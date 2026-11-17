//! Persisting the stage's bases and variants into the miner DB.
//!
//! The plan's `selected_scenarios` and `variants` tables are the hand-off to
//! P1b: the base row carries the decision it came from, and a variant row
//! carries its base, chain, seed and label-preservation record. P1b can rebuild
//! the transformed state by applying the recorded chain to the base decision's
//! state, so the DB stores references and provenance, not a second copy of every
//! table.
//!
//! Both tables are upserted by id, so re-running the stage after a policy or
//! yield change replaces its rows instead of duplicating them. Rejected
//! attempts are stored too (`label_preserved = 0` with the stable rejection
//! reason), which is what lets a later review answer "why did this lesson not
//! get variants?".

use rusqlite::{Connection, params};

use crate::miner::select::dedupe::exact_state_hash;

use super::VariantError;
use super::base::BaseScenario;
use super::stage::{RejectedVariant, VariantRecord};

/// Upsert the bases and the shipped/rejected variants of one stage run.
///
/// Each base must carry a `decision_id` (a generated rehearsal base does not,
/// and the caller must not persist a rehearsal): the `selected_scenarios` row
/// references the `decisions` row extraction wrote.
pub fn store_variants(
    connection: &Connection,
    pack_id: &str,
    bases: &[BaseScenario],
    shipped: &[VariantRecord],
    rejected: &[RejectedVariant],
    created_at: &str,
) -> Result<(), VariantError> {
    let transaction = connection.unchecked_transaction()?;
    for base in bases {
        let decision_id = base
            .decision_id
            .as_deref()
            .ok_or_else(|| VariantError::Base {
                id: base.id().to_string(),
                detail: "cannot persist a base with no decision id".to_string(),
            })?;
        let correct_action = serde_json::to_string(&base.scenario.correct_action)?;
        let accepted = serde_json::to_string(&base.scenario.accepted)?;
        let provenance = serde_json::to_string(&base.scenario.provenance)?;
        transaction.execute(
            "INSERT INTO selected_scenarios (
                scenario_id, decision_id, pack_id, lesson_id, family, correct_action,
                accepted, variant_of, transform_chain, label_check, label_kind,
                label_source, selection_reason, provenance, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, NULL, NULL, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(scenario_id) DO UPDATE SET
                decision_id = excluded.decision_id,
                pack_id = excluded.pack_id,
                lesson_id = excluded.lesson_id,
                family = excluded.family,
                correct_action = excluded.correct_action,
                accepted = excluded.accepted,
                label_kind = excluded.label_kind,
                label_source = excluded.label_source,
                selection_reason = excluded.selection_reason,
                provenance = excluded.provenance,
                created_at = excluded.created_at",
            params![
                base.id().as_str(),
                decision_id,
                pack_id,
                base.scenario.lesson_id,
                base.replay_family.as_deref().unwrap_or("unknown"),
                correct_action,
                accepted,
                base.label.kind.as_str(),
                base.label.kind.as_str(),
                "transform:base",
                provenance,
                created_at,
            ],
        )?;
    }

    for record in shipped {
        let base = bases
            .iter()
            .find(|base| base.id() == &record.base)
            .ok_or_else(|| VariantError::Base {
                id: record.base.to_string(),
                detail: "a shipped variant names a base outside the run".to_string(),
            })?;
        let decision_id = base
            .decision_id
            .as_deref()
            .ok_or_else(|| VariantError::Base {
                id: base.id().to_string(),
                detail: "cannot persist a base with no decision id".to_string(),
            })?;
        let chain = serde_json::to_string(&record.chain)?;
        let check = serde_json::to_string(
            record
                .scenario
                .provenance
                .label_check
                .as_ref()
                .expect("a shipped variant carries its label check"),
        )?;
        let provenance = serde_json::to_string(&record.scenario.provenance)?;
        let correct_action = serde_json::to_string(&record.scenario.correct_action)?;
        let accepted = serde_json::to_string(&record.scenario.accepted)?;
        let label_kind = record
            .scenario
            .provenance
            .label_check
            .as_ref()
            .map(|check| match check.kind {
                crate::miner::pack::LabelCheckKind::Book => "book",
                crate::miner::pack::LabelCheckKind::Mortal => "mortal",
                crate::miner::pack::LabelCheckKind::Mistake => "mistake",
            })
            .unwrap_or("book");
        transaction.execute(
            "INSERT INTO selected_scenarios (
                scenario_id, decision_id, pack_id, lesson_id, family, correct_action,
                accepted, variant_of, transform_chain, label_check, label_kind,
                label_source, selection_reason, provenance, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
             ON CONFLICT(scenario_id) DO UPDATE SET
                decision_id = excluded.decision_id,
                pack_id = excluded.pack_id,
                lesson_id = excluded.lesson_id,
                family = excluded.family,
                correct_action = excluded.correct_action,
                accepted = excluded.accepted,
                variant_of = excluded.variant_of,
                transform_chain = excluded.transform_chain,
                label_check = excluded.label_check,
                label_kind = excluded.label_kind,
                label_source = excluded.label_source,
                selection_reason = excluded.selection_reason,
                provenance = excluded.provenance,
                created_at = excluded.created_at",
            params![
                record.id.as_str(),
                decision_id,
                pack_id,
                record.scenario.lesson_id,
                base.replay_family.as_deref().unwrap_or("unknown"),
                correct_action,
                accepted,
                record.base.as_str(),
                chain,
                check,
                label_kind,
                label_kind,
                "transform:variant",
                provenance,
                created_at,
            ],
        )?;
        upsert_variant_row(
            &transaction,
            record.id.as_str(),
            record.base.as_str(),
            &chain,
            record.chain.transform_seed.as_str(),
            true,
            None,
            created_at,
        )?;
    }

    for record in rejected {
        let chain = serde_json::to_string(&record.chain)?;
        let reason = format!("{}: {}", record.code, record.detail);
        upsert_variant_row(
            &transaction,
            record.id.as_str(),
            record.base.as_str(),
            &chain,
            record.chain.transform_seed.as_str(),
            record.label_preserved,
            Some(&reason),
            created_at,
        )?;
    }
    transaction.commit()?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn upsert_variant_row(
    connection: &Connection,
    variant_id: &str,
    base_scenario_id: &str,
    transform_chain: &str,
    transform_seed: &str,
    label_preserved: bool,
    rejection_reason: Option<&str>,
    created_at: &str,
) -> Result<(), VariantError> {
    connection.execute(
        "INSERT INTO variants (
            variant_id, base_scenario_id, transform_chain, transform_seed,
            label_preserved, rejection_reason, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(variant_id) DO UPDATE SET
            base_scenario_id = excluded.base_scenario_id,
            transform_chain = excluded.transform_chain,
            transform_seed = excluded.transform_seed,
            label_preserved = excluded.label_preserved,
            rejection_reason = excluded.rejection_reason,
            created_at = excluded.created_at",
        params![
            variant_id,
            base_scenario_id,
            transform_chain,
            transform_seed,
            i64::from(label_preserved),
            rejection_reason,
            created_at,
        ],
    )?;
    Ok(())
}

/// The stored state hash of a base, for a caller that wants the dedupe key
/// without importing the labeler.
#[must_use]
pub fn base_hash(base: &BaseScenario) -> String {
    exact_state_hash(&base.scenario.state)
}
