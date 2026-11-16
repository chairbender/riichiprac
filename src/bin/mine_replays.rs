//! Stub entry point for the native-only replay miner.
//!
//! F1 creates the feature boundary and the subcommand surface; the commands
//! themselves land in later units (R1 and after). Running a stub exits with
//! code 2 and writes a "not implemented" line to stderr, so a script cannot
//! mistake it for a completed run.
//!
//! Build and run:
//!
//! ```text
//! cargo run --features miner --bin mine_replays -- --help
//! cargo run --features miner --bin mine_replays -- corpus report
//! ```
//!
//! The data root is `--data-dir`, then `$RIICHI_DATA_DIR`, then
//! `$HOME/riichiprac-data`; see [`riichiprac::miner::DataRoot`].

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};

use riichiprac::miner::DataRoot;

#[derive(Debug, Parser)]
#[command(
    name = "mine_replays",
    version,
    about = "Riichi replay miner (native-only; F1 scaffold)"
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
    Label,
    /// Generate label-preserving scenario variants.
    Transform,
    /// Assemble, audit and export scenario packs.
    Pack,
    /// Audit provenance, licences and pack integrity.
    Audit,
    /// Work the human review queue.
    Review,
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
            Self::Label => "label",
            Self::Transform => "transform",
            Self::Pack => "pack",
            Self::Audit => "audit",
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

    eprintln!(
        "mine_replays {}: not implemented in the F1 scaffold (data root: {})",
        cli.command.name(),
        root.root().display()
    );
    ExitCode::from(2)
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
            "label",
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
    fn unknown_subcommand_is_rejected() {
        assert!(Cli::try_parse_from(["mine_replays", "frobnicate"]).is_err());
    }
}
