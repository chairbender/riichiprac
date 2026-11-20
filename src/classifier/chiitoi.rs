//! The ch. 5.5 "chiitoitsu vs. toitoi" recogniser (`chiitoi_vs_toitoi`).
//!
//! Riichi Book 1, ch. 5, "How to get toitoi / chiitoitsu", *Toitoi vs.
//! chiitoitsu*: the hand is a 1-away chiitoitsu shape whose draw just turned one
//! of its pairs into a set, so the player stands at the crossroad between
//! dropping the third copy (staying with chiitoitsu) and keeping it (building to
//! toitoi). The book's box (ch5:608-613):
//!
//! > Choose chiitoitsu in the following situations.
//! > - There is a futile pair in your hand.
//! > - There is no pair of value tiles in your hand.
//! > - There are three or more pairs of simple tiles between 3 and 7 in your
//! >   hand.
//!
//! and its most important sentence (ch5:618): "If there is one or more futile
//! pair in your hand, you must stick with chiitoitsu. If not, you can go for
//! toitoi."
//!
//! The construction rule and the recognition rule are therefore the same read:
//!
//! - **futile pair** — a pair whose other two copies are already visible (both
//!   in the rivers, a river and a meld, …). The pair can never become a set, so
//!   toitoi is dead and the answer is the drawn third copy.
//! - **no value pair** — no pair of dragon, round-wind or seat-wind tiles, so the
//!   toitoi plan would be a cheap "toitoi-only" hand (ch5:621). Stay with
//!   chiitoitsu, again by discarding the drawn third copy.
//! - **three or more 3–7 simple pairs** — the book's third condition: those
//!   tiles' high versatility often stops the hand's advancement (ch5:633).
//!   Chiitoitsu.
//! - otherwise — keep the set and discard a lone tile; the three lone tiles are
//!   interchangeable, so all three are graded as the same answer.
//!
//! The shape itself is the generator's, read from the fourteen displayed tiles:
//! four pairs, the drawn triplet and three lone tiles. It is a 1-away hand, so
//! the ch. 7 riichi/dama and ch. 8 defense families (tenpai or slower hands) do
//! not read it.
//!
//! The lesson's only overlap is [`super::honitsu`]: a 1-away hand can satisfy
//! both the ch. 5.4 flush plan and this pair shape, so `honitsu_decision`
//! defers to this recogniser and keeps the flush label on a crossroad-shaped
//! hand this lesson refuses. [`super::shape`] is the nearest *shape* family, but
//! those lessons compare acceptance on 1- and 2-away standard hands, and the
//! ch. 5.5 shape (four pairs plus a completed set plus three singles) is not one
//! of their cells — the generated states are checked disjoint by
//! `super::tests`.

use agari::parse::to_counts;
use agari::shanten::{ShantenType, calculate_shanten};
use agari::tile::Tile;

use crate::generator::ScenarioId;
use crate::generator::honitsu_decision::value::is_fanpai;
use crate::state::{CorrectAction, GameState, TargetAction};

use super::support::{self, Turn};
use super::{Allowed, Match, TransformPolicy};

/// The ch. 5.5 cell is a pair-count, visibility and value-tile rule. Seat and
/// wind relabelling change which honour pairs are *value* pairs
/// (`is_fanpai`), and suit/rank relabelling moves the visible pairs, so the
/// label is recomputed after every transform. A red five is an ordinary tile
/// for this rule (no score is read), so normalising it only re-runs the read.
pub(crate) const POLICY: TransformPolicy = TransformPolicy {
    seat_perm: Allowed::AllowWithRecompute,
    suit_perm: Allowed::AllowWithRecompute,
    rank_mirror: Allowed::AllowWithRecompute,
    wind_relabel: Allowed::AllowWithRecompute,
    red5_normalize: Allowed::AllowWithRecompute,
    note: "the chiitoitsu/toitoi choice is read from the pair counts, the visible copies and \
           whether a pair is fanpai, so every relabelling re-runs the same read; a red five is \
           just a five here because the lesson never reads the hand's value",
};

/// The 1-away chiitoitsu shape: four pairs, the drawn triplet, three lone tiles.
struct Shape {
    /// The four pair kinds (exactly two copies each).
    pairs: Vec<Tile>,
    /// The kind the hand holds three copies of (the pair the draw completed).
    triplet: Tile,
    /// The three lone kinds (exactly one copy each).
    singles: Vec<Tile>,
}

/// Recognise the ch. 5.5 chiitoitsu/toitoi crossroad.
pub fn chiitoi_vs_toitoi(state: &GameState) -> Option<Match> {
    let turn = support::turn(state)?;
    // A quiet-table hand-building question: a Riichi or an open hand on the
    // table makes the defense lesson the live one (the ch. 3 shape family uses
    // the same guard).
    if state
        .players
        .iter()
        .any(|player| player.is_riichi || !player.melds.is_empty())
    {
        return None;
    }
    let shape = shape(&turn.hand)?;
    // The draw is the pair that became a set, exactly as the generator builds
    // it: without that fact the hand is an ordinary 1-away shape, not this
    // crossroad.
    if turn.draw != shape.triplet {
        return None;
    }

    let counts = to_counts(&turn.hand);
    let shanten = calculate_shanten(&counts);
    if shanten.shanten != 1 || shanten.best_type != ShantenType::Chiitoitsu {
        return None;
    }

    let futile = futile_pair(&turn, &shape);
    if futile {
        // ch5:618: a dead pair means toitoi is impossible.
        return Some(chiitoitsu_match(
            &shape,
            "futile pair: the pair can never become a set",
        ));
    }

    let value_pair = shape
        .pairs
        .iter()
        .any(|pair| is_fanpai(*pair, turn.round_wind, turn.human_wind));
    let middle_simple_pairs = shape
        .pairs
        .iter()
        .filter(|pair| matches!(pair.value(), Some(3..=7)))
        .count();
    if !value_pair || middle_simple_pairs >= 3 {
        // ch5:611-613: the book's second and third chiitoitsu conditions.
        return Some(chiitoitsu_match(
            &shape,
            "no value pair or three 3-7 simple pairs: toitoi stays cheap",
        ));
    }

    // ch5:618: without a chiitoitsu reason, the set is worth keeping.
    Some(toitoi_match(&shape))
}

/// Read the generator's 14-tile shape: four pairs, one triplet, three singles.
fn shape(hand: &[Tile]) -> Option<Shape> {
    let counts = to_counts(hand);
    if counts.len() != 8 {
        return None;
    }
    let mut pairs = Vec::new();
    let mut triplets = Vec::new();
    let mut singles = Vec::new();
    for (tile, count) in counts {
        match count {
            1 => singles.push(tile),
            2 => pairs.push(tile),
            3 => triplets.push(tile),
            _ => return None,
        }
    }
    if pairs.len() != 4 || triplets.len() != 1 || singles.len() != 3 {
        return None;
    }
    pairs.sort();
    singles.sort();
    Some(Shape {
        pairs,
        triplet: triplets[0],
        singles,
    })
}

/// True for the book's first chiitoitsu condition: a pair whose other two
/// copies are already visible, so it can never become a set.
///
/// The hand itself shows the pair's two copies; [`Turn::visible`] adds every
/// river, meld and dora indicator the player can see.
fn futile_pair(turn: &Turn, shape: &Shape) -> bool {
    shape.pairs.iter().any(|pair| {
        // Two copies are in the hand; two more make the fourth visible copy.
        turn.visible.get(pair).copied().unwrap_or(0) >= 2
    })
}

/// The chiitoitsu answer: drop the drawn third copy and restore five pairs.
fn chiitoitsu_match(shape: &Shape, situation: &str) -> Match {
    Match {
        lesson: ScenarioId::ChiitoiVsToitoi,
        situation: Some(situation.to_string()),
        target_action: TargetAction::NaniKiru,
        correct_action: CorrectAction::dama(shape.triplet.to_string()),
        equivalent_tiles: Vec::new(),
        riichi_triggers: Vec::new(),
        dama_reasons: Vec::new(),
        shouminkan_triggers: Vec::new(),
        scenario_note: None,
    }
}

/// The toitoi answer: keep the set and drop any lone tile.
///
/// The three lone tiles are interchangeable (the head is still a pair, the
/// fourth block is still a pair), so the other two are graded as the same
/// answer, exactly as the generator records them (ch5:603).
fn toitoi_match(shape: &Shape) -> Match {
    let mut singles = shape.singles.clone();
    let answer = singles.remove(0);
    Match {
        lesson: ScenarioId::ChiitoiVsToitoi,
        situation: Some("no futile pair, a value pair and few 3-7 pairs: keep the set".to_string()),
        target_action: TargetAction::NaniKiru,
        correct_action: CorrectAction::dama(answer.to_string()),
        equivalent_tiles: singles.iter().map(ToString::to_string).collect(),
        riichi_triggers: Vec::new(),
        dama_reasons: Vec::new(),
        shouminkan_triggers: Vec::new(),
        scenario_note: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::generator::generate_puzzle;

    fn generated() -> GameState {
        generate_puzzle("chiitoi_vs_toitoi").expect("chiitoi_vs_toitoi must generate")
    }

    fn answer_tile(state: &GameState) -> Tile {
        Tile::try_from(
            state
                .correct_action
                .tile()
                .expect("the lesson answer names a tile"),
        )
        .expect("answer must parse")
    }

    /// The state's own accepted set, sorted.
    fn state_answer_set(state: &GameState) -> Vec<String> {
        let mut tiles = state.equivalent_tiles.clone();
        tiles.push(answer_tile(state).to_string());
        tiles.sort();
        tiles.dedup();
        tiles
    }

    #[test]
    fn the_lesson_recognises_its_own_boards() {
        let mut chiitoitsu = 0;
        let mut toitoi = 0;
        for run in 0..40 {
            let state = generated();
            let matched = chiitoi_vs_toitoi(&state)
                .unwrap_or_else(|| panic!("run {run}: the lesson's own board must classify"));
            matched
                .validate(&state)
                .unwrap_or_else(|err| panic!("run {run}: illegal answer: {err}"));
            assert_eq!(matched.lesson, ScenarioId::ChiitoiVsToitoi);
            assert_eq!(matched.target_action, TargetAction::NaniKiru);
            assert_eq!(matched.answer_set(), state_answer_set(&state), "run {run}");

            if matched.answer_set().len() == 1 {
                chiitoitsu += 1;
            } else {
                toitoi += 1;
            }
        }
        assert!(chiitoitsu > 0, "the drill must ask for chiitoitsu");
        assert!(toitoi > 0, "the drill must ask for toitoi");
    }

    #[test]
    fn a_six_pair_tenpai_is_not_this_crossroad() {
        // The chiitoitsu Riichi/dama lesson is a six-pair tenpai: the shape is
        // one pair ahead of this lesson's four pairs plus a set.
        for _ in 0..8 {
            let state = generate_puzzle("chiitoitsu_riichi_vs_dama")
                .expect("chiitoitsu_riichi_vs_dama must generate");
            assert!(chiitoi_vs_toitoi(&state).is_none());
        }
    }

    #[test]
    fn a_three_pair_block_theory_board_is_not_this_crossroad() {
        // The ch. 3 pair-count lesson is also a multi-pair hand, but it is a
        // 2-away standard hand with three pairs, not the four-pairs-plus-set
        // chiitoitsu crossroad.
        for _ in 0..6 {
            let state = generate_puzzle("pair_count").expect("pair_count must generate");
            assert!(chiitoi_vs_toitoi(&state).is_none());
        }
    }

    #[test]
    fn a_draw_that_does_not_complete_a_set_is_not_the_lesson() {
        let state = generated();
        let answered = Tile::try_from(
            state
                .correct_action
                .tile()
                .expect("the lesson answer names a tile"),
        )
        .expect("answer parses");
        // Replace the draw with a tile the hand does not hold: the drawn hand
        // is then four pairs, a two-tile pair and four lone tiles, so no pair
        // became a set and the crossroad is not on the table.
        let unused = ["1z", "2z", "3z", "4z", "5z", "6z", "7z"]
            .into_iter()
            .map(|code| Tile::try_from(code).expect("honor parses"))
            .find(|tile| !state.tiles.iter().any(|code| *code == tile.to_string()))
            .expect("an unused honor");
        let mut broken = state.clone();
        broken.players[0].draw = Some(unused.to_string());
        assert!(chiitoi_vs_toitoi(&broken).is_none());
        let _ = answered;
    }
}
