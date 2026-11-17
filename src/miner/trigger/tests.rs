//! S1 trigger fixtures and precision/recall tests.
//!
//! Every fixture is a complete reconstructed decision built in memory. Positive
//! and near-miss negatives are pinned per trigger, then the same set is used to
//! assert that the trigger pass has perfect precision and recall against the
//! expected sets. One generated book lesson is the exception: it proves the
//! classifier seam, not the book rule.

use std::collections::{BTreeMap, BTreeSet};

use agari::tile::Tile;
use rusqlite::{Connection, params};

use super::*;
use crate::ai::actions::legal_actions;
use crate::decision::{ActionInfo, ActionKind};
use crate::generator::{evaluate_hand, format_hand_compact, generate_puzzle};
use crate::miner::MODEL_LABEL_SCHEMA;
use crate::miner::label::thresholds::{PercentileCut, PercentileCuts, PercentileThresholds};
use crate::miner::label::{
    CLASSIFIER_VERSION, LabelKind, ModelLabel, Q_UNITS, Q_UNITS_NOTE, RankedAction, VALUE_UNITS,
};
use crate::miner::provenance::ReplayId;
use crate::miner::storage::migrate;
use crate::replay::walk::DecisionSnapshot;
use crate::state::{DecisionContext, DiscardTile, PlayerState, Wind};

// --- Fixture construction -------------------------------------------------

fn tile(code: &str) -> Tile {
    Tile::try_from(code).unwrap_or_else(|err| panic!("fixture tile `{code}`: {err}"))
}

fn codes(tiles: &[&str]) -> Vec<String> {
    tiles.iter().map(|tile| (*tile).to_string()).collect()
}

fn player(seat: usize, wind: Wind, hand: &[&str], draw: Option<&str>, turn: usize) -> PlayerState {
    PlayerState {
        seat,
        name: format!("seat{seat}"),
        is_human: seat == 0,
        wind,
        score: 25_000,
        hand: codes(hand),
        draw: draw.map(str::to_string),
        red_fives: Vec::new(),
        discards: (0..turn)
            .map(|index| DiscardTile::new(river_tile(seat, index)))
            .collect(),
        melds: Vec::new(),
        is_riichi: false,
        riichi_discard_index: None,
    }
}

/// A deterministic river tile that does not accidentally make a hand tile a
/// suji: each seat gets a disjoint honour cycle.
fn river_tile(seat: usize, index: usize) -> String {
    let honors = ["1z", "2z", "3z", "4z", "5z", "6z", "7z"];
    honors[(seat * 3 + index) % honors.len()].to_string()
}

/// A state from a 13-tile standing hand plus an optional draw.
fn state_from(hand: &[&str], draw: Option<&str>, turn: usize) -> GameState {
    let mut human = player(0, Wind::East, hand, draw, turn);
    let mut concealed: Vec<Tile> = hand.iter().copied().map(tile).collect();
    if let Some(draw) = draw {
        concealed.push(tile(draw));
    }
    let metrics = evaluate_hand(&concealed);
    human.hand = codes(hand);
    human.draw = draw.map(str::to_string);

    GameState {
        category: "fixture".to_string(),
        target_action: crate::state::TargetAction::Best,
        correct_action: crate::state::CorrectAction::best(
            "Pass",
            None,
            Vec::new(),
            "Pass".to_string(),
        ),
        equivalent_tiles: Vec::new(),
        decision: DecisionContext::SelfTurn,
        scenario_note: None,
        call_offer: None,
        ai_decision: None,
        riichi_triggers: Vec::new(),
        dama_reasons: Vec::new(),
        shouminkan_triggers: Vec::new(),
        book_rationale: None,
        can_riichi: false,
        hand_string: format_hand_compact(&concealed),
        tiles: concealed.iter().map(ToString::to_string).collect(),
        shanten: metrics.shanten,
        is_agari: metrics.is_agari,
        decompositions_count: metrics.decompositions_count,
        ukeire_tiles: metrics.ukeire_tiles,
        ukeire_total: metrics.ukeire_total,
        round_wind: Wind::East,
        hand_number: 1,
        honba: 0,
        riichi_sticks: 0,
        dora_indicators: vec!["1p".to_string()],
        ura_dora_indicators: Vec::new(),
        tiles_remaining: 50,
        current_turn: 0,
        players: vec![
            human,
            player(
                1,
                Wind::South,
                &[
                    "1m", "1m", "2m", "3m", "4p", "5p", "6p", "7s", "8s", "9s", "2z", "3z", "4z",
                ],
                None,
                turn,
            ),
            player(
                2,
                Wind::West,
                &[
                    "2m", "2m", "3m", "4m", "5p", "6p", "7p", "1s", "2s", "3s", "5z", "6z", "7z",
                ],
                None,
                turn,
            ),
            player(
                3,
                Wind::North,
                &[
                    "3m", "3m", "4m", "5m", "6p", "7p", "8p", "2s", "3s", "4s", "1z", "5z", "6z",
                ],
                None,
                turn,
            ),
        ],
    }
}

/// A state from a 14-tile human hand (13 standing plus the draw).
fn base_state(human: &[&str], turn: usize) -> GameState {
    assert_eq!(human.len(), 14, "a fixture hand is 13 tiles plus the draw");
    let (standing, draw) = human.split_at(13);
    state_from(standing, draw.first().copied(), turn)
}

fn snapshot(mut state: GameState, kind: DecisionKind) -> DecisionSnapshot {
    let legal = legal_actions(&state);
    let played = legal
        .iter()
        .find(|action| action.kind == ActionKind::Discard)
        .cloned()
        .unwrap_or_else(pass_action);
    state.decision = match kind {
        DecisionKind::SelfTurn => DecisionContext::SelfTurn,
        _ => DecisionContext::ReactToDiscard {
            from: 1,
            tile: state
                .players
                .get(1)
                .and_then(|player| player.discards.last())
                .map_or_else(|| "1z".to_string(), |discard| discard.tile.clone()),
        },
    };
    DecisionSnapshot {
        decision_id: "fixture".to_string(),
        replay_id: ReplayId::from_bytes(b"fixture"),
        kyoku_index: 0,
        kyoku: 1,
        event_index: 0,
        line: 1,
        seat: 0,
        kind,
        state,
        legal_actions: legal,
        played: played.clone(),
        played_is_legal: true,
        waits: Vec::new(),
        furiten: false,
        ura_dora_indicators: Vec::new(),
        wall_draws: 0,
        warnings: Vec::new(),
    }
}

fn pass_action() -> ActionInfo {
    ActionInfo {
        action: "Pass".to_string(),
        label: "Pass".to_string(),
        kind: ActionKind::Pass,
        tile_index: None,
        tile: None,
        tiles: Vec::new(),
        kan_kind: None,
    }
}

fn discard(code: &str) -> ActionInfo {
    crate::ai::actions::discard_info(code, false).expect("a valid discard")
}

/// Every 1-shanten discard plan, value included, for the fixture assertions.
fn all_plans(state: &GameState) -> Vec<DiscardPlan> {
    let snap = snapshot(state.clone(), DecisionKind::SelfTurn);
    let mut plans = acceptance_plans(&snap);
    fill_plan_values(state, &mut plans);
    plans
}

fn with_played(mut snapshot: DecisionSnapshot, played: ActionInfo) -> DecisionSnapshot {
    snapshot.played = played;
    snapshot
}

/// Mark seat 3 (last in the opening rotation) as the Riichi threat with a
/// tenpai hand and a chosen river. Using the last seat keeps every other river's
/// discards at or before the declaration, so no tile becomes an accidental
/// post-Riichi genbutsu.
fn make_threat(state: &mut GameState, river: &[&str], tenpai: bool) {
    let threat = &mut state.players[3];
    threat.is_riichi = true;
    threat.discards = river
        .iter()
        .enumerate()
        .map(|(index, tile)| {
            if index + 1 == river.len() {
                DiscardTile::riichi(*tile)
            } else {
                DiscardTile::new(*tile)
            }
        })
        .collect();
    threat.riichi_discard_index = river.len().checked_sub(1);
    threat.hand = if tenpai {
        codes(&[
            "1m", "2m", "3m", "4p", "5p", "6p", "7s", "8s", "9s", "5z", "5z", "5z", "1z",
        ])
    } else {
        codes(&[
            "1m", "4m", "7m", "2p", "5p", "8p", "3s", "6s", "9s", "1z", "2z", "3z", "4z",
        ])
    };
}

// --- Hands ---------------------------------------------------------------

/// A quiet, far-from-tenpai hand: no trigger should fire.
const QUIET_HAND: &[&str] = &[
    "1m", "4m", "7m", "2p", "5p", "8p", "3s", "6s", "9s", "1z", "2z", "3z", "4z", "5m",
];

/// 1-shanten, no divergence: every legal discard keeps the same acceptance and
/// value. Found by the diagnostic below.
const NO_DIVERGENCE_HAND: &[&str] = &[
    "1m", "2m", "3m", "4p", "5p", "6p", "7s", "8s", "7p", "8p", "5z", "5z", "9m", "6m",
];

/// 1-shanten with a genuine speed/value split: discarding 1z keeps the most
/// acceptance with no yaku, discarding 4p keeps the East pair's value.
const OFFENSIVE_HAND: &[&str] = &[
    "1m", "2m", "3m", "4p", "5p", "6p", "7s", "8s", "7p", "8p", "5z", "5z", "1z", "1z",
];

/// 1-shanten with 9p, which the threat river makes genbutsu.
const DEFENSIVE_HAND: &[&str] = &[
    "1m", "2m", "3m", "4p", "5p", "6p", "7s", "8s", "9s", "1z", "1z", "5z", "5z", "9p",
];

/// 1-shanten with nothing the threat's pinzu river makes safe.
const NO_SAFE_HAND: &[&str] = &[
    "1m", "2m", "3m", "4m", "5m", "6m", "7m", "8m", "9m", "1s", "1s", "1z", "1z", "5m",
];

// --- Cases ---------------------------------------------------------------

struct Case {
    name: &'static str,
    snapshot: DecisionSnapshot,
    label: Option<ModelLabel>,
    cuts: Option<LabelCuts>,
    /// Triggers this case proves must fire.
    expected: BTreeSet<TriggerKind>,
    /// Triggers this case proves must not fire. A trigger in neither set is
    /// unconstrained: real boards overlap (a defence board can also be a book
    /// cell), so a fixture only asserts the trigger it is about.
    unexpected: BTreeSet<TriggerKind>,
}

fn case(
    name: &'static str,
    snapshot: DecisionSnapshot,
    expected: &[TriggerKind],
    unexpected: &[TriggerKind],
) -> Case {
    Case {
        name,
        snapshot,
        label: None,
        cuts: None,
        expected: expected.iter().copied().collect(),
        unexpected: unexpected.iter().copied().collect(),
    }
}

fn labelled_case(
    name: &'static str,
    snapshot: DecisionSnapshot,
    label: ModelLabel,
    cuts: LabelCuts,
    expected: &[TriggerKind],
    unexpected: &[TriggerKind],
) -> Case {
    Case {
        name,
        snapshot,
        label: Some(label),
        cuts: Some(cuts),
        expected: expected.iter().copied().collect(),
        unexpected: unexpected.iter().copied().collect(),
    }
}

const ALL: &[TriggerKind] = &TriggerKind::ALL;

fn trigger_cases() -> Vec<Case> {
    let mut cases = Vec::new();

    // Defensive positives and near misses.
    let mut defensive = base_state(DEFENSIVE_HAND, 6);
    make_threat(&mut defensive, &["9p", "1z", "2z", "3z", "4z", "6p"], true);
    cases.push(case(
        "defensive_positive",
        snapshot(defensive, DecisionKind::SelfTurn),
        &[TriggerKind::DefensiveRiichi],
        &[],
    ));

    let no_riichi = base_state(DEFENSIVE_HAND, 7);
    cases.push(case(
        "defensive_no_riichi",
        snapshot(no_riichi, DecisionKind::SelfTurn),
        &[],
        &[TriggerKind::DefensiveRiichi],
    ));

    let mut no_safe = base_state(NO_SAFE_HAND, 6);
    make_threat(&mut no_safe, &["1p", "2p", "3p", "4p", "5p", "6p"], true);
    cases.push(case(
        "defensive_no_safe_tile",
        snapshot(no_safe, DecisionKind::SelfTurn),
        &[],
        &[TriggerKind::DefensiveRiichi],
    ));

    let mut too_far = state_from(
        &[
            "1m", "4m", "7m", "2p", "5p", "8p", "3s", "6s", "9s", "1z", "2z", "3z", "9p",
        ],
        Some("5m"),
        6,
    );
    make_threat(&mut too_far, &["9p", "1z", "2z", "3z", "4z", "6p"], true);
    cases.push(case(
        "defensive_too_far_from_tenpai",
        snapshot(too_far, DecisionKind::SelfTurn),
        &[],
        &[TriggerKind::DefensiveRiichi],
    ));

    let mut threat_not_tenpai = base_state(DEFENSIVE_HAND, 6);
    make_threat(
        &mut threat_not_tenpai,
        &["9p", "1z", "2z", "3z", "4z", "6p"],
        false,
    );
    cases.push(case(
        "defensive_threat_not_tenpai",
        snapshot(threat_not_tenpai, DecisionKind::SelfTurn),
        &[],
        &[TriggerKind::DefensiveRiichi],
    ));

    // Offensive positives and near misses.
    let offensive = base_state(OFFENSIVE_HAND, 7);
    cases.push(case(
        "offensive_positive",
        snapshot(offensive, DecisionKind::SelfTurn),
        &[TriggerKind::OffensiveArchitecture],
        &[],
    ));

    let early = base_state(OFFENSIVE_HAND, 3);
    cases.push(case(
        "offensive_too_early",
        snapshot(early, DecisionKind::SelfTurn),
        &[],
        &[TriggerKind::OffensiveArchitecture],
    ));

    let late = base_state(OFFENSIVE_HAND, 13);
    cases.push(case(
        "offensive_too_late",
        snapshot(late, DecisionKind::SelfTurn),
        &[],
        &[TriggerKind::OffensiveArchitecture],
    ));

    let no_divergence = base_state(NO_DIVERGENCE_HAND, 7);
    cases.push(case(
        "offensive_no_divergence",
        snapshot(no_divergence, DecisionKind::SelfTurn),
        &[],
        &[TriggerKind::OffensiveArchitecture],
    ));

    let mut riichi_active = base_state(OFFENSIVE_HAND, 7);
    make_threat(&mut riichi_active, &["1p", "2p", "3p"], true);
    cases.push(case(
        "offensive_with_active_riichi",
        snapshot(riichi_active, DecisionKind::SelfTurn),
        &[],
        &[TriggerKind::OffensiveArchitecture],
    ));

    // A generated book lesson: the classifier seam, not a hand-scripted rule.
    let book_state = generate_puzzle("fold_to_riichi").expect("the lesson generates");
    cases.push(case(
        "book_positive",
        snapshot(book_state, DecisionKind::SelfTurn),
        &[TriggerKind::Book],
        &[],
    ));

    // Calls and kans.
    let reaction = state_from(
        &[
            "5p", "5p", "5p", "1m", "2m", "3m", "7s", "8s", "9s", "1z", "2z", "3z", "4z",
        ],
        None,
        7,
    );
    let mut reaction = snapshot(reaction, DecisionKind::Call);
    reaction.state.decision = DecisionContext::ReactToDiscard {
        from: 1,
        tile: "5p".to_string(),
    };
    reaction.legal_actions = legal_actions(&reaction.state);
    cases.push(case(
        "call_kan_positive",
        reaction,
        &[TriggerKind::CallKan],
        &[],
    ));

    let quiet = base_state(QUIET_HAND, 3);
    cases.push(case(
        "call_kan_negative",
        snapshot(quiet, DecisionKind::SelfTurn),
        &[],
        &[TriggerKind::CallKan],
    ));

    // Score and placement.
    let mut all_last = base_state(QUIET_HAND, 3);
    all_last.round_wind = Wind::South;
    all_last.hand_number = 4;
    cases.push(case(
        "score_all_last",
        snapshot(all_last, DecisionKind::SelfTurn),
        &[TriggerKind::ScorePlacement],
        &[],
    ));

    let mut honba = base_state(QUIET_HAND, 3);
    honba.honba = 1;
    cases.push(case(
        "score_honba",
        snapshot(honba, DecisionKind::SelfTurn),
        &[TriggerKind::ScorePlacement],
        &[],
    ));

    let mut large_gap = base_state(QUIET_HAND, 3);
    large_gap.players[0].score = 40_000;
    large_gap.players[1].score = 25_000;
    large_gap.players[2].score = 20_000;
    large_gap.players[3].score = 15_000;
    cases.push(case(
        "score_large_gap",
        snapshot(large_gap, DecisionKind::SelfTurn),
        &[TriggerKind::ScorePlacement],
        &[],
    ));

    let neutral = base_state(QUIET_HAND, 3);
    cases.push(case(
        "score_negative",
        snapshot(neutral, DecisionKind::SelfTurn),
        &[],
        &[TriggerKind::ScorePlacement],
    ));

    // A fully quiet board: no trigger at all.
    let all_quiet = base_state(QUIET_HAND, 3);
    cases.push(case(
        "fully_quiet",
        snapshot(all_quiet, DecisionKind::SelfTurn),
        &[],
        ALL,
    ));

    // Label-derived triggers. The quiet state keeps the cheap triggers silent.
    let key = "self_turn/early";
    let close_cuts = cuts_for(
        key,
        TriggerKind::CloseCall,
        &[0.0, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07],
    );
    let blunder_cuts = cuts_for(
        key,
        TriggerKind::Blunder,
        &[0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7],
    );
    let quiet = base_state(QUIET_HAND, 3);

    cases.push(labelled_case(
        "close_call_positive",
        with_played(
            snapshot(quiet.clone(), DecisionKind::SelfTurn),
            discard("9m"),
        ),
        label("Discard_1m", "Discard_9m", 1.0, 0.95, 0.0),
        LabelCuts {
            close_call: close_cuts.clone(),
            blunder: blunder_cuts.clone(),
        },
        &[TriggerKind::CloseCall],
        &[],
    ));
    cases.push(labelled_case(
        "close_call_negative",
        with_played(
            snapshot(quiet.clone(), DecisionKind::SelfTurn),
            discard("9m"),
        ),
        label("Discard_1m", "Discard_9m", 1.0, 0.5, 0.5),
        LabelCuts {
            close_call: close_cuts,
            blunder: blunder_cuts.clone(),
        },
        &[],
        &[TriggerKind::CloseCall],
    ));
    cases.push(labelled_case(
        "blunder_positive",
        with_played(
            snapshot(quiet.clone(), DecisionKind::SelfTurn),
            discard("9m"),
        ),
        label("Discard_1m", "Discard_9m", 2.0, 0.0, 0.5),
        LabelCuts {
            close_call: close_cuts_for_middle(),
            blunder: blunder_cuts.clone(),
        },
        &[TriggerKind::Blunder],
        &[],
    ));
    cases.push(labelled_case(
        "blunder_negative",
        with_played(snapshot(quiet, DecisionKind::SelfTurn), discard("1m")),
        label("Discard_1m", "Discard_1m", 2.0, 2.0, 0.5),
        LabelCuts {
            close_call: close_cuts_for_middle(),
            blunder: blunder_cuts,
        },
        &[],
        &[TriggerKind::Blunder],
    ));

    cases
}

fn cuts_for(key: &str, _trigger: TriggerKind, samples: &[f32]) -> PercentileCuts {
    let cut = PercentileCut::from_samples(key, samples, PercentileThresholds::default());
    PercentileCuts {
        families: BTreeMap::from([(key.to_string(), cut)]),
    }
}

/// A close-cut family whose cut is low enough that a 0.5 gap is not close.
fn close_cuts_for_middle() -> PercentileCuts {
    cuts_for(
        "self_turn/early",
        TriggerKind::CloseCall,
        &[0.0, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07],
    )
}

fn label(top: &str, played: &str, top_q: f32, played_q: f32, top2_gap: f32) -> ModelLabel {
    let ranking = vec![ranked(top, top_q, 0.6), ranked(played, played_q, 0.35)];
    let q_values = BTreeMap::from([(top.to_string(), top_q), (played.to_string(), played_q)]);
    ModelLabel {
        schema: MODEL_LABEL_SCHEMA.to_string(),
        version: 1,
        classifier_version: CLASSIFIER_VERSION.to_string(),
        model: "fixture.safetensors".to_string(),
        model_sha256: "a".repeat(64),
        gamma: None,
        pts: None,
        q_units: Q_UNITS.to_string(),
        value_units: VALUE_UNITS.to_string(),
        expected_value: 0.0,
        top_action: top.to_string(),
        top_probability: 0.6,
        probability_margin: top2_gap,
        q_gap_top2: Some(top2_gap),
        q_gap_safe: None,
        safe_action: None,
        riichi_discard: None,
        ranking,
        q_values,
        book: None,
        book_conflict: None,
        label_kind: Some(LabelKind::Mortal),
        stability: None,
        consensus: None,
        calibration_version: None,
        expected_point_diffs: None,
        generator: None,
        note: Q_UNITS_NOTE.to_string(),
    }
}

fn ranked(action: &str, q_value: f32, probability: f32) -> RankedAction {
    let tile = action.strip_prefix("Discard_").map(str::to_string);
    RankedAction {
        action: action.to_string(),
        label: action.replace('_', " "),
        kind: ActionKind::Discard,
        tile,
        probability,
        q_value: Some(q_value),
    }
}

// --- Tests ---------------------------------------------------------------

#[test]
fn fixtures_fire_and_do_not_fire_correctly() {
    for case in trigger_cases() {
        let report = case_report(&case);
        for trigger in TriggerKind::ALL {
            if case.expected.contains(&trigger) {
                assert!(
                    report.fired(trigger),
                    "{}: expected {} to fire; report {:?}",
                    case.name,
                    trigger,
                    report
                );
            }
            if case.unexpected.contains(&trigger) {
                assert!(
                    !report.fired(trigger),
                    "{}: expected {} not to fire; report {:?}",
                    case.name,
                    trigger,
                    report
                );
            }
        }
        if case.name == "fully_quiet" {
            assert!(
                report.hits.is_empty(),
                "the quiet fixture must fire nothing: {report:?}"
            );
        }
    }
}

fn case_report(case: &Case) -> TriggerReport {
    match (&case.label, &case.cuts) {
        (Some(label), Some(cuts)) => {
            evaluate_with_label(&case.snapshot, label, cuts, &TriggerConfig::default())
        }
        _ => evaluate_cheap(&case.snapshot, &TriggerConfig::default()),
    }
}

#[test]
fn the_fixture_set_has_perfect_trigger_precision_and_recall() {
    let cases = trigger_cases();
    let mut true_positive = BTreeMap::<TriggerKind, u64>::new();
    let mut false_positive = BTreeMap::<TriggerKind, u64>::new();
    let mut false_negative = BTreeMap::<TriggerKind, u64>::new();
    let mut negatives = BTreeMap::<TriggerKind, u64>::new();
    for case in &cases {
        let report = case_report(case);
        for trigger in TriggerKind::ALL {
            let fired = report.fired(trigger);
            let positive = case.expected.contains(&trigger);
            let negative = case.unexpected.contains(&trigger);
            if positive && fired {
                *true_positive.entry(trigger).or_insert(0) += 1;
            }
            if positive && !fired {
                *false_negative.entry(trigger).or_insert(0) += 1;
            }
            if negative {
                *negatives.entry(trigger).or_insert(0) += 1;
                if fired {
                    *false_positive.entry(trigger).or_insert(0) += 1;
                }
            }
        }
    }
    for trigger in TriggerKind::ALL {
        let tp = true_positive.get(&trigger).copied().unwrap_or(0);
        let fp = false_positive.get(&trigger).copied().unwrap_or(0);
        let fnn = false_negative.get(&trigger).copied().unwrap_or(0);
        let neg = negatives.get(&trigger).copied().unwrap_or(0);
        assert!(tp > 0, "{} has no positive fixture", trigger);
        assert!(neg > 0, "{} has no negative fixture", trigger);
        assert_eq!(fp, 0, "{} has {} false positive(s)", trigger, fp);
        assert_eq!(fnn, 0, "{} has {} false negative(s)", trigger, fnn);
        let precision = tp as f64 / (tp + fp) as f64;
        let recall = tp as f64 / (tp + fnn) as f64;
        assert!((precision - 1.0).abs() < f64::EPSILON);
        assert!((recall - 1.0).abs() < f64::EPSILON);
    }
}

#[test]
fn a_book_lesson_fires_the_book_trigger_and_a_quiet_hand_does_not() {
    let state = generate_puzzle("fold_to_riichi").expect("the lesson generates");
    let book = snapshot(state, DecisionKind::SelfTurn);
    assert!(
        classify_decision(&book).expect("no conflict").is_some(),
        "the generated lesson must classify"
    );
    let report = evaluate_cheap(&book, &TriggerConfig::default());
    assert!(
        report.fired(TriggerKind::Book),
        "a generated book state must fire the book trigger: {report:?}"
    );
    let code = report
        .hits
        .iter()
        .find(|hit| hit.trigger == TriggerKind::Book)
        .map(|hit| hit.code.as_str())
        .expect("a book hit");
    assert!(
        code.starts_with("book:ch"),
        "a book hit records its book section: {code}"
    );

    let quiet = snapshot(base_state(QUIET_HAND, 3), DecisionKind::SelfTurn);
    assert_eq!(
        classify_decision(&quiet).expect("no conflict"),
        None,
        "the quiet fixture must not be a book cell"
    );
    let report = evaluate_cheap(&quiet, &TriggerConfig::default());
    assert!(!report.fired(TriggerKind::Book), "{report:?}");
}

#[test]
fn the_offensive_fixture_really_has_a_speed_value_divergence() {
    let state = base_state(OFFENSIVE_HAND, 7);
    assert_eq!(state.shanten, 1, "the fixture must be 1-shanten");
    let plans = all_plans(&state);
    let (speed, value) =
        divergent_pair(&plans, &TriggerConfig::default()).expect("the fixture must diverge");
    assert_eq!(speed.tile, "1z");
    assert_eq!(value.tile, "4p");
    assert!(speed.ukeire >= value.ukeire + 2);
    assert!(value.value >= speed.value + 1_000);
}

#[test]
fn the_no_divergence_fixture_has_equal_plans() {
    let state = base_state(NO_DIVERGENCE_HAND, 7);
    assert_eq!(state.shanten, 1);
    let plans = all_plans(&state);
    assert!(
        divergent_pair(&plans, &TriggerConfig::default()).is_none(),
        "the near-miss hand must not diverge: {plans:?}"
    );
}

#[test]
fn a_trigger_filter_rejects_label_derived_triggers() {
    let error = TriggerFilter::parse(&["close_call".to_string()]).expect_err("needs a label");
    assert!(matches!(error, TriggerError::LabelDerivedPrefilter { .. }));
    let filter = TriggerFilter::parse(&["book".to_string(), "defensive".to_string()])
        .expect("cheap triggers")
        .expect("a filter");
    assert_eq!(
        filter.enabled(),
        vec![TriggerKind::Book, TriggerKind::DefensiveRiichi]
    );
    assert!(TriggerFilter::parse(&[]).expect("no names").is_none());
    assert!(TriggerFilter::parse(&["nope".to_string()]).is_err());
}

#[test]
fn a_report_writes_its_primary_reason_and_keeps_every_hit() {
    let mut state = base_state(OFFENSIVE_HAND, 7);
    state.honba = 1;
    let snapshot = snapshot(state, DecisionKind::SelfTurn);
    let report = evaluate_cheap(&snapshot, &TriggerConfig::default());
    assert!(
        report.fired(TriggerKind::OffensiveArchitecture)
            && report.fired(TriggerKind::ScorePlacement)
    );
    assert_eq!(report.primary_code(), Some("offensive_architecture"));
    let json = report.to_json().expect("serialise");
    let parsed: TriggerReport = serde_json::from_str(&json).expect("parse");
    assert_eq!(parsed, report);
    assert_eq!(parsed.families, report.families);
    assert!(parsed.families.contains(&Family::SpeedValue));
    assert!(parsed.families.contains(&Family::Placement));
}

#[test]
fn the_family_mapping_covers_every_trigger() {
    for trigger in TriggerKind::ALL {
        assert!(!trigger.as_str().is_empty());
        let families: BTreeSet<Family> =
            families_for(&[TriggerHit::new(trigger, trigger.as_str(), "")], None);
        assert!(
            !families.is_empty(),
            "{} maps to no family",
            trigger.as_str()
        );
    }
}

#[test]
fn the_config_rejects_an_impossible_window() {
    let mut config = TriggerConfig::default();
    config.validate().expect("defaults are usable");
    config.offensive_turns = (12, 5);
    assert!(matches!(
        config.validate(),
        Err(TriggerError::InvalidConfig { .. })
    ));
    config = TriggerConfig {
        defensive_max_shanten: 9,
        ..TriggerConfig::default()
    };
    assert!(config.validate().is_err());
}

#[test]
fn a_report_writes_its_primary_reason_onto_an_existing_decision_row() {
    let connection = Connection::open_in_memory().expect("memory db");
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .expect("foreign keys");
    migrate(&connection).expect("migrate");
    let replay_id = "a".repeat(64);
    connection
        .execute(
            "INSERT INTO replays (
                replay_id, source, licence, attribution, format, rule,
                rule_config_hash, generated_at, model, model_sha256, seed,
                log_path, log_bytes, log_sha256, validation_status,
                ingested_at, corpus_id, family, match_plan_id,
                match_plan_sha256, agents, provenance_json
             ) VALUES (?1, 'ai_selfplay', 'CC-BY-4.0', 'fixture', 'mjai',
                'tenhou-4p-hanchan', ?2, '2026-11-16T00:00:00Z',
                'akochan-1.0', ?3, '0x01', ?4, 10, ?5, 'ok',
                '2026-11-16T00:01:00Z', 'mixed-2026-11', 'mortal_mirror',
                'm1', ?6, '[]', '{}')",
            params![
                replay_id,
                "b".repeat(64),
                "c".repeat(64),
                format!("replays/mortal_mirror/{replay_id}.jsonl.gz"),
                "d".repeat(64),
                "e".repeat(64),
            ],
        )
        .expect("replay row");
    connection
        .execute(
            "INSERT INTO decisions (
                decision_id, replay_id, family, kyoku, honba, event_index, turn,
                seat, decision_kind, state_hash, state_json, legal_actions,
                played_action
             ) VALUES ('d1', ?1, 'mortal_mirror', 0, 0, 0, 0, 0, 'self_turn',
                'h', '{}', '[]', '{}')",
            params![replay_id],
        )
        .expect("decision row");

    let mut state = base_state(OFFENSIVE_HAND, 7);
    state.honba = 1;
    let report = evaluate_cheap(
        &snapshot(state, DecisionKind::SelfTurn),
        &TriggerConfig::default(),
    );
    assert!(report.fired(TriggerKind::OffensiveArchitecture));
    assert!(report.fired(TriggerKind::ScorePlacement));
    assert_eq!(
        record_triggers(&connection, "d1", &report).expect("write"),
        1
    );
    let (trigger, detail): (Option<String>, Option<String>) = connection
        .query_row(
            "SELECT trigger, trigger_detail FROM decisions WHERE decision_id = 'd1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("trigger columns");
    assert_eq!(trigger.as_deref(), Some("offensive_architecture"));
    let parsed: TriggerReport =
        serde_json::from_str(detail.as_deref().expect("detail json")).expect("parse");
    assert_eq!(parsed, report);

    // A rerun with a narrower filter must not leave a stale reason behind.
    let quiet = evaluate_cheap(
        &snapshot(base_state(QUIET_HAND, 3), DecisionKind::SelfTurn),
        &TriggerConfig::default(),
    );
    assert!(!quiet.has_any());
    assert_eq!(
        record_triggers(&connection, "d1", &quiet).expect("clear"),
        1
    );
    let (trigger, detail): (Option<String>, Option<String>) = connection
        .query_row(
            "SELECT trigger, trigger_detail FROM decisions WHERE decision_id = 'd1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("cleared columns");
    assert!(trigger.is_none());
    assert!(detail.is_none());

    // A decision with no row is a no-op, not an error.
    assert_eq!(
        record_triggers(&connection, "missing", &report).expect("no row"),
        0
    );
}

#[test]
fn a_corpus_sample_report_measures_labels_and_families() {
    use super::report::{TriggerSampleOptions, run_trigger_sample};
    use crate::miner::label::{LabelOptions, state_hash};
    use crate::miner::storage::{DataRoot, open_miner_db};
    use crate::replay::fixtures;

    let temp = tempfile::tempdir().expect("tempdir");
    let root = DataRoot::new(temp.path().join("data")).expect("data root");
    let bytes = fixtures::gzip(&fixtures::to_jsonl(&fixtures::all_events_game()));
    let family = root.replays_dir().join("mortal_mirror");
    std::fs::create_dir_all(&family).expect("family dir");
    std::fs::write(family.join(format!("{}.jsonl.gz", "f".repeat(64))), &bytes)
        .expect("replay file");

    // Put one cached label on the first decision, so the sample has a
    // label-derived pass without loading weights.
    let file = crate::replay::mjai::ReplayReader::read_gzip(&bytes).expect("fixture parses");
    let walk = crate::replay::walk::walk_replay(&file, ReplayId::from_bytes(&bytes))
        .expect("fixture validates");
    let first = &walk.decisions[0];
    let connection = open_miner_db(&root).expect("miner db");
    let cached = label("Discard_1m", "Discard_9m", 1.0, 0.95, 0.0);
    connection
        .execute(
            "INSERT INTO model_labels (
                state_hash, model_sha256, classifier_version, options_hash,
                status, attempts, label_json, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, 'ok', 1, ?5,
                '2026-11-16T00:00:00Z', '2026-11-16T00:00:00Z')",
            params![
                state_hash(&first.state),
                "a".repeat(64),
                CLASSIFIER_VERSION,
                LabelOptions::default().options_hash(),
                serde_json::to_string(&cached).expect("label json"),
            ],
        )
        .expect("cache row");
    drop(connection);

    let report = run_trigger_sample(&root, &TriggerSampleOptions::default()).expect("report");
    assert_eq!(report.replays_found, 1);
    assert_eq!(report.replays_walked, 1);
    assert_eq!(report.replays_failed, 0);
    assert!(report.decisions_seen > 0);
    assert_eq!(report.decisions_seen, walk.decisions.len() as u64);
    assert!(report.decisions_triggered > 0);
    assert_eq!(report.labelled_decisions, 1);
    assert_eq!(report.label_source, "cache");
    assert_eq!(report.label_models.len(), 1);
    assert_eq!(
        report.decision_rows_updated, 0,
        "no extracted rows exist yet"
    );
    assert!(!report.replay_families.is_empty());
    assert_eq!(report.replay_families[0].0, "mortal_mirror");
    assert!(!report.families.is_empty());

    let book = report
        .triggers
        .iter()
        .find(|stats| stats.trigger == TriggerKind::Book)
        .expect("book stats");
    assert!(book.fired > 0, "the fixture has book cells");
    assert_eq!(book.measured, book.fired);
    assert_eq!(book.precision, Some(1.0));
    assert_eq!(book.recall, Some(1.0));

    let summary = report.human_summary();
    assert!(summary.contains("trigger"));
    assert!(summary.contains("book"));
    assert!(summary.contains("families:"));
}

#[test]
fn a_malformed_table_is_not_evaluated() {
    let mut state = base_state(QUIET_HAND, 3);
    state.players.clear();
    let report = evaluate_cheap(
        &snapshot(state, DecisionKind::SelfTurn),
        &TriggerConfig::default(),
    );
    assert!(!report.has_any());
    assert!(
        report
            .notes
            .iter()
            .any(|note| note.contains("expected four players")),
        "{report:?}"
    );
}
