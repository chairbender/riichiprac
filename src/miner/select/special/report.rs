//! The S3 selector corpus sample report.
//!
//! This is the evidence page for the three selectors: it walks a replay shard,
//! reads cached labels (never a forward pass), evaluates each selector on every
//! reconstructed decision, and reports per family:
//!
//! - how many decisions the S1 trigger proposed;
//! - how many carried a label the selector could measure;
//! - how many the selector accepted;
//! - how many were accepted as close calls / with an equivalence tie;
//! - every decline reason, with its count;
//! - the L2 bands the deciding gaps landed in.
//!
//! It is deliberately separate from [`crate::miner::select::SelectionReport`]:
//! that report proves the *pack* is balanced and legal, while this one proves
//! the three non-book selectors behave on a real shard. The selector itself is
//! also wired into the selection run, so an accepted verdict is what keeps
//! `close_call`, `speed_value` or `mistake` on a candidate.
//!
//! ```text
//! $RIICHI_DATA_DIR/reviews/...           (not written; S2 owns the queue)
//! $RIICHI_DATA_DIR/reports/selector-sample.json  (operator redirect)
//! ```
//!
//! The command prints the report; an operator redirects it into `testdata/` for
//! the committed sample.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use rusqlite::Connection;
use serde::Serialize;

use crate::miner::label::state_hash;
use crate::miner::label::thresholds::{DecisionFamily, PercentileConfig};
use crate::miner::provenance::GameProvenance;
use crate::miner::storage::{DataRoot, open_miner_db, utc_stamp};
use crate::miner::trigger::families::Family;
use crate::miner::trigger::report::load_label;
use crate::miner::trigger::{LabelCuts, TriggerConfig, evaluate_cheap, evaluate_with_label};
use crate::replay::walk::walk_path;

use super::{
    SPECIAL_FAMILIES, SeatPolicy, SpecialConfig, SpecialVerdict, evaluate_specials, trigger_for,
};
use crate::miner::select::SelectionError;
use crate::miner::select::score::SampleCuts;

/// Schema name for the selector sample report.
pub const SELECTOR_SAMPLE_SCHEMA: &str = "riichiprac.selector-sample";

/// Version of the selector sample report.
pub const SELECTOR_SAMPLE_VERSION: u32 = 1;

/// Inputs for one selector sample report.
#[derive(Debug, Clone, Default)]
pub struct SelectorSampleOptions {
    /// Replay directory. Defaults to `$RIICHI_DATA_DIR/replays`.
    pub replays: Option<PathBuf>,
    /// One family sub-directory only.
    pub family: Option<String>,
    /// Maximum replay files in the sample.
    pub limit: Option<usize>,
    /// Cheap-trigger thresholds used to report what S1 proposed.
    pub trigger: TriggerConfig,
    /// S3 selector thresholds.
    pub special: SpecialConfig,
    /// Percentile configuration used to build the family cuts.
    pub percentiles: PercentileConfig,
}

/// One selector's measured counts.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SelectorStats {
    /// `close_call`, `speed_value` or `mistake`.
    pub family: Family,
    /// Decisions where the S1 trigger proposed this family.
    pub triggered: u64,
    /// Labelled decisions the selector could evaluate.
    pub evaluated: u64,
    /// Decisions the selector accepted.
    pub accepted: u64,
    /// Accepted decisions that must be presented as close calls.
    pub close: u64,
    /// Accepted decisions with more than one graded tile (an equivalence tie).
    pub tied: u64,
    /// Accepted speed/value decisions with a measured plan divergence.
    pub divergences: u64,
    /// L2 band counts (`close`, `middle`, `confident`), one per evaluated gap.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub bands: BTreeMap<String, u64>,
    /// Decline reasons, by stable code.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub declined: BTreeMap<String, u64>,
}

impl SelectorStats {
    pub(crate) fn new(family: Family) -> Self {
        Self {
            family,
            triggered: 0,
            evaluated: 0,
            accepted: 0,
            close: 0,
            tied: 0,
            divergences: 0,
            bands: BTreeMap::new(),
            declined: BTreeMap::new(),
        }
    }

    pub(crate) fn record(&mut self, verdict: &SpecialVerdict, trigger_fired: bool, labelled: bool) {
        if trigger_fired {
            self.triggered += 1;
        }
        if labelled {
            self.evaluated += 1;
        }
        if let Some(band) = verdict.band {
            *self.bands.entry(band.as_str().to_string()).or_insert(0) += 1;
        }
        if verdict.accepted {
            self.accepted += 1;
            if verdict.close {
                self.close += 1;
            }
            if verdict.accepted_tiles.len() > 1 {
                self.tied += 1;
            }
            if verdict.divergence.is_some() {
                self.divergences += 1;
            }
        } else if let Some(decline) = verdict.decline {
            *self
                .declined
                .entry(decline.as_str().to_string())
                .or_insert(0) += 1;
        }
    }
}

/// Per replay-family counts.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct SelectorReplayFamilyStats {
    /// Replay files walked in this family.
    pub replays: usize,
    /// Decisions reconstructed from them.
    pub decisions: u64,
    /// Decisions with a cached label.
    pub labelled: u64,
    /// Decisions whose recorded actor is a weak (rule/heuristic) policy.
    pub weak_policy_decisions: u64,
    /// Accepted verdicts per selector family.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub accepted: BTreeMap<String, u64>,
}

/// One selector corpus sample.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SelectorSampleReport {
    /// [`SELECTOR_SAMPLE_SCHEMA`].
    pub schema: String,
    /// [`SELECTOR_SAMPLE_VERSION`].
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
    /// Decisions that carried a cached label.
    pub labelled_decisions: u64,
    /// Decisions with no cached label.
    pub unlabelled_decisions: u64,
    /// Decisions whose recorded actor is a weak policy.
    pub weak_policy_decisions: u64,
    /// `none` or `cache`.
    pub label_source: String,
    /// Distinct labeler checkpoints used, `model (first 12 of sha256)`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub label_models: Vec<String>,
    /// One row per S3 family, in report order.
    pub selectors: Vec<SelectorStats>,
    /// Per replay-family counts, sorted by family name.
    pub replay_families: Vec<(String, SelectorReplayFamilyStats)>,
    /// Operator-facing notes.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
    /// First errors, in run order (bounded).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<String>,
}

impl SelectorSampleReport {
    /// A human-readable multi-line summary for the CLI.
    #[must_use]
    pub fn human_summary(&self) -> String {
        let mut out = String::new();
        out.push_str(&format!(
            "mine_replays selectors: {} replay(s) ({} walked, {} failed), {} decision(s) \
             ({} walker drops), {} weak-policy decision(s)\n",
            self.replays_found,
            self.replays_walked,
            self.replays_failed,
            self.decisions_seen,
            self.decisions_dropped,
            self.weak_policy_decisions
        ));
        out.push_str(&format!(
            "  labels: {} ({} of {} decisions labelled{})\n",
            self.label_source,
            self.labelled_decisions,
            self.decisions_seen,
            self.label_models
                .first()
                .map_or_else(String::new, |model| format!("; {model}"))
        ));
        out.push_str(&format!(
            "  {:<13} {:>8} {:>9} {:>8} {:>6} {:>5}  {}\n",
            "selector", "triggered", "evaluated", "accepted", "close", "ties", "declines"
        ));
        for stats in &self.selectors {
            let declines: Vec<String> = stats
                .declined
                .iter()
                .map(|(code, count)| format!("{code}={count}"))
                .collect();
            out.push_str(&format!(
                "  {:<13} {:>8} {:>9} {:>8} {:>6} {:>5}  {}\n",
                stats.family.as_str(),
                stats.triggered,
                stats.evaluated,
                stats.accepted,
                stats.close,
                stats.tied,
                if declines.is_empty() {
                    "-".to_string()
                } else {
                    declines.join(", ")
                }
            ));
        }
        for (family, stats) in &self.replay_families {
            let accepted: Vec<String> = stats
                .accepted
                .iter()
                .map(|(family, count)| format!("{family}={count}"))
                .collect();
            out.push_str(&format!(
                "  replay family {family}: {} replay(s), {} decision(s), {} labelled, {} weak \
                 policy, accepted [{}]\n",
                stats.replays,
                stats.decisions,
                stats.labelled,
                stats.weak_policy_decisions,
                if accepted.is_empty() {
                    "-".to_string()
                } else {
                    accepted.join(", ")
                }
            ));
        }
        for note in &self.notes {
            out.push_str(&format!("  note: {note}\n"));
        }
        for error in &self.errors {
            out.push_str(&format!("  error: {error}\n"));
        }
        out
    }
}

/// Walk a replay shard and report the three S3 selectors.
pub fn run_selector_sample(
    root: &DataRoot,
    options: &SelectorSampleOptions,
) -> Result<SelectorSampleReport, SelectionError> {
    options
        .trigger
        .validate()
        .map_err(|err| SelectionError::InvalidConfig(err.to_string()))?;
    options
        .special
        .validate()
        .map_err(SelectionError::InvalidConfig)?;
    options
        .percentiles
        .validate()
        .map_err(SelectionError::Threshold)?;

    let replays = options
        .replays
        .clone()
        .unwrap_or_else(|| root.replays_dir());
    let mut files = crate::miner::label::run::discover_replays(&replays, options.family.as_deref())
        .map_err(|err| match err {
            crate::miner::label::LabelError::MissingReplays(path) => {
                SelectionError::MissingReplays(path)
            }
            crate::miner::label::LabelError::Io { path, source } => {
                SelectionError::Io { path, source }
            }
            other => SelectionError::Discovery(other.to_string()),
        })?;
    if let Some(limit) = options.limit {
        files.truncate(limit);
    }

    let connection = open_miner_db(root)?;
    let (seats, mut errors) = load_seats(&connection)?;
    let mut report = SelectorSampleReport {
        schema: SELECTOR_SAMPLE_SCHEMA.to_string(),
        version: SELECTOR_SAMPLE_VERSION,
        generated_at: utc_stamp(SystemTime::now()),
        replays_found: files.len(),
        replays_walked: 0,
        replays_failed: 0,
        decisions_seen: 0,
        decisions_dropped: 0,
        labelled_decisions: 0,
        unlabelled_decisions: 0,
        weak_policy_decisions: 0,
        label_source: "none".to_string(),
        label_models: Vec::new(),
        selectors: SPECIAL_FAMILIES
            .into_iter()
            .map(SelectorStats::new)
            .collect(),
        replay_families: Vec::new(),
        notes: vec![
            "no forward pass: labels come from decisions.label_json or the L1/L2 model_labels \
             cache"
                .to_string(),
            "a blunder compares a weak agent's played action with the Mortal label; it never \
             reads the kyoku result"
                .to_string(),
            "closeness is banded by the decision family's percentile; a family with too few samples \
             declines rather than guessing"
                .to_string(),
        ],
        errors: Vec::new(),
    };

    // Pass 1: the label sample. No selector runs until the family cuts exist.
    let mut samples = SampleCuts::default();
    let mut labelled = 0_u64;
    let mut weak_policy_decisions = 0_u64;
    let mut replay_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut label_models: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for path in &files {
        let walk = match walk_path(path) {
            Ok(walk) => walk,
            Err(err) => {
                report.replays_failed += 1;
                push_error(&mut errors, format!("{}: {err}", path.display()));
                continue;
            }
        };
        report.replays_walked += 1;
        report.decisions_dropped += walk.skipped.len() as u64;
        let replay_family = family_of_path(path, &replays);
        *replay_counts.entry(replay_family).or_insert(0) += 1;
        let replay_seats = seats
            .get(walk.replay_id.as_str())
            .cloned()
            .unwrap_or_default();
        for decision in &walk.decisions {
            report.decisions_seen += 1;
            if actor_policy(&replay_seats, decision.seat).is_some_and(|policy| policy.is_weak()) {
                weak_policy_decisions += 1;
            }
            let hash = state_hash(&decision.state);
            let label = load_label(&connection, &decision.decision_id, &hash)?;
            if let Some(label) = &label {
                labelled += 1;
                label_models.insert(format!(
                    "{} ({})",
                    label.model,
                    &label.model_sha256[..label.model_sha256.len().min(12)]
                ));
                samples.add(
                    &DecisionFamily::of(decision).key(),
                    label,
                    &decision.played.action,
                );
            }
        }
    }
    report.labelled_decisions = labelled;
    report.unlabelled_decisions = report.decisions_seen - labelled;
    report.weak_policy_decisions = weak_policy_decisions;
    if !label_models.is_empty() {
        report.label_source = "cache".to_string();
        report.label_models = label_models.into_iter().collect();
    }
    let cuts: LabelCuts = samples
        .label_cuts(&options.percentiles)
        .map_err(SelectionError::Threshold)?;

    // Pass 2: evaluate and aggregate.
    let mut replay_families: BTreeMap<String, SelectorReplayFamilyStats> = replay_counts
        .iter()
        .map(|(family, replays)| {
            (
                family.clone(),
                SelectorReplayFamilyStats {
                    replays: *replays,
                    ..SelectorReplayFamilyStats::default()
                },
            )
        })
        .collect();
    for path in &files {
        let walk = match walk_path(path) {
            Ok(walk) => walk,
            Err(err) => {
                push_error(
                    &mut errors,
                    format!("{}: second walk failed: {err}", path.display()),
                );
                continue;
            }
        };
        let replay_family = family_of_path(path, &replays);
        let replay_seats = seats
            .get(walk.replay_id.as_str())
            .cloned()
            .unwrap_or_default();
        for decision in &walk.decisions {
            let hash = state_hash(&decision.state);
            let label = load_label(&connection, &decision.decision_id, &hash)?;
            let weak = actor_policy(&replay_seats, decision.seat);
            let triggers = match &label {
                Some(label) => evaluate_with_label(decision, label, &cuts, &options.trigger),
                None => evaluate_cheap(decision, &options.trigger),
            };
            let verdicts =
                evaluate_specials(decision, label.as_ref(), &cuts, weak, &options.special);
            let family_stats = replay_families.entry(replay_family.clone()).or_default();
            family_stats.decisions += 1;
            if label.is_some() {
                family_stats.labelled += 1;
            }
            if weak.is_some_and(SeatPolicy::is_weak) {
                family_stats.weak_policy_decisions += 1;
            }
            for verdict in &verdicts {
                let Some(trigger) = trigger_for(verdict.family) else {
                    continue;
                };
                let fired = triggers.fired(trigger);
                let stats = report
                    .selectors
                    .iter_mut()
                    .find(|stats| stats.family == verdict.family)
                    .expect("every special family has a stats row");
                stats.record(verdict, fired, label.is_some());
                if verdict.accepted {
                    *family_stats
                        .accepted
                        .entry(verdict.family.as_str().to_string())
                        .or_insert(0) += 1;
                }
            }
        }
    }
    report.replay_families = replay_families.into_iter().collect();
    report.errors = errors;
    Ok(report)
}

fn actor_policy(seats: &[SeatPolicy], seat: usize) -> Option<&SeatPolicy> {
    seats.iter().find(|policy| policy.seat == seat)
}

/// Every replay's provenance seats, keyed by replay id.
type ReplaySeats = BTreeMap<String, Vec<SeatPolicy>>;

/// Load every replay's provenance seats, keyed by replay id.
fn load_seats(connection: &Connection) -> Result<(ReplaySeats, Vec<String>), SelectionError> {
    let mut statement = connection.prepare("SELECT replay_id, provenance_json FROM replays")?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut seats = BTreeMap::new();
    let mut errors = Vec::new();
    for row in rows {
        let (replay_id, provenance_json) = row?;
        match serde_json::from_str::<GameProvenance>(&provenance_json) {
            Ok(provenance) => {
                let policies: Vec<SeatPolicy> = provenance
                    .seats
                    .iter()
                    .map(|seat| SeatPolicy {
                        seat: usize::from(seat.seat),
                        agent_id: seat.agent_id.clone(),
                        kind: seat.kind,
                        engine: seat.engine.clone(),
                    })
                    .collect();
                seats.insert(replay_id, policies);
            }
            Err(err) => push_error(
                &mut errors,
                format!("replay {replay_id}: provenance JSON: {err}"),
            ),
        }
    }
    Ok((seats, errors))
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

fn push_error(errors: &mut Vec<String>, error: String) {
    const MAX_ERRORS: usize = 100;
    if errors.len() < MAX_ERRORS {
        errors.push(error);
    }
}
