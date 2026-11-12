//! Riichi vs. dama on a hand with many improving tiles: Riichi Book 1, ch. 7,
//! "Many possibilities of improving the hand".
//!
//! The section's box:
//!
//! > It makes sense to wait in dama only when **both** of the following two
//! > conditions are met. 1. It is still an early turn (8th turn or before);
//! > 2. There are at least six kinds of tiles that can improve the scores
//! > and/or the wait, or there is at least one kind of tiles that can improve
//! > the score by at least three han in one step. — ch7:656-660
//!
//! and its worked example is a ready tanki whose improving kinds the book
//! counts out loud — fourteen of them (ch7:723). This lesson builds that shape
//! rather than paraphrasing it: four complete runs plus two isolated singles,
//! one dora in a run, and an early-turn river for every seat.
//!
//! The books's reasoning for the case is explicit about why it is a *choice*
//! rather than the general rule:
//!
//! > According to the riichi criteria given at the beginning of this chapter,
//! > you could call riichi with this hand. ... However, if it is the 6th turn
//! > or before, waiting in dama ... is an option. — ch7:716-720
//!
//! So the hand always has a han (its dora), the wait is a tanki, the human is
//! not the dealer, and it is never past the 8th turn. The general ch7:55-59
//! rule therefore picks Riichi on the han, and the improving box is the only
//! thing that keeps the answer dama.
//!
//! The two singles are interchangeable: discarding either one leaves a tanki
//! wait, so both are graded as the same answer (the `equivalent_tiles` twin
//! model the chiitoitsu lesson already uses). The improving count is verified
//! for both kept hands, so neither discard hides a worse hand.
//!
//! The count itself lives in [`improvement`] and is anchored on the book's own
//! fourteen-kind example; the skeleton and board only accept hands whose
//! computed count clears the box.

mod board;
mod improvement;
mod skeleton;

use crate::generator::support::retry::generate_with_retries;
use crate::state::GameState;

/// Generates a ready hand with many improving tiles and asks Riichi or dama.
pub fn generate(category: &str) -> Result<GameState, String> {
    generate_with_retries("dama_improving_hand", 20_000, || {
        let built = skeleton::build()?;
        board::build(category, &built)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::collections::HashMap;

    use agari::context::indicator_to_dora;
    use agari::parse::to_counts;
    use agari::shanten::calculate_shanten;
    use agari::tile::Tile;

    use crate::generator::riichi_judgement::judgement as riichi;
    use crate::generator::support::analysis::{evaluate_hand, visible_tile_counts};
    use crate::generator::support::testing::parse_tile;
    use crate::state::{CorrectActionType, DamaReason, DecisionContext, TargetAction, Wind};

    /// A hand as the player sees it, read back off the generated state.
    struct Puzzle {
        kept: Vec<Tile>,
        twin: Vec<Tile>,
        waits: Vec<Tile>,
        answer: Tile,
        equivalent: Tile,
        dora: Vec<Tile>,
        wind: Wind,
        round_wind: Wind,
        visible: HashMap<Tile, u8>,
        improvement: improvement::Improvement,
        twin_improvement: improvement::Improvement,
    }

    impl Puzzle {
        fn from_state(state: &GameState) -> Self {
            let human = &state.players[0];
            let answer = parse_tile(
                state
                    .correct_action
                    .tile()
                    .expect("the improving-hand answer names a discard"),
            );
            let equivalent = state
                .equivalent_tiles
                .first()
                .map(|code| parse_tile(code))
                .expect("the twin single is graded too");
            let mut display: Vec<Tile> = state.tiles.iter().map(|tile| parse_tile(tile)).collect();
            let mut kept = display.clone();
            kept.remove(
                kept.iter()
                    .position(|tile| *tile == answer)
                    .expect("the answer is in the display"),
            );
            let mut twin = display.clone();
            twin.remove(
                twin.iter()
                    .position(|tile| *tile == equivalent)
                    .expect("the equivalent is in the display"),
            );
            display.sort();

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

            let visible = visible_tile_counts(&rivers, &dora);
            // The count is the expensive part of the lesson: compute the two
            // hands once and let every assertion reuse them.
            let improvement = improvement::count(&kept, state.round_wind, human.wind, &dora);
            let twin_improvement = improvement::count(&twin, state.round_wind, human.wind, &dora);

            Self {
                kept,
                twin,
                waits: state
                    .ukeire_tiles
                    .iter()
                    .map(|tile| parse_tile(tile))
                    .collect(),
                answer,
                equivalent,
                visible,
                dora,
                wind: human.wind,
                round_wind: state.round_wind,
                improvement,
                twin_improvement,
            }
        }

        fn conditions(&self) -> riichi::Conditions {
            riichi::evaluate(
                &self.kept,
                &self.waits,
                self.round_wind,
                self.wind,
                &self.dora,
                &self.visible,
            )
        }
    }

    fn assert_state_is_consistent(state: &GameState) -> Puzzle {
        assert_eq!(state.category, "dama_improving_hand");
        assert_eq!(state.players.len(), 4);
        assert!(state.tiles_remaining > 0);
        assert_eq!(state.decision, DecisionContext::SelfTurn);
        assert!(state.shouminkan_triggers.is_empty());
        assert!(!state.is_agari);
        assert_eq!(state.shanten, 0);
        assert_eq!(state.target_action, TargetAction::Dama);
        assert_eq!(state.correct_action.action_type(), CorrectActionType::Dama);
        assert_eq!(
            state.dama_reasons,
            vec![DamaReason::EarlyTurn, DamaReason::ImprovingHand]
        );
        assert!(state.riichi_triggers.is_empty());

        let human = &state.players[0];
        assert!(human.is_human);
        assert!(human.melds.is_empty());
        assert!(!human.is_riichi);
        assert!(human.red_fives.is_empty());
        assert_eq!(human.hand.len(), 13);
        assert!(human.draw.is_some());

        // The early-turn half of the box: at most seven discards, so this is
        // the 8th turn at the latest (ch7:658).
        assert!(
            human.discards.len() <= board::EARLY_TURN_MAX_DISCARDS,
            "the human is at discard {}, past the 8th turn",
            human.discards.len()
        );
        // The human is never the dealer: ch7:59's dealer condition must not be
        // the reason the general rule picks riichi.
        assert_ne!(human.wind, Wind::East);
        assert_eq!(state.riichi_sticks, 0);

        let mut expected = human.hand.clone();
        expected.push(human.draw.clone().expect("draw"));
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
            .expect("the improving-hand table must be reachable");

        let puzzle = Puzzle::from_state(state);
        assert_eq!(puzzle.kept.len(), 13);
        assert_eq!(puzzle.twin.len(), 13);
        assert_eq!(
            calculate_shanten(&to_counts(&puzzle.kept)).shanten,
            0,
            "the kept hand must be ready"
        );
        assert_eq!(
            calculate_shanten(&to_counts(&puzzle.twin)).shanten,
            0,
            "the twin hand must be ready"
        );
        assert_eq!(
            state.ukeire_tiles.len(),
            1,
            "the kept hand waits on a single tanki tile"
        );
        let metrics = evaluate_hand(&puzzle.kept);
        assert_eq!(metrics.ukeire_tiles, state.ukeire_tiles);
        assert_eq!(metrics.ukeire_total, state.ukeire_total);

        // The two singles are interchangeable: each is the other's wait.
        assert!(puzzle.answer != puzzle.equivalent);
        let answer_wait = parse_tile(&state.ukeire_tiles[0]);
        assert!(
            puzzle.kept.contains(&answer_wait),
            "the kept tanki tile is still in the kept hand"
        );
        assert!(
            !puzzle.kept.contains(&puzzle.answer),
            "the answer must leave the kept hand"
        );
        assert_eq!(
            evaluate_hand(&puzzle.twin).ukeire_tiles,
            vec![puzzle.answer.to_string()],
            "keeping the other single waits on the answer tile"
        );

        // Exactly the two singles are ready discards.
        let mut full = puzzle.kept.clone();
        full.push(puzzle.answer);
        let mut codes = full.clone();
        codes.sort();
        codes.dedup();
        let mut discards = Vec::new();
        for code in codes {
            let mut rest = full.clone();
            rest.remove(
                rest.iter()
                    .position(|tile| *tile == code)
                    .expect("hand tile"),
            );
            if calculate_shanten(&to_counts(&rest)).shanten == 0 {
                discards.push(code);
            }
        }
        discards.sort();
        let mut expected_discards = vec![puzzle.answer, puzzle.equivalent];
        expected_discards.sort();
        assert_eq!(
            discards, expected_discards,
            "only the two singles are ready discards"
        );

        // Not furiten: neither single is already in the human river.
        for tile in [puzzle.answer, puzzle.equivalent] {
            assert!(
                !human
                    .discards
                    .iter()
                    .any(|discard| discard.tile == tile.to_string()),
                "human river contains ready discard {tile}"
            );
        }

        // The dora is one kept tile and the hand has a han without Riichi, so
        // the general rule would declare.
        assert_eq!(state.dora_indicators.len(), 1);
        let dora = indicator_to_dora(puzzle.dora[0]);
        assert_eq!(
            puzzle.kept.iter().filter(|tile| **tile == dora).count(),
            1,
            "exactly one kept tile is dora"
        );
        let conditions = puzzle.conditions();
        assert!(
            conditions.extra_han,
            "the hand must have a han without riichi"
        );
        assert!(!conditions.good_wait, "the tanki is not a good wait");
        assert!(!conditions.dealer);
        assert!(conditions.picks_riichi(), "the general rule would declare");

        // The two halves of the improving box, and the same checks for the
        // twin hand the equivalent discard leaves.
        for (hand, waits, improvement) in [
            (&puzzle.kept, &puzzle.waits, &puzzle.improvement),
            (&puzzle.twin, &vec![puzzle.answer], &puzzle.twin_improvement),
        ] {
            assert!(
                improvement.kinds() >= improvement::MANY_IMPROVING_KINDS,
                "only {} improving kinds, the box needs six",
                improvement.kinds()
            );
            assert!(improvement.qualifies());
            for &tile in &improvement.tiles {
                // Every counted kind must still be drawable.
                let held = hand.iter().filter(|candidate| **candidate == tile).count() as u8;
                assert!(
                    held + puzzle.visible.get(&tile).copied().unwrap_or(0) < 4,
                    "improving kind {tile} is dead on the table"
                );
                // The improving draws are never winning draws.
                assert!(!waits.contains(&tile), "{tile} is also a winning draw");
            }
        }

        // The payload must round-trip, including the reason vocabulary.
        let json = serde_json::to_string(state).expect("state must serialize");
        let parsed: GameState = serde_json::from_str(&json).expect("state must parse back");
        assert_eq!(parsed.category, state.category);
        assert_eq!(parsed.dama_reasons, state.dama_reasons);
        assert_eq!(parsed.equivalent_tiles, state.equivalent_tiles);

        puzzle
    }

    #[test]
    fn every_hand_stays_dama_with_the_box_s_conditions() {
        let started = std::time::Instant::now();
        for run in 0..60 {
            let state = generate("dama_improving_hand")
                .unwrap_or_else(|err| panic!("run {run} failed: {err}"));
            let puzzle = assert_state_is_consistent(&state);

            let improvement = &puzzle.improvement;
            assert!(
                improvement.kinds() >= improvement::MANY_IMPROVING_KINDS,
                "run {run}: {} kinds",
                improvement.kinds()
            );
            // The book's own example counts fourteen kinds; the lesson should
            // be in that territory rather than scraping past six.
            assert!(improvement.kinds() >= 6, "run {run}");
        }

        let elapsed = started.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(120),
            "60 improving-hand generations took {elapsed:?}"
        );
    }

    #[test]
    fn the_payload_offers_riichi_and_answers_dama() {
        for run in 0..10 {
            let state = crate::generator::generate_puzzle("dama_improving_hand")
                .unwrap_or_else(|err| panic!("run {run} failed: {err}"));

            assert!(state.can_riichi, "run {run}: Riichi must be offerable");
            assert_eq!(state.target_action, TargetAction::Dama, "run {run}");
            assert_eq!(
                state.dama_reasons,
                vec![DamaReason::EarlyTurn, DamaReason::ImprovingHand],
                "run {run}"
            );
            assert!(state.riichi_triggers.is_empty(), "run {run}");
            assert!(
                state.book_rationale.is_some(),
                "run {run}: finalize must stamp the book rationale"
            );
        }
    }

    #[test]
    fn both_singles_are_accepted_and_the_dora_is_on_the_table() {
        for run in 0..20 {
            let state = generate("dama_improving_hand")
                .unwrap_or_else(|err| panic!("run {run} failed: {err}"));
            let puzzle = assert_state_is_consistent(&state);

            // The equivalent tile is a real accepted discard, not decoration.
            assert_eq!(state.equivalent_tiles.len(), 1);
            assert_eq!(parse_tile(&state.equivalent_tiles[0]), puzzle.equivalent);

            // The dora indicator is never one of the improving kinds.
            let indicator = parse_tile(&state.dora_indicators[0]);
            assert!(!puzzle.improvement.tiles.contains(&indicator));
            assert!(!puzzle.twin_improvement.tiles.contains(&indicator));
        }
    }

    #[test]
    fn the_book_rationale_names_the_early_turn_and_the_count() {
        let state = crate::generator::finalize_state(
            generate("dama_improving_hand").expect("hand must generate"),
        );
        let rationale = state.book_rationale.expect("book rationale must attach");
        assert_eq!(rationale.source.chapter, 7);
        assert!(
            rationale
                .rules
                .iter()
                .any(|rule| rule.quote.contains("early turn")),
            "the early-turn condition must be quoted"
        );
        assert!(
            rationale
                .rules
                .iter()
                .any(|rule| rule.quote.contains("at least six kinds")),
            "the count condition must be quoted"
        );
    }

    #[test]
    fn no_other_dama_case_is_in_play() {
        // The whole point is that the improving box decides: the hand is not
        // riichi-only, not an expensive hand, and the wait is not a genbutsu.
        for _ in 0..20 {
            let state = generate("dama_improving_hand").expect("hand must generate");
            assert_eq!(
                state.dama_reasons,
                vec![DamaReason::EarlyTurn, DamaReason::ImprovingHand]
            );
            for other in [
                DamaReason::Mangan,
                DamaReason::HanemanPlus,
                DamaReason::GenbutsuWait,
                DamaReason::FewLiveWinningTiles,
                DamaReason::NoExtraHan,
                DamaReason::BadWait,
            ] {
                assert!(!state.dama_reasons.contains(&other), "{other:?}");
            }
        }
    }
}
