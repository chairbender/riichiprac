//! Table assembly for the ch. 5 honitsu lesson.
//!
//! The table is deliberately plain: everyone concealed, nobody in Riichi, the
//! human on a middle turn (six to nine discards each) so the hand is a
//! mid-hand decision like the book's "6th turn" examples. Everything that
//! decides the answer is in the fourteen tiles, so this module only has to keep
//! the two factors honest:
//!
//! - the dora indicator is chosen so **no hand tile is dora**, which keeps the
//!   hand worth exactly what the skeleton scored;
//! - the drawn tile is never the answer, so the answer is a tile thrown from
//!   the hand (tedashi) and the open hand is not already a call away.

use agari::context::indicator_to_dora;
use agari::tile::Tile;

use super::skeleton::{self, Variant};
use crate::generator::support::analysis::evaluate_hand;
use crate::generator::support::deck::{ALL_TILES, Deck};
use crate::generator::support::format::format_hand_compact;
use crate::generator::support::table::{
    deal_opponents, discards_from_tiles, random_round, random_scores_with_human_first,
    self_turn_river_plan,
};
use crate::rng::{choose, gen_range};
use crate::state::{CorrectAction, DecisionContext, GameState, PlayerState, TargetAction, Wind};

/// Builds one validated honitsu board for `variant`.
pub(super) fn build(category: &str, variant: Variant) -> Result<GameState, String> {
    let (round_wind, hand_number) = random_round();
    // The book's 5200 arithmetic is a non-dealer's ron value, so the human
    // never sits on the dealer seat. It also keeps "the seat wind" of the
    // Honitsu 3 hand a real fanpai.
    let human_wind = choose(&[Wind::South, Wind::West, Wind::North])
        .ok_or_else(|| "No non-dealer wind available".to_string())?;

    let skeleton = skeleton::build(variant, round_wind, human_wind)?;
    let hand_tiles = skeleton.tiles.clone();

    let mut deck = Deck::fresh();
    for &tile in &hand_tiles {
        deck.take(tile)?;
    }

    // A dora indicator whose dora is not in the hand: nothing on the board
    // changes a hand value the lesson already checked.
    let dora_candidates: Vec<Tile> = ALL_TILES
        .iter()
        .copied()
        .filter(|&tile| {
            deck.has(tile)
                && !hand_tiles.contains(&tile)
                && !hand_tiles.contains(&indicator_to_dora(tile))
        })
        .collect();
    let dora_indicator =
        choose(&dora_candidates).ok_or_else(|| "No neutral dora indicator".to_string())?;
    deck.take(dora_indicator)?;
    let ura_indicator = deck
        .draw()
        .ok_or_else(|| "Deck exhausted drawing the ura indicator".to_string())?;

    let scores = random_scores_with_human_first();
    // Six to nine discards each: a middle turn, like the section's examples.
    let plan = self_turn_river_plan(human_wind, &[], gen_range(6, 10));
    let deal = deal_opponents(&mut deck, human_wind, &scores, &plan)
        .ok_or_else(|| "Deck exhausted dealing the opponents".to_string())?;
    let human_river = deck
        .draw_excluding(plan.counts[0], &[])
        .ok_or_else(|| "Deck exhausted drawing the human river".to_string())?;

    // The draw is a hand tile that is neither the answer nor an accepted
    // equivalent, so every graded tile is visibly in the concealed hand.
    let mut draw_candidates: Vec<Tile> = hand_tiles
        .iter()
        .copied()
        .filter(|tile| *tile != skeleton.answer && !skeleton.equivalents.contains(tile))
        .collect();
    draw_candidates.sort();
    draw_candidates.dedup();
    let drawn = choose(&draw_candidates).ok_or_else(|| "No tile to draw".to_string())?;

    let mut concealed = hand_tiles.clone();
    let index = concealed
        .iter()
        .position(|tile| *tile == drawn)
        .ok_or_else(|| "The drawn tile is not in the hand".to_string())?;
    concealed.remove(index);

    let metrics = evaluate_hand(&hand_tiles);
    if metrics.is_agari || metrics.shanten < 1 {
        return Err(format!(
            "The honitsu hand must be unfinished, got {} shanten",
            metrics.shanten
        ));
    }

    let tiles_remaining = deck.remaining().saturating_sub(12).min(u8::MAX as usize) as u8;
    if tiles_remaining == 0 {
        return Err("No drawable tiles remain".to_string());
    }

    let hand_string = format_hand_compact(&hand_tiles);
    let tile_strings: Vec<String> = hand_tiles.iter().map(ToString::to_string).collect();
    let red_fives = match variant {
        // The red five sits inside the kept run, so it is still held after the
        // answer and the 5200 value is real.
        Variant::AlreadyHigh => vec![Tile::suited(skeleton.suit, 5).to_string()],
        _ => Vec::new(),
    };

    let human_player = PlayerState {
        seat: 0,
        name: "You".to_string(),
        is_human: true,
        wind: human_wind,
        score: scores[0],
        hand: concealed.iter().map(ToString::to_string).collect(),
        draw: Some(drawn.to_string()),
        red_fives,
        discards: discards_from_tiles(&human_river),
        melds: Vec::new(),
        is_riichi: false,
        riichi_discard_index: None,
    };

    let mut players = Vec::with_capacity(4);
    players.push(human_player);
    players.extend(deal.players);
    players.sort_by_key(|player| player.seat);

    let state = GameState {
        category: category.to_string(),
        target_action: TargetAction::NaniKiru,
        correct_action: CorrectAction::dama(skeleton.answer.to_string()),
        equivalent_tiles: skeleton
            .equivalents
            .iter()
            .filter(|tile| **tile != skeleton.answer)
            .map(ToString::to_string)
            .collect(),
        decision: DecisionContext::SelfTurn,
        scenario_note: None,
        call_offer: None,
        ai_decision: None,
        riichi_triggers: Vec::new(),
        dama_reasons: Vec::new(),
        shouminkan_triggers: Vec::new(),
        book_rationale: None,
        can_riichi: false,
        hand_string,
        tiles: tile_strings,
        shanten: metrics.shanten,
        is_agari: metrics.is_agari,
        decompositions_count: metrics.decompositions_count,
        ukeire_tiles: metrics.ukeire_tiles,
        ukeire_total: metrics.ukeire_total,
        round_wind,
        hand_number,
        honba: gen_range(0, 4) as u8,
        riichi_sticks: 0,
        dora_indicators: vec![dora_indicator.to_string()],
        ura_dora_indicators: vec![ura_indicator.to_string()],
        tiles_remaining,
        current_turn: 0,
        players,
    };

    validate(&state, variant, &skeleton)?;

    Ok(state)
}

/// Re-derives the lesson's answer and its two factors from the finished table.
fn validate(
    state: &GameState,
    variant: Variant,
    skeleton: &skeleton::Skeleton,
) -> Result<(), String> {
    if state.tiles.len() != 14 {
        return Err(format!(
            "The honitsu hand must show 14 tiles, got {}",
            state.tiles.len()
        ));
    }
    let human = state
        .players
        .iter()
        .find(|player| player.is_human)
        .ok_or_else(|| "No human player".to_string())?;
    if human.hand.len() != 13 || human.draw.is_none() {
        return Err("The human must hold 13 tiles plus a draw".to_string());
    }
    if !human.melds.is_empty() || human.is_riichi {
        return Err("The honitsu hand must be concealed and not in Riichi".to_string());
    }
    for player in &state.players {
        if !player.melds.is_empty() || player.is_riichi {
            return Err(format!("Seat {} already called or declared", player.seat));
        }
    }

    // The displayed tiles are exactly the concealed hand plus the draw.
    let mut expected: Vec<String> = human.hand.clone();
    expected.extend(human.draw.clone());
    expected.sort();
    let mut actual = state.tiles.clone();
    actual.sort();
    if actual != expected {
        return Err("The displayed tiles do not match the hand plus draw".to_string());
    }

    // No tile of the hand is dora: the lesson's value is the one it scored.
    for indicator in &state.dora_indicators {
        let indicator = Tile::try_from(indicator.as_str()).map_err(|err| err.to_string())?;
        let dora = indicator_to_dora(indicator);
        if state.tiles.iter().any(|code| *code == dora.to_string()) {
            return Err(format!("The dora {dora} is in the hand"));
        }
    }

    let facts = super::facts(state).ok_or_else(|| "The table has no honitsu facts".to_string())?;
    if facts.variant != variant || facts.variant != skeleton.variant {
        return Err(format!(
            "The table reads as {:?}, not {:?}",
            facts.variant, variant
        ));
    }
    if facts.blocks != skeleton.blocks {
        return Err("The table's block reading does not match the skeleton".to_string());
    }
    if facts.value_without.map(|value| value.points)
        != skeleton.value_without.map(|value| value.points)
    {
        return Err("The table's value without honitsu does not match the skeleton".to_string());
    }
    if facts
        .honitsu
        .as_ref()
        .map(|reading| (reading.value.points, reading.value.han))
        != skeleton
            .honitsu
            .as_ref()
            .map(|reading| (reading.value.points, reading.value.han))
    {
        return Err("The table's honitsu plan does not match the skeleton".to_string());
    }
    if !facts.blocks.has_five_block_potential() {
        return Err(format!(
            "The honitsu group has only {} blocks and {} floaters",
            facts.blocks.blocks,
            facts.blocks.floaters.len()
        ));
    }
    let answer = skeleton.answer.to_string();
    if facts.suit != skeleton.suit || state.correct_action.tile() != Some(answer.as_str()) {
        return Err("The state does not match the skeleton".to_string());
    }

    match variant {
        Variant::Commit => {
            let reading = facts
                .honitsu
                .as_ref()
                .ok_or_else(|| "The commit hand has no honitsu reading".to_string())?;
            if !reading.yaku.contains(&agari::yaku::Yaku::Honitsu) {
                return Err("The commit hand is not honitsu".to_string());
            }
            if reading.is_honitsu_only() || reading.value.points < 5_200 {
                return Err(format!(
                    "The commit hand's honitsu plan is worth only {} points with {} yaku",
                    reading.value.points,
                    reading.yaku.len()
                ));
            }
            if facts
                .value_without
                .is_some_and(|value| value.points >= 5_200)
            {
                return Err("The commit hand is already worth 5200 without honitsu".to_string());
            }
            if !facts.answer_is_off_suit {
                return Err("Committing must throw an off-suit tile".to_string());
            }
        }
        Variant::AlreadyHigh => {
            let value = facts
                .value_without
                .ok_or_else(|| "The straight hand has no minimum value".to_string())?;
            if value.points < 5_200 {
                return Err(format!(
                    "The straight hand is only worth {} points",
                    value.points
                ));
            }
            if facts.answer_is_off_suit {
                return Err("Playing for efficiency must keep the off-suit blocks".to_string());
            }
        }
        Variant::HonitsuOnly => {
            let reading = facts
                .honitsu
                .as_ref()
                .ok_or_else(|| "The honitsu-only hand has no reading".to_string())?;
            if !reading.is_honitsu_only() {
                return Err("The honitsu plan is not honitsu-only".to_string());
            }
            // The book's cheap number is the open, two-han value; the crate
            // scores a closed honitsu at three han, so the test is the yaku
            // list (honitsu and nothing else), not the closed score.
            if reading.value.han != 3 {
                return Err(format!(
                    "The closed honitsu plan unexpectedly scores {} han",
                    reading.value.han
                ));
            }
            if facts.answer_is_off_suit {
                return Err("Playing for efficiency must keep the off-suit blocks".to_string());
            }
        }
    }

    crate::generator::support::state_validation::validate_reachable_state(state)?;
    Ok(())
}
