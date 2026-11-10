mod board;
mod skeleton;
mod triggers;

use crate::generator::support::retry::generate_with_retries;
use crate::state::GameState;

/// Generates a hand where the player has drawn the fourth tile of an open
/// Pon and must decide whether to upgrade it to an Added Kan.
pub fn generate(category: &str) -> Result<GameState, String> {
    generate_with_retries("shouminkan", 20_000, || {
        let triggers = triggers::random();
        let skeleton = skeleton::build(triggers)?;
        board::build(category, &skeleton, triggers)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    use agari::context::{GameContext, WinType, indicator_to_dora};
    use agari::hand::{Meld, decompose_hand_with_melds};
    use agari::parse::to_counts;
    use agari::tile::Tile;
    use agari::yaku::detect_yaku_with_context;

    use crate::generator::support::analysis::wind_to_honor;
    use crate::generator::support::testing::parse_tile;
    use crate::state::{CorrectActionType, MeldType, ShouminkanTrigger, TargetAction, Wind};

    fn human_rank(state: &GameState) -> usize {
        let human_score = state.players[0].score;
        1 + state
            .players
            .iter()
            .filter(|player| player.score > human_score)
            .count()
    }

    fn shouminkan_min_wait_han(state: &GameState, wait: Tile) -> u8 {
        let human = &state.players[0];
        let open_tile = parse_tile(&human.melds[0].tiles[0]);
        let open_meld = Meld::koutsu_open(open_tile);

        let mut concealed_with_win: Vec<Tile> =
            human.hand.iter().map(|tile| parse_tile(tile)).collect();
        concealed_with_win.push(wait);
        let concealed_counts = to_counts(&concealed_with_win);
        let structures = decompose_hand_with_melds(&concealed_counts, &[open_meld]);

        let mut full_with_win = concealed_with_win;
        full_with_win.extend([open_tile; 3]);
        let full_counts = to_counts(&full_with_win);
        let context = GameContext::new(
            WinType::Ron,
            wind_to_honor(state.round_wind),
            wind_to_honor(human.wind),
        )
        .with_winning_tile(wait)
        .open();

        structures
            .iter()
            .map(|structure| detect_yaku_with_context(structure, &full_counts, &context).total_han)
            .min()
            .unwrap_or(0)
    }

    fn shouminkan_trigger_holds(state: &GameState, trigger: ShouminkanTrigger) -> bool {
        let human = &state.players[0];

        match trigger {
            ShouminkanTrigger::GoodWaitAndValue => {
                if state.shanten != 0 || !matches!(state.ukeire_tiles.len(), 2 | 3) {
                    return false;
                }
                state
                    .ukeire_tiles
                    .iter()
                    .all(|tile| shouminkan_min_wait_han(state, parse_tile(tile)) >= 2)
            }
            ShouminkanTrigger::LateGame => {
                state.tiles_remaining < 20
                    && state
                        .players
                        .iter()
                        .all(|player| player.discards.len() >= 13)
            }
            ShouminkanTrigger::PlacementDesperation => {
                if state.round_wind != Wind::South || state.hand_number != 4 {
                    return false;
                }
                let human_score = human.score;
                let Some(above) = state
                    .players
                    .iter()
                    .filter(|player| player.score > human_score)
                    .map(|player| player.score)
                    .min()
                else {
                    return false;
                };
                matches!(human_rank(state), 2 | 3) && above - human_score < 2_000
            }
            ShouminkanTrigger::LosingBadly => {
                let human_score = human.score;
                let mut scores: Vec<i32> =
                    state.players.iter().map(|player| player.score).collect();
                scores.sort_by(|a, b| b.cmp(a));
                human_rank(state) == 4 && scores[2] - human_score > 12_000
            }
        }
    }

    fn assert_shouminkan_constraints(state: &GameState) {
        assert_eq!(state.category, "shouminkan_decision");
        assert_eq!(state.target_action, TargetAction::Kan);
        assert_eq!(state.correct_action.action_type(), CorrectActionType::Kan);
        assert_eq!(state.tiles.len(), 14);
        assert_eq!(state.players.len(), 4);
        assert_eq!(state.shanten, 0);
        assert!(matches!(state.ukeire_tiles.len(), 2 | 3));
        assert!(!state.shouminkan_triggers.is_empty());
        assert!(state.riichi_triggers.is_empty());
        assert!(state.dama_reasons.is_empty());
        assert_eq!(state.dora_indicators.len(), 1);
        assert_eq!(state.ura_dora_indicators.len(), 1);
        assert!(state.tiles_remaining > 0);

        let human = &state.players[0];
        assert!(human.is_human);
        assert!(!human.is_riichi);
        assert_eq!(human.hand.len(), 10);
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

        let draw = human
            .draw
            .as_deref()
            .expect("shouminkan human must have a draw");
        assert_eq!(draw, human.melds[0].tiles[0]);
        assert_eq!(draw, state.correct_action.tile());
        assert!(
            !human.hand.iter().any(|tile| tile == draw),
            "the only fourth copy must be the active draw"
        );

        let mut expected = human.hand.clone();
        expected.push(draw.to_string());
        expected.extend(human.melds[0].tiles.iter().cloned());
        expected.sort();
        let mut actual = state.tiles.clone();
        actual.sort();
        assert_eq!(actual, expected, "displayed tiles must match the hand");

        // The open Pon is the only meld at the table.
        for opponent in &state.players[1..] {
            assert!(opponent.melds.is_empty());
            assert!(!opponent.is_riichi);
        }

        // The human is not furiten on any winning tile.
        for wait in &state.ukeire_tiles {
            assert!(
                !human.discards.iter().any(|discard| &discard.tile == wait),
                "human river contains furiten tile {wait}"
            );
        }

        // The Pon tile is never the visible dora, so the Kan decision does not
        // lean on an accidental dora.
        let indicator = parse_tile(&state.dora_indicators[0]);
        assert_ne!(indicator_to_dora(indicator).to_string(), draw);
        let ura_indicator = parse_tile(&state.ura_dora_indicators[0]);
        assert_ne!(indicator_to_dora(ura_indicator).to_string(), draw);

        let total_score: i32 = state.players.iter().map(|player| player.score).sum();
        assert_eq!(total_score, 100_000);

        for trigger in &state.shouminkan_triggers {
            assert!(
                shouminkan_trigger_holds(state, *trigger),
                "trigger {trigger:?} does not hold"
            );
        }
    }

    #[test]
    fn test_shouminkan_decision_constraints() {
        let started = std::time::Instant::now();
        let mut counts = [0usize; 4];

        for run in 0..200 {
            let state = generate("shouminkan_decision")
                .unwrap_or_else(|err| panic!("run {run} failed: {err}"));
            assert_shouminkan_constraints(&state);

            for trigger in &state.shouminkan_triggers {
                let index = match trigger {
                    ShouminkanTrigger::GoodWaitAndValue => 0,
                    ShouminkanTrigger::LateGame => 1,
                    ShouminkanTrigger::PlacementDesperation => 2,
                    ShouminkanTrigger::LosingBadly => 3,
                };
                counts[index] += 1;
            }
        }

        assert!(
            counts.iter().all(|&count| count > 0),
            "trigger coverage: {counts:?}"
        );
        let elapsed = started.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(10),
            "200 shouminkan generations took {elapsed:?}"
        );
    }

    #[test]
    fn test_shouminkan_each_trigger_can_be_applied() {
        let trigger_sets = [
            triggers::ShouminkanTriggerSet {
                good_wait_and_value: true,
                ..Default::default()
            },
            triggers::ShouminkanTriggerSet {
                late_game: true,
                ..Default::default()
            },
            triggers::ShouminkanTriggerSet {
                placement_desperation: true,
                ..Default::default()
            },
            triggers::ShouminkanTriggerSet {
                losing_badly: true,
                ..Default::default()
            },
            triggers::ShouminkanTriggerSet {
                good_wait_and_value: true,
                late_game: true,
                ..Default::default()
            },
        ];

        for triggers in trigger_sets {
            let mut generated = None;
            for _ in 0..50 {
                let Ok(skeleton) = skeleton::build(triggers) else {
                    continue;
                };
                if let Ok(state) = board::build("shouminkan_decision", &skeleton, triggers) {
                    generated = Some(state);
                    break;
                }
            }

            let state = generated
                .unwrap_or_else(|| panic!("could not generate a board for triggers {triggers:?}"));
            assert_eq!(state.shouminkan_triggers, triggers.to_vec());
            for trigger in triggers.to_vec() {
                assert!(shouminkan_trigger_holds(&state, trigger));
            }
        }
    }

    #[test]
    fn test_shouminkan_skeleton_generalizes() {
        for _ in 0..100 {
            let skeleton = skeleton::build(triggers::ShouminkanTriggerSet {
                good_wait_and_value: true,
                ..Default::default()
            })
            .expect("shouminkan skeleton must build");

            assert_eq!(skeleton.full_tiles().len(), 14);
            assert_eq!(skeleton.concealed_tiles.len(), 10);
            assert_eq!(skeleton.open_pon_tiles.len(), 3);
            assert_eq!(skeleton.open_pon_tiles[0], skeleton.drawn_tile);
            assert_eq!(skeleton.open_pon_tiles[1], skeleton.drawn_tile);
            assert_eq!(skeleton.open_pon_tiles[2], skeleton.drawn_tile);
            assert!(agari::parse::validate_hand(&skeleton.full_tiles()).is_ok());

            let mut post_discard = skeleton.concealed_tiles.clone();
            post_discard.extend(skeleton.open_pon_tiles.iter().copied());
            let counts = to_counts(&post_discard);
            assert_eq!(agari::shanten::calculate_shanten(&counts).shanten, 0);
            let ukeire = agari::shanten::calculate_ukeire(&counts);
            let wait_tiles: Vec<Tile> = ukeire.tiles.iter().map(|u| u.tile).collect();
            assert_eq!(wait_tiles.len(), skeleton.wait_tiles.len());
            assert!(
                skeleton
                    .wait_tiles
                    .iter()
                    .all(|wait| wait_tiles.contains(wait))
            );

            for wait in &skeleton.wait_tiles {
                assert!(
                    skeleton::waits_have_value(
                        &skeleton.concealed_tiles,
                        skeleton.drawn_tile,
                        &[*wait],
                        2,
                    ),
                    "wait {wait} must score at least two han"
                );
            }
        }
    }

    #[test]
    fn test_shouminkan_non_good_hands_can_be_light() {
        let mut light_hands = 0;

        for _ in 0..50 {
            let skeleton = skeleton::build(triggers::ShouminkanTriggerSet::default())
                .expect("non-good shouminkan skeleton must build");
            let han = skeleton::min_wait_han(
                &skeleton.concealed_tiles,
                skeleton.drawn_tile,
                &skeleton.wait_tiles,
            );
            assert!(han >= 1, "the open dragon Pon must always provide a yaku");
            if han < 2 {
                light_hands += 1;
            }
        }

        assert!(
            light_hands > 0,
            "non-good hands must not always guarantee two han"
        );
    }
}
