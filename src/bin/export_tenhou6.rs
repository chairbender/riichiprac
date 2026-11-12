//! Write a `tenhou.net/6` log for a generated (or supplied) game state.
//!
//! The log is the "custom log" input of <https://mjai.ekyu.moe>. Upload it with
//! the player id this tool prints, engine "Mortal", the network the local
//! checkpoint was trained as, and temperature 1.00 if you want the reviewer's
//! `pi(a|s)` column to be comparable with [`riichiprac::ai::wasm_bridge`]'s
//! softmax.
//!
//! ```text
//! cargo run --release --bin export_tenhou6 -- --scenario riichi_judgement
//! cargo run --release --bin export_tenhou6 -- --all --out-dir /tmp/tenhou6
//! cargo run --release --bin export_tenhou6 -- --state state.json --out log.json
//! cargo run --release --bin export_tenhou6 -- --scenario defense_safety_chart \
//!     --evaluate --evaluation-out /tmp/eval.json
//! ```
//!
//! Progress and diagnostics go to stderr so `--out -` keeps stdout parseable.
//! Exit codes: 0 success, 2 bad arguments or a state that cannot be exported,
//! 3 a model failure while `--evaluate` is on.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use candle_core::{DType, Device};
use candle_nn::VarBuilder;
use serde_json::json;

use riichiprac::ai::model::MortalV4Model;
use riichiprac::ai::wasm_bridge::evaluate_state;
use riichiprac::export::{Tenhou6Export, export_tenhou6};
use riichiprac::generator::{ScenarioId, generate_puzzle};
use riichiprac::state::GameState;

/// Scenarios whose log this exporter can represent faithfully.
///
/// The open-meld lessons claim a tile that the generator never puts in the
/// discarder's river, so those tables have no real game log at all; the
/// exporter rejects them by name instead of writing a lie.
const EXPORTABLE: &[ScenarioId] = &[
    ScenarioId::ChiitoitsuRiichiVsDama,
    ScenarioId::RiichiJudgement,
    ScenarioId::WindDiscardOrder,
    ScenarioId::DefenseSafetyChart,
    ScenarioId::SujiKabeSafety,
    ScenarioId::DefenseStuckHeuristic,
    ScenarioId::FoldToRiichi,
];

#[derive(Debug)]
struct Args {
    scenarios: Vec<ScenarioId>,
    all: bool,
    state: Option<PathBuf>,
    out: Option<PathBuf>,
    out_dir: Option<PathBuf>,
    evaluate: bool,
    weights: PathBuf,
    evaluation_out: Option<PathBuf>,
    evaluate_only: bool,
    quiet: bool,
}

fn main() -> ExitCode {
    let args = match parse_args(std::env::args().skip(1)) {
        Ok(args) => args,
        Err(message) => {
            eprintln!("export_tenhou6: {message}");
            eprintln!("{}", USAGE);
            return ExitCode::from(2);
        }
    };
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err((code, message)) => {
            eprintln!("export_tenhou6: {message}");
            ExitCode::from(code)
        }
    }
}

const USAGE: &str = "\
usage: export_tenhou6 [options]
  --scenario <id>        generate a puzzle for this scenario (repeatable)
  --all                  every scenario this exporter can represent
  --state <path>         read a GameState JSON instead of generating one
  --out <path>           write the log here (default: stdout, '-' for stdout)
  --out-dir <dir>        write <scenario>.tenhou6.json per generated puzzle
  --evaluate             also run the local Mortal checkpoint on the state
  --evaluate-only        skip the log and only evaluate (for states that cannot export)
  --weights <path>       Mortal checkpoint (default: frontend/public/models/...)
  --evaluation-out <p>   write our Evaluation JSON here (`-` for stdout)
  --quiet                do not print the upload hint
";

fn parse_args<I: Iterator<Item = String>>(mut args: I) -> Result<Args, String> {
    let mut parsed = Args {
        scenarios: Vec::new(),
        all: false,
        state: None,
        out: None,
        out_dir: None,
        evaluate: false,
        weights: default_weights(),
        evaluation_out: None,
        evaluate_only: false,
        quiet: false,
    };
    while let Some(arg) = args.next() {
        let mut value = |flag: &str| -> Result<String, String> {
            args.next().ok_or_else(|| format!("{flag} needs a value"))
        };
        match arg.as_str() {
            "--scenario" => {
                let id = value("--scenario")?;
                parsed.scenarios.push(
                    ScenarioId::from_id(&id).ok_or_else(|| format!("unknown scenario {id:?}"))?,
                );
            }
            "--all" => parsed.all = true,
            "--state" => parsed.state = Some(PathBuf::from(value("--state")?)),
            "--out" => parsed.out = Some(PathBuf::from(value("--out")?)),
            "--out-dir" => parsed.out_dir = Some(PathBuf::from(value("--out-dir")?)),
            "--evaluate" => parsed.evaluate = true,
            "--weights" => parsed.weights = PathBuf::from(value("--weights")?),
            "--evaluation-out" => {
                parsed.evaluation_out = Some(PathBuf::from(value("--evaluation-out")?))
            }
            "--evaluate-only" => {
                parsed.evaluate_only = true;
                parsed.evaluate = true;
            }
            "--quiet" => parsed.quiet = true,
            "--help" | "-h" => {
                print!("{USAGE}");
                std::process::exit(0);
            }
            other => return Err(format!("unknown argument {other:?}")),
        }
    }
    if parsed.state.is_none() && parsed.scenarios.is_empty() && !parsed.all {
        return Err("give --scenario, --all or --state".to_string());
    }
    if parsed.all {
        parsed.scenarios = EXPORTABLE.to_vec();
    }
    Ok(parsed)
}

fn default_weights() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.push("frontend/public/models/mortal_298k.safetensors");
    path
}

fn run(args: &Args) -> Result<(), (u8, String)> {
    let states = collect_states(args)?;
    if states.is_empty() {
        return Err((2, "no states to export".to_string()));
    }

    let model = if args.evaluate {
        Some(load_model(&args.weights)?)
    } else {
        None
    };

    for (label, state) in &states {
        if !args.evaluate_only {
            let export = export_tenhou6(state).map_err(|err| (2, format!("{label}: {err}")))?;
            report(label, &export, args);
            write_log(label, &export, args)?;
        }
        if let Some(model) = &model {
            let evaluation = evaluate_state(model, state)
                .map_err(|err| (3, format!("{label}: evaluation failed: {err}")))?;
            write_evaluation(label, state, &evaluation, args)?;
        }
    }
    Ok(())
}

fn collect_states(args: &Args) -> Result<Vec<(String, GameState)>, (u8, String)> {
    let mut states = Vec::new();
    if let Some(path) = &args.state {
        let body = std::fs::read_to_string(path)
            .map_err(|err| (2, format!("cannot read {}: {err}", path.display())))?;
        let state: GameState = serde_json::from_str(&body).map_err(|err| {
            (
                2,
                format!("{} is not a GameState JSON: {err}", path.display()),
            )
        })?;
        let label = state.category.clone();
        states.push((label, state));
    }
    for &id in &args.scenarios {
        let state = generate_puzzle(id.as_str())
            .map_err(|err| (2, format!("{}: generation failed: {err}", id.as_str())))?;
        states.push((id.as_str().to_string(), state));
    }
    Ok(states)
}

fn load_model(path: &Path) -> Result<MortalV4Model, (u8, String)> {
    if !path.is_file() {
        return Err((
            2,
            format!(
                "weights not found: {} (run scripts/convert_weights.py first)",
                path.display()
            ),
        ));
    }
    let bytes = std::fs::read(path)
        .map_err(|err| (3, format!("cannot read weights {}: {err}", path.display())))?;
    let builder = VarBuilder::from_buffered_safetensors(bytes, DType::F32, &Device::Cpu)
        .map_err(|err| (3, format!("cannot parse weights: {err}")))?;
    MortalV4Model::new(builder).map_err(|err| (3, format!("cannot bind weights: {err}")))
}

fn report(label: &str, export: &Tenhou6Export, args: &Args) {
    let summary = &export.summary;
    eprintln!(
        "{label}: player-id {} (human is absolute seat {}), kyoku {}, dealer seat {}, \
         {} takes / {} draws ({} replacement), {} bytes",
        summary.player_id,
        summary.player_id,
        summary.kyoku_num,
        summary.dealer_seat,
        summary.takes,
        summary.wall_draws,
        summary.replacement_draws,
        summary.log_bytes
    );
    for warning in &export.warnings {
        eprintln!("  warning: {warning}");
    }
    if !args.quiet {
        eprintln!(
            "  upload: https://mjai.ekyu.moe -> \"Custom log (tenhou.net/6 JSON)\", \
             target player {}, engine Mortal, temperature 1.00",
            export.player_id
        );
    }
}

fn write_log(label: &str, export: &Tenhou6Export, args: &Args) -> Result<(), (u8, String)> {
    if let Some(dir) = &args.out_dir {
        std::fs::create_dir_all(dir)
            .map_err(|err| (2, format!("cannot create {}: {err}", dir.display())))?;
        let path = dir.join(format!("{label}.tenhou6.json"));
        std::fs::write(&path, &export.json)
            .map_err(|err| (2, format!("cannot write {}: {err}", path.display())))?;
        eprintln!("  wrote {}", path.display());
        return Ok(());
    }
    match &args.out {
        Some(path) if path != Path::new("-") => {
            if let Some(parent) = path.parent()
                && !parent.as_os_str().is_empty()
            {
                std::fs::create_dir_all(parent)
                    .map_err(|err| (2, format!("cannot create {}: {err}", parent.display())))?;
            }
            std::fs::write(path, &export.json)
                .map_err(|err| (2, format!("cannot write {}: {err}", path.display())))?;
            eprintln!("  wrote {}", path.display());
        }
        _ => println!("{}", export.json),
    }
    Ok(())
}

fn write_evaluation(
    label: &str,
    state: &GameState,
    evaluation: &riichiprac::ai::wasm_bridge::Evaluation,
    args: &Args,
) -> Result<(), (u8, String)> {
    let payload = json!({
        "scenario": label,
        // `evaluate_state` applies Mortal's softmax with no temperature, so
        // these probabilities are the tau = 1 distribution. The reviewer
        // defaults to tau = 0.1 and must be set to 1.00 to match.
        "temperature": 1.0,
        "model": evaluation.model,
        "expected_value": evaluation.expected_value,
        "recommended_action": evaluation.recommended_action,
        "riichi_discard": evaluation.riichi_discard,
        "evaluations": evaluation
            .evaluations
            .iter()
            .map(|scored| json!({
                "action": scored.info.action,
                "kind": scored.info.kind,
                "probability": scored.probability,
            }))
            .collect::<Vec<_>>(),
        "state": state,
    });
    let text = serde_json::to_string_pretty(&payload)
        .map_err(|err| (3, format!("cannot serialize evaluation: {err}")))?;
    eprintln!(
        "{label}: our top action {} (EV {:.4})",
        evaluation.recommended_action, evaluation.expected_value
    );
    match &args.evaluation_out {
        Some(path) if path != Path::new("-") => {
            std::fs::write(path, text)
                .map_err(|err| (2, format!("cannot write {}: {err}", path.display())))?;
            eprintln!("  wrote {}", path.display());
        }
        Some(_) => println!("{text}"),
        None => {
            let path = PathBuf::from(format!("{label}.evaluation.json"));
            std::fs::write(&path, text)
                .map_err(|err| (2, format!("cannot write {}: {err}", path.display())))?;
            eprintln!("  wrote {}", path.display());
        }
    }
    Ok(())
}
