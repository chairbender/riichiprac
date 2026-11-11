use std::collections::BTreeMap;

use agari::parse::to_counts;
use agari::shanten::{calculate_shanten, calculate_ukeire};
use agari::tile::{Suit, Tile};

use crate::generator::support::deck::{ALL_TILES, Deck};
use crate::rng::choose;

/// One suited tile, the shape builders' most repeated line.
pub fn suited(suit: Suit, value: u8) -> Tile {
    Tile::Suited { suit, value }
}

/// Shanten of a hand written as a tile list.
pub fn shanten(tiles: &[Tile]) -> i8 {
    calculate_shanten(&to_counts(tiles)).shanten
}

/// Theoretical tile acceptance of a hand written as a tile list.
pub fn ukeire(tiles: &[Tile]) -> u8 {
    calculate_ukeire(&to_counts(tiles)).total_count
}

/// Tile values held exactly twice, in tile order.
pub fn pair_tiles(tiles: &[Tile]) -> Vec<Tile> {
    let mut counts: BTreeMap<Tile, usize> = BTreeMap::new();
    for tile in tiles {
        *counts.entry(*tile).or_insert(0) += 1;
    }
    counts
        .into_iter()
        .filter(|(_, count)| *count == 2)
        .map(|(tile, _)| tile)
        .collect()
}

/// The distinct tiles of a hand, in tile order.
pub fn distinct_tiles(tiles: &[Tile]) -> Vec<Tile> {
    let mut distinct = tiles.to_vec();
    distinct.sort();
    distinct.dedup();
    distinct
}

/// Removes one copy of `discard` from `tiles`.
pub fn without(tiles: &[Tile], discard: Tile) -> Result<Vec<Tile>, String> {
    let mut remaining = tiles.to_vec();
    let index = remaining
        .iter()
        .position(|tile| *tile == discard)
        .ok_or_else(|| format!("{discard} is not in the hand"))?;
    remaining.remove(index);
    Ok(remaining)
}

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
