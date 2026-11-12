//! Board assembly for the concealed-quad (ankan) decision.
//!
//! The hand is the only special part: all four copies of the quad tile are
//! still concealed, so the state carries a thirteen-tile hand plus the drawn
//! fourth copy and no melds. Everything else - the round, the scores, the
//! rivers, the opponents - is the shared table machinery.

use agari::context::indicator_to_dora;
use agari::parse::validate_hand;
use agari::tile::Tile;

use super::skeleton::AnkanSkeleton;
use crate::generator::support::analysis::{HandMetrics, evaluate_hand};
use crate::generator::support::deck::{ALL_TILES, Deck};
use crate::generator::support::format::format_hand_compact;
use crate::generator::support::table::{
    deal_opponents, discards_from_tiles, random_round, random_table_scores, self_turn_river_plan,
};
use crate::rng::{choose, gen_range, shuffle};
use crate::state::{CorrectAction, DecisionContext, GameState, PlayerState, TargetAction, Wind};

/// What the board asks the player to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum AnkanAnswer {
    /// Declare the concealed quad.
    Kan,
    /// Keep the four copies concealed and discard the useless tile instead.
    Decline,
}

/// Builds and validates a complete concealed-quad board.
pub(super) fn build(
    category: &str,
    skeleton: &AnkanSkeleton,
    answer: AnkanAnswer,
) -> Result<GameState, String> {
    let full_tiles = skeleton.full_tiles();
    validate_hand(&full_tiles)?;
    let metrics = evaluate_hand(&full_tiles);
    if metrics.is_agari {
        return Err("the concealed-quad decision cannot be a finished hand".to_string());
    }

    let (mut deck, dora_indicator, ura_indicator) = build_deck(skeleton)?;
    let (round_wind, hand_number) = random_round();
    let mut scores = random_table_scores();
    shuffle(&mut scores);
    let human_wind = choose(&Wind::ALL).ok_or_else(|| "No seat wind available".to_string())?;

    // No calls have happened: the quad decision is the human's own draw, and a
    // closed hand's rivers follow the plain rotation.
    let plan = self_turn_river_plan(human_wind, &[], gen_range(2, 8));
    let deal = deal_opponents(&mut deck, human_wind, &scores, &plan)
        .ok_or_else(|| "Deck exhausted drawing the opponents".to_string())?;
    let human_river = deck
        .draw_excluding(plan.counts[0], &[])
        .ok_or_else(|| "Deck exhausted drawing the human river".to_string())?;

    let tiles_remaining = deck.remaining().saturating_sub(12).min(u8::MAX as usize) as u8;
    if tiles_remaining == 0 {
        return Err("No drawable tiles remain".to_string());
    }

    Ok(assemble_state(
        category,
        skeleton,
        answer,
        full_tiles,
        metrics,
        TableContext {
            round_wind,
            hand_number,
            human_wind,
            dora_indicator,
            ura_indicator,
            scores,
            human_river,
            deal,
            tiles_remaining,
        },
    ))
}

/// Table values chosen after the hand and indicators are fixed.
struct TableContext {
    round_wind: Wind,
    hand_number: u8,
    human_wind: Wind,
    dora_indicator: Tile,
    ura_indicator: Tile,
    scores: [i32; 4],
    human_river: Vec<Tile>,
    deal: crate::generator::support::table::OpponentDeal,
    tiles_remaining: u8,
}

/// Removes the hand from the deck and draws the dora and ura indicators.
///
/// Neither indicator may make the quad tile itself dora: the lesson turns on
/// the shape, never on a Kan that happens to be worth extra dora.
fn build_deck(skeleton: &AnkanSkeleton) -> Result<(Deck, Tile, Tile), String> {
    let mut deck = Deck::fresh();
    for tile in &skeleton.full_tiles() {
        deck.take(*tile)?;
    }

    let legal_indicator = |deck: &Deck, indicator: Tile| {
        deck.has(indicator)
            && indicator != skeleton.quad_tile
            && indicator_to_dora(indicator) != skeleton.quad_tile
    };

    let dora_candidates: Vec<Tile> = ALL_TILES
        .iter()
        .copied()
        .filter(|&indicator| legal_indicator(&deck, indicator))
        .collect();
    let dora_indicator =
        choose(&dora_candidates).ok_or_else(|| "No legal dora indicator".to_string())?;
    deck.take(dora_indicator)?;

    let ura_candidates: Vec<Tile> = ALL_TILES
        .iter()
        .copied()
        .filter(|&indicator| legal_indicator(&deck, indicator))
        .collect();
    let ura_indicator =
        choose(&ura_candidates).ok_or_else(|| "No legal ura indicator".to_string())?;
    deck.take(ura_indicator)?;

    Ok((deck, dora_indicator, ura_indicator))
}

/// Assembles the public `GameState` from the validated pieces.
fn assemble_state(
    category: &str,
    skeleton: &AnkanSkeleton,
    answer: AnkanAnswer,
    full_tiles: Vec<Tile>,
    metrics: HandMetrics,
    context: TableContext,
) -> GameState {
    let TableContext {
        round_wind,
        hand_number,
        human_wind,
        dora_indicator,
        ura_indicator,
        scores,
        human_river,
        deal,
        tiles_remaining,
    } = context;

    let mut display_tiles = full_tiles;
    display_tiles.sort();
    let hand_string = format_hand_compact(&display_tiles);
    let tile_strings: Vec<String> = display_tiles.iter().map(|tile| tile.to_string()).collect();

    // The three copies already in hand plus the drawn fourth one.
    let mut concealed_hand: Vec<Tile> = skeleton.concealed_tiles.clone();
    concealed_hand.extend([skeleton.quad_tile; 3]);
    concealed_hand.sort();

    let correct_action = match answer {
        AnkanAnswer::Kan => CorrectAction::kan(skeleton.quad_tile.to_string()),
        AnkanAnswer::Decline => CorrectAction::discard(
            skeleton
                .decline_discard
                .expect("the decline skeleton names its discard")
                .to_string(),
        ),
    };

    let human_player = PlayerState {
        seat: 0,
        name: "You".to_string(),
        is_human: true,
        wind: human_wind,
        score: scores[0],
        hand: concealed_hand.iter().map(|tile| tile.to_string()).collect(),
        draw: Some(skeleton.quad_tile.to_string()),
        red_fives: Vec::new(),
        discards: discards_from_tiles(&human_river),
        melds: Vec::new(),
        is_riichi: false,
        riichi_discard_index: None,
    };

    let mut players = Vec::with_capacity(4);
    players.push(human_player);
    players.extend(deal.players);

    GameState {
        category: category.to_string(),
        // Both answers share one neutral prompt: "Call the quad, or discard?"
        target_action: TargetAction::Kan,
        correct_action,
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
        hand_string,
        tiles: tile_strings,
        shanten: metrics.shanten,
        is_agari: metrics.is_agari,
        decompositions_count: metrics.decompositions_count,
        ukeire_tiles: metrics.ukeire_tiles,
        ukeire_total: metrics.ukeire_total,
        round_wind,
        hand_number,
        honba: gen_range(0, 4) as u8,
        riichi_sticks: 0,
        dora_indicators: vec![dora_indicator.to_string()],
        ura_dora_indicators: vec![ura_indicator.to_string()],
        tiles_remaining,
        current_turn: 0,
        players,
    }
}
