//! Native tests for the `tenhou.net/6` exporter.
//!
//! The strongest test here is [`replay`]: it re-reads the produced JSON with a
//! small independent parser shaped like mjai-reviewer's `convlog` (takes and
//! discards in seat arrays, `60` for tsumogiri, `r`/`a`/`k` naki strings) and
//! rebuilds every seat's hand, river and melds from it. If the rebuilt table
//! matches the state the exporter started from, an external reviewer will see
//! the same table we evaluate.

use serde_json::{Value, json};

use super::*;
use crate::generator::{ScenarioId, generate_puzzle};
use crate::state::{
    CalledMeld, CorrectAction, DecisionContext, DiscardTile, GameState, MeldType, PlayerState,
    TargetAction, Wind,
};

// --- Fixtures -------------------------------------------------------------

fn player(seat: usize, wind: Wind, score: i32, hand: &[&str]) -> PlayerState {
    PlayerState {
        seat,
        name: format!("seat{seat}"),
        is_human: seat == 0,
        wind,
        score,
        hand: hand.iter().map(|tile| tile.to_string()).collect(),
        draw: None,
        red_fives: Vec::new(),
        discards: Vec::new(),
        melds: Vec::new(),
        is_riichi: false,
        riichi_discard_index: None,
    }
}

/// The self-turn position from the bridge tests: East 1, human is the dealer.
fn base_state() -> GameState {
    let mut human = player(
        0,
        Wind::East,
        25_000,
        &[
            "1m", "2m", "3m", "4m", "5m", "6m", "7m", "8m", "9m", "1p", "2p", "3p", "6s",
        ],
    );
    human.draw = Some("4p".to_string());
    human.red_fives = vec!["5m".to_string()];
    human.discards = vec![DiscardTile::new("9p"), DiscardTile::tsumogiri("1z")];

    let mut shimocha = player(
        1,
        Wind::South,
        25_000,
        &[
            "1s", "2s", "3s", "4s", "5s", "6s", "7s", "2p", "3p", "7z", "7z", "6z", "5z",
        ],
    );
    shimocha.discards = vec![DiscardTile::new("9s"), DiscardTile::new("2z")];

    GameState {
        category: "bridge_test".to_string(),
        target_action: TargetAction::NaniKiru,
        correct_action: CorrectAction::dama("4p"),
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
        hand_string: String::new(),
        tiles: Vec::new(),
        shanten: 0,
        is_agari: false,
        decompositions_count: 1,
        ukeire_tiles: vec!["9m".to_string()],
        ukeire_total: 4,
        round_wind: Wind::East,
        hand_number: 1,
        honba: 0,
        riichi_sticks: 0,
        dora_indicators: vec!["4z".to_string()],
        ura_dora_indicators: vec!["6z".to_string()],
        tiles_remaining: 61,
        current_turn: 0,
        players: vec![
            human,
            shimocha,
            {
                let mut toimen = player(2, Wind::West, 25_000, &["1z"; 13]);
                toimen.discards = vec![DiscardTile::new("8p"), DiscardTile::new("3z")];
                toimen
            },
            {
                let mut kamicha = player(3, Wind::North, 25_000, &["2z"; 13]);
                kamicha.discards = vec![DiscardTile::new("7s"), DiscardTile::new("4z")];
                kamicha
            },
        ],
    }
}

/// East 1 with the human holding an open pon of 7z claimed from Shimocha.
///
/// The timeline runs 0, 1, 2, 3, then 0, then Shimocha discards the 7z the
/// human pons, so the rivers are `[3, 2, 2, 2]` and the last discard is
/// Kamicha's.
fn open_pon_state() -> GameState {
    let mut state = base_state();
    state.players[0].hand = vec!["1m", "2m", "3m", "4m", "5m", "6m", "7m", "8m", "9m", "1p"]
        .into_iter()
        .map(str::to_string)
        .collect();
    state.players[0].draw = Some("4p".to_string());
    state.players[0].red_fives.clear();
    state.players[0].discards = vec![
        DiscardTile::new("9p"),
        DiscardTile::tsumogiri("1z"),
        DiscardTile::new("5s"),
        DiscardTile::new("6s"),
    ];
    // Fourteen discards plus the pending draw, less the one call, is 14 wall
    // draws: 56 tiles left.
    state.tiles_remaining = 56;
    state.players[0].melds = vec![CalledMeld {
        meld_type: MeldType::Pon,
        tiles: vec!["7z".to_string(); 3],
        called_from: Some(1),
    }];
    // Shimocha's second discard is the tile the human claims.
    state.players[1].discards = vec![
        DiscardTile::new("9s"),
        DiscardTile::new("7z"),
        DiscardTile::new("2z"),
        DiscardTile::new("6m"),
    ];
    state.players[2].discards = vec![
        DiscardTile::new("8p"),
        DiscardTile::new("3z"),
        DiscardTile::new("1s"),
    ];
    state.players[3].discards = vec![
        DiscardTile::new("7s"),
        DiscardTile::new("4z"),
        DiscardTile::new("2s"),
    ];
    state
}

// --- Independent replay ---------------------------------------------------

/// A tile id as it appears in a log, reduced to its kind (red fives collapse).
fn id_kind(id: u8) -> usize {
    match id {
        51 => 4,
        52 => 13,
        53 => 22,
        11..=19 => usize::from(id - 11),
        21..=29 => 9 + usize::from(id - 21),
        31..=39 => 18 + usize::from(id - 31),
        41..=47 => 27 + usize::from(id - 41),
        other => panic!("invalid tile id {other}"),
    }
}

fn id_aka(id: u8) -> bool {
    matches!(id, 51..=53)
}

#[derive(Debug, Default, Clone)]
struct ReplayedSeat {
    hand: Vec<u8>,
    river: Vec<(u8, bool, bool)>,
    melds: Vec<Vec<u8>>,
}

fn log_tile(value: &Value) -> Option<u8> {
    value.as_u64().map(|id| id as u8)
}

fn naki_parts(text: &str) -> (&str, u8, Vec<u8>) {
    // Tiles are adjacent two-digit pairs; the single letter marks the pair the
    // caller took from the discard.
    let mut digits: Vec<u8> = Vec::new();
    let mut marker = '\0';
    let mut marker_index = 0usize;
    let chars: Vec<char> = text.chars().collect();
    let mut index = 0usize;
    while index < chars.len() {
        if chars[index].is_ascii_digit() {
            let pair: String = chars[index..index + 2].iter().collect();
            digits.push(pair.parse::<u8>().expect("tile pair"));
            index += 2;
        } else {
            marker = chars[index];
            marker_index = digits.len();
            index += 1;
        }
    }
    let kind = match marker {
        'c' => "chi",
        'p' => "pon",
        'm' => "minkan",
        'a' => "ankan",
        'k' => "kakan",
        'r' => "riichi",
        other => panic!("unknown naki marker {other}"),
    };
    if kind == "chi" {
        return (kind, digits[0], vec![digits[1], digits[2]]);
    }
    // The claimed tile sits at the marker, the rest are the caller's copies.
    let claimed = digits[marker_index];
    let consumed = digits
        .iter()
        .enumerate()
        .filter(|(index, _)| *index != marker_index)
        .map(|(_, id)| *id)
        .collect();
    (kind, claimed, consumed)
}

fn remove(hand: &mut Vec<u8>, id: u8) {
    let position = hand
        .iter()
        .position(|held| *held == id || id_kind(*held) == id_kind(id))
        .unwrap_or_else(|| panic!("hand {hand:?} does not hold {id}"));
    hand.remove(position);
}

/// Re-read the log's kyoku and rebuild every seat's table.
///
/// `river_limit` truncates each seat's river to the state's own length so the
/// appended answer/tail discards do not count.
fn replay(json: &str, river_limit: &[usize; 4]) -> Vec<ReplayedSeat> {
    let document: Value = serde_json::from_str(json).expect("log is JSON");
    let kyoku = &document["log"][0];
    let entries = kyoku.as_array().expect("kyoku is an array");

    let mut seats = Vec::new();
    for (seat, limit) in river_limit.iter().enumerate() {
        let base = 4 + seat * 3;
        let haipai: Vec<u8> = entries[base]
            .as_array()
            .expect("haipai")
            .iter()
            .map(|tile| tile.as_u64().expect("tile id") as u8)
            .collect();
        assert_eq!(haipai.len(), 13, "seat {seat} haipai length");
        let takes = entries[base + 1].as_array().expect("takes");
        let discards = entries[base + 2].as_array().expect("discards");

        let mut replayed = ReplayedSeat {
            hand: haipai,
            ..Default::default()
        };
        let mut ti = 0usize;
        let mut di = 0usize;
        let mut last_draw: Option<u8> = None;

        while ti < takes.len() {
            let take = &takes[ti];
            if let Some(id) = log_tile(take) {
                replayed.hand.push(id);
                last_draw = Some(id);
                ti += 1;
                if di >= discards.len() {
                    break;
                }
                let entry = &discards[di];
                if let Some(text) = entry.as_str()
                    && (text.contains('a') || text.contains('k'))
                {
                    let (kind, claimed, _) = naki_parts(text);
                    assert!(replayed.hand.contains(&id), "kan tile was drawn");
                    replayed.hand.retain(|held| *held != id);
                    if kind == "ankan" {
                        replayed.melds.push(vec![claimed; 4]);
                    } else {
                        let meld = replayed
                            .melds
                            .iter_mut()
                            .find(|meld| id_kind(meld[0]) == id_kind(claimed))
                            .expect("kakan has a pon to extend");
                        meld.push(claimed);
                    }
                    di += 1;
                    continue;
                }
                finish_discard(&mut replayed, entry, last_draw, *limit);
                di += 1;
                continue;
            }

            let text = take.as_str().expect("take is a tile or naki");
            let (kind, claimed, consumed) = naki_parts(text);
            assert_ne!(kind, "riichi", "riichi belongs in discards");
            for id in &consumed {
                remove(&mut replayed.hand, *id);
            }
            let mut meld = vec![claimed];
            meld.extend(consumed.iter().copied());
            replayed.melds.push(meld);
            ti += 1;

            if kind == "minkan" {
                // The replacement draw is the next take.
                continue;
            }
            if di >= discards.len() {
                break;
            }
            finish_discard(&mut replayed, &discards[di], last_draw, *limit);
            di += 1;
        }

        let _ = last_draw;
        seats.push(replayed);
    }
    seats
}

fn finish_discard(seat: &mut ReplayedSeat, entry: &Value, last_draw: Option<u8>, limit: usize) {
    let past_state = seat.river.len() >= limit;
    if let Some(id) = log_tile(entry) {
        if id == TSUMOGIRI {
            let draw = last_draw.expect("tsumogiri needs a draw");
            if past_state {
                return;
            }
            remove(&mut seat.hand, draw);
            seat.river.push((draw, true, false));
        } else {
            if past_state {
                return;
            }
            remove(&mut seat.hand, id);
            seat.river.push((id, false, false));
        }
        return;
    }
    let text = entry.as_str().expect("discard is a tile, 60 or naki");
    if let Some(rest) = text.strip_prefix('r') {
        let id: u8 = rest.parse().expect("riichi tile");
        if past_state {
            return;
        }
        let tile = if id == TSUMOGIRI {
            last_draw.expect("tsumogiri riichi needs a draw")
        } else {
            id
        };
        remove(&mut seat.hand, tile);
        seat.river.push((tile, id == TSUMOGIRI, true));
        return;
    }
    panic!("unexpected discard naki {text:?}");
}

// --- Tests ----------------------------------------------------------------

/// Scenarios whose open melds the generator can back with a real discard: they
/// have no melds at all, so every table they emit is replayable.
const EXPORTABLE: &[ScenarioId] = &[
    ScenarioId::ChiitoitsuRiichiVsDama,
    ScenarioId::RiichiJudgement,
    ScenarioId::WindDiscardOrder,
    ScenarioId::DefenseSafetyChart,
    ScenarioId::SujiKabeSafety,
    ScenarioId::FoldToRiichi,
    ScenarioId::DefenseStuckHeuristic,
];

/// Scenarios that hold an open meld whose claimed tile no river contains.
///
/// The generators pick the pon/chi tiles from the hand skeleton and then draw
/// the opponents' rivers from the deck, so the discarder never discarded the
/// claimed tile. Such a table cannot be written as a real game log at all: a
/// claim has to land on an actual discard. The exporter rejects it instead of
/// quietly changing the table.
const UNREACHABLE_CLAIMS: &[ScenarioId] = &[
    ScenarioId::RyanmenProtorun,
    ScenarioId::NakabukureReady,
    ScenarioId::ProtorunPriority,
    ScenarioId::RyankanBreak,
    ScenarioId::ShouminkanDecision,
];

fn assert_replayable(state: &GameState, export: &Tenhou6Export, label: &str) {
    // The log's absolute seats are rotated: seat 0 is East in E1, which is the
    // state's dealer, not necessarily the human.
    let rotation = usize::from(export.player_id);
    let limits: [usize; 4] = std::array::from_fn(|seat| state.players[seat].discards.len());
    let mut limits_in_log_order = [0usize; 4];
    for absolute in 0..4usize {
        limits_in_log_order[absolute] = limits[(absolute + 4 - rotation) % 4];
    }
    let seats = replay(&export.json, &limits_in_log_order);

    for (absolute, replayed) in seats.iter().enumerate() {
        let seat = (absolute + 4 - rotation) % 4;
        let player = &state.players[seat];

        let mut expected: Vec<usize> = player
            .hand
            .iter()
            .chain(player.draw.iter())
            .map(|code| id_kind(Tile::plain(code).expect("tile").id()))
            .collect();
        let mut got: Vec<usize> = replayed.hand.iter().map(|id| id_kind(*id)).collect();
        got.sort_unstable();
        expected.sort_unstable();
        assert_eq!(got, expected, "{label}: seat {seat} hand");
        let red = replayed.hand.iter().filter(|id| id_aka(**id)).count();
        assert_eq!(
            red,
            player.red_fives.len().max(
                player
                    .hand
                    .iter()
                    .chain(player.draw.iter())
                    .filter(|code| player.red_fives.contains(code))
                    .count()
            ),
            "{label}: seat {seat} red fives"
        );

        let river: Vec<(usize, bool)> = player
            .discards
            .iter()
            .map(|discard| {
                let tile = Tile::from_discard(discard).expect("tile");
                (id_kind(tile.id()), discard.is_riichi)
            })
            .collect();
        let got_river: Vec<(usize, bool)> = replayed
            .river
            .iter()
            .map(|(id, _, riichi)| (id_kind(*id), *riichi))
            .collect();
        assert_eq!(got_river, river, "{label}: seat {seat} river");
        // A call can force a state's post-call discard to replay as tedashi, so
        // the log may only lose tsumogiri flags, never invent them.
        for (state_discard, (_, tsumogiri, _)) in player.discards.iter().zip(&replayed.river) {
            assert!(
                !*tsumogiri || state_discard.is_tsumogiri,
                "{label}: seat {seat} invented a tsumogiri for {}",
                state_discard.tile
            );
        }

        for meld in &player.melds {
            let mut expected: Vec<usize> = meld
                .tiles
                .iter()
                .map(|code| id_kind(Tile::plain(code).expect("tile").id()))
                .collect();
            expected.sort_unstable();
            assert!(
                replayed.melds.iter().any(|got| {
                    let mut got: Vec<usize> = got.iter().map(|id| id_kind(*id)).collect();
                    got.sort_unstable();
                    got == expected
                }),
                "{label}: seat {seat} meld {expected:?} missing from {:?}",
                replayed.melds
            );
        }
    }
}

#[test]
fn exports_a_self_turn_as_a_hanchan_kyoku() {
    let state = base_state();
    let export = export_tenhou6(&state).expect("export");
    let document: Value = serde_json::from_str(&export.json).expect("json");

    assert_eq!(document["rule"]["disp"], HANCHAN_RULE);
    assert_eq!(document["rule"]["aka"], 1);
    let kyoku = document["log"][0].as_array().expect("kyoku");
    assert_eq!(kyoku[0], json!([0, 0, 0]));
    assert_eq!(kyoku[1], json!([25000, 25000, 25000, 25000]));
    assert_eq!(kyoku[2], json!([44]), "4z is the dora indicator");
    assert_eq!(kyoku[3], json!([46]), "6z is the ura indicator");
    assert_eq!(kyoku.len(), 4 + 4 * 3 + 1);
    assert_eq!(kyoku[16], json!(["流局", [0, 0, 0, 0]]));

    // The human is East, so there is no rotation and player 0 is the target.
    assert_eq!(export.player_id, 0);
    assert_eq!(export.summary.player_id, 0);
    assert_eq!(export.summary.kyoku_num, 0);
    assert_eq!(export.summary.dealer_seat, 0);
    assert_eq!(export.summary.wall_draws, 9);
    assert_eq!(export.summary.implied_tiles_left, 61);
}

#[test]
fn the_log_replays_to_the_exported_table() {
    let state = base_state();
    let export = export_tenhou6(&state).expect("export");
    assert_replayable(&state, &export, "base");
}

#[test]
fn an_open_pon_replays_from_the_discard_it_claims() {
    let state = open_pon_state();
    let export = export_tenhou6(&state).expect("export");
    assert_replayable(&state, &export, "open pon");
    assert!(
        !export
            .warnings
            .iter()
            .any(|warning| warning.contains("replays the claim")),
        "the pon's declared source already holds the tile: {:?}",
        export.warnings
    );
}

#[test]
fn every_exportable_scenario_replays() {
    for &id in EXPORTABLE {
        for attempt in 0..3 {
            let state = generate_puzzle(id.as_str())
                .unwrap_or_else(|err| panic!("{} generation {attempt} failed: {err}", id.as_str()));
            let export = export_tenhou6(&state).unwrap_or_else(|err| {
                panic!(
                    "{} export {attempt} failed: {err}\nstate: {}",
                    id.as_str(),
                    serde_json::to_string(&state).unwrap()
                )
            });
            assert_replayable(&state, &export, id.as_str());
        }
    }
}

#[test]
fn scenarios_with_unbacked_claims_are_rejected_not_rewritten() {
    let mut rejected = 0usize;
    for &id in UNREACHABLE_CLAIMS {
        for _ in 0..3 {
            let Ok(state) = generate_puzzle(id.as_str()) else {
                continue;
            };
            match export_tenhou6(&state) {
                Ok(export) => {
                    // A lucky draw can put the claimed tile in a river.
                    assert_replayable(&state, &export, id.as_str());
                }
                Err(err) => {
                    assert!(
                        err.contains("no eligible river")
                            || err.contains("cannot be replayed as one turn order"),
                        "{}: unexpected error {err}",
                        id.as_str()
                    );
                    rejected += 1;
                }
            }
        }
    }
    assert!(
        rejected > 0,
        "at least one open-meld scenario should expose the missing claim tile"
    );
}

#[test]
fn every_exported_tile_exists_at_most_four_times() {
    let state = generate_puzzle("riichi_judgement").expect("state");
    let export = export_tenhou6(&state).expect("export");
    let document: Value = serde_json::from_str(&export.json).expect("json");
    let kyoku = document["log"][0].as_array().expect("kyoku");

    let mut counts = [0u8; TILE_KINDS];
    let mut note = |id: u8| {
        counts[id_kind(id)] += 1;
    };
    for id in kyoku[2].as_array().expect("dora") {
        note(id.as_u64().expect("id") as u8);
    }
    for id in kyoku[3].as_array().expect("ura") {
        note(id.as_u64().expect("id") as u8);
    }
    for seat in 0..4usize {
        let base = 4 + seat * 3;
        for id in kyoku[base].as_array().expect("haipai") {
            note(id.as_u64().expect("id") as u8);
        }
        for take in kyoku[base + 1].as_array().expect("takes") {
            if let Some(id) = log_tile(take) {
                note(id);
            }
        }
    }
    for (kind, count) in counts.iter().enumerate() {
        assert!(
            *count <= 4,
            "tile kind {kind} appears {count} times across the log"
        );
    }
}

#[test]
fn a_state_without_a_dora_indicator_is_rejected() {
    let mut state = base_state();
    state.dora_indicators.clear();
    let err = export_tenhou6(&state).expect_err("must reject");
    assert!(err.contains("dora indicator"), "{err}");
}

#[test]
fn a_riichi_declaration_becomes_a_riichi_discard() {
    let mut state = base_state();
    state.players[1].is_riichi = true;
    state.players[1].discards[0].is_riichi = true;
    state.players[1].riichi_discard_index = Some(0);
    let export = export_tenhou6(&state).expect("export");
    let document: Value = serde_json::from_str(&export.json).expect("json");
    let shimocha_discards = document["log"][0][4 + 3 + 2].as_array().expect("discards");
    let first = shimocha_discards[0].as_str().expect("riichi string");
    assert!(first.starts_with('r'), "{first}");

    let limits: [usize; 4] = std::array::from_fn(|seat| state.players[seat].discards.len());
    let seats = replay(&export.json, &limits);
    assert!(seats[1].river[0].2, "riichi flag survives the round trip");
}

#[test]
fn a_claim_that_no_river_can_supply_is_rejected() {
    let mut state = base_state();
    state.players[0].hand.truncate(10);
    state.players[0].melds = vec![CalledMeld {
        meld_type: MeldType::Pon,
        tiles: vec!["6z".to_string(); 3],
        called_from: Some(1),
    }];
    let err = export_tenhou6(&state).expect_err("must reject");
    assert!(err.contains("no eligible river"), "{err}");
}

#[test]
fn a_claim_falls_back_to_a_river_that_holds_the_tile() {
    let mut state = open_pon_state();
    // The state says the pon came from Toimen, whose river has no 7z; only
    // Shimocha's does, so the log has to claim it there.
    state.players[0].melds[0].called_from = Some(2);
    let export = export_tenhou6(&state).expect("export");
    assert!(
        export
            .warnings
            .iter()
            .any(|warning| warning.contains("replays the claim from seat 1")),
        "{:?}",
        export.warnings
    );
    assert_replayable(&state, &export, "fallback claim");
}
