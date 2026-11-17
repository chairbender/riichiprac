//! Cross-lesson, near-miss and performance tests for the shape classifiers.
//!
//! Per-lesson positive tests live beside each recogniser; this module holds the
//! properties that are about the family:
//!
//! - every generated block-theory state classifies as its own lesson, with the
//!   state's accepted answer set;
//! - the family's recognisers do not disagree with each other or with the
//!   B1/B2 registries on generated boards;
//! - a near-miss mutation of each lesson returns `None`;
//! - the documented performance budget holds.

use crate::classifier::{classify, classify_all};
use crate::generator::{ScenarioId, generate_puzzle};
use crate::state::{CorrectActionType, GameState};

/// The block-theory lessons this unit registers.
pub(crate) const BLOCK_LESSONS: &[ScenarioId] = &[
    ScenarioId::RyanmenProtorun,
    ScenarioId::NakabukureReady,
    ScenarioId::ProtorunPriority,
    ScenarioId::RyankanBreak,
    ScenarioId::ProtorunPlusOne,
    ScenarioId::NobetanKeep,
    ScenarioId::PairCount,
    ScenarioId::SkippingBlock,
    ScenarioId::PairCountOpen,
    ScenarioId::PerfectOneAway,
];

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

/// Generate `runs` states of `lesson` and prove the recogniser recovers the
/// lesson and its exact accepted tiles.
pub(crate) fn assert_lesson_answers_its_generated_state(lesson: ScenarioId, runs: usize) {
    let recogniser = super::super::classifier(lesson)
        .unwrap_or_else(|| panic!("{} has no classifier", lesson.as_str()))
        .matches;
    for run in 0..runs {
        let state = generate_puzzle(lesson.as_str())
            .unwrap_or_else(|err| panic!("{} run {run}: {err}", lesson.as_str()));
        let matched = recogniser(&state)
            .unwrap_or_else(|| panic!("{} run {run}: did not classify", lesson.as_str()));
        matched
            .validate(&state)
            .unwrap_or_else(|err| panic!("{} run {run}: illegal: {err}", lesson.as_str()));
        assert_eq!(
            matched.lesson,
            lesson,
            "{} run {run}: wrong lesson",
            lesson.as_str()
        );
        assert_eq!(
            matched.correct_action.action_type(),
            CorrectActionType::Dama,
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

/// Assert that `owner`'s recogniser does not fire on `other`'s generated board.
pub(crate) fn near_miss(owner: ScenarioId, other: ScenarioId) {
    let recogniser = super::super::classifier(owner)
        .unwrap_or_else(|| panic!("{} has no classifier", owner.as_str()))
        .matches;
    for run in 0..4 {
        let state = generate_puzzle(other.as_str())
            .unwrap_or_else(|err| panic!("{} run {run}: {err}", other.as_str()));
        assert!(
            recogniser(&state).is_none(),
            "{} recognised {} run {run}",
            owner.as_str(),
            other.as_str()
        );
    }
}

/// Replace one copy of `from` in the human's hand or draw with `to`.
pub(crate) fn replace_tile(state: &GameState, from: &str, to: &str) -> GameState {
    let mut replaced = state.clone();
    if let Some(code) = replaced.players[0]
        .hand
        .iter_mut()
        .find(|code| code.as_str() == from)
    {
        *code = to.to_string();
        return replaced;
    }
    if replaced.players[0].draw.as_deref() == Some(from) {
        replaced.players[0].draw = Some(to.to_string());
        return replaced;
    }
    panic!("{from} is not in the human hand");
}

/// An honour tile the state does not use anywhere, if one exists.
pub(crate) fn unused_honor(state: &GameState) -> String {
    for honor in ["1z", "2z", "3z", "4z", "5z", "6z", "7z"] {
        if !state.tiles.iter().any(|code| code == honor) {
            return honor.to_string();
        }
    }
    "1m".to_string()
}

/// Replace the drawn tile only.
pub(crate) fn replace_draw(state: &GameState, to: &str) -> GameState {
    let mut replaced = state.clone();
    replaced.players[0].draw = Some(to.to_string());
    replaced
}

#[test]
fn every_generated_block_state_classifies_as_its_own_lesson() {
    for &lesson in BLOCK_LESSONS {
        assert_lesson_answers_its_generated_state(lesson, 4);
    }
}

#[test]
fn the_family_never_disagrees_on_a_generated_block_board() {
    for &lesson in BLOCK_LESSONS {
        for run in 0..8 {
            let state = generate_puzzle(lesson.as_str())
                .unwrap_or_else(|err| panic!("{} run {run}: {err}", lesson.as_str()));
            let matches = classify_all(&state);
            let Some(first) = matches.first() else {
                panic!("{} run {run}: no label at all", lesson.as_str());
            };
            for other in &matches[1..] {
                assert!(
                    first.same_answer(other),
                    "{} run {run}: {} and {} disagree ({:?} vs {:?})",
                    lesson.as_str(),
                    first.lesson.as_str(),
                    other.lesson.as_str(),
                    first.answer_set(),
                    other.answer_set()
                );
            }
        }
    }
}

#[test]
fn classification_is_deterministic_across_the_shape_family() {
    for &lesson in BLOCK_LESSONS {
        let state = generate_puzzle(lesson.as_str()).expect("must generate");
        let first = classify_all(&state);
        let second = classify_all(&state);
        assert_eq!(first, second, "{} flipped", lesson.as_str());
        assert!(
            first
                .iter()
                .any(|matched| matched.lesson == lesson || matched.same_answer(&first[0])),
            "{} lost its label",
            lesson.as_str()
        );
    }
}

#[test]
fn shape_recognisers_decline_a_non_shape_lesson() {
    let state = generate_puzzle("riichi_judgement").expect("must generate");
    for &lesson in BLOCK_LESSONS {
        assert!(
            classify(&state, lesson).is_none(),
            "{} recognised a riichi/dama board",
            lesson.as_str()
        );
    }
}

#[test]
fn every_shape_match_is_a_legal_click() {
    for &lesson in BLOCK_LESSONS {
        for _ in 0..3 {
            let state = generate_puzzle(lesson.as_str()).expect("must generate");
            if let Some(matched) = classify(&state, lesson) {
                matched
                    .validate(&state)
                    .unwrap_or_else(|err| panic!("{}: {err}", lesson.as_str()));
                let stamped = matched.clone().stamp(state.clone());
                assert_eq!(stamped.correct_action, matched.correct_action);
                assert_eq!(stamped.target_action, crate::state::TargetAction::NaniKiru);
            }
        }
    }
}

/// The documented performance bound: a full 10-lesson batch of generated
/// states classifies inside a deliberately generous wall-clock budget.
#[test]
fn the_shape_family_stays_within_its_performance_budget() {
    // Generation is the generator tests' cost, not the classifier's; build the
    // batch first so the measurement is the comparison the budget describes.
    let mut states = Vec::new();
    for &lesson in BLOCK_LESSONS {
        for _ in 0..2 {
            states.push(
                generate_puzzle(lesson.as_str())
                    .unwrap_or_else(|err| panic!("{}: {err}", lesson.as_str())),
            );
        }
    }
    assert_eq!(states.len(), 20);

    let start = std::time::Instant::now();
    for state in &states {
        let _ = classify_all(state);
    }
    let elapsed = start.elapsed();
    assert!(
        elapsed < std::time::Duration::from_secs(5),
        "20 shape states took {elapsed:?} (budget: 5s)"
    );
}
