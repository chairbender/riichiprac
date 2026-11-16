//! Deterministic percentile thresholds per decision family (L2).
//!
//! Replay-strategy §6.5.2 replaces the agent specification's absolute point
//! thresholds (`|EV_opt - EV_safe| < 400`) with percentiles of a **Q gap or
//! probability margin inside one decision family**, because Q values are model
//! utility: a 0.4 gap can be razor-thin in one family and obvious in another.
//! This module is that hook for selection (S3):
//!
//! - a [`DecisionFamily`] is a stable key (decision kind × table-turn bucket);
//! - [`PercentileConfig`] holds the close-call and confidence percentiles,
//!   overridable per family and deserialisable from JSON;
//! - [`PercentileCut`] turns a sample of labels from one family into two
//!   deterministic cut values with the nearest-rank method;
//! - [`Band`] classifies a label's gap as `close`, `middle` or `confident`.
//!
//! Nothing here selects a scenario or knows about packs; it answers "is this
//! gap in the bottom X% of this family?" so a selector does not need a magic
//! constant. The method is order-independent (the sample is sorted with
//! `f32::total_cmp`), so the same corpus always produces the same cuts.
//!
//! A family with fewer than [`MIN_PERCENTILE_SAMPLES`] usable values yields no
//! cuts: claiming "the bottom 10%" of four decisions is not a percentile, it is
//! a coincidence. The caller must fall back to a coarser family or decline.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::replay::walk::{DecisionKind, DecisionSnapshot};

use super::ModelLabel;

/// The default share of a family that counts as a close call.
pub const DEFAULT_CLOSE_CALL_PERCENTILE: f32 = 10.0;

/// The default percentile at or above which a gap counts as confident.
pub const DEFAULT_CONFIDENCE_PERCENTILE: f32 = 90.0;

/// The smallest family sample that yields a percentile.
///
/// Below this the sample cannot describe a distribution, so
/// [`PercentileCut::from_samples`] records no cuts and
/// [`PercentileCut::band`] returns `None`.
pub const MIN_PERCENTILE_SAMPLES: usize = 8;

/// Coarse table-turn bucket used in the family key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnBucket {
    /// The first six discards of the table (turns 0–5).
    Early,
    /// The middle of the hand (turns 6–11).
    Mid,
    /// The last stretch (turn 12 and later).
    Late,
}

impl TurnBucket {
    /// Bucket a table-turn count (the longest river on the table).
    #[must_use]
    pub const fn of(table_turn: usize) -> Self {
        match table_turn {
            0..=5 => Self::Early,
            6..=11 => Self::Mid,
            _ => Self::Late,
        }
    }

    /// The spelling used in a family key.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Early => "early",
            Self::Mid => "mid",
            Self::Late => "late",
        }
    }

    /// Parse the spelling used in a family key.
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "early" => Some(Self::Early),
            "mid" => Some(Self::Mid),
            "late" => Some(Self::Late),
            _ => None,
        }
    }
}

/// A stable partition of decisions for percentile thresholds.
///
/// The key is `<decision_kind>/<turn_bucket>`, e.g. `self_turn/mid`. Decision
/// kind separates a discard turn from a call or a ron; the turn bucket keeps the
/// opening from being pooled with the last stretch, where a given Q gap means
/// different things.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct DecisionFamily {
    /// What kind of choice the decision presents.
    pub kind: DecisionKind,
    /// Which part of the hand it happened in.
    pub turn: TurnBucket,
}

impl DecisionFamily {
    /// The family of one reconstructed decision.
    #[must_use]
    pub fn of(snapshot: &DecisionSnapshot) -> Self {
        Self {
            kind: snapshot.kind,
            turn: TurnBucket::of(table_turn(snapshot)),
        }
    }

    /// The config/JSON key, `<kind>/<turn_bucket>`.
    #[must_use]
    pub fn key(&self) -> String {
        format!("{}/{}", self.kind.as_str(), self.turn.as_str())
    }

    /// Parse a config key produced by [`Self::key`].
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        let (kind, turn) = raw.split_once('/')?;
        Some(Self {
            kind: DecisionKind::parse(kind)?,
            turn: TurnBucket::parse(turn)?,
        })
    }

    /// Every family key this module recognises.
    #[must_use]
    pub fn keys() -> Vec<String> {
        const KINDS: [DecisionKind; 4] = [
            DecisionKind::SelfTurn,
            DecisionKind::Call,
            DecisionKind::ReactToDiscard,
            DecisionKind::ReactToKan,
        ];
        const TURNS: [TurnBucket; 3] = [TurnBucket::Early, TurnBucket::Mid, TurnBucket::Late];
        KINDS
            .iter()
            .flat_map(|kind| {
                TURNS.iter().map(move |turn| Self {
                    kind: *kind,
                    turn: *turn,
                })
            })
            .map(|family| family.key())
            .collect()
    }
}

/// The longest river on the table, used as the turn count.
///
/// The actor's own river is not a turn count at a call decision (the actor may
/// not have discarded yet), so the table's progress is the most honest proxy
/// available from a snapshot.
#[must_use]
pub fn table_turn(snapshot: &DecisionSnapshot) -> usize {
    snapshot
        .state
        .players
        .iter()
        .map(|player| player.discards.len())
        .max()
        .unwrap_or(0)
}

/// The two percentile knobs for one family.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PercentileThresholds {
    /// Bottom share (percent) of the family that counts as a close call.
    #[serde(default = "default_close_call")]
    pub close_call_percentile: f32,
    /// Percentile at or above which a gap counts as confident.
    #[serde(default = "default_confidence")]
    pub confidence_percentile: f32,
}

const fn default_close_call() -> f32 {
    DEFAULT_CLOSE_CALL_PERCENTILE
}

const fn default_confidence() -> f32 {
    DEFAULT_CONFIDENCE_PERCENTILE
}

impl Default for PercentileThresholds {
    fn default() -> Self {
        Self {
            close_call_percentile: DEFAULT_CLOSE_CALL_PERCENTILE,
            confidence_percentile: DEFAULT_CONFIDENCE_PERCENTILE,
        }
    }
}

impl PercentileThresholds {
    /// Check the percentiles are usable.
    pub fn validate(&self) -> Result<(), ThresholdError> {
        if !(self.close_call_percentile > 0.0 && self.close_call_percentile < 100.0) {
            return Err(ThresholdError::CloseCallOutOfRange {
                value: self.close_call_percentile,
            });
        }
        if !(self.confidence_percentile > 0.0 && self.confidence_percentile < 100.0) {
            return Err(ThresholdError::ConfidenceOutOfRange {
                value: self.confidence_percentile,
            });
        }
        if self.close_call_percentile >= self.confidence_percentile {
            return Err(ThresholdError::Overlapping {
                close: self.close_call_percentile,
                confidence: self.confidence_percentile,
            });
        }
        Ok(())
    }
}

/// Per-decision-family percentile configuration.
///
/// The default applies to every family without an override. A key that is not a
/// known [`DecisionFamily`] is an error rather than a silent fallback, so a typo
/// cannot quietly disable a tuned threshold.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PercentileConfig {
    /// Thresholds for families without an override.
    #[serde(default)]
    pub default: PercentileThresholds,
    /// Per-family overrides keyed by [`DecisionFamily::key`].
    #[serde(default)]
    pub families: BTreeMap<String, PercentileThresholds>,
}

impl PercentileConfig {
    /// The thresholds that apply to `family`.
    #[must_use]
    pub fn for_family(&self, family: &str) -> PercentileThresholds {
        self.families.get(family).copied().unwrap_or(self.default)
    }

    /// Validate the default and every override.
    pub fn validate(&self) -> Result<(), ThresholdError> {
        self.default.validate()?;
        for (key, thresholds) in &self.families {
            if DecisionFamily::parse(key).is_none() {
                return Err(ThresholdError::UnknownFamily { key: key.clone() });
            }
            thresholds.validate()?;
        }
        Ok(())
    }
}

/// A configuration that cannot be used as a percentile.
#[derive(Debug, Error, PartialEq)]
pub enum ThresholdError {
    /// The close-call share must be strictly between 0 and 100.
    #[error("close-call percentile {value} must be between 0 and 100 (exclusive)")]
    CloseCallOutOfRange { value: f32 },
    /// The confidence percentile must be strictly between 0 and 100.
    #[error("confidence percentile {value} must be between 0 and 100 (exclusive)")]
    ConfidenceOutOfRange { value: f32 },
    /// The two bands must not overlap.
    #[error("close-call percentile {close} must be below the confidence percentile {confidence}")]
    Overlapping { close: f32, confidence: f32 },
    /// An override names a family that does not exist.
    #[error("unknown decision family `{key}`; expected `<kind>/<turn>`, e.g. `self_turn/mid`")]
    UnknownFamily { key: String },
}

/// Where a label's gap sits in its family.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Band {
    /// At or below the family's close-call cut.
    Close,
    /// Between the two cuts.
    Middle,
    /// At or above the family's confidence cut.
    Confident,
}

impl Band {
    /// The JSON spelling.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Close => "close",
            Self::Middle => "middle",
            Self::Confident => "confident",
        }
    }
}

/// The two cut values computed from one family's sample.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PercentileCut {
    /// The family key.
    pub family: String,
    /// Usable (finite) sample values.
    pub sample_size: usize,
    /// The configured close-call percentile.
    pub close_percentile: f32,
    /// The configured confidence percentile.
    pub confidence_percentile: f32,
    /// Values at or below this are [`Band::Close`]; `None` when the family is
    /// too small to describe a distribution.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub close_at_or_below: Option<f32>,
    /// Values at or above this are [`Band::Confident`]; `None` when the family
    /// is too small.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confident_at_or_above: Option<f32>,
}

impl PercentileCut {
    /// Compute the cuts for one family's gap sample.
    ///
    /// The sample is sorted ascending with `f32::total_cmp`; non-finite values
    /// are dropped. With fewer than [`MIN_PERCENTILE_SAMPLES`] usable values the
    /// cuts stay `None`.
    #[must_use]
    pub fn from_samples(family: &str, samples: &[f32], thresholds: PercentileThresholds) -> Self {
        let mut sorted: Vec<f32> = samples
            .iter()
            .copied()
            .filter(|gap| gap.is_finite())
            .collect();
        sorted.sort_by(f32::total_cmp);
        let sample_size = sorted.len();
        let (close_at_or_below, confident_at_or_above) = if sample_size < MIN_PERCENTILE_SAMPLES {
            (None, None)
        } else {
            (
                Some(nearest_rank(&sorted, thresholds.close_call_percentile)),
                Some(nearest_rank(&sorted, thresholds.confidence_percentile)),
            )
        };
        Self {
            family: family.to_string(),
            sample_size,
            close_percentile: thresholds.close_call_percentile,
            confidence_percentile: thresholds.confidence_percentile,
            close_at_or_below,
            confident_at_or_above,
        }
    }

    /// Classify one gap, or `None` when the family has no usable cuts or the
    /// value is not finite.
    #[must_use]
    pub fn band(&self, gap: f32) -> Option<Band> {
        if !gap.is_finite() {
            return None;
        }
        let close = self.close_at_or_below?;
        let confident = self.confident_at_or_above?;
        if gap <= close {
            Some(Band::Close)
        } else if gap >= confident {
            Some(Band::Confident)
        } else {
            Some(Band::Middle)
        }
    }
}

/// The family key and gap for one labelled decision.
///
/// This is the glue between a label and [`PercentileCut`]: selection (S3) groups
/// these pairs by family and asks [`PercentileCuts::band`] whether a decision is
/// close or confident. `None` when the position offers a single legal action
/// (there is no top-two gap).
#[must_use]
pub fn family_gap(snapshot: &DecisionSnapshot, label: &ModelLabel) -> Option<(String, f32)> {
    Some((DecisionFamily::of(snapshot).key(), label.top2_gap()?))
}

/// The nearest-rank percentile of a sorted, non-empty sample.
///
/// `rank = ceil(percentile / 100 × n)`, clamped to `1..=n`, then indexed 0-based.
fn nearest_rank(sorted: &[f32], percentile: f32) -> f32 {
    debug_assert!(!sorted.is_empty());
    let count = sorted.len();
    let raw = ((percentile / 100.0) * count as f32).ceil();
    let rank = if raw.is_finite() && raw >= 1.0 {
        raw as usize
    } else {
        1
    };
    sorted[rank.clamp(1, count) - 1]
}

/// Every family's cuts for one corpus sample.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PercentileCuts {
    /// Cuts keyed by [`DecisionFamily::key`].
    pub families: BTreeMap<String, PercentileCut>,
}

impl PercentileCuts {
    /// Build every family's cuts from one sample per family.
    pub fn build(
        config: &PercentileConfig,
        samples: &BTreeMap<String, Vec<f32>>,
    ) -> Result<Self, ThresholdError> {
        config.validate()?;
        let families = samples
            .iter()
            .map(|(family, values)| {
                let thresholds = config.for_family(family);
                let cut = PercentileCut::from_samples(family, values, thresholds);
                (family.clone(), cut)
            })
            .collect();
        Ok(Self { families })
    }

    /// Classify one gap in one family, or `None` when the family has no cuts.
    #[must_use]
    pub fn band(&self, family: &str, gap: f32) -> Option<Band> {
        self.families.get(family)?.band(gap)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_family_key_round_trips_for_every_combination() {
        for key in DecisionFamily::keys() {
            let family = DecisionFamily::parse(&key).expect("every key parses");
            assert_eq!(family.key(), key);
        }
        assert_eq!(DecisionFamily::keys().len(), 12);
        assert!(DecisionFamily::parse("self_turn/dawn").is_none());
        assert!(DecisionFamily::parse("nope/mid").is_none());
        assert!(DecisionFamily::parse("self_turn").is_none());
    }

    #[test]
    fn the_turn_buckets_cover_every_turn() {
        assert_eq!(TurnBucket::of(0), TurnBucket::Early);
        assert_eq!(TurnBucket::of(5), TurnBucket::Early);
        assert_eq!(TurnBucket::of(6), TurnBucket::Mid);
        assert_eq!(TurnBucket::of(11), TurnBucket::Mid);
        assert_eq!(TurnBucket::of(12), TurnBucket::Late);
        assert_eq!(TurnBucket::of(70), TurnBucket::Late);
    }

    #[test]
    fn the_default_config_is_valid_and_used_for_unlisted_families() {
        let config = PercentileConfig::default();
        config.validate().expect("defaults are valid");
        assert_eq!(
            config.for_family("self_turn/mid"),
            PercentileThresholds::default()
        );
    }

    #[test]
    fn thresholds_are_configurable_per_family_and_validated() {
        let mut config = PercentileConfig::default();
        config.families.insert(
            "self_turn/mid".to_string(),
            PercentileThresholds {
                close_call_percentile: 20.0,
                confidence_percentile: 80.0,
            },
        );
        config.validate().expect("override is valid");
        assert_eq!(
            config.for_family("self_turn/mid").close_call_percentile,
            20.0
        );
        assert_eq!(
            config.for_family("call/early"),
            PercentileThresholds::default()
        );

        let mut unknown = config.clone();
        unknown.families.insert(
            "self_turn/dawn".to_string(),
            PercentileThresholds::default(),
        );
        assert!(matches!(
            unknown.validate(),
            Err(ThresholdError::UnknownFamily { .. })
        ));

        let overlapping = PercentileConfig {
            default: PercentileThresholds {
                close_call_percentile: 60.0,
                confidence_percentile: 50.0,
            },
            ..PercentileConfig::default()
        };
        assert!(matches!(
            overlapping.validate(),
            Err(ThresholdError::Overlapping { .. })
        ));

        let out_of_range = PercentileConfig {
            default: PercentileThresholds {
                close_call_percentile: 0.0,
                ..PercentileThresholds::default()
            },
            ..PercentileConfig::default()
        };
        assert!(matches!(
            out_of_range.validate(),
            Err(ThresholdError::CloseCallOutOfRange { .. })
        ));
    }

    #[test]
    fn percentile_cuts_are_deterministic_and_order_independent() {
        let values: Vec<f32> = (0..100).map(|value| value as f32 * 0.01).collect();
        let thresholds = PercentileThresholds::default();
        let forward = PercentileCut::from_samples("self_turn/mid", &values, thresholds);

        let mut shuffled = values.clone();
        shuffled.reverse();
        shuffled.rotate_left(37);
        let backward = PercentileCut::from_samples("self_turn/mid", &shuffled, thresholds);
        assert_eq!(forward, backward);

        // Nearest rank: 10% of 100 values is the 10th (index 9).
        assert!((forward.close_at_or_below.expect("cut") - 0.09).abs() < 1e-6);
        assert!((forward.confident_at_or_above.expect("cut") - 0.89).abs() < 1e-6);
        assert_eq!(forward.sample_size, 100);
    }

    #[test]
    fn the_band_puts_the_tails_and_the_middle_where_the_percentiles_say() {
        let values: Vec<f32> = (0..100).map(|value| value as f32 * 0.01).collect();
        let cut =
            PercentileCut::from_samples("self_turn/mid", &values, PercentileThresholds::default());
        let close = cut.close_at_or_below.expect("close cut");
        let confident = cut.confident_at_or_above.expect("confidence cut");
        assert_eq!(cut.band(close), Some(Band::Close));
        assert_eq!(cut.band(close / 2.0), Some(Band::Close));
        assert_eq!(cut.band((close + confident) / 2.0), Some(Band::Middle));
        assert_eq!(cut.band(confident), Some(Band::Confident));
        assert_eq!(cut.band(confident + 1.0), Some(Band::Confident));
        assert_eq!(Band::Close.as_str(), "close");
    }

    #[test]
    fn a_small_family_has_no_percentile() {
        let values: Vec<f32> = (0..MIN_PERCENTILE_SAMPLES - 1)
            .map(|value| value as f32)
            .collect();
        let cut =
            PercentileCut::from_samples("call/early", &values, PercentileThresholds::default());
        assert_eq!(cut.sample_size, values.len());
        assert!(cut.close_at_or_below.is_none());
        assert!(cut.confident_at_or_above.is_none());
        assert_eq!(cut.band(1.0), None);
    }

    #[test]
    fn non_finite_values_are_dropped_before_the_cut() {
        let mut values: Vec<f32> = (0..20).map(|value| value as f32).collect();
        values.extend([f32::NAN, f32::INFINITY, f32::NEG_INFINITY]);
        let cut =
            PercentileCut::from_samples("self_turn/late", &values, PercentileThresholds::default());
        assert_eq!(cut.sample_size, 20);
        assert!(cut.close_at_or_below.expect("cut").is_finite());
        assert_eq!(cut.band(f32::NAN), None);
    }

    #[test]
    fn a_family_gap_joins_a_label_to_its_family() {
        use crate::decision::ActionInfo;
        use crate::miner::label::tests::{CannedEvaluator, walk};

        let replay = walk(&crate::replay::fixtures::exhaustive_game(7));
        let snapshot = &replay.decisions[0];
        let evaluator =
            CannedEvaluator::new(|info: &ActionInfo| -(info.tile_index.unwrap_or(0) as f32) * 0.1);
        let label = super::super::build_label(
            &evaluator,
            snapshot,
            &super::super::LabelOptions::default(),
            super::super::CLASSIFIER_VERSION,
            None,
        )
        .expect("label builds");
        let (family, gap) = family_gap(snapshot, &label).expect("the fixture offers two actions");
        assert_eq!(family, DecisionFamily::of(snapshot).key());
        assert_eq!(Some(gap), label.top2_gap());
    }

    #[test]
    fn the_corpus_cuts_are_built_per_family_from_one_config() {
        let mut config = PercentileConfig::default();
        config.families.insert(
            "self_turn/late".to_string(),
            PercentileThresholds {
                close_call_percentile: 25.0,
                confidence_percentile: 75.0,
            },
        );
        let samples = BTreeMap::from([
            (
                "self_turn/late".to_string(),
                (0..40).map(|value| value as f32).collect::<Vec<_>>(),
            ),
            (
                "call/early".to_string(),
                (0..40).map(|value| value as f32 * 2.0).collect::<Vec<_>>(),
            ),
        ]);
        let cuts = PercentileCuts::build(&config, &samples).expect("valid config");
        assert_eq!(cuts.families.len(), 2);
        assert_eq!(
            cuts.band("self_turn/late", 1.0),
            Some(Band::Close),
            "the 25th percentile of 0..40 is 10"
        );
        assert_eq!(cuts.band("call/early", 39.0), Some(Band::Middle));
        assert_eq!(cuts.band("react_kan/mid", 1.0), None, "unseen family");
    }
}
