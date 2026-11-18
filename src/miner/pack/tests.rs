//! P1a acceptance: schema round-trip, every negative gate, deterministic
//! encoding, atomic publishing, the manifest audit and the fixture pack.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use super::audit::{AuditOptions, audit_pack_dir};
use super::check::{accepted_for, find_spoiler, spoiler_tokens};
use super::fixture::{FIXTURE_PACK_ID, fixture_games, fixture_pack};
use super::gate::{FindingSeverity, PackAuditContext, PackFindingCode, PublishProfile, audit_pack};
use super::model::*;
use super::report::{pack_report, render_pack_report};
use super::write::{
    GAMES_FILE_NAME, MANIFEST_FILE_NAME, decode_pack, encode_games, encode_pack, load_games,
    load_manifest, pack_file_name, publish_pack, read_pack,
};
use super::{PackBudget, PackError};
use crate::miner::provenance::CorpusId;
use crate::miner::transform::{Transform, TransformChain};
use crate::miner::{GameProvenance, Q_UNITS, VALUE_UNITS};
use crate::state::{CallOffer, CorrectAction};

const FIXTURE_TIME: &str = "2026-11-16T00:00:00Z";

fn fixture() -> (Pack, Vec<GameProvenance>) {
    (
        fixture_pack(FIXTURE_TIME).expect("fixture pack generates"),
        fixture_games(),
    )
}

fn audit(pack: &Pack, games: &[GameProvenance]) -> super::PackAudit {
    audit_pack(pack, &PackAuditContext::new(games)).expect("audit encodes")
}

fn assert_rejected(pack: &Pack, games: &[GameProvenance], expected: PackFindingCode) {
    let audit = audit(pack, games);
    assert!(
        audit.failure_codes().contains(&expected),
        "expected {expected:?}, got {:?}",
        audit
            .findings
            .iter()
            .map(|finding| (finding.code, finding.detail.as_str()))
            .collect::<Vec<_>>()
    );
}

#[test]
fn fixture_pack_round_trips_and_audits_clean() {
    let (pack, games) = fixture();
    assert_eq!(pack.schema, PACK_SCHEMA);
    assert_eq!(pack.version, PACK_VERSION);
    assert_eq!(pack.pack_id.as_str(), FIXTURE_PACK_ID);
    assert_eq!(pack.scenarios.len(), 2);
    assert_eq!(pack.source.agents.len(), 2, "mortal + heuristic union");
    assert!(pack.requires_model(), "the fixture carries no model labels");
    assert!(pack.scenarios.iter().all(|s| !s.accepted.is_empty()));

    let json = serde_json::to_string(&pack).expect("serialize");
    let parsed: Pack = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(parsed, pack);

    let audit = audit(&pack, &games);
    assert!(
        audit.is_clean(),
        "fixture must pass the pack gate: {:?}",
        audit
            .findings
            .iter()
            .map(|finding| (finding.code, finding.detail.as_str()))
            .collect::<Vec<_>>()
    );
    assert!(
        audit.is_clean_strict(),
        "the fixture must also pass a strict audit"
    );

    let encoded = encode_pack(&pack).expect("encode");
    let again = encode_pack(&pack).expect("encode again");
    assert_eq!(encoded.sha256, again.sha256, "encoding is deterministic");
    assert_eq!(encoded.bytes, again.bytes);
    let decoded = decode_pack(&encoded.bytes).expect("decode");
    assert_eq!(decoded, pack);
}

#[test]
fn fixture_generation_is_deterministic() {
    let first = fixture_pack(FIXTURE_TIME).expect("first");
    let second = fixture_pack(FIXTURE_TIME).expect("second");
    assert_eq!(first, second);
    assert_eq!(
        encode_pack(&first).expect("encode first").sha256,
        encode_pack(&second).expect("encode second").sha256
    );
}

#[test]
fn pack_json_carries_the_extended_shape_and_tolerates_unknown_fields() {
    let (mut pack, games) = fixture();
    let scenario = &mut pack.scenarios[0];
    scenario.mortal = Some(PackMortal {
        model: "mortal_298k.safetensors".to_string(),
        model_sha256: "a".repeat(64),
        top_action: "Discard_1z".to_string(),
        top_probability: 0.62,
        margin: 0.18,
        expected_value: -0.02,
        value_units: VALUE_UNITS.to_string(),
        ranking: vec![PackRankedAction {
            action: "Discard_1z".to_string(),
            probability: 0.62,
            q_value: Some(-0.12),
        }],
    });
    scenario.counterfactual = Some(PackCounterfactual {
        q_units: Q_UNITS.to_string(),
        q_values: BTreeMap::from([
            ("Discard_1z".to_string(), -0.12),
            ("Discard_5m".to_string(), -1.71),
        ]),
        q_gap_top2: Some(0.46),
        q_gap_safe: Some(0.11),
        probability_margin: Some(0.18),
        safe_action: Some("Discard_1z".to_string()),
        calibration_version: None,
    });
    scenario.played = Some(PackPlayed {
        kind: PlayedKind::Ai,
        agent: Some("mortal-298k".to_string()),
        action: "Discard_5m".to_string(),
        mortal_probability: Some(0.03),
    });
    scenario.interestingness = Some(PackInterestingness {
        score: 0.87,
        book_match: true,
        mortal_agreement: true,
        counterfactual_tension: 0.8,
        coverage: "new".to_string(),
        tags: vec!["defense".to_string(), "riichi".to_string()],
    });
    let chain = TransformChain::new("0x51").with(Transform::RankMirror {});
    scenario.provenance.variant_of = Some(ScenarioKey::parse("fixture-base").expect("id"));
    scenario.provenance.transforms = vec!["rank_mirror".to_string()];
    scenario.provenance.transform_seed = Some(chain.transform_seed.clone());
    scenario.provenance.transform_chain = Some(chain);
    scenario.provenance.label_check = Some(LabelCheck {
        kind: LabelCheckKind::Book,
        preserved: true,
        detail: Some("same lesson and answer".to_string()),
    });

    // The extended pack still passes every gate.
    assert!(audit(&pack, &games).is_clean());

    let value = serde_json::to_value(&pack).expect("json");
    assert_eq!(value["source"]["kind"], "ai_selfplay");
    assert_eq!(value["source"]["agents"].as_array().map(Vec::len), Some(2));
    assert!(value["source"]["agents"][0]["licence"]["id"].is_string());
    assert_eq!(
        value["scenarios"][0]["provenance"]["transforms"][0],
        "rank_mirror"
    );
    assert_eq!(
        value["scenarios"][0]["provenance"]["transform_chain"]["transforms"][0]["kind"],
        "rank_mirror"
    );
    assert_eq!(
        value["scenarios"][0]["provenance"]["label_check"]["preserved"],
        true
    );
    assert_eq!(value["scenarios"][0]["played"]["agent"], "mortal-298k");

    // Additive within the version: an unknown field is ignored.
    let mut value = serde_json::to_value(&pack).expect("json");
    value["future_pack_field"] = serde_json::json!({ "anything": true });
    value["scenarios"][0]["future_scenario_field"] = serde_json::json!(42);
    let parsed: Pack = serde_json::from_value(value).expect("unknown fields are tolerated");
    assert_eq!(parsed, pack);
}

#[test]
fn source_gate_rejects_every_negative_case() {
    let (pack, games) = fixture();

    let mut bad = pack.clone();
    bad.source.licence = "AGPL-3.0".to_string();
    assert_rejected(&bad, &games, PackFindingCode::DataLicenceNotAllowed);

    let mut bad = pack.clone();
    bad.source.attribution = "   ".to_string();
    assert_rejected(&bad, &games, PackFindingCode::EmptyAttribution);

    let mut bad = pack.clone();
    bad.source.redistributable = false;
    assert_rejected(&bad, &games, PackFindingCode::NotRedistributable);

    let mut bad = pack.clone();
    bad.source.agents.clear();
    assert_rejected(&bad, &games, PackFindingCode::NoAgents);

    let mut bad = pack.clone();
    bad.source.agents[0].licence.id = "internet-public".to_string();
    assert_rejected(&bad, &games, PackFindingCode::AgentLicenceInvalid);

    let mut bad = pack.clone();
    bad.source.data_commercial_use = false;
    assert_rejected(&bad, &games, PackFindingCode::CommercialFlagMismatch);

    // Non-self-play data fails at deserialisation, before any gate runs.
    let mut value = serde_json::to_value(&pack).expect("json");
    value["source"]["kind"] = serde_json::json!("tenhou_houou");
    assert!(serde_json::from_value::<Pack>(value).is_err());
}

#[test]
fn commercial_profile_refuses_akochan_data() {
    use crate::miner::LicenseInfo;
    use crate::miner::provenance::{AgentKind, AgentSpec};

    let (mut pack, mut games) = fixture();
    games[1].seats[1] = AgentSpec {
        seat: 1,
        agent_id: "akochan".to_string(),
        kind: AgentKind::Rule,
        engine: "akochan".to_string(),
        engine_version: "2024".to_string(),
        engine_sha256: None,
        weights_sha256: None,
        config: serde_json::json!({ "policy": "rule" }),
        config_hash: crate::miner::provenance::sha256_hex(b"akochan config"),
        temperature: None,
        sampling: "deterministic".to_string(),
        seed: Some("0x01".to_string()),
        reproducible: true,
        licence: LicenseInfo::new(
            "akochan-custom",
            "Akochan (non-commercial, attribution required)",
            false,
            "https://github.com/Equim-chan/akochan",
        ),
    };
    let mut union: BTreeMap<String, PackAgent> = BTreeMap::new();
    for game in &games {
        for seat in &game.seats {
            union
                .entry(super::model::agent_key(
                    &seat.agent_id,
                    &seat.engine,
                    &seat.engine_version,
                ))
                .or_insert_with(|| PackAgent::from_spec(seat));
        }
    }
    pack.source.agents = union.into_values().collect();
    pack.source.data_commercial_use = false;

    // Non-commercial redistribution is fine and the gate agrees.
    assert!(audit(&pack, &games).is_clean());

    let audit = audit_pack(
        &pack,
        &PackAuditContext::new(&games).with_profile(PublishProfile::Commercial),
    )
    .expect("audit runs");
    assert!(
        audit
            .failure_codes()
            .contains(&PackFindingCode::CommercialProfileRefused),
        "{:?}",
        audit.failure_codes()
    );

    // The publisher refuses before writing anything.
    let dir = tempfile::tempdir().expect("tempdir");
    let context = PackAuditContext::new(&games).with_profile(PublishProfile::Commercial);
    let error = publish_pack(dir.path(), &pack, &context, FIXTURE_TIME).expect_err("must refuse");
    assert!(matches!(error, PackError::AuditFailed(_)));
    assert_eq!(fs::read_dir(dir.path()).expect("dir").count(), 0);
}

#[test]
fn provenance_gate_rejects_missing_unpublishable_and_mismatched_games() {
    let (pack, games) = fixture();

    assert_rejected(&pack, &[], PackFindingCode::MissingGameProvenance);

    let mut bad = pack.clone();
    bad.scenarios[0].provenance.replay_id =
        crate::miner::provenance::ReplayId::from_bytes(b"a game that is not in the corpus");
    assert_rejected(&bad, &games, PackFindingCode::MissingGameProvenance);

    let mut bad_games = games.clone();
    bad_games[0].validation.tile_ledger = false;
    assert_rejected(&pack, &bad_games, PackFindingCode::UnpublishableGame);

    let mut bad_games = games.clone();
    bad_games[0].corpus_id = CorpusId::parse("some-other-corpus").expect("slug");
    assert_rejected(&pack, &bad_games, PackFindingCode::CorpusMismatch);

    let mut bad_games = games.clone();
    bad_games.push(bad_games[0].clone());
    assert_rejected(&pack, &bad_games, PackFindingCode::DuplicateGameProvenance);

    let mut bad = pack.clone();
    bad.source
        .agents
        .retain(|agent| agent.agent_id != "heuristic-v1");
    assert_rejected(&bad, &games, PackFindingCode::MissingAgent);

    let mut bad = pack.clone();
    let mut extra = bad.source.agents[0].clone();
    extra.agent_id = "unused-agent".to_string();
    extra.engine = "unused".to_string();
    extra.engine_version = "1".to_string();
    bad.source.agents.push(extra);
    assert_rejected(&bad, &games, PackFindingCode::UnexpectedAgent);

    let mut bad = pack.clone();
    let mortal = bad
        .source
        .agents
        .iter_mut()
        .find(|agent| agent.agent_id == "mortal-298k")
        .expect("fixture has the Mortal agent");
    mortal.licence.id = "MIT".to_string();
    assert_rejected(&bad, &games, PackFindingCode::AgentLicenceMismatch);
}

#[test]
fn answer_gate_rejects_every_negative_case() {
    let (pack, games) = fixture();

    let mut bad = pack.clone();
    let illegal = CorrectAction::fold("9z");
    bad.scenarios[0].state.correct_action = illegal.clone();
    bad.scenarios[0].correct_action = illegal;
    assert_rejected(&bad, &games, PackFindingCode::AnswerNotLegal);

    let mut bad = pack.clone();
    let riichi = CorrectAction::Riichi {
        discard: String::new(),
    };
    bad.scenarios[0].state.correct_action = riichi.clone();
    bad.scenarios[0].correct_action = riichi;
    assert_rejected(&bad, &games, PackFindingCode::RiichiWithoutDiscard);

    let mut bad = pack.clone();
    bad.scenarios[0].state.correct_action = CorrectAction::Pass;
    bad.scenarios[0].correct_action = CorrectAction::Pass;
    bad.scenarios[0].accepted = vec!["pass".to_string()];
    assert_rejected(&bad, &games, PackFindingCode::CallWithoutOffer);

    let mut bad = pack.clone();
    bad.scenarios[0].accepted.push("9z".to_string());
    assert_rejected(&bad, &games, PackFindingCode::AcceptedMismatch);

    let mut bad = pack.clone();
    bad.scenarios[0].state.equivalent_tiles = vec!["9z".to_string()];
    bad.scenarios[0].accepted = accepted_for(&bad.scenarios[0].state);
    let result = audit(&bad, &games);
    assert!(
        result
            .failure_codes()
            .contains(&PackFindingCode::EquivalentNotLegal),
        "{:?}",
        result.failure_codes()
    );

    let mut bad = pack.clone();
    let answer = bad.scenarios[0]
        .state
        .correct_action
        .tile()
        .expect("the fixture answer has a tile")
        .to_string();
    bad.scenarios[0].state.equivalent_tiles = vec![answer];
    bad.scenarios[0].accepted = accepted_for(&bad.scenarios[0].state);
    let result = audit(&bad, &games);
    assert!(
        result
            .failure_codes()
            .contains(&PackFindingCode::EquivalentRepeatsAnswer),
        "{:?}",
        result.failure_codes()
    );
}

#[test]
fn spoiler_gate_rejects_an_answer_tile_in_pre_answer_copy() {
    let (mut pack, games) = fixture();
    let answer = pack.scenarios[0]
        .state
        .correct_action
        .tile()
        .expect("the fixture answer has a tile")
        .to_string();
    pack.scenarios[0].title = format!("Discard the {answer} now");
    assert_rejected(&pack, &games, PackFindingCode::Spoiler);

    let mut pack2 = pack.clone();
    pack2.scenarios[0].title = "Choose the safest discard".to_string();
    pack2.scenarios[0].prompt = "Which tile do you discard?".to_string();
    pack2.scenarios[0].state.scenario_note = Some(format!("Your wait is {answer}"));
    // A note only spoils when it prints an answer tile; the gate must see it.
    assert_rejected(&pack2, &games, PackFindingCode::Spoiler);
}

#[test]
fn visible_call_offer_tiles_are_not_treated_as_wait_spoilers() {
    let (pack, _games) = fixture();
    let mut state = pack.scenarios[0].state.clone();
    let answer = accepted_for(&state);
    let offer_tile = ["1z", "2z", "3z", "4z", "5z", "6z", "7z"]
        .into_iter()
        .find(|tile| !answer.iter().any(|answer| answer == tile))
        .expect("an honour not in the answer");
    state.shanten = 0;
    state.ukeire_tiles = vec![offer_tile.to_string(), "1m".to_string()];
    state.call_offer = Some(CallOffer {
        action: "Pon".to_string(),
        label: format!("Pon {offer_tile}"),
        tile: offer_tile.to_string(),
        tiles: Vec::new(),
    });
    let tokens = spoiler_tokens(&state);
    assert!(
        !tokens.iter().any(|token| token == offer_tile),
        "a visibly offered tile is part of the question: {tokens:?}"
    );
}

#[test]
fn variant_gate_requires_a_preserved_label_check() {
    let (mut pack, games) = fixture();
    pack.scenarios[0].provenance.variant_of = Some(ScenarioKey::parse("fixture-base").expect("id"));
    assert_rejected(&pack, &games, PackFindingCode::VariantWithoutLabelCheck);

    pack.scenarios[0].provenance.label_check = Some(LabelCheck {
        kind: LabelCheckKind::Book,
        preserved: false,
        detail: None,
    });
    assert_rejected(&pack, &games, PackFindingCode::VariantLabelNotPreserved);

    let chain = TransformChain::new("0x51").with(Transform::RankMirror {});
    pack.scenarios[0].provenance.label_check = Some(LabelCheck {
        kind: LabelCheckKind::Book,
        preserved: true,
        detail: None,
    });
    pack.scenarios[0].provenance.transforms = vec!["rank_mirror".to_string()];
    pack.scenarios[0].provenance.transform_chain = Some(chain.clone());
    pack.scenarios[0].provenance.transform_seed = Some(chain.transform_seed.clone());
    assert!(audit(&pack, &games).is_clean());

    let mut bad = pack.clone();
    bad.scenarios[0].provenance.transform_chain =
        Some(TransformChain::new("0x1").with(Transform::RankMirror {}));
    bad.scenarios[0].provenance.transforms = vec!["seat_perm".to_string()];
    assert_rejected(&bad, &games, PackFindingCode::TransformListMismatch);

    let mut bad = pack.clone();
    bad.scenarios[0].provenance.transform_seed = None;
    assert_rejected(&bad, &games, PackFindingCode::TransformListMismatch);

    let mut bad = pack.clone();
    bad.scenarios[0].provenance.transform_seed = Some("0x99".to_string());
    assert_rejected(&bad, &games, PackFindingCode::TransformListMismatch);
}

#[test]
fn structural_and_state_gates_reject_negative_cases() {
    let (pack, games) = fixture();

    let mut bad = pack.clone();
    bad.schema = "riichiprac.other".to_string();
    assert_rejected(&bad, &games, PackFindingCode::WrongSchema);

    let mut bad = pack.clone();
    bad.version += 1;
    assert_rejected(&bad, &games, PackFindingCode::UnsupportedVersion);

    let mut bad = pack.clone();
    bad.scenarios.clear();
    assert_rejected(&bad, &games, PackFindingCode::EmptyPack);

    let mut bad = pack.clone();
    bad.scenarios[1].id = bad.scenarios[0].id.clone();
    assert_rejected(&bad, &games, PackFindingCode::DuplicateScenarioId);

    let mut bad = pack.clone();
    let mut duplicate = bad.scenarios[0].clone();
    duplicate.id = ScenarioKey::parse("fixture-copy").expect("id");
    duplicate.lesson_id = "other_lesson".to_string();
    duplicate.state.category = "other_lesson".to_string();
    bad.scenarios.push(duplicate);
    assert_rejected(&bad, &games, PackFindingCode::DuplicateState);

    let mut bad = pack.clone();
    bad.scenarios[0].state.category = "somewhere_else".to_string();
    assert_rejected(&bad, &games, PackFindingCode::LessonMismatch);

    let mut bad = pack.clone();
    let book = bad.scenarios[0].book.as_mut().expect("fixture has a book");
    book.key = "ch1.1".to_string();
    assert_rejected(&bad, &games, PackFindingCode::BookKeyMismatch);

    let mut bad = pack.clone();
    bad.scenarios[0].correct_action = CorrectAction::fold("1m");
    assert_rejected(&bad, &games, PackFindingCode::AnswerMismatch);

    let mut bad = pack.clone();
    bad.scenarios[0].accepted.clear();
    assert_rejected(&bad, &games, PackFindingCode::AcceptedEmpty);

    let mut bad = pack.clone();
    bad.scenarios[0].state.players[0].hand.pop();
    assert_rejected(&bad, &games, PackFindingCode::ScenarioStateInvalid);

    let mut bad = pack.clone();
    bad.scenarios[0].validation.visible_info_only = false;
    assert_rejected(&bad, &games, PackFindingCode::ValidationRecordFailed);

    let mut bad = pack.clone();
    bad.scenarios[0].played = Some(PackPlayed {
        kind: PlayedKind::Human,
        agent: None,
        action: "Discard_1m".to_string(),
        mortal_probability: None,
    });
    assert_rejected(&bad, &games, PackFindingCode::PlayedActionInvalid);

    let mut bad = pack.clone();
    bad.scenarios[0].mortal = Some(PackMortal {
        model: "mortal_298k.safetensors".to_string(),
        model_sha256: "a".repeat(64),
        top_action: "Discard_1z".to_string(),
        top_probability: 0.5,
        margin: 0.1,
        expected_value: 0.0,
        value_units: "points".to_string(),
        ranking: Vec::new(),
    });
    assert_rejected(&bad, &games, PackFindingCode::UnitsMismatch);
}

#[test]
fn budget_gate_rejects_an_oversized_pack_or_too_many_scenarios() {
    let (pack, games) = fixture();
    let context = PackAuditContext::new(&games).with_budget(PackBudget {
        max_bytes: 64,
        ..PackBudget::default()
    });
    let audit = audit_pack(&pack, &context).expect("audit runs");
    assert!(
        audit
            .failure_codes()
            .contains(&PackFindingCode::PackBudgetExceeded)
    );

    let context = PackAuditContext::new(&games).with_budget(PackBudget {
        max_scenarios: 1,
        ..PackBudget::default()
    });
    let audit = audit_pack(&pack, &context).expect("audit runs");
    assert!(
        audit
            .failure_codes()
            .contains(&PackFindingCode::ScenarioBudgetExceeded)
    );
}

#[test]
fn publish_writes_content_addressed_body_and_manifest_atomically() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (pack, games) = fixture();
    let context = PackAuditContext::new(&games);

    let published = publish_pack(dir.path(), &pack, &context, FIXTURE_TIME).expect("publish");
    assert!(published.path.exists());
    assert!(published.manifest_path.exists());
    assert_eq!(
        published.path.file_name().and_then(|name| name.to_str()),
        Some(
            pack_file_name(&pack.pack_id, &published.audit.sha256)
                .expect("filename")
                .as_str()
        )
    );
    assert!(published.audit.is_clean());

    let manifest = load_manifest(&published.manifest_path).expect("manifest parses");
    assert_eq!(manifest.packs.len(), 1);
    let entry = &manifest.packs[0];
    assert_eq!(entry.id, pack.pack_id);
    assert_eq!(entry.sha256, published.audit.sha256);
    assert_eq!(entry.bytes, published.audit.bytes);
    assert_eq!(entry.scenario_count, 2);
    assert!(entry.requires_model);
    assert_eq!(
        fs::read(&published.path).expect("body").len() as u64,
        entry.bytes
    );

    // No temporary file survived.
    for entry in fs::read_dir(dir.path()).expect("dir") {
        let name = entry.expect("entry").file_name();
        assert!(
            !name.to_string_lossy().ends_with(".tmp"),
            "left a temp file: {name:?}"
        );
    }

    // Republishing the same bytes replaces the one entry.
    let republished = publish_pack(dir.path(), &pack, &context, FIXTURE_TIME).expect("republish");
    assert_eq!(republished.entry.sha256, entry.sha256);
    let manifest = load_manifest(&published.manifest_path).expect("manifest parses");
    assert_eq!(manifest.packs.len(), 1);
}

#[test]
fn a_failed_write_leaves_no_partial_pack() {
    let dir = tempfile::tempdir().expect("tempdir");
    let blocked = dir.path().join("blocked");
    fs::write(&blocked, b"not a directory").expect("write file");
    let (pack, games) = fixture();
    let context = PackAuditContext::new(&games);
    let error = publish_pack(&blocked, &pack, &context, FIXTURE_TIME)
        .expect_err("a file cannot be a pack directory");
    assert!(matches!(error, PackError::Io { .. }));
    assert_eq!(
        fs::read(&blocked).expect("blocked file"),
        b"not a directory",
        "the failed publish must not touch an existing path"
    );
}

#[test]
fn a_dirty_pack_is_never_written() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (mut pack, games) = fixture();
    pack.scenarios[0].title = format!(
        "Discard the {}",
        pack.scenarios[0]
            .state
            .correct_action
            .tile()
            .expect("answer tile")
    );
    let context = PackAuditContext::new(&games);
    let error = publish_pack(dir.path(), &pack, &context, FIXTURE_TIME).expect_err("must refuse");
    match error {
        PackError::AuditFailed(audit) => {
            assert!(audit.failure_codes().contains(&PackFindingCode::Spoiler));
        }
        other => panic!("expected an audit failure, got {other}"),
    }
    assert_eq!(
        fs::read_dir(dir.path()).expect("dir").count(),
        0,
        "a refused pack leaves no files"
    );
}

fn publish_fixture(dir: &Path) -> (Pack, Vec<GameProvenance>) {
    let (pack, games) = fixture();
    super::write::write_games_atomic(dir, &games).expect("games");
    let context = PackAuditContext::new(&games);
    publish_pack(dir, &pack, &context, FIXTURE_TIME).expect("publish");
    (pack, games)
}

#[test]
fn directory_audit_is_clean_and_strict_after_publishing() {
    let dir = tempfile::tempdir().expect("tempdir");
    publish_fixture(dir.path());

    let report = audit_pack_dir(dir.path(), None, &AuditOptions::default()).expect("audit");
    assert!(report.is_clean(), "{:?}", report.findings);
    assert_eq!(report.packs.len(), 1);
    assert!(report.packs[0].is_clean_strict());

    let strict = audit_pack_dir(
        dir.path(),
        None,
        &AuditOptions {
            strict: true,
            ..AuditOptions::default()
        },
    )
    .expect("strict audit");
    assert!(strict.is_clean(), "{:?}", strict.findings);
}

#[test]
fn directory_audit_rejects_hash_byte_and_shape_tampering() {
    let dir = tempfile::tempdir().expect("tempdir");
    publish_fixture(dir.path());
    let manifest_path = dir.path().join(MANIFEST_FILE_NAME);
    let body_path = fs::read_dir(dir.path())
        .expect("dir")
        .flatten()
        .map(|entry| entry.path())
        .find(|path| path.extension().and_then(|e| e.to_str()) == Some("gz"))
        .expect("body");

    let mut manifest = load_manifest(&manifest_path).expect("manifest");
    manifest.packs[0].bytes += 1;
    fs::write(
        &manifest_path,
        serde_json::to_vec_pretty(&manifest).expect("json"),
    )
    .expect("write manifest");
    let report = audit_pack_dir(dir.path(), None, &AuditOptions::default()).expect("audit");
    assert!(
        report
            .findings
            .iter()
            .any(|finding| finding.code == PackFindingCode::PackFileByteMismatch)
    );

    let mut manifest = load_manifest(&manifest_path).expect("manifest");
    manifest.packs[0].bytes -= 1;
    fs::write(
        &manifest_path,
        serde_json::to_vec_pretty(&manifest).expect("json"),
    )
    .expect("write manifest");

    // The manifest hash is valid but the body bytes are not what it hashes.
    let original_body = fs::read(&body_path).expect("body");
    let mut tampered = original_body.clone();
    tampered.push(b'\n');
    fs::write(&body_path, &tampered).expect("tamper body");
    let report = audit_pack_dir(dir.path(), None, &AuditOptions::default()).expect("audit");
    assert!(
        report
            .findings
            .iter()
            .any(|finding| finding.code == PackFindingCode::PackFileHashMismatch),
        "{:?}",
        report.findings
    );
    fs::write(&body_path, &original_body).expect("restore body");

    // Restore a valid hash but point the entry at a body with another pack id.
    let mut manifest = load_manifest(&manifest_path).expect("manifest");
    let bytes = fs::read(&body_path).expect("body");
    let mut body = decode_pack(&bytes).expect("decode");
    body.pack_id = PackId::parse("some.other.pack").expect("id");
    let encoded = encode_pack(&body).expect("encode");
    manifest.packs[0].sha256 = encoded.sha256.clone();
    manifest.packs[0].bytes = encoded.len();
    let renamed = dir
        .path()
        .join(pack_file_name(&manifest.packs[0].id, &encoded.sha256).expect("name"));
    fs::remove_file(&body_path).expect("remove old");
    fs::write(&renamed, &encoded.bytes).expect("write body");
    manifest.packs[0].path = renamed
        .file_name()
        .and_then(|name| name.to_str())
        .expect("name")
        .to_string();
    fs::write(
        &manifest_path,
        serde_json::to_vec_pretty(&manifest).expect("json"),
    )
    .expect("write manifest");
    let report = audit_pack_dir(dir.path(), None, &AuditOptions::default()).expect("audit");
    assert!(
        report
            .packs
            .iter()
            .flat_map(|audit| audit.failure_codes())
            .chain(report.findings.iter().map(|f| f.code))
            .any(|code| code == PackFindingCode::PackIdMismatch),
        "expected a pack-id mismatch: {report:?}"
    );
}

#[test]
fn strict_audit_reports_manifest_drift_and_unlisted_bodies() {
    let dir = tempfile::tempdir().expect("tempdir");
    publish_fixture(dir.path());
    let manifest_path = dir.path().join(MANIFEST_FILE_NAME);
    let mut manifest = load_manifest(&manifest_path).expect("manifest");
    manifest.packs[0].lesson_ids = vec!["bogus_lesson".to_string()];
    fs::write(
        &manifest_path,
        serde_json::to_vec_pretty(&manifest).expect("json"),
    )
    .expect("write manifest");

    // Metadata drift is recoverable: a non-strict audit still passes.
    let report = audit_pack_dir(dir.path(), None, &AuditOptions::default()).expect("audit");
    assert!(report.is_clean(), "{:?}", report.findings);
    assert!(report.findings.iter().any(|finding| finding.code
        == PackFindingCode::ManifestMetadataDrift
        && finding.severity == FindingSeverity::Warning));

    let strict = audit_pack_dir(
        dir.path(),
        None,
        &AuditOptions {
            strict: true,
            ..AuditOptions::default()
        },
    )
    .expect("audit");
    assert!(!strict.is_clean());

    // A body the manifest does not list is a strict-mode warning.
    let copy = dir.path().join("orphan-0123456789ab.json.gz");
    let body = fs::read_dir(dir.path())
        .expect("dir")
        .flatten()
        .map(|entry| entry.path())
        .find(|path| {
            path.extension().and_then(|extension| extension.to_str()) == Some("gz") && path != &copy
        })
        .expect("body");
    fs::copy(&body, &copy).expect("copy");
    let report = audit_pack_dir(dir.path(), None, &AuditOptions::default()).expect("audit");
    assert!(report.is_clean());
    let strict = audit_pack_dir(
        dir.path(),
        None,
        &AuditOptions {
            strict: true,
            ..AuditOptions::default()
        },
    )
    .expect("audit");
    assert!(
        strict
            .findings
            .iter()
            .any(|finding| finding.code == PackFindingCode::UnlistedPackFile)
    );
}

#[test]
fn audit_requires_a_provenance_source() {
    let dir = tempfile::tempdir().expect("tempdir");
    publish_fixture(dir.path());
    fs::remove_file(dir.path().join(GAMES_FILE_NAME)).expect("remove games");

    let report = audit_pack_dir(dir.path(), None, &AuditOptions::default()).expect("audit");
    assert!(!report.is_clean());
    assert!(
        report
            .findings
            .iter()
            .any(|finding| finding.code == PackFindingCode::MissingGameProvenance)
    );

    let missing = dir.path().join("nowhere.jsonl");
    let error = audit_pack_dir(dir.path(), Some(&missing), &AuditOptions::default())
        .expect_err("an explicit missing source is an error");
    assert!(matches!(error, PackError::MissingGames(_)));
}

#[test]
fn manifest_loader_rejects_unsafe_or_malformed_entries() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (pack, _games) = fixture();
    let encoded = encode_pack(&pack).expect("encode");
    let mut entry = ManifestEntry::new(
        &pack,
        pack_file_name(&pack.pack_id, &encoded.sha256).expect("name"),
        encoded.sha256.clone(),
        encoded.len(),
    );
    let mut manifest = PackManifest::new(FIXTURE_TIME);
    manifest.upsert(entry.clone());
    let path = dir.path().join(MANIFEST_FILE_NAME);

    super::write::write_manifest_atomic(&path, &manifest).expect("valid manifest writes");

    entry.path = "../escape.json.gz".to_string();
    let mut bad = manifest.clone();
    bad.packs = vec![entry];
    assert!(super::write::write_manifest_atomic(&path, &bad).is_err());

    let mut entry = manifest.packs[0].clone();
    entry.sha256 = "not-a-hash".to_string();
    let mut bad = manifest.clone();
    bad.packs = vec![entry];
    assert!(super::write::write_manifest_atomic(&path, &bad).is_err());

    let mut entry = manifest.packs[0].clone();
    entry.licence = "AGPL-3.0".to_string();
    let mut bad = manifest.clone();
    bad.packs = vec![entry];
    assert!(super::write::write_manifest_atomic(&path, &bad).is_err());

    assert!(
        pack_file_name(&pack.pack_id, "nope").is_err(),
        "a filename needs a real SHA-256"
    );
}

#[test]
fn games_jsonl_round_trips_and_rejects_bad_rows() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (_, games) = fixture();
    let bytes = encode_games(&games).expect("encode");
    let path = dir.path().join(GAMES_FILE_NAME);
    fs::write(&path, bytes).expect("write");
    assert_eq!(load_games(&path).expect("load"), games);

    fs::write(&path, b"{\"not\":\"a game\"}\n").expect("write");
    assert!(matches!(load_games(&path), Err(PackError::Games { .. })));

    fs::write(&path, b"").expect("write");
    assert!(matches!(load_games(&path), Err(PackError::MissingGames(_))));
}

#[test]
fn pack_report_summarises_the_fixture() {
    let (pack, _games) = fixture();
    let encoded = encode_pack(&pack).expect("encode");
    let report = pack_report(&pack, encoded.len(), &PackBudget::default());
    assert_eq!(report.pack_id, FIXTURE_PACK_ID);
    assert_eq!(report.scenario_count, 2);
    assert_eq!(report.variant_count, 0);
    assert_eq!(report.variant_share, 0.0);
    assert_eq!(report.largest_base_share, 0.0);
    assert_eq!(report.agents.len(), 2);
    assert_eq!(report.lesson_ids.len(), 2);
    assert!(report.requires_model);
    assert_eq!(report.bytes, encoded.len());
    let lines = render_pack_report(&report);
    assert!(lines[0].contains(FIXTURE_PACK_ID));
    assert!(lines.iter().any(|line| line.contains("mortal-298k")));
}

#[test]
fn pack_validate_fails_closed_on_the_first_error() {
    let (mut pack, _games) = fixture();
    pack.validate().expect("fixture is valid");
    pack.scenarios.clear();
    assert!(matches!(pack.validate(), Err(PackError::Invalid { .. })));
}

fn fixture_body_path(dir: &Path) -> PathBuf {
    fs::read_dir(dir)
        .expect("dir")
        .flatten()
        .map(|entry| entry.path())
        .find(|path| path.extension().and_then(|extension| extension.to_str()) == Some("gz"))
        .expect("body")
}

#[test]
fn body_hash_and_pack_id_are_the_runtime_contract() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (pack, _games) = publish_fixture(dir.path());
    let body = read_pack(&fixture_body_path(dir.path())).expect("read body");
    assert_eq!(body, pack);
    let encoded = encode_pack(&body).expect("encode");
    assert_eq!(
        fs::read(fixture_body_path(dir.path())).expect("bytes"),
        encoded.bytes,
        "the published file is exactly the deterministic encoding"
    );
    assert!(find_spoiler(&pack.scenarios[0]).is_none());
}
