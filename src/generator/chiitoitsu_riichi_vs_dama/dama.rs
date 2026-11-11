use agari::context::indicator_to_dora;
use agari::scoring::ScoreLevel;
use agari::tile::{Honor, Tile};

use super::scoring;
use super::skeleton::{ChiitoitsuDecision, ChiitoitsuSkeleton};
use super::triggers::RiichiTriggerSet;
use crate::generator::support::analysis::regular_dora_in_hand;
use crate::generator::support::deck::{ALL_TILES, Deck};
use crate::generator::support::tiles::suji_tiles;
use crate::rng::{choose, shuffle};
use crate::state::{DamaReason, Wind};

/// Builds a chiitoitsu skeleton for the strict dama lesson: non-dealer,
/// no Tanyao, both lone tiles in 4-5-6, no red-five wait, and two dora pairs.
///
/// Both lone tiles are middle tiles so the "non-dealer waiting for 4,5,6"
/// dama case holds whichever one the player keeps. The hand is otherwise
/// identical for either choice, so the declaration is the only decision.
pub(super) fn build_skeleton() -> Result<ChiitoitsuSkeleton, String> {
    let wait_candidates: Vec<Tile> = ALL_TILES
        .iter()
        .copied()
        .filter(|&tile| matches!(tile.value(), Some(4..=6)))
        .collect();
    let wait_tile = choose(&wait_candidates).ok_or_else(|| "No middle wait tile".to_string())?;
    let other_candidates: Vec<Tile> = wait_candidates
        .iter()
        .copied()
        .filter(|&tile| tile != wait_tile)
        .collect();
    let discard_tile =
        choose(&other_candidates).ok_or_else(|| "No second middle wait tile".to_string())?;

    let mut deck = Deck::fresh();
    deck.take(wait_tile)?;
    deck.take(discard_tile)?;

    // At least one terminal/honor pair is mandatory, so the hand cannot
    // have Tanyao.
    let non_simple_candidates: Vec<Tile> = ALL_TILES
        .iter()
        .copied()
        .filter(|&tile| {
            tile != wait_tile && tile != discard_tile && !tile.is_simple() && deck.count(tile) >= 2
        })
        .collect();
    let required_pair = choose(&non_simple_candidates)
        .ok_or_else(|| "No terminal/honor pair available".to_string())?;
    deck.take_n(required_pair, 2)?;

    let mut pairs = vec![required_pair];
    for _ in 0..4 {
        let candidates: Vec<Tile> = ALL_TILES
            .iter()
            .copied()
            .filter(|&tile| {
                tile != wait_tile
                    && tile != discard_tile
                    && !pairs.contains(&tile)
                    && deck.count(tile) >= 2
            })
            .collect();

        let pair = choose(&candidates).ok_or_else(|| "No pair candidates left".to_string())?;
        deck.take_n(pair, 2)?;
        pairs.push(pair);
    }

    let drawn_candidates: Vec<Tile> = ALL_TILES
        .iter()
        .copied()
        .filter(|&tile| {
            tile != wait_tile
                && tile != discard_tile
                && !pairs.contains(&tile)
                && deck.count(tile) >= 2
        })
        .collect();
    let drawn_tile =
        choose(&drawn_candidates).ok_or_else(|| "No drawn-tile candidates left".to_string())?;
    deck.take_n(drawn_tile, 2)?;

    // Two of the five pairs become dora pairs. Each pair is two dora tiles,
    // so the final hand has exactly four dora.
    let mut dora_pairs = pairs.clone();
    shuffle(&mut dora_pairs);
    dora_pairs.truncate(2);
    if dora_pairs.len() != 2 {
        return Err("Could not select two dora pairs".to_string());
    }

    Ok(ChiitoitsuSkeleton {
        pairs,
        drawn_tile,
        wait_tile,
        discard_tile,
        decision: ChiitoitsuDecision::Dama,
        red_five_wait: false,
        triggers: RiichiTriggerSet::default(),
        dora_pairs,
    })
}

/// The dora indicator that produces `tile` as dora.
pub(super) fn dora_indicator_for(tile: Tile) -> Tile {
    match tile {
        Tile::Suited { suit, value } => Tile::suited(suit, if value == 1 { 9 } else { value - 1 }),
        Tile::Honor(honor) => Tile::honor(match honor {
            Honor::East => Honor::North,
            Honor::South => Honor::East,
            Honor::West => Honor::South,
            Honor::North => Honor::West,
            Honor::White => Honor::Red,
            Honor::Green => Honor::White,
            Honor::Red => Honor::Green,
        }),
    }
}

/// Chooses the two dora indicators that make both dama pairs dora.
pub(super) fn choose_dora_indicators(
    dora_pairs: &[Tile],
    winning_tiles: &[Tile],
    waits: [Tile; 2],
) -> Result<Vec<Tile>, String> {
    if dora_pairs.len() != 2 {
        return Err("Dama hand must have exactly two dora pairs".to_string());
    }

    let indicators: Vec<Tile> = dora_pairs
        .iter()
        .map(|&tile| dora_indicator_for(tile))
        .collect();
    if indicators.iter().any(|&indicator| {
        let dora = indicator_to_dora(indicator);
        waits.contains(&dora)
    }) {
        return Err("Dama wait must not be dora".to_string());
    }

    let total_dora: u8 = indicators
        .iter()
        .map(|&indicator| regular_dora_in_hand(winning_tiles, indicator))
        .sum();
    if total_dora != 4 {
        return Err(format!(
            "Dama hand must contain exactly four dora, found {total_dora}"
        ));
    }

    Ok(indicators)
}

/// Builds a human river that contains neither wait nor any suji of either wait.
pub(super) fn build_human_river(
    deck: &mut Deck,
    count: usize,
    waits: [Tile; 2],
) -> Result<Vec<Tile>, String> {
    let mut excluded = waits.to_vec();
    for wait in waits {
        excluded.extend(suji_tiles(wait));
    }

    let mut river = deck
        .draw_excluding(count, &excluded)
        .ok_or_else(|| "Deck exhausted drawing the human river".to_string())?;
    shuffle(&mut river);

    Ok(river)
}

/// Rejects completed dama hands below Mangan, for either possible wait.
pub(super) fn validate_score(
    skeleton: &ChiitoitsuSkeleton,
    round_wind: Wind,
    seat_wind: Wind,
    dora_indicators: &[Tile],
    aka_count: u8,
) -> Result<(), String> {
    for wait in skeleton.waits() {
        let winning_tiles = skeleton.winning_tiles(wait);
        let score_level = scoring::score_level(
            &winning_tiles,
            wait,
            round_wind,
            seat_wind,
            dora_indicators,
            aka_count,
        )
        .ok_or_else(|| "Dama hand did not score as chiitoitsu".to_string())?;

        if score_level < ScoreLevel::Mangan {
            return Err(format!(
                "Dama hand must be Mangan or better without Riichi, got {score_level:?}"
            ));
        }
    }

    Ok(())
}

/// Verifies the board-level dama conditions for both possible waits.
pub(super) fn validate_board_constraints(
    human_wind: Wind,
    waits: [Tile; 2],
    red_five_wait: bool,
    pairs: &[Tile],
    aka_count: u8,
) -> Result<(), String> {
    if human_wind == Wind::East {
        return Err("Dama player must not be the dealer".to_string());
    }
    if !waits.iter().all(|wait| matches!(wait.value(), Some(4..=6))) {
        return Err("Dama wait must be exactly 4, 5, or 6".to_string());
    }
    if red_five_wait {
        return Err("Dama wait must not be a red five".to_string());
    }
    if pairs.iter().all(|pair| pair.is_simple()) {
        return Err("Dama hand must contain a terminal or honor pair".to_string());
    }
    if aka_count != 0 {
        return Err("Dama hand must not rely on red fives".to_string());
    }

    Ok(())
}

/// The fixed explanation for the dama lesson.
pub(super) fn reasons() -> Vec<DamaReason> {
    vec![
        DamaReason::NotDealer,
        DamaReason::NoTanyao,
        DamaReason::MiddleWait,
        DamaReason::NoRedFiveWait,
        DamaReason::NoSujiTrap,
        DamaReason::Mangan,
    ]
}
