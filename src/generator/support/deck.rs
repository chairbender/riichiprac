use std::collections::HashMap;

use agari::tile::{Honor, Suit, Tile};

use crate::rng::choose;

/// All 34 standard Mahjong tile types.
pub const ALL_TILES: [Tile; 34] = [
    // Manzu (Characters)
    Tile::Suited {
        suit: Suit::Man,
        value: 1,
    },
    Tile::Suited {
        suit: Suit::Man,
        value: 2,
    },
    Tile::Suited {
        suit: Suit::Man,
        value: 3,
    },
    Tile::Suited {
        suit: Suit::Man,
        value: 4,
    },
    Tile::Suited {
        suit: Suit::Man,
        value: 5,
    },
    Tile::Suited {
        suit: Suit::Man,
        value: 6,
    },
    Tile::Suited {
        suit: Suit::Man,
        value: 7,
    },
    Tile::Suited {
        suit: Suit::Man,
        value: 8,
    },
    Tile::Suited {
        suit: Suit::Man,
        value: 9,
    },
    // Pinzu (Dots)
    Tile::Suited {
        suit: Suit::Pin,
        value: 1,
    },
    Tile::Suited {
        suit: Suit::Pin,
        value: 2,
    },
    Tile::Suited {
        suit: Suit::Pin,
        value: 3,
    },
    Tile::Suited {
        suit: Suit::Pin,
        value: 4,
    },
    Tile::Suited {
        suit: Suit::Pin,
        value: 5,
    },
    Tile::Suited {
        suit: Suit::Pin,
        value: 6,
    },
    Tile::Suited {
        suit: Suit::Pin,
        value: 7,
    },
    Tile::Suited {
        suit: Suit::Pin,
        value: 8,
    },
    Tile::Suited {
        suit: Suit::Pin,
        value: 9,
    },
    // Souzu (Bamboo)
    Tile::Suited {
        suit: Suit::Sou,
        value: 1,
    },
    Tile::Suited {
        suit: Suit::Sou,
        value: 2,
    },
    Tile::Suited {
        suit: Suit::Sou,
        value: 3,
    },
    Tile::Suited {
        suit: Suit::Sou,
        value: 4,
    },
    Tile::Suited {
        suit: Suit::Sou,
        value: 5,
    },
    Tile::Suited {
        suit: Suit::Sou,
        value: 6,
    },
    Tile::Suited {
        suit: Suit::Sou,
        value: 7,
    },
    Tile::Suited {
        suit: Suit::Sou,
        value: 8,
    },
    Tile::Suited {
        suit: Suit::Sou,
        value: 9,
    },
    // Honors: Winds
    Tile::Honor(Honor::East),
    Tile::Honor(Honor::South),
    Tile::Honor(Honor::West),
    Tile::Honor(Honor::North),
    // Honors: Dragons
    Tile::Honor(Honor::White),
    Tile::Honor(Honor::Green),
    Tile::Honor(Honor::Red),
];

/// A drawable Mahjong deck, tracking the copies of every tile left.
#[derive(Debug, Clone)]
pub struct Deck {
    tiles: HashMap<Tile, u8>,
}

impl Deck {
    /// Builds a fresh 136-tile deck with four copies of every tile.
    pub fn fresh() -> Self {
        Self {
            tiles: ALL_TILES.iter().map(|&tile| (tile, 4)).collect(),
        }
    }

    /// Number of copies of `tile` still in the deck.
    pub fn count(&self, tile: Tile) -> u8 {
        self.tiles.get(&tile).copied().unwrap_or(0)
    }

    /// True when at least one copy of `tile` remains.
    pub fn has(&self, tile: Tile) -> bool {
        self.count(tile) > 0
    }

    /// Removes one copy of `tile`, failing if none remain.
    pub fn take(&mut self, tile: Tile) -> Result<(), String> {
        match self.tiles.get_mut(&tile) {
            Some(count) if *count > 0 => {
                *count -= 1;
                Ok(())
            }
            _ => Err(format!("Tile {tile} is unavailable in the deck")),
        }
    }

    /// Removes `count` copies of `tile`, failing if any copy is missing.
    pub fn take_n(&mut self, tile: Tile, count: u8) -> Result<(), String> {
        if self.count(tile) < count {
            return Err(format!("Tile {tile} is unavailable in the deck"));
        }
        for _ in 0..count {
            self.take(tile)?;
        }
        Ok(())
    }

    /// Draws a random available tile type from the deck.
    pub fn draw(&mut self) -> Option<Tile> {
        let available: Vec<Tile> = ALL_TILES
            .iter()
            .copied()
            .filter(|tile| self.has(*tile))
            .collect();
        let tile = choose(&available)?;
        *self.tiles.get_mut(&tile)? -= 1;
        Some(tile)
    }

    /// Draws `count` random tiles from the deck.
    pub fn draw_n(&mut self, count: usize) -> Option<Vec<Tile>> {
        let mut tiles = Vec::with_capacity(count);
        for _ in 0..count {
            tiles.push(self.draw()?);
        }
        Some(tiles)
    }

    /// Draws `count` random tiles while never selecting an excluded tile.
    pub fn draw_excluding(&mut self, count: usize, excluded: &[Tile]) -> Option<Vec<Tile>> {
        let mut tiles = Vec::with_capacity(count);
        for _ in 0..count {
            let available: Vec<Tile> = ALL_TILES
                .iter()
                .copied()
                .filter(|tile| !excluded.contains(tile) && self.has(*tile))
                .collect();
            let tile = choose(&available)?;
            *self.tiles.get_mut(&tile)? -= 1;
            tiles.push(tile);
        }
        Some(tiles)
    }

    /// Total number of tiles still in the deck.
    pub fn remaining(&self) -> usize {
        self.tiles.values().map(|&count| count as usize).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_deck_holds_four_copies_of_every_tile() {
        let deck = Deck::fresh();
        assert_eq!(deck.remaining(), 136);
        for &tile in &ALL_TILES {
            assert_eq!(deck.count(tile), 4);
        }
    }

    #[test]
    fn take_and_take_n_respect_copy_limits() {
        let mut deck = Deck::fresh();
        let tile = Tile::Honor(Honor::White);

        deck.take_n(tile, 4).expect("four copies must be available");
        assert!(!deck.has(tile));
        assert!(deck.take(tile).is_err());
        assert!(deck.take_n(tile, 1).is_err());
        assert_eq!(deck.remaining(), 132);
    }

    #[test]
    fn draw_excluding_never_returns_excluded_tiles() {
        let mut deck = Deck::fresh();
        let excluded = [Tile::Honor(Honor::East), Tile::Honor(Honor::White)];

        let tiles = deck
            .draw_excluding(20, &excluded)
            .expect("deck must supply tiles");
        assert_eq!(tiles.len(), 20);
        assert!(tiles.iter().all(|tile| !excluded.contains(tile)));
    }
}
