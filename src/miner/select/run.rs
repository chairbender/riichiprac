//! The `mine_replays select` runner (implementation unit S2).
//!
//! Walks a replay shard, gates and ranks every decision, applies the quotas,
//! splits the held-out QA set and writes a review queue. The pure selection
//! logic lives in [`super::plan_selection`]; this module is the I/O and the
//! per-decision glue.
//!
//! # Passes
//!
//! 1. **Sample pass.** Walk the shard, read each decision's cached label from
//!    `decisions.label_json` or the L1 `model_labels` cache (never a forward
//!    pass), and collect the top-two / safe / played-action gap samples. The
//!    runs count their decisions here.
//! 2. **Candidate pass.** Walk again with the sample's percentile cuts, evaluate
//!    the S1 triggers, stamp the label's answer, run the gates, compute the
//!    signals and keep the compact candidate (no `GameState`).
//! 3. **Review pass.** Re-walk only the replays that hold a selected or held-out
//!    decision and build one embedded `riichiprac.scenario-report` per item.
//!
//! # Outputs
//!
//! ```text
//! $RIICHI_DATA_DIR/reviews/<pack-id>/review-queue.jsonl
//! $RIICHI_DATA_DIR/reviews/<pack-id>/held-out.jsonl
//! $RIICHI_DATA_DIR/reviews/<pack-id>/selection-report.json
//! $RIICHI_DATA_DIR/reviews/LATEST
//! ```
//!
//! `LATEST` holds the pack id so `mine_replays review` can find the most recent
//! queue without the operator typing a path. Nothing is written with
//! `--dry-run`, and a write failure leaves the previous file intact
//! ([`crate::miner::storage::write_atomic`]).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use serde::Serialize;

use crate::ai::actions::legal_actions;
use crate::ai::finalize::{action_info, correct_action_from_info, normalize_mortal_action};
use crate::ai::wasm_bridge::Evaluation;
use crate::decision::{ActionEvaluation, ActionInfo};
use crate::generator::SCENARIO_MANIFEST;
use crate::miner::funnel::{FunnelCounter, FunnelStage};
use crate::miner::label::thresholds::DecisionFamily;
use crate::miner::label::{LabelKind, ModelLabel};
use crate::miner::licence::allowed_data_licence;
use crate::miner::provenance::{GameProvenance, sha256_hex};
use crate::miner::source::SourceGate;
use crate::miner::storage::{DataRoot, open_miner_db, utc_stamp, write_atomic};
use crate::miner::trigger::report::load_label;
use crate::miner::trigger::{TriggerReport, evaluate_cheap, evaluate_with_label, families::Family};
use crate::replay::walk::{DecisionKind, DecisionSnapshot, walk_path};
use crate::report::{BuildReportRequest, ReportReason, ReportedAction, ReportedAi, build_report};
use crate::state::{CorrectAction, CorrectActionType, TargetAction};

use super::dedupe::{exact_state_hash, visible_info_fingerprint};
use super::gate::{GateFailure, GateInput, GateKind, evaluate};
use super::report::{GateStats, HeldOutStats, SelectionReport};
use super::review::ReviewItem;
use super::score::{SampleCuts, compute_signals};
use super::{
    AnswerSource, Candidate, LabelFacts, ReplayFacts, SELECTION_SCHEMA, SELECTION_VERSION,
    SelectedScenario, SelectionConfig, SelectionError, SelectionPlan, candidate_turn,
    plan_selection, pre_answer_texts, provenance_line, selection_reason, stamped_state,
};

/// One selection run's inputs.
#[derive(Debug, Clone)]
pub struct SelectionOptions {
    /// Replay directory. Defaults to `$RIICHI_DATA_DIR/replays`.
    pub replays: Option<PathBuf>,
    /// One family sub-directory only.
    pub family: Option<String>,
    /// Maximum replay files in the shard.
    pub limit: Option<usize>,
    /// Only walk replays that already have extracted `decisions` rows. A large
    /// corpus can hold thousands of unlabelled games; without this the
    /// selector walks them all to find no labels.
    pub extracted_only: bool,
    /// The selection configuration.
    pub config: SelectionConfig,
    /// Do not write the queue, the held-out set or the report.
    pub dry_run: bool,
}

/// Where one pack's selection files live.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelectionPaths {
    /// `reviews/<pack-id>/`.
    pub dir: PathBuf,
    /// `review-queue.jsonl`.
    pub queue: PathBuf,
    /// `held-out.jsonl`.
    pub held_out: PathBuf,
    /// `selection-report.json`.
    pub report: PathBuf,
    /// `reviews/LATEST`.
    pub latest: PathBuf,
}

/// The paths for one pack id under a data root.
#[must_use]
pub fn selection_paths(root: &DataRoot, pack_id: &str) -> SelectionPaths {
    let dir = root.reviews_dir().join(pack_id);
    SelectionPaths {
        queue: dir.join("review-queue.jsonl"),
        held_out: dir.join("held-out.jsonl"),
        report: dir.join("selection-report.json"),
        latest: root.reviews_dir().join("LATEST"),
        dir,
    }
}

/// The pack id written by the last `select` run, if any.
pub fn latest_pack(root: &DataRoot) -> Result<Option<String>, SelectionError> {
    let path = root.reviews_dir().join("LATEST");
    match std::fs::read_to_string(&path) {
        Ok(text) => {
            let pack = text.trim().to_string();
            Ok((!pack.is_empty()).then_some(pack))
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(source) => Err(SelectionError::Io {
            path: path.display().to_string(),
            source,
        }),
    }
}

/// What a selection run produced.
#[derive(Debug, Clone)]
pub struct SelectionOutcome {
    /// The machine-readable report.
    pub report: SelectionReport,
    /// The selected review-queue items, in queue order.
    pub queue: Vec<ReviewItem>,
    /// The held-out QA items, in holdout-key order.
    pub held_out: Vec<ReviewItem>,
    /// Where the queue lives (and was written, unless `--dry-run`).
    pub paths: SelectionPaths,
    /// Whether the files were written.
    pub written: bool,
}

/// One `replays` row, as the selection gates need it.
#[derive(Debug, Clone)]
struct ReplayRow {
    family: String,
    source: String,
    licence: String,
    validation: String,
    provenance_json: String,
}

fn load_replay_rows(
    connection: &Connection,
) -> Result<BTreeMap<String, ReplayRow>, SelectionError> {
    let mut statement = connection.prepare(
        "SELECT replay_id, family, source, licence, validation_status, provenance_json FROM replays",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            ReplayRow {
                family: row.get(1)?,
                source: row.get(2)?,
                licence: row.get(3)?,
                validation: row.get(4)?,
                provenance_json: row.get(5)?,
            },
        ))
    })?;
    let mut map = BTreeMap::new();
    for row in rows {
        let (id, row) = row?;
        map.insert(id, row);
    }
    Ok(map)
}

fn facts_for(row: Option<&ReplayRow>, replay_family: &str) -> ReplayFacts {
    let Some(row) = row else {
        return ReplayFacts {
            family: replay_family.to_string(),
            row_present: false,
            source: None,
            licence: None,
            validation: None,
            source_ok: false,
            licence_ok: false,
            provenance_ok: false,
            provenance_detail: Some(format!(
                "no `replays` row for this file; expected family `{replay_family}`"
            )),
            validation_ok: false,
            publishable: false,
            walk_clean: true,
        };
    };
    let mut facts = ReplayFacts {
        family: row.family.clone(),
        row_present: true,
        source: Some(row.source.clone()),
        licence: Some(row.licence.clone()),
        validation: Some(row.validation.clone()),
        source_ok: SourceGate::check(&row.source).is_ok(),
        licence_ok: allowed_data_licence(&row.licence),
        provenance_ok: false,
        provenance_detail: None,
        validation_ok: false,
        publishable: false,
        walk_clean: true,
    };
    match serde_json::from_str::<GameProvenance>(&row.provenance_json) {
        Ok(provenance) => match provenance.validate() {
            Ok(()) => {
                facts.provenance_ok = true;
                facts.validation_ok =
                    provenance.validation.is_publishable() && row.validation == "ok";
                facts.publishable = provenance.is_publishable() && row.validation == "ok";
            }
            Err(err) => {
                facts.provenance_detail = Some(err.to_string());
            }
        },
        Err(err) => {
            facts.provenance_detail = Some(format!("provenance JSON: {err}"));
        }
    }
    if !facts.validation_ok && facts.provenance_ok {
        facts.provenance_detail = Some(format!(
            "validation status `{}` is not publishable",
            row.validation
        ));
    }
    facts
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

fn io_error(path: &Path, source: std::io::Error) -> SelectionError {
    SelectionError::Io {
        path: path.display().to_string(),
        source,
    }
}

/// Walk a replay shard and select a review queue.
pub fn run_selection(
    root: &DataRoot,
    options: &SelectionOptions,
) -> Result<SelectionOutcome, SelectionError> {
    options
        .config
        .validate()
        .map_err(SelectionError::InvalidConfig)?;

    let replays_dir = options
        .replays
        .clone()
        .unwrap_or_else(|| root.replays_dir());
    let mut files =
        crate::miner::label::run::discover_replays(&replays_dir, options.family.as_deref())
            .map_err(|err| match err {
                crate::miner::label::LabelError::MissingReplays(path) => {
                    SelectionError::MissingReplays(path)
                }
                crate::miner::label::LabelError::Io { path, source } => {
                    SelectionError::Io { path, source }
                }
                other => SelectionError::Discovery(other.to_string()),
            })?;
    if let Some(limit) = options.limit {
        files.truncate(limit);
    }
    if !options.config.replay_families.is_empty() {
        files.retain(|path| {
            let family = family_of_path(path, &replays_dir);
            options.config.replay_family_allowed(&family)
        });
    }

    let connection = open_miner_db(root)?;
    if options.extracted_only {
        let mut statement = connection.prepare("SELECT DISTINCT replay_id FROM decisions")?;
        let extracted: std::collections::BTreeSet<String> = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<_, _>>()?;
        files.retain(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .and_then(|name| name.strip_suffix(".jsonl.gz"))
                .is_some_and(|id| extracted.contains(id))
        });
    }
    let replay_rows = load_replay_rows(&connection)?;

    let mut funnel = FunnelCounter::new();
    funnel.add(FunnelStage::GamesRequested, files.len() as u64);
    let mut errors: Vec<String> = Vec::new();
    let mut samples = SampleCuts::default();
    let mut decisions_seen = 0_u64;
    let mut decisions_dropped = 0_u64;
    let mut decisions_labelled = 0_u64;
    let mut replays_walked = 0_usize;
    let mut replays_failed = 0_usize;
    let mut replay_facts: BTreeMap<String, ReplayFacts> = BTreeMap::new();

    // Pass 1: the label sample. No triggers, no candidates, no forward pass.
    for path in &files {
        let walk = match walk_path(path) {
            Ok(walk) => walk,
            Err(err) => {
                replays_failed += 1;
                funnel.reject("replay_unreadable");
                push_error(&mut errors, format!("{}: {err}", path.display()));
                continue;
            }
        };
        replays_walked += 1;
        funnel.bump(FunnelStage::GamesParsed);
        funnel.reject_many("reachability", walk.skipped.len() as u64);
        decisions_dropped += walk.skipped.len() as u64;
        let replay_id = walk.replay_id.as_str().to_string();
        let family = family_of_path(path, &replays_dir);
        let mut facts = facts_for(replay_rows.get(&replay_id), &family);
        facts.walk_clean = walk.skipped.is_empty();
        if facts.source_ok && facts.licence_ok && facts.provenance_ok && facts.validation_ok {
            funnel.bump(FunnelStage::GamesValid);
        }
        replay_facts.insert(replay_id, facts);

        for decision in &walk.decisions {
            decisions_seen += 1;
            let hash = exact_state_hash(&decision.state);
            let label = load_label(&connection, &decision.decision_id, &hash)
                .map_err(SelectionError::Trigger)?;
            if let Some(label) = label {
                decisions_labelled += 1;
                samples.add(
                    &DecisionFamily::of(decision).key(),
                    &label,
                    &decision.played.action,
                );
            }
        }
    }
    funnel.add(FunnelStage::DecisionPoints, decisions_seen);

    let cuts = samples
        .label_cuts(&options.config.percentiles)
        .map_err(SelectionError::Threshold)?;

    // Pass 2: triggers, gates, signals, score.
    let mut candidates: Vec<Candidate> = Vec::new();
    let mut gate_counts: BTreeMap<GateKind, u64> = BTreeMap::new();
    let mut decisions_triggered = 0_u64;
    let mut decisions_classified = 0_u64;
    let mut reconstructed = 0_u64;

    for path in &files {
        let walk = match walk_path(path) {
            Ok(walk) => walk,
            Err(_) => continue,
        };
        let replay_id = walk.replay_id.as_str().to_string();
        let Some(facts) = replay_facts.get(&replay_id).cloned() else {
            continue;
        };
        let family = family_of_path(path, &replays_dir);
        for decision in &walk.decisions {
            reconstructed += 1;
            let hash = exact_state_hash(&decision.state);
            let label = load_label(&connection, &decision.decision_id, &hash)
                .map_err(SelectionError::Trigger)?;
            let report = match &label {
                Some(label) => evaluate_with_label(decision, label, &cuts, &options.config.trigger),
                None => evaluate_cheap(decision, &options.config.trigger),
            };
            if report.has_any() {
                decisions_triggered += 1;
            }
            if label.as_ref().is_some_and(|label| label.book.is_some()) {
                decisions_classified += 1;
            }
            let Some(label) = label.as_ref() else {
                *gate_counts.entry(GateKind::AnswerDefined).or_insert(0) += 1;
                funnel.reject("no_label");
                continue;
            };
            let plan = match answer_plan(decision, label) {
                Ok(plan) => plan,
                Err(failure) => {
                    *gate_counts.entry(failure.gate).or_insert(0) += 1;
                    funnel.reject(&failure.code);
                    continue;
                }
            };
            if options.config.stable_book_only && label.kind() != LabelKind::Book {
                funnel.reject("scope_not_stable_book");
                continue;
            }
            if !options.config.section_allowed(plan.section.as_deref())
                || !options.config.lesson_allowed(plan.lesson.as_deref())
                || !options.config.replay_family_allowed(&family)
            {
                funnel.reject("out_of_scope");
                continue;
            }
            match build_candidate(
                decision,
                label,
                plan,
                report,
                &facts,
                &family,
                &options.config,
                &samples,
                &cuts,
            ) {
                Ok(candidate) => candidates.push(candidate),
                Err(failure) => {
                    *gate_counts.entry(failure.gate).or_insert(0) += 1;
                    funnel.reject(&failure.code);
                }
            }
        }
    }
    funnel.add(FunnelStage::TriggerHits, decisions_triggered);
    funnel.add(FunnelStage::Reconstructed, reconstructed);
    funnel.add(FunnelStage::BookMatches, decisions_classified);
    funnel.add(FunnelStage::MortalLabelled, decisions_labelled);

    let candidate_count = candidates.len() as u64;
    funnel.add(FunnelStage::GatePassed, candidate_count);

    let plan = plan_selection(candidates, &options.config);
    funnel.add(FunnelStage::Selected, plan.selected.len() as u64);
    funnel.add(FunnelStage::HeldOut, plan.held_out.len() as u64);
    funnel.add(FunnelStage::Packed, 0);

    let paths = selection_paths(root, &options.config.pack_id);
    let created_at = rfc3339_now();
    let (mut items, missing) =
        build_review_items(&connection, &plan, &options.config, &created_at, &files)?;
    for decision_id in missing {
        push_error(
            &mut errors,
            format!("selected decision `{decision_id}` was not found when re-walking its replay"),
        );
        funnel.reject("review_item_missing");
    }
    // Keep the queue in selection order (the plan already is), and the QA set in
    // holdout-key order; `build_review_items` returns them in that order.
    items.sort_by(|left, right| left.queue_id.cmp(&right.queue_id));

    let held_out = plan.held_out.len() as u64;
    let held_out_target = options.config.held_out_target();
    let mut notes = vec![
        "games_generated is 0: selection consumes an existing corpus".to_string(),
        "packed is 0: P1a/P1b assemble, audit and ship the pack".to_string(),
        "a pack may not ship until every review-queue item has a disposition (P1b enforces it)"
            .to_string(),
    ];
    if plan.held_out.len() < held_out_target {
        notes.push(format!(
            "held-out QA is short of its target ({}/{held_out_target}): the valid pool was small \
             or duplicate-heavy",
            plan.held_out.len()
        ));
    }
    if plan.cap_blocked > 0 {
        notes.push(format!(
            "{} selection attempt(s) were skipped because a section/kind/turn cap was full",
            plan.cap_blocked
        ));
    }
    if plan.replay_cap_blocked > 0 {
        notes.push(format!(
            "{} selection attempt(s) were skipped because a corpus-family cap was full",
            plan.replay_cap_blocked
        ));
    }
    if plan.source_replay_cap_blocked > 0 {
        notes.push(format!(
            "{} selection attempt(s) were skipped because a source replay hit its per-replay \
             cap",
            plan.source_replay_cap_blocked
        ));
    }
    if let Some(scope) = options.config.scope_note() {
        notes.push(scope);
    }
    if plan.open_slots_used > 0 {
        notes.push(format!(
            "{} slot(s) were filled outside the family quotas (the configured shares sum below 1.0)",
            plan.open_slots_used
        ));
    }
    if plan.cap_relaxed > 0 {
        notes.push(format!(
            "{} scenario(s) were selected beyond a section/kind/turn cap: the remaining pool had \
             no candidate inside the cap, so the pack filled the slot instead of reporting a \
             shortfall",
            plan.cap_relaxed
        ));
    }

    let gate_rows: Vec<GateStats> = GateKind::ALL
        .into_iter()
        .map(|gate| GateStats {
            gate,
            rejected: gate_counts.get(&gate).copied().unwrap_or(0),
        })
        .collect();

    let report = SelectionReport {
        schema: SELECTION_SCHEMA.to_string(),
        version: SELECTION_VERSION,
        generated_at: utc_stamp(SystemTime::now()),
        pack_id: options.config.pack_id.clone(),
        pack_size: options.config.pack_size,
        replays_found: files.len(),
        replays_walked,
        replays_failed,
        decisions_seen,
        decisions_dropped,
        decisions_labelled,
        decisions_classified,
        decisions_triggered,
        candidates_valid: candidate_count,
        candidates_held_out: held_out,
        candidates_selected: plan.selected.len() as u64,
        funnel,
        gates: gate_rows,
        dedupe: plan.dedupe,
        cap_relaxed: plan.cap_relaxed,
        relaxed_fill: plan.relaxed_fill,
        held_out: HeldOutStats {
            target: held_out_target,
            kept: plan.held_out.len(),
        },
        families: plan.families.clone(),
        sections: plan.sections.clone(),
        kinds: plan.kinds.clone(),
        turns: plan.turns.clone(),
        replay_families: plan.replay_families.clone(),
        quotas: plan.quotas.clone(),
        caps: plan.caps,
        weights: options.config.weights,
        percentiles: samples.summary(&cuts),
        review_queue: relative(root, &paths.queue)?,
        held_out_queue: relative(root, &paths.held_out)?,
        report_path: relative(root, &paths.report)?,
        notes,
        errors,
    };

    let held_out_items: Vec<ReviewItem> =
        items.iter().filter(|item| item.held_out).cloned().collect();
    let queue: Vec<ReviewItem> = items.into_iter().filter(|item| !item.held_out).collect();
    let mut report = report;
    report.notes.push(format!(
        "review queue: {} item(s); held-out QA: {} item(s)",
        queue.len(),
        held_out_items.len()
    ));
    let mut outcome = SelectionOutcome {
        report,
        queue,
        held_out: held_out_items,
        paths,
        written: false,
    };
    if !options.dry_run {
        write_outputs(&outcome)?;
        outcome.written = true;
    }
    Ok(outcome)
}

fn relative(root: &DataRoot, path: &Path) -> Result<String, SelectionError> {
    root.relative_path(path).map_err(SelectionError::Storage)
}

fn push_error(errors: &mut Vec<String>, error: String) {
    const MAX_ERRORS: usize = 100;
    if errors.len() < MAX_ERRORS {
        errors.push(error);
    }
}

/// The answer a label would ship, plus its book metadata.
struct AnswerPlan {
    source: AnswerSource,
    answer: CorrectAction,
    accepted: Vec<String>,
    lesson: Option<String>,
    section: Option<String>,
    target_action: Option<TargetAction>,
}

fn answer_plan(snapshot: &DecisionSnapshot, label: &ModelLabel) -> Result<AnswerPlan, GateFailure> {
    match label.kind() {
        LabelKind::Book | LabelKind::Contested => {
            let Some(book) = label.book.as_ref() else {
                return Err(GateFailure::new(
                    GateKind::AnswerDefined,
                    "book_label_missing_answer",
                    "the label kind is book/contested but carries no book answer",
                ));
            };
            let section = SCENARIO_MANIFEST
                .iter()
                .find(|meta| meta.id.as_str() == book.lesson)
                .and_then(|meta| meta.book)
                .map(|book| book.key());
            Ok(AnswerPlan {
                source: if label.kind() == LabelKind::Contested {
                    AnswerSource::Contested
                } else {
                    AnswerSource::Book
                },
                answer: book.correct_action.clone(),
                accepted: book.accepted.clone(),
                lesson: Some(book.lesson.clone()),
                section,
                target_action: Some(book.target_action),
            })
        }
        LabelKind::Mortal => {
            let info = action_info(&snapshot.state, &label.top_action).or_else(|| {
                let wanted = normalize_mortal_action(&label.top_action);
                legal_actions(&snapshot.state)
                    .into_iter()
                    .find(|info| normalize_mortal_action(&info.action) == wanted)
            });
            let Some(info) = info else {
                return Err(GateFailure::new(
                    GateKind::AnswerLegal,
                    "top_action_not_legal",
                    format!(
                        "the label's top action `{}` is not a legal action on this table",
                        label.top_action
                    ),
                ));
            };
            let answer = correct_action_from_info(&info, label.riichi_discard.as_deref());
            let accepted = answer.tile().map(str::to_string).into_iter().collect();
            Ok(AnswerPlan {
                source: AnswerSource::Mortal,
                answer,
                accepted,
                lesson: None,
                section: None,
                target_action: Some(if snapshot.kind == DecisionKind::Call {
                    TargetAction::Call
                } else {
                    TargetAction::Best
                }),
            })
        }
        LabelKind::Unlabelled => Err(GateFailure::new(
            GateKind::AnswerDefined,
            "unresolved_label",
            "the label is unresolved: no book answer and no Mortal answer",
        )),
    }
}

#[allow(clippy::too_many_arguments)]
fn build_candidate(
    snapshot: &DecisionSnapshot,
    label: &ModelLabel,
    plan: AnswerPlan,
    report: TriggerReport,
    facts: &ReplayFacts,
    replay_family: &str,
    config: &SelectionConfig,
    samples: &SampleCuts,
    cuts: &crate::miner::trigger::LabelCuts,
) -> Result<Candidate, GateFailure> {
    let (turn, turn_bucket) = candidate_turn(snapshot);
    let family_key = DecisionFamily::of(snapshot).key();
    let signals = compute_signals(snapshot, label, &family_key, facts, samples, &cuts.blunder);

    let codes: Vec<&str> = report.hits.iter().map(|hit| hit.code.as_str()).collect();
    let base_reason = format!(
        "section={};kind={};turn={};triggers={}",
        plan.section.as_deref().unwrap_or("none"),
        snapshot.kind.as_str(),
        turn_bucket.as_str(),
        if codes.is_empty() {
            "none".to_string()
        } else {
            codes.join(",")
        }
    );
    let provenance = provenance_line(replay_family, snapshot.replay_id.as_str(), &label.model);
    let texts = pre_answer_texts(
        plan.lesson.as_deref(),
        label
            .book
            .as_ref()
            .and_then(|book| book.situation.as_deref()),
        &base_reason,
        &provenance,
    );

    let input = GateInput {
        snapshot,
        label: Some(label),
        answer: Some(&plan.answer),
        accepted: &plan.accepted,
        validated_reachable: true,
        facts,
        pre_answer_texts: &texts,
        config,
        confidence_cuts: &cuts.close_call,
    };
    if let Some(failure) = evaluate(&input) {
        return Err(failure);
    }

    Ok(Candidate {
        decision_id: snapshot.decision_id.clone(),
        replay_id: snapshot.replay_id.as_str().to_string(),
        replay_family: replay_family.to_string(),
        kyoku_index: snapshot.kyoku_index,
        event_index: snapshot.event_index,
        kind: snapshot.kind,
        turn,
        turn_bucket,
        decision_family: family_key,
        answer_source: plan.source,
        answer: plan.answer,
        accepted: plan.accepted,
        lesson: plan.lesson,
        book_section: plan.section,
        target_action: plan.target_action,
        label: LabelFacts::from_label(label, &snapshot.played.action),
        families: report.family_set(),
        triggers: report,
        exact_hash: exact_state_hash(&snapshot.state),
        visible_fingerprint: visible_info_fingerprint(snapshot),
        signals,
        score: 0.0,
    })
}

struct Queued {
    queue_id: String,
    candidate: Candidate,
    family: Option<Family>,
    rank: Option<usize>,
    held_out: bool,
}

/// Build the review items for the selected and held-out candidates.
///
/// Returns the items in queue order (selected first, then held-out) and the
/// decision ids that could not be found on the re-walk.
fn build_review_items(
    connection: &Connection,
    plan: &SelectionPlan,
    config: &SelectionConfig,
    created_at: &str,
    files: &[PathBuf],
) -> Result<(Vec<ReviewItem>, Vec<String>), SelectionError> {
    let mut queued: Vec<Queued> = Vec::new();
    let mut selected: Vec<&SelectedScenario> = plan.selected.iter().collect();
    selected.sort_by(|left, right| {
        family_order(left.family)
            .cmp(&family_order(right.family))
            .then_with(|| left.rank.cmp(&right.rank))
            .then_with(|| left.candidate.exact_hash.cmp(&right.candidate.exact_hash))
    });
    for (index, scenario) in selected.iter().enumerate() {
        let queue_id = format!("{}-{:03}", config.pack_id, index + 1);
        queued.push(Queued {
            queue_id,
            candidate: scenario.candidate.clone(),
            family: Some(scenario.family),
            rank: Some(scenario.rank),
            held_out: false,
        });
    }
    let mut held_out: Vec<&Candidate> = plan.held_out.iter().collect();
    held_out.sort_by(|left, right| {
        super::held_out_key(&config.held_out_salt, &left.exact_hash)
            .cmp(&super::held_out_key(
                &config.held_out_salt,
                &right.exact_hash,
            ))
            .then_with(|| left.exact_hash.cmp(&right.exact_hash))
    });
    for (index, candidate) in held_out.iter().enumerate() {
        queued.push(Queued {
            queue_id: format!("{}-qa-{:03}", config.pack_id, index + 1),
            candidate: (*candidate).clone(),
            family: None,
            rank: None,
            held_out: true,
        });
    }

    // Group the work by replay so every replay is walked at most once.
    let mut needed: BTreeMap<String, BTreeMap<String, usize>> = BTreeMap::new();
    for (index, item) in queued.iter().enumerate() {
        needed
            .entry(item.candidate.replay_id.clone())
            .or_default()
            .insert(item.candidate.decision_id.clone(), index);
    }

    let mut built: Vec<Option<ReviewItem>> = vec![None; queued.len()];
    for path in files {
        let walk = match walk_path(path) {
            Ok(walk) => walk,
            Err(err) => {
                return Err(SelectionError::Walk {
                    path: path.display().to_string(),
                    source: err,
                });
            }
        };
        let replay_id = walk.replay_id.as_str().to_string();
        let Some(wanted) = needed.get(&replay_id) else {
            continue;
        };
        for decision in &walk.decisions {
            let Some(index) = wanted.get(&decision.decision_id) else {
                continue;
            };
            let entry = &queued[*index];
            let hash = exact_state_hash(&decision.state);
            let label = load_label(connection, &decision.decision_id, &hash)
                .map_err(SelectionError::Trigger)?
                .ok_or_else(|| {
                    SelectionError::Review(format!(
                        "decision `{}` has no cached label for its review report",
                        decision.decision_id
                    ))
                })?;
            let reason = if entry.held_out {
                format!(
                    "held_out=qa;section={};kind={};turn={}",
                    entry.candidate.book_section.as_deref().unwrap_or("none"),
                    entry.candidate.kind.as_str(),
                    entry.candidate.turn_bucket.as_str()
                )
            } else {
                selection_reason(
                    entry.family.unwrap_or(Family::Book),
                    entry.candidate.book_section.as_deref(),
                    &entry.candidate,
                    entry.rank.unwrap_or(0),
                )
            };
            let review = build_review_report(
                decision,
                &entry.candidate,
                &label,
                &entry.queue_id,
                &reason,
                created_at,
            )?;
            built[*index] = Some(ReviewItem::new(
                entry.queue_id.clone(),
                config.pack_id.clone(),
                &entry.candidate,
                entry.family,
                entry.rank,
                entry.held_out,
                reason,
                review,
            ));
        }
    }

    let mut items = Vec::new();
    let mut missing = Vec::new();
    for (index, item) in built.into_iter().enumerate() {
        match item {
            Some(item) => items.push(item),
            None => missing.push(queued[index].candidate.decision_id.clone()),
        }
    }
    Ok((items, missing))
}

fn family_order(family: Family) -> usize {
    Family::ALL
        .iter()
        .position(|candidate| *candidate == family)
        .unwrap_or(usize::MAX)
}

fn build_review_report(
    snapshot: &DecisionSnapshot,
    candidate: &Candidate,
    label: &ModelLabel,
    queue_id: &str,
    reason: &str,
    created_at: &str,
) -> Result<crate::report::ScenarioReport, SelectionError> {
    let table = stamped_state(
        snapshot,
        candidate.answer_source,
        &candidate.answer,
        &candidate.accepted,
        candidate.lesson.as_deref(),
        candidate.target_action,
    );
    let note = format!(
        "curation: {reason}; {}; exact={}; visible={}",
        provenance_line(&candidate.replay_family, &candidate.replay_id, &label.model),
        &candidate.exact_hash[..candidate.exact_hash.len().min(12)],
        &candidate.visible_fingerprint[..candidate.visible_fingerprint.len().min(12)]
    );
    let ai = ReportedAi {
        model: label.model.clone(),
        evaluated_at: created_at.to_string(),
        evaluation: evaluation_from_label(label),
        comparison: None,
        peeked_before_answer: false,
    };
    build_report(BuildReportRequest {
        table,
        answer: reported_action(&candidate.answer),
        reason: ReportReason::Other,
        note: Some(note),
        created_at: created_at.to_string(),
        report_id: report_id(queue_id),
        commit: None,
        build_time: None,
        ai: Some(ai),
    })
    .map_err(SelectionError::Report)
}

fn evaluation_from_label(label: &ModelLabel) -> Evaluation {
    let evaluations: Vec<ActionEvaluation> = label
        .ranking
        .iter()
        .map(|ranked| ActionEvaluation {
            info: ActionInfo {
                action: ranked.action.clone(),
                label: ranked.label.clone(),
                kind: ranked.kind,
                tile_index: None,
                tile: ranked.tile.clone(),
                tiles: Vec::new(),
                kan_kind: None,
            },
            probability: ranked.probability,
            q_value: ranked.q_value,
        })
        .collect();
    Evaluation {
        model: label.model.clone(),
        expected_value: label.expected_value,
        recommended_action: label.top_action.clone(),
        riichi_discard: label.riichi_discard.clone(),
        evaluations,
    }
}

fn reported_action(answer: &CorrectAction) -> ReportedAction {
    match answer {
        CorrectAction::Riichi { discard } => {
            ReportedAction::new(CorrectActionType::Riichi, discard.clone())
        }
        CorrectAction::Dama { discard } => {
            ReportedAction::new(CorrectActionType::Dama, discard.clone())
        }
        CorrectAction::Fold { discard } => {
            ReportedAction::new(CorrectActionType::Fold, discard.clone())
        }
        CorrectAction::Kan { tile } => ReportedAction::new(CorrectActionType::Kan, tile.clone()),
        CorrectAction::Discard { tile } => {
            ReportedAction::new(CorrectActionType::Discard, tile.clone())
        }
        CorrectAction::Pass => ReportedAction::new(CorrectActionType::Pass, ""),
        CorrectAction::Best { action, tile, .. } => {
            ReportedAction::new(CorrectActionType::Best, tile.clone().unwrap_or_default())
                .with_action_name(action.clone())
        }
    }
}

fn report_id(queue_id: &str) -> String {
    let hash = sha256_hex(format!("riichiprac.review-report:{queue_id}").as_bytes());
    format!(
        "{}-{}-{}-{}-{}",
        &hash[0..8],
        &hash[8..12],
        &hash[12..16],
        &hash[16..20],
        &hash[20..32]
    )
}

fn rfc3339_now() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    crate::fuzz::format_rfc3339(now.as_secs() as i64, now.subsec_millis())
}

/// Write the queue, the held-out set, the report and the `LATEST` pointer.
fn write_outputs(outcome: &SelectionOutcome) -> Result<(), SelectionError> {
    let paths = &outcome.paths;
    std::fs::create_dir_all(&paths.dir).map_err(|source| io_error(&paths.dir, source))?;

    let queue = jsonl(&outcome.queue)?;
    write_atomic(&paths.queue, queue.as_bytes()).map_err(SelectionError::Storage)?;
    let held_out = jsonl(&outcome.held_out)?;
    write_atomic(&paths.held_out, held_out.as_bytes()).map_err(SelectionError::Storage)?;

    let report = serde_json::to_string_pretty(&outcome.report)?;
    write_atomic(&paths.report, report.as_bytes()).map_err(SelectionError::Storage)?;
    write_atomic(
        &paths.latest,
        format!("{}\n", outcome.report.pack_id).as_bytes(),
    )
    .map_err(SelectionError::Storage)?;
    Ok(())
}

fn jsonl<T: Serialize>(items: &[T]) -> Result<String, SelectionError> {
    let mut text = String::new();
    for item in items {
        text.push_str(&serde_json::to_string(item)?);
        text.push('\n');
    }
    Ok(text)
}
