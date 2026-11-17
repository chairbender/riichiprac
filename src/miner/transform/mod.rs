//! Scenario permutation engine (implementation unit V1).
//!
//! Permutation is stage 8 of the replay pipeline (`replay-implementation-plan.md`
//! §2.3): after a base scenario is selected and before a pack is assembled, one
//! validated state is expanded into several drill variants that teach the same
//! lesson. This module is the engine half of that stage — the transformations
//! themselves, their inverses and the provenance document. The label-preservation
//! gate that decides whether a variant may ship is unit V2.
//!
//! # The catalogue
//!
//! | Transform | What moves | Why it is a variant |
//! | --- | --- | --- |
//! | [`Transform::SeatPerm`] | the three opponents and their hands, melds, rivers, scores and seat references | changes who is across, left and dealer without changing the actor's decision |
//! | [`Transform::SuitPerm`] | one of six `m`/`p`/`s` bijections | breaks tile memorisation; sanshoku and honitsu survive a re-run |
//! | [`Transform::RankMirror`] | `r` ↔ `10 - r` inside a suit | breaks rank memorisation; the label must be re-derived |
//! | [`Transform::WindRelabel`] | the four winds: seat winds, wind honours and the round wind | breaks wind memorisation; placement and wind-order lessons are denied by policy |
//! | [`Transform::Red5Normalize`] | the aka identity of every red five | removes the red-five shortcut; the value must be recomputed |
//!
//! A seat wind belongs to the **seat**, so a permuted player takes the
//! destination seat's wind; the wind *labels* only move with
//! [`Transform::WindRelabel`]. Anything else would leave a table whose winds do
//! not run East, South, West, North from seat 0, which no legal position has.
//!
//! Normalising the actor to seat 0 is **not** on this list: the replay walker
//! already does it, and rotating all four seats then normalising back is a
//! no-op (§4.2). A real seat variant permutes the opponents *around* the actor.
//!
//! # Contract
//!
//! 1. **Pure relabelling.** [`TransformChain::apply`] rewrites seat references,
//!    tile codes, wind labels and the answer vocabulary. It never recomputes a
//!    derived field: `shanten`, ukeire, `can_riichi` and `book_rationale` are the
//!    gate's job through `finalize_state` (§4.4), and `book_rationale`'s book
//!    quotations must stay verbatim, so this engine leaves that field alone.
//!    The hand metrics happen to stay correct because every kind map is a
//!    bijection on the 34 kinds.
//! 2. **Reversible.** Every transform has an inverse, a chain's inverse applies
//!    the inverses in reverse order, and applying a chain and then its inverse
//!    restores the base state exactly. The one transform that is not
//!    information-preserving on its own is the red-five normalisation, so the
//!    applied chain records the copies it cleared and the inverse restores them.
//! 3. **Fail closed.** [`TransformChain::apply`] rejects a state the chain would
//!    turn into an impossible table: a chi that stops coming from the caller's
//!    kamicha (a chi may only claim the previous seat) or an answer that names
//!    the red copy being normalised (that action no longer exists). Tile strings
//!    outside the app vocabulary are rejected too.
//! 4. **Recorded.** A chain document carries its schema and version, the seed
//!    its parameters were drawn from, every transform's parameters and the
//!    red-five record. [`TransformChain::fingerprint`] is the dedupe key.
//! 5. **Tile-conserving.** [`ledger::TileLedger`] counts the visible copies, and
//!    the tests show a chain permutes the counts without gaining a fifth copy.
//!
//! Reachability, legal-answer, spoiler and label-preservation checks belong to
//! the gate, not here: this module never decides whether a variant is shippable.
//!
//! # What a transform deliberately does not touch
//!
//! River order, turn number, wall composition, dora count, scores (except as they
//! move with a permuted player), honba and riichi sticks, `book_rationale`,
//! `category`, and every count of hidden information (§4.3). The dora *value*
//! is never stored, so a suit or rank relabel moves the indicator and lets the
//! gate re-derive the value.

use thiserror::Error;

pub mod apply;
pub mod chain;
pub mod ledger;
pub mod mapping;
pub mod seat;
pub mod tiles;

#[cfg(test)]
mod tests;

pub use apply::RedFiveSlot;
pub use chain::{
    InverseChain, InverseTransform, Resolved, TRANSFORM_SCHEMA, TRANSFORM_VERSION, Transform,
    TransformChain,
};
pub use ledger::{LedgerError, TileLedger};
pub use mapping::Mapping;
pub use seat::SeatPerm;
pub use tiles::{KindMap, Suit, SuitMap};

/// Why a transform chain could not be applied, inverted or read.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum TransformError {
    /// The document names another schema.
    #[error("transform document names `{found}`, expected `{expected}`")]
    Schema {
        found: String,
        expected: &'static str,
    },
    /// The document names another version.
    #[error("transform document has version {found}, expected {expected}")]
    Version { found: u32, expected: u32 },
    /// The state is not a four-player table.
    #[error("a table must have four players, found {players}")]
    TableShape { players: usize },
    /// A seat index outside the four-player table.
    #[error("seat index {seat} is outside a four-player table")]
    InvalidSeat { seat: usize },
    /// A table whose winds do not run East, South, West, North from seat 0.
    #[error("seat {seat}'s wind is not the table's wind sequence")]
    WindOrder { seat: usize },
    /// A seat order that is not a permutation of `1, 2, 3`.
    #[error("seat order {order:?} is not a permutation of 1, 2 and 3")]
    InvalidSeatOrder { order: [u8; 3] },
    /// A suit map that is not a bijection.
    #[error("suit map {map} is not a permutation of m, p and s")]
    InvalidSuitMap { map: String },
    /// A wind relabel of four or more steps (a rotation has only three).
    #[error("wind relabel has {steps} steps; a rotation has 0..=3")]
    InvalidWindSteps { steps: u8 },
    /// A tile string outside the app's vocabulary.
    #[error("`{tile}` is not an app tile code")]
    InvalidTile { tile: String },
    /// A 34-kind index outside the tile vocabulary.
    #[error("tile index {index} is outside the 34 kinds")]
    InvalidTileIndex { index: usize },
    /// A compact hand string that does not parse.
    #[error("`{value}` is not a compact hand string")]
    InvalidHandString { value: String },
    /// A Mortal action name outside the vocabulary the engine knows.
    #[error("`{action}` is not a Mortal action name")]
    UnknownAction { action: String },
    /// A red-five discard name that a red-five normalisation cannot relabel.
    #[error(
        "`{action}` names a red five, so the answer depends on the aka identity that \
         `red5_normalize` removes"
    )]
    RedFiveAction { action: String },
    /// A chain that normalises red fives twice.
    #[error("a chain may normalise red fives only once")]
    DuplicateRedFiveNormalize,
    /// An inverse requested before the chain recorded its red-five copies.
    #[error("the chain normalises red fives but has not been applied, so its inverse is unknown")]
    UnresolvedRedFives,
    /// A red-five slot that no longer names a river entry.
    #[error("seat {player} has no river entry {index} for the red five `{tile}`")]
    InvalidRedFiveSlot {
        player: usize,
        index: usize,
        tile: String,
    },
    /// A chi meld that would claim a seat other than the caller's kamicha.
    #[error("seat {caller}'s chi would claim seat {from}, which is not its kamicha")]
    ChiNotFromPreviousSeat { caller: usize, from: usize },
    /// A chi offer that would no longer come from kamicha.
    #[error("the chi offer would come from seat {from}, not the acting seat's kamicha")]
    ChiOfferNotFromKamicha { from: usize },
}
