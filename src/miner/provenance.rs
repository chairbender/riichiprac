//! Provenance contracts shared by the corpus runner and every later miner unit.
//!
//! These types are the JSON documents named in [`crate::miner`]:
//! [`GameProvenance`] (`riichiprac.corpus-game` v1) and [`MatchPlan`]
//! (`riichiprac.corpus-match-plan` v1). They are deliberately strict: an
//! unknown source fails to deserialize, an unknown licence fails validation,
//! and a log path is only accepted relative to the data root. Later units may
//! add optional fields under the additive versioning rule; they may not invent
//! a second shape for the same record.

use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use super::licence::{LicenceError, LicenseInfo};
use super::source::{SourceError, SourceGate, SourceKind};
use super::storage::{self, StorageError};
use super::{CORPUS_GAME_SCHEMA, CORPUS_MATCH_PLAN_SCHEMA, JSON_SCHEMA_VERSION, TENHOU_4P_HANCHAN};

/// Domain separation is not needed for content hashes; this is plain SHA-256.
pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;

    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        // Writing into a String cannot fail.
        let _ = write!(&mut out, "{byte:02x}");
    }
    out
}

/// Whether `value` is a 64-character hex SHA-256, optionally `sha256:`-prefixed.
#[must_use]
pub fn is_sha256_hex(value: &str) -> bool {
    let raw = value.strip_prefix("sha256:").unwrap_or(value);
    raw.len() == 64 && raw.bytes().all(|b| b.is_ascii_hexdigit())
}

fn is_slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value != "."
        && value != ".."
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// Typed identifier rejection.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum IdError {
    #[error("`{kind}` is empty")]
    Empty { kind: &'static str },
    #[error("`{kind}` `{value}` is invalid: {reason}")]
    Invalid {
        kind: &'static str,
        value: String,
        reason: &'static str,
    },
}

/// Content-addressed replay id: the SHA-256 of the canonical raw mjai log.
///
/// Stored as bare lowercase hex (64 characters). A `sha256:` prefix is accepted
/// on input and stripped so both spellings cannot produce different ids. The
/// value is also the raw-log filename under `replays/<family>/`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ReplayId(String);

impl ReplayId {
    /// Hash canonical raw log bytes.
    #[must_use]
    pub fn from_bytes(bytes: &[u8]) -> Self {
        Self(sha256_hex(bytes))
    }

    /// Parse and normalise a replay id.
    pub fn parse(raw: &str) -> Result<Self, IdError> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err(IdError::Empty { kind: "replay_id" });
        }
        let hex = trimmed.strip_prefix("sha256:").unwrap_or(trimmed);
        if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(IdError::Invalid {
                kind: "replay_id",
                value: trimmed.to_string(),
                reason: "expected a 64-character hex SHA-256",
            });
        }
        Ok(Self(hex.to_ascii_lowercase()))
    }

    /// Bare lowercase hex.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for ReplayId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl Serialize for ReplayId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for ReplayId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = String::deserialize(deserializer)?;
        Self::parse(&raw).map_err(serde::de::Error::custom)
    }
}

macro_rules! slug_id {
    ($name:ident, $kind:literal) => {
        #[doc = concat!("Validated `", $kind, "` identifier.")]
        #[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub struct $name(String);

        impl $name {
            #[doc = concat!("Parse a `", $kind, "`.")]
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
                D: Deserializer<'de>,
            {
                let raw = String::deserialize(deserializer)?;
                Self::parse(&raw).map_err(serde::de::Error::custom)
            }
        }
    };
}

slug_id!(CorpusId, "corpus_id");
slug_id!(MatchPlanId, "match_plan_id");

/// Rule profile recorded with every game and match plan.
///
/// The app's [`crate::state::GameState`] represents the Tenhou four-player
/// hanchan profile. The exact engine settings are recorded here so a different
/// game cannot be silently normalised into that state model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuleProfile {
    /// Canonical profile name; [`TENHOU_4P_HANCHAN`] is the only supported one.
    pub profile: String,
    /// Hash of the engine's full rule configuration object.
    pub config_hash: String,
    /// Number of red fives in play.
    #[serde(default = "default_red_fives")]
    pub red_fives: u8,
    /// Whether kuitan (open tanyao) is enabled.
    #[serde(default = "default_true")]
    pub kuitan: bool,
    /// Starting score.
    #[serde(default = "default_starting_score")]
    pub starting_score: u32,
    /// Target/return score.
    #[serde(default = "default_return_score")]
    pub return_score: u32,
    /// Engine uma setting, copied verbatim. Not used by the app state model.
    #[serde(default)]
    pub uma: Vec<i32>,
    /// Whether kan dora is enabled.
    #[serde(default = "default_true")]
    pub kan_dora: bool,
}

fn default_red_fives() -> u8 {
    3
}
fn default_true() -> bool {
    true
}
fn default_starting_score() -> u32 {
    25_000
}
fn default_return_score() -> u32 {
    30_000
}

impl RuleProfile {
    /// The supported Tenhou four-player hanchan profile.
    ///
    /// `uma` is copied from the engine because it is an operator/match-plan
    /// setting, not an app constant; the state model does not use it.
    #[must_use]
    pub fn tenhou_4p_hanchan(config_hash: impl Into<String>, uma: [i32; 4]) -> Self {
        Self {
            profile: TENHOU_4P_HANCHAN.to_string(),
            config_hash: config_hash.into(),
            red_fives: default_red_fives(),
            kuitan: true,
            starting_score: default_starting_score(),
            return_score: default_return_score(),
            uma: uma.to_vec(),
            kan_dora: true,
        }
    }

    /// Reject a rule profile the app cannot represent.
    pub fn validate(&self) -> Result<(), ProvenanceError> {
        if self.profile.trim() != TENHOU_4P_HANCHAN {
            return Err(ProvenanceError::UnsupportedRuleProfile(
                self.profile.clone(),
            ));
        }
        if self.config_hash.trim().is_empty() {
            return Err(ProvenanceError::EmptyRuleConfigHash);
        }
        if self.uma.len() != 4 {
            return Err(ProvenanceError::UmaLength(self.uma.len()));
        }
        if !self.kuitan {
            return Err(ProvenanceError::UnsupportedRule(
                "kuitan must be enabled".to_string(),
            ));
        }
        if self.red_fives != 3 {
            return Err(ProvenanceError::UnsupportedRule(format!(
                "expected 3 red fives, found {}",
                self.red_fives
            )));
        }
        if self.starting_score != default_starting_score() {
            return Err(ProvenanceError::UnsupportedRule(format!(
                "expected a 25000 starting score, found {}",
                self.starting_score
            )));
        }
        if self.return_score != default_return_score() {
            return Err(ProvenanceError::UnsupportedRule(format!(
                "expected a 30000 return score, found {}",
                self.return_score
            )));
        }
        if !self.kan_dora {
            return Err(ProvenanceError::UnsupportedRule(
                "kan dora must be enabled".to_string(),
            ));
        }
        Ok(())
    }
}

/// What kind of policy occupied a seat.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentKind {
    /// A neural policy such as `mortal_298k`.
    Neural,
    /// A rule-based engine such as Akochan.
    Rule,
    /// One of the corpus-repo reference heuristics (H0–H3).
    Heuristic,
    /// Anything launched as an external process.
    External,
}

/// Identity, configuration, sampling and licence of one seat.
///
/// A name alone is not provenance: the full engine `config` and its canonical
/// hash are recorded, along with the seed (or an explicit `reproducible: false`)
/// and the data licence.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentSpec {
    /// Seat index 0..=3 in the resolved game, before actor normalisation.
    pub seat: u8,
    /// Stable agent id, for example `mortal-298k` or `heuristic-v1`.
    pub agent_id: String,
    /// Agent family.
    pub kind: AgentKind,
    /// Engine name, for example `libriichi` or `akochan`.
    pub engine: String,
    /// Engine version string.
    pub engine_version: String,
    /// Hash of the engine binary/crate, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine_sha256: Option<String>,
    /// Hash of the loaded weights, when the engine has any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weights_sha256: Option<String>,
    /// Full engine configuration object.
    pub config: serde_json::Value,
    /// Canonical hash of `config`.
    pub config_hash: String,
    /// Canonical temperature-like sampling knob, when the engine exposes one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    /// Engine sampling mode, for example `argmax`, `softmax`, `deterministic`
    /// or `boltzmann_epsilon`. A string because engines name this differently.
    pub sampling: String,
    /// Per-seat seed, when the engine accepts one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed: Option<String>,
    /// Whether `(seed, config)` can reproduce the game. `false` is honest, not
    /// an error; a game that claims reproducibility must carry its seed.
    pub reproducible: bool,
    /// Code/data licence and attribution for this agent.
    pub licence: LicenseInfo,
}

impl AgentSpec {
    /// Validate the seat record and the nested licence.
    pub fn validate(&self) -> Result<(), ProvenanceError> {
        if self.seat > 3 {
            return Err(ProvenanceError::SeatOutOfRange(self.seat));
        }
        for (field, value) in [
            ("agent_id", self.agent_id.as_str()),
            ("engine", self.engine.as_str()),
            ("engine_version", self.engine_version.as_str()),
            ("sampling", self.sampling.as_str()),
            ("config_hash", self.config_hash.as_str()),
        ] {
            if value.trim().is_empty() {
                return Err(ProvenanceError::EmptyAgentField {
                    seat: self.seat,
                    field,
                });
            }
        }
        if !self.config.is_object() {
            return Err(ProvenanceError::AgentConfigNotObject { seat: self.seat });
        }
        if !is_sha256_hex(&self.config_hash) {
            return Err(ProvenanceError::InvalidHash {
                field: "config_hash",
                value: self.config_hash.clone(),
            });
        }
        if let Some(temperature) = self.temperature
            && !temperature.is_finite()
        {
            return Err(ProvenanceError::InvalidTemperature { seat: self.seat });
        }
        if self.reproducible && self.seed.as_deref().map(str::trim).unwrap_or("").is_empty() {
            return Err(ProvenanceError::MissingSeed { seat: self.seat });
        }
        self.licence
            .validate()
            .map_err(|source| ProvenanceError::SeatLicence {
                seat: self.seat,
                source,
            })
    }
}

/// The corpus-repo build that generated a game.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GeneratorInfo {
    /// Repository name, for example `riichiprac-corpus`.
    pub repo: String,
    /// Tool version.
    pub version: String,
    /// Git commit, or `unknown` only for local experiments.
    pub commit: String,
}

impl GeneratorInfo {
    fn validate(&self) -> Result<(), ProvenanceError> {
        for (field, value) in [
            ("generator.repo", self.repo.as_str()),
            ("generator.version", self.version.as_str()),
            ("generator.commit", self.commit.as_str()),
        ] {
            if value.trim().is_empty() {
                return Err(ProvenanceError::EmptyField { field });
            }
        }
        Ok(())
    }
}

/// Reference to the immutable raw log, relative to the data root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogRef {
    /// Log format; only `mjai` is accepted as an input.
    pub format: String,
    /// Path relative to `RIICHI_DATA_DIR`, never absolute.
    pub path: String,
    /// Exact byte length on disk.
    pub bytes: u64,
    /// SHA-256 of the raw log; equals the [`ReplayId`].
    pub sha256: ReplayId,
}

/// Overall replay validation state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ValidationStatus {
    /// Parsed and structurally valid.
    Ok,
    /// Structurally invalid; keep the row for diagnosis, never select it.
    Bad,
    /// Parsed but some ledger/timing check is incomplete.
    Partial,
}

/// Structural validation summary recorded with the game.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ValidationSummary {
    /// Overall status.
    pub status: ValidationStatus,
    /// Events processed.
    pub events: u64,
    /// Tile conservation passed.
    #[serde(default)]
    pub tile_ledger: bool,
    /// Score deltas passed.
    #[serde(default)]
    pub score_ledger: bool,
    /// Rule profile matched the match plan.
    #[serde(default)]
    pub rule_profile_match: bool,
}

impl ValidationSummary {
    /// Whether the game may feed a candidate or a pack.
    #[must_use]
    pub fn is_publishable(&self) -> bool {
        self.status == ValidationStatus::Ok
            && self.events > 0
            && self.tile_ledger
            && self.score_ledger
            && self.rule_profile_match
    }
}

/// One generated game's complete provenance (`riichiprac.corpus-game` v1).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GameProvenance {
    /// Schema name; [`CORPUS_GAME_SCHEMA`].
    #[serde(default = "crate::miner::corpus_game_schema")]
    pub schema: String,
    /// Schema version; [`JSON_SCHEMA_VERSION`].
    #[serde(default = "crate::miner::json_schema_version")]
    pub version: u32,
    /// Content-addressed replay id.
    pub replay_id: ReplayId,
    /// Corpus this game belongs to.
    pub corpus_id: CorpusId,
    /// Matchup family, for example `mortal_mirror` or `rule_baseline`.
    pub family: String,
    /// Match plan used to generate this game.
    pub match_plan_id: MatchPlanId,
    /// Hash of the match plan document.
    pub match_plan_sha256: String,
    /// Replay source. Deserialisation already rejects anything but self-play.
    #[serde(default)]
    pub source: SourceKind,
    /// Rule profile actually used at the table.
    pub rule: RuleProfile,
    /// ISO-8601 generation timestamp.
    pub generated_at: String,
    /// The corpus-repo build.
    pub generator: GeneratorInfo,
    /// Corpus-level game seed.
    pub game_seed: String,
    /// Seat rotation schedule label.
    pub seat_schedule: String,
    /// All four seats, in resolved seat order.
    pub seats: Vec<AgentSpec>,
    /// The raw log.
    pub log: LogRef,
    /// Structural validation.
    pub validation: ValidationSummary,
    /// Whether the game mixed engines at the same table (as opposed to a
    /// corpus-level mix).
    #[serde(default)]
    pub cross_engine: bool,
    /// Sampling-variety label, for example `sampling` for M2.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy_variety: Option<String>,
}

impl GameProvenance {
    /// Validate schema, source, seats, rule, log path and licence.
    pub fn validate(&self) -> Result<(), ProvenanceError> {
        if self.schema != CORPUS_GAME_SCHEMA {
            return Err(ProvenanceError::WrongSchema {
                found: self.schema.clone(),
                expected: CORPUS_GAME_SCHEMA,
            });
        }
        if self.version != JSON_SCHEMA_VERSION {
            return Err(ProvenanceError::UnsupportedVersion {
                found: self.version,
                expected: JSON_SCHEMA_VERSION,
            });
        }
        SourceGate::require(&self.source)?;
        if !is_slug(&self.family) {
            return Err(ProvenanceError::InvalidSlug {
                field: "family",
                value: self.family.clone(),
            });
        }
        if !is_sha256_hex(&self.match_plan_sha256) {
            return Err(ProvenanceError::InvalidHash {
                field: "match_plan_sha256",
                value: self.match_plan_sha256.clone(),
            });
        }
        self.rule.validate()?;
        if self.generated_at.trim().is_empty() {
            return Err(ProvenanceError::EmptyField {
                field: "generated_at",
            });
        }
        self.generator.validate()?;
        if self.game_seed.trim().is_empty() {
            return Err(ProvenanceError::EmptyField { field: "game_seed" });
        }
        if self.seat_schedule.trim().is_empty() {
            return Err(ProvenanceError::EmptyField {
                field: "seat_schedule",
            });
        }
        validate_seats(&self.seats)?;
        if self.log.format != "mjai" {
            return Err(ProvenanceError::LogFormat(self.log.format.clone()));
        }
        if self.log.bytes == 0 {
            return Err(ProvenanceError::EmptyLog);
        }
        if !self.log.path.ends_with(".jsonl.gz") {
            return Err(ProvenanceError::LogPathNotMjaiGz(self.log.path.clone()));
        }
        // Relative-path rule, including no `..` and no absolute paths.
        storage::validate_relative_path(&self.log.path)?;
        let expected_path = storage::DataRoot::replay_relative_path(&self.family, &self.replay_id)?;
        if self.log.path != expected_path {
            return Err(ProvenanceError::UnexpectedLogPath {
                found: self.log.path.clone(),
                expected: expected_path,
            });
        }
        if self.log.sha256 != self.replay_id {
            return Err(ProvenanceError::ReplayHashMismatch {
                replay_id: self.replay_id.to_string(),
                log_sha256: self.log.sha256.to_string(),
            });
        }
        if let Some(variety) = &self.policy_variety
            && variety.trim().is_empty()
        {
            return Err(ProvenanceError::EmptyField {
                field: "policy_variety",
            });
        }
        Ok(())
    }

    /// Whether this game may feed a candidate or a shipped pack.
    #[must_use]
    pub fn is_publishable(&self) -> bool {
        self.validate().is_ok() && self.validation.is_publishable()
    }
}

fn validate_seats(seats: &[AgentSpec]) -> Result<(), ProvenanceError> {
    if seats.len() != 4 {
        return Err(ProvenanceError::WrongSeatCount(seats.len()));
    }
    let mut seen = [false; 4];
    for seat in seats {
        seat.validate()?;
        let index = usize::from(seat.seat);
        if seen[index] {
            return Err(ProvenanceError::DuplicateSeat(seat.seat));
        }
        seen[index] = true;
    }
    Ok(())
}

/// Corpus-level seed schedule.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SeedSchedule {
    /// Schedule kind, for example `sequence`.
    pub kind: String,
    /// First seed, when the schedule is numeric.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<u64>,
    /// Step between games, when the schedule is numeric.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step: Option<u64>,
}

/// A reviewable corpus match plan (`riichiprac.corpus-match-plan` v1).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MatchPlan {
    /// Schema name; [`CORPUS_MATCH_PLAN_SCHEMA`].
    #[serde(default = "crate::miner::corpus_match_plan_schema")]
    pub schema: String,
    /// Schema version; [`JSON_SCHEMA_VERSION`].
    #[serde(default = "crate::miner::json_schema_version")]
    pub version: u32,
    /// Corpus id.
    pub corpus_id: CorpusId,
    /// Matchup family, for example `mortal_mirror`.
    pub family: String,
    /// Rule profile all four seats must agree on.
    pub rule_profile: RuleProfile,
    /// Number of games requested.
    pub games: u32,
    /// Seat rotation schedule label.
    pub seat_schedule: String,
    /// Seed schedule.
    pub seed_schedule: SeedSchedule,
    /// Four seat specs.
    pub seats: Vec<AgentSpec>,
    /// Log directory relative to the data root.
    pub log_dir: String,
}

impl MatchPlan {
    /// Validate the plan before a run starts.
    pub fn validate(&self) -> Result<(), ProvenanceError> {
        if self.schema != CORPUS_MATCH_PLAN_SCHEMA {
            return Err(ProvenanceError::WrongSchema {
                found: self.schema.clone(),
                expected: CORPUS_MATCH_PLAN_SCHEMA,
            });
        }
        if self.version != JSON_SCHEMA_VERSION {
            return Err(ProvenanceError::UnsupportedVersion {
                found: self.version,
                expected: JSON_SCHEMA_VERSION,
            });
        }
        if !is_slug(&self.family) {
            return Err(ProvenanceError::InvalidSlug {
                field: "family",
                value: self.family.clone(),
            });
        }
        self.rule_profile.validate()?;
        if self.games == 0 {
            return Err(ProvenanceError::NoGames);
        }
        if self.seat_schedule.trim().is_empty() {
            return Err(ProvenanceError::EmptyField {
                field: "seat_schedule",
            });
        }
        if self.seed_schedule.kind.trim().is_empty() {
            return Err(ProvenanceError::EmptyField {
                field: "seed_schedule.kind",
            });
        }
        validate_seats(&self.seats)?;
        storage::validate_relative_path(&self.log_dir)?;
        Ok(())
    }
}

/// Typed provenance rejection.
#[derive(Debug, Error)]
pub enum ProvenanceError {
    #[error("schema is `{found}`, expected `{expected}`")]
    WrongSchema {
        found: String,
        expected: &'static str,
    },
    #[error("schema version {found} is not supported (expected {expected})")]
    UnsupportedVersion { found: u32, expected: u32 },
    #[error(transparent)]
    Source(#[from] SourceError),
    #[error("licence for the agent at seat {seat} is invalid: {source}")]
    SeatLicence {
        seat: u8,
        #[source]
        source: LicenceError,
    },
    #[error("`{field}` is empty")]
    EmptyField { field: &'static str },
    #[error("`{field}` `{value}` is not a valid slug")]
    InvalidSlug { field: &'static str, value: String },
    #[error("`{field}` `{value}` is not a SHA-256 digest")]
    InvalidHash { field: &'static str, value: String },
    #[error("expected exactly 4 seats, found {0}")]
    WrongSeatCount(usize),
    #[error("seat {0} is outside 0..=3")]
    SeatOutOfRange(u8),
    #[error("seat {0} appears more than once")]
    DuplicateSeat(u8),
    #[error("agent at seat {seat} has an empty `{field}`")]
    EmptyAgentField { seat: u8, field: &'static str },
    #[error("config for the agent at seat {seat} must be a JSON object")]
    AgentConfigNotObject { seat: u8 },
    #[error("temperature for the agent at seat {seat} is not a finite number")]
    InvalidTemperature { seat: u8 },
    #[error("agent at seat {seat} claims reproducibility but has no seed")]
    MissingSeed { seat: u8 },
    #[error("unsupported rule profile `{0}`")]
    UnsupportedRuleProfile(String),
    #[error("rule config hash is empty")]
    EmptyRuleConfigHash,
    #[error("rule profile has {0} uma entries; expected 4")]
    UmaLength(usize),
    #[error("rule profile is not the Tenhou four-player hanchan profile: {0}")]
    UnsupportedRule(String),
    #[error("log format `{0}` is not `mjai`")]
    LogFormat(String),
    #[error("log path `{0}` must end with `.jsonl.gz`")]
    LogPathNotMjaiGz(String),
    #[error("log path is invalid: {0}")]
    LogPath(#[from] StorageError),
    #[error("log bytes must be greater than zero")]
    EmptyLog,
    #[error("log path `{found}` does not match the data-root layout `{expected}`")]
    UnexpectedLogPath { found: String, expected: String },
    #[error("replay_id `{replay_id}` does not match log sha256 `{log_sha256}`")]
    ReplayHashMismatch {
        replay_id: String,
        log_sha256: String,
    },
    #[error("match plan requests no games")]
    NoGames,
    #[error("identifier is invalid: {0}")]
    Id(#[from] IdError),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hash(label: &str) -> String {
        sha256_hex(label.as_bytes())
    }

    fn licence(commercial: bool) -> LicenseInfo {
        LicenseInfo::new(
            "AGPL-3.0",
            "Mortal 298k checkpoint, generated by riichiprac-corpus",
            commercial,
            "https://github.com/Equim-chan/Mortal",
        )
    }

    fn agent(seat: u8) -> AgentSpec {
        AgentSpec {
            seat,
            agent_id: format!("mortal-298k-{seat}"),
            kind: AgentKind::Neural,
            engine: "libriichi".to_string(),
            engine_version: "0.4.x".to_string(),
            engine_sha256: Some(hash("libriichi")),
            weights_sha256: Some(hash("mortal_298k.safetensors")),
            config: serde_json::json!({
                "boltzmann_epsilon": 0.05,
                "boltzmann_temp": 1.0,
                "top_p": 1.0
            }),
            config_hash: hash("config"),
            temperature: Some(1.0),
            sampling: "boltzmann_epsilon".to_string(),
            seed: Some(format!("0x0{seat}")),
            reproducible: true,
            licence: licence(true),
        }
    }

    fn rule() -> RuleProfile {
        RuleProfile::tenhou_4p_hanchan(hash("rule-config"), [10, 5, -5, -10])
    }

    fn provenance() -> GameProvenance {
        let replay_id = ReplayId::parse(&hash("canonical mjai log")).expect("hash parses");
        GameProvenance {
            schema: CORPUS_GAME_SCHEMA.to_string(),
            version: JSON_SCHEMA_VERSION,
            replay_id: replay_id.clone(),
            corpus_id: CorpusId::parse("mixed-2026-11").expect("corpus id"),
            family: "mortal_mirror".to_string(),
            match_plan_id: MatchPlanId::parse("m1-mortal-mirror-2026-11").expect("plan id"),
            match_plan_sha256: hash("match plan"),
            source: SourceKind::ai_selfplay(),
            rule: rule(),
            generated_at: "2026-11-16T00:00:00Z".to_string(),
            generator: GeneratorInfo {
                repo: "riichiprac-corpus".to_string(),
                version: "0.1.0".to_string(),
                commit: "abc1234".to_string(),
            },
            game_seed: "0x9f2c1a7b".to_string(),
            seat_schedule: "rotate_each_game".to_string(),
            seats: (0..4).map(agent).collect(),
            log: LogRef {
                format: "mjai".to_string(),
                path: format!("replays/mortal_mirror/{replay_id}.jsonl.gz"),
                bytes: 41_234,
                sha256: replay_id,
            },
            validation: ValidationSummary {
                status: ValidationStatus::Ok,
                events: 812,
                tile_ledger: true,
                score_ledger: true,
                rule_profile_match: true,
            },
            cross_engine: false,
            policy_variety: None,
        }
    }

    #[test]
    fn game_provenance_round_trips_and_validates() {
        let original = provenance();
        original.validate().expect("fixture must validate");

        let json = serde_json::to_string(&original).expect("serialize");
        let parsed: GameProvenance = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(parsed, original);
        assert_eq!(parsed.schema, CORPUS_GAME_SCHEMA);
        assert_eq!(parsed.version, JSON_SCHEMA_VERSION);
        assert!(parsed.is_publishable());

        let raw: serde_json::Value = serde_json::from_str(&json).expect("json");
        assert_eq!(raw["source"], "ai_selfplay");
        assert_eq!(raw["seats"].as_array().map(Vec::len), Some(4));
        assert_eq!(raw["log"]["sha256"], raw["replay_id"]);
    }

    #[test]
    fn non_selfplay_source_fails_at_deserialize() {
        let mut raw = serde_json::to_value(provenance()).expect("json");
        raw["source"] = serde_json::json!("tenhou_houou");
        let err = serde_json::from_value::<GameProvenance>(raw).expect_err("must reject");
        assert!(err.to_string().contains("ai_selfplay"), "{err}");
    }

    #[test]
    fn missing_source_defaults_to_ai_selfplay() {
        let mut raw = serde_json::to_value(provenance()).expect("json");
        raw.as_object_mut().expect("object").remove("source");
        let parsed: GameProvenance = serde_json::from_value(raw).expect("default source");
        assert_eq!(parsed.source, SourceKind::ai_selfplay());
    }

    #[test]
    fn unknown_licence_rejects_the_game() {
        let mut game = provenance();
        game.seats[1].licence.id = "internet-public".to_string();
        assert!(matches!(
            game.validate(),
            Err(ProvenanceError::SeatLicence {
                seat: 1,
                source: LicenceError::UnknownId(_)
            })
        ));
    }

    #[test]
    fn seat_set_must_be_exactly_one_to_four() {
        let mut game = provenance();
        game.seats.pop();
        assert!(matches!(
            game.validate(),
            Err(ProvenanceError::WrongSeatCount(3))
        ));

        let mut game = provenance();
        game.seats[3].seat = 2;
        assert!(matches!(
            game.validate(),
            Err(ProvenanceError::DuplicateSeat(2))
        ));

        let mut game = provenance();
        game.seats[3].seat = 4;
        assert!(matches!(
            game.validate(),
            Err(ProvenanceError::SeatOutOfRange(4))
        ));
    }

    #[test]
    fn log_paths_must_be_relative_and_inside_the_data_root() {
        let mut game = provenance();
        game.log.path = "/home/someone/riichiprac-data/replays/a.jsonl.gz".to_string();
        assert!(matches!(
            game.validate(),
            Err(ProvenanceError::LogPath(StorageError::AbsolutePath(_)))
        ));

        let mut game = provenance();
        game.log.path = "replays/../../etc/passwd.jsonl.gz".to_string();
        assert!(game.validate().is_err(), "traversal must be rejected");

        let mut game = provenance();
        game.log.path = "replays/mortal_mirror/a.jsonl".to_string();
        assert!(matches!(
            game.validate(),
            Err(ProvenanceError::LogPathNotMjaiGz(_))
        ));

        let mut game = provenance();
        game.log.path = "replays/other_family/a.jsonl.gz".to_string();
        assert!(matches!(
            game.validate(),
            Err(ProvenanceError::UnexpectedLogPath { .. })
        ));
    }

    #[test]
    fn replay_id_and_log_hash_must_agree() {
        let mut game = provenance();
        game.log.sha256 = ReplayId::from_bytes(b"a different log");
        assert!(matches!(
            game.validate(),
            Err(ProvenanceError::ReplayHashMismatch { .. })
        ));
    }

    #[test]
    fn sanitised_rules_are_rejected() {
        let mut game = provenance();
        game.rule.profile = "sanma".to_string();
        assert!(matches!(
            game.validate(),
            Err(ProvenanceError::UnsupportedRuleProfile(_))
        ));

        let mut game = provenance();
        game.rule.red_fives = 0;
        assert!(matches!(
            game.validate(),
            Err(ProvenanceError::UnsupportedRule(_))
        ));

        let mut game = provenance();
        game.rule.kuitan = false;
        assert!(matches!(
            game.validate(),
            Err(ProvenanceError::UnsupportedRule(_))
        ));

        let mut game = provenance();
        game.rule.starting_score = 30_000;
        assert!(matches!(
            game.validate(),
            Err(ProvenanceError::UnsupportedRule(_))
        ));
    }

    #[test]
    fn schema_and_version_are_checked() {
        let mut game = provenance();
        game.schema = "riichiprac.something-else".to_string();
        assert!(matches!(
            game.validate(),
            Err(ProvenanceError::WrongSchema { .. })
        ));

        let mut game = provenance();
        game.version = JSON_SCHEMA_VERSION + 1;
        assert!(matches!(
            game.validate(),
            Err(ProvenanceError::UnsupportedVersion { .. })
        ));
    }

    #[test]
    fn reproducible_agent_needs_a_seed() {
        let mut game = provenance();
        game.seats[0].seed = None;
        assert!(matches!(
            game.validate(),
            Err(ProvenanceError::MissingSeed { seat: 0 })
        ));
    }

    #[test]
    fn validation_summary_gates_publishing() {
        let mut game = provenance();
        game.validation.tile_ledger = false;
        assert!(!game.is_publishable());
        game.validation.tile_ledger = true;
        game.validation.status = ValidationStatus::Partial;
        assert!(!game.is_publishable());
    }

    #[test]
    fn match_plan_round_trips_and_validates() {
        let plan = MatchPlan {
            schema: CORPUS_MATCH_PLAN_SCHEMA.to_string(),
            version: JSON_SCHEMA_VERSION,
            corpus_id: CorpusId::parse("mixed-2026-11").expect("corpus"),
            family: "mortal_mirror".to_string(),
            rule_profile: rule(),
            games: 1000,
            seat_schedule: "rotate_each_game".to_string(),
            seed_schedule: SeedSchedule {
                kind: "sequence".to_string(),
                start: Some(1000),
                step: Some(1),
            },
            seats: (0..4).map(agent).collect(),
            log_dir: "replays/mortal_mirror".to_string(),
        };
        plan.validate().expect("plan must validate");

        let json = serde_json::to_string(&plan).expect("serialize");
        let parsed: MatchPlan = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(parsed, plan);
        assert_eq!(parsed.schema, CORPUS_MATCH_PLAN_SCHEMA);
    }

    #[test]
    fn match_plan_rejects_duplicate_seats_absolute_log_dir_and_no_games() {
        let mut plan = MatchPlan {
            schema: CORPUS_MATCH_PLAN_SCHEMA.to_string(),
            version: JSON_SCHEMA_VERSION,
            corpus_id: CorpusId::parse("mixed-2026-11").expect("corpus"),
            family: "mortal_mirror".to_string(),
            rule_profile: rule(),
            games: 10,
            seat_schedule: "rotate_each_game".to_string(),
            seed_schedule: SeedSchedule {
                kind: "sequence".to_string(),
                start: Some(1),
                step: Some(1),
            },
            seats: (0..4).map(agent).collect(),
            log_dir: "replays/mortal_mirror".to_string(),
        };
        plan.seats[2].seat = 1;
        assert!(matches!(
            plan.validate(),
            Err(ProvenanceError::DuplicateSeat(1))
        ));

        plan.seats[2].seat = 2;
        plan.log_dir = "/tmp/replays".to_string();
        assert!(matches!(
            plan.validate(),
            Err(ProvenanceError::LogPath(StorageError::AbsolutePath(_)))
        ));

        plan.log_dir = "replays/mortal_mirror".to_string();
        plan.games = 0;
        assert!(matches!(plan.validate(), Err(ProvenanceError::NoGames)));
    }

    #[test]
    fn replay_ids_normalise_and_reject_bad_values() {
        let hex = hash("log");
        let prefixed = ReplayId::parse(&format!("sha256:{}", hex.to_uppercase())).expect("prefix");
        assert_eq!(prefixed.as_str(), hex);
        assert_eq!(prefixed.to_string(), hex);

        let short = "a".repeat(63);
        let non_hex = "g".repeat(64);
        for bad in ["", "sha256:", "xyz", short.as_str(), non_hex.as_str()] {
            assert!(ReplayId::parse(bad).is_err(), "{bad} must be rejected");
        }
    }

    #[test]
    fn corpus_and_plan_ids_reject_paths() {
        for bad in ["", "../corpus", "a/b", "a\\b", "..", "a b"] {
            assert!(CorpusId::parse(bad).is_err(), "{bad} must be rejected");
            assert!(MatchPlanId::parse(bad).is_err(), "{bad} must be rejected");
        }
        assert_eq!(
            CorpusId::parse("mixed-2026-11.1").expect("slug").as_str(),
            "mixed-2026-11.1"
        );
    }

    #[test]
    fn sha256_helper_matches_known_vector() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert!(is_sha256_hex(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        ));
        assert!(is_sha256_hex(
            "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        ));
        assert!(!is_sha256_hex("abc"));
    }
}
