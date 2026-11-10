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

use candle_core::{DType, Device, Tensor};
use candle_nn::VarBuilder;
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

use super::encoder::{OBS_CHANNELS, TILE_KINDS, encode_v4_observation, tile_index, tile_name};
use super::model::{ACTION_SPACE, MortalV4Model};
use crate::state::{GameState, MeldType};

/// Expected value is output 0; the 46 action logits are outputs 1..=46.
const VALUE_INDEX: usize = 0;

/// Action index of the first red-five discard (5m).
const FIRST_RED_DISCARD: usize = 34;
/// Action index of riichi.
const RIICHI_ACTION: usize = 37;
/// Action index of a ron/tsumo win.
const AGARI_ACTION: usize = 43;

/// One scored action in an evaluation result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActionEvaluation {
    /// Stable machine-readable name, e.g. `Discard_3m` or `Riichi`.
    pub action: String,
    /// Coarse action family: discard, riichi, chi, pon, kan, agari, ryukyoku, pass.
    #[serde(rename = "type")]
    pub kind: String,
    /// Tile kind (0..34) for tile actions; `None` otherwise.
    pub tile_index: Option<usize>,
    /// Softmax probability over the legal actions.
    pub probability: f32,
}

/// Full evaluation payload returned to JavaScript.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Evaluation {
    /// Output 0 of the network (Mortal's expected-value head).
    pub expected_value: f32,
    /// Action with the highest probability.
    pub recommended_action: String,
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
}

#[wasm_bindgen]
impl WasmMortalEvaluator {
    /// Build the evaluator from raw `.safetensors` bytes.
    #[wasm_bindgen(constructor)]
    pub fn new(weights_bytes: &[u8]) -> Result<WasmMortalEvaluator, JsValue> {
        // The buffered backend copies the file into WASM memory, which works on
        // wasm32 where mmap-based loading is unavailable.
        let vb =
            VarBuilder::from_buffered_safetensors(weights_bytes.to_vec(), DType::F32, &Device::Cpu)
                .map_err(|err| js_error(&format!("failed to parse model weights: {err}")))?;

        let model = MortalV4Model::new(vb)
            .map_err(|err| js_error(&format!("failed to bind model weights: {err}")))?;

        Ok(Self { model })
    }

    /// Evaluate a serialized [`GameState`].
    pub fn evaluate(&self, game_state_json: &str) -> Result<JsValue, JsValue> {
        let state: GameState = serde_json::from_str(game_state_json)
            .map_err(|err| js_error(&format!("invalid game state JSON: {err}")))?;

        let evaluation = evaluate_state(&self.model, &state)
            .map_err(|err| js_error(&format!("evaluation failed: {err}")))?;

        let json = serde_json::to_string(&evaluation)
            .map_err(|err| js_error(&format!("failed to serialize evaluation: {err}")))?;

        js_sys::JSON::parse(&json)
    }
}

/// Run one evaluation without touching JavaScript (used by native tests too).
pub fn evaluate_state(model: &MortalV4Model, state: &GameState) -> candle_core::Result<Evaluation> {
    let observation = encode_v4_observation(state);
    let input = Tensor::from_vec(observation, (1, OBS_CHANNELS, TILE_KINDS), &Device::Cpu)?;
    let output = model.forward(&input)?;
    let flat = output.flatten_all()?.to_vec1::<f32>()?;
    build_evaluation(state, &flat)
}

/// Split network outputs, mask illegal actions, and softmax the rest.
fn build_evaluation(state: &GameState, outputs: &[f32]) -> candle_core::Result<Evaluation> {
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

    let mut evaluations: Vec<ActionEvaluation> = probabilities
        .iter()
        .enumerate()
        .filter(|(index, _)| mask[*index])
        .map(|(index, &probability)| {
            let (action, kind, tile_index) = describe_action(index);
            ActionEvaluation {
                action,
                kind,
                tile_index,
                probability,
            }
        })
        .collect();
    evaluations.sort_by(|left, right| {
        right
            .probability
            .total_cmp(&left.probability)
            .then_with(|| left.action.cmp(&right.action))
    });

    let recommended_action = evaluations
        .first()
        .map(|evaluation| evaluation.action.clone())
        .expect("at least one legal action exists");

    Ok(Evaluation {
        expected_value,
        recommended_action,
        evaluations,
    })
}

/// Legal actions for the human seat in the current puzzle.
///
/// The trainer always presents a discard decision, so only discards, riichi and
/// a possible win are legal. Call and pass actions belong to reaction states.
pub fn legal_action_mask(state: &GameState) -> Vec<bool> {
    let mut mask = vec![false; ACTION_SPACE];
    if state.players.is_empty() {
        return mask;
    }

    let player = &state.players[0];
    let mut counts = [0u8; TILE_KINDS];
    for tile in player.hand.iter().chain(player.draw.iter()) {
        if let Some(index) = tile_index(tile) {
            counts[index] = counts[index].saturating_add(1);
        }
    }
    for (index, &count) in counts.iter().enumerate() {
        if count > 0 {
            mask[index] = true;
        }
    }

    // Red fives are separate actions only when the tile is held and flagged.
    for (tile, suit) in [("5m", 0usize), ("5p", 1), ("5s", 2)] {
        let index = tile_index(tile).expect("valid tile literal");
        if counts[index] > 0 && player.red_fives.iter().any(|held| held == tile) {
            mask[FIRST_RED_DISCARD + suit] = true;
        }
    }

    let menzen = player
        .melds
        .iter()
        .all(|meld| meld.meld_type == MeldType::Ankan);
    if menzen
        && state.shanten == 0
        && !player.is_riichi
        && player.score >= 1000
        && state.tiles_remaining >= 4
    {
        mask[RIICHI_ACTION] = true;
    }

    if state.is_agari {
        mask[AGARI_ACTION] = true;
    }

    mask
}

/// Decoded action metadata for one action index.
pub fn describe_action(index: usize) -> (String, String, Option<usize>) {
    match index {
        0..=33 => (
            format!("Discard_{}", tile_name(index).expect("valid tile index")),
            "discard".to_string(),
            Some(index),
        ),
        34..=36 => {
            let tile = 4 + (index - FIRST_RED_DISCARD) * 9;
            let name = tile_name(tile).expect("valid tile index");
            (
                format!("Discard_{name}r"),
                "discard".to_string(),
                Some(tile),
            )
        }
        RIICHI_ACTION => ("Riichi".to_string(), "riichi".to_string(), None),
        38 => ("Chi_Low".to_string(), "chi".to_string(), None),
        39 => ("Chi_Mid".to_string(), "chi".to_string(), None),
        40 => ("Chi_High".to_string(), "chi".to_string(), None),
        41 => ("Pon".to_string(), "pon".to_string(), None),
        42 => ("Kan".to_string(), "kan".to_string(), None),
        43 => ("Agari".to_string(), "agari".to_string(), None),
        44 => ("Ryukyoku".to_string(), "ryukyoku".to_string(), None),
        45 => ("Pass".to_string(), "pass".to_string(), None),
        other => (format!("Action_{other}"), "unknown".to_string(), None),
    }
}

fn js_error(message: &str) -> JsValue {
    JsValue::from_str(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{
        CalledMeld, CorrectAction, DiscardTile, GameState, MeldType, PlayerState, TargetAction,
        Wind,
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
            riichi_triggers: Vec::new(),
            dama_reasons: Vec::new(),
            shouminkan_triggers: Vec::new(),
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
    fn riichi_requires_tenpai_and_a_closed_hand() {
        let mut state = base_state();
        state.shanten = 1;
        assert!(!legal_action_mask(&state)[RIICHI_ACTION]);

        let mut state = base_state();
        state.players[0].melds = vec![CalledMeld {
            meld_type: MeldType::Pon,
            tiles: vec!["2z".to_string(); 3],
            called_from: Some(1),
        }];
        assert!(!legal_action_mask(&state)[RIICHI_ACTION]);

        let mut state = base_state();
        state.players[0].melds = vec![CalledMeld {
            meld_type: MeldType::Ankan,
            tiles: vec!["2z".to_string(); 4],
            called_from: None,
        }];
        assert!(legal_action_mask(&state)[RIICHI_ACTION]);
    }

    #[test]
    fn agari_is_legal_only_on_a_complete_hand() {
        let mut state = base_state();
        state.is_agari = true;
        assert!(legal_action_mask(&state)[AGARI_ACTION]);
    }

    #[test]
    fn action_metadata_covers_the_whole_space() {
        assert_eq!(describe_action(0).0, "Discard_1m");
        assert_eq!(describe_action(8).0, "Discard_9m");
        assert_eq!(describe_action(9).0, "Discard_1p");
        assert_eq!(describe_action(26).0, "Discard_9s");
        assert_eq!(describe_action(27).0, "Discard_1z");
        assert_eq!(describe_action(33).0, "Discard_7z");
        assert_eq!(
            describe_action(34),
            ("Discard_5mr".into(), "discard".into(), Some(4))
        );
        assert_eq!(describe_action(35).0, "Discard_5pr");
        assert_eq!(describe_action(36).0, "Discard_5sr");
        assert_eq!(
            describe_action(37),
            ("Riichi".into(), "riichi".into(), None)
        );
        assert_eq!(describe_action(41), ("Pon".into(), "pon".into(), None));
        assert_eq!(describe_action(45), ("Pass".into(), "pass".into(), None));
        for index in 0..ACTION_SPACE {
            let (action, kind, _) = describe_action(index);
            assert!(!action.is_empty());
            assert_ne!(kind, "unknown");
        }
    }

    #[test]
    fn masking_and_softmax_produce_normalized_legal_probabilities() {
        let state = base_state();
        let mut outputs = vec![0.0f32; 1 + ACTION_SPACE];
        // Give an illegal pon the highest logit; it must not surface.
        outputs[1 + tile_index("1m").unwrap()] = 1.0;
        outputs[1 + tile_index("9m").unwrap()] = 5.0;
        outputs[1 + 41] = 20.0;

        let evaluation = build_evaluation(&state, &outputs).unwrap();
        let total: f32 = evaluation.evaluations.iter().map(|e| e.probability).sum();
        assert!((total - 1.0).abs() < 1e-5);
        assert!(
            evaluation
                .evaluations
                .iter()
                .all(|e| e.kind != "pon" && e.probability >= 0.0)
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
            println!("  {:.3} {}", scored.probability, scored.action);
        }

        assert!(evaluation.expected_value.is_finite());
        let total: f32 = evaluation.evaluations.iter().map(|e| e.probability).sum();
        assert!((total - 1.0).abs() < 1e-3, "probabilities sum to {total}");
        assert!(!evaluation.recommended_action.is_empty());
        assert!(
            legal_action_mask(&state)
                .iter()
                .zip(0..)
                .any(|(&legal, index)| legal
                    && describe_action(index).0 == evaluation.recommended_action)
        );
    }
}
