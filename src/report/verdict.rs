//! Verdict derivation and answer auditing for imported reports.

use crate::state::CorrectAction;

use super::model::{ReportVerdict, ReportedAction};

/// Compare a submitted answer with the app's expected action.
pub fn evaluate(expected: &CorrectAction, answer: &ReportedAction) -> ReportVerdict {
    let expected_action = expected.action_type();
    let expected_tile = expected.tile();

    let is_action_correct = answer.action == expected_action;
    let is_tile_correct = match expected_tile {
        Some(tile) => answer.tile == tile,
        None => answer.tile.is_empty(),
    };

    ReportVerdict {
        is_correct: is_action_correct && is_tile_correct,
        is_action_correct,
        is_tile_correct,
        expected_action,
        expected_tile: expected_tile.unwrap_or_default().to_string(),
    }
}

/// Check that a report's answer is present in the human hand or draw.
///
/// This is only a warning: a malformed answer may be part of the bug being
/// reported, and rejecting the report would hide it.
pub fn answer_tile_visible(table: &crate::state::GameState, answer: &ReportedAction) -> bool {
    let Some(human) = table.players.iter().find(|player| player.is_human) else {
        return false;
    };

    human.hand.iter().any(|tile| tile == &answer.tile)
        || human.draw.as_deref() == Some(answer.tile.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::CorrectActionType;

    fn answer(action: CorrectActionType, tile: &str) -> ReportedAction {
        ReportedAction::new(action, tile)
    }

    #[test]
    fn matching_action_and_tile_is_correct() {
        let verdict = evaluate(
            &CorrectAction::riichi("3p"),
            &answer(CorrectActionType::Riichi, "3p"),
        );

        assert!(verdict.is_correct);
        assert!(verdict.is_action_correct);
        assert!(verdict.is_tile_correct);
        assert_eq!(verdict.expected_action, CorrectActionType::Riichi);
        assert_eq!(verdict.expected_tile, "3p");
    }

    #[test]
    fn wrong_action_with_right_tile_is_only_action_wrong() {
        let verdict = evaluate(
            &CorrectAction::dama("3p"),
            &answer(CorrectActionType::Riichi, "3p"),
        );

        assert!(!verdict.is_correct);
        assert!(!verdict.is_action_correct);
        assert!(verdict.is_tile_correct);
        assert_eq!(verdict.expected_action, CorrectActionType::Dama);
    }

    #[test]
    fn right_action_with_wrong_tile_is_only_tile_wrong() {
        let verdict = evaluate(
            &CorrectAction::dama("3p"),
            &answer(CorrectActionType::Dama, "5s"),
        );

        assert!(!verdict.is_correct);
        assert!(verdict.is_action_correct);
        assert!(!verdict.is_tile_correct);
        assert_eq!(verdict.expected_tile, "3p");
    }

    #[test]
    fn kan_and_discard_actions_use_the_tile_field() {
        let kan = evaluate(
            &CorrectAction::kan("5p"),
            &answer(CorrectActionType::Kan, "5p"),
        );
        assert!(kan.is_correct);
        assert_eq!(kan.expected_action, CorrectActionType::Kan);

        let discard = evaluate(
            &CorrectAction::discard("5p"),
            &answer(CorrectActionType::Discard, "5p"),
        );
        assert!(discard.is_correct);
        assert_eq!(discard.expected_action, CorrectActionType::Discard);
    }
}
