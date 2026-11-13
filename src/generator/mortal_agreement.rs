//! Opt-in Mortal-agreement rejection sampling for generated scenarios.
//!
//! Every lesson's answer is a Riichi Book 1 rule, and the shipped Mortal v4
//! policy does not always play the same move. The offline fuzz runs in
//! `scenario-fuzz-findings.md` document the disagreement classes, and a survey
//! with the shipped checkpoint puts per-candidate agreement anywhere from about
//! 9% (`ryankan_break`, whose book answer is an off-by-one tile choice on
//! nearly every hand) to 100% (the lessons Mortal always plays the same way).
//! A generated hand can therefore teach a rule the model would not follow.
//!
//! This module turns that comparison into a generation-time filter. A candidate
//! is generated normally, evaluated with the loaded model, and discarded unless
//! Mortal's **top-ranked action** is one of the scenario's accepted answers:
//! [`GameState::correct_action`] plus [`GameState::equivalent_tiles`]. The whole
//! action is compared, including the discard tile, with the same rule the fuzz
//! runner and the dual verdict use ([`crate::fuzz::compare_action_set`]), so
//! "Mortal agrees" cannot mean two different things in two places.
//!
//! ## One situation per request
//!
//! Rejection sampling must not change *what* the drill teaches. The filter
//! therefore draws the lesson's situation parameters once
//! (`crate::generator::sample_situation`) and then re-fills the hand under
//! that same situation on every rejected candidate
//! (`crate::generator::generate_reachable_candidate_for`). If a lesson has no
//! parameter concept, every candidate stays an independent full draw. Without
//! the pin, each retry would redraw the parameters (ch. 7's condition set, the
//! bad-wait cell, the value band), and the filter would keep whichever draw
//! Mortal happens to like — which biases the drill toward its most obvious
//! hands. A pinned set that cannot be built is an error naming the situation,
//! never a silent re-draw.
//!
//! The drawn set is reported in [`MortalAgreementReport::situation`], so a run
//! makes visible which condition the hand was built to isolate alongside the
//! rejection counts.
//!
//! The filter is deliberately opt-in. Generating one candidate is cheap, but
//! each candidate costs one forward pass (two when Mortal chooses Riichi,
//! because its declaration action carries no tile and the evaluator resolves
//! the discard in a second pass), so a caller chooses between `generate_puzzle`'s
//! instant book-only answer and this sampling cost.
//!
//! ```ignore
//! let puzzle = generate_with_model(
//!     "ryanmen_protorun",
//!     &model,
//!     "mortal_298k.safetensors",
//!     MortalAgreementOptions::default(),
//! )?;
//! println!("rejected {}/{} candidates",
//!     puzzle.agreement.as_ref().unwrap().rejected.total(),
//!     puzzle.agreement.as_ref().unwrap().attempts);
//! ```

use serde::{Deserialize, Serialize};

use crate::ai::model::MortalV4Model;
use crate::ai::wasm_bridge::{Evaluation, evaluate_state_named};
use crate::fuzz::{DiscrepancyKind, FuzzOutcome, compare_action_set};
use crate::state::GameState;

use super::{
    GeneratedPuzzle, Situation, finalize_state, generate_reachable_candidate,
    generate_reachable_candidate_for, sample_situation,
};

/// How many candidates one call may generate and evaluate by default.
///
/// Agreement is a property of the pair (lesson, model), and it varies widely by
/// family. A 10-hand survey against `mortal_298k.safetensors` measured roughly
/// 100% for `protorun_priority` and `defense_safety_chart`, 60-90% for most
/// discard lessons, and about **9%** for `ryankan_break` (its book answer is an
/// off-by-one tile choice on nearly every hand). Forty candidates therefore
/// still fail on `ryankan_break` with probability `0.91^40 ≈ 2%`, which is why
/// the bound is a knob rather than a constant of the sampler:
/// [`MortalAgreementOptions::max_candidates`] raises it when a caller can
/// afford more.
///
/// The cost is real: one forward pass per candidate (~41 ms per pass natively
/// for `mortal_298k`, more in WASM), and two when Mortal chooses Riichi so the
/// evaluator can resolve its discard.
pub const DEFAULT_MAX_CANDIDATES: usize = 40;

/// Why one generated candidate was discarded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgreementRejection {
    /// Mortal's top action is a different action family: a discard where the
    /// book says Riichi, Pass where it says Pon, and so on.
    Action,
    /// Mortal agrees on the family but not the tile (the discard, or the tile
    /// a Riichi is declared on).
    Tile,
    /// The scenario's answer has no legal equivalent in Mortal's action space,
    /// so agreement cannot be established.
    Incomparable,
    /// The forward pass itself failed (bad weights, a state the encoder
    /// rejects, a softmax that produced NaN).
    EvaluationFailed,
}

impl AgreementRejection {
    /// Stable snake_case name used in reports and log lines.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Action => "action_mismatch",
            Self::Tile => "tile_mismatch",
            Self::Incomparable => "incomparable",
            Self::EvaluationFailed => "evaluation_failure",
        }
    }
}

/// Rejected-candidate counts, split by reason.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgreementRejections {
    /// Candidates whose answer differed from Mortal on the action family.
    #[serde(default)]
    pub action: usize,
    /// Candidates whose answer differed from Mortal only on the tile.
    #[serde(default)]
    pub tile: usize,
    /// Candidates whose answer had no legal Mortal equivalent.
    #[serde(default)]
    pub incomparable: usize,
    /// Candidates whose evaluation failed.
    #[serde(default)]
    pub evaluation_failed: usize,
}

impl AgreementRejections {
    /// Rejections of every reason added together.
    pub fn total(&self) -> usize {
        self.action + self.tile + self.incomparable + self.evaluation_failed
    }

    fn record(&mut self, rejection: AgreementRejection) {
        match rejection {
            AgreementRejection::Action => self.action += 1,
            AgreementRejection::Tile => self.tile += 1,
            AgreementRejection::Incomparable => self.incomparable += 1,
            AgreementRejection::EvaluationFailed => self.evaluation_failed += 1,
        }
    }
}

/// What one sampling call actually did.
///
/// Serialized next to the accepted state by the WASM bridge, so a caller can
/// see how much rejection sampling it paid for and why candidates were
/// discarded.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MortalAgreementReport {
    /// Candidate bound the caller asked for.
    pub max_candidates: usize,
    /// Candidates generated, including ones the generator itself failed on and
    /// candidates whose evaluation failed.
    pub attempts: usize,
    /// Candidates that produced an evaluation. A Riichi top action runs an
    /// extra, uncounted second pass to resolve its discard.
    pub evaluations: usize,
    /// Candidates the lesson generators could not build at all (for example an
    /// unreachable river layout after their own retries).
    #[serde(default)]
    pub generation_failures: usize,
    /// The situation parameters drawn for this request, when the lesson has any.
    ///
    /// Drawn once before the first candidate; every attempt below is filled
    /// under this same set. `None` means the lesson has no parameter concept
    /// and each candidate was an independent full draw. The wording names the
    /// isolated condition, e.g. `extra han, bad wait, non-dealer`, and never the
    /// answer. The frontend shows it under a resolved scenario, after the
    /// player has answered or asked for Mortal's choice.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub situation: Option<String>,
    /// True when a candidate was accepted. `false` only appears on the error
    /// path, because a successful call always returns an accepted candidate.
    pub accepted: bool,
    /// Mortal's top action on the accepted candidate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recommended_action: Option<String>,
    /// Rejected candidates, split by reason.
    #[serde(default)]
    pub rejected: AgreementRejections,
}

/// Tunable knobs for the agreement filter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct MortalAgreementOptions {
    /// Whether the filter runs at all.
    ///
    /// This is the toggle a settings blob carries: `false` returns a plain
    /// [`crate::generator::generate_puzzle`] candidate with no report, so a host
    /// can keep one configuration and switch the filter on or off without
    /// changing the code path.
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    /// How many candidates may be generated and evaluated before giving up.
    /// Must be at least one.
    #[serde(default = "default_max_candidates")]
    pub max_candidates: usize,
}

impl Default for MortalAgreementOptions {
    fn default() -> Self {
        Self {
            enabled: true,
            max_candidates: DEFAULT_MAX_CANDIDATES,
        }
    }
}

impl MortalAgreementOptions {
    /// Enabled options with an explicit candidate bound.
    pub fn new(max_candidates: usize) -> Self {
        Self {
            enabled: true,
            max_candidates,
        }
    }

    /// The filter switched off, which yields the plain generated puzzle.
    pub fn disabled() -> Self {
        Self {
            enabled: false,
            max_candidates: DEFAULT_MAX_CANDIDATES,
        }
    }
}

fn default_enabled() -> bool {
    true
}

fn default_max_candidates() -> usize {
    DEFAULT_MAX_CANDIDATES
}

/// Whether Mortal's top action is one of the state's accepted answers.
///
/// `None` means agreement; `Some(reason)` means the candidate must be rejected.
/// The accepted set is the answer plus [`GameState::equivalent_tiles`], and the
/// comparison follows [`compare_action_set`]: a Riichi recommendation must also
/// declare on the answer's tile when the evaluator resolved one.
pub fn rejection_for(state: &GameState, evaluation: &Evaluation) -> Option<AgreementRejection> {
    let legal = crate::ai::wasm_bridge::legal_action_mask(state);
    let comparison = compare_action_set(
        &state.correct_action,
        &state.equivalent_tiles,
        evaluation,
        &legal,
    );

    match comparison.outcome {
        FuzzOutcome::Agrees => None,
        FuzzOutcome::Incomparable => Some(AgreementRejection::Incomparable),
        FuzzOutcome::Discrepancy => Some(match comparison.kind {
            Some(DiscrepancyKind::Tile) => AgreementRejection::Tile,
            _ => AgreementRejection::Action,
        }),
    }
}

/// Generate candidates until Mortal agrees, with an injected evaluator.
///
/// `evaluate` is the model call, separated out so the sampling loop can be
/// tested without candle. The production entry point is
/// [`generate_with_model`].
///
/// The lesson's situation parameters are drawn once here and then pinned for
/// every candidate in the loop, so a rejection changes the tiles but never the
/// question. See `generate_pinned`.
///
/// The `mock_table` fixture is returned as-is with no report: it is a fixed UI
/// mock, not a played-out position, so there is nothing to sample.
pub fn generate<F>(
    category: &str,
    options: MortalAgreementOptions,
    evaluate: F,
) -> Result<GeneratedPuzzle, String>
where
    F: FnMut(&GameState) -> Result<Evaluation, String>,
{
    if !options.enabled {
        // The opt-out path is exactly `generate_puzzle`: one candidate, no
        // evaluation, no report.
        let state = finalize_state(generate_reachable_candidate(category)?);
        return Ok(GeneratedPuzzle {
            state,
            agreement: None,
        });
    }

    if options.max_candidates == 0 {
        return Err(
            "Mortal-agreement sampling needs at least one candidate (max_candidates = 0)"
                .to_string(),
        );
    }

    if category == "mock_table" {
        let state = crate::fixtures::mock_table::generate(category)?;
        return Ok(GeneratedPuzzle {
            state: finalize_state(state),
            agreement: None,
        });
    }

    // The one draw that decides what this request teaches. `None` for a lesson
    // with no parameters, which keeps the old per-candidate full draw.
    let situation = sample_situation(category);
    generate_pinned(category, situation, options, evaluate)
}

/// The sampling loop proper, with the situation already drawn.
///
/// Split from [`generate`] so a test can pin a parameter set directly and see
/// how the loop reacts to it.
fn generate_pinned<F>(
    category: &str,
    situation: Option<Situation>,
    options: MortalAgreementOptions,
    mut evaluate: F,
) -> Result<GeneratedPuzzle, String>
where
    F: FnMut(&GameState) -> Result<Evaluation, String>,
{
    let mut report = MortalAgreementReport {
        max_candidates: options.max_candidates,
        situation: situation.map(Situation::label),
        ..MortalAgreementReport::default()
    };
    let mut last_error = String::new();

    for _ in 0..options.max_candidates {
        report.attempts += 1;

        // The reachability guard runs first, exactly as in `generate_puzzle`:
        // it is cheaper than an inference pass, so a malformed table is never
        // worth evaluating. A pinned situation means every retry refills under
        // the same parameters instead of drawing new ones.
        let state = match situation {
            Some(situation) => match generate_reachable_candidate_for(category, situation) {
                Ok(state) => finalize_state(state),
                Err(err) => {
                    // Re-filling is the whole point of the pin, so a fill
                    // failure says this set cannot be built here. Drawing a
                    // different set would quietly change the question (and
                    // bias the drill), so report it instead.
                    let label = report.situation.as_deref().unwrap_or_default();
                    return Err(format!(
                        "the drawn {category} situation ({label}) is unachievable: {err}"
                    ));
                }
            },
            None => match generate_reachable_candidate(category) {
                Ok(state) => finalize_state(state),
                Err(err) => {
                    report.generation_failures += 1;
                    last_error = err;
                    continue;
                }
            },
        };

        let evaluation = match evaluate(&state) {
            Ok(evaluation) => evaluation,
            Err(err) => {
                report.rejected.record(AgreementRejection::EvaluationFailed);
                last_error = err;
                continue;
            }
        };
        report.evaluations += 1;

        match rejection_for(&state, &evaluation) {
            None => {
                report.accepted = true;
                report.recommended_action = Some(evaluation.recommended_action);
                return Ok(GeneratedPuzzle {
                    state,
                    agreement: Some(report),
                });
            }
            Some(rejection) => {
                report.rejected.record(rejection);
                last_error = describe_rejection(rejection, &state, &evaluation);
            }
        }
    }

    let pinned = match report.situation.as_deref() {
        Some(label) => format!(" under the pinned situation ({label})"),
        None => String::new(),
    };
    Err(format!(
        "no {category} candidate matched Mortal after {} attempt(s){pinned} \
         ({} evaluated; {} action mismatch, {} tile mismatch, {} incomparable, \
         {} evaluation failure(s), {} generation failure(s)); last: {last_error}",
        report.attempts,
        report.evaluations,
        report.rejected.action,
        report.rejected.tile,
        report.rejected.incomparable,
        report.rejected.evaluation_failed,
        report.generation_failures,
    ))
}

/// Generate an agreeing puzzle with the loaded Mortal checkpoint.
pub fn generate_with_model(
    category: &str,
    model: &MortalV4Model,
    model_name: &str,
    options: MortalAgreementOptions,
) -> Result<GeneratedPuzzle, String> {
    generate(category, options, |state| {
        evaluate_state_named(model, state, model_name).map_err(|err| err.to_string())
    })
}

fn describe_rejection(
    rejection: AgreementRejection,
    state: &GameState,
    evaluation: &Evaluation,
) -> String {
    format!(
        "{}: Mortal picked {}, the book's answer is {}",
        rejection.as_str(),
        evaluation.recommended_action,
        crate::verdict::mortal_action_for_correct(&state.correct_action),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decision::{ActionEvaluation, ActionKind};
    use crate::generator::ScenarioId;
    use crate::state::CorrectAction;

    /// A synthetic evaluation whose top action is `action`.
    ///
    /// The comparison only reads the top action, the resolved Riichi discard,
    /// and the per-action probabilities, so a flat distribution over the real
    /// legal actions is enough.
    fn evaluation_with_top(state: &GameState, action: &str) -> Evaluation {
        let legal = crate::ai::actions::legal_actions(state);
        Evaluation {
            model: "test_model.safetensors".to_string(),
            expected_value: 0.0,
            recommended_action: action.to_string(),
            riichi_discard: None,
            evaluations: legal
                .iter()
                .map(|info| ActionEvaluation {
                    info: info.clone(),
                    probability: if info.action == action { 1.0 } else { 0.0 },
                })
                .collect(),
        }
    }

    /// The evaluation that makes the state's own answer agree.
    fn agreeing_evaluation(state: &GameState) -> Evaluation {
        let action = crate::verdict::mortal_action_for_correct(&state.correct_action);
        let mut evaluation = evaluation_with_top(state, &action);
        if action == "Riichi" {
            evaluation.riichi_discard = state.correct_action.tile().map(str::to_string);
        }
        evaluation
    }

    /// An evaluation that picks some other legal discard, so the state's answer
    /// is rejected whatever family it belongs to.
    fn disagreeing_evaluation(state: &GameState) -> Evaluation {
        let answer = state.correct_action.tile();
        let other = crate::ai::actions::legal_actions(state)
            .into_iter()
            .filter(|info| info.kind == ActionKind::Discard)
            .find_map(|info| info.tile.filter(|tile| Some(tile.as_str()) != answer))
            .expect("another discard exists");
        evaluation_with_top(state, &format!("Discard_{other}"))
    }

    fn generate_book_state(category: &str) -> GameState {
        crate::generator::generate_puzzle(category)
            .unwrap_or_else(|err| panic!("{category} must generate: {err}"))
    }

    #[test]
    fn options_default_to_the_documented_bound() {
        let default = MortalAgreementOptions::default();
        assert!(default.enabled);
        assert_eq!(default.max_candidates, DEFAULT_MAX_CANDIDATES);

        // The WASM bridge forwards `{}`, `{"max_candidates": n}` and the
        // settings toggle.
        let empty: MortalAgreementOptions =
            serde_json::from_str("{}").expect("empty options must parse");
        assert!(empty.enabled);
        assert_eq!(empty.max_candidates, DEFAULT_MAX_CANDIDATES);

        let explicit: MortalAgreementOptions =
            serde_json::from_str(r#"{"max_candidates":3}"#).expect("explicit options");
        assert!(explicit.enabled);
        assert_eq!(explicit.max_candidates, 3);

        let off: MortalAgreementOptions =
            serde_json::from_str(r#"{"enabled":false}"#).expect("toggle options");
        assert!(!off.enabled);
        assert_eq!(off.max_candidates, DEFAULT_MAX_CANDIDATES);
        assert!(!MortalAgreementOptions::disabled().enabled);
    }

    #[test]
    fn switching_the_filter_off_returns_the_plain_puzzle() {
        let puzzle = generate(
            "ryanmen_protorun",
            MortalAgreementOptions::disabled(),
            |_| unreachable!("a disabled filter must not evaluate"),
        )
        .expect("the plain generator must succeed");

        assert_eq!(puzzle.state.category, "ryanmen_protorun");
        assert!(puzzle.agreement.is_none());
        assert!(puzzle.state.book_rationale.is_some(), "still finalized");
    }

    #[test]
    fn report_counts_every_rejection_reason() {
        let mut rejected = AgreementRejections::default();
        for rejection in [
            AgreementRejection::Action,
            AgreementRejection::Tile,
            AgreementRejection::Incomparable,
            AgreementRejection::EvaluationFailed,
            AgreementRejection::Tile,
        ] {
            rejected.record(rejection);
        }

        assert_eq!(rejected.action, 1);
        assert_eq!(rejected.tile, 2);
        assert_eq!(rejected.incomparable, 1);
        assert_eq!(rejected.evaluation_failed, 1);
        assert_eq!(rejected.total(), 5);

        let json = serde_json::to_value(rejected).expect("rejections serialize");
        assert_eq!(json["action"], 1);
        assert_eq!(json["tile"], 2);
        assert_eq!(json["incomparable"], 1);
        assert_eq!(json["evaluation_failed"], 1);
    }

    #[test]
    fn matching_top_action_is_agreement() {
        let state = generate_book_state("ryanmen_protorun");

        assert_eq!(rejection_for(&state, &agreeing_evaluation(&state)), None);
    }

    #[test]
    fn a_different_discard_tile_is_a_tile_mismatch() {
        let state = generate_book_state("ryanmen_protorun");
        assert_eq!(
            state.correct_action.action_type(),
            crate::state::CorrectActionType::Dama,
            "the block-theory lesson answers with a discard"
        );

        // Pick any other legal discard as Mortal's top action.
        let answer = state.correct_action.tile().expect("answer tile");
        let other = crate::ai::actions::legal_actions(&state)
            .into_iter()
            .filter(|info| info.kind == ActionKind::Discard)
            .find_map(|info| info.tile.filter(|tile| tile != answer))
            .expect("a second discard exists");

        let rejection = rejection_for(
            &state,
            &evaluation_with_top(&state, &format!("Discard_{other}")),
        );
        assert_eq!(rejection, Some(AgreementRejection::Tile));
        assert_eq!(rejection.unwrap().as_str(), "tile_mismatch");
    }

    #[test]
    fn a_different_action_family_is_an_action_mismatch() {
        // The chiitoitsu lesson answers Riichi or dama, so the other family is
        // always legal.
        let state = generate_book_state("chiitoitsu_riichi_vs_dama");
        let other = match state.correct_action.action_type() {
            crate::state::CorrectActionType::Riichi => format!(
                "Discard_{}",
                state.correct_action.tile().expect("declaration tile")
            ),
            _ => "Riichi".to_string(),
        };

        assert_eq!(
            rejection_for(&state, &evaluation_with_top(&state, &other)),
            Some(AgreementRejection::Action)
        );
    }

    #[test]
    fn an_equivalent_tile_counts_as_agreement() {
        let state = generate_book_state("ryanmen_protorun");
        let answer = state.correct_action.tile().expect("answer tile");
        let twin = crate::ai::actions::legal_actions(&state)
            .into_iter()
            .filter(|info| info.kind == ActionKind::Discard)
            .find_map(|info| info.tile.filter(|tile| tile != answer))
            .expect("a second discard exists");

        let mut tied = state.clone();
        tied.equivalent_tiles = vec![twin.clone()];
        let evaluation = evaluation_with_top(&tied, &format!("Discard_{twin}"));

        assert_eq!(rejection_for(&tied, &evaluation), None);
        // The same evaluation against the unmodified state disagrees.
        assert_eq!(
            rejection_for(&state, &evaluation),
            Some(AgreementRejection::Tile)
        );
    }

    #[test]
    fn riichi_agreement_requires_the_resolved_discard() {
        for _ in 0..40 {
            let state = generate_book_state("chiitoitsu_riichi_vs_dama");
            let CorrectAction::Riichi { ref discard } = state.correct_action else {
                continue;
            };
            let answer = discard.clone();
            let mut evaluation = evaluation_with_top(&state, "Riichi");
            evaluation.riichi_discard = Some(answer.clone());
            assert_eq!(rejection_for(&state, &evaluation), None);

            let other = crate::ai::actions::legal_actions(&state)
                .into_iter()
                .filter(|info| info.kind == ActionKind::Discard)
                .find_map(|info| info.tile.filter(|tile| *tile != answer))
                .expect("another discard");
            evaluation.riichi_discard = Some(other);
            assert_eq!(
                rejection_for(&state, &evaluation),
                Some(AgreementRejection::Tile)
            );

            // An unresolved second pass cannot contradict the declaration.
            evaluation.riichi_discard = None;
            assert_eq!(rejection_for(&state, &evaluation), None);

            return;
        }
        panic!("no Riichi chiitoitsu lesson was generated");
    }

    #[test]
    fn an_answer_with_no_legal_mortal_equivalent_is_incomparable() {
        // A first-turn wind lesson never offers Kan, so an answer that needs it
        // has no legal equivalent in the state's action set and agreement
        // cannot be established.
        let mut state = generate_book_state("wind_discard_order");
        state.correct_action = CorrectAction::kan("1z");

        let rejection = rejection_for(&state, &evaluation_with_top(&state, "Discard_1z"));
        assert_eq!(rejection, Some(AgreementRejection::Incomparable));
        assert_eq!(rejection.unwrap().as_str(), "incomparable");
    }

    #[test]
    fn sampling_accepts_every_lesson_on_the_first_attempt() {
        for &id in ScenarioId::ALL {
            if id == ScenarioId::AiBestAction {
                continue;
            }
            let puzzle = generate(id.as_str(), MortalAgreementOptions::default(), |state| {
                Ok(agreeing_evaluation(state))
            })
            .unwrap_or_else(|err| panic!("{} must accept its own answer: {err}", id.as_str()));

            let report = puzzle.agreement.expect("a report for a sampled lesson");
            assert!(report.accepted, "{}: {}", id.as_str(), report.attempts);
            assert_eq!(report.attempts, 1, "{}", id.as_str());
            assert_eq!(report.evaluations, 1, "{}", id.as_str());
            assert_eq!(report.rejected.total(), 0, "{}", id.as_str());
            assert_eq!(report.max_candidates, DEFAULT_MAX_CANDIDATES);
            assert!(report.recommended_action.is_some());
            assert_eq!(puzzle.state.category, id.as_str());
            // The accepted hand is still a reachable table.
            crate::generator::support::state_validation::validate_reachable_state(&puzzle.state)
                .unwrap_or_else(|err| {
                    panic!("{} accepted an unreachable table: {err}", id.as_str())
                });
        }
    }

    #[test]
    fn sampling_counts_each_rejection_reason_before_accepting() {
        let mut call = 0usize;
        let puzzle = generate(
            "ryanmen_protorun",
            MortalAgreementOptions::new(6),
            |state| {
                call += 1;
                match call {
                    1 => Err("forward pass exploded".to_string()),
                    2 => Ok(evaluation_with_top(state, "Riichi")),
                    3 => {
                        let answer = state.correct_action.tile().expect("answer tile");
                        let other = crate::ai::actions::legal_actions(state)
                            .into_iter()
                            .filter(|info| info.kind == ActionKind::Discard)
                            .find_map(|info| info.tile.filter(|tile| tile != answer))
                            .expect("another discard");
                        Ok(evaluation_with_top(state, &format!("Discard_{other}")))
                    }
                    _ => Ok(agreeing_evaluation(state)),
                }
            },
        )
        .expect("the fourth candidate agrees");

        let report = puzzle.agreement.expect("report");
        assert_eq!(report.attempts, 4);
        assert_eq!(report.evaluations, 3);
        assert_eq!(report.rejected.evaluation_failed, 1);
        assert_eq!(report.rejected.action, 1);
        assert_eq!(report.rejected.tile, 1);
        assert_eq!(report.rejected.total(), 3);
        assert!(report.accepted);
    }

    #[test]
    fn sampling_gives_up_at_the_candidate_bound() {
        let err = match generate(
            "ryanmen_protorun",
            MortalAgreementOptions::new(3),
            |state| {
                let answer = state.correct_action.tile().expect("answer tile");
                let other = crate::ai::actions::legal_actions(state)
                    .into_iter()
                    .filter(|info| info.kind == ActionKind::Discard)
                    .find_map(|info| info.tile.filter(|tile| tile != answer))
                    .expect("another discard");
                Ok(evaluation_with_top(state, &format!("Discard_{other}")))
            },
        ) {
            Ok(_) => panic!("no candidate can agree"),
            Err(err) => err,
        };

        assert!(err.contains("ryanmen_protorun"), "{err}");
        assert!(err.contains("3 attempt(s)"), "{err}");
        assert!(err.contains("3 tile mismatch"), "{err}");
    }

    #[test]
    fn a_zero_candidate_bound_is_rejected_up_front() {
        let err = match generate("ryanmen_protorun", MortalAgreementOptions::new(0), |_| {
            unreachable!("no evaluation may run")
        }) {
            Ok(_) => panic!("zero candidates cannot succeed"),
            Err(err) => err,
        };
        assert!(err.contains("at least one candidate"), "{err}");
    }

    #[test]
    fn the_mock_table_fixture_is_exempt() {
        let puzzle = generate("mock_table", MortalAgreementOptions::default(), |_| {
            unreachable!("the fixture must not be evaluated")
        })
        .expect("the fixture must be returned");

        assert_eq!(puzzle.state.category, "mock_table");
        assert!(puzzle.agreement.is_none());
    }

    #[test]
    fn the_ai_drill_is_not_sampled() {
        // Its answer *is* Mortal's argmax, and `generate_puzzle` cannot build
        // it without the evaluator, so every attempt is a generation failure.
        let err = match generate("ai_best_action", MortalAgreementOptions::new(2), |_| {
            unreachable!("the drill is never evaluated through this path")
        }) {
            Ok(_) => panic!("the drill path must not generate"),
            Err(err) => err,
        };
        assert!(err.contains("generation failure(s)"), "{err}");
    }

    #[test]
    fn the_accepted_puzzle_serializes_as_state_plus_report() {
        let puzzle = generate(
            "ryanmen_protorun",
            MortalAgreementOptions::new(4),
            |state| Ok(agreeing_evaluation(state)),
        )
        .expect("the first candidate agrees");

        let json = serde_json::to_value(&puzzle).expect("puzzle serializes");
        assert_eq!(json["state"]["category"], "ryanmen_protorun");
        assert_eq!(json["agreement"]["accepted"], true);
        assert_eq!(json["agreement"]["max_candidates"], 4);
        assert_eq!(json["agreement"]["attempts"], 1);
        // A lesson without situation parameters reports no pinned set.
        assert!(json["agreement"].get("situation").is_none());
    }

    /// Lessons with a parameter concept report the set they were built for.
    #[test]
    fn the_report_names_the_drawn_situation() {
        for category in [
            "riichi_judgement",
            "dama_bad_wait",
            "dama_expensive_hand",
            "chiitoitsu_riichi_vs_dama",
            "push_or_fold",
        ] {
            let puzzle = generate(category, MortalAgreementOptions::new(4), |state| {
                Ok(agreeing_evaluation(state))
            })
            .unwrap_or_else(|err| panic!("{category} must accept its own answer: {err}"));
            let report = puzzle.agreement.expect("report");
            let label = report
                .situation
                .unwrap_or_else(|| panic!("{category} must report its situation"));

            assert!(!label.is_empty(), "{category}");
            match category {
                "riichi_judgement" => assert!(
                    label.ends_with("dealer") || label.ends_with("non-dealer"),
                    "{label}"
                ),
                "dama_bad_wait" => assert!(label.contains("live "), "{label}"),
                "dama_expensive_hand" => assert!(label.starts_with("hand worth "), "{label}"),
                "push_or_fold" => assert!(label.starts_with("1-away, "), "{label}"),
                _ => assert!(label.starts_with("seven pairs"), "{label}"),
            }
        }
    }

    /// Every player-facing situation label, for the six parameterised lessons.
    ///
    /// Enumerated rather than sampled: the guard below is about wording, so it
    /// must see all of them, and drawing from the shared PRNG would leave other
    /// tests' unseeded draws at the mercy of this one.
    fn all_situation_labels() -> Vec<(&'static str, String)> {
        use crate::generator::chiitoitsu_riichi_vs_dama::{RiichiTriggerSet, Target as Chiitoitsu};
        use crate::generator::dama_bad_wait::Target as BadWait;
        use crate::generator::dama_expensive_hand::Target as Expensive;
        use crate::generator::honitsu_decision::Variant as Honitsu;
        use crate::generator::push_or_fold::Target as PushFold;
        use crate::generator::riichi_judgement::judgement::Conditions;

        let mut labels: Vec<(&'static str, String)> = Vec::new();

        for extra_han in [false, true] {
            for good_wait in [false, true] {
                for dealer in [false, true] {
                    labels.push((
                        "riichi_judgement",
                        Situation::RiichiJudgement(Conditions {
                            extra_han,
                            good_wait,
                            dealer,
                        })
                        .label(),
                    ));
                }
            }
        }
        for target in [
            BadWait::DamaFewSimples,
            BadWait::RiichiManyLive,
            BadWait::RiichiHonorTerminal,
        ] {
            labels.push(("dama_bad_wait", Situation::DamaBadWait(target).label()));
        }
        for target in [Expensive::Dama7700, Expensive::DamaHaneman] {
            labels.push((
                "dama_expensive_hand",
                Situation::DamaExpensiveHand(target).label(),
            ));
        }
        labels.push((
            "chiitoitsu_riichi_vs_dama",
            Situation::Chiitoitsu(Chiitoitsu::Dama).label(),
        ));
        labels.push((
            "chiitoitsu_riichi_vs_dama",
            Situation::Chiitoitsu(Chiitoitsu::Riichi(RiichiTriggerSet {
                red_five_wait: true,
                ..RiichiTriggerSet::default()
            }))
            .label(),
        ));
        // Every non-empty subset of the five triggers the red-five wait cannot
        // be combined with (ch7's red-five lesson stands alone).
        for mask in 1u8..32 {
            labels.push((
                "chiitoitsu_riichi_vs_dama",
                Situation::Chiitoitsu(Chiitoitsu::Riichi(RiichiTriggerSet {
                    dealer: mask & 1 != 0,
                    tanyao: mask & 2 != 0,
                    red_five_wait: false,
                    suji_trap: mask & 4 != 0,
                    wait_outside_456: mask & 8 != 0,
                    score_below_mangan: mask & 16 != 0,
                }))
                .label(),
            ));
        }
        for target in [PushFold::Push, PushFold::Fold] {
            labels.push(("push_or_fold", Situation::PushOrFold(target).label()));
        }
        for target in [Honitsu::Commit, Honitsu::AlreadyHigh, Honitsu::HonitsuOnly] {
            labels.push((
                "honitsu_decision",
                Situation::HonitsuDecision(target).label(),
            ));
        }

        labels
    }

    /// The situation note is only revealed once the answer is on screen, but a
    /// label that names the play is the drill's answer in textbook form, so it
    /// must stay impossible to put on screen early by accident.
    ///
    /// A label such as `riichi: good wait only` or `dama: 7700 without riichi`
    /// says what to do; every family label states table facts only.
    #[test]
    fn the_situation_label_never_names_the_answer() {
        let labels = all_situation_labels();
        assert!(
            labels.len() >= 51,
            "every parameterised cell must be covered, saw {}",
            labels.len()
        );

        for (category, label) in labels {
            assert!(!label.is_empty(), "{category}");
            let lower = label.to_lowercase();
            for action in ["riichi", "dama", "push", "fold", "commit", "efficiency"] {
                assert!(
                    !lower.contains(action),
                    "{category} situation names the answer: {label}"
                );
            }
            assert!(
                !label.ends_with(':') && !label.contains(": "),
                "{category} situation reads as an action prefix: {label}"
            );
        }
    }

    /// Families with no parameter concept keep the old per-candidate draw.
    #[test]
    fn lessons_without_parameters_report_no_situation() {
        for category in [
            "ryanmen_protorun",
            "nakabukure_ready",
            "defense_safety_chart",
            "fold_to_riichi",
            "dama_genbutsu_wait",
            "suji_trap_riichi",
            "wind_discard_order",
        ] {
            assert!(
                crate::generator::sample_situation(category).is_none(),
                "{category} must not claim a situation parameter"
            );
            let puzzle = generate(category, MortalAgreementOptions::new(2), |state| {
                Ok(agreeing_evaluation(state))
            })
            .unwrap_or_else(|err| panic!("{category} must accept its own answer: {err}"));
            assert!(
                puzzle.agreement.expect("report").situation.is_none(),
                "{category}"
            );
        }
    }

    /// The state-visible fingerprint of a `riichi_judgement` parameter set:
    /// which conditions the finished hand isolates.
    fn riichi_situation_key(state: &GameState) -> String {
        format!(
            "{:?}|{:?}|{}",
            state.riichi_triggers,
            state.ukeire_tiles.len(),
            state.players[0].wind == crate::state::Wind::East,
        )
    }

    /// The point of the task: a filter that rejects every candidate refills
    /// under one drawn situation instead of redrawing it.
    #[test]
    fn one_request_pins_one_situation_across_every_candidate() {
        crate::rng::seed(0x5117_0001);

        let mut keys = Vec::new();
        let err = generate(
            "riichi_judgement",
            MortalAgreementOptions::new(6),
            |state| {
                keys.push(riichi_situation_key(state));
                Ok(disagreeing_evaluation(state))
            },
        )
        .expect_err("every candidate must be rejected");

        assert_eq!(keys.len(), 6, "{err}");
        assert!(
            keys.windows(2).all(|pair| pair[0] == pair[1]),
            "the situation moved between candidates: {keys:?}"
        );
        assert!(err.contains("pinned situation"), "{err}");
    }

    /// A seeded run reproduces the whole table, not just its parameter set.
    #[test]
    fn a_seeded_request_replays_the_same_puzzle() {
        crate::rng::seed(0xc0ff_ee01);
        let first = crate::generator::generate_puzzle("riichi_judgement").expect("first draw");
        crate::rng::seed(0xc0ff_ee01);
        let second = crate::generator::generate_puzzle("riichi_judgement").expect("second draw");

        assert_eq!(first, second, "a seeded draw must be reproducible");
    }

    /// A drawn set that cannot be built must be reported, not silently
    /// replaced by an easier one.
    #[test]
    fn an_unachievable_pinned_situation_is_reported_instead_of_redrawn() {
        use crate::generator::chiitoitsu_riichi_vs_dama::{RiichiTriggerSet, Target as Chiitoitsu};

        // The red-five Riichi justification must stand alone; a set that pairs
        // it with the deal is a parameter draw the family can never build.
        let impossible = Situation::Chiitoitsu(Chiitoitsu::Riichi(RiichiTriggerSet {
            red_five_wait: true,
            dealer: true,
            ..RiichiTriggerSet::default()
        }));

        let err = generate_pinned(
            "chiitoitsu_riichi_vs_dama",
            Some(impossible),
            MortalAgreementOptions::new(2),
            |_| unreachable!("an unachievable situation must fail before evaluation"),
        )
        .expect_err("the impossible set must fail");

        assert!(err.contains("unachievable"), "{err}");
        assert!(
            err.contains("seven pairs, dealer + red-five wait"),
            "the error must name the drawn set: {err}"
        );
        assert!(err.contains("chiitoitsu_riichi_vs_dama"), "{err}");
    }

    #[test]
    fn a_zero_weight_model_samples_through_the_real_encoder() {
        use candle_core::{DType, Device};
        use candle_nn::VarBuilder;

        let vb = VarBuilder::zeros(DType::F32, &Device::Cpu);
        let model = MortalV4Model::new(vb).expect("zero-weight model");

        // Zero logits make every legal action equally likely, so the top action
        // is Mortal's fixed alphabetical tie-break. Whether that happens to be
        // the book's answer is not important: the call must either accept a
        // reachable table or exhaust the bound with a counted error.
        match generate_with_model(
            "ryanmen_protorun",
            &model,
            "zero_weights",
            MortalAgreementOptions::new(3),
        ) {
            Ok(puzzle) => {
                let report = puzzle.agreement.expect("report");
                assert!(report.accepted);
                assert!(report.evaluations >= 1 && report.evaluations <= 3);
                assert_eq!(report.rejected.total() + 1, report.evaluations);
                crate::generator::support::state_validation::validate_reachable_state(
                    &puzzle.state,
                )
                .expect("the accepted table is reachable");
            }
            Err(err) => {
                assert!(err.contains("3 attempt(s)"), "{err}");
                assert!(err.contains("tile mismatch"), "{err}");
            }
        }
    }

    #[test]
    fn real_weights_find_an_agreeing_hand() {
        const WEIGHTS: &str = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/frontend/public/models/mortal_298k.safetensors"
        );
        if !std::path::Path::new(WEIGHTS).exists() {
            eprintln!("skipping agreement inference test: {WEIGHTS} is missing");
            return;
        }

        use crate::ai::model::MortalV4Model;
        use candle_core::{DType, Device};
        use candle_nn::VarBuilder;

        let vb = VarBuilder::from_buffered_safetensors(
            std::fs::read(WEIGHTS).unwrap(),
            DType::F32,
            &Device::Cpu,
        )
        .unwrap();
        let model = MortalV4Model::new(vb).unwrap();

        let puzzle = generate_with_model(
            "ryanmen_protorun",
            &model,
            "mortal_298k.safetensors",
            MortalAgreementOptions::default(),
        )
        .expect("ryanmen agrees often enough to find a hand in twelve tries");

        let report = puzzle.agreement.expect("report");
        assert!(report.accepted);
        assert!(report.evaluations >= 1);
        assert!(report.evaluations <= DEFAULT_MAX_CANDIDATES);
        assert_eq!(
            report.rejected.total() + 1,
            report.evaluations,
            "every evaluation except the accepted one is a rejection"
        );
        // Re-evaluating the accepted state with the real model must agree, so
        // the filter cannot accept a hand the fuzz runner would flag.
        let evaluation = evaluate_state_named(&model, &puzzle.state, "mortal_298k.safetensors")
            .expect("the accepted state evaluates");
        assert_eq!(rejection_for(&puzzle.state, &evaluation), None);
    }
}
