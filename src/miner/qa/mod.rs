//! Q1: the end-to-end acceptance harness.
//!
//! [`run_fixture_pipeline`] drives the whole miner without a GPU, a checkpoint,
//! a network or a real corpus:
//!
//! ```text
//! testdata/replays/*.jsonl
//!   └─ ingest fixture corpus ─► gzipped, content-addressed replays + provenance
//!        └─ label (FixtureEvaluator) ─► model_labels cache
//!             └─ select ─► review queue + held-out QA
//!                  └─ review (auto-accept) ─► dispositions
//!                       └─ transform rehearsal (seeded book bases) ─► variants + pack
//!                            └─ audit ─► publish_hosted ─► verify_hosted_dir
//!                                 └─ storage snapshot + PRAGMA integrity_check
//! ```
//!
//! The replay branch and the variant/pack branch use the same data root and the
//! same database. They are deliberately separate sources: the committed replay
//! fixtures contain no table that a book classifier recognises, while the V2
//! rehearsal generates book bases. The harness reports both honestly instead of
//! pretending one branch produced the other.
//!
//! # Determinism
//!
//! Every timestamp is the caller's pinned `generated_at`; the fixture corpus is
//! gzipped with a fixed gzip header; the fixture evaluator is a pure function of
//! the state; the rehearsal is seeded. Two runs over the same inputs therefore
//! produce the same pack body and SHA-256. The Q1 CI script runs the pipeline
//! twice and compares the reported hashes.
//!
//! # What is not claimed
//!
//! - No real corpus is generated. Corpora stay offline (C1–C8).
//! - The fixture evaluator is **not** Mortal: its identity is
//!   [`FIXTURE_EVALUATOR_NAME`](crate::miner::label::fixture::FIXTURE_EVALUATOR_NAME),
//!   and every label records that identity.
//! - Review is an automated accept of the fixture queue. It proves the
//!   disposition path and the pack review gate, not human judgement (Q2r).

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use flate2::Compression;
use flate2::GzBuilder;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::miner::JSON_SCHEMA_VERSION;
use crate::miner::label::CLASSIFIER_VERSION;
use crate::miner::label::LabelError;
use crate::miner::label::fixture::{FIXTURE_EVALUATOR_NAME, FixtureEvaluator};
use crate::miner::label::run::{LabelRunOptions, run_shard};
use crate::miner::pack::audit::{AuditOptions, audit_pack_dir};
use crate::miner::pack::host::{HostBudget, HostOptions, publish_hosted, verify_hosted_dir};
use crate::miner::pack::{PackError, fixture_games};
use crate::miner::provenance::{CorpusId, IdError, ProvenanceError, ReplayId, sha256_hex};
use crate::miner::select::run::{SelectionOptions, run_selection};
use crate::miner::select::{
    QuotaConfig, ReviewOptions, ReviewReport, SelectionConfig, SelectionError, review_queue,
};
use crate::miner::storage::{
    BackupOutcome, DataRoot, SnapshotInfo, StorageError, open_miner_db, plan_replay_backup,
    plan_snapshot_backup, row_counts, snapshot_database,
};
use crate::miner::trigger::families::Family;
use crate::miner::variant::run::{VariantRunOptions, run_variants};
use crate::miner::variant::{VariantConfig, VariantError};

/// Schema name of the Q1 pipeline report.
pub const QA_SCHEMA: &str = "riichiprac.qa-pipeline";

/// Version of the Q1 pipeline report.
pub const QA_VERSION: u32 = JSON_SCHEMA_VERSION;

/// Corpus family the fixture replays are stored under.
pub const QA_FAMILY: &str = "mortal_mirror";

/// Default pack id for the fixture corpus branch.
pub const QA_SELECTION_PACK_ID: &str = "q1-fixture";

/// Default pack id for the seeded rehearsal branch.
pub const QA_PACK_ID: &str = "q1-rehearsal";

/// Default number of generated book bases in the variant branch.
pub const QA_REHEARSAL_BASES: usize = 12;

/// Default review-queue size requested from the replay branch.
pub const QA_PACK_SIZE: usize = 8;

/// One Q1 run's inputs.
#[derive(Debug, Clone)]
pub struct QaOptions {
    /// Directory holding the fixture corpus (`.jsonl` or `.jsonl.gz`).
    pub corpus: PathBuf,
    /// Pinned ISO-8601 timestamp used for every pack, manifest and report.
    pub generated_at: String,
    /// Pack id for the replay selection/review branch.
    pub selection_pack_id: String,
    /// Pack id for the rehearsal transform/pack branch.
    pub pack_id: String,
    /// Review-queue size requested from the replay branch.
    pub pack_size: usize,
    /// Held-out QA share (`0.0` disables it).
    pub held_out_share: f32,
    /// Generated book bases in the variant branch.
    pub rehearsal_bases: usize,
    /// Variants attempted per generated base.
    pub variants_per_base: usize,
    /// Directory the audited pack is staged into; defaults to
    /// `<data-root>/hosted`.
    pub host_dir: Option<PathBuf>,
}

impl QaOptions {
    /// The defaults for the committed fixture corpus.
    pub fn fixture(corpus: impl Into<PathBuf>, generated_at: impl Into<String>) -> Self {
        Self {
            corpus: corpus.into(),
            generated_at: generated_at.into(),
            selection_pack_id: QA_SELECTION_PACK_ID.to_string(),
            pack_id: QA_PACK_ID.to_string(),
            pack_size: QA_PACK_SIZE,
            held_out_share: 0.25,
            rehearsal_bases: QA_REHEARSAL_BASES,
            variants_per_base: 2,
            host_dir: None,
        }
    }
}

/// One Q1 run's machine-readable report.
#[derive(Debug, Clone, Serialize)]
pub struct QaReport {
    /// `riichiprac.qa-pipeline`.
    pub schema: String,
    /// Schema version.
    pub version: u32,
    /// The pinned timestamp every artifact used.
    pub generated_at: String,
    /// Absolute data root.
    pub data_root: String,
    /// Fixture corpus ingestion.
    pub corpus: CorpusReport,
    /// Fixture-model label pass.
    pub labels: LabelReport,
    /// Selection, review queue and held-out QA.
    pub selection: SelectionOutcomeReport,
    /// Automated review dispositions.
    pub review: ReviewReport,
    /// Seeded book-rehearsal variant stage.
    pub variants: VariantStageReport,
    /// The audited, published pack.
    pub pack: PackReport,
    /// Directory audit findings.
    pub audit: AuditReportSummary,
    /// Same-origin staged copy and its verification.
    pub hosting: HostReportSummary,
    /// G11 storage/backup evidence.
    pub storage: StorageReport,
    /// Funnel facts a CI log can read without parsing the nested reports.
    pub checks: BTreeMap<String, bool>,
}

/// Fixture corpus ingestion facts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CorpusReport {
    /// Source directory.
    pub source: String,
    /// Files read.
    pub files: usize,
    /// Replays written and registered (content-addressed).
    pub replays: usize,
    /// Family every replay was registered under.
    pub family: String,
    /// Per-file replay ids and byte sizes.
    pub entries: Vec<CorpusEntry>,
}

/// One ingested fixture replay.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CorpusEntry {
    /// Source file name.
    pub source: String,
    /// Content-addressed replay id (SHA-256 of the gzipped bytes).
    pub replay_id: String,
    /// Stored bytes.
    pub bytes: u64,
    /// Stored relative path.
    pub path: String,
}

/// Label pass facts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LabelReport {
    /// Evaluator identity recorded on every label.
    pub model: String,
    /// Evaluator checkpoint hash.
    pub model_sha256: String,
    /// Replays walked.
    pub replays_walked: usize,
    /// Decisions seen.
    pub decisions_seen: usize,
    /// Decisions labelled.
    pub decisions_labelled: usize,
    /// Decisions served from the cache.
    pub decisions_cached: usize,
    /// Decisions that failed.
    pub decisions_failed: usize,
}

/// Selection and review facts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SelectionOutcomeReport {
    /// Pack id.
    pub pack_id: String,
    /// Requested pack size.
    pub pack_size: usize,
    /// Replays walked.
    pub replays_walked: usize,
    /// Decisions reconstructed.
    pub decisions_seen: u64,
    /// Candidates that passed the hard gates.
    pub candidates_valid: u64,
    /// Selected queue items.
    pub selected: usize,
    /// Held-out QA items.
    pub held_out: usize,
    /// Review queue path.
    pub queue: String,
    /// Held-out queue path.
    pub held_out_queue: String,
    /// Selection report path.
    pub report: String,
    /// Whether every queue item was accepted.
    pub all_accepted: bool,
    /// Queue items accepted.
    pub accepted: usize,
    /// Held-out QA items accepted.
    pub held_out_accepted: usize,
    /// Rejected disposition counts (zero for the fixture).
    pub rejected: usize,
    /// Items with no disposition yet.
    pub pending: usize,
    /// Items whose embedded report failed to re-parse.
    pub invalid: usize,
}

/// Variant-stage facts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VariantStageReport {
    /// Pack id.
    pub pack_id: String,
    /// Bases consumed.
    pub bases: usize,
    /// Variants attempted.
    pub attempted: usize,
    /// Variants that passed the label-preservation gate.
    pub shipped: usize,
    /// Variants rejected.
    pub rejected: usize,
    /// Transform families exercised.
    pub families: Vec<String>,
    /// Variant report path.
    pub report: String,
}

/// Published pack facts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackReport {
    /// Pack id.
    pub id: String,
    /// Absolute body path.
    pub path: String,
    /// Body bytes.
    pub bytes: u64,
    /// Body SHA-256.
    pub sha256: String,
    /// Scenario count.
    pub scenarios: u32,
    /// Whether the in-publish P1a audit was clean.
    pub audit_clean: bool,
}

/// Audit summary.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditReportSummary {
    /// Manifest audited.
    pub manifest: String,
    /// Findings count.
    pub findings: usize,
    /// Error findings count.
    pub errors: usize,
    /// Warning findings count.
    pub warnings: usize,
    /// Whether the audit was clean.
    pub clean: bool,
}

/// Hosting publication facts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostReportSummary {
    /// Hosting directory.
    pub dir: String,
    /// Manifest path.
    pub manifest: String,
    /// Hosted body count.
    pub packs: usize,
    /// Summed body bytes.
    pub total_bytes: u64,
    /// Manifest bytes.
    pub manifest_bytes: u64,
    /// Verification passed.
    pub verified: bool,
}

/// G11 storage and backup evidence.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageReport {
    /// Snapshot path.
    pub snapshot: String,
    /// Snapshot bytes.
    pub snapshot_bytes: u64,
    /// Snapshot SHA-256.
    pub snapshot_sha256: String,
    /// `PRAGMA integrity_check` result.
    pub integrity: String,
    /// Row counts for every miner table.
    pub rows: BTreeMap<String, i64>,
    /// Replay paths checked for the content-addressed layout.
    pub content_addressed: usize,
    /// Local replay backup plan (never executed by the harness).
    pub replay_backup: String,
    /// Local snapshot backup plan (never executed by the harness).
    pub snapshot_backup: String,
}

/// A Q1 harness failure.
#[derive(Debug, Error)]
pub enum QaError {
    /// Storage layer.
    #[error("storage: {0}")]
    Storage(#[from] StorageError),
    /// Label layer.
    #[error("label: {0}")]
    Label(#[from] LabelError),
    /// Selection layer.
    #[error("selection: {0}")]
    Selection(#[from] SelectionError),
    /// Variant layer.
    #[error("variant: {0}")]
    Variant(#[from] VariantError),
    /// Pack layer.
    #[error("pack: {0}")]
    Pack(#[from] PackError),
    /// Filesystem.
    #[error("i/o at `{path}`: {source}")]
    Io {
        /// Path.
        path: String,
        /// Source error.
        #[source]
        source: std::io::Error,
    },
    /// Serialisation.
    #[error("cannot serialise the Q1 report: {0}")]
    Serialise(String),
    /// No fixture repo.
    #[error("the fixture corpus `{0}` holds no .jsonl or .jsonl.gz replay")]
    EmptyCorpus(String),
    /// The review pass did not accept every queue item.
    #[error("the review queue still has {pending} pending item(s)")]
    ReviewPending {
        /// Pending count.
        pending: usize,
    },
    /// The pack was not published.
    #[error("the variant stage did not publish a pack")]
    PackNotPublished,
    /// A replay row did not use the content-addressed path.
    #[error("replay `{replay}` is stored at `{path}`, not `replays/{family}/<id>.jsonl.gz`")]
    NonAddressedReplay {
        /// Replay id.
        replay: String,
        /// Family.
        family: String,
        /// Stored path.
        path: String,
    },
    /// The audit found an error.
    #[error("the pack audit found {errors} error(s); see the report")]
    AuditDirty {
        /// Error count.
        errors: usize,
    },
    /// Provenance validation.
    #[error("provenance: {0}")]
    Provenance(#[from] ProvenanceError),
    /// Id parsing.
    #[error("id: {0}")]
    Id(#[from] IdError),
    /// SQLite.
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
}

/// Run the Q1 fixture pipeline in `root`.
pub fn run_fixture_pipeline(root: &DataRoot, options: &QaOptions) -> Result<QaReport, QaError> {
    root.ensure_layout()?;
    let started = options.generated_at.clone();

    let corpus = ingest_corpus(root, &options.corpus, &started)?;
    if corpus.replays == 0 {
        return Err(QaError::EmptyCorpus(options.corpus.display().to_string()));
    }

    // 1. Fixture model label pass.
    let evaluator = FixtureEvaluator::new();
    let label_options = LabelRunOptions {
        replays: Some(root.replays_dir()),
        family: Some(QA_FAMILY.to_string()),
        classifier_version: CLASSIFIER_VERSION.to_string(),
        ..LabelRunOptions::new("q1-fixture-evaluator")
    };
    let label_report = run_shard(root, &label_options, &evaluator)?;
    if label_report.decisions_failed > 0 {
        return Err(QaError::Label(LabelError::Evaluation(format!(
            "{} fixture decision(s) failed to label",
            label_report.decisions_failed
        ))));
    }

    // 2. Selection, review queue and held-out QA.
    let mut selection_config = SelectionConfig {
        pack_id: options.selection_pack_id.clone(),
        pack_size: options.pack_size,
        held_out_share: options.held_out_share,
        quotas: QuotaConfig {
            families: BTreeMap::from([(Family::MortalBest, 1.0)]),
            max_section_share: 1.0,
            max_decision_kind_share: 1.0,
            max_turn_bucket_share: 1.0,
            ..QuotaConfig::default()
        },
        ..SelectionConfig::default()
    };
    selection_config.held_out_salt = "q1-fixture".to_string();
    let selection = run_selection(
        root,
        &SelectionOptions {
            replays: Some(root.replays_dir()),
            family: Some(QA_FAMILY.to_string()),
            limit: None,
            extracted_only: false,
            config: selection_config,
            dry_run: false,
        },
    )?;
    let selected = selection.queue.len();
    let held_out = selection.held_out.len();
    if selected == 0 {
        return Err(QaError::Selection(SelectionError::InvalidConfig(
            "the fixture shard produced no selectable scenario; the fixture corpus or the \
             gates changed"
                .to_string(),
        )));
    }

    // 3. Automated review: accept every queue and held-out item.
    let queue_ids: Vec<String> = selection
        .queue
        .iter()
        .map(|item| item.queue_id.clone())
        .collect();
    let review = review_queue(&ReviewOptions {
        queue: selection.paths.queue.clone(),
        accept: queue_ids,
        reject: Vec::new(),
        note: Some("Q1 fixture auto-accept".to_string()),
        dry_run: false,
    })?;
    let accepted = review.accepted;
    let mut held_out_accepted = 0_usize;
    let mut rejected = review.rejected;
    let mut pending = review.pending;
    let mut invalid = review.invalid;
    if !selection.held_out.is_empty() {
        let held_ids: Vec<String> = selection
            .held_out
            .iter()
            .map(|item| item.queue_id.clone())
            .collect();
        let held = review_queue(&ReviewOptions {
            queue: selection.paths.held_out.clone(),
            accept: held_ids,
            reject: Vec::new(),
            note: Some("Q1 held-out QA auto-accept".to_string()),
            dry_run: false,
        })?;
        held_out_accepted += held.accepted;
        rejected += held.rejected;
        pending += held.pending;
        invalid += held.invalid;
    }
    if pending > 0 {
        return Err(QaError::ReviewPending { pending });
    }

    // 4. Seeded book rehearsal -> transform -> pack.
    let variants = run_variants(
        root,
        &VariantRunOptions {
            queue: None,
            rehearsal: Some(options.rehearsal_bases),
            pack_id: Some(options.pack_id.clone()),
            config: VariantConfig {
                variants_per_base: options.variants_per_base,
                max_per_base: 8,
                max_pack_share: 0.2,
                pack_size: options.rehearsal_bases,
                min_yield: 0.5,
                transform_seed: "q1-fixture".to_string(),
                ..VariantConfig::default()
            },
            out: None,
            generated_at: Some(started.clone()),
            publish: true,
            persist: false,
            dry_run: false,
        },
        None,
    )?;
    let published = variants
        .published
        .as_ref()
        .ok_or(QaError::PackNotPublished)?;

    // 5. Re-audit the export directory, then stage it same-origin.
    let audit = audit_pack_dir(&root.packs_dir(), None, &AuditOptions::default())?;
    let error_count = audit
        .findings
        .iter()
        .filter(|finding| finding.severity == crate::miner::pack::FindingSeverity::Error)
        .count();
    if error_count > 0 {
        return Err(QaError::AuditDirty {
            errors: error_count,
        });
    }

    let host_dir = options
        .host_dir
        .clone()
        .unwrap_or_else(|| root.root().join("hosted"));
    let hosted = publish_hosted(&HostOptions::new(
        root.packs_dir(),
        &host_dir,
        started.clone(),
    ))?;
    let hosted_verified = verify_hosted_dir(&host_dir, &HostBudget::default())?;

    // 6. G11 storage: snapshot + integrity check, content-addressed paths.
    let storage = storage_evidence(root, published.entry.sha256.as_str())?;

    let selection_report = SelectionOutcomeReport {
        pack_id: selection.report.pack_id.clone(),
        pack_size: selection.report.pack_size,
        replays_walked: selection.report.replays_walked,
        decisions_seen: selection.report.decisions_seen,
        candidates_valid: selection.report.candidates_valid,
        selected,
        held_out,
        queue: selection.paths.queue.display().to_string(),
        held_out_queue: selection.paths.held_out.display().to_string(),
        report: selection.paths.report.display().to_string(),
        all_accepted: pending == 0
            && invalid == 0
            && rejected == 0
            && accepted + held_out_accepted == selected + held_out,
        accepted,
        held_out_accepted,
        rejected,
        pending,
        invalid,
    };

    let variant_report = VariantStageReport {
        pack_id: options.pack_id.clone(),
        bases: variants.bases.len(),
        attempted: variants.variants.len() + variants.rejected.len(),
        shipped: variants.variants.len(),
        rejected: variants.rejected.len(),
        families: variants.report.share.transform_families.clone(),
        report: variants.paths.report.display().to_string(),
    };

    let pack_report = PackReport {
        id: published.entry.id.to_string(),
        path: published.path.display().to_string(),
        bytes: published.entry.bytes,
        sha256: published.entry.sha256.clone(),
        scenarios: published.entry.scenario_count,
        audit_clean: published.audit.is_clean(),
    };

    let audit_summary = AuditReportSummary {
        manifest: audit.manifest.clone(),
        findings: audit.findings.len(),
        errors: error_count,
        warnings: audit.findings.len().saturating_sub(error_count),
        clean: audit.is_clean(),
    };

    let hosting_summary = HostReportSummary {
        dir: host_dir.display().to_string(),
        manifest: hosted.manifest_path.display().to_string(),
        packs: hosted_verified.entries.len(),
        total_bytes: hosted_verified.total_bytes,
        manifest_bytes: hosted_verified.manifest_bytes,
        verified: !hosted_verified.entries.is_empty(),
    };

    let mut checks = BTreeMap::new();
    checks.insert("corpus_ingested".to_string(), corpus.replays > 0);
    checks.insert(
        "labels_clean".to_string(),
        label_report.decisions_failed == 0,
    );
    checks.insert("selection_nonempty".to_string(), selected > 0);
    checks.insert("held_out_present".to_string(), held_out > 0);
    checks.insert(
        "review_complete".to_string(),
        pending == 0
            && invalid == 0
            && rejected == 0
            && accepted + held_out_accepted == selected + held_out,
    );
    checks.insert(
        "variants_shipped".to_string(),
        !variants.variants.is_empty(),
    );
    checks.insert("pack_published".to_string(), published.audit.is_clean());
    checks.insert("audit_clean".to_string(), audit.is_clean());
    checks.insert(
        "hosting_verified".to_string(),
        !hosted_verified.entries.is_empty(),
    );
    checks.insert("storage_integrity".to_string(), storage.integrity == "ok");
    checks.insert(
        "content_addressed".to_string(),
        storage.content_addressed == corpus.replays,
    );

    Ok(QaReport {
        schema: QA_SCHEMA.to_string(),
        version: QA_VERSION,
        generated_at: started,
        data_root: root.root().display().to_string(),
        corpus,
        labels: LabelReport {
            model: label_report.model.clone(),
            model_sha256: label_report.model_sha256.clone(),
            replays_walked: label_report.replays_walked,
            decisions_seen: label_report.decisions_seen,
            decisions_labelled: label_report.decisions_labelled,
            decisions_cached: label_report.decisions_cached,
            decisions_failed: label_report.decisions_failed,
        },
        selection: selection_report,
        review,
        variants: variant_report,
        pack: pack_report,
        audit: audit_summary,
        hosting: hosting_summary,
        storage,
        checks,
    })
}

/// Ingest every fixture replay under `source` into the data root.
fn ingest_corpus(
    root: &DataRoot,
    source: &Path,
    generated_at: &str,
) -> Result<CorpusReport, QaError> {
    let mut files: Vec<PathBuf> = fs::read_dir(source)
        .map_err(|source| QaError::Io {
            path: source.to_string(),
            source,
        })?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .filter(|path| {
            path.extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ext == "jsonl" || ext == "gz")
        })
        .collect();
    if files.is_empty() {
        return Err(QaError::EmptyCorpus(source.display().to_string()));
    }
    files.sort();
    let db = open_miner_db(root)?;
    let base_games = fixture_games();
    let corpus_id =
        CorpusId::parse("q1-fixture-corpus").expect("the Q1 fixture corpus id is a slug");
    let mut entries = Vec::with_capacity(files.len());
    for (index, path) in files.iter().enumerate() {
        let raw = fs::read(path).map_err(|source| QaError::Io {
            path: path.display().to_string(),
            source,
        })?;
        let gz = if path.extension().and_then(|ext| ext.to_str()) == Some("gz") {
            raw
        } else {
            gzip_deterministic(&raw)
        };
        let replay_id = ReplayId::from_bytes(&gz);
        let stored = root.replay_path(QA_FAMILY, &replay_id)?;
        if let Some(parent) = stored.parent() {
            fs::create_dir_all(parent).map_err(|source| QaError::Io {
                path: parent.display().to_string(),
                source,
            })?;
        }
        fs::write(&stored, &gz).map_err(|source| QaError::Io {
            path: stored.display().to_string(),
            source,
        })?;

        let mut game = base_games[index % base_games.len()].clone();
        game.replay_id = replay_id.clone();
        game.corpus_id = corpus_id.clone();
        game.family = QA_FAMILY.to_string();
        game.generated_at = generated_at.to_string();
        game.game_seed = format!("0xq1{index:04x}");
        game.log.bytes = u64::try_from(gz.len()).unwrap_or(u64::MAX);
        game.log.sha256 = replay_id.clone();
        game.log.path = DataRoot::replay_relative_path(QA_FAMILY, &replay_id)?;
        game.validate()?;
        let provenance_json =
            serde_json::to_string(&game).map_err(|err| QaError::Serialise(err.to_string()))?;
        db.execute(
            "INSERT OR REPLACE INTO replays (
                replay_id, source, licence, attribution, format, rule,
                rule_config_hash, generated_at, model, model_sha256, seed,
                log_path, log_bytes, log_sha256, validation_status,
                ingested_at, corpus_id, family, match_plan_id,
                match_plan_sha256, agents, provenance_json
             ) VALUES (?1, 'ai_selfplay', 'CC-BY-4.0', ?2, 'mjai',
                'tenhou-4p-hanchan', ?3, ?4, 'fixture-evaluator', ?5, ?6,
                ?7, ?8, ?9, 'ok', ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            params![
                replay_id.as_str(),
                "Q1 fixture corpus (synthetic games generated by the riichiprac miner)",
                game.rule.config_hash,
                game.generated_at,
                sha256_hex(FIXTURE_EVALUATOR_NAME.as_bytes()),
                game.game_seed,
                game.log.path,
                i64::try_from(gz.len()).unwrap_or(i64::MAX),
                replay_id.as_str(),
                generated_at,
                game.corpus_id.as_str(),
                QA_FAMILY,
                "q1-fixture-plan",
                game.match_plan_sha256,
                serde_json::to_string(&game.seats)
                    .map_err(|err| QaError::Serialise(err.to_string()))?,
                provenance_json,
            ],
        )
        .map_err(StorageError::from)?;

        entries.push(CorpusEntry {
            source: path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default(),
            replay_id: replay_id.to_string(),
            bytes: u64::try_from(gz.len()).unwrap_or(u64::MAX),
            path: game.log.path,
        });
    }
    Ok(CorpusReport {
        source: source.display().to_string(),
        files: files.len(),
        replays: entries.len(),
        family: QA_FAMILY.to_string(),
        entries,
    })
}

/// Gzip fixture bytes with a fixed header so the replay id is reproducible.
fn gzip_deterministic(raw: &[u8]) -> Vec<u8> {
    let mut encoder = GzBuilder::new()
        .mtime(0)
        .write(Vec::new(), Compression::default());
    encoder
        .write_all(raw)
        .expect("in-memory gzip writer accepts bytes");
    encoder.finish().expect("in-memory gzip writer finishes")
}

/// Snapshot the DB and verify the G11 storage invariants.
fn storage_evidence(root: &DataRoot, pack_sha: &str) -> Result<StorageReport, QaError> {
    let db = open_miner_db(root)?;
    let rows = row_counts(&db)?;
    let snapshot_path = root
        .snapshots_dir()
        .join(format!("miner-check-{}.sqlite", &pack_sha[..12]));
    if snapshot_path.exists() {
        fs::remove_file(&snapshot_path).map_err(|source| QaError::Io {
            path: snapshot_path.display().to_string(),
            source,
        })?;
    }
    let snapshot = snapshot_database(&db, &snapshot_path)?;

    let mut statement = db.prepare("SELECT replay_id, family, log_path FROM replays")?;
    let rows_iter = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut content_addressed = 0_usize;
    for row in rows_iter {
        let (replay_id, family, path) = row.map_err(StorageError::from)?;
        let id = ReplayId::parse(&replay_id)?;
        let expected = DataRoot::replay_relative_path(&family, &id)?;
        if path != expected {
            return Err(QaError::NonAddressedReplay {
                replay: replay_id,
                family,
                path,
            });
        }
        content_addressed += 1;
    }

    let replay_backup = backup_label(plan_replay_backup(root, None));
    let snapshot_backup = backup_label(plan_snapshot_backup(&snapshot.path, None));

    let integrity = integrity_of(&snapshot)?;
    Ok(StorageReport {
        snapshot: snapshot.path.display().to_string(),
        snapshot_bytes: snapshot.bytes,
        snapshot_sha256: snapshot.sha256,
        integrity,
        rows: rows
            .into_iter()
            .map(|(table, count)| (table.to_string(), count))
            .collect(),
        content_addressed,
        replay_backup,
        snapshot_backup,
    })
}

/// Re-read the snapshot's `PRAGMA integrity_check`.
fn integrity_of(snapshot: &SnapshotInfo) -> Result<String, QaError> {
    let connection = rusqlite::Connection::open(&snapshot.path)?;
    let result: String = connection.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
    Ok(result)
}

/// A stable label for a backup plan (the harness never runs rclone).
fn backup_label(outcome: BackupOutcome) -> String {
    match outcome {
        BackupOutcome::Skipped { reason } => format!("skipped: {reason}"),
        BackupOutcome::Planned { commands } => format!(
            "planned: {}",
            commands
                .iter()
                .map(|command| command.display())
                .collect::<Vec<_>>()
                .join(" && ")
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_fixture_gzip_is_byte_stable() {
        let first = gzip_deterministic(b"one\n");
        let second = gzip_deterministic(b"one\n");
        assert_eq!(first, second);
        assert_ne!(first, b"one\n");
    }

    #[test]
    fn a_missing_corpus_is_a_hard_failure() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = DataRoot::new(temp.path().join("data")).expect("data root");
        let error = ingest_corpus(&root, &temp.path().join("missing"), "2026-11-17T00:00:00Z")
            .expect_err("a missing corpus must fail");
        assert!(matches!(error, QaError::Io { .. }));
    }
}
