//! Scenario pack format, pack gate, audit, fixture publisher (implementation
//! unit P1a) and DB-backed assembly (implementation unit P1b).
//!
//! A pack is a gzipped `riichiprac.scenario-pack` v1 JSON document: a small
//! provenance envelope around a list of complete [`crate::state::GameState`]
//! drills. The manifest is a separate, small, same-origin document listing the
//! content-addressed pack bodies. [`replay-strategy.md`] §6.7 defines the shape;
//! this module extends it with the P1a fields and makes every hard gate
//! executable.
//!
//! # Documents
//!
//! | Document | Schema | Code |
//! | --- | --- | --- |
//! | pack body | `riichiprac.scenario-pack` v1 | [`Pack`] |
//! | manifest | `riichiprac.scenario-pack-manifest` v1 | [`PackManifest`] |
//! | game provenance source | `riichiprac.corpus-game` v1 | [`GameProvenance`] |
//!
//! # The gate (pack-time half of G8)
//!
//! [`audit_pack`] is the single implementation of the pack gate. A pack is
//! clean only when all of these hold, and a publisher refuses a dirty pack:
//!
//! - **Schema.** Known schema and version, non-empty pack, unique scenario ids
//!   and state hashes, a non-empty title/prompt/lesson, and a `correct_action`
//!   that equals the state's own answer.
//! - **Source/licence.** `source.kind` is `ai_selfplay` (enforced by
//!   deserialisation too), the data licence is on the allowlist, the pack is
//!   redistributable, the attribution is present, every agent licence is known
//!   and complete, and `data_commercial_use` equals the logical AND of the
//!   contributing licences. A commercial profile is refused for a non-commercial
//!   or Akochan-bearing pack.
//! - **Provenance.** Every scenario's `replay_id` has a matching
//!   [`GameProvenance`], that game is publishable, its corpus matches the pack's
//!   `corpus_id`, and the pack's `source.agents` is exactly the union of the
//!   contributing games' seats, with the same licence ids and commercial flags.
//! - **Legal answer.** The answer is on the state's own legal-action list; a
//!   Riichi answer names a legal discard; a call/pass answer has an offer; every
//!   equivalent tile is legal; `accepted` is exactly the answer plus the
//!   equivalents.
//! - **Reachable state.** The state passes
//!   [`crate::generator::support::state_validation::validate_reachable_state`].
//! - **No spoiler.** The title, prompt, pre-answer note, book label, provenance
//!   labels and selection tags do not print an answer or acceptance tile code.
//! - **Variant honesty.** A transformed/variant scenario carries a
//!   `provenance.label_check` that says the label was preserved.
//! - **Budget.** The encoded gzip body is within [`PackBudget::max_bytes`], the
//!   manifest is within [`PackBudget::max_manifest_bytes`], and the scenario
//!   count is within [`PackBudget::max_scenarios`].
//!
//! # Writing
//!
//! [`encode_pack`] is deterministic: compact struct-order JSON, a fixed gzip
//! level and no timestamp in the gzip header, so the same pack always has the
//! same SHA-256. [`publish_pack`] audits, writes the content-addressed body with
//! [`crate::miner::storage::write_atomic`], then updates the manifest atomically.
//! A failure at any point leaves no partially written file.
//!
//! # Assembly (P1b)
//!
//! [`run_assembly`] is the real exporter: it reads the selected rows from the
//! miner DB, rebuilds each `PackScenario` (a base from its walked state, a
//! variant by re-applying its recorded chain), enforces the review gate, dedupe,
//! the per-base cap, optional family quotas and the byte budget, publishes
//! through the gate above, records `packs`/`pack_scenarios`, re-runs the
//! directory audit and writes the assembly report. The module docs of
//! [`assemble`] spell out the contracts and `replay-miner-operations.md` is the
//! operator contract.
//!
//! # CLI
//!
//! ```text
//! mine_replays pack fixture  [--out DIR] [--max-bytes N] [--generated-at ISO] [--json]
//! mine_replays pack assemble [--pack ID] [--queue FILE] [--licence ID]
//!                           [--attribution TEXT] [--max-bytes N]
//!                           [--max-scenarios N] [--max-per-base N]
//!                           [--share F32] [--family-quota book=30,...]
//!                           [--generated-at ISO] [--commit TEXT]
//!                           [--dry-run] [--json]
//! mine_replays pack publish  [--from DIR] [--to DIR] [--packs ID,...]
//!                           [--max-total-bytes N] [--updated-at ISO]
//!                           [--commercial] [--dry-run] [--json]
//! mine_replays pack report   [--manifest FILE] [--json]
//! mine_replays audit         [--manifest FILE] [--games FILE] [--strict] [--commercial] [--json]
//! ```
//!
//! `audit` exits 1 when the pack is dirty and 2 on an unreadable document.
//! `pack assemble` exits 1 on a failed pack audit and 2 when the selection
//! cannot be assembled. The fixture publisher writes the fixture pack, its
//! manifest and the fixture `GameProvenance` rows the audit needs
//! (`games.jsonl`).
//!
//! [`replay-strategy.md`]: ../../../replay-strategy.md
//! [`GameProvenance`]: crate::miner::GameProvenance

use thiserror::Error;

pub mod assemble;
pub mod audit;
pub mod check;
pub mod fixture;
pub mod gate;
pub mod host;
pub mod model;
pub mod report;
pub mod write;

#[cfg(test)]
mod tests;

pub use assemble::{
    ASSEMBLY_REPORT_FILE_NAME, ASSEMBLY_SCHEMA, ASSEMBLY_VERSION, AssemblyDrop, AssemblyLimits,
    AssemblyOptions, AssemblyOutcome, AssemblyReport, DEFAULT_GENERATOR_COMMIT, FamilyMixRow,
    ReviewSummary, run_assembly,
};
pub use audit::{AuditOptions, AuditReport, audit_pack_dir};
pub use check::{PASS_ANSWER, accepted_for, find_spoiler, is_tile_code, spoiler_tokens};
pub use fixture::{FIXTURE_CORPUS_ID, FIXTURE_PACK_ID, fixture_games, fixture_pack};
pub use gate::{
    FindingSeverity, PackAudit, PackAuditContext, PackFinding, PackFindingCode, PublishProfile,
    audit_pack, audit_summary,
};
pub use host::{
    DEFAULT_MAX_HOSTED_BYTES, HostBudget, HostOptions, HostReport, HostedEntry, HostedPublish,
    publish_hosted, verify_hosted_dir,
};
pub use model::{
    LabelCheck, LabelCheckKind, MANIFEST_SCHEMA, ManifestEntry, PACK_SCHEMA, PACK_VERSION, Pack,
    PackAgent, PackBook, PackCounterfactual, PackGenerator, PackId, PackInterestingness,
    PackManifest, PackMortal, PackPlayed, PackProvenance, PackRankedAction, PackScenario,
    PackSource, PackValidation, PlayedKind, ScenarioKey,
};
pub use report::{PackReport, pack_report, render_pack_report};
pub use write::{
    GAMES_FILE_NAME, MANIFEST_FILE_NAME, PackBytes, PublishedPack, decode_pack, encode_games,
    encode_manifest, encode_pack, load_games, load_manifest, merge_games, pack_file_name,
    publish_pack, read_manifest_or_default, read_pack, upsert_manifest_entry, write_games_atomic,
    write_manifest_atomic,
};

/// Default pack body ceiling: the P2 same-origin budget (50 MB).
pub const DEFAULT_MAX_PACK_BYTES: u64 = 50_000_000;

/// Default manifest ceiling. The manifest is loaded on every page visit, so it
/// must stay small.
pub const DEFAULT_MAX_MANIFEST_BYTES: u64 = 512 * 1024;

/// Default scenario ceiling for one pack.
pub const DEFAULT_MAX_SCENARIOS: usize = 2_000;

/// Fixed gzip level, so the same pack encodes to the same hash everywhere.
pub(crate) const GZIP_LEVEL: u32 = 6;

/// Body/manifest size and scenario-count limits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PackBudget {
    /// Maximum encoded pack body bytes.
    pub max_bytes: u64,
    /// Maximum encoded manifest bytes.
    pub max_manifest_bytes: u64,
    /// Maximum scenarios in one pack.
    pub max_scenarios: usize,
}

impl Default for PackBudget {
    fn default() -> Self {
        Self {
            max_bytes: DEFAULT_MAX_PACK_BYTES,
            max_manifest_bytes: DEFAULT_MAX_MANIFEST_BYTES,
            max_scenarios: DEFAULT_MAX_SCENARIOS,
        }
    }
}

impl PackBudget {
    /// The defaults with a different body ceiling.
    #[must_use]
    pub fn with_max_bytes(max_bytes: u64) -> Self {
        Self {
            max_bytes,
            ..Self::default()
        }
    }
}

/// Any failure while building, reading, auditing or writing a pack.
#[derive(Debug, Error)]
pub enum PackError {
    /// A filesystem operation failed.
    #[error("I/O error at `{path}`: {source}")]
    Io {
        /// Path involved.
        path: String,
        /// Underlying error.
        #[source]
        source: std::io::Error,
    },
    /// A JSON document did not parse.
    #[error("invalid JSON at `{path}`: {source}")]
    Json {
        /// Path involved.
        path: String,
        /// Underlying error.
        #[source]
        source: serde_json::Error,
    },
    /// A gzip stream did not decode.
    #[error("gzip error at `{path}`: {message}")]
    Gzip {
        /// Path involved.
        path: String,
        /// Decoder message.
        message: String,
    },
    /// A storage helper rejected a path or write.
    #[error(transparent)]
    Storage(#[from] crate::miner::StorageError),
    /// The audited pack has at least one failing check.
    #[error("pack `{}` failed {} audit check(s)", .0.pack_id, .0.failures().count())]
    AuditFailed(Box<PackAudit>),
    /// A pack-level invariant failed before the full audit ran.
    #[error("pack `{pack_id}` is invalid: {detail}")]
    Invalid {
        /// Pack id, or `unknown` when it did not parse.
        pack_id: String,
        /// First failure.
        detail: String,
    },
    /// The manifest is not a valid `riichiprac.scenario-pack-manifest` v1.
    #[error("manifest `{path}` is invalid: {detail}")]
    Manifest {
        /// Manifest path.
        path: String,
        /// Why it was rejected.
        detail: String,
    },
    /// A referenced file does not exist.
    #[error("pack file `{0}` is missing")]
    MissingFile(String),
    /// The audit has no provenance rows to check against.
    #[error("no game provenance source at `{0}`")]
    MissingGames(String),
    /// The game-provenance source is not a valid JSONL corpus of game rows.
    #[error("game provenance `{path}` is invalid: {detail}")]
    Games {
        /// Path involved.
        path: String,
        /// Why the row was rejected.
        detail: String,
    },
    /// The selected rows cannot be assembled into a pack.
    #[error("pack `{pack_id}` cannot be assembled: {detail}")]
    Assembly {
        /// Pack id, or `unknown` when it did not resolve.
        pack_id: String,
        /// First failure.
        detail: String,
    },
    /// The review queue blocks the pack (a pending item or an invalid report).
    #[error("review queue `{path}` blocks the pack: {detail}")]
    Review {
        /// Queue path.
        path: String,
        /// Why it blocks.
        detail: String,
    },
    /// A same-origin hosting publish refused its source or selection.
    #[error("pack hosting refused: {detail}")]
    HostRefused {
        /// Why the publish stopped.
        detail: String,
    },
    /// A hosted pack set exceeds the same-origin byte budget.
    #[error("{what} {bytes} exceed the {max} byte hosting budget")]
    HostBudgetExceeded {
        /// Which budget was measured.
        what: &'static str,
        /// Measured bytes.
        bytes: u64,
        /// The ceiling.
        max: u64,
    },
    /// A staged hosting directory is not a valid manifest + body set.
    #[error("hosting directory `{path}` is invalid: {detail}")]
    HostInvalid {
        /// Directory or file involved.
        path: String,
        /// Why it was rejected.
        detail: String,
    },
    /// SQLite failed while reading the selection or recording the export.
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
}
