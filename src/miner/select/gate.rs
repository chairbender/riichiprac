//! The eight hard gates from replay-strategy §7.1 (implementation unit S2).
//!
//! A candidate is not shippable unless **all** of these hold:
//!
//! 1. legal and reachable state ([`GateKind::Reachable`]);
//! 2. the answer is well defined ([`GateKind::AnswerDefined`]);
//! 3. the answer is legal on this state ([`GateKind::AnswerLegal`]);
//! 4. visible information suffices ([`GateKind::VisibleInformation`]);
//! 5. the label is confident enough ([`GateKind::LabelConfidence`]);
//! 6. source, licence and provenance pass ([`GateKind::Provenance`]);
//! 7. the state is not a duplicate ([`GateKind::Duplicate`], in
//!    [`super::dedupe`] because it depends on the pack's contents);
//! 8. the pre-answer text does not spoil the answer ([`GateKind::Spoiler`]).
//!
//! The gates are sequential and **fail closed**: the first failure is returned,
//! and a caller that cannot name the answer never reaches "is the answer legal".
//! That keeps the funnel's rejection counts honest (one candidate, one first
//! failure) without hiding the full gate order.
//!
//! # Gate 1 does not re-run the walker's search
//!
//! `walk_path` already drops a decision whose snapshot fails
//! `validate_reachable_state` (R2). A shard run therefore passes
//! `validated_reachable: true` and gate 1 checks the cheap invariants only
//! (non-empty legal set, tile ledger implied by a walked state). A candidate
//! built by hand — a fixture or a future importer — leaves the flag `false` and
//! the gate runs the full validator itself.
//!
//! # Gate 4 is a concrete redaction test
//!
//! "Hidden-hand facts may validate the scenario but must not be required to
//! solve it." The gate clones the state with every opponent's concealed hand
//! and draw removed, then requires that
//!
//! - the model-visible hash is unchanged (Mortal did not see the hidden
//!   tiles), and
//! - the answer's action is still in the redacted legal set (the drill can be
//!   answered from the table), and
//! - a tile answer is in the actor's own hand or draw.
//!
//! # Gate 8 is the programmatic part of the spoiler rule
//!
//! It rejects a pre-answer text that contains an accepted answer tile or a
//! waiting tile (for example "the wait was 3p"). It cannot judge whether
//! prose hints at the answer, so a human review still reads the queue; the gate
//! is a floor, not a substitute (§7.5).

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::ai::actions::legal_actions;
use crate::ai::finalize::normalize_mortal_action;
use crate::miner::label::ModelLabel;
use crate::miner::label::state_hash;
use crate::miner::label::thresholds::{Band, PercentileCuts};
use crate::replay::walk::DecisionSnapshot;
use crate::state::{CorrectAction, GameState};

use super::ReplayFacts;
use super::SelectionConfig;

/// The eight §7.1 gates. Declaration order is gate order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GateKind {
    /// The state is legal and reachable.
    Reachable,
    /// The answer is well defined.
    AnswerDefined,
    /// The answer is legal on the state.
    AnswerLegal,
    /// The answer is derivable from visible information.
    VisibleInformation,
    /// The label is confident enough to be a "best" answer.
    LabelConfidence,
    /// Source, licence and provenance pass.
    Provenance,
    /// The state is new to the pack.
    Duplicate,
    /// The pre-answer text does not name the answer.
    Spoiler,
}

impl GateKind {
    /// Every gate, in gate order.
    pub const ALL: [Self; 8] = [
        Self::Reachable,
        Self::AnswerDefined,
        Self::AnswerLegal,
        Self::VisibleInformation,
        Self::LabelConfidence,
        Self::Provenance,
        Self::Duplicate,
        Self::Spoiler,
    ];

    /// The report/JSON spelling.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Reachable => "reachable",
            Self::AnswerDefined => "answer_defined",
            Self::AnswerLegal => "answer_legal",
            Self::VisibleInformation => "visible_information",
            Self::LabelConfidence => "label_confidence",
            Self::Provenance => "provenance",
            Self::Duplicate => "duplicate",
            Self::Spoiler => "spoiler",
        }
    }
}

impl std::fmt::Display for GateKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One gate's rejection, with a stable reason code and a short explanation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GateFailure {
    /// Which gate rejected the candidate.
    pub gate: GateKind,
    /// Stable reason code, e.g. `no_label` or `duplicate_near`.
    pub code: String,
    /// Short, answer-free explanation for the report.
    pub detail: String,
}

impl GateFailure {
    /// Build a failure.
    #[must_use]
    pub fn new(gate: GateKind, code: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            gate,
            code: code.into(),
            detail: detail.into(),
        }
    }
}

/// Everything the gates read about one decision.
pub struct GateInput<'a> {
    /// The reconstructed decision.
    pub snapshot: &'a DecisionSnapshot,
    /// The cached L2/L1 label, when one exists.
    pub label: Option<&'a ModelLabel>,
    /// The answer the selector would ship, when the label defines one.
    pub answer: Option<&'a CorrectAction>,
    /// Every tile the answer accepts (the named tile plus equivalents).
    pub accepted: &'a [String],
    /// Whether the walker already validated reachability for this decision.
    pub validated_reachable: bool,
    /// Source/licence/provenance facts for the replay.
    pub facts: &'a ReplayFacts,
    /// Answer-free text the trainee would see before answering.
    pub pre_answer_texts: &'a [String],
    /// Selection thresholds.
    pub config: &'a SelectionConfig,
    /// The sample's top-two-gap cuts, for gate 5.
    pub confidence_cuts: &'a PercentileCuts,
}

/// Run the gates in order; the first failure rejects the candidate.
#[must_use]
pub fn evaluate(input: &GateInput<'_>) -> Option<GateFailure> {
    if let Some(failure) = reachable(input) {
        return Some(failure);
    }
    if let Some(failure) = answer_defined(input) {
        return Some(failure);
    }
    if let Some(failure) = answer_legal(input) {
        return Some(failure);
    }
    if let Some(failure) = visible_information(input) {
        return Some(failure);
    }
    if let Some(failure) = label_confidence(input) {
        return Some(failure);
    }
    if let Some(failure) = provenance(input) {
        return Some(failure);
    }
    spoiler(input)
}

fn reachable(input: &GateInput<'_>) -> Option<GateFailure> {
    if input.snapshot.state.players.len() != 4 {
        return Some(GateFailure::new(
            GateKind::Reachable,
            "table_shape",
            format!(
                "{} player(s) at the table, expected four",
                input.snapshot.state.players.len()
            ),
        ));
    }
    if input.snapshot.legal_actions.is_empty() {
        return Some(GateFailure::new(
            GateKind::Reachable,
            "no_legal_action",
            "the state offers no legal action",
        ));
    }
    if !input.validated_reachable
        && let Err(reason) = crate::generator::support::state_validation::validate_reachable_state(
            &input.snapshot.state,
        )
    {
        return Some(GateFailure::new(GateKind::Reachable, "unreachable", reason));
    }
    None
}

fn answer_defined(input: &GateInput<'_>) -> Option<GateFailure> {
    let Some(label) = input.label else {
        return Some(GateFailure::new(
            GateKind::AnswerDefined,
            "no_label",
            "the decision has no cached book or Mortal label",
        ));
    };
    if !label.is_shippable() {
        return Some(GateFailure::new(
            GateKind::AnswerDefined,
            "unresolved_label",
            "the label is unresolved: no book answer and no Mortal answer",
        ));
    }
    if label.book_conflict.is_some() {
        return Some(GateFailure::new(
            GateKind::AnswerDefined,
            "book_conflict",
            "two book rules disagree and no model settled it",
        ));
    }
    let Some(answer) = input.answer else {
        return Some(GateFailure::new(
            GateKind::AnswerDefined,
            "no_answer",
            "the label names no shippable answer",
        ));
    };
    if label.book.is_some() && answer.tile().is_some() && input.accepted.is_empty() {
        return Some(GateFailure::new(
            GateKind::AnswerDefined,
            "empty_answer_set",
            "the book label names a tile but accepts none",
        ));
    }
    if label.book.is_none() && input.snapshot.legal_actions.len() < 2 {
        return Some(GateFailure::new(
            GateKind::AnswerDefined,
            "no_choice",
            format!(
                "a Mortal-only drill needs a choice; the state offers one legal action ({:?})",
                answer.action_type()
            ),
        ));
    }
    None
}

fn answer_legal(input: &GateInput<'_>) -> Option<GateFailure> {
    let Some(answer) = input.answer else {
        return Some(GateFailure::new(
            GateKind::AnswerLegal,
            "no_answer",
            "no answer to check",
        ));
    };
    if let Err((code, detail)) = check_answer_legal(&input.snapshot.state, answer, input.accepted) {
        return Some(GateFailure::new(GateKind::AnswerLegal, code, detail));
    }
    None
}

/// Verify that `answer` is a legal, clickable action on `state`.
///
/// This mirrors [`crate::classifier::Match::validate`] for the book answers and
/// the labeler's action vocabulary for a Mortal answer: a discard (or the
/// discard under a Riichi/dama/fold answer) must be a legal hand discard, a Kan
/// must be an offered kan, a Pass must be a legal reaction, and a Riichi must be
/// legal. Equivalents must be legal discards too.
pub fn check_answer_legal(
    state: &GameState,
    answer: &CorrectAction,
    accepted: &[String],
) -> Result<(), (String, String)> {
    let legal = legal_actions(state);
    let discard_is_legal = |tile: &str| {
        legal.iter().any(|info| {
            info.kind == crate::decision::ActionKind::Discard && info.tile.as_deref() == Some(tile)
        })
    };
    let illegal_discard = |tile: &str| {
        (
            "answer_not_in_hand".to_string(),
            format!("`{tile}` is not a legal discard on this table"),
        )
    };
    let missing = |what: &str| {
        (
            "answer_not_offered".to_string(),
            format!("the table offers no legal {what}"),
        )
    };

    match answer {
        CorrectAction::Riichi { discard } => {
            if !legal
                .iter()
                .any(|info| info.kind == crate::decision::ActionKind::Riichi)
            {
                return Err(missing("Riichi"));
            }
            if !discard_is_legal(discard) {
                return Err(illegal_discard(discard));
            }
        }
        CorrectAction::Dama { discard }
        | CorrectAction::Fold { discard }
        | CorrectAction::Discard { tile: discard } => {
            if !discard_is_legal(discard) {
                return Err(illegal_discard(discard));
            }
        }
        CorrectAction::Kan { tile } => {
            if !legal.iter().any(|info| {
                info.kind == crate::decision::ActionKind::Kan
                    && (info.tile.as_deref() == Some(tile) || info.tile.is_none())
            }) {
                return Err(missing("Kan"));
            }
        }
        CorrectAction::Pass => {
            if !legal
                .iter()
                .any(|info| info.kind == crate::decision::ActionKind::Pass)
            {
                return Err(missing("Pass"));
            }
        }
        CorrectAction::Best { action, tile, .. } => {
            let wanted = normalize_mortal_action(action);
            if wanted == "Riichi" {
                if !legal
                    .iter()
                    .any(|info| info.kind == crate::decision::ActionKind::Riichi)
                {
                    return Err(missing("Riichi"));
                }
                if let Some(tile) = tile.as_deref()
                    && !discard_is_legal(tile)
                {
                    return Err(illegal_discard(tile));
                }
            } else if let Some(base) = wanted.strip_prefix("Discard_") {
                if !discard_is_legal(base) {
                    return Err(illegal_discard(base));
                }
            } else if !legal.iter().any(|info| {
                normalize_mortal_action(&info.action) == wanted
                    && tile
                        .as_deref()
                        .is_none_or(|tile| info.tile.as_deref() == Some(tile))
            }) {
                return Err(missing(&wanted));
            }
        }
    }

    // `accepted` lists the tiles a *discard* answer accepts. A call answer's
    // tile is the offered discard, which the actor does not hold, so it is not
    // checked as a legal hand discard.
    if answer_discard_tile(answer).is_some() {
        for tile in accepted {
            if !discard_is_legal(tile) {
                return Err((
                    "equivalent_not_in_hand".to_string(),
                    format!("accepted tile `{tile}` is not a legal discard on this table"),
                ));
            }
        }
    }
    Ok(())
}

fn visible_information(input: &GateInput<'_>) -> Option<GateFailure> {
    let state = &input.snapshot.state;
    let Some(answer) = input.answer else {
        return Some(GateFailure::new(
            GateKind::VisibleInformation,
            "no_answer",
            "no answer to check",
        ));
    };

    // Redact everything the trainee cannot see: opponent concealed tiles and
    // the post-answer ura indicators.
    let mut redacted = state.clone();
    for player in redacted.players.iter_mut().skip(1) {
        player.hand.clear();
        player.draw = None;
    }
    redacted.ura_dora_indicators.clear();
    if state_hash(&redacted) != state_hash(state) {
        return Some(GateFailure::new(
            GateKind::VisibleInformation,
            "model_sees_hidden_tiles",
            "the model-visible state changes when hidden hands are removed",
        ));
    }

    if let Err((code, detail)) = check_answer_legal(&redacted, answer, input.accepted) {
        return Some(GateFailure::new(
            GateKind::VisibleInformation,
            format!("hidden_{code}"),
            format!("the answer is not available from visible information: {detail}"),
        ));
    }

    // Only a discard-family answer must be a tile the actor visibly holds; a
    // call answer's tile belongs to the discarder's river.
    if let Some(tile) = answer_discard_tile(answer)
        && !actor_holds(state, tile)
    {
        return Some(GateFailure::new(
            GateKind::VisibleInformation,
            "answer_not_visible",
            format!("the answer tile `{tile}` is not in the actor's hand or draw"),
        ));
    }
    None
}

/// The discard a discard-family answer names, or `None`.
///
/// A Riichi/dama/fold/discard answer, and a Mortal `Discard_*` or `Riichi`
/// action, name a tile the actor must hold. A call, kan, pass or win answer does
/// not.
#[must_use]
pub fn answer_discard_tile(answer: &CorrectAction) -> Option<&str> {
    match answer {
        CorrectAction::Riichi { discard }
        | CorrectAction::Dama { discard }
        | CorrectAction::Fold { discard }
        | CorrectAction::Discard { tile: discard } => Some(discard),
        CorrectAction::Best { action, tile, .. } => {
            let wanted = normalize_mortal_action(action);
            (wanted.starts_with("Discard_") || wanted == "Riichi")
                .then_some(tile.as_deref())
                .flatten()
        }
        CorrectAction::Kan { .. } | CorrectAction::Pass => None,
    }
}

fn actor_holds(state: &GameState, tile: &str) -> bool {
    state.players.first().is_some_and(|player| {
        player.hand.iter().any(|held| held == tile)
            || player.draw.as_deref() == Some(tile)
            || player
                .melds
                .iter()
                .any(|meld| meld.tiles.iter().any(|held| held == tile))
    })
}

fn label_confidence(input: &GateInput<'_>) -> Option<GateFailure> {
    let Some(label) = input.label else {
        return Some(GateFailure::new(
            GateKind::LabelConfidence,
            "no_label",
            "no label to measure",
        ));
    };
    // A book match is exact by definition: the rule names the answer (up to
    // `equivalent_tiles`). A contested label carries the book answer and the
    // model's disagreement; it ships as a dual verdict, not as a coin flip.
    if label.book.is_some() {
        return None;
    }
    if let Some(gap) = label.top2_gap()
        && let Some(band) = input.confidence_cuts.band(
            &crate::miner::label::thresholds::DecisionFamily::of(input.snapshot).key(),
            gap,
        )
        && band == Band::Confident
    {
        return None;
    }
    if label.top_probability >= input.config.min_top_probability
        && label.probability_margin >= input.config.min_probability_margin
    {
        return None;
    }
    Some(GateFailure::new(
        GateKind::LabelConfidence,
        "label_unconfident",
        format!(
            "Mortal top-1 p={:.3} (margin {:.3}) is below the confidence gate and the family \
             sample has no confident cut",
            label.top_probability, label.probability_margin
        ),
    ))
}

fn provenance(input: &GateInput<'_>) -> Option<GateFailure> {
    let facts = input.facts;
    if !facts.row_present {
        return Some(GateFailure::new(
            GateKind::Provenance,
            "no_replay_row",
            facts
                .provenance_detail
                .clone()
                .unwrap_or_else(|| "no `replays` row for this file".to_string()),
        ));
    }
    if !facts.source_ok {
        return Some(GateFailure::new(
            GateKind::Provenance,
            "source_not_selfplay",
            format!(
                "source `{}` is not `ai_selfplay`",
                facts.source.as_deref().unwrap_or("missing")
            ),
        ));
    }
    if !facts.licence_ok {
        return Some(GateFailure::new(
            GateKind::Provenance,
            "licence_not_allowed",
            format!(
                "data licence `{}` is not on the allowlist",
                facts.licence.as_deref().unwrap_or("missing")
            ),
        ));
    }
    if !facts.provenance_ok {
        return Some(GateFailure::new(
            GateKind::Provenance,
            "provenance_incomplete",
            facts
                .provenance_detail
                .clone()
                .unwrap_or_else(|| "the game's provenance record did not validate".to_string()),
        ));
    }
    if !facts.validation_ok {
        return Some(GateFailure::new(
            GateKind::Provenance,
            "validation_not_publishable",
            "the replay's validation summary is not publishable".to_string(),
        ));
    }
    None
}

fn spoiler(input: &GateInput<'_>) -> Option<GateFailure> {
    let mut secrets: BTreeSet<&str> = BTreeSet::new();
    for tile in input.accepted {
        secrets.insert(tile.as_str());
    }
    for tile in &input.snapshot.waits {
        secrets.insert(tile.as_str());
    }
    for text in input.pre_answer_texts {
        for secret in &secrets {
            if contains_token(text, secret) {
                return Some(GateFailure::new(
                    GateKind::Spoiler,
                    "answer_in_text",
                    format!("pre-answer text contains the tile `{secret}`"),
                ));
            }
        }
    }
    None
}

/// True when `text` contains `token` as a standalone alphanumeric word.
///
/// Tile codes are two characters (`3p`), so a plain substring search would flag
/// an unrelated longer token; splitting on non-alphanumerics avoids that.
#[must_use]
pub fn contains_token(text: &str, token: &str) -> bool {
    text.split(|ch: char| !ch.is_ascii_alphanumeric())
        .any(|word| word == token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_gate_has_a_stable_code() {
        for gate in GateKind::ALL {
            assert_eq!(
                GateKind::ALL.iter().filter(|other| **other == gate).count(),
                1
            );
            assert!(!gate.as_str().is_empty());
            assert_eq!(gate.to_string(), gate.as_str());
        }
        assert_eq!(GateKind::ALL.len(), 8);
    }

    #[test]
    fn token_matching_does_not_flag_longer_words() {
        assert!(contains_token("Discard 3p now", "3p"));
        assert!(contains_token("wait=3p;", "3p"));
        assert!(!contains_token("13px", "3p"));
        assert!(!contains_token("the 3pin tile", "3p"));
        assert!(!contains_token("", "3p"));
    }
}
