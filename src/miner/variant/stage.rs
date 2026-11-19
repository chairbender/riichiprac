//! The variant stage: policy, gate, yield, dedupe, caps and pack assembly.
//!
//! [`VariantStage::run`] is the pure core of V2. It takes validated base
//! scenarios, plans transform chains under each lesson's `TransformPolicy`,
//! runs the label-preservation gate, and returns the **shipped** variants plus
//! the yield report. The order of operations is the acceptance gate's:
//!
//! ```text
//! plan → apply → gate → dedupe
//!      → measure per-pair yield → withdraw disabled pairs
//!      → per-base / per-pack caps → shipped set + report
//! ```
//!
//! Yield is measured **before** the caps so a cap cannot hide a broken pair, and
//! a disabled pair's preserved variants are withdrawn **before** the caps so a
//! withdrawn variant cannot occupy a slot. Duplicates collapse as they are
//! found, which is also before the caps.
//!
//! [`build_pack`] assembles the base scenarios and the shipped variants into a
//! `riichiprac.scenario-pack` and runs the P1a gate. That is the V2 "pack
//! integration": a variant without a preserved `label_check`, without a chain,
//! or without its base cannot enter the pack, because the pack's own gate
//! rejects it and [`build_pack`] refuses before it gets that far.

use std::collections::{BTreeMap, BTreeSet};

use rayon::prelude::*;

use crate::miner::label::CLASSIFIER_VERSION;
use crate::miner::pack::{
    LabelCheck, Pack, PackGenerator, PackId, PackPlayed, PackScenario, PackSource, PackValidation,
    ScenarioKey, find_spoiler,
};
use crate::miner::parallel::{Progress, resolve_workers, worker_pool};
use crate::miner::provenance::GameProvenance;
use crate::miner::select::dedupe::exact_state_hash;
use crate::miner::transform::TransformChain;

use super::base::{BaseScenario, counterfactual_block, mortal_block};
use super::gate::{self, GateDeps, GatedState, LabelUse};
use super::plan::{families_of, plan_for};
use super::report::{
    BaseShare, CapTruncation, DisabledPair, LabelActivity, PairYield, ShareReport, VariantReport,
};
use super::{TransformFamily, VariantConfig, VariantError};

/// One preserved, gated, shipped variant.
#[derive(Debug, Clone, PartialEq)]
pub struct VariantRecord {
    /// The base scenario.
    pub base: ScenarioKey,
    /// The variant's scenario id.
    pub id: ScenarioKey,
    /// The yield-report key of the base label (`lesson`, or `mortal_best`).
    pub lesson_key: String,
    /// The families the chain applies, in order.
    pub families: Vec<TransformFamily>,
    /// The resolved chain document (with the red-five record).
    pub chain: TransformChain,
    /// The model-visible state hash.
    pub state_hash: String,
    /// The label-preservation record.
    pub label_check: LabelCheck,
    /// The pack-ready scenario.
    pub scenario: PackScenario,
}

/// A chain that did not ship, with its stable reason.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct RejectedVariant {
    /// The base scenario.
    pub base: ScenarioKey,
    /// The variant id the attempt would have used.
    pub id: ScenarioKey,
    /// The chain that was attempted.
    pub chain: TransformChain,
    /// Stable reason code.
    pub code: &'static str,
    /// Detail. Never rendered to a player.
    pub detail: String,
    /// Whether the label re-run preserved the label and a later stage check
    /// (dedupe, spoiler) rejected the variant. A gate failure is `false`.
    pub label_preserved: bool,
}

/// What one stage run produced.
#[derive(Debug, Clone, PartialEq)]
pub struct StageOutcome {
    /// The yield report.
    pub report: VariantReport,
    /// Shipped variants, in base/attempt order.
    pub variants: Vec<VariantRecord>,
    /// Every attempted chain that did not ship, in attempt order.
    pub rejected: Vec<RejectedVariant>,
}

/// The stage configuration for one run.
pub struct VariantStage<'a> {
    /// The volume/policy configuration.
    pub config: &'a VariantConfig,
    /// The gate's labeler and percentile cuts.
    pub deps: GateDeps<'a>,
    /// The pack id the run belongs to.
    pub pack_id: String,
    /// When the run finished.
    pub generated_at: String,
}

/// Per-pair counters while the run is in progress.
#[derive(Default)]
struct PairCounters {
    attempted: u64,
    preserved: u64,
    rejections: BTreeMap<String, u64>,
}

/// One planned attempt's outcome, computed off the main thread.
enum AttemptOutcome {
    /// The planned chain is invalid for this base (a report error).
    Invalid(String),
    /// The gate rejected the chain.
    Rejected(gate::Reject),
    /// The gate preserved the label.
    Gated(Box<GatedState>),
}

/// One plan of one base: the chain and its gate outcome.
struct Attempt {
    chain: TransformChain,
    families: Vec<TransformFamily>,
    outcome: AttemptOutcome,
}

/// Everything one base contributes, computed by a worker and merged in base
/// order.
struct BaseRun {
    /// The base failed its own validation; the message is the report error.
    invalid: Option<String>,
    /// The base's yield-report key (`lesson`, or `mortal_best`).
    lesson_key: String,
    /// Families the base's policy allows.
    policy_families: BTreeSet<TransformFamily>,
    /// The planned attempts, in plan order.
    attempts: Vec<Attempt>,
}

impl BaseRun {
    /// Plan and gate every attempt for one base.
    ///
    /// The gate is the expensive part (the transform plus the label re-run), and
    /// it depends only on the base, its chain and the label cache, so a worker
    /// can compute it. Which attempts the serial run actually *uses* is decided
    /// during the merge: a duplicate or a failed gate can end a base early, and
    /// an attempt after that point is simply dropped, exactly as the serial loop
    /// would never have planned it. Computing it is bounded wasted work
    /// (`attempts_per_base` at most).
    fn of(
        base: &BaseScenario,
        stage: &VariantStage<'_>,
        seed: &str,
        attempts_per_base: usize,
    ) -> Self {
        if let Err(err) = base.validate() {
            return Self {
                invalid: Some(err.to_string()),
                lesson_key: String::new(),
                policy_families: BTreeSet::new(),
                attempts: Vec::new(),
            };
        }
        let policy = base.policy(stage.config.mortal_policy.to_policy());
        let plans = plan_for(base.id().as_str(), policy, seed, attempts_per_base);
        let attempts = plans
            .into_iter()
            .map(|plan| {
                let outcome = match super::plan::plan_is_valid(&plan) {
                    Err(err) => AttemptOutcome::Invalid(format!(
                        "planned chain for `{}` is invalid: {err}",
                        base.id()
                    )),
                    Ok(()) => match gate::check(base, &plan.chain, &stage.deps) {
                        Ok(gated) => AttemptOutcome::Gated(Box::new(gated)),
                        Err(reject) => AttemptOutcome::Rejected(reject),
                    },
                };
                Attempt {
                    chain: plan.chain,
                    families: plan.families,
                    outcome,
                }
            })
            .collect();
        Self {
            invalid: None,
            lesson_key: base.label.key(),
            policy_families: super::plan::allowed_families(policy).into_iter().collect(),
            attempts,
        }
    }
}

impl<'a> VariantStage<'a> {
    /// Run the stage over `bases` on one thread (the bounded mode).
    pub fn run(&self, bases: &[BaseScenario]) -> Result<StageOutcome, VariantError> {
        self.run_with(bases, 1, false)
    }

    /// Run the stage over `bases`, planning and gating on `workers` threads.
    ///
    /// Bases are independent until their results are merged, so the transform
    /// and its label re-run run on every available core (`workers = 0`). The
    /// merge then applies the serial order's rules — dedupe against everything
    /// already seen, the early stop once a base has its target, the per-pair
    /// yield, the per-base cap — in base and plan order, so the shipped set and
    /// the report do not depend on the worker count.
    ///
    /// One caveat is recorded rather than hidden: the gate re-runs the labeler,
    /// and two bases whose chains produce the *same* transformed state share one
    /// cache row. In a serial run the earlier base evaluates it and the later one
    /// reports `cached` (and is then dropped as a duplicate); with more than one
    /// worker the later base may evaluate it first, so `labels.evaluated` and
    /// `labels.cached` can differ by that overlap. The shipped set is unaffected.
    pub fn run_with(
        &self,
        bases: &[BaseScenario],
        workers: usize,
        progress: bool,
    ) -> Result<StageOutcome, VariantError> {
        self.config.validate()?;
        validate_bases(bases)?;

        let seed = self.config.transform_seed.as_str();
        let attempts_per_base = self.config.attempts_per_base();
        let mut seen: BTreeSet<String> = bases
            .iter()
            .map(|base| exact_state_hash(&base.scenario.state))
            .collect();

        let mut report = VariantReport::empty(self.generated_at.clone(), self.pack_id.clone());
        report.bases = bases.len();
        report.variants_per_base = self.config.variants_per_base;
        report.effective_cap = self.config.effective_cap();
        report.cap_cause = self.config.cap_cause();
        report.min_yield = self.config.min_yield;

        let mut variants: Vec<VariantRecord> = Vec::new();
        let mut rejected: Vec<RejectedVariant> = Vec::new();
        let mut pairs: BTreeMap<(String, TransformFamily), PairCounters> = BTreeMap::new();
        let mut label_activity = LabelActivity::default();
        let mut withdrawn = 0_u64;

        let resolved = resolve_workers(workers);
        report.workers = resolved;
        let progress_bar = Progress::new(
            "transform",
            "gate",
            "base scenario(s)",
            bases.len(),
            progress,
        );
        progress_bar.announce(resolved);
        let plan = |base: &BaseScenario| {
            progress_bar.tick();
            BaseRun::of(base, self, seed, attempts_per_base)
        };
        let planned: Vec<BaseRun> = if resolved == 1 {
            bases.iter().map(plan).collect()
        } else {
            let pool = worker_pool(resolved).map_err(VariantError::Workers)?;
            pool.install(|| bases.par_iter().map(plan).collect())
        };

        for (base, prepared) in bases.iter().zip(planned) {
            if let Some(error) = prepared.invalid {
                report.errors.push(error);
                continue;
            }
            if prepared.attempts.is_empty() {
                *report
                    .rejections
                    .entry("policy_denies_all".to_string())
                    .or_insert(0) += 1;
                continue;
            }
            let lesson_key = prepared.lesson_key;
            let policy_families = prepared.policy_families;
            let mut attempted_families: BTreeSet<TransformFamily> = BTreeSet::new();
            let mut kept_for_base = 0_usize;
            for (index, attempt) in prepared.attempts.into_iter().enumerate() {
                report.attempts += 1;
                attempted_families.extend(attempt.families.iter().copied());
                let families = &attempt.families;
                let chain = &attempt.chain;
                let outcome = attempt.outcome;
                'attempt: {
                    if let AttemptOutcome::Invalid(error) = &outcome {
                        report.errors.push(error.clone());
                        break 'attempt;
                    }
                    // The attempt is measured whichever way the gate goes; the
                    // yield is preserved/attempted per lesson/transform pair.
                    for family in families {
                        pairs
                            .entry((lesson_key.clone(), *family))
                            .or_default()
                            .attempted += 1;
                    }
                    let id = match variant_id(base, index) {
                        Ok(id) => id,
                        Err(err) => {
                            report.errors.push(err);
                            break 'attempt;
                        }
                    };
                    match outcome {
                        AttemptOutcome::Invalid(_) => {
                            unreachable!("an invalid plan ended the attempt above")
                        }
                        AttemptOutcome::Rejected(reject) => {
                            count_rejection(
                                &mut report,
                                &mut pairs,
                                &lesson_key,
                                families,
                                reject.code,
                            );
                            rejected.push(RejectedVariant {
                                base: base.id().clone(),
                                id,
                                chain: chain.clone(),
                                code: reject.code,
                                detail: reject.detail,
                                label_preserved: false,
                            });
                        }
                        AttemptOutcome::Gated(gated) => {
                            report.preserved += 1;
                            for family in families {
                                pairs
                                    .entry((lesson_key.clone(), *family))
                                    .or_default()
                                    .preserved += 1;
                            }
                            match gated.label_use {
                                LabelUse::Cached => label_activity.cached += 1,
                                LabelUse::Evaluated => label_activity.evaluated += 1,
                                LabelUse::Retried => label_activity.retried += 1,
                                LabelUse::None => {}
                            }
                            let hash = exact_state_hash(&gated.state);
                            if !seen.insert(hash.clone()) {
                                report.duplicate_states += 1;
                                count_rejection(
                                    &mut report,
                                    &mut pairs,
                                    &lesson_key,
                                    families,
                                    "duplicate_state",
                                );
                                rejected.push(RejectedVariant {
                                    base: base.id().clone(),
                                    id,
                                    chain: chain.clone(),
                                    code: "duplicate_state",
                                    detail: "the transformed state is already in the pack"
                                        .to_string(),
                                    label_preserved: true,
                                });
                                break 'attempt;
                            }
                            let scenario = variant_scenario(base, &id, &gated, chain);
                            if let Some(finding) = find_spoiler(&scenario) {
                                count_rejection(
                                    &mut report,
                                    &mut pairs,
                                    &lesson_key,
                                    families,
                                    "spoiler",
                                );
                                rejected.push(RejectedVariant {
                                    base: base.id().clone(),
                                    id,
                                    chain: chain.clone(),
                                    code: "spoiler",
                                    detail: finding.detail,
                                    label_preserved: true,
                                });
                                break 'attempt;
                            }
                            kept_for_base += 1;
                            variants.push(VariantRecord {
                                base: base.id().clone(),
                                id,
                                lesson_key: lesson_key.clone(),
                                families: families.clone(),
                                chain: chain.clone(),
                                state_hash: hash,
                                label_check: gated.label_check.clone(),
                                scenario,
                            });
                        }
                    }
                }
                // A pair needs at least one attempt per base to be measured;
                // stop once the base has its target and every allowed family
                // has been tried at least once.
                if kept_for_base >= self.config.variants_per_base
                    && policy_families
                        .iter()
                        .all(|family| attempted_families.contains(family))
                {
                    break;
                }
            }
        }

        let disabled = self.disabled_pairs(&pairs);
        let before_withdraw = variants.len() as u64;
        variants.retain(|record| {
            let blocked = record.families.iter().any(|family| {
                disabled
                    .iter()
                    .any(|pair| pair.lesson == record.lesson_key && pair.transform == *family)
            });
            if blocked {
                withdrawn += 1;
            }
            !blocked
        });
        debug_assert_eq!(withdrawn, before_withdraw - variants.len() as u64);
        if withdrawn > 0 {
            *report
                .rejections
                .entry("disabled_pair".to_string())
                .or_insert(0) += withdrawn;
        }
        report.withdrawn_disabled = withdrawn;

        // The per-base cap runs last, in base/attempt order, so the report can
        // say exactly which base was truncated by which rule.
        let cap = report.effective_cap;
        let cause = report.cap_cause;
        let mut preserved_per_base: BTreeMap<String, u64> = BTreeMap::new();
        for record in &variants {
            *preserved_per_base
                .entry(record.base.to_string())
                .or_insert(0) += 1;
        }
        let mut kept_per_base: BTreeMap<String, u64> = BTreeMap::new();
        let mut shipped: Vec<VariantRecord> = Vec::with_capacity(variants.len());
        for record in variants {
            let kept = kept_per_base.entry(record.base.to_string()).or_insert(0);
            if usize::try_from(*kept).unwrap_or(usize::MAX) >= cap {
                report.dropped_by_cap += 1;
                *report
                    .rejections
                    .entry("per_base_cap".to_string())
                    .or_insert(0) += 1;
                continue;
            }
            *kept += 1;
            shipped.push(record);
        }
        for (base, preserved) in preserved_per_base {
            let kept = kept_per_base.get(&base).copied().unwrap_or(0);
            if kept < preserved {
                report.cap_limited.push(CapTruncation {
                    base,
                    preserved,
                    kept,
                    cap,
                    cause,
                });
            }
        }

        report.shipped = shipped.len() as u64;
        for record in &shipped {
            let kind = match record.label_check.kind {
                crate::miner::pack::LabelCheckKind::Book => "book",
                crate::miner::pack::LabelCheckKind::Mortal => "mortal",
                crate::miner::pack::LabelCheckKind::Mistake => "mistake",
            };
            *report.label_kinds.entry(kind.to_string()).or_insert(0) += 1;
        }
        report.labels = label_activity;
        report.pair_yield = pair_yields(&pairs, &disabled);
        report.disabled_pairs = disabled;
        fill_share(&mut report, bases, &shipped);
        if shipped.is_empty() {
            report.notes.push(
                "no variant shipped: check the policy opt-ins and the per-pair yield".to_string(),
            );
        }
        if bases.iter().all(|base| base.label.top_action.is_none()) {
            report.notes.push(
                "no model label was re-run: every base is a book label and no checkpoint was \
                 supplied"
                    .to_string(),
            );
        }

        Ok(StageOutcome {
            report,
            variants: shipped,
            rejected,
        })
    }

    /// The pairs to disable, from the measured yields and reviewer overrides.
    fn disabled_pairs(
        &self,
        pairs: &BTreeMap<(String, TransformFamily), PairCounters>,
    ) -> Vec<DisabledPair> {
        let mut disabled = Vec::new();
        for ((lesson, family), counters) in pairs {
            let ratio = ratio(counters.preserved, counters.attempted);
            let override_ = self.config.pair_override(lesson, *family);
            let reviewed = override_.is_some_and(|pair| pair.enabled);
            let reason = if override_.is_some_and(|pair| !pair.enabled) {
                Some("reviewer_disabled")
            } else if ratio < self.config.min_yield && !reviewed {
                Some("below_threshold")
            } else {
                None
            };
            if let Some(reason) = reason {
                disabled.push(DisabledPair {
                    lesson: lesson.clone(),
                    transform: *family,
                    ratio,
                    min_yield: self.config.min_yield,
                    attempted: counters.attempted,
                    reviewed,
                    reason: reason.to_string(),
                });
            }
        }
        disabled
    }
}

/// The variant id one attempt would use, or the report error that stops it.
fn variant_id(base: &BaseScenario, index: usize) -> Result<ScenarioKey, String> {
    ScenarioKey::parse(&format!("{}-v{:02}", base.id().as_str(), index + 1))
        .map_err(|err| format!("cannot name a variant of `{}`: {err}", base.id()))
}

fn validate_bases(bases: &[BaseScenario]) -> Result<(), VariantError> {
    if bases.is_empty() {
        return Err(VariantError::Config(
            "the stage needs at least one base scenario".to_string(),
        ));
    }
    let mut ids: BTreeSet<&str> = BTreeSet::new();
    for base in bases {
        if !ids.insert(base.id().as_str()) {
            return Err(VariantError::Config(format!(
                "base scenario id `{}` appears twice; variant ids would collide",
                base.id()
            )));
        }
    }
    Ok(())
}

fn count_rejection(
    report: &mut VariantReport,
    pairs: &mut BTreeMap<(String, TransformFamily), PairCounters>,
    lesson_key: &str,
    families: &[TransformFamily],
    code: &'static str,
) {
    *report.rejections.entry(code.to_string()).or_insert(0) += 1;
    for family in families {
        *pairs
            .entry((lesson_key.to_string(), *family))
            .or_default()
            .rejections
            .entry(code.to_string())
            .or_insert(0) += 1;
    }
}

fn ratio(preserved: u64, attempted: u64) -> f32 {
    if attempted == 0 {
        0.0
    } else {
        preserved as f32 / attempted as f32
    }
}

fn pair_yields(
    pairs: &BTreeMap<(String, TransformFamily), PairCounters>,
    disabled: &[DisabledPair],
) -> Vec<PairYield> {
    pairs
        .iter()
        .map(|((lesson, family), counters)| {
            let ratio = ratio(counters.preserved, counters.attempted);
            PairYield {
                lesson: lesson.clone(),
                transform: *family,
                attempted: counters.attempted,
                preserved: counters.preserved,
                ratio,
                disabled: disabled
                    .iter()
                    .any(|pair| pair.lesson == *lesson && pair.transform == *family),
                rejections: counters.rejections.clone(),
            }
        })
        .collect()
}

/// Build the pack-ready scenario for one gated variant.
fn variant_scenario(
    base: &BaseScenario,
    id: &ScenarioKey,
    gated: &GatedState,
    chain: &TransformChain,
) -> PackScenario {
    let mut scenario = base.scenario.clone();
    scenario.id = id.clone();
    scenario.lesson_id = gated.state.category.clone();
    scenario.correct_action = gated.state.correct_action.clone();
    scenario.accepted = gated.accepted.clone();
    scenario.state = gated.state.clone();
    scenario.mortal = gated.model.as_ref().map(mortal_block);
    scenario.counterfactual = gated.model.as_ref().map(counterfactual_block);
    scenario.played = base.scenario.played.as_ref().map(|played| PackPlayed {
        kind: played.kind,
        agent: played.agent.clone(),
        action: chain
            .map_action_name(&played.action)
            .unwrap_or_else(|_| played.action.clone()),
        mortal_probability: played.mortal_probability,
    });
    scenario.interestingness = None;
    scenario.provenance.transforms = families_of(chain)
        .into_iter()
        .map(|family| family.as_str().to_string())
        .collect();
    scenario.provenance.transform_seed = Some(chain.transform_seed.clone());
    scenario.provenance.variant_of = Some(base.id().clone());
    scenario.provenance.transform_chain = Some(chain.clone());
    scenario.provenance.label_check = Some(gated.label_check.clone());
    scenario.validation = PackValidation {
        state_valid: true,
        replay_roundtrip: false,
        answer_recomputed: true,
        visible_info_only: true,
    };
    scenario
}

fn fill_share(report: &mut VariantReport, bases: &[BaseScenario], variants: &[VariantRecord]) {
    let mut per_base: BTreeMap<String, u64> = bases
        .iter()
        .map(|base| (base.id().to_string(), 1))
        .collect();
    let mut by_family: BTreeMap<String, u64> = BTreeMap::new();
    let mut by_chain: BTreeMap<String, u64> = BTreeMap::new();
    for record in variants {
        *per_base.entry(record.base.to_string()).or_insert(1) += 1;
        if let Some(first) = record.families.first() {
            *by_family.entry(first.to_string()).or_insert(0) += 1;
        }
        let signature: Vec<&str> = record
            .families
            .iter()
            .map(|family| family.as_str())
            .collect();
        *by_chain.entry(signature.join("+")).or_insert(0) += 1;
    }
    let pack_scenarios = bases.len() as u64 + variants.len() as u64;
    let largest = per_base
        .iter()
        .max_by_key(|(base, scenarios)| (*scenarios, std::cmp::Reverse(base.as_str())))
        .map(|(base, scenarios)| BaseShare {
            base: base.clone(),
            scenarios: *scenarios,
        });
    let mut families: Vec<String> = by_family.keys().cloned().collect();
    families.sort();
    report.share = ShareReport {
        bases: bases.len(),
        variants: variants.len() as u64,
        pack_scenarios,
        variant_share: if pack_scenarios == 0 {
            0.0
        } else {
            variants.len() as f32 / pack_scenarios as f32
        },
        largest_base_share: largest.as_ref().map_or(0.0, |base| {
            base.scenarios as f32 / pack_scenarios.max(1) as f32
        }),
        largest_base: largest,
        transform_families: families,
        by_family,
        by_chain,
    };
}

/// The inputs of [`build_pack`].
pub struct PackAssembly<'a> {
    /// The pack id.
    pub pack_id: &'a str,
    /// When the pack was generated.
    pub generated_at: &'a str,
    /// Pack data licence.
    pub licence: &'a str,
    /// Pack data attribution.
    pub attribution: &'a str,
    /// The base scenarios, in pack order.
    pub bases: &'a [BaseScenario],
    /// The shipped variants.
    pub variants: &'a [VariantRecord],
    /// The provenance rows the pack references.
    pub games: &'a [GameProvenance],
}

/// Assemble the base scenarios and the gated variants into a pack and run the
/// P1a gate.
///
/// This is the only path from the stage to a pack. It refuses, before the P1a
/// audit, a variant whose `label_check` is missing or not preserved, a variant
/// with no chain or no `variant_of`, and a variant whose base is not in
/// `bases`. A caller therefore cannot smuggle a rejected or hand-edited variant
/// into a pack.
pub fn build_pack(assembly: &PackAssembly<'_>) -> Result<Pack, VariantError> {
    let mut scenarios: Vec<PackScenario> = assembly
        .bases
        .iter()
        .map(|base| base.scenario.clone())
        .collect();
    let bases: BTreeSet<&str> = assembly
        .bases
        .iter()
        .map(|base| base.id().as_str())
        .collect();
    for record in assembly.variants {
        let label_check = record
            .scenario
            .provenance
            .label_check
            .as_ref()
            .ok_or_else(|| {
                VariantError::Config(format!(
                    "variant `{}` has no label-preservation record",
                    record.id
                ))
            })?;
        if !label_check.preserved {
            return Err(VariantError::Config(format!(
                "variant `{}` failed its label-preservation check",
                record.id
            )));
        }
        if record.chain.transform_seed.trim().is_empty() {
            return Err(VariantError::Config(format!(
                "variant `{}` has no transform seed",
                record.id
            )));
        }
        if record
            .scenario
            .provenance
            .transform_chain
            .as_ref()
            .is_none()
        {
            return Err(VariantError::Config(format!(
                "variant `{}` has no transform chain",
                record.id
            )));
        }
        let Some(base) = record.scenario.provenance.variant_of.as_ref() else {
            return Err(VariantError::Config(format!(
                "variant `{}` has no `variant_of`",
                record.id
            )));
        };
        if !bases.contains(base.as_str()) {
            return Err(VariantError::Config(format!(
                "variant `{}` names base `{base}`, which is not in the pack",
                record.id
            )));
        }
        scenarios.push(record.scenario.clone());
    }

    let source =
        PackSource::from_games(assembly.games, assembly.licence, assembly.attribution, true)
            .ok_or_else(|| {
                VariantError::Config(
                    "cannot build the pack source: no games, or the games name different corpora"
                        .to_string(),
                )
            })?;

    let pack = Pack {
        schema: crate::miner::pack::PACK_SCHEMA.to_string(),
        version: crate::miner::pack::PACK_VERSION,
        pack_id: PackId::parse(assembly.pack_id)
            .map_err(|err| VariantError::Config(err.to_string()))?,
        generated_at: assembly.generated_at.to_string(),
        generator: PackGenerator::mine_replays("variant-stage", CLASSIFIER_VERSION),
        source,
        scenarios,
    };
    pack.validate()?;
    Ok(pack)
}
