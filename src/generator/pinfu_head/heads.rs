//! The structural rule behind `pinfu_head`: which single tile may become the
//! head of a pinfu hand.
//!
//! Riichi Book 1, ch. 5, "How to get pinfu", *Building the head*:
//!
//! > To claim pinfu, the head must be a pair of number tiles or valueless wind
//! > tiles.
//!
//! and, on the worked example:
//!
//! > ... they can be the head of a pinfu hand when any of them grows into a
//! > pair. On the other hand, the value tile fa cannot be the head of pinfu. We
//! > should discard fa in this case.
//!
//! That is a statement about tile *types*, not about the finished hand: any
//! number tile (terminals included) and any valueless wind may be the head,
//! while a value honor — a dragon, the round wind, or the seat wind — never may,
//! because pairing it would make a yakuhai head instead. The generator proves
//! its answer with exactly this split, and the rationale quotes it, so the
//! predicate lives in one place.

use agari::tile::{Honor, Tile};

use crate::generator::support::analysis::wind_to_honor;
use crate::state::Wind;

/// The wind an honor tile names, or `None` for a dragon.
pub(crate) fn wind_from_honor(honor: Honor) -> Option<Wind> {
    Wind::ALL
        .into_iter()
        .find(|wind| wind_to_honor(*wind) == honor)
}

/// True when pairing this tile would give a head pinfu does not allow.
///
/// A value honor is a dragon, the round wind, or the player's own seat wind.
/// Every other tile — every number tile and every valueless wind — is fine.
pub(crate) fn is_value_honor(tile: Tile, round_wind: Wind, seat_wind: Wind) -> bool {
    match tile {
        Tile::Suited { .. } => false,
        // Dragons are yakuhai whatever the round and seat are.
        Tile::Honor(Honor::White | Honor::Green | Honor::Red) => true,
        Tile::Honor(honor) => {
            wind_from_honor(honor).is_some_and(|wind| wind == round_wind || wind == seat_wind)
        }
    }
}

/// True when pairing this tile would make a pinfu head.
///
/// "the head must be a pair of number tiles or valueless wind tiles" — the
/// exact complement of [`is_value_honor`], kept as its own function so callers
/// read like the book.
pub(crate) fn can_be_pinfu_head(tile: Tile, round_wind: Wind, seat_wind: Wind) -> bool {
    match tile {
        // Any rank, terminals included: "a pair of number tiles" draws no line
        // between simples and terminals.
        Tile::Suited { .. } => true,
        // "or valueless wind tiles": a wind that values nothing here.
        Tile::Honor(honor) => !is_value_honor(Tile::Honor(honor), round_wind, seat_wind),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agari::tile::Suit;

    #[test]
    fn every_number_tile_can_be_the_head() {
        for suit in [Suit::Man, Suit::Pin, Suit::Sou] {
            for value in 1u8..=9 {
                assert!(
                    can_be_pinfu_head(Tile::suited(suit, value), Wind::East, Wind::South),
                    "{value}{suit:?} is a number tile"
                );
                assert!(!is_value_honor(
                    Tile::suited(suit, value),
                    Wind::East,
                    Wind::South
                ));
            }
        }
    }

    #[test]
    fn every_dragon_is_a_value_honor() {
        for honor in [Honor::White, Honor::Green, Honor::Red] {
            assert!(is_value_honor(Tile::Honor(honor), Wind::East, Wind::South));
            assert!(!can_be_pinfu_head(
                Tile::Honor(honor),
                Wind::East,
                Wind::South
            ));
        }
    }

    #[test]
    fn the_round_and_seat_winds_are_value_honors() {
        for round_wind in Wind::ALL {
            for seat_wind in Wind::ALL {
                for wind in Wind::ALL {
                    let tile = Tile::Honor(wind_to_honor(wind));
                    let expected = wind == round_wind || wind == seat_wind;
                    assert_eq!(
                        is_value_honor(tile, round_wind, seat_wind),
                        expected,
                        "{wind:?} with round {round_wind:?} and seat {seat_wind:?}"
                    );
                    assert_eq!(
                        can_be_pinfu_head(tile, round_wind, seat_wind),
                        !expected,
                        "{wind:?} with round {round_wind:?} and seat {seat_wind:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn wind_round_trips_through_its_honor() {
        for wind in Wind::ALL {
            assert_eq!(wind_from_honor(wind_to_honor(wind)), Some(wind));
        }
        for honor in [Honor::White, Honor::Green, Honor::Red] {
            assert_eq!(wind_from_honor(honor), None);
        }
    }
}
