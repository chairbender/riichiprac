//! Deterministic fixture evaluator for the Q1 end-to-end acceptance harness.
//!
//! Q1 must exercise the labeler, selection and review paths without a GPU, a
//! checkpoint or a network. [`FixtureEvaluator`] is that stand-in: it scores
//! every legal action with a deterministic rule and, when a book classifier
//! recognises the table, puts the classifier's own answer on top so the label
//! is `book`/`stable` and the pipeline can ship it through the same gates as a
//! real label.
//!
//! **It is not a model and never claims to be one.** Its identity is
//! `q1-fixture-evaluator` with a fixed hash, so a pack built with it records
//! that identity in `labeler_model`/`labeler_model_sha256` and a reader can
//! tell it apart from any Mortal checkpoint. Nothing outside the Q1 harness
//! should use it to grade a drill.
//!
//! # Determinism
//!
//! The score is a pure function of the state: the book answer when there is
//! one, otherwise the first legal action in the app's own action order. The
//! softmax, ranking and tie-breaks match [`crate::ai::wasm_bridge::Evaluation`]
//! shape, so the existing label path consumes it unchanged. Two runs over the
//! same fixture corpus therefore produce the same labels and the same pack
//! hash (Q1's determinism gate).
//!
//! # Not a variant oracle
//!
//! The fallback (no book match) is not equivariant under suit/rank relabeling,
//! so a Mortal-only variant cannot be label-verified by this evaluator. The Q1
//! harness takes its variant/pack branch from the seeded book rehearsal, where
//! the classifier itself re-derives the answer, and uses this evaluator only
//! for the replay corpus branch.

use crate::ai::actions::legal_actions;
use crate::ai::wasm_bridge::Evaluation;
use crate::classifier::classify_all;
use crate::decision::{ActionEvaluation, ActionInfo, ActionKind};
use crate::miner::label::{LabelError, ModelIdentity, StateEvaluator};
use crate::state::{CorrectAction, GameState};

/// Model name recorded on every fixture label.
pub const FIXTURE_EVALUATOR_NAME: &str = "q1-fixture-evaluator";

/// Fixed SHA-256 recorded as the fixture evaluator's checkpoint hash.
pub const FIXTURE_EVALUATOR_SHA256: &str =
    "5e1f6b1e5b4a0d0c7c2f2f04a0c9d1e7b3a6f8c2d4e6a8b0c1d3e5f7092a4c6e";

/// Q value given to the chosen action.
const TOP_Q: f32 = 10.0;

/// A deterministic stand-in evaluator for the fixture pipeline.
#[derive(Debug, Clone)]
pub struct FixtureEvaluator {
    identity: ModelIdentity,
}

impl Default for FixtureEvaluator {
    fn default() -> Self {
        Self::new()
    }
}

impl FixtureEvaluator {
    /// Build the evaluator with its fixed fixture identity.
    #[must_use]
    pub fn new() -> Self {
        Self {
            identity: ModelIdentity {
                model: FIXTURE_EVALUATOR_NAME.to_string(),
                model_sha256: FIXTURE_EVALUATOR_SHA256.to_string(),
                gamma: None,
                pts: None,
            },
        }
    }

    /// The action this evaluator puts on top, with the Riichi second-pass
    /// discard when the book answer declares Riichi.
    fn preferred(state: &GameState) -> Option<(ActionInfo, Option<String>)> {
        let legal = legal_actions(state);
        if legal.is_empty() {
            return None;
        }
        if let Some(matched) = classify_all(state).into_iter().next()
            && let Some(found) = preferred_for(&legal, &matched.correct_action)
        {
            return Some(found);
        }
        // No book match: the app's action list is already deterministic
        // (discards, then calls, in a fixed order). Keep the first discard,
        // falling back to the first action when the state offers no discard.
        legal
            .iter()
            .find(|info| info.kind == ActionKind::Discard)
            .or_else(|| legal.first())
            .cloned()
            .map(|info| (info, None))
    }
}

/// Map a book answer onto the state's legal action list.
fn preferred_for(
    legal: &[ActionInfo],
    answer: &CorrectAction,
) -> Option<(ActionInfo, Option<String>)> {
    match answer {
        CorrectAction::Riichi { discard } => legal
            .iter()
            .find(|info| info.kind == ActionKind::Riichi)
            .cloned()
            .map(|info| (info, Some(discard.clone()))),
        CorrectAction::Dama { discard } | CorrectAction::Fold { discard } => legal
            .iter()
            .find(|info| info.kind == ActionKind::Discard && info.tile.as_deref() == Some(discard))
            .cloned()
            .map(|info| (info, None)),
        CorrectAction::Discard { tile } => legal
            .iter()
            .find(|info| info.kind == ActionKind::Discard && info.tile.as_deref() == Some(tile))
            .cloned()
            .map(|info| (info, None)),
        CorrectAction::Kan { tile } => legal
            .iter()
            .find(|info| info.kind == ActionKind::Kan && info.tile.as_deref() == Some(tile))
            .cloned()
            .map(|info| (info, None)),
        CorrectAction::Pass => legal
            .iter()
            .find(|info| info.kind == ActionKind::Pass)
            .cloned()
            .map(|info| (info, None)),
        CorrectAction::Best { action, .. } => legal
            .iter()
            .find(|info| info.action == *action)
            .cloned()
            .map(|info| (info, None)),
    }
}

impl StateEvaluator for FixtureEvaluator {
    fn identity(&self) -> &ModelIdentity {
        &self.identity
    }

    fn evaluate(&self, state: &GameState) -> Result<Evaluation, LabelError> {
        let preferred = Self::preferred(state).map(|(info, _)| info.action.clone());
        let mut scored: Vec<ActionEvaluation> = legal_actions(state)
            .into_iter()
            .enumerate()
            .map(|(index, info)| {
                let q_value = if preferred.as_deref() == Some(info.action.as_str()) {
                    TOP_Q
                } else {
                    -(index as f32) * 0.01 - 1.0
                };
                ActionEvaluation {
                    info,
                    probability: 0.0,
                    q_value: Some(q_value),
                }
            })
            .collect();
        if scored.is_empty() {
            return Err(LabelError::Evaluation(
                "the fixture evaluator found no legal action".to_string(),
            ));
        }
        let max_q = scored
            .iter()
            .map(|scored| scored.q_value.expect("q value"))
            .fold(f32::NEG_INFINITY, f32::max);
        let total: f32 = scored
            .iter()
            .map(|scored| (scored.q_value.expect("q value") - max_q).exp())
            .sum();
        for scored in &mut scored {
            scored.probability = (scored.q_value.expect("q value") - max_q).exp() / total;
        }
        scored.sort_by(|left, right| {
            right
                .probability
                .total_cmp(&left.probability)
                .then_with(|| left.info.action.cmp(&right.info.action))
        });
        let recommended_action = scored
            .first()
            .expect("a non-empty scored set has a first entry")
            .info
            .action
            .clone();
        let riichi_discard = Self::preferred(state).and_then(|(info, discard)| {
            (info.kind == ActionKind::Riichi)
                .then_some(discard)
                .flatten()
        });
        Ok(Evaluation {
            model: self.identity.model.clone(),
            expected_value: 0.0,
            recommended_action,
            riichi_discard,
            evaluations: scored,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generator::{ScenarioId, generate_puzzle};

    #[test]
    fn a_book_state_puts_the_classifier_answer_on_top() {
        crate::rng::seed(0x5eed_2026);
        let state = generate_puzzle(ScenarioId::FoldToRiichi.as_str()).expect("fixture state");
        let evaluation = FixtureEvaluator::new()
            .evaluate(&state)
            .expect("evaluation");
        let book = classify_all(&state);
        assert!(!book.is_empty(), "the fold fixture must be recognised");
        assert_eq!(
            evaluation.recommended_action,
            crate::report::mortal_action_for_correct(&book[0].correct_action)
        );
        assert!(evaluation.evaluations[0].probability > 0.99);
        assert!(
            evaluation
                .evaluations
                .iter()
                .all(|scored| scored.q_value.is_some())
        );
    }

    #[test]
    fn the_identity_is_fixture_not_mortal() {
        let evaluator = FixtureEvaluator::new();
        assert_eq!(evaluator.identity().model, FIXTURE_EVALUATOR_NAME);
        assert_ne!(evaluator.identity().model, "mortal_298k.safetensors");
        assert_eq!(evaluator.identity().model_sha256.len(), 64);
    }

    #[test]
    fn a_state_with_no_book_match_still_labels_deterministically() {
        let state = crate::generator::generate_puzzle(ScenarioId::RyanmenProtorun.as_str())
            .expect("fixture state");
        let first = FixtureEvaluator::new()
            .evaluate(&state)
            .expect("evaluation");
        let second = FixtureEvaluator::new()
            .evaluate(&state)
            .expect("evaluation");
        assert_eq!(first.recommended_action, second.recommended_action);
        assert_eq!(first.evaluations, second.evaluations);
    }
}
