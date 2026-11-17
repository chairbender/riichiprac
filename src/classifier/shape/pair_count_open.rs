//! Open-hand pair count (Riichi Book 1, ch. 3, ch3:351).
//!
//! "When we intend to call pon, having three pairs is actually better than
//! having two pairs": the Pon turns the target pair into a set and leaves two
//! pairs. This is the mirror image of the closed lesson, but the board is still
//! closed at the decision, so the planned Pon is stated on screen.
//!
//! The recogniser reads the same visible plan the player does: an honour pair
//! with both remaining copies live. It then compares the book's line after the
//! hypothetical Pon against the closed-hand oracle's preferred pair break, and
//! requires the book's line to accept strictly more. The redundant float may
//! tie the book's discard before and after the Pon; then it is the same two
//! discards in the other order and is graded as an equivalent.

use agari::parse::to_counts;
use agari::shanten::{calculate_shanten_with_melds, calculate_ukeire_with_melds};
use agari::tile::Tile;

use super::{Plan, count, live_copies, matched, pair_kinds, view};
use crate::classifier::Match;
use crate::generator::ScenarioId;
use crate::state::GameState;

/// Recognise "keep three pairs when the Pon is planned".
pub fn pair_count_open(state: &GameState) -> Option<Match> {
    let view = view(state)?;
    if view.melds != 0 || view.shanten() != 2 {
        return None;
    }
    let pairs = pair_kinds(&view.full);
    if pairs.len() != 3 {
        return None;
    }
    // The Pon target must be an honour pair whose other two copies are live.
    let targets: Vec<Tile> = pairs
        .iter()
        .copied()
        .filter(|pair| pair.is_honor() && live_copies(&view, *pair) == 2)
        .collect();
    if targets.len() != 1 {
        return None;
    }
    let target = targets[0];
    // The draw must complete one of the other two pairs, as the closed lesson
    // requires; the open cell is defined by keeping the drawn pair instead.
    if view.draw == target || !pairs.contains(&view.draw) {
        return None;
    }

    let plans: Vec<Plan> = view
        .plans()
        .into_iter()
        .filter(|plan| plan.shanten == 2)
        .collect();

    // The closed-hand rival is the drawn tile's pair break, exactly as the
    // closed lesson would answer.
    let rival = plans.iter().find(|plan| plan.tile == view.draw)?;
    if pair_kinds(&rival.kept).len() != 2 {
        return None;
    }

    // Candidate answers keep all three pairs and are not pair tiles.
    let keep_plans: Vec<&Plan> = plans
        .iter()
        .filter(|plan| {
            plan.tile != target
                && !pairs.contains(&plan.tile)
                && pair_kinds(&plan.kept).len() == 3
                && count(&plan.kept, target) == 2
        })
        .collect();
    if keep_plans.is_empty() {
        return None;
    }

    // The closed oracle must prefer the rival, and the planned Pon must reverse
    // that preference for the book's line.
    let rival_pon = pon_line(&rival.kept, target)?;
    let scored: Vec<(&Plan, (i8, u8))> = keep_plans
        .iter()
        .filter_map(|plan| pon_line(&plan.kept, target).map(|line| (*plan, line)))
        .collect();
    let best = scored
        .iter()
        .map(|(plan, (shanten, acceptance))| (*shanten, *acceptance, plan.total))
        .max()?;
    let top: Vec<&&Plan> = scored
        .iter()
        .filter(|(plan, (shanten, acceptance))| {
            *shanten == best.0 && *acceptance == best.1 && plan.total == best.2
        })
        .map(|(plan, _)| plan)
        .collect();
    if top.is_empty() {
        return None;
    }
    let answer = top[0];
    if answer.total >= rival.total {
        return None;
    }
    if answer.total + 2 < rival.total {
        return None;
    }
    if best.0 != 1 || best.1 <= rival_pon.1 {
        return None;
    }
    // Only the redundant float may tie the answer on both comparisons.
    for (plan, (shanten, acceptance)) in &scored {
        if plan.tile == answer.tile {
            continue;
        }
        let tie = *shanten == best.0 && *acceptance == best.1 && plan.total == best.2;
        if tie {
            continue;
        }
        if *shanten == best.0 && *acceptance == best.1 {
            return None;
        }
    }

    matched(
        ScenarioId::PairCountOpen,
        "Pon planned: keep three pairs, break the closed wait instead of a pair",
        answer.tile,
        top.iter()
            .filter(|plan| plan.tile != answer.tile)
            .map(|plan| plan.tile)
            .collect(),
    )
}

/// Shanten and acceptance after the planned Pon, before the follow-up discard.
fn pon_line(kept: &[Tile], target: Tile) -> Option<(i8, u8)> {
    if count(kept, target) != 2 {
        return None;
    }
    let concealed: Vec<Tile> = kept
        .iter()
        .copied()
        .filter(|tile| *tile != target)
        .collect();
    let counts = to_counts(&concealed);
    Some((
        calculate_shanten_with_melds(&counts, 1).shanten,
        calculate_ukeire_with_melds(&counts, 1).total_count,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::classifier::shape::tests::{assert_lesson_answers_its_generated_state, near_miss};
    use crate::generator::generate_puzzle;

    #[test]
    fn generated_open_pair_states_classify() {
        assert_lesson_answers_its_generated_state(ScenarioId::PairCountOpen, 8);
    }

    #[test]
    fn a_suited_third_pair_has_no_visible_pon_plan() {
        let state = generate_puzzle("pair_count_open").expect("must generate");
        // Replace the honour pair with a suited pair: the visible Pon plan is
        // gone, so the open-hand rule has no target.
        let view = super::view(&state).expect("a view");
        let target = pair_kinds(&view.full)
            .into_iter()
            .find(|pair| pair.is_honor())
            .expect("an honour pair");
        let unused = "1m";
        let mut broken = state.clone();
        for code in &mut broken.players[0].hand {
            if *code == target.to_string() {
                *code = unused.to_string();
            }
        }
        if broken.players[0].draw.as_deref() == Some(target.to_string().as_str()) {
            broken.players[0].draw = Some(unused.to_string());
        }
        assert!(pair_count_open(&broken).is_none());
    }

    #[test]
    fn a_near_miss_from_the_closed_pair_lesson_is_not_recognised() {
        near_miss(ScenarioId::PairCountOpen, ScenarioId::PairCount);
    }
}
