//! End-to-end checks for the `fold_to_riichi` lesson's answer carrier.
//!
//! The lesson answers with a plain fold discard (Riichi Book 1, ch. 8's
//! betaori), so grading, the human-readable report, and the report round trip
//! all have to name a fold without inventing any new vocabulary. These run on
//! the host target because the browser-target suite (`tests/wasm_tests.rs`)
//! cannot be executed without a wasm host.

use riichiprac::{
    build_scenario_report, generate_puzzle, grade_answer_json, parse_scenario_report,
};
use serde_json::json;

fn table() -> serde_json::Value {
    serde_json::from_str(&generate_puzzle("fold_to_riichi".to_string()))
        .expect("the fold payload must be valid JSON")
}

fn answer_of(table: &serde_json::Value) -> String {
    table["correct_action"]["discard"]
        .as_str()
        .expect("a fold answer names the discard")
        .to_string()
}

#[test]
fn the_fold_answer_grades_and_reports_as_a_discard() {
    for _ in 0..5 {
        let table = table();
        let answer = answer_of(&table);

        let grade: serde_json::Value = serde_json::from_str(&grade_answer_json(
            &json!({
                "table": table.clone(),
                "answer": { "action": "fold", "tile": answer },
                "evaluation": serde_json::Value::Null,
            })
            .to_string(),
        ))
        .expect("grade must return valid JSON");

        assert!(grade.get("error").is_none(), "grade error: {grade}");
        assert_eq!(grade["mode"], "book_only");
        assert_eq!(grade["outcome"], "only_available_agrees");
        assert_eq!(grade["book"]["is_action_correct"], true);
        assert_eq!(grade["book"]["is_tile_correct"], true);

        let report_request = json!({
            "table": table.clone(),
            "answer": { "action": "fold", "tile": answer },
            "reason": "expected_tile_wrong",
            "created_at": "2026-11-10T08:42:11.031Z",
            "report_id": "fold-to-riichi-report",
            "commit": "test-commit",
            "build_time": "2026-11-10T08:00:00.000Z"
        });
        let report_json = build_scenario_report(&report_request.to_string());
        let report: serde_json::Value =
            serde_json::from_str(&report_json).expect("report must be valid JSON");

        assert_eq!(report["table"]["correct_action"]["type"], "fold");
        assert_eq!(report["table"]["target_action"], "Defend");
        assert_eq!(report["decision"]["verdict"]["expected_action"], "fold");
        assert_eq!(report["decision"]["prompt"], "Which tile do you discard?");

        // The report text names the answer as a fold discard, never a Kan.
        let lines: Vec<&str> = report["human_readable"]
            .as_array()
            .expect("human-readable lines")
            .iter()
            .map(|line| line.as_str().expect("line"))
            .collect();
        let expected = format!("App expected: Fold, discarding the safest tile {answer}");
        assert!(lines.contains(&expected.as_str()), "{lines:?}");
        assert!(
            !lines.iter().any(|line| line.contains("Kan")),
            "a fold lesson must not mention a Kan: {lines:?}"
        );

        let parsed: serde_json::Value = serde_json::from_str(&parse_scenario_report(&report_json))
            .expect("parse must return valid JSON");
        assert!(parsed.get("error").is_none(), "parse error: {parsed}");
        assert_eq!(parsed["report"]["table"], report["table"]);
    }
}

#[test]
fn a_safe_tile_other_than_the_answer_is_not_accepted() {
    let table = table();
    let answer = answer_of(&table);
    let wrong = table["tiles"]
        .as_array()
        .expect("tiles")
        .iter()
        .map(|tile| tile.as_str().expect("tile code").to_string())
        .find(|tile| *tile != answer)
        .expect("a hand has more than one tile type");

    let grade: serde_json::Value = serde_json::from_str(&grade_answer_json(
        &json!({
            "table": table,
            "answer": { "action": "fold", "tile": wrong },
            "evaluation": serde_json::Value::Null,
        })
        .to_string(),
    ))
    .expect("grade must return valid JSON");

    assert_eq!(grade["book"]["is_action_correct"], true);
    assert_eq!(grade["book"]["is_tile_correct"], false);
}
