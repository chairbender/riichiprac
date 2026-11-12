//! Riichi vs. dama on a bad wait: Riichi Book 1, ch. 7, "Bad wait".
//!
//! The chapter's later dama sections are exceptions to the general
//! three-condition rule. This lesson takes the one case the general rule
//! forbids — a bad-wait, riichi-only hand by a non-dealer — and applies the
//! section's countable threshold instead:
//!
//! > Call riichi if there are three or more winning tiles left in the board.
//! > Go dama if there are only one or two simple tiles left to win on.
//! > (When waiting for an honor/terminal tile, you can call riichi even when
//! > only one tile is left in the board.) — ch7:521-522
//!
//! Every hand is a single-kind wait with no yaku and no dora without Riichi,
//! and the human is never the dealer. The generator plants visible copies of
//! the winning tile in the opponents' rivers to reach the target live count,
//! then recomputes that count from the finished table and grades the answer
//! with the book's box rather than with the constructor.

mod board;
mod judgement;
mod shapes;
mod skeleton;

use crate::generator::support::retry::generate_with_retries;
use crate::state::GameState;

pub(crate) use skeleton::Target;

/// Generates a closed, riichi-only bad-wait hand and asks Riichi or dama.
pub fn generate(category: &str) -> Result<GameState, String> {
    generate_with_target(category, sample_target())
}

/// Draws the box cell the next request will teach, before any tile exists.
///
/// The three cells are already isolated conditions, so the draw stays uniform:
/// each one is a different question, not a weaker or stronger case.
pub(crate) fn sample_target() -> Target {
    skeleton::random_target()
}

/// Builds a hand and table under an already-drawn box cell.
pub(crate) fn generate_with_target(category: &str, target: Target) -> Result<GameState, String> {
    generate_with_retries("dama_bad_wait", 20_000, || {
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
    use agari::shanten::calculate_shanten;
    use agari::tile::Tile;

    use crate::generator::riichi_judgement::judgement as riichi;
    use crate::generator::support::analysis::{evaluate_hand, visible_tile_counts};
    use crate::generator::support::testing::parse_tile;
    use crate::state::{CorrectActionType, RiichiTrigger, TargetAction, Wind};

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
            // The state's `hand` is the 13 tiles held before the draw; the
            // lesson is what happens after the answer comes out of that hand.
            let discard = parse_tile(
                state
                    .correct_action
                    .tile()
                    .expect("bad-wait answer must name a discard"),
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
                    .expect("bad-wait human must have a draw"),
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

        fn quality(&self) -> riichi::WaitQuality {
            riichi::wait_quality(&self.tenpai, &self.visible)
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
        generate_with_retries("dama_bad_wait", 8_000, || {
            let skeleton = skeleton::build(target)?;
            board::build("dama_bad_wait", &skeleton, target)
        })
    }

    /// Every distinct tile in a list, sorted, for discard sweeps.
    fn distinct_tiles(tiles: &[Tile]) -> Vec<Tile> {
        let mut codes = tiles.to_vec();
        codes.sort();
        codes.dedup();
        codes
    }

    fn assert_state_is_consistent(state: &GameState) {
        assert_eq!(state.category, "dama_bad_wait");
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
            .expect("bad-wait human must have a draw");
        let answer = state
            .correct_action
            .tile()
            .expect("bad-wait answer must name a discard");

        // An answer that throws the draw (tsumogiri) means the hand was already
        // tenpai on an earlier turn and the player passed up Riichi then. The
        // answer must be a tile from the hand.
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

        // Every generated table must be a position a real game could reach.
        crate::generator::support::state_validation::validate_reachable_state(state)
            .expect("bad-wait table must be reachable");

        let puzzle = Puzzle::from_state(state);
        assert_eq!(puzzle.tenpai.len(), 13);
        assert_eq!(puzzle.draw, parse_tile(draw));
        assert!(
            matches!(puzzle.waits.len(), 1 | 2),
            "a bad wait has one or two kinds"
        );
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
            !puzzle.tenpai.iter().any(|tile| tile.to_string() == answer),
            "the answer must come out of the hand"
        );

        // No other discard reaches tenpai, so the lesson asks the box's
        // Riichi-or-dama question rather than "which tile do I throw".
        let mut full = puzzle.tenpai.clone();
        full.push(parse_tile(answer));
        for tile in distinct_tiles(&full) {
            let mut rest = full.clone();
            let index = rest
                .iter()
                .position(|candidate| *candidate == tile)
                .expect("tile came from the display");
            rest.remove(index);
            let tenpai = calculate_shanten(&to_counts(&rest)).shanten == 0;
            assert_eq!(
                tenpai,
                tile.to_string() == answer,
                "{tile} must not reach tenpai as well"
            );
        }

        let metrics = evaluate_hand(&puzzle.tenpai);
        assert_eq!(
            metrics.ukeire_tiles, state.ukeire_tiles,
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

        // The general ch7.1 rule must find no condition, so the box decides.
        assert_eq!(
            puzzle.conditions(),
            riichi::Conditions::default(),
            "the lesson must hold the other ch7 conditions at their dama values"
        );
        assert_ne!(puzzle.wind, Wind::East);

        // A one- or two-kind wait is bad because it never has more than four
        // live tiles, however those copies are distributed.
        let quality = puzzle.quality();
        assert!((1..=2).contains(&quality.live_kinds));
        assert!(!quality.is_good());

        // No dora touches the hand, the draw, or the winning tile, so
        // condition 1 never comes from the indicator.
        let mut displayed = puzzle.tenpai.clone();
        displayed.push(parse_tile(answer));
        for &indicator in &puzzle.dora {
            let dora = agari::context::indicator_to_dora(indicator);
            assert!(!displayed.contains(&dora), "the hand holds the dora");
            assert_ne!(dora, puzzle.waits[0], "the winning tile is dora");
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

        // The payload must round-trip, including the trigger vocabulary the
        // frontend reads.
        let json = serde_json::to_string(state).expect("state must serialize");
        let parsed: GameState = serde_json::from_str(&json).expect("state must parse back");
        assert_eq!(parsed.category, state.category);
        assert_eq!(parsed.riichi_triggers, state.riichi_triggers);
        assert_eq!(parsed.dama_reasons, state.dama_reasons);
    }

    #[test]
    fn test_dama_bad_wait_follows_the_live_tile_box() {
        let started = std::time::Instant::now();
        let mut dama = 0;
        let mut many_live = 0;
        let mut honor_terminal = 0;
        let mut one_live = 0;
        let mut two_live = 0;

        for run in 0..300 {
            let state =
                generate("dama_bad_wait").unwrap_or_else(|err| panic!("run {run} failed: {err}"));
            assert_state_is_consistent(&state);

            let puzzle = Puzzle::from_state(&state);
            let quality = puzzle.quality();
            let verdict = judgement::verdict(&puzzle.waits, quality.live_tiles);
            assert!(matches!(quality.live_tiles, 1..=4), "run {run}");

            match quality.live_tiles {
                1 => one_live += 1,
                2 => two_live += 1,
                _ => {}
            }

            match verdict {
                judgement::Verdict::DamaFewSimpleTiles => {
                    dama += 1;
                    assert_eq!(state.target_action, TargetAction::Dama, "run {run}");
                    assert_eq!(state.correct_action.action_type(), CorrectActionType::Dama);
                    assert!(state.riichi_triggers.is_empty(), "run {run}");
                    assert_eq!(state.dama_reasons, judgement::dama_reasons(), "run {run}");
                    assert!(quality.live_tiles <= 2, "run {run}");
                    assert!(
                        puzzle.waits.iter().all(|wait| wait.is_simple()),
                        "run {run}"
                    );
                }
                judgement::Verdict::ThreeLiveTiles => {
                    many_live += 1;
                    assert!(quality.live_tiles >= 3, "run {run}");
                    assert_eq!(state.target_action, TargetAction::Riichi, "run {run}");
                    assert_eq!(
                        state.correct_action.action_type(),
                        CorrectActionType::Riichi
                    );
                    assert_eq!(
                        state.riichi_triggers,
                        vec![RiichiTrigger::ThreeLiveWinningTiles],
                        "run {run}"
                    );
                    assert!(state.dama_reasons.is_empty(), "run {run}");
                }
                judgement::Verdict::HonorTerminalWait => {
                    honor_terminal += 1;
                    assert!((1..=2).contains(&quality.live_tiles), "run {run}");
                    assert!(
                        puzzle.waits.iter().all(|wait| wait.is_terminal_or_honor()),
                        "run {run}"
                    );
                    assert_eq!(state.target_action, TargetAction::Riichi, "run {run}");
                    assert_eq!(
                        state.correct_action.action_type(),
                        CorrectActionType::Riichi
                    );
                    assert_eq!(
                        state.riichi_triggers,
                        vec![RiichiTrigger::HonorTerminalWait],
                        "run {run}"
                    );
                    assert!(state.dama_reasons.is_empty(), "run {run}");
                }
            }
        }

        assert!(dama > 0, "no 1-2 tile dama states were generated");
        assert!(
            many_live > 0,
            "no 3+ live tile riichi states were generated"
        );
        assert!(
            honor_terminal > 0,
            "no honor/terminal exception states were generated"
        );
        assert!(one_live > 0 && two_live > 0, "both 1 and 2 live counts");

        let elapsed = started.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(15),
            "300 bad-wait generations took {elapsed:?}"
        );
    }

    #[test]
    fn test_dama_bad_wait_each_branch_can_be_applied() {
        for target in [
            skeleton::Target::DamaFewSimples,
            skeleton::Target::RiichiManyLive,
            skeleton::Target::RiichiHonorTerminal,
        ] {
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
            let verdict = judgement::verdict(&puzzle.waits, puzzle.quality().live_tiles);
            assert_eq!(verdict, target.expected_verdict(), "{target:?}");
        }
    }

    /// The state's displayed waits must be the bad wait the lesson built.
    #[test]
    fn test_dama_bad_wait_displays_the_bad_wait_shape() {
        for _ in 0..120 {
            let state = generate("dama_bad_wait").expect("hand must generate");
            let puzzle = Puzzle::from_state(&state);

            assert!(matches!(state.ukeire_tiles.len(), 1 | 2));
            assert_eq!(puzzle.waits.len(), state.ukeire_tiles.len());
            assert!((1..=2).contains(&puzzle.quality().live_kinds));
            assert!(!puzzle.quality().is_good());
        }
    }
}
