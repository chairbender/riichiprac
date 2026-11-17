//! Per-scenario pack checks: state reachability, legal and accepted answers,
//! spoilers, unit sanity and variant honesty.
//!
//! These are the checks that do not need the corpus provenance or the encoded
//! byte size; [`super::gate::audit_pack`] runs them together with the
//! source/licence/provenance gate and the budget.

use std::collections::BTreeSet;

use crate::ai::actions::legal_actions;
use crate::decision::ActionKind;
use crate::generator::support::state_validation::validate_reachable_state;
use crate::miner::provenance::is_sha256_hex;
use crate::miner::transform::Transform;
use crate::miner::{Q_UNITS, VALUE_UNITS};
use crate::state::{CorrectAction, GameState};

use super::gate::{PackFinding, PackFindingCode};
use super::model::{PackScenario, PlayedKind};

/// The accepted-set token for a non-tile answer (`Pass`).
pub const PASS_ANSWER: &str = "pass";

/// The canonical accepted set for a state: the answer tile (or action name)
/// plus every `equivalent_tiles` entry, sorted and deduplicated.
#[must_use]
pub fn accepted_for(state: &GameState) -> Vec<String> {
    let mut accepted: Vec<String> = match &state.correct_action {
        CorrectAction::Pass => vec![PASS_ANSWER.to_string()],
        CorrectAction::Best { action, tile, .. } => match tile {
            Some(tile) => vec![tile.clone()],
            None => vec![action.clone()],
        },
        other => other.tile().map(str::to_string).into_iter().collect(),
    };
    if state.correct_action.tile().is_some() {
        accepted.extend(state.equivalent_tiles.iter().cloned());
    }
    accepted.sort();
    accepted.dedup();
    accepted
}

/// Run every checker that only needs the scenario itself.
#[must_use]
pub fn check_scenario(scenario: &PackScenario) -> Vec<PackFinding> {
    let mut findings = Vec::new();

    if scenario.title.trim().is_empty() {
        findings.push(PackFinding::scenario(
            PackFindingCode::EmptyField,
            scenario.id.as_str(),
            "`title` is empty",
        ));
    }
    if scenario.prompt.trim().is_empty() {
        findings.push(PackFinding::scenario(
            PackFindingCode::EmptyField,
            scenario.id.as_str(),
            "`prompt` is empty",
        ));
    }
    if scenario.lesson_id.trim().is_empty() {
        findings.push(PackFinding::scenario(
            PackFindingCode::EmptyField,
            scenario.id.as_str(),
            "`lesson_id` is empty",
        ));
    } else if scenario.state.category != scenario.lesson_id {
        findings.push(PackFinding::scenario(
            PackFindingCode::LessonMismatch,
            scenario.id.as_str(),
            format!(
                "lesson_id `{}` does not match the state's category `{}`",
                scenario.lesson_id, scenario.state.category
            ),
        ));
    }

    if let Some(book) = &scenario.book {
        let expected = format!("ch{}.{}", book.chapter, book.section);
        if book.key != expected || book.label.trim().is_empty() {
            findings.push(PackFinding::scenario(
                PackFindingCode::BookKeyMismatch,
                scenario.id.as_str(),
                format!(
                    "book `{}`/`{}` does not describe chapter {} section {}",
                    book.key, book.label, book.chapter, book.section
                ),
            ));
        }
    }

    if scenario.correct_action != scenario.state.correct_action {
        findings.push(PackFinding::scenario(
            PackFindingCode::AnswerMismatch,
            scenario.id.as_str(),
            "the scenario's `correct_action` differs from the state's own answer",
        ));
    }

    let expected_accepted = accepted_for(&scenario.state);
    if scenario.accepted.is_empty() {
        findings.push(PackFinding::scenario(
            PackFindingCode::AcceptedEmpty,
            scenario.id.as_str(),
            "`accepted` is empty",
        ));
    } else if scenario.accepted != expected_accepted {
        findings.push(PackFinding::scenario(
            PackFindingCode::AcceptedMismatch,
            scenario.id.as_str(),
            format!(
                "`accepted` is {:?}, expected {:?} (the answer plus the state's equivalent tiles, sorted)",
                scenario.accepted, expected_accepted
            ),
        ));
    }

    findings.extend(check_legal_answer(scenario));
    findings.extend(check_state(scenario));
    if let Some(spoiler) = find_spoiler(scenario) {
        findings.push(spoiler);
    }
    findings.extend(check_variant(scenario));
    findings.extend(check_units(scenario));
    if scenario.played.as_ref().is_some_and(|played| {
        played.kind == PlayedKind::Human
            || (played.kind == PlayedKind::Ai
                && played
                    .agent
                    .as_deref()
                    .map(str::trim)
                    .unwrap_or("")
                    .is_empty())
    }) {
        findings.push(PackFinding::scenario(
            PackFindingCode::PlayedActionInvalid,
            scenario.id.as_str(),
            "a played action must be an AI action with an agent id",
        ));
    }
    findings
}

/// The answer has to be an action the state itself offers.
fn check_legal_answer(scenario: &PackScenario) -> Vec<PackFinding> {
    let mut findings = Vec::new();
    let state = &scenario.state;
    let legal = legal_actions(state);
    let discard_is_legal = |tile: &str| {
        legal
            .iter()
            .any(|info| info.kind == ActionKind::Discard && info.tile.as_deref() == Some(tile))
    };
    let reject = |code: PackFindingCode, detail: String| {
        PackFinding::scenario(code, scenario.id.as_str(), detail)
    };

    match &state.correct_action {
        CorrectAction::Riichi { discard } => {
            if discard.trim().is_empty() {
                findings.push(reject(
                    PackFindingCode::RiichiWithoutDiscard,
                    "a Riichi answer must name the discard it declares on".to_string(),
                ));
            }
            if !legal.iter().any(|info| info.kind == ActionKind::Riichi) {
                findings.push(reject(
                    PackFindingCode::AnswerNotLegal,
                    "Riichi is not a legal action in this state".to_string(),
                ));
            }
            if !discard_is_legal(discard) {
                findings.push(reject(
                    PackFindingCode::AnswerNotLegal,
                    format!("Riichi discard `{discard}` is not in the hand"),
                ));
            }
        }
        CorrectAction::Dama { discard }
        | CorrectAction::Fold { discard }
        | CorrectAction::Discard { tile: discard } => {
            if !discard_is_legal(discard) {
                findings.push(reject(
                    PackFindingCode::AnswerNotLegal,
                    format!("answer discard `{discard}` is not in the hand"),
                ));
            }
        }
        CorrectAction::Kan { tile } => {
            if !legal
                .iter()
                .any(|info| info.kind == ActionKind::Kan && info.tile.as_deref() == Some(tile))
            {
                findings.push(reject(
                    PackFindingCode::AnswerNotLegal,
                    format!("Kan on `{tile}` is not a legal action in this state"),
                ));
            }
        }
        CorrectAction::Pass => {
            if !legal.iter().any(|info| info.kind == ActionKind::Pass) {
                findings.push(reject(
                    PackFindingCode::AnswerNotLegal,
                    "Pass is not a legal action in this state".to_string(),
                ));
            }
            if state.call_offer.is_none() {
                findings.push(reject(
                    PackFindingCode::CallWithoutOffer,
                    "a call/pass lesson must carry the offered call in `call_offer`".to_string(),
                ));
            }
        }
        CorrectAction::Best { action, .. } => {
            if !legal.iter().any(|info| &info.action == action) {
                findings.push(reject(
                    PackFindingCode::AnswerNotLegal,
                    format!("model action `{action}` is not a legal action in this state"),
                ));
            }
        }
    }

    if let Some(tile) = state.correct_action.tile()
        && state.equivalent_tiles.iter().any(|other| other == tile)
    {
        findings.push(reject(
            PackFindingCode::EquivalentRepeatsAnswer,
            format!("`{tile}` is listed as its own equivalent"),
        ));
    }
    for equivalent in &state.equivalent_tiles {
        if !discard_is_legal(equivalent) {
            findings.push(reject(
                PackFindingCode::EquivalentNotLegal,
                format!("equivalent tile `{equivalent}` is not a legal discard"),
            ));
        }
    }
    findings
}

/// The state must be a legal, reachable table and its build record must not
/// claim work that did not happen.
fn check_state(scenario: &PackScenario) -> Vec<PackFinding> {
    let mut findings = Vec::new();
    if let Err(message) = validate_reachable_state(&scenario.state) {
        findings.push(PackFinding::scenario(
            PackFindingCode::ScenarioStateInvalid,
            scenario.id.as_str(),
            message,
        ));
    }
    let validation = scenario.validation;
    if !validation.state_valid {
        findings.push(PackFinding::scenario(
            PackFindingCode::ValidationRecordFailed,
            scenario.id.as_str(),
            "`validation.state_valid` is false",
        ));
    }
    if !validation.answer_recomputed {
        findings.push(PackFinding::scenario(
            PackFindingCode::ValidationRecordFailed,
            scenario.id.as_str(),
            "`validation.answer_recomputed` is false; the answer was trusted from a source",
        ));
    }
    if !validation.visible_info_only {
        findings.push(PackFinding::scenario(
            PackFindingCode::ValidationRecordFailed,
            scenario.id.as_str(),
            "`validation.visible_info_only` is false; the answer needs hidden information",
        ));
    }
    findings
}

/// A variant must carry the label-preservation record that admitted it.
fn check_variant(scenario: &PackScenario) -> Vec<PackFinding> {
    let mut findings = Vec::new();
    let provenance = &scenario.provenance;
    if let Some(chain) = &provenance.transform_chain
        && let Err(error) = chain.validate()
    {
        findings.push(PackFinding::scenario(
            PackFindingCode::TransformChainInvalid,
            scenario.id.as_str(),
            error.to_string(),
        ));
    }
    if let Some(chain) = &provenance.transform_chain {
        let names: Vec<&'static str> = chain.transforms.iter().map(transform_name).collect();
        if names != provenance.transforms {
            findings.push(PackFinding::scenario(
                PackFindingCode::TransformListMismatch,
                scenario.id.as_str(),
                format!(
                    "`transforms` is {:?} but the chain is {:?}",
                    provenance.transforms, names
                ),
            ));
        }
    }
    if provenance.is_variant() {
        match &provenance.label_check {
            None => findings.push(PackFinding::scenario(
                PackFindingCode::VariantWithoutLabelCheck,
                scenario.id.as_str(),
                "a transformed/variant scenario must record its label-preservation check",
            )),
            Some(check) if !check.preserved => findings.push(PackFinding::scenario(
                PackFindingCode::VariantLabelNotPreserved,
                scenario.id.as_str(),
                "the variant's label-preservation check failed; it must not ship",
            )),
            Some(_) => {}
        }
    }
    findings
}

fn transform_name(transform: &Transform) -> &'static str {
    match transform {
        Transform::SeatPerm { .. } => "seat_perm",
        Transform::SuitPerm { .. } => "suit_perm",
        Transform::RankMirror {} => "rank_mirror",
        Transform::WindRelabel { .. } => "wind_relabel",
        Transform::Red5Normalize {} => "red5_normalize",
    }
}

/// Q values are model utility, probabilities are probabilities, and selection
/// scores are bounded. A unit mix-up is a pack defect, not a display detail.
fn check_units(scenario: &PackScenario) -> Vec<PackFinding> {
    let mut findings = Vec::new();
    let mut reject = |detail: String| {
        findings.push(PackFinding::scenario(
            PackFindingCode::UnitsMismatch,
            scenario.id.as_str(),
            detail,
        ));
    };

    if let Some(mortal) = &scenario.mortal {
        if mortal.value_units != VALUE_UNITS {
            reject(format!(
                "`mortal.value_units` is `{}`, expected `{VALUE_UNITS}`",
                mortal.value_units
            ));
        }
        if !is_sha256_hex(&mortal.model_sha256) {
            reject("`mortal.model_sha256` is not a SHA-256".to_string());
        }
        for (field, value) in [
            ("top_probability", mortal.top_probability),
            ("margin", mortal.margin),
        ] {
            if !value.is_finite() || !(0.0..=1.0).contains(&value) {
                reject(format!("`mortal.{field}` is not a probability: {value}"));
            }
        }
        if !mortal.expected_value.is_finite() {
            reject(format!(
                "`mortal.expected_value` is not finite: {}",
                mortal.expected_value
            ));
        }
        for action in &mortal.ranking {
            if !action.probability.is_finite() || !(0.0..=1.0).contains(&action.probability) {
                reject(format!(
                    "`mortal.ranking` probability for `{}` is not a probability: {}",
                    action.action, action.probability
                ));
            }
            if action.q_value.is_some_and(|q| !q.is_finite()) {
                reject(format!(
                    "`mortal.ranking` Q for `{}` is not finite",
                    action.action
                ));
            }
        }
    }

    if let Some(counterfactual) = &scenario.counterfactual {
        if counterfactual.q_units != Q_UNITS {
            reject(format!(
                "`counterfactual.q_units` is `{}`, expected `{Q_UNITS}`",
                counterfactual.q_units
            ));
        }
        for (action, q) in &counterfactual.q_values {
            if !q.is_finite() {
                reject(format!("`counterfactual.q_values[{action}]` is not finite"));
            }
        }
        for (field, value) in [
            ("q_gap_top2", counterfactual.q_gap_top2),
            ("q_gap_safe", counterfactual.q_gap_safe),
        ] {
            if value.is_some_and(|value| !value.is_finite()) {
                reject(format!("`counterfactual.{field}` is not finite"));
            }
        }
        // Q values are only ever points through a named calibration.
        if counterfactual.calibration_version.is_some()
            && counterfactual
                .calibration_version
                .as_deref()
                .unwrap_or("")
                .trim()
                .is_empty()
        {
            reject("`counterfactual.calibration_version` is empty".to_string());
        }
    }

    if let Some(interestingness) = &scenario.interestingness {
        for (field, value) in [
            ("score", interestingness.score),
            (
                "counterfactual_tension",
                interestingness.counterfactual_tension,
            ),
        ] {
            if !value.is_finite() || !(0.0..=1.0).contains(&value) {
                reject(format!(
                    "`interestingness.{field}` is not a 0..=1 score: {value}"
                ));
            }
        }
        if interestingness.coverage.trim().is_empty() {
            reject("`interestingness.coverage` is empty".to_string());
        }
    }
    findings
}

/// Whether a value is one of the app's compact tile codes.
#[must_use]
pub fn is_tile_code(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 2
        && bytes[0].is_ascii_digit()
        && bytes[0] != b'0'
        && matches!(bytes[1], b'm' | b'p' | b's' | b'z')
}

/// The tile codes a pre-answer string must not print.
///
/// The accepted answer's tiles are always forbidden. At tenpai the hand's
/// `ukeire_tiles` are its winning tiles, so they are the "wait" the hard gate
/// protects; visible call-offer tiles are never treated as a spoiler because
/// the offer is the question.
#[must_use]
pub fn spoiler_tokens(state: &GameState) -> Vec<String> {
    let answer_tokens: BTreeSet<String> = accepted_for(state)
        .into_iter()
        .filter(|token| is_tile_code(token))
        .collect();
    let mut tokens = answer_tokens.clone();
    if state.shanten == 0 {
        let visible_offer: BTreeSet<&str> = state
            .call_offer
            .as_ref()
            .map(|offer| {
                offer
                    .tiles
                    .iter()
                    .map(String::as_str)
                    .chain(std::iter::once(offer.tile.as_str()))
                    .collect()
            })
            .unwrap_or_default();
        for tile in &state.ukeire_tiles {
            if is_tile_code(tile)
                && (!visible_offer.contains(tile.as_str()) || answer_tokens.contains(tile))
            {
                tokens.insert(tile.clone());
            }
        }
    }
    tokens.into_iter().collect()
}

/// Find the first pre-answer string that prints a spoiling tile code.
#[must_use]
pub fn find_spoiler(scenario: &PackScenario) -> Option<PackFinding> {
    let tokens = spoiler_tokens(&scenario.state);
    if tokens.is_empty() {
        return None;
    }
    let mut texts: Vec<(&str, String)> = vec![
        ("title", scenario.title.clone()),
        ("prompt", scenario.prompt.clone()),
    ];
    if let Some(note) = &scenario.state.scenario_note {
        texts.push(("scenario_note", note.clone()));
    }
    if let Some(book) = &scenario.book {
        texts.push(("book.label", book.label.clone()));
    }
    if let Some(kyoku) = &scenario.provenance.kyoku {
        texts.push(("provenance.kyoku", kyoku.clone()));
    }
    if !scenario.provenance.transforms.is_empty() {
        texts.push((
            "provenance.transforms",
            scenario.provenance.transforms.join(" "),
        ));
    }
    if let Some(variant_of) = &scenario.provenance.variant_of {
        texts.push(("provenance.variant_of", variant_of.to_string()));
    }
    if let Some(interestingness) = &scenario.interestingness {
        texts.push(("interestingness.tags", interestingness.tags.join(" ")));
    }

    for (field, text) in texts {
        let lowered = text.to_ascii_lowercase();
        for token in &tokens {
            if contains_tile_token(&lowered, token) {
                return Some(PackFinding::scenario(
                    PackFindingCode::Spoiler,
                    scenario.id.as_str(),
                    format!("`{field}` prints the answer/wait tile code `{token}`"),
                ));
            }
        }
    }
    None
}

fn contains_tile_token(haystack: &str, token: &str) -> bool {
    let mut start = 0;
    while let Some(offset) = haystack[start..].find(token) {
        let index = start + offset;
        let before_ok = index == 0
            || !haystack[..index]
                .chars()
                .next_back()
                .is_some_and(|c| c.is_ascii_alphanumeric());
        let end = index + token.len();
        let after_ok = end == haystack.len()
            || !haystack[end..]
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphanumeric());
        if before_ok && after_ok {
            return true;
        }
        start = index + token.len();
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tile_codes_are_recognised() {
        assert!(is_tile_code("1m"));
        assert!(is_tile_code("7z"));
        for bad in ["0m", "1x", "m1", "11m", "", "r5m"] {
            assert!(!is_tile_code(bad), "{bad} must not be a tile code");
        }
    }

    #[test]
    fn token_matching_needs_code_boundaries() {
        assert!(contains_tile_token("discard the 1z now", "1z"));
        assert!(contains_tile_token("1z", "1z"));
        assert!(!contains_tile_token("11z", "1z"));
        assert!(!contains_tile_token("21z", "1z"));
        assert!(!contains_tile_token("1zz", "1z"));
        assert!(!contains_tile_token("a1z", "1z"));
    }
}
