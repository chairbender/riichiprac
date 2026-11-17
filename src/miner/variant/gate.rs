//! The label-preservation gate (`replay-implementation-plan.md` §4.4).
//!
//! For one base scenario and one transform chain, the gate:
//!
//! 1. applies the chain (V1) and fails closed on a state the chain makes
//!    impossible;
//! 2. recomputes the derived fields through `finalize_state`;
//! 3. runs `validate_reachable_state` and the visible-tile ledger;
//! 4. re-runs the label for the base's kind and requires the **inverse-mapped**
//!    answer to be the base's answer:
//!    - **book**: the same lesson, a unique answer, and the same answer set;
//!    - **contested**: the book half *and* the model's top-1;
//!    - **mortal**: the same top-1, and the same percentile band when the base
//!      label has a measured top-two gap;
//!    - **mistake**: the book half *and* the recorded mistake still a mistake
//!      after the forward mapping;
//! 5. stamps the re-derived answer onto the transformed state, then re-checks
//!    reachability and that the answer is legal.
//!
//! A failure is a [`Reject`] with a stable code; the stage counts it and never
//! hand-edits a label to make a variant fit. Spoilers and dedupe are the stage's
//! checks (they need the assembled scenario and the pack's other states), and
//! caps are stage policy — but they are all part of the §4.7 gate.

use crate::ai::finalize::{action_info, correct_action_from_info, normalize_mortal_action};
use crate::classifier::{self, Match};
use crate::generator::ScenarioId;
use crate::generator::support::state_validation::validate_reachable_state;
use crate::miner::label::cache::LabelCache;
use crate::miner::label::{LabelDisposition, ModelLabel, label_state};
use crate::miner::pack::{LabelCheck, LabelCheckKind, accepted_for, is_tile_code};
use crate::miner::select::gate::check_answer_legal;
use crate::miner::transform::{InverseChain, TileLedger, TransformChain};
use crate::state::{CorrectAction, GameState, TargetAction};

use super::TransformFamily;
use super::VariantLabelKind;
use super::base::{BaseScenario, same_action};
use super::plan::families_of;

/// A stable rejection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reject {
    /// Stable code for the report and for scripts.
    pub code: &'static str,
    /// Human-readable detail. Never shown to a player.
    pub detail: String,
}

impl Reject {
    /// Build a rejection.
    #[must_use]
    pub fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }
}

impl std::fmt::Display for Reject {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.detail)
    }
}

/// Which cache path produced a label, for the report counters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LabelUse {
    /// No model label was needed (a model-free book check).
    None,
    /// Served by the L1 cache.
    Cached,
    /// A first evaluation.
    Evaluated,
    /// A previously failed evaluation that succeeded.
    Retried,
}

/// A model labeler the gate can call, with the L1 cache.
pub struct VariantLabeler<'a> {
    /// The checkpoint (or a test evaluator) that scores a state.
    pub evaluator: &'a dyn crate::miner::label::StateEvaluator,
    /// The cache shared with L1; the key is the transformed state's hash.
    pub cache: &'a LabelCache<'a>,
    /// Label options (`q_values`, `safe_gap`), part of the cache key.
    pub options: crate::miner::label::LabelOptions,
}

impl VariantLabeler<'_> {
    /// Label a transformed state through the cache.
    fn label(
        &self,
        state: &GameState,
        classifier_version: &str,
    ) -> Result<(ModelLabel, LabelUse), Reject> {
        // The base's furiten flag is invariant under every catalogue transform
        // (the actor's river and waits are relabelled together), so a base that
        // the walker admitted cannot become furiten by relabelling.
        let disposition = label_state(
            self.cache,
            self.evaluator,
            state,
            false,
            &self.options,
            classifier_version,
            None,
        )
        .map_err(|err| Reject::new("labeler_error", err.to_string()))?;
        let use_ = match &disposition {
            LabelDisposition::Cached(_) => LabelUse::Cached,
            LabelDisposition::Labelled(_) => LabelUse::Evaluated,
            LabelDisposition::Retried(_) => LabelUse::Retried,
        };
        Ok((disposition.into_label(), use_))
    }
}

/// Everything the gate needs beyond the base and the chain.
pub struct GateDeps<'a> {
    /// The model labeler, when a checkpoint was supplied.
    pub labeler: Option<&'a VariantLabeler<'a>>,
    /// Per-family percentile cuts for the Mortal margin-band check.
    pub cuts: &'a crate::miner::label::thresholds::PercentileCuts,
    /// Classifier generation recorded on every label.
    pub classifier_version: &'a str,
}

/// A variant that passed the gate: the stamped state plus its label check.
#[derive(Debug, Clone, PartialEq)]
pub struct GatedState {
    /// The transformed, re-stamped, reachable state.
    pub state: GameState,
    /// Every tile the answer accepts (the answer plus equivalents).
    pub accepted: Vec<String>,
    /// The pack provenance record that admits this variant.
    pub label_check: LabelCheck,
    /// The model label the gate produced, when it ran one.
    pub model: Option<ModelLabel>,
    /// Which cache path produced [`Self::model`].
    pub label_use: LabelUse,
}

/// Run the gate for one base and one chain.
pub fn check(
    base: &BaseScenario,
    chain: &TransformChain,
    deps: &GateDeps<'_>,
) -> Result<GatedState, Reject> {
    // 1. Apply the chain. V1 fails closed on an impossible table.
    let applied = chain.apply(&base.scenario.state).map_err(|err| {
        Reject::new(
            "transform_rejected",
            format!("the chain cannot apply to this state: {err}"),
        )
    })?;
    if applied.state == base.scenario.state {
        return Err(Reject::new(
            "transform_noop",
            "the chain leaves the state unchanged (for example a red-five normalisation on a \
             hand with no red five)",
        ));
    }
    let inverse = applied.inverse();

    // 2. Recompute the derived fields, as §4.4 step 2 requires. The hand
    //    metrics are invariant under the kind bijections and are relabelled by
    //    the engine; `finalize_state` refreshes the rationale and `can_riichi`.
    let state = crate::generator::finalize_state(applied.state);

    // 3. Reachability and the visible-tile ledger.
    validate_reachable_state(&state)
        .map_err(|message| Reject::new("state_unreachable", message))?;
    let ledger =
        TileLedger::of(&state).map_err(|err| Reject::new("tile_ledger", err.to_string()))?;
    debug_assert!(ledger.total() > 0, "a reachable table has visible tiles");

    // 4. The label-preservation gate.
    let mut stamped = state;
    let (model, label_use, check_kind) = match base.label.kind {
        VariantLabelKind::Book | VariantLabelKind::Contested => {
            let (matched, model, label_use) = check_book(base, &stamped, deps, &inverse)?;
            stamped = matched.stamp(stamped);
            (model, label_use, LabelCheckKind::Book)
        }
        VariantLabelKind::Mortal => {
            let (answer, model, label_use) = check_mortal(base, &stamped, deps, &inverse)?;
            stamped.category = "mortal_best".to_string();
            stamped.target_action = TargetAction::Best;
            stamped.correct_action = answer;
            stamped.equivalent_tiles.clear();
            stamped.ai_decision = None;
            stamped = crate::generator::finalize_state(stamped);
            (Some(model), label_use, LabelCheckKind::Mortal)
        }
        VariantLabelKind::Mistake => {
            let (matched, model, label_use) = check_book(base, &stamped, deps, &inverse)?;
            check_mistake(base, chain, &matched)?;
            stamped = matched.stamp(stamped);
            (model, label_use, LabelCheckKind::Mistake)
        }
    };

    // The stamped answer is the re-derived one; make sure stamping did not make
    // the table impossible and that the answer is clickable.
    validate_reachable_state(&stamped)
        .map_err(|message| Reject::new("state_unreachable", message))?;
    let accepted = accepted_for(&stamped);
    if accepted.is_empty() {
        return Err(Reject::new(
            "answer_missing",
            "the re-derived answer names no tile or action",
        ));
    }
    check_answer_legal(&stamped, &stamped.correct_action, &accepted)
        .map_err(|(code, detail)| Reject::new("answer_illegal", format!("{code}: {detail}")))?;

    let families: Vec<String> = families_of(chain)
        .into_iter()
        .map(|family: TransformFamily| family.to_string())
        .collect();
    let detail = format!(
        "{} label preserved under {}; classifier {}",
        base.label.kind.as_str(),
        if families.is_empty() {
            "no transform".to_string()
        } else {
            families.join("+")
        },
        deps.classifier_version
    );

    Ok(GatedState {
        state: stamped,
        accepted,
        label_check: LabelCheck {
            kind: check_kind,
            preserved: true,
            detail: Some(detail),
        },
        model,
        label_use,
    })
}

/// The book half: the same lesson, a unique answer, and the same answer set.
fn check_book(
    base: &BaseScenario,
    state: &GameState,
    deps: &GateDeps<'_>,
    inverse: &InverseChain,
) -> Result<(Match, Option<ModelLabel>, LabelUse), Reject> {
    let lesson = base
        .label
        .lesson
        .as_deref()
        .expect("a book/contested/mistake base was validated with a lesson");
    let scenario_id = ScenarioId::from_id(lesson)
        .ok_or_else(|| Reject::new("unknown_lesson", format!("`{lesson}` is not registered")))?;

    let (model, label_use) = match deps.labeler {
        Some(labeler) => {
            let (label, label_use) = labeler.label(state, deps.classifier_version)?;
            if let Some(conflict) = &label.book_conflict {
                return Err(Reject::new(
                    "label_conflict",
                    format!(
                        "the book rules still disagree after the transform: {}",
                        conflict.lessons.join(", ")
                    ),
                ));
            }
            let book = label.book.as_ref().ok_or_else(|| {
                Reject::new(
                    "lesson_missing",
                    format!("no classifier recognises the transformed state as `{lesson}`"),
                )
            })?;
            if book.lesson != lesson {
                return Err(Reject::new(
                    "lesson_changed",
                    format!("the transformed state is `{}`, not `{lesson}`", book.lesson),
                ));
            }
            (Some(label), label_use)
        }
        None => (None, LabelUse::None),
    };

    // Re-run the base lesson's own recogniser for the full match (the trigger
    // and rationale lists the stamp needs), then require that every other
    // matching lesson agrees with its answer.
    let matched = classifier::classify(state, scenario_id).ok_or_else(|| {
        Reject::new(
            "lesson_missing",
            format!("`{lesson}` no longer recognises the transformed state"),
        )
    })?;
    if let Some(other) = classifier::classify_all(state)
        .into_iter()
        .find(|other| other.lesson != scenario_id && !other.same_answer(&matched))
    {
        return Err(Reject::new(
            "label_conflict",
            format!(
                "`{lesson}` and `{}` disagree on the transformed state",
                other.lesson.as_str()
            ),
        ));
    }

    verify_answer(
        base,
        &matched.correct_action,
        &match_answer_set(&matched),
        inverse,
    )?;

    if base.label.kind == VariantLabelKind::Contested {
        let label = model.as_ref().ok_or_else(|| {
            Reject::new(
                "labeler_required",
                "a contested base needs the model to verify its Mortal half",
            )
        })?;
        verify_top1(base, &label.top_action, inverse)?;
    }

    Ok((matched, model, label_use))
}

/// The Mortal half: the same top-1, and the same measured band.
fn check_mortal(
    base: &BaseScenario,
    state: &GameState,
    deps: &GateDeps<'_>,
    inverse: &InverseChain,
) -> Result<(CorrectAction, ModelLabel, LabelUse), Reject> {
    let labeler = deps.labeler.ok_or_else(|| {
        Reject::new(
            "labeler_required",
            "a Mortal-only base needs a checkpoint to re-run its label",
        )
    })?;
    let (label, label_use) = labeler.label(state, deps.classifier_version)?;
    verify_top1(base, &label.top_action, inverse)?;
    verify_band(base, &label, deps.cuts)?;

    let info = action_info(state, &label.top_action)
        .or_else(|| {
            let wanted = normalize_mortal_action(&label.top_action);
            crate::ai::actions::legal_actions(state)
                .into_iter()
                .find(|info| normalize_mortal_action(&info.action) == wanted)
        })
        .ok_or_else(|| {
            Reject::new(
                "top_action_not_legal",
                format!(
                    "the transformed state has no legal action `{}`",
                    label.top_action
                ),
            )
        })?;
    let answer = correct_action_from_info(&info, label.riichi_discard.as_deref());
    Ok((answer, label, label_use))
}

/// The accepted set of a book match, using the pack's own rule for non-tile
/// answers (`pass`, or a `Best` action name).
fn match_answer_set(matched: &Match) -> Vec<String> {
    let mut accepted: Vec<String> = match &matched.correct_action {
        CorrectAction::Pass => vec![crate::miner::pack::PASS_ANSWER.to_string()],
        CorrectAction::Best { action, tile, .. } => match tile {
            Some(tile) => vec![tile.clone()],
            None => vec![action.clone()],
        },
        other => other.tile().map(str::to_string).into_iter().collect(),
    };
    if matched.correct_action.tile().is_some() {
        accepted.extend(matched.equivalent_tiles.iter().cloned());
    }
    accepted.sort();
    accepted.dedup();
    accepted
}

/// The inverse-mapped answer must be the base answer and the same answer set.
pub(crate) fn verify_answer(
    base: &BaseScenario,
    answer: &CorrectAction,
    accepted: &[String],
    inverse: &InverseChain,
) -> Result<(), Reject> {
    let mapped = inverse
        .map_correct_action(answer)
        .map_err(|err| Reject::new("answer_unmapped", err.to_string()))?;
    let expected = &base.scenario.correct_action;
    if mapped.action_type() != expected.action_type() {
        return Err(Reject::new(
            "answer_changed",
            format!(
                "the inverse-mapped answer is `{:?}`, the base answer is `{:?}`",
                mapped.action_type(),
                expected.action_type()
            ),
        ));
    }

    let base_accepted = &base.scenario.accepted;
    match mapped.tile() {
        Some(tile) => {
            if !base_accepted.iter().any(|accepted| accepted == tile) {
                return Err(Reject::new(
                    "answer_changed",
                    format!("inverse-mapped answer `{tile}` is not in the base accepted set"),
                ));
            }
        }
        None => {
            if let CorrectAction::Best { action, .. } = &mapped
                && !base_accepted
                    .iter()
                    .any(|accepted| same_action(accepted, action))
            {
                return Err(Reject::new(
                    "answer_changed",
                    format!("inverse-mapped action `{action}` is not the base answer"),
                ));
            }
        }
    }

    // The whole accepted set: a variant that accepts a different set of tiles
    // grades a different drill, even when the named answer agrees.
    let mut mapped_set = Vec::with_capacity(accepted.len());
    for token in accepted {
        let mapped = if is_tile_code(token) {
            inverse
                .map_tile(token)
                .map_err(|err| Reject::new("answer_unmapped", err.to_string()))?
        } else if token == crate::miner::pack::PASS_ANSWER {
            token.clone()
        } else {
            inverse
                .map_action_name(token)
                .map_err(|err| Reject::new("answer_unmapped", err.to_string()))?
        };
        mapped_set.push(mapped);
    }
    mapped_set.sort();
    mapped_set.dedup();
    let mut base_set = base_accepted.clone();
    base_set.sort();
    base_set.dedup();
    if mapped_set != base_set {
        return Err(Reject::new(
            "answer_set_changed",
            format!(
                "the inverse-mapped answer set {mapped_set:?} differs from the base {base_set:?}"
            ),
        ));
    }
    Ok(())
}

/// The transformed top-1 must inverse-map to the base top-1.
fn verify_top1(
    base: &BaseScenario,
    top_action: &str,
    inverse: &InverseChain,
) -> Result<(), Reject> {
    let expected = base.label.top_action.as_deref().ok_or_else(|| {
        Reject::new(
            "base_top_action_missing",
            "the base label records no model top action to preserve",
        )
    })?;
    let mapped = inverse
        .map_action_name(top_action)
        .map_err(|err| Reject::new("top1_unmapped", err.to_string()))?;
    if !same_action(&mapped, expected) {
        return Err(Reject::new(
            "top1_changed",
            format!("the transformed top-1 inverse-maps to `{mapped}`, not `{expected}`"),
        ));
    }
    Ok(())
}

/// A Mortal-only base's measured band must not change.
///
/// The band comes from L2's percentile cuts: the base's family has a close and a
/// confident cut, and a transform that moves the position from "close call" to
/// "obvious" (or the reverse) changes the drill. When the family has too few
/// samples for a cut, there is nothing calibrated to compare and the top-1 check
/// is the whole label check.
fn verify_band(
    base: &BaseScenario,
    label: &ModelLabel,
    cuts: &crate::miner::label::thresholds::PercentileCuts,
) -> Result<(), Reject> {
    let Some(family) = base.label.decision_family.as_deref() else {
        return Ok(());
    };
    let (Some(base_gap), Some(variant_gap)) = (base.label.top2_gap(), label.top2_gap()) else {
        return Ok(());
    };
    let (Some(base_band), Some(variant_band)) =
        (cuts.band(family, base_gap), cuts.band(family, variant_gap))
    else {
        return Ok(());
    };
    if base_band != variant_band {
        return Err(Reject::new(
            "margin_band_changed",
            format!(
                "the top-two band changed from `{}` to `{}` in family `{family}`",
                base_band.as_str(),
                variant_band.as_str()
            ),
        ));
    }
    Ok(())
}

/// The recorded mistake must still be a mistake after the forward mapping.
fn check_mistake(
    base: &BaseScenario,
    chain: &TransformChain,
    matched: &Match,
) -> Result<(), Reject> {
    let played = base.label.played_action.as_deref().ok_or_else(|| {
        Reject::new(
            "played_action_missing",
            "a mistake base records no played action",
        )
    })?;
    let forward = chain
        .map_action_name(played)
        .map_err(|err| Reject::new("played_action_unmapped", err.to_string()))?;
    let answer = crate::verdict::mortal_action_for_correct(&matched.correct_action);
    if same_action(&forward, &answer) {
        return Err(Reject::new(
            "mistake_resolved",
            "the recorded mistake became the correct answer after the transform",
        ));
    }
    Ok(())
}
