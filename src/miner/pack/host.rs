//! Same-origin pack hosting (implementation unit P2).
//!
//! The miner's export directory (`$RIICHI_DATA_DIR/packs/`) is the audited
//! source of truth: a P1b `pack assemble` / P1a `pack fixture` run writes the
//! content-addressed bodies, the manifest and the `games.jsonl` provenance
//! rows. The browser never reads that directory. It reads a **hosting
//! directory** (`frontend/public/scenarios/`), which Vite copies verbatim into
//! the Pages artifact:
//!
//! ```text
//! frontend/public/scenarios/
//! ├── manifest.json                              # same-origin, small
//! └── <pack-id>-<sha256-prefix>.json.gz          # content-addressed bodies
//! ```
//!
//! [`publish_hosted`] is the only way to produce it. It:
//!
//! 1. re-runs the full directory audit ([`audit_pack_dir`], the G0/G8 gate) on
//!    the source, including the `games.jsonl` provenance rows, and refuses a
//!    dirty source;
//! 2. selects every manifest entry, or only the requested pack ids;
//! 3. enforces the same-origin byte budget ([`HostBudget`], default 50 MB) and
//!    the manifest ceiling — an over-budget set is refused, never trimmed (the
//!    operator moves it to the R2/HF mirror instead);
//! 4. copies only the content-addressed bodies. `games.jsonl`, raw replay logs,
//!    weights and any other source file stay out of the artifact;
//! 5. writes the manifest atomically and prunes `.json.gz` bodies the new
//!    manifest no longer lists, so an obsolete pack does not inflate the Pages
//!    artifact;
//! 6. re-verifies the staged directory ([`verify_hosted_dir`]) before returning.
//!
//! The manifest keeps every path relative, so it works unchanged for a
//! same-origin load and for the optional external mirror: a loader tries the
//! same-origin `manifest.json` and body first and then `<mirror-base>/<path>`.
//! Google Drive is a corpus/DB backup, never a runtime host. GitHub Release
//! assets send no CORS headers, so they are only a CI copy source (see
//! [`super::super::super::hosting-plan.md`]); an R2/HF mirror is the
//! browser-fetchable copy.
//!
//! `scripts/check-pack-hosting.mjs` is the dependency-free CI gate for the
//! artifact and `scripts/check-pack-cors.mjs` measures a mirror. They print
//! numbers and pass/fail; they do not judge anything visually (AGENTS.md §6).

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::miner::provenance::{is_sha256_hex, sha256_hex};
use crate::miner::storage;

use super::audit::{AuditOptions, audit_pack_dir};
use super::gate::PublishProfile;
use super::model::{ManifestEntry, PackId, PackManifest, render_lesson_counts};
use super::write::{
    MANIFEST_FILE_NAME, decode_pack, encode_manifest, load_manifest, validate_entry,
};
use super::{DEFAULT_MAX_MANIFEST_BYTES, PackBudget, PackError};

/// Default ceiling for every hosted pack body together: the P2 same-origin
/// budget. The AGENTS.md asset budget is mostly consumed by the rendered-view
/// assets, so a pack set larger than this moves to the R2/HF mirror.
pub const DEFAULT_MAX_HOSTED_BYTES: u64 = 50_000_000;

/// Same-origin hosting limits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostBudget {
    /// Maximum summed bytes of every hosted pack body.
    pub max_total_bytes: u64,
    /// Maximum manifest bytes. The manifest is fetched on every page visit.
    pub max_manifest_bytes: u64,
}

impl Default for HostBudget {
    fn default() -> Self {
        Self {
            max_total_bytes: DEFAULT_MAX_HOSTED_BYTES,
            max_manifest_bytes: DEFAULT_MAX_MANIFEST_BYTES,
        }
    }
}

impl HostBudget {
    /// The defaults with a different total-body ceiling.
    #[must_use]
    pub fn with_max_total_bytes(max_total_bytes: u64) -> Self {
        Self {
            max_total_bytes,
            ..Self::default()
        }
    }
}

/// One hosting publish request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostOptions {
    /// Audited export directory (`$RIICHI_DATA_DIR/packs/`).
    pub source: PathBuf,
    /// Same-origin hosting directory (`frontend/public/scenarios/`).
    pub dest: PathBuf,
    /// Pack ids to host. Empty means every entry in the source manifest; a
    /// non-empty list replaces the hosted set with exactly those packs.
    pub packs: Vec<PackId>,
    /// Publish intent the source audit checks (a commercial profile refuses
    /// Akochan or otherwise non-commercial data).
    pub profile: PublishProfile,
    /// Byte ceilings.
    pub budget: HostBudget,
    /// Manifest `updated_at` timestamp.
    pub updated_at: String,
    /// Report without writing or pruning anything.
    pub dry_run: bool,
}

impl HostOptions {
    /// All defaults for a full publish of `source` into `dest`.
    #[must_use]
    pub fn new(
        source: impl Into<PathBuf>,
        dest: impl Into<PathBuf>,
        updated_at: impl Into<String>,
    ) -> Self {
        Self {
            source: source.into(),
            dest: dest.into(),
            packs: Vec::new(),
            profile: PublishProfile::NonCommercial,
            budget: HostBudget::default(),
            updated_at: updated_at.into(),
            dry_run: false,
        }
    }
}

/// One hosted pack in a [`HostReport`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostedEntry {
    /// Pack id.
    pub id: String,
    /// Relative body path inside the hosting directory.
    pub path: String,
    /// SHA-256 of the exact hosted bytes.
    pub sha256: String,
    /// Body length in bytes.
    pub bytes: u64,
    /// Scenario count.
    pub scenario_count: u32,
    /// Shipped reviewed bases per lesson id.
    pub lesson_counts: BTreeMap<String, u32>,
    /// Pack data licence id.
    pub licence: String,
}

impl HostedEntry {
    fn from_entry(entry: &ManifestEntry) -> Self {
        Self {
            id: entry.id.to_string(),
            path: entry.path.clone(),
            sha256: entry.sha256.clone(),
            bytes: entry.bytes,
            scenario_count: entry.scenario_count,
            lesson_counts: entry.lesson_counts.clone(),
            licence: entry.licence.clone(),
        }
    }
}

/// The result of a publish or verification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostReport {
    /// Source export directory, or the verified directory for a verification.
    pub source: String,
    /// Hosting directory.
    pub dest: String,
    /// Total-body byte ceiling that applied.
    pub budget_bytes: u64,
    /// Manifest bytes.
    pub manifest_bytes: u64,
    /// Summed hosted body bytes.
    pub total_bytes: u64,
    /// One row per hosted pack, sorted by id.
    pub entries: Vec<HostedEntry>,
    /// Stale body filenames removed (or that a dry run would remove).
    pub removed: Vec<String>,
    /// Whether this was a dry run.
    pub dry_run: bool,
}

impl HostReport {
    /// Lines for the human CLI report.
    #[must_use]
    pub fn human_summary(&self) -> Vec<String> {
        let mut lines = vec![
            format!("source: {}", self.source),
            format!("hosted: {}", self.dest),
            format!(
                "{} pack(s), {} body bytes of {} allowed, {} byte manifest{}",
                self.entries.len(),
                self.total_bytes,
                self.budget_bytes,
                self.manifest_bytes,
                if self.dry_run { " (dry run)" } else { "" }
            ),
        ];
        for entry in &self.entries {
            lines.push(format!(
                "  {} · {} B · {} scenario(s) · {}",
                entry.id, entry.bytes, entry.scenario_count, entry.path
            ));
            if !entry.lesson_counts.is_empty() {
                lines.push(format!(
                    "    coverage: {}",
                    render_lesson_counts(&entry.lesson_counts)
                ));
            }
        }
        if !self.removed.is_empty() {
            let verb = if self.dry_run {
                "would remove"
            } else {
                "removed"
            };
            lines.push(format!(
                "  {verb} {} stale body/bodies: {}",
                self.removed.len(),
                self.removed.join(", ")
            ));
        }
        lines
    }
}

/// A publish that wrote (or, in a dry run, planned) the hosting directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedPublish {
    /// What was published.
    pub report: HostReport,
    /// The staged manifest path.
    pub manifest_path: PathBuf,
    /// Every staged body path.
    pub paths: Vec<PathBuf>,
}

/// Stage audited packs into a same-origin hosting directory.
///
/// Refuses an unaudited/dirty source, an unknown pack id, an over-budget set
/// and a destination that holds files this command does not own. Bodies and the
/// manifest are written atomically, stale `.json.gz` bodies are pruned, and the
/// result is read back through [`verify_hosted_dir`].
pub fn publish_hosted(options: &HostOptions) -> Result<HostedPublish, PackError> {
    if options.source == options.dest {
        return Err(PackError::HostRefused {
            detail: format!(
                "source and destination are the same directory (`{}`); publish to a copy",
                options.source.display()
            ),
        });
    }
    if options.updated_at.trim().is_empty() {
        return Err(PackError::HostRefused {
            detail: "the manifest `updated_at` timestamp is empty".to_string(),
        });
    }

    let audit_options = AuditOptions {
        profile: options.profile,
        strict: false,
        budget: PackBudget::default(),
    };
    let audit = audit_pack_dir(&options.source, None, &audit_options)?;
    if !audit.is_clean() {
        return Err(PackError::HostRefused {
            detail: format!(
                "source `{}` did not pass the pack audit: {}",
                options.source.display(),
                audit_failure_detail(&audit)
            ),
        });
    }

    let source_manifest = load_manifest(&options.source.join(MANIFEST_FILE_NAME))?;
    let requested = resolve_entries(&source_manifest, &options.packs)?;
    if requested.is_empty() {
        return Err(PackError::HostRefused {
            detail: format!(
                "`{}` lists no packs; run `pack assemble` or `pack fixture` first",
                options.source.display()
            ),
        });
    }
    for entry in &requested {
        validate_entry(entry).map_err(|detail| PackError::HostRefused {
            detail: format!("pack `{}`: {detail}", entry.id),
        })?;
    }

    // Read and verify every selected body once, and take the per-lesson coverage
    // from the decoded body. `pack publish` is what writes the hosting manifest,
    // so it always records `lesson_counts`, including for a source manifest that
    // predates the field. Never copy a stale count declaration into the artifact.
    let mut staged: Vec<(ManifestEntry, Vec<u8>)> = Vec::with_capacity(requested.len());
    for entry in &requested {
        let source_path = options.source.join(&entry.path);
        let bytes = fs::read(&source_path).map_err(|source| PackError::Io {
            path: source_path.display().to_string(),
            source,
        })?;
        let actual_bytes = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
        if actual_bytes != entry.bytes {
            return Err(PackError::HostInvalid {
                path: source_path.display().to_string(),
                detail: format!(
                    "pack `{}` is {actual_bytes} bytes, but the manifest says {}",
                    entry.id, entry.bytes
                ),
            });
        }
        let actual_sha256 = sha256_hex(&bytes);
        if !hash_matches(&entry.sha256, &actual_sha256) {
            return Err(PackError::HostInvalid {
                path: source_path.display().to_string(),
                detail: format!(
                    "pack `{}` hashes to {actual_sha256}, but the manifest says {}",
                    entry.id, entry.sha256
                ),
            });
        }
        let pack = decode_pack(&bytes)?;
        if pack.pack_id != entry.id {
            return Err(PackError::HostInvalid {
                path: source_path.display().to_string(),
                detail: format!(
                    "body declares pack `{}`, but the manifest entry is `{}`",
                    pack.pack_id, entry.id
                ),
            });
        }
        let entry = entry.with_lesson_counts(&pack);
        validate_entry(&entry).map_err(|detail| PackError::HostInvalid {
            path: source_path.display().to_string(),
            detail: format!("pack `{}`: {detail}", entry.id),
        })?;
        staged.push((entry, bytes));
    }
    let selected: Vec<ManifestEntry> = staged.iter().map(|(entry, _bytes)| entry.clone()).collect();

    let declared_bytes = selected.iter().map(|entry| entry.bytes).sum::<u64>();
    if declared_bytes > options.budget.max_total_bytes {
        return Err(PackError::HostBudgetExceeded {
            what: "hosted body bytes",
            bytes: declared_bytes,
            max: options.budget.max_total_bytes,
        });
    }

    let manifest = PackManifest {
        schema: source_manifest.schema.clone(),
        version: source_manifest.version,
        updated_at: options.updated_at.clone(),
        packs: selected.clone(),
    };
    let manifest_bytes = u64::try_from(encode_manifest(&manifest)?.len()).unwrap_or(u64::MAX);
    if manifest_bytes > options.budget.max_manifest_bytes {
        return Err(PackError::HostBudgetExceeded {
            what: "manifest bytes",
            bytes: manifest_bytes,
            max: options.budget.max_manifest_bytes,
        });
    }

    let stale = scan_destination(&options.dest, &manifest)?;

    if options.dry_run {
        return Ok(HostedPublish {
            report: HostReport {
                source: options.source.display().to_string(),
                dest: options.dest.display().to_string(),
                budget_bytes: options.budget.max_total_bytes,
                manifest_bytes,
                total_bytes: declared_bytes,
                entries: selected.iter().map(HostedEntry::from_entry).collect(),
                removed: stale,
                dry_run: true,
            },
            manifest_path: options.dest.join(MANIFEST_FILE_NAME),
            paths: selected
                .iter()
                .map(|entry| options.dest.join(&entry.path))
                .collect(),
        });
    }

    fs::create_dir_all(&options.dest).map_err(|source| PackError::Io {
        path: options.dest.display().to_string(),
        source,
    })?;

    // Copy only the content-addressed bodies. This is deliberately an allowlist:
    // games.jsonl, raw .jsonl.gz replays, weights and any stray source file are
    // never part of the Pages artifact.
    let mut paths = Vec::with_capacity(staged.len());
    for (entry, bytes) in &staged {
        let dest_path = options.dest.join(&entry.path);
        storage::write_atomic(&dest_path, bytes)?;
        paths.push(dest_path);
    }

    let manifest_path = options.dest.join(MANIFEST_FILE_NAME);
    super::write::write_manifest_atomic(&manifest_path, &manifest)?;

    // Prune bodies the new manifest no longer lists only after the manifest is
    // durable, so a failure never leaves the directory listing a missing body.
    for name in &stale {
        let path = options.dest.join(name);
        if let Err(error) = fs::remove_file(&path)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            return Err(PackError::Io {
                path: path.display().to_string(),
                source: error,
            });
        }
    }

    let verified = verify_hosted_dir(&options.dest, &options.budget)?;
    let expected: Vec<String> = selected.iter().map(|entry| entry.id.to_string()).collect();
    let actual: Vec<String> = verified
        .entries
        .iter()
        .map(|entry| entry.id.clone())
        .collect();
    if expected != actual {
        return Err(PackError::HostInvalid {
            path: options.dest.display().to_string(),
            detail: format!(
                "staged manifest lists {actual:?}, expected {expected:?} after publishing"
            ),
        });
    }

    Ok(HostedPublish {
        report: HostReport {
            source: options.source.display().to_string(),
            dest: options.dest.display().to_string(),
            budget_bytes: options.budget.max_total_bytes,
            manifest_bytes: verified.manifest_bytes,
            total_bytes: verified.total_bytes,
            entries: verified.entries,
            removed: stale,
            dry_run: false,
        },
        manifest_path,
        paths,
    })
}

/// Verify a staged hosting directory against its own manifest.
///
/// This is the read-back half of [`publish_hosted`] and is safe to run on an
/// artifact: it never trusts a filename, it re-hashes every body, decodes it
/// and compares the manifest's convenience metadata with the body. It also
/// refuses a directory that holds a file this layout does not define, so a raw
/// replay, database or weights file cannot ride along with the packs.
pub fn verify_hosted_dir(dir: &Path, budget: &HostBudget) -> Result<HostReport, PackError> {
    let manifest_path = dir.join(MANIFEST_FILE_NAME);
    let manifest_bytes = fs::metadata(&manifest_path)
        .map_err(|source| PackError::Io {
            path: manifest_path.display().to_string(),
            source,
        })?
        .len();
    if manifest_bytes > budget.max_manifest_bytes {
        return Err(PackError::HostBudgetExceeded {
            what: "manifest bytes",
            bytes: manifest_bytes,
            max: budget.max_manifest_bytes,
        });
    }
    let manifest = load_manifest(&manifest_path)?;
    let expected_files: BTreeSet<String> = manifest
        .packs
        .iter()
        .map(|entry| entry.path.clone())
        .collect();

    let mut total_bytes = 0u64;
    let mut entries = Vec::with_capacity(manifest.packs.len());
    for entry in &manifest.packs {
        validate_entry(entry).map_err(|detail| PackError::HostInvalid {
            path: manifest_path.display().to_string(),
            detail: format!("pack `{}`: {detail}", entry.id),
        })?;
        let body_path = dir.join(&entry.path);
        let bytes = fs::read(&body_path).map_err(|source| {
            if source.kind() == std::io::ErrorKind::NotFound {
                PackError::MissingFile(body_path.display().to_string())
            } else {
                PackError::Io {
                    path: body_path.display().to_string(),
                    source,
                }
            }
        })?;
        let actual_bytes = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
        if actual_bytes != entry.bytes {
            return Err(PackError::HostInvalid {
                path: body_path.display().to_string(),
                detail: format!(
                    "pack `{}` is {actual_bytes} bytes, but the manifest says {}",
                    entry.id, entry.bytes
                ),
            });
        }
        let actual_sha256 = sha256_hex(&bytes);
        if !hash_matches(&entry.sha256, &actual_sha256) {
            return Err(PackError::HostInvalid {
                path: body_path.display().to_string(),
                detail: format!(
                    "pack `{}` hashes to {actual_sha256}, but the manifest says {}",
                    entry.id, entry.sha256
                ),
            });
        }
        total_bytes = total_bytes.saturating_add(actual_bytes);

        let pack = decode_pack(&bytes)?;
        if pack.pack_id != entry.id {
            return Err(PackError::HostInvalid {
                path: body_path.display().to_string(),
                detail: format!(
                    "body declares pack `{}`, but the manifest entry is `{}`",
                    pack.pack_id, entry.id
                ),
            });
        }
        if pack.scenarios.len() != usize::try_from(entry.scenario_count).unwrap_or(usize::MAX) {
            return Err(PackError::HostInvalid {
                path: body_path.display().to_string(),
                detail: format!(
                    "body has {} scenario(s), but the manifest says {}",
                    pack.scenarios.len(),
                    entry.scenario_count
                ),
            });
        }
        // Coverage is what the app reads without a body download, so a hosted
        // artifact must record it and it must agree with the body. A count that
        // is absent would silently make a covered lesson look uncovered.
        let body_counts = pack.lesson_counts();
        if entry.lesson_counts.is_empty() {
            return Err(PackError::HostInvalid {
                path: body_path.display().to_string(),
                detail: format!(
                    "pack `{}` records no lesson_counts; republish with `pack publish`",
                    entry.id
                ),
            });
        }
        if entry.lesson_counts != body_counts {
            return Err(PackError::HostInvalid {
                path: body_path.display().to_string(),
                detail: format!(
                    "pack `{}` lesson_counts are `{}` in the manifest but `{}` in the body",
                    entry.id,
                    render_lesson_counts(&entry.lesson_counts),
                    render_lesson_counts(&body_counts)
                ),
            });
        }
        for (field, manifest_value, body_value) in [
            (
                "lesson_ids",
                entry.lesson_ids.join(","),
                pack.lesson_ids().join(","),
            ),
            (
                "book_sections",
                entry.book_sections.join(","),
                pack.book_sections().join(","),
            ),
            (
                "licence",
                entry.licence.clone(),
                pack.source.licence.clone(),
            ),
            (
                "requires_model",
                entry.requires_model.to_string(),
                pack.requires_model().to_string(),
            ),
            (
                "data_commercial_use",
                entry.data_commercial_use.to_string(),
                pack.source.data_commercial_use.to_string(),
            ),
        ] {
            if manifest_value != body_value {
                return Err(PackError::HostInvalid {
                    path: body_path.display().to_string(),
                    detail: format!(
                        "pack `{}` `{field}` is `{manifest_value}` in the manifest but `{body_value}` in the body",
                        entry.id
                    ),
                });
            }
        }
        entries.push(HostedEntry::from_entry(entry));
    }

    if total_bytes > budget.max_total_bytes {
        return Err(PackError::HostBudgetExceeded {
            what: "hosted body bytes",
            bytes: total_bytes,
            max: budget.max_total_bytes,
        });
    }

    // Every file in the directory must be one this layout defines.
    let listed: BTreeSet<String> = expected_files;
    for name in read_dir_names(dir)? {
        if name == MANIFEST_FILE_NAME {
            continue;
        }
        if name.ends_with(".json.gz") && listed.contains(&name) {
            continue;
        }
        return Err(PackError::HostInvalid {
            path: dir.join(&name).display().to_string(),
            detail: if is_forbidden_artifact(&name) {
                format!("`{name}` is a raw corpus/weights/database artifact and must not be hosted")
            } else {
                format!("`{name}` is not a manifest-listed pack body")
            },
        });
    }

    Ok(HostReport {
        source: dir.display().to_string(),
        dest: dir.display().to_string(),
        budget_bytes: budget.max_total_bytes,
        manifest_bytes,
        total_bytes,
        entries,
        removed: Vec::new(),
        dry_run: false,
    })
}

/// Resolve the requested ids against the source manifest.
fn resolve_entries(
    manifest: &PackManifest,
    wanted: &[PackId],
) -> Result<Vec<ManifestEntry>, PackError> {
    if wanted.is_empty() {
        return Ok(manifest.packs.clone());
    }
    let available: Vec<&str> = manifest
        .packs
        .iter()
        .map(|entry| entry.id.as_str())
        .collect();
    let mut chosen: BTreeMap<String, ManifestEntry> = BTreeMap::new();
    for id in wanted {
        let Some(entry) = manifest.entry(id) else {
            return Err(PackError::HostRefused {
                detail: format!(
                    "pack `{id}` is not in the source manifest (available: {})",
                    if available.is_empty() {
                        "none".to_string()
                    } else {
                        available.join(", ")
                    }
                ),
            });
        };
        chosen.insert(entry.id.as_str().to_string(), entry.clone());
    }
    Ok(chosen.into_values().collect())
}

/// Refuse a destination that holds a file this command does not own, and return
/// the `.json.gz` bodies the new manifest no longer lists.
fn scan_destination(dest: &Path, manifest: &PackManifest) -> Result<Vec<String>, PackError> {
    if !dest.exists() {
        return Ok(Vec::new());
    }
    let listed: BTreeSet<&str> = manifest
        .packs
        .iter()
        .map(|entry| entry.path.as_str())
        .collect();
    let mut stale = Vec::new();
    for name in read_dir_names(dest)? {
        if name == MANIFEST_FILE_NAME {
            continue;
        }
        if name.ends_with(".json.gz") {
            if !listed.contains(name.as_str()) {
                stale.push(name);
            }
            continue;
        }
        return Err(PackError::HostRefused {
            detail: format!(
                "`{}` holds `{name}`, which is not a pack manifest or body; point `--to` at the dedicated hosting directory",
                dest.display()
            ),
        });
    }
    Ok(stale)
}

fn read_dir_names(dir: &Path) -> Result<Vec<String>, PackError> {
    let entries = fs::read_dir(dir).map_err(|source| PackError::Io {
        path: dir.display().to_string(),
        source,
    })?;
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|source| PackError::Io {
            path: dir.display().to_string(),
            source,
        })?;
        let file_type = entry.file_type().map_err(|source| PackError::Io {
            path: entry.path().display().to_string(),
            source,
        })?;
        if !file_type.is_file() {
            return Err(PackError::HostInvalid {
                path: entry.path().display().to_string(),
                detail: "the hosting directory must contain only files".to_string(),
            });
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            return Err(PackError::HostInvalid {
                path: entry.path().display().to_string(),
                detail: "the hosting directory must not contain hidden files".to_string(),
            });
        }
        names.push(name);
    }
    names.sort();
    Ok(names)
}

fn audit_failure_detail(report: &super::audit::AuditReport) -> String {
    let failures = report.failures();
    let detail: Vec<String> = failures
        .iter()
        .take(3)
        .map(|finding| format!("{:?}: {}", finding.code, finding.detail))
        .collect();
    format!("{} failure(s); {}", failures.len(), detail.join("; "))
}

fn hash_matches(declared: &str, actual: &str) -> bool {
    let declared = declared.strip_prefix("sha256:").unwrap_or(declared);
    is_sha256_hex(declared) && declared.eq_ignore_ascii_case(actual)
}

fn is_forbidden_artifact(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [
        ".safetensors",
        ".pth",
        ".bin",
        ".sqlite",
        ".sqlite-wal",
        ".sqlite-shm",
        ".duckdb",
        ".jsonl",
        ".jsonl.gz",
        ".weights",
    ]
    .iter()
    .any(|suffix| lower.ends_with(suffix))
}

#[cfg(test)]
mod tests;
