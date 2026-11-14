//! AI hotseat scenario: a full round self-played by Mortal, then presented at
//! one of the inserted seat's real decisions.
//!
//! Flow:
//!
//! 1. Resolve the generation card's options (round, point disparity, seat) and
//!    deal the table under them.
//! 2. Play the round with the loaded Mortal model in every seat (see
//!    [`sim`](self)).
//! 3. Pick one of the inserted seat's recorded decisions uniformly and grade it
//!    exactly like [`crate::generator::ai_best_action`]: the correct answer is
//!    the model's top legal action at that position.
//!
//! The whole engine is in Rust/WASM. React only renders the returned
//! [`GameState`] and grades clicks against `correct_action`, so this scenario
//! needs no new frontend rules logic.

mod bridge;
mod options;
mod sim;

#[cfg(test)]
mod test_support;

use crate::ai::finalize::{build_ai_decision, correct_action_from_info};
use crate::ai::model::MortalV4Model;
use crate::ai::wasm_bridge::Evaluation;
use crate::decision::ActionKind;
use crate::generator::finalize_state;
use crate::rng::gen_range;
use crate::state::{GameState, TargetAction};

pub use options::{Disparity, HotseatOptions, HotseatRound, HotseatSeat, StartingConditions};

use sim::{ModelPolicy, Policy, SimTable};

/// How many full self-played rounds to try before giving up. A retry only
/// happens when the round ended before the inserted seat ever faced a
/// recordable decision.
const MAX_SIMULATED_ROUNDS: usize = 4;

/// Generate the AI hotseat scenario under the card's options.
///
/// `options_json` is the generation card's shape:
/// `{"round":"east_1","disparity":"about_equal_all","seat":"west"}`, with a
/// missing or `null` field drawn at random. Empty input means every option is
/// random.
pub fn generate(
    model: &MortalV4Model,
    model_name: &str,
    options_json: &str,
) -> Result<GameState, String> {
    let policy = ModelPolicy {
        model,
        name: model_name,
    };
    generate_with_policy(&policy, options_json)
}

/// The same generation path with an injectable policy, so the rules engine can
/// be tested without running dozens of debug-build forward passes.
pub(crate) fn generate_with_policy(
    policy: &dyn Policy,
    options_json: &str,
) -> Result<GameState, String> {
    let options = HotseatOptions::from_json(options_json)?;
    let conditions = options.resolve();

    let mut last_error = String::new();
    for _ in 0..MAX_SIMULATED_ROUNDS {
        let mut table = SimTable::deal(conditions);
        match table.play(policy) {
            Ok(_) => {}
            Err(err) => {
                last_error = err;
                continue;
            }
        }
        if table.records.is_empty() {
            last_error = "the round ended before the inserted seat faced a decision".to_string();
            continue;
        }

        let index = gen_range(0, table.records.len());
        let record = table.records.swap_remove(index);
        let mut state = record.state;
        state.category = "ai_hotseat".to_string();
        apply_top_action(&mut state, &record.evaluation)?;
        state = finalize_state(state);
        return Ok(state);
    }

    Err(format!(
        "could not produce a hotseat position after {MAX_SIMULATED_ROUNDS} simulated \
         round(s): {last_error}"
    ))
}

/// Stamp the model's top action as the trainer's answer.
///
/// Unlike the agreement sampler, the hotseat position is not chosen for its
/// answer: whatever the model played in that seat is the answer. The top
/// evaluation entry, rather than just its action name, is used because a hand
/// can offer several different `Kan` actions under one name.
fn apply_top_action(state: &mut GameState, evaluation: &Evaluation) -> Result<(), String> {
    let top = evaluation
        .evaluations
        .first()
        .ok_or_else(|| "the recorded position has no model evaluation".to_string())?;
    let tile_override = if top.info.kind == ActionKind::Riichi {
        evaluation.riichi_discard.as_deref()
    } else {
        None
    };
    state.correct_action = correct_action_from_info(&top.info, tile_override);
    state.target_action = TargetAction::Best;
    state.ai_decision = Some(build_ai_decision(state, evaluation, None));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decision::ActionKind;
    use crate::generator::hotseat::test_support::{FastMode, FastPolicy};
    use crate::generator::support::state_validation::validate_reachable_state;
    use crate::state::CorrectActionType;

    fn pinned() -> HotseatOptions {
        HotseatOptions {
            round: Some(HotseatRound::South2),
            disparity: Some(Disparity::AboutEqualBetweenTwo),
            seat: Some(HotseatSeat::West),
        }
    }

    #[test]
    fn a_fast_policy_returns_a_finalized_hotseat_position() {
        let policy = FastPolicy::default();
        let json = serde_json::to_string(&pinned()).unwrap();
        let state = generate_with_policy(&policy, &json).expect("hotseat generates");

        assert_eq!(state.category, "ai_hotseat");
        assert_eq!(state.target_action, TargetAction::Best);
        assert_eq!(state.correct_action.action_type(), CorrectActionType::Best);
        assert!(state.ai_decision.is_some());
        assert_eq!(state.players[0].wind, crate::state::Wind::West);
        assert!((1..=4).contains(&state.hand_number));
        assert_eq!(state.round_wind, crate::state::Wind::South);
        assert_eq!(state.hand_number, 2);
        // The note names the starting conditions, never the answer.
        let note = state.scenario_note.as_deref().unwrap_or_default();
        assert!(note.contains("South 2"));
        assert!(note.contains("West"));
        assert!(note.contains("level with one other"));
        assert!(!note.contains("Discard"));
        assert!(!note.contains("Riichi"));
    }

    #[test]
    fn the_answer_is_one_of_the_legal_actions() {
        let policy = FastPolicy::default();
        let state = generate_with_policy(&policy, "{}").expect("hotseat generates");
        let ai = state.ai_decision.clone().expect("ai decision");
        assert!(
            ai.actions
                .iter()
                .any(|action| action.action == ai.recommended_action)
        );
        let correct = match &state.correct_action {
            crate::state::CorrectAction::Best { action, .. } => action,
            other => panic!("expected a best answer, got {other:?}"),
        };
        assert_eq!(correct, &ai.recommended_action);
        let top = ai.evaluations.first().expect("top evaluation");
        assert_eq!(top.info.action, ai.recommended_action);
        if top.info.kind == ActionKind::Riichi {
            assert!(
                state.correct_action.tile().is_some(),
                "a Riichi answer must carry its declaration discard"
            );
        }
    }

    #[test]
    fn the_recorded_position_is_still_a_reachable_table() {
        let policy = FastPolicy::default();
        let state = generate_with_policy(&policy, "{}").expect("hotseat generates");
        // The serialized state keeps the real concealed hands, exactly like the
        // AI Best Action drill, so the same reachability guard applies.
        validate_reachable_state(&state).unwrap_or_else(|err| panic!("unreachable: {err}"));
    }

    #[test]
    fn the_inserter_never_records_a_forced_riichi_turn() {
        // The decision context only allows a self turn or a reaction, and every
        // candidate offers at least two choices: a forced tsumogiri after a
        // Riichi is filtered out before recording.
        let policy = FastPolicy::new(FastMode::Riichi);
        let state = generate_with_policy(&policy, "{}").expect("hotseat generates");
        let actions = crate::ai::actions::legal_actions(&state);
        assert!(
            actions.len() > 1,
            "a hotseat candidate must be a real decision, got {actions:?}"
        );
    }

    #[test]
    fn pinned_round_scores_and_seat_survive_generation() {
        let policy = FastPolicy::default();
        for seat in HotseatSeat::ALL {
            let options = HotseatOptions {
                round: Some(HotseatRound::East3),
                disparity: Some(Disparity::InFirstByLargeGap),
                seat: Some(seat),
            };
            let state = generate_with_policy(&policy, &serde_json::to_string(&options).unwrap())
                .expect("hotseat generates");
            assert_eq!(state.players[0].wind, seat.wind());
            assert_eq!(state.round_wind, crate::state::Wind::East);
            assert_eq!(state.hand_number, 3);
            // Riichi declarations during the played round may already have
            // taken the 1000-point stick, so compare against the starting score
            // with that allowance rather than requiring an exact tie.
            let start =
                Disparity::InFirstByLargeGap.scores_for(seat.wind().index())[seat.wind().index()];
            assert!(
                state.players[0].score <= start && state.players[0].score >= start - 1_000,
                "seat {} score {} vs start {start}",
                seat.label(),
                state.players[0].score
            );
            let highest = state
                .players
                .iter()
                .map(|player| player.score)
                .max()
                .unwrap();
            assert_eq!(
                highest, state.players[0].score,
                "the inserted seat is first"
            );
        }
    }

    #[test]
    fn every_disparity_cell_generates() {
        let policy = FastPolicy::default();
        for disparity in Disparity::ALL {
            let options = HotseatOptions {
                round: Some(HotseatRound::East1),
                disparity: Some(disparity),
                seat: Some(HotseatSeat::South),
            };
            let state = generate_with_policy(&policy, &serde_json::to_string(&options).unwrap())
                .unwrap_or_else(|err| panic!("{} failed: {err}", disparity.label()));
            assert!(!state.hand_string.is_empty());
        }
    }

    #[test]
    #[ignore = "runs a full Mortal self-play; use --release --ignored"]
    fn zero_weights_self_play_completes() {
        let model = test_support::zero_model();
        let state = generate(&model, "zero_weights", "{}").expect("hotseat generates");
        assert!(state.ai_decision.is_some());
    }

    #[test]
    #[ignore = "runs a full Mortal self-play; use --release --ignored"]
    fn real_weights_generate_a_hotseat_position() {
        const WEIGHTS: &str = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/frontend/public/models/mortal_298k.safetensors"
        );
        if !std::path::Path::new(WEIGHTS).exists() {
            eprintln!("skipping hotseat inference test: {WEIGHTS} is missing");
            return;
        }

        use candle_core::{DType, Device};
        use candle_nn::VarBuilder;
        let vb = VarBuilder::from_buffered_safetensors(
            std::fs::read(WEIGHTS).unwrap(),
            DType::F32,
            &Device::Cpu,
        )
        .unwrap();
        let model = MortalV4Model::new(vb).unwrap();

        let state = generate(
            &model,
            "mortal_298k.safetensors",
            r#"{"round":"east_1","disparity":"about_equal_all","seat":"east"}"#,
        )
        .expect("real weights must generate a hotseat position");
        let ai = state.ai_decision.expect("ai decision");
        assert_eq!(ai.model, "mortal_298k.safetensors");
        assert!(
            ai.actions
                .iter()
                .any(|action| action.action == ai.recommended_action)
        );
    }
}
