//! The bulging float (nakabukure), Riichi Book 1 ch. 3 and ch. 4.
//!
//! The same four-tile shape is kept in one hand and broken in the next, so the
//! recogniser cannot match the shape's name. It reads the hand's cell:
//!
//! - **Ready** (ch3:702): the bulge's wait is thin, so the middle tile goes and
//!   the hand waits on the outside float. The bulge discard is the strictly best
//!   tenpai discard.
//! - **1-away, keep** (ch4:694, ch3:690): the draw merely extends a pair into a
//!   side-wait protorun; the rest of the hand is weak, so the book keeps the
//!   bulge and throws a tile from the rival pair even though breaking the bulge
//!   accepts more tiles now.
//! - **1-away, break** (ch4:725): the draw completes a group-and-head block
//!   between two pairs; that rival is now decent, so the bulge tile goes.
//!
//! The two 1-away cells are told apart by the draw's relationship to the rival
//! pairs — adjacent to one pair in the keep cell, exactly two ranks from a pair
//! on both sides in the break cell. A draw that fits neither cell leaves the
//! comparison undecided and the recogniser returns `None`.

use agari::tile::Tile;

use super::{Plan, bulges, count, matched, pair_kinds, view};
use crate::classifier::Match;
use crate::generator::ScenarioId;
use crate::state::GameState;

/// Recognise a bulging-float decision.
pub fn nakabukure_ready(state: &GameState) -> Option<Match> {
    let view = view(state)?;
    let bulges = bulges(&view.full);
    if bulges.len() != 1 {
        return None;
    }
    let (suit, base) = bulges[0];
    let middle = Tile::suited(suit, base + 1);

    match view.shanten() {
        0 => ready_drop(&view, middle),
        1 => one_away(&view, suit, base, middle),
        _ => None,
    }
}

/// The ready-hand cell: the bulge tile is the strictly best tenpai discard.
fn ready_drop(view: &super::View, middle: Tile) -> Option<Match> {
    let plans: Vec<Plan> = view
        .plans()
        .into_iter()
        .filter(|plan| plan.shanten == 0)
        .collect();
    let answer = plans.iter().find(|plan| plan.tile == middle)?;
    // The ready cell is a single-tile wait after the bulge goes; a hand with a
    // wider wait is not the book's example.
    if answer.waits.len() != 1 {
        return None;
    }
    if plans
        .iter()
        .any(|plan| plan.tile != middle && plan.total >= answer.total)
    {
        return None;
    }

    matched(
        ScenarioId::NakabukureReady,
        "ready hand: the bulging float's wait is too thin, throw its middle",
        middle,
        Vec::new(),
    )
}

/// The two 1-away cells, selected by the draw's rival block.
fn one_away(view: &super::View, suit: agari::tile::Suit, base: u8, middle: Tile) -> Option<Match> {
    let low = Tile::suited(suit, base);
    let high = Tile::suited(suit, base + 2);
    let bulge_tiles = [low, middle, high];
    if count(&view.full, view.draw) != 1 {
        return None;
    }

    let pairs = pair_kinds(&view.full);
    let adjacent_pair = pairs
        .iter()
        .copied()
        .find(|pair| is_adjacent_pair(*pair, view.draw, &bulge_tiles));
    let between_pairs = is_between_pairs(suit, view.draw, &pairs);

    match (adjacent_pair.is_some(), between_pairs) {
        // A draw that fits both readings is not decisive.
        (true, true) => None,
        (true, false) => keep_cell(view, suit, base, middle),
        (false, true) => break_cell(view, suit, base, middle),
        (false, false) => None,
    }
}

/// The keep cell: the best bulge-preserving discard, while breaking the bulge
/// still accepts more tiles.
fn keep_cell(view: &super::View, suit: agari::tile::Suit, base: u8, middle: Tile) -> Option<Match> {
    let plans = view.plans();
    let keep_plans: Vec<&Plan> = plans
        .iter()
        .filter(|plan| {
            plan.shanten == 1
                && plan.tile != middle
                && keeps_bulge(&plan.kept, suit, base)
                && count(&view.full, plan.tile) >= 2
        })
        .collect();
    if keep_plans.is_empty() {
        return None;
    }

    let max = keep_plans.iter().map(|plan| plan.total).max()?;
    let best: Vec<&&Plan> = keep_plans.iter().filter(|plan| plan.total == max).collect();
    if best.len() != 1 {
        return None;
    }
    let answer = best[0];

    let break_plan = view.plan(middle)?;
    if break_plan.shanten != 1 || break_plan.total <= answer.total {
        return None;
    }

    matched(
        ScenarioId::NakabukureReady,
        "1-away, weak rivals: keep the bulging float and break a rival pair",
        answer.tile,
        Vec::new(),
    )
}

/// The break cell: the bulge discard is the unique best 1-away discard and at
/// least one keep-the-bulge alternative exists.
fn break_cell(
    view: &super::View,
    suit: agari::tile::Suit,
    base: u8,
    middle: Tile,
) -> Option<Match> {
    let plans = view.plans();
    let answer = plans
        .iter()
        .find(|plan| plan.tile == middle && plan.shanten == 1)?;
    let keep_exists = plans.iter().any(|plan| {
        plan.shanten == 1 && plan.tile != middle && keeps_bulge(&plan.kept, suit, base)
    });
    if !keep_exists {
        return None;
    }
    if plans
        .iter()
        .any(|plan| plan.tile != middle && plan.shanten == 1 && plan.total >= answer.total)
    {
        return None;
    }

    matched(
        ScenarioId::NakabukureReady,
        "1-away, decent rival block: break the bulging float",
        middle,
        Vec::new(),
    )
}

/// True when the same bulge `x, x+1, x+1, x+2` survives the discard.
fn keeps_bulge(kept: &[Tile], suit: agari::tile::Suit, base: u8) -> bool {
    bulges(kept).contains(&(suit, base))
}

/// True when `pair` is a pair of the draw's suit exactly one rank away.
fn is_adjacent_pair(pair: Tile, draw: Tile, bulge_tiles: &[Tile; 3]) -> bool {
    let (Some(pair_suit), Some(pair_value), Some(draw_suit), Some(draw_value)) =
        (pair.suit(), pair.value(), draw.suit(), draw.value())
    else {
        return false;
    };
    pair_suit == draw_suit && pair_value.abs_diff(draw_value) == 1 && !bulge_tiles.contains(&pair)
}

/// True when the draw sits exactly two ranks from a pair on both sides.
fn is_between_pairs(bulge_suit: agari::tile::Suit, draw: Tile, pairs: &[Tile]) -> bool {
    let (Some(suit), Some(value)) = (draw.suit(), draw.value()) else {
        return false;
    };
    if suit == bulge_suit {
        return false;
    }
    let low = value.checked_sub(2);
    let high = value.checked_add(2).filter(|value| *value <= 9);
    let (Some(low), Some(high)) = (low, high) else {
        return false;
    };
    pairs.contains(&Tile::suited(suit, low)) && pairs.contains(&Tile::suited(suit, high))
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::classifier::shape::tests::{assert_lesson_answers_its_generated_state, near_miss};
    use crate::generator::generate_puzzle;

    #[test]
    fn generated_bulging_float_states_classify() {
        assert_lesson_answers_its_generated_state(ScenarioId::NakabukureReady, 18);
    }

    #[test]
    fn breaking_the_bulge_shape_is_not_the_lesson() {
        let state = generate_puzzle("nakabukure_ready").expect("must generate");
        let broken = break_the_bulge(&state);
        assert!(nakabukure_ready(&broken).is_none());
    }

    #[test]
    fn a_near_miss_from_another_shape_lesson_is_not_recognised() {
        near_miss(ScenarioId::NakabukureReady, ScenarioId::NobetanKeep);
    }

    /// Replace the tile that makes the hand a bulge with an unrelated tile.
    fn break_the_bulge(state: &GameState) -> GameState {
        let bulges = bulges(&super::view(state).expect("a view").full);
        assert_eq!(bulges.len(), 1);
        let (suit, base) = bulges[0];
        let middle = Tile::suited(suit, base + 1).to_string();
        let mut broken = state.clone();
        if let Some(code) = broken.players[0]
            .hand
            .iter_mut()
            .find(|code| **code == middle)
        {
            *code = "1z".to_string();
            return broken;
        }
        if broken.players[0].draw.as_deref() == Some(middle.as_str()) {
            broken.players[0].draw = Some("1z".to_string());
            return broken;
        }
        panic!("the bulge middle must be in the hand");
    }
}
