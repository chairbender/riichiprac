//! L1 unit tests: state hashing, Q gaps, safe-gap source, book agreement and
//! the label cache. The two checkpoint-dependent tests skip with an explicit
//! message when the (uncommitted) Mortal weights are absent.

use std::cell::Cell;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use rusqlite::Connection;

use super::cache::{CacheLookup, LabelCache, LabelKey};
use super::*;
use crate::ai::actions::legal_actions;
use crate::ai::wasm_bridge::evaluate_state_named;
use crate::decision::{ActionEvaluation, ActionInfo, ActionKind};
use crate::miner::classifier::classify_decision;
use crate::miner::provenance::ReplayId;
use crate::miner::storage::migrate;
use crate::replay::fixtures;
use crate::replay::mjai::{EventKind, ReplayReader};
use crate::replay::walk::{DecisionSnapshot, ReplayWalk, walk_replay};
use crate::report::mortal_action_for_correct;
use crate::state::{GameState, TargetAction};

pub(super) fn walk(events: &[EventKind]) -> ReplayWalk {
    let text = fixtures::to_jsonl(events);
    let bytes = fixtures::gzip(&text);
    let file = ReplayReader::read_gzip(&bytes).expect("fixture must parse");
    walk_replay(&file, ReplayId::from_bytes(&bytes)).expect("fixture must validate")
}

pub(super) fn identity() -> ModelIdentity {
    ModelIdentity {
        model: "mortal_298k.safetensors".to_string(),
        model_sha256: "a".repeat(64),
        gamma: None,
        pts: None,
    }
}

/// A softmax over a caller-supplied Q function, ordered like the real bridge.
fn canned_evaluation(
    state: &GameState,
    identity: &ModelIdentity,
    q: &dyn Fn(&ActionInfo) -> f32,
) -> Evaluation {
    let mut scored: Vec<ActionEvaluation> = legal_actions(state)
        .into_iter()
        .map(|info| {
            let q_value = q(&info);
            ActionEvaluation {
                info,
                probability: 0.0,
                q_value: Some(q_value),
            }
        })
        .collect();
    let max_q = scored
        .iter()
        .map(|scored| scored.q_value.expect("q value"))
        .fold(f32::NEG_INFINITY, f32::max);
    let total: f32 = scored
        .iter()
        .map(|scored| (scored.q_value.expect("q value") - max_q).exp())
        .sum();
    for scored in &mut scored {
        scored.probability = (scored.q_value.expect("q value") - max_q).exp() / total;
    }
    scored.sort_by(|left, right| {
        right
            .probability
            .total_cmp(&left.probability)
            .then_with(|| left.info.action.cmp(&right.info.action))
    });
    let recommended_action = scored
        .first()
        .expect("a state always offers one legal action")
        .info
        .action
        .clone();
    Evaluation {
        model: identity.model.clone(),
        expected_value: -0.25,
        recommended_action,
        riichi_discard: None,
        evaluations: scored,
    }
}

pub(super) struct CannedEvaluator {
    identity: ModelIdentity,
    q: Box<dyn Fn(&ActionInfo) -> f32>,
    fail: Cell<bool>,
    calls: Cell<usize>,
}

impl CannedEvaluator {
    pub(super) fn new(q: impl Fn(&ActionInfo) -> f32 + 'static) -> Self {
        Self {
            identity: identity(),
            q: Box::new(q),
            fail: Cell::new(false),
            calls: Cell::new(0),
        }
    }

    pub(super) fn calls(&self) -> usize {
        self.calls.get()
    }
}

impl StateEvaluator for CannedEvaluator {
    fn identity(&self) -> &ModelIdentity {
        &self.identity
    }

    fn evaluate(&self, state: &GameState) -> Result<Evaluation, LabelError> {
        self.calls.set(self.calls.get() + 1);
        if self.fail.get() {
            return Err(LabelError::Evaluation("canned failure".to_string()));
        }
        Ok(canned_evaluation(state, &self.identity, self.q.as_ref()))
    }
}

fn memory_db() -> Connection {
    let connection = Connection::open_in_memory().expect("memory db");
    migrate(&connection).expect("migrate");
    connection
}

pub(super) fn weights_path() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("RIICHI_MORTAL_WEIGHTS")
        && !path.trim().is_empty()
    {
        return Some(PathBuf::from(path));
    }
    let default = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("frontend/public/models/mortal_298k.safetensors");
    default.exists().then_some(default)
}

fn skip_without_weights(test: &str) -> Option<PathBuf> {
    match weights_path() {
        Some(path) => Some(path),
        None => {
            eprintln!(
                "skipping {test}: the Mortal checkpoint is not present. \
                 Set RIICHI_MORTAL_WEIGHTS=/path/mortal_298k.safetensors or place \
                 frontend/public/models/mortal_298k.safetensors. The weights are gitignored."
            );
            None
        }
    }
}

#[test]
fn the_state_hash_covers_the_model_visible_position_only() {
    let replay = walk(&fixtures::exhaustive_game(7));
    let state = &replay.decisions[0].state;
    let base = state_hash(state);

    // Scenario metadata and derived metrics are not part of the observation, so
    // re-stamping a state must not invalidate its cached evaluation.
    let mut restamped = state.clone();
    restamped.category = "another_lesson".to_string();
    restamped.target_action = TargetAction::Fold;
    restamped.correct_action = crate::state::CorrectAction::fold("1z");
    restamped.equivalent_tiles = vec!["2z".to_string()];
    restamped.scenario_note = Some("note".to_string());
    restamped.book_rationale = None;
    restamped.tiles.clear();
    restamped.hand_string.clear();
    restamped.ukeire_total = 0;
    restamped.decompositions_count = 0;
    assert_eq!(
        state_hash(&restamped),
        base,
        "scenario metadata and display metrics must not change the model-visible hash"
    );

    // The derived shanten/waits ARE part of what the network sees (the encoder
    // reads them), so the hash changes when they do — that is the honest
    // boundary, and the walker recomputes them from the same hand.
    let mut reanalyzed = state.clone();
    reanalyzed.shanten = state.shanten.saturating_add(1);
    assert_ne!(state_hash(&reanalyzed), base);

    // A different table position must.
    let mut moved = state.clone();
    let original = moved.players[0].hand[0].clone();
    moved.players[0].hand[0] = if original == "1z" { "2z" } else { "1z" }.to_string();
    assert_ne!(state_hash(&moved), base);

    // The hash is stable across a JSON round trip (the cache is persisted).
    let json = serde_json::to_string(state).expect("state serializes");
    let decoded: GameState = serde_json::from_str(&json).expect("state decodes");
    assert_eq!(state_hash(&decoded), base);
}

#[test]
fn a_label_records_identity_units_and_both_q_gaps() {
    let replay = walk(&fixtures::exhaustive_game(7));
    let snapshot = &replay.decisions[0];
    // A distinct, ordered Q value so top-2 and top-1 are unambiguous.
    let evaluator = CannedEvaluator::new(|info| -(info.tile_index.unwrap_or(0) as f32) * 0.1);
    let label = build_label(
        &evaluator,
        snapshot,
        &LabelOptions::default(),
        CLASSIFIER_VERSION,
        None,
    )
    .expect("label builds");

    let model = evaluator.identity();
    assert_eq!(label.schema, crate::miner::MODEL_LABEL_SCHEMA);
    assert_eq!(label.model, model.model);
    assert_eq!(label.model_sha256, model.model_sha256);
    assert_eq!(label.q_units, "model_utility");
    assert_eq!(label.value_units, "model_utility");
    assert_eq!(label.q_values.len(), label.ranking.len());
    assert_eq!(label.top_action, label.ranking[0].action);
    assert!(
        (label.q_gap_top2.expect("two actions")
            - (label.ranking[0].q_value.unwrap() - label.ranking[1].q_value.unwrap()))
        .abs()
            < 1e-6
    );
    assert!(
        (label.probability_margin - (label.ranking[0].probability - label.ranking[1].probability))
            .abs()
            < 1e-6
    );
    // Q units are never points.
    assert!(label.note.contains("not points"));
    let json = serde_json::to_value(&label).expect("label serializes");
    assert_eq!(json["q_units"], "model_utility");
    assert!(
        !json
            .as_object()
            .expect("label object")
            .keys()
            .any(|key| key.contains("point")),
        "no label field may claim points: {json}"
    );

    // The label round-trips through the cache representation.
    let text = serde_json::to_string(&label).expect("label to string");
    let back: ModelLabel = serde_json::from_str(&text).expect("label from string");
    assert_eq!(back, label);
}

#[test]
fn the_q_values_are_the_softmax_input_and_the_q_units_stay_raw() {
    let replay = walk(&fixtures::exhaustive_game(7));
    let snapshot = &replay.decisions[0];
    let evaluator = CannedEvaluator::new(|info| -(info.tile_index.unwrap_or(0) as f32) * 0.05);
    let label = build_label(
        &evaluator,
        snapshot,
        &LabelOptions::default(),
        CLASSIFIER_VERSION,
        None,
    )
    .expect("label builds");

    let max_q = label
        .q_values
        .values()
        .copied()
        .fold(f32::NEG_INFINITY, f32::max);
    let total: f32 = label.q_values.values().map(|q| (q - max_q).exp()).sum();
    for ranked in &label.ranking {
        let q = ranked.q_value.expect("q value");
        let expected = (q - max_q).exp() / total;
        assert!(
            (ranked.probability - expected).abs() < 1e-6,
            "{}: probability {} is not softmax({q})",
            ranked.action,
            ranked.probability
        );
    }
}

#[test]
fn the_safe_gap_is_measured_against_the_book_safety_chart() {
    use crate::safety::SafetyFacts;
    use crate::state::DiscardTile;
    use agari::tile::Tile as SafetyTile;

    // Find a position with at least one legal discard that is NOT absolutely
    // safe, so the top action and the safe action can be different tiles.
    let mut found = None;
    for seed in 0..64 {
        let replay = walk(&fixtures::exhaustive_game(seed));
        for snapshot in &replay.decisions {
            let mut state = snapshot.state.clone();
            let legal = legal_actions(&state);
            let Some(genbutsu) = legal.iter().find_map(|info| {
                (info.kind == ActionKind::Discard)
                    .then(|| info.tile.clone())
                    .flatten()
            }) else {
                continue;
            };
            let Some(unsafe_tile) = legal.iter().find_map(|info| {
                (info.kind == ActionKind::Discard)
                    .then(|| info.tile.clone())
                    .flatten()
                    .filter(|tile| *tile != genbutsu)
            }) else {
                continue;
            };

            // Seat 1 declares Riichi with `genbutsu` in its river.
            let threat = &mut state.players[1];
            threat.is_riichi = true;
            threat.riichi_discard_index = None;
            threat.discards = vec![DiscardTile::new(genbutsu.clone())];
            let threat_seat = threat.seat;

            let facts = SafetyFacts::from_state(&state, threat_seat).expect("facts");
            let safe_tile = SafetyTile::try_from(genbutsu.as_str()).expect("tile");
            let unsafe_tile = SafetyTile::try_from(unsafe_tile.as_str()).expect("tile");
            if !facts.is_absolutely_safe(safe_tile) || facts.is_absolutely_safe(unsafe_tile) {
                continue;
            }
            found = Some((snapshot.clone(), state, genbutsu, unsafe_tile.to_string()));
            break;
        }
        if found.is_some() {
            break;
        }
    }
    let (snapshot, state, genbutsu, unsafe_tile) =
        found.expect("a fixture position with one safe and one unsafe discard");

    let safe_code = genbutsu.clone();
    let q = move |info: &ActionInfo| {
        if info.kind != ActionKind::Discard {
            return -3.0;
        }
        match info.tile.as_deref() {
            Some(tile) if tile == safe_code => -2.0,
            Some(tile) if tile == unsafe_tile => -0.1,
            _ => -3.0,
        }
    };
    let evaluator = CannedEvaluator::new(q);
    let label = build_label(
        &evaluator,
        &DecisionSnapshot {
            state,
            ..snapshot.clone()
        },
        &LabelOptions::default(),
        CLASSIFIER_VERSION,
        None,
    )
    .expect("label builds");

    assert_ne!(
        label.top_action,
        label.safe_action.clone().unwrap_or_default(),
        "the test needs a top action the chart does not call safe"
    );
    assert_eq!(label.safe_action, Some(format!("Discard_{genbutsu}")));
    let gap = label.q_gap_safe.expect("safe gap");
    assert!(
        (gap - (-0.1 - -2.0)).abs() < 1e-6,
        "q_gap_safe {gap} is not q(best) - q(safest)"
    );

    // Without an active threat there is no safe gap at all, even though the
    // same tile is legal.
    let mut calm = DecisionSnapshot {
        state: snapshot.state.clone(),
        ..snapshot.clone()
    };
    for player in &mut calm.state.players {
        player.is_riichi = false;
    }
    let label = build_label(
        &evaluator,
        &calm,
        &LabelOptions::default(),
        CLASSIFIER_VERSION,
        None,
    )
    .expect("label builds");
    assert_eq!(label.q_gap_safe, None);
    assert_eq!(label.safe_action, None);
}

#[test]
fn the_book_half_uses_the_classifier_and_compare_action_set() {
    let replay = walk(&fixtures::all_events_game());
    let mut checked = 0;
    for snapshot in &replay.decisions {
        let Ok(Some(matched)) = classify_decision(snapshot) else {
            continue;
        };
        let book_action = mortal_action_for_correct(&matched.correct_action);
        let agreeing = CannedEvaluator::new(move |info: &ActionInfo| {
            if info.action == book_action {
                0.0
            } else {
                -1.0
            }
        });
        let label = build_label(
            &agreeing,
            snapshot,
            &LabelOptions::default(),
            CLASSIFIER_VERSION,
            None,
        )
        .expect("label builds");
        let Some(book) = label.book else {
            // A ch. 7 conflict the model cannot settle stays a conflict; try
            // the next recognisable decision.
            continue;
        };
        assert_eq!(book.lesson, matched.lesson.as_str());
        assert_eq!(book.accepted, matched.answer_set());
        assert_eq!(book.agreement.outcome, "agrees");
        assert_eq!(book.agreement.model_action, label.top_action);
        checked += 1;
    }
    assert!(
        checked > 0,
        "the fixture must contain at least one book label"
    );
}

#[test]
fn a_disagreeing_model_is_recorded_as_a_discrepancy() {
    let replay = walk(&fixtures::all_events_game());
    let mut checked = 0;
    for snapshot in &replay.decisions {
        let Ok(Some(matched)) = classify_decision(snapshot) else {
            continue;
        };
        let book_action = mortal_action_for_correct(&matched.correct_action);
        let rejected = book_action.clone();
        // Every action Mortal likes better than the book answer: the book's
        // riichi/dama cell is the one family this fixture exercises.
        let disagreeing = CannedEvaluator::new(
            move |info: &ActionInfo| {
                if info.action == rejected { -1.0 } else { 0.0 }
            },
        );
        let label = build_label(
            &disagreeing,
            snapshot,
            &LabelOptions::default(),
            CLASSIFIER_VERSION,
            None,
        )
        .expect("label builds");
        let Some(book) = label.book else {
            continue;
        };
        assert_ne!(book.agreement.outcome, "agrees");
        assert_eq!(book.agreement.outcome, "discrepancy");
        assert_eq!(
            book.agreement.discrepancy_kind.as_deref(),
            Some("expected_action_wrong"),
            "a Riichi-versus-discard disagreement is an action discrepancy"
        );
        assert_eq!(book.agreement.book_action, book_action);
        checked += 1;
    }
    assert!(
        checked > 0,
        "the fixture must contain a book label to disagree with"
    );
}

#[test]
fn the_ranking_is_the_snapshots_legal_actions_in_mortal_order() {
    // A call decision, so the call mapping through `legal_actions` is covered.
    let replay = walk(&fixtures::exhaustive_game(3));
    let snapshot = replay
        .of_kind(crate::replay::DecisionKind::Call)
        .next()
        .expect("the fixture has a call decision");
    let evaluator = CannedEvaluator::new(|info| {
        if info.kind == ActionKind::Pass {
            0.0
        } else {
            -1.0
        }
    });
    let label = build_label(
        &evaluator,
        snapshot,
        &LabelOptions::default(),
        CLASSIFIER_VERSION,
        None,
    )
    .expect("label builds");

    let legal: BTreeMap<&str, ActionKind> = snapshot
        .legal_actions
        .iter()
        .map(|info| (info.action.as_str(), info.kind))
        .collect();
    for ranked in &label.ranking {
        assert_eq!(
            legal.get(ranked.action.as_str()).copied(),
            Some(ranked.kind),
            "{} is not a legal action mapped from legal_actions",
            ranked.action
        );
    }
    assert_eq!(label.ranking.len(), snapshot.legal_actions.len());
    assert!(
        label
            .ranking
            .iter()
            .any(|ranked| ranked.kind != ActionKind::Discard),
        "a call decision's ranking must include the call/pass actions"
    );
}

#[test]
fn a_generator_identity_is_recorded_only_when_it_differs() {
    let replay = walk(&fixtures::exhaustive_game(7));
    let snapshot = &replay.decisions[0];
    let evaluator = CannedEvaluator::new(|_| 0.0);

    let same = build_label(
        &evaluator,
        snapshot,
        &LabelOptions::default(),
        CLASSIFIER_VERSION,
        Some(&identity()),
    )
    .expect("label builds");
    assert_eq!(
        same.generator, None,
        "the labeler's own identity is not a generator record"
    );

    let other = ModelIdentity {
        model: "akochan-1.0".to_string(),
        model_sha256: "b".repeat(64),
        gamma: None,
        pts: None,
    };
    let different = build_label(
        &evaluator,
        snapshot,
        &LabelOptions::default(),
        CLASSIFIER_VERSION,
        Some(&other),
    )
    .expect("label builds");
    assert_eq!(different.generator.as_ref(), Some(&other));
}

#[test]
fn the_cache_key_covers_state_model_classifier_and_options() {
    let replay = walk(&fixtures::exhaustive_game(7));
    let state = &replay.decisions[0].state;
    let options = LabelOptions::default();
    let base = LabelKey::new(state, &identity(), CLASSIFIER_VERSION, &options);

    let mut other_model = identity();
    other_model.model_sha256 = "b".repeat(64);
    assert_ne!(
        LabelKey::new(state, &other_model, CLASSIFIER_VERSION, &options),
        base
    );
    assert_ne!(LabelKey::new(state, &identity(), "2", &options), base);
    assert_ne!(
        LabelKey::new(
            state,
            &identity(),
            CLASSIFIER_VERSION,
            &LabelOptions {
                q_values: true,
                safe_gap: false,
            },
        ),
        base
    );

    let mut other_state = state.clone();
    other_state.players[0].hand[0] = if other_state.players[0].hand[0] == "1z" {
        "2z".to_string()
    } else {
        "1z".to_string()
    };
    assert_ne!(
        LabelKey::new(&other_state, &identity(), CLASSIFIER_VERSION, &options),
        base
    );

    // The options hash is stable and option-order independent.
    assert_eq!(
        options.options_hash(),
        LabelOptions::default().options_hash()
    );
}

#[test]
fn a_finished_label_is_never_re_evaluated_and_a_failure_is_retried() {
    let connection = memory_db();
    let cache = LabelCache::new(&connection);
    let evaluator = CannedEvaluator::new(|info| -(info.tile_index.unwrap_or(0) as f32));
    let options = LabelOptions::default();

    let first_walk = walk(&fixtures::exhaustive_game(7));
    let first = &first_walk.decisions[0];
    let labelled = label_decision(
        &cache,
        &evaluator,
        first,
        &options,
        CLASSIFIER_VERSION,
        None,
    )
    .expect("first label");
    assert!(matches!(labelled, LabelDisposition::Labelled(_)));
    assert_eq!(evaluator.calls(), 1);

    let cached = label_decision(
        &cache,
        &evaluator,
        first,
        &options,
        CLASSIFIER_VERSION,
        None,
    )
    .expect("cached label");
    assert!(matches!(cached, LabelDisposition::Cached(_)));
    assert_eq!(
        evaluator.calls(),
        1,
        "a finished state must not be re-evaluated"
    );
    assert_eq!(cached.label(), labelled.label());

    // A different option set is a different key: it evaluates again.
    let no_safe_gap = LabelOptions {
        q_values: true,
        safe_gap: false,
    };
    assert!(matches!(
        label_decision(
            &cache,
            &evaluator,
            first,
            &no_safe_gap,
            CLASSIFIER_VERSION,
            None
        )
        .expect("option variant"),
        LabelDisposition::Labelled(_)
    ));
    assert_eq!(evaluator.calls(), 2);

    // A failure is recorded and retried; the retry is reported as such.
    let other_walk = walk(&fixtures::exhaustive_game(11));
    let other = &other_walk.decisions[0];
    assert_ne!(
        super::state_hash(&first.state),
        super::state_hash(&other.state)
    );
    evaluator.fail.set(true);
    assert!(
        label_decision(
            &cache,
            &evaluator,
            other,
            &options,
            CLASSIFIER_VERSION,
            None
        )
        .is_err()
    );
    let key = LabelKey::new(
        &other.state,
        evaluator.identity(),
        CLASSIFIER_VERSION,
        &options,
    );
    match cache.lookup(&key).expect("lookup") {
        CacheLookup::Failed { attempts, error } => {
            assert_eq!(attempts, 1);
            assert!(error.expect("recorded error").contains("canned failure"));
        }
        other => panic!("expected a failure row, got {other:?}"),
    }

    evaluator.fail.set(false);
    let retried = label_decision(
        &cache,
        &evaluator,
        other,
        &options,
        CLASSIFIER_VERSION,
        None,
    )
    .expect("retry succeeds");
    assert!(matches!(retried, LabelDisposition::Retried(_)));
    assert_eq!(evaluator.calls(), 4);

    // The cache counts finished and failed rows for the run report.
    let (finished, failed) = cache
        .counts(&identity().model_sha256, CLASSIFIER_VERSION, &options)
        .expect("counts");
    assert_eq!(finished, 2);
    assert_eq!(failed, 0);
}

/// G5: exact top-1/ranking parity with the browser's `evaluate_state`.
#[test]
fn label_parity_with_evaluate_state_on_a_fixed_fixture() {
    let Some(weights) = skip_without_weights("label parity test") else {
        return;
    };
    let labeler = Labeler::load(&weights, None, None).expect("checkpoint loads");
    let replay = walk(&fixtures::all_events_game());
    let mut checked = 0_usize;

    for snapshot in &replay.decisions {
        let plain =
            evaluate_state_named(labeler.model(), &snapshot.state, &labeler.identity().model)
                .expect("reference evaluation");
        let label = build_label(
            &labeler,
            snapshot,
            &LabelOptions::default(),
            CLASSIFIER_VERSION,
            None,
        )
        .expect("label builds");

        assert_eq!(label.top_action, plain.recommended_action);
        assert_eq!(label.ranking.len(), plain.evaluations.len());
        for (ranked, scored) in label.ranking.iter().zip(&plain.evaluations) {
            assert_eq!(ranked.action, scored.info.action, "ranking order differs");
            assert_eq!(ranked.kind, scored.info.kind);
            assert!((ranked.probability - scored.probability).abs() < 1e-6);
            assert!(ranked.q_value.expect("q value").is_finite());
        }
        assert_eq!(label.riichi_discard, plain.riichi_discard);
        assert!((label.expected_value - plain.expected_value).abs() < 1e-6);
        if let Some(gap) = label.q_gap_top2 {
            let q0 = label.ranking[0].q_value.expect("q");
            let q1 = label.ranking[1].q_value.expect("q");
            assert!((gap - (q0 - q1)).abs() < 1e-6);
        }
        checked += 1;
    }

    assert!(checked > 0, "the fixture replay must produce decisions");
    println!("label parity checked on {checked} decisions");
}
