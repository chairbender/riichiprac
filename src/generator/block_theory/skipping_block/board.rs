use agari::context::indicator_to_dora;
use agari::parse::to_counts;
use agari::shanten::calculate_ukeire;
use agari::tile::Tile;

use super::skeleton::{SkippingBlockSkeleton, evaluate_discard};
use crate::generator::support::analysis::{HandMetrics, evaluate_counts};
use crate::generator::support::deck::Deck;
use crate::generator::support::format::format_hand_compact;
use crate::generator::support::table::{
    OpponentDeal, deal_opponents, discards_from_tiles, random_round,
    random_scores_with_human_first, self_turn_river_plan,
};
use crate::rng::gen_range;
use crate::state::{CorrectAction, DecisionContext, GameState, PlayerState, TargetAction, Wind};

/// The validated hand shapes for one skipping-shape puzzle.
struct PreparedHand {
    /// The 13 concealed tiles (the isolated float is the draw).
    human_hand: Vec<Tile>,
    full_tiles: Vec<Tile>,
    metrics: HandMetrics,
    /// Every tile the post-discard hand accepts, kept out of the human river.
    acceptance: Vec<Tile>,
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
    skeleton: &SkippingBlockSkeleton,
) -> Result<GameState, String> {
    let prepared = prepare_hand(skeleton)?;
    let (mut deck, dora_indicator, ura_indicator) = build_deck(skeleton)?;

    let (round_wind, hand_number) = random_round();
    let honba = gen_range(0, 4) as u8;
    let scores = random_scores_with_human_first();

    // The human has just drawn and is about to discard, so the rivers come from
    // one legal timeline that ends on Kamicha's discard.
    let discard_count = gen_range(1, 7);
    let plan = self_turn_river_plan(Wind::East, &[], discard_count);
    let deal = deal_opponents(&mut deck, Wind::East, &scores, &plan)
        .ok_or_else(|| "Deck exhausted drawing the opponents".to_string())?;

    // Keep the river clear of every tile the hand accepts: the lesson is the
    // shape, not a river that quietly kills half the hand's improvement.
    let human_river = deck
        .draw_excluding(plan.counts[0], &prepared.acceptance)
        .ok_or_else(|| "Deck exhausted drawing the human river".to_string())?;

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

/// Splits the skeleton into the 13 concealed tiles and the post-discard metrics.
fn prepare_hand(skeleton: &SkippingBlockSkeleton) -> Result<PreparedHand, String> {
    let mut human_hand = skeleton.concealed_tiles.clone();
    human_hand.sort();

    let mut full_tiles = skeleton.full_tiles.clone();
    full_tiles.sort();

    // Re-prove the lesson on the exact hand the state will carry.
    let answer = evaluate_discard(&skeleton.full_tiles, skeleton.answer_tile)?;
    if answer.shanten != 2 {
        return Err("discarding the isolated float must leave the hand 2-away".to_string());
    }

    let acceptance = calculate_ukeire(&to_counts(&skeleton.concealed_tiles))
        .tiles
        .iter()
        .map(|ukeire| ukeire.tile)
        .collect();

    let metrics = evaluate_counts(&to_counts(&skeleton.concealed_tiles));

    Ok(PreparedHand {
        human_hand,
        full_tiles,
        metrics,
        acceptance,
    })
}

/// Removes the hand from the deck and draws the dora and ura indicators.
fn build_deck(skeleton: &SkippingBlockSkeleton) -> Result<(Deck, Tile, Tile), String> {
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

    // A dora on one of the two candidate tiles would turn the shape question
    // into a value question, so re-roll instead.
    let dora = indicator_to_dora(dora_indicator);
    if dora == skeleton.answer_tile || dora == skeleton.skipping_float {
        return Err("A candidate tile cannot be the dora".to_string());
    }

    Ok((deck, dora_indicator, ura_indicator))
}

/// Assembles the public `GameState` from the validated pieces.
fn assemble_state(
    category: &str,
    skeleton: &SkippingBlockSkeleton,
    prepared: PreparedHand,
    context: TableContext,
) -> GameState {
    let PreparedHand {
        human_hand,
        full_tiles,
        metrics,
        ..
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
        // The drawn tile is the isolated float: keeping it would cost the
        // skipping tile that the hand's other run is worth more than.
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
        // The hand is 2-away, so no Riichi is on offer and the answer is the
        // discard alone.
        can_riichi: false,
        correct_action: CorrectAction::dama(skeleton.answer_tile.to_string()),
        // Both floats leave the same acceptance, so the skipping tile is not
        // graded as an equivalent answer: the drill is the book's shape rule.
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
    use crate::state::{CorrectActionType, MeldType};
    use agari::parse::{parse_hand, to_counts};
    use agari::shanten::{calculate_shanten, calculate_ukeire};

    fn assert_skipping_constraints(state: &GameState) {
        assert_eq!(state.category, "skipping_block");
        assert_eq!(state.target_action, TargetAction::NaniKiru);
        assert_eq!(state.correct_action.action_type(), CorrectActionType::Dama);
        assert!(state.equivalent_tiles.is_empty());
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

        for opponent in &state.players[1..] {
            assert!(!opponent.is_riichi, "opponent must not be in riichi");
            assert!(opponent.melds.is_empty(), "opponent must have no melds");
        }

        let human = &state.players[0];
        assert!(human.is_human);
        assert!(!human.is_riichi);
        assert!(human.melds.is_empty(), "the lesson hand is concealed");
        assert_eq!(human.hand.len(), 13);
        assert_eq!(human.draw.as_deref(), state.correct_action.tile());
        assert!(
            state
                .tiles
                .contains(&state.correct_action.tile().unwrap().to_string())
        );

        // The hand is 2-away and the answer keeps it there.
        assert_eq!(state.shanten, 2);
        assert!(!state.is_agari);
        crate::generator::support::state_validation::validate_reachable_state(state)
            .expect("skipping-shape table must be reachable");

        // Both floats are the same rank in different suits, and the answer is
        // the isolated one.
        let answer = state
            .correct_action
            .tile()
            .expect("answer tile")
            .to_string();
        let answer_tile = Tile::try_from(answer.as_str()).expect("answer parses");
        let answer_suit = answer_tile.suit().expect("answer is suited");
        let mut partner_suit = None;
        for code in &human.hand {
            let tile = Tile::try_from(code.as_str()).expect("hand tile parses");
            if tile.suit() == Some(answer_suit) {
                assert!(
                    tile.value().unwrap().abs_diff(answer_tile.value().unwrap()) > 2,
                    "{tile} is within two ranks of the answer, so it is not isolated"
                );
            } else if tile.value() == answer_tile.value() {
                partner_suit = Some(tile.suit());
            }
        }
        assert!(
            partner_suit.is_some(),
            "the hand must hold the same rank in another suit"
        );

        // The panel's numbers come from the post-discard hand.
        let mut post_discard = state.tiles.clone();
        let index = post_discard
            .iter()
            .position(|tile| *tile == answer)
            .expect("answer is in the full hand");
        post_discard.remove(index);
        let tiles = parse_hand(&post_discard.join("")).expect("post-discard hand parses");
        let counts = to_counts(&tiles);
        assert_eq!(calculate_shanten(&counts).shanten, 2);
        let ukeire = calculate_ukeire(&counts);
        assert_eq!(ukeire.tiles.len(), state.ukeire_tiles.len());
        assert_eq!(ukeire.total_count, state.ukeire_total);

        // Furiten hygiene: the human river holds no acceptance tile.
        for discard in &human.discards {
            assert!(
                !state.ukeire_tiles.contains(&discard.tile),
                "human river contains an acceptance tile {}",
                discard.tile
            );
        }

        // Scores stay on the 100,000-point table.
        let total_score: i32 = state.players.iter().map(|player| player.score).sum();
        assert_eq!(total_score, 100_000);
    }

    #[test]
    fn test_generate_puzzle_game_state() {
        let state = generate("skipping_block").expect("Puzzle generation must succeed");
        assert_skipping_constraints(&state);
    }

    #[test]
    fn test_skipping_block_constraints_100_runs() {
        let start = std::time::Instant::now();

        for run in 0..100 {
            let state =
                generate("skipping_block").unwrap_or_else(|err| panic!("run {run} failed: {err}"));
            assert_skipping_constraints(&state);
        }

        let elapsed = start.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(5),
            "100 rejected-sample generations took {elapsed:?}"
        );
    }

    #[test]
    fn the_skipping_tile_is_not_graded_as_an_equivalent_answer() {
        for _ in 0..30 {
            let state = generate("skipping_block").expect("Puzzle generation must succeed");
            assert!(
                state.equivalent_tiles.is_empty(),
                "the drill grades the book's shape rule, not the tie"
            );

            // The answer is the isolated float: the hand holds its partner (the
            // skipping float) in another suit, and that is what must be kept.
            let answer = state.correct_action.tile().expect("answer tile");
            let answer_tile = Tile::try_from(answer).expect("answer parses");
            let partners: Vec<Tile> = state.players[0]
                .hand
                .iter()
                .filter_map(|code| Tile::try_from(code.as_str()).ok())
                .filter(|tile| {
                    tile.suit() != answer_tile.suit() && tile.value() == answer_tile.value()
                })
                .collect();
            assert!(
                !partners.is_empty(),
                "the hand must hold the same rank as the answer in another suit"
            );
            for partner in partners {
                assert_ne!(partner.to_string(), answer);
                assert!(
                    state.players[0].hand.contains(&partner.to_string()),
                    "the skipping float stays in the hand"
                );
            }
        }
    }

    #[test]
    fn the_human_hand_is_concealed() {
        let state = generate("skipping_block").expect("Puzzle generation must succeed");
        for player in &state.players {
            assert!(
                player
                    .melds
                    .iter()
                    .all(|meld| meld.meld_type != MeldType::Kan)
            );
        }
    }
}
