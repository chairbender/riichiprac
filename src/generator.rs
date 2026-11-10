use std::collections::HashMap;

use agari::hand::decompose_hand;
use agari::parse::{to_counts, validate_hand};
use agari::shanten::{calculate_shanten, calculate_ukeire};
use agari::tile::{Honor, Suit, Tile};

use crate::rng::{choose, gen_bool};
use crate::state::{CalledMeld, DiscardTile, GameState, MeldType, PlayerState, TargetAction, Wind};

pub type PuzzleResponse = GameState;

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
            Tile::Suited {
                suit: Suit::Man,
                value,
            } => m_vals.push(value),
            Tile::Suited {
                suit: Suit::Pin,
                value,
            } => p_vals.push(value),
            Tile::Suited {
                suit: Suit::Sou,
                value,
            } => s_vals.push(value),
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
                let t1 = Tile::Suited {
                    suit,
                    value: start_val,
                };
                let t2 = Tile::Suited {
                    suit,
                    value: start_val + 1,
                };
                let t3 = Tile::Suited {
                    suit,
                    value: start_val + 2,
                };

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

    /// Evaluates a 14-tile hand and populates the complete `GameState` table.
    pub fn generate_puzzle(&self, category: &str) -> Result<GameState, String> {
        let tiles = self.generate_random_hand();
        validate_hand(&tiles)?;

        let counts = to_counts(&tiles);
        let shanten_res = calculate_shanten(&counts);
        let decompositions = decompose_hand(&counts);
        let ukeire_res = calculate_ukeire(&counts);

        let hand_string = format_hand_compact(&tiles);
        let tile_strings: Vec<String> = tiles.iter().map(|t| t.to_string()).collect();
        let ukeire_tiles: Vec<String> = ukeire_res
            .tiles
            .iter()
            .map(|u| u.tile.to_string())
            .collect();

        // Separate human hand into 13 standing hand tiles + 1 active draw
        let human_standing_hand: Vec<String> = tile_strings[0..13].to_vec();
        let human_draw: Option<String> = tile_strings.get(13).cloned();

        // Player 0: Human User (Dealer / East)
        let player0 = PlayerState {
            seat: 0,
            name: "You".to_string(),
            is_human: true,
            wind: Wind::East,
            score: 25000,
            hand: human_standing_hand,
            draw: human_draw,
            discards: vec![
                DiscardTile::new("1z"),
                DiscardTile::new("9m"),
                DiscardTile::new("1p"),
                DiscardTile::tsumogiri("9s"),
                DiscardTile::new("2z"),
                DiscardTile::tsumogiri("8s"),
            ],
            melds: Vec::new(),
            is_riichi: false,
            riichi_discard_index: None,
        };

        // Player 1: Shimocha (South) - Has called Chi
        let player1 = PlayerState {
            seat: 1,
            name: "Shimocha".to_string(),
            is_human: false,
            wind: Wind::South,
            score: 25000,
            hand: vec![
                "1m".into(),
                "1m".into(),
                "2m".into(),
                "3m".into(),
                "4p".into(),
                "5p".into(),
                "6p".into(),
                "7s".into(),
                "8s".into(),
                "9s".into(),
            ],
            draw: None,
            discards: vec![
                DiscardTile::new("9m"),
                DiscardTile::new("1s"),
                DiscardTile::new("4z"),
                DiscardTile::tsumogiri("8p"),
                DiscardTile::new("2m"),
                DiscardTile::tsumogiri("3p"),
            ],
            melds: vec![CalledMeld {
                meld_type: MeldType::Chi,
                tiles: vec!["2s".to_string(), "3s".to_string(), "4s".to_string()],
                called_from: Some(0),
            }],
            is_riichi: false,
            riichi_discard_index: None,
        };

        // Player 2: Toimen (West) - In Riichi! Discard #5 ("6p") was the Riichi declaration tile
        let player2 = PlayerState {
            seat: 2,
            name: "Toimen".to_string(),
            is_human: false,
            wind: Wind::West,
            score: 24000, // Deducted 1000 for Riichi stick
            hand: vec![
                "1p".into(),
                "2p".into(),
                "3p".into(),
                "4s".into(),
                "5s".into(),
                "6s".into(),
                "7m".into(),
                "8m".into(),
                "9m".into(),
                "1m".into(),
                "2m".into(),
                "3m".into(),
                "7z".into(),
            ],
            draw: None,
            discards: vec![
                DiscardTile::new("1z"),
                DiscardTile::new("9p"),
                DiscardTile::new("1m"),
                DiscardTile::tsumogiri("7s"),
                DiscardTile::new("3z"),
                DiscardTile::riichi("6p"), // Riichi declaration tile (rotated in UI)
                DiscardTile::tsumogiri("8m"),
            ],
            melds: Vec::new(),
            is_riichi: true,
            riichi_discard_index: Some(5),
        };

        // Player 3: Kamicha (North) - Has called Pon of White Dragons
        let player3 = PlayerState {
            seat: 3,
            name: "Kamicha".to_string(),
            is_human: false,
            wind: Wind::North,
            score: 26000,
            hand: vec![
                "3m".into(),
                "4m".into(),
                "5m".into(),
                "2p".into(),
                "3p".into(),
                "4p".into(),
                "6s".into(),
                "7s".into(),
                "8s".into(),
                "1z".into(),
            ],
            draw: None,
            discards: vec![
                DiscardTile::new("7z"),
                DiscardTile::new("1s"),
                DiscardTile::new("9s"),
                DiscardTile::tsumogiri("2m"),
                DiscardTile::new("1m"),
                DiscardTile::tsumogiri("4p"),
            ],
            melds: vec![CalledMeld {
                meld_type: MeldType::Pon,
                tiles: vec!["5z".to_string(), "5z".to_string(), "5z".to_string()],
                called_from: Some(2),
            }],
            is_riichi: false,
            riichi_discard_index: None,
        };

        Ok(GameState {
            category: category.to_string(),
            target_action: TargetAction::Riichi,

            hand_string,
            tiles: tile_strings,
            shanten: shanten_res.shanten,
            is_agari: shanten_res.shanten == -1,
            decompositions_count: decompositions.len(),
            ukeire_tiles,
            ukeire_total: ukeire_res.total_count,

            round_wind: Wind::East,
            hand_number: 1,
            honba: 1,
            riichi_sticks: 1,
            dora_indicators: vec!["5p".to_string()],
            ura_dora_indicators: vec!["9s".to_string()],
            tiles_remaining: 62,

            current_turn: 0,
            players: vec![player0, player1, player2, player3],
        })
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

            assert!(validate_hand(&hand).is_ok());

            let compact = format_hand_compact(&hand);
            let parsed = parse_hand(&compact).expect("Compact notation must parse in agari");
            assert_eq!(parsed.len(), 14);
        }
    }

    #[test]
    fn test_generate_puzzle_game_state() {
        let generator = ScenarioGenerator::new();
        let state = generator
            .generate_puzzle("phase2_test")
            .expect("Puzzle generation must succeed");

        assert_eq!(state.category, "phase2_test");
        assert_eq!(state.tiles.len(), 14);
        assert_eq!(state.players.len(), 4);

        // Verify global state
        assert_eq!(state.round_wind, Wind::East);
        assert_eq!(state.hand_number, 1);
        assert_eq!(state.honba, 1);
        assert_eq!(state.riichi_sticks, 1);
        assert_eq!(state.dora_indicators, vec!["5p"]);
        assert_eq!(state.tiles_remaining, 62);

        // Verify players
        assert!(state.players[0].is_human);
        assert_eq!(state.players[0].hand.len(), 13);
        assert!(state.players[0].draw.is_some());

        // Verify Toimen is in Riichi
        let toimen = &state.players[2];
        assert!(toimen.is_riichi);
        assert_eq!(toimen.riichi_discard_index, Some(5));
        assert!(toimen.discards[5].is_riichi);

        // Verify open melds exist
        assert_eq!(state.players[1].melds.len(), 1);
        assert_eq!(state.players[1].melds[0].meld_type, MeldType::Chi);
        assert_eq!(state.players[3].melds.len(), 1);
        assert_eq!(state.players[3].melds[0].meld_type, MeldType::Pon);
    }
}
