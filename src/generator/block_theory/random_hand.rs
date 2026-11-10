use agari::tile::Tile;

use crate::generator::block_theory::shapes::{try_add_sequence, try_add_triplet};
use crate::generator::support::deck::{ALL_TILES, Deck};
use crate::rng::{choose, gen_bool};

/// Generates a randomized 14-tile hand using 5-block theory (4 melds + 1 pair)
/// sampled from a fresh 136-tile pool.
pub fn generate() -> Vec<Tile> {
    let mut deck = Deck::fresh();

    let mut hand: Vec<Tile> = Vec::with_capacity(14);

    // Block 1: The Pair (Jantou)
    let pair_candidates: Vec<Tile> = ALL_TILES
        .iter()
        .copied()
        .filter(|tile| deck.count(*tile) >= 2)
        .collect();

    if let Some(pair_tile) = choose(&pair_candidates) {
        hand.push(pair_tile);
        hand.push(pair_tile);
        if deck.take_n(pair_tile, 2).is_err() {
            return hand;
        }
    }

    // Blocks 2 to 5: 4 Melds (Mentsu) - either sequence (shuntsu) or triplet (koutsu)
    for _ in 0..4 {
        let want_sequence = gen_bool(0.65);
        let meld_formed = if want_sequence {
            try_add_sequence(&mut hand, &mut deck) || try_add_triplet(&mut hand, &mut deck)
        } else {
            try_add_triplet(&mut hand, &mut deck) || try_add_sequence(&mut hand, &mut deck)
        };

        // Fallback: if neither meld could be formed, fill with available tiles
        if !meld_formed {
            for _ in 0..3 {
                if let Some(tile) = deck.draw() {
                    hand.push(tile);
                }
            }
        }
    }

    // Ensure hand is padded to 14 tiles if any step lacked tiles
    while hand.len() < 14 {
        if let Some(tile) = deck.draw() {
            hand.push(tile);
        } else {
            break;
        }
    }

    hand.sort();
    hand
}

#[cfg(test)]
mod tests {
    use super::*;
    use agari::parse::{parse_hand, validate_hand};

    use crate::generator::support::format::format_hand_compact;

    #[test]
    fn generated_hands_have_fourteen_valid_tiles() {
        for _ in 0..20 {
            let hand = generate();
            assert_eq!(hand.len(), 14, "Hand must have exactly 14 tiles");
            assert!(validate_hand(&hand).is_ok());

            let compact = format_hand_compact(&hand);
            let parsed = parse_hand(&compact).expect("Compact notation must parse in agari");
            assert_eq!(parsed.len(), 14);
        }
    }
}
