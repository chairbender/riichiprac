//! Book/Mortal agreement, the `stable`/`contested` flag and label kinds (L2).
//!
//! A label has two perspectives: the book rule (a B1 classifier's recomputed
//! answer) and the model's top action. L1 already computed the comparison with
//! [`compare_action_set`], the app's grading rule; this module turns that
//! comparison into the two facts selection needs:
//!
//! - [`Stability`] — `stable` when the perspectives name one answer, `contested`
//!   when they name different answers, `unresolved` when the book disagrees with
//!   itself and the model cannot settle which rule applies.
//! - [`LabelKind`] — which answer a drill would grade (`book`, `contested`,
//!   `mortal`) or `none` for a position that must not ship.
//!
//! The distinction is the whole point of L2: a book/Mortal discrepancy is **not**
//! silently resolved in the model's favour. The book answer stays the drill's
//! answer, the model's action is recorded beside it, and the candidate is marked
//! `contested` so selection can ship it as a dual-verdict drill or leave it for
//! review (replay-strategy §5.2). The UI already has the vocabulary
//! (`book_agrees_mortal_does_not` / `mortal_agrees_book_does_not`).
//!
//! # Agreement is the app's comparison, not a string match
//!
//! [`ModelLabel::book`] is compared with the model through
//! [`crate::fuzz::compare_action_set`], which is also what
//! [`crate::generator::mortal_agreement`] uses at generation time: a Riichi
//! answer is only agreed with when the evaluator's second-pass discard matches,
//! and a discard is agreed with when it is the named tile or one of the
//! lesson's `equivalent_tiles`. A single normalised string equality would grade
//! both cases differently from the shipped app.
//!
//! # Multi-model votes are optional and are not an ensemble
//!
//! [`ModelConsensus`] records one [`ModelVote`] per evaluated checkpoint and is
//! created **only when at least two** checkpoints were evaluated. With the one
//! available `mortal_298k` checkpoint the field is absent; nothing in the
//! pipeline may describe a single model's output as an ensemble or as
//! "consensus stable" (replay-implementation-plan §5.3, replay-strategy §6.5).
//! When more than one checkpoint is ever available, disagreement between the
//! members marks the position `contested` instead of picking one silently.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::{BookLabel, ModelLabel};
use crate::ai::actions::legal_action_mask;
use crate::ai::wasm_bridge::Evaluation;
use crate::fuzz::{FuzzOutcome, compare_action_set, normalize_action_name};
use crate::miner::label::ModelIdentity;
use crate::state::GameState;

/// The `BookAgreement::outcome` spelling for agreement.
const AGREES: &str = "agrees";

/// Whether a labelled position has one answer or two.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Stability {
    /// The book and the model name the same answer (and, on a multi-model pass,
    /// every member agrees).
    Stable,
    /// The book and the model name different answers. The position is a
    /// dual-verdict drill: the book answer stays the answer and the model's
    /// action is shown beside it.
    Contested,
    /// The book rules disagree with each other and the model could not settle
    /// which rule applies. The decision is not shippable.
    Unresolved,
}

impl Stability {
    /// The JSON/DB spelling.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Contested => "contested",
            Self::Unresolved => "unresolved",
        }
    }
}

/// What kind of drill a label would produce.
///
/// The strings match the `decisions.label_kind` check constraint
/// (`book`, `mortal`, `contested`, `none`); the remaining constraint values
/// (`mistake`, `close_call`, `weak_opponent`) belong to selection (S2/S3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LabelKind {
    /// A book lesson whose answer the model agrees with.
    Book,
    /// A book lesson the model disagrees with; ship only as a dual verdict.
    Contested,
    /// No book lesson; the model's top action is the only answer.
    Mortal,
    /// No shippable label (the book conflicts and the model cannot settle it).
    #[serde(rename = "none")]
    Unlabelled,
}

impl LabelKind {
    /// The `decisions.label_kind` spelling.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Book => "book",
            Self::Contested => "contested",
            Self::Mortal => "mortal",
            Self::Unlabelled => "none",
        }
    }

    /// The `decisions.label_source` value for this kind.
    ///
    /// A book label is always `book+mortal`: the model did not set the answer,
    /// but its action was recorded and compared. A contested label carries the
    /// same two perspectives. Nothing here names a checkpoint; the identity is
    /// in `labeler_model`/`labeler_model_sha256` and in the label document.
    #[must_use]
    pub const fn source(self) -> &'static str {
        match self {
            Self::Book | Self::Contested => "book+mortal",
            Self::Mortal => "mortal",
            Self::Unlabelled => "none",
        }
    }
}

/// Whether several labelers agree on the top action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Consensus {
    /// Every evaluated checkpoint named the same normalised top action.
    Unanimous,
    /// At least one checkpoint named a different top action.
    Contested,
}

impl Consensus {
    /// The JSON spelling.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Unanimous => "unanimous",
            Self::Contested => "contested",
        }
    }
}

/// One checkpoint's vote on a position.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelVote {
    /// Model file name.
    pub model: String,
    /// SHA-256 of the checkpoint bytes.
    pub model_sha256: String,
    /// The member's top action.
    pub top_action: String,
    /// The member's top probability.
    pub top_probability: f32,
    /// `p(top) - p(second)`; `0.0` when the position offers one legal action.
    pub probability_margin: f32,
    /// Whether this member's top action is the label's book answer, when the
    /// label has one. `None` for a Mortal-only label.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agrees_with_book: Option<bool>,
}

/// How every evaluated checkpoint voted, for a label with more than one labeler.
///
/// Created only by [`ModelConsensus::from_votes`] with two or more members: a
/// single checkpoint is a label, not a consensus, and no field here is
/// populated for the default one-model pass.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelConsensus {
    /// Every member's identity and vote, in evaluation order (the primary
    /// labeler first).
    pub members: Vec<ModelVote>,
    /// The primary labeler's top action (the answer a Mortal-only drill grades).
    pub top_action: String,
    /// `unanimous` or `contested`.
    pub stability: Consensus,
    /// Vote counts keyed by the normalised action name (red-five variants
    /// collapse, matching [`normalize_action_name`]).
    pub votes: BTreeMap<String, usize>,
}

impl ModelConsensus {
    /// Build a consensus from at least two votes.
    ///
    /// Returns `None` for zero or one vote: the caller must then leave the
    /// field absent rather than describe one model as a consensus or an
    /// ensemble.
    #[must_use]
    pub fn from_votes(votes: Vec<ModelVote>) -> Option<Self> {
        let (first, rest) = votes.split_first()?;
        if rest.is_empty() {
            return None;
        }
        let mut counts: BTreeMap<String, usize> = BTreeMap::new();
        for vote in &votes {
            let key = normalize_action_name(&vote.top_action).to_string();
            *counts.entry(key).or_insert(0) += 1;
        }
        let stability = if counts.len() == 1 {
            Consensus::Unanimous
        } else {
            Consensus::Contested
        };
        Some(Self {
            top_action: first.top_action.clone(),
            members: votes,
            stability,
            votes: counts,
        })
    }

    /// True when a member named a top action the others did not.
    #[must_use]
    pub fn is_contested(&self) -> bool {
        self.stability == Consensus::Contested
    }
}

/// One checkpoint's vote, built from its evaluation of `state`.
///
/// `book` is the label's book half when it has one; the vote records whether
/// this checkpoint agrees with that answer using the app's comparison rule.
#[must_use]
pub fn vote_for(
    identity: &ModelIdentity,
    evaluation: &Evaluation,
    state: &GameState,
    book: Option<&BookLabel>,
) -> ModelVote {
    ModelVote {
        model: identity.model.clone(),
        model_sha256: identity.model_sha256.clone(),
        top_action: evaluation.recommended_action.clone(),
        top_probability: evaluation
            .evaluations
            .first()
            .map_or(0.0, |scored| scored.probability),
        probability_margin: probability_margin(evaluation),
        agrees_with_book: book.map(|book| model_agrees_with_book(state, book, evaluation)),
    }
}

/// `p(top) - p(second)` for one evaluation; `0.0` with one legal action.
#[must_use]
pub fn probability_margin(evaluation: &Evaluation) -> f32 {
    match evaluation.evaluations.as_slice() {
        [top, second, ..] => top.probability - second.probability,
        _ => 0.0,
    }
}

/// Whether one model's top action is a stored book label's answer.
///
/// This reconstructs the lesson's `equivalent_tiles` from the stored
/// `accepted` set (everything except the named tile) and runs the app's
/// comparison, so a per-member vote grades exactly like the single-model
/// agreement recorded on [`super::BookAgreement`].
#[must_use]
pub fn model_agrees_with_book(
    state: &GameState,
    book: &BookLabel,
    evaluation: &Evaluation,
) -> bool {
    let named = book.correct_action.tile();
    let equivalents: Vec<String> = book
        .accepted
        .iter()
        .filter(|tile| Some(tile.as_str()) != named)
        .cloned()
        .collect();
    let legal = legal_action_mask(state);
    compare_action_set(&book.correct_action, &equivalents, evaluation, &legal).outcome
        == FuzzOutcome::Agrees
}

/// Derive the stability of a label from its stored parts.
///
/// - a contested multi-model consensus wins (the members cannot agree);
/// - an unresolved book conflict is [`Stability::Unresolved`] and must not ship;
/// - otherwise a book label is `stable` only when the recorded comparison
///   outcome is agreement, and `contested` for any discrepancy or
///   incomparable answer;
/// - a Mortal-only label has no book perspective, so stability is `None`.
#[must_use]
pub fn derive_stability(label: &ModelLabel) -> Option<Stability> {
    if label
        .consensus
        .as_ref()
        .is_some_and(ModelConsensus::is_contested)
    {
        return Some(Stability::Contested);
    }
    if label.book_conflict.is_some() {
        return Some(Stability::Unresolved);
    }
    let book = label.book.as_ref()?;
    Some(if book.agreement.outcome == AGREES {
        Stability::Stable
    } else {
        Stability::Contested
    })
}

/// Derive the label kind from a label's stored parts.
///
/// A book conflict is unlabelled: the book has no answer to grade, and the
/// model does not get to invent one. A Mortal-only label whose members disagree
/// is `contested`, because there is no book answer to anchor it.
#[must_use]
pub fn derive_label_kind(label: &ModelLabel) -> LabelKind {
    if label.book_conflict.is_some() {
        return LabelKind::Unlabelled;
    }
    let consensus_contested = label
        .consensus
        .as_ref()
        .is_some_and(ModelConsensus::is_contested);
    match &label.book {
        Some(book) if book.agreement.outcome == AGREES && !consensus_contested => LabelKind::Book,
        Some(_) => LabelKind::Contested,
        None if consensus_contested => LabelKind::Contested,
        None => LabelKind::Mortal,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decision::ActionEvaluation;
    use crate::miner::label::BookAgreement;
    use crate::state::{CorrectAction, TargetAction};

    fn identity(name: &str, hash_char: char) -> ModelIdentity {
        ModelIdentity {
            model: name.to_string(),
            model_sha256: hash_char.to_string().repeat(64),
            gamma: None,
            pts: None,
        }
    }

    fn book_label(outcome: &str) -> BookLabel {
        BookLabel {
            lesson: "push_or_fold".to_string(),
            situation: None,
            target_action: TargetAction::Fold,
            correct_action: CorrectAction::fold("1z"),
            accepted: vec!["1z".to_string()],
            resolution: "single".to_string(),
            tiebreak_rejected: Vec::new(),
            agreement: BookAgreement {
                outcome: outcome.to_string(),
                discrepancy_kind: None,
                book_action: "Discard_1z".to_string(),
                book_probability: 0.4,
                model_action: "Discard_5m".to_string(),
                model_probability: 0.6,
            },
        }
    }

    fn label_with(
        book: Option<BookLabel>,
        conflict: bool,
        consensus: Option<ModelConsensus>,
    ) -> ModelLabel {
        ModelLabel {
            schema: crate::miner::MODEL_LABEL_SCHEMA.to_string(),
            version: crate::miner::JSON_SCHEMA_VERSION,
            classifier_version: super::super::CLASSIFIER_VERSION.to_string(),
            model: "mortal_298k.safetensors".to_string(),
            model_sha256: "a".repeat(64),
            gamma: None,
            pts: None,
            q_units: super::super::Q_UNITS.to_string(),
            value_units: super::super::VALUE_UNITS.to_string(),
            expected_value: 0.0,
            top_action: "Discard_5m".to_string(),
            top_probability: 0.6,
            probability_margin: 0.2,
            q_gap_top2: Some(0.4),
            q_gap_safe: None,
            safe_action: None,
            riichi_discard: None,
            ranking: Vec::new(),
            q_values: Default::default(),
            book,
            book_conflict: conflict.then(|| super::super::BookConflict {
                lessons: vec!["a".to_string(), "b".to_string()],
            }),
            label_kind: None,
            stability: None,
            consensus,
            calibration_version: None,
            expected_point_diffs: None,
            generator: None,
            note: super::super::Q_UNITS_NOTE.to_string(),
        }
    }

    fn evaluation(actions: &[(&str, f32)]) -> Evaluation {
        Evaluation {
            model: "mortal_298k.safetensors".to_string(),
            expected_value: 0.0,
            recommended_action: actions[0].0.to_string(),
            riichi_discard: None,
            evaluations: actions
                .iter()
                .map(|(action, probability)| {
                    ActionEvaluation::from_parts(action, "discard", None, *probability)
                })
                .collect(),
        }
    }

    #[test]
    fn an_agreeing_book_label_is_stable_and_a_book_drill() {
        let label = label_with(Some(book_label(AGREES)), false, None);
        assert_eq!(label.stability(), Some(Stability::Stable));
        assert_eq!(label.kind(), LabelKind::Book);
        assert_eq!(label.kind().source(), "book+mortal");
        assert!(label.is_shippable());
    }

    #[test]
    fn a_disagreeing_model_is_contested_and_keeps_the_book_answer() {
        let book = book_label("discrepancy");
        let answer = book.correct_action.clone();
        let label = label_with(Some(book), false, None);
        assert_eq!(label.stability(), Some(Stability::Contested));
        assert_eq!(label.kind(), LabelKind::Contested);
        assert_eq!(label.kind().source(), "book+mortal");
        assert!(
            label.is_shippable(),
            "a contested drill ships as a dual verdict"
        );
        assert_eq!(
            label
                .book
                .as_ref()
                .and_then(|book| book.correct_action.tile()),
            answer.tile(),
            "a disagreement must never replace the book answer with the model's"
        );
        assert_eq!(label.top_action, "Discard_5m");
    }

    #[test]
    fn an_unresolved_book_conflict_is_not_shippable() {
        let label = label_with(None, true, None);
        assert_eq!(label.stability(), Some(Stability::Unresolved));
        assert_eq!(label.kind(), LabelKind::Unlabelled);
        assert_eq!(label.kind().as_str(), "none");
        assert_eq!(label.kind().source(), "none");
        assert!(!label.is_shippable());
    }

    #[test]
    fn a_mortal_only_label_has_no_stability() {
        let label = label_with(None, false, None);
        assert_eq!(label.stability(), None);
        assert_eq!(label.kind(), LabelKind::Mortal);
        assert_eq!(label.kind().source(), "mortal");
        assert!(label.is_shippable());
    }

    #[test]
    fn consensus_only_exists_with_more_than_one_model() {
        let vote = ModelVote {
            model: "mortal_298k.safetensors".to_string(),
            model_sha256: "a".repeat(64),
            top_action: "Discard_1z".to_string(),
            top_probability: 0.9,
            probability_margin: 0.8,
            agrees_with_book: None,
        };
        assert!(
            ModelConsensus::from_votes(vec![vote]).is_none(),
            "one checkpoint is a label, not a consensus or an ensemble"
        );
        assert!(ModelConsensus::from_votes(Vec::new()).is_none());
    }

    #[test]
    fn two_models_that_disagree_make_the_label_contested() {
        let one = ModelVote {
            model: "a.safetensors".to_string(),
            model_sha256: "a".repeat(64),
            top_action: "Discard_1z".to_string(),
            top_probability: 0.7,
            probability_margin: 0.4,
            agrees_with_book: Some(true),
        };
        let two = ModelVote {
            model: "b.safetensors".to_string(),
            model_sha256: "b".repeat(64),
            top_action: "Discard_5m".to_string(),
            top_probability: 0.6,
            probability_margin: 0.2,
            agrees_with_book: Some(false),
        };
        let consensus =
            ModelConsensus::from_votes(vec![one.clone(), two.clone()]).expect("two votes");
        assert!(consensus.is_contested());
        assert_eq!(consensus.top_action, "Discard_1z");
        assert_eq!(consensus.votes.get("Discard_1z"), Some(&1));
        assert_eq!(consensus.votes.get("Discard_5m"), Some(&1));

        let label = label_with(Some(book_label(AGREES)), false, Some(consensus));
        assert_eq!(label.stability(), Some(Stability::Contested));
        assert_eq!(label.kind(), LabelKind::Contested);
    }

    #[test]
    fn two_models_that_agree_are_unanimous_and_red_fives_collapse() {
        let one = ModelVote {
            model: "a.safetensors".to_string(),
            model_sha256: "a".repeat(64),
            top_action: "Discard_5mr".to_string(),
            top_probability: 0.7,
            probability_margin: 0.4,
            agrees_with_book: Some(true),
        };
        let two = ModelVote {
            model: "b.safetensors".to_string(),
            model_sha256: "b".repeat(64),
            top_action: "Discard_5m".to_string(),
            top_probability: 0.6,
            probability_margin: 0.2,
            agrees_with_book: Some(true),
        };
        let consensus = ModelConsensus::from_votes(vec![one, two]).expect("two votes");
        assert_eq!(consensus.stability, Consensus::Unanimous);
        assert_eq!(consensus.votes.len(), 1);

        let label = label_with(Some(book_label(AGREES)), false, Some(consensus));
        assert_eq!(label.stability(), Some(Stability::Stable));
        assert_eq!(label.kind(), LabelKind::Book);
    }

    #[test]
    fn a_contested_consensus_on_a_mortal_only_label_is_contested() {
        let one = ModelVote {
            model: "a.safetensors".to_string(),
            model_sha256: "a".repeat(64),
            top_action: "Discard_1z".to_string(),
            top_probability: 0.7,
            probability_margin: 0.4,
            agrees_with_book: None,
        };
        let two = ModelVote {
            model: "b.safetensors".to_string(),
            model_sha256: "b".repeat(64),
            top_action: "Discard_5m".to_string(),
            top_probability: 0.6,
            probability_margin: 0.2,
            agrees_with_book: None,
        };
        let consensus = ModelConsensus::from_votes(vec![one, two]).expect("two votes");
        let label = label_with(None, false, Some(consensus));
        assert_eq!(label.stability(), Some(Stability::Contested));
        assert_eq!(label.kind(), LabelKind::Contested);
    }

    #[test]
    fn a_vote_uses_compare_action_set_for_the_book_answer() {
        let state = crate::generator::generate_puzzle("push_or_fold").expect("generated state");
        let book = BookLabel {
            lesson: "push_or_fold".to_string(),
            situation: None,
            target_action: state.target_action,
            correct_action: state.correct_action.clone(),
            accepted: {
                let mut accepted = vec![
                    state
                        .correct_action
                        .tile()
                        .expect("answer tile")
                        .to_string(),
                ];
                accepted.extend(state.equivalent_tiles.iter().cloned());
                accepted.sort();
                accepted.dedup();
                accepted
            },
            resolution: "single".to_string(),
            tiebreak_rejected: Vec::new(),
            agreement: BookAgreement {
                outcome: AGREES.to_string(),
                discrepancy_kind: None,
                book_action: crate::report::mortal_action_for_correct(&state.correct_action),
                book_probability: 1.0,
                model_action: crate::report::mortal_action_for_correct(&state.correct_action),
                model_probability: 1.0,
            },
        };
        let action = crate::report::mortal_action_for_correct(&state.correct_action);
        let agreeing = evaluation(&[(&action, 0.9), ("Discard_5m", 0.1)]);
        let vote = vote_for(
            &identity("mortal_298k.safetensors", 'a'),
            &agreeing,
            &state,
            Some(&book),
        );
        assert_eq!(
            vote.agrees_with_book,
            Some(true),
            "the book answer must count as agreement"
        );
        assert!((vote.probability_margin - 0.8).abs() < 1e-6);

        let disagreeing = evaluation(&[("Discard_5m", 0.9), ("Discard_5p", 0.1)]);
        if action != "Discard_5m" {
            let vote = vote_for(
                &identity("mortal_298k.safetensors", 'a'),
                &disagreeing,
                &state,
                Some(&book),
            );
            assert_eq!(vote.agrees_with_book, Some(false));
        }
    }
}
