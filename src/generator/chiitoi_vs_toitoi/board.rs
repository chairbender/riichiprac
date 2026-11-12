//! Table assembly for the "chiitoitsu vs toitoi" lesson.
//!
//! The decision is a visible-information read: a pair is *futile* when both of
//! its remaining copies are already on the table, because then it can never
//! become a set. The generator therefore owns two things completely:
//!
//! - the hand is always four pairs, the triplet the draw just completed, and
//!   three lone tiles (the book's own shape, ch5:594);
//! - on the chiitoitsu branch, exactly two copies of one pair sit in two
//!   different opponents' rivers, so that pair is visibly dead; on the toitoi
//!   branch, no hand tile type appears in any river at all.
//!
//! Everything else is noise: the human's river and the dora are kept off every
//! hand tile so the visible count is exactly the lesson, and the table is
//! re-derived from the finished state before it is returned ([`validate`]).

use agari::context::indicator_to_dora;
use agari::parse::to_counts;
use agari::tile::Tile;

use super::skeleton::{ChiitoiSkeleton, Variant};
use crate::generator::support::analysis::{HandMetrics, evaluate_counts};
use crate::generator::support::deck::Deck;
use crate::generator::support::format::format_hand_compact;
use crate::generator::support::table::{
    deal_opponents, discards_from_tiles, random_round, random_scores_with_human_first,
    self_turn_river_plan,
};
use crate::rng::{gen_range, shuffle};
use crate::state::{CorrectAction, DecisionContext, GameState, PlayerState, TargetAction, Wind};

/// The validated hand shapes for one puzzle.
struct PreparedHand {
    /// The thirteen concealed tiles before the discard.
    human_hand: Vec<Tile>,
    /// The displayed fourteen tiles.
    full_tiles: Vec<Tile>,
    metrics: HandMetrics,
}

/// Builds and validates a complete board for an already-proven hand skeleton.
pub(super) fn build_board(category: &str, skeleton: &ChiitoiSkeleton) -> Result<GameState, String> {
    let prepared = prepare_hand(skeleton)?;
    let (mut deck, dora_indicator, ura_indicator) = build_deck(skeleton)?;

    let (round_wind, hand_number) = random_round();
    let honba = gen_range(0, 4) as u8;
    let scores = random_scores_with_human_first();

    // The hand is closed, so every river follows the natural rotation. A few
    // discards on each side are enough for the futile pair to be visible.
    let discard_count = gen_range(2, 7);
    let plan = self_turn_river_plan(Wind::East, &[], discard_count);

    // Reserve the doomed pair's two remaining copies before any opponent hand
    // is dealt: if one sat in a concealed hand, the pair would not be dead.
    let futile_copy = match skeleton.futile_pair {
        Some(tile) => {
            deck.take_n(tile, 2)
                .map_err(|_| format!("the {tile} pair cannot supply two visible copies"))?;
            Some(tile)
        }
        None => None,
    };

    let deal = deal_opponents(&mut deck, Wind::East, &scores, &plan)
        .ok_or_else(|| "Deck exhausted drawing the opponents".to_string())?;

    // Keep every hand tile type out of the human's river: a pair copy there
    // would confuse the visible count, and a wait tile there would be furiten.
    let human_types = distinct_tiles(&prepared.full_tiles);
    let human_river = deck
        .draw_excluding(plan.counts[0], &human_types)
        .ok_or_else(|| "Deck exhausted drawing the human river".to_string())?;

    // Plant the reserved copies in two different opponents' rivers, so the
    // pair reads as dead rather than as one opponent's own pair.
    let mut opponent_rivers: Vec<Vec<Tile>> = deal.rivers.clone();
    if let Some(tile) = futile_copy {
        let mut seats = [1usize, 2, 3];
        shuffle(&mut seats);
        for &seat in &seats[..2] {
            let river = opponent_rivers
                .get_mut(seat - 1)
                .ok_or_else(|| "missing opponent river".to_string())?;
            if river.is_empty() {
                return Err("an opponent river is too short to plant the futile pair".to_string());
            }
            let index = gen_range(0, river.len());
            river[index] = tile;
        }
    }

    let mut players = Vec::with_capacity(4);
    players.push(human_player(
        scores[0],
        &prepared.human_hand,
        skeleton,
        &human_river,
    ));
    for (index, opponent) in deal.players.iter().enumerate() {
        let river = &opponent_rivers[index];
        let mut discards = discards_from_tiles(river);
        crate::generator::support::table::force_tedashi(
            &mut discards,
            &plan.hand_discards[opponent.seat],
        );
        let mut player = opponent.clone();
        player.discards = discards;
        players.push(player);
    }

    let tiles_remaining = deck.remaining().saturating_sub(12).min(u8::MAX as usize) as u8;
    if tiles_remaining == 0 {
        return Err("No drawable tiles remain".to_string());
    }

    let state = GameState {
        category: category.to_string(),
        target_action: TargetAction::NaniKiru,
        // A 1-away hand cannot declare; the answer is the discard alone.
        can_riichi: false,
        correct_action: CorrectAction::dama(skeleton.answer_tile.to_string()),
        // The toitoi branch accepts any of its three lone tiles; the other two
        // are graded as the same answer.
        equivalent_tiles: skeleton
            .equivalent_tiles
            .iter()
            .map(ToString::to_string)
            .collect(),
        decision: DecisionContext::SelfTurn,
        scenario_note: None,
        call_offer: None,
        ai_decision: None,
        riichi_triggers: Vec::new(),
        dama_reasons: Vec::new(),
        shouminkan_triggers: Vec::new(),
        book_rationale: None,
        hand_string: format_hand_compact(&prepared.full_tiles),
        tiles: prepared
            .full_tiles
            .iter()
            .map(ToString::to_string)
            .collect(),
        shanten: prepared.metrics.shanten,
        is_agari: prepared.metrics.is_agari,
        decompositions_count: prepared.metrics.decompositions_count,
        ukeire_tiles: prepared.metrics.ukeire_tiles,
        ukeire_total: prepared.metrics.ukeire_total,
        round_wind,
        hand_number,
        honba,
        riichi_sticks: 0,
        dora_indicators: vec![dora_indicator.to_string()],
        ura_dora_indicators: vec![ura_indicator.to_string()],
        tiles_remaining,
        current_turn: 0,
        players,
    };

    validate(&state, skeleton)?;
    Ok(state)
}

/// Checks the hand is the shape the skeleton proved, then evaluates the answer.
fn prepare_hand(skeleton: &ChiitoiSkeleton) -> Result<PreparedHand, String> {
    let mut human_hand = skeleton.pre_draw_tiles();
    human_hand.sort();
    if human_hand.len() != 13 {
        return Err("a closed hand must hold thirteen concealed tiles".to_string());
    }
    if !human_hand.contains(&skeleton.triplet) {
        return Err("the drawn tile's pair partner must stay in the hand".to_string());
    }

    let mut full_tiles = skeleton.full_tiles();
    full_tiles.sort();
    if full_tiles.len() != 14 {
        return Err("a turn hand must hold fourteen tiles".to_string());
    }

    let post_discard = skeleton.post_discard_tiles();
    let metrics = evaluate_counts(&to_counts(&post_discard));
    if metrics.shanten != 1 {
        return Err(format!(
            "the answer must leave the hand 1-away, got {}",
            metrics.shanten
        ));
    }

    Ok(PreparedHand {
        human_hand,
        full_tiles,
        metrics,
    })
}

/// Removes the hand from the deck and draws the dora and ura indicators.
fn build_deck(skeleton: &ChiitoiSkeleton) -> Result<(Deck, Tile, Tile), String> {
    let mut deck = Deck::fresh();
    for tile in skeleton.full_tiles() {
        deck.take(tile)?;
    }

    let dora_indicator = deck
        .draw()
        .ok_or_else(|| "Deck exhausted drawing the dora indicator".to_string())?;
    let ura_indicator = deck
        .draw()
        .ok_or_else(|| "Deck exhausted drawing the ura indicator".to_string())?;

    // Keep value out of a shape decision: no displayed tile may be the dora.
    let dora = indicator_to_dora(dora_indicator);
    if skeleton.full_tiles().contains(&dora) {
        return Err("a hand tile cannot be the dora".to_string());
    }

    Ok((deck, dora_indicator, ura_indicator))
}

fn human_player(
    score: i32,
    human_hand: &[Tile],
    skeleton: &ChiitoiSkeleton,
    human_river: &[Tile],
) -> PlayerState {
    PlayerState {
        seat: 0,
        name: "You".to_string(),
        is_human: true,
        wind: Wind::East,
        score,
        hand: human_hand.iter().map(ToString::to_string).collect(),
        draw: Some(skeleton.draw.to_string()),
        red_fives: Vec::new(),
        discards: discards_from_tiles(human_river),
        melds: Vec::new(),
        is_riichi: false,
        riichi_discard_index: None,
    }
}

/// Re-derives the answer from the finished payload and checks the visibility
/// that decides it.
///
/// This is deliberately not a re-run of the skeleton: it reads the same
/// fourteen-tile hand and the same rivers the player will see, so a planting
/// mistake (a copy left in the deck, or a second dead pair) fails here.
fn validate(state: &GameState, skeleton: &ChiitoiSkeleton) -> Result<(), String> {
    let human = state
        .players
        .first()
        .ok_or_else(|| "the table has no human seat".to_string())?;
    if !human.melds.is_empty() {
        return Err("the lesson is a closed hand".to_string());
    }
    let draw = human
        .draw
        .as_deref()
        .ok_or_else(|| "the human must have drawn a tile".to_string())?;
    if draw != skeleton.draw.to_string() {
        return Err("the displayed draw is not the skeleton's draw".to_string());
    }

    let mut expected = human.hand.clone();
    expected.push(draw.to_string());
    expected.sort();
    let mut actual = state.tiles.clone();
    actual.sort();
    if actual != expected {
        return Err("the displayed hand is not hand plus draw".to_string());
    }

    // Pair-like tiles of the drawn hand: a pair held exactly twice. (The
    // triplet contributes a pair to chiitoitsu, but it cannot be dead: only one
    // copy of its tile is left in the wall.)
    let hand_tiles: Vec<Tile> = state
        .tiles
        .iter()
        .filter_map(|code| Tile::try_from(code.as_str()).ok())
        .collect();
    let counts = to_counts(&hand_tiles);
    let mut dead_pairs: Vec<Tile> = counts
        .iter()
        .filter(|(_, count)| **count == 2)
        .map(|(tile, _)| *tile)
        .filter(|tile| visible_copies(state, *tile) >= 4)
        .collect();
    dead_pairs.sort();
    let mut dead_pairs_expected: Vec<Tile> = skeleton.futile_pair.into_iter().collect();
    dead_pairs_expected.sort();
    if dead_pairs != dead_pairs_expected {
        return Err(format!(
            "the state's dead pairs {dead_pairs:?} disagree with the skeleton's \
             {dead_pairs_expected:?}"
        ));
    }

    if let Some(futile) = skeleton.futile_pair {
        // Both extra copies must be in opponents' rivers, not in a meld or the
        // human's own river.
        let code = futile.to_string();
        let planted: usize = state
            .players
            .iter()
            .skip(1)
            .flat_map(|player| player.discards.iter())
            .filter(|discard| discard.tile == code)
            .count();
        if planted != 2 {
            return Err(format!(
                "the {futile} pair needs both remaining copies in opponent rivers, found {planted}"
            ));
        }
    }

    // The answer must be one of the displayed tiles and must leave the shape
    // the skeleton proved.
    let answer = skeleton.answer_tile.to_string();
    if !state.tiles.contains(&answer) {
        return Err("the answer is not in the displayed hand".to_string());
    }
    match skeleton.variant {
        Variant::FutilePair if answer != skeleton.triplet.to_string() => {
            Err("the futile-pair answer must be the drawn third copy".to_string())
        }
        Variant::BuildToitoi if skeleton.singles.iter().all(|t| t.to_string() != answer) => {
            Err("the toitoi answer must be a lone tile".to_string())
        }
        _ => crate::generator::support::state_validation::validate_reachable_state(state),
    }
}

/// Copies this player can see: the hand, every river, every open meld, and the
/// dora indicators. Opponents' concealed hands are not visible.
fn visible_copies(state: &GameState, tile: Tile) -> u8 {
    let code = tile.to_string();
    let mut total = state
        .tiles
        .iter()
        .filter(|held| held.as_str() == code)
        .count() as u8;
    for player in &state.players {
        total += player
            .discards
            .iter()
            .filter(|discard| discard.tile == code)
            .count() as u8;
        for meld in &player.melds {
            total += meld.tiles.iter().filter(|held| *held == &code).count() as u8;
        }
    }
    total += state
        .dora_indicators
        .iter()
        .filter(|indicator| *indicator == &code)
        .count() as u8;
    total
}

fn distinct_tiles(tiles: &[Tile]) -> Vec<Tile> {
    let mut distinct = tiles.to_vec();
    distinct.sort();
    distinct.dedup();
    distinct
}

#[cfg(test)]
mod tests {
    use super::super::{generate, generate_variant};
    use super::*;
    use crate::state::CorrectActionType;
    use agari::parse::parse_hand;
    use agari::shanten::{calculate_shanten, calculate_ukeire};
    use std::collections::BTreeMap;

    fn counts_in(tiles: &[String]) -> BTreeMap<String, usize> {
        let mut counts = BTreeMap::new();
        for tile in tiles {
            *counts.entry(tile.clone()).or_insert(0) += 1;
        }
        counts
    }

    fn pairs_in(tiles: &[String]) -> Vec<String> {
        counts_in(tiles)
            .into_iter()
            .filter(|(_, count)| *count == 2)
            .map(|(tile, _)| tile)
            .collect()
    }

    fn assert_chiitoi_constraints(state: &GameState) {
        assert_eq!(state.category, "chiitoi_vs_toitoi");
        assert_eq!(state.target_action, TargetAction::NaniKiru);
        assert_eq!(state.correct_action.action_type(), CorrectActionType::Dama);
        assert_eq!(state.tiles.len(), 14);
        assert_eq!(state.players.len(), 4);
        assert_eq!(state.shanten, 1);
        assert!(!state.is_agari);
        assert!(!state.can_riichi, "a 1-away hand cannot declare Riichi");
        assert_eq!(state.riichi_sticks, 0);
        assert_eq!(state.dora_indicators.len(), 1);
        assert_eq!(state.ura_dora_indicators.len(), 1);
        assert!(state.tiles_remaining > 0);

        match (state.round_wind, state.hand_number) {
            (Wind::East, 1..=4) | (Wind::South, 1..=2) => {}
            other => panic!("invalid round: {other:?}"),
        }

        for opponent in &state.players[1..] {
            assert!(!opponent.is_riichi);
            assert!(opponent.melds.is_empty());
            assert!(opponent.riichi_discard_index.is_none());
        }

        let human = &state.players[0];
        assert!(human.is_human);
        assert!(!human.is_riichi);
        assert!(human.melds.is_empty());
        assert_eq!(human.hand.len(), 13);
        let draw = human.draw.clone().expect("the human must have drawn");

        // The draw makes a pair into a triplet: three copies in the full hand.
        assert_eq!(
            counts_in(&state.tiles).get(&draw).copied(),
            Some(3),
            "the draw must complete a triplet"
        );

        // Four pairs still hold exactly twice, and three lone tiles remain.
        let pairs = pairs_in(&state.tiles);
        assert_eq!(pairs.len(), 4, "the hand must hold four pairs: {pairs:?}");
        let counts = counts_in(&state.tiles);
        let singles: Vec<&String> = counts
            .iter()
            .filter(|(_, count)| **count == 1)
            .map(|(tile, _)| tile)
            .collect();
        assert_eq!(singles.len(), 3, "three lone tiles must remain");

        // The answer clears one of the two kinds and leaves 1-away.
        let answer = state
            .correct_action
            .tile()
            .expect("answer tile")
            .to_string();
        assert!(state.tiles.contains(&answer));
        let mut post = state.tiles.clone();
        let index = post
            .iter()
            .position(|tile| tile == &answer)
            .expect("answer in hand");
        post.remove(index);
        let parsed = parse_hand(&post.join("")).expect("post-discard hand must parse");
        let post_counts = to_counts(&parsed);
        assert_eq!(calculate_shanten(&post_counts).shanten, 1);
        let ukeire = calculate_ukeire(&post_counts);
        assert!(!ukeire.tiles.is_empty());

        // Dead-pair count, straight from the payload.
        let mut dead = Vec::new();
        for pair in &pairs {
            let mut visible = state.tiles.iter().filter(|tile| *tile == pair).count();
            for player in &state.players {
                visible += player
                    .discards
                    .iter()
                    .filter(|discard| &discard.tile == pair)
                    .count();
                for meld in &player.melds {
                    visible += meld.tiles.iter().filter(|tile| *tile == pair).count();
                }
            }
            visible += state
                .dora_indicators
                .iter()
                .filter(|indicator| *indicator == pair)
                .count();
            if visible >= 4 {
                dead.push(pair.clone());
            }
        }

        let answer_is_draw = answer == draw;
        if answer_is_draw {
            // Chiitoitsu: exactly one dead pair, both extra copies in rivers.
            assert_eq!(dead.len(), 1, "the chiitoitsu hand needs one dead pair");
            let dead_tile = &dead[0];
            let planted: usize = state.players[1..]
                .iter()
                .flat_map(|player| player.discards.iter())
                .filter(|discard| &discard.tile == dead_tile)
                .count();
            assert_eq!(planted, 2, "both dead copies must be in opponent rivers");
            assert!(state.equivalent_tiles.is_empty());

            // The book's discard restores five pairs and three lone tiles.
            assert_eq!(pairs_in(&post).len(), 5);
        } else {
            // Toitoi: no dead pair, the triplet stays, and the other two lone
            // tiles are graded as the same answer.
            assert!(dead.is_empty(), "the toitoi hand must have no dead pair");
            assert_eq!(
                counts_in(&post)[&draw],
                3,
                "keeping the triplet is the toitoi plan"
            );
            assert_eq!(pairs_in(&post).len(), 4);
            assert_eq!(state.equivalent_tiles.len(), 2);
            for equivalent in &state.equivalent_tiles {
                assert_ne!(equivalent, &answer);
                assert_eq!(counts_in(&state.tiles).get(equivalent).copied(), Some(1));
            }

            // The counted chiitoitsu discard accepts strictly more tiles.
            let mut counted = state.tiles.clone();
            let draw_index = counted
                .iter()
                .position(|tile| tile == &draw)
                .expect("draw in hand");
            counted.remove(draw_index);
            let counted = parse_hand(&counted.join("")).expect("counted hand must parse");
            let counted_total = calculate_ukeire(&to_counts(&counted)).total_count;
            assert!(
                counted_total > ukeire.total_count,
                "the chiitoitsu discard must look better by acceptance ({counted_total} vs {})",
                ukeire.total_count
            );
        }

        // No displayed hand tile is the dora.
        let indicator = parse_hand(&state.dora_indicators[0])
            .expect("dora indicator must parse")
            .remove(0);
        let dora = indicator_to_dora(indicator).to_string();
        assert!(!state.tiles.contains(&dora), "no hand tile may be the dora");

        // The rivers come from one legal turn order.
        crate::generator::support::state_validation::validate_reachable_state(state)
            .expect("the table must be reachable");

        // Scores stay on the 100,000-point table.
        assert_eq!(state.players.iter().map(|p| p.score).sum::<i32>(), 100_000);
    }

    #[test]
    fn test_generate_puzzle_game_state() {
        for variant in Variant::ALL {
            let state = generate_variant("chiitoi_vs_toitoi", variant)
                .unwrap_or_else(|err| panic!("{variant:?} generation failed: {err}"));
            assert_chiitoi_constraints(&state);
        }

        let state = generate("chiitoi_vs_toitoi").expect("generation must succeed");
        assert_chiitoi_constraints(&state);
    }

    #[test]
    fn the_drill_mixes_both_answers() {
        let mut chiitoitsu = 0;
        let mut toitoi = 0;
        for _ in 0..80 {
            let state = generate("chiitoi_vs_toitoi").expect("generation must succeed");
            let answer = state.correct_action.tile().expect("answer").to_string();
            let draw = state.players[0].draw.clone().expect("draw");
            if answer == draw {
                chiitoitsu += 1;
            } else {
                toitoi += 1;
            }
        }
        assert!(
            chiitoitsu > 0,
            "the drill must ask for chiitoitsu sometimes"
        );
        assert!(toitoi > 0, "the drill must ask for toitoi sometimes");
    }

    #[test]
    fn test_chiitoi_constraints_100_runs() {
        let start = std::time::Instant::now();

        for run in 0..100 {
            let state =
                generate("chiitoi_vs_toitoi").unwrap_or_else(|err| panic!("run {run}: {err}"));
            assert_chiitoi_constraints(&state);
        }

        let elapsed = start.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(10),
            "100 rejected-sample generations took {elapsed:?}"
        );
    }
}
