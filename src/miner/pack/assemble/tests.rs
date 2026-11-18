//! P1b acceptance tests: assembly from the DB, limits, the review gate,
//! determinism, the DB/export agreement and the assembly report.

use std::collections::BTreeMap;

use rusqlite::{Connection, params};

use crate::generator::ScenarioId;
use crate::miner::pack::{
    AssemblyLimits, AssemblyOptions, AssemblyReport, PackError, audit_pack_dir, decode_pack,
};
use crate::miner::provenance::{GameProvenance, ReplayId, sha256_hex};
use crate::miner::select::dedupe::exact_state_hash;
use crate::miner::select::review::{
    DISPOSITION_SCHEMA, DISPOSITION_VERSION, REVIEW_SCHEMA, REVIEW_VERSION,
};
use crate::miner::select::{
    DispositionVerdict, ReviewDisposition, ReviewItem, Signals, write_dispositions,
};
use crate::miner::storage::{DataRoot, open_miner_db};
use crate::miner::variant::base::BaseScenario;
use crate::miner::variant::{GateDeps, VariantConfig, VariantStage, persist, rehearsal};
use crate::miner::{AuditOptions, CLASSIFIER_VERSION, Family};
use crate::report::{BuildReportRequest, ReportReason, ReportedAction, build_report};
use crate::state::{CorrectAction, CorrectActionType, GameState};

use super::BaseGroup;

const STAMP: &str = "2026-11-17T00:00:00Z";
const PACK_ID: &str = "p1b-fixture";

struct Db {
    _dir: tempfile::TempDir,
    root: DataRoot,
    connection: Connection,
}

fn database() -> Db {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = DataRoot::new(dir.path()).expect("data root");
    let connection = open_miner_db(&root).expect("miner db");
    Db {
        _dir: dir,
        root,
        connection,
    }
}

/// Insert the `replays` row a fixture game needs.
fn insert_replay(connection: &Connection, game: &GameProvenance) {
    let seat = game
        .seats
        .iter()
        .find(|seat| seat.weights_sha256.is_some())
        .or_else(|| game.seats.first())
        .expect("a game has seats");
    let agents = serde_json::to_string(&game.seats).expect("agents");
    let provenance = serde_json::to_string(game).expect("provenance");
    connection
        .execute(
            "INSERT INTO replays (
                replay_id, source, licence, attribution, format, rule, rule_config_hash,
                generated_at, model, model_sha256, seed, log_path, log_bytes, log_sha256,
                validation_status, ingested_at, corpus_id, family, match_plan_id,
                match_plan_sha256, agents, cross_engine, data_commercial_use, provenance_json
             ) VALUES (?1, 'ai_selfplay', 'CC-BY-4.0',
                'Fixture games for the P1b assembly tests. Pack data CC BY 4.0.',
                'mjai', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'ok',
                '2026-11-16T00:01:00Z', ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
            params![
                game.replay_id.as_str(),
                game.rule.profile,
                game.rule.config_hash,
                game.generated_at,
                seat.agent_id,
                seat.weights_sha256
                    .clone()
                    .unwrap_or_else(|| "c".repeat(64)),
                game.game_seed,
                game.log.path,
                i64::try_from(game.log.bytes).unwrap_or(i64::MAX),
                game.log.sha256.as_str(),
                game.corpus_id.as_str(),
                game.family,
                game.match_plan_id.as_str(),
                game.match_plan_sha256,
                agents,
                i64::from(game.cross_engine),
                i64::from(
                    game.seats
                        .iter()
                        .all(|seat| seat.licence.data_commercial_use)
                ),
                provenance,
            ],
        )
        .expect("replay row");
}

/// One `decisions` row carrying the base's own state.
fn insert_decision(connection: &Connection, base: &BaseScenario, index: i64) {
    let state = serde_json::to_string(&base.scenario.state).expect("state");
    let played = base
        .scenario
        .correct_action
        .tile()
        .map_or_else(|| "Pass".to_string(), |tile| format!("Discard_{tile}"));
    connection
        .execute(
            "INSERT INTO decisions (
                decision_id, replay_id, family, kyoku, honba, event_index, turn, seat,
                decision_kind, state_hash, state_json, legal_actions, played_action
             ) VALUES (?1, ?2, 'book', 0, 0, ?3, 0, 0, 'self_turn', ?4, ?5, '[]', ?6)",
            params![
                format!("{PACK_ID}-decision-{index:03}"),
                base.scenario.provenance.replay_id.as_str(),
                index,
                exact_state_hash(&base.scenario.state),
                state,
                played,
            ],
        )
        .expect("decision row");
}

/// Persist the realistic fixture selection: `count` rehearsal bases and their
/// V2-gated variants.
fn selection(db: &Db, count: usize) -> Vec<BaseScenario> {
    let rehearsal = rehearsal::rehearsal_bases(count).expect("rehearsal bases");
    for game in &rehearsal.games {
        insert_replay(&db.connection, game);
    }
    let mut bases = rehearsal.bases;
    for (index, base) in bases.iter_mut().enumerate() {
        insert_decision(&db.connection, base, index as i64);
        base.decision_id = Some(format!("{PACK_ID}-decision-{index:03}"));
    }
    let config = VariantConfig {
        variants_per_base: 3,
        min_yield: 0.0,
        ..VariantConfig::default()
    };
    let cuts = crate::miner::label::thresholds::PercentileCuts::build(
        &crate::miner::label::thresholds::PercentileConfig::default(),
        &BTreeMap::new(),
    )
    .expect("cuts");
    let stage = VariantStage {
        config: &config,
        deps: GateDeps {
            labeler: None,
            cuts: &cuts,
            classifier_version: CLASSIFIER_VERSION,
        },
        pack_id: PACK_ID.to_string(),
        generated_at: STAMP.to_string(),
    };
    let outcome = stage.run(&bases).expect("variant stage");
    assert!(
        !outcome.variants.is_empty(),
        "the fixture must ship variants: {:?}",
        outcome.report.rejections
    );
    persist::store_variants(
        &db.connection,
        PACK_ID,
        &bases,
        &outcome.variants,
        &outcome.rejected,
        STAMP,
    )
    .expect("persist");
    bases
}

fn options() -> AssemblyOptions {
    AssemblyOptions {
        pack_id: Some(PACK_ID.to_string()),
        ..AssemblyOptions::default()
    }
}

struct Row {
    scenario_id: String,
    ordinal: i64,
    base: Option<String>,
    lesson_id: String,
    state_hash: String,
    variant: i64,
}

fn query_rows(connection: &Connection) -> Vec<Row> {
    let mut statement = connection
        .prepare(
            "SELECT scenario_id, ordinal, base_scenario_id, lesson_id, family,
                    state_hash, variant
             FROM pack_scenarios WHERE pack_id = ?1 ORDER BY ordinal",
        )
        .expect("prepare");
    statement
        .query_map(params![PACK_ID], |row| {
            Ok(Row {
                scenario_id: row.get(0)?,
                ordinal: row.get(1)?,
                base: row.get(2)?,
                lesson_id: row.get(3)?,
                state_hash: row.get(5)?,
                variant: row.get(6)?,
            })
        })
        .expect("query")
        .collect::<Result<Vec<_>, _>>()
        .expect("rows")
}

// ---------------------------------------------------------------------------
// The assembly itself.
// ---------------------------------------------------------------------------

#[test]
fn assembles_a_clean_pack_that_agrees_with_the_db_and_is_deterministic() {
    let db = database();
    selection(&db, 3);

    let outcome = crate::miner::pack::run_assembly(&db.root, &options()).expect("assembles");
    assert!(outcome.written);
    assert_eq!(outcome.pack.pack_id.as_str(), PACK_ID);
    assert_eq!(outcome.pack.generated_at, STAMP);
    assert_eq!(outcome.pack.generator.commit, "db");
    assert!(outcome.report.audit_clean, "{:?}", outcome.report.dropped);
    assert!(outcome.pack.scenarios.len() >= 3);
    assert_eq!(
        outcome.report.scenarios as usize,
        outcome.pack.scenarios.len()
    );
    assert_eq!(
        outcome.report.bases + outcome.report.variants,
        outcome.report.scenarios
    );
    assert!(outcome.report.variants > 0, "the pack ships variants");
    let first_variant = outcome
        .pack
        .scenarios
        .iter()
        .position(|scenario| scenario.provenance.is_variant())
        .expect("a variant");
    assert!(
        outcome.pack.scenarios[..first_variant]
            .iter()
            .all(|scenario| !scenario.provenance.is_variant()),
        "bases must precede variants so the session picker sees every position first"
    );
    assert!(
        outcome.pack.scenarios[first_variant..]
            .iter()
            .all(|scenario| scenario.provenance.is_variant()),
        "every variant must follow the base block"
    );

    // The manifest and the body are present and agree.
    let published = outcome.published.as_ref().expect("published");
    let decoded = decode_pack(&std::fs::read(&published.path).expect("body")).expect("decode");
    assert_eq!(decoded, outcome.pack);
    assert_eq!(published.entry.sha256, outcome.report.sha256);
    assert_eq!(
        published.entry.scenario_count as usize,
        outcome.pack.scenarios.len()
    );
    assert_eq!(
        published.entry.bytes,
        std::fs::metadata(&published.path).expect("meta").len()
    );
    assert_eq!(
        outcome.report.export_path,
        format!(
            "packs/{}",
            published.path.file_name().unwrap().to_string_lossy()
        )
    );

    // `packs` and `pack_scenarios` agree with the JSON export, row for row.
    let (sha256, bytes, count, export_path, licence): (String, i64, i64, String, String) = db
        .connection
        .query_row(
            "SELECT sha256, bytes, scenario_count, export_path, licence FROM packs WHERE pack_id = ?1",
            params![PACK_ID],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .expect("packs row");
    assert_eq!(sha256, outcome.report.sha256);
    assert_eq!(bytes, outcome.report.bytes as i64);
    assert_eq!(count as usize, outcome.pack.scenarios.len());
    assert_eq!(export_path, outcome.report.export_path);
    assert_eq!(licence, "CC-BY-4.0");

    let rows = query_rows(&db.connection);
    assert_eq!(rows.len(), outcome.pack.scenarios.len());
    for (index, (row, scenario)) in rows.iter().zip(&outcome.pack.scenarios).enumerate() {
        assert_eq!(row.scenario_id, scenario.id.as_str());
        assert_eq!(row.ordinal, index as i64);
        assert_eq!(
            row.base.as_deref(),
            scenario
                .provenance
                .variant_of
                .as_ref()
                .map(|id| id.as_str())
        );
        assert_eq!(row.lesson_id, scenario.lesson_id);
        assert_eq!(row.state_hash, exact_state_hash(&scenario.state));
        assert_eq!(row.variant, i64::from(scenario.provenance.is_variant()));
        let json = serde_json::to_vec(scenario).expect("scenario json");
        let stored: String = db
            .connection
            .query_row(
                "SELECT scenario_sha256 FROM pack_scenarios WHERE pack_id = ?1 AND scenario_id = ?2",
                params![PACK_ID, scenario.id.as_str()],
                |row| row.get(0),
            )
            .expect("scenario hash");
        assert_eq!(stored, sha256_hex(&json));
    }

    // The report carries the mix, the largest base share and the agent union.
    assert!(!outcome.report.families.is_empty());
    assert!(
        outcome
            .report
            .largest_base
            .as_ref()
            .is_some_and(|base| base.scenarios >= 2),
        "a base with a variant is the largest: {:?}",
        outcome.report.largest_base
    );
    assert!(!outcome.report.agents.is_empty());
    assert!((0.0..=1.0).contains(&outcome.report.variant_share));
    assert_eq!(outcome.report.limits, AssemblyLimits::default());

    // The directory audit is clean and the report was written.
    let audit = audit_pack_dir(&db.root.packs_dir(), None, &AuditOptions::default())
        .expect("directory audit");
    assert!(audit.is_clean(), "{:?}", audit.failures());
    let report_path = outcome.report_path.as_ref().expect("report path");
    let report: AssemblyReport =
        serde_json::from_slice(&std::fs::read(report_path).expect("report")).expect("report json");
    assert_eq!(report, outcome.report);

    // Determinism: the same rows assemble to the same SHA-256.
    let again = crate::miner::pack::run_assembly(
        &db.root,
        &AssemblyOptions {
            dry_run: true,
            ..options()
        },
    )
    .expect("dry assembly");
    assert_eq!(again.report.sha256, outcome.report.sha256);
    assert_eq!(again.pack, outcome.pack);
    assert!(!again.written);
}

// ---------------------------------------------------------------------------
// Limits and dedupe.
// ---------------------------------------------------------------------------

#[test]
fn enforces_family_quotas_on_the_selection() {
    let db = database();
    selection(&db, 3);

    let quota = crate::miner::pack::run_assembly(
        &db.root,
        &AssemblyOptions {
            dry_run: true,
            limits: AssemblyLimits {
                max_per_base: 8,
                max_pack_share: 1.0,
                family_quotas: BTreeMap::from([("book".to_string(), 1)]),
                max_variants: None,
                variants_disabled: false,
            },
            ..options()
        },
    )
    .expect("quota assembly");
    assert_eq!(
        quota.report.drop_counts.get("family_quota").copied(),
        Some(2),
        "three book bases against a quota of one: {:?}",
        quota.report.drop_counts
    );
    let book = quota
        .report
        .families
        .iter()
        .find(|family| family.family == "book")
        .expect("book family");
    assert_eq!(book.quota, Some(1));
    assert_eq!(book.bases, 1);
    assert!(
        book.variants >= 1,
        "the surviving base keeps its gated variants"
    );
    for drop in &quota.report.dropped {
        assert!(matches!(
            drop.reason.as_str(),
            "family_quota" | "base_dropped" | "per_base_cap" | "duplicate_state"
        ));
    }
}

/// A synthetic group, so the cap/dedupe rules can be exercised without
/// depending on how many variants the V2 policy happens to preserve.
fn synthetic_group(family: &str, base_id: &str, state_hash: &str, variants: usize) -> BaseGroup {
    let pack = crate::miner::pack::fixture_pack("2026-11-16T00:00:00Z").expect("fixture pack");
    let mut template = pack.scenarios[0].clone();
    let mut rename = |id: &str| {
        template.id = crate::miner::ScenarioKey::parse(id).expect("slug");
        template.clone()
    };
    BaseGroup {
        base_id: base_id.to_string(),
        base: Some(super::Assembled {
            scenario: rename(base_id),
            state_hash: state_hash.to_string(),
            family: family.to_string(),
        }),
        variants: (0..variants)
            .map(|index| {
                let id = format!("{base_id}-v{index:02}");
                super::Assembled {
                    scenario: rename(&id),
                    state_hash: format!("{state_hash}-v{index:02}"),
                    family: family.to_string(),
                }
            })
            .collect(),
    }
}

#[test]
fn caps_dedupe_and_family_quotas_apply_to_the_groups() {
    let options = AssemblyOptions {
        limits: AssemblyLimits {
            max_per_base: 1,
            max_pack_share: 1.0,
            ..AssemblyLimits::default()
        },
        ..AssemblyOptions::default()
    };
    let mut groups = vec![synthetic_group("book", "base-a", "state-a", 3)];
    let mut drops = Vec::new();
    super::apply_dedupe_and_caps(&mut groups, &options, &mut drops);
    assert_eq!(groups[0].variants.len(), 1, "the per-base cap keeps one");
    assert_eq!(
        drops
            .iter()
            .filter(|drop| drop.reason == "per_base_cap")
            .count(),
        2
    );

    // Exact state hashes collapse in pack order.
    let options = AssemblyOptions::default();
    let mut groups = vec![
        synthetic_group("book", "base-a", "same-state", 0),
        synthetic_group("book", "base-b", "same-state", 0),
    ];
    let mut drops = Vec::new();
    super::apply_dedupe_and_caps(&mut groups, &options, &mut drops);
    assert!(groups[0].base.is_some());
    assert!(groups[1].base.is_none(), "the later duplicate is dropped");
    assert_eq!(
        drops
            .iter()
            .filter(|drop| drop.reason == "duplicate_state")
            .count(),
        1
    );

    // Quotas count base scenarios and take their variants with them.
    let options = AssemblyOptions {
        limits: AssemblyLimits {
            max_pack_share: 1.0,
            family_quotas: BTreeMap::from([("book".to_string(), 1)]),
            ..AssemblyLimits::default()
        },
        ..AssemblyOptions::default()
    };
    let mut groups = vec![
        synthetic_group("book", "base-a", "state-a", 1),
        synthetic_group("book", "base-b", "state-b", 2),
    ];
    let mut drops = Vec::new();
    super::apply_dedupe_and_caps(&mut groups, &options, &mut drops);
    assert!(groups[0].base.is_some());
    assert!(groups[1].base.is_none());
    assert!(
        groups[1].variants.is_empty(),
        "a dropped base's variants go too"
    );
    assert_eq!(
        drops
            .iter()
            .filter(|drop| drop.reason == "family_quota")
            .count(),
        1
    );
    assert_eq!(
        drops
            .iter()
            .filter(|drop| drop.reason == "base_dropped")
            .count(),
        2
    );

    // A global variant ceiling keeps evenly spaced variants, not the tail.
    let options = AssemblyOptions {
        limits: AssemblyLimits {
            max_pack_share: 1.0,
            max_variants: Some(3),
            ..AssemblyLimits::default()
        },
        ..AssemblyOptions::default()
    };
    let mut groups = vec![
        synthetic_group("book", "base-a", "state-a", 2),
        synthetic_group("book", "base-b", "state-b", 2),
        synthetic_group("book", "base-c", "state-c", 2),
    ];
    let mut drops = Vec::new();
    super::apply_dedupe_and_caps(&mut groups, &options, &mut drops);
    let kept: usize = groups.iter().map(|group| group.variants.len()).sum();
    assert_eq!(kept, 3, "the ceiling keeps exactly three variants");
    assert_eq!(
        drops
            .iter()
            .filter(|drop| drop.reason == "variant_limit")
            .count(),
        3
    );
    assert!(
        groups.iter().all(|group| !group.variants.is_empty()),
        "the kept variants are spread across bases: {:?}",
        groups
            .iter()
            .map(|group| group.variants.len())
            .collect::<Vec<_>>()
    );
}

#[test]
fn dedupe_drops_a_second_row_with_the_same_state() {
    let db = database();
    selection(&db, 2);

    // A hand-written row that repeats the first base's state under a new id.
    let (decision_id, lesson_id, family, correct_action, accepted, provenance, created_at): (
        String,
        String,
        String,
        String,
        String,
        String,
        String,
    ) = db
        .connection
        .query_row(
            "SELECT decision_id, lesson_id, family, correct_action, accepted, provenance, created_at
             FROM selected_scenarios WHERE pack_id = ?1 ORDER BY scenario_id LIMIT 1",
            params![PACK_ID],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .expect("first base");
    db.connection
        .execute(
            "INSERT INTO selected_scenarios (
                scenario_id, decision_id, pack_id, lesson_id, family, correct_action,
                accepted, label_kind, label_source, provenance, selection_family, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'book', 'book', ?8, ?9, ?10)",
            params![
                "zzz-duplicate",
                decision_id,
                PACK_ID,
                lesson_id,
                family,
                correct_action,
                accepted,
                provenance,
                "book",
                created_at,
            ],
        )
        .expect("duplicate row");

    let outcome = crate::miner::pack::run_assembly(
        &db.root,
        &AssemblyOptions {
            dry_run: true,
            ..options()
        },
    )
    .expect("assembles");
    assert!(
        outcome
            .report
            .drop_counts
            .get("duplicate_state")
            .copied()
            .unwrap_or(0)
            >= 1,
        "{:?}",
        outcome.report.drop_counts
    );
    assert!(
        !outcome
            .pack
            .scenarios
            .iter()
            .any(|scenario| scenario.id.as_str().ends_with("zzz-duplicate")),
        "the later duplicate must not ship"
    );
}

#[test]
fn refuses_a_pack_over_its_byte_or_scenario_budget() {
    let db = database();
    selection(&db, 2);

    let error = crate::miner::pack::run_assembly(
        &db.root,
        &AssemblyOptions {
            dry_run: true,
            budget: crate::miner::PackBudget {
                max_bytes: 64,
                ..crate::miner::PackBudget::default()
            },
            ..options()
        },
    )
    .expect_err("over budget");
    match error {
        PackError::Assembly { detail, .. } => assert!(detail.contains("byte ceiling")),
        other => panic!("unexpected error: {other}"),
    }

    let error = crate::miner::pack::run_assembly(
        &db.root,
        &AssemblyOptions {
            dry_run: true,
            budget: crate::miner::PackBudget {
                max_scenarios: 1,
                ..crate::miner::PackBudget::default()
            },
            ..options()
        },
    )
    .expect_err("over the scenario ceiling");
    match error {
        PackError::Assembly { detail, .. } => assert!(detail.contains("scenario ceiling")),
        other => panic!("unexpected error: {other}"),
    }
}

// ---------------------------------------------------------------------------
// The review gate.
// ---------------------------------------------------------------------------

fn reported_action(answer: &CorrectAction) -> ReportedAction {
    match answer {
        CorrectAction::Riichi { discard } => {
            ReportedAction::new(CorrectActionType::Riichi, discard.clone())
        }
        CorrectAction::Dama { discard } => {
            ReportedAction::new(CorrectActionType::Dama, discard.clone())
        }
        CorrectAction::Fold { discard } => {
            ReportedAction::new(CorrectActionType::Fold, discard.clone())
        }
        CorrectAction::Kan { tile } => ReportedAction::new(CorrectActionType::Kan, tile.clone()),
        CorrectAction::Discard { tile } => {
            ReportedAction::new(CorrectActionType::Discard, tile.clone())
        }
        CorrectAction::Pass => ReportedAction::new(CorrectActionType::Pass, ""),
        CorrectAction::Best { action, tile, .. } => {
            ReportedAction::new(CorrectActionType::Best, tile.clone().unwrap_or_default())
                .with_action_name(action.clone())
        }
    }
}

fn review_item(base: &BaseScenario, state: &GameState, index: usize) -> ReviewItem {
    let report = build_report(BuildReportRequest {
        table: state.clone(),
        answer: reported_action(&state.correct_action),
        reason: ReportReason::Other,
        note: None,
        created_at: STAMP.to_string(),
        report_id: format!("p1b-review-{index:03}"),
        commit: None,
        build_time: None,
        ai: None,
    })
    .expect("report");
    ReviewItem {
        schema: REVIEW_SCHEMA.to_string(),
        version: REVIEW_VERSION,
        queue_id: base.id().to_string(),
        pack_id: PACK_ID.to_string(),
        decision_id: base.decision_id.clone().expect("decision"),
        replay_id: base.scenario.provenance.replay_id.as_str().to_string(),
        replay_family: "book".to_string(),
        family: Some(Family::Book),
        families: vec![Family::Book],
        rank: Some(index + 1),
        score: 0.5,
        signals: Signals::zero(),
        held_out: false,
        selection_reason: format!(
            "family=book;section=none;kind=self_turn;turn=early;rank={}",
            index + 1
        ),
        lesson: Some(base.scenario.lesson_id.clone()),
        book_section: None,
        label_kind: "book".to_string(),
        label_stability: Some("stable".to_string()),
        label_model: "mortal-298k".to_string(),
        decision_kind: "self_turn".to_string(),
        event_index: base.scenario.provenance.decision_index,
        turn: 0,
        turn_bucket: "early".to_string(),
        exact_hash: exact_state_hash(state),
        visible_fingerprint: exact_state_hash(state),
        review: report,
    }
}

fn write_queue(db: &Db, items: &[ReviewItem], verdicts: &[(&str, DispositionVerdict)]) {
    let paths = crate::miner::selection_paths(&db.root, PACK_ID);
    std::fs::create_dir_all(&paths.dir).expect("review dir");
    let mut text = String::new();
    for item in items {
        text.push_str(&serde_json::to_string(item).expect("item"));
        text.push('\n');
    }
    crate::miner::storage::write_atomic(&paths.queue, text.as_bytes()).expect("queue");
    let dispositions: Vec<ReviewDisposition> = verdicts
        .iter()
        .map(|(queue_id, verdict)| ReviewDisposition {
            schema: DISPOSITION_SCHEMA.to_string(),
            version: DISPOSITION_VERSION,
            queue_id: (*queue_id).to_string(),
            decision_id: items
                .iter()
                .find(|item| item.queue_id == *queue_id)
                .expect("known id")
                .decision_id
                .clone(),
            verdict: *verdict,
            note: None,
            reviewed_at: "20261117-000000".to_string(),
        })
        .collect();
    write_dispositions(&paths.dir.join("dispositions.jsonl"), &dispositions).expect("verdicts");
}

#[test]
fn a_reviewer_rejection_is_excluded_and_the_pack_ships_the_accepted_rows() {
    let db = database();
    let bases = selection(&db, 2);
    let items: Vec<ReviewItem> = bases
        .iter()
        .enumerate()
        .map(|(index, base)| review_item(base, &base.scenario.state, index))
        .collect();
    write_queue(
        &db,
        &items,
        &[
            (items[0].queue_id.as_str(), DispositionVerdict::Accepted),
            (items[1].queue_id.as_str(), DispositionVerdict::Rejected),
        ],
    );

    let outcome = crate::miner::pack::run_assembly(
        &db.root,
        &AssemblyOptions {
            dry_run: true,
            ..options()
        },
    )
    .expect("assembles");
    assert!(outcome.report.review.checked);
    assert_eq!(outcome.report.review.items, 2);
    assert_eq!(outcome.report.review.accepted, 1);
    assert_eq!(outcome.report.review.rejected, 1);
    assert_eq!(
        outcome.report.drop_counts.get("reviewer_rejected").copied(),
        Some(1)
    );
    let ids: Vec<&str> = outcome
        .pack
        .scenarios
        .iter()
        .map(|scenario| scenario.id.as_str())
        .collect();
    assert!(ids.contains(&items[0].queue_id.as_str()));
    assert!(
        !ids.iter()
            .any(|id| id.starts_with(items[1].queue_id.as_str())),
        "a rejected base and its variants must not ship: {ids:?}"
    );
}

#[test]
fn a_pending_or_invalid_review_queue_refuses_the_pack() {
    let db = database();
    let bases = selection(&db, 2);
    let items: Vec<ReviewItem> = bases
        .iter()
        .enumerate()
        .map(|(index, base)| review_item(base, &base.scenario.state, index))
        .collect();

    // One item pending.
    write_queue(
        &db,
        &items,
        &[(items[0].queue_id.as_str(), DispositionVerdict::Accepted)],
    );
    let error = crate::miner::pack::run_assembly(&db.root, &options()).expect_err("pending");
    match error {
        PackError::Review { detail, .. } => assert!(detail.contains("no disposition"), "{detail}"),
        other => panic!("unexpected error: {other}"),
    }

    // Every item has a verdict, but one embedded report is invalid.
    let mut broken = items.clone();
    broken[1].review.schema = "riichiprac.not-a-report".to_string();
    write_queue(
        &db,
        &broken,
        &[
            (items[0].queue_id.as_str(), DispositionVerdict::Accepted),
            (items[1].queue_id.as_str(), DispositionVerdict::Accepted),
        ],
    );
    let error = crate::miner::pack::run_assembly(&db.root, &options()).expect_err("invalid");
    match error {
        PackError::Review { detail, .. } => {
            assert!(detail.contains("invalid embedded report"), "{detail}");
        }
        other => panic!("unexpected error: {other}"),
    }
}

// ---------------------------------------------------------------------------
// Guard rails.
// ---------------------------------------------------------------------------

#[test]
fn limits_parse_and_bound_the_variant_cap() {
    let quotas =
        AssemblyLimits::parse_family_quotas(&["book=30".to_string(), " coverage = 15".to_string()])
            .expect("quotas");
    assert_eq!(quotas.get("book"), Some(&30));
    assert_eq!(quotas.get("coverage"), Some(&15));
    for bad in [
        vec!["book".to_string()],
        vec!["=3".to_string()],
        vec!["book=0".to_string()],
        vec!["book=many".to_string()],
    ] {
        assert!(
            AssemblyLimits::parse_family_quotas(&bad).is_err(),
            "{bad:?} must be rejected"
        );
    }

    let limits = AssemblyLimits {
        max_per_base: 8,
        max_pack_share: 0.20,
        ..AssemblyLimits::default()
    };
    assert_eq!(limits.effective_variant_cap(100), 8, "the base cap wins");
    assert_eq!(limits.effective_variant_cap(10), 2, "20 % of ten is two");
    assert_eq!(limits.effective_variant_cap(1), 1, "never zero");
    assert!(limits.validate().is_ok());
    assert!(
        AssemblyLimits {
            max_per_base: 0,
            ..limits.clone()
        }
        .validate()
        .is_err()
    );
    assert!(
        AssemblyLimits {
            max_pack_share: 0.0,
            ..limits
        }
        .validate()
        .is_err()
    );
}

#[test]
fn row_timestamps_normalise_to_iso_and_pick_the_latest() {
    assert_eq!(
        super::iso_from_stamp("20261117-120000").expect("stamp"),
        "2026-11-17T12:00:00Z"
    );
    assert_eq!(
        super::iso_from_stamp("2026-11-17T12:00:00Z").expect("iso"),
        "2026-11-17T12:00:00Z"
    );
    assert!(super::iso_from_stamp("yesterday").is_err());
}

#[test]
fn assembly_refuses_a_missing_selection_and_an_ungated_variant() {
    let db = database();
    let error = crate::miner::pack::run_assembly(&db.root, &options()).expect_err("no rows");
    match error {
        PackError::Assembly { detail, .. } => assert!(detail.contains("no `selected_scenarios`")),
        other => panic!("unexpected error: {other}"),
    }

    let bases = selection(&db, 1);
    let error = crate::miner::pack::run_assembly(
        &db.root,
        &AssemblyOptions {
            dry_run: true,
            generated_at: Some("yesterday".to_string()),
            ..options()
        },
    )
    .expect_err("bad timestamp");
    match error {
        PackError::Assembly { detail, .. } => assert!(detail.contains("ISO-8601"), "{detail}"),
        other => panic!("unexpected error: {other}"),
    }

    let variant_id: String = db
        .connection
        .query_row(
            "SELECT scenario_id FROM selected_scenarios
             WHERE pack_id = ?1 AND variant_of IS NOT NULL LIMIT 1",
            params![PACK_ID],
            |row| row.get(0),
        )
        .expect("a persisted variant");
    // An ungated variant (no `variants` row) must be refused.
    db.connection
        .execute(
            "DELETE FROM variants WHERE variant_id = ?1",
            params![variant_id],
        )
        .expect("remove gate row");
    let error = crate::miner::pack::run_assembly(&db.root, &options()).expect_err("ungated");
    match error {
        PackError::Assembly { detail, .. } => {
            assert!(detail.contains("no `variants` row"), "{detail}");
        }
        other => panic!("unexpected error: {other}"),
    }
    assert_eq!(bases.len(), 1);
    assert!(ScenarioId::from_id(&bases[0].scenario.lesson_id).is_some());
}

#[test]
fn the_pack_interleaves_bases_from_the_same_replay() {
    let mut groups = vec![
        synthetic_group("book", "base-a", "state-a", 1),
        synthetic_group("book", "base-b", "state-b", 1),
        synthetic_group("book", "base-c", "state-c", 1),
        synthetic_group("book", "base-d", "state-d", 1),
        synthetic_group("book", "base-e", "state-e", 1),
    ];
    for (index, group) in groups.iter_mut().enumerate() {
        let replay = if index < 3 { "a" } else { "b" };
        group
            .base
            .as_mut()
            .expect("base")
            .scenario
            .provenance
            .replay_id = ReplayId::parse(&replay.repeat(64)).expect("replay id");
    }
    super::order_groups_for_pack(&mut groups);
    let replays: Vec<String> = groups
        .iter()
        .map(|group| {
            group
                .base
                .as_ref()
                .expect("base")
                .scenario
                .provenance
                .replay_id
                .as_str()
                .chars()
                .next()
                .expect("first")
                .to_string()
        })
        .collect();
    for pair in replays.windows(2) {
        assert_ne!(
            pair[0], pair[1],
            "adjacent bases share a replay: {replays:?}"
        );
    }
}

#[test]
fn disabling_variants_ships_the_reviewed_bases_only() {
    let options = AssemblyOptions {
        limits: AssemblyLimits {
            max_pack_share: 1.0,
            variants_disabled: true,
            ..AssemblyLimits::default()
        },
        ..AssemblyOptions::default()
    };
    let mut groups = vec![
        synthetic_group("book", "base-a", "state-a", 2),
        synthetic_group("book", "base-b", "state-b", 3),
    ];
    let mut drops = Vec::new();
    super::apply_dedupe_and_caps(&mut groups, &options, &mut drops);
    assert_eq!(
        groups
            .iter()
            .map(|group| group.variants.len())
            .sum::<usize>(),
        0
    );
    assert!(groups.iter().all(|group| group.base.is_some()));
    assert_eq!(
        drops
            .iter()
            .filter(|drop| drop.reason == "variants_disabled")
            .count(),
        5
    );
}
