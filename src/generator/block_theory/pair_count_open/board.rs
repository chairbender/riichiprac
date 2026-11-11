use agari::context::indicator_to_dora;
use agari::parse::to_counts;
use agari::tile::Tile;

use super::skeleton::{PairCountOpenSkeleton, TARGET_LIVE_COPIES};
use crate::display::format_tile_for_display;
use crate::generator::support::analysis::{HandMetrics, evaluate_counts};
use crate::generator::support::deck::Deck;
use crate::generator::support::format::format_hand_compact;
use crate::generator::support::table::{
    OpponentDeal, deal_opponents, discards_from_tiles, random_round,
    random_scores_with_human_first, self_turn_river_plan,
};
use crate::rng::gen_range;
use crate::state::{CorrectAction, DecisionContext, GameState, PlayerState, TargetAction, Wind};

/// The validated hand shapes for one open-hand three-pair puzzle.
struct PreparedHand {
    /// The thirteen concealed tiles before the draw; the answer is one of them.
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
    skeleton: &PairCountOpenSkeleton,
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

    // Keep the human's river clear of every improving tile. The hand is still
    // 2-away, so this is hygiene rather than furiten.
    let human_river = deck
        .draw_excluding(plan.counts[0], &wait_tiles(skeleton))
        .ok_or_else(|| "Deck exhausted drawing the human river".to_string())?;

    validate_visible_waits(skeleton, &deal.rivers, dora_indicator)?;
    validate_target_is_live(skeleton, &deal.rivers, dora_indicator)?;

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
fn prepare_hand(skeleton: &PairCountOpenSkeleton) -> Result<PreparedHand, String> {
    if skeleton.answer_tile == skeleton.draw {
        return Err("the answer must not be the tile just drawn".to_string());
    }

    let mut human_hand = skeleton.concealed_tiles.clone();
    human_hand.sort();
    if human_hand.len() != 13 {
        return Err("a closed hand must hold thirteen concealed tiles".to_string());
    }
    if !human_hand.contains(&skeleton.answer_tile) {
        return Err("the answer tile must be in the concealed hand".to_string());
    }
    if !human_hand.contains(&skeleton.draw) {
        return Err("the drawn tile's partner must stay in the hand".to_string());
    }
    for pair in skeleton.pairs {
        let expected = if pair == skeleton.pairs[1] { 1 } else { 2 };
        if human_hand.iter().filter(|tile| **tile == pair).count() != expected {
            return Err(format!("the {pair} pair must be in the hand"));
        }
    }
    if !human_hand.contains(&skeleton.float) {
        return Err(format!(
            "the {} float must stay in the hand",
            skeleton.float
        ));
    }
    for tile in skeleton
        .kanchan
        .iter()
        .chain(skeleton.ryanmen.iter())
        .chain(skeleton.completed_run.iter())
    {
        if !human_hand.contains(tile) {
            return Err(format!("the {tile} block tile must stay in the hand"));
        }
    }
    for tile in &skeleton.equivalent_tiles {
        if !human_hand.contains(tile) {
            return Err(format!("the {tile} equivalent discard must be in the hand"));
        }
    }

    let mut full_tiles = skeleton.full_tiles.clone();
    full_tiles.sort();

    let post_discard_tiles = without(&full_tiles, skeleton.answer_tile)?;
    let metrics = evaluate_counts(&to_counts(&post_discard_tiles));
    if metrics.shanten != 2 {
        return Err("the answer must leave the hand 2-away".to_string());
    }
    if metrics.ukeire_total != skeleton.answer_closed_acceptance {
        return Err(format!(
            "the board's acceptance {} disagrees with the proved {}",
            metrics.ukeire_total, skeleton.answer_closed_acceptance
        ));
    }

    Ok(PreparedHand {
        human_hand,
        full_tiles,
        metrics,
    })
}

/// Removes the hand from the deck and draws the dora and ura indicators.
fn build_deck(skeleton: &PairCountOpenSkeleton) -> Result<(Deck, Tile, Tile), String> {
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

    // Keep value out of a shape decision: no graded discard and no Pon target
    // may be the dora.
    let dora = indicator_to_dora(dora_indicator);
    if dora == skeleton.answer_tile
        || skeleton.equivalent_tiles.contains(&dora)
        || dora == skeleton.pon_target
    {
        return Err("a lesson tile cannot be the dora".to_string());
    }

    Ok((deck, dora_indicator, ura_indicator))
}

/// Every tile that improves the hand once the answer is discarded.
fn wait_tiles(skeleton: &PairCountOpenSkeleton) -> Vec<Tile> {
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
    skeleton: &PairCountOpenSkeleton,
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

/// Keeps both copies of the Pon target live and unseen.
///
/// The hand holds two dragons, so an opponent must still be able to discard one
/// of the other two for the plan to be real. Neither river nor the face-up dora
/// indicator may show a copy.
fn validate_target_is_live(
    skeleton: &PairCountOpenSkeleton,
    opponent_rivers: &[Vec<Tile>],
    dora_indicator: Tile,
) -> Result<(), String> {
    if dora_indicator == skeleton.pon_target {
        return Err("the Pon target cannot be the dora indicator".to_string());
    }
    for river in opponent_rivers {
        if river.contains(&skeleton.pon_target) {
            return Err("an opponent already discarded the Pon target".to_string());
        }
    }

    let held = skeleton
        .full_tiles
        .iter()
        .filter(|tile| **tile == skeleton.pon_target)
        .count();
    if 4 - held < TARGET_LIVE_COPIES as usize {
        return Err("not enough live copies of the Pon target".to_string());
    }

    Ok(())
}

/// Assembles the public `GameState` from the validated pieces.
fn assemble_state(
    category: &str,
    skeleton: &PairCountOpenSkeleton,
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
    let target = format_tile_for_display(&skeleton.pon_target.to_string(), false);
    let scenario_note = format!(
        "You hold a {target} pair and intend to Pon as soon as an opponent discards a third \
         one. Which tile do you discard, keeping that plan in mind?"
    );

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
        // The hand is 2-away, so the answer is a plain discard. The Pon is a
        // plan, not a declaration the player can make this turn.
        correct_action: CorrectAction::dama(skeleton.answer_tile.to_string()),
        // Discarding the redundant float first is the same two discards in the
        // other order, so it is graded as the same answer.
        equivalent_tiles,
        decision: DecisionContext::SelfTurn,
        scenario_note: Some(scenario_note),
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
    use super::super::skeleton::{TARGET_LIVE_COPIES, best_follow_up_pairs, pon_line};
    use super::*;
    use crate::state::CorrectActionType;
    use agari::parse::parse_hand;
    use agari::shanten::calculate_ukeire;
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

    fn parse_tiles(tiles: &[String]) -> Vec<Tile> {
        tiles
            .iter()
            .map(|tile| Tile::try_from(tile.as_str()).expect("state tile must parse"))
            .collect()
    }

    fn without_code(tiles: &[String], discard: &str) -> Vec<String> {
        let mut remaining = tiles.to_vec();
        let index = remaining
            .iter()
            .position(|tile| tile.as_str() == discard)
            .expect("discard must be in the hand");
        remaining.remove(index);
        remaining
    }

    fn assert_pair_count_open_constraints(state: &GameState) {
        assert_eq!(state.category, "pair_count_open");
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
        assert!(human.melds.is_empty(), "the hand is still closed");
        let draw = human.draw.clone().expect("the human must have drawn");
        let answer = state
            .correct_action
            .tile()
            .expect("answer tile")
            .to_string();
        assert_ne!(draw, answer, "the open-hand answer is not the drawn tile");

        // Three pairs, one of them a dragon pair the player plans to Pon.
        let pairs = pairs_in(&state.tiles);
        assert_eq!(pairs.len(), 3, "the hand must hold three pairs: {pairs:?}");
        let target = pairs
            .iter()
            .find(|tile| matches!(tile.as_str(), "5z" | "6z" | "7z"))
            .expect("one pair is a dragon")
            .clone();
        assert!(pairs.contains(&draw), "the draw completes the third pair");
        assert_ne!(answer, target, "the Pon target is not discarded");

        // The answer does not break a pair, and all three pairs survive it.
        assert!(
            !pairs.contains(&answer),
            "the answer must not break a pair: {answer}"
        );
        let post_discard = without_code(&state.tiles, &answer);
        let post_pairs = pairs_in(&post_discard);
        assert_eq!(post_pairs.len(), 3, "the answer keeps three pairs");
        assert!(post_pairs.contains(&target));
        assert_eq!(
            post_discard.iter().filter(|tile| **tile == target).count(),
            2,
            "both Pon-target tiles stay in the hand"
        );

        // The visible plan is on the board without naming the answer.
        let note = state
            .scenario_note
            .as_deref()
            .expect("the plan needs a note");
        assert!(note.contains("Pon"), "the note must state the Pon plan");
        assert!(
            note.contains(&format_tile_for_display(&target, false)),
            "the note must name the dragon pair: {note}"
        );
        assert!(!note.contains(&answer), "the note must not name the answer");

        // Discarding the redundant float first is the same answer.
        for equivalent in &state.equivalent_tiles {
            assert!(!pairs.contains(equivalent), "the equivalent is not a pair");
            let alternative = without_code(&state.tiles, equivalent);
            assert_eq!(pairs_in(&alternative).len(), 3);
            assert_eq!(
                alternative.iter().filter(|tile| **tile == target).count(),
                2
            );
        }

        // The answer keeps the hand 2-away.
        assert_eq!(state.shanten, 2);
        assert!(!state.is_agari);
        assert!(!state.can_riichi, "a 2-away closed hand cannot call Riichi");

        // The rivers come from one legal turn order with no calls.
        crate::generator::support::state_validation::validate_reachable_state(state)
            .expect("the open pair-count table must be reachable");
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

        // The Pon is live: at least two copies of the dragon are still unseen.
        let mut visible_targets = 0;
        for opponent in &state.players[1..] {
            visible_targets += opponent
                .discards
                .iter()
                .filter(|discard| discard.tile == target)
                .count();
        }
        if indicator == target {
            visible_targets += 1;
        }
        assert!(
            TARGET_LIVE_COPIES as usize <= 4 - 2 - visible_targets,
            "the Pon target must have two live copies"
        );

        // Value constraint: no graded discard and no Pon target is the dora.
        let indicator = parse_hand(&state.dora_indicators[0])
            .expect("dora indicator must parse")
            .remove(0);
        let dora = indicator_to_dora(indicator).to_string();
        assert_ne!(Some(dora.as_str()), state.correct_action.tile());
        assert!(!state.equivalent_tiles.contains(&dora));
        assert_ne!(dora, target);

        // Closed oracle inversion: breaking a pair accepts more than the book's
        // discard, and the Pon target's live copies cover the difference.
        let post_tiles = parse_tiles(&post_discard);
        let answer_closed = calculate_ukeire(&to_counts(&post_tiles)).total_count;
        assert_eq!(answer_closed, state.ukeire_total);
        let rival = draw.clone();
        assert!(
            pairs.contains(&rival),
            "the drawn tile must complete a suited pair"
        );
        assert_ne!(rival, target);
        assert_ne!(rival, answer);
        let rival_hand = parse_tiles(&without_code(&state.tiles, &rival));
        let rival_closed = calculate_ukeire(&to_counts(&rival_hand)).total_count;
        assert!(
            rival_closed > answer_closed,
            "the closed oracle must prefer {rival} ({rival_closed}) over {answer} \
             ({answer_closed})"
        );
        assert!(
            answer_closed + TARGET_LIVE_COPIES >= rival_closed,
            "the Pon's live copies must cover the closed gap"
        );

        // After the Pon the book line holds two pairs and accepts more than the
        // pair-break rival, which holds only one.
        let target_tile = Tile::try_from(target.as_str()).expect("target parses");
        let (answer_pon_shanten, answer_pon) =
            pon_line(&post_tiles, target_tile).expect("the Pon survives the answer");
        assert_eq!(answer_pon_shanten, 1);
        let (rival_pon_shanten, rival_pon) =
            pon_line(&rival_hand, target_tile).expect("the Pon survives the rival");
        assert_eq!(rival_pon_shanten, 1);
        assert!(
            answer_pon > rival_pon,
            "keeping three pairs must accept {answer_pon} vs {rival_pon} after the Pon"
        );
        assert!(
            best_follow_up_pairs(&post_tiles, target_tile)
                .expect("follow-up")
                .iter()
                .all(|pairs| *pairs == 2),
            "the book line must leave two pairs after the Pon"
        );
        assert!(
            best_follow_up_pairs(&rival_hand, target_tile)
                .expect("follow-up")
                .iter()
                .all(|pairs| *pairs == 1),
            "the rival must leave one pair after the Pon"
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
        let state = generate("pair_count_open").expect("Puzzle generation must succeed");

        assert_pair_count_open_constraints(&state);
        assert_eq!(state.shanten, 2);
    }

    #[test]
    fn test_pair_count_open_constraints_100_runs() {
        let start = std::time::Instant::now();

        for run in 0..100 {
            let state =
                generate("pair_count_open").unwrap_or_else(|err| panic!("run {run} failed: {err}"));
            assert_pair_count_open_constraints(&state);
        }

        let elapsed = start.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(10),
            "100 rejected-sample generations took {elapsed:?}"
        );
    }

    #[test]
    fn the_plan_note_is_only_on_this_lesson() {
        let open = generate("pair_count_open").expect("open lesson must generate");
        assert!(open.scenario_note.is_some());

        let closed = super::super::super::pair_count::generate("pair_count")
            .expect("closed lesson must generate");
        assert!(closed.scenario_note.is_none());
    }
}
