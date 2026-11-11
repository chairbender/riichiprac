//! Tile-shape helpers for the general Riichi-judgement hand.
//!
//! A standard closed tenpai hand here is three complete sets, a pair, a
//! two-tile protorun (the wait), and one drawn tile that does not help. The
//! protorun decides the wait:
//!
//! - side wait (ryanmen): 34 waits on 2/5, two kinds;
//! - closed wait (kanchan): 24 waits on 3 only;
//! - edge wait (penchan): 12 waits on 3 only.
//!
//! Riichi Book 1, table 7.1 ("Typical wait patterns") lists those three as
//! 2 kinds-8 tiles, 1 kind-4 tiles, and 1 kind-4 tiles respectively.

use agari::tile::{Honor, Suit, Tile};

use super::judgement::Conditions;
use super::skeleton::ValueSource;
use crate::generator::support::deck::{ALL_TILES, Deck};
use crate::rng::{choose, gen_range};

/// The three straight protoruns the lesson uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum WaitShape {
    /// Two adjacent tiles, waiting on either end (2 kinds).
    Ryanmen,
    /// A gap of two, waiting on the middle tile (1 kind).
    Kanchan,
    /// 12 or 89, waiting on 3 or 7 (1 kind).
    Penchan,
}

impl WaitShape {
    /// The shape for a target: a good wait needs a ryanmen; a bad wait uses
    /// one of the single-kind shapes.
    pub(super) fn for_conditions(conditions: Conditions) -> Self {
        if conditions.good_wait {
            return Self::Ryanmen;
        }

        let shapes = [Self::Kanchan, Self::Penchan];
        choose(&shapes).unwrap_or(Self::Kanchan)
    }
}

/// Draws the wait protorun and its winning tiles.
///
/// `value` restricts the tiles when the hand has to be tanyao: every tile of
/// the *winning* hand must be a simple, and the winning tile counts, so a
/// tanyao ryanmen must wait on 2-5, 3-6, 4-7, or 5-8.
pub(super) fn draw_wait_shape(
    deck: &mut Deck,
    shape: WaitShape,
    value: Option<ValueSource>,
) -> Result<(Vec<Tile>, Vec<Tile>, Suit), String> {
    let simple_only = matches!(value, Some(ValueSource::Tanyao));
    let suits = [Suit::Man, Suit::Pin, Suit::Sou];
    let suit = choose(&suits).ok_or_else(|| "No suit available".to_string())?;

    let (shape_values, wait_values): (Vec<u8>, Vec<u8>) = match shape {
        WaitShape::Ryanmen => {
            // base, base+1 holds the tiles; base-1 and base+2 win.
            // A tanyao ryanmen needs the winning tiles simple too.
            let bases: Vec<u8> = if simple_only {
                (3..=6).collect()
            } else {
                (2..=7).collect()
            };
            let base = choose(&bases).ok_or_else(|| "No ryanmen base".to_string())?;
            (vec![base, base + 1], vec![base - 1, base + 2])
        }
        WaitShape::Kanchan => {
            // v, v+2 holds the tiles; v+1 wins.
            let starts: Vec<u8> = if simple_only {
                (2..=6).collect()
            } else {
                (1..=7).collect()
            };
            let start = choose(&starts).ok_or_else(|| "No kanchan start".to_string())?;
            (vec![start, start + 2], vec![start + 1])
        }
        WaitShape::Penchan => {
            // 12 waits 3 and 89 waits 7; never all-simple.
            let (shape_values, wait_value) = if gen_range(0, 2) == 0 {
                (vec![1, 2], 3)
            } else {
                (vec![8, 9], 7)
            };
            (shape_values, vec![wait_value])
        }
    };

    let shape_tiles: Vec<Tile> = shape_values
        .iter()
        .map(|&value| Tile::suited(suit, value))
        .collect();
    let wait_tiles: Vec<Tile> = wait_values
        .iter()
        .map(|&value| Tile::suited(suit, value))
        .collect();

    for tile in &shape_tiles {
        deck.take(*tile)?;
    }

    Ok((shape_tiles, wait_tiles, suit))
}

/// Draws the pair. Tanyao hands must pair a simple tile.
pub(super) fn draw_pair(deck: &mut Deck, value: Option<ValueSource>) -> Result<Tile, String> {
    let simple_only = matches!(value, Some(ValueSource::Tanyao));
    let candidates: Vec<Tile> = ALL_TILES
        .iter()
        .copied()
        .filter(|&tile| deck.count(tile) >= 2 && (!simple_only || tile.is_simple()))
        .collect();

    let pair = choose(&candidates).ok_or_else(|| "No pair available".to_string())?;
    deck.take_n(pair, 2)?;
    Ok(pair)
}

/// Draws one complete set: a sequence or a triplet.
pub(super) fn draw_set(deck: &mut Deck, value: Option<ValueSource>) -> Result<Vec<Tile>, String> {
    let simple_only = matches!(value, Some(ValueSource::Tanyao));
    let mut candidates: Vec<Vec<Tile>> = Vec::new();

    for suit in [Suit::Man, Suit::Pin, Suit::Sou] {
        for start in 1..=7u8 {
            let tiles = vec![
                Tile::suited(suit, start),
                Tile::suited(suit, start + 1),
                Tile::suited(suit, start + 2),
            ];
            if tiles.iter().any(|tile| !deck.has(*tile)) {
                continue;
            }
            if simple_only && tiles.iter().any(|tile| !tile.is_simple()) {
                continue;
            }
            candidates.push(tiles);
        }

        for value in 1..=9u8 {
            let tile = Tile::suited(suit, value);
            if deck.count(tile) >= 3 && (!simple_only || tile.is_simple()) {
                candidates.push(vec![tile; 3]);
            }
        }
    }

    let set = choose(&candidates).ok_or_else(|| "No complete set available".to_string())?;
    for tile in &set {
        deck.take(*tile)?;
    }
    Ok(set)
}

/// Draws the triplet that supplies the hand's first han.
///
/// A dragon triplet is a yakuhai: it scores even on a closed hand with a bad
/// wait, which is exactly the ch7.1 condition-1 case ("at least one han other
/// than riichi").
pub(super) fn draw_dragon_triplet(deck: &mut Deck) -> Result<Vec<Tile>, String> {
    let dragons = [
        Tile::Honor(Honor::White),
        Tile::Honor(Honor::Green),
        Tile::Honor(Honor::Red),
    ];
    let dragon = choose(&dragons).ok_or_else(|| "No dragon available".to_string())?;
    deck.take_n(dragon, 3)?;
    Ok(vec![dragon; 3])
}

/// Draws a tile that cannot pair with or extend the hand: an honor, or a suited
/// tile at least three ranks from every held tile of its suit.
///
/// This is the tile the player has just drawn and must discard. Keeping it
/// isolated means the draw cannot complete the tenpai hand or open a second,
/// unintended wait, so the discard stays unambiguous.
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
                // Honors never join a run; only a duplicate copy matters.
                if position >= 27 || held_position >= 27 {
                    return position != held_position;
                }
                position / 9 != held_position / 9 || position.abs_diff(held_position) > 2
            })
        })
        .map(|(_, tile)| tile)
        .collect();

    let tile = choose(&candidates).ok_or_else(|| "No isolated tile available".to_string())?;
    deck.take(tile)?;
    Ok(tile)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ryanmen_waits_on_two_kinds() {
        for _ in 0..50 {
            let mut deck = Deck::fresh();
            let (_, waits, _) =
                draw_wait_shape(&mut deck, WaitShape::Ryanmen, None).expect("ryanmen must draw");
            assert_eq!(waits.len(), 2);
        }
    }

    #[test]
    fn single_kind_shapes_wait_on_one_tile() {
        for shape in [WaitShape::Kanchan, WaitShape::Penchan] {
            for _ in 0..50 {
                let mut deck = Deck::fresh();
                let (_, waits, _) =
                    draw_wait_shape(&mut deck, shape, None).expect("shape must draw");
                assert_eq!(waits.len(), 1, "{shape:?}");
            }
        }
    }

    #[test]
    fn tanyao_shapes_keep_the_winning_tile_simple() {
        for _ in 0..100 {
            let mut deck = Deck::fresh();
            let (shape, waits, _) =
                draw_wait_shape(&mut deck, WaitShape::Ryanmen, Some(ValueSource::Tanyao))
                    .expect("tanyao ryanmen must draw");
            assert!(
                shape
                    .iter()
                    .chain(waits.iter())
                    .all(|tile| tile.is_simple())
            );
        }
    }

    #[test]
    fn an_isolated_tile_cannot_extend_the_hand() {
        let held = vec![
            Tile::suited(Suit::Man, 2),
            Tile::suited(Suit::Man, 3),
            Tile::Honor(Honor::White),
        ];
        for _ in 0..50 {
            let mut deck = Deck::fresh();
            let floater = draw_isolated(&mut deck, &held).expect("floater must draw");
            assert!(!held.contains(&floater));
            if let (Some(suit), Some(value)) = (floater.suit(), floater.value()) {
                let near_man = held.iter().any(|&tile| {
                    tile.suit() == Some(suit)
                        && tile.value().is_some_and(|held| held.abs_diff(value) <= 2)
                });
                assert!(!near_man, "{floater} sits next to the held tiles");
            }
        }
    }
}
