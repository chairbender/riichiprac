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

use agari::hand::{HandStructure, Meld, decompose_hand};
use agari::parse::to_counts;
use agari::shanten::{calculate_shanten, calculate_ukeire};
use agari::tile::Tile;

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
}
