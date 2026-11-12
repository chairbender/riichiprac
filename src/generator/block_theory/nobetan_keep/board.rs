use agari::context::indicator_to_dora;
use agari::parse::to_counts;
use agari::tile::Tile;

use super::skeleton::{NobetanKeepSkeleton, without};
use crate::generator::support::analysis::{HandMetrics, evaluate_counts};
use crate::generator::support::deck::Deck;
use crate::generator::support::format::format_hand_compact;
use crate::generator::support::table::{
    OpponentDeal, deal_opponents, discards_from_tiles, force_tedashi, random_round,
    random_scores_with_human_first, self_turn_river_plan,
};
use crate::rng::gen_range;
use crate::state::{CorrectAction, DecisionContext, GameState, PlayerState, TargetAction, Wind};

/// The validated hand shapes for one nobetan puzzle.
struct PreparedHand {
    /// The thirteen concealed tiles before the discard; the answer is the drawn
    /// tile, so the hand keeps the whole shape.
    human_hand: Vec<Tile>,
    full_tiles: Vec<Tile>,
    metrics: HandMetrics,
}

/// Board-level values chosen after the hand and indicators are fixed.
struct TableContext {
    round_wind: Wind,
    hand_number: u8,
    honba: u8,
    dora_indicator: Tile,
    ura_indicator: Tile,
    scores: [i32; 4],
    human_river: Vec<Tile>,
    /// Human river entries that came from the hand, so they are tedashi.
    human_hand_discards: Vec<usize>,
    deal: OpponentDeal,
    tiles_remaining: u8,
}

/// Builds and validates a complete board for an already-proven hand skeleton.
pub(super) fn build_board(
    category: &str,
    skeleton: &NobetanKeepSkeleton,
) -> Result<GameState, String> {
    let prepared = prepare_hand(skeleton)?;
    let (mut deck, dora_indicator, ura_indicator) = build_deck(skeleton)?;

    let (round_wind, hand_number) = random_round();
    let honba = gen_range(0, 4) as u8;
    let scores = random_scores_with_human_first();

    // The hand is closed and the human is about to discard, so the rivers come
    // from an ordinary rotation with no call in it.
    let discard_count = gen_range(1, 7);
    let plan = self_turn_river_plan(Wind::East, &[], discard_count);
    let deal = deal_opponents(&mut deck, Wind::East, &scores, &plan)
        .ok_or_else(|| "Deck exhausted drawing the opponents".to_string())?;

    // Keep the human's river clear of the answer and of every tile the hand
    // accepts, so the board does not look like a furiten or a spent wait.
    let human_river = deck
        .draw_excluding(plan.counts[0], &wait_tiles(skeleton))
        .ok_or_else(|| "Deck exhausted drawing the human river".to_string())?;

    validate_visible_waits(skeleton, &deal.rivers, dora_indicator)?;

    let tiles_remaining = deck.remaining().saturating_sub(12).min(u8::MAX as usize) as u8;
    if tiles_remaining == 0 {
        return Err("No drawable tiles remain".to_string());
    }

    Ok(assemble_state(
        category,
        skeleton,
        prepared,
        TableContext {
            round_wind,
            hand_number,
            honba,
            dora_indicator,
            ura_indicator,
            scores,
            human_river,
            human_hand_discards: plan.hand_discards[0].clone(),
            deal,
            tiles_remaining,
        },
    ))
}

/// Removes the drawn tile from the concealed hand and evaluates the answer.
fn prepare_hand(skeleton: &NobetanKeepSkeleton) -> Result<PreparedHand, String> {
    // The answer is the tile just drawn: the player draws a float that does
    // nothing and must not throw the stretched single away for it.
    let mut human_hand = skeleton.full_tiles.clone();
    let draw_index = human_hand
        .iter()
        .position(|tile| *tile == skeleton.answer_tile)
        .ok_or_else(|| "Nobetan skeleton is missing its answer tile".to_string())?;
    human_hand.remove(draw_index);
    human_hand.sort();

    // The whole shape must still be in the concealed hand.
    for tile in skeleton.nobetan {
        if !human_hand.contains(&tile) {
            return Err("the stretched single must stay in the hand".to_string());
        }
    }
    if !human_hand.contains(&skeleton.retained_float) {
        return Err("the float beside the pair must stay in the hand".to_string());
    }
    if human_hand.contains(&skeleton.answer_tile) {
        return Err("the answer must not remain in the hand".to_string());
    }

    let mut full_tiles = skeleton.full_tiles.clone();
    full_tiles.sort();

    let post_discard = without(&full_tiles, skeleton.answer_tile)?;
    let metrics = evaluate_counts(&to_counts(&post_discard));

    Ok(PreparedHand {
        human_hand,
        full_tiles,
        metrics,
    })
}

/// Removes the hand from the deck and draws the dora and ura indicators.
fn build_deck(skeleton: &NobetanKeepSkeleton) -> Result<(Deck, Tile, Tile), String> {
    let mut deck = Deck::fresh();
    for tile in &skeleton.full_tiles {
        deck.take(*tile)?;
    }

    // Keep value out of the decision: a dora among the hand tiles would make
    // the shape question a scoring question. Indicators are drawn face up, so
    // drawing past a hand-tile dora costs nothing but a wall tile.
    let mut dora_indicator = None;
    for _ in 0..32 {
        let Some(candidate) = deck.draw() else {
            break;
        };
        if !skeleton.full_tiles.contains(&indicator_to_dora(candidate)) {
            dora_indicator = Some(candidate);
            break;
        }
    }
    let dora_indicator =
        dora_indicator.ok_or_else(|| "Deck exhausted drawing the dora indicator".to_string())?;
    let ura_indicator = deck
        .draw()
        .ok_or_else(|| "Deck exhausted drawing the ura indicator".to_string())?;

    Ok((deck, dora_indicator, ura_indicator))
}

/// Every tile that improves the hand once the answer is discarded, plus the
/// answer itself.
fn wait_tiles(skeleton: &NobetanKeepSkeleton) -> Vec<Tile> {
    let post_discard = match without(&skeleton.full_tiles, skeleton.answer_tile) {
        Ok(tiles) => tiles,
        Err(_) => return vec![skeleton.answer_tile],
    };
    let metrics = evaluate_counts(&to_counts(&post_discard));
    let mut waits: Vec<Tile> = metrics
        .ukeire_tiles
        .iter()
        .filter_map(|tile| Tile::try_from(tile.as_str()).ok())
        .collect();
    waits.push(skeleton.answer_tile);
    waits
}

/// Rejects a hand when an accepted tile is already too visible to draw.
fn validate_visible_waits(
    skeleton: &NobetanKeepSkeleton,
    opponent_rivers: &[Vec<Tile>],
    dora_indicator: Tile,
) -> Result<(), String> {
    for wait in wait_tiles(skeleton) {
        let mut visible = 0;
        for river in opponent_rivers {
            visible += river.iter().filter(|tile| **tile == wait).count();
        }
        if dora_indicator == wait {
            visible += 1;
        }
        if visible > 2 {
            return Err(format!(
                "{visible} copies of accepted tile {wait} are already visible"
            ));
        }
    }

    Ok(())
}

/// Assembles the public `GameState` from the validated pieces.
fn assemble_state(
    category: &str,
    skeleton: &NobetanKeepSkeleton,
    prepared: PreparedHand,
    context: TableContext,
) -> GameState {
    let PreparedHand {
        human_hand,
        full_tiles,
        metrics,
    } = prepared;
    let TableContext {
        round_wind,
        hand_number,
        honba,
        dora_indicator,
        ura_indicator,
        scores,
        human_river,
        human_hand_discards,
        deal,
        tiles_remaining,
    } = context;

    let hand_string = format_hand_compact(&full_tiles);
    let tile_strings: Vec<String> = full_tiles.iter().map(|tile| tile.to_string()).collect();

    let human_player = PlayerState {
        seat: 0,
        name: "You".to_string(),
        is_human: true,
        wind: Wind::East,
        score: scores[0],
        hand: human_hand.iter().map(|tile| tile.to_string()).collect(),
        // The drawn float is the tile the lesson asks about.
        draw: Some(skeleton.answer_tile.to_string()),
        red_fives: Vec::new(),
        discards: {
            let mut discards = discards_from_tiles(&human_river);
            force_tedashi(&mut discards, &human_hand_discards);
            discards
        },
        melds: Vec::new(),
        is_riichi: false,
        riichi_discard_index: None,
    };

    let mut players = Vec::with_capacity(4);
    players.push(human_player);
    players.extend(deal.players);

    GameState {
        category: category.to_string(),
        target_action: TargetAction::NaniKiru,
        // The hand is 2-away, so Riichi is illegal and the discard is the whole
        // question.
        correct_action: CorrectAction::dama(skeleton.answer_tile.to_string()),
        // The answer is unique: every other shape-preserving discard accepts
        // fewer tiles, so none is graded as equivalent.
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
        hand_string,
        tiles: tile_strings,
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
        current_turn: 0,
        players,
    }
}

#[cfg(test)]
mod tests {
    use super::super::generate;
    use super::*;
    use crate::generator::support::completion::can_reach_side_wait;
    use crate::state::CorrectActionType;
    use agari::parse::parse_hand;
    use agari::shanten::{calculate_shanten, calculate_ukeire};

    fn post_discard_tiles(state: &GameState) -> Vec<Tile> {
        let mut tiles = state.tiles.clone();
        let answer = state
            .correct_action
            .tile()
            .expect("answer tile")
            .to_string();
        let index = tiles
            .iter()
            .position(|tile| *tile == answer)
            .expect("answer tile must be in the full hand");
        tiles.remove(index);
        parse_hand(&tiles.join("")).expect("post-discard hand must parse")
    }

    fn assert_nobetan_keep_constraints(state: &GameState) {
        assert_eq!(state.category, "nobetan_keep");
        assert_eq!(state.target_action, TargetAction::NaniKiru);
        assert_eq!(state.correct_action.action_type(), CorrectActionType::Dama);
        assert_eq!(state.tiles.len(), 14);
        assert_eq!(state.players.len(), 4);
        assert_eq!(state.shanten, 2);
        assert!(!state.is_agari);

        // Round constraint: South 2 or earlier.
        match (state.round_wind, state.hand_number) {
            (Wind::East, 1..=4) | (Wind::South, 1..=2) => {}
            other => panic!("invalid round: {other:?}"),
        }
        assert_eq!(state.riichi_sticks, 0);
        assert_eq!(state.dora_indicators.len(), 1);
        assert_eq!(state.ura_dora_indicators.len(), 1);
        assert!(state.tiles_remaining > 0);

        // Threat constraint: no opponent is in riichi or has an open meld.
        for opponent in &state.players[1..] {
            assert!(!opponent.is_riichi, "opponent must not be in riichi");
            assert!(opponent.melds.is_empty(), "opponent must have no melds");
            assert!(opponent.riichi_discard_index.is_none());
        }

        // Closed human hand with a drawn float.
        let human = &state.players[0];
        assert!(human.is_human);
        assert!(!human.is_riichi);
        assert_eq!(human.hand.len(), 13);
        assert!(human.melds.is_empty());
        let draw = human.draw.as_deref().expect("human must have a draw");
        assert_eq!(Some(draw), state.correct_action.tile());
        // The answer is the drawn tile, so it is not in the concealed hand.
        assert!(!human.hand.iter().any(|tile| tile == draw));

        // The answer keeps the whole stretched single in hand.
        let post = post_discard_tiles(state);
        assert_eq!(calculate_shanten(&to_counts(&post)).shanten, 2);
        let starts = super::super::skeleton::nobetan_starts(&post);
        assert_eq!(starts.len(), 1, "the answer must keep one stretched single");
        let (suit, base) = starts[0];
        for value in base..base + 4 {
            let tile = Tile::Suited { suit, value };
            assert!(
                human.hand.iter().any(|held| held == &tile.to_string()),
                "the answer must keep {tile} in hand"
            );
        }

        // Acceptance constraint: the answer accepts less than breaking the
        // shape, so the drill cannot be graded by counting tiles alone.
        let answer_acceptance = calculate_ukeire(&to_counts(&post)).total_count;
        for value in [base, base + 3] {
            let end = Tile::Suited { suit, value }.to_string();
            let mut broken: Vec<String> = state.tiles.clone();
            let index = broken
                .iter()
                .position(|tile| *tile == end)
                .expect("the end must be in the hand");
            broken.remove(index);
            let broken_tiles = parse_hand(&broken.join("")).expect("broken hand must parse");
            assert_eq!(calculate_shanten(&to_counts(&broken_tiles)).shanten, 2);
            assert!(
                calculate_ukeire(&to_counts(&broken_tiles)).total_count > answer_acceptance,
                "breaking {end} must accept more than the answer"
            );
        }

        // Furiten hygiene: the human river holds no accepted tile.
        for discard in &human.discards {
            assert!(
                !state.ukeire_tiles.contains(&discard.tile),
                "human river contains an accepted tile {}",
                discard.tile
            );
        }

        // Value constraint: no hand tile is the dora.
        let indicator = parse_hand(&state.dora_indicators[0])
            .expect("dora indicator must parse")
            .remove(0);
        assert!(
            !state
                .tiles
                .contains(&indicator_to_dora(indicator).to_string())
        );

        // Scores stay on the 100,000-point table.
        let total_score: i32 = state.players.iter().map(|player| player.score).sum();
        assert_eq!(total_score, 100_000);

        // The visible full hand is exactly hand + draw.
        let mut expected: Vec<String> = human.hand.clone();
        expected.push(human.draw.clone().expect("human must have a draw"));
        expected.sort();
        let mut actual = state.tiles.clone();
        actual.sort();
        assert_eq!(actual, expected);

        crate::generator::support::state_validation::validate_reachable_state(state)
            .expect("nobetan keep table must be reachable");
    }

    #[test]
    fn test_generate_puzzle_game_state() {
        let state = generate("nobetan_keep").expect("Puzzle generation must succeed");
        assert_nobetan_keep_constraints(&state);

        // Wait-quality constraint: the kept shape can still reach a side wait.
        // The 100-run loop leaves this out because the two-step enumeration is
        // the expensive part of the proof and the skeleton test covers it.
        assert!(can_reach_side_wait(&post_discard_tiles(&state)));
    }

    #[test]
    fn test_nobetan_keep_constraints_100_runs() {
        let start = std::time::Instant::now();

        for run in 0..100 {
            let state =
                generate("nobetan_keep").unwrap_or_else(|err| panic!("run {run} failed: {err}"));
            assert_nobetan_keep_constraints(&state);
        }

        let elapsed = start.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(20),
            "100 rejected-sample generations took {elapsed:?}"
        );
    }
}
