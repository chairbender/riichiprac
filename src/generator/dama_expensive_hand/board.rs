//! Table setup for the ch. 7 high-scoring-hand lesson.
//!
//! The board itself is deliberately plain: three concealed opponents, no calls,
//! no riichi, one dora indicator. Everything that decides the answer is in the
//! human's hand, so this module only has to set the two situational facts the
//! book's box checks before it reaches the hand's value:
//!
//! - **Not far behind** (ch7:641): the human starts the table in front, so the
//!   "riichi because you are far behind" exception cannot apply.
//! - **Past the 6th turn** (ch7:642): every seat, the human included, has
//!   discarded at least seven tiles, so the early-turn good-wait exception
//!   cannot apply either.
//!
//! The value itself is recounted from the finished table through
//! [`super::scoring::worst_value`] — dora indicator, red five and all — and the
//! board is rejected unless that lands in the target's band.

use agari::tile::Tile;

use super::judgement;
use super::scoring;
use super::skeleton::{Skeleton, Target};
use crate::generator::support::analysis::evaluate_hand;
use crate::generator::support::deck::Deck;
use crate::generator::support::format::format_hand_compact;
use crate::generator::support::table::{
    OpponentDeal, deal_opponents, discards_from_tiles, self_turn_river_plan,
};
use crate::rng::{choose, gen_range};
use crate::state::{CorrectAction, DecisionContext, GameState, PlayerState, TargetAction, Wind};

/// Fewest discards every seat needs, so the table is past the book's 6th turn.
const MIN_RIVER: usize = 7;

/// Board-level values chosen after the hand is fixed.
struct TableContext {
    round_wind: Wind,
    hand_number: u8,
    human_wind: Wind,
    dora_indicator: Tile,
    ura_indicator: Tile,
    scores: [i32; 4],
    human_river: Vec<Tile>,
    deal: OpponentDeal,
    tiles_remaining: u8,
}

/// Builds and validates one table for an already-constructed hand.
pub(super) fn build(
    category: &str,
    skeleton: &Skeleton,
    target: Target,
) -> Result<GameState, String> {
    let tenpai_metrics = evaluate_hand(&skeleton.tenpai_tiles);
    if tenpai_metrics.shanten != 0 {
        return Err("the expensive hand must be tenpai after the discard".to_string());
    }
    let pre_draw_tiles = skeleton.pre_draw_tiles();
    if evaluate_hand(&pre_draw_tiles).shanten != 1 {
        return Err("the expensive hand must be 1-shanten before the draw".to_string());
    }
    if skeleton.discard_tile == skeleton.drawn_tile
        || !pre_draw_tiles.contains(&skeleton.discard_tile)
    {
        return Err("the expensive-hand answer must be a tedashi from the hand".to_string());
    }

    let round_wind = skeleton.round_wind;
    let human_wind = skeleton.human_wind;
    // The book's 7700 and haneman numbers are the non-dealer's ron values.
    if human_wind == Wind::East {
        return Err("the expensive-hand lesson keeps the human off the dealer seat".to_string());
    }
    let hand_number = match round_wind {
        Wind::East => gen_range(1, 5) as u8,
        Wind::South => gen_range(1, 3) as u8,
        _ => 1,
    };

    let mut deck = Deck::fresh();
    for tile in &skeleton.full_tiles() {
        deck.take(*tile)?;
    }
    deck.take(skeleton.dora_indicator)?;
    let ura_candidates: Vec<Tile> = crate::generator::support::deck::ALL_TILES
        .iter()
        .copied()
        .filter(|&tile| deck.has(tile) && tile != skeleton.dora_indicator)
        .collect();
    let ura_indicator =
        choose(&ura_candidates).ok_or_else(|| "No legal ura indicator".to_string())?;
    deck.take(ura_indicator)?;

    let scores = leading_scores();
    // The early-turn exceptions need this decision to be later than the 6th
    // turn, so every river starts with at least seven discards.
    let plan = self_turn_river_plan(human_wind, &[], gen_range(MIN_RIVER, 11));
    if plan.counts[0] < MIN_RIVER {
        return Err("the human river is too short for the lesson".to_string());
    }
    let deal = deal_opponents(&mut deck, human_wind, &scores, &plan)
        .ok_or_else(|| "Deck exhausted drawing the opponents".to_string())?;

    // Not furiten: no winning tile may already be in the human river.
    let human_river = deck
        .draw_excluding(plan.counts[0], &skeleton.wait_tiles)
        .ok_or_else(|| "Deck exhausted drawing the human river".to_string())?;

    // The two-sided wait must stay live: a river that swallowed one side would
    // make the hand a dead wait rather than the book's good side wait.
    let visible = crate::generator::support::analysis::visible_tile_counts(
        &deal.rivers,
        &[skeleton.dora_indicator],
    );
    let quality = crate::generator::riichi_judgement::judgement::wait_quality(
        &skeleton.tenpai_tiles,
        &visible,
    );
    if quality.live_kinds != 2 {
        return Err(format!(
            "the table leaves {} live winning kinds, expected the two sides of the wait",
            quality.live_kinds
        ));
    }

    // Recount the hand's value from the finished table. Nothing on the board
    // changes it, but the book's test is about the value *after* the discard,
    // so it is recomputed rather than trusted.
    let worst = scoring::worst_value(
        &skeleton.tenpai_tiles,
        &skeleton.wait_tiles,
        round_wind,
        human_wind,
        &[skeleton.dora_indicator],
        skeleton.aka_count,
    )
    .ok_or_else(|| "a winning tile has no yaku without Riichi".to_string())?;
    let verdict = judgement::verdict(worst.points)
        .ok_or_else(|| format!("the worst winning tile is only {} points", worst.points))?;
    if verdict != target.expected_verdict() {
        return Err(format!(
            "the worst winning tile is worth {} points, not the {target:?} band",
            worst.points
        ));
    }
    if skeleton.dora_tile != agari::context::indicator_to_dora(skeleton.dora_indicator) {
        return Err("the dora indicator does not make the pair dora".to_string());
    }

    let tiles_remaining = deck.remaining().saturating_sub(12).min(u8::MAX as usize) as u8;
    if tiles_remaining == 0 {
        return Err("No drawable tiles remain".to_string());
    }

    Ok(assemble_state(
        category,
        skeleton,
        verdict,
        tenpai_metrics,
        TableContext {
            round_wind,
            hand_number,
            human_wind,
            dora_indicator: skeleton.dora_indicator,
            ura_indicator,
            scores,
            human_river,
            deal,
            tiles_remaining,
        },
    ))
}

/// Four plausible scores with the human in front, so the "far behind" Riichi
/// exception cannot apply (ch7:641).
fn leading_scores() -> [i32; 4] {
    loop {
        let human = 30_000 + 1_000 * gen_range(0, 10) as i32; // 30,000-39,000
        let first = 12_000 + 1_000 * gen_range(0, 10) as i32;
        let second = 12_000 + 1_000 * gen_range(0, 10) as i32;
        let third = 100_000 - human - first - second;
        if third >= 8_000 && third < human {
            return [human, first, second, third];
        }
    }
}

/// Assembles the public `GameState` from the validated pieces.
fn assemble_state(
    category: &str,
    skeleton: &Skeleton,
    verdict: judgement::Verdict,
    tenpai_metrics: crate::generator::support::analysis::HandMetrics,
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

    let mut display_tiles = skeleton.full_tiles();
    display_tiles.sort();
    let mut sorted_hand = skeleton.pre_draw_tiles();
    sorted_hand.sort();

    let hand_string = format_hand_compact(&display_tiles);
    let tile_strings: Vec<String> = display_tiles.iter().map(|tile| tile.to_string()).collect();
    let red_fives: Vec<String> = skeleton
        .red_five
        .map(|tile| vec![tile.to_string()])
        .unwrap_or_default();

    let human_player = PlayerState {
        seat: 0,
        name: "You".to_string(),
        is_human: true,
        wind: human_wind,
        score: scores[0],
        hand: sorted_hand.iter().map(|tile| tile.to_string()).collect(),
        draw: Some(skeleton.drawn_tile.to_string()),
        red_fives,
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
        target_action: TargetAction::Dama,
        correct_action: CorrectAction::dama(skeleton.discard_tile.to_string()),
        equivalent_tiles: Vec::new(),
        decision: DecisionContext::SelfTurn,
        scenario_note: None,
        call_offer: None,
        ai_decision: None,
        riichi_triggers: Vec::new(),
        dama_reasons: verdict.dama_reasons(),
        shouminkan_triggers: Vec::new(),
        book_rationale: None,
        hand_string,
        tiles: tile_strings,
        shanten: tenpai_metrics.shanten,
        is_agari: false,
        decompositions_count: tenpai_metrics.decompositions_count,
        ukeire_tiles: tenpai_metrics.ukeire_tiles,
        ukeire_total: tenpai_metrics.ukeire_total,
        round_wind,
        hand_number,
        honba: gen_range(0, 4) as u8,
        riichi_sticks: 0,
        dora_indicators: vec![dora_indicator.to_string()],
        ura_dora_indicators: vec![ura_indicator.to_string()],
        can_riichi: false,
        tiles_remaining,
        current_turn: 0,
        players,
    }
}
