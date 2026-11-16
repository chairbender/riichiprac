//! mjai tile codes, including the red fives.
//!
//! mjai names a tile by rank + suit (`1m`…`9s`) and an honour by its letter
//! (`E`, `S`, `W`, `N`, `P`, `F`, `C`). The red fives are the extra codes
//! `5mr`, `5pr` and `5sr`. `?` is the *in-game mode* placeholder for a tile the
//! receiving player may not see; a replay log must never contain it, because a
//! replay exposes every hand, and this reader rejects it instead of quietly
//! dropping information.
//!
//! Internally a tile is the app's 34-kind index (the same order as
//! [`crate::ai::encoder::tile_index`]) plus an `aka` flag. The app stores red
//! fives out of band (`PlayerState::red_fives`) and leaves the tile name plain,
//! so [`Tile::app_name`] returns `5m` for both `5m` and `5mr`; the flag is never
//! lost because it lives on the [`Tile`] itself. [`Tile::tenhou6_id`] is the
//! mapping the reviewer export uses (`51`/`52`/`53` for the red fives), kept
//! here so R2 does not invent a second table.

use std::fmt;

/// Number of tile kinds in a four-player game.
pub const TILE_KINDS: usize = 34;

/// Typed reason a mjai tile string could not be read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TileParseError {
    /// `?`, the in-game-mode hidden tile. A replay must not contain it.
    Hidden,
    /// A tile string outside the mjai vocabulary.
    Unknown(String),
    /// A red-five suffix on a tile that has no red five (`5zr`, `5mr` is fine).
    NotARedFive(String),
}

impl fmt::Display for TileParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Hidden => f.write_str("`?` is an in-game hidden tile, not a replay tile"),
            Self::Unknown(raw) => write!(f, "`{raw}` is not an mjai tile"),
            Self::NotARedFive(raw) => write!(f, "`{raw}` names a red five that does not exist"),
        }
    }
}

impl std::error::Error for TileParseError {}

/// One physical tile: a 34-kind index plus the red-five flag.
///
/// The flag is part of identity, so a hand can hold `5m` and `5mr` at the same
/// time and a ledger can tell them apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Tile {
    /// 0..=8 man, 9..=17 pin, 18..=26 sou, 27..=33 E,S,W,N,P,F,C.
    kind: u8,
    /// Whether this is the red five of its suit.
    aka: bool,
}

impl Tile {
    /// Build a tile from a kind index and red-five flag.
    ///
    /// Only 5m, 5p and 5s (kinds 4, 13 and 22) have a red five; any other kind
    /// with `aka` is rejected rather than silently normalised.
    #[must_use]
    pub fn new(kind: usize, aka: bool) -> Option<Self> {
        if kind >= TILE_KINDS {
            return None;
        }
        if aka && !is_five(kind) {
            return None;
        }
        Some(Self {
            kind: kind as u8,
            aka,
        })
    }

    /// Parse one mjai tile string.
    pub fn parse(raw: &str) -> Result<Self, TileParseError> {
        if raw == "?" {
            return Err(TileParseError::Hidden);
        }
        let bytes = raw.as_bytes();
        if bytes.len() == 3 && bytes[2] == b'r' {
            let kind =
                parse_plain(&raw[..2]).ok_or_else(|| TileParseError::Unknown(raw.to_string()))?;
            if !is_five(kind) {
                return Err(TileParseError::NotARedFive(raw.to_string()));
            }
            return Ok(Self {
                kind: kind as u8,
                aka: true,
            });
        }
        let kind = parse_plain(raw).ok_or_else(|| TileParseError::Unknown(raw.to_string()))?;
        Ok(Self {
            kind: kind as u8,
            aka: false,
        })
    }

    /// The 34-kind index.
    #[must_use]
    pub fn kind(self) -> usize {
        self.kind as usize
    }

    /// Whether this is a red five.
    #[must_use]
    pub fn is_aka(self) -> bool {
        self.aka
    }

    /// Whether the tile is a wind or dragon.
    #[must_use]
    pub fn is_honor(self) -> bool {
        self.kind >= 27
    }

    /// The canonical mjai string (`5mr` for the red five).
    #[must_use]
    pub fn mjai_name(self) -> String {
        let mut name = kind_name(self.kind as usize);
        if self.aka {
            name.push('r');
        }
        name
    }

    /// The app's tile name: honours are `1z`…`7z`, red fives are plain.
    ///
    /// The red flag travels separately in `PlayerState::red_fives`; use
    /// [`Tile::is_aka`] when the identity matters.
    #[must_use]
    pub fn app_name(self) -> String {
        if self.kind < 27 {
            let suit = ['m', 'p', 's'][self.kind as usize / 9];
            format!("{}{suit}", self.kind % 9 + 1)
        } else {
            format!("{}z", self.kind - 26)
        }
    }

    /// The `tenhou.net/6` tile id (`51`/`52`/`53` for the red fives).
    #[must_use]
    pub fn tenhou6_id(self) -> u8 {
        if self.aka {
            match self.kind {
                4 => 51,
                13 => 52,
                22 => 53,
                _ => unreachable!("Tile::new only sets aka on a five"),
            }
        } else if self.kind < 27 {
            let suit = self.kind / 9 + 1;
            let rank = self.kind % 9 + 1;
            suit * 10 + rank
        } else {
            41 + (self.kind - 27)
        }
    }

    /// Whether `self` is the same tile kind as `other` (red fives included).
    #[must_use]
    pub fn same_kind(self, other: Self) -> bool {
        self.kind == other.kind
    }
}

impl fmt::Display for Tile {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.mjai_name())
    }
}

/// A tile always serialises as its canonical mjai string.
///
/// The fixture writer uses this; the browser build never sees a [`Tile`].
impl serde::Serialize for Tile {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.mjai_name())
    }
}

pub(crate) fn kind_name(kind: usize) -> String {
    if kind < 27 {
        let suit = ['m', 'p', 's'][kind / 9];
        format!("{}{suit}", kind % 9 + 1)
    } else {
        let honor = ['E', 'S', 'W', 'N', 'P', 'F', 'C'][kind - 27];
        honor.to_string()
    }
}

fn is_five(kind: usize) -> bool {
    matches!(kind, 4 | 13 | 22)
}

fn parse_plain(raw: &str) -> Option<usize> {
    match raw {
        "E" => return Some(27),
        "S" => return Some(28),
        "W" => return Some(29),
        "N" => return Some(30),
        "P" => return Some(31),
        "F" => return Some(32),
        "C" => return Some(33),
        _ => {}
    }
    let bytes = raw.as_bytes();
    if bytes.len() != 2 {
        return None;
    }
    let rank = match bytes[0] {
        b'1'..=b'9' => (bytes[0] - b'0') as usize,
        _ => return None,
    };
    match bytes[1] {
        b'm' => Some(rank - 1),
        b'p' => Some(9 + rank - 1),
        b's' => Some(18 + rank - 1),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_every_mjai_tile_and_round_trips() {
        for tile in [
            "1m", "2m", "3m", "4m", "5m", "6m", "7m", "8m", "9m", "1p", "2p", "3p", "4p", "5p",
            "6p", "7p", "8p", "9p", "1s", "2s", "3s", "4s", "5s", "6s", "7s", "8s", "9s", "E", "S",
            "W", "N", "P", "F", "C", "5mr", "5pr", "5sr",
        ] {
            let parsed = Tile::parse(tile).expect("mjai tile must parse");
            assert_eq!(parsed.mjai_name(), tile);
        }
    }

    #[test]
    fn maps_red_fives_to_the_app_and_tenhou6_representations() {
        let red = Tile::parse("5mr").unwrap();
        assert!(red.is_aka());
        assert_eq!(red.app_name(), "5m");
        assert_eq!(red.tenhou6_id(), 51);
        assert_eq!(Tile::parse("5m").unwrap().tenhou6_id(), 15);
        assert_eq!(Tile::parse("5pr").unwrap().tenhou6_id(), 52);
        assert_eq!(Tile::parse("5sr").unwrap().tenhou6_id(), 53);
        assert_eq!(Tile::parse("C").unwrap().app_name(), "7z");
        assert_eq!(Tile::parse("E").unwrap().tenhou6_id(), 41);
    }

    #[test]
    fn rejects_hidden_and_malformed_tiles() {
        assert_eq!(Tile::parse("?"), Err(TileParseError::Hidden));
        for raw in ["", "0m", "10m", "5mrr", "5zr", "1x", "e", "M", "5 m"] {
            assert!(
                matches!(Tile::parse(raw), Err(TileParseError::Unknown(_))),
                "`{raw}` should be an unknown tile"
            );
        }
        assert_eq!(
            Tile::parse("1mr"),
            Err(TileParseError::NotARedFive("1mr".to_string()))
        );
    }

    #[test]
    fn new_refuses_a_red_flag_on_a_non_five() {
        assert!(Tile::new(0, true).is_none());
        assert!(Tile::new(34, false).is_none());
        assert_eq!(Tile::new(4, true).unwrap().mjai_name(), "5mr");
    }
}
