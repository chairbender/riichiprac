//! Stretched single (nobetan), Riichi Book 1 ch. 3, ch3:662/669.
//!
//! `3456` and `4567` are the most versatile four-tile shapes. Discarding an end
//! accepts more tiles right now, but it turns the shape into a run and leaves
//! the remaining protoruns closed or edge waits. The book keeps the shape until
//! the hand is ready or 1-away.
//!
//! The recogniser requires the book's counter-intuitive comparison: exactly one
//! 3456/4567, a shape-preserving discard that is the best such discard, both
//! ends accepting strictly more, and the kept shape reaching strictly more
//! side-wait completions.

use agari::tile::Tile;

use super::{Plan, matched, nobetans, pair_kinds, view};
use crate::classifier::Match;
use crate::generator::{ScenarioId, side_wait_routes};
use crate::state::GameState;

/// Recognise "keep the stretched single, throw the float".
pub fn nobetan_keep(state: &GameState) -> Option<Match> {
    let view = view(state)?;
    if view.melds != 0 || view.shanten() != 2 {
        return None;
    }
    let stretched = nobetans(&view.full);
    if stretched.len() != 1 {
        return None;
    }
    let (suit, base) = stretched[0];
    let ends = [Tile::suited(suit, base), Tile::suited(suit, base + 3)];
    // The 2-away closed-hand lesson has two pairs (head and rival pair); three
    // pairs is the pair-count lesson's board.
    if pair_kinds(&view.full).len() != 2 {
        return None;
    }

    let plans = view.plans();
    let keep_plans: Vec<&Plan> = plans
        .iter()
        .filter(|plan| plan.shanten == 2 && nobetans(&plan.kept).contains(&(suit, base)))
        .collect();
    if keep_plans.is_empty() {
        return None;
    }
    // The answer is the unique best shape-preserving discard.
    let max = keep_plans.iter().map(|plan| plan.total).max()?;
    let best: Vec<&&Plan> = keep_plans.iter().filter(|plan| plan.total == max).collect();
    if best.len() != 1 {
        return None;
    }
    let answer = best[0];

    // Both ends must be the larger-acceptance temptation and must break the
    // shape.
    for end in ends {
        let push = plans.iter().find(|plan| plan.tile == end)?;
        if push.shanten != 2 || push.total <= answer.total {
            return None;
        }
        if nobetans(&push.kept).contains(&(suit, base)) {
            return None;
        }
        if side_wait_routes(&answer.kept) <= side_wait_routes(&push.kept) {
            return None;
        }
    }

    matched(
        ScenarioId::NobetanKeep,
        "2-away: keep 3456/4567 despite the ends' larger immediate acceptance",
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
    fn generated_nobetan_states_classify() {
        assert_lesson_answers_its_generated_state(ScenarioId::NobetanKeep, 6);
    }

    #[test]
    fn moving_one_stretched_single_rank_is_not_the_lesson() {
        let state = generate_puzzle("nobetan_keep").expect("must generate");
        let view = super::view(&state).expect("a view");
        let (suit, base) = nobetans(&view.full)[0];
        let keep = Tile::suited(suit, base);
        let broken = replace_tile(&state, &keep.to_string(), "1z");
        assert!(nobetan_keep(&broken).is_none());
    }

    #[test]
    fn a_near_miss_from_the_pair_count_lesson_is_not_recognised() {
        near_miss(ScenarioId::NobetanKeep, ScenarioId::PairCount);
    }
}
