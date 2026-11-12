//! Table setup for the ch. 7 bad-wait lesson.
//!
//! The board is deliberately quiet: three opponents with concealed hands and
//! rivers, one dora indicator, no calls and no riichi. That keeps the ch. 7
//! bad-wait box the only thing deciding the answer.
//!
//! The interesting part is the *visible* winning-tile count. The skeleton
//! chooses how many copies of the winning tile should remain live; this module
//! plants the rest in the opponents' rivers, excludes the winning tile from
//! every other river, and then recounts the wait from the real table.

use std::collections::HashMap;

use agari::context::indicator_to_dora;
use agari::tile::Tile;

use super::judgement::{self, Verdict};
use super::skeleton::{Skeleton, Target};
use crate::generator::riichi_judgement::judgement as riichi;
use crate::generator::support::analysis::{evaluate_hand, visible_tile_counts};
use crate::generator::support::deck::{ALL_TILES, Deck};
use crate::generator::support::format::format_hand_compact;
use crate::generator::support::table::{
    OpponentDeal, discards_from_tiles, random_scores_with_human_first, self_turn_river_plan,
};
use crate::rng::{choose, gen_range, shuffle};
use crate::state::{CorrectAction, DecisionContext, GameState, PlayerState, TargetAction, Wind};

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
    let full_tiles = skeleton.full_tiles();
    let tenpai_metrics = evaluate_hand(&skeleton.tenpai_tiles);
    if tenpai_metrics.shanten != 0 {
        return Err("bad-wait hand must be tenpai after the discard".to_string());
    }
    // The draw is what reaches tenpai: the hand before it must not already be
    // tenpai, or the table would imply the player passed up Riichi earlier.
    let pre_draw_tiles = skeleton.pre_draw_tiles();
    if evaluate_hand(&pre_draw_tiles).shanten != 1 {
        return Err("bad-wait hand must be 1-shanten before the draw".to_string());
    }
    // The answer is discarded from the hand, never off the draw: a tsumogiri
    // answer would say the player was already tenpai on an earlier turn.
    if skeleton.discard_tile == skeleton.drawn_tile
        || !pre_draw_tiles.contains(&skeleton.discard_tile)
    {
        return Err("bad-wait answer must be a tedashi from the hand".to_string());
    }

    let round_wind = skeleton.round_wind;
    let human_wind = skeleton.human_wind;
    let hand_number = match round_wind {
        Wind::East => gen_range(1, 5) as u8,
        Wind::South => gen_range(1, 3) as u8,
        _ => 1,
    };

    let mut deck = Deck::fresh();
    for tile in &full_tiles {
        deck.take(*tile)?;
    }

    // The dora must never touch the hand, the draw, or any winning tile:
    // condition 1 counts dora, so a lucky indicator would turn a riichi-only
    // hand into a hand with a yaku. The indicator itself must not be a winning
    // tile, because indicators are visible and would shrink the wait.
    let dora_indicator = choose_dora_indicator(&deck, &full_tiles, &skeleton.wait_tiles)?;
    deck.take(dora_indicator)?;
    let ura_indicator = choose_dora_indicator(&deck, &full_tiles, &skeleton.wait_tiles)?;
    deck.take(ura_indicator)?;

    // Reserve the visible losing copies before dealing, so an opponent's hand
    // cannot consume them first.
    for &tile in &skeleton.planted {
        deck.take(tile)?;
    }

    let scores = random_scores_with_human_first();
    // The human draws after Kamicha (seat 3) discards.
    let counts = self_turn_river_plan(human_wind, &[], gen_range(2, 7)).counts;
    let deal = deal_opponents_with_visible(
        &mut deck,
        human_wind,
        &scores,
        &counts,
        skeleton.planted.clone(),
        &skeleton.wait_tiles,
    )
    .ok_or_else(|| "Deck exhausted drawing the opponents".to_string())?;

    // The human is not furiten: no winning tile may already be in their river.
    let human_river = deck
        .draw_excluding(counts[0], &skeleton.wait_tiles)
        .ok_or_else(|| "Deck exhausted drawing the human river".to_string())?;

    // Only table-visible tiles count. The ura indicator is hidden when the
    // player decides, so it is not part of the live count.
    let visible = visible_tile_counts(&deal.rivers, &[dora_indicator]);
    let quality = riichi::wait_quality(&skeleton.tenpai_tiles, &visible);
    if quality.is_good() {
        return Err(format!(
            "the table leaves a good wait ({:?}); this lesson needs a bad one",
            quality
        ));
    }
    if quality.live_tiles != skeleton.live_tiles {
        return Err(format!(
            "table leaves {} live winning tiles, the hand was built for {}",
            quality.live_tiles, skeleton.live_tiles
        ));
    }

    // The general ch7.1 rule must find none of its three conditions: the hand
    // is riichi-only, the wait is bad, and the human is not the dealer. The
    // bad-wait box is therefore the only rule that can pick the answer.
    let conditions = riichi::evaluate(
        &skeleton.tenpai_tiles,
        &skeleton.wait_tiles,
        round_wind,
        human_wind,
        &[dora_indicator],
        &visible,
    );
    if conditions != riichi::Conditions::default() {
        return Err(format!(
            "the general rule computed {conditions:?}; this lesson needs its dama cell"
        ));
    }

    let verdict = judgement::verdict(&skeleton.wait_tiles, quality.live_tiles);
    if verdict != target.expected_verdict() {
        return Err(format!(
            "the box computed {verdict:?}, but the hand was built for {target:?}"
        ));
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
            dora_indicator,
            ura_indicator,
            scores,
            human_river,
            deal,
            tiles_remaining,
        },
    ))
}

/// Deals concealed hands and rivers, placing `planted` tiles in the rivers.
///
/// The planted tiles are already removed from the deck. Every other river slot
/// draws a random tile that is *not* one of `excluded_from_rivers`, so the
/// visible wait count is exactly the planted count plus the hand's own copies.
fn deal_opponents_with_visible(
    deck: &mut Deck,
    human_wind: Wind,
    scores: &[i32; 4],
    river_counts: &[usize; 4],
    planted: Vec<Tile>,
    excluded_from_rivers: &[Tile],
) -> Option<OpponentDeal> {
    let opponent_meta = [(1usize, "Shimocha"), (2, "Toimen"), (3, "Kamicha")];
    let total_slots: usize = river_counts[1..4].iter().sum();
    if total_slots < planted.len() {
        return None;
    }

    let mut slots: Vec<usize> = (0..total_slots).collect();
    shuffle(&mut slots);
    let mut plant_map: HashMap<usize, Tile> =
        slots.into_iter().take(planted.len()).zip(planted).collect();

    let mut players = Vec::with_capacity(3);
    let mut rivers = Vec::with_capacity(3);
    let mut offset = 0usize;
    for (index, (seat, name)) in opponent_meta.iter().enumerate() {
        let hand = deck.draw_n(13)?;
        let mut river = Vec::with_capacity(river_counts[*seat]);
        for local in 0..river_counts[*seat] {
            let global = offset + local;
            let tile = match plant_map.remove(&global) {
                Some(tile) => tile,
                None => deck.draw_excluding(1, excluded_from_rivers)?.pop()?,
            };
            river.push(tile);
        }
        offset += river_counts[*seat];

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

/// Picks an indicator that cannot make the hand, the draw, or a wait dora.
fn choose_dora_indicator(
    deck: &Deck,
    full_tiles: &[Tile],
    wait_tiles: &[Tile],
) -> Result<Tile, String> {
    let candidates: Vec<Tile> = ALL_TILES
        .iter()
        .copied()
        .filter(|&indicator| {
            deck.has(indicator)
                && !wait_tiles.contains(&indicator)
                && !wait_tiles.contains(&indicator_to_dora(indicator))
                && !full_tiles.contains(&indicator_to_dora(indicator))
        })
        .collect();

    choose(&candidates).ok_or_else(|| "No legal dora indicator".to_string())
}

/// Assembles the public `GameState` from the validated pieces.
fn assemble_state(
    category: &str,
    skeleton: &Skeleton,
    verdict: Verdict,
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
    let (target_action, correct_action, riichi_triggers, dama_reasons) = if verdict.picks_riichi() {
        (
            TargetAction::Riichi,
            CorrectAction::riichi(discard),
            vec![verdict.trigger().expect("a riichi verdict has a trigger")],
            Vec::new(),
        )
    } else {
        (
            TargetAction::Dama,
            CorrectAction::dama(discard),
            Vec::new(),
            judgement::dama_reasons(),
        )
    };

    GameState {
        category: category.to_string(),
        target_action,
        correct_action,
        equivalent_tiles: Vec::new(),
        decision: DecisionContext::SelfTurn,
        scenario_note: None,
        call_offer: None,
        ai_decision: None,
        riichi_triggers,
        dama_reasons,
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
