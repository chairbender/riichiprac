//! Channel-level tests for the Mortal v4 observation encoder.

use super::encoder::{
    OBS_CHANNELS, OBS_LEN, OFF_AKAS, OFF_ANKAN, OFF_BAKAZE, OFF_CALL_TILE, OFF_CAN_AGARI,
    OFF_CAN_CHI, OFF_CAN_RIICHI, OFF_DISCARD_CANDIDATES, OFF_DORA_INDICATORS, OFF_DORAS_OWNED,
    OFF_DORAS_UNSEEN, OFF_FURITEN, OFF_FURO, OFF_HAND, OFF_HONBA, OFF_JIKAZE, OFF_KAWA_OVERVIEW,
    OFF_KYOKU, OFF_KYOTAKU, OFF_LAST_TEDASHI, OFF_OPPONENTS, OFF_RANK, OFF_REQUIRED_BEST,
    OFF_REQUIRED_TILES, OFF_RIICHI_ACCEPTED, OFF_RIICHI_DECLARED, OFF_RIICHI_SUTEHAI, OFF_ROUND,
    OFF_SCORES, OFF_SELF_KAWA_FIRST, OFF_SHANTEN, OFF_TILES_LEFT, OFF_TILES_SEEN, OFF_WAITS,
    OPP_KAWA_ITEM_CHANNELS, OPP_SUMMARY, TILE_KINDS, dora_tile, encode_v4_observation, tile_index,
    tile_name,
};
use crate::state::{
    CalledMeld, CorrectAction, DecisionContext, DiscardTile, GameState, MeldType, PlayerState,
    TargetAction, Wind,
};

fn player(
    seat: usize,
    wind: Wind,
    score: i32,
    hand: &[&str],
    discards: Vec<DiscardTile>,
) -> PlayerState {
    PlayerState {
        seat,
        name: format!("seat{seat}"),
        is_human: seat == 0,
        wind,
        score,
        hand: hand.iter().map(|tile| tile.to_string()).collect(),
        draw: None,
        red_fives: Vec::new(),
        discards,
        melds: Vec::new(),
        is_riichi: false,
        riichi_discard_index: None,
    }
}

fn base_state() -> GameState {
    let mut human = player(
        0,
        Wind::East,
        25_000,
        &[
            "1m", "1m", "2p", "3p", "4p", "5p", "6p", "7s", "8s", "9s", "2z", "2z", "3z",
        ],
        vec![
            DiscardTile::new("1z"),
            DiscardTile::tsumogiri("9p"),
            DiscardTile::new("4z"),
        ],
    );
    human.draw = Some("3m".to_string());
    human.red_fives = vec!["5p".to_string()];

    let mut shimocha = player(
        1,
        Wind::South,
        30_000,
        &[
            "1s", "2s", "3s", "4s", "5s", "6s", "7s", "8s", "9s", "1p", "1p", "1p", "2z",
        ],
        vec![DiscardTile::new("1s"), DiscardTile::tsumogiri("9m")],
    );
    shimocha.melds = vec![CalledMeld {
        meld_type: MeldType::Pon,
        tiles: vec!["5z".to_string(), "5z".to_string(), "5z".to_string()],
        called_from: Some(0),
    }];

    let mut toimen = player(
        2,
        Wind::West,
        20_000,
        &[
            "1p", "2p", "3p", "4m", "5m", "6m", "7p", "8p", "9p", "1m", "2m", "3m", "4z",
        ],
        vec![
            DiscardTile::new("7z"),
            DiscardTile::riichi("6p"),
            DiscardTile::tsumogiri("8m"),
        ],
    );
    toimen.is_riichi = true;
    toimen.riichi_discard_index = Some(1);

    let mut kamicha = player(
        3,
        Wind::North,
        25_000,
        &[
            "1m", "3m", "4m", "6m", "7m", "8m", "9m", "2s", "3s", "4s", "6s", "7s", "8s",
        ],
        vec![DiscardTile::new("2m")],
    );
    kamicha.melds = vec![CalledMeld {
        meld_type: MeldType::Ankan,
        tiles: vec![
            "1s".to_string(),
            "1s".to_string(),
            "1s".to_string(),
            "1s".to_string(),
        ],
        called_from: None,
    }];

    GameState {
        category: "encoder_test".to_string(),
        target_action: TargetAction::NaniKiru,
        correct_action: CorrectAction::dama("3m"),
        decision: DecisionContext::SelfTurn,
        ai_decision: None,
        riichi_triggers: Vec::new(),
        dama_reasons: Vec::new(),
        shouminkan_triggers: Vec::new(),

        hand_string: "113z".to_string(),
        tiles: Vec::new(),
        shanten: 0,
        is_agari: false,
        decompositions_count: 1,
        ukeire_tiles: vec!["5m".to_string()],
        ukeire_total: 4,

        round_wind: Wind::East,
        hand_number: 1,
        honba: 2,
        riichi_sticks: 1,
        dora_indicators: vec!["1m".to_string()],
        ura_dora_indicators: Vec::new(),
        tiles_remaining: 55,

        current_turn: 0,
        players: vec![human, shimocha, toimen, kamicha],
    }
}

fn cell(obs: &[f32], row: usize, column: usize) -> f32 {
    obs[row * TILE_KINDS + column]
}

fn row_is_set(obs: &[f32], row: usize) -> bool {
    (0..TILE_KINDS).all(|column| cell(obs, row, column) == 1.0)
}

fn col(value: &str) -> usize {
    tile_index(value).unwrap()
}

#[test]
fn observation_has_mortal_v4_shape_and_unit_range() {
    let state = base_state();
    let obs = encode_v4_observation(&state);

    assert_eq!(obs.len(), OBS_LEN);
    assert_eq!(obs.len(), 34_408);
    assert_eq!(OBS_CHANNELS, 1012);
    assert!(
        obs.iter()
            .all(|value| value.is_finite() && (0.0..=1.0).contains(value)),
        "every feature must be a finite value in [0, 1]"
    );
}

#[test]
fn tile_indices_and_dora_cycles_match_mortal() {
    assert_eq!(tile_index("1m"), Some(0));
    assert_eq!(tile_index("9m"), Some(8));
    assert_eq!(tile_index("1p"), Some(9));
    assert_eq!(tile_index("9p"), Some(17));
    assert_eq!(tile_index("1s"), Some(18));
    assert_eq!(tile_index("9s"), Some(26));
    assert_eq!(tile_index("1z"), Some(27));
    assert_eq!(tile_index("7z"), Some(33));
    assert_eq!(tile_index("0m"), None);
    assert_eq!(tile_index("8z"), None);
    assert_eq!(tile_index("10m"), None);
    assert_eq!(tile_name(33).as_deref(), Some("7z"));

    assert_eq!(tile_name(dora_tile(col("1m"))).as_deref(), Some("2m"));
    assert_eq!(tile_name(dora_tile(col("9m"))).as_deref(), Some("1m"));
    assert_eq!(tile_name(dora_tile(col("9p"))).as_deref(), Some("1p"));
    assert_eq!(tile_name(dora_tile(col("4z"))).as_deref(), Some("1z"));
    assert_eq!(tile_name(dora_tile(col("7z"))).as_deref(), Some("5z"));
    assert_eq!(tile_name(dora_tile(col("5z"))).as_deref(), Some("6z"));
}

#[test]
fn hand_counts_red_fives_and_draw_are_encoded() {
    let obs = encode_v4_observation(&base_state());

    // Two copies of 1m: rows 0 and 1 of the hand block.
    assert_eq!(cell(&obs, OFF_HAND, col("1m")), 1.0);
    assert_eq!(cell(&obs, OFF_HAND + 1, col("1m")), 1.0);
    assert_eq!(cell(&obs, OFF_HAND + 2, col("1m")), 0.0);
    // Two copies of 2z (South) but only one row.
    assert_eq!(cell(&obs, OFF_HAND, col("2z")), 1.0);
    assert_eq!(cell(&obs, OFF_HAND + 1, col("2z")), 1.0);
    // The drawn tile counts as part of the hand.
    assert_eq!(cell(&obs, OFF_HAND, col("3m")), 1.0);

    // Red 5p fills the whole 5p aka row; the other suits stay clear.
    assert!(row_is_set(&obs, OFF_AKAS + 1));
    assert!(!row_is_set(&obs, OFF_AKAS));
    assert!(!row_is_set(&obs, OFF_AKAS + 2));
}

#[test]
fn scores_rank_and_round_context_are_encoded() {
    let obs = encode_v4_observation(&base_state());

    assert!((cell(&obs, OFF_SCORES, 0) - 0.25).abs() < 1e-6);
    assert!((cell(&obs, OFF_SCORES + 1, 0) - 25_000.0 / 30_000.0).abs() < 1e-6);
    assert!((cell(&obs, OFF_SCORES + 2, 0) - 0.30).abs() < 1e-6);
    assert!((cell(&obs, OFF_SCORES + 3, 0) - 1.0).abs() < 1e-6);

    // One opponent (30,000) is ahead of the human's 25,000.
    assert!(row_is_set(&obs, OFF_RANK + 1));
    assert!(!row_is_set(&obs, OFF_RANK));

    assert!((cell(&obs, OFF_HONBA, 0) - 0.2).abs() < 1e-6);
    assert!((cell(&obs, OFF_KYOTAKU, 0) - 0.1).abs() < 1e-6);
    assert!(row_is_set(&obs, OFF_KYOKU));
    assert_eq!(cell(&obs, OFF_BAKAZE, col("1z")), 1.0);
    assert_eq!(cell(&obs, OFF_JIKAZE, col("1z")), 1.0);
    assert_eq!(cell(&obs, OFF_ROUND, 0), 0.0);

    // South 3: kyoku row 2, round wind channel at the South column, progress 6/7.
    let mut state = base_state();
    state.round_wind = Wind::South;
    state.hand_number = 3;
    let obs = encode_v4_observation(&state);
    assert!(row_is_set(&obs, OFF_KYOKU + 2));
    assert_eq!(cell(&obs, OFF_BAKAZE, col("2z")), 1.0);
    assert!((cell(&obs, OFF_ROUND, 0) - 6.0 / 7.0).abs() < 1e-6);
}

#[test]
fn dora_indicators_flag_discards_and_rivers() {
    let obs = encode_v4_observation(&base_state());
    // "1m" indicator makes 2m dora, which kamicha discarded.
    let dora = col("2m");

    assert_eq!(cell(&obs, OFF_DORA_INDICATORS, col("1m")), 1.0);
    assert!(!row_is_set(&obs, OFF_DORA_INDICATORS + 3)); // indicator is not a red five

    // Kamicha is opponent index 2; their first discard block holds the 2m.
    let opp_base =
        OFF_OPPONENTS + 2 * (6 * OPP_KAWA_ITEM_CHANNELS + 18 * OPP_KAWA_ITEM_CHANNELS + 3);
    assert_eq!(cell(&obs, opp_base + 3, dora), 1.0);
    assert!(row_is_set(&obs, opp_base + 5), "dora flag row is filled");

    // Rivers are mirrored in the per-seat overview tile set (kamicha = seat 3).
    assert_eq!(cell(&obs, OFF_KAWA_OVERVIEW + 3 * 7, dora), 1.0);
}

#[test]
fn self_river_is_newest_first_and_tedashi_is_flagged() {
    let obs = encode_v4_observation(&base_state());

    // First block is chronological: 1z, 9p, 4z.
    assert_eq!(cell(&obs, OFF_SELF_KAWA_FIRST + 1, col("1z")), 1.0);
    assert_eq!(cell(&obs, OFF_SELF_KAWA_FIRST + 4 + 1, col("9p")), 1.0);
    assert_eq!(cell(&obs, OFF_SELF_KAWA_FIRST + 8 + 1, col("4z")), 1.0);
    // The tsumogiri 9p must not set tedashi-style flags (self items have none
    // beyond aka/dora; the 9p is not dora).
    assert_eq!(cell(&obs, OFF_SELF_KAWA_FIRST + 4 + 3, col("9p")), 0.0);
}

#[test]
fn opponent_riichi_and_tedashi_channels_are_encoded() {
    let obs = encode_v4_observation(&base_state());
    let toimen_base = OFF_OPPONENTS + (6 * 8 + 18 * 8 + 3);

    // Toimen's second discard was the riichi declaration tile (6p).
    let item_base = toimen_base + OPP_KAWA_ITEM_CHANNELS;
    assert_eq!(cell(&obs, item_base + 3, col("6p")), 1.0);
    assert!(row_is_set(&obs, item_base + 7), "riichi flag");

    // And its river summary / last-tedashi / riichi declaration blocks.
    assert!(cell(&obs, toimen_base + OPP_SUMMARY, col("6p")) > 0.0);
    assert_eq!(cell(&obs, OFF_RIICHI_DECLARED + 1, 0), 1.0);
    assert!(row_is_set(&obs, OFF_RIICHI_ACCEPTED + 1));
    assert_eq!(cell(&obs, OFF_RIICHI_SUTEHAI + 3, col("6p")), 1.0);

    // Last hand discard for toimen is the tsumogiri 8m -> still 8m; last
    // tedashi is 6p, so last-tedashi holds 6p.
    assert_eq!(cell(&obs, OFF_LAST_TEDASHI + 3, col("6p")), 1.0);
}

#[test]
fn melds_and_closed_kans_use_separate_blocks() {
    let obs = encode_v4_observation(&base_state());

    // Shimocha (seat 1) pon of 5z: three copies in meld slot 0, rows 0..2.
    let furo = OFF_FURO + 20;
    assert_eq!(cell(&obs, furo, col("5z")), 1.0);
    assert_eq!(cell(&obs, furo + 1, col("5z")), 1.0);
    assert_eq!(cell(&obs, furo + 2, col("5z")), 1.0);
    assert_eq!(cell(&obs, furo + 3, col("5z")), 0.0);

    // Kamicha's closed kan lives in the ankan block, not the meld block.
    assert_eq!(cell(&obs, OFF_ANKAN + 3, col("1s")), 1.0);
    let kamicha_furo = OFF_FURO + 3 * 20;
    assert_eq!(cell(&obs, kamicha_furo, col("1s")), 0.0);
}

#[test]
fn waits_furiten_shanten_and_discard_candidates() {
    let obs = encode_v4_observation(&base_state());

    // Tenpai on 5m, which has not been discarded -> no furiten.
    assert_eq!(cell(&obs, OFF_WAITS, col("5m")), 1.0);
    assert!(!row_is_set(&obs, OFF_FURITEN));
    assert!(row_is_set(&obs, OFF_SHANTEN));
    assert!(row_is_set(&obs, OFF_CAN_RIICHI));

    for tile in ["1m", "2p", "5p", "3z", "3m"] {
        assert_eq!(
            cell(&obs, OFF_DISCARD_CANDIDATES, col(tile)),
            1.0,
            "candidate {tile}"
        );
    }

    // Discarding the wait tile makes the hand furiten.
    let mut state = base_state();
    state.players[0].discards.push(DiscardTile::new("5m"));
    let obs = encode_v4_observation(&state);
    assert!(row_is_set(&obs, OFF_FURITEN));
}

#[test]
fn wall_dora_owned_and_tiles_seen_are_encoded() {
    let obs = encode_v4_observation(&base_state());

    assert!((cell(&obs, OFF_TILES_LEFT, 0) - 55.0 / 69.0).abs() < 1e-6);
    // The human holds the red 5p: one dora owned.
    assert!((cell(&obs, OFF_DORAS_OWNED, 0) - 1.0 / 12.0).abs() < 1e-6);
    // One 2m is visible (kamicha's discard) and one aka is in hand, so
    // 7 - 2 = 5 dora remain unseen.
    assert!((cell(&obs, OFF_DORAS_UNSEEN, 0) - 5.0 / 23.0).abs() < 1e-6);

    // Two 1m in hand + the 1m indicator.
    assert!((cell(&obs, OFF_TILES_SEEN, col("1m")) - 3.0 / 4.0).abs() < 1e-6);
    // Three 5z in the pon.
    assert!((cell(&obs, OFF_TILES_SEEN, col("5z")) - 3.0 / 4.0).abs() < 1e-6);
    // Four 1s are fully visible through the closed kan.
    assert!((cell(&obs, OFF_TILES_SEEN, col("1s")) - 1.0).abs() < 1e-6);

    // A dora triplet in a meld counts for its owner.
    let mut state = base_state();
    state.dora_indicators = vec!["4p".to_string()];
    state.players[1].melds = vec![CalledMeld {
        meld_type: MeldType::Pon,
        tiles: vec!["5p".to_string(), "5p".to_string(), "5p".to_string()],
        called_from: Some(0),
    }];
    let obs = encode_v4_observation(&state);
    assert!((cell(&obs, OFF_DORAS_OWNED + 1, 0) - 3.0 / 12.0).abs() < 1e-6);
}

#[test]
fn agari_and_hidden_opponent_hands_do_not_leak() {
    let mut state = base_state();
    state.is_agari = true;
    assert!(row_is_set(&encode_v4_observation(&state), OFF_CAN_AGARI));

    // Changing hidden opponent hands must not change a single feature.
    let baseline = encode_v4_observation(&base_state());
    let mut changed = base_state();
    for player in changed.players.iter_mut().skip(1) {
        player.hand = vec!["7z".to_string(); 13];
    }
    assert_eq!(baseline, encode_v4_observation(&changed));
}

#[test]
fn reaction_state_encodes_call_features() {
    let mut state = base_state();
    state.decision = DecisionContext::ReactToDiscard {
        from: 3,
        tile: "3m".to_string(),
    };
    state.current_turn = 3;
    state.players[0].draw = None;
    state.players[0].hand = [
        "1m", "2m", "4m", "5m", "9p", "9p", "9p", "1s", "2s", "3s", "7z", "7z", "7z",
    ]
    .iter()
    .map(|tile| tile.to_string())
    .collect();
    state.players[3].discards.push(DiscardTile::new("3m"));
    state.shanten = 1;
    state.is_agari = false;
    state.ukeire_tiles = Vec::new();

    let obs = encode_v4_observation(&state);
    assert!((cell(&obs, OFF_CALL_TILE, col("3m")) - 1.0).abs() < 1e-6);
    assert!(row_is_set(&obs, OFF_CAN_CHI));
    assert!(row_is_set(&obs, OFF_CAN_CHI + 1));
    assert!(row_is_set(&obs, OFF_CAN_CHI + 2));
    assert!(!row_is_set(&obs, OFF_DISCARD_CANDIDATES));
}

#[test]
fn generated_puzzles_encode_to_valid_observations() {
    for _ in 0..5 {
        let json = crate::generate_puzzle("basic_test".to_string());
        let state: GameState = serde_json::from_str(&json).expect("puzzle JSON must decode");
        let obs = encode_v4_observation(&state);
        assert_eq!(obs.len(), OBS_LEN);
        assert!(
            obs.iter()
                .all(|value| value.is_finite() && (0.0..=1.0).contains(value))
        );
    }
}

fn clean_state(hand: &[&str], draw: &str) -> GameState {
    let mut state = base_state();
    state.players[0].hand = hand.iter().map(|tile| tile.to_string()).collect();
    state.players[0].draw = Some(draw.to_string());
    state.players[0].red_fives.clear();
    state.players[0].discards.clear();
    state.players[0].melds.clear();
    for seat in 1..4 {
        state.players[seat].discards.clear();
        state.players[seat].melds.clear();
        state.players[seat].red_fives.clear();
    }
    state.dora_indicators.clear();
    state.ura_dora_indicators.clear();
    state
}

fn hand_counts(hand: &[&str], draw: &str) -> [u8; TILE_KINDS] {
    let mut counts = [0u8; TILE_KINDS];
    for tile in hand.iter().copied().chain(std::iter::once(draw)) {
        counts[tile_index(tile).unwrap()] += 1;
    }
    counts
}

#[test]
fn required_tiles_land_in_the_right_discard_rows() {
    // 123m 456p 789s 11z 23m, drawn 9p: tenpai on 1m/4m after discarding 9p.
    let hand = [
        "1m", "2m", "3m", "4p", "5p", "6p", "7s", "8s", "9s", "1z", "1z", "2m", "3m",
    ];
    let mut state = clean_state(&hand, "9p");
    state.shanten = 0;
    state.is_agari = false;
    state.ukeire_tiles = vec!["1m".to_string(), "4m".to_string()];
    state.ukeire_total = 6;

    let obs = encode_v4_observation(&state);

    // Only 9p keeps tenpai.
    assert_eq!(cell(&obs, OFF_DISCARD_CANDIDATES + 1, col("9p")), 1.0);
    for tile in ["1m", "2m", "3m", "4p", "7s", "1z"] {
        assert_eq!(cell(&obs, OFF_DISCARD_CANDIDATES + 1, col(tile)), 0.0);
    }

    // First required-tile block, indexed by the discard: 1m and 4m.
    let row = OFF_REQUIRED_TILES + col("9p");
    assert_eq!(cell(&obs, row, col("1m")), 1.0);
    assert_eq!(cell(&obs, row, col("4m")), 1.0);
    let required_count: usize = (0..TILE_KINDS)
        .filter(|&column| cell(&obs, row, column) != 0.0)
        .count();
    assert_eq!(required_count, 2, "only 1m and 4m improve the hand");
    assert_eq!(cell(&obs, OFF_REQUIRED_BEST, col("9p")), 1.0);

    // A tenpai hand never uses the shanten-down block.
    for row in OFF_REQUIRED_TILES + TILE_KINDS..OFF_REQUIRED_TILES + 2 * TILE_KINDS {
        assert!(
            (0..TILE_KINDS).all(|column| cell(&obs, row, column) == 0.0),
            "row {row} must stay empty"
        );
    }
}

#[test]
fn shanten_down_discards_use_the_second_required_tile_block() {
    let hand = [
        "1m", "4m", "7m", "1p", "4p", "7p", "1s", "4s", "7s", "1z", "4z", "5z", "6z",
    ];
    let mut state = clean_state(&hand, "9m");
    let counts = hand_counts(&hand, "9m");
    state.shanten = super::sp::calc_all(&counts, 4);
    assert!(state.shanten >= 4);
    state.is_agari = false;
    state.ukeire_tiles.clear();
    state.ukeire_total = 0;

    let obs = encode_v4_observation(&state);
    let mut shanten_down_rows = Vec::new();
    for discard in 0..TILE_KINDS {
        let row = OFF_REQUIRED_TILES + TILE_KINDS + discard;
        if (0..TILE_KINDS).any(|column| cell(&obs, row, column) != 0.0) {
            shanten_down_rows.push(discard);
        }
    }
    assert!(
        !shanten_down_rows.is_empty(),
        "a high-shanten hand must populate the 925-958 block"
    );
    // 1m is one of the known shanten-down discards for this hand.
    let row = OFF_REQUIRED_TILES + TILE_KINDS + col("1m");
    assert!(
        (0..TILE_KINDS).any(|column| cell(&obs, row, column) != 0.0),
        "discarding 1m loses shanten and must land in the second block"
    );
}
