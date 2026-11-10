//! Human- and agent-readable rendering of a scenario report.

use std::collections::HashMap;
use std::fmt::Write;

use crate::state::{CorrectAction, CorrectActionType, GameState, PlayerState};

use super::model::{ReportVerdict, ReportedAction, ScenarioReport};

/// Render the full report as plain text.
///
/// This is deliberately redundant with the JSON: a maintainer or an LLM should
/// be able to understand the disputed position without knowing the schema.
pub fn render_text(report: &ScenarioReport, verdict: &ReportVerdict) -> String {
    let mut out = String::new();

    let _ = writeln!(out, "Riichi Trainer scenario report");
    let _ = writeln!(
        out,
        "Scenario: {} ({})",
        report.scenario.label, report.scenario.id
    );
    let _ = writeln!(
        out,
        "Exported: {} · app {} · commit {} · built {}",
        report.created_at,
        report.app.app_version,
        or_unknown(&report.app.commit),
        or_unknown(&report.app.build_time)
    );
    let _ = writeln!(out);

    render_table(&mut out, &report.table);
    let _ = writeln!(out);

    let _ = writeln!(out, "Decision: {}", report.decision.prompt);
    let _ = writeln!(
        out,
        "App expected: {}",
        describe_correct_action(&report.table.correct_action)
    );
    let _ = writeln!(
        out,
        "Reporter answered: {}",
        describe_reported_action(&report.decision.answer)
    );
    let _ = writeln!(
        out,
        "Verdict: {}",
        if verdict.is_correct {
            "CORRECT"
        } else if !verdict.is_action_correct {
            "INCORRECT (action mismatch)"
        } else {
            "INCORRECT (tile mismatch)"
        }
    );
    let _ = writeln!(out, "Reporter reason: {}", report.decision.reason.as_str());
    if let Some(note) = &report.decision.note {
        let _ = writeln!(out, "Reporter note: {note}");
    }

    render_triggers(&mut out, &report.table);

    if let Some(ai) = &report.ai {
        let _ = writeln!(out);
        render_ai(&mut out, ai);
    }

    out
}

/// Render the report as one string per line, so the pretty-printed JSON file
/// stays readable in a plain text editor or an LLM prompt.
pub fn render_lines(report: &ScenarioReport, verdict: &ReportVerdict) -> Vec<String> {
    render_text(report, verdict)
        .lines()
        .map(|line| line.to_string())
        .collect()
}

fn render_table(out: &mut String, table: &GameState) {
    let _ = writeln!(
        out,
        "Table: {:?} {} · honba {} · riichi sticks {} · tiles left {}",
        table.round_wind,
        table.hand_number,
        table.honba,
        table.riichi_sticks,
        table.tiles_remaining
    );
    let _ = writeln!(out, "Dora indicators: {}", or_none(&table.dora_indicators));
    let _ = writeln!(
        out,
        "Ura indicators: {}",
        or_none(&table.ura_dora_indicators)
    );
    let _ = writeln!(out);

    for player in &table.players {
        render_player(out, player, table.current_turn == player.seat);
    }
}

fn render_player(out: &mut String, player: &PlayerState, is_current: bool) {
    let mut tags = Vec::new();
    if player.is_human {
        tags.push("human");
    }
    if player.is_riichi {
        tags.push("riichi");
    }
    if is_current {
        tags.push("to act");
    }
    let tag_text = if tags.is_empty() {
        String::new()
    } else {
        format!(" [{}]", tags.join(", "))
    };

    let _ = writeln!(
        out,
        "{} ({:?}, {}){}",
        player.name, player.wind, player.score, tag_text
    );

    let mut red_counts = red_five_counts(player);
    let hand = annotate_red_fives(&player.hand, &mut red_counts);
    let draw = player
        .draw
        .as_ref()
        .map(|tile| annotate_red_fives(std::slice::from_ref(tile), &mut red_counts));

    let _ = writeln!(out, "  Concealed: {}", or_none(&hand));
    let _ = writeln!(
        out,
        "  Draw: {}",
        draw.map(|tiles| tiles.join(" "))
            .unwrap_or_else(|| "(none)".to_string())
    );
    let _ = writeln!(out, "  Melds: {}", format_melds(player));
    let _ = writeln!(out, "  River: {}", format_river(player));
    if player.is_riichi {
        let declaration = player
            .riichi_discard_index
            .map(|index| format!(" (declaration discard #{})", index + 1))
            .unwrap_or_default();
        let _ = writeln!(out, "  Riichi:{declaration}");
    }
}

fn render_triggers(out: &mut String, table: &GameState) {
    if !table.riichi_triggers.is_empty() {
        let reasons: Vec<String> = table
            .riichi_triggers
            .iter()
            .map(|reason| format!("{reason:?}"))
            .collect();
        let _ = writeln!(out, "Riichi triggers: {}", reasons.join(", "));
    }
    if !table.dama_reasons.is_empty() {
        let reasons: Vec<String> = table
            .dama_reasons
            .iter()
            .map(|reason| format!("{reason:?}"))
            .collect();
        let _ = writeln!(out, "Dama reasons: {}", reasons.join(", "));
    }
    if !table.shouminkan_triggers.is_empty() {
        let reasons: Vec<String> = table
            .shouminkan_triggers
            .iter()
            .map(|reason| format!("{reason:?}"))
            .collect();
        let _ = writeln!(out, "Shouminkan triggers: {}", reasons.join(", "));
    }
}

fn render_ai(out: &mut String, ai: &super::model::ReportedAi) {
    let _ = writeln!(
        out,
        "Mortal ({}) captured at {}:",
        ai.model, ai.evaluated_at
    );
    let _ = writeln!(out, "  Expected value: {:.4}", ai.evaluation.expected_value);
    let _ = writeln!(out, "  Recommended: {}", ai.evaluation.recommended_action);
    for action in ai.evaluation.evaluations.iter().take(5) {
        let _ = writeln!(
            out,
            "    {:<14} {:>6.2}%",
            action.action,
            action.probability * 100.0
        );
    }
    if let Some(comparison) = &ai.comparison {
        let _ = writeln!(
            out,
            "  App action {} = {:.2}%, reporter action {} = {:.2}%",
            comparison.app_action,
            comparison.app_probability * 100.0,
            comparison.reporter_action,
            comparison.reporter_probability * 100.0
        );
        let _ = writeln!(
            out,
            "  Mortal agrees with app: {} · agrees with reporter: {}",
            yes_no(comparison.ai_agrees_with_app),
            yes_no(comparison.ai_agrees_with_reporter)
        );
    }
}

fn describe_correct_action(action: &CorrectAction) -> String {
    match action {
        CorrectAction::Riichi { discard } => format!("Riichi, discarding {discard}"),
        CorrectAction::Dama { discard } => format!("Dama, discarding {discard}"),
        CorrectAction::Kan { tile } => format!("Added Kan on {tile}"),
        CorrectAction::Discard { tile } => format!("Pass on the Kan and discard {tile}"),
        CorrectAction::Best { action, tile, .. } => match tile {
            Some(tile) => format!("{action} ({tile})"),
            None => action.clone(),
        },
    }
}

fn describe_reported_action(answer: &ReportedAction) -> String {
    match answer.action {
        CorrectActionType::Riichi => format!("Riichi, discarding {}", answer.tile),
        CorrectActionType::Dama => format!("Dama, discarding {}", answer.tile),
        CorrectActionType::Kan => format!("Added Kan on {}", answer.tile),
        CorrectActionType::Discard => {
            format!("Pass on the Kan and discard {}", answer.tile)
        }
        CorrectActionType::Best => answer
            .action_name
            .clone()
            .unwrap_or_else(|| format!("Discard {}", answer.tile)),
    }
}

fn format_melds(player: &PlayerState) -> String {
    if player.melds.is_empty() {
        return "(none)".to_string();
    }

    player
        .melds
        .iter()
        .map(|meld| {
            let called_from = meld
                .called_from
                .map(|seat| format!(" from seat {seat}"))
                .unwrap_or_default();
            format!(
                "{:?} [{}]{}",
                meld.meld_type,
                meld.tiles.join(" "),
                called_from
            )
        })
        .collect::<Vec<_>>()
        .join("; ")
}

fn format_river(player: &PlayerState) -> String {
    if player.discards.is_empty() {
        return "(empty)".to_string();
    }

    player
        .discards
        .iter()
        .map(|discard| {
            let mut tile = discard.tile.clone();
            if discard.is_tsumogiri {
                tile.push('*');
            }
            if discard.is_riichi {
                tile.push_str("(riichi)");
            }
            tile
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn red_five_counts(player: &PlayerState) -> HashMap<String, usize> {
    let mut counts = HashMap::new();
    for tile in &player.red_fives {
        *counts.entry(tile.clone()).or_insert(0) += 1;
    }
    counts
}

/// Mark red-five copies. `red_fives` records tile codes, not positions, so the
/// first matching copies are marked.
fn annotate_red_fives(tiles: &[String], remaining: &mut HashMap<String, usize>) -> Vec<String> {
    tiles
        .iter()
        .map(|tile| {
            let count = remaining.get_mut(tile);
            match count {
                Some(count) if *count > 0 => {
                    *count -= 1;
                    format!("{tile}(red)")
                }
                _ => tile.clone(),
            }
        })
        .collect()
}

fn or_none(values: &[String]) -> String {
    if values.is_empty() {
        "(none)".to_string()
    } else {
        values.join(" ")
    }
}

fn or_unknown(value: &str) -> &str {
    if value.is_empty() { "unknown" } else { value }
}

fn yes_no(value: bool) -> &'static str {
    if value { "yes" } else { "no" }
}

#[cfg(test)]
mod tests {
    use crate::fixtures::mock_table;
    use crate::report::build_report;
    use crate::report::model::{BuildReportRequest, DecisionPrompt, ReportReason, ReportedAction};
    use crate::state::{CorrectActionType, TargetAction};

    fn fixture_report() -> super::super::model::ScenarioReport {
        let table = mock_table::generate("mock_table").expect("fixture must build");
        let discard = table
            .correct_action
            .tile()
            .expect("fixture answer tile")
            .to_string();
        let request = BuildReportRequest {
            table,
            answer: ReportedAction::new(CorrectActionType::Dama, discard),
            reason: ReportReason::ExpectedActionWrong,
            note: Some("The app should have stayed dama here.".to_string()),
            created_at: "2026-11-10T08:42:11.031Z".to_string(),
            report_id: "8b0e5c0e-4f1b-4f7e-9b3e-2a7c1d9e6f10".to_string(),
            commit: Some("d63f935".to_string()),
            build_time: Some("2026-11-10T08:00:00.000Z".to_string()),
            ai: None,
        };

        build_report(request).expect("report must build")
    }

    #[test]
    fn summary_contains_the_table_decision_and_note() {
        let report = fixture_report();
        let text = report.human_readable.join("\n");

        assert!(text.contains("Riichi Trainer scenario report"));
        assert!(text.contains("Table: East"));
        assert!(text.contains("Dora indicators:"));
        assert!(text.contains("You (East, 25000)"));
        assert!(text.contains("Decision: Declare Riichi, or stay dama?"));
        assert!(text.contains("App expected: Riichi, discarding"));
        assert!(text.contains("Reporter answered: Dama, discarding"));
        assert!(text.contains("INCORRECT (action mismatch)"));
        assert!(text.contains("Reporter note: The app should have stayed dama here."));
    }

    #[test]
    fn summary_marks_riichi_and_tsumogiri_discards() {
        let report = fixture_report();
        let text = report.human_readable.join("\n");

        assert!(text.contains("9s*"), "tsumogiri markers are shown");
        assert!(text.contains("6p(riichi)"), "riichi declaration is shown");
        assert!(text.contains("Shimocha"));
        assert!(text.contains("Toimen"));
        assert!(text.contains("Kamicha"));
    }

    #[test]
    fn summary_describes_target_action_prompts() {
        assert_eq!(
            DecisionPrompt::from_target(TargetAction::NaniKiru).as_str(),
            "Which tile do you discard?"
        );
        assert_eq!(
            DecisionPrompt::from_target(TargetAction::Kan).as_str(),
            "Call Shouminkan, or discard?"
        );
        assert_eq!(
            DecisionPrompt::from_target(TargetAction::Riichi).as_str(),
            "Declare Riichi, or stay dama?"
        );
    }
}
