//! Perfect 1-away (Riichi Book 1 ch. 3, ch3:382/389).
//!
//! A 1-away hand with two side-wait protoruns and two pairs is "perfect": no
//! matter how it becomes ready, a side wait is always available. The drill's
//! draw turns one complex suit into a double closed shape, whose rival line
//! accepts slightly more tiles on paper. The book throws the draw back and
//! keeps the perfect shape.
//!
//! The recogniser requires exactly one discard that leaves the book's perfect
//! 1-away partition, and a non-perfect rival that accepts strictly more, so the
//! state is the lesson's counter-intuitive choice and not an ordinary
//! efficiency discard.

use super::{Plan, matched, view};
use crate::classifier::Match;
use crate::generator::{ScenarioId, is_perfect_one_away};
use crate::state::GameState;

/// Recognise "discard the draw and keep the perfect 1-away".
pub fn perfect_one_away(state: &GameState) -> Option<Match> {
    let view = view(state)?;
    if view.melds != 0 || view.shanten() != 1 {
        return None;
    }
    let plans: Vec<Plan> = view
        .plans()
        .into_iter()
        .filter(|plan| plan.shanten == 1)
        .collect();

    let perfect: Vec<&Plan> = plans
        .iter()
        .filter(|plan| is_perfect_one_away(&plan.kept))
        .collect();
    if perfect.len() != 1 {
        return None;
    }
    let answer = perfect[0];

    // The rival is the strongest ordinary discard: it accepts more tiles, but
    // gives up the perfect shape's guaranteed side wait.
    let rival = plans
        .iter()
        .filter(|plan| plan.tile != answer.tile)
        .max_by_key(|plan| plan.total)?;
    if rival.total <= answer.total {
        return None;
    }

    matched(
        ScenarioId::PerfectOneAway,
        "perfect 1-away: throw the draw back, keep two side waits and two pairs",
        answer.tile,
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
    fn generated_perfect_states_classify() {
        assert_lesson_answers_its_generated_state(ScenarioId::PerfectOneAway, 6);
    }

    #[test]
    fn breaking_the_shared_shape_is_not_the_lesson() {
        let state = generate_puzzle("perfect_one_away").expect("must generate");
        // Replace one tile of the shared side wait, destroying the perfect
        // partition; no discard may then leave the book's shape.
        let view = super::view(&state).expect("a view");
        let answer = state.correct_action.tile().expect("an answer").to_string();
        let tile = view
            .full
            .iter()
            .map(ToString::to_string)
            .find(|code| code != &answer)
            .expect("a tile");
        let broken = replace_tile(&state, &tile, "1z");
        assert!(perfect_one_away(&broken).is_none());
    }

    #[test]
    fn a_near_miss_from_the_ryankan_lesson_is_not_recognised() {
        near_miss(ScenarioId::PerfectOneAway, ScenarioId::RyankanBreak);
    }
}
