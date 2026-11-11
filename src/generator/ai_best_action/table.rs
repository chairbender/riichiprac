use std::collections::HashMap;

use agari::tile::Tile;

use crate::generator::support::deck::Deck;
use crate::generator::support::table::{
    OpponentDeal, RiverPlan, deal_opponents, random_round, random_table_scores,
    self_turn_river_plan,
};
use crate::rng::gen_range;
use crate::state::Wind;

/// A freshly dealt table, before a decision is attached.
pub struct Table {
    pub round_wind: Wind,
    pub hand_number: u8,
    pub honba: u8,
    pub riichi_sticks: u8,
    pub human_wind: Wind,
    pub scores: [i32; 4],
    pub dora_indicators: Vec<String>,
    pub ura_dora_indicators: Vec<String>,
    pub human_tiles: Vec<Tile>,
    pub human_river: Vec<Tile>,
    /// Indices of `human_river` that follow a call, so they are tedashi.
    pub human_hand_discards: Vec<usize>,
    pub deal: OpponentDeal,
    pub tiles_remaining: u8,
}

/// Deal a random, deck-consistent four-player table.
pub fn deal_table() -> Result<Table, String> {
    let mut deck = Deck::fresh();
    let human_tiles = deck
        .draw_n(14)
        .ok_or_else(|| "deck ran out while dealing the human hand".to_string())?;
    deal_rest(deck, human_tiles, &[])
}

/// Deal the rest of the table around a pre-built 14-tile human hand.
pub fn deal_table_with_human(human_tiles: Vec<Tile>) -> Result<Table, String> {
    deal_table_with_human_calls(human_tiles, &[])
}

/// Deal the rest of the table around a pre-built 14-tile human hand that has
/// already called `calls` (each `(caller, called_from)`).
pub fn deal_table_with_human_calls(
    human_tiles: Vec<Tile>,
    calls: &[(usize, usize)],
) -> Result<Table, String> {
    let mut deck = Deck::fresh();
    let mut counts: HashMap<Tile, u8> = HashMap::new();
    for &tile in &human_tiles {
        *counts.entry(tile).or_insert(0) += 1;
    }
    for (tile, count) in &counts {
        deck.take_n(*tile, *count)?;
    }
    deal_rest(deck, human_tiles, calls)
}

/// Deal the rest of the table with empty rivers (first-turn states).
pub fn deal_table_with_human_no_rivers(human_tiles: Vec<Tile>) -> Result<Table, String> {
    let mut deck = Deck::fresh();
    let mut counts: HashMap<Tile, u8> = HashMap::new();
    for &tile in &human_tiles {
        *counts.entry(tile).or_insert(0) += 1;
    }
    for (tile, count) in &counts {
        deck.take_n(*tile, *count)?;
    }

    let (round_wind, hand_number) = random_round();
    let scores = random_table_scores();
    // The opening draw belongs to the dealer; the human holds it, so the human
    // has to be East.
    let human_wind = Wind::East;
    let deal = deal_opponents(&mut deck, human_wind, &scores, &RiverPlan::default())
        .ok_or_else(|| "deck ran out while dealing opponents".to_string())?;

    let mut dead_wall = deck
        .draw_n(14)
        .ok_or_else(|| "deck ran out while dealing the dead wall".to_string())?;
    let dora = dead_wall.remove(0);
    let ura = dead_wall.remove(0);

    Ok(Table {
        round_wind,
        hand_number,
        honba: gen_range(0, 4) as u8,
        riichi_sticks: gen_range(0, 3) as u8,
        human_wind,
        scores,
        dora_indicators: vec![dora.to_string()],
        ura_dora_indicators: vec![ura.to_string()],
        human_tiles,
        human_river: Vec::new(),
        human_hand_discards: Vec::new(),
        deal,
        tiles_remaining: deck.remaining() as u8,
    })
}

fn deal_rest(
    mut deck: Deck,
    human_tiles: Vec<Tile>,
    calls: &[(usize, usize)],
) -> Result<Table, String> {
    let (round_wind, hand_number) = random_round();
    let scores = random_table_scores();
    let human_wind = Wind::ALL[gen_range(0, 4)];

    // The human is about to discard, so plan the rivers as one legal timeline
    // that ends on Kamicha's discard. Picking each river separately is what let
    // the human end up with more discards than the other seats.
    let plan = self_turn_river_plan(human_wind, calls, gen_range(3, 10));
    let deal = deal_opponents(&mut deck, human_wind, &scores, &plan)
        .ok_or_else(|| "deck ran out while dealing opponents".to_string())?;

    let human_river = deck
        .draw_n(plan.counts[0])
        .ok_or_else(|| "deck ran out while dealing the human river".to_string())?;

    let mut dead_wall = deck
        .draw_n(14)
        .ok_or_else(|| "deck ran out while dealing the dead wall".to_string())?;
    let dora = dead_wall.remove(0);
    let ura = dead_wall.remove(0);

    Ok(Table {
        round_wind,
        hand_number,
        honba: gen_range(0, 4) as u8,
        riichi_sticks: gen_range(0, 3) as u8,
        human_wind,
        scores,
        dora_indicators: vec![dora.to_string()],
        ura_dora_indicators: vec![ura.to_string()],
        human_tiles,
        human_river,
        human_hand_discards: plan.hand_discards[0].clone(),
        deal,
        tiles_remaining: deck.remaining() as u8,
    })
}
