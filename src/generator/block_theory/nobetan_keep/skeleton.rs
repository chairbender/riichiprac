use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use agari::parse::{to_counts, validate_hand};
use agari::shanten::{calculate_shanten, calculate_ukeire};
use agari::tile::{Suit, Tile};

use crate::generator::support::completion::{side_wait_routes, two_step_lines};
use crate::generator::support::deck::Deck;
use crate::rng::{gen_range, shuffle};

/// The constructed parts of a "keep the stretched single" puzzle.
///
/// Riichi Book 1, ch. 3, "Four-tile complex shapes 1: nobetan":
///
/// - "the middle two ones --- 3456 and 4567 --- are the most versatile"
///   (ch3:649), and "Try to keep a stretched single shape if a hand has one. In
///   particular, 3456 and 4567 should be kept until the hand becomes ready or
///   1-away from ready." (ch3:669)
/// - The book's own 2-away example: "It is true that discarding wan3 or wan6
///   would lead to the greatest tile acceptance (7 kinds--24 tiles)
///   temporarily. However, doing so is too myopic. If we do that, all the
///   remaining protoruns will be closed-wait or edge-wait ones. We should
///   rather discard suo9 to keep the 3456 shape, which we can expect to produce
///   two side-wait protoruns later. The resulting tile acceptance (6 kinds--20
///   tiles) is not much smaller, either." (ch3:662)
///
/// Anki 1463193147898 (definition), 1463193166572 (keep it), 1463193567734
/// (why it is good while the hand is not ready), 1463193918897 (why it is good
/// in a ready hand), 1463193992139 (which stretched singles are best).
///
/// The skeleton is that hand generalised: the nobetan in its own suit, a head
/// pair and a closed-wait protorun in a second suit, and an edge-wait protorun,
/// a pair, a float beside the pair, and the drawn float in a third suit. The
/// float beside the pair is what makes the book's discard strictly the best
/// shape-preserving discard, and the drawn float is the answer.
pub(super) struct NobetanKeepSkeleton {
    /// All 14 tiles for evaluation.
    pub full_tiles: Vec<Tile>,
    /// The four tiles of the stretched single (`x..x+3`).
    pub nobetan: [Tile; 4],
    /// The two ends of the nobetan; either breaks the shape.
    pub nobetan_ends: [Tile; 2],
    /// The drawn float: the book's discard, which keeps the shape.
    pub answer_tile: Tile,
    /// The float beside the second pair (the book's 7s).
    pub retained_float: Tile,
}

impl NobetanKeepSkeleton {
    /// The suit the stretched single sits in.
    #[cfg(test)]
    pub(super) fn nobetan_suit(&self) -> Suit {
        match self.nobetan[0] {
            Tile::Suited { suit, .. } => suit,
            _ => unreachable!("a stretched single is always suited"),
        }
    }

    /// True when the book's discard leaves all four stretched-single tiles.
    #[cfg(test)]
    pub(super) fn keeps_the_nobetan(&self) -> bool {
        let keep = without(&self.full_tiles, self.answer_tile);
        keep.is_ok_and(|tiles| nobetan_starts(&tiles) == nobetan_starts(&self.full_tiles))
    }

    /// True when breaking an end removes the stretched single.
    #[cfg(test)]
    pub(super) fn breaks_the_nobetan(&self, end: Tile) -> bool {
        let broken = without(&self.full_tiles, end);
        broken.is_ok_and(|tiles| {
            !nobetan_starts(&tiles).contains(&nobetan_starts(&self.full_tiles)[0])
        })
    }
}

/// Builds the 2-away hand and proves the book's discard instruction on it.
pub(super) fn build_skeleton() -> Result<NobetanKeepSkeleton, String> {
    'attempt: for _ in 0..2_048 {
        let mut deck = Deck::fresh();

        // Each shape gets its own suit, as in the book: the nobetan in manzu,
        // the head and closed wait in pinzu, the edge wait and the floats in
        // souzu.
        let mut suits = [Suit::Man, Suit::Pin, Suit::Sou];
        shuffle(&mut suits);
        let [nobetan_suit, head_suit, float_suit] = suits;

        // The book's two most versatile shapes.
        let base = if gen_range(0, 2) == 0 { 3u8 } else { 4u8 };
        let nobetan = [
            suited(nobetan_suit, base),
            suited(nobetan_suit, base + 1),
            suited(nobetan_suit, base + 2),
            suited(nobetan_suit, base + 3),
        ];
        let nobetan_ends = [nobetan[0], nobetan[3]];

        // The head pair and a closed-wait protorun in the second suit (the
        // book's 11p and 35p). The two blocks sit two ranks apart (or its
        // mirror), so they never run together into a second stretched single;
        // these placements spread the pair across the suit.
        const HEAD_CLOSED: [(u8, u8); 5] = [(1, 3), (3, 5), (5, 7), (6, 2), (9, 5)];
        let (head_value, closed_base) = HEAD_CLOSED[gen_range(0, HEAD_CLOSED.len())];
        let head = [suited(head_suit, head_value); 2];
        let closed = [
            suited(head_suit, closed_base),
            suited(head_suit, closed_base + 2),
        ];

        // An edge-wait protorun in the third suit (the book's 12s) and a pair
        // far enough from it that the three blocks stay separate.
        let (edge_start, pair_value) = [(1u8, 5u8), (1, 6), (8, 2)][gen_range(0, 3)];
        let edge = [
            suited(float_suit, edge_start),
            suited(float_suit, edge_start + 1),
        ];

        // The pair's partner is the retained float, and the drawn float sits
        // two ranks further out with a gap between them (the book's 66s, 7s,
        // and 9s), so the drawn tile is a float and not a protorun.
        let pair = [suited(float_suit, pair_value); 2];
        let retained_float = suited(float_suit, pair_value + 1);
        let answer_tile = suited(float_suit, pair_value + 3);

        for tile in nobetan
            .iter()
            .chain(head.iter())
            .chain(closed.iter())
            .chain(edge.iter())
            .chain(pair.iter())
            .chain([&retained_float, &answer_tile])
        {
            if deck.take(*tile).is_err() {
                continue 'attempt;
            }
        }

        let full_tiles = vec![
            nobetan[0],
            nobetan[1],
            nobetan[2],
            nobetan[3],
            head[0],
            head[1],
            closed[0],
            closed[1],
            edge[0],
            edge[1],
            pair[0],
            pair[1],
            retained_float,
            answer_tile,
        ];
        if validate_hand(&full_tiles).is_err() {
            continue 'attempt;
        }

        let skeleton = NobetanKeepSkeleton {
            full_tiles: full_tiles.clone(),
            nobetan,
            nobetan_ends,
            answer_tile,
            retained_float,
        };

        // Verify inside the loop so a hand the rule does not decide cleanly is
        // re-rolled like any other rejected candidate. The proof enumerates
        // two-step completions, which is expensive, so hands already proven in
        // this process are trusted: the result depends only on the tile
        // multiset, and the suits are a permutation of the same shape.
        if !is_proven(&full_tiles) {
            if verify_lesson(&skeleton).is_err() {
                continue 'attempt;
            }
            mark_proven(&full_tiles);
        }

        return Ok(skeleton);
    }

    Err("Failed to construct a valid nobetan keep hand".to_string())
}

/// Proves the book's instruction for one hand.
///
/// - The hand is 2-away and holds exactly one stretched single.
/// - The answer keeps the whole shape, leaves 2-away, and is the *best*
///   shape-preserving discard by raw acceptance.
/// - Breaking an end leaves 2-away, breaks the shape, and accepts strictly more
///   tiles: it is the max-acceptance discard, so counting tiles alone gives the
///   wrong answer.
/// - The kept shape can still reach a side wait, and it reaches strictly more
///   side-wait completions than the broken hand does (see [`two_step_lines`]).
pub(super) fn verify_lesson(skeleton: &NobetanKeepSkeleton) -> Result<(), String> {
    let full_shanten = calculate_shanten(&to_counts(&skeleton.full_tiles)).shanten;
    if full_shanten != 2 {
        return Err(format!(
            "a nobetan keep hand must be 2-away, got {full_shanten}"
        ));
    }
    let starts = nobetan_starts(&skeleton.full_tiles);
    if starts.len() != 1 {
        return Err(format!(
            "the hand must hold exactly one stretched single, got {}",
            starts.len()
        ));
    }

    let answer_hand = without(&skeleton.full_tiles, skeleton.answer_tile)?;
    if calculate_shanten(&to_counts(&answer_hand)).shanten != 2 {
        return Err("the book's discard must leave the hand 2-away".to_string());
    }
    if nobetan_starts(&answer_hand) != starts {
        return Err("the book's discard must keep the stretched single".to_string());
    }
    let answer_acceptance = calculate_ukeire(&to_counts(&answer_hand)).total_count;

    // Every other discard that keeps the shape must be worse, so the drill has
    // no second, equally defensible keep answer.
    for tile in distinct(&skeleton.full_tiles) {
        if tile == skeleton.answer_tile {
            continue;
        }
        let Ok(remaining) = without(&skeleton.full_tiles, tile) else {
            continue;
        };
        if calculate_shanten(&to_counts(&remaining)).shanten != 2 {
            continue;
        }
        if nobetan_starts(&remaining) != starts {
            continue;
        }
        let acceptance = calculate_ukeire(&to_counts(&remaining)).total_count;
        if acceptance >= answer_acceptance {
            return Err(format!(
                "another shape-preserving discard ({tile}) accepts {acceptance} tiles"
            ));
        }
    }

    // Breaking either end must be the max-acceptance line.
    let mut rival_acceptance = 0;
    for end in skeleton.nobetan_ends {
        let broken = without(&skeleton.full_tiles, end)?;
        if calculate_shanten(&to_counts(&broken)).shanten != 2 {
            return Err("breaking an end must leave the hand 2-away".to_string());
        }
        if nobetan_starts(&broken) == starts {
            return Err("discarding an end must break the stretched single".to_string());
        }
        let acceptance = calculate_ukeire(&to_counts(&broken)).total_count;
        if acceptance <= answer_acceptance {
            return Err(format!(
                "breaking the shape ({end}) accepts {acceptance}, the answer accepts {answer_acceptance}"
            ));
        }
        rival_acceptance = rival_acceptance.max(acceptance);
    }
    for tile in distinct(&skeleton.full_tiles) {
        let Ok(remaining) = without(&skeleton.full_tiles, tile) else {
            continue;
        };
        if calculate_shanten(&to_counts(&remaining)).shanten != 2 {
            continue;
        }
        let acceptance = calculate_ukeire(&to_counts(&remaining)).total_count;
        if acceptance > rival_acceptance {
            return Err(format!(
                "{tile} accepts {acceptance} tiles, more than breaking the shape"
            ));
        }
    }

    // The wait-quality comparison the rationale shows: keeping the shape can
    // still land on a side wait, and it has strictly more side-wait completions
    // than the broken hand. The routes are enumerated once per hand.
    let answer_lines = two_step_lines(&answer_hand);
    if !answer_lines.iter().any(|line| line.has_side_wait()) {
        return Err("the answer must keep a side wait reachable".to_string());
    }
    let answer_routes = answer_lines
        .iter()
        .flat_map(|line| line.lines.iter())
        .filter(|line| line.has_side_wait())
        .count();
    // Both ends are checked: the two broken hands are mirror images, but the
    // rule must hold for whichever end the player is tempted by.
    for end in skeleton.nobetan_ends {
        let broken_hand = without(&skeleton.full_tiles, end)?;
        let broken_routes = side_wait_routes(&broken_hand);
        if answer_routes <= broken_routes {
            return Err(format!(
                "keeping the shape must have more side-wait completions ({answer_routes} vs {broken_routes})"
            ));
        }
    }

    Ok(())
}

/// Hands whose full proof already ran in this process, keyed by tile multiset.
fn proven_hands() -> &'static Mutex<HashSet<Vec<Vec<u8>>>> {
    static PROVEN: OnceLock<Mutex<HashSet<Vec<Vec<u8>>>>> = OnceLock::new();
    PROVEN.get_or_init(|| Mutex::new(HashSet::new()))
}

/// A suit-agnostic multiset key: sorted ranks per suit, with the suits sorted
/// too, so permuting the three suits maps to the same key.
fn proof_key(tiles: &[Tile]) -> Vec<Vec<u8>> {
    let mut suits: Vec<Vec<u8>> = vec![Vec::new(); 3];
    let mut honors: Vec<u8> = Vec::new();
    for tile in tiles {
        match tile {
            Tile::Suited { suit, value } => {
                let index = match suit {
                    Suit::Man => 0,
                    Suit::Pin => 1,
                    Suit::Sou => 2,
                };
                suits[index].push(*value);
            }
            Tile::Honor(honor) => honors.push(*honor as u8),
        }
    }
    for suit in &mut suits {
        suit.sort();
    }
    suits.sort();
    suits.push(honors);
    suits
}

fn is_proven(tiles: &[Tile]) -> bool {
    proven_hands()
        .lock()
        .is_ok_and(|proven| proven.contains(&proof_key(tiles)))
}

fn mark_proven(tiles: &[Tile]) {
    if let Ok(mut proven) = proven_hands().lock() {
        proven.insert(proof_key(tiles));
    }
}

fn suited(suit: Suit, value: u8) -> Tile {
    Tile::Suited { suit, value }
}

/// Removes one copy of `discard` from `tiles`.
pub(super) fn without(tiles: &[Tile], discard: Tile) -> Result<Vec<Tile>, String> {
    let mut remaining = tiles.to_vec();
    let index = remaining
        .iter()
        .position(|tile| *tile == discard)
        .ok_or_else(|| format!("{discard} is not in the hand"))?;
    remaining.remove(index);
    Ok(remaining)
}

fn distinct(tiles: &[Tile]) -> Vec<Tile> {
    let mut distinct = tiles.to_vec();
    distinct.sort();
    distinct.dedup();
    distinct
}

/// Every stretched single (`x..x+3`) in a hand, in tile order.
pub(crate) fn nobetan_starts(tiles: &[Tile]) -> Vec<(Suit, u8)> {
    let mut found = Vec::new();
    for suit in [Suit::Man, Suit::Pin, Suit::Sou] {
        let mut counts = [0u8; 10];
        for tile in tiles {
            if let Tile::Suited {
                suit: tile_suit,
                value,
            } = tile
                && *tile_suit == suit
            {
                counts[*value as usize] += 1;
            }
        }
        for base in 1..=6u8 {
            if (base..base + 4).all(|value| counts[value as usize] >= 1) {
                found.push((suit, base));
            }
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn skeleton_generalizes_across_suits_and_shapes() {
        let mut nobetan_suits = HashSet::new();
        let mut bases = HashSet::new();
        let mut answers = HashSet::new();

        for _ in 0..80 {
            let skeleton = build_skeleton().expect("nobetan keep skeleton must build");

            assert_eq!(skeleton.full_tiles.len(), 14);
            assert!(validate_hand(&skeleton.full_tiles).is_ok());
            assert!(skeleton.keeps_the_nobetan());

            let [x, x1, x2, x3] = skeleton.nobetan;
            let (
                Tile::Suited { suit, value },
                Tile::Suited {
                    suit: suit1,
                    value: value1,
                },
                Tile::Suited {
                    suit: suit2,
                    value: value2,
                },
                Tile::Suited {
                    suit: suit3,
                    value: value3,
                },
            ) = (x, x1, x2, x3)
            else {
                panic!("the stretched single must be suited");
            };
            assert_eq!(suit, suit1);
            assert_eq!(suit, suit2);
            assert_eq!(suit, suit3);
            assert_eq!(value1, value + 1);
            assert_eq!(value2, value + 2);
            assert_eq!(value3, value + 3);
            assert!((3..=4).contains(&value));
            nobetan_suits.insert(suit);
            bases.insert(value);

            // The ends are the two tiles that break the shape.
            assert_eq!(skeleton.nobetan_ends, [x, x3]);
            assert!(skeleton.breaks_the_nobetan(x));
            assert!(skeleton.breaks_the_nobetan(x3));

            // The answer and the retained float sit two ranks from the pair, in
            // the third suit.
            assert_ne!(skeleton.answer_tile, skeleton.retained_float);
            assert_ne!(skeleton.nobetan_suit(), suit_of(skeleton.answer_tile));
            answers.insert(skeleton.answer_tile);
        }

        assert!(
            nobetan_suits.len() > 1,
            "the generator must cover several suits"
        );
        assert!(bases.len() > 1, "the generator must cover 3456 and 4567");
        assert!(answers.len() > 3, "the generator must vary the drawn float");
    }

    #[test]
    fn every_skeleton_proves_the_book_instruction() {
        for _ in 0..12 {
            let skeleton = build_skeleton().expect("nobetan keep skeleton must build");
            verify_lesson(&skeleton).expect("every skeleton must prove the discard");

            let answer_hand = without(&skeleton.full_tiles, skeleton.answer_tile).unwrap();
            let answer_acceptance = calculate_ukeire(&to_counts(&answer_hand)).total_count;
            let answer_routes = side_wait_routes(&answer_hand);
            assert!(answer_routes > 0, "the kept shape must reach a side wait");

            for end in skeleton.nobetan_ends {
                let broken = without(&skeleton.full_tiles, end).unwrap();
                assert!(
                    calculate_ukeire(&to_counts(&broken)).total_count > answer_acceptance,
                    "breaking the shape must accept more tiles"
                );
                assert!(
                    side_wait_routes(&broken) < answer_routes,
                    "keeping the shape must offer more side-wait completions"
                );
            }
        }
    }

    fn suit_of(tile: Tile) -> Suit {
        match tile {
            Tile::Suited { suit, .. } => suit,
            _ => unreachable!("the floats are suited"),
        }
    }
}
