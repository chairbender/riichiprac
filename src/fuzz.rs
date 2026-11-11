//! Pure helpers for the offline scenario fuzz runner (`bin/fuzz_scenarios`).
//!
//! This module deliberately contains no file I/O, no model loading, and no
//! platform clock access: it only transforms data, so it is unit-tested by
//! `cargo test --lib` and still compiles for wasm32. The binary owns argument
//! parsing, generation, evaluation, and writing report files.
//!
//! Comparison rules are documented in `scenario-fuzz-plan.md`.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::ai::model::ACTION_SPACE;
use crate::ai::wasm_bridge::{Evaluation, describe_action};
use crate::report::{ReportedAction, mortal_action_for_correct, probability_for_action};
use crate::state::{CorrectAction, CorrectActionType};

/// Result of comparing the app's expected action with Mortal's top pick.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FuzzOutcome {
    /// Mortal's recommendation matches the app's expected action.
    Agrees,
    /// Both actions are legal but differ.
    Discrepancy,
    /// The app's expected action has no legal Mortal equivalent (for example Kan).
    Incomparable,
}

/// Which part of the answer disagrees.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiscrepancyKind {
    /// Different action family (Riichi vs discard, Kan vs discard, ...).
    Action,
    /// Both are discards but the tile differs.
    Tile,
}

impl DiscrepancyKind {
    /// Stable snake_case name used in report notes and logs.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Action => "expected_action_wrong",
            Self::Tile => "expected_tile_wrong",
        }
    }
}

/// Everything the runner needs to log, classify, and export one comparison.
#[derive(Debug, Clone)]
pub struct Comparison {
    /// Mortal action name for the app's expected answer.
    pub app_action: String,
    /// Aggregated probability of `app_action`, including red-five variants.
    pub app_probability: f32,
    /// Mortal's top recommendation.
    pub ai_action: String,
    /// Aggregated probability of `ai_action`, including red-five variants.
    pub ai_probability: f32,
    /// Mortal's value head output for the position.
    pub expected_value: f32,
    /// Agreement / discrepancy / incomparable.
    pub outcome: FuzzOutcome,
    /// Present only for a discrepancy.
    pub kind: Option<DiscrepancyKind>,
}

impl Comparison {
    /// True when this comparison should become a report file.
    pub fn should_export(&self, include_incomparable: bool) -> bool {
        matches!(self.outcome, FuzzOutcome::Discrepancy)
            || (include_incomparable && self.outcome == FuzzOutcome::Incomparable)
    }

    /// How far ahead of the app's answer Mortal's top pick is.
    ///
    /// Both sides are probability sums over red-five variants, so the lead is
    /// comparable. Negative when the app's answer actually outranks Mortal's
    /// top pick, which can happen for incomparable cases.
    pub fn ai_lead(&self) -> f32 {
        self.ai_probability - self.app_probability
    }

    /// True when Mortal's lead is at least `min_margin`, i.e. the disagreement
    /// is bigger than a statistical tie.
    pub fn exceeds_margin(&self, min_margin: f32) -> bool {
        self.ai_lead() >= min_margin
    }
}

/// Normalize a Mortal action name for comparison.
///
/// Mortal keeps red fives as separate actions (`Discard_5mr`), while the
/// trainer names tiles with the plain code (`5m`). Red names compare equal to
/// their plain tile.
pub fn normalize_action_name(name: &str) -> &str {
    match name {
        "Discard_5mr" | "Discard_5pr" | "Discard_5sr" => &name[..name.len() - 1],
        _ => name,
    }
}

/// Action-space index for an action name, treating red fives as their plain tile.
pub fn action_index(name: &str) -> Option<usize> {
    let normalized = normalize_action_name(name);
    (0..ACTION_SPACE).find(|&index| normalize_action_name(&describe_action(index).0) == normalized)
}

/// Whether the action name resolves to an enabled entry in a legal-action mask.
pub fn action_is_legal(name: &str, legal: &[bool]) -> bool {
    action_index(name)
        .and_then(|index| legal.get(index).copied())
        .unwrap_or(false)
}

/// Compare the app's expected action with one Mortal evaluation.
///
/// `legal` is the output of `ai::wasm_bridge::legal_action_mask` for the same
/// state. The app action is checked for legality first; if it has no legal
/// Mortal equivalent the result is [`FuzzOutcome::Incomparable`] even when the
/// model happens to name the same action (Kan is never legal in this space).
pub fn compare_expected_action(
    expected: &CorrectAction,
    evaluation: &Evaluation,
    legal: &[bool],
) -> Comparison {
    compare_action_set(expected, &[], evaluation, legal)
}

/// Compare the app's answer with one Mortal evaluation, accepting any tile the
/// state declares equivalent.
///
/// [`crate::state::GameState::equivalent_tiles`] names discards that grade as
/// the same answer: a shape lesson's twin tile, or a genbutsu tie where another
/// player's post-riichi discard is as safe as the answer (Riichi Book 1, ch. 8
/// counts both kinds as genbutsu). Mortal picking one of them is agreement, not
/// a discrepancy.
pub fn compare_action_set(
    expected: &CorrectAction,
    equivalents: &[String],
    evaluation: &Evaluation,
    legal: &[bool],
) -> Comparison {
    let mut comparison = compare_expected_action_inner(expected, evaluation, legal);

    if comparison.outcome == FuzzOutcome::Discrepancy
        && comparison.kind == Some(DiscrepancyKind::Tile)
        && let Some(tile) = normalize_action_name(&comparison.ai_action).strip_prefix("Discard_")
        && equivalents.iter().any(|equivalent| equivalent == tile)
    {
        comparison.outcome = FuzzOutcome::Agrees;
        comparison.kind = None;
    }

    comparison
}

fn compare_expected_action_inner(
    expected: &CorrectAction,
    evaluation: &Evaluation,
    legal: &[bool],
) -> Comparison {
    let app_action = mortal_action_for_correct(expected);
    let ai_action = evaluation.recommended_action.clone();
    let app_probability = probability_for_action(evaluation, &app_action);
    let ai_probability = probability_for_action(evaluation, normalize_action_name(&ai_action));

    let (outcome, kind) = if !action_is_legal(&app_action, legal) {
        (FuzzOutcome::Incomparable, None)
    } else if normalize_action_name(&ai_action) == normalize_action_name(&app_action) {
        // Matching action names only settle a riichi-vs-dama comparison when
        // the declared discards agree too. Mortal's `Riichi` action carries no
        // tile, so its second-pass discard (when the evaluator resolved one)
        // decides the rest.
        if riichi_discard_disagrees(expected, evaluation) {
            (FuzzOutcome::Discrepancy, Some(DiscrepancyKind::Tile))
        } else {
            (FuzzOutcome::Agrees, None)
        }
    } else {
        (
            FuzzOutcome::Discrepancy,
            Some(discrepancy_kind(expected, &ai_action)),
        )
    };

    Comparison {
        app_action,
        app_probability,
        ai_action,
        ai_probability,
        expected_value: evaluation.expected_value,
        outcome,
        kind,
    }
}

/// Classify a discrepancy as an action-family or tile-level disagreement.
pub fn discrepancy_kind(expected: &CorrectAction, ai_action: &str) -> DiscrepancyKind {
    let expected_is_discard = matches!(
        expected.action_type(),
        CorrectActionType::Dama | CorrectActionType::Fold | CorrectActionType::Discard
    );
    let ai_is_discard = normalize_action_name(ai_action).starts_with("Discard_");

    if expected_is_discard && ai_is_discard {
        DiscrepancyKind::Tile
    } else {
        DiscrepancyKind::Action
    }
}

/// Whether both sides declare Riichi but on different discards.
///
/// Only a Riichi-vs-Riichi comparison can disagree on the tile after the action
/// names match, and only when the evaluation resolved Mortal's second-pass
/// discard. Everything else (including an unresolved discard) compares equal.
pub fn riichi_discard_disagrees(expected: &CorrectAction, evaluation: &Evaluation) -> bool {
    if !matches!(expected, CorrectAction::Riichi { .. }) {
        return false;
    }
    let Some(app_tile) = expected.tile() else {
        return false;
    };
    evaluation
        .riichi_discard
        .as_deref()
        .is_some_and(|ai_tile| ai_tile != app_tile)
}

/// Convert Mortal's recommendation into the report's answer vocabulary.
///
/// `fallback_tile` is used for actions that do not name a tile in Mortal's
/// action space (Riichi and Kan). For a Riichi recommendation the evaluation's
/// own second-pass discard is preferred, so the exported report records what
/// Mortal would actually declare on instead of echoing the app's tile. Returns
/// `None` for actions the report cannot express, such as `Agari`, `Ryukyoku`,
/// or `Pass`.
pub fn reported_action_for_ai(
    ai_action: &str,
    fallback_tile: &str,
    riichi_discard: Option<&str>,
) -> Option<ReportedAction> {
    let normalized = normalize_action_name(ai_action);
    match normalized {
        "Riichi" => Some(ReportedAction::new(
            CorrectActionType::Riichi,
            riichi_discard.unwrap_or(fallback_tile),
        )),
        "Kan" => Some(ReportedAction::new(CorrectActionType::Kan, fallback_tile)),
        _ => normalized
            .strip_prefix("Discard_")
            .map(|tile| ReportedAction::new(CorrectActionType::Discard, tile)),
    }
}

/// Short provenance note written into `decision.note`.
pub fn provenance_note(
    iteration: u64,
    scenario: &str,
    model: &str,
    comparison: &Comparison,
    incomparable: bool,
) -> String {
    let prefix = if incomparable { "incomparable: " } else { "" };
    let app_probability = positive_zero(comparison.app_probability);
    let ai_probability = positive_zero(comparison.ai_probability);
    format!(
        "{prefix}fuzz: iteration {iteration}, scenario {scenario}, model {model}, \
         app {} (p={app_probability:.2}) vs AI {} (p={ai_probability:.2}), expected_value={:.4}",
        comparison.app_action, comparison.ai_action, comparison.expected_value,
    )
}

/// Format an empty probability sum as `0.00` instead of `-0.00`.
fn positive_zero(value: f32) -> f32 {
    if value == 0.0 { 0.0 } else { value }
}

/// UTC timestamp in the report's RFC3339 shape (`2026-11-10T08:42:11.031Z`).
pub fn format_rfc3339(seconds_since_epoch: i64, millis: u32) -> String {
    let (year, month, day, hour, minute, second) = utc_components(seconds_since_epoch);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

/// UTC filename stamp (`YYYYMMDD-HHmmss`).
pub fn file_stamp_utc(seconds_since_epoch: i64) -> String {
    let (year, month, day, hour, minute, second) = utc_components(seconds_since_epoch);
    format!("{year:04}{month:02}{day:02}-{hour:02}{minute:02}{second:02}")
}

fn utc_components(seconds_since_epoch: i64) -> (i64, u32, u32, u32, u32, u32) {
    let days = seconds_since_epoch.div_euclid(86_400);
    let seconds_of_day = seconds_since_epoch.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = (seconds_of_day / 3_600) as u32;
    let minute = ((seconds_of_day % 3_600) / 60) as u32;
    let second = (seconds_of_day % 60) as u32;
    (year, month, day, hour, minute, second)
}

/// Howard Hinnant's `civil_from_days`: days since 1970-01-01 to (year, month, day).
fn civil_from_days(days_since_epoch: i64) -> (i64, u32, u32) {
    let shifted = days_since_epoch + 719_468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let day_of_era = (shifted - era * 146_097) as u64;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era as i64 + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_prime + 2) / 5 + 1) as u32;
    let month = if month_prime < 10 {
        month_prime + 3
    } else {
        month_prime - 9
    } as u32;
    let year = if month <= 2 { year + 1 } else { year };
    (year, month, day)
}

/// Deterministic 32-hex-character id from a 64-bit seed.
pub fn hex_id_from_seed(seed: u64) -> String {
    let mut state = if seed == 0 {
        0x9e37_79b9_7f4a_7c15
    } else {
        seed
    };
    let mut id = String::with_capacity(32);
    for _ in 0..2 {
        state = xorshift64(state);
        id.push_str(&format!("{state:016x}"));
    }
    id
}

fn xorshift64(mut value: u64) -> u64 {
    value ^= value << 13;
    value ^= value >> 7;
    value ^= value << 17;
    value
}

/// Serializable final summary, shared by the human and `--json` output paths.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct FuzzSummary {
    /// Generation attempts actually made.
    pub iterations: u64,
    /// Budget requested on the command line.
    pub requested_iterations: u64,
    /// Attempts where the generator returned an error.
    pub generator_failures: u64,
    /// Successful Mortal evaluations.
    pub evaluations: u64,
    /// Cases where Mortal's top pick matched the app.
    pub agreements: u64,
    /// Disagreements per scenario id.
    pub discrepancies: BTreeMap<String, u64>,
    /// Cases whose expected action has no legal Mortal equivalent.
    pub incomparable_found: u64,
    /// Incomparable cases not exported because the flag was off.
    pub incomparable_skipped: u64,
    /// Discrepancies whose Mortal action cannot be expressed as a report answer.
    pub unsupported_ai_skipped: u64,
    /// Discrepancies and exported incomparables dropped by `--min-margin`.
    pub below_margin: u64,
    /// Report files written.
    pub files_written: u64,
    /// Whether `--limit` stopped the run early.
    pub limit_reached: bool,
    /// Configured file limit.
    pub limit: usize,
    /// Minimum probability lead required to export a disagreement.
    pub min_margin: f32,
    /// Directory the reports were written to.
    pub out_dir: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::tile_index;
    use crate::ai::wasm_bridge::ActionEvaluation;
    use crate::state::CorrectAction;

    fn evaluation(recommended: &str, actions: &[(&str, &str, f32)]) -> Evaluation {
        Evaluation {
            model: "test".to_string(),
            expected_value: 0.041,
            recommended_action: recommended.to_string(),
            riichi_discard: None,
            evaluations: actions
                .iter()
                .map(|(action, kind, probability)| {
                    ActionEvaluation::from_parts(action, kind, None, *probability)
                })
                .collect(),
        }
    }

    fn mask_for(tiles: &[&str], riichi: bool) -> Vec<bool> {
        let mut mask = vec![false; ACTION_SPACE];
        for tile in tiles {
            mask[tile_index(tile).expect("valid tile")] = true;
        }
        mask[37] = riichi;
        mask
    }

    #[test]
    fn maps_every_correct_action_to_a_mortal_name() {
        assert_eq!(
            mortal_action_for_correct(&CorrectAction::riichi("3p")),
            "Riichi"
        );
        assert_eq!(
            mortal_action_for_correct(&CorrectAction::dama("3p")),
            "Discard_3p"
        );
        assert_eq!(mortal_action_for_correct(&CorrectAction::kan("5p")), "Kan");
        assert_eq!(
            mortal_action_for_correct(&CorrectAction::discard("5p")),
            "Discard_5p"
        );
    }

    #[test]
    fn normalizes_only_red_fives() {
        assert_eq!(normalize_action_name("Discard_5mr"), "Discard_5m");
        assert_eq!(normalize_action_name("Discard_5pr"), "Discard_5p");
        assert_eq!(normalize_action_name("Discard_5sr"), "Discard_5s");
        assert_eq!(normalize_action_name("Discard_5m"), "Discard_5m");
        assert_eq!(normalize_action_name("Discard_5zr"), "Discard_5zr");
        assert_eq!(normalize_action_name("Riichi"), "Riichi");
    }

    #[test]
    fn resolves_action_indices_and_legality() {
        let mask = mask_for(&["3p", "5m"], true);

        assert_eq!(action_index("Discard_3p"), Some(tile_index("3p").unwrap()));
        assert_eq!(action_index("Discard_5mr"), Some(tile_index("5m").unwrap()));
        assert_eq!(action_index("Riichi"), Some(37));
        assert!(action_is_legal("Riichi", &mask));
        assert!(action_is_legal("Discard_3p", &mask));
        assert!(!action_is_legal("Discard_4p", &mask));
        assert!(!action_is_legal("Kan", &mask));
    }

    #[test]
    fn agreement_requires_a_legal_matching_top_pick() {
        let expected = CorrectAction::riichi("3p");
        let evaluation = evaluation(
            "Riichi",
            &[("Riichi", "riichi", 0.7), ("Discard_3p", "discard", 0.3)],
        );

        let comparison = compare_expected_action(&expected, &evaluation, &mask_for(&["3p"], true));

        assert_eq!(comparison.outcome, FuzzOutcome::Agrees);
        assert_eq!(comparison.kind, None);
        assert_eq!(comparison.app_action, "Riichi");
        assert_eq!(comparison.ai_action, "Riichi");
        assert_eq!(comparison.app_probability, 0.7);
    }

    #[test]
    fn red_five_recommendation_agrees_with_plain_tile() {
        let expected = CorrectAction::dama("5m");
        let evaluation = evaluation(
            "Discard_5mr",
            &[
                ("Discard_5mr", "discard", 0.5),
                ("Discard_5m", "discard", 0.2),
            ],
        );

        let comparison = compare_expected_action(&expected, &evaluation, &mask_for(&["5m"], true));

        assert_eq!(comparison.outcome, FuzzOutcome::Agrees);
        assert!((comparison.app_probability - 0.7).abs() < 1e-6);
        assert!((comparison.ai_probability - 0.7).abs() < 1e-6);
    }

    #[test]
    fn discard_vs_discard_is_a_tile_discrepancy() {
        let expected = CorrectAction::dama("3p");
        let evaluation = evaluation(
            "Discard_4p",
            &[
                ("Discard_4p", "discard", 0.62),
                ("Discard_3p", "discard", 0.21),
            ],
        );

        let comparison =
            compare_expected_action(&expected, &evaluation, &mask_for(&["3p", "4p"], true));

        assert_eq!(comparison.outcome, FuzzOutcome::Discrepancy);
        assert_eq!(comparison.kind, Some(DiscrepancyKind::Tile));
        assert_eq!(comparison.kind.unwrap().as_str(), "expected_tile_wrong");
    }

    #[test]
    fn riichi_vs_discard_is_an_action_discrepancy() {
        let expected = CorrectAction::riichi("3p");
        let evaluation = evaluation(
            "Discard_3p",
            &[("Discard_3p", "discard", 0.62), ("Riichi", "riichi", 0.21)],
        );

        let comparison = compare_expected_action(&expected, &evaluation, &mask_for(&["3p"], true));

        assert_eq!(comparison.outcome, FuzzOutcome::Discrepancy);
        assert_eq!(comparison.kind, Some(DiscrepancyKind::Action));
        assert!((comparison.app_probability - 0.21).abs() < 1e-6);
        assert!((comparison.ai_probability - 0.62).abs() < 1e-6);
    }

    #[test]
    fn kan_is_incomparable_even_when_the_name_would_match() {
        let expected = CorrectAction::kan("5p");
        let evaluation = evaluation(
            "Kan",
            &[("Kan", "kan", 0.9), ("Discard_5p", "discard", 0.1)],
        );

        let comparison = compare_expected_action(&expected, &evaluation, &mask_for(&["5p"], true));

        assert_eq!(comparison.outcome, FuzzOutcome::Incomparable);
        assert_eq!(comparison.kind, None);
    }

    #[test]
    fn include_incomparable_controls_export() {
        let expected = CorrectAction::kan("5p");
        let evaluation = evaluation("Discard_5p", &[("Discard_5p", "discard", 1.0)]);
        let comparison = compare_expected_action(&expected, &evaluation, &mask_for(&["5p"], true));

        assert!(!comparison.should_export(false));
        assert!(comparison.should_export(true));
    }

    #[test]
    fn converts_mortal_recommendations_to_reported_actions() {
        let riichi = reported_action_for_ai("Riichi", "3p", None).unwrap();
        assert_eq!(riichi.action, CorrectActionType::Riichi);
        assert_eq!(riichi.tile, "3p");

        // The second-pass discard wins over the app's tile: the report must
        // record what Mortal would declare on.
        let riichi = reported_action_for_ai("Riichi", "3p", Some("7s")).unwrap();
        assert_eq!(riichi.action, CorrectActionType::Riichi);
        assert_eq!(riichi.tile, "7s");

        let discard = reported_action_for_ai("Discard_4p", "3p", None).unwrap();
        assert_eq!(discard.action, CorrectActionType::Discard);
        assert_eq!(discard.tile, "4p");

        let red = reported_action_for_ai("Discard_5mr", "3p", None).unwrap();
        assert_eq!(red.action, CorrectActionType::Discard);
        assert_eq!(red.tile, "5m");

        let kan = reported_action_for_ai("Kan", "5p", None).unwrap();
        assert_eq!(kan.action, CorrectActionType::Kan);
        assert_eq!(kan.tile, "5p");

        assert!(reported_action_for_ai("Agari", "5p", None).is_none());
        assert!(reported_action_for_ai("Pass", "5p", None).is_none());
    }

    #[test]
    fn riichi_agreement_requires_the_same_declared_discard() {
        let expected = CorrectAction::riichi("3p");
        let mut same = evaluation("Riichi", &[("Riichi", "riichi", 0.8)]);
        same.riichi_discard = Some("3p".to_string());
        let comparison = compare_expected_action(&expected, &same, &mask_for(&["3p"], true));
        assert_eq!(comparison.outcome, FuzzOutcome::Agrees);

        let mut different = evaluation("Riichi", &[("Riichi", "riichi", 0.8)]);
        different.riichi_discard = Some("7s".to_string());
        let comparison = compare_expected_action(&expected, &different, &mask_for(&["3p"], true));
        assert_eq!(comparison.outcome, FuzzOutcome::Discrepancy);
        assert_eq!(comparison.kind, Some(DiscrepancyKind::Tile));

        // An unresolved second pass cannot contradict the declaration.
        let unresolved = evaluation("Riichi", &[("Riichi", "riichi", 0.8)]);
        let comparison = compare_expected_action(&expected, &unresolved, &mask_for(&["3p"], true));
        assert_eq!(comparison.outcome, FuzzOutcome::Agrees);
    }

    #[test]
    fn equivalent_tiles_count_as_agreement() {
        let expected = CorrectAction::fold("3p");
        let evaluation = evaluation(
            "Discard_5m",
            &[
                ("Discard_5m", "discard", 0.6),
                ("Discard_3p", "discard", 0.4),
            ],
        );
        let legal = mask_for(&["3p", "5m"], false);

        // Without the equivalent, Mortal's tile is a discrepancy.
        let strict = compare_expected_action(&expected, &evaluation, &legal);
        assert_eq!(strict.outcome, FuzzOutcome::Discrepancy);
        assert_eq!(strict.kind, Some(DiscrepancyKind::Tile));

        // The state's equivalent list turns it into the same answer: another
        // player's post-riichi discard of 5m is genbutsu too (ch. 8).
        let tied = compare_action_set(&expected, &["5m".to_string()], &evaluation, &legal);
        assert_eq!(tied.outcome, FuzzOutcome::Agrees);
        assert_eq!(tied.kind, None);
        assert_eq!(tied.ai_action, "Discard_5m");

        // An unlisted tile still disagrees.
        let other = compare_action_set(&expected, &["7s".to_string()], &evaluation, &legal);
        assert_eq!(other.outcome, FuzzOutcome::Discrepancy);
    }

    #[test]
    fn note_contains_provenance_and_both_probabilities() {
        let expected = CorrectAction::riichi("3p");
        let evaluation = evaluation(
            "Discard_3p",
            &[("Discard_3p", "discard", 0.62), ("Riichi", "riichi", 0.21)],
        );
        let comparison = compare_expected_action(&expected, &evaluation, &mask_for(&["3p"], true));

        let note = provenance_note(
            37,
            "chiitoitsu_riichi_vs_dama",
            "mortal_298k.safetensors",
            &comparison,
            false,
        );

        assert!(note.starts_with("fuzz: iteration 37"));
        assert!(note.contains("scenario chiitoitsu_riichi_vs_dama"));
        assert!(note.contains("model mortal_298k.safetensors"));
        assert!(note.contains("app Riichi (p=0.21)"));
        assert!(note.contains("AI Discard_3p (p=0.62)"));
        assert!(note.contains("expected_value=0.0410"));
    }

    #[test]
    fn incomparable_note_is_marked() {
        let expected = CorrectAction::kan("5p");
        let evaluation = evaluation("Discard_5p", &[("Discard_5p", "discard", 1.0)]);
        let comparison = compare_expected_action(&expected, &evaluation, &mask_for(&["5p"], true));

        let note = provenance_note(1, "shouminkan_decision", "m.safetensors", &comparison, true);

        assert!(note.starts_with("incomparable: fuzz:"));
        assert!(note.contains("app Kan (p=0.00)"));
        assert!(!note.contains("-0.00"));
    }

    #[test]
    fn formats_utc_timestamps_and_filename_stamps() {
        assert_eq!(format_rfc3339(0, 0), "1970-01-01T00:00:00.000Z");
        assert_eq!(format_rfc3339(0, 31), "1970-01-01T00:00:00.031Z");
        assert_eq!(
            format_rfc3339(1_794_300_131, 42),
            "2026-11-10T08:42:11.042Z"
        );
        assert_eq!(file_stamp_utc(1_794_300_131), "20261110-084211");
        assert_eq!(file_stamp_utc(59), "19700101-000059");
        assert_eq!(file_stamp_utc(86_400), "19700102-000000");
    }

    #[test]
    fn hex_ids_are_32_lowercase_hex_chars() {
        let first = hex_id_from_seed(42);
        let second = hex_id_from_seed(43);

        assert_eq!(first.len(), 32);
        assert_eq!(second.len(), 32);
        assert_ne!(first, second);
        assert!(
            first
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        );
        assert_eq!(hex_id_from_seed(42), first);
        assert_eq!(hex_id_from_seed(0).len(), 32);
    }

    #[test]
    fn margin_filters_only_lead_below_the_threshold() {
        let expected = CorrectAction::dama("8m");
        let evaluation = evaluation(
            "Discard_7m",
            &[
                ("Discard_7m", "discard", 0.371),
                ("Discard_8m", "discard", 0.3695),
            ],
        );
        let mask = mask_for(&["7m", "8m"], false);
        let comparison = compare_expected_action(&expected, &evaluation, &mask);

        assert_eq!(comparison.outcome, FuzzOutcome::Discrepancy);
        assert!((comparison.ai_lead() - 0.0015).abs() < 1e-6);
        assert!(
            comparison.exceeds_margin(0.0),
            "zero margin keeps everything"
        );
        assert!(comparison.exceeds_margin(0.001), "0.0015 clears 0.001");
        assert!(
            !comparison.exceeds_margin(0.05),
            "a 0.0015 lead is inside a 0.05 margin"
        );
    }

    #[test]
    fn margin_keeps_a_clear_disagreement() {
        let expected = CorrectAction::dama("6m");
        let evaluation = evaluation(
            "Discard_3s",
            &[
                ("Discard_3s", "discard", 0.85),
                ("Discard_6m", "discard", 0.0024),
            ],
        );
        let mask = mask_for(&["3s", "6m"], false);
        let comparison = compare_expected_action(&expected, &evaluation, &mask);

        assert!(comparison.exceeds_margin(0.05));
        assert!(comparison.exceeds_margin(0.5));
    }

    #[test]
    fn summary_serializes_with_stable_keys() {
        let mut summary = FuzzSummary {
            iterations: 4,
            requested_iterations: 5,
            generator_failures: 1,
            evaluations: 3,
            agreements: 2,
            incomparable_found: 0,
            incomparable_skipped: 0,
            unsupported_ai_skipped: 0,
            files_written: 1,
            limit_reached: true,
            limit: 1,
            out_dir: "fuzz-reports".to_string(),
            ..FuzzSummary::default()
        };
        summary
            .discrepancies
            .insert("ryanmen_protorun".to_string(), 1);

        let json: serde_json::Value = serde_json::to_value(&summary).unwrap();

        assert_eq!(json["iterations"], 4);
        assert_eq!(json["generator_failures"], 1);
        assert_eq!(json["discrepancies"]["ryanmen_protorun"], 1);
        assert_eq!(json["limit_reached"], true);
    }
}
