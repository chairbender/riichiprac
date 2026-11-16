//! Book classification over the replay walker's snapshots (B1 × R2).
//!
//! The recognisers themselves live in [`crate::classifier`], outside the miner
//! feature, because the B1 gate is the default app build. This module is the
//! miner-side seam: it takes a [`DecisionSnapshot`] from the R2 walker and
//! applies the miner's furiten policy before asking for a label.
//!
//! Replay-strategy §6.3 leaves furiten as an open question and §8 lists it as a
//! risk: a decision whose legality or answer depends on furiten must be
//! computed or rejected, never silently mined. R2 already computes permanent
//! furiten from the record, so a snapshot that is furiten is rejected here
//! (the classifiers also refuse a state whose tenpai candidate is already in
//! the actor's river, which is the same check on visible information).
//!
//! A snapshot is not a generator board: the walker normalises the actor to seat
//! 0 and fills the derived hand fields, but most random self-play positions do
//! not satisfy any book lesson. `Ok(None)` is the common, expected answer.

use crate::ai::wasm_bridge::Evaluation;
use crate::classifier::{self, Conflict, Label, Match};
use crate::replay::walk::DecisionSnapshot;

/// Classify one reconstructed decision.
///
/// - `Err(Conflict)` when two book rules read the same visible position and
///   disagree (see [`crate::classifier`] on the ch. 7 riichi/dama family); the
///   caller must not pick one.
/// - `Ok(None)` for a furiten decision or one that no B1 lesson recognises.
/// - `Ok(Some(match))` for the single book label, already stripped of any other
///   lesson's answer vocabulary. Call [`Match::stamp`] to write it onto the
///   snapshot's state.
pub fn classify_decision(snapshot: &DecisionSnapshot) -> Result<Option<Match>, Conflict> {
    if snapshot.furiten {
        return Ok(None);
    }
    classifier::classify_unique(&snapshot.state)
}

/// Classify one reconstructed decision with Mortal as the tiebreaker.
///
/// This is the miner's preferred path whenever the L1 labeler has an
/// [`Evaluation`] for the snapshot: when two book lessons read the same visible
/// position differently, the label is the lesson whose answer the model's top
/// action agrees with (see [`crate::classifier::classify_with_mortal`]). The
/// returned [`Label`] carries the [`crate::classifier::Resolution`] so the
/// candidate row can record `selection_reason: "mortal_tiebreak"`.
///
/// `evaluation` must be the model's evaluation of the snapshot's own state.
/// With no evaluation, use [`classify_decision`], which fails closed on a
/// disagreement.
pub fn classify_decision_with_mortal(
    snapshot: &DecisionSnapshot,
    evaluation: &Evaluation,
) -> Result<Option<Label>, Conflict> {
    if snapshot.furiten {
        return Ok(None);
    }
    classifier::classify_with_mortal(&snapshot.state, evaluation)
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::classifier::registered_lessons;
    use crate::miner::provenance::ReplayId;
    use crate::replay::fixtures;
    use crate::replay::mjai::ReplayReader;
    use crate::replay::walk::{ReplayWalk, walk_replay};

    fn walk(events: &[crate::replay::mjai::EventKind]) -> ReplayWalk {
        let text = fixtures::to_jsonl(events);
        let bytes = fixtures::gzip(&text);
        let file = ReplayReader::read_gzip(&bytes).expect("fixture must parse");
        walk_replay(&file, ReplayId::from_bytes(&bytes)).expect("fixture must validate")
    }

    /// The ch. 7 riichi/dama lessons are the one family whose book sections can
    /// disagree; every other pair must agree on the answer.
    fn only_ch7_conflicts(conflict: &Conflict) -> bool {
        use crate::generator::ScenarioId;
        conflict.matches.iter().all(|matched| {
            matches!(
                matched.lesson,
                ScenarioId::RiichiJudgement
                    | ScenarioId::DamaBadWait
                    | ScenarioId::DamaGenbutsuWait
                    | ScenarioId::DamaExpensiveHand
                    | ScenarioId::DamaImprovingHand
            )
        })
    }

    #[test]
    fn walking_a_fixture_replay_classifies_without_a_conflict_or_an_illegal_answer() {
        let replay = walk(&fixtures::all_events_game());
        assert!(!replay.decisions.is_empty());

        let mut recognised = 0;
        for decision in &replay.decisions {
            match classify_decision(decision) {
                Ok(Some(matched)) => {
                    recognised += 1;
                    assert!(
                        registered_lessons().any(|lesson| lesson == matched.lesson),
                        "a match must name a registered lesson"
                    );
                    matched.validate(&decision.state).unwrap_or_else(|err| {
                        panic!("decision {}: illegal answer: {err}", decision.decision_id)
                    });
                    // Re-stamping must not change the answer the drill grades.
                    let stamped = matched.clone().stamp(decision.state.clone());
                    assert_eq!(stamped.correct_action, matched.correct_action);
                }
                Ok(None) => {}
                Err(conflict) => assert!(
                    only_ch7_conflicts(&conflict),
                    "decision {}: {conflict}",
                    decision.decision_id
                ),
            }
        }
        // The fixture is a hand-scripted game, not a lesson board, so most
        // decisions are not a book cell. The scripted table does contain a few
        // (a fold and a riichi/dama read among them), which is what proves the
        // seam runs end to end rather than merely declining everything.
        assert!(
            recognised > 0,
            "the fixture replay must contain at least one book cell"
        );
        assert!(recognised < replay.decisions.len());
    }

    #[test]
    fn classification_is_deterministic_over_a_walked_replay() {
        let replay = walk(&fixtures::exhaustive_game(7));
        for decision in &replay.decisions {
            let first = classify_decision(decision);
            let second = classify_decision(decision);
            assert_eq!(first, second, "decision {} flipped", decision.decision_id);
        }
    }

    #[test]
    fn the_mortal_path_keeps_every_model_free_label() {
        use crate::ai::wasm_bridge::{ActionEvaluation, Evaluation};

        // A deliberately unhelpful evaluation: it agrees with no book answer.
        // Where the model-free path already has a label, the tiebreak must not
        // change it; where it is a conflict, the tiebreak fails closed too.
        let evaluation = Evaluation {
            model: "mortal_298k.safetensors".to_string(),
            expected_value: 0.0,
            recommended_action: "Pass".to_string(),
            riichi_discard: None,
            evaluations: vec![ActionEvaluation::from_parts("Pass", "pass", None, 1.0)],
        };

        let replay = walk(&fixtures::all_events_game());
        for decision in &replay.decisions {
            let plain = classify_decision(decision);
            let with_mortal = classify_decision_with_mortal(decision, &evaluation);
            match (plain, with_mortal) {
                (Ok(Some(matched)), Ok(Some(label))) => {
                    assert_eq!(label.matched, matched, "{}", decision.decision_id);
                    assert!(
                        matches!(
                            label.resolution,
                            crate::classifier::Resolution::Single
                                | crate::classifier::Resolution::Agreement
                        ),
                        "decision {}: unexplained tiebreak {:?}",
                        decision.decision_id,
                        label.resolution
                    );
                }
                (Ok(None), Ok(None)) => {}
                (Err(conflict), Err(other)) => assert_eq!(conflict.lessons(), other.lessons()),
                // A model-free conflict can stay a conflict; it must never
                // become a different label just because an evaluation exists.
                (Err(conflict), Ok(None) | Ok(Some(_))) => panic!(
                    "decision {}: the model-free conflict vanished: {conflict}",
                    decision.decision_id
                ),
                (left, right) => panic!(
                    "decision {}: model-free {:?} vs mortal {:?}",
                    decision.decision_id, left, right
                ),
            }
        }
    }

    #[test]
    fn a_furiten_decision_is_never_classified() {
        let replay = walk(&fixtures::furiten_ron_game());
        for decision in &replay.decisions {
            if !decision.furiten {
                continue;
            }
            assert!(
                classify_decision(decision).map(|matched| matched.is_none()) == Ok(true),
                "a furiten decision must be rejected, not labelled"
            );
        }
    }
}
