//! Table assembly for the floating-sanshoku lesson.

use agari::parse::to_counts;
use agari::tile::Tile;

use super::skeleton::{SanshokuSkeleton, analyze};
use crate::generator::support::analysis::{HandMetrics, evaluate_counts};
use crate::generator::support::deck::Deck;
use crate::generator::support::format::format_hand_compact;
use crate::generator::support::table::{
    OpponentDeal, deal_opponents, discards_from_tiles, random_round,
    random_scores_with_human_first, self_turn_river_plan,
};
use crate::rng::gen_range;
use crate::state::{CorrectAction, DecisionContext, GameState, PlayerState, TargetAction, Wind};

/// The hand shapes validated for one floating-sanshoku puzzle.
struct PreparedHand {
    /// The 13 concealed tiles before the discard.
    human_hand: Vec<Tile>,
    full_tiles: Vec<Tile>,
    /// Metrics of the hand after the answer discard.
    metrics: HandMetrics,
}

/// Board-level values chosen after the hand and indicator are fixed.
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

/// Builds and validates a complete board for an already-proven skeleton.
pub(super) fn build_board(
    category: &str,
    skeleton: &SanshokuSkeleton,
) -> Result<GameState, String> {
    let prepared = prepare_hand(skeleton)?;
    let (mut deck, ura_indicator) = build_deck(skeleton)?;

    let (round_wind, hand_number) = random_round();
    let honba = gen_range(0, 4) as u8;
    let scores = random_scores_with_human_first();

    // The human is one away from tenpai before the draw, so no call is needed;
    // the river follows a plain rotation.
    let discard_count = gen_range(1, 7);
    let plan = self_turn_river_plan(Wind::East, &[], discard_count);
    let deal = deal_opponents(&mut deck, Wind::East, &scores, &plan)
        .ok_or_else(|| "Deck exhausted drawing the opponents".to_string())?;

    // Keep the human's river clear of every winning tile on either candidate
    // line. The hand is tenpai, so this is furiten hygiene as well as a
    // distraction remover.
    let wait_tiles = candidate_waits(skeleton)?;
    let human_river = deck
        .draw_excluding(plan.counts[0], &wait_tiles)
        .ok_or_else(|| "Deck exhausted drawing the human river".to_string())?;

    validate_visible_waits(&wait_tiles, &deal.rivers, skeleton.dora_indicator)?;

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
            dora_indicator: skeleton.dora_indicator,
            ura_indicator,
            scores,
            human_river,
            deal,
            tiles_remaining,
        },
    ))
}

/// Removes the drawn tile from the concealed hand and evaluates the answer.
fn prepare_hand(skeleton: &SanshokuSkeleton) -> Result<PreparedHand, String> {
    if skeleton.answer == skeleton.draw {
        return Err("the answer cannot be the tile just drawn".to_string());
    }
    if !skeleton.hand_tiles.contains(&skeleton.answer) {
        return Err("the answer must be in the concealed hand".to_string());
    }
    if !skeleton.full_tiles.contains(&skeleton.answer) {
        return Err("the answer must be in the full hand".to_string());
    }

    let mut full_tiles = skeleton.full_tiles.clone();
    full_tiles.sort();
    let post_discard = without(&full_tiles, skeleton.answer)?;
    let metrics = evaluate_counts(&to_counts(&post_discard));

    Ok(PreparedHand {
        human_hand: skeleton.hand_tiles.clone(),
        full_tiles,
        metrics,
    })
}

/// Removes the hand from the deck and draws the ura indicator.
fn build_deck(skeleton: &SanshokuSkeleton) -> Result<(Deck, Tile), String> {
    let mut deck = Deck::fresh();
    for tile in &skeleton.full_tiles {
        deck.take(*tile)?;
    }
    deck.take(skeleton.dora_indicator)?;
    // The ura indicator is hidden and never used by the answer, so any
    // remaining tile is fine.
    let ura_indicator = deck
        .draw()
        .ok_or_else(|| "Deck exhausted drawing the ura indicator".to_string())?;
    Ok((deck, ura_indicator))
}

/// Every winning tile of the hand's tenpai discards.
fn candidate_waits(skeleton: &SanshokuSkeleton) -> Result<Vec<Tile>, String> {
    let facts = analyze(skeleton)?;
    let mut waits = Vec::new();
    for line in &facts.lines {
        for wait in line.waits() {
            if !waits.contains(&wait) {
                waits.push(wait);
            }
        }
    }
    Ok(waits)
}

/// Rejects a hand when a winning tile is already too visible to draw.
fn validate_visible_waits(
    waits: &[Tile],
    opponent_rivers: &[Vec<Tile>],
    dora_indicator: Tile,
) -> Result<(), String> {
    for wait in waits {
        let mut visible = 0;
        for river in opponent_rivers {
            visible += river.iter().filter(|tile| *tile == wait).count();
        }
        if dora_indicator == *wait {
            visible += 1;
        }
        if visible > 2 {
            return Err(format!(
                "{visible} copies of winning tile {wait} are already visible"
            ));
        }
    }
    Ok(())
}

/// Assembles the public `GameState` from the validated pieces.
fn assemble_state(
    category: &str,
    skeleton: &SanshokuSkeleton,
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
        // The answer is the discard alone: the book compares two waits, not a
        // Riichi declaration. A closed tenpai hand may still arm Riichi in the
        // UI; the graded answer is the plain discard.
        correct_action: CorrectAction::dama(skeleton.answer.to_string()),
        equivalent_tiles: Vec::new(),
        decision: DecisionContext::SelfTurn,
        scenario_note: None,
        call_offer: None,
        ai_decision: None,
        riichi_triggers: Vec::new(),
        dama_reasons: Vec::new(),
        shouminkan_triggers: Vec::new(),
        book_rationale: None,
        // Stamped by `finalize_state` from the legal action set.
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
    use super::*;
    use crate::generator::generate_puzzle as generate;
    use crate::generator::support::yaku::discard_lines;
    use crate::state::CorrectActionType;
    use agari::parse::parse_hand;
    use agari::shanten::calculate_shanten;
    use agari::yaku::Yaku;

    fn assert_sanshoku_pursuit_constraints(state: &GameState) {
        assert_eq!(state.category, "sanshoku_pursuit");
        assert_eq!(state.target_action, TargetAction::NaniKiru);
        assert_eq!(state.correct_action.action_type(), CorrectActionType::Dama);
        assert_eq!(state.tiles.len(), 14);
        assert_eq!(state.players.len(), 4);

        match (state.round_wind, state.hand_number) {
            (Wind::East, 1..=4) | (Wind::South, 1..=2) => {}
            other => panic!("invalid round: {other:?}"),
        }
        assert_eq!(state.riichi_sticks, 0);
        assert_eq!(state.dora_indicators.len(), 1);
        assert_eq!(state.ura_dora_indicators.len(), 1);
        assert!(state.tiles_remaining > 0);

        // No opponent threat or open hand: the lesson is the hand's value.
        for opponent in &state.players[1..] {
            assert!(!opponent.is_riichi);
            assert!(opponent.melds.is_empty());
            assert!(opponent.riichi_discard_index.is_none());
        }

        let human = &state.players[0];
        assert!(human.is_human);
        assert!(!human.is_riichi);
        assert_eq!(human.hand.len(), 13);
        assert!(human.draw.is_some());
        assert!(human.melds.is_empty());

        let answer = state.correct_action.tile().expect("answer tile");
        assert!(human.hand.iter().any(|tile| tile == answer));
        assert_ne!(human.draw.as_deref(), Some(answer));

        // The 14-tile hand is tenpai with an extra tile; the answer leaves
        // tenpai, not a step back.
        let full_tiles: Vec<Tile> = state
            .tiles
            .iter()
            .map(|code| Tile::try_from(code.as_str()).expect("tile code"))
            .collect();
        assert_eq!(calculate_shanten(&to_counts(&full_tiles)).shanten, 0);
        assert_eq!(state.shanten, 0);

        let indicators: Vec<Tile> = state
            .dora_indicators
            .iter()
            .map(|code| Tile::try_from(code.as_str()).expect("indicator"))
            .collect();
        let lines = discard_lines(&full_tiles, state.round_wind, human.wind, &indicators, 0);
        let answer_line = lines
            .iter()
            .find(|line| line.discard.to_string() == answer)
            .expect("the answer must leave tenpai");
        assert!(!answer_line.wins.is_empty());

        // The two teaching waits must be reachable from the table.
        for wait in &answer_line.wins {
            let wait = wait.wait;
            let visible = human
                .discards
                .iter()
                .filter(|discard| discard.tile == wait.to_string())
                .count();
            assert_eq!(visible, 0, "the human river contains winning tile {wait}");
        }

        // The answer is the book's gate, not an arbitrary discard.
        let facts = super::super::facts(state).expect("facts");
        assert_eq!(facts.answer.to_string(), answer);
        assert_eq!(facts.chases, !facts.has_other_value);

        // The chase line is the sanshoku line, the efficiency line is pinfu.
        let chase = lines
            .iter()
            .find(|line| line.discard == facts.chase_discard)
            .expect("chase line");
        let efficiency = lines
            .iter()
            .find(|line| line.discard == facts.efficiency_discard)
            .expect("efficiency line");
        assert!(chase.all_have(Yaku::SanshokuDoujun));
        assert!(!chase.has(Yaku::Pinfu));
        assert!(efficiency.all_have(Yaku::Pinfu));
        assert!(!efficiency.has(Yaku::SanshokuDoujun));

        // A closed tenpai hand may declare Riichi; the graded answer stays the
        // plain discard.
        assert!(state.can_riichi);

        crate::generator::support::state_validation::validate_reachable_state(state)
            .expect("sanshoku table must be reachable");

        let total_score: i32 = state.players.iter().map(|player| player.score).sum();
        assert_eq!(total_score, 100_000);

        let mut expected: Vec<String> = human.hand.clone();
        expected.push(human.draw.clone().expect("human must have a draw"));
        expected.sort();
        let mut actual = state.tiles.clone();
        actual.sort();
        assert_eq!(actual, expected);
    }

    #[test]
    fn test_generate_puzzle_game_state() {
        let state = generate("sanshoku_pursuit").expect("Puzzle generation must succeed");
        assert_sanshoku_pursuit_constraints(&state);

        let full = parse_hand(&state.tiles.join("")).expect("full hand must parse");
        assert_eq!(full.len(), 14);
    }

    #[test]
    fn test_sanshoku_pursuit_constraints_100_runs() {
        let start = std::time::Instant::now();

        for run in 0..100 {
            let state = generate("sanshoku_pursuit")
                .unwrap_or_else(|err| panic!("run {run} failed: {err}"));
            assert_sanshoku_pursuit_constraints(&state);
        }

        let elapsed = start.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(20),
            "100 generations took {elapsed:?}"
        );
    }

    #[test]
    fn the_answer_is_not_a_second_teaching_line() {
        for _ in 0..40 {
            let state = generate("sanshoku_pursuit").expect("generation must succeed");
            let facts = super::super::facts(&state).expect("facts");

            // The answer must be one of the two candidate discards.
            assert!(
                facts.answer == facts.chase_discard || facts.answer == facts.efficiency_discard
            );

            // The gate, not the tile order, picks the answer.
            assert_eq!(facts.chases, facts.dora == 0 && facts.other_yaku.is_empty());
        }
    }
}
