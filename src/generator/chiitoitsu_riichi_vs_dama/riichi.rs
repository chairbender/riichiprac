use agari::context::indicator_to_dora;
use agari::tile::Tile;

use super::scoring;
use super::skeleton::{ChiitoitsuDecision, ChiitoitsuSkeleton};
use super::triggers::RiichiTriggerSet;
use crate::generator::support::analysis::regular_dora_in_hand;
use crate::generator::support::deck::{ALL_TILES, Deck};
use crate::generator::support::tiles::{is_outside_456, suji_tiles};
use crate::rng::{choose, shuffle};
use crate::state::Wind;

/// Builds six distinct pairs plus a wait singleton and an unwanted
/// singleton that will be discarded, under the chosen Riichi heuristics.
pub(super) fn build_skeleton(triggers: RiichiTriggerSet) -> Result<ChiitoitsuSkeleton, String> {
    let wait_candidates: Vec<Tile> = ALL_TILES
        .iter()
        .copied()
        .filter(|&tile| {
            if triggers.red_five_wait && tile.value() != Some(5) {
                return false;
            }
            if triggers.tanyao && !tile.is_simple() {
                return false;
            }
            if triggers.wait_outside_456 && !is_outside_456(tile) {
                return false;
            }
            if triggers.suji_trap && tile.suit().is_none() {
                return false;
            }
            true
        })
        .collect();

    let wait_tile =
        choose(&wait_candidates).ok_or_else(|| "No compatible wait tile".to_string())?;

    let mut deck = Deck::fresh();
    deck.take(wait_tile)?;

    let mut pairs = Vec::with_capacity(6);
    for _ in 0..6 {
        let candidates: Vec<Tile> = ALL_TILES
            .iter()
            .copied()
            .filter(|&tile| {
                tile != wait_tile
                    && !pairs.contains(&tile)
                    && deck.count(tile) >= 2
                    && (!triggers.tanyao || tile.is_simple())
            })
            .collect();

        let pair = choose(&candidates).ok_or_else(|| "No pair candidates left".to_string())?;
        deck.take_n(pair, 2)?;
        pairs.push(pair);
    }

    let discard_candidates: Vec<Tile> = ALL_TILES
        .iter()
        .copied()
        .filter(|&tile| tile != wait_tile && !pairs.contains(&tile) && deck.has(tile))
        .collect();
    let discard_tile =
        choose(&discard_candidates).ok_or_else(|| "No discard candidates left".to_string())?;

    Ok(ChiitoitsuSkeleton {
        pairs,
        wait_tile,
        discard_tile,
        decision: ChiitoitsuDecision::Riichi,
        red_five_wait: triggers.red_five_wait,
        triggers,
        dora_pairs: Vec::new(),
    })
}

/// Chooses the dora indicator for a Riichi hand, keeping the wait off the dora
/// and respecting the "below Mangan" trigger when present.
pub(super) fn choose_dora_indicators(
    winning_tiles: &[Tile],
    wait_tile: Tile,
    triggers: RiichiTriggerSet,
    aka_count: u8,
) -> Result<Vec<Tile>, String> {
    let dora_candidates: Vec<Tile> = ALL_TILES
        .iter()
        .copied()
        .filter(|&indicator| {
            if indicator_to_dora(indicator) == wait_tile {
                return false;
            }
            if triggers.score_below_mangan {
                regular_dora_in_hand(winning_tiles, indicator) + aka_count <= 1
            } else {
                true
            }
        })
        .collect();

    Ok(vec![
        choose(&dora_candidates).ok_or_else(|| "No legal dora indicator".to_string())?,
    ])
}

/// Builds the human river, optionally forcing a same-suit suji of the wait
/// while never allowing the wait tile itself to appear (furiten).
pub(super) fn build_human_river(
    deck: &mut Deck,
    count: usize,
    wait_tile: Tile,
    suji_trap: bool,
) -> Result<Vec<Tile>, String> {
    let mut river = Vec::with_capacity(count);

    if suji_trap {
        let suji = suji_tiles(wait_tile);
        let tile = choose(&suji).ok_or_else(|| "No suji available for the wait".to_string())?;
        deck.take(tile)?;
        river.push(tile);
    }

    let remaining = count.saturating_sub(river.len());
    let mut extra = deck
        .draw_excluding(remaining, &[wait_tile])
        .ok_or_else(|| "Deck exhausted drawing the human river".to_string())?;
    river.append(&mut extra);
    shuffle(&mut river);

    Ok(river)
}

/// Rejects completed hands that score Mangan or better without Riichi.
pub(super) fn validate_score(
    winning_tiles: &[Tile],
    wait_tile: Tile,
    round_wind: Wind,
    seat_wind: Wind,
    dora_indicator: Tile,
    aka_count: u8,
) -> Result<(), String> {
    if !scoring::scores_below_mangan(
        winning_tiles,
        wait_tile,
        round_wind,
        seat_wind,
        dora_indicator,
        aka_count,
    ) {
        return Err("Completed chiitoitsu hand is not below Mangan without Riichi".to_string());
    }

    Ok(())
}
