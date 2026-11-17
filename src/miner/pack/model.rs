//! The `riichiprac.scenario-pack` v1 and `riichiprac.scenario-pack-manifest`
//! v1 documents.
//!
//! These mirror the shape `replay-strategy.md` §6.7 defines, extended with the
//! fields implementation unit P1a requires: a complete `source.agents` union
//! with each contributor's licence, `provenance.variant_of`,
//! `provenance.transform_chain`, `provenance.label_check` and `played.agent`.
//!
//! Every document is additive within its schema version: new fields are
//! optional and defaulted, so an older reader keeps working. A field whose
//! meaning or units change is a version bump, and a reader rejects a version it
//! does not know. The one non-additive field is `source.kind`: it deserialises
//! through [`SourceKind`], so anything other than `ai_selfplay` fails before a
//! gate can see it.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::miner::licence::LicenseInfo;
use crate::miner::provenance::{
    AgentKind, AgentSpec, CorpusId, IdError, ReplayId, is_sha256_hex, is_slug,
};
use crate::miner::source::SourceKind;
use crate::miner::transform::TransformChain;
use crate::miner::{JSON_SCHEMA_VERSION, SCENARIO_PACK_MANIFEST_SCHEMA, SCENARIO_PACK_SCHEMA};
use crate::state::{CorrectAction, GameState};

/// Schema name of a shipped pack.
pub const PACK_SCHEMA: &str = SCENARIO_PACK_SCHEMA;

/// Schema name of the pack manifest.
pub const MANIFEST_SCHEMA: &str = SCENARIO_PACK_MANIFEST_SCHEMA;

/// Current pack and manifest schema version.
pub const PACK_VERSION: u32 = JSON_SCHEMA_VERSION;

pub(crate) fn pack_schema() -> String {
    PACK_SCHEMA.to_string()
}

pub(crate) fn manifest_schema() -> String {
    MANIFEST_SCHEMA.to_string()
}

const fn pack_version() -> u32 {
    PACK_VERSION
}

macro_rules! slug_key {
    ($name:ident, $kind:literal) => {
        #[doc = concat!("Validated `", $kind, "` identifier.")]
        #[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub struct $name(String);

        impl $name {
            #[doc = concat!("Parse and validate a `", $kind, "`.")]
            pub fn parse(raw: &str) -> Result<Self, IdError> {
                let trimmed = raw.trim();
                if trimmed.is_empty() {
                    return Err(IdError::Empty { kind: $kind });
                }
                if !is_slug(trimmed) {
                    return Err(IdError::Invalid {
                        kind: $kind,
                        value: trimmed.to_string(),
                        reason: "expected letters, digits, `-`, `_` or `.` (no path separators)",
                    });
                }
                Ok(Self(trimmed.to_string()))
            }

            #[doc = concat!("The canonical `", $kind, "` string.")]
            #[must_use]
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl Serialize for $name {
            fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
            where
                S: serde::Serializer,
            {
                serializer.serialize_str(&self.0)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                let raw = String::deserialize(deserializer)?;
                Self::parse(&raw).map_err(serde::de::Error::custom)
            }
        }
    };
}

slug_key!(PackId, "pack_id");
slug_key!(ScenarioKey, "scenario_id");

/// The build that produced a pack.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackGenerator {
    /// Tool name, normally `mine_replays`.
    pub tool: String,
    /// Tool version.
    pub version: String,
    /// Git commit, or a fixture label such as `fixture`.
    pub commit: String,
    /// Classifier generation the lesson answers were derived with.
    pub classifier_version: String,
}

impl PackGenerator {
    /// The miner's own identity, with a fixture-safe commit label.
    #[must_use]
    pub fn mine_replays(commit: impl Into<String>, classifier_version: impl Into<String>) -> Self {
        Self {
            tool: "mine_replays".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            commit: commit.into(),
            classifier_version: classifier_version.into(),
        }
    }
}

/// One contributing agent, in the pack-level union.
///
/// A pack never names an agent it did not use: the audit compares this union
/// with the seats of every `GameProvenance` the pack references.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PackAgent {
    /// Stable agent id, for example `mortal-298k`.
    pub agent_id: String,
    /// Agent family.
    pub kind: AgentKind,
    /// Engine name.
    pub engine: String,
    /// Engine version.
    pub engine_version: String,
    /// Checkpoint hash when the engine loaded weights.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weights_sha256: Option<String>,
    /// The engine/data licence and attribution.
    pub licence: LicenseInfo,
}

impl PackAgent {
    /// Project one seat record into the pack-level union.
    #[must_use]
    pub fn from_spec(spec: &AgentSpec) -> Self {
        Self {
            agent_id: spec.agent_id.clone(),
            kind: spec.kind,
            engine: spec.engine.clone(),
            engine_version: spec.engine_version.clone(),
            weights_sha256: spec.weights_sha256.clone(),
            licence: spec.licence.clone(),
        }
    }

    /// The key two records must agree on to be the same contributor.
    #[must_use]
    pub fn key(&self) -> String {
        agent_key(&self.agent_id, &self.engine, &self.engine_version)
    }
}

pub(crate) fn agent_key(agent_id: &str, engine: &str, engine_version: &str) -> String {
    format!("{agent_id}\u{1f}{engine}\u{1f}{engine_version}")
}

/// The pack's source and licence declaration.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PackSource {
    /// Replay source. Deserialisation already rejects anything but self-play.
    #[serde(default)]
    pub kind: SourceKind,
    /// Corpus the games came from.
    pub corpus_id: CorpusId,
    /// Data licence id of the pack itself (must be on the data allowlist).
    pub licence: String,
    /// Human-readable data attribution.
    pub attribution: String,
    /// Whether the pack body may be redistributed at all.
    pub redistributable: bool,
    /// Whether the pack data may be used commercially.
    pub data_commercial_use: bool,
    /// Every contributing agent, with its own licence and attribution.
    pub agents: Vec<PackAgent>,
}

/// One numbered Riichi Book 1 section, for picker grouping.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackBook {
    /// Chapter number.
    pub chapter: u8,
    /// Section number inside the chapter.
    pub section: u8,
    /// Stable section key, `ch<chapter>.<section>`.
    pub key: String,
    /// Picker label, for example `ch8.2 · Defense basics`.
    pub label: String,
}

/// One ranked model action recorded with an optional label.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PackRankedAction {
    /// Mortal action name, for example `Discard_1z`.
    pub action: String,
    /// Masked probability.
    pub probability: f32,
    /// Raw Q value in model-utility units, when recorded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub q_value: Option<f32>,
}

/// The optional model label carried by a scenario.
///
/// Q values are model utility, never points: a point-denominated field may only
/// appear under [`PackCounterfactual::calibration_version`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PackMortal {
    /// Checkpoint filename.
    pub model: String,
    /// Checkpoint SHA-256.
    pub model_sha256: String,
    /// Top action name.
    pub top_action: String,
    /// Top-action probability.
    pub top_probability: f32,
    /// `p(top) - p(second)`.
    pub margin: f32,
    /// The value head's estimate for the position.
    pub expected_value: f32,
    /// Units of `expected_value`; [`crate::miner::VALUE_UNITS`].
    pub value_units: String,
    /// Every legal action, highest probability first.
    #[serde(default)]
    pub ranking: Vec<PackRankedAction>,
}

/// Raw Q values and gaps for the counterfactual view.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PackCounterfactual {
    /// Units of every Q value below; [`crate::miner::Q_UNITS`].
    pub q_units: String,
    /// Raw Q value per action name.
    #[serde(default)]
    pub q_values: BTreeMap<String, f32>,
    /// `q(best) - q(second)`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub q_gap_top2: Option<f32>,
    /// `q(best) - q(safest)`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub q_gap_safe: Option<f32>,
    /// `p(best) - p(second)`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub probability_margin: Option<f32>,
    /// The action `q_gap_safe` was measured against.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub safe_action: Option<String>,
    /// Version of the Q→point calibration, when one was applied.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calibration_version: Option<String>,
}

/// Who took the recorded action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlayedKind {
    /// One of the corpus agents.
    Ai,
    /// A human from a third-party log. Never publishable.
    Human,
}

/// The action the seat actually took in the replay.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PackPlayed {
    /// Whether an AI or a human played it.
    pub kind: PlayedKind,
    /// Agent id of the player, required for `kind = "ai"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    /// Mortal action name of the played action.
    pub action: String,
    /// Probability the model gave the played action, when labelled.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mortal_probability: Option<f32>,
}

/// Selection metadata. Never rendered before the answer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PackInterestingness {
    /// Selection score, `0.0..=1.0`.
    pub score: f32,
    /// Whether a book classifier recognises the position.
    pub book_match: bool,
    /// Whether the model's top action is in the accepted set.
    pub mortal_agreement: bool,
    /// Counterfactual tension, `0.0..=1.0`.
    pub counterfactual_tension: f32,
    /// Coverage state, for example `new`.
    pub coverage: String,
    /// Selection tags.
    #[serde(default)]
    pub tags: Vec<String>,
}

/// How a variant's label was re-checked after transformation (V2 gate).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LabelCheckKind {
    /// A book classifier named the same lesson and answer.
    Book,
    /// The model's top action inverse-mapped to the base answer.
    Mortal,
    /// A mistake/played-action lesson still shows the same mistake.
    Mistake,
}

/// The label-preservation record carried by a variant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LabelCheck {
    /// What kind of label was checked.
    pub kind: LabelCheckKind,
    /// Whether the label survived the transform chain.
    pub preserved: bool,
    /// Answer-free note for the report.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// Small, answer-free provenance for one scenario.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PackProvenance {
    /// The raw self-play log the state came from.
    pub replay_id: ReplayId,
    /// Index into the replay's decision/event stream.
    pub decision_index: u64,
    /// Round label such as `E3`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kyoku: Option<String>,
    /// Honba count.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub honba: Option<u8>,
    /// Turn number inside the kyoku.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn: Option<u8>,
    /// Applied transform names, in order (the human-readable copy of
    /// `transform_chain`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub transforms: Vec<String>,
    /// The base scenario this is a variant of.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant_of: Option<ScenarioKey>,
    /// The full transform-chain document the variant was built from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transform_chain: Option<TransformChain>,
    /// The label-preservation check that admitted the variant.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label_check: Option<LabelCheck>,
}

impl PackProvenance {
    /// Whether this scenario was built by a transform chain.
    #[must_use]
    pub fn is_variant(&self) -> bool {
        self.variant_of.is_some()
            || self
                .transform_chain
                .as_ref()
                .is_some_and(|chain| !chain.is_empty())
    }
}

/// Build-time validation record. The loader still revalidates the state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackValidation {
    /// `validate_reachable_state` passed.
    pub state_valid: bool,
    /// The state round-tripped through the replay walker.
    #[serde(default)]
    pub replay_roundtrip: bool,
    /// The answer was recomputed from the state, not trusted.
    pub answer_recomputed: bool,
    /// The answer is reachable from visible information only.
    pub visible_info_only: bool,
}

impl PackValidation {
    /// The build-time record for a generated fixture state.
    #[must_use]
    pub fn fixture() -> Self {
        Self {
            state_valid: true,
            // A generated fixture has no replay behind it.
            replay_roundtrip: false,
            answer_recomputed: true,
            visible_info_only: true,
        }
    }
}

/// One drillable scenario inside a pack.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PackScenario {
    /// Stable scenario id inside the pack.
    pub id: ScenarioKey,
    /// Lesson the scenario teaches; must match the state's `category`.
    pub lesson_id: String,
    /// The Riichi Book 1 section, when the lesson has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub book: Option<PackBook>,
    /// Answer-free title for the picker.
    pub title: String,
    /// Answer-free prompt shown before the answer.
    pub prompt: String,
    /// The complete app state, including its own answer fields.
    pub state: GameState,
    /// The graded answer. Duplicated from `state` on purpose; the audit
    /// recomputes and rejects a mismatch.
    pub correct_action: CorrectAction,
    /// Every tile/action that grades as correct: the answer plus the state's
    /// `equivalent_tiles`, sorted.
    pub accepted: Vec<String>,
    /// Optional model label.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mortal: Option<PackMortal>,
    /// Optional raw Q values.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub counterfactual: Option<PackCounterfactual>,
    /// What the seat actually played.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub played: Option<PackPlayed>,
    /// Selection metadata.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interestingness: Option<PackInterestingness>,
    /// Where the scenario came from.
    pub provenance: PackProvenance,
    /// Build-time validation record.
    pub validation: PackValidation,
}

/// A shipped scenario pack (`riichiprac.scenario-pack` v1).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Pack {
    /// Schema name; [`PACK_SCHEMA`].
    #[serde(default = "pack_schema")]
    pub schema: String,
    /// Schema version; [`PACK_VERSION`].
    #[serde(default = "pack_version")]
    pub version: u32,
    /// Pack id, also the filename prefix.
    pub pack_id: PackId,
    /// ISO-8601 generation timestamp.
    pub generated_at: String,
    /// The build that produced the pack.
    pub generator: PackGenerator,
    /// Source and licence declaration.
    pub source: PackSource,
    /// The drills.
    pub scenarios: Vec<PackScenario>,
}

impl Pack {
    /// Every lesson id in the pack, sorted and unique.
    #[must_use]
    pub fn lesson_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .scenarios
            .iter()
            .map(|scenario| scenario.lesson_id.clone())
            .collect();
        ids.sort();
        ids.dedup();
        ids
    }

    /// Every book section key in the pack, sorted and unique.
    #[must_use]
    pub fn book_sections(&self) -> Vec<String> {
        let mut sections: Vec<String> = self
            .scenarios
            .iter()
            .filter_map(|scenario| scenario.book.as_ref().map(|book| book.key.clone()))
            .collect();
        sections.sort();
        sections.dedup();
        sections
    }

    /// Whether a consumer needs the model to show every label.
    ///
    /// True when at least one scenario has no precomputed label; the answer is
    /// always gradable without weights.
    #[must_use]
    pub fn requires_model(&self) -> bool {
        self.scenarios
            .iter()
            .any(|scenario| scenario.mortal.is_none())
    }

    /// Housekeeping: every agent named by the source, sorted by key.
    #[must_use]
    pub fn agents(&self) -> Vec<&PackAgent> {
        let mut agents: Vec<&PackAgent> = self.source.agents.iter().collect();
        agents.sort_by_key(|agent| agent.key());
        agents
    }
}

/// One entry in the runtime manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManifestEntry {
    /// Pack id.
    pub id: PackId,
    /// Safe relative path from the manifest's directory to the pack body.
    pub path: String,
    /// SHA-256 of the exact pack file bytes.
    pub sha256: String,
    /// Pack file length in bytes.
    pub bytes: u64,
    /// Number of scenarios in the body.
    pub scenario_count: u32,
    /// Lesson ids, sorted and unique.
    pub lesson_ids: Vec<String>,
    /// Book section keys, sorted and unique.
    pub book_sections: Vec<String>,
    /// Pack data licence id.
    pub licence: String,
    /// Whether the model is needed for the pack's labels.
    pub requires_model: bool,
    /// Whether the pack data may be used commercially.
    #[serde(default)]
    pub data_commercial_use: bool,
}

impl ManifestEntry {
    /// Build the entry a publisher writes for an encoded body.
    #[must_use]
    pub fn new(
        pack: &Pack,
        path: impl Into<String>,
        sha256: impl Into<String>,
        bytes: u64,
    ) -> Self {
        Self {
            id: pack.pack_id.clone(),
            path: path.into(),
            sha256: sha256.into(),
            bytes,
            scenario_count: u32::try_from(pack.scenarios.len()).unwrap_or(u32::MAX),
            lesson_ids: pack.lesson_ids(),
            book_sections: pack.book_sections(),
            licence: pack.source.licence.clone(),
            requires_model: pack.requires_model(),
            data_commercial_use: pack.source.data_commercial_use,
        }
    }

    /// Whether the entry's hash is a well-formed SHA-256.
    #[must_use]
    pub fn has_valid_hash(&self) -> bool {
        is_sha256_hex(&self.sha256)
    }
}

/// The runtime manifest (`riichiprac.scenario-pack-manifest` v1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackManifest {
    /// Schema name; [`MANIFEST_SCHEMA`].
    #[serde(default = "manifest_schema")]
    pub schema: String,
    /// Schema version; [`PACK_VERSION`].
    #[serde(default = "pack_version")]
    pub version: u32,
    /// ISO-8601 update timestamp.
    pub updated_at: String,
    /// One entry per pack, sorted by id.
    pub packs: Vec<ManifestEntry>,
}

impl PackManifest {
    /// An empty manifest.
    #[must_use]
    pub fn new(updated_at: impl Into<String>) -> Self {
        Self {
            schema: manifest_schema(),
            version: pack_version(),
            updated_at: updated_at.into(),
            packs: Vec::new(),
        }
    }

    /// Insert or replace one entry, keeping the manifest sorted by id.
    pub fn upsert(&mut self, entry: ManifestEntry) {
        self.packs.retain(|existing| existing.id != entry.id);
        self.packs.push(entry);
        self.packs.sort_by(|a, b| a.id.as_str().cmp(b.id.as_str()));
    }

    /// Find one entry.
    #[must_use]
    pub fn entry(&self, id: &PackId) -> Option<&ManifestEntry> {
        self.packs.iter().find(|entry| &entry.id == id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pack_and_scenario_ids_reject_paths() {
        for bad in [
            "",
            "../pack",
            "a/b",
            "a\\b",
            "..",
            "a b",
            "x".repeat(100).as_str(),
        ] {
            assert!(PackId::parse(bad).is_err(), "{bad} must be rejected");
            assert!(ScenarioKey::parse(bad).is_err(), "{bad} must be rejected");
        }
        assert_eq!(
            PackId::parse("replay.ch8-defense.2026-11")
                .expect("slug")
                .as_str(),
            "replay.ch8-defense.2026-11"
        );
    }

    #[test]
    fn manifest_upsert_replaces_and_sorts() {
        let mut manifest = PackManifest::new("2026-11-16T00:00:00Z");
        let entry = |id: &str, path: &str| ManifestEntry {
            id: PackId::parse(id).expect("id"),
            path: path.to_string(),
            sha256: "a".repeat(64),
            bytes: 10,
            scenario_count: 1,
            lesson_ids: vec!["lesson".to_string()],
            book_sections: vec![],
            licence: "CC-BY-4.0".to_string(),
            requires_model: false,
            data_commercial_use: true,
        };
        manifest.upsert(entry("b.pack", "b.json.gz"));
        manifest.upsert(entry("a.pack", "a.json.gz"));
        manifest.upsert(entry("b.pack", "b2.json.gz"));

        let ids: Vec<&str> = manifest.packs.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, vec!["a.pack", "b.pack"]);
        assert_eq!(
            manifest
                .entry(&PackId::parse("b.pack").expect("id"))
                .map(|e| e.path.as_str()),
            Some("b2.json.gz")
        );
    }
}
