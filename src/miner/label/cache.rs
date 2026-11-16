//! SQLite cache for Mortal labels (L1).
//!
//! One row per `(state_hash, model_sha256, classifier_version, options_hash)`,
//! created by the `model_labels` migration in [`crate::miner::storage`]. The
//! cache records outcomes, not just hits:
//!
//! - `status = 'ok'` with a parsed [`ModelLabel`] is finished work; a rerun
//!   skips it and never runs a forward pass for that key.
//! - `status = 'failed'` stores the last error and an attempt count. A later run
//!   retries it, so a transient failure never becomes permanent.
//!
//! The row is a cache, not the source of truth: the decision row keeps its own
//! `label_json` copy, and deleting this table only costs one re-evaluation.

use std::time::SystemTime;

use rusqlite::{Connection, OptionalExtension, params};

use super::{LabelError, LabelOptions, ModelIdentity, ModelLabel, state_hash};
use crate::miner::storage::utc_stamp;

/// One cache key: the model-visible state plus the model/classifier/options that
/// produced the label.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LabelKey {
    /// SHA-256 of the v4 observation ([`super::state_hash`]).
    pub state_hash: String,
    /// SHA-256 of the labeler checkpoint.
    pub model_sha256: String,
    /// Classifier generation.
    pub classifier_version: String,
    /// Hash of [`LabelOptions`].
    pub options_hash: String,
}

impl LabelKey {
    /// Build the key for a state and evaluator identity.
    #[must_use]
    pub fn new(
        state: &crate::state::GameState,
        identity: &ModelIdentity,
        classifier_version: &str,
        options: &LabelOptions,
    ) -> Self {
        Self {
            state_hash: state_hash(state),
            model_sha256: identity.model_sha256.clone(),
            classifier_version: classifier_version.to_string(),
            options_hash: options.options_hash(),
        }
    }
}

/// What the cache knows about one key.
#[derive(Debug, Clone, PartialEq)]
pub enum CacheLookup {
    /// No row for this key.
    Miss,
    /// A finished, decodable label. Boxed so a cache miss stays small.
    Hit(Box<ModelLabel>),
    /// A recorded failure (or an unreadable `ok` payload) that must be retried.
    Failed {
        /// Evaluation attempts recorded so far.
        attempts: u32,
        /// The previous error, when the row stored one.
        error: Option<String>,
    },
}

/// A handle over the miner database's `model_labels` table.
///
/// The cache deliberately borrows an open [`Connection`]: a shard run opens the
/// DB once, and every decision writes through the same connection.
pub struct LabelCache<'connection> {
    connection: &'connection Connection,
}

impl<'connection> LabelCache<'connection> {
    /// Wrap an open, migrated miner DB connection.
    #[must_use]
    pub fn new(connection: &'connection Connection) -> Self {
        Self { connection }
    }

    /// Look up one key.
    pub fn lookup(&self, key: &LabelKey) -> Result<CacheLookup, LabelError> {
        let row: Option<(String, i64, Option<String>, Option<String>)> = self
            .connection
            .query_row(
                "SELECT status, attempts, label_json, last_error
                   FROM model_labels
                  WHERE state_hash = ?1
                    AND model_sha256 = ?2
                    AND classifier_version = ?3
                    AND options_hash = ?4",
                params![
                    key.state_hash,
                    key.model_sha256,
                    key.classifier_version,
                    key.options_hash
                ],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;

        let Some((status, attempts, label_json, last_error)) = row else {
            return Ok(CacheLookup::Miss);
        };
        let attempts = u32::try_from(attempts).unwrap_or(u32::MAX);

        if status == "ok"
            && let Some(json) = label_json
        {
            match serde_json::from_str::<ModelLabel>(&json) {
                Ok(label) => return Ok(CacheLookup::Hit(Box::new(label))),
                Err(err) => {
                    return Ok(CacheLookup::Failed {
                        attempts,
                        error: Some(format!("cached label is unreadable: {err}")),
                    });
                }
            }
        }
        Ok(CacheLookup::Failed {
            attempts,
            error: last_error,
        })
    }

    /// Record a finished label.
    pub fn record_success(&self, key: &LabelKey, label: &ModelLabel) -> Result<(), LabelError> {
        let json = serde_json::to_string(label)?;
        let stamp = now_stamp();
        self.connection.execute(
            "INSERT INTO model_labels (
                state_hash, model_sha256, classifier_version, options_hash,
                status, attempts, label_json, last_error, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, 'ok', 1, ?5, NULL, ?6, ?6)
             ON CONFLICT(state_hash, model_sha256, classifier_version, options_hash)
             DO UPDATE SET
                status = 'ok',
                attempts = model_labels.attempts + 1,
                label_json = excluded.label_json,
                last_error = NULL,
                updated_at = excluded.updated_at",
            params![
                key.state_hash,
                key.model_sha256,
                key.classifier_version,
                key.options_hash,
                json,
                stamp
            ],
        )?;
        Ok(())
    }

    /// Record a failed evaluation, incrementing the attempt count.
    pub fn record_failure(&self, key: &LabelKey, error: &str) -> Result<(), LabelError> {
        let stamp = now_stamp();
        self.connection.execute(
            "INSERT INTO model_labels (
                state_hash, model_sha256, classifier_version, options_hash,
                status, attempts, label_json, last_error, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, 'failed', 1, NULL, ?5, ?6, ?6)
             ON CONFLICT(state_hash, model_sha256, classifier_version, options_hash)
             DO UPDATE SET
                status = 'failed',
                attempts = model_labels.attempts + 1,
                label_json = NULL,
                last_error = excluded.last_error,
                updated_at = excluded.updated_at",
            params![
                key.state_hash,
                key.model_sha256,
                key.classifier_version,
                key.options_hash,
                error,
                stamp
            ],
        )?;
        Ok(())
    }

    /// Count finished and failed rows for one model/classifier/options triple.
    pub fn counts(
        &self,
        model_sha256: &str,
        classifier_version: &str,
        options: &LabelOptions,
    ) -> Result<(u64, u64), LabelError> {
        let options_hash = options.options_hash();
        let finished: i64 = self.connection.query_row(
            "SELECT COUNT(*) FROM model_labels
              WHERE model_sha256 = ?1 AND classifier_version = ?2
                AND options_hash = ?3 AND status = 'ok'",
            params![model_sha256, classifier_version, options_hash],
            |row| row.get(0),
        )?;
        let failed: i64 = self.connection.query_row(
            "SELECT COUNT(*) FROM model_labels
              WHERE model_sha256 = ?1 AND classifier_version = ?2
                AND options_hash = ?3 AND status = 'failed'",
            params![model_sha256, classifier_version, options_hash],
            |row| row.get(0),
        )?;
        Ok((
            u64::try_from(finished).unwrap_or(0),
            u64::try_from(failed).unwrap_or(0),
        ))
    }
}

fn now_stamp() -> String {
    utc_stamp(SystemTime::now())
}
