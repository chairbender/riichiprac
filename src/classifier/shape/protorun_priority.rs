//! Protorun priority (Riichi Book 1, ch. 3, ch3:205/230).
//!
//! A 1-away hand has one block too many. The two side-wait protoruns accept
//! twice the tiles a closed wait does, so the closed wait is the block to
//! break, and both of its tiles are the same discard.
//!
//! The recogniser looks for the book's decisive comparison rather than a named
//! skeleton: the closed wait's two tiles are the unique **tied** maximum
//! acceptance line, and the kept hand's four winning kinds are all side-wait
//! completions. Any hand where that comparison is not unique is not this
//! question.

use agari::tile::Tile;

use super::{Plan, count, matched, plan_waits_equal, view};
use crate::classifier::{Match, classify};
use crate::generator::ScenarioId;
use crate::state::GameState;

/// Recognise the "break the closed wait" discard.
pub fn protorun_priority(state: &GameState) -> Option<Match> {
    // The ch. 8 push/fold cell owns a 1-away hand whose shape also happens to
    // be a valid closed-wait break; the push/fold decision (whether to push at
    // all) is the lesson that board asks, so the block-theory ranking defers.
    if classify(state, ScenarioId::PushOrFold).is_some() {
        return None;
    }
    let view = view(state)?;
    if view.shanten() != 1 {
        return None;
    }
    let plans: Vec<Plan> = view
        .plans()
        .into_iter()
        .filter(|plan| plan.shanten == 1)
        .collect();
    if plans.len() < 3 {
        return None;
    }

    let max = plans.iter().map(|plan| plan.total).max()?;
    let tied: Vec<&Plan> = plans.iter().filter(|plan| plan.total == max).collect();
    // The closed wait's two tiles are the same discard and nothing else may
    // reach the same acceptance.
    if tied.len() != 2 {
        return None;
    }
    let [first, second] = [tied[0], tied[1]];
    if !is_closed_wait_pair(first.tile, second.tile) {
        return None;
    }
    if !plan_waits_equal(first, second) {
        return None;
    }
    // The kept hand must show the two surviving side waits: four winning
    // kinds, every one a side-wait route in a standard reading.
    if first.waits.len() != 4 || !is_two_side_waits(&first.kept) {
        return None;
    }

    matched(
        ScenarioId::ProtorunPriority,
        "one block too many: break the closed wait and keep both side waits",
        first.tile,
        vec![second.tile],
    )
}

/// Two tiles of the same suit exactly two ranks apart.
fn is_closed_wait_pair(left: Tile, right: Tile) -> bool {
    match (left.suit(), left.value(), right.suit(), right.value()) {
        (Some(left_suit), Some(left_value), Some(right_suit), Some(right_value)) => {
            left_suit == right_suit && left_value.abs_diff(right_value) == 2
        }
        _ => false,
    }
}

/// True when the hand contains two disjoint side-wait protoruns.
fn is_two_side_waits(tiles: &[Tile]) -> bool {
    let ryanmen = super::ryanmen_pairs(tiles);
    for (index, first) in ryanmen.iter().enumerate() {
        for second in &ryanmen[index + 1..] {
            if first.iter().all(|tile| !second.contains(tile))
                && first.iter().all(|tile| count(tiles, *tile) >= 1)
                && second.iter().all(|tile| count(tiles, *tile) >= 1)
            {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::classifier::shape::tests::{
        assert_lesson_answers_its_generated_state, near_miss, replace_tile,
    };
    use crate::generator::generate_puzzle;

    #[test]
    fn generated_protorun_priority_states_classify() {
        assert_lesson_answers_its_generated_state(ScenarioId::ProtorunPriority, 8);
    }

    #[test]
    fn a_hand_without_the_closed_wait_is_not_the_lesson() {
        let state = generate_puzzle("protorun_priority").expect("must generate");
        let answer = state.correct_action.tile().expect("an answer").to_string();
        // Turn the closed wait into a side wait: the two maximum lines no
        // longer form the closed-wait pair the lesson breaks.
        let high = state.equivalent_tiles[0].clone();
        let low = answer;
        let broken = replace_tile(&state, &high, &shift_one_rank(&low));
        assert!(protorun_priority(&broken).is_none());
    }

    #[test]
    fn a_near_miss_from_the_plus_one_lesson_is_not_recognised() {
        near_miss(ScenarioId::ProtorunPriority, ScenarioId::ProtorunPlusOne);
    }

    fn shift_one_rank(code: &str) -> String {
        let value = code[..1].parse::<u8>().expect("a rank");
        let suit = &code[1..];
        format!("{}{suit}", if value == 9 { 1 } else { value + 1 })
    }
}
