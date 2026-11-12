//! Riichi vs. dama on an expensive hand: Riichi Book 1, ch. 7, "High scoring
//! hand".
//!
//! The section's rule:
//!
//! > When your hand is already expensive without riichi (minimum of 7700 if
//! > playing with red fives; 5200 if playing without red fives), it is OK to
//! > go dama. — ch7:569
//!
//! and its closing box:
//!
//! > Don't riichi if the minimum hand value is haneman or better. — ch7:646
//!
//! This lesson hands the player a closed, tenpai hand whose *worst* winning
//! tile already scores 7700 by ron without Riichi. The answer is always dama:
//! at 7700 the book calls the declaration acceptable, and at haneman or better
//! it tells the player not to declare at all.
//!
//! The two "riichi anyway" cells of the box are held off on purpose — the human
//! is in front, and the table is past the 6th turn — so the hand's value is the
//! only thing deciding. Both branches are graded from a fresh score
//! enumeration over every winning tile (ch7:598), never from the constructor.

mod board;
mod judgement;
mod scoring;
mod skeleton;

use crate::generator::support::retry::generate_with_retries;
use crate::state::GameState;

pub(crate) use skeleton::Target;

/// Generates a closed, expensive tenpai hand and asks Riichi or dama.
pub fn generate(category: &str) -> Result<GameState, String> {
    generate_with_target(category, sample_target())
}

/// Draws the value band the next request will teach, before any tile exists.
///
/// The two bands are equally likely, because they are the section's two
/// distinct cells: "7700 is acceptable" and "haneman means no riichi".
pub(crate) fn sample_target() -> Target {
    skeleton::random_target()
}

/// Builds a hand and table under an already-drawn value band.
pub(crate) fn generate_with_target(category: &str, target: Target) -> Result<GameState, String> {
    generate_with_retries("dama_expensive_hand", 20_000, || {
        let built = skeleton::build(target)?;
        board::build(category, &built, target)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    use agari::context::indicator_to_dora;
    use agari::hand::{HandStructure, decompose_hand};
    use agari::parse::to_counts;
    use agari::shanten::calculate_shanten;
    use agari::tile::Tile;

    use crate::generator::support::analysis::{regular_dora_in_hand, visible_tile_counts};
    use crate::generator::support::testing::parse_tile;
    use crate::state::{
        CorrectActionType, DamaReason, DecisionContext, RiichiTrigger, TargetAction, Wind,
    };

    /// A hand as the player sees it, read back off the generated state.
    struct Puzzle {
        tenpai: Vec<Tile>,
        draw: Tile,
        discard: Tile,
        waits: Vec<Tile>,
        dora: Vec<Tile>,
        wind: Wind,
        round_wind: Wind,
        red_fives: Vec<Tile>,
    }

    impl Puzzle {
        fn from_state(state: &GameState) -> Self {
            let human = &state.players[0];
            let discard = parse_tile(
                state
                    .correct_action
                    .tile()
                    .expect("the expensive-hand answer names a discard"),
            );
            let mut tenpai: Vec<Tile> = state.tiles.iter().map(|tile| parse_tile(tile)).collect();
            let index = tenpai
                .iter()
                .position(|tile| *tile == discard)
                .expect("the answer must be in the displayed hand");
            tenpai.remove(index);
            let draw = parse_tile(
                human
                    .draw
                    .as_deref()
                    .expect("the expensive-hand human has a draw"),
            );
            let waits = state
                .ukeire_tiles
                .iter()
                .map(|tile| parse_tile(tile))
                .collect();
            let dora = state
                .dora_indicators
                .iter()
                .map(|tile| parse_tile(tile))
                .collect();
            let red_fives = human
                .red_fives
                .iter()
                .map(|tile| parse_tile(tile))
                .collect();

            Self {
                tenpai,
                draw,
                discard,
                waits,
                dora,
                wind: human.wind,
                round_wind: state.round_wind,
                red_fives,
            }
        }

        fn worst(&self) -> scoring::Value {
            scoring::worst_value(
                &self.tenpai,
                &self.waits,
                self.round_wind,
                self.wind,
                &self.dora,
                self.red_fives.len() as u8,
            )
            .expect("both winning tiles have a yaku")
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
    }

    fn generate_for(target: skeleton::Target) -> Result<GameState, String> {
        generate_with_retries("dama_expensive_hand", 8_000, || {
            let built = skeleton::build(target)?;
            board::build("dama_expensive_hand", &built, target)
        })
    }

    fn assert_state_is_consistent(state: &GameState) {
        assert_eq!(state.category, "dama_expensive_hand");
        assert_eq!(state.players.len(), 4);
        assert!(state.tiles_remaining > 0);
        assert_eq!(state.decision, DecisionContext::SelfTurn);
        assert!(state.shouminkan_triggers.is_empty());
        assert!(!state.is_agari);
        assert_eq!(state.shanten, 0);

        let human = &state.players[0];
        assert!(human.is_human);
        assert!(human.melds.is_empty());
        assert!(!human.is_riichi);
        assert_eq!(human.hand.len(), 13);
        // The human is never the dealer: the 7700/haneman numbers are a
        // non-dealer's ron values.
        assert_ne!(human.wind, Wind::East);
        assert!(
            human.discards.len() >= 6,
            "the table must be past the 6th turn"
        );
        // Not far behind: the human starts the hand in front.
        assert!(
            state.players[1..]
                .iter()
                .all(|opponent| opponent.score <= human.score),
            "the human must not be far behind"
        );

        let draw = human
            .draw
            .as_deref()
            .expect("the expensive-hand human must have a draw");
        let answer = state
            .correct_action
            .tile()
            .expect("the expensive-hand answer must name a discard");
        assert_ne!(answer, draw, "the answer must never be tsumogiri");
        assert!(
            human.hand.iter().any(|tile| tile == answer),
            "the answer {answer} must be a hand tile (tedashi)"
        );

        // The draw is what reaches tenpai: the pre-draw hand is 1-shanten.
        let pre_draw: Vec<Tile> = human.hand.iter().map(|tile| parse_tile(tile)).collect();
        assert_eq!(
            calculate_shanten(&to_counts(&pre_draw)).shanten,
            1,
            "the pre-draw hand must be 1-shanten"
        );

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
        }

        crate::generator::support::state_validation::validate_reachable_state(state)
            .expect("the expensive-hand table must be reachable");

        let puzzle = Puzzle::from_state(state);
        assert_eq!(puzzle.tenpai.len(), 13);
        assert_eq!(puzzle.draw, parse_tile(draw));
        assert_eq!(puzzle.discard, parse_tile(answer));
        assert_eq!(puzzle.waits.len(), 2, "the wait is a two-sided side wait");
        assert_eq!(state.ukeire_tiles.len(), puzzle.waits.len());
        assert_eq!(
            calculate_shanten(&to_counts(&puzzle.tenpai)).shanten,
            0,
            "the kept hand must be tenpai"
        );

        // The draw is part of the kept tenpai hand, and the discarded tile is
        // not: this is the flip that makes the answer tedashi.
        assert!(
            puzzle.tenpai.contains(&puzzle.draw),
            "the draw must stay in the tenpai hand"
        );
        assert!(
            puzzle.tenpai.iter().all(|tile| tile.to_string() != answer),
            "the answer must come out of the hand"
        );

        // No other discard reaches tenpai, so the lesson asks the declaration
        // question rather than "which tile do I throw".
        let mut full = puzzle.tenpai.clone();
        full.push(parse_tile(answer));
        let mut codes = full.clone();
        codes.sort();
        codes.dedup();
        let mut tenpai_discards = Vec::new();
        for code in codes {
            let mut rest = full.clone();
            let index = rest
                .iter()
                .position(|tile| *tile == code)
                .expect("tile came from the display");
            rest.remove(index);
            if calculate_shanten(&to_counts(&rest)).shanten == 0 {
                tenpai_discards.push(code);
            }
        }
        assert_eq!(tenpai_discards, vec![parse_tile(answer)]);

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

        // Standard hands only, never chiitoitsu.
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

        // The dora pair: one indicator makes exactly two hand tiles dora, and
        // no winning tile is dora.
        assert_eq!(state.dora_indicators.len(), 1);
        let indicator = parse_tile(&state.dora_indicators[0]);
        let dora_tile = indicator_to_dora(indicator);
        for winning in puzzle.winning_hands() {
            assert_eq!(regular_dora_in_hand(&winning, indicator), 2);
            assert!(!puzzle.waits.contains(&dora_tile));
        }
        // The ura indicator is hidden at decision time and must never be shown
        // as the dora indicator.
        assert_eq!(state.ura_dora_indicators.len(), 1);

        // The value band, recomputed at the worst winning tile.
        let worst = puzzle.worst();
        assert!(
            worst.points >= judgement::EXPENSIVE_MIN_POINTS,
            "worst value {} must clear 7700",
            worst.points
        );
        match state.dama_reasons.as_slice() {
            [DamaReason::Mangan] => {
                assert!(
                    worst.points < judgement::HANEMAN_MIN_POINTS,
                    "the 7700 branch must stay below haneman"
                );
            }
            [DamaReason::HanemanPlus] => {
                assert!(worst.points >= judgement::HANEMAN_MIN_POINTS);
            }
            other => panic!("unexpected dama reasons {other:?}"),
        }

        // The answer is dama, with no riichi justification attached.
        assert_eq!(state.target_action, TargetAction::Dama);
        assert_eq!(state.correct_action.action_type(), CorrectActionType::Dama);
        assert!(state.riichi_triggers.is_empty());
        assert!(!state.dama_reasons.is_empty());
        assert!(!state.can_riichi || state.shanten == 0);

        // The payload must round-trip.
        let json = serde_json::to_string(state).expect("state must serialize");
        let parsed: GameState = serde_json::from_str(&json).expect("state must parse back");
        assert_eq!(parsed.category, state.category);
        assert_eq!(parsed.riichi_triggers, state.riichi_triggers);
        assert_eq!(parsed.dama_reasons, state.dama_reasons);
    }

    #[test]
    fn test_dama_expensive_hand_follows_the_score_thresholds() {
        let started = std::time::Instant::now();
        let mut mangan = 0;
        let mut haneman = 0;

        for run in 0..300 {
            let state = generate("dama_expensive_hand")
                .unwrap_or_else(|err| panic!("run {run} failed: {err}"));
            assert_state_is_consistent(&state);

            let puzzle = Puzzle::from_state(&state);
            let worst = puzzle.worst();
            let verdict = judgement::verdict(worst.points).expect("value must be expensive");
            assert_eq!(verdict, verdict_from_reasons(&state.dama_reasons));

            match verdict {
                judgement::Verdict::DamaExpensive => mangan += 1,
                judgement::Verdict::DamaHaneman => haneman += 1,
            }
        }

        assert!(mangan > 0, "no 7700-11999 hands were generated");
        assert!(haneman > 0, "no haneman+ hands were generated");

        let elapsed = started.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(20),
            "300 expensive-hand generations took {elapsed:?}"
        );
    }

    fn verdict_from_reasons(reasons: &[DamaReason]) -> judgement::Verdict {
        match reasons {
            [DamaReason::Mangan] => judgement::Verdict::DamaExpensive,
            [DamaReason::HanemanPlus] => judgement::Verdict::DamaHaneman,
            other => panic!("unexpected dama reasons {other:?}"),
        }
    }

    #[test]
    fn test_dama_expensive_hand_each_branch_can_be_applied() {
        for target in [skeleton::Target::Dama7700, skeleton::Target::DamaHaneman] {
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
            let worst = puzzle.worst();
            assert_eq!(
                judgement::verdict(worst.points),
                Some(target.expected_verdict()),
                "{target:?}"
            );
        }
    }

    #[test]
    fn test_dama_expensive_hand_never_declares() {
        for _ in 0..100 {
            let state = generate("dama_expensive_hand").expect("hand must generate");
            assert_eq!(state.target_action, TargetAction::Dama);
            assert!(state.riichi_triggers.is_empty());
            assert!(
                state.dama_reasons.contains(&DamaReason::Mangan)
                    || state.dama_reasons.contains(&DamaReason::HanemanPlus)
            );
        }
    }

    #[test]
    fn test_dama_expensive_hand_attaches_the_book_rationale() {
        let state = crate::generator::finalize_state(
            generate("dama_expensive_hand").expect("hand must generate"),
        );
        let rationale = state.book_rationale.expect("book rationale must attach");
        assert_eq!(rationale.source.chapter, 7);
        assert!(!rationale.rules.is_empty());
        assert!(
            rationale
                .rules
                .iter()
                .all(|rule| !rule.quote.is_empty() && !rule.applies.is_empty())
        );
        assert!(
            rationale
                .caveats
                .iter()
                .any(|caveat| caveat.contains("worst winning tile"))
        );
    }

    #[test]
    fn test_dama_expensive_hand_wait_is_visible_and_live() {
        for _ in 0..60 {
            let state = generate("dama_expensive_hand").expect("hand must generate");
            let puzzle = Puzzle::from_state(&state);
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
            let visible = visible_tile_counts(&rivers, &puzzle.dora);
            let quality = crate::generator::riichi_judgement::judgement::wait_quality(
                &puzzle.tenpai,
                &visible,
            );
            assert_eq!(quality.live_kinds, 2);
            assert!(quality.live_tiles >= 1);
        }
    }

    #[test]
    fn test_riichi_triggers_stay_empty() {
        // Guard the vocabulary: this lesson never emits a Riichi justification.
        for _ in 0..30 {
            let state = generate("dama_expensive_hand").expect("hand must generate");
            for trigger in [
                RiichiTrigger::Dealer,
                RiichiTrigger::HasExtraHan,
                RiichiTrigger::GoodWait,
                RiichiTrigger::ThreeLiveWinningTiles,
                RiichiTrigger::HonorTerminalWait,
                RiichiTrigger::Tanyao,
                RiichiTrigger::RedFiveWait,
                RiichiTrigger::SujiTrap,
                RiichiTrigger::WaitOutside456,
                RiichiTrigger::ScoreBelowMangan,
            ] {
                assert!(!state.riichi_triggers.contains(&trigger));
            }
        }
    }
}
