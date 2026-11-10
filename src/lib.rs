pub mod generator;
pub mod rng;

use wasm_bindgen::prelude::*;

pub use generator::{PuzzleResponse, ScenarioGenerator, generate_random_hand};

/// Verification helper for WASM module initialization.
#[wasm_bindgen]
pub fn check_wasm_status() -> String {
    "WASM module initialized successfully".to_string()
}

/// Generates a randomized 14-tile Mahjong hand using 5-block theory,
/// evaluates it via the `agari` crate, and returns the serialized JSON string.
#[wasm_bindgen]
pub fn generate_puzzle(category: String) -> String {
    let generator = ScenarioGenerator::new();
    match generator.generate_puzzle(&category) {
        Ok(puzzle) => serde_json::to_string(&puzzle).unwrap_or_else(|err| {
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
    fn test_generate_puzzle_json() {
        let json_str = generate_puzzle("basic_test".to_string());
        let parsed: serde_json::Value = serde_json::from_str(&json_str).expect("Must return valid JSON");
        assert_eq!(parsed["category"], "basic_test");
        assert_eq!(parsed["tiles"].as_array().expect("tiles must be array").len(), 14);
        assert!(parsed.get("shanten").is_some());
    }
}
