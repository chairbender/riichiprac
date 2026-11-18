//! The base scenario a variant is built from, and its label.
//!
//! A base is a [`PackScenario`] plus the label the stage must preserve. It can
//! come from three places:
//!
//! - the S2 review queue (the real pipeline: one selected, non-held-out item);
//! - a generated puzzle (the 100-scenario rehearsal and the tests);
//! - a hand-built pack scenario (tests and P1b's future assembly path).
//!
//! The base stores the pack-shaped scenario, not a `GameState` plus a pile of
//! flags, so a shipped variant is the base with a new id, a transformed state, a
//! transformed answer and the variant provenance filled in. The P1a pack gate
//! therefore checks the base and the variant with the same code.

use serde::{Deserialize, Serialize};

use crate::ai::finalize::normalize_mortal_action;
use crate::ai::wasm_bridge::Evaluation;
use crate::generator::{SCENARIO_MANIFEST, ScenarioId};
use crate::miner::label::{ModelLabel, VALUE_UNITS};
use crate::miner::pack::{
    PackBook, PackCounterfactual, PackMortal, PackProvenance, PackRankedAction, PackScenario,
    ScenarioKey,
};
use crate::miner::provenance::{GameProvenance, ReplayId};
use crate::miner::select::review::ReviewItem;
use crate::miner::trigger::families::Family;
use crate::state::TargetAction;

use super::{VariantError, VariantLabelKind};

/// The label a variant must preserve.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BaseLabel {
    /// Which gate applies.
    pub kind: VariantLabelKind,
    /// The book lesson, when the label has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lesson: Option<String>,
    /// The model's top action on the base, when a model label exists.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top_action: Option<String>,
    /// `p(top) - p(second)` on the base, when a model label exists.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub probability_margin: Option<f32>,
    /// `q(top) - q(second)` on the base, when recorded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub q_gap_top2: Option<f32>,
    /// Decision family key (`<kind>/<turn_bucket>`) for percentile bands.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision_family: Option<String>,
    /// The action the recorded player took, for a mistake drill.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub played_action: Option<String>,
}

impl BaseLabel {
    /// The key the yield report and a reviewer override use: the lesson when
    /// there is one, otherwise the label kind.
    #[must_use]
    pub fn key(&self) -> String {
        self.lesson.clone().unwrap_or_else(|| match self.kind {
            VariantLabelKind::Mortal => "mortal_best".to_string(),
            VariantLabelKind::Mistake => "mistake".to_string(),
            VariantLabelKind::Book => "book".to_string(),
            VariantLabelKind::Contested => "contested".to_string(),
        })
    }

    /// The model's top-two gap, Q first, then the probability margin.
    #[must_use]
    pub fn top2_gap(&self) -> Option<f32> {
        self.q_gap_top2.or(self.probability_margin)
    }
}

/// One base scenario: a pack-shaped scenario plus its label.
#[derive(Debug, Clone, PartialEq)]
pub struct BaseScenario {
    /// The scenario as a pack would hold it, with no variant fields set.
    pub scenario: PackScenario,
    /// The label the gate must preserve.
    pub label: BaseLabel,
    /// The replay corpus family the decision came from, when known.
    pub replay_family: Option<String>,
    /// The `decisions.decision_id` the base came from, when it came from a
    /// replay. A generated rehearsal base has none and is never persisted.
    pub decision_id: Option<String>,
}

impl BaseScenario {
    /// The base's scenario id.
    #[must_use]
    pub fn id(&self) -> &ScenarioKey {
        &self.scenario.id
    }

    /// Validate the pieces the gate assumes before it runs.
    pub fn validate(&self) -> Result<(), VariantError> {
        let state = &self.scenario.state;
        let reject = |detail: String| VariantError::Base {
            id: self.scenario.id.to_string(),
            detail,
        };
        if self.scenario.provenance.is_variant() {
            return Err(reject(
                "a base scenario must not carry variant provenance".to_string(),
            ));
        }
        if state.category != self.scenario.lesson_id {
            return Err(reject(format!(
                "`lesson_id` is `{}` but the state's category is `{}`",
                self.scenario.lesson_id, state.category
            )));
        }
        if self.scenario.correct_action != state.correct_action {
            return Err(reject(
                "the scenario answer differs from the state's own answer".to_string(),
            ));
        }
        match self.label.kind {
            VariantLabelKind::Book | VariantLabelKind::Contested => {
                let lesson = self.label.lesson.as_deref().ok_or_else(|| {
                    reject("a book/contested label must name its lesson".to_string())
                })?;
                if ScenarioId::from_id(lesson).is_none() {
                    return Err(reject(format!("`{lesson}` is not a registered lesson")));
                }
                if crate::classifier::classifier(
                    ScenarioId::from_id(lesson).expect("checked above"),
                )
                .is_none()
                {
                    return Err(reject(format!(
                        "lesson `{lesson}` has no registered classifier, so it has no transform \
                         policy"
                    )));
                }
            }
            VariantLabelKind::Mortal => {
                if self
                    .label
                    .top_action
                    .as_deref()
                    .unwrap_or("")
                    .trim()
                    .is_empty()
                {
                    return Err(reject(
                        "a Mortal label must record the model's top action".to_string(),
                    ));
                }
            }
            VariantLabelKind::Mistake => {
                let lesson = self.label.lesson.as_deref().ok_or_else(|| {
                    reject("a mistake label must name the lesson it grades against".to_string())
                })?;
                if ScenarioId::from_id(lesson).is_none() {
                    return Err(reject(format!("`{lesson}` is not a registered lesson")));
                }
                if self
                    .label
                    .played_action
                    .as_deref()
                    .unwrap_or("")
                    .trim()
                    .is_empty()
                {
                    return Err(reject(
                        "a mistake label must record the played action".to_string(),
                    ));
                }
            }
        }
        Ok(())
    }

    /// The classifier transform policy for this base.
    ///
    /// A lesson owns its policy. A label with no lesson (Mortal-only, or a
    /// mistake drill whose lesson is absent) uses the configured
    /// `mortal_policy`, which defaults to deny everywhere (§4.5).
    #[must_use]
    pub fn policy(
        &self,
        mortal_policy: crate::classifier::TransformPolicy,
    ) -> crate::classifier::TransformPolicy {
        let lesson = self
            .label
            .lesson
            .as_deref()
            .and_then(ScenarioId::from_id)
            .and_then(crate::classifier::transform_policy);
        lesson.unwrap_or(mortal_policy)
    }

    /// Build a base from one selected review-queue item.
    ///
    /// `label` is the base decision's cached model label from the DB, when the
    /// run has it; `played_action` is the action the replay recorded. Both are
    /// optional: a book base ships and transforms without a checkpoint, while a
    /// Mortal base needs the model label to name its top action.
    pub fn from_review_item(
        item: &ReviewItem,
        label: Option<&ModelLabel>,
        played_action: Option<&str>,
    ) -> Result<Self, VariantError> {
        let reject = |detail: String| VariantError::Base {
            id: item.queue_id.clone(),
            detail,
        };
        let kind = VariantLabelKind::parse(&item.label_kind)
            .ok_or_else(|| reject(format!("label kind `{}` cannot ship", item.label_kind)))?;
        let state = item.review.table.clone();
        if crate::miner::select::dedupe::exact_state_hash(&state) != item.exact_hash {
            return Err(reject(
                "the queue item's table does not match its recorded state hash; the queue was \
                 edited or written by a different build"
                    .to_string(),
            ));
        }

        let lesson = match kind {
            VariantLabelKind::Book | VariantLabelKind::Contested | VariantLabelKind::Mistake => {
                Some(item.lesson.clone().ok_or_else(|| {
                    reject("a book label must carry the selected lesson id".to_string())
                })?)
            }
            VariantLabelKind::Mortal => None,
        };

        let meta = lesson
            .as_deref()
            .and_then(ScenarioId::from_id)
            .and_then(|id| SCENARIO_MANIFEST.iter().find(|meta| meta.id == id));
        let title = meta
            .map(|meta| meta.label.to_string())
            .unwrap_or_else(|| item.review.scenario.label.clone());
        let prompt = prompt_for(state.target_action);

        let evaluation = item.review.ai.as_ref().map(|ai| &ai.evaluation);
        let top_action = label
            .map(|label| label.top_action.clone())
            .or_else(|| evaluation.map(|evaluation| evaluation.recommended_action.clone()));
        let (probability_margin, q_gap_top2) = evaluation.map(top_two_gaps).unwrap_or((None, None));
        let probability_margin = label
            .map(|label| label.probability_margin)
            .or(probability_margin);
        let q_gap_top2 = label.and_then(|label| label.q_gap_top2).or(q_gap_top2);

        let accepted = crate::miner::pack::accepted_for(&state);
        let scenario = PackScenario {
            id: ScenarioKey::parse(&item.queue_id).map_err(|err| reject(err.to_string()))?,
            lesson_id: state.category.clone(),
            book: meta.and_then(|meta| {
                meta.book.map(|book| PackBook {
                    chapter: book.chapter,
                    section: book.section,
                    key: book.key(),
                    label: book.label(),
                })
            }),
            title,
            prompt: prompt.to_string(),
            correct_action: state.correct_action.clone(),
            accepted,
            state,
            mortal: label.map(mortal_block),
            counterfactual: label.map(counterfactual_block),
            played: None,
            interestingness: Some(crate::miner::pack::PackInterestingness {
                score: item.score.clamp(0.0, 1.0),
                book_match: item.lesson.is_some(),
                mortal_agreement: item.label_stability.as_deref() == Some("stable"),
                counterfactual_tension: item.signals.counterfactual_tension.clamp(0.0, 1.0),
                coverage: item
                    .family
                    .map_or_else(|| "held_out".to_string(), |family| family.to_string()),
                tags: Vec::new(),
            }),
            provenance: PackProvenance {
                replay_id: ReplayId::parse(&item.replay_id)
                    .map_err(|err| reject(format!("replay id `{}`: {err}", item.replay_id)))?,
                decision_index: item.event_index,
                kyoku: None,
                honba: None,
                turn: u8::try_from(item.turn).ok(),
                transforms: Vec::new(),
                transform_seed: None,
                variant_of: None,
                transform_chain: None,
                label_check: None,
            },
            validation: crate::miner::pack::PackValidation {
                state_valid: true,
                replay_roundtrip: true,
                answer_recomputed: true,
                visible_info_only: true,
            },
        };

        let base = Self {
            scenario,
            label: BaseLabel {
                kind,
                lesson,
                top_action,
                probability_margin,
                q_gap_top2,
                decision_family: Some(format!("{}/{}", item.decision_kind, item.turn_bucket)),
                played_action: played_action.map(str::to_string),
            },
            replay_family: Some(item.replay_family.clone()),
            decision_id: Some(item.decision_id.clone()),
        };
        base.validate()?;
        Ok(base)
    }

    /// Build a base from a pack scenario and an explicit label (tests and the
    /// P1b path).
    pub fn from_pack_scenario(
        scenario: PackScenario,
        label: BaseLabel,
    ) -> Result<Self, VariantError> {
        let base = Self {
            scenario,
            label,
            replay_family: None,
            decision_id: None,
        };
        base.validate()?;
        Ok(base)
    }

    /// Build a book base from a generated puzzle.
    ///
    /// Used by the rehearsal: the generated state is stamped with its own
    /// classifier answer (the same path S2 uses), so the base is a legal,
    /// reachable, book-labelled scenario without a replay or a model.
    pub fn from_generated(
        lesson: ScenarioId,
        index: usize,
        replay: &GameProvenance,
    ) -> Result<Self, VariantError> {
        let reject = |detail: String| VariantError::Base {
            id: lesson.as_str().to_string(),
            detail,
        };
        let state = crate::generator::generate_puzzle(lesson.as_str())
            .map_err(|detail| reject(format!("cannot generate `{}`: {detail}", lesson.as_str())))?;
        let matched = crate::classifier::classify(&state, lesson).ok_or_else(|| {
            reject(format!(
                "the generated `{}` state does not match its own classifier",
                lesson.as_str()
            ))
        })?;
        let target_action = matched.target_action;
        let stamped = matched.stamp(state);
        // The accepted set is the pack's own rule (answer + equivalents, or
        // `pass`/the action name for a non-tile answer), not the match's tile
        // list: a Pass answer has no tile and must still be gradable.
        let accepted = crate::miner::pack::accepted_for(&stamped);
        let meta = SCENARIO_MANIFEST
            .iter()
            .find(|meta| meta.id == lesson)
            .expect("every classifier lesson is in the scenario manifest");
        let family = Family::Book;
        let scenario = PackScenario {
            id: ScenarioKey::parse(&format!("rehearsal-{}-{index:03}", lesson.as_str()))
                .map_err(|err| reject(err.to_string()))?,
            lesson_id: lesson.as_str().to_string(),
            book: meta.book.map(|book| PackBook {
                chapter: book.chapter,
                section: book.section,
                key: book.key(),
                label: book.label(),
            }),
            title: meta.label.to_string(),
            prompt: prompt_for(target_action).to_string(),
            correct_action: stamped.correct_action.clone(),
            accepted,
            state: stamped,
            mortal: None,
            counterfactual: None,
            played: None,
            interestingness: Some(crate::miner::pack::PackInterestingness {
                score: 0.5,
                book_match: true,
                mortal_agreement: false,
                counterfactual_tension: 0.0,
                coverage: family.to_string(),
                tags: vec!["rehearsal".to_string()],
            }),
            provenance: PackProvenance {
                replay_id: replay.replay_id.clone(),
                decision_index: index as u64,
                kyoku: Some("E1".to_string()),
                honba: Some(0),
                turn: Some(1),
                transforms: Vec::new(),
                transform_seed: None,
                variant_of: None,
                transform_chain: None,
                label_check: None,
            },
            validation: crate::miner::pack::PackValidation::fixture(),
        };
        let base = Self {
            scenario,
            label: BaseLabel {
                kind: VariantLabelKind::Book,
                lesson: Some(lesson.as_str().to_string()),
                top_action: None,
                probability_margin: None,
                q_gap_top2: None,
                decision_family: None,
                played_action: None,
            },
            replay_family: Some(replay.family.clone()),
            decision_id: None,
        };
        base.validate()?;
        Ok(base)
    }
}

/// An answer-free prompt for a decision kind, matching P1a's fixture copy.
#[must_use]
pub fn prompt_for(target: TargetAction) -> &'static str {
    match target {
        TargetAction::Riichi | TargetAction::Dama => "Declare riichi, or stay in dama?",
        TargetAction::Push | TargetAction::Fold | TargetAction::Defend => {
            "Which tile do you discard?"
        }
        TargetAction::Kan => "Call the kan, or discard?",
        TargetAction::Call => "Take the offered call, or pass?",
        TargetAction::NaniKiru | TargetAction::Best => "Choose the correct action.",
    }
}

fn top_two_gaps(evaluation: &Evaluation) -> (Option<f32>, Option<f32>) {
    let top = evaluation.evaluations.first();
    let second = evaluation.evaluations.get(1);
    let (Some(top), Some(second)) = (top, second) else {
        return (None, None);
    };
    let margin = Some(top.probability - second.probability);
    let gap = match (top.q_value, second.q_value) {
        (Some(one), Some(two)) => Some(one - two),
        _ => None,
    };
    (margin, gap)
}

pub(crate) fn mortal_block(label: &ModelLabel) -> PackMortal {
    PackMortal {
        model: label.model.clone(),
        model_sha256: label.model_sha256.clone(),
        top_action: label.top_action.clone(),
        top_probability: label.top_probability,
        margin: label.probability_margin,
        expected_value: label.expected_value,
        value_units: VALUE_UNITS.to_string(),
        ranking: label
            .ranking
            .iter()
            .map(|ranked| PackRankedAction {
                action: ranked.action.clone(),
                probability: ranked.probability,
                q_value: ranked.q_value,
            })
            .collect(),
    }
}

pub(crate) fn counterfactual_block(label: &ModelLabel) -> PackCounterfactual {
    PackCounterfactual {
        q_units: crate::miner::Q_UNITS.to_string(),
        q_values: label.q_values.clone(),
        q_gap_top2: label.q_gap_top2,
        q_gap_safe: label.q_gap_safe,
        probability_margin: Some(label.probability_margin),
        safe_action: label.safe_action.clone(),
        calibration_version: label.calibration_version.clone(),
    }
}

/// True when two model action names are the same action after red-five
/// normalisation.
#[must_use]
pub(crate) fn same_action(one: &str, other: &str) -> bool {
    normalize_mortal_action(one) == normalize_mortal_action(other)
}
