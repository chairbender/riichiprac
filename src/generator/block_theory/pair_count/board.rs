use agari::context::indicator_to_dora;
use agari::parse::to_counts;
use agari::tile::Tile;

use super::skeleton::PairCountSkeleton;
use crate::generator::support::analysis::{HandMetrics, evaluate_counts};
use crate::generator::support::deck::Deck;
use crate::generator::support::format::format_hand_compact;
use crate::generator::support::table::{
    OpponentDeal, deal_opponents, discards_from_tiles, random_round,
    random_scores_with_human_first, self_turn_river_plan,
};
use crate::rng::gen_range;
use crate::state::{CorrectAction, DecisionContext, GameState, PlayerState, TargetAction, Wind};

/// The validated hand shapes for one three-pair puzzle.
struct PreparedHand {
    /// The thirteen concealed tiles before the discard; the answer is the
    /// separately drawn fourteenth tile.
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
    deal: OpponentDeal,
    tiles_remaining: u8,
}

/// Builds and validates a complete board for an already-proven hand skeleton.
pub(super) fn build_board(
    category: &str,
    skeleton: &PairCountSkeleton,
) -> Result<GameState, String> {
    let prepared = prepare_hand(skeleton)?;
    let (mut deck, dora_indicator, ura_indicator) = build_deck(skeleton)?;

    let (round_wind, hand_number) = random_round();
    let honba = gen_range(0, 4) as u8;
    let scores = random_scores_with_human_first();

    // The hand is closed, so every river follows the natural rotation.
    let discard_count = gen_range(1, 7);
    let plan = self_turn_river_plan(Wind::East, &[], discard_count);
    let deal = deal_opponents(&mut deck, Wind::East, &scores, &plan)
        .ok_or_else(|| "Deck exhausted drawing the opponents".to_string())?;

    // Keep the human's river clear of every improving tile. With the hand still
    // 2-away this is hygiene rather than furiten, but it keeps the displayed
    // acceptance honest.
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
            deal,
            tiles_remaining,
        },
    ))
}

/// Checks the hand is the shape the skeleton proved, then evaluates the answer.
fn prepare_hand(skeleton: &PairCountSkeleton) -> Result<PreparedHand, String> {
    if skeleton.answer_tile != skeleton.draw {
        return Err("the answer must be the tile just drawn".to_string());
    }

    let mut human_hand = skeleton.concealed_tiles.clone();
    human_hand.sort();
    if human_hand.len() != 13 {
        return Err("a closed hand must hold thirteen concealed tiles".to_string());
    }
    if !human_hand.contains(&skeleton.draw) {
        return Err("the drawn tile's partner must stay in the hand".to_string());
    }
    for pair in skeleton.pairs {
        if !human_hand.contains(&pair) {
            return Err(format!("the {pair} pair must be in the hand"));
        }
    }
    for tile in &skeleton.equivalent_tiles {
        if !human_hand.contains(tile) {
            return Err(format!("the {tile} pair must stay in the hand"));
        }
    }
    // The side wait must survive the discard, and the rest of the hand must be
    // exactly the blocks the skeleton proved.
    if !human_hand.contains(&skeleton.ryanmen[1]) {
        return Err("the side wait's other tile must survive the discard".to_string());
    }
    for tile in skeleton
        .completed_run
        .iter()
        .chain(skeleton.protoruns.iter().flatten())
    {
        if !human_hand.contains(tile) {
            return Err(format!("the {tile} block tile must stay in the hand"));
        }
    }
    if skeleton.rival_acceptance >= skeleton.answer_acceptance {
        return Err("keeping three pairs must accept fewer tiles".to_string());
    }

    let mut full_tiles = skeleton.full_tiles.clone();
    full_tiles.sort();

    let post_discard_tiles = without(&full_tiles, skeleton.answer_tile)?;
    let metrics = evaluate_counts(&to_counts(&post_discard_tiles));
    if metrics.shanten != 2 {
        return Err("the answer must leave the hand 2-away".to_string());
    }
    if metrics.ukeire_total != skeleton.answer_acceptance {
        return Err(format!(
            "the board's acceptance {} disagrees with the proved {}",
            metrics.ukeire_total, skeleton.answer_acceptance
        ));
    }

    Ok(PreparedHand {
        human_hand,
        full_tiles,
        metrics,
    })
}

/// Removes the hand from the deck and draws the dora and ura indicators.
fn build_deck(skeleton: &PairCountSkeleton) -> Result<(Deck, Tile, Tile), String> {
    let mut deck = Deck::fresh();
    for tile in &skeleton.full_tiles {
        deck.take(*tile)?;
    }

    let dora_indicator = deck
        .draw()
        .ok_or_else(|| "Deck exhausted drawing the dora indicator".to_string())?;
    let ura_indicator = deck
        .draw()
        .ok_or_else(|| "Deck exhausted drawing the ura indicator".to_string())?;

    // Keep value out of a shape decision: no graded discard may be the dora.
    let dora = indicator_to_dora(dora_indicator);
    if dora == skeleton.answer_tile || skeleton.equivalent_tiles.contains(&dora) {
        return Err("a pair tile cannot be the dora".to_string());
    }

    Ok((deck, dora_indicator, ura_indicator))
}

/// Every tile that improves the hand once the answer is discarded.
fn wait_tiles(skeleton: &PairCountSkeleton) -> Vec<Tile> {
    let post_discard = match without(&skeleton.full_tiles, skeleton.answer_tile) {
        Ok(tiles) => tiles,
        Err(_) => return Vec::new(),
    };
    let metrics = evaluate_counts(&to_counts(&post_discard));
    metrics
        .ukeire_tiles
        .iter()
        .filter_map(|tile| Tile::try_from(tile.as_str()).ok())
        .collect()
}

/// Rejects a hand when an improving tile is already too visible to draw.
fn validate_visible_waits(
    skeleton: &PairCountSkeleton,
    opponent_rivers: &[Vec<Tile>],
    dora_indicator: Tile,
) -> Result<(), String> {
    for wait in wait_tiles(skeleton) {
        let mut visible = 0;
        for river in opponent_rivers {
            visible += river.iter().filter(|tile| **tile == wait).count();
        }
        // The indicator is face up, so it is a visible copy as well.
        if dora_indicator == wait {
            visible += 1;
        }
        if visible > 2 {
            return Err(format!(
                "{visible} copies of wait tile {wait} are already visible"
            ));
        }
    }

    Ok(())
}

/// Assembles the public `GameState` from the validated pieces.
fn assemble_state(
    category: &str,
    skeleton: &PairCountSkeleton,
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
        deal,
        tiles_remaining,
    } = context;

    let hand_string = format_hand_compact(&full_tiles);
    let tile_strings: Vec<String> = full_tiles.iter().map(|tile| tile.to_string()).collect();
    let equivalent_tiles: Vec<String> = skeleton
        .equivalent_tiles
        .iter()
        .map(|tile| tile.to_string())
        .collect();

    let human_player = PlayerState {
        seat: 0,
        name: "You".to_string(),
        is_human: true,
        wind: Wind::East,
        score: scores[0],
        hand: human_hand.iter().map(|tile| tile.to_string()).collect(),
        draw: Some(skeleton.draw.to_string()),
        red_fives: Vec::new(),
        discards: discards_from_tiles(&human_river),
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
        // Stamped by `finalize_state` from the legal action set.
        can_riichi: false,
        // The hand is 2-away, so the answer is a plain discard. The lesson has
        // no declaration to make, and `target_action` keeps the report wording
        // at "discard X".
        correct_action: CorrectAction::dama(skeleton.answer_tile.to_string()),
        // Breaking either of the other two pairs leaves the identical two-pair
        // hand, so the pair choice itself is not graded.
        equivalent_tiles,
        decision: DecisionContext::SelfTurn,
        ai_decision: None,
        riichi_triggers: Vec::new(),
        dama_reasons: Vec::new(),
        shouminkan_triggers: Vec::new(),
        book_rationale: None,
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

/// Removes one copy of `discard` from `tiles`.
fn without(tiles: &[Tile], discard: Tile) -> Result<Vec<Tile>, String> {
    let mut remaining = tiles.to_vec();
    let index = remaining
        .iter()
        .position(|tile| *tile == discard)
        .ok_or_else(|| format!("{discard} is not in the hand"))?;
    remaining.remove(index);
    Ok(remaining)
}

#[cfg(test)]
mod tests {
    use super::super::generate;
    use super::*;
    use crate::state::CorrectActionType;
    use agari::parse::parse_hand;
    use agari::shanten::{calculate_shanten, calculate_ukeire};
    use std::collections::BTreeMap;

    fn pairs_in(tiles: &[String]) -> Vec<String> {
        let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
        for tile in tiles {
            *counts.entry(tile.as_str()).or_insert(0) += 1;
        }
        counts
            .into_iter()
            .filter(|(_, count)| *count == 2)
            .map(|(tile, _)| tile.to_string())
            .collect()
    }

    fn assert_pair_count_constraints(state: &GameState) {
        assert_eq!(state.category, "pair_count");
        assert_eq!(state.target_action, TargetAction::NaniKiru);
        assert_eq!(state.correct_action.action_type(), CorrectActionType::Dama);
        assert_eq!(state.tiles.len(), 14);
        assert_eq!(state.players.len(), 4);

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

        // The human hand is closed: thirteen concealed tiles plus a draw.
        let human = &state.players[0];
        assert!(human.is_human);
        assert!(!human.is_riichi);
        assert_eq!(human.hand.len(), 13);
        assert!(human.melds.is_empty(), "the lesson is the closed hand");
        let draw = human.draw.clone().expect("the human must have drawn");

        // The answer is the tile just drawn, and the hand holds its partner.
        let answer = state.correct_action.tile().expect("answer tile");
        assert_eq!(draw, answer, "the book discards the tile it just drew");
        assert!(
            human.hand.iter().any(|tile| tile == answer),
            "the pair partner must still be in the hand"
        );

        // The drawn hand holds exactly three pairs; the answer breaks one.
        let pairs = pairs_in(&state.tiles);
        assert_eq!(pairs.len(), 3, "the hand must hold three pairs: {pairs:?}");
        assert!(pairs.contains(&answer.to_string()));

        let mut post_discard = state.tiles.clone();
        let answer_index = post_discard
            .iter()
            .position(|tile| tile == answer)
            .expect("answer tile must be in the full hand");
        post_discard.remove(answer_index);
        assert_eq!(
            pairs_in(&post_discard).len(),
            2,
            "the answer must leave two pairs"
        );

        // Every equivalent tile breaks a pair for the same hand shape too.
        for equivalent in &state.equivalent_tiles {
            assert!(pairs.contains(equivalent));
            let mut alternative = state.tiles.clone();
            let index = alternative
                .iter()
                .position(|tile| tile == equivalent)
                .expect("equivalent tile must be in the full hand");
            alternative.remove(index);
            assert_eq!(pairs_in(&alternative).len(), 2);
        }

        // The answer keeps the hand 2-away.
        assert_eq!(state.shanten, 2);
        assert!(!state.is_agari);
        assert!(!state.can_riichi, "a 2-away closed hand cannot call Riichi");

        // The rivers come from one legal turn order with no calls.
        crate::generator::support::state_validation::validate_reachable_state(state)
            .expect("pair count table must be reachable");
        let discard_counts: Vec<usize> = state
            .players
            .iter()
            .map(|player| player.discards.len())
            .collect();
        assert!((1..=6).contains(&discard_counts[0]));
        assert_eq!(
            discard_counts[0], discard_counts[1],
            "a closed hand has no call to bend the rotation"
        );

        // Hygiene: the human river holds no improving tile.
        for discard in &human.discards {
            assert!(
                !state.ukeire_tiles.contains(&discard.tile),
                "human river contains an improving tile {}",
                discard.tile
            );
        }

        // Wait chance constraint: at most two copies of any improving tile are
        // visible in the opponent rivers or the dora indicator.
        let indicator = state.dora_indicators[0].clone();
        for wait in &state.ukeire_tiles {
            let mut visible = 0;
            for opponent in &state.players[1..] {
                for discard in &opponent.discards {
                    if &discard.tile == wait {
                        visible += 1;
                    }
                }
            }
            if &indicator == wait {
                visible += 1;
            }
            assert!(visible <= 2, "{visible} copies of wait {wait} are visible");
        }

        // Value constraint: no graded discard is the dora.
        let indicator = parse_hand(&state.dora_indicators[0])
            .expect("dora indicator must parse")
            .remove(0);
        let dora = indicator_to_dora(indicator).to_string();
        assert_ne!(Some(dora.as_str()), state.correct_action.tile());
        assert!(!state.equivalent_tiles.contains(&dora));

        // Scores stay on the 100,000-point table.
        let total_score: i32 = state.players.iter().map(|player| player.score).sum();
        assert_eq!(total_score, 100_000);

        // The visible full hand is exactly hand + draw.
        let mut expected: Vec<String> = human.hand.clone();
        expected.push(draw);
        expected.sort();
        let mut actual = state.tiles.clone();
        actual.sort();
        assert_eq!(actual, expected);
    }

    #[test]
    fn test_generate_puzzle_game_state() {
        let state = generate("pair_count").expect("Puzzle generation must succeed");

        assert_pair_count_constraints(&state);
        assert_eq!(state.shanten, 2);
        assert!(
            state
                .tiles
                .iter()
                .any(|tile| Some(tile.as_str()) == state.correct_action.tile())
        );

        // The post-discard hand is still 2-away and its acceptance is live.
        let mut post_discard = state.tiles.clone();
        let answer = state
            .correct_action
            .tile()
            .expect("answer tile")
            .to_string();
        let answer_index = post_discard
            .iter()
            .position(|tile| *tile == answer)
            .expect("answer tile must be in the full hand");
        post_discard.remove(answer_index);
        let post_tiles =
            parse_hand(&post_discard.join("")).expect("post-discard hand must parse in agari");
        let counts = to_counts(&post_tiles);
        assert_eq!(calculate_shanten(&counts).shanten, 2);
        let ukeire = calculate_ukeire(&counts);
        assert!(!ukeire.tiles.is_empty());
        assert!(ukeire.total_count > 0);
    }

    #[test]
    fn test_pair_count_constraints_100_runs() {
        let start = std::time::Instant::now();

        for run in 0..100 {
            let state =
                generate("pair_count").unwrap_or_else(|err| panic!("run {run} failed: {err}"));
            assert_pair_count_constraints(&state);
        }

        let elapsed = start.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(10),
            "100 rejected-sample generations took {elapsed:?}"
        );
    }

    #[test]
    fn keeping_three_pairs_accepts_fewer_tiles_than_breaking_one() {
        for _ in 0..30 {
            let state = generate("pair_count").expect("generation must succeed");
            let answer = state
                .correct_action
                .tile()
                .expect("answer tile")
                .to_string();

            // The rival is the answer's pair partner: discarding it keeps the
            // new pair and drops the side wait.
            let Tile::Suited { suit, value } =
                Tile::try_from(answer.as_str()).expect("the answer must be a suited tile")
            else {
                panic!("the drawn tile must be suited");
            };
            let partner = Tile::Suited {
                suit,
                value: value + 1,
            };
            assert!(
                state.tiles.contains(&partner.to_string()),
                "the ryanmen partner must be in the hand"
            );

            let mut hand = state.tiles.clone();
            let partner_index = hand
                .iter()
                .position(|tile| *tile == partner.to_string())
                .expect("partner must be in the hand");
            hand.remove(partner_index);
            assert_eq!(pairs_in(&hand).len(), 3, "the rival keeps three pairs");

            let tiles = parse_hand(&hand.join("")).expect("hand must parse");
            let rival_total = calculate_ukeire(&to_counts(&tiles)).total_count;
            assert!(
                rival_total < state.ukeire_total,
                "keeping three pairs accepts {rival_total}, breaking one accepts {}",
                state.ukeire_total
            );
        }
    }
}
