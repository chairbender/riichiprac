//! Table assembly for the fold-to-Riichi lesson.
//!
//! The board is built around two facts the generator must own completely:
//!
//! - the threat has declared Riichi on its latest discard, from a deep river
//!   (the chapter's turn discussion counts how few suji a thin river has
//!   denied, ch8:382-389);
//! - the learner's hand holds exactly one tile that the book calls 100% safe,
//!   and that tile sits inside a pair, a protorun, or a run.
//!
//! Everything else is constructed so the chart's answer is forced. Every hand
//! tile type is kept out of every river except the answer, so no second tile
//! can be genbutsu; the dora is kept off the hand, and the suited blocks span
//! two suits, so the hand is the "low scoring hand" of ch8:35. The safety table
//! then confirms the answer, and the board is re-derived from the finished
//! state before it is returned ([`validate`]).
//!
//! `GameState::shanten` is the displayed fourteen tiles' shanten, as in every
//! other lesson; the generator additionally requires the thirteen tiles the
//! learner keeps after the fold to be 2-away or worse, which is the book's
//! "1-away (or worse) hand" condition (ch8:34).

use std::collections::HashSet;

use agari::context::indicator_to_dora;
use agari::parse::to_counts;
use agari::shanten::{calculate_shanten, calculate_ukeire};
use agari::tile::{Honor, Suit, Tile};

use super::skeleton::{BlockKind, Skeleton};
use crate::generator::support::analysis::evaluate_counts;
use crate::generator::support::deck::{ALL_TILES, Deck};
use crate::generator::support::format::format_hand_compact;
use crate::generator::support::table::{
    RiverPlan, discards_from_tiles, force_tedashi, random_round, random_scores_with_human_first,
    self_turn_river_plan,
};
use crate::rng::{choose, gen_bool, gen_range, shuffle};
use crate::safety::{EARLY_TURN_LIMIT, SafetyFacts, SafetyRank};
use crate::state::{CorrectAction, DecisionContext, GameState, PlayerState, TargetAction, Wind};

/// The book's fold condition: "1-away (or worse) hand" (ch8:34).
const FOLD_SHANTEN: i8 = 2;

/// How many discards the threat must already have made.
///
/// Ch. 8's turn discussion (ch8:382-389) counts how much of the suji defence a
/// thin river has not denied yet: early on, 16 of 18 suji are still alive. A
/// one-discard river therefore gives the defender almost nothing to read, so
/// the board always starts from a deep one.
const MIN_THREAT_RIVER: usize = 8;

/// Builds one complete, validated fold board.
pub(super) fn build(category: &str, skeleton: &Skeleton) -> Result<GameState, String> {
    let (round_wind, hand_number) = random_round();
    let honba = gen_range(0, 4) as u8;
    let scores = random_scores_with_human_first();
    let human_wind = choose(&Wind::ALL).ok_or_else(|| "no seat wind available".to_string())?;
    let threat_seat = gen_range(1, 4);

    let mut deck = Deck::fresh();

    // The learner's hand first: it owns the answer and its block, so nothing
    // later can consume one of their copies.
    let (concealed, draw) = build_human_hand(&mut deck, skeleton)?;
    let mut human_full = concealed.clone();
    human_full.push(draw);
    let human_types = unique(human_full.iter().copied());

    // The threat really is tenpai on the declaration, and never on the safe
    // tile (a genbutsu tile of a furiten riichi hand would be a weaker lesson).
    let threat_hand = build_threat_hand(&mut deck, skeleton.answer)?;

    let plan = self_turn_river_plan(human_wind, &[], MIN_THREAT_RIVER);
    let counts = plan.counts;

    // Half the boards plant the safe tile in the threat's early river, where the
    // chapter's early-discard reads live; the other half make it the declaration
    // tile itself, which is also the tile Kamicha "has just discarded" whenever
    // the threat is Kamicha (ch8:102).
    let declare_on_answer = gen_bool(0.5);
    let threat_river = build_threat_river(
        &mut deck,
        skeleton.answer,
        &human_types,
        counts[threat_seat],
        declare_on_answer,
    )?;
    let human_river = deck
        .draw_excluding(counts[0], &human_types)
        .ok_or_else(|| "deck exhausted drawing the human river".to_string())?;

    let mut players = Vec::with_capacity(4);
    players.push(human_player(
        human_wind,
        scores[0],
        &concealed,
        draw,
        &human_river,
        &plan,
    ));

    let opponent_meta = [(1usize, "Shimocha"), (2, "Toimen"), (3, "Kamicha")];
    for (seat, name) in opponent_meta {
        if seat == threat_seat {
            players.push(threat_player(
                seat,
                name,
                human_wind,
                scores[seat],
                &threat_hand,
                &threat_river,
                &plan,
            ));
            continue;
        }

        let hand = deck
            .draw_n(13)
            .ok_or_else(|| "deck exhausted dealing an opponent".to_string())?;
        let river = deck
            .draw_excluding(counts[seat], &human_types)
            .ok_or_else(|| "deck exhausted drawing an opponent river".to_string())?;
        let mut discards = discards_from_tiles(&river);
        force_tedashi(&mut discards, &plan.hand_discards[seat]);

        players.push(PlayerState {
            seat,
            name: name.to_string(),
            is_human: false,
            wind: human_wind.next(seat),
            score: scores[seat],
            hand: hand.iter().map(ToString::to_string).collect(),
            draw: None,
            red_fives: Vec::new(),
            discards,
            melds: Vec::new(),
            is_riichi: false,
            riichi_discard_index: None,
        });
    }
    players.sort_by_key(|player| player.seat);

    // The dora is off the hand: a hand whose minimum value is 7700 is a push,
    // not a fold (ch8:65), and the lesson must stay a pure safety question.
    let dora_indicator = draw_dora(&mut deck, &human_types)?;
    let ura_indicator = deck
        .draw()
        .ok_or_else(|| "deck exhausted drawing the ura indicator".to_string())?;

    let mut full_tiles = human_full.clone();
    full_tiles.sort();
    let metrics = evaluate_counts(&to_counts(&full_tiles));
    if metrics.shanten != FOLD_SHANTEN {
        return Err(format!(
            "the displayed hand must be {FOLD_SHANTEN}-away, got {}",
            metrics.shanten
        ));
    }

    // The kept hand: the fold's own cost, and still 2-away or worse.
    let mut kept = full_tiles.clone();
    let answer_index = kept
        .iter()
        .position(|tile| *tile == skeleton.answer)
        .ok_or_else(|| "the answer is not in the displayed hand".to_string())?;
    kept.remove(answer_index);
    let kept_shanten = calculate_shanten(&to_counts(&kept)).shanten;
    if kept_shanten < FOLD_SHANTEN {
        return Err(format!(
            "the kept hand must stay {FOLD_SHANTEN}-away or worse, got {kept_shanten}"
        ));
    }

    let tiles_remaining = deck.remaining().saturating_sub(12).min(u8::MAX as usize) as u8;
    if tiles_remaining == 0 {
        return Err("no drawable tiles remain".to_string());
    }

    let state = GameState {
        category: category.to_string(),
        target_action: TargetAction::Defend,
        correct_action: CorrectAction::fold(skeleton.answer.to_string()),
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
        hand_string: format_hand_compact(&full_tiles),
        tiles: full_tiles.iter().map(ToString::to_string).collect(),
        shanten: metrics.shanten,
        is_agari: metrics.is_agari,
        decompositions_count: metrics.decompositions_count,
        ukeire_tiles: metrics.ukeire_tiles,
        ukeire_total: metrics.ukeire_total,
        round_wind,
        hand_number,
        honba,
        riichi_sticks: 1,
        dora_indicators: vec![dora_indicator.to_string()],
        ura_dora_indicators: vec![ura_indicator.to_string()],
        tiles_remaining,
        current_turn: 0,
        players,
    };

    validate(&state, skeleton, threat_seat)?;
    Ok(state)
}

/// Builds the learner's fourteen tiles and picks the drawn tile.
///
/// The shape is always the same skeleton: the answer's block, the blocks the
/// theme needs, and four lone honors — exactly 2-away. Every constructed block
/// is suited, so the hand never holds a value triplet, and the suited tiles are
/// spread over at least two suits, so it is not a flush either. The draw is one
/// of the lone honors, so the answer and its block partner both stay in the
/// concealed hand and the block is on screen.
fn build_human_hand(deck: &mut Deck, skeleton: &Skeleton) -> Result<(Vec<Tile>, Tile), String> {
    let mut tiles: Vec<Tile> = Vec::with_capacity(14);
    for tile in skeleton.reserved() {
        take(deck, &mut tiles, tile)?;
    }

    match skeleton.kind {
        // The answer's pair is the head: two sets and one more protorun
        // complete the hand.
        BlockKind::Pair => {
            add_set(deck, &mut tiles)?;
            add_set(deck, &mut tiles)?;
            add_protorun(deck, &mut tiles)?;
        }
        // The answer's protorun plus two sets and a head.
        BlockKind::Ryanmen => {
            add_set(deck, &mut tiles)?;
            add_set(deck, &mut tiles)?;
            add_pair(deck, &mut tiles)?;
        }
        // The answer's run, one more set, a head and a protorun: breaking the
        // run costs a completed set, which keeps the kept hand slow.
        BlockKind::Run => {
            add_set(deck, &mut tiles)?;
            add_pair(deck, &mut tiles)?;
            add_protorun(deck, &mut tiles)?;
        }
    }

    // Four lone honors. They can never form a block with a suited answer, and
    // they keep the hand off tanyao and off a one-suit flush, so the hand stays
    // the book's "low scoring hand" (ch8:65).
    let mut floats = Vec::with_capacity(4);
    let mut honors: Vec<Honor> = vec![
        Honor::East,
        Honor::South,
        Honor::West,
        Honor::North,
        Honor::White,
        Honor::Green,
        Honor::Red,
    ];
    shuffle(&mut honors);
    for honor in honors {
        if floats.len() == 4 {
            break;
        }
        let tile = Tile::Honor(honor);
        if tiles.contains(&tile) || !deck.has(tile) {
            continue;
        }
        take(deck, &mut tiles, tile)?;
        floats.push(tile);
    }
    if floats.len() != 4 {
        return Err("not enough honor floats for the learner's hand".to_string());
    }

    if tiles.len() != 14 {
        return Err(format!(
            "the learner's {} hand has {} tiles",
            skeleton.kind.as_str(),
            tiles.len()
        ));
    }
    let metrics = evaluate_counts(&to_counts(&tiles));
    if metrics.shanten != FOLD_SHANTEN {
        return Err(format!(
            "the learner's hand must be {FOLD_SHANTEN}-away, got {}",
            metrics.shanten
        ));
    }
    let suits: HashSet<Suit> = tiles.iter().filter_map(|tile| tile.suit()).collect();
    if suits.len() < 2 {
        return Err("the learner's hand must not be a one-suit hand".to_string());
    }

    let draw = choose(&floats).ok_or_else(|| "no honor can be the draw".to_string())?;
    let index = tiles
        .iter()
        .position(|tile| *tile == draw)
        .ok_or_else(|| "the chosen draw left the hand".to_string())?;
    tiles.remove(index);

    Ok((tiles, draw))
}

/// Builds the threat's concealed hand: three sets, a head and one protorun.
///
/// That is exactly tenpai on the protorun, so the Riichi declaration is a real
/// one. The safe tile is excluded from the whole hand, so the threat is never
/// furiten on the tile the lesson calls safe.
fn build_threat_hand(deck: &mut Deck, answer: Tile) -> Result<Vec<Tile>, String> {
    let mut tiles: Vec<Tile> = Vec::with_capacity(13);

    for _ in 0..3 {
        let held = tiles.clone();
        let set = choose_set(deck, &|tile: Tile| tile != answer && !held.contains(&tile))
            .ok_or_else(|| "no complete set is available for the threat".to_string())?;
        for tile in set {
            take(deck, &mut tiles, tile)?;
        }
    }

    let held = tiles.clone();
    let pair = choose_pair(deck, &|tile: Tile| tile != answer && !held.contains(&tile))
        .ok_or_else(|| "no pair is available for the threat".to_string())?;
    take_n(deck, &mut tiles, pair, 2)?;

    let held = tiles.clone();
    let protorun = choose_protorun(deck, &|tile: Tile| tile != answer && !held.contains(&tile))
        .ok_or_else(|| "no protorun is available for the threat".to_string())?;
    for tile in protorun {
        take(deck, &mut tiles, tile)?;
    }

    if tiles.len() != 13 {
        return Err(format!("the threat holds {} tiles", tiles.len()));
    }
    if calculate_shanten(&to_counts(&tiles)).shanten != 0 {
        return Err("the threat's hand is not tenpai".to_string());
    }
    if calculate_ukeire(&to_counts(&tiles))
        .tiles
        .iter()
        .any(|entry| entry.tile == answer)
    {
        return Err("the threat must not wait on the safe tile".to_string());
    }

    Ok(tiles)
}

/// Builds the threat's river, planting the answer where the lesson wants it.
///
/// Every hand tile type is kept out of the river, so the answer really is the
/// hand's only genbutsu. `declare_on_answer` puts it on the declaration itself;
/// otherwise it lands inside the first [`EARLY_TURN_LIMIT`] discards, the
/// chapter's "early turns".
fn build_threat_river(
    deck: &mut Deck,
    answer: Tile,
    human_types: &[Tile],
    count: usize,
    declare_on_answer: bool,
) -> Result<Vec<Tile>, String> {
    if count < 2 {
        return Err("the threat's river is too short for the lesson".to_string());
    }

    let mut river = deck
        .draw_excluding(count - 1, human_types)
        .ok_or_else(|| "deck exhausted drawing the threat river".to_string())?;
    // The answer's table copy: one more than the learner holds.
    deck.take(answer)?;
    if declare_on_answer {
        river.push(answer);
    } else {
        let index = gen_range(0, EARLY_TURN_LIMIT.min(river.len()));
        river.insert(index, answer);
    }

    Ok(river)
}

fn human_player(
    human_wind: Wind,
    score: i32,
    concealed: &[Tile],
    draw: Tile,
    river: &[Tile],
    plan: &RiverPlan,
) -> PlayerState {
    let mut discards = discards_from_tiles(river);
    force_tedashi(&mut discards, &plan.hand_discards[0]);

    PlayerState {
        seat: 0,
        name: "You".to_string(),
        is_human: true,
        wind: human_wind,
        score,
        hand: concealed.iter().map(ToString::to_string).collect(),
        draw: Some(draw.to_string()),
        red_fives: Vec::new(),
        discards,
        melds: Vec::new(),
        is_riichi: false,
        riichi_discard_index: None,
    }
}

fn threat_player(
    seat: usize,
    name: &str,
    human_wind: Wind,
    score: i32,
    hand: &[Tile],
    river: &[Tile],
    plan: &RiverPlan,
) -> PlayerState {
    let mut discards = discards_from_tiles(river);
    force_tedashi(&mut discards, &plan.hand_discards[seat]);
    // The declaration tile is thrown from the hand, never tsumogiri.
    if let Some(last) = discards.last_mut() {
        last.is_riichi = true;
        last.is_tsumogiri = false;
    }

    PlayerState {
        seat,
        name: name.to_string(),
        is_human: false,
        wind: human_wind.next(seat),
        score,
        hand: hand.iter().map(ToString::to_string).collect(),
        draw: None,
        red_fives: Vec::new(),
        discards,
        melds: Vec::new(),
        is_riichi: true,
        riichi_discard_index: Some(river.len() - 1),
    }
}

fn add_set(deck: &mut Deck, tiles: &mut Vec<Tile>) -> Result<(), String> {
    let held = tiles.clone();
    let set = choose_set(deck, &|tile: Tile| block_allowed(tile, &held))
        .ok_or_else(|| "no complete set is available".to_string())?;
    for tile in set {
        take(deck, tiles, tile)?;
    }
    Ok(())
}

fn add_protorun(deck: &mut Deck, tiles: &mut Vec<Tile>) -> Result<(), String> {
    let held = tiles.clone();
    let protorun = choose_protorun(deck, &|tile: Tile| block_allowed(tile, &held))
        .ok_or_else(|| "no protorun is available".to_string())?;
    for tile in protorun {
        take(deck, tiles, tile)?;
    }
    Ok(())
}

fn add_pair(deck: &mut Deck, tiles: &mut Vec<Tile>) -> Result<(), String> {
    let held = tiles.clone();
    let pair = choose_pair(deck, &|tile: Tile| block_allowed(tile, &held))
        .ok_or_else(|| "no pair is available".to_string())?;
    take_n(deck, tiles, pair, 2)
}

/// Blocks in the learner's hand are suited only.
///
/// A suited set can never be a value triplet, and the four honors are the
/// hand's floats, so the hand has no yaku and no high-value set.
fn block_allowed(tile: Tile, held: &[Tile]) -> bool {
    tile.suit().is_some() && !held.contains(&tile)
}

/// Chooses a complete run or triplet the predicate allows.
fn choose_set<F>(deck: &Deck, allowed: &F) -> Option<Vec<Tile>>
where
    F: Fn(Tile) -> bool,
{
    let mut candidates: Vec<Vec<Tile>> = Vec::new();

    for suit in [Suit::Man, Suit::Pin, Suit::Sou] {
        for start in 1..=7u8 {
            let run = vec![
                Tile::suited(suit, start),
                Tile::suited(suit, start + 1),
                Tile::suited(suit, start + 2),
            ];
            if run.iter().all(|tile| allowed(*tile) && deck.has(*tile)) {
                candidates.push(run);
            }
        }
    }

    for &tile in ALL_TILES.iter() {
        if allowed(tile) && deck.count(tile) >= 3 {
            candidates.push(vec![tile, tile, tile]);
        }
    }

    shuffle(&mut candidates);
    candidates.into_iter().next()
}

/// Chooses a pair (two copies of one tile) the predicate allows.
fn choose_pair<F>(deck: &Deck, allowed: &F) -> Option<Tile>
where
    F: Fn(Tile) -> bool,
{
    let mut candidates: Vec<Tile> = ALL_TILES
        .iter()
        .copied()
        .filter(|tile| allowed(*tile) && deck.count(*tile) >= 2)
        .collect();
    shuffle(&mut candidates);
    candidates.first().copied()
}

/// Chooses a same-suit two-tile protorun the predicate allows.
fn choose_protorun<F>(deck: &Deck, allowed: &F) -> Option<Vec<Tile>>
where
    F: Fn(Tile) -> bool,
{
    let mut candidates: Vec<Vec<Tile>> = Vec::new();

    for suit in [Suit::Man, Suit::Pin, Suit::Sou] {
        for value in 1..=9u8 {
            for step in 1..=2u8 {
                if value + step > 9 {
                    continue;
                }
                let low = Tile::suited(suit, value);
                let high = Tile::suited(suit, value + step);
                if allowed(low) && allowed(high) && deck.has(low) && deck.has(high) {
                    candidates.push(vec![low, high]);
                }
            }
        }
    }

    shuffle(&mut candidates);
    candidates.into_iter().next()
}

/// Picks a dora indicator whose dora is not in the learner's hand.
///
/// The indicator itself is also kept off the hand's tile types, so a hand tile
/// can never reach four visible copies through the indicator and silently
/// become a second 100% tile.
fn draw_dora(deck: &mut Deck, human_types: &[Tile]) -> Result<Tile, String> {
    let mut candidates: Vec<Tile> = ALL_TILES
        .iter()
        .copied()
        .filter(|tile| deck.has(*tile))
        .filter(|tile| !human_types.contains(tile))
        .filter(|tile| !human_types.contains(&indicator_to_dora(*tile)))
        .collect();
    shuffle(&mut candidates);
    let indicator = candidates
        .first()
        .copied()
        .ok_or_else(|| "no legal dora indicator".to_string())?;
    deck.take(indicator)?;
    Ok(indicator)
}

fn take(deck: &mut Deck, tiles: &mut Vec<Tile>, tile: Tile) -> Result<(), String> {
    deck.take(tile)?;
    tiles.push(tile);
    Ok(())
}

fn take_n(deck: &mut Deck, tiles: &mut Vec<Tile>, tile: Tile, count: u8) -> Result<(), String> {
    for _ in 0..count {
        take(deck, tiles, tile)?;
    }
    Ok(())
}

fn unique(tiles: impl IntoIterator<Item = Tile>) -> Vec<Tile> {
    let mut unique: Vec<Tile> = tiles.into_iter().collect();
    unique.sort();
    unique.dedup();
    unique
}

/// True when two tiles are the same tile or a same-suit protorun.
fn shares_block(a: Tile, b: Tile) -> bool {
    if a == b {
        return true;
    }
    match (a.suit(), a.value(), b.suit(), b.value()) {
        (Some(a_suit), Some(a_value), Some(b_suit), Some(b_value)) => {
            a_suit == b_suit && (1..=2).contains(&a_value.abs_diff(b_value))
        }
        _ => false,
    }
}

/// Re-derives every promise of the lesson from the finished table.
///
/// The table is the oracle: the answer's chart row must be the 100% one, every
/// other hand tile must be strictly worse and not 100% safe by any of the
/// chapter's three kinds, and the answer must still share a block with a tile
/// the learner keeps. A tie re-rolls the board rather than teaching two answers.
fn validate(state: &GameState, skeleton: &Skeleton, threat_seat: usize) -> Result<(), String> {
    if state
        .players
        .iter()
        .filter(|player| player.is_riichi)
        .count()
        != 1
    {
        return Err("exactly one opponent must be in Riichi".to_string());
    }

    let threat = state
        .players
        .iter()
        .find(|player| player.seat == threat_seat)
        .ok_or_else(|| "no threat player".to_string())?;
    if !threat.is_riichi {
        return Err("the threat must be in Riichi".to_string());
    }
    if !threat.melds.is_empty() {
        return Err("the threat must be concealed".to_string());
    }
    let declaration = threat
        .riichi_discard_index
        .ok_or_else(|| "the threat has no declaration discard".to_string())?;
    if declaration + 1 != threat.discards.len() {
        return Err("the declaration must be the threat's latest discard".to_string());
    }
    if !threat.discards[declaration].is_riichi {
        return Err("the declaration discard is not marked".to_string());
    }
    if threat.discards.len() < MIN_THREAT_RIVER {
        return Err(format!(
            "the threat's river is only {} deep",
            threat.discards.len()
        ));
    }

    let human = state
        .players
        .iter()
        .find(|player| player.is_human)
        .ok_or_else(|| "no human player".to_string())?;
    if !human.melds.is_empty() || human.is_riichi {
        return Err("the defender must be concealed and not in Riichi".to_string());
    }
    if human.hand.len() != 13 || human.draw.is_none() {
        return Err("the defender must hold thirteen tiles plus the draw".to_string());
    }
    if state.shanten != FOLD_SHANTEN {
        return Err(format!(
            "the displayed hand must be {FOLD_SHANTEN}-away, got {}",
            state.shanten
        ));
    }
    if !matches!(state.correct_action, CorrectAction::Fold { .. }) {
        return Err("the answer must be a plain fold discard".to_string());
    }
    if !state.equivalent_tiles.is_empty() {
        return Err("this lesson has one exact answer".to_string());
    }

    let answer = Tile::try_from(
        state
            .correct_action
            .tile()
            .ok_or_else(|| "the fold answer must name a tile".to_string())?,
    )
    .map_err(|err| err.to_string())?;
    if answer != skeleton.answer {
        return Err("the answer does not match the skeleton".to_string());
    }

    let draw = Tile::try_from(
        human
            .draw
            .as_deref()
            .ok_or_else(|| "the defender has no draw".to_string())?,
    )
    .map_err(|err| err.to_string())?;
    let hand: Vec<Tile> = human
        .hand
        .iter()
        .map(|code| Tile::try_from(code.as_str()).map_err(|err| err.to_string()))
        .collect::<Result<_, _>>()?;
    if !hand.contains(&answer) {
        return Err("the safe tile must be a hand tile, so the fold is tedashi".to_string());
    }
    if draw == answer {
        return Err("the answer must not be the draw".to_string());
    }
    for tile in &skeleton.block {
        if !hand.contains(tile) {
            return Err("the answer's block must stay in the concealed hand".to_string());
        }
    }
    if !hand
        .iter()
        .filter(|tile| **tile != answer)
        .any(|tile| shares_block(answer, *tile))
    {
        return Err("the answer must share a block with a kept tile".to_string());
    }

    // The kept hand is still 2-away or worse: the fold gives up a block, not
    // the hand's readiness.
    let mut kept = hand.clone();
    let index = kept
        .iter()
        .position(|tile| *tile == answer)
        .ok_or_else(|| "the answer left the hand".to_string())?;
    kept.remove(index);
    let kept_shanten = calculate_shanten(&to_counts(&kept)).shanten;
    if kept_shanten < FOLD_SHANTEN {
        return Err(format!(
            "the kept hand must stay {FOLD_SHANTEN}-away or worse, got {kept_shanten}"
        ));
    }

    // The safety table is the oracle.
    let facts = SafetyFacts::from_state(state, threat_seat)
        .ok_or_else(|| "no safety facts for the threat".to_string())?;
    let answer_read = facts.read(answer);
    if answer_read.rank != SafetyRank::Genbutsu {
        return Err(format!(
            "the answer is Rank {}, not the 100% row",
            answer_read.rank.code()
        ));
    }

    let mut held_types = hand.clone();
    held_types.push(draw);
    let held_types = unique(held_types.iter().copied());
    for tile in &held_types {
        if *tile == answer {
            continue;
        }
        if facts.is_absolutely_safe(*tile) {
            return Err(format!("{tile} is also 100% safe"));
        }
        if facts.rank(*tile).order() <= answer_read.rank.order() {
            return Err(format!("{tile} ties or beats the answer on the chart"));
        }
    }

    // The threat really is tenpai, and never on the safe tile.
    let threat_hand: Vec<Tile> = threat
        .hand
        .iter()
        .map(|code| Tile::try_from(code.as_str()).map_err(|err| err.to_string()))
        .collect::<Result<_, _>>()?;
    if calculate_shanten(&to_counts(&threat_hand)).shanten != 0 {
        return Err("the threat's hand is not tenpai".to_string());
    }
    if calculate_ukeire(&to_counts(&threat_hand))
        .tiles
        .iter()
        .any(|entry| entry.tile == answer)
    {
        return Err("the threat must not wait on the safe tile".to_string());
    }

    // Low scoring (ch8:65): no dora, no one-suit hand, and the lone honors
    // rule out tanyao. The hand is a junk hand rather than a value push.
    let dora: Vec<Tile> = state
        .dora_indicators
        .iter()
        .filter_map(|code| Tile::try_from(code.as_str()).ok())
        .map(indicator_to_dora)
        .collect();
    if held_types.iter().any(|tile| dora.contains(tile)) {
        return Err("the hand must hold no dora".to_string());
    }
    let suits: HashSet<Suit> = held_types.iter().filter_map(|tile| tile.suit()).collect();
    if suits.len() < 2 {
        return Err("the hand must not be a one-suit hand".to_string());
    }

    crate::generator::support::state_validation::validate_reachable_state(state)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::{generate, skeleton::BlockKind};
    use super::*;
    use crate::state::CorrectActionType;

    fn human(state: &GameState) -> &PlayerState {
        state
            .players
            .iter()
            .find(|player| player.is_human)
            .expect("human player")
    }

    fn threat(state: &GameState) -> &PlayerState {
        state
            .players
            .iter()
            .find(|player| player.is_riichi)
            .expect("threat player")
    }

    fn answer_tile(state: &GameState) -> Tile {
        Tile::try_from(state.correct_action.tile().expect("answer tile"))
            .expect("answer must parse")
    }

    fn hand_tiles(state: &GameState) -> Vec<Tile> {
        let player = human(state);
        player
            .hand
            .iter()
            .chain(player.draw.iter())
            .map(|code| Tile::try_from(code.as_str()).expect("tile code"))
            .collect()
    }

    #[test]
    fn generated_boards_teach_the_single_100_percent_tile() {
        for run in 0..200 {
            let state =
                generate("fold_to_riichi").unwrap_or_else(|err| panic!("run {run} failed: {err}"));

            assert_eq!(state.category, "fold_to_riichi");
            assert_eq!(state.target_action, TargetAction::Defend);
            assert_eq!(state.correct_action.action_type(), CorrectActionType::Fold);
            assert!(state.equivalent_tiles.is_empty());
            assert_eq!(state.shanten, FOLD_SHANTEN);
            assert_eq!(state.riichi_sticks, 1);
            assert_eq!(state.dora_indicators.len(), 1);
            assert_eq!(state.ura_dora_indicators.len(), 1);
            assert!(state.book_rationale.is_none(), "finalize stamps it later");

            let threat = threat(&state);
            assert!(threat.melds.is_empty());
            assert_eq!(
                threat.riichi_discard_index,
                Some(threat.discards.len() - 1),
                "the declaration must be the latest discard"
            );
            assert!(threat.discards.last().expect("a discard").is_riichi);
            assert!(!threat.discards.last().expect("a discard").is_tsumogiri);
            assert!(
                threat.discards.len() >= MIN_THREAT_RIVER,
                "run {run}: the river is not deep enough"
            );

            let player = human(&state);
            assert_eq!(player.hand.len(), 13);
            assert!(player.draw.is_some());
            assert!(player.melds.is_empty());
            assert!(!player.is_riichi);

            // The answer is a concealed hand tile, never the draw.
            let answer = answer_tile(&state);
            assert_ne!(Some(answer.to_string()), player.draw);
            assert!(
                player.hand.contains(&answer.to_string()),
                "run {run}: the fold must be tedashi"
            );

            // The answer shares a block with a kept tile.
            let held = hand_tiles(&state);
            assert!(
                held.iter()
                    .filter(|tile| **tile != answer)
                    .any(|tile| shares_block(answer, *tile)),
                "run {run}: {answer} is an isolated float"
            );

            // The chart: the answer is the only 100% tile in the hand.
            let facts = SafetyFacts::from_state(&state, threat.seat).expect("facts");
            assert_eq!(facts.rank(answer), SafetyRank::Genbutsu);
            for tile in unique(held.iter().copied()) {
                if tile == answer {
                    continue;
                }
                assert!(
                    !facts.is_absolutely_safe(tile),
                    "run {run}: {tile} is also 100% safe"
                );
                assert!(
                    facts.rank(tile).order() > facts.rank(answer).order(),
                    "run {run}: {tile} is not strictly more dangerous"
                );
            }

            // The displayed fourteen tiles are the hand plus the draw.
            let mut expected: Vec<String> = player.hand.clone();
            expected.push(player.draw.clone().expect("draw"));
            expected.sort();
            let mut actual = state.tiles.clone();
            actual.sort();
            assert_eq!(actual, expected);

            // The threat is genuinely tenpai, and not on the safe tile.
            let threat_hand: Vec<Tile> = threat
                .hand
                .iter()
                .map(|code| Tile::try_from(code.as_str()).expect("tile code"))
                .collect();
            assert_eq!(
                calculate_shanten(&to_counts(&threat_hand)).shanten,
                0,
                "run {run}: the threat must be ready"
            );
            assert!(
                !calculate_ukeire(&to_counts(&threat_hand))
                    .tiles
                    .iter()
                    .any(|entry| entry.tile == answer),
                "run {run}: a furiten threat is a weaker lesson"
            );

            // Low scoring: no dora, and the suited tiles span two suits.
            let dora: Vec<Tile> = state
                .dora_indicators
                .iter()
                .map(|code| indicator_to_dora(Tile::try_from(code.as_str()).expect("indicator")))
                .collect();
            assert!(!held.iter().any(|tile| dora.contains(tile)));
            let suits: HashSet<Suit> = held.iter().filter_map(|tile| tile.suit()).collect();
            assert!(suits.len() >= 2);

            // The kept hand stays slow.
            let mut kept = held.clone();
            let index = kept
                .iter()
                .position(|tile| *tile == answer)
                .expect("answer");
            kept.remove(index);
            assert!(calculate_shanten(&to_counts(&kept)).shanten >= FOLD_SHANTEN);

            let total_score: i32 = state.players.iter().map(|player| player.score).sum();
            assert_eq!(total_score, 100_000);
        }
    }

    /// Both placements of the safe tile appear: an early river discard and the
    /// Riichi declaration itself.
    #[test]
    fn the_safe_tile_is_both_an_early_discard_and_a_declaration() {
        let mut early = 0;
        let mut declaration = 0;

        for _ in 0..120 {
            let state = generate("fold_to_riichi").expect("generation");
            let answer = answer_tile(&state);
            let threat = threat(&state);
            let last = threat.discards.last().expect("a river").tile.clone();
            if last == answer.to_string() {
                declaration += 1;
            } else {
                early += 1;
            }
        }

        assert!(early > 0, "no board planted the safe tile early");
        assert!(declaration > 0, "no board declared Riichi on the safe tile");
    }

    #[test]
    fn every_block_kind_is_generated() {
        let mut seen = HashSet::new();
        for _ in 0..120 {
            let state = generate("fold_to_riichi").expect("generation");
            let answer = answer_tile(&state);
            let held = hand_tiles(&state);
            let copies = held.iter().filter(|tile| **tile == answer).count();
            let neighbours: Vec<Tile> = held
                .iter()
                .copied()
                .filter(|tile| *tile != answer && shares_block(answer, *tile))
                .collect();

            if copies >= 2 {
                seen.insert(BlockKind::Pair.as_str());
            } else if neighbours.len() >= 2 {
                seen.insert(BlockKind::Run.as_str());
            } else {
                seen.insert(BlockKind::Ryanmen.as_str());
            }
        }

        for kind in BlockKind::ALL {
            assert!(seen.contains(kind.as_str()), "{kind:?} was never generated");
        }
    }

    #[test]
    fn blocks_and_answer_are_always_on_the_table() {
        for _ in 0..60 {
            let state = generate("fold_to_riichi").expect("generation");
            let answer = answer_tile(&state);
            let held = hand_tiles(&state);
            let threats = state
                .players
                .iter()
                .filter(|player| player.is_riichi)
                .count();
            assert_eq!(threats, 1);
            assert!(held.contains(&answer));
        }
    }

    #[test]
    fn shares_block_accepts_pairs_and_protoruns() {
        let four = Tile::suited(Suit::Man, 4);
        assert!(shares_block(four, four));
        assert!(shares_block(four, Tile::suited(Suit::Man, 3)));
        assert!(shares_block(four, Tile::suited(Suit::Man, 5)));
        assert!(shares_block(four, Tile::suited(Suit::Man, 6)));
        assert!(!shares_block(four, Tile::suited(Suit::Man, 7)));
        assert!(!shares_block(four, Tile::suited(Suit::Pin, 3)));
        assert!(!shares_block(four, Tile::Honor(Honor::East)));
        assert!(!shares_block(
            Tile::Honor(Honor::East),
            Tile::Honor(Honor::South)
        ));
    }
}
