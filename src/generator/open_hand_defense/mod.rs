//! Reading safety from the discard an open hand made after a chii (ch. 8.4).
//!
//! Riichi Book 1, ch. 8, "Discard upon chii":
//!
//! > `chii -> discard a tile in the same suit`
//! > `=> the neighborhood of the last discard is safe` — ch8:567–568
//! > `chii -> discard a tile in a different suit`
//! > `=> the neighborhood of the last discard is dangerous` — ch8:569–570
//!
//! The generation is fully constructive:
//!
//! 1. `skeleton` plants a three-meld open hand whose last call is a chii and
//!    whose last discard is the tile thrown immediately after it. The four
//!    concealed tiles are a pair plus one protorun, so the threat is really
//!    tenpai (and the chapter's "three open sets => assume ready" shortcut is
//!    literal).
//! 2. In the same-suit case the kept protorun is in another suit: the threat's
//!    winning tiles are outside the post-chii discard's neighbourhood. The
//!    answer is the human's only neighbourhood tile, and it is part of a
//!    protorun so the fold is visible.
//! 3. The different-suit variant is the trap: the kept protorun is in the
//!    discard's suit, one of its winning tiles is the tempting neighbourhood
//!    tile, and the answer is the human's 100 % genbutsu just outside the
//!    neighbourhood.
//! 4. `board` assembles the table, reserves every structural tile before the
//!    random fill, and re-derives the whole read from the finished state.
//!
//! Deck cards: 1463255367640 (when to assume ready), 1463255468847 (estimate
//! value), 1463255593155 (dangerous tiles from melds), 1463255694221 (the
//! chi-discard rule). No scoring oracle is used: the answer is a structural
//! board read.

mod board;
mod skeleton;

use crate::generator::support::retry::generate_with_retries;
use crate::state::GameState;

/// Generates the ch. 8.4 open-hand chii-discard puzzle.
pub fn generate(category: &str) -> Result<GameState, String> {
    generate_with_retries("open_hand_defense", 10_000, || {
        let skeleton = skeleton::build()?;
        board::build_board(category, &skeleton)
    })
}
