//! Directory-level pack audit: the manifest and every body it lists.
//!
//! [`audit_pack_dir`] is what `mine_replays audit` runs. It verifies the
//! manifest's own structure and size, then each entry's path, bytes, SHA-256,
//! decoded pack id/count, the full [`super::gate::audit_pack`] gate, and the
//! convenience metadata the manifest duplicates from the body. Bodies the
//! manifest does not list are a strict-mode warning.
//!
//! Findings here are manifest-level; each pack's own findings live on its
//! [`PackAudit`].

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::miner::provenance::{GameProvenance, is_sha256_hex, sha256_hex};

use super::gate::{
    FindingSeverity, PackAudit, PackAuditContext, PackFinding, PackFindingCode, PublishProfile,
    audit_pack_encoded,
};
use super::model::{ManifestEntry, Pack, render_lesson_counts};
use super::write::{
    GAMES_FILE_NAME, MANIFEST_FILE_NAME, PackBytes, decode_pack, load_games, load_manifest,
    validate_entry,
};
use super::{PackBudget, PackError};

/// Options for a directory audit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditOptions {
    /// The publish intent a commercial profile would refuse.
    pub profile: PublishProfile,
    /// Treat warnings as failures.
    pub strict: bool,
    /// Size and count ceilings.
    pub budget: PackBudget,
}

impl Default for AuditOptions {
    fn default() -> Self {
        Self {
            profile: PublishProfile::NonCommercial,
            strict: false,
            budget: PackBudget::default(),
        }
    }
}

/// The result of auditing a manifest and its bodies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditReport {
    /// The manifest path as given.
    pub manifest: String,
    /// Manifest file bytes.
    pub manifest_bytes: u64,
    /// Whether warnings were treated as failures.
    pub strict: bool,
    /// The publish intent.
    pub profile: PublishProfile,
    /// Manifest-level and file-level findings.
    pub findings: Vec<PackFinding>,
    /// One audit per listed body.
    pub packs: Vec<PackAudit>,
}

impl AuditReport {
    /// Whether the audit passed under its own `strict` setting.
    #[must_use]
    pub fn is_clean(&self) -> bool {
        let manifest_ok = if self.strict {
            self.findings.is_empty()
        } else {
            !self
                .findings
                .iter()
                .any(|finding| finding.severity == FindingSeverity::Error)
        };
        manifest_ok
            && self.packs.iter().all(|audit| {
                if self.strict {
                    audit.is_clean_strict()
                } else {
                    audit.is_clean()
                }
            })
    }

    /// Every failing finding across the manifest and the packs.
    #[must_use]
    pub fn failures(&self) -> Vec<&PackFinding> {
        let mut failures: Vec<&PackFinding> = self
            .findings
            .iter()
            .filter(|finding| finding.severity == FindingSeverity::Error)
            .collect();
        for audit in &self.packs {
            failures.extend(audit.failures());
        }
        failures
    }
}

/// Audit `<dir>/manifest.json`, its bodies and the provenance source.
///
/// `games_path` overrides the default `<dir>/games.jsonl`. A missing default
/// source is a gate failure (every scenario lacks provenance); an explicitly
/// requested missing file is an I/O error.
pub fn audit_pack_dir(
    dir: &Path,
    games_path: Option<&Path>,
    options: &AuditOptions,
) -> Result<AuditReport, PackError> {
    let manifest_path = dir.join(MANIFEST_FILE_NAME);
    let manifest_bytes = fs::metadata(&manifest_path)
        .map_err(|source| PackError::Io {
            path: manifest_path.display().to_string(),
            source,
        })?
        .len();
    let manifest = load_manifest(&manifest_path)?;

    let mut findings = Vec::new();
    if manifest_bytes > options.budget.max_manifest_bytes {
        findings.push(PackFinding::error(
            PackFindingCode::ManifestBudgetExceeded,
            format!(
                "manifest is {manifest_bytes} bytes, over the {} byte ceiling",
                options.budget.max_manifest_bytes
            ),
        ));
    }

    let games = load_provenance(dir, games_path, &mut findings)?;
    let context = PackAuditContext {
        games: &games,
        profile: options.profile,
        budget: options.budget,
    };

    let mut packs = Vec::new();
    let mut listed: BTreeSet<std::path::PathBuf> = BTreeSet::new();
    for entry in &manifest.packs {
        listed.insert(dir.join(&entry.path));
        if let Err(detail) = validate_entry(entry) {
            findings.push(PackFinding::error(
                PackFindingCode::ManifestEntryInvalid,
                format!("`{}`: {detail}", entry.id),
            ));
            continue;
        }
        match audit_entry(dir, entry, &context) {
            Ok((audit, entry_findings)) => {
                findings.extend(entry_findings);
                packs.push(audit);
            }
            Err(PackError::MissingFile(path)) => findings.push(PackFinding::error(
                PackFindingCode::PackFileMissing,
                format!("pack `{}` is missing at `{path}`", entry.id),
            )),
            Err(error) => findings.push(PackFinding::error(
                PackFindingCode::PackFileUnreadable,
                format!("pack `{}`: {error}", entry.id),
            )),
        }
    }

    // A body the manifest forgot is invisible to a loader; strict mode says so.
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(".json.gz"))
            {
                continue;
            }
            if !listed.contains(&path) {
                findings.push(PackFinding::warning(
                    PackFindingCode::UnlistedPackFile,
                    format!("`{}` is not listed in the manifest", path.display()),
                ));
            }
        }
    }

    Ok(AuditReport {
        manifest: manifest_path.display().to_string(),
        manifest_bytes,
        strict: options.strict,
        profile: options.profile,
        findings,
        packs,
    })
}

fn load_provenance(
    dir: &Path,
    games_path: Option<&Path>,
    findings: &mut Vec<PackFinding>,
) -> Result<Vec<GameProvenance>, PackError> {
    let explicit = games_path;
    let path = games_path
        .map(Path::to_path_buf)
        .unwrap_or_else(|| dir.join(GAMES_FILE_NAME));
    if !path.exists() {
        if explicit.is_some() {
            return Err(PackError::MissingGames(path.display().to_string()));
        }
        findings.push(PackFinding::error(
            PackFindingCode::MissingGameProvenance,
            format!(
                "no provenance source at `{}`; every scenario's replay id is unverifiable",
                path.display()
            ),
        ));
        return Ok(Vec::new());
    }
    load_games(&path)
}

fn audit_entry(
    dir: &Path,
    entry: &ManifestEntry,
    context: &PackAuditContext<'_>,
) -> Result<(PackAudit, Vec<PackFinding>), PackError> {
    let path = dir.join(&entry.path);
    let bytes = fs::read(&path).map_err(|source| {
        if source.kind() == std::io::ErrorKind::NotFound {
            PackError::MissingFile(path.display().to_string())
        } else {
            PackError::Io {
                path: path.display().to_string(),
                source,
            }
        }
    })?;
    let mut findings = Vec::new();
    let actual_bytes = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
    if actual_bytes != entry.bytes {
        findings.push(PackFinding::error(
            PackFindingCode::PackFileByteMismatch,
            format!(
                "pack `{}` is {actual_bytes} bytes, but the manifest says {}",
                entry.id, entry.bytes
            ),
        ));
    }
    let actual_sha256 = sha256_hex(&bytes);
    let declared = entry
        .sha256
        .strip_prefix("sha256:")
        .unwrap_or(&entry.sha256);
    if !declared.eq_ignore_ascii_case(&actual_sha256) {
        findings.push(PackFinding::error(
            PackFindingCode::PackFileHashMismatch,
            format!(
                "pack `{}` hashes to {actual_sha256}, but the manifest says {}",
                entry.id, entry.sha256
            ),
        ));
    }
    if !is_sha256_hex(&entry.sha256) {
        findings.push(PackFinding::error(
            PackFindingCode::ManifestEntryInvalid,
            format!("pack `{}` has an invalid sha256", entry.id),
        ));
    }

    let pack = match decode_pack(&bytes) {
        Ok(pack) => pack,
        Err(error) => {
            findings.push(PackFinding::error(
                PackFindingCode::PackFileUnreadable,
                format!("pack `{}`: {error}", entry.id),
            ));
            return Ok((
                PackAudit {
                    pack_id: entry.id.to_string(),
                    scenario_count: 0,
                    bytes: actual_bytes,
                    sha256: actual_sha256,
                    findings: Vec::new(),
                },
                findings,
            ));
        }
    };
    if pack.pack_id != entry.id {
        findings.push(PackFinding::error(
            PackFindingCode::PackIdMismatch,
            format!(
                "body declares pack `{}`, but the manifest entry is `{}`",
                pack.pack_id, entry.id
            ),
        ));
    }
    if pack.scenarios.len() != usize::try_from(entry.scenario_count).unwrap_or(usize::MAX) {
        findings.push(PackFinding::error(
            PackFindingCode::ScenarioCountMismatch,
            format!(
                "body has {} scenarios, but the manifest says {}",
                pack.scenarios.len(),
                entry.scenario_count
            ),
        ));
    }

    findings.extend(manifest_drift(entry, &pack));

    let encoded = PackBytes {
        bytes: bytes.clone(),
        sha256: actual_sha256,
    };
    let audit = audit_pack_encoded(&pack, context, &encoded)?;
    Ok((audit, findings))
}

/// Metadata a loader can recompute. Drift is a warning (strict-only failure),
/// not an integrity failure.
///
/// The exception is `lesson_counts`: it is the per-lesson coverage decision the
/// app makes before downloading a body, so a recorded count that disagrees with
/// the body is an **error**. A manifest that records no counts at all is only a
/// warning, which keeps a manifest published before the field existed auditable.
fn manifest_drift(entry: &ManifestEntry, pack: &Pack) -> Vec<PackFinding> {
    let mut drifted = Vec::new();
    let mut check = |field: &str, manifest: String, body: String| {
        if manifest != body {
            drifted.push(PackFinding::warning(
                PackFindingCode::ManifestMetadataDrift,
                format!(
                    "pack `{}` `{field}` is `{manifest}` in the manifest but `{body}` in the body",
                    entry.id
                ),
            ));
        }
    };
    check(
        "lesson_ids",
        entry.lesson_ids.join(","),
        pack.lesson_ids().join(","),
    );
    check(
        "book_sections",
        entry.book_sections.join(","),
        pack.book_sections().join(","),
    );
    check(
        "licence",
        entry.licence.clone(),
        pack.source.licence.clone(),
    );
    check(
        "requires_model",
        entry.requires_model.to_string(),
        pack.requires_model().to_string(),
    );
    check(
        "data_commercial_use",
        entry.data_commercial_use.to_string(),
        pack.source.data_commercial_use.to_string(),
    );

    let body_counts = pack.lesson_counts();
    if entry.lesson_counts.is_empty() {
        drifted.push(PackFinding::warning(
            PackFindingCode::LessonCountsMissing,
            format!(
                "pack `{}` records no lesson_counts; republish with `pack publish` so coverage needs no body download",
                entry.id
            ),
        ));
    } else if entry.lesson_counts != body_counts {
        drifted.push(PackFinding::error(
            PackFindingCode::LessonCountMismatch,
            format!(
                "pack `{}` lesson_counts are `{}` in the manifest but `{}` in the body",
                entry.id,
                render_lesson_counts(&entry.lesson_counts),
                render_lesson_counts(&body_counts)
            ),
        ));
    }
    drifted
}
