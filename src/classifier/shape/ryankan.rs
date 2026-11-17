//! Double closed (ryankan) break (Riichi Book 1, ch. 3, ch3:523).
//!
//! When a draw lands next to the head it creates a side-wait protorun. The
//! ryankan is worth only two kinds, and it only gets worse as the hand nears
//! ready, so the book keeps the new side wait and breaks the double closed
//! shape instead.
//!
//! The recogniser requires the exact trade the book describes: breaking the
//! ryankan's low terminal keeps a side wait reachable, while undoing the draw
//! and breaking the high terminal both leave closed waits only.

use agari::tile::Tile;

use super::{Plan, count, matched, ryankans, view};
use crate::classifier::Match;
use crate::generator::ScenarioId;
use crate::generator::support::completion::can_reach_side_wait;
use crate::state::GameState;

/// Recognise the "break the ryankan's low terminal" discard.
pub fn ryankan_break(state: &GameState) -> Option<Match> {
    let view = view(state)?;
    if view.shanten() != 1 {
        return None;
    }
    let plans: Vec<Plan> = view
        .plans()
        .into_iter()
        .filter(|plan| plan.shanten == 1)
        .collect();

    // The draw sits directly below the head, which is what creates the new
    // side wait; the ryankan's top tile is one rank below the draw.
    if !has_head_above(&view.full, view.draw) {
        return None;
    }
    let draw_plan = plans.iter().find(|plan| plan.tile == view.draw)?;
    // Undoing the draw must leave closed/edge waits only, or this is the
    // perfect-shape cell rather than the ryankan lesson.
    if can_reach_side_wait(&view.effective(&draw_plan.kept)) {
        return None;
    }

    // The answer is the low terminal of the ryankan: it keeps a side wait
    // reachable while the high terminal does not, and it accepts at least as
    // much as undoing the draw. More than one ryankan that satisfies this is
    // undecided.
    let mut answers: Vec<Tile> = Vec::new();
    let (Some(draw_suit), Some(draw_value)) = (view.draw.suit(), view.draw.value()) else {
        return None;
    };
    for (suit, base) in ryankans(&view.full) {
        let low = Tile::suited(suit, base);
        let high = Tile::suited(suit, base + 4);
        if suit != draw_suit
            || high.value() != draw_value.checked_sub(1)
            || low == view.draw
            || count(&view.full, high) == 0
        {
            continue;
        }
        let Some(low_plan) = plans.iter().find(|plan| plan.tile == low) else {
            continue;
        };
        let Some(high_plan) = plans.iter().find(|plan| plan.tile == high) else {
            continue;
        };
        if !can_reach_side_wait(&view.effective(&low_plan.kept))
            || can_reach_side_wait(&view.effective(&high_plan.kept))
            || low_plan.total < draw_plan.total
        {
            continue;
        }
        answers.push(low);
    }
    answers.sort();
    answers.dedup();
    if answers.len() != 1 {
        return None;
    }

    matched(
        ScenarioId::RyankanBreak,
        "draw beside the head: keep the new side wait, break the low end of the double closed shape",
        answers[0],
        Vec::new(),
    )
}

/// True when a pair sits exactly one rank above `tile` in the same suit (the
/// head the draw lands beside).
fn has_head_above(tiles: &[Tile], tile: Tile) -> bool {
    let (Some(suit), Some(value)) = (tile.suit(), tile.value()) else {
        return false;
    };
    value
        .checked_add(1)
        .filter(|other| *other <= 9)
        .is_some_and(|other| count(tiles, Tile::suited(suit, other)) >= 2)
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::classifier::shape::tests::{
        assert_lesson_answers_its_generated_state, near_miss, replace_tile,
    };
    use crate::generator::generate_puzzle;

    #[test]
    fn generated_ryankan_states_classify() {
        assert_lesson_answers_its_generated_state(ScenarioId::RyankanBreak, 8);
    }

    #[test]
    fn a_hand_without_a_reachable_side_wait_is_not_the_lesson() {
        let state = generate_puzzle("ryankan_break").expect("must generate");
        // Replace the draw with a tile that does not sit next to the head, so
        // no side wait is created and the partition cannot be the book's.
        let broken = replace_tile(&state, find_draw(&state), "1z");
        assert!(ryankan_break(&broken).is_none());
    }

    #[test]
    fn a_near_miss_from_the_perfect_lesson_is_not_recognised() {
        near_miss(ScenarioId::RyankanBreak, ScenarioId::PerfectOneAway);
    }

    fn find_draw(state: &GameState) -> &str {
        state.players[0].draw.as_deref().expect("a draw")
    }
}
