use agari::tile::{Suit, Tile};

use super::ShouminkanWaitShape;
use crate::generator::support::deck::{ALL_TILES, Deck};
use crate::rng::{choose, gen_range};

pub(super) fn build_wait_shape(
    deck: &mut Deck,
    wait_shape: ShouminkanWaitShape,
) -> Result<(Vec<Tile>, Vec<Tile>, Suit), String> {
    let suits = [Suit::Man, Suit::Pin, Suit::Sou];
    let suit = choose(&suits).ok_or_else(|| "No suit available".to_string())?;

    let (shape_tiles, wait_tiles) = match wait_shape {
        ShouminkanWaitShape::Ryanmen => {
            // 23 waits on 1/4, 78 waits on 6/9.
            let base = gen_range(2, 8) as u8;
            (
                vec![Tile::suited(suit, base), Tile::suited(suit, base + 1)],
                vec![Tile::suited(suit, base - 1), Tile::suited(suit, base + 2)],
            )
        }
        ShouminkanWaitShape::ThreeSided => {
            // 23456 waits on 1/4/7, 34567 on 2/5/8, 45678 on 3/6/9.
            let start = gen_range(2, 5) as u8;
            let shape_tiles = (start..start + 5)
                .map(|value| Tile::suited(suit, value))
                .collect();
            let wait_tiles = vec![
                Tile::suited(suit, start - 1),
                Tile::suited(suit, start + 2),
                Tile::suited(suit, start + 5),
            ];
            (shape_tiles, wait_tiles)
        }
    };

    for tile in &shape_tiles {
        deck.take(*tile)?;
    }

    Ok((shape_tiles, wait_tiles, suit))
}

/// Draws a ryanmen protorun (two adjacent suited tiles) from a suit that the
/// hand has not used yet. Used by the far-from-ready hands, which have no wait.
pub(super) fn draw_protorun(
    deck: &mut Deck,
    used_suits: &[Suit],
) -> Result<(Vec<Tile>, Suit), String> {
    let suits: Vec<Suit> = [Suit::Man, Suit::Pin, Suit::Sou]
        .into_iter()
        .filter(|suit| !used_suits.contains(suit))
        .collect();
    let suit = choose(&suits).ok_or_else(|| "No protorun suit available".to_string())?;

    let mut candidates: Vec<(Tile, Tile)> = Vec::new();
    for start in 1..=8u8 {
        let low = Tile::suited(suit, start);
        let high = Tile::suited(suit, start + 1);
        if deck.has(low) && deck.has(high) {
            candidates.push((low, high));
        }
    }

    let (low, high) = choose(&candidates).ok_or_else(|| "No protorun available".to_string())?;
    deck.take(low)?;
    deck.take(high)?;
    Ok((vec![low, high], suit))
}

/// Draws a pair, preferring a suited pair so far-from-ready hands look like the
/// book's examples rather than a pile of honors. `exclude` keeps the dragon
/// triplets and the Pon tile out of the pair.
pub(super) fn draw_mixed_pair(deck: &mut Deck, exclude: &[Tile]) -> Result<Tile, String> {
    let mut suited: Vec<Tile> = Vec::new();
    let mut honors: Vec<Tile> = Vec::new();
    for (position, &tile) in ALL_TILES.iter().enumerate() {
        if exclude.contains(&tile) || deck.count(tile) < 2 {
            continue;
        }
        if position < 27 {
            suited.push(tile);
        } else {
            honors.push(tile);
        }
    }

    let pair = choose(&suited)
        .or_else(|| choose(&honors))
        .ok_or_else(|| "No pair available".to_string())?;
    deck.take_n(pair, 2)?;
    Ok(pair)
}

/// Draws a tile that cannot form a taatsu or a pair with the tiles already in
/// the hand: an honor, or a suited tile at least two ranks away from every held
/// tile of that suit. These are the floating tiles of the far-from-ready hands.
pub(super) fn draw_isolated(deck: &mut Deck, held: &[Tile]) -> Result<Tile, String> {
    let held_positions: Vec<usize> = held
        .iter()
        .filter_map(|tile| ALL_TILES.iter().position(|candidate| candidate == tile))
        .collect();

    let candidates: Vec<Tile> = ALL_TILES
        .iter()
        .copied()
        .enumerate()
        .filter(|&(position, tile)| {
            if !deck.has(tile) {
                return false;
            }
            held_positions.iter().all(|&held_position| {
                // Honors never join a run; only duplicate copies matter.
                if position >= 27 || held_position >= 27 {
                    return position != held_position;
                }
                position / 9 != held_position / 9
                    || position.abs_diff(held_position) > 2
            })
        })
        .map(|(_, tile)| tile)
        .collect();

    let tile = choose(&candidates).ok_or_else(|| "No floating tile available".to_string())?;
    deck.take(tile)?;
    Ok(tile)
}

/// Draws an honor pair that does not collide with the dragon triplets.
pub(super) fn draw_pair(
    deck: &mut Deck,
    pon_tile: Tile,
    value_tile: Option<Tile>,
) -> Result<Tile, String> {
    let candidates: Vec<Tile> = ALL_TILES
        .iter()
        .copied()
        .filter(|&tile| {
            tile.is_honor() && tile != pon_tile && Some(tile) != value_tile && deck.count(tile) >= 2
        })
        .collect();
    let pair = choose(&candidates).ok_or_else(|| "No honor pair available".to_string())?;
    deck.take_n(pair, 2)?;
    Ok(pair)
}

/// Draws a complete sequence or triplet from one suit.
pub(super) fn draw_set(deck: &mut Deck, suit: Suit) -> Result<Vec<Tile>, String> {
    let mut candidates: Vec<Vec<Tile>> = Vec::new();

    for start in 1..=7u8 {
        let tiles = vec![
            Tile::suited(suit, start),
            Tile::suited(suit, start + 1),
            Tile::suited(suit, start + 2),
        ];
        if tiles.iter().all(|tile| deck.has(*tile)) {
            candidates.push(tiles);
        }
    }

    for value in 1..=9u8 {
        let tile = Tile::suited(suit, value);
        if deck.count(tile) >= 3 {
            candidates.push(vec![tile; 3]);
        }
    }

    let set = choose(&candidates)
        .ok_or_else(|| "No complete set available in the selected suit".to_string())?;
    for tile in &set {
        deck.take(*tile)?;
    }
    Ok(set)
}
