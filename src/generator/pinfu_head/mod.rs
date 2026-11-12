//! `pinfu_head`: with no pair yet, which tile do you not throw away?
//!
//! Riichi Book 1, ch. 5, "How to get pinfu", *Building the head*:
//!
//! > To claim pinfu, the head must be a pair of number tiles or valueless wind
//! > tiles. Therefore, try not to discard terminals or valueless wind tiles
//! > lightly when having a pinfu hand. Keep this in mind especially when a hand
//! > is lacking any pair.
//!
//! and the answer to the book's worked example:
//!
//! > The hand has a potential to have pinfu, so we should not discard any of
//! > 1m 9p E at this point. All of these three tiles may appear useless, but
//! > they can be the head of a pinfu hand when any of them grows into a pair.
//! > On the other hand, the value tile fa cannot be the head of pinfu. We
//! > should discard fa in this case.
//!
//! The drill hands the player a closed, pinfu-shaped hand with no pair, three
//! lone tiles that could still pair into the head (terminals and valueless
//! winds), and one lone value honor — a dragon, the round wind, or the seat
//! wind. The answer is always the value honor, and it is proved structurally:
//! it is the only tile in the fourteen that can never be the head of a pinfu
//! hand. Score never enters it (the dora is never the answer), and neither does
//! acceptance: the other lone tiles are isolated on purpose, so pairing one is
//! their only use.
//!
//! The hand's shape is held fixed so the question is only about the head: four
//! run-shaped blocks (two runs, two side-wait protoruns), no triplet, no meld,
//! and no pair anywhere. The first-turn table has no calls, riichi, or furiten.

mod board;
mod heads;

use crate::generator::support::retry::generate_with_retries;
use crate::state::GameState;

pub(crate) use heads::{can_be_pinfu_head, wind_from_honor};

/// Generates a first-turn pinfu hand whose answer is its lone value honor.
pub fn generate(category: &str) -> Result<GameState, String> {
    generate_with_retries("pinfu_head", 500, || board::build(category))
}

#[cfg(test)]
mod tests {
    use agari::tile::Tile;

    use super::heads::is_value_honor;
    use super::*;
    use crate::generator::support::state_validation::validate_reachable_state;
    use crate::state::{CorrectActionType, TargetAction};

    #[test]
    fn answer_is_the_only_tile_that_cannot_be_the_pinfu_head() {
        for run in 0..100 {
            let state =
                generate("pinfu_head").unwrap_or_else(|err| panic!("run {run} failed: {err}"));

            assert_eq!(state.category, "pinfu_head");
            assert_eq!(state.target_action, TargetAction::NaniKiru);
            assert_eq!(state.correct_action.action_type(), CorrectActionType::Dama);
            assert!(state.equivalent_tiles.is_empty());

            let round = state.round_wind;
            let seat = state.players[0].wind;
            let answer = state
                .correct_action
                .tile()
                .expect("the answer names a tile");

            let mut value_honors = Vec::new();
            for code in &state.tiles {
                let tile = Tile::try_from(code.as_str()).expect("a parsed tile");
                if is_value_honor(tile, round, seat) {
                    value_honors.push(code.clone());
                } else {
                    assert!(
                        can_be_pinfu_head(tile, round, seat),
                        "run {run}: {code} can be the pinfu head but is not the answer"
                    );
                }
            }

            assert_eq!(
                value_honors,
                vec![answer.to_string()],
                "run {run}: the answer must be the hand's one value honor"
            );
        }
    }

    #[test]
    fn hand_has_no_pair_and_keeps_three_lone_head_candidates() {
        for run in 0..100 {
            let state =
                generate("pinfu_head").unwrap_or_else(|err| panic!("run {run} failed: {err}"));
            let round = state.round_wind;
            let seat = state.players[0].wind;

            let mut counts = std::collections::BTreeMap::new();
            for code in &state.tiles {
                *counts.entry(code.clone()).or_insert(0usize) += 1;
            }
            assert!(
                counts.values().all(|count| *count == 1),
                "run {run}: the hand must hold no pair yet"
            );

            // A lone candidate is a head-capable tile with nothing of its suit
            // within two ranks: pairing it is its only use.
            let tiles: Vec<Tile> = state
                .tiles
                .iter()
                .map(|code| Tile::try_from(code.as_str()).unwrap())
                .collect();
            let answer = Tile::try_from(state.correct_action.tile().unwrap()).unwrap();
            let lone: Vec<Tile> = tiles
                .iter()
                .copied()
                .filter(|tile| *tile != answer)
                .filter(|tile| can_be_pinfu_head(*tile, round, seat))
                .filter(|tile| {
                    !tiles
                        .iter()
                        .any(|other| other != tile && sits_within_two(*tile, *other))
                })
                .collect();

            assert_eq!(
                lone.len(),
                3,
                "run {run}: the hand must keep exactly three lone head candidates, got {lone:?}"
            );
        }
    }

    #[test]
    fn table_is_a_closed_first_turn() {
        for run in 0..100 {
            let state =
                generate("pinfu_head").unwrap_or_else(|err| panic!("run {run} failed: {err}"));

            assert_eq!(state.current_turn, 0, "run {run}");
            assert_eq!(state.players[0].hand.len(), 13, "run {run}");
            assert!(state.players[0].draw.is_some(), "run {run}");
            assert!(state.players[0].discards.is_empty(), "run {run}");
            for player in &state.players {
                assert!(player.melds.is_empty(), "run {run}: seat {}", player.seat);
                assert!(!player.is_riichi, "run {run}: seat {}", player.seat);
                assert!(
                    player.discards.len() <= 1,
                    "run {run}: seat {} has {} discards on the first go-around",
                    player.seat,
                    player.discards.len()
                );
            }

            assert!(state.shanten >= 2, "run {run}: shanten {}", state.shanten);
            assert!(!state.is_agari, "run {run}");
            assert!(!state.can_riichi, "run {run}");

            validate_reachable_state(&state)
                .unwrap_or_else(|err| panic!("run {run}: unreachable table: {err}"));
        }
    }

    #[test]
    fn the_answer_is_never_the_dora() {
        for run in 0..100 {
            let state =
                generate("pinfu_head").unwrap_or_else(|err| panic!("run {run} failed: {err}"));
            let answer = Tile::try_from(state.correct_action.tile().unwrap()).unwrap();
            for indicator in &state.dora_indicators {
                let indicator = Tile::try_from(indicator.as_str()).unwrap();
                assert_ne!(
                    agari::context::indicator_to_dora(indicator),
                    answer,
                    "run {run}: the answer must not be worth points"
                );
            }
        }
    }

    /// True when two suited tiles of one suit sit within two ranks.
    fn sits_within_two(left: Tile, right: Tile) -> bool {
        match (left, right) {
            (
                Tile::Suited {
                    suit: left_suit,
                    value: left_value,
                },
                Tile::Suited {
                    suit: right_suit,
                    value: right_value,
                },
            ) => left_suit == right_suit && (left_value as i16 - right_value as i16).abs() <= 2,
            _ => false,
        }
    }
}
