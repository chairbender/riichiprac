//! Table assembly for the "never meld a cheap and slow hand" lesson.

use agari::context::indicator_to_dora;
use agari::parse::to_counts;
use agari::shanten::{calculate_shanten, calculate_shanten_with_melds};
use agari::tile::Tile;

use super::skeleton::{self, Skeleton, has_side_wait_pair, has_triplet};
use crate::generator::support::analysis::evaluate_counts;
use crate::generator::support::deck::{ALL_TILES, Deck};
use crate::generator::support::format::format_hand_compact;
use crate::generator::support::table::{
    discards_from_tiles, force_tedashi, plan_rivers, random_round, random_scores_with_human_first,
};
use crate::rng::{choose, gen_range, shuffle};
use crate::state::{
    CallOffer, CorrectAction, DecisionContext, GameState, PlayerState, TargetAction, Wind,
    dealer_seat,
};

/// The book's "slow" threshold: 2-away or worse after melding.
const SLOW_AFTER_MELD: i8 = 2;
/// The book's parenthetical: 3-away or worse before melding.
const SLOW_BEFORE_MELD: i8 = 3;

/// Builds one complete, validated cheap-and-slow call board.
pub(super) fn build_board(category: &str) -> Result<GameState, String> {
    let skeleton = skeleton::build()?;
    let (round_wind, hand_number) = random_round();
    let honba = gen_range(0, 4) as u8;
    let scores = random_scores_with_human_first();
    let human_wind = choose(&Wind::ALL).ok_or_else(|| "no seat wind available".to_string())?;

    let mut deck = Deck::fresh();

    // Reserve the whole hand plus the discarded copy of the dragon before any
    // random fill can consume one of them.
    let mut human_all = skeleton.hand.clone();
    human_all.push(skeleton.dragon);
    for &tile in &human_all {
        deck.take(tile)?;
    }

    // One legal timeline fixes every river length and ends on the offering
    // seat's discard.
    let plan = plan_rivers(dealer_seat(human_wind), skeleton.from, &[], gen_range(3, 8));
    let counts = plan.counts;

    let excluded = {
        let mut excluded: Vec<Tile> = skeleton.hand.clone();
        excluded.push(skeleton.dragon);
        excluded.sort();
        excluded.dedup();
        excluded
    };

    let human_river = deck
        .draw_excluding(counts[0], &excluded)
        .ok_or_else(|| "deck exhausted drawing the human river".to_string())?;

    let mut players = Vec::with_capacity(4);
    players.push(human_player(
        human_wind,
        scores[0],
        &skeleton.hand,
        &human_river,
        &plan,
    ));

    for seat in 1..=3usize {
        let hand = deck
            .draw_n(13)
            .ok_or_else(|| "deck exhausted dealing an opponent".to_string())?;
        let river = if seat == skeleton.from {
            let mut river = deck
                .draw_excluding(counts[seat] - 1, &excluded)
                .ok_or_else(|| "deck exhausted drawing the offering river".to_string())?;
            river.push(skeleton.dragon);
            river
        } else {
            deck.draw_excluding(counts[seat], &excluded)
                .ok_or_else(|| "deck exhausted drawing an opponent river".to_string())?
        };
        let mut discards = discards_from_tiles(&river);
        force_tedashi(&mut discards, &plan.hand_discards[seat]);
        if seat == skeleton.from {
            // The offered tile is the last discard and comes from the hand.
            if let Some(last) = discards.last_mut() {
                last.is_tsumogiri = false;
            }
        }

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

    // Cheap means no dora: the indicator's dora is never a tile the hand holds.
    let dora_indicator = draw_dora(&mut deck, &skeleton.hand)?;
    let ura_indicator = deck
        .draw()
        .ok_or_else(|| "deck exhausted drawing the ura indicator".to_string())?;

    let tiles_remaining = deck.remaining().saturating_sub(12).min(u8::MAX as usize) as u8;
    if tiles_remaining == 0 {
        return Err("no drawable tiles remain".to_string());
    }

    let mut full_tiles = skeleton.hand.clone();
    full_tiles.sort();
    let metrics = evaluate_counts(&to_counts(&full_tiles));

    let offer = CallOffer {
        action: "Pon".to_string(),
        label: format!(
            "Pon {}",
            crate::display::format_tile_for_display(&skeleton.dragon.to_string(), false)
        ),
        tile: skeleton.dragon.to_string(),
        tiles: Vec::new(),
    };

    let state = GameState {
        category: category.to_string(),
        target_action: TargetAction::Call,
        correct_action: CorrectAction::pass(),
        equivalent_tiles: Vec::new(),
        decision: DecisionContext::ReactToDiscard {
            from: skeleton.from,
            tile: skeleton.dragon.to_string(),
        },
        scenario_note: Some(format!(
            "{} discarded {}. You hold a pair: Pon, or pass?",
            players[skeleton.from].name,
            crate::display::format_tile_for_display(&skeleton.dragon.to_string(), false)
        )),
        call_offer: Some(offer),
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
        riichi_sticks: 0,
        dora_indicators: vec![dora_indicator.to_string()],
        ura_dora_indicators: vec![ura_indicator.to_string()],
        tiles_remaining,
        current_turn: skeleton.from,
        players,
    };

    validate(&state, &skeleton)?;
    Ok(state)
}

fn human_player(
    human_wind: Wind,
    score: i32,
    hand: &[Tile],
    river: &[Tile],
    plan: &crate::generator::support::table::RiverPlan,
) -> PlayerState {
    let mut discards = discards_from_tiles(river);
    force_tedashi(&mut discards, &plan.hand_discards[0]);

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
        melds: Vec::new(),
        is_riichi: false,
        riichi_discard_index: None,
    }
}

/// Picks a dora indicator whose dora the hand does not hold.
fn draw_dora(deck: &mut Deck, hand: &[Tile]) -> Result<Tile, String> {
    let mut candidates: Vec<Tile> = ALL_TILES
        .iter()
        .copied()
        .filter(|indicator| deck.has(*indicator) && !hand.contains(&indicator_to_dora(*indicator)))
        .collect();
    shuffle(&mut candidates);
    let indicator = candidates
        .first()
        .copied()
        .ok_or_else(|| "no legal dora indicator".to_string())?;
    deck.take(indicator)?;
    Ok(indicator)
}

/// Re-derives every structural promise from the finished table.
fn validate(state: &GameState, skeleton: &Skeleton) -> Result<(), String> {
    let human = state
        .players
        .iter()
        .find(|player| player.is_human)
        .ok_or_else(|| "no human player".to_string())?;
    let source = state
        .players
        .get(skeleton.from)
        .ok_or_else(|| "no offering player".to_string())?;

    if !human.melds.is_empty() || human.is_riichi {
        return Err("the human must be concealed and not in Riichi".to_string());
    }
    if human.hand.len() != 13 || human.draw.is_some() {
        return Err("a reaction hand must hold thirteen tiles and no draw".to_string());
    }
    if state.decision
        != (DecisionContext::ReactToDiscard {
            from: skeleton.from,
            tile: skeleton.dragon.to_string(),
        })
    {
        return Err("the decision must be the offered Pon".to_string());
    }
    if state.target_action != TargetAction::Call
        || state.correct_action.action_type() != crate::state::CorrectActionType::Pass
    {
        return Err("the answer must be to pass on the call".to_string());
    }
    let Some(offer) = state.call_offer.as_ref() else {
        return Err("the state must carry the offered call".to_string());
    };
    if offer.action != "Pon" || offer.tile != skeleton.dragon.to_string() {
        return Err("the offer must be the dragon Pon".to_string());
    }
    if !state.equivalent_tiles.is_empty() {
        return Err("this lesson has one answer".to_string());
    }

    // The source really did just discard the offered tile.
    let last = source
        .discards
        .last()
        .ok_or_else(|| "the source has no discards".to_string())?;
    if last.tile != skeleton.dragon.to_string() {
        return Err("the source's last discard is not the offered dragon".to_string());
    }
    if last.is_tsumogiri {
        return Err("the offered discard must be tedashi".to_string());
    }

    let tiles: Vec<Tile> = human
        .hand
        .iter()
        .map(|code| Tile::try_from(code.as_str()).map_err(|err| err.to_string()))
        .collect::<Result<_, _>>()?;
    if tiles
        .iter()
        .filter(|tile| **tile == skeleton.dragon)
        .count()
        != 2
    {
        return Err("the hand must hold two copies of the offered dragon".to_string());
    }

    // Slow: 3-away or worse before the call, and 2-away or worse for *every*
    // discard the Pon would leave. The book's parenthetical definition is
    // checked directly rather than assumed.
    let before = calculate_shanten(&to_counts(&tiles)).shanten;
    if before < SLOW_BEFORE_MELD {
        return Err(format!(
            "the hand must be {SLOW_BEFORE_MELD}-away or worse before the call, got {before}"
        ));
    }

    let after_pon = skeleton.after_pon();
    if has_side_wait_pair(&after_pon) {
        return Err("the hand must not show a side-wait protorun".to_string());
    }
    if has_triplet(&after_pon) {
        return Err("the hand must not already hold a triplet".to_string());
    }
    let mut seen = Vec::new();
    for discard in after_pon.iter().copied() {
        if seen.contains(&discard) {
            continue;
        }
        seen.push(discard);
        let mut after = after_pon.clone();
        let index = after
            .iter()
            .position(|tile| *tile == discard)
            .ok_or_else(|| "the discard left the hand".to_string())?;
        after.remove(index);
        let shanten = calculate_shanten_with_melds(&to_counts(&after), 1).shanten;
        if shanten < SLOW_AFTER_MELD {
            return Err(format!(
                "discarding {discard} after the Pon leaves the hand {shanten}-away, not slow"
            ));
        }
    }

    // Cheap: no dora in the hand.
    let dora: Vec<Tile> = state
        .dora_indicators
        .iter()
        .filter_map(|code| Tile::try_from(code.as_str()).ok())
        .map(indicator_to_dora)
        .collect();
    if tiles.iter().any(|tile| dora.contains(tile)) {
        return Err("the hand must not hold a dora".to_string());
    }

    if !human.red_fives.is_empty() {
        return Err("the cheap hand holds no red fives".to_string());
    }

    let total_score: i32 = state.players.iter().map(|player| player.score).sum();
    if total_score != 100_000 {
        return Err(format!("scores sum to {total_score}, expected 100000"));
    }

    crate::generator::support::state_validation::validate_reachable_state(state)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::generate;
    use super::*;
    use crate::state::CorrectActionType;

    fn human(state: &GameState) -> &PlayerState {
        state
            .players
            .iter()
            .find(|player| player.is_human)
            .expect("human player")
    }

    fn assert_board(state: &GameState) {
        assert_eq!(state.category, "meld_or_not");
        assert_eq!(state.target_action, TargetAction::Call);
        assert_eq!(state.correct_action.action_type(), CorrectActionType::Pass);
        assert_eq!(state.players.len(), 4);
        assert_eq!(state.riichi_sticks, 0);
        assert_eq!(state.dora_indicators.len(), 1);
        assert_eq!(state.ura_dora_indicators.len(), 1);
        assert!(state.tiles_remaining > 0);

        let human = human(state);
        assert!(human.is_human);
        assert_eq!(human.hand.len(), 13);
        assert!(human.draw.is_none());
        assert!(human.melds.is_empty());
        assert!(!human.is_riichi);
        assert_eq!(state.tiles.len(), 13);
        assert!(state.shanten >= 3);
        assert!(!state.is_agari);
        assert_eq!(
            state.call_offer.as_ref().map(|offer| offer.action.as_str()),
            Some("Pon")
        );

        let offer = state.call_offer.as_ref().expect("offer");
        let DecisionContext::ReactToDiscard { from, tile } = &state.decision else {
            panic!("the lesson is a call reaction");
        };
        assert_eq!(tile, &offer.tile);
        assert_eq!(state.current_turn, *from);
        assert!((1..=3).contains(from));

        let source = &state.players[*from];
        assert_eq!(
            source.discards.last().map(|discard| discard.tile.as_str()),
            Some(offer.tile.as_str())
        );
        assert!(!source.discards.last().expect("last discard").is_tsumogiri);

        // The hand really is slow after the call, for every discard.
        let tiles: Vec<Tile> = human
            .hand
            .iter()
            .map(|code| Tile::try_from(code.as_str()).expect("tile"))
            .collect();
        let dragon = Tile::try_from(offer.tile.as_str()).expect("tile");
        assert_eq!(tiles.iter().filter(|tile| **tile == dragon).count(), 2);

        let mut after_pon = tiles.clone();
        for _ in 0..2 {
            let index = after_pon.iter().position(|tile| *tile == dragon).unwrap();
            after_pon.remove(index);
        }
        assert_eq!(after_pon.len(), 11);
        assert!(!has_side_wait_pair(&after_pon));

        let mut seen = Vec::new();
        for discard in after_pon.clone() {
            if seen.contains(&discard) {
                continue;
            }
            seen.push(discard);
            let mut after = after_pon.clone();
            let index = after.iter().position(|tile| *tile == discard).unwrap();
            after.remove(index);
            assert!(
                calculate_shanten_with_melds(&to_counts(&after), 1).shanten >= 2,
                "discarding {discard} leaves the hand fast"
            );
        }
    }

    #[test]
    fn test_generate_meld_or_not() {
        let state =
            crate::generator::generate_puzzle("meld_or_not").expect("generation must succeed");
        assert_board(&state);

        // The book's rationale is stamped and cites ch. 9.
        let rationale = state.book_rationale.as_ref().expect("rationale");
        assert_eq!(rationale.source.chapter, 9);
        assert!(!rationale.rules.is_empty());
        assert!(!rationale.absent.is_empty());
        assert!(
            rationale
                .rules
                .iter()
                .any(|rule| rule.id == "cheap_and_slow")
        );
    }

    #[test]
    fn test_meld_or_not_constraints_100_runs() {
        let start = std::time::Instant::now();
        for run in 0..100 {
            let state =
                generate("meld_or_not").unwrap_or_else(|err| panic!("run {run} failed: {err}"));
            assert_board(&state);
        }
        let elapsed = start.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(15),
            "100 generations took {elapsed:?}"
        );
    }

    #[test]
    fn every_offering_seat_is_used() {
        let mut seen = [false; 4];
        for _ in 0..120 {
            let state = generate("meld_or_not").expect("generate");
            if let DecisionContext::ReactToDiscard { from, .. } = state.decision {
                seen[from] = true;
            }
        }
        assert!(
            seen[1] && seen[2] && seen[3],
            "all three seats must offer: {seen:?}"
        );
    }
}
