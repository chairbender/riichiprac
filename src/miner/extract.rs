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

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use rusqlite::{Connection, params};
use serde::Serialize;
use thiserror::Error;

use crate::miner::label::run::discover_replays;
use crate::miner::label::state_hash;
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
             ({} walker drops{}), {} inserted, {} refreshed\n",
            self.replays_found,
            self.replays_walked,
            self.replays_failed,
            self.decisions_seen,
            self.decisions_dropped,
            if self.dry_run { ", dry run" } else { "" },
            self.decisions_inserted,
            self.decisions_updated
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

/// Walk a replay shard and upsert every reconstructed decision.
pub fn run_extraction(
    root: &DataRoot,
    options: &ExtractOptions,
) -> Result<ExtractReport, ExtractError> {
    let replays = options
        .replays
        .clone()
        .unwrap_or_else(|| root.replays_dir());
    let mut files = discover_replays(&replays, options.family.as_deref())
        .map_err(|err| ExtractError::Discovery(err.to_string()))?;
    if let Some(limit) = options.limit {
        files.truncate(limit);
    }

    let connection = open_miner_db(root)?;
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
        replay_families: Vec::new(),
        errors: Vec::new(),
    };
    let mut families: BTreeMap<String, ExtractFamilyStats> = BTreeMap::new();

    for path in &files {
        let family = family_of_path(path, &replays);
        let walk = match walk_path(path) {
            Ok(walk) => walk,
            Err(err) => {
                report.replays_failed += 1;
                record_error(&mut report, format!("{}: {err}", path.display()));
                continue;
            }
        };
        report.replays_walked += 1;
        report.decisions_seen += walk.decisions.len() as u64;
        report.decisions_dropped += walk.skipped.len() as u64;

        let (inserted, updated) = if options.dry_run {
            (0, 0)
        } else {
            match write_decisions(
                &connection,
                walk.replay_id.as_str(),
                &family,
                &walk.decisions,
            ) {
                Ok(counts) => counts,
                Err(err) => {
                    report.replays_failed += 1;
                    record_error(&mut report, format!("{}: {err}", path.display()));
                    continue;
                }
            }
        };

        let entry = families.entry(family).or_default();
        entry.replays += 1;
        entry.decisions += walk.decisions.len() as u64;
        entry.inserted += inserted;
        entry.updated += updated;
        report.decisions_inserted += inserted;
        report.decisions_updated += updated;
    }

    report.replay_families = families.into_iter().collect();
    Ok(report)
}

/// Insert or refresh one replay's decisions. Returns `(inserted, updated)`.
///
/// The insert is `OR IGNORE` and the refresh touches only the state columns, so
/// a rerun cannot erase a label, trigger or selection that a later stage wrote.
fn write_decisions(
    connection: &Connection,
    replay_id: &str,
    family: &str,
    decisions: &[DecisionSnapshot],
) -> Result<(u64, u64), ExtractError> {
    let transaction = connection.unchecked_transaction()?;
    let mut inserted = 0_u64;
    let mut updated = 0_u64;
    for decision in decisions {
        let (turn, _) = candidate_turn(decision);
        let legal_actions: Vec<&str> = decision
            .legal_actions
            .iter()
            .map(|info| info.action.as_str())
            .collect();
        transaction.execute(
            "INSERT OR IGNORE INTO decisions (
                decision_id, replay_id, family, kyoku, honba, event_index, turn,
                seat, decision_kind, state_hash, state_json, visible_info_hash,
                legal_actions, played_action
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                decision.decision_id,
                replay_id,
                family,
                i64::try_from(decision.kyoku_index).unwrap_or(i64::MAX),
                i64::from(decision.state.honba),
                i64::try_from(decision.event_index).unwrap_or(i64::MAX),
                i64::try_from(turn).unwrap_or(i64::MAX),
                i64::try_from(decision.seat).unwrap_or(i64::MAX),
                decision.kind.as_str(),
                state_hash(&decision.state),
                serde_json::to_string(&decision.state)?,
                visible_info_fingerprint(decision),
                serde_json::to_string(&legal_actions)?,
                decision.played.action,
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
                decision.decision_id,
                replay_id,
                family,
                i64::try_from(decision.kyoku_index).unwrap_or(i64::MAX),
                i64::from(decision.state.honba),
                i64::try_from(decision.event_index).unwrap_or(i64::MAX),
                i64::try_from(turn).unwrap_or(i64::MAX),
                i64::try_from(decision.seat).unwrap_or(i64::MAX),
                decision.kind.as_str(),
                state_hash(&decision.state),
                serde_json::to_string(&decision.state)?,
                visible_info_fingerprint(decision),
                serde_json::to_string(&legal_actions)?,
                decision.played.action,
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
}
