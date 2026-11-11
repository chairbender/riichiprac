use wasm_bindgen_test::*;

wasm_bindgen_test_configure!(run_in_browser);

use agari::context::{GameContext, WinType, indicator_to_dora};
use agari::hand::{HandStructure, decompose_hand};
use agari::parse::{parse_hand, to_counts, validate_hand};
use agari::scoring::{ScoreLevel, calculate_score};
use agari::shanten::{calculate_shanten, calculate_ukeire};
use agari::tile::{Honor, Tile};
use agari::yaku::detect_yaku_with_context;
use riichiprac::generator::{format_hand_compact, generate_random_hand};
use riichiprac::{
    build_scenario_report, check_wasm_status, generate_puzzle, grade_answer_json,
    parse_scenario_report,
};

#[wasm_bindgen_test]
fn test_wasm_status() {
    let status = check_wasm_status();
    assert_eq!(status, "WASM module initialized successfully");
}

#[wasm_bindgen_test]
fn test_scenario_report_builds_and_parses_through_wasm() {
    let table: serde_json::Value = serde_json::from_str(&generate_puzzle("mock_table".to_string()))
        .expect("mock table must be valid JSON");
    let tile = table["correct_action"]["discard"]
        .as_str()
        .expect("mock table is a Riichi puzzle")
        .to_string();

    let request = serde_json::json!({
        "table": table,
        "answer": { "action": "dama", "tile": tile },
        "reason": "expected_action_wrong",
        "note": "Round-trip test",
        "created_at": "2026-11-10T08:42:11.031Z",
        "report_id": "test-report",
        "commit": "test-commit",
        "build_time": "2026-11-10T08:00:00.000Z"
    });

    let report_json = build_scenario_report(&request.to_string());
    let report: serde_json::Value =
        serde_json::from_str(&report_json).expect("build must return valid JSON");

    assert_eq!(report["schema"], "riichiprac.scenario-report");
    assert_eq!(report["version"], 2);
    assert_eq!(report["table"]["category"], "mock_table");
    assert_eq!(report["decision"]["verdict"]["is_correct"], false);
    assert_eq!(report["decision"]["verdict"]["is_action_correct"], false);
    assert_eq!(report["decision"]["verdict"]["is_tile_correct"], true);
    assert_eq!(report["decision"]["verdict"]["mode"], "book_only");
    assert_eq!(
        report["decision"]["verdict"]["outcome"],
        "only_available_disagrees"
    );
    assert_ne!(
        report["decision"]["verdict"]["outcome"], "neither_agrees",
        "a book-only miss must not be graded as wrong"
    );
    let summary = report["human_readable"]
        .as_array()
        .expect("summary lines")
        .iter()
        .filter_map(|line| line.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(summary.contains("Riichi Trainer scenario report"));

    let parsed_json = parse_scenario_report(&report_json);
    let parsed: serde_json::Value =
        serde_json::from_str(&parsed_json).expect("parse must return valid JSON");
    assert!(parsed.get("error").is_none(), "parse error: {parsed_json}");
    assert_eq!(parsed["report"]["table"], report["table"]);
    assert_eq!(parsed["verdict"]["is_correct"], false);
    assert!(
        parsed["warnings"]
            .as_array()
            .expect("warnings array")
            .is_empty(),
        "warnings: {parsed_json}"
    );
}

#[wasm_bindgen_test]
fn test_scenario_report_rejects_a_future_version() {
    let table: serde_json::Value = serde_json::from_str(&generate_puzzle("mock_table".to_string()))
        .expect("mock table must be valid JSON");
    let tile = table["correct_action"]["discard"]
        .as_str()
        .expect("mock table is a Riichi puzzle")
        .to_string();
    let request = serde_json::json!({
        "table": table,
        "answer": { "action": "dama", "tile": tile },
        "reason": "other",
        "created_at": "2026-11-10T08:42:11.031Z",
        "report_id": "test-report"
    });

    let mut report: serde_json::Value =
        serde_json::from_str(&build_scenario_report(&request.to_string()))
            .expect("build must return valid JSON");
    report["version"] = serde_json::json!(99);

    let parsed: serde_json::Value =
        serde_json::from_str(&parse_scenario_report(&report.to_string()))
            .expect("parse must return valid JSON");

    assert!(
        parsed["error"]
            .as_str()
            .expect("error string")
            .contains("Unsupported report version")
    );
}

#[wasm_bindgen_test]
fn test_list_scenarios_payload() {
    let json = riichiprac::list_scenarios();
    let parsed: serde_json::Value =
        serde_json::from_str(&json).expect("scenario manifest must be valid JSON");
    let scenarios = parsed
        .as_array()
        .expect("scenario manifest must be an array");

    // Manifest-derived so adding a lesson cannot leave this test stale.
    assert_eq!(
        scenarios.len(),
        riichiprac::generator::SCENARIO_MANIFEST.len()
    );
    assert!(scenarios.iter().all(|scenario| {
        scenario["id"].is_string()
            && scenario["label"].is_string()
            && scenario["description"].is_string()
            && scenario["category"].is_string()
            && scenario["tags"].is_array()
            && scenario["requires_ai"].is_boolean()
            && scenario["grading"].is_string()
    }));
    assert!(
        scenarios
            .iter()
            .any(|scenario| scenario["id"] == "ryanmen_protorun")
    );
    assert!(
        !scenarios
            .iter()
            .any(|scenario| scenario["id"] == "mock_table"),
        "fixtures must not appear in the lesson manifest"
    );
    assert!(
        scenarios
            .iter()
            .any(|scenario| scenario["id"] == "ai_best_action"
                && scenario["requires_ai"] == true
                && scenario["grading"] == "mortal_only"),
        "AI scenario must be listed, marked requires_ai, and graded by Mortal alone"
    );
    assert!(
        scenarios
            .iter()
            .any(|scenario| scenario["id"] == "ryanmen_protorun"
                && scenario["grading"] == "book_and_mortal"),
        "book lessons are graded by both perspectives"
    );
}

#[wasm_bindgen_test]
fn test_ai_scenario_requires_the_evaluator() {
    let json = generate_puzzle("ai_best_action".to_string());
    let parsed: serde_json::Value =
        serde_json::from_str(&json).expect("error payload must be valid JSON");
    assert!(
        parsed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("Mortal model"),
        "expected a model-required error, got {json}"
    );
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

fn honor_from_wind(wind: &str) -> Honor {
    match wind {
        "East" => Honor::East,
        "South" => Honor::South,
        "West" => Honor::West,
        "North" => Honor::North,
        other => panic!("unexpected wind {other}"),
    }
}

fn chiitoitsu_score_level(
    winning_tiles: &[Tile],
    wait: Tile,
    round_wind: &str,
    seat_wind: &str,
    dora_indicators: &[Tile],
    aka_count: u8,
) -> ScoreLevel {
    let counts = to_counts(winning_tiles);
    let structure = decompose_hand(&counts)
        .into_iter()
        .find(|structure| matches!(structure, HandStructure::Chiitoitsu { .. }))
        .expect("winning hand must be chiitoitsu");

    let context = GameContext::new(
        WinType::Ron,
        honor_from_wind(round_wind),
        honor_from_wind(seat_wind),
    )
    .with_winning_tile(wait)
    .with_dora(dora_indicators.to_vec())
    .with_aka(aka_count);

    let yaku = detect_yaku_with_context(&structure, &counts, &context);
    calculate_score(&structure, &yaku, &context).score_level
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

    let mut riichi_count = 0;

    for run in 0..100 {
        let json_output = generate_puzzle("chiitoitsu_riichi_vs_dama".to_string());
        let val: serde_json::Value = serde_json::from_str(&json_output)
            .unwrap_or_else(|err| panic!("run {run}: invalid JSON: {err}: {json_output}"));

        assert_eq!(val["category"], "chiitoitsu_riichi_vs_dama");

        // Dama payloads are covered by the dedicated 100-hand test below.
        if val["correct_action"]["type"].as_str() == Some("dama") {
            continue;
        }
        riichi_count += 1;

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
        assert!(val["dama_reasons"].as_array().unwrap().is_empty());
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

    assert!(riichi_count > 0, "no Riichi states were generated");
}

#[wasm_bindgen_test]
fn test_chiitoitsu_dama_100_hands() {
    let started = js_sys::Date::now();
    let mut dama_count = 0;
    let mut attempts = 0;

    while dama_count < 100 && attempts < 400 {
        attempts += 1;
        let json_output = generate_puzzle("chiitoitsu_riichi_vs_dama".to_string());
        let val: serde_json::Value = serde_json::from_str(&json_output)
            .unwrap_or_else(|err| panic!("attempt {attempts}: invalid JSON: {err}: {json_output}"));

        if val["correct_action"]["type"].as_str() != Some("dama") {
            continue;
        }
        dama_count += 1;

        assert_eq!(val["target_action"], "Dama");
        assert_eq!(val["correct_action"]["type"], "dama");
        assert!(val["riichi_triggers"].as_array().unwrap().is_empty());
        let dama_reasons: Vec<&str> = val["dama_reasons"]
            .as_array()
            .expect("dama_reasons array")
            .iter()
            .map(|reason| reason.as_str().expect("dama reason string"))
            .collect();
        assert_eq!(
            dama_reasons,
            vec![
                "not_dealer",
                "no_tanyao",
                "middle_wait",
                "no_red_five_wait",
                "no_suji_trap",
                "mangan",
            ]
        );

        let discard_code = val["correct_action"]["discard"]
            .as_str()
            .expect("dama action must have a discard");
        let human = &val["players"][0];
        assert_eq!(human["hand"].as_array().unwrap().len(), 13);
        assert_eq!(human["draw"], discard_code);
        assert_ne!(human["wind"], "East");
        let red_fives = human["red_fives"]
            .as_array()
            .expect("human red_fives array");
        assert!(red_fives.is_empty());

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
        assert_eq!(
            actual, expected,
            "hand {dama_count}: tiles must match hand + draw"
        );

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
        assert!(matches!(wait.value(), Some(4..=6)));
        assert_eq!(counts.get(&wait), Some(&1));
        assert_ne!(parse_single_tile(discard_code), wait);
        assert_eq!(calculate_shanten(&counts).shanten, 0);
        let ukeire = calculate_ukeire(&counts);
        assert_eq!(ukeire.tiles.len(), 1);
        assert_eq!(ukeire.tiles[0].tile, wait);

        assert!(
            counts
                .iter()
                .any(|(&tile, &count)| count == 2 && !tile.is_simple()),
            "hand {dama_count}: missing a terminal/honor pair"
        );

        let suji = suji_tiles(wait);
        for discard in human["discards"].as_array().unwrap() {
            let code = discard["tile"].as_str().unwrap();
            assert_ne!(code, wait_code);
            assert!(
                !suji.iter().any(|suji| suji.to_string() == code),
                "hand {dama_count}: river contains wait suji {code}"
            );
        }

        let dora_indicators = val["dora_indicators"]
            .as_array()
            .expect("dora indicators array");
        assert_eq!(dora_indicators.len(), 2);

        let parsed_indicators: Vec<Tile> = dora_indicators
            .iter()
            .map(|indicator| parse_single_tile(indicator.as_str().unwrap()))
            .collect();
        for &indicator in &parsed_indicators {
            assert_ne!(indicator_to_dora(indicator), wait);
        }

        let total_dora: usize = parsed_indicators
            .iter()
            .map(|&indicator| {
                let dora = indicator_to_dora(indicator);
                hand_tiles.iter().filter(|tile| **tile == dora).count()
            })
            .sum();
        assert_eq!(total_dora, 4, "hand {dama_count}: expected four dora");

        let mut winning = hand_tiles;
        winning.push(wait);
        let score_level = chiitoitsu_score_level(
            &winning,
            wait,
            val["round_wind"].as_str().expect("round wind"),
            human["wind"].as_str().expect("human wind"),
            &parsed_indicators,
            0,
        );
        assert!(
            score_level >= ScoreLevel::Mangan,
            "hand {dama_count}: dama score is {score_level:?}"
        );
    }

    assert_eq!(dama_count, 100, "did not generate 100 dama hands");
    assert!(attempts <= 400);

    let elapsed = js_sys::Date::now() - started;
    assert!(elapsed < 10_000.0, "100 dama hands took {elapsed}ms");
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
    for i in 0..50 {
        // 1. Generate 14-tile hand via 5-block theory
        let hand = generate_random_hand();
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
                !wait_tiles.contains(&tile),
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

    /// The protorun-priority payload: a 1-away hand with one block too many
    /// where only the closed wait may be broken.
    ///
    /// Riichi Book 1 ch3:205/ch3:230 — a side wait accepts twice as many tiles
    /// as a closed wait, so breaking the closed wait keeps both 8-tile waits.
    #[wasm_bindgen_test]
    fn test_protorun_priority_rejection_sampling_constraints() {
        for run in 0..25 {
            let json_output = generate_puzzle("protorun_priority".to_string());
            let val: serde_json::Value = serde_json::from_str(&json_output)
                .unwrap_or_else(|err| panic!("run {run}: invalid JSON: {err}: {json_output}"));

            assert_eq!(val["category"], "protorun_priority");
            assert_eq!(val["target_action"], "NaniKiru");
            assert_eq!(val["correct_action"]["type"], "dama");
            assert_eq!(val["riichi_sticks"], 0);
            assert_eq!(val["dora_indicators"].as_array().unwrap().len(), 1);
            assert_eq!(val["ura_dora_indicators"].as_array().unwrap().len(), 1);
            assert_eq!(val["tiles"].as_array().unwrap().len(), 14);
            assert_eq!(val["shanten"], 1);
            assert_eq!(val["is_agari"], false);
            assert_eq!(val["ukeire_tiles"].as_array().unwrap().len(), 4);
            assert_eq!(val["ukeire_total"], 16);

            let players = val["players"].as_array().expect("players array");
            assert_eq!(players.len(), 4);
            for opponent in &players[1..] {
                assert_eq!(opponent["is_riichi"], false);
                assert_eq!(opponent["melds"].as_array().unwrap().len(), 0);
                assert!(opponent["riichi_discard_index"].is_null());
            }

            // The human hand, the open Yakuhai Pon, and the drawn closed-wait tile.
            let human = &players[0];
            assert_eq!(human["hand"].as_array().unwrap().len(), 10);
            assert_eq!(human["melds"].as_array().unwrap().len(), 1);
            assert_eq!(human["melds"][0]["meld_type"], "Pon");
            let meld_tiles = human["melds"][0]["tiles"].as_array().unwrap();
            assert_eq!(meld_tiles.len(), 3);
            assert!(meld_tiles.iter().all(|tile| tile == &meld_tiles[0]));

            let answer = val["correct_action"]["discard"]
                .as_str()
                .expect("dama action must include a discard tile");
            assert_eq!(human["draw"], answer);

            // The other tile of the closed wait is graded as the same decision.
            let equivalents = val["equivalent_tiles"]
                .as_array()
                .expect("protorun priority must declare its twin tile");
            assert_eq!(equivalents.len(), 1);
            let equivalent = equivalents[0].as_str().expect("equivalent tile");
            assert_ne!(equivalent, answer);
            assert!(
                human["hand"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|tile| tile.as_str() == Some(equivalent)),
                "run {run}: the closed wait's other tile must be in hand"
            );

            // Full hand = concealed hand + draw + open meld.
            let mut expected: Vec<&str> = human["hand"]
                .as_array()
                .unwrap()
                .iter()
                .map(|tile| tile.as_str().unwrap())
                .collect();
            expected.push(answer);
            expected.extend(meld_tiles.iter().map(|tile| tile.as_str().unwrap()));
            expected.sort();
            let mut actual: Vec<&str> = val["tiles"]
                .as_array()
                .unwrap()
                .iter()
                .map(|tile| tile.as_str().unwrap())
                .collect();
            actual.sort();
            assert_eq!(actual, expected);

            // The dora is never one of the closed wait's tiles: the lesson is
            // about shape, not value.
            let indicator = parse_hand(val["dora_indicators"][0].as_str().unwrap())
                .expect("dora indicator parses")
                .remove(0);
            let dora = indicator_to_dora(indicator).to_string();
            assert_ne!(dora, answer);
            assert_ne!(dora, equivalent);

            // Answering with the twin tile grades as the book's answer.
            let request = serde_json::json!({
                "table": val,
                "answer": { "action": "dama", "tile": equivalent },
                "evaluation": serde_json::Value::Null,
            });
            let grade: serde_json::Value =
                serde_json::from_str(&riichiprac::grade_answer_json(&request.to_string()))
                    .expect("grade must be valid JSON");
            assert_eq!(
                grade["book"]["is_tile_correct"], true,
                "run {run}: the twin closed-wait tile must grade correct"
            );
            assert_eq!(grade["outcome"], "only_available_agrees");

            // Scores total 100,000.
            let total_score: i64 = players
                .iter()
                .map(|player| player["score"].as_i64().expect("score int"))
                .sum();
            assert_eq!(total_score, 100_000);
        }
    }

    #[wasm_bindgen_test]
    fn test_shouminkan_decision_payload() {
        for run in 0..50 {
            let json_output = generate_puzzle("shouminkan_decision".to_string());
            let val: serde_json::Value = serde_json::from_str(&json_output)
                .unwrap_or_else(|err| panic!("run {run}: invalid JSON: {err}: {json_output}"));

            assert_eq!(val["category"], "shouminkan_decision");
            assert_eq!(val["target_action"], "Kan");
            assert_eq!(val["correct_action"]["type"], "kan");
            assert!(
                val["correct_action"]["discard"].is_null(),
                "run {run}: Kan action must not include a discard field"
            );

            let kan_tile = val["correct_action"]["tile"]
                .as_str()
                .expect("Kan action must include the fourth tile");
            let triggers = val["shouminkan_triggers"]
                .as_array()
                .expect("shouminkan_triggers must be an array");
            assert!(
                !triggers.is_empty(),
                "run {run}: at least one trigger is required"
            );

            let human = &val["players"][0];
            assert_eq!(human["hand"].as_array().unwrap().len(), 10);
            assert_eq!(human["draw"], kan_tile);
            assert_eq!(human["melds"].as_array().unwrap().len(), 1);
            assert_eq!(human["melds"][0]["meld_type"], "Pon");
            let meld_tiles = human["melds"][0]["tiles"].as_array().unwrap();
            assert_eq!(meld_tiles.len(), 3);
            assert!(meld_tiles.iter().all(|tile| tile == kan_tile));
            assert!(
                !human["hand"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|tile| tile == kan_tile)
            );
            assert_eq!(val["tiles"].as_array().unwrap().len(), 14);

            let total_score: i64 = val["players"]
                .as_array()
                .unwrap()
                .iter()
                .map(|player| player["score"].as_i64().expect("score int"))
                .sum();
            assert_eq!(total_score, 100_000);
        }
    }
}

#[wasm_bindgen_test]
fn test_grade_answer_through_wasm() {
    let table: serde_json::Value = serde_json::from_str(&generate_puzzle("mock_table".to_string()))
        .expect("mock table must be valid JSON");
    let answer = if table["correct_action"]["type"] == "riichi" {
        serde_json::json!({
            "action": "riichi",
            "tile": table["correct_action"]["discard"],
        })
    } else {
        serde_json::json!({
            "action": "dama",
            "tile": table["correct_action"]["discard"],
        })
    };
    let request = serde_json::json!({
        "table": table,
        "answer": answer,
        "evaluation": serde_json::Value::Null,
    });

    let grade_json = grade_answer_json(&request.to_string());
    let grade: serde_json::Value =
        serde_json::from_str(&grade_json).expect("grade must return valid JSON");

    assert!(grade.get("error").is_none(), "grade error: {grade_json}");
    assert_eq!(grade["mode"], "book_only");
    assert_eq!(grade["outcome"], "only_available_agrees");
    assert_eq!(grade["book"]["is_action_correct"], true);
    assert!(grade["mortal"].is_null());
}
