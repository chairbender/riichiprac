//! The ch. 5.4 honitsu decision (`honitsu_decision`).
//!
//! Riichi Book 1, ch. 5.4, "How to get honitsu", "Conditions to go for
//! honitsu":
//!
//! > When judging whether to go for honitsu or not, we should consider two
//! > factors --- five-block potential and hand values with and without
//! > honitsu. — ch5:468
//!
//! and its two "do not go" boxes:
//!
//! > In such situations, you should not aim for honitsu; you should try to make
//! > the hand ready without melding and go for riichi. — ch5:506
//! >
//! > At the same time, when the hand value is sufficiently high (>= 5200)
//! > *without* honitsu, you should not go for honitsu at the cost of tile
//! > efficiency. — ch5:517
//!
//! Every generated hand has the same five-block picture in the target suit
//! plus honors, so the block count alone never decides; the values do. The
//! recogniser re-derives both factors from the fourteen tiles, exactly as the
//! generator's `facts` does:
//!
//! - **commit** when the honitsu plan is worth at least 5200 and the same tiles
//!   played straight cannot reach it (the book's Honitsu 1). The answer starts
//!   on the redundant off-suit group, so every distinct off-suit tile is an
//!   accepted answer.
//! - **already high** when the straight hand is worth at least 5200 with the
//!   inefficient in-suit floating tile thrown (the book's Honitsu 3): keep the
//!   off-suit block and throw the in-suit floater.
//! - **honitsu only** when the plan's only yaku would be honitsu itself, the
//!   "very cheap (2000 or 2600 points)" hand (the book's Honitsu 2): throw the
//!   valueless honor floater and keep the blocks.
//!
//! A honitsu decision is a mid-hand plan question, not a riichi/dama
//! declaration. The recogniser refuses an opening hand and a hand with a
//! discard into tenpai, so the ch. 7 family's cells and this one stay disjoint.
//! It also refuses the ch. 5.5 chiitoitsu/toitoi shape (four pairs, a completed
//! set and three lone tiles): that hand's question is the pair-count crossroad
//! ([`super::chiitoi`]), and the flush plan is not what it asks.

use agari::tile::Tile;

use crate::generator::ScenarioId;
use crate::generator::honitsu_decision::honitsu_suit;
use crate::generator::honitsu_decision::value::{
    Reading, blocks_and_floaters, honitsu_reading, is_fanpai,
};
use crate::generator::support::value::worst_completion_value;
use crate::state::{CorrectAction, GameState, TargetAction};

use super::support::{self, Turn};
use super::{Allowed, Match, TransformPolicy};

/// The book's "sufficiently high" floor without honitsu (ch5:517).
const HIGH_VALUE_FLOOR: u32 = 5_200;

/// Suit permutation preserves the one-suit property, so the label is recomputed
/// after any relabelling. Red-five normalisation changes the hand's value
/// against the 5200 floors, so it is recompute-gated too.
pub(crate) const POLICY: TransformPolicy = TransformPolicy {
    seat_perm: Allowed::AllowWithRecompute,
    suit_perm: Allowed::AllowWithRecompute,
    rank_mirror: Allowed::AllowWithRecompute,
    wind_relabel: Allowed::AllowWithRecompute,
    red5_normalize: Allowed::AllowWithRecompute,
    note: "honitsu's two factors (five-block potential and value with/without honitsu) are \
           recomputed from the tiles, so every relabelling re-runs the decision; a red five is \
           worth a han and can move a hand across the 5200 floor.",
};

/// Which book cell the hand is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Cell {
    Commit,
    AlreadyHigh,
    HonitsuOnly,
}

/// One table read for the honitsu decision.
struct HonitsuView {
    turn: Turn,
    reading: Option<Reading>,
    /// In-suit leftover tiles: the plan's floating block candidates.
    suited_floaters: Vec<Tile>,
    /// Valueless-wind leftovers.
    valueless_honor_floaters: Vec<Tile>,
    /// Distinct off-suit hand tiles: the tiles the flush makes redundant.
    off_suit: Vec<Tile>,
}

impl HonitsuView {
    /// The worst ron value of the same tiles with `tile` discarded.
    fn straight_value(&self, tile: Tile, aka: u8) -> Option<u32> {
        let mut rest = self.turn.hand.clone();
        let index = rest.iter().position(|held| *held == tile)?;
        rest.remove(index);
        worst_completion_value(
            &rest,
            self.turn.round_wind,
            self.turn.human_wind,
            &self.turn.dora,
            aka,
        )
        .map(|value| value.points)
    }
}

/// Recognise the ch. 5.4 honitsu decision.
pub fn honitsu_decision(state: &GameState) -> Option<Match> {
    let turn = support::turn(state)?;
    if turn.turn < 2 {
        return None;
    }
    if !(1..=2).contains(&turn.shanten) {
        return None;
    }
    // The ch. 5.5 crossroad owns the hands it recognises (four pairs, a
    // completed set and three lone tiles): that hand's question is the
    // pair-count rule, not the flush plan, and the two lessons would otherwise
    // read the same table differently.
    if super::chiitoi::chiitoi_vs_toitoi(state).is_some() {
        return None;
    }
    // A discard into tenpai is the ch7 riichi/dama question, not this plan
    // decision; the lesson's own boards keep the Riichi toggle off.
    if support::candidates(&turn).is_some() {
        return None;
    }
    // The plan is a quiet mid-hand question: any call or Riichi on the table
    // makes a defense/riichi lesson the live one, and an open hand changes the
    // flush plan itself.
    if state
        .players
        .iter()
        .any(|player| player.is_riichi || !player.melds.is_empty())
    {
        return None;
    }

    let suit = honitsu_suit(&turn.hand)?;
    let group: Vec<Tile> = turn
        .hand
        .iter()
        .copied()
        .filter(|tile| tile.suit().is_none_or(|tile_suit| tile_suit == suit))
        .collect();
    let blocks = blocks_and_floaters(&group);
    if !blocks.has_five_block_potential() {
        return None;
    }
    // The plan's completion is `None` when the group cannot be finished into a
    // honitsu hand (the book's Honitsu 3 branch); the already-high cell is then
    // decided entirely by the straight hand's value.
    let reading = honitsu_reading(
        &group,
        suit,
        turn.round_wind,
        turn.human_wind,
        &turn.dora,
        turn.aka,
    );

    let suited_floaters: Vec<Tile> = blocks
        .floaters
        .iter()
        .copied()
        .filter(|tile| tile.suit() == Some(suit))
        .collect();
    let valueless_honor_floaters: Vec<Tile> = blocks
        .floaters
        .iter()
        .copied()
        .filter(|tile| {
            matches!(tile, Tile::Honor(_)) && !is_fanpai(*tile, turn.round_wind, turn.human_wind)
        })
        .collect();
    let off_suit: Vec<Tile> = support::distinct(&turn.hand)
        .into_iter()
        .filter(|tile| tile.suit().is_some_and(|tile_suit| tile_suit != suit))
        .collect();

    let view = HonitsuView {
        turn,
        reading,
        suited_floaters,
        valueless_honor_floaters,
        off_suit,
    };
    let (cell, answer, equivalents) = decide(&view)?;

    let situation = match cell {
        Cell::Commit => {
            "five blocks and a honitsu plan worth at least 5200; the same tiles have no straight \
             yaku"
                .to_string()
        }
        Cell::AlreadyHigh => {
            "the hand is already worth at least 5200 without honitsu, so keep the off-suit block \
             and tile efficiency"
                .to_string()
        }
        Cell::HonitsuOnly => {
            "the honitsu plan would be honitsu-only and cheap, so keep the off-suit blocks and \
             play for efficiency"
                .to_string()
        }
    };

    Some(Match {
        lesson: ScenarioId::HonitsuDecision,
        situation: Some(situation),
        target_action: TargetAction::NaniKiru,
        correct_action: CorrectAction::dama(answer.to_string()),
        equivalent_tiles: equivalents,
        riichi_triggers: Vec::new(),
        dama_reasons: Vec::new(),
        shouminkan_triggers: Vec::new(),
        scenario_note: None,
    })
}

/// The book cell and its answer, or `None` when the factors do not decide.
fn decide(view: &HonitsuView) -> Option<(Cell, Tile, Vec<String>)> {
    let cheap = view.reading.as_ref().is_some_and(Reading::is_honitsu_only);
    if cheap {
        // ch5:506: a honitsu-only plan is "very cheap". Throw the valueless
        // honor that was the fifth block candidate.
        let [answer] = view.valueless_honor_floaters.as_slice() else {
            return None;
        };
        if view
            .straight_value(*answer, view.turn.aka)
            .is_some_and(|points| points >= HIGH_VALUE_FLOOR)
        {
            // Then the "already sufficiently high" box should decide, not this
            // one; the two cells must not both apply.
            return None;
        }
        return Some((Cell::HonitsuOnly, *answer, Vec::new()));
    }

    // ch5:517: with >= 5200 without honitsu, efficiency wins. The in-suit
    // floater is the inefficient tile; the off-suit block is kept.
    if view.suited_floaters.len() == 1 {
        let floater = view.suited_floaters[0];
        if view
            .straight_value(floater, view.turn.aka)
            .is_some_and(|points| points >= HIGH_VALUE_FLOOR)
        {
            return Some((Cell::AlreadyHigh, floater, Vec::new()));
        }
    }

    // ch5:468/492: go for honitsu when the plan is worth more than the same
    // tiles straight. The redundant off-suit group is the multi-turn discard
    // plan, so every off-suit tile is an accepted answer.
    let reading = view.reading.as_ref()?;
    if reading.value.points < HIGH_VALUE_FLOOR {
        return None;
    }
    if view.off_suit.is_empty() {
        return None;
    }
    let straight_already_high = view.off_suit.iter().any(|tile| {
        view.straight_value(*tile, view.turn.aka)
            .is_some_and(|points| points >= HIGH_VALUE_FLOOR)
    });
    if straight_already_high {
        return None;
    }
    let mut answers = view.off_suit.clone();
    answers.sort();
    let answer = answers[0];
    let equivalents = answers[1..].iter().map(ToString::to_string).collect();
    Some((Cell::Commit, answer, equivalents))
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::generator::generate_puzzle;
    use crate::generator::honitsu_decision::{Variant, generate_with_target};

    fn generated(category: &str) -> GameState {
        generate_puzzle(category).unwrap_or_else(|err| panic!("{category}: {err}"))
    }

    fn assert_own_lesson(state: &GameState) {
        let matched = honitsu_decision(state).expect("the lesson must match");
        matched
            .validate(state)
            .unwrap_or_else(|err| panic!("illegal answer: {err}"));
        assert_eq!(matched.lesson, ScenarioId::HonitsuDecision);
        assert_eq!(matched.target_action, TargetAction::NaniKiru);
        let mut expected = state.equivalent_tiles.clone();
        expected.push(
            state
                .correct_action
                .tile()
                .expect("the answer names a tile")
                .to_string(),
        );
        expected.sort();
        expected.dedup();
        assert_eq!(matched.answer_set(), expected);
    }

    #[test]
    fn every_branch_recognises_its_own_lesson() {
        for variant in [Variant::Commit, Variant::AlreadyHigh, Variant::HonitsuOnly] {
            for run in 0..6 {
                let state = generate_with_target("honitsu_decision", variant)
                    .unwrap_or_else(|err| panic!("{variant:?} run {run}: {err}"));
                assert_own_lesson(&state);
            }
        }
    }

    #[test]
    fn the_unpinned_entry_point_recognises_every_branch() {
        let mut cells = Vec::new();
        for _ in 0..30 {
            let state = generated("honitsu_decision");
            let matched = honitsu_decision(&state).expect("a honitsu board must match");
            matched.validate(&state).expect("the answer must be legal");
            cells.push(matched.situation.clone().unwrap_or_default());
        }
        assert!(cells.iter().any(|cell| cell.contains("five blocks")));
        assert!(cells.iter().any(|cell| cell.contains("already worth")));
        assert!(cells.iter().any(|cell| cell.contains("honitsu-only")));
    }

    #[test]
    fn a_first_turn_hand_is_not_the_mid_hand_decision() {
        let mut state = generated("honitsu_decision");
        state.players[0].discards.clear();
        assert!(honitsu_decision(&state).is_none());
    }

    #[test]
    fn a_tenpai_discard_makes_it_the_ch7_question_instead() {
        // A hand with a discard into tenpai is a riichi/dama decision; the
        // honitsu plan lesson refuses it.
        let state = generated("riichi_judgement");
        assert!(honitsu_decision(&state).is_none());
    }

    #[test]
    fn the_commit_branch_accepts_every_off_suit_tile() {
        for _ in 0..6 {
            let state =
                generate_with_target("honitsu_decision", Variant::Commit).expect("must generate");
            let matched = honitsu_decision(&state).expect("the commit cell");
            let suit =
                honitsu_suit(&support::turn(&state).expect("a turn").hand).expect("a honitsu suit");
            let off_suit: Vec<String> = state
                .tiles
                .iter()
                .filter(|code| {
                    Tile::try_from(code.as_str())
                        .ok()
                        .and_then(|tile| tile.suit())
                        .is_some_and(|tile_suit| tile_suit != suit)
                })
                .cloned()
                .collect();
            let mut expected = off_suit;
            expected.sort();
            expected.dedup();
            assert_eq!(matched.answer_set(), expected);
        }
    }
}
