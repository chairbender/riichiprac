use wasm_bindgen_test::*;

wasm_bindgen_test_configure!(run_in_browser);

use agari::hand::decompose_hand;
use agari::parse::{parse_hand, to_counts, validate_hand};
use agari::shanten::{calculate_shanten, calculate_ukeire};
use riichiprac::generator::{format_hand_compact, ScenarioGenerator};
use riichiprac::{check_wasm_status, generate_puzzle};

#[wasm_bindgen_test]
fn test_wasm_status() {
    let status = check_wasm_status();
    assert_eq!(status, "WASM module initialized successfully");
}

#[wasm_bindgen_test]
fn test_generate_50_random_hands_parsed_by_agari() {
    let generator = ScenarioGenerator::new();

    for i in 0..50 {
        // 1. Generate 14-tile hand via 5-block theory
        let hand = generator.generate_random_hand();
        assert_eq!(
            hand.len(),
            14,
            "Hand #{i} must contain exactly 14 tiles, got {}",
            hand.len()
        );

        // 2. Validate hand constraints with agari (14 tiles, max 4 of each tile)
        assert!(
            validate_hand(&hand).is_ok(),
            "Hand #{i} failed agari::parse::validate_hand"
        );

        // 3. Format hand as compact notation and verify agari can parse it
        let compact = format_hand_compact(&hand);
        assert!(
            !compact.is_empty(),
            "Hand #{i} produced an empty compact notation string"
        );

        let parsed = parse_hand(&compact).unwrap_or_else(|err| {
            panic!("Hand #{i} notation '{compact}' failed agari::parse::parse_hand: {err}")
        });
        assert_eq!(
            parsed.len(),
            14,
            "Hand #{i} parsed hand must have 14 tiles, got {}",
            parsed.len()
        );

        // 4. Evaluate with agari shanten, ukeire, and decomposition
        let counts = to_counts(&hand);
        let shanten_res = calculate_shanten(&counts);
        assert!(
            shanten_res.shanten >= -1,
            "Hand #{i} produced invalid shanten {}",
            shanten_res.shanten
        );

        let _ukeire = calculate_ukeire(&counts);
        let _decompositions = decompose_hand(&counts);
    }
}

#[wasm_bindgen_test]
fn test_generate_puzzle_wasm_api() {
    for _ in 0..5 {
        let json_output = generate_puzzle("standard_category".to_string());
        let val: serde_json::Value = serde_json::from_str(&json_output)
            .expect("generate_puzzle must return valid serialized JSON");

        assert_eq!(val["category"], "standard_category");

        let tiles = val["tiles"]
            .as_array()
            .expect("tiles field must be a JSON array");
        assert_eq!(tiles.len(), 14, "tiles array must contain 14 tiles");

        let hand_str = val["hand_string"]
            .as_str()
            .expect("hand_string must be a string");
        assert!(!hand_str.is_empty());

        let shanten = val["shanten"]
            .as_i64()
            .expect("shanten field must be an integer");
        assert!(shanten >= -1);

        assert!(val.get("is_agari").is_some());
        assert!(val.get("decompositions_count").is_some());
        assert!(val.get("ukeire_total").is_some());
        assert!(val.get("ukeire_tiles").is_some());
    }
}
