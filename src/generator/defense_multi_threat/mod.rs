//! Defense against two or more opponents at once (Riichi Book 1, ch. 8).
//!
//! The rest of the ch. 8 defense family reads **one** threat: `fold_to_riichi`,
//! the safety-chart lessons and the blockade lessons all take
//! `support::sole_riichi_threat` and refuse a table with a second live opponent.
//! The chapter is explicit that this is not enough:
//!
//! > {\jap Genbutsu} tiles of player X are 100\% safe against X, but not
//! > necessarily safe against the other two players. ... There are three kinds
//! > of tiles that are 100\% safe against all of the opponents. — ch8:100–104
//!
//! The three kinds are "the tile that was just discarded by your left player"
//! (temporary furiten covers the other two, ch8:102), "a fourth honor tile"
//! (ch8:103), and "an absolute ``no chance'' tile" (ch8:104). This lesson asks
//! for a discard while **every** live opponent is considered, so the answer is
//! one of those three and every other tile in the hand is dangerous to at least
//! one of them.
//!
//! # The shapes
//!
//! Three table shapes are generated, each a different combination of the ways
//! ch. 8 says an opponent becomes dangerous:
//!
//! - `TwoRiichi`: two opponents have declared Riichi (ch. 8.3).
//! - `RiichiAndOpenHand`: one Riichi and one three-meld open hand. Ch. 8.4:
//!   "Assume an opponent has a ready hand ... They have three or more open sets
//!   / runs." The open hand is generated as real tenpai so the read is exact.
//! - `ThreeThreats`: both of the above at once — two Riichi declarations and a
//!   three-meld open hand — on a South-round table where the human is well
//!   ahead. Ch. 8's "Your position in the game" says to be more defensive when
//!   ahead, "especially ... in the South round", so the score line reinforces
//!   the fold.
//!
//! # What the board teaches
//!
//! Each board keeps a **trap**: a hand tile that is 100% safe against one
//! threat (its genbutsu, or a wait of the open hand read from the outside) but
//! dangerous to another. The drill is to notice that safety against one
//! opponent is not safety against the table, and to find the one tile the
//! chapter calls safe against all of them. The hand is at least
//! [`board::MIN_SHANTEN`]-away, so the question is purely which tile to fold
//! with.
//!
//! The generator reads the finished table back through
//! [`crate::safety::MultiThreatFacts`] and rejects any board where more than
//! one tile is certain safe, where the trap is not a live danger, or where the
//! open hand is not really tenpai on the trap.

mod board;

use crate::generator::support::retry::generate_with_retries;
use crate::state::GameState;

/// Generates one multi-threat fold puzzle.
pub fn generate(category: &str) -> Result<GameState, String> {
    generate_with_retries("defense_multi_threat", 6_000, || board::build(category))
}
