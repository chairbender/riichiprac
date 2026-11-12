//! Concealed quad (ankan): declare it or keep the four copies?
//!
//! Riichi Book 1, ch. 9, "Concealed quad (ankan)", lists the conditions that
//! justify the quad - "1-away, where at least one block has a good wait" and
//! "2-away, where all the blocks have a good wait" - and then the cases where
//! the quad is wrong even when the hand is close to ready, the first of which
//! is "one of the four tiles can be used a good floating tile".
//!
//! One lesson, one neutral question ("Call Kan, or discard?"), so the coin
//! flip happens before rejection sampling: half the returned puzzles are quad
//! hands the book justifies and half are the floating-tile decline, with no
//! visible hint about which answer is expected.

mod board;
mod skeleton;

use crate::generator::support::retry::generate_with_retries;
use crate::rng::gen_bool;
use crate::state::GameState;

/// Generates a hand where the player holds all four copies of a tile and must
/// decide whether to declare a concealed quad.
pub fn generate(category: &str) -> Result<GameState, String> {
    if gen_bool(0.5) {
        generate_kan(category)
    } else {
        generate_decline(category)
    }
}

/// Generates the positive half: a hand the book's ankan conditions justify.
///
/// The two conditions are drawn with equal weight, so a run covers both
/// "1-away, where at least one block has a good wait" and "2-away, where all
/// the blocks have a good wait".
fn generate_kan(category: &str) -> Result<GameState, String> {
    generate_with_retries("ankan", 20_000, || {
        let shape = if gen_bool(0.5) {
            skeleton::AnkanShape::OneAwayGoodWait
        } else {
            skeleton::AnkanShape::TwoAwayAllGoodWaits
        };
        let skeleton = skeleton::build(shape)?;
        board::build(category, &skeleton, board::AnkanAnswer::Kan)
    })
}

/// Generates the book's decline case: a close-to-ready hand whose fourth copy
/// is a good floating tile, so the answer is to discard the useless tile and
/// keep the four copies.
fn generate_decline(category: &str) -> Result<GameState, String> {
    generate_with_retries("ankan (decline)", 20_000, || {
        let skeleton = skeleton::build(skeleton::AnkanShape::FloatingTileDecline)?;
        board::build(category, &skeleton, board::AnkanAnswer::Decline)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    use agari::parse::to_counts;
    use agari::shanten::{calculate_shanten, calculate_shanten_with_melds, calculate_ukeire};
    use agari::tile::{Suit, Tile};

    use crate::generator::support::testing::parse_tile;
    use crate::state::{CorrectActionType, TargetAction};

    /// The ten tiles left once the quad is declared, read off the state.
    fn post_kan_tiles(state: &GameState) -> Vec<Tile> {
        let human = &state.players[0];
        let quad = human.draw.as_deref().expect("the quad decision has a draw");
        human
            .hand
            .iter()
            .filter(|code| code.as_str() != quad)
            .map(|code| parse_tile(code))
            .collect()
    }

    fn post_kan_shanten(state: &GameState) -> i8 {
        calculate_shanten_with_melds(&to_counts(&post_kan_tiles(state)), 1).shanten
    }

    /// The displayed fourteen tiles, read off the state.
    fn displayed_tiles(state: &GameState) -> Vec<Tile> {
        state.tiles.iter().map(|code| parse_tile(code)).collect()
    }

    fn quad_tile(state: &GameState) -> Tile {
        parse_tile(state.players[0].draw.as_deref().expect("draw"))
    }

    /// Sorted distinct ranks per suit, used to read the block shape back off
    /// the concealed ten tiles.
    fn suited_ranks(tiles: &[Tile]) -> [Vec<u8>; 3] {
        let mut ranks = [Vec::new(), Vec::new(), Vec::new()];
        for tile in tiles {
            if let Tile::Suited { suit, value } = tile {
                let index = match suit {
                    Suit::Man => 0,
                    Suit::Pin => 1,
                    Suit::Sou => 2,
                };
                ranks[index].push(*value);
            }
        }
        for ranks in &mut ranks {
            ranks.sort_unstable();
            ranks.dedup();
        }
        ranks
    }

    fn has_side_wait_block(tiles: &[Tile]) -> bool {
        suited_ranks(tiles).iter().any(|ranks| {
            ranks.len() == 2 && ranks[1] == ranks[0] + 1 && (2..=7).contains(&ranks[0])
        })
    }

    fn has_closed_wait_block(tiles: &[Tile]) -> bool {
        suited_ranks(tiles)
            .iter()
            .any(|ranks| ranks.len() == 2 && ranks[1] == ranks[0] + 2)
    }

    fn all_blocks_are_side_waits(tiles: &[Tile]) -> bool {
        suited_ranks(tiles).iter().all(|ranks| match ranks.len() {
            0 => true,
            2 => ranks[1] == ranks[0] + 1 && (2..=7).contains(&ranks[0]),
            _ => false,
        })
    }

    fn assert_kan_constraints(state: &GameState) {
        assert_eq!(state.category, "ankan_decision");
        assert_eq!(state.target_action, TargetAction::Kan);
        assert_eq!(state.correct_action.action_type(), CorrectActionType::Kan);
        assert_eq!(state.tiles.len(), 14);
        assert_eq!(state.players.len(), 4);
        assert!(state.shouminkan_triggers.is_empty());
        assert!(state.riichi_triggers.is_empty());
        assert!(state.dama_reasons.is_empty());
        assert_eq!(state.dora_indicators.len(), 1);
        assert_eq!(state.ura_dora_indicators.len(), 1);
        assert!(state.tiles_remaining > 0);
        assert!(!state.can_riichi, "a Kan decision must not offer Riichi");

        let human = &state.players[0];
        assert!(human.is_human);
        assert!(!human.is_riichi);
        assert!(human.melds.is_empty(), "an ankan decision has no melds yet");
        assert_eq!(human.hand.len(), 13);

        let draw = human.draw.as_deref().expect("the quad is the draw");
        assert_eq!(Some(draw), state.correct_action.tile());

        // All four copies are concealed: three in hand and the drawn fourth.
        assert_eq!(
            human
                .hand
                .iter()
                .filter(|tile| tile.as_str() == draw)
                .count(),
            3,
            "the hand must hold the other three copies of the quad"
        );

        let mut expected = human.hand.clone();
        expected.push(draw.to_string());
        expected.sort();
        let mut actual = state.tiles.clone();
        actual.sort();
        assert_eq!(actual, expected, "displayed tiles must match the hand");

        // The quad is an honor in the Kan lesson, so the fourth copy has no
        // use as a floating tile: the book's only objection cannot apply.
        let quad = quad_tile(state);
        assert!(
            matches!(quad, Tile::Honor(_)),
            "the Kan lesson builds the quad from an honor"
        );

        let post_kan = post_kan_tiles(state);
        assert_eq!(post_kan.len(), 10);
        let shanten = post_kan_shanten(state);
        assert!(
            matches!(shanten, 1 | 2),
            "the Kan lesson is 1-away or 2-away, got {shanten}"
        );
        // The table's own shanten has to agree with the post-quad shape.
        assert_eq!(state.shanten, shanten);

        if shanten == 1 {
            assert!(
                has_side_wait_block(&post_kan),
                "the 1-away lesson keeps at least one good-wait block"
            );
            assert!(
                has_closed_wait_block(&post_kan),
                "the 1-away lesson also holds a bad-wait block, as in the book's example"
            );
        } else {
            assert!(
                all_blocks_are_side_waits(&post_kan),
                "the 2-away lesson has every block on a good wait"
            );
        }

        for opponent in &state.players[1..] {
            assert!(opponent.melds.is_empty());
            assert!(!opponent.is_riichi);
        }

        let indicator = parse_tile(&state.dora_indicators[0]);
        assert_ne!(indicator, quad);
        assert_ne!(
            agari::context::indicator_to_dora(indicator),
            quad,
            "the quad must not be the visible dora"
        );

        let total_score: i32 = state.players.iter().map(|player| player.score).sum();
        assert_eq!(total_score, 100_000);
    }

    fn assert_decline_constraints(state: &GameState) {
        assert_eq!(state.category, "ankan_decision");
        // The same neutral question; only the expected answer differs.
        assert_eq!(state.target_action, TargetAction::Kan);
        assert_eq!(
            state.correct_action.action_type(),
            CorrectActionType::Discard
        );
        assert_eq!(state.tiles.len(), 14);
        assert_eq!(state.shanten, 1, "the decline lesson is close to ready");
        assert!(!state.can_riichi);

        let human = &state.players[0];
        let draw = human.draw.as_deref().expect("the quad is the draw");
        let quad = quad_tile(state);
        let Tile::Suited { value, .. } = quad else {
            panic!("the decline quad must be a middle tile");
        };
        assert!(value == 4 || value == 6);

        let answer = state
            .correct_action
            .tile()
            .expect("the decline answer is a discard");
        assert_ne!(answer, draw, "the answer keeps the four copies");
        assert!(
            human.hand.iter().any(|tile| tile == answer),
            "the decline answer must be a tile in hand"
        );
        assert_eq!(human.hand.len(), 13, "the decline hand is concealed");

        // Both lines are 1-away, exactly as the book describes: the quad does
        // not improve the shanten, it only takes away the floating tile.
        assert_eq!(post_kan_shanten(state), 1);

        let mut float_line = displayed_tiles(state);
        float_line.retain(|tile| *tile != parse_tile(answer));
        assert_eq!(float_line.len(), 13);
        assert_eq!(calculate_shanten(&to_counts(&float_line)).shanten, 1);
        let float_acceptance: Vec<Tile> = calculate_ukeire(&to_counts(&float_line))
            .tiles
            .iter()
            .map(|u| u.tile)
            .collect();

        let mut kan_line = post_kan_tiles(state);
        kan_line.retain(|tile| *tile != parse_tile(answer));
        assert_eq!(kan_line.len(), 9);
        assert_eq!(
            calculate_shanten_with_melds(&to_counts(&kan_line), 1).shanten,
            1
        );
        let kan_acceptance: Vec<Tile> =
            agari::shanten::calculate_ukeire_with_melds(&to_counts(&kan_line), 1)
                .tiles
                .iter()
                .map(|u| u.tile)
                .collect();

        // The book's claim: the floating copy accepts its protoruns, and the
        // quad line can never accept them.
        let float_targets = skeleton::floating_acceptance(quad);
        assert_eq!(float_targets.len(), 4);
        for target in float_targets {
            assert!(
                float_acceptance.contains(&target),
                "keeping the quad must accept {target}"
            );
            assert!(
                !kan_acceptance.contains(&target),
                "the quad line must lose {target}"
            );
        }
    }

    #[test]
    fn test_ankan_decision_constraints() {
        let started = std::time::Instant::now();
        let mut kan_count = 0usize;
        let mut one_away_count = 0usize;
        let mut two_away_count = 0usize;
        let mut decline_count = 0usize;

        for run in 0..400 {
            let state =
                generate("ankan_decision").unwrap_or_else(|err| panic!("run {run} failed: {err}"));

            match state.correct_action.action_type() {
                CorrectActionType::Kan => {
                    kan_count += 1;
                    assert_kan_constraints(&state);
                    match post_kan_shanten(&state) {
                        1 => one_away_count += 1,
                        2 => two_away_count += 1,
                        other => panic!("run {run}: unexpected quad shanten {other}"),
                    }
                }
                CorrectActionType::Discard => {
                    decline_count += 1;
                    assert_decline_constraints(&state);
                }
                other => panic!("run {run}: unexpected ankan answer {other:?}"),
            }
        }

        // The answer is chosen by a coin flip before rejection sampling, so a
        // 400-hand sweep must land near 50/50 rather than telegraphing one half.
        println!(
            "answer coverage: {kan_count} Kan / {decline_count} discard \
             ({one_away_count} one-away, {two_away_count} two-away)"
        );
        assert!(
            kan_count >= 130 && decline_count >= 130,
            "answer coverage must be roughly even, got {kan_count} Kan / {decline_count} discard"
        );
        assert!(
            one_away_count > 0 && two_away_count > 0,
            "both book conditions must be covered: {one_away_count} one-away, \
             {two_away_count} two-away"
        );

        let elapsed = started.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(10),
            "400 ankan generations took {elapsed:?}"
        );
    }

    #[test]
    fn test_ankan_skeletons_are_always_valid() {
        for shape in [
            skeleton::AnkanShape::OneAwayGoodWait,
            skeleton::AnkanShape::TwoAwayAllGoodWaits,
            skeleton::AnkanShape::FloatingTileDecline,
        ] {
            for run in 0..50 {
                let skeleton = skeleton::build(shape)
                    .unwrap_or_else(|err| panic!("{shape:?} run {run}: {err}"));
                assert_eq!(skeleton.full_tiles().len(), 14);
                assert_eq!(skeleton.concealed_tiles.len(), 10);
                assert!(
                    agari::parse::validate_hand(&skeleton.full_tiles()).is_ok(),
                    "{shape:?} run {run}: hand must be legal"
                );
            }
        }
    }

    #[test]
    fn test_ankan_boards_are_reachable() {
        use crate::generator::support::state_validation::validate_reachable_state;

        for run in 0..40 {
            let state =
                generate("ankan_decision").unwrap_or_else(|err| panic!("run {run} failed: {err}"));
            validate_reachable_state(&state)
                .unwrap_or_else(|err| panic!("run {run} produced an unreachable table: {err}"));
        }
    }
}
