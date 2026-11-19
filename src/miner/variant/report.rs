//! The variant yield report and the reviewer's yield-policy file.
//!
//! The report is `riichiprac.variant-report` v1. §4.7 requires it to carry the
//! per-transform/per-lesson attempt/preserve/reject counts, the disabled pairs,
//! the caps that truncated a base, the pack's variant share and its largest
//! single-base share. The P1a `pack report` prints the pack-side view; this
//! document is the stage-side one that answers "which transform earns its
//! volume?".
//!
//! Counts are per `(lesson, family)`. A composed chain counts once under each
//! family it contains, because the question the report answers is "does this
//! family preserve this lesson?", not "does this exact pair of families?". A
//! pair below [`VariantConfig::min_yield`](super::VariantConfig::min_yield) is
//! disabled unless a reviewer opts it back in through a
//! [`YieldPolicy`]; a disabled pair's variants are withdrawn before the caps
//! run, so nothing from a pair the stage just measured as unreliable ships.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::{
    TransformFamily, VARIANT_SCHEMA, VARIANT_VERSION, VariantError, YIELD_POLICY_SCHEMA,
    YIELD_POLICY_VERSION,
};

/// One reviewer decision that keeps a transform/lesson pair enabled.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairOverride {
    /// Lesson id, or `mortal_best`/`mistake` for a label without a lesson.
    pub lesson: String,
    /// The transform family.
    pub transform: TransformFamily,
    /// `true` keeps the pair enabled; `false` explicitly disables it.
    pub enabled: bool,
    /// Why the reviewer decided this.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// A reviewer's yield-policy file (`riichiprac.variant-yield-policy` v1).
///
/// Feed it back with `--yield-policy` after inspecting a run: a pair that fell
/// below the threshold stays disabled unless an entry here says `enabled:
/// true`. The file is an append-only human decision, never an automatic pass.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct YieldPolicy {
    /// [`YIELD_POLICY_SCHEMA`].
    #[serde(default = "policy_schema")]
    pub schema: String,
    /// [`YIELD_POLICY_VERSION`].
    #[serde(default = "policy_version")]
    pub version: u32,
    /// The reviewer's pair decisions.
    #[serde(default)]
    pub pairs: Vec<PairOverride>,
}

fn policy_schema() -> String {
    YIELD_POLICY_SCHEMA.to_string()
}

const fn policy_version() -> u32 {
    YIELD_POLICY_VERSION
}

impl Default for YieldPolicy {
    fn default() -> Self {
        Self {
            schema: policy_schema(),
            version: policy_version(),
            pairs: Vec::new(),
        }
    }
}

impl YieldPolicy {
    /// Read and validate a policy file.
    pub fn read(path: &std::path::Path) -> Result<Self, VariantError> {
        let text = std::fs::read_to_string(path).map_err(|source| VariantError::Io {
            path: path.display().to_string(),
            source,
        })?;
        let policy: Self = serde_json::from_str(&text)?;
        if policy.schema != YIELD_POLICY_SCHEMA {
            return Err(VariantError::Config(format!(
                "`{}` names schema `{}`, expected `{YIELD_POLICY_SCHEMA}`",
                path.display(),
                policy.schema
            )));
        }
        if policy.version != YIELD_POLICY_VERSION {
            return Err(VariantError::Config(format!(
                "`{}` has version {}, expected {YIELD_POLICY_VERSION}",
                path.display(),
                policy.version
            )));
        }
        Ok(policy)
    }

    /// The override for one pair, when present.
    #[must_use]
    pub fn get(&self, lesson: &str, transform: TransformFamily) -> Option<&PairOverride> {
        self.pairs
            .iter()
            .find(|pair| pair.lesson == lesson && pair.transform == transform)
    }
}

/// Attempts, keeps and rejection reasons for one transform/lesson pair.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PairYield {
    /// Lesson id, or `mortal_best`/`mistake` for a label without a lesson.
    pub lesson: String,
    /// The transform family.
    pub transform: TransformFamily,
    /// Chains that contained this family.
    pub attempted: u64,
    /// Chains that contained this family and preserved the label.
    pub preserved: u64,
    /// `preserved / attempted`, `0.0` when nothing was attempted.
    pub ratio: f32,
    /// Whether the pair is disabled for the next run.
    pub disabled: bool,
    /// Stable rejection reason → count.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub rejections: BTreeMap<String, u64>,
}

impl PairYield {
    /// True when the pair met [`VariantConfig::min_yield`](super::VariantConfig::min_yield).
    #[must_use]
    pub fn meets(&self, min_yield: f32) -> bool {
        self.ratio >= min_yield
    }
}

/// One transform/lesson pair the stage disabled.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DisabledPair {
    /// Lesson id.
    pub lesson: String,
    /// The transform family.
    pub transform: TransformFamily,
    /// Measured yield.
    pub ratio: f32,
    /// The configured threshold.
    pub min_yield: f32,
    /// Additional attempts; zero when the policy denies the family outright.
    pub attempted: u64,
    /// Whether a reviewer explicitly opted this pair in.
    pub reviewed: bool,
    /// Stable reason (`below_threshold`, `reviewer_disabled`).
    pub reason: String,
}

/// Why the per-base cap is what it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapCause {
    /// [`VariantConfig::max_per_base`](super::VariantConfig::max_per_base) is smaller.
    PerBase,
    /// The per-pack share is smaller than the per-base cap.
    PackShare,
}

impl CapCause {
    /// Stable report spelling.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::PerBase => "per_base",
            Self::PackShare => "pack_share",
        }
    }
}

/// One base whose variant count the cap truncated.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapTruncation {
    /// Base scenario id.
    pub base: String,
    /// Preserved variants the base produced.
    pub preserved: u64,
    /// Variants kept after the cap.
    pub kept: u64,
    /// The effective cap.
    pub cap: usize,
    /// Which rule produced the cap.
    pub cause: CapCause,
}

/// How many scenarios one base contributes to the assembled pack.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BaseShare {
    /// Base scenario id.
    pub base: String,
    /// The base plus its shipped variants.
    pub scenarios: u64,
}

/// The pack-side share summary §4.7 asks for.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ShareReport {
    /// Bases in the run.
    pub bases: usize,
    /// Shipped variants.
    pub variants: u64,
    /// Scenarios in the assembled pack (bases + shipped variants).
    pub pack_scenarios: u64,
    /// `variants / pack_scenarios`.
    pub variant_share: f32,
    /// The base that contributes the most.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub largest_base: Option<BaseShare>,
    /// The largest base's scenarios as a share of the pack.
    pub largest_base_share: f32,
    /// Distinct transform families in the shipped set (the first family of
    /// each chain), sorted.
    #[serde(default)]
    pub transform_families: Vec<String>,
    /// Shipped variants per first family.
    #[serde(default)]
    pub by_family: BTreeMap<String, u64>,
    /// Shipped variants per chain signature, e.g. `suit_perm+rank_mirror`.
    #[serde(default)]
    pub by_chain: BTreeMap<String, u64>,
}

/// Model-label cache activity during the run.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LabelActivity {
    /// Labels served by the L1 cache.
    pub cached: u64,
    /// First evaluations.
    pub evaluated: u64,
    /// Failed evaluations retried successfully.
    pub retried: u64,
}

/// One variant run's `riichiprac.variant-report` v1.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VariantReport {
    /// [`VARIANT_SCHEMA`].
    #[serde(default = "report_schema")]
    pub schema: String,
    /// [`VARIANT_VERSION`].
    #[serde(default = "report_version")]
    pub version: u32,
    /// When the run finished.
    pub generated_at: String,
    /// Pack id the variants belong to.
    pub pack_id: String,
    /// Base scenarios the run consumed.
    pub bases: usize,
    /// Variants requested per base.
    pub variants_per_base: usize,
    /// Planned chain attempts.
    pub attempts: u64,
    /// Chains whose label survived.
    pub preserved: u64,
    /// Variants in the shipped set.
    pub shipped: u64,
    /// Preserved variants withdrawn because a pair was disabled.
    pub withdrawn_disabled: u64,
    /// Preserved variants dropped by a cap.
    pub dropped_by_cap: u64,
    /// Chains rejected as a duplicate state.
    pub duplicate_states: u64,
    /// Chains rejected before/at the gate, by stable reason.
    pub rejections: BTreeMap<String, u64>,
    /// Per transform/lesson yield.
    pub pair_yield: Vec<PairYield>,
    /// Pairs disabled for the next run.
    pub disabled_pairs: Vec<DisabledPair>,
    /// Bases the cap truncated.
    pub cap_limited: Vec<CapTruncation>,
    /// The effective per-base cap.
    pub effective_cap: usize,
    /// Which rule set the cap.
    pub cap_cause: CapCause,
    /// The configured minimum yield.
    pub min_yield: f32,
    /// Shipped labels by kind.
    pub label_kinds: BTreeMap<String, u64>,
    /// Cache activity for the model labels V2 re-ran.
    pub labels: LabelActivity,
    /// Pack-side share summary.
    pub share: ShareReport,
    /// Resolved worker threads this run used (`0` was requested as every core).
    #[serde(default)]
    pub workers: usize,
    /// Wall time of the whole run, in milliseconds.
    #[serde(default)]
    pub wall_time_ms: u64,
    /// Answer-free notes for the operator.
    #[serde(default)]
    pub notes: Vec<String>,
    /// Per-base or per-replay errors (never the whole run's failure).
    #[serde(default)]
    pub errors: Vec<String>,
}

fn report_schema() -> String {
    VARIANT_SCHEMA.to_string()
}

const fn report_version() -> u32 {
    VARIANT_VERSION
}

impl VariantReport {
    /// An empty report skeleton for a run that produced nothing.
    #[must_use]
    pub fn empty(generated_at: impl Into<String>, pack_id: impl Into<String>) -> Self {
        Self {
            schema: report_schema(),
            version: report_version(),
            generated_at: generated_at.into(),
            pack_id: pack_id.into(),
            bases: 0,
            variants_per_base: 0,
            attempts: 0,
            preserved: 0,
            shipped: 0,
            withdrawn_disabled: 0,
            dropped_by_cap: 0,
            duplicate_states: 0,
            rejections: BTreeMap::new(),
            pair_yield: Vec::new(),
            disabled_pairs: Vec::new(),
            cap_limited: Vec::new(),
            effective_cap: 0,
            cap_cause: CapCause::PerBase,
            min_yield: 0.0,
            label_kinds: BTreeMap::new(),
            labels: LabelActivity::default(),
            share: ShareReport {
                bases: 0,
                variants: 0,
                pack_scenarios: 0,
                variant_share: 0.0,
                largest_base: None,
                largest_base_share: 0.0,
                transform_families: Vec::new(),
                by_family: BTreeMap::new(),
                by_chain: BTreeMap::new(),
            },
            workers: 0,
            wall_time_ms: 0,
            notes: Vec::new(),
            errors: Vec::new(),
        }
    }

    /// True when every shipped variant was label-preserving (always true: the
    /// stage ships nothing else) and no `errors` are recorded.
    #[must_use]
    pub fn is_clean(&self) -> bool {
        self.errors.is_empty()
    }

    /// Whether the acceptance rehearsal condition holds: at least two transform
    /// families shipped and no base above the cap.
    #[must_use]
    pub fn meets_rehearsal(&self) -> bool {
        self.share.transform_families.len() >= 2
            && self
                .share
                .largest_base
                .as_ref()
                .is_none_or(|base| base.scenarios <= 1 + self.effective_cap as u64)
    }

    /// A human-readable summary, one line per fact.
    #[must_use]
    pub fn human_summary(&self) -> Vec<String> {
        let mut lines = Vec::new();
        lines.push(format!(
            "mine_replays transform: pack `{}` at {}",
            self.pack_id, self.generated_at
        ));
        lines.push(format!(
            "  bases {}; variants requested/base {}; attempts {}; preserved {}; shipped {}",
            self.bases, self.variants_per_base, self.attempts, self.preserved, self.shipped
        ));
        lines.push(format!(
            "  withdrawn (disabled pair) {}; dropped by cap {}; duplicate states {}; errors {}",
            self.withdrawn_disabled,
            self.dropped_by_cap,
            self.duplicate_states,
            self.errors.len()
        ));
        lines.push(format!(
            "  cap {} per base ({}); min yield {:.0}%; model labels: {} cached, {} evaluated",
            self.effective_cap,
            self.cap_cause.as_str(),
            self.min_yield * 100.0,
            self.labels.cached,
            self.labels.evaluated
        ));
        lines.push(format!(
            "  ran in {} ms on {} worker thread(s)",
            self.wall_time_ms, self.workers
        ));
        lines.push(format!(
            "  pack share: {}/{} scenarios are variants ({:.1}%); largest base {} ({:.1}%)",
            self.share.variants,
            self.share.pack_scenarios,
            self.share.variant_share * 100.0,
            self.share.largest_base.as_ref().map_or_else(
                || "none".to_string(),
                |base| format!("`{}` with {}", base.base, base.scenarios)
            ),
            self.share.largest_base_share * 100.0
        ));
        lines.push(format!(
            "  transform families: {}",
            if self.share.transform_families.is_empty() {
                "none".to_string()
            } else {
                self.share.transform_families.join(", ")
            }
        ));
        if !self.disabled_pairs.is_empty() {
            let shown: Vec<String> = self
                .disabled_pairs
                .iter()
                .take(8)
                .map(|pair| {
                    format!(
                        "{}/{} ({:.0}%, {})",
                        pair.lesson,
                        pair.transform,
                        pair.ratio * 100.0,
                        pair.reason
                    )
                })
                .collect();
            let extra = self.disabled_pairs.len().saturating_sub(shown.len());
            lines.push(format!(
                "  disabled pairs ({}): {}{}",
                self.disabled_pairs.len(),
                shown.join(", "),
                if extra > 0 {
                    format!("; and {extra} more")
                } else {
                    String::new()
                }
            ));
        }
        if !self.rejections.is_empty() {
            let reasons: Vec<String> = self
                .rejections
                .iter()
                .map(|(reason, count)| format!("{reason}={count}"))
                .collect();
            lines.push(format!("  rejections: {}", reasons.join(", ")));
        }
        for note in &self.notes {
            lines.push(format!("  note: {note}"));
        }
        for error in &self.errors {
            lines.push(format!("  error: {error}"));
        }
        lines
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_yield_policy_round_trips() {
        let policy = YieldPolicy {
            pairs: vec![PairOverride {
                lesson: "pinfu_head".to_string(),
                transform: TransformFamily::RankMirror,
                enabled: true,
                note: Some("reviewed".to_string()),
            }],
            ..YieldPolicy::default()
        };
        let json = serde_json::to_string(&policy).expect("serialises");
        let parsed: YieldPolicy = serde_json::from_str(&json).expect("parses");
        assert_eq!(parsed, policy);
        assert!(
            policy
                .get("pinfu_head", TransformFamily::RankMirror)
                .is_some_and(|pair| pair.enabled)
        );
        assert!(
            policy
                .get("pinfu_head", TransformFamily::SuitPerm)
                .is_none()
        );
    }

    #[test]
    fn an_empty_report_is_serialisable_and_serialises_its_schema() {
        let report = VariantReport::empty("2026-11-17T00:00:00Z", "test");
        let json = serde_json::to_value(&report).expect("serialises");
        assert_eq!(json["schema"], VARIANT_SCHEMA);
        assert_eq!(json["version"], VARIANT_VERSION);
        assert!(!report.meets_rehearsal());
        assert!(report.is_clean());
    }
}
