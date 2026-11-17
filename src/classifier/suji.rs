//! The ch. 8 immediate suji-trap declaration (`suji_trap_riichi`).
//!
//! Riichi Book 1, ch. 8, "Suji trap":
//!
//! > When you wait for a tile that is a suji tile of some tiles you have
//! > discarded yourself, we say you have a suji-trap wait. In particular, when
//! > your wait is a suji tile of the riichi declaration tile, we say it is an
//! > immediate suji-trap wait. — ch8:165
//!
//! and ch. 7 turns it into a reason to declare:
//!
//! > The third factor you may want to consider is whether your wait would
//! > appear safe in the eyes of your opponents. [...] This is called a
//! > suji-trap wait. — ch7:512
//!
//! The lesson's cell is narrow on purpose. The trap discard leaves the ch7:521
//! bad-wait box's **dama** cell (a 1-2 live simple wait, riichi-only,
//! non-dealer), which would otherwise keep the hand concealed. The hand then has
//! at least two discards that reach tenpai on that same wait: one is a suji of
//! the wait (the immediate trap) and one is not. The trap is the difference
//! between the answers, so the drill asks which discard to declare on.
//!
//! The recogniser therefore:
//!
//! - requires every tenpai candidate to leave the **same** winning tiles (the
//!   choice must be about the declaration tile, not acceptance);
//! - requires the trap candidate(s) to be the bad-wait box's dama cell, with the
//!   trap as the only reason to declare;
//! - requires at least one plain candidate of the same wait;
//! - answers Riichi on the trap candidate(s), and never on a plain discard.
//!
//! A plain discard may leave a hand with an *extra han* (a different 13-tile
//! hand can score), which is exactly why it is not the drill's answer: the
//! trap's own hand must be riichi-only for the trap to be what changes the
//! decision.
//!
//! [`crate::classifier::riichi::dama_bad_wait`] defers to this cell, so the box
//! cannot also label the same state dama.

use agari::tile::Tile;

use crate::generator::ScenarioId;
use crate::generator::dama_bad_wait::judgement as bad_wait;
use crate::generator::support::tiles::suji_tiles;
use crate::state::{CorrectAction, GameState, RiichiTrigger, TargetAction};

use super::support::{self, Candidate, Kept};
use super::{Allowed, Match, TransformPolicy};

/// The trap is shape- and seat-symmetric once the label is recomputed. Red-five
/// normalisation is a value change (the hand must stay riichi-only), so it goes
/// through the recompute gate too.
pub(crate) const POLICY: TransformPolicy = TransformPolicy {
    seat_perm: Allowed::AllowWithRecompute,
    suit_perm: Allowed::AllowWithRecompute,
    rank_mirror: Allowed::AllowWithRecompute,
    wind_relabel: Allowed::AllowWithRecompute,
    red5_normalize: Allowed::AllowWithRecompute,
    note: "the immediate trap is a suji relation between two ranks, so every transform re-runs \
           the same rule; a red five must be recomputed because the hand has to stay riichi-only \
           for the trap to be the only reason to declare.",
};

/// Recognise the immediate suji-trap declaration.
pub fn suji_trap_riichi(state: &GameState) -> Option<Match> {
    let turn = support::turn(state)?;
    let candidates = support::candidates(&turn)?;
    trap_cell(state, &candidates)
}

/// The trap cell for an already-read candidate set, shared with the bad-wait
/// box so the two labels can never both apply.
pub(crate) fn trap_cell(state: &GameState, candidates: &[Candidate]) -> Option<Match> {
    // The lesson's choice is the declaration tile alone: every candidate must
    // leave the same winning tiles, exactly as the generator builds them. A
    // state where the plain discard keeps a different wait is an acceptance
    // decision, not the trap question.
    let waits = &candidates.first()?.kept.waits;
    let mut traps: Vec<&Candidate> = Vec::new();
    let mut plains: Vec<&Candidate> = Vec::new();
    for candidate in candidates {
        let kept = &candidate.kept;
        if &kept.waits != waits || !kept.is_standard() || !kept.is_live() {
            return None;
        }
        if is_immediate_trap(candidate.discard, kept) {
            let live = kept.quality.live_tiles;
            // The trap's own hand is the bad-wait box's dama cell: a 1-2 live
            // simple wait with none of the general rule's conditions. That is
            // what makes the trap, rather than value or wait, the reason to
            // declare.
            if live > 2 || bad_wait::verdict(&kept.waits, live).picks_riichi() {
                return None;
            }
            if kept.conditions.picks_riichi() {
                return None;
            }
            traps.push(candidate);
        } else {
            // A plain discard of the same wait: the contrast that makes the
            // declaration tile the lesson. It may carry extra han of its own.
            plains.push(candidate);
        }
    }
    // Without a plain discard of the same wait the drill has no choice to ask
    // about, and without a trap discard there is nothing to declare on.
    if traps.is_empty() || plains.is_empty() {
        return None;
    }
    if !state.players[0].is_human || state.players[0].score < 1_000 || state.tiles_remaining < 4 {
        return None;
    }
    if state.players[0].is_riichi {
        return None;
    }

    let answer = traps[0].discard;
    let mut equivalents: Vec<String> = traps[1..]
        .iter()
        .map(|candidate| candidate.discard.to_string())
        .collect();
    equivalents.sort();

    let live = traps[0].kept.quality.live_tiles;
    Some(Match {
        lesson: ScenarioId::SujiTrapRiichi,
        situation: Some(format!("immediate suji trap, {live} live winning tiles")),
        target_action: TargetAction::Riichi,
        correct_action: CorrectAction::riichi(answer.to_string()),
        equivalent_tiles: equivalents,
        riichi_triggers: vec![RiichiTrigger::ImmediateSujiTrap],
        dama_reasons: Vec::new(),
        shouminkan_triggers: Vec::new(),
        scenario_note: None,
    })
}

/// True when one of `kept`'s winning tiles is three ranks from `discard`.
fn is_immediate_trap(discard: Tile, kept: &Kept) -> bool {
    let suji = suji_tiles(discard);
    kept.waits.iter().any(|wait| suji.contains(wait))
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::generator::generate_puzzle;

    #[test]
    fn the_trap_recognises_its_own_lesson() {
        for run in 0..12 {
            let state = generate_puzzle("suji_trap_riichi")
                .unwrap_or_else(|err| panic!("run {run}: {err}"));
            let matched = suji_trap_riichi(&state).unwrap_or_else(|| panic!("run {run}: no match"));
            matched
                .validate(&state)
                .unwrap_or_else(|err| panic!("run {run}: illegal answer: {err}"));
            assert_eq!(matched.lesson, ScenarioId::SujiTrapRiichi);
            assert_eq!(matched.target_action, TargetAction::Riichi);
            assert_eq!(
                matched.correct_action.tile(),
                state.correct_action.tile(),
                "run {run}: the trap discard is the answer"
            );
            assert_eq!(
                matched.riichi_triggers,
                vec![RiichiTrigger::ImmediateSujiTrap]
            );
            assert!(matched.dama_reasons.is_empty());
            assert!(
                matched
                    .situation
                    .as_deref()
                    .is_some_and(|situation| situation.contains("immediate suji trap"))
            );
        }
    }

    #[test]
    fn a_hand_without_a_trap_discard_is_not_this_lesson() {
        // Make the trap discard and the plain discard identical in trap terms
        // by removing the alternative: a hand with only trap discards has no
        // contrast and must be refused.
        for _ in 0..8 {
            let state = generate_puzzle("suji_trap_riichi").expect("must generate");
            let turn = support::turn(&state).expect("a turn");
            let candidates = support::candidates(&turn).expect("candidates");
            let traps: Vec<Candidate> = candidates
                .into_iter()
                .filter(|candidate| {
                    candidate
                        .kept
                        .waits
                        .iter()
                        .any(|wait| suji_tiles(candidate.discard).contains(wait))
                })
                .collect();
            assert_eq!(traps.len(), 1, "the lesson has one trap discard");
            assert!(
                trap_cell(&state, &traps).is_none(),
                "a single trap discard with no plain alternative is not the drill"
            );
        }
    }

    #[test]
    fn a_good_wait_is_not_the_bad_wait_trap_cell() {
        // The trap cell is the bad-wait box's dama case; a 3+ live good wait is
        // a different ch7 cell even when its discard happens to be a suji.
        let state = generate_puzzle("riichi_judgement").expect("must generate");
        assert!(suji_trap_riichi(&state).is_none());
    }

    #[test]
    fn the_bad_wait_box_defers_to_the_trap() {
        for _ in 0..8 {
            let state = generate_puzzle("suji_trap_riichi").expect("must generate");
            assert!(
                super::super::classify(&state, ScenarioId::DamaBadWait).is_none(),
                "dama_bad_wait must not label the trap state dama"
            );
        }
    }

    #[test]
    fn a_non_tenpai_hand_has_no_trap_declaration() {
        let state = generate_puzzle("pinfu_head").expect("must generate");
        assert!(suji_trap_riichi(&state).is_none());
    }
}
