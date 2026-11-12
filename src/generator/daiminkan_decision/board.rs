//! Table assembly for the open-quad (daiminkan) lesson.
//!
//! The hand is fixed by [`super::skeleton`]; this module chooses the table the
//! book's other two quad conditions live on (South-4 placement pressure and a
//! hopeless score line), the dora that decides whether the hand is the book's
//! 2000-point example or its 1000-point one, and the opponents' rivers.
//!
//! The board is validated from the finished state through [`super::facts`], so
//! the numbers the rationale prints and the numbers the rejection sampler
//! checks are the same numbers.

use agari::context::indicator_to_dora;
use agari::parse::to_counts;
use agari::tile::Tile;

use super::skeleton::{DaiminkanShape, DaiminkanSkeleton};
use super::{DaiminkanTriggerSet, facts, quad_window};

use crate::generator::support::deck::{ALL_TILES, Deck};
use crate::generator::support::format::format_hand_compact;
use crate::generator::support::table::{
    discards_from_tiles, force_tedashi, losing_badly_ranked_scores,
    placement_desperation_ranked_scores, plan_rivers, random_round, random_table_scores,
    scores_for_seats,
};
use crate::rng::{choose, gen_range, shuffle};
use crate::state::{
    CallOffer, CalledMeld, CorrectAction, DecisionContext, GameState, MeldType, PlayerState,
    TargetAction, Wind, dealer_seat,
};

/// What the board asks the player to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum DaiminkanAnswer {
    /// Call the open quad.
    Kan,
    /// Pass on the discard and keep the three copies concealed.
    Pass,
}

/// Where the table stands, which is the book's other two quad conditions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum DaiminkanTable {
    /// No score pressure: only the hand's own value can justify the quad.
    Balanced,
    /// South-4, one place behind by a gap only the quad's minipoints close.
    PlacementDesperation,
    /// Fourth place, far behind.
    LosingBadly,
}

impl DaiminkanTable {
    pub(super) fn trigger(self) -> DaiminkanTriggerSet {
        match self {
            Self::Balanced => DaiminkanTriggerSet::default(),
            Self::PlacementDesperation => DaiminkanTriggerSet {
                placement_desperation: true,
                ..Default::default()
            },
            Self::LosingBadly => DaiminkanTriggerSet {
                losing_badly: true,
                ..Default::default()
            },
        }
    }
}

/// Hundreds of points the human may sit behind the player above.
const PLACEMENT_GRANULARITY: i32 = 100;

/// Builds and validates one complete open-quad board.
pub(super) fn build(
    category: &str,
    skeleton: &DaiminkanSkeleton,
    shape: DaiminkanShape,
    answer: DaiminkanAnswer,
    table: DaiminkanTable,
) -> Result<GameState, String> {
    let full_tiles = skeleton.full_tiles();
    agari::parse::validate_hand(&full_tiles)?;

    // The human never sits in the dealer seat: the book's values are non-dealer
    // ron values, and the dealer multiplier would move every band.
    let human_wind = choose(&[Wind::South, Wind::West, Wind::North])
        .ok_or_else(|| "No non-dealer wind available".to_string())?;
    let (round_wind, hand_number) = match table {
        DaiminkanTable::PlacementDesperation => (Wind::South, 4),
        _ => random_round(),
    };

    let (dora_indicator, ura_indicator) = choose_indicators(skeleton, shape)?;
    let indicators = [dora_indicator];
    let window = quad_window(skeleton, round_wind, human_wind, &indicators)
        .ok_or_else(|| "the hand has no ron value".to_string())?;
    let scores = choose_scores(table, window)?;

    // The hand, the dora and the ura indicator leave the deck before any
    // opponent draws, so the fourth copy of the quad can only ever be the
    // offered discard.
    let mut deck = Deck::fresh();
    for tile in &full_tiles {
        deck.take(*tile)?;
    }
    deck.take(dora_indicator)?;
    deck.take(ura_indicator)?;

    let from = gen_range(1, 4);
    let min_discards = match table {
        DaiminkanTable::Balanced => gen_range(2, 7),
        _ => gen_range(6, 12),
    };
    // The human already has an open Chi, called from Kamicha (seat 3), so the
    // timeline runs through that call.
    let plan = plan_rivers(dealer_seat(human_wind), from, &[(0, 3)], min_discards);
    let chi_claim = plan
        .calls
        .iter()
        .find(|call| call.caller == 0 && call.source == 3)
        .copied()
        .ok_or_else(|| "the open Chi's call is missing from the timeline".to_string())?;
    // A Chi consumes a discard, so seat 3's river has to show a tile the human
    // took. The claimed copy is a spare tile of one of the run's ranks; prefer
    // one that is not a winning tile, which would shrink the wait.
    let chi_claimed = skeleton
        .open_run
        .iter()
        .copied()
        .filter(|tile| !skeleton.wait_tiles.contains(tile))
        .find(|tile| deck.has(*tile))
        .ok_or_else(|| "no spare copy of the Chi's run is left in the deck".to_string())?;
    deck.take(chi_claimed)?;

    // The human is not furiten: no winning tile may sit in their own river.
    let human_river = deck
        .draw_excluding(plan.counts[0], &skeleton.wait_tiles)
        .ok_or_else(|| "Deck exhausted drawing the human river".to_string())?;

    let mut players = Vec::with_capacity(4);
    players.push(human_player(
        human_wind,
        scores[0],
        skeleton,
        &human_river,
        &plan.hand_discards[0],
    ));
    // The offered quad is the offering seat's last discard, and the Chi claim
    // is planted where the timeline says it landed. No other river entry may
    // look claimable, so both tiles read at their own slot.
    let avoid: Vec<Tile> = skeleton
        .open_run
        .iter()
        .copied()
        .chain(std::iter::once(skeleton.quad_tile))
        .collect();
    for (seat, score) in scores.iter().enumerate().skip(1) {
        let hand = deck
            .draw_n(13)
            .ok_or_else(|| "Deck exhausted dealing an opponent".to_string())?;
        let offer_slot = (seat == from).then(|| plan.counts[seat] - 1);
        let mut river = Vec::with_capacity(plan.counts[seat]);
        for slot in 0..plan.counts[seat] {
            if Some(slot) == offer_slot {
                river.push(skeleton.quad_tile);
            } else if seat == chi_claim.source && slot == chi_claim.index {
                river.push(chi_claimed);
            } else {
                river.push(
                    deck.draw_excluding(1, &avoid)
                        .ok_or_else(|| "Deck exhausted drawing an opponent river".to_string())?
                        .pop()
                        .ok_or_else(|| "Deck exhausted drawing an opponent river".to_string())?,
                );
            }
        }
        let mut discards = discards_from_tiles(&river);
        if let Some(slot) = offer_slot {
            // The offered tile comes from the hand.
            if let Some(last) = discards.get_mut(slot) {
                last.is_tsumogiri = false;
            }
        }
        force_tedashi(&mut discards, &plan.hand_discards[seat]);
        players.push(PlayerState {
            seat,
            name: match seat {
                1 => "Shimocha",
                2 => "Toimen",
                _ => "Kamicha",
            }
            .to_string(),
            is_human: false,
            wind: human_wind.next(seat),
            score: *score,
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

    // Every winning tile still has to be drawable.
    for wait in &skeleton.wait_tiles {
        if !deck.has(*wait) {
            return Err(format!("Every copy of the winning tile {wait} is visible"));
        }
    }

    let tiles_remaining = deck.remaining().saturating_sub(12).min(u8::MAX as usize) as u8;
    if tiles_remaining == 0 {
        return Err("No drawable tiles remain".to_string());
    }

    let metrics =
        crate::generator::support::analysis::evaluate_counts(&to_counts(&skeleton.hand_tiles()));
    let mut display_tiles = skeleton.hand_tiles();
    display_tiles.sort();
    let hand_string = format_hand_compact(&display_tiles);
    let tile_strings: Vec<String> = display_tiles.iter().map(ToString::to_string).collect();

    let correct_action = match answer {
        DaiminkanAnswer::Kan => CorrectAction::kan(skeleton.quad_tile.to_string()),
        DaiminkanAnswer::Pass => CorrectAction::pass(),
    };
    let quad_name = crate::display::format_tile_for_display(&skeleton.quad_tile.to_string(), false);
    let source_name = players[from].name.clone();

    let state = GameState {
        category: category.to_string(),
        // The answer is a call decision: take the offered quad, or pass.
        target_action: TargetAction::Call,
        correct_action,
        equivalent_tiles: Vec::new(),
        decision: DecisionContext::ReactToDiscard {
            from,
            tile: skeleton.quad_tile.to_string(),
        },
        scenario_note: Some(format!(
            "{source_name} discarded {quad_name}. You hold three: call the quad, or pass?"
        )),
        call_offer: Some(CallOffer {
            action: "Kan".to_string(),
            label: format!("Kan {quad_name}"),
            tile: skeleton.quad_tile.to_string(),
            tiles: Vec::new(),
        }),
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
        current_turn: from,
        players,
    };

    validate(&state, skeleton, shape, answer, table)?;
    Ok(state)
}

/// Picks a dora indicator (and a hidden ura) that keeps the hand's value in the
/// book's example.
///
/// The book's 2000-point hand holds one dora; its 1000-point hand holds none.
/// Neither may be made dora on a winning tile, which would lift the value the
/// book is quoting.
fn choose_indicators(
    skeleton: &DaiminkanSkeleton,
    shape: DaiminkanShape,
) -> Result<(Tile, Tile), String> {
    let hand = skeleton.hand_tiles();
    let wanted = u8::from(shape.wants_dora());
    let deck = Deck::fresh();

    let dora_candidates: Vec<Tile> = ALL_TILES
        .iter()
        .copied()
        .filter(|&indicator| {
            let dora = indicator_to_dora(indicator);
            deck.has(indicator)
                && dora != skeleton.quad_tile
                && !skeleton.wait_tiles.contains(&dora)
                && hand.iter().filter(|tile| **tile == dora).count() as u8 == wanted
        })
        .collect();
    let dora_indicator =
        choose(&dora_candidates).ok_or_else(|| "No legal dora indicator".to_string())?;

    let ura_candidates: Vec<Tile> = ALL_TILES
        .iter()
        .copied()
        .filter(|&indicator| {
            indicator != dora_indicator
                && indicator_to_dora(indicator) != skeleton.quad_tile
                && deck.has(indicator)
        })
        .collect();
    let ura_indicator =
        choose(&ura_candidates).ok_or_else(|| "No legal ura indicator".to_string())?;

    Ok((dora_indicator, ura_indicator))
}

/// Chooses seat-ordered scores for the active table situation.
fn choose_scores(table: DaiminkanTable, window: super::QuadWindow) -> Result<[i32; 4], String> {
    match table {
        DaiminkanTable::Balanced => {
            let mut scores = random_table_scores();
            shuffle(&mut scores);
            Ok(scores)
        }
        DaiminkanTable::PlacementDesperation => {
            // The gap must sit inside the quad's minipoint gain: the hand wins
            // `dama` now, `kan` once the fourth copy joins the quad, and only
            // the second figure beats the player above.
            let first = window.dama as i32 / PLACEMENT_GRANULARITY + 1;
            let last = window.kan as i32 / PLACEMENT_GRANULARITY;
            if first > last {
                return Err(format!(
                    "The quad gains no whole-hundred points ({} -> {}), so it cannot decide a \
                     placement",
                    window.dama, window.kan
                ));
            }
            let steps: Vec<i32> = (first..=last)
                .map(|hundred| hundred * PLACEMENT_GRANULARITY)
                .collect();
            let gap = choose(&steps).ok_or_else(|| "No placement gap available".to_string())?;
            let human_rank = gen_range(1, 3);
            Ok(scores_for_seats(
                placement_desperation_ranked_scores(human_rank, gap),
                human_rank,
            ))
        }
        DaiminkanTable::LosingBadly => Ok(scores_for_seats(losing_badly_ranked_scores(), 3)),
    }
}

fn human_player(
    human_wind: Wind,
    score: i32,
    skeleton: &DaiminkanSkeleton,
    river: &[Tile],
    hand_discards: &[usize],
) -> PlayerState {
    let mut hand = skeleton.concealed_tiles.clone();
    hand.sort();
    let mut discards = discards_from_tiles(river);
    // A discard thrown right after the open Chi comes from the hand.
    force_tedashi(&mut discards, hand_discards);

    PlayerState {
        seat: 0,
        name: "You".to_string(),
        is_human: true,
        wind: human_wind,
        score,
        hand: hand.iter().map(ToString::to_string).collect(),
        draw: None,
        red_fives: Vec::new(),
        discards,
        melds: vec![CalledMeld {
            meld_type: MeldType::Chi,
            tiles: skeleton.open_run.iter().map(ToString::to_string).collect(),
            // A chi can only claim the previous seat's discard: the human sits
            // at seat 0, so the called run came from Kamicha.
            called_from: Some(3),
        }],
        is_riichi: false,
        riichi_discard_index: None,
    }
}

/// Re-derives every structural promise from the finished table.
fn validate(
    state: &GameState,
    skeleton: &DaiminkanSkeleton,
    shape: DaiminkanShape,
    answer: DaiminkanAnswer,
    table: DaiminkanTable,
) -> Result<(), String> {
    let parsed = facts(state).ok_or_else(|| "the table has no readable hand".to_string())?;

    if parsed.good_wait != shape.wants_good_wait() {
        return Err("the wait shape does not match the lesson".to_string());
    }
    let expected_han = if shape.wants_dora() { 2 } else { 1 };
    if parsed.han != expected_han {
        return Err(format!(
            "the hand must score {expected_han} han, got {}",
            parsed.han
        ));
    }
    if shape.wants_dora() && !parsed.in_value_band {
        return Err(format!(
            "the book's 2000-5200 band is missed: {} points",
            parsed.value
        ));
    }
    if !shape.wants_dora() && parsed.in_value_band {
        return Err(format!(
            "the cheap hand must stay below the band, got {} points",
            parsed.value
        ));
    }

    // The hand's own condition only counts when the wait is good too, so the
    // bad-wait box carries no trigger even though its value is in the band.
    let expected = DaiminkanTriggerSet {
        good_wait_and_value: shape.wants_dora() && shape.wants_good_wait(),
        ..table.trigger()
    };
    let triggers = parsed.triggers();
    if triggers != expected {
        return Err(format!(
            "the table does not stand where it was built: {triggers:?} vs {expected:?}"
        ));
    }
    match answer {
        DaiminkanAnswer::Kan if !triggers.any() => {
            return Err("an open quad must have one of the book's conditions".to_string());
        }
        DaiminkanAnswer::Pass if triggers.any() => {
            return Err("passing needs every open-quad condition to fail".to_string());
        }
        _ => {}
    }

    let human = &state.players[0];
    if human.melds.len() != 1 || human.melds[0].meld_type != MeldType::Chi {
        return Err("the human must hold exactly the called run".to_string());
    }
    if human.hand.len() != 10 || human.draw.is_some() {
        return Err("a reaction hand holds ten concealed tiles and no draw".to_string());
    }
    if human.discards.iter().any(|discard| {
        skeleton
            .wait_tiles
            .iter()
            .any(|wait| discard.tile == wait.to_string())
    }) {
        return Err("the human river holds a winning tile (furiten)".to_string());
    }

    let source = state
        .players
        .get(state.current_turn)
        .ok_or_else(|| "no offering player".to_string())?;
    let last = source
        .discards
        .last()
        .ok_or_else(|| "the offering player has no discard".to_string())?;
    if last.tile != skeleton.quad_tile.to_string() || last.is_tsumogiri {
        return Err("the offering player did not just discard the quad tile".to_string());
    }

    let total_score: i32 = state.players.iter().map(|player| player.score).sum();
    if total_score != 100_000 {
        return Err(format!("scores sum to {total_score}, expected 100000"));
    }

    if parsed.losing_badly && !matches!(table, DaiminkanTable::LosingBadly) {
        return Err("a balanced table landed in a losing position".to_string());
    }

    Ok(())
}
