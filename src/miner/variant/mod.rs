//! Label-preserving scenario variants (implementation unit V2).
//!
//! V1 built the permutation engine ([`crate::miner::transform`]): the five
//! catalogue transforms, their inverses and the `riichiprac.scenario-transforms`
//! provenance document. This module makes permutation a **pipeline stage**
//! (`replay-implementation-plan.md` §4 and §5.3):
//!
//! ```text
//! selected base scenarios
//!         │  per-lesson TransformPolicy (§4.5)
//!         ▼
//!   planned transform chain ──► V1 apply ──► recompute derived fields
//!         │                                      │
//!         │                          reachability + tile ledger + legal answer
//!         │                                      │
//!         │                         label-preservation gate (§4.4)
//!         │            book: lesson + answer         mortal: top-1 + margin band
//!         │            mistake: played action         contested: both halves
//!         ▼                                      │
//!   reject with a stable reason  ◄───────────────┤
//!                                                ▼
//!                          pair-yield report ──► disable pairs below 50 %
//!                                                ▼
//!                          dedupe + per-base / per-pack caps (§4.6)
//!                                                ▼
//!                             gated PackScenario variants ──► P1a pack gate
//! ```
//!
//! # What this stage owns
//!
//! - **Per-lesson policy.** The policy lives on the classifier
//!   ([`crate::classifier::TransformPolicy`]) because the lesson is the thing
//!   that declares its own invariance. An unclassified label (Mortal-only) has
//!   no lesson to opt in, so it uses [`VariantConfig::mortal_policy`], which
//!   defaults to deny for every transform. A missing opt-in loses volume; a
//!   wrong opt-in ships a broken drill (§4.5).
//! - **Label preservation.** Re-run the classifier/labeler on the transformed
//!   state and require the inverse-mapped answer to match the base. A failure
//!   is a rejection, never a hand-edited label (§4.4).
//! - **Volume control.** The per-transform/per-lesson yield report disables a
//!   pair below [`VariantConfig::min_yield`] unless a reviewer opts it back in;
//!   exact state hashes collapse; a base may contribute at most
//!   [`VariantConfig::max_per_base`] variants and at most
//!   [`VariantConfig::max_pack_share`] of the pack (§4.6).
//! - **Provenance.** Every shipped variant carries `variant_of`,
//!   `transform_chain`, `transform_seed` and `label_check`, which is exactly
//!   what the P1a pack gate re-checks before it writes a pack.
//!
//! # What this stage does not own
//!
//! It does not select base scenarios (S2 does), does not publish a curated pack
//! (P1b does) and does not decide whether a scenario teaches (the review queue
//! does). Its output is the gated variant set plus the yield report; the pack
//! assembly path is [`stage::build_pack`], which runs the P1a gate so an
//! ungated variant can never reach a pack.

pub mod base;
pub mod gate;
pub mod persist;
pub mod plan;
pub mod rehearsal;
pub mod report;
pub mod run;
pub mod stage;

#[cfg(test)]
mod tests;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::classifier::{Allowed, TransformPolicy};
use crate::miner::label::LabelError;
use crate::miner::pack::PackError;
use crate::miner::storage::StorageError;
use crate::miner::transform::{Transform, TransformError};

pub use base::{BaseLabel, BaseScenario};
pub use gate::{GateDeps, GatedState, Reject, VariantLabeler};
pub use plan::{PlannedChain, plan_for};
pub use report::{
    BaseShare, CapCause, CapTruncation, DisabledPair, PairOverride, PairYield, ShareReport,
    VariantReport, YieldPolicy,
};
pub use run::{VariantPaths, VariantRunOptions, VariantRunOutcome, run_variants, variant_paths};
pub use stage::{StageOutcome, VariantRecord, VariantStage, build_pack};

/// Schema name of the variant yield report.
pub const VARIANT_SCHEMA: &str = "riichiprac.variant-report";

/// Version of the variant yield report.
pub const VARIANT_VERSION: u32 = crate::miner::JSON_SCHEMA_VERSION;

/// Schema name of a reviewer's yield-policy file.
pub const YIELD_POLICY_SCHEMA: &str = "riichiprac.variant-yield-policy";

/// Version of the yield-policy file.
pub const YIELD_POLICY_VERSION: u32 = crate::miner::JSON_SCHEMA_VERSION;

/// Default number of variants the stage tries to keep per base.
pub const DEFAULT_VARIANTS_PER_BASE: usize = 3;

/// Default maximum variants one base may contribute (§4.6).
pub const DEFAULT_MAX_PER_BASE: usize = 8;

/// Default maximum share of a pack one base may occupy (§4.6).
pub const DEFAULT_PACK_SHARE: f32 = 0.20;

/// Default pack size the per-pack share is measured against.
pub const DEFAULT_PACK_SIZE: usize = 100;

/// Default minimum yield for a transform/lesson pair to stay enabled (§4.7).
pub const DEFAULT_MIN_YIELD: f32 = 0.50;

/// Default seed the transform parameters are drawn from.
pub const DEFAULT_TRANSFORM_SEED: &str = "0x51";

/// A transform family without its parameters.
///
/// The five catalogue transforms are the families the yield report and the
/// policy use; a concrete [`Transform`] is a family plus parameters.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransformFamily {
    /// Permute the three opponents around the actor.
    SeatPerm,
    /// Relabel the three numbered suits.
    SuitPerm,
    /// Mirror ranks inside each suit.
    RankMirror,
    /// Rotate the four winds.
    WindRelabel,
    /// Drop the aka identity of the red fives.
    Red5Normalize,
}

impl TransformFamily {
    /// Every family, in the catalogue's order.
    pub const ALL: [Self; 5] = [
        Self::SeatPerm,
        Self::SuitPerm,
        Self::RankMirror,
        Self::WindRelabel,
        Self::Red5Normalize,
    ];

    /// The stable report/JSON spelling.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::SeatPerm => "seat_perm",
            Self::SuitPerm => "suit_perm",
            Self::RankMirror => "rank_mirror",
            Self::WindRelabel => "wind_relabel",
            Self::Red5Normalize => "red5_normalize",
        }
    }

    /// The family a concrete transform belongs to.
    #[must_use]
    pub fn of(transform: &Transform) -> Self {
        match transform {
            Transform::SeatPerm { .. } => Self::SeatPerm,
            Transform::SuitPerm { .. } => Self::SuitPerm,
            Transform::RankMirror {} => Self::RankMirror,
            Transform::WindRelabel { .. } => Self::WindRelabel,
            Transform::Red5Normalize {} => Self::Red5Normalize,
        }
    }

    /// Whether `policy` opts this family in.
    #[must_use]
    pub fn allowed(self, policy: TransformPolicy) -> bool {
        let allowed = match self {
            Self::SeatPerm => policy.seat_perm,
            Self::SuitPerm => policy.suit_perm,
            Self::RankMirror => policy.rank_mirror,
            Self::WindRelabel => policy.wind_relabel,
            Self::Red5Normalize => policy.red5_normalize,
        };
        allowed == Allowed::AllowWithRecompute
    }

    /// Parse the report spelling.
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "seat_perm" => Some(Self::SeatPerm),
            "suit_perm" => Some(Self::SuitPerm),
            "rank_mirror" => Some(Self::RankMirror),
            "wind_relabel" => Some(Self::WindRelabel),
            "red5_normalize" => Some(Self::Red5Normalize),
            _ => None,
        }
    }
}

impl std::fmt::Display for TransformFamily {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Which label a base scenario ships, from the point of view of the gate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VariantLabelKind {
    /// A cited book lesson with an exact answer.
    Book,
    /// A book answer and a Mortal top action that disagree.
    Contested,
    /// The model's top action is the answer.
    Mortal,
    /// A book or model lesson whose drill is the recorded mistake.
    Mistake,
}

impl VariantLabelKind {
    /// The stable spelling used by the label/selection documents.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Book => "book",
            Self::Contested => "contested",
            Self::Mortal => "mortal",
            Self::Mistake => "mistake",
        }
    }

    /// Parse a selection/label spelling. `none` and anything unknown return
    /// `None`: an unlabelled base has no label to preserve.
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "book" => Some(Self::Book),
            "contested" => Some(Self::Contested),
            "mortal" => Some(Self::Mortal),
            "mistake" => Some(Self::Mistake),
            _ => None,
        }
    }

    /// The pack `label_check.kind` this label kind produces.
    #[must_use]
    pub const fn check_kind(self) -> crate::miner::pack::LabelCheckKind {
        match self {
            Self::Book | Self::Contested => crate::miner::pack::LabelCheckKind::Book,
            Self::Mortal => crate::miner::pack::LabelCheckKind::Mortal,
            Self::Mistake => crate::miner::pack::LabelCheckKind::Mistake,
        }
    }
}

/// A serialisable form of a [`TransformPolicy`].
///
/// The classifier's policy is a `const` with `&'static str` note, which cannot
/// round-trip through JSON. This record carries the five opt-ins a config or a
/// reviewer override needs; `true` means [`Allowed::AllowWithRecompute`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct PolicyRecord {
    /// Permit the opponent permutation.
    #[serde(default)]
    pub seat_perm: bool,
    /// Permit the suit bijection.
    #[serde(default)]
    pub suit_perm: bool,
    /// Permit the rank mirror.
    #[serde(default)]
    pub rank_mirror: bool,
    /// Permit the wind rotation.
    #[serde(default)]
    pub wind_relabel: bool,
    /// Permit the red-five normalisation.
    #[serde(default)]
    pub red5_normalize: bool,
}

impl PolicyRecord {
    /// Every transform denied.
    pub const DENY: Self = Self {
        seat_perm: false,
        suit_perm: false,
        rank_mirror: false,
        wind_relabel: false,
        red5_normalize: false,
    };

    /// Project a classifier policy into the serialisable record.
    #[must_use]
    pub fn from_policy(policy: TransformPolicy) -> Self {
        Self {
            seat_perm: policy.seat_perm == Allowed::AllowWithRecompute,
            suit_perm: policy.suit_perm == Allowed::AllowWithRecompute,
            rank_mirror: policy.rank_mirror == Allowed::AllowWithRecompute,
            wind_relabel: policy.wind_relabel == Allowed::AllowWithRecompute,
            red5_normalize: policy.red5_normalize == Allowed::AllowWithRecompute,
        }
    }

    /// Build a classifier policy. The note records that this came from config,
    /// not from the lesson's declaration.
    #[must_use]
    pub fn to_policy(self) -> TransformPolicy {
        let allowed = |allowed: bool| {
            if allowed {
                Allowed::AllowWithRecompute
            } else {
                Allowed::Deny
            }
        };
        TransformPolicy {
            seat_perm: allowed(self.seat_perm),
            suit_perm: allowed(self.suit_perm),
            rank_mirror: allowed(self.rank_mirror),
            wind_relabel: allowed(self.wind_relabel),
            red5_normalize: allowed(self.red5_normalize),
            note: "operator-supplied policy for a label with no lesson opt-in",
        }
    }

    /// Whether one family is permitted.
    #[must_use]
    pub fn allows(self, family: TransformFamily) -> bool {
        match family {
            TransformFamily::SeatPerm => self.seat_perm,
            TransformFamily::SuitPerm => self.suit_perm,
            TransformFamily::RankMirror => self.rank_mirror,
            TransformFamily::WindRelabel => self.wind_relabel,
            TransformFamily::Red5Normalize => self.red5_normalize,
        }
    }
}

/// One variant-stage run's volume and policy configuration.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VariantConfig {
    /// Variants to keep per base (the target, before caps).
    pub variants_per_base: usize,
    /// Maximum variants one base may contribute.
    pub max_per_base: usize,
    /// Maximum share of the pack one base may occupy, `0.0..=1.0`.
    pub max_pack_share: f32,
    /// Pack size the share is measured against.
    pub pack_size: usize,
    /// Minimum yield a transform/lesson pair needs to stay enabled.
    pub min_yield: f32,
    /// Seed every chain's parameters are drawn from.
    pub transform_seed: String,
    /// Attempts per base; defaults to a multiple of `variants_per_base`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempts_per_base: Option<usize>,
    /// Policy for a label with no lesson (Mortal-only or unclassified).
    #[serde(default)]
    pub mortal_policy: PolicyRecord,
    /// Reviewer decisions that keep a low-yield pair enabled.
    #[serde(default)]
    pub pair_overrides: Vec<PairOverride>,
    /// Data licence for a published pack; required to publish a real run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub licence: Option<String>,
    /// Data attribution for a published pack; required to publish a real run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attribution: Option<String>,
}

impl Default for VariantConfig {
    fn default() -> Self {
        Self {
            variants_per_base: DEFAULT_VARIANTS_PER_BASE,
            max_per_base: DEFAULT_MAX_PER_BASE,
            max_pack_share: DEFAULT_PACK_SHARE,
            pack_size: DEFAULT_PACK_SIZE,
            min_yield: DEFAULT_MIN_YIELD,
            transform_seed: DEFAULT_TRANSFORM_SEED.to_string(),
            attempts_per_base: None,
            mortal_policy: PolicyRecord::DENY,
            pair_overrides: Vec::new(),
            licence: None,
            attribution: None,
        }
    }
}

impl VariantConfig {
    /// Check the bounds. A bad config is a start failure, not a quiet default.
    pub fn validate(&self) -> Result<(), VariantError> {
        if self.variants_per_base == 0 {
            return Err(VariantError::Config(
                "`variants_per_base` must be at least 1".to_string(),
            ));
        }
        if self.max_per_base == 0 {
            return Err(VariantError::Config(
                "`max_per_base` must be at least 1".to_string(),
            ));
        }
        if !(self.max_pack_share > 0.0 && self.max_pack_share <= 1.0) {
            return Err(VariantError::Config(format!(
                "`max_pack_share` must be in (0.0, 1.0], found {}",
                self.max_pack_share
            )));
        }
        if self.pack_size == 0 {
            return Err(VariantError::Config(
                "`pack_size` must be at least 1".to_string(),
            ));
        }
        if !(0.0..=1.0).contains(&self.min_yield) {
            return Err(VariantError::Config(format!(
                "`min_yield` must be in 0.0..=1.0, found {}",
                self.min_yield
            )));
        }
        if self.transform_seed.trim().is_empty() {
            return Err(VariantError::Config(
                "`transform_seed` must not be empty".to_string(),
            ));
        }
        for pair in &self.pair_overrides {
            if pair.lesson.trim().is_empty() {
                return Err(VariantError::Config(
                    "a pair override names an empty lesson".to_string(),
                ));
            }
        }
        Ok(())
    }

    /// How many variants one base may actually contribute.
    ///
    /// The per-base cap and the per-pack share both apply; the smaller wins. A
    /// share of a small pack binds before the cap does, which is the point of
    /// the share rule.
    #[must_use]
    pub fn effective_cap(&self) -> usize {
        let share = (self.max_pack_share * self.pack_size as f32).floor();
        let share_cap = if share.is_finite() && share >= 1.0 {
            share as usize
        } else {
            1
        };
        self.max_per_base.min(share_cap)
    }

    /// Which rule produced [`Self::effective_cap`].
    #[must_use]
    pub fn cap_cause(&self) -> CapCause {
        let share = (self.max_pack_share * self.pack_size as f32).floor();
        let share_cap = if share.is_finite() && share >= 1.0 {
            share as usize
        } else {
            1
        };
        if share_cap < self.max_per_base {
            CapCause::PackShare
        } else {
            CapCause::PerBase
        }
    }

    /// How many chains to plan per base.
    #[must_use]
    pub fn attempts_per_base(&self) -> usize {
        self.attempts_per_base.unwrap_or_else(|| {
            self.variants_per_base
                .saturating_mul(3)
                .max(self.variants_per_base + 4)
                .min(48)
        })
    }

    /// The override for one pair, when the reviewer supplied one.
    #[must_use]
    pub fn pair_override(&self, lesson: &str, family: TransformFamily) -> Option<&PairOverride> {
        self.pair_overrides
            .iter()
            .find(|pair| pair.lesson == lesson && pair.transform == family)
    }
}

/// Anything that stops a variant run: a bad config, an unreadable queue, a
/// scoring/cache failure, or a pack that the P1a gate refuses.
#[derive(Debug, Error)]
pub enum VariantError {
    /// The configuration is out of bounds.
    #[error("invalid variant configuration: {0}")]
    Config(String),
    /// A base scenario cannot be transformed, beyond a per-variant rejection.
    #[error("variant base `{id}`: {detail}")]
    Base {
        /// The base scenario id.
        id: String,
        /// Why it is unusable.
        detail: String,
    },
    /// A file could not be read or written.
    #[error("I/O error at `{path}`: {source}")]
    Io {
        /// Path involved.
        path: String,
        #[source]
        /// The OS error.
        source: std::io::Error,
    },
    /// A JSON document did not parse.
    #[error("variant JSON error: {0}")]
    Json(#[from] serde_json::Error),
    /// SQLite failed.
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    /// The data root or storage layer failed.
    #[error(transparent)]
    Storage(#[from] StorageError),
    /// The labeler failed.
    #[error(transparent)]
    Label(#[from] LabelError),
    /// The pack gate refused the assembled pack.
    #[error(transparent)]
    Pack(#[from] PackError),
    /// The transform engine failed outside a per-variant rejection.
    #[error(transparent)]
    Transform(#[from] TransformError),
    /// No review queue was found.
    #[error("no review queue: {0}")]
    MissingQueue(String),
    /// The selection layer failed while reading a queue.
    #[error("selection error: {0}")]
    Selection(String),
    /// A report could not be serialised.
    #[error("variant report error: {0}")]
    Report(String),
    /// The worker pool could not start.
    #[error("{0}")]
    Workers(String),
}

impl VariantError {
    /// An I/O error with the path attached.
    #[must_use]
    pub fn io(path: impl std::fmt::Display, source: std::io::Error) -> Self {
        Self::Io {
            path: path.to_string(),
            source,
        }
    }
}
