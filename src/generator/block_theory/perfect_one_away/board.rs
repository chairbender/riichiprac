use agari::context::indicator_to_dora;
use agari::parse::to_counts;
use agari::tile::Tile;

use super::skeleton::Skeleton;
use crate::generator::support::analysis::{HandMetrics, evaluate_counts};
use crate::generator::support::deck::Deck;
use crate::generator::support::format::format_hand_compact;
use crate::generator::support::table::{
    OpponentDeal, deal_opponents, discards_from_tiles, random_round,
    random_scores_with_human_first, self_turn_river_plan,
};
use crate::rng::gen_range;
use crate::state::{CorrectAction, DecisionContext, GameState, PlayerState, TargetAction, Wind};

/// The validated hand shapes for one perfect-1-away puzzle.
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
pub(super) fn build_board(category: &str, skeleton: &Skeleton) -> Result<GameState, String> {
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

    // Keep the human's river clear of every improving tile, so the displayed
    // acceptance is not muddied by the player's own discards.
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
fn prepare_hand(skeleton: &Skeleton) -> Result<PreparedHand, String> {
    if skeleton.concealed_tiles.len() != 13 {
        return Err("a closed hand must hold thirteen concealed tiles".to_string());
    }
    if skeleton.full_tiles.len() != 14 {
        return Err("a turn hand must hold fourteen tiles".to_string());
    }
    if skeleton.answer_acceptance == 0 {
        return Err("the answer's acceptance was never proved".to_string());
    }
    if skeleton.rival_acceptance <= skeleton.answer_acceptance {
        return Err("the rival must accept more tiles than the book's discard".to_string());
    }
    if !skeleton.concealed_tiles.contains(&skeleton.rival_tile) {
        return Err("the rival tile must be in the concealed hand".to_string());
    }
    if skeleton.concealed_tiles.contains(&skeleton.draw) {
        return Err("the draw must not already be in the concealed hand".to_string());
    }
    // The four blocks the skeleton proved must be the hand the board shows.
    for tile in skeleton
        .pair_run
        .iter()
        .chain(skeleton.shared.iter())
        .chain(skeleton.complex_run.iter())
        .chain(skeleton.ryanmen.iter())
    {
        if !skeleton.concealed_tiles.contains(tile) {
            return Err(format!("the {tile} block tile is missing from the hand"));
        }
    }
    for tile in skeleton.ryankan {
        if !skeleton.full_tiles.contains(&tile) {
            return Err(format!("the {tile} double closed shape is missing a tile"));
        }
    }

    let mut human_hand = skeleton.concealed_tiles.clone();
    human_hand.sort();

    let mut full_tiles = skeleton.full_tiles.clone();
    full_tiles.sort();

    let metrics = evaluate_counts(&to_counts(&human_hand));
    if metrics.shanten != 1 {
        return Err("the answer must leave the hand 1-away".to_string());
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
fn build_deck(skeleton: &Skeleton) -> Result<(Deck, Tile, Tile), String> {
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

    // Keep value out of a shape decision: the graded discard is never the dora.
    if indicator_to_dora(dora_indicator) == skeleton.draw {
        return Err("the drawn tile cannot be the dora".to_string());
    }

    Ok((deck, dora_indicator, ura_indicator))
}

/// Every tile that improves the hand once the answer is discarded.
fn wait_tiles(skeleton: &Skeleton) -> Vec<Tile> {
    let metrics = evaluate_counts(&to_counts(&skeleton.concealed_tiles));
    metrics
        .ukeire_tiles
        .iter()
        .filter_map(|tile| Tile::try_from(tile.as_str()).ok())
        .collect()
}

/// Rejects a hand when an improving tile is already too visible to draw.
fn validate_visible_waits(
    skeleton: &Skeleton,
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
    skeleton: &Skeleton,
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
        // The hand is 1-away, so the answer is a plain discard. The lesson has
        // no declaration to make, and `target_action` keeps the report wording
        // at "discard X".
        correct_action: CorrectAction::dama(skeleton.draw.to_string()),
        // The book's discard is the only perfect one; no tile is interchangeable
        // with it.
        equivalent_tiles: Vec::new(),
        decision: DecisionContext::SelfTurn,
        scenario_note: None,
        call_offer: None,
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

#[cfg(test)]
mod tests {
    use super::super::generate;
    use super::*;
    use crate::generator::support::completion::{is_perfect_one_away, perfect_one_away_shape};
    use crate::state::CorrectActionType;
    use agari::parse::parse_hand;
    use agari::shanten::{calculate_shanten, calculate_ukeire};

    fn assert_perfect_one_away_constraints(state: &GameState) {
        assert_eq!(state.category, "perfect_one_away");
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

        // The answer is the tile just drawn.
        let answer = state.correct_action.tile().expect("answer tile");
        assert_eq!(draw, answer, "the book discards the tile it just drew");

        // The thirteen tiles left behind are the book's perfect 1-away.
        let mut post_discard = state.tiles.clone();
        let answer_index = post_discard
            .iter()
            .position(|tile| tile == answer)
            .expect("answer tile must be in the full hand");
        post_discard.remove(answer_index);
        let post_tiles =
            parse_hand(&post_discard.join("")).expect("post-discard hand must parse in agari");
        assert!(
            perfect_one_away_shape(&post_tiles).is_some(),
            "the answer must leave the book's two-side-wait, two-pair shape"
        );
        assert!(is_perfect_one_away(&post_tiles));

        // The answer keeps the hand 1-away.
        assert_eq!(state.shanten, 1);
        assert!(!state.is_agari);
        assert!(!state.can_riichi, "a 1-away closed hand cannot call Riichi");

        // The rivers come from one legal turn order with no calls.
        crate::generator::support::state_validation::validate_reachable_state(state)
            .expect("perfect 1-away table must be reachable");
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

        // Value constraint: the answer is not the dora.
        let indicator = parse_hand(&state.dora_indicators[0])
            .expect("dora indicator must parse")
            .remove(0);
        assert_ne!(
            Some(indicator_to_dora(indicator).to_string().as_str()),
            state.correct_action.tile()
        );

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
        let state = generate("perfect_one_away").expect("Puzzle generation must succeed");

        assert_perfect_one_away_constraints(&state);
    }

    #[test]
    fn test_perfect_one_away_constraints_100_runs() {
        let start = std::time::Instant::now();

        for run in 0..100 {
            let state = generate("perfect_one_away")
                .unwrap_or_else(|err| panic!("run {run} failed: {err}"));
            assert_perfect_one_away_constraints(&state);
        }

        let elapsed = start.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(10),
            "100 rejected-sample generations took {elapsed:?}"
        );
    }

    #[test]
    fn the_kept_side_wait_break_is_the_higher_acceptance_rival() {
        for _ in 0..30 {
            let state = generate("perfect_one_away").expect("generation must succeed");
            let answer = state
                .correct_action
                .tile()
                .expect("answer tile")
                .to_string();

            // The rival keeps the drawn tile and breaks the pair of the
            // protorun plus one, which leaves the shared side wait intact.
            let draw = Tile::try_from(answer.as_str()).expect("the answer must be a tile");
            let mut full: Vec<Tile> = state
                .tiles
                .iter()
                .filter_map(|code| Tile::try_from(code.as_str()).ok())
                .collect();
            full.sort();

            let answer_hand: Vec<Tile> = {
                let mut hand = full.clone();
                let index = hand.iter().position(|tile| *tile == draw).unwrap();
                hand.remove(index);
                hand
            };
            let answer_acceptance = calculate_ukeire(&to_counts(&answer_hand)).total_count;
            assert_eq!(answer_acceptance, state.ukeire_total);

            // Every other discard that stays 1-away is not perfect, and the
            // best of them accepts more than the book's discard.
            let mut best_rival: Option<u8> = None;
            let mut seen: Vec<Tile> = Vec::new();
            for discard in &full {
                if *discard == draw || seen.contains(discard) {
                    continue;
                }
                seen.push(*discard);
                let mut hand = full.clone();
                let index = hand.iter().position(|tile| tile == discard).unwrap();
                hand.remove(index);
                if calculate_shanten(&to_counts(&hand)).shanten != 1 {
                    continue;
                }
                assert!(
                    !is_perfect_one_away(&hand),
                    "discarding {discard} would also leave the perfect hand"
                );
                let total = calculate_ukeire(&to_counts(&hand)).total_count;
                best_rival = Some(match best_rival {
                    Some(best) => best.max(total),
                    None => total,
                });
            }
            let best_rival = best_rival.expect("a 1-away hand must have another discard");
            assert!(
                best_rival > answer_acceptance,
                "the rival must accept more tiles ({best_rival} vs {answer_acceptance})"
            );
        }
    }
}
