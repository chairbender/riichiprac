//! Mechanical completion enumeration for 1-away hands.
//!
//! A 1-away hand's raw `ukeire` only says which tiles take it to tenpai; it
//! says nothing about the *wait* that tenpai will have. Lessons that grade wait
//! quality instead of raw acceptance need to walk one step further:
//!
//! 1. for every tile the 1-away hand accepts, draw it;
//! 2. for every discard that still leaves tenpai, list the winning tiles;
//! 3. classify each winning tile from the winning decomposition -- inside a
//!    run it is a side (ryanmen), closed (kanchan), or edge (penchan) wait, on
//!    the pair it is a single (tanki) wait, and on a triplet it is a double-pair
//!    (shanpon) wait.
//!
//! That is the oracle Riichi Book 1 asks for when it ranks a hand by the wait it
//! can still reach: ch3:506 ("it will ultimately become a single closed-wait
//! protorun when this block remains incomplete when the hand is ready") and
//! ch3:523 ("we should keep it and break the double closed shape instead").
//! `nobetan_keep` and `perfect_one_away` need the same walk.
//!
//! [`every_draw_reaches_side_wait`] turns that walk into the book's test for a
//! 1-away hand's wait: the hand passes only when *every* tile it accepts leaves
//! at least one discard that reaches tenpai on a side wait.

use agari::hand::{HandStructure, Meld, decompose_hand};
use agari::parse::to_counts;
use agari::shanten::{calculate_shanten, calculate_ukeire};
use agari::tile::{Suit, Tile};

/// The shape of a winning wait, in the book's vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum WaitShape {
    /// Side wait (ryanmen): a consecutive protorun waiting on either end.
    Ryanmen,
    /// Closed wait (kanchan): a gapped protorun waiting on the middle.
    Kanchan,
    /// Edge wait (penchan): 12 waiting on 3, or 89 waiting on 7.
    Penchan,
    /// Single wait (tanki): the pair is completed by the winning tile.
    Tanki,
    /// Double-pair wait (shanpon): a pair is completed into a triplet.
    Shanpon,
}

impl WaitShape {
    /// True for the side wait, the only shape the ryankan lesson protects.
    pub fn is_side(self) -> bool {
        self == WaitShape::Ryanmen
    }
}

/// One way a 1-away hand can reach tenpai.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompletionLine {
    /// The accepted tile that took the hand from 1-away to tenpai.
    pub draw: Tile,
    /// The discard that left the hand tenpai.
    pub discard: Tile,
    /// Every tile that would win the resulting tenpai hand.
    pub waits: Vec<Tile>,
    /// The wait shapes those winning tiles can represent.
    pub shapes: Vec<WaitShape>,
}

impl CompletionLine {
    /// True when this line can end on a side wait.
    pub fn has_side_wait(&self) -> bool {
        self.shapes.iter().any(|shape| shape.is_side())
    }
}

/// Enumerates every completion of a 1-away hand.
///
/// `tiles` is the whole 13-tile hand, including any open meld (the block-theory
/// lessons evaluate the meld as part of the counts). Lines are returned in
/// acceptance order, so callers can stop at the first side wait.
pub fn completion_lines(tiles: &[Tile]) -> Vec<CompletionLine> {
    let counts = to_counts(tiles);
    if calculate_shanten(&counts).shanten != 1 {
        return Vec::new();
    }

    let mut lines = Vec::new();
    for accepted in calculate_ukeire(&counts).tiles {
        let mut drawn = tiles.to_vec();
        drawn.push(accepted.tile);

        let mut seen = Vec::new();
        for discard in drawn.clone() {
            if seen.contains(&discard) {
                continue;
            }
            seen.push(discard);

            let mut tenpai = drawn.clone();
            let index = tenpai
                .iter()
                .position(|tile| *tile == discard)
                .expect("discard came from the drawn hand");
            tenpai.remove(index);

            if calculate_shanten(&to_counts(&tenpai)).shanten != 0 {
                continue;
            }

            let winning = calculate_ukeire(&to_counts(&tenpai));
            if winning.tiles.is_empty() {
                continue;
            }

            let waits: Vec<Tile> = winning.tiles.iter().map(|tile| tile.tile).collect();
            let mut shapes = Vec::new();
            for wait in &waits {
                shapes.extend(wait_shapes(&tenpai, *wait));
            }
            shapes.sort();
            shapes.dedup();

            lines.push(CompletionLine {
                draw: accepted.tile,
                discard,
                waits,
                shapes,
            });
        }
    }

    lines
}

/// True when completing the hand once can still reach a side wait.
pub fn can_reach_side_wait(tiles: &[Tile]) -> bool {
    completion_lines(tiles)
        .iter()
        .any(CompletionLine::has_side_wait)
}

/// True when every way the hand can become ready can still choose a side wait.
///
/// This is Riichi Book 1's test for a 1-away hand's wait. ch3:389 says of the
/// perfect shape that "no matter how a hand becomes ready, you will
/// \emph{always} have the option to choose side wait as the final wait", and
/// ch8:68 repeats it as the rule for judging a 1-away hand: "your judgement
/// should be based on the \emph{best} possible wait pattern you can choose when
/// the hand becomes ready in the \emph{worst} possible manner". A hand passes
/// only when *every* acceptance tile has at least one discard that leaves
/// tenpai on a side wait (see [`completion_lines`]).
pub fn every_draw_reaches_side_wait(tiles: &[Tile]) -> bool {
    let lines = completion_lines(tiles);
    if lines.is_empty() {
        return false;
    }

    let mut draws: Vec<Tile> = lines.iter().map(|line| line.draw).collect();
    draws.sort();
    draws.dedup();

    draws.iter().all(|draw| {
        lines
            .iter()
            .filter(|line| line.draw == *draw)
            .any(|line| line.has_side_wait())
    })
}

/// The block partition Riichi Book 1 calls perfect 1-away.
///
/// > When a 1-away hand has two side-wait protoruns and two pairs, it is called
/// > {\bf perfect 1-away}. — ch3:382
///
/// A 13-tile hand cannot hold two sets, two side-wait protoruns and two pairs
/// side by side (that is 14 tiles), so exactly one tile is shared: one side wait
/// is also the pair. That shared three-tile block is the "protorun plus one"
/// shape (`233` or `334`), and the partition is:
///
/// - two completed sets (runs or triplets),
/// - one standalone side-wait protorun,
/// - one standalone pair,
/// - one protorun plus one, whose protorun is a side wait and whose duplicated
///   tile is the second pair.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PerfectShape {
    /// The two completed sets, as the tiles each one uses.
    pub sets: Vec<[Tile; 3]>,
    /// The standalone side-wait protorun.
    pub ryanmen: [Tile; 2],
    /// The standalone pair.
    pub pair: [Tile; 2],
    /// The protorun plus one: a side-wait protorun sharing its end with a pair.
    pub shared: [Tile; 3],
}

impl PerfectShape {
    /// The two side-wait protoruns the book counts, as tile pairs.
    pub fn protoruns(&self) -> [[Tile; 2]; 2] {
        [self.ryanmen, shared_ryanmen(self.shared)]
    }
}

/// The side-wait protorun inside a protorun-plus-one block.
fn shared_ryanmen(shared: [Tile; 3]) -> [Tile; 2] {
    // 233 -> 23, 334 -> 34: drop one copy of the duplicated end.
    let [first, second, third] = shared;
    if first == second {
        [second, third]
    } else {
        [first, second]
    }
}

/// Finds the book's perfect 1-away partition of a 13-tile hand, if it has one.
///
/// Structural only: it says the hand can be read as the book's two side-wait
/// protoruns plus two pairs plus completed sets. A hand can pass this and still
/// fail [`every_draw_reaches_side_wait`] when its blocks interfere in one suit,
/// so lessons check both.
pub fn perfect_one_away_shape(tiles: &[Tile]) -> Option<PerfectShape> {
    if tiles.len() != 13 {
        return None;
    }

    let mut sorted = tiles.to_vec();
    sorted.sort();

    for first in set_candidates(&sorted) {
        let Some(without_first) = without_tiles(&sorted, &first) else {
            continue;
        };
        for second in set_candidates(&without_first) {
            let Some(rest) = without_tiles(&without_first, &second) else {
                continue;
            };
            if rest.len() != 7 {
                continue;
            }
            let Some((shared, ryanmen, pair)) = split_shared_ryanmen_pair(&rest) else {
                continue;
            };
            return Some(PerfectShape {
                sets: vec![first, second],
                ryanmen,
                pair,
                shared,
            });
        }
    }

    None
}

/// True when the hand is the book's perfect 1-away: the structure *and* the
/// every-completion side wait.
pub fn is_perfect_one_away(tiles: &[Tile]) -> bool {
    perfect_one_away_shape(tiles).is_some() && every_draw_reaches_side_wait(tiles)
}

/// Every completed set (run or triplet) that `tiles` can supply.
fn set_candidates(tiles: &[Tile]) -> Vec<[Tile; 3]> {
    let mut sets = Vec::new();

    for suit in [Suit::Man, Suit::Pin, Suit::Sou] {
        for start in 1..=7u8 {
            let run = [
                Tile::suited(suit, start),
                Tile::suited(suit, start + 1),
                Tile::suited(suit, start + 2),
            ];
            if without_tiles(tiles, &run).is_some() {
                sets.push(run);
            }
        }
    }

    let mut distinct = tiles.to_vec();
    distinct.sort();
    distinct.dedup();
    for tile in distinct {
        if tiles.iter().filter(|candidate| **candidate == tile).count() >= 3 {
            sets.push([tile, tile, tile]);
        }
    }

    sets
}

/// Splits seven tiles into a protorun plus one, a side-wait protorun and a pair.
fn split_shared_ryanmen_pair(rest: &[Tile]) -> Option<([Tile; 3], [Tile; 2], [Tile; 2])> {
    for shared in shared_candidates(rest) {
        let Some(left) = without_tiles(rest, &shared) else {
            continue;
        };
        if left.len() != 4 {
            continue;
        }
        for ryanmen in ryanmen_candidates(&left) {
            let Some(pair) = without_tiles(&left, &ryanmen) else {
                continue;
            };
            if pair.len() == 2 && pair[0] == pair[1] {
                return Some((shared, ryanmen, [pair[0], pair[1]]));
            }
        }
    }

    None
}

/// Every protorun-plus-one block (`233`, `334`, ...) seven tiles can supply.
///
/// The pair is an end of the side wait, so the wait stays two-sided only for
/// ranks 2-7: `122` and `889` would be edge waits, not side waits.
fn shared_candidates(tiles: &[Tile]) -> Vec<[Tile; 3]> {
    let mut blocks = Vec::new();
    for suit in [Suit::Man, Suit::Pin, Suit::Sou] {
        for value in 2..=7u8 {
            let low_pair = [
                Tile::suited(suit, value),
                Tile::suited(suit, value),
                Tile::suited(suit, value + 1),
            ];
            let high_pair = [
                Tile::suited(suit, value),
                Tile::suited(suit, value + 1),
                Tile::suited(suit, value + 1),
            ];
            for block in [low_pair, high_pair] {
                if without_tiles(tiles, &block).is_some() {
                    blocks.push(block);
                }
            }
        }
    }
    blocks
}

/// Every two-sided protorun (ranks 2-7) the tiles can supply.
fn ryanmen_candidates(tiles: &[Tile]) -> Vec<[Tile; 2]> {
    let mut waits = Vec::new();
    for suit in [Suit::Man, Suit::Pin, Suit::Sou] {
        for value in 2..=7u8 {
            let wait = [Tile::suited(suit, value), Tile::suited(suit, value + 1)];
            if without_tiles(tiles, &wait).is_some() {
                waits.push(wait);
            }
        }
    }
    waits
}

/// Removes one copy of each tile in `remove`, or `None` if one is missing.
fn without_tiles(tiles: &[Tile], remove: &[Tile]) -> Option<Vec<Tile>> {
    let mut remaining = tiles.to_vec();
    for tile in remove {
        let index = remaining.iter().position(|candidate| candidate == tile)?;
        remaining.remove(index);
    }
    Some(remaining)
}

/// Classifies one winning tile against the tenpai hand it completes.
///
/// A tile can be read more than once (the winning tile may be the pair in one
/// decomposition and the low end of a run in another); every reading is
/// returned so callers can ask whether *any* reading is a side wait.
pub fn wait_shapes(tenpai: &[Tile], wait: Tile) -> Vec<WaitShape> {
    let mut winning = tenpai.to_vec();
    winning.push(wait);

    let mut shapes = Vec::new();
    for structure in decompose_hand(&to_counts(&winning)) {
        let HandStructure::Standard { melds, pair } = structure else {
            // Chiitoitsu and kokushi waits are single-tile waits.
            shapes.push(WaitShape::Tanki);
            continue;
        };

        if pair == wait {
            shapes.push(WaitShape::Tanki);
        }

        for meld in melds {
            match meld {
                Meld::Shuntsu(start, _) => {
                    let Tile::Suited { suit, value } = start else {
                        continue;
                    };
                    let run = [
                        Tile::Suited { suit, value },
                        Tile::Suited {
                            suit,
                            value: value + 1,
                        },
                        Tile::Suited {
                            suit,
                            value: value + 2,
                        },
                    ];
                    let Some(position) = run.iter().position(|tile| *tile == wait) else {
                        continue;
                    };
                    shapes.push(match position {
                        0 => {
                            if value <= 6 {
                                WaitShape::Ryanmen
                            } else {
                                WaitShape::Penchan
                            }
                        }
                        1 => WaitShape::Kanchan,
                        2 => {
                            if value >= 2 {
                                WaitShape::Ryanmen
                            } else {
                                WaitShape::Penchan
                            }
                        }
                        _ => unreachable!("a run has three tiles"),
                    });
                }
                Meld::Koutsu(tile, _) if tile == wait => shapes.push(WaitShape::Shanpon),
                _ => {}
            }
        }
    }

    shapes.sort();
    shapes.dedup();
    shapes
}

#[cfg(test)]
mod tests {
    use super::*;
    use agari::parse::parse_hand;

    fn tiles(hand: &str) -> Vec<Tile> {
        parse_hand(hand).expect("test hand must parse")
    }

    #[test]
    fn a_ryanmen_wait_is_classified_as_a_side_wait() {
        // Tenpai on 45s, waiting 3s/6s.
        let tenpai = tiles("123m456p45s77s111z");
        let waits = wait_shapes(&tenpai, tiles("3s")[0]);
        assert!(waits.contains(&WaitShape::Ryanmen));

        let waits = wait_shapes(&tenpai, tiles("6s")[0]);
        assert!(waits.contains(&WaitShape::Ryanmen));
    }

    #[test]
    fn a_kanchan_wait_is_not_a_side_wait() {
        // Tenpai on 35s, waiting 4s.
        let tenpai = tiles("123m456p35s77s111z");
        let waits = wait_shapes(&tenpai, tiles("4s")[0]);
        assert_eq!(waits, vec![WaitShape::Kanchan]);
        assert!(!waits.iter().any(|shape| shape.is_side()));
    }

    #[test]
    fn an_edge_wait_is_not_a_side_wait() {
        // Tenpai on 12s, waiting 3s.
        let tenpai = tiles("123m456p12s77s111z");
        let waits = wait_shapes(&tenpai, tiles("3s")[0]);
        assert!(waits.contains(&WaitShape::Penchan));
        assert!(!waits.iter().any(|shape| shape.is_side()));
    }

    #[test]
    fn a_tanki_wait_is_not_a_side_wait() {
        let tenpai = tiles("123m456p789s111z2z");
        let waits = wait_shapes(&tenpai, tiles("2z")[0]);
        assert!(waits.contains(&WaitShape::Tanki));
        assert!(!waits.iter().any(|shape| shape.is_side()));
    }

    #[test]
    fn a_1_away_hand_lists_its_completions() {
        // 789m + 46p kanchan + the 788s block + 555z open pon: completing the
        // kanchan leaves a side wait on the 6s/7s remnant.
        let hand = tiles("789m46p46788s555z");
        let lines = completion_lines(&hand);
        assert!(!lines.is_empty());
        assert!(lines.iter().any(CompletionLine::has_side_wait));

        let draws: Vec<Tile> = lines.iter().map(|line| line.draw).collect();
        assert!(draws.contains(&tiles("5p")[0]));
    }

    #[test]
    fn a_hand_with_no_side_wait_reports_none() {
        // 123m + 35p kanchan + 246s ryankan + 77s head + 555z: every completion
        // ends on one of the two closed waits.
        let hand = tiles("123m35p246s77s555z");
        assert!(!can_reach_side_wait(&hand));
    }

    #[test]
    fn a_tenpai_hand_has_no_completion_lines() {
        let hand = tiles("123m456p77s111z22z");
        assert!(completion_lines(&hand).is_empty());
    }

    #[test]
    fn the_book_example_is_the_perfect_one_away_shape() {
        // Riichi Book 1's own example (ch3:382): 233m 123p 66p 67s 555z.
        let hand = tiles("233m123p66p67s555z");
        assert_eq!(hand.len(), 13);

        let shape = perfect_one_away_shape(&hand).expect("the book's example must decompose");
        assert_eq!(shape.sets.len(), 2);
        assert_eq!(
            shape.shared,
            [tiles("2m")[0], tiles("3m")[0], tiles("3m")[0]]
        );
        assert!(shape.pair[0] == shape.pair[1]);
        assert!(every_draw_reaches_side_wait(&hand));
        assert!(is_perfect_one_away(&hand));
    }

    #[test]
    fn a_hand_with_one_pair_is_not_the_book_shape() {
        // Two side waits and one pair plus a float: good wait, but not the
        // book's two-pair definition.
        let hand = tiles("23555m456p3499s2z");
        assert!(every_draw_reaches_side_wait(&hand));
        assert!(perfect_one_away_shape(&hand).is_none());
        assert!(!is_perfect_one_away(&hand));
    }

    #[test]
    fn a_kanchan_instead_of_a_side_wait_is_not_perfect() {
        // Same block count, but the second protorun is a closed wait.
        let hand = tiles("233m123p66p57s555z");
        assert!(perfect_one_away_shape(&hand).is_none());
    }
}
