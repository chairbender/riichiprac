use agari::parse::{TileCounts, to_counts, validate_hand};
use agari::shanten::calculate_ukeire;
use agari::tile::{Honor, Suit, Tile};

use crate::generator::support::deck::{ALL_TILES, Deck};
use crate::rng::{choose, gen_bool, gen_range};

/// The constructed parts of a "bulging float in a ready hand" puzzle.
///
/// Riichi Book 1, ch. 3, "Four-tile complex shapes 2: nakabukure":
///
/// - "Any bulging float shapes from 2334 through 6778 can accept four kinds of
///   tiles to produce a side-wait protorun and a complete run." (ch3:681)
/// - "Try to keep a bulging float shape until a hand becomes 1-away." (ch3:708)
/// - "It is waiting for wan4, but we are already using two of it in the hand,
///   leaving only two winning tiles. We should rather discard wan4 to wait for
///   bei." (ch3:702)
///
/// So the skeleton is the book's ready-hand example: three complete sets (one
/// of them an open Yakuhai Pon, which also makes Riichi illegal), the bulging
/// float `x, x+1, x+1, x+2`, and one floating honor. The correct answer is the
/// bulge tile `x+1`; the alternative is the floating honor.
pub(super) struct NakabukureSkeleton {
    /// All 14 tiles for evaluation, including the open Yakuhai meld.
    pub full_tiles: Vec<Tile>,
    /// The 11 concealed tiles before the discard.
    pub concealed_tiles: Vec<Tile>,
    /// The four tiles of the bulging float (`x, x+1, x+1, x+2`).
    pub bulge_tiles: [Tile; 4],
    /// The middle tile `x+1`: the book's discard.
    pub bulge_tile: Tile,
    /// The floating honor: the tanki wait left by the book's discard.
    pub float_tile: Tile,
    /// The three tiles of the open Yakuhai meld.
    pub open_meld_tiles: Vec<Tile>,
}

/// Builds the book's ready-hand skeleton: three complete sets, the bulging
/// float `x, x+1, x+1, x+2`, and one floating honor. [`verify_waits`] checks
/// the two candidate discards.
pub(super) fn build_skeleton() -> Result<NakabukureSkeleton, String> {
    'attempt: for _ in 0..512 {
        let mut deck = Deck::fresh();

        let suits = [Suit::Man, Suit::Pin, Suit::Sou];
        let suit = choose(&suits).ok_or_else(|| "No suits available".to_string())?;

        // The book lists 2334 through 6778, so the run starts at 2..=6 and the
        // middle tile x+1 stays a 3..=7 middle tile.
        let base = gen_range(2, 7) as u8;
        let low = suited(suit, base);
        let mid = suited(suit, base + 1);
        let high = suited(suit, base + 2);
        let bulge_tiles = [low, mid, mid, high];
        for tile in &bulge_tiles {
            if deck.take(*tile).is_err() {
                continue 'attempt;
            }
        }

        // Open Yakuhai triplet: any dragon guarantees a yaku and makes Riichi
        // illegal, so the answer is the discard alone (dama).
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

        // Two complete sets, both outside the bulge's suit. If a set shared the
        // suit, breaking it could recombine with the bulge into two sets and
        // leave a second, equally good tenpai discard.
        let other_suits: Vec<Suit> = suits.iter().copied().filter(|s| *s != suit).collect();
        let mut concealed_tiles = Vec::with_capacity(11);
        for _ in 0..2 {
            if !add_set(&mut concealed_tiles, &mut deck, &other_suits) {
                continue 'attempt;
            }
        }

        // One floating honor: the single-tile wait after the bulge is gone.
        let float_candidates: Vec<Tile> = ALL_TILES
            .iter()
            .copied()
            .filter(|tile| matches!(tile, Tile::Honor(_)) && *tile != dragon && deck.has(*tile))
            .collect();
        let float_tile = match choose(&float_candidates) {
            Some(tile) => tile,
            None => continue 'attempt,
        };
        if deck.take(float_tile).is_err() {
            continue 'attempt;
        }

        concealed_tiles.extend(bulge_tiles.iter().copied());
        concealed_tiles.push(float_tile);

        let mut full_tiles = concealed_tiles.clone();
        full_tiles.extend(open_meld_tiles.iter().copied());
        if validate_hand(&full_tiles).is_err() {
            continue 'attempt;
        }

        return Ok(NakabukureSkeleton {
            full_tiles,
            concealed_tiles,
            bulge_tiles,
            bulge_tile: mid,
            float_tile,
            open_meld_tiles,
        });
    }

    Err("Failed to construct a valid nakabukure ready hand".to_string())
}

/// Confirms both candidate discards leave tenpai and that the book's discard
/// keeps strictly more winning tiles.
///
/// Two `calculate_ukeire` calls, no shape parsing: discarding the bulge tile
/// leaves the lone honour as the only wait (three live tiles); discarding the
/// honour leaves the bulge tile the hand already holds twice (two live tiles).
pub(super) fn verify_waits(skeleton: &NakabukureSkeleton) -> Result<(), String> {
    let bulge_counts = counts_without(&skeleton.full_tiles, skeleton.bulge_tile)
        .ok_or_else(|| "Nakabukure skeleton is missing its bulge tile".to_string())?;
    let float_counts = counts_without(&skeleton.full_tiles, skeleton.float_tile)
        .ok_or_else(|| "Nakabukure skeleton is missing its floating honor".to_string())?;

    let bulge_discard = calculate_ukeire(&bulge_counts);
    let float_discard = calculate_ukeire(&float_counts);

    if bulge_discard.shanten != 0 || float_discard.shanten != 0 {
        return Err("A candidate discard does not leave tenpai".to_string());
    }
    if bulge_discard.tiles.len() != 1 || bulge_discard.tiles[0].tile != skeleton.float_tile {
        return Err("Discarding the bulge must wait on the floating honor alone".to_string());
    }
    if float_discard.tiles.len() != 1 || float_discard.tiles[0].tile != skeleton.bulge_tile {
        return Err("Discarding the honor must wait on the bulge tile alone".to_string());
    }
    if bulge_discard.total_count <= float_discard.total_count {
        return Err("The bulge discard must keep strictly more winning tiles".to_string());
    }

    Ok(())
}

/// Adds a random complete set (sequence or triplet) in one of `suits`.
fn add_set(hand: &mut Vec<Tile>, deck: &mut Deck, suits: &[Suit]) -> bool {
    let mut sequences: Vec<[Tile; 3]> = Vec::new();
    let mut triplets: Vec<[Tile; 3]> = Vec::new();

    for &suit in suits {
        for start in 1..=7u8 {
            let meld = [
                suited(suit, start),
                suited(suit, start + 1),
                suited(suit, start + 2),
            ];
            if meld.iter().all(|tile| deck.has(*tile)) {
                sequences.push(meld);
            }
        }
        for value in 1..=9u8 {
            let tile = suited(suit, value);
            if deck.count(tile) >= 3 {
                triplets.push([tile; 3]);
            }
        }
    }

    let pick = if gen_bool(0.65) {
        choose(&sequences).or_else(|| choose(&triplets))
    } else {
        choose(&triplets).or_else(|| choose(&sequences))
    };
    let Some(meld) = pick else {
        return false;
    };
    for tile in meld {
        if deck.take(tile).is_err() {
            return false;
        }
    }
    hand.extend(meld);
    true
}

fn suited(suit: Suit, value: u8) -> Tile {
    Tile::Suited { suit, value }
}

/// Counts the hand after removing one copy of `discard`.
fn counts_without(tiles: &[Tile], discard: Tile) -> Option<TileCounts> {
    let mut remaining = tiles.to_vec();
    let index = remaining.iter().position(|tile| *tile == discard)?;
    remaining.remove(index);
    Some(to_counts(&remaining))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn skeleton_generalizes_across_suits_and_bases() {
        let mut suits = HashSet::new();
        let mut bases = HashSet::new();
        let mut floats = HashSet::new();

        for _ in 0..100 {
            let skeleton = build_skeleton().expect("Nakabukure skeleton must build");

            assert_eq!(skeleton.full_tiles.len(), 14);
            assert_eq!(skeleton.concealed_tiles.len(), 11);
            assert_eq!(skeleton.open_meld_tiles.len(), 3);
            assert!(validate_hand(&skeleton.full_tiles).is_ok());

            let [low, mid_a, mid_b, high] = skeleton.bulge_tiles;
            assert_eq!(mid_a, mid_b, "the bulge repeats its middle tile");
            assert_eq!(skeleton.bulge_tile, mid_a);
            let (Tile::Suited { suit, value }, Tile::Suited { suit: s2, .. }) = (low, high) else {
                panic!("the bulge must be a suited shape");
            };
            assert_eq!(suit, s2);
            assert_eq!(mid_a, suited(suit, value + 1));
            assert_eq!(high, suited(suit, value + 2));
            assert!(
                (2..=6).contains(&value),
                "bulge bases must stay inside the book's 2334-6778 range"
            );
            suits.insert(suit);
            bases.insert(value);

            assert!(matches!(skeleton.float_tile, Tile::Honor(_)));
            floats.insert(format!("{:?}", skeleton.float_tile));

            // Every concealed tile outside the bulge sits in another suit.
            let set_tiles: Vec<Tile> = skeleton
                .concealed_tiles
                .iter()
                .copied()
                .filter(|tile| !skeleton.bulge_tiles.contains(tile))
                .filter(|tile| *tile != skeleton.float_tile)
                .collect();
            assert_eq!(set_tiles.len(), 6);
            assert!(
                set_tiles.iter().all(|tile| tile.suit() != Some(suit)),
                "concealed sets must not share the bulge's suit"
            );

            // The open meld is three copies of one dragon.
            let open = &skeleton.open_meld_tiles;
            assert_eq!(open[0], open[1]);
            assert_eq!(open[1], open[2]);
            assert!(matches!(
                open[0],
                Tile::Honor(Honor::White | Honor::Green | Honor::Red)
            ));
            assert_ne!(open[0], skeleton.float_tile);
        }

        assert!(suits.len() > 1, "generator must cover multiple suits");
        assert!(bases.len() > 1, "generator must cover multiple bases");
        assert!(floats.len() > 1, "generator must cover multiple floats");
    }

    #[test]
    fn only_the_bulge_and_the_float_leave_tenpai() {
        use agari::shanten::calculate_shanten;

        for _ in 0..50 {
            let skeleton = build_skeleton().expect("Nakabukure skeleton must build");

            let mut tenpai_discards = Vec::new();
            let mut seen = HashSet::new();
            for tile in &skeleton.full_tiles {
                if !seen.insert(*tile) {
                    continue;
                }
                let counts = counts_without(&skeleton.full_tiles, *tile).expect("tile in hand");
                if calculate_shanten(&counts).shanten == 0 {
                    tenpai_discards.push(*tile);
                }
            }
            tenpai_discards.sort();
            let mut expected = vec![skeleton.bulge_tile, skeleton.float_tile];
            expected.sort();

            assert_eq!(
                tenpai_discards, expected,
                "exactly the bulge tile and the floating honor may leave tenpai"
            );
        }
    }

    #[test]
    fn bulge_discard_has_the_larger_wait() {
        for _ in 0..50 {
            let skeleton = build_skeleton().expect("Nakabukure skeleton must build");
            verify_waits(&skeleton).expect("every skeleton must pass the wait check");

            let bulge_counts =
                counts_without(&skeleton.full_tiles, skeleton.bulge_tile).expect("bulge in hand");
            let float_counts =
                counts_without(&skeleton.full_tiles, skeleton.float_tile).expect("float in hand");

            let bulge_discard = calculate_ukeire(&bulge_counts);
            let float_discard = calculate_ukeire(&float_counts);

            assert_eq!(bulge_discard.shanten, 0);
            assert_eq!(float_discard.shanten, 0);
            assert_eq!(bulge_discard.tiles.len(), 1);
            assert_eq!(bulge_discard.tiles[0].tile, skeleton.float_tile);
            assert_eq!(float_discard.tiles.len(), 1);
            assert_eq!(float_discard.tiles[0].tile, skeleton.bulge_tile);
            assert_ne!(
                bulge_discard.tiles[0].tile, skeleton.bulge_tile,
                "the book's discard must not leave the bulge tile as its own wait"
            );
            assert!(
                bulge_discard.total_count > float_discard.total_count,
                "{} vs {}",
                bulge_discard.total_count,
                float_discard.total_count
            );
            assert_eq!(bulge_discard.total_count, 3);
            assert_eq!(float_discard.total_count, 2);
        }
    }
}
