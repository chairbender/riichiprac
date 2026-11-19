//! L1/L2 shard-runner tests: replay discovery, cache skip on rerun, the
//! `decisions` row write including the L2 agreement classification, calibration
//! without re-evaluation, the optional multi-model pass, and one real end-to-end
//! run when the checkpoint is present.

use std::fs;

use rusqlite::params;

use super::*;
use crate::decision::ActionInfo;
use crate::miner::label::ModelLabel;
use crate::miner::label::tests::{CannedEvaluator, calibration_fixture, identity, weights_path};
use crate::miner::provenance::{ReplayId, sha256_hex};
use crate::miner::storage::open_miner_db;
use crate::replay::fixtures;
use crate::replay::mjai::ReplayReader;
use crate::replay::walk::walk_replay;

fn write_replay(root: &DataRoot, family: &str, events: &[crate::replay::EventKind]) -> Vec<u8> {
    let bytes = fixtures::gzip(&fixtures::to_jsonl(events));
    let dir = root.replays_dir().join(family);
    fs::create_dir_all(&dir).expect("family dir");
    fs::write(dir.join(format!("{}.jsonl.gz", sha256_hex(&bytes))), &bytes).expect("replay file");
    bytes
}

#[test]
fn replay_discovery_reads_family_dirs_and_rejects_a_missing_family() {
    let temp = tempfile::tempdir().expect("tempdir");
    let dir = temp.path();
    fs::create_dir_all(dir.join("mortal_mirror")).expect("dir");
    fs::create_dir_all(dir.join("akochan")).expect("dir");
    fs::write(dir.join("mortal_mirror/a.jsonl.gz"), b"x").expect("file");
    fs::write(dir.join("mortal_mirror/notes.txt"), b"x").expect("file");
    fs::write(dir.join("akochan/b.jsonl.gz"), b"x").expect("file");
    fs::write(dir.join("stray.jsonl.gz"), b"x").expect("file");

    let all = discover_replays(dir, None).expect("all families");
    assert_eq!(all.len(), 3, "top-level files count too: {all:?}");

    let family = discover_replays(dir, Some("mortal_mirror")).expect("one family");
    assert_eq!(family.len(), 1);
    assert!(family[0].ends_with("a.jsonl.gz"));

    let error = discover_replays(dir, Some("missing")).expect_err("missing family");
    assert!(matches!(error, LabelError::MissingReplays(_)));
}

#[test]
fn a_shard_writes_the_decision_row_and_a_rerun_never_re_evaluates() {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = DataRoot::new(temp.path().join("data")).expect("data root");
    let bytes = write_replay(&root, "mortal_mirror", &fixtures::all_events_game());
    let replay_id = ReplayId::from_bytes(&bytes);

    // Walk once to learn the first decision id and insert the replay + decision
    // rows ingest/extract would have written.
    let file = ReplayReader::read_gzip(&bytes).expect("fixture parses");
    let walked = walk_replay(&file, replay_id.clone()).expect("fixture validates");
    let first_decision = &walked.decisions[0];
    let connection = open_miner_db(&root).expect("miner db");
    connection
        .execute(
            "INSERT INTO replays (
                replay_id, source, licence, attribution, format, rule,
                rule_config_hash, generated_at, model, model_sha256, seed,
                log_path, log_bytes, log_sha256, validation_status,
                ingested_at, corpus_id, family, match_plan_id,
                match_plan_sha256, agents, provenance_json
             ) VALUES (?1, 'ai_selfplay', 'CC-BY-4.0', 'fixture', 'mjai',
                'tenhou-4p-hanchan', ?2, '2026-11-16T00:00:00Z',
                'akochan-1.0', ?3, '0x01', ?4, ?5, ?6, 'ok',
                '2026-11-16T00:01:00Z', 'mixed-2026-11', 'mortal_mirror',
                'm1', ?7, '[]', '{}')",
            params![
                replay_id.as_str(),
                "b".repeat(64),
                "e".repeat(64),
                format!("replays/mortal_mirror/{}.jsonl.gz", replay_id.as_str()),
                i64::try_from(bytes.len()).expect("fixture size"),
                sha256_hex(&bytes),
                "f".repeat(64),
            ],
        )
        .expect("replay row");
    connection
        .execute(
            "INSERT INTO decisions (
                decision_id, replay_id, family, kyoku, honba, event_index, turn,
                seat, decision_kind, state_hash, state_json, legal_actions,
                played_action
             ) VALUES (?1, ?2, 'mortal_mirror', 0, 0, ?3, 0, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                first_decision.decision_id,
                replay_id.as_str(),
                i64::try_from(first_decision.event_index).expect("index"),
                i64::try_from(first_decision.seat).expect("seat"),
                first_decision.kind.as_str(),
                crate::miner::label::state_hash(&first_decision.state),
                serde_json::to_string(&first_decision.state).expect("state json"),
                serde_json::to_string(&first_decision.legal_actions).expect("legal actions"),
                serde_json::to_string(&first_decision.played).expect("played"),
            ],
        )
        .expect("decision row");

    let evaluator = CannedEvaluator::new(|info| -(info.tile_index.unwrap_or(0) as f32) * 0.1);
    let options = LabelRunOptions::new("unused.safetensors");
    let first = run_shard(&root, &options, &evaluator).expect("first shard run");

    assert_eq!(first.replays_found, 1);
    assert_eq!(first.replays_walked, 1);
    assert_eq!(first.replays_failed, 0);
    assert!(first.decisions_seen > 0);
    assert!(first.decisions_labelled > 0);
    assert_eq!(first.decisions_failed, 0);
    assert_eq!(
        first.decisions_labelled + first.decisions_cached + first.decisions_retried,
        first.decisions_seen
    );
    let calls_after_first = evaluator.calls();
    assert_eq!(calls_after_first, first.decisions_labelled);
    assert_eq!(
        first.stable + first.contested + first.mortal_only + first.book_conflicts,
        first.decisions_seen,
        "every decision must be classified as exactly one L2 kind"
    );
    assert_eq!(
        first.labelers,
        vec![identity().model],
        "one checkpoint, not an ensemble"
    );

    // The extract row now carries the labeler identity, units and Q values.
    let (model, units, q_values, label_json): (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    ) = connection
        .query_row(
            "SELECT labeler_model, q_units, q_values_json, label_json
               FROM decisions WHERE decision_id = ?1",
            params![first_decision.decision_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("labelled decision row");
    assert_eq!(model.as_deref(), Some(identity().model.as_str()));
    assert_eq!(units.as_deref(), Some("model_utility"));
    let q_values = q_values.expect("q values written");
    assert!(q_values.contains("Discard_"), "q map: {q_values}");
    let label: ModelLabel =
        serde_json::from_str(&label_json.expect("label json")).expect("label decodes");
    assert_eq!(label.q_units, "model_utility");
    // L2 wrote the agreement classification onto the same row.
    let (kind, source): (Option<String>, Option<String>) = connection
        .query_row(
            "SELECT label_kind, label_source FROM decisions WHERE decision_id = ?1",
            params![first_decision.decision_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("classification columns");
    assert_eq!(kind.as_deref(), Some(label.kind().as_str()));
    assert_eq!(source.as_deref(), Some(label.kind().source()));
    // The replay was generated by a different checkpoint, so both identities
    // are recorded rather than hidden.
    assert_eq!(
        label.generator.as_ref().map(|other| other.model.as_str()),
        Some("akochan-1.0")
    );

    // A rerun skips every finished state and does not touch the network.
    let second = run_shard(&root, &options, &evaluator).expect("second shard run");
    assert_eq!(second.decisions_seen, first.decisions_seen);
    assert_eq!(second.decisions_cached, first.decisions_seen);
    assert_eq!(second.decisions_labelled, 0);
    assert_eq!(second.decisions_retried, 0);
    assert_eq!(second.decisions_failed, 0);
    assert_eq!(
        evaluator.calls(),
        calls_after_first,
        "a rerun must not run the model for a finished state"
    );

    // The cache has one finished row per unique model-visible state.
    let finished_rows: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM model_labels WHERE status = 'ok'",
            [],
            |row| row.get(0),
        )
        .expect("cache rows");
    assert_eq!(
        usize::try_from(finished_rows).expect("count"),
        first.decisions_labelled,
        "duplicate positions in one run share a cache row"
    );
}

#[test]
fn the_shard_limit_bounds_the_replay_count() {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = DataRoot::new(temp.path().join("data")).expect("data root");
    write_replay(&root, "mortal_mirror", &fixtures::all_events_game());
    write_replay(&root, "mortal_mirror", &fixtures::exhaustive_game(5));

    let evaluator = CannedEvaluator::new(|_| 0.0);
    let mut options = LabelRunOptions::new("unused.safetensors");
    options.limit = Some(1);
    let report = run_shard(&root, &options, &evaluator).expect("limited run");
    assert_eq!(report.replays_found, 1);
    assert_eq!(report.replays_walked, 1);
}

/// End-to-end with the real checkpoint: load once, label the shard, rerun cached.
#[test]
fn a_real_checkpoint_labels_a_shard_and_the_rerun_is_cached() {
    let Some(weights) = weights_path() else {
        eprintln!(
            "skipping real label-shard test: the Mortal checkpoint is not present. \
             Set RIICHI_MORTAL_WEIGHTS=/path/mortal_298k.safetensors or place \
             frontend/public/models/mortal_298k.safetensors. The weights are gitignored."
        );
        return;
    };
    let temp = tempfile::tempdir().expect("tempdir");
    let root = DataRoot::new(temp.path().join("data")).expect("data root");
    write_replay(&root, "mortal_mirror", &fixtures::all_events_game());

    let options = LabelRunOptions::new(weights);
    let first = run_label(&root, &options).expect("real label run");
    assert_eq!(first.replays_walked, 1);
    assert!(first.decisions_labelled > 0);
    assert_eq!(first.decisions_failed, 0, "errors: {:?}", first.errors);
    assert!(first.book_labels > 0, "the fixture contains book cells");

    let second = run_label(&root, &options).expect("cached rerun");
    assert_eq!(second.decisions_labelled, 0);
    assert_eq!(second.decisions_cached, first.decisions_seen);
    assert_eq!(second.decisions_failed, 0);
}

#[test]
fn the_decision_write_leaves_selection_columns_alone() {
    // A row labelled by L1 must not claim a selection decision: `label_kind`
    // and `label_source` belong to L2/S2. This pins the UPDATE column list.
    let temp = tempfile::tempdir().expect("tempdir");
    let root = DataRoot::new(temp.path().join("data")).expect("data root");
    let connection = open_miner_db(&root).expect("miner db");
    let replay_id = "a".repeat(64);
    connection
        .execute(
            "INSERT INTO replays (
                replay_id, source, licence, attribution, format, rule,
                rule_config_hash, generated_at, model, model_sha256, seed,
                log_path, log_bytes, log_sha256, validation_status,
                ingested_at, corpus_id, family, match_plan_id,
                match_plan_sha256, agents, provenance_json
             ) VALUES (?1, 'ai_selfplay', 'CC-BY-4.0', 'fixture', 'mjai',
                'tenhou-4p-hanchan', ?2, '2026-11-16T00:00:00Z', 'mortal-298k',
                ?3, '0x01', ?4, 10, ?5, 'ok', '2026-11-16T00:01:00Z',
                'mixed-2026-11', 'mortal_mirror', 'm1', ?6, '[]', '{}')",
            params![
                replay_id,
                "b".repeat(64),
                "c".repeat(64),
                "replays/mortal_mirror/a.jsonl.gz",
                "d".repeat(64),
                "e".repeat(64),
            ],
        )
        .expect("replay row");
    connection
        .execute(
            "INSERT INTO decisions (
                decision_id, replay_id, family, kyoku, honba, event_index, turn,
                seat, decision_kind, state_hash, state_json, legal_actions,
                played_action, label_kind, label_source
             ) VALUES ('d1', ?1, 'mortal_mirror', 0, 0, 0, 0, 0, 'self_turn',
                'h', '{}', '[]', '{}', 'book', 'b1')",
            params![replay_id],
        )
        .expect("decision row");

    let id = identity();
    let label = ModelLabel {
        schema: crate::miner::MODEL_LABEL_SCHEMA.to_string(),
        version: 1,
        classifier_version: super::super::CLASSIFIER_VERSION.to_string(),
        model: id.model,
        model_sha256: id.model_sha256,
        gamma: None,
        pts: None,
        q_units: super::super::Q_UNITS.to_string(),
        value_units: super::super::VALUE_UNITS.to_string(),
        expected_value: 0.0,
        top_action: "Discard_1m".to_string(),
        top_probability: 1.0,
        probability_margin: 0.0,
        q_gap_top2: None,
        q_gap_safe: None,
        safe_action: None,
        riichi_discard: None,
        ranking: Vec::new(),
        q_values: Default::default(),
        book: None,
        book_conflict: None,
        label_kind: None,
        stability: None,
        consensus: None,
        calibration_version: None,
        expected_point_diffs: None,
        generator: None,
        note: super::super::Q_UNITS_NOTE.to_string(),
    };
    write_decision_label(&connection, "d1", &label).expect("decision write");

    let (kind, source, top, units): (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    ) = connection
        .query_row(
            "SELECT label_kind, label_source, mortal_top, q_units
                   FROM decisions WHERE decision_id = 'd1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("decision row");
    assert_eq!(
        kind.as_deref(),
        Some("book"),
        "L1 must not overwrite label_kind"
    );
    assert_eq!(
        source.as_deref(),
        Some("b1"),
        "L1 must not overwrite label_source"
    );
    assert_eq!(top.as_deref(), Some("Discard_1m"));
    assert_eq!(units.as_deref(), Some("model_utility"));
}

#[test]
fn a_calibrated_run_stores_the_raw_cache_label_and_a_rerun_does_not_evaluate() {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = DataRoot::new(temp.path().join("data")).expect("data root");
    write_replay(&root, "mortal_mirror", &fixtures::all_events_game());

    let evaluator = CannedEvaluator::new(|info| -(info.tile_index.unwrap_or(0) as f32) * 0.1);
    let mut options = LabelRunOptions::new("unused.safetensors");
    options.calibration = Some(calibration_fixture());
    let first = run_shard(&root, &options, &evaluator).expect("calibrated run");

    assert_eq!(first.calibration.as_deref(), Some("fixture-calibration"));
    assert!(first.decisions_labelled > 0);
    assert_eq!(first.decisions_failed, 0, "errors: {:?}", first.errors);
    let calls_after_first = evaluator.calls();

    // The cache keeps the raw label: point estimates are a pure function of its
    // Q values, so they must not be baked into the cached payload.
    let connection = open_miner_db(&root).expect("miner db");
    let cached_json: String = connection
        .query_row(
            "SELECT label_json FROM model_labels WHERE status = 'ok' LIMIT 1",
            [],
            |row| row.get(0),
        )
        .expect("cached label");
    let cached: ModelLabel = serde_json::from_str(&cached_json).expect("decodes");
    assert!(cached.expected_point_diffs.is_none());
    assert!(cached.calibration_version.is_none());
    assert!(!cached.q_values.is_empty());

    // A calibration change is a recalibration, not a new evaluation.
    let mut recalibrated = options.clone();
    let mut other = calibration_fixture();
    other.calibration_id = "second-calibration".to_string();
    recalibrated.calibration = Some(other);
    let second = run_shard(&root, &recalibrated, &evaluator).expect("recalibrated run");
    assert_eq!(second.decisions_cached, second.decisions_seen);
    assert_eq!(second.decisions_labelled, 0);
    assert_eq!(
        evaluator.calls(),
        calls_after_first,
        "recalibrating must reuse the cached raw labels"
    );
    assert_eq!(second.calibration.as_deref(), Some("second-calibration"));
}

#[test]
fn a_multi_model_pass_records_each_vote_and_skips_the_single_model_cache() {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = DataRoot::new(temp.path().join("data")).expect("data root");
    write_replay(&root, "mortal_mirror", &fixtures::all_events_game());

    let primary = CannedEvaluator::new(|info| -(info.tile_index.unwrap_or(0) as f32));
    let mut second_identity = identity();
    second_identity.model = "other_checkpoint.safetensors".to_string();
    second_identity.model_sha256 = "b".repeat(64);
    let second = CannedEvaluator::with_identity(second_identity, |info: &ActionInfo| {
        info.tile_index.unwrap_or(0) as f32
    });

    let options = LabelRunOptions::new("unused.safetensors");
    let report = run_shard_models(&root, &options, &[&primary, &second]).expect("multi-model run");
    assert_eq!(report.labelers.len(), 2);
    assert_eq!(report.model, identity().model, "the primary labeler leads");
    assert!(report.decisions_labelled > 0);
    assert_eq!(report.decisions_failed, 0, "errors: {:?}", report.errors);
    assert_eq!(
        report.decisions_cached, 0,
        "a consensus needs a labeler-set cache key, which no pipeline uses yet"
    );
    assert_eq!(primary.calls(), report.decisions_labelled);
    assert_eq!(second.calls(), report.decisions_labelled);

    // The single-model cache must not hold consensus rows.
    let connection = open_miner_db(&root).expect("miner db");
    let cache_rows: i64 = connection
        .query_row("SELECT COUNT(*) FROM model_labels", [], |row| row.get(0))
        .expect("cache rows");
    assert_eq!(cache_rows, 0);
}

#[test]
fn a_trigger_prefilter_skips_the_forward_pass_for_untriggered_decisions() {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = DataRoot::new(temp.path().join("data")).expect("data root");
    write_replay(&root, "mortal_mirror", &fixtures::all_events_game());

    let evaluator = CannedEvaluator::new(|info| -(info.tile_index.unwrap_or(0) as f32) * 0.1);
    let mut options = LabelRunOptions::new("unused.safetensors");
    assert!(
        options.trigger_filter.is_none(),
        "the default labels every decision"
    );
    options.trigger_filter = Some(
        crate::miner::trigger::TriggerFilter::only([crate::miner::trigger::TriggerKind::Book])
            .expect("a cheap filter"),
    );

    let report = run_shard(&root, &options, &evaluator).expect("filtered shard run");
    assert!(report.decisions_triggered > 0, "the fixture has book cells");
    assert!(
        report.decisions_filtered_out > 0,
        "the fixture is mostly not a book cell"
    );
    assert_eq!(
        report.decisions_triggered + report.decisions_filtered_out,
        report.decisions_seen
    );
    assert_eq!(
        evaluator.calls(),
        report.decisions_labelled,
        "only triggered decisions reach the forward pass"
    );
    assert!(evaluator.calls() < report.decisions_seen);
    assert_eq!(report.decisions_failed, 0, "errors: {:?}", report.errors);
    assert_eq!(
        report.trigger_hits.get("book").copied(),
        Some(report.decisions_triggered),
        "every triggered decision is a book hit in this filter"
    );
}

/// Q2p: the same shard must produce the same rows and the same report on one
/// worker and on many. Extract runs first so the label pass has `decisions` rows
/// to write onto, which is the real pipeline order.
#[test]
fn parallel_and_serial_label_runs_write_the_same_rows_and_report() {
    let serial = label_shard(1);
    let parallel = label_shard(4);

    assert_eq!(serial.report.workers, 1);
    assert_eq!(parallel.report.workers, 4);
    assert!(serial.report.decisions_labelled > 0);
    assert_eq!(
        serial.report.decisions_failed, 0,
        "{:?}",
        serial.report.errors
    );
    assert_eq!(
        serial.report.decisions_labelled
            + serial.report.decisions_cached
            + serial.report.decisions_retried,
        serial.report.decisions_seen,
        "every decision is labelled, cached or retried"
    );
    assert_eq!(
        serial.evaluator.calls(),
        serial.report.decisions_labelled,
        "a duplicate state shares one evaluation, as in the serial pass"
    );
    assert_eq!(
        parallel.evaluator.calls(),
        parallel.report.decisions_labelled,
        "the flight map keeps one evaluation per state on many workers"
    );

    for field in [
        "replays_found",
        "replays_walked",
        "replays_failed",
        "decisions_seen",
        "decisions_dropped",
        "decisions_cached",
        "decisions_labelled",
        "decisions_retried",
        "decisions_failed",
        "decisions_triggered",
        "decisions_filtered_out",
        "book_labels",
        "stable",
        "contested",
        "mortal_only",
        "book_conflicts",
    ] {
        assert_eq!(
            report_field(&serial.report, field),
            report_field(&parallel.report, field),
            "`{field}` must not depend on the worker count"
        );
    }
    assert_eq!(serial.report.trigger_hits, parallel.report.trigger_hits);
    assert_eq!(serial.report.errors, parallel.report.errors);
    assert_eq!(serial.report.labelers, parallel.report.labelers);
    assert_eq!(serial.rows, parallel.rows, "same `decisions` rows");
    assert_eq!(serial.cache_rows, parallel.cache_rows, "same cache rows");
}

/// One seeded data root, extracted, then labelled on `workers` threads.
struct LabelShardRun {
    report: LabelRunReport,
    evaluator: CannedEvaluator,
    rows: Vec<(String, String, String, String)>,
    cache_rows: Vec<(String, String)>,
}

fn label_shard(workers: usize) -> LabelShardRun {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = DataRoot::new(temp.path().join("data")).expect("data root");
    let mut first: Option<Vec<u8>> = None;
    for events in [
        fixtures::all_events_game(),
        fixtures::exhaustive_game(3),
        fixtures::two_kyoku_game(),
        fixtures::chankan_game(),
        fixtures::furiten_ron_game(),
    ] {
        let bytes = write_replay(&root, "mortal_mirror", &events);
        first.get_or_insert(bytes);
    }
    let first = ReplayId::from_bytes(&first.expect("a seeded replay"));
    // The first file's replay row exercises the generator-identity path.
    let connection = open_miner_db(&root).expect("miner db");
    connection
        .execute(
            "INSERT INTO replays (
                replay_id, source, licence, attribution, format, rule,
                rule_config_hash, generated_at, model, model_sha256, seed,
                log_path, log_bytes, log_sha256, validation_status,
                ingested_at, corpus_id, family, match_plan_id,
                match_plan_sha256, agents, provenance_json
             ) VALUES (?1, 'ai_selfplay', 'CC-BY-4.0', 'fixture', 'mjai',
                'tenhou-4p-hanchan', ?2, '2026-11-16T00:00:00Z',
                'akochan-1.0', ?3, '0x01', ?4, 1, ?5, 'ok',
                '2026-11-16T00:01:00Z', 'mixed-2026-11', 'mortal_mirror',
                'm1', ?6, '[]', '{}')",
            params![
                first.as_str(),
                "b".repeat(64),
                "e".repeat(64),
                format!("replays/mortal_mirror/{}.jsonl.gz", first.as_str()),
                "f".repeat(64),
                "0".repeat(64),
            ],
        )
        .expect("replay row");
    drop(connection);

    let extraction = crate::miner::extract::run_extraction(
        &root,
        &crate::miner::extract::ExtractOptions {
            workers,
            ..Default::default()
        },
    )
    .expect("extract");
    assert!(extraction.decisions_inserted > 0);

    let evaluator = CannedEvaluator::new(|info| -(info.tile_index.unwrap_or(0) as f32) * 0.1);
    let mut options = LabelRunOptions::new("unused.safetensors");
    options.workers = workers;
    let report = run_shard(&root, &options, &evaluator).expect("shard run");

    let connection = open_miner_db(&root).expect("miner db");
    let mut statement = connection
        .prepare(
            "SELECT decision_id, label_json, label_kind, label_source
               FROM decisions ORDER BY decision_id",
        )
        .expect("statement");
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .expect("rows")
        .map(|row| row.expect("row"))
        .collect();
    let mut statement = connection
        .prepare("SELECT state_hash, label_json FROM model_labels ORDER BY state_hash")
        .expect("statement");
    let cache_rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .expect("rows")
        .map(|row| row.expect("row"))
        .collect();
    LabelShardRun {
        report,
        evaluator,
        rows,
        cache_rows,
    }
}

/// Read one numeric report field by name, so a new counter cannot silently drop
/// out of the comparison above.
fn report_field(report: &LabelRunReport, field: &str) -> usize {
    let value = serde_json::to_value(report).expect("report json");
    value
        .get(field)
        .and_then(serde_json::Value::as_u64)
        .unwrap_or_else(|| panic!("`{field}` is not a numeric report field"))
        .try_into()
        .expect("fits in usize")
}

/// A classifier bump must not leave the retired rule set's label behind on a
/// decision the trigger filter now skips. The shard clears every older-version
/// label once, before the workers start.
#[test]
fn a_classifier_bump_clears_labels_the_filter_now_skips() {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = DataRoot::new(temp.path().join("data")).expect("data root");
    let bytes = write_replay(&root, "mortal_mirror", &fixtures::all_events_game());
    let replay_id = ReplayId::from_bytes(&bytes);

    let file = ReplayReader::read_gzip(&bytes).expect("fixture parses");
    let walked = walk_replay(&file, replay_id.clone()).expect("fixture validates");

    let mut options = LabelRunOptions::new("unused.safetensors");
    options.trigger_filter = Some(
        crate::miner::trigger::TriggerFilter::only([crate::miner::trigger::TriggerKind::Book])
            .expect("a cheap filter"),
    );
    let skipped = walked
        .decisions
        .iter()
        .find(|decision| !cheap_triggers(decision, &options).has_any())
        .expect("the fixture has a decision the book filter skips");

    let connection = open_miner_db(&root).expect("miner db");
    connection
        .execute(
            "INSERT INTO replays (
                replay_id, source, licence, attribution, format, rule,
                rule_config_hash, generated_at, model, model_sha256, seed,
                log_path, log_bytes, log_sha256, validation_status,
                ingested_at, corpus_id, family, match_plan_id,
                match_plan_sha256, agents, provenance_json
             ) VALUES (?1, 'ai_selfplay', 'CC-BY-4.0', 'fixture', 'mjai',
                'tenhou-4p-hanchan', ?2, '2026-11-16T00:00:00Z',
                'akochan-1.0', ?3, '0x01', ?4, ?5, ?6, 'ok',
                '2026-11-16T00:01:00Z', 'mixed-2026-11', 'mortal_mirror',
                'm1', ?7, '[]', '{}')",
            params![
                replay_id.as_str(),
                "b".repeat(64),
                "e".repeat(64),
                format!("replays/mortal_mirror/{}.jsonl.gz", replay_id.as_str()),
                i64::try_from(bytes.len()).expect("fixture size"),
                sha256_hex(&bytes),
                "f".repeat(64),
            ],
        )
        .expect("replay row");
    connection
        .execute(
            "INSERT INTO decisions (
                decision_id, replay_id, family, kyoku, honba, event_index, turn,
                seat, decision_kind, state_hash, state_json, legal_actions,
                played_action, label_json, label_kind, label_source, mortal_top,
                mortal_top_prob, mortal_margin, mortal_ranking, q_values_json,
                q_units, labeler_model, labeler_model_sha256, classifier_version
             ) VALUES (?1, ?2, 'mortal_mirror', 0, 0, ?3, 0, ?4, ?5, ?6, ?7, ?8,
                ?9, '{\"old\":true}', 'book', 'book+mortal', 'Discard_1m', 0.5,
                0.1, '[]', '{}', 'model_utility', 'mortal_298k.safetensors', ?10, '1')",
            params![
                skipped.decision_id,
                replay_id.as_str(),
                i64::try_from(skipped.event_index).expect("index"),
                i64::try_from(skipped.seat).expect("seat"),
                skipped.kind.as_str(),
                crate::miner::label::state_hash(&skipped.state),
                serde_json::to_string(&skipped.state).expect("state json"),
                serde_json::to_string(&skipped.legal_actions).expect("legal actions"),
                serde_json::to_string(&skipped.played).expect("played"),
                "a".repeat(64),
            ],
        )
        .expect("decision row");

    let evaluator = CannedEvaluator::new(|info| -(info.tile_index.unwrap_or(0) as f32) * 0.1);
    let report = run_shard(&root, &options, &evaluator).expect("shard run");

    assert_eq!(
        report.stale_labels_cleared, 1,
        "the one old-version label is cleared"
    );
    let (label, kind, version): (Option<String>, Option<String>, Option<String>) = connection
        .query_row(
            "SELECT label_json, label_kind, classifier_version
             FROM decisions WHERE decision_id = ?1",
            [&skipped.decision_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("decision row");
    assert!(
        label.is_none() && kind.is_none() && version.is_none(),
        "the retired label survived: {label:?} {kind:?} {version:?}"
    );
}
