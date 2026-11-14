//! AI hotseat scenario: a full round self-played by Mortal, then presented at
//! one of the inserted seat's real decisions.
//!
//! Flow:
//!
//! 1. Resolve the generation card's options (round, point disparity, seat) and
//!    deal the table under them.
//! 2. Play the round with the loaded Mortal model in every seat (see
//!    [`sim`](self)).
//! 3. Pick one of the inserted seat's recorded decisions with an inverse
//!    survival weight (late turns are rarer, so they are up-weighted) and grade
//!    it exactly like the other Mortal-only drills: the correct answer is the
//!    model's top legal action at that position.
//!
//! Insertion points are real decisions only: forced Riichi tsumogiri turns and
//! round-ending wins (tsumo/ron) are excluded.
//!
//! The whole engine is in Rust/WASM. React only renders the returned
//! [`GameState`] and grades clicks against `correct_action`, so this scenario
//! needs no new frontend rules logic.

mod bridge;
mod options;
mod sim;

#[cfg(test)]
mod test_support;

use crate::ai::finalize::{build_ai_decision, correct_action_from_info};
use crate::ai::model::MortalV4Model;
use crate::ai::wasm_bridge::Evaluation;
use crate::decision::ActionKind;
use crate::generator::finalize_state;
use crate::rng::{gen_range, random_f64};
use crate::state::{GameState, TargetAction};

pub use options::{Disparity, HotseatOptions, HotseatRound, HotseatSeat, StartingConditions};
pub(crate) use sim::TurnProgress;

use sim::{DecisionRecord, ModelPolicy, Policy, SimTable};

/// How many full self-played rounds to try before giving up. A retry only
/// happens when the round ended before the inserted seat ever faced a
/// recordable decision.
const MAX_SIMULATED_ROUNDS: usize = 4;

/// The last full turn of a round dealt from the 69-tile live wall.
///
/// Turn `t` covers live-wall draws `4t - 3 ..= 4t`. Turn 17 is draws 65..=68,
/// when all four seats act; draw 69 is a partial eighteenth turn that only the
/// dealer reaches, so it is outside the uniform range.
pub(crate) const MAX_FULL_TURN: usize = 17;

/// Empirical probability that a real-weight round has a recordable decision for
/// the inserted seat at each full turn.
///
/// Measured over 30 rounds of `mortal_298k.safetensors` (East 1, level scores,
/// East seat): turns 1-3 were recordable in 30/30 rounds, turns 14-17 in only
/// 5-6/30. Selecting uniformly over decisions therefore over-samples the early
/// game, because a decision can only exist at a turn the round actually
/// reached. The ratio `1 / TURN_SURVIVAL[t]` is the importance weight that
/// flattens the result back to an even turn distribution.
///
/// Index 0 is unused. The values are the raw measured fractions
/// (`30,30,30,28,28,27,27,22,22,21,13,10,9,5,5,6,6` out of 30) rather than a
/// smoothed curve: multiplying each turn's count by its inverse survival then
/// gives the same expected weight at every turn. Re-measure this table if the
/// checkpoint or the seat-condition mix changes materially.
const TURN_SURVIVAL: [f32; MAX_FULL_TURN + 1] = [
    0.0, 1.0, 1.0, 1.0, 0.933, 0.933, 0.9, 0.9, 0.733, 0.733, 0.7, 0.433, 0.333, 0.3, 0.167, 0.167,
    0.2, 0.2,
];

/// Generate the AI hotseat scenario under the card's options.
///
/// `options_json` is the generation card's shape:
/// `{"round":"east_1","disparity":"about_equal_all","seat":"west"}`, with a
/// missing or `null` field drawn at random. Empty input means every option is
/// random.
pub fn generate(
    model: &MortalV4Model,
    model_name: &str,
    options_json: &str,
) -> Result<GameState, String> {
    generate_model_with_progress(model, model_name, options_json, &mut |_| {})
}

/// Production path with a progress sink, shared by the WASM bridge.
pub(crate) fn generate_model_with_progress(
    model: &MortalV4Model,
    model_name: &str,
    options_json: &str,
    progress: &mut dyn FnMut(TurnProgress),
) -> Result<GameState, String> {
    let policy = ModelPolicy {
        model,
        name: model_name,
    };
    generate_with_progress(&policy, options_json, progress)
}

/// The same generation path with an injectable policy, so the rules engine can
/// be tested without running dozens of debug-build forward passes.
#[cfg(test)]
pub(crate) fn generate_with_policy(
    policy: &dyn Policy,
    options_json: &str,
) -> Result<GameState, String> {
    generate_with_progress(policy, options_json, &mut |_| {})
}

/// Full generation path: play a round, choose one of its real decisions, and
/// report each new full turn while the round is being played.
pub(crate) fn generate_with_progress(
    policy: &dyn Policy,
    options_json: &str,
    progress: &mut dyn FnMut(TurnProgress),
) -> Result<GameState, String> {
    let options = HotseatOptions::from_json(options_json)?;
    let conditions = options.resolve();

    let mut last_error = String::new();
    for attempt in 1..=MAX_SIMULATED_ROUNDS {
        let mut table = SimTable::deal(conditions);
        match table.play_with_progress(policy, attempt, progress) {
            Ok(_) => {}
            Err(err) => {
                last_error = err;
                continue;
            }
        }
        if table.records.is_empty() {
            last_error = "the round ended before the inserted seat faced a decision".to_string();
            continue;
        }

        let index = match select_record(&table.records) {
            Ok(index) => index,
            Err(err) => {
                last_error = err;
                continue;
            }
        };
        let record = table.records.swap_remove(index);
        let mut state = record.state;
        state.category = "ai_hotseat".to_string();
        // The turn is part of the position, not a hint at the answer: it tells
        // the player how far into the round the insertion happened.
        let base_note = state
            .scenario_note
            .as_deref()
            .map(str::trim_end)
            .filter(|note| !note.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| conditions.note());
        state.scenario_note = Some(format!("{base_note} Inserted on turn {}.", record.turn));
        apply_top_action(&mut state, &record.evaluation)?;
        state = finalize_state(state);
        return Ok(state);
    }

    Err(format!(
        "could not produce a hotseat position after {MAX_SIMULATED_ROUNDS} simulated \
         round(s): {last_error}"
    ))
}

/// Choose a recorded decision with an inverse-survival weight.
///
/// A turn is weighted by `1 / TURN_SURVIVAL[turn]`, then one record at that
/// turn is picked uniformly. This makes every full turn 1..=[`MAX_FULL_TURN`]
/// equally likely instead of inheriting the round-length survival curve.
fn select_record(records: &[DecisionRecord]) -> Result<usize, String> {
    select_record_with_survival(records, &TURN_SURVIVAL)
}

/// The weighted selector, with the survival table injectable for tests.
fn select_record_with_survival(
    records: &[DecisionRecord],
    survival: &[f32; MAX_FULL_TURN + 1],
) -> Result<usize, String> {
    let mut by_turn: Vec<Vec<usize>> = vec![Vec::new(); MAX_FULL_TURN + 1];
    for (index, record) in records.iter().enumerate() {
        let turn = record.turn as usize;
        if (1..=MAX_FULL_TURN).contains(&turn) {
            by_turn[turn].push(index);
        }
    }

    let weights: Vec<(usize, f64)> = (1..=MAX_FULL_TURN)
        .filter(|turn| !by_turn[*turn].is_empty())
        .map(|turn| (turn, 1.0 / survival[turn].max(0.01) as f64))
        .collect();
    if weights.is_empty() {
        return Err("the round recorded no decision in the full-turn range".to_string());
    }

    let total: f64 = weights.iter().map(|(_, weight)| weight).sum();
    let mut roll = random_f64() * total;
    let mut chosen = weights[weights.len() - 1].0;
    for (turn, weight) in &weights {
        if roll < *weight {
            chosen = *turn;
            break;
        }
        roll -= weight;
    }

    let group = &by_turn[chosen];
    Ok(group[gen_range(0, group.len())])
}

/// Stamp the model's top action as the trainer's answer.
///
/// Unlike the agreement sampler, the hotseat position is not chosen for its
/// answer: whatever the model played in that seat is the answer. The top
/// evaluation entry, rather than just its action name, is used because a hand
/// can offer several different `Kan` actions under one name.
fn apply_top_action(state: &mut GameState, evaluation: &Evaluation) -> Result<(), String> {
    let top = evaluation
        .evaluations
        .first()
        .ok_or_else(|| "the recorded position has no model evaluation".to_string())?;
    let tile_override = if top.info.kind == ActionKind::Riichi {
        evaluation.riichi_discard.as_deref()
    } else {
        None
    };
    state.correct_action = correct_action_from_info(&top.info, tile_override);
    state.target_action = TargetAction::Best;
    state.ai_decision = Some(build_ai_decision(state, evaluation, None));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decision::ActionKind;
    use crate::generator::hotseat::test_support::{FastMode, FastPolicy};
    use crate::generator::support::state_validation::validate_reachable_state;
    use crate::state::CorrectActionType;

    fn pinned() -> HotseatOptions {
        HotseatOptions {
            round: Some(HotseatRound::South2),
            disparity: Some(Disparity::AboutEqualBetweenTwo),
            seat: Some(HotseatSeat::West),
        }
    }

    #[test]
    fn a_fast_policy_returns_a_finalized_hotseat_position() {
        let policy = FastPolicy::default();
        let json = serde_json::to_string(&pinned()).unwrap();
        let state = generate_with_policy(&policy, &json).expect("hotseat generates");

        assert_eq!(state.category, "ai_hotseat");
        assert_eq!(state.target_action, TargetAction::Best);
        assert_eq!(state.correct_action.action_type(), CorrectActionType::Best);
        assert!(state.ai_decision.is_some());
        assert_eq!(state.players[0].wind, crate::state::Wind::West);
        assert!((1..=4).contains(&state.hand_number));
        assert_eq!(state.round_wind, crate::state::Wind::South);
        assert_eq!(state.hand_number, 2);
        // The note names the starting conditions, never the answer.
        let note = state.scenario_note.as_deref().unwrap_or_default();
        assert!(note.contains("South 2"));
        assert!(note.contains("West"));
        assert!(note.contains("level with one other"));
        assert!(!note.contains("Discard"));
        assert!(!note.contains("Riichi"));
    }

    #[test]
    fn measured_turn_counts_are_flattened_by_the_survival_weights() {
        // The calibration sample behind TURN_SURVIVAL. Each turn's expected
        // selection weight is count / survival; the whole point of the table is
        // that those weights are the same for every full turn.
        let measured = [
            0usize, 30, 30, 30, 28, 28, 27, 27, 22, 22, 21, 13, 10, 9, 5, 5, 6, 6,
        ];
        let weights: Vec<f64> = (1..=MAX_FULL_TURN)
            .map(|turn| measured[turn] as f64 / TURN_SURVIVAL[turn] as f64)
            .collect();
        let min = weights.iter().copied().fold(f64::INFINITY, f64::min);
        let max = weights.iter().copied().fold(0.0, f64::max);
        assert!(
            max / min < 1.01,
            "the calibration must flatten to equal turn weights: {weights:?}"
        );
        assert!(
            measured.iter().skip(1).max().unwrap() / measured[1..].iter().min().unwrap() >= 4,
            "the raw counts must actually be biased for this test to mean anything"
        );
    }

    #[test]
    fn the_note_reports_the_inserted_turn() {
        let policy = FastPolicy::default();
        let state = generate_with_policy(&policy, "{}").expect("hotseat generates");
        let note = state.scenario_note.as_deref().unwrap_or_default();
        assert!(note.contains("Inserted on turn "), "{note}");
        let turn: u8 = note
            .rsplit("Inserted on turn ")
            .next()
            .and_then(|rest| rest.trim_end_matches('.').parse().ok())
            .expect("the note must end with a turn number");
        assert!((1..=MAX_FULL_TURN as u8).contains(&turn), "{turn}");
    }

    #[test]
    fn weighted_selection_flattens_the_turn_distribution() {
        // One no-win round records a decision at every full turn. With a flat
        // survival table the selector must give each present turn the same
        // share; this is the mechanism the real survival weights invert.
        let policy = FastPolicy::default();
        let mut table = crate::generator::hotseat::sim::SimTable::deal(StartingConditions {
            round: HotseatRound::East1,
            disparity: Disparity::AboutEqualAll,
            seat: HotseatSeat::East,
        });
        table.play(&policy).expect("round plays");
        let records = table.records;
        let uniform = [1.0f32; MAX_FULL_TURN + 1];

        let mut counts = [0usize; MAX_FULL_TURN + 1];
        for _ in 0..2_000 {
            let index = select_record_with_survival(&records, &uniform).expect("a record");
            counts[records[index].turn as usize] += 1;
        }
        let present: Vec<usize> = (1..=MAX_FULL_TURN)
            .filter(|turn| records.iter().any(|record| record.turn as usize == *turn))
            .collect();
        let expected = 2_000 / present.len();
        for turn in &present {
            assert!(
                counts[*turn] > expected / 2 && counts[*turn] < expected * 2,
                "turn {turn} selected {} times, expected about {expected}: {counts:?}",
                counts[*turn]
            );
        }
    }

    #[test]
    fn the_answer_is_one_of_the_legal_actions() {
        let policy = FastPolicy::default();
        let state = generate_with_policy(&policy, "{}").expect("hotseat generates");
        let ai = state.ai_decision.clone().expect("ai decision");
        assert!(
            ai.actions
                .iter()
                .any(|action| action.action == ai.recommended_action)
        );
        let correct = match &state.correct_action {
            crate::state::CorrectAction::Best { action, .. } => action,
            other => panic!("expected a best answer, got {other:?}"),
        };
        assert_eq!(correct, &ai.recommended_action);
        let top = ai.evaluations.first().expect("top evaluation");
        assert_eq!(top.info.action, ai.recommended_action);
        if top.info.kind == ActionKind::Riichi {
            assert!(
                state.correct_action.tile().is_some(),
                "a Riichi answer must carry its declaration discard"
            );
        }
    }

    #[test]
    fn the_recorded_position_is_still_a_reachable_table() {
        let policy = FastPolicy::default();
        let state = generate_with_policy(&policy, "{}").expect("hotseat generates");
        // The serialized state keeps the real concealed hands, as the other AI
        // drills do, so the same reachability guard applies.
        validate_reachable_state(&state).unwrap_or_else(|err| panic!("unreachable: {err}"));
    }

    #[test]
    fn the_inserter_never_records_a_forced_riichi_turn() {
        // The decision context only allows a self turn or a reaction, and every
        // candidate offers at least two choices: a forced tsumogiri after a
        // Riichi is filtered out before recording.
        let policy = FastPolicy::new(FastMode::Riichi);
        let state = generate_with_policy(&policy, "{}").expect("hotseat generates");
        let actions = crate::ai::actions::legal_actions(&state);
        assert!(
            actions.len() > 1,
            "a hotseat candidate must be a real decision, got {actions:?}"
        );
    }

    #[test]
    fn pinned_round_scores_and_seat_survive_generation() {
        let policy = FastPolicy::default();
        for seat in HotseatSeat::ALL {
            let options = HotseatOptions {
                round: Some(HotseatRound::East3),
                disparity: Some(Disparity::InFirstByLargeGap),
                seat: Some(seat),
            };
            let state = generate_with_policy(&policy, &serde_json::to_string(&options).unwrap())
                .expect("hotseat generates");
            assert_eq!(state.players[0].wind, seat.wind());
            assert_eq!(state.round_wind, crate::state::Wind::East);
            assert_eq!(state.hand_number, 3);
            // Riichi declarations during the played round may already have
            // taken the 1000-point stick, so compare against the starting score
            // with that allowance rather than requiring an exact tie.
            let start =
                Disparity::InFirstByLargeGap.scores_for(seat.wind().index())[seat.wind().index()];
            assert!(
                state.players[0].score <= start && state.players[0].score >= start - 1_000,
                "seat {} score {} vs start {start}",
                seat.label(),
                state.players[0].score
            );
            let highest = state
                .players
                .iter()
                .map(|player| player.score)
                .max()
                .unwrap();
            assert_eq!(
                highest, state.players[0].score,
                "the inserted seat is first"
            );
        }
    }

    #[test]
    fn every_disparity_cell_generates() {
        let policy = FastPolicy::default();
        for disparity in Disparity::ALL {
            let options = HotseatOptions {
                round: Some(HotseatRound::East1),
                disparity: Some(disparity),
                seat: Some(HotseatSeat::South),
            };
            let state = generate_with_policy(&policy, &serde_json::to_string(&options).unwrap())
                .unwrap_or_else(|err| panic!("{} failed: {err}", disparity.label()));
            assert!(!state.hand_string.is_empty());
        }
    }

    #[test]
    #[ignore = "runs a full Mortal self-play; use --release --ignored"]
    fn zero_weights_self_play_completes() {
        let model = test_support::zero_model();
        let state = generate(&model, "zero_weights", "{}").expect("hotseat generates");
        assert!(state.ai_decision.is_some());
    }

    #[test]
    #[ignore = "runs a full Mortal self-play; use --release --ignored"]
    fn real_weights_generate_a_hotseat_position() {
        const WEIGHTS: &str = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/frontend/public/models/mortal_298k.safetensors"
        );
        if !std::path::Path::new(WEIGHTS).exists() {
            eprintln!("skipping hotseat inference test: {WEIGHTS} is missing");
            return;
        }

        use candle_core::{DType, Device};
        use candle_nn::VarBuilder;
        let vb = VarBuilder::from_buffered_safetensors(
            std::fs::read(WEIGHTS).unwrap(),
            DType::F32,
            &Device::Cpu,
        )
        .unwrap();
        let model = MortalV4Model::new(vb).unwrap();

        let mut turns = Vec::new();
        let state = generate_model_with_progress(
            &model,
            "mortal_298k.safetensors",
            r#"{"round":"east_1","disparity":"about_equal_all","seat":"east"}"#,
            &mut |progress| turns.push(progress),
        )
        .expect("real weights must generate a hotseat position");

        assert!(!turns.is_empty(), "the real round must report progress");
        assert_eq!(turns[0].turn, 1);
        assert!(
            turns.windows(2).all(|pair| pair[1].turn >= pair[0].turn),
            "progress must advance: {turns:?}"
        );
        let note = state.scenario_note.as_deref().unwrap_or_default();
        let inserted: u8 = note
            .rsplit("Inserted on turn ")
            .next()
            .and_then(|rest| rest.trim_end_matches('.').parse().ok())
            .expect("the real position must name its turn");
        assert!((1..=MAX_FULL_TURN as u8).contains(&inserted), "{inserted}");

        let ai = state.ai_decision.expect("ai decision");
        assert_eq!(ai.model, "mortal_298k.safetensors");
        assert!(
            ai.actions
                .iter()
                .any(|action| action.action == ai.recommended_action)
        );
    }
}
