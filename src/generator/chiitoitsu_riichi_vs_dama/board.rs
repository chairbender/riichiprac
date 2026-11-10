use agari::context::indicator_to_dora;
use agari::parse::validate_hand;
use agari::tile::Tile;

use super::dama;
use super::riichi;
use super::skeleton::{ChiitoitsuDecision, ChiitoitsuSkeleton, has_six_pairs_and_singleton};
use crate::generator::support::analysis::{HandMetrics, evaluate_hand};
use crate::generator::support::deck::{ALL_TILES, Deck};
use crate::generator::support::format::format_hand_compact;
use crate::generator::support::table::{
    OpponentDeal, deal_opponents, discards_from_tiles, random_round, random_scores_with_human_first,
};
use crate::generator::support::tiles::suji_tiles;
use crate::rng::{choose, gen_range};
use crate::state::{CorrectAction, GameState, PlayerState, TargetAction, Wind};

/// The validated hand shapes for one chiitoitsu puzzle.
struct PreparedHand {
    full_tiles: Vec<Tile>,
    tenpai_tiles: Vec<Tile>,
    winning_tiles: Vec<Tile>,
    tenpai_metrics: HandMetrics,
    winning_decompositions: usize,
}

/// Board-level values chosen after the hand and dora are fixed.
struct TableContext {
    round_wind: Wind,
    hand_number: u8,
    human_wind: Wind,
    dora_indicators: Vec<Tile>,
    ura_indicator: Tile,
    scores: [i32; 4],
    human_river: Vec<Tile>,
    deal: OpponentDeal,
    tiles_remaining: u8,
}

/// Builds and validates a complete board for a chiitoitsu skeleton.
pub(super) fn build(category: &str, skeleton: &ChiitoitsuSkeleton) -> Result<GameState, String> {
    let prepared = prepare_hand(skeleton)?;

    let (round_wind, hand_number) = random_round();
    let human_wind = choose_human_wind(skeleton)?;
    let aka_count = u8::from(skeleton.red_five_wait);
    let dora_indicators = choose_dora_indicators(skeleton, &prepared.winning_tiles, aka_count)?;

    validate_score(
        skeleton,
        &prepared.winning_tiles,
        round_wind,
        human_wind,
        &dora_indicators,
        aka_count,
    )?;

    let (mut deck, ura_indicator) =
        build_deck(&prepared.full_tiles, &dora_indicators, skeleton.wait_tile)?;

    let scores = random_scores_with_human_first();
    // The human is about to discard, so every player has completed the
    // same number of turns and made one discard per turn.
    let discard_count = gen_range(2, 7);
    let deal = deal_opponents(&mut deck, human_wind, &scores, discard_count)
        .ok_or_else(|| "Deck exhausted drawing the opponents".to_string())?;
    let human_river = build_human_river(skeleton, &mut deck, discard_count)?;

    validate_visible_waits(skeleton.wait_tile, &deal.rivers, &dora_indicators)?;

    if skeleton.decision == ChiitoitsuDecision::Dama {
        dama::validate_board_constraints(
            human_wind,
            skeleton.wait_tile,
            skeleton.red_five_wait,
            &skeleton.pairs,
            aka_count,
        )?;
    }

    let tiles_remaining = deck.remaining().saturating_sub(12).min(u8::MAX as usize) as u8;
    if tiles_remaining == 0 {
        return Err("No drawable tiles remain".to_string());
    }

    Ok(assemble_state(
        category,
        skeleton,
        prepared,
        TableContext {
            round_wind,
            hand_number,
            human_wind,
            dora_indicators,
            ura_indicator,
            scores,
            human_river,
            deal,
            tiles_remaining,
        },
    ))
}

/// Validates the seven-pairs shape and evaluates both the tenpai and winning hands.
fn prepare_hand(skeleton: &ChiitoitsuSkeleton) -> Result<PreparedHand, String> {
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
fn choose_human_wind(skeleton: &ChiitoitsuSkeleton) -> Result<Wind, String> {
    if skeleton.decision == ChiitoitsuDecision::Riichi && skeleton.triggers.dealer {
        Ok(Wind::East)
    } else {
        choose(&[Wind::South, Wind::West, Wind::North])
            .ok_or_else(|| "No non-dealer winds available".to_string())
    }
}

/// Chooses dora indicators according to the Riichi or dama lesson.
fn choose_dora_indicators(
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
fn validate_score(
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
fn build_deck(
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
fn build_human_river(
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
fn validate_visible_waits(
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

/// Assembles the public `GameState` from the validated pieces.
fn assemble_state(
    category: &str,
    skeleton: &ChiitoitsuSkeleton,
    prepared: PreparedHand,
    context: TableContext,
) -> GameState {
    let PreparedHand {
        full_tiles,
        tenpai_tiles,
        tenpai_metrics,
        winning_decompositions,
        ..
    } = prepared;
    let TableContext {
        round_wind,
        hand_number,
        human_wind,
        dora_indicators,
        ura_indicator,
        scores,
        human_river,
        deal,
        tiles_remaining,
    } = context;

    let mut display_tiles = full_tiles;
    display_tiles.sort();
    let mut sorted_hand = tenpai_tiles;
    sorted_hand.sort();

    let hand_string = format_hand_compact(&display_tiles);
    let tile_strings: Vec<String> = display_tiles.iter().map(|tile| tile.to_string()).collect();
    let human_red_fives = if skeleton.red_five_wait {
        vec![skeleton.wait_tile.to_string()]
    } else {
        Vec::new()
    };

    let human_player = PlayerState {
        seat: 0,
        name: "You".to_string(),
        is_human: true,
        wind: human_wind,
        score: scores[0],
        hand: sorted_hand.iter().map(|tile| tile.to_string()).collect(),
        draw: Some(skeleton.discard_tile.to_string()),
        red_fives: human_red_fives,
        discards: discards_from_tiles(&human_river),
        melds: Vec::new(),
        is_riichi: false,
        riichi_discard_index: None,
    };

    let mut players = Vec::with_capacity(4);
    players.push(human_player);
    players.extend(deal.players);

    let (target_action, correct_action) = match skeleton.decision {
        ChiitoitsuDecision::Riichi => (
            TargetAction::Riichi,
            CorrectAction::riichi(skeleton.discard_tile.to_string()),
        ),
        ChiitoitsuDecision::Dama => (
            TargetAction::Dama,
            CorrectAction::dama(skeleton.discard_tile.to_string()),
        ),
    };
    let dama_reasons = match skeleton.decision {
        ChiitoitsuDecision::Riichi => Vec::new(),
        ChiitoitsuDecision::Dama => dama::reasons(),
    };

    GameState {
        category: category.to_string(),
        target_action,
        correct_action,
        riichi_triggers: skeleton.triggers.to_vec(),
        dama_reasons,
        shouminkan_triggers: Vec::new(),
        hand_string,
        tiles: tile_strings,
        shanten: tenpai_metrics.shanten,
        is_agari: false,
        decompositions_count: winning_decompositions,
        ukeire_tiles: tenpai_metrics.ukeire_tiles,
        ukeire_total: tenpai_metrics.ukeire_total,
        round_wind,
        hand_number,
        honba: gen_range(0, 4) as u8,
        riichi_sticks: 0,
        dora_indicators: dora_indicators
            .iter()
            .map(|indicator| indicator.to_string())
            .collect(),
        ura_dora_indicators: vec![ura_indicator.to_string()],
        tiles_remaining,
        current_turn: 0,
        players,
    }
}
