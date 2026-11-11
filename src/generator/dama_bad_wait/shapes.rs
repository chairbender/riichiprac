//! Tile-shape helpers for the ch. 7 bad-wait lesson.
//!
//! The hand is always a closed standard tenpai whose wait is a *bad* wait,
//! which is what lets the box's live-tile count decide:
//!
//! - closed wait (kanchan): 24 waits on 3, one kind;
//! - edge wait (penchan): 12 waits on 3 (or 89 on 7), one kind;
//! - dual pon wait (shanpon): three sets and two pairs, two kinds.
//!
//! Riichi Book 1, table 7.1 ("Typical wait patterns") lists the first two as
//! 1 kind and the dual pon wait as 2 kinds-4 tiles; all three fail the
//! chapter's "at least two kinds and more than four tiles" good-wait test.
//!
//! The single wait (tanki) is deliberately absent: with four sets plus a lone
//! tile, the drawn tile would be a second legal tanki wait, so the hand would
//! have two correct discards and the lesson could not ask one Riichi-or-dama
//! question.

use agari::tile::{Suit, Tile};

use crate::generator::support::deck::{ALL_TILES, Deck};
use crate::rng::{choose, gen_range};

/// Which single- or dual-kind wait shape the hand uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum WaitShape {
    /// Two tiles with a one-tile gap (24 waits on 3).
    Kanchan,
    /// 12 waiting on 3, or 89 waiting on 7.
    Penchan,
    /// Three sets plus two pairs, waiting to pon either pair.
    Shanpon,
}

/// What the winning tile is allowed to be.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum WaitClass {
    /// Only a simple (2-8): the ch7:522 dama case.
    Simple,
    /// Any; used by the caller's curated honor/terminal wait list.
    Any,
}

/// The tiles the wait block contributes to the hand, plus its winning tiles.
pub(super) struct WaitBlock {
    /// Tiles placed into the thirteen-tile hand.
    pub tiles: Vec<Tile>,
    /// The winning tiles of the block.
    pub waits: Vec<Tile>,
}

/// Draws a wait block and its winning tiles.
///
/// The winning tile is chosen *before* the rest of the hand, and the caller
/// then removes every remaining copy from the deck, so no complete set or pair
/// can contain it. That keeps the block's copy count the only copies in hand,
/// which is what makes the live count predictable.
pub(super) fn draw_wait_block(
    deck: &mut Deck,
    shape: WaitShape,
    class: WaitClass,
) -> Result<WaitBlock, String> {
    match shape {
        WaitShape::Kanchan => {
            let suit = choose(&[Suit::Man, Suit::Pin, Suit::Sou])
                .ok_or_else(|| "No suit available".to_string())?;
            // v, v+2 holds the shape; v+1 wins. A simple winning tile needs
            // v+1 in 2..=8, so v is 1..=7.
            let starts: Vec<u8> = (1..=7u8)
                .filter(|&start| class_allows(class, Tile::suited(suit, start + 1)))
                .collect();
            let start = choose(&starts).ok_or_else(|| "No kanchan start".to_string())?;

            let tiles = vec![Tile::suited(suit, start), Tile::suited(suit, start + 2)];
            let waits = vec![Tile::suited(suit, start + 1)];
            for &tile in &tiles {
                deck.take(tile)?;
            }

            Ok(WaitBlock { tiles, waits })
        }
        WaitShape::Penchan => {
            let suit = choose(&[Suit::Man, Suit::Pin, Suit::Sou])
                .ok_or_else(|| "No suit available".to_string())?;
            // 12 waits 3 and 89 waits 7; both winning tiles are simple.
            let (values, wait_value) = if gen_range(0, 2) == 0 {
                (vec![1, 2], 3)
            } else {
                (vec![8, 9], 7)
            };
            let wait = Tile::suited(suit, wait_value);
            if !class_allows(class, wait) {
                return Err(format!("A penchan wait on {wait} is not {class:?}"));
            }

            let tiles: Vec<Tile> = values
                .iter()
                .map(|&value| Tile::suited(suit, value))
                .collect();
            for &tile in &tiles {
                deck.take(tile)?;
            }

            Ok(WaitBlock {
                tiles,
                waits: vec![wait],
            })
        }
        WaitShape::Shanpon => {
            let candidates: Vec<Tile> = ALL_TILES
                .iter()
                .copied()
                .filter(|&tile| deck.count(tile) >= 2 && class_allows(class, tile))
                .collect();
            let first = choose(&candidates).ok_or_else(|| "No shanpon tile".to_string())?;
            let rest: Vec<Tile> = candidates
                .into_iter()
                .filter(|tile| *tile != first)
                .collect();
            let second = choose(&rest).ok_or_else(|| "No second shanpon tile".to_string())?;

            draw_shanpon_pairs(deck, &[first, second])
        }
    }
}

/// Draws a dual pon wait on exactly the supplied tiles.
///
/// Used for the honor/terminal branch, where the winning tiles have to avoid
/// dragons and the round/seat winds (a triplet of any of those is a yaku).
pub(super) fn draw_shanpon_pairs(deck: &mut Deck, waits: &[Tile]) -> Result<WaitBlock, String> {
    if waits.len() != 2 || waits[0] == waits[1] {
        return Err("A shanpon needs two distinct wait tiles".to_string());
    }

    let mut tiles = Vec::with_capacity(4);
    for &wait in waits {
        deck.take_n(wait, 2)?;
        tiles.push(wait);
        tiles.push(wait);
    }

    Ok(WaitBlock {
        tiles,
        waits: waits.to_vec(),
    })
}

/// True when `tile` is allowed as the winning tile for this class.
fn class_allows(class: WaitClass, tile: Tile) -> bool {
    match class {
        WaitClass::Simple => tile.is_simple(),
        WaitClass::Any => true,
    }
}

/// Draws one complete set: a sequence or a triplet.
pub(super) fn draw_set(deck: &mut Deck) -> Result<Vec<Tile>, String> {
    let mut candidates: Vec<Vec<Tile>> = Vec::new();

    for suit in [Suit::Man, Suit::Pin, Suit::Sou] {
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
    }

    let set = choose(&candidates).ok_or_else(|| "No complete set available".to_string())?;
    for tile in &set {
        deck.take(*tile)?;
    }
    Ok(set)
}

/// Draws the pair of a closed/edge-wait hand.
pub(super) fn draw_pair(deck: &mut Deck) -> Result<Tile, String> {
    let candidates: Vec<Tile> = ALL_TILES
        .iter()
        .copied()
        .filter(|&tile| deck.count(tile) >= 2)
        .collect();

    let pair = choose(&candidates).ok_or_else(|| "No pair available".to_string())?;
    deck.take_n(pair, 2)?;
    Ok(pair)
}

/// Draws a tile that cannot pair with or extend the hand.
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
    fn simple_shapes_wait_on_the_expected_kinds() {
        for shape in [WaitShape::Kanchan, WaitShape::Penchan] {
            for _ in 0..50 {
                let mut deck = Deck::fresh();
                let block =
                    draw_wait_block(&mut deck, shape, WaitClass::Simple).expect("shape must draw");
                assert_eq!(block.waits.len(), 1, "{shape:?}");
                assert!(block.waits[0].is_simple(), "{shape:?}");
            }
        }
    }

    #[test]
    fn shanpon_holds_two_copies_of_two_distinct_tiles() {
        for _ in 0..50 {
            let mut deck = Deck::fresh();
            let block =
                draw_wait_block(&mut deck, WaitShape::Shanpon, WaitClass::Simple).expect("draw");
            assert_eq!(block.waits.len(), 2);
            assert_ne!(block.waits[0], block.waits[1]);
            let held: Vec<Tile> = block
                .tiles
                .iter()
                .filter(|tile| block.waits.contains(tile))
                .copied()
                .collect();
            assert_eq!(held.len(), 4);
            assert!(block.waits.iter().all(|wait| wait.is_simple()));
        }
    }

    #[test]
    fn an_explicit_shanpon_uses_the_given_tiles() {
        let waits = vec![
            Tile::Suited {
                suit: Suit::Man,
                value: 1,
            },
            Tile::Suited {
                suit: Suit::Pin,
                value: 9,
            },
        ];
        let mut deck = Deck::fresh();
        let block = draw_shanpon_pairs(&mut deck, &waits).expect("shanpon must draw");
        assert_eq!(block.waits, waits);
        assert_eq!(block.tiles.len(), 4);
        assert_eq!(deck.count(waits[0]), 2);
        assert_eq!(deck.count(waits[1]), 2);
    }

    #[test]
    fn an_isolated_tile_cannot_extend_the_hand() {
        use agari::tile::Honor;

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
