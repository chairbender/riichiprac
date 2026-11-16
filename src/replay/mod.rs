//! Replay library (R1): mjai reader and structural validator.
//!
//! This module is native-only (the `miner` Cargo feature) and has one input
//! format: gzipped mjai JSONL produced by our own AI self-play corpus. It
//! contains no Tenhou, Mahjong Soul, Riichi City or Hime parser, and it does not
//! infer a game's best move; it only decides whether a game is **structurally**
//! legal and gives R2 a typed event stream to walk.
//!
//! # Flow
//!
//! ```text
//! .jsonl.gz ── ReplayReader ──> ReplayFile { events } ── validate_game ──> GameSummary
//!                                 │
//!                                 └─ R2 walker (next unit)
//! ```
//!
//! - [`tile`] maps mjai tile codes (including `5mr`/`5pr`/`5sr`) to the app's
//!   tile kinds; the red-five flag is never lost.
//! - [`mjai`] is the gzip reader and the event enum. It rejects unknown events,
//!   in-game-mode events, `?` hidden tiles and out-of-range seats with a typed
//!   [`mjai::ParseError`] carrying the source line.
//! - [`validate`] checks the whole game: event order, actor/seat consistency,
//!   call legality, the 136-tile ledger, the 70-draw wall (a kan's replacement
//!   draw counts as one of them), dora timing, and the score/kyotaku chain.
//! - [`walk`] reconstructs the app's [`crate::state::GameState`] at every
//!   decision point of a validated replay, normalised so the actor is seat 0.
//!
//! # Scope boundary
//!
//! A replay is a complete game. The validator starts it at E1 with 25 000 each
//! and follows the table through every kyoku; a clip with mid-game scores is
//! not a replay. Yaku, waits, furiten, scoring values and `GameState`
//! reconstruction are R2's job, not this module's.
//!
//! The contract and acceptance evidence are summarised in
//! [`replay-miner-operations.md`](../../replay-miner-operations.md).

pub mod mjai;
pub mod tile;
pub mod validate;
pub mod walk;

#[cfg(test)]
mod fixtures;

pub use mjai::{
    EventKind, MAX_DECOMPRESSED_BYTES, MAX_EVENTS, MAX_LINE_BYTES, MjaiEvent, ParseError,
    ParseErrorKind, ReplayFile, ReplayReader, SUPPORTED_EVENTS,
};
pub use tile::{TILE_KINDS, Tile, TileParseError};
pub use validate::{
    CallError, CallErrorKind, EventOrderError, EventOrderKind, GameSummary, KyokuResultSummary,
    KyokuSummary, LedgerError, LedgerErrorKind, ReplayError, ScoreError, ScoreErrorKind, WallError,
    WallErrorKind, read_and_validate_path, validate_game,
};
pub use walk::{
    DecisionKind, DecisionSnapshot, ReplayWalk, SkippedDecision, WALL_DRAWS, WalkError,
    decision_id, walk_path, walk_replay,
};
