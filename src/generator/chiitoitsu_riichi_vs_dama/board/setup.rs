use agari::context::indicator_to_dora;
use agari::parse::validate_hand;
use agari::tile::Tile;

use super::super::dama;
use super::super::riichi;
use super::super::skeleton::{ChiitoitsuDecision, ChiitoitsuSkeleton, has_six_pairs_and_singleton};
use super::PreparedHand;
use crate::generator::support::analysis::evaluate_hand;
use crate::generator::support::deck::{ALL_TILES, Deck};
use crate::generator::support::tiles::suji_tiles;
use crate::rng::choose;
use crate::state::Wind;

pub(super) fn prepare_hand(skeleton: &ChiitoitsuSkeleton) -> Result<PreparedHand, String> {
    let full_tiles = skeleton.full_tiles();
    validate_hand(&full_tiles)?;

    let tenpai_tiles = skeleton.tenpai_tiles();
    if !has_six_pairs_and_singleton(&tenpai_tiles, skeleton.wait_tile) {
        return Err("Chiitoitsu skeleton is not six pairs plus one singleton".to_string());
    }

    let tenpai_metrics = evaluate_hand(&tenpai_tiles);
    if tenpai_metrics.shanten != 0 {
        return Err("Chiitoitsu discard must leave a tenpai hand".to_string());
    }
    if tenpai_metrics.ukeire_tiles.len() != 1
        || tenpai_metrics.ukeire_tiles[0] != skeleton.wait_tile.to_string()
    {
        return Err("Chiitoitsu hand must have exactly the intended wait".to_string());
    }

    let mut winning_tiles = tenpai_tiles.clone();
    winning_tiles.push(skeleton.wait_tile);
    let winning_metrics = evaluate_hand(&winning_tiles);

    Ok(PreparedHand {
        full_tiles,
        tenpai_tiles,
        winning_tiles,
        tenpai_metrics,
        winning_decompositions: winning_metrics.decompositions_count,
    })
}

/// Chooses the human seat wind, honouring the dealer trigger.
pub(super) fn choose_human_wind(skeleton: &ChiitoitsuSkeleton) -> Result<Wind, String> {
    if skeleton.decision == ChiitoitsuDecision::Riichi && skeleton.triggers.dealer {
        Ok(Wind::East)
    } else {
        choose(&[Wind::South, Wind::West, Wind::North])
            .ok_or_else(|| "No non-dealer winds available".to_string())
    }
}

/// Chooses dora indicators according to the Riichi or dama lesson.
pub(super) fn choose_dora_indicators(
    skeleton: &ChiitoitsuSkeleton,
    winning_tiles: &[Tile],
    aka_count: u8,
) -> Result<Vec<Tile>, String> {
    match skeleton.decision {
        ChiitoitsuDecision::Riichi => riichi::choose_dora_indicators(
            winning_tiles,
            skeleton.wait_tile,
            skeleton.triggers,
            aka_count,
        ),
        ChiitoitsuDecision::Dama => {
            dama::choose_dora_indicators(&skeleton.dora_pairs, winning_tiles, skeleton.wait_tile)
        }
    }
}

/// Rejects completed hands that break the lesson's scoring target.
pub(super) fn validate_score(
    skeleton: &ChiitoitsuSkeleton,
    winning_tiles: &[Tile],
    round_wind: Wind,
    human_wind: Wind,
    dora_indicators: &[Tile],
    aka_count: u8,
) -> Result<(), String> {
    match skeleton.decision {
        ChiitoitsuDecision::Riichi => riichi::validate_score(
            winning_tiles,
            skeleton.wait_tile,
            round_wind,
            human_wind,
            dora_indicators[0],
            aka_count,
        ),
        ChiitoitsuDecision::Dama => dama::validate_score(
            winning_tiles,
            skeleton.wait_tile,
            round_wind,
            human_wind,
            dora_indicators,
            aka_count,
        ),
    }
}

/// Removes the hand and indicators from the deck and draws the ura indicator.
pub(super) fn build_deck(
    full_tiles: &[Tile],
    dora_indicators: &[Tile],
    wait_tile: Tile,
) -> Result<(Deck, Tile), String> {
    let mut deck = Deck::fresh();
    for tile in full_tiles {
        deck.take(*tile)?;
    }
    for indicator in dora_indicators {
        deck.take(*indicator)?;
    }

    let ura_candidates: Vec<Tile> = ALL_TILES
        .iter()
        .copied()
        .filter(|&indicator| indicator_to_dora(indicator) != wait_tile && deck.has(indicator))
        .collect();
    let ura_indicator =
        choose(&ura_candidates).ok_or_else(|| "No legal ura indicator".to_string())?;
    deck.take(ura_indicator)?;

    Ok((deck, ura_indicator))
}

/// Builds the human river under the active lesson's furiten/suji rules.
pub(super) fn build_human_river(
    skeleton: &ChiitoitsuSkeleton,
    deck: &mut Deck,
    discard_count: usize,
) -> Result<Vec<Tile>, String> {
    match skeleton.decision {
        ChiitoitsuDecision::Riichi => riichi::build_human_river(
            deck,
            discard_count,
            skeleton.wait_tile,
            skeleton.triggers.suji_trap,
        ),
        ChiitoitsuDecision::Dama => {
            let river = dama::build_human_river(deck, discard_count, skeleton.wait_tile)?;
            let suji = suji_tiles(skeleton.wait_tile);
            if river.iter().any(|tile| suji.contains(tile)) {
                return Err("Dama river must not contain a wait suji".to_string());
            }
            Ok(river)
        }
    }
}

/// Rejects a wait when too many winning tiles are already visible.
pub(super) fn validate_visible_waits(
    wait_tile: Tile,
    opponent_rivers: &[Vec<Tile>],
    dora_indicators: &[Tile],
) -> Result<(), String> {
    let mut visible_wait_tiles = 0;
    for river in opponent_rivers {
        for tile in river {
            if *tile == wait_tile {
                visible_wait_tiles += 1;
            }
        }
    }
    for indicator in dora_indicators {
        if *indicator == wait_tile {
            visible_wait_tiles += 1;
        }
    }
    if visible_wait_tiles > 2 {
        return Err(format!(
            "{visible_wait_tiles} chiitoitsu wait tiles are already visible"
        ));
    }

    Ok(())
}
