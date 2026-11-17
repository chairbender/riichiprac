//! The tile vocabulary a transform relabels.
//!
//! The app names tiles with the compact codes `1m`..`9s` and `1z`..`7z`, and
//! [Mortal action names](crate::ai::actions) embed them (`Discard_3m`,
//! `Discard_5mr`). This module holds the kind-level bijections the catalogue
//! transforms are built from:
//!
//! | Transform | Kind bijection |
//! | --- | --- |
//! | `suit_perm` | swap the three numbered suits |
//! | `rank_mirror` | `r` ↔ `10 - r` inside a numbered suit |
//! | `wind_relabel` | rotate the four wind honours (and the round wind) |
//! | `seat_perm`, `red5_normalize` | none (identity on kinds) |
//!
//! Every bijection here is a permutation of the 34 kinds, so applying it twice
//! through its inverse restores the original code and a hand's kind counts are
//! conserved.

use serde::{Deserialize, Serialize};

use crate::ai::encoder::{tile_index, tile_name};

use super::TransformError;

/// Number of tile kinds in a four-player game.
pub const TILE_KINDS: usize = 34;

/// First 34-kind index of the wind honours (`1z`).
pub const FIRST_WIND: usize = 27;

/// A numbered suit. Honours are not a suit and no catalogue transform permutes
/// them as a group (a wind relabel rotates four honours instead).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Suit {
    #[serde(rename = "m")]
    Man,
    #[serde(rename = "p")]
    Pin,
    #[serde(rename = "s")]
    Sou,
}

impl Suit {
    /// All three suits in the app's kind order.
    pub const ALL: [Suit; 3] = [Suit::Man, Suit::Pin, Suit::Sou];

    /// 0 for man, 1 for pin, 2 for sou.
    #[must_use]
    pub const fn index(self) -> usize {
        match self {
            Self::Man => 0,
            Self::Pin => 1,
            Self::Sou => 2,
        }
    }

    /// The suit's code letter.
    #[must_use]
    pub const fn letter(self) -> char {
        match self {
            Self::Man => 'm',
            Self::Pin => 'p',
            Self::Sou => 's',
        }
    }

    /// Parse the suit letter of a tile code or compact hand group.
    #[must_use]
    pub const fn from_letter(letter: char) -> Option<Self> {
        match letter {
            'm' => Some(Self::Man),
            'p' => Some(Self::Pin),
            's' => Some(Self::Sou),
            _ => None,
        }
    }

    /// 34-kind index of the suit's rank one.
    #[must_use]
    pub const fn base(self) -> usize {
        self.index() * 9
    }
}

impl std::fmt::Display for Suit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Man => "m",
            Self::Pin => "p",
            Self::Sou => "s",
        })
    }
}

/// One of the six bijections of the numbered suits.
///
/// Serialises as the `{"m": ..., "p": ..., "s": ...}` map the implementation
/// plan sketches (`replay-implementation-plan.md` §4.6). The fields are private
/// so every value that exists is a bijection: both [`SuitMap::new`] and the
/// JSON reader reject anything else.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "SuitMapFields")]
pub struct SuitMap {
    m: Suit,
    p: Suit,
    s: Suit,
}

/// The wire form of a [`SuitMap`], validated by [`SuitMap::new`].
#[derive(Deserialize)]
struct SuitMapFields {
    m: Suit,
    p: Suit,
    s: Suit,
}

impl TryFrom<SuitMapFields> for SuitMap {
    type Error = TransformError;

    fn try_from(fields: SuitMapFields) -> Result<Self, Self::Error> {
        Self::new(fields.m, fields.p, fields.s)
    }
}

impl SuitMap {
    /// The map that changes nothing.
    pub const IDENTITY: Self = Self {
        m: Suit::Man,
        p: Suit::Pin,
        s: Suit::Sou,
    };

    /// Build a map, rejecting anything that is not a bijection.
    pub fn new(m: Suit, p: Suit, s: Suit) -> Result<Self, TransformError> {
        let map = Self { m, p, s };
        map.validate()?;
        Ok(map)
    }

    /// True when the three images are the three suits, each exactly once.
    #[must_use]
    pub fn is_bijection(self) -> bool {
        let mut seen = [false; 3];
        for suit in [self.m, self.p, self.s] {
            let slot = &mut seen[suit.index()];
            if *slot {
                return false;
            }
            *slot = true;
        }
        true
    }

    /// Whether every suit maps to itself.
    #[must_use]
    pub fn is_identity(self) -> bool {
        self == Self::IDENTITY
    }

    /// Reject a non-bijection.
    pub fn validate(self) -> Result<(), TransformError> {
        if self.is_bijection() {
            Ok(())
        } else {
            Err(TransformError::InvalidSuitMap {
                map: self.to_string(),
            })
        }
    }

    /// Where `suit` goes.
    #[must_use]
    pub fn map(self, suit: Suit) -> Suit {
        match suit {
            Suit::Man => self.m,
            Suit::Pin => self.p,
            Suit::Sou => self.s,
        }
    }

    /// The map that undoes this one.
    ///
    /// Every value that exists is a bijection (the fields are private), so this
    /// cannot fail.
    #[must_use]
    pub fn inverse(self) -> Self {
        let mut order = Suit::ALL;
        for suit in Suit::ALL {
            order[self.map(suit).index()] = suit;
        }
        Self {
            m: order[0],
            p: order[1],
            s: order[2],
        }
    }
}

impl std::fmt::Display for SuitMap {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{{m:{}, p:{}, s:{}}}",
            self.m.letter(),
            self.p.letter(),
            self.s.letter()
        )
    }
}

/// A permutation of the 34 tile kinds, indexed in the app's kind order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KindMap {
    kinds: [u8; TILE_KINDS],
}

impl KindMap {
    /// The map that changes nothing.
    #[must_use]
    pub fn identity() -> Self {
        Self::from_fn(|kind| kind)
    }

    /// A map built from one `old kind -> new kind` function.
    ///
    /// Callers only compose maps that are already permutations, so the result is
    /// a permutation too.
    #[must_use]
    pub fn from_fn(mut map: impl FnMut(usize) -> usize) -> Self {
        let mut kinds = [0u8; TILE_KINDS];
        for (index, slot) in kinds.iter_mut().enumerate() {
            *slot = map(index) as u8;
        }
        Self { kinds }
    }

    /// The kind map of a numbered-suit bijection. Honours stay put.
    #[must_use]
    pub fn suit(map: SuitMap) -> Self {
        let mut this = Self::identity();
        for suit in Suit::ALL {
            let target = map.map(suit);
            for rank in 0..9 {
                this.kinds[suit.base() + rank] = (target.base() + rank) as u8;
            }
        }
        this
    }

    /// `r` ↔ `10 - r` inside each numbered suit. Honours stay put.
    #[must_use]
    pub fn rank_mirror() -> Self {
        let mut this = Self::identity();
        for suit in Suit::ALL {
            for rank in 0..9 {
                this.kinds[suit.base() + rank] = (suit.base() + 8 - rank) as u8;
            }
        }
        this
    }

    /// Rotate the four wind honours by `steps`, leaving dragons alone.
    #[must_use]
    pub fn wind_rotation(steps: u8) -> Self {
        let mut this = Self::identity();
        let steps = usize::from(steps % 4);
        for wind in 0..4 {
            this.kinds[FIRST_WIND + wind] = (FIRST_WIND + (wind + steps) % 4) as u8;
        }
        this
    }

    /// Where one kind index goes. Indices outside the 34 kinds are returned
    /// unchanged and are rejected by the callers that can see a bad index.
    #[must_use]
    pub fn kind(&self, kind: usize) -> usize {
        self.kinds
            .get(kind)
            .map_or(kind, |mapped| usize::from(*mapped))
    }

    /// Whether the map changes nothing.
    #[must_use]
    pub fn is_identity(&self) -> bool {
        self.kinds
            .iter()
            .enumerate()
            .all(|(index, mapped)| usize::from(*mapped) == index)
    }

    /// Relabel one app tile code (`3m`, `7z`).
    pub fn map_code(&self, code: &str) -> Result<String, TransformError> {
        let index = tile_index(code).ok_or_else(|| TransformError::InvalidTile {
            tile: code.to_string(),
        })?;
        tile_name(self.kind(index)).ok_or_else(|| TransformError::InvalidTile {
            tile: code.to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_suit_map_is_a_bijection_with_an_inverse() {
        let mut checked = 0;
        for m in Suit::ALL {
            for p in Suit::ALL {
                for s in Suit::ALL {
                    let Ok(map) = SuitMap::new(m, p, s) else {
                        continue;
                    };
                    checked += 1;
                    let inverse = map.inverse();
                    for suit in Suit::ALL {
                        assert_eq!(inverse.map(map.map(suit)), suit);
                    }
                }
            }
        }
        assert_eq!(checked, 6);
        assert!(SuitMap::new(Suit::Man, Suit::Man, Suit::Sou).is_err());
    }

    #[test]
    fn suit_and_rank_maps_relabel_codes_and_keep_honours() {
        let man_to_pin = SuitMap::new(Suit::Pin, Suit::Sou, Suit::Man).expect("bijection");
        let map = KindMap::suit(man_to_pin);
        assert_eq!(map.map_code("3m").unwrap(), "3p");
        assert_eq!(map.map_code("3p").unwrap(), "3s");
        assert_eq!(map.map_code("3s").unwrap(), "3m");
        assert_eq!(map.map_code("7z").unwrap(), "7z");

        let mirror = KindMap::rank_mirror();
        assert_eq!(mirror.map_code("1m").unwrap(), "9m");
        assert_eq!(mirror.map_code("5p").unwrap(), "5p");
        assert_eq!(mirror.map_code("3z").unwrap(), "3z");
        assert_eq!(mirror.map_code("9s").unwrap(), "1s");
    }

    #[test]
    fn the_wind_rotation_only_moves_winds() {
        let map = KindMap::wind_rotation(1);
        assert_eq!(map.map_code("1z").unwrap(), "2z");
        assert_eq!(map.map_code("4z").unwrap(), "1z");
        assert_eq!(map.map_code("5z").unwrap(), "5z");
        assert_eq!(map.map_code("1m").unwrap(), "1m");
        assert!(KindMap::wind_rotation(4).is_identity());
    }

    #[test]
    fn kind_maps_are_involutions_or_cycles_as_documented() {
        let mirror = KindMap::rank_mirror();
        for kind in 0..TILE_KINDS {
            assert_eq!(mirror.kind(mirror.kind(kind)), kind);
        }

        let rotate = KindMap::wind_rotation(1);
        for kind in 0..TILE_KINDS {
            assert_eq!(
                rotate.kind(rotate.kind(rotate.kind(rotate.kind(kind)))),
                kind
            );
        }

        let suits =
            KindMap::suit(SuitMap::new(Suit::Pin, Suit::Sou, Suit::Man).expect("bijection"));
        for kind in 0..TILE_KINDS {
            let once = suits.kind(kind);
            let twice = suits.kind(once);
            assert_eq!(suits.kind(twice), kind);
        }
    }

    #[test]
    fn bad_codes_are_rejected() {
        let map = KindMap::rank_mirror();
        for code in ["", "0m", "8z", "10m", "5m "] {
            assert!(map.map_code(code).is_err(), "`{code}` must be rejected");
        }
    }

    #[test]
    fn json_names_the_suits_by_letter() {
        let map = SuitMap::new(Suit::Pin, Suit::Sou, Suit::Man).expect("bijection");
        let json = serde_json::to_value(map).expect("serialises");
        assert_eq!(json, serde_json::json!({"m": "p", "p": "s", "s": "m"}));
        assert_eq!(
            serde_json::from_value::<SuitMap>(json).expect("parses"),
            map
        );
    }
}
