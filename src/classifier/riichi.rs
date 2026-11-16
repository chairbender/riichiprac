//! The ch. 7 Riichi/dama recognisers: `riichi_judgement` and the four `dama_*`
//! lessons.
//!
//! Every lesson in this family asks the same structural question — the human
//! holds a closed 14-tile hand whose one tenpai discard is the answer to
//! "declare Riichi or stay in dama?" — and differs only in which ch. 7 cell
//! decides. The recognisers therefore share one tenpai reading
//! ([`super::support`]) and one unanimity rule: every discard that leaves the
//! hand tenpai must land in the same cell, or the state is not this lesson's
//! question.
//!
//! The book cells, as the generators encode them:
//!
//! - [`super::ScenarioId::RiichiJudgement`] — the general three-condition rule
//!   (ch7:55-59): riichi if at least one of extra han, good wait, dealer holds;
//!   otherwise dama (ch7:71). The 1-2 live-tile cells belong to the later
//!   bad-wait box, so they are left to [`super::ScenarioId::DamaBadWait`].
//! - [`super::ScenarioId::DamaBadWait`] — the ch7:521 box: 3+ live winning tiles
//!   call riichi; 1-2 live simple tiles stay dama; 1-2 live honor/terminal tiles
//!   may call riichi.
//! - [`super::ScenarioId::DamaGenbutsuWait`] — ch7:539: dama when one winning
//!   tile is the genbutsu of the player drawing all the attention.
//! - [`super::ScenarioId::DamaExpensiveHand`] — ch7:569/598/646: dama when the
//!   worst ron value without riichi is 7700, and never riichi at haneman.
//! - [`super::ScenarioId::DamaImprovingHand`] — ch7:656-660: dama on an early
//!   turn when six kinds (or one three-han step) improve the ready hand.
//!
//! The dama exceptions that the book leaves to board reading (in the lead,
//! cheap/expensive waits, trap waits) are **not** modelled: a classifier that
//! cannot read the exception returns `None` rather than claiming dama.
//!
//! See the module-level note in [`super`] on the known conflict between
//! `riichi_judgement`'s dama cell and `dama_bad_wait`'s 3+ live cell.

use agari::tile::Tile;

use crate::generator::ScenarioId;
use crate::generator::dama_bad_wait::judgement as bad_wait;
use crate::generator::dama_expensive_hand::judgement as expensive;
use crate::generator::dama_genbutsu_wait::judgement as genbutsu;
use crate::generator::dama_improving_hand::improvement;
use crate::safety::SafetyFacts;
use crate::state::{CorrectAction, DamaReason, GameState, RiichiTrigger, TargetAction};

use super::support::{self, Candidate, Kept, Turn};
use super::{Allowed, Match, TransformPolicy};

/// The declaration a riichi/dama cell picks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Declaration {
    Riichi,
    Dama,
}

/// ch. 7 labels survive suit/rank/wind/seat relabelling once the label is
/// recomputed; red-five normalisation changes the hand's value (ch7:569's 7700
/// is a red-five rule), so it stays denied (`replay-implementation-plan` §4.5).
pub(crate) const DAMA_POLICY: TransformPolicy = TransformPolicy {
    seat_perm: Allowed::AllowWithRecompute,
    suit_perm: Allowed::AllowWithRecompute,
    rank_mirror: Allowed::AllowWithRecompute,
    wind_relabel: Allowed::AllowWithRecompute,
    red5_normalize: Allowed::Deny,
    note: "ch7 riichi/dama cells are shape, wait and value rules; the label must be \
           recomputed after any seat/suit/rank/wind relabelling. A red five is worth one \
           han, so normalising it can move a hand across the 7700 and extra-han thresholds.",
};

/// The general three-condition rule (ch7:55-59).
pub fn riichi_judgement(state: &GameState) -> Option<Match> {
    let turn = support::turn(state)?;
    let candidates = support::candidates(&turn)?;
    let (declaration, chosen, equivalents) = unanimity_index(&turn, &candidates, |_, kept| {
        if !is_book_tenpai(kept) {
            return None;
        }
        // ch7:521's box owns the 1-2 live-tile cells, including the honor and
        // terminal footnote, so the general rule defers to it.
        if kept.quality.live_tiles <= 2 {
            return None;
        }
        Some(if kept.conditions.picks_riichi() {
            Declaration::Riichi
        } else {
            Declaration::Dama
        })
    })?;

    if declaration == Declaration::Riichi && !riichi_is_legal(state) {
        return None;
    }
    let conditions = candidates[chosen].kept.conditions;
    let mut triggers = Vec::new();
    let mut reasons = Vec::new();
    if declaration == Declaration::Riichi {
        if conditions.extra_han {
            triggers.push(RiichiTrigger::HasExtraHan);
        }
        if conditions.good_wait {
            triggers.push(RiichiTrigger::GoodWait);
        }
        if conditions.dealer {
            triggers.push(RiichiTrigger::Dealer);
        }
    } else {
        if !conditions.dealer {
            reasons.push(DamaReason::NotDealer);
        }
        reasons.push(DamaReason::BadWait);
        if !conditions.extra_han {
            reasons.push(DamaReason::NoExtraHan);
        }
    }

    Some(declaration_match(
        ScenarioId::RiichiJudgement,
        Some(conditions.label().to_string()),
        declaration,
        candidates[chosen].discard,
        equivalents,
        Hints { triggers, reasons },
        None,
    ))
}

/// ch7:521's bad-wait box.
pub fn dama_bad_wait(state: &GameState) -> Option<Match> {
    let turn = support::turn(state)?;
    let candidates = support::candidates(&turn)?;
    let (verdict, chosen, equivalents) = unanimity_index(&turn, &candidates, |_, kept| {
        if !is_book_tenpai(kept) {
            return None;
        }
        let live = kept.quality.live_tiles;
        if !(1..=4u8).contains(&live) {
            return None;
        }
        Some(bad_wait::verdict(&kept.waits, live))
    })?;

    let declaration = if verdict.picks_riichi() {
        Declaration::Riichi
    } else {
        Declaration::Dama
    };
    if declaration == Declaration::Riichi && !riichi_is_legal(state) {
        return None;
    }
    let kept = &candidates[chosen].kept;
    let live = kept.quality.live_tiles;

    let mut triggers = Vec::new();
    let mut reasons = Vec::new();
    if let Some(trigger) = verdict.trigger() {
        triggers.push(trigger);
    } else {
        // The general rule's other dama conditions, only where they hold.
        if !kept.conditions.dealer {
            reasons.push(DamaReason::NotDealer);
        }
        reasons.push(DamaReason::BadWait);
        if !kept.conditions.extra_han {
            reasons.push(DamaReason::NoExtraHan);
        }
        reasons.push(DamaReason::FewLiveWinningTiles);
    }

    Some(declaration_match(
        ScenarioId::DamaBadWait,
        Some(if verdict == bad_wait::Verdict::HonorTerminalWait {
            format!("bad wait, {live} live honor/terminal winning tiles")
        } else {
            format!("bad wait, {live} live winning tiles")
        }),
        declaration,
        candidates[chosen].discard,
        equivalents,
        Hints { triggers, reasons },
        None,
    ))
}

/// ch7:539's genbutsu wait.
pub fn dama_genbutsu_wait(state: &GameState) -> Option<Match> {
    let turn = support::turn(state)?;
    let candidates = support::candidates(&turn)?;
    let threat = support::sole_riichi_threat(state)?;
    let facts = SafetyFacts::from_state(state, threat)?;

    let (_, chosen, equivalents) = unanimity_index(&turn, &candidates, |_, kept| {
        if !is_book_tenpai(kept) {
            return None;
        }
        // The section is an exception to riichi: if the general rule already
        // says dama, this is a different dama reason.
        if !kept.conditions.picks_riichi() {
            return None;
        }
        if !genbutsu::applies(&kept.waits, &facts) {
            return None;
        }
        Some(Declaration::Dama)
    })?;

    // The situation label is miner metadata and must stay answer-free, so it
    // does not name the wait tiles (one of them can be in the threat's river).
    Some(declaration_match(
        ScenarioId::DamaGenbutsuWait,
        Some("one winning tile is the threat's genbutsu".to_string()),
        Declaration::Dama,
        candidates[chosen].discard,
        equivalents,
        Hints {
            triggers: Vec::new(),
            reasons: genbutsu::dama_reasons(),
        },
        None,
    ))
}

/// ch7:569/598/646's high-scoring hand.
pub fn dama_expensive_hand(state: &GameState) -> Option<Match> {
    let turn = support::turn(state)?;
    let candidates = support::candidates(&turn)?;

    let (_, chosen, equivalents) = unanimity_index(&turn, &candidates, |turn, kept| {
        expensive_cell(turn, kept).map(|_| Declaration::Dama)
    })?;

    let kept = &candidates[chosen].kept;
    let (cell, points) = expensive_cell(&turn, kept)?;
    Some(declaration_match(
        ScenarioId::DamaExpensiveHand,
        Some(format!("minimum ron value {points} without riichi")),
        Declaration::Dama,
        candidates[chosen].discard,
        equivalents,
        Hints {
            triggers: Vec::new(),
            reasons: cell.dama_reasons(),
        },
        None,
    ))
}

/// The ch7:656-660 improving-hand cell for one kept hand.
///
/// The count scores the hand with the generators' aka-free value model, so a
/// table where the human holds a red five is outside what this recogniser can
/// certify and returns `None`.
fn improving_cell(turn: &Turn, kept: &Kept) -> Option<improvement::Improvement> {
    if turn.aka > 0 || !is_book_tenpai(kept) {
        return None;
    }
    // The box is an exception to riichi: the general rule must pick riichi for
    // this cell to be the reason the hand stays concealed.
    if !kept.conditions.picks_riichi() {
        return None;
    }
    // ch7:658: an early turn (8th turn or before).
    if turn.turn > 8 {
        return None;
    }
    let count = improvement::count(&kept.tiles, turn.round_wind, turn.human_wind, &turn.dora);
    if !count.qualifies() {
        return None;
    }
    Some(count)
}

/// The expensive-hand cell for one kept hand, or `None` when a ch7:641
/// "riichi anyway" clause applies.
fn expensive_cell(turn: &Turn, kept: &Kept) -> Option<(expensive::Verdict, u32)> {
    if !is_book_tenpai(kept) {
        return None;
    }
    let value = kept.worst_value?;
    let cell = expensive::verdict(value.points)?;
    if cell == expensive::Verdict::DamaExpensive {
        // ch7:641: riichi if it is the 6th turn or before and the wait is a
        // two-way side wait or better, or the 10th turn or before and the wait
        // is a three-way side wait or better.
        if turn.turn <= 6 {
            return None;
        }
        if turn.turn <= 10 && kept.side_waits >= 3 {
            return None;
        }
        // "Riichi if you are far behind from other players": the classifier
        // takes the generator's conservative reading (the human must be in
        // front) and returns no match otherwise.
        if !turn.human_is_in_front() {
            return None;
        }
    }
    Some((cell, value.points))
}

/// ch7:656-660's many improving kinds.
pub fn dama_improving_hand(state: &GameState) -> Option<Match> {
    let turn = support::turn(state)?;
    let candidates = support::candidates(&turn)?;

    let (_, chosen, equivalents) = unanimity_index(&turn, &candidates, |turn, kept| {
        improving_cell(turn, kept).map(|_| Declaration::Dama)
    })?;
    let count = improving_cell(&turn, &candidates[chosen].kept)?;

    Some(declaration_match(
        ScenarioId::DamaImprovingHand,
        Some(if count.has_big_step() {
            format!(
                "{}, {} improving kinds, at least one three-han step",
                "early turn",
                count.kinds()
            )
        } else {
            format!("early turn, {} improving kinds", count.kinds())
        }),
        Declaration::Dama,
        candidates[chosen].discard,
        equivalents,
        Hints {
            triggers: Vec::new(),
            reasons: vec![DamaReason::EarlyTurn, DamaReason::ImprovingHand],
        },
        None,
    ))
}

/// True when the kept hand is a standard tenpai hand with a live winning tile.
fn is_book_tenpai(kept: &Kept) -> bool {
    kept.is_standard() && kept.is_live()
}

/// True when the table lets the human declare Riichi.
fn riichi_is_legal(state: &GameState) -> bool {
    let human = &state.players[0];
    human.score >= 1_000
        && state.tiles_remaining >= 4
        && !human.is_riichi
        && human
            .melds
            .iter()
            .all(|meld| meld.meld_type == crate::state::MeldType::Ankan)
}

/// Every candidate must land on the same verdict; returns it, the index of the
/// first candidate, and the equivalent discards.
fn unanimity_index<T: PartialEq>(
    turn: &Turn,
    candidates: &[Candidate],
    mut verdict: impl FnMut(&Turn, &Kept) -> Option<T>,
) -> Option<(T, usize, Vec<String>)> {
    let mut agreed: Option<(T, usize)> = None;
    let mut equivalents = Vec::new();
    for (index, candidate) in candidates.iter().enumerate() {
        let value = verdict(turn, &candidate.kept)?;
        match &agreed {
            None => agreed = Some((value, index)),
            Some((current, _)) if *current == value => {
                equivalents.push(candidate.discard.to_string());
            }
            Some(_) => return None,
        }
    }
    let (value, index) = agreed?;
    Some((value, index, equivalents))
}

/// The book trigger vocabulary a ch. 7 declaration's rationale is built from.
struct Hints {
    triggers: Vec<RiichiTrigger>,
    reasons: Vec<DamaReason>,
}

/// Build the [`Match`] for one riichi/dama cell.
fn declaration_match(
    lesson: ScenarioId,
    situation: Option<String>,
    declaration: Declaration,
    discard: Tile,
    equivalents: Vec<String>,
    hints: Hints,
    scenario_note: Option<String>,
) -> Match {
    let (target_action, correct_action) = match declaration {
        Declaration::Riichi => (
            TargetAction::Riichi,
            CorrectAction::riichi(discard.to_string()),
        ),
        Declaration::Dama => (TargetAction::Dama, CorrectAction::dama(discard.to_string())),
    };
    Match {
        lesson,
        situation,
        target_action,
        correct_action,
        equivalent_tiles: equivalents,
        riichi_triggers: hints.triggers,
        dama_reasons: hints.reasons,
        scenario_note,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::generator::generate_puzzle;

    fn generated(category: &str) -> GameState {
        generate_puzzle(category).unwrap_or_else(|err| panic!("{category}: {err}"))
    }

    fn assert_matches_own_lesson(category: &str) {
        let state = generated(category);
        let lesson = ScenarioId::from_id(category).expect("a real lesson");
        let matched = super::super::classify(&state, lesson)
            .unwrap_or_else(|| panic!("{category} must classify as itself"));
        matched
            .validate(&state)
            .unwrap_or_else(|err| panic!("{category}: {err}"));
        assert_eq!(matched.lesson, lesson);
        assert_eq!(
            matched.correct_action.action_type(),
            state.correct_action.action_type(),
            "{category}: the action family must agree with the lesson"
        );
        assert_eq!(
            matched.answer_set(),
            {
                let mut expected = state.equivalent_tiles.clone();
                expected.push(
                    state
                        .correct_action
                        .tile()
                        .expect("the lesson answer names a tile")
                        .to_string(),
                );
                expected.sort();
                expected.dedup();
                expected
            },
            "{category}: the accepted tiles must agree with the lesson"
        );
        assert_eq!(
            matched.target_action, state.target_action,
            "{category}: the decision must agree with the lesson"
        );
    }

    #[test]
    fn the_general_rule_recognises_its_own_lesson() {
        for _ in 0..12 {
            assert_matches_own_lesson("riichi_judgement");
        }
    }

    #[test]
    fn the_bad_wait_box_recognises_its_own_lesson() {
        for _ in 0..12 {
            assert_matches_own_lesson("dama_bad_wait");
        }
    }

    #[test]
    fn the_genbutsu_wait_recognises_its_own_lesson() {
        for _ in 0..8 {
            assert_matches_own_lesson("dama_genbutsu_wait");
        }
    }

    #[test]
    fn the_expensive_hand_recognises_its_own_lesson() {
        for _ in 0..8 {
            assert_matches_own_lesson("dama_expensive_hand");
        }
    }

    #[test]
    fn the_improving_hand_recognises_its_own_lesson() {
        for _ in 0..6 {
            assert_matches_own_lesson("dama_improving_hand");
        }
    }

    #[test]
    fn a_hand_that_reaches_tenpai_on_several_discards_needs_agreement() {
        // A riichi-judgement hand whose displayed draw is a spare tile: both
        // dropping the draw and dropping the lesson's answer can leave tenpai.
        // The classifier must either agree on the declaration (and list the
        // other discard as equivalent) or refuse the state.
        for _ in 0..20 {
            let state = generated("riichi_judgement");
            let Some(turn) = support::turn(&state) else {
                continue;
            };
            let Some(candidates) = support::candidates(&turn) else {
                continue;
            };
            let matched = riichi_judgement(&state);
            match matched {
                None => continue,
                Some(matched) => {
                    // Every candidate discard must be in the accepted set.
                    for candidate in &candidates {
                        assert!(
                            matched
                                .answer_set()
                                .iter()
                                .any(|tile| *tile == candidate.discard.to_string())
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn a_non_tenpai_hand_has_no_riichi_judgement() {
        let mut state = generated("riichi_judgement");
        // Replace the draw with a tile that cannot reach tenpai from any
        // discard: keep drawing a copy of a tile the hand already holds twice.
        let spare = state.players[0]
            .hand
            .iter()
            .find(|code| {
                state.players[0]
                    .hand
                    .iter()
                    .filter(|other| other == code)
                    .count()
                    >= 2
            })
            .cloned();
        let Some(spare) = spare else { return };
        state.players[0].draw = Some(spare);
        let Some(turn) = support::turn(&state) else {
            return;
        };
        if support::candidates(&turn).is_some() {
            // Still tenpai after some discard; this fixture cannot test the
            // guard, and the near-miss set in `super::tests` covers it.
            return;
        }
        assert!(riichi_judgement(&state).is_none());
        assert!(dama_bad_wait(&state).is_none());
    }

    #[test]
    fn a_furiten_candidate_removes_the_whole_state() {
        let mut state = generated("riichi_judgement");
        let waits = state.ukeire_tiles.clone();
        let Some(wait) = waits.first().cloned() else {
            return;
        };
        state.players[0]
            .discards
            .push(crate::state::DiscardTile::new(wait));
        assert!(support::candidates(&support::turn(&state).expect("a turn")).is_none());
        assert!(riichi_judgement(&state).is_none());
        assert!(dama_bad_wait(&state).is_none());
    }

    #[test]
    fn the_bad_wait_box_needs_a_bad_wait() {
        let state = generated("dama_bad_wait");
        let matched = dama_bad_wait(&state).expect("the lesson's own cell");
        assert!(!matched.dama_reasons.is_empty() || !matched.riichi_triggers.is_empty());
    }

    #[test]
    fn a_chiitoitsu_tenpai_is_not_a_standard_hand_rule() {
        for _ in 0..6 {
            let state = generated("chiitoitsu_riichi_vs_dama");
            assert!(riichi_judgement(&state).is_none());
            assert!(dama_bad_wait(&state).is_none());
            assert!(dama_improving_hand(&state).is_none());
        }
    }

    #[test]
    fn a_good_wait_hand_is_not_the_bad_wait_box() {
        let mut checked = 0;
        for _ in 0..24 {
            let state = generated("riichi_judgement");
            if !state.riichi_triggers.contains(&RiichiTrigger::GoodWait) {
                continue;
            }
            checked += 1;
            assert!(
                dama_bad_wait(&state).is_none(),
                "a good wait is not the bad-wait box"
            );
        }
        assert!(checked > 0, "the generator must produce a good wait");
    }

    #[test]
    fn a_threatless_table_is_not_the_genbutsu_lesson() {
        let mut state = generated("dama_genbutsu_wait");
        for player in &mut state.players {
            player.is_riichi = false;
            player.riichi_discard_index = None;
            for discard in &mut player.discards {
                discard.is_riichi = false;
            }
        }
        assert!(dama_genbutsu_wait(&state).is_none());
    }

    #[test]
    fn a_wait_without_a_genbutsu_side_is_not_the_genbutsu_lesson() {
        let mut state = generated("dama_genbutsu_wait");
        let threat = support::sole_riichi_threat(&state).expect("one threat");
        let waits = state.ukeire_tiles.clone();
        state.players[threat]
            .discards
            .retain(|discard| !waits.iter().any(|wait| wait == &discard.tile));
        assert!(dama_genbutsu_wait(&state).is_none());
    }

    #[test]
    fn a_hand_with_no_yaku_floor_is_not_the_expensive_lesson() {
        let mut checked = 0;
        for _ in 0..80 {
            let state = generated("riichi_judgement");
            if !state.dama_reasons.contains(&DamaReason::NoExtraHan) {
                continue;
            }
            checked += 1;
            assert!(
                dama_expensive_hand(&state).is_none(),
                "a riichi-only hand has no ron value to protect"
            );
        }
        assert!(checked > 0, "the generator must produce a riichi-only hand");
    }

    #[test]
    fn a_hand_past_the_eighth_turn_is_not_the_improving_lesson() {
        let mut state = generated("dama_improving_hand");
        let fillers = ["1z", "2z", "3z", "4z", "5z", "6z", "7z", "1p", "9p"];
        for (index, tile) in fillers.iter().enumerate() {
            state.players[0]
                .discards
                .push(crate::state::DiscardTile::new(*tile));
            let _ = index;
        }
        assert!(state.players[0].discards.len() > 8);
        assert!(dama_improving_hand(&state).is_none());
    }

    #[test]
    fn a_red_five_is_outside_the_improving_count() {
        let mut state = generated("dama_improving_hand");
        let five = state.players[0]
            .hand
            .iter()
            .find(|code| code.ends_with('m') || code.ends_with('p') || code.ends_with('s'))
            .cloned();
        if let Some(five) = five {
            state.players[0].red_fives = vec![five];
            assert!(dama_improving_hand(&state).is_none());
        }
    }

    #[test]
    fn the_riichi_judgement_dama_cell_and_the_bad_wait_box_conflict() {
        // The known ch7 conflict: a bad-wait riichi-only non-dealer with 3-4
        // live winning tiles is dama under the general rule (ch7:71) and riichi
        // under the later bad-wait box (ch7:521).
        let mut found = false;
        for _ in 0..80 {
            let state = generated("riichi_judgement");
            if state.correct_action.action_type() != crate::state::CorrectActionType::Dama {
                continue;
            }
            let general = riichi_judgement(&state).expect("the lesson's own cell");
            let boxed = dama_bad_wait(&state).expect("the box's own cell");
            assert_eq!(
                general.correct_action.action_type(),
                crate::state::CorrectActionType::Dama
            );
            assert_eq!(
                boxed.correct_action.action_type(),
                crate::state::CorrectActionType::Riichi
            );
            assert!(!general.same_answer(&boxed));
            found = true;
            break;
        }
        assert!(found, "the generator must produce the conflicted cell");
    }
}
