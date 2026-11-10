use agari::parse::{to_counts, validate_hand};
use agari::shanten::{calculate_shanten, calculate_ukeire};
use agari::tile::{Honor, Suit, Tile};

use crate::generator::block_theory::shapes::{try_add_sequence, try_add_triplet};
use crate::generator::support::deck::{ALL_TILES, Deck};
use crate::rng::{choose, gen_bool, gen_range};

/// The constructed parts of a "Ryanmen protorun + 1" hand.
pub(super) struct RyanmenSkeleton {
    /// All 14 tiles for evaluation, including the open Yakuhai meld.
    pub full_tiles: Vec<Tile>,
    /// The 11 concealed tiles before the duplicate is discarded.
    pub concealed_tiles: Vec<Tile>,
    /// The three-tile shape (XXY or XYY).
    pub shape_tiles: [Tile; 3],
    /// The two tiles that complete the ryanmen.
    pub wait_tiles: [Tile; 2],
    /// The three tiles of the open Yakuhai meld.
    pub open_meld_tiles: Vec<Tile>,
    /// The duplicate tile that should be discarded.
    pub correct_tile: Tile,
}

/// Constructs a valid "Ryanmen protorun + 1" skeleton from a fresh deck.
pub(super) fn build_skeleton() -> Result<RyanmenSkeleton, String> {
    'attempt: for _ in 0..256 {
        let mut deck = Deck::fresh();

        let suits = [Suit::Man, Suit::Pin, Suit::Sou];
        let suit = choose(&suits).ok_or_else(|| "No suits available".to_string())?;

        // X and X+1 stay inside 2..=8 so the remaining two tiles are a
        // true ryanmen (23, 34, ... 78) rather than a terminal penchan.
        let base = gen_range(2, 8) as u8;
        let x = Tile::Suited { suit, value: base };
        let y = Tile::Suited {
            suit,
            value: base + 1,
        };
        let wait_low = Tile::Suited {
            suit,
            value: base - 1,
        };
        let wait_high = Tile::Suited {
            suit,
            value: base + 2,
        };

        // XXY leaves X as the duplicate; XYY leaves Y as the duplicate.
        let (shape_tiles, correct_tile) = if gen_bool(0.5) {
            ([x, x, y], x)
        } else {
            ([x, y, y], y)
        };

        for tile in &shape_tiles {
            if deck.take(*tile).is_err() {
                continue 'attempt;
            }
        }

        // Open Yakuhai triplet: any dragon guarantees a yaku.
        let dragons = [
            Tile::Honor(Honor::White),
            Tile::Honor(Honor::Green),
            Tile::Honor(Honor::Red),
        ];
        let dragon = choose(&dragons).ok_or_else(|| "No dragons available".to_string())?;
        let open_meld_tiles = vec![dragon, dragon, dragon];
        if deck.take_n(dragon, 3).is_err() {
            continue 'attempt;
        }

        // Two completed sets, either sequences or triplets.
        let mut concealed_tiles = Vec::with_capacity(11);
        for _ in 0..2 {
            let added = if gen_bool(0.65) {
                try_add_sequence(&mut concealed_tiles, &mut deck)
                    || try_add_triplet(&mut concealed_tiles, &mut deck)
            } else {
                try_add_triplet(&mut concealed_tiles, &mut deck)
                    || try_add_sequence(&mut concealed_tiles, &mut deck)
            };
            if !added {
                continue 'attempt;
            }
        }

        // A separate pair, deliberately not overlapping the special shape.
        let pair_candidates: Vec<Tile> = ALL_TILES
            .iter()
            .copied()
            .filter(|tile| !shape_tiles.contains(tile) && deck.count(*tile) >= 2)
            .collect();
        let pair_tile = match choose(&pair_candidates) {
            Some(tile) => tile,
            None => continue 'attempt,
        };
        concealed_tiles.push(pair_tile);
        concealed_tiles.push(pair_tile);
        if deck.take_n(pair_tile, 2).is_err() {
            continue 'attempt;
        }

        concealed_tiles.extend(shape_tiles.iter().copied());

        let mut full_tiles = concealed_tiles.clone();
        full_tiles.extend(open_meld_tiles.iter().copied());

        if validate_hand(&full_tiles).is_err() {
            continue 'attempt;
        }

        // Confirm the duplicate discard leaves a tenpai hand, that the
        // ryanmen is the only wait, and that both sides remain live.
        if !deck.has(wait_low) || !deck.has(wait_high) {
            continue 'attempt;
        }

        let mut post_discard = full_tiles.clone();
        let Some(duplicate_index) = post_discard.iter().position(|tile| *tile == correct_tile)
        else {
            continue 'attempt;
        };
        post_discard.remove(duplicate_index);
        let post_counts = to_counts(&post_discard);
        if calculate_shanten(&post_counts).shanten != 0 {
            continue 'attempt;
        }

        let post_ukeire = calculate_ukeire(&post_counts);
        let post_wait_tiles: Vec<Tile> = post_ukeire.tiles.iter().map(|u| u.tile).collect();
        if post_wait_tiles.len() != 2
            || !post_wait_tiles.contains(&wait_low)
            || !post_wait_tiles.contains(&wait_high)
        {
            continue 'attempt;
        }

        return Ok(RyanmenSkeleton {
            full_tiles,
            concealed_tiles,
            shape_tiles,
            wait_tiles: [wait_low, wait_high],
            open_meld_tiles,
            correct_tile,
        });
    }

    Err("Failed to construct a valid ryanmen protorun hand".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn test_ryanmen_skeleton_generalizes() {
        let mut suits = HashSet::new();
        let mut bases = HashSet::new();

        for _ in 0..100 {
            let skeleton = build_skeleton().expect("Ryanmen skeleton must build");

            assert_eq!(skeleton.full_tiles.len(), 14);
            assert_eq!(skeleton.concealed_tiles.len(), 11);
            assert_eq!(skeleton.open_meld_tiles.len(), 3);
            assert!(validate_hand(&skeleton.full_tiles).is_ok());

            let mut assembled = skeleton.concealed_tiles.clone();
            assembled.extend(skeleton.open_meld_tiles.iter().copied());
            assembled.sort();
            let mut full = skeleton.full_tiles.clone();
            full.sort();
            assert_eq!(assembled, full);

            let [a, b, c] = skeleton.shape_tiles;
            assert!(a == b || b == c, "shape must be XXY or XYY");
            let duplicate = if a == b { a } else { c };
            assert_eq!(skeleton.correct_tile, duplicate);

            let (x, y) = if a == b { (a, c) } else { (a, b) };
            let (wait_low, wait_high) = match (x, y) {
                (
                    Tile::Suited {
                        suit: suit_x,
                        value: value_x,
                    },
                    Tile::Suited {
                        suit: suit_y,
                        value: value_y,
                    },
                ) => {
                    assert_eq!(suit_x, suit_y);
                    assert_eq!(value_y, value_x + 1, "ryanmen tiles must be adjacent");
                    assert!(
                        (2..=7).contains(&value_x),
                        "lower ryanmen tile must stay within 2-7"
                    );
                    suits.insert(suit_x);
                    bases.insert(value_x);

                    (
                        Tile::Suited {
                            suit: suit_x,
                            value: value_x - 1,
                        },
                        Tile::Suited {
                            suit: suit_x,
                            value: value_x + 2,
                        },
                    )
                }
                _ => panic!("ryanmen shape must use suited tiles"),
            };
            assert_eq!(skeleton.wait_tiles, [wait_low, wait_high]);

            // The duplicate is the only discard that preserves the ryanmen.
            let mut post_discard = skeleton.full_tiles.clone();
            let duplicate_index = post_discard
                .iter()
                .position(|tile| *tile == skeleton.correct_tile)
                .expect("duplicate must be present");
            post_discard.remove(duplicate_index);
            assert_eq!(
                calculate_shanten(&to_counts(&post_discard)).shanten,
                0,
                "discarding the duplicate must leave tenpai"
            );

            let post_ukeire = calculate_ukeire(&to_counts(&post_discard));
            let wait_tiles: Vec<Tile> = post_ukeire.tiles.iter().map(|u| u.tile).collect();
            assert_eq!(wait_tiles.len(), 2);
            assert!(
                wait_tiles.contains(&wait_low) && wait_tiles.contains(&wait_high),
                "both sides of the ryanmen must remain live"
            );
        }

        assert!(suits.len() > 1, "generator must cover multiple suits");
        assert!(
            bases.len() > 1,
            "generator must cover multiple base numbers"
        );
    }
}
