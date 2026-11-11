//! Board assembly for the `wind_discard_order` lesson.
//!
//! The hand is built around the seat arithmetic: one copy of every valueless
//! wind goes into the hand, with the right player's wind as the draw, and the
//! rest is a slow but natural 1-shanten filler (a pair plus complete sets, all
//! suited). The round wind and the human's own wind are never dealt into the
//! hand, and the dora indicator is always a suit tile, so every wind the hand
//! holds really is valueless.

use agari::parse::to_counts;
use agari::tile::{Honor, Suit, Tile};

use crate::generator::support::analysis::{evaluate_counts, wind_to_honor};
use crate::generator::support::deck::{ALL_TILES, Deck};
use crate::generator::support::format::format_hand_compact;
use crate::generator::support::table::{
    RiverPlan, deal_opponents, random_scores_with_human_first, river_counts,
};
use crate::rng::choose;
use crate::state::{
    CorrectAction, DecisionContext, GameState, PlayerState, TargetAction, Wind, dealer_seat,
};

/// The seat arithmetic one board is built around.
#[derive(Debug, Clone)]
struct SeatPlan {
    round_wind: Wind,
    human_wind: Wind,
    /// The valueless winds in the human's hand. Always contains the right
    /// player's wind (the answer); the round wind and the human's own wind are
    /// never here.
    hand_winds: Vec<Wind>,
    /// Discards per seat before the human's first draw.
    river_counts: [usize; 4],
}

impl SeatPlan {
    /// The right player's wind, which the book throws first.
    fn answer(&self) -> Wind {
        self.human_wind.next(1)
    }
}

/// Builds and validates one first-turn wind-order board.
pub(super) fn build(category: &str) -> Result<GameState, String> {
    let plan = plan()?;
    let answer = honor(plan.answer());

    let mut deck = Deck::fresh();

    // One copy of every valueless wind in hand; the right player's wind is the
    // drawn tile, so the player sees it arrive and has to choose what to throw.
    for &wind in &plan.hand_winds {
        deck.take(honor(wind))?;
    }

    // Fill the rest with a natural block shape, all in suits.
    let filler_target = 14 - plan.hand_winds.len();
    let mut filler = Vec::with_capacity(filler_target);
    add_pair(&mut filler, &mut deck)?;
    while filler.len() < filler_target {
        let remaining = filler_target - filler.len();
        if remaining >= 3 && add_set(&mut filler, &mut deck)? {
            continue;
        }
        add_single(&mut filler, &mut deck)?;
    }

    // The concealed hand keeps the other valueless winds; the answer is the draw.
    let mut concealed = filler;
    for &wind in &plan.hand_winds {
        if wind != plan.answer() {
            concealed.push(honor(wind));
        }
    }
    concealed.sort();

    if concealed.len() != 13 {
        return Err(format!(
            "wind-order hand holds {} concealed tiles, expected 13",
            concealed.len()
        ));
    }

    let mut full_tiles = concealed.clone();
    full_tiles.push(answer);
    full_tiles.sort();

    let metrics = evaluate_counts(&to_counts(&full_tiles));
    if metrics.is_agari || metrics.shanten < 1 {
        return Err(format!(
            "wind-order hand must not be ready, got {} shanten",
            metrics.shanten
        ));
    }

    // A suit dora keeps every held wind valueless.
    let dora_indicator = draw_suited(&mut deck, &[])?;
    let ura_indicator = draw_suited(&mut deck, &[])?;

    let scores = random_scores_with_human_first();
    // Wind order already plans the rivers without calls, so no discard in the
    // plan is forced tedashi.
    let river_plan = RiverPlan {
        counts: plan.river_counts,
        ..RiverPlan::default()
    };
    let deal = deal_opponents(&mut deck, plan.human_wind, &scores, &river_plan)
        .ok_or_else(|| "Deck exhausted dealing the opponents".to_string())?;

    let tiles_remaining = deck.remaining().saturating_sub(12).min(u8::MAX as usize) as u8;
    if tiles_remaining == 0 {
        return Err("No drawable tiles remain".to_string());
    }

    if plan.river_counts[0] != 0 {
        return Err("The human must not have discarded before its first turn".to_string());
    }

    let human = PlayerState {
        seat: 0,
        name: "You".to_string(),
        is_human: true,
        wind: plan.human_wind,
        score: scores[0],
        hand: concealed.iter().map(ToString::to_string).collect(),
        draw: Some(answer.to_string()),
        red_fives: Vec::new(),
        discards: Vec::new(),
        melds: Vec::new(),
        is_riichi: false,
        riichi_discard_index: None,
    };

    let mut players = Vec::with_capacity(4);
    players.push(human);
    players.extend(deal.players);
    players.sort_by_key(|player| player.seat);

    let state = GameState {
        category: category.to_string(),
        target_action: TargetAction::NaniKiru,
        correct_action: CorrectAction::dama(answer.to_string()),
        equivalent_tiles: Vec::new(),
        decision: DecisionContext::SelfTurn,
        ai_decision: None,
        riichi_triggers: Vec::new(),
        dama_reasons: Vec::new(),
        shouminkan_triggers: Vec::new(),
        book_rationale: None,
        can_riichi: false,
        hand_string: format_hand_compact(&full_tiles),
        tiles: full_tiles.iter().map(ToString::to_string).collect(),
        shanten: metrics.shanten,
        is_agari: metrics.is_agari,
        decompositions_count: metrics.decompositions_count,
        ukeire_tiles: metrics.ukeire_tiles,
        ukeire_total: metrics.ukeire_total,
        round_wind: plan.round_wind,
        hand_number: 1,
        honba: 0,
        riichi_sticks: 0,
        dora_indicators: vec![dora_indicator.to_string()],
        ura_dora_indicators: vec![ura_indicator.to_string()],
        tiles_remaining,
        current_turn: 0,
        players,
    };

    validate(&state, &plan)?;
    Ok(state)
}

/// Picks a round and seat wind where the right player's wind is valueless.
///
/// The valueless winds are every wind except the round wind and the human's own
/// wind, so the shimocha's wind is in the hand exactly when it is neither. When
/// the human is the dealer (East) the hand is the opening draw and every river
/// is empty; otherwise the board stops right after Kamicha's first discard, the
/// turn on which the human first draws.
fn plan() -> Result<SeatPlan, String> {
    let round_wind = choose(&[Wind::East, Wind::South]).ok_or("No round wind available")?;
    let human_wind = choose(&Wind::ALL).ok_or("No seat wind available")?;

    let answer = human_wind.next(1);
    if answer == round_wind {
        return Err(
            "The right player's wind is the round wind, so it is not a valueless wind".to_string(),
        );
    }

    let hand_winds: Vec<Wind> = Wind::ALL
        .iter()
        .copied()
        .filter(|wind| *wind != human_wind && *wind != round_wind)
        .collect();
    if !hand_winds.contains(&answer) {
        return Err("The right player's wind is missing from the hand".to_string());
    }

    let river_counts = if human_wind == Wind::East {
        [0; 4]
    } else {
        river_counts(dealer_seat(human_wind), 3, &[], 0)
    };

    Ok(SeatPlan {
        round_wind,
        human_wind,
        hand_winds,
        river_counts,
    })
}

fn validate(state: &GameState, plan: &SeatPlan) -> Result<(), String> {
    for (seat, player) in state.players.iter().enumerate() {
        let expected = plan.human_wind.next(seat);
        if player.wind != expected {
            return Err(format!(
                "seat {seat} has wind {:?}, expected {:?}",
                player.wind, expected
            ));
        }
    }

    let mut held_winds = Vec::new();
    for code in &state.tiles {
        let tile = Tile::try_from(code.as_str()).map_err(|err| err.to_string())?;
        if let Tile::Honor(honor) = tile {
            let wind = wind_from_honor(honor)
                .ok_or_else(|| format!("The hand holds a dragon ({code})"))?;
            held_winds.push(wind);
        }
    }

    if held_winds.len() != plan.hand_winds.len() {
        return Err(format!(
            "the hand holds {} winds, expected {}",
            held_winds.len(),
            plan.hand_winds.len()
        ));
    }
    for &wind in &plan.hand_winds {
        if held_winds.iter().filter(|held| **held == wind).count() != 1 {
            return Err(format!("the hand must hold exactly one copy of {wind:?}"));
        }
    }

    let answer = plan.answer();
    if answer == plan.round_wind || answer == plan.human_wind {
        return Err("The answer wind is not valueless".to_string());
    }
    let answer_code = honor(answer).to_string();
    if state.correct_action.tile() != Some(answer_code.as_str()) {
        return Err("The answer is not the right player's wind".to_string());
    }
    if !state.equivalent_tiles.is_empty() {
        return Err("The wind order has exactly one answer".to_string());
    }

    if state.hand_number != 1 {
        return Err(format!(
            "the wind-order lesson is a first-turn drill, got hand {}",
            state.hand_number
        ));
    }
    if state.players[0].discards.len() != plan.river_counts[0] {
        return Err("the human river does not match the planned timeline".to_string());
    }
    for player in &state.players {
        if !player.melds.is_empty() || player.is_riichi {
            return Err(format!("seat {} already called or declared", player.seat));
        }
        if player.seat != 0 && player.draw.is_some() {
            return Err(format!("seat {} has an active draw", player.seat));
        }
    }

    Ok(())
}

fn honor(wind: Wind) -> Tile {
    Tile::Honor(wind_to_honor(wind))
}

fn wind_from_honor(honor: Honor) -> Option<Wind> {
    match honor {
        Honor::East => Some(Wind::East),
        Honor::South => Some(Wind::South),
        Honor::West => Some(Wind::West),
        Honor::North => Some(Wind::North),
        Honor::White | Honor::Green | Honor::Red => None,
    }
}

fn is_suited(tile: Tile) -> bool {
    matches!(tile, Tile::Suited { .. })
}

fn add_pair(hand: &mut Vec<Tile>, deck: &mut Deck) -> Result<(), String> {
    let candidates: Vec<Tile> = ALL_TILES
        .iter()
        .copied()
        .filter(|tile| is_suited(*tile) && deck.count(*tile) >= 2)
        .collect();
    let tile = choose(&candidates).ok_or("No suited pair left in the deck")?;
    deck.take_n(tile, 2)?;
    hand.push(tile);
    hand.push(tile);
    Ok(())
}

/// Adds one suited run or triplet. Returns false when the deck cannot make one.
fn add_set(hand: &mut Vec<Tile>, deck: &mut Deck) -> Result<bool, String> {
    if let Some(run) = random_run(deck) {
        for tile in run {
            deck.take(tile)?;
            hand.push(tile);
        }
        return Ok(true);
    }
    if let Some(tile) = random_triplet(deck) {
        deck.take_n(tile, 3)?;
        hand.extend([tile; 3]);
        return Ok(true);
    }
    Ok(false)
}

fn random_run(deck: &Deck) -> Option<[Tile; 3]> {
    let mut candidates = Vec::new();
    for suit in [Suit::Man, Suit::Pin, Suit::Sou] {
        for start in 1u8..=7 {
            let run = [
                Tile::Suited { suit, value: start },
                Tile::Suited {
                    suit,
                    value: start + 1,
                },
                Tile::Suited {
                    suit,
                    value: start + 2,
                },
            ];
            if run.iter().all(|tile| deck.has(*tile)) {
                candidates.push(run);
            }
        }
    }
    choose(&candidates)
}

fn random_triplet(deck: &Deck) -> Option<Tile> {
    let candidates: Vec<Tile> = ALL_TILES
        .iter()
        .copied()
        .filter(|tile| is_suited(*tile) && deck.count(*tile) >= 3)
        .collect();
    choose(&candidates)
}

fn add_single(hand: &mut Vec<Tile>, deck: &mut Deck) -> Result<(), String> {
    let tile = draw_suited(deck, &[])?;
    hand.push(tile);
    Ok(())
}

fn draw_suited(deck: &mut Deck, excluded: &[Tile]) -> Result<Tile, String> {
    let available: Vec<Tile> = ALL_TILES
        .iter()
        .copied()
        .filter(|tile| is_suited(*tile) && deck.has(*tile) && !excluded.contains(tile))
        .collect();
    let tile = choose(&available).ok_or("No suited tile left in the deck")?;
    deck.take(tile)?;
    Ok(tile)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_plan() -> SeatPlan {
        for _ in 0..200 {
            if let Ok(plan) = plan() {
                return plan;
            }
        }
        panic!("no valueless right wind came up in 200 draws");
    }

    #[test]
    fn two_wind_and_three_wind_plans_both_exist() {
        let mut saw_two = false;
        let mut saw_three = false;

        for _ in 0..200 {
            let plan = valid_plan();
            match plan.hand_winds.len() {
                2 => saw_two = true,
                3 => saw_three = true,
                other => panic!("unexpected wind count {other}"),
            }

            assert!(plan.hand_winds.contains(&plan.answer()));
            assert!(!plan.hand_winds.contains(&plan.human_wind));
            assert!(!plan.hand_winds.contains(&plan.round_wind));
        }

        assert!(saw_two && saw_three);
    }

    #[test]
    fn the_dealers_opening_draw_has_no_rivers() {
        // Whatever seat the human holds, the plan only lets the dealer draw on
        // an empty table, and every other seat draws after Kamicha's discard.
        for _ in 0..100 {
            let plan = valid_plan();
            if plan.human_wind == Wind::East {
                assert_eq!(plan.river_counts, [0; 4]);
            } else {
                assert_eq!(plan.river_counts[0], 0);
                assert!(plan.river_counts.iter().all(|count| *count <= 1));
            }
        }
    }
}
