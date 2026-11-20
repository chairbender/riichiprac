//! The ch. 5.1 floating-sanshoku recogniser (`sanshoku_pursuit`).
//!
//! Riichi Book 1, ch. 5, "Floating":
//!
//! > 3 in this hand is essentially a redundant floating tile from a pure tile
//! > efficiency perspective; we do not need it to accept 4. However, if we keep
//! > it and discard North instead, we can hope to get sanshoku of 345. — ch5:62
//!
//! > If a hand has at least one dora or tanyao (All Simples), we should discard
//! > 3 to choose a side wait pinfu hand. Only when there is no other yaku or
//! > dora in a pinfu hand, it is OK to choose closed-wait sanshoku over
//! > side-wait pinfu. — ch5:74
//!
//! The drill is that gated choice on a tenpai hand with one extra tile:
//!
//! - discarding the floating tile `x` leaves `x+2, x+3` as a side wait (a
//!   ryanmen) and keeps the hand pinfu — the efficiency line;
//! - discarding `x+3` leaves `x, x+2` as a closed wait and completes sanshoku
//!   across the three suits — the chase line (ch5:110 forbids taking the chase
//!   if it steps the hand back to 2-away, and here both lines stay tenpai).
//!
//! The lamp that decides is the hand's other value, exactly as the generator
//! reads it through [`crate::generator::support::yaku`]: the visible dora plus
//! every yaku other than pinfu/sanshoku on any tenpai line. With none of either,
//! the book keeps the float and chases sanshoku; with any, it takes the side-wait
//! pinfu.
//!
//! The shape finder is the generator's own
//! ([`crate::generator::sanshoku_candidate_shapes`]), called without an answer,
//! so the construction and the recognition cannot drift. A state on which the
//! two teaching lines do not read as the book says (the chase line not sanshoku
//! on every winning tile, the efficiency line not pinfu, or a third tenpai line
//! that also reaches either teaching yaku) is refused: the drill would have two
//! correct answers.
//!
//! # Overlap
//!
//! The lesson is tenpai, so the ch. 3 shape lessons (1- and 2-away standard
//! hands) and the ch. 7 riichi/dama family read a different question. Its only
//! close neighbour is [`super::shape::ryanmen`], which also answers a tenpai
//! hand with a duplicate — but that lesson's answer is always the drawn tile,
//! while this one's is a tile that stays in the concealed hand (the generator
//! forbids the answer being the draw). `super::tests` pins the generated cells
//! disjoint.

use agari::tile::{Suit, Tile};
use agari::yaku::Yaku;

use crate::generator::ScenarioId;
use crate::generator::sanshoku_candidate_shapes;
use crate::generator::support::yaku::{discard_lines, dora_count, other_yaku};
use crate::state::{CorrectAction, GameState, TargetAction};

use super::support;
use super::{Allowed, Match, TransformPolicy};

/// Shorthand for a suited tile.
fn suited(suit: Suit, value: u8) -> Tile {
    Tile::Suited { suit, value }
}

/// Ch. 5.1 compares yaku and waits, and the gate reads the dora. Every
/// relabelling is recomputed, and a red five stays a dora: normalising one would
/// silently drop a han the book's "at least one dora" branch counts.
pub(crate) const POLICY: TransformPolicy = TransformPolicy {
    seat_perm: Allowed::AllowWithRecompute,
    suit_perm: Allowed::AllowWithRecompute,
    rank_mirror: Allowed::AllowWithRecompute,
    wind_relabel: Allowed::AllowWithRecompute,
    red5_normalize: Allowed::Deny,
    note: "the sanshoku/pinfu choice is a yaku and wait comparison, so every relabelling re-runs \
           it; a red five is a dora, and the gate turns on whether the hand has one at all",
};

/// Recognise the ch. 5.1 floating-sanshoku discard.
pub fn sanshoku_pursuit(state: &GameState) -> Option<Match> {
    let turn = support::turn(state)?;
    // A quiet-table hand-building question: a Riichi or an open hand on the
    // table makes the defense lesson the live one.
    if state
        .players
        .iter()
        .any(|player| player.is_riichi || !player.melds.is_empty())
    {
        return None;
    }
    // The lesson is a tenpai hand with an extra tile: both candidate discards
    // keep it tenpai.
    if turn.shanten != 0 {
        return None;
    }

    let shapes = sanshoku_candidate_shapes(&turn.hand);
    if shapes.is_empty() {
        return None;
    }

    let lines = discard_lines(
        &turn.hand,
        turn.round_wind,
        turn.human_wind,
        &turn.dora,
        turn.aka,
    );
    if lines.is_empty() {
        return None;
    }

    // Furiten makes the wait comparison dishonest: a winning tile already in
    // the actor's own river is exactly the state the miner rejects.
    for line in &lines {
        if line.waits().iter().any(|wait| turn.river.contains(wait)) {
            return None;
        }
    }

    // ch5:74's gate: at least one dora (including a red five) or any other
    // yaku on any line takes the side-wait pinfu; with neither, the book keeps
    // the float and chases sanshoku.
    let dora = dora_count(&turn.hand, &turn.dora) + turn.aka;
    let mut yaku_list = Vec::new();
    for line in &lines {
        for yaku in other_yaku(&line.wins) {
            if !yaku_list.contains(&yaku) {
                yaku_list.push(yaku);
            }
        }
    }
    let takes_side_wait = dora > 0 || !yaku_list.is_empty();

    let mut answer: Option<Tile> = None;
    let mut situation: Option<String> = None;
    for (suit, x) in shapes {
        let efficiency = suited(suit, x);
        let chase = suited(suit, x + 3);
        let efficiency_line = lines.iter().find(|line| line.discard == efficiency)?;
        let chase_line = lines.iter().find(|line| line.discard == chase)?;

        // The generator's proof, re-read from the table: the side-wait line is
        // pinfu on every winning tile and not sanshoku; the chase line is
        // sanshoku on every winning tile and keeps a closed wait.
        if !efficiency_line.all_have(Yaku::Pinfu) || efficiency_line.has(Yaku::SanshokuDoujun) {
            return None;
        }
        if !chase_line.all_have(Yaku::SanshokuDoujun) || chase_line.has(Yaku::Pinfu) {
            return None;
        }
        // A third tenpai discard that also reaches either teaching yaku would
        // give the drill a second correct answer.
        for line in &lines {
            if line.discard == efficiency || line.discard == chase {
                continue;
            }
            if line.has(Yaku::Pinfu) || line.has(Yaku::SanshokuDoujun) {
                return None;
            }
        }

        let named = if takes_side_wait { efficiency } else { chase };
        if let Some(previous) = answer
            && previous != named
        {
            // Two floating shapes that disagree about the discard: the table is
            // not one question.
            return None;
        }
        answer = Some(named);
        situation = Some(if takes_side_wait {
            "floating sanshoku: a dora or another yaku takes the side-wait pinfu".to_string()
        } else {
            "floating sanshoku: no other yaku or dora, keep the float and chase".to_string()
        });
    }
    let answer = answer?;

    Some(Match {
        lesson: ScenarioId::SanshokuPursuit,
        situation,
        target_action: TargetAction::NaniKiru,
        correct_action: CorrectAction::dama(answer.to_string()),
        equivalent_tiles: Vec::new(),
        riichi_triggers: Vec::new(),
        dama_reasons: Vec::new(),
        shouminkan_triggers: Vec::new(),
        scenario_note: None,
    })
}

/// True when the ch. 5.1 floating-sanshoku cell claims this table.
///
/// The ch. 7 family defers to it: a hand that holds an extra tile and two
/// teaching waits is the book's *wait-choice* question (ch5:62/74), not a
/// declaration question. The shape test is cheap, so the full recogniser only
/// runs on the hands that look like the lesson.
pub(crate) fn takes_wait_choice(turn: &super::support::Turn, state: &GameState) -> bool {
    if turn.shanten != 0 || sanshoku_candidate_shapes(&turn.hand).is_empty() {
        return false;
    }
    sanshoku_pursuit(state).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::generator::generate_puzzle;

    fn generated() -> GameState {
        generate_puzzle("sanshoku_pursuit").expect("sanshoku_pursuit must generate")
    }

    fn answer_tile(state: &GameState) -> Tile {
        Tile::try_from(
            state
                .correct_action
                .tile()
                .expect("the lesson answer names a tile"),
        )
        .expect("answer parses")
    }

    #[test]
    fn the_lesson_recognises_its_own_boards() {
        let mut chases = 0;
        let mut side_waits = 0;
        for run in 0..30 {
            let state = generated();
            let matched = sanshoku_pursuit(&state)
                .unwrap_or_else(|| panic!("run {run}: the lesson's own board must classify"));
            matched
                .validate(&state)
                .unwrap_or_else(|err| panic!("run {run}: illegal answer: {err}"));
            assert_eq!(matched.lesson, ScenarioId::SanshokuPursuit);
            assert_eq!(matched.target_action, TargetAction::NaniKiru);
            assert_eq!(
                matched.correct_action.tile(),
                Some(answer_tile(&state).to_string().as_str())
            );
            assert!(matched.equivalent_tiles.is_empty());

            // The gate decides: the answer is the chase discard only when the
            // hand has neither a dora nor another yaku.
            let turn = support::turn(&state).expect("a turn");
            let lines = discard_lines(
                &turn.hand,
                turn.round_wind,
                turn.human_wind,
                &turn.dora,
                turn.aka,
            );
            let mut yaku_list = Vec::new();
            for line in &lines {
                for yaku in other_yaku(&line.wins) {
                    if !yaku_list.contains(&yaku) {
                        yaku_list.push(yaku);
                    }
                }
            }
            let chase = dora_count(&turn.hand, &turn.dora) + turn.aka == 0 && yaku_list.is_empty();
            if chase {
                chases += 1;
            } else {
                side_waits += 1;
            }
        }
        assert!(chases > 0, "the drill must ask for the chase");
        assert!(side_waits > 0, "the drill must ask for the side wait");
    }

    #[test]
    fn a_breaking_the_floating_shape_is_not_the_lesson() {
        // Replace the floating tile with a copy of the run's middle: the
        // `x, x+2, x+3` shape is gone, so the hand is an ordinary tenpai.
        let mut broken = 0;
        for _ in 0..12 {
            let state = generated();
            let turn = support::turn(&state).expect("a turn");
            let Some((suit, x)) = sanshoku_candidate_shapes(&turn.hand).first().copied() else {
                continue;
            };
            let floating = suited(suit, x);
            let Some(index) = state.players[0]
                .hand
                .iter()
                .position(|code| code == &floating.to_string())
            else {
                continue;
            };
            let mut mutated = state.clone();
            mutated.players[0].hand[index] = suited(suit, x + 1).to_string();
            if sanshoku_pursuit(&mutated).is_none() {
                broken += 1;
            }
        }
        assert!(broken > 0, "the near-miss must be refused");
    }

    #[test]
    fn a_standard_riichi_hand_is_not_the_floating_lesson() {
        for _ in 0..6 {
            let state = generate_puzzle("riichi_judgement").expect("riichi must generate");
            assert!(sanshoku_pursuit(&state).is_none());
        }
    }

    #[test]
    fn a_14_tile_hand_with_no_floating_shape_is_refused() {
        // The ch. 7 bad-wait board is also tenpai, but without the three-suit
        // `x, x+2, x+3` shape there is nothing to chase.
        for _ in 0..6 {
            let state = generate_puzzle("dama_bad_wait").expect("the box must generate");
            assert!(sanshoku_pursuit(&state).is_none());
        }
    }
}
