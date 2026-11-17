//! The pack report: family mix, variant share, agents and size.
//!
//! `mine_replays pack report` prints one of these per manifest entry. It is the
//! P1a half of the P1b pack report (which adds selection-side family quotas).

use serde::{Deserialize, Serialize};

use super::PackBudget;
use super::model::Pack;

/// A serialisable summary of one pack body.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PackReport {
    /// Pack id.
    pub pack_id: String,
    /// Generation timestamp.
    pub generated_at: String,
    /// Scenarios in the body.
    pub scenario_count: usize,
    /// Encoded body bytes.
    pub bytes: u64,
    /// The body ceiling it was measured against.
    pub max_bytes: u64,
    /// Pack data licence.
    pub licence: String,
    /// Whether the data grants commercial use.
    pub data_commercial_use: bool,
    /// Whether the model is needed for labels.
    pub requires_model: bool,
    /// Lesson ids, sorted and unique.
    pub lesson_ids: Vec<String>,
    /// Book sections, sorted and unique.
    pub book_sections: Vec<String>,
    /// Contributing agents, `"<id> (<engine> <version>, <licence>)"`, sorted.
    pub agents: Vec<String>,
    /// Scenarios built by a transform chain.
    pub variant_count: usize,
    /// `variant_count / scenario_count`.
    pub variant_share: f64,
    /// The largest share of scenarios that are variants of one base scenario
    /// (`0.0` when the pack ships no variants).
    pub largest_base_share: f64,
}

/// Build a report from a decoded pack and its encoded size.
#[must_use]
pub fn pack_report(pack: &Pack, bytes: u64, budget: &PackBudget) -> PackReport {
    let total = pack.scenarios.len();
    let variant_count = pack
        .scenarios
        .iter()
        .filter(|scenario| scenario.provenance.is_variant())
        .count();
    let mut bases: std::collections::BTreeMap<&str, usize> = std::collections::BTreeMap::new();
    for scenario in &pack.scenarios {
        if let Some(base) = &scenario.provenance.variant_of {
            *bases.entry(base.as_str()).or_default() += 1;
        }
    }
    let largest = bases.values().copied().max().unwrap_or(0);
    let share = |count: usize| {
        if total == 0 {
            0.0
        } else {
            count as f64 / total as f64
        }
    };

    let mut agents: Vec<String> = pack
        .agents()
        .into_iter()
        .map(|agent| {
            format!(
                "{} ({} {}, {})",
                agent.agent_id, agent.engine, agent.engine_version, agent.licence.id
            )
        })
        .collect();
    agents.sort();
    agents.dedup();

    PackReport {
        pack_id: pack.pack_id.to_string(),
        generated_at: pack.generated_at.clone(),
        scenario_count: total,
        bytes,
        max_bytes: budget.max_bytes,
        licence: pack.source.licence.clone(),
        data_commercial_use: pack.source.data_commercial_use,
        requires_model: pack.requires_model(),
        lesson_ids: pack.lesson_ids(),
        book_sections: pack.book_sections(),
        agents,
        variant_count,
        variant_share: share(variant_count),
        largest_base_share: share(largest),
    }
}

/// Render a report as report-style text lines.
#[must_use]
pub fn render_pack_report(report: &PackReport) -> Vec<String> {
    let mut lines = vec![
        format!(
            "{}: {} scenario(s), {} / {} bytes",
            report.pack_id, report.scenario_count, report.bytes, report.max_bytes
        ),
        format!(
            "  generated {}; licence {} (commercial: {}); requires model: {}",
            report.generated_at, report.licence, report.data_commercial_use, report.requires_model
        ),
        format!(
            "  variants {} ({:.0}%), largest base share {:.0}%",
            report.variant_count,
            report.variant_share * 100.0,
            report.largest_base_share * 100.0
        ),
        format!("  lessons: {}", report.lesson_ids.join(", ")),
    ];
    if !report.book_sections.is_empty() {
        lines.push(format!(
            "  book sections: {}",
            report.book_sections.join(", ")
        ));
    }
    lines.push(format!("  agents: {}", report.agents.join("; ")));
    lines
}
