//! Shared decision payload types for the trainer and the Mortal bridge.

use serde::{Deserialize, Serialize};

/// Coarse action family understood by the frontend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionKind {
    Discard,
    Riichi,
    Chi,
    Pon,
    Kan,
    Agari,
    Ryukyoku,
    Pass,
}

/// Which shape of kan a `Kan` action represents.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KanKind {
    /// Open kan off an opponent's discard.
    Daiminkan,
    /// Closed kan from four concealed copies.
    Ankan,
    /// Added kan on an existing open Pon.
    Kakan,
}

/// One legal action with everything the UI needs to render and grade it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActionInfo {
    /// Mortal action name, e.g. `Discard_3m`, `Riichi`, `Chi_Low`, `Pon`.
    pub action: String,
    /// Human-readable label, e.g. `Discard 3m`, `Chi 2m 3m on 4m`.
    pub label: String,
    /// Coarse family. Serialized as `type` to match the existing AI payload.
    #[serde(rename = "type")]
    pub kind: ActionKind,
    /// Mortal's 0..=33 tile index for tile actions; `None` for calls.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tile_index: Option<usize>,
    /// Base tile code for discard/pon/kan/agari actions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tile: Option<String>,
    /// Additional concrete tiles consumed by a call (chi).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tiles: Vec<String>,
    /// Which kan shape is offered, when relevant.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kan_kind: Option<KanKind>,
}

impl ActionInfo {
    /// True when this is a plain hand discard (including a red five).
    pub fn is_discard(&self) -> bool {
        self.kind == ActionKind::Discard
    }
}

/// One scored action in an evaluation result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActionEvaluation {
    /// Action metadata, flattened into the JSON object.
    #[serde(flatten)]
    pub info: ActionInfo,
    /// Softmax probability over the legal actions.
    pub probability: f32,
}

/// The model-derived decision attached to an AI scenario payload.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AiDecision {
    /// Exact model identity, e.g. `mortal_298k.safetensors`.
    pub model: String,
    /// Optional model-provided explanation. `None` for the current policy net.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    /// Mortal's expected-value head for the position.
    pub expected_value: f32,
    /// Raw argmax, including a red-five suffix when applicable.
    pub recommended_action: String,
    /// Every legal action, highest probability first.
    pub evaluations: Vec<ActionEvaluation>,
    /// Every legal action with render/grade details, no probabilities.
    pub actions: Vec<ActionInfo>,
}
