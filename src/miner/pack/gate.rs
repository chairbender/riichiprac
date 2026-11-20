//! The pack gate: schema, source/licence, provenance, answers and budget.
//!
//! [`audit_pack`] is the executable form of the G8 pack gate and the pack-time
//! half of the hard gates in `replay-strategy.md` §7.1. A publisher calls it
//! before writing anything; [`super::write::publish_pack`] refuses a dirty pack
//! with a [`PackError::AuditFailed`](super::PackError::AuditFailed).
//!
//! Findings carry a stable code, so a test asserts the gate that fired instead
//! of matching prose. Errors block a publish. Warnings (manifest metadata that a
//! loader can recompute) only block an `audit --strict` run.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::miner::licence::{allowed_data_licence, data_commercial_use_all};
use crate::miner::provenance::GameProvenance;
use crate::miner::source::SourceGate;

use super::check::check_scenario;
use super::model::{Pack, PackAgent, PackSource, agent_key};
use super::write::{PackBytes, encode_pack};
use super::{PackBudget, PackError};

/// How much a finding blocks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FindingSeverity {
    /// Blocks a publish and exits `audit` with 1.
    Error,
    /// Reported, and blocks only `audit --strict`.
    Warning,
}

/// A stable identity for one gate failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PackFindingCode {
    /// The document names another schema.
    WrongSchema,
    /// The document names an unsupported schema version.
    UnsupportedVersion,
    /// The pack has no scenarios.
    EmptyPack,
    /// Two scenarios share an id.
    DuplicateScenarioId,
    /// Two scenarios share a state.
    DuplicateState,
    /// A required string is empty.
    EmptyField,
    /// `lesson_id` and the state's `category` disagree.
    LessonMismatch,
    /// The book citation key does not describe its chapter/section.
    BookKeyMismatch,
    /// The pack answer and the state answer disagree.
    AnswerMismatch,
    /// `accepted` is empty.
    AcceptedEmpty,
    /// `accepted` is not the answer plus the state's equivalents.
    AcceptedMismatch,
    /// The answer is not legal in the state.
    AnswerNotLegal,
    /// A Riichi answer names no legal discard.
    RiichiWithoutDiscard,
    /// A call/pass answer has no `call_offer`.
    CallWithoutOffer,
    /// An equivalent tile is not a legal discard.
    EquivalentNotLegal,
    /// The answer lists itself as an equivalent.
    EquivalentRepeatsAnswer,
    /// `validate_reachable_state` rejected the table.
    ScenarioStateInvalid,
    /// The build record claims validation that did not happen.
    ValidationRecordFailed,
    /// A pre-answer string prints the answer or wait.
    Spoiler,
    /// The transform-chain document is invalid.
    TransformChainInvalid,
    /// `provenance.transforms` disagrees with the chain.
    TransformListMismatch,
    /// A variant has no label-preservation record.
    VariantWithoutLabelCheck,
    /// A variant's label-preservation check failed.
    VariantLabelNotPreserved,
    /// A model/selection number or unit is wrong.
    UnitsMismatch,
    /// `played` names a human or a nameless AI.
    PlayedActionInvalid,
    /// The replay source is not `ai_selfplay`.
    SourceNotAllowed,
    /// The pack data licence is not on the allowlist.
    DataLicenceNotAllowed,
    /// The pack has no attribution text.
    EmptyAttribution,
    /// The pack forbids redistribution.
    NotRedistributable,
    /// The pack names no contributing agents.
    NoAgents,
    /// A contributor's licence is unknown or incomplete.
    AgentLicenceInvalid,
    /// A contributor appears twice in the union.
    DuplicateAgent,
    /// `data_commercial_use` disagrees with the contributing licences.
    CommercialFlagMismatch,
    /// A commercial profile was requested for a non-commercial pack.
    CommercialProfileRefused,
    /// A scenario's `replay_id` has no `GameProvenance` row.
    MissingGameProvenance,
    /// The matching game is structurally invalid or unpublishable.
    UnpublishableGame,
    /// The game's corpus differs from the pack's source corpus.
    CorpusMismatch,
    /// A contributing seat's agent is absent from `source.agents`.
    MissingAgent,
    /// `source.agents` names an agent no contributing game used.
    UnexpectedAgent,
    /// `source.agents` records a different licence for a contributing agent.
    AgentLicenceMismatch,
    /// The provenance source repeats a replay id.
    DuplicateGameProvenance,
    /// The encoded pack body exceeds its byte ceiling.
    PackBudgetExceeded,
    /// The pack has more scenarios than its ceiling.
    ScenarioBudgetExceeded,
    /// The manifest exceeds its byte ceiling.
    ManifestBudgetExceeded,
    /// A manifest entry's convenience metadata drifted from the body.
    ManifestMetadataDrift,
    /// A manifest entry records no per-lesson coverage.
    LessonCountsMissing,
    /// A manifest entry's per-lesson coverage disagrees with the body.
    LessonCountMismatch,
    /// A manifest entry points at a missing file.
    PackFileMissing,
    /// The pack file length disagrees with the manifest.
    PackFileByteMismatch,
    /// The pack file hash disagrees with the manifest.
    PackFileHashMismatch,
    /// A pack file is not a readable gzip JSON pack.
    PackFileUnreadable,
    /// The body's pack id disagrees with the manifest entry.
    PackIdMismatch,
    /// The body's scenario count disagrees with the manifest entry.
    ScenarioCountMismatch,
    /// A pack file in the directory has no manifest entry.
    UnlistedPackFile,
    /// A manifest entry is structurally invalid.
    ManifestEntryInvalid,
}

/// One gate result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackFinding {
    /// Stable code.
    pub code: PackFindingCode,
    /// Whether this blocks a publish.
    pub severity: FindingSeverity,
    /// The scenario that failed, when the finding is scenario-scoped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scenario: Option<String>,
    /// Human-readable detail. Never rendered to the player.
    pub detail: String,
}

impl PackFinding {
    /// A pack-level error.
    #[must_use]
    pub fn error(code: PackFindingCode, detail: impl Into<String>) -> Self {
        Self {
            code,
            severity: FindingSeverity::Error,
            scenario: None,
            detail: detail.into(),
        }
    }

    /// A pack-level warning.
    #[must_use]
    pub fn warning(code: PackFindingCode, detail: impl Into<String>) -> Self {
        Self {
            code,
            severity: FindingSeverity::Warning,
            scenario: None,
            detail: detail.into(),
        }
    }

    /// An error scoped to one scenario.
    #[must_use]
    pub fn scenario(
        code: PackFindingCode,
        scenario: impl Into<String>,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            code,
            severity: FindingSeverity::Error,
            scenario: Some(scenario.into()),
            detail: detail.into(),
        }
    }
}

/// The publish intent. A commercial profile refuses a pack whose data licence
/// or any contributing agent forbids commercial use.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PublishProfile {
    /// Commercial redistribution.
    Commercial,
    /// Non-commercial / undecided redistribution.
    #[default]
    NonCommercial,
}

/// Everything the gate needs that is not inside the pack.
#[derive(Debug, Clone)]
pub struct PackAuditContext<'a> {
    /// The `GameProvenance` rows of the corpus the pack references.
    pub games: &'a [GameProvenance],
    /// The publish intent.
    pub profile: PublishProfile,
    /// Size and count ceilings.
    pub budget: PackBudget,
}

impl<'a> PackAuditContext<'a> {
    /// Audit against `games` with the default budget and non-commercial profile.
    #[must_use]
    pub fn new(games: &'a [GameProvenance]) -> Self {
        Self {
            games,
            profile: PublishProfile::NonCommercial,
            budget: PackBudget::default(),
        }
    }

    /// Set the publish intent.
    #[must_use]
    pub fn with_profile(mut self, profile: PublishProfile) -> Self {
        self.profile = profile;
        self
    }

    /// Set the ceilings.
    #[must_use]
    pub fn with_budget(mut self, budget: PackBudget) -> Self {
        self.budget = budget;
        self
    }
}

/// The outcome of auditing one pack body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackAudit {
    /// The pack id, or `unknown` when it did not parse.
    pub pack_id: String,
    /// Scenarios in the body.
    pub scenario_count: usize,
    /// Encoded body bytes.
    pub bytes: u64,
    /// SHA-256 of the encoded body.
    pub sha256: String,
    /// Every finding, in check order.
    pub findings: Vec<PackFinding>,
}

impl PackAudit {
    /// Findings that block a publish.
    pub fn failures(&self) -> impl Iterator<Item = &PackFinding> {
        self.findings
            .iter()
            .filter(|finding| finding.severity == FindingSeverity::Error)
    }

    /// Findings that only `--strict` blocks.
    pub fn warnings(&self) -> impl Iterator<Item = &PackFinding> {
        self.findings
            .iter()
            .filter(|finding| finding.severity == FindingSeverity::Warning)
    }

    /// Whether a publish may proceed.
    #[must_use]
    pub fn is_clean(&self) -> bool {
        self.failures().next().is_none()
    }

    /// Whether `audit --strict` passes (no findings at all).
    #[must_use]
    pub fn is_clean_strict(&self) -> bool {
        self.findings.is_empty()
    }

    /// The distinct failure codes, for a test or a report.
    #[must_use]
    pub fn failure_codes(&self) -> Vec<PackFindingCode> {
        let codes: BTreeSet<PackFindingCode> =
            self.failures().map(|finding| finding.code).collect();
        codes.into_iter().collect()
    }
}

impl Pack {
    /// Every structural and scenario-scoped finding, before the provenance and
    /// byte gates run.
    #[must_use]
    pub fn findings(&self) -> Vec<PackFinding> {
        let mut findings = structural_findings(self);
        for scenario in &self.scenarios {
            findings.extend(check_scenario(scenario));
        }
        findings
    }

    /// Fail closed on the first error.
    pub fn validate(&self) -> Result<(), PackError> {
        match self
            .findings()
            .into_iter()
            .find(|finding| finding.severity == FindingSeverity::Error)
        {
            Some(finding) => Err(PackError::Invalid {
                pack_id: self.pack_id.to_string(),
                detail: format!("{:?}: {}", finding.code, finding.detail),
            }),
            None => Ok(()),
        }
    }
}

fn structural_findings(pack: &Pack) -> Vec<PackFinding> {
    let mut findings = Vec::new();
    if pack.schema != super::model::PACK_SCHEMA {
        findings.push(PackFinding::error(
            PackFindingCode::WrongSchema,
            format!(
                "pack schema is `{}`, expected `{}`",
                pack.schema,
                super::model::PACK_SCHEMA
            ),
        ));
    }
    if pack.version != super::model::PACK_VERSION {
        findings.push(PackFinding::error(
            PackFindingCode::UnsupportedVersion,
            format!(
                "pack version {} is not supported (expected {})",
                pack.version,
                super::model::PACK_VERSION
            ),
        ));
    }
    for (field, value) in [
        ("generated_at", pack.generated_at.as_str()),
        ("generator.tool", pack.generator.tool.as_str()),
        ("generator.version", pack.generator.version.as_str()),
        ("generator.commit", pack.generator.commit.as_str()),
        (
            "generator.classifier_version",
            pack.generator.classifier_version.as_str(),
        ),
    ] {
        if value.trim().is_empty() {
            findings.push(PackFinding::error(
                PackFindingCode::EmptyField,
                format!("`{field}` is empty"),
            ));
        }
    }
    if pack.scenarios.is_empty() {
        findings.push(PackFinding::error(
            PackFindingCode::EmptyPack,
            "a pack must contain at least one scenario",
        ));
    }

    let mut ids = BTreeSet::new();
    let mut states = BTreeMap::new();
    for scenario in &pack.scenarios {
        if !ids.insert(scenario.id.clone()) {
            findings.push(PackFinding::scenario(
                PackFindingCode::DuplicateScenarioId,
                scenario.id.as_str(),
                "the scenario id appears more than once",
            ));
        }
        let hash = crate::miner::state_hash(&scenario.state);
        if let Some(previous) = states.insert(hash.clone(), scenario.id.as_str()) {
            findings.push(PackFinding::scenario(
                PackFindingCode::DuplicateState,
                scenario.id.as_str(),
                format!("the same state is already shipped as `{previous}` ({hash})"),
            ));
        }
    }
    findings
}

/// Audit one pack body. Encoding happens here so the byte budget and the hash
/// describe exactly the bytes a publisher would write.
pub fn audit_pack(pack: &Pack, context: &PackAuditContext<'_>) -> Result<PackAudit, PackError> {
    let encoded = encode_pack(pack)?;
    audit_pack_encoded(pack, context, &encoded)
}

pub(crate) fn audit_pack_encoded(
    pack: &Pack,
    context: &PackAuditContext<'_>,
    encoded: &PackBytes,
) -> Result<PackAudit, PackError> {
    let mut findings = pack.findings();
    findings.extend(check_source(&pack.source, context.profile));
    findings.extend(check_provenance(pack, context.games));

    if pack.scenarios.len() > context.budget.max_scenarios {
        findings.push(PackFinding::error(
            PackFindingCode::ScenarioBudgetExceeded,
            format!(
                "{} scenarios exceed the {} ceiling",
                pack.scenarios.len(),
                context.budget.max_scenarios
            ),
        ));
    }
    if encoded.len() > context.budget.max_bytes {
        findings.push(PackFinding::error(
            PackFindingCode::PackBudgetExceeded,
            format!(
                "{} encoded bytes exceed the {} ceiling",
                encoded.len(),
                context.budget.max_bytes
            ),
        ));
    }

    Ok(PackAudit {
        pack_id: pack.pack_id.to_string(),
        scenario_count: pack.scenarios.len(),
        bytes: encoded.len(),
        sha256: encoded.sha256.clone(),
        findings,
    })
}

/// Source kind, data licence, attribution, redistribution and the complete
/// agent union's licences and commercial flag.
fn check_source(source: &PackSource, profile: PublishProfile) -> Vec<PackFinding> {
    let mut findings = Vec::new();
    if let Err(error) = SourceGate::require(&source.kind) {
        findings.push(PackFinding::error(
            PackFindingCode::SourceNotAllowed,
            error.to_string(),
        ));
    }
    if !allowed_data_licence(&source.licence) {
        findings.push(PackFinding::error(
            PackFindingCode::DataLicenceNotAllowed,
            format!(
                "data licence `{}` is not on the pack allowlist",
                source.licence
            ),
        ));
    }
    if source.attribution.trim().is_empty() {
        findings.push(PackFinding::error(
            PackFindingCode::EmptyAttribution,
            "the pack has no data attribution",
        ));
    }
    if !source.redistributable {
        findings.push(PackFinding::error(
            PackFindingCode::NotRedistributable,
            "the pack forbids redistribution but a published pack must allow it",
        ));
    }
    if source.agents.is_empty() {
        findings.push(PackFinding::error(
            PackFindingCode::NoAgents,
            "`source.agents` is empty; a pack must name every contributor",
        ));
    }

    let mut keys = BTreeSet::new();
    for agent in &source.agents {
        if let Err(error) = agent.licence.validate() {
            findings.push(PackFinding::error(
                PackFindingCode::AgentLicenceInvalid,
                format!("`{}`: {error}", agent.agent_id),
            ));
        }
        for (field, value) in [
            ("agent_id", agent.agent_id.as_str()),
            ("engine", agent.engine.as_str()),
            ("engine_version", agent.engine_version.as_str()),
        ] {
            if value.trim().is_empty() {
                findings.push(PackFinding::error(
                    PackFindingCode::EmptyField,
                    format!("agent `{}` has an empty `{field}`", agent.agent_id),
                ));
            }
        }
        if !keys.insert(agent.key()) {
            findings.push(PackFinding::error(
                PackFindingCode::DuplicateAgent,
                format!(
                    "agent `{}` appears twice in `source.agents`",
                    agent.agent_id
                ),
            ));
        }
    }

    let commercial = data_commercial_use_all(source.agents.iter().map(|agent| &agent.licence));
    if commercial != source.data_commercial_use {
        findings.push(PackFinding::error(
            PackFindingCode::CommercialFlagMismatch,
            format!(
                "`data_commercial_use` is {} but the contributing licences allow {}",
                source.data_commercial_use, commercial
            ),
        ));
    }
    if profile == PublishProfile::Commercial {
        let akochan = source
            .agents
            .iter()
            .any(|agent| agent.licence.id == "akochan-custom");
        let blocked_agent = source
            .agents
            .iter()
            .find(|agent| !agent.licence.data_commercial_use)
            .map(|agent| agent.agent_id.clone());
        if !source.data_commercial_use || akochan || blocked_agent.is_some() {
            let reason = if akochan {
                "it contains Akochan (non-commercial) data".to_string()
            } else if let Some(agent) = blocked_agent {
                format!("contributor `{agent}` forbids commercial data use")
            } else {
                "the pack does not grant commercial data use".to_string()
            };
            findings.push(PackFinding::error(
                PackFindingCode::CommercialProfileRefused,
                format!("a commercial profile is refused: {reason}"),
            ));
        }
    }
    findings
}

/// Every referenced game must exist, be publishable, share the pack's corpus,
/// and have its seats represented in `source.agents` with matching licences.
fn check_provenance(pack: &Pack, games: &[GameProvenance]) -> Vec<PackFinding> {
    let mut findings = Vec::new();
    let mut by_id: BTreeMap<&str, &GameProvenance> = BTreeMap::new();
    for game in games {
        if by_id.insert(game.replay_id.as_str(), game).is_some() {
            findings.push(PackFinding::error(
                PackFindingCode::DuplicateGameProvenance,
                format!(
                    "replay `{}` appears twice in the provenance source",
                    game.replay_id
                ),
            ));
        }
    }

    let mut contributing: BTreeSet<&str> = BTreeSet::new();
    for scenario in &pack.scenarios {
        let replay_id = scenario.provenance.replay_id.as_str();
        let Some(game) = by_id.get(replay_id) else {
            findings.push(PackFinding::scenario(
                PackFindingCode::MissingGameProvenance,
                scenario.id.as_str(),
                format!("no `GameProvenance` row for replay `{replay_id}`"),
            ));
            continue;
        };
        contributing.insert(replay_id);
        if let Err(error) = game.validate() {
            findings.push(PackFinding::scenario(
                PackFindingCode::UnpublishableGame,
                scenario.id.as_str(),
                format!("replay `{replay_id}` is invalid: {error}"),
            ));
        } else if !game.validation.is_publishable() {
            findings.push(PackFinding::scenario(
                PackFindingCode::UnpublishableGame,
                scenario.id.as_str(),
                format!("replay `{replay_id}` is not publishable"),
            ));
        }
        if game.corpus_id.as_str() != pack.source.corpus_id.as_str() {
            findings.push(PackFinding::scenario(
                PackFindingCode::CorpusMismatch,
                scenario.id.as_str(),
                format!(
                    "replay `{replay_id}` belongs to corpus `{}`, but the pack declares `{}`",
                    game.corpus_id.as_str(),
                    pack.source.corpus_id.as_str()
                ),
            ));
        }
    }

    // The three-way join: expected = seats of every contributing game.
    let mut expected: BTreeMap<String, ExpectedAgent> = BTreeMap::new();
    for id in &contributing {
        let Some(game) = by_id.get(id) else {
            continue;
        };
        for seat in &game.seats {
            let key = agent_key(&seat.agent_id, &seat.engine, &seat.engine_version);
            expected.entry(key).or_insert_with(|| ExpectedAgent {
                label: format!(
                    "{} ({} {})",
                    seat.agent_id, seat.engine, seat.engine_version
                ),
                licence_id: seat.licence.id.clone(),
                commercial: seat.licence.data_commercial_use,
            });
        }
    }
    let actual: BTreeMap<String, &PackAgent> = pack
        .source
        .agents
        .iter()
        .map(|agent| (agent.key(), agent))
        .collect();

    for (key, expected) in &expected {
        match actual.get(key) {
            None => findings.push(PackFinding::error(
                PackFindingCode::MissingAgent,
                format!(
                    "contributing agent `{}` is missing from `source.agents`",
                    expected.label
                ),
            )),
            Some(agent)
                if agent.licence.id != expected.licence_id
                    || agent.licence.data_commercial_use != expected.commercial =>
            {
                findings.push(PackFinding::error(
                    PackFindingCode::AgentLicenceMismatch,
                    format!(
                        "agent `{}` records licence `{}` (commercial {}), but the corpus records `{}` (commercial {})",
                        agent.agent_id,
                        agent.licence.id,
                        agent.licence.data_commercial_use,
                        expected.licence_id,
                        expected.commercial
                    ),
                ));
            }
            Some(_) => {}
        }
    }
    for (key, agent) in &actual {
        if !expected.contains_key(key) {
            findings.push(PackFinding::error(
                PackFindingCode::UnexpectedAgent,
                format!(
                    "`source.agents` names `{}` but no contributing game used it",
                    agent.agent_id
                ),
            ));
        }
    }
    findings
}

struct ExpectedAgent {
    label: String,
    licence_id: String,
    commercial: bool,
}

/// Human-readable one-line summary of an audit.
#[must_use]
pub fn audit_summary(audit: &PackAudit) -> String {
    let failures = audit.failures().count();
    let warnings = audit.warnings().count();
    format!(
        "{}: {} scenario(s), {} bytes, sha256 {}, {} failure(s), {} warning(s)",
        audit.pack_id, audit.scenario_count, audit.bytes, audit.sha256, failures, warnings
    )
}
