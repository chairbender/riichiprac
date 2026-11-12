//! Table setup for the ch. 7 improving-hand lesson.
//!
//! The board has one job beyond keeping the table legal: it must leave every
//! counted improving kind **live**. The count is a property of the ready hand
//! (the same theoretical four-copies count `agari` reports for `ukeire`), so a
//! river that swallowed an improving tile would quietly turn one of the box's
//! six kinds into a dead one. The rivers therefore never show an improving
//! tile, either single, or the dora indicator, and the wait is never discarded
//! by the human (no furiten).
//!
//! Everything else is the ch. 7 improving box's other half: it is still an
//! early turn (ch7:658), so every river is short — at most seven discards per
//! seat, which is the 8th turn at the latest. And the hand has one dora, so the
//! general three-condition rule (ch7:55-59) picks Riichi: the improving box is
//! the only reason the answer is dama.

use agari::context::indicator_to_dora;
use agari::tile::Tile;

use super::skeleton::Skeleton;
use crate::generator::riichi_judgement::judgement as riichi;
use crate::generator::support::analysis::{evaluate_hand, visible_tile_counts};
use crate::generator::support::deck::{ALL_TILES, Deck};
use crate::generator::support::format::format_hand_compact;
use crate::generator::support::table::{
    OpponentDeal, discards_from_tiles, random_scores_with_human_first, self_turn_river_plan,
};
use crate::rng::{choose, gen_range};
use crate::state::{
    CorrectAction, DamaReason, DecisionContext, GameState, PlayerState, TargetAction,
};

/// ch7:658: "an early turn (8th turn or before)". The human is about to make
/// their next discard, so at most seven discards may already be in the river.
pub(super) const EARLY_TURN_MAX_DISCARDS: usize = 7;

/// Board-level values chosen after the hand is fixed.
struct TableContext {
    round_wind: crate::state::Wind,
    hand_number: u8,
    human_wind: crate::state::Wind,
    dora_indicator: Tile,
    ura_indicator: Tile,
    scores: [i32; 4],
    human_river: Vec<Tile>,
    deal: OpponentDeal,
    tiles_remaining: u8,
}

/// Builds and validates one table for an already-constructed hand.
pub(super) fn build(category: &str, skeleton: &Skeleton) -> Result<GameState, String> {
    let tenpai_metrics = evaluate_hand(&skeleton.tenpai_tiles);
    if tenpai_metrics.shanten != 0 {
        return Err("the improving hand must be tenpai after the discard".to_string());
    }
    if evaluate_hand(&skeleton.twin_tiles()).shanten != 0 {
        return Err("the twin tanki must also be tenpai".to_string());
    }
    if skeleton.tenpai_tiles.len() != 13 || skeleton.full_tiles().len() != 14 {
        return Err("the improving hand must show fourteen tiles".to_string());
    }
    if let Err(err) = agari::parse::validate_hand(&skeleton.full_tiles()) {
        return Err(format!("the improving hand is not a valid hand: {err:?}"));
    }

    let round_wind = skeleton.round_wind;
    let human_wind = skeleton.human_wind;
    if human_wind == crate::state::Wind::East {
        return Err("the improving-hand lesson keeps the human off the dealer seat".to_string());
    }
    let hand_number = match round_wind {
        crate::state::Wind::East => gen_range(1, 5) as u8,
        crate::state::Wind::South => gen_range(1, 3) as u8,
        _ => 1,
    };

    let mut deck = Deck::fresh();
    for tile in &skeleton.full_tiles() {
        deck.take(*tile)?;
    }
    deck.take(skeleton.dora_indicator)?;
    let ura_candidates: Vec<Tile> = ALL_TILES
        .iter()
        .copied()
        .filter(|&tile| deck.has(tile))
        .collect();
    let ura_indicator =
        choose(&ura_candidates).ok_or_else(|| "No legal ura indicator".to_string())?;
    deck.take(ura_indicator)?;

    // The improving kinds, both singles and the indicator stay out of every
    // river: an improving kind must keep a live copy, and the wait must never
    // be in the human's river (furiten).
    let mut excluded = skeleton.improvement.tiles.clone();
    excluded.extend(skeleton.equivalent_improvement.tiles.iter().copied());
    excluded.push(skeleton.wait_tile);
    excluded.push(skeleton.drawn_tile);
    excluded.push(skeleton.dora_indicator);
    excluded.sort();
    excluded.dedup();

    // The early-turn half of the box: every seat is at or before the 8th turn.
    let plan = self_turn_river_plan(human_wind, &[], gen_range(2, 7));
    if plan.counts[0] > EARLY_TURN_MAX_DISCARDS {
        return Err(format!(
            "the human river is at discard {}, past the 8th turn",
            plan.counts[0]
        ));
    }
    let scores = random_scores_with_human_first();
    let deal = deal_opponents_excluding(&mut deck, human_wind, &scores, &plan, &excluded)
        .ok_or_else(|| "Deck exhausted drawing the opponents".to_string())?;
    let human_river = deck
        .draw_excluding(plan.counts[0], &excluded)
        .ok_or_else(|| "Deck exhausted drawing the human river".to_string())?;

    // Re-check the two halves of the box on the finished table. The count is
    // theoretical (a shape property), but a kind whose remaining copies are
    // all visible is no longer drawable, so every counted kind must be live.
    let visible = visible_tile_counts(&deal.rivers, &[skeleton.dora_indicator]);
    let mut live_improving = 0usize;
    for &tile in &skeleton.improvement.tiles {
        let held = skeleton
            .tenpai_tiles
            .iter()
            .filter(|candidate| **candidate == tile)
            .count() as u8;
        if held + visible.get(&tile).copied().unwrap_or(0) < 4 {
            live_improving += 1;
        }
    }
    if live_improving < skeleton.improvement.kinds() {
        return Err(format!(
            "the rivers killed {} improving kinds",
            skeleton.improvement.kinds() - live_improving
        ));
    }

    let quality = riichi::wait_quality(&skeleton.tenpai_tiles, &visible);
    if quality.live_tiles == 0 {
        return Err("the table killed the whole wait".to_string());
    }
    let conditions = riichi::evaluate(
        &skeleton.tenpai_tiles,
        &[skeleton.wait_tile],
        round_wind,
        human_wind,
        &[skeleton.dora_indicator],
        &visible,
    );
    if !conditions.picks_riichi() {
        return Err(
            "the general rule would keep dama anyway; this lesson needs it to say riichi"
                .to_string(),
        );
    }
    if conditions.dealer {
        return Err("the human must not be the dealer".to_string());
    }
    // The dora is the guaranteed han; make sure it landed in the hand.
    let dora = indicator_to_dora(skeleton.dora_indicator);
    if !skeleton.tenpai_tiles.contains(&dora) {
        return Err("the dora indicator does not make a kept tile dora".to_string());
    }

    let tiles_remaining = deck.remaining().saturating_sub(12).min(u8::MAX as usize) as u8;
    if tiles_remaining == 0 {
        return Err("No drawable tiles remain".to_string());
    }

    Ok(assemble_state(
        category,
        skeleton,
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

/// Deals concealed hands and rivers, never showing `excluded` in a river.
fn deal_opponents_excluding(
    deck: &mut Deck,
    human_wind: crate::state::Wind,
    scores: &[i32; 4],
    plan: &crate::generator::support::table::RiverPlan,
    excluded: &[Tile],
) -> Option<OpponentDeal> {
    let opponent_meta = [(1usize, "Shimocha"), (2, "Toimen"), (3, "Kamicha")];

    let mut players = Vec::with_capacity(3);
    let mut rivers = Vec::with_capacity(3);
    for (index, (seat, name)) in opponent_meta.iter().enumerate() {
        let hand = deck.draw_n(13)?;
        let river = deck.draw_excluding(plan.counts[*seat], excluded)?;
        rivers.push(river.clone());
        players.push(PlayerState {
            seat: *seat,
            name: name.to_string(),
            is_human: false,
            wind: human_wind.next(*seat),
            score: scores[index + 1],
            hand: hand.iter().map(|tile| tile.to_string()).collect(),
            draw: None,
            red_fives: Vec::new(),
            discards: discards_from_tiles(&river),
            melds: Vec::new(),
            is_riichi: false,
            riichi_discard_index: None,
        });
    }

    Some(OpponentDeal { players, rivers })
}

/// Assembles the public `GameState` from the validated pieces.
fn assemble_state(
    category: &str,
    skeleton: &Skeleton,
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
    let mut sorted_hand = skeleton.tenpai_tiles.clone();
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

    GameState {
        category: category.to_string(),
        target_action: TargetAction::Dama,
        correct_action: CorrectAction::dama(skeleton.drawn_tile.to_string()),
        // Either single can be the tanki, so the other discard is the same
        // answer (the chiitoitsu twin model).
        equivalent_tiles: vec![skeleton.equivalent_discard().to_string()],
        decision: DecisionContext::SelfTurn,
        scenario_note: None,
        call_offer: None,
        ai_decision: None,
        riichi_triggers: Vec::new(),
        dama_reasons: vec![DamaReason::EarlyTurn, DamaReason::ImprovingHand],
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
