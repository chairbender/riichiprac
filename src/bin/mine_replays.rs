//! Entry point for the native-only replay miner.
//!
//! F1 created the feature boundary and the subcommand surface; L1 implements
//! `label` on top of the R2 walker and the F1 database. The remaining commands
//! are still stubs: running one exits with code 2 and writes a "not implemented"
//! line to stderr, so a script cannot mistake it for a completed run.
//!
//! Build and run:
//!
//! ```text
//! cargo run --features miner --bin mine_replays -- --help
//! cargo run --features miner --bin mine_replays -- label --weights \
//!   frontend/public/models/mortal_298k.safetensors
//! ```
//!
//! The data root is `--data-dir`, then `$RIICHI_DATA_DIR`, then
//! `$HOME/riichiprac-data`; see [`riichiprac::miner::DataRoot`].

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::SystemTime;

use clap::{Parser, Subcommand};

use riichiprac::miner::label::run::{LabelRunOptions, LabelRunReport, run_label};
use riichiprac::miner::{
    AuditOptions, CLASSIFIER_VERSION, DataRoot, GAMES_FILE_NAME, MANIFEST_FILE_NAME, PackAudit,
    PackAuditContext, PackBudget, PackError, PackFinding, PackFindingCode, PublishProfile,
    QPointCalibration, audit_pack_dir, audit_summary, fixture_games, fixture_pack, load_manifest,
    pack_report, publish_pack, read_pack, render_pack_report, utc_iso8601, write_games_atomic,
};

#[derive(Debug, Parser)]
#[command(
    name = "mine_replays",
    version,
    about = "Riichi replay miner (native-only)"
)]
struct Cli {
    /// Data root. Defaults to $RIICHI_DATA_DIR or ~/riichiprac-data.
    #[arg(long, global = true, value_name = "DIR")]
    data_dir: Option<PathBuf>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Generate mixed-agent self-play corpora.
    Corpus {
        #[command(subcommand)]
        action: Option<CorpusAction>,
    },
    /// Ingest and validate raw self-play logs.
    Ingest,
    /// Reconstruct decision points from validated logs.
    Extract,
    /// Label candidates with book classifiers and Mortal.
    Label {
        /// Mortal checkpoint (.safetensors).
        #[arg(long, value_name = "FILE")]
        weights: PathBuf,

        /// Additional checkpoints for the optional multi-model vote pass,
        /// comma separated. One checkpoint is the normal labeler and is not an
        /// ensemble; a multi-model pass records each member's vote.
        #[arg(long, value_name = "FILE,...", value_delimiter = ',')]
        models: Vec<PathBuf>,

        /// Versioned Q→point calibration (JSON). Point estimates are recorded
        /// in a separate field and the raw Q values are never overwritten.
        #[arg(long, value_name = "FILE")]
        calibration: Option<PathBuf>,

        /// Replay directory (default: <data-dir>/replays).
        #[arg(long, value_name = "DIR")]
        replays: Option<PathBuf>,

        /// Label only this family sub-directory.
        #[arg(long, value_name = "NAME")]
        family: Option<String>,

        /// Maximum replay files in this shard.
        #[arg(long, value_name = "N")]
        limit: Option<usize>,

        /// Classifier generation recorded on every label.
        #[arg(long, value_name = "V", default_value = CLASSIFIER_VERSION)]
        classifier_version: String,

        /// Reward discount the checkpoint was trained with, when known.
        #[arg(long, value_name = "F32")]
        gamma: Option<f32>,

        /// Placement utility weights, comma separated, when known.
        #[arg(long, value_name = "a,b,c,d", value_delimiter = ',')]
        pts: Option<Vec<f32>>,

        /// Machine-readable report.
        #[arg(long)]
        json: bool,
    },
    /// Generate label-preserving scenario variants.
    Transform,
    /// Assemble, audit and export scenario packs.
    Pack {
        #[command(subcommand)]
        action: Option<PackAction>,
    },
    /// Audit provenance, licences and pack integrity.
    Audit {
        /// Manifest to audit (default: <data-dir>/packs/manifest.json).
        #[arg(long, value_name = "FILE")]
        manifest: Option<PathBuf>,

        /// Game provenance JSONL (default: games.jsonl beside the manifest).
        #[arg(long, value_name = "FILE")]
        games: Option<PathBuf>,

        /// Fail on warnings as well as errors.
        #[arg(long)]
        strict: bool,

        /// Audit for a commercial redistribution profile.
        #[arg(long)]
        commercial: bool,

        /// Machine-readable report.
        #[arg(long)]
        json: bool,
    },
    /// Work the human review queue.
    Review,
}

#[derive(Debug, Subcommand)]
enum PackAction {
    /// Publish the built-in fixture pack, manifest and provenance rows.
    Fixture {
        /// Output directory (default: <data-dir>/packs).
        #[arg(long, value_name = "DIR")]
        out: Option<PathBuf>,

        /// Pack body byte ceiling (default: 50 MB).
        #[arg(long, value_name = "N")]
        max_bytes: Option<u64>,

        /// Machine-readable report.
        #[arg(long)]
        json: bool,
    },
    /// Print the pack report for every manifest entry.
    Report {
        /// Manifest to report on (default: <data-dir>/packs/manifest.json).
        #[arg(long, value_name = "FILE")]
        manifest: Option<PathBuf>,

        /// Machine-readable report.
        #[arg(long)]
        json: bool,
    },
}

#[derive(Debug, Subcommand)]
enum CorpusAction {
    /// Print one row per corpus family: counts, triggers, labels, shortfalls.
    Report,
}

impl Command {
    fn name(&self) -> &'static str {
        match self {
            Self::Corpus { .. } => "corpus",
            Self::Ingest => "ingest",
            Self::Extract => "extract",
            Self::Label { .. } => "label",
            Self::Transform => "transform",
            Self::Pack { .. } => "pack",
            Self::Audit { .. } => "audit",
            Self::Review => "review",
        }
    }
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let root = match cli.data_dir {
        Some(path) => DataRoot::new(path),
        None => DataRoot::from_env(),
    };
    let root = match root {
        Ok(root) => root,
        Err(err) => {
            eprintln!("mine_replays: {err}");
            return ExitCode::from(2);
        }
    };

    match cli.command {
        Command::Label {
            weights,
            models,
            calibration,
            replays,
            family,
            limit,
            classifier_version,
            gamma,
            pts,
            json,
        } => {
            let calibration = match calibration {
                Some(path) => match QPointCalibration::read(&path) {
                    Ok(calibration) => Some(calibration),
                    Err(err) => {
                        eprintln!("mine_replays label: {err}");
                        return ExitCode::from(2);
                    }
                },
                None => None,
            };
            run_label_command(
                &root,
                &LabelRunOptions {
                    weights,
                    extra_models: models,
                    replays,
                    family,
                    limit,
                    classifier_version,
                    gamma,
                    pts,
                    label_options: Default::default(),
                    calibration,
                },
                json,
            )
        }
        Command::Pack { action } => run_pack_command(&root, action),
        Command::Audit {
            manifest,
            games,
            strict,
            commercial,
            json,
        } => run_audit_command(&root, manifest, games, strict, commercial, json),
        command => {
            eprintln!(
                "mine_replays {}: not implemented yet (data root: {})",
                command.name(),
                root.root().display()
            );
            ExitCode::from(2)
        }
    }
}

fn run_pack_command(root: &DataRoot, action: Option<PackAction>) -> ExitCode {
    let Some(action) = action else {
        eprintln!("mine_replays pack: choose `fixture` or `report`");
        return ExitCode::from(2);
    };
    match action {
        PackAction::Fixture {
            out,
            max_bytes,
            json,
        } => run_pack_fixture(root, out, max_bytes, json),
        PackAction::Report { manifest, json } => run_pack_report(root, manifest, json),
    }
}

fn run_pack_fixture(
    root: &DataRoot,
    out: Option<PathBuf>,
    max_bytes: Option<u64>,
    json: bool,
) -> ExitCode {
    let dir = out.unwrap_or_else(|| root.packs_dir());
    let budget = max_bytes.map_or_else(PackBudget::default, PackBudget::with_max_bytes);
    let now = utc_iso8601(SystemTime::now());
    let pack = match fixture_pack(&now) {
        Ok(pack) => pack,
        Err(err) => {
            eprintln!("mine_replays pack fixture: {err}");
            return ExitCode::from(2);
        }
    };
    let games = fixture_games();
    let context = PackAuditContext::new(&games).with_budget(budget);

    // The audit reads the provenance source; write it before publishing so the
    // command leaves a directory that `audit` can re-check on its own.
    if let Err(err) = write_games_atomic(&dir, &games) {
        eprintln!("mine_replays pack fixture: {err}");
        return ExitCode::from(2);
    }
    match publish_pack(&dir, &pack, &context, &now) {
        Ok(published) => {
            let report = pack_report(&pack, published.entry.bytes, &budget);
            if json {
                let payload = serde_json::json!({
                    "path": published.path.display().to_string(),
                    "manifest": published.manifest_path.display().to_string(),
                    "games": dir.join(GAMES_FILE_NAME).display().to_string(),
                    "entry": published.entry,
                    "report": report,
                });
                match serde_json::to_string_pretty(&payload) {
                    Ok(text) => println!("{text}"),
                    Err(err) => {
                        eprintln!("mine_replays pack fixture: cannot serialise the report: {err}");
                        return ExitCode::from(2);
                    }
                }
            } else {
                println!(
                    "mine_replays pack fixture: wrote {} ({} bytes)",
                    published.path.display(),
                    published.entry.bytes
                );
                for line in render_pack_report(&report) {
                    println!("  {line}");
                }
                println!("  manifest: {}", published.manifest_path.display());
                println!("  provenance: {}", dir.join(GAMES_FILE_NAME).display());
            }
            ExitCode::SUCCESS
        }
        Err(PackError::AuditFailed(audit)) => {
            eprintln!("mine_replays pack fixture: the fixture pack failed its own audit");
            print_pack_findings(&audit);
            ExitCode::from(1)
        }
        Err(err) => {
            eprintln!("mine_replays pack fixture: {err}");
            ExitCode::from(2)
        }
    }
}

fn run_pack_report(root: &DataRoot, manifest: Option<PathBuf>, json: bool) -> ExitCode {
    let path = manifest.unwrap_or_else(|| root.packs_dir().join(MANIFEST_FILE_NAME));
    let manifest = match load_manifest(&path) {
        Ok(manifest) => manifest,
        Err(err) => {
            eprintln!("mine_replays pack report: {err}");
            return ExitCode::from(2);
        }
    };
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let budget = PackBudget::default();
    let mut reports = Vec::new();
    let mut errors = 0usize;
    for entry in &manifest.packs {
        let pack_path = dir.join(&entry.path);
        match read_pack(&pack_path) {
            Ok(pack) => reports.push(pack_report(&pack, entry.bytes, &budget)),
            Err(err) => {
                eprintln!("mine_replays pack report: {err}");
                errors += 1;
            }
        }
    }
    if json {
        let payload = serde_json::json!({
            "manifest": path.display().to_string(),
            "packs": reports,
        });
        match serde_json::to_string_pretty(&payload) {
            Ok(text) => println!("{text}"),
            Err(err) => {
                eprintln!("mine_replays pack report: cannot serialise the report: {err}");
                return ExitCode::from(2);
            }
        }
    } else if reports.is_empty() {
        println!(
            "mine_replays pack report: {} lists no packs",
            path.display()
        );
    } else {
        for report in &reports {
            for line in render_pack_report(report) {
                println!("{line}");
            }
        }
    }
    if errors > 0 {
        ExitCode::from(1)
    } else {
        ExitCode::SUCCESS
    }
}

fn run_audit_command(
    root: &DataRoot,
    manifest: Option<PathBuf>,
    games: Option<PathBuf>,
    strict: bool,
    commercial: bool,
    json: bool,
) -> ExitCode {
    let path = manifest.unwrap_or_else(|| root.packs_dir().join(MANIFEST_FILE_NAME));
    let dir = path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf();
    let options = AuditOptions {
        profile: if commercial {
            PublishProfile::Commercial
        } else {
            PublishProfile::NonCommercial
        },
        strict,
        budget: PackBudget::default(),
    };
    let report = match audit_pack_dir(&dir, games.as_deref(), &options) {
        Ok(report) => report,
        Err(err) => {
            eprintln!("mine_replays audit: {err}");
            return ExitCode::from(2);
        }
    };

    if json {
        match serde_json::to_string_pretty(&report) {
            Ok(text) => println!("{text}"),
            Err(err) => {
                eprintln!("mine_replays audit: cannot serialise the report: {err}");
                return ExitCode::from(2);
            }
        }
    } else {
        println!(
            "mine_replays audit: {} ({} bytes manifest, {} pack(s){})",
            report.manifest,
            report.manifest_bytes,
            report.packs.len(),
            if report.strict { ", strict" } else { "" }
        );
        for finding in &report.findings {
            print_finding(finding);
        }
        for audit in &report.packs {
            print_pack_findings(audit);
        }
        let failures = report.failures().len();
        if failures == 0 {
            println!("  clean");
        } else {
            println!("  {failures} failure(s)");
        }
    }

    if report.is_clean() {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}

fn print_pack_findings(audit: &PackAudit) {
    if audit.findings.is_empty() {
        println!("  {}", audit_summary(audit));
        return;
    }
    println!("  {}", audit_summary(audit));
    for finding in &audit.findings {
        print_finding(finding);
    }
}

fn print_finding(finding: &PackFinding) {
    let severity = match finding.severity {
        riichiprac::miner::FindingSeverity::Error => "error",
        riichiprac::miner::FindingSeverity::Warning => "warning",
    };
    let code: PackFindingCode = finding.code;
    match &finding.scenario {
        Some(scenario) => eprintln!("    {severity} [{code:?}] {scenario}: {}", finding.detail),
        None => eprintln!("    {severity} [{code:?}] {}", finding.detail),
    }
}

fn run_label_command(root: &DataRoot, options: &LabelRunOptions, json: bool) -> ExitCode {
    match run_label(root, options) {
        Ok(report) if json => {
            match serde_json::to_string_pretty(&report) {
                Ok(text) => println!("{text}"),
                Err(err) => {
                    eprintln!("mine_replays label: cannot serialise the report: {err}");
                    return ExitCode::from(2);
                }
            }
            label_exit_code(&report)
        }
        Ok(report) => {
            println!(
                "mine_replays label: {} replay(s) ({}, {} failed), {} decisions \
                 ({} labelled, {} cached, {} retried, {} failed)",
                report.replays_found,
                report.replays_walked,
                report.replays_failed,
                report.decisions_seen,
                report.decisions_labelled,
                report.decisions_cached,
                report.decisions_retried,
                report.decisions_failed
            );
            println!(
                "  model: {} (sha256 {}), classifier {}",
                report.model, report.model_sha256, report.classifier_version
            );
            if report.labelers.len() > 1 {
                println!("  multi-model votes: {}", report.labelers.join(", "));
            }
            if let Some(calibration) = &report.calibration {
                println!("  Q->point calibration: {calibration}");
            }
            println!(
                "  book labels: {} ({} stable, {} contested); mortal-only: {}; \
                 unresolved conflicts: {}; walker drops: {}",
                report.book_labels,
                report.stable,
                report.contested,
                report.mortal_only,
                report.book_conflicts,
                report.decisions_dropped
            );
            for error in &report.errors {
                eprintln!("  error: {error}");
            }
            label_exit_code(&report)
        }
        Err(err) => {
            eprintln!("mine_replays label: {err}");
            ExitCode::from(2)
        }
    }
}

/// A run with failures is not a success: exit 1 so a script notices.
fn label_exit_code(report: &LabelRunReport) -> ExitCode {
    if report.replays_failed + report.decisions_failed > 0 {
        ExitCode::from(1)
    } else {
        ExitCode::SUCCESS
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    #[test]
    fn clap_definition_is_well_formed() {
        Cli::command().debug_assert();
    }

    #[test]
    fn every_f1_subcommand_parses() {
        for name in [
            "corpus",
            "ingest",
            "extract",
            "transform",
            "pack",
            "audit",
            "review",
        ] {
            let cli = Cli::try_parse_from(["mine_replays", name])
                .unwrap_or_else(|err| panic!("`{name}` must parse: {err}"));
            assert_eq!(cli.command.name(), name);
        }
    }

    #[test]
    fn label_requires_weights_and_parses_the_model_metadata() {
        assert!(
            Cli::try_parse_from(["mine_replays", "label"]).is_err(),
            "the miner never guesses a checkpoint"
        );
        let cli = Cli::try_parse_from([
            "mine_replays",
            "label",
            "--weights",
            "mortal_298k.safetensors",
            "--models",
            "other_a.safetensors,other_b.safetensors",
            "--calibration",
            "calibration.json",
            "--family",
            "mortal_mirror",
            "--limit",
            "5",
            "--gamma",
            "0.99",
            "--pts",
            "90,45,0,-135",
            "--json",
        ])
        .expect("label parses");
        match cli.command {
            Command::Label {
                weights,
                models,
                calibration,
                family,
                limit,
                gamma,
                pts,
                json,
                ..
            } => {
                assert_eq!(weights, PathBuf::from("mortal_298k.safetensors"));
                assert_eq!(
                    models,
                    vec![
                        PathBuf::from("other_a.safetensors"),
                        PathBuf::from("other_b.safetensors")
                    ]
                );
                assert_eq!(calibration, Some(PathBuf::from("calibration.json")));
                assert_eq!(family.as_deref(), Some("mortal_mirror"));
                assert_eq!(limit, Some(5));
                assert_eq!(gamma, Some(0.99));
                assert_eq!(pts, Some(vec![90.0, 45.0, 0.0, -135.0]));
                assert!(json);
            }
            other => panic!("expected the label command, got {other:?}"),
        }
    }

    #[test]
    fn a_single_model_label_run_has_no_extra_models_or_calibration() {
        let cli = Cli::try_parse_from([
            "mine_replays",
            "label",
            "--weights",
            "mortal_298k.safetensors",
        ])
        .expect("label parses");
        match cli.command {
            Command::Label {
                models,
                calibration,
                ..
            } => {
                assert!(models.is_empty(), "one checkpoint is the normal labeler");
                assert!(calibration.is_none());
            }
            other => panic!("expected the label command, got {other:?}"),
        }
    }

    #[test]
    fn corpus_report_and_global_data_dir_parse() {
        let cli = Cli::try_parse_from([
            "mine_replays",
            "--data-dir",
            "/tmp/riichiprac-data",
            "corpus",
            "report",
        ])
        .expect("corpus report parses");
        assert_eq!(cli.data_dir, Some(PathBuf::from("/tmp/riichiprac-data")));
        assert!(matches!(
            cli.command,
            Command::Corpus {
                action: Some(CorpusAction::Report)
            }
        ));
    }

    #[test]
    fn pack_and_audit_options_parse() {
        let cli = Cli::try_parse_from([
            "mine_replays",
            "pack",
            "fixture",
            "--out",
            "/tmp/riichiprac-packs",
            "--max-bytes",
            "1024",
            "--json",
        ])
        .expect("pack fixture parses");
        match cli.command {
            Command::Pack {
                action:
                    Some(PackAction::Fixture {
                        out,
                        max_bytes,
                        json,
                    }),
            } => {
                assert_eq!(out, Some(PathBuf::from("/tmp/riichiprac-packs")));
                assert_eq!(max_bytes, Some(1024));
                assert!(json);
            }
            other => panic!("expected pack fixture, got {other:?}"),
        }

        let cli = Cli::try_parse_from([
            "mine_replays",
            "pack",
            "report",
            "--manifest",
            "manifest.json",
            "--json",
        ])
        .expect("pack report parses");
        match cli.command {
            Command::Pack {
                action: Some(PackAction::Report { manifest, json }),
            } => {
                assert_eq!(manifest, Some(PathBuf::from("manifest.json")));
                assert!(json);
            }
            other => panic!("expected pack report, got {other:?}"),
        }

        let cli = Cli::try_parse_from([
            "mine_replays",
            "audit",
            "--manifest",
            "manifest.json",
            "--games",
            "games.jsonl",
            "--strict",
            "--commercial",
            "--json",
        ])
        .expect("audit parses");
        match cli.command {
            Command::Audit {
                manifest,
                games,
                strict,
                commercial,
                json,
            } => {
                assert_eq!(manifest, Some(PathBuf::from("manifest.json")));
                assert_eq!(games, Some(PathBuf::from("games.jsonl")));
                assert!(strict);
                assert!(commercial);
                assert!(json);
            }
            other => panic!("expected audit, got {other:?}"),
        }
    }

    #[test]
    fn unknown_subcommand_is_rejected() {
        assert!(Cli::try_parse_from(["mine_replays", "frobnicate"]).is_err());
    }
}
