use wasm_bindgen_test::*;

wasm_bindgen_test_configure!(run_in_browser);

use agari::context::indicator_to_dora;
use agari::hand::decompose_hand;
use agari::parse::{parse_hand, to_counts, validate_hand};
use agari::shanten::{calculate_shanten, calculate_ukeire};
use agari::tile::Tile;
use riichiprac::generator::{ScenarioGenerator, format_hand_compact};
use riichiprac::{check_wasm_status, generate_puzzle};

#[wasm_bindgen_test]
fn test_wasm_status() {
    let status = check_wasm_status();
    assert_eq!(status, "WASM module initialized successfully");
}

fn parse_single_tile(code: &str) -> Tile {
    parse_hand(code).expect("tile code must parse").remove(0)
}

fn is_outside_456(tile: Tile) -> bool {
    match tile.value() {
        Some(value) => !(4..=6).contains(&value),
        None => true,
    }
}

fn suji_tiles(tile: Tile) -> Vec<Tile> {
    let (Some(suit), Some(value)) = (tile.suit(), tile.value()) else {
        return Vec::new();
    };

    let mut suji = Vec::new();
    if value > 3 {
        suji.push(Tile::suited(suit, value - 3));
    }
    if value + 3 <= 9 {
        suji.push(Tile::suited(suit, value + 3));
    }
    suji
}

#[wasm_bindgen_test]
fn test_chiitoitsu_riichi_vs_dama_payload() {
    const TRIGGERS: [&str; 6] = [
        "dealer",
        "tanyao",
        "red_five_wait",
        "suji_trap",
        "wait_outside_456",
        "score_below_mangan",
    ];

    for run in 0..100 {
        let json_output = generate_puzzle("chiitoitsu_riichi_vs_dama".to_string());
        let val: serde_json::Value = serde_json::from_str(&json_output)
            .unwrap_or_else(|err| panic!("run {run}: invalid JSON: {err}: {json_output}"));

        assert_eq!(val["category"], "chiitoitsu_riichi_vs_dama");
        assert_eq!(val["target_action"], "Riichi");
        assert_eq!(val["correct_action"]["type"], "riichi");

        let discard_code = val["correct_action"]["discard"]
            .as_str()
            .expect("riichi action must have a discard");
        let human = &val["players"][0];
        assert_eq!(human["hand"].as_array().unwrap().len(), 13);
        assert_eq!(human["draw"], discard_code);
        assert_eq!(human["melds"].as_array().unwrap().len(), 0);
        let red_fives = human["red_fives"]
            .as_array()
            .expect("human red_fives array");
        assert!(red_fives.len() <= 1);

        let triggers = val["riichi_triggers"]
            .as_array()
            .expect("riichi_triggers array");
        assert!(!triggers.is_empty(), "run {run}: no triggers applied");
        for trigger in triggers {
            let trigger = trigger.as_str().expect("trigger string");
            assert!(
                TRIGGERS.contains(&trigger),
                "run {run}: unknown trigger {trigger}"
            );
        }

        let mut expected: Vec<&str> = human["hand"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tile| tile.as_str().unwrap())
            .collect();
        expected.push(discard_code);
        expected.sort();
        let mut actual: Vec<&str> = val["tiles"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tile| tile.as_str().unwrap())
            .collect();
        actual.sort();
        assert_eq!(actual, expected, "run {run}: tiles must match hand + draw");

        let hand_tiles: Vec<Tile> = human["hand"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tile| parse_single_tile(tile.as_str().unwrap()))
            .collect();
        let counts = to_counts(&hand_tiles);
        assert_eq!(counts.len(), 7);
        assert_eq!(counts.values().filter(|&&count| count == 2).count(), 6);
        assert_eq!(counts.values().filter(|&&count| count == 1).count(), 1);

        let wait_code = val["ukeire_tiles"][0]
            .as_str()
            .expect("chiitoitsu wait tile");
        let wait = parse_single_tile(wait_code);
        assert_eq!(counts.get(&wait), Some(&1));
        assert_eq!(calculate_shanten(&counts).shanten, 0);
        let ukeire = calculate_ukeire(&counts);
        assert_eq!(ukeire.tiles.len(), 1);
        assert_eq!(ukeire.tiles[0].tile.to_string(), wait_code);
        assert_ne!(parse_single_tile(discard_code), wait);

        let indicator =
            parse_single_tile(val["dora_indicators"][0].as_str().expect("dora indicator"));
        assert_ne!(
            indicator_to_dora(indicator),
            wait,
            "run {run}: wait is the dora"
        );

        for discard in human["discards"].as_array().unwrap() {
            assert_ne!(discard["tile"].as_str(), Some(wait_code));
        }

        for trigger in triggers {
            match trigger.as_str().unwrap() {
                "dealer" => assert_eq!(human["wind"], "East", "run {run}"),
                "tanyao" => {
                    for (&tile, &count) in &counts {
                        if count == 2 || tile == wait {
                            assert!(tile.is_simple(), "run {run}: non-simple tile {tile}");
                        }
                    }
                }
                "red_five_wait" => {
                    assert_eq!(wait.value(), Some(5), "run {run}");
                    assert!(
                        red_fives
                            .iter()
                            .any(|tile| tile.as_str() == Some(wait_code)),
                        "run {run}: red five marker missing"
                    );
                }
                "suji_trap" => {
                    let suji: Vec<String> = suji_tiles(wait)
                        .iter()
                        .map(|tile| tile.to_string())
                        .collect();
                    assert!(
                        human["discards"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|discard| suji
                                .iter()
                                .any(|suji| { Some(suji.as_str()) == discard["tile"].as_str() })),
                        "run {run}: river is missing the suji"
                    );
                }
                "wait_outside_456" => assert!(is_outside_456(wait), "run {run}"),
                "score_below_mangan" => {
                    let dora = indicator_to_dora(indicator);
                    let regular = hand_tiles.iter().filter(|tile| **tile == dora).count();
                    assert!(
                        regular + red_fives.len() <= 1,
                        "run {run}: trigger claims at most one dora"
                    );
                }
                other => panic!("run {run}: unexpected trigger {other}"),
            }
        }
    }
}

#[wasm_bindgen_test]
fn test_payload_supports_riichi_and_dama_actions() {
    let ryanmen: serde_json::Value =
        serde_json::from_str(&generate_puzzle("ryanmen_protorun".to_string()))
            .expect("ryanmen payload must be valid JSON");
    assert_eq!(ryanmen["correct_action"]["type"], "dama");
    assert!(
        ryanmen["correct_action"]["discard"].is_string(),
        "dama action must include a discard tile"
    );

    let mock: serde_json::Value = serde_json::from_str(&generate_puzzle("mock_table".to_string()))
        .expect("mock payload must be valid JSON");
    assert_eq!(mock["correct_action"]["type"], "riichi");
    assert!(
        mock["correct_action"]["discard"].is_string(),
        "riichi action must include a discard tile"
    );
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

        assert_eq!(val["correct_action"]["type"], "dama");
        let correct_tile = val["correct_action"]["discard"]
            .as_str()
            .expect("correct_action.discard must be a string");
        assert!(
            tiles.iter().any(|tile| tile.as_str() == Some(correct_tile)),
            "correct_action tile must be present in the human hand"
        );

        // New scenario: one open Yakuhai meld plus 10 concealed tiles + draw.
        let human = &val["players"][0];
        assert_eq!(human["hand"].as_array().unwrap().len(), 10);
        assert_eq!(human["draw"], correct_tile);
        assert_eq!(human["melds"][0]["meld_type"], "Pon");
        assert_eq!(human["melds"][0]["tiles"].as_array().unwrap().len(), 3);
    }
}

#[wasm_bindgen_test]
fn test_ryanmen_rejection_sampling_constraints() {
    for run in 0..100 {
        let json_output = generate_puzzle("ryanmen_protorun".to_string());
        let val: serde_json::Value = serde_json::from_str(&json_output).unwrap_or_else(|err| {
            panic!("run {run}: generate_puzzle returned invalid JSON: {err}: {json_output}")
        });

        assert_eq!(val["category"], "ryanmen_protorun");
        assert_eq!(val["target_action"], "NaniKiru");
        assert_eq!(val["correct_action"]["type"], "dama");
        assert_eq!(val["riichi_sticks"], 0);
        assert_eq!(val["dora_indicators"].as_array().unwrap().len(), 1);
        assert_eq!(val["ura_dora_indicators"].as_array().unwrap().len(), 1);

        let round_wind = val["round_wind"].as_str().expect("round_wind string");
        let hand_number = val["hand_number"].as_u64().expect("hand_number int");
        match round_wind {
            "East" => assert!((1..=4).contains(&hand_number)),
            "South" => assert!((1..=2).contains(&hand_number)),
            other => panic!("run {run}: invalid round {other} {hand_number}"),
        }

        let players = val["players"].as_array().expect("players array");
        assert_eq!(players.len(), 4);

        // Threat constraint.
        for opponent in &players[1..] {
            assert_eq!(opponent["is_riichi"], false);
            assert_eq!(opponent["melds"].as_array().unwrap().len(), 0);
            assert!(opponent["riichi_discard_index"].is_null());
        }

        // Human hand and open Yakuhai.
        let human = &players[0];
        assert_eq!(human["hand"].as_array().unwrap().len(), 10);
        assert_eq!(human["melds"][0]["meld_type"], "Pon");
        assert_eq!(human["melds"][0]["tiles"].as_array().unwrap().len(), 3);
        assert_eq!(human["draw"], val["correct_action"]["discard"]);

        let discard_counts: Vec<usize> = players
            .iter()
            .map(|player| player["discards"].as_array().unwrap().len())
            .collect();
        assert!(
            discard_counts
                .iter()
                .all(|&count| count == discard_counts[0]),
            "run {run}: discard counts must line up: {discard_counts:?}"
        );
        assert!((1..=6).contains(&discard_counts[0]));

        // The two wait tiles.
        let wait_tiles: Vec<&str> = val["ukeire_tiles"]
            .as_array()
            .expect("ukeire_tiles array")
            .iter()
            .map(|tile| tile.as_str().expect("wait tile string"))
            .collect();
        assert_eq!(wait_tiles.len(), 2);

        // Furiten constraint.
        for discard in human["discards"].as_array().unwrap() {
            let tile = discard["tile"].as_str().unwrap();
            assert!(
                !wait_tiles.iter().any(|wait| *wait == tile),
                "run {run}: human river contains wait tile {tile}"
            );
        }

        // Wait chance constraint.
        let mut visible_wait_tiles = 0;
        for opponent in &players[1..] {
            for discard in opponent["discards"].as_array().unwrap() {
                if wait_tiles
                    .iter()
                    .any(|wait| *wait == discard["tile"].as_str().unwrap())
                {
                    visible_wait_tiles += 1;
                }
            }
        }
        for indicator in val["dora_indicators"].as_array().unwrap() {
            if wait_tiles
                .iter()
                .any(|wait| *wait == indicator.as_str().unwrap())
            {
                visible_wait_tiles += 1;
            }
        }
        assert!(
            visible_wait_tiles <= 2,
            "run {run}: {visible_wait_tiles} wait tiles visible"
        );

        // Value constraint: duplicate is not the dora.
        let indicator = parse_hand(val["dora_indicators"][0].as_str().unwrap())
            .expect("dora indicator parses")
            .remove(0);
        assert_ne!(
            indicator_to_dora(indicator).to_string(),
            val["correct_action"]["discard"].as_str().unwrap(),
            "run {run}: duplicate tile is the dora"
        );

        // Scores total 100,000.
        let total_score: i64 = players
            .iter()
            .map(|player| player["score"].as_i64().expect("score int"))
            .sum();
        assert_eq!(total_score, 100_000);

        // Full hand = concealed hand + draw + open meld.
        let mut expected: Vec<&str> = human["hand"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tile| tile.as_str().unwrap())
            .collect();
        expected.push(human["draw"].as_str().unwrap());
        expected.extend(
            human["melds"][0]["tiles"]
                .as_array()
                .unwrap()
                .iter()
                .map(|tile| tile.as_str().unwrap()),
        );
        expected.sort();
        let mut actual: Vec<&str> = val["tiles"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tile| tile.as_str().unwrap())
            .collect();
        actual.sort();
        assert_eq!(actual, expected);
    }
}
