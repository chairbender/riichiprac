//! Table setup for the ch. 7 genbutsu-wait lesson.
//!
//! The skeleton builds the book's pinfu hand; this module supplies the one
//! thing the section is about: a player who is drawing all the attention and
//! has already discarded one of the hand's winning tiles. The threat is shown
//! as a Riichi declaration, because that is the chapter's first example of a
//! player everyone is watching (ch7:539) and it is the only one a static table
//! can state unambiguously.
//!
//! Construction:
//!
//! - the threat's river takes the chosen winning tile at a random early slot,
//!   before the declaration discard, so the tile is genuine genbutsu;
//! - neither winning tile appears in any other river, so the other side of the
//!   wait stays fully visible-live and the hand still has something to win on;
//! - the human river avoids both winning tiles, so the lesson is never furiten.
//!
//! After the table is assembled the genbutsu read is recomputed from the
//! finished state through [`SafetyFacts`], exactly as the defense lessons do.

use agari::context::indicator_to_dora;
use agari::tile::Tile;

use super::judgement;
use super::skeleton::Skeleton;
use crate::generator::riichi_judgement::judgement as riichi;
use crate::generator::support::analysis::{evaluate_hand, visible_tile_counts};
use crate::generator::support::deck::{ALL_TILES, Deck};
use crate::generator::support::format::format_hand_compact;
use crate::generator::support::table::{
    OpponentDeal, discards_from_tiles, random_scores_with_human_first, self_turn_river_plan,
};
use crate::rng::{choose, gen_range};
use crate::safety::SafetyFacts;
use crate::state::{CorrectAction, DecisionContext, GameState, PlayerState, TargetAction, Wind};

/// Smallest river every seat needs: the threat must have at least one discard
/// before the declaration, and the table reads better from the middle of a hand.
const MIN_RIVER: usize = 6;

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
pub(super) fn build(category: &str, skeleton: &Skeleton) -> Result<GameState, String> {
    let full_tiles = skeleton.full_tiles();
    let tenpai_metrics = evaluate_hand(&skeleton.tenpai_tiles);
    if tenpai_metrics.shanten != 0 {
        return Err("the genbutsu-wait hand must be tenpai after the discard".to_string());
    }
    // The draw is what reaches tenpai: the hand before it must not already be
    // tenpai, or the table would imply the player passed up Riichi earlier.
    let pre_draw_tiles = skeleton.pre_draw_tiles();
    if evaluate_hand(&pre_draw_tiles).shanten != 1 {
        return Err("the genbutsu-wait hand must be 1-shanten before the draw".to_string());
    }
    // The answer is discarded from the hand, never off the draw: a tsumogiri
    // answer would say the player was already tenpai on an earlier turn.
    if skeleton.discard_tile == skeleton.drawn_tile
        || !pre_draw_tiles.contains(&skeleton.discard_tile)
    {
        return Err("the genbutsu-wait answer must be a tedashi from the hand".to_string());
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

    // No dora may touch the hand, the draw, or either winning tile: condition 1
    // should come from the hand's own yaku, not a lucky indicator, and an
    // indicator on a winning tile would make that tile visible and shrink the
    // wait.
    let dora_indicator = choose_dora_indicator(&deck, &full_tiles, &skeleton.wait_tiles)?;
    deck.take(dora_indicator)?;
    let ura_indicator = choose_dora_indicator(&deck, &full_tiles, &skeleton.wait_tiles)?;
    deck.take(ura_indicator)?;

    // The threat is one of the three opponents; the human never is, so the
    // general rule's dealer condition stays false.
    let threat_seat = gen_range(1, 4);

    // Reserve the copy that goes into the threat's river before dealing, so no
    // opponent hand or other river can consume it first.
    deck.take(skeleton.genbutsu_wait)?;

    let scores = random_scores_with_human_first();
    let counts = self_turn_river_plan(human_wind, &[], gen_range(MIN_RIVER, 13)).counts;
    let deal = deal_opponents_with_threat(
        &mut deck,
        human_wind,
        &scores,
        &counts,
        threat_seat,
        skeleton.genbutsu_wait,
        &skeleton.wait_tiles,
    )
    .ok_or_else(|| "Deck exhausted drawing the opponents".to_string())?;

    // Not furiten: no winning tile may already be in the human river.
    let human_river = deck
        .draw_excluding(counts[0], &skeleton.wait_tiles)
        .ok_or_else(|| "Deck exhausted drawing the human river".to_string())?;

    // Only table-visible tiles count. The ura indicator is hidden when the
    // player decides, so it is not part of the live count.
    let visible = visible_tile_counts(&deal.rivers, &[dora_indicator]);
    let quality = riichi::wait_quality(&skeleton.tenpai_tiles, &visible);
    if quality.live_kinds != 2 {
        return Err(format!(
            "the table leaves {} live winning kinds, expected the two sides of the wait",
            quality.live_kinds
        ));
    }
    // One planted copy is visible, so the genbutsu side has three live copies
    // and the untouched side has all four: seven live winning tiles.
    if quality.live_tiles != 7 {
        return Err(format!(
            "the table leaves {} live winning tiles, expected 7 (one genbutsu copy plus a \
             full live side)",
            quality.live_tiles
        ));
    }

    // The general ch7.1 rule *does* pick Riichi here: the hand has a han
    // (pinfu) and a good wait. The genbutsu section is the exception, so the
    // lesson only accepts a hand the rule would otherwise declare on.
    let conditions = riichi::evaluate(
        &skeleton.tenpai_tiles,
        &skeleton.wait_tiles,
        round_wind,
        human_wind,
        &[dora_indicator],
        &visible,
    );
    if !conditions.extra_han || !conditions.good_wait || conditions.dealer {
        return Err(format!(
            "the general rule computed {conditions:?}; the lesson needs a hand the genbutsu \
             section overrides"
        ));
    }

    let tiles_remaining = deck.remaining().saturating_sub(12).min(u8::MAX as usize) as u8;
    if tiles_remaining == 0 {
        return Err("No drawable tiles remain".to_string());
    }

    let state = assemble_state(
        category,
        skeleton,
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
    );
    validate(&state, skeleton, threat_seat)?;
    Ok(state)
}

/// Deals concealed hands and rivers, making `threat_seat` a Riichi declarer.
///
/// The planted genbutsu copy goes into the threat's river before the
/// declaration discard; every other river slot draws a tile that is *not* one
/// of `excluded_from_rivers`, so the live side of the wait stays untouched.
fn deal_opponents_with_threat(
    deck: &mut Deck,
    human_wind: Wind,
    scores: &[i32; 4],
    river_counts: &[usize; 4],
    threat_seat: usize,
    genbutsu_wait: Tile,
    excluded_from_rivers: &[Tile],
) -> Option<OpponentDeal> {
    let opponent_meta = [(1usize, "Shimocha"), (2, "Toimen"), (3, "Kamicha")];

    // The declaration is the threat's final discard, so the genbutsu copy must
    // land before it to be part of the threat's own river rather than the
    // declaration itself.
    let threat_slots = river_counts[threat_seat];
    if threat_slots < 2 {
        return None;
    }
    let plant_index = gen_range(0, threat_slots - 1);

    let mut players = Vec::with_capacity(3);
    let mut rivers = Vec::with_capacity(3);
    for (seat, name) in opponent_meta.iter() {
        let hand = deck.draw_n(13)?;
        let is_threat = *seat == threat_seat;

        let mut river = Vec::with_capacity(river_counts[*seat]);
        for local in 0..river_counts[*seat] {
            let tile = if is_threat && local == plant_index {
                genbutsu_wait
            } else {
                deck.draw_excluding(1, excluded_from_rivers)?.pop()?
            };
            river.push(tile);
        }
        rivers.push(river.clone());

        let mut discards = discards_from_tiles(&river);
        let riichi_discard_index = if is_threat {
            let last = discards.last_mut()?;
            // The declaration tile is discarded from the hand, never tsumogiri.
            last.is_riichi = true;
            last.is_tsumogiri = false;
            Some(discards.len() - 1)
        } else {
            None
        };

        players.push(PlayerState {
            seat: *seat,
            name: name.to_string(),
            is_human: false,
            wind: human_wind.next(*seat),
            score: scores[*seat],
            hand: hand.iter().map(|tile| tile.to_string()).collect(),
            draw: None,
            red_fives: Vec::new(),
            discards,
            melds: Vec::new(),
            is_riichi: is_threat,
            riichi_discard_index,
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

/// Re-derives the chapter's read from the finished table and re-checks it.
fn validate(state: &GameState, skeleton: &Skeleton, threat_seat: usize) -> Result<(), String> {
    let threat = state
        .players
        .iter()
        .find(|player| player.seat == threat_seat)
        .ok_or_else(|| "No threat player".to_string())?;
    if !threat.is_riichi || threat.riichi_discard_index.is_none() {
        return Err("the threat must be in Riichi".to_string());
    }
    if threat.seat == 0 {
        return Err("the threat must not be the human".to_string());
    }
    if state.players[0].wind == Wind::East {
        return Err("the human must not be the dealer".to_string());
    }

    let facts = SafetyFacts::from_state(state, threat_seat)
        .ok_or_else(|| "No safety facts for the threat seat".to_string())?;

    if !judgement::applies(&skeleton.wait_tiles, &facts) {
        return Err("no winning tile is the threat's genbutsu".to_string());
    }
    let genbutsu = judgement::genbutsu_waits(&skeleton.wait_tiles, &facts);
    if genbutsu != vec![skeleton.genbutsu_wait] {
        return Err(format!(
            "the threat's genbutsu covers {genbutsu:?}, expected exactly {:?}",
            skeleton.genbutsu_wait
        ));
    }

    // The other side of the wait must still be live, or this would be a dead
    // wait (a wait change) instead of the chapter's dama case.
    if facts.is_genbutsu(skeleton.live_wait()) {
        return Err(format!(
            "the live winning tile {} is also the threat's genbutsu",
            skeleton.live_wait()
        ));
    }

    // The human river must not already hold a winning tile.
    let human = &state.players[0];
    for wait in &skeleton.wait_tiles {
        if human
            .discards
            .iter()
            .any(|discard| discard.tile == wait.to_string())
        {
            return Err(format!("the human river holds the furiten tile {wait}"));
        }
    }

    // The table must be a reachable position: rivers, melds, and the draw all
    // line up with one legal turn order.
    crate::generator::support::state_validation::validate_reachable_state(state)
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
    players.sort_by_key(|player| player.seat);

    GameState {
        category: category.to_string(),
        target_action: TargetAction::Dama,
        correct_action: CorrectAction::dama(skeleton.discard_tile.to_string()),
        equivalent_tiles: Vec::new(),
        decision: DecisionContext::SelfTurn,
        scenario_note: None,
        ai_decision: None,
        riichi_triggers: Vec::new(),
        dama_reasons: judgement::dama_reasons(),
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
        riichi_sticks: 1,
        dora_indicators: vec![dora_indicator.to_string()],
        ura_dora_indicators: vec![ura_indicator.to_string()],
        can_riichi: false,
        tiles_remaining,
        current_turn: 0,
        players,
    }
}
