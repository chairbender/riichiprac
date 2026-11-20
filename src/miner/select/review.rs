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
//! - [`ReviewFilter`] and [`deterministic_sample`] narrow a 1k–2k queue to the
//!   rows a reviewer is working on and make a spot-check sample reproducible
//!   across the CLI and the browser view (`frontend/tools/review-queue/`).
//! - [`ReviewStatus`] turns "what is left?" into a filter (`--status pending`),
//!   so a session resumes without re-reading what is already dispositioned.
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

use std::collections::{BTreeMap, BTreeSet};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use crate::miner::storage::utc_stamp;
use crate::miner::trigger::families::Family;
use crate::report::ScenarioReport;
use crate::state::CorrectAction;

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

/// Schema name carried by a bulk verdicts document.
pub const REVIEW_VERDICTS_SCHEMA: &str = "riichiprac.review-verdicts";

/// Version of the bulk verdicts schema.
pub const REVIEW_VERDICTS_VERSION: u32 = 1;

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
    /// Event index of the decision inside its replay, for pack provenance.
    #[serde(default)]
    pub event_index: u64,
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
            event_index: u64::try_from(candidate.event_index).unwrap_or(u64::MAX),
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

/// One verdict inside a [`ReviewVerdictFile`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewVerdict {
    /// The queue item this verdict applies to.
    pub queue_id: String,
    /// Accept or reject.
    pub verdict: DispositionVerdict,
    /// Why the verdict was reached (mechanical-review reasons, reviewer note).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// A bulk verdicts document for a large review queue (Q2r2).
///
/// One-at-a-time review does not scale past roughly a thousand candidates, so a
/// mechanical pre-review pass writes every verdict into one file and
/// `mine_replays review --verdicts FILE` applies them in a single run. The
/// document is deliberately the same shape as the review tooling's
/// machine-readable output: a reviewer can inspect, sample or edit it before it
/// becomes the append-only disposition log.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReviewVerdictFile {
    /// [`REVIEW_VERDICTS_SCHEMA`].
    pub schema: String,
    /// [`REVIEW_VERDICTS_VERSION`].
    pub version: u32,
    /// Optional run-wide note applied when a verdict has no reason of its own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// One verdict per queue item.
    pub verdicts: Vec<ReviewVerdict>,
}

/// Read and validate a bulk verdicts document.
pub fn read_verdicts(path: &Path) -> Result<ReviewVerdictFile, SelectionError> {
    let text = std::fs::read_to_string(path).map_err(|source| SelectionError::Io {
        path: path.display().to_string(),
        source,
    })?;
    let document: ReviewVerdictFile = serde_json::from_str(&text).map_err(|source| {
        SelectionError::Review(format!(
            "{}: not a review verdicts document: {source}",
            path.display()
        ))
    })?;
    if document.schema != REVIEW_VERDICTS_SCHEMA {
        return Err(SelectionError::Review(format!(
            "{}: schema `{}` is not `{REVIEW_VERDICTS_SCHEMA}`",
            path.display(),
            document.schema
        )));
    }
    if document.version > REVIEW_VERDICTS_VERSION {
        return Err(SelectionError::Review(format!(
            "{}: version {} is newer than {REVIEW_VERDICTS_VERSION}",
            path.display(),
            document.version
        )));
    }
    let mut seen = std::collections::BTreeSet::new();
    for verdict in &document.verdicts {
        if !seen.insert(verdict.queue_id.as_str()) {
            return Err(SelectionError::Review(format!(
                "{}: `{}` appears more than once",
                path.display(),
                verdict.queue_id
            )));
        }
    }
    Ok(document)
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

/// The disposition state of one queue item, used as a review filter (Q2r2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReviewStatus {
    /// No disposition recorded yet.
    Pending,
    /// Latest disposition accepts it.
    Accepted,
    /// Latest disposition rejects it.
    Rejected,
}

impl ReviewStatus {
    /// The CLI/JSON spelling.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Accepted => "accepted",
            Self::Rejected => "rejected",
        }
    }

    /// Parse the CLI spelling.
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "pending" => Some(Self::Pending),
            "accepted" => Some(Self::Accepted),
            "rejected" => Some(Self::Rejected),
            _ => None,
        }
    }

    /// The status a latest disposition implies.
    #[must_use]
    pub const fn of(verdict: Option<DispositionVerdict>) -> Self {
        match verdict {
            None => Self::Pending,
            Some(DispositionVerdict::Accepted) => Self::Accepted,
            Some(DispositionVerdict::Rejected) => Self::Rejected,
        }
    }
}

/// Narrow a large queue to the rows a reviewer wants to see (Q2r2).
///
/// Empty vectors mean "do not filter on this field". Every populated field must
/// match, so filters compose as AND. Sections match a prefix (`ch8` includes
/// `ch8.2`), turns match either a bucket name (`early`) or an exact table-turn
/// number (`7`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReviewFilter {
    /// Book lesson ids (exact).
    pub lessons: Vec<String>,
    /// Book sections, matched as a dotted prefix.
    pub sections: Vec<String>,
    /// Source replay families (exact).
    pub families: Vec<String>,
    /// Turn buckets or exact table turns.
    pub turns: Vec<String>,
    /// Disposition states.
    pub statuses: Vec<ReviewStatus>,
}

impl ReviewFilter {
    /// True when no field narrows the queue.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.lessons.is_empty()
            && self.sections.is_empty()
            && self.families.is_empty()
            && self.turns.is_empty()
            && self.statuses.is_empty()
    }

    /// Match one queue item with its latest disposition state.
    #[must_use]
    pub fn matches(&self, item: &ReviewItem, status: ReviewStatus) -> bool {
        if !self.lessons.is_empty()
            && !self
                .lessons
                .iter()
                .any(|lesson| item.lesson.as_deref() == Some(lesson.as_str()))
        {
            return false;
        }
        if !self.sections.is_empty() {
            let section = item.book_section.as_deref().unwrap_or_default();
            let hit = self.sections.iter().any(|wanted| {
                section == wanted
                    || section
                        .strip_prefix(wanted.as_str())
                        .is_some_and(|rest| rest.starts_with('.'))
            });
            if !hit {
                return false;
            }
        }
        if !self.families.is_empty() && !self.families.contains(&item.replay_family) {
            return false;
        }
        if !self.turns.is_empty() {
            let hit = self.turns.iter().any(|wanted| {
                item.turn_bucket == *wanted
                    || wanted.parse::<usize>().is_ok_and(|turn| turn == item.turn)
            });
            if !hit {
                return false;
            }
        }
        self.statuses.is_empty() || self.statuses.contains(&status)
    }
}

/// Deterministic sample order for a review session.
///
/// Every candidate is ranked by FNV-1a 64 over `seed\0queue_id` (ties broken by
/// queue id), the first `count` are taken, and the result is returned in queue
/// order so a batch pass still walks the file the way `select` wrote it. The
/// same seed and queue therefore draw the same sample in the CLI and the browser
/// view, and re-running a session is reproducible.
#[must_use]
pub fn deterministic_sample(items: &[ReviewItem], count: usize, seed: &str) -> Vec<usize> {
    let all: Vec<usize> = (0..items.len()).collect();
    sample_filtered(items, &all, count, seed)
}

/// Sample `count` of `candidates` (queue indices) by the deterministic order.
fn sample_filtered(
    items: &[ReviewItem],
    candidates: &[usize],
    count: usize,
    seed: &str,
) -> Vec<usize> {
    if count >= candidates.len() {
        return candidates.to_vec();
    }
    let mut ranked: Vec<(u64, &str, usize)> = candidates
        .iter()
        .map(|&index| {
            let item = &items[index];
            (
                sample_key(seed, &item.queue_id),
                item.queue_id.as_str(),
                index,
            )
        })
        .collect();
    ranked.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(b.1)));
    let mut chosen: Vec<usize> = ranked.into_iter().take(count).map(|row| row.2).collect();
    chosen.sort_unstable();
    chosen
}

fn fnv1a64(seed: &str, queue_id: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in seed
        .bytes()
        .chain(std::iter::once(0))
        .chain(queue_id.bytes())
    {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// The sample order key: FNV-1a 64 over `seed\0queue_id`, then the SplitMix64
/// finalizer. FNV alone keeps sequential ids (`-001`, `-002`, ...) in order,
/// which would turn a "sample" into "the first N"; the finalizer scatters them.
/// The browser view implements this same rule in `review-core.mjs`.
fn sample_key(seed: &str, queue_id: &str) -> u64 {
    let mut hash = fnv1a64(seed, queue_id);
    hash = (hash ^ (hash >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    hash = (hash ^ (hash >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    hash ^ (hash >> 31)
}

fn correct_action_text(action: &CorrectAction) -> String {
    match action {
        CorrectAction::Riichi { discard } => format!("riichi {discard}"),
        CorrectAction::Dama { discard } => format!("dama {discard}"),
        CorrectAction::Fold { discard } => format!("fold {discard}"),
        CorrectAction::Kan { tile } => format!("kan {tile}"),
        CorrectAction::Discard { tile } => format!("discard {tile}"),
        CorrectAction::Pass => "pass".to_string(),
        CorrectAction::Best { label, .. } => format!("best {label}"),
    }
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
    /// Book lesson, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lesson: Option<String>,
    /// Book section, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub book_section: Option<String>,
    /// Source replay family.
    pub replay_family: String,
    /// Decision kind (`self_turn`, `call`, ...).
    pub decision_kind: String,
    /// Table turn.
    pub turn: usize,
    /// Turn bucket (`early`, `mid`, `late`).
    pub turn_bucket: String,
    /// Label kind.
    pub label_kind: String,
    /// Held-out flag.
    pub held_out: bool,
    /// The answer-free selection reason recorded by `select`.
    pub selection_reason: String,
    /// The hand the human holds, from the embedded report.
    pub hand: String,
    /// The graded answer, from the embedded report's table.
    pub answer: String,
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
    /// Items matching the run's filter (the whole queue when unfiltered).
    pub filtered: usize,
    /// Requested sample size, when the run sampled.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sampled: Option<usize>,
    /// Rows returned after filtering, sampling and `--limit`.
    pub shown: usize,
    /// Per-item rows for the shown selection, in queue order.
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
        let done = self.accepted + self.rejected;
        let percent = if self.items == 0 {
            0.0
        } else {
            100.0 * done as f64 / self.items as f64
        };
        out.push_str(&format!(
            "  progress: {done}/{} dispositioned ({percent:.1}%); shown: {} of {} filtered\n",
            self.items, self.shown, self.filtered
        ));
        if let Some(sampled) = self.sampled {
            out.push_str(&format!(
                "  sampled: up to {sampled} of {}\n",
                self.filtered
            ));
        }
        if list {
            for row in &self.rows {
                out.push_str(&format!(
                    "  {:<28} {:<9} {:<24} {:<6} {:<7} `{:<14}` {:<16} {}\n",
                    row.queue_id,
                    row.verdict.map_or("pending", |verdict| verdict.as_str()),
                    row.lesson.as_deref().unwrap_or("-"),
                    row.book_section.as_deref().unwrap_or("-"),
                    row.turn_bucket,
                    row.hand,
                    row.answer,
                    row.replay_family
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
    /// Bulk verdicts document to apply (Q2r2).
    pub verdicts: Option<PathBuf>,
    /// Note attached to every new disposition in this run.
    pub note: Option<String>,
    /// Do not write the dispositions (a dry run).
    pub dry_run: bool,
    /// Narrow the listing (and the bulk scope) by lesson/section/source/turn/status.
    pub filter: ReviewFilter,
    /// Draw a deterministic sample of this many filtered items.
    pub sample: Option<usize>,
    /// Sample seed (shared by the CLI and the browser view).
    pub seed: String,
    /// Show at most this many rows after filtering and sampling.
    pub limit: Option<usize>,
    /// Apply this verdict to every shown row (a scoped bulk disposition).
    pub bulk_verdict: Option<DispositionVerdict>,
    /// Write the shown selection as a `riichiprac.review-verdicts` document.
    pub verdicts_out: Option<PathBuf>,
}

impl ReviewOptions {
    /// A run's default sample seed.
    pub const DEFAULT_SEED: &'static str = "q2r2";
}

/// Read a queue, re-validate its reports, record dispositions and summarise.
pub fn review_queue(options: &ReviewOptions) -> Result<ReviewReport, SelectionError> {
    if options.bulk_verdict.is_some() {
        if options
            .note
            .as_deref()
            .is_none_or(|note| note.trim().is_empty())
        {
            return Err(SelectionError::Review(
                "a bulk verdict needs a --note saying what was judged".to_string(),
            ));
        }
        if options.filter.is_empty() {
            return Err(SelectionError::Review(
                "a bulk verdict needs at least one filter (--lesson/--section/--family/\
                 --turn/--status); use --verdicts for a whole-queue pass"
                    .to_string(),
            ));
        }
    }
    if options.verdicts_out.is_some() && options.bulk_verdict.is_none() {
        return Err(SelectionError::Review(
            "--verdicts-out needs --bulk-verdict".to_string(),
        ));
    }
    let queue = read_queue(&options.queue)?;
    let dispositions_path = queue.dispositions_path();
    let previous = read_dispositions(&dispositions_path)?;

    let mut latest: BTreeMap<String, ReviewDisposition> = BTreeMap::new();
    for disposition in previous {
        latest.insert(disposition.queue_id.clone(), disposition);
    }

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
        let (hand, answer) = (
            item.review.table.hand_string.clone(),
            correct_action_text(&item.review.table.correct_action),
        );
        let status = ReviewStatus::of(latest.get(&item.queue_id).map(|entry| entry.verdict));
        let shown = options.filter.matches(item, status);
        rows.push((
            shown,
            ReviewRow {
                queue_id: item.queue_id.clone(),
                decision_id: item.decision_id.clone(),
                family: item.family,
                lesson: item.lesson.clone(),
                book_section: item.book_section.clone(),
                replay_family: item.replay_family.clone(),
                decision_kind: item.decision_kind.clone(),
                turn: item.turn,
                turn_bucket: item.turn_bucket.clone(),
                label_kind: item.label_kind.clone(),
                held_out: item.held_out,
                selection_reason: item.selection_reason.clone(),
                hand,
                answer,
                verdict: None,
                note: None,
                warnings,
            },
        ));
    }
    let filtered_rows: Vec<&ReviewRow> = rows
        .iter()
        .filter(|(shown, _)| *shown)
        .map(|(_, row)| row)
        .collect();
    let filtered = filtered_rows.len();
    let filtered_indices: Vec<usize> = rows
        .iter()
        .enumerate()
        .filter(|(_, (shown, _))| *shown)
        .map(|(index, _)| index)
        .collect();

    // The shown selection is queue order -> optional deterministic sample ->
    // optional display cap. A bulk verdict applies to exactly this selection.
    let mut shown_indices = filtered_indices.clone();
    if let Some(count) = options.sample {
        let seed = if options.seed.is_empty() {
            ReviewOptions::DEFAULT_SEED
        } else {
            options.seed.as_str()
        };
        shown_indices = sample_filtered(&queue.items, &filtered_indices, count, seed);
    }
    if let Some(limit) = options.limit {
        shown_indices.truncate(limit);
    }
    let shown_ids: Vec<String> = shown_indices
        .iter()
        .map(|index| rows[*index].1.queue_id.clone())
        .collect();
    let shown = shown_ids.len();
    let shown_set: BTreeSet<String> = shown_ids.iter().cloned().collect();

    let known: BTreeMap<&str, &ReviewItem> = queue
        .items
        .iter()
        .map(|item| (item.queue_id.as_str(), item))
        .collect();

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
    if let Some(path) = &options.verdicts {
        let document = read_verdicts(path)?;
        for verdict in &document.verdicts {
            let note = verdict
                .reason
                .clone()
                .or_else(|| document.note.clone())
                .or_else(|| options.note.clone());
            fresh.push(make_disposition(
                &known,
                &verdict.queue_id,
                verdict.verdict,
                note,
            )?);
        }
    }
    if let Some(verdict) = options.bulk_verdict {
        for id in &shown_ids {
            fresh.push(make_disposition(
                &known,
                id.as_str(),
                verdict,
                options.note.clone(),
            )?);
        }
    }
    if let Some(path) = &options.verdicts_out {
        let verdict = options
            .bulk_verdict
            .expect("validated: --verdicts-out needs --bulk-verdict");
        let document = ReviewVerdictFile {
            schema: REVIEW_VERDICTS_SCHEMA.to_string(),
            version: REVIEW_VERDICTS_VERSION,
            note: options.note.clone(),
            verdicts: shown_ids
                .iter()
                .map(|id| ReviewVerdict {
                    queue_id: id.clone(),
                    verdict,
                    reason: None,
                })
                .collect(),
        };
        let text = serde_json::to_string_pretty(&document)?;
        std::fs::write(path, format!("{text}\n")).map_err(|source| SelectionError::Io {
            path: path.display().to_string(),
            source,
        })?;
    }
    for disposition in &fresh {
        latest.insert(disposition.queue_id.clone(), disposition.clone());
    }
    if !options.dry_run {
        write_dispositions(&dispositions_path, &fresh)?;
    }

    let mut selected = Vec::with_capacity(shown);
    for (_, row) in rows {
        if !shown_set.contains(row.queue_id.as_str()) {
            continue;
        }
        let mut row = row;
        if let Some(disposition) = latest.get(&row.queue_id) {
            row.verdict = Some(disposition.verdict);
            row.note = disposition.note.clone();
        }
        selected.push(row);
    }
    let accepted = queue
        .items
        .iter()
        .filter(|item| {
            latest
                .get(&item.queue_id)
                .is_some_and(|entry| entry.verdict == DispositionVerdict::Accepted)
        })
        .count();
    let rejected = queue
        .items
        .iter()
        .filter(|item| {
            latest
                .get(&item.queue_id)
                .is_some_and(|entry| entry.verdict == DispositionVerdict::Rejected)
        })
        .count();
    let pending = queue.items.len().saturating_sub(accepted + rejected);
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
        filtered,
        sampled: options.sample.filter(|count| *count < filtered),
        shown,
        rows: selected,
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

    #[test]
    fn a_bulk_verdict_file_applies_every_verdict_in_one_run() {
        let temp = tempfile::tempdir().expect("tempdir");
        let queue_path = temp.path().join("review-queue.jsonl");
        let mut first = crate::miner::select::tests::fixture::review_item_fixture();
        let mut second = first.clone();
        second.queue_id = "s2-fixture-002".to_string();
        first.queue_id = "s2-fixture-001".to_string();
        let lines = format!(
            "{}\n{}\n",
            serde_json::to_string(&first).expect("first"),
            serde_json::to_string(&second).expect("second")
        );
        std::fs::write(&queue_path, lines).expect("queue");

        let verdicts_path = temp.path().join("verdicts.json");
        let document = ReviewVerdictFile {
            schema: REVIEW_VERDICTS_SCHEMA.to_string(),
            version: REVIEW_VERDICTS_VERSION,
            note: Some("mechanical review".to_string()),
            verdicts: vec![
                ReviewVerdict {
                    queue_id: first.queue_id.clone(),
                    verdict: DispositionVerdict::Accepted,
                    reason: None,
                },
                ReviewVerdict {
                    queue_id: second.queue_id.clone(),
                    verdict: DispositionVerdict::Rejected,
                    reason: Some("duplicate_visible".to_string()),
                },
            ],
        };
        std::fs::write(
            &verdicts_path,
            serde_json::to_string_pretty(&document).expect("json"),
        )
        .expect("verdicts");

        let read = read_verdicts(&verdicts_path).expect("verdicts parse");
        assert_eq!(read.verdicts.len(), 2);

        let report = review_queue(&ReviewOptions {
            queue: queue_path,
            accept: Vec::new(),
            reject: Vec::new(),
            verdicts: Some(verdicts_path),
            note: None,
            dry_run: false,
            ..ReviewOptions::default()
        })
        .expect("bulk review");
        assert_eq!(report.items, 2);
        assert_eq!(report.accepted, 1);
        assert_eq!(report.rejected, 1);
        assert_eq!(report.pending, 0);

        let dispositions =
            read_dispositions(&temp.path().join("dispositions.jsonl")).expect("dispositions");
        assert_eq!(dispositions.len(), 2);
        assert_eq!(dispositions[0].note.as_deref(), Some("mechanical review"));
        assert_eq!(dispositions[1].note.as_deref(), Some("duplicate_visible"));
    }

    #[test]
    fn a_verdicts_document_rejects_an_unknown_item_and_a_repeat() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("verdicts.json");
        let write = |verdicts: Vec<ReviewVerdict>| {
            let document = ReviewVerdictFile {
                schema: REVIEW_VERDICTS_SCHEMA.to_string(),
                version: REVIEW_VERDICTS_VERSION,
                note: None,
                verdicts,
            };
            std::fs::write(&path, serde_json::to_string(&document).expect("json")).expect("write");
        };
        write(vec![
            ReviewVerdict {
                queue_id: "s2-fixture-001".to_string(),
                verdict: DispositionVerdict::Accepted,
                reason: None,
            },
            ReviewVerdict {
                queue_id: "s2-fixture-001".to_string(),
                verdict: DispositionVerdict::Rejected,
                reason: None,
            },
        ]);
        let err = read_verdicts(&path).expect_err("a repeat must be rejected");
        assert!(format!("{err}").contains("more than once"));

        let known: BTreeMap<&str, &ReviewItem> = BTreeMap::new();
        let err = make_disposition(&known, "missing", DispositionVerdict::Accepted, None)
            .expect_err("an unknown id must be rejected");
        assert!(format!("{err}").contains("not in this review queue"));
    }

    /// Three queue items with distinct lesson/section/source/turn fields.
    fn filter_fixture() -> Vec<ReviewItem> {
        let mut base = crate::miner::select::tests::fixture::review_item_fixture();
        base.queue_id = "q-001".to_string();
        base.lesson = Some("fold_to_riichi".to_string());
        base.book_section = Some("ch8.2".to_string());
        base.replay_family = "mortal_mirror".to_string();
        base.turn = 3;
        base.turn_bucket = "early".to_string();

        let mut second = base.clone();
        second.queue_id = "q-002".to_string();
        second.lesson = Some("kabe_one_chance".to_string());
        second.book_section = Some("ch8.3".to_string());
        second.replay_family = "akochan_tactics".to_string();
        second.turn = 9;
        second.turn_bucket = "mid".to_string();

        let mut third = base.clone();
        third.queue_id = "q-003".to_string();
        third.lesson = Some("fold_to_riichi".to_string());
        third.book_section = Some("ch8.1".to_string());
        third.replay_family = "heterogeneous_table".to_string();
        third.turn = 15;
        third.turn_bucket = "late".to_string();
        vec![base, second, third]
    }

    #[test]
    fn a_filter_narrows_by_lesson_section_source_turn_and_status() {
        let items = filter_fixture();
        let none = ReviewStatus::Pending;
        let matches = |filter: &ReviewFilter| -> Vec<&str> {
            items
                .iter()
                .filter(|item| filter.matches(item, none))
                .map(|item| item.queue_id.as_str())
                .collect()
        };

        let mut filter = ReviewFilter {
            lessons: vec!["fold_to_riichi".to_string()],
            ..ReviewFilter::default()
        };
        assert_eq!(matches(&filter), vec!["q-001", "q-003"]);

        filter.lessons.clear();
        filter.sections = vec!["ch8".to_string()];
        assert_eq!(matches(&filter), vec!["q-001", "q-002", "q-003"]);
        filter.sections = vec!["ch8.3".to_string()];
        assert_eq!(matches(&filter), vec!["q-002"]);
        filter.sections = vec!["ch8.30".to_string()];
        assert!(matches(&filter).is_empty(), "a prefix must stop at a dot");

        filter.sections.clear();
        filter.families = vec!["akochan_tactics".to_string()];
        assert_eq!(matches(&filter), vec!["q-002"]);

        filter.families.clear();
        filter.turns = vec!["late".to_string()];
        assert_eq!(matches(&filter), vec!["q-003"]);
        filter.turns = vec!["9".to_string()];
        assert_eq!(matches(&filter), vec!["q-002"]);

        filter.turns.clear();
        filter.statuses = vec![ReviewStatus::Accepted];
        assert!(matches(&filter).is_empty());
        assert_eq!(
            ReviewStatus::of(Some(DispositionVerdict::Accepted)),
            ReviewStatus::Accepted
        );
        assert_eq!(
            ReviewStatus::of(Some(DispositionVerdict::Rejected)),
            ReviewStatus::Rejected
        );
        assert_eq!(ReviewStatus::of(None), ReviewStatus::Pending);
        assert!(ReviewFilter::default().is_empty());
    }

    #[test]
    fn a_sample_is_deterministic_and_stays_inside_the_filter() {
        let items = filter_fixture();
        let first = deterministic_sample(&items, 2, "q2r2-test");
        let again = deterministic_sample(&items, 2, "q2r2-test");
        assert_eq!(first, again, "the same seed draws the same sample");
        assert_eq!(first.len(), 2);
        assert!(
            first.windows(2).all(|pair| pair[0] < pair[1]),
            "queue order"
        );

        let other = deterministic_sample(&items, 2, "a-different-seed");
        assert_eq!(other.len(), 2);
        // Different seeds are allowed to collide on a 3-item pool; the ordering
        // rule itself is pinned by `same_orders_the_whole_pool_stably`.
        assert!(other.iter().all(|index| *index < items.len()));

        assert_eq!(
            deterministic_sample(&items, 0, "q2r2-test"),
            Vec::<usize>::new(),
            "a zero sample shows nothing"
        );
        assert_eq!(
            deterministic_sample(&items, 99, "q2r2-test"),
            vec![0, 1, 2],
            "a sample larger than the pool keeps queue order"
        );
    }

    #[test]
    fn a_sample_order_is_pinned_so_the_cli_and_the_browser_agree() {
        // The browser view implements the same FNV-1a 64 + SplitMix64 rule; change
        // both together or a session's sample is no longer reproducible.
        assert_eq!(sample_key("q2r2", "q-001"), 548_070_798_376_218_475);
        assert_eq!(sample_key("q2r2", "q-002"), 6_933_946_166_570_799_882);
        let items = filter_fixture();
        let ranked = deterministic_sample(&items, 2, "q2r2");
        assert_eq!(ranked, vec![0, 1]);
    }

    #[test]
    fn a_bulk_verdict_needs_a_note_and_a_filter_and_records_the_shown_rows() {
        let temp = tempfile::tempdir().expect("tempdir");
        let items = filter_fixture();
        let queue_path = temp.path().join("review-queue.jsonl");
        let lines: String = items
            .iter()
            .map(|item| serde_json::to_string(item).expect("json") + "\n")
            .collect();
        std::fs::write(&queue_path, lines).expect("queue");

        let err = review_queue(&ReviewOptions {
            queue: queue_path.clone(),
            bulk_verdict: Some(DispositionVerdict::Accepted),
            filter: ReviewFilter {
                lessons: vec!["fold_to_riichi".to_string()],
                ..ReviewFilter::default()
            },
            ..ReviewOptions::default()
        })
        .expect_err("a bulk verdict without a note must be refused");
        assert!(format!("{err}").contains("--note"));

        let err = review_queue(&ReviewOptions {
            queue: queue_path.clone(),
            bulk_verdict: Some(DispositionVerdict::Accepted),
            note: Some("checked".to_string()),
            ..ReviewOptions::default()
        })
        .expect_err("a bulk verdict over the whole queue must be refused");
        assert!(format!("{err}").contains("at least one filter"));

        let report = review_queue(&ReviewOptions {
            queue: queue_path.clone(),
            bulk_verdict: Some(DispositionVerdict::Rejected),
            note: Some("checked".to_string()),
            filter: ReviewFilter {
                lessons: vec!["fold_to_riichi".to_string()],
                ..ReviewFilter::default()
            },
            dry_run: false,
            ..ReviewOptions::default()
        })
        .expect("scoped bulk verdict");
        assert_eq!(report.items, 3);
        assert_eq!(report.filtered, 2);
        assert_eq!(report.shown, 2);
        assert_eq!(report.rejected, 2);
        assert_eq!(report.pending, 1);
        assert_eq!(
            report
                .rows
                .iter()
                .map(|row| row.queue_id.as_str())
                .collect::<Vec<_>>(),
            vec!["q-001", "q-003"]
        );
        assert_eq!(report.rows[0].note.as_deref(), Some("checked"));
        assert_eq!(report.rows[0].lesson.as_deref(), Some("fold_to_riichi"));
        assert_eq!(report.rows[0].turn, 3);
        assert_eq!(report.rows[0].turn_bucket, "early");

        let dispositions =
            read_dispositions(&temp.path().join("dispositions.jsonl")).expect("dispositions");
        assert_eq!(dispositions.len(), 2);
        assert!(
            dispositions
                .iter()
                .all(|entry| entry.verdict == DispositionVerdict::Rejected)
        );
    }

    #[test]
    fn a_status_filter_resumes_a_session_after_the_latest_disposition_wins() {
        let temp = tempfile::tempdir().expect("tempdir");
        let items = filter_fixture();
        let queue_path = temp.path().join("review-queue.jsonl");
        let lines: String = items
            .iter()
            .map(|item| serde_json::to_string(item).expect("json") + "\n")
            .collect();
        std::fs::write(&queue_path, lines).expect("queue");
        review_queue(&ReviewOptions {
            queue: queue_path.clone(),
            accept: vec!["q-001".to_string()],
            note: Some("good".to_string()),
            ..ReviewOptions::default()
        })
        .expect("accept one");

        let pending = review_queue(&ReviewOptions {
            queue: queue_path.clone(),
            filter: ReviewFilter {
                statuses: vec![ReviewStatus::Pending],
                ..ReviewFilter::default()
            },
            ..ReviewOptions::default()
        })
        .expect("resume");
        assert_eq!(pending.pending, 2);
        assert_eq!(
            pending
                .rows
                .iter()
                .map(|row| row.queue_id.as_str())
                .collect::<Vec<_>>(),
            vec!["q-002", "q-003"]
        );

        review_queue(&ReviewOptions {
            queue: queue_path.clone(),
            reject: vec!["q-001".to_string()],
            note: Some("actually ambiguous".to_string()),
            ..ReviewOptions::default()
        })
        .expect("override");

        let accepted = review_queue(&ReviewOptions {
            queue: queue_path,
            filter: ReviewFilter {
                statuses: vec![ReviewStatus::Accepted],
                ..ReviewFilter::default()
            },
            ..ReviewOptions::default()
        })
        .expect("latest wins");
        assert_eq!(accepted.accepted, 0);
        assert_eq!(accepted.rejected, 1);
        assert!(
            accepted.rows.is_empty(),
            "the override moved it out of accepted"
        );
    }

    #[test]
    fn a_dry_run_writes_the_verdicts_document_but_no_dispositions() {
        let temp = tempfile::tempdir().expect("tempdir");
        let items = filter_fixture();
        let queue_path = temp.path().join("review-queue.jsonl");
        let lines: String = items
            .iter()
            .map(|item| serde_json::to_string(item).expect("json") + "\n")
            .collect();
        std::fs::write(&queue_path, lines).expect("queue");
        let verdicts_out = temp.path().join("verdicts.json");

        let report = review_queue(&ReviewOptions {
            queue: queue_path,
            bulk_verdict: Some(DispositionVerdict::Accepted),
            note: Some("sample inspected".to_string()),
            filter: ReviewFilter {
                sections: vec!["ch8.2".to_string()],
                ..ReviewFilter::default()
            },
            sample: Some(5),
            limit: Some(1),
            verdicts_out: Some(verdicts_out.clone()),
            dry_run: true,
            ..ReviewOptions::default()
        })
        .expect("dry bulk run");
        assert_eq!(report.filtered, 1);
        assert_eq!(report.shown, 1);
        assert!(
            !temp.path().join("dispositions.jsonl").exists(),
            "a dry run must not append dispositions"
        );
        let document = read_verdicts(&verdicts_out).expect("verdicts document");
        assert_eq!(document.verdicts.len(), 1);
        assert_eq!(document.verdicts[0].queue_id, "q-001");
        assert_eq!(document.note.as_deref(), Some("sample inspected"));
    }
}
