use agari::context::{GameContext, WinType};
use agari::hand::{Meld, decompose_hand_with_melds};
use agari::parse::{to_counts, validate_hand};
use agari::shanten::{calculate_shanten, calculate_ukeire};
use agari::tile::{Honor, Suit, Tile};
use agari::yaku::detect_yaku_with_context;

use super::triggers::ShouminkanTriggerSet;
use crate::generator::support::deck::{ALL_TILES, Deck};
use crate::rng::{choose, gen_bool, gen_range};

/// Whether the supplied wait completes with two or three winning tiles.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ShouminkanWaitShape {
    Ryanmen,
    ThreeSided,
}

/// The constructed parts of an Added Kan hand.
pub(super) struct ShouminkanSkeleton {
    /// The three tiles already called as an open Pon.
    pub open_pon_tiles: Vec<Tile>,
    /// The fourth copy of the Pon tile, currently drawn.
    pub drawn_tile: Tile,
    /// The ten concealed tiles left after discarding the drawn tile.
    pub concealed_tiles: Vec<Tile>,
    /// Winning tiles for the tenpai hand (2 for ryanmen, 3 for three-sided).
    pub wait_tiles: Vec<Tile>,
}

impl ShouminkanSkeleton {
    /// The fourteen visible tiles: concealed hand + draw + open Pon.
    pub(super) fn full_tiles(&self) -> Vec<Tile> {
        let mut tiles = Vec::with_capacity(14);
        tiles.extend(self.concealed_tiles.iter().copied());
        tiles.push(self.drawn_tile);
        tiles.extend(self.open_pon_tiles.iter().copied());
        tiles
    }
}

/// Builds a tenpai hand with an open dragon Pon, the fourth copy drawn,
/// a second dragon triplet for guaranteed value, and a ryanmen or
/// three-sided wait.
pub(super) fn build(triggers: ShouminkanTriggerSet) -> Result<ShouminkanSkeleton, String> {
    for _ in 0..512 {
        let mut deck = Deck::fresh();

        let dragons = [
            Tile::Honor(Honor::White),
            Tile::Honor(Honor::Green),
            Tile::Honor(Honor::Red),
        ];
        let pon_tile =
            choose(&dragons).ok_or_else(|| "No dragon available for the Pon".to_string())?;
        deck.take_n(pon_tile, 3)?;
        // Keep the fourth copy aside as the active draw.
        deck.take(pon_tile)?;
        let open_pon_tiles = vec![pon_tile; 3];

        let mut concealed_tiles = Vec::with_capacity(10);

        // The Good Wait & Value lesson forces a second dragon triplet so
        // the hand is worth at least two han before any Kan dora.
        let value_tile = if triggers.good_wait_and_value {
            let value_candidates: Vec<Tile> = dragons
                .iter()
                .copied()
                .filter(|&tile| tile != pon_tile)
                .collect();
            let value_tile = choose(&value_candidates)
                .ok_or_else(|| "No second dragon for guaranteed value".to_string())?;
            deck.take_n(value_tile, 3)?;
            concealed_tiles.extend([value_tile; 3]);
            Some(value_tile)
        } else {
            None
        };

        let wait_shape = if gen_bool(0.5) {
            ShouminkanWaitShape::ThreeSided
        } else {
            ShouminkanWaitShape::Ryanmen
        };
        let (shape_tiles, wait_tiles, shape_suit) = build_wait_shape(&mut deck, wait_shape)?;
        concealed_tiles.extend(shape_tiles);

        // An honor pair cannot interact with the suited wait shape.
        let pair_tile = draw_pair(&mut deck, pon_tile, value_tile)?;
        concealed_tiles.push(pair_tile);
        concealed_tiles.push(pair_tile);

        // Complete the remaining blocks in suits untouched by the wait.
        // A ryanmen shape needs two extra sets without the value triplet;
        // a three-sided shape needs one.
        let extra_sets = match (wait_shape, value_tile.is_some()) {
            (ShouminkanWaitShape::Ryanmen, false) => 2,
            (ShouminkanWaitShape::Ryanmen, true) => 1,
            (ShouminkanWaitShape::ThreeSided, false) => 1,
            (ShouminkanWaitShape::ThreeSided, true) => 0,
        };
        let mut used_suits = Vec::new();
        for _ in 0..extra_sets {
            let candidates: Vec<Suit> = [Suit::Man, Suit::Pin, Suit::Sou]
                .into_iter()
                .filter(|&suit| suit != shape_suit && !used_suits.contains(&suit))
                .collect();
            let set_suit =
                choose(&candidates).ok_or_else(|| "No secondary suit available".to_string())?;
            used_suits.push(set_suit);
            concealed_tiles.extend(draw_set(&mut deck, set_suit)?);
        }

        if concealed_tiles.len() != 10 {
            continue;
        }

        // Every winning tile must still be live in the wall.
        if wait_tiles.iter().any(|tile| !deck.has(*tile)) {
            continue;
        }

        let mut full_tiles = concealed_tiles.clone();
        full_tiles.push(pon_tile);
        full_tiles.extend(open_pon_tiles.iter().copied());
        if full_tiles.len() != 14 || validate_hand(&full_tiles).is_err() {
            continue;
        }

        let mut post_discard_tiles = concealed_tiles.clone();
        post_discard_tiles.extend(open_pon_tiles.iter().copied());
        let post_counts = to_counts(&post_discard_tiles);
        if calculate_shanten(&post_counts).shanten != 0 {
            continue;
        }

        let ukeire = calculate_ukeire(&post_counts);
        let ukeire_tiles: Vec<Tile> = ukeire.tiles.iter().map(|u| u.tile).collect();
        if ukeire_tiles.len() != wait_tiles.len()
            || !wait_tiles.iter().all(|tile| ukeire_tiles.contains(tile))
        {
            continue;
        }

        let min_han = if triggers.good_wait_and_value { 2 } else { 1 };
        if !waits_have_value(&concealed_tiles, pon_tile, &wait_tiles, min_han) {
            continue;
        }

        concealed_tiles.sort();
        let mut wait_tiles = wait_tiles;
        wait_tiles.sort();

        return Ok(ShouminkanSkeleton {
            open_pon_tiles,
            drawn_tile: pon_tile,
            concealed_tiles,
            wait_tiles,
        });
    }

    Err("Failed to construct a valid Added Kan skeleton".to_string())
}

/// Chooses the suited tiles that form a two-sided or three-sided wait.
fn build_wait_shape(
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
fn draw_pair(deck: &mut Deck, pon_tile: Tile, value_tile: Option<Tile>) -> Result<Tile, String> {
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
fn draw_set(deck: &mut Deck, suit: Suit) -> Result<Vec<Tile>, String> {
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

/// The lowest yaku han across every winning tile, before any Kan dora.
pub(super) fn min_wait_han(
    concealed_tiles: &[Tile],
    open_pon_tile: Tile,
    wait_tiles: &[Tile],
) -> u8 {
    let open_meld = Meld::koutsu_open(open_pon_tile);
    let mut min_han = u8::MAX;

    for &wait_tile in wait_tiles {
        let mut concealed_with_win = concealed_tiles.to_vec();
        concealed_with_win.push(wait_tile);
        let concealed_counts = to_counts(&concealed_with_win);
        let structures =
            decompose_hand_with_melds(&concealed_counts, std::slice::from_ref(&open_meld));
        if structures.is_empty() {
            return 0;
        }

        let mut full_with_win = concealed_with_win;
        full_with_win.extend([open_pon_tile; 3]);
        let full_counts = to_counts(&full_with_win);
        let context = GameContext::new(WinType::Ron, Honor::East, Honor::East)
            .with_winning_tile(wait_tile)
            .open();

        let han = structures
            .iter()
            .map(|structure| detect_yaku_with_context(structure, &full_counts, &context).total_han)
            .min()
            .unwrap_or(0);
        min_han = min_han.min(han);
    }

    if wait_tiles.is_empty() { 0 } else { min_han }
}

/// Verifies every winning tile scores at least `min_han` before Kan dora.
pub(super) fn waits_have_value(
    concealed_tiles: &[Tile],
    open_pon_tile: Tile,
    wait_tiles: &[Tile],
    min_han: u8,
) -> bool {
    min_wait_han(concealed_tiles, open_pon_tile, wait_tiles) >= min_han
}
