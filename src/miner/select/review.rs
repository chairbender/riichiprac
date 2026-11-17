//! The JSONL review queue and its dispositions (implementation unit S2).
//!
//! Replay-strategy §7.5: "A human review step is not a luxury. The interestingness
//! score can rank, but it cannot tell whether a position *teaches* something."
//! This module makes the review step concrete and file-based:
//!
//! - [`ReviewItem`] is one JSONL line: the selection metadata a reviewer needs
//!   plus a complete [`crate::report::ScenarioReport`] for that single candidate,
//!   built by the app's existing report builder. The report is the same versioned
//!   document the in-app importer understands, so a reviewer sees the table, the
//!   graded answer, the book rationale and the Mortal ranking in one place.
//! - [`ReviewDisposition`] is the reviewer's accept/reject, appended to a
//!   sidecar `dispositions.jsonl`. The queue itself is never rewritten: a review
//!   round is an append-only log, and the latest disposition per item wins.
//! - [`review_queue`] reads a queue, re-validates every embedded report through
//!   [`crate::report::parse_report`] (which recomputes the derived fields and
//!   never trusts a saved verdict), records new dispositions and reports what is
//!   still pending.
//!
//! # Why re-validate on read
//!
//! A queue file may be edited by hand or written by an older run. Re-parsing the
//! report on read catches a malformed table, a wrong schema, a missing human or a
//! stale verdict before a reviewer spends attention on it. It also gives the
//! reviewer the importer's warnings.
//!
//! # What the queue is not
//!
//! It is not a pack. It contains the answer in the embedded report (the reviewer
//! must see it) and must never be published. The pack builder (P1b) emits the
//! trainee-facing payload from selected scenarios, not from this file.

use std::collections::BTreeMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use crate::miner::storage::utc_stamp;
use crate::miner::trigger::families::Family;
use crate::report::ScenarioReport;

use super::score::Signals;
use super::{Candidate, SelectionError};

/// Schema name carried by one review-queue line.
pub const REVIEW_SCHEMA: &str = "riichiprac.review-item";

/// Version of the review-item schema.
pub const REVIEW_VERSION: u32 = 1;

/// Schema name carried by one disposition line.
pub const DISPOSITION_SCHEMA: &str = "riichiprac.review-disposition";

/// Version of the disposition schema.
pub const DISPOSITION_VERSION: u32 = 1;

/// One queued candidate.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReviewItem {
    /// [`REVIEW_SCHEMA`].
    pub schema: String,
    /// [`REVIEW_VERSION`].
    pub version: u32,
    /// Stable queue id (`<pack>-<nnn>`).
    pub queue_id: String,
    /// Pack this item belongs to.
    pub pack_id: String,
    /// Content-addressed decision id.
    pub decision_id: String,
    /// The replay it came from.
    pub replay_id: String,
    /// The replay's corpus family.
    pub replay_family: String,
    /// The family whose quota selected it; `None` for a held-out QA item.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub family: Option<Family>,
    /// Every family the candidate can feed.
    #[serde(default)]
    pub families: Vec<Family>,
    /// 1-based rank inside the assigned family; `None` for a held-out item.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rank: Option<usize>,
    /// Composite score.
    pub score: f32,
    /// The ranking signals behind the score.
    pub signals: Signals,
    /// True for a held-out QA item; it must not become a pack scenario.
    pub held_out: bool,
    /// Answer-free selection reason.
    pub selection_reason: String,
    /// Book lesson id, when the answer is a book answer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lesson: Option<String>,
    /// Book section (`ch8.4`), when the answer has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub book_section: Option<String>,
    /// `book`, `contested`, `mortal` or `none`.
    pub label_kind: String,
    /// `stable`, `contested` or `unresolved`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label_stability: Option<String>,
    /// Labeler checkpoint name.
    pub label_model: String,
    /// Decision kind (`self_turn`, `call`, ...).
    pub decision_kind: String,
    /// Table turn.
    pub turn: usize,
    /// Turn bucket (`early`, `mid`, `late`).
    pub turn_bucket: String,
    /// Exact model-visible state hash.
    pub exact_hash: String,
    /// Literal visible-table fingerprint.
    pub visible_fingerprint: String,
    /// The single-candidate `riichiprac.scenario-report` the reviewer reads.
    pub review: ScenarioReport,
}

impl ReviewItem {
    /// Build one queue item from a selected (or held-out) candidate and its
    /// report.
    #[must_use]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        queue_id: String,
        pack_id: String,
        candidate: &Candidate,
        family: Option<Family>,
        rank: Option<usize>,
        held_out: bool,
        selection_reason: String,
        review: ScenarioReport,
    ) -> Self {
        Self {
            schema: REVIEW_SCHEMA.to_string(),
            version: REVIEW_VERSION,
            queue_id,
            pack_id,
            decision_id: candidate.decision_id.clone(),
            replay_id: candidate.replay_id.clone(),
            replay_family: candidate.replay_family.clone(),
            family,
            families: candidate.families.iter().copied().collect(),
            rank,
            score: candidate.score,
            signals: candidate.signals,
            held_out,
            selection_reason,
            lesson: candidate.lesson.clone(),
            book_section: candidate.book_section.clone(),
            label_kind: candidate.label.kind.clone(),
            label_stability: candidate.label.stability.clone(),
            label_model: candidate.label.model.clone(),
            decision_kind: candidate.kind.as_str().to_string(),
            turn: candidate.turn,
            turn_bucket: candidate.turn_bucket.as_str().to_string(),
            exact_hash: candidate.exact_hash.clone(),
            visible_fingerprint: candidate.visible_fingerprint.clone(),
            review,
        }
    }

    /// The one-line label a reviewer sees before opening the report.
    #[must_use]
    pub fn title(&self) -> String {
        let family = self
            .family
            .map_or_else(|| "held-out".to_string(), |family| family.to_string());
        let section = self.book_section.as_deref().unwrap_or("none");
        format!(
            "{} [{}] {} · {} · {} · {}",
            self.queue_id, family, self.decision_kind, self.turn_bucket, section, self.label_kind
        )
    }
}

/// A reviewer's verdict on one queue item.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DispositionVerdict {
    /// Ship it.
    Accepted,
    /// Do not ship it.
    Rejected,
}

impl DispositionVerdict {
    /// The JSON spelling.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::Rejected => "rejected",
        }
    }
}

impl std::fmt::Display for DispositionVerdict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One reviewer decision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewDisposition {
    /// [`DISPOSITION_SCHEMA`].
    pub schema: String,
    /// [`DISPOSITION_VERSION`].
    pub version: u32,
    /// The item reviewed.
    pub queue_id: String,
    /// The decision inside it.
    pub decision_id: String,
    /// Accept or reject.
    pub verdict: DispositionVerdict,
    /// Optional reviewer note.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// When it was recorded, `YYYYMMDD-HHMMSS` UTC.
    pub reviewed_at: String,
}

impl ReviewDisposition {
    /// Build a disposition for one item.
    #[must_use]
    pub fn new(item: &ReviewItem, verdict: DispositionVerdict, note: Option<String>) -> Self {
        Self {
            schema: DISPOSITION_SCHEMA.to_string(),
            version: DISPOSITION_VERSION,
            queue_id: item.queue_id.clone(),
            decision_id: item.decision_id.clone(),
            verdict,
            note: note.filter(|note| !note.trim().is_empty()),
            reviewed_at: utc_stamp(SystemTime::now()),
        }
    }

    /// Validate the envelope.
    fn validate(&self, line: usize) -> Result<(), SelectionError> {
        if self.schema != DISPOSITION_SCHEMA {
            return Err(SelectionError::Review(format!(
                "disposition line {line}: schema `{}` is not `{DISPOSITION_SCHEMA}`",
                self.schema
            )));
        }
        if self.version > DISPOSITION_VERSION {
            return Err(SelectionError::Review(format!(
                "disposition line {line}: version {} is newer than {DISPOSITION_VERSION}",
                self.version
            )));
        }
        Ok(())
    }
}

/// A loaded queue.
#[derive(Debug, Clone, PartialEq)]
pub struct ReviewQueue {
    /// The file it was read from.
    pub path: PathBuf,
    /// Every item, in file order.
    pub items: Vec<ReviewItem>,
}

impl ReviewQueue {
    /// Where the disposition sidecar lives for this queue.
    #[must_use]
    pub fn dispositions_path(&self) -> PathBuf {
        self.path
            .parent()
            .map_or_else(|| PathBuf::from("."), Path::to_path_buf)
            .join("dispositions.jsonl")
    }
}

/// Read and structurally validate a queue file.
pub fn read_queue(path: &Path) -> Result<ReviewQueue, SelectionError> {
    let text = std::fs::read_to_string(path).map_err(|source| SelectionError::Io {
        path: path.display().to_string(),
        source,
    })?;
    let items = parse_queue_lines(&text, path)?;
    Ok(ReviewQueue {
        path: path.to_path_buf(),
        items,
    })
}

fn parse_queue_lines(text: &str, path: &Path) -> Result<Vec<ReviewItem>, SelectionError> {
    let mut items = Vec::new();
    for (index, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let item: ReviewItem = serde_json::from_str(line).map_err(|err| {
            SelectionError::Review(format!("{}:{}: {err}", path.display(), index + 1))
        })?;
        if item.schema != REVIEW_SCHEMA {
            return Err(SelectionError::Review(format!(
                "{}:{}: schema `{}` is not `{REVIEW_SCHEMA}`",
                path.display(),
                index + 1,
                item.schema
            )));
        }
        if item.version > REVIEW_VERSION {
            return Err(SelectionError::Review(format!(
                "{}:{}: version {} is newer than {REVIEW_VERSION}",
                path.display(),
                index + 1,
                item.version
            )));
        }
        if item.queue_id.trim().is_empty() {
            return Err(SelectionError::Review(format!(
                "{}:{}: item has no queue id",
                path.display(),
                index + 1
            )));
        }
        items.push(item);
    }
    Ok(items)
}

/// Read the disposition sidecar. A missing file is an empty log.
pub fn read_dispositions(path: &Path) -> Result<Vec<ReviewDisposition>, SelectionError> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(source) => {
            return Err(SelectionError::Io {
                path: path.display().to_string(),
                source,
            });
        }
    };
    let mut dispositions = Vec::new();
    for (index, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let disposition: ReviewDisposition = serde_json::from_str(line).map_err(|err| {
            SelectionError::Review(format!("{}:{}: {err}", path.display(), index + 1))
        })?;
        disposition.validate(index + 1)?;
        dispositions.push(disposition);
    }
    Ok(dispositions)
}

/// Append dispositions to the sidecar, creating it when missing.
///
/// Append-only: a review round never rewrites earlier verdicts. The latest entry
/// for a queue id wins when the report is assembled.
pub fn write_dispositions(
    path: &Path,
    dispositions: &[ReviewDisposition],
) -> Result<usize, SelectionError> {
    if dispositions.is_empty() {
        return Ok(0);
    }
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent).map_err(|source| SelectionError::Io {
            path: parent.display().to_string(),
            source,
        })?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|source| SelectionError::Io {
            path: path.display().to_string(),
            source,
        })?;
    for disposition in dispositions {
        let line = serde_json::to_string(disposition)?;
        writeln!(file, "{line}").map_err(|source| SelectionError::Io {
            path: path.display().to_string(),
            source,
        })?;
    }
    Ok(dispositions.len())
}

/// One row of the review report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReviewRow {
    /// Queue id.
    pub queue_id: String,
    /// Decision id.
    pub decision_id: String,
    /// The family it was selected for.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub family: Option<Family>,
    /// Book section, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub book_section: Option<String>,
    /// Label kind.
    pub label_kind: String,
    /// Held-out flag.
    pub held_out: bool,
    /// Latest verdict, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verdict: Option<DispositionVerdict>,
    /// Reviewer note, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// Re-validation warnings for the embedded report.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

/// The result of a review run.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ReviewReport {
    /// `riichiprac.review-report`.
    pub schema: String,
    /// Schema version (1).
    pub version: u32,
    /// When the review ran, `YYYYMMDD-HHMMSS` UTC.
    pub generated_at: String,
    /// Queue path.
    pub queue_path: String,
    /// Disposition path.
    pub dispositions_path: String,
    /// Pack id from the first item.
    pub pack_id: String,
    /// Items in the queue.
    pub items: usize,
    /// Items whose embedded report re-parsed without an error.
    pub valid: usize,
    /// Items whose report failed to parse.
    pub invalid: usize,
    /// Items with no disposition yet.
    pub pending: usize,
    /// Items accepted.
    pub accepted: usize,
    /// Items rejected.
    pub rejected: usize,
    /// Per-item rows, in queue order.
    pub rows: Vec<ReviewRow>,
    /// First invalid-report errors.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<String>,
}

impl ReviewReport {
    /// A multi-line summary for the CLI.
    #[must_use]
    pub fn human_summary(&self, list: bool) -> String {
        let mut out = String::new();
        out.push_str(&format!(
            "mine_replays review: {} item(s) from {}\n",
            self.items, self.queue_path
        ));
        out.push_str(&format!(
            "  valid: {}; invalid: {}; pending: {}; accepted: {}; rejected: {}\n",
            self.valid, self.invalid, self.pending, self.accepted, self.rejected
        ));
        if list {
            for row in &self.rows {
                out.push_str(&format!(
                    "  {:<24} {:<10} {:<8} {}\n",
                    row.queue_id,
                    row.verdict.map_or("pending", |verdict| verdict.as_str()),
                    row.label_kind,
                    row.family
                        .map_or_else(|| "held-out".to_string(), |family| family.to_string())
                ));
            }
        }
        for row in &self.rows {
            for warning in &row.warnings {
                out.push_str(&format!("  warning [{}]: {warning}\n", row.queue_id));
            }
        }
        for error in &self.errors {
            out.push_str(&format!("  error: {error}\n"));
        }
        out
    }
}

/// One review run's inputs.
#[derive(Debug, Clone, Default)]
pub struct ReviewOptions {
    /// Queue file to read.
    pub queue: PathBuf,
    /// Queue ids to accept.
    pub accept: Vec<String>,
    /// Queue ids to reject.
    pub reject: Vec<String>,
    /// Note attached to every new disposition in this run.
    pub note: Option<String>,
    /// Do not write the dispositions (a dry run).
    pub dry_run: bool,
}

/// Read a queue, re-validate its reports, record dispositions and summarise.
pub fn review_queue(options: &ReviewOptions) -> Result<ReviewReport, SelectionError> {
    let queue = read_queue(&options.queue)?;
    let dispositions_path = queue.dispositions_path();
    let previous = read_dispositions(&dispositions_path)?;

    let mut errors = Vec::new();
    let mut valid = 0_usize;
    let mut rows = Vec::with_capacity(queue.items.len());
    for item in &queue.items {
        let json = serde_json::to_string(&item.review)?;
        let warnings = match crate::report::parse_report(&json) {
            Ok(parsed) => {
                valid += 1;
                parsed.warnings
            }
            Err(err) => {
                errors.push(format!("{}: {err}", item.queue_id));
                vec![err]
            }
        };
        rows.push(ReviewRow {
            queue_id: item.queue_id.clone(),
            decision_id: item.decision_id.clone(),
            family: item.family,
            book_section: item.book_section.clone(),
            label_kind: item.label_kind.clone(),
            held_out: item.held_out,
            verdict: None,
            note: None,
            warnings,
        });
    }

    let known: BTreeMap<&str, &ReviewItem> = queue
        .items
        .iter()
        .map(|item| (item.queue_id.as_str(), item))
        .collect();
    let mut latest: BTreeMap<String, ReviewDisposition> = BTreeMap::new();
    for disposition in previous {
        latest.insert(disposition.queue_id.clone(), disposition);
    }

    let mut fresh = Vec::new();
    for id in &options.accept {
        fresh.push(make_disposition(
            &known,
            id,
            DispositionVerdict::Accepted,
            options.note.clone(),
        )?);
    }
    for id in &options.reject {
        fresh.push(make_disposition(
            &known,
            id,
            DispositionVerdict::Rejected,
            options.note.clone(),
        )?);
    }
    for disposition in &fresh {
        latest.insert(disposition.queue_id.clone(), disposition.clone());
    }
    if !options.dry_run {
        write_dispositions(&dispositions_path, &fresh)?;
    }

    for row in &mut rows {
        if let Some(disposition) = latest.get(&row.queue_id) {
            row.verdict = Some(disposition.verdict);
            row.note = disposition.note.clone();
        }
    }
    let accepted = rows
        .iter()
        .filter(|row| row.verdict == Some(DispositionVerdict::Accepted))
        .count();
    let rejected = rows
        .iter()
        .filter(|row| row.verdict == Some(DispositionVerdict::Rejected))
        .count();
    let pending = rows.iter().filter(|row| row.verdict.is_none()).count();
    let pack_id = queue
        .items
        .first()
        .map(|item| item.pack_id.clone())
        .unwrap_or_default();

    Ok(ReviewReport {
        schema: "riichiprac.review-report".to_string(),
        version: 1,
        generated_at: utc_stamp(SystemTime::now()),
        queue_path: queue.path.display().to_string(),
        dispositions_path: dispositions_path.display().to_string(),
        pack_id,
        items: queue.items.len(),
        valid,
        invalid: queue.items.len().saturating_sub(valid),
        pending,
        accepted,
        rejected,
        rows,
        errors,
    })
}

fn make_disposition(
    known: &BTreeMap<&str, &ReviewItem>,
    id: &str,
    verdict: DispositionVerdict,
    note: Option<String>,
) -> Result<ReviewDisposition, SelectionError> {
    let item = known
        .get(id)
        .ok_or_else(|| SelectionError::Review(format!("`{id}` is not in this review queue")))?;
    Ok(ReviewDisposition::new(item, verdict, note))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_malformed_queue_line_is_named_with_its_line_number() {
        let path = Path::new("queue.jsonl");
        let err = parse_queue_lines("{not json}\n", path).expect_err("must reject");
        assert!(format!("{err}").contains("queue.jsonl:1"));
    }

    #[test]
    fn an_unknown_schema_is_rejected() {
        let mut item = crate::miner::select::tests::fixture::review_item_fixture();
        item.schema = "something.else".to_string();
        let line = serde_json::to_string(&item).expect("serialize");
        let err = parse_queue_lines(&line, Path::new("q.jsonl")).expect_err("must reject");
        assert!(format!("{err}").contains("is not"));
    }

    #[test]
    fn an_unknown_disposition_id_is_an_error() {
        let known: BTreeMap<&str, &ReviewItem> = BTreeMap::new();
        let err = make_disposition(&known, "missing", DispositionVerdict::Accepted, None)
            .expect_err("must reject");
        assert!(format!("{err}").contains("not in this review queue"));
    }
}
