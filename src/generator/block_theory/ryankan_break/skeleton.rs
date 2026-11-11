use agari::parse::{to_counts, validate_hand};
use agari::shanten::{calculate_shanten, calculate_ukeire};
use agari::tile::{Honor, Suit, Tile};

use crate::generator::support::completion::can_reach_side_wait;
use crate::generator::support::deck::Deck;
use crate::rng::{choose, gen_bool, gen_range, shuffle};

/// The constructed parts of a "break the double closed shape" puzzle.
///
/// Riichi Book 1, ch. 3, "Double closed (ryankan) shape":
///
/// - "When two closed-wait protoruns are combined, we have a double closed
///   (ryankan) shape." (ch3:477)
/// - "Each shape accepts as many as 2 kinds--8 tiles." (ch3:483)
/// - "Double closed shapes are particularly useful when a hand is relatively far
///   from ready (2-away or worse)." (ch3:505) and "it will ultimately become a
///   single closed-wait protorun when this block remains incomplete when the
///   hand is ready." (ch3:506)
/// - The decisive instruction: "when we draw a tile next to the head, creating a
///   side-wait protorun, we should keep it and break the double closed shape
///   instead." (ch3:523)
///
/// Anki 1463192521881 (definition), 1463192693530 (2 kinds--8 tiles), and
/// 1463192695124 (why it gets worse as the hand gets ready).
///
/// The skeleton is the book's second example adapted to the open Yakuhai Pon the
/// block-theory lessons use: two completed sets, the head, one closed-wait
/// protorun, and a ryankan whose top tile is one rank below the draw. The draw
/// sits next to the head, so the hand holds `HH + D` and can treat it as a
/// side-wait protorun (`D,H`) or as the pair plus a float.
///
/// Breaking the *low* ryankan terminal leaves the top two ryankan tiles, and the
/// lower of those is adjacent to the drawn tile: together they are a side wait
/// the hand can still land on. Breaking the *high* terminal leaves the bottom two
/// tiles, which sit two ranks below the draw, and every completion is a closed
/// wait. That asymmetry is what makes the book's "break the ryankan" discard
/// uniquely correct rather than an arbitrary choice between its two ends.
pub(super) struct RyankanBreakSkeleton {
    /// All 14 tiles for evaluation, including the open Yakuhai meld.
    pub full_tiles: Vec<Tile>,
    /// The 11 concealed tiles before the discard.
    pub concealed_tiles: Vec<Tile>,
    /// The three-tile double closed shape (X, X+2, X+4).
    pub ryankan: [Tile; 3],
    /// The head the draw sits next to.
    pub head: [Tile; 2],
    /// The tile that was just drawn next to the head.
    pub draw: Tile,
    /// The side-wait protorun the draw creates with one head tile.
    pub new_ryanmen: [Tile; 2],
    /// The other closed-wait protorun, which must survive the discard.
    pub second_protorun: [Tile; 2],
    /// The tile that completes `second_protorun`.
    pub second_wait: Tile,
    /// The three tiles of the open Yakuhai meld.
    pub open_meld_tiles: Vec<Tile>,
    /// The low ryankan terminal: the discard that keeps the side wait.
    pub answer_tile: Tile,
}

/// Builds the 1-away hand and proves the book's discard instruction on it.
pub(super) fn build_skeleton() -> Result<RyankanBreakSkeleton, String> {
    'attempt: for _ in 0..512 {
        let mut deck = Deck::fresh();

        // The complex suit holds the head, the draw, and the ryankan; the other
        // two suits hold the closed-wait protorun and the concealed set, so no
        // block can recombine with another and change the shape.
        let mut suits = [Suit::Man, Suit::Pin, Suit::Sou];
        shuffle(&mut suits);
        let complex_suit = suits[0];
        let second_suit = suits[1];
        let set_suit = suits[2];

        // The book's second example is head 88p with a 7p draw, leaving the
        // ryankan's top tile one rank below the draw. 77 + 6 is the other
        // valid instance; 99 + 8 would make an edge wait, so it is excluded.
        let head_value = if gen_bool(0.5) { 7u8 } else { 8u8 };
        let draw_value = head_value - 1;
        let ryankan_base = head_value - 6;
        let ryankan = [
            suited(complex_suit, ryankan_base),
            suited(complex_suit, ryankan_base + 2),
            suited(complex_suit, ryankan_base + 4),
        ];
        let head = [suited(complex_suit, head_value); 2];
        let draw = suited(complex_suit, draw_value);
        for tile in ryankan
            .iter()
            .chain(head.iter())
            .chain(std::iter::once(&draw))
        {
            if deck.take(*tile).is_err() {
                continue 'attempt;
            }
        }

        // A closed-wait protorun in another suit: 13, 24, ... 79.
        let second_base = gen_range(1, 8) as u8;
        let second_protorun = [
            suited(second_suit, second_base),
            suited(second_suit, second_base + 2),
        ];
        let second_wait = suited(second_suit, second_base + 1);
        for tile in second_protorun {
            if deck.take(tile).is_err() {
                continue 'attempt;
            }
        }

        // The second completed set, in the third suit.
        let mut concealed_tiles = Vec::with_capacity(11);
        let added = if gen_bool(0.6) {
            try_add_run(&mut concealed_tiles, &mut deck, set_suit)
                || try_add_triplet(&mut concealed_tiles, &mut deck, set_suit)
        } else {
            try_add_triplet(&mut concealed_tiles, &mut deck, set_suit)
                || try_add_run(&mut concealed_tiles, &mut deck, set_suit)
        };
        if !added {
            continue 'attempt;
        }

        // Open Yakuhai triplet: any dragon guarantees a yaku, and the open meld
        // makes Riichi illegal so the lesson is the discard alone.
        let dragons = [
            Tile::Honor(Honor::White),
            Tile::Honor(Honor::Green),
            Tile::Honor(Honor::Red),
        ];
        let Some(dragon) = choose(&dragons) else {
            continue 'attempt;
        };
        let open_meld_tiles = vec![dragon, dragon, dragon];
        if deck.take_n(dragon, 3).is_err() {
            continue 'attempt;
        }

        concealed_tiles.extend(ryankan.iter().copied());
        concealed_tiles.extend(head.iter().copied());
        concealed_tiles.push(draw);
        concealed_tiles.extend(second_protorun.iter().copied());

        let mut full_tiles = concealed_tiles.clone();
        full_tiles.extend(open_meld_tiles.iter().copied());
        if validate_hand(&full_tiles).is_err() {
            continue 'attempt;
        }

        let skeleton = RyankanBreakSkeleton {
            full_tiles,
            concealed_tiles,
            ryankan,
            head,
            draw,
            new_ryanmen: [draw, head[0]],
            second_protorun,
            second_wait,
            open_meld_tiles,
            answer_tile: ryankan[0],
        };

        // Verify inside the loop so a hand the rule does not decide cleanly is
        // re-rolled like any other rejected candidate.
        if verify_lesson(&skeleton).is_err() {
            continue 'attempt;
        }

        return Ok(skeleton);
    }

    Err("Failed to construct a valid ryankan break hand".to_string())
}

/// Proves the book's instruction for one hand.
///
/// (a) the answer keeps the hand 1-away;
/// (b) the answer can still reach tenpai on a side wait, so the new ryanmen
///     survives as a real option;
/// (c) undoing the draw (discarding the tile that made the new ryanmen) can only
///     reach closed, edge, single, or double-pair waits.
///
/// The high ryankan terminal is checked too: it is not a second correct answer,
/// because it leaves only closed waits. The answer must also accept at least as
/// many tiles as undoing the draw, so the lesson never contradicts raw
/// acceptance as well as wait quality.
pub(super) fn verify_lesson(skeleton: &RyankanBreakSkeleton) -> Result<(), String> {
    let pre_draw = without(&skeleton.full_tiles, skeleton.draw)?;
    if calculate_shanten(&to_counts(&pre_draw)).shanten != 1 {
        return Err("the hand before the draw must already be 1-away".to_string());
    }

    let answer_hand = without(&skeleton.full_tiles, skeleton.answer_tile)?;
    if calculate_shanten(&to_counts(&answer_hand)).shanten != 1 {
        return Err("breaking the ryankan's low terminal must leave 1-away".to_string());
    }
    if !can_reach_side_wait(&answer_hand) {
        return Err("the answer must leave a side wait reachable".to_string());
    }

    let wrong_hand = without(&skeleton.full_tiles, skeleton.draw)?;
    if calculate_shanten(&to_counts(&wrong_hand)).shanten != 1 {
        return Err("undoing the draw must leave 1-away".to_string());
    }
    if can_reach_side_wait(&wrong_hand) {
        return Err("undoing the draw must leave only closed/edge waits".to_string());
    }

    let high_hand = without(&skeleton.full_tiles, skeleton.ryankan[2])?;
    if calculate_shanten(&to_counts(&high_hand)).shanten != 1 {
        return Err("breaking the ryankan's high terminal must leave 1-away".to_string());
    }
    if can_reach_side_wait(&high_hand) {
        return Err(
            "the high terminal must not keep a side wait; the answer is the low end".to_string(),
        );
    }

    let answer_acceptance = calculate_ukeire(&to_counts(&answer_hand)).total_count;
    let wrong_acceptance = calculate_ukeire(&to_counts(&wrong_hand)).total_count;
    if answer_acceptance < wrong_acceptance {
        return Err(format!(
            "the answer accepts {answer_acceptance} tiles, undoing the draw accepts {wrong_acceptance}"
        ));
    }

    Ok(())
}

fn suited(suit: Suit, value: u8) -> Tile {
    Tile::Suited { suit, value }
}

/// Removes one copy of `discard` from `tiles`.
fn without(tiles: &[Tile], discard: Tile) -> Result<Vec<Tile>, String> {
    let mut remaining = tiles.to_vec();
    let index = remaining
        .iter()
        .position(|tile| *tile == discard)
        .ok_or_else(|| format!("{discard} is not in the hand"))?;
    remaining.remove(index);
    Ok(remaining)
}

/// Adds a random completed run in `suit` if the deck still has one.
fn try_add_run(hand: &mut Vec<Tile>, deck: &mut Deck, suit: Suit) -> bool {
    let starts: Vec<u8> = (1..=7)
        .filter(|start| {
            deck.count(suited(suit, *start)) >= 1
                && deck.count(suited(suit, *start + 1)) >= 1
                && deck.count(suited(suit, *start + 2)) >= 1
        })
        .collect();
    let Some(start) = choose(&starts) else {
        return false;
    };
    for value in start..start + 3 {
        if deck.take(suited(suit, value)).is_err() {
            return false;
        }
        hand.push(suited(suit, value));
    }
    true
}

/// Adds a random triplet in `suit` if the deck still has three copies.
fn try_add_triplet(hand: &mut Vec<Tile>, deck: &mut Deck, suit: Suit) -> bool {
    let values: Vec<u8> = (1..=9)
        .filter(|value| deck.count(suited(suit, *value)) >= 3)
        .collect();
    let Some(value) = choose(&values) else {
        return false;
    };
    if deck.take_n(suited(suit, value), 3).is_err() {
        return false;
    }
    for _ in 0..3 {
        hand.push(suited(suit, value));
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn skeleton_generalizes_across_suits_and_shapes() {
        let mut complex_suits = HashSet::new();
        let mut heads = HashSet::new();
        let mut second_waits = HashSet::new();

        for _ in 0..100 {
            let skeleton = build_skeleton().expect("ryankan break skeleton must build");

            assert_eq!(skeleton.full_tiles.len(), 14);
            assert_eq!(skeleton.concealed_tiles.len(), 11);
            assert_eq!(skeleton.open_meld_tiles.len(), 3);
            assert!(validate_hand(&skeleton.full_tiles).is_ok());

            // The ryankan is X, X+2, X+4 in one suit.
            let [x, x2, x4] = skeleton.ryankan;
            let (
                Tile::Suited { suit, value },
                Tile::Suited {
                    suit: suit2,
                    value: value2,
                },
                Tile::Suited {
                    suit: suit4,
                    value: value4,
                },
            ) = (x, x2, x4)
            else {
                panic!("the ryankan must be suited");
            };
            assert_eq!(suit, suit2);
            assert_eq!(suit, suit4);
            assert_eq!(value2, value + 2);
            assert_eq!(value4, value + 4);
            assert!((1..=5).contains(&value));
            complex_suits.insert(suit);

            // The head and the draw sit next to each other.
            let [head_a, head_b] = skeleton.head;
            assert_eq!(head_a, head_b);
            let Tile::Suited {
                suit: head_suit,
                value: head_value,
            } = head_a
            else {
                panic!("the head must be suited");
            };
            assert_eq!(head_suit, suit);
            let Tile::Suited {
                suit: draw_suit,
                value: draw_value,
            } = skeleton.draw
            else {
                panic!("the draw must be suited");
            };
            assert_eq!(draw_suit, head_suit);
            assert_eq!(draw_value + 1, head_value);
            assert!(skeleton.new_ryanmen.contains(&skeleton.draw));
            assert!(skeleton.new_ryanmen.contains(&head_a));
            heads.insert(head_value);

            // The second protorun is a closed wait in another suit.
            let [low, high] = skeleton.second_protorun;
            let (
                Tile::Suited {
                    suit: low_suit,
                    value: low_value,
                },
                Tile::Suited {
                    suit: high_suit,
                    value: high_value,
                },
            ) = (low, high)
            else {
                panic!("the second protorun must be suited");
            };
            assert_eq!(low_suit, high_suit);
            assert_ne!(low_suit, suit);
            assert_eq!(high_value, low_value + 2);
            assert_eq!(skeleton.second_wait, suited(low_suit, low_value + 1));
            second_waits.insert(skeleton.second_wait);

            // The answer is the low terminal of the ryankan.
            assert_eq!(skeleton.answer_tile, skeleton.ryankan[0]);
            assert_ne!(skeleton.answer_tile, skeleton.draw);
        }

        assert!(
            complex_suits.len() > 1,
            "the generator must cover several suits"
        );
        assert!(heads.len() > 1, "the generator must cover both heads");
        assert!(
            second_waits.len() > 2,
            "the generator must cover several closed waits"
        );
    }

    #[test]
    fn every_skeleton_proves_the_book_instruction() {
        for _ in 0..60 {
            let skeleton = build_skeleton().expect("ryankan break skeleton must build");
            verify_lesson(&skeleton).expect("every skeleton must prove the discard");

            let answer_hand = without(&skeleton.full_tiles, skeleton.answer_tile).unwrap();
            assert!(can_reach_side_wait(&answer_hand));

            let wrong_hand = without(&skeleton.full_tiles, skeleton.draw).unwrap();
            assert!(!can_reach_side_wait(&wrong_hand));

            let answer_acceptance = calculate_ukeire(&to_counts(&answer_hand)).total_count;
            let wrong_acceptance = calculate_ukeire(&to_counts(&wrong_hand)).total_count;
            assert!(answer_acceptance >= wrong_acceptance);
        }
    }

    #[test]
    fn the_high_terminal_is_not_a_second_answer() {
        for _ in 0..50 {
            let skeleton = build_skeleton().expect("ryankan break skeleton must build");
            let high_hand = without(&skeleton.full_tiles, skeleton.ryankan[2]).unwrap();
            assert_eq!(calculate_shanten(&to_counts(&high_hand)).shanten, 1);
            assert!(!can_reach_side_wait(&high_hand));
        }
    }
}
