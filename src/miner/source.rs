//! The fail-closed replay source gate.
//!
//! The project decision in [`replay-strategy.md`] is that AI self-play is the
//! **only** replay source. Tenhou, Mahjong Soul, Riichi City, Hime, M-League,
//! Hugging Face/Kaggle derivatives and user-imported human logs are not
//! deferred features; they are rejected inputs. This module makes that a type,
//! not a convention: [`SourceKind`] can only hold [`AI_SELFPLAY`], and
//! deserialising any other source string is an error.
//!
//! [`replay-strategy.md`]: ../../replay-strategy.md

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;
use thiserror::Error;

/// The only replay source the pipeline accepts.
pub const AI_SELFPLAY: &str = "ai_selfplay";

/// A validated replay source kind.
///
/// There is deliberately no public constructor for an arbitrary string. Use
/// [`SourceKind::parse`] or [`SourceGate::check`], both of which reject every
/// value except `ai_selfplay`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SourceKind(String);

impl SourceKind {
    /// The one allowed source: our own AI self-play corpus.
    #[must_use]
    pub fn ai_selfplay() -> Self {
        Self(AI_SELFPLAY.to_string())
    }

    /// Parse a source string against the allowlist.
    ///
    /// The comparison is exact after trimming: `AI_SELFPLAY`, `tenhou` and the
    /// empty string are all rejected. A future source needs an explicit product
    /// decision and a change to this allowlist, not a new string in a data file.
    pub fn parse(raw: &str) -> Result<Self, SourceError> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err(SourceError::Empty);
        }
        if trimmed == AI_SELFPLAY {
            Ok(Self(AI_SELFPLAY.to_string()))
        } else {
            Err(SourceError::NotAllowed(trimmed.to_string()))
        }
    }

    /// Whether this kind is on the allowlist.
    ///
    /// Always `true` for a value that could be constructed, because unknown
    /// values cannot exist. Kept as an explicit check so call sites read as a
    /// gate rather than an assumption.
    #[must_use]
    pub fn is_allowed(&self) -> bool {
        self.0 == AI_SELFPLAY
    }

    /// The canonical string.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Default for SourceKind {
    fn default() -> Self {
        Self::ai_selfplay()
    }
}

impl fmt::Display for SourceKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl Serialize for SourceKind {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for SourceKind {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = String::deserialize(deserializer)?;
        Self::parse(&raw).map_err(serde::de::Error::custom)
    }
}

/// Typed reason a source was rejected.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SourceError {
    /// The field was missing/blank.
    #[error("replay source is empty; only `ai_selfplay` is allowed")]
    Empty,
    /// The source is a known or unknown non-self-play source.
    #[error(
        "replay source `{0}` is not allowed; only `ai_selfplay` (our own AI self-play) may be ingested or published"
    )]
    NotAllowed(String),
}

/// The allowlist entry point used by ingest and publish code.
#[derive(Debug, Clone, Copy, Default)]
pub struct SourceGate;

impl SourceGate {
    /// Parse and allowlist a raw source string.
    pub fn check(raw: &str) -> Result<SourceKind, SourceError> {
        SourceKind::parse(raw)
    }

    /// Re-check an already typed source.
    pub fn require(kind: &SourceKind) -> Result<(), SourceError> {
        if kind.is_allowed() {
            Ok(())
        } else {
            Err(SourceError::NotAllowed(kind.as_str().to_string()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_accepts_only_ai_selfplay() {
        let allowed = SourceGate::check("ai_selfplay").expect("ai_selfplay must be allowed");
        assert_eq!(allowed, SourceKind::ai_selfplay());
        assert!(allowed.is_allowed());
        assert_eq!(allowed.to_string(), "ai_selfplay");

        // Surrounding whitespace is tolerated; the value is still the allowlist
        // entry, not a way to sneak in a different source.
        assert_eq!(
            SourceGate::check("  ai_selfplay\t").expect("trimmed allowlist entry"),
            SourceKind::ai_selfplay()
        );
    }

    #[test]
    fn allowlist_rejects_every_other_source() {
        let rejected = [
            "",
            " ",
            "AI_SELFPLAY",
            "ai_selfplay_extra",
            "selfplay",
            "ai",
            "human",
            "tenhou",
            "tenhou_houou",
            "tenhou6",
            "mjlog",
            "mahjong_soul",
            "majsoul",
            "riichi_city",
            "hime_mahjong",
            "m_league",
            "mleague",
            "user_import",
            "byo_replay",
            "huggingface",
            "kaggle",
            "third_party",
            "synthetic",
        ];

        for raw in rejected {
            assert!(
                SourceGate::check(raw).is_err(),
                "source `{raw}` must be rejected by the allowlist"
            );
        }
    }

    #[test]
    fn empty_source_is_its_own_typed_error() {
        assert_eq!(SourceGate::check(""), Err(SourceError::Empty));
        assert_eq!(
            SourceGate::check("tenhou"),
            Err(SourceError::NotAllowed("tenhou".to_string()))
        );
    }

    #[test]
    fn source_deserialization_is_fail_closed() {
        assert_eq!(
            serde_json::from_str::<SourceKind>("\"ai_selfplay\"").expect("allowed source"),
            SourceKind::ai_selfplay()
        );
        for json in ["\"tenhou\"", "\"mahjong_soul\"", "\"\"", "null", "42", "{}"] {
            assert!(
                serde_json::from_str::<SourceKind>(json).is_err(),
                "{json} must not deserialize into a source"
            );
        }
    }

    #[test]
    fn source_round_trips_through_json() {
        let kind = SourceKind::ai_selfplay();
        let encoded = serde_json::to_string(&kind).expect("serialize");
        assert_eq!(encoded, "\"ai_selfplay\"");
        assert_eq!(
            serde_json::from_str::<SourceKind>(&encoded).expect("deserialize"),
            kind
        );
    }
}
