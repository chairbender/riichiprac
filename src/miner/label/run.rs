//! The `mine_replays label` shard runner (L1 on top of R2 and F1).
//!
//! Walks every gzipped mjai replay under `$RIICHI_DATA_DIR/replays/<family>/`,
//! turns each R2 decision into a Mortal label, and stores it in the F1 SQLite
//! database:
//!
//! - the `model_labels` cache, keyed by
//!   `(state_hash, model_sha256, classifier_version, options_hash)`, so a rerun
//!   skips finished states and retries only failures;
//! - the `decisions` row when `extract` has already created one for that
//!   `decision_id` (`mortal_*`, `q_values_json`, `labeler_*`, `label_json`).
//!   A missing row is not an error: L1 must run before extraction lands.
//!
//! The weights are loaded once per process ([`super::Labeler::load`]) and reused
//! for every state in the shard.
//!
//! # Parallelism
//!
//! The label pass is the most expensive offline stage, so it runs on every
//! available core by default (`--workers 0`, `AGENTS.md` §5b). Replay files are
//! the unit of work: each worker walks its own file and evaluates the model
//! outside the database lock, while the cache lookup and every write happen
//! under the stage's single connection lock (SQLite has one writer). The
//! per-file counters merge in file order, so the report is the same as a
//! `--workers 1` run of the same shard.
//!
//! Two decisions with the same model-visible state share **one** evaluation
//! ([`LabelFlight`]): the first claims the key, evaluates it and records it, and
//! every duplicate waits for that result and then reuses the cache row. That is
//! the serial run's behaviour, and it keeps the cached/labelled split of the
//! report independent of the worker count. A position that differs only in
//! something the model observation does not carry (the actor's permanent-furiten
//! flag, the replay's generator identity) keeps the first label recorded for its
//! state hash, exactly as a rerun does; with more than one worker the file that
//! claims such a shared state may differ from the serial order, so a corpus that
//! mixes those positions can record a different one of the two labels.
//!
//! `--progress` prints the measured file count, and the report records the
//! resolved worker count and the wall time.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex, PoisonError};
use std::time::Instant;

use rayon::prelude::*;
use rusqlite::{Connection, params};
use serde::Serialize;

use super::cache::{CacheClaim, LabelCache, LabelKey};
use super::calibration::QPointCalibration;
use super::{
    LabelDisposition, LabelError, LabelOptions, ModelIdentity, ModelLabel, StateEvaluator,
    build_label,
};
use crate::miner::parallel::{Progress, SharedDb, elapsed_ms, resolve_workers, worker_pool};
use crate::miner::storage::{DataRoot, open_miner_db};
use crate::miner::trigger::{
    TriggerConfig, TriggerFilter, TriggerReport, evaluate_cheap, record_triggers,
};

/// Only corpus replay files are walked; the R1 reader has its own decode bounds.
const REPLAY_SUFFIX: &str = ".jsonl.gz";

/// Keep the report readable: a broken corpus can fail thousands of times.
const MAX_ERRORS: usize = 100;

/// One `label` run's inputs.
#[derive(Debug, Clone)]
pub struct LabelRunOptions {
    /// Checkpoint to load. Required: the miner never guesses a model.
    pub weights: PathBuf,
    /// Additional checkpoints for the optional multi-model vote pass.
    ///
    /// Empty by default: one checkpoint is the normal labeler and is **not** a
    /// consensus or an ensemble. A multi-model pass records each member's vote
    /// and does not use the single-model label cache.
    pub extra_models: Vec<PathBuf>,
    /// Replay directory. Defaults to `$RIICHI_DATA_DIR/replays`.
    pub replays: Option<PathBuf>,
    /// Label one family sub-directory only.
    pub family: Option<String>,
    /// Maximum replay files in this shard.
    pub limit: Option<usize>,
    /// Classifier generation recorded on every label.
    pub classifier_version: String,
    /// Worker threads. `0` uses every available core; `1` is the bounded mode
    /// for tests, fixtures and debugging.
    pub workers: usize,
    /// Print phase and file progress to stderr.
    pub progress: bool,
    /// Reward discount, when the operator knows it.
    pub gamma: Option<f32>,
    /// Placement/rank utility weights, when the operator knows them.
    pub pts: Option<Vec<f32>>,
    /// Optional analyses to record.
    pub label_options: LabelOptions,
    /// Optional versioned Q→point calibration applied to every label.
    ///
    /// It is not part of the cache key: the point estimates are recomputed from
    /// the cached raw Q values, so recalibrating never re-runs the model.
    pub calibration: Option<QPointCalibration>,
    /// Cheap-trigger prefilter. `None` labels every decision.
    ///
    /// With a filter, a decision whose cheap triggers do not fire is skipped
    /// **before** the forward pass, which is S1's "no model pass for cheap
    /// filters". The reason columns record only the triggers this run evaluated;
    /// an unfiltered `mine_replays triggers` pass records every trigger.
    pub trigger_filter: Option<TriggerFilter>,
    /// Thresholds used by the cheap triggers recorded on this run.
    pub trigger_config: TriggerConfig,
}

impl LabelRunOptions {
    /// Defaults for a full label pass over a checkpoint.
    #[must_use]
    pub fn new(weights: impl Into<PathBuf>) -> Self {
        Self {
            weights: weights.into(),
            extra_models: Vec::new(),
            replays: None,
            family: None,
            limit: None,
            classifier_version: super::CLASSIFIER_VERSION.to_string(),
            workers: 0,
            progress: false,
            gamma: None,
            pts: None,
            label_options: LabelOptions::default(),
            calibration: None,
            trigger_filter: None,
            trigger_config: TriggerConfig::default(),
        }
    }
}

/// What a shard run did, as the operator report.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct LabelRunReport {
    /// Labeler file name.
    pub model: String,
    /// Labeler checkpoint hash.
    pub model_sha256: String,
    /// Every evaluated checkpoint, primary first. One entry on the normal pass.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub labelers: Vec<String>,
    /// Classifier generation.
    pub classifier_version: String,
    /// Calibration id applied to this run, when one was.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calibration: Option<String>,
    /// Replay files the shard selected.
    pub replays_found: usize,
    /// Replays that walked cleanly.
    pub replays_walked: usize,
    /// Replays that failed to read or validate.
    pub replays_failed: usize,
    /// Decisions the walker produced.
    pub decisions_seen: usize,
    /// Decisions the walker rejected (reachability guard).
    pub decisions_dropped: usize,
    /// Decisions served from the cache without a forward pass.
    pub decisions_cached: usize,
    /// Decisions evaluated for the first time.
    pub decisions_labelled: usize,
    /// Previously failed decisions retried successfully.
    pub decisions_retried: usize,
    /// Decisions whose evaluation failed this run.
    pub decisions_failed: usize,
    /// Decisions where at least one cheap trigger fired.
    pub decisions_triggered: usize,
    /// Decisions a trigger prefilter kept out of the forward pass.
    pub decisions_filtered_out: usize,
    /// Cheap-trigger fires per trigger family, in report order.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub trigger_hits: BTreeMap<String, usize>,
    /// Labels that carry a book match.
    pub book_labels: usize,
    /// Book labels whose answer the model agrees with (`stable`).
    pub stable: usize,
    /// Book labels the model disagrees with (`contested`); shippable only as a
    /// dual verdict.
    pub contested: usize,
    /// Labels with no book lesson (the model's action is the answer).
    pub mortal_only: usize,
    /// Book conflicts the model could not settle (`unresolved`); not shippable.
    pub book_conflicts: usize,
    /// Resolved worker threads this run used (`0` was requested as every core).
    #[serde(default)]
    pub workers: usize,
    /// Wall time of the whole label pass, in milliseconds.
    #[serde(default)]
    pub wall_time_ms: u64,
    /// First errors, in run order (bounded).
    pub errors: Vec<String>,
}

/// Label a replay shard with the checkpoint(s) named in `options`.
///
/// One checkpoint is the normal path. Additional `extra_models` switch to the
/// optional multi-model vote pass, which records each member's identity and
/// top action and marks a split table `contested`.
pub fn run_label(root: &DataRoot, options: &LabelRunOptions) -> Result<LabelRunReport, LabelError> {
    let primary = super::Labeler::load(&options.weights, options.gamma, options.pts.clone())?;
    if options.extra_models.is_empty() {
        return run_shard_models(root, options, &[&primary]);
    }
    let mut checkpoints = Vec::with_capacity(1 + options.extra_models.len());
    checkpoints.push(primary);
    for path in &options.extra_models {
        checkpoints.push(super::Labeler::load(
            path,
            options.gamma,
            options.pts.clone(),
        )?);
    }
    let evaluators: Vec<&dyn StateEvaluator> = checkpoints
        .iter()
        .map(|labeler| labeler as &dyn StateEvaluator)
        .collect();
    run_shard_models(root, options, &evaluators)
}

/// Label a replay shard with an already-loaded evaluator.
///
/// This is the seam the tests use with a canned evaluator, and the shape a
/// future multi-model pass can reuse without reloading weights per shard.
pub fn run_shard(
    root: &DataRoot,
    options: &LabelRunOptions,
    evaluator: &dyn StateEvaluator,
) -> Result<LabelRunReport, LabelError> {
    run_shard_models(root, options, &[evaluator])
}

/// One cache key's state inside a single run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FlightEntry {
    /// Some worker is evaluating this key.
    InFlight,
    /// The key is recorded in the cache; duplicates reuse its label.
    Done,
}

/// What [`LabelFlight::enter`] tells a worker to do with one key.
enum FlightStep {
    /// This worker evaluates and records the key.
    Owner,
    /// The key is recorded; read it back from the cache.
    Done,
    /// Another worker is evaluating the key; wait for it.
    Wait,
}

/// In-run single-flight sharing of model evaluations.
///
/// The serial pass evaluates a key once and serves every later duplicate from
/// the cache. Parallel workers must produce the same report, so the first
/// worker to see a key claims it, and duplicates wait for the result instead of
/// running a second forward pass. Only the keys are held (not the labels), so
/// the map costs one cache key per unique evaluated state.
struct LabelFlight {
    entries: Mutex<BTreeMap<LabelKey, FlightEntry>>,
    ready: Condvar,
}

impl LabelFlight {
    fn new() -> Self {
        Self {
            entries: Mutex::new(BTreeMap::new()),
            ready: Condvar::new(),
        }
    }

    fn enter(&self, key: &LabelKey) -> FlightStep {
        let mut entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        match entries.get(key) {
            Some(FlightEntry::Done) => FlightStep::Done,
            Some(FlightEntry::InFlight) => FlightStep::Wait,
            None => {
                entries.insert(key.clone(), FlightEntry::InFlight);
                FlightStep::Owner
            }
        }
    }

    /// Block until the key is no longer being evaluated.
    fn wait(&self, key: &LabelKey) {
        let mut entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        while matches!(entries.get(key), Some(FlightEntry::InFlight)) {
            entries = self
                .ready
                .wait(entries)
                .unwrap_or_else(PoisonError::into_inner);
        }
    }

    /// Mark the key recorded, and wake every waiter.
    fn finish(&self, key: &LabelKey) {
        {
            let mut entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
            entries.insert(key.clone(), FlightEntry::Done);
        }
        self.ready.notify_all();
    }

    /// Drop a failed key so a later duplicate retries it, as the serial run
    /// would.
    fn abandon(&self, key: &LabelKey) {
        {
            let mut entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
            entries.remove(key);
        }
        self.ready.notify_all();
    }
}

/// One replay file's counters, merged into the report in file order.
#[derive(Default)]
struct LabelFile {
    /// The replay walked (its decisions count even if they all failed).
    walked: bool,
    /// The replay could not be read or validated.
    failed: bool,
    decisions_seen: usize,
    decisions_dropped: usize,
    decisions_cached: usize,
    decisions_labelled: usize,
    decisions_retried: usize,
    decisions_failed: usize,
    decisions_triggered: usize,
    decisions_filtered_out: usize,
    trigger_hits: BTreeMap<String, usize>,
    book_labels: usize,
    stable: usize,
    contested: usize,
    mortal_only: usize,
    book_conflicts: usize,
    errors: Vec<String>,
}

impl LabelFile {
    fn record_error(&mut self, error: String) {
        if self.errors.len() < MAX_ERRORS {
            self.errors.push(error);
        }
    }

    fn merge_into(self, report: &mut LabelRunReport) {
        if self.walked {
            report.replays_walked += 1;
        }
        if self.failed {
            report.replays_failed += 1;
        }
        report.decisions_seen += self.decisions_seen;
        report.decisions_dropped += self.decisions_dropped;
        report.decisions_cached += self.decisions_cached;
        report.decisions_labelled += self.decisions_labelled;
        report.decisions_retried += self.decisions_retried;
        report.decisions_failed += self.decisions_failed;
        report.decisions_triggered += self.decisions_triggered;
        report.decisions_filtered_out += self.decisions_filtered_out;
        for (trigger, count) in self.trigger_hits {
            *report.trigger_hits.entry(trigger).or_insert(0) += count;
        }
        report.book_labels += self.book_labels;
        report.stable += self.stable;
        report.contested += self.contested;
        report.mortal_only += self.mortal_only;
        report.book_conflicts += self.book_conflicts;
        for error in self.errors {
            if report.errors.len() < MAX_ERRORS {
                report.errors.push(error);
            }
        }
    }
}

/// Label a replay shard with one or more already-loaded evaluators.
///
/// A single evaluator uses the L1 cache keyed by its identity. Two or more
/// evaluators take the optional multi-model path: every checkpoint votes and the
/// label records the consensus; that path deliberately skips the cache because
/// its key would need the whole labeler set (no current pipeline uses it).
pub fn run_shard_models(
    root: &DataRoot,
    options: &LabelRunOptions,
    evaluators: &[&dyn StateEvaluator],
) -> Result<LabelRunReport, LabelError> {
    let started = Instant::now();
    let Some(primary) = evaluators.first() else {
        return Err(LabelError::Evaluation(
            "no labeler was supplied to the shard run".to_string(),
        ));
    };
    let primary: &dyn StateEvaluator = *primary;
    // Resolve the replay shard before opening the DB, so a mistyped `--replays`
    // path is a hard error rather than an empty, successful-looking run.
    let replays = options
        .replays
        .clone()
        .unwrap_or_else(|| root.replays_dir());
    let mut files = discover_replays(&replays, options.family.as_deref())?;
    if let Some(limit) = options.limit {
        files.truncate(limit);
    }

    let workers = resolve_workers(options.workers);
    let pool = worker_pool(workers).map_err(LabelError::Workers)?;
    let progress = Progress::new(
        "label",
        "walk",
        "replay file(s)",
        files.len(),
        options.progress,
    );
    progress.announce(workers);

    let connection = open_miner_db(root)?;
    // One read of `replays` beats one query per file, and keeps the workers off
    // the database for anything but their own label writes.
    let generators = generator_identities(&connection)?;
    let db = SharedDb::new(connection);
    let single_model = evaluators.len() == 1;
    let flight = LabelFlight::new();

    let results: Vec<Result<LabelFile, LabelError>> = pool.install(|| {
        files
            .par_iter()
            .map(|path| {
                progress.tick();
                label_file(
                    &db,
                    &flight,
                    options,
                    evaluators,
                    primary,
                    single_model,
                    &generators,
                    path,
                )
            })
            .collect()
    });

    let identity = primary.identity();
    let mut report = LabelRunReport {
        model: identity.model.clone(),
        model_sha256: identity.model_sha256.clone(),
        labelers: evaluators
            .iter()
            .map(|evaluator| evaluator.identity().model.clone())
            .collect(),
        classifier_version: options.classifier_version.clone(),
        calibration: options
            .calibration
            .as_ref()
            .map(|calibration| calibration.calibration_id.clone()),
        replays_found: files.len(),
        workers,
        wall_time_ms: 0,
        ..LabelRunReport::default()
    };

    for result in results {
        let file = result?;
        file.merge_into(&mut report);
    }
    report.wall_time_ms = elapsed_ms(started);

    Ok(report)
}

/// Walk and label one replay file.
#[allow(clippy::too_many_arguments)]
fn label_file(
    db: &SharedDb,
    flight: &LabelFlight,
    options: &LabelRunOptions,
    evaluators: &[&dyn StateEvaluator],
    primary: &dyn StateEvaluator,
    single_model: bool,
    generators: &BTreeMap<String, ModelIdentity>,
    path: &Path,
) -> Result<LabelFile, LabelError> {
    let walk = match crate::replay::walk::walk_path(path) {
        Ok(walk) => walk,
        Err(err) => {
            let mut file = LabelFile {
                failed: true,
                ..LabelFile::default()
            };
            file.record_error(format!("{}: {err}", path.display()));
            return Ok(file);
        }
    };
    let generator = generators.get(walk.replay_id.as_str());
    let mut file = LabelFile {
        walked: true,
        decisions_dropped: walk.skipped.len(),
        ..LabelFile::default()
    };

    for decision in &walk.decisions {
        file.decisions_seen += 1;
        let triggers = cheap_triggers(decision, options);
        tally_triggers(&mut file, &triggers);
        // Record the reason on an extracted row even when the filter keeps the
        // decision out of the model pass. A missing row changes nothing.
        db.with(|connection| record_triggers(connection, &decision.decision_id, &triggers))?;
        if options.trigger_filter.is_some() && !triggers.has_any() {
            file.decisions_filtered_out += 1;
            continue;
        }
        let labelled = if single_model {
            match label_with_flight(db, flight, primary, decision, options, generator) {
                Ok(disposition) => {
                    match &disposition {
                        LabelDisposition::Cached(_) => file.decisions_cached += 1,
                        LabelDisposition::Labelled(_) => file.decisions_labelled += 1,
                        LabelDisposition::Retried(_) => file.decisions_retried += 1,
                    }
                    Ok(disposition.into_label())
                }
                Err(err) => Err(err),
            }
        } else {
            super::build_label_with_models(
                evaluators,
                decision,
                &options.label_options,
                &options.classifier_version,
                generator,
            )
            .inspect(|_| {
                file.decisions_labelled += 1;
            })
        };

        let label = match labelled {
            Ok(mut label) => {
                // Calibration is a pure function of the cached raw Q values:
                // apply it after the cache lookup so a recalibration never
                // invalidates a finished evaluation.
                if let Some(calibration) = &options.calibration
                    && let Err(err) = label.apply_calibration(calibration)
                {
                    file.decisions_failed += 1;
                    file.record_error(format!("{}: {err}", decision.decision_id));
                    continue;
                }
                label
            }
            Err(err) => {
                file.decisions_failed += 1;
                file.record_error(format!("{}: {err}", decision.decision_id));
                continue;
            }
        };

        tally(&mut file, &label);
        db.with(|connection| {
            write_decision_label(connection, &decision.decision_id, &label)?;
            write_decision_classification(connection, &decision.decision_id, &label)
        })?;
    }

    Ok(file)
}

/// Label one decision through the cache, sharing one evaluation per state.
///
/// The cache lookup and the writes happen under the stage's database lock; the
/// forward pass runs outside it.
fn label_with_flight(
    db: &SharedDb,
    flight: &LabelFlight,
    evaluator: &dyn StateEvaluator,
    decision: &crate::replay::walk::DecisionSnapshot,
    options: &LabelRunOptions,
    generator: Option<&ModelIdentity>,
) -> Result<LabelDisposition, LabelError> {
    let key = LabelKey::new(
        &decision.state,
        evaluator.identity(),
        &options.classifier_version,
        &options.label_options,
    );
    loop {
        match flight.enter(&key) {
            FlightStep::Done => {
                // The owner recorded the label before it released the key.
                let claim = db.with(|connection| LabelCache::new(connection).claim(&key))?;
                return match claim {
                    CacheClaim::Hit(label) => Ok(LabelDisposition::Cached(*label)),
                    CacheClaim::Evaluate { .. } => Err(LabelError::Evaluation(
                        "a finished in-run label was not in the cache".to_string(),
                    )),
                };
            }
            FlightStep::Wait => {
                flight.wait(&key);
                continue;
            }
            FlightStep::Owner => {}
        }

        let claim = db.with(|connection| LabelCache::new(connection).claim(&key))?;
        if let CacheClaim::Hit(label) = &claim {
            flight.finish(&key);
            return Ok(LabelDisposition::Cached(label.as_ref().clone()));
        }
        let built = build_label(
            evaluator,
            decision,
            &options.label_options,
            &options.classifier_version,
            generator,
        );
        let settled = db.with(|connection| LabelCache::new(connection).settle(&key, &claim, built));
        return match settled {
            Ok(disposition) => {
                flight.finish(&key);
                Ok(disposition)
            }
            Err(err) => {
                flight.abandon(&key);
                Err(err)
            }
        };
    }
}

/// The cheap triggers for one decision, narrowed to the prefilter's set.
fn cheap_triggers(
    decision: &crate::replay::walk::DecisionSnapshot,
    options: &LabelRunOptions,
) -> TriggerReport {
    match &options.trigger_filter {
        Some(filter) => filter.report(decision, &options.trigger_config),
        None => evaluate_cheap(decision, &options.trigger_config),
    }
}

/// Count one decision's trigger report for the shard summary.
fn tally_triggers(file: &mut LabelFile, triggers: &TriggerReport) {
    if triggers.has_any() {
        file.decisions_triggered += 1;
    }
    for hit in &triggers.hits {
        *file
            .trigger_hits
            .entry(hit.trigger.as_str().to_string())
            .or_insert(0) += 1;
    }
}

/// Count the agreement outcome of one label for the shard report.
fn tally(file: &mut LabelFile, label: &ModelLabel) {
    if label.book.is_some() {
        file.book_labels += 1;
    }
    if label.book_conflict.is_some() {
        file.book_conflicts += 1;
    }
    match label.kind() {
        super::agreement::LabelKind::Book => file.stable += 1,
        super::agreement::LabelKind::Contested => file.contested += 1,
        super::agreement::LabelKind::Mortal => file.mortal_only += 1,
        super::agreement::LabelKind::Unlabelled => {}
    }
}

/// Every replay's generator identity, read once before the parallel pass.
///
/// Ingest records the engine that produced a replay; a label keeps it only when
/// it differs from the labeler's own identity.
fn generator_identities(
    connection: &Connection,
) -> Result<BTreeMap<String, ModelIdentity>, LabelError> {
    let mut statement = connection.prepare("SELECT replay_id, model, model_sha256 FROM replays")?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            ModelIdentity {
                model: row.get(1)?,
                model_sha256: row.get(2)?,
                gamma: None,
                pts: None,
            },
        ))
    })?;
    let mut map = BTreeMap::new();
    for row in rows {
        let (replay_id, identity) = row?;
        map.insert(replay_id, identity);
    }
    Ok(map)
}

/// Copy a label onto an existing `decisions` row.
///
/// `label_kind`/`label_source` are written by
/// [`write_decision_classification`] (L2) and `selection_reason` belongs to
/// selection (S2), so this L1 write leaves them alone.
fn write_decision_label(
    connection: &Connection,
    decision_id: &str,
    label: &ModelLabel,
) -> Result<(), LabelError> {
    let ranking = serde_json::to_string(&label.ranking)?;
    let q_values = serde_json::to_string(&label.q_values)?;
    let label_json = serde_json::to_string(label)?;
    connection.execute(
        "UPDATE decisions SET
            mortal_top = ?1,
            mortal_top_prob = ?2,
            mortal_margin = ?3,
            mortal_ranking = ?4,
            q_values_json = ?5,
            q_units = ?6,
            labeler_model = ?7,
            labeler_model_sha256 = ?8,
            classifier_version = ?9,
            label_json = ?10
          WHERE decision_id = ?11",
        params![
            label.top_action,
            f64::from(label.top_probability),
            f64::from(label.probability_margin),
            ranking,
            q_values,
            label.q_units,
            label.model,
            label.model_sha256,
            label.classifier_version,
            label_json,
            decision_id
        ],
    )?;
    Ok(())
}

/// Record the L2 agreement classification on an existing `decisions` row.
///
/// `label_kind` uses the table's existing vocabulary (`book`, `contested`,
/// `mortal`, `none`); `label_source` says which perspectives produced the
/// answer (`book+mortal`, `mortal`, `none`). A book/Mortal discrepancy is
/// therefore queryable as `contested` instead of looking like an ordinary book
/// label. `selection_reason` stays with S2.
fn write_decision_classification(
    connection: &Connection,
    decision_id: &str,
    label: &ModelLabel,
) -> Result<(), LabelError> {
    let kind = label.kind();
    connection.execute(
        "UPDATE decisions SET label_kind = ?1, label_source = ?2 WHERE decision_id = ?3",
        params![kind.as_str(), kind.source(), decision_id],
    )?;
    Ok(())
}

/// Every replay file in one family directory, or in all of them.
pub(crate) fn discover_replays(
    replays_dir: &Path,
    family: Option<&str>,
) -> Result<Vec<PathBuf>, LabelError> {
    if !replays_dir.is_dir() {
        return Err(LabelError::MissingReplays(
            replays_dir.display().to_string(),
        ));
    }

    let mut files = Vec::new();
    match family {
        Some(family) => {
            let dir = replays_dir.join(family);
            if !dir.is_dir() {
                return Err(LabelError::MissingReplays(dir.display().to_string()));
            }
            collect_replays(&dir, &mut files)?;
        }
        None => {
            collect_replays(replays_dir, &mut files)?;
            for entry in read_dir(replays_dir)? {
                let path = entry.path();
                if path.is_dir() {
                    collect_replays(&path, &mut files)?;
                }
            }
        }
    }
    files.sort();
    files.dedup();
    Ok(files)
}

fn collect_replays(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), LabelError> {
    for entry in read_dir(dir)? {
        let path = entry.path();
        if path.is_file()
            && path
                .file_name()
                .map(|name| name.to_string_lossy().ends_with(REPLAY_SUFFIX))
                .unwrap_or(false)
        {
            out.push(path);
        }
    }
    Ok(())
}

fn read_dir(dir: &Path) -> Result<Vec<std::fs::DirEntry>, LabelError> {
    let entries = std::fs::read_dir(dir).map_err(|source| LabelError::Io {
        path: dir.display().to_string(),
        source,
    })?;
    let mut out = Vec::new();
    for entry in entries {
        out.push(entry.map_err(|source| LabelError::Io {
            path: dir.display().to_string(),
            source,
        })?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests;
