//! The general Riichi-vs-dama rule from Riichi Book 1, ch. 7.
//!
//! The book states one box and then explains it in words:
//!
//! > Choose riichi over dama if **at least one** of the following three
//! > conditions is met. 1. Your hand has at least one han other than riichi.
//! > 2. Your hand has a good wait. 3. You are the dealer. — ch7:55-59
//!
//! > In other words, the only type of riichi that these criteria prohibit is a
//! > bad-wait riichi-only hand by a non-dealer. — ch7:71
//!
//! A wait is good when there are "at least two kinds and more than four tiles
//! left to win on" (ch7:491), counting *live* tiles: the book is explicit that
//! "you should count the kinds and the number of live tiles to win on, not
//! merely the ideal numbers suggested by the hand shape."
//!
//! This module computes those three conditions from a finished hand. The
//! generator then only accepts hands whose computed conditions match the
//! answer it built for, so the book rule — not the constructor — decides the
//! grade.

use std::collections::HashMap;

use agari::context::{GameContext, WinType};
use agari::hand::{HandStructure, decompose_hand};
use agari::parse::to_counts;
use agari::scoring::{ScoreLevel, calculate_score};
use agari::shanten::calculate_ukeire_with_visible;
use agari::tile::Tile;
use agari::yaku::detect_yaku_with_context;

use crate::generator::support::analysis::wind_to_honor;
use crate::state::Wind;

/// A wait is good when it has at least two kinds of winning tile (ch7:491).
pub(super) const GOOD_WAIT_MIN_KINDS: usize = 2;
/// ... and more than four live tiles left to win on, i.e. at least five.
pub(super) const GOOD_WAIT_MIN_TILES: u8 = 5;
/// The book's separate "bad wait" dama case is a wait with only one or two
/// tiles left (ch7:520). Keeping at least three live here means that exception
/// never applies, so the three-condition rule is the only thing deciding.
pub(super) const MIN_LIVE_TILES: u8 = 3;

/// The three ch7.1 conditions, as they hold for one hand.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Conditions {
    /// Condition 1: at least one han other than riichi at every winning tile.
    pub extra_han: bool,
    /// Condition 2: the live wait has at least two kinds and more than four
    /// tiles left.
    pub good_wait: bool,
    /// Condition 3: the human is the dealer (East seat).
    pub dealer: bool,
}

impl Conditions {
    /// True when the book's rule picks Riichi.
    pub(crate) fn picks_riichi(self) -> bool {
        self.extra_han || self.good_wait || self.dealer
    }

    /// The condition set named for the agreement report.
    ///
    /// Every label states all three conditions as the table shows them, and
    /// never names the action they pick. The note that carries this string is
    /// shown under a scenario the player has not answered yet, so a label such
    /// as `riichi: good wait only` would hand over the answer; `no extra han`
    /// only means condition 1 of ch7:55-59 is off, which the player can see for
    /// themselves by scoring the hand.
    pub(crate) fn label(self) -> &'static str {
        match (self.extra_han, self.good_wait, self.dealer) {
            (false, false, false) => "no extra han, bad wait, non-dealer",
            (true, false, false) => "extra han, bad wait, non-dealer",
            (false, true, false) => "no extra han, good wait, non-dealer",
            (false, false, true) => "no extra han, bad wait, dealer",
            (true, true, false) => "extra han, good wait, non-dealer",
            (true, false, true) => "extra han, bad wait, dealer",
            (false, true, true) => "no extra han, good wait, dealer",
            (true, true, true) => "extra han, good wait, dealer",
        }
    }

    /// The non-empty condition sets, used by the generator and its tests.
    pub(super) const RIICHI_SETS: [Conditions; 7] = [
        Conditions {
            extra_han: true,
            good_wait: false,
            dealer: false,
        },
        Conditions {
            extra_han: false,
            good_wait: true,
            dealer: false,
        },
        Conditions {
            extra_han: false,
            good_wait: false,
            dealer: true,
        },
        Conditions {
            extra_han: true,
            good_wait: true,
            dealer: false,
        },
        Conditions {
            extra_han: true,
            good_wait: false,
            dealer: true,
        },
        Conditions {
            extra_han: false,
            good_wait: true,
            dealer: true,
        },
        Conditions {
            extra_han: true,
            good_wait: true,
            dealer: true,
        },
    ];
}

/// Live wait quality, counted the way ch7:491 counts it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WaitQuality {
    /// Distinct winning tile types that still have at least one live copy.
    pub(crate) live_kinds: usize,
    /// Live copies of every winning tile, across all kinds.
    pub(crate) live_tiles: u8,
}

impl WaitQuality {
    pub(crate) fn is_good(self) -> bool {
        self.live_kinds >= GOOD_WAIT_MIN_KINDS && self.live_tiles >= GOOD_WAIT_MIN_TILES
    }
}

/// Counts the live winning tiles of a tenpai hand.
///
/// `visible` is everything the player can see on the table — the opponents'
/// rivers, melds and dora indicators — and must not repeat the hand's own
/// tiles, which `agari` already subtracts.
pub(crate) fn wait_quality(tenpai_tiles: &[Tile], visible: &HashMap<Tile, u8>) -> WaitQuality {
    let counts = to_counts(tenpai_tiles);
    let ukeire = calculate_ukeire_with_visible(&counts, visible);

    WaitQuality {
        live_kinds: ukeire
            .tiles
            .iter()
            .filter(|entry| entry.available > 0)
            .count(),
        live_tiles: ukeire.total_count,
    }
}

/// The han a finished hand scores without Riichi, at its best yaku reading.
///
/// Reading the *best* decomposition is deliberate: a hand that can be scored
/// with a yaku is worth at least one han, and the book's condition 1 asks
/// whether the hand "has at least one han other than riichi".
pub(crate) fn han_without_riichi(
    winning_tiles: &[Tile],
    wait: Tile,
    round_wind: Wind,
    seat_wind: Wind,
    dora_indicators: &[Tile],
) -> u8 {
    let counts = to_counts(winning_tiles);
    let context = GameContext::new(
        WinType::Ron,
        wind_to_honor(round_wind),
        wind_to_honor(seat_wind),
    )
    .with_winning_tile(wait)
    .with_dora(dora_indicators.to_vec());

    decompose_hand(&counts)
        .iter()
        .filter(|structure| matches!(structure, HandStructure::Standard { .. }))
        .map(|structure| {
            detect_yaku_with_context(structure, &counts, &context).total_han_with_dora()
        })
        .max()
        .unwrap_or(0)
}

/// The highest score level the finished hand can reach without Riichi.
///
/// The book's general rule is the default; ch. 7's later sections list cases
/// where dama is still better, including "when your hand is already expensive
/// without riichi (minimum of 7700 ...), it is OK to go dama." The generator
/// only accepts hands below mangan so that exception never applies.
pub(super) fn worst_score_level(
    winning_tiles: &[Tile],
    wait: Tile,
    round_wind: Wind,
    seat_wind: Wind,
    dora_indicators: &[Tile],
) -> ScoreLevel {
    let counts = to_counts(winning_tiles);
    let context = GameContext::new(
        WinType::Ron,
        wind_to_honor(round_wind),
        wind_to_honor(seat_wind),
    )
    .with_winning_tile(wait)
    .with_dora(dora_indicators.to_vec());

    decompose_hand(&counts)
        .iter()
        .filter(|structure| matches!(structure, HandStructure::Standard { .. }))
        .map(|structure| {
            let yaku = detect_yaku_with_context(structure, &counts, &context);
            calculate_score(structure, &yaku, &context).score_level
        })
        .max()
        .unwrap_or(ScoreLevel::Normal)
}

/// The han the hand is guaranteed to have without Riichi.
///
/// "Worst winning tile" means the minimum across every winning tile: a hand
/// that only has a yaku on one side of its wait is a riichi-only hand on the
/// other side, and the book's rule is about the hand, not the lucky draw.
/// The round and seat winds are fixed by the board, and no dora may touch the
/// hand, so the result is stable before and after the table is dealt.
pub(crate) fn min_han_without_riichi(
    tenpai_tiles: &[Tile],
    wait_tiles: &[Tile],
    round_wind: Wind,
    seat_wind: Wind,
    dora_indicators: &[Tile],
) -> u8 {
    wait_tiles
        .iter()
        .map(|&wait| {
            let mut winning_tiles = tenpai_tiles.to_vec();
            winning_tiles.push(wait);
            han_without_riichi(&winning_tiles, wait, round_wind, seat_wind, dora_indicators)
        })
        .min()
        .unwrap_or(0)
}

/// The three conditions as they hold for this hand.
pub(crate) fn evaluate(
    tenpai_tiles: &[Tile],
    wait_tiles: &[Tile],
    round_wind: Wind,
    seat_wind: Wind,
    dora_indicators: &[Tile],
    visible: &HashMap<Tile, u8>,
) -> Conditions {
    Conditions {
        extra_han: min_han_without_riichi(
            tenpai_tiles,
            wait_tiles,
            round_wind,
            seat_wind,
            dora_indicators,
        ) >= 1,
        good_wait: wait_quality(tenpai_tiles, visible).is_good(),
        dealer: seat_wind == Wind::East,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generator::support::testing::parse_tile;
    use agari::parse::parse_hand;

    fn tiles(hand: &str) -> Vec<Tile> {
        parse_hand(hand).expect("hand must parse")
    }

    #[test]
    fn the_three_condition_set_is_the_full_rule() {
        for conditions in Conditions::RIICHI_SETS {
            assert!(conditions.picks_riichi(), "{conditions:?}");
        }
        assert!(!Conditions::default().picks_riichi());
    }

    #[test]
    fn wait_quality_counts_kinds_and_live_tiles() {
        // 34m waits on 2m/5m: two kinds, eight nominal tiles.
        let hand = tiles("123m567p789s22z34m");
        let quality = wait_quality(&hand, &HashMap::new());
        // One 2m is already in the 123m run, so only three 2m and four 5m live.
        assert_eq!(quality.live_kinds, 2);
        assert_eq!(quality.live_tiles, 7);
        assert!(quality.is_good());

        // Every copy of 2m and 5m visible cuts the wait to nothing.
        let mut visible = HashMap::new();
        visible.insert(parse_tile("2m"), 4);
        visible.insert(parse_tile("5m"), 4);
        let quality = wait_quality(&hand, &visible);
        assert_eq!(quality.live_tiles, 0);
        assert!(!quality.is_good());
    }

    #[test]
    fn a_closed_wait_is_bad_even_with_all_four_tiles_live() {
        // 24m waits on 3m only: one kind, so it fails the two-kinds half.
        let hand = tiles("123m567p789s22z24m");
        let quality = wait_quality(&hand, &HashMap::new());
        // 3m is the only winning kind, and the 123m run holds one of them.
        assert_eq!(quality.live_kinds, 1);
        assert_eq!(quality.live_tiles, 3);
        assert!(!quality.is_good());
    }

    #[test]
    fn a_yakuhai_hand_has_han_without_riichi() {
        // Dragon triplet: White dragon is a yaku even on a closed kanchan wait.
        let winning = tiles("123m567p555z22z24m3m");
        assert_eq!(
            han_without_riichi(&winning, parse_tile("3m"), Wind::East, Wind::South, &[],),
            1
        );
    }

    #[test]
    fn a_yaku_less_hand_scores_nothing_without_riichi() {
        // No yaku: no tanyao (123m), no pinfu (kanchan wait), no yakuhai.
        let winning = tiles("123m567p789s22z24m3m");
        assert_eq!(
            han_without_riichi(&winning, parse_tile("3m"), Wind::East, Wind::South, &[],),
            0
        );
    }

    #[test]
    fn the_worst_winning_tile_decides_condition_one() {
        // 34m waits 2m/5m. The hand has a dragon triplet, so both sides score;
        // adding a dora to the 5m side only must not fake a one-han floor.
        let tenpai = tiles("123m567p555z22z34m");
        let waits = vec![parse_tile("2m"), parse_tile("5m")];
        assert_eq!(
            min_han_without_riichi(&tenpai, &waits, Wind::East, Wind::South, &[]),
            1
        );
        // 4m indicator makes 5m dora; the 2m side still has only the dragon.
        let dora = vec![parse_tile("4m")];
        assert_eq!(
            min_han_without_riichi(&tenpai, &waits, Wind::East, Wind::South, &dora),
            1
        );
    }

    #[test]
    fn dealer_is_the_east_seat() {
        let tenpai = tiles("123m567p789s22z34m");
        let waits = vec![parse_tile("2m"), parse_tile("5m")];
        let visible = HashMap::new();

        let east = evaluate(&tenpai, &waits, Wind::South, Wind::East, &[], &visible);
        assert!(east.dealer);

        let south = evaluate(&tenpai, &waits, Wind::South, Wind::South, &[], &visible);
        assert!(!south.dealer);
    }
}
