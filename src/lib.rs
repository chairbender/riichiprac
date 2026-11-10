pub mod generator;
pub mod rng;
pub mod state;

use wasm_bindgen::prelude::*;

pub use generator::{PuzzleResponse, ScenarioGenerator, generate_random_hand};
pub use state::{
    CalledMeld, CorrectAction, CorrectActionType, DiscardTile, GameState, MeldType, PlayerState,
    TargetAction, Wind,
};

/// Verification helper for WASM module initialization.
#[wasm_bindgen]
pub fn check_wasm_status() -> String {
    "WASM module initialized successfully".to_string()
}

/// Generates a randomized 14-tile Mahjong hand using 5-block theory,
/// evaluates it via the `agari` crate, and returns the serialized JSON string
/// of the full GameState (global state, 4 player states, rivers, melds, riichi).
#[wasm_bindgen]
pub fn generate_puzzle(category: String) -> String {
    let generator = ScenarioGenerator::new();
    match generator.generate_puzzle(&category) {
        Ok(state) => serde_json::to_string(&state).unwrap_or_else(|err| {
            format!("{{\"error\": \"Failed to serialize puzzle: {}\"}}", err)
        }),
        Err(err) => format!("{{\"error\": \"{}\"}}", err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_check_wasm_status() {
        assert_eq!(check_wasm_status(), "WASM module initialized successfully");
    }

    #[test]
    fn test_correct_action_serializes_type_and_discard() {
        for (action_type, expected_type) in [
            (CorrectActionType::Riichi, "riichi"),
            (CorrectActionType::Dama, "dama"),
        ] {
            let action = CorrectAction {
                action_type,
                discard: "4p".to_string(),
            };
            let json = serde_json::to_value(&action).expect("action must serialize");

            assert_eq!(json["type"], expected_type);
            assert_eq!(json["discard"], "4p");
            assert!(json.get("tile").is_none());
        }
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
