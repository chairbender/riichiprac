//! The `mine_replays transform` runner: load bases, run the stage, write results.
//!
//! Two sources feed the stage:
//!
//! - **a review queue** (the real pipeline): the latest `select` run's
//!   `review-queue.jsonl`, minus the held-out QA items and any item a reviewer
//!   rejected. Base labels and played actions come from the miner DB when it has
//!   them; a book base still runs without a checkpoint, while a Mortal base
//!   needs `--weights`.
//! - **a rehearsal** (`--rehearsal N`): `N` generated book puzzles, for the
//!   §4.7 acceptance evidence without a corpus.
//!
//! Outputs, under `$RIICHI_DATA_DIR/reviews/<pack-id>/variants/`:
//!
//! ```text
//! variant-report.json   riichiprac.variant-report v1 (the yield/caps/share report)
//! variants.jsonl        one gated PackScenario per line (review-side, answer-bearing)
//! rejected.jsonl        every attempted chain that did not ship, with its reason
//! ```
//!
//! With `--pack` the runner also assembles the base + gated variant pack and
//! publishes it through P1a (`publish_pack`), which re-runs the source/licence,
//! provenance, answer, spoiler and variant-honesty gate. The variant files are
//! review artifacts and are never published: they carry the answers.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, params};

use crate::miner::label::CLASSIFIER_VERSION;
use crate::miner::label::thresholds::{PercentileConfig, PercentileCuts};
use crate::miner::pack::{PackAuditContext, PackScenario, PublishedPack, publish_pack};
use crate::miner::provenance::{GameProvenance, ReplayId};
use crate::miner::select::review::{read_dispositions, read_queue};
use crate::miner::select::run::latest_pack;
use crate::miner::select::{DispositionVerdict, selection_paths};
use crate::miner::storage::{DataRoot, open_miner_db, utc_iso8601, utc_stamp, write_atomic};
use crate::miner::trigger::report::load_label;

use super::base::BaseScenario;
use super::gate::VariantLabeler;
use super::rehearsal::rehearsal_bases;
use super::report::VariantReport;
use super::stage::{
    PackAssembly, RejectedVariant, StageOutcome, VariantRecord, VariantStage, build_pack,
};
use super::{
    DEFAULT_TRANSFORM_SEED, VariantConfig, VariantError, VariantLabelKind, gate::GateDeps,
};

/// One variant run's inputs.
#[derive(Debug, Clone)]
pub struct VariantRunOptions {
    /// Review queue to read. `None` uses the latest `select` run's queue.
    pub queue: Option<PathBuf>,
    /// Build `N` generated book bases instead of reading a queue.
    pub rehearsal: Option<usize>,
    /// Pack id. Defaults to the queue's pack id, or a rehearsal stamp.
    pub pack_id: Option<String>,
    /// Volume and policy configuration.
    pub config: VariantConfig,
    /// Output directory. Defaults to the review directory's `variants/`.
    pub out: Option<PathBuf>,
    /// Pack/report timestamp. A fixed value keeps a reproducibility run's pack
    /// hash stable; `None` uses the wall clock.
    pub generated_at: Option<String>,
    /// Assemble and publish a pack through P1a.
    pub publish: bool,
    /// Write the bases and variants to the DB (queue runs only).
    pub persist: bool,
    /// Worker threads for the offline stage. `0` uses every available core; `1`
    /// is the bounded mode for tests, fixtures and debugging.
    pub workers: usize,
    /// Print base/attempt progress to stderr.
    pub progress: bool,
    /// Build and report without writing anything.
    pub dry_run: bool,
}

impl Default for VariantRunOptions {
    fn default() -> Self {
        Self {
            queue: None,
            rehearsal: None,
            pack_id: None,
            config: VariantConfig::default(),
            out: None,
            generated_at: None,
            publish: false,
            persist: true,
            workers: 0,
            progress: false,
            dry_run: false,
        }
    }
}

/// Where one variant run's files live.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VariantPaths {
    /// `reviews/<pack-id>/variants/`.
    pub dir: PathBuf,
    /// `variant-report.json`.
    pub report: PathBuf,
    /// `variants.jsonl`.
    pub variants: PathBuf,
    /// `rejected.jsonl`.
    pub rejected: PathBuf,
}

/// The paths for one pack id under a data root.
#[must_use]
pub fn variant_paths(root: &DataRoot, pack_id: &str) -> VariantPaths {
    let dir = selection_paths(root, pack_id).dir.join("variants");
    VariantPaths {
        report: dir.join("variant-report.json"),
        variants: dir.join("variants.jsonl"),
        rejected: dir.join("rejected.jsonl"),
        dir,
    }
}

/// What one variant run produced.
#[derive(Debug)]
pub struct VariantRunOutcome {
    /// The yield report.
    pub report: VariantReport,
    /// Bases the run consumed.
    pub bases: Vec<BaseScenario>,
    /// Shipped variants.
    pub variants: Vec<VariantRecord>,
    /// Attempted chains that did not ship.
    pub rejected: Vec<RejectedVariant>,
    /// The files (written unless `--dry-run`).
    pub paths: VariantPaths,
    /// Whether the files were written.
    pub written: bool,
    /// The published pack, when `--pack` ran.
    pub published: Option<PublishedPack>,
}

/// Run the transform stage.
pub fn run_variants(
    root: &DataRoot,
    options: &VariantRunOptions,
    labeler: Option<&VariantLabeler<'_>>,
) -> Result<VariantRunOutcome, VariantError> {
    options.config.validate()?;
    if options.rehearsal.is_some() && options.queue.is_some() {
        return Err(VariantError::Config(
            "choose a review queue or a rehearsal, not both".to_string(),
        ));
    }
    if options.publish && options.dry_run {
        return Err(VariantError::Config(
            "`--pack` and `--dry-run` cannot be combined".to_string(),
        ));
    }
    if options.persist && options.rehearsal.is_some() {
        return Err(VariantError::Config(
            "a rehearsal has no `decisions` rows to attach its variants to; persist is only for \
             queue runs"
                .to_string(),
        ));
    }

    let now = options
        .generated_at
        .clone()
        .unwrap_or_else(|| utc_iso8601(std::time::SystemTime::now()));
    let (bases, games, queue_note, default_pack_id, base_notes) = match options.rehearsal {
        Some(count) => {
            let rehearsal = rehearsal_bases(count)?;
            let mut note = format!(
                "rehearsal: {} generated book base(s), {} skipped draw(s); states are generated \
                 and no replay roundtrip is claimed",
                rehearsal.bases.len(),
                rehearsal.skipped.len()
            );
            for skipped in rehearsal.skipped.iter().take(5) {
                note.push_str(&format!("; {skipped}"));
            }
            (
                rehearsal.bases,
                Some(rehearsal.games),
                note,
                format!(
                    "variant-rehearsal-{}",
                    utc_stamp(std::time::SystemTime::now())
                ),
                Vec::new(),
            )
        }
        None => {
            let loaded = load_queue_bases(root, options.queue.as_deref())?;
            (
                loaded.bases,
                None,
                loaded.note,
                loaded.pack_id,
                loaded.errors,
            )
        }
    };
    if bases.is_empty() {
        return Err(VariantError::MissingQueue(
            "no base scenario could be loaded".to_string(),
        ));
    }
    let pack_id = options.pack_id.clone().unwrap_or(default_pack_id);

    let started = std::time::Instant::now();
    let cuts = cuts_for(&bases)?;
    let stage = VariantStage {
        config: &options.config,
        deps: GateDeps {
            labeler,
            cuts: &cuts,
            classifier_version: CLASSIFIER_VERSION,
        },
        pack_id: pack_id.clone(),
        generated_at: now.clone(),
    };
    let mut outcome = stage.run_with(&bases, options.workers, options.progress)?;
    outcome.report.wall_time_ms = crate::miner::parallel::elapsed_ms(started);
    let mut report = outcome.report;
    report.notes.push(queue_note);
    for error in base_notes {
        report.notes.push(format!("unusable base: {error}"));
    }
    if labeler.is_none()
        && bases.iter().any(|base| {
            matches!(
                base.label.kind,
                VariantLabelKind::Mortal | VariantLabelKind::Contested
            )
        })
    {
        report.notes.push(
            "no checkpoint supplied: Mortal-only and contested bases cannot be label-verified, so              their transform pairs are rejected and disabled by yield"
                .to_string(),
        );
    }

    // The rehearsal carries its own fixture games; a queue run reads the
    // provenance rows it references, and only when it needs them (to publish).
    let games = match games {
        Some(games) => games,
        None if options.publish => {
            let connection = open_miner_db(root)?;
            games_from_db(&connection, &bases)?
        }
        None => Vec::new(),
    };
    if options.persist {
        let connection = open_miner_db(root)?;
        crate::miner::variant::persist::store_variants(
            &connection,
            &pack_id,
            &bases,
            &outcome.variants,
            &outcome.rejected,
            &utc_stamp(std::time::SystemTime::now()),
        )?;
    }

    let paths = options
        .out
        .clone()
        .map(|dir| VariantPaths {
            report: dir.join("variant-report.json"),
            variants: dir.join("variants.jsonl"),
            rejected: dir.join("rejected.jsonl"),
            dir,
        })
        .unwrap_or_else(|| variant_paths(root, &pack_id));

    let mut published = None;
    if options.publish {
        let (licence, attribution) = publish_copy(options.rehearsal.is_some(), &options.config)?;
        let pack = build_pack(&PackAssembly {
            pack_id: &pack_id,
            generated_at: &now,
            licence,
            attribution,
            bases: &bases,
            variants: &outcome.variants,
            games: &games,
        })?;
        if !options.dry_run {
            let dir = root.packs_dir();
            write_games_merged(&dir, &games)?;
            let context = PackAuditContext::new(&games);
            published = Some(publish_pack(&dir, &pack, &context, &now)?);
            report.notes.push(format!(
                "published pack `{pack_id}` through the P1a gate ({} scenario(s))",
                pack.scenarios.len()
            ));
        }
    }

    let mut outcome = VariantRunOutcome {
        report,
        bases,
        variants: outcome.variants,
        rejected: outcome.rejected,
        paths,
        written: false,
        published,
    };
    if !options.dry_run {
        write_outputs(&outcome)?;
        outcome.written = true;
    }
    Ok(outcome)
}

/// The bases one queue load produced.
struct LoadedQueue {
    bases: Vec<BaseScenario>,
    note: String,
    pack_id: String,
    errors: Vec<String>,
}

/// Load the selected review-queue items as bases.
fn load_queue_bases(root: &DataRoot, queue: Option<&Path>) -> Result<LoadedQueue, VariantError> {
    let path = match queue {
        Some(path) => path.to_path_buf(),
        None => {
            let pack = latest_pack(root)
                .map_err(|err| VariantError::Selection(err.to_string()))?
                .ok_or_else(|| {
                    VariantError::MissingQueue(
                        "no `select` run found; run `mine_replays select` or pass `--queue`"
                            .to_string(),
                    )
                })?;
            selection_paths(root, &pack).queue
        }
    };
    if !path.exists() {
        return Err(VariantError::MissingQueue(path.display().to_string()));
    }
    let queue = read_queue(&path).map_err(|err| VariantError::Selection(err.to_string()))?;
    let pack_id = queue
        .items
        .first()
        .map(|item| item.pack_id.clone())
        .ok_or_else(|| {
            VariantError::MissingQueue(format!("`{}` holds no queue item", path.display()))
        })?;
    let dispositions = read_dispositions(&queue.dispositions_path())
        .map_err(|err| VariantError::Selection(err.to_string()))?;
    let latest: BTreeMap<&str, DispositionVerdict> = dispositions
        .iter()
        .map(|disposition| (disposition.queue_id.as_str(), disposition.verdict))
        .collect();

    let connection = open_miner_db(root)?;
    let mut bases = Vec::new();
    let mut held_out = 0_usize;
    let mut rejected = 0_usize;
    let mut errors = Vec::new();
    for item in &queue.items {
        if item.held_out {
            held_out += 1;
            continue;
        }
        if latest.get(item.queue_id.as_str()) == Some(&DispositionVerdict::Rejected) {
            rejected += 1;
            continue;
        }
        let label = load_label(&connection, &item.decision_id, &item.exact_hash)
            .map_err(|err| VariantError::Selection(err.to_string()))?;
        let played = played_action(&connection, &item.decision_id)?;
        match BaseScenario::from_review_item(item, label.as_ref(), played.as_deref()) {
            Ok(base) => bases.push(base),
            Err(err) => {
                if errors.len() < 32 {
                    errors.push(format!("{}: {err}", item.queue_id));
                }
            }
        }
    }
    let note = format!(
        "queue: {} base(s) from `{}`; {held_out} held-out item(s) skipped; \
         {rejected} reviewer-rejected item(s) skipped; {} unusable item(s)",
        bases.len(),
        path.display(),
        errors.len()
    );
    Ok(LoadedQueue {
        bases,
        note,
        pack_id,
        errors,
    })
}

fn played_action(
    connection: &Connection,
    decision_id: &str,
) -> Result<Option<String>, VariantError> {
    let value: Option<String> = connection
        .query_row(
            "SELECT played_action FROM decisions WHERE decision_id = ?1",
            params![decision_id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(value)
}

/// The per-family percentile cuts the Mortal band check uses.
fn cuts_for(bases: &[BaseScenario]) -> Result<PercentileCuts, VariantError> {
    let mut samples: BTreeMap<String, Vec<f32>> = BTreeMap::new();
    for base in bases {
        if base.label.kind != VariantLabelKind::Mortal {
            continue;
        }
        let (Some(family), Some(gap)) =
            (base.label.decision_family.as_ref(), base.label.top2_gap())
        else {
            continue;
        };
        samples.entry(family.clone()).or_default().push(gap);
    }
    PercentileCuts::build(&PercentileConfig::default(), &samples)
        .map_err(|err| VariantError::Config(err.to_string()))
}

/// The provenance rows a published pack references, read from the DB.
fn games_from_db(
    connection: &Connection,
    bases: &[BaseScenario],
) -> Result<Vec<GameProvenance>, VariantError> {
    let ids: BTreeSet<&ReplayId> = bases
        .iter()
        .map(|base| &base.scenario.provenance.replay_id)
        .collect();
    let mut games = Vec::with_capacity(ids.len());
    for id in ids {
        let json: Option<String> = connection
            .query_row(
                "SELECT provenance_json FROM replays WHERE replay_id = ?1",
                params![id.as_str()],
                |row| row.get(0),
            )
            .optional()?;
        let json = json.ok_or_else(|| VariantError::Base {
            id: id.as_str().to_string(),
            detail: "no `replays` provenance row for this base's replay; cannot publish a \
                         pack the P1a source gate cannot audit"
                .to_string(),
        })?;
        let game: GameProvenance = serde_json::from_str(&json)?;
        game.validate().map_err(|err| VariantError::Base {
            id: id.as_str().to_string(),
            detail: format!("invalid replay provenance: {err}"),
        })?;
        games.push(game);
    }
    Ok(games)
}

fn publish_copy(rehearsal: bool, config: &VariantConfig) -> Result<(&str, &str), VariantError> {
    match (config.licence.as_deref(), config.attribution.as_deref()) {
        (Some(licence), Some(attribution)) => Ok((licence, attribution)),
        _ if rehearsal => Ok((
            "CC-BY-4.0",
            "Rehearsal pack generated by the riichiprac miner from seeded lesson puzzles. \
             Fixture provenance uses Mortal 298k (AGPL-3.0) and the riichiprac reference \
             heuristics (MIT). Pack data CC BY 4.0.",
        )),
        _ => Err(VariantError::Config(
            "`--pack` on a real queue needs a data licence and attribution in the variant \
             config (`licence`, `attribution`); the stage will not invent them"
                .to_string(),
        )),
    }
}

fn write_games_merged(dir: &Path, games: &[GameProvenance]) -> Result<(), VariantError> {
    crate::miner::pack::merge_games(dir, games).map_err(VariantError::Pack)?;
    Ok(())
}

fn write_outputs(outcome: &VariantRunOutcome) -> Result<(), VariantError> {
    std::fs::create_dir_all(&outcome.paths.dir)
        .map_err(|source| VariantError::io(outcome.paths.dir.display(), source))?;
    let variants = jsonl(
        outcome
            .variants
            .iter()
            .map(|record| &record.scenario)
            .collect::<Vec<&PackScenario>>(),
    )?;
    write_atomic(&outcome.paths.variants, variants.as_bytes())?;
    let rejected = jsonl(outcome.rejected.iter().collect::<Vec<_>>())?;
    write_atomic(&outcome.paths.rejected, rejected.as_bytes())?;
    let report = serde_json::to_string_pretty(&outcome.report)
        .map_err(|err| VariantError::Report(err.to_string()))?;
    write_atomic(&outcome.paths.report, report.as_bytes())?;
    Ok(())
}

fn jsonl<T: serde::Serialize>(items: Vec<&T>) -> Result<String, VariantError> {
    let mut text = String::new();
    for item in items {
        text.push_str(&serde_json::to_string(item)?);
        text.push('\n');
    }
    Ok(text)
}

/// A report-only entry point for a caller that has bases in hand (tests and
/// P1b); it runs the stage and returns the report without I/O.
pub fn report_for(
    bases: &[BaseScenario],
    config: &VariantConfig,
    labeler: Option<&VariantLabeler<'_>>,
    pack_id: &str,
    generated_at: &str,
) -> Result<(VariantReport, Vec<VariantRecord>), VariantError> {
    let cuts = cuts_for(bases)?;
    let stage = VariantStage {
        config,
        deps: GateDeps {
            labeler,
            cuts: &cuts,
            classifier_version: CLASSIFIER_VERSION,
        },
        pack_id: pack_id.to_string(),
        generated_at: generated_at.to_string(),
    };
    let StageOutcome {
        report, variants, ..
    } = stage.run(bases)?;
    Ok((report, variants))
}

/// The default seed the CLI shows; a caller pinning a rehearsal uses it.
#[must_use]
pub const fn default_transform_seed() -> &'static str {
    DEFAULT_TRANSFORM_SEED
}
