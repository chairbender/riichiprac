//! General Riichi-vs-dama: the three-condition rule from Riichi Book 1, ch. 7.
//!
//! The chiitoitsu lesson asks the same question about one hand shape; this
//! lesson asks it about any standard closed tenpai hand. The book's box is
//!
//! > Choose riichi over dama if **at least one** of the following three
//! > conditions is met. 1. Your hand has at least one han other than riichi.
//! > 2. Your hand has a good wait. 3. You are the dealer. — ch7:55-59
//!
//! and the converse is stated in one sentence:
//!
//! > the only type of riichi that these criteria prohibit is a bad-wait
//! > riichi-only hand by a non-dealer. — ch7:71
//!
//! A good wait means "at least two kinds and more than four tiles left to win
//! on" (ch7:491), counted over live tiles.
//!
//! The generator builds the hand for a target set of conditions and then
//! rejects it unless the computed conditions — han at the worst winning tile,
//! live wait quality, seat wind — match that target exactly. Board cases where
//! the later ch. 7 sections prefer dama (a 1-2 tile bad wait, being in the
//! lead, a genbutsu wait, a hand already worth 7700+) are deliberately kept
//! out of the sample.

mod board;
mod judgement;
mod shapes;
mod skeleton;

use crate::generator::support::retry::generate_with_retries;
use crate::state::GameState;

/// Generates a standard closed tenpai hand and asks Riichi or dama.
pub fn generate(category: &str) -> Result<GameState, String> {
    generate_with_retries("riichi_judgement", 20_000, || {
        let target = skeleton::random_target();
        let skeleton = skeleton::build(target)?;
        board::build(category, &skeleton, target)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::collections::HashMap;

    use agari::hand::{HandStructure, decompose_hand};
    use agari::parse::to_counts;
    use agari::scoring::ScoreLevel;
    use agari::shanten::calculate_shanten;
    use agari::tile::Tile;

    use crate::generator::support::analysis::{evaluate_hand, visible_tile_counts};
    use crate::generator::support::testing::parse_tile;
    use crate::state::{CorrectActionType, DamaReason, RiichiTrigger, TargetAction, Wind};

    /// A hand as the player sees it, read back off the generated state.
    struct Puzzle {
        tenpai: Vec<Tile>,
        draw: Tile,
        waits: Vec<Tile>,
        visible: HashMap<Tile, u8>,
        wind: Wind,
        round_wind: Wind,
        dora: Vec<Tile>,
    }

    impl Puzzle {
        fn from_state(state: &GameState) -> Self {
            let human = &state.players[0];
            let tenpai: Vec<Tile> = human.hand.iter().map(|tile| parse_tile(tile)).collect();
            let draw = parse_tile(
                human
                    .draw
                    .as_deref()
                    .expect("riichi-judgement human must have a draw"),
            );
            let waits: Vec<Tile> = state
                .ukeire_tiles
                .iter()
                .map(|tile| parse_tile(tile))
                .collect();
            let dora: Vec<Tile> = state
                .dora_indicators
                .iter()
                .map(|tile| parse_tile(tile))
                .collect();
            let rivers: Vec<Vec<Tile>> = state.players[1..]
                .iter()
                .map(|player| {
                    player
                        .discards
                        .iter()
                        .map(|discard| parse_tile(&discard.tile))
                        .collect()
                })
                .collect();

            Self {
                tenpai,
                draw,
                waits,
                visible: visible_tile_counts(&rivers, &dora),
                wind: human.wind,
                round_wind: state.round_wind,
                dora,
            }
        }

        fn winning_hands(&self) -> Vec<Vec<Tile>> {
            self.waits
                .iter()
                .map(|&wait| {
                    let mut tiles = self.tenpai.clone();
                    tiles.push(wait);
                    tiles
                })
                .collect()
        }

        /// Condition 1: at least one han without riichi at every winning tile.
        fn extra_han(&self) -> u8 {
            judgement::min_han_without_riichi(
                &self.tenpai,
                &self.waits,
                self.round_wind,
                self.wind,
                &self.dora,
            )
        }

        /// Condition 2, counted the way ch7:491 counts it.
        fn good_wait(&self) -> bool {
            judgement::wait_quality(&self.tenpai, &self.visible).is_good()
        }

        /// The full three-condition rule, spelled out for the test.
        fn conditions(&self) -> judgement::Conditions {
            judgement::Conditions {
                extra_han: self.extra_han() >= 1,
                good_wait: self.good_wait(),
                dealer: self.wind == Wind::East,
            }
        }
    }

    fn generate_for(target: judgement::Conditions) -> Result<GameState, String> {
        generate_with_retries("riichi_judgement", 8_000, || {
            let skeleton = skeleton::build(target)?;
            board::build("riichi_judgement", &skeleton, target)
        })
    }

    fn expected_triggers(conditions: judgement::Conditions) -> Vec<RiichiTrigger> {
        let mut triggers = Vec::new();
        if conditions.extra_han {
            triggers.push(RiichiTrigger::HasExtraHan);
        }
        if conditions.good_wait {
            triggers.push(RiichiTrigger::GoodWait);
        }
        if conditions.dealer {
            triggers.push(RiichiTrigger::Dealer);
        }
        triggers
    }

    fn assert_state_is_consistent(state: &GameState) {
        assert_eq!(state.category, "riichi_judgement");
        assert_eq!(state.players.len(), 4);
        assert!(state.tiles_remaining > 0);
        assert_eq!(state.decision, crate::state::DecisionContext::SelfTurn);
        assert!(state.shouminkan_triggers.is_empty());
        assert!(!state.is_agari);
        assert_eq!(state.shanten, 0);

        let human = &state.players[0];
        assert!(human.is_human);
        assert!(human.melds.is_empty());
        assert!(!human.is_riichi);
        assert!(human.red_fives.is_empty());
        assert_eq!(human.hand.len(), 13);
        let draw = human
            .draw
            .as_deref()
            .expect("riichi-judgement human must have a draw");
        assert_eq!(Some(draw), state.correct_action.tile());

        let mut expected = human.hand.clone();
        expected.push(draw.to_string());
        expected.sort();
        let mut actual = state.tiles.clone();
        actual.sort();
        assert_eq!(actual, expected, "displayed tiles must match the hand");

        for opponent in &state.players[1..] {
            assert!(!opponent.is_human);
            assert!(!opponent.is_riichi);
            assert!(opponent.melds.is_empty());
            assert_eq!(opponent.discards.len(), human.discards.len());
        }

        let puzzle = Puzzle::from_state(state);
        assert_eq!(puzzle.tenpai.len(), 13);
        assert_eq!(puzzle.draw, parse_tile(draw));
        assert_eq!(
            calculate_shanten(&to_counts(&puzzle.tenpai)).shanten,
            0,
            "the kept hand must be tenpai"
        );

        let metrics = evaluate_hand(&puzzle.tenpai);
        assert_eq!(
            metrics.ukeire_tiles.len(),
            puzzle.waits.len(),
            "displayed waits must be the hand's real waits"
        );

        // The fourteen tiles plus a wait are a standard hand, never chiitoitsu.
        for winning in puzzle.winning_hands() {
            let structures = decompose_hand(&to_counts(&winning));
            assert!(
                structures
                    .iter()
                    .any(|structure| matches!(structure, HandStructure::Standard { .. })),
                "hand must be a standard hand"
            );
            assert!(
                !structures
                    .iter()
                    .any(|structure| matches!(structure, HandStructure::Chiitoitsu { .. })),
                "hand must not be chiitoitsu"
            );
        }

        // No dora touches the hand, so condition 1 never comes from the luck
        // of the indicator. (The draw is excluded from the winning hand, but a
        // dora on it would still mislead, so nothing in the display is dora.)
        let mut displayed = puzzle.tenpai.clone();
        displayed.push(puzzle.draw);
        for &indicator in &puzzle.dora {
            assert!(
                !displayed.contains(&agari::context::indicator_to_dora(indicator)),
                "the hand holds the dora"
            );
        }

        // Not furiten: no winning tile is already in the human river.
        for wait in &puzzle.waits {
            assert!(
                !human
                    .discards
                    .iter()
                    .any(|discard| discard.tile == wait.to_string()),
                "human river contains furiten tile {wait}"
            );
        }

        // The payload must round-trip, including the new trigger and reason
        // vocabulary the frontend reads.
        let json = serde_json::to_string(state).expect("state must serialize");
        let parsed: GameState = serde_json::from_str(&json).expect("state must parse back");
        assert_eq!(parsed.category, state.category);
        assert_eq!(parsed.riichi_triggers, state.riichi_triggers);
        assert_eq!(parsed.dama_reasons, state.dama_reasons);
    }

    #[test]
    fn test_riichi_judgement_constraints() {
        let started = std::time::Instant::now();
        let mut riichi = 0;
        let mut dama = 0;
        let mut extra_han = 0;
        let mut good_wait = 0;
        let mut dealer = 0;

        for run in 0..300 {
            let state = generate("riichi_judgement")
                .unwrap_or_else(|err| panic!("run {run} failed: {err}"));
            assert_state_is_consistent(&state);

            let puzzle = Puzzle::from_state(&state);
            let conditions = puzzle.conditions();

            assert_eq!(
                state.riichi_triggers,
                expected_triggers(conditions),
                "run {run}: triggers must be the conditions the book rule finds"
            );

            // Riichi Book 1, ch. 7: riichi if at least one condition holds.
            if conditions.picks_riichi() {
                riichi += 1;
                assert_eq!(state.target_action, TargetAction::Riichi, "run {run}");
                assert_eq!(
                    state.correct_action.action_type(),
                    CorrectActionType::Riichi
                );
                assert!(state.dama_reasons.is_empty(), "run {run}");
                assert!(
                    !state.riichi_triggers.is_empty(),
                    "run {run}: a riichi answer needs a cited condition"
                );

                // The high-scoring dama case must not be generated as riichi.
                for winning in puzzle.winning_hands() {
                    let wait = *winning.last().expect("winning tile");
                    assert!(
                        judgement::worst_score_level(
                            &winning,
                            wait,
                            puzzle.round_wind,
                            puzzle.wind,
                            &puzzle.dora,
                        ) < ScoreLevel::Mangan,
                        "run {run}: riichi hand is already mangan without riichi"
                    );
                }
            } else {
                dama += 1;
                assert_eq!(state.target_action, TargetAction::Dama, "run {run}");
                assert_eq!(state.correct_action.action_type(), CorrectActionType::Dama);
                assert!(state.riichi_triggers.is_empty(), "run {run}");
                assert_eq!(
                    state.dama_reasons,
                    vec![
                        DamaReason::NotDealer,
                        DamaReason::BadWait,
                        DamaReason::NoExtraHan,
                    ],
                    "run {run}"
                );

                // The only prohibited riichi: bad wait, riichi-only, non-dealer.
                assert_ne!(puzzle.wind, Wind::East, "run {run}");
                assert!(!puzzle.good_wait(), "run {run}");
                assert_eq!(puzzle.extra_han(), 0, "run {run}");
                assert!(
                    judgement::wait_quality(&puzzle.tenpai, &puzzle.visible).live_tiles >= 3,
                    "run {run}: the 1-2 tile bad wait is a different lesson"
                );
            }

            extra_han += usize::from(conditions.extra_han);
            good_wait += usize::from(conditions.good_wait);
            dealer += usize::from(conditions.dealer);
        }

        assert!(riichi > 0, "no Riichi states were generated");
        assert!(dama > 0, "no dama states were generated");
        assert!(extra_han > 0, "condition 1 was never exercised");
        assert!(good_wait > 0, "condition 2 was never exercised");
        assert!(dealer > 0, "condition 3 was never exercised");

        let elapsed = started.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(10),
            "300 riichi-judgement generations took {elapsed:?}"
        );
    }

    #[test]
    fn test_riichi_judgement_each_condition_combination_can_be_applied() {
        let targets = judgement::Conditions::RIICHI_SETS
            .into_iter()
            .chain(std::iter::once(judgement::Conditions::default()));

        for target in targets {
            let mut generated = None;
            for _ in 0..8 {
                if let Ok(state) = generate_for(target) {
                    generated = Some(state);
                    break;
                }
            }
            let state =
                generated.unwrap_or_else(|| panic!("could not generate a board for {target:?}"));

            assert_state_is_consistent(&state);
            let puzzle = Puzzle::from_state(&state);
            assert_eq!(puzzle.conditions(), target, "{target:?}");
            assert_eq!(state.riichi_triggers, expected_triggers(target));
            assert_eq!(
                state.target_action,
                if target.picks_riichi() {
                    TargetAction::Riichi
                } else {
                    TargetAction::Dama
                }
            );
        }
    }

    /// A good wait has two kinds; a bad wait has one. The state's `ukeire_tiles`
    /// must show exactly that, because the UI displays it as the wait.
    #[test]
    fn test_riichi_judgement_wait_shape_matches_the_condition() {
        let mut good = 0;
        let mut bad = 0;

        for _ in 0..120 {
            let state = generate("riichi_judgement").expect("hand must generate");
            let puzzle = Puzzle::from_state(&state);
            let quality = judgement::wait_quality(&puzzle.tenpai, &puzzle.visible);

            if puzzle.good_wait() {
                good += 1;
                assert_eq!(quality.live_kinds, 2);
                assert!(quality.live_tiles >= 5);
                assert_eq!(state.ukeire_tiles.len(), 2);
            } else {
                bad += 1;
                assert!(quality.live_kinds <= 1 || quality.live_tiles <= 4);
                assert_eq!(state.ukeire_tiles.len(), 1);
            }
        }

        assert!(good > 0, "no good waits were generated");
        assert!(bad > 0, "no bad waits were generated");
    }
}
