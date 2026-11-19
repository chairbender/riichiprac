//! Entry point for the native-only replay miner.
//!
//! F1 created the feature boundary and the subcommand surface; L1 implements
//! `label` on top of the R2 walker and the F1 database, S1 implements `triggers`,
//! S2 implements `select` and `review`, V2 implements `transform`, and
//! P1a/P1b/P2 implement `pack fixture`, `pack assemble`, `pack publish`,
//! `pack report` and `audit`, and Q1 implements `qa fixture`. The remaining
//! commands are still stubs: running
//! one exits with code 2 and writes a "not implemented" line to stderr, so a
//! script cannot mistake it for a completed run.
//!
//! Build and run:
//!
//! ```text
//! cargo run --features miner --bin mine_replays -- --help
//! cargo run --features miner --bin mine_replays -- label --weights \
//!   frontend/public/models/mortal_298k.safetensors
//! ```
//!
//! The data root is `--data-dir`, then `$RIICHI_DATA_DIR`, then
//! `$HOME/riichiprac-data`; see [`riichiprac::miner::DataRoot`].

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::SystemTime;

use clap::{Parser, Subcommand};

use riichiprac::miner::extract::{ExtractOptions, ExtractReport, run_extraction};
use riichiprac::miner::label::Labeler;
use riichiprac::miner::label::run::{LabelRunOptions, LabelRunReport, run_label};
use riichiprac::miner::qa::{QA_PACK_ID, QA_SELECTION_PACK_ID, QaOptions, run_fixture_pipeline};
use riichiprac::miner::variant::{
    DEFAULT_MAX_PER_BASE, DEFAULT_MIN_YIELD, DEFAULT_PACK_SHARE, DEFAULT_TRANSFORM_SEED,
    DEFAULT_VARIANTS_PER_BASE, VariantLabeler, VariantRunOptions, YieldPolicy, run_variants,
};
use riichiprac::miner::{
    AssemblyLimits, AssemblyOptions, AuditOptions, CLASSIFIER_VERSION, DEFAULT_GENERATOR_COMMIT,
    DEFAULT_MAX_HOSTED_BYTES, DEFAULT_PACK_SIZE, DataRoot, FamilyFilter, GAMES_FILE_NAME,
    HostOptions, MANIFEST_FILE_NAME, PackAudit, PackAuditContext, PackBudget, PackError,
    PackFinding, PackFindingCode, PackId, PublishProfile, QPointCalibration, ReviewOptions,
    SelectionConfig, SelectionOptions, TriggerConfig, TriggerFilter, TriggerSampleOptions,
    TriggerSampleReport, audit_pack_dir, audit_summary, fixture_games, fixture_pack, latest_pack,
    load_manifest, open_miner_db, pack_report, publish_hosted, publish_pack, read_pack, read_queue,
    render_pack_report, review_queue, run_assembly, run_selection, run_trigger_sample,
    selection_paths, utc_iso8601, write_games_atomic,
};

#[derive(Debug, Parser)]
#[command(
    name = "mine_replays",
    version,
    about = "Riichi replay miner (native-only)"
)]
struct Cli {
    /// Data root. Defaults to $RIICHI_DATA_DIR or ~/riichiprac-data.
    #[arg(long, global = true, value_name = "DIR")]
    data_dir: Option<PathBuf>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Generate mixed-agent self-play corpora.
    Corpus {
        #[command(subcommand)]
        action: Option<CorpusAction>,
    },
    /// Ingest and validate raw self-play logs.
    Ingest,
    /// Reconstruct and persist decision points from validated logs.
    Extract {
        /// Replay directory (default: <data-dir>/replays).
        #[arg(long, value_name = "DIR")]
        replays: Option<PathBuf>,

        /// Read only this family sub-directory.
        #[arg(long, value_name = "NAME")]
        family: Option<String>,

        /// Maximum replay files in this shard.
        #[arg(long, value_name = "N")]
        limit: Option<usize>,

        /// Worker threads for the offline walk. 0 uses every available core; 1
        /// is for debugging and tests.
        #[arg(long, value_name = "N", default_value_t = 0)]
        workers: usize,

        /// Print phase and file progress to stderr.
        #[arg(long)]
        progress: bool,

        /// Validate and report without writing any row.
        #[arg(long)]
        dry_run: bool,

        /// Machine-readable report.
        #[arg(long)]
        json: bool,
    },
    /// Label candidates with book classifiers and Mortal.
    Label {
        /// Mortal checkpoint (.safetensors).
        #[arg(long, value_name = "FILE")]
        weights: PathBuf,

        /// Additional checkpoints for the optional multi-model vote pass,
        /// comma separated. One checkpoint is the normal labeler and is not an
        /// ensemble; a multi-model pass records each member's vote.
        #[arg(long, value_name = "FILE,...", value_delimiter = ',')]
        models: Vec<PathBuf>,

        /// Versioned Q→point calibration (JSON). Point estimates are recorded
        /// in a separate field and the raw Q values are never overwritten.
        #[arg(long, value_name = "FILE")]
        calibration: Option<PathBuf>,

        /// Replay directory (default: <data-dir>/replays).
        #[arg(long, value_name = "DIR")]
        replays: Option<PathBuf>,

        /// Label only this family sub-directory.
        #[arg(long, value_name = "NAME")]
        family: Option<String>,

        /// Maximum replay files in this shard.
        #[arg(long, value_name = "N")]
        limit: Option<usize>,

        /// Classifier generation recorded on every label.
        #[arg(long, value_name = "V", default_value = CLASSIFIER_VERSION)]
        classifier_version: String,

        /// Worker threads for the offline label pass. 0 uses every available
        /// core; 1 is for debugging and tests.
        #[arg(long, value_name = "N", default_value_t = 0)]
        workers: usize,

        /// Print phase and file progress to stderr.
        #[arg(long)]
        progress: bool,

        /// Reward discount the checkpoint was trained with, when known.
        #[arg(long, value_name = "F32")]
        gamma: Option<f32>,

        /// Placement utility weights, comma separated, when known.
        #[arg(long, value_name = "a,b,c,d", value_delimiter = ',')]
        pts: Option<Vec<f32>>,

        /// Only label decisions whose cheap trigger fires. Comma separated:
        /// book, defensive_riichi, offensive_architecture, call_kan,
        /// score_placement. Label-derived triggers are rejected here.
        #[arg(long, value_name = "LIST", value_delimiter = ',')]
        trigger: Vec<String>,

        /// Machine-readable report.
        #[arg(long)]
        json: bool,
    },
    /// Report cheap candidate triggers and their family precision/recall.
    Triggers {
        /// Replay directory (default: <data-dir>/replays).
        #[arg(long, value_name = "DIR")]
        replays: Option<PathBuf>,

        /// Read only this family sub-directory.
        #[arg(long, value_name = "NAME")]
        family: Option<String>,

        /// Maximum replay files in the sample.
        #[arg(long, value_name = "N")]
        limit: Option<usize>,

        /// Only count these candidate families.
        #[arg(long, value_name = "LIST", value_delimiter = ',')]
        families: Vec<String>,

        /// Do not write trigger reasons onto decisions rows.
        #[arg(long)]
        dry_run: bool,

        /// Machine-readable report.
        #[arg(long)]
        json: bool,
    },
    /// Select a balanced, deduplicated review queue from a replay shard.
    Select {
        /// Replay directory (default: <data-dir>/replays).
        #[arg(long, value_name = "DIR")]
        replays: Option<PathBuf>,

        /// Read only this family sub-directory.
        #[arg(long, value_name = "NAME")]
        family: Option<String>,

        /// Maximum replay files in the shard.
        #[arg(long, value_name = "N")]
        limit: Option<usize>,

        /// Pack id and review-directory name. Defaults to `s2-<UTC stamp>`.
        #[arg(long, value_name = "ID")]
        pack_id: Option<String>,

        /// Pack size (scenarios to select).
        #[arg(long, value_name = "N", default_value_t = DEFAULT_PACK_SIZE)]
        size: usize,

        /// Share of the pack kept out for held-out QA (0 disables).
        #[arg(long, value_name = "F32")]
        held_out_share: Option<f32>,

        /// Salt for the deterministic held-out split.
        #[arg(long, value_name = "TEXT")]
        seed: Option<String>,

        /// Lesson scope: only these book sections (`ch8` or `ch8.2`). Comma
        /// separated; repeat is not needed.
        #[arg(long, value_name = "LIST", value_delimiter = ',')]
        section: Vec<String>,

        /// Lesson scope: only these exact book lesson ids.
        #[arg(long, value_name = "LIST", value_delimiter = ',')]
        lesson: Vec<String>,

        /// Lesson scope: only these corpus (replay) families, mixed together.
        #[arg(long, value_name = "LIST", value_delimiter = ',')]
        corpus_family: Vec<String>,

        /// Maximum selected bases per corpus family, e.g.
        /// `mortal_mirror=20,akochan_tactics=20`.
        #[arg(long, value_name = "LIST", value_delimiter = ',')]
        corpus_cap: Vec<String>,

        /// Maximum selected bases from one source replay.
        #[arg(long, value_name = "N")]
        max_per_replay: Option<usize>,

        /// Walk only replays that already have extracted decisions rows.
        #[arg(long)]
        extracted_only: bool,

        /// Worker threads for the offline selection walk. 0 uses every
        /// available core; 1 is for debugging and tests.
        #[arg(long, value_name = "N", default_value_t = 0)]
        workers: usize,

        /// Print phase and file progress to stderr.
        #[arg(long)]
        progress: bool,

        /// Keep only stable book labels (reject book/Mortal disagreement).
        #[arg(long)]
        stable_book_only: bool,

        /// Maximum share of the pack one book section may occupy (default 0.20).
        /// A lesson-scoped pack raises this so three known sections can fill it.
        #[arg(long, value_name = "F32")]
        max_section_share: Option<f32>,

        /// Maximum share of the pack one decision kind may occupy.
        #[arg(long, value_name = "F32")]
        max_kind_share: Option<f32>,

        /// Maximum share of the pack one turn bucket may occupy.
        #[arg(long, value_name = "F32")]
        max_turn_share: Option<f32>,

        /// Build and report without writing the queue or the report.
        #[arg(long)]
        dry_run: bool,

        /// Machine-readable report.
        #[arg(long)]
        json: bool,
    },
    /// Generate label-preserving scenario variants.
    Transform {
        /// Review queue to transform. Defaults to the latest `select` run.
        #[arg(long, value_name = "FILE")]
        queue: Option<PathBuf>,

        /// Build N generated book bases instead of reading a review queue.
        #[arg(long, value_name = "N")]
        rehearsal: Option<usize>,

        /// Pack id. Defaults to the queue's pack id, or a rehearsal stamp.
        #[arg(long, value_name = "ID")]
        pack_id: Option<String>,

        /// Variants to keep per base.
        #[arg(
            long,
            value_name = "N",
            default_value_t = DEFAULT_VARIANTS_PER_BASE
        )]
        variants: usize,

        /// Maximum variants one base may contribute.
        #[arg(
            long,
            value_name = "N",
            default_value_t = DEFAULT_MAX_PER_BASE
        )]
        max_per_base: usize,

        /// Maximum share of the pack one base may occupy.
        #[arg(long, value_name = "F32", default_value_t = DEFAULT_PACK_SHARE)]
        share: f32,

        /// Pack size the per-base share is measured against.
        #[arg(long, value_name = "N", default_value_t = DEFAULT_PACK_SIZE)]
        pack_size: usize,

        /// Minimum yield a transform/lesson pair needs to stay enabled.
        #[arg(long, value_name = "F32", default_value_t = DEFAULT_MIN_YIELD)]
        min_yield: f32,

        /// Seed the transform parameters are drawn from.
        #[arg(long, value_name = "TEXT", default_value_t = DEFAULT_TRANSFORM_SEED.to_string())]
        seed: String,

        /// Reviewer yield-policy file (keeps low-yield pairs enabled).
        #[arg(long, value_name = "FILE")]
        yield_policy: Option<PathBuf>,

        /// Mortal checkpoint for the label re-run (needed for Mortal-only bases).
        #[arg(long, value_name = "FILE")]
        weights: Option<PathBuf>,

        /// Worker threads for the offline variant stage. 0 uses every available
        /// core; 1 is for debugging and tests.
        #[arg(long, value_name = "N", default_value_t = 0)]
        workers: usize,

        /// Print base/attempt progress to stderr.
        #[arg(long)]
        progress: bool,

        /// Output directory (default: reviews/<pack-id>/variants).
        #[arg(long, value_name = "DIR")]
        out: Option<PathBuf>,

        /// Report/pack timestamp. A fixed value keeps a reproducibility run's
        /// pack hash stable.
        #[arg(long, value_name = "ISO")]
        generated_at: Option<String>,

        /// Assemble and publish a pack through the P1a gate.
        #[arg(long)]
        pack: bool,

        /// Do not write the report, the variant files or a pack.
        #[arg(long)]
        dry_run: bool,

        /// Machine-readable report.
        #[arg(long)]
        json: bool,
    },
    /// Run the end-to-end acceptance harness on fixture data.
    Qa {
        #[command(subcommand)]
        action: Option<QaAction>,
    },
    /// Assemble, audit and export scenario packs.
    Pack {
        #[command(subcommand)]
        action: Option<PackAction>,
    },
    /// Audit provenance, licences and pack integrity.
    Audit {
        /// Manifest to audit (default: <data-dir>/packs/manifest.json).
        #[arg(long, value_name = "FILE")]
        manifest: Option<PathBuf>,

        /// Game provenance JSONL (default: games.jsonl beside the manifest).
        #[arg(long, value_name = "FILE")]
        games: Option<PathBuf>,

        /// Fail on warnings as well as errors.
        #[arg(long)]
        strict: bool,

        /// Audit for a commercial redistribution profile.
        #[arg(long)]
        commercial: bool,

        /// Machine-readable report.
        #[arg(long)]
        json: bool,
    },
    /// Work the human review queue.
    Review {
        /// Queue file. Defaults to the last `select` run's queue.
        #[arg(long, value_name = "FILE")]
        queue: Option<PathBuf>,

        /// Pack id under <data-dir>/reviews/ to review.
        #[arg(long, value_name = "ID")]
        pack: Option<String>,

        /// Review the held-out QA queue instead of the pack queue.
        #[arg(long)]
        held_out: bool,

        /// Queue ids to accept.
        #[arg(long, value_name = "LIST", value_delimiter = ',')]
        accept: Vec<String>,

        /// Queue ids to reject.
        #[arg(long, value_name = "LIST", value_delimiter = ',')]
        reject: Vec<String>,

        /// Note recorded on every new disposition.
        #[arg(long, value_name = "TEXT")]
        note: Option<String>,

        /// List every item with its verdict.
        #[arg(long)]
        list: bool,

        /// Print one item's embedded `riichiprac.scenario-report` and exit.
        #[arg(long, value_name = "QUEUE_ID")]
        show: Option<String>,

        /// Validate and report without writing dispositions.
        #[arg(long)]
        dry_run: bool,

        /// Machine-readable report.
        #[arg(long)]
        json: bool,
    },
}

#[derive(Debug, Subcommand)]
enum PackAction {
    /// Assemble, audit and export a pack from the selected DB rows.
    Assemble {
        /// Pack id to export (default: the latest `select` run's pack).
        #[arg(long, value_name = "ID")]
        pack: Option<String>,

        /// Review queue to check (default: reviews/<pack>/review-queue.jsonl).
        #[arg(long, value_name = "FILE")]
        queue: Option<PathBuf>,

        /// Pack data licence (default: the packed replays' shared licence).
        #[arg(long, value_name = "ID")]
        licence: Option<String>,

        /// Pack data attribution (default: the packed replays' shared text).
        #[arg(long, value_name = "TEXT")]
        attribution: Option<String>,

        /// Pack body byte ceiling (default: 50 MB).
        #[arg(long, value_name = "N")]
        max_bytes: Option<u64>,

        /// Scenario-count ceiling (default: 2000).
        #[arg(long, value_name = "N")]
        max_scenarios: Option<usize>,

        /// Maximum variants one base may contribute (default: 8).
        #[arg(long, value_name = "N")]
        max_per_base: Option<usize>,

        /// Maximum share of the pack one base may occupy (default: 0.20).
        #[arg(long, value_name = "F32")]
        share: Option<f32>,

        /// Maximum variants in the whole pack, spread evenly across the base
        /// order. Omit to keep every variant the per-base cap allows.
        #[arg(long, value_name = "N")]
        max_variants: Option<usize>,

        /// Ship the reviewed bases only; drop every variant.
        #[arg(long)]
        no_variants: bool,

        /// Drop a lesson that has fewer than N reviewed bases (default 1).
        #[arg(long, value_name = "N")]
        min_bases_per_lesson: Option<usize>,

        /// Keep at most one scenario per actor hand (different rivers/scores can
        /// otherwise repeat the same-looking hand).
        #[arg(long)]
        unique_hands: bool,

        /// Family ceilings counted in base scenarios, e.g. book=30,coverage=15.
        #[arg(long, value_name = "LIST", value_delimiter = ',')]
        family_quota: Vec<String>,

        /// Pack timestamp (default: the latest selected row's stamp).
        #[arg(long, value_name = "ISO")]
        generated_at: Option<String>,

        /// Generator commit label recorded on the pack (default: `db`).
        #[arg(long, value_name = "TEXT", default_value = DEFAULT_GENERATOR_COMMIT)]
        commit: String,

        /// Build, audit and report without writing the export or the DB rows.
        #[arg(long)]
        dry_run: bool,

        /// Machine-readable report.
        #[arg(long)]
        json: bool,
    },
    /// Publish the built-in fixture pack, manifest and provenance rows.
    Fixture {
        /// Output directory (default: <data-dir>/packs).
        #[arg(long, value_name = "DIR")]
        out: Option<PathBuf>,

        /// Pack body byte ceiling (default: 50 MB).
        #[arg(long, value_name = "N")]
        max_bytes: Option<u64>,

        /// Pack timestamp (default: now). A fixed value keeps a committed
        /// smoke pack reproducible.
        #[arg(long, value_name = "ISO")]
        generated_at: Option<String>,

        /// Machine-readable report.
        #[arg(long)]
        json: bool,
    },
    /// Stage audited packs into the same-origin Pages directory.
    Publish {
        /// Audited export directory (default: <data-dir>/packs).
        #[arg(long, value_name = "DIR")]
        from: Option<PathBuf>,

        /// Same-origin hosting directory (default: frontend/public/scenarios).
        #[arg(long, value_name = "DIR", default_value = "frontend/public/scenarios")]
        to: PathBuf,

        /// Pack ids to host. Default: every entry in the source manifest. A
        /// non-empty list replaces the hosted set with exactly those packs.
        #[arg(long, value_name = "LIST", value_delimiter = ',')]
        packs: Vec<String>,

        /// Total hosted body-byte ceiling (default: 50 MB).
        #[arg(long, value_name = "N")]
        max_total_bytes: Option<u64>,

        /// Manifest timestamp (default: now).
        #[arg(long, value_name = "ISO")]
        updated_at: Option<String>,

        /// Audit for a commercial redistribution profile.
        #[arg(long)]
        commercial: bool,

        /// Report without writing or pruning the destination.
        #[arg(long)]
        dry_run: bool,

        /// Machine-readable report.
        #[arg(long)]
        json: bool,
    },
    /// Print the pack report for every manifest entry.
    Report {
        /// Manifest to report on (default: <data-dir>/packs/manifest.json).
        #[arg(long, value_name = "FILE")]
        manifest: Option<PathBuf>,

        /// Machine-readable report.
        #[arg(long)]
        json: bool,
    },
}

#[derive(Debug, Subcommand)]
enum QaAction {
    /// Run the whole fixture pipeline once: ingest, label, select, review,
    /// transform, pack, audit, host and storage check.
    Fixture {
        /// Fixture corpus directory (`.jsonl` or `.jsonl.gz`).
        #[arg(long, value_name = "DIR", default_value = "testdata/replays")]
        corpus: PathBuf,

        /// Pinned timestamp for the packs, manifest and reports.
        #[arg(long, value_name = "ISO")]
        generated_at: Option<String>,

        /// Review-queue size requested from the replay branch.
        #[arg(long, value_name = "N", default_value_t = riichiprac::miner::qa::QA_PACK_SIZE)]
        pack_size: usize,

        /// Held-out QA share (0 disables).
        #[arg(long, value_name = "F32", default_value_t = 0.25)]
        held_out_share: f32,

        /// Generated book bases in the variant branch.
        #[arg(long, value_name = "N", default_value_t = riichiprac::miner::qa::QA_REHEARSAL_BASES)]
        rehearsal: usize,

        /// Variants attempted per generated base.
        #[arg(long, value_name = "N", default_value_t = 2)]
        variants: usize,

        /// Same-origin staging directory (default: <data-dir>/hosted).
        #[arg(long, value_name = "DIR")]
        host: Option<PathBuf>,

        /// Machine-readable report.
        #[arg(long)]
        json: bool,
    },
}

#[derive(Debug, Subcommand)]
enum CorpusAction {
    /// Print one row per corpus family: counts, triggers, labels, shortfalls.
    Report,
}

impl Command {
    fn name(&self) -> &'static str {
        match self {
            Self::Corpus { .. } => "corpus",
            Self::Ingest => "ingest",
            Self::Extract { .. } => "extract",
            Self::Label { .. } => "label",
            Self::Triggers { .. } => "triggers",
            Self::Transform { .. } => "transform",
            Self::Qa { .. } => "qa",
            Self::Pack { .. } => "pack",
            Self::Audit { .. } => "audit",
            Self::Select { .. } => "select",
            Self::Review { .. } => "review",
        }
    }
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let root = match cli.data_dir {
        Some(path) => DataRoot::new(path),
        None => DataRoot::from_env(),
    };
    let root = match root {
        Ok(root) => root,
        Err(err) => {
            eprintln!("mine_replays: {err}");
            return ExitCode::from(2);
        }
    };

    match cli.command {
        Command::Extract {
            replays,
            family,
            limit,
            workers,
            progress,
            dry_run,
            json,
        } => run_extract_command(
            &root,
            &ExtractOptions {
                replays,
                family,
                limit,
                workers,
                progress,
                dry_run,
            },
            json,
        ),
        Command::Label {
            weights,
            models,
            calibration,
            replays,
            family,
            limit,
            classifier_version,
            workers,
            progress,
            gamma,
            pts,
            trigger,
            json,
        } => {
            let calibration = match calibration {
                Some(path) => match QPointCalibration::read(&path) {
                    Ok(calibration) => Some(calibration),
                    Err(err) => {
                        eprintln!("mine_replays label: {err}");
                        return ExitCode::from(2);
                    }
                },
                None => None,
            };
            let trigger_filter = match TriggerFilter::parse(&trigger) {
                Ok(filter) => filter,
                Err(err) => {
                    eprintln!("mine_replays label: {err}");
                    return ExitCode::from(2);
                }
            };
            run_label_command(
                &root,
                &LabelRunOptions {
                    weights,
                    extra_models: models,
                    replays,
                    family,
                    limit,
                    classifier_version,
                    workers,
                    progress,
                    gamma,
                    pts,
                    label_options: Default::default(),
                    calibration,
                    trigger_filter,
                    trigger_config: TriggerConfig::default(),
                },
                json,
            )
        }
        Command::Triggers {
            replays,
            family,
            limit,
            families,
            dry_run,
            json,
        } => {
            let families = match FamilyFilter::parse(&families) {
                Ok(filter) => filter,
                Err(err) => {
                    eprintln!("mine_replays triggers: {err}");
                    return ExitCode::from(2);
                }
            };
            run_triggers_command(
                &root,
                &TriggerSampleOptions {
                    replays,
                    family,
                    limit,
                    config: TriggerConfig::default(),
                    families,
                    percentiles: Default::default(),
                    dry_run,
                },
                json,
            )
        }
        Command::Transform {
            queue,
            rehearsal,
            pack_id,
            variants,
            max_per_base,
            share,
            pack_size,
            min_yield,
            seed,
            yield_policy,
            weights,
            workers,
            progress,
            out,
            generated_at,
            pack,
            dry_run,
            json,
        } => {
            let mut config = riichiprac::miner::variant::VariantConfig {
                variants_per_base: variants,
                max_per_base,
                max_pack_share: share,
                pack_size,
                min_yield,
                transform_seed: seed,
                ..Default::default()
            };
            if let Some(path) = &yield_policy {
                match YieldPolicy::read(path) {
                    Ok(policy) => config.pair_overrides = policy.pairs,
                    Err(err) => {
                        eprintln!("mine_replays transform: {err}");
                        return ExitCode::from(2);
                    }
                }
            }
            let options = VariantRunOptions {
                queue,
                rehearsal,
                pack_id,
                config,
                out,
                generated_at,
                publish: pack,
                persist: rehearsal.is_none(),
                workers,
                progress,
                dry_run,
            };
            run_transform_command(&root, &options, weights, json)
        }
        Command::Qa { action } => run_qa_command(&root, action),
        Command::Pack { action } => run_pack_command(&root, action),
        Command::Audit {
            manifest,
            games,
            strict,
            commercial,
            json,
        } => run_audit_command(&root, manifest, games, strict, commercial, json),
        Command::Select {
            replays,
            family,
            limit,
            pack_id,
            size,
            held_out_share,
            seed,
            section,
            lesson,
            corpus_family,
            corpus_cap,
            max_per_replay,
            extracted_only,
            workers,
            progress,
            stable_book_only,
            max_section_share,
            max_kind_share,
            max_turn_share,
            dry_run,
            json,
        } => {
            let mut quotas = riichiprac::miner::QuotaConfig::default();
            if let Some(share) = max_section_share {
                quotas.max_section_share = share;
            }
            if let Some(share) = max_kind_share {
                quotas.max_decision_kind_share = share;
            }
            if let Some(share) = max_turn_share {
                quotas.max_turn_bucket_share = share;
            }
            let mut config = SelectionConfig {
                pack_size: size,
                book_prefixes: section,
                lessons: lesson,
                replay_families: corpus_family,
                max_per_replay,
                stable_book_only,
                quotas,
                ..SelectionConfig::default()
            };
            if let Err(err) = parse_family_caps(&corpus_cap, &mut config.replay_family_caps) {
                eprintln!("mine_replays select: {err}");
                return ExitCode::from(2);
            }
            config.pack_id = pack_id.unwrap_or_else(|| format!("s2-{}", utc_stamp_now()));
            if let Some(share) = held_out_share {
                config.held_out_share = share;
            }
            if let Some(seed) = seed {
                config.held_out_salt = seed;
            }
            run_select_command(
                &root,
                &SelectionOptions {
                    replays,
                    family,
                    limit,
                    extracted_only,
                    config,
                    workers,
                    progress,
                    dry_run,
                },
                json,
            )
        }
        Command::Review {
            queue,
            pack,
            held_out,
            accept,
            reject,
            note,
            list,
            show,
            dry_run,
            json,
        } => run_review_command(
            &root, queue, pack, held_out, &accept, &reject, note, list, show, dry_run, json,
        ),
        command => {
            eprintln!(
                "mine_replays {}: not implemented yet (data root: {})",
                command.name(),
                root.root().display()
            );
            ExitCode::from(2)
        }
    }
}

fn run_qa_command(root: &DataRoot, action: Option<QaAction>) -> ExitCode {
    let Some(action) = action else {
        eprintln!("mine_replays qa: choose `fixture`");
        return ExitCode::from(2);
    };
    match action {
        QaAction::Fixture {
            corpus,
            generated_at,
            pack_size,
            held_out_share,
            rehearsal,
            variants,
            host,
            json,
        } => {
            let options = QaOptions {
                corpus,
                generated_at: generated_at.unwrap_or_else(|| utc_iso8601(SystemTime::now())),
                selection_pack_id: QA_SELECTION_PACK_ID.to_string(),
                pack_id: QA_PACK_ID.to_string(),
                pack_size,
                held_out_share,
                rehearsal_bases: rehearsal,
                variants_per_base: variants,
                host_dir: host,
            };
            match run_fixture_pipeline(root, &options) {
                Ok(report) => {
                    if json {
                        match serde_json::to_string_pretty(&report) {
                            Ok(text) => println!("{text}"),
                            Err(err) => {
                                eprintln!("mine_replays qa fixture: cannot serialise: {err}");
                                return ExitCode::from(2);
                            }
                        }
                    } else {
                        println!(
                            "mine_replays qa fixture: {} replay(s), {} labels, {} selected, {} held out",
                            report.corpus.replays,
                            report.labels.decisions_labelled,
                            report.selection.selected,
                            report.selection.held_out
                        );
                        println!(
                            "  pack: {} ({} scenarios, {} bytes, sha256 {})",
                            report.pack.path,
                            report.pack.scenarios,
                            report.pack.bytes,
                            report.pack.sha256
                        );
                        println!(
                            "  variants: {} shipped / {} attempted from {} base(s)",
                            report.variants.shipped,
                            report.variants.attempted,
                            report.variants.bases
                        );
                        println!("  hosted: {}", report.hosting.dir);
                        println!(
                            "  snapshot: {} ({})",
                            report.storage.snapshot, report.storage.integrity
                        );
                        for (name, ok) in &report.checks {
                            println!("  {}: {}", if *ok { "PASS" } else { "FAIL" }, name);
                        }
                    }
                    if report.checks.values().all(|ok| *ok) {
                        ExitCode::SUCCESS
                    } else {
                        ExitCode::from(1)
                    }
                }
                Err(err) => {
                    eprintln!("mine_replays qa fixture: {err}");
                    ExitCode::from(1)
                }
            }
        }
    }
}

fn run_pack_command(root: &DataRoot, action: Option<PackAction>) -> ExitCode {
    let Some(action) = action else {
        eprintln!("mine_replays pack: choose `assemble`, `fixture`, `publish` or `report`");
        return ExitCode::from(2);
    };
    match action {
        PackAction::Assemble {
            pack,
            queue,
            licence,
            attribution,
            max_bytes,
            max_scenarios,
            max_per_base,
            share,
            max_variants,
            no_variants,
            min_bases_per_lesson,
            unique_hands,
            family_quota,
            generated_at,
            commit,
            dry_run,
            json,
        } => run_pack_assemble(
            root,
            AssemblyCommand {
                pack,
                queue,
                licence,
                attribution,
                max_bytes,
                max_scenarios,
                max_per_base,
                share,
                max_variants,
                no_variants,
                min_bases_per_lesson,
                unique_hands,
                family_quota,
                generated_at,
                commit,
                dry_run,
                json,
            },
        ),
        PackAction::Fixture {
            out,
            max_bytes,
            generated_at,
            json,
        } => run_pack_fixture(root, out, max_bytes, generated_at, json),
        PackAction::Publish {
            from,
            to,
            packs,
            max_total_bytes,
            updated_at,
            commercial,
            dry_run,
            json,
        } => run_pack_publish(
            root,
            PublishCommand {
                from,
                to,
                packs,
                max_total_bytes,
                updated_at,
                commercial,
                dry_run,
                json,
            },
        ),
        PackAction::Report { manifest, json } => run_pack_report(root, manifest, json),
    }
}

struct AssemblyCommand {
    pack: Option<String>,
    queue: Option<PathBuf>,
    licence: Option<String>,
    attribution: Option<String>,
    max_bytes: Option<u64>,
    max_scenarios: Option<usize>,
    max_per_base: Option<usize>,
    share: Option<f32>,
    max_variants: Option<usize>,
    no_variants: bool,
    min_bases_per_lesson: Option<usize>,
    unique_hands: bool,
    family_quota: Vec<String>,
    generated_at: Option<String>,
    commit: String,
    dry_run: bool,
    json: bool,
}

fn run_pack_assemble(root: &DataRoot, command: AssemblyCommand) -> ExitCode {
    let quotas = match AssemblyLimits::parse_family_quotas(&command.family_quota) {
        Ok(quotas) => quotas,
        Err(message) => {
            eprintln!("mine_replays pack assemble: {message}");
            return ExitCode::from(2);
        }
    };
    let mut budget = PackBudget::default();
    if let Some(max_bytes) = command.max_bytes {
        budget.max_bytes = max_bytes;
    }
    if let Some(max_scenarios) = command.max_scenarios {
        budget.max_scenarios = max_scenarios;
    }
    let mut limits = AssemblyLimits::default();
    if let Some(max_per_base) = command.max_per_base {
        limits.max_per_base = max_per_base;
    }
    if let Some(share) = command.share {
        limits.max_pack_share = share;
    }
    limits.max_variants = command.max_variants;
    limits.variants_disabled = command.no_variants;
    if let Some(minimum) = command.min_bases_per_lesson {
        limits.min_bases_per_lesson = minimum;
    }
    limits.unique_actor_hands = command.unique_hands;
    limits.family_quotas = quotas;
    let options = AssemblyOptions {
        pack_id: command.pack,
        queue: command.queue,
        licence: command.licence,
        attribution: command.attribution,
        commit: command.commit,
        generated_at: command.generated_at,
        limits,
        budget,
        dry_run: command.dry_run,
    };
    match run_assembly(root, &options) {
        Ok(outcome) => {
            if command.json {
                match serde_json::to_string_pretty(&outcome.report) {
                    Ok(text) => println!("{text}"),
                    Err(err) => {
                        eprintln!("mine_replays pack assemble: cannot serialise the report: {err}");
                        return ExitCode::from(2);
                    }
                }
            } else {
                println!("{}", outcome.report.human_summary());
                if let Some(published) = &outcome.published {
                    println!("  pack: {}", published.path.display());
                    println!("  manifest: {}", published.manifest_path.display());
                }
                if let Some(path) = &outcome.report_path {
                    println!("  report: {}", path.display());
                }
            }
            if outcome.written && !outcome.report.audit_clean {
                ExitCode::from(1)
            } else {
                ExitCode::SUCCESS
            }
        }
        Err(PackError::AuditFailed(audit)) => {
            eprintln!("mine_replays pack assemble: the pack failed its own audit");
            print_pack_findings(&audit);
            ExitCode::from(1)
        }
        Err(err) => {
            eprintln!("mine_replays pack assemble: {err}");
            ExitCode::from(2)
        }
    }
}

fn run_pack_fixture(
    root: &DataRoot,
    out: Option<PathBuf>,
    max_bytes: Option<u64>,
    generated_at: Option<String>,
    json: bool,
) -> ExitCode {
    let dir = out.unwrap_or_else(|| root.packs_dir());
    let budget = max_bytes.map_or_else(PackBudget::default, PackBudget::with_max_bytes);
    let now = generated_at.unwrap_or_else(|| utc_iso8601(SystemTime::now()));
    let pack = match fixture_pack(&now) {
        Ok(pack) => pack,
        Err(err) => {
            eprintln!("mine_replays pack fixture: {err}");
            return ExitCode::from(2);
        }
    };
    let games = fixture_games();
    let context = PackAuditContext::new(&games).with_budget(budget);

    // The audit reads the provenance source; write it before publishing so the
    // command leaves a directory that `audit` can re-check on its own.
    if let Err(err) = write_games_atomic(&dir, &games) {
        eprintln!("mine_replays pack fixture: {err}");
        return ExitCode::from(2);
    }
    match publish_pack(&dir, &pack, &context, &now) {
        Ok(published) => {
            let report = pack_report(&pack, published.entry.bytes, &budget);
            if json {
                let payload = serde_json::json!({
                    "path": published.path.display().to_string(),
                    "manifest": published.manifest_path.display().to_string(),
                    "games": dir.join(GAMES_FILE_NAME).display().to_string(),
                    "entry": published.entry,
                    "report": report,
                });
                match serde_json::to_string_pretty(&payload) {
                    Ok(text) => println!("{text}"),
                    Err(err) => {
                        eprintln!("mine_replays pack fixture: cannot serialise the report: {err}");
                        return ExitCode::from(2);
                    }
                }
            } else {
                println!(
                    "mine_replays pack fixture: wrote {} ({} bytes)",
                    published.path.display(),
                    published.entry.bytes
                );
                for line in render_pack_report(&report) {
                    println!("  {line}");
                }
                println!("  manifest: {}", published.manifest_path.display());
                println!("  provenance: {}", dir.join(GAMES_FILE_NAME).display());
            }
            ExitCode::SUCCESS
        }
        Err(PackError::AuditFailed(audit)) => {
            eprintln!("mine_replays pack fixture: the fixture pack failed its own audit");
            print_pack_findings(&audit);
            ExitCode::from(1)
        }
        Err(err) => {
            eprintln!("mine_replays pack fixture: {err}");
            ExitCode::from(2)
        }
    }
}

struct PublishCommand {
    from: Option<PathBuf>,
    to: PathBuf,
    packs: Vec<String>,
    max_total_bytes: Option<u64>,
    updated_at: Option<String>,
    commercial: bool,
    dry_run: bool,
    json: bool,
}

fn run_pack_publish(root: &DataRoot, command: PublishCommand) -> ExitCode {
    let mut options = HostOptions::new(
        command.from.unwrap_or_else(|| root.packs_dir()),
        command.to,
        command
            .updated_at
            .unwrap_or_else(|| utc_iso8601(SystemTime::now())),
    );
    let mut packs = Vec::with_capacity(command.packs.len());
    for raw in &command.packs {
        match PackId::parse(raw) {
            Ok(id) => packs.push(id),
            Err(err) => {
                eprintln!("mine_replays pack publish: {err}");
                return ExitCode::from(2);
            }
        }
    }
    options.packs = packs;
    options.profile = if command.commercial {
        PublishProfile::Commercial
    } else {
        PublishProfile::NonCommercial
    };
    options.budget.max_total_bytes = command.max_total_bytes.unwrap_or(DEFAULT_MAX_HOSTED_BYTES);
    options.dry_run = command.dry_run;

    match publish_hosted(&options) {
        Ok(published) => {
            if command.json {
                let payload = serde_json::json!({
                    "report": published.report,
                    "manifest": published.manifest_path.display().to_string(),
                    "bodies": published
                        .paths
                        .iter()
                        .map(|path| path.display().to_string())
                        .collect::<Vec<_>>(),
                });
                match serde_json::to_string_pretty(&payload) {
                    Ok(text) => println!("{text}"),
                    Err(err) => {
                        eprintln!("mine_replays pack publish: cannot serialise the report: {err}");
                        return ExitCode::from(2);
                    }
                }
            } else {
                for line in published.report.human_summary() {
                    println!("{line}");
                }
                println!("  manifest: {}", published.manifest_path.display());
            }
            ExitCode::SUCCESS
        }
        Err(
            error @ (PackError::HostRefused { .. }
            | PackError::HostBudgetExceeded { .. }
            | PackError::HostInvalid { .. }
            | PackError::AuditFailed(_)
            | PackError::MissingFile(_)),
        ) => {
            eprintln!("mine_replays pack publish: {error}");
            if let PackError::AuditFailed(audit) = &error {
                print_pack_findings(audit);
            }
            ExitCode::from(1)
        }
        Err(err) => {
            eprintln!("mine_replays pack publish: {err}");
            ExitCode::from(2)
        }
    }
}

fn run_pack_report(root: &DataRoot, manifest: Option<PathBuf>, json: bool) -> ExitCode {
    let path = manifest.unwrap_or_else(|| root.packs_dir().join(MANIFEST_FILE_NAME));
    let manifest = match load_manifest(&path) {
        Ok(manifest) => manifest,
        Err(err) => {
            eprintln!("mine_replays pack report: {err}");
            return ExitCode::from(2);
        }
    };
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let budget = PackBudget::default();
    let mut reports = Vec::new();
    let mut errors = 0usize;
    for entry in &manifest.packs {
        let pack_path = dir.join(&entry.path);
        match read_pack(&pack_path) {
            Ok(pack) => reports.push(pack_report(&pack, entry.bytes, &budget)),
            Err(err) => {
                eprintln!("mine_replays pack report: {err}");
                errors += 1;
            }
        }
    }
    if json {
        let payload = serde_json::json!({
            "manifest": path.display().to_string(),
            "packs": reports,
        });
        match serde_json::to_string_pretty(&payload) {
            Ok(text) => println!("{text}"),
            Err(err) => {
                eprintln!("mine_replays pack report: cannot serialise the report: {err}");
                return ExitCode::from(2);
            }
        }
    } else if reports.is_empty() {
        println!(
            "mine_replays pack report: {} lists no packs",
            path.display()
        );
    } else {
        for report in &reports {
            for line in render_pack_report(report) {
                println!("{line}");
            }
        }
    }
    if errors > 0 {
        ExitCode::from(1)
    } else {
        ExitCode::SUCCESS
    }
}

fn run_audit_command(
    root: &DataRoot,
    manifest: Option<PathBuf>,
    games: Option<PathBuf>,
    strict: bool,
    commercial: bool,
    json: bool,
) -> ExitCode {
    let path = manifest.unwrap_or_else(|| root.packs_dir().join(MANIFEST_FILE_NAME));
    let dir = path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf();
    let options = AuditOptions {
        profile: if commercial {
            PublishProfile::Commercial
        } else {
            PublishProfile::NonCommercial
        },
        strict,
        budget: PackBudget::default(),
    };
    let report = match audit_pack_dir(&dir, games.as_deref(), &options) {
        Ok(report) => report,
        Err(err) => {
            eprintln!("mine_replays audit: {err}");
            return ExitCode::from(2);
        }
    };

    if json {
        match serde_json::to_string_pretty(&report) {
            Ok(text) => println!("{text}"),
            Err(err) => {
                eprintln!("mine_replays audit: cannot serialise the report: {err}");
                return ExitCode::from(2);
            }
        }
    } else {
        println!(
            "mine_replays audit: {} ({} bytes manifest, {} pack(s){})",
            report.manifest,
            report.manifest_bytes,
            report.packs.len(),
            if report.strict { ", strict" } else { "" }
        );
        for finding in &report.findings {
            print_finding(finding);
        }
        for audit in &report.packs {
            print_pack_findings(audit);
        }
        let failures = report.failures().len();
        if failures == 0 {
            println!("  clean");
        } else {
            println!("  {failures} failure(s)");
        }
    }

    if report.is_clean() {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}

fn print_pack_findings(audit: &PackAudit) {
    if audit.findings.is_empty() {
        println!("  {}", audit_summary(audit));
        return;
    }
    println!("  {}", audit_summary(audit));
    for finding in &audit.findings {
        print_finding(finding);
    }
}

fn print_finding(finding: &PackFinding) {
    let severity = match finding.severity {
        riichiprac::miner::FindingSeverity::Error => "error",
        riichiprac::miner::FindingSeverity::Warning => "warning",
    };
    let code: PackFindingCode = finding.code;
    match &finding.scenario {
        Some(scenario) => eprintln!("    {severity} [{code:?}] {scenario}: {}", finding.detail),
        None => eprintln!("    {severity} [{code:?}] {}", finding.detail),
    }
}

fn utc_stamp_now() -> String {
    riichiprac::miner::utc_stamp(std::time::SystemTime::now())
}

fn run_transform_command(
    root: &DataRoot,
    options: &VariantRunOptions,
    weights: Option<PathBuf>,
    json: bool,
) -> ExitCode {
    let connection = match open_miner_db(root) {
        Ok(connection) => connection,
        Err(err) => {
            eprintln!("mine_replays transform: {err}");
            return ExitCode::from(2);
        }
    };
    let loaded = match &weights {
        Some(path) => match Labeler::load(path, None, None) {
            Ok(labeler) => Some(labeler),
            Err(err) => {
                eprintln!("mine_replays transform: {err}");
                return ExitCode::from(2);
            }
        },
        None => None,
    };
    let db = riichiprac::miner::SharedDb::new(connection);
    let labeler = loaded.as_ref().map(|evaluator| VariantLabeler {
        evaluator,
        db: &db,
        options: Default::default(),
    });
    match run_variants(root, options, labeler.as_ref()) {
        Ok(outcome) if json => {
            match serde_json::to_string_pretty(&outcome.report) {
                Ok(text) => println!("{text}"),
                Err(err) => {
                    eprintln!("mine_replays transform: cannot serialise the report: {err}");
                    return ExitCode::from(2);
                }
            }
            transform_exit_code(&outcome.report)
        }
        Ok(outcome) => {
            for line in outcome.report.human_summary() {
                println!("{line}");
            }
            println!("  variants: {}", outcome.paths.variants.display());
            println!("  rejected: {}", outcome.paths.rejected.display());
            println!("  report: {}", outcome.paths.report.display());
            if let Some(published) = &outcome.published {
                println!(
                    "  pack: {} ({} bytes)",
                    published.path.display(),
                    published.entry.bytes
                );
                println!("  manifest: {}", published.manifest_path.display());
            }
            transform_exit_code(&outcome.report)
        }
        Err(err) => {
            eprintln!("mine_replays transform: {err}");
            ExitCode::from(2)
        }
    }
}

fn transform_exit_code(report: &riichiprac::miner::variant::VariantReport) -> ExitCode {
    if report.is_clean() {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}

fn parse_family_caps(
    raw: &[String],
    target: &mut std::collections::BTreeMap<String, usize>,
) -> Result<(), String> {
    for entry in raw {
        let Some((family, cap)) = entry.split_once('=') else {
            return Err(format!("`{entry}` is not `family=cap`"));
        };
        if family.trim().is_empty() {
            return Err(format!("`{entry}` has a blank family"));
        }
        let cap: usize = cap
            .trim()
            .parse()
            .map_err(|_| format!("`{entry}` has a non-numeric cap"))?;
        if cap == 0 {
            return Err(format!("`{entry}` must have a cap of at least one"));
        }
        target.insert(family.trim().to_string(), cap);
    }
    Ok(())
}

fn run_select_command(root: &DataRoot, options: &SelectionOptions, json: bool) -> ExitCode {
    match run_selection(root, options) {
        Ok(outcome) if json => {
            match serde_json::to_string_pretty(&outcome.report) {
                Ok(text) => println!("{text}"),
                Err(err) => {
                    eprintln!("mine_replays select: cannot serialise the report: {err}");
                    return ExitCode::from(2);
                }
            }
            selection_exit_code(&outcome.report)
        }
        Ok(outcome) => {
            println!("{}", outcome.report.human_summary());
            selection_exit_code(&outcome.report)
        }
        Err(err) => {
            eprintln!("mine_replays select: {err}");
            ExitCode::from(2)
        }
    }
}

fn selection_exit_code(report: &riichiprac::miner::SelectionReport) -> ExitCode {
    if report.replays_failed > 0 || !report.errors.is_empty() {
        ExitCode::from(1)
    } else {
        ExitCode::SUCCESS
    }
}

#[allow(clippy::too_many_arguments)]
fn run_review_command(
    root: &DataRoot,
    queue: Option<PathBuf>,
    pack: Option<String>,
    held_out: bool,
    accept: &[String],
    reject: &[String],
    note: Option<String>,
    list: bool,
    show: Option<String>,
    dry_run: bool,
    json: bool,
) -> ExitCode {
    let path = match resolve_queue(root, queue, pack, held_out) {
        Ok(path) => path,
        Err(message) => {
            eprintln!("mine_replays review: {message}");
            return ExitCode::from(2);
        }
    };
    if let Some(id) = show {
        return match read_queue(&path) {
            Ok(queue) => match queue.items.iter().find(|item| item.queue_id == id) {
                Some(item) => match serde_json::to_string_pretty(&item.review) {
                    Ok(text) => {
                        println!("{text}");
                        ExitCode::SUCCESS
                    }
                    Err(err) => {
                        eprintln!("mine_replays review: cannot serialise the report: {err}");
                        ExitCode::from(2)
                    }
                },
                None => {
                    eprintln!("mine_replays review: `{id}` is not in {}", path.display());
                    ExitCode::from(2)
                }
            },
            Err(err) => {
                eprintln!("mine_replays review: {err}");
                ExitCode::from(2)
            }
        };
    }
    let report = match review_queue(&ReviewOptions {
        queue: path,
        accept: accept.to_vec(),
        reject: reject.to_vec(),
        note,
        dry_run,
    }) {
        Ok(report) => report,
        Err(err) => {
            eprintln!("mine_replays review: {err}");
            return ExitCode::from(2);
        }
    };
    if json {
        match serde_json::to_string_pretty(&report) {
            Ok(text) => println!("{text}"),
            Err(err) => {
                eprintln!("mine_replays review: cannot serialise the report: {err}");
                return ExitCode::from(2);
            }
        }
    } else {
        print!("{}", report.human_summary(list));
    }
    if report.invalid > 0 {
        ExitCode::from(1)
    } else {
        ExitCode::SUCCESS
    }
}

fn resolve_queue(
    root: &DataRoot,
    queue: Option<PathBuf>,
    pack: Option<String>,
    held_out: bool,
) -> Result<PathBuf, String> {
    if let Some(path) = queue {
        return Ok(path);
    }
    let pack = match pack {
        Some(pack) => pack,
        None => latest_pack(root)
            .map_err(|err| err.to_string())?
            .ok_or_else(|| {
                "no selection run found; run `select` first or pass --queue/--pack".to_string()
            })?,
    };
    let paths = selection_paths(root, &pack);
    Ok(if held_out {
        paths.held_out
    } else {
        paths.queue
    })
}

fn run_extract_command(root: &DataRoot, options: &ExtractOptions, json: bool) -> ExitCode {
    match run_extraction(root, options) {
        Ok(report) if json => {
            match serde_json::to_string_pretty(&report) {
                Ok(text) => println!("{text}"),
                Err(err) => {
                    eprintln!("mine_replays extract: cannot serialise the report: {err}");
                    return ExitCode::from(2);
                }
            }
            extract_exit_code(&report)
        }
        Ok(report) => {
            print!("{}", report.human_summary());
            extract_exit_code(&report)
        }
        Err(err) => {
            eprintln!("mine_replays extract: {err}");
            ExitCode::from(2)
        }
    }
}

fn extract_exit_code(report: &ExtractReport) -> ExitCode {
    if report.replays_failed > 0 || !report.errors.is_empty() {
        ExitCode::from(1)
    } else {
        ExitCode::SUCCESS
    }
}

fn run_label_command(root: &DataRoot, options: &LabelRunOptions, json: bool) -> ExitCode {
    match run_label(root, options) {
        Ok(report) if json => {
            match serde_json::to_string_pretty(&report) {
                Ok(text) => println!("{text}"),
                Err(err) => {
                    eprintln!("mine_replays label: cannot serialise the report: {err}");
                    return ExitCode::from(2);
                }
            }
            label_exit_code(&report)
        }
        Ok(report) => {
            println!(
                "mine_replays label: {} replay(s) ({} walked, {} failed), {} decisions \
                 ({} labelled, {} cached, {} retried, {} failed) in {} ms on {} worker thread(s)",
                report.replays_found,
                report.replays_walked,
                report.replays_failed,
                report.decisions_seen,
                report.decisions_labelled,
                report.decisions_cached,
                report.decisions_retried,
                report.decisions_failed,
                report.wall_time_ms,
                report.workers
            );
            println!(
                "  model: {} (sha256 {}), classifier {}",
                report.model, report.model_sha256, report.classifier_version
            );
            if report.labelers.len() > 1 {
                println!("  multi-model votes: {}", report.labelers.join(", "));
            }
            if let Some(calibration) = &report.calibration {
                println!("  Q->point calibration: {calibration}");
            }
            println!(
                "  book labels: {} ({} stable, {} contested); mortal-only: {}; \
                 unresolved conflicts: {}; walker drops: {}",
                report.book_labels,
                report.stable,
                report.contested,
                report.mortal_only,
                report.book_conflicts,
                report.decisions_dropped
            );
            if report.decisions_triggered > 0 || report.decisions_filtered_out > 0 {
                let hits: Vec<String> = report
                    .trigger_hits
                    .iter()
                    .map(|(trigger, count)| format!("{trigger}={count}"))
                    .collect();
                println!(
                    "  triggers: {} decision(s) hit [{}]; {} filtered out before the model",
                    report.decisions_triggered,
                    hits.join(", "),
                    report.decisions_filtered_out
                );
            }
            for error in &report.errors {
                eprintln!("  error: {error}");
            }
            label_exit_code(&report)
        }
        Err(err) => {
            eprintln!("mine_replays label: {err}");
            ExitCode::from(2)
        }
    }
}

/// A run with failures is not a success: exit 1 so a script notices.
fn label_exit_code(report: &LabelRunReport) -> ExitCode {
    if report.replays_failed + report.decisions_failed > 0 {
        ExitCode::from(1)
    } else {
        ExitCode::SUCCESS
    }
}

fn run_triggers_command(root: &DataRoot, options: &TriggerSampleOptions, json: bool) -> ExitCode {
    match run_trigger_sample(root, options) {
        Ok(report) if json => {
            match serde_json::to_string_pretty(&report) {
                Ok(text) => println!("{text}"),
                Err(err) => {
                    eprintln!("mine_replays triggers: cannot serialise the report: {err}");
                    return ExitCode::from(2);
                }
            }
            trigger_exit_code(&report)
        }
        Ok(report) => {
            print!("{}", report.human_summary());
            trigger_exit_code(&report)
        }
        Err(err) => {
            eprintln!("mine_replays triggers: {err}");
            ExitCode::from(2)
        }
    }
}

fn trigger_exit_code(report: &TriggerSampleReport) -> ExitCode {
    if report.replays_failed > 0 {
        ExitCode::from(1)
    } else {
        ExitCode::SUCCESS
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    #[test]
    fn clap_definition_is_well_formed() {
        Cli::command().debug_assert();
    }

    #[test]
    fn every_f1_subcommand_parses() {
        for name in [
            "corpus",
            "ingest",
            "extract",
            "select",
            "transform",
            "triggers",
            "pack",
            "audit",
            "review",
        ] {
            let cli = Cli::try_parse_from(["mine_replays", name])
                .unwrap_or_else(|err| panic!("`{name}` must parse: {err}"));
            assert_eq!(cli.command.name(), name);
        }
    }

    #[test]
    fn label_requires_weights_and_parses_the_model_metadata() {
        assert!(
            Cli::try_parse_from(["mine_replays", "label"]).is_err(),
            "the miner never guesses a checkpoint"
        );
        let cli = Cli::try_parse_from([
            "mine_replays",
            "label",
            "--weights",
            "mortal_298k.safetensors",
            "--models",
            "other_a.safetensors,other_b.safetensors",
            "--calibration",
            "calibration.json",
            "--family",
            "mortal_mirror",
            "--limit",
            "5",
            "--gamma",
            "0.99",
            "--pts",
            "90,45,0,-135",
            "--trigger",
            "book,call",
            "--json",
        ])
        .expect("label parses");
        match cli.command {
            Command::Label {
                weights,
                models,
                calibration,
                family,
                limit,
                gamma,
                pts,
                trigger,
                json,
                ..
            } => {
                assert_eq!(weights, PathBuf::from("mortal_298k.safetensors"));
                assert_eq!(
                    models,
                    vec![
                        PathBuf::from("other_a.safetensors"),
                        PathBuf::from("other_b.safetensors")
                    ]
                );
                assert_eq!(calibration, Some(PathBuf::from("calibration.json")));
                assert_eq!(family.as_deref(), Some("mortal_mirror"));
                assert_eq!(limit, Some(5));
                assert_eq!(gamma, Some(0.99));
                assert_eq!(pts, Some(vec![90.0, 45.0, 0.0, -135.0]));
                assert_eq!(trigger, vec!["book".to_string(), "call".to_string()]);
                assert!(json);
            }
            other => panic!("expected the label command, got {other:?}"),
        }
    }

    #[test]
    fn the_trigger_report_command_parses_its_sample_options() {
        let cli = Cli::try_parse_from([
            "mine_replays",
            "triggers",
            "--replays",
            "/data/replays",
            "--family",
            "mortal_mirror",
            "--limit",
            "3",
            "--families",
            "book,table-read",
            "--dry-run",
            "--json",
        ])
        .expect("triggers parses");
        match cli.command {
            Command::Triggers {
                replays,
                family,
                limit,
                families,
                dry_run,
                json,
            } => {
                assert_eq!(replays, Some(PathBuf::from("/data/replays")));
                assert_eq!(family.as_deref(), Some("mortal_mirror"));
                assert_eq!(limit, Some(3));
                assert_eq!(families, vec!["book".to_string(), "table-read".to_string()]);
                assert!(dry_run);
                assert!(json);
            }
            other => panic!("expected the triggers command, got {other:?}"),
        }
    }

    #[test]
    fn a_single_model_label_run_has_no_extra_models_or_calibration() {
        let cli = Cli::try_parse_from([
            "mine_replays",
            "label",
            "--weights",
            "mortal_298k.safetensors",
        ])
        .expect("label parses");
        match cli.command {
            Command::Label {
                models,
                calibration,
                ..
            } => {
                assert!(models.is_empty(), "one checkpoint is the normal labeler");
                assert!(calibration.is_none());
            }
            other => panic!("expected the label command, got {other:?}"),
        }
    }

    #[test]
    fn corpus_report_and_global_data_dir_parse() {
        let cli = Cli::try_parse_from([
            "mine_replays",
            "--data-dir",
            "/tmp/riichiprac-data",
            "corpus",
            "report",
        ])
        .expect("corpus report parses");
        assert_eq!(cli.data_dir, Some(PathBuf::from("/tmp/riichiprac-data")));
        assert!(matches!(
            cli.command,
            Command::Corpus {
                action: Some(CorpusAction::Report)
            }
        ));
    }

    #[test]
    fn pack_and_audit_options_parse() {
        let cli = Cli::try_parse_from([
            "mine_replays",
            "pack",
            "fixture",
            "--out",
            "/tmp/riichiprac-packs",
            "--max-bytes",
            "1024",
            "--json",
        ])
        .expect("pack fixture parses");
        match cli.command {
            Command::Pack {
                action:
                    Some(PackAction::Fixture {
                        out,
                        max_bytes,
                        generated_at,
                        json,
                    }),
            } => {
                assert_eq!(out, Some(PathBuf::from("/tmp/riichiprac-packs")));
                assert_eq!(max_bytes, Some(1024));
                assert_eq!(generated_at, None);
                assert!(json);
            }
            other => panic!("expected pack fixture, got {other:?}"),
        }

        let cli = Cli::try_parse_from([
            "mine_replays",
            "pack",
            "report",
            "--manifest",
            "manifest.json",
            "--json",
        ])
        .expect("pack report parses");
        match cli.command {
            Command::Pack {
                action: Some(PackAction::Report { manifest, json }),
            } => {
                assert_eq!(manifest, Some(PathBuf::from("manifest.json")));
                assert!(json);
            }
            other => panic!("expected pack report, got {other:?}"),
        }

        let cli = Cli::try_parse_from([
            "mine_replays",
            "pack",
            "publish",
            "--from",
            "/tmp/riichiprac-packs",
            "--to",
            "frontend/public/scenarios",
            "--packs",
            "a.pack,b.pack",
            "--max-total-bytes",
            "2048",
            "--updated-at",
            "2026-11-17T00:00:00Z",
            "--dry-run",
            "--json",
        ])
        .expect("pack publish parses");
        match cli.command {
            Command::Pack {
                action:
                    Some(PackAction::Publish {
                        from,
                        to,
                        packs,
                        max_total_bytes,
                        updated_at,
                        commercial,
                        dry_run,
                        json,
                    }),
            } => {
                assert_eq!(from, Some(PathBuf::from("/tmp/riichiprac-packs")));
                assert_eq!(to, PathBuf::from("frontend/public/scenarios"));
                assert_eq!(packs, vec!["a.pack".to_string(), "b.pack".to_string()]);
                assert_eq!(max_total_bytes, Some(2048));
                assert_eq!(updated_at.as_deref(), Some("2026-11-17T00:00:00Z"));
                assert!(!commercial);
                assert!(dry_run);
                assert!(json);
            }
            other => panic!("expected pack publish, got {other:?}"),
        }

        let cli = Cli::try_parse_from([
            "mine_replays",
            "audit",
            "--manifest",
            "manifest.json",
            "--games",
            "games.jsonl",
            "--strict",
            "--commercial",
            "--json",
        ])
        .expect("audit parses");
        match cli.command {
            Command::Audit {
                manifest,
                games,
                strict,
                commercial,
                json,
            } => {
                assert_eq!(manifest, Some(PathBuf::from("manifest.json")));
                assert_eq!(games, Some(PathBuf::from("games.jsonl")));
                assert!(strict);
                assert!(commercial);
                assert!(json);
            }
            other => panic!("expected audit, got {other:?}"),
        }
    }

    #[test]
    fn the_select_command_parses_its_options() {
        let cli = Cli::try_parse_from([
            "mine_replays",
            "select",
            "--replays",
            "/data/replays",
            "--family",
            "mortal_mirror",
            "--limit",
            "3",
            "--pack-id",
            "s2-smoke",
            "--size",
            "40",
            "--held-out-share",
            "0.2",
            "--seed",
            "qa-a",
            "--section",
            "ch8",
            "--lesson",
            "fold_to_riichi",
            "--corpus-family",
            "mortal_mirror,akochan_tactics",
            "--corpus-cap",
            "akochan_tactics=25",
            "--max-per-replay",
            "2",
            "--extracted-only",
            "--stable-book-only",
            "--dry-run",
            "--json",
        ])
        .expect("select parses");
        match cli.command {
            Command::Select {
                replays,
                family,
                limit,
                pack_id,
                size,
                held_out_share,
                seed,
                section,
                lesson,
                corpus_family,
                corpus_cap,
                max_per_replay,
                extracted_only,
                stable_book_only,
                dry_run,
                json,
                ..
            } => {
                assert_eq!(replays, Some(PathBuf::from("/data/replays")));
                assert_eq!(family.as_deref(), Some("mortal_mirror"));
                assert_eq!(limit, Some(3));
                assert_eq!(pack_id.as_deref(), Some("s2-smoke"));
                assert_eq!(size, 40);
                assert_eq!(held_out_share, Some(0.2));
                assert_eq!(seed.as_deref(), Some("qa-a"));
                assert_eq!(section, vec!["ch8".to_string()]);
                assert_eq!(lesson, vec!["fold_to_riichi".to_string()]);
                assert_eq!(
                    corpus_family,
                    vec!["mortal_mirror".to_string(), "akochan_tactics".to_string()]
                );
                assert_eq!(corpus_cap, vec!["akochan_tactics=25".to_string()]);
                assert_eq!(max_per_replay, Some(2));
                assert!(extracted_only);
                assert!(stable_book_only);
                assert!(dry_run);
                assert!(json);
            }
            other => panic!("expected the select command, got {other:?}"),
        }
        let defaults = Cli::try_parse_from(["mine_replays", "select"]).expect("defaults parse");
        match defaults.command {
            Command::Select { size, .. } => assert_eq!(size, DEFAULT_PACK_SIZE),
            other => panic!("expected the select command, got {other:?}"),
        }
    }

    #[test]
    fn the_review_command_parses_its_options() {
        let cli = Cli::try_parse_from([
            "mine_replays",
            "review",
            "--pack",
            "s2-smoke",
            "--held-out",
            "--accept",
            "s2-smoke-001,s2-smoke-002",
            "--reject",
            "s2-smoke-003",
            "--note",
            "ambiguous",
            "--list",
        ])
        .expect("review parses");
        match cli.command {
            Command::Review {
                pack,
                held_out,
                accept,
                reject,
                note,
                list,
                ..
            } => {
                assert_eq!(pack.as_deref(), Some("s2-smoke"));
                assert!(held_out);
                assert_eq!(
                    accept,
                    vec!["s2-smoke-001".to_string(), "s2-smoke-002".to_string()]
                );
                assert_eq!(reject, vec!["s2-smoke-003".to_string()]);
                assert_eq!(note.as_deref(), Some("ambiguous"));
                assert!(list);
            }
            other => panic!("expected the review command, got {other:?}"),
        }
    }

    #[test]
    fn unknown_subcommand_is_rejected() {
        assert!(Cli::try_parse_from(["mine_replays", "frobnicate"]).is_err());
    }

    #[test]
    fn the_offline_stages_parse_their_worker_and_progress_flags() {
        let extract = Cli::try_parse_from([
            "mine_replays",
            "extract",
            "--workers",
            "14",
            "--progress",
            "--limit",
            "40",
            "--json",
        ])
        .expect("extract parses");
        match extract.command {
            Command::Extract {
                workers,
                progress,
                limit,
                ..
            } => {
                assert_eq!(workers, 14);
                assert!(progress);
                assert_eq!(limit, Some(40));
            }
            other => panic!("expected the extract command, got {other:?}"),
        }

        let label = Cli::try_parse_from([
            "mine_replays",
            "label",
            "--weights",
            "mortal_298k.safetensors",
            "--workers",
            "0",
            "--progress",
        ])
        .expect("label parses");
        match label.command {
            Command::Label {
                workers, progress, ..
            } => {
                assert_eq!(workers, 0, "0 is every available core");
                assert!(progress);
            }
            other => panic!("expected the label command, got {other:?}"),
        }

        let transform = Cli::try_parse_from([
            "mine_replays",
            "transform",
            "--rehearsal",
            "8",
            "--workers",
            "3",
            "--progress",
            "--json",
        ])
        .expect("transform parses");
        match transform.command {
            Command::Transform {
                workers, progress, ..
            } => {
                assert_eq!(workers, 3);
                assert!(progress);
            }
            other => panic!("expected the transform command, got {other:?}"),
        }

        // The default is the whole machine, not one thread.
        for name in ["extract", "transform"] {
            let cli = Cli::try_parse_from(["mine_replays", name]).expect("defaults parse");
            let workers = match cli.command {
                Command::Extract { workers, .. } | Command::Transform { workers, .. } => workers,
                other => panic!("expected `{name}`, got {other:?}"),
            };
            assert_eq!(workers, 0, "`{name}` defaults to every available core");
        }
        let cli = Cli::try_parse_from([
            "mine_replays",
            "label",
            "--weights",
            "mortal_298k.safetensors",
        ])
        .expect("label defaults parse");
        match cli.command {
            Command::Label { workers, .. } => {
                assert_eq!(workers, 0, "label defaults to every available core");
            }
            other => panic!("expected the label command, got {other:?}"),
        }
    }
}
