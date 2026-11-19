//! Ranking signals and the composite score (implementation unit S2).
//!
//! Replay-strategy §7.2 splits selection into **hard gates** (must hold, or the
//! candidate is not shippable) and **ranking signals** (how good it is among
//! valid candidates). This module is the second half: every signal is a number
//! in `0.0..=1.0`, and [`ScoreWeights::score`] is the configurable composite
//! from §7.2.
//!
//! ```text
//! score = 0.25 * book_match
//!       + 0.15 * label_confidence
//!       + 0.15 * counterfactual_tension
//!       + 0.15 * stakes
//!       + 0.15 * discrimination
//!       + 0.10 * novelty
//!       + 0.05 * realism
//! ```
//!
//! The weights are a default, not a law: they are a field on
//! [`ScoreWeights`], validated and normalised by their sum, so an operator can
//! re-weight the ranking without touching the gates. The score never hides a
//! gate failure, because gates run first and a rejected candidate is never
//! scored.
//!
//! # Why the percentile ranks
//!
//! A raw Q gap is model utility, not points: `0.4` can be razor-thin in one
//! decision family and obvious in another. Both `label_confidence` and
//! `counterfactual_tension` are therefore **percentile ranks inside the
//! decision family** (`<decision kind>/<turn bucket>`), built from the same
//! labelled sample the L2 thresholds use. A family with fewer than
//! [`MIN_PERCENTILE_SAMPLES`] values falls back to the pooled sample rather than
//! pretending a four-decision sample is a distribution.
//!
//! # `stakes` is a proxy, not a point claim
//!
//! The strategy names score swing, placement leverage, hand value and threat
//! value. The selector does not have a simulator, so it combines cheap,
//! visible-state proxies whose formula is written down in [`stakes`]. It is a
//! **ranking** signal, never a claim that the decision is worth N points, and
//! it is not shown to a trainee.

use std::collections::BTreeMap;

use agari::tile::Tile;
use serde::{Deserialize, Serialize};

use crate::generator::support::yaku::dora_count;
use crate::miner::label::ModelLabel;
use crate::miner::label::thresholds::{
    MIN_PERCENTILE_SAMPLES, PercentileConfig, PercentileCuts, ThresholdError, TurnBucket,
    table_turn,
};
use crate::miner::trigger::{LabelCuts, played_gap};
use crate::replay::walk::DecisionSnapshot;
use crate::state::{GameState, Wind};

use super::ReplayFacts;

fn clamp01(value: f32) -> f32 {
    if !value.is_finite() {
        return 0.0;
    }
    value.clamp(0.0, 1.0)
}

/// The §7.2 composite weights.
///
/// Every field is a non-negative relative weight; [`Self::score`] divides by
/// their sum, so the absolute scale does not matter.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ScoreWeights {
    /// A cited book rule with a unique answer.
    pub book_match: f32,
    /// How decisive the label is inside its decision family.
    pub label_confidence: f32,
    /// How thin the top-two (and safe-vs-best) gap is.
    pub counterfactual_tension: f32,
    /// Score/placement, hand-value and threat proxies.
    pub stakes: f32,
    /// Weak-vs-strong separation, or a thin top-two gap as its stand-in.
    pub discrimination: f32,
    /// Distance from the catalogue's most common section/kind/turn bucket.
    pub novelty: f32,
    /// A clean, complete game with no reconstruction warnings.
    pub realism: f32,
}

impl Default for ScoreWeights {
    fn default() -> Self {
        Self {
            book_match: 0.25,
            label_confidence: 0.15,
            counterfactual_tension: 0.15,
            stakes: 0.15,
            discrimination: 0.15,
            novelty: 0.10,
            realism: 0.05,
        }
    }
}

impl ScoreWeights {
    /// Every weight, in §7.2 order.
    #[must_use]
    pub fn as_pairs(&self) -> [(&'static str, f32); 7] {
        [
            ("book_match", self.book_match),
            ("label_confidence", self.label_confidence),
            ("counterfactual_tension", self.counterfactual_tension),
            ("stakes", self.stakes),
            ("discrimination", self.discrimination),
            ("novelty", self.novelty),
            ("realism", self.realism),
        ]
    }

    /// Reject a negative or non-finite weight, or an all-zero set.
    pub fn validate(&self) -> Result<(), String> {
        let mut total = 0.0;
        for (name, weight) in self.as_pairs() {
            if !weight.is_finite() || weight < 0.0 {
                return Err(format!(
                    "score weight `{name}` must be finite and non-negative"
                ));
            }
            total += weight;
        }
        if total <= 0.0 {
            return Err("at least one score weight must be positive".to_string());
        }
        Ok(())
    }

    /// The weighted mean of [`Signals`].
    #[must_use]
    pub fn score(&self, signals: &Signals) -> f32 {
        let pairs = [
            (self.book_match, signals.book_match),
            (self.label_confidence, signals.label_confidence),
            (self.counterfactual_tension, signals.counterfactual_tension),
            (self.stakes, signals.stakes),
            (self.discrimination, signals.discrimination),
            (self.novelty, signals.novelty),
            (self.realism, signals.realism),
        ];
        let mut total = 0.0;
        let mut sum = 0.0;
        for (weight, signal) in pairs {
            total += weight;
            sum += weight * clamp01(signal);
        }
        if total > 0.0 { sum / total } else { 0.0 }
    }
}

/// One candidate's ranking signals, every one in `0.0..=1.0`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Signals {
    /// A cited book rule with a unique answer.
    pub book_match: f32,
    /// Percentile rank of the label's top-two gap in its decision family.
    pub label_confidence: f32,
    /// `1 - percentile` of the top-two (and safe) gap: thin gaps score high.
    pub counterfactual_tension: f32,
    /// Score/placement, hand-value and threat proxy.
    pub stakes: f32,
    /// Weak-vs-strong separation, else thinness.
    pub discrimination: f32,
    /// Rarity of the book section / decision kind / turn bucket.
    pub novelty: f32,
    /// Complete, clean game and publishable provenance.
    pub realism: f32,
}

impl Signals {
    /// Neutral defaults for the pre-frequency pass.
    #[must_use]
    pub fn zero() -> Self {
        Self {
            book_match: 0.0,
            label_confidence: 0.0,
            counterfactual_tension: 0.0,
            stakes: 0.0,
            discrimination: 0.0,
            novelty: 0.5,
            realism: 0.0,
        }
    }
}

/// Per-family samples the percentile signals are measured against.
///
/// The maps are keyed by [`crate::miner::label::thresholds::DecisionFamily::key`]
/// (`<decision_kind>/<turn_bucket>`). The values are raw model-utility gaps,
/// never points.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SampleCuts {
    /// `q(best) - q(second)` per family.
    #[serde(default)]
    pub top2: BTreeMap<String, Vec<f32>>,
    /// `q(best) - q(safest)` per family.
    #[serde(default)]
    pub safe: BTreeMap<String, Vec<f32>>,
    /// `q(best) - q(played)` per family, only where the record did not play the
    /// top action.
    #[serde(default)]
    pub played: BTreeMap<String, Vec<f32>>,
}

impl SampleCuts {
    /// Add one cached label to the relevant samples.
    pub fn add(&mut self, family: &str, label: &ModelLabel, played_action: &str) {
        if let Some(gap) = label.top2_gap() {
            self.top2.entry(family.to_string()).or_default().push(gap);
        }
        if let Some(gap) = label.q_gap_safe {
            self.safe.entry(family.to_string()).or_default().push(gap);
        }
        if let Some(gap) = played_gap(played_action, label) {
            self.played.entry(family.to_string()).or_default().push(gap);
        }
    }

    /// Merge a worker's samples into this set. Order inside each family is not
    /// part of the percentile contract, but callers merge in file order anyway.
    pub fn merge(&mut self, other: &Self) {
        for (key, values) in &other.top2 {
            self.top2
                .entry(key.clone())
                .or_default()
                .extend_from_slice(values);
        }
        for (key, values) in &other.safe {
            self.safe
                .entry(key.clone())
                .or_default()
                .extend_from_slice(values);
        }
        for (key, values) in &other.played {
            self.played
                .entry(key.clone())
                .or_default()
                .extend_from_slice(values);
        }
    }

    /// The trigger cuts S1 needs, built from this sample.
    ///
    /// `close_call` is the top-two-gap distribution, which is also the
    /// distribution gate 5 bands a Mortal-only answer against; `blunder` is the
    /// played-gap distribution.
    pub fn label_cuts(&self, percentiles: &PercentileConfig) -> Result<LabelCuts, ThresholdError> {
        Ok(LabelCuts {
            close_call: PercentileCuts::build(percentiles, &self.top2)?,
            blunder: PercentileCuts::build(percentiles, &self.played)?,
        })
    }

    /// Percentile rank of a top-two gap inside its family (pooled fallback).
    #[must_use]
    pub fn top2_rank(&self, family: &str, value: f32) -> Option<f32> {
        rank(&self.top2, family, value)
    }

    /// Percentile rank of a safe gap inside its family (pooled fallback).
    #[must_use]
    pub fn safe_rank(&self, family: &str, value: f32) -> Option<f32> {
        rank(&self.safe, family, value)
    }

    /// Percentile rank of a played-action gap inside its family.
    #[must_use]
    pub fn played_rank(&self, family: &str, value: f32) -> Option<f32> {
        rank(&self.played, family, value)
    }

    /// One row per family, for the selection report.
    #[must_use]
    pub fn summary(&self, cuts: &LabelCuts) -> Vec<SampleSummary> {
        let mut families: Vec<String> = self
            .top2
            .keys()
            .chain(self.safe.keys())
            .chain(self.played.keys())
            .cloned()
            .collect();
        families.sort();
        families.dedup();
        families
            .into_iter()
            .map(|family| {
                let cut = cuts.close_call.families.get(&family);
                SampleSummary {
                    top2_samples: self.top2.get(&family).map_or(0, Vec::len),
                    safe_samples: self.safe.get(&family).map_or(0, Vec::len),
                    played_samples: self.played.get(&family).map_or(0, Vec::len),
                    close_at_or_below: cut.and_then(|cut| cut.close_at_or_below),
                    confident_at_or_above: cut.and_then(|cut| cut.confident_at_or_above),
                    family,
                }
            })
            .collect()
    }
}

/// One family's sample size and computed cuts, for the report.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SampleSummary {
    /// The decision-family key.
    pub family: String,
    /// Top-two-gap samples.
    pub top2_samples: usize,
    /// Safe-gap samples.
    pub safe_samples: usize,
    /// Played-gap samples.
    pub played_samples: usize,
    /// Close-call cut, or `None` when the family is too small.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub close_at_or_below: Option<f32>,
    /// Confidence cut, or `None` when the family is too small.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confident_at_or_above: Option<f32>,
}

/// The share of `values` at or below `value`, in `(0.0, 1.0]`.
///
/// `None` for an empty sample or a non-finite value. Ties count as at-or-below,
/// so the rank is deterministic and order-independent.
#[must_use]
pub fn percentile_rank(values: &[f32], value: f32) -> Option<f32> {
    if values.is_empty() || !value.is_finite() {
        return None;
    }
    let usable = values.iter().filter(|sample| sample.is_finite()).count();
    if usable == 0 {
        return None;
    }
    let at_or_below = values
        .iter()
        .filter(|sample| sample.is_finite() && **sample <= value)
        .count();
    Some(at_or_below as f32 / usable as f32)
}

/// Rank inside one family, falling back to the pooled sample when the family is
/// too small to describe a distribution.
fn rank(samples: &BTreeMap<String, Vec<f32>>, family: &str, value: f32) -> Option<f32> {
    if let Some(values) = samples.get(family)
        && values.len() >= MIN_PERCENTILE_SAMPLES
        && let Some(rank) = percentile_rank(values, value)
    {
        return Some(rank);
    }
    let pooled: Vec<f32> = samples.values().flatten().copied().collect();
    percentile_rank(&pooled, value)
}

/// Compute every signal except `novelty`, which needs the whole candidate pool.
#[must_use]
pub fn compute_signals(
    snapshot: &DecisionSnapshot,
    label: &ModelLabel,
    family: &str,
    facts: &ReplayFacts,
    samples: &SampleCuts,
    blunder_cuts: &PercentileCuts,
) -> Signals {
    let top2 = label.top2_gap();
    let label_confidence = top2
        .and_then(|gap| samples.top2_rank(family, gap))
        .unwrap_or_else(|| clamp01(label.top_probability));

    let mut tension_parts = Vec::new();
    if let Some(gap) = top2
        && let Some(rank) = samples.top2_rank(family, gap)
    {
        tension_parts.push(1.0 - rank);
    }
    if let Some(gap) = label.q_gap_safe
        && let Some(rank) = samples.safe_rank(family, gap)
    {
        tension_parts.push(1.0 - rank);
    }
    let counterfactual_tension = if tension_parts.is_empty() {
        // No percentile sample yet: a wide probability margin is a decisive
        // position, a narrow one is tense. This is a fallback, not a threshold.
        clamp01(1.0 - label.probability_margin * 2.0)
    } else {
        tension_parts.iter().sum::<f32>() / tension_parts.len() as f32
    };

    let played = &snapshot.played.action;
    let played_rank = played_gap(played, label).and_then(|gap| samples.played_rank(family, gap));
    let in_blunder_band = played_gap(played, label)
        .and_then(|gap| blunder_cuts.band(family, gap))
        .is_some_and(|band| band == crate::miner::label::thresholds::Band::Confident);
    let discrimination = if in_blunder_band {
        1.0
    } else if let Some(rank) = played_rank {
        rank
    } else {
        // The record played the model's own top action, so there is no observed
        // weak-vs-strong split: the strategy's parenthetical fallback is the
        // top-two gap itself.
        1.0 - label_confidence
    };

    Signals {
        book_match: f32::from(label.book.is_some()),
        label_confidence,
        counterfactual_tension,
        stakes: stakes(&snapshot.state),
        discrimination: clamp01(discrimination),
        novelty: 0.5,
        realism: realism(facts, &snapshot.warnings),
    }
}

/// A visible-state proxy for the decision's stakes, in `0.0..=1.0`.
///
/// ```text
/// score_leverage = clamp(spread / 40000
///                        + 0.30 * all_last
///                        + 0.10 * min(honba, 3)
///                        + 0.10 * min(riichi_sticks, 3))
/// hand_value     = clamp(0.40 * dora_held / 4
///                        + 0.30 * red_fives / 3
///                        + 0.30 * ukeire_total / 36)
/// threat         = clamp(0.60 * riichi_opponents / 3
///                        + 0.40 * opponent_melds / 8)
/// stakes         = 0.40 * score_leverage + 0.30 * hand_value + 0.30 * threat
/// ```
///
/// `dora_held` counts the actor's own visible tiles (hand, draw and melds)
/// against the dora indicators. Nothing here is a point value.
#[must_use]
pub fn stakes(state: &GameState) -> f32 {
    let scores: Vec<i32> = state.players.iter().map(|player| player.score).collect();
    let spread = scores
        .iter()
        .max()
        .zip(scores.iter().min())
        .map_or(0, |(high, low)| high.saturating_sub(*low));
    let all_last = state.round_wind == Wind::South && state.hand_number >= 4;
    let score_leverage = clamp01(
        spread as f32 / 40_000.0
            + if all_last { 0.30 } else { 0.0 }
            + 0.10 * f32::from(state.honba.min(3))
            + 0.10 * f32::from(state.riichi_sticks.min(3)),
    );

    let actor = state.players.first();
    let mut visible_tiles: Vec<Tile> = actor
        .map(|player| {
            player
                .hand
                .iter()
                .chain(player.draw.iter())
                .chain(player.melds.iter().flat_map(|meld| meld.tiles.iter()))
                .filter_map(|code| Tile::try_from(code.as_str()).ok())
                .collect()
        })
        .unwrap_or_default();
    visible_tiles.sort();
    let indicators: Vec<Tile> = state
        .dora_indicators
        .iter()
        .filter_map(|code| Tile::try_from(code.as_str()).ok())
        .collect();
    let dora_held = dora_count(&visible_tiles, &indicators);
    let red_fives = actor.map_or(0, |player| player.red_fives.len());
    let ukeire = usize::from(state.ukeire_total);
    let hand_value = clamp01(
        0.40 * f32::from(dora_held) / 4.0
            + 0.30 * red_fives as f32 / 3.0
            + 0.30 * ukeire as f32 / 36.0,
    );

    let riichi = state
        .players
        .iter()
        .skip(1)
        .filter(|player| player.is_riichi)
        .count();
    let melds: usize = state
        .players
        .iter()
        .skip(1)
        .map(|player| player.melds.len())
        .sum();
    let threat = clamp01(0.60 * riichi as f32 / 3.0 + 0.40 * melds as f32 / 8.0);

    clamp01(0.40 * score_leverage + 0.30 * hand_value + 0.30 * threat)
}

/// How clean and complete the source game is.
#[must_use]
pub fn realism(facts: &ReplayFacts, warnings: &[String]) -> f32 {
    let base = if facts.walk_clean && facts.publishable {
        1.0
    } else if facts.walk_clean {
        0.6
    } else {
        0.4
    };
    clamp01(base - 0.2 * warnings.len() as f32)
}

/// The turn bucket of one snapshot, for the per-turn quota.
#[must_use]
pub fn snapshot_turn(snapshot: &DecisionSnapshot) -> (usize, TurnBucket) {
    let turn = table_turn(snapshot);
    (turn, TurnBucket::of(turn))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::miner::select::tests::fixture;

    #[test]
    fn the_default_weights_are_the_strategy_composite() {
        let weights = ScoreWeights::default();
        weights.validate().expect("defaults are valid");
        assert_eq!(
            weights
                .as_pairs()
                .map(|(_, weight)| weight)
                .iter()
                .sum::<f32>(),
            1.0
        );
        assert_eq!(weights.book_match, 0.25);
        assert_eq!(weights.novelty, 0.10);
    }

    #[test]
    fn the_composite_is_normalised_and_bounded() {
        let weights = ScoreWeights::default();
        let signals = Signals {
            book_match: 1.0,
            label_confidence: 1.0,
            counterfactual_tension: 1.0,
            stakes: 1.0,
            discrimination: 1.0,
            novelty: 1.0,
            realism: 1.0,
        };
        assert_eq!(weights.score(&signals), 1.0);
        assert_eq!(weights.score(&Signals::zero()), 0.5 * weights.novelty);
        let doubled = ScoreWeights {
            book_match: 0.5,
            ..ScoreWeights::default()
        };
        doubled.validate().expect("scaled weights are valid");
        assert!((doubled.score(&signals) - 1.0).abs() < 1e-6);

        let invalid = ScoreWeights {
            stakes: -1.0,
            ..ScoreWeights::default()
        };
        assert!(invalid.validate().is_err());
        let zero = ScoreWeights {
            book_match: 0.0,
            label_confidence: 0.0,
            counterfactual_tension: 0.0,
            stakes: 0.0,
            discrimination: 0.0,
            novelty: 0.0,
            realism: 0.0,
        };
        assert!(zero.validate().is_err());
    }

    #[test]
    fn percentile_rank_is_order_independent_and_counts_ties() {
        let values = [0.1, 0.4, 0.2, 0.4];
        assert_eq!(percentile_rank(&values, 0.1), Some(0.25));
        assert_eq!(percentile_rank(&values, 0.4), Some(1.0));
        assert_eq!(percentile_rank(&values, 0.3), Some(0.5));
        assert_eq!(percentile_rank(&[], 0.3), None);
        assert_eq!(percentile_rank(&values, f32::NAN), None);
    }

    #[test]
    fn a_small_family_falls_back_to_the_pooled_sample() {
        let mut samples = SampleCuts::default();
        samples
            .top2
            .insert("self_turn/early".to_string(), vec![0.1, 0.2]);
        samples.top2.insert(
            "self_turn/mid".to_string(),
            (0..8).map(|i| i as f32 / 10.0).collect(),
        );
        // `early` has only two samples, so it falls back to the pooled ten;
        // `mid` has the eight-sample minimum and uses its own distribution.
        assert_eq!(samples.top2_rank("self_turn/early", 0.2), Some(0.5));
        assert_eq!(samples.top2_rank("self_turn/mid", 0.5), Some(0.75));
        assert_eq!(samples.top2_rank("nope", 0.5), Some(0.8));
    }

    #[test]
    fn stakes_are_bounded_and_rise_with_context() {
        let quiet = fixture::snapshot();
        let quiet_stakes = stakes(&quiet.state);

        let mut loud_state = quiet.state.clone();
        loud_state.players[0].score = 50_000;
        loud_state.players[1].score = 5_000;
        loud_state.round_wind = Wind::South;
        loud_state.hand_number = 4;
        loud_state.honba = 3;
        loud_state.riichi_sticks = 3;
        loud_state.players[2].is_riichi = true;
        loud_state.players[2].melds.push(crate::state::CalledMeld {
            meld_type: crate::state::MeldType::Pon,
            tiles: vec!["5z".to_string(), "5z".to_string(), "5z".to_string()],
            called_from: Some(1),
        });
        let loud_stakes = stakes(&loud_state);
        assert!((0.0..=1.0).contains(&quiet_stakes));
        assert!((0.0..=1.0).contains(&loud_stakes));
        assert!(
            loud_stakes > quiet_stakes,
            "all-last, honba, sticks, spread and a threat must raise stakes: \
             {quiet_stakes} vs {loud_stakes}"
        );
    }

    #[test]
    fn realism_drops_with_warnings_and_a_dirty_walk() {
        let clean = ReplayFacts::fixture_ok();
        assert_eq!(realism(&clean, &[]), 1.0);
        assert_eq!(realism(&clean, &["note".to_string()]), 0.8);
        let mut dirty = clean.clone();
        dirty.walk_clean = false;
        assert_eq!(realism(&dirty, &[]), 0.4);
        let mut partial = clean;
        partial.publishable = false;
        assert_eq!(realism(&partial, &[]), 0.6);
    }
}
