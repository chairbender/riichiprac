//! Table setup for the ch. 8 "Suji trap" lesson.
//!
//! The skeleton fixes the hand; the board supplies the two things the section
//! is about:
//!
//! - the two copies of the winning tile that are already visible in the
//!   opponents' rivers, so the wait is a two-tile bad wait and ch. 7's bad-wait
//!   box would keep the hand dama;
//! - a human river that holds no suji of the wait, because ch. 8 defines a
//!   suji-trap wait as a suji tile of a tile *you* discarded. If the river
//!   already held one, the plain discard would leave a trap too and the lesson
//!   would lose its only answer.
//!
//! After the table is assembled every read is recomputed from the finished
//! state: the two tenpai discards, the shared wait, the suji relation, the live
//! count and the general ch. 7 rule. Nothing is trusted from the constructor.

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
use crate::generator::support::tiles::suji_tiles;
use crate::rng::{choose, gen_range, shuffle};
use crate::state::{
    CorrectAction, DecisionContext, GameState, PlayerState, RiichiTrigger, TargetAction, Wind,
};

/// Smallest river every seat needs: the table reads better from the middle of a
/// hand, and two opponent rivers must have room for the planted copies.
const MIN_RIVER: usize = 6;

/// Table-level values chosen after the hand is fixed.
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
        return Err("the suji-trap hand must be tenpai after the discard".to_string());
    }
    if tenpai_metrics.ukeire_tiles != vec![skeleton.wait_tile.to_string()] {
        return Err("the kept hand must wait on exactly the trap wait".to_string());
    }
    // The draw is what reaches tenpai, and the answer is a tedashi from the
    // hand, never off the draw.
    let pre_draw_tiles = skeleton.pre_draw_tiles();
    if evaluate_hand(&pre_draw_tiles).shanten != 1 {
        return Err("the suji-trap hand must be 1-shanten before the draw".to_string());
    }
    if skeleton.trap_discard == skeleton.drawn_tile
        || !pre_draw_tiles.contains(&skeleton.trap_discard)
    {
        return Err("the suji-trap answer must be a tedashi from the hand".to_string());
    }
    if skeleton.trap_discard == skeleton.plain_discard {
        return Err("the two tenpai discards must differ".to_string());
    }

    let round_wind = skeleton.round_wind;
    let human_wind = skeleton.human_wind;
    if human_wind == Wind::East {
        return Err("the human must not be the dealer".to_string());
    }
    let hand_number = match round_wind {
        Wind::East => gen_range(1, 5) as u8,
        Wind::South => gen_range(1, 3) as u8,
        _ => 1,
    };

    let mut deck = Deck::fresh();
    for tile in &full_tiles {
        deck.take(*tile)?;
    }
    // Both planted copies are reserved before any river is drawn, so no random
    // fill can consume them first.
    for &planted in &skeleton.planted {
        deck.take(planted)?;
    }

    // No dora may touch the hand or the wait: the hand has to stay riichi-only,
    // and a visible indicator on the wait would shrink it below two live tiles.
    let dora_indicator = choose_dora_indicator(&deck, &full_tiles, skeleton.wait_tile)?;
    deck.take(dora_indicator)?;
    let ura_indicator = choose_dora_indicator(&deck, &full_tiles, skeleton.wait_tile)?;
    deck.take(ura_indicator)?;

    let scores = random_scores_with_human_first();
    let counts = self_turn_river_plan(human_wind, &[], gen_range(MIN_RIVER, 13)).counts;
    let deal = deal_opponents_with_plants(
        &mut deck,
        human_wind,
        &scores,
        &counts,
        &skeleton.planted,
        skeleton.wait_tile,
    )
    .ok_or_else(|| "Deck exhausted drawing the opponents".to_string())?;

    // Not furiten and not already a trap: the human river holds neither the
    // wait nor any suji of it.
    let mut forbidden = suji_tiles(skeleton.wait_tile);
    forbidden.push(skeleton.wait_tile);
    let human_river = deck
        .draw_excluding(counts[0], &forbidden)
        .ok_or_else(|| "Deck exhausted drawing the human river".to_string())?;

    // Only table-visible tiles count. The ura indicator is hidden when the
    // player decides, so it is not part of the live count.
    let visible = visible_tile_counts(&deal.rivers, &[dora_indicator]);
    let quality = riichi::wait_quality(&skeleton.tenpai_tiles, &visible);
    if quality.live_kinds != 1 {
        return Err(format!(
            "the table leaves {} live winning kinds, expected the single trap wait",
            quality.live_kinds
        ));
    }
    if quality.live_tiles != 2 {
        return Err(format!(
            "the table leaves {} live winning tiles, expected 2 (two planted copies)",
            quality.live_tiles
        ));
    }

    // The trap is the *only* justification: the general ch. 7 rule and its
    // bad-wait box both keep a riichi-only bad-wait non-dealer hand concealed,
    // so the lesson's answer comes from the suji-trap section alone.
    let conditions = riichi::evaluate(
        &skeleton.tenpai_tiles,
        &[skeleton.wait_tile],
        round_wind,
        human_wind,
        &[dora_indicator],
        &visible,
    );
    if conditions.extra_han || conditions.good_wait || conditions.dealer {
        return Err(format!(
            "the general rule computed {conditions:?}; the trap must be the only reason"
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
    validate(&state, skeleton)?;
    Ok(state)
}

/// Deals concealed hands and rivers, planting the visible wait copies.
///
/// Each planted copy goes into a different opponent's river, and every other
/// river slot draws a tile that is not the wait tile, so exactly
/// `skeleton.planted.len()` copies are visible.
fn deal_opponents_with_plants(
    deck: &mut Deck,
    human_wind: Wind,
    scores: &[i32; 4],
    river_counts: &[usize; 4],
    planted: &[Tile],
    wait_tile: Tile,
) -> Option<OpponentDeal> {
    let opponent_meta = [(1usize, "Shimocha"), (2, "Toimen"), (3, "Kamicha")];

    // Give each planted copy its own seat, so no single river looks like a
    // deliberate four-of-a-kind dump.
    if planted.len() > opponent_meta.len() {
        return None;
    }
    let mut seats: Vec<usize> = opponent_meta.iter().map(|(seat, _)| *seat).collect();
    shuffle(&mut seats);
    let mut plants: std::collections::HashMap<usize, Vec<Tile>> = std::collections::HashMap::new();
    for (index, &seat) in seats[..planted.len()].iter().enumerate() {
        if river_counts[seat] < 1 {
            return None;
        }
        plants.entry(seat).or_default().push(planted[index]);
    }

    let mut players = Vec::with_capacity(3);
    let mut rivers = Vec::with_capacity(3);
    for (seat, name) in opponent_meta.iter() {
        let hand = deck.draw_n(13)?;
        let slots = river_counts[*seat];
        let seat_plants = plants.get(seat).cloned().unwrap_or_default();
        let mut river = Vec::with_capacity(slots);
        for plant in seat_plants {
            river.push(plant);
        }
        while river.len() < slots {
            let tile = deck.draw_excluding(1, &[wait_tile])?.pop()?;
            river.push(tile);
        }
        shuffle(&mut river);
        rivers.push(river.clone());
        let discards = discards_from_tiles(&river);

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
            is_riichi: false,
            riichi_discard_index: None,
        });
    }

    Some(OpponentDeal { players, rivers })
}

/// Picks an indicator that cannot make the hand or the wait dora, and is not
/// the wait itself (a visible copy would drop the wait to one live tile).
fn choose_dora_indicator(
    deck: &Deck,
    full_tiles: &[Tile],
    wait_tile: Tile,
) -> Result<Tile, String> {
    let candidates: Vec<Tile> = ALL_TILES
        .iter()
        .copied()
        .filter(|&indicator| {
            deck.has(indicator)
                && indicator != wait_tile
                && !full_tiles.contains(&indicator_to_dora(indicator))
                && indicator_to_dora(indicator) != wait_tile
        })
        .collect();

    choose(&candidates).ok_or_else(|| "No legal dora indicator".to_string())
}

/// Re-derives the lesson's read from the finished table and re-checks it.
fn validate(state: &GameState, skeleton: &Skeleton) -> Result<(), String> {
    let human = &state.players[0];
    if human.wind == Wind::East {
        return Err("the human must not be the dealer".to_string());
    }
    if human.is_riichi || !human.melds.is_empty() {
        return Err("the human must be closed and not in Riichi".to_string());
    }

    // The answer is the trap discard, tedashi from the hand.
    match &state.correct_action {
        CorrectAction::Riichi { discard }
            if discard == &skeleton.trap_discard.to_string()
                && skeleton.trap_discard != skeleton.drawn_tile
                && human.hand.iter().any(|tile| tile == discard) => {}
        other => {
            return Err(format!(
                "the answer must be Riichi on the trap discard, got {other:?}"
            ));
        }
    }
    if state.ukeire_tiles != vec![skeleton.wait_tile.to_string()] {
        return Err("the displayed wait must be the single trap wait".to_string());
    }

    // Recount the visible copies of the wait on the finished table: the hand
    // holds none, so exactly the two planted copies are visible and two tiles
    // are live.
    let wait_code = skeleton.wait_tile.to_string();
    let visible_copies = state
        .players
        .iter()
        .flat_map(|player| player.discards.iter())
        .filter(|discard| discard.tile == wait_code)
        .count()
        + state
            .dora_indicators
            .iter()
            .filter(|indicator| **indicator == wait_code)
            .count();
    if visible_copies != 2 {
        return Err(format!(
            "{visible_copies} copies of the wait are visible, expected the two planted copies"
        ));
    }

    // The human river must hold neither the wait (furiten) nor a suji of it (a
    // trap that would pre-exist the declaration).
    let trap_suji = suji_tiles(skeleton.wait_tile);
    for discard in &human.discards {
        if discard.tile == skeleton.wait_tile.to_string() {
            return Err("the human river holds the furiten tile".to_string());
        }
        if trap_suji
            .iter()
            .any(|suji| suji.to_string() == discard.tile)
        {
            return Err("the human river already holds a suji of the wait".to_string());
        }
    }

    // The plain discard must leave tenpai on the same wait, and the trap
    // discard must be the only one that makes the wait a suji of the
    // declaration tile.
    let discards = analysis_discards(&state.tiles, skeleton.wait_tile)?;
    if !discards
        .iter()
        .any(|discard| discard == &skeleton.plain_discard.to_string())
    {
        return Err("the plain discard does not leave tenpai on the same wait".to_string());
    }
    if !suji_tiles(skeleton.trap_discard).contains(&skeleton.wait_tile) {
        return Err("the trap discard is not a suji of the wait".to_string());
    }
    if suji_tiles(skeleton.plain_discard).contains(&skeleton.wait_tile) {
        return Err("the plain discard is also a suji of the wait".to_string());
    }

    crate::generator::support::state_validation::validate_reachable_state(state)
}

/// The distinct discards that leave the fourteen-tile hand on `wait`.
fn analysis_discards(tiles: &[String], wait: Tile) -> Result<Vec<String>, String> {
    let parsed: Vec<Tile> = tiles
        .iter()
        .filter_map(|code| Tile::try_from(code.as_str()).ok())
        .collect();
    let mut distinct = parsed.clone();
    distinct.sort();
    distinct.dedup();

    let mut discards = Vec::new();
    for candidate in distinct {
        let mut rest = parsed.clone();
        let index = rest
            .iter()
            .position(|tile| *tile == candidate)
            .expect("candidate came from the hand");
        rest.remove(index);
        let metrics = evaluate_hand(&rest);
        if metrics.shanten == 0 && metrics.ukeire_tiles == vec![wait.to_string()] {
            discards.push(candidate.to_string());
        }
    }
    Ok(discards)
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
        target_action: TargetAction::Riichi,
        correct_action: CorrectAction::riichi(skeleton.trap_discard.to_string()),
        equivalent_tiles: Vec::new(),
        decision: DecisionContext::SelfTurn,
        call_offer: None,
        scenario_note: None,
        ai_decision: None,
        riichi_triggers: vec![RiichiTrigger::ImmediateSujiTrap],
        dama_reasons: Vec::new(),
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
        riichi_sticks: gen_range(0, 3) as u8,
        dora_indicators: vec![dora_indicator.to_string()],
        ura_dora_indicators: vec![ura_indicator.to_string()],
        can_riichi: false,
        tiles_remaining,
        current_turn: 0,
        players,
    }
}
