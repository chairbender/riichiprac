//! Scenario generators, organized one module per lesson.
//!
//! - `block_theory`: 5-block random hands and the ryanmen protorun lesson.
//! - `chiitoitsu_riichi_vs_dama`: seven-pairs Riichi/dama family.
//! - `shouminkan_decision`: Added Kan decision lesson.
//! - `support`: shared deck, table, scoring, formatting, and retry helpers.
//!
//! The Phase 2 `mock_table` fixture lives in `crate::fixtures`, outside the
//! lesson registry.

mod block_theory;
mod chiitoitsu_riichi_vs_dama;
mod shouminkan_decision;
mod support;

use agari::tile::Tile;
use serde::Serialize;

use crate::state::GameState;

pub use support::analysis::{HandMetrics, evaluate_hand};
pub use support::deck::ALL_TILES;
pub use support::format::format_hand_compact;

pub type PuzzleResponse = GameState;

/// Broad grouping used by the scenario picker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScenarioCategory {
    TileEfficiency,
    RiichiDecision,
    KanDecision,
}

impl ScenarioCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            ScenarioCategory::TileEfficiency => "tile_efficiency",
            ScenarioCategory::RiichiDecision => "riichi_decision",
            ScenarioCategory::KanDecision => "kan_decision",
        }
    }
}

/// Display metadata for one lesson.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScenarioMeta {
    pub id: ScenarioId,
    pub label: &'static str,
    pub description: &'static str,
    pub category: ScenarioCategory,
    pub tags: &'static [&'static str],
}

/// The user-facing scenario catalogue. Fixtures are deliberately excluded.
pub const SCENARIO_MANIFEST: &[ScenarioMeta] = &[
    ScenarioMeta {
        id: ScenarioId::RyanmenProtorun,
        label: "Ryanmen Protorun",
        description: "Block theory: choose the discard that keeps the ryanmen wait.",
        category: ScenarioCategory::TileEfficiency,
        tags: &["block_theory", "discard", "ryanmen"],
    },
    ScenarioMeta {
        id: ScenarioId::ChiitoitsuRiichiVsDama,
        label: "Chiitoitsu Riichi vs Dama",
        description: "Seven pairs: decide whether to declare Riichi or stay dama.",
        category: ScenarioCategory::RiichiDecision,
        tags: &["chiitoitsu", "riichi", "dama"],
    },
    ScenarioMeta {
        id: ScenarioId::ShouminkanDecision,
        label: "Added Kan Decision",
        description: "Open Pon, fourth tile drawn: decide whether to upgrade to an Added Kan.",
        category: ScenarioCategory::KanDecision,
        tags: &["kan", "shouminkan"],
    },
];

/// Serializes the scenario catalogue for the frontend picker.
pub fn list_scenarios_json() -> String {
    #[derive(Serialize)]
    struct ScenarioMetaJson {
        id: &'static str,
        label: &'static str,
        description: &'static str,
        category: &'static str,
        tags: &'static [&'static str],
    }

    let scenarios: Vec<ScenarioMetaJson> = SCENARIO_MANIFEST
        .iter()
        .map(|meta| ScenarioMetaJson {
            id: meta.id.as_str(),
            label: meta.label,
            description: meta.description,
            category: meta.category.as_str(),
            tags: meta.tags,
        })
        .collect();

    serde_json::to_string(&scenarios)
        .unwrap_or_else(|err| format!("{{\"error\":\"Failed to serialize scenarios: {err}\"}}"))
}

/// Every scenario the generator can dispatch to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScenarioId {
    RyanmenProtorun,
    ChiitoitsuRiichiVsDama,
    ShouminkanDecision,
}

impl ScenarioId {
    /// Every real scenario, excluding the UI fixture.
    pub const ALL: &'static [ScenarioId] = &[
        ScenarioId::RyanmenProtorun,
        ScenarioId::ChiitoitsuRiichiVsDama,
        ScenarioId::ShouminkanDecision,
    ];

    /// The category string understood by the WASM API.
    pub fn as_str(self) -> &'static str {
        match self {
            ScenarioId::RyanmenProtorun => "ryanmen_protorun",
            ScenarioId::ChiitoitsuRiichiVsDama => "chiitoitsu_riichi_vs_dama",
            ScenarioId::ShouminkanDecision => "shouminkan_decision",
        }
    }

    /// Resolves an incoming category string.
    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            "ryanmen_protorun" => Some(ScenarioId::RyanmenProtorun),
            "chiitoitsu_riichi_vs_dama" => Some(ScenarioId::ChiitoitsuRiichiVsDama),
            "shouminkan_decision" => Some(ScenarioId::ShouminkanDecision),
            _ => None,
        }
    }

    /// Generates a puzzle for this scenario, echoing `category` in the state.
    pub fn generate(self, category: &str) -> Result<GameState, String> {
        match self {
            ScenarioId::RyanmenProtorun => block_theory::ryanmen_protorun::generate(category),
            ScenarioId::ChiitoitsuRiichiVsDama => chiitoitsu_riichi_vs_dama::generate(category),
            ScenarioId::ShouminkanDecision => shouminkan_decision::generate(category),
        }
    }
}

/// Dispatches to the requested scenario. Unknown categories fall back to
/// the first real Block Theory scenario. The `mock_table` fixture is handled
/// separately so it stays out of the lesson manifest.
pub fn generate_puzzle(category: &str) -> Result<GameState, String> {
    if category == "mock_table" {
        return crate::fixtures::mock_table::generate(category);
    }

    match ScenarioId::from_id(category) {
        Some(id) => id.generate(category),
        None => block_theory::ryanmen_protorun::generate(category),
    }
}

/// Standalone function for generating a 14-tile hand via 5-block theory.
pub fn generate_random_hand() -> Vec<Tile> {
    block_theory::random_hand::generate()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::CorrectActionType;

    #[test]
    fn every_scenario_id_generates_its_own_category() {
        for &id in ScenarioId::ALL {
            assert_eq!(ScenarioId::from_id(id.as_str()), Some(id));
            let state = id
                .generate(id.as_str())
                .unwrap_or_else(|err| panic!("{} failed: {err}", id.as_str()));
            assert_eq!(state.category, id.as_str());
        }
    }

    #[test]
    fn manifest_matches_the_registered_scenario_ids() {
        let manifest_ids: Vec<ScenarioId> = SCENARIO_MANIFEST.iter().map(|meta| meta.id).collect();
        assert_eq!(manifest_ids, ScenarioId::ALL.to_vec());

        for meta in SCENARIO_MANIFEST {
            assert!(!meta.label.is_empty());
            assert!(!meta.description.is_empty());
            assert!(!meta.tags.is_empty());
        }
    }

    #[test]
    fn list_scenarios_json_serializes_the_manifest() {
        let parsed: serde_json::Value =
            serde_json::from_str(&list_scenarios_json()).expect("manifest must be valid JSON");
        let scenarios = parsed.as_array().expect("manifest must be an array");

        assert_eq!(scenarios.len(), ScenarioId::ALL.len());
        assert_eq!(scenarios[0]["id"], "ryanmen_protorun");
        assert_eq!(scenarios[0]["category"], "tile_efficiency");
        assert!(scenarios[0]["tags"].is_array());
    }

    #[test]
    fn unknown_categories_fall_back_to_ryanmen_protorun() {
        let state = generate_puzzle("unknown_category").expect("fallback must generate");

        assert_eq!(state.category, "unknown_category");
        assert_eq!(state.players[0].melds.len(), 1);
        assert_eq!(state.correct_action.action_type(), CorrectActionType::Dama);
    }

    #[test]
    fn generate_random_hand_returns_fourteen_tiles() {
        assert_eq!(generate_random_hand().len(), 14);
    }

    #[test]
    fn mock_table_fixture_remains_reachable_for_payload_tests() {
        let state = generate_puzzle("mock_table").expect("mock table fixture must generate");

        assert_eq!(state.category, "mock_table");
    }
}
