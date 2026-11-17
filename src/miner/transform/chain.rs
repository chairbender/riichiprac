//! The ordered transform chain, its inverse and the provenance document.
//!
//! The catalogue is the five transforms `replay-implementation-plan.md` §4.3
//! defines. A [`TransformChain`] is the `riichiprac.scenario-transforms` v1
//! document: a seed, the ordered transforms with their parameters, and — once
//! the chain has been applied — the red-five copies it normalised, which is the
//! only forward information the inverse cannot otherwise recover.
//!
//! # Contract
//!
//! - A transform chain is a **pure relabelling**. It never recomputes a derived
//!   field (shanten, ukeire, `book_rationale`, `can_riichi`): the
//!   label-preservation gate does that on the transformed state (§4.4).
//! - Every transform is reversible. [`TransformChain::apply`] returns a
//!   [`Resolved`] whose inverse restores the base state exactly, including the
//!   red-five identities.
//! - [`TransformChain::apply`] fails closed on a state the chain would make
//!   impossible (a chi that stops coming from the caller's kamicha, an answer
//!   that names the red copy being normalised). Reachability, legal answers and
//!   label preservation remain the gate's checks.

use serde::{Deserialize, Serialize};

use crate::decision::ActionInfo;
use crate::miner::provenance::sha256_hex;
use crate::state::{CorrectAction, GameState};

use super::TransformError;
use super::apply::{self, RedFiveSlot};
use super::mapping::Mapping;
use super::seat::SeatPerm;
use super::tiles::{KindMap, SuitMap};

/// Schema name of a transform-chain document.
pub const TRANSFORM_SCHEMA: &str = crate::miner::SCENARIO_TRANSFORMS_SCHEMA;

/// Schema version of a transform-chain document.
pub const TRANSFORM_VERSION: u32 = crate::miner::JSON_SCHEMA_VERSION;

fn schema_name() -> String {
    TRANSFORM_SCHEMA.to_string()
}

const fn schema_version() -> u32 {
    TRANSFORM_VERSION
}

/// One catalogue transform and its parameters.
///
/// Serialises as `{"kind": ..., "params": {...}}`. The parameters are the values
/// §4.6 records for a variant, so a chain document alone reproduces the variant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "params", rename_all = "snake_case")]
pub enum Transform {
    /// Permute the three opponents around the acting seat.
    SeatPerm {
        /// `order[new_seat - 1]` is the old seat now at `new_seat`.
        order: SeatPerm,
    },
    /// Relabel the three numbered suits.
    SuitPerm {
        /// The suit bijection.
        map: SuitMap,
    },
    /// Mirror ranks inside each numbered suit (`r` ↔ `10 - r`).
    RankMirror {},
    /// Rotate every wind (seat winds, wind honours and the round wind) by
    /// `steps`.
    WindRelabel {
        /// Rotation in seats, `0..=3`.
        steps: u8,
    },
    /// Drop the aka identity of every red five on the table.
    ///
    /// The copies are recorded on the chain ([`TransformChain::red_fives`]) when
    /// the chain is applied, so the inverse can put them back.
    Red5Normalize {},
}

impl Transform {
    /// The transform's parameters, as the one post-condition check reads them.
    pub fn validate(&self) -> Result<(), TransformError> {
        match self {
            Self::SeatPerm { order } => SeatPerm::new(order.order()).map(|_| ()),
            Self::SuitPerm { map } => map.validate(),
            Self::RankMirror {} => Ok(()),
            Self::WindRelabel { steps } => {
                if *steps < 4 {
                    Ok(())
                } else {
                    Err(TransformError::InvalidWindSteps { steps: *steps })
                }
            }
            Self::Red5Normalize {} => Ok(()),
        }
    }

    /// This transform as one relabelling step.
    #[must_use]
    pub fn mapping(&self) -> Mapping {
        match self {
            Self::SeatPerm { order } => Mapping {
                seat: *order,
                ..Mapping::identity()
            },
            Self::SuitPerm { map } => Mapping {
                kinds: KindMap::suit(*map),
                ..Mapping::identity()
            },
            Self::RankMirror {} => Mapping {
                kinds: KindMap::rank_mirror(),
                flips_chi: true,
                ..Mapping::identity()
            },
            Self::WindRelabel { steps } => Mapping {
                kinds: KindMap::wind_rotation(*steps),
                wind_steps: *steps % 4,
                ..Mapping::identity()
            },
            Self::Red5Normalize {} => Mapping {
                keeps_red_fives: false,
                ..Mapping::identity()
            },
        }
    }

    /// Reject a state this transform would turn into an impossible table.
    pub fn check_applicable(&self, state: &GameState) -> Result<(), TransformError> {
        match self {
            Self::SeatPerm { order } => apply::check_chi_seats(state, *order),
            Self::Red5Normalize {} => apply::check_red_five_answers(state),
            Self::SuitPerm { .. } | Self::RankMirror {} | Self::WindRelabel { .. } => Ok(()),
        }
    }

    /// The mapping that undoes this transform.
    #[must_use]
    pub fn inverse(&self, red_fives: &[RedFiveSlot]) -> InverseTransform {
        match self {
            Self::SeatPerm { order } => InverseTransform::SeatPerm {
                order: order.inverse(),
            },
            Self::SuitPerm { map } => InverseTransform::SuitPerm { map: map.inverse() },
            Self::RankMirror {} => InverseTransform::RankMirror {},
            Self::WindRelabel { steps } => InverseTransform::WindRelabel {
                steps: (4 - steps % 4) % 4,
            },
            Self::Red5Normalize {} => InverseTransform::RestoreRedFives {
                slots: red_fives.to_vec(),
            },
        }
    }
}

/// The transform chain applied to a scenario, as a `riichiprac.scenario-transforms`
/// v1 document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TransformChain {
    /// Schema name; always [`TRANSFORM_SCHEMA`].
    #[serde(default = "schema_name")]
    pub schema: String,
    /// Schema version; always [`TRANSFORM_VERSION`].
    #[serde(default = "schema_version")]
    pub version: u32,
    /// The seed the variant's parameters were drawn from, e.g. `0x51`.
    #[serde(default)]
    pub transform_seed: String,
    /// The transforms, in application order.
    pub transforms: Vec<Transform>,
    /// Red-five copies a `red5_normalize` cleared, in the coordinates of the
    /// state the step ran on.
    ///
    /// `None` until the chain has been applied. Present but empty means the
    /// chain normalised red fives and found none; present and non-empty is the
    /// record the inverse restores from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub red_fives: Option<Vec<RedFiveSlot>>,
}

impl Default for TransformChain {
    fn default() -> Self {
        Self {
            schema: schema_name(),
            version: schema_version(),
            transform_seed: String::new(),
            transforms: Vec::new(),
            red_fives: None,
        }
    }
}

impl TransformChain {
    /// An empty chain drawn from `seed`.
    pub fn new(seed: impl Into<String>) -> Self {
        Self {
            transform_seed: seed.into(),
            ..Self::default()
        }
    }

    /// Append a transform.
    pub fn push(&mut self, transform: Transform) -> &mut Self {
        self.transforms.push(transform);
        self
    }

    /// Append a transform, builder style.
    #[must_use]
    pub fn with(mut self, transform: Transform) -> Self {
        self.transforms.push(transform);
        self
    }

    /// True when the chain relabels nothing.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.transforms.is_empty()
    }

    /// Reject an unknown schema, an unknown version, bad parameters or a chain
    /// that normalises red fives twice.
    pub fn validate(&self) -> Result<(), TransformError> {
        if self.schema != TRANSFORM_SCHEMA {
            return Err(TransformError::Schema {
                found: self.schema.clone(),
                expected: TRANSFORM_SCHEMA,
            });
        }
        if self.version != TRANSFORM_VERSION {
            return Err(TransformError::Version {
                found: self.version,
                expected: TRANSFORM_VERSION,
            });
        }
        let mut normalised = false;
        for transform in &self.transforms {
            transform.validate()?;
            if matches!(transform, Transform::Red5Normalize {}) {
                if normalised {
                    return Err(TransformError::DuplicateRedFiveNormalize);
                }
                normalised = true;
            }
        }
        Ok(())
    }

    /// Apply the chain and return the transformed state with its resolved chain.
    ///
    /// The returned chain carries the red-five copies the run normalised, so it
    /// is the provenance document for the variant and the input to
    /// [`Resolved::inverse`].
    pub fn apply(&self, state: &GameState) -> Result<Resolved, TransformError> {
        self.validate()?;
        let mut out = state.clone();
        let mut red_fives = None;
        for transform in &self.transforms {
            transform.check_applicable(&out)?;
            match transform {
                Transform::Red5Normalize {} => {
                    red_fives = Some(apply::clear_red_fives(&mut out));
                }
                other => apply::apply_mapping(&mut out, &other.mapping())?,
            }
        }
        Ok(Resolved {
            state: out,
            chain: Self {
                red_fives,
                ..self.clone()
            },
        })
    }

    /// The inverse of an applied chain.
    pub fn inverse(&self) -> Result<InverseChain, TransformError> {
        self.validate()?;
        let normalises = self
            .transforms
            .iter()
            .any(|transform| matches!(transform, Transform::Red5Normalize {}));
        if normalises && self.red_fives.is_none() {
            return Err(TransformError::UnresolvedRedFives);
        }
        Ok(self.inverse_resolved())
    }

    /// The inverse, without checking that the chain was resolved.
    fn inverse_resolved(&self) -> InverseChain {
        let slots = self.red_fives.clone().unwrap_or_default();
        InverseChain {
            schema: schema_name(),
            version: schema_version(),
            steps: self
                .transforms
                .iter()
                .rev()
                .map(|transform| transform.inverse(&slots))
                .collect(),
        }
    }

    /// Stable hash of the chain's transform parameters, for variant dedupe.
    ///
    /// The seed and the derived red-five record are part of the document but
    /// not of the hash: two variants of one base state are the same transform
    /// when they apply the same operations, whatever seed chose them.
    #[must_use]
    pub fn fingerprint(&self) -> String {
        let mut canonical = self.clone();
        canonical.transform_seed = String::new();
        canonical.red_fives = None;
        let bytes = serde_json::to_vec(&canonical).expect("a transform chain always serialises");
        sha256_hex(&bytes)
    }

    /// One relabelling step per transform, in order.
    fn mappings(&self) -> impl Iterator<Item = Mapping> + '_ {
        self.transforms.iter().map(Transform::mapping)
    }

    /// Relabel one app tile code through the whole chain.
    pub fn map_tile(&self, code: &str) -> Result<String, TransformError> {
        let mut current = code.to_string();
        for mapping in self.mappings() {
            current = mapping.map_code(&current)?;
        }
        Ok(current)
    }

    /// Relabel every tile token in free text through the whole chain.
    pub fn map_text(&self, text: &str) -> String {
        self.mappings()
            .fold(text.to_string(), |text, mapping| mapping.map_text(&text))
    }

    /// Relabel one Mortal action name through the whole chain.
    pub fn map_action_name(&self, action: &str) -> Result<String, TransformError> {
        let mut current = action.to_string();
        for mapping in self.mappings() {
            current = mapping.map_action_name(&current)?;
        }
        Ok(current)
    }

    /// Relabel a graded answer through the whole chain.
    pub fn map_correct_action(
        &self,
        action: &CorrectAction,
    ) -> Result<CorrectAction, TransformError> {
        let mut current = action.clone();
        for mapping in self.mappings() {
            current = mapping.map_correct_action(&current)?;
        }
        Ok(current)
    }

    /// Relabel one legal action through the whole chain.
    pub fn map_action_info(&self, info: &ActionInfo) -> Result<ActionInfo, TransformError> {
        let mut current = info.clone();
        for mapping in self.mappings() {
            current = mapping.map_action_info(&current)?;
        }
        Ok(current)
    }
}

/// A transformed state plus the chain document that produced it.
#[derive(Debug, Clone, PartialEq)]
pub struct Resolved {
    /// The transformed table.
    pub state: GameState,
    /// The chain, with the red-five record filled in.
    pub chain: TransformChain,
}

impl Resolved {
    /// The inverse mapping, which restores the base state exactly.
    #[must_use]
    pub fn inverse(&self) -> InverseChain {
        self.chain.inverse_resolved()
    }
}

/// One inverse step. Not a scenario variant: the inverse of a transform chain is
/// a mapping, and the only transform that is not information-preserving on its
/// own is the red-five normalisation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "params", rename_all = "snake_case")]
pub enum InverseTransform {
    /// Undo an opponent permutation.
    SeatPerm { order: SeatPerm },
    /// Undo a suit permutation.
    SuitPerm { map: SuitMap },
    /// Undo a rank mirror.
    RankMirror {},
    /// Undo a wind rotation.
    WindRelabel { steps: u8 },
    /// Put the recorded red-five identities back.
    RestoreRedFives { slots: Vec<RedFiveSlot> },
}

impl InverseTransform {
    /// This inverse as one relabelling step; `None` for a red-five restore,
    /// which touches aka flags rather than tile kinds.
    #[must_use]
    pub fn mapping(&self) -> Option<Mapping> {
        match self {
            Self::SeatPerm { order } => Some(Mapping {
                seat: *order,
                ..Mapping::identity()
            }),
            Self::SuitPerm { map } => Some(Mapping {
                kinds: KindMap::suit(*map),
                ..Mapping::identity()
            }),
            Self::RankMirror {} => Some(Mapping {
                kinds: KindMap::rank_mirror(),
                flips_chi: true,
                ..Mapping::identity()
            }),
            Self::WindRelabel { steps } => Some(Mapping {
                kinds: KindMap::wind_rotation(*steps),
                wind_steps: *steps % 4,
                ..Mapping::identity()
            }),
            Self::RestoreRedFives { .. } => None,
        }
    }
}

/// The inverse of a transform chain, as an audit record and an executable map.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InverseChain {
    /// Schema name; always [`TRANSFORM_SCHEMA`].
    #[serde(default = "schema_name")]
    pub schema: String,
    /// Schema version; always [`TRANSFORM_VERSION`].
    #[serde(default = "schema_version")]
    pub version: u32,
    /// The inverse steps, in application order.
    pub steps: Vec<InverseTransform>,
}

impl InverseChain {
    /// Reject a document with another schema or version.
    pub fn validate(&self) -> Result<(), TransformError> {
        if self.schema != TRANSFORM_SCHEMA {
            return Err(TransformError::Schema {
                found: self.schema.clone(),
                expected: TRANSFORM_SCHEMA,
            });
        }
        if self.version != TRANSFORM_VERSION {
            return Err(TransformError::Version {
                found: self.version,
                expected: TRANSFORM_VERSION,
            });
        }
        Ok(())
    }

    /// Restore the base state from a chain's output.
    pub fn apply(&self, state: &GameState) -> Result<GameState, TransformError> {
        self.validate()?;
        let mut out = state.clone();
        for step in &self.steps {
            match step {
                InverseTransform::RestoreRedFives { slots } => {
                    apply::restore_red_fives(&mut out, slots)?;
                }
                other => {
                    if let Some(mapping) = other.mapping() {
                        apply::apply_mapping(&mut out, &mapping)?;
                    }
                }
            }
        }
        Ok(out)
    }

    /// One relabelling step per inverse step, in order.
    fn mappings(&self) -> impl Iterator<Item = Mapping> + '_ {
        self.steps.iter().filter_map(InverseTransform::mapping)
    }

    /// Relabel one app tile code back to the base vocabulary.
    pub fn map_tile(&self, code: &str) -> Result<String, TransformError> {
        let mut current = code.to_string();
        for mapping in self.mappings() {
            current = mapping.map_code(&current)?;
        }
        Ok(current)
    }

    /// Relabel every tile token in free text back to the base vocabulary.
    pub fn map_text(&self, text: &str) -> String {
        self.mappings()
            .fold(text.to_string(), |text, mapping| mapping.map_text(&text))
    }

    /// Relabel one Mortal action name back to the base vocabulary.
    pub fn map_action_name(&self, action: &str) -> Result<String, TransformError> {
        let mut current = action.to_string();
        for mapping in self.mappings() {
            current = mapping.map_action_name(&current)?;
        }
        Ok(current)
    }

    /// Relabel a graded answer back to the base vocabulary.
    ///
    /// A red-five answer never reaches this mapping: the forward chain refuses
    /// such a state, and the restore step carries no tile-kind change.
    pub fn map_correct_action(
        &self,
        action: &CorrectAction,
    ) -> Result<CorrectAction, TransformError> {
        let mut current = action.clone();
        for mapping in self.mappings() {
            current = mapping.map_correct_action(&current)?;
        }
        Ok(current)
    }

    /// Relabel one legal action back to the base vocabulary.
    pub fn map_action_info(&self, info: &ActionInfo) -> Result<ActionInfo, TransformError> {
        let mut current = info.clone();
        for mapping in self.mappings() {
            current = mapping.map_action_info(&current)?;
        }
        Ok(current)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::miner::transform::tests::synthetic_state;
    use crate::miner::transform::tiles::Suit;

    fn suit_chain() -> TransformChain {
        TransformChain::new("0x51").with(Transform::SuitPerm {
            map: SuitMap::new(Suit::Pin, Suit::Sou, Suit::Man).expect("bijection"),
        })
    }

    #[test]
    fn a_chain_document_records_schema_version_seed_and_params() {
        let chain = suit_chain().with(Transform::RankMirror {});
        let json = serde_json::to_value(&chain).expect("serialises");
        assert_eq!(json["schema"], TRANSFORM_SCHEMA);
        assert_eq!(json["version"], TRANSFORM_VERSION);
        assert_eq!(json["transform_seed"], "0x51");
        assert_eq!(json["transforms"][0]["kind"], "suit_perm");
        assert_eq!(
            json["transforms"][0]["params"]["map"],
            serde_json::json!({"m": "p", "p": "s", "s": "m"})
        );
        assert_eq!(json["transforms"][1]["kind"], "rank_mirror");
        assert_eq!(json["transforms"][1]["params"], serde_json::json!({}));
        assert!(json.get("red_fives").is_none());

        let parsed: TransformChain = serde_json::from_value(json).expect("parses");
        assert_eq!(parsed, chain);
    }

    #[test]
    fn every_catalogue_transform_round_trips_through_json() {
        let transforms = [
            Transform::SeatPerm {
                order: SeatPerm::new([2, 3, 1]).expect("permutation"),
            },
            Transform::SuitPerm {
                map: SuitMap::new(Suit::Sou, Suit::Man, Suit::Pin).expect("bijection"),
            },
            Transform::RankMirror {},
            Transform::WindRelabel { steps: 3 },
            Transform::Red5Normalize {},
        ];
        for transform in transforms {
            let json = serde_json::to_string(&transform).expect("serialises");
            assert_eq!(
                serde_json::from_str::<Transform>(&json).expect("parses"),
                transform,
                "{json}"
            );
        }
    }

    #[test]
    fn a_chain_restores_its_base_state_exactly() {
        let base = synthetic_state();
        let chain = TransformChain::new("0x7f")
            .with(Transform::SuitPerm {
                map: SuitMap::new(Suit::Pin, Suit::Sou, Suit::Man).expect("bijection"),
            })
            .with(Transform::RankMirror {})
            .with(Transform::WindRelabel { steps: 1 })
            .with(Transform::SeatPerm {
                order: SeatPerm::new([2, 3, 1]).expect("permutation"),
            })
            .with(Transform::Red5Normalize {});
        let applied = chain.apply(&base).expect("applies");
        assert_ne!(applied.state, base, "the chain must change the table");

        let restored = applied
            .inverse()
            .apply(&applied.state)
            .expect("the inverse applies");
        assert_eq!(restored, base);
    }

    #[test]
    fn a_red_five_chain_records_what_it_normalised() {
        let base = synthetic_state();
        let chain = TransformChain::new("0x11").with(Transform::Red5Normalize {});
        assert!(
            chain.inverse().is_err(),
            "an unapplied chain has no inverse"
        );

        let applied = chain.apply(&base).expect("applies");
        let slots = applied
            .chain
            .red_fives
            .as_ref()
            .expect("the applied chain records the copies");
        assert!(!slots.is_empty());
        assert!(
            applied.state.players.iter().all(|p| p.red_fives.is_empty()),
            "every red five is normalised"
        );
        assert!(applied.chain.inverse().is_ok());
    }

    #[test]
    fn the_fingerprint_ignores_the_seed_and_the_red_five_record() {
        let one = suit_chain();
        let mut two = suit_chain();
        two.transform_seed = "0x99".to_string();
        assert_eq!(one.fingerprint(), two.fingerprint());

        let other = suit_chain().with(Transform::RankMirror {});
        assert_ne!(one.fingerprint(), other.fingerprint());
    }

    #[test]
    fn a_foreign_schema_or_version_is_rejected() {
        let mut chain = suit_chain();
        chain.schema = "riichiprac.other".to_string();
        assert!(matches!(
            chain.validate(),
            Err(TransformError::Schema { .. })
        ));

        let mut chain = suit_chain();
        chain.version = 99;
        assert!(matches!(
            chain.validate(),
            Err(TransformError::Version { .. })
        ));

        let mut chain = suit_chain();
        chain.push(Transform::WindRelabel { steps: 4 });
        assert!(matches!(
            chain.validate(),
            Err(TransformError::InvalidWindSteps { .. })
        ));
    }

    #[test]
    fn normalising_red_fives_twice_is_rejected() {
        let chain = TransformChain::new("0x01")
            .with(Transform::Red5Normalize {})
            .with(Transform::Red5Normalize {});
        assert!(matches!(
            chain.apply(&synthetic_state()),
            Err(TransformError::DuplicateRedFiveNormalize)
        ));
    }

    #[test]
    fn action_names_fold_through_the_chain() {
        let chain = TransformChain::new("0x02")
            .with(Transform::SuitPerm {
                map: SuitMap::new(Suit::Pin, Suit::Sou, Suit::Man).expect("bijection"),
            })
            .with(Transform::RankMirror {});
        assert_eq!(chain.map_action_name("Discard_3m").unwrap(), "Discard_7p");
        assert_eq!(chain.map_action_name("Discard_5mr").unwrap(), "Discard_5pr");
        assert_eq!(chain.map_action_name("Chi_Low").unwrap(), "Chi_High");
        assert_eq!(chain.map_action_name("Pon").unwrap(), "Pon");
    }

    #[test]
    fn two_rank_mirrors_cancel_in_the_answer_vocabulary() {
        let chain = TransformChain::new("0x03")
            .with(Transform::RankMirror {})
            .with(Transform::RankMirror {});
        assert_eq!(chain.map_action_name("Chi_Low").unwrap(), "Chi_Low");
        assert_eq!(chain.map_action_name("Discard_3m").unwrap(), "Discard_3m");
    }
}
