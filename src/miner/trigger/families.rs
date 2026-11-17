//! Candidate families and the family filter (implementation unit S1).
//!
//! Replay-strategy §6.6 and §7.3 name the families a pack balances against:
//! `book`, `contested`, `mortal_best`, `mistake`, `close_call`, `speed_value`,
//! `coverage`, `table_read`, `placement`, `multi_step`. S1 does not select a
//! pack (that is S2); it answers the two questions a selector asks first:
//!
//! 1. Which families can this candidate feed? ([`Family`], derived from the
//!    trigger hits and the label kind.)
//! 2. Is at least one of them enabled? ([`FamilyFilter`].)
//!
//! The mapping is the trigger table in replay-strategy §6.5.1: a defensive
//! Riichi candidate feeds table reading, an offensive one feeds speed/value, a
//! call or kan feeds the book's ch. 9 cells or a Mortal call, a score context
//! feeds placement, and the label-derived triggers feed close-call and mistake.
//! A book match always adds `book` (the label's own family) and `coverage` (the
//! candidate fills a book section). The label kind adds the label's family even
//! when no trigger fired, so a plain book/Mortal label is never invisible to
//! selection.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::miner::label::LabelKind;

use super::{TriggerHit, TriggerKind};

/// One candidate family from replay-strategy §6.6/§7.3.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Family {
    /// A book lesson with a unique answer.
    Book,
    /// A book/Mortal disagreement (L2 `contested`).
    Contested,
    /// A Mortal-only best action.
    MortalBest,
    /// A blunder vs the labeler.
    Mistake,
    /// A top-two gap in the family's close band.
    CloseCall,
    /// A 1-shanten speed-vs-value divergence.
    SpeedValue,
    /// A decision that fills an under-represented book section.
    Coverage,
    /// A real river / safety read.
    TableRead,
    /// A score/placement context.
    Placement,
    /// A multi-step drill (no S1 trigger; reserved for the product stage).
    MultiStep,
}

impl Family {
    /// Every family, in report order.
    pub const ALL: [Family; 10] = [
        Family::Book,
        Family::Contested,
        Family::MortalBest,
        Family::Mistake,
        Family::CloseCall,
        Family::SpeedValue,
        Family::Coverage,
        Family::TableRead,
        Family::Placement,
        Family::MultiStep,
    ];

    /// The JSON/database spelling.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Book => "book",
            Self::Contested => "contested",
            Self::MortalBest => "mortal_best",
            Self::Mistake => "mistake",
            Self::CloseCall => "close_call",
            Self::SpeedValue => "speed_value",
            Self::Coverage => "coverage",
            Self::TableRead => "table_read",
            Self::Placement => "placement",
            Self::MultiStep => "multi_step",
        }
    }

    /// Parse a family name. `-` is accepted for `_`, so a CLI list is forgiving.
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        let normalised = raw.trim().to_ascii_lowercase().replace('-', "_");
        Self::ALL
            .into_iter()
            .find(|family| family.as_str() == normalised)
    }
}

impl std::fmt::Display for Family {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The families one candidate can feed.
///
/// `label` is the final L2 label when the trigger pass has one; before the
/// model pass it is `None` and only the cheap trigger families are known.
#[must_use]
pub fn families_for(
    hits: &[TriggerHit],
    label: Option<&crate::miner::label::ModelLabel>,
) -> BTreeSet<Family> {
    let mut families = BTreeSet::new();
    if let Some(label) = label {
        match label.kind() {
            LabelKind::Book => {
                families.insert(Family::Book);
            }
            LabelKind::Contested => {
                families.insert(Family::Contested);
            }
            LabelKind::Mortal => {
                families.insert(Family::MortalBest);
            }
            LabelKind::Unlabelled => {}
        }
        if label.book.is_some() {
            // A settled book label can exist without a model-free trigger hit
            // (a conflict Mortal settled); it still fills that book section.
            families.insert(Family::Coverage);
        }
    }

    let has_book = hits.iter().any(|hit| hit.trigger == TriggerKind::Book);
    for hit in hits {
        match hit.trigger {
            TriggerKind::Book => {
                families.insert(Family::Book);
                families.insert(Family::Coverage);
            }
            TriggerKind::DefensiveRiichi => {
                families.insert(Family::TableRead);
            }
            TriggerKind::OffensiveArchitecture => {
                families.insert(Family::SpeedValue);
            }
            TriggerKind::CallKan => {
                // A ch. 9 book cell is already covered by the book trigger; a
                // call with no book answer is a Mortal-best candidate.
                if !has_book {
                    families.insert(Family::MortalBest);
                }
            }
            TriggerKind::ScorePlacement => {
                families.insert(Family::Placement);
            }
            TriggerKind::CloseCall => {
                families.insert(Family::CloseCall);
            }
            TriggerKind::Blunder => {
                families.insert(Family::Mistake);
            }
        }
    }
    families
}

/// The enabled candidate families.
///
/// The default enables every family, which is the report's view. A selection
/// pass narrows it; a candidate with no enabled family is dropped **before** an
/// expensive stage, exactly like the cheap trigger prefilter.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct FamilyFilter {
    enabled: BTreeSet<Family>,
}

impl Default for FamilyFilter {
    fn default() -> Self {
        Self::all()
    }
}

impl FamilyFilter {
    /// Every family enabled.
    #[must_use]
    pub fn all() -> Self {
        Self {
            enabled: Family::ALL.into_iter().collect(),
        }
    }

    /// No family enabled (useful for a deliberate empty report).
    #[must_use]
    pub fn none() -> Self {
        Self {
            enabled: BTreeSet::new(),
        }
    }

    /// Build a filter from family names.
    ///
    /// An empty list means every family, matching the CLI's "no `--family`
    /// flag" default.
    pub fn parse(names: &[String]) -> Result<Self, super::TriggerError> {
        if names.is_empty() {
            return Ok(Self::all());
        }
        let mut enabled = BTreeSet::new();
        for name in names {
            let family = Family::parse(name)
                .ok_or_else(|| super::TriggerError::UnknownFamily { name: name.clone() })?;
            enabled.insert(family);
        }
        Ok(Self { enabled })
    }

    /// Only these families.
    #[must_use]
    pub fn only(families: impl IntoIterator<Item = Family>) -> Self {
        Self {
            enabled: families.into_iter().collect(),
        }
    }

    /// Whether a candidate with `families` is accepted.
    #[must_use]
    pub fn accepts(&self, families: &BTreeSet<Family>) -> bool {
        families.iter().any(|family| self.enabled.contains(family))
    }

    /// The enabled families, in report order.
    #[must_use]
    pub fn enabled(&self) -> Vec<Family> {
        Family::ALL
            .into_iter()
            .filter(|family| self.enabled.contains(family))
            .collect()
    }

    /// True when nothing can pass.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.enabled.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn family_names_round_trip_and_accept_hyphens() {
        for family in Family::ALL {
            assert_eq!(Family::parse(family.as_str()), Some(family));
            assert_eq!(
                Family::parse(&family.as_str().replace('_', "-")),
                Some(family)
            );
        }
        assert_eq!(Family::parse("unknown"), None);
    }

    #[test]
    fn the_default_filter_enables_every_family() {
        let filter = FamilyFilter::default();
        assert_eq!(filter.enabled(), Family::ALL.to_vec());
        for family in Family::ALL {
            assert!(filter.accepts(&BTreeSet::from([family])));
        }
        assert!(!filter.is_empty());
    }

    #[test]
    fn parsing_a_filter_is_fail_closed() {
        let only = FamilyFilter::parse(&["book".to_string(), "table-read".to_string()])
            .expect("known families");
        assert_eq!(only.enabled(), vec![Family::Book, Family::TableRead]);
        assert!(only.accepts(&BTreeSet::from([Family::TableRead])));
        assert!(!only.accepts(&BTreeSet::from([Family::Placement])));

        let all = FamilyFilter::parse(&[]).expect("empty means all");
        assert_eq!(all, FamilyFilter::all());

        assert!(FamilyFilter::parse(&["nope".to_string()]).is_err());
        assert!(FamilyFilter::none().is_empty());
    }
}
