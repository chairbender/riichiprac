use std::collections::HashMap;

use agari::hand::decompose_hand;
use agari::parse::{to_counts, validate_hand};
use agari::shanten::{calculate_shanten, calculate_ukeire};
use agari::tile::{Honor, Suit, Tile};
use serde::{Deserialize, Serialize};

use crate::rng::{choose, gen_bool};

/// All 34 standard Mahjong tile types.
pub const ALL_TILES: [Tile; 34] = [
    // Manzu (Characters)
    Tile::Suited { suit: Suit::Man, value: 1 },
    Tile::Suited { suit: Suit::Man, value: 2 },
    Tile::Suited { suit: Suit::Man, value: 3 },
    Tile::Suited { suit: Suit::Man, value: 4 },
    Tile::Suited { suit: Suit::Man, value: 5 },
    Tile::Suited { suit: Suit::Man, value: 6 },
    Tile::Suited { suit: Suit::Man, value: 7 },
    Tile::Suited { suit: Suit::Man, value: 8 },
    Tile::Suited { suit: Suit::Man, value: 9 },
    // Pinzu (Dots)
    Tile::Suited { suit: Suit::Pin, value: 1 },
    Tile::Suited { suit: Suit::Pin, value: 2 },
    Tile::Suited { suit: Suit::Pin, value: 3 },
    Tile::Suited { suit: Suit::Pin, value: 4 },
    Tile::Suited { suit: Suit::Pin, value: 5 },
    Tile::Suited { suit: Suit::Pin, value: 6 },
    Tile::Suited { suit: Suit::Pin, value: 7 },
    Tile::Suited { suit: Suit::Pin, value: 8 },
    Tile::Suited { suit: Suit::Pin, value: 9 },
    // Souzu (Bamboo)
    Tile::Suited { suit: Suit::Sou, value: 1 },
    Tile::Suited { suit: Suit::Sou, value: 2 },
    Tile::Suited { suit: Suit::Sou, value: 3 },
    Tile::Suited { suit: Suit::Sou, value: 4 },
    Tile::Suited { suit: Suit::Sou, value: 5 },
    Tile::Suited { suit: Suit::Sou, value: 6 },
    Tile::Suited { suit: Suit::Sou, value: 7 },
    Tile::Suited { suit: Suit::Sou, value: 8 },
    Tile::Suited { suit: Suit::Sou, value: 9 },
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

/// Formats a list of tiles into standard compact Mahjong notation (e.g. "123m456p789s11122z").
pub fn format_hand_compact(tiles: &[Tile]) -> String {
    let mut sorted = tiles.to_vec();
    sorted.sort();

    let mut result = String::new();
    let mut m_vals = Vec::new();
    let mut p_vals = Vec::new();
    let mut s_vals = Vec::new();
    let mut z_vals = Vec::new();

    for tile in sorted {
        match tile {
            Tile::Suited { suit: Suit::Man, value } => m_vals.push(value),
            Tile::Suited { suit: Suit::Pin, value } => p_vals.push(value),
            Tile::Suited { suit: Suit::Sou, value } => s_vals.push(value),
            Tile::Honor(h) => {
                let v = match h {
                    Honor::East => 1,
                    Honor::South => 2,
                    Honor::West => 3,
                    Honor::North => 4,
                    Honor::White => 5,
                    Honor::Green => 6,
                    Honor::Red => 7,
                };
                z_vals.push(v);
            }
        }
    }

    if !m_vals.is_empty() {
        for v in m_vals {
            result.push_str(&v.to_string());
        }
        result.push('m');
    }
    if !p_vals.is_empty() {
        for v in p_vals {
            result.push_str(&v.to_string());
        }
        result.push('p');
    }
    if !s_vals.is_empty() {
        for v in s_vals {
            result.push_str(&v.to_string());
        }
        result.push('s');
    }
    if !z_vals.is_empty() {
        for v in z_vals {
            result.push_str(&v.to_string());
        }
        result.push('z');
    }

    result
}

/// Serialized payload representing a generated puzzle and its evaluation by `agari`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PuzzleResponse {
    pub category: String,
    pub hand_string: String,
    pub tiles: Vec<String>,
    pub shanten: i8,
    pub is_agari: bool,
    pub decompositions_count: usize,
    pub ukeire_tiles: Vec<String>,
    pub ukeire_total: u8,
}

/// Scenario generator that implements 5-block theory hand generation.
#[derive(Debug, Default, Clone)]
pub struct ScenarioGenerator;

impl ScenarioGenerator {
    pub fn new() -> Self {
        Self
    }

    /// Generates a randomized 14-tile hand using 5-block theory (4 melds + 1 pair)
    /// sampled from a fresh 136-tile pool.
    pub fn generate_random_hand(&self) -> Vec<Tile> {
        let mut deck: HashMap<Tile, u8> = HashMap::new();
        for &tile in &ALL_TILES {
            deck.insert(tile, 4);
        }

        let mut hand: Vec<Tile> = Vec::with_capacity(14);

        // Block 1: The Pair (Jantou)
        // Find tiles with at least 2 remaining copies in the deck
        let pair_candidates: Vec<Tile> = ALL_TILES
            .iter()
            .copied()
            .filter(|t| deck.get(t).copied().unwrap_or(0) >= 2)
            .collect();

        if let Some(pair_tile) = choose(&pair_candidates) {
            hand.push(pair_tile);
            hand.push(pair_tile);
            *deck.entry(pair_tile).or_insert(0) -= 2;
        }

        // Blocks 2 to 5: 4 Melds (Mentsu) - either sequence (shuntsu) or triplet (koutsu)
        for _ in 0..4 {
            let want_sequence = gen_bool(0.65);
            let meld_formed = if want_sequence {
                self.try_add_sequence(&mut hand, &mut deck)
                    || self.try_add_triplet(&mut hand, &mut deck)
            } else {
                self.try_add_triplet(&mut hand, &mut deck)
                    || self.try_add_sequence(&mut hand, &mut deck)
            };

            // Fallback: if neither meld could be formed, fill with available tiles
            if !meld_formed {
                for _ in 0..3 {
                    let available: Vec<Tile> = ALL_TILES
                        .iter()
                        .copied()
                        .filter(|t| deck.get(t).copied().unwrap_or(0) > 0)
                        .collect();
                    if let Some(t) = choose(&available) {
                        hand.push(t);
                        *deck.entry(t).or_insert(0) -= 1;
                    }
                }
            }
        }

        // Ensure hand is padded to 14 tiles if any step lacked tiles
        while hand.len() < 14 {
            let available: Vec<Tile> = ALL_TILES
                .iter()
                .copied()
                .filter(|t| deck.get(t).copied().unwrap_or(0) > 0)
                .collect();
            if let Some(t) = choose(&available) {
                hand.push(t);
                *deck.entry(t).or_insert(0) -= 1;
            } else {
                break;
            }
        }

        hand.sort();
        hand
    }

    fn try_add_sequence(&self, hand: &mut Vec<Tile>, deck: &mut HashMap<Tile, u8>) -> bool {
        let suits = [Suit::Man, Suit::Pin, Suit::Sou];
        let mut candidates = Vec::new();

        for &suit in &suits {
            for start_val in 1..=7 {
                let t1 = Tile::Suited { suit, value: start_val };
                let t2 = Tile::Suited { suit, value: start_val + 1 };
                let t3 = Tile::Suited { suit, value: start_val + 2 };

                if deck.get(&t1).copied().unwrap_or(0) >= 1
                    && deck.get(&t2).copied().unwrap_or(0) >= 1
                    && deck.get(&t3).copied().unwrap_or(0) >= 1
                {
                    candidates.push((t1, t2, t3));
                }
            }
        }

        if let Some((t1, t2, t3)) = choose(&candidates) {
            hand.push(t1);
            hand.push(t2);
            hand.push(t3);
            *deck.entry(t1).or_insert(0) -= 1;
            *deck.entry(t2).or_insert(0) -= 1;
            *deck.entry(t3).or_insert(0) -= 1;
            true
        } else {
            false
        }
    }

    fn try_add_triplet(&self, hand: &mut Vec<Tile>, deck: &mut HashMap<Tile, u8>) -> bool {
        let candidates: Vec<Tile> = ALL_TILES
            .iter()
            .copied()
            .filter(|t| deck.get(t).copied().unwrap_or(0) >= 3)
            .collect();

        if let Some(tile) = choose(&candidates) {
            hand.push(tile);
            hand.push(tile);
            hand.push(tile);
            *deck.entry(tile).or_insert(0) -= 3;
            true
        } else {
            false
        }
    }

    /// Evaluates a 14-tile hand using the `agari` crate.
    pub fn evaluate_hand(&self, tiles: &[Tile]) -> Result<PuzzleResponse, String> {
        validate_hand(tiles)?;

        let counts = to_counts(tiles);
        let shanten_res = calculate_shanten(&counts);
        let decompositions = decompose_hand(&counts);
        let ukeire_res = calculate_ukeire(&counts);

        let hand_string = format_hand_compact(tiles);
        let tile_strings = tiles.iter().map(|t| t.to_string()).collect();
        let ukeire_tiles = ukeire_res.tiles.iter().map(|u| u.tile.to_string()).collect();

        Ok(PuzzleResponse {
            category: "random".to_string(),
            hand_string,
            tiles: tile_strings,
            shanten: shanten_res.shanten,
            is_agari: shanten_res.shanten == -1,
            decompositions_count: decompositions.len(),
            ukeire_tiles,
            ukeire_total: ukeire_res.total_count,
        })
    }

    /// Generates a randomized hand and returns its evaluated puzzle payload.
    pub fn generate_puzzle(&self, category: &str) -> Result<PuzzleResponse, String> {
        let tiles = self.generate_random_hand();
        let mut puzzle = self.evaluate_hand(&tiles)?;
        puzzle.category = category.to_string();
        Ok(puzzle)
    }
}

/// Standalone function for generating a 14-tile hand via 5-block theory.
pub fn generate_random_hand() -> Vec<Tile> {
    ScenarioGenerator::new().generate_random_hand()
}

#[cfg(test)]
mod tests {
    use super::*;
    use agari::parse::parse_hand;

    #[test]
    fn test_generate_random_hand_structure() {
        let generator = ScenarioGenerator::new();
        for _ in 0..20 {
            let hand = generator.generate_random_hand();
            assert_eq!(hand.len(), 14, "Hand must have exactly 14 tiles");

            // Verify with agari validate_hand
            assert!(validate_hand(&hand).is_ok());

            // Verify formatting round-trip
            let compact = format_hand_compact(&hand);
            let parsed = parse_hand(&compact).expect("Compact notation must parse in agari");
            assert_eq!(parsed.len(), 14);
        }
    }

    #[test]
    fn test_generate_puzzle() {
        let generator = ScenarioGenerator::new();
        let puzzle = generator.generate_puzzle("test_category").expect("Puzzle generation must succeed");
        assert_eq!(puzzle.category, "test_category");
        assert_eq!(puzzle.tiles.len(), 14);
        assert!(!puzzle.hand_string.is_empty());
    }
}
