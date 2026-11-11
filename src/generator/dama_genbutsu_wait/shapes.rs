//! Tile-shape helpers for the ch. 7 genbutsu-wait lesson.
//!
//! The hand is always the one the chapter's example describes: "you manage to
//! make your hand ready for pinfu, waiting for souzu 3 - souzu 6" (ch7:558).
//! Every complete block is a sequence, the pair is a suited tile, and the wait
//! is a two-sided (ryanmen) protorun:
//!
//! - side wait (ryanmen): 34 waits on 2/5, two kinds and eight nominal tiles;
//! - three sequences, never a triplet, so the closed hand stays pinfu-shaped;
//! - a suited pair, never an honor, so the pair is not a yakuhai pair.
//!
//! Pinfu is what makes the general ch7.1 rule say riichi, which is what the
//! genbutsu-wait section is an exception to: the hand has a han *and* a good
//! wait, and it still goes dama because one of the winning tiles is the
//! threatening player's genbutsu (ch7:538-539, ch7:558).

use agari::tile::{Suit, Tile};

use crate::generator::support::deck::{ALL_TILES, Deck};
use crate::rng::choose;

/// The tiles the waiting block contributes to the hand, plus its winning tiles.
pub(super) struct WaitBlock {
    /// The two protorun tiles placed into the thirteen-tile hand.
    pub tiles: Vec<Tile>,
    /// The two winning tiles that complete the protorun.
    pub waits: Vec<Tile>,
}

/// Draws a side-wait protorun and its two winning tiles.
///
/// `base` and `base + 1` are held; `base - 1` and `base + 2` win. Restricting
/// `base` to 2..=7 keeps every tile and every winning tile a number tile
/// (1..=9) of the same suit.
pub(super) fn draw_ryanmen(deck: &mut Deck) -> Result<WaitBlock, String> {
    let suit = choose(&[Suit::Man, Suit::Pin, Suit::Sou])
        .ok_or_else(|| "No suit available".to_string())?;
    let base =
        choose(&(2..=7u8).collect::<Vec<_>>()).ok_or_else(|| "No ryanmen base".to_string())?;

    let tiles = vec![Tile::suited(suit, base), Tile::suited(suit, base + 1)];
    let waits = vec![Tile::suited(suit, base - 1), Tile::suited(suit, base + 2)];
    for &tile in &tiles {
        deck.take(tile)?;
    }

    Ok(WaitBlock { tiles, waits })
}

/// Draws one complete sequence.
///
/// The lesson never draws a triplet: pinfu needs four runs, and a triplet would
/// both break the yaku and (for a simple triplet) invite tanyao instead.
pub(super) fn draw_sequence(deck: &mut Deck) -> Result<Vec<Tile>, String> {
    let mut candidates: Vec<Vec<Tile>> = Vec::with_capacity(21);

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
    }

    let set = choose(&candidates).ok_or_else(|| "No complete sequence available".to_string())?;
    for tile in &set {
        deck.take(*tile)?;
    }
    Ok(set)
}

/// Draws the pair of the pinfu hand. Only a suited tile may pair: an honor pair
/// of a dragon, the round wind, or the seat wind would be a yakuhai instead.
pub(super) fn draw_suited_pair(deck: &mut Deck) -> Result<Tile, String> {
    let candidates: Vec<Tile> = ALL_TILES
        .iter()
        .copied()
        .filter(|tile| !tile.is_honor() && deck.count(*tile) >= 2)
        .collect();

    let pair = choose(&candidates).ok_or_else(|| "No suited pair available".to_string())?;
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
    fn the_side_wait_holds_two_adjacent_tiles_and_waits_on_the_ends() {
        for _ in 0..50 {
            let mut deck = Deck::fresh();
            let block = draw_ryanmen(&mut deck).expect("ryanmen must draw");
            assert_eq!(block.tiles.len(), 2);
            assert_eq!(block.waits.len(), 2);

            let (Some(suit), Some(first)) = (block.tiles[0].suit(), block.tiles[0].value()) else {
                panic!("a ryanmen protorun is two suited tiles");
            };
            assert_eq!(block.tiles[1].suit(), Some(suit));
            assert_eq!(block.tiles[1].value(), Some(first + 1));
            assert!(block.waits.iter().all(|tile| tile.suit() == Some(suit)));
            assert_eq!(block.waits[0].value(), Some(first - 1));
            assert_eq!(block.waits[1].value(), Some(first + 2));
        }
    }

    #[test]
    fn every_complete_block_is_a_sequence() {
        for _ in 0..100 {
            let mut deck = Deck::fresh();
            let set = draw_sequence(&mut deck).expect("sequence must draw");
            assert_eq!(set.len(), 3);
            let (Some(suit), Some(first)) = (set[0].suit(), set[0].value()) else {
                panic!("a sequence is three suited tiles");
            };
            assert!(set.iter().all(|tile| tile.suit() == Some(suit)));
            assert_eq!(set[1].value(), Some(first + 1));
            assert_eq!(set[2].value(), Some(first + 2));
        }
    }

    #[test]
    fn the_pair_is_never_an_honor() {
        for _ in 0..100 {
            let mut deck = Deck::fresh();
            let pair = draw_suited_pair(&mut deck).expect("pair must draw");
            assert!(!pair.is_honor(), "honor pair would add a yakuhai");
            assert_eq!(deck.count(pair), 2);
        }
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
