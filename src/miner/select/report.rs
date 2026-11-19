//! The selection report and its human summary (implementation unit S2).
//!
//! One report per `mine_replays select` run. It is the operator's evidence that
//! selection did what it claims:
//!
//! - the funnel `raw → trigger → reconstructed → valid → classified → labelled →
//!   selected → packed` with the rejection reasons at every stage;
//! - one row per gate (first-failure counts, so the rows add up to the funnel's
//!   valid row);
//! - family quotas against what the pack actually took, including an explicit
//!   shortfall reason;
//! - the book-section, decision-kind and turn-bucket distribution against their
//!   caps;
//! - the exact/near dedupe counts and the held-out QA size;
//! - the percentile samples the confidence and tension signals were measured
//!   against, so a "confidence 0.9" is traceable to a sample size.
//!
//! `packed` stays `0`: S2 stops at the review queue. P1b owns pack assembly.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::miner::funnel::{FunnelCounter, FunnelStage};
use crate::miner::trigger::families::Family;

use super::gate::GateKind;
use super::quota::QuotaCaps;
use super::score::{SampleSummary, ScoreWeights};
use super::{BucketQuotaRow, FamilyQuotaRow};

/// The selection report's schema version.
pub const REPORT_VERSION: u32 = 1;

/// One gate's first-failure count.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GateStats {
    /// The gate.
    pub gate: GateKind,
    /// Candidates whose **first** failing gate was this one.
    pub rejected: u64,
}

/// Exact and near duplicate counts.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct DedupeStats {
    /// Candidates with the same model-visible state hash as an already selected
    /// candidate.
    pub exact: u64,
    /// Candidates with the same literal visible table as an already selected
    /// candidate, but a different hidden-hand state.
    pub near: u64,
}

impl DedupeStats {
    /// Total duplicates skipped.
    #[must_use]
    pub fn total(&self) -> u64 {
        self.exact + self.near
    }
}

/// The held-out QA split.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct HeldOutStats {
    /// How many the configured share asks for.
    pub target: usize,
    /// How many were actually kept (the pool may be smaller, or duplicate-heavy).
    pub kept: usize,
}

/// One selection run's machine-readable report.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SelectionReport {
    /// `riichiprac.selection-report`.
    pub schema: String,
    /// Schema version.
    pub version: u32,
    /// When the run finished, `YYYYMMDD-HHMMSS` UTC.
    pub generated_at: String,
    /// Pack id.
    pub pack_id: String,
    /// Requested pack size.
    pub pack_size: usize,
    /// Replay files discovered.
    pub replays_found: usize,
    /// Replays walked cleanly.
    pub replays_walked: usize,
    /// Replays that failed to read or validate.
    pub replays_failed: usize,
    /// Decisions the walker produced.
    pub decisions_seen: u64,
    /// Decisions the walker's reachability guard dropped.
    pub decisions_dropped: u64,
    /// Decisions that carried a cached label.
    pub decisions_labelled: u64,
    /// Decisions with a book label.
    pub decisions_classified: u64,
    /// Decisions with at least one trigger hit.
    pub decisions_triggered: u64,
    /// Decisions that passed every non-dedupe gate.
    pub candidates_valid: u64,
    /// Candidates kept out for QA.
    pub candidates_held_out: u64,
    /// Candidates selected into the queue.
    pub candidates_selected: u64,
    /// The ordered funnel.
    pub funnel: FunnelCounter,
    /// Gate rejections by first failure, in gate order.
    pub gates: Vec<GateStats>,
    /// Duplicate counts.
    pub dedupe: DedupeStats,
    /// Scenarios selected beyond a diversity cap after the relaxed fill.
    pub cap_relaxed: u64,
    /// Slots filled after the quota round (open slots plus the relaxed fill).
    pub relaxed_fill: u64,
    /// The held-out split.
    pub held_out: HeldOutStats,
    /// One row per family.
    pub families: Vec<FamilyQuotaRow>,
    /// Book-section distribution.
    pub sections: Vec<BucketQuotaRow>,
    /// Decision-kind distribution.
    pub kinds: Vec<BucketQuotaRow>,
    /// Turn-bucket distribution.
    pub turns: Vec<BucketQuotaRow>,
    /// Corpus (replay) family distribution.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub replay_families: Vec<BucketQuotaRow>,
    /// Integer quotas actually used.
    pub quotas: BTreeMap<Family, usize>,
    /// Integer caps actually used.
    pub caps: QuotaCaps,
    /// The composite weights.
    pub weights: ScoreWeights,
    /// Per-decision-family percentile samples.
    pub percentiles: Vec<SampleSummary>,
    /// Relative path of the review queue.
    pub review_queue: String,
    /// Relative path of the held-out QA queue.
    pub held_out_queue: String,
    /// Relative path of this report.
    pub report_path: String,
    /// Resolved worker threads this run used (`0` was requested as every core).
    #[serde(default)]
    pub workers: usize,
    /// Wall time of the whole run, in milliseconds.
    #[serde(default)]
    pub wall_time_ms: u64,
    /// Operator-facing notes (non-failures).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
    /// First errors, in run order (bounded).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<String>,
}

impl SelectionReport {
    /// The funnel rows as `(stage, count)`, in pipeline order.
    #[must_use]
    pub fn funnel_rows(&self) -> Vec<(&'static str, u64)> {
        self.funnel
            .stages()
            .into_iter()
            .map(|(stage, count)| (stage_name(stage), count))
            .collect()
    }

    /// A multi-line summary for the CLI.
    #[must_use]
    pub fn human_summary(&self) -> String {
        let mut out = String::new();
        out.push_str(&format!(
            "mine_replays select: pack `{}` ({} requested), {} replay(s) ({} walked, {} failed)\n",
            self.pack_id,
            self.pack_size,
            self.replays_found,
            self.replays_walked,
            self.replays_failed
        ));
        out.push_str(&format!(
            "  decisions: {} seen ({} walker drops), {} labelled, {} book, {} triggered\n",
            self.decisions_seen,
            self.decisions_dropped,
            self.decisions_labelled,
            self.decisions_classified,
            self.decisions_triggered
        ));
        out.push_str(&format!(
            "  candidates: {} valid, {} held out for QA ({} requested), {} selected\n",
            self.candidates_valid,
            self.held_out.kept,
            self.held_out.target,
            self.candidates_selected
        ));
        out.push_str("  funnel: ");
        let rows = self.funnel_rows();
        let mut parts = Vec::new();
        for (name, count) in rows {
            parts.push(format!("{name}={count}"));
        }
        out.push_str(&parts.join(" -> "));
        out.push('\n');

        if !self.gates.is_empty() {
            out.push_str("  gates: ");
            let parts: Vec<String> = self
                .gates
                .iter()
                .map(|stats| format!("{}={}", stats.gate.as_str(), stats.rejected))
                .collect();
            out.push_str(&parts.join(", "));
            out.push('\n');
        }
        out.push_str(&format!(
            "  dedupe: {} exact, {} near ({} skipped)\n",
            self.dedupe.exact,
            self.dedupe.near,
            self.dedupe.total()
        ));
        if self.relaxed_fill > 0 {
            out.push_str(&format!(
                "  relaxed fill: {} slot(s) after the quota round, {} beyond a cap\n",
                self.relaxed_fill, self.cap_relaxed
            ));
        }

        out.push_str(&format!(
            "  {:<12} {:>6} {:>7} {:>9}  {}\n",
            "family", "quota", "taken", "in-pool", "shortfall"
        ));
        for row in &self.families {
            out.push_str(&format!(
                "  {:<12} {:>6} {:>7} {:>9}  {}\n",
                row.family.as_str(),
                row.quota,
                row.selected,
                row.candidates,
                row.shortfall.as_deref().unwrap_or("ok")
            ));
        }

        print_buckets(&mut out, "book section", &self.sections);
        print_buckets(&mut out, "decision kind", &self.kinds);
        print_buckets(&mut out, "turn bucket", &self.turns);
        print_buckets(&mut out, "corpus family", &self.replay_families);

        out.push_str(&format!(
            "  review queue: {} ({} item(s))\n",
            self.review_queue, self.candidates_selected
        ));
        out.push_str(&format!(
            "  held-out QA: {} ({} item(s))\n",
            self.held_out_queue, self.held_out.kept
        ));
        out.push_str(&format!("  report: {}\n", self.report_path));
        for note in &self.notes {
            out.push_str(&format!("  note: {note}\n"));
        }
        for error in &self.errors {
            out.push_str(&format!("  error: {error}\n"));
        }
        out
    }
}

fn print_buckets(out: &mut String, label: &str, rows: &[BucketQuotaRow]) {
    if rows.is_empty() {
        return;
    }
    let cap = rows
        .iter()
        .find_map(|row| row.cap)
        .map_or_else(|| "-".to_string(), |cap| cap.to_string());
    out.push_str(&format!("  {label} (cap {cap}):\n"));
    for row in rows {
        let cap = row
            .cap
            .map_or_else(|| "-".to_string(), |cap| cap.to_string());
        out.push_str(&format!(
            "    {:<20} {:>4}/{:<4} taken ({} in pool){}{}\n",
            row.bucket,
            row.selected,
            cap,
            row.candidates,
            if row.cap_reached { " [cap]" } else { "" },
            if row.relaxed > 0 {
                format!(" +{} relaxed", row.relaxed)
            } else {
                String::new()
            }
        ));
    }
}

fn stage_name(stage: FunnelStage) -> &'static str {
    match stage {
        FunnelStage::GamesRequested => "raw",
        FunnelStage::GamesGenerated => "generated",
        FunnelStage::GamesParsed => "parsed",
        FunnelStage::GamesValid => "games_valid",
        FunnelStage::DecisionPoints => "decisions",
        FunnelStage::TriggerHits => "trigger",
        FunnelStage::Reconstructed => "reconstructed",
        FunnelStage::BookMatches => "classified",
        FunnelStage::MortalLabelled => "labelled",
        FunnelStage::GatePassed => "valid",
        FunnelStage::HeldOut => "held_out",
        FunnelStage::Selected => "selected",
        FunnelStage::Packed => "packed",
    }
}
