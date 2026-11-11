//! Riichi the immediate suji trap: Riichi Book 1, ch. 8, "Suji trap".
//!
//! The chapter defines the trap and then gives the immediate version of it:
//!
//! > When you wait for a tile that is a suji tile of some tiles you have
//! > discarded yourself, we say you have a suji-trap wait. In particular, when
//! > your wait is a suji tile of the riichi declaration tile, we say it is an
//! > immediate suji-trap wait. — ch8:165
//!
//! > If you call riichi by discarding the {6}, the hand waits for {3}, which is
//! > a suji tile of {6} (immediate suji-trap riichi). — ch8:170
//!
//! Ch. 7 turns that defense concept into a Riichi justification, which is the
//! question this lesson asks:
//!
//! > The third factor you may want to consider is whether your wait would
//! > appear safe in the eyes of your opponents. [...] This is called a
//! > suji-trap wait. — ch7:512
//!
//! The generated hand has two discards that both reach tenpai on the *same*
//! single tile, so the choice is not about acceptance at all: one discard makes
//! the winning tile a suji of the declaration tile and the other does not. The
//! hand is riichi-only, the human is not the dealer, and two copies of the wait
//! are already visible, so the general ch. 7 rule (ch7:55-59) and its bad-wait
//! box (ch7:521-522) both keep it dama. The suji trap is the reason to declare.
//!
//! Answer: Riichi, discarding the trap tile.

mod board;
mod skeleton;

use crate::generator::support::retry::generate_with_retries;
use crate::state::GameState;

/// Generates a closed tenpai hand whose trap discard makes the wait look safe.
pub fn generate(category: &str) -> Result<GameState, String> {
    generate_with_retries("suji_trap_riichi", 10_000, || {
        let skeleton = skeleton::build()?;
        board::build(category, &skeleton)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::collections::HashMap;

    use agari::hand::{HandStructure, decompose_hand};
    use agari::parse::to_counts;
    use agari::shanten::calculate_shanten;
    use agari::tile::Tile;

    use crate::generator::riichi_judgement::judgement as riichi;
    use crate::generator::support::analysis::{evaluate_hand, visible_tile_counts};
    use crate::generator::support::testing::parse_tile;
    use crate::generator::support::tiles::suji_tiles;
    use crate::state::{CorrectActionType, RiichiTrigger, TargetAction, Wind};

    /// A hand as the player sees it, read back off the generated state.
    struct Puzzle {
        /// The 13 tiles left after the trap discard.
        tenpai: Vec<Tile>,
        draw: Tile,
        trap_discard: Tile,
        waits: Vec<Tile>,
        visible: HashMap<Tile, u8>,
        wind: Wind,
        round_wind: Wind,
        dora: Vec<Tile>,
    }

    impl Puzzle {
        fn from_state(state: &GameState) -> Self {
            let human = &state.players[0];
            let trap_discard = parse_tile(
                state
                    .correct_action
                    .tile()
                    .expect("the suji-trap answer must name a discard"),
            );
            let mut tenpai: Vec<Tile> = state.tiles.iter().map(|tile| parse_tile(tile)).collect();
            let index = tenpai
                .iter()
                .position(|tile| *tile == trap_discard)
                .expect("the answer must be in the displayed hand");
            tenpai.remove(index);
            let draw = parse_tile(
                human
                    .draw
                    .as_deref()
                    .expect("the suji-trap human must have a draw"),
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
                trap_discard,
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

        fn conditions(&self) -> riichi::Conditions {
            riichi::evaluate(
                &self.tenpai,
                &self.waits,
                self.round_wind,
                self.wind,
                &self.dora,
                &self.visible,
            )
        }
    }

    /// Every distinct tile in a list, sorted, for discard sweeps.
    fn distinct_tiles(tiles: &[Tile]) -> Vec<Tile> {
        let mut codes = tiles.to_vec();
        codes.sort();
        codes.dedup();
        codes
    }

    /// The tenpai discards of the displayed fourteen tiles, with their waits.
    fn tenpai_discards(full: &[Tile]) -> Vec<(Tile, Vec<Tile>)> {
        let mut discards = Vec::new();
        for code in distinct_tiles(full) {
            let mut rest = full.to_vec();
            let index = rest
                .iter()
                .position(|tile| *tile == code)
                .expect("code came from the hand");
            rest.remove(index);
            if calculate_shanten(&to_counts(&rest)).shanten == 0 {
                let waits: Vec<Tile> = evaluate_hand(&rest)
                    .ukeire_tiles
                    .iter()
                    .map(|wait| parse_tile(wait))
                    .collect();
                discards.push((code, waits));
            }
        }
        discards
    }

    fn assert_state_is_consistent(state: &GameState) -> Puzzle {
        assert_eq!(state.category, "suji_trap_riichi");
        assert_eq!(state.players.len(), 4);
        assert!(state.tiles_remaining > 0);
        assert_eq!(state.decision, crate::state::DecisionContext::SelfTurn);
        assert!(state.shouminkan_triggers.is_empty());
        assert!(!state.is_agari);
        assert_eq!(state.shanten, 0);

        // The answer: Riichi on the trap discard, with the immediate trap as
        // the only cited justification.
        assert_eq!(state.target_action, TargetAction::Riichi);
        assert_eq!(
            state.correct_action.action_type(),
            CorrectActionType::Riichi
        );
        assert_eq!(
            state.riichi_triggers,
            vec![RiichiTrigger::ImmediateSujiTrap]
        );
        assert!(state.dama_reasons.is_empty());

        let human = &state.players[0];
        assert!(human.is_human);
        assert!(human.melds.is_empty());
        assert!(!human.is_riichi);
        assert!(human.red_fives.is_empty());
        assert_eq!(human.hand.len(), 13);
        let draw = human
            .draw
            .as_deref()
            .expect("the suji-trap human must have a draw");
        let answer = state
            .correct_action
            .tile()
            .expect("the suji-trap answer must name a discard");

        // The answer is a tedashi from the hand, never the draw: the table must
        // not imply that an earlier Riichi was passed up.
        assert_ne!(answer, draw, "the answer must never be tsumogiri");
        assert!(
            human.hand.iter().any(|tile| tile == answer),
            "the answer {answer} must be a hand tile (tedashi)"
        );

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

        // Every generated table must be a position a real game could reach.
        crate::generator::support::state_validation::validate_reachable_state(state)
            .expect("the suji-trap table must be reachable");

        let puzzle = Puzzle::from_state(state);
        assert_eq!(puzzle.tenpai.len(), 13);
        assert_eq!(puzzle.draw, parse_tile(draw));
        assert_eq!(
            calculate_shanten(&to_counts(&puzzle.tenpai)).shanten,
            0,
            "the kept hand must be tenpai"
        );
        assert!(
            puzzle.tenpai.contains(&puzzle.draw),
            "the draw must stay in the tenpai hand"
        );
        assert!(
            !puzzle.tenpai.iter().any(|tile| tile.to_string() == answer),
            "the answer must come out of the hand"
        );

        // One single wait, three ranks from the declaration tile: the book's
        // immediate suji trap (ch8:170).
        assert_eq!(puzzle.waits.len(), 1, "the lesson is a single wait");
        let wait_suji = suji_tiles(puzzle.trap_discard);
        assert!(
            wait_suji.contains(&puzzle.waits[0]),
            "the wait must be three ranks from the trap discard"
        );

        // Four nominal copies (the hand holds none), two of them visible in
        // the opponents' rivers: a two-tile bad wait, so the general rule and
        // the bad-wait box would both keep this hand dama.
        assert_eq!(state.ukeire_total, 4, "four nominal winning tiles");
        let quality = riichi::wait_quality(&puzzle.tenpai, &puzzle.visible);
        assert_eq!(quality.live_kinds, 1);
        assert_eq!(quality.live_tiles, 2);
        assert!(!quality.is_good());
        let conditions = puzzle.conditions();
        assert!(!conditions.extra_han, "the hand must be riichi-only");
        assert!(!conditions.good_wait);
        assert!(!conditions.dealer);
        assert!(
            !(conditions.extra_han || conditions.good_wait || conditions.dealer),
            "the trap must be the only reason"
        );

        // The alternative discard reaches tenpai on the same wait and is not a
        // suji of it, so the trap is the only difference between the answers.
        let full: Vec<Tile> = state.tiles.iter().map(|tile| parse_tile(tile)).collect();
        let discards = tenpai_discards(&full);
        assert_eq!(
            discards.len(),
            2,
            "exactly two discards keep the hand ready"
        );
        assert!(
            discards.iter().any(|(tile, _)| tile.to_string() == answer),
            "the trap discard is one of them"
        );
        let plain = discards
            .iter()
            .find(|(tile, _)| tile.to_string() != answer)
            .expect("the plain alternative");
        assert_eq!(plain.1, puzzle.waits, "both discards wait on the same tile");
        assert!(
            !suji_tiles(plain.0).contains(&puzzle.waits[0]),
            "the alternative must not be a suji of the wait"
        );

        // No winning hand may be chiitoitsu, and the hand must be standard.
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

        // Riichi-only: no yaku and no dora without the declaration.
        assert_eq!(
            riichi::min_han_without_riichi(
                &puzzle.tenpai,
                &puzzle.waits,
                puzzle.round_wind,
                puzzle.wind,
                &puzzle.dora,
            ),
            0,
            "the hand must be riichi-only"
        );

        // The human river may not already hold the wait (furiten) or any suji
        // of it (which would make the plain discard a trap too).
        for discard in &human.discards {
            assert_ne!(discard.tile, puzzle.waits[0].to_string(), "furiten");
            assert!(
                !suji_tiles(puzzle.waits[0])
                    .iter()
                    .any(|suji| suji.to_string() == discard.tile),
                "the human river already holds a suji of the wait"
            );
        }

        // The payload must round-trip, including the new trigger vocabulary.
        let json = serde_json::to_string(state).expect("state must serialize");
        let parsed: GameState = serde_json::from_str(&json).expect("state must parse back");
        assert_eq!(parsed.category, state.category);
        assert_eq!(parsed.riichi_triggers, state.riichi_triggers);

        puzzle
    }

    #[test]
    fn test_suji_trap_riichi_constraints() {
        let started = std::time::Instant::now();
        for run in 0..200 {
            let state = generate("suji_trap_riichi")
                .unwrap_or_else(|err| panic!("run {run} failed: {err}"));
            assert_state_is_consistent(&state);
        }

        let elapsed = started.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(15),
            "200 suji-trap generations took {elapsed:?}"
        );
    }

    /// Both mirrored shapes (waiting on 7 or on 3) must appear, so the lesson
    /// is not silently locked to one suit layout.
    #[test]
    fn both_mirrored_shapes_are_generated() {
        let mut low = 0;
        let mut high = 0;
        for _ in 0..120 {
            let state = generate("suji_trap_riichi").expect("hand must generate");
            let puzzle = assert_state_is_consistent(&state);
            match puzzle.waits[0].value() {
                Some(7) => low += 1,
                Some(3) => high += 1,
                other => panic!("unexpected wait value {other:?}"),
            }
        }
        assert!(low > 0 && high > 0, "low {low} high {high}");
    }

    /// The full payload must offer Riichi and cite the ch. 8 suji-trap section.
    #[test]
    fn the_payload_offers_riichi_and_cites_the_trap() {
        for run in 0..10 {
            let state = crate::generator::generate_puzzle("suji_trap_riichi")
                .unwrap_or_else(|err| panic!("run {run} failed: {err}"));

            assert!(state.can_riichi, "run {run}: Riichi must be offerable");
            assert_eq!(state.target_action, TargetAction::Riichi, "run {run}");
            assert_eq!(
                state.correct_action.action_type(),
                CorrectActionType::Riichi,
                "run {run}"
            );
            assert_eq!(
                state.riichi_triggers,
                vec![RiichiTrigger::ImmediateSujiTrap],
                "run {run}"
            );
            assert!(state.dama_reasons.is_empty(), "run {run}");

            let rationale = state
                .book_rationale
                .as_ref()
                .expect("finalize must stamp the book rationale");
            assert_eq!(rationale.source.chapter, 8, "run {run}");
            assert_eq!(rationale.source.section, "Suji trap", "run {run}");
            assert!(
                rationale
                    .rules
                    .iter()
                    .any(|rule| rule.id == "immediate_suji_trap"),
                "run {run}: the cited rule must be the immediate trap"
            );
            assert!(!rationale.caveats.is_empty(), "run {run}");
        }
    }
}
