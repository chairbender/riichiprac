//! Deterministic transform-chain planning for one base scenario.
//!
//! The stage must be reproducible: the same base, policy and seed always draw
//! the same chains in the same order. This module derives each chain's family
//! order and parameters from the SHA-256 of `seed|base id|attempt`, so no RNG
//! state is involved and a test can pin an exact chain.
//!
//! # What a plan looks like
//!
//! The first `n` attempts are the `n` families the policy allows, one each. From
//! attempt `n` on, a chain composes two allowed families (the second rotates,
//! so the pairs are not all the same). Composition matters for anti-memorisation
//! (§4.1): a hand whose suits *and* ranks are both relabelled is harder to
//! recognise than either alone.
//!
//! Every single-family chain is non-identity: the five suit bijections exclude
//! the identity, the five opponent orders exclude `[1, 2, 3]`, and a wind
//! rotation is one to three steps. Two families in a chain are always distinct,
//! so a composed chain cannot cancel into the identity.

use crate::classifier::TransformPolicy;
use crate::miner::provenance::sha256_hex;
use crate::miner::transform::{SeatPerm, Suit, SuitMap, Transform, TransformChain, TransformError};

use super::TransformFamily;

/// One planned chain and the families it uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedChain {
    /// The ordered transform chain, ready for [`TransformChain::apply`].
    pub chain: TransformChain,
    /// The families in application order (`chain.transforms` projected).
    pub families: Vec<TransformFamily>,
}

impl PlannedChain {
    /// The chain's fingerprint, the per-base dedupe key.
    #[must_use]
    pub fn fingerprint(&self) -> String {
        self.chain.fingerprint()
    }
}

/// The non-identity suit bijections, in a fixed order.
///
/// The two three-cycles first, then the three swaps.
fn suit_map(index: u64) -> SuitMap {
    let (m, p, s) = match index % 5 {
        0 => (Suit::Pin, Suit::Sou, Suit::Man),
        1 => (Suit::Sou, Suit::Man, Suit::Pin),
        2 => (Suit::Pin, Suit::Man, Suit::Sou),
        3 => (Suit::Sou, Suit::Pin, Suit::Man),
        _ => (Suit::Man, Suit::Sou, Suit::Pin),
    };
    SuitMap::new(m, p, s).expect("the five suit maps are bijections")
}

/// The non-identity permutations of seats 1–3, in a fixed order.
const SEAT_ORDERS: [[u8; 3]; 5] = [[2, 3, 1], [3, 1, 2], [2, 1, 3], [3, 2, 1], [1, 3, 2]];

/// The families `policy` opts in, in catalogue order.
#[must_use]
pub fn allowed_families(policy: TransformPolicy) -> Vec<TransformFamily> {
    TransformFamily::ALL
        .into_iter()
        .filter(|family| family.allowed(policy))
        .collect()
}

/// Plan up to `attempts` distinct chains for one base under `policy`.
///
/// Returns an empty vector when the policy allows no family, which the stage
/// reports as `policy_denies_all` rather than silently shipping the base alone.
#[must_use]
pub fn plan_for(
    base_id: &str,
    policy: TransformPolicy,
    seed: &str,
    attempts: usize,
) -> Vec<PlannedChain> {
    let allowed = allowed_families(policy);
    if allowed.is_empty() || attempts == 0 {
        return Vec::new();
    }

    let mut plans: Vec<PlannedChain> = Vec::with_capacity(attempts);
    let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let limit = attempts.saturating_mul(4);
    for attempt in 0..limit {
        if plans.len() == attempts {
            break;
        }
        let plan = match plan_attempt(base_id, seed, attempt, &allowed) {
            Some(plan) => plan,
            None => continue,
        };
        if seen.insert(plan.fingerprint()) {
            plans.push(plan);
        }
    }
    plans
}

fn plan_attempt(
    base_id: &str,
    seed: &str,
    attempt: usize,
    allowed: &[TransformFamily],
) -> Option<PlannedChain> {
    let count = allowed.len();
    let primary = allowed[attempt % count];
    let secondary = if attempt >= count && count > 1 {
        let offset = 1 + ((attempt / count - 1) % (count - 1));
        Some(allowed[(attempt % count + offset) % count])
    } else {
        None
    };

    let mut chain = TransformChain::new(format!("{seed}+{attempt}"));
    let mut families = Vec::with_capacity(2);
    chain.push(draw(primary, &draw_bits(base_id, seed, attempt, 0))?);
    families.push(primary);
    if let Some(secondary) = secondary {
        chain.push(draw(secondary, &draw_bits(base_id, seed, attempt, 1))?);
        families.push(secondary);
    }
    Some(PlannedChain { chain, families })
}

/// 64 pseudo-random bits for one draw, derived from the seed/base/attempt.
fn draw_bits(base_id: &str, seed: &str, attempt: usize, slot: u8) -> u64 {
    let hash = sha256_hex(format!("{seed}|{base_id}|{attempt}|{slot}").as_bytes());
    u64::from_str_radix(&hash[..16], 16).expect("sha256 hex is sixteen valid nibbles")
}

/// Turn a family plus draw bits into a concrete non-identity transform.
fn draw(family: TransformFamily, bits: &u64) -> Option<Transform> {
    match family {
        TransformFamily::SeatPerm => {
            let order = SEAT_ORDERS[(*bits % 5) as usize];
            Some(Transform::SeatPerm {
                order: SeatPerm::new(order).ok()?,
            })
        }
        TransformFamily::SuitPerm => Some(Transform::SuitPerm {
            map: suit_map(*bits),
        }),
        TransformFamily::RankMirror => Some(Transform::RankMirror {}),
        TransformFamily::WindRelabel => Some(Transform::WindRelabel {
            steps: ((*bits % 3) as u8) + 1,
        }),
        TransformFamily::Red5Normalize => Some(Transform::Red5Normalize {}),
    }
}

/// Check that a chain's declared families are exactly its transforms.
pub(crate) fn families_of(chain: &TransformChain) -> Vec<TransformFamily> {
    chain.transforms.iter().map(TransformFamily::of).collect()
}

/// Best-effort invariant used by the stage: a planned chain never validates to
/// an error.
pub(crate) fn plan_is_valid(plan: &PlannedChain) -> Result<(), TransformError> {
    plan.chain.validate()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::classifier::Allowed;

    fn all_allowed() -> TransformPolicy {
        TransformPolicy {
            seat_perm: Allowed::AllowWithRecompute,
            suit_perm: Allowed::AllowWithRecompute,
            rank_mirror: Allowed::AllowWithRecompute,
            wind_relabel: Allowed::AllowWithRecompute,
            red5_normalize: Allowed::AllowWithRecompute,
            note: "test",
        }
    }

    #[test]
    fn a_full_policy_plans_one_chain_per_family_first() {
        let plans = plan_for("base", all_allowed(), "0x51", 5);
        assert_eq!(plans.len(), 5);
        let families: Vec<TransformFamily> = plans.iter().map(|plan| plan.families[0]).collect();
        assert_eq!(families, TransformFamily::ALL.to_vec());
        assert!(plans.iter().all(|plan| plan.families.len() == 1));
    }

    #[test]
    fn later_attempts_compose_two_distinct_families() {
        let plans = plan_for("base", all_allowed(), "0x51", 8);
        assert!(plans.len() >= 6);
        for plan in &plans[5..] {
            assert_eq!(plan.families.len(), 2, "{:?}", plan.families);
            assert_ne!(plan.families[0], plan.families[1]);
        }
    }

    #[test]
    fn planning_is_reproducible_and_distinct() {
        let one = plan_for("base", all_allowed(), "0x51", 8);
        let two = plan_for("base", all_allowed(), "0x51", 8);
        assert_eq!(one, two);
        let fingerprints: std::collections::BTreeSet<String> =
            one.iter().map(PlannedChain::fingerprint).collect();
        assert_eq!(fingerprints.len(), one.len(), "chains must be distinct");
        // The fingerprint is per base: two bases that draw the same family and
        // parameters share it, which is what the stage's per-base dedupe wants.
        let other = plan_for("another-base", all_allowed(), "0x51", 8);
        assert_eq!(one[0].families, other[0].families);
    }

    #[test]
    fn a_denied_family_is_never_planned() {
        let policy = TransformPolicy {
            seat_perm: Allowed::Deny,
            suit_perm: Allowed::AllowWithRecompute,
            rank_mirror: Allowed::AllowWithRecompute,
            wind_relabel: Allowed::Deny,
            red5_normalize: Allowed::Deny,
            note: "test",
        };
        let plans = plan_for("base", policy, "0x01", 12);
        assert!(!plans.is_empty());
        for plan in &plans {
            assert!(plan.families.iter().all(|family| {
                matches!(
                    family,
                    TransformFamily::SuitPerm | TransformFamily::RankMirror
                )
            }));
        }
    }

    #[test]
    fn an_identity_only_policy_plans_nothing() {
        let policy = TransformPolicy::DENY;
        assert!(plan_for("base", policy, "0x01", 8).is_empty());
    }

    #[test]
    fn every_planned_chain_validates_and_matches_its_families() {
        for plan in plan_for("base", all_allowed(), "0x02", 12) {
            plan_is_valid(&plan).expect("a planned chain validates");
            assert_eq!(families_of(&plan.chain), plan.families);
            assert!(!plan.chain.is_empty());
        }
    }
}
