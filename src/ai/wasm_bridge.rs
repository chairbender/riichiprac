//! WebAssembly bridge for Mortal v4 evaluation.
//!
//! [`WasmMortalEvaluator`] owns the loaded checkpoint (parsed once, kept in WASM
//! memory) and evaluates a [`GameState`] on demand:
//!
//! JSON state -> encoder (1012x34) -> Candle forward -> 47 outputs
//! (`[0]` expected value, `[1..]` action logits) -> legal-action mask ->
//! softmax -> JSON.
//!
//! Action indices follow Mortal's `ACTION_SPACE`:
//!
//! | Index | Action |
//! | --- | --- |
//! | 0..=33 | discard 1m..9m, 1p..9p, 1s..9s, E, S, W, N, haku, hatsu, chun |
//! | 34..=36 | discard red 5m / 5p / 5s |
//! | 37 | riichi |
//! | 38..=40 | chi (low / mid / high) |
//! | 41 | pon |
//! | 42 | kan |
//! | 43 | agari |
//! | 44 | ryukyoku |
//! | 45 | pass |

use std::collections::HashMap;

use candle_core::{DType, Device, Tensor};
use candle_nn::VarBuilder;
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

use super::actions::{RIICHI_ACTION, action_index, legal_actions};
use super::encoder::{OBS_CHANNELS, TILE_KINDS, encode_v4_observation};
use super::model::{ACTION_SPACE, MortalV4Model};
pub use crate::decision::ActionEvaluation;
use crate::decision::{ActionInfo, ActionKind};
use crate::generator::MortalAgreementOptions;
use crate::state::GameState;

pub use super::actions::{describe_action, legal_action_mask};

/// Expected value is output 0; the 46 action logits are outputs 1..=46.
const VALUE_INDEX: usize = 0;

/// Full evaluation payload returned to JavaScript.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Evaluation {
    /// Exact model identity, e.g. `mortal_298k.safetensors`.
    #[serde(default)]
    pub model: String,
    /// Output 0 of the network (Mortal's expected-value head).
    pub expected_value: f32,
    /// Action with the highest probability.
    pub recommended_action: String,
    /// When the top action is Riichi, the discard the model would declare on.
    ///
    /// Mortal's action space has a single `Riichi` action with no tile, so the
    /// discard comes from the documented second pass: re-evaluate with the
    /// player marked as already in Riichi and the `Riichi` action masked off.
    /// `None` for every non-Riichi recommendation and for callers that only
    /// need the first pass ([`evaluate_state_with_options`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub riichi_discard: Option<String>,
    /// Legal actions, highest probability first.
    pub evaluations: Vec<ActionEvaluation>,
}

/// Owns the Mortal v4 checkpoint inside WASM memory.
///
/// Construct once from the bytes of `public/models/mortal_298k.safetensors`
/// and reuse it for every evaluation; weights are parsed a single time.
#[wasm_bindgen]
pub struct WasmMortalEvaluator {
    model: MortalV4Model,
    model_name: String,
}

#[wasm_bindgen]
impl WasmMortalEvaluator {
    /// Build the evaluator from raw `.safetensors` bytes.
    #[wasm_bindgen(constructor)]
    pub fn new(weights_bytes: &[u8], model_name: &str) -> Result<WasmMortalEvaluator, JsValue> {
        // The buffered backend copies the file into WASM memory, which works on
        // wasm32 where mmap-based loading is unavailable.
        let vb =
            VarBuilder::from_buffered_safetensors(weights_bytes.to_vec(), DType::F32, &Device::Cpu)
                .map_err(|err| js_error(&format!("failed to parse model weights: {err}")))?;

        let model = MortalV4Model::new(vb)
            .map_err(|err| js_error(&format!("failed to bind model weights: {err}")))?;

        Ok(Self {
            model,
            model_name: model_name.to_string(),
        })
    }

    /// Generate and finalize the AI Best Action scenario.
    pub fn generate_ai_puzzle(&self, category: &str) -> Result<String, JsValue> {
        let state =
            crate::generator::ai_best_action::generate(&self.model, &self.model_name, category)
                .map_err(|err| js_error(&format!("failed to generate AI scenario: {err}")))?;
        let state = crate::generator::finalize_state(state);

        serde_json::to_string(&state)
            .map_err(|err| js_error(&format!("failed to serialize AI scenario: {err}")))
    }

    /// Evaluate a serialized [`GameState`].
    pub fn evaluate(&self, game_state_json: &str) -> Result<JsValue, JsValue> {
        let state: GameState = serde_json::from_str(game_state_json)
            .map_err(|err| js_error(&format!("invalid game state JSON: {err}")))?;

        let evaluation = evaluate_state_named(&self.model, &state, &self.model_name)
            .map_err(|err| js_error(&format!("evaluation failed: {err}")))?;

        let json = serde_json::to_string(&evaluation)
            .map_err(|err| js_error(&format!("failed to serialize evaluation: {err}")))?;

        js_sys::JSON::parse(&json)
    }

    /// Generate a lesson puzzle and require Mortal to agree with its book answer.
    ///
    /// This is the opt-in agreement filter on the generation path: candidates
    /// are generated and evaluated until the model's top-ranked action equals
    /// one of the lesson's accepted answers, within
    /// [`MortalAgreementOptions::max_candidates`] attempts. `options_json` is
    /// `{"max_candidates": 40}`, `{}` / `""` for the default bound, or
    /// `{"enabled": false}` to get the plain `generate_puzzle` result with no
    /// report.
    ///
    /// Returns `{"state": GameState, "agreement": MortalAgreementReport}` as a
    /// JSON string. Use [`Self::generate_ai_puzzle`] for `ai_best_action`, whose
    /// answer is Mortal's own argmax and is therefore not sampled.
    pub fn generate_puzzle_with_agreement(
        &self,
        category: &str,
        options_json: &str,
    ) -> Result<String, JsValue> {
        let options: MortalAgreementOptions = if options_json.trim().is_empty() {
            MortalAgreementOptions::default()
        } else {
            serde_json::from_str(options_json)
                .map_err(|err| js_error(&format!("invalid Mortal-agreement options JSON: {err}")))?
        };

        let puzzle = crate::generator::generate_puzzle_with_agreement(
            category,
            &self.model,
            &self.model_name,
            options,
        )
        .map_err(|err| js_error(&format!("failed to generate an agreeing scenario: {err}")))?;

        serde_json::to_string(&puzzle)
            .map_err(|err| js_error(&format!("failed to serialize the agreeing scenario: {err}")))
    }
}

/// Run one evaluation without touching JavaScript (used by native tests too).
pub fn evaluate_state(model: &MortalV4Model, state: &GameState) -> candle_core::Result<Evaluation> {
    evaluate_state_named(model, state, "unknown")
}

/// Run one evaluation and attach the model identity to the result.
///
/// When the model's top action is Riichi, this also runs the second pass and
/// records the discard Mortal would declare on, so callers can grade and show
/// the whole riichi-vs-dama decision rather than a tile-less action name.
pub fn evaluate_state_named(
    model: &MortalV4Model,
    state: &GameState,
    model_name: &str,
) -> candle_core::Result<Evaluation> {
    let mut evaluation = evaluate_state_with_options(model, state, model_name, &[])?;
    attach_riichi_discard(model, state, model_name, &mut evaluation)?;
    Ok(evaluation)
}

/// Fill [`Evaluation::riichi_discard`] for a Riichi recommendation.
///
/// The discard is chosen exactly the way the AI drill chooses it: clone the
/// position with the human already in Riichi, mask `Riichi` off, and take the
/// highest-probability discard from the second pass.
fn attach_riichi_discard(
    model: &MortalV4Model,
    state: &GameState,
    model_name: &str,
    evaluation: &mut Evaluation,
) -> candle_core::Result<()> {
    if evaluation.recommended_action != "Riichi" || evaluation.riichi_discard.is_some() {
        return Ok(());
    }

    let mut post = state.clone();
    if post.players.is_empty() {
        return Ok(());
    }
    post.players[0].is_riichi = true;

    // A second-pass failure must not sink the first pass: the declaration is
    // still Mortal's answer, it just cannot say which tile it would discard.
    // The AI drill generator treats a missing discard as a rejected candidate.
    let Ok(second) = evaluate_state_with_options(model, &post, model_name, &[RIICHI_ACTION]) else {
        return Ok(());
    };
    evaluation.riichi_discard = riichi_discard_from_evaluation(&second);
    Ok(())
}

/// The discard at the top of a second-pass evaluation, if it offered one.
fn riichi_discard_from_evaluation(evaluation: &Evaluation) -> Option<String> {
    evaluation
        .evaluations
        .iter()
        .find(|scored| scored.info.kind == ActionKind::Discard)
        .and_then(|scored| scored.info.tile.clone())
}

/// Run one evaluation with extra action indices forbidden.
///
/// This is used for the Riichi second pass: after the model chooses Riichi, the
/// discard is chosen by re-evaluating with the declaration action masked off.
pub fn evaluate_state_with_options(
    model: &MortalV4Model,
    state: &GameState,
    model_name: &str,
    forbidden: &[usize],
) -> candle_core::Result<Evaluation> {
    let observation = encode_v4_observation(state);
    let input = Tensor::from_vec(observation, (1, OBS_CHANNELS, TILE_KINDS), &Device::Cpu)?;
    let output = model.forward(&input)?;
    let flat = output.flatten_all()?.to_vec1::<f32>()?;
    build_evaluation(state, &flat, model_name, forbidden)
}

/// Split network outputs, mask illegal actions, and softmax the rest.
fn build_evaluation(
    state: &GameState,
    outputs: &[f32],
    model_name: &str,
    forbidden: &[usize],
) -> candle_core::Result<Evaluation> {
    if outputs.len() != 1 + ACTION_SPACE {
        candle_core::bail!(
            "expected {} network outputs, got {}",
            1 + ACTION_SPACE,
            outputs.len()
        );
    }

    let expected_value = outputs[VALUE_INDEX];
    let logits = &outputs[1..];
    let mut mask = legal_action_mask(state);
    for &index in forbidden {
        if index < mask.len() {
            mask[index] = false;
        }
    }
    if !mask.iter().any(|&legal| legal) {
        candle_core::bail!("game state leaves no legal action");
    }
    // Guard NaN/inf logits so the softmax stays usable.
    if logits.iter().any(|logit| !logit.is_finite()) {
        for (index, legal) in mask.iter_mut().enumerate() {
            if !logits[index].is_finite() {
                *legal = false;
            }
        }
        if !mask.iter().any(|&legal| legal) {
            candle_core::bail!("all legal action logits were NaN or infinite");
        }
    }

    let max_logit = logits
        .iter()
        .zip(&mask)
        .filter(|(_, legal)| **legal)
        .map(|(&logit, _)| logit)
        .fold(f32::NEG_INFINITY, f32::max);
    let mut probabilities: Vec<f32> = logits
        .iter()
        .zip(&mask)
        .map(|(&logit, &legal)| {
            if legal {
                (logit - max_logit).exp()
            } else {
                0.0
            }
        })
        .collect();
    let total: f32 = probabilities.iter().sum();
    if !(total.is_finite() && total > 0.0) {
        candle_core::bail!("softmax normalization failed (sum = {total})");
    }
    for probability in &mut probabilities {
        *probability /= total;
    }

    let info_by_index: HashMap<usize, ActionInfo> = legal_actions(state)
        .into_iter()
        .filter_map(|info| action_index(&info.action).map(|index| (index, info)))
        .collect();

    let mut evaluations: Vec<ActionEvaluation> = probabilities
        .iter()
        .enumerate()
        .filter(|(index, _)| mask[*index])
        .filter_map(|(index, &probability)| {
            let info = info_by_index.get(&index)?.clone();
            Some(ActionEvaluation { info, probability })
        })
        .collect();
    evaluations.sort_by(|left, right| {
        right
            .probability
            .total_cmp(&left.probability)
            .then_with(|| left.info.action.cmp(&right.info.action))
    });

    let recommended_action = evaluations
        .first()
        .map(|evaluation| evaluation.info.action.clone())
        .expect("at least one legal action exists");

    Ok(Evaluation {
        model: model_name.to_string(),
        expected_value,
        recommended_action,
        riichi_discard: None,
        evaluations,
    })
}

fn js_error(message: &str) -> JsValue {
    JsValue::from_str(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::actions::{AGARI_ACTION, FIRST_RED_DISCARD, RIICHI_ACTION};
    use crate::ai::encoder::tile_index;
    use crate::decision::ActionKind;
    use crate::state::{
        CalledMeld, CorrectAction, DecisionContext, DiscardTile, GameState, MeldType, PlayerState,
        TargetAction, Wind,
    };

    fn player(seat: usize, wind: Wind, score: i32, hand: &[&str]) -> PlayerState {
        PlayerState {
            seat,
            name: format!("seat{seat}"),
            is_human: seat == 0,
            wind,
            score,
            hand: hand.iter().map(|tile| tile.to_string()).collect(),
            draw: None,
            red_fives: Vec::new(),
            discards: vec![DiscardTile::new("1z")],
            melds: Vec::new(),
            is_riichi: false,
            riichi_discard_index: None,
        }
    }

    fn base_state() -> GameState {
        let mut human = player(
            0,
            Wind::East,
            25_000,
            &[
                "1m", "2m", "3m", "4p", "5p", "6p", "7s", "8s", "9s", "2z", "2z", "3z", "4z",
            ],
        );
        human.draw = Some("6m".to_string());
        human.red_fives = vec!["5p".to_string()];

        GameState {
            category: "bridge_test".to_string(),
            target_action: TargetAction::NaniKiru,
            correct_action: CorrectAction::dama("6m"),
            equivalent_tiles: Vec::new(),
            decision: DecisionContext::SelfTurn,
            scenario_note: None,
            call_offer: None,
            ai_decision: None,
            riichi_triggers: Vec::new(),
            dama_reasons: Vec::new(),
            shouminkan_triggers: Vec::new(),
            book_rationale: None,
            can_riichi: false,
            hand_string: String::new(),
            tiles: Vec::new(),
            shanten: 0,
            is_agari: false,
            decompositions_count: 1,
            ukeire_tiles: vec!["9m".to_string()],
            ukeire_total: 4,
            round_wind: Wind::East,
            hand_number: 1,
            honba: 0,
            riichi_sticks: 0,
            dora_indicators: vec!["1p".to_string()],
            ura_dora_indicators: Vec::new(),
            tiles_remaining: 40,
            current_turn: 0,
            players: vec![
                human,
                player(1, Wind::South, 25_000, &["1p"; 13]),
                player(2, Wind::West, 25_000, &["2p"; 13]),
                player(3, Wind::North, 25_000, &["3p"; 13]),
            ],
        }
    }

    #[test]
    fn legal_mask_covers_hand_discards_red_five_and_riichi() {
        let mask = legal_action_mask(&base_state());

        assert!(mask[tile_index("1m").unwrap()]);
        assert!(
            mask[tile_index("6m").unwrap()],
            "drawn tile is discarded too"
        );
        assert!(mask[FIRST_RED_DISCARD + 1], "red 5p is held");
        assert!(
            !mask[tile_index("5p").unwrap()],
            "the only 5p held is the red one, so the plain discard is impossible"
        );
        assert!(!mask[FIRST_RED_DISCARD], "no red 5m");
        assert!(mask[RIICHI_ACTION]);
        assert!(!mask[AGARI_ACTION]);

        // No call/pass actions in a self discard decision.
        for action in [38, 39, 40, 41, 42, 44, 45] {
            assert!(!mask[action], "action {action} must be masked");
        }
        // Tiles not in hand are illegal.
        assert!(!mask[tile_index("9m").unwrap()]);
    }

    #[test]
    fn riichi_needs_tenpai_or_a_discard_that_reaches_it() {
        // A closed tenpai hand can declare.
        let state = base_state();
        assert!(legal_action_mask(&state)[RIICHI_ACTION]);

        // A closed 1-shanten hand can declare too, as long as some discard
        // reaches tenpai: libriichi's `has_next_shanten_discard` rule, because
        // the declaration is made on that discard.
        let hand = [
            "1m", "2m", "3m", "4p", "5p", "6p", "7m", "8m", "9m", "2z", "2z", "3s", "9s",
        ];
        let mut state = base_state();
        state.players[0].hand = hand.iter().map(|tile| tile.to_string()).collect();
        state.players[0].red_fives.clear();
        state.players[0].draw = Some("4s".to_string());
        state.shanten = shanten_of(&hand);
        assert_eq!(state.shanten, 1, "the fixture hand must be 1-shanten");
        assert!(
            legal_action_mask(&state)[RIICHI_ACTION],
            "discarding 9s reaches tenpai, so Riichi is legal"
        );
        assert_can_riichi_plane(&state, true);

        // The same hand with a useless draw: no discard reaches tenpai, so the
        // gate stays shut and the mask and the observation agree.
        state.players[0].draw = Some("5z".to_string());
        assert!(
            !legal_action_mask(&state)[RIICHI_ACTION],
            "nothing reaches tenpai, so Riichi is not legal"
        );
        assert_can_riichi_plane(&state, false);

        // An open hand can never declare, whatever the shanten.
        let mut state = base_state();
        state.players[0].melds = vec![CalledMeld {
            meld_type: MeldType::Pon,
            tiles: vec!["2z".to_string(); 3],
            called_from: Some(1),
        }];
        assert!(!legal_action_mask(&state)[RIICHI_ACTION]);

        // A closed kan keeps the hand closed.
        let mut state = base_state();
        state.players[0].melds = vec![CalledMeld {
            meld_type: MeldType::Ankan,
            tiles: vec!["2z".to_string(); 4],
            called_from: None,
        }];
        assert!(legal_action_mask(&state)[RIICHI_ACTION]);
    }

    fn shanten_of(codes: &[&str]) -> i8 {
        let mut counts = [0u8; 34];
        for code in codes {
            counts[tile_index(code).expect("tile")] += 1;
        }
        crate::ai::sp::calc_all(&counts, 4)
    }

    fn assert_can_riichi_plane(state: &GameState, expected: bool) {
        let observation = crate::ai::encoder::encode_v4_observation(state);
        let row = crate::ai::encoder::OFF_CAN_RIICHI * crate::ai::encoder::TILE_KINDS;
        let filled = observation[row..row + crate::ai::encoder::TILE_KINDS]
            .iter()
            .all(|value| *value == 1.0);
        assert_eq!(filled, expected, "the can_riichi plane must agree");
    }

    #[test]
    fn agari_is_legal_only_on_a_complete_hand() {
        let mut state = base_state();
        state.is_agari = true;
        assert!(legal_action_mask(&state)[AGARI_ACTION]);
    }

    #[test]
    fn masking_and_softmax_produce_normalized_legal_probabilities() {
        let state = base_state();
        let mut outputs = vec![0.0f32; 1 + ACTION_SPACE];
        // Give an illegal pon the highest logit; it must not surface.
        outputs[1 + tile_index("1m").unwrap()] = 1.0;
        outputs[1 + tile_index("9m").unwrap()] = 5.0;
        outputs[1 + 41] = 20.0;

        let evaluation = build_evaluation(&state, &outputs, "test", &[]).unwrap();
        let total: f32 = evaluation.evaluations.iter().map(|e| e.probability).sum();
        assert!((total - 1.0).abs() < 1e-5);
        assert!(
            evaluation
                .evaluations
                .iter()
                .all(|e| e.info.kind != ActionKind::Pon && e.probability >= 0.0)
        );
        assert!(
            evaluation
                .evaluations
                .windows(2)
                .all(|pair| pair[0].probability >= pair[1].probability)
        );
        assert!(evaluation.recommended_action.starts_with("Discard_"));
        assert!(evaluation.expected_value.abs() < f32::EPSILON);
    }

    #[test]
    fn second_pass_result_reads_the_top_discard() {
        let state = base_state();
        let outputs = vec![0.0f32; 1 + ACTION_SPACE];
        let mut second =
            build_evaluation(&state, &outputs, "test", &[]).expect("uniform second pass");

        // The first legal action is a discard, so a uniform second pass resolves
        // to a concrete tile for the declaration.
        let discard = riichi_discard_from_evaluation(&second).expect("a discard");
        assert!(matches!(
            discard.chars().last(),
            Some('m' | 'p' | 's' | 'z')
        ));
        assert_eq!(second.riichi_discard, None, "the helper does not mutate");

        // A second pass with no discard at all leaves the declaration tile-less.
        second
            .evaluations
            .retain(|scored| scored.info.kind != ActionKind::Discard);
        assert_eq!(riichi_discard_from_evaluation(&second), None);
    }

    #[test]
    fn evaluations_from_old_payloads_default_the_riichi_discard() {
        let json = serde_json::json!({
            "model": "mortal_298k.safetensors",
            "expected_value": 0.1,
            "recommended_action": "Riichi",
            "evaluations": []
        });
        let evaluation: Evaluation = serde_json::from_value(json).expect("old payload parses");
        assert_eq!(evaluation.riichi_discard, None);
    }

    #[test]
    fn first_pass_evaluations_never_invent_a_riichi_discard() {
        let state = base_state();
        let mut outputs = vec![0.0f32; 1 + ACTION_SPACE];
        outputs[1 + RIICHI_ACTION] = 10.0;
        let evaluation = build_evaluation(&state, &outputs, "test", &[]).expect("riichi top");

        assert_eq!(evaluation.recommended_action, "Riichi");
        assert_eq!(evaluation.riichi_discard, None);
    }

    #[test]
    fn real_weights_produce_a_legal_recommendation() {
        const WEIGHTS: &str = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/frontend/public/models/mortal_298k.safetensors"
        );
        if !std::path::Path::new(WEIGHTS).exists() {
            eprintln!("skipping bridge inference test: {WEIGHTS} is missing");
            return;
        }

        let vb = VarBuilder::from_buffered_safetensors(
            std::fs::read(WEIGHTS).unwrap(),
            DType::F32,
            &Device::Cpu,
        )
        .unwrap();
        let model = MortalV4Model::new(vb).unwrap();
        let state = base_state();
        let evaluation = evaluate_state(&model, &state).unwrap();
        println!(
            "EV {:.3} -> {}",
            evaluation.expected_value, evaluation.recommended_action
        );
        for scored in evaluation.evaluations.iter().take(3) {
            println!("  {:.3} {}", scored.probability, scored.info.action);
        }

        assert!(evaluation.expected_value.is_finite());
        let total: f32 = evaluation.evaluations.iter().map(|e| e.probability).sum();
        assert!((total - 1.0).abs() < 1e-3, "probabilities sum to {total}");
        assert!(!evaluation.recommended_action.is_empty());
        assert!(
            evaluation
                .evaluations
                .iter()
                .any(|scored| scored.info.action == evaluation.recommended_action)
        );
    }
}
