mod board;
mod dama;
mod riichi;
mod scoring;
mod skeleton;
mod triggers;

use crate::generator::support::retry::generate_with_retries;
use crate::rng::gen_bool;
use crate::state::GameState;

/// Generates a seven-pairs tenpai that randomly asks for Riichi or dama.
///
/// The Riichi path applies at least one Riichi heuristic and keeps the wait
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
    use agari::scoring::ScoreLevel;
    use agari::shanten::calculate_shanten;
    use agari::tile::Tile;

    use crate::generator::support::analysis::regular_dora_in_hand;
    use crate::generator::support::deck::ALL_TILES;
    use crate::generator::support::testing::parse_tile;
    use crate::generator::support::tiles::{is_outside_456, suji_tiles};
    use crate::state::{CorrectActionType, DamaReason, RiichiTrigger, TargetAction, Wind};

    fn chiitoitsu_state_tiles(state: &GameState) -> (Vec<Tile>, Tile, Tile) {
        let human = &state.players[0];
        let hand_tiles: Vec<Tile> = human.hand.iter().map(|tile| parse_tile(tile)).collect();
        let wait = parse_tile(&state.ukeire_tiles[0]);
        let discard = parse_tile(
            human
                .draw
                .as_deref()
                .expect("chiitoitsu human must have a draw"),
        );
        let mut winning = hand_tiles;
        winning.push(wait);
        (winning, wait, discard)
    }

    fn chiitoitsu_trigger_holds(state: &GameState, trigger: RiichiTrigger) -> bool {
        let human = &state.players[0];
        let (winning, wait, _) = chiitoitsu_state_tiles(state);
        let counts = agari::parse::to_counts(&winning);

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
                let aka = human.red_fives.len() as u8;
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
            let draw = human
                .draw
                .clone()
                .expect("chiitoitsu human must have a draw");
            assert_eq!(Some(draw.as_str()), state.correct_action.tile());

            let mut expected = human.hand.clone();
            expected.push(draw);
            expected.sort();
            let mut actual = state.tiles.clone();
            actual.sort();
            assert_eq!(actual, expected, "run {run}: displayed tiles must match");

            let (winning, wait, discard) = chiitoitsu_state_tiles(&state);
            assert_eq!(winning.len(), 14);
            assert_ne!(wait, discard);

            let hand_counts = agari::parse::to_counts(
                &human
                    .hand
                    .iter()
                    .map(|tile| parse_tile(tile))
                    .collect::<Vec<_>>(),
            );
            let pair_count = hand_counts.values().filter(|&&count| count == 2).count();
            let singleton_count = hand_counts.values().filter(|&&count| count == 1).count();
            assert_eq!(hand_counts.len(), 7);
            assert_eq!(pair_count, 6);
            assert_eq!(singleton_count, 1);
            assert_eq!(hand_counts.get(&wait), Some(&1));
            assert!(!hand_counts.contains_key(&discard));

            assert_eq!(state.ukeire_tiles.len(), 1);
            assert_eq!(calculate_shanten(&hand_counts).shanten, 0);
            let ukeire = agari::shanten::calculate_ukeire(&hand_counts);
            assert_eq!(ukeire.tiles.len(), 1);
            assert_eq!(ukeire.tiles[0].tile, wait);

            for indicator in &state.dora_indicators {
                assert_ne!(
                    indicator_to_dora(parse_tile(indicator)),
                    wait,
                    "run {run}: the wait must never be the dora"
                );
            }
            let ura_indicator = parse_tile(&state.ura_dora_indicators[0]);
            assert_ne!(indicator_to_dora(ura_indicator), wait);

            for discard_tile in &human.discards {
                assert_ne!(
                    discard_tile.tile,
                    wait.to_string(),
                    "run {run}: the human river is furiten"
                );
            }

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

                    for trigger in &state.riichi_triggers {
                        assert!(
                            chiitoitsu_trigger_holds(&state, *trigger),
                            "run {run}: trigger {trigger:?} does not hold"
                        );
                    }

                    let indicator = parse_tile(&state.dora_indicators[0]);
                    let aka = human.red_fives.len() as u8;
                    assert!(aka <= 1);
                    assert!(scoring::scores_below_mangan(
                        &winning,
                        wait,
                        state.round_wind,
                        human.wind,
                        indicator,
                        aka
                    ));
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
                    assert!(matches!(wait.value(), Some(4..=6)));
                    assert!(human.red_fives.is_empty());
                    assert!(!human.red_fives.iter().any(|tile| tile == &wait.to_string()));

                    let has_non_simple_pair = hand_counts
                        .iter()
                        .any(|(&tile, &count)| count == 2 && !tile.is_simple());
                    assert!(
                        has_non_simple_pair,
                        "run {run}: dama hand needs a terminal/honor pair"
                    );

                    let suji = suji_tiles(wait);
                    assert!(
                        !human.discards.iter().any(|discard| {
                            suji.iter().any(|suji| suji.to_string() == discard.tile)
                        }),
                        "run {run}: dama river contains a wait suji"
                    );

                    let total_dora: u8 = state
                        .dora_indicators
                        .iter()
                        .map(|indicator| regular_dora_in_hand(&winning, parse_tile(indicator)))
                        .sum();
                    assert_eq!(total_dora, 4, "run {run}: dama hand must inject four dora");

                    let indicators: Vec<Tile> = state
                        .dora_indicators
                        .iter()
                        .map(|t| parse_tile(t))
                        .collect();
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

    #[test]
    fn test_dora_indicator_for_round_trips() {
        for &tile in &ALL_TILES {
            assert_eq!(indicator_to_dora(dama::dora_indicator_for(tile)), tile);
        }
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
            let (winning, wait, _) = chiitoitsu_state_tiles(&state);
            let hand_counts = agari::parse::to_counts(
                &human
                    .hand
                    .iter()
                    .map(|tile| parse_tile(tile))
                    .collect::<Vec<_>>(),
            );

            assert_ne!(human.wind, Wind::East);
            assert!(matches!(wait.value(), Some(4..=6)));
            assert!(human.red_fives.is_empty());
            assert!(
                hand_counts
                    .iter()
                    .any(|(&tile, &count)| count == 2 && !tile.is_simple())
            );

            let suji = suji_tiles(wait);
            assert!(
                !human
                    .discards
                    .iter()
                    .any(|discard| suji.iter().any(|suji| suji.to_string() == discard.tile))
            );

            let indicators: Vec<Tile> = state
                .dora_indicators
                .iter()
                .map(|t| parse_tile(t))
                .collect();
            assert_eq!(indicators.len(), 2);
            let total_dora: u8 = indicators
                .iter()
                .map(|&indicator| regular_dora_in_hand(&winning, indicator))
                .sum();
            assert_eq!(total_dora, 4);

            let score_level =
                scoring::score_level(&winning, wait, state.round_wind, human.wind, &indicators, 0)
                    .expect("dama hand must score as chiitoitsu");
            assert!(score_level >= ScoreLevel::Mangan);
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
                assert!(chiitoitsu_trigger_holds(&state, trigger));
            }
        }
    }
}
