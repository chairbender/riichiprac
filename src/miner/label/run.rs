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

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use super::calibration::QPointCalibration;
use super::{
    LabelDisposition, LabelError, LabelOptions, ModelIdentity, ModelLabel, StateEvaluator,
    label_decision,
};
use crate::miner::storage::{DataRoot, open_miner_db};

/// Only corpus replay files are walked; the R1 reader has its own decode bounds.
const REPLAY_SUFFIX: &str = ".jsonl.gz";

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
            gamma: None,
            pts: None,
            label_options: LabelOptions::default(),
            calibration: None,
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

    let connection = open_miner_db(root)?;
    let identity = primary.identity();
    let cache = super::cache::LabelCache::new(&connection);
    let single_model = evaluators.len() == 1;
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
        ..LabelRunReport::default()
    };

    for path in files {
        let walk = match crate::replay::walk::walk_path(&path) {
            Ok(walk) => walk,
            Err(err) => {
                report.replays_failed += 1;
                record_error(&mut report, format!("{}: {err}", path.display()));
                continue;
            }
        };
        report.replays_walked += 1;
        report.decisions_dropped += walk.skipped.len();
        let generator = generator_identity(&connection, walk.replay_id.as_str())?;

        for decision in &walk.decisions {
            report.decisions_seen += 1;
            let labelled = if single_model {
                label_decision(
                    &cache,
                    primary,
                    decision,
                    &options.label_options,
                    &options.classifier_version,
                    generator.as_ref(),
                )
                .map(|disposition| {
                    match &disposition {
                        LabelDisposition::Cached(_) => report.decisions_cached += 1,
                        LabelDisposition::Labelled(_) => report.decisions_labelled += 1,
                        LabelDisposition::Retried(_) => report.decisions_retried += 1,
                    }
                    disposition.into_label()
                })
            } else {
                super::build_label_with_models(
                    evaluators,
                    decision,
                    &options.label_options,
                    &options.classifier_version,
                    generator.as_ref(),
                )
                .inspect(|_| {
                    report.decisions_labelled += 1;
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
                        report.decisions_failed += 1;
                        record_error(&mut report, format!("{}: {err}", decision.decision_id));
                        continue;
                    }
                    label
                }
                Err(err) => {
                    report.decisions_failed += 1;
                    record_error(&mut report, format!("{}: {err}", decision.decision_id));
                    continue;
                }
            };

            tally(&mut report, &label);
            write_decision_label(&connection, &decision.decision_id, &label)?;
            write_decision_classification(&connection, &decision.decision_id, &label)?;
        }
    }

    Ok(report)
}

/// Count the agreement outcome of one label for the shard report.
fn tally(report: &mut LabelRunReport, label: &ModelLabel) {
    if label.book.is_some() {
        report.book_labels += 1;
    }
    if label.book_conflict.is_some() {
        report.book_conflicts += 1;
    }
    match label.kind() {
        super::agreement::LabelKind::Book => report.stable += 1,
        super::agreement::LabelKind::Contested => report.contested += 1,
        super::agreement::LabelKind::Mortal => report.mortal_only += 1,
        super::agreement::LabelKind::Unlabelled => {}
    }
}

/// Keep the report readable: a broken corpus can fail thousands of times.
fn record_error(report: &mut LabelRunReport, error: String) {
    const MAX_ERRORS: usize = 100;
    if report.errors.len() < MAX_ERRORS {
        report.errors.push(error);
    }
}

/// The replay's generator identity from `replays`, when ingest recorded it.
fn generator_identity(
    connection: &Connection,
    replay_id: &str,
) -> Result<Option<ModelIdentity>, LabelError> {
    let row: Option<(String, String)> = connection
        .query_row(
            "SELECT model, model_sha256 FROM replays WHERE replay_id = ?1",
            params![replay_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    Ok(row.map(|(model, model_sha256)| ModelIdentity {
        model,
        model_sha256,
        gamma: None,
        pts: None,
    }))
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
fn discover_replays(replays_dir: &Path, family: Option<&str>) -> Result<Vec<PathBuf>, LabelError> {
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
