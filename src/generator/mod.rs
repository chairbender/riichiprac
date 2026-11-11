//! Scenario generators, organized one module per lesson.
//!
//! - `block_theory`: 5-block random hands and the ryanmen protorun lesson.
//! - `chiitoitsu_riichi_vs_dama`: seven-pairs Riichi/dama family.
//! - `defense`: pure-defense "safest discard" lessons from the ch. 8 chart.
//! - `shouminkan_decision`: Added Kan decision lesson.
//! - `support`: shared deck, table, scoring, formatting, and retry helpers.
//!
//! The Phase 2 `mock_table` fixture lives in `crate::fixtures`, outside the
//! lesson registry.

pub mod ai_best_action;
mod block_theory;
mod chiitoitsu_riichi_vs_dama;
mod defense;
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
    AiDecision,
    DefenseDecision,
}

impl ScenarioCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            ScenarioCategory::TileEfficiency => "tile_efficiency",
            ScenarioCategory::RiichiDecision => "riichi_decision",
            ScenarioCategory::KanDecision => "kan_decision",
            ScenarioCategory::AiDecision => "ai_decision",
            ScenarioCategory::DefenseDecision => "defense_decision",
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
    /// True when generation needs the loaded Mortal evaluator.
    pub requires_ai: bool,
    /// Which perspectives grade this lesson.
    pub grading: ScenarioGrading,
}

/// How an answer is graded for a lesson.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScenarioGrading {
    /// A book rule plus Mortal when the model is loaded.
    BookAndMortal,
    /// The state's answer is the model's own action; there is no book rule.
    MortalOnly,
}

impl ScenarioGrading {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::BookAndMortal => "book_and_mortal",
            Self::MortalOnly => "mortal_only",
        }
    }
}

/// The user-facing scenario catalogue. Fixtures are deliberately excluded.
pub const SCENARIO_MANIFEST: &[ScenarioMeta] = &[
    ScenarioMeta {
        id: ScenarioId::RyanmenProtorun,
        label: "Ryanmen Protorun",
        description: "Block theory: choose the discard that keeps the ryanmen wait.",
        category: ScenarioCategory::TileEfficiency,
        tags: &["block_theory", "discard", "ryanmen"],
        requires_ai: false,
        grading: ScenarioGrading::BookAndMortal,
    },
    ScenarioMeta {
        id: ScenarioId::ChiitoitsuRiichiVsDama,
        label: "Chiitoitsu Riichi vs Dama",
        description: "Seven pairs: decide whether to declare Riichi or stay dama.",
        category: ScenarioCategory::RiichiDecision,
        tags: &["chiitoitsu", "riichi", "dama"],
        requires_ai: false,
        grading: ScenarioGrading::BookAndMortal,
    },
    ScenarioMeta {
        id: ScenarioId::ShouminkanDecision,
        label: "Added Kan Decision",
        description: "Open Pon, fourth tile drawn: decide whether to upgrade to an Added Kan.",
        category: ScenarioCategory::KanDecision,
        tags: &["kan", "shouminkan"],
        requires_ai: false,
        grading: ScenarioGrading::BookAndMortal,
    },
    ScenarioMeta {
        id: ScenarioId::ShouminkanDecline,
        label: "Decline the Kan",
        description: "Open Pon, fourth tile drawn, hand still 2-away with value: keep the Pon and discard.",
        category: ScenarioCategory::KanDecision,
        tags: &["kan", "shouminkan", "decline"],
        requires_ai: false,
        grading: ScenarioGrading::BookAndMortal,
    },
    ScenarioMeta {
        id: ScenarioId::AiBestAction,
        label: "AI Best Action",
        description: "Any decision: discard, call, or win — the answer is Mortal v4's top action.",
        category: ScenarioCategory::AiDecision,
        tags: &["ai", "mortal", "discard", "call", "any_decision"],
        requires_ai: true,
        grading: ScenarioGrading::MortalOnly,
    },
    ScenarioMeta {
        id: ScenarioId::DefenseSafetyChart,
        label: "Defense: Safest Discard",
        description: "An opponent has declared Riichi: discard the tile the book's safety chart ranks safest.",
        category: ScenarioCategory::DefenseDecision,
        tags: &["defense", "betaori", "safety_chart", "suji", "genbutsu"],
        requires_ai: false,
        grading: ScenarioGrading::BookAndMortal,
    },
    ScenarioMeta {
        id: ScenarioId::DefenseStuckHeuristic,
        label: "Defense: Nothing Is Safe",
        description: "No tile is identified as safe: apply the book's fallback and break up the pair.",
        category: ScenarioCategory::DefenseDecision,
        tags: &["defense", "betaori", "heuristic", "pairs", "discard"],
        requires_ai: false,
        grading: ScenarioGrading::BookAndMortal,
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
        requires_ai: bool,
        grading: &'static str,
    }

    let scenarios: Vec<ScenarioMetaJson> = SCENARIO_MANIFEST
        .iter()
        .map(|meta| ScenarioMetaJson {
            id: meta.id.as_str(),
            label: meta.label,
            description: meta.description,
            category: meta.category.as_str(),
            tags: meta.tags,
            requires_ai: meta.requires_ai,
            grading: meta.grading.as_str(),
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
    ShouminkanDecline,
    AiBestAction,
    DefenseSafetyChart,
    DefenseStuckHeuristic,
}

impl ScenarioId {
    /// Every real scenario, excluding the UI fixture.
    pub const ALL: &'static [ScenarioId] = &[
        ScenarioId::RyanmenProtorun,
        ScenarioId::ChiitoitsuRiichiVsDama,
        ScenarioId::ShouminkanDecision,
        ScenarioId::ShouminkanDecline,
        ScenarioId::AiBestAction,
        ScenarioId::DefenseSafetyChart,
        ScenarioId::DefenseStuckHeuristic,
    ];

    /// The category string understood by the WASM API.
    pub fn as_str(self) -> &'static str {
        match self {
            ScenarioId::RyanmenProtorun => "ryanmen_protorun",
            ScenarioId::ChiitoitsuRiichiVsDama => "chiitoitsu_riichi_vs_dama",
            ScenarioId::ShouminkanDecision => "shouminkan_decision",
            ScenarioId::ShouminkanDecline => "shouminkan_decline",
            ScenarioId::AiBestAction => "ai_best_action",
            ScenarioId::DefenseSafetyChart => "defense_safety_chart",
            ScenarioId::DefenseStuckHeuristic => "defense_stuck_heuristic",
        }
    }

    /// Resolves an incoming category string.
    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            "ryanmen_protorun" => Some(ScenarioId::RyanmenProtorun),
            "chiitoitsu_riichi_vs_dama" => Some(ScenarioId::ChiitoitsuRiichiVsDama),
            "shouminkan_decision" => Some(ScenarioId::ShouminkanDecision),
            "shouminkan_decline" => Some(ScenarioId::ShouminkanDecline),
            "ai_best_action" => Some(ScenarioId::AiBestAction),
            "defense_safety_chart" => Some(ScenarioId::DefenseSafetyChart),
            "defense_stuck_heuristic" => Some(ScenarioId::DefenseStuckHeuristic),
            _ => None,
        }
    }

    /// Generates a puzzle for this scenario, echoing `category` in the state.
    pub fn generate(self, category: &str) -> Result<GameState, String> {
        match self {
            ScenarioId::RyanmenProtorun => block_theory::ryanmen_protorun::generate(category),
            ScenarioId::ChiitoitsuRiichiVsDama => chiitoitsu_riichi_vs_dama::generate(category),
            ScenarioId::ShouminkanDecision => shouminkan_decision::generate(category),
            ScenarioId::ShouminkanDecline => shouminkan_decision::generate_decline(category),
            ScenarioId::AiBestAction => Err(
                "ai_best_action requires the loaded Mortal model; use the evaluator's \
                 generate_ai_puzzle"
                    .to_string(),
            ),
            ScenarioId::DefenseSafetyChart => defense::generate_safety_chart(category),
            ScenarioId::DefenseStuckHeuristic => defense::generate_stuck(category),
        }
    }
}

/// Dispatches to the requested scenario. Unknown categories fall back to
/// the first real Block Theory scenario. The `mock_table` fixture is handled
/// separately so it stays out of the lesson manifest.
pub fn generate_puzzle(category: &str) -> Result<GameState, String> {
    if category == "mock_table" {
        // The fixture is a fixed UI mock, not a played-out table, so it is not
        // held to the reachability rules.
        return Ok(finalize_state(crate::fixtures::mock_table::generate(
            category,
        )?));
    }

    let mut last_error = String::new();
    for _ in 0..MAX_REACHABILITY_ATTEMPTS {
        let state = match ScenarioId::from_id(category) {
            Some(id) => id.generate(category)?,
            None => block_theory::ryanmen_protorun::generate(category)?,
        };

        // Final guard: a lesson may have shaped its rivers and melds freely,
        // but the finished table still has to be a position a real game could
        // have produced.
        match support::state_validation::validate_reachable_state(&state) {
            Ok(()) => return Ok(finalize_state(state)),
            Err(err) => last_error = err,
        }
    }

    Err(format!(
        "generated {category} states were never reachable after \
         {MAX_REACHABILITY_ATTEMPTS} attempts: {last_error}"
    ))
}

/// How many full generations to try before the reachability guard gives up.
const MAX_REACHABILITY_ATTEMPTS: usize = 8;

/// Attach derived fields that must never be trusted from a generator literal.
///
/// The book rationale is a pure function of the state plus the static rule
/// table, so it is stamped once at the generation boundary and recomputed on
/// report import.
pub fn finalize_state(mut state: GameState) -> GameState {
    state.book_rationale = crate::rationale::rationale_for(&state);
    state
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
            if id == ScenarioId::AiBestAction {
                assert!(id.generate(id.as_str()).is_err());
                continue;
            }
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
        assert_eq!(scenarios[0]["requires_ai"], false);
        assert!(scenarios[0]["tags"].is_array());
        assert!(
            scenarios
                .iter()
                .any(|scenario| scenario["id"] == "ai_best_action"
                    && scenario["requires_ai"] == true)
        );
        assert!(
            scenarios
                .iter()
                .any(|scenario| scenario["id"] == "defense_safety_chart"
                    && scenario["category"] == "defense_decision")
        );
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

    #[test]
    fn every_generated_lesson_is_a_reachable_table() {
        use crate::generator::support::state_validation::validate_reachable_state;

        for &id in ScenarioId::ALL {
            if id == ScenarioId::AiBestAction {
                continue;
            }
            for run in 0..30 {
                let state = generate_puzzle(id.as_str())
                    .unwrap_or_else(|err| panic!("{} run {run} failed: {err}", id.as_str()));
                validate_reachable_state(&state).unwrap_or_else(|err| {
                    panic!(
                        "{} run {run} produced an unreachable table: {err}",
                        id.as_str()
                    )
                });
            }
        }
    }

    #[test]
    fn generated_rivers_never_invent_extra_discards() {
        use crate::generator::support::state_validation::validate_reachable_state;

        // The reported defect: one seat's river was two entries longer than the
        // others with no call to explain it. Every lesson must now keep the
        // rivers within one call's worth of the rotation.
        for category in [
            "ryanmen_protorun",
            "chiitoitsu_riichi_vs_dama",
            "shouminkan_decision",
            "shouminkan_decline",
            "defense_safety_chart",
            "defense_stuck_heuristic",
        ] {
            for run in 0..20 {
                let state = generate_puzzle(category)
                    .unwrap_or_else(|err| panic!("{category} run {run} failed: {err}"));
                validate_reachable_state(&state)
                    .unwrap_or_else(|err| panic!("{category} run {run}: {err}"));

                let counts: Vec<usize> = state
                    .players
                    .iter()
                    .map(|player| player.discards.len())
                    .collect();
                let calls: usize = state.players.iter().map(|player| player.melds.len()).sum();
                let spread = counts.iter().max().unwrap() - counts.iter().min().unwrap();
                assert!(
                    spread <= 1 + calls,
                    "{category} run {run}: rivers {counts:?} with {calls} calls"
                );
            }
        }
    }
}
