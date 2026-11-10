//! Mortal v4 observation encoder.
//!
//! Translates our [`GameState`] into the `(1012, 34)` feature matrix produced by
//! `libriichi`'s `PlayerState::encode_obs(4, false)`.
//!
//! The channel offsets below were measured from libriichi rather than guessed:
//! `encode_obs` fills rows in a fixed order and asserts the cursor lands on
//! 1012. A few pieces of Mortal's input require its single-player EV solver
//! (the required-tile plane and the 3x17 tenpai/win/EV table); those rows are
//! left at zero — see [`OFF_REQUIRED_TILES`] and [`OFF_SP_TABLE`].
//!
//! Observation is always from the human seat's perspective (`players[0]`),
//! relative seat order 0=self, 1=shimocha, 2=toimen, 3=kamicha. Hidden
//! information is never read: opponent hands are ignored, only their rivers,
//! melds and open kans are encoded.

use crate::decision::{ActionKind, KanKind};
use crate::state::{DecisionContext, DiscardTile, GameState, MeldType, PlayerState};

/// Mortal v4 observation channels (`libriichi::consts::obs_shape(4)`).
pub const OBS_CHANNELS: usize = 1012;
/// Tile kinds per channel: 1m-9m, 1p-9p, 1s-9s, E, S, W, N, haku, hatsu, chun.
pub const TILE_KINDS: usize = 34;
/// Flat length of the observation buffer (`1012 * 34 = 34,408`).
pub const OBS_LEN: usize = OBS_CHANNELS * TILE_KINDS;

// --- Section offsets (row indices into the 1012-channel observation) -------

/// 4 rows: hand counts, one row per copy held (0..=3).
pub const OFF_HAND: usize = 0;
/// 3 rows: red 5m / 5p / 5s held in hand.
pub const OFF_AKAS: usize = 4;
/// 8 rows: per seat, score/100000 then min(score, 30000)/30000.
pub const OFF_SCORES: usize = 7;
/// 4 rows: one-hot current rank (0 = first).
pub const OFF_RANK: usize = 15;
/// 4 rows: one-hot round number within the wind (0..=3).
pub const OFF_KYOKU: usize = 19;
/// 1 row: honba / 10.
pub const OFF_HONBA: usize = 23;
/// 1 row: riichi sticks / 10.
pub const OFF_KYOTAKU: usize = 24;
/// 1 row: round wind sits at the wind's tile column.
pub const OFF_BAKAZE: usize = 25;
/// 1 row: self seat wind at the wind's tile column.
pub const OFF_JIKAZE: usize = 26;
/// 1 row: round progress `(min(round_wind, South) * 4 + kyoku) / 7`.
pub const OFF_ROUND: usize = 27;
/// 7 rows: dora indicator tile set (4 counts + 3 red-five flags).
pub const OFF_DORA_INDICATORS: usize = 28;
/// 24 rows: own river, first 6 discards, 4 rows each.
pub const OFF_SELF_KAWA_FIRST: usize = 35;
/// 72 rows: own river, last 18 discards (newest first), 4 rows each.
pub const OFF_SELF_KAWA_LAST: usize = 59;
/// 1 row: own discards weighted by recency (`exp(-0.2 * turns_ago)`).
pub const OFF_SELF_KAWA_DECAY: usize = 131;
/// Own-discard item layout inside the two river blocks above.
pub const SELF_KAWA_ITEM_CHANNELS: usize = 4;
/// 3 x 195 rows: the three opponents' rivers.
pub const OFF_OPPONENTS: usize = 132;
/// Rows per opponent: 6x8 first discards, 18x8 last discards, 3 summary.
pub const OPPONENT_STRIDE: usize = 195;
/// Opponent-discard item layout (8 rows).
pub const OPP_KAWA_ITEM_CHANNELS: usize = 8;
/// Offset of the per-opponent river summary (tile / tedashi / riichi with decay).
pub const OPP_SUMMARY: usize = 192;
/// 1 row: tiles left in the wall / 69.
pub const OFF_TILES_LEFT: usize = 717;
/// 4 rows: per seat, dora owned / 12.
pub const OFF_DORAS_OWNED: usize = 718;
/// 1 row: unseen dora / 23.
pub const OFF_DORAS_UNSEEN: usize = 722;
/// 28 rows: per seat, river tile set (4 counts + 3 red-five flags).
pub const OFF_KAWA_OVERVIEW: usize = 723;
/// 80 rows: per seat, 4 meld slots x 5 rows (4 counts + 1 red-five flag).
pub const OFF_FURO: usize = 751;
/// 4 rows: per seat, closed-kan tile set.
pub const OFF_ANKAN: usize = 831;
/// 1 row: visible copy count per tile / 4.
pub const OFF_TILES_SEEN: usize = 835;
/// 9 rows: per opponent, last hand discard (tile / red / dora).
pub const OFF_LAST_TEDASHI: usize = 836;
/// 9 rows: per opponent, riichi declaration discard (tile / red / dora).
pub const OFF_RIICHI_SUTEHAI: usize = 845;
/// 3 rows: per opponent, has declared riichi.
pub const OFF_RIICHI_DECLARED: usize = 854;
/// 3 rows: per opponent, riichi accepted.
pub const OFF_RIICHI_ACCEPTED: usize = 857;
/// 1 row: self winning tiles.
pub const OFF_WAITS: usize = 860;
/// 1 row: self is furiten.
pub const OFF_FURITEN: usize = 861;
/// 7 rows: one-hot shanten, clamped to 6.
pub const OFF_SHANTEN: usize = 862;
/// 1 row: self has an accepted riichi.
pub const OFF_SELF_RIICHI: usize = 869;
/// 1 row: currently choosing which kan to declare.
pub const OFF_AT_KAN_SELECT: usize = 870;
/// 3 rows: tile that can be called (tile / red / dora).
pub const OFF_CALL_TILE: usize = 871;
/// 5 rows: discard candidates, keep-shanten, next-shanten, tenpai, self riichi.
pub const OFF_DISCARD_CANDIDATES: usize = 874;
/// 1 row: riichi is legal.
pub const OFF_CAN_RIICHI: usize = 879;
/// 3 rows: chi low / mid / high legal.
pub const OFF_CAN_CHI: usize = 880;
/// 1 row: pon legal.
pub const OFF_CAN_PON: usize = 883;
/// 1 row: open kan legal.
pub const OFF_CAN_DAIMINKAN: usize = 884;
/// 1 row: closed kan legal (tiles in row).
pub const OFF_CAN_ANKAN: usize = 885;
/// 1 row: added kan legal (tiles in row).
pub const OFF_CAN_KAKAN: usize = 886;
/// 1 row: ron/tsumo win legal.
pub const OFF_CAN_AGARI: usize = 887;
/// 1 row: nine terminals draw legal.
pub const OFF_CAN_RYUKYOKU: usize = 888;
/// 2 rows: expected value / 100000, then min(EV, 30000) / 30000.
pub const OFF_EV: usize = 889;
/// 68 rows: discard x required-tile planes from Mortal's EV solver.
pub const OFF_REQUIRED_TILES: usize = 891;
/// 1 row: discard with the most required tiles.
pub const OFF_REQUIRED_BEST: usize = 959;
/// 51 rows: 3 x 17 turn-wise tenpai probability / win probability / EV.
pub const OFF_SP_TABLE: usize = 961;

/// Encode a game state as Mortal's v4 observation matrix, flattened row-major.
///
/// The returned vector always has [`OBS_LEN`] elements; feed it to
/// [`crate::ai::MortalV4Model::forward`] as `(1, 1012, 34)`.
pub fn encode_v4_observation(state: &GameState) -> Vec<f32> {
    let mut buf = ObsBuffer::new();
    if state.players.len() < 4 {
        // Defensive: malformed states still produce a correctly sized buffer.
        return buf.into_vec();
    }

    let self_player = &state.players[0];
    let opponents = [&state.players[1], &state.players[2], &state.players[3]];
    let dora_factor = dora_factors(state);
    let self_hand = hand_counts(self_player);
    let max_kawa_len = state
        .players
        .iter()
        .map(|player| player.discards.len())
        .max()
        .unwrap_or(0);

    encode_hand(&mut buf, self_player);
    encode_akas(&mut buf, self_player);
    encode_scores(&mut buf, state);
    encode_round_context(&mut buf, state);
    encode_dora_indicators(&mut buf, state);
    encode_self_river(&mut buf, self_player, &dora_factor, max_kawa_len);
    encode_opponent_rivers(&mut buf, &opponents, &dora_factor, max_kawa_len);
    encode_wall_and_dora(
        &mut buf,
        state,
        &self_hand,
        &dora_factor,
        self_player,
        &opponents,
    );
    encode_tiles_seen(&mut buf, state);
    encode_last_discards(&mut buf, &opponents, &dora_factor);
    encode_waits_and_shanten(&mut buf, state, self_player);
    encode_decision_features(&mut buf, state, self_player, &self_hand);

    buf.into_vec()
}

// --- Sections --------------------------------------------------------------

fn encode_hand(buf: &mut ObsBuffer, player: &PlayerState) {
    for tile in player.hand.iter().chain(player.draw.iter()) {
        let Some(index) = tile_index(tile) else {
            continue;
        };
        // Hand counts are one-hot over copies: row 0 for the first copy, ...
        let count = buf.count_in_column(OFF_HAND, 4, index) as usize;
        if count < 4 {
            buf.assign(OFF_HAND + count, index, 1.0);
        }
    }
}

fn encode_akas(buf: &mut ObsBuffer, player: &PlayerState) {
    for tile in &player.red_fives {
        if let Some(suit) = red_five_suit(tile) {
            // libriichi fills the whole row: a red five is held in this suit.
            buf.fill(OFF_AKAS + suit, 1.0);
        }
    }
}

fn encode_scores(buf: &mut ObsBuffer, state: &GameState) {
    for (seat, player) in state.players.iter().take(4).enumerate() {
        let score = player.score;
        buf.fill(
            OFF_SCORES + seat * 2,
            score.clamp(0, 100_000) as f32 / 100_000.0,
        );
        buf.fill(
            OFF_SCORES + seat * 2 + 1,
            score.clamp(0, 30_000) as f32 / 30_000.0,
        );
    }

    let self_score = state.players[0].score;
    let rank = state
        .players
        .iter()
        .skip(1)
        .filter(|player| player.score > self_score)
        .count()
        .min(3);
    buf.fill(OFF_RANK + rank, 1.0);
}

fn encode_round_context(buf: &mut ObsBuffer, state: &GameState) {
    let bakaze = state.round_wind.index();
    let jikaze = state.players[0].wind.index();
    let kyoku = (state.hand_number.saturating_sub(1) as usize).min(3);

    buf.fill(OFF_KYOKU + kyoku, 1.0);
    buf.fill(OFF_HONBA, state.honba.min(10) as f32 / 10.0);
    buf.fill(OFF_KYOTAKU, state.riichi_sticks.min(10) as f32 / 10.0);
    buf.assign(OFF_BAKAZE, bakaze, 1.0);
    buf.assign(OFF_JIKAZE, jikaze, 1.0);
    let progress = (bakaze.min(1) * 4 + kyoku) as f32 / 7.0;
    buf.fill(OFF_ROUND, progress);
}

fn encode_dora_indicators(buf: &mut ObsBuffer, state: &GameState) {
    let tiles = state
        .dora_indicators
        .iter()
        .filter_map(|tile| tile_index(tile));
    encode_tile_set(buf, OFF_DORA_INDICATORS, tiles);
}

fn encode_self_river(
    buf: &mut ObsBuffer,
    player: &PlayerState,
    dora_factor: &[u8; TILE_KINDS],
    max_kawa_len: usize,
) {
    let first = player.discards.len().min(6);
    for (turn, discard) in player.discards.iter().take(first).enumerate() {
        encode_self_kawa_item(
            buf,
            OFF_SELF_KAWA_FIRST + turn * SELF_KAWA_ITEM_CHANNELS,
            discard.tile.as_str(),
            dora_factor,
        );
    }

    let last = player.discards.len().min(18);
    for ago in 0..last {
        let discard = &player.discards[player.discards.len() - 1 - ago];
        encode_self_kawa_item(
            buf,
            OFF_SELF_KAWA_LAST + ago * SELF_KAWA_ITEM_CHANNELS,
            discard.tile.as_str(),
            dora_factor,
        );
    }

    // Recency-weighted bag of own discards.
    for (turn, discard) in player.discards.iter().enumerate() {
        let Some(index) = tile_index(&discard.tile) else {
            continue;
        };
        let turns_ago = max_kawa_len.saturating_sub(1 + turn);
        let weight = (-0.2 * turns_ago as f32).exp();
        buf.assign(OFF_SELF_KAWA_DECAY, index, weight);
    }
}

fn encode_self_kawa_item(
    buf: &mut ObsBuffer,
    base: usize,
    tile: &str,
    dora_factor: &[u8; TILE_KINDS],
) {
    let Some(index) = tile_index(tile) else {
        return;
    };
    // Row 0 holds kan tiles called off this position (not tracked here).
    buf.assign(base + 1, index, 1.0);
    // Row 2 is the red-five flag; our discards do not record aka-ness.
    if dora_factor[index] > 0 {
        buf.fill(base + 3, 1.0);
    }
}

fn encode_opponent_rivers(
    buf: &mut ObsBuffer,
    opponents: &[&PlayerState; 3],
    dora_factor: &[u8; TILE_KINDS],
    max_kawa_len: usize,
) {
    for (seat, player) in opponents.iter().enumerate() {
        let base = OFF_OPPONENTS + seat * OPPONENT_STRIDE;

        let first = player.discards.len().min(6);
        for (turn, discard) in player.discards.iter().take(first).enumerate() {
            encode_opponent_kawa_item(
                buf,
                base + turn * OPP_KAWA_ITEM_CHANNELS,
                discard,
                dora_factor,
            );
        }

        let last = player.discards.len().min(18);
        for ago in 0..last {
            let discard = &player.discards[player.discards.len() - 1 - ago];
            encode_opponent_kawa_item(
                buf,
                base + 48 + ago * OPP_KAWA_ITEM_CHANNELS,
                discard,
                dora_factor,
            );
        }

        // Summary: tile / tedashi / riichi, each weighted by recency.
        for (turn, discard) in player.discards.iter().enumerate() {
            let Some(index) = tile_index(&discard.tile) else {
                continue;
            };
            let turns_ago = max_kawa_len.saturating_sub(1 + turn);
            let weight = (-0.2 * turns_ago as f32).exp();
            buf.assign(base + OPP_SUMMARY, index, weight);
            if !discard.is_tsumogiri {
                buf.assign(base + OPP_SUMMARY + 1, index, weight);
            }
            if discard.is_riichi {
                buf.assign(base + OPP_SUMMARY + 2, index, weight);
            }
        }
    }
}

fn encode_opponent_kawa_item(
    buf: &mut ObsBuffer,
    base: usize,
    discard: &DiscardTile,
    dora_factor: &[u8; TILE_KINDS],
) {
    let Some(index) = tile_index(&discard.tile) else {
        return;
    };
    // Rows 0-2 hold chi/pon consumed tiles and called kans; those live in the
    // meld overview instead.
    buf.assign(base + 3, index, 1.0);
    // Row 4 is the red-five flag; opponent akas are not tracked.
    if dora_factor[index] > 0 {
        buf.fill(base + 5, 1.0);
    }
    if !discard.is_tsumogiri {
        buf.fill(base + 6, 1.0);
    }
    if discard.is_riichi {
        buf.fill(base + 7, 1.0);
    }
}

fn encode_wall_and_dora(
    buf: &mut ObsBuffer,
    state: &GameState,
    self_hand: &[u8; TILE_KINDS],
    dora_factor: &[u8; TILE_KINDS],
    self_player: &PlayerState,
    opponents: &[&PlayerState; 3],
) {
    buf.fill(OFF_TILES_LEFT, state.tiles_remaining.min(69) as f32 / 69.0);

    // `doras_owned`: dora currently held, i.e. hand + melds for self and melds
    // only for opponents (their hands are hidden).
    let mut doras_owned = [0u8; 4];
    doras_owned[0] = dora_in_tiles(
        self_hand
            .iter()
            .enumerate()
            .filter_map(|(tile, &count)| (count > 0).then_some((tile, count))),
        dora_factor,
    );
    let self_akas = self_player
        .red_fives
        .iter()
        .filter(|tile| tile_index(tile).is_some())
        .count() as u8;
    doras_owned[0] = doras_owned[0].saturating_add(self_akas);
    doras_owned[0] = doras_owned[0].saturating_add(dora_in_player_melds(self_player, dora_factor));
    for (seat, player) in opponents.iter().enumerate() {
        doras_owned[seat + 1] = dora_in_player_melds(player, dora_factor);
    }
    for (seat, &count) in doras_owned.iter().enumerate() {
        buf.fill(OFF_DORAS_OWNED + seat, count.min(12) as f32 / 12.0);
    }

    // Tiles that are dora but have not been seen yet.
    let indicator_dora = state.dora_indicators.len() as i32 * 4 + 3;
    let doras_seen = (visible_dora_seen(state, self_hand, dora_factor, self_player, opponents)
        as i32)
        .min(indicator_dora);
    let unseen = (indicator_dora - doras_seen).clamp(0, 23);
    buf.fill(OFF_DORAS_UNSEEN, unseen as f32 / 23.0);

    // Per-seat river tile sets.
    for (seat, player) in state.players.iter().take(4).enumerate() {
        let tiles = player
            .discards
            .iter()
            .filter_map(|discard| tile_index(&discard.tile));
        encode_tile_set(buf, OFF_KAWA_OVERVIEW + seat * 7, tiles);
    }

    // Melds: 4 slots x 5 rows per seat (chi/pon/open kan).
    for (seat, player) in state.players.iter().take(4).enumerate() {
        let base = OFF_FURO + seat * 20;
        let melds: Vec<_> = player
            .melds
            .iter()
            .filter(|meld| meld.meld_type != MeldType::Ankan)
            .take(4)
            .collect();
        for (slot, meld) in melds.iter().enumerate() {
            let meld_base = base + slot * 5;
            for tile in &meld.tiles {
                let Some(index) = tile_index(tile) else {
                    continue;
                };
                let row = buf.count_in_column(meld_base, 4, index) as usize;
                if row < 4 {
                    buf.assign(meld_base + row, index, 1.0);
                }
            }
        }
    }

    // Closed kans: one row per seat holding a tile set.
    for (seat, player) in state.players.iter().take(4).enumerate() {
        for meld in player
            .melds
            .iter()
            .filter(|m| m.meld_type == MeldType::Ankan)
        {
            for tile in &meld.tiles {
                if let Some(index) = tile_index(tile) {
                    buf.assign(OFF_ANKAN + seat, index, 1.0);
                }
            }
        }
    }
}

fn encode_tiles_seen(buf: &mut ObsBuffer, state: &GameState) {
    let mut seen = [0u8; TILE_KINDS];

    for tile in state.players[0]
        .hand
        .iter()
        .chain(state.players[0].draw.iter())
        .chain(state.dora_indicators.iter())
    {
        if let Some(index) = tile_index(tile) {
            seen[index] = seen[index].saturating_add(1);
        }
    }

    for player in state.players.iter().take(4) {
        for discard in &player.discards {
            if let Some(index) = tile_index(&discard.tile) {
                seen[index] = seen[index].saturating_add(1);
            }
        }
        for meld in &player.melds {
            for tile in &meld.tiles {
                if let Some(index) = tile_index(tile) {
                    let copies = if meld.meld_type == MeldType::Ankan {
                        4
                    } else {
                        1
                    };
                    seen[index] = seen[index].saturating_add(copies);
                }
            }
        }
    }

    for (index, &count) in seen.iter().enumerate() {
        buf.assign(OFF_TILES_SEEN, index, count.min(4) as f32 / 4.0);
    }
}

fn encode_last_discards(
    buf: &mut ObsBuffer,
    opponents: &[&PlayerState; 3],
    dora_factor: &[u8; TILE_KINDS],
) {
    for (seat, player) in opponents.iter().enumerate() {
        if let Some(discard) = player.discards.iter().rev().find(|d| !d.is_tsumogiri) {
            encode_tile_with_flags(buf, OFF_LAST_TEDASHI + seat * 3, &discard.tile, dora_factor);
        }

        if player.is_riichi {
            if let Some(discard) = player
                .riichi_discard_index
                .and_then(|index| player.discards.get(index))
            {
                encode_tile_with_flags(
                    buf,
                    OFF_RIICHI_SUTEHAI + seat * 3,
                    &discard.tile,
                    dora_factor,
                );
            }
            buf.fill(OFF_RIICHI_DECLARED + seat, 1.0);
            buf.fill(OFF_RIICHI_ACCEPTED + seat, 1.0);
        }
    }
}

fn encode_waits_and_shanten(buf: &mut ObsBuffer, state: &GameState, player: &PlayerState) {
    // `ukeire_tiles` are the winning tiles once the hand is tenpai; sp_waits
    // already encodes that.
    let waits: Vec<usize> = if state.shanten == 0 {
        state
            .ukeire_tiles
            .iter()
            .filter_map(|tile| tile_index(tile))
            .collect()
    } else {
        Vec::new()
    };
    for &index in &waits {
        buf.assign(OFF_WAITS, index, 1.0);
    }

    let furiten = waits.iter().any(|&index| {
        player
            .discards
            .iter()
            .any(|discard| tile_index(&discard.tile) == Some(index))
    });
    if furiten {
        buf.fill(OFF_FURITEN, 1.0);
    }

    let shanten = state.shanten.clamp(0, 6) as usize;
    buf.fill(OFF_SHANTEN + shanten, 1.0);

    if player.is_riichi {
        buf.fill(OFF_SELF_RIICHI, 1.0);
    }
}

fn encode_decision_features(
    buf: &mut ObsBuffer,
    state: &GameState,
    player: &PlayerState,
    self_hand: &[u8; TILE_KINDS],
) {
    // Legal discard candidates (aka tiles collapse onto their base tile).
    if matches!(state.decision, DecisionContext::SelfTurn) {
        for (index, &count) in self_hand.iter().enumerate() {
            if count > 0 {
                buf.assign(OFF_DISCARD_CANDIDATES, index, 1.0);
            }
        }
        if player.is_riichi {
            buf.fill(OFF_DISCARD_CANDIDATES + 4, 1.0);
        }
    }

    for action in super::actions::legal_actions(state) {
        match action.kind {
            ActionKind::Discard => {}
            ActionKind::Riichi => buf.fill(OFF_CAN_RIICHI, 1.0),
            ActionKind::Chi => {
                let row = match action.action.as_str() {
                    "Chi_Low" => 0,
                    "Chi_Mid" => 1,
                    "Chi_High" => 2,
                    _ => continue,
                };
                buf.fill(OFF_CAN_CHI + row, 1.0);
            }
            ActionKind::Pon => buf.fill(OFF_CAN_PON, 1.0),
            ActionKind::Kan => match action.kan_kind {
                Some(KanKind::Daiminkan) => buf.fill(OFF_CAN_DAIMINKAN, 1.0),
                Some(KanKind::Ankan) => buf.fill(OFF_CAN_ANKAN, 1.0),
                Some(KanKind::Kakan) => buf.fill(OFF_CAN_KAKAN, 1.0),
                None => {}
            },
            ActionKind::Agari => buf.fill(OFF_CAN_AGARI, 1.0),
            ActionKind::Ryukyoku => buf.fill(OFF_CAN_RYUKYOKU, 1.0),
            ActionKind::Pass => {}
        }
    }

    // The claimed tile for a reaction decision.
    if let Some(tile) = claimed_tile(state)
        && let Some(index) = tile_index(tile)
    {
        buf.assign(OFF_CALL_TILE, index, 1.0);
        // Row 1 is the red-five flag; our discards do not record aka-ness.
        // Row 2 is the dora flag; it is filled by the caller's dora data when
        // available. The tile identity is the important part here.
    }
}

/// The tile a reaction decision is responding to, if any.
fn claimed_tile(state: &GameState) -> Option<&str> {
    match &state.decision {
        DecisionContext::ReactToDiscard { tile, .. } | DecisionContext::ReactToKan { tile, .. } => {
            Some(tile)
        }
        DecisionContext::SelfTurn => None,
    }
}

// --- Helpers ---------------------------------------------------------------

/// `f32` matrix of shape (1012, 34) with the buffer helpers libriichi uses.
struct ObsBuffer {
    data: Vec<f32>,
}

impl ObsBuffer {
    fn new() -> Self {
        Self {
            data: vec![0.0; OBS_LEN],
        }
    }

    /// Set every tile column of `row` to `value`.
    fn fill(&mut self, row: usize, value: f32) {
        let start = row * TILE_KINDS;
        self.data[start..start + TILE_KINDS].fill(value);
    }

    fn assign(&mut self, row: usize, column: usize, value: f32) {
        self.data[row * TILE_KINDS + column] = value;
    }

    /// Number of non-zero entries in `rows` at `column`.
    fn count_in_column(&self, row: usize, rows: usize, column: usize) -> u8 {
        (0..rows)
            .filter(|offset| self.data[(row + offset) * TILE_KINDS + column] != 0.0)
            .count() as u8
    }

    fn into_vec(self) -> Vec<f32> {
        self.data
    }
}

/// Mirrors `encode_tile_set`: 4 copy-count rows plus one row per red five.
fn encode_tile_set(buf: &mut ObsBuffer, base: usize, tiles: impl Iterator<Item = usize>) {
    for index in tiles {
        let count = buf.count_in_column(base, 4, index) as usize;
        if count < 4 {
            buf.assign(base + count, index, 1.0);
        }
    }
}

fn encode_tile_with_flags(
    buf: &mut ObsBuffer,
    base: usize,
    tile: &str,
    dora_factor: &[u8; TILE_KINDS],
) {
    let Some(index) = tile_index(tile) else {
        return;
    };
    buf.assign(base, index, 1.0);
    // Row 1 = red five; our state does not mark which discards were red.
    if dora_factor[index] > 0 {
        buf.fill(base + 2, 1.0);
    }
}

fn hand_counts(player: &PlayerState) -> [u8; TILE_KINDS] {
    let mut counts = [0u8; TILE_KINDS];
    for tile in player.hand.iter().chain(player.draw.iter()) {
        if let Some(index) = tile_index(tile) {
            counts[index] = counts[index].saturating_add(1);
        }
    }
    counts
}

/// Dora multiplier per tile kind, derived from the visible indicators.
fn dora_factors(state: &GameState) -> [u8; TILE_KINDS] {
    let mut factors = [0u8; TILE_KINDS];
    for tile in &state.dora_indicators {
        if let Some(index) = tile_index(tile) {
            factors[dora_tile(index)] = factors[dora_tile(index)].saturating_add(1);
        }
    }
    factors
}

fn dora_in_tiles<I>(tiles: I, dora_factor: &[u8; TILE_KINDS]) -> u8
where
    I: Iterator<Item = (usize, u8)>,
{
    tiles
        .map(|(tile, count)| dora_factor[tile].saturating_mul(count))
        .fold(0u8, u8::saturating_add)
}

fn dora_in_player_melds(player: &PlayerState, dora_factor: &[u8; TILE_KINDS]) -> u8 {
    let mut total = 0u8;
    for meld in &player.melds {
        let copies = if meld.meld_type == MeldType::Ankan {
            4
        } else {
            1
        };
        for tile in &meld.tiles {
            if let Some(index) = tile_index(tile) {
                total = total.saturating_add(dora_factor[index].saturating_mul(copies));
            }
        }
    }
    total
}

/// Total dora tiles witnessed by the human (hand, rivers, melds, indicators).
fn visible_dora_seen(
    state: &GameState,
    self_hand: &[u8; TILE_KINDS],
    dora_factor: &[u8; TILE_KINDS],
    self_player: &PlayerState,
    opponents: &[&PlayerState; 3],
) -> u8 {
    let mut seen = dora_in_tiles(
        self_hand
            .iter()
            .enumerate()
            .filter_map(|(tile, &count)| (count > 0).then_some((tile, count))),
        dora_factor,
    );
    seen = seen.saturating_add(
        self_player
            .red_fives
            .iter()
            .filter(|tile| tile_index(tile).is_some())
            .count() as u8,
    );

    for player in std::iter::once(self_player).chain(opponents.iter().copied()) {
        seen = seen.saturating_add(
            player
                .discards
                .iter()
                .filter_map(|discard| tile_index(&discard.tile))
                .map(|index| dora_factor[index])
                .fold(0u8, u8::saturating_add),
        );
    }

    seen = seen.saturating_add(dora_in_player_melds(self_player, dora_factor));
    for player in opponents {
        seen = seen.saturating_add(dora_in_player_melds(player, dora_factor));
    }

    // The indicators themselves have been witnessed too.
    seen.saturating_add(
        state
            .dora_indicators
            .iter()
            .filter_map(|tile| tile_index(tile))
            .map(|index| dora_factor[index])
            .fold(0u8, u8::saturating_add),
    )
}

/// Map a tile string (`1m`, `9p`, `5s`, `7z`) to Mortal's 0..34 tile index.
pub fn tile_index(tile: &str) -> Option<usize> {
    let bytes = tile.as_bytes();
    if bytes.len() != 2 {
        return None;
    }
    let value = bytes[0].wrapping_sub(b'0') as usize;
    let (base, max) = match bytes[1] {
        b'm' => (0, 9),
        b'p' => (9, 9),
        b's' => (18, 9),
        b'z' => (27, 7),
        _ => return None,
    };
    (1..=max).contains(&value).then(|| base + value - 1)
}

/// Inverse of [`tile_index`], mainly for tests and diagnostics.
pub fn tile_name(index: usize) -> Option<String> {
    if index >= TILE_KINDS {
        return None;
    }
    let (base, suit) = match index {
        0..=8 => (0, 'm'),
        9..=17 => (9, 'p'),
        18..=26 => (18, 's'),
        _ => (27, 'z'),
    };
    Some(format!("{}{}", index - base + 1, suit))
}

/// The tile that an indicator in `index` makes dora.
pub fn dora_tile(index: usize) -> usize {
    match index {
        0..=26 => {
            let base = index - index % 9;
            base + (index % 9 + 1) % 9
        }
        27..=30 => 27 + (index - 27 + 1) % 4,
        _ => 31 + (index - 31 + 1) % 3,
    }
}

fn red_five_suit(tile: &str) -> Option<usize> {
    match tile {
        "5m" => Some(0),
        "5p" => Some(1),
        "5s" => Some(2),
        _ => None,
    }
}
