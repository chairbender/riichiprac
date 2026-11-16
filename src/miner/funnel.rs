//! Ordered funnel counter for corpus and selection reports.
//!
//! The plan requires one row per corpus family with requested/generated/parsed/
//! valid counts, decision points, trigger hits, labels and selections, plus a
//! breakdown of rejection reasons (`replay-implementation-plan.md` §3.6, G3).
//! Every later unit bumps the same counter so a shortfall is visible instead of
//! silently substituting another family.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Ordered pipeline stages. The declaration order is the report order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FunnelStage {
    /// Games the match plan asked for.
    GamesRequested,
    /// Games the runner produced.
    GamesGenerated,
    /// Games the parser accepted.
    GamesParsed,
    /// Games that passed structural validation.
    GamesValid,
    /// Decision points enumerated.
    DecisionPoints,
    /// Candidates whose trigger fired.
    TriggerHits,
    /// Candidates a book classifier matched.
    BookMatches,
    /// Candidates labelled by Mortal.
    MortalLabelled,
    /// Scenarios selected for a pack.
    Selected,
}

/// A monotonic count of successful stages plus rejection reasons.
///
/// Rejections do not decrement an earlier stage: the report keeps both so the
/// pass rate can be computed and every dropped item is attributable.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FunnelCounter {
    #[serde(default)]
    counts: BTreeMap<FunnelStage, u64>,
    #[serde(default)]
    rejections: BTreeMap<String, u64>,
}

impl FunnelCounter {
    /// An empty counter.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Increment a stage by one.
    pub fn bump(&mut self, stage: FunnelStage) {
        self.add(stage, 1);
    }

    /// Increment a stage by `n` (saturating at `u64::MAX`).
    pub fn add(&mut self, stage: FunnelStage, n: u64) {
        let entry = self.counts.entry(stage).or_insert(0);
        *entry = entry.saturating_add(n);
    }

    /// Count reached by one stage.
    #[must_use]
    pub fn count(&self, stage: FunnelStage) -> u64 {
        self.counts.get(&stage).copied().unwrap_or(0)
    }

    /// Record one rejection with a stable reason string.
    ///
    /// A blank reason becomes `unspecified` so a report cannot hide a drop
    /// behind an empty label.
    pub fn reject(&mut self, reason: &str) {
        let reason = reason.trim();
        let reason = if reason.is_empty() {
            "unspecified"
        } else {
            reason
        };
        let entry = self.rejections.entry(reason.to_string()).or_insert(0);
        *entry = entry.saturating_add(1);
    }

    /// Record `n` rejections with one reason.
    pub fn reject_many(&mut self, reason: &str, n: u64) {
        for _ in 0..n {
            self.reject(reason);
        }
    }

    /// Rejection counts keyed by reason.
    #[must_use]
    pub fn rejections(&self) -> &BTreeMap<String, u64> {
        &self.rejections
    }

    /// Total rejected items across all reasons.
    #[must_use]
    pub fn total_rejected(&self) -> u64 {
        self.rejections.values().copied().sum()
    }

    /// Conversion from one stage to another, or `None` when the denominator
    /// is zero (not 0%, which would be misleading).
    #[must_use]
    pub fn pass_rate(&self, from: FunnelStage, to: FunnelStage) -> Option<f64> {
        let denominator = self.count(from);
        if denominator == 0 {
            return None;
        }
        Some(self.count(to) as f64 / denominator as f64)
    }

    /// Whether every recorded count is zero.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.counts.values().all(|count| *count == 0) && self.rejections.is_empty()
    }

    /// Counts in pipeline order, including zero-valued stages.
    #[must_use]
    pub fn stages(&self) -> Vec<(FunnelStage, u64)> {
        const ALL: [FunnelStage; 9] = [
            FunnelStage::GamesRequested,
            FunnelStage::GamesGenerated,
            FunnelStage::GamesParsed,
            FunnelStage::GamesValid,
            FunnelStage::DecisionPoints,
            FunnelStage::TriggerHits,
            FunnelStage::BookMatches,
            FunnelStage::MortalLabelled,
            FunnelStage::Selected,
        ];
        ALL.iter()
            .map(|stage| (*stage, self.count(*stage)))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_are_monotonic_and_report_in_pipeline_order() {
        let mut funnel = FunnelCounter::new();
        funnel.add(FunnelStage::GamesRequested, 1000);
        funnel.add(FunnelStage::GamesGenerated, 1000);
        funnel.add(FunnelStage::GamesParsed, 995);
        funnel.add(FunnelStage::GamesValid, 990);

        assert_eq!(funnel.count(FunnelStage::GamesRequested), 1000);
        assert_eq!(
            funnel.pass_rate(FunnelStage::GamesGenerated, FunnelStage::GamesParsed),
            Some(0.995)
        );
        assert_eq!(
            funnel.pass_rate(FunnelStage::GamesRequested, FunnelStage::GamesGenerated),
            Some(1.0)
        );

        let stages = funnel.stages();
        assert_eq!(stages.first(), Some(&(FunnelStage::GamesRequested, 1000)));
        assert_eq!(stages.last(), Some(&(FunnelStage::Selected, 0)));
        assert!(!funnel.is_empty());
    }

    #[test]
    fn empty_denominator_has_no_pass_rate() {
        let funnel = FunnelCounter::new();
        assert_eq!(
            funnel.pass_rate(FunnelStage::GamesGenerated, FunnelStage::GamesValid),
            None
        );
        assert!(funnel.is_empty());
    }

    #[test]
    fn rejections_are_grouped_and_blank_is_named() {
        let mut funnel = FunnelCounter::new();
        funnel.reject("tile_ledger");
        funnel.reject("tile_ledger");
        funnel.reject("  ");
        funnel.reject_many("illegal_action", 3);

        assert_eq!(funnel.rejections().get("tile_ledger"), Some(&2));
        assert_eq!(funnel.rejections().get("unspecified"), Some(&1));
        assert_eq!(funnel.rejections().get("illegal_action"), Some(&3));
        assert_eq!(funnel.total_rejected(), 6);
    }

    #[test]
    fn funnel_round_trips_through_json() {
        let mut funnel = FunnelCounter::new();
        funnel.add(FunnelStage::GamesRequested, 10);
        funnel.add(FunnelStage::GamesValid, 9);
        funnel.reject("tile_ledger");

        let json = serde_json::to_string(&funnel).expect("serialize");
        let parsed: FunnelCounter = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(parsed, funnel);
        assert_eq!(parsed.count(FunnelStage::GamesValid), 9);

        let raw: serde_json::Value = serde_json::from_str(&json).expect("json");
        assert_eq!(raw["counts"]["games_requested"], 10);
        assert_eq!(raw["rejections"]["tile_ledger"], 1);
    }
}
