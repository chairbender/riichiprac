//! Score enumeration and block counting for the honitsu lesson.
//!
//! Riichi Book 1, ch. 5, "Conditions to go for honitsu", asks the player to
//! weigh two things (ch5:468):
//!
//! > five-block potential and hand values with and without honitsu
//!
//! Both are derived here from tiles rather than trusted from the constructor:
//!
//! - [`blocks_and_floaters`] is the book's five-block reading of a hand: it
//!   counts complete sets, protoruns and pairs as blocks and a leftover tile as
//!   a floating block candidate (ch5:492 counts the two fanpai pairs, the pair
//!   and the 79m protorun as four blocks, "and ... either of the two floating
//!   tiles ... to produce the fifth block").
//! - [`honitsu_reading`] completes the suit-plus-honor group into the best
//!   fourteen-tile hand the honitsu plan can reach, so its value can be scored.
//! - [`read_hand`] scores one finished hand and returns the yaku it claims, so
//!   "honitsu and two yakuhai" can be told apart from a "honitsu-only hand,
//!   which is very cheap (2000 or 2600 points)" (ch5:506).

use std::collections::BTreeMap;

use agari::context::{GameContext, WinType};
use agari::hand::{HandStructure, decompose_hand};
use agari::parse::to_counts;
use agari::scoring::calculate_score;
use agari::tile::{Honor, Suit, Tile};
use agari::yaku::{Yaku, detect_yaku_with_context};

use crate::generator::support::analysis::wind_to_honor;
use crate::generator::support::value::Value;
use crate::state::Wind;

/// The three suits, in the order the block counter walks them.
pub(crate) const SUITS: [Suit; 3] = [Suit::Man, Suit::Pin, Suit::Sou];

/// Every honor, in tile order.
pub(crate) const HONORS: [Honor; 7] = [
    Honor::East,
    Honor::South,
    Honor::West,
    Honor::North,
    Honor::White,
    Honor::Green,
    Honor::Red,
];

/// The three dragons, the fanpai that are never a seat/round wind.
pub(crate) const DRAGONS: [Honor; 3] = [Honor::White, Honor::Green, Honor::Red];

/// The book's block reading of a set of tiles.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Blocks {
    /// Complete sets, protoruns and pairs.
    pub blocks: u8,
    /// The isolated tiles left over: the book's "block candidates".
    pub floaters: Vec<Tile>,
}

impl Blocks {
    /// True when the group has the book's five blocks-or-candidates.
    pub fn has_five_block_potential(&self) -> bool {
        self.blocks as usize + self.floaters.len() >= 5
    }
}

/// Counts complete sets, then protoruns, then pairs, and keeps what is left
/// over as floating block candidates.
///
/// The order is the book's own reading order: a shape is read as complete first
/// and as an incomplete protorun only when it cannot be a set. It is a greedy
/// count, which is all the lesson needs: every hand here is built out of
/// separated groups, so no alternate decomposition changes the count.
pub(crate) fn blocks_and_floaters(tiles: &[Tile]) -> Blocks {
    let mut counts: BTreeMap<Tile, u8> = BTreeMap::new();
    for &tile in tiles {
        *counts.entry(tile).or_insert(0) += 1;
    }

    let mut blocks = 0u8;

    for suit in SUITS {
        // Complete triplets.
        for value in 1..=9u8 {
            while count(&counts, suit, value) >= 3 {
                take(&mut counts, suit, value, 3);
                blocks += 1;
            }
        }
        // Complete runs.
        for value in 1..=7u8 {
            while count(&counts, suit, value) >= 1
                && count(&counts, suit, value + 1) >= 1
                && count(&counts, suit, value + 2) >= 1
            {
                take(&mut counts, suit, value, 1);
                take(&mut counts, suit, value + 1, 1);
                take(&mut counts, suit, value + 2, 1);
                blocks += 1;
            }
        }
        // Side and edge protoruns. Edge shapes (12, 89) are not protoruns. A
        // pair is read as a pair, never as one half of a protorun, so both
        // copies must still be single tiles here.
        for value in 1..=8u8 {
            if matches!(value, 1 | 8) {
                continue;
            }
            while count(&counts, suit, value) == 1 && count(&counts, suit, value + 1) == 1 {
                take(&mut counts, suit, value, 1);
                take(&mut counts, suit, value + 1, 1);
                blocks += 1;
            }
        }
        // Closed protoruns (a gap of one rank).
        for value in 1..=7u8 {
            while count(&counts, suit, value) == 1 && count(&counts, suit, value + 2) == 1 {
                take(&mut counts, suit, value, 1);
                take(&mut counts, suit, value + 2, 1);
                blocks += 1;
            }
        }
        // Pairs.
        for value in 1..=9u8 {
            while count(&counts, suit, value) >= 2 {
                take(&mut counts, suit, value, 2);
                blocks += 1;
            }
        }
    }

    let mut floaters = Vec::new();
    for honor in HONORS {
        let tile = Tile::Honor(honor);
        let held = counts.get(&tile).copied().unwrap_or(0);
        blocks += held / 3;
        blocks += (held % 3) / 2;
        if held % 3 == 1 {
            floaters.push(tile);
        }
    }
    for suit in SUITS {
        for value in 1..=9u8 {
            if count(&counts, suit, value) > 0 {
                floaters.push(Tile::suited(suit, value));
            }
        }
    }
    floaters.sort();

    Blocks { blocks, floaters }
}

fn count(counts: &BTreeMap<Tile, u8>, suit: Suit, value: u8) -> u8 {
    counts.get(&Tile::suited(suit, value)).copied().unwrap_or(0)
}

fn take(counts: &mut BTreeMap<Tile, u8>, suit: Suit, value: u8, n: u8) {
    let entry = counts.entry(Tile::suited(suit, value)).or_insert(0);
    *entry = entry.saturating_sub(n);
}

/// True for the fanpai: dragons, the round wind and the seat wind.
pub(crate) fn is_fanpai(tile: Tile, round_wind: Wind, seat_wind: Wind) -> bool {
    match tile {
        Tile::Honor(honor) => {
            DRAGONS.contains(&honor)
                || honor == wind_to_honor(round_wind)
                || honor == wind_to_honor(seat_wind)
        }
        Tile::Suited { .. } => false,
    }
}

/// The best ron reading of one complete, closed hand, without Riichi.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Reading {
    /// Ron points and han.
    pub value: Value,
    /// The yaku the winning reading claims (dora are counted in `value` but are
    /// not yaku).
    pub yaku: Vec<Yaku>,
}

impl Reading {
    /// True when the only yaku claimed is honitsu itself. Riichi Book 1,
    /// ch5:506 calls such a hand a "honitsu-only hand, which is very cheap".
    pub fn is_honitsu_only(&self) -> bool {
        self.yaku.iter().any(|yaku| *yaku == Yaku::Honitsu)
            && self.yaku.iter().all(|yaku| *yaku == Yaku::Honitsu)
    }
}

/// The best ron value of one finished hand, plus the yaku behind it.
pub(crate) fn read_hand(
    winning: &[Tile],
    wait: Tile,
    round_wind: Wind,
    seat_wind: Wind,
    dora: &[Tile],
    aka: u8,
) -> Option<Reading> {
    let counts = to_counts(winning);
    let context = GameContext::new(
        WinType::Ron,
        wind_to_honor(round_wind),
        wind_to_honor(seat_wind),
    )
    .with_winning_tile(wait)
    .with_dora(dora.to_vec())
    .with_aka(aka);

    decompose_hand(&counts)
        .iter()
        .filter(|structure| matches!(structure, HandStructure::Standard { .. }))
        .filter_map(|structure| {
            let detected = detect_yaku_with_context(structure, &counts, &context);
            if detected.yaku_list.is_empty() {
                return None;
            }
            let score = calculate_score(structure, &detected, &context);
            Some(Reading {
                value: Value {
                    points: score.payment.total,
                    han: score.han,
                },
                yaku: detected.yaku_list,
            })
        })
        .max_by_key(|reading| reading.value.points)
}

/// The best hand the honitsu plan can become, scored.
///
/// The plan keeps every tile it holds and adds up to four tiles of the target
/// suit or honors until the hand wins. Enumerating those four tiles is the
/// "hand value with honitsu" of ch5:468: whatever the plan can grow into, it
/// stays a half-flush, so its score is directly comparable with the same tiles
/// played straight.
///
/// The group is expected to be three or four tiles short (the lesson's groups
/// are eleven or ten tiles); anything shorter or longer returns `None`, which
/// the caller treats as "this table is not a honitsu decision".
pub(crate) fn honitsu_reading(
    tiles: &[Tile],
    suit: Suit,
    round_wind: Wind,
    seat_wind: Wind,
    dora: &[Tile],
    aka: u8,
) -> Option<Reading> {
    let group: Vec<Tile> = tiles
        .iter()
        .copied()
        .filter(|tile| match tile.suit() {
            Some(tile_suit) => tile_suit == suit,
            None => true,
        })
        .collect();
    let need = 14usize.checked_sub(group.len())?;
    if need == 0 || need > 4 {
        return None;
    }

    let base = to_counts(&group);
    let pool = honitsu_pool(suit);
    let mut best: Option<Reading> = None;
    for addition in combinations(&pool, need) {
        let mut counts = base.clone();
        let mut within_limits = true;
        for tile in &addition {
            let count = counts.entry(*tile).or_insert(0);
            *count += 1;
            if *count > 4 {
                within_limits = false;
                break;
            }
        }
        if !within_limits || decompose_hand(&counts).is_empty() {
            continue;
        }

        let mut winning: Vec<Tile> = Vec::with_capacity(14);
        for (&tile, &count) in &counts {
            for _ in 0..count {
                winning.push(tile);
            }
        }
        let mut waits = addition.clone();
        waits.sort();
        waits.dedup();
        for wait in waits {
            if let Some(reading) = read_hand(&winning, wait, round_wind, seat_wind, dora, aka)
                && best
                    .as_ref()
                    .is_none_or(|current| reading.value.points > current.value.points)
            {
                best = Some(reading);
            }
        }
    }
    best
}

/// The tiles the honitsu plan may still draw: the target suit and every honor.
fn honitsu_pool(suit: Suit) -> Vec<Tile> {
    let mut pool: Vec<Tile> = (1..=9u8).map(|value| Tile::suited(suit, value)).collect();
    pool.extend(HONORS.iter().map(|honor| Tile::Honor(*honor)));
    pool
}

/// Every multiset of `count` tiles from `pool`, in pool order.
fn combinations(pool: &[Tile], count: usize) -> Vec<Vec<Tile>> {
    let mut out = Vec::new();
    let mut current = Vec::with_capacity(count);
    fn walk(
        pool: &[Tile],
        count: usize,
        start: usize,
        current: &mut Vec<Tile>,
        out: &mut Vec<Vec<Tile>>,
    ) {
        if current.len() == count {
            out.push(current.clone());
            return;
        }
        for index in start..pool.len() {
            current.push(pool[index]);
            walk(pool, count, index, current, out);
            current.pop();
        }
    }
    walk(pool, count, 0, &mut current, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::generator::support::testing::parse_tile;

    fn tiles(codes: &[&str]) -> Vec<Tile> {
        codes.iter().map(|code| parse_tile(code)).collect()
    }

    #[test]
    fn the_books_honitsu_example_has_four_blocks_and_two_floaters() {
        // Ch5, Honitsu 1: 55m 79m 東東 中中 1m, plus the two floaters 東 and 1m.
        let hand = tiles(&["5m", "5m", "7m", "9m", "1z", "1z", "7z", "7z", "1m"]);
        let blocks = blocks_and_floaters(&hand);
        assert_eq!(blocks.blocks, 4);
        assert_eq!(blocks.floaters, tiles(&["1m"]));
        assert!(blocks.has_five_block_potential());
    }

    #[test]
    fn a_lone_wind_is_a_floating_block_candidate() {
        let hand = tiles(&["1z"]);
        let blocks = blocks_and_floaters(&hand);
        assert_eq!(blocks.blocks, 0);
        assert_eq!(blocks.floaters, tiles(&["1z"]));
    }

    #[test]
    fn a_group_with_two_fanpai_pairs_completes_to_a_valuable_honitsu() {
        // 123m 567m 白白 中中 9m: the book's four blocks and a floating tile.
        let hand = tiles(&[
            "1m", "2m", "3m", "5m", "6m", "7m", "5z", "5z", "7z", "7z", "9m",
        ]);
        let reading = honitsu_reading(&hand, Suit::Man, Wind::East, Wind::South, &[], 0)
            .expect("the group completes");
        assert!(reading.yaku.contains(&Yaku::Honitsu));
        assert!(reading.value.points >= 5_200);
        assert!(!reading.is_honitsu_only());
    }

    #[test]
    fn a_group_without_fanpai_completes_to_a_honitsu_only_hand() {
        // The cheap branch's shape: 123m 567m 24m 79m 東. No fanpai, and the
        // completed runs are 123 234 567 789, so it cannot pick up ittsu or
        // iipeikou either.
        let hand = tiles(&[
            "1m", "2m", "3m", "5m", "6m", "7m", "2m", "4m", "7m", "9m", "1z",
        ]);
        let reading = honitsu_reading(&hand, Suit::Man, Wind::East, Wind::South, &[], 0)
            .expect("the group completes");
        assert!(reading.is_honitsu_only(), "{:?}", reading.yaku);
        // This crate scores a closed honitsu at three han; the book's 2000/2600
        // is the open, two-han value of the same plan.
        assert_eq!(reading.value.han, 3);
    }

    #[test]
    fn a_group_too_short_to_complete_has_no_reading() {
        let hand = tiles(&["1m"]);
        assert!(honitsu_reading(&hand, Suit::Man, Wind::East, Wind::South, &[], 0).is_none());
    }
}
