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
