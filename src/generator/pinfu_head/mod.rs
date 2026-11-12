//! `pinfu_head`: with no committed head yet, which tile do you not throw away?
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
//! The drill hands the player a hand with the book's *texture* (`1m 4m 6m |
//! 23p 67p 9p | 5667s | E fa`, ch5:452), not a clean "no pair anywhere"
//! template: two side waits, a middle closed wait that looks like a float, a
//! bulging float whose doubled middle is the hand's only duplicate, an isolated
//! terminal, a terminal sitting two ranks from a protorun, a valueless wind,
//! and one lone value honor — a dragon, the round wind, or the seat wind.
//!
//! The answer is always the value honor, and it is proved structurally: it is
//! the only tile in the fourteen that can never be the head of a pinfu hand.
//! Score never enters it (the dora is never the answer). What makes the drill
//! more than a lookup is the hand: the duplicates, the closed wait and the
//! adjacent terminal are exactly the tiles that tempt a discard in the book's
//! example, so the player has to read the whole hand before finding the one
//! tile the rule bars.
//!
//! The first-turn table has no calls, riichi, or furiten.

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
    use agari::tile::{Suit, Tile};

    use super::heads::is_value_honor;
    use super::*;
    use crate::generator::support::state_validation::validate_reachable_state;
    use crate::state::{CorrectActionType, TargetAction};

    fn tiles_of(state: &GameState) -> Vec<Tile> {
        state
            .tiles
            .iter()
            .map(|code| Tile::try_from(code.as_str()).expect("a parsed tile"))
            .collect()
    }

    fn count(tiles: &[Tile], tile: Tile) -> usize {
        tiles.iter().filter(|other| **other == tile).count()
    }

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
                        "run {run}: {code} cannot be the pinfu head but is not the answer"
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
    fn hand_keeps_a_bulge_and_its_lone_terminals_and_wind() {
        for run in 0..100 {
            let state =
                generate("pinfu_head").unwrap_or_else(|err| panic!("run {run} failed: {err}"));
            let round = state.round_wind;
            let seat = state.players[0].wind;
            let tiles = tiles_of(&state);

            // No committed head: exactly one duplicated type, and it is the
            // middle of a bulge `x, x+1, x+1, x+2`.
            let repeated: Vec<Tile> = tiles
                .iter()
                .copied()
                .filter(|tile| count(&tiles, *tile) > 1)
                .collect();
            assert_eq!(
                repeated.len(),
                2,
                "run {run}: only the bulge's middle may repeat, got {repeated:?}"
            );
            assert_eq!(repeated[0], repeated[1], "run {run}: one repeated type");
            let Tile::Suited { suit, value } = repeated[0] else {
                panic!("run {run}: the repeat must be a suited bulge middle");
            };
            let bulge = [
                Tile::suited(suit, value - 1),
                Tile::suited(suit, value),
                Tile::suited(suit, value),
                Tile::suited(suit, value + 1),
            ];
            assert_eq!(count(&tiles, bulge[0]), 1, "run {run}: the bulge's low end");
            assert_eq!(count(&tiles, bulge[1]), 2, "run {run}: the bulge's middle");
            assert_eq!(
                count(&tiles, bulge[3]),
                1,
                "run {run}: the bulge's high end"
            );

            // Both terminals are spare floats, never part of a block.
            let terminals = tiles
                .iter()
                .filter(|tile| matches!(tile, Tile::Suited { value: 1 | 9, .. }))
                .count();
            assert_eq!(terminals, 2, "run {run}: exactly two terminal floats");

            // One value honor and one valueless wind beside it, so "throw the
            // honor" is wrong for one of the two.
            let honors: Vec<Tile> = tiles
                .iter()
                .copied()
                .filter(|tile| matches!(tile, Tile::Honor(_)))
                .collect();
            assert_eq!(honors.len(), 2, "run {run}: two honors");
            assert_eq!(
                honors
                    .iter()
                    .filter(|tile| is_value_honor(**tile, round, seat))
                    .count(),
                1,
                "run {run}: one of the honors is the value honor"
            );
            assert!(
                honors
                    .iter()
                    .any(|tile| !is_value_honor(*tile, round, seat)),
                "run {run}: the other honor must be a valueless wind"
            );

            // The hand is still a normal hand, not a one-suit special.
            let suits: Vec<Suit> = tiles
                .iter()
                .filter_map(|tile| match tile {
                    Tile::Suited { suit, .. } => Some(*suit),
                    Tile::Honor(_) => None,
                })
                .collect();
            assert!(
                suits.iter().any(|suit| *suit != suits[0]),
                "run {run}: the hand must use at least two suits"
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
}
