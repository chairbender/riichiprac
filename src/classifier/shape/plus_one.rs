//! Protorun plus one priority (Riichi Book 1, ch. 3, ch3:574).
//!
//! Two covered protoruns accept the same total when one cover is dropped, so
//! raw acceptance cannot choose between them. The book covers the **weaker**
//! protorun: the side wait is strong enough bare, while the closed wait needs
//! the back-up copy. The answer is therefore the side-wait shape's cover.
//!
//! The recogniser requires the book's premise: exactly one side-wait covered
//! shape and one closed-wait covered shape, their two cover discards tie for
//! the highest acceptance, and every other discard is strictly worse. A hand
//! with a different cover count is not this question.

use super::{PlusOne, count, matched, plus_ones, view};
use crate::classifier::Match;
use crate::generator::ScenarioId;
use crate::state::GameState;

/// Recognise "discard the side-wait shape's cover".
pub fn protorun_plus_one(state: &GameState) -> Option<Match> {
    let view = view(state)?;
    if view.shanten() != 1 {
        return None;
    }
    let shapes = plus_ones(&view.full);
    let side: Vec<&PlusOne> = shapes.iter().filter(|shape| shape.side_wait).collect();
    let closed: Vec<&PlusOne> = shapes.iter().filter(|shape| !shape.side_wait).collect();
    if side.len() != 1 || closed.len() != 1 {
        return None;
    }
    let (side, closed) = (side[0], closed[0]);
    if side.cover() == closed.cover() {
        return None;
    }
    // The two shapes must be genuinely separate blocks.
    if side
        .tiles()
        .iter()
        .any(|tile| closed.tiles().contains(tile))
    {
        return None;
    }

    let plans = view.plans();
    let answer = plans
        .iter()
        .find(|plan| plan.tile == side.cover() && plan.shanten == 1)?;
    let rival = plans
        .iter()
        .find(|plan| plan.tile == closed.cover() && plan.shanten == 1)?;
    if answer.total != rival.total {
        return None;
    }
    // The book's question is a tie between the two covers; a third discard at
    // the same acceptance would make the drill undecided.
    let max = plans
        .iter()
        .filter(|plan| plan.shanten == 1)
        .map(|plan| plan.total)
        .max()?;
    if answer.total != max {
        return None;
    }
    if plans
        .iter()
        .filter(|plan| plan.shanten == 1 && plan.total == max)
        .count()
        != 2
    {
        return None;
    }
    if count(&view.full, side.cover()) < 2 || count(&view.full, closed.cover()) < 2 {
        return None;
    }

    matched(
        ScenarioId::ProtorunPlusOne,
        "two covered protoruns: cover the weaker closed wait and leave the side wait bare",
        side.cover(),
        Vec::new(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::classifier::shape::tests::{
        assert_lesson_answers_its_generated_state, near_miss, replace_tile,
    };
    use crate::generator::generate_puzzle;

    #[test]
    fn generated_plus_one_states_classify() {
        assert_lesson_answers_its_generated_state(ScenarioId::ProtorunPlusOne, 8);
    }

    #[test]
    fn a_hand_with_only_one_covered_shape_is_not_the_lesson() {
        let state = generate_puzzle("protorun_plus_one").expect("must generate");
        assert!(
            state.equivalent_tiles.is_empty(),
            "the rival cover is deliberately not an equivalent"
        );
        // Break the weak closed-wait shape by moving its partner into the
        // strong shape's suit: with only one covered protorun the book's
        // cross-shape comparison disappears.
        let weak_cover = find_weak_cover(&state);
        let strong_cover = state.correct_action.tile().expect("an answer").to_string();
        let broken = replace_tile(&state, &weak_cover, &strong_cover);
        assert!(protorun_plus_one(&broken).is_none());
    }

    #[test]
    fn a_near_miss_from_the_priority_lesson_is_not_recognised() {
        near_miss(ScenarioId::ProtorunPlusOne, ScenarioId::ProtorunPriority);
    }

    fn find_weak_cover(state: &GameState) -> String {
        let view = super::view(state).expect("a view");
        let shapes = plus_ones(&view.full);
        shapes
            .iter()
            .find(|shape| !shape.side_wait)
            .map(|shape| shape.cover().to_string())
            .expect("a closed covered shape")
    }
}
