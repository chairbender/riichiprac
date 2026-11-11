//! Riichi vs. dama on a genbutsu wait: Riichi Book 1, ch. 7, "Genbutsu wait".
//!
//! The chapter lists dama as the third case where keeping a ready hand
//! concealed is fine:
//!
//! > The third case where going dama is OK is when another player is already
//! > getting a lot of attention from others (e.g., riichi, dora pon, or
//! > honitsu) and one of your winning tiles is among their genbutsu tiles.
//! > — ch7:538-539
//!
//! and gives the reason with its own example:
//!
//! > Then, you should keep the hand dama, as souzu 6 is one of the dealer's
//! > genbutsu tiles. There is a good chance that the other two players fold
//! > against the dealer completely and try to discard nothing but their genbutsu
//! > tiles. — ch7:558
//!
//! This lesson is deliberately the mirror image of `dama_bad_wait`. The book's
//! example is a *pinfu* hand on a *side wait*, so the general three-condition
//! rule (ch7:55-59) would tell the player to declare Riichi: the hand has a han
//! and a good wait. The genbutsu section is the exception that keeps it
//! concealed, because the players folding to the threat throw exactly the tiles
//! the threat cannot ron — including one side of this wait.
//!
//! The table shows the threat as a Riichi declarer, the chapter's first example
//! of a player everyone is watching, and plants one winning tile in that
//! player's river before the declaration. The answer is always dama; the
//! generator grades it by re-reading the genbutsu from the finished table, not
//! by trusting the constructor.

mod board;
mod judgement;
mod shapes;
mod skeleton;

use crate::generator::support::retry::generate_with_retries;
use crate::state::GameState;

/// Generates the book's pinfu side-wait hand against a genbutsu-wait threat.
pub fn generate(category: &str) -> Result<GameState, String> {
    generate_with_retries("dama_genbutsu_wait", 20_000, || {
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
    use crate::safety::SafetyFacts;
    use crate::state::{CorrectActionType, DamaReason, TargetAction, Wind};

    /// A hand as the player sees it, read back off the generated state.
    struct Puzzle {
        tenpai: Vec<Tile>,
        draw: Tile,
        waits: Vec<Tile>,
        visible: HashMap<Tile, u8>,
        wind: Wind,
        round_wind: Wind,
        dora: Vec<Tile>,
        /// The riichi opponent the genbutsu read is taken against.
        threat_seat: usize,
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
                    .expect("genbutsu-wait answer must name a discard"),
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
                    .expect("genbutsu-wait human must have a draw"),
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
            let threat_seat = state
                .players
                .iter()
                .find(|player| player.is_riichi)
                .expect("the lesson needs a riichi threat")
                .seat;

            Self {
                tenpai,
                draw,
                waits,
                visible: visible_tile_counts(&rivers, &dora),
                wind: human.wind,
                round_wind: state.round_wind,
                dora,
                threat_seat,
            }
        }

        fn facts(&self, state: &GameState) -> SafetyFacts {
            SafetyFacts::from_state(state, self.threat_seat)
                .expect("the threat's safety facts must be readable")
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

    /// Every distinct tile in a list, sorted, for discard sweeps.
    fn distinct_tiles(tiles: &[Tile]) -> Vec<Tile> {
        let mut codes = tiles.to_vec();
        codes.sort();
        codes.dedup();
        codes
    }

    fn assert_state_is_consistent(state: &GameState) -> Puzzle {
        assert_eq!(state.category, "dama_genbutsu_wait");
        assert_eq!(state.players.len(), 4);
        assert!(state.tiles_remaining > 0);
        assert_eq!(state.decision, crate::state::DecisionContext::SelfTurn);
        assert!(state.shouminkan_triggers.is_empty());
        assert!(state.riichi_triggers.is_empty(), "the answer is dama");
        assert!(!state.is_agari);
        assert_eq!(state.shanten, 0);
        assert_eq!(state.riichi_sticks, 1);
        assert_eq!(state.target_action, TargetAction::Dama);
        assert_eq!(state.correct_action.action_type(), CorrectActionType::Dama);
        assert_eq!(state.dama_reasons, vec![DamaReason::GenbutsuWait]);

        let human = &state.players[0];
        assert!(human.is_human);
        assert!(human.melds.is_empty());
        assert!(!human.is_riichi);
        assert!(human.red_fives.is_empty());
        assert_eq!(human.hand.len(), 13);
        let draw = human
            .draw
            .as_deref()
            .expect("genbutsu-wait human must have a draw");
        let answer = state
            .correct_action
            .tile()
            .expect("genbutsu-wait answer must name a discard");

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

        // Exactly one opponent is in Riichi, and its declaration is marked.
        let riichi_players: Vec<_> = state
            .players
            .iter()
            .skip(1)
            .filter(|player| player.is_riichi)
            .collect();
        assert_eq!(riichi_players.len(), 1, "one threatening player");
        let threat = riichi_players[0];
        let index = threat
            .riichi_discard_index
            .expect("the threat has a declaration discard");
        assert!(threat.discards[index].is_riichi);
        assert_eq!(
            index + 1,
            threat.discards.len(),
            "declaration is the last discard"
        );

        for opponent in &state.players[1..] {
            assert!(!opponent.is_human);
            assert!(opponent.melds.is_empty());
        }

        // Every generated table must be a position a real game could reach.
        crate::generator::support::state_validation::validate_reachable_state(state)
            .expect("genbutsu-wait table must be reachable");

        let puzzle = Puzzle::from_state(state);
        assert_eq!(puzzle.tenpai.len(), 13);
        assert_eq!(puzzle.draw, parse_tile(draw));
        assert_eq!(puzzle.waits.len(), 2, "the book's example is a side wait");
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

        // No other discard reaches tenpai, so the lesson asks Riichi vs dama
        // rather than "which tile do I throw".
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

        // No dora touches the hand, the draw, or a winning tile, so the only
        // value without Riichi is the hand's yaku (pinfu).
        let mut displayed = puzzle.tenpai.clone();
        displayed.push(parse_tile(answer));
        for &indicator in &puzzle.dora {
            let dora = agari::context::indicator_to_dora(indicator);
            assert!(!displayed.contains(&dora), "the hand holds the dora");
            assert!(!puzzle.waits.contains(&dora), "a winning tile is dora");
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

        // The payload must round-trip, including the new reason vocabulary.
        let json = serde_json::to_string(state).expect("state must serialize");
        let parsed: GameState = serde_json::from_str(&json).expect("state must parse back");
        assert_eq!(parsed.category, state.category);
        assert_eq!(parsed.riichi_triggers, state.riichi_triggers);
        assert_eq!(parsed.dama_reasons, state.dama_reasons);

        puzzle
    }

    #[test]
    fn every_hand_is_dama_because_one_winning_tile_is_the_threat_genbutsu() {
        let started = std::time::Instant::now();
        for run in 0..200 {
            let state = generate("dama_genbutsu_wait")
                .unwrap_or_else(|err| panic!("run {run} failed: {err}"));
            let puzzle = assert_state_is_consistent(&state);
            let facts = puzzle.facts(&state);

            // The task's verification: at least one winning tile appears in the
            // threatening player's river (or is otherwise their genbutsu).
            let genbutsu = judgement::genbutsu_waits(&puzzle.waits, &facts);
            assert!(
                !genbutsu.is_empty(),
                "run {run}: no winning tile is the threat's genbutsu"
            );
            assert_eq!(genbutsu.len(), 1, "run {run}: one side of the wait");
            assert!(judgement::applies(&puzzle.waits, &facts), "run {run}");

            // ... and the other side is still live, so the hand can win.
            let live: Vec<Tile> = puzzle
                .waits
                .iter()
                .copied()
                .filter(|tile| !facts.is_genbutsu(*tile))
                .collect();
            assert_eq!(live.len(), 1, "run {run}");

            // The general rule would have said Riichi: this is the exception.
            let conditions = puzzle.conditions();
            assert!(
                conditions.extra_han,
                "run {run}: the book's example is a pinfu hand"
            );
            assert!(
                conditions.good_wait,
                "run {run}: the book's example is a side wait"
            );
            assert!(
                !conditions.dealer,
                "run {run}: the human is never the dealer"
            );

            let quality = puzzle.quality();
            assert_eq!(quality.live_kinds, 2, "run {run}");
            assert_eq!(quality.live_tiles, 7, "run {run}");
            assert!(quality.is_good(), "run {run}");
        }

        let elapsed = started.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(15),
            "200 genbutsu-wait generations took {elapsed:?}"
        );
    }

    #[test]
    fn the_genbutsu_tile_is_discarded_before_the_declaration() {
        for run in 0..80 {
            let state = generate("dama_genbutsu_wait")
                .unwrap_or_else(|err| panic!("run {run} failed: {err}"));
            let puzzle = assert_state_is_consistent(&state);
            let facts = puzzle.facts(&state);

            let threat = state
                .players
                .iter()
                .find(|player| player.seat == puzzle.threat_seat)
                .expect("threat player");
            let declaration = threat
                .riichi_discard_index
                .expect("the threat declared riichi");

            let genbutsu = judgement::genbutsu_waits(&puzzle.waits, &facts);
            let tile = genbutsu[0].to_string();
            let position = threat
                .discards
                .iter()
                .position(|discard| discard.tile == tile)
                .unwrap_or_else(|| panic!("run {run}: {tile} is not in the threat's river"));
            assert!(
                position < declaration,
                "run {run}: {tile} must be discarded before the declaration"
            );
            // And the live side is in nobody's river.
            let live = puzzle
                .waits
                .iter()
                .find(|wait| !facts.is_genbutsu(**wait))
                .copied()
                .expect("one live winning tile");
            for opponent in &state.players[1..] {
                assert!(
                    !opponent
                        .discards
                        .iter()
                        .any(|discard| discard.tile == live.to_string()),
                    "run {run}: the live wait {live} is visible in a river"
                );
            }
        }
    }

    /// The displayed waits must be the hand's real two-sided wait, and the
    /// answer must be the tedashi floater, not the drawn protorun tile.
    #[test]
    fn the_lesson_always_shows_the_side_wait_and_keeps_the_drawn_protorun_tile() {
        for run in 0..80 {
            let state = generate("dama_genbutsu_wait")
                .unwrap_or_else(|err| panic!("run {run} failed: {err}"));
            let puzzle = assert_state_is_consistent(&state);

            assert_eq!(state.ukeire_tiles.len(), 2, "run {run}");
            assert_eq!(puzzle.waits.len(), 2, "run {run}");
            let quality = puzzle.quality();
            assert_eq!(quality.live_kinds, 2, "run {run}");
            assert!(quality.is_good(), "run {run}");

            // The drawn tile is one half of the protorun and stays in the hand;
            // it is never a winning tile, so the discard stays a discard.
            assert!(puzzle.tenpai.contains(&puzzle.draw), "run {run}");
            assert!(!puzzle.waits.contains(&puzzle.draw), "run {run}");
        }
    }

    /// The full generated payload must offer Riichi (so the question is really
    /// Riichi vs. dama) while the book's answer stays dama.
    #[test]
    fn the_payload_offers_riichi_and_answers_dama() {
        for run in 0..10 {
            let state = crate::generator::generate_puzzle("dama_genbutsu_wait")
                .unwrap_or_else(|err| panic!("run {run} failed: {err}"));

            assert!(state.can_riichi, "run {run}: Riichi must be offerable");
            assert_eq!(state.target_action, TargetAction::Dama, "run {run}");
            assert_eq!(
                state.dama_reasons,
                vec![DamaReason::GenbutsuWait],
                "run {run}"
            );
            assert!(state.riichi_triggers.is_empty(), "run {run}");
            assert!(
                state.book_rationale.is_some(),
                "run {run}: finalize must stamp the book rationale"
            );
        }
    }
}
