//! The ch. 5 "building the head" pinfu rule (`pinfu_head`).
//!
//! Riichi Book 1, ch. 5, "How to get pinfu", *Building the head*:
//!
//! > To claim pinfu, the head must be a pair of number tiles or valueless wind
//! > tiles. Therefore, try not to discard terminals or valueless wind tiles
//! > lightly when having a pinfu hand. Keep this in mind especially when a hand
//! > is lacking any pair. — ch5
//!
//! and the book's worked example:
//!
//! > ... they can be the head of a pinfu hand when any of them grows into a
//! > pair. On the other hand, the value tile fa cannot be the head of pinfu. We
//! > should discard fa in this case.
//!
//! The rule is about tile **types**: any number tile and any valueless wind may
//! become the pinfu head, while a value honor (a dragon, the round wind or the
//! seat wind) never can. The drill's opening hand has exactly one value honor
//! and no committed head, so that honor is the only tile the rule bars and the
//! answer.
//!
//! "No committed head" is structural: every duplicate must be the middle of the
//! book's bulging float (`x, x+1, x+1, x+2`), which is a shape, not a pair. A
//! hand that already holds a real pair has finished building its head, so it is
//! not this question and the recogniser refuses it.

use agari::tile::Tile;

use crate::generator::ScenarioId;
use crate::generator::pinfu_head::is_value_honor;
use crate::state::{CorrectAction, GameState, TargetAction};

use super::support::{self, Turn};
use super::{Allowed, Match, TransformPolicy};

/// The rule is about tile types and head shape, so suit/rank/wind relabelling
/// keeps the same answer when recomputed. A red five is a dora, and the lesson
/// is deliberately score-free ("the answer is never the dora"), so normalising
/// one is allowed only through the recompute gate.
pub(crate) const POLICY: TransformPolicy = TransformPolicy {
    seat_perm: Allowed::AllowWithRecompute,
    suit_perm: Allowed::AllowWithRecompute,
    rank_mirror: Allowed::AllowWithRecompute,
    wind_relabel: Allowed::AllowWithRecompute,
    red5_normalize: Allowed::Deny,
    note: "pinfu head eligibility is a tile-type rule (number tiles and valueless winds may be \
           the head; value honors may not), so every relabelling re-runs it. Red-five \
           normalisation stays denied: the lesson is deliberately score-free, and changing the \
           red-five identity only loses volume without teaching a different rule.",
};

/// Recognise the ch. 5 pinfu-head discard.
pub fn pinfu_head(state: &GameState) -> Option<Match> {
    let turn = support::turn(state)?;
    if !support::is_opening_turn(state, &turn) {
        return None;
    }
    // The lesson's hands are slow opening shapes, not a ready hand's riichi
    // question; a tenpai discard would make another lesson the live one.
    if turn.shanten < 2 || support::candidates(&turn).is_some() {
        return None;
    }
    if has_committed_head(&turn) {
        return None;
    }

    // Every non-value tile may be the head, so the rule names the lone value
    // honor as the only tile that cannot be. Two value honors would leave the
    // answer ambiguous; a hand with none has no answer under this rule.
    let value_honors: Vec<Tile> = support::distinct(&turn.hand)
        .into_iter()
        .filter(|tile| is_value_honor(*tile, turn.round_wind, turn.human_wind))
        .collect();
    let [answer] = value_honors.as_slice() else {
        return None;
    };
    if turn.hand.iter().filter(|tile| *tile == answer).count() != 1 {
        return None;
    }

    Some(Match {
        lesson: ScenarioId::PinfuHead,
        situation: Some("no committed head; one value honor cannot be the pinfu head".to_string()),
        target_action: TargetAction::NaniKiru,
        correct_action: CorrectAction::dama(answer.to_string()),
        equivalent_tiles: Vec::new(),
        riichi_triggers: Vec::new(),
        dama_reasons: Vec::new(),
        shouminkan_triggers: Vec::new(),
        scenario_note: None,
    })
}

/// True when the hand already holds a pair (or a triplet) that can be the head.
///
/// A bulging float (`x, x+1, x+1, x+2`) doubles its middle tile but is read as
/// one block, so it is not a committed head. Every other repeated type is.
fn has_committed_head(turn: &Turn) -> bool {
    support::distinct(&turn.hand).into_iter().any(|tile| {
        match turn.hand.iter().filter(|held| **held == tile).count() {
            0 | 1 => false,
            2 => !is_bulge_middle(turn, tile),
            _ => true,
        }
    })
}

/// True when `tile` is the doubled middle of `x, x+1, x+1, x+2`.
fn is_bulge_middle(turn: &Turn, tile: Tile) -> bool {
    let Tile::Suited { suit, value } = tile else {
        return false;
    };
    if !(2..=8).contains(&value) {
        return false;
    }
    let held = |rank: u8| turn.hand.contains(&Tile::suited(suit, rank));
    held(value - 1) && held(value + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::generator::generate_puzzle;

    /// Replace one spare tile of the concealed hand, keeping the hand at
    /// thirteen tiles and the table otherwise intact.
    fn replace_spare(state: &mut GameState, with: &str, exclude: &[&str]) {
        let index = state.players[0]
            .hand
            .iter()
            .position(|code| !exclude.contains(&code.as_str()))
            .expect("a spare hand tile");
        state.players[0].hand[index] = with.to_string();
    }

    #[test]
    fn the_pinfu_head_recognises_its_own_lesson() {
        for run in 0..12 {
            let state =
                generate_puzzle("pinfu_head").unwrap_or_else(|err| panic!("run {run}: {err}"));
            let matched = pinfu_head(&state).unwrap_or_else(|| panic!("run {run}: no match"));
            matched
                .validate(&state)
                .unwrap_or_else(|err| panic!("run {run}: illegal answer: {err}"));
            assert_eq!(matched.lesson, ScenarioId::PinfuHead);
            assert_eq!(matched.target_action, TargetAction::NaniKiru);
            assert_eq!(matched.correct_action.tile(), state.correct_action.tile());
            assert!(matched.equivalent_tiles.is_empty());
        }
    }

    #[test]
    fn a_hand_with_a_committed_pair_is_not_this_lesson() {
        for _ in 0..8 {
            let mut state = generate_puzzle("pinfu_head").expect("must generate");
            // The hand always carries two terminal floats, and a terminal can
            // never be a bulging float's middle: duplicating one builds a real
            // pair, so the head is done.
            let Some(terminal) = state.players[0]
                .hand
                .iter()
                .find(|code| {
                    let first = code.chars().next();
                    let last = code.chars().last();
                    matches!(first, Some('1' | '9')) && matches!(last, Some('m' | 'p' | 's'))
                })
                .cloned()
            else {
                continue;
            };
            let answer = state.correct_action.tile().expect("answer").to_string();
            if !state.players[0].hand.iter().any(|code| code == &answer) {
                continue;
            }
            let Some(index) = state.players[0]
                .hand
                .iter()
                .position(|code| *code != answer && *code != terminal)
            else {
                continue;
            };
            state.players[0].hand[index] = terminal;
            assert!(
                pinfu_head(&state).is_none(),
                "a real pair means the head is already built"
            );
        }
    }

    #[test]
    fn a_mid_hand_state_is_not_the_opening_head_lesson() {
        let mut state = generate_puzzle("pinfu_head").expect("must generate");
        for tile in ["1z", "2z", "3z"] {
            state.players[0]
                .discards
                .push(crate::state::DiscardTile::new(tile));
        }
        assert!(pinfu_head(&state).is_none());
    }

    #[test]
    fn a_second_copy_of_the_value_honor_is_not_this_lesson() {
        let mut state = generate_puzzle("pinfu_head").expect("must generate");
        let answer = state.correct_action.tile().expect("answer").to_string();
        replace_spare(&mut state, &answer, &[answer.as_str()]);
        assert!(
            pinfu_head(&state).is_none(),
            "two copies of the value honor are a committed pair, not a lone tile"
        );
    }
}
