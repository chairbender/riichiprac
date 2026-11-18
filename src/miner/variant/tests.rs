//! V2 acceptance tests: the §4.7 gate and the §4.8 transform-stage cases.
//!
//! The book cases run on the app's own seeded lesson generators (the rehearsal
//! path), so they need no corpus and no checkpoint. The Mortal cases use a
//! scripted [`StateEvaluator`] and the real L1 label cache, which is the same
//! code path the real labeler uses with a checkpoint.

use std::cell::Cell;
use std::sync::OnceLock;

use rusqlite::Connection;

use crate::ai::actions::legal_actions;
use crate::ai::finalize::correct_action_from_info;
use crate::ai::wasm_bridge::{ActionEvaluation, Evaluation};
use crate::classifier::{self, Allowed, TransformPolicy};
use crate::generator::{ScenarioId, support::state_validation::validate_reachable_state};
use crate::miner::label::cache::LabelCache;
use crate::miner::label::thresholds::{PercentileConfig, PercentileCuts};
use crate::miner::label::{LabelError, LabelOptions, ModelIdentity, StateEvaluator};
use crate::miner::pack::{
    LabelCheck, LabelCheckKind, Pack, PackAuditContext, PackScenario, ScenarioKey, accepted_for,
    audit_pack, find_spoiler, fixture_games, pack_report,
};
use crate::miner::provenance::GameProvenance;
use crate::miner::select::dedupe::exact_state_hash;
use crate::miner::storage::migrate;
use crate::miner::transform::{Suit, SuitMap, Transform, TransformChain};
use crate::state::GameState;

use super::base::{BaseLabel, BaseScenario};
use super::gate::{GateDeps, LabelUse, VariantLabeler};
use super::plan::{allowed_families, plan_for};
use super::rehearsal::rehearsal_bases;
use super::report::PairOverride;
use super::stage::{PackAssembly, VariantRecord, VariantStage, build_pack};
use super::{TransformFamily, VariantConfig, VariantLabelKind, persist};

const STAMP: &str = "2026-11-17T00:00:00Z";

fn sample_bases() -> &'static [BaseScenario] {
    static BASES: OnceLock<Vec<BaseScenario>> = OnceLock::new();
    BASES.get_or_init(|| {
        rehearsal_bases(8)
            .expect("the rehearsal builds 8 bases")
            .bases
    })
}

fn base_for(lesson: ScenarioId) -> BaseScenario {
    let games = fixture_games();
    let mut index = 0;
    loop {
        crate::rng::seed(0x5eed_0000 + index);
        if let Ok(base) = BaseScenario::from_generated(lesson, index as usize, &games[0]) {
            return base;
        }
        index += 1;
        assert!(index < 40, "cannot generate `{}`", lesson.as_str());
    }
}

fn empty_cuts() -> PercentileCuts {
    PercentileCuts::build(
        &PercentileConfig::default(),
        &std::collections::BTreeMap::new(),
    )
    .expect("empty cuts")
}

fn stage_deps<'a>(
    cuts: &'a PercentileCuts,
    labeler: Option<&'a VariantLabeler<'a>>,
) -> GateDeps<'a> {
    GateDeps {
        labeler,
        cuts,
        classifier_version: "1",
    }
}

fn run_stage(
    bases: &[BaseScenario],
    config: &VariantConfig,
    labeler: Option<&VariantLabeler<'_>>,
) -> super::StageOutcome {
    let cuts = empty_cuts();
    VariantStage {
        config,
        deps: stage_deps(&cuts, labeler),
        pack_id: "test-pack".to_string(),
        generated_at: STAMP.to_string(),
    }
    .run(bases)
    .expect("the stage runs")
}

fn open_policy_all() -> TransformPolicy {
    TransformPolicy {
        seat_perm: Allowed::AllowWithRecompute,
        suit_perm: Allowed::AllowWithRecompute,
        rank_mirror: Allowed::AllowWithRecompute,
        wind_relabel: Allowed::AllowWithRecompute,
        red5_normalize: Allowed::AllowWithRecompute,
        note: "test",
    }
}

fn rehearsal_games() -> Vec<GameProvenance> {
    fixture_games()
}

fn rehearsal_pack(outcome: &super::StageOutcome, bases: &[BaseScenario]) -> Pack {
    build_pack(&PackAssembly {
        pack_id: "rehearsal-test",
        generated_at: STAMP,
        licence: "CC-BY-4.0",
        attribution: "Test rehearsal data, CC BY 4.0.",
        bases,
        variants: &outcome.variants,
        games: &rehearsal_games(),
    })
    .expect("the rehearsal pack assembles")
}

// ---------------------------------------------------------------------------
// §4.7: every shipped variant is valid, labelled, unique, capped and recorded.
// ---------------------------------------------------------------------------

#[test]
fn every_shipped_variant_is_reachable_gated_and_recorded() {
    let bases = sample_bases();
    let config = VariantConfig {
        variants_per_base: 2,
        min_yield: 0.0,
        ..VariantConfig::default()
    };
    let outcome = run_stage(bases, &config, None);
    assert!(!outcome.variants.is_empty(), "the rehearsal ships variants");

    let mut families = std::collections::BTreeSet::new();
    for record in &outcome.variants {
        families.insert(record.families[0]);
        let scenario = &record.scenario;
        validate_reachable_state(&scenario.state)
            .unwrap_or_else(|message| panic!("{}: {message}", scenario.id));
        assert_eq!(scenario.correct_action, scenario.state.correct_action);
        assert_eq!(scenario.accepted, accepted_for(&scenario.state));
        assert!(find_spoiler(scenario).is_none(), "{}", scenario.id);

        let provenance = &scenario.provenance;
        assert_eq!(provenance.variant_of.as_ref(), Some(&record.base));
        assert!(provenance.transform_chain.is_some());
        assert_eq!(provenance.transform_chain.as_ref().unwrap(), &record.chain);
        assert!(!record.chain.transform_seed.trim().is_empty());
        assert_eq!(
            provenance.transform_seed.as_deref(),
            Some(record.chain.transform_seed.as_str())
        );
        let check = provenance.label_check.as_ref().expect("label check");
        assert!(check.preserved);
        assert_eq!(check.kind, LabelCheckKind::Book);
        assert_eq!(
            provenance.transforms,
            record
                .families
                .iter()
                .map(|family| family.as_str().to_string())
                .collect::<Vec<_>>()
        );
        assert!(scenario.provenance.is_variant());
        assert!(scenario.validation.state_valid);
        assert!(scenario.validation.answer_recomputed);
    }
    assert!(
        families.len() >= 2,
        "the shipped set spans at least two families: {families:?}"
    );
    assert_eq!(outcome.report.shipped, outcome.variants.len() as u64);
    assert!(outcome.report.label_kinds.contains_key("book"));
    assert!(outcome.report.share.variant_share > 0.0);
    assert!(
        outcome
            .report
            .share
            .largest_base
            .as_ref()
            .is_some_and(|base| base.scenarios >= 2)
    );
}

#[test]
fn the_shipped_set_is_reproducible_for_one_seed() {
    let bases = sample_bases();
    let config = VariantConfig {
        variants_per_base: 2,
        min_yield: 0.0,
        ..VariantConfig::default()
    };
    let one = run_stage(bases, &config, None);
    let two = run_stage(bases, &config, None);
    let ids = |outcome: &super::StageOutcome| {
        outcome
            .variants
            .iter()
            .map(|record| record.id.to_string())
            .collect::<Vec<_>>()
    };
    assert_eq!(ids(&one), ids(&two));
    let hashes = |outcome: &super::StageOutcome| {
        outcome
            .variants
            .iter()
            .map(|record| record.state_hash.clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(hashes(&one), hashes(&two));
}

#[test]
fn a_pair_below_the_configured_yield_is_disabled_and_ships_nothing() {
    let bases = sample_bases();
    // A 100 % threshold makes every imperfectly-preserving pair fail, which
    // exercises the same disable rule the default 50 % threshold uses.
    let config = VariantConfig {
        variants_per_base: 3,
        min_yield: 1.0,
        ..VariantConfig::default()
    };
    let outcome = run_stage(bases, &config, None);
    assert!(
        !outcome.report.disabled_pairs.is_empty(),
        "{:?}",
        outcome.report.pair_yield
    );
    for pair in &outcome.report.disabled_pairs {
        assert_eq!(pair.reason, "below_threshold");
        assert!(
            outcome.variants.iter().all(|record| {
                !(record.lesson_key == pair.lesson && record.families.contains(&pair.transform))
            }),
            "a disabled pair ships nothing: {pair:?}"
        );
    }
    let withdrawn_expected = outcome
        .report
        .pair_yield
        .iter()
        .filter(|pair| pair.disabled && pair.preserved > 0)
        .count();
    assert!(
        exited_withdrawal(&outcome, withdrawn_expected),
        "a disabled pair with preserved variants withdraws them: {} vs {:?}",
        outcome.report.withdrawn_disabled,
        outcome.report.pair_yield
    );
}

fn exited_withdrawal(outcome: &super::StageOutcome, withdrawn_expected: usize) -> bool {
    withdrawn_expected == 0 || outcome.report.withdrawn_disabled > 0
}

#[test]
fn a_reviewer_override_keeps_a_low_yield_pair_enabled_and_reports_it() {
    let bases = vec![base_for(ScenarioId::DefenseStuckHeuristic)];
    let config = VariantConfig {
        variants_per_base: 2,
        min_yield: 1.0,
        pair_overrides: vec![PairOverride {
            lesson: "defense_stuck_heuristic".to_string(),
            transform: TransformFamily::SuitPerm,
            enabled: true,
            note: Some("reviewed".to_string()),
        }],
        ..VariantConfig::default()
    };
    let outcome = run_stage(&bases, &config, None);
    assert!(
        outcome
            .variants
            .iter()
            .any(|record| record.families.contains(&TransformFamily::SuitPerm)),
        "{:?}",
        outcome.report.rejections
    );
    let suit = outcome
        .report
        .pair_yield
        .iter()
        .find(|pair| pair.transform == TransformFamily::SuitPerm)
        .expect("a suit row exists");
    assert!(!suit.disabled);
    assert!(
        !outcome
            .report
            .disabled_pairs
            .iter()
            .any(|pair| pair.transform == TransformFamily::SuitPerm)
    );
}

#[test]
fn an_explicit_reviewer_disable_withdraws_preserved_variants() {
    let bases = sample_bases();
    let config = VariantConfig {
        variants_per_base: 3,
        min_yield: 0.0,
        pair_overrides: vec![PairOverride {
            lesson: bases[0].label.key(),
            transform: TransformFamily::SuitPerm,
            enabled: false,
            note: Some("disabled for the test".to_string()),
        }],
        ..VariantConfig::default()
    };
    let outcome = run_stage(bases, &config, None);
    let lesson = bases[0].label.key();
    assert!(
        outcome
            .report
            .disabled_pairs
            .iter()
            .any(|pair| pair.lesson == lesson
                && pair.transform == TransformFamily::SuitPerm
                && pair.reason == "reviewer_disabled"),
        "{:?}",
        outcome.report.disabled_pairs
    );
    assert!(
        outcome
            .variants
            .iter()
            .filter(|record| record.lesson_key == lesson)
            .all(|record| !record.families.contains(&TransformFamily::SuitPerm)),
        "no withdrawn family ships for this lesson"
    );
    assert!(outcome.report.withdrawn_disabled > 0);
    assert!(outcome.report.rejections.contains_key("disabled_pair"));
}

#[test]
fn the_per_base_cap_truncates_and_the_report_says_so() {
    let base = base_for(ScenarioId::RyanmenProtorun);
    let config = VariantConfig {
        variants_per_base: 8,
        max_per_base: 2,
        attempts_per_base: Some(16),
        min_yield: 0.0,
        ..VariantConfig::default()
    };
    let outcome = run_stage(std::slice::from_ref(&base), &config, None);
    assert_eq!(outcome.variants.len(), 2, "the cap keeps two variants");
    assert!(outcome.report.dropped_by_cap > 0);
    let row = outcome
        .report
        .cap_limited
        .iter()
        .find(|row| row.base == base.id().as_str())
        .expect("the truncated base is reported");
    assert_eq!(row.kept, 2);
    assert_eq!(row.cap, 2);
    assert!(row.preserved > row.kept);
    assert_eq!(row.cause, super::report::CapCause::PerBase);
}

#[test]
fn the_pack_share_cap_binds_before_the_per_base_cap() {
    let base = base_for(ScenarioId::RyanmenProtorun);
    let config = VariantConfig {
        variants_per_base: 4,
        max_per_base: 8,
        max_pack_share: 0.2,
        pack_size: 5,
        attempts_per_base: Some(12),
        min_yield: 0.0,
        ..VariantConfig::default()
    };
    assert_eq!(config.effective_cap(), 1);
    assert_eq!(config.cap_cause(), super::report::CapCause::PackShare);
    let outcome = run_stage(&[base], &config, None);
    assert_eq!(outcome.variants.len(), 1);
    assert_eq!(outcome.report.effective_cap, 1);
    assert!(outcome.report.dropped_by_cap >= 1);
}

#[test]
fn a_duplicate_base_state_collapses_its_variants() {
    let base = base_for(ScenarioId::RyanmenProtorun);
    let mut twin = base.clone();
    twin.scenario.id = ScenarioKey::parse("twin-base").expect("slug");
    let config = VariantConfig {
        variants_per_base: 2,
        min_yield: 0.0,
        ..VariantConfig::default()
    };
    let outcome = run_stage(&[base, twin], &config, None);
    assert!(outcome.report.duplicate_states > 0);
    let hashes: std::collections::BTreeSet<&str> = outcome
        .variants
        .iter()
        .map(|record| record.state_hash.as_str())
        .collect();
    assert_eq!(hashes.len(), outcome.variants.len(), "no duplicate states");
}

#[test]
fn two_commuting_chains_collapse_to_one_dedupe_key() {
    let base = base_for(ScenarioId::RyanmenProtorun);
    let swap = SuitMap::new(Suit::Pin, Suit::Man, Suit::Sou).expect("bijection");
    let one = TransformChain::new("0x01")
        .with(Transform::SuitPerm { map: swap })
        .with(Transform::RankMirror {});
    let two = TransformChain::new("0x02")
        .with(Transform::RankMirror {})
        .with(Transform::SuitPerm { map: swap });
    let first = one.apply(&base.scenario.state).expect("applies");
    let second = two.apply(&base.scenario.state).expect("applies");
    assert_eq!(
        exact_state_hash(&first.state),
        exact_state_hash(&second.state),
        "the dedupe key is the state, not the chain"
    );
}

#[test]
fn a_variants_inverse_maps_its_answer_back_to_the_base() {
    let base = base_for(ScenarioId::RyanmenProtorun);
    let chain = plan_for(base.id().as_str(), open_policy_all(), "0x51", 1)
        .pop()
        .expect("a plan")
        .chain;
    let applied = chain.apply(&base.scenario.state).expect("applies");
    let inverse = applied.inverse();
    let restored = inverse.apply(&applied.state).expect("inverse applies");
    assert_eq!(restored, base.scenario.state);
    assert_eq!(
        inverse
            .map_correct_action(&applied.state.correct_action)
            .expect("maps"),
        base.scenario.correct_action
    );
}

#[test]
fn a_wrong_transformed_answer_is_rejected_by_verify_answer() {
    let base = base_for(ScenarioId::RyanmenProtorun);
    let chain = TransformChain::new("0x03").with(Transform::SuitPerm {
        map: SuitMap::new(Suit::Pin, Suit::Sou, Suit::Man).expect("bijection"),
    });
    let applied = chain.apply(&base.scenario.state).expect("applies");
    let inverse = applied.inverse();
    // A legal discard that is not the book answer.
    let wrong = applied
        .state
        .players
        .first()
        .expect("seat 0")
        .hand
        .iter()
        .find(|tile| Some(tile.as_str()) != applied.state.correct_action.tile())
        .expect("a non-answer tile")
        .clone();
    let wrong = crate::state::CorrectAction::discard(wrong);
    let accepted = vec![wrong.tile().unwrap_or_default().to_string()];
    let reject = super::gate::verify_answer(&base, &wrong, &accepted, &inverse)
        .expect_err("a different answer is rejected");
    assert!(
        reject.code == "answer_changed" || reject.code == "answer_set_changed",
        "{reject}"
    );
}

#[test]
fn the_gate_rejects_a_state_the_chain_makes_unreachable() {
    // A seat permutation moves rivers with the players; a base whose river
    // counts are not symmetric can stop being a legal turn order.
    let bases = sample_bases();
    let config = VariantConfig {
        variants_per_base: 8,
        attempts_per_base: Some(12),
        min_yield: 0.0,
        ..VariantConfig::default()
    };
    let outcome = run_stage(bases, &config, None);
    assert!(
        outcome.report.rejections.contains_key("state_unreachable")
            || outcome.report.rejections.contains_key("transform_rejected"),
        "{:?}",
        outcome.report.rejections
    );
    for record in &outcome.variants {
        validate_reachable_state(&record.scenario.state).expect("every shipped state is reachable");
    }
}

// ---------------------------------------------------------------------------
// §4.8 explicit lesson cases: policy first, classifier second.
// ---------------------------------------------------------------------------

#[test]
fn the_wind_order_lesson_denies_seat_and_wind_transforms() {
    let base = base_for(ScenarioId::WindDiscardOrder);
    let policy = base.policy(open_policy_all());
    let families = allowed_families(policy);
    assert!(!families.contains(&TransformFamily::SeatPerm));
    assert!(!families.contains(&TransformFamily::WindRelabel));
    assert!(families.contains(&TransformFamily::SuitPerm));
    let plans = plan_for(base.id().as_str(), policy, "0x51", 8);
    assert!(plans.iter().all(|plan| {
        !plan.families.contains(&TransformFamily::SeatPerm)
            && !plan.families.contains(&TransformFamily::WindRelabel)
    }));
    let outcome = run_stage(
        &[base],
        &VariantConfig {
            variants_per_base: 2,
            min_yield: 0.0,
            ..VariantConfig::default()
        },
        None,
    );
    assert!(outcome.variants.iter().all(|record| {
        !record.families.contains(&TransformFamily::SeatPerm)
            && !record.families.contains(&TransformFamily::WindRelabel)
    }));
}

#[test]
fn the_suji_trap_lesson_survives_a_suit_permutation() {
    let base = base_for(ScenarioId::SujiTrapRiichi);
    let outcome = run_stage(
        &[base],
        &VariantConfig {
            variants_per_base: 4,
            min_yield: 0.0,
            ..VariantConfig::default()
        },
        None,
    );
    assert!(
        outcome
            .variants
            .iter()
            .any(|record| record.families.contains(&TransformFamily::SuitPerm)),
        "{:?}",
        outcome.report.rejections
    );
    for record in &outcome.variants {
        assert_eq!(record.scenario.lesson_id, "suji_trap_riichi");
    }
}

#[test]
fn honitsu_survives_a_suit_permutation_with_the_same_lesson() {
    let base = base_for(ScenarioId::HonitsuDecision);
    let outcome = run_stage(
        &[base],
        &VariantConfig {
            variants_per_base: 6,
            min_yield: 0.0,
            attempts_per_base: Some(12),
            ..VariantConfig::default()
        },
        None,
    );
    assert!(
        outcome
            .variants
            .iter()
            .any(|record| record.families.contains(&TransformFamily::SuitPerm)),
        "{:?}",
        outcome.report.rejections
    );
    for record in &outcome.variants {
        assert_eq!(record.scenario.lesson_id, "honitsu_decision");
    }
}

#[test]
fn pinfu_head_rank_mirror_is_only_shipped_when_the_classifier_agrees() {
    let base = base_for(ScenarioId::PinfuHead);
    let config = VariantConfig {
        variants_per_base: 6,
        min_yield: 0.0,
        attempts_per_base: Some(12),
        ..VariantConfig::default()
    };
    let outcome = run_stage(std::slice::from_ref(&base), &config, None);
    for record in &outcome.variants {
        if !record.families.contains(&TransformFamily::RankMirror) {
            continue;
        }
        // The gate's own rule: the classifier must still name the lesson on the
        // transformed state. Assert it rather than assume the mirror preserves
        // the head rule.
        let lesson = ScenarioId::from_id("pinfu_head").expect("registered");
        assert!(
            classifier::classify(&record.scenario.state, lesson).is_some(),
            "{}",
            record.id
        );
    }
    // A rejection is allowed and expected for at least some mirrors; the point
    // is that nothing ships without the classifier.
    let _ = base;
}

#[test]
fn a_lesson_with_no_classifier_denies_every_transform() {
    // `sanshoku_pursuit` has a generator but no B1/B2 classifier, so it has no
    // declared policy. The catalogue's default is deny, not a guess.
    let state = crate::generator::generate_puzzle("sanshoku_pursuit").expect("generates");
    let scenario = PackScenario {
        id: ScenarioKey::parse("sanshoku-base").expect("slug"),
        lesson_id: state.category.clone(),
        book: None,
        title: "Sanshoku".to_string(),
        prompt: "Choose the correct action.".to_string(),
        correct_action: state.correct_action.clone(),
        accepted: accepted_for(&state),
        state,
        mortal: None,
        counterfactual: None,
        played: None,
        interestingness: None,
        provenance: crate::miner::pack::PackProvenance {
            replay_id: crate::miner::provenance::ReplayId::from_bytes(b"sanshoku"),
            decision_index: 0,
            kyoku: None,
            honba: None,
            turn: None,
            transforms: Vec::new(),
            transform_seed: None,
            variant_of: None,
            transform_chain: None,
            label_check: None,
        },
        validation: crate::miner::pack::PackValidation::fixture(),
    };
    let label = BaseLabel {
        kind: VariantLabelKind::Book,
        lesson: Some("sanshoku_pursuit".to_string()),
        top_action: None,
        probability_margin: None,
        q_gap_top2: None,
        decision_family: None,
        played_action: None,
    };
    let error = BaseScenario::from_pack_scenario(scenario, label)
        .expect_err("no classifier means no policy");
    assert!(
        error.to_string().contains("no registered classifier"),
        "{error}"
    );
}

#[test]
fn ittsu_and_placement_families_are_absent_and_fail_closed() {
    // The app ships no ittsu or placement classifier, so there is no policy to
    // opt them in; the stage cannot invent one.
    assert!(ScenarioId::from_id("ittsu_pursuit").is_none());
    assert!(ScenarioId::from_id("placement_decision").is_none());
    assert!(classifier::transform_policy(ScenarioId::SanshokuPursuit).is_none());
}

#[test]
fn red_five_normalisation_is_denied_by_the_riichi_lessons_policy() {
    let base = base_for(ScenarioId::RiichiJudgement);
    let policy = base.policy(open_policy_all());
    assert!(!TransformFamily::Red5Normalize.allowed(policy));
    assert!(!allowed_families(policy).contains(&TransformFamily::Red5Normalize));
}

#[test]
fn a_no_op_chain_is_rejected_as_transform_noop() {
    // A red-five normalisation on a state with no red five changes nothing.
    let mut base = base_for(ScenarioId::RyanmenProtorun);
    base.scenario.state.players.iter_mut().for_each(|player| {
        player.red_fives.clear();
        for discard in &mut player.discards {
            discard.is_red = false;
        }
    });
    let chain = TransformChain::new("0x01").with(Transform::Red5Normalize {});
    let cuts = empty_cuts();
    let deps = stage_deps(&cuts, None);
    let reject = super::gate::check(&base, &chain, &deps).expect_err("a no-op is not a variant");
    assert_eq!(reject.code, "transform_noop", "{reject}");
}

// ---------------------------------------------------------------------------
// Mortal labels: cache, top-1 inverse mapping and the close-call band.
// ---------------------------------------------------------------------------

struct ScriptedEvaluator {
    identity: ModelIdentity,
    base_hash: String,
    base_top: String,
    variant_top: String,
    base_gap: f32,
    variant_gap: f32,
    calls: Cell<usize>,
}

impl ScriptedEvaluator {
    fn new(base: &BaseScenario, base_top: &str, variant_top: &str, gap: f32) -> Self {
        Self {
            identity: ModelIdentity {
                model: "scripted.safetensors".to_string(),
                model_sha256: "b".repeat(64),
                gamma: None,
                pts: None,
            },
            base_hash: exact_state_hash(&base.scenario.state),
            base_top: base_top.to_string(),
            variant_top: variant_top.to_string(),
            base_gap: gap,
            variant_gap: gap,
            calls: Cell::new(0),
        }
    }

    fn evaluate_with(&self, top: &str, gap: f32, state: &GameState) -> Evaluation {
        let mut evaluations: Vec<ActionEvaluation> = legal_actions(state)
            .into_iter()
            .map(|info| ActionEvaluation {
                info,
                probability: 0.0,
                q_value: Some(0.0),
            })
            .collect();
        let top_index = evaluations
            .iter()
            .position(|scored| scored.info.action == top)
            .unwrap_or(0);
        let second = evaluations
            .iter()
            .position(|scored| scored.info.action != top)
            .unwrap_or(0);
        for (index, scored) in evaluations.iter_mut().enumerate() {
            scored.q_value = Some(if index == top_index {
                1.0
            } else if index == second {
                1.0 - gap
            } else {
                -1.0
            });
        }
        let max_q = 1.0_f32;
        let total: f32 = evaluations
            .iter()
            .map(|scored| (scored.q_value.unwrap_or(0.0) - max_q).exp())
            .sum();
        for scored in &mut evaluations {
            scored.probability = (scored.q_value.unwrap_or(0.0) - max_q).exp() / total;
        }
        evaluations.sort_by(|left, right| {
            right
                .probability
                .total_cmp(&left.probability)
                .then_with(|| left.info.action.cmp(&right.info.action))
        });
        let recommended_action = evaluations
            .first()
            .map_or_else(|| top.to_string(), |scored| scored.info.action.clone());
        Evaluation {
            model: self.identity.model.clone(),
            expected_value: -0.25,
            recommended_action,
            riichi_discard: None,
            evaluations,
        }
    }
}

impl StateEvaluator for ScriptedEvaluator {
    fn identity(&self) -> &ModelIdentity {
        &self.identity
    }

    fn evaluate(&self, state: &GameState) -> Result<Evaluation, LabelError> {
        self.calls.set(self.calls.get() + 1);
        let hash = exact_state_hash(state);
        if hash == self.base_hash {
            Ok(self.evaluate_with(&self.base_top, self.base_gap, state))
        } else {
            Ok(self.evaluate_with(&self.variant_top, self.variant_gap, state))
        }
    }
}

fn mortal_base(state: &GameState, top_action: &str, gap: f32, family: &str) -> BaseScenario {
    let mut state = state.clone();
    state.ai_decision = None;
    state.category = "mortal_best".to_string();
    state.target_action = crate::state::TargetAction::Best;
    let info = legal_actions(&state)
        .into_iter()
        .find(|info| info.action == top_action)
        .expect("the scripted top action is legal");
    state.correct_action = correct_action_from_info(&info, None);
    state.equivalent_tiles.clear();
    let accepted = accepted_for(&state);
    let scenario = PackScenario {
        id: ScenarioKey::parse("mortal-base").expect("slug"),
        lesson_id: state.category.clone(),
        book: None,
        title: "Mortal best".to_string(),
        prompt: "Choose the correct action.".to_string(),
        correct_action: state.correct_action.clone(),
        accepted,
        state,
        mortal: None,
        counterfactual: None,
        played: None,
        interestingness: None,
        provenance: crate::miner::pack::PackProvenance {
            replay_id: crate::miner::provenance::ReplayId::from_bytes(b"mortal-base"),
            decision_index: 0,
            kyoku: None,
            honba: None,
            turn: None,
            transforms: Vec::new(),
            transform_seed: None,
            variant_of: None,
            transform_chain: None,
            label_check: None,
        },
        validation: crate::miner::pack::PackValidation::fixture(),
    };
    BaseScenario::from_pack_scenario(
        scenario,
        BaseLabel {
            kind: VariantLabelKind::Mortal,
            lesson: None,
            top_action: Some(top_action.to_string()),
            probability_margin: Some(gap),
            q_gap_top2: Some(gap),
            decision_family: Some(family.to_string()),
            played_action: None,
        },
    )
    .expect("the mortal base validates")
}

fn top_action_of(base: &BaseScenario) -> String {
    let answer = &base.scenario.correct_action;
    crate::verdict::mortal_action_for_correct(answer)
}

fn labeler_and_cache<'a>(
    evaluator: &'a ScriptedEvaluator,
    connection: &'a Connection,
) -> (LabelCache<'a>, LabelOptions) {
    let _ = evaluator;
    (LabelCache::new(connection), LabelOptions::default())
}

#[test]
fn a_mortal_base_without_a_labeler_is_rejected() {
    let source = base_for(ScenarioId::RyanmenProtorun);
    let top = top_action_of(&source);
    let base = mortal_base(&source.scenario.state, &top, 0.2, "self_turn/mid");
    let chain = TransformChain::new("0x01").with(Transform::SuitPerm {
        map: SuitMap::new(Suit::Pin, Suit::Sou, Suit::Man).expect("bijection"),
    });
    let cuts = empty_cuts();
    let deps = stage_deps(&cuts, None);
    let reject = super::gate::check(&base, &chain, &deps).expect_err("no labeler");
    assert_eq!(reject.code, "labeler_required", "{reject}");
}

#[test]
fn a_mortal_variant_whose_top_one_flips_is_rejected() {
    let source = base_for(ScenarioId::RyanmenProtorun);
    let top = top_action_of(&source);
    let base = mortal_base(&source.scenario.state, &top, 0.2, "self_turn/mid");
    let chain = TransformChain::new("0x01").with(Transform::SuitPerm {
        map: SuitMap::new(Suit::Pin, Suit::Sou, Suit::Man).expect("bijection"),
    });
    let applied = chain.apply(&base.scenario.state).expect("applies");
    let mapped = chain.map_action_name(&top).expect("maps");
    // A different legal action of the transformed table.
    let other = legal_actions(&applied.state)
        .into_iter()
        .find(|info| info.action != mapped)
        .expect("another legal action")
        .action;
    let evaluator = ScriptedEvaluator::new(&base, &top, &other, 0.2);
    let connection = Connection::open_in_memory().expect("memory db");
    migrate(&connection).expect("migrate");
    let (cache, options) = labeler_and_cache(&evaluator, &connection);
    let labeler = VariantLabeler {
        evaluator: &evaluator,
        cache: &cache,
        options,
    };
    let cuts = empty_cuts();
    let deps = stage_deps(&cuts, Some(&labeler));
    let reject = super::gate::check(&base, &chain, &deps).expect_err("top-1 flip");
    assert_eq!(reject.code, "top1_changed", "{reject}");
}

#[test]
fn a_mortal_variant_with_a_stable_top_one_ships_and_uses_the_cache() {
    let source = base_for(ScenarioId::RyanmenProtorun);
    let top = top_action_of(&source);
    let base = mortal_base(&source.scenario.state, &top, 0.2, "self_turn/mid");
    let chain = TransformChain::new("0x01").with(Transform::SuitPerm {
        map: SuitMap::new(Suit::Pin, Suit::Sou, Suit::Man).expect("bijection"),
    });
    let applied = chain.apply(&base.scenario.state).expect("applies");
    let variant_top = chain.map_action_name(&top).expect("maps");
    assert!(
        legal_actions(&applied.state)
            .iter()
            .any(|info| info.action == variant_top),
        "the mapped top action is legal on the transformed table"
    );
    let evaluator = ScriptedEvaluator::new(&base, &top, &variant_top, 0.2);
    let connection = Connection::open_in_memory().expect("memory db");
    migrate(&connection).expect("migrate");
    let (cache, options) = labeler_and_cache(&evaluator, &connection);
    let labeler = VariantLabeler {
        evaluator: &evaluator,
        cache: &cache,
        options,
    };
    let cuts = empty_cuts();
    let deps = stage_deps(&cuts, Some(&labeler));
    let gated = super::gate::check(&base, &chain, &deps).expect("the label survives");
    assert_eq!(gated.label_check.kind, LabelCheckKind::Mortal);
    assert!(gated.model.is_some());
    assert_eq!(gated.label_use, LabelUse::Evaluated);
    assert_eq!(gated.state.category, "mortal_best");

    // A second gate run over the same transformed state is a cache hit and does
    // not evaluate again.
    let calls = evaluator.calls.get();
    let again = super::gate::check(&base, &chain, &deps).expect("the label survives");
    assert_eq!(again.label_use, LabelUse::Cached);
    assert_eq!(evaluator.calls.get(), calls, "the cache served the label");
}

#[test]
fn a_mortal_variant_that_leaves_the_close_call_band_is_rejected() {
    let source = base_for(ScenarioId::RyanmenProtorun);
    let top = top_action_of(&source);
    let base = mortal_base(&source.scenario.state, &top, 0.005, "self_turn/mid");
    let chain = TransformChain::new("0x01").with(Transform::SuitPerm {
        map: SuitMap::new(Suit::Pin, Suit::Sou, Suit::Man).expect("bijection"),
    });
    let variant_top = chain.map_action_name(&top).expect("maps");
    let mut evaluator = ScriptedEvaluator::new(&base, &top, &variant_top, 0.005);
    evaluator.variant_gap = 1.0;
    let connection = Connection::open_in_memory().expect("memory db");
    migrate(&connection).expect("migrate");
    let (cache, options) = labeler_and_cache(&evaluator, &connection);
    let labeler = VariantLabeler {
        evaluator: &evaluator,
        cache: &cache,
        options,
    };
    // Ten tiny gaps and ten large ones: close ≤ 0.005, confident ≥ 5.0.
    let mut samples = std::collections::BTreeMap::new();
    let mut values = vec![0.005_f32; 10];
    values.extend(vec![5.0_f32; 10]);
    samples.insert("self_turn/mid".to_string(), values);
    let cuts = PercentileCuts::build(&PercentileConfig::default(), &samples).expect("build cuts");
    let deps = stage_deps(&cuts, Some(&labeler));
    let reject = super::gate::check(&base, &chain, &deps).expect_err("band change");
    assert_eq!(reject.code, "margin_band_changed", "{reject}");
}

// ---------------------------------------------------------------------------
// Pack integration and the rehearsal acceptance.
// ---------------------------------------------------------------------------

#[test]
fn the_rehearsal_pack_passes_the_p1a_gate_and_reports_shares() {
    let bases = sample_bases();
    let config = VariantConfig {
        variants_per_base: 2,
        min_yield: 0.0,
        ..VariantConfig::default()
    };
    let outcome = run_stage(bases, &config, None);
    let pack = rehearsal_pack(&outcome, bases);
    assert_eq!(
        pack.scenarios.len(),
        bases.len() + outcome.variants.len(),
        "the pack ships every base and gated variant"
    );
    let audit = audit_pack(&pack, &PackAuditContext::new(&rehearsal_games())).expect("audits");
    assert!(
        audit.is_clean(),
        "{:?}",
        audit
            .findings
            .iter()
            .map(|finding| (&finding.code, &finding.detail))
            .collect::<Vec<_>>()
    );
    let report = pack_report(&pack, audit.bytes, &Default::default());
    assert!(report.variant_count >= 2);
    assert!(report.variant_share > 0.0);
    assert!(report.largest_base_share > 0.0);
    assert!(
        report.variant_share < 1.0,
        "the bases are still in the pack"
    );
}

#[test]
fn build_pack_refuses_a_variant_without_a_preserved_label_check() {
    let bases = sample_bases();
    let config = VariantConfig {
        variants_per_base: 2,
        min_yield: 0.0,
        ..VariantConfig::default()
    };
    let outcome = run_stage(bases, &config, None);
    let mut variants = outcome.variants.clone();
    variants[0].scenario.provenance.label_check = Some(LabelCheck {
        kind: LabelCheckKind::Book,
        preserved: false,
        detail: None,
    });
    let error = build_pack(&PackAssembly {
        pack_id: "bad-pack",
        generated_at: STAMP,
        licence: "CC-BY-4.0",
        attribution: "test",
        bases,
        variants: &variants,
        games: &rehearsal_games(),
    })
    .expect_err("a failed check cannot ship");
    assert!(
        error.to_string().contains("failed its label-preservation"),
        "{error}"
    );

    let mut variants = outcome.variants.clone();
    variants[0].scenario.provenance.variant_of = None;
    let error = build_pack(&PackAssembly {
        pack_id: "bad-pack",
        generated_at: STAMP,
        licence: "CC-BY-4.0",
        attribution: "test",
        bases,
        variants: &variants,
        games: &rehearsal_games(),
    })
    .expect_err("a variant needs its base");
    assert!(error.to_string().contains("`variant_of`"), "{error}");
}

#[test]
fn build_pack_refuses_a_base_outside_the_pack() {
    let bases = sample_bases();
    let config = VariantConfig {
        variants_per_base: 2,
        min_yield: 0.0,
        ..VariantConfig::default()
    };
    let outcome = run_stage(bases, &config, None);
    let error = build_pack(&PackAssembly {
        pack_id: "bad-pack",
        generated_at: STAMP,
        licence: "CC-BY-4.0",
        attribution: "test",
        bases: &bases[1..],
        variants: &outcome.variants,
        games: &rehearsal_games(),
    })
    .expect_err("a base must be in the pack");
    assert!(error.to_string().contains("not in the pack"), "{error}");
}

// ---------------------------------------------------------------------------
// DB persistence (§4.6 store variant_of/chain/seed/label_check).
// ---------------------------------------------------------------------------

fn decision_fixture(connection: &Connection) {
    let replay = "a".repeat(64);
    let sql = format!(
        "INSERT INTO replays (
            replay_id, source, licence, attribution, format, rule,
            rule_config_hash, generated_at, model, model_sha256, seed,
            log_path, log_bytes, log_sha256, validation_status,
            ingested_at, corpus_id, family, match_plan_id,
            match_plan_sha256, agents, provenance_json
         ) VALUES ('{replay}', 'ai_selfplay', 'CC-BY-4.0', 'fixture', 'mjai',
            'tenhou-4p-hanchan', 'hash', '2026-11-16T00:00:00Z',
            'mortal-298k', 'b', '0x01', 'replays/a.jsonl.gz', 10, '{replay}',
            'ok', '2026-11-16T00:01:00Z', 'corpus', 'book', 'm1', 'd',
            '[]', '{{}}');
         INSERT INTO decisions (
            decision_id, replay_id, family, kyoku, honba, event_index,
            turn, seat, decision_kind, state_hash, state_json,
            legal_actions, played_action, trigger
         ) VALUES ('decision-1', '{replay}', 'book', 0, 0, 0, 0, 0,
            'self_turn', 'h', '{{}}', '[]', '{{}}', 'book:ch3.1');"
    );
    connection.execute_batch(&sql).expect("fixture rows");
}

#[test]
fn persistence_stores_bases_variants_and_rejections() {
    let connection = Connection::open_in_memory().expect("memory db");
    migrate(&connection).expect("migrate");
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .expect("foreign keys");
    decision_fixture(&connection);

    let mut base = base_for(ScenarioId::RyanmenProtorun);
    base.decision_id = Some("decision-1".to_string());
    let config = VariantConfig {
        variants_per_base: 3,
        min_yield: 0.0,
        ..VariantConfig::default()
    };
    let outcome = run_stage(std::slice::from_ref(&base), &config, None);
    assert!(!outcome.variants.is_empty());
    persist::store_variants(
        &connection,
        "test-pack",
        &[base.clone()],
        &outcome.variants,
        &outcome.rejected,
        STAMP,
    )
    .expect("persists");

    let selected: i64 = connection
        .query_row("SELECT COUNT(*) FROM selected_scenarios", [], |row| {
            row.get(0)
        })
        .expect("count");
    assert_eq!(selected, 1 + outcome.variants.len() as i64);
    let variants: i64 = connection
        .query_row("SELECT COUNT(*) FROM variants", [], |row| row.get(0))
        .expect("count");
    assert_eq!(
        variants,
        (outcome.variants.len() + outcome.rejected.len()) as i64
    );
    let gate_failures = outcome
        .rejected
        .iter()
        .filter(|record| !record.label_preserved)
        .count() as i64;
    let rejected: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM variants WHERE label_preserved = 0 AND rejection_reason IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .expect("count");
    assert_eq!(rejected, gate_failures);
    let stored_chain: String = connection
        .query_row(
            "SELECT transform_chain FROM variants WHERE variant_id = ?1",
            rusqlite::params![outcome.variants[0].id.as_str()],
            |row| row.get(0),
        )
        .expect("chain");
    assert!(stored_chain.contains("transforms"));
}

// ---------------------------------------------------------------------------
// The 100-scenario rehearsal (slow; run with `--ignored` for the evidence).
// ---------------------------------------------------------------------------

#[test]
#[ignore = "slow: builds and audits the 100-base §4.7 rehearsal"]
fn a_hundred_base_rehearsal_meets_the_acceptance_gate() {
    let rehearsal = rehearsal_bases(100).expect("100 bases");
    assert_eq!(rehearsal.bases.len(), 100);
    let config = VariantConfig::default();
    let outcome = run_stage(&rehearsal.bases, &config, None);
    assert!(!outcome.variants.is_empty());
    assert!(
        outcome.report.share.transform_families.len() >= 2,
        "{:?}",
        outcome.report.share.transform_families
    );
    let cap = outcome.report.effective_cap as u64;
    assert!(
        outcome
            .report
            .share
            .largest_base
            .as_ref()
            .is_some_and(|base| base.scenarios <= 1 + cap),
        "{:?}",
        outcome.report.share.largest_base
    );
    assert!(!outcome.report.disabled_pairs.is_empty());
    assert!(!outcome.report.pair_yield.is_empty());
    assert!(outcome.report.cap_limited.is_empty());
    let pack = rehearsal_pack(&outcome, &rehearsal.bases);
    let audit = audit_pack(&pack, &PackAuditContext::new(&rehearsal.games)).expect("audits");
    assert!(audit.is_clean(), "{:?}", audit.failure_codes());
}

#[test]
fn the_variant_record_carries_the_pack_fields() {
    let bases = sample_bases();
    let config = VariantConfig {
        variants_per_base: 1,
        min_yield: 0.0,
        ..VariantConfig::default()
    };
    let outcome = run_stage(bases, &config, None);
    let record: &VariantRecord = outcome.variants.first().expect("a variant");
    assert_eq!(
        record.scenario.provenance.variant_of.as_ref(),
        Some(&record.base)
    );
    assert!(record.scenario.provenance.label_check.is_some());
    assert!(record.scenario.provenance.is_variant());
}

#[test]
fn the_policy_record_round_trips_a_classifier_policy() {
    let policy = crate::classifier::transform_policy(ScenarioId::WindDiscardOrder).expect("policy");
    let record = super::PolicyRecord::from_policy(policy);
    assert!(!record.seat_perm);
    assert!(record.suit_perm);
    let back = record.to_policy();
    assert_eq!(back.seat_perm, policy.seat_perm);
    assert_eq!(back.suit_perm, policy.suit_perm);
    assert!(record.allows(TransformFamily::SuitPerm));
    assert!(!record.allows(TransformFamily::SeatPerm));
}

#[test]
fn a_mortal_base_without_a_classifier_policy_uses_the_configured_default() {
    let source = base_for(ScenarioId::RyanmenProtorun);
    let top = top_action_of(&source);
    let base = mortal_base(&source.scenario.state, &top, 0.2, "self_turn/mid");
    let denied = base.policy(super::PolicyRecord::DENY.to_policy());
    assert!(allowed_families(denied).is_empty());
    let opened = super::PolicyRecord {
        suit_perm: true,
        ..super::PolicyRecord::DENY
    }
    .to_policy();
    assert_eq!(
        allowed_families(base.policy(opened)),
        vec![TransformFamily::SuitPerm]
    );
}

#[test]
fn an_empty_base_list_is_a_config_error() {
    let cuts = empty_cuts();
    let stage = VariantStage {
        config: &VariantConfig::default(),
        deps: stage_deps(&cuts, None),
        pack_id: "p".to_string(),
        generated_at: STAMP.to_string(),
    };
    assert!(stage.run(&[]).is_err());
}

#[test]
fn label_driven_variant_records_survive_a_pack_round_trip() {
    let bases = sample_bases();
    let config = VariantConfig {
        variants_per_base: 1,
        min_yield: 0.0,
        ..VariantConfig::default()
    };
    let outcome = run_stage(bases, &config, None);
    let pack = rehearsal_pack(&outcome, bases);
    let encoded = crate::miner::pack::encode_pack(&pack).expect("encodes");
    let decoded = crate::miner::pack::decode_pack(&encoded.bytes).expect("decodes");
    assert_eq!(decoded.scenarios.len(), pack.scenarios.len());
    for scenario in &decoded.scenarios {
        if scenario.provenance.is_variant() {
            assert!(scenario.provenance.label_check.is_some());
        }
    }
}

#[test]
fn the_empty_report_serialises_its_schema_and_version() {
    let report = super::VariantReport::empty(STAMP, "p");
    let json = serde_json::to_value(&report).expect("serialises");
    assert_eq!(json["schema"], super::VARIANT_SCHEMA);
    assert_eq!(json["version"], super::VARIANT_VERSION);
}

// ---------------------------------------------------------------------------
// The runner: queue/rehearsal I/O, the report file and the published pack.
// ---------------------------------------------------------------------------

fn rehearsal_root(dir: &tempfile::TempDir) -> crate::miner::storage::DataRoot {
    crate::miner::storage::DataRoot::new(dir.path()).expect("data root")
}

#[test]
fn a_rehearsal_run_writes_the_report_and_a_clean_pack() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = rehearsal_root(&dir);
    let options = super::VariantRunOptions {
        rehearsal: Some(4),
        config: VariantConfig {
            variants_per_base: 2,
            min_yield: 0.0,
            ..VariantConfig::default()
        },
        publish: true,
        persist: false,
        ..super::VariantRunOptions::default()
    };
    let outcome = super::run_variants(&root, &options, None).expect("the run succeeds");
    assert!(outcome.written);
    assert!(outcome.paths.report.exists());
    assert!(outcome.paths.variants.exists());
    assert!(outcome.paths.rejected.exists());
    let text = std::fs::read_to_string(&outcome.paths.report).expect("reads");
    let report: super::VariantReport = serde_json::from_str(&text).expect("parses");
    assert_eq!(report.schema, super::VARIANT_SCHEMA);
    assert_eq!(report.shipped, outcome.variants.len() as u64);
    assert!(report.bases >= 4);

    let published = outcome.published.expect("published");
    assert!(published.path.exists());
    assert!(published.audit.is_clean(), "{:?}", published.audit.findings);
    let body = std::fs::read_to_string(outcome.paths.variants).expect("reads");
    for line in body.lines() {
        let scenario: PackScenario = serde_json::from_str(line).expect("a pack scenario");
        assert!(scenario.provenance.is_variant());
        assert!(scenario.provenance.label_check.is_some());
    }
}

#[test]
fn a_dry_run_writes_nothing() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = rehearsal_root(&dir);
    let options = super::VariantRunOptions {
        rehearsal: Some(3),
        config: VariantConfig {
            variants_per_base: 1,
            min_yield: 0.0,
            ..VariantConfig::default()
        },
        dry_run: true,
        persist: false,
        ..super::VariantRunOptions::default()
    };
    let outcome = super::run_variants(&root, &options, None).expect("the run succeeds");
    assert!(!outcome.written);
    assert!(!outcome.paths.dir.exists());
}

#[test]
fn publishing_and_dry_running_together_is_refused() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = rehearsal_root(&dir);
    let options = super::VariantRunOptions {
        rehearsal: Some(2),
        publish: true,
        dry_run: true,
        persist: false,
        ..super::VariantRunOptions::default()
    };
    let error = super::run_variants(&root, &options, None).expect_err("refused");
    assert!(error.to_string().contains("cannot be combined"), "{error}");
}

#[test]
fn a_queue_run_without_a_queue_or_rehearsal_is_refused() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = rehearsal_root(&dir);
    let error = super::run_variants(&root, &super::VariantRunOptions::default(), None)
        .expect_err("no queue");
    assert!(error.to_string().contains("no `select` run"), "{error}");
}

#[test]
fn a_yield_policy_file_round_trips_from_disk() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("yield-policy.json");
    let policy = super::YieldPolicy {
        pairs: vec![PairOverride {
            lesson: "pinfu_head".to_string(),
            transform: TransformFamily::RankMirror,
            enabled: true,
            note: Some("reviewed".to_string()),
        }],
        ..super::YieldPolicy::default()
    };
    std::fs::write(
        &path,
        serde_json::to_string_pretty(&policy).expect("serialises"),
    )
    .expect("writes");
    let read = super::YieldPolicy::read(&path).expect("reads");
    assert_eq!(read, policy);
    let mut bad = policy.clone();
    bad.version = 99;
    std::fs::write(&path, serde_json::to_string(&bad).expect("serialises")).expect("writes");
    assert!(super::YieldPolicy::read(&path).is_err());
}

#[test]
fn a_queue_run_reads_selected_items_stages_variants_and_persists_them() {
    use crate::miner::select::review::{REVIEW_SCHEMA, REVIEW_VERSION, ReviewItem};
    use crate::miner::select::score::Signals;
    use crate::miner::trigger::families::Family;
    use crate::report::{BuildReportRequest, ReportReason, ReportedAction, ScenarioReport};

    let dir = tempfile::tempdir().expect("tempdir");
    let root = rehearsal_root(&dir);
    let connection = crate::miner::storage::open_miner_db(&root).expect("db");
    decision_fixture(&connection);

    let base = base_for(ScenarioId::RyanmenProtorun);
    let table = base.scenario.state.clone();
    let review: ScenarioReport = crate::report::build_report(BuildReportRequest {
        table: table.clone(),
        answer: ReportedAction::new(
            table.correct_action.action_type(),
            table.correct_action.tile().unwrap_or_default(),
        ),
        reason: ReportReason::Other,
        note: None,
        created_at: STAMP.to_string(),
        report_id: "test-report".to_string(),
        commit: None,
        build_time: None,
        ai: None,
    })
    .expect("the review report builds");
    let item = ReviewItem {
        schema: REVIEW_SCHEMA.to_string(),
        version: REVIEW_VERSION,
        queue_id: "s2-test-001".to_string(),
        pack_id: "s2-test".to_string(),
        decision_id: "decision-1".to_string(),
        replay_id: "a".repeat(64),
        replay_family: "book".to_string(),
        family: Some(Family::Book),
        families: vec![Family::Book],
        rank: Some(1),
        score: 0.9,
        signals: Signals::zero(),
        special: Vec::new(),
        held_out: false,
        selection_reason: "test".to_string(),
        lesson: Some("ryanmen_protorun".to_string()),
        book_section: Some("ch3.2".to_string()),
        label_kind: "book".to_string(),
        label_stability: Some("stable".to_string()),
        label_model: "mortal-298k".to_string(),
        decision_kind: "self_turn".to_string(),
        event_index: 0,
        turn: 1,
        turn_bucket: "early".to_string(),
        exact_hash: exact_state_hash(&table),
        visible_fingerprint: "b".repeat(64),
        review,
    };
    let queue_path = root
        .reviews_dir()
        .join("s2-test")
        .join("review-queue.jsonl");
    std::fs::create_dir_all(queue_path.parent().expect("parent")).expect("dir");
    std::fs::write(
        &queue_path,
        format!("{}\n", serde_json::to_string(&item).expect("serialises")),
    )
    .expect("queue");

    let options = super::VariantRunOptions {
        queue: Some(queue_path),
        pack_id: Some("s2-test".to_string()),
        config: VariantConfig {
            variants_per_base: 1,
            min_yield: 0.0,
            ..VariantConfig::default()
        },
        persist: true,
        ..super::VariantRunOptions::default()
    };
    let outcome = super::run_variants(&root, &options, None).expect("the queue run succeeds");
    assert_eq!(outcome.bases.len(), 1);
    assert!(outcome.written);
    assert_eq!(outcome.report.bases, 1);
    assert!(outcome.report.bases == 1 && outcome.report.share.variants >= 1);

    let bases: i64 = connection
        .query_row("SELECT COUNT(*) FROM selected_scenarios", [], |row| {
            row.get(0)
        })
        .expect("count");
    assert_eq!(bases, 1 + outcome.variants.len() as i64);
    let chain_seed: String = connection
        .query_row(
            "SELECT transform_seed FROM variants WHERE label_preserved = 1 LIMIT 1",
            [],
            |row| row.get(0),
        )
        .expect("a persisted shipped variant");
    assert!(!chain_seed.trim().is_empty());
}

#[test]
fn a_rejected_disposition_removes_the_base_from_the_stage() {
    use crate::miner::select::review::{REVIEW_SCHEMA, REVIEW_VERSION, ReviewItem};
    use crate::miner::select::score::Signals;
    use crate::miner::trigger::families::Family;
    use crate::report::{BuildReportRequest, ReportReason, ReportedAction};

    let dir = tempfile::tempdir().expect("tempdir");
    let root = rehearsal_root(&dir);
    let connection = crate::miner::storage::open_miner_db(&root).expect("db");
    decision_fixture(&connection);

    let base = base_for(ScenarioId::RyanmenProtorun);
    let table = base.scenario.state.clone();
    let review = crate::report::build_report(BuildReportRequest {
        table: table.clone(),
        answer: ReportedAction::new(
            table.correct_action.action_type(),
            table.correct_action.tile().unwrap_or_default(),
        ),
        reason: ReportReason::Other,
        note: None,
        created_at: STAMP.to_string(),
        report_id: "test-report-2".to_string(),
        commit: None,
        build_time: None,
        ai: None,
    })
    .expect("the review report builds");
    let item = ReviewItem {
        schema: REVIEW_SCHEMA.to_string(),
        version: REVIEW_VERSION,
        queue_id: "s2-test-002".to_string(),
        pack_id: "s2-test".to_string(),
        decision_id: "decision-1".to_string(),
        replay_id: "a".repeat(64),
        replay_family: "book".to_string(),
        family: Some(Family::Book),
        families: vec![Family::Book],
        rank: Some(1),
        score: 0.9,
        signals: Signals::zero(),
        special: Vec::new(),
        held_out: false,
        selection_reason: "test".to_string(),
        lesson: Some("ryanmen_protorun".to_string()),
        book_section: Some("ch3.2".to_string()),
        label_kind: "book".to_string(),
        label_stability: Some("stable".to_string()),
        label_model: "mortal-298k".to_string(),
        decision_kind: "self_turn".to_string(),
        event_index: 0,
        turn: 1,
        turn_bucket: "early".to_string(),
        exact_hash: exact_state_hash(&table),
        visible_fingerprint: "c".repeat(64),
        review,
    };
    let queue_path = root
        .reviews_dir()
        .join("s2-test")
        .join("review-queue.jsonl");
    std::fs::create_dir_all(queue_path.parent().expect("parent")).expect("dir");
    std::fs::write(
        &queue_path,
        format!("{}\n", serde_json::to_string(&item).expect("serialises")),
    )
    .expect("queue");
    std::fs::write(
        queue_path
            .parent()
            .expect("parent")
            .join("dispositions.jsonl"),
        format!(
            "{}\n",
            serde_json::to_string(&crate::miner::select::ReviewDisposition::new(
                &item,
                crate::miner::select::DispositionVerdict::Rejected,
                Some("does not teach".to_string()),
            ))
            .expect("serialises")
        ),
    )
    .expect("dispositions");

    let error = super::run_variants(
        &root,
        &super::VariantRunOptions {
            queue: Some(queue_path),
            persist: false,
            ..super::VariantRunOptions::default()
        },
        None,
    )
    .expect_err("no base survives the rejection");
    assert!(error.to_string().contains("no base scenario"), "{error}");
}
