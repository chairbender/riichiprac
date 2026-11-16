//! Book classifiers: recognise a lesson in an arbitrary table state.
//!
//! The scenario modules in [`crate::generator`] are **constructors**: they build
//! a hand that satisfies a lesson's constraints. The replay miner needs the
//! inverse — given a reconstructed [`GameState`], does it satisfy a lesson, and
//! what is the answer? This module is that inverse (replay-strategy §6.4,
//! implementation units B1 and B2).
//!
//! # The contract
//!
//! Every classifier is a pure function
//!
//! ```ignore
//! fn matches(state: &GameState) -> Option<Match>;
//! ```
//!
//! that returns [`Some`] only when **exactly one action family** is correct
//! under the lesson's book rule, together with the book answer itself. The
//! rules the recognisers follow:
//!
//! - **Visible information only.** The answer is derived from the tiles, rivers,
//!   melds, dora indicators, winds and scores the player can see. Observer-side
//!   facts (a threat's hidden hand) may never be needed for the answer.
//! - **Recompute, never trust.** A recogniser ignores the state's
//!   `correct_action`, `book_rationale`, `riichi_triggers`, `dama_reasons` and
//!   derived hand metrics. It re-derives the answer from the tiles and stamps
//!   its own answer with [`Match::stamp`].
//! - **No RNG, no generator skeleton.** The same state always classifies the
//!   same way. Recognisers call the *same* analysis helpers as the generators
//!   (`judgement`, `safety`, `value`, `completion`), so the construction rule and
//!   the recognition rule cannot drift.
//! - **Fail closed.** A state that needs an input the classifier cannot read
//!   (furiten, a two-Riichi table, a rule exception the book leaves to board
//!   reading) returns `None` instead of a guess.
//!
//! # Equivalent answers
//!
//! A riichi/dama question is about the declaration, not the tile: several
//! discards can leave hands that all satisfy the same rule cell. When every
//! tenpai discard agrees, the match names the first and lists the rest in
//! `equivalent_tiles`, which the app already grades as the same answer
//! ([`crate::verdict::grade_book_with_equivalents`]). If two discards disagree
//! about the rule, the state is not that lesson's question and the classifier
//! returns `None`.
//!
//! # Where the predicates live
//!
//! The B1/B2 recognisers share one state reading ([`support`]) and one
//! transform contract, and the classifier gate runs on the **default** app
//! build (not the `miner` feature), so they live in this module rather than
//! beside each constructor. They still call each lesson's own judgement helpers
//! instead of re-implementing the book rule.
//!
//! # Two decision shapes
//!
//! B1's lessons are all closed self-turn discard decisions, and [`support::turn`]
//! is that view. B2 adds the ch. 9 reaction and kan decisions: a Pon/Chi/Kan
//! offer ([`crate::state::DecisionContext::ReactToDiscard`]) and an open or
//! concealed quad on the player's own turn. Those recognisers read the hand
//! through their own tile lists and the state's `call_offer`/`melds` instead of
//! `turn`, and [`Match::validate`] grades every
//! answer against the state's own [`crate::ai::actions::legal_actions`] list, so
//! a Kan or Pass answer is checked exactly like a discard.
//!
//! # ch. 7 sections can disagree on arbitrary states
//!
//! The chapter's structure is a general rule plus a list of exceptions, and the
//! app ships each cell as its own lesson. The **lesson generators** now build
//! disjoint cells (see each lesson's module doc): the general rule only draws
//! its riichi cells, the bad-wait box owns every bad wait, the improving board
//! makes the box agree, and the expensive board keeps a good wait. A generated
//! state therefore has one book answer.
//!
//! A replay state is arbitrary, though, and two *specific* sections can still
//! read the same visible hand differently — for example a 7700+ hand on a 3-4
//! live bad wait is the bad-wait box's riichi (ch7:521) and the expensive-hand
//! section's dama (ch7:569), and a tanki with three live tiles can be both the
//! box's riichi and the improving-hand section's dama (ch7:656). The general
//! rule defers to all of them. [`classify_all`] returns every match, so the
//! disagreement is visible rather than hidden.
//!
//! # Mortal is the tiebreaker
//!
//! When the book disagrees with itself, the label is **the lesson whose answer
//! Mortal's top action agrees with** (the model's `recommended_action` is the
//! match's `correct_action` or one of its `equivalent_tiles`):
//!
//! - [`classify_with_mortal`] does exactly that and records the decision as
//!   [`Resolution::MortalTiebreak`] with the rejected lessons. This is the
//!   miner's path whenever an evaluation exists.
//! - If no match, or more than one, agrees with the model, the disagreement
//!   stays a [`Conflict`]: the model cannot arbitrate what it does not
//!   distinguish, so the state is not shipped.
//! - [`classify_unique`] is the model-free fallback and reports a [`Conflict`]
//!   for any disagreement.
//!
//! The only other shipped overlap is ch. 8's bottom row: a `CC` board can be
//! the safety chart's `non_suji` answer and the fallback lesson's board, and
//! the two can name different tiles (see [`defense`]'s bottom-row note). It is
//! settled by the same rule. The test suite pins both families' disagreements,
//! both Mortal outcomes, and proves no other pair of recognisers disagrees.

pub mod call;
pub mod defense;
pub mod honitsu;
pub mod kan;
pub mod pinfu;
pub mod push_fold;
pub mod riichi;
pub mod suji;
pub mod wind;

pub(crate) mod support;

use crate::ai::wasm_bridge::Evaluation;
use crate::decision::ActionKind;
use crate::fuzz::{FuzzOutcome, compare_action_set};
use crate::generator::ScenarioId;
use crate::state::{
    CorrectAction, CorrectActionType, DamaReason, GameState, RiichiTrigger, ShouminkanTrigger,
    TargetAction,
};

/// What a classifier concluded about one state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Match {
    /// The book lesson whose rule decides the answer.
    pub lesson: ScenarioId,
    /// A short, answer-free description of the rule cell, e.g.
    /// `extra han, good wait, non-dealer` or `minimum value 8000 without
    /// riichi`. Miner/selection metadata; never rendered before the answer.
    pub situation: Option<String>,
    /// The decision the lesson asks about.
    pub target_action: TargetAction,
    /// The book's answer, recomputed from the table.
    pub correct_action: CorrectAction,
    /// Discards that grade as the same answer (`GameState::equivalent_tiles`).
    pub equivalent_tiles: Vec<String>,
    /// The ch. 7 riichi triggers the rationale is built from.
    pub riichi_triggers: Vec<RiichiTrigger>,
    /// The ch. 7 dama reasons the rationale is built from.
    pub dama_reasons: Vec<DamaReason>,
    /// The ch. 9 Added Kan triggers the rationale is built from.
    pub shouminkan_triggers: Vec<ShouminkanTrigger>,
    /// Pre-answer copy the lesson needs on screen (answer-free facts only).
    pub scenario_note: Option<String>,
}

impl Match {
    /// Every tile the answer accepts, sorted: the named discard plus its
    /// equivalents.
    pub fn answer_set(&self) -> Vec<String> {
        let mut tiles: Vec<String> = self
            .correct_action
            .tile()
            .map(str::to_string)
            .into_iter()
            .chain(self.equivalent_tiles.iter().cloned())
            .collect();
        tiles.sort();
        tiles.dedup();
        tiles
    }

    /// Re-check the answer against the state it came from.
    ///
    /// The answer must be one the state's own legal-action list offers: a
    /// discard (or the discard under a Riichi/dama/fold answer) has to be a
    /// legal hand discard, a Kan has to be one of the offered kans, and a Pass
    /// has to be a legal reaction. That covers the closed self-turn lessons and
    /// the ch. 9 reaction/kan lessons with one rule, and it never depends on the
    /// lesson's own fields. Equivalents must be legal discards too. This is the
    /// invariant every classifier must keep: a match is a legal, clickable
    /// answer on the state that produced it.
    pub fn validate(&self, state: &GameState) -> Result<(), MatchError> {
        let legal = crate::ai::actions::legal_actions(state);
        let discard_is_legal = |tile: &str| {
            legal
                .iter()
                .any(|info| info.kind == ActionKind::Discard && info.tile.as_deref() == Some(tile))
        };

        match &self.correct_action {
            CorrectAction::Riichi { discard } => {
                if !legal.iter().any(|info| info.kind == ActionKind::Riichi) {
                    return Err(MatchError::RiichiNotLegal);
                }
                if !discard_is_legal(discard) {
                    return Err(MatchError::AnswerNotInHand(discard.clone()));
                }
            }
            CorrectAction::Dama { discard }
            | CorrectAction::Fold { discard }
            | CorrectAction::Discard { tile: discard } => {
                if !discard_is_legal(discard) {
                    return Err(MatchError::AnswerNotInHand(discard.clone()));
                }
            }
            CorrectAction::Kan { tile } => {
                if !legal
                    .iter()
                    .any(|info| info.kind == ActionKind::Kan && info.tile.as_deref() == Some(tile))
                {
                    return Err(MatchError::KanNotLegal(tile.clone()));
                }
            }
            CorrectAction::Pass => {
                if !legal.iter().any(|info| info.kind == ActionKind::Pass) {
                    return Err(MatchError::PassNotLegal);
                }
            }
            other => return Err(MatchError::UnsupportedAnswer(other.action_type())),
        }

        for equivalent in &self.equivalent_tiles {
            if !discard_is_legal(equivalent) {
                return Err(MatchError::EquivalentNotInHand(equivalent.clone()));
            }
        }
        if let Some(tile) = self.correct_action.tile()
            && self.equivalent_tiles.iter().any(|other| other == tile)
        {
            return Err(MatchError::AnswerRepeatsEquivalent);
        }
        if let Some(situation) = &self.situation
            && self
                .correct_action
                .tile()
                .is_some_and(|tile| situation.contains(tile))
        {
            return Err(MatchError::Spoiler(situation.clone()));
        }
        Ok(())
    }

    /// Stamp this match onto a state and finalise it.
    ///
    /// The lesson's answer vocabulary and trigger/reason lists are replaced, so
    /// a mined state never carries the generator's constructor facts or another
    /// lesson's rationale. The decision context and the offered call are left
    /// as the state supplied them: a ch. 9 call/Kan lesson's offer is part of
    /// its question, not part of its answer. Derived hand metrics (`tiles`,
    /// `shanten`, `ukeire`) are left as the caller supplied them: the replay
    /// walker computes them when it reconstructs the snapshot.
    pub fn stamp(self, mut state: GameState) -> GameState {
        state.category = self.lesson.as_str().to_string();
        state.target_action = self.target_action;
        state.correct_action = self.correct_action;
        state.equivalent_tiles = self.equivalent_tiles;
        state.riichi_triggers = self.riichi_triggers;
        state.dama_reasons = self.dama_reasons;
        state.shouminkan_triggers = self.shouminkan_triggers;
        state.ai_decision = None;
        state.scenario_note = self.scenario_note;
        crate::generator::finalize_state(state)
    }

    /// True when both matches grade the same answer.
    ///
    /// The decision's *framing* is not part of the answer: the ch. 8 defense
    /// lessons carry [`TargetAction::Defend`] while the push/fold lesson's fold
    /// cell carries [`TargetAction::Fold`] for the same "discard the safe tile"
    /// decision, so the two fold carriers compare equal.
    pub fn same_answer(&self, other: &Self) -> bool {
        fold_carrier(self.target_action) == fold_carrier(other.target_action)
            && self.correct_action.action_type() == other.correct_action.action_type()
            && self.answer_set() == other.answer_set()
    }
}

/// The fold carriers of two lessons compare equal; every other target action is
/// its own.
fn fold_carrier(target: TargetAction) -> Option<TargetAction> {
    match target {
        TargetAction::Fold | TargetAction::Defend => None,
        other => Some(other),
    }
}

/// Which transforms a lesson's label survives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Allowed {
    /// The label is not preserved; the variant must be rejected.
    Deny,
    /// The label may be recomputed on the transformed state and kept only when
    /// the classifier still returns the same lesson and an inverse-mapped
    /// answer (implementation-plan §4.4).
    AllowWithRecompute,
}

/// A lesson's declared invariance under the transform catalogue.
///
/// The default is [`TransformPolicy::DENY`] for every transform
/// (implementation-plan §4.5): a missing opt-in loses volume, a wrong opt-in
/// ships a broken drill.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TransformPolicy {
    pub seat_perm: Allowed,
    pub suit_perm: Allowed,
    pub rank_mirror: Allowed,
    pub wind_relabel: Allowed,
    pub red5_normalize: Allowed,
    /// Why the lesson opts in or out of each transform.
    pub note: &'static str,
}

impl TransformPolicy {
    /// Every transform denied: the contract's default.
    pub const DENY: Self = Self {
        seat_perm: Allowed::Deny,
        suit_perm: Allowed::Deny,
        rank_mirror: Allowed::Deny,
        wind_relabel: Allowed::Deny,
        red5_normalize: Allowed::Deny,
        note: "no transform declared",
    };

    /// True when the lesson opts into at least one transform.
    pub fn allows_any(self) -> bool {
        [
            self.seat_perm,
            self.suit_perm,
            self.rank_mirror,
            self.wind_relabel,
            self.red5_normalize,
        ]
        .contains(&Allowed::AllowWithRecompute)
    }
}

/// One registered lesson recogniser.
pub struct LessonClassifier {
    pub lesson: ScenarioId,
    pub policy: TransformPolicy,
    pub matches: fn(&GameState) -> Option<Match>,
}

/// Every B1 classifier, in [`classify_unique`]'s precedence order.
///
/// Specific lessons come before the general ones: a suji/no-chance ranking
/// drill is also a "safest discard" board, and the slower-hand betaori lesson is
/// also a defense board, so the narrower rule is listed first.
pub const CLASSIFIERS: &[LessonClassifier] = &[
    // ch. 7/ch. 8 suji-trap family. It refines the bad-wait box's dama cell,
    // which defers to it, so it comes first.
    LessonClassifier {
        lesson: ScenarioId::SujiTrapRiichi,
        policy: suji::POLICY,
        matches: suji::suji_trap_riichi,
    },
    // ch. 7 riichi/dama family.
    LessonClassifier {
        lesson: ScenarioId::DamaBadWait,
        policy: riichi::DAMA_POLICY,
        matches: riichi::dama_bad_wait,
    },
    LessonClassifier {
        lesson: ScenarioId::DamaGenbutsuWait,
        policy: riichi::DAMA_POLICY,
        matches: riichi::dama_genbutsu_wait,
    },
    LessonClassifier {
        lesson: ScenarioId::DamaExpensiveHand,
        policy: riichi::DAMA_POLICY,
        matches: riichi::dama_expensive_hand,
    },
    LessonClassifier {
        lesson: ScenarioId::DamaImprovingHand,
        policy: riichi::DAMA_POLICY,
        matches: riichi::dama_improving_hand,
    },
    LessonClassifier {
        lesson: ScenarioId::RiichiJudgement,
        policy: riichi::DAMA_POLICY,
        matches: riichi::riichi_judgement,
    },
    // ch. 8 push/fold and defense family.
    LessonClassifier {
        lesson: ScenarioId::PushOrFold,
        policy: push_fold::POLICY,
        matches: push_fold::push_or_fold,
    },
    LessonClassifier {
        lesson: ScenarioId::FoldToRiichi,
        policy: defense::POLICY,
        matches: defense::fold_to_riichi,
    },
    LessonClassifier {
        lesson: ScenarioId::SujiKabeSafety,
        policy: defense::POLICY,
        matches: defense::suji_kabe_safety,
    },
    LessonClassifier {
        lesson: ScenarioId::KabeNoChance,
        policy: defense::POLICY,
        matches: defense::kabe_no_chance,
    },
    LessonClassifier {
        lesson: ScenarioId::KabeOneChance,
        policy: defense::POLICY,
        matches: defense::kabe_one_chance,
    },
    LessonClassifier {
        lesson: ScenarioId::KabeDoubleOneChance,
        policy: defense::POLICY,
        matches: defense::kabe_double_one_chance,
    },
    LessonClassifier {
        lesson: ScenarioId::KabeSujiDefense,
        policy: defense::POLICY,
        matches: defense::kabe_suji_defense,
    },
    LessonClassifier {
        lesson: ScenarioId::DefenseStuckHeuristic,
        policy: defense::POLICY,
        matches: defense::defense_stuck_heuristic,
    },
    LessonClassifier {
        lesson: ScenarioId::DefenseSafetyChart,
        policy: defense::POLICY,
        matches: defense::defense_safety_chart,
    },
    // ch. 5 shape/value family.
    LessonClassifier {
        lesson: ScenarioId::PinfuHead,
        policy: pinfu::POLICY,
        matches: pinfu::pinfu_head,
    },
    LessonClassifier {
        lesson: ScenarioId::HonitsuDecision,
        policy: honitsu::POLICY,
        matches: honitsu::honitsu_decision,
    },
    // ch. 9 call, kan and seating family.
    LessonClassifier {
        lesson: ScenarioId::MeldOrNot,
        policy: call::MELD_POLICY,
        matches: call::meld_or_not,
    },
    LessonClassifier {
        lesson: ScenarioId::DaiminkanDecision,
        policy: call::DAIMINKAN_POLICY,
        matches: call::daiminkan_decision,
    },
    LessonClassifier {
        lesson: ScenarioId::AnkanDecision,
        policy: kan::POLICY,
        matches: kan::ankan_decision,
    },
    LessonClassifier {
        lesson: ScenarioId::ShouminkanDecision,
        policy: kan::POLICY,
        matches: kan::shouminkan_decision,
    },
    LessonClassifier {
        lesson: ScenarioId::WindDiscardOrder,
        policy: wind::POLICY,
        matches: wind::wind_discard_order,
    },
];

/// The registered classifier for `lesson`, if it has one.
pub fn classifier(lesson: ScenarioId) -> Option<&'static LessonClassifier> {
    CLASSIFIERS.iter().find(|entry| entry.lesson == lesson)
}

/// Run one lesson's recogniser.
pub fn classify(state: &GameState, lesson: ScenarioId) -> Option<Match> {
    (classifier(lesson)?.matches)(state)
}

/// Run every registered recogniser, in precedence order.
///
/// More than one lesson can match the same state (see the module docs on the
/// known ch. 7 disagreement, and on a defense board that is also a
/// fastest-tile ranking drill). Callers that need a single label must use
/// [`classify_with_mortal`] (preferred) or [`classify_unique`].
pub fn classify_all(state: &GameState) -> Vec<Match> {
    CLASSIFIERS
        .iter()
        .filter_map(|entry| (entry.matches)(state))
        .collect()
}

/// Two matches that disagree about the answer for the same state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Conflict {
    pub matches: Vec<Match>,
}

impl Conflict {
    /// The conflicting lessons, in precedence order.
    pub fn lessons(&self) -> Vec<ScenarioId> {
        self.matches.iter().map(|matched| matched.lesson).collect()
    }
}

impl std::fmt::Display for Conflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let lessons: Vec<&str> = self
            .matches
            .iter()
            .map(|matched| matched.lesson.as_str())
            .collect();
        write!(f, "conflicting book matches: {}", lessons.join(", "))
    }
}

/// How a label was settled when more than one book rule matched.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolution {
    /// Only one lesson matched.
    Single,
    /// Several lessons matched and all grade the same answer; the label is the
    /// first in registry order.
    Agreement,
    /// Several lessons disagreed and Mortal's top action agreed with exactly
    /// one of them, which became the label.
    MortalTiebreak {
        /// The lessons Mortal did not agree with, in precedence order.
        rejected: Vec<ScenarioId>,
    },
}

/// A settled label plus how it was settled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Label {
    pub matched: Match,
    pub resolution: Resolution,
}

/// True when Mortal's top action is this match's book answer.
///
/// "Agreeing" uses the app's own comparison rule
/// ([`crate::fuzz::compare_action_set`]): the model's recommendation must be
/// the match's `correct_action` or one of its `equivalent_tiles`, with a Riichi
/// answer also matching the evaluator's second-pass discard. The evaluation must
/// have been produced from this same state.
pub fn mortal_agrees(state: &GameState, matched: &Match, evaluation: &Evaluation) -> bool {
    let legal = crate::ai::actions::legal_action_mask(state);
    compare_action_set(
        &matched.correct_action,
        &matched.equivalent_tiles,
        evaluation,
        &legal,
    )
    .outcome
        == FuzzOutcome::Agrees
}

/// The single label for a state, or a [`Conflict`] when the book rules disagree.
///
/// - No classifier matches: `Ok(None)`.
/// - One classifier matches: `Ok(Some(match))`.
/// - Several match the same answer: `Ok(Some(first))` (the attribution is
///   ambiguous, the answer is not).
/// - Several match different answers: `Err(Conflict)` — fail closed; the miner
///   must not pick one.
///
/// The miner should prefer [`classify_with_mortal`], which settles exactly that
/// last case with the model's top action (see the module docs). This function is
/// the model-free fallback for when no evaluation is available.
pub fn classify_unique(state: &GameState) -> Result<Option<Match>, Conflict> {
    let mut matches = classify_all(state);
    match matches.len() {
        0 => Ok(None),
        1 => Ok(matches.pop()),
        _ => {
            let first = &matches[0];
            if matches[1..].iter().all(|other| first.same_answer(other)) {
                Ok(Some(matches.remove(0)))
            } else {
                Err(Conflict { matches })
            }
        }
    }
}

/// The single label for a state, using Mortal as the tiebreaker.
///
/// This is [`classify_unique`] plus the selection rule the miner uses when the
/// book disagrees with itself: if the matching lessons grade different answers,
/// the label is the lesson whose answer Mortal's top action agrees with
/// ([`mortal_agrees`]). If no match, or more than one, agrees with the model,
/// the disagreement stays a [`Conflict`] — the model cannot arbitrate what it
/// does not distinguish.
///
/// `evaluation` must be the model's evaluation of `state` itself; the legal
/// mask is taken from `state` and the comparison uses the app's grading rule
/// (including `equivalent_tiles` and the Riichi second-pass discard).
pub fn classify_with_mortal(
    state: &GameState,
    evaluation: &Evaluation,
) -> Result<Option<Label>, Conflict> {
    let mut matches = classify_all(state);
    match matches.len() {
        0 => Ok(None),
        1 => Ok(Some(Label {
            matched: matches.remove(0),
            resolution: Resolution::Single,
        })),
        _ => {
            if matches[1..]
                .iter()
                .all(|other| matches[0].same_answer(other))
            {
                return Ok(Some(Label {
                    matched: matches.remove(0),
                    resolution: Resolution::Agreement,
                }));
            }

            let agreed: Vec<usize> = matches
                .iter()
                .enumerate()
                .filter(|(_, matched)| mortal_agrees(state, matched, evaluation))
                .map(|(index, _)| index)
                .collect();
            match agreed.as_slice() {
                [only] => {
                    let rejected = matches
                        .iter()
                        .enumerate()
                        .filter(|(index, _)| index != only)
                        .map(|(_, matched)| matched.lesson)
                        .collect();
                    Ok(Some(Label {
                        matched: matches.swap_remove(*only),
                        resolution: Resolution::MortalTiebreak { rejected },
                    }))
                }
                _ => Err(Conflict { matches }),
            }
        }
    }
}

/// The declared transform policy for a lesson, if it is registered.
pub fn transform_policy(lesson: ScenarioId) -> Option<TransformPolicy> {
    classifier(lesson).map(|entry| entry.policy)
}

/// Every lesson this module can recognise.
pub fn registered_lessons() -> impl Iterator<Item = ScenarioId> {
    CLASSIFIERS.iter().map(|entry| entry.lesson)
}

/// Why a match is not a legal answer on its state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MatchError {
    /// The state is not a closed self-turn discard decision.
    NotASelfTurn,
    /// The answer has no tile to click.
    NoAnswerTile,
    /// The named tile is not a legal hand discard.
    AnswerNotInHand(String),
    /// An equivalent tile is not a legal hand discard.
    EquivalentNotInHand(String),
    /// The named tile is listed as its own equivalent.
    AnswerRepeatsEquivalent,
    /// A Riichi answer the table's rules do not allow.
    RiichiNotLegal,
    /// The named kan is not one of the state's legal kans.
    KanNotLegal(String),
    /// A Pass answer on a state that offers no pass.
    PassNotLegal,
    /// A classifier returned an answer vocabulary it does not own.
    UnsupportedAnswer(CorrectActionType),
    /// The situation label names the answer.
    Spoiler(String),
}

impl std::fmt::Display for MatchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotASelfTurn => f.write_str("state is not a closed self-turn discard decision"),
            Self::NoAnswerTile => f.write_str("the answer names no tile"),
            Self::AnswerNotInHand(tile) => write!(f, "answer {tile} is not a legal discard"),
            Self::EquivalentNotInHand(tile) => {
                write!(f, "equivalent {tile} is not a legal discard")
            }
            Self::AnswerRepeatsEquivalent => f.write_str("the answer is its own equivalent"),
            Self::RiichiNotLegal => f.write_str("Riichi is not legal on this table"),
            Self::KanNotLegal(tile) => write!(f, "kan {tile} is not a legal kan on this table"),
            Self::PassNotLegal => f.write_str("passing is not a legal action on this table"),
            Self::UnsupportedAnswer(kind) => write!(f, "unsupported answer family {kind:?}"),
            Self::Spoiler(label) => write!(f, "the situation label names the answer: {label}"),
        }
    }
}

impl std::error::Error for MatchError {}

#[cfg(test)]
mod tests;
