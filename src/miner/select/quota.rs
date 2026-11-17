//! Family quotas and diversity caps (implementation unit S2).
//!
//! Replay-strategy §6.6 is explicit that selection is a **quota problem, not one
//! sort**: "quotas prevent the easiest family (usually `mortal_best`) from
//! crowding out the pedagogically valuable ones." This module turns the
//! configured shares into integer quotas and the section/kind/turn shares into
//! integer diversity caps.
//!
//! # Family quotas
//!
//! A share is a fraction of `pack_size`. Shares are converted with the
//! largest-remainder method, so `0.30`, `0.05`, … of a 100-scenario pack become
//! exact integer counts that add up to `round(sum * pack_size)` without a
//! rounding bias. Shares may sum to less than `1.0`; the leftover slots are
//! reported as [`QuotaPlan::open_slots`] and may be filled by the best remaining
//! candidate (see [`super::plan_selection`]). A sum above `1.0` is an error
//! rather than a silent rescale, because silently changing the mix would hide an
//! operator mistake.
//!
//! # Diversity caps
//!
//! §7.2's "novelty/coverage" and "diversity" rows ask for per-book-section,
//! per-decision-kind and per-turn-bucket limits. A cap is a **maximum** count:
//! it stops a hundred near-identical ryanmen discards filling the pack, and a
//! family that cannot fill its quota without breaking a cap is reported as a
//! shortfall instead of quietly overshooting. Caps default to a generous share
//! (section 20 %, decision kind 60 %, turn bucket 60 %) because the corpus mix is
//! the thing being measured, not tuned.
//!
//! `multi_step` defaults to a zero share: §7.3 lists it as a later product
//! feature, and a permanent reported shortfall for a family the pipeline cannot
//! produce yet would be noise. An operator can opt in with a share.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::miner::trigger::families::Family;

/// Per-family shares plus the three diversity shares.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QuotaConfig {
    /// Share of the pack each family may take.
    #[serde(default = "default_family_shares")]
    pub families: BTreeMap<Family, f32>,
    /// Maximum share of the pack one book section may take.
    #[serde(default = "default_section_share")]
    pub max_section_share: f32,
    /// Absolute per-section cap that overrides [`Self::max_section_share`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_per_section: Option<usize>,
    /// Maximum share of the pack one decision kind may take.
    #[serde(default = "default_kind_share")]
    pub max_decision_kind_share: f32,
    /// Maximum share of the pack one turn bucket may take.
    #[serde(default = "default_turn_share")]
    pub max_turn_bucket_share: f32,
}

fn default_family_shares() -> BTreeMap<Family, f32> {
    BTreeMap::from([
        (Family::Book, 0.30),
        (Family::Contested, 0.05),
        (Family::MortalBest, 0.10),
        (Family::Mistake, 0.10),
        (Family::CloseCall, 0.10),
        (Family::SpeedValue, 0.08),
        (Family::Coverage, 0.15),
        (Family::TableRead, 0.07),
        (Family::Placement, 0.05),
        // Reserved for the product stage; see the module docs.
        (Family::MultiStep, 0.00),
    ])
}

const fn default_section_share() -> f32 {
    0.20
}

const fn default_kind_share() -> f32 {
    0.60
}

const fn default_turn_share() -> f32 {
    0.60
}

impl Default for QuotaConfig {
    fn default() -> Self {
        Self {
            families: default_family_shares(),
            max_section_share: default_section_share(),
            max_per_section: None,
            max_decision_kind_share: default_kind_share(),
            max_turn_bucket_share: default_turn_share(),
        }
    }
}

impl QuotaConfig {
    /// Reject a share outside `0.0..=1.0`, a non-finite value, a sum above one,
    /// or an impossible cap.
    pub fn validate(&self) -> Result<(), String> {
        let mut total = 0.0;
        for (family, share) in &self.families {
            if !share.is_finite() || !(0.0..=1.0).contains(share) {
                return Err(format!(
                    "family `{family}` share {share} must be finite and between 0 and 1"
                ));
            }
            total += share;
        }
        if total > 1.0 + 1e-4 {
            return Err(format!(
                "family shares sum to {total:.4}; a pack cannot give away more than 100%"
            ));
        }
        for (name, share) in [
            ("max_section_share", self.max_section_share),
            ("max_decision_kind_share", self.max_decision_kind_share),
            ("max_turn_bucket_share", self.max_turn_bucket_share),
        ] {
            if !share.is_finite() || !(share > 0.0 && share <= 1.0) {
                return Err(format!("`{name}` {share} must be finite and in (0, 1]"));
            }
        }
        if self.max_per_section == Some(0) {
            return Err("`max_per_section` must be at least one".to_string());
        }
        Ok(())
    }

    /// The family shares as an explicit map, filling a missing family with 0.
    #[must_use]
    pub fn share(&self, family: Family) -> f32 {
        self.families.get(&family).copied().unwrap_or(0.0)
    }

    /// Integer quotas for a pack of `pack_size`, by largest remainder.
    #[must_use]
    pub fn family_counts(&self, pack_size: usize) -> BTreeMap<Family, usize> {
        let mut counts: BTreeMap<Family, usize> =
            Family::ALL.into_iter().map(|family| (family, 0)).collect();
        if pack_size == 0 {
            return counts;
        }
        let sum: f32 = Family::ALL.iter().map(|family| self.share(*family)).sum();
        let target = ((sum * pack_size as f32).round() as usize).min(pack_size);
        let mut remainders: Vec<(Family, f32)> = Family::ALL
            .iter()
            .map(|family| {
                let exact = self.share(*family) * pack_size as f32;
                let floor = exact.floor();
                counts.insert(*family, floor.max(0.0) as usize);
                (*family, exact - floor)
            })
            .collect();
        let mut allocated: usize = counts.values().sum();
        remainders.sort_by(|left, right| {
            right
                .1
                .total_cmp(&left.1)
                .then_with(|| left.0.cmp(&right.0))
        });
        // `target - sum(floors)` is always smaller than the number of families
        // with a positive share, so one pass in descending-remainder order
        // distributes every leftover slot exactly once.
        for (family, _) in remainders {
            if allocated >= target {
                break;
            }
            if self.share(family) > 0.0
                && let Some(count) = counts.get_mut(&family)
            {
                *count += 1;
                allocated += 1;
            }
        }
        counts
    }

    /// Integer caps for one bucket of each kind.
    #[must_use]
    pub fn caps(&self, pack_size: usize) -> QuotaCaps {
        let cap = |share: f32| {
            if share >= 1.0 {
                pack_size.max(1)
            } else {
                // `0.6 * 100` is `60.000004` in binary floating point; the
                // epsilon keeps a clean share from rounding up to 61.
                ((share * pack_size as f32 - 1e-4).ceil() as usize).max(1)
            }
        };
        QuotaCaps {
            section: self
                .max_per_section
                .unwrap_or_else(|| cap(self.max_section_share)),
            decision_kind: cap(self.max_decision_kind_share),
            turn_bucket: cap(self.max_turn_bucket_share),
        }
    }

    /// Slots a pack of `pack_size` leaves for the open (unquoted) fill.
    #[must_use]
    pub fn open_slots(&self, pack_size: usize) -> usize {
        pack_size.saturating_sub(self.family_counts(pack_size).values().sum())
    }
}

/// The integer diversity caps for one pack.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuotaCaps {
    /// Maximum scenarios from one book section.
    pub section: usize,
    /// Maximum scenarios from one decision kind.
    pub decision_kind: usize,
    /// Maximum scenarios from one turn bucket.
    pub turn_bucket: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_quotas_sum_to_the_pack_size() {
        let config = QuotaConfig::default();
        config.validate().expect("defaults are valid");
        let counts = config.family_counts(100);
        assert_eq!(counts.values().sum::<usize>(), 100);
        assert_eq!(counts[&Family::Book], 30);
        assert_eq!(counts[&Family::Coverage], 15);
        assert_eq!(counts[&Family::Contested], 5);
        assert_eq!(counts[&Family::MultiStep], 0);
        assert_eq!(config.open_slots(100), 0);
    }

    #[test]
    fn largest_remainder_is_exact_for_awkward_pack_sizes() {
        let config = QuotaConfig::default();
        for size in [1_usize, 3, 7, 10, 33, 99, 101] {
            let counts = config.family_counts(size);
            assert_eq!(
                counts.values().sum::<usize>(),
                ((size as f32) * 1.0).round() as usize,
                "pack size {size}"
            );
        }
    }

    #[test]
    fn a_partial_share_produces_open_slots() {
        let config = QuotaConfig {
            families: BTreeMap::from([(Family::Book, 0.5)]),
            ..QuotaConfig::default()
        };
        let counts = config.family_counts(10);
        assert_eq!(counts[&Family::Book], 5);
        assert_eq!(counts.values().sum::<usize>(), 5);
        assert_eq!(config.open_slots(10), 5);
    }

    #[test]
    fn an_over_allocated_mix_is_rejected() {
        let config = QuotaConfig {
            families: BTreeMap::from([(Family::Book, 0.8), (Family::Coverage, 0.5)]),
            ..QuotaConfig::default()
        };
        assert!(config.validate().is_err());
    }

    #[test]
    fn caps_are_integers_and_never_zero() {
        let config = QuotaConfig::default();
        let caps = config.caps(100);
        assert_eq!(caps.section, 20);
        assert_eq!(caps.decision_kind, 60);
        assert_eq!(caps.turn_bucket, 60);

        let small = config.caps(1);
        assert_eq!(small.section, 1);
        assert_eq!(small.decision_kind, 1);

        let absolute = QuotaConfig {
            max_per_section: Some(4),
            ..QuotaConfig::default()
        };
        assert_eq!(absolute.caps(100).section, 4);
    }

    #[test]
    fn implausible_shares_are_rejected() {
        for share in [-0.1, 1.5, f32::NAN] {
            let config = QuotaConfig {
                families: BTreeMap::from([(Family::Book, share)]),
                ..QuotaConfig::default()
            };
            assert!(config.validate().is_err(), "share {share} must be rejected");
        }
        let config = QuotaConfig {
            max_section_share: 0.0,
            ..QuotaConfig::default()
        };
        assert!(config.validate().is_err());
        let config = QuotaConfig {
            max_per_section: Some(0),
            ..QuotaConfig::default()
        };
        assert!(config.validate().is_err());
    }
}
