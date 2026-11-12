use agari::context::{GameContext, WinType, indicator_to_dora};
use agari::hand::{Meld, decompose_hand_with_melds};
use agari::parse::to_counts;
use agari::tile::{Honor, Tile};
use agari::yaku::{Yaku, detect_yaku_with_context};

use super::skeleton::{self, NakabukureSkeleton, Variant};
use crate::generator::block_theory::shared::deal_with_pon_claim;
use crate::generator::support::analysis::{HandMetrics, evaluate_counts, wind_to_honor};
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

/// The validated hand shapes for one bulging-float puzzle.
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
pub(super) fn build_board(
    category: &str,
    skeleton: &NakabukureSkeleton,
) -> Result<GameState, String> {
    let (mut deck, dora_indicator, ura_indicator) = build_deck(skeleton)?;

    let (round_wind, hand_number) = random_round();
    let honba = gen_range(0, 4) as u8;
    let scores = random_scores_with_human_first();

    // The open Yakuhai Pon is the ready-hand lesson's way of making Riichi
    // illegal and the discard the whole question. The closed 1-away variants
    // hold no meld, so their timeline has no call in it.
    let has_open_meld = !skeleton.open_meld_tiles.is_empty();
    let calls: &[(usize, usize)] = if has_open_meld { &[(0, 1)] } else { &[] };

    // The human is the current player (about to discard). With the Pon they
    // have one extra discard over a pure rotation; without it the timeline is
    // an ordinary rotation.
    let discard_count = gen_range(1, 7);
    let plan = self_turn_river_plan(Wind::East, calls, discard_count);
    let deal = deal_with_pon_claim(&mut deck, &scores, &plan, &skeleton.open_meld_tiles)?;

    // Neither candidate discard may sit in the human's own river: for the
    // ready hand that would be furiten, and for the 1-away hands it would look
    // like a tile the hand already threw away.
    let human_river = deck
        .draw_excluding(
            plan.counts[0],
            &[skeleton.bulge_tile, skeleton.draw, skeleton.answer_tile],
        )
        .ok_or_else(|| "Deck exhausted drawing the human river".to_string())?;

    match skeleton.variant {
        Variant::ReadyDrop => {
            // The book's ready-hand comparison is three live tiles against two.
            // "Live" means unseen: the hand's own copies are already excluded
            // from the wait count, so neither wait may also sit in a river, a
            // meld, or one of the indicators. Copies in an opponent's concealed
            // hand stay unseen, exactly as they would in a real game.
            let wait_tiles = [skeleton.draw.to_string(), skeleton.bulge_tile.to_string()];
            for player in &deal.players {
                for discard in &player.discards {
                    if wait_tiles.contains(&discard.tile) {
                        return Err("A wait tile is visible in an opponent river".to_string());
                    }
                }
                for meld in &player.melds {
                    if meld.tiles.iter().any(|tile| wait_tiles.contains(tile)) {
                        return Err("A wait tile is visible in an opponent meld".to_string());
                    }
                }
            }
            if wait_tiles.iter().any(|wait| {
                *wait == dora_indicator.to_string() || *wait == ura_indicator.to_string()
            }) {
                return Err("A wait tile is the dora or ura indicator".to_string());
            }

            // Reject ready hands that gain any yaku beyond the intended open
            // Yakuhai.
            if has_unintended_yaku(skeleton, round_wind, dora_indicator) {
                return Err("Candidate hand has unintended yaku".to_string());
            }

            skeleton::verify_ready_drop(skeleton)?;
        }
        Variant::OneAwayKeep => skeleton::verify_one_away_keep(skeleton)?,
        Variant::OneAwayBreak => skeleton::verify_one_away_break(skeleton)?,
    }

    let prepared = prepare_hand(skeleton)?;

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

/// Verifies the shape and evaluates the hand after the book's discard.
fn prepare_hand(skeleton: &NakabukureSkeleton) -> Result<PreparedHand, String> {
    // The concealed hand must hold the whole bulging float, not just its middle
    // tile: the four tiles are the block the lesson is about.
    for tile in &skeleton.bulge_tiles {
        if !skeleton.concealed_tiles.contains(tile) {
            return Err("Nakabukure skeleton is missing part of its bulge".to_string());
        }
    }

    // The drawn tile is kept in `draw`, so the concealed hand holds the
    // bulging float intact: the decision comes before the discard.
    let mut human_hand = skeleton.concealed_tiles.clone();
    let draw_index = human_hand
        .iter()
        .position(|tile| *tile == skeleton.draw)
        .ok_or_else(|| "Nakabukure skeleton is missing its drawn tile".to_string())?;
    human_hand.remove(draw_index);
    human_hand.sort();

    let mut full_tiles = skeleton.full_tiles.clone();
    full_tiles.sort();

    let mut post_discard_tiles = full_tiles.clone();
    let post_discard_index = post_discard_tiles
        .iter()
        .position(|tile| *tile == skeleton.answer_tile)
        .ok_or_else(|| "Nakabukure skeleton is missing its answer tile".to_string())?;
    post_discard_tiles.remove(post_discard_index);

    let metrics = evaluate_counts(&to_counts(&post_discard_tiles));

    Ok(PreparedHand {
        human_hand,
        full_tiles,
        metrics,
    })
}

/// Removes the hand from the deck and draws the dora and ura indicators.
fn build_deck(skeleton: &NakabukureSkeleton) -> Result<(Deck, Tile, Tile), String> {
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

    // Keep value out of the decision: if the indicator turns a tile of the hand
    // into dora, discarding it would cost points for reasons the lesson is not
    // about.
    let dora = indicator_to_dora(dora_indicator);
    if skeleton.full_tiles.contains(&dora) {
        return Err("A hand tile cannot be the dora".to_string());
    }

    Ok((deck, dora_indicator, ura_indicator))
}

/// Assembles the public `GameState` from the validated pieces.
fn assemble_state(
    category: &str,
    skeleton: &NakabukureSkeleton,
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

    let melds = if skeleton.open_meld_tiles.is_empty() {
        Vec::new()
    } else {
        vec![CalledMeld {
            meld_type: MeldType::Pon,
            tiles: skeleton
                .open_meld_tiles
                .iter()
                .map(|tile| tile.to_string())
                .collect(),
            called_from: Some(1),
        }]
    };

    let human_player = PlayerState {
        seat: 0,
        name: "You".to_string(),
        is_human: true,
        wind: Wind::East,
        score: scores[0],
        hand: human_hand.iter().map(|tile| tile.to_string()).collect(),
        // The drawn tile completes the shape the hand has to judge: the lone
        // honour in the ready hand, the rival pair's partner in the 1-away
        // keep hand, and the third 1m in the break hand.
        draw: Some(skeleton.draw.to_string()),
        red_fives: Vec::new(),
        discards: {
            let mut discards = discards_from_tiles(&human_river);
            force_tedashi(&mut discards, &human_hand_discards);
            discards
        },
        melds,
        is_riichi: false,
        riichi_discard_index: None,
    };

    let mut players = Vec::with_capacity(4);
    players.push(human_player);
    players.extend(deal.players);

    GameState {
        category: category.to_string(),
        target_action: TargetAction::NaniKiru,
        // The ready-hand lesson keeps Riichi illegal with an open Yakuhai Pon;
        // the 1-away hands are not tenpai, so no declaration is offered either
        // way and the answer is the discard alone.
        correct_action: CorrectAction::dama(skeleton.answer_tile.to_string()),
        equivalent_tiles: Vec::new(),
        decision: DecisionContext::SelfTurn,
        scenario_note: None,
        call_offer: None,
        ai_decision: None,
        riichi_triggers: Vec::new(),
        dama_reasons: Vec::new(),
        shouminkan_triggers: Vec::new(),
        book_rationale: None,
        // Only the open Yakuhai Pon (ready variant) forbids Riichi; for the
        // 1-away hands the hand is not tenpai. `finalize_state` recomputes this
        // at the generation boundary.
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

/// Rejects any winning decomposition whose only yaku is not the open dragon
/// yakuhai. This keeps the ready-hand scenario a pure tile-efficiency problem.
fn has_unintended_yaku(
    skeleton: &NakabukureSkeleton,
    round_wind: Wind,
    dora_indicator: Tile,
) -> bool {
    let Some(&open_tile) = skeleton.open_meld_tiles.first() else {
        return false;
    };
    let Tile::Honor(open_honor) = open_tile else {
        return true;
    };
    let allowed_yaku = Yaku::Yakuhai(open_honor);
    let open_meld = Meld::koutsu_open(open_tile);

    // (discard, winning tile): the book's discard keeps the lone-honour wait;
    // the tempting discard leaves the bulge tile as the wait.
    let paths = [
        (skeleton.bulge_tile, skeleton.draw),
        (skeleton.draw, skeleton.bulge_tile),
    ];

    for (discard, wait_tile) in paths {
        let mut concealed = skeleton.concealed_tiles.clone();
        let Some(discard_index) = concealed.iter().position(|tile| *tile == discard) else {
            return true;
        };
        concealed.remove(discard_index);

        let mut concealed_with_win = concealed.clone();
        concealed_with_win.push(wait_tile);
        let structures = decompose_hand_with_melds(
            &to_counts(&concealed_with_win),
            std::slice::from_ref(&open_meld),
        );
        if structures.is_empty() {
            return true;
        }

        let mut full_with_win = concealed;
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
    use super::super::{generate, generate_variant};
    use super::*;
    use crate::state::CorrectActionType;
    use agari::parse::parse_hand;
    use agari::shanten::{calculate_shanten, calculate_ukeire};
    use std::collections::HashSet;

    /// Every discard that leaves a tenpai hand, read back from the payload.
    fn tenpai_discards(state: &GameState) -> Vec<String> {
        let mut seen = HashSet::new();
        let mut discs = Vec::new();
        for tile in &state.tiles {
            if !seen.insert(tile.clone()) {
                continue;
            }
            let mut remaining = state.tiles.clone();
            let index = remaining
                .iter()
                .position(|candidate| candidate == tile)
                .expect("tile must be in the hand");
            remaining.remove(index);
            let parsed = parse_hand(&remaining.join("")).expect("hand must parse");
            if calculate_shanten(&to_counts(&parsed)).shanten == 0 {
                discs.push(tile.clone());
            }
        }
        discs.sort();
        discs
    }

    fn assert_ready_drop_constraints(state: &GameState) {
        assert_eq!(state.shanten, 0);

        let draw = state.players[0]
            .draw
            .as_deref()
            .expect("human must have a draw");
        assert!(draw.ends_with('z'), "the draw is the floating honour");

        // The correct discard is the middle tile of a 4-tile bulge: it appears
        // exactly twice in the full hand and the draw is the other candidate.
        let answer = state.correct_action.tile().expect("answer tile");
        assert_ne!(answer, draw);
        let copies = state
            .tiles
            .iter()
            .filter(|tile| tile.as_str() == answer)
            .count();
        assert_eq!(copies, 2, "the bulge tile is held exactly twice");

        // The book's discard leaves the lone honour as the only wait, with all
        // three remaining copies live; the tempting discard leaves the bulge
        // tile, which is already held twice.
        assert_eq!(state.ukeire_tiles, vec![draw.to_string()]);
        assert_eq!(state.ukeire_total, 3);

        let mut post_float = state.tiles.clone();
        let float_index = post_float
            .iter()
            .position(|tile| tile == draw)
            .expect("draw must be in the full hand");
        post_float.remove(float_index);
        let float_tiles = parse_hand(&post_float.join("")).expect("hand must parse");
        let float_counts = to_counts(&float_tiles);
        assert_eq!(calculate_shanten(&float_counts).shanten, 0);
        let float_ukeire = calculate_ukeire(&float_counts);
        assert_eq!(float_ukeire.tiles.len(), 1);
        assert_eq!(float_ukeire.tiles[0].tile.to_string(), answer);
        assert_eq!(float_ukeire.total_count, 2);

        // Both candidate discards, and nothing else, leave tenpai.
        let mut expected = vec![answer.to_string(), draw.to_string()];
        expected.sort();
        assert_eq!(tenpai_discards(state), expected);

        // Furiten and wait availability: neither wait is visible anywhere.
        let wait_tiles: Vec<String> = vec![answer.to_string(), draw.to_string()];
        for player in &state.players {
            for discard in &player.discards {
                assert!(
                    !wait_tiles.contains(&discard.tile),
                    "a wait tile is visible in a river"
                );
            }
        }
        for indicator in &state.dora_indicators {
            assert!(
                !wait_tiles.contains(indicator),
                "a wait tile is the dora indicator"
            );
        }
    }

    /// The two 1-away variants share a table shape: closed hand, no melds.
    fn assert_one_away_table(state: &GameState) {
        assert_eq!(state.shanten, 1);
        assert_eq!(state.correct_action.action_type(), CorrectActionType::Dama);

        let human = &state.players[0];
        assert!(human.melds.is_empty(), "the 1-away hands are closed");
        assert_eq!(human.hand.len(), 13);
        assert_eq!(human.hand.len() + 1, 14);
        assert!(human.draw.is_some());
        assert!(!human.is_riichi);
        assert!(!state.can_riichi, "a 1-away hand cannot declare Riichi");

        let human_discards = human.discards.len();
        assert!((1..=8).contains(&human_discards));

        // Neither candidate discard is already in the river.
        let answer = state
            .correct_action
            .tile()
            .expect("answer tile")
            .to_string();
        for discard in &human.discards {
            assert_ne!(
                discard.tile, answer,
                "the answer is not already in the river"
            );
        }

        // No dora sits in the hand: the decision is pure shape.
        let indicator = parse_hand(&state.dora_indicators[0])
            .expect("dora indicator must parse")
            .remove(0);
        let dora = indicator_to_dora(indicator).to_string();
        assert!(!state.tiles.contains(&dora), "no hand tile may be the dora");
        assert_ne!(dora, answer);
    }

    /// True when the hand still holds a full bulging float after discarding
    /// one copy of `answer`.
    fn bulge_survives(tiles: &[String], answer: &str) -> bool {
        let mut counts: std::collections::BTreeMap<String, usize> = Default::default();
        let mut removed = false;
        for tile in tiles {
            if !removed && tile == answer {
                removed = true;
                continue;
            }
            *counts.entry(tile.clone()).or_insert(0) += 1;
        }
        for suit in ['m', 'p', 's'] {
            for base in 1..=7u8 {
                let low = format!("{base}{suit}");
                let mid = format!("{}{suit}", base + 1);
                let high = format!("{}{suit}", base + 2);
                let get = |code: &str| counts.get(code).copied().unwrap_or(0);
                if get(&low) >= 1 && get(&mid) >= 2 && get(&high) >= 1 {
                    return true;
                }
            }
        }
        false
    }

    fn assert_nakabukure_constraints(state: &GameState) {
        assert_eq!(state.category, "nakabukure_ready");
        assert_eq!(state.target_action, TargetAction::NaniKiru);
        assert_eq!(state.correct_action.action_type(), CorrectActionType::Dama);
        assert_eq!(state.tiles.len(), 14);
        assert_eq!(state.players.len(), 4);
        assert!(!state.is_agari);

        match (state.round_wind, state.hand_number) {
            (Wind::East, 1..=4) | (Wind::South, 1..=2) => {}
            other => panic!("invalid round: {other:?}"),
        }
        assert_eq!(state.riichi_sticks, 0);
        assert_eq!(state.dora_indicators.len(), 1);
        assert_eq!(state.ura_dora_indicators.len(), 1);
        assert!(state.tiles_remaining > 0);

        for opponent in &state.players[1..] {
            assert!(!opponent.is_riichi);
            assert!(opponent.melds.is_empty());
            assert!(opponent.riichi_discard_index.is_none());
        }

        let human = &state.players[0];
        assert!(human.is_human);
        assert!(!human.is_riichi);

        if human.melds.is_empty() {
            assert_one_away_table(state);
        } else {
            // The ready-hand lesson keeps its open Yakuhai Pon.
            assert_eq!(state.shanten, 0);
            assert_eq!(human.hand.len(), 10);
            assert_eq!(human.hand.len() + 1 + 3, 14);
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
            assert!(
                !human.discards[1].is_tsumogiri,
                "the discard after the Pon must be tedashi"
            );
            assert_ready_drop_constraints(state);
        }

        // The rivers come from one legal turn order.
        crate::generator::support::state_validation::validate_reachable_state(state)
            .expect("nakabukure table must be reachable");

        // Scores stay on the 100,000-point table.
        let total_score: i32 = state.players.iter().map(|player| player.score).sum();
        assert_eq!(total_score, 100_000);

        // The visible full hand is exactly hand + draw + melds.
        let draw = human.draw.as_deref().expect("human must have a draw");
        let mut expected_hand: Vec<String> = human.hand.clone();
        expected_hand.push(draw.to_string());
        for meld in &human.melds {
            expected_hand.extend(meld.tiles.iter().cloned());
        }
        expected_hand.sort();
        let mut actual = state.tiles.clone();
        actual.sort();
        assert_eq!(actual, expected_hand);
    }

    #[test]
    fn test_generate_puzzle_game_state() {
        for variant in Variant::ALL {
            let state = generate_variant("nakabukure_ready", variant)
                .unwrap_or_else(|err| panic!("{variant:?} generation failed: {err}"));
            assert_nakabukure_constraints(&state);
        }

        // The mixed entry point must be able to serve every variant.
        let state = generate("nakabukure_ready").expect("Puzzle generation must succeed");
        assert_nakabukure_constraints(&state);
    }

    #[test]
    fn the_drill_mixes_both_outcomes() {
        let mut drop = 0;
        let mut keep = 0;
        for _ in 0..120 {
            let state = generate("nakabukure_ready").expect("generation must succeed");
            let answer = state
                .correct_action
                .tile()
                .expect("answer tile")
                .to_string();
            if bulge_survives(&state.tiles, &answer) {
                keep += 1;
            } else {
                drop += 1;
            }
        }
        assert!(drop > 0, "the drill must still ask for the bulge discard");
        assert!(
            keep > 0,
            "the drill must sometimes keep the bulge and discard another tile"
        );
    }

    #[test]
    fn test_nakabukure_constraints_100_runs() {
        let start = std::time::Instant::now();

        for run in 0..100 {
            let state = generate("nakabukure_ready")
                .unwrap_or_else(|err| panic!("run {run} failed: {err}"));
            assert_nakabukure_constraints(&state);
        }

        let elapsed = start.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(10),
            "100 rejected-sample generations took {elapsed:?}"
        );
    }
}
