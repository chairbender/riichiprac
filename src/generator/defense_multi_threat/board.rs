//! Table assembly for the multi-threat defense drill.
//!
//! The board is built around a **threat set** rather than a single riichi
//! player:
//!
//! - two opponents in Riichi (ch. 8.3), or
//! - one Riichi plus a three-meld open hand that is really tenpai (ch. 8.4), or
//! - both at once: two Riichi declarations and a three-meld open hand.
//!
//! Every board reserves, before any random fill:
//!
//! 1. the **answer**, one of ch. 8:102–104's three kinds of tiles that are
//!    100% safe against *all* opponents;
//! 2. a **trap**, a hand tile that is 100% safe against one threat but live
//!    against another, so the drill shows why per-threat safety does not
//!    compose;
//! 3. the open hand's structure, its three melds' claimed copies, and the
//!    rivers that witness those claims.
//!
//! The fill then never hands the defender a second certifiably safe tile, and
//! the finished table is read back through [`MultiThreatFacts`] before it is
//! returned.

use std::collections::HashMap;

use agari::parse::to_counts;
use agari::shanten::{calculate_shanten_with_melds, calculate_ukeire_with_melds};
use agari::tile::{Suit, Tile};

use crate::generator::support::analysis::evaluate_counts;
use crate::generator::support::deck::{ALL_TILES, Deck};
use crate::generator::support::format::format_hand_compact;
use crate::generator::support::table::{
    RiverPlan, discards_from_tiles, force_tedashi, random_round, random_scores_with_human_first,
    self_turn_river_plan,
};
use crate::rng::{choose, gen_range, shuffle};
use crate::safety::{MultiThreatFacts, SafetyRank};
use crate::state::{
    CalledMeld, CorrectAction, DecisionContext, GameState, MeldType, PlayerState, TargetAction,
    Wind,
};

/// The hand must be 2-away or worse: the drill is a complete fold, the same
/// cell as ch. 8.3's betaori ("If you need to push when your hand is 2-away
/// from ready or worse, you can discard Rank B or safer tiles"), and with two
/// live opponents Rank B is no longer enough.
pub(super) const MIN_SHANTEN: i8 = 2;

/// Thirteen concealed tiles plus the draw.
const HAND_SIZE: usize = 13;

/// Ch. 8.4's own "assume ready" shortcut: "They have three or more open sets /
/// runs."
const OPEN_MELDS: usize = 3;

/// The lowest card index a river is allowed to fill before its claims. A trap
/// must sit in the threat's early river so that it precedes the other threat's
/// declaration discard; the minimum discard count keeps that true.
const MIN_RIVER: usize = 5;

/// Which threat combination the board presents.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Shape {
    /// Two opponents have declared Riichi.
    TwoRiichi,
    /// One Riichi and one three-meld open hand.
    RiichiAndOpenHand,
    /// Two Riichi declarations and a three-meld open hand.
    ThreeThreats,
}

impl Shape {
    fn sample() -> Self {
        match gen_range(0, 3) {
            0 => Shape::TwoRiichi,
            1 => Shape::RiichiAndOpenHand,
            _ => Shape::ThreeThreats,
        }
    }

    /// The shape's own name for the rationale and tests.
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Shape::TwoRiichi => "two_riichi",
            Shape::RiichiAndOpenHand => "riichi_and_open_hand",
            Shape::ThreeThreats => "three_threats",
        }
    }
}

/// Which of ch. 8's three 100%-safe-against-everyone kinds answers the board.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum AnswerMode {
    /// "A fourth honor tile when there is no possibility of Thirteen Orphans"
    /// (ch8:103): all four copies visible.
    FourthHonor,
    /// A tile every threat has already discarded, the footnote's "a tile
    /// discarded by all three of your opponents is safe against all three".
    EveryRiver,
    /// "The tile that was just discarded by your left player" (ch8:102): the
    /// furiten rule protects it against everyone for this turn.
    LeftDiscard,
}

impl AnswerMode {
    fn sample() -> Self {
        match gen_range(0, 3) {
            0 => AnswerMode::FourthHonor,
            1 => AnswerMode::EveryRiver,
            _ => AnswerMode::LeftDiscard,
        }
    }

    pub(super) fn as_str(self) -> &'static str {
        match self {
            AnswerMode::FourthHonor => "fourth_honor",
            AnswerMode::EveryRiver => "every_river",
            AnswerMode::LeftDiscard => "left_discard",
        }
    }

    /// How many copies the board needs: one in the hand plus the visible ones.
    fn copies(self, threats: usize) -> u8 {
        match self {
            AnswerMode::FourthHonor => 4,
            AnswerMode::EveryRiver => 1 + threats as u8,
            AnswerMode::LeftDiscard => 2,
        }
    }
}

/// One planned call: the meld and the copy that comes off the source's river.
#[derive(Debug, Clone)]
struct PlannedMeld {
    meld_type: MeldType,
    tiles: Vec<Tile>,
    claimed: Tile,
}

/// A three-meld open hand that is really tenpai.
#[derive(Debug, Clone)]
struct OpenHandPlan {
    seat: usize,
    /// The seat that plays immediately before the open hand; every call claims
    /// one of its discards, so the calls stay in the natural rotation.
    source: usize,
    melds: Vec<PlannedMeld>,
    /// Four tiles: a pair plus the protorun that is the wait.
    concealed: Vec<Tile>,
    /// The protorun's winning tiles.
    waits: Vec<Tile>,
    /// Every structural tile, so the answer cannot collide with the hand.
    reserved: Vec<Tile>,
}

/// Everything the table is built around, decided before a tile is dealt.
#[derive(Debug, Clone)]
struct Plan {
    shape: Shape,
    answer_mode: AnswerMode,
    answer: Tile,
    trap: Tile,
    /// The threat whose river shows the trap, making it that threat's genbutsu.
    trap_seat: usize,
    human_wind: Wind,
    round_wind: Wind,
    hand_number: u8,
    scores: [i32; 4],
    /// Seats in Riichi.
    riichi: Vec<usize>,
    /// The open-hand threat, when the shape has one.
    open: Option<OpenHandPlan>,
    /// Opponents that are neither in Riichi nor open.
    quiet: Vec<usize>,
    rivers: RiverPlan,
}

impl Plan {
    /// Every live opponent, in seat order.
    fn threat_seats(&self) -> Vec<usize> {
        let mut seats = self.riichi.clone();
        if let Some(open) = &self.open {
            seats.push(open.seat);
        }
        seats.sort_unstable();
        seats
    }
}

/// Builds one validated multi-threat board.
pub(super) fn build(category: &str) -> Result<GameState, String> {
    let plan = draw_plan()?;
    let threats = plan.threat_seats();
    if threats.len() < 2 {
        return Err("the multi-threat drill needs at least two live opponents".to_string());
    }

    let mut deck = Deck::fresh();

    // Reserve every structural tile before the random fill.
    for _ in 0..plan.answer_mode.copies(threats.len()) {
        deck.take(plan.answer)?;
    }
    deck.take(plan.trap)?;
    deck.take(plan.trap)?;
    if let Some(open) = &plan.open {
        for meld in &open.melds {
            for &tile in &meld.tiles {
                deck.take(tile)?;
            }
            deck.take(meld.claimed)?;
        }
        for &tile in &open.concealed {
            deck.take(tile)?;
        }
    }

    let counts = plan.rivers.counts;
    let mut slots: [Vec<Option<Tile>>; 4] = std::array::from_fn(|seat| vec![None; counts[seat]]);

    // The claims first: each meld takes a known discard at a known index.
    if let Some(open) = &plan.open {
        let calls: Vec<_> = plan
            .rivers
            .calls
            .iter()
            .filter(|call| call.caller == open.seat)
            .collect();
        if calls.len() != OPEN_MELDS {
            return Err(format!(
                "the open hand made {} calls, expected {OPEN_MELDS}",
                calls.len()
            ));
        }
        for (call, meld) in calls.iter().zip(&open.melds) {
            let slot = slots[call.source]
                .get_mut(call.index)
                .ok_or_else(|| "a planned claim falls outside its source's river".to_string())?;
            if slot.is_some() {
                return Err("two claims want the same river slot".to_string());
            }
            *slot = Some(meld.claimed);
        }
    }

    // The trap sits early in one threat's river, so it precedes the other
    // threat's declaration discard and cannot become post-riichi genbutsu.
    place_early(&mut slots[plan.trap_seat], plan.trap)?;

    // The answer's visible copies.
    match plan.answer_mode {
        AnswerMode::FourthHonor => {
            // One in each threat's river, plus a quiet opponent when the shape
            // has fewer than three threats. All four copies are then visible.
            let mut hosts = threats.clone();
            hosts.extend(plan.quiet.iter().copied());
            for &seat in hosts.iter().take(3) {
                place_early(&mut slots[seat], plan.answer)?;
            }
        }
        AnswerMode::EveryRiver => {
            for &seat in &threats {
                place_early(&mut slots[seat], plan.answer)?;
            }
        }
        AnswerMode::LeftDiscard => {
            let slot = slots[3]
                .last_mut()
                .ok_or_else(|| "the left player has no river".to_string())?;
            if slot.is_some() {
                return Err("the left player's last discard is already claimed".to_string());
            }
            *slot = Some(plan.answer);
        }
    }

    // Everything still empty is a random discard. The answer and the trap are
    // kept out of the random fill so their visibility counts stay exactly what
    // the plan promised.
    let excluded = [plan.answer, plan.trap];
    for river in slots.iter_mut() {
        for slot in river.iter_mut() {
            if slot.is_some() {
                continue;
            }
            *slot = Some(draw_one(&mut deck, &excluded)?);
        }
    }

    let mut rivers: [Vec<Tile>; 4] = std::array::from_fn(|_| Vec::new());
    for (river, filled) in rivers.iter_mut().zip(slots.iter()) {
        *river = filled
            .iter()
            .map(|tile| tile.expect("every river slot is filled"))
            .collect();
    }

    // Opponent hands. The open hand keeps its structural four.
    let mut players: Vec<PlayerState> = Vec::with_capacity(4);
    for seat in 1..4 {
        let (hand, melds) = match &plan.open {
            Some(open) if open.seat == seat => (
                open.concealed.clone(),
                open.melds
                    .iter()
                    .map(|meld| called_meld(meld, open.source))
                    .collect(),
            ),
            _ => (
                deck.draw_n(HAND_SIZE)
                    .ok_or_else(|| "deck exhausted dealing an opponent".to_string())?,
                Vec::new(),
            ),
        };

        let mut discards = discards_from_tiles(&rivers[seat]);
        force_tedashi(&mut discards, &plan.rivers.hand_discards[seat]);

        let is_riichi = plan.riichi.contains(&seat);
        if is_riichi {
            let last = discards
                .len()
                .checked_sub(1)
                .ok_or_else(|| "a Riichi player has no discard to declare on".to_string())?;
            discards[last].is_riichi = true;
            discards[last].is_tsumogiri = false;
        }

        players.push(PlayerState {
            seat,
            name: seat_name(seat).to_string(),
            is_human: false,
            wind: plan.human_wind.next(seat),
            score: plan.scores[seat],
            hand: hand.iter().map(ToString::to_string).collect(),
            draw: None,
            red_fives: Vec::new(),
            discards,
            melds,
            is_riichi,
            riichi_discard_index: is_riichi.then(|| rivers[seat].len() - 1),
        });
    }

    let dora_indicator = draw_one(&mut deck, &excluded)?;
    let ura_indicator = draw_one(&mut deck, &[])?;

    let mut human_discards = discards_from_tiles(&rivers[0]);
    force_tedashi(&mut human_discards, &plan.rivers.hand_discards[0]);

    let human_wind = plan.human_wind;
    players.insert(
        0,
        PlayerState {
            seat: 0,
            name: "You".to_string(),
            is_human: true,
            wind: human_wind,
            score: plan.scores[0],
            hand: Vec::new(),
            draw: None,
            red_fives: Vec::new(),
            discards: human_discards,
            melds: Vec::new(),
            is_riichi: false,
            riichi_discard_index: None,
        },
    );
    players.sort_by_key(|player| player.seat);

    let mut state = GameState {
        category: category.to_string(),
        target_action: TargetAction::Defend,
        correct_action: CorrectAction::fold(plan.answer.to_string()),
        equivalent_tiles: Vec::new(),
        decision: DecisionContext::SelfTurn,
        scenario_note: None,
        call_offer: None,
        ai_decision: None,
        riichi_triggers: Vec::new(),
        dama_reasons: Vec::new(),
        shouminkan_triggers: Vec::new(),
        book_rationale: None,
        can_riichi: false,
        hand_string: String::new(),
        tiles: Vec::new(),
        shanten: MIN_SHANTEN,
        is_agari: false,
        decompositions_count: 0,
        ukeire_tiles: Vec::new(),
        ukeire_total: 0,
        round_wind: plan.round_wind,
        hand_number: plan.hand_number,
        honba: gen_range(0, 4) as u8,
        riichi_sticks: 1,
        dora_indicators: vec![dora_indicator.to_string()],
        ura_dora_indicators: vec![ura_indicator.to_string()],
        tiles_remaining: 0,
        current_turn: 0,
        players,
    };

    // Fill the hand around the answer and the trap. Every candidate is checked
    // against the finished table's own multi-threat read, so no second certain
    // safe tile can slip in through a blockade, a dead honor, or a shared
    // river.
    let mut hand = vec![plan.answer, plan.trap];
    while hand.len() < HAND_SIZE {
        let tile = pick_filler(&deck, &state, &threats, &hand, plan.answer, &excluded)
            .ok_or_else(|| "no dangerous filler tile is left".to_string())?;
        state.players[0].hand = hand.iter().map(ToString::to_string).collect();
        deck.take(tile)?;
        hand.push(tile);
    }
    state.players[0].hand = hand.iter().map(ToString::to_string).collect();

    let draw = pick_filler(&deck, &state, &threats, &hand, plan.answer, &excluded)
        .ok_or_else(|| "no dangerous draw tile is left".to_string())?;
    deck.take(draw)?;
    state.players[0].draw = Some(draw.to_string());

    let mut full_tiles = hand;
    full_tiles.push(draw);
    full_tiles.sort();

    let metrics = evaluate_counts(&to_counts(&full_tiles));
    if metrics.shanten < MIN_SHANTEN {
        return Err(format!(
            "the defender's hand must be at least {MIN_SHANTEN}-away, got {}",
            metrics.shanten
        ));
    }
    if metrics.is_agari {
        return Err("the defender's hand cannot be a winning hand".to_string());
    }

    state.hand_string = format_hand_compact(&full_tiles);
    state.tiles = full_tiles.iter().map(ToString::to_string).collect();
    state.shanten = metrics.shanten;
    state.is_agari = metrics.is_agari;
    state.decompositions_count = metrics.decompositions_count;
    state.ukeire_tiles = metrics.ukeire_tiles;
    state.ukeire_total = metrics.ukeire_total;
    state.tiles_remaining = deck.remaining().saturating_sub(12).min(u8::MAX as usize) as u8;
    if state.tiles_remaining == 0 {
        return Err("no drawable tiles remain".to_string());
    }

    validate(&state, &plan)?;
    Ok(state)
}

/// Samples the threat set, the answer, the trap and the table around them.
fn draw_plan() -> Result<Plan, String> {
    let shape = Shape::sample();

    let mut seats = vec![1usize, 2, 3];
    shuffle(&mut seats);
    let (riichi, open_seat) = match shape {
        Shape::TwoRiichi => (vec![seats[0], seats[1]], None),
        Shape::RiichiAndOpenHand => (vec![seats[0]], Some(seats[1])),
        Shape::ThreeThreats => (vec![seats[0], seats[1]], Some(seats[2])),
    };
    let quiet: Vec<usize> = (1..4)
        .filter(|seat| !riichi.contains(seat) && Some(*seat) != open_seat)
        .collect();
    let mut riichi = riichi;
    riichi.sort_unstable();

    let human_wind = choose(&Wind::ALL).ok_or_else(|| "no seat wind available".to_string())?;
    let (round_wind, hand_number) = random_round();
    let scores = random_scores_with_human_first();

    // The open hand decides which tiles are live waits, so plan it before the
    // answer and the trap.
    let open = match open_seat {
        Some(seat) => Some(plan_open_hand(seat)?),
        None => None,
    };
    let open_reserved: Vec<Tile> = open
        .as_ref()
        .map(|open| open.reserved.clone())
        .unwrap_or_default();

    // The trap: a wait of the open hand (a live winning tile read from the
    // outside) or, on the two-Riichi table, any number tile. It is planted in a
    // Riichi threat's river, so it is that threat's genbutsu and nothing else.
    let (trap, trap_seat) = match &open {
        Some(open) => {
            let trap = choose(&open.waits)
                .ok_or_else(|| "the open hand has no winning tile".to_string())?;
            let seat = *riichi
                .iter()
                .find(|seat| **seat != open.source)
                .or_else(|| riichi.first())
                .ok_or_else(|| "the open-hand shape needs a Riichi threat".to_string())?;
            (trap, seat)
        }
        None => {
            let suited: Vec<Tile> = ALL_TILES
                .iter()
                .copied()
                .filter(|tile| !tile.is_honor())
                .collect();
            let trap = choose(&suited).ok_or_else(|| "no trap tile available".to_string())?;
            (trap, riichi[0])
        }
    };

    let answer_mode = AnswerMode::sample();
    let answer = plan_answer(answer_mode, trap, &open_reserved, &open_waits(&open))?;

    let calls: Vec<(usize, usize)> = open
        .as_ref()
        .map(|open| vec![(open.seat, open.source); OPEN_MELDS])
        .unwrap_or_default();
    let rivers = self_turn_river_plan(human_wind, &calls, gen_range(MIN_RIVER, MIN_RIVER + 3));

    Ok(Plan {
        shape,
        answer_mode,
        answer,
        trap,
        trap_seat,
        human_wind,
        round_wind,
        hand_number,
        scores,
        riichi,
        open,
        quiet,
        rivers,
    })
}

/// The open hand's winning tiles, if there is one.
fn open_waits(open: &Option<OpenHandPlan>) -> Vec<Tile> {
    open.as_ref()
        .map(|open| open.waits.clone())
        .unwrap_or_default()
}

/// Picks the answer tile: one of ch. 8's three safe-against-everyone kinds.
fn plan_answer(
    mode: AnswerMode,
    trap: Tile,
    reserved: &[Tile],
    waits: &[Tile],
) -> Result<Tile, String> {
    let mut pool: Vec<Tile> = ALL_TILES
        .iter()
        .copied()
        .filter(|tile| *tile != trap)
        .filter(|tile| !reserved.contains(tile))
        .filter(|tile| !waits.contains(tile))
        .filter(|tile| match mode {
            // A fourth honor needs an honor; the other kinds are cleanest on a
            // number tile (an honor's chart row already depends on copies).
            AnswerMode::FourthHonor => tile.is_honor(),
            _ => !tile.is_honor(),
        })
        .collect();
    shuffle(&mut pool);
    pool.first()
        .copied()
        .ok_or_else(|| format!("no answer tile fits {:?}", mode.as_str()))
}

/// Plans a three-meld open hand whose wait is the trap.
fn plan_open_hand(seat: usize) -> Result<OpenHandPlan, String> {
    let source = (seat + 3) % 4;

    for _attempt in 0..120 {
        let mut protoruns = Vec::new();
        for suit in [Suit::Man, Suit::Pin, Suit::Sou] {
            for start in 1..=8u8 {
                for step in [1u8, 2] {
                    let second = start + step;
                    if second > 9 {
                        continue;
                    }
                    let waits: Vec<Tile> = protorun_waits(start, step)
                        .into_iter()
                        .map(|value| Tile::suited(suit, value))
                        .collect();
                    if waits.is_empty() {
                        continue;
                    }
                    protoruns.push((Tile::suited(suit, start), Tile::suited(suit, second), waits));
                }
            }
        }
        shuffle(&mut protoruns);

        let (first, second, waits) = protoruns
            .pop()
            .ok_or_else(|| "no protorun fits the open hand".to_string())?;
        let mut counts: HashMap<Tile, u8> = HashMap::new();
        for tile in [first, second] {
            counts.insert(tile, 1);
        }

        // The head: a pair that is not part of the wait.
        let mut pairs: Vec<Tile> = ALL_TILES
            .iter()
            .copied()
            .filter(|tile| !waits.contains(tile) && *tile != first && *tile != second)
            .collect();
        shuffle(&mut pairs);
        let Some(pair) = pairs.first().copied() else {
            continue;
        };
        counts.insert(pair, 2);

        // Three melds that share nothing with the wait or the head. A chi can
        // claim any rank, a pon needs all four copies (three in the meld plus
        // the one off the river).
        let mut melds: Vec<PlannedMeld> = Vec::new();
        let mut candidates = meld_candidates();
        shuffle(&mut candidates);
        for candidate in candidates {
            if melds.len() == OPEN_MELDS {
                break;
            }
            if candidate
                .tiles
                .iter()
                .any(|tile| waits.contains(tile) || *tile == pair)
            {
                continue;
            }
            let mut trial = counts.clone();
            let mut fits = true;
            for &tile in &candidate.tiles {
                let entry = trial.entry(tile).or_insert(0);
                *entry += 1;
                if *entry > 4 {
                    fits = false;
                    break;
                }
            }
            if fits {
                let entry = trial.entry(candidate.claimed).or_insert(0);
                *entry += 1;
                if *entry > 4 {
                    fits = false;
                }
            }
            if !fits {
                continue;
            }
            counts = trial;
            melds.push(candidate);
        }
        if melds.len() != OPEN_MELDS {
            continue;
        }

        let concealed = vec![pair, pair, first, second];
        let shanten =
            calculate_shanten_with_melds(&to_counts(&concealed), OPEN_MELDS as u8).shanten;
        if shanten != 0 {
            continue;
        }

        let mut reserved = concealed.clone();
        reserved.extend(waits.iter().copied());
        for meld in &melds {
            reserved.extend(meld.tiles.iter().copied());
            reserved.push(meld.claimed);
        }
        reserved.sort();
        reserved.dedup();

        return Ok(OpenHandPlan {
            seat,
            source,
            melds,
            concealed,
            waits,
            reserved,
        });
    }

    Err("no open-hand structure fits the table".to_string())
}

/// Every legal open meld the planner may use.
fn meld_candidates() -> Vec<PlannedMeld> {
    let mut candidates = Vec::new();

    for suit in [Suit::Man, Suit::Pin, Suit::Sou] {
        for start in 1..=7u8 {
            let tiles = vec![
                Tile::suited(suit, start),
                Tile::suited(suit, start + 1),
                Tile::suited(suit, start + 2),
            ];
            // Any rank of a chi can be the claimed tile.
            for &claimed in &tiles {
                candidates.push(PlannedMeld {
                    meld_type: MeldType::Chi,
                    tiles: tiles.clone(),
                    claimed,
                });
            }
        }
    }

    for &tile in ALL_TILES.iter() {
        candidates.push(PlannedMeld {
            meld_type: MeldType::Pon,
            tiles: vec![tile, tile, tile],
            claimed: tile,
        });
    }

    candidates
}

/// The winning ranks of a two-tile protorun.
fn protorun_waits(start: u8, step: u8) -> Vec<u8> {
    match step {
        1 if start == 1 => vec![3],
        1 if start == 8 => vec![7],
        1 => vec![start - 1, start + 2],
        2 => vec![start + 1],
        _ => Vec::new(),
    }
}

fn called_meld(planned: &PlannedMeld, source: usize) -> CalledMeld {
    let mut tiles = planned.tiles.clone();
    tiles.sort();
    CalledMeld {
        meld_type: planned.meld_type,
        tiles: tiles.iter().map(ToString::to_string).collect(),
        called_from: Some(source),
    }
}

/// Places `tile` at the earliest free index of `river`, preferring the book's
/// "early turns" slots so a trap precedes every declaration discard.
fn place_early(river: &mut [Option<Tile>], tile: Tile) -> Result<usize, String> {
    let earliest_free = (0..river.len())
        .find(|index| river[*index].is_none())
        .ok_or_else(|| format!("no free river slot for {tile}"))?;
    // `earliest_free` is naturally the safest slot; the constant documents the
    // window the trap needs to stay inside.
    if earliest_free > MIN_RIVER {
        return Err(format!(
            "the structural tile {tile} would sit too late in the river ({earliest_free})"
        ));
    }
    river[earliest_free] = Some(tile);
    Ok(earliest_free)
}

fn draw_one(deck: &mut Deck, excluded: &[Tile]) -> Result<Tile, String> {
    deck.draw_excluding(1, excluded)
        .and_then(|mut tiles| tiles.pop())
        .ok_or_else(|| "deck exhausted".to_string())
}

/// Picks a filler the finished table reads as dangerous to at least one live
/// opponent, while leaving the answer as the only certain-safe hand tile.
fn pick_filler(
    deck: &Deck,
    state: &GameState,
    threats: &[usize],
    hand: &[Tile],
    answer: Tile,
    excluded: &[Tile],
) -> Option<Tile> {
    let mut pool: Vec<Tile> = ALL_TILES
        .iter()
        .copied()
        .filter(|tile| deck.has(*tile))
        .filter(|tile| !excluded.contains(tile))
        .collect();
    shuffle(&mut pool);

    pool.into_iter()
        .find(|tile| filler_is_legal(state, threats, hand, answer, *tile))
}

/// True when adding `tile` to `hand` leaves exactly one certain-safe tile, the
/// answer, and the candidate is genuinely dangerous to somebody.
fn filler_is_legal(
    state: &GameState,
    threats: &[usize],
    hand: &[Tile],
    answer: Tile,
    tile: Tile,
) -> bool {
    let mut trial = state.clone();
    trial.players[0].hand = hand
        .iter()
        .copied()
        .chain(std::iter::once(tile))
        .map(|tile| tile.to_string())
        .collect();

    let Some(facts) = MultiThreatFacts::from_state(&trial, threats) else {
        return false;
    };

    // The candidate must be dangerous to the opponent who fears it most: Rank B
    // or worse is the band a fold-only hand cannot use to push (ch8:36's
    // "Rank B or safer" is the 2-away push line; a hand that is only Rank CC+
    // against somebody has no push tile there).
    if facts.worst_rank(tile).order() < SafetyRank::B.order() {
        return false;
    }

    let mut all: Vec<Tile> = hand.iter().copied().chain(std::iter::once(tile)).collect();
    all.sort();
    all.dedup();

    // Exactly one tile (the answer) may be certain safe.
    let safe: Vec<Tile> = all
        .into_iter()
        .filter(|candidate| facts.is_certain_safe(*candidate))
        .collect();
    safe == vec![answer]
}

fn seat_name(seat: usize) -> &'static str {
    match seat {
        1 => "Shimocha",
        2 => "Toimen",
        _ => "Kamicha",
    }
}

/// Re-derives every promise from the finished table.
fn validate(state: &GameState, plan: &Plan) -> Result<(), String> {
    let human = state
        .players
        .iter()
        .find(|player| player.is_human)
        .ok_or_else(|| "no human player".to_string())?;
    if !human.melds.is_empty() || human.is_riichi {
        return Err("the defender must be concealed and not in Riichi".to_string());
    }
    if human.hand.len() != HAND_SIZE || human.draw.is_none() {
        return Err("the defender must hold thirteen tiles plus the draw".to_string());
    }
    if state.shanten < MIN_SHANTEN {
        return Err(format!(
            "the defender must be at least {MIN_SHANTEN}-away, got {}",
            state.shanten
        ));
    }

    let threats = plan.threat_seats();
    if threats.len() < 2 {
        return Err("the drill needs at least two live opponents".to_string());
    }

    let riichi: Vec<usize> = state
        .players
        .iter()
        .filter(|player| !player.is_human && player.is_riichi)
        .map(|player| player.seat)
        .collect();
    let open: Vec<usize> = state
        .players
        .iter()
        .filter(|player| !player.is_human && player.melds.len() >= OPEN_MELDS)
        .map(|player| player.seat)
        .collect();
    if riichi != plan.riichi {
        return Err(format!(
            "{:?} has Riichi at {:?}, planned {:?}",
            plan.shape.as_str(),
            riichi,
            plan.riichi
        ));
    }
    match plan.shape {
        Shape::TwoRiichi => {
            if !open.is_empty() {
                return Err("the two-Riichi shape has an open hand".to_string());
            }
        }
        Shape::RiichiAndOpenHand => {
            if riichi.len() != 1 || open.len() != 1 {
                return Err(format!(
                    "the Riichi-and-open shape needs one of each, got {riichi:?} / {open:?}"
                ));
            }
        }
        Shape::ThreeThreats => {
            if riichi.len() != 2 || open.len() != 1 {
                return Err(format!(
                    "the three-threat shape needs two Riichi and one open hand, got {riichi:?} / {open:?}"
                ));
            }
        }
    }

    let facts = MultiThreatFacts::from_state(state, &threats)
        .ok_or_else(|| "no multi-threat safety facts".to_string())?;

    let mut hand_tiles: Vec<Tile> = human
        .hand
        .iter()
        .chain(human.draw.iter())
        .map(|code| Tile::try_from(code.as_str()).map_err(|err| err.to_string()))
        .collect::<Result<_, _>>()?;
    if hand_tiles.len() != 14 {
        return Err(format!("the defender holds {} tiles", hand_tiles.len()));
    }
    hand_tiles.sort();
    hand_tiles.dedup();

    let safe: Vec<Tile> = hand_tiles
        .iter()
        .copied()
        .filter(|tile| facts.is_certain_safe(*tile))
        .collect();
    if safe != vec![plan.answer] {
        return Err(format!(
            "the hand's certain-safe tiles are {safe:?}, expected only {}",
            plan.answer
        ));
    }
    if !human
        .hand
        .iter()
        .any(|code| code == &plan.answer.to_string())
    {
        return Err("the answer must be in the hand, not only on the table".to_string());
    }

    // The trap: safe against at least one threat, live against at least one.
    let trap_safe = facts.safe_seats(plan.trap);
    if trap_safe.is_empty() || trap_safe.len() == threats.len() {
        return Err(format!(
            "the trap {} must trade one threat's safety for another's danger, got {trap_safe:?}",
            plan.trap
        ));
    }
    if !hand_tiles.contains(&plan.trap) {
        return Err("the trap must be a tile the defender holds".to_string());
    }

    if let Some(open) = &plan.open {
        let player = state
            .players
            .iter()
            .find(|player| player.seat == open.seat)
            .ok_or_else(|| "no open-hand player".to_string())?;
        if player.melds.len() != OPEN_MELDS {
            return Err(format!(
                "the open hand has {} melds, expected {OPEN_MELDS}",
                player.melds.len()
            ));
        }
        if player.hand.len() != 4 {
            return Err("the open hand must keep four concealed tiles".to_string());
        }
        let concealed: Vec<Tile> = player
            .hand
            .iter()
            .map(|code| Tile::try_from(code.as_str()).map_err(|err| err.to_string()))
            .collect::<Result<_, _>>()?;
        if calculate_shanten_with_melds(&to_counts(&concealed), OPEN_MELDS as u8).shanten != 0 {
            return Err("the open hand must really be tenpai".to_string());
        }
        let waits: Vec<Tile> =
            calculate_ukeire_with_melds(&to_counts(&concealed), OPEN_MELDS as u8)
                .tiles
                .iter()
                .map(|entry| entry.tile)
                .collect();
        if !waits.contains(&plan.trap) {
            return Err(format!(
                "the trap {} must be one of the open hand's winning tiles {waits:?}",
                plan.trap
            ));
        }
        if waits.contains(&plan.answer) {
            return Err("the answer cannot be a winning tile of the open hand".to_string());
        }
    }

    // Every claim needs a river to back it, and the table must be reachable.
    crate::generator::support::state_validation::validate_reachable_state(state)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::generate;
    use super::*;
    use crate::state::CorrectActionType;

    fn answer_tile(state: &GameState) -> Tile {
        Tile::try_from(state.correct_action.tile().expect("answer tile"))
            .expect("answer must parse")
    }

    fn human(state: &GameState) -> &PlayerState {
        state
            .players
            .iter()
            .find(|player| player.is_human)
            .expect("human player")
    }

    fn threats(state: &GameState) -> Vec<usize> {
        state
            .players
            .iter()
            .filter(|player| !player.is_human && (player.is_riichi || player.melds.len() >= 3))
            .map(|player| player.seat)
            .collect()
    }

    fn assert_board(state: &GameState) {
        assert_eq!(state.category, "defense_multi_threat");
        assert_eq!(state.target_action, TargetAction::Defend);
        assert_eq!(state.correct_action.action_type(), CorrectActionType::Fold);
        assert_eq!(state.players.len(), 4);
        assert_eq!(state.decision, DecisionContext::SelfTurn);
        assert_eq!(state.current_turn, 0);
        assert!(state.tiles_remaining > 0);
        assert!(state.book_rationale.is_none(), "finalize stamps it later");

        let human = human(state);
        assert!(human.is_human);
        assert_eq!(human.hand.len(), 13);
        assert!(human.draw.is_some());
        assert!(human.melds.is_empty());
        assert!(!human.is_riichi);
        assert_eq!(state.tiles.len(), 14);
        assert!(state.shanten >= MIN_SHANTEN);
        assert!(!state.is_agari);

        let threat_seats = threats(state);
        assert!(
            threat_seats.len() >= 2,
            "a multi-threat board needs two live opponents"
        );

        let answer = answer_tile(state);
        assert!(human.hand.contains(&answer.to_string()));
        assert_ne!(human.draw, Some(answer.to_string()));

        let facts = MultiThreatFacts::from_state(state, &threat_seats).expect("facts");
        let mut distinct: Vec<Tile> = state
            .tiles
            .iter()
            .filter_map(|code| Tile::try_from(code.as_str()).ok())
            .collect();
        distinct.sort();
        distinct.dedup();
        let safe: Vec<Tile> = distinct
            .iter()
            .copied()
            .filter(|tile| facts.is_certain_safe(*tile))
            .collect();
        assert_eq!(
            safe,
            vec![answer],
            "the answer must be the only certain tile"
        );

        // The trap is what makes the lesson a multi-threat read: safe for one
        // live opponent and live for another.
        let trap: Vec<Tile> = distinct
            .iter()
            .copied()
            .filter(|tile| *tile != answer)
            .filter(|tile| {
                let safe_seats = facts.safe_seats(*tile);
                !safe_seats.is_empty() && safe_seats.len() < threat_seats.len()
            })
            .collect();
        assert!(
            !trap.is_empty(),
            "the board must hold a per-threat trap tile"
        );

        assert!(state.equivalent_tiles.is_empty());
    }

    #[test]
    fn test_generate_multi_threat() {
        let state = generate("defense_multi_threat").expect("generation must succeed");
        assert_board(&state);
    }

    #[test]
    fn test_multi_threat_constraints_runs() {
        for run in 0..120 {
            let state = generate("defense_multi_threat")
                .unwrap_or_else(|err| panic!("run {run} failed: {err}"));
            assert_board(&state);
        }
    }

    #[test]
    fn every_shape_appears() {
        let mut two_riichi = 0;
        let mut riichi_open = 0;
        let mut three = 0;
        for _ in 0..200 {
            let state = generate("defense_multi_threat").expect("generate");
            let riichi = state
                .players
                .iter()
                .filter(|player| !player.is_human && player.is_riichi)
                .count();
            let open = state
                .players
                .iter()
                .filter(|player| !player.is_human && player.melds.len() >= OPEN_MELDS)
                .count();
            match (riichi, open) {
                (2, 0) => two_riichi += 1,
                (1, 1) => riichi_open += 1,
                (2, 1) => three += 1,
                other => panic!("unexpected threat shape {other:?}"),
            }
        }
        assert!(
            two_riichi > 10,
            "two-Riichi table appeared {two_riichi} times"
        );
        assert!(
            riichi_open > 10,
            "Riichi-plus-open table appeared {riichi_open} times"
        );
        assert!(three > 10, "three-threat table appeared {three} times");
    }

    #[test]
    fn repeated_generation_does_not_repeat_the_visible_table() {
        use std::collections::HashSet;

        let mut seen = HashSet::new();
        for run in 0..80 {
            let state = generate("defense_multi_threat").expect("generate");
            let mut key = state.tiles.join(",");
            for player in &state.players {
                key.push('|');
                key.push_str(&player.hand.join(","));
                key.push('/');
                key.push_str(&player.draw.clone().unwrap_or_default());
                key.push('/');
                key.push_str(
                    &player
                        .discards
                        .iter()
                        .map(|discard| discard.tile.as_str())
                        .collect::<Vec<_>>()
                        .join(","),
                );
                key.push('/');
                key.push_str("melds:");
                for meld in &player.melds {
                    key.push_str(&format!("{:?}:{};", meld.meld_type, meld.tiles.join(",")));
                }
            }
            assert!(seen.insert(key), "run {run} repeated a visible table");
        }
    }

    #[test]
    fn every_answer_mode_appears() {
        let mut honour = 0;
        let mut every_river = 0;
        let mut left = 0;
        for _ in 0..180 {
            let state = generate("defense_multi_threat").expect("generate");
            let answer = answer_tile(&state);
            let threat_seats = threats(&state);
            let facts = MultiThreatFacts::from_state(&state, &threat_seats).expect("facts");

            if answer.is_honor() {
                honour += 1;
            } else if facts
                .threats
                .iter()
                .all(|threat| threat.facts.genbutsu.contains(&answer))
            {
                every_river += 1;
            } else {
                left += 1;
                assert_eq!(
                    state.players[3]
                        .discards
                        .last()
                        .map(|discard| discard.tile.as_str()),
                    Some(answer.to_string().as_str()),
                    "the left-discard answer must be Kamicha's last discard"
                );
            }
        }
        assert!(honour > 5, "fourth-honor answer appeared {honour} times");
        assert!(
            every_river > 5,
            "every-river answer appeared {every_river} times"
        );
        assert!(left > 5, "left-discard answer appeared {left} times");
    }

    #[test]
    fn the_open_hand_is_a_real_tenpai_with_a_claim_behind_every_meld() {
        let mut checked = 0;
        for _ in 0..120 {
            let state = generate("defense_multi_threat").expect("generate");
            let Some(open) = state
                .players
                .iter()
                .find(|player| !player.is_human && player.melds.len() >= OPEN_MELDS)
            else {
                continue;
            };
            checked += 1;
            let concealed: Vec<Tile> = open
                .hand
                .iter()
                .map(|code| Tile::try_from(code.as_str()).expect("tile"))
                .collect();
            assert_eq!(
                calculate_shanten_with_melds(&to_counts(&concealed), OPEN_MELDS as u8).shanten,
                0
            );

            let source = (open.seat + 3) % 4;
            let river = &state.players[source].discards;
            let mut used = vec![false; river.len()];
            for meld in &open.melds {
                assert_eq!(meld.called_from, Some(source));
                let tiles: Vec<Tile> = meld
                    .tiles
                    .iter()
                    .map(|code| Tile::try_from(code.as_str()).expect("tile"))
                    .collect();
                let claimable = |tile: Tile| match meld.meld_type {
                    MeldType::Chi => tiles.contains(&tile),
                    _ => tiles.first() == Some(&tile),
                };
                let slot = river
                    .iter()
                    .enumerate()
                    .position(|(index, discard)| {
                        !used[index]
                            && claimable(
                                Tile::try_from(discard.tile.as_str()).expect("discard tile"),
                            )
                    })
                    .unwrap_or_else(|| {
                        panic!("no river entry backs the {:?} {tiles:?}", meld.meld_type)
                    });
                used[slot] = true;
            }
        }
        assert!(checked > 30, "the open-hand shape must be covered");
    }
}
