//! Cross-lesson tests for the book classifiers.
//!
//! Per-lesson positive and near-miss tests live beside each recogniser. This
//! module holds the properties that are about the *framework*:
//!
//! - every generated B1 lesson state classifies, and its match validates;
//! - no two recognisers ever disagree about the answer (the one pinned ch. 7
//!   conflict excepted);
//! - classification is deterministic and does not read the state's own answer;
//! - rotating the table and normalising the actor back to seat 0 classifies the
//!   same way, and an unnormalised table classifies as nothing;
//! - every recognised lesson declares a transform policy, and the default is
//!   deny.

use super::*;

use crate::generator::{ScenarioId, generate_puzzle};
use crate::state::{CorrectAction, GameState};

/// Every B1 lesson, with its generator id.
const B1_LESSONS: &[ScenarioId] = &[
    ScenarioId::RiichiJudgement,
    ScenarioId::DamaBadWait,
    ScenarioId::DamaGenbutsuWait,
    ScenarioId::DamaExpensiveHand,
    ScenarioId::DamaImprovingHand,
    ScenarioId::PushOrFold,
    ScenarioId::FoldToRiichi,
    ScenarioId::DefenseSafetyChart,
    ScenarioId::SujiKabeSafety,
    ScenarioId::KabeNoChance,
    ScenarioId::KabeOneChance,
    ScenarioId::KabeDoubleOneChance,
    ScenarioId::KabeSujiDefense,
    ScenarioId::DefenseStuckHeuristic,
];

fn generated(lesson: ScenarioId) -> GameState {
    generate_puzzle(lesson.as_str()).unwrap_or_else(|err| panic!("{}: {err}", lesson.as_str()))
}

/// The answer set a state already carries.
fn state_answer_set(state: &GameState) -> Vec<String> {
    let mut tiles = state.equivalent_tiles.clone();
    if let Some(tile) = state.correct_action.tile() {
        tiles.push(tile.to_string());
    }
    tiles.sort();
    tiles.dedup();
    tiles
}

#[test]
fn every_b1_lesson_is_registered() {
    for &lesson in B1_LESSONS {
        assert!(
            classifier(lesson).is_some(),
            "{} has no classifier",
            lesson.as_str()
        );
        assert!(
            registered_lessons().any(|registered| registered == lesson),
            "{} is not in the registry iteration",
            lesson.as_str()
        );
    }
}

#[test]
fn every_registered_classifier_names_a_real_lesson() {
    for entry in CLASSIFIERS {
        assert_eq!(
            ScenarioId::from_id(entry.lesson.as_str()),
            Some(entry.lesson),
            "{} does not round-trip",
            entry.lesson.as_str()
        );
        assert_eq!(transform_policy(entry.lesson), Some(entry.policy));
    }
}

#[test]
fn the_default_transform_policy_denies_everything() {
    assert!(!TransformPolicy::DENY.allows_any());
    for transform in [
        TransformPolicy::DENY.seat_perm,
        TransformPolicy::DENY.suit_perm,
        TransformPolicy::DENY.rank_mirror,
        TransformPolicy::DENY.wind_relabel,
        TransformPolicy::DENY.red5_normalize,
    ] {
        assert_eq!(transform, Allowed::Deny);
    }
}

#[test]
fn every_opted_in_policy_explains_itself() {
    for entry in CLASSIFIERS {
        if entry.policy.allows_any() {
            assert!(
                entry.policy.note.len() > 20,
                "{} opts into a transform without a note",
                entry.lesson.as_str()
            );
        }
    }
}

/// The safety-chart generator's `non_suji` theme answers with a plain
/// non-suji terminal (`CC`), the bottom row ch. 8 does not identify. That board
/// belongs to the fallback lesson's row, so `defense_safety_chart` refuses it
/// (see `classifier::defense`'s module note). The shared test allows exactly
/// that documented refusal and nothing else.
fn documented_bottom_row_refusal(lesson: ScenarioId, state: &GameState) -> bool {
    if lesson != ScenarioId::DefenseSafetyChart {
        return false;
    }
    let Some(turn) = support::turn(state) else {
        return false;
    };
    let Some(threat) = support::sole_riichi_threat(state) else {
        return false;
    };
    let Some(facts) = crate::safety::SafetyFacts::from_state(state, threat) else {
        return false;
    };
    turn.hand
        .iter()
        .map(|tile| facts.rank(*tile).order())
        .min()
        .is_some_and(|best| best >= crate::safety::SafetyRank::Cc.order())
}

#[test]
fn every_generated_b1_state_classifies_as_its_own_lesson() {
    for &lesson in B1_LESSONS {
        for run in 0..3 {
            let state = generated(lesson);
            let Some(matched) = classify(&state, lesson) else {
                assert!(
                    documented_bottom_row_refusal(lesson, &state),
                    "{} run {run}: did not classify as itself",
                    lesson.as_str()
                );
                continue;
            };
            matched.validate(&state).unwrap_or_else(|err| {
                panic!("{} run {run}: illegal answer: {err}", lesson.as_str())
            });
            assert_eq!(matched.lesson, lesson, "{} run {run}", lesson.as_str());
            assert_eq!(
                matched.correct_action.action_type(),
                state.correct_action.action_type(),
                "{} run {run}: action family",
                lesson.as_str()
            );
            assert_eq!(
                matched.answer_set(),
                state_answer_set(&state),
                "{} run {run}: accepted tiles",
                lesson.as_str()
            );
        }
    }
}

#[test]
fn classification_never_depends_on_the_states_own_answer() {
    // Overwrite the answer and trigger fields with nonsense; the recogniser must
    // still return the book answer it recomputes.
    for &lesson in B1_LESSONS {
        let state = generated(lesson);
        let mut stripped = state.clone();
        stripped.correct_action = CorrectAction::pass();
        stripped.equivalent_tiles.clear();
        stripped.riichi_triggers.clear();
        stripped.dama_reasons.clear();
        stripped.book_rationale = None;

        assert_eq!(
            classify(&state, lesson),
            classify(&stripped, lesson),
            "{} reads its own answer",
            lesson.as_str()
        );
    }
}

#[test]
fn classification_is_deterministic() {
    for &lesson in B1_LESSONS {
        let state = generated(lesson);
        let first = classify_all(&state);
        let second = classify_all(&state);
        assert_eq!(first, second, "{} is not deterministic", lesson.as_str());
    }
}

#[test]
fn stamping_replaces_the_lessons_answer_and_reclassifies_the_same() {
    // Stamp a match onto another lesson's table: the lesson's answer vocabulary
    // must be replaced, and the stamped table must classify the same way.
    for &lesson in B1_LESSONS {
        let state = generated(lesson);
        let Some(matched) = classify(&state, lesson) else {
            continue;
        };
        let stamped = matched.clone().stamp(state.clone());

        assert_eq!(stamped.category, lesson.as_str());
        assert_eq!(stamped.correct_action, matched.correct_action);
        assert_eq!(stamped.equivalent_tiles, matched.equivalent_tiles);
        assert_eq!(stamped.target_action, matched.target_action);
        assert_eq!(stamped.riichi_triggers, matched.riichi_triggers);
        assert_eq!(stamped.dama_reasons, matched.dama_reasons);
        assert!(stamped.shouminkan_triggers.is_empty());
        assert!(stamped.call_offer.is_none());
        assert!(stamped.ai_decision.is_none());

        let restamped = classify(&stamped, lesson)
            .unwrap_or_else(|| panic!("{} lost its label after stamping", lesson.as_str()));
        assert_eq!(restamped.answer_set(), matched.answer_set());
    }
}

/// True for the ch. 7 riichi/dama lessons.
fn is_ch7_lesson(lesson: ScenarioId) -> bool {
    matches!(
        lesson,
        ScenarioId::RiichiJudgement
            | ScenarioId::DamaBadWait
            | ScenarioId::DamaGenbutsuWait
            | ScenarioId::DamaExpensiveHand
            | ScenarioId::DamaImprovingHand
    )
}

/// True when the only disagreement is inside the ch. 7 riichi/dama family.
///
/// The general three-condition rule and the chapter's later dama sections can
/// read the same hand as riichi or dama (the bad-wait box's 3+ live cell, the
/// genbutsu wait, the expensive hand, the improving hand). Both the shipped
/// `riichi_judgement` and the shipped `dama_*` lessons exist for those cells, so
/// the recognisers mirror both and the framework reports the disagreement
/// instead of picking one. No conflict crosses a lesson family: the defense and
/// push/fold recognisers all agree with each other.
fn is_documented_ch7_conflict(matches: &[Match]) -> bool {
    matches.len() >= 2
        && matches.iter().all(|matched| is_ch7_lesson(matched.lesson))
        && !matches[1..]
            .iter()
            .all(|other| matches[0].same_answer(other))
}

#[test]
fn no_two_recognisers_disagree_except_inside_the_ch7_family() {
    for &lesson in B1_LESSONS {
        for _ in 0..3 {
            let state = generated(lesson);
            let matches = classify_all(&state);
            if matches.len() < 2 {
                continue;
            }
            let first = &matches[0];
            let agree = matches[1..].iter().all(|other| first.same_answer(other));
            assert!(
                agree || is_documented_ch7_conflict(&matches),
                "{}: conflicting answers from {:?}",
                lesson.as_str(),
                matches
                    .iter()
                    .map(|m| (m.lesson.as_str(), m.answer_set(), m.target_action))
                    .collect::<Vec<_>>()
            );
            if !agree {
                assert!(
                    matches
                        .iter()
                        .all(|matched| matched.validate(&state).is_ok()),
                    "{}: a conflicting match is not even legal",
                    lesson.as_str()
                );
            }
        }
    }
}

#[test]
fn classify_unique_is_ok_for_every_generated_b1_state() {
    for &lesson in B1_LESSONS {
        for _ in 0..3 {
            let state = generated(lesson);
            match classify_unique(&state) {
                Ok(Some(matched)) => {
                    matched
                        .validate(&state)
                        .expect("a unique label must be legal");
                }
                Ok(None) => {
                    assert!(
                        documented_bottom_row_refusal(lesson, &state),
                        "{} did not classify at all",
                        lesson.as_str()
                    );
                }
                Err(conflict) => {
                    assert!(
                        is_documented_ch7_conflict(&conflict.matches),
                        "{}: unexpected conflict: {conflict}",
                        lesson.as_str()
                    );
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Mortal as the tiebreaker.
// ---------------------------------------------------------------------------

use crate::ai::wasm_bridge::{ActionEvaluation, Evaluation};

/// A minimal evaluation whose top action is `top`, from the state's point of
/// view. Only the action name participates in agreement, so the probability
/// list is a formality.
fn evaluation_for(top: &str, riichi_discard: Option<&str>) -> Evaluation {
    Evaluation {
        model: "mortal_298k.safetensors".to_string(),
        expected_value: 0.0,
        recommended_action: top.to_string(),
        riichi_discard: riichi_discard.map(str::to_string),
        evaluations: vec![ActionEvaluation::from_parts(top, "discard", None, 1.0)],
    }
}

/// The model's top action that agrees with one match, as an evaluation.
fn evaluation_agreeing_with(matched: &Match) -> Evaluation {
    match &matched.correct_action {
        CorrectAction::Riichi { discard } => evaluation_for("Riichi", Some(discard.as_str())),
        other => evaluation_for(
            &format!(
                "Discard_{}",
                other.tile().expect("a ch7 match names a discard")
            ),
            None,
        ),
    }
}

/// A generated state where the general rule and the bad-wait box disagree.
fn ch7_conflict_state() -> GameState {
    for _ in 0..160 {
        let state = generated(ScenarioId::RiichiJudgement);
        let (Some(general), Some(boxed)) = (
            classify(&state, ScenarioId::RiichiJudgement),
            classify(&state, ScenarioId::DamaBadWait),
        ) else {
            continue;
        };
        if !general.same_answer(&boxed) {
            return state;
        }
    }
    panic!("the generators must produce a ch7 disagreement");
}

#[test]
fn mortal_breaks_a_ch7_disagreement_toward_the_general_rule() {
    let state = ch7_conflict_state();
    let general = classify(&state, ScenarioId::RiichiJudgement).expect("the general rule");
    let boxed = classify(&state, ScenarioId::DamaBadWait).expect("the bad-wait box");
    assert!(!general.same_answer(&boxed));

    let evaluation = evaluation_agreeing_with(&general);
    let label = classify_with_mortal(&state, &evaluation)
        .expect("Mortal distinguishes the two answers")
        .expect("a label");
    assert_eq!(label.matched, general);
    assert_eq!(
        label.resolution,
        Resolution::MortalTiebreak {
            rejected: vec![ScenarioId::DamaBadWait]
        }
    );
    label.matched.validate(&state).expect("a legal answer");
}

#[test]
fn mortal_breaks_a_ch7_disagreement_toward_the_exception() {
    let state = ch7_conflict_state();
    let general = classify(&state, ScenarioId::RiichiJudgement).expect("the general rule");
    let boxed = classify(&state, ScenarioId::DamaBadWait).expect("the bad-wait box");

    let evaluation = evaluation_agreeing_with(&boxed);
    let label = classify_with_mortal(&state, &evaluation)
        .expect("Mortal distinguishes the two answers")
        .expect("a label");
    assert_eq!(label.matched, boxed);
    assert_eq!(
        label.resolution,
        Resolution::MortalTiebreak {
            rejected: vec![ScenarioId::RiichiJudgement]
        }
    );
    label.matched.validate(&state).expect("a legal answer");
    assert_ne!(label.matched, general);
}

#[test]
fn a_model_that_agrees_with_neither_keeps_the_conflict() {
    let state = ch7_conflict_state();
    let matches = classify_all(&state);
    let answers: Vec<String> = matches
        .iter()
        .flat_map(|matched| matched.answer_set())
        .collect();
    let other = support::turn(&state)
        .expect("a turn")
        .hand
        .iter()
        .map(ToString::to_string)
        .find(|tile| !answers.contains(tile))
        .expect("a hand tile that is not an answer");
    let evaluation = evaluation_for(&format!("Discard_{other}"), None);

    let conflict = classify_with_mortal(&state, &evaluation)
        .expect_err("neither book rule is what Mortal plays");
    assert!(is_documented_ch7_conflict(&conflict.matches));
    // The model-free path agrees with the model-free fallback.
    assert_eq!(
        classify_unique(&state)
            .expect_err("the disagreement stands")
            .lessons(),
        conflict.lessons()
    );
}

#[test]
fn a_single_match_needs_no_tiebreak() {
    let state = generated(ScenarioId::DefenseStuckHeuristic);
    let Some(matched) = classify(&state, ScenarioId::DefenseStuckHeuristic) else {
        return;
    };
    if classify_all(&state).len() != 1 {
        return;
    }
    let evaluation = evaluation_for("Pass", None);
    let label = classify_with_mortal(&state, &evaluation)
        .expect("one match is not a disagreement")
        .expect("a label");
    assert_eq!(label.matched, matched);
    assert_eq!(label.resolution, Resolution::Single);
}

#[test]
fn agreeing_matches_resolve_without_asking_the_model() {
    // The push/fold fold cell and the safety chart grade the same safe tile;
    // an evaluation that agrees with nothing extra must not disturb that.
    let state = generated(ScenarioId::DefenseSafetyChart);
    let matches = classify_all(&state);
    if matches.len() < 2
        || !matches[1..]
            .iter()
            .all(|other| matches[0].same_answer(other))
    {
        return;
    }
    let evaluation = evaluation_for("Pass", None);
    let label = classify_with_mortal(&state, &evaluation)
        .expect("agreeing matches are not a conflict")
        .expect("a label");
    assert_eq!(label.resolution, Resolution::Agreement);
    assert!(label.matched.same_answer(&matches[0]));
}

#[test]
fn mortal_agreement_uses_the_equivalents_and_the_riichi_discard() {
    let state = generated(ScenarioId::DamaImprovingHand);
    let matched = classify(&state, ScenarioId::DamaImprovingHand).expect("the lesson");
    for equivalent in &matched.equivalent_tiles {
        let evaluation = evaluation_for(&format!("Discard_{equivalent}"), None);
        assert!(
            mortal_agrees(&state, &matched, &evaluation),
            "an equivalent discard is agreement"
        );
    }

    let riichi = generated(ScenarioId::RiichiJudgement);
    let matched = classify(&riichi, ScenarioId::RiichiJudgement).expect("the lesson");
    if let CorrectAction::Riichi { discard } = &matched.correct_action {
        let agreeing = evaluation_for("Riichi", Some(discard.as_str()));
        assert!(mortal_agrees(&riichi, &matched, &agreeing));
        let other = evaluation_for("Riichi", Some("1z"));
        assert!(
            discard == "1z" || !mortal_agrees(&riichi, &matched, &other),
            "a different second-pass discard is a disagreement"
        );
    }
}

#[test]
fn a_lesson_without_a_classifier_is_not_recognised() {
    assert!(classifier(ScenarioId::SanshokuPursuit).is_none());
    assert!(
        classify(
            &generated(ScenarioId::RiichiJudgement),
            ScenarioId::SanshokuPursuit
        )
        .is_none()
    );
    assert!(transform_policy(ScenarioId::MeldOrNot).is_none());
}

// ---------------------------------------------------------------------------
// Seat rotation.
// ---------------------------------------------------------------------------

/// Rotate every seat by `steps`, keeping the actors attached to their tiles.
///
/// This is the replay walker's normalisation, expressed as a pure table
/// transform for the test only: winds, scores, hands, rivers, melds and the
/// decision references all move with the player. `rotate(rotate(state, k), 4-k)`
/// is the identity, and rotating a state whose human is not at seat 0 must not
/// classify until it is normalised back.
fn rotate(state: &GameState, steps: usize) -> GameState {
    let steps = steps % 4;
    let mut rotated = state.clone();
    if steps == 0 {
        return rotated;
    }
    let players = state.players.clone();
    for (index, player) in players.iter().enumerate() {
        let mut moved = player.clone();
        moved.seat = (index + steps) % 4;
        moved.wind = player.wind.next(steps);
        let seat = moved.seat;
        rotated.players[seat] = moved;
    }
    // Rivers are indexed by seat, so the rotation is already in the players.
    rotated.current_turn = (state.current_turn + steps) % 4;
    rotated.decision = match &state.decision {
        crate::state::DecisionContext::SelfTurn => crate::state::DecisionContext::SelfTurn,
        crate::state::DecisionContext::ReactToDiscard { from, tile } => {
            crate::state::DecisionContext::ReactToDiscard {
                from: (from + steps) % 4,
                tile: tile.clone(),
            }
        }
        crate::state::DecisionContext::ReactToKan { from, tile } => {
            crate::state::DecisionContext::ReactToKan {
                from: (from + steps) % 4,
                tile: tile.clone(),
            }
        }
    };
    if let Some(offer) = &mut rotated.call_offer {
        // A call offer names tiles, not seats; nothing to remap.
        let _ = offer;
    }
    for player in &mut rotated.players {
        if let Some(meld) = player.melds.first_mut()
            && let Some(from) = &mut meld.called_from
        {
            *from = (*from + steps) % 4;
        }
    }
    rotated
}

#[test]
fn rotation_round_trips_to_the_same_table() {
    let state = generated(ScenarioId::RiichiJudgement);
    for steps in 1..4 {
        let round_trip = rotate(&rotate(&state, steps), 4 - steps);
        assert_eq!(round_trip, state, "rotation {steps} did not round-trip");
    }
}

#[test]
fn classification_is_rotation_invariant_after_seat_normalisation() {
    for &lesson in B1_LESSONS {
        let state = generated(lesson);
        let original = classify_all(&state);
        for steps in 1..4 {
            // Normalisation: the actor comes back to seat 0, which is the
            // round trip the walker guarantees before a state reaches a
            // classifier.
            let normalised = rotate(&rotate(&state, steps), 4 - steps);
            assert_eq!(
                classify_all(&normalised),
                original,
                "{}: rotation {steps} changed the label",
                lesson.as_str()
            );

            // Mid-rotation the actor is not at seat 0 and there is no answer to
            // give; the classifier must not silently read another player's
            // hand.
            let rotated = rotate(&state, steps);
            assert!(
                classify(&rotated, lesson).is_none(),
                "{}: an unnormalised table must not classify",
                lesson.as_str()
            );
        }
    }
}
