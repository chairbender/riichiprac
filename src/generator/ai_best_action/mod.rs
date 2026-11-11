//! AI Best Action scenario: a random valid table whose answer is the loaded
//! Mortal model's top legal action.

mod reaction;
mod self_turn;
mod table;
mod validate;

use crate::ai::actions::RIICHI_ACTION;
use crate::ai::finalize::{
    build_ai_decision, correct_action_from_recommendation, evaluation_matches_legal_actions,
};
use crate::ai::model::MortalV4Model;
use crate::ai::wasm_bridge::{Evaluation, evaluate_state_named, evaluate_state_with_options};
use crate::decision::ActionKind;
use crate::rng::gen_range;
use crate::state::{DecisionContext, GameState, TargetAction};

use self::reaction::build_candidate as build_reaction_candidate;
use self::self_turn::{build_candidate as build_self_turn_candidate, build_special_candidate};
use self::validate::{validate_reaction_candidate, validate_self_turn_candidate};

/// How many structural candidates to try before giving up.
const MAX_ATTEMPTS: usize = 500;
/// How many candidates may reach model inference before giving up.
const MAX_INFERENCE_ATTEMPTS: usize = 12;

/// Generate a finalized AI scenario state.
pub fn generate(
    model: &MortalV4Model,
    model_name: &str,
    category: &str,
) -> Result<GameState, String> {
    if category != "ai_best_action" {
        return Err(format!(
            "AI scenario generator cannot handle category {category}"
        ));
    }

    let mut last_error = String::new();
    let mut inference_attempts = 0usize;

    for _ in 0..MAX_ATTEMPTS {
        let mut state = match build_any_candidate(category) {
            Ok(state) => state,
            Err(err) => {
                last_error = err;
                continue;
            }
        };
        if let Err(err) = validate_state(&state) {
            last_error = err;
            continue;
        }

        inference_attempts += 1;
        let evaluation = match evaluate_state_named(model, &state, model_name) {
            Ok(evaluation) => evaluation,
            Err(err) => {
                last_error = format!("model evaluation failed: {err}");
                if inference_attempts >= MAX_INFERENCE_ATTEMPTS {
                    break;
                }
                continue;
            }
        };

        let riichi_discard = if evaluation.recommended_action == "Riichi" {
            let mut post = state.clone();
            post.players[0].is_riichi = true;
            match evaluate_state_with_options(model, &post, model_name, &[RIICHI_ACTION]) {
                Ok(second) => second
                    .evaluations
                    .iter()
                    .find(|scored| scored.info.kind == ActionKind::Discard)
                    .and_then(|scored| scored.info.tile.clone()),
                Err(err) => {
                    last_error = format!("Riichi second pass failed: {err}");
                    if inference_attempts >= MAX_INFERENCE_ATTEMPTS {
                        break;
                    }
                    continue;
                }
            }
        } else {
            None
        };

        match apply_evaluation(&mut state, &evaluation, riichi_discard.as_deref()) {
            Ok(()) => return Ok(state),
            Err(err) => {
                last_error = err;
                if inference_attempts >= MAX_INFERENCE_ATTEMPTS {
                    break;
                }
            }
        }
    }

    Err(format!(
        "failed to generate an AI scenario after {inference_attempts} model evaluations: {last_error}"
    ))
}

fn build_any_candidate(category: &str) -> Result<GameState, String> {
    match gen_range(0, 100) {
        0..=34 => build_self_turn_candidate(category),
        35..=69 => build_special_candidate(category),
        _ => build_reaction_candidate(category),
    }
}

fn validate_state(state: &GameState) -> Result<(), String> {
    match &state.decision {
        DecisionContext::SelfTurn => validate_self_turn_candidate(state),
        DecisionContext::ReactToDiscard { .. } => validate_reaction_candidate(state),
        DecisionContext::ReactToKan { .. } => {
            Err("chankan reactions are not implemented".to_string())
        }
    }?;
    // Final guard: the rivers, melds, and draw must describe one reachable
    // turn order, whatever the lesson-specific checks above allowed.
    crate::generator::support::state_validation::validate_reachable_state(state)
}

/// Apply a model evaluation to a validated candidate.
///
/// `riichi_discard` is the discard chosen by the second pass when the model
/// selected Riichi.
pub(crate) fn apply_evaluation(
    state: &mut GameState,
    evaluation: &Evaluation,
    riichi_discard: Option<&str>,
) -> Result<(), String> {
    if !evaluation_matches_legal_actions(state, evaluation) {
        return Err("model evaluation does not cover the legal action set".to_string());
    }
    if evaluation.recommended_action == "Riichi" && riichi_discard.is_none() {
        return Err("Riichi recommendation has no second-pass discard".to_string());
    }

    let correct_action = correct_action_from_recommendation(state, evaluation, riichi_discard)?;
    let ai_decision = build_ai_decision(state, evaluation, None);
    state.correct_action = correct_action;
    state.target_action = TargetAction::Best;
    state.ai_decision = Some(ai_decision);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate::validate_candidate;
    use super::*;
    use crate::ai::finalize::action_info;
    use crate::decision::{ActionEvaluation, ActionKind};
    use crate::state::DecisionContext;

    fn valid_candidate() -> GameState {
        for _ in 0..100 {
            if let Ok(state) = build_self_turn_candidate("ai_best_action")
                && validate_candidate(&state).is_ok()
            {
                return state;
            }
        }
        panic!("could not build a valid pure-discard candidate");
    }

    #[test]
    fn structural_candidates_are_valid() {
        for run in 0..200 {
            let state = valid_candidate();
            validate_candidate(&state).unwrap_or_else(|err| panic!("run {run} invalid: {err}"));
            crate::generator::support::state_validation::validate_reachable_state(&state)
                .unwrap_or_else(|err| panic!("run {run} unreachable: {err}"));
            assert_eq!(state.category, "ai_best_action");
            assert_eq!(state.target_action, TargetAction::Best);
            assert_eq!(state.decision, DecisionContext::SelfTurn);
            assert!(state.ai_decision.is_none());
            assert_eq!(state.players.len(), 4);
            assert_eq!(state.players[0].hand.len(), 13);
            assert!(state.players[0].draw.is_some());
            assert_eq!(state.tiles.len(), 14);
        }
    }

    #[test]
    fn reaction_candidates_are_valid() {
        let mut families = [0usize; 5];
        for run in 0..160 {
            let state = build_reaction_candidate("ai_best_action")
                .unwrap_or_else(|err| panic!("run {run} failed: {err}"));
            validate_reaction_candidate(&state)
                .unwrap_or_else(|err| panic!("run {run} invalid: {err}"));
            crate::generator::support::state_validation::validate_reachable_state(&state)
                .unwrap_or_else(|err| panic!("run {run} unreachable: {err}"));
            let (from, tile, chankan) = match &state.decision {
                DecisionContext::ReactToDiscard { from, tile } => (from, tile, false),
                DecisionContext::ReactToKan { from, tile } => (from, tile, true),
                DecisionContext::SelfTurn => panic!("run {run}: not a reaction"),
            };
            assert_eq!(state.current_turn, *from);
            if chankan {
                families[4] += 1;
                assert!(state.players[*from].melds.iter().any(|meld| {
                    meld.meld_type == crate::state::MeldType::Kan
                        && meld.tiles.len() == 4
                        && meld.tiles.iter().all(|held| held == tile)
                }));
            } else {
                assert_eq!(
                    state.players[*from]
                        .discards
                        .last()
                        .map(|d| d.tile.as_str()),
                    Some(tile.as_str())
                );
            }
            assert_eq!(state.players[0].hand.len(), 13);
            assert!(state.players[0].draw.is_none());
            let actions = crate::ai::actions::legal_actions(&state);
            assert!(actions.iter().any(|a| a.kind == ActionKind::Pass));
            let non_pass = actions
                .iter()
                .filter(|a| a.kind != ActionKind::Pass)
                .count();
            assert!(non_pass > 0);
            if actions.iter().any(|a| a.kind == ActionKind::Chi) {
                families[0] += 1;
            }
            if actions.iter().any(|a| a.kind == ActionKind::Pon) {
                families[1] += 1;
            }
            if actions.iter().any(|a| a.kind == ActionKind::Kan) {
                families[2] += 1;
            }
            if actions.iter().any(|a| a.kind == ActionKind::Agari) {
                families[3] += 1;
            }
        }
        assert!(
            families.iter().all(|&count| count > 0),
            "reaction family coverage: {families:?}"
        );
    }

    fn evaluation_for(state: &GameState, action: &str) -> Evaluation {
        let actions = crate::ai::actions::legal_actions(state);
        let count = actions.len().max(1) as f32;
        Evaluation {
            model: "test_model.safetensors".to_string(),
            expected_value: 0.1,
            recommended_action: action.to_string(),
            evaluations: actions
                .iter()
                .map(|info| ActionEvaluation {
                    info: info.clone(),
                    probability: if info.action == action {
                        0.6
                    } else {
                        0.4 / (count - 1.0).max(1.0)
                    },
                })
                .collect(),
        }
    }

    #[test]
    fn reaction_evaluation_finalizes() {
        let mut state = build_reaction_candidate("ai_best_action").expect("reaction");
        let action = crate::ai::actions::legal_actions(&state)
            .into_iter()
            .find(|info| info.kind != ActionKind::Pass)
            .expect("non-pass action");
        let evaluation = evaluation_for(&state, &action.action);
        apply_evaluation(&mut state, &evaluation, None).expect("apply reaction");
        assert_eq!(state.target_action, TargetAction::Best);
        assert!(matches!(
            state.correct_action,
            crate::state::CorrectAction::Best { .. }
        ));
        let ai = state.ai_decision.expect("ai decision");
        assert_eq!(ai.recommended_action, action.action);
    }

    #[test]
    fn riichi_evaluation_uses_the_second_pass_discard() {
        let mut state =
            super::self_turn::build_riichi_candidate("ai_best_action").expect("riichi candidate");
        let discard = crate::ai::actions::legal_actions(&state)
            .into_iter()
            .find(|info| info.kind == ActionKind::Discard)
            .and_then(|info| info.tile)
            .expect("discard tile");
        let evaluation = evaluation_for(&state, "Riichi");
        apply_evaluation(&mut state, &evaluation, Some(&discard)).expect("apply riichi");
        assert_eq!(
            state.correct_action.action_type(),
            crate::state::CorrectActionType::Best
        );
        assert_eq!(state.correct_action.tile(), Some(discard.as_str()));
        assert!(matches!(
            &state.correct_action,
            crate::state::CorrectAction::Best { action, .. } if action == "Riichi"
        ));
    }

    #[test]
    fn synthetic_evaluation_becomes_the_answer() {
        let mut state = valid_candidate();
        let actions = crate::ai::actions::legal_actions(&state);
        let recommended = actions
            .iter()
            .find(|info| info.kind == ActionKind::Discard)
            .expect("pure discard has a discard")
            .clone();
        let evaluation = Evaluation {
            model: "test_model.safetensors".to_string(),
            expected_value: 0.25,
            recommended_action: recommended.action.clone(),
            evaluations: actions
                .iter()
                .map(|info| ActionEvaluation {
                    info: info.clone(),
                    probability: if info.action == recommended.action {
                        0.5
                    } else {
                        0.5 / (actions.len().max(2) - 1) as f32
                    },
                })
                .collect(),
        };

        apply_evaluation(&mut state, &evaluation, None).expect("evaluation must apply");
        let expected = action_info(&state, &recommended.action).expect("recommended info");
        assert_eq!(state.target_action, TargetAction::Best);
        assert_eq!(
            state.correct_action.action_type(),
            crate::state::CorrectActionType::Best
        );
        assert_eq!(
            state.correct_action.tile(),
            Some(expected.tile.as_deref().unwrap())
        );
        let ai = state.ai_decision.expect("ai decision");
        assert_eq!(ai.model, "test_model.safetensors");
        assert_eq!(ai.recommended_action, recommended.action);
        assert!(!ai.actions.is_empty());
        assert!(!ai.evaluations.is_empty());
    }

    #[test]
    fn zero_weight_model_generates_a_finalized_state() {
        use crate::ai::model::MortalV4Model;
        use candle_core::{DType, Device};
        use candle_nn::VarBuilder;

        let device = Device::Cpu;
        let vb = VarBuilder::zeros(DType::F32, &device);
        let model = MortalV4Model::new(vb).expect("zero-weight model");

        for run in 0..10 {
            let state = generate(&model, "zero_weights", "ai_best_action")
                .unwrap_or_else(|err| panic!("run {run}: {err}"));
            assert_eq!(state.target_action, TargetAction::Best);
            assert!(state.correct_action.action_type() == crate::state::CorrectActionType::Best);
            let ai = state.ai_decision.expect("ai decision");
            assert!(!ai.evaluations.is_empty());
            assert!(
                ai.actions
                    .iter()
                    .any(|action| action.action == ai.recommended_action)
            );
        }
    }

    #[test]
    fn real_weights_generate_a_discard_answer() {
        const WEIGHTS: &str = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/frontend/public/models/mortal_298k.safetensors"
        );
        if !std::path::Path::new(WEIGHTS).exists() {
            eprintln!("skipping AI scenario inference test: {WEIGHTS} is missing");
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

        for run in 0..20 {
            let state = generate(&model, "mortal_298k.safetensors", "ai_best_action")
                .unwrap_or_else(|err| panic!("run {run} failed: {err}"));
            assert_eq!(state.category, "ai_best_action");
            assert!(state.correct_action.action_type() == crate::state::CorrectActionType::Best);
            let ai = state.ai_decision.expect("ai decision");
            assert!(
                ai.actions
                    .iter()
                    .any(|action| action.action == ai.recommended_action)
            );
            let total: f32 = ai.evaluations.iter().map(|e| e.probability).sum();
            assert!((total - 1.0).abs() < 1e-3);
        }
    }
}
