//! Verdict derivation and answer auditing for imported reports.

use crate::state::CorrectAction;
use crate::verdict;

use super::model::{ReportVerdict, ReportedAction};

/// Compare a submitted answer with the book's expected action.
///
/// This is the book-only half of the dual verdict; report construction uses
/// [`crate::verdict::grade_answer`] so Mortal is included when available.
pub fn evaluate(expected: &CorrectAction, answer: &ReportedAction) -> ReportVerdict {
    let book = verdict::grade_book(expected, answer);
    ReportVerdict::from_dual(&verdict::grade_from_parts(Some(book), None), expected)
}

/// Check that a report's answer is present in the human hand or draw.
///
/// This is only a warning: a malformed answer may be part of the bug being
/// reported, and rejecting the report would hide it.
pub fn answer_tile_visible(table: &crate::state::GameState, answer: &ReportedAction) -> bool {
    // A call-or-pass answer names no tile: the thing it names is the opponent's
    // discard, which the table shows in the source's river.
    if answer.tile.is_empty() {
        return true;
    }

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
    fn a_pass_answer_names_no_tile_to_look_for() {
        let table = crate::fixtures::mock_table::generate("mock_table").expect("fixture");
        assert!(answer_tile_visible(
            &table,
            &answer(CorrectActionType::Pass, "")
        ));
        assert!(!answer_tile_visible(
            &table,
            &answer(CorrectActionType::Pass, "not-in-hand")
        ));
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
