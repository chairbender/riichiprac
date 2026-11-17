//! Corpus sample report for the cheap triggers (implementation unit S1).
//!
//! The report walks a replay shard the same way `mine_replays label` does,
//! evaluates the triggers on every reconstructed decision, and prints one row
//! per trigger with:
//!
//! - how often it fired;
//! - how many of those fires had measurable evidence (a relevant book label, or
//!   a shippable label for the placement trigger);
//! - precision and recall against that evidence;
//! - the evidence basis, so an unmeasurable family is visible instead of
//!   reading as 0 %.
//!
//! The evidence is deliberately **not** the trigger itself:
//!
//! | Trigger | Evidence |
//! | --- | --- |
//! | `book` | any book label (settled L2 label, else model-free match) |
//! | `defensive_riichi` | a ch. 7 or ch. 8 book label |
//! | `offensive_architecture` | a ch. 4 or ch. 5 book label |
//! | `call_kan` | a ch. 9 book label |
//! | `score_placement` | any shippable label |
//! | `close_call` / `blunder` | the label gap that defines them (exact by construction) |
//!
//! Labels are read from the operational DB, never recomputed: the trigger pass
//! is model-free. It prefers a `decisions.label_json` row and falls back to the
//! L1/L2 `model_labels` cache keyed by `state_hash`, so a shard labelled before
//! extraction still contributes its labels. With no labels the chapter-based
//! rows still measure against the model-free book classifier; the placement row
//! reports itself unmeasured.
//!
//! # Writes
//!
//! For every decision that already has a `decisions` row, the report writes the
//! final `trigger`/`trigger_detail` (cheap hits plus any label-derived hits).
//! It never inserts a row: extraction owns that. `--dry-run` skips the write.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use super::families::{Family, FamilyFilter};
use super::{
    LabelCuts, TRIGGER_SCHEMA, TRIGGER_VERSION, TriggerConfig, TriggerError, TriggerKind,
    TriggerReport, blunder_hit, close_call_hit, evaluate_cheap, played_gap, record_triggers,
};
use crate::generator::SCENARIO_MANIFEST;
use crate::miner::classifier::classify_decision;
use crate::miner::label::thresholds::{Band, DecisionFamily, PercentileConfig, PercentileCuts};
use crate::miner::label::{ModelLabel, state_hash};
use crate::miner::storage::{DataRoot, open_miner_db, utc_stamp};
use crate::replay::walk::{DecisionSnapshot, walk_path};

/// Inputs for one corpus sample report.
#[derive(Debug, Clone, Default)]
pub struct TriggerSampleOptions {
    /// Replay directory. Defaults to `$RIICHI_DATA_DIR/replays`.
    pub replays: Option<PathBuf>,
    /// One family sub-directory only.
    pub family: Option<String>,
    /// Maximum replay files in the sample.
    pub limit: Option<usize>,
    /// Cheap-trigger thresholds.
    pub config: TriggerConfig,
    /// Which candidate families count as in scope.
    pub families: FamilyFilter,
    /// Percentile configuration used to build the label-derived cuts.
    pub percentiles: PercentileConfig,
    /// Do not write `decisions.trigger`/`trigger_detail`.
    pub dry_run: bool,
}

/// One trigger's measured counts.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TriggerStats {
    /// The trigger family.
    pub trigger: TriggerKind,
    /// Decisions where it fired.
    pub fired: u64,
    /// Fired decisions that had measurable evidence.
    pub measured: u64,
    /// Decisions whose evidence says the trigger should have fired.
    pub target: u64,
    /// Fired and evidence says it should have fired.
    pub true_positive: u64,
    /// `true_positive / measured`, or `None` when nothing was measurable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub precision: Option<f64>,
    /// `true_positive / target`, or `None` when the sample has no target.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recall: Option<f64>,
    /// What the precision/recall are measured against.
    pub basis: String,
}

/// Per-replay-family counts.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ReplayFamilyStats {
    /// Replay files walked in this family.
    pub replays: usize,
    /// Decisions reconstructed from them.
    pub decisions: u64,
    /// Decisions with at least one trigger.
    pub triggered: u64,
    /// Fires per trigger family.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub trigger_hits: BTreeMap<String, u64>,
}

/// One corpus sample trigger report.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TriggerSampleReport {
    /// [`TRIGGER_SCHEMA`].
    pub schema: String,
    /// [`TRIGGER_VERSION`].
    pub version: u32,
    /// When the sample ran, `YYYYMMDD-HHMMSS` UTC.
    pub generated_at: String,
    /// Replay files discovered.
    pub replays_found: usize,
    /// Replays walked cleanly.
    pub replays_walked: usize,
    /// Replays that failed to read or validate.
    pub replays_failed: usize,
    /// Decisions the walker produced.
    pub decisions_seen: u64,
    /// Decisions the reachability guard rejected.
    pub decisions_dropped: u64,
    /// Decisions with at least one trigger.
    pub decisions_triggered: u64,
    /// Decisions whose final report has no family the filter accepts.
    pub family_filtered_out: u64,
    /// Decisions that carried a cached label.
    pub labelled_decisions: u64,
    /// Decisions with no cached label. Their book evidence falls back to the
    /// model-free classifier; the placement evidence is unmeasured.
    pub unlabelled_decisions: u64,
    /// `none` or `cache`.
    pub label_source: String,
    /// Distinct labeler checkpoints used, `model (first 12 of sha256)`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub label_models: Vec<String>,
    /// `decisions` rows whose trigger columns were updated.
    pub decision_rows_updated: u64,
    /// One row per trigger, in precedence order.
    pub triggers: Vec<TriggerStats>,
    /// Candidate counts per family.
    pub families: Vec<FamilyStats>,
    /// Per replay-family counts, sorted by family name.
    pub replay_families: Vec<(String, ReplayFamilyStats)>,
    /// First errors, in run order (bounded).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<String>,
}

/// One family's candidate count.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FamilyStats {
    /// The family.
    pub family: Family,
    /// Candidates whose family set contains it.
    pub candidates: u64,
}

/// One decision collected by the first pass.
struct SampleRow {
    replay_family: String,
    decision_id: String,
    family_key: String,
    played_action: String,
    cheap: TriggerReport,
    report: TriggerReport,
    label: Option<ModelLabel>,
    book_lesson: Option<String>,
    book_chapter: Option<u8>,
}

impl TriggerSampleReport {
    /// A human-readable multi-line summary for the CLI.
    #[must_use]
    pub fn human_summary(&self) -> String {
        let mut out = String::new();
        out.push_str(&format!(
            "mine_replays triggers: {} replay(s) ({} walked, {} failed), {} decisions \
             ({} walker drops), {} triggered\n",
            self.replays_found,
            self.replays_walked,
            self.replays_failed,
            self.decisions_seen,
            self.decisions_dropped,
            self.decisions_triggered
        ));
        out.push_str(&format!(
            "  labels: {} ({}/{} decisions labelled{})\n",
            self.label_source,
            self.labelled_decisions,
            self.decisions_seen,
            self.label_models
                .first()
                .map_or_else(String::new, |model| format!("; {model}"))
        ));
        out.push_str(&format!(
            "  decision rows updated with trigger reasons: {}\n",
            self.decision_rows_updated
        ));
        out.push_str(&format!(
            "  {:<24} {:>6} {:>8} {:>7} {:>9} {:>7}  {}\n",
            "trigger", "fired", "measured", "target", "precision", "recall", "basis"
        ));
        for stats in &self.triggers {
            out.push_str(&format!(
                "  {:<24} {:>6} {:>8} {:>7} {:>9} {:>7}  {}\n",
                stats.trigger.as_str(),
                stats.fired,
                stats.measured,
                stats.target,
                format_ratio(stats.precision),
                format_ratio(stats.recall),
                stats.basis
            ));
        }
        let families: Vec<String> = self
            .families
            .iter()
            .map(|stats| format!("{}={}", stats.family.as_str(), stats.candidates))
            .collect();
        out.push_str(&format!("  families: {}\n", families.join(", ")));
        out.push_str(&format!(
            "  family filter rejected {} candidate(s)\n",
            self.family_filtered_out
        ));
        for (family, stats) in &self.replay_families {
            let hits: Vec<String> = stats
                .trigger_hits
                .iter()
                .map(|(trigger, count)| format!("{trigger}={count}"))
                .collect();
            out.push_str(&format!(
                "  replay family {family}: {} replay(s), {} decision(s), {} triggered [{}]\n",
                stats.replays,
                stats.decisions,
                stats.triggered,
                hits.join(", ")
            ));
        }
        for error in &self.errors {
            out.push_str(&format!("  error: {error}\n"));
        }
        out
    }
}

fn format_ratio(value: Option<f64>) -> String {
    value.map_or_else(|| "-".to_string(), |value| format!("{value:.2}"))
}

/// Walk a replay shard and evaluate the trigger families on every decision.
pub fn run_trigger_sample(
    root: &DataRoot,
    options: &TriggerSampleOptions,
) -> Result<TriggerSampleReport, TriggerError> {
    options.config.validate()?;
    options.percentiles.validate()?;

    let replays = options
        .replays
        .clone()
        .unwrap_or_else(|| root.replays_dir());
    let mut files = super::super::label::run::discover_replays(&replays, options.family.as_deref())
        .map_err(|err| match err {
            crate::miner::label::LabelError::MissingReplays(path) => {
                TriggerError::MissingReplays(path)
            }
            crate::miner::label::LabelError::Io { path, source } => {
                TriggerError::Io { path, source }
            }
            other => TriggerError::LabelDiscovery(other.to_string()),
        })?;
    if let Some(limit) = options.limit {
        files.truncate(limit);
    }

    let connection = open_miner_db(root)?;
    let mut report = TriggerSampleReport {
        schema: TRIGGER_SCHEMA.to_string(),
        version: TRIGGER_VERSION,
        generated_at: utc_stamp(SystemTime::now()),
        replays_found: files.len(),
        replays_walked: 0,
        replays_failed: 0,
        decisions_seen: 0,
        decisions_dropped: 0,
        decisions_triggered: 0,
        family_filtered_out: 0,
        labelled_decisions: 0,
        unlabelled_decisions: 0,
        label_source: "none".to_string(),
        label_models: Vec::new(),
        decision_rows_updated: 0,
        triggers: Vec::new(),
        families: Vec::new(),
        replay_families: Vec::new(),
        errors: Vec::new(),
    };
    let mut rows: Vec<SampleRow> = Vec::new();
    let mut replay_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut labels: BTreeSet<String> = BTreeSet::new();

    for path in files {
        let walk = match walk_path(&path) {
            Ok(walk) => walk,
            Err(err) => {
                report.replays_failed += 1;
                record_error(&mut report, format!("{}: {err}", path.display()));
                continue;
            }
        };
        report.replays_walked += 1;
        report.decisions_dropped += walk.skipped.len() as u64;
        let replay_family = family_of_path(&path, &replays);
        *replay_counts.entry(replay_family.clone()).or_insert(0) += 1;

        for decision in &walk.decisions {
            report.decisions_seen += 1;
            let state_hash = state_hash(&decision.state);
            let label = load_label(&connection, &decision.decision_id, &state_hash)?;
            if let Some(label) = &label {
                report.labelled_decisions += 1;
                labels.insert(format!(
                    "{} ({})",
                    label.model,
                    &label.model_sha256[..label.model_sha256.len().min(12)]
                ));
            }
            let (book_lesson, book_chapter) = book_truth(decision, label.as_ref());
            let cheap = evaluate_cheap(decision, &options.config);
            rows.push(SampleRow {
                replay_family: replay_family.clone(),
                decision_id: decision.decision_id.clone(),
                family_key: DecisionFamily::of(decision).key(),
                played_action: decision.played.action.clone(),
                report: cheap.clone(),
                cheap,
                label,
                book_lesson,
                book_chapter,
            });
        }
    }

    // Pass two: the label-derived cuts are percentiles of this sample. Without
    // the minimum sample the cuts stay empty and neither trigger fires.
    let cuts = sample_cuts(&rows, &options.percentiles)?;
    for row in &mut rows {
        if let Some(label) = &row.label {
            let mut report = row.cheap.clone();
            if let Some(hit) = close_call_hit(&row.family_key, label, &cuts.close_call) {
                report.add_hit(hit);
            }
            if let Some(hit) =
                blunder_hit(&row.family_key, &row.played_action, label, &cuts.blunder)
            {
                report.add_hit(hit);
            }
            report.refresh_families(Some(label));
            row.report = report;
        }
    }

    report.unlabelled_decisions = report.decisions_seen - report.labelled_decisions;
    if !labels.is_empty() {
        report.label_source = "cache".to_string();
        report.label_models = labels.into_iter().collect();
    }
    aggregate(&mut report, &rows, options, &cuts, &replay_counts)?;

    // Write the reasons onto rows extraction already created. A report over an
    // un-extracted corpus changes nothing, which is expected before R2's
    // extract command lands; the JSON still carries every count.
    if !options.dry_run {
        for row in &rows {
            report.decision_rows_updated +=
                record_triggers(&connection, &row.decision_id, &row.report)? as u64;
        }
    }

    Ok(report)
}

fn sample_cuts(
    rows: &[SampleRow],
    percentiles: &PercentileConfig,
) -> Result<LabelCuts, TriggerError> {
    let mut close_samples: BTreeMap<String, Vec<f32>> = BTreeMap::new();
    let mut blunder_samples: BTreeMap<String, Vec<f32>> = BTreeMap::new();
    for row in rows {
        let Some(label) = &row.label else {
            continue;
        };
        if let Some(gap) = label.top2_gap() {
            close_samples
                .entry(row.family_key.clone())
                .or_default()
                .push(gap);
        }
        if let Some(gap) = played_gap(&row.played_action, label) {
            blunder_samples
                .entry(row.family_key.clone())
                .or_default()
                .push(gap);
        }
    }
    Ok(LabelCuts {
        close_call: PercentileCuts::build(percentiles, &close_samples)?,
        blunder: PercentileCuts::build(percentiles, &blunder_samples)?,
    })
}

fn aggregate(
    report: &mut TriggerSampleReport,
    rows: &[SampleRow],
    options: &TriggerSampleOptions,
    cuts: &LabelCuts,
    replay_counts: &BTreeMap<String, usize>,
) -> Result<(), TriggerError> {
    let labels_available = rows.iter().any(|row| row.label.is_some());
    let mut family_counts: BTreeMap<Family, u64> = BTreeMap::new();
    let mut stats: BTreeMap<TriggerKind, TriggerStats> = TriggerKind::ALL
        .into_iter()
        .map(|trigger| {
            (
                trigger,
                TriggerStats {
                    trigger,
                    fired: 0,
                    measured: 0,
                    target: 0,
                    true_positive: 0,
                    precision: None,
                    recall: None,
                    basis: basis_for(trigger, labels_available),
                },
            )
        })
        .collect();

    for row in rows {
        if !options.families.accepts(&row.report.family_set()) {
            report.family_filtered_out += 1;
        }
        if row.report.has_any() {
            report.decisions_triggered += 1;
        }
        for family in &row.report.families {
            *family_counts.entry(*family).or_insert(0) += 1;
        }
        for trigger in TriggerKind::ALL {
            let stats = stats.get_mut(&trigger).expect("every trigger has a row");
            let fired = row.report.fired(trigger);
            let evidence = evidence(row, trigger, cuts);
            if fired {
                stats.fired += 1;
            }
            if let Some(true) = evidence {
                stats.target += 1;
            }
            if fired && let Some(evidence) = evidence {
                stats.measured += 1;
                if evidence {
                    stats.true_positive += 1;
                }
            }
        }
    }

    for trigger in TriggerKind::ALL {
        let mut stats = stats.remove(&trigger).expect("every trigger has a row");
        stats.precision =
            (stats.measured > 0).then(|| stats.true_positive as f64 / stats.measured as f64);
        stats.recall = (stats.target > 0).then(|| stats.true_positive as f64 / stats.target as f64);
        report.triggers.push(stats);
    }

    report.families = Family::ALL
        .into_iter()
        .map(|family| FamilyStats {
            family,
            candidates: family_counts.get(&family).copied().unwrap_or(0),
        })
        .collect();
    let mut replay_families: BTreeMap<String, ReplayFamilyStats> = replay_counts
        .iter()
        .map(|(family, replays)| {
            (
                family.clone(),
                ReplayFamilyStats {
                    replays: *replays,
                    ..ReplayFamilyStats::default()
                },
            )
        })
        .collect();
    for row in rows {
        let entry = replay_families
            .entry(row.replay_family.clone())
            .or_default();
        entry.decisions += 1;
        if row.report.has_any() {
            entry.triggered += 1;
            for hit in &row.report.hits {
                *entry
                    .trigger_hits
                    .entry(hit.trigger.as_str().to_string())
                    .or_insert(0) += 1;
            }
        }
    }
    report.replay_families = replay_families.into_iter().collect();
    Ok(())
}

fn basis_for(trigger: TriggerKind, labels_available: bool) -> String {
    match trigger {
        TriggerKind::Book => "book label (settled, else model-free)".to_string(),
        TriggerKind::DefensiveRiichi => "ch.7/ch.8 book label".to_string(),
        TriggerKind::OffensiveArchitecture => {
            "ch.4/ch.5 book label; non-book speed/value not labelled".to_string()
        }
        TriggerKind::CallKan => "ch.9 book label; non-book calls not labelled".to_string(),
        TriggerKind::ScorePlacement if labels_available => "any shippable label".to_string(),
        TriggerKind::ScorePlacement => "unmeasured: no labels in sample".to_string(),
        TriggerKind::CloseCall | TriggerKind::Blunder => {
            "label-derived (exact by construction)".to_string()
        }
    }
}

fn evidence(row: &SampleRow, trigger: TriggerKind, cuts: &LabelCuts) -> Option<bool> {
    match trigger {
        TriggerKind::Book => Some(row.book_lesson.is_some()),
        TriggerKind::DefensiveRiichi => Some(matches!(row.book_chapter, Some(7 | 8))),
        TriggerKind::OffensiveArchitecture => Some(matches!(row.book_chapter, Some(4 | 5))),
        TriggerKind::CallKan => Some(row.book_chapter == Some(9)),
        TriggerKind::ScorePlacement => row.label.as_ref().map(ModelLabel::is_shippable),
        TriggerKind::CloseCall => {
            let label = row.label.as_ref()?;
            let gap = label.top2_gap()?;
            Some(cuts.close_call.band(&row.family_key, gap)? == Band::Close)
        }
        TriggerKind::Blunder => {
            let label = row.label.as_ref()?;
            let gap = played_gap(&row.played_action, label)?;
            Some(cuts.blunder.band(&row.family_key, gap)? == Band::Confident)
        }
    }
}

/// The book lesson a decision carries, settled label first then model-free.
fn book_truth(
    decision: &DecisionSnapshot,
    label: Option<&ModelLabel>,
) -> (Option<String>, Option<u8>) {
    let lesson = label
        .and_then(|label| label.book.as_ref())
        .map(|book| book.lesson.clone())
        .or_else(|| match classify_decision(decision) {
            Ok(Some(matched)) => Some(matched.lesson.as_str().to_string()),
            _ => None,
        });
    let chapter = lesson.as_deref().and_then(chapter_of_lesson);
    (lesson, chapter)
}

fn chapter_of_lesson(lesson: &str) -> Option<u8> {
    SCENARIO_MANIFEST
        .iter()
        .find(|meta| meta.id.as_str() == lesson)
        .and_then(|meta| meta.book)
        .map(|book| book.chapter)
}

fn load_label(
    connection: &Connection,
    decision_id: &str,
    state_hash: &str,
) -> Result<Option<ModelLabel>, TriggerError> {
    let decision_json: Option<String> = connection
        .query_row(
            "SELECT label_json FROM decisions
             WHERE decision_id = ?1 AND label_json IS NOT NULL",
            params![decision_id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(json) = decision_json {
        return Ok(Some(serde_json::from_str(&json)?));
    }
    let cache_json: Option<String> = connection
        .query_row(
            "SELECT label_json FROM model_labels
             WHERE state_hash = ?1 AND status = 'ok' AND label_json IS NOT NULL
             ORDER BY model_sha256, classifier_version, options_hash
             LIMIT 1",
            params![state_hash],
            |row| row.get(0),
        )
        .optional()?;
    match cache_json {
        Some(json) => Ok(Some(serde_json::from_str(&json)?)),
        None => Ok(None),
    }
}

fn family_of_path(path: &Path, replays_dir: &Path) -> String {
    let relative = path.strip_prefix(replays_dir).unwrap_or(path);
    let parent = relative.parent().unwrap_or_else(|| Path::new(""));
    if parent.as_os_str().is_empty() {
        "(root)".to_string()
    } else {
        parent.to_string_lossy().replace('\\', "/")
    }
}

fn record_error(report: &mut TriggerSampleReport, error: String) {
    const MAX_ERRORS: usize = 100;
    if report.errors.len() < MAX_ERRORS {
        report.errors.push(error);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_family_path_is_relative_and_named_for_the_root() {
        let root = Path::new("/data/replays");
        assert_eq!(
            family_of_path(Path::new("/data/replays/mortal/a.jsonl.gz"), root),
            "mortal"
        );
        assert_eq!(
            family_of_path(Path::new("/data/replays/a.jsonl.gz"), root),
            "(root)"
        );
        assert_eq!(
            family_of_path(Path::new("/data/replays/a/b.jsonl.gz"), root),
            "a"
        );
    }

    #[test]
    fn an_empty_sample_has_no_percentiles_and_a_named_basis() {
        let report = TriggerSampleReport {
            schema: TRIGGER_SCHEMA.to_string(),
            version: TRIGGER_VERSION,
            generated_at: "20261116-000000".to_string(),
            replays_found: 0,
            replays_walked: 0,
            replays_failed: 0,
            decisions_seen: 0,
            decisions_dropped: 0,
            decisions_triggered: 0,
            family_filtered_out: 0,
            labelled_decisions: 0,
            unlabelled_decisions: 0,
            label_source: "none".to_string(),
            label_models: Vec::new(),
            decision_rows_updated: 0,
            triggers: Vec::new(),
            families: Vec::new(),
            replay_families: Vec::new(),
            errors: Vec::new(),
        };
        let summary = report.human_summary();
        assert!(summary.contains("0 replay(s)"));
        assert!(summary.contains("labels: none"));
    }
}
