//! P1b: assemble an audited pack from the selected, gated rows in the DB.
//!
//! The S2 selector and the V2 transform stage write their hand-off rows into
//! `selected_scenarios` (one row per selected base and per shipped variant) and
//! `variants` (the chain, seed and label-preservation verdict). This module is
//! the export side of that contract:
//!
//! ```text
//! selected_scenarios + variants + decisions + replays
//!         │  rebuild each PackScenario from the stored answer, chain and state
//!         ▼
//!   review gate (pending disposition / invalid embedded report refuses the pack)
//!         ▼
//!   dedupe → per-base cap → optional family quotas → byte budget
//!         ▼
//!   P1a encode + audit → packs/<pack-id>-<sha>.json.gz + manifest
//!         ▼
//!   packs / pack_scenarios rows + the assembly report
//! ```
//!
//! # What the DB stores, and what this module rebuilds
//!
//! A `selected_scenarios` row stores the decision it came from, the answer,
//! the accepted set, the lesson, the selection family and the provenance
//! document — not a second copy of the table. A base is rebuilt from the
//! walked `decisions.state_json`; a variant is rebuilt by applying the recorded
//! [`TransformChain`] to that base state. Both are then re-stamped through the
//! lesson's classifier (which re-derives the triggers, the situation note and
//! the answer set) and the result must agree with the stored answer and
//! accepted set: a disagreement is a corrupt/stale row, not something to paper
//! over. The P1a gate then re-checks reachability, legality, spoilers, variant
//! honesty and provenance on the rebuilt document.
//!
//! # Determinism
//!
//! The pack body is a pure function of the selected rows: the scenario order is
//! the base id order with each base's variants after it, the default
//! `generated_at` is the latest row's `created_at` (not the wall clock), and the
//! encoder already fixes the JSON field order and the gzip header. Running the
//! assembly twice over the same rows therefore produces the same SHA-256.
//!
//! # Limits
//!
//! - **Dedupe.** Two rebuilt scenarios with the same exact state hash collapse;
//!   the later one in pack order is dropped.
//! - **Per-base cap.** A base plus its variants is capped at
//!   `min(max_per_base, floor(max_pack_share * planned scenarios))` variants
//!   (§4.6, defaults 8 and 20 %). The base itself is counted in the report's
//!   `largest_base_share`.
//! - **Family quotas.** Optional explicit ceilings, counted in **base**
//!   scenarios (§4.6: quotas count bases, not variants). S2 already balanced
//!   the selection, so the default leaves the reviewed rows alone; an operator
//!   re-packing by hand can pass quotas here.
//! - **Byte budget.** A body over `PackBudget::max_bytes` (or a scenario count
//!   over `max_scenarios`) is refused, not silently trimmed: the operator
//!   splits the pack instead of shipping a different selection.
//!
//! # Operator contract
//!
//! ```text
//! mine_replays pack assemble [--pack ID] [--queue FILE] [--licence ID]
//!                           [--attribution TEXT] [--max-bytes N]
//!                           [--max-scenarios N] [--max-per-base N]
//!                           [--share F32]
//!                           [--family-quota book=30,coverage=15]
//!                           [--generated-at ISO] [--commit TEXT]
//!                           [--dry-run] [--json]
//! ```
//!
//! See [`run_assembly`](crate::miner::pack::run_assembly) and
//! `replay-miner-operations.md`.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

use crate::classifier;
use crate::generator::{SCENARIO_MANIFEST, ScenarioId, finalize_state};
use crate::miner::JSON_SCHEMA_VERSION;
use crate::miner::label::{CLASSIFIER_VERSION, ModelLabel};
use crate::miner::pack::audit::{AuditOptions, audit_pack_dir};
use crate::miner::pack::check::accepted_for;
use crate::miner::pack::gate::{PackAuditContext, audit_pack_encoded};
use crate::miner::pack::model::{
    LabelCheck, PACK_SCHEMA, PACK_VERSION, Pack, PackBook, PackGenerator, PackId, PackPlayed,
    PackProvenance, PackScenario, PackSource, PackValidation, PlayedKind, ScenarioKey,
};
use crate::miner::pack::write::{
    MANIFEST_FILE_NAME, encode_pack, merge_games, pack_file_name, publish_pack,
};
use crate::miner::pack::{PackBudget, PackError, PublishedPack};
use crate::miner::provenance::{GameProvenance, ReplayId, sha256_hex};
use crate::miner::select::dedupe::exact_state_hash;
use crate::miner::select::review::{read_dispositions, read_queue};
use crate::miner::select::run::latest_pack;
use crate::miner::select::{DispositionVerdict, selection_paths};
use crate::miner::storage::{DataRoot, open_miner_db, utc_iso8601, utc_stamp, write_atomic};
use crate::miner::transform::TransformChain;
use crate::miner::variant::base::prompt_for;
use crate::miner::variant::base::{counterfactual_block, mortal_block};
use crate::miner::variant::plan::families_of;
use crate::miner::variant::{DEFAULT_MAX_PER_BASE, DEFAULT_PACK_SHARE};
use crate::state::{CorrectAction, GameState, TargetAction};

/// Schema name of the assembly report.
pub const ASSEMBLY_SCHEMA: &str = "riichiprac.pack-assembly-report";

/// Version of the assembly report schema.
pub const ASSEMBLY_VERSION: u32 = JSON_SCHEMA_VERSION;

/// Default commit label recorded on a pack assembled from the DB.
pub const DEFAULT_GENERATOR_COMMIT: &str = "db";

/// The file name of the assembly report inside `reviews/<pack-id>/`.
pub const ASSEMBLY_REPORT_FILE_NAME: &str = "assembly-report.json";

/// Caps and optional family quotas.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AssemblyLimits {
    /// Maximum variants one base may contribute (§4.6).
    pub max_per_base: usize,
    /// Maximum share of the pack one base's variants may take (§4.6).
    pub max_pack_share: f32,
    /// Optional per-family ceilings, counted in base scenarios.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub family_quotas: BTreeMap<String, usize>,
    /// Optional ceiling on the whole pack's variants, spread evenly across the
    /// remaining pack order. `None` keeps every variant the per-base cap allows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_variants: Option<usize>,
    /// Drop every variant and ship the reviewed bases only. A product decision
    /// for a pack that gets its variety from real scenarios instead.
    #[serde(default, skip_serializing_if = "is_false")]
    pub variants_disabled: bool,
    /// Minimum number of bases a lesson needs to stay in the pack. A lesson with
    /// fewer real scenarios than this is dropped rather than repeating one
    /// position every time it is drawn.
    #[serde(default = "default_min_bases_per_lesson")]
    pub min_bases_per_lesson: usize,
}

const fn default_min_bases_per_lesson() -> usize {
    1
}

const fn is_false(value: &bool) -> bool {
    !*value
}

impl Default for AssemblyLimits {
    fn default() -> Self {
        Self {
            max_per_base: DEFAULT_MAX_PER_BASE,
            max_pack_share: DEFAULT_PACK_SHARE,
            family_quotas: BTreeMap::new(),
            max_variants: None,
            variants_disabled: false,
            min_bases_per_lesson: default_min_bases_per_lesson(),
        }
    }
}

impl AssemblyLimits {
    /// Reject a limit that cannot describe a pack.
    pub fn validate(&self) -> Result<(), String> {
        if self.max_per_base == 0 {
            return Err("`max_per_base` must be at least 1".to_string());
        }
        if !self.max_pack_share.is_finite()
            || !(self.max_pack_share > 0.0 && self.max_pack_share <= 1.0)
        {
            return Err(format!(
                "`max_pack_share` {} must be in (0.0, 1.0]",
                self.max_pack_share
            ));
        }
        for (family, quota) in &self.family_quotas {
            if family.trim().is_empty() {
                return Err("a family quota names an empty family".to_string());
            }
            if *quota == 0 {
                return Err(format!("family `{family}` has a zero quota"));
            }
        }
        if self.max_variants == Some(0) {
            return Err("`max_variants` must be at least one".to_string());
        }
        if self.min_bases_per_lesson == 0 {
            return Err("`min_bases_per_lesson` must be at least one".to_string());
        }
        Ok(())
    }

    /// How many variants one base may keep for a pack of `scenarios`.
    #[must_use]
    pub fn effective_variant_cap(&self, scenarios: usize) -> usize {
        let share = (self.max_pack_share * scenarios as f32).floor();
        let share_cap = if share.is_finite() && share >= 1.0 {
            share as usize
        } else {
            1
        };
        self.max_per_base.min(share_cap)
    }

    /// Parse `book=30,coverage=15` family ceilings for a CLI flag.
    pub fn parse_family_quotas(raw: &[String]) -> Result<BTreeMap<String, usize>, String> {
        let mut quotas = BTreeMap::new();
        for entry in raw {
            let (family, quota) = entry
                .split_once('=')
                .ok_or_else(|| format!("`{entry}` is not `<family>=<count>`"))?;
            let family = family.trim();
            if family.is_empty() {
                return Err(format!("`{entry}` names an empty family"));
            }
            let count: usize = quota
                .trim()
                .parse()
                .map_err(|_| format!("`{entry}` has no integer count"))?;
            if count == 0 {
                return Err(format!("`{entry}` must be at least one"));
            }
            quotas.insert(family.to_string(), count);
        }
        Ok(quotas)
    }
}

/// One assembly run's inputs.
#[derive(Debug, Clone)]
pub struct AssemblyOptions {
    /// Pack id to export. Defaults to the latest `select` run's pack id.
    pub pack_id: Option<String>,
    /// Review queue to check. Defaults to `reviews/<pack-id>/review-queue.jsonl`
    /// when it exists; an explicit path must exist.
    pub queue: Option<PathBuf>,
    /// Pack data licence. Defaults to the replays' shared licence.
    pub licence: Option<String>,
    /// Pack data attribution. Defaults to the replays' shared attribution.
    pub attribution: Option<String>,
    /// Generator commit label recorded on the pack (never a fake SHA).
    pub commit: String,
    /// ISO-8601 pack timestamp. Defaults to the latest selected row's
    /// `created_at`, so a re-assembly of the same rows hashes identically.
    pub generated_at: Option<String>,
    /// Caps and optional family quotas.
    pub limits: AssemblyLimits,
    /// Size and scenario-count ceilings.
    pub budget: PackBudget,
    /// Build, audit and report without publishing or recording anything.
    pub dry_run: bool,
}

impl Default for AssemblyOptions {
    fn default() -> Self {
        Self {
            pack_id: None,
            queue: None,
            licence: None,
            attribution: None,
            commit: DEFAULT_GENERATOR_COMMIT.to_string(),
            generated_at: None,
            limits: AssemblyLimits::default(),
            budget: PackBudget::default(),
            dry_run: false,
        }
    }
}

/// One family's share of the assembled pack.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FamilyMixRow {
    /// Selection family (`book`, `coverage`, ...) or the replay family when the
    /// row carried no selection family.
    pub family: String,
    /// Base scenarios in this family.
    pub bases: u64,
    /// Variants of those bases.
    pub variants: u64,
    /// `bases + variants`.
    pub scenarios: u64,
    /// Quota the assembly enforced for this family, when one was configured.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quota: Option<usize>,
}

/// Why one selected row did not reach the pack.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssemblyDrop {
    /// The `selected_scenarios.scenario_id` that was left out.
    pub scenario_id: String,
    /// Stable reason code.
    pub reason: String,
    /// Answer-free detail.
    pub detail: String,
}

/// What the review gate found.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewSummary {
    /// Whether a queue was found and checked.
    pub checked: bool,
    /// Non-held-out items in the queue.
    pub items: u64,
    /// Items a reviewer accepted.
    pub accepted: u64,
    /// Items a reviewer rejected.
    pub rejected: u64,
}

/// The pack assembly report (`riichiprac.pack-assembly-report` v1).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AssemblyReport {
    /// [`ASSEMBLY_SCHEMA`].
    pub schema: String,
    /// [`ASSEMBLY_VERSION`].
    pub version: u32,
    /// Pack id.
    pub pack_id: String,
    /// The pack's timestamp (the latest selected row's stamp by default).
    pub generated_at: String,
    /// `selected_scenarios` rows read for the pack.
    pub rows_read: u64,
    /// Base scenarios that reached the pack.
    pub bases: u64,
    /// Variants that reached the pack.
    pub variants: u64,
    /// `bases + variants`.
    pub scenarios: u64,
    /// Per-family mix, sorted by family.
    pub families: Vec<FamilyMixRow>,
    /// Rows left out, in pack order.
    pub dropped: Vec<AssemblyDrop>,
    /// Drop counts by reason code.
    pub drop_counts: BTreeMap<String, u64>,
    /// Variants as a share of the pack.
    pub variant_share: f64,
    /// The base with the most scenarios, when the pack ships variants.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub largest_base: Option<LargestBase>,
    /// The caps and quotas this run applied.
    pub limits: AssemblyLimits,
    /// Encoded body bytes.
    pub bytes: u64,
    /// The body ceiling.
    pub max_bytes: u64,
    /// The scenario ceiling.
    pub max_scenarios: usize,
    /// SHA-256 of the encoded body.
    pub sha256: String,
    /// Content-addressed body path, relative to the data root.
    pub export_path: String,
    /// Manifest path, relative to the data root.
    pub manifest_path: String,
    /// Pack data licence.
    pub licence: String,
    /// Whether the data grants commercial use.
    pub data_commercial_use: bool,
    /// Contributing agents, `"<id> (<engine> <version>, <licence>)"`, sorted.
    pub agents: Vec<String>,
    /// The review gate's outcome.
    pub review: ReviewSummary,
    /// Whether the published directory was re-audited.
    pub audited: bool,
    /// Whether that audit was clean.
    pub audit_clean: bool,
    /// Answer-free notes.
    pub notes: Vec<String>,
}

/// The base that occupies the largest share of the pack.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LargestBase {
    /// Base scenario id.
    pub base: String,
    /// Base plus its shipped variants.
    pub scenarios: u64,
    /// `scenarios / pack scenarios`.
    pub share: f64,
}

impl AssemblyReport {
    /// Render the report as report-style text lines.
    #[must_use]
    pub fn human_summary(&self) -> String {
        let mut lines = vec![
            format!(
                "{}: {} scenario(s) from {} selected row(s), {} / {} bytes",
                self.pack_id, self.scenarios, self.rows_read, self.bytes, self.max_bytes
            ),
            format!(
                "  generated {}; sha256 {}",
                self.generated_at,
                &self.sha256[..self.sha256.len().min(16)]
            ),
            format!(
                "  bases {} + variants {} ({:.0}%); licence {} (commercial: {})",
                self.bases,
                self.variants,
                self.variant_share * 100.0,
                self.licence,
                self.data_commercial_use
            ),
        ];
        if let Some(base) = &self.largest_base {
            lines.push(format!(
                "  largest base {}: {} scenario(s) ({:.0}%)",
                base.base,
                base.scenarios,
                base.share * 100.0
            ));
        }
        let mix: Vec<String> = self
            .families
            .iter()
            .map(|family| {
                let quota = family
                    .quota
                    .map_or_else(String::new, |quota| format!("/{quota}"));
                format!("{}{} ({})", family.family, quota, family.scenarios)
            })
            .collect();
        lines.push(format!("  families: {}", mix.join(", ")));
        if !self.drop_counts.is_empty() {
            let drops: Vec<String> = self
                .drop_counts
                .iter()
                .map(|(reason, count)| format!("{reason}={count}"))
                .collect();
            lines.push(format!("  dropped: {}", drops.join(", ")));
        }
        lines.push(format!(
            "  review: {}; audit: {}",
            if self.review.checked {
                format!(
                    "{} item(s), {} accepted, {} rejected",
                    self.review.items, self.review.accepted, self.review.rejected
                )
            } else {
                "not checked".to_string()
            },
            if !self.audited {
                "not run".to_string()
            } else if self.audit_clean {
                "clean".to_string()
            } else {
                "dirty".to_string()
            }
        ));
        lines.push(format!("  export: {}", self.export_path));
        lines.join("\n")
    }
}

/// What one assembly run produced.
#[derive(Debug)]
pub struct AssemblyOutcome {
    /// The assembled pack.
    pub pack: Pack,
    /// The machine-readable report.
    pub report: AssemblyReport,
    /// The published body and manifest entry, unless `--dry-run`.
    pub published: Option<PublishedPack>,
    /// Where the report was written (`None` on a dry run).
    pub report_path: Option<PathBuf>,
    /// Whether the export (body, manifest, DB rows, report) was written.
    pub written: bool,
}

/// Assemble, audit, publish and record one pack.
pub fn run_assembly(
    root: &DataRoot,
    options: &AssemblyOptions,
) -> Result<AssemblyOutcome, PackError> {
    options
        .limits
        .validate()
        .map_err(|detail| PackError::Assembly {
            pack_id: "unknown".to_string(),
            detail,
        })?;

    let pack_id = resolve_pack_id(root, options.pack_id.as_deref())?;
    let connection = open_miner_db(root)?;
    let rows = load_rows(&connection, &pack_id)?;
    if rows.is_empty() {
        return Err(PackError::Assembly {
            pack_id,
            detail: "no `selected_scenarios` row carries this pack id; run `select` and \
                     `transform` first"
                .to_string(),
        });
    }

    let mut review = ReviewSummary::default();
    let mut accepted: Option<BTreeSet<String>> = None;
    let mut rejected: BTreeSet<String> = BTreeSet::new();
    if let Some(queue_path) = resolve_queue(root, &pack_id, options.queue.as_deref())? {
        let gate = review_gate(&queue_path, &pack_id)?;
        review = gate.summary;
        accepted = Some(gate.accepted);
        rejected = gate.rejected;
    }

    let variants = load_variant_gates(&connection, &pack_id)?;
    let mut drops: Vec<AssemblyDrop> = Vec::new();
    let mut groups = build_groups(
        &pack_id,
        &rows,
        &variants,
        accepted.as_ref(),
        &rejected,
        &mut drops,
    )?;
    apply_dedupe_and_caps(&mut groups, options, &mut drops);
    order_groups_for_pack(&mut groups);

    // Bases first, then variants. The picker deals in body order, so keeping
    // every base ahead of its (and every other base's) variant means a learner
    // sees the distinct positions before the relabelled repeats. The order is
    // still deterministic: bases in base-id order, variants in the same order.
    let mut scenarios: Vec<PackScenario> = Vec::new();
    for group in &groups {
        if let Some(base) = &group.base {
            scenarios.push(base.scenario.clone());
        }
    }
    for group in &groups {
        for variant in &group.variants {
            scenarios.push(variant.scenario.clone());
        }
    }
    if scenarios.is_empty() {
        return Err(PackError::Assembly {
            pack_id,
            detail: format!(
                "every selected row was dropped ({} drop(s)); see the assembly report",
                drops.len()
            ),
        });
    }

    let replay_ids: BTreeSet<&ReplayId> = scenarios
        .iter()
        .map(|scenario| &scenario.provenance.replay_id)
        .collect();
    let games = games_for(&rows, &replay_ids)?;
    let (licence, attribution) = pack_copy(&pack_id, &rows, &replay_ids, options)?;
    let source = PackSource::from_games(&games, licence, attribution, true).ok_or_else(|| {
        PackError::Assembly {
            pack_id: pack_id.clone(),
            detail: "the packed scenarios name no contributing game, or their games disagree \
                     about the corpus"
                .to_string(),
        }
    })?;

    let generated_at = options
        .generated_at
        .clone()
        .unwrap_or_else(|| latest_stamp(&rows));
    if !is_iso_timestamp(&generated_at) {
        return Err(PackError::Assembly {
            pack_id,
            detail: format!(
                "`generated_at` `{generated_at}` is not an ISO-8601 UTC timestamp \
                 (`YYYY-MM-DDTHH:MM:SSZ`)"
            ),
        });
    }

    let pack = Pack {
        schema: PACK_SCHEMA.to_string(),
        version: PACK_VERSION,
        pack_id: PackId::parse(&pack_id).map_err(|err| PackError::Assembly {
            pack_id: pack_id.clone(),
            detail: format!("pack id: {err}"),
        })?,
        generated_at,
        generator: PackGenerator::mine_replays(options.commit.clone(), CLASSIFIER_VERSION),
        source,
        scenarios,
    };
    pack.validate()?;

    let encoded = encode_pack(&pack)?;
    if pack.scenarios.len() > options.budget.max_scenarios {
        return Err(PackError::Assembly {
            pack_id,
            detail: format!(
                "the pack has {} scenarios, over the {} scenario ceiling; split the pack",
                pack.scenarios.len(),
                options.budget.max_scenarios
            ),
        });
    }
    if encoded.len() > options.budget.max_bytes {
        return Err(PackError::Assembly {
            pack_id,
            detail: format!(
                "the pack body is {} bytes, over the {} byte ceiling; split the pack",
                encoded.len(),
                options.budget.max_bytes
            ),
        });
    }
    let context = PackAuditContext::new(&games).with_budget(options.budget);
    let audit = audit_pack_encoded(&pack, &context, &encoded)?;
    if !audit.is_clean() {
        return Err(PackError::AuditFailed(Box::new(audit)));
    }

    let file_name = pack_file_name(&pack.pack_id, &encoded.sha256)?;
    let body_path = root.packs_dir().join(&file_name);
    let existed = body_path.exists();
    let export_path = root.relative_path(&body_path)?;
    let manifest_path = root.relative_path(&root.packs_dir().join(MANIFEST_FILE_NAME))?;

    let mut report = build_report(
        &pack,
        &groups,
        &drops,
        &review,
        options,
        rows.len() as u64,
        &encoded,
        &export_path,
        &manifest_path,
    );

    let mut published = None;
    let mut report_path = None;
    let mut written = false;
    if !options.dry_run {
        merge_games(&root.packs_dir(), &games)?;
        published = Some(publish_pack(
            &root.packs_dir(),
            &pack,
            &context,
            &utc_iso8601(SystemTime::now()),
        )?);
        let published = published.as_ref().expect("just published");
        if let Err(error) = record_pack(
            &connection,
            &pack,
            published,
            &groups,
            &report,
            &export_path,
            &manifest_path,
        ) {
            if !existed {
                // Do not leave a body the DB does not know about.
                let _ = fs::remove_file(&published.path);
            }
            return Err(error);
        }

        let audit = audit_pack_dir(&root.packs_dir(), None, &AuditOptions::default())?;
        let own_clean = audit
            .packs
            .iter()
            .find(|audit| audit.pack_id == pack.pack_id.as_str())
            .is_some_and(|audit| audit.is_clean());
        report.audited = true;
        report.audit_clean = own_clean;
        let path = selection_paths(root, &pack_id)
            .dir
            .join(ASSEMBLY_REPORT_FILE_NAME);
        let json = serde_json::to_vec_pretty(&report).map_err(|source| PackError::Json {
            path: path.display().to_string(),
            source,
        })?;
        write_atomic(&path, &json)?;
        report_path = Some(path);
        written = true;
        if !own_clean {
            return Err(PackError::Assembly {
                pack_id,
                detail: "the published directory failed its re-audit; see the assembly report"
                    .to_string(),
            });
        }
    }

    Ok(AssemblyOutcome {
        pack,
        report,
        published,
        report_path,
        written,
    })
}

fn resolve_pack_id(root: &DataRoot, explicit: Option<&str>) -> Result<String, PackError> {
    if let Some(pack_id) = explicit {
        return Ok(pack_id.to_string());
    }
    latest_pack(root)
        .map_err(|err| PackError::Assembly {
            pack_id: "unknown".to_string(),
            detail: err.to_string(),
        })?
        .ok_or_else(|| PackError::Assembly {
            pack_id: "unknown".to_string(),
            detail: "no pack id given and no `select` run found; pass `--pack`".to_string(),
        })
}

fn resolve_queue(
    root: &DataRoot,
    pack_id: &str,
    explicit: Option<&Path>,
) -> Result<Option<PathBuf>, PackError> {
    if let Some(path) = explicit {
        if !path.exists() {
            return Err(PackError::Review {
                path: path.display().to_string(),
                detail: "the queue file does not exist".to_string(),
            });
        }
        return Ok(Some(path.to_path_buf()));
    }
    let path = selection_paths(root, pack_id).queue;
    Ok(path.exists().then_some(path))
}

// ---------------------------------------------------------------------------
// The review gate.
// ---------------------------------------------------------------------------

struct ReviewGate {
    summary: ReviewSummary,
    accepted: BTreeSet<String>,
    rejected: BTreeSet<String>,
}

/// Every non-held-out queue item needs a verdict, its embedded report must
/// parse, and the queue must belong to this pack.
fn review_gate(path: &Path, pack_id: &str) -> Result<ReviewGate, PackError> {
    let review_err = |detail: String| PackError::Review {
        path: path.display().to_string(),
        detail,
    };
    let queue = read_queue(path).map_err(|err| review_err(err.to_string()))?;
    let dispositions =
        read_dispositions(&queue.dispositions_path()).map_err(|err| review_err(err.to_string()))?;
    let latest: BTreeMap<&str, DispositionVerdict> = dispositions
        .iter()
        .map(|disposition| (disposition.queue_id.as_str(), disposition.verdict))
        .collect();

    let mut summary = ReviewSummary {
        checked: true,
        ..ReviewSummary::default()
    };
    let mut accepted = BTreeSet::new();
    let mut rejected = BTreeSet::new();
    let mut pending: Vec<String> = Vec::new();
    let mut invalid: Vec<String> = Vec::new();
    for item in &queue.items {
        if item.held_out {
            continue;
        }
        if item.pack_id != pack_id {
            return Err(review_err(format!(
                "the queue belongs to pack `{}`, not `{pack_id}`",
                item.pack_id
            )));
        }
        summary.items += 1;
        if let Err(err) = validate_report(item) {
            invalid.push(format!("{}: {err}", item.queue_id));
        }
        match latest.get(item.queue_id.as_str()) {
            Some(DispositionVerdict::Accepted) => {
                summary.accepted += 1;
                accepted.insert(item.queue_id.clone());
            }
            Some(DispositionVerdict::Rejected) => {
                summary.rejected += 1;
                rejected.insert(item.queue_id.clone());
            }
            None => pending.push(item.queue_id.clone()),
        }
    }
    if !invalid.is_empty() {
        return Err(review_err(format!(
            "{} item(s) carry an invalid embedded report: {}",
            invalid.len(),
            preview(&invalid)
        )));
    }
    if !pending.is_empty() {
        return Err(review_err(format!(
            "{} item(s) have no disposition yet: {}",
            pending.len(),
            preview(&pending)
        )));
    }
    Ok(ReviewGate {
        summary,
        accepted,
        rejected,
    })
}

fn validate_report(item: &crate::miner::select::ReviewItem) -> Result<(), String> {
    let json = serde_json::to_string(&item.review).map_err(|err| err.to_string())?;
    crate::report::parse_report(&json)
        .map(|_| ())
        .map_err(|err| err.to_string())
}

fn preview(ids: &[String]) -> String {
    const MAX: usize = 5;
    let mut text = ids.iter().take(MAX).cloned().collect::<Vec<_>>().join(", ");
    if ids.len() > MAX {
        text.push_str(&format!(", … ({} more)", ids.len() - MAX));
    }
    text
}

// ---------------------------------------------------------------------------
// Reading the selection.
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct SelectedRow {
    scenario_id: String,
    lesson_id: String,
    selection_family: String,
    correct_action: String,
    accepted: String,
    variant_of: Option<String>,
    provenance: String,
    created_at: String,
    replay_id: String,
    event_index: i64,
    seat: i64,
    turn: i64,
    state_json: String,
    played_action: Option<String>,
    label_json: Option<String>,
    licence: String,
    attribution: String,
    provenance_json: String,
}
fn load_rows(connection: &Connection, pack_id: &str) -> Result<Vec<SelectedRow>, PackError> {
    let missing: i64 = connection.query_row(
        "SELECT COUNT(*) FROM selected_scenarios s
         LEFT JOIN decisions d ON d.decision_id = s.decision_id
         LEFT JOIN replays r ON r.replay_id = d.replay_id
         WHERE s.pack_id = ?1 AND (d.decision_id IS NULL OR r.replay_id IS NULL)",
        params![pack_id],
        |row| row.get(0),
    )?;
    if missing > 0 {
        return Err(PackError::Assembly {
            pack_id: pack_id.to_string(),
            detail: format!(
                "{missing} selected row(s) reference a decision or replay that is not in the DB"
            ),
        });
    }

    let mut statement = connection.prepare(
        "SELECT s.scenario_id, s.lesson_id, s.selection_family, s.correct_action,
                s.accepted, s.variant_of, s.provenance, s.created_at,
                d.replay_id, d.event_index, d.seat, d.turn, d.state_json, d.played_action,
                d.label_json, r.licence, r.attribution, r.provenance_json
         FROM selected_scenarios s
         JOIN decisions d ON d.decision_id = s.decision_id
         JOIN replays r ON r.replay_id = d.replay_id
         WHERE s.pack_id = ?1
         ORDER BY s.scenario_id",
    )?;
    let rows = statement.query_map(params![pack_id], |row| {
        Ok(SelectedRow {
            scenario_id: row.get(0)?,
            lesson_id: row.get(1)?,
            selection_family: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
            correct_action: row.get(3)?,
            accepted: row.get(4)?,
            variant_of: row.get(5)?,
            provenance: row.get(6)?,
            created_at: row.get(7)?,
            replay_id: row.get(8)?,
            event_index: row.get(9)?,
            seat: row.get(10)?,
            turn: row.get(11)?,
            state_json: row.get(12)?,
            played_action: row.get(13)?,
            label_json: row.get(14)?,
            licence: row.get(15)?,
            attribution: row.get(16)?,
            provenance_json: row.get(17)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

struct VariantGate {
    chain: TransformChain,
    seed: String,
    label_check: LabelCheck,
}

fn load_variant_gates(
    connection: &Connection,
    pack_id: &str,
) -> Result<BTreeMap<String, VariantGate>, PackError> {
    let mut statement = connection.prepare(
        "SELECT v.variant_id, v.transform_chain, v.transform_seed, v.label_preserved,
                s.label_check
         FROM variants v
         JOIN selected_scenarios s ON s.scenario_id = v.variant_id
         WHERE s.pack_id = ?1",
    )?;
    let rows = statement.query_map(params![pack_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, Option<String>>(4)?,
        ))
    })?;
    let mut gates = BTreeMap::new();
    for row in rows {
        let (id, chain_json, seed, preserved, label_check) = row?;
        if preserved != 1 {
            return Err(PackError::Assembly {
                pack_id: pack_id.to_string(),
                detail: format!(
                    "variant `{id}` is recorded as failing its label-preservation gate; it must \
                     not ship"
                ),
            });
        }
        let chain: TransformChain =
            serde_json::from_str(&chain_json).map_err(|source| PackError::Json {
                path: format!("variants/{id}/transform_chain"),
                source,
            })?;
        chain.validate().map_err(|err| PackError::Assembly {
            pack_id: pack_id.to_string(),
            detail: format!("variant `{id}` records an invalid transform chain: {err}"),
        })?;
        if chain.transform_seed != seed {
            return Err(PackError::Assembly {
                pack_id: pack_id.to_string(),
                detail: format!(
                    "variant `{id}` records seed `{seed}` but its chain names `{}`",
                    chain.transform_seed
                ),
            });
        }
        let label_check_json = label_check.ok_or_else(|| PackError::Assembly {
            pack_id: pack_id.to_string(),
            detail: format!("variant `{id}` has no label-preservation record"),
        })?;
        let label_check: LabelCheck =
            serde_json::from_str(&label_check_json).map_err(|source| PackError::Json {
                path: format!("selected_scenarios/{id}/label_check"),
                source,
            })?;
        if !label_check.preserved {
            return Err(PackError::Assembly {
                pack_id: pack_id.to_string(),
                detail: format!("variant `{id}` failed its label-preservation check"),
            });
        }
        gates.insert(
            id,
            VariantGate {
                chain,
                seed,
                label_check,
            },
        );
    }
    Ok(gates)
}

/// A rebuilt scenario plus the bookkeeping the report needs.
struct Assembled {
    scenario: PackScenario,
    state_hash: String,
    family: String,
}

struct BaseGroup {
    base_id: String,
    base: Option<Assembled>,
    variants: Vec<Assembled>,
}

fn build_groups(
    pack_id: &str,
    rows: &[SelectedRow],
    variants: &BTreeMap<String, VariantGate>,
    accepted: Option<&BTreeSet<String>>,
    rejected: &BTreeSet<String>,
    drops: &mut Vec<AssemblyDrop>,
) -> Result<Vec<BaseGroup>, PackError> {
    let mut groups: Vec<BaseGroup> = Vec::new();
    let mut by_id: BTreeMap<&str, SelectedRow> = BTreeMap::new();
    for row in rows.iter().filter(|row| row.variant_of.is_none()) {
        by_id.insert(row.scenario_id.as_str(), row.clone());
    }

    for row in rows.iter().filter(|row| row.variant_of.is_none()) {
        let family = selection_family(row, None);
        if rejected.contains(&row.scenario_id) {
            drops.push(AssemblyDrop {
                scenario_id: row.scenario_id.clone(),
                reason: "reviewer_rejected".to_string(),
                detail: "a reviewer rejected this item".to_string(),
            });
            groups.push(BaseGroup {
                base_id: row.scenario_id.clone(),
                base: None,
                variants: Vec::new(),
            });
            continue;
        }
        if let Some(accepted) = accepted
            && !accepted.contains(&row.scenario_id)
        {
            return Err(PackError::Assembly {
                pack_id: pack_id.to_string(),
                detail: format!(
                    "selected base `{}` is not in the review queue; the row is unreviewed",
                    row.scenario_id
                ),
            });
        }
        let base = rebuild_base(row, &family).map_err(|err| row_error(pack_id, err))?;
        groups.push(BaseGroup {
            base_id: row.scenario_id.clone(),
            base: Some(base),
            variants: Vec::new(),
        });
    }

    for row in rows.iter().filter(|row| row.variant_of.is_some()) {
        let base_id = row.variant_of.clone().expect("filtered");
        let Some(base_row) = by_id.get(base_id.as_str()) else {
            return Err(PackError::Assembly {
                pack_id: pack_id.to_string(),
                detail: format!(
                    "variant `{}` names base `{base_id}`, which is not a selected base of this pack",
                    row.scenario_id
                ),
            });
        };
        let Some(group) = groups.iter_mut().find(|group| group.base_id == base_id) else {
            return Err(PackError::Assembly {
                pack_id: pack_id.to_string(),
                detail: format!("variant `{}` has no base group", row.scenario_id),
            });
        };
        if group.base.is_none() {
            drops.push(AssemblyDrop {
                scenario_id: row.scenario_id.clone(),
                reason: "base_dropped".to_string(),
                detail: format!("its base `{base_id}` was not packed"),
            });
            continue;
        }
        let gate = variants
            .get(&row.scenario_id)
            .ok_or_else(|| PackError::Assembly {
                pack_id: pack_id.to_string(),
                detail: format!(
                    "variant `{}` has no `variants` row; only a gated variant may ship",
                    row.scenario_id
                ),
            })?;
        let family = selection_family(row, Some(base_row));
        let built =
            rebuild_variant(row, base_row, gate, &family).map_err(|err| row_error(pack_id, err))?;
        group.variants.push(built);
    }

    Ok(groups)
}

fn selection_family(row: &SelectedRow, base: Option<&SelectedRow>) -> String {
    let candidate = if row.selection_family.trim().is_empty() {
        base.map(|base| base.selection_family.as_str())
            .unwrap_or("")
    } else {
        row.selection_family.as_str()
    };
    if candidate.trim().is_empty() {
        "unknown".to_string()
    } else {
        candidate.to_string()
    }
}

// ---------------------------------------------------------------------------
// Rebuilding one scenario.
// ---------------------------------------------------------------------------

/// A selected row that cannot be rebuilt. `run_assembly` attaches the pack id;
/// the row is the useful identity while rebuilding.
#[derive(Debug)]
struct RowError {
    scenario_id: String,
    detail: String,
}

impl RowError {
    fn new(scenario_id: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            scenario_id: scenario_id.into(),
            detail: detail.into(),
        }
    }
}

fn row_error(pack_id: &str, error: RowError) -> PackError {
    PackError::Assembly {
        pack_id: pack_id.to_string(),
        detail: format!("scenario `{}`: {}", error.scenario_id, error.detail),
    }
}

fn parse_state(row: &SelectedRow) -> Result<GameState, RowError> {
    serde_json::from_str(&row.state_json).map_err(|source| {
        RowError::new(
            &row.scenario_id,
            format!("cannot parse the decision's state: {source}"),
        )
    })
}

fn parse_answer(row: &SelectedRow) -> Result<(CorrectAction, Vec<String>), RowError> {
    let answer: CorrectAction = serde_json::from_str(&row.correct_action).map_err(|source| {
        RowError::new(
            &row.scenario_id,
            format!("cannot parse `correct_action`: {source}"),
        )
    })?;
    let accepted: Vec<String> = serde_json::from_str(&row.accepted).map_err(|source| {
        RowError::new(
            &row.scenario_id,
            format!("cannot parse `accepted`: {source}"),
        )
    })?;
    Ok((answer, accepted))
}

fn parse_provenance(row: &SelectedRow) -> Result<PackProvenance, RowError> {
    serde_json::from_str(&row.provenance).map_err(|source| {
        RowError::new(
            &row.scenario_id,
            format!("cannot parse `provenance`: {source}"),
        )
    })
}

fn rebuild_base(row: &SelectedRow, family: &str) -> Result<Assembled, RowError> {
    let state = parse_state(row)?;
    let (answer, accepted) = parse_answer(row)?;
    let stamped = stamp_state(state, &row.lesson_id, &answer, &accepted, row)?;
    let mut provenance = parse_provenance(row)?;
    normalise_provenance(&mut provenance, row, &stamped, None)?;
    let scenario = scenario_from(row, stamped, answer, accepted, provenance)?;
    let state_hash = exact_state_hash(&scenario.state);
    Ok(Assembled {
        scenario,
        state_hash,
        family: family.to_string(),
    })
}

fn rebuild_variant(
    row: &SelectedRow,
    base: &SelectedRow,
    gate: &VariantGate,
    family: &str,
) -> Result<Assembled, RowError> {
    let base_state = parse_state(base)?;
    let (base_answer, base_accepted) = parse_answer(base)?;
    let stamped_base = stamp_state(
        base_state,
        &base.lesson_id,
        &base_answer,
        &base_accepted,
        base,
    )?;
    let applied = gate.chain.apply(&stamped_base).map_err(|err| {
        RowError::new(
            &row.scenario_id,
            format!("the recorded transform chain no longer applies: {err}"),
        )
    })?;

    let (answer, accepted) = parse_answer(row)?;
    let stamped = stamp_state(applied.state, &row.lesson_id, &answer, &accepted, row)?;
    let mut provenance = parse_provenance(row)?;
    normalise_provenance(&mut provenance, row, &stamped, Some((base, gate)))?;
    let mut scenario = scenario_from(row, stamped, answer, accepted, provenance)?;
    // The recorded chain is authoritative: the pack gate re-checks that the
    // transform list and seed match it.
    scenario.provenance.transform_chain = Some(gate.chain.clone());
    scenario.provenance.transform_seed = Some(gate.seed.clone());
    scenario.provenance.label_check = Some(gate.label_check.clone());
    if let Some(played) = &mut scenario.played
        && let Ok(mapped) = gate.chain.map_action_name(&played.action)
    {
        played.action = mapped;
    }
    scenario.validation = PackValidation {
        state_valid: true,
        replay_roundtrip: false,
        answer_recomputed: true,
        visible_info_only: true,
    };
    let state_hash = exact_state_hash(&scenario.state);
    Ok(Assembled {
        scenario,
        state_hash,
        family: family.to_string(),
    })
}

/// Stamp the stored answer back onto a rebuilt state.
///
/// A registered lesson is re-classified, which re-derives the situation note,
/// triggers and answer set; the result must agree with the stored answer and
/// accepted set or the row is stale and the pack is refused. A Mortal-only
/// lesson (`mortal_best`) has no classifier, so the stored answer is stamped
/// and the target action is derived from the action kind.
fn stamp_state(
    state: GameState,
    lesson: &str,
    stored: &CorrectAction,
    accepted: &[String],
    row: &SelectedRow,
) -> Result<GameState, RowError> {
    let state = finalize_state(state);
    let stamped = match ScenarioId::from_id(lesson) {
        Some(id) => {
            let matched = classifier::classify(&state, id).ok_or_else(|| {
                RowError::new(
                    &row.scenario_id,
                    format!("lesson `{lesson}` no longer classifies the rebuilt state"),
                )
            })?;
            let value = matched.stamp(state);
            if &value.correct_action != stored {
                return Err(RowError::new(
                    &row.scenario_id,
                    format!(
                        "lesson `{lesson}` re-derives `{:?}`, but the row stores `{stored:?}`",
                        value.correct_action
                    ),
                ));
            }
            value
        }
        None => plain_stamp(state, lesson, stored, accepted),
    };
    let canonical = accepted_for(&stamped);
    if canonical != accepted {
        return Err(RowError::new(
            &row.scenario_id,
            format!("`accepted` is {accepted:?}, but the rebuilt state grades {canonical:?}"),
        ));
    }
    Ok(stamped)
}

fn plain_stamp(
    mut state: GameState,
    lesson: &str,
    answer: &CorrectAction,
    accepted: &[String],
) -> GameState {
    state.category = lesson.to_string();
    state.target_action = target_for(answer);
    state.correct_action = answer.clone();
    let named = answer.tile();
    state.equivalent_tiles = accepted
        .iter()
        .filter(|tile| Some(tile.as_str()) != named)
        .cloned()
        .collect();
    state.ai_decision = None;
    state.riichi_triggers.clear();
    state.dama_reasons.clear();
    state.shouminkan_triggers.clear();
    state.scenario_note = None;
    finalize_state(state)
}

fn target_for(answer: &CorrectAction) -> TargetAction {
    match answer {
        CorrectAction::Riichi { .. } => TargetAction::Riichi,
        CorrectAction::Dama { .. } => TargetAction::Dama,
        CorrectAction::Fold { .. } => TargetAction::Fold,
        CorrectAction::Kan { .. } => TargetAction::Kan,
        CorrectAction::Discard { .. } => TargetAction::Defend,
        CorrectAction::Pass => TargetAction::Call,
        CorrectAction::Best { .. } => TargetAction::Best,
    }
}

fn normalise_provenance(
    provenance: &mut PackProvenance,
    row: &SelectedRow,
    state: &GameState,
    variant: Option<(&SelectedRow, &VariantGate)>,
) -> Result<(), RowError> {
    let declared = provenance.replay_id.as_str().to_string();
    if declared != row.replay_id {
        return Err(RowError::new(
            &row.scenario_id,
            format!(
                "`provenance.replay_id` is `{declared}` but the decision belongs to `{}`",
                row.replay_id
            ),
        ));
    }
    provenance.decision_index = u64::try_from(row.event_index).unwrap_or(0);
    provenance.kyoku = Some(kyoku_label(state));
    provenance.honba = Some(state.honba);
    provenance.turn = u8::try_from(row.turn).ok();
    match variant {
        None => {
            if provenance.is_variant() {
                return Err(RowError::new(
                    &row.scenario_id,
                    "a base scenario carries variant provenance",
                ));
            }
            provenance.transforms.clear();
            provenance.transform_seed = None;
            provenance.variant_of = None;
            provenance.transform_chain = None;
            provenance.label_check = None;
        }
        Some((base, gate)) => {
            if let Some(recorded) = &provenance.variant_of
                && recorded.as_str() != base.scenario_id
            {
                return Err(RowError::new(
                    &row.scenario_id,
                    format!(
                        "`variant_of` is `{recorded}` but the row says `{}`",
                        base.scenario_id
                    ),
                ));
            }
            if let Some(chain) = &provenance.transform_chain
                && chain.fingerprint() != gate.chain.fingerprint()
            {
                return Err(RowError::new(
                    &row.scenario_id,
                    "the stored provenance chain differs from the `variants` chain",
                ));
            }
            if let Some(seed) = &provenance.transform_seed
                && seed != &gate.seed
            {
                return Err(RowError::new(
                    &row.scenario_id,
                    format!(
                        "`provenance.transform_seed` is `{seed}`, the chain names `{}`",
                        gate.seed
                    ),
                ));
            }
            provenance.variant_of = Some(ScenarioKey::parse(&base.scenario_id).map_err(|err| {
                RowError::new(&row.scenario_id, format!("base scenario id: {err}"))
            })?);
            provenance.transforms = families_of(&gate.chain)
                .into_iter()
                .map(|family| family.to_string())
                .collect();
            provenance.transform_seed = Some(gate.seed.clone());
            provenance.transform_chain = Some(gate.chain.clone());
            provenance.label_check = Some(gate.label_check.clone());
        }
    }
    Ok(())
}

fn kyoku_label(state: &GameState) -> String {
    let round = match state.round_wind {
        crate::state::Wind::East => 'E',
        crate::state::Wind::South => 'S',
        crate::state::Wind::West => 'W',
        crate::state::Wind::North => 'N',
    };
    format!("{round}{}", state.hand_number.saturating_add(1))
}

/// The acting seat's agent id, for the `played` action's attribution.
fn agent_for(row: &SelectedRow) -> Option<String> {
    let game: GameProvenance = serde_json::from_str(&row.provenance_json).ok()?;
    let seat = usize::try_from(row.seat).ok()?;
    game.seats.get(seat).map(|seat| seat.agent_id.clone())
}

fn scenario_from(
    row: &SelectedRow,
    state: GameState,
    answer: CorrectAction,
    accepted: Vec<String>,
    provenance: PackProvenance,
) -> Result<PackScenario, RowError> {
    let meta = ScenarioId::from_id(&row.lesson_id)
        .and_then(|id| SCENARIO_MANIFEST.iter().find(|meta| meta.id == id));
    let book = meta.and_then(|meta| {
        meta.book.map(|book| PackBook {
            chapter: book.chapter,
            section: book.section,
            key: book.key(),
            label: book.label(),
        })
    });
    let title = meta.map_or_else(
        || "Model best action".to_string(),
        |meta| meta.label.to_string(),
    );
    let prompt = prompt_for(state.target_action).to_string();
    let label = row
        .label_json
        .as_deref()
        .and_then(|json| serde_json::from_str::<ModelLabel>(json).ok());
    let played = row.played_action.as_ref().map(|action| PackPlayed {
        kind: PlayedKind::Ai,
        agent: agent_for(row),
        action: action.clone(),
        mortal_probability: label.as_ref().and_then(|label| {
            label
                .ranking
                .iter()
                .find(|ranked| ranked.action == *action)
                .map(|ranked| ranked.probability)
        }),
    });
    let id = ScenarioKey::parse(&row.scenario_id)
        .map_err(|err| RowError::new(&row.scenario_id, format!("scenario id: {err}")))?;
    Ok(PackScenario {
        id,
        lesson_id: row.lesson_id.clone(),
        book,
        title,
        prompt,
        correct_action: answer,
        accepted,
        state,
        mortal: label.as_ref().map(mortal_block),
        counterfactual: label.as_ref().map(counterfactual_block),
        played,
        interestingness: None,
        provenance,
        validation: PackValidation {
            state_valid: true,
            replay_roundtrip: true,
            answer_recomputed: true,
            visible_info_only: true,
        },
    })
}

// ---------------------------------------------------------------------------
// Limits.
// ---------------------------------------------------------------------------

fn apply_dedupe_and_caps(
    groups: &mut [BaseGroup],
    options: &AssemblyOptions,
    drops: &mut Vec<AssemblyDrop>,
) {
    // 1. Exact state hashes collapse, in pack order.
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for group in groups.iter_mut() {
        if let Some(base) = &group.base
            && !seen.insert(base.state_hash.clone())
        {
            drops.push(AssemblyDrop {
                scenario_id: base.scenario.id.to_string(),
                reason: "duplicate_state".to_string(),
                detail: "another selected scenario has the same exact state".to_string(),
            });
            group.base = None;
        }
        group.variants.retain(|variant| {
            if seen.insert(variant.state_hash.clone()) {
                true
            } else {
                drops.push(AssemblyDrop {
                    scenario_id: variant.scenario.id.to_string(),
                    reason: "duplicate_state".to_string(),
                    detail: "another selected scenario has the same exact state".to_string(),
                });
                false
            }
        });
    }

    // 2. The per-base cap, counted in variants (§4.6 defaults 8 and 20 %).
    let planned: usize = groups
        .iter()
        .map(|group| usize::from(group.base.is_some()) + group.variants.len())
        .sum();
    let cap = options.limits.effective_variant_cap(planned);
    for group in groups.iter_mut() {
        if group.variants.len() <= cap {
            continue;
        }
        for variant in group.variants.drain(cap..) {
            drops.push(AssemblyDrop {
                scenario_id: variant.scenario.id.to_string(),
                reason: "per_base_cap".to_string(),
                detail: format!("base `{}` keeps at most {cap} variant(s)", group.base_id),
            });
        }
    }

    // 3. Optional family quotas, counted in base scenarios (§4.6).
    if !options.limits.family_quotas.is_empty() {
        let mut bases_per_family: BTreeMap<String, usize> = BTreeMap::new();
        for group in groups.iter_mut() {
            let Some(base) = &group.base else {
                continue;
            };
            let Some(quota) = options.limits.family_quotas.get(&base.family) else {
                continue;
            };
            let taken = bases_per_family.entry(base.family.clone()).or_insert(0);
            if *taken >= *quota {
                let id = base.scenario.id.to_string();
                let family = base.family.clone();
                drops.push(AssemblyDrop {
                    scenario_id: id.clone(),
                    reason: "family_quota".to_string(),
                    detail: format!("family `{family}` already has its quota of {quota} base(s)"),
                });
                for variant in &group.variants {
                    drops.push(AssemblyDrop {
                        scenario_id: variant.scenario.id.to_string(),
                        reason: "base_dropped".to_string(),
                        detail: format!("its base `{id}` was over its family quota"),
                    });
                }
                group.base = None;
                group.variants.clear();
            } else {
                *taken += 1;
            }
        }
    }

    // 4. A lesson with too few real positions is not a varied replay drill:
    // drop it rather than deal the same scenario every time it is drawn.
    if options.limits.min_bases_per_lesson > 1 {
        let mut per_lesson: BTreeMap<String, usize> = BTreeMap::new();
        for group in groups.iter() {
            if let Some(base) = &group.base {
                *per_lesson
                    .entry(base.scenario.lesson_id.clone())
                    .or_insert(0) += 1;
            }
        }
        for group in groups.iter_mut() {
            let Some(base) = &group.base else {
                continue;
            };
            let lesson = base.scenario.lesson_id.clone();
            let count = per_lesson.get(&lesson).copied().unwrap_or(0);
            if count >= options.limits.min_bases_per_lesson {
                continue;
            }
            let id = base.scenario.id.to_string();
            drops.push(AssemblyDrop {
                scenario_id: id.clone(),
                reason: "lesson_too_small".to_string(),
                detail: format!(
                    "lesson `{lesson}` has {count} base(s); the pack needs at least {}",
                    options.limits.min_bases_per_lesson
                ),
            });
            for variant in &group.variants {
                drops.push(AssemblyDrop {
                    scenario_id: variant.scenario.id.to_string(),
                    reason: "base_dropped".to_string(),
                    detail: format!("its base `{id}` was in an undersupplied lesson"),
                });
            }
            group.base = None;
            group.variants.clear();
        }
    }

    // 5. Variants can be disabled entirely: the pack then ships only the
    // reviewed bases. This is a product decision, not a cap.
    if options.limits.variants_disabled {
        for group in groups.iter_mut() {
            for variant in group.variants.drain(..) {
                drops.push(AssemblyDrop {
                    scenario_id: variant.scenario.id.to_string(),
                    reason: "variants_disabled".to_string(),
                    detail: "this pack ships its reviewed bases only".to_string(),
                });
            }
        }
        return;
    }

    // 6. Optional global variant ceiling. Keep evenly spaced variants across
    // the pack order rather than truncating the tail, so the limit does not
    // silently favour whichever lesson sorts first.
    let Some(limit) = options.limits.max_variants else {
        return;
    };
    let total: usize = groups.iter().map(|group| group.variants.len()).sum();
    if total <= limit {
        return;
    }
    let keep: BTreeSet<usize> = (0..limit).map(|index| index * total / limit).collect();
    let mut position = 0_usize;
    for group in groups.iter_mut() {
        let mut retained = Vec::new();
        for variant in group.variants.drain(..) {
            if keep.contains(&position) {
                retained.push(variant);
            } else {
                drops.push(AssemblyDrop {
                    scenario_id: variant.scenario.id.to_string(),
                    reason: "variant_limit".to_string(),
                    detail: format!("the pack keeps {limit} of {total} variant(s)"),
                });
            }
            position += 1;
        }
        group.variants = retained;
    }
}

// ---------------------------------------------------------------------------
// Pack metadata.
// ---------------------------------------------------------------------------

/// Interleave base groups so consecutive scenarios rarely come from the same
/// replay.
///
/// The selector may pick several decisions from one game (sometimes adjacent
/// turns). Dealing those back-to-back looks like the same hand repeating, even
/// though every state hash is unique. This greedy pass keeps the deterministic
/// first-fit order but picks the next group with a different source replay when
/// one remains; only a run with no alternative repeats a replay.
fn order_groups_for_pack(groups: &mut Vec<BaseGroup>) {
    let mut remaining = std::mem::take(groups);
    let mut ordered = Vec::with_capacity(remaining.len());
    let mut last_replay: Option<String> = None;
    while !remaining.is_empty() {
        let pick = remaining
            .iter()
            .position(|group| {
                group
                    .base
                    .as_ref()
                    .map(|base| base.scenario.provenance.replay_id.as_str())
                    != last_replay.as_deref()
            })
            .unwrap_or(0);
        let group = remaining.remove(pick);
        last_replay = group
            .base
            .as_ref()
            .map(|base| base.scenario.provenance.replay_id.as_str().to_string());
        ordered.push(group);
    }
    *groups = ordered;
}

fn games_for(
    rows: &[SelectedRow],
    replay_ids: &BTreeSet<&ReplayId>,
) -> Result<Vec<GameProvenance>, PackError> {
    let mut games: BTreeMap<&str, GameProvenance> = BTreeMap::new();
    for row in rows {
        let id = row.replay_id.as_str();
        if !replay_ids.iter().any(|wanted| wanted.as_str() == id) {
            continue;
        }
        let game: GameProvenance =
            serde_json::from_str(&row.provenance_json).map_err(|source| PackError::Games {
                path: format!("replays/{id}/provenance_json"),
                detail: source.to_string(),
            })?;
        game.validate().map_err(|err| PackError::Games {
            path: format!("replays/{id}/provenance_json"),
            detail: err.to_string(),
        })?;
        games.insert(id, game);
    }
    Ok(games.into_values().collect())
}

fn pack_copy(
    pack_id: &str,
    rows: &[SelectedRow],
    replay_ids: &BTreeSet<&ReplayId>,
    options: &AssemblyOptions,
) -> Result<(String, String), PackError> {
    let mut licences: BTreeSet<&str> = BTreeSet::new();
    let mut attributions: BTreeSet<&str> = BTreeSet::new();
    for row in rows {
        if !replay_ids
            .iter()
            .any(|wanted| wanted.as_str() == row.replay_id)
        {
            continue;
        }
        licences.insert(row.licence.as_str());
        attributions.insert(row.attribution.as_str());
    }
    let licence = match options.licence.as_deref() {
        Some(licence) => licence.to_string(),
        None if licences.len() == 1 => licences.first().expect("checked one element").to_string(),
        None => {
            return Err(PackError::Assembly {
                pack_id: pack_id.to_string(),
                detail: format!(
                    "the packed replays declare {} licences ({}); pass `--licence`",
                    licences.len(),
                    licences.iter().copied().collect::<Vec<_>>().join(", ")
                ),
            });
        }
    };
    let attribution = match options.attribution.as_deref() {
        Some(attribution) => attribution.to_string(),
        None if attributions.len() == 1 => attributions
            .first()
            .expect("checked one element")
            .to_string(),
        None => {
            return Err(PackError::Assembly {
                pack_id: pack_id.to_string(),
                detail: format!(
                    "the packed replays declare {} attributions; pass `--attribution`",
                    attributions.len()
                ),
            });
        }
    };
    Ok((licence, attribution))
}

fn latest_stamp(rows: &[SelectedRow]) -> String {
    rows.iter()
        .filter_map(|row| iso_from_stamp(&row.created_at).ok())
        .max()
        .unwrap_or_else(|| utc_iso8601(UNIX_EPOCH))
}

/// Normalise the DB's `utc_stamp` (`YYYYMMDD-HHMMSS`) or an ISO-8601 timestamp.
fn iso_from_stamp(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.len() == 15
        && raw.as_bytes().get(8) == Some(&b'-')
        && raw
            .bytes()
            .enumerate()
            .all(|(index, byte)| index == 8 || byte.is_ascii_digit())
    {
        return Ok(format!(
            "{}-{}-{}T{}:{}:{}Z",
            &raw[0..4],
            &raw[4..6],
            &raw[6..8],
            &raw[9..11],
            &raw[11..13],
            &raw[13..15]
        ));
    }
    if is_iso_timestamp(raw) {
        return Ok(raw.to_string());
    }
    Err(format!("`{raw}` is not a UTC stamp or ISO-8601 timestamp"))
}

fn is_iso_timestamp(raw: &str) -> bool {
    let raw = raw.trim();
    raw.len() >= 20
        && raw.as_bytes().get(4) == Some(&b'-')
        && raw.as_bytes().get(7) == Some(&b'-')
        && raw.as_bytes().get(10) == Some(&b'T')
        && raw.ends_with('Z')
}

#[allow(clippy::too_many_arguments)]
fn build_report(
    pack: &Pack,
    groups: &[BaseGroup],
    drops: &[AssemblyDrop],
    review: &ReviewSummary,
    options: &AssemblyOptions,
    rows_read: u64,
    encoded: &crate::miner::pack::write::PackBytes,
    export_path: &str,
    manifest_path: &str,
) -> AssemblyReport {
    let mut families: BTreeMap<&str, (u64, u64)> = BTreeMap::new();
    let mut largest: Option<LargestBase> = None;
    let mut bases = 0_u64;
    let mut variants = 0_u64;
    for group in groups {
        if let Some(base) = &group.base {
            bases += 1;
            let entry = families.entry(base.family.as_str()).or_insert((0, 0));
            entry.0 += 1;
            let scenarios = 1 + group.variants.len() as u64;
            let replace = largest.as_ref().is_none_or(|current| {
                scenarios > current.scenarios
                    || (scenarios == current.scenarios
                        && base.scenario.id.as_str() < current.base.as_str())
            });
            if replace {
                largest = Some(LargestBase {
                    base: base.scenario.id.to_string(),
                    scenarios,
                    share: 0.0,
                });
            }
            for variant in &group.variants {
                variants += 1;
                let entry = families.entry(variant.family.as_str()).or_insert((0, 0));
                entry.1 += 1;
            }
        }
    }
    let scenarios = bases + variants;
    if let Some(base) = &mut largest {
        base.share = if scenarios == 0 {
            0.0
        } else {
            base.scenarios as f64 / scenarios as f64
        };
    }
    let mut mix: Vec<FamilyMixRow> = families
        .into_iter()
        .map(|(family, (bases, variants))| FamilyMixRow {
            family: family.to_string(),
            bases,
            variants,
            scenarios: bases + variants,
            quota: options.limits.family_quotas.get(family).copied(),
        })
        .collect();
    mix.sort_by(|left, right| {
        right
            .scenarios
            .cmp(&left.scenarios)
            .then_with(|| left.family.cmp(&right.family))
    });

    let mut drop_counts: BTreeMap<String, u64> = BTreeMap::new();
    for drop in drops {
        *drop_counts.entry(drop.reason.clone()).or_insert(0) += 1;
    }

    let mut notes = vec![
        "generated_at is the latest selected row's timestamp, so re-assembling the same rows \
         hashes identically"
            .to_string(),
        "a base state comes from the walked decision row; a variant re-applies its recorded \
         chain to that state and the lesson classifier must re-derive the stored answer"
            .to_string(),
    ];
    if !review.checked {
        notes.push(
            "no review queue was found for this pack, so reviewer dispositions were not checked"
                .to_string(),
        );
    }
    if pack.requires_model() {
        notes.push(
            "at least one scenario ships without a precomputed model label (the DB stores a \
             variant's label only in the review artifact, never in the export); every answer is \
             still gradable without weights"
                .to_string(),
        );
    }
    if drop_counts.get("per_base_cap").copied().unwrap_or(0) > 0 {
        notes.push(format!(
            "the per-base cap is {} variant(s) for this pack (min of max_per_base {} and {:.0}% \
             of the planned scenarios)",
            options.limits.effective_variant_cap(
                groups
                    .iter()
                    .map(|group| usize::from(group.base.is_some()) + group.variants.len())
                    .sum()
            ),
            options.limits.max_per_base,
            options.limits.max_pack_share * 100.0
        ));
    }
    if !options.limits.family_quotas.is_empty() {
        notes.push(
            "family quotas were applied and count base scenarios, not variants (§4.6)".to_string(),
        );
    }
    if options.limits.variants_disabled {
        notes.push(
            "variants are disabled for this pack: it ships the reviewed bases only, and its \
             variety comes from real scenarios"
                .to_string(),
        );
    } else if let Some(limit) = options.limits.max_variants {
        notes.push(format!(
            "the pack keeps at most {limit} variant(s), spread evenly across the base order; \
             a variant beyond the ceiling is reported as `variant_limit`"
        ));
    }
    if options.limits.min_bases_per_lesson > 1 {
        notes.push(format!(
            "a lesson needs at least {} reviewed base(s) to stay in the pack; an undersupplied \
             lesson is reported as `lesson_too_small` instead of repeating one position",
            options.limits.min_bases_per_lesson
        ));
    }

    AssemblyReport {
        schema: ASSEMBLY_SCHEMA.to_string(),
        version: ASSEMBLY_VERSION,
        pack_id: pack.pack_id.to_string(),
        generated_at: pack.generated_at.clone(),
        rows_read,
        bases,
        variants,
        scenarios,
        families: mix,
        dropped: drops.to_vec(),
        drop_counts,
        variant_share: if scenarios == 0 {
            0.0
        } else {
            variants as f64 / scenarios as f64
        },
        largest_base: largest,
        limits: options.limits.clone(),
        bytes: encoded.len(),
        max_bytes: options.budget.max_bytes,
        max_scenarios: options.budget.max_scenarios,
        sha256: encoded.sha256.clone(),
        export_path: export_path.to_string(),
        manifest_path: manifest_path.to_string(),
        licence: pack.source.licence.clone(),
        data_commercial_use: pack.source.data_commercial_use,
        agents: pack
            .agents()
            .into_iter()
            .map(|agent| {
                format!(
                    "{} ({} {}, {})",
                    agent.agent_id, agent.engine, agent.engine_version, agent.licence.id
                )
            })
            .collect(),
        review: *review,
        audited: false,
        audit_clean: false,
        notes,
    }
}

// ---------------------------------------------------------------------------
// Recording the export.
// ---------------------------------------------------------------------------

fn record_pack(
    connection: &Connection,
    pack: &Pack,
    published: &PublishedPack,
    groups: &[BaseGroup],
    report: &AssemblyReport,
    export_path: &str,
    manifest_path: &str,
) -> Result<(), PackError> {
    let source_mix = serde_json::json!({
        "families": report
            .families
            .iter()
            .map(|family| (family.family.clone(), family.scenarios))
            .collect::<BTreeMap<String, u64>>(),
        "bases": report.bases,
        "variants": report.variants,
        "variant_share": report.variant_share,
    });
    let now = utc_stamp(SystemTime::now());
    let transaction = connection.unchecked_transaction()?;
    transaction.execute(
        "INSERT INTO packs (
            pack_id, version, schema, manifest_path, sha256, bytes, scenario_count,
            source_mix, licence, data_commercial_use, published_at, export_path, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(pack_id) DO UPDATE SET
            version = excluded.version,
            schema = excluded.schema,
            manifest_path = excluded.manifest_path,
            sha256 = excluded.sha256,
            bytes = excluded.bytes,
            scenario_count = excluded.scenario_count,
            source_mix = excluded.source_mix,
            licence = excluded.licence,
            data_commercial_use = excluded.data_commercial_use,
            published_at = excluded.published_at,
            export_path = excluded.export_path,
            created_at = excluded.created_at",
        params![
            pack.pack_id.as_str(),
            pack.version,
            &pack.schema,
            manifest_path,
            &published.entry.sha256,
            i64::try_from(published.entry.bytes).unwrap_or(i64::MAX),
            i64::try_from(pack.scenarios.len()).unwrap_or(i64::MAX),
            source_mix.to_string(),
            &pack.source.licence,
            i64::from(pack.source.data_commercial_use),
            now,
            export_path,
            now,
        ],
    )?;
    transaction.execute(
        "DELETE FROM pack_scenarios WHERE pack_id = ?1",
        params![pack.pack_id.as_str()],
    )?;

    let mut ordinal = 0_i64;
    // Match the pack body's bases-first order (see `run_assembly`).
    for group in groups {
        if let Some(base) = &group.base {
            insert_pack_scenario(&transaction, pack, base, None, ordinal)?;
            ordinal += 1;
        }
    }
    for group in groups {
        let Some(base) = &group.base else {
            continue;
        };
        for variant in &group.variants {
            insert_pack_scenario(
                &transaction,
                pack,
                variant,
                Some(base.scenario.id.as_str()),
                ordinal,
            )?;
            ordinal += 1;
        }
    }
    transaction.commit()?;
    Ok(())
}

fn insert_pack_scenario(
    connection: &Connection,
    pack: &Pack,
    scenario: &Assembled,
    base: Option<&str>,
    ordinal: i64,
) -> Result<(), PackError> {
    let json = serde_json::to_vec(&scenario.scenario).map_err(|source| PackError::Json {
        path: format!("{}/{}", pack.pack_id, scenario.scenario.id),
        source,
    })?;
    connection.execute(
        "INSERT INTO pack_scenarios (
            pack_id, scenario_id, ordinal, base_scenario_id, lesson_id, family,
            state_hash, scenario_sha256, variant
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            pack.pack_id.as_str(),
            scenario.scenario.id.as_str(),
            ordinal,
            base,
            &scenario.scenario.lesson_id,
            &scenario.family,
            &scenario.state_hash,
            sha256_hex(&json),
            i64::from(base.is_some()),
        ],
    )?;
    Ok(())
}

// `scenario_from` builds the id with `ScenarioKey::parse`; a selected row id is
// written by S2/V2 and is a slug, so the parse cannot fail for a row this
// module read from the DB.

#[cfg(test)]
mod tests;
