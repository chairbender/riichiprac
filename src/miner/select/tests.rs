//! S2 fixtures and acceptance tests.
//!
//! The fixture set pins one positive and one near-miss negative per gate, the
//! quota/cap/dedupe behaviour, the deterministic held-out split, and the full
//! shard run that writes a queue, a held-out set, a report and the `LATEST`
//! pointer. The run test uses the R1 fixture replay and a real (in-memory)
//! SQLite database, so the walker → label cache → gate → selection → report
//! path is exercised end to end without weights.

use std::collections::{BTreeMap, BTreeSet};

use super::*;
use crate::decision::ActionKind;
use crate::generator::{evaluate_hand, format_hand_compact};
use crate::miner::funnel::FunnelStage;
use crate::miner::label::thresholds::PercentileCuts;
use crate::miner::label::thresholds::TurnBucket;
use crate::miner::label::{
    BookAgreement, BookLabel, CLASSIFIER_VERSION, LabelKind, ModelLabel, Q_UNITS, Q_UNITS_NOTE,
    RankedAction, VALUE_UNITS,
};
use crate::miner::licence::LicenseInfo;
use crate::miner::provenance::{
    AgentKind, AgentSpec, CorpusId, GameProvenance, GeneratorInfo, LogRef, MatchPlanId, ReplayId,
    RuleProfile, ValidationStatus, ValidationSummary, sha256_hex,
};
use crate::miner::source::SourceKind;
use crate::miner::storage::{DataRoot, migrate, open_miner_db};
use crate::miner::trigger::{TriggerReport, families::Family};
use crate::miner::{CORPUS_GAME_SCHEMA, JSON_SCHEMA_VERSION};
use crate::replay::walk::{DecisionKind, DecisionSnapshot};
use crate::state::{CorrectAction, DecisionContext, DiscardTile, PlayerState, TargetAction, Wind};

/// Fixtures shared by the gate, score and review unit tests.
pub(crate) mod fixture {
    use super::*;

    const ACTOR_HAND: [&str; 13] = [
        "1m", "2m", "3m", "4p", "5p", "6p", "7s", "8s", "9s", "1z", "1z", "5z", "9p",
    ];
    const DRAW: &str = "5z";

    fn codes(tiles: &[&str]) -> Vec<String> {
        tiles.iter().map(|tile| (*tile).to_string()).collect()
    }

    fn river_tile(seat: usize, index: usize) -> String {
        let honors = ["1z", "2z", "3z", "4z", "5z", "6z", "7z"];
        honors[(seat * 3 + index) % honors.len()].to_string()
    }

    fn player(seat: usize, wind: Wind, hand: &[&str], turn: usize) -> PlayerState {
        PlayerState {
            seat,
            name: format!("seat{seat}"),
            is_human: seat == 0,
            wind,
            score: 25_000,
            hand: codes(hand),
            draw: None,
            red_fives: Vec::new(),
            discards: (0..turn)
                .map(|index| DiscardTile::new(river_tile(seat, index)))
                .collect(),
            melds: Vec::new(),
            is_riichi: false,
            riichi_discard_index: None,
        }
    }

    /// A legal 14-tile self-turn state (13 standing tiles plus the draw).
    pub(crate) fn state() -> GameState {
        let mut human = player(0, Wind::East, &ACTOR_HAND, 6);
        human.draw = Some(DRAW.to_string());
        let mut concealed: Vec<agari::tile::Tile> = ACTOR_HAND
            .iter()
            .chain(std::iter::once(&DRAW))
            .filter_map(|code| agari::tile::Tile::try_from(*code).ok())
            .collect();
        concealed.sort();
        let metrics = evaluate_hand(&concealed);
        GameState {
            category: "fixture".to_string(),
            target_action: TargetAction::Best,
            correct_action: CorrectAction::best("Pass", None, Vec::new(), "Pass".to_string()),
            equivalent_tiles: Vec::new(),
            decision: DecisionContext::SelfTurn,
            scenario_note: None,
            call_offer: None,
            ai_decision: None,
            riichi_triggers: Vec::new(),
            dama_reasons: Vec::new(),
            shouminkan_triggers: Vec::new(),
            book_rationale: None,
            can_riichi: false,
            hand_string: format_hand_compact(&concealed),
            tiles: concealed.iter().map(ToString::to_string).collect(),
            shanten: metrics.shanten,
            is_agari: metrics.is_agari,
            decompositions_count: metrics.decompositions_count,
            ukeire_tiles: metrics.ukeire_tiles,
            ukeire_total: metrics.ukeire_total,
            round_wind: Wind::East,
            hand_number: 1,
            honba: 0,
            riichi_sticks: 0,
            dora_indicators: vec!["1p".to_string()],
            ura_dora_indicators: Vec::new(),
            tiles_remaining: 50,
            current_turn: 0,
            players: vec![
                human,
                player(
                    1,
                    Wind::South,
                    &[
                        "1m", "1m", "2m", "3m", "4p", "5p", "6p", "7s", "8s", "9s", "2z", "3z",
                        "4z",
                    ],
                    6,
                ),
                player(
                    2,
                    Wind::West,
                    &[
                        "2m", "2m", "3m", "4m", "5p", "6p", "7p", "1s", "2s", "3s", "5z", "6z",
                        "7z",
                    ],
                    6,
                ),
                player(
                    3,
                    Wind::North,
                    &[
                        "3m", "3m", "4m", "5m", "6p", "7p", "8p", "2s", "3s", "4s", "1z", "5z",
                        "6z",
                    ],
                    6,
                ),
            ],
        }
    }

    /// A self-turn decision whose recorded action is the model's top action.
    pub(crate) fn snapshot() -> DecisionSnapshot {
        snapshot_with(state())
    }

    pub(crate) fn snapshot_with(mut state: GameState) -> DecisionSnapshot {
        let legal = crate::ai::actions::legal_actions(&state);
        let played = legal
            .iter()
            .find(|action| action.kind == ActionKind::Discard)
            .cloned()
            .unwrap_or_else(|| {
                crate::ai::actions::legal_actions(&state)
                    .into_iter()
                    .next()
                    .expect("the fixture state offers an action")
            });
        state.decision = DecisionContext::SelfTurn;
        DecisionSnapshot {
            decision_id: "fixture-decision".to_string(),
            replay_id: ReplayId::from_bytes(b"s2-fixture"),
            kyoku_index: 0,
            kyoku: 1,
            event_index: 0,
            line: 1,
            seat: 0,
            kind: DecisionKind::SelfTurn,
            state,
            legal_actions: legal,
            played: played.clone(),
            played_is_legal: true,
            waits: Vec::new(),
            furiten: false,
            ura_dora_indicators: Vec::new(),
            wall_draws: 0,
            warnings: Vec::new(),
        }
    }

    fn ranked(action: &str, probability: f32, q: f32) -> RankedAction {
        RankedAction {
            action: action.to_string(),
            label: action.replace('_', " "),
            kind: ActionKind::Discard,
            tile: action.strip_prefix("Discard_").map(str::to_string),
            probability,
            q_value: Some(q),
        }
    }

    /// A Mortal-only label whose top action is a legal discard.
    pub(crate) fn mortal_label(
        snapshot: &DecisionSnapshot,
        top_probability: f32,
        margin: f32,
    ) -> ModelLabel {
        let discards: Vec<String> = snapshot
            .legal_actions
            .iter()
            .filter(|action| action.kind == ActionKind::Discard)
            .map(|action| action.action.clone())
            .collect();
        assert!(
            discards.len() >= 2,
            "the fixture needs two legal discards: {:?}",
            discards
        );
        let top = discards[0].clone();
        let second = discards[1].clone();
        let q_gap = margin;
        ModelLabel {
            schema: crate::miner::MODEL_LABEL_SCHEMA.to_string(),
            version: 1,
            classifier_version: CLASSIFIER_VERSION.to_string(),
            model: "fixture.safetensors".to_string(),
            model_sha256: "a".repeat(64),
            gamma: None,
            pts: None,
            q_units: Q_UNITS.to_string(),
            value_units: VALUE_UNITS.to_string(),
            expected_value: 0.0,
            top_action: top.clone(),
            top_probability,
            probability_margin: margin,
            q_gap_top2: Some(q_gap),
            q_gap_safe: None,
            safe_action: None,
            riichi_discard: None,
            ranking: vec![
                ranked(&top, top_probability, 1.0),
                ranked(&second, (1.0 - top_probability).max(0.0), 1.0 - q_gap),
            ],
            q_values: BTreeMap::from([(top, 1.0), (second, 1.0 - q_gap)]),
            book: None,
            book_conflict: None,
            label_kind: Some(LabelKind::Mortal),
            stability: None,
            consensus: None,
            calibration_version: None,
            expected_point_diffs: None,
            generator: None,
            note: Q_UNITS_NOTE.to_string(),
        }
    }

    /// A book label whose answer is `discard` in the dama family.
    pub(crate) fn book_label(discard: &str) -> ModelLabel {
        let mut label = mortal_label(&snapshot(), 0.6, 0.2);
        label.book = Some(BookLabel {
            lesson: "dama_bad_wait".to_string(),
            situation: Some("bad wait, extra value".to_string()),
            target_action: TargetAction::Dama,
            correct_action: CorrectAction::dama(discard),
            accepted: vec![discard.to_string()],
            resolution: "single".to_string(),
            tiebreak_rejected: Vec::new(),
            agreement: BookAgreement {
                outcome: "agrees".to_string(),
                discrepancy_kind: None,
                book_action: format!("Discard_{discard}"),
                book_probability: 0.6,
                model_action: format!("Discard_{discard}"),
                model_probability: 0.6,
            },
        });
        label.label_kind = Some(LabelKind::Book);
        label.top_action = format!("Discard_{discard}");
        label
    }

    /// A compact candidate for the pure selection tests.
    pub(crate) fn candidate(id: &str, family: Family, section: Option<&str>) -> Candidate {
        candidate_with(
            id,
            family,
            section,
            DecisionKind::SelfTurn,
            TurnBucket::Mid,
            0.5,
            &sha256_hex(format!("exact-{id}").as_bytes()),
            &sha256_hex(format!("visible-{id}").as_bytes()),
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn candidate_with(
        id: &str,
        family: Family,
        section: Option<&str>,
        kind: DecisionKind,
        turn_bucket: TurnBucket,
        strength: f32,
        exact_hash: &str,
        visible_fingerprint: &str,
    ) -> Candidate {
        Candidate {
            decision_id: id.to_string(),
            replay_id: "b".repeat(64),
            replay_family: "mortal_mirror".to_string(),
            kyoku_index: 0,
            event_index: 0,
            kind,
            turn: 6,
            turn_bucket,
            decision_family: format!("{}/{}", kind.as_str(), turn_bucket.as_str()),
            answer_source: AnswerSource::Mortal,
            answer: CorrectAction::best(
                "Discard_1m",
                Some("1m".to_string()),
                Vec::new(),
                "Discard 1m".to_string(),
            ),
            accepted: vec!["1m".to_string()],
            lesson: None,
            book_section: section.map(str::to_string),
            target_action: Some(TargetAction::Best),
            label: LabelFacts {
                kind: "mortal".to_string(),
                stability: None,
                model: "fixture.safetensors".to_string(),
                model_sha256: "a".repeat(64),
                top_action: "Discard_1m".to_string(),
                top_probability: 0.9,
                probability_margin: 0.8,
                q_gap_top2: Some(0.1),
                q_gap_safe: None,
                played_gap: None,
                book_situation: section.map(|_| "answer-free situation".to_string()),
                book_resolution: None,
                riichi_discard: None,
            },
            families: BTreeSet::from([family]),
            triggers: TriggerReport::new(),
            exact_hash: exact_hash.to_string(),
            visible_fingerprint: visible_fingerprint.to_string(),
            signals: Signals {
                book_match: strength,
                label_confidence: strength,
                counterfactual_tension: 0.0,
                stakes: 0.0,
                discrimination: 0.0,
                novelty: 0.5,
                realism: 1.0,
            },
            score: strength,
        }
    }

    /// One review item built through the app's real report builder.
    pub(crate) fn review_item_fixture() -> ReviewItem {
        let snapshot = snapshot();
        let label = mortal_label(&snapshot, 0.9, 0.8);
        let plan = answer_plan_for_test(&snapshot, &label);
        let table = stamped_state(
            &snapshot,
            plan.0,
            &plan.1,
            &plan.2,
            None,
            Some(TargetAction::Best),
        );
        let action_name = match &plan.1 {
            CorrectAction::Best { action, .. } => action.clone(),
            other => format!("{other:?}"),
        };
        let report = crate::report::build_report(crate::report::BuildReportRequest {
            table,
            answer: crate::report::ReportedAction::new(
                crate::state::CorrectActionType::Best,
                plan.1.tile().unwrap_or_default().to_string(),
            )
            .with_action_name(action_name),
            reason: crate::report::ReportReason::Other,
            note: Some("fixture review".to_string()),
            created_at: "2026-11-17T08:00:00.000Z".to_string(),
            report_id: "11111111-2222-3333-4444-555555555555".to_string(),
            commit: None,
            build_time: None,
            ai: None,
        })
        .expect("fixture report builds");
        let candidate = candidate("fixture-review", Family::MortalBest, None);
        ReviewItem::new(
            "s2-fixture-001".to_string(),
            "s2-fixture".to_string(),
            &candidate,
            Some(Family::MortalBest),
            Some(1),
            false,
            "family=mortal_best;section=none;kind=self_turn;turn=mid;rank=1".to_string(),
            report,
        )
    }

    /// The answer plan for a label, as the runner computes it.
    fn answer_plan_for_test(
        snapshot: &DecisionSnapshot,
        label: &ModelLabel,
    ) -> (AnswerSource, CorrectAction, Vec<String>) {
        match label.kind() {
            LabelKind::Mortal => {
                let info = crate::ai::finalize::action_info(&snapshot.state, &label.top_action)
                    .expect("top action is legal");
                let answer = crate::ai::finalize::correct_action_from_info(&info, None);
                let accepted = answer.tile().map(str::to_string).into_iter().collect();
                (AnswerSource::Mortal, answer, accepted)
            }
            _ => {
                let book = label.book.as_ref().expect("book label");
                (
                    AnswerSource::Book,
                    book.correct_action.clone(),
                    book.accepted.clone(),
                )
            }
        }
    }

    /// A gate input with a passing fixture, so a test can mutate one field.
    pub(crate) struct GateFixture {
        pub snapshot: DecisionSnapshot,
        pub label: ModelLabel,
        pub answer: CorrectAction,
        pub accepted: Vec<String>,
        pub facts: ReplayFacts,
        pub texts: Vec<String>,
        pub config: SelectionConfig,
        pub cuts: PercentileCuts,
    }

    impl GateFixture {
        pub(crate) fn passing() -> Self {
            let snapshot = snapshot();
            let (label, answer, accepted) = {
                let label = mortal_label(&snapshot, 0.9, 0.8);
                let info = crate::ai::finalize::action_info(&snapshot.state, &label.top_action)
                    .expect("top action");
                let answer = crate::ai::finalize::correct_action_from_info(&info, None);
                let accepted = answer.tile().map(str::to_string).into_iter().collect();
                (label, answer, accepted)
            };
            Self {
                snapshot,
                label,
                answer,
                accepted,
                facts: ReplayFacts::fixture_ok(),
                texts: Vec::new(),
                config: SelectionConfig {
                    pack_id: "gate-test".to_string(),
                    ..SelectionConfig::default()
                },
                cuts: PercentileCuts {
                    families: BTreeMap::new(),
                },
            }
        }

        pub(crate) fn run(&self) -> Option<GateFailure> {
            evaluate(&GateInput {
                snapshot: &self.snapshot,
                label: Some(&self.label),
                answer: Some(&self.answer),
                accepted: &self.accepted,
                validated_reachable: true,
                facts: &self.facts,
                pre_answer_texts: &self.texts,
                config: &self.config,
                confidence_cuts: &self.cuts,
            })
        }
    }
}

// --- Gate tests ----------------------------------------------------------

#[test]
fn a_valid_mortal_candidate_passes_every_gate() {
    let fixture = fixture::GateFixture::passing();
    assert_eq!(fixture.run(), None);
}

#[test]
fn a_hand_built_invalid_state_fails_the_reachability_gate() {
    let mut fixture = fixture::GateFixture::passing();
    fixture.snapshot.state.players[0].hand.pop();
    let failure = evaluate(&GateInput {
        snapshot: &fixture.snapshot,
        label: Some(&fixture.label),
        answer: Some(&fixture.answer),
        accepted: &fixture.accepted,
        validated_reachable: false,
        facts: &fixture.facts,
        pre_answer_texts: &[],
        config: &fixture.config,
        confidence_cuts: &fixture.cuts,
    })
    .expect("a hand-built invalid state is rejected");
    assert_eq!(failure.gate, GateKind::Reachable);
    assert_eq!(failure.code, "unreachable");
}

#[test]
fn a_label_less_decision_is_rejected() {
    let mut fixture = fixture::GateFixture::passing();
    let failure = evaluate(&GateInput {
        snapshot: &fixture.snapshot,
        label: None,
        answer: None,
        accepted: &[],
        validated_reachable: true,
        facts: &fixture.facts,
        pre_answer_texts: &[],
        config: &fixture.config,
        confidence_cuts: &fixture.cuts,
    })
    .expect("a label-less candidate is not shippable");
    assert_eq!(failure.gate, GateKind::AnswerDefined);
    assert_eq!(failure.code, "no_label");
    fixture.texts.clear();
}

#[test]
fn an_unresolved_label_is_rejected() {
    let mut fixture = fixture::GateFixture::passing();
    fixture.label.label_kind = Some(LabelKind::Unlabelled);
    fixture.label.book = None;
    let failure = fixture.run().expect("unresolved label is rejected");
    assert_eq!(failure.gate, GateKind::AnswerDefined);
    assert_eq!(failure.code, "unresolved_label");
}

#[test]
fn an_illegal_answer_is_rejected() {
    let mut fixture = fixture::GateFixture::passing();
    fixture.answer = CorrectAction::dama("9z");
    fixture.accepted = vec!["9z".to_string()];
    let failure = fixture.run().expect("an illegal discard is rejected");
    assert_eq!(failure.gate, GateKind::AnswerLegal);
    assert_eq!(failure.code, "answer_not_in_hand");
}

#[test]
fn the_visible_info_gate_redacts_hidden_hands() {
    let fixture = fixture::GateFixture::passing();
    let state = &fixture.snapshot.state;
    let redacted = {
        let mut redacted = state.clone();
        for player in redacted.players.iter_mut().skip(1) {
            player.hand.clear();
            player.draw = None;
        }
        redacted
    };
    assert_eq!(
        crate::miner::label::state_hash(&redacted),
        crate::miner::label::state_hash(state),
        "the model-visible hash must not depend on opponent concealed tiles"
    );
    assert_eq!(
        crate::ai::actions::legal_actions(&redacted)
            .iter()
            .map(|action| action.action.clone())
            .collect::<BTreeSet<_>>(),
        crate::ai::actions::legal_actions(state)
            .iter()
            .map(|action| action.action.clone())
            .collect::<BTreeSet<_>>()
    );
    // And the gate accepts an answer that survives the redaction.
    assert_eq!(fixture.run(), None);
}

#[test]
fn an_unconfident_mortal_label_is_rejected() {
    let mut fixture = fixture::GateFixture::passing();
    fixture.label.top_probability = 0.2;
    fixture.label.probability_margin = 0.0;
    let failure = fixture.run().expect("a coin flip is not a best answer");
    assert_eq!(failure.gate, GateKind::LabelConfidence);
    assert_eq!(failure.code, "label_unconfident");
}

#[test]
fn a_book_answer_passes_the_confidence_gate() {
    let mut fixture = fixture::GateFixture::passing();
    fixture.label = fixture::book_label("1z");
    fixture.answer = CorrectAction::dama("1z");
    fixture.accepted = vec!["1z".to_string()];
    assert_eq!(fixture.run(), None);
}

#[test]
fn every_provenance_leg_fails_closed() {
    let mut fixture = fixture::GateFixture::passing();
    fixture.facts.source_ok = false;
    assert_eq!(
        fixture.run().expect("bad source").code,
        "source_not_selfplay"
    );

    let mut fixture = fixture::GateFixture::passing();
    fixture.facts.licence_ok = false;
    assert_eq!(
        fixture.run().expect("bad licence").code,
        "licence_not_allowed"
    );

    let mut fixture = fixture::GateFixture::passing();
    fixture.facts.provenance_ok = false;
    fixture.facts.provenance_detail = Some("log hash mismatch".to_string());
    let failure = fixture.run().expect("bad provenance");
    assert_eq!(failure.code, "provenance_incomplete");
    assert!(failure.detail.contains("log hash mismatch"));

    let mut fixture = fixture::GateFixture::passing();
    fixture.facts.validation_ok = false;
    assert_eq!(
        fixture.run().expect("bad validation").code,
        "validation_not_publishable"
    );
}

#[test]
fn a_pre_answer_text_that_names_the_answer_is_rejected() {
    let mut fixture = fixture::GateFixture::passing();
    let tile = fixture.answer.tile().expect("a discard answer").to_string();
    fixture.texts = vec![format!("the safe tile is {tile}")];
    let failure = fixture.run().expect("a spoiler is rejected");
    assert_eq!(failure.gate, GateKind::Spoiler);
    assert_eq!(failure.code, "answer_in_text");

    // The same text without a tile token is not a spoiler.
    let mut fixture = fixture::GateFixture::passing();
    fixture.texts = vec!["discard the safest tile".to_string()];
    assert_eq!(fixture.run(), None);
}

// --- Selection plan tests -------------------------------------------------

fn config(families: BTreeMap<Family, f32>, pack_size: usize) -> SelectionConfig {
    SelectionConfig {
        pack_id: "plan-test".to_string(),
        pack_size,
        held_out_share: 0.0,
        quotas: QuotaConfig {
            families,
            max_section_share: 1.0,
            max_decision_kind_share: 1.0,
            max_turn_bucket_share: 1.0,
            ..QuotaConfig::default()
        },
        ..SelectionConfig::default()
    }
}

#[test]
fn family_quotas_are_enforced_and_balanced() {
    let mut candidates = Vec::new();
    for index in 0..10 {
        candidates.push(fixture::candidate(
            &format!("book-{index}"),
            Family::Book,
            Some("ch8.4"),
        ));
        candidates.push(fixture::candidate(
            &format!("mortal-{index}"),
            Family::MortalBest,
            None,
        ));
    }
    let plan = plan_selection(
        candidates,
        &config(
            BTreeMap::from([(Family::Book, 0.5), (Family::MortalBest, 0.5)]),
            4,
        ),
    );
    assert_eq!(plan.selected.len(), 4);
    let book = plan
        .families
        .iter()
        .find(|row| row.family == Family::Book)
        .expect("book row");
    let mortal = plan
        .families
        .iter()
        .find(|row| row.family == Family::MortalBest)
        .expect("mortal row");
    assert_eq!(book.selected, 2);
    assert_eq!(mortal.selected, 2);
    assert!(book.shortfall.is_none());
    assert!(mortal.shortfall.is_none());
}

#[test]
fn a_family_with_no_candidates_reports_a_shortfall_without_substituting() {
    let candidates = vec![
        fixture::candidate("a", Family::Book, Some("ch8.4")),
        fixture::candidate("b", Family::Book, Some("ch8.4")),
    ];
    let plan = plan_selection(
        candidates,
        &config(
            BTreeMap::from([(Family::Book, 0.5), (Family::MortalBest, 0.5)]),
            4,
        ),
    );
    assert_eq!(plan.selected.len(), 2, "only book candidates exist");
    let mortal = plan
        .families
        .iter()
        .find(|row| row.family == Family::MortalBest)
        .expect("mortal row");
    assert_eq!(mortal.selected, 0);
    assert_eq!(mortal.shortfall.as_deref(), Some("no_candidates"));
}

#[test]
fn exact_and_near_duplicates_are_skipped() {
    let mut candidates = Vec::new();
    for index in 0..4 {
        candidates.push(fixture::candidate(
            &format!("c{index}"),
            Family::Book,
            Some("ch8.4"),
        ));
    }
    // Two exact duplicates of c0, and one near duplicate (same visible table).
    candidates.push(fixture::candidate_with(
        "exact-dup",
        Family::Book,
        Some("ch8.4"),
        DecisionKind::SelfTurn,
        TurnBucket::Mid,
        0.5,
        &candidates[0].exact_hash,
        &candidates[0].visible_fingerprint,
    ));
    candidates.push(fixture::candidate_with(
        "near-dup",
        Family::Book,
        Some("ch8.4"),
        DecisionKind::SelfTurn,
        TurnBucket::Mid,
        0.5,
        &sha256_hex(b"a different hidden hand"),
        &candidates[0].visible_fingerprint,
    ));
    let plan = plan_selection(
        candidates,
        &config(BTreeMap::from([(Family::Book, 1.0)]), 10),
    );
    assert_eq!(plan.selected.len(), 4, "duplicates must not enter the pack");
    assert_eq!(plan.dedupe.exact, 1);
    assert_eq!(plan.dedupe.near, 1);
    let decisions: BTreeSet<&str> = plan
        .selected
        .iter()
        .map(|scenario| scenario.candidate.decision_id.as_str())
        .collect();
    assert_eq!(decisions.len(), plan.selected.len());
}

#[test]
fn a_section_cap_stops_a_single_section_filling_the_pack() {
    let candidates: Vec<Candidate> = (0..6)
        .map(|index| {
            fixture::candidate_with(
                &format!("c{index}"),
                Family::Book,
                Some("ch8.4"),
                DecisionKind::SelfTurn,
                TurnBucket::Mid,
                1.0 - index as f32 / 100.0,
                &sha256_hex(format!("exact-{index}").as_bytes()),
                &sha256_hex(format!("visible-{index}").as_bytes()),
            )
        })
        .collect();
    let mut config = config(BTreeMap::from([(Family::Book, 1.0)]), 6);
    config.quotas.max_per_section = Some(2);
    config.quotas.max_decision_kind_share = 1.0;
    config.quotas.max_turn_bucket_share = 1.0;
    let plan = plan_selection(candidates, &config);
    // The quota round stops at the cap; the relaxed fill then avoids a short
    // pack by taking the remaining candidates and records exactly how many went
    // over the cap.
    assert_eq!(plan.selected.len(), 6);
    assert!(plan.cap_blocked > 0);
    assert_eq!(plan.cap_relaxed, 4);
    let row = plan
        .sections
        .iter()
        .find(|row| row.bucket == "ch8.4")
        .expect("section row");
    assert_eq!(row.selected, 6);
    assert_eq!(row.cap, Some(2));
    assert_eq!(row.relaxed, 4);
    assert!(row.cap_reached);
    let book = plan
        .families
        .iter()
        .find(|row| row.family == Family::Book)
        .expect("book row");
    assert!(book.shortfall.is_none());
}

#[test]
fn the_held_out_split_is_deterministic_and_sized() {
    let candidates: Vec<Candidate> = (0..20)
        .map(|index| fixture::candidate(&format!("c{index}"), Family::Book, Some("ch8.4")))
        .collect();
    let mut config = config(BTreeMap::from([(Family::Book, 1.0)]), 10);
    config.held_out_share = 0.2;
    let first = plan_selection(candidates.clone(), &config);
    let second = plan_selection(candidates, &config);
    assert_eq!(first.held_out.len(), 2);
    assert_eq!(
        first
            .held_out
            .iter()
            .map(|candidate| candidate.decision_id.clone())
            .collect::<Vec<_>>(),
        second
            .held_out
            .iter()
            .map(|candidate| candidate.decision_id.clone())
            .collect::<Vec<_>>(),
        "the split must not depend on input order"
    );
    let selected: BTreeSet<&str> = first
        .selected
        .iter()
        .map(|scenario| scenario.candidate.decision_id.as_str())
        .collect();
    assert!(
        first
            .held_out
            .iter()
            .all(|candidate| !selected.contains(candidate.decision_id.as_str())),
        "a held-out item must not also be selected"
    );
}

#[test]
fn novelty_prefers_the_rare_bucket() {
    let mut candidates = Vec::new();
    for index in 0..9 {
        candidates.push(fixture::candidate(
            &format!("common-{index}"),
            Family::Book,
            Some("ch8.4"),
        ));
    }
    candidates.push(fixture::candidate("rare", Family::Book, Some("ch3.1")));
    assign_novelty_and_scores(&mut candidates, &ScoreWeights::default());
    let rare = candidates
        .iter()
        .find(|candidate| candidate.decision_id == "rare")
        .expect("rare candidate");
    let common = candidates
        .iter()
        .find(|candidate| candidate.decision_id == "common-0")
        .expect("common candidate");
    assert!(rare.signals.novelty > common.signals.novelty);
    assert!(rare.score > common.score);
}

#[test]
fn a_partial_mix_fills_the_open_slots() {
    let candidates: Vec<Candidate> = (0..10)
        .map(|index| fixture::candidate(&format!("c{index}"), Family::Book, Some("ch8.4")))
        .collect();
    let plan = plan_selection(
        candidates,
        &config(BTreeMap::from([(Family::Book, 0.5)]), 6),
    );
    assert_eq!(plan.selected.len(), 6);
    assert_eq!(plan.open_slots_used, 3);
}

#[test]
fn the_config_rejects_a_path_unsafe_pack_id() {
    for pack in ["", "../x", "a/b", "a b", "."] {
        let config = SelectionConfig {
            pack_id: pack.to_string(),
            ..SelectionConfig::default()
        };
        assert!(config.validate().is_err(), "`{pack}` must be rejected");
    }
    let config = SelectionConfig {
        pack_id: "s2-smoke".to_string(),
        ..SelectionConfig::default()
    };
    config.validate().expect("a normal pack id");
    assert_eq!(config.held_out_target(), 10);
}

#[test]
fn the_queue_size_may_exceed_a_pack_body() {
    let config = SelectionConfig {
        pack_id: "s2-smoke".to_string(),
        pack_size: 2_500,
        ..SelectionConfig::default()
    };
    config
        .validate()
        .expect("a 2.5k review queue is not a pack body");
    let config = SelectionConfig {
        pack_id: "s2-smoke".to_string(),
        pack_size: 5_001,
        ..SelectionConfig::default()
    };
    assert!(config.validate().is_err(), "the 5,000 ceiling still binds");
}

// --- Review queue tests ---------------------------------------------------

#[test]
fn a_review_item_round_trips_and_its_report_revalidates() {
    let item = fixture::review_item_fixture();
    let json = serde_json::to_string(&item).expect("serialize");
    let parsed: ReviewItem = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(parsed, item);
    let report_json = serde_json::to_string(&parsed.review).expect("report json");
    let report = crate::report::parse_report(&report_json).expect("the embedded report re-parses");
    assert!(
        report.warnings.is_empty(),
        "warnings: {:?}",
        report.warnings
    );
    assert!(!item.title().is_empty());
}

#[test]
fn dispositions_are_append_only_and_the_latest_wins() {
    let temp = tempfile::tempdir().expect("tempdir");
    let queue_path = temp.path().join("review-queue.jsonl");
    let item = fixture::review_item_fixture();
    std::fs::write(
        &queue_path,
        format!("{}\n", serde_json::to_string(&item).expect("json")),
    )
    .expect("queue");

    let first = review_queue(&ReviewOptions {
        queue: queue_path.clone(),
        accept: vec![item.queue_id.clone()],
        reject: Vec::new(),
        verdicts: None,
        note: Some("good drill".to_string()),
        dry_run: false,
    })
    .expect("accept");
    assert_eq!(first.items, 1);
    assert_eq!(first.valid, 1);
    assert_eq!(first.accepted, 1);
    assert_eq!(first.pending, 0);

    let second = review_queue(&ReviewOptions {
        queue: queue_path,
        accept: Vec::new(),
        reject: vec![item.queue_id.clone()],
        verdicts: None,
        note: Some("ambiguous".to_string()),
        dry_run: false,
    })
    .expect("reject");
    assert_eq!(second.accepted, 0);
    assert_eq!(second.rejected, 1);
    assert_eq!(second.pending, 0);

    let dispositions =
        read_dispositions(&temp.path().join("dispositions.jsonl")).expect("dispositions");
    assert_eq!(dispositions.len(), 2, "the log is append-only");
    assert_eq!(dispositions[0].verdict, DispositionVerdict::Accepted);
    assert_eq!(dispositions[1].verdict, DispositionVerdict::Rejected);
}

#[test]
fn a_dry_run_review_writes_no_dispositions() {
    let temp = tempfile::tempdir().expect("tempdir");
    let queue_path = temp.path().join("review-queue.jsonl");
    let item = fixture::review_item_fixture();
    std::fs::write(
        &queue_path,
        format!("{}\n", serde_json::to_string(&item).expect("json")),
    )
    .expect("queue");
    let report = review_queue(&ReviewOptions {
        queue: queue_path,
        accept: vec![item.queue_id.clone()],
        reject: Vec::new(),
        verdicts: None,
        note: None,
        dry_run: true,
    })
    .expect("dry run");
    assert_eq!(report.accepted, 1);
    assert!(
        !temp.path().join("dispositions.jsonl").exists(),
        "a dry run must not write"
    );
}

// --- End-to-end run -------------------------------------------------------

fn provenance(replay_id: &ReplayId, family: &str) -> GameProvenance {
    let hash = sha256_hex(b"fixture");
    let agent = |seat: u8| AgentSpec {
        seat,
        agent_id: format!("mortal-298k-{seat}"),
        kind: AgentKind::Neural,
        engine: "mortal-candle".to_string(),
        engine_version: "v4".to_string(),
        engine_sha256: Some(hash.clone()),
        weights_sha256: Some(hash.clone()),
        config: serde_json::json!({ "model": "mortal_298k" }),
        config_hash: hash.clone(),
        temperature: Some(1.0),
        sampling: "argmax".to_string(),
        seed: Some(format!("0x0{seat}")),
        reproducible: true,
        licence: LicenseInfo::new(
            "AGPL-3.0",
            "Mortal 298k checkpoint",
            true,
            "https://github.com/Equim-chan/Mortal",
        ),
    };
    GameProvenance {
        schema: CORPUS_GAME_SCHEMA.to_string(),
        version: JSON_SCHEMA_VERSION,
        replay_id: replay_id.clone(),
        corpus_id: CorpusId::parse("s2-fixture").expect("corpus id"),
        family: family.to_string(),
        match_plan_id: MatchPlanId::parse("s2-fixture-plan").expect("plan id"),
        match_plan_sha256: hash.clone(),
        source: SourceKind::ai_selfplay(),
        rule: RuleProfile::tenhou_4p_hanchan(hash.clone(), [10, 5, -5, -10]),
        generated_at: "2026-11-17T00:00:00Z".to_string(),
        generator: GeneratorInfo {
            repo: "riichiprac-corpus".to_string(),
            version: "0.1.0".to_string(),
            commit: "abc1234".to_string(),
        },
        game_seed: "0x1".to_string(),
        seat_schedule: "rotate_each_game".to_string(),
        seats: (0..4).map(agent).collect(),
        log: LogRef {
            format: "mjai".to_string(),
            path: format!("replays/{family}/{replay_id}.jsonl.gz"),
            bytes: 1,
            sha256: replay_id.clone(),
        },
        validation: ValidationSummary {
            status: ValidationStatus::Ok,
            events: 10,
            tile_ledger: true,
            score_ledger: true,
            rule_profile_match: true,
        },
        cross_engine: false,
        policy_variety: None,
    }
}

fn run_fixture() -> (tempfile::TempDir, DataRoot) {
    use crate::miner::label::LabelOptions;

    let temp = tempfile::tempdir().expect("tempdir");
    let root = DataRoot::new(temp.path().join("data")).expect("data root");
    root.ensure_layout().expect("layout");
    let bytes = crate::replay::fixtures::gzip(&crate::replay::fixtures::to_jsonl(
        &crate::replay::fixtures::all_events_game(),
    ));
    let replay_id = ReplayId::from_bytes(&bytes);
    let family = "mortal_mirror";
    let dir = root.replays_dir().join(family);
    std::fs::create_dir_all(&dir).expect("replay dir");
    std::fs::write(dir.join(format!("{replay_id}.jsonl.gz")), &bytes).expect("replay");

    let provenance = provenance(&replay_id, family);
    provenance.validate().expect("fixture provenance validates");
    let provenance_json = serde_json::to_string(&provenance).expect("provenance json");
    let rule_hash = provenance.rule.config_hash.clone();
    let match_plan_sha = provenance.match_plan_sha256.clone();
    let log_path = provenance.log.path.clone();
    let log_bytes = i64::try_from(provenance.log.bytes).expect("log bytes");
    let model_sha = sha256_hex(b"mortal_298k.safetensors");
    let connection = open_miner_db(&root).expect("db");
    migrate(&connection).expect("migrate");
    connection
        .execute(
            "INSERT INTO replays (
                replay_id, source, licence, attribution, format, rule,
                rule_config_hash, generated_at, model, model_sha256, seed,
                log_path, log_bytes, log_sha256, validation_status,
                ingested_at, corpus_id, family, match_plan_id,
                match_plan_sha256, agents, provenance_json
             ) VALUES (?1, 'ai_selfplay', 'CC-BY-4.0', 'fixture', 'mjai',
                'tenhou-4p-hanchan', ?2, '2026-11-17T00:00:00Z',
                'mortal-298k', ?3, '0x1', ?4, ?5, ?6, 'ok',
                '2026-11-17T00:01:00Z', 's2-fixture', ?7, 's2-fixture-plan',
                ?8, '[]', ?9)",
            rusqlite::params![
                replay_id.as_str(),
                rule_hash,
                model_sha,
                log_path,
                log_bytes,
                replay_id.as_str(),
                family,
                match_plan_sha,
                provenance_json,
            ],
        )
        .expect("replay row");

    let file = crate::replay::mjai::ReplayReader::read_gzip(&bytes).expect("fixture parses");
    let walk = crate::replay::walk::walk_replay(&file, replay_id).expect("fixture validates");
    let mut cached = 0;
    for decision in &walk.decisions {
        if cached == 3 {
            break;
        }
        let discards = decision
            .legal_actions
            .iter()
            .filter(|action| action.kind == ActionKind::Discard)
            .count();
        if discards < 2 || decision.kind != DecisionKind::SelfTurn {
            continue;
        }
        let label = fixture::mortal_label(decision, 0.9, 0.8);
        connection
            .execute(
                "INSERT INTO model_labels (
                    state_hash, model_sha256, classifier_version, options_hash,
                    status, attempts, label_json, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, 'ok', 1, ?5,
                    '2026-11-17T00:00:00Z', '2026-11-17T00:00:00Z')",
                rusqlite::params![
                    crate::miner::label::state_hash(&decision.state),
                    "a".repeat(64),
                    CLASSIFIER_VERSION,
                    LabelOptions::default().options_hash(),
                    serde_json::to_string(&label).expect("label json"),
                ],
            )
            .expect("cache row");
        cached += 1;
    }
    assert_eq!(cached, 3, "the fixture must cache three labels");
    (temp, root)
}

#[test]
fn a_shard_run_writes_the_queue_the_report_and_the_latest_pointer() {
    let (_temp, root) = run_fixture();
    let mut config = SelectionConfig {
        pack_id: "s2-test".to_string(),
        pack_size: 3,
        held_out_share: 0.0,
        quotas: QuotaConfig {
            families: BTreeMap::from([(Family::MortalBest, 1.0)]),
            max_section_share: 1.0,
            max_decision_kind_share: 1.0,
            max_turn_bucket_share: 1.0,
            ..QuotaConfig::default()
        },
        ..SelectionConfig::default()
    };
    config.held_out_salt = "test".to_string();
    let outcome = run_selection(
        &root,
        &SelectionOptions {
            replays: None,
            family: Some("mortal_mirror".to_string()),
            limit: None,
            extracted_only: false,
            config,
            workers: 1,
            progress: false,
            dry_run: false,
        },
    )
    .expect("run");

    assert!(outcome.written);
    assert_eq!(outcome.report.schema, SELECTION_SCHEMA);
    assert_eq!(outcome.report.pack_id, "s2-test");
    assert_eq!(outcome.report.candidates_selected, 3);
    assert_eq!(outcome.queue.len(), 3);
    assert!(outcome.held_out.is_empty());
    assert_eq!(outcome.report.gates.len(), GateKind::ALL.len());
    assert_eq!(
        outcome.report.funnel.count(FunnelStage::Selected),
        3,
        "the funnel must report the selection"
    );
    assert_eq!(outcome.report.funnel.count(FunnelStage::Packed), 0);
    assert!(outcome.paths.queue.exists());
    assert!(outcome.paths.report.exists());
    assert!(outcome.paths.held_out.exists());
    let latest = std::fs::read_to_string(&outcome.paths.latest).expect("latest");
    assert_eq!(latest.trim(), "s2-test");
    assert_eq!(
        latest_pack(&root).expect("latest pack").as_deref(),
        Some("s2-test")
    );

    let queue = read_queue(&outcome.paths.queue).expect("queue reads");
    assert_eq!(queue.items.len(), 3);
    for item in &queue.items {
        assert_eq!(item.schema, REVIEW_SCHEMA);
        assert_eq!(item.pack_id, "s2-test");
        assert!(!item.held_out);
        let json = serde_json::to_string(&item.review).expect("report json");
        let parsed = crate::report::parse_report(&json).expect("report re-parses");
        assert!(parsed.warnings.is_empty(), "{:?}", parsed.warnings);
        assert_eq!(parsed.report.table.category, "mortal_best");
        assert_eq!(item.label_kind, "mortal");
    }
    // The queue is consumable by the review command.
    let review = review_queue(&ReviewOptions {
        queue: outcome.paths.queue.clone(),
        accept: Vec::new(),
        reject: Vec::new(),
        verdicts: None,
        note: None,
        dry_run: true,
    })
    .expect("review");
    assert_eq!(review.items, 3);
    assert_eq!(review.pending, 3);
    assert_eq!(review.invalid, 0);
    assert!(!outcome.report.human_summary().is_empty());
}

#[test]
fn a_dry_run_writes_nothing() {
    let (_temp, root) = run_fixture();
    let config = SelectionConfig {
        pack_id: "s2-dry".to_string(),
        pack_size: 2,
        held_out_share: 0.0,
        quotas: QuotaConfig {
            families: BTreeMap::from([(Family::MortalBest, 1.0)]),
            max_section_share: 1.0,
            max_decision_kind_share: 1.0,
            max_turn_bucket_share: 1.0,
            ..QuotaConfig::default()
        },
        ..SelectionConfig::default()
    };
    let outcome = run_selection(
        &root,
        &SelectionOptions {
            replays: None,
            family: Some("mortal_mirror".to_string()),
            limit: None,
            extracted_only: false,
            config,
            workers: 1,
            progress: false,
            dry_run: true,
        },
    )
    .expect("dry run");
    assert!(!outcome.written);
    assert!(!outcome.paths.queue.exists());
    assert!(!outcome.paths.report.exists());
    assert_eq!(outcome.report.candidates_selected, 2);
}

#[test]
fn the_section_scope_matches_a_prefix_or_an_exact_section() {
    let mut config = SelectionConfig {
        pack_id: "scope".to_string(),
        book_prefixes: vec!["ch8".to_string()],
        ..SelectionConfig::default()
    };
    assert!(config.section_allowed(Some("ch8")));
    assert!(config.section_allowed(Some("ch8.2")));
    assert!(config.section_allowed(Some("ch8.3")));
    assert!(!config.section_allowed(Some("ch8x.2")));
    assert!(!config.section_allowed(Some("ch7.3")));
    assert!(!config.section_allowed(None), "a ch8 pack is book-only");

    config.book_prefixes = vec!["ch8.2".to_string()];
    assert!(config.section_allowed(Some("ch8.2")));
    assert!(!config.section_allowed(Some("ch8.3")));

    config.lessons = vec!["fold_to_riichi".to_string()];
    assert!(config.lesson_allowed(Some("fold_to_riichi")));
    assert!(!config.lesson_allowed(Some("defense_safety_chart")));

    config.replay_families = vec!["akochan_tactics".to_string()];
    assert!(config.replay_family_allowed("akochan_tactics"));
    assert!(!config.replay_family_allowed("mortal_mirror"));
    assert!(config.scope_note().is_some());
}

#[test]
fn a_corpus_family_cap_balances_the_pack_and_is_never_relaxed() {
    let mut candidates = Vec::new();
    for index in 0..10 {
        let family = if index < 5 {
            "mortal_mirror"
        } else {
            "akochan_tactics"
        };
        let mut candidate = fixture::candidate_with(
            &format!("c{index}"),
            Family::Book,
            Some("ch8.2"),
            DecisionKind::SelfTurn,
            TurnBucket::Mid,
            1.0 - index as f32 / 100.0,
            &sha256_hex(format!("exact-{index}").as_bytes()),
            &sha256_hex(format!("visible-{index}").as_bytes()),
        );
        candidate.replay_family = family.to_string();
        candidates.push(candidate);
    }
    let mut mixed = config(BTreeMap::from([(Family::Book, 1.0)]), 6);
    mixed.replay_family_caps = BTreeMap::from([
        ("mortal_mirror".to_string(), 3),
        ("akochan_tactics".to_string(), 3),
    ]);
    let plan = plan_selection(candidates, &mixed);
    assert_eq!(plan.selected.len(), 6);
    let families: BTreeMap<&str, usize> =
        plan.selected
            .iter()
            .fold(BTreeMap::new(), |mut counts, scenario| {
                *counts
                    .entry(scenario.candidate.replay_family.as_str())
                    .or_insert(0) += 1;
                counts
            });
    assert_eq!(families["mortal_mirror"], 3);
    assert_eq!(families["akochan_tactics"], 3);
    let row = plan
        .replay_families
        .iter()
        .find(|row| row.bucket == "mortal_mirror")
        .expect("corpus family row");
    assert_eq!(row.cap, Some(3));
    assert_eq!(row.relaxed, 0);
    assert!(row.cap_reached);

    // A cap is a mix rule, so the pack may be short rather than over the cap.
    let mut strict = config(BTreeMap::from([(Family::Book, 1.0)]), 10);
    strict.replay_family_caps = BTreeMap::from([("mortal_mirror".to_string(), 2)]);
    let candidates: Vec<Candidate> = (0..5)
        .map(|index| fixture::candidate(&format!("m{index}"), Family::Book, Some("ch8.2")))
        .collect();
    let plan = plan_selection(candidates, &strict);
    assert_eq!(plan.selected.len(), 2, "the unlisted pool is empty");
    assert!(plan.replay_cap_blocked > 0);
    assert_eq!(plan.cap_relaxed, 0);
}

#[test]
fn a_source_replay_cap_keeps_one_game_from_filling_the_pack() {
    let mut candidates = Vec::new();
    for index in 0..10 {
        let mut candidate = fixture::candidate(&format!("r{index}"), Family::Book, Some("ch8.2"));
        candidate.replay_id = format!("{:064x}", index / 2);
        candidates.push(candidate);
    }
    let mut config = config(BTreeMap::from([(Family::Book, 1.0)]), 10);
    config.max_per_replay = Some(1);
    let plan = plan_selection(candidates, &config);
    assert_eq!(plan.selected.len(), 5);
    let seen: BTreeSet<&str> = plan
        .selected
        .iter()
        .map(|scenario| scenario.candidate.replay_id.as_str())
        .collect();
    assert_eq!(seen.len(), 5, "one base per replay");
    assert!(plan.source_replay_cap_blocked > 0);
}
