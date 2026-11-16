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
}

impl LabelRunOptions {
    /// Defaults for a full label pass over a checkpoint.
    #[must_use]
    pub fn new(weights: impl Into<PathBuf>) -> Self {
        Self {
            weights: weights.into(),
            replays: None,
            family: None,
            limit: None,
            classifier_version: super::CLASSIFIER_VERSION.to_string(),
            gamma: None,
            pts: None,
            label_options: LabelOptions::default(),
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
    /// Classifier generation.
    pub classifier_version: String,
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
    /// Book disagreements the model could not settle.
    pub book_conflicts: usize,
    /// First errors, in run order (bounded).
    pub errors: Vec<String>,
}

/// Label a replay shard with the checkpoint named in `options`.
pub fn run_label(root: &DataRoot, options: &LabelRunOptions) -> Result<LabelRunReport, LabelError> {
    let labeler = super::Labeler::load(&options.weights, options.gamma, options.pts.clone())?;
    run_shard(root, options, &labeler)
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
    let identity = evaluator.identity();
    let cache = super::cache::LabelCache::new(&connection);
    let mut report = LabelRunReport {
        model: identity.model.clone(),
        model_sha256: identity.model_sha256.clone(),
        classifier_version: options.classifier_version.clone(),
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
            match label_decision(
                &cache,
                evaluator,
                decision,
                &options.label_options,
                &options.classifier_version,
                generator.as_ref(),
            ) {
                Ok(disposition) => {
                    match &disposition {
                        LabelDisposition::Cached(_) => report.decisions_cached += 1,
                        LabelDisposition::Labelled(_) => report.decisions_labelled += 1,
                        LabelDisposition::Retried(_) => report.decisions_retried += 1,
                    }
                    let label = disposition.label();
                    if label.book.is_some() {
                        report.book_labels += 1;
                    }
                    if label.book_conflict.is_some() {
                        report.book_conflicts += 1;
                    }
                    write_decision_label(&connection, &decision.decision_id, label)?;
                }
                Err(err) => {
                    report.decisions_failed += 1;
                    record_error(&mut report, format!("{}: {err}", decision.decision_id));
                }
            }
        }
    }

    Ok(report)
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
/// `label_kind`/`label_source`/`selection_reason` belong to selection (S2), not
/// to L1, so they are left alone.
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
