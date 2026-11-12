//! Board assembly for the `pinfu_head` lesson.
//!
//! The hand copies the *texture* of the book's worked example ("Pinfu 4",
//! ch5:452), not just its answer:
//!
//! ```text
//! 1m 4m 6m | 2p 3p 6p 7p 9p | 5s 6s 6s 7s | E fa
//! ```
//!
//! - two side-wait protoruns (the book's `23p` and `67p`);
//! - one middle closed-wait protorun (the book's `46m`) — two loose-looking
//!   tiles that are really shape;
//! - one bulging float `x, x+1, x+1, x+2` (the book's `5667s`), whose doubled
//!   middle tile is the hand's *only* duplicate: a shape, not a committed head;
//! - three lone floats, one of each kind the book names: an isolated terminal
//!   (`1m`), a terminal exactly two ranks from a block (`9p`, next to `67p`),
//!   and a valueless wind (`E`);
//! - one lone value honor (`fa`), which "cannot be the head of pinfu" and is
//!   therefore the answer.
//!
//! So the hand is not a clean "no pair anywhere" template: like the book's, it
//! has a duplicate that lives inside a bulge, a closed wait that looks like a
//! float, and a terminal float sitting next to a protorun. Those are the
//! distractors that make the player read the hand instead of spotting the one
//! odd honor. What stays exact is the oracle: the value honor is the only tile
//! in the fourteen that can never become the pinfu head.
//!
//! The middle kanchan (`24`..`68`) and the bulges (`2334`..`6778`) keep every
//! terminal out of the blocks, so the hand's two terminals really are its two
//! spare floats. The first-turn table keeps calls, riichi, and furiten out of
//! the decision, and the dora is never the answer, so the choice is structural
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
use crate::rng::{choose, gen_range};
use crate::state::{
    CorrectAction, DecisionContext, GameState, PlayerState, TargetAction, Wind, dealer_seat,
};

const SUITS: [Suit; 3] = [Suit::Man, Suit::Pin, Suit::Sou];

/// How many lone floats every hand keeps beside the value honor.
const FLOATS: usize = 3;

/// The block layout one hand is built from.
struct Shapes {
    /// `x, x+1, x+1, x+2`: the book's bulging float, and the hand's only
    /// duplicate tile type.
    bulge: [Tile; 4],
    /// Two side-wait (ryanmen) protoruns.
    ryanmen: Vec<[Tile; 2]>,
    /// One middle closed-wait (kanchan) protorun.
    kanchan: [Tile; 2],
    /// `[valueless wind, isolated terminal, terminal two ranks from a block]`,
    /// in that order.
    floats: Vec<Tile>,
}

/// One hand drawn under the lesson's constraints.
struct HandPlan {
    round_wind: Wind,
    hand_number: u8,
    human_wind: Wind,
    /// The lone value honor: the only tile in the hand that cannot be the head.
    value_honor: Tile,
    shapes: Shapes,
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

    /// The tiles left after the answer is discarded: thirteen tiles.
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
            "Your hand is closed and built from runs and side waits, with no committed head \
             yet: pinfu is the plan. Which tile do you discard?"
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

/// How many full hand layouts to try before giving up.
///
/// The float rules are the narrow part: the book's `9p` needs a block tile
/// exactly two ranks from a terminal with the rank between them free, and the
/// isolated `1m` needs a terminal whose whole neighbourhood is empty. A random
/// block layout satisfies both maybe half the time, so the draw is retried
/// rather than relaxed.
const MAX_PLAN_ATTEMPTS: usize = 200;

/// Draws a round, a seat, the value honor and the book's block layout.
fn plan() -> Result<HandPlan, String> {
    let mut last_error = String::new();
    for _ in 0..MAX_PLAN_ATTEMPTS {
        match attempt() {
            Ok(plan) => return Ok(plan),
            Err(err) => last_error = err,
        }
    }
    Err(format!(
        "failed to build a pinfu_head hand after {MAX_PLAN_ATTEMPTS} attempts: {last_error}"
    ))
}

/// One full draw, checked against every lesson constraint.
fn attempt() -> Result<HandPlan, String> {
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

    let shapes =
        pick_shapes(round_wind, human_wind, value_honor).ok_or("no shape fits the lesson")?;

    let mut full_tiles: Vec<Tile> = vec![value_honor];
    full_tiles.extend(shapes.bulge.iter().copied());
    for protorun in &shapes.ryanmen {
        full_tiles.extend(protorun.iter().copied());
    }
    full_tiles.extend(shapes.kanchan.iter().copied());
    full_tiles.extend(shapes.floats.iter().copied());
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
        shapes,
        full_tiles,
        draw,
        river_counts: planned_rivers,
    };

    check_plan(&plan)?;
    Ok(plan)
}

/// Places the bulge, the protoruns and the three lone floats.
///
/// The bulge goes first because it owns the hand's only duplicate tile; every
/// later block and float is a tile type the hand does not hold yet.
fn pick_shapes(round_wind: Wind, human_wind: Wind, value_honor: Tile) -> Option<Shapes> {
    let mut taken = vec![value_honor];

    // The book's `5667s`: `x, x+1, x+1, x+2`. The range 2334..6778 is the one
    // ch. 3 gives for bulging floats.
    let mut bulges = Vec::new();
    for suit in SUITS {
        for low in 2u8..=6 {
            bulges.push([
                Tile::suited(suit, low),
                Tile::suited(suit, low + 1),
                Tile::suited(suit, low + 1),
                Tile::suited(suit, low + 2),
            ]);
        }
    }
    // `value_honor` is an honor, so it can never collide with a bulge; keep the
    // filter anyway so the invariant is local.
    bulges.retain(|bulge| bulge.iter().all(|tile| !taken.contains(tile)));
    let bulge = choose(&bulges)?;
    taken.extend(bulge.iter().copied());

    // Two side-wait protoruns: `23` through `78`.
    let mut ryanmen = Vec::new();
    for _ in 0..2 {
        let mut options = Vec::new();
        for suit in SUITS {
            for low in 2u8..=7 {
                let protorun = [Tile::suited(suit, low), Tile::suited(suit, low + 1)];
                if protorun.iter().all(|tile| !taken.contains(tile)) {
                    options.push(protorun);
                }
            }
        }
        let protorun = choose(&options)?;
        taken.extend(protorun.iter().copied());
        ryanmen.push(protorun);
    }

    // One middle closed-wait protorun (`24`..`68`), so no terminal ever lives
    // in a block: the book's `46m`, and the reason both terminals below are
    // genuinely spare.
    let mut kanchan = Vec::new();
    for suit in SUITS {
        for low in 2u8..=6 {
            let protorun = [Tile::suited(suit, low), Tile::suited(suit, low + 2)];
            if protorun.iter().all(|tile| !taken.contains(tile)) {
                kanchan.push(protorun);
            }
        }
    }
    let kanchan = choose(&kanchan)?;
    taken.extend(kanchan.iter().copied());

    // The floats, in the order the doc comment names them.
    let mut floats = Vec::new();

    // The book's `E`: a valueless wind.
    let mut winds = Vec::new();
    for wind in Wind::ALL {
        if wind == round_wind || wind == human_wind {
            continue;
        }
        let tile = Tile::Honor(wind_to_honor(wind));
        if !taken.contains(&tile) && !floats.contains(&tile) {
            winds.push(tile);
        }
    }
    let wind = choose(&winds)?;
    floats.push(wind);

    // The book's `1m`: a terminal with nothing of its suit within two ranks.
    let mut isolated = Vec::new();
    for terminal in terminals() {
        if taken.contains(&terminal) || floats.contains(&terminal) {
            continue;
        }
        let alone = !taken
            .iter()
            .chain(floats.iter())
            .any(|other| *other != terminal && within_two(terminal, *other));
        if alone {
            isolated.push(terminal);
        }
    }
    let isolated = choose(&isolated)?;
    floats.push(isolated);

    // The book's `9p`: a terminal exactly two ranks from a block tile, and
    // nothing one rank away, so it forms only a closed wait with the block and
    // stays a float otherwise.
    let mut adjacent = Vec::new();
    for terminal in terminals() {
        if taken.contains(&terminal) || floats.contains(&terminal) {
            continue;
        }
        let one_away = taken
            .iter()
            .any(|other| *other != terminal && gap(terminal, *other) == Some(1));
        let two_away = taken
            .iter()
            .any(|other| *other != terminal && gap(terminal, *other) == Some(2));
        if !one_away && two_away {
            adjacent.push(terminal);
        }
    }
    let adjacent = choose(&adjacent)?;
    floats.push(adjacent);

    Some(Shapes {
        bulge,
        ryanmen,
        kanchan,
        floats,
    })
}

/// Every terminal tile.
fn terminals() -> Vec<Tile> {
    let mut terminals = Vec::new();
    for suit in SUITS {
        terminals.push(Tile::suited(suit, 1));
        terminals.push(Tile::suited(suit, 9));
    }
    terminals
}

/// True when two tiles of one suit are within two ranks of each other.
fn within_two(left: Tile, right: Tile) -> bool {
    gap(left, right).is_some_and(|gap| gap <= 2)
}

/// The rank gap between two tiles of the same suit, if they share one.
fn gap(left: Tile, right: Tile) -> Option<u8> {
    match (left, right) {
        (
            Tile::Suited {
                suit: left_suit,
                value: left_value,
            },
            Tile::Suited {
                suit: right_suit,
                value: right_value,
            },
        ) if left_suit == right_suit => Some(left_value.abs_diff(right_value)),
        _ => None,
    }
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

/// The tile types held more than once, in hand order.
fn repeated_types(tiles: &[Tile]) -> Vec<Tile> {
    let mut repeated = Vec::new();
    for (index, tile) in tiles.iter().enumerate() {
        if tiles[..index].contains(tile) {
            continue;
        }
        if tiles.iter().filter(|other| *other == tile).count() > 1 {
            repeated.push(*tile);
        }
    }
    repeated
}

/// Self-check on the built hand, before it becomes a board.
fn check_plan(plan: &HandPlan) -> Result<(), String> {
    // No committed head: the bulge's doubled middle is the only repeat.
    let repeated = repeated_types(&plan.full_tiles);
    if repeated != vec![plan.shapes.bulge[1]] {
        return Err(format!(
            "the only repeated tile must be the bulge's middle, got {repeated:?}"
        ));
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
        if *tile == plan.value_honor || *tile == plan.shapes.bulge[1] {
            continue;
        }
        if !can_be_pinfu_head(*tile, plan.round_wind, plan.human_wind) {
            return Err(format!(
                "{tile} cannot be the pinfu head but is not the answer"
            ));
        }
    }

    // Every block and float is still in the hand.
    for block in plan
        .shapes
        .ryanmen
        .iter()
        .map(|protorun| protorun.as_slice())
        .chain(std::iter::once(plan.shapes.kanchan.as_slice()))
        .chain(std::iter::once(plan.shapes.bulge.as_slice()))
    {
        for tile in block {
            if !plan.full_tiles.contains(tile) {
                return Err(format!("the block tile {tile} is missing"));
            }
        }
    }
    for float in &plan.shapes.floats {
        if !plan.full_tiles.contains(float) {
            return Err(format!("the kept float {float} is missing"));
        }
    }
    if plan.shapes.floats.len() != FLOATS {
        return Err("the hand must keep three lone floats".to_string());
    }
    // One float of each kind the book names: wind, isolated terminal, terminal
    // two ranks from a block.
    let winds = plan
        .shapes
        .floats
        .iter()
        .filter(|tile| matches!(tile, Tile::Honor(_)))
        .count();
    if winds != 1 {
        return Err("exactly one float must be the valueless wind".to_string());
    }
    let terminals_held = plan
        .shapes
        .floats
        .iter()
        .filter(|tile| matches!(tile, Tile::Suited { value: 1 | 9, .. }))
        .count();
    if terminals_held != 2 {
        return Err("the other two floats must be terminals".to_string());
    }

    // One terminal is the book's isolated `1m`, the other its `9p`: exactly two
    // ranks from a block tile with the rank between them free.
    let mut isolated = 0;
    let mut adjacent = 0;
    for float in &plan.shapes.floats {
        if !matches!(float, Tile::Suited { value: 1 | 9, .. }) {
            continue;
        }
        let nearest = plan
            .full_tiles
            .iter()
            .filter(|tile| *tile != float)
            .filter_map(|tile| gap(*float, *tile))
            .min();
        match nearest {
            Some(2) => adjacent += 1,
            Some(distance) if distance > 2 => isolated += 1,
            None => isolated += 1,
            Some(distance) => {
                return Err(format!(
                    "{float} sits {distance} from a block tile, so it is shape, not a float"
                ));
            }
        }
    }
    if isolated != 1 || adjacent != 1 {
        return Err(format!(
            "the terminals must be one isolated and one two ranks from a block, got \
             {isolated} isolated and {adjacent} adjacent"
        ));
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

    // No committed head: the only repeat is the bulge's middle.
    let repeated = repeated_types(&tiles);
    if repeated != vec![plan.shapes.bulge[1]] {
        return Err(format!(
            "the only repeated tile must be the bulge's middle, got {repeated:?}"
        ));
    }

    // Every block and float the skeleton built is still there.
    for tile in plan.shapes.bulge.iter().chain(plan.shapes.kanchan.iter()) {
        if !tiles.contains(tile) {
            return Err(format!("the block tile {tile} is missing"));
        }
    }
    for protorun in &plan.shapes.ryanmen {
        for tile in protorun {
            if !tiles.contains(tile) {
                return Err(format!("the block tile {tile} is missing"));
            }
        }
    }
    for float in &plan.shapes.floats {
        if !tiles.contains(float) {
            return Err(format!("the kept float {float} is missing"));
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

    fn count(tiles: &[Tile], tile: Tile) -> usize {
        tiles.iter().filter(|other| **other == tile).count()
    }

    #[test]
    fn plans_copy_the_books_texture() {
        let mut saw_isolated = 0;
        let mut saw_adjacent = 0;

        for _ in 0..500 {
            let plan = plan().expect("the plan must be buildable");
            let tiles = &plan.full_tiles;

            assert_eq!(tiles.len(), 14);
            assert_eq!(repeated_types(tiles), vec![plan.shapes.bulge[1]]);
            assert_eq!(count(tiles, plan.shapes.bulge[1]), 2);
            assert!(tiles.contains(&plan.value_honor));

            // The bulge is a real x, x+1, x+1, x+2.
            let bulge = plan.shapes.bulge;
            assert_eq!(gap(bulge[0], bulge[1]), Some(1));
            assert_eq!(bulge[1], bulge[2]);
            assert_eq!(gap(bulge[2], bulge[3]), Some(1));
            for tile in bulge {
                assert!(tiles.contains(&tile));
            }

            // Two side waits and one middle closed wait.
            assert_eq!(plan.shapes.ryanmen.len(), 2);
            for protorun in &plan.shapes.ryanmen {
                assert_eq!(gap(protorun[0], protorun[1]), Some(1));
            }
            assert_eq!(gap(plan.shapes.kanchan[0], plan.shapes.kanchan[1]), Some(2));

            // One wind float, one isolated terminal, one adjacent terminal.
            assert_eq!(plan.shapes.floats.len(), FLOATS);
            let wind = plan
                .shapes
                .floats
                .iter()
                .find(|tile| matches!(tile, Tile::Honor(_)))
                .expect("a wind float");
            let Tile::Honor(honor) = *wind else {
                unreachable!()
            };
            let wind = wind_from_honor(honor).expect("a wind");
            assert_ne!(wind, plan.round_wind);
            assert_ne!(wind, plan.human_wind);

            let terminal_floats: Vec<Tile> = plan
                .shapes
                .floats
                .iter()
                .copied()
                .filter(|tile| matches!(tile, Tile::Suited { value: 1 | 9, .. }))
                .collect();
            assert_eq!(terminal_floats.len(), 2);

            for terminal in terminal_floats {
                let others: Vec<Tile> = tiles
                    .iter()
                    .copied()
                    .filter(|tile| *tile != terminal)
                    .collect();
                // Only tiles of the terminal's own suit can be within reach.
                let nearest = others
                    .iter()
                    .filter_map(|other| gap(terminal, *other))
                    .min();
                match nearest {
                    Some(2) => saw_adjacent += 1,
                    Some(distance) => {
                        assert!(distance > 2, "{terminal} is {distance} from a block");
                        saw_isolated += 1;
                    }
                    None => saw_isolated += 1,
                }
            }

            // No terminal ever lives in a block, so the hand's two terminals
            // really are its two spare floats.
            let terminals = tiles
                .iter()
                .filter(|tile| matches!(tile, Tile::Suited { value: 1 | 9, .. }))
                .count();
            assert_eq!(terminals, 2);
        }

        assert!(saw_isolated > 0, "the 1m-style float must be generated");
        assert!(saw_adjacent > 0, "the 9p-style float must be generated");
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
