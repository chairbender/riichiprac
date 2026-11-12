//! `sanshoku_pursuit`: Riichi Book 1, ch. 5.1, the floating sanshoku method.
//!
//! The book's rule:
//!
//! > 3 in this hand is essentially a redundant floating tile from a pure tile
//! > efficiency perspective; we do not need it to accept 4. However, if we keep
//! > it and discard North instead, we can hope to get sanshoku of 345. — ch5:62
//!
//! > If a hand has at least one dora or tanyao (All Simples), we should discard
//! > 3 to choose a side wait pinfu hand. Only when there is no other yaku or
//! > dora in a pinfu hand, it is OK to choose closed-wait sanshoku over
//! > side-wait pinfu. — ch5:74
//!
//! and the switching rule that limits the chase:
//!
//! > You should not pursue sanshoku if switching requires reverting a 1-away
//! > hand to 2-away. — ch5:110
//!
//! The drill is the book's gated floating decision. The hand is tenpai with an
//! extra tile: discarding the float (`x` in the floating suit) keeps a side
//! wait and is pinfu; discarding the high tile (`x+3`) keeps a closed wait and
//! is sanshoku. The answer depends on the book's gate, not on a hand-written
//! example:
//!
//! - no dora, no tanyao, no other yaku -> keep the float and chase sanshoku;
//! - at least one dora, or tanyao, or another yaku -> take the side-wait pinfu.
//!
//! The yaku comparison is read off [`crate::generator::support::yaku`], which
//! enumerates every tenpai discard, every winning tile, and every yaku reading.
//!
//! Anki 1463199499575 (building a block when a hand is short of five),
//! 1463199600827 (the seven methods), 1463199674777 (the floating method and
//! when to use it), 1463199757639 (switching), 1463199890461 (the double-closed
//! companion), 1463200050641 (stretched single), 1463200126332 (lining pairs),
//! 1463200307818 (golden), and 1463200355010 (crashing a meld). This drill
//! teaches the floating method; the same no-other-yaku-or-dora gate governs the
//! companion methods, and ch5:129 is cited for the double-closed version.

mod board;
mod facts;
mod skeleton;

use crate::generator::support::retry::generate_with_retries;
use crate::state::GameState;

pub(crate) use facts::{SanshokuFacts, from_state as facts};

/// Generates one floating sanshoku decision.
pub fn generate(category: &str) -> Result<GameState, String> {
    generate_with_retries("sanshoku_pursuit", 20_000, || {
        let skeleton = skeleton::build_skeleton()?;
        board::build_board(category, &skeleton)
    })
}
