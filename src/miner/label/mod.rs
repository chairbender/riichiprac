//! Mortal labeler (L1): batch native inference, Q values and the label cache.
//! L2 adds book/Mortal agreement (`stable`/`contested`), optional multi-model
//! votes, percentile-threshold hooks and optional versioned Q→point calibration.
//!
//! This is the native/mining side of the app's MIT Mortal inference. It runs
//! the same [`MortalV4Model`] and the same masked softmax as the browser's
//! [`crate::ai::wasm_bridge::evaluate_state_named`], but keeps the per-action
//! **Q values** the browser payload discards and records them as
//! `model_utility` (replay-strategy §6.5.2, implementation unit L1).
//!
//! # What a label contains
//!
//! A [`ModelLabel`] is a self-contained JSON document:
//!
//! - the labeler identity (`model`, `model_sha256`, optional `gamma`/`pts`) and
//!   `q_units`/`value_units` = `"model_utility"`;
//! - the model's top action, full ranking, probabilities and expected value;
//! - the raw `q_values` map, `q_gap_top2` and `probability_margin`;
//! - `q_gap_safe`, where the safe action is chosen by
//!   [`crate::safety::SafetyFacts`] (the book's chart), never by "Mortal says
//!   so", plus the `safe_action` it measured against;
//! - the book label for the same snapshot, settled with Mortal as the
//!   tiebreaker ([`crate::miner::classifier::classify_decision_with_mortal`]),
//!   and the agreement computed by [`compare_action_set`] (the app's grading
//!   rule, including `equivalent_tiles` and the Riichi second pass);
//! - the derived `label_kind` (`book`/`contested`/`mortal`/`none`) and
//!   `stability` (`stable`/`contested`/`unresolved`) from
//!   [`agreement`], so a book/Mortal discrepancy is an explicit
//!   contested drill rather than a silent preference for either side;
//! - optional multi-model `consensus` votes (only with two or more checkpoints);
//! - optional `calibration_version`/`expected_point_diffs` from
//!   [`calibration`], which never overwrite the raw Q values;
//! - the replay's generator identity when it differs from the labeler's.
//!
//! No field claims points. `q_gap_top2` is `q(best) - q(second)` and
//! `q_gap_safe` is `q(best) - q(safest)` in the same model-utility units as the
//! Q values; absolute Q values are only comparable within one position. A point
//! estimate exists only in the separate `expected_point_diffs` field, and only
//! when a caller explicitly applied a versioned
//! [`QPointCalibration`](self::calibration::QPointCalibration).
//!
//! # Cache
//!
//! Evaluations are cached in SQLite by
//! `(state_hash, model_sha256, classifier_version, options_hash)` through
//! [`cache::LabelCache`]. The state hash is the SHA-256 of the v4 observation
//! ([`state_hash`]), i.e. exactly what the model sees: scenario metadata and
//! derived hand metrics are excluded, so re-stamping a state or finding the
//! same table position in another replay reuses the evaluation. [`label_decision`]
//! skips finished (`ok`) work and retries `failed` rows.
//!
//! # No `libriichi`
//!
//! This module uses only the crate's own Candle port. The Q values are the
//! network's action logits; nothing links to Mortal's AGPL-3.0 library.

pub mod agreement;
pub mod cache;
pub mod calibration;
pub mod run;
pub mod thresholds;

use std::collections::BTreeMap;
use std::path::Path;

use agari::tile::Tile as SafetyTile;
use candle_core::{DType, Device};
use candle_nn::VarBuilder;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::ai::actions::legal_action_mask;
use crate::ai::encoder::encode_v4_observation;
use crate::ai::model::MortalV4Model;
use crate::ai::wasm_bridge::{Evaluation, evaluate_state_with_q_values};
use crate::classifier::Resolution;
use crate::decision::ActionKind;
use crate::fuzz::{FuzzOutcome, compare_action_set};
use crate::miner::provenance::sha256_hex;
use crate::replay::walk::DecisionSnapshot;
use crate::safety::SafetyFacts;
use crate::state::{CorrectAction, GameState, TargetAction};

use self::cache::{CacheLookup, LabelCache, LabelKey};
use self::calibration::ExpectedPointDiffs;
use super::MODEL_LABEL_SCHEMA;
pub use agreement::{
    Consensus, LabelKind, ModelConsensus, ModelVote, Stability, derive_label_kind, derive_stability,
};

/// Units for every Q value and Q gap; a difference is not a point difference.
pub const Q_UNITS: &str = "model_utility";

/// Units for the model's value head and expected value.
pub const VALUE_UNITS: &str = "model_utility";

/// Classifier/labeler generation recorded on every label.
///
/// It is part of the cache key: a classifier change must not reuse a book label
/// from the previous rule set. The Mortal inference itself is versioned by
/// `model_sha256`.
pub const CLASSIFIER_VERSION: &str = "1";

/// The note carried by every label, so a consumer cannot mistake Q for points.
pub const Q_UNITS_NOTE: &str = "Q values are model utility, not points.";

/// Any failure while loading the model, evaluating a state, labelling or
/// reading/writing the cache.
#[derive(Debug, Error)]
pub enum LabelError {
    /// The checkpoint could not be read.
    #[error("cannot read Mortal weights at `{path}`: {source}")]
    Weights {
        path: String,
        #[source]
        source: std::io::Error,
    },
    /// The checkpoint did not parse or bind.
    #[error("cannot load the Mortal checkpoint `{path}`: {message}")]
    Model { path: String, message: String },
    /// A replay-store path could not be read.
    #[error("I/O error at `{path}`: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
    /// The forward pass failed.
    #[error("Mortal evaluation failed: {0}")]
    Evaluation(String),
    /// The evaluator did not supply a Q value for a scored action.
    #[error("evaluation is missing a Q value for `{0}`; the mining labeler needs raw Q values")]
    MissingQValue(String),
    /// A label payload could not be (de)serialized.
    #[error("label JSON error: {0}")]
    Json(#[from] serde_json::Error),
    /// SQLite failure.
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    /// The data root or replay store failed.
    #[error(transparent)]
    Storage(#[from] super::storage::StorageError),
    /// A replay could not be walked.
    #[error(transparent)]
    Walk(#[from] crate::replay::WalkError),
    /// The replay directory is missing.
    #[error("replay directory `{0}` does not exist")]
    MissingReplays(String),
}

/// The model's identity, hash and the utility configuration it was trained on.
///
/// `gamma`/`pts` are recorded **when the operator supplies them**; the deployed
/// `mortal_298k.safetensors` carries neither in its metadata, so they are `None`
/// unless the CLI or a future model card provides them. Never invent them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelIdentity {
    /// Exact file name, e.g. `mortal_298k.safetensors`.
    pub model: String,
    /// SHA-256 of the checkpoint bytes, lowercase hex.
    pub model_sha256: String,
    /// Reward discount the training target used, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gamma: Option<f32>,
    /// Placement/rank utility weights, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pts: Option<Vec<f32>>,
}

impl ModelIdentity {
    /// True when two identities name the same checkpoint file and bytes.
    #[must_use]
    pub fn same_checkpoint(&self, other: &Self) -> bool {
        self.model == other.model && self.model_sha256 == other.model_sha256
    }
}

/// One scored action in the stored ranking, with its raw Q value.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RankedAction {
    /// Mortal action name, e.g. `Discard_3m`, `Chi_Low`, `Pon`.
    pub action: String,
    /// The `legal_actions` label for the same action (call mapping source).
    pub label: String,
    /// Coarse action family.
    pub kind: ActionKind,
    /// Base tile code for tile actions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tile: Option<String>,
    /// Softmax probability over the legal actions.
    pub probability: f32,
    /// Raw model Q value, in [`Q_UNITS`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub q_value: Option<f32>,
}

/// The app's book label for the same snapshot, plus how Mortal agreed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BookLabel {
    /// Lesson id (`ScenarioId::as_str`).
    pub lesson: String,
    /// Answer-free note describing the rule cell.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub situation: Option<String>,
    /// The decision the lesson asks about.
    pub target_action: TargetAction,
    /// The book answer, recomputed from the visible table.
    pub correct_action: CorrectAction,
    /// Every tile the answer accepts (the named tile plus equivalents).
    pub accepted: Vec<String>,
    /// `single`, `agreement` or `mortal_tiebreak`.
    pub resolution: String,
    /// Lessons Mortal's tiebreak rejected, when it settled a conflict.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tiebreak_rejected: Vec<String>,
    /// The app's comparison of the book answer with the model's top action.
    pub agreement: BookAgreement,
}

/// Result of [`compare_action_set`] for a book label.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BookAgreement {
    /// `agrees`, `discrepancy` or `incomparable`.
    pub outcome: String,
    /// `expected_tile_wrong` / `expected_action_wrong` for a discrepancy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub discrepancy_kind: Option<String>,
    /// Mortal's action name for the book answer.
    pub book_action: String,
    /// Aggregated probability of the book answer (red-five variants summed).
    pub book_probability: f32,
    /// Mortal's top action.
    pub model_action: String,
    /// The model's top probability.
    pub model_probability: f32,
}

/// A book disagreement the model could not settle. The decision is not shipped.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BookConflict {
    /// The conflicting lessons, in classifier precedence order.
    pub lessons: Vec<String>,
}

/// One state's complete Mortal label, stored as JSON in the cache and on the
/// decision row.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelLabel {
    /// `riichiprac.model-label`.
    pub schema: String,
    /// Schema version.
    pub version: u32,
    /// Classifier generation used for the book half of the label.
    pub classifier_version: String,
    /// Labeler identity (the model that produced the Q values).
    pub model: String,
    /// Labeler checkpoint hash.
    pub model_sha256: String,
    /// Discount/placement configuration, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gamma: Option<f32>,
    /// Placement/rank utility weights, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pts: Option<Vec<f32>>,
    /// Units of [`Self::q_values`] and the gaps.
    pub q_units: String,
    /// Units of [`Self::expected_value`].
    pub value_units: String,
    /// Mortal's expected-value head for the position.
    pub expected_value: f32,
    /// The model's top action.
    pub top_action: String,
    /// Probability of the top action.
    pub top_probability: f32,
    /// `p(best) - p(second)`; `0.0` when the position offers one legal action.
    pub probability_margin: f32,
    /// `q(best) - q(second)`, in model-utility units; `None` with one action.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub q_gap_top2: Option<f32>,
    /// `q(best) - q(safest)`, in model-utility units; `None` without a threat or
    /// a legal discard the safety chart calls absolutely safe.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub q_gap_safe: Option<f32>,
    /// The action `q_gap_safe` was measured against, when one exists.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub safe_action: Option<String>,
    /// The discard the model declares Riichi on, from the second pass.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub riichi_discard: Option<String>,
    /// Every legal action, highest probability first, with raw Q values.
    pub ranking: Vec<RankedAction>,
    /// Raw Q value per action name, in model-utility units.
    ///
    /// One action name can cover several concrete actions (`Kan` has an ankan,
    /// a kakan and a daiminkan candidate), so this map keeps the highest Q for
    /// a repeated name; [`Self::ranking`] keeps every entry.
    #[serde(default)]
    pub q_values: BTreeMap<String, f32>,
    /// The book label, when a B1 classifier recognises the position.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub book: Option<BookLabel>,
    /// The book's unresolved disagreement, when it has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub book_conflict: Option<BookConflict>,
    /// What kind of drill the label produces (`book`, `contested`, `mortal`,
    /// `none`). Missing on a pre-L2 label; [`Self::kind`] derives it in that
    /// case.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label_kind: Option<LabelKind>,
    /// `stable`, `contested` or `unresolved` for a label with a book half.
    /// Missing on a pre-L2 label; [`Self::stability`] derives it in that case.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stability: Option<Stability>,
    /// Multi-model votes, present only when more than one checkpoint was
    /// evaluated. `None` for the default one-model pass: one model is not a
    /// consensus.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub consensus: Option<ModelConsensus>,
    /// Id of the Q→point calibration used for [`Self::expected_point_diffs`].
    /// Absent unless a calibration was explicitly applied.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calibration_version: Option<String>,
    /// Point estimates derived from a versioned calibration. Absent by default;
    /// the raw Q values beside it are never overwritten.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_point_diffs: Option<ExpectedPointDiffs>,
    /// The replay generator's identity, recorded only when it differs from the
    /// labeler's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generator: Option<ModelIdentity>,
    /// Unit reminder carried in the payload itself.
    pub note: String,
}

impl ModelLabel {
    /// True when the model and the replay generator are different checkpoints.
    #[must_use]
    pub fn generator_differs(&self) -> bool {
        self.generator.is_some()
    }

    /// The label kind, derived from the book/model parts when a pre-L2 payload
    /// did not store it.
    #[must_use]
    pub fn kind(&self) -> LabelKind {
        self.label_kind
            .unwrap_or_else(|| agreement::derive_label_kind(self))
    }

    /// The book/Mortal stability, derived from the book/model parts when a
    /// pre-L2 payload did not store it.
    #[must_use]
    pub fn stability(&self) -> Option<Stability> {
        self.stability.or_else(|| agreement::derive_stability(self))
    }

    /// Whether a candidate with this label may be shipped.
    ///
    /// A contested label is shippable as a dual verdict; an unresolved book
    /// conflict is not, because the book has no answer to grade.
    #[must_use]
    pub fn is_shippable(&self) -> bool {
        self.kind() != LabelKind::Unlabelled
    }

    /// The top-two gap used by [`thresholds`]: the Q gap when it exists, else
    /// the probability margin. `None` when the position offers one legal action.
    #[must_use]
    pub fn top2_gap(&self) -> Option<f32> {
        if self.ranking.len() < 2 {
            return None;
        }
        self.q_gap_top2.or(Some(self.probability_margin))
    }
}

/// Which optional analyses a label run records.
///
/// The defaults record everything L1 defines. The pair is part of the cache
/// key, so a run with a different option set never reuses another's labels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct LabelOptions {
    /// Keep the raw Q values and `q_gap_top2`.
    #[serde(default = "default_true")]
    pub q_values: bool,
    /// Compute `q_gap_safe`/`safe_action` from the book's safety chart.
    #[serde(default = "default_true")]
    pub safe_gap: bool,
}

const fn default_true() -> bool {
    true
}

impl Default for LabelOptions {
    fn default() -> Self {
        Self {
            q_values: true,
            safe_gap: true,
        }
    }
}

impl LabelOptions {
    /// Stable hash of the option set, used in the cache key.
    #[must_use]
    pub fn options_hash(&self) -> String {
        let bytes = serde_json::to_vec(self).expect("LabelOptions is plain booleans");
        sha256_hex(&bytes)
    }
}

/// Canonical hash of the model-visible position.
///
/// This is the SHA-256 of the v4 observation bytes — exactly what Mortal sees.
/// Scenario metadata (`category`, `correct_action`, rationale, notes) and the
/// display-only hand metrics are excluded on purpose: re-stamping a state,
/// settling a different lesson, or finding the same table position in another
/// replay must all reuse one cache entry. The derived shanten/wait inputs the
/// observation actually encodes stay in, because the network sees them.
#[must_use]
pub fn state_hash(state: &GameState) -> String {
    let observation = encode_v4_observation(state);
    let mut bytes = Vec::with_capacity(observation.len() * 4);
    for value in observation {
        bytes.extend_from_slice(&value.to_bits().to_le_bytes());
    }
    sha256_hex(&bytes)
}

/// Anything that can score one state. The real implementation is [`Labeler`];
/// tests use a canned evaluator so cache and label logic do not need weights.
pub trait StateEvaluator {
    /// The model identity recorded on every label.
    fn identity(&self) -> &ModelIdentity;

    /// Score one state, keeping raw Q values on every action.
    fn evaluate(&self, state: &GameState) -> Result<Evaluation, LabelError>;
}

/// A checkpoint loaded once per process and reused for every evaluation.
pub struct Labeler {
    model: MortalV4Model,
    identity: ModelIdentity,
}

impl Labeler {
    /// Load a `.safetensors` checkpoint and hash it for the label identity.
    ///
    /// The weights are parsed and bound a single time; [`StateEvaluator::evaluate`]
    /// only runs the forward pass.
    pub fn load(
        weights: &Path,
        gamma: Option<f32>,
        pts: Option<Vec<f32>>,
    ) -> Result<Self, LabelError> {
        let bytes = std::fs::read(weights).map_err(|source| LabelError::Weights {
            path: weights.display().to_string(),
            source,
        })?;
        let model_sha256 = sha256_hex(&bytes);
        let model_name = weights
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| "model.safetensors".to_string());

        let vb = VarBuilder::from_buffered_safetensors(bytes, DType::F32, &Device::Cpu).map_err(
            |err| LabelError::Model {
                path: weights.display().to_string(),
                message: err.to_string(),
            },
        )?;
        let model = MortalV4Model::new(vb).map_err(|err| LabelError::Model {
            path: weights.display().to_string(),
            message: err.to_string(),
        })?;

        Ok(Self {
            model,
            identity: ModelIdentity {
                model: model_name,
                model_sha256,
                gamma,
                pts,
            },
        })
    }

    /// The loaded model, for callers that also need the raw network.
    #[must_use]
    pub fn model(&self) -> &MortalV4Model {
        &self.model
    }
}

impl StateEvaluator for Labeler {
    fn identity(&self) -> &ModelIdentity {
        &self.identity
    }

    fn evaluate(&self, state: &GameState) -> Result<Evaluation, LabelError> {
        evaluate_state_with_q_values(&self.model, state, &self.identity.model)
            .map_err(|err| LabelError::Evaluation(err.to_string()))
    }
}

/// How a decision was labelled, and whether the cache already had it.
#[derive(Debug, Clone, PartialEq)]
pub enum LabelDisposition {
    /// The cache held a finished label; no forward pass ran.
    Cached(ModelLabel),
    /// A first evaluation.
    Labelled(ModelLabel),
    /// A previously failed key that succeeded on this attempt.
    Retried(ModelLabel),
}

impl LabelDisposition {
    /// The label, whichever path produced it.
    #[must_use]
    pub fn label(&self) -> &ModelLabel {
        match self {
            Self::Cached(label) | Self::Labelled(label) | Self::Retried(label) => label,
        }
    }

    /// The label, consuming the disposition.
    #[must_use]
    pub fn into_label(self) -> ModelLabel {
        match self {
            Self::Cached(label) | Self::Labelled(label) | Self::Retried(label) => label,
        }
    }
}

/// Label one snapshot through the cache.
///
/// - A finished (`ok`) cache row is returned without evaluating.
/// - A missing row is evaluated, labelled, recorded and reported as
///   [`LabelDisposition::Labelled`].
/// - A `failed` row is retried; success is recorded and reported as
///   [`LabelDisposition::Retried`], and another failure updates the error and
///   attempt count.
///
/// `generator` is the replay's generator identity when the provenance row is
/// known; it is recorded only when it differs from the labeler's.
pub fn label_decision(
    cache: &LabelCache<'_>,
    evaluator: &dyn StateEvaluator,
    snapshot: &DecisionSnapshot,
    options: &LabelOptions,
    classifier_version: &str,
    generator: Option<&ModelIdentity>,
) -> Result<LabelDisposition, LabelError> {
    let key = LabelKey::new(
        &snapshot.state,
        evaluator.identity(),
        classifier_version,
        options,
    );

    let lookup = cache.lookup(&key)?;
    if let CacheLookup::Hit(label) = &lookup {
        return Ok(LabelDisposition::Cached(label.as_ref().clone()));
    }
    let retrying = matches!(lookup, CacheLookup::Failed { .. });

    match evaluate_and_label(evaluator, snapshot, options, classifier_version, generator) {
        Ok(label) => {
            cache.record_success(&key, &label)?;
            Ok(if retrying {
                LabelDisposition::Retried(label)
            } else {
                LabelDisposition::Labelled(label)
            })
        }
        Err(err) => {
            cache.record_failure(&key, &err.to_string())?;
            Err(err)
        }
    }
}

/// Evaluate a snapshot and build its complete label document.
///
/// The book half goes through
/// [`crate::miner::classifier::classify_decision_with_mortal`], so the Mortal
/// tiebreak and the furiten reject policy are the miner's existing rules. A
/// book disagreement the model cannot settle is recorded as
/// [`ModelLabel::book_conflict`]; the caller must not ship that decision.
pub fn build_label(
    evaluator: &dyn StateEvaluator,
    snapshot: &DecisionSnapshot,
    options: &LabelOptions,
    classifier_version: &str,
    generator: Option<&ModelIdentity>,
) -> Result<ModelLabel, LabelError> {
    let identity = evaluator.identity();
    let evaluation = evaluator.evaluate(&snapshot.state)?;
    let label = assemble_label(
        &snapshot.state,
        snapshot,
        &evaluation,
        identity,
        options,
        classifier_version,
        generator,
    )?;
    Ok(label)
}

fn evaluate_and_label(
    evaluator: &dyn StateEvaluator,
    snapshot: &DecisionSnapshot,
    options: &LabelOptions,
    classifier_version: &str,
    generator: Option<&ModelIdentity>,
) -> Result<ModelLabel, LabelError> {
    build_label(evaluator, snapshot, options, classifier_version, generator)
}

/// Build the label document from one evaluation (no forward pass).
fn assemble_label(
    state: &GameState,
    snapshot: &DecisionSnapshot,
    evaluation: &Evaluation,
    identity: &ModelIdentity,
    options: &LabelOptions,
    classifier_version: &str,
    generator: Option<&ModelIdentity>,
) -> Result<ModelLabel, LabelError> {
    let mut ranking: Vec<RankedAction> = Vec::with_capacity(evaluation.evaluations.len());
    let mut q_values = BTreeMap::new();
    for scored in &evaluation.evaluations {
        if options.q_values && scored.q_value.is_none() {
            return Err(LabelError::MissingQValue(scored.info.action.clone()));
        }
        if let Some(q) = scored.q_value {
            q_values
                .entry(scored.info.action.clone())
                .and_modify(|existing: &mut f32| *existing = existing.max(q))
                .or_insert(q);
        }
        ranking.push(RankedAction {
            action: scored.info.action.clone(),
            label: scored.info.label.clone(),
            kind: scored.info.kind,
            tile: scored.info.tile.clone(),
            probability: scored.probability,
            q_value: scored.q_value,
        });
    }
    if ranking.is_empty() {
        return Err(LabelError::Evaluation(
            "the evaluation scored no legal action".to_string(),
        ));
    }

    let top = &ranking[0];
    let probability_margin = ranking
        .get(1)
        .map_or(0.0, |second| top.probability - second.probability);
    let q_gap_top2 = if options.q_values {
        match (
            top.q_value,
            ranking.get(1).and_then(|second| second.q_value),
        ) {
            (Some(best), Some(second)) => Some(best - second),
            _ => None,
        }
    } else {
        None
    };
    let safe = if options.q_values && options.safe_gap {
        safest_discard(state, evaluation)
    } else {
        None
    };
    let (safe_action, q_gap_safe) = match (safe, top.q_value) {
        (Some((action, q)), Some(best)) => (Some(action), Some(best - q)),
        _ => (None, None),
    };

    let (book, book_conflict) =
        match crate::miner::classifier::classify_decision_with_mortal(snapshot, evaluation) {
            Ok(Some(label)) => (Some(book_label(state, evaluation, label)), None),
            Ok(None) => (None, None),
            Err(conflict) => (
                None,
                Some(BookConflict {
                    lessons: conflict
                        .lessons()
                        .iter()
                        .map(|lesson| lesson.as_str().to_string())
                        .collect(),
                }),
            ),
        };

    let generator = generator
        .filter(|other| !identity.same_checkpoint(other))
        .cloned();

    let mut label = ModelLabel {
        schema: MODEL_LABEL_SCHEMA.to_string(),
        version: super::JSON_SCHEMA_VERSION,
        classifier_version: classifier_version.to_string(),
        model: identity.model.clone(),
        model_sha256: identity.model_sha256.clone(),
        gamma: identity.gamma,
        pts: identity.pts.clone(),
        q_units: Q_UNITS.to_string(),
        value_units: VALUE_UNITS.to_string(),
        expected_value: evaluation.expected_value,
        top_action: top.action.clone(),
        top_probability: top.probability,
        probability_margin,
        q_gap_top2,
        q_gap_safe,
        safe_action,
        riichi_discard: evaluation.riichi_discard.clone(),
        ranking,
        q_values,
        book,
        book_conflict,
        label_kind: None,
        stability: None,
        consensus: None,
        calibration_version: None,
        expected_point_diffs: None,
        generator,
        note: Q_UNITS_NOTE.to_string(),
    };
    refresh_agreement(&mut label);
    Ok(label)
}

/// Fill in the derived agreement fields after the book half or a multi-model
/// consensus changed.
fn refresh_agreement(label: &mut ModelLabel) {
    label.label_kind = Some(agreement::derive_label_kind(label));
    label.stability = agreement::derive_stability(label);
}

/// Evaluate a state with more than one checkpoint and record every vote.
///
/// This is the optional multi-model path (replay-implementation-plan §5.3). The
/// first evaluator is the primary labeler: its Q values, ranking, gaps and book
/// comparison are the label, and the remaining checkpoints only contribute a
/// [`ModelVote`] each. Two or more members produce a [`ModelConsensus`]; a
/// disagreement marks the label `contested` rather than silently preferring the
/// primary. With one evaluator this is exactly [`build_label`] and the consensus
/// field stays absent — one checkpoint is never called an ensemble.
///
/// This path deliberately does not write the label cache: the L1 cache key is
/// one checkpoint's identity, and a consensus needs a labeler-set key that no
/// current pipeline uses. A multi-model pass is a separate analysis run.
pub fn build_label_with_models(
    evaluators: &[&dyn StateEvaluator],
    snapshot: &DecisionSnapshot,
    options: &LabelOptions,
    classifier_version: &str,
    generator: Option<&ModelIdentity>,
) -> Result<ModelLabel, LabelError> {
    let Some((primary, rest)) = evaluators.split_first() else {
        return Err(LabelError::Evaluation(
            "no labeler was supplied to the multi-model pass".to_string(),
        ));
    };
    let primary_evaluation = primary.evaluate(&snapshot.state)?;
    let mut label = assemble_label(
        &snapshot.state,
        snapshot,
        &primary_evaluation,
        primary.identity(),
        options,
        classifier_version,
        generator,
    )?;

    if rest.is_empty() {
        return Ok(label);
    }

    let mut votes = Vec::with_capacity(evaluators.len());
    votes.push(agreement::vote_for(
        primary.identity(),
        &primary_evaluation,
        &snapshot.state,
        label.book.as_ref(),
    ));
    for evaluator in rest {
        let evaluation = evaluator.evaluate(&snapshot.state)?;
        votes.push(agreement::vote_for(
            evaluator.identity(),
            &evaluation,
            &snapshot.state,
            label.book.as_ref(),
        ));
    }
    label.consensus = ModelConsensus::from_votes(votes);
    refresh_agreement(&mut label);
    Ok(label)
}

/// Turn a settled classifier label into the stored book half.
fn book_label(
    state: &GameState,
    evaluation: &Evaluation,
    label: crate::classifier::Label,
) -> BookLabel {
    let legal = legal_action_mask(state);
    let comparison = compare_action_set(
        &label.matched.correct_action,
        &label.matched.equivalent_tiles,
        evaluation,
        &legal,
    );
    let (resolution, tiebreak_rejected) = match &label.resolution {
        Resolution::Single => ("single".to_string(), Vec::new()),
        Resolution::Agreement => ("agreement".to_string(), Vec::new()),
        Resolution::MortalTiebreak { rejected } => (
            "mortal_tiebreak".to_string(),
            rejected
                .iter()
                .map(|lesson| lesson.as_str().to_string())
                .collect(),
        ),
    };
    BookLabel {
        lesson: label.matched.lesson.as_str().to_string(),
        situation: label.matched.situation.clone(),
        target_action: label.matched.target_action,
        correct_action: label.matched.correct_action.clone(),
        accepted: label.matched.answer_set(),
        resolution,
        tiebreak_rejected,
        agreement: BookAgreement {
            outcome: outcome_name(comparison.outcome).to_string(),
            discrepancy_kind: comparison.kind.map(|kind| kind.as_str().to_string()),
            book_action: comparison.app_action,
            book_probability: comparison.app_probability,
            model_action: comparison.ai_action,
            model_probability: comparison.ai_probability,
        },
    }
}

fn outcome_name(outcome: FuzzOutcome) -> &'static str {
    match outcome {
        FuzzOutcome::Agrees => "agrees",
        FuzzOutcome::Discrepancy => "discrepancy",
        FuzzOutcome::Incomparable => "incomparable",
    }
}

/// The highest-Q legal discard that the book's chart calls absolutely safe.
///
/// Every opponent in Riichi is a threat; a tile must be safe against all of
/// them. This is deliberately not "the safest-looking tile Mortal likes": the
/// safety rank comes from [`SafetyFacts`], and the Q value only breaks ties
/// between safe candidates. Returns `None` when no opponent is in Riichi, when
/// the safety facts cannot be built, or when no legal discard is absolutely
/// safe.
#[must_use]
pub fn safest_discard(state: &GameState, evaluation: &Evaluation) -> Option<(String, f32)> {
    let threats: Vec<SafetyFacts> = state
        .players
        .iter()
        .filter(|player| !player.is_human && player.is_riichi)
        .filter_map(|player| SafetyFacts::from_state(state, player.seat))
        .collect();
    if threats.is_empty() {
        return None;
    }

    let mut best: Option<(String, f32)> = None;
    for scored in &evaluation.evaluations {
        if scored.info.kind != ActionKind::Discard {
            continue;
        }
        let Some(code) = &scored.info.tile else {
            continue;
        };
        let Ok(tile) = SafetyTile::try_from(code.as_str()) else {
            continue;
        };
        if !threats.iter().all(|facts| facts.is_absolutely_safe(tile)) {
            continue;
        }
        let Some(q) = scored.q_value else {
            continue;
        };
        match &best {
            Some((_, best_q)) if *best_q >= q => {}
            _ => best = Some((scored.info.action.clone(), q)),
        }
    }
    best
}

#[cfg(test)]
mod tests;
