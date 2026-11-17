//! The ch. 9 seating tip for valueless winds (`wind_discard_order`).
//!
//! Riichi Book 1, ch. 9, "Be mindful of the seating", seating-related tip 2:
//!
//! > When discarding valueless wind tiles, discard the right player's wind
//! > first, then the facing player's wind next. — ch9
//!
//! The reason is seat arithmetic: a Pon or Kan by the right player (shimocha)
//! skips the facing player's turn and hands the right player an extra draw, so
//! the right player is the one whose call is most worth denying. Throwing their
//! wind early does that.
//!
//! The recogniser is pure seat order. It requires the opening turn, a closed
//! slow hand, and two or three distinct valueless winds (one copy each, no
//! dragons, no round/seat wind, and no held wind is the dora). The answer is
//! the highest-priority wind the hand holds: the right player's, else the
//! facing player's, else the left player's.
//!
//! Seat and wind transforms are denied ([`TransformPolicy`]): rotating either
//! changes the seating arithmetic the lesson teaches, which is exactly the case
//! the implementation plan's invariance matrix calls out.

use agari::context::indicator_to_dora;
use agari::tile::{Honor, Tile};

use crate::generator::ScenarioId;
use crate::generator::support::analysis::wind_to_honor;
use crate::state::{CorrectAction, GameState, TargetAction, Wind};

use super::support;
use super::{Allowed, Match, TransformPolicy};

/// The lesson is seat and wind arithmetic, so those two transforms are denied.
/// Suit and rank relabelling leave the seating untouched; a red five is only a
/// value detail and is recomputed.
pub(crate) const POLICY: TransformPolicy = TransformPolicy {
    seat_perm: Allowed::Deny,
    suit_perm: Allowed::AllowWithRecompute,
    rank_mirror: Allowed::AllowWithRecompute,
    wind_relabel: Allowed::Deny,
    red5_normalize: Allowed::AllowWithRecompute,
    note: "the answer is shimocha's wind, then toimen's, then kamicha's; rotating seats or winds \
           changes that arithmetic, so both are denied. Suit/rank relabelling does not touch it, \
           and a red five only changes a filler tile's value.",
};

/// Recognise the ch. 9 valueless-wind discard order.
pub fn wind_discard_order(state: &GameState) -> Option<Match> {
    let turn = support::turn(state)?;
    if !support::is_opening_turn(state, &turn) {
        return None;
    }
    // The generated hand is slow by construction; a ready hand has bigger
    // questions than which wind to pitch.
    if turn.shanten < 1 {
        return None;
    }

    let round_honor = wind_to_honor(turn.round_wind);
    let seat_honor = wind_to_honor(turn.human_wind);
    let dora: Vec<Tile> = state
        .dora_indicators
        .iter()
        .filter_map(|code| Tile::try_from(code.as_str()).ok())
        .map(indicator_to_dora)
        .collect();

    let mut held_winds: Vec<Wind> = Vec::new();
    for tile in &turn.hand {
        match tile {
            Tile::Suited { .. } => {}
            Tile::Honor(Honor::White | Honor::Green | Honor::Red) => {
                // A dragon is never a valueless wind; the lesson's hand holds
                // none at all.
                return None;
            }
            Tile::Honor(honor) => {
                if *honor == round_honor || *honor == seat_honor {
                    // A value wind in hand is a different (pairing) question.
                    return None;
                }
                let wind = Wind::ALL
                    .into_iter()
                    .find(|wind| wind_to_honor(*wind) == *honor)?;
                if dora.contains(tile) {
                    // The generator keeps every held wind valueless; a wind
                    // dora changes the discard order's cost.
                    return None;
                }
                held_winds.push(wind);
            }
        }
    }

    let mut distinct = held_winds.clone();
    distinct.sort_by_key(|wind| wind.index());
    distinct.dedup();
    // Two different winds are the minimum order question; a pair of one wind is
    // a head, not a discard-order decision.
    if distinct.len() < 2 || distinct.len() != held_winds.len() {
        return None;
    }

    // The book's order: right player (seat 1), then facing (seat 2), then left
    // (seat 3). The answer is the first of those the hand holds.
    let answer = (1..=3usize).find_map(|seat| {
        let wind = state
            .players
            .iter()
            .find(|player| player.seat == seat)?
            .wind;
        distinct.contains(&wind).then_some(wind)
    })?;

    Some(Match {
        lesson: ScenarioId::WindDiscardOrder,
        situation: Some(format!(
            "{} valueless winds in hand; seat order decides the first pitch",
            distinct.len()
        )),
        target_action: TargetAction::NaniKiru,
        correct_action: CorrectAction::dama(wind_code(answer)),
        equivalent_tiles: Vec::new(),
        riichi_triggers: Vec::new(),
        dama_reasons: Vec::new(),
        shouminkan_triggers: Vec::new(),
        scenario_note: None,
    })
}

/// The state code for one wind.
fn wind_code(wind: Wind) -> String {
    match wind {
        Wind::East => "1z",
        Wind::South => "2z",
        Wind::West => "3z",
        Wind::North => "4z",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::generator::generate_puzzle;

    #[test]
    fn the_wind_order_recognises_its_own_lesson() {
        for run in 0..12 {
            let state = generate_puzzle("wind_discard_order")
                .unwrap_or_else(|err| panic!("run {run}: {err}"));
            let matched =
                wind_discard_order(&state).unwrap_or_else(|| panic!("run {run}: no match"));
            matched
                .validate(&state)
                .unwrap_or_else(|err| panic!("run {run}: illegal answer: {err}"));
            assert_eq!(matched.lesson, ScenarioId::WindDiscardOrder);
            assert_eq!(matched.target_action, TargetAction::NaniKiru);
            assert_eq!(
                matched.correct_action.tile(),
                state.correct_action.tile(),
                "run {run}: the shimocha's wind is the answer"
            );
        }
    }

    #[test]
    fn a_mid_hand_state_is_not_the_opening_tip() {
        let mut state = generate_puzzle("wind_discard_order").expect("must generate");
        state.players[0]
            .discards
            .push(crate::state::DiscardTile::new("1m"));
        assert!(wind_discard_order(&state).is_none());
    }

    #[test]
    fn a_hand_with_one_wind_has_no_order_question() {
        let mut state = generate_puzzle("wind_discard_order").expect("must generate");
        // Drop a second wind by replacing it with a suited filler tile that the
        // hand does not already hold four times.
        let turn = support::turn(&state).expect("a turn");
        let winds: Vec<Tile> = turn
            .hand
            .iter()
            .copied()
            .filter(|tile| matches!(tile, Tile::Honor(_)))
            .collect();
        if winds.len() != 2 {
            return;
        }
        let Some(spare) = state.players[0]
            .hand
            .iter()
            .position(|code| code == &winds[0].to_string())
        else {
            return;
        };
        // A suited tile the hand does not hold four times.
        let Some(replacement) = ["5s", "5m", "5p", "1s", "1m", "1p"]
            .into_iter()
            .find(|code| {
                state.players[0]
                    .hand
                    .iter()
                    .filter(|held| held.as_str() == *code)
                    .count()
                    < 4
            })
        else {
            return;
        };
        state.players[0].hand[spare] = replacement.to_string();
        assert!(wind_discard_order(&state).is_none());
    }

    #[test]
    fn a_dragon_is_not_a_valueless_wind() {
        let mut state = generate_puzzle("wind_discard_order").expect("must generate");
        let answer = state.correct_action.tile().expect("answer").to_string();
        if let Some(index) = state.players[0]
            .hand
            .iter()
            .position(|code| *code != answer)
        {
            state.players[0].hand[index] = "5z".to_string();
            assert!(wind_discard_order(&state).is_none());
        }
    }
}
