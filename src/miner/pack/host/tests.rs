//! P2 acceptance: the same-origin hosting publisher and verifier.
//!
//! Every test starts from the audited P1a fixture export, so the hosting path
//! is exercised with the real gate, real content-addressed filenames and real
//! `games.jsonl` provenance rather than a hand-written manifest.

use std::fs;
use std::path::{Path, PathBuf};

use tempfile::TempDir;

use super::super::fixture::{FIXTURE_PACK_ID, fixture_games, fixture_pack};
use super::super::gate::PackAuditContext;
use super::super::model::{Pack, PackId};
use super::super::write::{GAMES_FILE_NAME, MANIFEST_FILE_NAME, publish_pack};
use super::super::{PackBudget, PackError};
use super::{HostBudget, HostOptions, publish_hosted, verify_hosted_dir};

const FIXTURE_TIME: &str = "2026-11-17T00:00:00Z";

struct Fixture {
    _dir: TempDir,
    source: PathBuf,
    dest: PathBuf,
    pack: Pack,
}

fn setup() -> Fixture {
    let dir = tempfile::tempdir().expect("tempdir");
    let source = dir.path().join("packs");
    let dest = dir.path().join("hosted");
    let fixture = fixture_pack(FIXTURE_TIME).expect("fixture pack");
    let games = fixture_games();
    fs::create_dir_all(&source).expect("source dir");
    super::super::write::write_games_atomic(&source, &games).expect("games provenance");
    publish_pack(
        &source,
        &fixture,
        &PackAuditContext::new(&games),
        FIXTURE_TIME,
    )
    .expect("fixture publishes");
    Fixture {
        _dir: dir,
        source,
        dest,
        pack: fixture,
    }
}

fn options(fixture: &Fixture) -> HostOptions {
    HostOptions::new(&fixture.source, &fixture.dest, "2026-11-17T01:00:00Z")
}

fn names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .expect("read dir")
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .collect();
    names.sort();
    names
}

#[test]
fn publish_stages_only_the_manifest_and_content_addressed_bodies() {
    let fixture = setup();
    // Files the source directory holds but the artifact must never carry.
    fs::write(fixture.source.join("notes.txt"), b"operator notes").expect("notes");
    fs::write(
        fixture.source.join("mortal_298k.safetensors"),
        b"not really weights",
    )
    .expect("weights");

    let published = publish_hosted(&options(&fixture)).expect("publish");

    assert!(!published.report.dry_run);
    assert_eq!(published.report.entries.len(), 1);
    assert_eq!(published.report.entries[0].id, FIXTURE_PACK_ID);
    assert_eq!(
        published.report.total_bytes,
        published.report.entries[0].bytes
    );
    assert!(published.report.manifest_bytes > 0);
    assert!(published.report.removed.is_empty());
    assert_eq!(published.report.budget_bytes, 50_000_000);

    let body_path = &published.paths[0];
    assert_eq!(
        names(&fixture.dest),
        vec![
            MANIFEST_FILE_NAME.to_string(),
            body_path
                .file_name()
                .expect("file name")
                .to_string_lossy()
                .to_string(),
        ],
        "only the manifest and one body are hosted"
    );
    assert!(!fixture.dest.join(GAMES_FILE_NAME).exists());
    assert!(!fixture.dest.join("notes.txt").exists());
    assert!(!fixture.dest.join("mortal_298k.safetensors").exists());

    let source_bytes =
        fs::read(fixture.source.join(&published.report.entries[0].path)).expect("source body");
    let hosted_bytes = fs::read(body_path).expect("hosted body");
    assert_eq!(
        source_bytes, hosted_bytes,
        "the body is copied byte for byte"
    );

    let verified =
        verify_hosted_dir(&fixture.dest, &HostBudget::default()).expect("staged dir verifies");
    assert_eq!(verified.entries, published.report.entries);
    assert_eq!(verified.total_bytes, published.report.total_bytes);

    let manifest = super::super::load_manifest(&fixture.dest.join(MANIFEST_FILE_NAME))
        .expect("manifest loads");
    assert_eq!(manifest.updated_at, "2026-11-17T01:00:00Z");
    assert_eq!(manifest.packs.len(), 1);
    assert!(
        super::super::write::validate_entry(&manifest.packs[0]).is_ok(),
        "hosted entries keep the content-addressed filename and relative path"
    );
}

#[test]
fn publish_refuses_a_dirty_source() {
    let fixture = setup();
    fs::remove_file(fixture.source.join(GAMES_FILE_NAME)).expect("remove provenance");

    let error = publish_hosted(&options(&fixture)).expect_err("dirty source refused");
    let message = error.to_string();
    assert!(matches!(error, PackError::HostRefused { .. }), "{message}");
    assert!(
        message.contains("did not pass the pack audit"),
        "the refusal names the audit: {message}"
    );
    assert!(!fixture.dest.exists(), "nothing is written on refusal");
}

#[test]
fn publish_refuses_an_unknown_pack_id() {
    let fixture = setup();
    let mut options = options(&fixture);
    options.packs = vec![PackId::parse("not-a-pack").expect("valid id")];

    let error = publish_hosted(&options).expect_err("unknown id refused");
    assert!(matches!(error, PackError::HostRefused { .. }), "{error}");
    assert!(
        error.to_string().contains("not in the source manifest"),
        "{error}"
    );
    assert!(error.to_string().contains(FIXTURE_PACK_ID), "{error}");
    assert!(!fixture.dest.exists());
}

#[test]
fn publish_refuses_an_over_budget_set_instead_of_trimming() {
    let fixture = setup();
    let mut options = options(&fixture);
    options.budget = HostBudget::with_max_total_bytes(1);

    let error = publish_hosted(&options).expect_err("budget refused");
    match error {
        PackError::HostBudgetExceeded { what, max, bytes } => {
            assert_eq!(what, "hosted body bytes");
            assert_eq!(max, 1);
            assert!(bytes > 1);
        }
        other => panic!("expected a budget error, got {other}"),
    }
    assert!(!fixture.dest.exists());
}

#[test]
fn publish_refuses_a_tiny_manifest_budget() {
    let fixture = setup();
    let mut options = options(&fixture);
    options.budget.max_manifest_bytes = 16;

    let error = publish_hosted(&options).expect_err("manifest budget refused");
    assert!(
        matches!(
            error,
            PackError::HostBudgetExceeded {
                what: "manifest bytes",
                ..
            }
        ),
        "{error}"
    );
    assert!(!fixture.dest.exists());
}

#[test]
fn dry_run_plans_without_writing() {
    let fixture = setup();
    let mut options = options(&fixture);
    options.dry_run = true;

    let planned = publish_hosted(&options).expect("dry run");
    assert!(planned.report.dry_run);
    assert_eq!(planned.report.entries.len(), 1);
    assert!(planned.report.manifest_bytes > 0);
    assert!(!fixture.dest.exists(), "a dry run creates no destination");
}

#[test]
fn publish_is_deterministic_and_idempotent() {
    let fixture = setup();
    let first = publish_hosted(&options(&fixture)).expect("first publish");
    let manifest_first = fs::read(fixture.dest.join(MANIFEST_FILE_NAME)).expect("manifest");
    let body_first = fs::read(&first.paths[0]).expect("body");

    let second = publish_hosted(&options(&fixture)).expect("second publish");
    let manifest_second = fs::read(fixture.dest.join(MANIFEST_FILE_NAME)).expect("manifest");
    let body_second = fs::read(&second.paths[0]).expect("body");

    assert_eq!(first.report, second.report);
    assert_eq!(manifest_first, manifest_second);
    assert_eq!(body_first, body_second);
    assert!(second.report.removed.is_empty());
}

#[test]
fn publish_prunes_stale_bodies_after_the_manifest_is_written() {
    let fixture = setup();
    publish_hosted(&options(&fixture)).expect("first publish");
    let stale = fixture.dest.join("replay.old.2026-11-000000000000.json.gz");
    fs::write(&stale, b"stale gzip body").expect("stale body");

    let published = publish_hosted(&options(&fixture)).expect("second publish");
    assert_eq!(
        published.report.removed,
        vec![stale.file_name().unwrap().to_string_lossy().to_string()]
    );
    assert!(
        !stale.exists(),
        "a body the manifest no longer lists is pruned"
    );
    assert_eq!(names(&fixture.dest).len(), 2);
}

#[test]
fn publish_refuses_foreign_files_in_the_destination_without_touching_them() {
    let fixture = setup();
    fs::create_dir_all(&fixture.dest).expect("dest");
    fs::write(fixture.dest.join("README.md"), b"not a pack artifact").expect("foreign file");

    let error = publish_hosted(&options(&fixture)).expect_err("foreign file refused");
    assert!(matches!(error, PackError::HostRefused { .. }), "{error}");
    assert!(fixture.dest.join("README.md").exists());
    assert!(
        !fixture.dest.join(MANIFEST_FILE_NAME).exists(),
        "a refused publish writes nothing"
    );
}

#[test]
fn subset_publish_replaces_the_hosted_set_and_prunes_the_rest() {
    let fixture = setup();
    let mut second = fixture.pack.clone();
    second.pack_id = PackId::parse("replay.fixture.two").expect("id");
    let games = fixture_games();
    publish_pack(
        &fixture.source,
        &second,
        &PackAuditContext::new(&games),
        FIXTURE_TIME,
    )
    .expect("second pack publishes");
    assert_eq!(
        super::super::load_manifest(&fixture.source.join(MANIFEST_FILE_NAME))
            .expect("manifest")
            .packs
            .len(),
        2
    );

    // Host both first, so the subset publish has one body to prune.
    publish_hosted(&options(&fixture)).expect("full publish");
    let mut options = options(&fixture);
    options.packs = vec![second.pack_id.clone()];
    let published = publish_hosted(&options).expect("subset publish");

    assert_eq!(published.report.entries.len(), 1);
    assert_eq!(published.report.entries[0].id, "replay.fixture.two");
    assert_eq!(published.report.removed.len(), 1);
    assert_eq!(names(&fixture.dest).len(), 2);
    let verified = verify_hosted_dir(&fixture.dest, &HostBudget::default()).expect("verifies");
    assert_eq!(verified.entries[0].id, "replay.fixture.two");
}

#[test]
fn verify_detects_a_tampered_body() {
    let fixture = setup();
    let published = publish_hosted(&options(&fixture)).expect("publish");
    let mut bytes = fs::read(&published.paths[0]).expect("body");
    bytes.push(0);
    fs::write(&published.paths[0], &bytes).expect("tamper");

    let error = verify_hosted_dir(&fixture.dest, &HostBudget::default())
        .expect_err("tampered body rejected");
    let message = error.to_string();
    assert!(matches!(error, PackError::HostInvalid { .. }), "{message}");
    assert!(
        message.contains("bytes") || message.contains("hashes"),
        "the failure names the mismatch: {message}"
    );
}

#[test]
fn verify_refuses_raw_corpus_and_weight_files() {
    let fixture = setup();
    publish_hosted(&options(&fixture)).expect("publish");
    fs::write(
        fixture.dest.join("mortal_298k.safetensors"),
        b"not really weights",
    )
    .expect("weights");

    let error =
        verify_hosted_dir(&fixture.dest, &HostBudget::default()).expect_err("weights rejected");
    assert!(
        error.to_string().contains("raw corpus/weights/database"),
        "{error}"
    );
}

#[test]
fn verify_refuses_a_missing_body_and_an_unlisted_body() {
    let fixture = setup();
    let published = publish_hosted(&options(&fixture)).expect("publish");
    fs::remove_file(&published.paths[0]).expect("remove body");
    let error = verify_hosted_dir(&fixture.dest, &HostBudget::default())
        .expect_err("missing body rejected");
    assert!(matches!(error, PackError::MissingFile(_)), "{error}");

    publish_hosted(&options(&fixture)).expect("restore the hosted body");
    fs::write(fixture.dest.join("stray-000000000000.json.gz"), b"unlisted").expect("stray body");
    let error = verify_hosted_dir(&fixture.dest, &HostBudget::default())
        .expect_err("unlisted body rejected");
    assert!(
        error.to_string().contains("not a manifest-listed"),
        "{error}"
    );
}

#[test]
fn publish_rejects_a_source_that_is_the_destination() {
    let fixture = setup();
    let mut options = options(&fixture);
    options.dest = fixture.source.clone();
    let error = publish_hosted(&options).expect_err("same dir refused");
    assert!(error.to_string().contains("same directory"), "{error}");
}

#[test]
fn publish_rejects_an_empty_manifest_timestamp() {
    let fixture = setup();
    let mut options = options(&fixture);
    options.updated_at = "  ".to_string();
    let error = publish_hosted(&options).expect_err("empty timestamp refused");
    assert!(error.to_string().contains("timestamp is empty"), "{error}");
}

#[test]
fn publish_uses_the_pack_budget_defaults_for_the_source_audit() {
    // A per-pack body over the P1a 50 MB ceiling is already refused by the
    // source audit; hosting does not re-implement that check.
    let fixture = setup();
    let report = publish_hosted(&options(&fixture)).expect("publish");
    assert!(report.report.total_bytes <= PackBudget::default().max_bytes);
}
