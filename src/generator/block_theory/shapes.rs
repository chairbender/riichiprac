use agari::tile::{Suit, Tile};

use crate::generator::support::deck::{ALL_TILES, Deck};
use crate::rng::choose;

/// Adds a random complete sequence if one is still available in the deck.
pub fn try_add_sequence(hand: &mut Vec<Tile>, deck: &mut Deck) -> bool {
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

            if deck.has(t1) && deck.has(t2) && deck.has(t3) {
                candidates.push((t1, t2, t3));
            }
        }
    }

    if let Some((t1, t2, t3)) = choose(&candidates) {
        if deck.take(t1).is_err() || deck.take(t2).is_err() || deck.take(t3).is_err() {
            return false;
        }
        hand.push(t1);
        hand.push(t2);
        hand.push(t3);
        true
    } else {
        false
    }
}

/// Adds a random complete triplet if one is still available in the deck.
pub fn try_add_triplet(hand: &mut Vec<Tile>, deck: &mut Deck) -> bool {
    let candidates: Vec<Tile> = ALL_TILES
        .iter()
        .copied()
        .filter(|tile| deck.count(*tile) >= 3)
        .collect();

    if let Some(tile) = choose(&candidates) {
        if deck.take_n(tile, 3).is_err() {
            return false;
        }
        hand.push(tile);
        hand.push(tile);
        hand.push(tile);
        true
    } else {
        false
    }
}
