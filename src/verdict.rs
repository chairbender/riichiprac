//! Dual grading: the book heuristic and the Mortal policy, side by side.
//!
//! Every trainer puzzle has a book answer (`GameState::correct_action`, derived
//! from a Riichi Book 1 rule) and, once the model is loaded, a Mortal
//! recommendation. This module turns both comparisons into one verdict:
//!
//! - [`PerspectiveResult`] for each perspective,
//! - [`GradingMode`] for which perspectives actually exist at runtime,
//! - [`AnswerOutcome`] as the single derived label the UI renders.
//!
//! The invariant that matters: an answer is only *wrong* when both perspectives
//! reject it ([`AnswerOutcome::NeitherAgrees`]). A single-perspective miss is
//! reported as a statement about that perspective, never as a judgement.

use serde::{Deserialize, Serialize};

use crate::ai::wasm_bridge::Evaluation;
use crate::state::{CorrectAction, CorrectActionType, GameState};

/// Draw weighting used for the display-only "Mortal was nearly split" note.
pub const CLOSE_SECOND_GAP: f32 = 0.05;
/// Upper cut-point of the `Low` display band (below this is `Low`).
const CONFIDENCE_MEDIUM: f32 = 0.25;
/// Upper cut-point of the `Medium` display band (at or above is `High`).
const CONFIDENCE_HIGH: f32 = 0.50;

/// The action the player submitted, in trainer vocabulary.
///
/// This is the same shape the report format carries (`ReportedAction`), moved
/// here so grading does not depend on the report module.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubmittedAnswer {
    /// Action family the player submitted.
    pub action: CorrectActionType,
    /// Tile code clicked for the discard/Kan.
    pub tile: String,
    /// Optional index of the clicked copy in the rendered hand. Only needed to
    /// disambiguate physical copies (for example two `5m`, one of them red);
    /// correctness itself is code-based.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tile_index: Option<usize>,
    /// Mortal action name for an AI-scenario answer (`Chi_Low`, `Pon`, ...).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action_name: Option<String>,
}

impl SubmittedAnswer {
    pub fn new(action: CorrectActionType, tile: impl Into<String>) -> Self {
        Self {
            action,
            tile: tile.into(),
            tile_index: None,
            action_name: None,
        }
    }

    /// Attach the Mortal action name for an AI-scenario answer.
    pub fn with_action_name(mut self, action_name: impl Into<String>) -> Self {
        self.action_name = Some(action_name.into());
        self
    }
}

/// Whether one perspective accepts the answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PerspectiveResult {
    Agrees,
    Disagrees,
    Unavailable,
}

/// Which perspectives exist for this grade.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GradingMode {
    /// Book rule and a loaded model.
    BookAndMortal,
    /// Model missing (weights failed, still loading, or evaluation errored).
    BookOnly,
    /// A declared Mortal drill: the answer *is* the model's action.
    MortalOnly,
    /// Neither perspective could be computed.
    Ungraded,
}

impl GradingMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::BookAndMortal => "book_and_mortal",
            Self::BookOnly => "book_only",
            Self::MortalOnly => "mortal_only",
            Self::Ungraded => "ungraded",
        }
    }
}

/// The single derived label. `NeitherAgrees` is the only "wrong" state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnswerOutcome {
    BothAgree,
    BookAgreesMortalDoesNot,
    MortalAgreesBookDoesNot,
    NeitherAgrees,
    OnlyAvailableAgrees,
    OnlyAvailableDisagrees,
    Ungraded,
}

impl AnswerOutcome {
    /// True only when both perspectives reject the answer.
    pub fn is_wrong(self) -> bool {
        self == Self::NeitherAgrees
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::BothAgree => "both_agree",
            Self::BookAgreesMortalDoesNot => "book_agrees_mortal_does_not",
            Self::MortalAgreesBookDoesNot => "mortal_agrees_book_does_not",
            Self::NeitherAgrees => "neither_agrees",
            Self::OnlyAvailableAgrees => "only_available_agrees",
            Self::OnlyAvailableDisagrees => "only_available_disagrees",
            Self::Ungraded => "ungraded",
        }
    }
}

/// Display-only confidence bucket for Mortal's recommendation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MortalConfidence {
    High,
    Medium,
    Low,
    /// No probabilities available (a drill graded without a live evaluation).
    Unknown,
}

impl MortalConfidence {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::High => "high",
            Self::Medium => "medium",
            Self::Low => "low",
            Self::Unknown => "unknown",
        }
    }

    fn from_top_probability(probability: Option<f32>) -> Self {
        match probability {
            None => Self::Unknown,
            Some(probability) if !probability.is_finite() => Self::Unknown,
            Some(probability) if probability >= CONFIDENCE_HIGH => Self::High,
            Some(probability) if probability >= CONFIDENCE_MEDIUM => Self::Medium,
            Some(_) => Self::Low,
        }
    }
}

/// The book's grade for the submitted answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BookGrade {
    pub is_action_correct: bool,
    pub is_tile_correct: bool,
    pub expected_action: CorrectActionType,
    pub expected_tile: String,
}

impl BookGrade {
    pub fn agrees(&self) -> bool {
        self.is_action_correct && self.is_tile_correct
    }
}

/// Mortal's grade for the submitted answer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MortalGrade {
    /// Exact model identity, e.g. `mortal_298k.safetensors`.
    pub model: String,
    /// Raw argmax action name, including a red-five suffix when applicable.
    pub recommended_action: String,
    /// Red-five-normalized argmax.
    pub recommended_base: String,
    /// Human-readable label for the recommendation.
    pub recommended_label: String,
    /// True when the recommendation is a Riichi declaration.
    ///
    /// Mortal's action space has a single `Riichi` action, so this is the
    /// declaration half of the answer; [`Self::recommended_discard`] is the
    /// other half when the evaluator could resolve it.
    #[serde(default)]
    pub recommended_riichi: bool,
    /// The discard Mortal would declare Riichi on, when known.
    ///
    /// Populated from the evaluator's Riichi second pass (or the drill's
    /// stored answer). `None` when Mortal is not declaring Riichi, or when no
    /// second pass was available, in which case the declaration is graded on
    /// its own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recommended_discard: Option<String>,
    /// The submitted answer expressed in Mortal's action vocabulary.
    pub answer_action: String,
    /// Whether the answer's declaration matches the recommendation
    /// (Riichi with Riichi, or the same non-Riichi action).
    pub matches_action: bool,
    /// Whether the answer's tile matches, when the recommendation carries one
    /// (a discard action, or a Riichi declaration with a known discard).
    pub matches_tile: bool,
    /// True only when both parts match; the model's top action.
    pub agrees: bool,
    /// Probability the model assigned to the answer, red-five variants summed.
    pub answer_probability: f32,
    /// Probability of the recommended action.
    pub top_probability: f32,
    /// Display-only confidence bucket.
    pub confidence: MortalConfidence,
    /// True when a rejected answer is within [`CLOSE_SECOND_GAP`] of the top.
    pub close_second: bool,
}

/// The full dual verdict for one submitted answer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DualGrade {
    pub mode: GradingMode,
    /// None for a Mortal drill, which has no book rule.
    pub book: Option<BookGrade>,
    /// None when no evaluation exists for a book lesson.
    pub mortal: Option<MortalGrade>,
    pub outcome: AnswerOutcome,
}

impl DualGrade {
    /// True only when both perspectives reject the answer.
    pub fn is_wrong(&self) -> bool {
        self.outcome.is_wrong()
    }
}

/// Grade one submitted answer against both perspectives.
///
/// A `CorrectAction::Best` state is a Mortal drill: the state's own answer is
/// the model's, so the Mortal perspective exists even when no live evaluation
/// does (probabilities are then reported as `0.0` and confidence as
/// [`MortalConfidence::Unknown`]).
pub fn grade_answer(
    state: &GameState,
    answer: &SubmittedAnswer,
    evaluation: Option<&Evaluation>,
) -> DualGrade {
    let is_drill = matches!(state.correct_action, CorrectAction::Best { .. });

    let book = if is_drill {
        None
    } else {
        Some(grade_book_with_equivalents(
            &state.correct_action,
            &state.equivalent_tiles,
            answer,
        ))
    };

    let mortal = if is_drill {
        Some(grade_drill(state, answer, evaluation))
    } else {
        evaluation.map(|evaluation| grade_mortal(evaluation, answer))
    };

    grade_from_parts(book, mortal)
}

/// Assemble a grade from parts that were computed elsewhere (report import).
pub fn grade_from_parts(book: Option<BookGrade>, mortal: Option<MortalGrade>) -> DualGrade {
    let outcome = outcome_for(book.as_ref(), mortal.as_ref());
    let mode = mode_for(book.as_ref(), mortal.as_ref());

    DualGrade {
        mode,
        book,
        mortal,
        outcome,
    }
}

/// Grade against the book's `correct_action` (action family plus tile).
pub fn grade_book(expected: &CorrectAction, answer: &SubmittedAnswer) -> BookGrade {
    grade_book_with_equivalents(expected, &[], answer)
}

/// Grade against the book's `correct_action`, accepting any tile the state
/// declares equivalent.
///
/// Some lessons ask for a shape rather than one named tile (for example the
/// protorun lesson, where either tile of a closed wait is the same discard).
/// Those states name the tile the player drew in `correct_action` and list the
/// interchangeable tiles in [`GameState::equivalent_tiles`], so the twin choice
/// is graded as agreeing rather than as a miss.
pub fn grade_book_with_equivalents(
    expected: &CorrectAction,
    equivalents: &[String],
    answer: &SubmittedAnswer,
) -> BookGrade {
    let expected_action = expected.action_type();
    let expected_tile = expected.tile();

    let is_action_correct = answer.action == expected_action;
    let is_tile_correct = match expected_tile {
        Some(tile) => answer.tile == tile || equivalents.iter().any(|other| other == &answer.tile),
        None => answer.tile.is_empty(),
    };

    BookGrade {
        is_action_correct,
        is_tile_correct,
        expected_action,
        expected_tile: expected_tile.unwrap_or_default().to_string(),
    }
}

/// Grade a Mortal drill, where the state's `best` action is the recommendation.
fn grade_drill(
    state: &GameState,
    answer: &SubmittedAnswer,
    evaluation: Option<&Evaluation>,
) -> MortalGrade {
    let CorrectAction::Best {
        action,
        tile,
        label,
        ..
    } = &state.correct_action
    else {
        unreachable!("grade_drill is only called for CorrectAction::Best");
    };

    let recommended_base = normalize_mortal_action(action);
    let recommended_riichi = recommended_base == "Riichi";
    let answer_action = normalize_mortal_action(
        &answer
            .action_name
            .clone()
            .unwrap_or_else(|| mortal_action_for_answer(answer)),
    );

    // Riichi and the call actions are graded at action level; discards carry a
    // tile, which the drill stores next to the action. A Riichi drill's tile is
    // the second-pass discard, so the declaration and its discard are graded as
    // one answer.
    let needs_tile = recommended_riichi || action.starts_with("Discard_");
    let tile_matches = !needs_tile || answer.tile == tile.as_deref().unwrap_or_default();
    let matches_action = answer_action == recommended_base;
    let agrees = matches_action && tile_matches;

    let (top_probability, answer_probability) = match evaluation {
        Some(evaluation) => (
            probability_for_action(evaluation, action),
            probability_for_action(evaluation, &answer_action),
        ),
        None => (0.0, 0.0),
    };
    let confidence = MortalConfidence::from_top_probability(evaluation.map(|_| top_probability));

    MortalGrade {
        model: evaluation
            .map(|evaluation| evaluation.model.clone())
            .unwrap_or_else(|| "Mortal".to_string()),
        recommended_action: action.clone(),
        recommended_base,
        recommended_label: label.clone(),
        recommended_riichi,
        recommended_discard: recommended_riichi.then(|| tile.clone()).flatten(),
        answer_action,
        matches_action,
        matches_tile: tile_matches,
        agrees,
        answer_probability,
        top_probability,
        confidence,
        close_second: !agrees
            && top_probability > 0.0
            && (top_probability - answer_probability).abs() <= CLOSE_SECOND_GAP,
    }
}

/// Grade against a live Mortal evaluation.
///
/// The comparison is the whole declaration, not just the float in the action
/// vector: Riichi with Riichi, a discard with the same discard, and Riichi-vs-
/// dama always a miss. When the evaluation resolved Mortal's Riichi discard,
/// the tile is graded too, so a right declaration on the wrong tile is not a
/// full agreement.
fn grade_mortal(evaluation: &Evaluation, answer: &SubmittedAnswer) -> MortalGrade {
    let recommended_action = evaluation.recommended_action.clone();
    let recommended_base = normalize_mortal_action(&recommended_action);
    let recommended_riichi = recommended_base == "Riichi";
    let answer_action = normalize_mortal_action(&mortal_action_for_answer(answer));
    let answer_riichi = answer_action == "Riichi";

    let (matches_action, matches_tile) = if recommended_riichi {
        let tile_matches = if answer_riichi {
            // Mortal's `Riichi` action carries no tile; compare the second-pass
            // discard only when the evaluator could resolve it.
            evaluation
                .riichi_discard
                .as_deref()
                .is_none_or(|discard| discard == answer.tile)
        } else {
            false
        };
        (answer_riichi, tile_matches)
    } else {
        (recommended_base == answer_action, true)
    };
    let agrees = matches_action && matches_tile;

    let top_probability = probability_for_action(evaluation, &recommended_action);
    let answer_probability = probability_for_action(evaluation, &answer_action);
    let recommended_label = evaluation
        .evaluations
        .iter()
        .find(|scored| scored.info.action == recommended_action)
        .map(|scored| scored.info.label.clone())
        .filter(|label| !label.is_empty())
        .unwrap_or_else(|| display_action_name(&recommended_action));

    MortalGrade {
        model: evaluation.model.clone(),
        recommended_action,
        recommended_base,
        recommended_label,
        recommended_riichi,
        recommended_discard: recommended_riichi
            .then(|| evaluation.riichi_discard.clone())
            .flatten(),
        answer_action,
        matches_action,
        matches_tile,
        agrees,
        answer_probability,
        top_probability,
        confidence: MortalConfidence::from_top_probability(Some(top_probability)),
        close_second: !agrees
            && top_probability > 0.0
            && (top_probability - answer_probability).abs() <= CLOSE_SECOND_GAP,
    }
}

fn outcome_for(book: Option<&BookGrade>, mortal: Option<&MortalGrade>) -> AnswerOutcome {
    let book_agrees = book.map(BookGrade::agrees);
    let mortal_agrees = mortal.map(|mortal| mortal.agrees);

    match (book_agrees, mortal_agrees) {
        (Some(true), Some(true)) => AnswerOutcome::BothAgree,
        (Some(true), Some(false)) => AnswerOutcome::BookAgreesMortalDoesNot,
        (Some(false), Some(true)) => AnswerOutcome::MortalAgreesBookDoesNot,
        (Some(false), Some(false)) => AnswerOutcome::NeitherAgrees,
        (Some(true), None) => AnswerOutcome::OnlyAvailableAgrees,
        (Some(false), None) => AnswerOutcome::OnlyAvailableDisagrees,
        (None, Some(true)) => AnswerOutcome::OnlyAvailableAgrees,
        (None, Some(false)) => AnswerOutcome::OnlyAvailableDisagrees,
        (None, None) => AnswerOutcome::Ungraded,
    }
}

fn mode_for(book: Option<&BookGrade>, mortal: Option<&MortalGrade>) -> GradingMode {
    match (book.is_some(), mortal.is_some()) {
        (true, true) => GradingMode::BookAndMortal,
        (true, false) => GradingMode::BookOnly,
        (false, true) => GradingMode::MortalOnly,
        (false, false) => GradingMode::Ungraded,
    }
}

/// Collapse a red-five discard action onto its base tile for grading.
pub fn normalize_mortal_action(action: &str) -> String {
    if let Some(tile) = action.strip_prefix("Discard_")
        && let Some(base) = tile.strip_suffix('r')
    {
        return format!("Discard_{base}");
    }
    action.to_string()
}

/// Mortal action name for the book's expected answer.
pub fn mortal_action_for_correct(action: &CorrectAction) -> String {
    match action {
        CorrectAction::Riichi { .. } => "Riichi".to_string(),
        CorrectAction::Dama { discard } | CorrectAction::Fold { discard } => {
            format!("Discard_{discard}")
        }
        CorrectAction::Kan { .. } => "Kan".to_string(),
        CorrectAction::Discard { tile } => format!("Discard_{tile}"),
        CorrectAction::Best { action, .. } => action.clone(),
    }
}

/// Mortal action name for a submitted answer.
pub fn mortal_action_for_answer(answer: &SubmittedAnswer) -> String {
    match answer.action {
        CorrectActionType::Riichi => "Riichi".to_string(),
        CorrectActionType::Dama => format!("Discard_{}", answer.tile),
        CorrectActionType::Fold => format!("Discard_{}", answer.tile),
        CorrectActionType::Kan => "Kan".to_string(),
        CorrectActionType::Discard => format!("Discard_{}", answer.tile),
        CorrectActionType::Best => answer
            .action_name
            .clone()
            .unwrap_or_else(|| format!("Discard_{}", answer.tile)),
    }
}

/// Whether Mortal's top action matches `action`, including the declared
/// discard for a Riichi recommendation when the evaluator resolved one.
///
/// A Riichi recommendation whose second-pass discard is unknown still matches
/// any Riichi declaration: the model never picked a tile for it.
pub fn mortal_recommendation_matches(evaluation: &Evaluation, action: &str, tile: &str) -> bool {
    let recommended = normalize_mortal_action(&evaluation.recommended_action);
    let candidate = normalize_mortal_action(action);
    if recommended != candidate {
        return false;
    }
    if recommended == "Riichi" {
        return evaluation
            .riichi_discard
            .as_deref()
            .is_none_or(|discard| discard == tile);
    }
    true
}

/// Sum the action probability, including the red-five variant for 5m/5p/5s.
pub fn probability_for_action(evaluation: &Evaluation, action: &str) -> f32 {
    let base = normalize_mortal_action(action);
    let red_variant = base
        .strip_prefix("Discard_")
        .filter(|tile| is_five_tile(tile))
        .map(|_| format!("{base}r"));

    evaluation
        .evaluations
        .iter()
        .filter(|scored| {
            scored.info.action == base
                || red_variant
                    .as_deref()
                    .is_some_and(|red| scored.info.action == red)
        })
        .map(|scored| scored.probability)
        .sum()
}

fn is_five_tile(tile: &str) -> bool {
    let bytes = tile.as_bytes();
    bytes.len() == 2 && bytes[0] == b'5' && matches!(bytes[1], b'm' | b'p' | b's')
}

/// Human-readable label for a raw Mortal action name.
pub fn display_action_name(action: &str) -> String {
    if let Some(tile) = action.strip_prefix("Discard_") {
        return match tile.strip_suffix('r') {
            Some(base) => format!("Discard {base} (red)"),
            None => format!("Discard {tile}"),
        };
    }
    match action {
        "Agari" => "Win (agari)".to_string(),
        "Ryukyoku" => "Draw (ryukyoku)".to_string(),
        other => other.replace('_', " "),
    }
}

#[derive(Debug, Deserialize)]
struct GradeRequest {
    table: GameState,
    answer: SubmittedAnswer,
    #[serde(default)]
    evaluation: Option<Evaluation>,
}

/// Native JSON boundary for the WASM export.
pub fn grade_answer_json(request_json: &str) -> Result<String, String> {
    let request: GradeRequest = serde_json::from_str(request_json)
        .map_err(|err| format!("Invalid grade request: {err}"))?;
    let grade = grade_answer(&request.table, &request.answer, request.evaluation.as_ref());
    serde_json::to_string(&grade).map_err(|err| format!("Failed to serialize grade: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::wasm_bridge::ActionEvaluation;
    use crate::state::CorrectAction;

    fn evaluation(actions: &[(&str, f32)]) -> Evaluation {
        Evaluation {
            model: "mortal_298k.safetensors".to_string(),
            expected_value: 0.1,
            recommended_action: actions
                .first()
                .map(|(name, _)| (*name).to_string())
                .unwrap_or_default(),
            riichi_discard: None,
            evaluations: actions
                .iter()
                .map(|(name, probability)| {
                    ActionEvaluation::from_parts(name, "discard", None, *probability)
                })
                .collect(),
        }
    }

    /// A Riichi recommendation, optionally with the second-pass discard.
    fn riichi_evaluation(discard: Option<&str>) -> Evaluation {
        let mut evaluation = evaluation(&[("Riichi", 0.7), ("Discard_3p", 0.2)]);
        evaluation.riichi_discard = discard.map(str::to_string);
        evaluation
    }

    fn dama_state() -> GameState {
        let mut state = crate::fixtures::mock_table::generate("mock_table").unwrap();
        state.correct_action = CorrectAction::dama("3p");
        state
    }

    fn riichi_state() -> GameState {
        let mut state = crate::fixtures::mock_table::generate("mock_table").unwrap();
        state.correct_action = CorrectAction::riichi("3p");
        state
    }

    fn drill_state() -> GameState {
        let mut state = crate::fixtures::mock_table::generate("mock_table").unwrap();
        state.correct_action = CorrectAction::best(
            "Riichi",
            Some("3p".to_string()),
            Vec::new(),
            "Riichi".to_string(),
        );
        state
    }

    fn answer(action: CorrectActionType, tile: &str) -> SubmittedAnswer {
        SubmittedAnswer::new(action, tile)
    }

    #[test]
    fn outcome_matrix_is_total_and_only_neither_is_wrong() {
        let table = [
            (Some(true), Some(true), AnswerOutcome::BothAgree),
            (
                Some(true),
                Some(false),
                AnswerOutcome::BookAgreesMortalDoesNot,
            ),
            (
                Some(false),
                Some(true),
                AnswerOutcome::MortalAgreesBookDoesNot,
            ),
            (Some(false), Some(false), AnswerOutcome::NeitherAgrees),
            (Some(true), None, AnswerOutcome::OnlyAvailableAgrees),
            (Some(false), None, AnswerOutcome::OnlyAvailableDisagrees),
            (None, Some(true), AnswerOutcome::OnlyAvailableAgrees),
            (None, Some(false), AnswerOutcome::OnlyAvailableDisagrees),
            (None, None, AnswerOutcome::Ungraded),
        ];

        for (book, mortal, expected) in table {
            let book_grade = book.map(|agrees| BookGrade {
                is_action_correct: agrees,
                is_tile_correct: agrees,
                expected_action: CorrectActionType::Dama,
                expected_tile: "3p".to_string(),
            });
            let mortal_grade = mortal.map(|agrees| MortalGrade {
                model: "test".to_string(),
                recommended_action: "Discard_3p".to_string(),
                recommended_base: "Discard_3p".to_string(),
                recommended_label: "Discard 3p".to_string(),
                recommended_riichi: false,
                recommended_discard: None,
                answer_action: "Discard_3p".to_string(),
                matches_action: agrees,
                matches_tile: agrees,
                agrees,
                answer_probability: 0.5,
                top_probability: 0.5,
                confidence: MortalConfidence::Medium,
                close_second: false,
            });

            let outcome = outcome_for(book_grade.as_ref(), mortal_grade.as_ref());
            assert_eq!(outcome, expected);
            assert_eq!(outcome.is_wrong(), expected == AnswerOutcome::NeitherAgrees);
        }
    }

    #[test]
    fn book_only_never_calls_an_answer_wrong() {
        let grade = grade_answer(
            &dama_state(),
            &answer(CorrectActionType::Riichi, "3p"),
            None,
        );

        assert_eq!(grade.mode, GradingMode::BookOnly);
        assert_eq!(grade.outcome, AnswerOutcome::OnlyAvailableDisagrees);
        assert!(!grade.is_wrong());
        assert!(grade.mortal.is_none());
    }

    #[test]
    fn both_disagree_is_the_only_wrong_outcome() {
        let eval = evaluation(&[("Discard_5s", 0.6), ("Discard_3p", 0.1)]);
        let grade = grade_answer(
            &dama_state(),
            &answer(CorrectActionType::Riichi, "3p"),
            Some(&eval),
        );

        assert_eq!(grade.outcome, AnswerOutcome::NeitherAgrees);
        assert!(grade.is_wrong());
    }

    #[test]
    fn picking_one_side_of_a_split_is_not_wrong() {
        let eval = evaluation(&[("Discard_5s", 0.6)]);
        let state = dama_state();

        let picks_book = grade_answer(&state, &answer(CorrectActionType::Dama, "3p"), Some(&eval));
        assert_eq!(picks_book.outcome, AnswerOutcome::BookAgreesMortalDoesNot);
        assert!(!picks_book.is_wrong());

        let picks_mortal =
            grade_answer(&state, &answer(CorrectActionType::Dama, "5s"), Some(&eval));
        assert_eq!(picks_mortal.outcome, AnswerOutcome::MortalAgreesBookDoesNot);
        assert!(!picks_mortal.is_wrong());
    }

    #[test]
    fn red_five_answer_matches_its_plain_tile() {
        let eval = evaluation(&[("Discard_5mr", 0.4), ("Discard_5m", 0.2)]);

        let grade = grade_answer(
            &dama_state(),
            &answer(CorrectActionType::Dama, "5m"),
            Some(&eval),
        );

        let mortal = grade.mortal.expect("mortal grade");
        assert!(mortal.agrees);
        assert_eq!(mortal.recommended_base, "Discard_5m");
        // Both entries are aggregated, not just the red one.
        assert!((mortal.answer_probability - 0.6).abs() < 1e-6);
        assert!((mortal.top_probability - 0.6).abs() < 1e-6);
    }

    #[test]
    fn riichi_agreement_ignores_the_discard_tile() {
        let eval = evaluation(&[("Riichi", 0.7), ("Discard_3p", 0.2)]);
        let grade = grade_answer(
            &riichi_state(),
            &answer(CorrectActionType::Riichi, "7s"),
            Some(&eval),
        );

        let mortal = grade.mortal.expect("mortal grade");
        assert!(mortal.agrees, "Riichi is a single model action");
        assert!(mortal.recommended_riichi);
        assert_eq!(mortal.recommended_discard, None);
        let book = grade.book.expect("book grade");
        assert!(book.is_action_correct);
        assert!(!book.is_tile_correct, "the book still grades the tile");
        assert_eq!(grade.outcome, AnswerOutcome::MortalAgreesBookDoesNot);
    }

    #[test]
    fn riichi_recommendation_grades_the_declared_discard_when_known() {
        let eval = riichi_evaluation(Some("3p"));

        let same_tile = grade_answer(
            &riichi_state(),
            &answer(CorrectActionType::Riichi, "3p"),
            Some(&eval),
        );
        let mortal = same_tile.mortal.expect("mortal grade");
        assert!(mortal.recommended_riichi);
        assert_eq!(mortal.recommended_discard.as_deref(), Some("3p"));
        assert!(mortal.matches_action);
        assert!(mortal.matches_tile);
        assert!(mortal.agrees);
        assert_eq!(same_tile.outcome, AnswerOutcome::BothAgree);

        // Same declaration on the wrong tile: the declaration half is right,
        // the discard half is not, so it is not a full agreement — and the book
        // rejects the tile too.
        let other_tile = grade_answer(
            &riichi_state(),
            &answer(CorrectActionType::Riichi, "7s"),
            Some(&eval),
        );
        let mortal = other_tile.mortal.expect("mortal grade");
        assert!(mortal.matches_action);
        assert!(!mortal.matches_tile);
        assert!(!mortal.agrees);
        assert!(!other_tile.book.expect("book grade").is_tile_correct);
        assert_eq!(other_tile.outcome, AnswerOutcome::NeitherAgrees);
    }

    #[test]
    fn dama_answer_misses_a_riichi_recommendation_even_on_the_same_tile() {
        let eval = riichi_evaluation(Some("3p"));
        let grade = grade_answer(
            &riichi_state(),
            &answer(CorrectActionType::Dama, "3p"),
            Some(&eval),
        );

        let mortal = grade.mortal.expect("mortal grade");
        assert!(mortal.recommended_riichi);
        assert!(!mortal.matches_action, "dama is not Mortal's declaration");
        assert!(!mortal.matches_tile);
        assert!(!mortal.agrees);
        assert_eq!(grade.outcome, AnswerOutcome::NeitherAgrees);
    }

    #[test]
    fn riichi_answer_misses_a_dama_recommendation_on_the_same_tile() {
        let eval = evaluation(&[("Discard_3p", 0.6), ("Riichi", 0.2)]);
        let grade = grade_answer(
            &riichi_state(),
            &answer(CorrectActionType::Riichi, "3p"),
            Some(&eval),
        );

        let mortal = grade.mortal.expect("mortal grade");
        assert!(!mortal.recommended_riichi);
        assert_eq!(mortal.recommended_discard, None);
        assert!(!mortal.matches_action);
        assert!(!mortal.agrees);
    }

    #[test]
    fn drill_exposes_the_riichi_declaration_and_its_discard() {
        let grade = grade_answer(
            &drill_state(),
            &SubmittedAnswer::new(CorrectActionType::Best, "3p").with_action_name("Riichi"),
            None,
        );

        let mortal = grade.mortal.expect("drill grade");
        assert!(mortal.recommended_riichi);
        assert_eq!(mortal.recommended_discard.as_deref(), Some("3p"));
        assert!(mortal.agrees);

        let dama = grade_answer(
            &drill_state(),
            &SubmittedAnswer::new(CorrectActionType::Best, "3p"),
            None,
        );
        let mortal = dama.mortal.expect("drill grade");
        assert!(!mortal.matches_action, "damning away from Riichi is a miss");
        assert!(!mortal.agrees);
    }

    #[test]
    fn close_second_is_display_only() {
        let eval = evaluation(&[("Discard_5s", 0.34), ("Discard_3p", 0.31)]);
        let grade = grade_answer(
            &dama_state(),
            &answer(CorrectActionType::Dama, "3p"),
            Some(&eval),
        );

        let mortal = grade.mortal.expect("mortal grade");
        assert!(!mortal.agrees);
        assert!(mortal.close_second);
        assert_eq!(mortal.confidence, MortalConfidence::Medium);
    }

    #[test]
    fn equivalent_tiles_are_graded_as_the_same_answer() {
        let mut state = dama_state();
        state.equivalent_tiles = vec!["5s".to_string()];

        let twin = grade_answer(&state, &answer(CorrectActionType::Dama, "5s"), None);
        let book = twin.book.expect("book grade");
        assert!(
            book.is_tile_correct,
            "the equivalent tile must grade correct"
        );
        assert!(book.agrees());
        assert_eq!(book.expected_tile, "3p", "the canonical tile is unchanged");

        let miss = grade_answer(&state, &answer(CorrectActionType::Dama, "7p"), None);
        assert!(
            !miss.book.expect("book grade").is_tile_correct,
            "a tile that is neither expected nor equivalent still misses"
        );
    }

    #[test]
    fn drill_grades_against_the_state_action() {
        let no_eval = grade_answer(
            &drill_state(),
            &SubmittedAnswer::new(CorrectActionType::Best, "3p").with_action_name("Riichi"),
            None,
        );
        assert_eq!(no_eval.mode, GradingMode::MortalOnly);
        assert_eq!(no_eval.outcome, AnswerOutcome::OnlyAvailableAgrees);
        assert!(no_eval.book.is_none());
        let mortal = no_eval.mortal.expect("drill grade");
        assert_eq!(mortal.confidence, MortalConfidence::Unknown);
        assert!(mortal.agrees);

        let wrong_tile = grade_answer(
            &drill_state(),
            &SubmittedAnswer::new(CorrectActionType::Best, "7s").with_action_name("Riichi"),
            None,
        );
        assert_eq!(wrong_tile.outcome, AnswerOutcome::OnlyAvailableDisagrees);
        assert!(!wrong_tile.is_wrong(), "a drill miss is still not 'wrong'");
    }

    #[test]
    fn drill_without_a_model_still_grades_but_has_no_probabilities() {
        let grade = grade_answer(
            &drill_state(),
            &SubmittedAnswer::new(CorrectActionType::Best, "3p").with_action_name("Riichi"),
            None,
        );

        let mortal = grade.mortal.expect("drill grade");
        assert_eq!(mortal.answer_probability, 0.0);
        assert_eq!(mortal.top_probability, 0.0);
    }

    #[test]
    fn grade_json_round_trips() {
        let state = dama_state();
        let request = serde_json::json!({
            "table": state,
            "answer": { "action": "dama", "tile": "3p" },
            "evaluation": serde_json::Value::Null,
        });

        let json = grade_answer_json(&request.to_string()).expect("grade must serialize");
        let grade: DualGrade = serde_json::from_str(&json).expect("grade must parse");

        assert_eq!(grade.mode, GradingMode::BookOnly);
        assert_eq!(grade.outcome, AnswerOutcome::OnlyAvailableAgrees);
    }

    #[test]
    fn old_mortal_grades_default_the_riichi_fields() {
        // A report written before `recommended_riichi` / `recommended_discard`
        // existed must still import; both fields default.
        let grade: MortalGrade = serde_json::from_value(serde_json::json!({
            "model": "mortal_298k.safetensors",
            "recommended_action": "Discard_3p",
            "recommended_base": "Discard_3p",
            "recommended_label": "Discard 3p",
            "answer_action": "Discard_3p",
            "matches_action": true,
            "matches_tile": true,
            "agrees": true,
            "answer_probability": 0.6,
            "top_probability": 0.6,
            "confidence": "high",
            "close_second": false
        }))
        .expect("old grade payload parses");

        assert!(!grade.recommended_riichi);
        assert_eq!(grade.recommended_discard, None);
    }

    #[test]
    fn display_names_cover_the_action_vocabulary() {
        assert_eq!(display_action_name("Discard_3p"), "Discard 3p");
        assert_eq!(display_action_name("Discard_5mr"), "Discard 5m (red)");
        assert_eq!(display_action_name("Chi_Low"), "Chi Low");
        assert_eq!(display_action_name("Agari"), "Win (agari)");
    }
}
