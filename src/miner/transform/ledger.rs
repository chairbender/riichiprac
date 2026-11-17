//! The visible-tile ledger of a table.
//!
//! A permutation must **conserve tiles**: the transformed table holds exactly
//! the base table's copies, each relabelled by the chain's kind bijection, and
//! no kind gains a fifth copy. This module counts the physical copies a
//! [`GameState`] shows and rejects an impossible count.
//!
//! Counted: every player's hand, active draw, melds and river, plus the dora and
//! ura indicators. Not counted: the derived hand payload (`tiles`,
//! `ukeire_tiles`, `hand_string`) and the answer/offer fields, which *refer* to
//! tiles the table already holds rather than adding copies. `red_fives` marks a
//! copy the hand already holds, so it sets an aka flag without adding a tile.
//!
//! A called tile is written twice in this model — in the caller's meld and in
//! the source's river, the record the reachability guard requires — so the
//! river record is skipped (`claim_records`) or a claimed tile would count as
//! two.
//!
//! The model has two known gaps, both older than this engine: a called red five
//! keeps no aka identity in a meld's `tiles`, and a red five used as a dora
//! indicator has none either. The ledger counts those copies but cannot see
//! their red identity.

use crate::ai::encoder::{tile_index, tile_name};
use crate::generator::support::state_validation::claim_records;

use super::tiles::{Suit, TILE_KINDS};
use crate::state::GameState;

/// Why a table's visible tiles are not a possible set of copies.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum LedgerError {
    /// A tile string outside the app's vocabulary.
    #[error("`{tile}` in {field} is not an app tile code")]
    InvalidTile { field: &'static str, tile: String },
    /// A red-five list names a tile the player does not hold.
    #[error("seat {player} lists `{tile}` as a red five but does not hold it")]
    RedFiveNotHeld { player: usize, tile: String },
    /// A red flag on a tile that is not a five.
    #[error("`{tile}` is marked red but is not a five")]
    RedFiveNotAFive { tile: String },
    /// Two red fives of the same suit.
    #[error("the table shows more than one red five of suit `{suit}`")]
    DuplicateRedFive { suit: char },
    /// More than four copies of a kind.
    #[error("{count} copies of `{tile}` are on the table; a tile has four")]
    TooManyCopies { tile: String, count: u8 },
}

/// The visible copies of each tile kind, plus which suits' red five is in play.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TileLedger {
    kinds: [u8; TILE_KINDS],
    red: [bool; 3],
    total: usize,
}

impl TileLedger {
    /// Count a table's visible tiles, rejecting an impossible set of copies.
    pub fn of(state: &GameState) -> Result<Self, LedgerError> {
        let mut ledger = Self {
            kinds: [0; TILE_KINDS],
            red: [false; 3],
            total: 0,
        };
        let claims = claim_records(state);

        for (player, seat) in state.players.iter().enumerate() {
            for tile in &seat.hand {
                ledger.add(tile, "players[].hand")?;
            }
            if let Some(draw) = &seat.draw {
                ledger.add(draw, "players[].draw")?;
            }
            for meld in &seat.melds {
                for tile in &meld.tiles {
                    ledger.add(tile, "players[].melds[].tiles")?;
                }
            }
            for (index, discard) in seat.discards.iter().enumerate() {
                if claims.get(player).and_then(|river| river.get(index)) == Some(&true) {
                    // The record of a tile a call took; the meld already holds it.
                    continue;
                }
                ledger.add(&discard.tile, "players[].discards[].tile")?;
                if discard.is_red {
                    ledger.mark_red(&discard.tile)?;
                }
            }
            for tile in &seat.red_fives {
                let held = seat
                    .hand
                    .iter()
                    .chain(seat.draw.iter())
                    .any(|held| held == tile);
                if !held {
                    return Err(LedgerError::RedFiveNotHeld {
                        player,
                        tile: tile.clone(),
                    });
                }
                ledger.mark_red(tile)?;
            }
        }

        for tile in &state.dora_indicators {
            ledger.add(tile, "dora_indicators")?;
        }
        for tile in &state.ura_dora_indicators {
            ledger.add(tile, "ura_dora_indicators")?;
        }
        Ok(ledger)
    }

    /// How many visible copies of one app tile code the table holds.
    pub fn count(&self, code: &str) -> Result<u8, LedgerError> {
        let index = tile_index(code).ok_or_else(|| LedgerError::InvalidTile {
            field: "ledger query",
            tile: code.to_string(),
        })?;
        Ok(self.kinds[index])
    }

    /// How many visible copies of one 34-kind index the table holds.
    #[must_use]
    pub fn count_kind(&self, kind: usize) -> u8 {
        self.kinds.get(kind).copied().unwrap_or(0)
    }

    /// Whether a suit's red five is on the table.
    #[must_use]
    pub fn red(&self, suit: Suit) -> bool {
        self.red[suit.index()]
    }

    /// Every visible tile the table shows.
    #[must_use]
    pub fn total(&self) -> usize {
        self.total
    }

    fn add(&mut self, code: &str, field: &'static str) -> Result<(), LedgerError> {
        let index = tile_index(code).ok_or_else(|| LedgerError::InvalidTile {
            field,
            tile: code.to_string(),
        })?;
        let count = &mut self.kinds[index];
        *count += 1;
        if *count > 4 {
            return Err(LedgerError::TooManyCopies {
                tile: tile_name(index).unwrap_or_else(|| code.to_string()),
                count: *count,
            });
        }
        self.total += 1;
        Ok(())
    }

    fn mark_red(&mut self, code: &str) -> Result<(), LedgerError> {
        let index = tile_index(code).ok_or_else(|| LedgerError::InvalidTile {
            field: "red five",
            tile: code.to_string(),
        })?;
        if index >= 27 || index % 9 != 4 {
            return Err(LedgerError::RedFiveNotAFive {
                tile: code.to_string(),
            });
        }
        let suit = &mut self.red[index / 9];
        if *suit {
            return Err(LedgerError::DuplicateRedFive {
                suit: Suit::ALL[index / 9].letter(),
            });
        }
        *suit = true;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::miner::transform::tests::synthetic_state;

    #[test]
    fn the_synthetic_state_has_a_possible_ledger() {
        let ledger = TileLedger::of(&synthetic_state()).expect("synthetic table must be possible");
        assert!(ledger.total() > 0);
        assert!(ledger.red(Suit::Man));
        assert_eq!(ledger.count("5m").expect("a five"), 2);
    }

    #[test]
    fn a_fifth_copy_is_rejected() {
        let mut state = synthetic_state();
        state.players[1].hand = vec!["5m".to_string(); 5];
        let error = TileLedger::of(&state).expect_err("five copies is impossible");
        assert!(matches!(error, LedgerError::TooManyCopies { .. }));
    }

    #[test]
    fn two_red_fives_of_one_suit_are_rejected() {
        let mut state = synthetic_state();
        state.players[1].hand.push("5m".to_string());
        state.players[1].red_fives.push("5m".to_string());
        let error = TileLedger::of(&state).expect_err("one red five per suit");
        assert!(matches!(error, LedgerError::DuplicateRedFive { .. }));
    }

    #[test]
    fn a_red_five_nobody_holds_is_rejected() {
        let mut state = synthetic_state();
        state.players[2].red_fives.push("5p".to_string());
        let error = TileLedger::of(&state).expect_err("the copy is not in hand");
        assert!(matches!(error, LedgerError::RedFiveNotHeld { .. }));
    }
}
