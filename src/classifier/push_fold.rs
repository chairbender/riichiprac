//! The ch. 8.1 push/fold recogniser (`push_or_fold`).
//!
//! The book's box (ch8:23-36):
//!
//! > Push if **two** of the following conditions are met: Ready hand; High
//! > scoring hand; Good wait.
//! >
//! > Fold if **two** of the following conditions are met: 1-away (or worse)
//! > hand; Low scoring hand; Bad wait.
//!
//! The lesson isolates the 1-away hand, where the two boxes are exact
//! complements (ch8:62, "Pushing with a 1-away hand is acceptable only when
//! *both* the other two conditions are met"). The recogniser therefore reads
//! the 1-away hand twice:
//!
//! - **push** when a discard leaves a 1-away hand whose worst completion is
//!   worth 7700 and can always choose a side wait (the same
//!   `push_or_fold::hand_conditions` the generator validates with), and
//! - **fold** otherwise, when exactly one tile in the hand is the threat's
//!   genbutsu — the generator's 100%-safe fold cell.
//!
//! The answer is an ordinary discard in both cells, exactly as the shipped
//! lesson carries it: `Push` + the shape-preserving discard, `Fold` + the safe
//! tile.

use agari::parse::to_counts;
use agari::shanten::calculate_shanten;
use agari::tile::Tile;

use crate::generator::ScenarioId;
use crate::generator::push_or_fold;
use crate::safety::{SafetyFacts, SafetyRank};
use crate::state::{CorrectAction, GameState, TargetAction};

use super::support::{self, Turn};
use super::{Allowed, Match, TransformPolicy};

/// ch. 8 push/fold is a shape/value/safety rule: every transform must be
/// recomputed, including red-five normalisation (a red five changes the hand's
/// value against the 7700 floor).
pub(crate) const POLICY: TransformPolicy = TransformPolicy {
    seat_perm: Allowed::AllowWithRecompute,
    suit_perm: Allowed::AllowWithRecompute,
    rank_mirror: Allowed::AllowWithRecompute,
    wind_relabel: Allowed::AllowWithRecompute,
    red5_normalize: Allowed::AllowWithRecompute,
    note: "ch8.1's push/fold box is a value, wait and safety-chart rule; the label must be \
           recomputed after any transform, and a red five can move the 7700 minimum value.",
};

/// Recognise the ch. 8.1 push/fold cell.
pub fn push_or_fold(state: &GameState) -> Option<Match> {
    let turn = support::turn(state)?;
    // The box's cell is a 1-away hand; tenpai belongs to the riichi/dama family
    // and 2-away+ is the betaori lesson.
    if turn.shanten != 1 {
        return None;
    }
    let threat = support::sole_riichi_threat(state)?;

    let push_discards = push_discards(&turn);
    if !push_discards.is_empty() {
        let answer = push_discards[0];
        let equivalents = push_discards[1..].iter().map(ToString::to_string).collect();
        return Some(Match {
            lesson: ScenarioId::PushOrFold,
            situation: Some("1-away, high scoring hand and good wait".to_string()),
            target_action: TargetAction::Push,
            correct_action: CorrectAction::dama(answer.to_string()),
            equivalent_tiles: equivalents,
            riichi_triggers: Vec::new(),
            dama_reasons: Vec::new(),
            shouminkan_triggers: Vec::new(),
            scenario_note: Some(push_note(&turn)),
        });
    }

    // Fold cell: the box says fold, and the drill's answer is the threat's
    // 100% safe tile. A table where more than one tile is genbutsu is the
    // ranking lesson's board, not this box's single-safe-tile drill.
    let facts = SafetyFacts::from_state(state, threat)?;
    let safe: Vec<Tile> = support::distinct(&turn.hand)
        .into_iter()
        .filter(|tile| facts.rank(*tile) == SafetyRank::Genbutsu)
        .collect();
    if safe.len() != 1 {
        return None;
    }
    let answer = safe[0];
    Some(Match {
        lesson: ScenarioId::PushOrFold,
        situation: Some("1-away, low scoring or bad wait, threat in Riichi".to_string()),
        target_action: TargetAction::Fold,
        correct_action: CorrectAction::fold(answer.to_string()),
        equivalent_tiles: Vec::new(),
        riichi_triggers: Vec::new(),
        dama_reasons: Vec::new(),
        shouminkan_triggers: Vec::new(),
        scenario_note: Some(push_note(&turn)),
    })
}

/// Every discard that leaves a 1-away hand meeting both non-ready push
/// conditions, in tile order.
fn push_discards(turn: &Turn) -> Vec<Tile> {
    let mut pushing = Vec::new();
    for discard in support::distinct(&turn.hand) {
        let mut rest = turn.hand.clone();
        let index = rest
            .iter()
            .position(|tile| *tile == discard)
            .expect("the tile came from the hand");
        rest.remove(index);
        if calculate_shanten(&to_counts(&rest)).shanten != 1 {
            continue;
        }
        let conditions =
            push_or_fold::hand_conditions(&rest, turn.round_wind, turn.human_wind, &turn.dora);
        if conditions.pushes() {
            pushing.push(discard);
        }
    }
    pushing
}

/// The lesson's pre-answer note: the two box facts, without the answer.
fn push_note(turn: &Turn) -> String {
    // The note restates the same two facts the generator's board prints; it
    // never names the discard or the decision.
    let conditions = hand_conditions_of_draw(turn);
    let value = match conditions.and_then(|conditions| conditions.value) {
        Some(value) => format!(
            "the worst winning tile is already worth {} points without Riichi",
            value.points
        ),
        None => "at least one way the hand can win has no yaku at all".to_string(),
    };
    let wait = match conditions {
        Some(conditions) if conditions.good_wait => "every completion can still choose a side wait",
        _ => "at least one completion can only reach a closed, edge or single wait",
    };
    format!("An opponent has declared Riichi. You are 1-away: {value}, and {wait}.")
}

/// The pre-draw 13-tile hand's push conditions, when it is 1-away.
fn hand_conditions_of_draw(turn: &Turn) -> Option<push_or_fold::Conditions> {
    let mut core = turn.hand.clone();
    // The lesson's conditions are read off the 13 tiles held before the draw.
    let index = core.iter().position(|tile| *tile == turn.draw)?;
    core.remove(index);
    if calculate_shanten(&to_counts(&core)).shanten != 1 {
        return None;
    }
    Some(push_or_fold::hand_conditions(
        &core,
        turn.round_wind,
        turn.human_wind,
        &turn.dora,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::generator::generate_puzzle;

    #[test]
    fn the_push_cell_recognises_its_own_lesson() {
        let mut pushes = 0;
        for _ in 0..40 {
            let state = generate_puzzle("push_or_fold").expect("must generate");
            if state.target_action != TargetAction::Push {
                continue;
            }
            pushes += 1;
            let matched = push_or_fold(&state).expect("a push board must match");
            matched.validate(&state).expect("the answer must be legal");
            assert_eq!(matched.target_action, TargetAction::Push);
            assert_eq!(
                matched.correct_action.action_type(),
                crate::state::CorrectActionType::Dama
            );
            assert!(
                matched.answer_set().contains(
                    &state
                        .correct_action
                        .tile()
                        .expect("the push answer names a tile")
                        .to_string()
                )
            );
        }
        assert!(pushes > 0, "the generator must produce a push board");
    }

    #[test]
    fn the_fold_cell_recognises_its_own_lesson() {
        let mut folds = 0;
        for _ in 0..40 {
            let state = generate_puzzle("push_or_fold").expect("must generate");
            if state.target_action != TargetAction::Fold {
                continue;
            }
            folds += 1;
            let matched = push_or_fold(&state).expect("a fold board must match");
            matched.validate(&state).expect("the answer must be legal");
            assert_eq!(matched.target_action, TargetAction::Fold);
            assert_eq!(matched.correct_action.tile(), state.correct_action.tile());
        }
        assert!(folds > 0, "the generator must produce a fold board");
    }

    #[test]
    fn a_two_away_hand_is_not_the_push_fold_cell() {
        let state = generate_puzzle("fold_to_riichi").expect("must generate");
        assert!(push_or_fold(&state).is_none());
    }

    #[test]
    fn a_tenpai_hand_is_not_the_push_fold_cell() {
        let state = generate_puzzle("riichi_judgement").expect("must generate");
        assert!(push_or_fold(&state).is_none());
    }

    #[test]
    fn a_table_without_a_riichi_threat_is_not_the_push_fold_cell() {
        let mut state = generate_puzzle("push_or_fold").expect("must generate");
        for player in &mut state.players {
            player.is_riichi = false;
            player.riichi_discard_index = None;
            for discard in &mut player.discards {
                discard.is_riichi = false;
            }
        }
        assert!(push_or_fold(&state).is_none());
    }

    #[test]
    fn a_push_cell_needs_both_non_ready_conditions() {
        // A push board's discard must keep the 1-away shape *and* the value:
        // removing the value condition (a hand with no dora/yaku) is the fold
        // cell, never a push.
        for _ in 0..30 {
            let state = generate_puzzle("push_or_fold").expect("must generate");
            let Some(turn) = support::turn(&state) else {
                continue;
            };
            let pushing = push_discards(&turn);
            if state.target_action == TargetAction::Push {
                assert!(!pushing.is_empty(), "a push board must have a push discard");
            } else {
                assert!(pushing.is_empty(), "a fold board must have no push discard");
            }
        }
    }

    #[test]
    fn the_note_never_names_the_answer() {
        for _ in 0..20 {
            let state = generate_puzzle("push_or_fold").expect("must generate");
            let Some(matched) = push_or_fold(&state) else {
                continue;
            };
            let tile = matched.correct_action.tile().expect("an answer tile");
            assert!(
                !matched
                    .scenario_note
                    .as_deref()
                    .unwrap_or("")
                    .contains(tile)
            );
        }
    }
}
