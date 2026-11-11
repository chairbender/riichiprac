use wasm_bindgen_test::*;

wasm_bindgen_test_configure!(run_in_browser);

use agari::context::{GameContext, WinType, indicator_to_dora};
use agari::hand::{HandStructure, decompose_hand};
use agari::parse::{parse_hand, to_counts, validate_hand};
use agari::scoring::{ScoreLevel, calculate_score};
use agari::shanten::{calculate_shanten, calculate_ukeire, calculate_ukeire_with_visible};
use agari::tile::{Honor, Tile};
use agari::yaku::detect_yaku_with_context;
use riichiprac::generator::{format_hand_compact, generate_random_hand};
use riichiprac::{
    build_scenario_report, check_wasm_status, export_tenhou6_json, generate_puzzle,
    grade_answer_json, parse_scenario_report,
};

#[wasm_bindgen_test]
fn test_wasm_status() {
    let status = check_wasm_status();
    assert_eq!(status, "WASM module initialized successfully");
}

#[wasm_bindgen_test]
fn test_export_tenhou6_writes_a_reviewer_log() {
    let state = generate_puzzle("riichi_judgement".to_string());
    let log = export_tenhou6_json(&state);
    let parsed: serde_json::Value = serde_json::from_str(&log).expect("the export must be JSON");

    assert_eq!(parsed["rule"]["disp"], "般南喰赤");
    assert_eq!(parsed["name"].as_array().expect("names").len(), 4);

    let kyoku = parsed["log"][0].as_array().expect("one kyoku");
    assert_eq!(kyoku[0].as_array().expect("meta").len(), 3, "kyoku meta");
    assert_eq!(kyoku[1].as_array().expect("scores").len(), 4, "scores");
    for seat in 0..4 {
        let base = 4 + seat * 3;
        assert_eq!(
            kyoku[base].as_array().expect("haipai").len(),
            13,
            "seat {seat} haipai"
        );
        assert!(kyoku[base + 1].is_array(), "seat {seat} takes");
        assert!(kyoku[base + 2].is_array(), "seat {seat} discards");
    }

    let error: serde_json::Value =
        serde_json::from_str(&export_tenhou6_json("{}")).expect("error payload is JSON");
    assert!(
        error["error"]
            .as_str()
            .expect("error string")
            .contains("invalid game state"),
        "{error}"
    );
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
    assert!(
        scenarios.iter().any(|scenario| {
            (scenario["id"] == "defense_safety_chart"
                || scenario["id"] == "defense_stuck_heuristic")
                && scenario["category"] == "defense_decision"
                && scenario["grading"] == "book_and_mortal"
                && scenario["requires_ai"] == false
        }),
        "the defense lessons are book-graded and need no model"
    );
    assert!(
        scenarios
            .iter()
            .filter(|scenario| scenario["category"] == "defense_decision")
            .count()
            >= 2,
        "both defense lessons must be listed"
    );
    assert!(
        scenarios.iter().any(|scenario| {
            scenario["id"] == "open_hand_defense"
                && scenario["category"] == "defense_decision"
                && scenario["grading"] == "book_and_mortal"
                && scenario["requires_ai"] == false
        }),
        "the open-hand chii lesson must be listed as a book lesson"
    );
    assert!(
        scenarios.iter().any(|scenario| {
            scenario["id"] == "meld_or_not"
                && scenario["category"] == "melding_decision"
                && scenario["grading"] == "book_and_mortal"
                && scenario["requires_ai"] == false
        }),
        "the cheap-and-slow call lesson must be listed as a book lesson"
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

/// Asserts the shape both chiitoitsu payloads share: the 13-tile pre-draw
/// hand is five pairs plus three lone tiles, and the drawn tile is the second
/// copy of one of them. Returns the hand, the drawn tile, and the 14-tile hand.
fn chiitoitsu_pre_draw_shape(
    val: &serde_json::Value,
    run_label: &str,
) -> (Vec<Tile>, Tile, Vec<Tile>) {
    let human = &val["players"][0];
    let hand_tiles: Vec<Tile> = human["hand"]
        .as_array()
        .expect("hand array")
        .iter()
        .map(|tile| parse_single_tile(tile.as_str().unwrap()))
        .collect();
    let draw = parse_single_tile(human["draw"].as_str().expect("draw tile"));

    let counts = to_counts(&hand_tiles);
    assert_eq!(counts.len(), 8, "{run_label}: distinct pre-draw tiles");
    assert_eq!(
        counts.values().filter(|&&count| count == 2).count(),
        5,
        "{run_label}: pre-draw pairs"
    );
    assert_eq!(
        counts.values().filter(|&&count| count == 1).count(),
        3,
        "{run_label}: pre-draw lone tiles"
    );
    assert_eq!(
        counts.get(&draw),
        Some(&1),
        "{run_label}: the draw pairs an existing lone tile"
    );
    assert_eq!(
        calculate_shanten(&counts).shanten,
        1,
        "{run_label}: pre-draw is 1-shanten"
    );

    let mut full = hand_tiles.clone();
    full.push(draw);
    let full_counts = to_counts(&full);
    assert_eq!(
        full_counts.get(&draw),
        Some(&2),
        "{run_label}: the draw completes a pair"
    );
    assert_eq!(
        full_counts.values().filter(|&&count| count == 2).count(),
        6,
        "{run_label}: post-draw pairs"
    );
    assert_eq!(
        full_counts.values().filter(|&&count| count == 1).count(),
        2,
        "{run_label}: post-draw lone tiles"
    );

    (hand_tiles, draw, full)
}

/// The accepted discard codes: the canonical answer plus any equivalent tile.
fn chiitoitsu_accepted_codes(val: &serde_json::Value) -> Vec<String> {
    let mut accepted = vec![
        val["correct_action"]["discard"]
            .as_str()
            .expect("chiitoitsu answer discard")
            .to_string(),
    ];
    // The red-five lesson serializes no `equivalent_tiles` field at all.
    if let Some(equivalents) = val["equivalent_tiles"].as_array() {
        accepted.extend(equivalents.iter().map(|tile| {
            tile.as_str()
                .expect("chiitoitsu equivalent tile")
                .to_string()
        }));
    }
    accepted
}

/// The two count-1 tiles in the 14-tile hand.
fn chiitoitsu_lone_tiles(full: &[Tile]) -> [Tile; 2] {
    let counts = to_counts(full);
    let lone: Vec<Tile> = counts
        .iter()
        .filter(|(_, count)| **count == 1)
        .map(|(&tile, _)| tile)
        .collect();
    assert_eq!(
        lone.len(),
        2,
        "post-draw chiitoitsu hand has two lone tiles"
    );
    [lone[0], lone[1]]
}

/// The waits the accepted discards can leave (the other lone tile).
fn chiitoitsu_accepted_waits(val: &serde_json::Value, full: &[Tile]) -> Vec<Tile> {
    let lone = chiitoitsu_lone_tiles(full);
    chiitoitsu_accepted_codes(val)
        .into_iter()
        .map(|code| {
            let discard = parse_single_tile(&code);
            lone.into_iter()
                .find(|&tile| tile != discard)
                .expect("a distinct twin lone tile")
        })
        .collect()
}

/// The 13-tile tenpai hand that keeps `wait_code` (the other lone tile is out).
fn chiitoitsu_tenpai(full: &[Tile], wait_code: &str) -> (Vec<Tile>, Tile) {
    let wait = parse_single_tile(wait_code);
    let other = chiitoitsu_lone_tiles(full)
        .into_iter()
        .find(|&tile| tile != wait)
        .expect("a distinct twin lone tile");
    let mut tenpai = full.to_vec();
    let index = tenpai
        .iter()
        .position(|tile| *tile == other)
        .expect("the twin discard is in the hand");
    tenpai.remove(index);
    (tenpai, wait)
}

/// The 14-tile winning hand completed on `wait_code`.
fn chiitoitsu_winning(full: &[Tile], wait_code: &str) -> Vec<Tile> {
    let (tenpai, wait) = chiitoitsu_tenpai(full, wait_code);
    let mut winning = tenpai;
    winning.push(wait);
    winning
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
    let mut red_five_count = 0;

    for run in 0..120 {
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
        assert_eq!(
            val["can_riichi"], true,
            "run {run}: a book Riichi answer must be an offerable declaration"
        );

        let human = &val["players"][0];
        assert_eq!(human["hand"].as_array().unwrap().len(), 13);
        assert_eq!(human["melds"].as_array().unwrap().len(), 0);
        let red_fives = human["red_fives"]
            .as_array()
            .expect("human red_fives array");
        assert!(red_fives.len() <= 1, "run {run}");

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

        let (_hand_tiles, _draw, full) = chiitoitsu_pre_draw_shape(&val, &format!("run {run}"));

        let mut expected: Vec<&str> = human["hand"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tile| tile.as_str().unwrap())
            .collect();
        expected.push(human["draw"].as_str().unwrap());
        expected.sort();
        let mut actual: Vec<&str> = val["tiles"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tile| tile.as_str().unwrap())
            .collect();
        actual.sort();
        assert_eq!(actual, expected, "run {run}: tiles must match hand + draw");

        let accepted = chiitoitsu_accepted_codes(&val);
        let waits = chiitoitsu_accepted_waits(&val, &full);
        let red_five_lesson = triggers.len() == 1 && triggers[0].as_str() == Some("red_five_wait");
        if red_five_lesson {
            red_five_count += 1;
            assert_eq!(accepted.len(), 1, "run {run}: red five is single answer");
            assert_eq!(waits.len(), 1, "run {run}");
            assert_eq!(red_fives.len(), 1, "run {run}: one red five");
            assert_eq!(
                red_fives[0].as_str(),
                Some(waits[0].to_string().as_str()),
                "run {run}: the kept wait is the red five"
            );
        } else {
            assert_eq!(accepted.len(), 2, "run {run}: the twin answer");
            assert_eq!(waits.len(), 2, "run {run}");
            assert_ne!(accepted[0], accepted[1], "run {run}");
            assert_eq!(red_fives.len(), 0, "run {run}");
        }

        // The drawn tile is the pair-completing tile, never the discard.
        assert!(
            !accepted
                .iter()
                .any(|code| code == human["draw"].as_str().unwrap()),
            "run {run}: the draw must not be the answer tile"
        );

        // The state's canonical wait follows the canonical discard.
        let wait_code = val["ukeire_tiles"][0]
            .as_str()
            .expect("chiitoitsu wait tile");
        assert!(
            waits.iter().any(|wait| wait.to_string() == wait_code),
            "run {run}: ukeire must name an accepted wait"
        );

        let indicators: Vec<Tile> = val["dora_indicators"]
            .as_array()
            .expect("dora indicators array")
            .iter()
            .map(|indicator| parse_single_tile(indicator.as_str().unwrap()))
            .collect();
        assert_eq!(indicators.len(), 1, "run {run}");

        for wait in &waits {
            let wait_code = wait.to_string();
            let (tenpai, wait) = chiitoitsu_tenpai(&full, &wait_code);
            let counts = to_counts(&tenpai);
            assert_eq!(calculate_shanten(&counts).shanten, 0, "run {run}");
            let ukeire = calculate_ukeire(&counts);
            assert_eq!(ukeire.tiles.len(), 1, "run {run}");
            assert_eq!(ukeire.tiles[0].tile, wait, "run {run}");

            // No accepted wait is the dora, and none is in the human river.
            for &indicator in &indicators {
                assert_ne!(indicator_to_dora(indicator), wait, "run {run}");
            }
            for discard in human["discards"].as_array().unwrap() {
                assert_ne!(discard["tile"].as_str(), Some(wait_code.as_str()));
            }

            let winning = chiitoitsu_winning(&full, &wait_code);
            let winning_counts = to_counts(&winning);

            for trigger in triggers {
                match trigger.as_str().unwrap() {
                    "dealer" => assert_eq!(human["wind"], "East", "run {run}"),
                    "tanyao" => {
                        for (&tile, &count) in &winning_counts {
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
                                .any(|tile| tile.as_str() == Some(wait_code.as_str())),
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
                                .any(|discard| suji.iter().any(|suji| {
                                    Some(suji.as_str()) == discard["tile"].as_str()
                                })),
                            "run {run}: river is missing the suji"
                        );
                    }
                    "wait_outside_456" => assert!(is_outside_456(wait), "run {run}"),
                    "score_below_mangan" => {
                        let dora = indicator_to_dora(indicators[0]);
                        let regular = winning.iter().filter(|tile| **tile == dora).count();
                        let aka = red_fives
                            .iter()
                            .filter(|code| {
                                winning
                                    .iter()
                                    .any(|tile| tile.to_string() == code.as_str().unwrap())
                            })
                            .count();
                        assert!(
                            regular + aka <= 1,
                            "run {run}: trigger claims at most one dora"
                        );
                    }
                    other => panic!("run {run}: unexpected trigger {other}"),
                }
            }
        }
    }

    assert!(riichi_count > 0, "no Riichi states were generated");
    assert!(
        red_five_count > 0,
        "no single-red-five states were generated"
    );
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

        let human = &val["players"][0];
        assert_eq!(human["hand"].as_array().unwrap().len(), 13);
        assert_ne!(human["wind"], "East");
        let red_fives = human["red_fives"]
            .as_array()
            .expect("human red_fives array");
        assert!(red_fives.is_empty());

        let (_hand_tiles, _draw, full) =
            chiitoitsu_pre_draw_shape(&val, &format!("hand {dama_count}"));
        let accepted = chiitoitsu_accepted_codes(&val);
        let waits = chiitoitsu_accepted_waits(&val, &full);
        assert_eq!(accepted.len(), 2, "hand {dama_count}: the dama twin answer");
        assert_eq!(waits.len(), 2, "hand {dama_count}");
        assert_ne!(accepted[0], accepted[1], "hand {dama_count}");
        assert!(
            !accepted
                .iter()
                .any(|code| code == human["draw"].as_str().unwrap()),
            "hand {dama_count}: the draw must not be the answer tile"
        );

        let mut expected: Vec<&str> = human["hand"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tile| tile.as_str().unwrap())
            .collect();
        expected.push(human["draw"].as_str().unwrap());
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

        let full_counts = to_counts(&full);
        assert!(
            full_counts
                .iter()
                .any(|(&tile, &count)| count == 2 && !tile.is_simple()),
            "hand {dama_count}: missing a terminal/honor pair"
        );

        let dora_indicators = val["dora_indicators"]
            .as_array()
            .expect("dora indicators array");
        assert_eq!(dora_indicators.len(), 2);
        let parsed_indicators: Vec<Tile> = dora_indicators
            .iter()
            .map(|indicator| parse_single_tile(indicator.as_str().unwrap()))
            .collect();

        for wait in &waits {
            let wait_code = wait.to_string();
            let (tenpai, wait) = chiitoitsu_tenpai(&full, &wait_code);
            assert!(matches!(wait.value(), Some(4..=6)));
            let counts = to_counts(&tenpai);
            assert_eq!(calculate_shanten(&counts).shanten, 0);
            let ukeire = calculate_ukeire(&counts);
            assert_eq!(ukeire.tiles.len(), 1);
            assert_eq!(ukeire.tiles[0].tile, wait);

            let suji = suji_tiles(wait);
            for discard in human["discards"].as_array().unwrap() {
                let code = discard["tile"].as_str().unwrap();
                assert_ne!(code, wait_code.as_str());
                assert!(
                    !suji.iter().any(|suji| suji.to_string() == code),
                    "hand {dama_count}: river contains wait suji {code}"
                );
            }

            let winning = chiitoitsu_winning(&full, &wait_code);
            let total_dora: usize = parsed_indicators
                .iter()
                .map(|&indicator| {
                    let dora = indicator_to_dora(indicator);
                    winning.iter().filter(|tile| **tile == dora).count()
                })
                .sum();
            assert_eq!(total_dora, 4, "hand {dama_count}: expected four dora");

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
    }

    assert_eq!(dama_count, 100, "did not generate 100 dama hands");
    assert!(attempts <= 400);

    let elapsed = js_sys::Date::now() - started;
    assert!(elapsed < 10_000.0, "100 dama hands took {elapsed}ms");
}

/// The 13-tile tenpai hand the player keeps, read back off a Riichi/dama
/// payload.
///
/// The answer is discarded from the hand (tedashi), never off the draw: a
/// tsumogiri answer would mean the hand was already tenpai on an earlier turn,
/// so Riichi was available then and the table implies a decision the lesson
/// does not ask about. The draw must be the tile that reaches tenpai.
fn kept_hand_after_a_tedashi(val: &serde_json::Value, run: usize) -> Vec<Tile> {
    let human = &val["players"][0];
    assert_eq!(human["hand"].as_array().unwrap().len(), 13);
    let discard_code = val["correct_action"]["discard"]
        .as_str()
        .expect("a riichi/dama action must name the discard");
    let draw_code = human["draw"].as_str().expect("the human has a draw");
    assert_ne!(
        draw_code, discard_code,
        "run {run}: the answer must be tedashi"
    );

    let pre_draw: Vec<Tile> = human["hand"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tile| parse_single_tile(tile.as_str().unwrap()))
        .collect();
    assert!(
        pre_draw.iter().any(|tile| tile.to_string() == discard_code),
        "run {run}: the answer must be a hand tile"
    );
    assert_eq!(
        calculate_shanten(&to_counts(&pre_draw)).shanten,
        1,
        "run {run}: the pre-draw hand must be 1-shanten"
    );

    let draw = parse_single_tile(draw_code);
    let mut full = pre_draw;
    full.push(draw);
    assert_eq!(
        calculate_shanten(&to_counts(&full)).shanten,
        0,
        "run {run}: the draw must reach tenpai"
    );

    let discard = parse_single_tile(discard_code);
    let answer_index = full
        .iter()
        .position(|tile| *tile == discard)
        .expect("the answer is in the hand");
    let mut tenpai = full;
    tenpai.remove(answer_index);
    assert!(
        tenpai.contains(&draw),
        "run {run}: the draw must stay in the tenpai hand"
    );
    tenpai
}

/// Han without riichi for one standard winning hand, at its best yaku reading.
fn standard_han_without_riichi(
    winning_tiles: &[Tile],
    wait: Tile,
    round_wind: &str,
    seat_wind: &str,
    dora_indicators: &[Tile],
) -> u8 {
    let counts = to_counts(winning_tiles);
    let context = GameContext::new(
        WinType::Ron,
        honor_from_wind(round_wind),
        honor_from_wind(seat_wind),
    )
    .with_winning_tile(wait)
    .with_dora(dora_indicators.to_vec());

    decompose_hand(&counts)
        .iter()
        .filter(|structure| matches!(structure, HandStructure::Standard { .. }))
        .map(|structure| {
            detect_yaku_with_context(structure, &counts, &context).total_han_with_dora()
        })
        .max()
        .unwrap_or(0)
}

/// Best ron value of one standard winning hand without Riichi, in points.
fn standard_ron_points(
    winning_tiles: &[Tile],
    wait: Tile,
    round_wind: &str,
    seat_wind: &str,
    dora_indicators: &[Tile],
    aka_count: u8,
) -> Option<u32> {
    let counts = to_counts(winning_tiles);
    let context = GameContext::new(
        WinType::Ron,
        honor_from_wind(round_wind),
        honor_from_wind(seat_wind),
    )
    .with_winning_tile(wait)
    .with_dora(dora_indicators.to_vec())
    .with_aka(aka_count);

    decompose_hand(&counts)
        .iter()
        .filter(|structure| matches!(structure, HandStructure::Standard { .. }))
        .filter_map(|structure| {
            let yaku = detect_yaku_with_context(structure, &counts, &context);
            if yaku.yaku_list.is_empty() {
                return None;
            }
            Some(calculate_score(structure, &yaku, &context).payment.total)
        })
        .max()
}

/// Riichi Book 1, ch. 7: "Choose riichi over dama if at least one of the
/// following three conditions is met" — a han, a good wait, or the deal.
#[wasm_bindgen_test]
fn test_riichi_judgement_payload_follows_the_three_conditions() {
    let mut riichi_count = 0;
    let mut dama_count = 0;

    for run in 0..80 {
        let json_output = generate_puzzle("riichi_judgement".to_string());
        let val: serde_json::Value = serde_json::from_str(&json_output)
            .unwrap_or_else(|err| panic!("run {run}: invalid JSON: {err}: {json_output}"));
        assert_eq!(val["category"], "riichi_judgement");

        let human = &val["players"][0];
        assert_eq!(human["hand"].as_array().unwrap().len(), 13);
        assert!(human["melds"].as_array().unwrap().is_empty());
        assert_eq!(human["is_riichi"], false);
        let discard_code = val["correct_action"]["discard"]
            .as_str()
            .expect("riichi/dama action must have a discard");
        let tenpai = kept_hand_after_a_tedashi(&val, run);
        assert!(!tenpai.iter().any(|tile| tile.to_string() == discard_code));
        let counts = to_counts(&tenpai);
        assert_eq!(calculate_shanten(&counts).shanten, 0, "run {run}");
        let waits: Vec<Tile> = val["ukeire_tiles"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tile| parse_single_tile(tile.as_str().unwrap()))
            .collect();
        assert!(matches!(waits.len(), 1 | 2), "run {run}: waits {waits:?}");
        assert_eq!(calculate_ukeire(&counts).tiles.len(), waits.len());

        let dora: Vec<Tile> = val["dora_indicators"]
            .as_array()
            .unwrap()
            .iter()
            .map(|indicator| parse_single_tile(indicator.as_str().unwrap()))
            .collect();
        let round_wind = val["round_wind"].as_str().expect("round wind");
        let seat_wind = human["wind"].as_str().expect("human wind");

        // Condition 1: at least one han (yaku or dora) without riichi, and it
        // must hold on the worst winning tile.
        let extra_han = waits
            .iter()
            .map(|&wait| {
                let mut winning = tenpai.clone();
                winning.push(wait);
                standard_han_without_riichi(&winning, wait, round_wind, seat_wind, &dora)
            })
            .min()
            .unwrap_or(0)
            >= 1;

        // Condition 2: at least two kinds and more than four live tiles.
        let mut visible: std::collections::HashMap<Tile, u8> = std::collections::HashMap::new();
        for opponent in val["players"].as_array().unwrap().iter().skip(1) {
            for discard in opponent["discards"].as_array().unwrap() {
                *visible
                    .entry(parse_single_tile(discard["tile"].as_str().unwrap()))
                    .or_insert(0) += 1;
            }
        }
        for &indicator in &dora {
            *visible.entry(indicator).or_insert(0) += 1;
        }
        let ukeire = calculate_ukeire_with_visible(&counts, &visible);
        let good_wait = ukeire.tiles.len() >= 2 && ukeire.total_count > 4;
        assert!(
            ukeire.total_count >= 3,
            "run {run}: the book's 1-2 tile dama case is a different lesson"
        );

        // Condition 3: the dealer.
        let dealer = seat_wind == "East";
        let expected_riichi = extra_han || good_wait || dealer;

        // The hand is never furiten.
        for discard in human["discards"].as_array().unwrap() {
            let code = discard["tile"].as_str().unwrap();
            assert!(
                !waits.iter().any(|wait| wait.to_string() == code),
                "run {run}: human river contains furiten tile {code}"
            );
        }

        let mut expected_triggers = Vec::new();
        if extra_han {
            expected_triggers.push("has_extra_han");
        }
        if good_wait {
            expected_triggers.push("good_wait");
        }
        if dealer {
            expected_triggers.push("dealer");
        }

        if expected_riichi {
            riichi_count += 1;
            assert_eq!(val["target_action"], "Riichi");
            assert_eq!(val["correct_action"]["type"], "riichi");
            let triggers: Vec<&str> = val["riichi_triggers"]
                .as_array()
                .unwrap()
                .iter()
                .map(|trigger| trigger.as_str().unwrap())
                .collect();
            assert_eq!(triggers, expected_triggers, "run {run}");
            assert!(val["dama_reasons"].as_array().unwrap().is_empty());
        } else {
            dama_count += 1;
            assert_eq!(val["target_action"], "Dama");
            assert_eq!(val["correct_action"]["type"], "dama");
            assert!(val["riichi_triggers"].as_array().unwrap().is_empty());
            let reasons: Vec<&str> = val["dama_reasons"]
                .as_array()
                .unwrap()
                .iter()
                .map(|reason| reason.as_str().unwrap())
                .collect();
            assert_eq!(
                reasons,
                vec!["not_dealer", "bad_wait", "no_extra_han"],
                "run {run}"
            );
        }
    }

    assert!(riichi_count > 0, "no Riichi states were generated");
    assert!(dama_count > 0, "no dama states were generated");
}

/// Riichi Book 1, ch. 7, "Bad wait": call riichi with three or more live
/// winning tiles, dama with one or two live simple ones, and riichi on an
/// honor/terminal wait even with one tile left.
#[wasm_bindgen_test]
fn test_dama_bad_wait_payload_follows_the_live_tile_box() {
    let mut dama_count = 0;
    let mut many_live_count = 0;
    let mut honor_terminal_count = 0;

    for run in 0..80 {
        let json_output = generate_puzzle("dama_bad_wait".to_string());
        let val: serde_json::Value = serde_json::from_str(&json_output)
            .unwrap_or_else(|err| panic!("run {run}: invalid JSON: {err}: {json_output}"));
        assert_eq!(val["category"], "dama_bad_wait");

        let human = &val["players"][0];
        assert_eq!(human["hand"].as_array().unwrap().len(), 13);
        assert!(human["melds"].as_array().unwrap().is_empty());
        assert_eq!(human["is_riichi"], false);
        let tenpai = kept_hand_after_a_tedashi(&val, run);
        let counts = to_counts(&tenpai);
        assert_eq!(calculate_shanten(&counts).shanten, 0, "run {run}");

        let waits: Vec<Tile> = val["ukeire_tiles"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tile| parse_single_tile(tile.as_str().unwrap()))
            .collect();
        assert!(
            matches!(waits.len(), 1 | 2),
            "run {run}: a bad wait has one or two kinds"
        );
        let wait = waits[0];

        let dora: Vec<Tile> = val["dora_indicators"]
            .as_array()
            .unwrap()
            .iter()
            .map(|indicator| parse_single_tile(indicator.as_str().unwrap()))
            .collect();

        // Live winning tiles: the hand plus everything on the table.
        let mut visible: std::collections::HashMap<Tile, u8> = std::collections::HashMap::new();
        for opponent in val["players"].as_array().unwrap().iter().skip(1) {
            for discard in opponent["discards"].as_array().unwrap() {
                *visible
                    .entry(parse_single_tile(discard["tile"].as_str().unwrap()))
                    .or_insert(0) += 1;
            }
        }
        for &indicator in &dora {
            *visible.entry(indicator).or_insert(0) += 1;
        }
        let ukeire = calculate_ukeire_with_visible(&counts, &visible);
        let live_kinds = ukeire
            .tiles
            .iter()
            .filter(|entry| entry.available > 0)
            .count();
        assert!((1..=2).contains(&live_kinds), "run {run}");
        let live = ukeire.total_count;
        assert!((1..=4).contains(&live), "run {run}: live {live}");

        // The general ch7.1 rule must find none of its three conditions.
        let round_wind = val["round_wind"].as_str().expect("round wind");
        let seat_wind = human["wind"].as_str().expect("human wind");
        assert_ne!(
            seat_wind, "East",
            "run {run}: this lesson is non-dealer only"
        );
        for &waiting_tile in &waits {
            let mut winning = tenpai.clone();
            winning.push(waiting_tile);
            assert_eq!(
                standard_han_without_riichi(&winning, waiting_tile, round_wind, seat_wind, &dora),
                0,
                "run {run}: the bad-wait box must be the only decider"
            );
        }
        assert!(!(live_kinds >= 2 && live > 4), "run {run}: the wait is bad");

        let triggers = || -> Vec<&str> {
            val["riichi_triggers"]
                .as_array()
                .unwrap()
                .iter()
                .map(|trigger| trigger.as_str().unwrap())
                .collect()
        };
        let reasons = || -> Vec<&str> {
            val["dama_reasons"]
                .as_array()
                .unwrap()
                .iter()
                .map(|reason| reason.as_str().unwrap())
                .collect()
        };

        if live >= 3 {
            many_live_count += 1;
            assert_eq!(val["target_action"], "Riichi", "run {run}");
            assert_eq!(val["correct_action"]["type"], "riichi", "run {run}");
            assert_eq!(triggers(), vec!["three_live_winning_tiles"], "run {run}");
            assert!(reasons().is_empty(), "run {run}");
        } else if wait.is_terminal_or_honor() {
            honor_terminal_count += 1;
            assert!(
                waits.iter().all(|wait| wait.is_terminal_or_honor()),
                "run {run}"
            );
            assert_eq!(val["target_action"], "Riichi", "run {run}");
            assert_eq!(val["correct_action"]["type"], "riichi", "run {run}");
            assert_eq!(triggers(), vec!["honor_terminal_wait"], "run {run}");
            assert!(reasons().is_empty(), "run {run}");
        } else {
            dama_count += 1;
            assert!(waits.iter().all(|wait| wait.is_simple()), "run {run}");
            assert_eq!(val["target_action"], "Dama", "run {run}");
            assert_eq!(val["correct_action"]["type"], "dama", "run {run}");
            assert!(triggers().is_empty(), "run {run}");
            assert_eq!(
                reasons(),
                vec![
                    "not_dealer",
                    "bad_wait",
                    "no_extra_han",
                    "few_live_winning_tiles"
                ],
                "run {run}"
            );
        }

        // The hand is never furiten.
        for discard in human["discards"].as_array().unwrap() {
            let code = discard["tile"].as_str().unwrap();
            assert_ne!(code, wait.to_string(), "run {run}: furiten wait {code}");
        }
    }

    assert!(dama_count > 0, "no 1-2 tile dama states were generated");
    assert!(
        many_live_count > 0,
        "no 3+ live tile riichi states were generated"
    );
    assert!(
        honor_terminal_count > 0,
        "no honor/terminal exception states were generated"
    );
}

/// Riichi Book 1, ch. 7, "Genbutsu wait": keep the pinfu side-wait hand dama
/// when one winning tile is the threatening player's genbutsu (ch7:539, 558).
#[wasm_bindgen_test]
fn test_dama_genbutsu_wait_payload_stays_dama() {
    for run in 0..60 {
        let json_output = generate_puzzle("dama_genbutsu_wait".to_string());
        let val: serde_json::Value = serde_json::from_str(&json_output)
            .unwrap_or_else(|err| panic!("run {run}: invalid JSON: {err}: {json_output}"));
        assert_eq!(val["category"], "dama_genbutsu_wait");
        assert_eq!(val["target_action"], "Dama", "run {run}");
        assert_eq!(val["correct_action"]["type"], "dama", "run {run}");
        assert!(val["riichi_triggers"].as_array().unwrap().is_empty());

        let reasons: Vec<&str> = val["dama_reasons"]
            .as_array()
            .unwrap()
            .iter()
            .map(|reason| reason.as_str().unwrap())
            .collect();
        assert_eq!(reasons, vec!["genbutsu_wait"], "run {run}");

        let human = &val["players"][0];
        assert_eq!(human["hand"].as_array().unwrap().len(), 13);
        assert!(human["melds"].as_array().unwrap().is_empty());
        assert_eq!(human["is_riichi"], false);
        assert_ne!(
            human["wind"], "East",
            "run {run}: the human is never the dealer"
        );
        let tenpai = kept_hand_after_a_tedashi(&val, run);
        assert_eq!(
            val["can_riichi"], true,
            "run {run}: Riichi must be offerable for a Riichi-vs-dama question"
        );

        let counts = to_counts(&tenpai);
        assert_eq!(calculate_shanten(&counts).shanten, 0, "run {run}");

        let waits: Vec<Tile> = val["ukeire_tiles"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tile| parse_single_tile(tile.as_str().unwrap()))
            .collect();
        assert_eq!(
            waits.len(),
            2,
            "run {run}: the book's example is a side wait"
        );

        // The book's example is a pinfu hand, so the general ch7.1 rule would
        // have declared Riichi. Only the genbutsu wait keeps it concealed.
        let dora: Vec<Tile> = val["dora_indicators"]
            .as_array()
            .unwrap()
            .iter()
            .map(|indicator| parse_single_tile(indicator.as_str().unwrap()))
            .collect();
        let round_wind = val["round_wind"].as_str().expect("round wind");
        let seat_wind = human["wind"].as_str().expect("human wind");
        for &waiting_tile in &waits {
            let mut winning = tenpai.clone();
            winning.push(waiting_tile);
            assert!(
                standard_han_without_riichi(&winning, waiting_tile, round_wind, seat_wind, &dora)
                    >= 1,
                "run {run}: the book's example has a han without riichi"
            );
        }

        // Exactly one opponent is in Riichi: the player everyone is watching.
        let players = val["players"].as_array().unwrap();
        let threats: Vec<&serde_json::Value> = players
            .iter()
            .skip(1)
            .filter(|player| player["is_riichi"] == true)
            .collect();
        assert_eq!(threats.len(), 1, "run {run}: one threatening player");
        let threat = threats[0];

        let threat_discards = threat["discards"].as_array().unwrap();
        let declaration = threat["riichi_discard_index"]
            .as_u64()
            .expect("the threat has a declaration discard") as usize;
        assert_eq!(
            declaration + 1,
            threat_discards.len(),
            "run {run}: the declaration is the threat's last discard"
        );
        assert_eq!(threat_discards[declaration]["is_riichi"], true);

        // The task's verification: at least one winning tile appears in the
        // threatening player's river, so it is their genbutsu.
        let threat_river: Vec<String> = threat_discards
            .iter()
            .map(|discard| discard["tile"].as_str().unwrap().to_string())
            .collect();
        let genbutsu: Vec<Tile> = waits
            .iter()
            .copied()
            .filter(|wait| threat_river.contains(&wait.to_string()))
            .collect();
        assert_eq!(
            genbutsu.len(),
            1,
            "run {run}: exactly one side of the wait is the threat's genbutsu"
        );

        // It was discarded before the declaration, so it is the threat's own
        // river rather than the declaration tile itself.
        let planted = genbutsu[0].to_string();
        let position = threat_river
            .iter()
            .position(|code| *code == planted)
            .unwrap_or_else(|| panic!("run {run}: {planted} missing from the threat river"));
        assert!(
            position < declaration,
            "run {run}: {planted} must be discarded before the declaration"
        );

        // The other side of the wait is still live: it is in nobody's river.
        let live = waits
            .iter()
            .copied()
            .find(|wait| !genbutsu.contains(wait))
            .expect("one live winning tile");
        let live_code = live.to_string();
        for opponent in players.iter().skip(1) {
            for discard in opponent["discards"].as_array().unwrap() {
                assert_ne!(
                    discard["tile"].as_str().unwrap(),
                    live_code,
                    "run {run}: the live wait is visible in a river"
                );
            }
        }

        // The hand is never furiten.
        for discard in human["discards"].as_array().unwrap() {
            let code = discard["tile"].as_str().unwrap();
            assert!(
                !waits.iter().any(|wait| wait.to_string() == code),
                "run {run}: human river contains furiten tile {code}"
            );
        }
    }
}

/// Riichi Book 1, ch. 7, "High scoring hand": an already-expensive hand stays
/// dama, and a haneman-or-better minimum forbids the declaration outright
/// (ch7:569, ch7:598, ch7:646).
#[wasm_bindgen_test]
fn test_dama_expensive_hand_payload_stays_dama() {
    let mut mangan_count = 0;
    let mut haneman_count = 0;

    for run in 0..60 {
        let json_output = generate_puzzle("dama_expensive_hand".to_string());
        let val: serde_json::Value = serde_json::from_str(&json_output)
            .unwrap_or_else(|err| panic!("run {run}: invalid JSON: {err}: {json_output}"));
        assert_eq!(val["category"], "dama_expensive_hand");
        assert_eq!(val["target_action"], "Dama", "run {run}");
        assert_eq!(val["correct_action"]["type"], "dama", "run {run}");
        assert!(val["riichi_triggers"].as_array().unwrap().is_empty());

        let reasons: Vec<&str> = val["dama_reasons"]
            .as_array()
            .unwrap()
            .iter()
            .map(|reason| reason.as_str().unwrap())
            .collect();
        assert!(
            reasons == vec!["mangan"] || reasons == vec!["haneman_plus"],
            "run {run}: unexpected reasons {reasons:?}"
        );

        let human = &val["players"][0];
        assert_eq!(human["hand"].as_array().unwrap().len(), 13);
        assert!(human["melds"].as_array().unwrap().is_empty());
        assert_eq!(human["is_riichi"], false);
        assert_ne!(
            human["wind"], "East",
            "run {run}: the 7700/haneman numbers are non-dealer ron values"
        );
        // The book's "far behind" Riichi exception must not apply.
        let human_score = human["score"].as_i64().expect("human score");
        for opponent in val["players"].as_array().unwrap().iter().skip(1) {
            assert!(
                opponent["score"].as_i64().unwrap() <= human_score,
                "run {run}: the human must not be far behind"
            );
        }
        // ... nor the early-turn one.
        assert!(
            human["discards"].as_array().unwrap().len() >= 6,
            "run {run}: the table must be past the 6th turn"
        );
        assert_eq!(
            val["can_riichi"], true,
            "run {run}: Riichi must be offerable for a Riichi-vs-dama question"
        );

        let tenpai = kept_hand_after_a_tedashi(&val, run);
        let counts = to_counts(&tenpai);
        assert_eq!(calculate_shanten(&counts).shanten, 0, "run {run}");

        let waits: Vec<Tile> = val["ukeire_tiles"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tile| parse_single_tile(tile.as_str().unwrap()))
            .collect();
        assert_eq!(waits.len(), 2, "run {run}: the wait is a side wait");

        let dora: Vec<Tile> = val["dora_indicators"]
            .as_array()
            .unwrap()
            .iter()
            .map(|indicator| parse_single_tile(indicator.as_str().unwrap()))
            .collect();
        assert_eq!(dora.len(), 1, "run {run}");
        let red_fives: Vec<Tile> = human["red_fives"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tile| parse_single_tile(tile.as_str().unwrap()))
            .collect();
        let aka = red_fives.len() as u8;
        assert!(aka <= 1, "run {run}: at most one red five in the hand");

        let round_wind = val["round_wind"].as_str().expect("round wind");
        let seat_wind = human["wind"].as_str().expect("human wind");

        // The task's verification: enumerate every winning tile and take the
        // worst value without Riichi.
        let worst = waits
            .iter()
            .map(|&wait| {
                let mut winning = tenpai.clone();
                winning.push(wait);
                standard_ron_points(&winning, wait, round_wind, seat_wind, &dora, aka)
                    .unwrap_or_else(|| panic!("run {run}: a winning tile has no yaku"))
            })
            .min()
            .expect("the wait is not empty");
        assert!(
            worst >= 7_700,
            "run {run}: the worst winning tile is only {worst}"
        );

        if reasons == vec!["haneman_plus"] {
            haneman_count += 1;
            assert_eq!(aka, 1, "run {run}: the haneman branch carries a red five");
            assert!(worst >= 12_000, "run {run}: haneman minimum was {worst}");
        } else {
            mangan_count += 1;
            assert_eq!(aka, 0, "run {run}: the 7700 branch has no red five");
            assert!(
                worst < 12_000,
                "run {run}: the 7700 branch reached haneman at {worst}"
            );
        }

        // The hand is never furiten.
        for discard in human["discards"].as_array().unwrap() {
            let code = discard["tile"].as_str().unwrap();
            assert!(
                !waits.iter().any(|wait| wait.to_string() == code),
                "run {run}: human river contains furiten tile {code}"
            );
        }
    }

    assert!(mangan_count > 0, "no 7700-11999 hands were generated");
    assert!(haneman_count > 0, "no haneman+ hands were generated");
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
        // An out-of-rotation call lets the walk skip a seat, so the rivers can
        // differ by one per call; the native `validate_reachable_state` test
        // checks the exact timeline.
        let calls: usize = players
            .iter()
            .map(|player| player["melds"].as_array().unwrap().len())
            .sum();
        let spread = discard_counts.iter().max().unwrap() - discard_counts.iter().min().unwrap();
        assert!(
            spread <= 1 + calls,
            "run {run}: discard counts must be reachable given {calls} call(s): {discard_counts:?}"
        );
        // The planner takes `gen_range(1, 7)` as the per-seat floor, and the
        // human's out-of-rotation Pon can leave them one discard ahead.
        assert!(
            (1..=7).contains(&discard_counts[0]),
            "run {run}: human discard count {discard_counts:?}"
        );

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

    /// The ryankan-break payload: a 1-away hand where the draw sits next to the
    /// head, so the book keeps the new side wait and breaks the double closed
    /// shape (ch3:523).
    #[wasm_bindgen_test]
    fn test_ryankan_break_payload() {
        for run in 0..25 {
            let json_output = generate_puzzle("ryankan_break".to_string());
            let val: serde_json::Value = serde_json::from_str(&json_output)
                .unwrap_or_else(|err| panic!("run {run}: invalid JSON: {err}: {json_output}"));

            assert_eq!(val["category"], "ryankan_break");
            assert_eq!(val["target_action"], "NaniKiru");
            assert_eq!(val["correct_action"]["type"], "dama");
            assert_eq!(val["riichi_sticks"], 0);
            assert_eq!(val["dora_indicators"].as_array().unwrap().len(), 1);
            assert_eq!(val["ura_dora_indicators"].as_array().unwrap().len(), 1);
            assert_eq!(val["tiles"].as_array().unwrap().len(), 14);
            assert_eq!(val["shanten"], 1);
            assert_eq!(val["is_agari"], false);
            assert!(!val["ukeire_tiles"].as_array().unwrap().is_empty());
            assert!(val["ukeire_total"].as_u64().unwrap() > 0);

            // The other ryankan terminal only leaves closed waits, so it is not
            // graded as equivalent.
            assert!(val["equivalent_tiles"].as_array().is_none_or(Vec::is_empty));

            let players = val["players"].as_array().expect("players array");
            assert_eq!(players.len(), 4);
            for opponent in &players[1..] {
                assert_eq!(opponent["is_riichi"], false);
                assert_eq!(opponent["melds"].as_array().unwrap().len(), 0);
                assert!(opponent["riichi_discard_index"].is_null());
            }

            // The human hand, the open Yakuhai Pon, and the draw.
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
            let draw = human["draw"].as_str().expect("human draw");
            assert_ne!(draw, answer, "the answer is a hand tile, not the draw");
            assert!(
                human["hand"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|tile| tile.as_str() == Some(answer)),
                "run {run}: the answer must be in the concealed hand"
            );

            // Full hand = concealed hand + draw + open meld.
            let mut expected: Vec<&str> = human["hand"]
                .as_array()
                .unwrap()
                .iter()
                .map(|tile| tile.as_str().unwrap())
                .collect();
            expected.push(draw);
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

            // The answer is never the dora: this is a shape lesson.
            let indicator = parse_hand(val["dora_indicators"][0].as_str().unwrap())
                .expect("dora indicator parses")
                .remove(0);
            assert_ne!(indicator_to_dora(indicator).to_string(), answer);

            // Scores total 100,000.
            let total_score: i64 = players
                .iter()
                .map(|player| player["score"].as_i64().expect("score int"))
                .sum();
            assert_eq!(total_score, 100_000);
        }
    }

    /// The pair-count payload: a closed 2-away hand whose draw pairs a tile of
    /// a side wait, so the book breaks the pair and keeps the protorun
    /// (ch3:336, ch3:331).
    #[wasm_bindgen_test]
    fn test_pair_count_payload() {
        for run in 0..25 {
            let json_output = generate_puzzle("pair_count".to_string());
            let val: serde_json::Value = serde_json::from_str(&json_output)
                .unwrap_or_else(|err| panic!("run {run}: invalid JSON: {err}: {json_output}"));

            assert_eq!(val["category"], "pair_count");
            assert_eq!(val["target_action"], "NaniKiru");
            assert_eq!(val["correct_action"]["type"], "dama");
            assert_eq!(val["riichi_sticks"], 0);
            assert_eq!(val["dora_indicators"].as_array().unwrap().len(), 1);
            assert_eq!(val["ura_dora_indicators"].as_array().unwrap().len(), 1);
            assert_eq!(val["tiles"].as_array().unwrap().len(), 14);
            assert_eq!(val["shanten"], 2);
            assert_eq!(val["is_agari"], false);
            assert_eq!(val["can_riichi"], false);
            assert!(!val["ukeire_tiles"].as_array().unwrap().is_empty());
            assert!(val["ukeire_total"].as_u64().unwrap() > 0);

            let players = val["players"].as_array().expect("players array");
            assert_eq!(players.len(), 4);
            for opponent in &players[1..] {
                assert_eq!(opponent["is_riichi"], false);
                assert_eq!(opponent["melds"].as_array().unwrap().len(), 0);
                assert!(opponent["riichi_discard_index"].is_null());
            }

            // The lesson is the closed variant: thirteen concealed tiles, the
            // draw, and no meld.
            let human = &players[0];
            assert_eq!(human["hand"].as_array().unwrap().len(), 13);
            assert_eq!(human["melds"].as_array().unwrap().len(), 0);
            let draw = human["draw"].as_str().expect("human draw");

            let answer = val["correct_action"]["discard"]
                .as_str()
                .expect("dama action must include a discard tile");
            assert_eq!(draw, answer, "the book discards the tile just drawn");
            assert!(
                human["hand"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|tile| tile.as_str() == Some(answer)),
                "run {run}: the pair partner must stay in the hand"
            );

            // Exactly three pairs, and the answer is one of them.
            let tiles: Vec<&str> = val["tiles"]
                .as_array()
                .unwrap()
                .iter()
                .map(|tile| tile.as_str().unwrap())
                .collect();
            let mut counts: std::collections::HashMap<&str, usize> =
                std::collections::HashMap::new();
            for tile in &tiles {
                *counts.entry(*tile).or_insert(0) += 1;
            }
            let pairs: Vec<&&str> = counts
                .iter()
                .filter(|(_, count)| **count == 2)
                .map(|(tile, _)| tile)
                .collect();
            assert_eq!(pairs.len(), 3, "the hand must hold three pairs");
            assert!(pairs.iter().any(|pair| **pair == answer));

            // The other pair tiles are graded as the same answer.
            let equivalents = val["equivalent_tiles"]
                .as_array()
                .expect("equivalent tiles array");
            assert_eq!(equivalents.len(), 2);
            for equivalent in equivalents {
                let code = equivalent.as_str().expect("tile code");
                assert_ne!(code, answer);
                assert!(
                    pairs.iter().any(|pair| **pair == code),
                    "{code} must be a pair tile"
                );
            }

            // Full hand = concealed hand + draw.
            let mut expected: Vec<&str> = human["hand"]
                .as_array()
                .unwrap()
                .iter()
                .map(|tile| tile.as_str().unwrap())
                .collect();
            expected.push(draw);
            expected.sort();
            let mut actual = tiles.clone();
            actual.sort();
            assert_eq!(actual, expected);

            // No graded discard is the dora: this is a shape lesson.
            let indicator = parse_hand(val["dora_indicators"][0].as_str().unwrap())
                .expect("dora indicator parses")
                .remove(0);
            let dora = indicator_to_dora(indicator).to_string();
            assert_ne!(dora, answer);
            assert!(
                !equivalents
                    .iter()
                    .any(|tile| tile.as_str() == Some(dora.as_str())),
                "no graded discard may be the dora"
            );

            // Scores total 100,000.
            let total_score: i64 = players
                .iter()
                .map(|player| player["score"].as_i64().expect("score int"))
                .sum();
            assert_eq!(total_score, 100_000);
        }
    }

    /// The open-hand pair-count payload: three pairs, one of them a dragon the
    /// player plans to Pon, so the book keeps the pairs and breaks the closed
    /// wait instead (ch3:351). The plan must be visible in `scenario_note`.
    #[wasm_bindgen_test]
    fn test_pair_count_open_payload() {
        for run in 0..10 {
            let json_output = generate_puzzle("pair_count_open".to_string());
            let val: serde_json::Value = serde_json::from_str(&json_output)
                .unwrap_or_else(|err| panic!("run {run}: invalid JSON: {err}: {json_output}"));

            assert_eq!(val["category"], "pair_count_open");
            assert_eq!(val["target_action"], "NaniKiru");
            assert_eq!(val["correct_action"]["type"], "dama");
            assert_eq!(val["tiles"].as_array().unwrap().len(), 14);
            assert_eq!(val["shanten"], 2);
            assert_eq!(val["can_riichi"], false);
            assert!(val["ukeire_total"].as_u64().unwrap() > 0);
            assert!(
                val["scenario_note"]
                    .as_str()
                    .expect("run {run}: the Pon plan needs a note")
                    .contains("Pon"),
                "run {run}: the note must state the planned Pon"
            );

            let players = val["players"].as_array().expect("players array");
            let human = &players[0];
            assert_eq!(human["hand"].as_array().unwrap().len(), 13);
            assert_eq!(human["melds"].as_array().unwrap().len(), 0);
            let draw = human["draw"].as_str().expect("human draw");
            let answer = val["correct_action"]["discard"]
                .as_str()
                .expect("dama action must include a discard tile");
            assert_ne!(draw, answer, "the open-hand answer is not the drawn tile");

            let tiles: Vec<&str> = val["tiles"]
                .as_array()
                .unwrap()
                .iter()
                .map(|tile| tile.as_str().unwrap())
                .collect();
            let mut counts: std::collections::HashMap<&str, usize> =
                std::collections::HashMap::new();
            for tile in &tiles {
                *counts.entry(*tile).or_insert(0) += 1;
            }
            let pairs: Vec<&&str> = counts
                .iter()
                .filter(|(_, count)| **count == 2)
                .map(|(tile, _)| tile)
                .collect();
            assert_eq!(pairs.len(), 3, "run {run}: the hand must hold three pairs");
            let target = pairs
                .iter()
                .find(|pair| matches!(***pair, "5z" | "6z" | "7z"))
                .expect("one pair is a dragon");
            assert_ne!(answer, **target, "the answer cannot be the Pon target");
            assert!(
                !pairs.iter().any(|pair| **pair == answer),
                "run {run}: the answer cannot break a pair"
            );

            // The answer keeps all three pairs, including both dragons.
            let mut post = tiles.clone();
            let index = post
                .iter()
                .position(|tile| *tile == answer)
                .expect("answer must be in the hand");
            post.remove(index);
            let mut post_counts: std::collections::HashMap<&str, usize> =
                std::collections::HashMap::new();
            for tile in &post {
                *post_counts.entry(*tile).or_insert(0) += 1;
            }
            let post_pairs = post_counts.values().filter(|count| **count == 2).count();
            assert_eq!(post_pairs, 3, "run {run}: the answer keeps three pairs");
            assert_eq!(
                post_counts.get(**target).copied(),
                Some(2),
                "run {run}: both Pon-target tiles must stay in the hand"
            );

            // No graded discard is the dora.
            let indicator = parse_hand(val["dora_indicators"][0].as_str().unwrap())
                .expect("dora indicator parses")
                .remove(0);
            let dora = indicator_to_dora(indicator).to_string();
            assert_ne!(dora, answer);
            assert_ne!(dora.as_str(), **target);
        }
    }

    #[wasm_bindgen_test]
    fn test_shouminkan_decision_payload() {
        let mut kan_count = 0usize;
        let mut discard_count = 0usize;

        for run in 0..100 {
            let json_output = generate_puzzle("shouminkan_decision".to_string());
            let val: serde_json::Value = serde_json::from_str(&json_output)
                .unwrap_or_else(|err| panic!("run {run}: invalid JSON: {err}: {json_output}"));

            assert_eq!(val["category"], "shouminkan_decision");
            // One lesson, one neutral prompt: the payload never hints at the
            // expected answer, even though the answer splits ~50/50.
            assert_eq!(val["target_action"], "Kan");

            let answer = val["correct_action"]["type"]
                .as_str()
                .expect("answer must carry a type");
            assert!(
                answer == "kan" || answer == "discard",
                "run {run}: unexpected answer {answer}"
            );
            let answer_tile = val["correct_action"]["tile"]
                .as_str()
                .expect("both answers must name the fourth tile");
            if answer == "kan" {
                kan_count += 1;
                assert!(
                    val["correct_action"]["discard"].is_null(),
                    "run {run}: Kan action must not include a discard field"
                );
            } else {
                discard_count += 1;
            }

            let triggers = val["shouminkan_triggers"]
                .as_array()
                .expect("shouminkan_triggers must be an array");
            if answer == "kan" {
                assert!(
                    !triggers.is_empty(),
                    "run {run}: at least one trigger is required for the Kan answer"
                );
            } else {
                assert!(
                    triggers.is_empty(),
                    "run {run}: the discard answer has no Kan justification"
                );
            }

            let human = &val["players"][0];
            assert_eq!(human["hand"].as_array().unwrap().len(), 10);
            assert_eq!(human["draw"], answer_tile);
            assert_eq!(human["melds"].as_array().unwrap().len(), 1);
            assert_eq!(human["melds"][0]["meld_type"], "Pon");
            let meld_tiles = human["melds"][0]["tiles"].as_array().unwrap();
            assert_eq!(meld_tiles.len(), 3);
            assert_eq!(meld_tiles[0], answer_tile);
            assert!(meld_tiles.iter().all(|tile| tile == answer_tile));
            assert!(
                !human["hand"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|tile| tile == answer_tile)
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

        assert!(
            kan_count >= 25 && discard_count >= 25,
            "the payload sweep must cover both answers, got {kan_count} Kan / {discard_count} discard"
        );
    }
}

#[wasm_bindgen_test]
fn test_nakabukure_ready_rejection_sampling_constraints() {
    for run in 0..25 {
        let json_output = generate_puzzle("nakabukure_ready".to_string());
        let val: serde_json::Value = serde_json::from_str(&json_output)
            .unwrap_or_else(|err| panic!("run {run}: invalid JSON: {err}: {json_output}"));

        assert_eq!(val["category"], "nakabukure_ready");
        assert_eq!(val["target_action"], "NaniKiru");
        assert_eq!(val["correct_action"]["type"], "dama");
        assert_eq!(val["riichi_sticks"], 0);
        assert_eq!(val["dora_indicators"].as_array().unwrap().len(), 1);
        assert_eq!(val["ura_dora_indicators"].as_array().unwrap().len(), 1);
        assert_eq!(val["shanten"], 0);
        assert_eq!(val["is_agari"], false);

        let players = val["players"].as_array().expect("players array");
        assert_eq!(players.len(), 4);
        for opponent in &players[1..] {
            assert_eq!(opponent["is_riichi"], false);
            assert_eq!(opponent["melds"].as_array().unwrap().len(), 0);
            assert!(opponent["riichi_discard_index"].is_null());
        }

        // Human hand, open Yakuhai Pon, and the drawn honour.
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
        let draw = human["draw"].as_str().expect("human draw");
        assert_ne!(answer, draw, "run {run}: the draw is not the answer");
        assert!(
            draw.ends_with('z'),
            "run {run}: the alternative discard is the floating honour"
        );

        // The visible full hand is exactly hand + draw + open meld.
        let mut expected: Vec<&str> = human["hand"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tile| tile.as_str().unwrap())
            .collect();
        expected.push(draw);
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

        // The bulge tile is held exactly twice.
        assert_eq!(
            actual.iter().filter(|tile| **tile == answer).count(),
            2,
            "run {run}: the answer is the middle tile of the bulge"
        );

        // The book's discard leaves the lone honour as the only wait, with
        // three live copies.
        let wait_tiles: Vec<&str> = val["ukeire_tiles"]
            .as_array()
            .expect("ukeire_tiles array")
            .iter()
            .map(|tile| tile.as_str().unwrap())
            .collect();
        assert_eq!(wait_tiles, vec![draw]);
        assert_eq!(val["ukeire_total"], 3);

        // The tempting discard leaves the bulge tile, of which only two remain.
        let mut post_float = actual.clone();
        let float_index = post_float
            .iter()
            .position(|tile| *tile == draw)
            .expect("draw must be in the full hand");
        post_float.remove(float_index);
        let parsed =
            parse_hand(&post_float.join("")).expect("post-discard hand must parse in agari");
        let counts = to_counts(&parsed);
        assert_eq!(calculate_shanten(&counts).shanten, 0);
        let ukeire = calculate_ukeire(&counts);
        assert_eq!(ukeire.tiles.len(), 1);
        assert_eq!(ukeire.tiles[0].tile.to_string(), answer);
        assert_eq!(ukeire.total_count, 2);
        assert!(val["ukeire_total"].as_u64().unwrap() > 2);

        // Furiten and availability: neither wait is visible anywhere.
        for player in players {
            for discard in player["discards"].as_array().unwrap() {
                let tile = discard["tile"].as_str().unwrap();
                assert_ne!(tile, answer, "run {run}: answer is visibly discarded");
                assert_ne!(tile, draw, "run {run}: the honour is visibly discarded");
            }
        }
        for indicator in val["dora_indicators"].as_array().unwrap() {
            let tile = indicator.as_str().unwrap();
            assert_ne!(tile, answer);
            assert_ne!(tile, draw);
        }

        let total_score: i64 = players
            .iter()
            .map(|player| player["score"].as_i64().expect("score int"))
            .sum();
        assert_eq!(total_score, 100_000);
    }
}

#[wasm_bindgen_test]
fn test_defense_scenarios_payload() {
    for category in ["defense_safety_chart", "defense_stuck_heuristic"] {
        for run in 0..10 {
            let json_output = generate_puzzle(category.to_string());
            let val: serde_json::Value = serde_json::from_str(&json_output)
                .unwrap_or_else(|err| panic!("{category} run {run}: invalid JSON: {err}"));

            assert_eq!(val["category"], category);
            assert_eq!(val["target_action"], "Defend");
            assert_eq!(val["correct_action"]["type"], "fold");
            let answer = val["correct_action"]["discard"]
                .as_str()
                .expect("a fold answer names the discard");

            let players = val["players"].as_array().expect("players array");
            assert_eq!(players.len(), 4);

            let human = &players[0];
            assert_eq!(human["is_human"], true);
            assert_eq!(human["hand"].as_array().unwrap().len(), 13);
            assert_eq!(human["draw"], answer);
            assert!(human["melds"].as_array().unwrap().is_empty());
            assert_eq!(human["is_riichi"], false);

            // Pure defense: exactly one opponent has declared Riichi, and the
            // declaration tile is the last discard in their river.
            let threats: Vec<&serde_json::Value> = players
                .iter()
                .filter(|player| player["is_riichi"] == true)
                .collect();
            assert_eq!(threats.len(), 1, "{category} run {run}");
            let threat = threats[0];
            let discards = threat["discards"].as_array().unwrap();
            assert_eq!(
                threat["riichi_discard_index"].as_u64(),
                Some(discards.len() as u64 - 1)
            );
            assert_eq!(discards.last().unwrap()["is_riichi"], true);

            // The hand is not ready: these lessons are about folding.
            assert!(val["shanten"].as_i64().unwrap() >= 1);

            let mut expected: Vec<&str> = human["hand"]
                .as_array()
                .unwrap()
                .iter()
                .map(|tile| tile.as_str().unwrap())
                .collect();
            expected.push(answer);
            expected.sort();
            let mut actual: Vec<&str> = val["tiles"]
                .as_array()
                .unwrap()
                .iter()
                .map(|tile| tile.as_str().unwrap())
                .collect();
            actual.sort();
            assert_eq!(actual, expected);

            // Another player's post-riichi discard of a held tile ties the
            // answer on the 100% row, so the state lists it as an equivalent
            // answer: both are genbutsu (Riichi Book 1, ch. 8).
            for equivalent in val["equivalent_tiles"].as_array().into_iter().flatten() {
                let equivalent = equivalent
                    .as_str()
                    .expect("an equivalent answer must name a tile");
                assert_ne!(equivalent, answer);
                assert!(
                    expected.contains(&equivalent),
                    "{category} run {run}: {equivalent} is not in the hand"
                );
            }

            let total_score: i64 = players
                .iter()
                .map(|player| player["score"].as_i64().expect("score int"))
                .sum();
            assert_eq!(total_score, 100_000);

            // The ch. 8 rationale is stamped at the generation boundary.
            assert!(val["book_rationale"]["rules"].is_array());
            assert!(
                !val["book_rationale"]["rules"]
                    .as_array()
                    .unwrap()
                    .is_empty()
            );
            assert_eq!(val["book_rationale"]["source"]["chapter"], 8);
        }
    }
}

#[wasm_bindgen_test]
fn test_open_hand_defense_payload() {
    let mut saw_same_suit = false;
    let mut saw_different_suit = false;

    for run in 0..30 {
        let json_output = generate_puzzle("open_hand_defense".to_string());
        let val: serde_json::Value = serde_json::from_str(&json_output)
            .unwrap_or_else(|err| panic!("run {run}: invalid JSON: {err}"));

        assert_eq!(val["category"], "open_hand_defense");
        assert_eq!(val["target_action"], "Defend");
        assert_eq!(val["correct_action"]["type"], "fold");
        assert_eq!(val["decision"]["kind"], "self_turn");
        assert_eq!(val["current_turn"], 0);
        assert_eq!(val["can_riichi"], false);
        assert_eq!(val["shanten"], 2);
        assert_eq!(val["riichi_sticks"], 0);

        let answer = val["correct_action"]["discard"]
            .as_str()
            .expect("a fold answer names the discard");
        let answer_tile = parse_single_tile(answer);

        let players = val["players"].as_array().expect("players array");
        assert_eq!(players.len(), 4);

        let human = &players[0];
        assert_eq!(human["is_human"], true);
        assert_eq!(human["hand"].as_array().unwrap().len(), 13);
        assert!(human["draw"].is_string());
        assert!(human["melds"].as_array().unwrap().is_empty());
        assert_eq!(human["is_riichi"], false);
        assert!(
            human["hand"]
                .as_array()
                .unwrap()
                .iter()
                .any(|tile| tile.as_str() == Some(answer)),
            "the answer is a hand discard, so the fold is visible"
        );

        // The threat is the opponent with three open melds. Its last call is
        // the chii, and its last discard is the tile thrown after it.
        let threat = players
            .iter()
            .skip(1)
            .find(|player| {
                player["melds"]
                    .as_array()
                    .is_some_and(|melds| melds.len() == 3)
            })
            .unwrap_or_else(|| panic!("{run}: no three-meld threat"));
        assert_eq!(threat["is_riichi"], false);
        let melds = threat["melds"].as_array().unwrap();
        let last_chi = melds
            .iter()
            .rev()
            .find(|meld| meld["meld_type"] == "Chi")
            .expect("the last call is a chii");
        let chi_suit = parse_single_tile(last_chi["tiles"][0].as_str().expect("a chii tile"))
            .suit()
            .expect("suited");
        let threat_discards = threat["discards"].as_array().unwrap();
        let post_chi = parse_single_tile(
            threat_discards.last().expect("a post-chii discard")["tile"]
                .as_str()
                .expect("a discard tile"),
        );

        let human_tiles: Vec<Tile> = human["hand"]
            .as_array()
            .unwrap()
            .iter()
            .chain(std::iter::once(&human["draw"]))
            .map(|tile| parse_single_tile(tile.as_str().expect("tile code")))
            .collect();
        let in_neighbourhood: Vec<Tile> = {
            let mut unique = human_tiles.clone();
            unique.sort();
            unique.dedup();
            unique
                .into_iter()
                .filter(|tile| riichiprac::safety::in_open_hand_neighbourhood(*tile, post_chi))
                .collect()
        };

        if chi_suit == post_chi.suit().expect("suited") {
            saw_same_suit = true;
            // The book's safe case: the answer is the hand's only tile in the
            // neighbourhood of the last discard.
            assert_eq!(in_neighbourhood, vec![answer_tile]);
            assert!(
                threat_discards
                    .iter()
                    .all(|discard| discard["tile"].as_str() != Some(answer)),
                "the same-suit board holds no genbutsu"
            );
        } else {
            saw_different_suit = true;
            // The trap: the neighbourhood is dangerous, and the answer is the
            // 100% genbutsu just outside it.
            assert!(
                !riichiprac::safety::in_open_hand_neighbourhood(answer_tile, post_chi),
                "the trap answer is outside the neighbourhood"
            );
            assert!(
                !in_neighbourhood.is_empty(),
                "the trap must show a tempting tile in the neighbourhood"
            );
            assert!(
                threat_discards
                    .iter()
                    .any(|discard| discard["tile"].as_str() == Some(answer)),
                "the trap answer must be in the threat's river"
            );
        }

        assert_eq!(val["equivalent_tiles"].as_array().map(Vec::len), None);

        let total_score: i64 = players
            .iter()
            .map(|player| player["score"].as_i64().expect("score int"))
            .sum();
        assert_eq!(total_score, 100_000);

        let rationale = &val["book_rationale"];
        assert_eq!(rationale["source"]["chapter"], 8);
        assert!(
            rationale["rules"]
                .as_array()
                .is_some_and(|rules| !rules.is_empty()),
            "the ch. 8.4 rationale must be stamped"
        );
    }

    assert!(saw_same_suit, "the same-suit case must be generated");
    assert!(
        saw_different_suit,
        "the different-suit trap must be generated"
    );
}

#[wasm_bindgen_test]
fn test_meld_or_not_payload() {
    for run in 0..25 {
        let json_output = generate_puzzle("meld_or_not".to_string());
        let val: serde_json::Value = serde_json::from_str(&json_output)
            .unwrap_or_else(|err| panic!("run {run}: invalid JSON: {err}"));

        assert_eq!(val["category"], "meld_or_not");
        assert_eq!(val["target_action"], "Call");
        assert_eq!(val["correct_action"]["type"], "pass");
        assert_eq!(val["decision"]["kind"], "react_to_discard");
        assert_eq!(val["can_riichi"], false);

        let offer = &val["call_offer"];
        assert_eq!(offer["action"], "Pon");
        assert_eq!(offer["tile"], val["decision"]["tile"]);
        assert!(
            offer["label"]
                .as_str()
                .is_some_and(|l| l.starts_with("Pon "))
        );

        let from = val["decision"]["from"]
            .as_u64()
            .expect("the reaction names its source") as usize;
        assert!((1..=3).contains(&from));
        assert_eq!(val["current_turn"], from);

        let players = val["players"].as_array().expect("players array");
        assert_eq!(players.len(), 4);
        let human = &players[0];
        assert_eq!(human["is_human"], true);
        assert_eq!(human["hand"].as_array().unwrap().len(), 13);
        assert!(human["draw"].is_null());
        assert!(human["melds"].as_array().unwrap().is_empty());
        assert_eq!(human["is_riichi"], false);
        assert!(
            val["shanten"].as_i64().unwrap() >= 3,
            "the hand must be 3-away or worse before the call"
        );

        // The offering seat really did just discard the offered tile.
        let source = &players[from];
        let discards = source["discards"].as_array().unwrap();
        assert_eq!(
            discards.last().expect("last discard")["tile"],
            offer["tile"],
            "run {run}"
        );
        assert_eq!(discards.last().unwrap()["is_tsumogiri"], false);

        // The hand holds a pair of the offered tile, so the Pon is real.
        let offered = offer["tile"].as_str().expect("tile");
        assert_eq!(
            human["hand"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|tile| tile.as_str() == Some(offered))
                .count(),
            2
        );

        // Cheap: no dora in the hand.
        let indicator = parse_single_tile(val["dora_indicators"][0].as_str().expect("indicator"));
        let dora = indicator_to_dora(indicator).to_string();
        assert!(
            human["hand"]
                .as_array()
                .unwrap()
                .iter()
                .all(|tile| tile.as_str() != Some(dora.as_str())),
            "run {run}: the hand must not hold a dora"
        );

        let total_score: i64 = players
            .iter()
            .map(|player| player["score"].as_i64().expect("score int"))
            .sum();
        assert_eq!(total_score, 100_000);

        let rationale = &val["book_rationale"];
        assert_eq!(rationale["source"]["chapter"], 9);
        assert!(
            rationale["absent"]
                .as_array()
                .is_some_and(|absent| !absent.is_empty()),
            "the ch. 9.2 exceptions must be listed as absent rules"
        );
    }
}

#[wasm_bindgen_test]
fn test_meld_or_not_grades_pass_and_pon_through_wasm() {
    let table: serde_json::Value =
        serde_json::from_str(&generate_puzzle("meld_or_not".to_string()))
            .expect("call lesson must be valid JSON");

    let pass = serde_json::json!({
        "table": table,
        "answer": { "action": "pass", "tile": "" },
        "evaluation": serde_json::Value::Null,
    });
    let grade: serde_json::Value =
        serde_json::from_str(&grade_answer_json(&pass.to_string())).expect("grade must be JSON");
    assert_eq!(grade["outcome"], "only_available_agrees");
    assert_eq!(grade["book"]["is_action_correct"], true);
    assert_eq!(grade["book"]["expected_action"], "pass");

    let call = serde_json::json!({
        "table": table,
        "answer": { "action": "call", "tile": "", "action_name": "Pon" },
        "evaluation": serde_json::Value::Null,
    });
    let grade: serde_json::Value =
        serde_json::from_str(&grade_answer_json(&call.to_string())).expect("grade must be JSON");
    assert_eq!(grade["outcome"], "only_available_disagrees");
    assert_eq!(grade["book"]["is_action_correct"], false);
}

#[wasm_bindgen_test]
fn test_wind_discard_order_payload() {
    for run in 0..25 {
        let json_output = generate_puzzle("wind_discard_order".to_string());
        let val: serde_json::Value = serde_json::from_str(&json_output)
            .unwrap_or_else(|err| panic!("run {run}: invalid JSON: {err}"));

        assert_eq!(val["category"], "wind_discard_order");
        assert_eq!(val["target_action"], "NaniKiru");
        assert_eq!(val["correct_action"]["type"], "dama");
        assert_eq!(val["hand_number"], 1);
        assert_eq!(val["current_turn"], 0);

        let answer = val["correct_action"]["discard"]
            .as_str()
            .expect("the answer names the discard")
            .to_string();
        let players = val["players"].as_array().expect("players array");
        assert_eq!(players.len(), 4);

        // The answer is the right player's (seat 1's) seat wind.
        let shimocha_wind = players[1]["wind"]
            .as_str()
            .expect("shimocha must have a wind");
        let expected = match shimocha_wind {
            "East" => "1z",
            "South" => "2z",
            "West" => "3z",
            "North" => "4z",
            other => panic!("run {run}: unknown wind {other}"),
        };
        assert_eq!(answer, expected, "run {run}");

        let human = &players[0];
        assert_eq!(human["is_human"], true);
        assert_eq!(human["hand"].as_array().unwrap().len(), 13);
        assert_eq!(human["draw"], answer);
        assert!(human["melds"].as_array().unwrap().is_empty());
        assert_eq!(human["is_riichi"], false);
        assert!(human["discards"].as_array().unwrap().is_empty());
        assert!(val["equivalent_tiles"].as_array().is_none_or(Vec::is_empty));

        for player in players {
            assert!(player["melds"].as_array().unwrap().is_empty());
            assert_eq!(player["is_riichi"], false);
            assert!(player["discards"].as_array().unwrap().len() <= 1);
        }

        // Two or three valueless winds and no dragons; never the seat wind or
        // the round wind.
        let seat_wind = human["wind"].as_str().unwrap();
        let round_wind = val["round_wind"].as_str().unwrap();
        let winds: Vec<&str> = val["tiles"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tile| tile.as_str().unwrap())
            .filter(|code| matches!(*code, "1z" | "2z" | "3z" | "4z"))
            .collect();
        assert!(
            (2..=3).contains(&winds.len()),
            "run {run}: {} winds in hand",
            winds.len()
        );
        let name_for = |code: &str| match code {
            "1z" => "East",
            "2z" => "South",
            "3z" => "West",
            _ => "North",
        };
        for code in &winds {
            assert_ne!(name_for(code), seat_wind, "run {run}: seat wind held");
            assert_ne!(name_for(code), round_wind, "run {run}: round wind held");
        }
        assert_eq!(val["book_rationale"]["source"]["chapter"], 9);
        assert!(
            !val["book_rationale"]["rules"]
                .as_array()
                .unwrap()
                .is_empty()
        );

        let total_score: i64 = players
            .iter()
            .map(|player| player["score"].as_i64().expect("score int"))
            .sum();
        assert_eq!(total_score, 100_000);
    }
}

#[wasm_bindgen_test]
fn test_defense_answer_grades_against_the_book() {
    let table: serde_json::Value =
        serde_json::from_str(&generate_puzzle("defense_safety_chart".to_string()))
            .expect("defense payload must be valid JSON");
    let answer = table["correct_action"]["discard"]
        .as_str()
        .expect("a fold answer")
        .to_string();

    let request = serde_json::json!({
        "table": table.clone(),
        "answer": { "action": "fold", "tile": answer },
        "evaluation": serde_json::Value::Null,
    });
    let grade_json = grade_answer_json(&request.to_string());
    let grade: serde_json::Value =
        serde_json::from_str(&grade_json).expect("grade must return valid JSON");

    assert!(grade.get("error").is_none(), "grade error: {grade_json}");
    assert_eq!(grade["mode"], "book_only");
    assert_eq!(grade["outcome"], "only_available_agrees");
    assert_eq!(grade["book"]["is_action_correct"], true);
    assert_eq!(grade["book"]["is_tile_correct"], true);

    // A fold answer survives the report round trip, including the action enum.
    let report_request = serde_json::json!({
        "table": table,
        "answer": { "action": "fold", "tile": answer },
        "reason": "expected_tile_wrong",
        "created_at": "2026-11-10T08:42:11.031Z",
        "report_id": "defense-report",
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

    let parsed_json = parse_scenario_report(&report_json);
    let parsed: serde_json::Value =
        serde_json::from_str(&parsed_json).expect("parse must return valid JSON");
    assert!(parsed.get("error").is_none(), "parse error: {parsed_json}");
    assert_eq!(parsed["report"]["table"], report["table"]);
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

#[wasm_bindgen_test]
fn test_generated_states_gate_illegal_riichi() {
    // The block-theory lesson always holds an open Yakuhai Pon: Riichi must be
    // reported as illegal rather than offered and graded as a wrong answer.
    for run in 0..20 {
        let val: serde_json::Value =
            serde_json::from_str(&generate_puzzle("ryanmen_protorun".to_string()))
                .expect("ryanmen payload");
        assert_eq!(val["can_riichi"], false, "run {run}");
        assert!(
            !val["players"][0]["melds"].as_array().unwrap().is_empty(),
            "run {run}: the lesson must stay an open hand"
        );
    }

    // A closed tenpai lesson can offer the declaration.
    let chiitoitsu: serde_json::Value =
        serde_json::from_str(&generate_puzzle("chiitoitsu_riichi_vs_dama".to_string()))
            .expect("chiitoitsu payload");
    assert!(chiitoitsu["can_riichi"].is_boolean());
}

#[wasm_bindgen_test]
fn test_grade_shows_mortals_riichi_declaration() {
    let table: serde_json::Value = serde_json::from_str(&generate_puzzle("mock_table".to_string()))
        .expect("mock table must be valid JSON");
    let discard = table["correct_action"]["discard"]
        .as_str()
        .expect("mock table is a Riichi puzzle")
        .to_string();

    let request = serde_json::json!({
        "table": table,
        "answer": { "action": "riichi", "tile": discard },
        "evaluation": {
            "model": "mortal_298k.safetensors",
            "expected_value": 0.2,
            "recommended_action": "Riichi",
            "riichi_discard": discard,
            "evaluations": [
                { "action": "Riichi", "label": "Riichi", "type": "riichi", "probability": 0.7 },
                { "action": "Discard_3p", "label": "Discard 3p", "type": "discard",
                  "tile": "3p", "probability": 0.3 }
            ]
        },
    });

    let grade_json = grade_answer_json(&request.to_string());
    let grade: serde_json::Value =
        serde_json::from_str(&grade_json).expect("grade must return valid JSON");

    assert!(grade.get("error").is_none(), "grade error: {grade_json}");
    assert_eq!(grade["mode"], "book_and_mortal");
    assert_eq!(grade["outcome"], "both_agree");
    assert_eq!(grade["mortal"]["recommended_riichi"], true);
    assert_eq!(grade["mortal"]["recommended_discard"], discard);
    assert_eq!(grade["mortal"]["agrees"], true);
}
