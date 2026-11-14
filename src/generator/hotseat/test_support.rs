//! Test-only helpers for the hotseat simulator.

use candle_core::{DType, Device};
use candle_nn::VarBuilder;

use crate::ai::actions::legal_actions;
use crate::ai::model::MortalV4Model;
use crate::ai::wasm_bridge::Evaluation;
use crate::decision::{ActionEvaluation, ActionInfo, ActionKind};
use crate::generator::hotseat::sim::Policy;
use crate::state::GameState;

/// A model with every weight zero. Used only by the ignored full-round timing
/// test: a debug-build Candle forward pass is roughly two seconds, so the rules
/// tests use [`FastPolicy`] instead.
pub(crate) fn zero_model() -> MortalV4Model {
    let vb = VarBuilder::zeros(DType::F32, &Device::Cpu);
    MortalV4Model::new(vb).expect("zero-weight model binds")
}

/// A cheap deterministic policy that still exercises every engine branch.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) enum FastMode {
    /// Discard the first legal tile; pass on every call. Keeps a round going.
    #[default]
    DiscardOnly,
    /// Declare Riichi whenever it is legal, and win when possible.
    Riichi,
    /// Take the first call or win offered, otherwise discard.
    CallsAndWins,
}

/// Deterministic test policy.
pub(crate) struct FastPolicy {
    pub(crate) mode: FastMode,
}

impl FastPolicy {
    pub(crate) fn new(mode: FastMode) -> Self {
        Self { mode }
    }
}

impl Default for FastPolicy {
    fn default() -> Self {
        Self {
            mode: FastMode::DiscardOnly,
        }
    }
}

impl Policy for FastPolicy {
    fn evaluate(&self, state: &GameState) -> Result<Evaluation, String> {
        let actions = legal_actions(state);
        if actions.is_empty() {
            return Err("test policy found no legal action".to_string());
        }

        let chosen = choose(&actions, self.mode, state)?;
        let mut evaluations: Vec<ActionEvaluation> = Vec::with_capacity(actions.len());
        let rest = if actions.len() > 1 {
            0.1 / (actions.len() - 1) as f32
        } else {
            0.0
        };
        for action in &actions {
            let probability = if action.action == chosen.action
                && action.tile == chosen.tile
                && action.kind == chosen.kind
            {
                0.9
            } else {
                rest
            };
            evaluations.push(ActionEvaluation {
                info: action.clone(),
                probability,
            });
        }
        evaluations.sort_by(|left, right| {
            right
                .probability
                .total_cmp(&left.probability)
                .then_with(|| left.info.action.cmp(&right.info.action))
        });

        let riichi_discard = (chosen.kind == ActionKind::Riichi)
            .then(|| {
                actions
                    .iter()
                    .find(|action| action.kind == ActionKind::Discard)
                    .and_then(|action| action.tile.clone())
            })
            .flatten();

        Ok(Evaluation {
            model: "fast_test_policy".to_string(),
            expected_value: 0.0,
            recommended_action: chosen.action.clone(),
            riichi_discard,
            evaluations,
        })
    }
}

fn choose(actions: &[ActionInfo], mode: FastMode, state: &GameState) -> Result<ActionInfo, String> {
    let first = |kind: ActionKind| actions.iter().find(|action| action.kind == kind).cloned();
    let discard = || {
        actions
            .iter()
            .find(|action| action.kind == ActionKind::Discard)
            .cloned()
    };

    if state.decision == crate::state::DecisionContext::SelfTurn {
        if matches!(mode, FastMode::Riichi | FastMode::CallsAndWins)
            && let Some(agari) = first(ActionKind::Agari)
        {
            return Ok(agari);
        }
        if mode == FastMode::Riichi
            && let Some(riichi) = first(ActionKind::Riichi)
        {
            return Ok(riichi);
        }
        if let Some(tile) = discard() {
            return Ok(tile);
        }
        return actions
            .first()
            .cloned()
            .ok_or_else(|| "empty action list".to_string());
    }

    if mode == FastMode::CallsAndWins {
        if let Some(agari) = first(ActionKind::Agari) {
            return Ok(agari);
        }
        if let Some(call) = actions.iter().find(|action| {
            matches!(
                action.kind,
                ActionKind::Chi | ActionKind::Pon | ActionKind::Kan
            )
        }) {
            return Ok(call.clone());
        }
    }

    if let Some(pass) = first(ActionKind::Pass) {
        return Ok(pass);
    }
    actions
        .first()
        .cloned()
        .ok_or_else(|| "empty reaction list".to_string())
}
