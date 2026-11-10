//! Helpers that turn a model evaluation into a trainer answer.

use std::collections::BTreeSet;

use crate::decision::{ActionInfo, ActionKind, AiDecision};
use crate::state::{CorrectAction, GameState};

use super::actions::legal_actions;
use super::wasm_bridge::Evaluation;

/// Collapse a red-five discard action onto its base tile for grading.
pub fn normalize_mortal_action(action: &str) -> String {
    if let Some(tile) = action.strip_prefix("Discard_")
        && let Some(base) = tile.strip_suffix('r')
    {
        return format!("Discard_{base}");
    }
    action.to_string()
}

/// Find the render details for a model action.
pub fn action_info(state: &GameState, action: &str) -> Option<ActionInfo> {
    legal_actions(state)
        .into_iter()
        .find(|info| info.action == action)
}

/// Whether the evaluation covers exactly the legal action set.
pub fn evaluation_matches_legal_actions(state: &GameState, evaluation: &Evaluation) -> bool {
    let legal: BTreeSet<String> = legal_actions(state)
        .into_iter()
        .map(|info| info.action)
        .collect();
    let scored: BTreeSet<String> = evaluation
        .evaluations
        .iter()
        .map(|scored| scored.info.action.clone())
        .collect();
    legal == scored
}

/// Turn one action into the trainer's `correct_action`.
pub fn correct_action_from_info(info: &ActionInfo, tile_override: Option<&str>) -> CorrectAction {
    let tile = tile_override
        .map(str::to_string)
        .or_else(|| info.tile.clone());
    CorrectAction::best(
        normalize_mortal_action(&info.action),
        tile,
        info.tiles.clone(),
        info.label.clone(),
    )
}

/// Turn the model's argmax into the trainer's answer.
pub fn correct_action_from_recommendation(
    state: &GameState,
    evaluation: &Evaluation,
    tile_override: Option<&str>,
) -> Result<CorrectAction, String> {
    let info = action_info(state, &evaluation.recommended_action).ok_or_else(|| {
        format!(
            "model recommended {}, which is not a legal action",
            evaluation.recommended_action
        )
    })?;
    Ok(correct_action_from_info(&info, tile_override))
}

/// Build the AI payload attached to a scenario.
pub fn build_ai_decision(
    state: &GameState,
    evaluation: &Evaluation,
    reasoning: Option<String>,
) -> AiDecision {
    let mut actions = legal_actions(state);
    actions.sort_by_key(action_sort_key);

    AiDecision {
        model: evaluation.model.clone(),
        reasoning,
        expected_value: evaluation.expected_value,
        recommended_action: evaluation.recommended_action.clone(),
        evaluations: evaluation.evaluations.clone(),
        actions,
    }
}

fn action_sort_key(info: &ActionInfo) -> (u8, Option<usize>, String) {
    let kind = match info.kind {
        ActionKind::Riichi => 0,
        ActionKind::Chi => 1,
        ActionKind::Pon => 2,
        ActionKind::Kan => 3,
        ActionKind::Agari => 4,
        ActionKind::Ryukyoku => 5,
        ActionKind::Pass => 6,
        ActionKind::Discard => 7,
    };
    (kind, info.tile_index, info.action.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decision::ActionEvaluation;

    #[test]
    fn red_five_is_normalized_for_grading() {
        assert_eq!(normalize_mortal_action("Discard_5mr"), "Discard_5m");
        assert_eq!(normalize_mortal_action("Discard_5m"), "Discard_5m");
        assert_eq!(normalize_mortal_action("Pon"), "Pon");
    }

    #[test]
    fn action_sort_puts_calls_before_discards() {
        let info = |kind, action: &str| ActionInfo {
            action: action.to_string(),
            label: action.to_string(),
            kind,
            tile_index: None,
            tile: None,
            tiles: Vec::new(),
            kan_kind: None,
        };
        let mut actions = [
            info(ActionKind::Discard, "Discard_1m"),
            info(ActionKind::Pass, "Pass"),
            info(ActionKind::Pon, "Pon"),
        ];
        actions.sort_by_key(action_sort_key);
        assert_eq!(actions[0].action, "Pon");
        assert_eq!(actions[1].action, "Pass");
        assert_eq!(actions[2].action, "Discard_1m");
    }

    #[test]
    fn evaluation_must_cover_every_legal_action() {
        let state =
            crate::fixtures::mock_table::generate("mock_table").expect("mock table must build");
        let legal = legal_actions(&state);
        let evaluation = Evaluation {
            model: "test".to_string(),
            expected_value: 0.0,
            recommended_action: legal[0].action.clone(),
            evaluations: legal
                .iter()
                .cloned()
                .map(|info| ActionEvaluation {
                    info,
                    probability: 1.0 / legal.len() as f32,
                })
                .collect(),
        };
        assert!(evaluation_matches_legal_actions(&state, &evaluation));

        let mut missing = evaluation.clone();
        missing.evaluations.pop();
        assert!(!evaluation_matches_legal_actions(&state, &missing));
    }
}
