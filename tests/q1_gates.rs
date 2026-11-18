//! Q1 gate matrix: one failing test per hard gate.
//!
//! The acceptance harness in `scripts/check-pipeline-e2e.sh` proves the happy
//! path on fixtures. This file proves the gates fail closed when the same
//! artifacts are corrupted, so a green pipeline cannot mean "nothing was
//! checked". Each test names the gate ID from `replay-implementation-plan.md`
//! §7.2.
//!
//! The offline corpus-family report (G3) has no fixture runner in this repo
//! (C1–C8 live in `riichiprac-corpus`); the closest fixture check here is the
//! provenance family-slug rule, which is the part every fixture-driven run
//! depends on. The loader gate (G9) is the frontend suite; Q1 runs it through
//! `scripts/check-pipeline-e2e.sh`.

#![cfg(feature = "miner")]

use riichiprac::classifier::{TransformPolicy, classify};
use riichiprac::generator::{ScenarioId, generate_puzzle, validate_reachable_state};
use riichiprac::miner::label::cache::LabelCache;
use riichiprac::miner::label::fixture::FixtureEvaluator;
use riichiprac::miner::label::{CLASSIFIER_VERSION, LabelDisposition, LabelOptions, label_state};
use riichiprac::miner::pack::{
    PackAuditContext, PackBudget, PackFindingCode, audit_pack, decode_pack, encode_pack,
    fixture_games, fixture_pack,
};
use std::collections::BTreeMap;

use riichiprac::miner::select::gate::check_answer_legal;
use riichiprac::miner::storage::{
    DataRoot, open_miner_db, plan_replay_backup, snapshot_database, validate_relative_path,
};
use riichiprac::miner::variant::VariantLabelKind;
use riichiprac::miner::variant::gate::{GateDeps, check};
use riichiprac::miner::variant::plan::plan_for;
use riichiprac::miner::variant::rehearsal::rehearsal_bases;
use riichiprac::replay::mjai::ReplayReader;
use riichiprac::state::{CorrectAction, GameState};

const PINNED: &str = "2026-11-17T00:00:00Z";

fn fixture_state(lesson: ScenarioId) -> GameState {
    riichiprac::rng::seed(0x5eed_2026);
    generate_puzzle(lesson.as_str()).expect("fixture state")
}

fn a_tile_not_in_hand(state: &GameState) -> String {
    let hand = &state.players[0];
    let used: std::collections::BTreeSet<&str> = hand
        .hand
        .iter()
        .chain(hand.draw.iter())
        .map(String::as_str)
        .collect();
    ["1m", "2m", "3m", "4m", "5m", "6m", "7m", "8m", "9m"]
        .into_iter()
        .chain(["1p", "2p", "3p", "4p", "5p", "6p", "7p", "8p", "9p"])
        .chain(["1s", "2s", "3s", "4s", "5s", "6s", "7s", "8s", "9s"])
        .chain(["1z", "2z", "3z", "4z", "5z", "6z", "7z"])
        .find(|tile| !used.contains(tile))
        .expect("a state never uses all 34 tile kinds")
        .to_string()
}

#[test]
fn g0_source_and_provenance_fail_closed() {
    // The source kind is a one-value allowlist and unknown values do not parse.
    assert!(riichiprac::miner::SourceKind::parse("tenhou").is_err());
    assert!(riichiprac::miner::SourceKind::parse("ai_selfplay").is_ok());

    // A pack body with a non-self-play source does not even deserialize.
    let pack = fixture_pack(PINNED).expect("fixture pack");
    let bytes = encode_pack(&pack).expect("encode").bytes;
    let mut json: serde_json::Value = serde_json::from_slice(&gunzip(&bytes)).expect("pack json");
    json["source"]["kind"] = serde_json::Value::String("tenhou_houou".to_string());
    let tampered = gzip(json.to_string().as_bytes());
    assert!(decode_pack(&tampered).is_err());

    // Provenance with an invalid family slug is a hard rejection.
    let mut game = fixture_games().remove(0);
    game.family = "Mortal Mirror".to_string();
    assert!(game.validate().is_err());
}

#[test]
fn g1_parser_rejects_malformed_jsonl() {
    let error = ReplayReader::read_jsonl("not json at all\n").expect_err("must reject");
    assert!(format!("{error}").to_lowercase().contains("json"));
}

#[test]
fn g2_reconstruction_rejects_an_impossible_table() {
    let mut state = fixture_state(ScenarioId::FoldToRiichi);
    state.players[1].hand.clear();
    state.players[1].draw = None;
    assert!(
        validate_reachable_state(&state).is_err(),
        "an opponent with no concealed tiles is not reachable"
    );
}

#[test]
fn g3_a_corpus_family_must_be_a_slug() {
    let mut game = fixture_games().remove(0);
    game.family = "mortalmirror".to_string();
    game.log.path = DataRoot::replay_relative_path("mortalmirror", &game.replay_id)
        .expect("a valid family builds a path");
    assert!(game.validate().is_ok());
    game.family = "mortal/mirror".to_string();
    assert!(game.validate().is_err());
}

#[test]
fn g4_classifier_positive_and_near_miss() {
    let state = fixture_state(ScenarioId::FoldToRiichi);
    assert!(
        classify(&state, ScenarioId::FoldToRiichi).is_some(),
        "the generated fold scenario must match its classifier"
    );

    // Remove the threat: there is nothing to fold against.
    let mut near_miss = state.clone();
    for player in &mut near_miss.players[1..] {
        player.is_riichi = false;
        player.riichi_discard_index = None;
    }
    assert!(
        classify(&near_miss, ScenarioId::FoldToRiichi).is_none(),
        "a table with no riichi threat is not a fold drill"
    );
}

#[test]
fn g5_label_cache_hits_and_q_values_are_kept() {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = DataRoot::new(temp.path().join("data")).expect("root");
    let connection = open_miner_db(&root).expect("db");
    let cache = LabelCache::new(&connection);
    let evaluator = FixtureEvaluator::new();
    let options = LabelOptions::default();
    let state = fixture_state(ScenarioId::FoldToRiichi);
    let first = label_state(
        &cache,
        &evaluator,
        &state,
        false,
        &options,
        CLASSIFIER_VERSION,
        None,
    )
    .expect("first label");
    assert!(matches!(first, LabelDisposition::Labelled(_)));
    assert!(first.label().q_gap_top2.is_some());
    let second = label_state(
        &cache,
        &evaluator,
        &state,
        false,
        &options,
        CLASSIFIER_VERSION,
        None,
    )
    .expect("second label");
    assert!(
        matches!(second, LabelDisposition::Cached(_)),
        "a rerun must not re-evaluate a finished state"
    );
}

#[test]
fn g6_selection_rejects_an_illegal_answer() {
    let state = fixture_state(ScenarioId::FoldToRiichi);
    let illegal = CorrectAction::discard(a_tile_not_in_hand(&state));
    let (code, _) = check_answer_legal(&state, &illegal, &[]).expect_err("illegal must fail");
    assert_eq!(code, "answer_not_in_hand");
}

#[test]
fn g7_variant_gate_rejects_a_changed_answer() {
    let rehearsal = rehearsal_bases(4).expect("rehearsal");
    let cuts = riichiprac::miner::label::thresholds::PercentileCuts::build(
        &riichiprac::miner::label::thresholds::PercentileConfig::default(),
        &BTreeMap::new(),
    )
    .expect("cuts");
    let deps = GateDeps {
        labeler: None,
        cuts: &cuts,
        classifier_version: CLASSIFIER_VERSION,
    };
    let mut preserved = None;
    for base in &rehearsal.bases {
        if base.label.kind != VariantLabelKind::Book {
            continue;
        }
        let policy = base.policy(TransformPolicy::DENY);
        for plan in plan_for(base.id().as_str(), policy, "q1-gate", 4) {
            if let Ok(gated) = check(base, &plan.chain, &deps) {
                preserved = Some((base.clone(), plan.chain, gated));
                break;
            }
        }
        if preserved.is_some() {
            break;
        }
    }
    let (base, chain, gated) = preserved.expect("at least one rehearsal chain must be preserved");
    assert!(gated.label_check.preserved);

    let mut corrupted = base.clone();
    corrupted.scenario.accepted = vec!["1z".to_string()];
    let rejected = check(&corrupted, &chain, &deps).expect_err("a changed answer set must fail");
    assert_eq!(rejected.code, "answer_changed");
}

#[test]
fn g8_pack_audit_rejects_a_bad_source_licence_answer_spoiler_and_budget() {
    let games = fixture_games();
    let pack = fixture_pack(PINNED).expect("fixture pack");
    let clean = audit_pack(&pack, &PackAuditContext::new(&games)).expect("audit");
    assert!(clean.is_clean(), "the fixture pack must start clean");

    let mut bad_licence = pack.clone();
    bad_licence.source.licence = "WTFPL".to_string();
    let audit = audit_pack(&bad_licence, &PackAuditContext::new(&games)).expect("audit");
    assert!(!audit.is_clean());
    assert!(
        audit
            .findings
            .iter()
            .any(|finding| finding.code == PackFindingCode::DataLicenceNotAllowed)
    );

    let mut spoiler = pack.clone();
    let answer = spoiler.scenarios[0]
        .correct_action
        .tile()
        .expect("a fixture scenario answers with a tile")
        .to_string();
    spoiler.scenarios[0].title = format!("Discard the {answer}");
    let audit = audit_pack(&spoiler, &PackAuditContext::new(&games)).expect("audit");
    assert!(!audit.is_clean());

    let mut illegal = pack.clone();
    let tile = a_tile_not_in_hand(&illegal.scenarios[0].state);
    illegal.scenarios[0].correct_action = CorrectAction::discard(tile.clone());
    illegal.scenarios[0].state.correct_action = CorrectAction::discard(tile);
    illegal.scenarios[0].accepted = Vec::new();
    let audit = audit_pack(&illegal, &PackAuditContext::new(&games)).expect("audit");
    assert!(!audit.is_clean());

    let audit = audit_pack(
        &pack,
        &PackAuditContext::new(&games).with_budget(PackBudget::with_max_bytes(1)),
    )
    .expect("audit");
    assert!(!audit.is_clean());

    // Missing provenance is a hard failure, not a warning.
    let audit = audit_pack(&pack, &PackAuditContext::new(&[])).expect("audit");
    assert!(!audit.is_clean());
}

#[test]
fn g11_storage_snapshot_integrity_and_content_addressed_paths() {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = DataRoot::new(temp.path().join("data")).expect("root");
    root.ensure_layout().expect("layout");
    let connection = open_miner_db(&root).expect("db");
    let snapshot = snapshot_database(&connection, &root.snapshots_dir().join("check.sqlite"))
        .expect("snapshot");
    assert!(snapshot.bytes > 0);
    assert_eq!(snapshot.sha256.len(), 64);
    let check = rusqlite::Connection::open(&snapshot.path).expect("snapshot opens");
    let integrity: String = check
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .expect("integrity");
    assert_eq!(integrity, "ok");

    let replay = riichiprac::miner::ReplayId::from_bytes(b"q1 fixture");
    let path = DataRoot::replay_relative_path("mortal_mirror", &replay).expect("path");
    assert!(path.ends_with(".jsonl.gz"));
    assert!(validate_relative_path(&path).is_ok());
    assert!(validate_relative_path("../escape.jsonl.gz").is_err());
    let outcome = plan_replay_backup(&root, None);
    assert!(
        outcome.is_skipped(),
        "no remote means skipped, not a fake success"
    );
}

fn gzip(bytes: &[u8]) -> Vec<u8> {
    use std::io::Write;
    let mut encoder = flate2::GzBuilder::new()
        .mtime(0)
        .write(Vec::new(), flate2::Compression::default());
    encoder.write_all(bytes).expect("gzip");
    encoder.finish().expect("gzip")
}

fn gunzip(bytes: &[u8]) -> Vec<u8> {
    use std::io::Read;
    let mut decoder = flate2::read::MultiGzDecoder::new(bytes);
    let mut out = Vec::new();
    decoder.read_to_end(&mut out).expect("gunzip");
    out
}
