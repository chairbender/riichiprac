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

/// Whether a lone tile can serve as the kept Riichi wait under every active
/// heuristic.
///
/// The twin-discard model also runs the other lone tile through this test, so
/// the declaration is correct whichever tile the player keeps. The red-five
/// model only runs the kept wait through it: the second lone tile is the
/// discard, and the red-five rule needs the red five to stay in hand.
fn wait_matches(tile: Tile, triggers: RiichiTriggerSet) -> bool {
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
}

/// Builds five distinct pairs plus three lone tiles under the chosen Riichi
/// heuristics: the tile the draw completes, the canonically kept wait, and the
/// lone tile that is discarded.
pub(super) fn build_skeleton(triggers: RiichiTriggerSet) -> Result<ChiitoitsuSkeleton, String> {
    // The red-five lesson is single-answer, so another trigger would keep
    // justifying Riichi on the mirror discard and break that model.
    if triggers.red_five_wait
        && (RiichiTriggerSet {
            red_five_wait: false,
            ..triggers
        })
        .any()
    {
        return Err("The red-five trigger must not be combined with another".to_string());
    }

    let wait_candidates: Vec<Tile> = ALL_TILES
        .iter()
        .copied()
        .filter(|&tile| wait_matches(tile, triggers))
        .collect();

    let wait_tile =
        choose(&wait_candidates).ok_or_else(|| "No compatible wait tile".to_string())?;

    let discard_candidates: Vec<Tile> = if triggers.red_five_wait {
        // The hand shows exactly one five, and it is the red five kept as the
        // wait. Any other lone tile is a legal discard; discarding the red
        // five would remove the book's justification for Riichi.
        ALL_TILES
            .iter()
            .copied()
            .filter(|&tile| tile != wait_tile && tile.value() != Some(5))
            .collect()
    } else {
        wait_candidates
            .iter()
            .copied()
            .filter(|&tile| tile != wait_tile)
            .collect()
    };
    let discard_tile =
        choose(&discard_candidates).ok_or_else(|| "No compatible discard tile".to_string())?;

    let mut deck = Deck::fresh();
    deck.take(wait_tile)?;
    deck.take(discard_tile)?;

    let mut pairs = Vec::with_capacity(5);
    for _ in 0..5 {
        let candidates: Vec<Tile> = ALL_TILES
            .iter()
            .copied()
            .filter(|&tile| {
                tile != wait_tile
                    && tile != discard_tile
                    && !pairs.contains(&tile)
                    && deck.count(tile) >= 2
                    && (!triggers.tanyao || tile.is_simple())
                    && (!triggers.red_five_wait || tile.value() != Some(5))
            })
            .collect();

        let pair = choose(&candidates).ok_or_else(|| "No pair candidates left".to_string())?;
        deck.take_n(pair, 2)?;
        pairs.push(pair);
    }

    // The draw is the second copy of this lone tile, so both copies must
    // still be in the wall.
    let drawn_candidates: Vec<Tile> = ALL_TILES
        .iter()
        .copied()
        .filter(|&tile| {
            tile != wait_tile
                && tile != discard_tile
                && !pairs.contains(&tile)
                && deck.count(tile) >= 2
                && (!triggers.tanyao || tile.is_simple())
                && (!triggers.red_five_wait || tile.value() != Some(5))
        })
        .collect();
    let drawn_tile =
        choose(&drawn_candidates).ok_or_else(|| "No drawn-tile candidates left".to_string())?;
    deck.take_n(drawn_tile, 2)?;

    Ok(ChiitoitsuSkeleton {
        pairs,
        drawn_tile,
        wait_tile,
        discard_tile,
        decision: ChiitoitsuDecision::Riichi,
        red_five_wait: triggers.red_five_wait,
        triggers,
        dora_pairs: Vec::new(),
    })
}

/// Chooses the dora indicator for a Riichi hand, keeping every accepted wait
/// off the dora and respecting the "below Mangan" trigger when present.
pub(super) fn choose_dora_indicators(
    winning_tiles: &[Tile],
    waits: &[Tile],
    triggers: RiichiTriggerSet,
    aka_count: u8,
) -> Result<Vec<Tile>, String> {
    let dora_candidates: Vec<Tile> = ALL_TILES
        .iter()
        .copied()
        .filter(|&indicator| {
            if waits
                .iter()
                .any(|&wait| indicator_to_dora(indicator) == wait)
            {
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

/// Builds the human river, optionally forcing a same-suit suji of every
/// accepted wait while never allowing one of those wait tiles itself to appear
/// (furiten).
pub(super) fn build_human_river(
    deck: &mut Deck,
    count: usize,
    waits: &[Tile],
    suji_trap: bool,
) -> Result<Vec<Tile>, String> {
    let mut river = Vec::with_capacity(count);

    if suji_trap {
        let mut used: Vec<Tile> = Vec::new();
        for &wait in waits {
            let suji: Vec<Tile> = suji_tiles(wait)
                .into_iter()
                .filter(|&tile| !waits.contains(&tile) && !used.contains(&tile))
                .collect();
            let tile = choose(&suji)
                .ok_or_else(|| "No suji available for the chiitoitsu waits".to_string())?;
            deck.take(tile)?;
            used.push(tile);
            river.push(tile);
        }
    }

    let remaining = count.saturating_sub(river.len());
    let mut extra = deck
        .draw_excluding(remaining, waits)
        .ok_or_else(|| "Deck exhausted drawing the human river".to_string())?;
    river.append(&mut extra);
    shuffle(&mut river);

    Ok(river)
}

/// Rejects completed hands that score Mangan or better without Riichi, for
/// every wait an accepted discard can leave.
pub(super) fn validate_score(
    skeleton: &ChiitoitsuSkeleton,
    round_wind: Wind,
    seat_wind: Wind,
    dora_indicator: Tile,
    aka_count: u8,
) -> Result<(), String> {
    for wait in skeleton.accepted_waits() {
        let winning_tiles = skeleton.winning_tiles(wait);
        if !scoring::scores_below_mangan(
            &winning_tiles,
            wait,
            round_wind,
            seat_wind,
            dora_indicator,
            aka_count,
        ) {
            return Err("Completed chiitoitsu hand is not below Mangan without Riichi".to_string());
        }
    }

    Ok(())
}
