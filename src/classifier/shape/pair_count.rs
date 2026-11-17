//! Closed-hand pair count (Riichi Book 1, ch. 3, ch3:336/343).
//!
//! In a closed hand, avoid three pairs: keeping the new pair gains two tiles
//! but loses the side wait's eight. The answer is the tile that just completed
//! the third pair, and breaking either of the other two pairs leaves the same
//! two-pair hand, so those are graded as equivalents.
//!
//! The recogniser requires the book's arithmetic to decide the hand: the drawn
//! pair is the strict best discard against every three-pair line, all other
//! pair breaks tie it, and no other discard reaches it. A hand with a different
//! pair count or a stay-three-pairs line that is not strictly worse is the open
//! companion lesson or undecided.

use super::{Plan, count, matched, pair_kinds, view};
use crate::classifier::Match;
use crate::generator::ScenarioId;
use crate::state::GameState;

/// Recognise "break the third pair in a closed hand".
pub fn pair_count(state: &GameState) -> Option<Match> {
    let view = view(state)?;
    if view.melds != 0 || view.shanten() != 2 {
        return None;
    }
    let pairs = pair_kinds(&view.full);
    if pairs.len() != 3 {
        return None;
    }
    // The open-hand companion owns a live honour pair it plans to Pon; this
    // closed lesson never treats an honour pair as a callable target.
    if pairs.iter().any(|pair| pair.is_honor()) {
        return None;
    }
    // The draw must be the tile that completed the third pair.
    if !pairs.contains(&view.draw) || count(&view.full, view.draw) != 2 {
        return None;
    }

    let plans: Vec<Plan> = view
        .plans()
        .into_iter()
        .filter(|plan| plan.shanten == 2)
        .collect();
    let answer = plans.iter().find(|plan| plan.tile == view.draw)?;

    // Every discard that keeps three pairs must accept strictly less.
    for plan in &plans {
        if plan.tile == view.draw {
            continue;
        }
        if pair_kinds(&plan.kept).len() == 3 && plan.total >= answer.total {
            return None;
        }
    }

    // Every other two-pair line must tie the answer, so the pair choice itself
    // is not graded.
    let mut equivalents = Vec::new();
    for plan in &plans {
        if plan.tile == view.draw || pair_kinds(&plan.kept).len() != 2 {
            continue;
        }
        if plan.total != answer.total {
            return None;
        }
        equivalents.push(plan.tile);
    }
    if equivalents.is_empty() {
        return None;
    }
    // No non-pair discard may accidentally slip through at the answer's count.
    for plan in &plans {
        if plan.tile == view.draw || pair_kinds(&plan.kept).len() == 2 {
            continue;
        }
        if plan.total >= answer.total {
            return None;
        }
    }

    matched(
        ScenarioId::PairCount,
        "closed hand: three pairs are the weakest form, break the pair you just drew",
        view.draw,
        equivalents,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::classifier::shape::tests::{
        assert_lesson_answers_its_generated_state, near_miss, replace_tile, unused_honor,
    };
    use crate::generator::generate_puzzle;

    #[test]
    fn generated_pair_count_states_classify() {
        assert_lesson_answers_its_generated_state(ScenarioId::PairCount, 8);
    }

    #[test]
    fn two_pairs_is_not_the_three_pair_lesson() {
        let state = generate_puzzle("pair_count").expect("must generate");
        let equivalent = state.equivalent_tiles[0].clone();
        let unused = unused_honor(&state);
        let broken = replace_tile(&state, &equivalent, &unused);
        assert!(pair_count(&broken).is_none());
    }

    #[test]
    fn a_near_miss_from_the_open_companion_is_not_recognised() {
        near_miss(ScenarioId::PairCount, ScenarioId::PairCountOpen);
    }
}
