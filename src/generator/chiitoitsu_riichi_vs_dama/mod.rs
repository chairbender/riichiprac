mod board;
mod dama;
mod riichi;
mod scoring;
mod skeleton;
mod triggers;

use crate::generator::support::retry::generate_with_retries;
use crate::rng::gen_bool;
use crate::state::GameState;

/// Generates a newly-tenpai seven-pairs hand that randomly asks for Riichi or
/// dama.
///
/// The 13-tile hand before the draw is five pairs plus three lone tiles. The
/// drawn tile completes the sixth pair, so Riichi only becomes available on
/// this turn. Either of the two remaining lone tiles can then be discarded;
/// both leave a seven-pairs wait and are graded as correct, and the lesson's
/// constraints hold for both waits so the declaration is the real decision.
///
/// The Riichi path applies at least one Riichi heuristic and keeps both waits
/// off the dora. The dama path inverts those conditions and guarantees a
/// Mangan-or-better hand through two dora pairs.
pub fn generate(category: &str) -> Result<GameState, String> {
    generate_with_retries("chiitoitsu", 20_000, || {
        let skeleton = if gen_bool(0.5) {
            riichi::build_skeleton(triggers::random())?
        } else {
            dama::build_skeleton()?
        };

        board::build(category, &skeleton)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    use agari::context::indicator_to_dora;
    use agari::parse::to_counts;
    use agari::scoring::ScoreLevel;
    use agari::shanten::{calculate_shanten, calculate_ukeire};
    use agari::tile::Tile;

    use crate::generator::support::analysis::regular_dora_in_hand;
    use crate::generator::support::deck::ALL_TILES;
    use crate::generator::support::testing::parse_tile;
    use crate::generator::support::tiles::{is_outside_456, suji_tiles};
    use crate::state::{CorrectActionType, DamaReason, RiichiTrigger, TargetAction, Wind};

    /// The 13-tile hand before the draw, exactly as the state displays it.
    fn pre_draw_tiles(state: &GameState) -> Vec<Tile> {
        state.players[0]
            .hand
            .iter()
            .map(|tile| parse_tile(tile))
            .collect()
    }

    fn drawn_tile(state: &GameState) -> Tile {
        parse_tile(
            state.players[0]
                .draw
                .as_deref()
                .expect("chiitoitsu human must have a draw"),
        )
    }

    /// The 14-tile hand after the draw (hand plus the drawn tile).
    fn full_tiles(state: &GameState) -> Vec<Tile> {
        let mut tiles = pre_draw_tiles(state);
        tiles.push(drawn_tile(state));
        tiles
    }

    /// The two accepted discards: the canonical answer and its equivalent.
    fn accepted_tiles(state: &GameState) -> [Tile; 2] {
        let canonical = parse_tile(state.correct_action.tile().expect("chiitoitsu answer tile"));
        let equivalent = parse_tile(
            state
                .equivalent_tiles
                .first()
                .expect("chiitoitsu must accept its twin discard"),
        );
        [canonical, equivalent]
    }

    fn without_one(tiles: &[Tile], tile: Tile) -> Vec<Tile> {
        let mut out = tiles.to_vec();
        let index = out
            .iter()
            .position(|candidate| *candidate == tile)
            .unwrap_or_else(|| panic!("hand does not contain {tile}"));
        out.remove(index);
        out
    }

    /// The 13-tile tenpai hand that keeps `wait` (the other lone tile is out).
    fn tenpai_for(state: &GameState, wait: Tile) -> Vec<Tile> {
        let full = full_tiles(state);
        let other = accepted_tiles(state)
            .into_iter()
            .find(|&tile| tile != wait)
            .expect("a distinct twin discard");
        without_one(&full, other)
    }

    /// The 14-tile winning hand completed on `wait`.
    fn winning_for(state: &GameState, wait: Tile) -> Vec<Tile> {
        let mut winning = tenpai_for(state, wait);
        winning.push(wait);
        winning
    }

    fn chiitoitsu_trigger_holds(state: &GameState, trigger: RiichiTrigger, wait: Tile) -> bool {
        let human = &state.players[0];
        let winning = winning_for(state, wait);
        let counts = to_counts(&winning);

        match trigger {
            RiichiTrigger::Dealer => human.wind == Wind::East,
            RiichiTrigger::Tanyao => {
                counts
                    .iter()
                    .filter(|(_, count)| **count == 2)
                    .all(|(&tile, _)| tile.is_simple())
                    && wait.is_simple()
            }
            RiichiTrigger::RedFiveWait => {
                wait.value() == Some(5)
                    && human.red_fives.iter().any(|tile| tile == &wait.to_string())
            }
            RiichiTrigger::SujiTrap => {
                let suji: Vec<String> = suji_tiles(wait)
                    .iter()
                    .map(|tile| tile.to_string())
                    .collect();
                human
                    .discards
                    .iter()
                    .any(|discard| suji.contains(&discard.tile))
            }
            RiichiTrigger::WaitOutside456 => is_outside_456(wait),
            RiichiTrigger::ScoreBelowMangan => {
                let indicator = parse_tile(&state.dora_indicators[0]);
                let aka = human
                    .red_fives
                    .iter()
                    .filter(|code| winning.iter().any(|tile| tile.to_string() == **code))
                    .count() as u8;
                regular_dora_in_hand(&winning, indicator) + aka <= 1
            }
            // The general ch7.1 triggers belong to the `riichi_judgement`
            // lesson; this seven-pairs generator never emits them.
            RiichiTrigger::HasExtraHan | RiichiTrigger::GoodWait => false,
        }
    }

    #[test]
    fn test_chiitoitsu_riichi_vs_dama_constraints() {
        let mut riichi_count = 0;
        let mut dama_count = 0;

        for run in 0..200 {
            let state = generate("chiitoitsu_riichi_vs_dama")
                .unwrap_or_else(|err| panic!("run {run} failed: {err}"));

            assert_eq!(state.category, "chiitoitsu_riichi_vs_dama");

            let human = &state.players[0];
            assert!(human.is_human);
            assert!(human.melds.is_empty());
            assert!(!human.is_riichi);
            assert_eq!(human.hand.len(), 13);

            let draw = drawn_tile(&state);
            let pre_draw = pre_draw_tiles(&state);
            let full = full_tiles(&state);

            let mut expected: Vec<String> = full.iter().map(|tile| tile.to_string()).collect();
            expected.sort();
            let mut actual = state.tiles.clone();
            actual.sort();
            assert_eq!(actual, expected, "run {run}: displayed tiles must match");

            // The draw completes a pair: the pre-draw hand is five pairs plus
            // three lone tiles and 1-shanten, with one copy of the drawn tile.
            let pre_counts = to_counts(&pre_draw);
            assert_eq!(pre_counts.len(), 8, "run {run}");
            assert_eq!(
                pre_counts.values().filter(|&&count| count == 2).count(),
                5,
                "run {run}"
            );
            assert_eq!(
                pre_counts.values().filter(|&&count| count == 1).count(),
                3,
                "run {run}"
            );
            assert_eq!(pre_counts.get(&draw), Some(&1), "run {run}");
            assert_eq!(calculate_shanten(&pre_counts).shanten, 1, "run {run}");

            let full_counts = to_counts(&full);
            assert_eq!(full_counts.len(), 8, "run {run}");
            assert_eq!(
                full_counts.values().filter(|&&count| count == 2).count(),
                6,
                "run {run}: the draw must complete the sixth pair"
            );
            assert_eq!(
                full_counts.values().filter(|&&count| count == 1).count(),
                2,
                "run {run}: two lone tiles remain"
            );
            assert_eq!(full_counts.get(&draw), Some(&2), "run {run}");

            // The accepted set is exactly the two lone tiles. Dropping either
            // leaves a live seven-pairs tenpai on the other.
            assert_eq!(state.equivalent_tiles.len(), 1, "run {run}");
            let accepted = accepted_tiles(&state);
            assert_ne!(accepted[0], accepted[1], "run {run}");
            for &tile in &accepted {
                assert!(
                    full_counts.contains_key(&tile),
                    "run {run}: {tile} not held"
                );
            }

            for wait in accepted {
                let tenpai = tenpai_for(&state, wait);
                let counts = to_counts(&tenpai);
                assert_eq!(counts.len(), 7, "run {run}");
                assert_eq!(calculate_shanten(&counts).shanten, 0, "run {run}");
                let ukeire = calculate_ukeire(&counts);
                assert_eq!(ukeire.tiles.len(), 1, "run {run}");
                assert_eq!(ukeire.tiles[0].tile, wait, "run {run}");

                assert_eq!(winning_for(&state, wait).len(), 14, "run {run}");

                // Neither wait may be in the human river (furiten).
                for discard_tile in &human.discards {
                    assert_ne!(
                        discard_tile.tile,
                        wait.to_string(),
                        "run {run}: the human river is furiten"
                    );
                }

                for indicator in &state.dora_indicators {
                    assert_ne!(
                        indicator_to_dora(parse_tile(indicator)),
                        wait,
                        "run {run}: a wait is the dora"
                    );
                }
                let ura_indicator = parse_tile(&state.ura_dora_indicators[0]);
                assert_ne!(indicator_to_dora(ura_indicator), wait, "run {run}");
            }

            // No third discard reaches tenpai, so the accepted set is complete.
            for &tile in full_counts.keys() {
                let post_discard = without_one(&full, tile);
                let tenpai = calculate_shanten(&to_counts(&post_discard)).shanten == 0;
                assert_eq!(
                    tenpai,
                    accepted.contains(&tile),
                    "run {run}: discard {tile} tenpai={tenpai}"
                );
            }

            assert_eq!(state.ukeire_tiles.len(), 1);
            assert_eq!(calculate_shanten(&full_counts).shanten, 0);
            assert_eq!(
                state.ukeire_tiles[0],
                skeleton_wait(&state).to_string(),
                "run {run}: ukeire must name the canonical wait"
            );

            match state.correct_action.action_type() {
                CorrectActionType::Riichi => {
                    riichi_count += 1;
                    assert_eq!(state.target_action, TargetAction::Riichi);
                    assert!(
                        !state.riichi_triggers.is_empty(),
                        "run {run}: at least one Riichi trigger must apply"
                    );
                    assert!(state.dama_reasons.is_empty());
                    assert_eq!(state.dora_indicators.len(), 1);

                    for &wait in &accepted {
                        for trigger in &state.riichi_triggers {
                            assert!(
                                chiitoitsu_trigger_holds(&state, *trigger, wait),
                                "run {run}: trigger {trigger:?} does not hold on wait {wait}"
                            );
                        }
                    }

                    let indicator = parse_tile(&state.dora_indicators[0]);
                    let aka = human.red_fives.len().min(1) as u8;
                    for wait in accepted {
                        assert!(scoring::scores_below_mangan(
                            &winning_for(&state, wait),
                            wait,
                            state.round_wind,
                            human.wind,
                            indicator,
                            aka
                        ));
                    }
                }
                CorrectActionType::Dama => {
                    dama_count += 1;
                    assert_eq!(state.target_action, TargetAction::Dama);
                    assert!(state.riichi_triggers.is_empty());
                    assert_eq!(
                        state.dama_reasons,
                        vec![
                            DamaReason::NotDealer,
                            DamaReason::NoTanyao,
                            DamaReason::MiddleWait,
                            DamaReason::NoRedFiveWait,
                            DamaReason::NoSujiTrap,
                            DamaReason::Mangan,
                        ]
                    );
                    assert_eq!(state.dora_indicators.len(), 2);
                    assert_ne!(human.wind, Wind::East);
                    assert!(human.red_fives.is_empty());

                    let has_non_simple_pair = full_counts
                        .iter()
                        .any(|(&tile, &count)| count == 2 && !tile.is_simple());
                    assert!(
                        has_non_simple_pair,
                        "run {run}: dama hand needs a terminal/honor pair"
                    );

                    let indicators: Vec<Tile> = state
                        .dora_indicators
                        .iter()
                        .map(|t| parse_tile(t))
                        .collect();
                    for wait in accepted {
                        assert!(matches!(wait.value(), Some(4..=6)), "run {run}");

                        let suji = suji_tiles(wait);
                        assert!(
                            !human.discards.iter().any(|discard| {
                                suji.iter().any(|suji| suji.to_string() == discard.tile)
                            }),
                            "run {run}: dama river contains a wait suji"
                        );

                        let winning = winning_for(&state, wait);
                        let total_dora: u8 = indicators
                            .iter()
                            .map(|&indicator| regular_dora_in_hand(&winning, indicator))
                            .sum();
                        assert_eq!(total_dora, 4, "run {run}: dama hand must inject four dora");

                        let score_level = scoring::score_level(
                            &winning,
                            wait,
                            state.round_wind,
                            human.wind,
                            &indicators,
                            0,
                        )
                        .expect("dama hand must score as chiitoitsu");
                        assert!(
                            score_level >= ScoreLevel::Mangan,
                            "run {run}: dama hand is {score_level:?}, not Mangan or better"
                        );
                    }
                }
                CorrectActionType::Fold
                | CorrectActionType::Kan
                | CorrectActionType::Discard
                | CorrectActionType::Best => {
                    panic!("run {run}: chiitoitsu scenario returned a non-lesson action")
                }
            }
        }

        assert!(riichi_count > 0, "no Riichi states were generated");
        assert!(dama_count > 0, "no dama states were generated");
    }

    /// The canonical wait is the one the state's ukeire names after the
    /// canonical discard.
    fn skeleton_wait(state: &GameState) -> Tile {
        let full = full_tiles(state);
        let canonical = parse_tile(state.correct_action.tile().expect("chiitoitsu answer tile"));
        let tenpai = without_one(&full, canonical);
        let ukeire = calculate_ukeire(&to_counts(&tenpai));
        assert_eq!(ukeire.tiles.len(), 1);
        ukeire.tiles[0].tile
    }

    #[test]
    fn test_dora_indicator_for_round_trips() {
        for &tile in &ALL_TILES {
            assert_eq!(indicator_to_dora(dama::dora_indicator_for(tile)), tile);
        }
    }

    #[test]
    fn test_chiitoitsu_draw_pairs_a_singleton_100_hands() {
        let started = std::time::Instant::now();

        for run in 0..100 {
            let state = generate("chiitoitsu_riichi_vs_dama")
                .unwrap_or_else(|err| panic!("run {run} failed: {err}"));

            let pre_draw = pre_draw_tiles(&state);
            let draw = drawn_tile(&state);
            let pre_counts = to_counts(&pre_draw);
            assert_eq!(pre_counts.len(), 8, "run {run}");
            assert_eq!(
                pre_counts.values().filter(|&&count| count == 2).count(),
                5,
                "run {run}"
            );
            assert_eq!(
                pre_counts.values().filter(|&&count| count == 1).count(),
                3,
                "run {run}"
            );
            assert_eq!(pre_counts.get(&draw), Some(&1), "run {run}");
            assert_eq!(calculate_shanten(&pre_counts).shanten, 1, "run {run}");

            let mut full = pre_draw;
            full.push(draw);
            let full_counts = to_counts(&full);
            assert_eq!(full_counts.get(&draw), Some(&2), "run {run}");
            assert_eq!(
                full_counts.values().filter(|&&count| count == 2).count(),
                6,
                "run {run}: the draw must complete a pair"
            );
            assert_eq!(
                full_counts.values().filter(|&&count| count == 1).count(),
                2,
                "run {run}"
            );

            let accepted = accepted_tiles(&state);
            assert_ne!(accepted[0], accepted[1], "run {run}");
            assert!(accepted.contains(&skeleton_wait(&state)), "run {run}");
        }

        let elapsed = started.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(5),
            "100 chiitoitsu hands took {elapsed:?}"
        );
    }

    #[test]
    fn test_chiitoitsu_dama_rejection_sampling_100_hands() {
        let started = std::time::Instant::now();

        for run in 0..100 {
            let mut generated = None;
            for _ in 0..50 {
                let Ok(skeleton) = dama::build_skeleton() else {
                    continue;
                };
                if let Ok(state) = board::build("chiitoitsu_riichi_vs_dama", &skeleton) {
                    generated = Some(state);
                    break;
                }
            }
            let state =
                generated.unwrap_or_else(|| panic!("run {run}: dama board failed after retries"));

            assert_eq!(state.target_action, TargetAction::Dama);
            assert_eq!(state.correct_action.action_type(), CorrectActionType::Dama);
            assert!(state.riichi_triggers.is_empty());
            assert_eq!(
                state.dama_reasons,
                vec![
                    DamaReason::NotDealer,
                    DamaReason::NoTanyao,
                    DamaReason::MiddleWait,
                    DamaReason::NoRedFiveWait,
                    DamaReason::NoSujiTrap,
                    DamaReason::Mangan,
                ]
            );

            let human = &state.players[0];
            let accepted = accepted_tiles(&state);
            let full_counts = to_counts(&full_tiles(&state));

            assert_ne!(human.wind, Wind::East);
            assert!(human.red_fives.is_empty());
            for wait in accepted {
                assert!(matches!(wait.value(), Some(4..=6)), "run {run}");

                let suji = suji_tiles(wait);
                assert!(
                    !human
                        .discards
                        .iter()
                        .any(|discard| suji.iter().any(|suji| suji.to_string() == discard.tile)),
                    "run {run}: dama river contains a wait suji"
                );
            }
            assert!(
                full_counts
                    .iter()
                    .any(|(&tile, &count)| count == 2 && !tile.is_simple()),
                "run {run}: dama hand needs a terminal/honor pair"
            );

            let indicators: Vec<Tile> = state
                .dora_indicators
                .iter()
                .map(|t| parse_tile(t))
                .collect();
            assert_eq!(indicators.len(), 2);
            for wait in accepted {
                let winning = winning_for(&state, wait);
                let total_dora: u8 = indicators
                    .iter()
                    .map(|&indicator| regular_dora_in_hand(&winning, indicator))
                    .sum();
                assert_eq!(total_dora, 4, "run {run}");

                let score_level = scoring::score_level(
                    &winning,
                    wait,
                    state.round_wind,
                    human.wind,
                    &indicators,
                    0,
                )
                .expect("dama hand must score as chiitoitsu");
                assert!(score_level >= ScoreLevel::Mangan, "run {run}");
            }
        }

        let elapsed = started.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(5),
            "100 dama rejection-sampled hands took {elapsed:?}"
        );
    }

    #[test]
    fn test_chiitoitsu_each_trigger_can_be_applied() {
        let trigger_sets = [
            triggers::RiichiTriggerSet {
                dealer: true,
                ..Default::default()
            },
            triggers::RiichiTriggerSet {
                tanyao: true,
                ..Default::default()
            },
            triggers::RiichiTriggerSet {
                red_five_wait: true,
                ..Default::default()
            },
            triggers::RiichiTriggerSet {
                suji_trap: true,
                ..Default::default()
            },
            triggers::RiichiTriggerSet {
                wait_outside_456: true,
                ..Default::default()
            },
            triggers::RiichiTriggerSet {
                score_below_mangan: true,
                ..Default::default()
            },
        ];

        for triggers in trigger_sets {
            let mut generated = None;
            for _ in 0..50 {
                let Ok(skeleton) = riichi::build_skeleton(triggers) else {
                    continue;
                };
                if let Ok(state) = board::build("chiitoitsu_riichi_vs_dama", &skeleton) {
                    generated = Some(state);
                    break;
                }
            }

            let state = generated
                .unwrap_or_else(|| panic!("could not generate a board for triggers {triggers:?}"));

            let expected = triggers.to_vec();
            assert_eq!(state.riichi_triggers, expected);
            for trigger in expected {
                for wait in accepted_tiles(&state) {
                    assert!(
                        chiitoitsu_trigger_holds(&state, trigger, wait),
                        "trigger {trigger:?} does not hold on wait {wait}"
                    );
                }
            }
        }
    }
}
