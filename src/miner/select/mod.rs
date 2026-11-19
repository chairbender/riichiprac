//! Selection: hard gates, ranking, family quotas, dedupe and the review queue
//! (implementation unit S2).
//!
//! S1 answered "is this decision worth inspecting?". S2 answers the next
//! question: **which candidates form a balanced, legal, non-duplicated pack?**
//! It implements replay-strategy §6.6 (selection is a quota problem, not a
//! single sort), §7.1 (hard gates), §7.2 (ranking signals and the composite
//! score) and §7.5's curation workflow.
//!
//! ```text
//! decisions ──► gates 1–6, 8 ──► valid candidates ──► held-out QA split
//!                                              │
//!                                              ├─► novelty + composite score
//!                                              └─► family buckets
//!                                                     │
//!                              family quotas + section / kind / turn caps
//!                                                     │
//!                                              gate 7 (dedupe) during fill
//!                                                     ▼
//!                                        review-queue.jsonl (selected + held-out)
//! ```
//!
//! # What this module does not do
//!
//! - It does not assemble or publish a pack. P1a/P1b own the pack schema, the
//!   audit and the ship gate. The funnel's `packed` row stays `0` here.
//! - It does not transform states. V1/V2 own permutation; [`dedupe`] hashes
//!   literal tiles so a transformed variant is not mistaken for its base.
//! - It does not decide whether a scenario *teaches*. The composite ranks; the
//!   review queue and a human decide (§7.5, AGENTS.md §6).
//! - It never writes into an existing `decisions` row. Extraction owns that
//!   row; like S1, a run over an un-extracted corpus still reports and writes
//!   its queue.
//!
//! # The two passes over a shard
//!
//! Gate 5 and the percentile signals are measured inside a decision family, so
//! they need the shard's own label sample before a candidate can be scored. The
//! runner therefore walks the shard twice:
//!
//! 1. collect each labelled decision's top-two, safe and played-action gaps;
//! 2. evaluate the triggers with those cuts, then gate and score every decision.
//!
//! Candidates are kept **without** their `GameState`: a compact candidate is
//! metadata plus signals, and the third pass re-walks only the replays that hold
//! a selected or held-out decision to build its review report. This keeps memory
//! proportional to the candidate metadata, not to a whole 1k-game corpus of
//! table states.
//!
//! # Review queue
//!
//! Every selected and held-out candidate becomes one JSONL line in
//! [`review::ReviewItem`]. The line embeds a complete
//! [`crate::report::ScenarioReport`] for that single candidate — the app's own
//! versioned report format — so `mine_replays review --show <id>` prints exactly
//! the document the existing report importer understands.

pub mod dedupe;
pub mod gate;
pub mod quota;
pub mod report;
pub mod review;
pub mod run;
pub mod score;

#[cfg(test)]
mod tests;

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::miner::label::thresholds::{PercentileConfig, ThresholdError, TurnBucket, table_turn};
use crate::miner::label::{LabelKind, ModelLabel};
use crate::miner::trigger::families::Family;
use crate::miner::trigger::{TriggerConfig, TriggerReport, played_gap};
use crate::replay::walk::{DecisionKind, DecisionSnapshot, WalkError};
use crate::state::{CorrectAction, GameState, TargetAction};

pub use dedupe::{
    DedupeSet, VISIBLE_FINGERPRINT_VERSION, exact_state_hash, visible_info_fingerprint,
};
pub use gate::{GateFailure, GateInput, GateKind, check_answer_legal, contains_token, evaluate};
pub use quota::{QuotaCaps, QuotaConfig};
pub use report::{DedupeStats, GateStats, HeldOutStats, SelectionReport};
pub use review::{
    DISPOSITION_SCHEMA, DispositionVerdict, REVIEW_SCHEMA, REVIEW_VERSION, ReviewDisposition,
    ReviewItem, ReviewOptions, ReviewQueue, ReviewReport, read_dispositions, read_queue,
    review_queue, write_dispositions,
};
pub use run::{
    SelectionOptions, SelectionOutcome, SelectionPaths, latest_pack, run_selection, selection_paths,
};
pub use score::{SampleCuts, SampleSummary, ScoreWeights, Signals};

/// Schema name carried by a serialised selection report.
pub const SELECTION_SCHEMA: &str = "riichiprac.selection-report";

/// Version of the selection report schema.
pub const SELECTION_VERSION: u32 = 1;

/// Default pack size for the S2 smoke pack.
pub const DEFAULT_PACK_SIZE: usize = 100;

/// Default share of the pack kept out for held-out QA.
pub const DEFAULT_HELD_OUT_SHARE: f32 = 0.10;

/// Default salt for the deterministic held-out split.
pub const DEFAULT_HELD_OUT_SALT: &str = "s2";

/// One selection run's configuration.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SelectionConfig {
    /// Pack id; also the review directory name.
    pub pack_id: String,
    /// How many scenarios the pack should contain.
    pub pack_size: usize,
    /// Per-family shares and the diversity caps.
    #[serde(default)]
    pub quotas: QuotaConfig,
    /// The §7.2 composite weights.
    #[serde(default)]
    pub weights: ScoreWeights,
    /// Per-family percentile configuration for the confidence cuts.
    #[serde(default)]
    pub percentiles: PercentileConfig,
    /// Mortal-only fallback: minimum top-1 probability when the family has no
    /// percentile cut yet.
    #[serde(default = "default_min_top_probability")]
    pub min_top_probability: f32,
    /// Mortal-only fallback: minimum top-two probability margin.
    #[serde(default)]
    pub min_probability_margin: f32,
    /// Share of the pack size kept out for QA (`0.0` disables).
    #[serde(default = "default_held_out_share")]
    pub held_out_share: f32,
    /// Salt for the deterministic held-out split. Changing it changes the split,
    /// so a QA set can be reproduced or re-drawn deliberately.
    #[serde(default = "default_held_out_salt")]
    pub held_out_salt: String,
    /// Cheap-trigger thresholds (S1) used to annotate candidates.
    #[serde(default)]
    pub trigger: TriggerConfig,
    /// Only candidates whose book section starts with one of these prefixes
    /// (`ch8` or `ch8.2`). Empty means every section, including Mortal-only
    /// candidates with no book section.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub book_prefixes: Vec<String>,
    /// Only candidates with one of these exact book lessons. Empty means every
    /// lesson.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub lessons: Vec<String>,
    /// Only candidates from these corpus (replay) families. Empty means every
    /// family.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub replay_families: Vec<String>,
    /// Maximum selected bases per corpus family. A family not listed is
    /// uncapped. The cap is enforced during both the quota fill and the relaxed
    /// fill, so one corpus family cannot dominate a lesson-scoped pack.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub replay_family_caps: BTreeMap<String, usize>,
    /// Maximum selected bases from one source replay. `None` is uncapped. This
    /// keeps several adjacent turns of one game from looking like repeats.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_per_replay: Option<usize>,
    /// Keep only stable book labels; a contested (book vs Mortal disagreement)
    /// label is rejected. A first curated pack uses this so every shipped
    /// scenario has one unambiguous book answer.
    #[serde(default, skip_serializing_if = "is_false")]
    pub stable_book_only: bool,
}

const fn is_false(value: &bool) -> bool {
    !*value
}

const fn default_min_top_probability() -> f32 {
    0.5
}

const fn default_held_out_share() -> f32 {
    DEFAULT_HELD_OUT_SHARE
}

fn default_held_out_salt() -> String {
    DEFAULT_HELD_OUT_SALT.to_string()
}

impl Default for SelectionConfig {
    fn default() -> Self {
        Self {
            pack_id: String::new(),
            pack_size: DEFAULT_PACK_SIZE,
            quotas: QuotaConfig::default(),
            weights: ScoreWeights::default(),
            percentiles: PercentileConfig::default(),
            min_top_probability: default_min_top_probability(),
            min_probability_margin: 0.0,
            held_out_share: default_held_out_share(),
            held_out_salt: default_held_out_salt(),
            trigger: TriggerConfig::default(),
            book_prefixes: Vec::new(),
            lessons: Vec::new(),
            replay_families: Vec::new(),
            replay_family_caps: BTreeMap::new(),
            max_per_replay: None,
            stable_book_only: false,
        }
    }
}

impl SelectionConfig {
    /// Reject a configuration that cannot describe a pack.
    pub fn validate(&self) -> Result<(), String> {
        if self.pack_id.is_empty() || self.pack_id.len() > 64 {
            return Err("`pack_id` must be 1..=64 characters".to_string());
        }
        if !self
            .pack_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
            || self.pack_id == "."
            || self.pack_id == ".."
        {
            return Err(format!(
                "`pack_id` `{}` must be a path-safe name (letters, digits, `-`, `_`, `.`)",
                self.pack_id
            ));
        }
        if !(1..=5_000).contains(&self.pack_size) {
            // The selection queue is not itself a pack body: assembly owns the
            // final scenario ceiling (`pack assemble --max-scenarios`). A large
            // reviewed pool is legitimate, because the pack's unique-hand and
            // lesson-floor rules drop rows after review.
            return Err(format!(
                "`pack_size` {} is outside 1..=5000",
                self.pack_size
            ));
        }
        if !self.min_top_probability.is_finite()
            || !(self.min_top_probability > 0.0 && self.min_top_probability <= 1.0)
        {
            return Err(format!(
                "`min_top_probability` {} must be in (0, 1]",
                self.min_top_probability
            ));
        }
        if !self.min_probability_margin.is_finite() || self.min_probability_margin < 0.0 {
            return Err(format!(
                "`min_probability_margin` {} must be finite and non-negative",
                self.min_probability_margin
            ));
        }
        if !self.held_out_share.is_finite() || !(0.0..1.0).contains(&self.held_out_share) {
            return Err(format!(
                "`held_out_share` {} must be in [0, 1)",
                self.held_out_share
            ));
        }
        if self.held_out_salt.trim().is_empty() {
            return Err("`held_out_salt` must not be blank".to_string());
        }
        self.weights.validate()?;
        self.quotas.validate()?;
        self.percentiles.validate().map_err(|err| err.to_string())?;
        self.trigger.validate().map_err(|err| err.to_string())?;
        for prefix in &self.book_prefixes {
            if prefix.trim().is_empty() || !prefix.starts_with("ch") {
                return Err(format!(
                    "book prefix `{prefix}` must be a non-empty `ch<chapter>` string"
                ));
            }
        }
        if self.lessons.iter().any(|lesson| lesson.trim().is_empty()) {
            return Err("`lessons` must not contain a blank lesson id".to_string());
        }
        if self
            .replay_families
            .iter()
            .any(|family| family.trim().is_empty())
        {
            return Err("`replay_families` must not contain a blank family".to_string());
        }
        for (family, cap) in &self.replay_family_caps {
            if family.trim().is_empty() {
                return Err("`replay_family_caps` has a blank family".to_string());
            }
            if *cap == 0 {
                return Err(format!(
                    "replay family cap for `{family}` must be at least one"
                ));
            }
        }
        if self.max_per_replay == Some(0) {
            return Err("`max_per_replay` must be at least one".to_string());
        }
        Ok(())
    }

    /// Whether a book section satisfies the section scope.
    ///
    /// A prefix matches the section itself (`ch8`) or a dotted child
    /// (`ch8.2`). A Mortal-only candidate has no section and is rejected by a
    /// non-empty section scope, because a ch. 8 pack is a book-lesson pack.
    #[must_use]
    pub fn section_allowed(&self, section: Option<&str>) -> bool {
        if self.book_prefixes.is_empty() {
            return true;
        }
        let Some(section) = section else {
            return false;
        };
        self.book_prefixes.iter().any(|prefix| {
            section == prefix
                || section
                    .strip_prefix(prefix)
                    .is_some_and(|rest| rest.starts_with('.'))
        })
    }

    /// Whether a book lesson satisfies the lesson scope.
    #[must_use]
    pub fn lesson_allowed(&self, lesson: Option<&str>) -> bool {
        if self.lessons.is_empty() {
            return true;
        }
        lesson.is_some_and(|lesson| self.lessons.iter().any(|allowed| allowed == lesson))
    }

    /// Whether a corpus (replay) family satisfies the family scope.
    #[must_use]
    pub fn replay_family_allowed(&self, family: &str) -> bool {
        self.replay_families.is_empty()
            || self.replay_families.iter().any(|allowed| allowed == family)
    }

    /// A one-line description of the scope, for the selection report notes.
    #[must_use]
    pub fn scope_note(&self) -> Option<String> {
        if self.book_prefixes.is_empty()
            && self.lessons.is_empty()
            && self.replay_families.is_empty()
            && !self.stable_book_only
        {
            return None;
        }
        let mut parts = Vec::new();
        if !self.book_prefixes.is_empty() {
            parts.push(format!("sections={}", self.book_prefixes.join(",")));
        }
        if !self.lessons.is_empty() {
            parts.push(format!("lessons={}", self.lessons.join(",")));
        }
        if !self.replay_families.is_empty() {
            parts.push(format!("corpus={}", self.replay_families.join(",")));
        }
        if self.stable_book_only {
            parts.push("stable book labels only".to_string());
        }
        Some(format!("scope: {}", parts.join("; ")))
    }

    /// How many candidates the held-out QA set should hold.
    #[must_use]
    pub fn held_out_target(&self) -> usize {
        if self.held_out_share <= 0.0 {
            return 0;
        }
        ((self.held_out_share * self.pack_size as f32 - 1e-4).ceil() as usize).min(self.pack_size)
    }
}

/// Source, licence and provenance facts for one replay.
///
/// The run fills this from the `replays` row and the embedded
/// [`crate::miner::provenance::GameProvenance`]; a fixture leaves every flag
/// `true`. The gate reads the flags, not the database, so the decision is one
/// explicit step.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReplayFacts {
    /// Corpus family (`mortal_mirror`, `akochan_vs_mortal`, ...).
    pub family: String,
    /// A `replays` row exists for the file.
    #[serde(default)]
    pub row_present: bool,
    /// The stored `replays.source` value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// The stored data licence id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub licence: Option<String>,
    /// The stored validation status.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub validation: Option<String>,
    /// `source` is exactly `ai_selfplay`.
    pub source_ok: bool,
    /// The licence is on the pack data allowlist.
    pub licence_ok: bool,
    /// The `GameProvenance` document validated (schema, seats, seed, rule, log).
    pub provenance_ok: bool,
    /// Why the provenance failed, when it did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provenance_detail: Option<String>,
    /// The replay's validation summary is publishable.
    pub validation_ok: bool,
    /// Provenance validates **and** its validation summary is publishable.
    pub publishable: bool,
    /// The walk reconstructed every decision in the game.
    pub walk_clean: bool,
}

impl ReplayFacts {
    /// A fixture fact set that passes every source gate.
    #[must_use]
    pub fn fixture_ok() -> Self {
        Self {
            family: "mortal_mirror".to_string(),
            row_present: true,
            source: Some("ai_selfplay".to_string()),
            licence: Some("CC-BY-4.0".to_string()),
            validation: Some("ok".to_string()),
            source_ok: true,
            licence_ok: true,
            provenance_ok: true,
            provenance_detail: None,
            validation_ok: true,
            publishable: true,
            walk_clean: true,
        }
    }
}

/// Which half of the label supplied the answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnswerSource {
    /// A cited book rule with a unique answer.
    Book,
    /// A book answer the model disagrees with (dual verdict).
    Contested,
    /// A Mortal-only best action.
    Mortal,
}

impl AnswerSource {
    /// The JSON/database spelling.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Book => "book",
            Self::Contested => "contested",
            Self::Mortal => "mortal",
        }
    }
}

impl std::fmt::Display for AnswerSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The compact, state-free label facts a candidate keeps.
///
/// The full [`ModelLabel`] (ranking and Q map) is reloaded for the selected and
/// held-out candidates only, when the review report is built. This struct keeps
/// the numbers the gates and score need plus the answer-free book metadata.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LabelFacts {
    /// `book`, `contested`, `mortal` or `none`.
    pub kind: String,
    /// `stable`, `contested` or `unresolved`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stability: Option<String>,
    /// Labeler checkpoint name.
    pub model: String,
    /// Labeler checkpoint SHA-256.
    pub model_sha256: String,
    /// The model's top action.
    pub top_action: String,
    /// Probability of the top action.
    pub top_probability: f32,
    /// `p(best) - p(second)`.
    pub probability_margin: f32,
    /// `q(best) - q(second)`, model utility.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub q_gap_top2: Option<f32>,
    /// `q(best) - q(safest)`, model utility.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub q_gap_safe: Option<f32>,
    /// `q(best) - q(played)`, when the record did not play the top action.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub played_gap: Option<f32>,
    /// The classifier's answer-free situation note.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub book_situation: Option<String>,
    /// How a contested book label was settled.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub book_resolution: Option<String>,
    /// The discard the model would declare Riichi on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub riichi_discard: Option<String>,
}

impl LabelFacts {
    /// Build the compact facts from a cached label and the recorded action.
    #[must_use]
    pub fn from_label(label: &ModelLabel, played_action: &str) -> Self {
        Self {
            kind: label_kind_name(label.kind()),
            stability: label
                .stability()
                .map(|stability| format!("{stability:?}").to_lowercase()),
            model: label.model.clone(),
            model_sha256: label.model_sha256.clone(),
            top_action: label.top_action.clone(),
            top_probability: label.top_probability,
            probability_margin: label.probability_margin,
            q_gap_top2: label.q_gap_top2,
            q_gap_safe: label.q_gap_safe,
            played_gap: played_gap(played_action, label),
            book_situation: label.book.as_ref().and_then(|book| book.situation.clone()),
            book_resolution: label.book.as_ref().map(|book| book.resolution.clone()),
            riichi_discard: label.riichi_discard.clone(),
        }
    }

    /// The label kind spelling.
    #[must_use]
    pub fn label_kind(&self) -> &str {
        &self.kind
    }
}

fn label_kind_name(kind: LabelKind) -> String {
    match kind {
        LabelKind::Book => "book",
        LabelKind::Contested => "contested",
        LabelKind::Mortal => "mortal",
        LabelKind::Unlabelled => "none",
    }
    .to_string()
}

/// One gate-passing candidate, without its table state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Candidate {
    /// Content-addressed decision id.
    pub decision_id: String,
    /// The replay the decision came from.
    pub replay_id: String,
    /// The replay's corpus family.
    pub replay_family: String,
    /// 0-based kyoku ordinal.
    pub kyoku_index: usize,
    /// Event index of the decision inside the replay.
    pub event_index: usize,
    /// What kind of decision this is.
    pub kind: DecisionKind,
    /// Table turn (longest river).
    pub turn: usize,
    /// Coarse turn bucket.
    pub turn_bucket: TurnBucket,
    /// `<decision kind>/<turn bucket>`.
    pub decision_family: String,
    /// Which label half supplied the answer.
    pub answer_source: AnswerSource,
    /// The answer the selector would ship.
    pub answer: CorrectAction,
    /// Every tile the answer accepts.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub accepted: Vec<String>,
    /// The book lesson id, when the answer is a book answer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lesson: Option<String>,
    /// The book section (`ch8.4`), when the answer has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub book_section: Option<String>,
    /// The decision prompt the book lesson asks, when the answer has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_action: Option<TargetAction>,
    /// The compact label facts.
    pub label: LabelFacts,
    /// The candidate families this decision can feed.
    pub families: BTreeSet<Family>,
    /// The S1 trigger report.
    pub triggers: TriggerReport,
    /// The exact model-visible state hash.
    pub exact_hash: String,
    /// The literal visible-table fingerprint.
    pub visible_fingerprint: String,
    /// The ranking signals.
    pub signals: Signals,
    /// The composite score.
    pub score: f32,
}

impl Candidate {
    /// The book-section bucket key (`none` when the answer is Mortal-only).
    #[must_use]
    pub fn section_key(&self) -> &str {
        self.book_section.as_deref().unwrap_or("none")
    }

    /// The decision-kind bucket key.
    #[must_use]
    pub fn kind_key(&self) -> &str {
        self.kind.as_str()
    }

    /// The turn-bucket bucket key.
    #[must_use]
    pub fn turn_key(&self) -> &str {
        self.turn_bucket.as_str()
    }
}

/// One selected candidate, with the family that consumed its quota.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SelectedScenario {
    /// The candidate.
    pub candidate: Candidate,
    /// The family the selector assigned it to.
    pub family: Family,
    /// 1-based rank inside that family's candidate bucket.
    pub rank: usize,
}

/// One family's quota outcome.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FamilyQuotaRow {
    /// The family.
    pub family: Family,
    /// Integer quota for this pack.
    pub quota: usize,
    /// Valid candidates that could feed it.
    pub candidates: usize,
    /// How many the pack took.
    pub selected: usize,
    /// Shortfall, and why it happened.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shortfall: Option<String>,
}

/// One diversity bucket's cap outcome.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BucketQuotaRow {
    /// Bucket key (`ch8.4`, `self_turn`, `mid`, ...).
    pub bucket: String,
    /// Maximum the pack allows from this bucket. `None` for the `none` book
    /// section, which has no section cap.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cap: Option<usize>,
    /// Valid candidates in this bucket.
    pub candidates: usize,
    /// How many the pack took.
    pub selected: usize,
    /// True when the pack filled the cap.
    pub cap_reached: bool,
    /// How far the pack went over the cap after the relaxed fill.
    #[serde(default, skip_serializing_if = "is_zero_usize")]
    pub relaxed: usize,
}

const fn is_zero_usize(value: &usize) -> bool {
    *value == 0
}

/// The result of the pure selection pass over a candidate list.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SelectionPlan {
    /// Selected candidates, in selection order.
    pub selected: Vec<SelectedScenario>,
    /// The held-out QA set, in holdout-key order.
    pub held_out: Vec<Candidate>,
    /// One row per family, in report order.
    pub families: Vec<FamilyQuotaRow>,
    /// Book-section buckets, sorted by key.
    pub sections: Vec<BucketQuotaRow>,
    /// Decision-kind buckets, sorted by key.
    pub kinds: Vec<BucketQuotaRow>,
    /// Turn buckets, in early/mid/late order.
    pub turns: Vec<BucketQuotaRow>,
    /// Corpus-family buckets, sorted by key.
    pub replay_families: Vec<BucketQuotaRow>,
    /// Integer family quotas.
    pub quotas: BTreeMap<Family, usize>,
    /// The integer diversity caps.
    pub caps: QuotaCaps,
    /// Candidates dropped during the fill because they duplicated a selected
    /// one.
    pub dedupe: DedupeStats,
    /// Selections skipped because a diversity cap was full.
    pub cap_blocked: u64,
    /// Selections skipped because a corpus-family cap was full.
    pub replay_cap_blocked: u64,
    /// Selections skipped because a source replay already had its maximum.
    pub source_replay_cap_blocked: u64,
    /// Scenarios selected **beyond** a diversity cap because the remaining pool
    /// had nothing else to offer.
    pub cap_relaxed: u64,
    /// Slots filled after the quota round (open slots and the relaxed fill).
    pub relaxed_fill: u64,
    /// Slots filled outside the family quotas (a partial-share mix).
    pub open_slots_used: usize,
}

/// The deterministic held-out key for one candidate.
#[must_use]
pub fn held_out_key(salt: &str, exact_hash: &str) -> String {
    crate::miner::provenance::sha256_hex(
        format!("riichiprac.held-out.v1:{salt}:{exact_hash}").as_bytes(),
    )
}

/// Fill `signals.novelty` from the candidate pool's bucket frequencies and
/// recompute every composite score.
///
/// `novelty` is the mean of the inverse frequency of the candidate's book
/// section, decision kind and turn bucket. The most common value in each
/// dimension scores `0`, the rarest scores `1`. This is coverage, not rarity for
/// its own sake (§7.4): a rare state that fills a hole scores high, a rare state
/// in an already-covered bucket does not.
pub fn assign_novelty_and_scores(candidates: &mut [Candidate], weights: &ScoreWeights) {
    let mut sections: BTreeMap<String, usize> = BTreeMap::new();
    let mut kinds: BTreeMap<String, usize> = BTreeMap::new();
    let mut turns: BTreeMap<String, usize> = BTreeMap::new();
    for candidate in candidates.iter() {
        *sections
            .entry(candidate.section_key().to_string())
            .or_insert(0) += 1;
        *kinds.entry(candidate.kind_key().to_string()).or_insert(0) += 1;
        *turns.entry(candidate.turn_key().to_string()).or_insert(0) += 1;
    }
    let max = |counts: &BTreeMap<String, usize>| counts.values().copied().max().unwrap_or(0);
    let section_max = max(&sections);
    let kind_max = max(&kinds);
    let turn_max = max(&turns);

    for candidate in candidates.iter_mut() {
        let rarity = |counts: &BTreeMap<String, usize>, key: &str, maximum: usize| -> f32 {
            if maximum == 0 {
                return 0.0;
            }
            let count = counts.get(key).copied().unwrap_or(0);
            1.0 - count as f32 / maximum as f32
        };
        let novelty = (rarity(&sections, candidate.section_key(), section_max)
            + rarity(&kinds, candidate.kind_key(), kind_max)
            + rarity(&turns, candidate.turn_key(), turn_max))
            / 3.0;
        candidate.signals.novelty = novelty.clamp(0.0, 1.0);
        candidate.score = weights.score(&candidate.signals);
    }
}

/// Rank candidates for one family: highest score first, ties by exact hash.
pub(crate) fn rank_key(left: &Candidate, right: &Candidate) -> std::cmp::Ordering {
    right
        .score
        .total_cmp(&left.score)
        .then_with(|| left.exact_hash.cmp(&right.exact_hash))
}

/// Choose the held-out QA set deterministically and remove it from the pool.
fn split_held_out(candidates: &[Candidate], config: &SelectionConfig) -> Vec<usize> {
    let target = config.held_out_target();
    if target == 0 {
        return Vec::new();
    }
    let mut order: Vec<usize> = (0..candidates.len()).collect();
    order.sort_by(|left, right| {
        held_out_key(&config.held_out_salt, &candidates[*left].exact_hash)
            .cmp(&held_out_key(
                &config.held_out_salt,
                &candidates[*right].exact_hash,
            ))
            .then_with(|| {
                candidates[*left]
                    .exact_hash
                    .cmp(&candidates[*right].exact_hash)
            })
    });
    let mut taken = Vec::with_capacity(target);
    let mut seen = DedupeSet::new();
    for index in order {
        if taken.len() >= target {
            break;
        }
        let candidate = &candidates[index];
        if seen
            .insert(
                candidate.exact_hash.clone(),
                candidate.visible_fingerprint.clone(),
                &candidate.decision_id,
            )
            .is_none()
        {
            taken.push(index);
        }
    }
    taken
}

/// The pure selection pass: held-out split, novelty, family buckets, quotas,
/// caps and dedupe.
#[must_use]
pub fn plan_selection(mut candidates: Vec<Candidate>, config: &SelectionConfig) -> SelectionPlan {
    // A stable input order makes the whole plan independent of filesystem order.
    candidates.sort_by(|left, right| left.exact_hash.cmp(&right.exact_hash));
    assign_novelty_and_scores(&mut candidates, &config.weights);

    let held_out_indices = split_held_out(&candidates, config);
    let held_out_set: BTreeSet<usize> = held_out_indices.iter().copied().collect();
    let held_out: Vec<Candidate> = held_out_indices
        .iter()
        .map(|index| candidates[*index].clone())
        .collect();

    let quotas = config.quotas.family_counts(config.pack_size);
    let caps = config.quotas.caps(config.pack_size);
    let open_slots = config.quotas.open_slots(config.pack_size);

    let mut buckets: BTreeMap<Family, Vec<usize>> = BTreeMap::new();
    let mut ranks: BTreeMap<(Family, usize), usize> = BTreeMap::new();
    for family in Family::ALL {
        let mut indices: Vec<usize> = candidates
            .iter()
            .enumerate()
            .filter(|(index, candidate)| {
                !held_out_set.contains(index) && candidate.families.contains(&family)
            })
            .map(|(index, _)| index)
            .collect();
        indices.sort_by(|left, right| rank_key(&candidates[*left], &candidates[*right]));
        for (position, index) in indices.iter().enumerate() {
            ranks.insert((family, *index), position + 1);
        }
        buckets.insert(family, indices);
    }

    let mut seen = DedupeSet::new();
    let mut selected: Vec<SelectedScenario> = Vec::new();
    let mut selected_indices: BTreeSet<usize> = BTreeSet::new();
    let mut family_selected: BTreeMap<Family, usize> = BTreeMap::new();
    let mut cursors: BTreeMap<Family, usize> = BTreeMap::new();
    let mut cap_blocked_by_family: BTreeMap<Family, u64> = BTreeMap::new();
    let mut section_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut kind_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut turn_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut replay_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut replay_id_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut dedupe = DedupeStats::default();
    // Indices known to duplicate an already selected candidate. They are never
    // retried: a later fill phase must not count the same duplicate twice.
    let mut duplicate_indices: BTreeSet<usize> = BTreeSet::new();
    let mut cap_blocked = 0_u64;
    let mut replay_cap_blocked = 0_u64;
    let mut source_replay_cap_blocked = 0_u64;

    let caps_ok = |candidate: &Candidate,
                   sections: &BTreeMap<String, usize>,
                   kinds: &BTreeMap<String, usize>,
                   turns: &BTreeMap<String, usize>,
                   replays: &BTreeMap<String, usize>| {
        // A Mortal-only candidate has no book section, so the section cap does
        // not apply to it; applying a cap to "none" would limit the unbooked
        // half of the pack for no pedagogical reason.
        let section_ok = candidate.book_section.is_none()
            || sections.get(candidate.section_key()).copied().unwrap_or(0) < caps.section;
        let replay_ok = config
            .replay_family_caps
            .get(&candidate.replay_family)
            .is_none_or(|cap| replays.get(&candidate.replay_family).copied().unwrap_or(0) < *cap);
        section_ok
            && replay_ok
            && kinds.get(candidate.kind_key()).copied().unwrap_or(0) < caps.decision_kind
            && turns.get(candidate.turn_key()).copied().unwrap_or(0) < caps.turn_bucket
    };
    let source_replay_ok = |candidate: &Candidate, counts: &BTreeMap<String, usize>| {
        config
            .max_per_replay
            .is_none_or(|cap| counts.get(&candidate.replay_id).copied().unwrap_or(0) < cap)
    };

    loop {
        if selected.len() >= config.pack_size {
            break;
        }
        let mut order: Vec<Family> = Family::ALL
            .into_iter()
            .filter(|family| {
                family_selected.get(family).copied().unwrap_or(0)
                    < quotas.get(family).copied().unwrap_or(0)
                    && cursors.get(family).copied().unwrap_or(0)
                        < buckets.get(family).map_or(0, Vec::len)
            })
            .collect();
        if order.is_empty() {
            break;
        }
        // The family furthest below its quota goes first, so a scarce family is
        // not starved by a rich one. Ties keep the strategy's report order.
        order.sort_by(|left, right| {
            let deficit = |family: &Family| {
                let quota = quotas.get(family).copied().unwrap_or(0).max(1) as f32;
                let taken = family_selected.get(family).copied().unwrap_or(0) as f32;
                (quota - taken) / quota
            };
            deficit(right)
                .total_cmp(&deficit(left))
                .then_with(|| left.cmp(right))
        });

        let mut progress = false;
        for family in order {
            if selected.len() >= config.pack_size {
                break;
            }
            let bucket = buckets.get(&family).cloned().unwrap_or_default();
            let mut cursor = cursors.get(&family).copied().unwrap_or(0);
            while cursor < bucket.len() {
                let index = bucket[cursor];
                cursor += 1;
                if selected_indices.contains(&index) || duplicate_indices.contains(&index) {
                    continue;
                }
                let candidate = &candidates[index];
                if !source_replay_ok(candidate, &replay_id_counts) {
                    source_replay_cap_blocked += 1;
                    continue;
                }
                let replay_ok = config
                    .replay_family_caps
                    .get(&candidate.replay_family)
                    .is_none_or(|cap| {
                        replay_counts
                            .get(&candidate.replay_family)
                            .copied()
                            .unwrap_or(0)
                            < *cap
                    });
                if !replay_ok {
                    replay_cap_blocked += 1;
                    continue;
                }
                if !caps_ok(
                    candidate,
                    &section_counts,
                    &kind_counts,
                    &turn_counts,
                    &replay_counts,
                ) {
                    cap_blocked += 1;
                    *cap_blocked_by_family.entry(family).or_insert(0) += 1;
                    continue;
                }
                if let Some(failure) = seen.insert(
                    candidate.exact_hash.clone(),
                    candidate.visible_fingerprint.clone(),
                    &candidate.decision_id,
                ) {
                    count_duplicate(&mut dedupe, &failure);
                    duplicate_indices.insert(index);
                    continue;
                }
                selected_indices.insert(index);
                *family_selected.entry(family).or_insert(0) += 1;
                *section_counts
                    .entry(candidate.section_key().to_string())
                    .or_insert(0) += 1;
                *kind_counts
                    .entry(candidate.kind_key().to_string())
                    .or_insert(0) += 1;
                *turn_counts
                    .entry(candidate.turn_key().to_string())
                    .or_insert(0) += 1;
                *replay_counts
                    .entry(candidate.replay_family.clone())
                    .or_insert(0) += 1;
                *replay_id_counts
                    .entry(candidate.replay_id.clone())
                    .or_insert(0) += 1;
                selected.push(SelectedScenario {
                    candidate: candidate.clone(),
                    family,
                    rank: ranks.get(&(family, index)).copied().unwrap_or(0),
                });
                progress = true;
                break;
            }
            cursors.insert(family, cursor);
            if progress {
                break;
            }
        }
        if !progress {
            break;
        }
    }

    // A partial-share mix leaves slots that no family quota owns. Fill them with
    // the best remaining candidate, still respecting the caps and dedupe.
    let mut open_slots_used = 0;
    if open_slots > 0 && selected.len() < config.pack_size {
        let mut order: Vec<usize> = (0..candidates.len())
            .filter(|index| {
                !held_out_set.contains(index)
                    && !selected_indices.contains(index)
                    && !duplicate_indices.contains(index)
            })
            .collect();
        order.sort_by(|left, right| rank_key(&candidates[*left], &candidates[*right]));
        for index in order {
            if selected.len() >= config.pack_size || open_slots_used >= open_slots {
                break;
            }
            let candidate = &candidates[index];
            if !source_replay_ok(candidate, &replay_id_counts) {
                source_replay_cap_blocked += 1;
                continue;
            }
            if !caps_ok(
                candidate,
                &section_counts,
                &kind_counts,
                &turn_counts,
                &replay_counts,
            ) {
                cap_blocked += 1;
                continue;
            }
            let Some(family) = balanced_family(candidate, &family_selected, &quotas) else {
                continue;
            };
            if let Some(failure) = seen.insert(
                candidate.exact_hash.clone(),
                candidate.visible_fingerprint.clone(),
                &candidate.decision_id,
            ) {
                count_duplicate(&mut dedupe, &failure);
                duplicate_indices.insert(index);
                continue;
            }
            selected_indices.insert(index);
            *section_counts
                .entry(candidate.section_key().to_string())
                .or_insert(0) += 1;
            *kind_counts
                .entry(candidate.kind_key().to_string())
                .or_insert(0) += 1;
            *turn_counts
                .entry(candidate.turn_key().to_string())
                .or_insert(0) += 1;
            *replay_counts
                .entry(candidate.replay_family.clone())
                .or_insert(0) += 1;
            *replay_id_counts
                .entry(candidate.replay_id.clone())
                .or_insert(0) += 1;
            selected.push(SelectedScenario {
                candidate: candidate.clone(),
                family,
                rank: ranks.get(&(family, index)).copied().unwrap_or(0),
            });
            open_slots_used += 1;
        }
    }

    // A cap is a "do not let this bucket crowd out the others" rule, not a
    // reason to ship a short pack. When the pack still has room and every
    // remaining candidate sits in a bucket that has already met its cap, relax
    // the cap rather than leave the slot empty; the report records exactly how
    // many scenarios were selected that way. Under-quota families go first, so
    // the relaxation repairs the quota mix before it pads the easiest family.
    let mut cap_relaxed = 0_u64;
    let mut relaxed_fill = 0_u64;
    if selected.len() < config.pack_size {
        let mut order: Vec<Family> = Family::ALL
            .into_iter()
            .filter(|family| {
                family_selected.get(family).copied().unwrap_or(0)
                    < quotas.get(family).copied().unwrap_or(0)
                    && buckets.get(family).is_some_and(|bucket| !bucket.is_empty())
            })
            .collect();
        order.sort_by(|left, right| {
            let deficit = |family: &Family| {
                let quota = quotas.get(family).copied().unwrap_or(0).max(1) as f32;
                let taken = family_selected.get(family).copied().unwrap_or(0) as f32;
                (quota - taken) / quota
            };
            deficit(right)
                .total_cmp(&deficit(left))
                .then_with(|| left.cmp(right))
        });
        'families: for family in order {
            // Start from the top of the bucket again: the quota round left the
            // cursor past the cap-blocked candidates, and those are exactly the
            // ones the relaxation is here to reconsider.
            let bucket = buckets.get(&family).cloned().unwrap_or_default();
            let quota = quotas.get(&family).copied().unwrap_or(0);
            for index in bucket {
                if selected.len() >= config.pack_size {
                    break 'families;
                }
                if family_selected.get(&family).copied().unwrap_or(0) >= quota {
                    break;
                }
                if selected_indices.contains(&index)
                    || held_out_set.contains(&index)
                    || duplicate_indices.contains(&index)
                {
                    continue;
                }
                let candidate = &candidates[index];
                if !source_replay_ok(candidate, &replay_id_counts) {
                    source_replay_cap_blocked += 1;
                    continue;
                }
                let replay_ok = config
                    .replay_family_caps
                    .get(&candidate.replay_family)
                    .is_none_or(|cap| {
                        replay_counts
                            .get(&candidate.replay_family)
                            .copied()
                            .unwrap_or(0)
                            < *cap
                    });
                if !replay_ok {
                    replay_cap_blocked += 1;
                    continue;
                }
                let over_cap = !caps_ok(
                    candidate,
                    &section_counts,
                    &kind_counts,
                    &turn_counts,
                    &replay_counts,
                );
                if let Some(failure) = seen.insert(
                    candidate.exact_hash.clone(),
                    candidate.visible_fingerprint.clone(),
                    &candidate.decision_id,
                ) {
                    count_duplicate(&mut dedupe, &failure);
                    duplicate_indices.insert(index);
                    continue;
                }
                if over_cap {
                    cap_relaxed += 1;
                }
                selected_indices.insert(index);
                *family_selected.entry(family).or_insert(0) += 1;
                *section_counts
                    .entry(candidate.section_key().to_string())
                    .or_insert(0) += 1;
                *kind_counts
                    .entry(candidate.kind_key().to_string())
                    .or_insert(0) += 1;
                *turn_counts
                    .entry(candidate.turn_key().to_string())
                    .or_insert(0) += 1;
                *replay_counts
                    .entry(candidate.replay_family.clone())
                    .or_insert(0) += 1;
                *replay_id_counts
                    .entry(candidate.replay_id.clone())
                    .or_insert(0) += 1;
                selected.push(SelectedScenario {
                    candidate: candidate.clone(),
                    family,
                    rank: ranks.get(&(family, index)).copied().unwrap_or(0),
                });
                relaxed_fill += 1;
            }
        }
    }
    if selected.len() < config.pack_size {
        let mut order: Vec<usize> = (0..candidates.len())
            .filter(|index| {
                !held_out_set.contains(index)
                    && !selected_indices.contains(index)
                    && !duplicate_indices.contains(index)
            })
            .collect();
        order.sort_by(|left, right| rank_key(&candidates[*left], &candidates[*right]));
        for index in order {
            if selected.len() >= config.pack_size {
                break;
            }
            if duplicate_indices.contains(&index) {
                continue;
            }
            let candidate = &candidates[index];
            let Some(family) = balanced_family(candidate, &family_selected, &quotas) else {
                continue;
            };
            if !source_replay_ok(candidate, &replay_id_counts) {
                source_replay_cap_blocked += 1;
                continue;
            }
            let replay_ok = config
                .replay_family_caps
                .get(&candidate.replay_family)
                .is_none_or(|cap| {
                    replay_counts
                        .get(&candidate.replay_family)
                        .copied()
                        .unwrap_or(0)
                        < *cap
                });
            if !replay_ok {
                replay_cap_blocked += 1;
                continue;
            }
            let over_cap = !caps_ok(
                candidate,
                &section_counts,
                &kind_counts,
                &turn_counts,
                &replay_counts,
            );
            if let Some(failure) = seen.insert(
                candidate.exact_hash.clone(),
                candidate.visible_fingerprint.clone(),
                &candidate.decision_id,
            ) {
                count_duplicate(&mut dedupe, &failure);
                duplicate_indices.insert(index);
                continue;
            }
            if over_cap {
                cap_relaxed += 1;
            }
            selected_indices.insert(index);
            *family_selected.entry(family).or_insert(0) += 1;
            *section_counts
                .entry(candidate.section_key().to_string())
                .or_insert(0) += 1;
            *kind_counts
                .entry(candidate.kind_key().to_string())
                .or_insert(0) += 1;
            *turn_counts
                .entry(candidate.turn_key().to_string())
                .or_insert(0) += 1;
            *replay_counts
                .entry(candidate.replay_family.clone())
                .or_insert(0) += 1;
            *replay_id_counts
                .entry(candidate.replay_id.clone())
                .or_insert(0) += 1;
            selected.push(SelectedScenario {
                candidate: candidate.clone(),
                family,
                rank: ranks.get(&(family, index)).copied().unwrap_or(0),
            });
            relaxed_fill += 1;
        }
    }

    let families = Family::ALL
        .into_iter()
        .map(|family| {
            let quota = quotas.get(&family).copied().unwrap_or(0);
            let bucket = buckets.get(&family).cloned().unwrap_or_default();
            let candidates_in_family = bucket.len();
            let taken = family_selected.get(&family).copied().unwrap_or(0);
            let unclaimed = bucket
                .iter()
                .filter(|index| {
                    !selected_indices.contains(index) && !duplicate_indices.contains(index)
                })
                .count();
            let shortfall = (taken < quota).then(|| {
                if candidates_in_family == 0 {
                    "no_candidates"
                } else if unclaimed == 0 {
                    // Every candidate this family could feed was claimed by
                    // another family's quota, or was a duplicate.
                    "shared_with_other_families"
                } else if selected.len() >= config.pack_size {
                    "pack_full"
                } else if cap_blocked_by_family.get(&family).copied().unwrap_or(0) > 0 {
                    "cap_limited"
                } else {
                    "exhausted"
                }
                .to_string()
            });
            FamilyQuotaRow {
                family,
                quota,
                candidates: candidates_in_family,
                selected: taken,
                shortfall,
            }
        })
        .collect();

    let mut section_candidates: BTreeMap<String, usize> = BTreeMap::new();
    let mut kind_candidates: BTreeMap<String, usize> = BTreeMap::new();
    let mut turn_candidates: BTreeMap<String, usize> = BTreeMap::new();
    let mut replay_candidates: BTreeMap<String, usize> = BTreeMap::new();
    for (index, candidate) in candidates.iter().enumerate() {
        if held_out_set.contains(&index) {
            continue;
        }
        *section_candidates
            .entry(candidate.section_key().to_string())
            .or_insert(0) += 1;
        *kind_candidates
            .entry(candidate.kind_key().to_string())
            .or_insert(0) += 1;
        *turn_candidates
            .entry(candidate.turn_key().to_string())
            .or_insert(0) += 1;
        *replay_candidates
            .entry(candidate.replay_family.clone())
            .or_insert(0) += 1;
    }
    let rows = |candidate_counts: &BTreeMap<String, usize>,
                selected_counts: &BTreeMap<String, usize>,
                cap: usize,
                uncapped_bucket: Option<&str>| {
        candidate_counts
            .iter()
            .map(|(bucket, candidates)| {
                let taken = selected_counts.get(bucket).copied().unwrap_or(0);
                let applicable = uncapped_bucket != Some(bucket.as_str());
                let cap = applicable.then_some(cap);
                BucketQuotaRow {
                    bucket: bucket.clone(),
                    cap,
                    candidates: *candidates,
                    selected: taken,
                    cap_reached: cap.is_some_and(|cap| taken >= cap),
                    relaxed: cap.map_or(0, |cap| taken.saturating_sub(cap)),
                }
            })
            .collect::<Vec<_>>()
    };

    SelectionPlan {
        selected,
        held_out,
        families,
        sections: rows(
            &section_candidates,
            &section_counts,
            caps.section,
            Some("none"),
        ),
        kinds: rows(&kind_candidates, &kind_counts, caps.decision_kind, None),
        turns: rows(&turn_candidates, &turn_counts, caps.turn_bucket, None),
        replay_families: replay_candidates
            .iter()
            .map(|(bucket, candidates)| {
                let taken = replay_counts.get(bucket).copied().unwrap_or(0);
                let cap = config.replay_family_caps.get(bucket).copied();
                BucketQuotaRow {
                    bucket: bucket.clone(),
                    cap,
                    candidates: *candidates,
                    selected: taken,
                    cap_reached: cap.is_some_and(|cap| taken >= cap),
                    // A corpus-family cap is never relaxed: it is the mix rule,
                    // not a crowding-out guard.
                    relaxed: 0,
                }
            })
            .collect(),
        quotas,
        caps,
        dedupe,
        cap_blocked,
        cap_relaxed,
        relaxed_fill: relaxed_fill + open_slots_used as u64,
        open_slots_used,
        replay_cap_blocked,
        source_replay_cap_blocked,
    }
}

/// The family with the largest relative deficit that this candidate can feed.
///
/// The relaxed fill has no quota left to aim at, so it assigns each extra
/// scenario to the family that is furthest below its quota. That keeps a late
/// fill from piling onto the family whose bucket happens to sort first.
fn balanced_family(
    candidate: &Candidate,
    family_selected: &BTreeMap<Family, usize>,
    quotas: &BTreeMap<Family, usize>,
) -> Option<Family> {
    Family::ALL
        .into_iter()
        .filter(|family| candidate.families.contains(family))
        .max_by(|left, right| {
            let fill = |family: &Family| {
                let quota = quotas.get(family).copied().unwrap_or(0).max(1) as f32;
                let taken = family_selected.get(family).copied().unwrap_or(0) as f32;
                (quota - taken) / quota
            };
            fill(left)
                .total_cmp(&fill(right))
                .then_with(|| right.cmp(left))
        })
}

fn count_duplicate(stats: &mut DedupeStats, failure: &GateFailure) {
    if failure.code == "duplicate_exact" {
        stats.exact += 1;
    } else {
        stats.near += 1;
    }
}

/// Any failure while selecting, building a review report or reading a queue.
#[derive(Debug, Error)]
pub enum SelectionError {
    /// The configuration cannot describe a pack.
    #[error("invalid selection configuration: {0}")]
    InvalidConfig(String),
    /// A percentile configuration was rejected by L2.
    #[error(transparent)]
    Threshold(#[from] ThresholdError),
    /// The trigger pass failed.
    #[error(transparent)]
    Trigger(#[from] crate::miner::trigger::TriggerError),
    /// The data root or replay store failed.
    #[error(transparent)]
    Storage(#[from] crate::miner::storage::StorageError),
    /// SQLite failed.
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    /// A document could not be (de)serialised.
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    /// The replay directory does not exist.
    #[error("replay directory `{0}` does not exist")]
    MissingReplays(String),
    /// A file could not be read or written.
    #[error("I/O error at `{path}`: {source}")]
    Io {
        /// The path involved.
        path: String,
        /// The operating-system error.
        #[source]
        source: std::io::Error,
    },
    /// A replay could not be walked.
    #[error("replay `{path}`: {source}")]
    Walk {
        /// The replay path.
        path: String,
        /// The walker's error.
        #[source]
        source: WalkError,
    },
    /// Replay discovery failed.
    #[error("cannot discover replays: {0}")]
    Discovery(String),
    /// A review report could not be built or parsed.
    #[error("scenario report: {0}")]
    Report(String),
    /// The review queue is malformed or a disposition names an unknown id.
    #[error("review queue: {0}")]
    Review(String),
}

/// The table state a candidate's review report shows.
///
/// This is the walker's snapshot with the provisional `correct_action` replaced
/// by the label's answer, so the report the reviewer reads grades the answer the
/// pack would ship. A book answer keeps its lesson, target action and
/// equivalents; a Mortal answer uses the labeler's action vocabulary.
pub fn stamped_state(
    snapshot: &DecisionSnapshot,
    answer_source: AnswerSource,
    answer: &CorrectAction,
    accepted: &[String],
    lesson: Option<&str>,
    target_action: Option<TargetAction>,
) -> GameState {
    let mut state = snapshot.state.clone();
    state.ai_decision = None;
    state.riichi_triggers = Vec::new();
    state.dama_reasons = Vec::new();
    state.shouminkan_triggers = Vec::new();
    state.scenario_note = None;
    state.correct_action = answer.clone();
    let named = answer.tile();
    state.equivalent_tiles = accepted
        .iter()
        .filter(|tile| Some(tile.as_str()) != named)
        .cloned()
        .collect();
    match answer_source {
        AnswerSource::Book | AnswerSource::Contested => {
            state.category = lesson.unwrap_or("book").to_string();
            state.target_action = target_action.unwrap_or(TargetAction::Best);
        }
        AnswerSource::Mortal => {
            state.category = "mortal_best".to_string();
            state.target_action = TargetAction::Best;
        }
    }
    crate::generator::finalize_state(state)
}

/// Every pre-answer text the spoiler gate checks for one candidate.
///
/// These are the answer-free strings the selector would publish: the lesson's
/// manifest label and description, the classifier's situation note, the
/// candidate's selection reason and its provenance line. Trigger *details* are
/// excluded: they name candidate safe tiles and are review metadata, never
/// pre-answer copy.
#[must_use]
pub fn pre_answer_texts(
    lesson: Option<&str>,
    situation: Option<&str>,
    selection_reason: &str,
    provenance_line: &str,
) -> Vec<String> {
    let mut texts = vec![selection_reason.to_string(), provenance_line.to_string()];
    if let Some(lesson) = lesson
        && let Some(meta) = crate::generator::SCENARIO_MANIFEST
            .iter()
            .find(|meta| meta.id.as_str() == lesson)
    {
        texts.push(meta.label.to_string());
        texts.push(meta.description.to_string());
    }
    if let Some(situation) = situation {
        texts.push(situation.to_string());
    }
    texts
}

/// The answer-free selection reason stored on a selected scenario.
#[must_use]
pub fn selection_reason(
    family: Family,
    book_section: Option<&str>,
    candidate: &Candidate,
    rank: usize,
) -> String {
    let codes: Vec<&str> = candidate
        .triggers
        .hits
        .iter()
        .map(|hit| hit.code.as_str())
        .collect();
    format!(
        "family={family};section={};kind={};turn={};rank={rank};triggers={}",
        book_section.unwrap_or("none"),
        candidate.kind.as_str(),
        candidate.turn_bucket.as_str(),
        if codes.is_empty() {
            "none".to_string()
        } else {
            codes.join(",")
        }
    )
}

/// The answer-free provenance line stored on a review item.
#[must_use]
pub fn provenance_line(replay_family: &str, replay_id: &str, model: &str) -> String {
    format!(
        "replay={replay_family}/{};labeler={model}",
        &replay_id[..replay_id.len().min(12)]
    )
}

/// The table turn and bucket for a decision (kept here so callers do not need
/// the L2 threshold module).
#[must_use]
pub fn candidate_turn(snapshot: &DecisionSnapshot) -> (usize, TurnBucket) {
    let turn = table_turn(snapshot);
    (turn, TurnBucket::of(turn))
}
