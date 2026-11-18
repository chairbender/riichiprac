//! S3 selector fixtures.
//!
//! Each selector gets a positive and a near-miss negative, plus the two
//! properties the unit must never violate: an accepted answer is a legal
//! action, and a blunder verdict does not change when the score or the ura
//! indicators change.

use std::collections::BTreeMap;

use super::*;
use crate::decision::ActionKind;
use crate::generator::{evaluate_hand, format_hand_compact};
use crate::miner::label::thresholds::{PercentileCut, PercentileCuts, PercentileThresholds};
use crate::miner::label::{CLASSIFIER_VERSION, LabelKind, Q_UNITS, Q_UNITS_NOTE, RankedAction};
use crate::miner::provenance::ReplayId;
use crate::state::{CorrectAction, DecisionContext, DiscardTile, GameState, PlayerState, Wind};

const CLOSE_HAND: &[&str] = &[
    "1m", "2m", "3m", "4p", "5p", "6p", "7s", "8s", "9s", "1z", "1z", "5z", "5z", "9p",
];
const MIRROR_HAND: &[&str] = &[
    "1m", "2m", "3m", "7m", "8m", "9m", "1p", "2p", "3p", "7p", "8p", "9p", "5s", "5s",
];
const OFFENSIVE_HAND: &[&str] = &[
    "1m", "2m", "3m", "4p", "5p", "6p", "7s", "8s", "7p", "8p", "5z", "5z", "1z", "1z",
];
const NO_DIVERGENCE_HAND: &[&str] = &[
    "1m", "2m", "3m", "4p", "5p", "6p", "7s", "8s", "7p", "8p", "5z", "5z", "9m", "6m",
];

fn codes(tiles: &[&str]) -> Vec<String> {
    tiles.iter().map(|tile| (*tile).to_string()).collect()
}

fn river_tile(seat: usize, index: usize) -> String {
    let honors = ["1z", "2z", "3z", "4z", "5z", "6z", "7z"];
    honors[(seat * 3 + index) % honors.len()].to_string()
}

fn player(seat: usize, wind: Wind, hand: &[&str], turn: usize) -> PlayerState {
    PlayerState {
        seat,
        name: format!("seat{seat}"),
        is_human: seat == 0,
        wind,
        score: 25_000,
        hand: codes(hand),
        draw: None,
        red_fives: Vec::new(),
        discards: (0..turn)
            .map(|index| DiscardTile::new(river_tile(seat, index)))
            .collect(),
        melds: Vec::new(),
        is_riichi: false,
        riichi_discard_index: None,
    }
}

/// A legal 14-tile self-turn state (13 standing tiles plus the draw).
fn state(hand: &[&str], turn: usize) -> GameState {
    assert_eq!(hand.len(), 14, "a fixture hand is 13 tiles plus the draw");
    let (standing, draw) = hand.split_at(13);
    let mut human = player(0, Wind::East, standing, turn);
    human.draw = draw.first().map(|tile| (*tile).to_string());
    let concealed: Vec<agari::tile::Tile> = hand
        .iter()
        .filter_map(|code| agari::tile::Tile::try_from(*code).ok())
        .collect();
    let metrics = evaluate_hand(&concealed);
    GameState {
        category: "fixture".to_string(),
        target_action: crate::state::TargetAction::Best,
        correct_action: CorrectAction::best("Pass", None, Vec::new(), "Pass".to_string()),
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
                turn,
            ),
            player(
                2,
                Wind::West,
                &[
                    "2m", "2m", "3m", "4m", "5p", "6p", "7p", "1s", "2s", "3s", "5z", "6z", "7z",
                ],
                turn,
            ),
            player(
                3,
                Wind::North,
                &[
                    "3m", "3m", "4m", "5m", "6p", "7p", "8p", "2s", "3s", "4s", "1z", "5z", "6z",
                ],
                turn,
            ),
        ],
    }
}

fn snapshot(state: GameState, kind: DecisionKind) -> DecisionSnapshot {
    let legal = crate::ai::actions::legal_actions(&state);
    let played = legal
        .iter()
        .find(|action| action.kind == ActionKind::Discard)
        .cloned()
        .unwrap_or_else(|| legal[0].clone());
    let mut state = state;
    state.decision = match kind {
        DecisionKind::SelfTurn => DecisionContext::SelfTurn,
        _ => DecisionContext::ReactToDiscard {
            from: 1,
            tile: "1z".to_string(),
        },
    };
    DecisionSnapshot {
        decision_id: "s3-fixture".to_string(),
        replay_id: ReplayId::from_bytes(b"s3-fixture"),
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

fn ranked(action: &str, probability: f32, q: f32) -> RankedAction {
    RankedAction {
        action: action.to_string(),
        label: action.replace('_', " "),
        kind: ActionKind::Discard,
        tile: action.strip_prefix("Discard_").map(str::to_string),
        probability,
        q_value: Some(q),
    }
}

fn label(top: &str, second: &str, top_q: f32, second_q: f32) -> ModelLabel {
    let gap = (top_q - second_q).max(0.0);
    ModelLabel {
        schema: crate::miner::MODEL_LABEL_SCHEMA.to_string(),
        version: 1,
        classifier_version: CLASSIFIER_VERSION.to_string(),
        model: "fixture.safetensors".to_string(),
        model_sha256: "a".repeat(64),
        gamma: None,
        pts: None,
        q_units: Q_UNITS.to_string(),
        value_units: crate::miner::VALUE_UNITS.to_string(),
        expected_value: 0.0,
        top_action: top.to_string(),
        top_probability: 0.6,
        probability_margin: 0.05,
        q_gap_top2: Some(gap),
        q_gap_safe: None,
        safe_action: None,
        riichi_discard: None,
        ranking: vec![ranked(top, 0.6, top_q), ranked(second, 0.35, second_q)],
        q_values: BTreeMap::from([(top.to_string(), top_q), (second.to_string(), second_q)]),
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

/// 20 samples `0.0..=1.9`: close cut 0.1, confidence cut 1.7.
fn cuts_for(family: &str) -> PercentileCuts {
    let samples: Vec<f32> = (0..20).map(|index| index as f32 * 0.1).collect();
    let cut = PercentileCut::from_samples(family, &samples, PercentileThresholds::default());
    PercentileCuts {
        families: BTreeMap::from([(family.to_string(), cut)]),
    }
}

fn label_cuts(family: &str) -> LabelCuts {
    let cuts = cuts_for(family);
    LabelCuts {
        close_call: cuts.clone(),
        blunder: cuts,
    }
}

fn weak() -> SeatPolicy {
    SeatPolicy {
        seat: 0,
        agent_id: "akochan".to_string(),
        kind: AgentKind::Rule,
        engine: "akochan".to_string(),
    }
}

fn strong() -> SeatPolicy {
    SeatPolicy {
        seat: 0,
        agent_id: "mortal-298k".to_string(),
        kind: AgentKind::Neural,
        engine: "mortal-candle".to_string(),
    }
}

// --- Close call ----------------------------------------------------------

#[test]
fn close_call_accepts_a_close_gap_and_marks_it_close() {
    let snap = snapshot(state(CLOSE_HAND, 3), DecisionKind::SelfTurn);
    let label = label("Discard_9p", "Discard_1z", 2.0, 1.95);
    let verdict = close_call_verdict(&snap, Some(&label), &label_cuts("self_turn/early"));
    assert!(verdict.accepted, "{verdict:?}");
    assert!(verdict.close);
    assert_eq!(verdict.band, Some(Band::Close));
    assert_eq!(verdict.sample_size, 20);
    assert_eq!(verdict.answer.as_deref(), Some("Discard_9p"));
    assert_eq!(verdict.actions.len(), 2);
    assert_eq!(verdict.actions[1].role, SpecialRole::CloseAlternative);
}

#[test]
fn close_call_declines_a_middle_gap_and_a_missing_sample() {
    let snap = snapshot(state(CLOSE_HAND, 3), DecisionKind::SelfTurn);
    let middle = label("Discard_9p", "Discard_1z", 2.0, 1.5);
    let verdict = close_call_verdict(&snap, Some(&middle), &label_cuts("self_turn/early"));
    assert!(!verdict.accepted);
    assert_eq!(verdict.decline, Some(Decline::NotClose));
    assert_eq!(
        verdict.band,
        Some(Band::Middle),
        "a measured decline records its band"
    );

    let empty = LabelCuts::empty();
    let verdict = close_call_verdict(&snap, Some(&middle), &empty);
    assert_eq!(verdict.decline, Some(Decline::NoPercentileSample));
    assert_eq!(verdict.band, None, "no sample means no band");

    let verdict = close_call_verdict(&snap, None, &label_cuts("self_turn/early"));
    assert_eq!(verdict.decline, Some(Decline::NoLabel));
}

#[test]
fn a_gap_in_another_family_does_not_borrow_a_cut() {
    let snap = snapshot(state(CLOSE_HAND, 3), DecisionKind::SelfTurn);
    let label = label("Discard_9p", "Discard_1z", 2.0, 1.95);
    let cuts = label_cuts("self_turn/late");
    let verdict = close_call_verdict(&snap, Some(&label), &cuts);
    assert_eq!(verdict.decline, Some(Decline::NoPercentileSample));
}

#[test]
fn structural_symmetry_alone_is_not_an_equivalence_tie() {
    // 1m and 9m are mirror images in this hand, but they are different tiles in
    // the same river: accepting both would grade a genuinely different discard.
    let snap = snapshot(state(MIRROR_HAND, 3), DecisionKind::SelfTurn);
    let label = label("Discard_1m", "Discard_9m", 2.0, 1.95);
    let verdict = close_call_verdict(&snap, Some(&label), &label_cuts("self_turn/early"));
    assert!(verdict.accepted, "{verdict:?}");
    assert!(verdict.accepted_tiles.is_empty());
    assert_eq!(verdict.actions.len(), 2, "the alternative is still shown");
}

#[test]
fn a_classifier_listed_equivalent_tile_is_a_tie() {
    let mut snap = snapshot(state(MIRROR_HAND, 3), DecisionKind::SelfTurn);
    snap.state.equivalent_tiles = vec!["9m".to_string()];
    let label = label("Discard_1m", "Discard_9m", 2.0, 1.95);
    let verdict = close_call_verdict(&snap, Some(&label), &label_cuts("self_turn/early"));
    assert!(verdict.accepted, "{verdict:?}");
    assert_eq!(
        verdict.accepted_tiles,
        vec!["1m".to_string(), "9m".to_string()]
    );
}

#[test]
fn listing_the_answer_itself_does_not_make_the_alternative_equivalent() {
    let mut snap = snapshot(state(MIRROR_HAND, 3), DecisionKind::SelfTurn);
    snap.state.equivalent_tiles = vec!["1m".to_string()];
    let label = label("Discard_1m", "Discard_9m", 2.0, 1.95);
    let verdict = close_call_verdict(&snap, Some(&label), &label_cuts("self_turn/early"));
    assert!(verdict.accepted, "{verdict:?}");
    assert!(
        verdict.accepted_tiles.is_empty(),
        "the classifier listed the answer, not the alternative"
    );
}

#[test]
fn genuinely_different_actions_are_shown_not_graded_as_ties() {
    let snap = snapshot(state(CLOSE_HAND, 3), DecisionKind::SelfTurn);
    let label = label("Discard_9p", "Discard_1z", 2.0, 1.95);
    let verdict = close_call_verdict(&snap, Some(&label), &label_cuts("self_turn/early"));
    assert!(verdict.accepted);
    assert!(
        verdict.accepted_tiles.is_empty(),
        "9p and 1z are different plans, not equivalent tiles"
    );
    assert_eq!(verdict.actions.len(), 2, "the alternative is still shown");
}

// --- Speed vs value ------------------------------------------------------

#[test]
fn speed_value_accepts_a_strict_divergence_and_names_both_plans() {
    let snap = snapshot(state(OFFENSIVE_HAND, 7), DecisionKind::SelfTurn);
    assert_eq!(snap.state.shanten, 1);
    let label = label("Discard_1z", "Discard_4p", 2.0, 1.6);
    let verdict = speed_value_verdict(
        &snap,
        Some(&label),
        &label_cuts("self_turn/mid"),
        &SpecialConfig::default(),
    );
    assert!(verdict.accepted, "{verdict:?}");
    let divergence = verdict.divergence.as_ref().expect("divergence");
    assert_eq!(divergence.speed_action, "Discard_1z");
    assert_eq!(divergence.value_action, "Discard_4p");
    assert_eq!(divergence.answer_plan, AnswerPlan::Speed);
    assert!(divergence.ukeire_gap > 0);
    assert!(divergence.worst_value_gap > 0);
    assert_eq!(verdict.actions.len(), 2);
    assert_eq!(verdict.actions[0].role, SpecialRole::Speed);
    assert_eq!(verdict.actions[1].role, SpecialRole::Value);
    // The label gap 0.4 is outside the 0.1 close cut.
    assert!(!verdict.close);
    assert_eq!(verdict.band, Some(Band::Middle));
}

#[test]
fn speed_value_declines_a_hand_with_no_divergence() {
    let snap = snapshot(state(NO_DIVERGENCE_HAND, 7), DecisionKind::SelfTurn);
    let label = label("Discard_9m", "Discard_6m", 2.0, 1.9);
    let verdict = speed_value_verdict(
        &snap,
        Some(&label),
        &label_cuts("self_turn/mid"),
        &SpecialConfig::default(),
    );
    assert!(!verdict.accepted);
    assert_eq!(verdict.decline, Some(Decline::NoDivergence));
}

#[test]
fn speed_value_declines_a_riichi_table_and_an_out_of_window_turn() {
    let mut riichi = state(OFFENSIVE_HAND, 7);
    riichi.players[2].is_riichi = true;
    let snap = snapshot(riichi, DecisionKind::SelfTurn);
    let label = label("Discard_1z", "Discard_4p", 2.0, 1.6);
    let verdict = speed_value_verdict(
        &snap,
        Some(&label),
        &label_cuts("self_turn/mid"),
        &SpecialConfig::default(),
    );
    assert_eq!(verdict.decline, Some(Decline::RiichiActive));

    let snap = snapshot(state(OFFENSIVE_HAND, 3), DecisionKind::SelfTurn);
    let verdict = speed_value_verdict(
        &snap,
        Some(&label),
        &label_cuts("self_turn/early"),
        &SpecialConfig::default(),
    );
    assert_eq!(verdict.decline, Some(Decline::TurnOutsideWindow));
}

#[test]
fn speed_value_declines_when_the_mortal_answer_is_not_one_of_the_plans() {
    let snap = snapshot(state(OFFENSIVE_HAND, 7), DecisionKind::SelfTurn);
    let other = snap
        .legal_actions
        .iter()
        .find(|action| {
            action.kind == ActionKind::Discard
                && action.tile.as_deref() != Some("1z")
                && action.tile.as_deref() != Some("4p")
        })
        .expect("a third discard")
        .tile
        .clone()
        .expect("tile");
    let label = label(&format!("Discard_{other}"), "Discard_1z", 2.0, 1.9);
    let verdict = speed_value_verdict(
        &snap,
        Some(&label),
        &label_cuts("self_turn/mid"),
        &SpecialConfig::default(),
    );
    assert_eq!(verdict.decline, Some(Decline::AnswerNotInPair));
}

// --- Blunder -------------------------------------------------------------

#[test]
fn blunder_accepts_a_weak_agents_confident_gap() {
    let mut snap = snapshot(state(CLOSE_HAND, 3), DecisionKind::SelfTurn);
    let label = label("Discard_1z", "Discard_9p", 2.0, 0.0);
    snap.played = crate::ai::actions::discard_info("9p", false).expect("legal discard");
    let verdict = blunder_verdict(
        &snap,
        Some(&label),
        &label_cuts("self_turn/early"),
        Some(&weak()),
    );
    assert!(verdict.accepted, "{verdict:?}");
    assert!(!verdict.close);
    assert_eq!(verdict.band, Some(Band::Confident));
    assert_eq!(verdict.answer.as_deref(), Some("Discard_1z"));
    assert_eq!(verdict.actions.len(), 2);
    assert_eq!(verdict.actions[1].role, SpecialRole::Played);
    assert_eq!(
        verdict
            .weak_policy
            .as_ref()
            .map(|policy| policy.agent_id.as_str()),
        Some("akochan")
    );
}

#[test]
fn a_neural_actor_is_not_a_blunder_source() {
    let mut snap = snapshot(state(CLOSE_HAND, 3), DecisionKind::SelfTurn);
    let label = label("Discard_1z", "Discard_9p", 2.0, 0.0);
    snap.played = crate::ai::actions::discard_info("9p", false).expect("legal discard");
    let verdict = blunder_verdict(
        &snap,
        Some(&label),
        &label_cuts("self_turn/early"),
        Some(&strong()),
    );
    assert_eq!(verdict.decline, Some(Decline::ActorNotWeak));
    let verdict = blunder_verdict(&snap, Some(&label), &label_cuts("self_turn/early"), None);
    assert_eq!(verdict.decline, Some(Decline::ActorNotWeak));
}

#[test]
fn blunder_declines_the_top_action_an_unscored_play_and_a_thin_gap() {
    let mut snap = snapshot(state(CLOSE_HAND, 3), DecisionKind::SelfTurn);
    let base = label("Discard_1z", "Discard_9p", 2.0, 0.0);

    snap.played = crate::ai::actions::discard_info("1z", false).expect("legal discard");
    let verdict = blunder_verdict(
        &snap,
        Some(&base),
        &label_cuts("self_turn/early"),
        Some(&weak()),
    );
    assert_eq!(verdict.decline, Some(Decline::PlayedTopAction));

    snap.played = crate::ai::actions::discard_info("9p", false).expect("legal discard");
    let mut unscored = base.clone();
    unscored.q_values.remove("Discard_9p");
    let verdict = blunder_verdict(
        &snap,
        Some(&unscored),
        &label_cuts("self_turn/early"),
        Some(&weak()),
    );
    assert_eq!(verdict.decline, Some(Decline::PlayedUnscored));

    let thin = label("Discard_1z", "Discard_9p", 2.0, 1.5);
    let verdict = blunder_verdict(
        &snap,
        Some(&thin),
        &label_cuts("self_turn/early"),
        Some(&weak()),
    );
    assert_eq!(verdict.decline, Some(Decline::NotConfident));

    let verdict = blunder_verdict(&snap, Some(&thin), &LabelCuts::empty(), Some(&weak()));
    assert_eq!(verdict.decline, Some(Decline::NoPercentileSample));
}

#[test]
fn a_blunder_verdict_never_reads_the_score_or_ura_dora() {
    let mut snap = snapshot(state(CLOSE_HAND, 3), DecisionKind::SelfTurn);
    let label = label("Discard_1z", "Discard_9p", 2.0, 0.0);
    snap.played = crate::ai::actions::discard_info("9p", false).expect("legal discard");
    let baseline = blunder_verdict(
        &snap,
        Some(&label),
        &label_cuts("self_turn/early"),
        Some(&weak()),
    );

    snap.state.players[0].score = 1_000;
    snap.state.players[1].score = 99_000;
    snap.state.honba = 5;
    snap.ura_dora_indicators = vec!["1m".to_string(), "2m".to_string()];
    let changed = blunder_verdict(
        &snap,
        Some(&label),
        &label_cuts("self_turn/early"),
        Some(&weak()),
    );
    assert_eq!(
        baseline, changed,
        "score context and post-answer ura must not change a blunder verdict"
    );
}

// --- Cross-cutting -------------------------------------------------------

#[test]
fn every_accepted_answer_and_tie_is_a_legal_action() {
    let cases = [
        (
            snapshot(state(CLOSE_HAND, 3), DecisionKind::SelfTurn),
            label("Discard_9p", "Discard_1z", 2.0, 1.95),
            "self_turn/early",
        ),
        (
            snapshot(state(MIRROR_HAND, 3), DecisionKind::SelfTurn),
            label("Discard_1m", "Discard_9m", 2.0, 1.95),
            "self_turn/early",
        ),
        (
            snapshot(state(OFFENSIVE_HAND, 7), DecisionKind::SelfTurn),
            label("Discard_1z", "Discard_4p", 2.0, 1.6),
            "self_turn/mid",
        ),
    ];
    for (snap, label, family) in cases {
        let verdicts = evaluate_specials(
            &snap,
            Some(&label),
            &label_cuts(family),
            Some(&weak()),
            &SpecialConfig::default(),
        );
        for verdict in verdicts.into_iter().filter(|verdict| verdict.accepted) {
            let answer = verdict
                .answer
                .as_deref()
                .expect("an accepted verdict names an answer");
            assert!(
                snap.legal_actions
                    .iter()
                    .any(|action| action.action == answer),
                "{} is not legal: {}",
                answer,
                verdict.family
            );
            for tile in &verdict.accepted_tiles {
                assert!(
                    snap.legal_actions
                        .iter()
                        .any(|action| action.tile.as_deref() == Some(tile.as_str())),
                    "tie tile {tile} is not a legal discard"
                );
            }
        }
    }
}

#[test]
fn the_config_rejects_an_impossible_window_and_zero_gap() {
    SpecialConfig::default().validate().expect("defaults");
    let bad = SpecialConfig {
        speed_value_turns: (12, 5),
        ..SpecialConfig::default()
    };
    assert!(bad.validate().is_err());
    let bad = SpecialConfig {
        speed_value_min_ukeire_gap: 0,
        ..SpecialConfig::default()
    };
    assert!(bad.validate().is_err());
}

#[test]
fn every_special_family_has_a_row_and_a_trigger() {
    for family in SPECIAL_FAMILIES {
        assert!(is_special_family(family));
        assert!(trigger_for(family).is_some(), "{family}");
    }
    assert!(!is_special_family(Family::Book));
}

#[test]
fn a_selector_stats_row_counts_accepts_declines_and_bands() {
    let mut stats = report::SelectorStats::new(Family::CloseCall);
    let snap = snapshot(state(CLOSE_HAND, 3), DecisionKind::SelfTurn);
    let close = label("Discard_9p", "Discard_1z", 2.0, 1.95);
    let verdict = close_call_verdict(&snap, Some(&close), &label_cuts("self_turn/early"));
    stats.record(&verdict, true, true);
    assert_eq!(stats.triggered, 1);
    assert_eq!(stats.evaluated, 1);
    assert_eq!(stats.accepted, 1);
    assert_eq!(stats.close, 1);
    assert_eq!(stats.bands.get("close"), Some(&1));

    let middle = label("Discard_9p", "Discard_1z", 2.0, 1.5);
    let verdict = close_call_verdict(&snap, Some(&middle), &label_cuts("self_turn/early"));
    stats.record(&verdict, false, true);
    assert_eq!(stats.declined.get("not_close"), Some(&1));

    let report = report::SelectorSampleReport {
        schema: report::SELECTOR_SAMPLE_SCHEMA.to_string(),
        version: report::SELECTOR_SAMPLE_VERSION,
        generated_at: "20261117-000000".to_string(),
        replays_found: 1,
        replays_walked: 1,
        replays_failed: 0,
        decisions_seen: 1,
        decisions_dropped: 0,
        labelled_decisions: 1,
        unlabelled_decisions: 0,
        weak_policy_decisions: 1,
        label_source: "cache".to_string(),
        label_models: Vec::new(),
        selectors: vec![stats],
        replay_families: Vec::new(),
        notes: Vec::new(),
        errors: Vec::new(),
    };
    let summary = report.human_summary();
    assert!(summary.contains("close_call"));
    assert!(summary.contains("not_close=1"));
}
