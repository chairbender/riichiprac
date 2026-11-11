//! Export a [`crate::state::GameState`] as a game log an external reviewer
//! can ingest.
//!
//! The only format we emit today is `tenhou.net/6` JSON, which is the
//! "custom log" input of <https://mjai.ekyu.moe>. See [`tenhou6`] for the
//! format notes and the fidelity rules the exporter enforces.

pub mod tenhou6;

pub use tenhou6::{Tenhou6Export, Tenhou6Summary, export_tenhou6, export_tenhou6_json};
