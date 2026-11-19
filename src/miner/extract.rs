//! `mine_replays extract`: persist reconstructed decision points (R2) into the
//! F1 operational database.
//!
//! R2's walker is model-free and pure: it reads a validated replay, rebuilds
//! every reachable `GameState`, and hands the caller a [`DecisionSnapshot`]. The
//! pack pipeline needs those states in the database because
//!
//! - P1b rebuilds a shipped base from `decisions.state_json`; a
//!   `selected_scenarios` row that points at a missing decision is refused;
//! - `label` writes its Mortal label onto the existing `decisions` row;
//! - `triggers` records the cheap trigger reasons there.
//!
//! Extraction is therefore stage 3 of the pipeline
//! (`corpus → ingest → extract → label → select → transform → pack`). It is
//! idempotent: re-running over the same replay updates the state/ledger columns
//! and leaves every label, trigger and selection column untouched. The raw log
//! is immutable and is never rewritten.
//!
//! # What one row stores
//!
//! | Column | Value |
//! | --- | --- |
//! | `decision_id` | R2's `sha256(replay_id, kyoku_index, event_index)` |
//! | `state_json` | the complete reconstructed `GameState` |
//! | `state_hash` | the L1/Mortal v4 observation hash (the label cache key) |
//! | `visible_info_hash` | the literal visible-table fingerprint (dedupe) |
//! | `legal_actions` | JSON array of the action strings the actor may take |
//! | `played_action` | the action string the record actually played |
//!
//! The trigger, label and selection columns are owned by later stages and are
//! preserved on every rerun.
//!
//! # Parallelism
//!
//! Files are independent, so the default run walks the shard on every available
//! core (`--workers 0`). Each worker walks its own files and writes its rows
//! under the stage's single database lock; the per-file results merge in file
//! order, so the report and the rows are the same as a `--workers 1` run. The
//! report records the worker count and wall time, and `--progress` prints the
//! measured file count.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime};

use rayon::prelude::*;
use rusqlite::{Connection, params};
use serde::Serialize;
use thiserror::Error;

use crate::miner::label::run::discover_replays;
use crate::miner::label::state_hash;
use crate::miner::parallel::{Progress, SharedDb, elapsed_ms, resolve_workers, worker_pool};
use crate::miner::select::candidate_turn;
use crate::miner::select::dedupe::visible_info_fingerprint;
use crate::miner::storage::{DataRoot, open_miner_db, utc_stamp};
use crate::replay::walk::{DecisionSnapshot, walk_path};

/// Schema string of one extraction report.
pub const EXTRACT_SCHEMA: &str = "riichiprac.extraction-report";
/// Report version.
pub const EXTRACT_VERSION: u32 = 1;

/// One `extract` run's inputs.
#[derive(Debug, Clone, Default)]
pub struct ExtractOptions {
    /// Replay directory. Defaults to `$RIICHI_DATA_DIR/replays`.
    pub replays: Option<PathBuf>,
    /// One family sub-directory only.
    pub family: Option<String>,
    /// Maximum replay files in this shard.
    pub limit: Option<usize>,
    /// Worker threads. `0` uses every available core; `1` is the bounded mode
    /// for tests, fixtures and debugging. Offline stages default to the whole
    /// machine.
    pub workers: usize,
    /// Print phase and file progress to stderr.
    pub progress: bool,
    /// Validate and report without writing a row.
    pub dry_run: bool,
}

/// Per-replay-family extraction counts.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct ExtractFamilyStats {
    /// Replay files walked in this family.
    pub replays: usize,
    /// Decisions reconstructed from them.
    pub decisions: u64,
    /// New `decisions` rows written.
    pub inserted: u64,
    /// Existing `decisions` rows whose state columns were refreshed.
    pub updated: u64,
}

/// One extraction run's report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ExtractReport {
    /// [`EXTRACT_SCHEMA`].
    pub schema: String,
    /// [`EXTRACT_VERSION`].
    pub version: u32,
    /// When the run started, `YYYYMMDD-HHMMSS` UTC.
    pub generated_at: String,
    /// Replay files discovered.
    pub replays_found: usize,
    /// Replays walked cleanly.
    pub replays_walked: usize,
    /// Replays that failed to read, validate or insert.
    pub replays_failed: usize,
    /// Decisions the walker produced.
    pub decisions_seen: u64,
    /// Decisions the reachability guard rejected (never inserted).
    pub decisions_dropped: u64,
    /// New `decisions` rows written.
    pub decisions_inserted: u64,
    /// Existing rows refreshed.
    pub decisions_updated: u64,
    /// The run wrote nothing (`--dry-run`).
    pub dry_run: bool,
    /// Resolved worker threads this run used (`0` was requested as every core).
    #[serde(default)]
    pub workers: usize,
    /// Wall time of the whole run, in milliseconds.
    #[serde(default)]
    pub wall_time_ms: u64,
    /// Per replay-family counts, sorted by family name.
    pub replay_families: Vec<(String, ExtractFamilyStats)>,
    /// First errors, in run order (bounded).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<String>,
}

impl ExtractReport {
    /// A human-readable multi-line summary for the CLI.
    #[must_use]
    pub fn human_summary(&self) -> String {
        let mut out = String::new();
        out.push_str(&format!(
            "mine_replays extract: {} replay(s) ({} walked, {} failed), {} decision(s) \
             ({} walker drops{}), {} inserted, {} refreshed in {} ms on {} worker thread(s)\n",
            self.replays_found,
            self.replays_walked,
            self.replays_failed,
            self.decisions_seen,
            self.decisions_dropped,
            if self.dry_run { ", dry run" } else { "" },
            self.decisions_inserted,
            self.decisions_updated,
            self.wall_time_ms,
            self.workers
        ));
        for (family, stats) in &self.replay_families {
            out.push_str(&format!(
                "  {family}: {} replay(s), {} decision(s), {} inserted, {} refreshed\n",
                stats.replays, stats.decisions, stats.inserted, stats.updated
            ));
        }
        for error in &self.errors {
            out.push_str(&format!("  error: {error}\n"));
        }
        out
    }
}

/// Anything that stops an extraction run.
#[derive(Debug, Error)]
pub enum ExtractError {
    /// The replay store failed.
    #[error(transparent)]
    Storage(#[from] crate::miner::storage::StorageError),
    /// Replay discovery failed.
    #[error("cannot discover replays: {0}")]
    Discovery(String),
    /// SQLite failed.
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    /// A document could not be serialised.
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    /// The replay directory is missing.
    #[error("replay directory `{0}` does not exist")]
    MissingReplays(String),
    /// The worker pool could not start.
    #[error("{0}")]
    Workers(String),
}

fn family_of_path(path: &Path, replays_dir: &Path) -> String {
    let relative = path.strip_prefix(replays_dir).unwrap_or(path);
    let parent = relative.parent().unwrap_or_else(|| Path::new(""));
    if parent.as_os_str().is_empty() {
        "(root)".to_string()
    } else {
        parent.to_string_lossy().replace('\\', "/")
    }
}

/// One replay file's extraction result, merged in file order.
struct ExtractFile {
    /// The walk succeeded (so its decisions count even if the write failed).
    walked: bool,
    decisions_seen: u64,
    decisions_dropped: u64,
    /// The family row, present only when the file's rows were written.
    family: Option<(String, ExtractFamilyStats)>,
    /// The first failure for this file, in the serial report's wording.
    error: Option<String>,
}

fn extract_file(db: &SharedDb, path: &Path, replays_dir: &Path, dry_run: bool) -> ExtractFile {
    let family = family_of_path(path, replays_dir);
    let mut file = ExtractFile {
        walked: false,
        decisions_seen: 0,
        decisions_dropped: 0,
        family: None,
        error: None,
    };
    let walk = match walk_path(path) {
        Ok(walk) => walk,
        Err(err) => {
            file.error = Some(format!("{}: {err}", path.display()));
            return file;
        }
    };
    file.walked = true;
    file.decisions_seen = walk.decisions.len() as u64;
    file.decisions_dropped = walk.skipped.len() as u64;

    let (inserted, updated) = if dry_run {
        (0, 0)
    } else {
        // The state hash, the visible-info fingerprint and the state JSON are
        // the expensive part of a row (the v4 observation is rebuilt for the
        // hash), so they are computed here, outside the stage's single database
        // lock, and only the short statements run inside it.
        let rows = match decision_rows(&family, &walk.decisions) {
            Ok(rows) => rows,
            Err(err) => {
                file.error = Some(format!("{}: {err}", path.display()));
                return file;
            }
        };
        match db.with(|connection| write_rows(connection, walk.replay_id.as_str(), &rows)) {
            Ok(counts) => counts,
            Err(err) => {
                file.error = Some(format!("{}: {err}", path.display()));
                return file;
            }
        }
    };
    file.family = Some((
        family,
        ExtractFamilyStats {
            replays: 1,
            decisions: walk.decisions.len() as u64,
            inserted,
            updated,
        },
    ));
    file
}

/// Walk a replay shard and upsert every reconstructed decision.
///
/// Files are independent, so the shard is walked with `workers` threads. Each
/// worker walks its files and writes its rows under the stage's single database
/// lock; the per-file results merge in file order, so the report is identical to
/// a `--workers 1` run of the same shard (apart from the recorded worker count
/// and wall time).
pub fn run_extraction(
    root: &DataRoot,
    options: &ExtractOptions,
) -> Result<ExtractReport, ExtractError> {
    let started = Instant::now();
    let replays = options
        .replays
        .clone()
        .unwrap_or_else(|| root.replays_dir());
    let mut files = discover_replays(&replays, options.family.as_deref())
        .map_err(|err| ExtractError::Discovery(err.to_string()))?;
    if let Some(limit) = options.limit {
        files.truncate(limit);
    }

    let workers = resolve_workers(options.workers);
    let pool = worker_pool(workers).map_err(ExtractError::Workers)?;
    let progress = Progress::new(
        "extract",
        "walk",
        "replay file(s)",
        files.len(),
        options.progress,
    );
    progress.announce(workers);

    let connection = open_miner_db(root)?;
    let db = SharedDb::new(connection);
    let results: Vec<ExtractFile> = pool.install(|| {
        files
            .par_iter()
            .map(|path| {
                progress.tick();
                extract_file(&db, path, &replays, options.dry_run)
            })
            .collect()
    });

    let mut report = ExtractReport {
        schema: EXTRACT_SCHEMA.to_string(),
        version: EXTRACT_VERSION,
        generated_at: utc_stamp(SystemTime::now()),
        replays_found: files.len(),
        replays_walked: 0,
        replays_failed: 0,
        decisions_seen: 0,
        decisions_dropped: 0,
        decisions_inserted: 0,
        decisions_updated: 0,
        dry_run: options.dry_run,
        workers,
        wall_time_ms: 0,
        replay_families: Vec::new(),
        errors: Vec::new(),
    };
    let mut families: BTreeMap<String, ExtractFamilyStats> = BTreeMap::new();

    for file in results {
        if file.walked {
            report.replays_walked += 1;
            report.decisions_seen += file.decisions_seen;
            report.decisions_dropped += file.decisions_dropped;
        }
        if let Some((family, stats)) = file.family {
            let entry = families.entry(family).or_default();
            entry.replays += stats.replays;
            entry.decisions += stats.decisions;
            entry.inserted += stats.inserted;
            entry.updated += stats.updated;
            report.decisions_inserted += stats.inserted;
            report.decisions_updated += stats.updated;
        }
        if let Some(error) = file.error {
            report.replays_failed += 1;
            record_error(&mut report, error);
        }
    }

    report.replay_families = families.into_iter().collect();
    report.wall_time_ms = elapsed_ms(started);
    Ok(report)
}

/// One `decisions` row, fully prepared off the database lock.
///
/// The v4 observation behind `state_hash` is the expensive part of extraction
/// (about 13 ms per decision on the Q2 corpus), so building a row must not run
/// inside the stage's single lock.
struct DecisionRow {
    decision_id: String,
    family: String,
    kyoku: i64,
    honba: i64,
    event_index: i64,
    turn: i64,
    seat: i64,
    kind: &'static str,
    state_hash: String,
    state_json: String,
    visible_info_hash: String,
    legal_actions: String,
    played_action: String,
}

/// Build one replay's rows. Pure, so a worker can do it outside the lock.
fn decision_rows(
    family: &str,
    decisions: &[DecisionSnapshot],
) -> Result<Vec<DecisionRow>, ExtractError> {
    let mut rows = Vec::with_capacity(decisions.len());
    for decision in decisions {
        let (turn, _) = candidate_turn(decision);
        let legal_actions: Vec<&str> = decision
            .legal_actions
            .iter()
            .map(|info| info.action.as_str())
            .collect();
        rows.push(DecisionRow {
            decision_id: decision.decision_id.clone(),
            family: family.to_string(),
            kyoku: i64::try_from(decision.kyoku_index).unwrap_or(i64::MAX),
            honba: i64::from(decision.state.honba),
            event_index: i64::try_from(decision.event_index).unwrap_or(i64::MAX),
            turn: i64::try_from(turn).unwrap_or(i64::MAX),
            seat: i64::try_from(decision.seat).unwrap_or(i64::MAX),
            kind: decision.kind.as_str(),
            state_hash: state_hash(&decision.state),
            state_json: serde_json::to_string(&decision.state)?,
            visible_info_hash: visible_info_fingerprint(decision),
            legal_actions: serde_json::to_string(&legal_actions)?,
            played_action: decision.played.action.clone(),
        });
    }
    Ok(rows)
}

/// Insert or refresh one replay's decisions. Returns `(inserted, updated)`.
///
/// The insert is `OR IGNORE` and the refresh touches only the state columns, so
/// a rerun cannot erase a label, trigger or selection that a later stage wrote.
fn write_rows(
    connection: &Connection,
    replay_id: &str,
    rows: &[DecisionRow],
) -> Result<(u64, u64), ExtractError> {
    let transaction = connection.unchecked_transaction()?;
    let mut inserted = 0_u64;
    let mut updated = 0_u64;
    for row in rows {
        transaction.execute(
            "INSERT OR IGNORE INTO decisions (
                decision_id, replay_id, family, kyoku, honba, event_index, turn,
                seat, decision_kind, state_hash, state_json, visible_info_hash,
                legal_actions, played_action
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                row.decision_id,
                replay_id,
                row.family,
                row.kyoku,
                row.honba,
                row.event_index,
                row.turn,
                row.seat,
                row.kind,
                row.state_hash,
                row.state_json,
                row.visible_info_hash,
                row.legal_actions,
                row.played_action,
            ],
        )?;
        if transaction.changes() == 1 {
            inserted += 1;
            continue;
        }
        transaction.execute(
            "UPDATE decisions SET
                replay_id = ?2,
                family = ?3,
                kyoku = ?4,
                honba = ?5,
                event_index = ?6,
                turn = ?7,
                seat = ?8,
                decision_kind = ?9,
                state_hash = ?10,
                state_json = ?11,
                visible_info_hash = ?12,
                legal_actions = ?13,
                played_action = ?14
              WHERE decision_id = ?1",
            params![
                row.decision_id,
                replay_id,
                row.family,
                row.kyoku,
                row.honba,
                row.event_index,
                row.turn,
                row.seat,
                row.kind,
                row.state_hash,
                row.state_json,
                row.visible_info_hash,
                row.legal_actions,
                row.played_action,
            ],
        )?;
        updated += 1;
    }
    transaction.commit()?;
    Ok((inserted, updated))
}

fn record_error(report: &mut ExtractReport, error: String) {
    const MAX_ERRORS: usize = 100;
    if report.errors.len() < MAX_ERRORS {
        report.errors.push(error);
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use rusqlite::params;

    use super::*;
    use crate::miner::provenance::ReplayId;
    use crate::replay::fixtures;
    use crate::replay::mjai::ReplayReader;
    use crate::replay::walk::walk_replay;

    fn write_replay(root: &DataRoot, family: &str, events: &[crate::replay::EventKind]) -> Vec<u8> {
        let bytes = fixtures::gzip(&fixtures::to_jsonl(events));
        let dir = root.replays_dir().join(family);
        fs::create_dir_all(&dir).expect("family dir");
        fs::write(
            dir.join(format!(
                "{}.jsonl.gz",
                crate::miner::provenance::sha256_hex(&bytes)
            )),
            &bytes,
        )
        .expect("replay file");
        bytes
    }

    fn insert_replay(root: &DataRoot, family: &str, bytes: &[u8]) -> String {
        let replay_id = ReplayId::from_bytes(bytes);
        let connection = open_miner_db(root).expect("miner db");
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
                    '2026-11-16T00:01:00Z', 'mixed-2026-11', ?7,
                    'm1', ?8, '[]', '{}')",
                params![
                    replay_id.as_str(),
                    "b".repeat(64),
                    "e".repeat(64),
                    format!("replays/{family}/{}.jsonl.gz", replay_id.as_str()),
                    i64::try_from(bytes.len()).expect("fixture size"),
                    crate::miner::provenance::sha256_hex(bytes),
                    family,
                    "f".repeat(64),
                ],
            )
            .expect("replay row");
        replay_id.as_str().to_string()
    }

    #[test]
    fn extraction_writes_one_row_per_reconstructed_decision() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = DataRoot::new(temp.path().join("data")).expect("data root");
        let bytes = write_replay(&root, "mortal_mirror", &fixtures::all_events_game());
        let replay_id = insert_replay(&root, "mortal_mirror", &bytes);

        let file = ReplayReader::read_gzip(&bytes).expect("fixture parses");
        let walked = walk_replay(&file, ReplayId::from_bytes(&bytes)).expect("fixture validates");

        let report = run_extraction(&root, &ExtractOptions::default()).expect("extract");
        assert_eq!(report.replays_found, 1);
        assert_eq!(report.replays_walked, 1);
        assert_eq!(report.replays_failed, 0);
        assert_eq!(report.decisions_seen, walked.decisions.len() as u64);
        assert_eq!(report.decisions_inserted, walked.decisions.len() as u64);
        assert_eq!(report.decisions_updated, 0);
        assert_eq!(report.replay_families[0].0, "mortal_mirror");

        let connection = open_miner_db(&root).expect("miner db");
        let rows: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM decisions WHERE replay_id = ?1",
                params![replay_id],
                |row| row.get(0),
            )
            .expect("count");
        assert_eq!(rows, walked.decisions.len() as i64);

        let (state_json, hash, played, legal): (String, String, String, String) = connection
            .query_row(
                "SELECT state_json, state_hash, played_action, legal_actions
                 FROM decisions WHERE decision_id = ?1",
                params![walked.decisions[0].decision_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("first row");
        let state: crate::state::GameState =
            serde_json::from_str(&state_json).expect("state round-trips");
        assert_eq!(hash, state_hash(&state));
        assert_eq!(played, walked.decisions[0].played.action);
        let legal: Vec<String> = serde_json::from_str(&legal).expect("legal actions");
        assert_eq!(legal.len(), walked.decisions[0].legal_actions.len());
    }

    #[test]
    fn a_rerun_refreshes_without_clobbering_labels_or_triggers() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = DataRoot::new(temp.path().join("data")).expect("data root");
        let bytes = write_replay(&root, "mortal_mirror", &fixtures::all_events_game());
        insert_replay(&root, "mortal_mirror", &bytes);

        let first = run_extraction(&root, &ExtractOptions::default()).expect("first");
        assert!(first.decisions_inserted > 0);

        let connection = open_miner_db(&root).expect("miner db");
        let decision_id: String = connection
            .query_row("SELECT decision_id FROM decisions LIMIT 1", [], |row| {
                row.get(0)
            })
            .expect("a decision");
        connection
            .execute(
                "UPDATE decisions SET trigger = 'book:ch8.2', label_json = '{\"sentinel\":true}',
                    label_kind = 'book', selection_reason = 'reviewed'
                  WHERE decision_id = ?1",
                params![decision_id],
            )
            .expect("label write");

        let second = run_extraction(&root, &ExtractOptions::default()).expect("second");
        assert_eq!(second.decisions_inserted, 0);
        assert_eq!(second.decisions_updated, first.decisions_inserted);

        let (trigger, label, kind, reason): (String, String, String, String) = connection
            .query_row(
                "SELECT trigger, label_json, label_kind, selection_reason
                 FROM decisions WHERE decision_id = ?1",
                params![decision_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("preserved row");
        assert_eq!(trigger, "book:ch8.2");
        assert_eq!(label, "{\"sentinel\":true}");
        assert_eq!(kind, "book");
        assert_eq!(reason, "reviewed");
    }

    #[test]
    fn a_dry_run_writes_no_row() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = DataRoot::new(temp.path().join("data")).expect("data root");
        let bytes = write_replay(&root, "mortal_mirror", &fixtures::all_events_game());
        insert_replay(&root, "mortal_mirror", &bytes);

        let report = run_extraction(
            &root,
            &ExtractOptions {
                dry_run: true,
                ..Default::default()
            },
        )
        .expect("dry run");
        assert!(report.decisions_seen > 0);
        assert_eq!(report.decisions_inserted, 0);
        assert_eq!(report.decisions_updated, 0);

        let connection = open_miner_db(&root).expect("miner db");
        let rows: i64 = connection
            .query_row("SELECT COUNT(*) FROM decisions", [], |row| row.get(0))
            .expect("count");
        assert_eq!(rows, 0);
    }

    /// Every `decisions` column that extract owns, keyed by `decision_id`, so two
    /// runs can be compared row for row.
    fn decision_rows(root: &DataRoot) -> Vec<(String, String, String, String, String)> {
        let connection = open_miner_db(root).expect("miner db");
        let mut statement = connection
            .prepare(
                "SELECT decision_id, replay_id, family, state_json, visible_info_hash
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
                    row.get::<_, String>(4)?,
                ))
            })
            .expect("rows");
        rows.map(|row| row.expect("row")).collect()
    }

    /// The report with the two fields that legitimately depend on the run
    /// environment (resolved workers, wall time) removed.
    fn comparable_report(report: &ExtractReport) -> serde_json::Value {
        let mut value = serde_json::to_value(report).expect("report json");
        let object = value.as_object_mut().expect("an object");
        object.remove("workers");
        object.remove("wall_time_ms");
        object.remove("generated_at");
        value
    }

    fn seed_shard(root: &DataRoot) {
        for (family, events) in [
            ("mortal_mirror", fixtures::all_events_game()),
            ("mortal_mirror", fixtures::exhaustive_game(5)),
            ("akochan_tactics", fixtures::two_kyoku_game()),
            ("akochan_tactics", fixtures::chankan_game()),
            ("akochan_tactics", fixtures::furiten_ron_game()),
        ] {
            let bytes = write_replay(root, family, &events);
            insert_replay(root, family, &bytes);
        }
    }

    #[test]
    fn parallel_and_serial_extraction_write_the_same_rows_and_report() {
        let serial_temp = tempfile::tempdir().expect("tempdir");
        let serial_root = DataRoot::new(serial_temp.path().join("data")).expect("data root");
        seed_shard(&serial_root);
        let serial = run_extraction(
            &serial_root,
            &ExtractOptions {
                workers: 1,
                ..Default::default()
            },
        )
        .expect("serial extract");

        let parallel_temp = tempfile::tempdir().expect("tempdir");
        let parallel_root = DataRoot::new(parallel_temp.path().join("data")).expect("data root");
        seed_shard(&parallel_root);
        let parallel = run_extraction(
            &parallel_root,
            &ExtractOptions {
                workers: 4,
                ..Default::default()
            },
        )
        .expect("parallel extract");

        assert!(serial.replays_walked >= 5, "{serial:?}");
        assert_eq!(serial.workers, 1);
        assert_eq!(parallel.workers, 4);
        assert_eq!(serial.replays_found, parallel.replays_found);
        assert_eq!(serial.replays_walked, parallel.replays_walked);
        assert_eq!(serial.replays_failed, parallel.replays_failed);
        assert_eq!(serial.decisions_seen, parallel.decisions_seen);
        assert_eq!(serial.decisions_dropped, parallel.decisions_dropped);
        assert_eq!(serial.decisions_inserted, parallel.decisions_inserted);
        assert_eq!(serial.decisions_updated, parallel.decisions_updated);
        assert_eq!(serial.replay_families, parallel.replay_families);
        assert_eq!(serial.errors, parallel.errors);
        assert_eq!(
            comparable_report(&serial),
            comparable_report(&parallel),
            "the report differs only by the worker count and the wall time"
        );
        assert_eq!(
            decision_rows(&serial_root),
            decision_rows(&parallel_root),
            "both runs must write the same rows"
        );
    }

    #[test]
    fn a_rerun_on_either_worker_count_refreshes_the_same_rows() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = DataRoot::new(temp.path().join("data")).expect("data root");
        seed_shard(&root);

        let first = run_extraction(
            &root,
            &ExtractOptions {
                workers: 4,
                ..Default::default()
            },
        )
        .expect("parallel extract");
        assert!(first.decisions_inserted > 0);
        let rows = decision_rows(&root);

        let second = run_extraction(
            &root,
            &ExtractOptions {
                workers: 1,
                ..Default::default()
            },
        )
        .expect("serial rerun");
        assert_eq!(second.decisions_inserted, 0);
        assert_eq!(second.decisions_updated, first.decisions_inserted);
        assert_eq!(second.decisions_seen, first.decisions_seen);
        assert_eq!(decision_rows(&root), rows);
    }
}
