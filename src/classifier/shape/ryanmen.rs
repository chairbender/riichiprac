//! Ryanmen protorun plus one (Riichi Book 1, ch. 3).
//!
//! The hand holds `XXY` or `XYY` beside completed blocks: the duplicate `X` is
//! tempting because it looks like a pair, but throwing it keeps the consecutive
//! `XY` protorun as a live two-sided wait.

use agari::tile::Tile;

use super::{Plan, count, matched, sets_pair_ryanmen, view};
use crate::classifier::Match;
use crate::generator::ScenarioId;
use crate::state::GameState;

/// Recognise the ryanmen-protorun-plus-one discard.
///
/// The book's cell is a **tenpai** hand that partitions into three complete
/// sets (counting called melds), one pair and one side-wait protorun. The
/// duplicate is the tile whose discard leaves exactly that partition and whose
/// other copy is still in the protorun. A hand with a different tenpai reading,
/// or with two such discards, is not this question.
pub fn ryanmen_protorun(state: &GameState) -> Option<Match> {
    let view = view(state)?;
    if view.shanten() != 0 {
        return None;
    }
    let plans: Vec<Plan> = view
        .plans()
        .into_iter()
        .filter(|plan| plan.shanten == 0)
        .collect();

    let mut candidates: Vec<&Plan> = plans
        .iter()
        .filter(|plan| {
            plan.tile == view.draw && is_duplicate_ryanmen_discard(&view.full, plan, view.melds)
        })
        .collect();
    if candidates.len() != 1 {
        return None;
    }
    let plan = candidates.pop()?;
    if plan.waits.len() != 2 {
        return None;
    }

    matched(
        ScenarioId::RyanmenProtorun,
        "protorun plus one: keep the side wait, throw the duplicate",
        plan.tile,
        Vec::new(),
    )
}

/// True when discarding `plan.tile` leaves sets + pair + a ryanmen whose tile
/// is the discarded kind, and the full hand really held a second copy.
fn is_duplicate_ryanmen_discard(full: &[Tile], plan: &Plan, melds: u8) -> bool {
    if count(full, plan.tile) < 2 {
        return false;
    }
    sets_pair_ryanmen(&plan.kept, melds).is_some_and(|ryanmen| ryanmen.contains(&plan.tile))
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::classifier::shape::tests::{
        assert_lesson_answers_its_generated_state, near_miss, replace_draw, unused_honor,
    };
    use crate::generator::generate_puzzle;

    #[test]
    fn generated_ryanmen_states_classify() {
        assert_lesson_answers_its_generated_state(ScenarioId::RyanmenProtorun, 6);
    }

    #[test]
    fn a_hand_without_the_duplicate_protorun_is_not_the_lesson() {
        let state = generate_puzzle("ryanmen_protorun").expect("must generate");
        let answer = state.correct_action.tile().expect("an answer").to_string();
        // Replace the drawn duplicate with a tile that is not in the hand, so
        // the protorun loses its spare copy and the partition cannot hold.
        let unused = unused_honor(&state);
        let broken = replace_draw(&state, &unused);
        assert!(broken.correct_action.tile() == Some(answer.as_str()));
        assert!(ryanmen_protorun(&broken).is_none());
    }

    #[test]
    fn a_riichi_discard_is_not_a_shape_lesson() {
        let mut state = generate_puzzle("ryanmen_protorun").expect("must generate");
        state.players[0].is_riichi = true;
        assert!(ryanmen_protorun(&state).is_none());
    }

    #[test]
    fn a_near_miss_from_another_shape_lesson_is_not_recognised() {
        near_miss(ScenarioId::RyanmenProtorun, ScenarioId::ProtorunPriority);
    }
}
