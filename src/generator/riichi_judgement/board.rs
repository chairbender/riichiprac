//! Table setup for the general Riichi-judgement lesson.
//!
//! The board is deliberately quiet: three opponents with concealed hands and
//! rivers, one dora indicator, no calls and no riichi. That keeps the book's
//! three-condition rule the only thing that decides the answer. The rest of
//! ch. 7's dama cases are board-reading exceptions (in the lead, a genbutsu
//! wait, an opponent drawing attention) and are not modelled here.

use agari::context::indicator_to_dora;
use agari::tile::Tile;

use super::judgement::{self, Conditions, MIN_LIVE_TILES};
use super::skeleton::Skeleton;
use crate::generator::support::analysis::{evaluate_hand, visible_tile_counts};
use crate::generator::support::deck::{ALL_TILES, Deck};
use crate::generator::support::format::format_hand_compact;
use crate::generator::support::table::{
    OpponentDeal, deal_opponents, discards_from_tiles, random_round,
    random_scores_with_human_first, self_turn_river_plan,
};
use crate::rng::{choose, gen_range};
use crate::state::{
    CorrectAction, DamaReason, DecisionContext, GameState, PlayerState, RiichiTrigger,
    TargetAction, Wind,
};

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
    target: Conditions,
) -> Result<GameState, String> {
    let full_tiles = skeleton.full_tiles();
    let tenpai_metrics = evaluate_hand(&skeleton.tenpai_tiles);
    if tenpai_metrics.shanten != 0 {
        return Err("Riichi-judgement hand must be tenpai after the discard".to_string());
    }
    // The draw is what reaches tenpai: the hand before it must not already be
    // tenpai, or the table would imply the player passed up Riichi earlier.
    let pre_draw_tiles = skeleton.pre_draw_tiles();
    let pre_draw_metrics = evaluate_hand(&pre_draw_tiles);
    if pre_draw_metrics.shanten != 1 {
        return Err(format!(
            "Riichi-judgement hand must be 1-shanten before the draw, not {}",
            pre_draw_metrics.shanten
        ));
    }
    // The answer is discarded from the hand, never off the draw: a tsumogiri
    // answer would say the player was already tenpai on an earlier turn.
    if skeleton.discard_tile == skeleton.drawn_tile
        || !pre_draw_tiles.contains(&skeleton.discard_tile)
    {
        return Err("Riichi-judgement answer must be a tedashi from the hand".to_string());
    }

    let (round_wind, hand_number) = random_round();
    let human_wind = if target.dealer {
        Wind::East
    } else {
        choose(&[Wind::South, Wind::West, Wind::North])
            .ok_or_else(|| "No non-dealer wind available".to_string())?
    };

    let mut deck = Deck::fresh();
    for tile in &full_tiles {
        deck.take(*tile)?;
    }

    // The dora must never touch the hand or the draw. Condition 1 counts dora,
    // so a lucky indicator would turn a riichi-only hand into a condition-1
    // hand and the dama branch could never be built.
    let dora_indicator = choose_dora_indicator(&deck, &full_tiles)?;
    deck.take(dora_indicator)?;
    let ura_indicator = choose_dora_indicator(&deck, &full_tiles)?;
    deck.take(ura_indicator)?;

    let scores = random_scores_with_human_first();
    // The human is about to discard, so every river comes from one legal
    // timeline that ends on Kamicha's discard.
    let plan = self_turn_river_plan(human_wind, &[], gen_range(2, 7));
    let deal = deal_opponents(&mut deck, human_wind, &scores, &plan)
        .ok_or_else(|| "Deck exhausted drawing the opponents".to_string())?;
    // The human is not furiten: no winning tile may already be in their river.
    let human_river = deck
        .draw_excluding(plan.counts[0], &skeleton.wait_tiles)
        .ok_or_else(|| "Deck exhausted drawing the human river".to_string())?;

    // Only table-visible tiles count. The ura indicator is not visible to the
    // player when they decide, so it is not part of the live-wait count.
    let visible = visible_tile_counts(&deal.rivers, &[dora_indicator]);

    let quality = judgement::wait_quality(&skeleton.tenpai_tiles, &visible);
    if quality.live_tiles < MIN_LIVE_TILES {
        return Err(format!(
            "Only {} live winning tiles are left; the book's 1-2 tile dama case is a \
             different lesson",
            quality.live_tiles
        ));
    }

    let conditions = judgement::evaluate(
        &skeleton.tenpai_tiles,
        &skeleton.wait_tiles,
        round_wind,
        human_wind,
        &[dora_indicator],
        &visible,
    );
    if conditions != target {
        return Err(format!(
            "Book rule computed {conditions:?}, but the hand was built for {target:?}"
        ));
    }

    // ch7 "High scoring hand": a hand already worth 7700+ is a dama case on
    // its own, so no riichi answer may be generated above mangan without riichi.
    if conditions.picks_riichi() {
        for &wait in &skeleton.wait_tiles {
            let mut winning_tiles = skeleton.tenpai_tiles.clone();
            winning_tiles.push(wait);
            if judgement::worst_score_level(
                &winning_tiles,
                wait,
                round_wind,
                human_wind,
                &[dora_indicator],
            ) >= agari::scoring::ScoreLevel::Mangan
            {
                return Err(
                    "Riichi hand is already mangan without Riichi, which the book lets you \
                     keep dama"
                        .to_string(),
                );
            }
        }
    }

    let tiles_remaining = deck.remaining().saturating_sub(12).min(u8::MAX as usize) as u8;
    if tiles_remaining == 0 {
        return Err("No drawable tiles remain".to_string());
    }

    Ok(assemble_state(
        category,
        skeleton,
        conditions,
        tenpai_metrics,
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

/// Picks an indicator whose dora lands nowhere in the visible hand.
fn choose_dora_indicator(deck: &Deck, full_tiles: &[Tile]) -> Result<Tile, String> {
    let candidates: Vec<Tile> = ALL_TILES
        .iter()
        .copied()
        .filter(|&indicator| {
            deck.has(indicator) && !full_tiles.contains(&indicator_to_dora(indicator))
        })
        .collect();

    choose(&candidates).ok_or_else(|| "No legal dora indicator".to_string())
}

/// The book's three conditions, in the order the book lists them.
fn triggers_for(conditions: Conditions) -> Vec<RiichiTrigger> {
    let mut triggers = Vec::new();
    if conditions.extra_han {
        triggers.push(RiichiTrigger::HasExtraHan);
    }
    if conditions.good_wait {
        triggers.push(RiichiTrigger::GoodWait);
    }
    if conditions.dealer {
        triggers.push(RiichiTrigger::Dealer);
    }
    triggers
}

/// The book's only prohibited riichi, spelled out as dama reasons.
fn dama_reasons() -> Vec<DamaReason> {
    vec![
        DamaReason::NotDealer,
        DamaReason::BadWait,
        DamaReason::NoExtraHan,
    ]
}

/// Assembles the public `GameState` from the validated pieces.
fn assemble_state(
    category: &str,
    skeleton: &Skeleton,
    conditions: Conditions,
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

    let human_player = PlayerState {
        seat: 0,
        name: "You".to_string(),
        is_human: true,
        wind: human_wind,
        score: scores[0],
        hand: sorted_hand.iter().map(|tile| tile.to_string()).collect(),
        draw: Some(skeleton.drawn_tile.to_string()),
        red_fives: Vec::new(),
        discards: discards_from_tiles(&human_river),
        melds: Vec::new(),
        is_riichi: false,
        riichi_discard_index: None,
    };

    let mut players = Vec::with_capacity(4);
    players.push(human_player);
    players.extend(deal.players);

    let discard = skeleton.discard_tile.to_string();
    let picks_riichi = conditions.picks_riichi();
    let (target_action, correct_action) = if picks_riichi {
        (TargetAction::Riichi, CorrectAction::riichi(discard.clone()))
    } else {
        (TargetAction::Dama, CorrectAction::dama(discard.clone()))
    };

    GameState {
        category: category.to_string(),
        target_action,
        correct_action,
        equivalent_tiles: Vec::new(),
        decision: DecisionContext::SelfTurn,
        ai_decision: None,
        riichi_triggers: triggers_for(conditions),
        dama_reasons: if picks_riichi {
            Vec::new()
        } else {
            dama_reasons()
        },
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
