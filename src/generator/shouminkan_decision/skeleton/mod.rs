mod shapes;
pub(crate) mod value;

use agari::parse::{to_counts, validate_hand};
use agari::shanten::{calculate_shanten, calculate_ukeire};
use agari::tile::{Honor, Suit, Tile};

use super::triggers::ShouminkanTriggerSet;
use crate::generator::support::deck::Deck;
use crate::rng::{choose, gen_bool};
use shapes::{build_wait_shape, draw_pair, draw_set};
use value::waits_have_value;

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
