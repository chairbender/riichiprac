//! One source of truth for legal actions and their Mortal representation.
//!
//! The model mask, the observation encoder, the AI scenario payload, and the
//! frontend grader all read this module so they cannot disagree about which
//! actions are legal.

use agari::context::{GameContext, WinType};
use agari::hand::{KanType, Meld, decompose_hand, decompose_hand_with_melds};
use agari::parse::{parse_hand, to_counts};
use agari::shanten::{calculate_shanten_with_melds, calculate_ukeire_with_melds};
use agari::tile::Tile;
use agari::yaku::detect_yaku_with_context;

use crate::decision::{ActionInfo, ActionKind, KanKind};
use crate::display::format_tile_for_display;
use crate::state::{CalledMeld, DecisionContext, GameState, MeldType, PlayerState};

use super::encoder::{tile_index, tile_name};
use super::model::ACTION_SPACE;

/// Mortal action index of the first red-five discard (5m).
pub const FIRST_RED_DISCARD: usize = 34;
/// Mortal action index of Riichi.
pub const RIICHI_ACTION: usize = 37;
/// Mortal action index of Chi low / mid / high.
pub const CHI_LOW_ACTION: usize = 38;
pub const CHI_MID_ACTION: usize = 39;
pub const CHI_HIGH_ACTION: usize = 40;
/// Mortal action index of Pon.
pub const PON_ACTION: usize = 41;
/// Mortal action index of Kan.
pub const KAN_ACTION: usize = 42;
/// Mortal action index of ron/tsumo.
pub const AGARI_ACTION: usize = 43;
/// Mortal action index of nine-terminals draw.
pub const RYUKYOKU_ACTION: usize = 44;
/// Mortal action index of pass.
pub const PASS_ACTION: usize = 45;

/// All legal actions for the human in the current decision.
pub fn legal_actions(state: &GameState) -> Vec<ActionInfo> {
    let mut actions = Vec::new();
    if state.players.is_empty() {
        return actions;
    }

    match &state.decision {
        DecisionContext::SelfTurn => self_turn_actions(state, &mut actions),
        DecisionContext::ReactToDiscard { from, tile } => {
            reaction_actions(state, *from, tile, &mut actions)
        }
        DecisionContext::ReactToKan { from, tile } => {
            chankan_actions(state, *from, tile, &mut actions)
        }
    }

    actions
}

/// Legal-action bitmask in Mortal's 46-action space.
pub fn legal_action_mask(state: &GameState) -> Vec<bool> {
    let mut mask = vec![false; ACTION_SPACE];
    for action in legal_actions(state) {
        if let Some(index) = action_index(&action.action) {
            mask[index] = true;
        }
    }
    mask
}

/// Whether declaring Riichi is one of the human's legal actions.
///
/// This is the gate the UI reads (`GameState::can_riichi`) so an open hand,
/// an already-declared Riichi, a non-tenpai hand, or an empty wallet cannot
/// offer a declaration that the rules forbid.
pub fn riichi_is_legal(state: &GameState) -> bool {
    legal_actions(state)
        .iter()
        .any(|info| info.kind == ActionKind::Riichi)
}

/// State-free description of one Mortal action index.
///
/// Kept for diagnostics and the offline fuzz runner; the live evaluator uses
/// [`legal_actions`] so labels include concrete call tiles.
pub fn describe_action(index: usize) -> (String, String, Option<usize>) {
    match index {
        0..=33 => (
            format!("Discard_{}", tile_name(index).expect("valid tile index")),
            "discard".to_string(),
            Some(index),
        ),
        34..=36 => {
            let tile = 4 + (index - FIRST_RED_DISCARD) * 9;
            let name = tile_name(tile).expect("valid tile index");
            (
                format!("Discard_{name}r"),
                "discard".to_string(),
                Some(tile),
            )
        }
        RIICHI_ACTION => ("Riichi".to_string(), "riichi".to_string(), None),
        CHI_LOW_ACTION => ("Chi_Low".to_string(), "chi".to_string(), None),
        CHI_MID_ACTION => ("Chi_Mid".to_string(), "chi".to_string(), None),
        CHI_HIGH_ACTION => ("Chi_High".to_string(), "chi".to_string(), None),
        PON_ACTION => ("Pon".to_string(), "pon".to_string(), None),
        KAN_ACTION => ("Kan".to_string(), "kan".to_string(), None),
        AGARI_ACTION => ("Agari".to_string(), "agari".to_string(), None),
        RYUKYOKU_ACTION => ("Ryukyoku".to_string(), "ryukyoku".to_string(), None),
        PASS_ACTION => ("Pass".to_string(), "pass".to_string(), None),
        other => (format!("Action_{other}"), "unknown".to_string(), None),
    }
}

/// Mortal action index for a machine-readable action name.
pub fn action_index(action: &str) -> Option<usize> {
    match action {
        "Riichi" => Some(RIICHI_ACTION),
        "Chi_Low" => Some(CHI_LOW_ACTION),
        "Chi_Mid" => Some(CHI_MID_ACTION),
        "Chi_High" => Some(CHI_HIGH_ACTION),
        "Pon" => Some(PON_ACTION),
        "Kan" => Some(KAN_ACTION),
        "Agari" => Some(AGARI_ACTION),
        "Ryukyoku" => Some(RYUKYOKU_ACTION),
        "Pass" => Some(PASS_ACTION),
        _ => {
            if let Some(tile) = action.strip_prefix("Discard_") {
                if let Some(tile) = tile.strip_suffix('r') {
                    let index = tile_index(tile)?;
                    let suit = match index / 9 {
                        0..=2 => index / 9,
                        _ => return None,
                    };
                    Some(FIRST_RED_DISCARD + suit)
                } else {
                    tile_index(tile)
                }
            } else {
                None
            }
        }
    }
}

/// Build the information for one discard action.
pub fn discard_info(tile: &str, red: bool) -> Option<ActionInfo> {
    let index = tile_index(tile)?;
    let action = if red {
        format!("Discard_{tile}r")
    } else {
        format!("Discard_{tile}")
    };
    let label = format!("Discard {}", format_tile_for_display(tile, red));
    Some(ActionInfo {
        action,
        label,
        kind: ActionKind::Discard,
        tile_index: Some(index),
        tile: Some(tile.to_string()),
        tiles: Vec::new(),
        kan_kind: None,
    })
}

fn self_turn_actions(state: &GameState, out: &mut Vec<ActionInfo>) {
    let player = &state.players[0];
    let held = concealed_tiles(player);

    // One discard action per distinct tile: a red five consumes one of its
    // copies, so a hand holding only the red five must not offer the plain
    // discard too (libriichi masks it the same way).
    let mut seen: Vec<&String> = Vec::new();
    for tile in &held {
        if seen.contains(&tile) {
            continue;
        }
        seen.push(tile);

        let copies = held.iter().filter(|held| *held == tile).count();
        let is_red = player.red_fives.iter().any(|red| red == tile);
        let plain_copies = copies.saturating_sub(usize::from(is_red));

        if plain_copies > 0
            && let Some(info) = discard_info(tile, false)
        {
            out.push(info);
        }
        if is_red && let Some(info) = discard_info(tile, true) {
            out.push(info);
        }
    }

    if can_riichi(state, player) {
        out.push(ActionInfo {
            action: "Riichi".to_string(),
            label: "Riichi".to_string(),
            kind: ActionKind::Riichi,
            tile_index: None,
            tile: None,
            tiles: Vec::new(),
            kan_kind: None,
        });
    }

    if state.is_agari {
        out.push(ActionInfo {
            action: "Agari".to_string(),
            label: "Tsumo".to_string(),
            kind: ActionKind::Agari,
            tile_index: None,
            tile: player.draw.clone(),
            tiles: Vec::new(),
            kan_kind: None,
        });
    }

    if can_ryukyoku(state, player) {
        out.push(ActionInfo {
            action: "Ryukyoku".to_string(),
            label: "Nine terminals".to_string(),
            kind: ActionKind::Ryukyoku,
            tile_index: None,
            tile: None,
            tiles: Vec::new(),
            kan_kind: None,
        });
    }

    for (tile, kind) in self_turn_kans(state, player) {
        out.push(kan_info(&tile, kind));
    }
}

fn reaction_actions(state: &GameState, from: usize, tile: &str, out: &mut Vec<ActionInfo>) {
    let player = &state.players[0];
    // A tile thrown by a declared Riichi hand can only be ronned: chi, pon and
    // daiminkan are all forbidden on it, so no call is offered.
    let discarder_in_riichi = state
        .players
        .get(from)
        .is_some_and(|source| source.is_riichi);
    // The last discard of a hand can be ronned but not called: there is no
    // replacement draw and no next turn to make the call legal.
    let wall_is_empty = state.tiles_remaining == 0;

    if !player.is_riichi && !discarder_in_riichi && !wall_is_empty {
        for (action, consumed, chi_label) in chi_options(state, from, tile, player) {
            out.push(ActionInfo {
                action: action.to_string(),
                label: chi_label,
                kind: ActionKind::Chi,
                tile_index: tile_index(tile),
                tile: Some(tile.to_string()),
                tiles: consumed,
                kan_kind: None,
            });
        }

        let matching = count_in(&player_hand(player), tile);
        if matching >= 2 {
            out.push(ActionInfo {
                action: "Pon".to_string(),
                label: format!("Pon {}", format_tile_for_display(tile, false)),
                kind: ActionKind::Pon,
                tile_index: tile_index(tile),
                tile: Some(tile.to_string()),
                tiles: Vec::new(),
                kan_kind: None,
            });
        }
        if matching >= 3 {
            out.push(kan_info(tile, KanKind::Daiminkan));
        }
    }

    if can_ron(state, player, tile) {
        out.push(ActionInfo {
            action: "Agari".to_string(),
            label: format!("Ron {}", format_tile_for_display(tile, false)),
            kind: ActionKind::Agari,
            tile_index: tile_index(tile),
            tile: Some(tile.to_string()),
            tiles: Vec::new(),
            kan_kind: None,
        });
    }

    out.push(pass_info());
}

fn chankan_actions(state: &GameState, _from: usize, tile: &str, out: &mut Vec<ActionInfo>) {
    let player = &state.players[0];
    if can_ron(state, player, tile) {
        out.push(ActionInfo {
            action: "Agari".to_string(),
            label: format!("Chankan {}", format_tile_for_display(tile, false)),
            kind: ActionKind::Agari,
            tile_index: tile_index(tile),
            tile: Some(tile.to_string()),
            tiles: Vec::new(),
            kan_kind: None,
        });
    }
    out.push(pass_info());
}

fn pass_info() -> ActionInfo {
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

fn kan_info(tile: &str, kind: KanKind) -> ActionInfo {
    let prefix = match kind {
        KanKind::Daiminkan => "Daiminkan",
        KanKind::Ankan => "Ankan",
        KanKind::Kakan => "Kakan",
    };
    ActionInfo {
        action: "Kan".to_string(),
        label: format!("{prefix} {}", format_tile_for_display(tile, false)),
        kind: ActionKind::Kan,
        tile_index: tile_index(tile),
        tile: Some(tile.to_string()),
        tiles: Vec::new(),
        kan_kind: Some(kind),
    }
}

/// True when discarding one tile leaves the hand tenpai.
///
/// libriichi offers Riichi from 1-shanten when such a discard exists
/// (`has_next_shanten_discard` in `PlayerState::tsumo`): the declaration is
/// made on that discard, so the hand itself never has to be tenpai.
fn can_discard_into_tenpai(player: &PlayerState) -> bool {
    let mut counts = [0u8; 34];
    for code in concealed_tiles(player) {
        if let Some(index) = tile_index(&code) {
            counts[index] = counts[index].saturating_add(1);
        }
    }
    let len_div3 = 4u8.saturating_sub(player.melds.len() as u8);
    (0..34).any(|index| {
        if counts[index] == 0 {
            return false;
        }
        counts[index] -= 1;
        let after = super::sp::calc_all(&counts, len_div3);
        counts[index] += 1;
        after == 0
    })
}

fn can_riichi(state: &GameState, player: &PlayerState) -> bool {
    let menzen = player
        .melds
        .iter()
        .all(|meld| meld.meld_type == MeldType::Ankan);
    menzen
        && !player.is_riichi
        && player.score >= 1000
        && state.tiles_remaining >= 4
        && (state.shanten == 0 || (state.shanten == 1 && can_discard_into_tenpai(player)))
}

/// Every tile whose discard keeps the human tenpai while declaring Riichi.
///
/// The UI's Riichi button asks for a discard. When this list holds exactly one
/// copy there is nothing to choose and the declaration can be completed with
/// that tile; with several it is the pick step's option list, so a discard that
/// breaks tenpai cannot be chosen. It is derived here, from the same counts and
/// shanten the legal action mask uses, so the frontend never re-derives a
/// mahjong rule.
///
/// Empty unless Riichi is legal *on the human's own turn*: a reaction to an
/// opponent's discard has no declaration to make.
pub fn riichi_discard_tiles(state: &GameState) -> Vec<String> {
    if state.players.is_empty() || !matches!(state.decision, DecisionContext::SelfTurn) {
        return Vec::new();
    }
    let player = &state.players[0];
    if !can_riichi(state, player) {
        return Vec::new();
    }

    let concealed = concealed_tiles(player);
    let mut counts = [0u8; 34];
    for code in &concealed {
        if let Some(index) = tile_index(code) {
            counts[index] = counts[index].saturating_add(1);
        }
    }
    let len_div3 = 4u8.saturating_sub(player.melds.len() as u8);

    let mut out = Vec::new();
    for code in &concealed {
        if out.contains(code) {
            continue;
        }
        let Some(index) = tile_index(code) else {
            continue;
        };
        if counts[index] == 0 {
            continue;
        }
        counts[index] -= 1;
        let after = super::sp::calc_all(&counts, len_div3);
        counts[index] += 1;
        if after == 0 {
            out.push(code.clone());
        }
    }
    out
}

/// Nine-terminals draw: first turn, closed hand, at least nine distinct
/// terminal/honor tile kinds.
fn can_ryukyoku(state: &GameState, player: &PlayerState) -> bool {
    if state.current_turn != 0
        || player.is_riichi
        || !player.melds.is_empty()
        || state
            .players
            .iter()
            .any(|candidate| !candidate.discards.is_empty())
    {
        return false;
    }

    let mut distinct = std::collections::HashSet::new();
    for tile in concealed_tiles(player) {
        if let Some(parsed) = parse_tile_code(&tile)
            && is_terminal_or_honor(parsed)
        {
            distinct.insert(tile);
        }
    }
    distinct.len() >= 9
}

fn is_terminal_or_honor(tile: Tile) -> bool {
    match tile {
        Tile::Honor(_) => true,
        Tile::Suited { value, .. } => value == 1 || value == 9,
    }
}

/// Closed-kong / added-kong candidates for a self turn.
///
/// A declared Riichi may still call a closed quad, but only one that leaves the
/// winning tiles unchanged: Riichi locks the hand's wait, so the quad must take
/// four tiles the hand was not waiting to use. An added kan (and, of course, a
/// claimed quad) stays unavailable, because a Riichi hand is closed.
fn self_turn_kans(state: &GameState, player: &PlayerState) -> Vec<(String, KanKind)> {
    let counts = tile_counts(&concealed_tiles(player));
    let mut kans = Vec::new();
    for (tile, &count) in &counts {
        if count != 4 {
            continue;
        }
        if player.is_riichi && !riichi_ankan_keeps_wait(player, tile) {
            continue;
        }
        kans.push((tile.clone(), KanKind::Ankan));
    }

    if player.is_riichi {
        return kans;
    }

    for meld in &player.melds {
        if meld.meld_type != MeldType::Pon || meld.tiles.is_empty() {
            continue;
        }
        let tile = &meld.tiles[0];
        if counts.get(tile).copied().unwrap_or(0) > 0 {
            // A Pon plus the fourth copy (in hand or draw) can be added.
            if state.players[0]
                .hand
                .iter()
                .chain(state.players[0].draw.iter())
                .any(|held| held == tile)
            {
                kans.push((tile.clone(), KanKind::Kakan));
            }
        }
    }

    kans
}

/// Whether a closed quad preserves a declared Riichi hand's wait.
///
/// A Riichi hand must discard the tile it draws, so the only closed quad it may
/// still call is one that leaves the hand waiting on exactly the same tiles. The
/// wait before the kan is the concealed hand of the last discard (the active
/// draw is not part of it) plus the melds already called. The quad then takes
/// four copies out of the fourteen concealed tiles, and its replacement draw is
/// the tile the player discards, so the hand that remains is those ten tiles
/// plus the new closed meld. Both shapes must be tenpai on the same tiles.
fn riichi_ankan_keeps_wait(player: &PlayerState, tile: &str) -> bool {
    let melds = player.melds.len();
    if !is_tenpai_with_melds(&player.hand, melds) {
        return false;
    }

    let mut after = concealed_tiles(player);
    let mut removed = 0usize;
    after.retain(|held| {
        if held == tile && removed < 4 {
            removed += 1;
            false
        } else {
            true
        }
    });
    if removed != 4 || !is_tenpai_with_melds(&after, melds + 1) {
        return false;
    }

    let mut before_waits = waits_for(&player.hand, melds);
    let mut after_waits = waits_for(&after, melds + 1);
    before_waits.sort_unstable();
    before_waits.dedup();
    after_waits.sort_unstable();
    after_waits.dedup();
    before_waits == after_waits
}

/// Tenpai for a hand of `13 - 3 * melds` concealed tiles plus its called melds.
fn is_tenpai_with_melds(hand: &[String], melds: usize) -> bool {
    let tiles: Vec<Tile> = hand
        .iter()
        .filter_map(|tile| parse_tile_code(tile))
        .collect();
    calculate_shanten_with_melds(&to_counts(&tiles), melds as u8).shanten == 0
}

/// Chi options for a claimed tile. Mortal defines the type relative to the
/// called tile's position in the sequence:
/// low = called tile is lowest, mid = middle, high = highest.
fn chi_options(
    _state: &GameState,
    from: usize,
    tile: &str,
    player: &PlayerState,
) -> Vec<(String, Vec<String>, String)> {
    // Chi is only legal from kamicha: relative seat 3.
    if from != 3 {
        return Vec::new();
    }
    let Some(index) = tile_index(tile) else {
        return Vec::new();
    };
    if index >= 27 {
        return Vec::new();
    }

    let value = index % 9 + 1;
    let counts = tile_counts(&player_hand(player));
    let mut options = Vec::new();

    let mut try_chi = |consumed: [usize; 2], action: &str| {
        let codes: Vec<String> = consumed
            .iter()
            .filter_map(|&tile_index| tile_name(tile_index))
            .collect();
        if codes.len() != 2 {
            return;
        }
        let mut counts_left = counts.clone();
        for code in &codes {
            let Some(count) = counts_left.get_mut(code) else {
                return;
            };
            if *count == 0 {
                return;
            }
            *count -= 1;
        }
        let mut sorted = codes.clone();
        sorted.sort();
        let label = format!(
            "Chi {} {} on {}",
            format_tile_for_display(&sorted[0], false),
            format_tile_for_display(&sorted[1], false),
            format_tile_for_display(tile, false)
        );
        options.push((action.to_string(), sorted, label));
    };

    if value <= 7 {
        try_chi([index + 1, index + 2], "Chi_Low");
    }
    if (2..=8).contains(&value) {
        try_chi([index - 1, index + 1], "Chi_Mid");
    }
    if value >= 3 {
        try_chi([index - 2, index - 1], "Chi_High");
    }

    options
}

/// Whether the human can ron the claimed tile.
fn can_ron(state: &GameState, player: &PlayerState, tile: &str) -> bool {
    if !winning_hand(
        state.round_wind,
        player.wind,
        &player.hand,
        &player.melds,
        tile,
        WinType::Ron,
        player.is_riichi,
    ) {
        return false;
    }

    // A Riichi player may still ron; only furiten forbids it. The winning
    // tiles are the hand's waits, and furiten looks at every tile discarded by
    // the player, including before this turn.
    let waits = waits_for(&player.hand, player.melds.len());
    let furiten = waits
        .iter()
        .any(|wait| player.discards.iter().any(|discard| discard.tile == *wait));
    !furiten
}

/// Whether adding `winning_tile` to a concealed hand makes a legal win.
///
/// This is the single rule shared by the trainer's ron check and the hotseat
/// simulator's tsumo check: the complete hand must decompose, must carry at
/// least one yaku in the supplied win context, and must include every called
/// meld. Furiten is a ron-only condition and stays in [`can_ron`].
pub(crate) fn winning_hand(
    round_wind: crate::state::Wind,
    player_wind: crate::state::Wind,
    hand: &[String],
    player_melds: &[CalledMeld],
    winning_tile: &str,
    win_type: WinType,
    is_riichi: bool,
) -> bool {
    let Some(claimed) = parse_tile_code(winning_tile) else {
        return false;
    };
    let mut tiles: Vec<Tile> = hand
        .iter()
        .filter_map(|tile| parse_tile_code(tile))
        .collect();
    tiles.push(claimed);

    let condensed = to_counts(&tiles);
    if calculate_shanten_with_melds(&condensed, player_melds.len() as u8).shanten != -1 {
        return false;
    }

    let melds = agari_melds(player_melds);
    let structures = if melds.is_empty() {
        decompose_hand(&condensed)
    } else {
        decompose_hand_with_melds(&condensed, &melds)
    };
    if structures.is_empty() {
        return false;
    }

    // Yaku detection needs every tile in the hand, including called melds.
    let mut full_tiles: Vec<Tile> = tiles;
    for meld in player_melds {
        full_tiles.extend(meld.tiles.iter().filter_map(|tile| parse_tile_code(tile)));
    }
    let full_counts = to_counts(&full_tiles);

    let context = GameContext::new(
        win_type,
        wind_to_honor(round_wind),
        wind_to_honor(player_wind),
    )
    .with_winning_tile(claimed);
    let context = if is_riichi { context.riichi() } else { context };
    let context = if melds.iter().any(|meld| meld.is_open()) {
        context.open()
    } else {
        context
    };

    structures.iter().any(|structure| {
        !detect_yaku_with_context(structure, &full_counts, &context)
            .yaku_list
            .is_empty()
    })
}

fn waits_for(hand: &[String], melds: usize) -> Vec<String> {
    let tiles: Vec<Tile> = hand
        .iter()
        .filter_map(|tile| parse_tile_code(tile))
        .collect();
    let counts = to_counts(&tiles);
    calculate_ukeire_with_melds(&counts, melds as u8)
        .tiles
        .iter()
        .map(|ukeire| ukeire.tile.to_string())
        .collect()
}

fn concealed_tiles(player: &PlayerState) -> Vec<String> {
    player
        .hand
        .iter()
        .chain(player.draw.iter())
        .cloned()
        .collect()
}

fn player_hand(player: &PlayerState) -> Vec<String> {
    player.hand.clone()
}

fn tile_counts(tiles: &[String]) -> std::collections::HashMap<String, u8> {
    let mut counts = std::collections::HashMap::new();
    for tile in tiles {
        *counts.entry(tile.clone()).or_insert(0) += 1;
    }
    counts
}

fn count_in(tiles: &[String], tile: &str) -> usize {
    tiles
        .iter()
        .filter(|candidate| candidate.as_str() == tile)
        .count()
}

fn parse_tile_code(code: &str) -> Option<Tile> {
    parse_hand(code).ok()?.into_iter().next()
}

fn agari_melds(melds: &[CalledMeld]) -> Vec<Meld> {
    melds
        .iter()
        .filter_map(|meld| {
            let first = meld.tiles.first().and_then(|tile| parse_tile_code(tile))?;
            match meld.meld_type {
                MeldType::Chi => Some(Meld::shuntsu_open(first)),
                MeldType::Pon => Some(Meld::koutsu_open(first)),
                MeldType::Kan => Some(Meld::kan(first, KanType::Open)),
                MeldType::Ankan => Some(Meld::kan(first, KanType::Closed)),
            }
        })
        .collect()
}

fn wind_to_honor(wind: crate::state::Wind) -> agari::tile::Honor {
    match wind {
        crate::state::Wind::East => agari::tile::Honor::East,
        crate::state::Wind::South => agari::tile::Honor::South,
        crate::state::Wind::West => agari::tile::Honor::West,
        crate::state::Wind::North => agari::tile::Honor::North,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{CorrectAction, DiscardTile, GameState, PlayerState, TargetAction, Wind};

    fn player(seat: usize, wind: Wind, hand: &[&str]) -> PlayerState {
        PlayerState {
            seat,
            name: format!("seat{seat}"),
            is_human: seat == 0,
            wind,
            score: 25_000,
            hand: hand.iter().map(|tile| tile.to_string()).collect(),
            draw: None,
            red_fives: Vec::new(),
            discards: vec![DiscardTile::new("1z")],
            melds: Vec::new(),
            is_riichi: false,
            riichi_discard_index: None,
        }
    }

    fn base_state(hand: &[&str]) -> GameState {
        let mut human = player(0, Wind::East, hand);
        human.draw = None;
        GameState {
            category: "actions_test".to_string(),
            target_action: TargetAction::NaniKiru,
            correct_action: CorrectAction::dama("1m"),
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
            shanten: 1,
            is_agari: false,
            decompositions_count: 0,
            ukeire_tiles: Vec::new(),
            ukeire_total: 0,
            round_wind: Wind::East,
            hand_number: 1,
            honba: 0,
            riichi_sticks: 0,
            dora_indicators: vec!["1p".to_string()],
            ura_dora_indicators: Vec::new(),
            tiles_remaining: 40,
            current_turn: 0,
            players: vec![
                human,
                player(1, Wind::South, &["1p"; 13]),
                player(2, Wind::West, &["2p"; 13]),
                player(3, Wind::North, &["3p"; 13]),
            ],
        }
    }

    #[test]
    fn self_turn_includes_discards_and_riichi() {
        let mut state = base_state(&[
            "1m", "2m", "3m", "4p", "5p", "6p", "7s", "8s", "9s", "2z", "2z", "3z", "4z",
        ]);
        state.shanten = 0;
        let actions = legal_actions(&state);
        assert!(actions.iter().any(|a| a.action == "Discard_1m"));
        assert!(actions.iter().any(|a| a.action == "Riichi"));
        assert!(!actions.iter().any(|a| a.action == "Pass"));
    }

    #[test]
    fn riichi_gate_matches_the_legal_action_set() {
        let mut state = base_state(&[
            "1m", "2m", "3m", "4p", "5p", "6p", "7s", "8s", "9s", "2z", "2z", "3z", "4z",
        ]);
        state.shanten = 0;
        assert!(riichi_is_legal(&state));

        // An open Pon makes the hand open, so Riichi must be impossible even
        // though the hand is tenpai.
        state.players[0].melds = vec![CalledMeld {
            meld_type: MeldType::Pon,
            tiles: vec!["2z".to_string(); 3],
            called_from: Some(1),
        }];
        assert!(!riichi_is_legal(&state));

        // A Riichi player cannot declare again.
        state.players[0].melds.clear();
        state.players[0].is_riichi = true;
        assert!(!riichi_is_legal(&state));
    }

    #[test]
    fn a_riichi_ankan_that_keeps_the_wait_is_legal() {
        // 999m is an already-complete triplet and the drawn fourth copy only
        // joins it, so the 6s/9s wait is unchanged.
        let mut state = base_state(&[
            "1m", "2m", "3m", "4p", "5p", "6p", "7s", "8s", "2z", "2z", "9m", "9m", "9m",
        ]);
        state.players[0].is_riichi = true;
        state.players[0].draw = Some("9m".to_string());

        let actions = legal_actions(&state);
        let kan = actions
            .iter()
            .find(|info| info.kind == ActionKind::Kan)
            .expect("a riichi hand may complete its own closed triplet");
        assert_eq!(kan.kan_kind, Some(KanKind::Ankan));
        assert_eq!(kan.tile.as_deref(), Some("9m"));
        assert_eq!(kan.label, "Ankan 9m");
    }

    #[test]
    fn a_riichi_ankan_that_changes_the_wait_is_illegal() {
        // 44m is the pair and the third copy completes 345m, so the 13-tile
        // hand waits on 6s/9s. Removing all four 4m strands 3m 5m and loses the
        // tenpai, so the quad must not be offered.
        let mut state = base_state(&[
            "3m", "4m", "4m", "4m", "5m", "4p", "5p", "6p", "7s", "8s", "9s", "9s", "9s",
        ]);
        state.players[0].is_riichi = true;
        state.players[0].draw = Some("4m".to_string());

        let actions = legal_actions(&state);
        assert!(
            !actions.iter().any(|info| info.kind == ActionKind::Kan),
            "a quad that changes a riichi wait is illegal: {actions:?}"
        );
    }

    #[test]
    fn a_closed_quad_is_offered_without_riichi() {
        let mut state = base_state(&[
            "1m", "2m", "3m", "4p", "5p", "6p", "7s", "8s", "2z", "2z", "9m", "9m", "9m",
        ]);
        state.players[0].draw = Some("9m".to_string());

        let actions = legal_actions(&state);
        assert!(
            actions.iter().any(|info| info.kind == ActionKind::Kan
                && info.kan_kind == Some(KanKind::Ankan)
                && info.tile.as_deref() == Some("9m")),
            "{actions:?}"
        );
    }

    #[test]
    fn a_riichi_hand_never_offers_an_added_kan() {
        // A riichi hand is closed, so it cannot hold a pon to add to. The model
        // still refuses the added kan when a reconstructed state carries both
        // flags.
        let mut state = base_state(&["1m", "2m", "3m", "4p", "5p", "6p", "7s", "8s", "1z", "2z"]);
        state.players[0].melds = vec![CalledMeld {
            meld_type: MeldType::Pon,
            tiles: vec!["1z".to_string(); 3],
            called_from: Some(1),
        }];
        state.players[0].is_riichi = true;
        state.players[0].draw = Some("1z".to_string());

        let actions = legal_actions(&state);
        assert!(
            !actions.iter().any(|info| info.kind == ActionKind::Kan),
            "a riichi hand must not offer a kakan: {actions:?}"
        );
    }

    #[test]
    fn red_five_discards_do_not_offer_an_impossible_plain_copy() {
        // Only the red 5p is held: discarding a plain 5p is impossible.
        let mut state = base_state(&[
            "1m", "2m", "3m", "4p", "5p", "6p", "7s", "8s", "9s", "2z", "2z", "3z", "4z",
        ]);
        state.players[0].red_fives = vec!["5p".to_string()];
        let actions = legal_actions(&state);
        assert!(actions.iter().any(|a| a.action == "Discard_5pr"));
        assert!(
            !actions.iter().any(|a| a.action == "Discard_5p"),
            "the only 5p held is red"
        );

        // Two 5p with one red: both the plain and the red discard are legal,
        // and each appears once.
        let mut state = base_state(&[
            "1m", "2m", "3m", "4p", "5p", "5p", "6p", "7s", "8s", "2z", "2z", "3z", "4z",
        ]);
        state.players[0].red_fives = vec!["5p".to_string()];
        let actions = legal_actions(&state);
        let plain = actions.iter().filter(|a| a.action == "Discard_5p").count();
        let red = actions.iter().filter(|a| a.action == "Discard_5pr").count();
        assert_eq!(plain, 1, "one plain 5p is held");
        assert_eq!(red, 1, "one red 5p is held");

        let plain_label = actions
            .iter()
            .find(|a| a.action == "Discard_5p")
            .map(|a| a.label.as_str());
        let red_label = actions
            .iter()
            .find(|a| a.action == "Discard_5pr")
            .map(|a| a.label.as_str());
        assert_eq!(plain_label, Some("Discard 5p"));
        assert_eq!(red_label, Some("Discard R5p"));
    }

    #[test]
    fn action_labels_use_friendly_honor_names() {
        let state = base_state(&[
            "1m", "2m", "3m", "4p", "5p", "6p", "7s", "8s", "9s", "1z", "2z", "3z", "4z",
        ]);
        let actions = legal_actions(&state);

        for (action, label) in [
            ("Discard_1z", "Discard E"),
            ("Discard_2z", "Discard S"),
            ("Discard_3z", "Discard W"),
            ("Discard_4z", "Discard N"),
        ] {
            assert_eq!(
                actions
                    .iter()
                    .find(|info| info.action == action)
                    .map(|info| info.label.as_str()),
                Some(label)
            );
        }
    }

    #[test]
    fn chi_low_mid_high_map_to_the_called_tile_position() {
        let mut state = base_state(&[
            "1m", "2m", "4m", "5m", "6m", "9p", "9p", "9p", "1s", "2s", "3s", "7z", "7z",
        ]);
        state.decision = DecisionContext::ReactToDiscard {
            from: 3,
            tile: "3m".to_string(),
        };
        let actions = legal_actions(&state);
        assert!(
            actions
                .iter()
                .any(|a| a.action == "Chi_Low" && a.tiles == ["4m", "5m"])
        );
        assert!(
            actions
                .iter()
                .any(|a| a.action == "Chi_Mid" && a.tiles == ["2m", "4m"])
        );
        assert!(
            actions
                .iter()
                .any(|a| a.action == "Chi_High" && a.tiles == ["1m", "2m"])
        );
        assert!(actions.iter().any(|a| a.action == "Pass"));
    }

    #[test]
    fn riichi_discards_and_the_last_tile_cannot_be_called() {
        let mut state = base_state(&[
            "5p", "5p", "5p", "1m", "2m", "3m", "7s", "8s", "9s", "2z", "2z", "3z", "4z",
        ]);
        state.decision = DecisionContext::ReactToDiscard {
            from: 1,
            tile: "5p".to_string(),
        };
        // A normal discard offers the pon/kan.
        assert!(legal_actions(&state).iter().any(|a| a.action == "Pon"));

        // A tile thrown by a Riichi hand can only be ronned.
        state.players[1].is_riichi = true;
        let actions = legal_actions(&state);
        assert!(!actions.iter().any(|a| a.action == "Pon"), "{actions:?}");
        assert!(!actions.iter().any(|a| a.action == "Kan"), "{actions:?}");
        state.players[1].is_riichi = false;

        // The final discard of the hand has no next turn to call into.
        state.tiles_remaining = 0;
        let actions = legal_actions(&state);
        assert!(!actions.iter().any(|a| a.action == "Pon"), "{actions:?}");
    }

    #[test]
    fn pon_and_daiminkan_require_matching_copies() {
        let mut state = base_state(&[
            "5p", "5p", "5p", "1m", "2m", "3m", "7s", "8s", "9s", "2z", "2z", "3z", "4z",
        ]);
        state.decision = DecisionContext::ReactToDiscard {
            from: 1,
            tile: "5p".to_string(),
        };
        let actions = legal_actions(&state);
        assert!(actions.iter().any(|a| a.action == "Pon"));
        assert!(actions.iter().any(|a| a.action == "Kan"));
        assert!(actions.iter().any(|a| a.action == "Pass"));
    }

    #[test]
    fn ron_requires_yaku_and_no_furiten() {
        let mut state = base_state(&[
            "1m", "2m", "3m", "4p", "5p", "6p", "7s", "8s", "9s", "2z", "2z", "3z", "3z",
        ]);
        state.decision = DecisionContext::ReactToDiscard {
            from: 1,
            tile: "4z".to_string(),
        };
        // 4z (north) has no yaku in this hand.
        assert!(!legal_actions(&state).iter().any(|a| a.action == "Agari"));
    }

    #[test]
    fn ron_sees_the_riichi_yaku_when_the_hand_has_no_other() {
        let mut state = base_state(&[
            "1m", "2m", "3m", "4p", "5p", "6p", "7s", "8s", "9s", "2s", "3s", "4s", "1z",
        ]);
        state.players[0].discards.clear();
        state.players[0].is_riichi = true;
        state.decision = DecisionContext::ReactToDiscard {
            from: 1,
            tile: "1z".to_string(),
        };
        let actions = legal_actions(&state);
        assert!(
            actions.iter().any(|a| a.action == "Agari"),
            "a closed Riichi hand wins even with no other yaku: {actions:?}"
        );
    }

    #[test]
    fn ron_sees_a_complete_open_hand() {
        // One open dragon pon is the yaku; the concealed ten tiles wait on the
        // pair. Shanten must be calculated with the called meld counted, not on
        // the eleven physical tiles alone.
        let mut state = base_state(&["1m", "2m", "3m", "4p", "5p", "6p", "7s", "8s", "9s", "2z"]);
        state.players[0].melds = vec![CalledMeld {
            meld_type: MeldType::Pon,
            tiles: vec!["5z".to_string(); 3],
            called_from: Some(1),
        }];
        state.decision = DecisionContext::ReactToDiscard {
            from: 1,
            tile: "2z".to_string(),
        };
        let actions = legal_actions(&state);
        assert!(
            actions.iter().any(|a| a.action == "Agari"),
            "an open hand that completes with a yaku must offer ron: {actions:?}"
        );
    }

    #[test]
    fn action_indices_match_mortal() {
        assert_eq!(action_index("Discard_1m"), Some(0));
        assert_eq!(action_index("Discard_5mr"), Some(34));
        assert_eq!(action_index("Riichi"), Some(37));
        assert_eq!(action_index("Chi_Low"), Some(38));
        assert_eq!(action_index("Pon"), Some(41));
        assert_eq!(action_index("Kan"), Some(42));
        assert_eq!(action_index("Agari"), Some(43));
        assert_eq!(action_index("Pass"), Some(45));
    }

    #[test]
    fn mask_and_actions_agree() {
        let state = base_state(&[
            "1m", "2m", "3m", "4p", "5p", "6p", "7s", "8s", "9s", "2z", "2z", "3z", "4z",
        ]);
        let mask = legal_action_mask(&state);
        for action in legal_actions(&state) {
            assert!(mask[action_index(&action.action).unwrap()]);
        }
    }
}
