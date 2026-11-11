//! Versioned, self-contained scenario reports for disputed decisions.
//!
//! The frontend sends a minimal [`BuildReportRequest`] containing the exact
//! [`crate::state::GameState`] and the reporter's answer. This module stamps
//! the schema, derives the verdict and readable summary, and returns a JSON
//! file that can be imported later.
//!
//! Importing re-parses the report, recomputes every derived field, and returns
//! non-fatal [`ParsedReport::warnings`] for any inconsistency. The embedded
//! verdict and summary are never trusted.

mod model;
mod summary;
mod verdict;

use serde_json::json;

use crate::ai::wasm_bridge::Evaluation;
use crate::generator::SCENARIO_MANIFEST;
use crate::state::CorrectAction;
use crate::verdict as dual;

pub use model::{
    AiComparison, AppInfo, BuildReportRequest, DecisionPrompt, ParsedReport, ReportDecision,
    ReportReason, ReportVerdict, ReportedAction, ReportedAi, ScenarioReport, ScenarioSnapshot,
};
pub use verdict::evaluate as evaluate_book_answer;

/// Stable identifier for the report file format.
pub const REPORT_SCHEMA: &str = "riichiprac.scenario-report";

/// Current report schema version.
///
/// Version 2 adds the dual verdict (`outcome`, `mode`, `mortal`). Version 1
/// files still import: the new fields default and only the book fields are
/// compared, so an old report is not reported as tampered.
pub const REPORT_VERSION: u32 = 2;

/// Largest note (in characters) the exporter accepts.
pub const MAX_NOTE_CHARS: usize = 4000;

/// Largest report file (in bytes) the importer accepts.
pub const MAX_REPORT_BYTES: usize = 2 * 1024 * 1024;

/// Build a report from a request sent by the frontend.
pub fn build_report(request: BuildReportRequest) -> Result<ScenarioReport, String> {
    let note = normalize_note(request.note)?;
    let mut table = request.table;
    // Derived, so never trust a stale value from the request.
    table.book_rationale = crate::rationale::rationale_for(&table);
    table.can_riichi = crate::ai::actions::riichi_is_legal(&table);
    let grade = dual::grade_answer(
        &table,
        &request.answer,
        request.ai.as_ref().map(|ai| &ai.evaluation),
    );
    let report_verdict = ReportVerdict::from_dual(&grade, &table.correct_action);
    let scenario = scenario_snapshot(&table.category);
    let prompt = DecisionPrompt::from_target(table.target_action)
        .as_str()
        .to_string();

    let ai = request
        .ai
        .map(|ai| add_comparison(ai, &table.correct_action, &request.answer));

    let decision = ReportDecision {
        prompt,
        reason: request.reason,
        note,
        answer: request.answer,
        verdict: report_verdict.clone(),
    };

    let app = AppInfo {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        commit: request.commit.unwrap_or_else(|| "dev".to_string()),
        build_time: request.build_time.unwrap_or_default(),
    };

    let mut report = ScenarioReport::new(
        request.report_id,
        request.created_at,
        app,
        scenario,
        decision,
        table,
        ai,
    );
    report.human_readable = summary::render_lines(&report, &report_verdict);
    Ok(report)
}

/// Parse and validate an imported report, recomputing derived fields.
pub fn parse_report(json: &str) -> Result<ParsedReport, String> {
    let mut report: ScenarioReport =
        serde_json::from_str(json).map_err(|err| format!("Could not read report JSON: {err}"))?;

    validate_envelope(&report)?;

    if report.table.players.len() != 4 {
        return Err(format!(
            "Report table has {} players; expected 4.",
            report.table.players.len()
        ));
    }
    let human_count = report
        .table
        .players
        .iter()
        .filter(|player| player.is_human)
        .count();
    if human_count != 1 {
        return Err(format!(
            "Report table has {human_count} human players; expected exactly 1."
        ));
    }

    report.table.book_rationale = crate::rationale::rationale_for(&report.table);
    // Recomputed like every other derived field: an old or tampered report must
    // not be able to hand the UI an illegal Riichi affordance.
    report.table.can_riichi = crate::ai::actions::riichi_is_legal(&report.table);
    let grade = dual::grade_answer(
        &report.table,
        &report.decision.answer,
        report.ai.as_ref().map(|ai| &ai.evaluation),
    );
    let report_verdict = ReportVerdict::from_dual(&grade, &report.table.correct_action);
    let mut warnings = Vec::new();

    if !report.decision.verdict.book_matches(&report_verdict) {
        warnings.push(
            "The saved verdict disagrees with the recomputed verdict; showing the recomputed one."
                .to_string(),
        );
    }

    if !verdict::answer_tile_visible(&report.table, &report.decision.answer) {
        warnings.push(format!(
            "The reported answer tile {} is not in the human hand or draw.",
            report.decision.answer.tile
        ));
    }

    if report.scenario.id != report.table.category {
        warnings.push(format!(
            "Scenario id '{}' does not match the table category '{}'.",
            report.scenario.id, report.table.category
        ));
    }

    if let Some(ai) = &mut report.ai {
        ai.comparison = Some(make_comparison(
            &ai.evaluation,
            &report.table.correct_action,
            &report.decision.answer,
        ));
        warnings.extend(validate_ai(&ai.evaluation));
    }

    report.decision.verdict = report_verdict.clone();
    report.human_readable = summary::render_lines(&report, &report_verdict);

    Ok(ParsedReport {
        report,
        verdict: report_verdict,
        warnings,
    })
}

/// Build a report from a JSON request and return pretty-printed report JSON.
pub fn build_report_json(request_json: &str) -> Result<String, String> {
    let request: BuildReportRequest = serde_json::from_str(request_json)
        .map_err(|err| format!("Invalid report request: {err}"))?;
    let report = build_report(request)?;
    serde_json::to_string_pretty(&report)
        .map_err(|err| format!("Failed to serialize report: {err}"))
}

/// Parse report JSON and return the recomputed report as JSON.
pub fn parse_report_json(report_json: &str) -> Result<String, String> {
    if report_json.len() > MAX_REPORT_BYTES {
        return Err(format!(
            "Report is too large ({} bytes; maximum is {}).",
            report_json.len(),
            MAX_REPORT_BYTES
        ));
    }

    let parsed = parse_report(report_json)?;
    serde_json::to_string(&parsed)
        .map_err(|err| format!("Failed to serialize parsed report: {err}"))
}

/// Error payload used by the WASM wrappers.
pub fn error_json(message: &str) -> String {
    json!({ "error": message }).to_string()
}

fn validate_envelope(report: &ScenarioReport) -> Result<(), String> {
    if report.schema != REPORT_SCHEMA {
        return Err(format!(
            "Not a Riichi Trainer report (schema '{}'); expected '{}'.",
            report.schema, REPORT_SCHEMA
        ));
    }
    if report.version == 0 || report.version > REPORT_VERSION {
        return Err(format!(
            "Unsupported report version {}. This build supports version {}.",
            report.version, REPORT_VERSION
        ));
    }
    Ok(())
}

fn normalize_note(note: Option<String>) -> Result<Option<String>, String> {
    let Some(note) = note else {
        return Ok(None);
    };
    let trimmed = note.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().count() > MAX_NOTE_CHARS {
        return Err(format!(
            "Reporter note is too long ({} characters; maximum is {}).",
            trimmed.chars().count(),
            MAX_NOTE_CHARS
        ));
    }
    Ok(Some(trimmed.to_string()))
}

fn scenario_snapshot(category: &str) -> ScenarioSnapshot {
    SCENARIO_MANIFEST
        .iter()
        .find(|meta| meta.id.as_str() == category)
        .map(|meta| ScenarioSnapshot {
            id: meta.id.as_str().to_string(),
            label: meta.label.to_string(),
            description: meta.description.to_string(),
            category: meta.category.as_str().to_string(),
            tags: meta.tags.iter().map(|tag| (*tag).to_string()).collect(),
        })
        .unwrap_or_else(|| ScenarioSnapshot {
            id: category.to_string(),
            label: category.to_string(),
            description: String::new(),
            category: String::new(),
            tags: Vec::new(),
        })
}

fn add_comparison(
    mut ai: ReportedAi,
    expected: &CorrectAction,
    answer: &ReportedAction,
) -> ReportedAi {
    ai.comparison = Some(make_comparison(&ai.evaluation, expected, answer));
    ai
}

fn make_comparison(
    evaluation: &Evaluation,
    expected: &CorrectAction,
    answer: &ReportedAction,
) -> AiComparison {
    let app_action = mortal_action_for_correct(expected);
    let reporter_action = mortal_action_for_reported(answer);
    let app_probability = probability_for_action(evaluation, &app_action);
    let reporter_probability = probability_for_action(evaluation, &reporter_action);

    AiComparison {
        ai_agrees_with_app: dual::mortal_recommendation_matches(
            evaluation,
            &app_action,
            expected.tile().unwrap_or_default(),
        ),
        ai_agrees_with_reporter: dual::mortal_recommendation_matches(
            evaluation,
            &reporter_action,
            &answer.tile,
        ),
        app_action,
        app_probability,
        reporter_action,
        reporter_probability,
    }
}

pub use dual::mortal_action_for_answer as mortal_action_for_reported;
pub use dual::{mortal_action_for_correct, probability_for_action};

fn validate_ai(evaluation: &Evaluation) -> Vec<String> {
    let mut warnings = Vec::new();

    if !evaluation.expected_value.is_finite() {
        warnings.push(format!(
            "AI expected value is not finite ({}).",
            evaluation.expected_value
        ));
    }

    let mut total = 0.0;
    for action in &evaluation.evaluations {
        if !action.probability.is_finite() || !(0.0..=1.0).contains(&action.probability) {
            warnings.push(format!(
                "AI action {} has an invalid probability {}.",
                action.action, action.probability
            ));
        } else {
            total += action.probability;
        }
    }

    if !evaluation.evaluations.is_empty() && (total - 1.0).abs() > 1e-3 {
        warnings.push(format!("AI probabilities sum to {total:.4}, not 1.0."));
    }

    if evaluation.recommended_action.is_empty() {
        warnings.push("AI recommended action is empty.".to_string());
    } else if !evaluation
        .evaluations
        .iter()
        .any(|action| action.action == evaluation.recommended_action)
    {
        warnings.push(format!(
            "AI recommended action {} is missing from its evaluations.",
            evaluation.recommended_action
        ));
    }

    warnings
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::wasm_bridge::ActionEvaluation;
    use crate::fixtures::mock_table;
    use crate::state::{CorrectAction, CorrectActionType, GameState, MeldType, Wind};

    fn evaluation(actions: &[(&str, &str, f32)]) -> Evaluation {
        Evaluation {
            model: "test".to_string(),
            expected_value: 0.25,
            recommended_action: actions
                .first()
                .map(|(name, _, _)| (*name).to_string())
                .unwrap_or_default(),
            riichi_discard: None,
            evaluations: actions
                .iter()
                .map(|(name, kind, probability)| {
                    ActionEvaluation::from_parts(name, kind, None, *probability)
                })
                .collect(),
        }
    }

    fn request(table: GameState, answer: ReportedAction) -> BuildReportRequest {
        BuildReportRequest {
            table,
            answer,
            reason: ReportReason::ExpectedActionWrong,
            note: Some("  The app should have stayed dama.  ".to_string()),
            created_at: "2026-11-10T08:42:11.031Z".to_string(),
            report_id: "8b0e5c0e-4f1b-4f7e-9b3e-2a7c1d9e6f10".to_string(),
            commit: Some("d63f935".to_string()),
            build_time: Some("2026-11-10T08:00:00.000Z".to_string()),
            ai: None,
        }
    }

    fn fixture_report() -> ScenarioReport {
        let table = mock_table::generate("mock_table").expect("fixture must build");
        let tile = table
            .correct_action
            .tile()
            .expect("fixture answer tile")
            .to_string();
        build_report(request(
            table,
            ReportedAction::new(CorrectActionType::Dama, tile),
        ))
        .expect("report must build")
    }

    #[test]
    fn build_stamps_schema_version_scenario_and_verdict() {
        let report = fixture_report();

        assert_eq!(report.schema, REPORT_SCHEMA);
        assert_eq!(report.version, REPORT_VERSION);
        assert_eq!(report.scenario.id, "mock_table");
        assert_eq!(report.scenario.label, "mock_table");
        assert_eq!(report.app.app_version, env!("CARGO_PKG_VERSION"));
        assert_eq!(report.decision.prompt, "Declare Riichi, or stay dama?");
        assert!(!report.decision.verdict.is_correct);
        assert!(!report.decision.verdict.is_action_correct);
        assert!(report.decision.verdict.is_tile_correct);
        assert_eq!(
            report.decision.note.as_deref(),
            Some("The app should have stayed dama.")
        );
        assert!(!report.human_readable.is_empty());
    }

    #[test]
    fn report_json_round_trips_through_parse() {
        let report = fixture_report();
        let json = serde_json::to_string_pretty(&report).expect("report must serialize");

        let parsed = parse_report(&json).expect("report must parse");

        assert_eq!(parsed.report.table, report.table);
        assert_eq!(parsed.report.decision, report.decision);
        assert_eq!(parsed.verdict, report.decision.verdict);
        assert!(
            parsed.warnings.is_empty(),
            "warnings: {:?}",
            parsed.warnings
        );
        assert_eq!(parsed.report.human_readable, report.human_readable);
    }

    #[test]
    fn wrong_schema_is_rejected() {
        let mut report = fixture_report();
        report.schema = "something.else".to_string();

        let err = parse_report(&serde_json::to_string(&report).unwrap()).unwrap_err();

        assert!(err.contains("Not a Riichi Trainer report"));
    }

    #[test]
    fn future_version_is_rejected() {
        let mut report = fixture_report();
        report.version = REPORT_VERSION + 1;

        let err = parse_report(&serde_json::to_string(&report).unwrap()).unwrap_err();

        assert!(err.contains("Unsupported report version"));
    }

    #[test]
    fn tampered_verdict_warns_but_still_loads() {
        let mut report = fixture_report();
        report.decision.verdict.is_correct = true;
        report.decision.verdict.is_action_correct = true;

        let parsed = parse_report(&serde_json::to_string(&report).unwrap()).unwrap();

        assert!(!parsed.verdict.is_correct);
        assert!(
            parsed
                .warnings
                .iter()
                .any(|warning| warning.contains("saved verdict disagrees")),
            "warnings: {:?}",
            parsed.warnings
        );
    }

    #[test]
    fn answer_tile_missing_from_hand_warns_but_still_loads() {
        let table = mock_table::generate("mock_table").expect("fixture must build");
        let human = table
            .players
            .iter()
            .find(|player| player.is_human)
            .expect("fixture has a human");
        let all_tiles = (1..=9)
            .flat_map(|value| {
                [
                    format!("{value}m"),
                    format!("{value}p"),
                    format!("{value}s"),
                ]
            })
            .chain((1..=7).map(|value| format!("{value}z")));
        let missing = all_tiles
            .into_iter()
            .find(|tile| !human.hand.contains(tile) && human.draw.as_deref() != Some(tile.as_str()))
            .expect("a 14-tile hand cannot hold every tile");

        let mut report = build_report(request(
            table,
            ReportedAction::new(CorrectActionType::Dama, missing),
        ))
        .expect("report must build");
        report.decision.verdict.is_tile_correct = true;

        let parsed = parse_report(&serde_json::to_string(&report).unwrap()).unwrap();

        assert!(
            parsed
                .warnings
                .iter()
                .any(|warning| warning.contains("not in the human hand or draw")),
            "warnings: {:?}",
            parsed.warnings
        );
    }

    #[test]
    fn missing_players_are_rejected() {
        let mut report = fixture_report();
        report.table.players.pop();

        let err = parse_report(&serde_json::to_string(&report).unwrap()).unwrap_err();

        assert!(err.contains("expected 4"));
    }

    #[test]
    fn note_is_trimmed_and_optional() {
        let table = mock_table::generate("mock_table").expect("fixture must build");
        let tile = table
            .correct_action
            .tile()
            .expect("fixture answer tile")
            .to_string();

        let mut req = request(table, ReportedAction::new(CorrectActionType::Dama, tile));
        req.note = Some("   ".to_string());
        let report = build_report(req).expect("report must build");
        assert!(report.decision.note.is_none());

        let mut req = request(
            mock_table::generate("mock_table").unwrap(),
            ReportedAction::new(CorrectActionType::Dama, "1m"),
        );
        req.note = Some("x".repeat(MAX_NOTE_CHARS + 1));
        let err = build_report(req).unwrap_err();
        assert!(err.contains("too long"));
    }

    #[test]
    fn ai_comparison_aggregates_red_five_variants() {
        let table = mock_table::generate("mock_table").expect("fixture must build");
        let mut req = request(table, ReportedAction::new(CorrectActionType::Dama, "5m"));
        req.ai = Some(ReportedAi {
            model: "mortal_298k.safetensors".to_string(),
            evaluated_at: "2026-11-10T08:42:05.000Z".to_string(),
            evaluation: evaluation(&[
                ("Riichi", "riichi", 0.3),
                ("Discard_5m", "discard", 0.5),
                ("Discard_5mr", "discard", 0.2),
            ]),
            comparison: None,
            peeked_before_answer: false,
        });

        // Force the expected answer to be a 5m discard so the aggregation is
        // exercised regardless of the random fixture hand.
        let mut table = mock_table::generate("mock_table").unwrap();
        table.correct_action = CorrectAction::dama("5m");
        req.table = table;

        let report = build_report(req).expect("report must build");
        let comparison = report.ai.as_ref().unwrap().comparison.as_ref().unwrap();

        assert_eq!(comparison.app_action, "Discard_5m");
        assert!((comparison.app_probability - 0.7).abs() < 1e-6);
        assert_eq!(comparison.reporter_action, "Discard_5m");
        assert!(!comparison.ai_agrees_with_app);
    }

    #[test]
    fn valid_ai_snapshot_round_trips_and_recomputes_comparison() {
        let mut report = fixture_report();
        report.ai = Some(ReportedAi {
            model: "mortal_298k.safetensors".to_string(),
            evaluated_at: "2026-11-10T08:42:05.000Z".to_string(),
            evaluation: evaluation(&[("Discard_6m", "discard", 0.9), ("Riichi", "riichi", 0.1)]),
            comparison: None,
            peeked_before_answer: false,
        });

        let parsed = parse_report(&serde_json::to_string(&report).unwrap()).unwrap();

        assert!(
            parsed.warnings.is_empty(),
            "warnings: {:?}",
            parsed.warnings
        );
        let ai = parsed.report.ai.expect("AI snapshot must survive");
        let comparison = ai.comparison.expect("comparison must be recomputed");
        assert!(!comparison.app_action.is_empty());
        assert!(!comparison.reporter_action.is_empty());
    }

    #[test]
    fn invalid_ai_probabilities_warn_on_import() {
        let mut report = fixture_report();
        report.ai = Some(ReportedAi {
            model: "mortal_298k.safetensors".to_string(),
            evaluated_at: "2026-11-10T08:42:05.000Z".to_string(),
            evaluation: evaluation(&[("Discard_1m", "discard", 0.8), ("Riichi", "riichi", 0.5)]),
            comparison: None,
            peeked_before_answer: false,
        });

        let parsed = parse_report(&serde_json::to_string(&report).unwrap()).unwrap();

        assert!(
            parsed
                .warnings
                .iter()
                .any(|warning| warning.contains("sum to")),
            "warnings: {:?}",
            parsed.warnings
        );
    }

    #[test]
    fn drill_report_keeps_the_expected_tile_and_mode() {
        let mut table = mock_table::generate("mock_table").expect("fixture must build");
        table.correct_action = CorrectAction::best(
            "Riichi",
            Some("3p".to_string()),
            Vec::new(),
            "Riichi".to_string(),
        );

        let mut req = request(
            table,
            ReportedAction::new(CorrectActionType::Best, "3p").with_action_name("Riichi"),
        );
        req.ai = None;
        let report = build_report(req).expect("drill report must build");

        assert_eq!(
            report.decision.verdict.expected_action,
            CorrectActionType::Best
        );
        assert_eq!(report.decision.verdict.expected_tile, "3p");
        assert_eq!(
            report.decision.verdict.mode,
            crate::verdict::GradingMode::MortalOnly
        );
        assert_eq!(
            report.decision.verdict.outcome,
            crate::verdict::AnswerOutcome::OnlyAvailableAgrees
        );
        assert!(
            report.decision.verdict.is_correct,
            "a drill's is_correct is Mortal's answer"
        );
    }

    #[test]
    fn committed_v2_fixture_carries_the_dual_verdict() {
        let json = include_str!("../../tests/fixtures/scenario_report_v2.json");
        let parsed = parse_report(json).expect("v2 fixture must parse");

        assert_eq!(parsed.report.version, REPORT_VERSION);
        assert_eq!(parsed.verdict.mode, crate::verdict::GradingMode::BookOnly);
        assert_eq!(
            parsed.verdict.outcome,
            crate::verdict::AnswerOutcome::OnlyAvailableDisagrees
        );
        assert!(
            parsed.warnings.is_empty(),
            "warnings: {:?}",
            parsed.warnings
        );
        assert!(parsed.report.table.book_rationale.is_some());
        assert!(
            parsed
                .report
                .human_readable
                .join("\n")
                .contains("Book: DISAGREES")
        );
    }

    #[test]
    fn committed_fixture_parses_and_regenerates_summary() {
        let json = include_str!("../../tests/fixtures/scenario_report_v1.json");
        let parsed = parse_report(json).expect("fixture must parse");

        assert_eq!(parsed.report.schema, REPORT_SCHEMA);
        assert_eq!(parsed.report.scenario.id, "ryanmen_protorun");
        assert_eq!(
            parsed.report.decision.answer.action,
            CorrectActionType::Riichi
        );
        assert!(!parsed.verdict.is_action_correct);
        assert!(
            parsed
                .report
                .human_readable
                .join("\n")
                .contains("Ryanmen Protorun")
        );
        assert!(
            parsed.warnings.is_empty(),
            "warnings: {:?}",
            parsed.warnings
        );
    }

    #[test]
    fn malformed_json_returns_an_error() {
        let err = parse_report("{ not json").unwrap_err();
        assert!(err.contains("Could not read report JSON"));
    }

    #[test]
    fn build_and_parse_json_wrappers_round_trip() {
        let table = mock_table::generate("mock_table").expect("fixture must build");
        let tile = table
            .correct_action
            .tile()
            .expect("fixture answer tile")
            .to_string();
        let request_json = serde_json::to_string(&request(
            table,
            ReportedAction::new(CorrectActionType::Dama, tile),
        ))
        .unwrap();

        let report_json = build_report_json(&request_json).expect("build must succeed");
        let parsed_json = parse_report_json(&report_json).expect("parse must succeed");
        let parsed: ParsedReport = serde_json::from_str(&parsed_json).unwrap();

        assert_eq!(parsed.report.version, REPORT_VERSION);
        assert!(parsed.warnings.is_empty());
    }

    #[test]
    fn scenario_snapshot_uses_the_manifest_when_available() {
        let snapshot = scenario_snapshot("chiitoitsu_riichi_vs_dama");

        assert_eq!(snapshot.label, "Chiitoitsu Riichi vs Dama");
        assert_eq!(snapshot.category, "riichi_decision");
        assert!(snapshot.tags.contains(&"chiitoitsu".to_string()));
    }

    #[test]
    fn scenario_snapshot_falls_back_to_the_category() {
        let snapshot = scenario_snapshot("mock_table");

        assert_eq!(snapshot.id, "mock_table");
        assert_eq!(snapshot.label, "mock_table");
        assert!(snapshot.tags.is_empty());
    }

    #[test]
    fn table_type_helpers_are_exercised() {
        // Keep a compile-time reference to the public state re-exports used by
        // report consumers, and sanity-check a generated table's shape.
        let table = mock_table::generate("mock_table").unwrap();
        assert!(table.players.iter().any(|player| player.is_human));
        assert_eq!(table.round_wind, Wind::East);
        assert!(
            table
                .players
                .iter()
                .flat_map(|player| &player.melds)
                .all(|meld| matches!(
                    meld.meld_type,
                    MeldType::Chi | MeldType::Pon | MeldType::Kan | MeldType::Ankan
                ))
        );
    }
}
