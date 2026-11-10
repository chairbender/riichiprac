//! Verify a downloaded Riichi Trainer scenario report outside the browser.
//!
//! ```bash
//! cargo run --release --bin verify_report -- report.json
//! cargo run --release --bin verify_report -- report.json \
//!   --weights frontend/public/models/mortal_298k.safetensors
//! ```
//!
//! Exit codes: 0 valid, 1 invalid report, 2 AI evaluation failure.

use std::path::PathBuf;
use std::process::ExitCode;

use candle_core::{DType, Device};
use candle_nn::VarBuilder;
use serde_json::json;

use riichiprac::ai::model::MortalV4Model;
use riichiprac::ai::wasm_bridge::evaluate_state;
use riichiprac::report::{ParsedReport, parse_report};

struct Args {
    report: PathBuf,
    weights: Option<PathBuf>,
    json: bool,
}

fn main() -> ExitCode {
    if std::env::args().any(|arg| arg == "--help" || arg == "-h") {
        println!("usage: verify_report <report.json> [--weights <model.safetensors>] [--json]");
        return ExitCode::SUCCESS;
    }

    let args = match parse_args() {
        Ok(args) => args,
        Err(message) => {
            eprintln!("verify_report: {message}");
            eprintln!(
                "usage: verify_report <report.json> [--weights <model.safetensors>] [--json]"
            );
            return ExitCode::from(2);
        }
    };

    let text = match std::fs::read_to_string(&args.report) {
        Ok(text) => text,
        Err(err) => {
            eprintln!(
                "verify_report: cannot read {}: {err}",
                args.report.display()
            );
            return ExitCode::from(1);
        }
    };

    let parsed = match parse_report(&text) {
        Ok(parsed) => parsed,
        Err(message) => {
            eprintln!("verify_report: invalid report: {message}");
            return ExitCode::from(1);
        }
    };

    if !args.json {
        print_report(&parsed);
    }

    let ai = match args.weights {
        Some(path) => match evaluate_weights(&parsed, &path) {
            Ok(evaluation) => {
                if !args.json {
                    print_evaluation(&parsed, &evaluation);
                }
                Some(evaluation)
            }
            Err(message) => {
                eprintln!("verify_report: AI evaluation failed: {message}");
                return ExitCode::from(2);
            }
        },
        None => None,
    };

    if args.json {
        let payload = json!({
            "valid": true,
            "warnings": parsed.warnings,
            "report_id": parsed.report.report_id,
            "scenario": parsed.report.scenario,
            "verdict": parsed.verdict,
            "ai": ai,
        });
        println!(
            "{}",
            serde_json::to_string_pretty(&payload).expect("verification payload must serialize")
        );
    }

    ExitCode::SUCCESS
}

fn parse_args() -> Result<Args, String> {
    let mut report = None;
    let mut weights = None;
    let mut json = false;
    let mut args = std::env::args().skip(1);

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--weights" => {
                let path = args
                    .next()
                    .ok_or_else(|| "--weights requires a path".to_string())?;
                weights = Some(PathBuf::from(path));
            }
            "--json" => json = true,
            other if other.starts_with('-') => {
                return Err(format!("unknown option {other}"));
            }
            other => {
                if report.is_some() {
                    return Err("only one report path is accepted".to_string());
                }
                report = Some(PathBuf::from(other));
            }
        }
    }

    Ok(Args {
        report: report.ok_or_else(|| "missing report path".to_string())?,
        weights,
        json,
    })
}

fn print_report(parsed: &ParsedReport) {
    println!("{}", parsed.report.human_readable.join("\n"));
    if !parsed.warnings.is_empty() {
        println!("Warnings:");
        for warning in &parsed.warnings {
            println!("  - {warning}");
        }
    }
}

fn print_evaluation(parsed: &ParsedReport, evaluation: &riichiprac::ai::wasm_bridge::Evaluation) {
    println!();
    println!(
        "Mortal double check: EV {:.4}, recommended {}",
        evaluation.expected_value, evaluation.recommended_action
    );
    for action in evaluation.evaluations.iter().take(5) {
        println!(
            "  {:<14} {:>6.2}%",
            action.action,
            action.probability * 100.0
        );
    }
    println!(
        "App expected {} · reporter answered {:?} {}",
        parsed.report.table.correct_action.tile(),
        parsed.report.decision.answer.action,
        parsed.report.decision.answer.tile
    );
}

fn evaluate_weights(
    parsed: &ParsedReport,
    path: &PathBuf,
) -> Result<riichiprac::ai::wasm_bridge::Evaluation, String> {
    let bytes =
        std::fs::read(path).map_err(|err| format!("cannot read {}: {err}", path.display()))?;
    let var_builder = VarBuilder::from_buffered_safetensors(bytes, DType::F32, &Device::Cpu)
        .map_err(|err| format!("cannot parse model weights: {err}"))?;
    let model = MortalV4Model::new(var_builder)
        .map_err(|err| format!("cannot bind model weights: {err}"))?;
    evaluate_state(&model, &parsed.report.table).map_err(|err| format!("evaluation failed: {err}"))
}
