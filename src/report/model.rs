//! Serializable model for versioned scenario reports.
//!
//! A report is a self-contained snapshot of one disputed puzzle: the exact
//! [`GameState`], the reporter's answer, the app's expected answer, and an
//! optional Mortal evaluation. The frontend downloads this object as JSON and
//! can import it again later.
//!
//! `decision.verdict` and `human_readable` are derived fields. Importers
//! recompute both instead of trusting them.

use serde::{Deserialize, Serialize};

use crate::ai::wasm_bridge::Evaluation;
use crate::state::{CorrectActionType, GameState};

use super::{REPORT_SCHEMA, REPORT_VERSION};

/// Human-readable prompt shown above the options for a decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecisionPrompt {
    RiichiOrDama,
    WhichDiscard,
    KanOrDiscard,
    PushOrFold,
}

impl DecisionPrompt {
    pub fn from_target(target: crate::state::TargetAction) -> Self {
        use crate::state::TargetAction;

        match target {
            TargetAction::Riichi | TargetAction::Dama => Self::RiichiOrDama,
            TargetAction::NaniKiru => Self::WhichDiscard,
            TargetAction::Kan => Self::KanOrDiscard,
            TargetAction::Push | TargetAction::Fold => Self::PushOrFold,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::RiichiOrDama => "Declare Riichi, or stay dama?",
            Self::WhichDiscard => "Which tile do you discard?",
            Self::KanOrDiscard => "Call Shouminkan, or discard?",
            Self::PushOrFold => "Push or fold?",
        }
    }
}

/// Why the reporter thinks the app's answer is wrong.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportReason {
    /// The action family is wrong (Riichi vs Dama, Kan vs Discard).
    ExpectedActionWrong,
    /// The action family is right but the discard tile is wrong.
    ExpectedTileWrong,
    /// The answer may be right but the explanation/triggers are wrong.
    ExplanationWrong,
    /// The Mortal evaluation itself looks wrong.
    AiEvaluationWrong,
    /// Anything else.
    Other,
}

impl ReportReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ExpectedActionWrong => "expected_action_wrong",
            Self::ExpectedTileWrong => "expected_tile_wrong",
            Self::ExplanationWrong => "explanation_wrong",
            Self::AiEvaluationWrong => "ai_evaluation_wrong",
            Self::Other => "other",
        }
    }
}

/// The action the reporter submitted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReportedAction {
    /// Action family the player submitted.
    pub action: CorrectActionType,
    /// Tile code clicked for the discard/Kan.
    pub tile: String,
    /// Optional index of the clicked copy in the rendered hand. This is only
    /// needed to disambiguate physical copies (for example two `5m` tiles,
    /// one of which is red); correctness itself is code-based.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tile_index: Option<usize>,
}

impl ReportedAction {
    pub fn new(action: CorrectActionType, tile: impl Into<String>) -> Self {
        Self {
            action,
            tile: tile.into(),
            tile_index: None,
        }
    }
}

/// Comparison between the app answer, the reporter answer, and Mortal.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AiComparison {
    /// Mortal action name for the app's expected answer (e.g. `Discard_3p`).
    pub app_action: String,
    /// Probability Mortal assigns to `app_action`, aggregating red-five variants.
    pub app_probability: f32,
    /// Mortal action name for the reporter's answer.
    pub reporter_action: String,
    /// Probability Mortal assigns to `reporter_action`.
    pub reporter_probability: f32,
    /// Whether Mortal's recommended action is the app's expected answer.
    pub ai_agrees_with_app: bool,
    /// Whether Mortal's recommended action is the reporter's answer.
    pub ai_agrees_with_reporter: bool,
}

/// Mortal evaluation captured at export time.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReportedAi {
    /// Weights file the evaluation came from.
    pub model: String,
    /// ISO timestamp for when the evaluation ran.
    pub evaluated_at: String,
    /// Full evaluator payload.
    pub evaluation: Evaluation,
    /// Derived convenience block. Recomputed on import.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comparison: Option<AiComparison>,
}

/// Recomputed result of comparing the reporter's answer to the app answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReportVerdict {
    pub is_correct: bool,
    pub is_action_correct: bool,
    pub is_tile_correct: bool,
    /// Action family the app expected.
    pub expected_action: CorrectActionType,
    /// Tile the app expected.
    pub expected_tile: String,
}

/// Scenario metadata snapshot so a report stays readable after a rename.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScenarioSnapshot {
    pub id: String,
    pub label: String,
    pub description: String,
    pub category: String,
    pub tags: Vec<String>,
}

/// Build information for the client that produced the report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppInfo {
    pub app_version: String,
    pub commit: String,
    pub build_time: String,
}

/// The disputed decision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReportDecision {
    /// Human-readable question, e.g. "Declare Riichi, or stay dama?".
    pub prompt: String,
    /// Reporter-selected category for the complaint.
    pub reason: ReportReason,
    /// Optional free-text note included in the file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// What the reporter clicked.
    pub answer: ReportedAction,
    /// Verdict captured at export time. Recomputed on import.
    pub verdict: ReportVerdict,
}

/// The complete report file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScenarioReport {
    pub schema: String,
    pub version: u32,
    pub report_id: String,
    pub created_at: String,
    pub app: AppInfo,
    pub scenario: ScenarioSnapshot,
    pub decision: ReportDecision,
    /// Exact table state. Never summarize or re-derive this on import.
    pub table: GameState,
    /// Optional Mortal snapshot.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai: Option<ReportedAi>,
    /// Derived text rendering for humans and LLM agents, one string per line.
    /// Rebuilt on import.
    #[serde(default)]
    pub human_readable: Vec<String>,
}

impl ScenarioReport {
    /// Stamp the schema and version fields for a new report.
    pub fn new(
        report_id: String,
        created_at: String,
        app: AppInfo,
        scenario: ScenarioSnapshot,
        decision: ReportDecision,
        table: GameState,
        ai: Option<ReportedAi>,
    ) -> Self {
        Self {
            schema: REPORT_SCHEMA.to_string(),
            version: REPORT_VERSION,
            report_id,
            created_at,
            app,
            scenario,
            decision,
            table,
            ai,
            human_readable: Vec::new(),
        }
    }
}

/// Result of parsing an imported report.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ParsedReport {
    /// Report with derived fields rebuilt for the current build.
    pub report: ScenarioReport,
    /// Verdict recomputed from `table.correct_action` and `decision.answer`.
    pub verdict: ReportVerdict,
    /// Non-fatal inconsistencies worth surfacing to the reviewer.
    pub warnings: Vec<String>,
}

/// Minimal envelope sent by the frontend when building a report.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildReportRequest {
    pub table: GameState,
    pub answer: ReportedAction,
    pub reason: ReportReason,
    #[serde(default)]
    pub note: Option<String>,
    pub created_at: String,
    pub report_id: String,
    #[serde(default)]
    pub commit: Option<String>,
    #[serde(default)]
    pub build_time: Option<String>,
    #[serde(default)]
    pub ai: Option<ReportedAi>,
}
