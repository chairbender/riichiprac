//! Mechanical completion enumeration for 1-away and 2-away hands.
//!
//! A hand's raw `ukeire` only says which tiles take it one step closer to
//! tenpai; it says nothing about the *wait* that tenpai will have. Lessons that
//! grade wait quality instead of raw acceptance need to walk further:
//!
//! 1. for every tile the hand accepts, draw it;
//! 2. for every discard that still leaves the hand one step closer, repeat;
//! 3. at 1-away, for every discard that still leaves tenpai, list the winning
//!    tiles;
//! 4. classify each winning tile from the winning decomposition -- inside a run
//!    it is a side (ryanmen), closed (kanchan), or edge (penchan) wait, on the
//!    pair it is a single (tanki) wait, and on a triplet it is a double-pair
//!    (shanpon) wait.
//!
//! That is the oracle Riichi Book 1 asks for when it ranks a hand by the wait it
//! can still reach: ch3:506 ("it will ultimately become a single closed-wait
//! protorun when this block remains incomplete when the hand is ready") and
//! ch3:523 ("we should keep it and break the double closed shape instead").
//! `ryankan_break` uses the 1-away walk; `nobetan_keep` uses the 2-away walk to
//! compare the waits the kept shape can still reach with the waits the broken
//! hand can: the book's claim is that breaking a stretched single fills the
//! hand with "closed-wait or edge-wait" protoruns (ch3:662), so the kept shape
//! must leave strictly more side-wait completions.

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
    /// How many copies of those winning tiles are still live.
    pub wait_count: u8,
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
                wait_count: winning.total_count,
                shapes,
            });
        }
    }

    lines
}

/// One way a 2-away hand can reach tenpai.
///
/// The first draw takes the hand to 1-away and the first discard keeps it
/// there; [`CompletionLine`]s then record every tenpai the remaining 1-away
/// hand can still reach. Grouping by the first draw is what lets a lesson ask
/// "can this hand reach a side wait *whatever* it draws?" instead of only
/// "can it reach one somehow?".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TwoStepLine {
    /// The accepted tile that took the hand from 2-away to 1-away.
    pub draw: Tile,
    /// The discard that left the hand 1-away.
    pub discard: Tile,
    /// Every tenpai the remaining 1-away hand can still reach.
    pub lines: Vec<CompletionLine>,
}

impl TwoStepLine {
    /// True when this first step can still end on a side wait.
    pub fn has_side_wait(&self) -> bool {
        self.lines.iter().any(CompletionLine::has_side_wait)
    }
}

/// Enumerates every completion of a 2-away hand.
///
/// For each accepted draw, every discard that leaves 1-away is walked with
/// [`completion_lines`], so the result names the tenpai waits that follow each
/// first step. Lines are returned in acceptance order.
pub fn two_step_lines(tiles: &[Tile]) -> Vec<TwoStepLine> {
    let counts = to_counts(tiles);
    if calculate_shanten(&counts).shanten != 2 {
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

            let mut one_away = drawn.clone();
            let index = one_away
                .iter()
                .position(|tile| *tile == discard)
                .expect("discard came from the drawn hand");
            one_away.remove(index);

            if calculate_shanten(&to_counts(&one_away)).shanten != 1 {
                continue;
            }

            lines.push(TwoStepLine {
                draw: accepted.tile,
                discard,
                lines: completion_lines(&one_away),
            });
        }
    }

    lines
}

/// True when completing the hand can still reach a side wait.
///
/// A 1-away hand is walked one step (draw, discard, tenpai) and a 2-away hand
/// two steps (draw, discard, draw, discard, tenpai). Tenpai and complete hands
/// have no route to walk and report `false`.
pub fn can_reach_side_wait(tiles: &[Tile]) -> bool {
    match calculate_shanten(&to_counts(tiles)).shanten {
        1 => completion_lines(tiles)
            .iter()
            .any(CompletionLine::has_side_wait),
        2 => two_step_lines(tiles).iter().any(TwoStepLine::has_side_wait),
        _ => false,
    }
}

/// The completion with the most live winning tiles, if the hand can reach one.
///
/// Ties are broken toward a side wait, because that is the outcome a player
/// would pick between two equally live waits. This is the line a lesson shows
/// when it argues about *wait quality*: "your best tenpai" rather than "some
/// tenpai".
pub fn best_completion(tiles: &[Tile]) -> Option<CompletionLine> {
    let lines: Vec<CompletionLine> = match calculate_shanten(&to_counts(tiles)).shanten {
        1 => completion_lines(tiles),
        2 => two_step_lines(tiles)
            .into_iter()
            .flat_map(|line| line.lines)
            .collect(),
        _ => return None,
    };

    lines.into_iter().max_by_key(|line| {
        (
            line.wait_count,
            u8::from(line.has_side_wait()),
            line.waits.len(),
        )
    })
}

/// How many tenpai routes out of a hand can end on a side wait.
///
/// The route count is the wait-quality comparison a lesson can print: keeping
/// a stretched single leaves more ways to reach a side wait than breaking it
/// does, even when the broken hand accepts more tiles right now.
pub fn side_wait_routes(tiles: &[Tile]) -> usize {
    let lines: Vec<CompletionLine> = match calculate_shanten(&to_counts(tiles)).shanten {
        1 => completion_lines(tiles),
        2 => two_step_lines(tiles)
            .into_iter()
            .flat_map(|line| line.lines)
            .collect(),
        _ => return 0,
    };

    lines.iter().filter(|line| line.has_side_wait()).count()
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
    fn a_2_away_hand_lists_two_step_lines() {
        // The book's nobetan hand: discarding 9s keeps 3456m, and the two-step
        // walk reaches a side wait.
        let hand = tiles("3456m11p35p12s667s");
        let lines = two_step_lines(&hand);
        assert!(!lines.is_empty());
        assert!(lines.iter().any(TwoStepLine::has_side_wait));
        assert!(can_reach_side_wait(&hand));

        // Breaking the shape leaves only the pair-beside-a-float route, and it
        // is strictly worse than keeping the shape.
        let broken = tiles("456m11p35p12s667s9s");
        assert!(side_wait_routes(&hand) > side_wait_routes(&broken));
    }

    #[test]
    fn the_best_completion_is_the_most_live_wait() {
        let hand = tiles("3456m11p35p12s667s");
        let best = best_completion(&hand).expect("the hand must reach tenpai");
        assert!(best.has_side_wait());
        assert!(best.wait_count > 0);

        // Every line's wait count is at most the best one.
        for line in two_step_lines(&hand) {
            for inner in line.lines {
                assert!(inner.wait_count <= best.wait_count);
            }
        }
    }

    #[test]
    fn tenpai_hands_have_no_two_step_lines() {
        let hand = tiles("123m456p77s111z22z");
        assert!(two_step_lines(&hand).is_empty());
        assert_eq!(side_wait_routes(&hand), 0);
        assert!(best_completion(&hand).is_none());
    }
}
