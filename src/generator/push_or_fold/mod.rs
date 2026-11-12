//! Push or fold: Riichi Book 1, ch. 8.1, "A simple principle".
//!
//! The chapter's box is two three-condition lists:
//!
//! > {\large Push} if {\bf two} of the following conditions are met: Ready
//! > hand; High scoring hand; Good wait. — ch8:23
//! >
//! > {\large Fold} if {\bf two} of the following conditions are met: 1-away (or
//! > worse) hand; Low scoring hand; Bad wait. — ch8:31
//!
//! and its own reading of the first list:
//!
//! > Pushing with a 1-away hand is acceptable only when \emph{both} of the
//! > other two conditions are met. — ch8:62
//!
//! This lesson isolates that cell. Both branches hand the player the same
//! fourteen-tile shape — two sets, two protoruns and two pairs, the last one
//! just completed by the draw — and only the hand's value and wait change:
//!
//! - `push`: a guaranteed mangan (ch8:65's "minimum hand value is 7700") and a
//!   perfect 1-away shape (ch8:77: "no matter how this hand becomes ready, you
//!   can \emph{always} choose to have a side wait"). Both non-ready conditions
//!   hold, so the answer is the shape-preserving discard, even though that
//!   tile sits on the chart's dangerous Rank D row. The book's own exception
//!   permits it: "Only if your hand has a guaranteed {\jap mangan}, you can
//!   discard {\bf Rank D} tiles." (ch8, "Defense against riichi")
//! - `fold`: a hand with no yaku and a bad wait (at least one way the hand can
//!   become ready leaves only a closed, edge or single wait), so neither
//!   condition holds. The answer is the safest discard — the threat's genbutsu
//!   — even though throwing it visibly breaks a complete set.
//!
//! The answer stays an ordinary discard: pushing is the shape-preserving tile,
//! folding is the safe tile. There is no `Push`/`Fold` answer to invent.

mod board;
mod skeleton;

use agari::tile::Tile;

use crate::generator::support::retry::generate_with_retries;
use crate::generator::support::value::{Value, worst_completion_value};
use crate::state::GameState;

pub(crate) use skeleton::Target;

/// Generates a push-or-fold puzzle for the next request.
pub fn generate(category: &str) -> Result<GameState, String> {
    generate_with_target(category, sample_target())
}

/// Draws the cell of the box the next request will teach, before any tile
/// exists.
pub(crate) fn sample_target() -> Target {
    Target::sample()
}

/// Builds a hand and table under an already-drawn cell.
pub(crate) fn generate_with_target(category: &str, target: Target) -> Result<GameState, String> {
    generate_with_retries("push_or_fold", 500, || board::build(category, target))
}

/// The two conditions ch. 8 weighs for a 1-away hand, re-derived from a
/// finished table.
///
/// The rationale needs them to say *why* the answer is push or fold, and it
/// must read them off the shipped tiles rather than trusting the constructor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Conditions {
    /// The worst value the hand can win for without Riichi; `None` when some
    /// completion has no yaku at all.
    pub value: Option<Value>,
    /// True when every completion still can choose a side wait.
    pub good_wait: bool,
}

impl Conditions {
    /// True when the hand meets both of the non-ready push conditions.
    pub fn pushes(&self) -> bool {
        self.is_high_scoring() && self.good_wait
    }

    /// True when the worst completion reaches the book's 7700 floor.
    pub fn is_high_scoring(&self) -> bool {
        self.value.is_some_and(Value::is_high_scoring)
    }
}

/// Re-derives the push conditions from `state`, or `None` when the state is not
/// a push/fold table.
pub(crate) fn conditions(state: &GameState) -> Option<Conditions> {
    let human = state.players.iter().find(|player| player.is_human)?;
    let drawn = Tile::try_from(human.draw.as_deref()?).ok()?;
    let mut core: Vec<Tile> = state
        .tiles
        .iter()
        .filter_map(|code| Tile::try_from(code.as_str()).ok())
        .collect();
    let index = core.iter().position(|tile| *tile == drawn)?;
    core.remove(index);

    let dora: Vec<Tile> = state
        .dora_indicators
        .iter()
        .filter_map(|code| Tile::try_from(code.as_str()).ok())
        .collect();

    Some(hand_conditions(&core, state.round_wind, human.wind, &dora))
}

/// The push conditions for one 13-tile hand.
pub(crate) fn hand_conditions(
    tiles: &[Tile],
    round_wind: crate::state::Wind,
    seat_wind: crate::state::Wind,
    dora: &[Tile],
) -> Conditions {
    Conditions {
        value: worst_completion_value(tiles, round_wind, seat_wind, dora, 0),
        good_wait: skeleton::good_wait(tiles),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use agari::parse::to_counts;
    use agari::shanten::calculate_shanten;
    use agari::tile::Tile;

    use crate::generator::support::value::worst_completion_value;
    use crate::safety::{SafetyFacts, SafetyRank};
    use crate::state::{CorrectActionType, TargetAction};

    fn human(state: &GameState) -> &crate::state::PlayerState {
        state
            .players
            .iter()
            .find(|player| player.is_human)
            .expect("human player")
    }

    fn threat(state: &GameState) -> &crate::state::PlayerState {
        state
            .players
            .iter()
            .find(|player| player.is_riichi)
            .expect("threat player")
    }

    fn answer(state: &GameState) -> Tile {
        Tile::try_from(state.correct_action.tile().expect("answer tile"))
            .expect("answer tile must parse")
    }

    fn core(state: &GameState) -> Vec<Tile> {
        let mut tiles: Vec<Tile> = state
            .tiles
            .iter()
            .filter_map(|code| Tile::try_from(code.as_str()).ok())
            .collect();
        let drawn = human(state).draw.as_deref().expect("a drawn tile");
        let index = tiles
            .iter()
            .position(|tile| tile.to_string() == drawn)
            .expect("the draw is in the hand");
        tiles.remove(index);
        tiles
    }

    fn push_conditions(state: &GameState) -> (bool, bool) {
        let dora: Vec<Tile> = state
            .dora_indicators
            .iter()
            .filter_map(|code| Tile::try_from(code.as_str()).ok())
            .collect();
        let value =
            worst_completion_value(&core(state), state.round_wind, human(state).wind, &dora, 0);
        let high = value.is_some_and(|value| value.is_high_scoring());
        (high, skeleton::good_wait(&core(state)))
    }

    #[test]
    fn both_cells_of_the_box_are_generated() {
        let mut saw_push = false;
        let mut saw_fold = false;
        for _ in 0..80 {
            let state = generate("push_or_fold").expect("the lesson must generate");
            assert_eq!(state.category, "push_or_fold");
            assert_eq!(state.shanten, 1, "the hand must be 1-away");
            assert!(!state.can_riichi);
            assert!(!state.is_agari);
            assert_eq!(state.riichi_sticks, 1);

            let threat = threat(&state);
            assert!(threat.riichi_discard_index.is_some());
            assert!(threat.discards.last().expect("a riichi discard").is_riichi);

            let human = human(&state);
            assert_eq!(human.hand.len(), 13);
            assert!(human.draw.is_some());
            assert!(human.melds.is_empty());
            assert!(!human.is_riichi);

            match state.target_action {
                TargetAction::Push => {
                    saw_push = true;
                    assert_eq!(state.correct_action.action_type(), CorrectActionType::Dama);
                    assert_eq!(state.correct_action.tile(), human.draw.as_deref());

                    let facts = SafetyFacts::from_state(&state, threat.seat).expect("facts");
                    assert_eq!(
                        facts.rank(answer(&state)),
                        SafetyRank::D,
                        "the pushed discard is the chart's most dangerous row"
                    );
                    let (high, good) = push_conditions(&state);
                    assert!(high && good, "both non-ready push conditions must hold");
                }
                TargetAction::Fold => {
                    saw_fold = true;
                    assert_eq!(state.correct_action.action_type(), CorrectActionType::Fold);
                    assert_ne!(
                        Some(state.correct_action.tile().unwrap()),
                        human.draw.as_deref()
                    );

                    let facts = SafetyFacts::from_state(&state, threat.seat).expect("facts");
                    assert_eq!(
                        facts.rank(answer(&state)),
                        SafetyRank::Genbutsu,
                        "the fold answer is 100% safe"
                    );
                    let (high, good) = push_conditions(&state);
                    assert!(
                        !(high && good),
                        "a 1-away hand folds unless both other conditions hold"
                    );
                }
                other => panic!("unexpected target action {other:?}"),
            }
        }
        assert!(saw_push, "the push cell must be generated");
        assert!(saw_fold, "the fold cell must be generated");
    }

    #[test]
    fn the_answer_is_a_tile_the_human_holds() {
        for target in [Target::Push, Target::Fold] {
            for run in 0..20 {
                let state = generate_with_target("push_or_fold", target)
                    .unwrap_or_else(|err| panic!("{target:?} run {run}: {err}"));
                let tile = state.correct_action.tile().expect("an answer tile");
                assert!(
                    state.tiles.iter().any(|code| code == tile),
                    "{target:?} run {run}: the answer must be in the hand"
                );

                let mut tiles: Vec<Tile> = state
                    .tiles
                    .iter()
                    .filter_map(|code| Tile::try_from(code.as_str()).ok())
                    .collect();
                tiles.sort();
                assert_eq!(calculate_shanten(&to_counts(&tiles)).shanten, 1);
            }
        }
    }

    #[test]
    fn the_accepted_push_discards_are_exactly_the_two_pair_tiles() {
        for run in 0..6 {
            let state = generate_with_target("push_or_fold", Target::Push).expect("a push hand");
            let dora: Vec<Tile> = state
                .dora_indicators
                .iter()
                .filter_map(|code| Tile::try_from(code.as_str()).ok())
                .collect();
            let mut tiles: Vec<Tile> = state
                .tiles
                .iter()
                .filter_map(|code| Tile::try_from(code.as_str()).ok())
                .collect();
            tiles.sort();

            let mut accepted: Vec<String> = Vec::new();
            let mut seen: Vec<Tile> = Vec::new();
            for discard in &tiles {
                if seen.contains(discard) {
                    continue;
                }
                seen.push(*discard);

                let mut rest = tiles.clone();
                let index = rest.iter().position(|tile| tile == discard).unwrap();
                rest.remove(index);
                let conditions =
                    hand_conditions(&rest, state.round_wind, state.players[0].wind, &dora);
                if conditions.pushes() {
                    accepted.push(discard.to_string());
                }
            }
            accepted.sort();
            accepted.dedup();

            let mut expected: Vec<String> = vec![
                state.correct_action.tile().unwrap().to_string(),
                state.equivalent_tiles[0].clone(),
            ];
            expected.sort();
            expected.dedup();

            assert_eq!(
                accepted, expected,
                "run {run}: the shape-preserving discards must be exactly the two pair tiles"
            );
            assert_eq!(accepted.len(), 2);
        }
    }

    #[test]
    fn the_fold_hand_has_no_push_discard() {
        for run in 0..6 {
            let state = generate_with_target("push_or_fold", Target::Fold).expect("a fold hand");
            let dora: Vec<Tile> = state
                .dora_indicators
                .iter()
                .filter_map(|code| Tile::try_from(code.as_str()).ok())
                .collect();
            let mut tiles: Vec<Tile> = state
                .tiles
                .iter()
                .filter_map(|code| Tile::try_from(code.as_str()).ok())
                .collect();
            tiles.sort();

            let mut seen: Vec<Tile> = Vec::new();
            for discard in &tiles {
                if seen.contains(discard) {
                    continue;
                }
                seen.push(*discard);

                let mut rest = tiles.clone();
                let index = rest.iter().position(|tile| tile == discard).unwrap();
                rest.remove(index);
                let conditions =
                    hand_conditions(&rest, state.round_wind, state.players[0].wind, &dora);
                assert!(
                    !conditions.pushes(),
                    "run {run}: discarding {discard} would meet both push conditions"
                );
            }
        }
    }
}
