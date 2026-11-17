//! Native-only replay-miner foundation.
//!
//! This module is compiled only with the `miner` Cargo feature. It holds the
//! metadata contracts every later miner unit builds on: agent/rule/licence
//! provenance, the fail-closed source gate, the local data-root and SQLite
//! storage layer, atomic writes, and the funnel counter. It deliberately
//! contains no replay parser, no Mortal inference and no `libriichi`
//! dependency; see [`replay-implementation-plan.md`] unit F1 and
//! [`replay-miner-operations.md`] for the operator contract.
//!
//! # JSON schema names and versioning
//!
//! Every serialised miner document carries a `schema` string and an integer
//! `version`. The names are stable:
//!
//! | Constant | Value | Document |
//! | --- | --- | --- |
//! | [`CORPUS_GAME_SCHEMA`] | `riichiprac.corpus-game` | one generated game's provenance |
//! | [`CORPUS_MATCH_PLAN_SCHEMA`] | `riichiprac.corpus-match-plan` | a corpus match plan |
//! | [`SCENARIO_TRANSFORMS_SCHEMA`] | `riichiprac.scenario-transforms` | a transform chain |
//! | [`SCENARIO_PACK_SCHEMA`] | `riichiprac.scenario-pack` | a shipped scenario pack |
//! | [`SCENARIO_PACK_MANIFEST_SCHEMA`] | `riichiprac.scenario-pack-manifest` | the pack manifest |
//! | [`MODEL_LABEL_SCHEMA`] | `riichiprac.model-label` | one Mortal label (L1) |
//! | [`TRIGGER_SCHEMA`] | `riichiprac.candidate-trigger` | one candidate's trigger report (S1) |
//! | [`SELECTION_SCHEMA`] | `riichiprac.selection-report` | one selection run's report (S2) |
//! | [`REVIEW_SCHEMA`] | `riichiprac.review-item` | one review-queue line (S2) |
//! | [`DISPOSITION_SCHEMA`] | `riichiprac.review-disposition` | one reviewer verdict (S2) |
//!
//! The versioning rule is **additive within a version**: new optional fields
//! use `#[serde(default)]` so older files still parse, and unknown fields are
//! ignored. A breaking change (renamed/removed field, changed meaning, changed
//! units) increments `version`; a reader rejects a version it does not know.
//! The source kind is the one field that is not additive: anything other than
//! `ai_selfplay` fails to deserialize at all.
//!
//! [`replay-implementation-plan.md`]: ../../replay-implementation-plan.md
//! [`replay-miner-operations.md`]: ../../replay-miner-operations.md

#[cfg(target_arch = "wasm32")]
compile_error!("the `miner` feature is native-only; do not enable it for the wasm32 browser build");

pub mod classifier;
pub mod funnel;
pub mod label;
pub mod licence;
pub mod provenance;
pub mod select;
pub mod source;
pub mod storage;
pub mod transform;
pub mod trigger;

pub use classifier::{classify_decision, classify_decision_with_mortal};
pub use funnel::{FunnelCounter, FunnelStage};
pub use label::calibration::{
    CALIBRATION_SCHEMA, CALIBRATION_VERSION, CalibrationBreakpoint, CalibrationError,
    ExpectedPointDiffs, POINT_UNITS, QPointCalibration,
};
pub use label::thresholds::{
    Band, DEFAULT_CLOSE_CALL_PERCENTILE, DEFAULT_CONFIDENCE_PERCENTILE, DecisionFamily,
    MIN_PERCENTILE_SAMPLES, PercentileConfig, PercentileCut, PercentileCuts, PercentileThresholds,
    ThresholdError, TurnBucket, family_gap,
};
pub use label::{
    BookAgreement, BookConflict, BookLabel, CLASSIFIER_VERSION, LabelDisposition, LabelError,
    LabelKind, LabelOptions, Labeler, ModelConsensus, ModelIdentity, ModelLabel, ModelVote,
    Q_UNITS, Q_UNITS_NOTE, RankedAction, Stability, StateEvaluator, VALUE_UNITS, build_label,
    label_decision, safest_discard, state_hash,
};
pub use licence::{LicenceError, LicenseInfo, allowed_data_licence, data_commercial_use_all};
pub use provenance::{
    AgentKind, AgentSpec, CorpusId, GameProvenance, GeneratorInfo, IdError, LogRef, MatchPlan,
    MatchPlanId, ProvenanceError, ReplayId, RuleProfile, SeedSchedule, ValidationStatus,
    ValidationSummary,
};
pub use select::dedupe::{
    DedupeSet, VISIBLE_FINGERPRINT_VERSION, exact_state_hash, visible_info_fingerprint,
};
pub use select::gate::{GateFailure, GateInput, GateKind, check_answer_legal, contains_token};
pub use select::quota::{QuotaCaps, QuotaConfig};
pub use select::report::{DedupeStats, GateStats, HeldOutStats, SelectionReport};
pub use select::review::{
    DISPOSITION_SCHEMA, DispositionVerdict, REVIEW_SCHEMA, REVIEW_VERSION, ReviewDisposition,
    ReviewItem, ReviewOptions, ReviewQueue, ReviewReport, read_queue, review_queue,
    write_dispositions,
};
pub use select::run::{
    SelectionOptions, SelectionOutcome, SelectionPaths, latest_pack, run_selection, selection_paths,
};
pub use select::score::{ScoreWeights, Signals, percentile_rank};
pub use select::{
    BucketQuotaRow, Candidate, DEFAULT_HELD_OUT_SALT, DEFAULT_HELD_OUT_SHARE, DEFAULT_PACK_SIZE,
    FamilyQuotaRow, SELECTION_SCHEMA, SELECTION_VERSION, SelectionConfig, SelectionError,
    SelectionPlan, plan_selection,
};
pub use source::{SourceError, SourceGate, SourceKind};
pub use storage::{
    BackupCommand, BackupOutcome, DATA_DIR_ENV, DataRoot, MINER_DB_RELATIVE_PATH, MINER_TABLES,
    RCLONE_REMOTE_ENV, RemoteBackup, SCHEMA_VERSION, SnapshotInfo, StorageError, migrate,
    open_miner_db, plan_replay_backup, plan_snapshot_backup, row_counts, snapshot_database,
    utc_stamp, validate_relative_path, write_atomic,
};
pub use trigger::families::{Family, FamilyFilter, families_for};
pub use trigger::report::{
    FamilyStats, ReplayFamilyStats, TriggerSampleOptions, TriggerSampleReport, TriggerStats,
    run_trigger_sample,
};
pub use trigger::{
    LabelCuts, TRIGGER_SCHEMA, TRIGGER_VERSION, TriggerConfig, TriggerError, TriggerFilter,
    TriggerHit, TriggerKind, TriggerReport, blunder_hit, close_call_hit, evaluate_cheap,
    evaluate_selected, evaluate_with_label, played_gap, record_triggers,
};

/// Schema name for one generated game's provenance record.
pub const CORPUS_GAME_SCHEMA: &str = "riichiprac.corpus-game";

/// Schema name for a corpus match plan.
pub const CORPUS_MATCH_PLAN_SCHEMA: &str = "riichiprac.corpus-match-plan";

/// Schema name for a scenario transform chain.
pub const SCENARIO_TRANSFORMS_SCHEMA: &str = "riichiprac.scenario-transforms";

/// Schema name for a shipped scenario pack.
pub const SCENARIO_PACK_SCHEMA: &str = "riichiprac.scenario-pack";

/// Schema name for the scenario-pack manifest.
pub const SCENARIO_PACK_MANIFEST_SCHEMA: &str = "riichiprac.scenario-pack-manifest";

/// Schema name for one Mortal label document (L1).
pub const MODEL_LABEL_SCHEMA: &str = "riichiprac.model-label";

/// Current version of every miner JSON schema defined in F1.
///
/// The pack and transform schemas are declared here now so later units cannot
/// invent a second string; they share the same additive versioning rule.
pub const JSON_SCHEMA_VERSION: u32 = 1;

/// The canonical Tenhou four-player hanchan rule profile name.
pub const TENHOU_4P_HANCHAN: &str = "tenhou-4p-hanchan";

pub(crate) fn json_schema_version() -> u32 {
    JSON_SCHEMA_VERSION
}

pub(crate) fn corpus_game_schema() -> String {
    CORPUS_GAME_SCHEMA.to_string()
}

pub(crate) fn corpus_match_plan_schema() -> String {
    CORPUS_MATCH_PLAN_SCHEMA.to_string()
}
