use std::collections::HashMap;

use agari::hand::decompose_hand;
use agari::parse::{to_counts, validate_hand};
use agari::shanten::{calculate_shanten, calculate_ukeire};
use agari::tile::{Honor, Suit, Tile};

use crate::rng::{choose, gen_bool, gen_range};
use crate::state::{
    CalledMeld, CorrectAction, CorrectActionType, DiscardTile, GameState, MeldType, PlayerState,
    TargetAction, Wind,
};

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

/// Builds a fresh 136-tile deck with four copies of every tile.
fn fresh_deck() -> HashMap<Tile, u8> {
    ALL_TILES.iter().map(|&tile| (tile, 4)).collect()
}

/// The constructed parts of a "Ryanmen protorun + 1" hand.
struct RyanmenSkeleton {
    /// All 14 tiles for evaluation, including the open Yakuhai meld.
    full_tiles: Vec<Tile>,
    /// The 11 concealed tiles before the duplicate is discarded.
    concealed_tiles: Vec<Tile>,
    /// The three-tile shape (XXY or XYY).
    shape_tiles: [Tile; 3],
    /// The three tiles of the open Yakuhai meld.
    open_meld_tiles: Vec<Tile>,
    /// The duplicate tile that should be discarded.
    correct_tile: Tile,
}

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
        let mut deck = fresh_deck();

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

    /// Generates the first Block Theory scenario: a ryanmen protorun (XXY/XYY)
    /// with an open Yakuhai meld, two completed sets, and a separate pair.
    ///
    /// The duplicate tile is the correct discard because it leaves the
    /// consecutive pair intact as a live ryanmen wait.
    pub fn generate_ryanmen_protorun(&self, category: &str) -> Result<GameState, String> {
        let mut state = self.generate_mock_puzzle(category)?;
        let skeleton = self.build_ryanmen_skeleton()?;
        let correct_tile = skeleton.correct_tile;
        if !skeleton.shape_tiles.contains(&correct_tile) {
            return Err("Ryanmen skeleton is missing its duplicate tile".to_string());
        }

        let mut full_tiles = skeleton.full_tiles.clone();
        full_tiles.sort();

        // Evaluate the resulting 13-tile hand after the correct discard so
        // shanten/ukeire describe the intended ryanmen wait.
        let mut post_discard_tiles = full_tiles.clone();
        let post_discard_index = post_discard_tiles
            .iter()
            .position(|tile| *tile == correct_tile)
            .ok_or_else(|| "Ryanmen skeleton is missing its duplicate tile".to_string())?;
        post_discard_tiles.remove(post_discard_index);

        let counts = to_counts(&post_discard_tiles);
        let shanten_res = calculate_shanten(&counts);
        let decompositions = decompose_hand(&counts);
        let ukeire_res = calculate_ukeire(&counts);

        let hand_string = format_hand_compact(&full_tiles);
        let tile_strings: Vec<String> = full_tiles.iter().map(|t| t.to_string()).collect();
        let ukeire_tiles: Vec<String> = ukeire_res
            .tiles
            .iter()
            .map(|u| u.tile.to_string())
            .collect();

        // The drawn tile is the duplicate, so it is immediately discardable.
        let mut human_hand = skeleton.concealed_tiles.clone();
        let duplicate_index = human_hand
            .iter()
            .position(|tile| *tile == correct_tile)
            .ok_or_else(|| "Ryanmen skeleton is missing its duplicate tile".to_string())?;
        human_hand.remove(duplicate_index);
        human_hand.sort();

        let meld_tiles: Vec<String> = skeleton
            .open_meld_tiles
            .iter()
            .map(|tile| tile.to_string())
            .collect();

        state.category = category.to_string();
        state.target_action = TargetAction::NaniKiru;
        state.correct_action = CorrectAction {
            action_type: CorrectActionType::Discard,
            tile: correct_tile.to_string(),
        };
        state.hand_string = hand_string;
        state.tiles = tile_strings;
        state.shanten = shanten_res.shanten;
        state.is_agari = shanten_res.shanten == -1;
        state.decompositions_count = decompositions.len();
        state.ukeire_tiles = ukeire_tiles;
        state.ukeire_total = ukeire_res.total_count;
        state.current_turn = 0;

        state.players[0] = PlayerState {
            seat: 0,
            name: "You".to_string(),
            is_human: true,
            wind: Wind::East,
            score: 25000,
            hand: human_hand.iter().map(|tile| tile.to_string()).collect(),
            draw: Some(correct_tile.to_string()),
            discards: Vec::new(),
            melds: vec![CalledMeld {
                meld_type: MeldType::Pon,
                tiles: meld_tiles,
                called_from: Some(1),
            }],
            is_riichi: false,
            riichi_discard_index: None,
        };

        Ok(state)
    }

    /// Constructs a valid "Ryanmen protorun + 1" skeleton from a fresh deck.
    fn build_ryanmen_skeleton(&self) -> Result<RyanmenSkeleton, String> {
        'attempt: for _ in 0..256 {
            let mut deck = fresh_deck();

            let suits = [Suit::Man, Suit::Pin, Suit::Sou];
            let suit = choose(&suits).ok_or_else(|| "No suits available".to_string())?;

            // X and X+1 stay inside 2..=8 so the remaining two tiles are a
            // true ryanmen (23, 34, ... 78) rather than a terminal penchan.
            let base = gen_range(2, 8) as u8;
            let x = Tile::Suited { suit, value: base };
            let y = Tile::Suited {
                suit,
                value: base + 1,
            };

            // XXY leaves X as the duplicate; XYY leaves Y as the duplicate.
            let (shape_tiles, correct_tile) = if gen_bool(0.5) {
                ([x, x, y], x)
            } else {
                ([x, y, y], y)
            };

            let mut shape_can_be_removed = true;
            for tile in &shape_tiles {
                match deck.get_mut(tile) {
                    Some(count) if *count > 0 => *count -= 1,
                    _ => shape_can_be_removed = false,
                }
            }
            if !shape_can_be_removed {
                continue 'attempt;
            }

            // Open Yakuhai triplet: any dragon guarantees a yaku.
            let dragons = [
                Tile::Honor(Honor::White),
                Tile::Honor(Honor::Green),
                Tile::Honor(Honor::Red),
            ];
            let dragon = choose(&dragons).ok_or_else(|| "No dragons available".to_string())?;
            let open_meld_tiles = vec![dragon, dragon, dragon];
            for _ in 0..3 {
                if let Some(count) = deck.get_mut(&dragon) {
                    *count -= 1;
                }
            }

            // Two completed sets, either sequences or triplets.
            let mut concealed_tiles = Vec::with_capacity(11);
            for _ in 0..2 {
                let added = if gen_bool(0.65) {
                    self.try_add_sequence(&mut concealed_tiles, &mut deck)
                        || self.try_add_triplet(&mut concealed_tiles, &mut deck)
                } else {
                    self.try_add_triplet(&mut concealed_tiles, &mut deck)
                        || self.try_add_sequence(&mut concealed_tiles, &mut deck)
                };
                if !added {
                    continue 'attempt;
                }
            }

            // A separate pair, deliberately not overlapping the special shape.
            let pair_candidates: Vec<Tile> = ALL_TILES
                .iter()
                .copied()
                .filter(|tile| {
                    !shape_tiles.contains(tile) && deck.get(tile).copied().unwrap_or(0) >= 2
                })
                .collect();
            let pair_tile = match choose(&pair_candidates) {
                Some(tile) => tile,
                None => continue 'attempt,
            };
            concealed_tiles.push(pair_tile);
            concealed_tiles.push(pair_tile);
            *deck
                .get_mut(&pair_tile)
                .expect("pair tile must exist in the deck") -= 2;

            concealed_tiles.extend(shape_tiles.iter().copied());

            let mut full_tiles = concealed_tiles.clone();
            full_tiles.extend(open_meld_tiles.iter().copied());

            if validate_hand(&full_tiles).is_err() {
                continue 'attempt;
            }

            // Confirm the duplicate discard leaves a tenpai hand, and that
            // both sides of the ryanmen are still available in the wall.
            let wait_low = Tile::Suited {
                suit,
                value: base - 1,
            };
            let wait_high = Tile::Suited {
                suit,
                value: base + 2,
            };
            if deck.get(&wait_low).copied().unwrap_or(0) == 0
                || deck.get(&wait_high).copied().unwrap_or(0) == 0
            {
                continue 'attempt;
            }

            let mut post_discard = full_tiles.clone();
            let Some(duplicate_index) = post_discard.iter().position(|tile| *tile == correct_tile)
            else {
                continue 'attempt;
            };
            post_discard.remove(duplicate_index);
            if calculate_shanten(&to_counts(&post_discard)).shanten != 0 {
                continue 'attempt;
            }

            return Ok(RyanmenSkeleton {
                full_tiles,
                concealed_tiles,
                shape_tiles,
                open_meld_tiles,
                correct_tile,
            });
        }

        Err("Failed to construct a valid ryanmen protorun hand".to_string())
    }

    /// Dispatches to the requested scenario. Unknown categories fall back to
    /// the first real Block Theory scenario; "mock_table" keeps the Phase 2
    /// fixture available for UI scaffolding and tests.
    pub fn generate_puzzle(&self, category: &str) -> Result<GameState, String> {
        match category {
            "mock_table" => self.generate_mock_puzzle(category),
            _ => self.generate_ryanmen_protorun(category),
        }
    }

    /// Evaluates a random 14-tile hand and populates the complete mocked
    /// `GameState` table used by the Phase 2 UI fixture.
    fn generate_mock_puzzle(&self, category: &str) -> Result<GameState, String> {
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
        let correct_discard = human_draw
            .clone()
            .or_else(|| human_standing_hand.first().cloned())
            .unwrap_or_default();

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
            correct_action: CorrectAction {
                action_type: CorrectActionType::Discard,
                tile: correct_discard,
            },

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
            .generate_puzzle("ryanmen_protorun")
            .expect("Puzzle generation must succeed");

        assert_eq!(state.category, "ryanmen_protorun");
        assert_eq!(state.target_action, TargetAction::NaniKiru);
        assert_eq!(state.tiles.len(), 14);
        assert_eq!(state.players.len(), 4);

        // Verify the expected answer points at a tile in the human hand
        assert_eq!(state.correct_action.action_type, CorrectActionType::Discard);
        assert!(state.tiles.contains(&state.correct_action.tile));

        // Verify global state
        assert_eq!(state.round_wind, Wind::East);
        assert_eq!(state.hand_number, 1);
        assert_eq!(state.honba, 1);
        assert_eq!(state.riichi_sticks, 1);
        assert_eq!(state.dora_indicators, vec!["5p"]);
        assert_eq!(state.tiles_remaining, 62);

        // The human has one open Yakuhai meld, 10 concealed tiles, and a draw.
        let human = &state.players[0];
        assert!(human.is_human);
        assert_eq!(human.hand.len(), 10);
        assert_eq!(
            human.draw.as_deref(),
            Some(state.correct_action.tile.as_str())
        );
        assert_eq!(human.melds.len(), 1);
        assert_eq!(human.melds[0].meld_type, MeldType::Pon);
        assert_eq!(human.melds[0].tiles.len(), 3);
        assert!(
            human.melds[0]
                .tiles
                .iter()
                .all(|tile| tile == &human.melds[0].tiles[0])
        );
        assert!(matches!(
            human.melds[0].tiles[0].as_str(),
            "5z" | "6z" | "7z"
        ));
        assert_eq!(human.hand.len() + 1 + human.melds[0].tiles.len(), 14);

        // Discarding the duplicate leaves a tenpai ryanmen wait.
        let mut post_discard = state.tiles.clone();
        let duplicate_index = post_discard
            .iter()
            .position(|tile| tile == &state.correct_action.tile)
            .expect("correct tile must be in the full hand");
        post_discard.remove(duplicate_index);
        let post_tiles =
            parse_hand(&post_discard.join("")).expect("post-discard hand must parse in agari");
        let post_counts = to_counts(&post_tiles);
        assert_eq!(calculate_shanten(&post_counts).shanten, 0);
        let ukeire = calculate_ukeire(&post_counts);
        assert!(ukeire.total_count > 0, "ryanmen wait must be live");
        assert!(ukeire.tiles.len() >= 2, "ryanmen wait must have two sides");

        // Verify Toimen is in Riichi
        let toimen = &state.players[2];
        assert!(toimen.is_riichi);
        assert_eq!(toimen.riichi_discard_index, Some(5));
        assert!(toimen.discards[5].is_riichi);

        // Verify the reused fixture opponents keep their open melds
        assert_eq!(state.players[1].melds.len(), 1);
        assert_eq!(state.players[1].melds[0].meld_type, MeldType::Chi);
        assert_eq!(state.players[3].melds.len(), 1);
        assert_eq!(state.players[3].melds[0].meld_type, MeldType::Pon);
    }

    #[test]
    fn test_mock_table_fixture_still_serves_phase2_shape() {
        let generator = ScenarioGenerator::new();
        let state = generator
            .generate_puzzle("mock_table")
            .expect("Mock table fixture must build");

        assert_eq!(state.category, "mock_table");
        assert_eq!(state.players[0].hand.len(), 13);
        assert!(state.players[2].is_riichi);
    }

    #[test]
    fn test_ryanmen_skeleton_generalizes() {
        use std::collections::HashSet;

        let generator = ScenarioGenerator::new();
        let mut suits = HashSet::new();
        let mut bases = HashSet::new();

        for _ in 0..100 {
            let skeleton = generator
                .build_ryanmen_skeleton()
                .expect("Ryanmen skeleton must build");

            assert_eq!(skeleton.full_tiles.len(), 14);
            assert_eq!(skeleton.concealed_tiles.len(), 11);
            assert_eq!(skeleton.open_meld_tiles.len(), 3);
            assert!(validate_hand(&skeleton.full_tiles).is_ok());

            let mut assembled = skeleton.concealed_tiles.clone();
            assembled.extend(skeleton.open_meld_tiles.iter().copied());
            assembled.sort();
            let mut full = skeleton.full_tiles.clone();
            full.sort();
            assert_eq!(assembled, full);

            let [a, b, c] = skeleton.shape_tiles;
            assert!(a == b || b == c, "shape must be XXY or XYY");
            let duplicate = if a == b { a } else { c };
            assert_eq!(skeleton.correct_tile, duplicate);

            let (x, y) = if a == b { (a, c) } else { (a, b) };
            let (wait_low, wait_high) = match (x, y) {
                (
                    Tile::Suited {
                        suit: suit_x,
                        value: value_x,
                    },
                    Tile::Suited {
                        suit: suit_y,
                        value: value_y,
                    },
                ) => {
                    assert_eq!(suit_x, suit_y);
                    assert_eq!(value_y, value_x + 1, "ryanmen tiles must be adjacent");
                    assert!(
                        (2..=7).contains(&value_x),
                        "lower ryanmen tile must stay within 2-7"
                    );
                    suits.insert(suit_x);
                    bases.insert(value_x);

                    (
                        Tile::Suited {
                            suit: suit_x,
                            value: value_x - 1,
                        },
                        Tile::Suited {
                            suit: suit_x,
                            value: value_x + 2,
                        },
                    )
                }
                _ => panic!("ryanmen shape must use suited tiles"),
            };

            // The duplicate is the only discard that preserves the ryanmen.
            let mut post_discard = skeleton.full_tiles.clone();
            let duplicate_index = post_discard
                .iter()
                .position(|tile| *tile == skeleton.correct_tile)
                .expect("duplicate must be present");
            post_discard.remove(duplicate_index);
            assert_eq!(
                calculate_shanten(&to_counts(&post_discard)).shanten,
                0,
                "discarding the duplicate must leave tenpai"
            );

            let post_ukeire = calculate_ukeire(&to_counts(&post_discard));
            let wait_tiles: Vec<Tile> = post_ukeire.tiles.iter().map(|u| u.tile).collect();
            assert!(
                wait_tiles.contains(&wait_low) && wait_tiles.contains(&wait_high),
                "both sides of the ryanmen must remain live"
            );
        }

        assert!(suits.len() > 1, "generator must cover multiple suits");
        assert!(
            bases.len() > 1,
            "generator must cover multiple base numbers"
        );
    }
}
