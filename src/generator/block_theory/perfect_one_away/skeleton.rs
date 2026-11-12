//! Constructive skeleton for the perfect-1-away lesson (ch. 3.2).
//!
//! Riichi Book 1, ch. 3, "Perfect $n$-away":
//!
//! > When a 1-away hand has two side-wait protoruns and two pairs, it is called
//! > {\bf perfect 1-away}. — ch3:382
//! >
//! > It is called ``perfect'' because this hand can become ready either by
//! > calling {\jap chii}, calling {\jap pon}, or drawing a tile to complete a
//! > run or a set, and no matter how a hand becomes ready, you will
//! > \emph{always} have the option to choose side wait as the final wait.
//! > — ch3:389
//!
//! Anki 1463192202158 ("What's a perfect 1-away hand? Why is it perfect?").
//!
//! The skeleton generalises the book's own ch3:498 hand, which it presents as a
//! question: the player holds the perfect shape and draws the tile that turns
//! the complex suit into a double closed shape. The player holds:
//!
//! - two completed runs (one in the pair's suit, one in the complex suit),
//! - one protorun plus one (`223` / `334`): a side wait whose end is also a
//!   pair, so the hand holds its two side waits and two pairs in thirteen tiles,
//! - one standalone side wait,
//! - one standalone pair.
//!
//! The draw lands two ranks below the complex run, turning `456p + 67p` into
//! `246p + 567p` — the book's double closed (ryankan) shape. The drill's answer
//! is to throw the draw back and keep the shape ch3:382 defines and ch3:389
//! calls perfect; its rival is to keep the double closed shape by breaking the
//! pair of the protorun plus one (`455m` -> `45m`, the book's own ch3:498
//! discard line).
//!
//! The rival accepts slightly more tiles on paper — the whole point of the drill
//! — but it is not the perfect shape: it trades one of the two pairs for a block
//! the book says is only for hands "relatively far from ready (2-away or worse)"
//! and that "will ultimately become a single closed-wait protorun when this
//! block remains incomplete when the hand is ready" (ch3:505-506).

use agari::parse::to_counts;
use agari::shanten::{calculate_shanten, calculate_ukeire};
use agari::tile::{Suit, Tile};

use crate::generator::support::completion::is_perfect_one_away;
use crate::generator::support::deck::Deck;
use crate::rng::{gen_range, shuffle};

/// The constructed parts of one perfect-1-away puzzle.
#[derive(Debug, Clone)]
pub(super) struct Skeleton {
    /// All fourteen tiles: the perfect hand plus the draw.
    pub full_tiles: Vec<Tile>,
    /// The thirteen tiles the perfect hand held before the draw.
    pub concealed_tiles: Vec<Tile>,
    /// The tile just drawn. Discarding it is the answer.
    pub draw: Tile,
    /// The run that sits beside the standalone pair, in the pair's suit.
    pub pair_run: [Tile; 3],
    /// The protorun plus one block (`223` or `334`).
    pub shared: [Tile; 3],
    /// The side wait inside the shared block.
    pub shared_ryanmen: [Tile; 2],
    /// The duplicated tile of the shared block: discarding it keeps the side
    /// wait and is the rival answer.
    pub rival_tile: Tile,
    /// The run the draw sits below, in the complex suit.
    pub complex_run: [Tile; 3],
    /// The standalone side wait in the complex suit.
    pub ryanmen: [Tile; 2],
    /// The double closed shape the draw creates (`draw`, run low, wait low).
    pub ryankan: [Tile; 3],
    /// Live acceptance after the book's discard.
    pub answer_acceptance: u8,
    /// Live acceptance after the rival discard that keeps the ryankan.
    pub rival_acceptance: u8,
}

/// Builds one hand and proves the book's discard on it.
pub(super) fn build_skeleton() -> Result<Skeleton, String> {
    let mut last = String::new();
    for _ in 0..4_000 {
        match attempt() {
            Ok(skeleton) => return Ok(skeleton),
            Err(err) => last = err,
        }
    }
    Err(format!("could not build a perfect 1-away hand: {last}"))
}

fn attempt() -> Result<Skeleton, String> {
    let mut suits = [Suit::Man, Suit::Pin, Suit::Sou];
    shuffle(&mut suits);

    construct(Construction {
        pair_suit: suits[0],
        shared_suit: suits[1],
        complex_suit: suits[2],
        run_start: gen_range(1, 8) as u8,
        shared_value: gen_range(2, 8) as u8,
        shared_high_pair: gen_range(0, 2) == 0,
        complex_start: gen_range(3, 6) as u8,
    })
}

/// The parameters one hand is built from.
#[derive(Debug, Clone, Copy)]
struct Construction {
    pair_suit: Suit,
    shared_suit: Suit,
    complex_suit: Suit,
    /// Low tile of the run in the pair's suit.
    run_start: u8,
    /// Low tile of the protorun plus one.
    shared_value: u8,
    /// True for `334` (pair on the high end), false for `223`.
    shared_high_pair: bool,
    /// Low tile of the run in the complex suit.
    complex_start: u8,
}

/// Builds one hand from fixed parameters and proves the book's discard on it.
fn construct(params: Construction) -> Result<Skeleton, String> {
    let Construction {
        pair_suit,
        shared_suit,
        complex_suit,
        run_start,
        shared_value,
        shared_high_pair,
        complex_start,
    } = params;

    // The pair's suit holds a completed run and the standalone pair. The pair
    // sits on the run's middle tile, so the hand holds three copies of that tile
    // and the pair's own completion is thin. That is the small raw-acceptance
    // cost the perfect shape pays here, and it is what lets the rival out-count
    // it.
    let pair_run = [
        suited(pair_suit, run_start),
        suited(pair_suit, run_start + 1),
        suited(pair_suit, run_start + 2),
    ];
    let pair = [suited(pair_suit, run_start + 1); 2];

    // The protorun plus one: `223` or `334`, a side wait whose end is also a
    // pair. Ranks 2-7 keep the wait two-sided.
    let shared = if shared_high_pair {
        [
            suited(shared_suit, shared_value),
            suited(shared_suit, shared_value + 1),
            suited(shared_suit, shared_value + 1),
        ]
    } else {
        [
            suited(shared_suit, shared_value),
            suited(shared_suit, shared_value),
            suited(shared_suit, shared_value + 1),
        ]
    };
    let shared_ryanmen = [shared[0], shared[2]];
    let rival_tile = if shared_high_pair {
        shared[2]
    } else {
        shared[0]
    };

    // The complex suit holds a run and the standalone side wait, which starts
    // two ranks above the run's low tile. The draw sits two ranks below that
    // low tile, so `draw + run low + wait low` is a double closed shape.
    let complex_run = [
        suited(complex_suit, complex_start),
        suited(complex_suit, complex_start + 1),
        suited(complex_suit, complex_start + 2),
    ];
    let ryanmen = [
        suited(complex_suit, complex_start + 2),
        suited(complex_suit, complex_start + 3),
    ];
    let draw = suited(complex_suit, complex_start - 2);
    let ryankan = [draw, complex_run[0], ryanmen[0]];

    let mut concealed_tiles = Vec::with_capacity(13);
    concealed_tiles.extend(pair_run);
    concealed_tiles.extend(pair);
    concealed_tiles.extend(shared);
    concealed_tiles.extend(complex_run);
    concealed_tiles.extend(ryanmen);
    if concealed_tiles.len() != 13 {
        return Err("the perfect hand must hold thirteen tiles".to_string());
    }

    let mut full_tiles = concealed_tiles.clone();
    full_tiles.push(draw);

    // Copy limits: four of a tile, never five.
    let mut deck = Deck::fresh();
    for tile in &full_tiles {
        deck.take(*tile)?;
    }

    let skeleton = Skeleton {
        full_tiles,
        concealed_tiles,
        draw,
        pair_run,
        shared,
        shared_ryanmen,
        rival_tile,
        complex_run,
        ryanmen,
        ryankan,
        answer_acceptance: 0,
        rival_acceptance: 0,
    };

    let (answer_acceptance, rival_acceptance) = verify_lesson(&skeleton)?;

    Ok(Skeleton {
        answer_acceptance,
        rival_acceptance,
        ..skeleton
    })
}

/// Proves the book's discard for one hand, returning the two acceptance counts.
///
/// (a) the thirteen-tile hand is the book's perfect 1-away, both structurally
///     (two side-wait protoruns plus two pairs plus completed sets) and by the
///     every-completion test;
/// (b) the fourteen tiles are still 1-away;
/// (c) discarding the draw is the *only* perfect discard;
/// (d) the rival — discarding the shared block's duplicated tile, which keeps
///     its side wait — leaves 1-away but not perfect: it gives up the second
///     pair for a double closed shape, and accepts strictly more tiles than the
///     book's discard;
/// (e) no other non-perfect discard accepts more than the rival, so the
///     temptation the lesson shows is the strongest one.
pub(super) fn verify_lesson(skeleton: &Skeleton) -> Result<(u8, u8), String> {
    if skeleton.full_tiles.len() != 14 || skeleton.concealed_tiles.len() != 13 {
        return Err("a turn hand must hold fourteen tiles".to_string());
    }
    if calculate_shanten(&to_counts(&skeleton.concealed_tiles)).shanten != 1 {
        return Err("the perfect hand must be 1-away".to_string());
    }
    if !is_perfect_one_away(&skeleton.concealed_tiles) {
        return Err("the thirteen tiles must be the book's perfect 1-away".to_string());
    }
    if calculate_shanten(&to_counts(&skeleton.full_tiles)).shanten != 1 {
        return Err("the drawn hand must still be 1-away".to_string());
    }
    if skeleton.rival_tile == skeleton.draw {
        return Err("the rival cannot be the drawn tile".to_string());
    }
    if !skeleton.full_tiles.contains(&skeleton.draw) {
        return Err("the draw must be one of the fourteen tiles".to_string());
    }
    for tile in skeleton.shared_ryanmen {
        if !skeleton.full_tiles.contains(&tile) {
            return Err("the shared side wait must be in the hand".to_string());
        }
    }

    let answer_acceptance = calculate_ukeire(&to_counts(&skeleton.concealed_tiles)).total_count;

    let rival_hand = without(&skeleton.full_tiles, skeleton.rival_tile)?;
    if calculate_shanten(&to_counts(&rival_hand)).shanten != 1 {
        return Err("the rival discard must leave the hand 1-away".to_string());
    }
    if is_perfect_one_away(&rival_hand) {
        return Err("the rival discard must not leave a perfect hand".to_string());
    }
    let rival_acceptance = calculate_ukeire(&to_counts(&rival_hand)).total_count;
    if rival_acceptance <= answer_acceptance {
        return Err(format!(
            "the book's discard accepts {answer_acceptance} tiles, the rival accepts \
             {rival_acceptance}"
        ));
    }

    for tile in distinct_tiles(&skeleton.full_tiles) {
        if tile == skeleton.draw {
            continue;
        }
        let remaining = without(&skeleton.full_tiles, tile)?;
        if calculate_shanten(&to_counts(&remaining)).shanten != 1 {
            continue;
        }
        if is_perfect_one_away(&remaining) {
            return Err(format!(
                "discarding {tile} also leaves the perfect hand, so the answer is not unique"
            ));
        }
        let total = calculate_ukeire(&to_counts(&remaining)).total_count;
        if total > rival_acceptance {
            return Err(format!(
                "discarding {tile} accepts {total} tiles, more than the rival's {rival_acceptance}"
            ));
        }
    }

    Ok((answer_acceptance, rival_acceptance))
}

fn suited(suit: Suit, value: u8) -> Tile {
    Tile::Suited { suit, value }
}

fn distinct_tiles(tiles: &[Tile]) -> Vec<Tile> {
    let mut distinct = tiles.to_vec();
    distinct.sort();
    distinct.dedup();
    distinct
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn every_skeleton_proves_the_book_discard() {
        for run in 0..60 {
            let skeleton = build_skeleton()
                .unwrap_or_else(|err| panic!("perfect 1-away skeleton run {run}: {err}"));

            assert_eq!(skeleton.full_tiles.len(), 14);
            assert_eq!(skeleton.concealed_tiles.len(), 13);
            assert_eq!(skeleton.draw, skeleton.ryankan[0]);
            assert!(skeleton.shared.contains(&skeleton.rival_tile));
            assert!(skeleton.shared_ryanmen.contains(&skeleton.rival_tile));
            assert!(skeleton.rival_acceptance > skeleton.answer_acceptance);
            assert!(is_perfect_one_away(&skeleton.concealed_tiles));
            assert!(!skeleton.concealed_tiles.contains(&skeleton.draw));
        }
    }

    #[test]
    fn the_geometry_generalizes_across_suits_and_ranks() {
        let mut pair_suits = HashSet::new();
        let mut shared_values = HashSet::new();
        let mut complex_starts = HashSet::new();

        for _ in 0..80 {
            let skeleton = build_skeleton().expect("skeleton must build");
            pair_suits.insert(skeleton.pair_run[0].suit().expect("a suited run"));
            shared_values.insert(skeleton.shared_ryanmen[0].value().expect("a suited wait"));
            complex_starts.insert(skeleton.complex_run[0].value().expect("a suited run"));
        }

        assert!(
            pair_suits.len() > 1,
            "the generator must cover several suits"
        );
        assert!(
            shared_values.len() > 2,
            "the generator must cover several shared blocks"
        );
        assert!(
            complex_starts.len() > 1,
            "the generator must cover several complex runs"
        );
    }
}
