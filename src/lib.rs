pub mod ai;
pub mod decision;
pub(crate) mod fixtures;
pub mod fuzz;
pub mod generator;
pub mod rationale;
pub mod report;
pub mod rng;
pub mod safety;
pub mod state;
pub mod verdict;

use wasm_bindgen::prelude::*;

pub use ai::WasmMortalEvaluator;
pub use decision::{ActionEvaluation, ActionInfo, ActionKind, AiDecision, KanKind};
pub use generator::{PuzzleResponse, generate_random_hand};
pub use rationale::{AbsentRule, BookRationale, BookRule, Citation};
pub use report::{
    AiComparison, AppInfo, DecisionPrompt, ParsedReport, ReportDecision, ReportReason,
    ReportVerdict, ReportedAction, ReportedAi, ScenarioReport, ScenarioSnapshot,
};
pub use safety::{SafetyFacts, SafetyRank, StuckRules, TileRead};
pub use state::{
    CalledMeld, CorrectAction, CorrectActionType, DamaReason, DecisionContext, DiscardTile,
    GameState, MeldType, PlayerState, RiichiTrigger, ShouminkanTrigger, TargetAction, Wind,
};
pub use verdict::{
    AnswerOutcome, BookGrade, DualGrade, GradingMode, MortalConfidence, MortalGrade,
    PerspectiveResult, SubmittedAnswer,
};

/// Verification helper for WASM module initialization.
#[wasm_bindgen]
pub fn check_wasm_status() -> String {
    "WASM module initialized successfully".to_string()
}

/// Returns the user-facing scenario catalogue as a JSON array.
#[wasm_bindgen]
pub fn list_scenarios() -> String {
    generator::list_scenarios_json()
}

/// Generates a randomized 14-tile Mahjong hand using 5-block theory,
/// evaluates it via the `agari` crate, and returns the serialized JSON string
/// of the full GameState (global state, 4 player states, rivers, melds, riichi).
#[wasm_bindgen]
pub fn generate_puzzle(category: String) -> String {
    match generator::generate_puzzle(&category) {
        Ok(state) => serde_json::to_string(&state).unwrap_or_else(|err| {
            format!("{{\"error\": \"Failed to serialize puzzle: {}\"}}", err)
        }),
        Err(err) => format!("{{\"error\": \"{}\"}}", err),
    }
}

/// Builds a versioned scenario report from a JSON request containing the
/// exact game state, the reporter's answer, and optional AI evaluation.
///
/// Returns pretty-printed report JSON, or `{"error": "..."}`.
#[wasm_bindgen]
pub fn build_scenario_report(request_json: &str) -> String {
    report::build_report_json(request_json).unwrap_or_else(|err| report::error_json(&err))
}

/// Grades a submitted answer against both the book heuristic and Mortal.
///
/// Request: `{"table": GameState, "answer": SubmittedAnswer, "evaluation": Evaluation|null}`.
/// Returns a `DualGrade` JSON object, or `{"error": "..."}`.
#[wasm_bindgen]
pub fn grade_answer_json(request_json: &str) -> String {
    verdict::grade_answer_json(request_json).unwrap_or_else(|err| report::error_json(&err))
}

/// Parses and validates an imported scenario report.
///
/// Returns `{"report": ..., "verdict": ..., "warnings": [...]}` with derived
/// fields recomputed, or `{"error": "..."}`.
#[wasm_bindgen]
pub fn parse_scenario_report(report_json: &str) -> String {
    report::parse_report_json(report_json).unwrap_or_else(|err| report::error_json(&err))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_check_wasm_status() {
        assert_eq!(check_wasm_status(), "WASM module initialized successfully");
    }

    #[test]
    fn test_correct_action_serializes_its_tagged_shape() {
        for (action, expected_type) in [
            (CorrectAction::riichi("4p"), "riichi"),
            (CorrectAction::dama("4p"), "dama"),
        ] {
            let json = serde_json::to_value(&action).expect("action must serialize");

            assert_eq!(json["type"], expected_type);
            assert_eq!(json["discard"], "4p");
            assert!(json.get("tile").is_none());
        }

        for (action, expected_type) in [
            (CorrectAction::kan("5p"), "kan"),
            (CorrectAction::discard("5p"), "discard"),
        ] {
            let json = serde_json::to_value(&action).expect("action must serialize");

            assert_eq!(json["type"], expected_type);
            assert_eq!(json["tile"], "5p");
            assert!(json.get("discard").is_none());
        }

        let best = CorrectAction::best(
            "Chi_Low",
            Some("4m".to_string()),
            vec!["5m".to_string(), "6m".to_string()],
            "Chi 5m 6m on 4m",
        );
        let json = serde_json::to_value(&best).expect("best action must serialize");
        assert_eq!(json["type"], "best");
        assert_eq!(json["action"], "Chi_Low");
        assert_eq!(json["tile"], "4m");
        assert_eq!(json["tiles"][0], "5m");
        assert_eq!(json["label"], "Chi 5m 6m on 4m");
    }

    #[test]
    fn decision_context_serializes_as_a_tagged_shape() {
        let json = serde_json::to_value(DecisionContext::ReactToDiscard {
            from: 3,
            tile: "4m".to_string(),
        })
        .expect("decision must serialize");
        assert_eq!(json["kind"], "react_to_discard");
        assert_eq!(json["from"], 3);
        assert_eq!(json["tile"], "4m");

        let json = serde_json::to_value(DecisionContext::SelfTurn).expect("decision");
        assert_eq!(json["kind"], "self_turn");
    }

    #[test]
    fn test_generate_puzzle_json() {
        let json_str = generate_puzzle("basic_test".to_string());
        let parsed: serde_json::Value =
            serde_json::from_str(&json_str).expect("Must return valid JSON");
        assert_eq!(parsed["category"], "basic_test");
        assert_eq!(
            parsed["tiles"]
                .as_array()
                .expect("tiles must be array")
                .len(),
            14
        );
        assert!(parsed.get("shanten").is_some());
        assert_eq!(parsed["players"].as_array().unwrap().len(), 4);

        let round_wind = parsed["round_wind"]
            .as_str()
            .expect("round_wind must be a string");
        let hand_number = parsed["hand_number"]
            .as_u64()
            .expect("hand_number must be an integer");
        match round_wind {
            "East" => assert!((1..=4).contains(&hand_number)),
            "South" => assert!((1..=2).contains(&hand_number)),
            other => panic!("round must be South 2 or earlier, got {other} {hand_number}"),
        }

        let human = &parsed["players"][0];
        assert_eq!(human["hand"].as_array().unwrap().len(), 10);
        assert_eq!(human["melds"][0]["meld_type"], "Pon");
        assert_eq!(human["melds"][0]["tiles"].as_array().unwrap().len(), 3);
        assert_eq!(parsed["target_action"], "NaniKiru");

        assert_eq!(parsed["correct_action"]["type"], "dama");
        let correct_tile = parsed["correct_action"]["discard"]
            .as_str()
            .expect("correct_action.discard must be a string");
        assert!(
            parsed["tiles"]
                .as_array()
                .unwrap()
                .iter()
                .any(|tile| tile.as_str() == Some(correct_tile)),
            "correct_action tile must be present in the human hand"
        );
        assert_eq!(human["draw"], correct_tile);
    }
}
