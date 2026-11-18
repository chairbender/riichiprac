//! Entry point for the native-only replay miner.
//!
//! F1 created the feature boundary and the subcommand surface; L1 implements
//! `label` on top of the R2 walker and the F1 database, S1 implements `triggers`,
//! S2 implements `select` and `review`, V2 implements `transform`, and P1a/P1b
//! implement `pack fixture`, `pack assemble`, `pack report` and `audit`. The
//! remaining commands are still stubs: running one exits with code 2 and writes
//! a "not implemented" line to stderr, so a script cannot mistake it for a
//! completed run.
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

use riichiprac::miner::label::Labeler;
use riichiprac::miner::label::cache::LabelCache;
use riichiprac::miner::label::run::{LabelRunOptions, LabelRunReport, run_label};
use riichiprac::miner::variant::{
    DEFAULT_MAX_PER_BASE, DEFAULT_MIN_YIELD, DEFAULT_PACK_SHARE, DEFAULT_TRANSFORM_SEED,
    DEFAULT_VARIANTS_PER_BASE, VariantLabeler, VariantRunOptions, YieldPolicy, run_variants,
};
use riichiprac::miner::{
    AssemblyLimits, AssemblyOptions, AuditOptions, CLASSIFIER_VERSION, DEFAULT_GENERATOR_COMMIT,
    DEFAULT_PACK_SIZE, DataRoot, FamilyFilter, GAMES_FILE_NAME, MANIFEST_FILE_NAME, PackAudit,
    PackAuditContext, PackBudget, PackError, PackFinding, PackFindingCode, PublishProfile,
    QPointCalibration, ReviewOptions, SelectionConfig, SelectionOptions, TriggerConfig,
    TriggerFilter, TriggerSampleOptions, TriggerSampleReport, audit_pack_dir, audit_summary,
    fixture_games, fixture_pack, latest_pack, load_manifest, open_miner_db, pack_report,
    publish_pack, read_pack, read_queue, render_pack_report, review_queue, run_assembly,
    run_selection, run_trigger_sample, selection_paths, utc_iso8601, write_games_atomic,
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
    /// Reconstruct decision points from validated logs.
    Extract,
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

        /// Output directory (default: reviews/<pack-id>/variants).
        #[arg(long, value_name = "DIR")]
        out: Option<PathBuf>,

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
enum CorpusAction {
    /// Print one row per corpus family: counts, triggers, labels, shortfalls.
    Report,
}

impl Command {
    fn name(&self) -> &'static str {
        match self {
            Self::Corpus { .. } => "corpus",
            Self::Ingest => "ingest",
            Self::Extract => "extract",
            Self::Label { .. } => "label",
            Self::Triggers { .. } => "triggers",
            Self::Transform { .. } => "transform",
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
        Command::Label {
            weights,
            models,
            calibration,
            replays,
            family,
            limit,
            classifier_version,
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
            out,
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
                publish: pack,
                persist: rehearsal.is_none(),
                dry_run,
            };
            run_transform_command(&root, &options, weights, json)
        }
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
            dry_run,
            json,
        } => {
            let mut config = SelectionConfig {
                pack_size: size,
                ..SelectionConfig::default()
            };
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
                    config,
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

fn run_pack_command(root: &DataRoot, action: Option<PackAction>) -> ExitCode {
    let Some(action) = action else {
        eprintln!("mine_replays pack: choose `assemble`, `fixture` or `report`");
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
            json,
        } => run_pack_fixture(root, out, max_bytes, json),
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
    json: bool,
) -> ExitCode {
    let dir = out.unwrap_or_else(|| root.packs_dir());
    let budget = max_bytes.map_or_else(PackBudget::default, PackBudget::with_max_bytes);
    let now = utc_iso8601(SystemTime::now());
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
    let cache = LabelCache::new(&connection);
    let labeler = loaded.as_ref().map(|evaluator| VariantLabeler {
        evaluator,
        cache: &cache,
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
                "mine_replays label: {} replay(s) ({}, {} failed), {} decisions \
                 ({} labelled, {} cached, {} retried, {} failed)",
                report.replays_found,
                report.replays_walked,
                report.replays_failed,
                report.decisions_seen,
                report.decisions_labelled,
                report.decisions_cached,
                report.decisions_retried,
                report.decisions_failed
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
                        json,
                    }),
            } => {
                assert_eq!(out, Some(PathBuf::from("/tmp/riichiprac-packs")));
                assert_eq!(max_bytes, Some(1024));
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
                dry_run,
                json,
            } => {
                assert_eq!(replays, Some(PathBuf::from("/data/replays")));
                assert_eq!(family.as_deref(), Some("mortal_mirror"));
                assert_eq!(limit, Some(3));
                assert_eq!(pack_id.as_deref(), Some("s2-smoke"));
                assert_eq!(size, 40);
                assert_eq!(held_out_share, Some(0.2));
                assert_eq!(seed.as_deref(), Some("qa-a"));
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
}
