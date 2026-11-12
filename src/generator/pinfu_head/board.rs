//! Board assembly for the `pinfu_head` lesson.
//!
//! Every hand is built the same way, in the book's terms:
//!
//! - four run-shaped blocks — two complete runs and two side-wait protoruns —
//!   so the closed hand stays pinfu-shaped and no triplet can appear;
//! - three lone head candidates, each a terminal or a valueless wind with no
//!   other tile of its suit within two ranks, so pairing one is its only use.
//!   "All of these three tiles may appear useless, but they can be the head of
//!   a pinfu hand when any of them grows into a pair" (ch5:458);
//! - one lone value honor — a dragon, the round wind, or the seat wind — which
//!   "cannot be the head of pinfu" (ch5:458). That tile is the answer.
//!
//! Nothing pairs, so the hand has no head yet: exactly the case the book calls
//! out ("Keep this in mind especially when a hand is lacking any pair",
//! ch5:449). The first-turn table keeps calls, riichi, and furiten out of the
//! decision, and the dora is never the answer, so the choice is structural
//! rather than a score comparison.

use agari::context::indicator_to_dora;
use agari::parse::to_counts;
use agari::tile::{Honor, Suit, Tile};

use super::heads::{can_be_pinfu_head, is_value_honor};
use crate::generator::support::analysis::{evaluate_counts, wind_to_honor};
use crate::generator::support::deck::{ALL_TILES, Deck};
use crate::generator::support::format::format_hand_compact;
use crate::generator::support::table::{
    OpponentDeal, RiverPlan, deal_opponents, random_round, random_scores_with_human_first,
    river_counts,
};
use crate::rng::{choose, gen_range, shuffle};
use crate::state::{
    CorrectAction, DecisionContext, GameState, PlayerState, TargetAction, Wind, dealer_seat,
};

/// How many lone head candidates every hand keeps beside the value honor.
const HEAD_CANDIDATES: usize = 3;

/// One hand drawn under the lesson's constraints.
struct HandPlan {
    round_wind: Wind,
    hand_number: u8,
    human_wind: Wind,
    /// The lone value honor: the only tile in the hand that cannot be the head.
    value_honor: Tile,
    /// Lone terminals and valueless winds that can still pair into the head.
    heads: Vec<Tile>,
    /// Two complete runs and two side-wait protoruns.
    blocks: Vec<Vec<Tile>>,
    /// All fourteen tiles, sorted.
    full_tiles: Vec<Tile>,
    /// The tile just drawn. Never the answer, so the value honor is in hand.
    draw: Tile,
    /// Discards per seat before the human's first draw.
    river_counts: [usize; 4],
}

impl HandPlan {
    /// The thirteen concealed tiles: the full hand without the draw.
    fn concealed(&self) -> Result<Vec<Tile>, String> {
        let mut concealed = self.full_tiles.clone();
        let index = concealed
            .iter()
            .position(|tile| *tile == self.draw)
            .ok_or("the drawn tile is not part of the hand")?;
        concealed.remove(index);
        Ok(concealed)
    }

    /// The tiles left after the answer is discarded: thirteen tiles, no head.
    fn after_answer(&self) -> Vec<Tile> {
        self.full_tiles
            .iter()
            .copied()
            .filter(|tile| *tile != self.value_honor)
            .collect()
    }
}

/// Builds and validates one `pinfu_head` board.
pub(super) fn build(category: &str) -> Result<GameState, String> {
    let plan = plan()?;
    let answer = plan.value_honor;

    let mut deck = Deck::fresh();
    for tile in &plan.full_tiles {
        deck.take(*tile)?;
    }
    // The dora may never be the answer, or keeping a value tile would have a
    // point and the drill would stop being structural.
    let dora_indicator = draw_indicator(&mut deck, answer)?;
    let ura_indicator = draw_indicator(&mut deck, answer)?;

    let scores = random_scores_with_human_first();
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

    let concealed = plan.concealed()?;
    if concealed.len() != 13 {
        return Err(format!(
            "pinfu_head holds {} concealed tiles, expected 13",
            concealed.len()
        ));
    }

    let metrics = evaluate_counts(&to_counts(&plan.after_answer()));
    let human = PlayerState {
        seat: 0,
        name: "You".to_string(),
        is_human: true,
        wind: plan.human_wind,
        score: scores[0],
        hand: concealed.iter().map(ToString::to_string).collect(),
        draw: Some(plan.draw.to_string()),
        red_fives: Vec::new(),
        discards: Vec::new(),
        melds: Vec::new(),
        is_riichi: false,
        riichi_discard_index: None,
    };

    let OpponentDeal {
        players: opponent_players,
        rivers: opponent_rivers,
    } = deal;
    let mut players = Vec::with_capacity(4);
    players.push(human);
    players.extend(opponent_players);
    players.sort_by_key(|player| player.seat);

    let state = GameState {
        category: category.to_string(),
        target_action: TargetAction::NaniKiru,
        correct_action: CorrectAction::dama(answer.to_string()),
        equivalent_tiles: Vec::new(),
        decision: DecisionContext::SelfTurn,
        scenario_note: Some(
            "Your hand is closed and built from runs and side waits, with no pair yet: \
             pinfu is the plan. Which tile do you discard?"
                .to_string(),
        ),
        call_offer: None,
        ai_decision: None,
        riichi_triggers: Vec::new(),
        dama_reasons: Vec::new(),
        shouminkan_triggers: Vec::new(),
        book_rationale: None,
        can_riichi: false,
        hand_string: format_hand_compact(&plan.full_tiles),
        tiles: plan.full_tiles.iter().map(ToString::to_string).collect(),
        shanten: metrics.shanten,
        is_agari: metrics.is_agari,
        decompositions_count: metrics.decompositions_count,
        ukeire_tiles: metrics.ukeire_tiles,
        ukeire_total: metrics.ukeire_total,
        round_wind: plan.round_wind,
        hand_number: plan.hand_number,
        honba: gen_range(0, 4) as u8,
        riichi_sticks: 0,
        dora_indicators: vec![dora_indicator.to_string()],
        ura_dora_indicators: vec![ura_indicator.to_string()],
        tiles_remaining,
        current_turn: 0,
        players,
    };

    validate(&state, &plan, &opponent_rivers, answer)?;
    Ok(state)
}

/// Draws a round, a seat, the value honor, the head candidates and the blocks.
fn plan() -> Result<HandPlan, String> {
    let (round_wind, hand_number) = random_round();
    let human_wind = choose(&Wind::ALL).ok_or("No seat wind available")?;

    // Every value honor the table creates; the hand may hold exactly one.
    let mut value_honors = vec![
        Tile::Honor(Honor::White),
        Tile::Honor(Honor::Green),
        Tile::Honor(Honor::Red),
        Tile::Honor(wind_to_honor(round_wind)),
        Tile::Honor(wind_to_honor(human_wind)),
    ];
    value_honors.sort();
    value_honors.dedup();
    let value_honor = choose(&value_honors).ok_or("No value honor available")?;

    let heads = pick_heads(round_wind, human_wind, value_honor)?;
    let blocks = pick_blocks(&heads, value_honor)?;

    let mut full_tiles: Vec<Tile> = heads.clone();
    full_tiles.push(value_honor);
    for block in &blocks {
        full_tiles.extend(block.iter().copied());
    }
    full_tiles.sort();

    if full_tiles.len() != 14 {
        return Err(format!(
            "the built hand holds {} tiles, expected 14",
            full_tiles.len()
        ));
    }

    // The draw is never the answer: the value honor has to be found in the 13
    // tiles already in hand, as it is in the book's example.
    let draw_pool: Vec<Tile> = full_tiles
        .iter()
        .copied()
        .filter(|tile| *tile != value_honor)
        .collect();
    let draw = choose(&draw_pool).ok_or("No tile available to draw")?;

    let planned_rivers = if human_wind == Wind::East {
        // The dealer's opening draw: no river has a tile yet.
        [0; 4]
    } else {
        // The board stops right after Kamicha's first discard, when the human
        // first draws.
        river_counts(dealer_seat(human_wind), 3, &[], 0)
    };
    let plan = HandPlan {
        round_wind,
        hand_number,
        human_wind,
        value_honor,
        heads,
        blocks,
        full_tiles,
        draw,
        river_counts: planned_rivers,
    };

    check_plan(&plan)?;
    Ok(plan)
}

/// Picks the three lone tiles that can still pair into the pinfu head.
fn pick_heads(round_wind: Wind, human_wind: Wind, value_honor: Tile) -> Result<Vec<Tile>, String> {
    let mut pool = Vec::new();
    // "a pair of number tiles": terminals are the ones that look useless.
    for suit in [Suit::Man, Suit::Pin, Suit::Sou] {
        pool.push(Tile::suited(suit, 1));
        pool.push(Tile::suited(suit, 9));
    }
    // "or valueless wind tiles".
    for wind in Wind::ALL {
        if wind != round_wind && wind != human_wind {
            pool.push(Tile::Honor(wind_to_honor(wind)));
        }
    }
    pool.retain(|tile| *tile != value_honor);
    shuffle(&mut pool);
    pool.truncate(HEAD_CANDIDATES);

    if pool.len() != HEAD_CANDIDATES {
        return Err("not enough head candidates for the hand".to_string());
    }
    pool.sort();
    Ok(pool)
}

/// Picks two complete runs and two side-wait protoruns around the lone tiles.
fn pick_blocks(heads: &[Tile], value_honor: Tile) -> Result<Vec<Vec<Tile>>, String> {
    let mut taken: Vec<Tile> = heads.to_vec();
    taken.push(value_honor);
    // A lone head candidate is useless on purpose: nothing of its suit may sit
    // within two ranks, so pairing it is its only future.
    let forbidden = isolation_zone(heads);

    let mut blocks = Vec::new();
    for _ in 0..2 {
        let options = free_blocks(runs(), &taken, &forbidden);
        let run = choose(&options).ok_or("no complete run fits the head candidates")?;
        taken.extend(run.iter().copied());
        blocks.push(run);
    }
    for _ in 0..2 {
        let options = free_blocks(protoruns(), &taken, &forbidden);
        let protorun = choose(&options).ok_or("no side-wait protorun fits the head candidates")?;
        taken.extend(protorun.iter().copied());
        blocks.push(protorun);
    }

    if !blocks_across_two_suits(&blocks) {
        return Err("the blocks are all in one suit".to_string());
    }
    Ok(blocks)
}

/// Every three-tile suited run.
fn runs() -> Vec<Vec<Tile>> {
    let mut runs = Vec::new();
    for suit in [Suit::Man, Suit::Pin, Suit::Sou] {
        for start in 1u8..=7 {
            runs.push(vec![
                Tile::suited(suit, start),
                Tile::suited(suit, start + 1),
                Tile::suited(suit, start + 2),
            ]);
        }
    }
    runs
}

/// Every two-tile side-wait (ryanmen) protorun: 23 through 78.
fn protoruns() -> Vec<Vec<Tile>> {
    let mut protoruns = Vec::new();
    for suit in [Suit::Man, Suit::Pin, Suit::Sou] {
        for low in 2u8..=7 {
            protoruns.push(vec![Tile::suited(suit, low), Tile::suited(suit, low + 1)]);
        }
    }
    protoruns
}

/// Blocks whose every tile is still free.
fn free_blocks(options: Vec<Vec<Tile>>, taken: &[Tile], forbidden: &[Tile]) -> Vec<Vec<Tile>> {
    options
        .into_iter()
        .filter(|block| {
            block
                .iter()
                .all(|tile| !taken.contains(tile) && !forbidden.contains(tile))
        })
        .collect()
}

/// The tiles that must stay empty so a lone head candidate keeps its shape.
///
/// The candidates are terminals and winds. A terminal may not have anything
/// within two ranks of it in its suit, or it would be a protorun partner rather
/// than a pair candidate; winds have no neighbours at all.
fn isolation_zone(tiles: &[Tile]) -> Vec<Tile> {
    let mut forbidden = Vec::new();
    for tile in tiles {
        let Tile::Suited { suit, value } = *tile else {
            continue;
        };
        for delta in [-2i16, -1, 1, 2] {
            let neighbour = value as i16 + delta;
            if (1..=9).contains(&neighbour) {
                forbidden.push(Tile::Suited {
                    suit,
                    value: neighbour as u8,
                });
            }
        }
    }
    forbidden
}

fn blocks_across_two_suits(blocks: &[Vec<Tile>]) -> bool {
    let mut suits = Vec::new();
    for tile in blocks.iter().flatten() {
        let Tile::Suited { suit, .. } = *tile else {
            continue;
        };
        if !suits.contains(&suit) {
            suits.push(suit);
        }
    }
    suits.len() >= 2
}

/// Draws an indicator whose dora is not `forbidden`.
fn draw_indicator(deck: &mut Deck, forbidden: Tile) -> Result<Tile, String> {
    let candidates: Vec<Tile> = ALL_TILES
        .iter()
        .copied()
        .filter(|tile| deck.has(*tile) && indicator_to_dora(*tile) != forbidden)
        .collect();
    let indicator = choose(&candidates).ok_or("No dora indicator left in the deck")?;
    deck.take(indicator)?;
    Ok(indicator)
}

/// Self-check on the built hand, before it becomes a board.
fn check_plan(plan: &HandPlan) -> Result<(), String> {
    let mut counts: Vec<Tile> = Vec::new();
    for tile in &plan.full_tiles {
        if counts.contains(tile) {
            return Err(format!("the hand pairs {tile}: it must hold no pair yet"));
        }
        counts.push(*tile);
    }

    let value_honors: Vec<&Tile> = plan
        .full_tiles
        .iter()
        .filter(|tile| is_value_honor(**tile, plan.round_wind, plan.human_wind))
        .collect();
    if value_honors.len() != 1 || *value_honors[0] != plan.value_honor {
        return Err("the hand must hold exactly one value honor".to_string());
    }
    for tile in &plan.full_tiles {
        if *tile == plan.value_honor {
            continue;
        }
        if !can_be_pinfu_head(*tile, plan.round_wind, plan.human_wind) {
            return Err(format!(
                "{tile} cannot be the pinfu head but is not the answer"
            ));
        }
    }

    // The lone candidates stay lone, and nothing of their suit sits near them.
    let forbidden = isolation_zone(&plan.heads);
    for tile in &plan.full_tiles {
        if plan.heads.contains(tile) {
            continue;
        }
        if forbidden.contains(tile) {
            return Err(format!("{tile} sits too close to a lone head candidate"));
        }
    }

    // The answer is the only tile left over, so the hand has no head.
    let heads_kept = plan
        .full_tiles
        .iter()
        .filter(|tile| plan.heads.contains(*tile))
        .count();
    if heads_kept != HEAD_CANDIDATES {
        return Err("a head candidate is missing from the hand".to_string());
    }

    let after = plan.after_answer();
    if after.len() != 13 {
        return Err("the answer must leave thirteen tiles".to_string());
    }
    let metrics = evaluate_counts(&to_counts(&after));
    if metrics.is_agari || metrics.shanten < 2 {
        return Err(format!(
            "the hand must stay far from ready, got {} shanten",
            metrics.shanten
        ));
    }

    Ok(())
}

/// Re-reads the finished state and re-proves the answer from its tiles.
fn validate(
    state: &GameState,
    plan: &HandPlan,
    opponent_rivers: &[Vec<Tile>],
    answer: Tile,
) -> Result<(), String> {
    if state.players[0].hand.len() != 13 {
        return Err("the human must hold thirteen concealed tiles".to_string());
    }
    if state.tiles.len() != 14 {
        return Err("the hand must hold fourteen tiles".to_string());
    }

    let round = state.round_wind;
    let seat = state.players[0].wind;

    let tiles: Vec<Tile> = state
        .tiles
        .iter()
        .map(|code| Tile::try_from(code.as_str()).map_err(|err| err.to_string()))
        .collect::<Result<_, _>>()?;

    // Structural oracle: the answer is the only tile that can never be the head.
    let mut value_honors = Vec::new();
    for tile in &tiles {
        if is_value_honor(*tile, round, seat) {
            value_honors.push(*tile);
        } else if !can_be_pinfu_head(*tile, round, seat) {
            return Err(format!(
                "{tile} cannot be the pinfu head but is not the answer"
            ));
        }
    }
    if value_honors.len() != 1 {
        return Err(format!(
            "the hand holds {} value honors, expected exactly one",
            value_honors.len()
        ));
    }
    if value_honors[0] != answer {
        return Err("the answer is not the hand's value honor".to_string());
    }
    let answer_code = answer.to_string();
    if state.correct_action.tile() != Some(answer_code.as_str()) {
        return Err("the answer is not the value honor's tile".to_string());
    }
    if !state.equivalent_tiles.is_empty() {
        return Err("the value honor is the one and only answer".to_string());
    }

    // No pair yet, and every block the skeleton built is still there.
    let mut seen: Vec<Tile> = Vec::new();
    for tile in &tiles {
        if seen.contains(tile) {
            return Err(format!("the hand pairs {tile}: it must hold no pair yet"));
        }
        seen.push(*tile);
    }
    for head in &plan.heads {
        if !tiles.contains(head) {
            return Err(format!("the kept head candidate {head} is missing"));
        }
    }
    for tile in plan.blocks.iter().flatten() {
        if !tiles.contains(tile) {
            return Err(format!("the block tile {tile} is missing"));
        }
    }

    // The table: a first turn, closed, not ready, and the answer is no dora.
    if state.players[0].discards.len() != plan.river_counts[0] {
        return Err("the human river does not match the planned timeline".to_string());
    }
    for player in &state.players {
        if !player.melds.is_empty() || player.is_riichi {
            return Err(format!(
                "seat {} has already called or declared",
                player.seat
            ));
        }
        if player.seat != 0 && player.draw.is_some() {
            return Err(format!("seat {} has an active draw", player.seat));
        }
    }
    if state
        .dora_indicators
        .iter()
        .filter_map(|code| Tile::try_from(code.as_str()).ok())
        .any(|indicator| indicator_to_dora(indicator) == answer)
    {
        return Err("the answer cannot be the dora".to_string());
    }
    if opponent_rivers.iter().any(|river| river.len() > 1) {
        return Err("the opponents cannot have discarded twice on the first turn".to_string());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::heads::wind_from_honor;
    use super::*;

    #[test]
    fn plans_always_hold_three_lone_candidates_and_one_value_honor() {
        for _ in 0..500 {
            let plan = plan().expect("the plan must be buildable");

            assert_eq!(plan.heads.len(), HEAD_CANDIDATES);
            assert_eq!(plan.full_tiles.len(), 14);
            assert!(plan.full_tiles.contains(&plan.value_honor));
            assert!(!plan.heads.contains(&plan.value_honor));

            for head in &plan.heads {
                assert!(
                    can_be_pinfu_head(*head, plan.round_wind, plan.human_wind),
                    "{head} must be able to become the pinfu head"
                );
            }
            assert!(is_value_honor(
                plan.value_honor,
                plan.round_wind,
                plan.human_wind
            ));
        }
    }

    #[test]
    fn the_value_honor_moves_between_dragons_and_table_winds() {
        let mut dragons = false;
        let mut round_wind = false;
        let mut seat_wind = false;

        for _ in 0..500 {
            let plan = plan().expect("the plan must be buildable");
            match plan.value_honor {
                Tile::Honor(Honor::White | Honor::Green | Honor::Red) => dragons = true,
                Tile::Honor(honor) => match wind_from_honor(honor) {
                    Some(wind) if wind == plan.round_wind => round_wind = true,
                    Some(wind) if wind == plan.human_wind => seat_wind = true,
                    Some(_) => panic!("{honor:?} is not a value honor"),
                    None => panic!("{honor:?} is not a wind"),
                },
                Tile::Suited { .. } => panic!("the answer must be an honor"),
            }
        }

        assert!(dragons, "dragons must be generated");
        assert!(round_wind, "the round wind must be generated");
        assert!(seat_wind, "the seat wind must be generated");
    }

    #[test]
    fn the_draw_is_never_the_answer() {
        for _ in 0..200 {
            let plan = plan().expect("the plan must be buildable");
            assert_ne!(plan.draw, plan.value_honor);
            assert!(plan.concealed().unwrap().contains(&plan.value_honor));
        }
    }
}
