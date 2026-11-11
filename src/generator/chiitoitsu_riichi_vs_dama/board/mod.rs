mod setup;

use agari::tile::Tile;

use super::dama;
use super::skeleton::{ChiitoitsuDecision, ChiitoitsuSkeleton};
use crate::generator::support::analysis::HandMetrics;
use crate::generator::support::format::format_hand_compact;
use crate::generator::support::table::{
    OpponentDeal, deal_opponents, discards_from_tiles, random_round,
    random_scores_with_human_first, self_turn_river_counts,
};
use crate::rng::gen_range;
use crate::state::{CorrectAction, DecisionContext, GameState, PlayerState, TargetAction, Wind};
use setup::{
    build_deck, build_human_river, choose_dora_indicators, choose_human_wind, prepare_hand,
    validate_score, validate_visible_waits,
};

struct PreparedHand {
    full_tiles: Vec<Tile>,
    pre_draw_tiles: Vec<Tile>,
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

pub(super) fn build(category: &str, skeleton: &ChiitoitsuSkeleton) -> Result<GameState, String> {
    let prepared = prepare_hand(skeleton)?;

    let (round_wind, hand_number) = random_round();
    let human_wind = choose_human_wind(skeleton)?;
    let aka_count = u8::from(skeleton.red_five_wait);
    let dora_indicators = choose_dora_indicators(skeleton, &prepared.winning_tiles, aka_count)?;

    validate_score(
        skeleton,
        round_wind,
        human_wind,
        &dora_indicators,
        aka_count,
    )?;

    let (mut deck, ura_indicator) = build_deck(
        &prepared.full_tiles,
        &dora_indicators,
        &skeleton.accepted_waits(),
    )?;

    let scores = random_scores_with_human_first();
    // The human is about to discard, so every river comes from one legal
    // timeline that ends on Kamicha's discard.
    let counts = self_turn_river_counts(human_wind, &[], gen_range(2, 7));
    let deal = deal_opponents(&mut deck, human_wind, &scores, &counts)
        .ok_or_else(|| "Deck exhausted drawing the opponents".to_string())?;
    let human_river = build_human_river(skeleton, &mut deck, counts[0])?;

    validate_visible_waits(&skeleton.accepted_waits(), &deal.rivers, &dora_indicators)?;

    if skeleton.decision == ChiitoitsuDecision::Dama {
        dama::validate_board_constraints(
            human_wind,
            &skeleton.accepted_waits(),
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

/// Assembles the public `GameState` from the validated pieces.
fn assemble_state(
    category: &str,
    skeleton: &ChiitoitsuSkeleton,
    prepared: PreparedHand,
    context: TableContext,
) -> GameState {
    let PreparedHand {
        full_tiles,
        pre_draw_tiles,
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
    let mut sorted_hand = pre_draw_tiles;
    sorted_hand.sort();

    let hand_string = format_hand_compact(&display_tiles);
    let tile_strings: Vec<String> = display_tiles.iter().map(|tile| tile.to_string()).collect();
    // The red-five lesson keeps exactly one red five, and it is the wait.
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
        draw: Some(skeleton.drawn_tile.to_string()),
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
        // The draw completed the sixth pair, so the hand holds two lone tiles.
        // In the twin model dropping either one leaves a seven-pairs tenpai
        // and the lesson constraints hold for both waits. In the red-five
        // model the kept wait is the hand's only red five: discarding it would
        // give away the dora and the book's red-five justification, so only
        // the other lone tile is accepted.
        equivalent_tiles: if skeleton.red_five_wait {
            Vec::new()
        } else {
            vec![skeleton.wait_tile.to_string()]
        },
        decision: DecisionContext::SelfTurn,
        ai_decision: None,
        riichi_triggers: skeleton.triggers.to_vec(),
        dama_reasons,
        shouminkan_triggers: Vec::new(),
        book_rationale: None,
        can_riichi: false,
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
