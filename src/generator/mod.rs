//! Scenario generators, organized one module per lesson.
//!
//! - `block_theory`: 5-block random hands and the ryanmen protorun lesson.
//! - `chiitoitsu_riichi_vs_dama`: seven-pairs Riichi/dama family.
//! - `shouminkan_decision`: Added Kan decision lesson.
//! - `mock_table`: Phase 2 UI fixture, not a training lesson.
//! - `support`: shared deck, table, scoring, formatting, and retry helpers.

mod block_theory;
mod chiitoitsu_riichi_vs_dama;
mod mock_table;
mod shouminkan_decision;
mod support;

use agari::tile::Tile;

use crate::state::GameState;

pub use support::deck::ALL_TILES;
pub use support::format::format_hand_compact;

pub type PuzzleResponse = GameState;

/// Every scenario the generator can dispatch to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScenarioId {
    RyanmenProtorun,
    ChiitoitsuRiichiVsDama,
    ShouminkanDecision,
    MockTable,
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
            ScenarioId::MockTable => "mock_table",
        }
    }

    /// Resolves an incoming category string.
    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            "ryanmen_protorun" => Some(ScenarioId::RyanmenProtorun),
            "chiitoitsu_riichi_vs_dama" => Some(ScenarioId::ChiitoitsuRiichiVsDama),
            "shouminkan_decision" => Some(ScenarioId::ShouminkanDecision),
            "mock_table" => Some(ScenarioId::MockTable),
            _ => None,
        }
    }

    /// Generates a puzzle for this scenario, echoing `category` in the state.
    pub fn generate(self, category: &str) -> Result<GameState, String> {
        match self {
            ScenarioId::RyanmenProtorun => block_theory::ryanmen_protorun::generate(category),
            ScenarioId::ChiitoitsuRiichiVsDama => chiitoitsu_riichi_vs_dama::generate(category),
            ScenarioId::ShouminkanDecision => shouminkan_decision::generate(category),
            ScenarioId::MockTable => mock_table::generate(category),
        }
    }
}

/// Dispatches to the requested scenario. Unknown categories fall back to
/// the first real Block Theory scenario; "mock_table" keeps the Phase 2
/// fixture available for UI scaffolding and tests.
pub fn generate_puzzle(category: &str) -> Result<GameState, String> {
    match ScenarioId::from_id(category) {
        Some(id) => id.generate(category),
        None => block_theory::ryanmen_protorun::generate(category),
    }
}

/// Standalone function for generating a 14-tile hand via 5-block theory.
pub fn generate_random_hand() -> Vec<Tile> {
    block_theory::random_hand::generate()
}

/// Scenario generator facade kept for the existing library API.
#[derive(Debug, Default, Clone)]
pub struct ScenarioGenerator;

impl ScenarioGenerator {
    pub fn new() -> Self {
        Self
    }

    pub fn generate_random_hand(&self) -> Vec<Tile> {
        generate_random_hand()
    }

    pub fn generate_puzzle(&self, category: &str) -> Result<GameState, String> {
        generate_puzzle(category)
    }
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
    fn unknown_categories_fall_back_to_ryanmen_protorun() {
        let state = generate_puzzle("unknown_category").expect("fallback must generate");

        assert_eq!(state.category, "unknown_category");
        assert_eq!(state.players[0].melds.len(), 1);
        assert_eq!(state.correct_action.action_type(), CorrectActionType::Dama);
    }

    #[test]
    fn scenario_generator_facade_preserves_the_public_api() {
        let generator = ScenarioGenerator::new();

        assert_eq!(generator.generate_random_hand().len(), 14);
        assert_eq!(
            generator
                .generate_puzzle("mock_table")
                .expect("mock table must generate")
                .category,
            "mock_table"
        );
    }
}
