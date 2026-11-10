use agari::context::{GameContext, WinType, indicator_to_dora};
use agari::hand::{Meld, decompose_hand_with_melds};
use agari::parse::{to_counts, validate_hand};
use agari::shanten::{calculate_shanten, calculate_ukeire};
use agari::tile::{Honor, Suit, Tile};
use agari::yaku::{Yaku, detect_yaku_with_context};

use crate::generator::block_theory::shapes::{try_add_sequence, try_add_triplet};
use crate::generator::support::analysis::{HandMetrics, evaluate_counts, wind_to_honor};
use crate::generator::support::deck::{ALL_TILES, Deck};
use crate::generator::support::format::format_hand_compact;
use crate::generator::support::retry::generate_with_retries;
use crate::generator::support::table::{
    OpponentDeal, deal_opponents, discards_from_tiles, random_round, random_scores_with_human_first,
};
use crate::rng::{choose, gen_bool, gen_range};
use crate::state::{
    CalledMeld, CorrectAction, GameState, MeldType, PlayerState, TargetAction, Wind,
};

/// The constructed parts of a "Ryanmen protorun + 1" hand.
struct RyanmenSkeleton {
    /// All 14 tiles for evaluation, including the open Yakuhai meld.
    full_tiles: Vec<Tile>,
    /// The 11 concealed tiles before the duplicate is discarded.
    concealed_tiles: Vec<Tile>,
    /// The three-tile shape (XXY or XYY).
    shape_tiles: [Tile; 3],
    /// The two tiles that complete the ryanmen.
    wait_tiles: [Tile; 2],
    /// The three tiles of the open Yakuhai meld.
    open_meld_tiles: Vec<Tile>,
    /// The duplicate tile that should be discarded.
    correct_tile: Tile,
}

/// Generates the first Block Theory scenario: a ryanmen protorun (XXY/XYY)
/// with an open Yakuhai meld, two completed sets, and a separate pair.
///
/// The duplicate tile is the correct discard because it leaves the
/// consecutive pair intact as a live ryanmen wait.
pub fn generate(category: &str) -> Result<GameState, String> {
    generate_with_retries("ryanmen", 10_000, || {
        let skeleton = build_skeleton()?;
        build_board(category, &skeleton)
    })
}

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
    deal: OpponentDeal,
    tiles_remaining: u8,
}

/// Builds and validates a complete board for an already-valid hand skeleton.
fn build_board(category: &str, skeleton: &RyanmenSkeleton) -> Result<GameState, String> {
    let prepared = prepare_hand(skeleton)?;
    let (mut deck, dora_indicator, ura_indicator) = build_deck(skeleton)?;

    let (round_wind, hand_number) = random_round();
    let honba = gen_range(0, 4) as u8;
    let scores = random_scores_with_human_first();

    // The human is the current player (about to discard), so every player
    // has completed the same number of turns and made one discard per turn.
    // At least one turn has passed because the human has an open Pon.
    let discard_count = gen_range(1, 7);
    let deal = deal_opponents(&mut deck, Wind::East, &scores, discard_count)
        .ok_or_else(|| "Deck exhausted drawing the opponents".to_string())?;

    // Furiten: the human's river cannot contain either ryanmen wait tile.
    let human_river = deck
        .draw_excluding(discard_count, &skeleton.wait_tiles)
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
        discards: discards_from_tiles(&human_river),
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
        riichi_triggers: Vec::new(),
        dama_reasons: Vec::new(),
        shouminkan_triggers: Vec::new(),
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

/// Constructs a valid "Ryanmen protorun + 1" skeleton from a fresh deck.
fn build_skeleton() -> Result<RyanmenSkeleton, String> {
    'attempt: for _ in 0..256 {
        let mut deck = Deck::fresh();

        let suits = [Suit::Man, Suit::Pin, Suit::Sou];
        let suit = choose(&suits).ok_or_else(|| "No suits available".to_string())?;

        // X and X+1 stay inside 2..=8 so the remaining two tiles are a
        // true ryanmen (23, 34, ... 78) rather than a terminal penchan.
        let base = gen_range(2, 8) as u8;
        let x = Tile::Suited { suit, value: base };
        let y = Tile::Suited {
            suit,
            value: base + 1,
        };
        let wait_low = Tile::Suited {
            suit,
            value: base - 1,
        };
        let wait_high = Tile::Suited {
            suit,
            value: base + 2,
        };

        // XXY leaves X as the duplicate; XYY leaves Y as the duplicate.
        let (shape_tiles, correct_tile) = if gen_bool(0.5) {
            ([x, x, y], x)
        } else {
            ([x, y, y], y)
        };

        for tile in &shape_tiles {
            if deck.take(*tile).is_err() {
                continue 'attempt;
            }
        }

        // Open Yakuhai triplet: any dragon guarantees a yaku.
        let dragons = [
            Tile::Honor(Honor::White),
            Tile::Honor(Honor::Green),
            Tile::Honor(Honor::Red),
        ];
        let dragon = choose(&dragons).ok_or_else(|| "No dragons available".to_string())?;
        let open_meld_tiles = vec![dragon, dragon, dragon];
        if deck.take_n(dragon, 3).is_err() {
            continue 'attempt;
        }

        // Two completed sets, either sequences or triplets.
        let mut concealed_tiles = Vec::with_capacity(11);
        for _ in 0..2 {
            let added = if gen_bool(0.65) {
                try_add_sequence(&mut concealed_tiles, &mut deck)
                    || try_add_triplet(&mut concealed_tiles, &mut deck)
            } else {
                try_add_triplet(&mut concealed_tiles, &mut deck)
                    || try_add_sequence(&mut concealed_tiles, &mut deck)
            };
            if !added {
                continue 'attempt;
            }
        }

        // A separate pair, deliberately not overlapping the special shape.
        let pair_candidates: Vec<Tile> = ALL_TILES
            .iter()
            .copied()
            .filter(|tile| !shape_tiles.contains(tile) && deck.count(*tile) >= 2)
            .collect();
        let pair_tile = match choose(&pair_candidates) {
            Some(tile) => tile,
            None => continue 'attempt,
        };
        concealed_tiles.push(pair_tile);
        concealed_tiles.push(pair_tile);
        if deck.take_n(pair_tile, 2).is_err() {
            continue 'attempt;
        }

        concealed_tiles.extend(shape_tiles.iter().copied());

        let mut full_tiles = concealed_tiles.clone();
        full_tiles.extend(open_meld_tiles.iter().copied());

        if validate_hand(&full_tiles).is_err() {
            continue 'attempt;
        }

        // Confirm the duplicate discard leaves a tenpai hand, that the
        // ryanmen is the only wait, and that both sides remain live.
        if !deck.has(wait_low) || !deck.has(wait_high) {
            continue 'attempt;
        }

        let mut post_discard = full_tiles.clone();
        let Some(duplicate_index) = post_discard.iter().position(|tile| *tile == correct_tile)
        else {
            continue 'attempt;
        };
        post_discard.remove(duplicate_index);
        let post_counts = to_counts(&post_discard);
        if calculate_shanten(&post_counts).shanten != 0 {
            continue 'attempt;
        }

        let post_ukeire = calculate_ukeire(&post_counts);
        let post_wait_tiles: Vec<Tile> = post_ukeire.tiles.iter().map(|u| u.tile).collect();
        if post_wait_tiles.len() != 2
            || !post_wait_tiles.contains(&wait_low)
            || !post_wait_tiles.contains(&wait_high)
        {
            continue 'attempt;
        }

        return Ok(RyanmenSkeleton {
            full_tiles,
            concealed_tiles,
            shape_tiles,
            wait_tiles: [wait_low, wait_high],
            open_meld_tiles,
            correct_tile,
        });
    }

    Err("Failed to construct a valid ryanmen protorun hand".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    use agari::parse::parse_hand;

    use crate::state::CorrectActionType;

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
        assert_eq!(human.draw.as_deref(), Some(state.correct_action.tile()));
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

        // Every player has taken the same number of turns and discarded once
        // per turn. The human is currently about to discard.
        let discard_counts: Vec<usize> = state
            .players
            .iter()
            .map(|player| player.discards.len())
            .collect();
        assert!(
            discard_counts
                .iter()
                .all(|&count| count == discard_counts[0]),
            "discard counts must line up: {discard_counts:?}"
        );
        assert!((1..=6).contains(&discard_counts[0]));

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
        let state = generate("ryanmen_protorun").expect("Puzzle generation must succeed");

        assert_ryanmen_constraints(&state);
        assert_eq!(state.shanten, 0);
        assert_eq!(state.ukeire_tiles.len(), 2);
        assert!(
            state
                .tiles
                .iter()
                .any(|tile| tile == state.correct_action.tile())
        );

        // Discarding the duplicate leaves the two-sided ryanmen wait.
        let mut post_discard = state.tiles.clone();
        let duplicate_index = post_discard
            .iter()
            .position(|tile| tile == state.correct_action.tile())
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

    #[test]
    fn test_ryanmen_skeleton_generalizes() {
        let mut suits = HashSet::new();
        let mut bases = HashSet::new();

        for _ in 0..100 {
            let skeleton = build_skeleton().expect("Ryanmen skeleton must build");

            assert_eq!(skeleton.full_tiles.len(), 14);
            assert_eq!(skeleton.concealed_tiles.len(), 11);
            assert_eq!(skeleton.open_meld_tiles.len(), 3);
            assert!(validate_hand(&skeleton.full_tiles).is_ok());

            let mut assembled = skeleton.concealed_tiles.clone();
            assembled.extend(skeleton.open_meld_tiles.iter().copied());
            assembled.sort();
            let mut full = skeleton.full_tiles.clone();
            full.sort();
            assert_eq!(assembled, full);

            let [a, b, c] = skeleton.shape_tiles;
            assert!(a == b || b == c, "shape must be XXY or XYY");
            let duplicate = if a == b { a } else { c };
            assert_eq!(skeleton.correct_tile, duplicate);

            let (x, y) = if a == b { (a, c) } else { (a, b) };
            let (wait_low, wait_high) = match (x, y) {
                (
                    Tile::Suited {
                        suit: suit_x,
                        value: value_x,
                    },
                    Tile::Suited {
                        suit: suit_y,
                        value: value_y,
                    },
                ) => {
                    assert_eq!(suit_x, suit_y);
                    assert_eq!(value_y, value_x + 1, "ryanmen tiles must be adjacent");
                    assert!(
                        (2..=7).contains(&value_x),
                        "lower ryanmen tile must stay within 2-7"
                    );
                    suits.insert(suit_x);
                    bases.insert(value_x);

                    (
                        Tile::Suited {
                            suit: suit_x,
                            value: value_x - 1,
                        },
                        Tile::Suited {
                            suit: suit_x,
                            value: value_x + 2,
                        },
                    )
                }
                _ => panic!("ryanmen shape must use suited tiles"),
            };
            assert_eq!(skeleton.wait_tiles, [wait_low, wait_high]);

            // The duplicate is the only discard that preserves the ryanmen.
            let mut post_discard = skeleton.full_tiles.clone();
            let duplicate_index = post_discard
                .iter()
                .position(|tile| *tile == skeleton.correct_tile)
                .expect("duplicate must be present");
            post_discard.remove(duplicate_index);
            assert_eq!(
                calculate_shanten(&to_counts(&post_discard)).shanten,
                0,
                "discarding the duplicate must leave tenpai"
            );

            let post_ukeire = calculate_ukeire(&to_counts(&post_discard));
            let wait_tiles: Vec<Tile> = post_ukeire.tiles.iter().map(|u| u.tile).collect();
            assert_eq!(wait_tiles.len(), 2);
            assert!(
                wait_tiles.contains(&wait_low) && wait_tiles.contains(&wait_high),
                "both sides of the ryanmen must remain live"
            );
        }

        assert!(suits.len() > 1, "generator must cover multiple suits");
        assert!(
            bases.len() > 1,
            "generator must cover multiple base numbers"
        );
    }
}
