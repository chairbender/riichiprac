//! Skipping shape (Riichi Book 1 ch. 3, ch3:713, `tbl:skipping`).
//!
//! A floating tile two ranks from a complete run beats an isolated tile of the
//! same rank even though the hand's raw acceptance is identical: the skipping
//! group turns into a run plus a protorun on more kinds of draws. The book's
//! own example keeps `3p` (skipping to `567p`) and throws the isolated `3m`.
//!
//! The recogniser requires both halves of that comparison: the two floats are
//! alone in their suits and accept exactly the same tiles right now, while the
//! skipping group's protorun draws strictly exceed the isolated tile's.

use agari::tile::Tile;

use super::{count, is_isolated, matched, skippings, view};
use crate::classifier::Match;
use crate::generator::{ScenarioId, isolated_turns, skipping_turns};
use crate::state::GameState;

/// Recognise "throw the isolated float, keep the skipping tile".
pub fn skipping_block(state: &GameState) -> Option<Match> {
    let view = view(state)?;
    if view.melds != 0 || view.shanten() != 2 {
        return None;
    }
    let plans = view.plans();
    let mut answers: Vec<Tile> = Vec::new();

    for skipping in skippings(&view.full) {
        if count(&view.full, skipping.float) != 1 {
            continue;
        }
        let Some(skip_plan) = plans.iter().find(|plan| plan.tile == skipping.float) else {
            continue;
        };
        if skip_plan.shanten != 2 {
            continue;
        }

        // The competitor is an isolated float of the same rank in another suit.
        for candidate in view.distinct() {
            if candidate == skipping.float
                || candidate.value() != skipping.float.value()
                || candidate.suit() == skipping.float.suit()
                || count(&view.full, candidate) != 1
                || !is_isolated(&view.full, candidate)
            {
                continue;
            }
            let Some(plan) = plans.iter().find(|plan| plan.tile == candidate) else {
                continue;
            };
            if plan.shanten != 2
                || plan.total != skip_plan.total
                || plan.waits.len() != skip_plan.waits.len()
            {
                continue;
            }
            if skipping_turns(skipping.float, skipping.run).len() <= isolated_turns(candidate).len()
            {
                continue;
            }
            answers.push(candidate);
        }
    }

    answers.sort();
    answers.dedup();
    if answers.len() != 1 {
        return None;
    }
    let answer = answers[0];

    matched(
        ScenarioId::SkippingBlock,
        "a float two ranks from a run beats an isolated float of the same rank",
        answer,
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
    fn generated_skipping_states_classify() {
        assert_lesson_answers_its_generated_state(ScenarioId::SkippingBlock, 8);
    }

    #[test]
    fn an_unrelated_isolated_tile_is_not_the_lesson() {
        let state = generate_puzzle("skipping_block").expect("must generate");
        // Replace the isolated float with a rank the skipping group does not
        // compete with; the book's same-rank comparison disappears.
        let answer = state.correct_action.tile().expect("an answer").to_string();
        let broken = replace_tile(&state, &answer, "1z");
        assert!(skipping_block(&broken).is_none());
    }

    #[test]
    fn a_near_miss_from_the_nobetan_lesson_is_not_recognised() {
        near_miss(ScenarioId::SkippingBlock, ScenarioId::NobetanKeep);
    }
}
