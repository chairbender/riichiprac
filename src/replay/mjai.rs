//! Gzipped mjai JSONL reader and replay event model.
//!
//! # What is accepted
//!
//! The corpus is AI self-play, and mjai JSONL is its only wire format
//! ([`replay-strategy.md`] §2). A replay is a **complete game**: an optional
//! `start_game`, one or more kyoku, and a final `end_game`. Each line is one
//! JSON object with a `type` field. In-game-only messages (`hello`, `join`,
//! `none`) and every format that is not mjai are rejected; there is no
//! Tenhou/Mahjong Soul/Riichi City reader in the ingestion path.
//!
//! The supported event vocabulary is [`SUPPORTED_EVENTS`]. It is the plan's R1
//! list plus `start_game`, which Mortal's `libriichi` arena writes at the head
//! of every log; rejecting it would make the corpus unreadable. Every other
//! mjai event is a typed [`ParseErrorKind::UnsupportedEvent`] or
//! [`ParseErrorKind::UnknownEvent`], never a silent skip.
//!
//! # Accepted shape
//!
//! The reader follows the mjai event definitions, with two deliberate
//! narrowings for the four-player Tenhou hanchan corpus:
//!
//! - `start_kyoku` **must** carry `scores` and exactly four 13-tile hands. The
//!   canonical schema allows the field to be omitted (and sanma three-hand
//!   logs); a replay without an opening score ledger cannot be validated, so it
//!   is rejected instead of guessed.
//! - `?` (the in-game hidden-tile marker) is a hard error. A replay exposes
//!   every hand; a hidden tile means the file is an in-game transcript.
//!
//! `hora` and `ryukyoku` accept the union of the fields the two common writers
//! emit: `pai`, `deltas`, `scores`, `ura_markers`, `reason` and `tehais` are all
//! optional. R1 validates whichever are present; R2 uses what it needs.
//!
//! [`replay-strategy.md`]: ../../replay-strategy.md

use std::fmt;
use std::fs;
use std::io::Read;
use std::path::Path;

use flate2::read::MultiGzDecoder;
use serde::Serialize;
use serde_json::{Map, Value};
use thiserror::Error;

use super::tile::{Tile, TileParseError};

/// Longest accepted JSONL line, in bytes.
pub const MAX_LINE_BYTES: usize = 64 * 1024;

/// Largest accepted event count.
pub const MAX_EVENTS: usize = 100_000;

/// Largest accepted decompressed replay, in bytes.
pub const MAX_DECOMPRESSED_BYTES: u64 = 64 * 1024 * 1024;

/// Every event name this reader accepts, in mjai spelling.
pub const SUPPORTED_EVENTS: &[&str] = &[
    "start_game",
    "start_kyoku",
    "tsumo",
    "dahai",
    "chi",
    "pon",
    "daiminkan",
    "ankan",
    "kakan",
    "dora",
    "reach",
    "reach_accepted",
    "hora",
    "ryukyoku",
    "end_kyoku",
    "end_game",
];

/// One parsed replay line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MjaiEvent {
    /// 1-based line in the decompressed JSONL.
    pub line: usize,
    /// The event itself.
    pub kind: EventKind,
}

/// A validated-shape replay file, before structural validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplayFile {
    events: Vec<MjaiEvent>,
}

impl ReplayFile {
    /// The events in file order.
    #[must_use]
    pub fn events(&self) -> &[MjaiEvent] {
        &self.events
    }

    /// Event count.
    #[must_use]
    pub fn len(&self) -> usize {
        self.events.len()
    }

    /// Whether the file has no events (never true for a file the reader
    /// returned; kept for completeness).
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }

    /// Consume the file and return its events.
    #[must_use]
    pub fn into_events(self) -> Vec<MjaiEvent> {
        self.events
    }
}

/// The mjai events R1 understands.
///
/// Serialisation exists for the test-only fixture writer; the build/test
/// direction is hand-written in [`EventKind::parse_value`] so every malformed
/// field has a typed error and a line number.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EventKind {
    StartGame {
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        names: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        seed: Option<[u64; 2]>,
    },
    StartKyoku {
        bakaze: Tile,
        dora_marker: Tile,
        kyoku: u8,
        honba: u8,
        kyotaku: u8,
        oya: u8,
        scores: [i32; 4],
        tehais: [[Tile; 13]; 4],
    },
    Tsumo {
        actor: u8,
        pai: Tile,
    },
    Dahai {
        actor: u8,
        pai: Tile,
        tsumogiri: bool,
    },
    Chi {
        actor: u8,
        target: u8,
        pai: Tile,
        consumed: [Tile; 2],
    },
    Pon {
        actor: u8,
        target: u8,
        pai: Tile,
        consumed: [Tile; 2],
    },
    Daiminkan {
        actor: u8,
        target: u8,
        pai: Tile,
        consumed: [Tile; 3],
    },
    Ankan {
        actor: u8,
        consumed: [Tile; 4],
    },
    Kakan {
        actor: u8,
        pai: Tile,
        consumed: [Tile; 3],
    },
    Dora {
        dora_marker: Tile,
    },
    Reach {
        actor: u8,
    },
    ReachAccepted {
        actor: u8,
    },
    Hora {
        actor: u8,
        target: u8,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pai: Option<Tile>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        deltas: Option<[i32; 4]>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scores: Option<[i32; 4]>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ura_markers: Option<Vec<Tile>>,
    },
    Ryukyoku {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        deltas: Option<[i32; 4]>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scores: Option<[i32; 4]>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tehais: Option<[[Tile; 13]; 4]>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ura_markers: Option<Vec<Tile>>,
    },
    EndKyoku,
    EndGame,
}

impl EventKind {
    /// The mjai type string.
    #[must_use]
    pub const fn name(&self) -> &'static str {
        match self {
            Self::StartGame { .. } => "start_game",
            Self::StartKyoku { .. } => "start_kyoku",
            Self::Tsumo { .. } => "tsumo",
            Self::Dahai { .. } => "dahai",
            Self::Chi { .. } => "chi",
            Self::Pon { .. } => "pon",
            Self::Daiminkan { .. } => "daiminkan",
            Self::Ankan { .. } => "ankan",
            Self::Kakan { .. } => "kakan",
            Self::Dora { .. } => "dora",
            Self::Reach { .. } => "reach",
            Self::ReachAccepted { .. } => "reach_accepted",
            Self::Hora { .. } => "hora",
            Self::Ryukyoku { .. } => "ryukyoku",
            Self::EndKyoku => "end_kyoku",
            Self::EndGame => "end_game",
        }
    }

    /// Parse one JSON event value.
    fn parse_value(value: &Value, line: usize) -> Result<Self, ParseError> {
        let object = value
            .as_object()
            .ok_or_else(|| ParseError::at(line, ParseErrorKind::NotAnObject))?;
        let name = object
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| ParseError::at(line, ParseErrorKind::MissingType))?;
        let fields = Fields { line, object };

        let event = match name {
            "start_game" => {
                let names = match fields.opt("names") {
                    Some(_) => {
                        let names = fields.strings("names")?;
                        if names.len() != 4 {
                            return Err(ParseError::at(
                                line,
                                ParseErrorKind::WrongLength {
                                    field: "names",
                                    expected: 4,
                                    found: names.len(),
                                },
                            ));
                        }
                        names
                    }
                    None => Vec::new(),
                };
                let seed = match fields.opt("seed") {
                    Some(_) => Some(fields.u64_pair("seed")?),
                    None => None,
                };
                Self::StartGame { names, seed }
            }
            "start_kyoku" => Self::StartKyoku {
                bakaze: fields.tile("bakaze")?,
                dora_marker: fields.tile("dora_marker")?,
                kyoku: fields.bounded_u8("kyoku", 1, 4)?,
                honba: fields.u8("honba")?,
                kyotaku: fields.u8("kyotaku")?,
                oya: fields.actor("oya")?,
                scores: fields.i32s("scores")?,
                tehais: fields.tehais("tehais")?,
            },
            "tsumo" => Self::Tsumo {
                actor: fields.actor("actor")?,
                pai: fields.tile("pai")?,
            },
            "dahai" => Self::Dahai {
                actor: fields.actor("actor")?,
                pai: fields.tile("pai")?,
                tsumogiri: fields.bool("tsumogiri")?,
            },
            "chi" => Self::Chi {
                actor: fields.actor("actor")?,
                target: fields.actor("target")?,
                pai: fields.tile("pai")?,
                consumed: fields.tiles("consumed")?,
            },
            "pon" => Self::Pon {
                actor: fields.actor("actor")?,
                target: fields.actor("target")?,
                pai: fields.tile("pai")?,
                consumed: fields.tiles("consumed")?,
            },
            "daiminkan" => Self::Daiminkan {
                actor: fields.actor("actor")?,
                target: fields.actor("target")?,
                pai: fields.tile("pai")?,
                consumed: fields.tiles("consumed")?,
            },
            "ankan" => Self::Ankan {
                actor: fields.actor("actor")?,
                consumed: fields.tiles("consumed")?,
            },
            "kakan" => Self::Kakan {
                actor: fields.actor("actor")?,
                pai: fields.tile("pai")?,
                consumed: fields.tiles("consumed")?,
            },
            "dora" => Self::Dora {
                dora_marker: fields.tile("dora_marker")?,
            },
            "reach" => Self::Reach {
                actor: fields.actor("actor")?,
            },
            "reach_accepted" => Self::ReachAccepted {
                actor: fields.actor("actor")?,
            },
            "hora" => Self::Hora {
                actor: fields.actor("actor")?,
                target: fields.actor("target")?,
                pai: fields.opt_tile("pai")?,
                deltas: fields.opt_i32s("deltas")?,
                scores: fields.opt_i32s("scores")?,
                ura_markers: fields.opt_tiles("ura_markers", 5)?,
            },
            "ryukyoku" => Self::Ryukyoku {
                reason: fields.opt_string("reason")?,
                deltas: fields.opt_i32s("deltas")?,
                scores: fields.opt_i32s("scores")?,
                tehais: fields.opt_tehais("tehais")?,
                ura_markers: fields.opt_tiles("ura_markers", 5)?,
            },
            "end_kyoku" => Self::EndKyoku,
            "end_game" => Self::EndGame,
            "hello" | "join" | "none" => {
                return Err(ParseError::at(
                    line,
                    ParseErrorKind::UnsupportedEvent(name.to_string()),
                ));
            }
            other => {
                return Err(ParseError::at(
                    line,
                    ParseErrorKind::UnknownEvent(other.to_string()),
                ));
            }
        };
        Ok(event)
    }
}

/// Typed parse failure, with the 1-based source line when there is one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError {
    /// `None` for a whole-file failure.
    pub line: Option<usize>,
    pub kind: ParseErrorKind,
}

impl ParseError {
    fn at(line: usize, kind: ParseErrorKind) -> Self {
        Self {
            line: Some(line),
            kind,
        }
    }

    fn file(kind: ParseErrorKind) -> Self {
        Self { line: None, kind }
    }
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.line {
            Some(line) => write!(f, "line {line}: {}", self.kind),
            None => write!(f, "replay: {}", self.kind),
        }
    }
}

impl std::error::Error for ParseError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.kind)
    }
}

/// The reason a replay line or file was rejected.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ParseErrorKind {
    #[error("cannot read replay: {0}")]
    Io(String),
    #[error("cannot decompress gzip replay: {0}")]
    Gzip(String),
    #[error("replay is not gzip-compressed; corpus logs are `.jsonl.gz`")]
    NotGzip,
    #[error("replay contains no events")]
    Empty,
    #[error("replay is not valid UTF-8: {0}")]
    InvalidUtf8(String),
    #[error("replay is larger than the {max} byte limit")]
    TooLarge { max: u64 },
    #[error("event line is longer than the {max} byte limit")]
    LineTooLong { max: usize },
    #[error("replay has more than {max} events")]
    TooManyEvents { max: usize },
    #[error("invalid JSON: {0}")]
    InvalidJson(String),
    #[error("event is not a JSON object")]
    NotAnObject,
    #[error("event has no string `type` field")]
    MissingType,
    #[error("mjai event `{0}` is not valid in replay mode")]
    UnsupportedEvent(String),
    #[error("unknown mjai event `{0}`")]
    UnknownEvent(String),
    #[error("missing field `{field}`")]
    MissingField { field: &'static str },
    #[error("field `{field}` has the wrong type")]
    WrongType { field: &'static str },
    #[error("field `{field}` is out of range: {value}")]
    OutOfRange { field: &'static str, value: i64 },
    #[error("field `{field}` must have {expected} entries, found {found}")]
    WrongLength {
        field: &'static str,
        expected: usize,
        found: usize,
    },
    #[error("field `{field}` must have at most {max} entries, found {found}")]
    TooManyEntries {
        field: &'static str,
        max: usize,
        found: usize,
    },
    #[error("field `{field}`: {source}")]
    InvalidTile {
        field: &'static str,
        source: TileParseError,
    },
}

/// The replay reader.
#[derive(Debug, Clone, Copy, Default)]
pub struct ReplayReader;

impl ReplayReader {
    /// Read a gzipped mjai JSONL replay from `path`.
    pub fn read_path(path: &Path) -> Result<ReplayFile, ParseError> {
        let bytes = fs::read(path).map_err(|err| {
            ParseError::file(ParseErrorKind::Io(format!("{}: {err}", path.display())))
        })?;
        Self::read_gzip(&bytes)
    }

    /// Read a gzipped mjai JSONL replay from memory.
    ///
    /// The gzip magic is checked before decompressing, so an uncompressed file
    /// that happens to sit behind a `.gz` name is rejected rather than guessed.
    pub fn read_gzip(bytes: &[u8]) -> Result<ReplayFile, ParseError> {
        if !bytes.starts_with(&[0x1f, 0x8b]) {
            return Err(ParseError::file(ParseErrorKind::NotGzip));
        }
        let mut decoder = MultiGzDecoder::new(bytes);
        let mut decoded = Vec::new();
        decoder
            .by_ref()
            .take(MAX_DECOMPRESSED_BYTES + 1)
            .read_to_end(&mut decoded)
            .map_err(|err| ParseError::file(ParseErrorKind::Gzip(err.to_string())))?;
        if decoded.len() as u64 > MAX_DECOMPRESSED_BYTES {
            return Err(ParseError::file(ParseErrorKind::TooLarge {
                max: MAX_DECOMPRESSED_BYTES,
            }));
        }
        let text = String::from_utf8(decoded)
            .map_err(|err| ParseError::file(ParseErrorKind::InvalidUtf8(err.to_string())))?;
        Self::read_jsonl(&text)
    }

    /// Read uncompressed mjai JSONL from a string.
    ///
    /// This is the test/fixture entry point. The ingestion path uses
    /// [`ReplayReader::read_path`] and therefore always goes through gzip.
    pub fn read_jsonl(text: &str) -> Result<ReplayFile, ParseError> {
        let mut events = Vec::new();
        for (index, raw) in text.split('\n').enumerate() {
            let line = index + 1;
            let trimmed = raw.strip_suffix('\r').unwrap_or(raw).trim();
            if trimmed.is_empty() {
                continue;
            }
            if trimmed.len() > MAX_LINE_BYTES {
                return Err(ParseError::at(
                    line,
                    ParseErrorKind::LineTooLong {
                        max: MAX_LINE_BYTES,
                    },
                ));
            }
            if events.len() >= MAX_EVENTS {
                return Err(ParseError::at(
                    line,
                    ParseErrorKind::TooManyEvents { max: MAX_EVENTS },
                ));
            }
            let value: Value = serde_json::from_str(trimmed).map_err(|err| {
                ParseError::at(line, ParseErrorKind::InvalidJson(err.to_string()))
            })?;
            let kind = EventKind::parse_value(&value, line)?;
            events.push(MjaiEvent { line, kind });
        }
        if events.is_empty() {
            return Err(ParseError::file(ParseErrorKind::Empty));
        }
        Ok(ReplayFile { events })
    }
}

/// Field access with the event's line number attached to every failure.
struct Fields<'a> {
    line: usize,
    object: &'a Map<String, Value>,
}

impl<'a> Fields<'a> {
    fn error(&self, kind: ParseErrorKind) -> ParseError {
        ParseError::at(self.line, kind)
    }

    fn get(&self, field: &'static str) -> Result<&'a Value, ParseError> {
        self.object
            .get(field)
            .ok_or_else(|| self.error(ParseErrorKind::MissingField { field }))
    }

    fn opt(&self, field: &'static str) -> Option<&'a Value> {
        self.object.get(field)
    }

    fn u8(&self, field: &'static str) -> Result<u8, ParseError> {
        let value = self.get(field)?;
        let number = value
            .as_u64()
            .ok_or_else(|| self.error(ParseErrorKind::WrongType { field }))?;
        u8::try_from(number).map_err(|_| {
            self.error(ParseErrorKind::OutOfRange {
                field,
                value: i64::try_from(number).unwrap_or(i64::MAX),
            })
        })
    }

    fn bounded_u8(&self, field: &'static str, min: u8, max: u8) -> Result<u8, ParseError> {
        let value = self.u8(field)?;
        if (min..=max).contains(&value) {
            Ok(value)
        } else {
            Err(self.error(ParseErrorKind::OutOfRange {
                field,
                value: i64::from(value),
            }))
        }
    }

    fn actor(&self, field: &'static str) -> Result<u8, ParseError> {
        self.bounded_u8(field, 0, 3)
    }

    fn bool(&self, field: &'static str) -> Result<bool, ParseError> {
        self.get(field)?
            .as_bool()
            .ok_or_else(|| self.error(ParseErrorKind::WrongType { field }))
    }

    fn string(&self, field: &'static str) -> Result<String, ParseError> {
        self.get(field)?
            .as_str()
            .map(ToString::to_string)
            .ok_or_else(|| self.error(ParseErrorKind::WrongType { field }))
    }

    fn opt_string(&self, field: &'static str) -> Result<Option<String>, ParseError> {
        match self.opt(field) {
            Some(value) => value
                .as_str()
                .map(|s| Some(s.to_string()))
                .ok_or_else(|| self.error(ParseErrorKind::WrongType { field })),
            None => Ok(None),
        }
    }

    fn strings(&self, field: &'static str) -> Result<Vec<String>, ParseError> {
        let values = self
            .get(field)?
            .as_array()
            .ok_or_else(|| self.error(ParseErrorKind::WrongType { field }))?;
        values
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(ToString::to_string)
                    .ok_or_else(|| self.error(ParseErrorKind::WrongType { field }))
            })
            .collect()
    }

    fn u64_pair(&self, field: &'static str) -> Result<[u64; 2], ParseError> {
        let values = self
            .get(field)?
            .as_array()
            .ok_or_else(|| self.error(ParseErrorKind::WrongType { field }))?;
        if values.len() != 2 {
            return Err(self.error(ParseErrorKind::WrongLength {
                field,
                expected: 2,
                found: values.len(),
            }));
        }
        let mut out = [0_u64; 2];
        for (slot, value) in out.iter_mut().zip(values) {
            *slot = value
                .as_u64()
                .ok_or_else(|| self.error(ParseErrorKind::WrongType { field }))?;
        }
        Ok(out)
    }

    fn tile(&self, field: &'static str) -> Result<Tile, ParseError> {
        let raw = self.string(field)?;
        Tile::parse(&raw)
            .map_err(|source| self.error(ParseErrorKind::InvalidTile { field, source }))
    }

    fn opt_tile(&self, field: &'static str) -> Result<Option<Tile>, ParseError> {
        match self.opt(field) {
            Some(_) => Ok(Some(self.tile(field)?)),
            None => Ok(None),
        }
    }

    fn tile_value(&self, field: &'static str, value: &Value) -> Result<Tile, ParseError> {
        let raw = value
            .as_str()
            .ok_or_else(|| self.error(ParseErrorKind::WrongType { field }))?;
        Tile::parse(raw).map_err(|source| self.error(ParseErrorKind::InvalidTile { field, source }))
    }

    fn tiles<const N: usize>(&self, field: &'static str) -> Result<[Tile; N], ParseError> {
        let values = self
            .get(field)?
            .as_array()
            .ok_or_else(|| self.error(ParseErrorKind::WrongType { field }))?;
        if values.len() != N {
            return Err(self.error(ParseErrorKind::WrongLength {
                field,
                expected: N,
                found: values.len(),
            }));
        }
        let mut out = Vec::with_capacity(N);
        for value in values {
            out.push(self.tile_value(field, value)?);
        }
        out.try_into().map_err(|_| {
            self.error(ParseErrorKind::WrongLength {
                field,
                expected: N,
                found: values.len(),
            })
        })
    }

    fn opt_tiles(&self, field: &'static str, max: usize) -> Result<Option<Vec<Tile>>, ParseError> {
        let Some(value) = self.opt(field) else {
            return Ok(None);
        };
        let values = value
            .as_array()
            .ok_or_else(|| self.error(ParseErrorKind::WrongType { field }))?;
        if values.len() > max {
            return Err(self.error(ParseErrorKind::TooManyEntries {
                field,
                max,
                found: values.len(),
            }));
        }
        let mut out = Vec::with_capacity(values.len());
        for value in values {
            out.push(self.tile_value(field, value)?);
        }
        Ok(Some(out))
    }

    fn i32s(&self, field: &'static str) -> Result<[i32; 4], ParseError> {
        let values = self
            .get(field)?
            .as_array()
            .ok_or_else(|| self.error(ParseErrorKind::WrongType { field }))?;
        if values.len() != 4 {
            return Err(self.error(ParseErrorKind::WrongLength {
                field,
                expected: 4,
                found: values.len(),
            }));
        }
        let mut out = [0_i32; 4];
        for (slot, value) in out.iter_mut().zip(values) {
            let number = value
                .as_i64()
                .ok_or_else(|| self.error(ParseErrorKind::WrongType { field }))?;
            *slot = i32::try_from(number).map_err(|_| {
                self.error(ParseErrorKind::OutOfRange {
                    field,
                    value: number,
                })
            })?;
        }
        Ok(out)
    }

    fn opt_i32s(&self, field: &'static str) -> Result<Option<[i32; 4]>, ParseError> {
        match self.opt(field) {
            Some(_) => Ok(Some(self.i32s(field)?)),
            None => Ok(None),
        }
    }

    fn tehais(&self, field: &'static str) -> Result<[[Tile; 13]; 4], ParseError> {
        let rows = self
            .get(field)?
            .as_array()
            .ok_or_else(|| self.error(ParseErrorKind::WrongType { field }))?;
        if rows.len() != 4 {
            return Err(self.error(ParseErrorKind::WrongLength {
                field,
                expected: 4,
                found: rows.len(),
            }));
        }
        let mut out = Vec::with_capacity(4);
        for row in rows {
            let values = row
                .as_array()
                .ok_or_else(|| self.error(ParseErrorKind::WrongType { field }))?;
            if values.len() != 13 {
                return Err(self.error(ParseErrorKind::WrongLength {
                    field,
                    expected: 13,
                    found: values.len(),
                }));
            }
            let mut hand = Vec::with_capacity(13);
            for value in values {
                hand.push(self.tile_value(field, value)?);
            }
            out.push(hand.try_into().map_err(|_| {
                self.error(ParseErrorKind::WrongLength {
                    field,
                    expected: 13,
                    found: values.len(),
                })
            })?);
        }
        out.try_into().map_err(|_| {
            self.error(ParseErrorKind::WrongLength {
                field,
                expected: 4,
                found: rows.len(),
            })
        })
    }

    fn opt_tehais(&self, field: &'static str) -> Result<Option<[[Tile; 13]; 4]>, ParseError> {
        match self.opt(field) {
            Some(_) => Ok(Some(self.tehais(field)?)),
            None => Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_one(line: &str) -> Result<EventKind, ParseError> {
        let file = ReplayReader::read_jsonl(line)?;
        Ok(file.events()[0].kind.clone())
    }

    #[test]
    fn reads_every_supported_event_shape() {
        let cases = [
            r#"{"type":"start_game","names":["a","b","c","d"],"seed":[1,2]}"#,
            r#"{"type":"start_kyoku","bakaze":"E","dora_marker":"E","kyoku":1,"honba":0,"kyotaku":0,"oya":0,"scores":[25000,25000,25000,25000],"tehais":[["1m","2m","3m","4m","5m","6m","7m","8m","9m","1p","2p","3p","4p"],["1m","2m","3m","4m","5m","6m","7m","8m","9m","1p","2p","3p","4p"],["1m","2m","3m","4m","5m","6m","7m","8m","9m","1p","2p","3p","4p"],["1m","2m","3m","4m","5m","6m","7m","8m","9m","1p","2p","3p","4p"]]}"#,
            r#"{"type":"tsumo","actor":0,"pai":"5mr"}"#,
            r#"{"type":"dahai","actor":0,"pai":"5sr","tsumogiri":true}"#,
            r#"{"type":"chi","actor":1,"target":0,"pai":"3m","consumed":["4m","5m"]}"#,
            r#"{"type":"pon","actor":2,"target":0,"pai":"C","consumed":["C","C"]}"#,
            r#"{"type":"daiminkan","actor":3,"target":0,"pai":"5p","consumed":["5p","5p","5p"]}"#,
            r#"{"type":"ankan","actor":0,"consumed":["9m","9m","9m","9m"]}"#,
            r#"{"type":"kakan","actor":1,"pai":"S","consumed":["S","S","S"]}"#,
            r#"{"type":"dora","dora_marker":"3s"}"#,
            r#"{"type":"reach","actor":2}"#,
            r#"{"type":"reach_accepted","actor":2}"#,
            r#"{"type":"hora","actor":3,"target":1,"pai":"4p","deltas":[0,-8000,0,9000],"scores":[25000,17000,25000,34000],"ura_markers":["4p"]}"#,
            r#"{"type":"hora","actor":3,"target":1}"#,
            r#"{"type":"ryukyoku","reason":"exhaustive_draw","deltas":[0,1500,0,-1500],"scores":[25000,26500,25000,23500]}"#,
            r#"{"type":"ryukyoku"}"#,
            r#"{"type":"end_kyoku"}"#,
            r#"{"type":"end_game"}"#,
        ];
        let mut seen = std::collections::BTreeSet::new();
        for case in cases {
            let event = parse_one(case).unwrap_or_else(|err| panic!("{case}: {err}"));
            seen.insert(event.name());
        }
        for name in SUPPORTED_EVENTS {
            assert!(seen.contains(name), "no parser case for `{name}`");
        }
    }

    #[test]
    fn reports_the_line_number_and_field() {
        let text =
            "{\"type\":\"tsumo\",\"actor\":0,\"pai\":\"1m\"}\n\n{\"type\":\"tsumo\",\"actor\":0}\n";
        let err = ReplayReader::read_jsonl(text).expect_err("missing pai must fail");
        assert_eq!(err.line, Some(3));
        assert_eq!(err.kind, ParseErrorKind::MissingField { field: "pai" });
    }

    #[test]
    fn rejects_hidden_tiles_and_out_of_range_actors() {
        let err = parse_one(r#"{"type":"tsumo","actor":0,"pai":"?"}"#)
            .expect_err("hidden tile must fail");
        assert!(matches!(
            err.kind,
            ParseErrorKind::InvalidTile {
                field: "pai",
                source: TileParseError::Hidden
            }
        ));

        let err =
            parse_one(r#"{"type":"tsumo","actor":4,"pai":"1m"}"#).expect_err("actor 4 must fail");
        assert_eq!(
            err.kind,
            ParseErrorKind::OutOfRange {
                field: "actor",
                value: 4
            }
        );
    }

    #[test]
    fn rejects_unknown_and_in_game_events() {
        let err = parse_one(r#"{"type":"none"}"#).expect_err("none must fail");
        assert_eq!(
            err.kind,
            ParseErrorKind::UnsupportedEvent("none".to_string())
        );
        let err = parse_one(r#"{"type":"mahjong_soul","x":1}"#).expect_err("unknown must fail");
        assert_eq!(
            err.kind,
            ParseErrorKind::UnknownEvent("mahjong_soul".to_string())
        );
    }

    #[test]
    fn rejects_an_uncompressed_file_behind_a_gz_name() {
        let err = ReplayReader::read_gzip(b"{\"type\":\"end_game\"}\n")
            .expect_err("plain text must not be accepted as gzip");
        assert_eq!(err.kind, ParseErrorKind::NotGzip);
    }

    #[test]
    fn rejects_an_empty_replay() {
        let err = ReplayReader::read_jsonl("\n\n").expect_err("empty must fail");
        assert_eq!(err.kind, ParseErrorKind::Empty);
    }
}
