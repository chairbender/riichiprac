//! Local data-root layout, atomic writes, SQLite schema and the rclone contract.
//!
//! The miner owns one configurable directory, `RIICHI_DATA_DIR` (default
//! `~/riichiprac-data`). Raw logs, the operational SQLite DB, DB snapshots and
//! generated packs live there and are never committed. Everything the DB stores
//! is a path **relative to that root**; this module rejects absolute paths and
//! `..` traversal instead of writing a host path or a username into a row.
//!
//! Google Drive backup via rclone is a separate operator task. This module only
//! builds the append-only copy/check commands: with no `RIICHI_RCLONE_REMOTE`
//! configured the backup plan is a no-op, and the miner runs local-only.

use rusqlite::{Connection, params};
use serde::Serialize;
use std::collections::BTreeMap;
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use thiserror::Error;

use super::provenance::{ReplayId, sha256_hex};

/// Environment variable naming the data root.
pub const DATA_DIR_ENV: &str = "RIICHI_DATA_DIR";

/// Default data root when [`DATA_DIR_ENV`] is unset.
pub const DEFAULT_DATA_DIR: &str = "~/riichiprac-data";

/// Relative path of the operational scenario DB.
pub const MINER_DB_RELATIVE_PATH: &str = "db/miner.sqlite";

/// Environment variable naming an optional rclone remote folder.
///
/// Example: `RIICHI_RCLONE_REMOTE=gdrive:riichiprac`. Empty/unset means
/// "local only"; the miner never requires rclone.
pub const RCLONE_REMOTE_ENV: &str = "RIICHI_RCLONE_REMOTE";

/// Sub-folder of the remote that receives immutable raw logs.
pub const RCLONE_REPLAYS_DIR: &str = "replays";

/// Sub-folder of the remote that receives timestamped DB snapshots.
pub const RCLONE_DB_DIR: &str = "db";

/// Current SQLite schema version.
pub const SCHEMA_VERSION: u32 = 2;

/// Tables created by [`SCHEMA_VERSION`], in dependency order.
pub const MINER_TABLES: &[&str] = &[
    "corpus_runs",
    "replays",
    "decisions",
    "selected_scenarios",
    "variants",
    "packs",
    "backups",
    "model_labels",
];

/// Typed storage failure.
#[derive(Debug, Error)]
pub enum StorageError {
    #[error("data root is empty")]
    EmptyDataRoot,
    #[error("cannot determine a data root: set {DATA_DIR_ENV} or HOME")]
    NoDataRoot,
    #[error("path `{0}` is absolute; the miner stores paths relative to RIICHI_DATA_DIR")]
    AbsolutePath(String),
    #[error("path `{0}` is not a safe relative path (empty, `..`, or backslash)")]
    UnsafeRelativePath(String),
    #[error("path `{0}` is outside the data root")]
    OutsideDataRoot(String),
    #[error("path segment `{0}` is invalid")]
    InvalidSegment(String),
    #[error("path `{0}` is not valid UTF-8")]
    NonUtf8Path(String),
    #[error("invalid snapshot id `{0}`: expected digits and `-`")]
    InvalidSnapshotId(String),
    #[error("snapshot `{0}` already exists; refusing to overwrite")]
    SnapshotExists(String),
    #[error("I/O error at `{path}`: {source}")]
    Io {
        path: String,
        #[source]
        source: io::Error,
    },
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("integrity check failed: {0}")]
    Integrity(String),
    #[error("database schema version {found} is newer than supported ({supported})")]
    SchemaTooNew { found: u32, supported: u32 },
    #[error("invalid rclone remote `{0}`: expected `remote:folder`")]
    InvalidRemote(String),
}

fn io_at(path: &Path, source: io::Error) -> StorageError {
    StorageError::Io {
        path: path.display().to_string(),
        source,
    }
}

/// Reject a path that is absolute, empty or escapes through `..`.
///
/// This is deliberately stricter than [`Path`]: it also rejects backslashes and
/// Windows drive prefixes so a row has one portable spelling on every host.
pub fn validate_relative_path(raw: &str) -> Result<(), StorageError> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(StorageError::UnsafeRelativePath(raw.to_string()));
    }
    if value.contains('\\') {
        return Err(StorageError::UnsafeRelativePath(raw.to_string()));
    }
    let path = Path::new(value);
    if path.is_absolute() {
        return Err(StorageError::AbsolutePath(raw.to_string()));
    }
    let bytes = value.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return Err(StorageError::AbsolutePath(raw.to_string()));
    }
    for component in path.components() {
        match component {
            Component::Normal(_) => {}
            _ => return Err(StorageError::UnsafeRelativePath(raw.to_string())),
        }
    }
    Ok(())
}

fn validate_segment(raw: &str) -> Result<(), StorageError> {
    if raw.is_empty() || raw == "." || raw == ".." || raw.contains('/') || raw.contains('\\') {
        return Err(StorageError::InvalidSegment(raw.to_string()));
    }
    Ok(())
}

/// Absolute local data root and its canonical layout.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataRoot {
    root: PathBuf,
}

impl DataRoot {
    /// Resolve `RIICHI_DATA_DIR`, or the documented default when unset.
    pub fn from_env() -> Result<Self, StorageError> {
        match env::var(DATA_DIR_ENV) {
            Ok(value) if !value.trim().is_empty() => Self::new(value.trim()),
            _ => Self::new(DEFAULT_DATA_DIR),
        }
    }

    /// Build a data root, expanding a leading `~` and making the path absolute.
    pub fn new(path: impl Into<PathBuf>) -> Result<Self, StorageError> {
        let expanded = expand_home(path.into())?;
        if expanded.as_os_str().is_empty() {
            return Err(StorageError::EmptyDataRoot);
        }
        let absolute = if expanded.is_absolute() {
            expanded
        } else {
            env::current_dir()
                .map_err(|source| io_at(&expanded, source))?
                .join(expanded)
        };
        Ok(Self { root: absolute })
    }

    /// The absolute root.
    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// `$RIICHI_DATA_DIR/replays`.
    #[must_use]
    pub fn replays_dir(&self) -> PathBuf {
        self.root.join("replays")
    }

    /// `$RIICHI_DATA_DIR/db`.
    #[must_use]
    pub fn db_dir(&self) -> PathBuf {
        self.root.join("db")
    }

    /// `$RIICHI_DATA_DIR/snapshots`.
    #[must_use]
    pub fn snapshots_dir(&self) -> PathBuf {
        self.root.join("snapshots")
    }

    /// `$RIICHI_DATA_DIR/packs`.
    #[must_use]
    pub fn packs_dir(&self) -> PathBuf {
        self.root.join("packs")
    }

    /// `$RIICHI_DATA_DIR/tmp`, the atomic-write staging directory.
    #[must_use]
    pub fn tmp_dir(&self) -> PathBuf {
        self.root.join("tmp")
    }

    /// `$RIICHI_DATA_DIR/logs`.
    #[must_use]
    pub fn logs_dir(&self) -> PathBuf {
        self.root.join("logs")
    }

    /// The operational SQLite database.
    #[must_use]
    pub fn db_path(&self) -> PathBuf {
        self.root.join(MINER_DB_RELATIVE_PATH)
    }

    /// Create the canonical layout (idempotent).
    pub fn ensure_layout(&self) -> Result<(), StorageError> {
        for dir in [
            self.replays_dir(),
            self.db_dir(),
            self.snapshots_dir(),
            self.packs_dir(),
            self.tmp_dir(),
            self.logs_dir(),
        ] {
            fs::create_dir_all(&dir).map_err(|source| io_at(&dir, source))?;
        }
        Ok(())
    }

    /// Resolve a stored relative path inside the root.
    pub fn resolve_relative(&self, relative: &str) -> Result<PathBuf, StorageError> {
        validate_relative_path(relative)?;
        Ok(self.root.join(relative.trim()))
    }

    /// Convert a path to the relative form stored in the DB.
    ///
    /// Absolute paths must be inside the root; relative paths are validated as
    /// they are. Never returns an absolute host path.
    pub fn relative_path(&self, path: &Path) -> Result<String, StorageError> {
        let relative = if path.is_absolute() {
            path.strip_prefix(&self.root)
                .map_err(|_| StorageError::OutsideDataRoot(path.display().to_string()))?
                .to_path_buf()
        } else {
            path.to_path_buf()
        };
        let text = relative
            .to_str()
            .ok_or_else(|| StorageError::NonUtf8Path(path.display().to_string()))?
            .replace('\\', "/");
        validate_relative_path(&text)?;
        Ok(text)
    }

    /// Relative path of one immutable raw log:
    /// `replays/<family>/<replay_id>.jsonl.gz`.
    pub fn replay_relative_path(
        family: &str,
        replay_id: &ReplayId,
    ) -> Result<String, StorageError> {
        validate_segment(family)?;
        let relative = format!("replays/{family}/{replay_id}.jsonl.gz");
        validate_relative_path(&relative)?;
        Ok(relative)
    }

    /// Absolute path of one immutable raw log.
    pub fn replay_path(&self, family: &str, replay_id: &ReplayId) -> Result<PathBuf, StorageError> {
        Ok(self
            .root
            .join(Self::replay_relative_path(family, replay_id)?))
    }

    /// Timestamped snapshot path: `snapshots/miner-YYYYMMDD-HHMMSS.sqlite`.
    #[must_use]
    pub fn snapshot_path(&self, at: SystemTime) -> PathBuf {
        self.snapshot_path_named(&utc_stamp(at))
            .expect("generated UTC stamps are valid")
    }

    /// Snapshot path for an externally supplied `YYYYMMDD-HHMMSS` stamp.
    pub fn snapshot_path_named(&self, stamp: &str) -> Result<PathBuf, StorageError> {
        if stamp.is_empty()
            || !stamp
                .bytes()
                .all(|byte| byte.is_ascii_digit() || byte == b'-')
        {
            return Err(StorageError::InvalidSnapshotId(stamp.to_string()));
        }
        Ok(self.snapshots_dir().join(format!("miner-{stamp}.sqlite")))
    }
}

fn expand_home(path: PathBuf) -> Result<PathBuf, StorageError> {
    let text = path.to_string_lossy();
    if text == "~" || text.starts_with("~/") {
        let home = env::var_os("HOME")
            .filter(|value| !value.is_empty())
            .ok_or(StorageError::NoDataRoot)?;
        let rest = text.strip_prefix("~/").unwrap_or("");
        return Ok(PathBuf::from(home).join(rest));
    }
    Ok(path)
}

/// Format a UTC `YYYYMMDD-HHMMSS` timestamp without a date-library dependency.
#[must_use]
pub fn utc_stamp(at: SystemTime) -> String {
    let seconds = at
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);
    let days = seconds.div_euclid(86_400);
    let second_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}{month:02}{day:02}-{:02}{:02}{:02}",
        second_of_day / 3_600,
        (second_of_day % 3_600) / 60,
        second_of_day % 60
    )
}

/// Format a UTC instant as an ISO-8601 `YYYY-MM-DDTHH:MM:SSZ` timestamp.
///
/// Pack documents use this spelling (`2026-11-14T12:00:00Z`), while snapshots
/// use the compact [`utc_stamp`] filename form. Both share one calendar
/// conversion, so they cannot disagree about the date.
#[must_use]
pub fn utc_iso8601(at: SystemTime) -> String {
    let seconds = at
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);
    let days = seconds.div_euclid(86_400);
    let second_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        second_of_day / 3_600,
        (second_of_day % 3_600) / 60,
        second_of_day % 60
    )
}

/// Howard Hinnant's `civil_from_days`, for UTC formatting without `chrono`.
fn civil_from_days(days_since_epoch: i64) -> (i64, u32, u32) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = if month_prime < 10 {
        month_prime + 3
    } else {
        month_prime - 9
    };
    let year = if month <= 2 { year + 1 } else { year };
    (year, month as u32, day as u32)
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Write `bytes` to `path` atomically: temp file in the same directory, fsync,
/// then rename. A failure at any point leaves the previous file untouched and
/// removes the temp file.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), StorageError> {
    write_atomic_with_hook(path, bytes, |_| Ok(()))
}

fn write_atomic_with_hook<F>(
    path: &Path,
    bytes: &[u8],
    before_rename: F,
) -> Result<(), StorageError>
where
    F: FnOnce(&Path) -> Result<(), StorageError>,
{
    let parent = match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };
    fs::create_dir_all(parent).map_err(|source| io_at(parent, source))?;

    let file_name = path
        .file_name()
        .ok_or_else(|| StorageError::InvalidSegment(path.display().to_string()))?
        .to_string_lossy();
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temp_path = parent.join(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        counter
    ));

    let mut guard = TempPathGuard::new(temp_path.clone());
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp_path)
        .map_err(|source| io_at(&temp_path, source))?;
    file.write_all(bytes)
        .map_err(|source| io_at(&temp_path, source))?;
    file.sync_all()
        .map_err(|source| io_at(&temp_path, source))?;
    drop(file);

    before_rename(&temp_path)?;
    fs::rename(&temp_path, path).map_err(|source| io_at(path, source))?;
    guard.disarm();
    sync_parent_dir(parent);
    Ok(())
}

struct TempPathGuard {
    path: Option<PathBuf>,
}

impl TempPathGuard {
    fn new(path: PathBuf) -> Self {
        Self { path: Some(path) }
    }

    fn disarm(&mut self) {
        self.path = None;
    }
}

impl Drop for TempPathGuard {
    fn drop(&mut self) {
        if let Some(path) = self.path.take() {
            let _ = fs::remove_file(path);
        }
    }
}

fn sync_parent_dir(parent: &Path) {
    #[cfg(unix)]
    {
        // Best effort: the rename is already atomic; a parent fsync only makes
        // the directory entry durable. Some filesystems refuse opening a dir.
        if let Ok(dir) = File::open(parent) {
            let _ = dir.sync_all();
        }
    }
    #[cfg(not(unix))]
    let _ = parent;
}

/// Open (and migrate) the operational SQLite DB under the root.
pub fn open_miner_db(root: &DataRoot) -> Result<Connection, StorageError> {
    root.ensure_layout()?;
    let path = root.db_path();
    let connection = Connection::open(&path)?;
    configure_connection(&connection)?;
    migrate(&connection)?;
    Ok(connection)
}

fn configure_connection(connection: &Connection) -> Result<(), StorageError> {
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.busy_timeout(Duration::from_secs(5))?;
    connection
        .pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get::<_, String>(0))?;
    Ok(())
}

/// Apply pending schema migrations; idempotent.
pub fn migrate(connection: &Connection) -> Result<u32, StorageError> {
    let current: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let current = u32::try_from(current).unwrap_or(u32::MAX);
    if current > SCHEMA_VERSION {
        return Err(StorageError::SchemaTooNew {
            found: current,
            supported: SCHEMA_VERSION,
        });
    }
    for (index, sql) in MIGRATIONS.iter().enumerate() {
        let version = u32::try_from(index + 1).unwrap_or(u32::MAX);
        if version <= current {
            continue;
        }
        let transaction = connection.unchecked_transaction()?;
        transaction.execute_batch(sql)?;
        transaction.pragma_update(None, "user_version", i64::from(version))?;
        transaction.commit()?;
    }
    Ok(SCHEMA_VERSION)
}

/// Read the DB schema version.
pub fn schema_version(connection: &Connection) -> Result<u32, StorageError> {
    let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    Ok(u32::try_from(version).unwrap_or(u32::MAX))
}

/// Snapshot the DB with `VACUUM INTO` and verify `PRAGMA integrity_check`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SnapshotInfo {
    /// Absolute on-disk snapshot path.
    pub path: PathBuf,
    /// Snapshot size.
    pub bytes: u64,
    /// SHA-256 of the snapshot file.
    pub sha256: String,
}

impl SnapshotInfo {
    /// Copy this snapshot to the optional rclone remote.
    pub fn backup(&self, remote: Option<&RemoteBackup>) -> BackupOutcome {
        plan_snapshot_backup(&self.path, remote)
    }
}

/// Create a timestamped, integrity-checked snapshot of `connection`.
pub fn snapshot_database(
    connection: &Connection,
    destination: &Path,
) -> Result<SnapshotInfo, StorageError> {
    if destination.exists() {
        return Err(StorageError::SnapshotExists(
            destination.display().to_string(),
        ));
    }
    if let Some(parent) = destination.parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent).map_err(|source| io_at(parent, source))?;
    }
    let destination_text = destination
        .to_str()
        .ok_or_else(|| StorageError::NonUtf8Path(destination.display().to_string()))?;
    connection.execute("VACUUM INTO ?1", params![destination_text])?;

    let bytes = fs::read(destination).map_err(|source| io_at(destination, source))?;
    let sha256 = sha256_hex(&bytes);

    let check = Connection::open(destination)?;
    let integrity: String = check.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
    if integrity != "ok" {
        return Err(StorageError::Integrity(integrity));
    }
    Ok(SnapshotInfo {
        path: destination.to_path_buf(),
        bytes: bytes.len() as u64,
        sha256,
    })
}

/// Count rows in every miner table (a cheap fixture/migration assertion).
pub fn row_counts(connection: &Connection) -> Result<BTreeMap<&'static str, i64>, StorageError> {
    let mut counts = BTreeMap::new();
    for &table in MINER_TABLES {
        let count: i64 =
            connection.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })?;
        counts.insert(table, count);
    }
    Ok(counts)
}

/// One prepared external command, never executed by the library.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BackupCommand {
    /// Program name.
    pub program: String,
    /// Arguments in order.
    pub args: Vec<String>,
}

impl BackupCommand {
    /// Render the command for an operator log.
    #[must_use]
    pub fn display(&self) -> String {
        let mut text = self.program.clone();
        for arg in &self.args {
            text.push(' ');
            text.push_str(arg);
        }
        text
    }
}

/// Result of planning the optional rclone backup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackupOutcome {
    /// No remote configured: the pipeline writes locally and does nothing.
    Skipped {
        /// Why the backup was skipped.
        reason: &'static str,
    },
    /// Commands the operator/corpus runner may execute after a run.
    Planned {
        /// Copy/check commands, in order.
        commands: Vec<BackupCommand>,
    },
}

impl BackupOutcome {
    /// Whether nothing is to be done.
    #[must_use]
    pub fn is_skipped(&self) -> bool {
        matches!(self, Self::Skipped { .. })
    }

    /// The planned commands, empty when skipped.
    #[must_use]
    pub fn commands(&self) -> &[BackupCommand] {
        match self {
            Self::Skipped { .. } => &[],
            Self::Planned { commands } => commands,
        }
    }

    /// The skip reason, when skipped.
    #[must_use]
    pub fn skip_reason(&self) -> Option<&'static str> {
        match self {
            Self::Skipped { reason } => Some(reason),
            Self::Planned { .. } => None,
        }
    }
}

/// An rclone remote folder such as `gdrive:riichiprac`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteBackup {
    remote: String,
}

impl RemoteBackup {
    /// Parse `remote:folder`. Credentials are rclone's concern, never ours.
    pub fn parse(raw: &str) -> Result<Self, StorageError> {
        let value = raw.trim();
        let Some((name, folder)) = value.split_once(':') else {
            return Err(StorageError::InvalidRemote(raw.to_string()));
        };
        if name.is_empty()
            || folder.is_empty()
            || name.starts_with('-')
            || value.chars().any(char::is_whitespace)
            || folder.contains("..")
        {
            return Err(StorageError::InvalidRemote(raw.to_string()));
        }
        Ok(Self {
            remote: value.trim_end_matches('/').to_string(),
        })
    }

    /// Read [`RCLONE_REMOTE_ENV`], or `None` when backup is not configured.
    pub fn from_env() -> Result<Option<Self>, StorageError> {
        match env::var(RCLONE_REMOTE_ENV) {
            Ok(value) if !value.trim().is_empty() => Self::parse(&value).map(Some),
            _ => Ok(None),
        }
    }

    /// The configured `remote:folder`.
    #[must_use]
    pub fn remote(&self) -> &str {
        &self.remote
    }

    /// Destination for a remote sub-folder.
    #[must_use]
    pub fn destination(&self, sub_folder: &str) -> String {
        format!("{}/{}", self.remote.trim_end_matches('/'), sub_folder)
    }
}

fn rclone(args: Vec<String>) -> BackupCommand {
    BackupCommand {
        program: "rclone".to_string(),
        args,
    }
}

/// Plan the append-only raw-log copy and `rclone check`.
///
/// The local corpus is immutable and content-addressed, so `copy` (never
/// `sync`) plus `--immutable` prevents accidental overwrite. No command runs
/// here; the corpus runner executes the plan.
#[must_use]
pub fn plan_replay_backup(root: &DataRoot, remote: Option<&RemoteBackup>) -> BackupOutcome {
    let Some(remote) = remote else {
        return BackupOutcome::Skipped {
            reason: "no rclone remote configured (set RIICHI_RCLONE_REMOTE)",
        };
    };
    let local = root.replays_dir().display().to_string();
    let destination = remote.destination(RCLONE_REPLAYS_DIR);
    BackupOutcome::Planned {
        commands: vec![
            rclone(vec![
                "copy".to_string(),
                "--checksum".to_string(),
                "--immutable".to_string(),
                local.clone(),
                destination.clone(),
            ]),
            rclone(vec![
                "check".to_string(),
                local,
                destination,
                "--checksum".to_string(),
            ]),
        ],
    }
}

/// Plan the copy of one timestamped DB snapshot. Never copies a live DB.
#[must_use]
pub fn plan_snapshot_backup(snapshot: &Path, remote: Option<&RemoteBackup>) -> BackupOutcome {
    let Some(remote) = remote else {
        return BackupOutcome::Skipped {
            reason: "no rclone remote configured (set RIICHI_RCLONE_REMOTE)",
        };
    };
    BackupOutcome::Planned {
        commands: vec![rclone(vec![
            "copy".to_string(),
            snapshot.display().to_string(),
            remote.destination(RCLONE_DB_DIR),
        ])],
    }
}

const MIGRATIONS: &[&str] = &[MIGRATION_1, MIGRATION_2];

const MIGRATION_1: &str = r#"
PRAGMA foreign_keys = ON;

-- One corpus generation run.
CREATE TABLE IF NOT EXISTS corpus_runs (
    run_id              TEXT PRIMARY KEY,
    corpus_id           TEXT NOT NULL,
    family              TEXT NOT NULL,
    match_plan_id       TEXT NOT NULL,
    match_plan_sha256   TEXT NOT NULL,
    started_at          TEXT NOT NULL,
    finished_at         TEXT NULL,
    replay_count        INTEGER NOT NULL DEFAULT 0 CHECK (replay_count >= 0),
    local_dir           TEXT NOT NULL,
    gdrive_dir          TEXT NULL,
    db_snapshot         TEXT NULL,
    rclone_status       TEXT NOT NULL DEFAULT 'skipped'
                        CHECK (rclone_status IN ('ok', 'failed', 'skipped')),
    report_json         TEXT NULL
);

-- One immutable AI self-play game. `source` is a DB-level fail-closed gate.
CREATE TABLE IF NOT EXISTS replays (
    replay_id           TEXT PRIMARY KEY CHECK (length(replay_id) = 64),
    source              TEXT NOT NULL DEFAULT 'ai_selfplay'
                        CHECK (source = 'ai_selfplay'),
    licence             TEXT NOT NULL,
    attribution         TEXT NOT NULL,
    format              TEXT NOT NULL CHECK (format = 'mjai'),
    rule                TEXT NOT NULL,
    rule_config_hash    TEXT NOT NULL,
    generated_at        TEXT NOT NULL,
    model               TEXT NOT NULL,
    model_sha256        TEXT NOT NULL,
    seed                TEXT NOT NULL,
    log_path            TEXT NOT NULL UNIQUE,
    log_bytes           INTEGER NOT NULL CHECK (log_bytes > 0),
    log_sha256          TEXT NOT NULL CHECK (length(log_sha256) = 64),
    validation_status   TEXT NOT NULL
                        CHECK (validation_status IN ('ok', 'bad', 'partial')),
    ingested_at         TEXT NOT NULL,
    storage_backend     TEXT NOT NULL DEFAULT 'local'
                        CHECK (storage_backend IN ('local', 'gdrive')),
    backed_up_at        TEXT NULL,
    backup_sha256       TEXT NULL,
    -- F1 extensions: corpus/family/roster and the full provenance document.
    corpus_id           TEXT NOT NULL,
    family              TEXT NOT NULL,
    match_plan_id       TEXT NOT NULL,
    match_plan_sha256   TEXT NOT NULL,
    agents              TEXT NOT NULL,
    cross_engine        INTEGER NOT NULL DEFAULT 0
                        CHECK (cross_engine IN (0, 1)),
    data_commercial_use INTEGER NOT NULL DEFAULT 0
                        CHECK (data_commercial_use IN (0, 1)),
    provenance_json     TEXT NOT NULL
);

-- One decision point inside a replay.
CREATE TABLE IF NOT EXISTS decisions (
    decision_id             TEXT PRIMARY KEY,
    replay_id               TEXT NOT NULL
                            REFERENCES replays(replay_id) ON DELETE CASCADE,
    family                  TEXT NOT NULL,
    kyoku                   INTEGER NOT NULL,
    honba                   INTEGER NOT NULL,
    event_index             INTEGER NOT NULL CHECK (event_index >= 0),
    turn                    INTEGER NOT NULL,
    seat                    INTEGER NOT NULL CHECK (seat BETWEEN 0 AND 3),
    decision_kind           TEXT NOT NULL,
    state_hash              TEXT NOT NULL,
    state_json              TEXT NOT NULL,
    visible_info_hash       TEXT NULL,
    legal_actions           TEXT NOT NULL,
    played_action           TEXT NOT NULL,
    trigger                 TEXT NULL,
    trigger_detail          TEXT NULL,
    book_match              TEXT NULL,
    mortal_top              TEXT NULL,
    mortal_top_prob         REAL NULL,
    mortal_margin           REAL NULL,
    mortal_ranking          TEXT NULL,
    label_kind              TEXT NULL
                            CHECK (label_kind IS NULL OR label_kind IN
                                ('book', 'mortal', 'contested', 'mistake',
                                 'close_call', 'weak_opponent', 'none')),
    label_source            TEXT NULL,
    label_json              TEXT NULL,
    labeler_model           TEXT NULL,
    labeler_model_sha256    TEXT NULL,
    classifier_version      TEXT NULL,
    q_values_json           TEXT NULL,
    q_units                 TEXT NULL
                            CHECK (q_units IS NULL OR q_units = 'model_utility'),
    interestingness         REAL NULL,
    selection_reason        TEXT NULL,
    pack_id                 TEXT NULL,
    UNIQUE (replay_id, event_index)
);

-- A curated scenario selected for a pack.
CREATE TABLE IF NOT EXISTS selected_scenarios (
    scenario_id         TEXT PRIMARY KEY,
    decision_id         TEXT NOT NULL
                        REFERENCES decisions(decision_id) ON DELETE CASCADE,
    pack_id             TEXT NULL,
    lesson_id           TEXT NOT NULL,
    family              TEXT NOT NULL,
    correct_action      TEXT NOT NULL,
    accepted            TEXT NOT NULL,
    variant_of          TEXT NULL
                        REFERENCES selected_scenarios(scenario_id) ON DELETE SET NULL,
    transform_chain     TEXT NULL,
    label_check         TEXT NULL,
    label_kind          TEXT NOT NULL,
    label_source        TEXT NOT NULL,
    selection_reason    TEXT NULL,
    provenance          TEXT NOT NULL,
    created_at          TEXT NOT NULL
);

-- A transformed variant of a selected scenario.
CREATE TABLE IF NOT EXISTS variants (
    variant_id          TEXT PRIMARY KEY,
    base_scenario_id    TEXT NOT NULL
                        REFERENCES selected_scenarios(scenario_id) ON DELETE CASCADE,
    transform_chain     TEXT NOT NULL,
    transform_seed      TEXT NOT NULL,
    label_preserved     INTEGER NOT NULL CHECK (label_preserved IN (0, 1)),
    rejection_reason    TEXT NULL,
    created_at          TEXT NOT NULL
);

-- A published (or publishable) static pack export.
CREATE TABLE IF NOT EXISTS packs (
    pack_id             TEXT PRIMARY KEY,
    version             INTEGER NOT NULL,
    schema              TEXT NOT NULL,
    manifest_path       TEXT NULL,
    sha256              TEXT NOT NULL,
    bytes               INTEGER NOT NULL CHECK (bytes >= 0),
    scenario_count      INTEGER NOT NULL CHECK (scenario_count >= 0),
    source_mix          TEXT NOT NULL,
    licence             TEXT NOT NULL,
    data_commercial_use INTEGER NOT NULL DEFAULT 0
                        CHECK (data_commercial_use IN (0, 1)),
    published_at        TEXT NULL,
    export_path         TEXT NOT NULL,
    db_backup_id        TEXT NULL REFERENCES backups(backup_id),
    created_at          TEXT NOT NULL
);

-- A local snapshot or optional rclone copy.
CREATE TABLE IF NOT EXISTS backups (
    backup_id           TEXT PRIMARY KEY,
    kind                TEXT NOT NULL
                        CHECK (kind IN ('replay_copy', 'db_snapshot', 'pack_copy')),
    path                TEXT NOT NULL,
    sha256              TEXT NOT NULL,
    bytes               INTEGER NOT NULL CHECK (bytes >= 0),
    created_at          TEXT NOT NULL,
    rclone_remote       TEXT NULL,
    verified_at         TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_replays_family ON replays(family);
CREATE INDEX IF NOT EXISTS idx_replays_corpus ON replays(corpus_id, family);
CREATE INDEX IF NOT EXISTS idx_decisions_replay ON decisions(replay_id);
CREATE INDEX IF NOT EXISTS idx_decisions_family ON decisions(family);
CREATE INDEX IF NOT EXISTS idx_decisions_pack ON decisions(pack_id);
CREATE INDEX IF NOT EXISTS idx_selected_pack ON selected_scenarios(pack_id);
CREATE INDEX IF NOT EXISTS idx_variants_base ON variants(base_scenario_id);
"#;

/// L1: the Mortal label cache.
///
/// One row per `(state_hash, model_sha256, classifier_version, options_hash)`.
/// `status = 'ok'` with a `label_json` payload is finished work: a rerun skips
/// it. `status = 'failed'` records the last error and is retried, so a transient
/// failure never becomes permanent. `attempts` counts evaluation attempts.
///
/// The table is a cache, not the source of truth for a packed label: the
/// `decisions` row keeps its own copy. Deleting it only costs one re-evaluation.
const MIGRATION_2: &str = r#"
-- L1 Mortal label cache. Keyed by the model-visible state, not by decision id:
-- several decisions that present the same table position share one evaluation.
CREATE TABLE IF NOT EXISTS model_labels (
    state_hash          TEXT NOT NULL,
    model_sha256        TEXT NOT NULL CHECK (length(model_sha256) = 64),
    classifier_version  TEXT NOT NULL,
    options_hash        TEXT NOT NULL CHECK (length(options_hash) = 64),
    status              TEXT NOT NULL CHECK (status IN ('ok', 'failed')),
    attempts            INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 1),
    label_json          TEXT NULL,
    last_error          TEXT NULL,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    PRIMARY KEY (state_hash, model_sha256, classifier_version, options_hash)
);

CREATE INDEX IF NOT EXISTS idx_model_labels_status ON model_labels(status);
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn root() -> (tempfile::TempDir, DataRoot) {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = DataRoot::new(dir.path()).expect("data root");
        (dir, root)
    }

    #[test]
    fn layout_is_created_under_the_root() {
        let (_dir, root) = root();
        root.ensure_layout().expect("layout");
        for dir in [
            root.replays_dir(),
            root.db_dir(),
            root.snapshots_dir(),
            root.packs_dir(),
            root.tmp_dir(),
            root.logs_dir(),
        ] {
            assert!(dir.is_dir(), "{} must exist", dir.display());
            assert!(dir.starts_with(root.root()));
        }
        assert_eq!(root.db_path(), root.root().join("db/miner.sqlite"));
    }

    #[test]
    fn relative_path_rule_rejects_absolute_and_traversal() {
        for valid in [
            "replays/mortal_mirror/abc.jsonl.gz",
            "db/miner.sqlite",
            "packs/pack-1.json.gz",
        ] {
            validate_relative_path(valid).unwrap_or_else(|err| panic!("{valid}: {err}"));
        }
        for invalid in [
            "",
            " ",
            "/etc/passwd",
            "../secrets",
            "replays/../../x",
            "a\\b",
        ] {
            assert!(
                validate_relative_path(invalid).is_err(),
                "{invalid} must be rejected"
            );
        }
        assert!(matches!(
            validate_relative_path("C:/tmp/x"),
            Err(StorageError::AbsolutePath(_))
        ));
    }

    #[test]
    fn data_root_resolves_and_relativises_paths() {
        let (_dir, root) = root();
        let id = ReplayId::from_bytes(b"log");
        let relative = DataRoot::replay_relative_path("mortal_mirror", &id).expect("relative");
        assert_eq!(relative, format!("replays/mortal_mirror/{id}.jsonl.gz"));
        let absolute = root.replay_path("mortal_mirror", &id).expect("absolute");
        assert!(absolute.starts_with(root.root()));
        assert_eq!(root.relative_path(&absolute).expect("relative"), relative);
        assert_eq!(root.resolve_relative(&relative).expect("resolve"), absolute);

        let outside = root
            .root()
            .parent()
            .expect("parent")
            .join("elsewhere.jsonl.gz");
        assert!(matches!(
            root.relative_path(&outside),
            Err(StorageError::OutsideDataRoot(_))
        ));
        assert!(root.resolve_relative("/absolute").is_err());
        assert!(root.resolve_relative("replays/../../x").is_err());
        assert!(DataRoot::replay_relative_path("..", &id).is_err());
    }

    #[test]
    fn empty_data_root_is_rejected() {
        assert!(matches!(
            DataRoot::new(""),
            Err(StorageError::EmptyDataRoot)
        ));
    }

    #[test]
    fn utc_stamp_formats_known_instants() {
        assert_eq!(utc_stamp(UNIX_EPOCH), "19700101-000000");
        assert_eq!(
            utc_stamp(UNIX_EPOCH + Duration::from_secs(946_684_800)),
            "20000101-000000"
        );
        // 2026-11-16T00:00:00Z
        assert_eq!(
            utc_stamp(UNIX_EPOCH + Duration::from_secs(1_794_787_200)),
            "20261116-000000"
        );
        assert_eq!(utc_iso8601(UNIX_EPOCH), "1970-01-01T00:00:00Z");
        assert_eq!(
            utc_iso8601(UNIX_EPOCH + Duration::from_secs(1_794_787_200 + 43_201)),
            "2026-11-16T12:00:01Z"
        );
        let root = DataRoot::new("/tmp").expect("root");
        assert_eq!(
            root.snapshot_path(UNIX_EPOCH)
                .file_name()
                .and_then(|name| name.to_str()),
            Some("miner-19700101-000000.sqlite")
        );
        assert!(root.snapshot_path_named("2026-11").is_ok());
        assert!(root.snapshot_path_named("../x").is_err());
    }

    #[test]
    fn atomic_write_creates_and_replaces_the_target() {
        let (dir, _root) = root();
        let target = dir.path().join("nested/file.json");
        write_atomic(&target, b"one").expect("first write");
        assert_eq!(fs::read(&target).expect("read"), b"one");
        write_atomic(&target, b"two").expect("overwrite");
        assert_eq!(fs::read(&target).expect("read"), b"two");
        assert!(
            !target.parent().expect("parent").join("nested").exists()
                || fs::read_dir(target.parent().expect("parent"))
                    .expect("read dir")
                    .all(|entry| !entry
                        .expect("entry")
                        .file_name()
                        .to_string_lossy()
                        .ends_with(".tmp")),
            "no temp file may be left behind"
        );
    }

    #[test]
    fn atomic_write_failure_leaves_no_partial_file() {
        let (dir, _root) = root();
        let target = dir.path().join("state.json");
        write_atomic(&target, b"old").expect("seed");

        let error = write_atomic_with_hook(&target, b"new", |_| {
            Err(StorageError::Integrity("injected failure".to_string()))
        });
        assert!(error.is_err());
        assert_eq!(fs::read(&target).expect("old content"), b"old");
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .expect("read dir")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "temp file must be removed: {leftovers:?}"
        );

        // A brand-new target must not appear at all.
        let fresh = dir.path().join("fresh.json");
        assert!(
            write_atomic_with_hook(&fresh, b"new", |_| Err(StorageError::EmptyDataRoot)).is_err()
        );
        assert!(!fresh.exists(), "failed write must not create the target");
    }

    #[test]
    fn migration_creates_tables_and_is_idempotent() {
        let connection = Connection::open_in_memory().expect("memory db");
        assert_eq!(schema_version(&connection).expect("version"), 0);
        assert_eq!(migrate(&connection).expect("migrate"), SCHEMA_VERSION);
        assert_eq!(
            schema_version(&connection).expect("version"),
            SCHEMA_VERSION
        );

        let tables: Vec<String> = {
            let mut statement = connection
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
                .expect("prepare");
            statement
                .query_map([], |row| row.get(0))
                .expect("query")
                .collect::<Result<_, _>>()
                .expect("rows")
        };
        for table in MINER_TABLES {
            assert!(
                tables.iter().any(|found| found == table),
                "{table} missing from {tables:?}"
            );
        }

        assert_eq!(
            migrate(&connection).expect("second migrate"),
            SCHEMA_VERSION
        );
        let counts = row_counts(&connection).expect("counts");
        assert_eq!(counts.len(), MINER_TABLES.len());
        assert!(counts.values().all(|count| *count == 0));
    }

    #[test]
    fn schema_rejects_a_non_selfplay_source_and_orphans() {
        let connection = Connection::open_in_memory().expect("memory db");
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .expect("fk");
        migrate(&connection).expect("migrate");

        let insert_replay = |source: &str| {
            connection.execute(
                "INSERT INTO replays (
                    replay_id, source, licence, attribution, format, rule,
                    rule_config_hash, generated_at, model, model_sha256, seed,
                    log_path, log_bytes, log_sha256, validation_status,
                    ingested_at, corpus_id, family, match_plan_id,
                    match_plan_sha256, agents, provenance_json
                 ) VALUES (?1, ?2, 'CC-BY-4.0', 'fixture', 'mjai', 'tenhou-4p-hanchan',
                    ?3, '2026-11-16T00:00:00Z', 'mortal-298k', ?4, '0x01',
                    ?5, 10, ?6, 'ok', '2026-11-16T00:01:00Z', 'mixed-2026-11',
                    'mortal_mirror', 'm1', ?7, '[]', '{}')",
                params![
                    "a".repeat(64),
                    source,
                    "b".repeat(64),
                    "c".repeat(64),
                    format!("replays/mortal_mirror/{}.jsonl.gz", "a".repeat(64)),
                    "d".repeat(64),
                    "e".repeat(64),
                ],
            )
        };

        assert!(insert_replay("ai_selfplay").is_ok());
        let error = insert_replay("tenhou_houou").expect_err("source CHECK must reject");
        assert!(
            error.to_string().contains("CHECK"),
            "unexpected error: {error}"
        );

        // A decision cannot exist without its replay.
        let orphan = connection.execute(
            "INSERT INTO decisions (
                decision_id, replay_id, family, kyoku, honba, event_index, turn,
                seat, decision_kind, state_hash, state_json, legal_actions,
                played_action
             ) VALUES ('d1', ?1, 'mortal_mirror', 0, 0, 0, 0, 0, 'self_turn',
                'h', '{}', '[]', '{}')",
            params!["f".repeat(64)],
        );
        assert!(
            orphan.is_err(),
            "foreign key must reject an orphan decision"
        );
    }

    #[test]
    fn full_fixture_round_trips_through_the_schema() {
        let connection = Connection::open_in_memory().expect("memory db");
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .expect("fk");
        migrate(&connection).expect("migrate");
        let replay_id = "a".repeat(64);

        connection
            .execute(
                "INSERT INTO corpus_runs (
                    run_id, corpus_id, family, match_plan_id, match_plan_sha256,
                    started_at, finished_at, replay_count, local_dir, rclone_status
                 ) VALUES ('run-1', 'mixed-2026-11', 'mortal_mirror', 'm1', ?1,
                    '2026-11-16T00:00:00Z', '2026-11-16T01:00:00Z', 1,
                    'replays/mortal_mirror', 'skipped')",
                params!["b".repeat(64)],
            )
            .expect("corpus run");

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
                    'mortal-298k', ?3, '0x01', ?4, 10, ?1, 'ok',
                    '2026-11-16T00:01:00Z', 'mixed-2026-11', 'mortal_mirror',
                    'm1', ?5, '[]', '{}')",
                params![
                    replay_id,
                    "b".repeat(64),
                    "c".repeat(64),
                    format!("replays/mortal_mirror/{replay_id}.jsonl.gz"),
                    "d".repeat(64),
                ],
            )
            .expect("replay");

        connection
            .execute(
                "INSERT INTO decisions (
                    decision_id, replay_id, family, kyoku, honba, event_index,
                    turn, seat, decision_kind, state_hash, state_json,
                    legal_actions, played_action, trigger
                 ) VALUES ('decision-1', ?1, 'mortal_mirror', 0, 0, 0, 0, 0,
                    'self_turn', 'h', '{}', '[]', '{}', 'book:ch8.1')",
                params![replay_id],
            )
            .expect("decision");

        connection
            .execute(
                "INSERT INTO selected_scenarios (
                    scenario_id, decision_id, lesson_id, family, correct_action,
                    accepted, label_kind, label_source, provenance, created_at
                 ) VALUES ('scenario-1', 'decision-1', 'fold_to_riichi',
                    'mortal_mirror', '{}', '[]', 'book', 'book', '{}',
                    '2026-11-16T00:02:00Z')",
                [],
            )
            .expect("selected scenario");

        connection
            .execute(
                "INSERT INTO variants (
                    variant_id, base_scenario_id, transform_chain,
                    transform_seed, label_preserved, created_at
                 ) VALUES ('variant-1', 'scenario-1', '[]', 'seed-1', 1,
                    '2026-11-16T00:03:00Z')",
                [],
            )
            .expect("variant");

        connection
            .execute(
                "INSERT INTO backups (
                    backup_id, kind, path, sha256, bytes, created_at
                 ) VALUES ('backup-1', 'db_snapshot',
                    'snapshots/miner-20261116-000000.sqlite', ?1, 1024,
                    '2026-11-16T00:04:00Z')",
                params!["e".repeat(64)],
            )
            .expect("backup");

        connection
            .execute(
                "INSERT INTO packs (
                    pack_id, version, schema, sha256, bytes, scenario_count,
                    source_mix, licence, export_path, db_backup_id, created_at
                 ) VALUES ('pack-1', 1, 'riichiprac.scenario-pack', ?1, 2048,
                    1, '{}', 'CC-BY-4.0', 'packs/pack-1.json.gz', 'backup-1',
                    '2026-11-16T00:05:00Z')",
                params!["f".repeat(64)],
            )
            .expect("pack");

        let counts = row_counts(&connection).expect("counts");
        assert_eq!(counts["corpus_runs"], 1);
        assert_eq!(counts["replays"], 1);
        assert_eq!(counts["decisions"], 1);
        assert_eq!(counts["selected_scenarios"], 1);
        assert_eq!(counts["variants"], 1);
        assert_eq!(counts["packs"], 1);
        assert_eq!(counts["backups"], 1);
    }

    #[test]
    fn snapshot_passes_integrity_check() {
        let (_dir, root) = root();
        let connection = open_miner_db(&root).expect("open");
        connection
            .execute(
                "INSERT INTO backups (
                    backup_id, kind, path, sha256, bytes, created_at
                 ) VALUES ('snap-1', 'db_snapshot', 'snapshots/x.sqlite', ?1,
                    1, '2026-11-16T00:00:00Z')",
                params!["a".repeat(64)],
            )
            .expect("seed row");
        let destination = root.snapshot_path(UNIX_EPOCH + Duration::from_secs(1_794_787_200));
        let info = snapshot_database(&connection, &destination).expect("snapshot");
        assert_eq!(info.path, destination);
        assert!(info.bytes > 0);
        assert_eq!(info.sha256.len(), 64);
        assert!(destination.is_file());

        let check = Connection::open(&destination).expect("open snapshot");
        let integrity: String = check
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .expect("integrity");
        assert_eq!(integrity, "ok");
        let restored: i64 = check
            .query_row("SELECT COUNT(*) FROM backups", [], |row| row.get(0))
            .expect("count");
        assert_eq!(restored, 1);

        assert!(matches!(
            snapshot_database(&connection, &destination),
            Err(StorageError::SnapshotExists(_))
        ));
    }

    #[test]
    fn backup_is_a_no_op_without_a_remote() {
        let (_dir, root) = root();
        let replays = plan_replay_backup(&root, None);
        assert!(replays.is_skipped());
        assert!(replays.commands().is_empty());
        assert!(replays.skip_reason().is_some());

        let snapshot = plan_snapshot_backup(&root.snapshots_dir().join("x.sqlite"), None);
        assert!(snapshot.is_skipped());

        let remote = RemoteBackup::parse("gdrive:riichiprac").expect("remote");
        let planned = plan_replay_backup(&root, Some(&remote));
        assert!(!planned.is_skipped());
        assert_eq!(planned.commands().len(), 2);
        assert_eq!(
            planned.commands()[0].args,
            vec![
                "copy",
                "--checksum",
                "--immutable",
                root.replays_dir().to_string_lossy().as_ref(),
                "gdrive:riichiprac/replays",
            ]
        );
        assert_eq!(
            planned.commands()[1].args,
            vec![
                "check",
                root.replays_dir().to_string_lossy().as_ref(),
                "gdrive:riichiprac/replays",
                "--checksum",
            ]
        );

        let snapshot = plan_snapshot_backup(Path::new("/tmp/snap.sqlite"), Some(&remote));
        assert_eq!(snapshot.commands().len(), 1);
        assert_eq!(
            snapshot.commands()[0].args,
            vec!["copy", "/tmp/snap.sqlite", "gdrive:riichiprac/db"]
        );
    }

    #[test]
    fn remote_backup_rejects_bad_configuration() {
        for bad in [
            "",
            "gdrive",
            "gdrive:",
            ":riichiprac",
            "-x:riichiprac",
            "a b:riichiprac",
            "gdrive:../x",
        ] {
            assert!(RemoteBackup::parse(bad).is_err(), "{bad} must be rejected");
        }
        assert_eq!(
            RemoteBackup::parse(" gdrive:riichiprac/ ")
                .expect("remote")
                .remote(),
            "gdrive:riichiprac"
        );
        let remote = RemoteBackup::parse("gdrive:riichiprac").expect("remote");
        assert_eq!(remote.destination("replays"), "gdrive:riichiprac/replays");
    }
}
