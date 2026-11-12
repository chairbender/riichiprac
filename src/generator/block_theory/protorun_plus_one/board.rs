use agari::context::{GameContext, WinType, indicator_to_dora};
use agari::hand::{Meld, decompose_hand_with_melds};
use agari::parse::to_counts;
use agari::tile::{Honor, Tile};
use agari::yaku::{Yaku, detect_yaku_with_context};

use super::skeleton::{ProtorunPlusOneSkeleton, evaluate_discard};
use crate::generator::block_theory::shared::deal_with_pon_claim;
use crate::generator::support::analysis::{HandMetrics, evaluate_counts, wind_to_honor};
use crate::generator::support::completion::completion_lines;
use crate::generator::support::deck::Deck;
use crate::generator::support::format::format_hand_compact;
use crate::generator::support::table::{
    OpponentDeal, discards_from_tiles, force_tedashi, random_round, random_scores_with_human_first,
    self_turn_river_plan,
};
use crate::rng::gen_range;
use crate::state::{
    CalledMeld, CorrectAction, DecisionContext, GameState, MeldType, PlayerState, TargetAction,
    Wind,
};

/// The validated hand shapes for one protorun-plus-one puzzle.
struct PreparedHand {
    /// The ten concealed tiles in hand before the discard; the answer may be
    /// the draw instead.
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
    /// Human river entries that follow the Pon, so they are tedashi.
    human_hand_discards: Vec<usize>,
    deal: OpponentDeal,
    tiles_remaining: u8,
}

/// Builds and validates a complete board for an already-proven hand skeleton.
pub(super) fn build_board(
    category: &str,
    skeleton: &ProtorunPlusOneSkeleton,
) -> Result<GameState, String> {
    let prepared = prepare_hand(skeleton)?;
    let (mut deck, dora_indicator, ura_indicator) = build_deck(skeleton)?;

    let (round_wind, hand_number) = random_round();
    let honba = gen_range(0, 4) as u8;
    let scores = random_scores_with_human_first();

    // The human has an open Pon, so one legal timeline is the call right after
    // Shimocha's discard; the rivers follow from it.
    let discard_count = gen_range(1, 7);
    let plan = self_turn_river_plan(Wind::East, &[(0, 1)], discard_count);
    let deal = deal_with_pon_claim(&mut deck, &scores, &plan, &skeleton.open_meld_tiles)?;

    // Keep the human's river clear of every wait tile. The hand is 1-away, so
    // this is hygiene rather than furiten, but it removes a distracting
    // coincidence.
    let human_river = deck
        .draw_excluding(plan.counts[0], &wait_tiles(skeleton))
        .ok_or_else(|| "Deck exhausted drawing the human river".to_string())?;

    validate_visible_waits(skeleton, &deal.rivers, dora_indicator)?;

    // Reject hands that would win with any yaku beyond the intended open
    // Yakuhai. The hand is 1-away, so the winning shapes are every completion
    // line's wait.
    if has_unintended_yaku(skeleton, round_wind, dora_indicator) {
        return Err("Candidate hand has unintended yaku".to_string());
    }

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

/// Every tile that improves the hand once the answer is discarded.
fn wait_tiles(skeleton: &ProtorunPlusOneSkeleton) -> Vec<Tile> {
    evaluate_discard(&skeleton.full_tiles, skeleton.answer_tile)
        .map(|answer| answer.tiles)
        .unwrap_or_default()
}

/// Removes the draw from the concealed hand and evaluates the answer.
fn prepare_hand(skeleton: &ProtorunPlusOneSkeleton) -> Result<PreparedHand, String> {
    if skeleton.answer_tile == skeleton.rival_tile {
        return Err("the two covers must be different tiles".to_string());
    }

    // The visible hand is the eleven concealed tiles minus the draw: the draw
    // is shown separately, and the answer is either one of the ten remaining
    // tiles or the drawn tile itself.
    let mut human_hand = skeleton.concealed_tiles.clone();
    let draw_index = human_hand
        .iter()
        .position(|tile| *tile == skeleton.draw)
        .ok_or_else(|| "Protorun plus one skeleton is missing its draw".to_string())?;
    human_hand.remove(draw_index);
    human_hand.sort();
    assert_hand_shape(skeleton, &human_hand)?;

    let mut full_tiles = skeleton.full_tiles.clone();
    full_tiles.sort();

    let post_discard_tiles = without(&full_tiles, skeleton.answer_tile)?;
    let metrics = evaluate_counts(&to_counts(&post_discard_tiles));

    // Re-prove the lesson on the exact hand the state will carry.
    let answer = evaluate_discard(&skeleton.full_tiles, skeleton.answer_tile)?;
    if answer.shanten != 1 || metrics.shanten != 1 {
        return Err("the answer must leave the hand 1-away".to_string());
    }

    Ok(PreparedHand {
        human_hand,
        full_tiles,
        metrics,
    })
}

/// Asserts that the two complex shapes are where the skeleton says they are.
fn assert_hand_shape(
    skeleton: &ProtorunPlusOneSkeleton,
    human_hand: &[Tile],
) -> Result<(), String> {
    if !human_hand.contains(&skeleton.answer_tile) && skeleton.draw != skeleton.answer_tile {
        return Err("the answer must be in the concealed hand or the draw".to_string());
    }

    if !human_hand.contains(&skeleton.weak.partner) {
        return Err("the closed wait's far tile must stay in the hand".to_string());
    }
    if !human_hand.contains(&skeleton.strong.partner) {
        return Err("the side wait's other tile must stay in the hand".to_string());
    }
    for shape in [skeleton.weak, skeleton.strong] {
        let copies = human_hand
            .iter()
            .filter(|tile| **tile == shape.pair)
            .count()
            + usize::from(skeleton.draw == shape.pair);
        if copies != 2 {
            return Err(format!("{} must be held twice for its cover", shape.pair));
        }
    }
    for tile in skeleton.run {
        if !human_hand.contains(&tile) {
            return Err("the concealed run must stay in the hand".to_string());
        }
    }
    if !human_hand.contains(&skeleton.head) {
        return Err("the head must stay in the hand".to_string());
    }

    Ok(())
}

/// Removes the hand from the deck and draws the dora and ura indicators.
fn build_deck(skeleton: &ProtorunPlusOneSkeleton) -> Result<(Deck, Tile, Tile), String> {
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

    // A dora on a cover tile would turn the shape question into a value
    // question, so re-roll instead.
    let dora = indicator_to_dora(dora_indicator);
    if dora == skeleton.answer_tile || dora == skeleton.rival_tile {
        return Err("a cover tile cannot be the dora".to_string());
    }

    Ok((deck, dora_indicator, ura_indicator))
}

/// Rejects a hand when a wait tile is already too visible to draw.
fn validate_visible_waits(
    skeleton: &ProtorunPlusOneSkeleton,
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
    skeleton: &ProtorunPlusOneSkeleton,
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
    let meld_tiles: Vec<String> = skeleton
        .open_meld_tiles
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
        discards: {
            let mut discards = discards_from_tiles(&human_river);
            force_tedashi(&mut discards, &human_hand_discards);
            discards
        },
        melds: vec![CalledMeld {
            meld_type: MeldType::Pon,
            tiles: meld_tiles,
            called_from: Some(1),
        }],
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
        // The open Yakuhai meld makes Riichi illegal, so discarding without a
        // declaration is the only legal answer.
        correct_action: CorrectAction::dama(skeleton.answer_tile.to_string()),
        // The tied rival breaks the closed wait's cover, which the book says to
        // keep, so it is deliberately not graded as an equivalent discard.
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

/// Rejects any winning decomposition whose only yaku is not the open dragon
/// yakuhai. This keeps the scenario a pure block-shape problem.
fn has_unintended_yaku(
    skeleton: &ProtorunPlusOneSkeleton,
    round_wind: Wind,
    dora_indicator: Tile,
) -> bool {
    let open_tile = skeleton.open_meld_tiles[0];
    let open_honor = match open_tile {
        Tile::Honor(honor) => honor,
        _ => return true,
    };
    let allowed_yaku = Yaku::Yakuhai(open_honor);
    let open_meld = Meld::koutsu_open(open_tile);

    let Some(answer_hand) = without(&skeleton.full_tiles, skeleton.answer_tile).ok() else {
        return true;
    };

    // Walk the completions of the answer hand and test every winning hand.
    for line in completion_lines(&answer_hand) {
        let Some(mut tenpai) = without(&answer_hand, line.discard).ok() else {
            continue;
        };
        tenpai.push(line.draw);

        for wait in line.waits {
            let mut winning = tenpai.clone();
            winning.push(wait);

            let mut concealed = winning.clone();
            for tile in &skeleton.open_meld_tiles {
                let Some(index) = concealed.iter().position(|held| held == tile) else {
                    return true;
                };
                concealed.remove(index);
            }

            let concealed_counts = to_counts(&concealed);
            let structures =
                decompose_hand_with_melds(&concealed_counts, std::slice::from_ref(&open_meld));
            if structures.is_empty() {
                return true;
            }

            let full_counts = to_counts(&winning);
            let mut context =
                GameContext::new(WinType::Ron, wind_to_honor(round_wind), Honor::East)
                    .with_winning_tile(wait)
                    .open();
            context.dora_indicators = vec![dora_indicator];

            for structure in &structures {
                let result = detect_yaku_with_context(structure, &full_counts, &context);
                if result.yaku_list.len() != 1 || result.yaku_list[0] != allowed_yaku {
                    return true;
                }
            }
        }
    }

    false
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
    use super::super::generate;
    use super::*;
    use crate::state::CorrectActionType;
    use agari::parse::parse_hand;
    use agari::shanten::{calculate_shanten, calculate_ukeire};

    fn assert_protorun_plus_one_constraints(state: &GameState) {
        assert_eq!(state.category, "protorun_plus_one");
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

        // Human hand, open Yakuhai, and draw.
        let human = &state.players[0];
        assert!(human.is_human);
        assert!(!human.is_riichi);
        assert_eq!(human.hand.len(), 10);
        assert!(human.draw.is_some());
        assert_eq!(human.melds.len(), 1);
        assert_eq!(human.melds[0].meld_type, MeldType::Pon);
        assert_eq!(human.melds[0].tiles.len(), 3);
        assert!(
            human.melds[0]
                .tiles
                .iter()
                .all(|tile| tile == &human.melds[0].tiles[0])
        );
        assert!(matches!(
            human.melds[0].tiles[0].as_str(),
            "5z" | "6z" | "7z"
        ));

        // The answer is a tile the player can discard: the draw or a hand tile.
        let answer = state.correct_action.tile().expect("answer tile");
        assert!(
            human.hand.iter().any(|tile| tile == answer) || human.draw.as_deref() == Some(answer)
        );

        // The rival cover is never graded as equivalent.
        assert!(state.equivalent_tiles.is_empty());

        // The rivers come from one legal turn order.
        crate::generator::support::state_validation::validate_reachable_state(state)
            .expect("protorun plus one table must be reachable");
        let discard_counts: Vec<usize> = state
            .players
            .iter()
            .map(|player| player.discards.len())
            .collect();
        assert!((1..=8).contains(&discard_counts[0]));
        assert!(
            !human.discards[1].is_tsumogiri,
            "the discard after the Pon must be tedashi"
        );

        // The answer keeps the hand 1-away and accepts the book's tiles.
        assert_eq!(state.shanten, 1);
        assert_eq!(state.ukeire_tiles.len(), 5);
        assert_eq!(state.ukeire_total, 16);

        // Furiten hygiene: the human river holds no wait tile.
        for discard in &human.discards {
            assert!(
                !state.ukeire_tiles.contains(&discard.tile),
                "human river contains a wait tile {}",
                discard.tile
            );
        }

        // Wait chance constraint: at most two copies of any wait tile are
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

        // The visible full hand is exactly hand + draw + open meld.
        let mut expected: Vec<String> = human.hand.clone();
        expected.push(human.draw.clone().expect("human must have a draw"));
        expected.extend(human.melds[0].tiles.iter().cloned());
        expected.sort();
        let mut actual = state.tiles.clone();
        actual.sort();
        assert_eq!(actual, expected);
    }

    #[test]
    fn test_generate_puzzle_game_state() {
        let state = generate("protorun_plus_one").expect("Puzzle generation must succeed");

        assert_protorun_plus_one_constraints(&state);
    }

    #[test]
    fn test_protorun_plus_one_constraints_100_runs() {
        let start = std::time::Instant::now();

        for run in 0..100 {
            let state = generate("protorun_plus_one")
                .unwrap_or_else(|err| panic!("run {run} failed: {err}"));
            assert_protorun_plus_one_constraints(&state);
        }

        let elapsed = start.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(10),
            "100 rejected-sample generations took {elapsed:?}"
        );
    }

    #[test]
    fn the_answer_hand_is_still_one_away() {
        for _ in 0..20 {
            let state = generate("protorun_plus_one").expect("generation must succeed");
            let mut post_discard = state.tiles.clone();
            let answer = state
                .correct_action
                .tile()
                .expect("answer tile")
                .to_string();
            let index = post_discard
                .iter()
                .position(|tile| *tile == answer)
                .expect("answer in hand");
            post_discard.remove(index);
            let tiles = parse_hand(&post_discard.join("")).expect("post-discard hand must parse");
            let counts = to_counts(&tiles);
            assert_eq!(calculate_shanten(&counts).shanten, 1);
            let ukeire = calculate_ukeire(&counts);
            assert_eq!(ukeire.total_count, 16);
        }
    }
}
