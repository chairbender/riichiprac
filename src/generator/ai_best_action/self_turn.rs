use std::collections::HashMap;

use agari::tile::{Suit, Tile};

use crate::generator::support::analysis::{HandMetrics, evaluate_hand};
use crate::generator::support::deck::ALL_TILES;
use crate::generator::support::format::format_hand_compact;
use crate::generator::support::table::discards_from_tiles;
use crate::rng::{choose, gen_bool, gen_range, shuffle};
use crate::state::{
    CalledMeld, CorrectAction, DecisionContext, GameState, MeldType, PlayerState, TargetAction,
};

use super::reaction::build_complete_hand;
use super::table::{Table, deal_table, deal_table_with_human, deal_table_with_human_no_rivers};
use super::validate::validate_self_turn_candidate;

/// Build a self-turn candidate with a randomly chosen special decision.
pub fn build_special_candidate(category: &str) -> Result<GameState, String> {
    match gen_range(0, 5) {
        0 => build_riichi_candidate(category),
        1 => build_tsumo_candidate(category),
        2 => build_ankan_candidate(category),
        3 => build_kakan_candidate(category),
        _ => build_ryukyoku_candidate(category),
    }
}

/// Build a self-turn hand that presents a pure discard decision.
///
/// Riichi, kan, and agari are deliberately excluded here so the first reaction
/// family has a single, unambiguous decision shape.
pub fn build_candidate(category: &str) -> Result<GameState, String> {
    let table = deal_table()?;
    let metrics = evaluate_hand(&table.human_tiles);
    if metrics.shanten < 1 || metrics.is_agari {
        return Err("self-turn candidate is already tenpai or complete".to_string());
    }

    let mut counts: HashMap<Tile, u8> = HashMap::new();
    for &tile in &table.human_tiles {
        *counts.entry(tile).or_insert(0) += 1;
    }
    if counts.values().any(|&count| count == 4) {
        return Err("self-turn candidate accidentally offers a kan".to_string());
    }

    let mut full_tiles = table.human_tiles.clone();
    full_tiles.sort();
    let draw = full_tiles
        .pop()
        .ok_or_else(|| "dealt hand was empty".to_string())?;
    full_tiles.sort();

    assemble_checked(
        category,
        table,
        full_tiles,
        draw,
        metrics,
        false,
        Vec::new(),
    )
}

pub(super) fn build_riichi_candidate(category: &str) -> Result<GameState, String> {
    for _ in 0..40 {
        let (hand, draw) = match tenpai_shape() {
            Ok(shape) => shape,
            Err(_) => continue,
        };
        let metrics = evaluate_hand(&hand);
        if metrics.shanten != 0 {
            continue;
        }
        let mut full: Vec<Tile> = hand.clone();
        full.push(draw);
        if evaluate_hand(&full).is_agari {
            continue;
        }
        let table = match deal_table_with_human(full) {
            Ok(table) => table,
            Err(_) => continue,
        };
        match assemble_checked(category, table, hand, draw, metrics, false, Vec::new()) {
            Ok(state) => return Ok(state),
            Err(_) => continue,
        }
    }
    Err("could not build a Riichi tenpai hand".to_string())
}

fn build_tsumo_candidate(category: &str) -> Result<GameState, String> {
    for _ in 0..40 {
        let mut full = match build_complete_hand() {
            Ok(hand) => hand,
            Err(_) => continue,
        };
        full.sort();
        let draw = full
            .pop()
            .ok_or_else(|| "complete hand was empty".to_string())?;
        let hand = full;
        let metrics = evaluate_hand(
            &hand
                .iter()
                .copied()
                .chain(std::iter::once(draw))
                .collect::<Vec<_>>(),
        );
        if !metrics.is_agari {
            continue;
        }
        let table = match deal_table_with_human(
            hand.iter().copied().chain(std::iter::once(draw)).collect(),
        ) {
            Ok(table) => table,
            Err(_) => continue,
        };
        match assemble_checked(category, table, hand, draw, metrics, true, Vec::new()) {
            Ok(state) => return Ok(state),
            Err(_) => continue,
        }
    }
    Err("could not build a tsumo hand".to_string())
}

fn build_ankan_candidate(category: &str) -> Result<GameState, String> {
    for _ in 0..40 {
        let mut counts: HashMap<Tile, u8> = HashMap::new();
        let mut full = Vec::new();

        let kan_tile = choose(&ALL_TILES).expect("tiles exist");
        for _ in 0..4 {
            full.push(kan_tile);
        }
        *counts.entry(kan_tile).or_insert(0) = 4;

        while full.len() < 14 {
            let tile = choose(&ALL_TILES).expect("tiles exist");
            let count = counts.entry(tile).or_insert(0);
            if *count >= 4 {
                continue;
            }
            *count += 1;
            full.push(tile);
        }
        full.sort();
        let draw = full
            .pop()
            .ok_or_else(|| "ankan hand was empty".to_string())?;
        let hand = full;
        let metrics = evaluate_hand(
            &hand
                .iter()
                .copied()
                .chain(std::iter::once(draw))
                .collect::<Vec<_>>(),
        );
        if metrics.is_agari {
            continue;
        }
        let table = match deal_table_with_human(
            hand.iter().copied().chain(std::iter::once(draw)).collect(),
        ) {
            Ok(table) => table,
            Err(_) => continue,
        };
        match assemble_checked(category, table, hand, draw, metrics, false, Vec::new()) {
            Ok(state) => return Ok(state),
            Err(_) => continue,
        }
    }
    Err("could not build an ankan hand".to_string())
}

fn build_kakan_candidate(category: &str) -> Result<GameState, String> {
    for _ in 0..40 {
        let mut counts: HashMap<Tile, u8> = HashMap::new();
        let kan_tile = choose(&ALL_TILES).expect("tiles exist");

        let mut hand = vec![kan_tile];
        // Three copies are reserved for the open Pon, so the fourth is the
        // only copy allowed in hand/draw.
        counts.insert(kan_tile, 4);
        while hand.len() < 10 {
            let tile = choose(&ALL_TILES).expect("tiles exist");
            let count = counts.entry(tile).or_insert(0);
            if *count >= 4 {
                continue;
            }
            *count += 1;
            hand.push(tile);
        }

        let draw = loop {
            let tile = choose(&ALL_TILES).expect("tiles exist");
            let count = counts.entry(tile).or_insert(0);
            if *count < 4 {
                *count += 1;
                break tile;
            }
        };

        // Reject a second four-of-a-kind, which would offer an ambiguous kan.
        if counts
            .iter()
            .any(|(tile, count)| *tile != kan_tile && *count >= 4)
        {
            continue;
        }

        let meld = CalledMeld {
            meld_type: MeldType::Pon,
            tiles: vec![kan_tile.to_string(); 3],
            called_from: Some(1),
        };
        let mut display: Vec<Tile> = hand
            .iter()
            .copied()
            .chain(std::iter::once(draw))
            .chain(std::iter::repeat_n(kan_tile, 3))
            .collect();
        display.sort();

        let metrics = evaluate_hand(
            &hand
                .iter()
                .copied()
                .chain(std::iter::once(draw))
                .collect::<Vec<_>>(),
        );
        let table = match deal_table_with_human(display) {
            Ok(table) => table,
            Err(_) => continue,
        };
        match assemble_checked(category, table, hand, draw, metrics, false, vec![meld]) {
            Ok(state) => return Ok(state),
            Err(_) => continue,
        }
    }
    Err("could not build a kakan hand".to_string())
}

fn build_ryukyoku_candidate(category: &str) -> Result<GameState, String> {
    for _ in 0..40 {
        let mut terminals: Vec<Tile> = ALL_TILES
            .iter()
            .copied()
            .filter(|tile| match tile {
                Tile::Honor(_) => true,
                Tile::Suited { value, .. } => *value == 1 || *value == 9,
            })
            .collect();
        shuffle(&mut terminals);
        terminals.truncate(9);

        let mut counts: HashMap<Tile, u8> = HashMap::new();
        for &tile in &terminals {
            *counts.entry(tile).or_insert(0) += 1;
        }
        let mut full = terminals;
        while full.len() < 14 {
            let tile = choose(&ALL_TILES).expect("tiles exist");
            let count = counts.entry(tile).or_insert(0);
            if *count >= 4 {
                continue;
            }
            *count += 1;
            full.push(tile);
        }
        full.sort();
        let draw = full
            .pop()
            .ok_or_else(|| "nine-terminals hand was empty".to_string())?;
        let hand = full;
        let metrics = evaluate_hand(
            &hand
                .iter()
                .copied()
                .chain(std::iter::once(draw))
                .collect::<Vec<_>>(),
        );
        if metrics.is_agari {
            continue;
        }
        let table = match deal_table_with_human_no_rivers(
            hand.iter().copied().chain(std::iter::once(draw)).collect(),
        ) {
            Ok(table) => table,
            Err(_) => continue,
        };
        match assemble_checked(category, table, hand, draw, metrics, false, Vec::new()) {
            Ok(state) => return Ok(state),
            Err(_) => continue,
        }
    }
    Err("could not build a nine-terminals hand".to_string())
}

fn assemble(
    category: &str,
    table: Table,
    mut hand: Vec<Tile>,
    draw: Tile,
    metrics: HandMetrics,
    is_agari: bool,
    melds: Vec<CalledMeld>,
) -> Result<GameState, String> {
    hand.sort();
    let concealed: Vec<Tile> = hand.iter().copied().chain(std::iter::once(draw)).collect();
    let red_fives = choose_red_five(&concealed);

    let mut display_tiles = concealed.clone();
    for meld in &melds {
        for tile in &meld.tiles {
            if let Ok(parsed) = agari::parse::parse_hand(tile)
                && let Some(tile) = parsed.first()
            {
                display_tiles.push(*tile);
            }
        }
    }
    display_tiles.sort();

    let human = PlayerState {
        seat: 0,
        name: "You".to_string(),
        is_human: true,
        wind: table.human_wind,
        score: table.scores[0],
        hand: hand.iter().map(|tile| tile.to_string()).collect(),
        draw: Some(draw.to_string()),
        red_fives,
        discards: discards_from_tiles(&table.human_river),
        melds,
        is_riichi: false,
        riichi_discard_index: None,
    };

    let mut players = Vec::with_capacity(4);
    players.push(human);
    players.extend(table.deal.players);

    let hand_string = format_hand_compact(&display_tiles);
    let mut tile_strings: Vec<String> = display_tiles.iter().map(|tile| tile.to_string()).collect();
    tile_strings.sort();

    Ok(GameState {
        category: category.to_string(),
        target_action: TargetAction::Best,
        correct_action: CorrectAction::best("Pass", None, Vec::new(), "Pending"),
        decision: DecisionContext::SelfTurn,
        ai_decision: None,
        riichi_triggers: Vec::new(),
        dama_reasons: Vec::new(),
        shouminkan_triggers: Vec::new(),
        book_rationale: None,
        hand_string,
        tiles: tile_strings,
        shanten: metrics.shanten,
        is_agari,
        decompositions_count: metrics.decompositions_count,
        ukeire_tiles: metrics.ukeire_tiles,
        ukeire_total: metrics.ukeire_total,
        round_wind: table.round_wind,
        hand_number: table.hand_number,
        honba: table.honba,
        riichi_sticks: table.riichi_sticks,
        dora_indicators: table.dora_indicators,
        ura_dora_indicators: table.ura_dora_indicators,
        tiles_remaining: table.tiles_remaining,
        current_turn: 0,
        players,
    })
}

fn assemble_checked(
    category: &str,
    table: Table,
    hand: Vec<Tile>,
    draw: Tile,
    metrics: HandMetrics,
    is_agari: bool,
    melds: Vec<CalledMeld>,
) -> Result<GameState, String> {
    let state = assemble(category, table, hand, draw, metrics, is_agari, melds)?;
    validate_self_turn_candidate(&state)?;
    Ok(state)
}

/// Four random melds plus a singleton: a 13-tile tenpai hand waiting to pair
/// the singleton. The extra tile is the draw that must be discarded.
fn tenpai_shape() -> Result<(Vec<Tile>, Tile), String> {
    let mut counts: HashMap<Tile, u8> = HashMap::new();
    let mut tiles = Vec::new();

    for _ in 0..4 {
        if gen_bool(0.6) {
            let suit = match gen_range(0, 3) {
                0 => Suit::Man,
                1 => Suit::Pin,
                _ => Suit::Sou,
            };
            let start = gen_range(1, 8) as u8;
            let set = [
                Tile::suited(suit, start),
                Tile::suited(suit, start + 1),
                Tile::suited(suit, start + 2),
            ];
            if !can_add(&counts, &set) {
                return Err("could not add a sequence".to_string());
            }
            for tile in set {
                *counts.entry(tile).or_insert(0) += 1;
                tiles.push(tile);
            }
        } else {
            let tile = choose(&ALL_TILES).expect("tiles exist");
            if counts.get(&tile).copied().unwrap_or(0) + 3 > 4 {
                return Err("could not add a triplet".to_string());
            }
            for _ in 0..3 {
                *counts.entry(tile).or_insert(0) += 1;
                tiles.push(tile);
            }
        }
    }

    let mut singleton = choose(&ALL_TILES).expect("tiles exist");
    for _ in 0..40 {
        if counts.get(&singleton).copied().unwrap_or(0) < 4 {
            break;
        }
        singleton = choose(&ALL_TILES).expect("tiles exist");
    }
    if counts.get(&singleton).copied().unwrap_or(0) >= 4 {
        return Err("could not add the singleton".to_string());
    }
    *counts.entry(singleton).or_insert(0) += 1;
    tiles.push(singleton);

    let draw = sensible_draw(&counts, singleton);
    Ok((tiles, draw))
}

fn sensible_draw(counts: &HashMap<Tile, u8>, singleton: Tile) -> Tile {
    for _ in 0..80 {
        let tile = choose(&ALL_TILES).expect("tiles exist");
        if tile != singleton && counts.get(&tile).copied().unwrap_or(0) < 4 {
            return tile;
        }
    }
    // Fallback: any available tile, even the singleton (the caller rejects a
    // complete hand).
    choose(&ALL_TILES).expect("tiles exist")
}

fn can_add(counts: &HashMap<Tile, u8>, tiles: &[Tile]) -> bool {
    let mut needed: HashMap<Tile, u8> = HashMap::new();
    for tile in tiles {
        *needed.entry(*tile).or_insert(0) += 1;
    }
    needed
        .iter()
        .all(|(tile, count)| counts.get(tile).copied().unwrap_or(0) + count <= 4)
}

fn choose_red_five(full_tiles: &[Tile]) -> Vec<String> {
    if !gen_bool(0.35) {
        return Vec::new();
    }
    let eligible: Vec<String> = full_tiles
        .iter()
        .filter(|tile| matches!(tile.to_string().as_str(), "5m" | "5p" | "5s"))
        .map(|tile| tile.to_string())
        .collect();
    choose(&eligible).into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::actions::legal_actions;
    use crate::decision::ActionKind;

    fn actions(state: &GameState) -> Vec<ActionKind> {
        legal_actions(state).into_iter().map(|a| a.kind).collect()
    }

    #[test]
    fn riichi_candidates_offer_riichi() {
        for run in 0..60 {
            let state = build_riichi_candidate("ai_best_action")
                .unwrap_or_else(|err| panic!("run {run}: {err}"));
            super::super::validate::validate_self_turn_candidate(&state)
                .unwrap_or_else(|err| panic!("run {run}: {err}"));
            assert_eq!(state.shanten, 0);
            assert!(!state.is_agari);
            assert!(actions(&state).contains(&ActionKind::Riichi));
        }
    }

    #[test]
    fn tsumo_candidates_offer_win() {
        for run in 0..40 {
            let state = build_tsumo_candidate("ai_best_action")
                .unwrap_or_else(|err| panic!("run {run}: {err}"));
            super::super::validate::validate_self_turn_candidate(&state)
                .unwrap_or_else(|err| panic!("run {run}: {err}"));
            assert!(state.is_agari);
            assert!(actions(&state).contains(&ActionKind::Agari));
        }
    }

    #[test]
    fn ryukyoku_candidates_offer_the_draw() {
        for run in 0..40 {
            let state = build_ryukyoku_candidate("ai_best_action")
                .unwrap_or_else(|err| panic!("run {run}: {err}"));
            super::super::validate::validate_self_turn_candidate(&state)
                .unwrap_or_else(|err| panic!("run {run}: {err}"));
            assert!(
                state
                    .players
                    .iter()
                    .all(|player| player.discards.is_empty())
            );
            assert!(actions(&state).contains(&ActionKind::Ryukyoku));
        }
    }

    #[test]
    fn kakan_candidates_offer_kan() {
        for run in 0..40 {
            let state = build_kakan_candidate("ai_best_action")
                .unwrap_or_else(|err| panic!("run {run}: {err}"));
            super::super::validate::validate_self_turn_candidate(&state)
                .unwrap_or_else(|err| panic!("run {run}: {err}"));
            assert_eq!(state.players[0].melds.len(), 1);
            assert_eq!(state.players[0].hand.len(), 10);
            assert!(actions(&state).contains(&ActionKind::Kan));
        }
    }

    #[test]
    fn ankan_candidates_offer_kan() {
        for run in 0..40 {
            let state = build_ankan_candidate("ai_best_action")
                .unwrap_or_else(|err| panic!("run {run}: {err}"));
            super::super::validate::validate_self_turn_candidate(&state)
                .unwrap_or_else(|err| panic!("run {run}: {err}"));
            assert!(actions(&state).contains(&ActionKind::Kan));
        }
    }
}
