use agari::context::{GameContext, WinType, indicator_to_dora};
use agari::hand::{Meld, decompose_hand_with_melds};
use agari::parse::to_counts;
use agari::tile::{Honor, Tile};
use agari::yaku::{Yaku, detect_yaku_with_context};

use super::skeleton::RyanmenSkeleton;
use crate::generator::support::analysis::{HandMetrics, evaluate_counts, wind_to_honor};
use crate::generator::support::deck::Deck;
use crate::generator::support::format::format_hand_compact;
use crate::generator::support::table::{
    OpponentDeal, deal_opponents, discards_from_tiles, force_tedashi, random_round,
    random_scores_with_human_first, self_turn_river_plan,
};
use crate::rng::gen_range;
use crate::state::{
    CalledMeld, CorrectAction, DecisionContext, GameState, MeldType, PlayerState, TargetAction,
    Wind,
};

/// The validated hand shapes for one ryanmen puzzle.
struct PreparedHand {
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

/// Builds and validates a complete board for an already-valid hand skeleton.
pub(super) fn build_board(category: &str, skeleton: &RyanmenSkeleton) -> Result<GameState, String> {
    let prepared = prepare_hand(skeleton)?;
    let (mut deck, dora_indicator, ura_indicator) = build_deck(skeleton)?;

    let (round_wind, hand_number) = random_round();
    let honba = gen_range(0, 4) as u8;
    let scores = random_scores_with_human_first();

    // The human has an open Pon, so the human called out of rotation once.
    // Plan one legal timeline: the call happens right after Shimocha's
    // discard, and the rivers follow from it.
    let discard_count = gen_range(1, 7);
    let plan = self_turn_river_plan(Wind::East, &[(0, 1)], discard_count);
    let deal = deal_opponents(&mut deck, Wind::East, &scores, &plan)
        .ok_or_else(|| "Deck exhausted drawing the opponents".to_string())?;

    // Furiten: the human's river cannot contain either ryanmen wait tile.
    let human_river = deck
        .draw_excluding(plan.counts[0], &skeleton.wait_tiles)
        .ok_or_else(|| "Deck exhausted drawing the human river".to_string())?;

    validate_visible_waits(skeleton, &deal.rivers, dora_indicator)?;

    // Reject hands that gain any yaku beyond the intended open Yakuhai.
    if has_unintended_yaku(skeleton, &prepared.human_hand, round_wind, dora_indicator) {
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

/// Verifies the shape and evaluates the hand after the duplicate discard.
fn prepare_hand(skeleton: &RyanmenSkeleton) -> Result<PreparedHand, String> {
    if !skeleton.shape_tiles.contains(&skeleton.correct_tile) {
        return Err("Ryanmen skeleton is missing its duplicate tile".to_string());
    }

    let mut human_hand = skeleton.concealed_tiles.clone();
    let duplicate_index = human_hand
        .iter()
        .position(|tile| *tile == skeleton.correct_tile)
        .ok_or_else(|| "Ryanmen skeleton is missing its duplicate tile".to_string())?;
    human_hand.remove(duplicate_index);
    human_hand.sort();

    let mut full_tiles = skeleton.full_tiles.clone();
    full_tiles.sort();

    let mut post_discard_tiles = full_tiles.clone();
    let post_discard_index = post_discard_tiles
        .iter()
        .position(|tile| *tile == skeleton.correct_tile)
        .ok_or_else(|| "Ryanmen skeleton is missing its duplicate tile".to_string())?;
    post_discard_tiles.remove(post_discard_index);

    let metrics = evaluate_counts(&to_counts(&post_discard_tiles));

    Ok(PreparedHand {
        human_hand,
        full_tiles,
        metrics,
    })
}

/// Removes the hand from the deck and draws the dora and ura indicators.
fn build_deck(skeleton: &RyanmenSkeleton) -> Result<(Deck, Tile, Tile), String> {
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

    if indicator_to_dora(dora_indicator) == skeleton.correct_tile {
        return Err("The duplicate tile cannot be the dora".to_string());
    }

    Ok((deck, dora_indicator, ura_indicator))
}

/// Rejects a wait when too many winning-tile copies are already visible.
fn validate_visible_waits(
    skeleton: &RyanmenSkeleton,
    opponent_rivers: &[Vec<Tile>],
    dora_indicator: Tile,
) -> Result<(), String> {
    let mut visible_wait_tiles = 0;
    for river in opponent_rivers {
        for tile in river {
            if skeleton.wait_tiles.contains(tile) {
                visible_wait_tiles += 1;
            }
        }
    }
    if skeleton.wait_tiles.contains(&dora_indicator) {
        visible_wait_tiles += 1;
    }
    if visible_wait_tiles > 2 {
        return Err(format!(
            "{visible_wait_tiles} ryanmen wait tiles are already visible"
        ));
    }

    Ok(())
}

/// Assembles the public `GameState` from the validated pieces.
fn assemble_state(
    category: &str,
    skeleton: &RyanmenSkeleton,
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
        draw: Some(skeleton.correct_tile.to_string()),
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
        // The open Yakuhai meld makes Riichi illegal, so staying dama is
        // the only legal declaration for this hand.
        correct_action: CorrectAction::dama(skeleton.correct_tile.to_string()),
        equivalent_tiles: Vec::new(),
        decision: DecisionContext::SelfTurn,
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

/// Rejects any winning decomposition whose only yaku is not the open
/// dragon yakuhai. This keeps the scenario a pure tile-efficiency problem.
fn has_unintended_yaku(
    skeleton: &RyanmenSkeleton,
    human_hand: &[Tile],
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

    for &wait_tile in &skeleton.wait_tiles {
        let mut concealed_with_win = human_hand.to_vec();
        concealed_with_win.push(wait_tile);
        let concealed_counts = to_counts(&concealed_with_win);
        let structures =
            decompose_hand_with_melds(&concealed_counts, std::slice::from_ref(&open_meld));
        if structures.is_empty() {
            return true;
        }

        let mut full_with_win = human_hand.to_vec();
        full_with_win.extend(skeleton.open_meld_tiles.iter().copied());
        full_with_win.push(wait_tile);
        let full_counts = to_counts(&full_with_win);

        let mut context = GameContext::new(WinType::Ron, wind_to_honor(round_wind), Honor::East)
            .with_winning_tile(wait_tile)
            .open();
        context.dora_indicators = vec![dora_indicator];

        for structure in &structures {
            let result = detect_yaku_with_context(structure, &full_counts, &context);
            if result.yaku_list.len() != 1 || result.yaku_list[0] != allowed_yaku {
                return true;
            }
        }
    }

    false
}

#[cfg(test)]
mod tests {
    use super::super::generate;
    use super::*;
    use crate::state::CorrectActionType;
    use agari::parse::parse_hand;
    use agari::shanten::{calculate_shanten, calculate_ukeire};
    use agari::tile::Suit;

    fn assert_ryanmen_constraints(state: &GameState) {
        assert_eq!(state.category, "ryanmen_protorun");
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
        assert_eq!(human.draw.as_deref(), state.correct_action.tile());
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

        // The rivers come from one legal turn order: the human's earlier Pon
        // gives them one extra discard over a pure rotation.
        crate::generator::support::state_validation::validate_reachable_state(state)
            .expect("cast table must be reachable");
        let discard_counts: Vec<usize> = state
            .players
            .iter()
            .map(|player| player.discards.len())
            .collect();
        assert!((1..=8).contains(&discard_counts[0]));
        // The human pon'd Shimocha's discard, so their following discard (the
        // second one: the first came before the call) came from the hand and
        // must never be marked tsumogiri.
        assert!(
            !human.discards[1].is_tsumogiri,
            "the discard after the Pon must be tedashi"
        );

        // The only wait is the live two-sided ryanmen.
        assert_eq!(state.ukeire_tiles.len(), 2);
        let wait_tiles = &state.ukeire_tiles;

        // Furiten constraint: the human river excludes both wait tiles.
        for discard in &human.discards {
            assert!(
                !wait_tiles.contains(&discard.tile),
                "human river contains furiten tile {}",
                discard.tile
            );
        }

        // Wait chance constraint: <= 2 wait tiles visible in opponent rivers
        // or the dora indicator.
        let mut visible_wait_tiles = 0;
        for opponent in &state.players[1..] {
            for discard in &opponent.discards {
                if wait_tiles.contains(&discard.tile) {
                    visible_wait_tiles += 1;
                }
            }
        }
        for indicator in &state.dora_indicators {
            if wait_tiles.contains(indicator) {
                visible_wait_tiles += 1;
            }
        }
        assert!(
            visible_wait_tiles <= 2,
            "{visible_wait_tiles} wait tiles are visible"
        );
        assert!(8 - visible_wait_tiles >= 2);

        // Value constraint: the duplicate is not the actual dora.
        let indicator = parse_hand(&state.dora_indicators[0])
            .expect("dora indicator must parse")
            .remove(0);
        assert_ne!(
            indicator_to_dora(indicator).to_string(),
            state.correct_action.tile().expect("answer tile")
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
        let state = generate("ryanmen_protorun").expect("Puzzle generation must succeed");

        assert_ryanmen_constraints(&state);
        assert_eq!(state.shanten, 0);
        assert_eq!(state.ukeire_tiles.len(), 2);
        assert!(
            state
                .tiles
                .iter()
                .any(|tile| Some(tile.as_str()) == state.correct_action.tile())
        );

        // Discarding the duplicate leaves the two-sided ryanmen wait.
        let mut post_discard = state.tiles.clone();
        let duplicate_index = post_discard
            .iter()
            .position(|tile| Some(tile.as_str()) == state.correct_action.tile())
            .expect("correct tile must be in the full hand");
        post_discard.remove(duplicate_index);
        let post_tiles =
            parse_hand(&post_discard.join("")).expect("post-discard hand must parse in agari");
        let post_counts = to_counts(&post_tiles);
        assert_eq!(calculate_shanten(&post_counts).shanten, 0);
        let ukeire = calculate_ukeire(&post_counts);
        assert_eq!(ukeire.tiles.len(), 2);
        assert!(ukeire.total_count > 0);
    }

    #[test]
    fn test_unintended_yaku_is_rejected() {
        let pin = |value: u8| Tile::Suited {
            suit: Suit::Pin,
            value,
        };
        let man = |value: u8| Tile::Suited {
            suit: Suit::Man,
            value,
        };
        let sou = |value: u8| Tile::Suited {
            suit: Suit::Sou,
            value,
        };
        let haku = Tile::Honor(Honor::White);
        let dora_indicator = man(1);

        let make_skeleton = |concealed: Vec<Tile>| {
            let open = vec![haku, haku, haku];
            let mut full = concealed.clone();
            full.extend(open.iter().copied());
            let mut human_hand = concealed.clone();
            let duplicate_index = human_hand
                .iter()
                .position(|tile| *tile == pin(6))
                .expect("duplicate must be in concealed hand");
            human_hand.remove(duplicate_index);
            (
                RyanmenSkeleton {
                    full_tiles: full,
                    concealed_tiles: concealed,
                    shape_tiles: [pin(6), pin(6), pin(7)],
                    wait_tiles: [pin(5), pin(8)],
                    open_meld_tiles: open,
                    correct_tile: pin(6),
                },
                human_hand,
            )
        };

        // All-pinzu concealed hand plus the open Haku is Honitsu + Yakuhai.
        let (honitsu, honitsu_hand) = make_skeleton(vec![
            pin(1),
            pin(2),
            pin(3),
            pin(2),
            pin(3),
            pin(4),
            pin(9),
            pin(9),
            pin(6),
            pin(6),
            pin(7),
        ]);
        assert!(has_unintended_yaku(
            &honitsu,
            &honitsu_hand,
            Wind::East,
            dora_indicator
        ));

        // Sets spread across suits leave only the open Yakuhai.
        let (clean, clean_hand) = make_skeleton(vec![
            man(1),
            man(2),
            man(3),
            sou(2),
            sou(3),
            sou(4),
            sou(9),
            sou(9),
            pin(6),
            pin(6),
            pin(7),
        ]);
        assert!(!has_unintended_yaku(
            &clean,
            &clean_hand,
            Wind::East,
            dora_indicator
        ));
    }

    #[test]
    fn test_ryanmen_constraints_100_runs() {
        let start = std::time::Instant::now();

        for run in 0..100 {
            let state = generate("ryanmen_protorun")
                .unwrap_or_else(|err| panic!("run {run} failed: {err}"));
            assert_ryanmen_constraints(&state);
        }

        let elapsed = start.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(5),
            "100 rejected-sample generations took {elapsed:?}"
        );
    }
}
