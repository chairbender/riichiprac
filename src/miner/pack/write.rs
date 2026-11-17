//! Deterministic pack encoding, content-addressed writing and the manifest.
//!
//! [`encode_pack`] is the only encoder: compact struct-order JSON in a gzip
//! stream with a fixed level and no header timestamp, so the same pack always
//! produces the same bytes and SHA-256. [`publish_pack`] audits first, writes
//! the body with [`crate::miner::storage::write_atomic`], then updates the
//! manifest the same way. Each file is either the previous bytes or the complete
//! new bytes; a failed manifest write removes a body this call created.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use flate2::Compression;
use flate2::read::MultiGzDecoder;
use flate2::write::GzEncoder;

use crate::miner::licence::allowed_data_licence;
use crate::miner::provenance::{GameProvenance, is_sha256_hex, sha256_hex};
use crate::miner::storage::{self, validate_relative_path};

use super::gate::{PackAudit, PackAuditContext, audit_pack_encoded};
use super::model::{ManifestEntry, Pack, PackId, PackManifest};
use super::{GZIP_LEVEL, PackError};

/// The runtime manifest's filename inside a pack directory.
pub const MANIFEST_FILE_NAME: &str = "manifest.json";

/// The fixture publisher's provenance file inside a pack directory.
pub const GAMES_FILE_NAME: &str = "games.jsonl";

/// SHAs are truncated to this many hex characters in a content-addressed
/// filename. The manifest carries the full hash.
const FILENAME_SHA_PREFIX: usize = 12;

/// Encoded pack bytes and their hash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackBytes {
    /// The exact gzip bytes a publisher writes.
    pub bytes: Vec<u8>,
    /// SHA-256 of `bytes`, lowercase hex.
    pub sha256: String,
}

impl PackBytes {
    /// Body length in bytes.
    #[must_use]
    pub fn len(&self) -> u64 {
        u64::try_from(self.bytes.len()).unwrap_or(u64::MAX)
    }

    /// Whether the body is empty (it never is for a valid pack).
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }
}

/// Deterministically encode a pack body.
pub fn encode_pack(pack: &Pack) -> Result<PackBytes, PackError> {
    let json = serde_json::to_vec(pack).map_err(|source| PackError::Json {
        path: "<pack>".to_string(),
        source,
    })?;
    let mut encoder = GzEncoder::new(Vec::new(), Compression::new(GZIP_LEVEL));
    encoder.write_all(&json).map_err(|error| PackError::Gzip {
        path: "<pack>".to_string(),
        message: error.to_string(),
    })?;
    let bytes = encoder.finish().map_err(|error| PackError::Gzip {
        path: "<pack>".to_string(),
        message: error.to_string(),
    })?;
    let sha256 = sha256_hex(&bytes);
    Ok(PackBytes { bytes, sha256 })
}

/// Decode an in-memory gzip pack body.
pub fn decode_pack(bytes: &[u8]) -> Result<Pack, PackError> {
    let mut decoder = MultiGzDecoder::new(bytes);
    let mut json = Vec::new();
    decoder
        .read_to_end(&mut json)
        .map_err(|error| PackError::Gzip {
            path: "<memory>".to_string(),
            message: error.to_string(),
        })?;
    serde_json::from_slice(&json).map_err(|source| PackError::Json {
        path: "<memory>".to_string(),
        source,
    })
}

/// Read and decode one pack file.
pub fn read_pack(path: &Path) -> Result<Pack, PackError> {
    let bytes = fs::read(path).map_err(|source| PackError::Io {
        path: path.display().to_string(),
        source,
    })?;
    let mut decoder = MultiGzDecoder::new(bytes.as_slice());
    let mut json = Vec::new();
    decoder
        .read_to_end(&mut json)
        .map_err(|error| PackError::Gzip {
            path: path.display().to_string(),
            message: error.to_string(),
        })?;
    serde_json::from_slice(&json).map_err(|source| PackError::Json {
        path: path.display().to_string(),
        source,
    })
}

/// The content-addressed body filename `"<pack-id>-<sha-prefix>.json.gz"`.
pub fn pack_file_name(pack_id: &PackId, sha256: &str) -> Result<String, PackError> {
    if !is_sha256_hex(sha256) {
        return Err(PackError::Invalid {
            pack_id: pack_id.to_string(),
            detail: format!("`{sha256}` is not a SHA-256 for the pack filename"),
        });
    }
    let raw = sha256.strip_prefix("sha256:").unwrap_or(sha256);
    let prefix = &raw[..FILENAME_SHA_PREFIX];
    Ok(format!("{pack_id}-{prefix}.json.gz"))
}

/// Parse and validate a manifest, fail-closed.
pub fn load_manifest(path: &Path) -> Result<PackManifest, PackError> {
    let bytes = fs::read(path).map_err(|source| PackError::Io {
        path: path.display().to_string(),
        source,
    })?;
    let manifest: PackManifest =
        serde_json::from_slice(&bytes).map_err(|source| PackError::Json {
            path: path.display().to_string(),
            source,
        })?;
    validate_manifest(&manifest).map_err(|detail| PackError::Manifest {
        path: path.display().to_string(),
        detail,
    })?;
    Ok(manifest)
}

/// Read a manifest, or start a new empty one when the file does not exist.
pub fn read_manifest_or_default(path: &Path, updated_at: &str) -> Result<PackManifest, PackError> {
    if path.exists() {
        load_manifest(path)
    } else {
        Ok(PackManifest::new(updated_at))
    }
}

/// Write the manifest atomically, with a trailing newline for a clean diff.
pub fn write_manifest_atomic(path: &Path, manifest: &PackManifest) -> Result<(), PackError> {
    validate_manifest(manifest).map_err(|detail| PackError::Manifest {
        path: path.display().to_string(),
        detail,
    })?;
    let mut json = serde_json::to_vec_pretty(manifest).map_err(|source| PackError::Json {
        path: path.display().to_string(),
        source,
    })?;
    json.push(b'\n');
    storage::write_atomic(path, &json).map_err(PackError::from)
}

fn validate_manifest(manifest: &PackManifest) -> Result<(), String> {
    if manifest.schema != super::model::MANIFEST_SCHEMA {
        return Err(format!(
            "schema is `{}`, expected `{}`",
            manifest.schema,
            super::model::MANIFEST_SCHEMA
        ));
    }
    if manifest.version != super::model::PACK_VERSION {
        return Err(format!(
            "version {} is not supported (expected {})",
            manifest.version,
            super::model::PACK_VERSION
        ));
    }
    if manifest.updated_at.trim().is_empty() {
        return Err("`updated_at` is empty".to_string());
    }
    let mut ids = std::collections::BTreeSet::new();
    for entry in &manifest.packs {
        if !ids.insert(entry.id.clone()) {
            return Err(format!("pack id `{}` appears twice", entry.id));
        }
        validate_entry(entry)?;
    }
    Ok(())
}

/// Validate one manifest entry's shape and content-addressed filename.
pub(crate) fn validate_entry(entry: &ManifestEntry) -> Result<(), String> {
    validate_relative_path(&entry.path).map_err(|error| error.to_string())?;
    if !entry.has_valid_hash() {
        return Err(format!(
            "pack `{}` has an invalid sha256 `{}`",
            entry.id, entry.sha256
        ));
    }
    let expected_name =
        pack_file_name(&entry.id, &entry.sha256).map_err(|error| error.to_string())?;
    let actual_name = Path::new(&entry.path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    if actual_name != expected_name {
        return Err(format!(
            "pack `{}` path `{}` does not end in `{expected_name}`",
            entry.id, entry.path
        ));
    }
    if entry.bytes == 0 {
        return Err(format!("pack `{}` has zero bytes", entry.id));
    }
    if entry.scenario_count == 0 {
        return Err(format!("pack `{}` has no scenarios", entry.id));
    }
    if !allowed_data_licence(&entry.licence) {
        return Err(format!(
            "pack `{}` declares data licence `{}`, which is not on the allowlist",
            entry.id, entry.licence
        ));
    }
    let lessons = sorted_unique(&entry.lesson_ids);
    if lessons != entry.lesson_ids {
        return Err(format!(
            "pack `{}` lesson_ids are not sorted and unique",
            entry.id
        ));
    }
    let sections = sorted_unique(&entry.book_sections);
    if sections != entry.book_sections {
        return Err(format!(
            "pack `{}` book_sections are not sorted and unique",
            entry.id
        ));
    }
    Ok(())
}

fn sorted_unique(values: &[String]) -> Vec<String> {
    let mut sorted = values.to_vec();
    sorted.sort();
    sorted.dedup();
    sorted
}

/// Insert or replace one entry in `<dir>/manifest.json` atomically.
pub fn upsert_manifest_entry(
    dir: &Path,
    entry: ManifestEntry,
    updated_at: &str,
) -> Result<PackManifest, PackError> {
    let path = dir.join(MANIFEST_FILE_NAME);
    let mut manifest = read_manifest_or_default(&path, updated_at)?;
    manifest.updated_at = updated_at.to_string();
    manifest.upsert(entry);
    write_manifest_atomic(&path, &manifest)?;
    Ok(manifest)
}

/// A pack body and manifest that were written successfully.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishedPack {
    /// The manifest entry as written.
    pub entry: ManifestEntry,
    /// Absolute or caller-relative path of the body.
    pub path: PathBuf,
    /// The manifest the entry was merged into.
    pub manifest_path: PathBuf,
    /// The audit the publish passed.
    pub audit: PackAudit,
}

/// Audit, write the body atomically, then update the manifest atomically.
///
/// The body is content-addressed, so re-publishing an unchanged pack rewrites
/// the same file with the same bytes. A dirty pack is never written.
pub fn publish_pack(
    dir: &Path,
    pack: &Pack,
    context: &PackAuditContext<'_>,
    updated_at: &str,
) -> Result<PublishedPack, PackError> {
    let encoded = encode_pack(pack)?;
    let audit = audit_pack_encoded(pack, context, &encoded)?;
    if !audit.is_clean() {
        return Err(PackError::AuditFailed(Box::new(audit)));
    }

    fs::create_dir_all(dir).map_err(|source| PackError::Io {
        path: dir.display().to_string(),
        source,
    })?;
    let file_name = pack_file_name(&pack.pack_id, &encoded.sha256)?;
    let path = dir.join(&file_name);
    let existed = path.exists();
    storage::write_atomic(&path, &encoded.bytes)?;

    let entry = ManifestEntry::new(pack, file_name, encoded.sha256.clone(), encoded.len());
    let manifest_path = dir.join(MANIFEST_FILE_NAME);
    if let Err(error) = upsert_manifest_entry(dir, entry.clone(), updated_at) {
        if !existed {
            // Do not leave a body the manifest never references.
            let _ = fs::remove_file(&path);
        }
        return Err(error);
    }

    Ok(PublishedPack {
        entry,
        path,
        manifest_path,
        audit,
    })
}

/// Encode game-provenance rows as JSONL.
pub fn encode_games(games: &[GameProvenance]) -> Result<Vec<u8>, PackError> {
    let mut out = Vec::new();
    for game in games {
        let line = serde_json::to_vec(game).map_err(|source| PackError::Json {
            path: "<games>".to_string(),
            source,
        })?;
        out.extend_from_slice(&line);
        out.push(b'\n');
    }
    Ok(out)
}

/// Write the fixture/audit provenance rows to `<dir>/games.jsonl` atomically.
pub fn write_games_atomic(dir: &Path, games: &[GameProvenance]) -> Result<PathBuf, PackError> {
    let path = dir.join(GAMES_FILE_NAME);
    let bytes = encode_games(games)?;
    storage::write_atomic(&path, &bytes)?;
    Ok(path)
}

/// Read and validate a JSONL game-provenance source.
pub fn load_games(path: &Path) -> Result<Vec<GameProvenance>, PackError> {
    let text = fs::read_to_string(path).map_err(|source| PackError::Io {
        path: path.display().to_string(),
        source,
    })?;
    let mut games = Vec::new();
    for (index, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let game: GameProvenance =
            serde_json::from_str(line).map_err(|source| PackError::Games {
                path: path.display().to_string(),
                detail: format!("line {}: {source}", index + 1),
            })?;
        game.validate().map_err(|error| PackError::Games {
            path: path.display().to_string(),
            detail: format!("line {}: {error}", index + 1),
        })?;
        games.push(game);
    }
    if games.is_empty() {
        return Err(PackError::MissingGames(path.display().to_string()));
    }
    Ok(games)
}
