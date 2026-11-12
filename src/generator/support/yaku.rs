//! Yaku enumeration over winning hands and over every tenpai discard.
//!
//! The ch. 5 yaku-pursuit lessons need more than a score: they need to know
//! *which* yaku a hand can claim. A sanshoku chase, for example, is only worth
//! the wait it gives up when the hand has no other yaku or dora (ch5:74), and
//! whether that is true can only be answered by walking every way the hand can
//! finish.
//!
//! [`winning_readings`] enumerates the yaku of one finished hand across all of
//! its standard decompositions. [`discard_lines`] walks a 14-tile hand: every
//! distinct discard that leaves tenpai, every winning tile of that tenpai, and
//! every yaku reading of each winning hand. That is the oracle a "which wait do
//! I choose?" drill needs, and it is built from the same `agari` shanten and
//! ukeire calls the rest of the generator uses, so the yaku oracle and the
//! acceptance counts cannot disagree.
//!
//! For 1-away hands that are one step from tenpai, the existing
//! [`super::completion`] module remains the wait-shape enumerator.

use agari::context::{GameContext, WinType, indicator_to_dora};
use agari::hand::{HandStructure, decompose_hand};
use agari::parse::to_counts;
use agari::shanten::{calculate_shanten, calculate_ukeire};
use agari::tile::Tile;
use agari::yaku::{Yaku, detect_yaku_with_context};

use super::analysis::wind_to_honor;
use crate::state::Wind;

/// One yaku reading of a finished hand.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct YakuReading {
    /// Every yaku the winning hand can claim in this decomposition.
    pub yaku: Vec<Yaku>,
    /// Dora in the hand, including the red-five bonus and ura if supplied.
    pub dora: u8,
}

impl YakuReading {
    /// True when this reading claims `yaku`.
    pub fn has(&self, yaku: Yaku) -> bool {
        self.yaku.contains(&yaku)
    }

    /// Yaku other than the pinfu / sanshoku pair this family compares.
    ///
    /// Tanyao and iipeiko are "other yaku" for ch. 5.1's gate; `Riichi` and
    /// `MenzenTsumo` never appear because the caller scores a ron hand with no
    /// declaration.
    pub fn other_yaku(&self) -> Vec<Yaku> {
        self.yaku
            .iter()
            .copied()
            .filter(|yaku| !matches!(yaku, Yaku::Pinfu | Yaku::SanshokuDoujun))
            .collect()
    }
}

/// One winning tile of a tenpai hand, with every yaku reading it can claim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TenpaiWin {
    pub wait: Tile,
    pub readings: Vec<YakuReading>,
}

impl TenpaiWin {
    /// True when any reading claims `yaku`.
    pub fn has(&self, yaku: Yaku) -> bool {
        self.readings.iter().any(|reading| reading.has(yaku))
    }
}

/// One discard that leaves the hand tenpai, with every winning tile.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscardLine {
    pub discard: Tile,
    pub wins: Vec<TenpaiWin>,
}

impl DiscardLine {
    /// True when any winning tile can claim `yaku`.
    pub fn has(&self, yaku: Yaku) -> bool {
        self.wins.iter().any(|win| win.has(yaku))
    }

    /// True when every winning tile can claim `yaku`.
    pub fn all_have(&self, yaku: Yaku) -> bool {
        !self.wins.is_empty() && self.wins.iter().all(|win| win.has(yaku))
    }

    /// The winning tiles, in acceptance order.
    pub fn waits(&self) -> Vec<Tile> {
        self.wins.iter().map(|win| win.wait).collect()
    }
}

/// Every yaku reading of one finished hand, across its standard decompositions.
///
/// Chiitoitsu and kokushi structures are skipped: the ch. 5 lessons this
/// supports build standard four-meld-one-pair hands.
pub fn winning_readings(
    winning_tiles: &[Tile],
    wait: Tile,
    round_wind: Wind,
    seat_wind: Wind,
    dora_indicators: &[Tile],
    aka_count: u8,
) -> Vec<YakuReading> {
    let counts = to_counts(winning_tiles);
    let context = GameContext::new(
        WinType::Ron,
        wind_to_honor(round_wind),
        wind_to_honor(seat_wind),
    )
    .with_winning_tile(wait)
    .with_dora(dora_indicators.to_vec())
    .with_aka(aka_count);

    decompose_hand(&counts)
        .iter()
        .filter(|structure| matches!(structure, HandStructure::Standard { .. }))
        .map(|structure| {
            let result = detect_yaku_with_context(structure, &counts, &context);
            YakuReading {
                yaku: result.yaku_list,
                dora: result.dora_count,
            }
        })
        .collect()
}

/// Every winning tile of a tenpai hand, with its yaku readings.
///
/// Returns an empty list when `tenpai` is not tenpai.
pub fn tenpai_wins(
    tenpai: &[Tile],
    round_wind: Wind,
    seat_wind: Wind,
    dora_indicators: &[Tile],
    aka_count: u8,
) -> Vec<TenpaiWin> {
    let counts = to_counts(tenpai);
    if calculate_shanten(&counts).shanten != 0 {
        return Vec::new();
    }

    calculate_ukeire(&counts)
        .tiles
        .into_iter()
        .map(|accepted| {
            let mut winning = tenpai.to_vec();
            winning.push(accepted.tile);
            TenpaiWin {
                wait: accepted.tile,
                readings: winning_readings(
                    &winning,
                    accepted.tile,
                    round_wind,
                    seat_wind,
                    dora_indicators,
                    aka_count,
                ),
            }
        })
        .collect()
}

/// Every distinct discard that leaves a 14-tile hand tenpai.
///
/// This is the completion enumerator for a "which tenpai wait?" decision: each
/// line carries the discard and every winning tile of the resulting tenpai,
/// with both sets of yaku readings. Discards that do not leave tenpai are
/// omitted.
pub fn discard_lines(
    tiles: &[Tile],
    round_wind: Wind,
    seat_wind: Wind,
    dora_indicators: &[Tile],
    aka_count: u8,
) -> Vec<DiscardLine> {
    let mut lines = Vec::new();
    let mut seen = Vec::new();

    for discard in tiles {
        if seen.contains(discard) {
            continue;
        }
        seen.push(*discard);

        let mut remaining = tiles.to_vec();
        let index = remaining
            .iter()
            .position(|tile| tile == discard)
            .expect("the discard came from the hand");
        remaining.remove(index);

        if calculate_shanten(&to_counts(&remaining)).shanten != 0 {
            continue;
        }

        lines.push(DiscardLine {
            discard: *discard,
            wins: tenpai_wins(
                &remaining,
                round_wind,
                seat_wind,
                dora_indicators,
                aka_count,
            ),
        });
    }

    lines
}

/// Dora in `tiles` for the given indicators.
pub fn dora_count(tiles: &[Tile], indicators: &[Tile]) -> u8 {
    indicators
        .iter()
        .map(|&indicator| {
            let dora = indicator_to_dora(indicator);
            tiles.iter().filter(|tile| **tile == dora).count() as u8
        })
        .sum()
}

/// Every yaku other than pinfu / sanshoku that appears in `wins`.
pub fn other_yaku(wins: &[TenpaiWin]) -> Vec<Yaku> {
    let mut out = Vec::new();
    for win in wins {
        for reading in &win.readings {
            for yaku in reading.other_yaku() {
                if !out.contains(&yaku) {
                    out.push(yaku);
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use agari::parse::parse_hand;

    fn tiles(hand: &str) -> Vec<Tile> {
        parse_hand(hand).expect("test hand must parse")
    }

    #[test]
    fn a_closed_wait_sanshoku_is_enumerated_without_pinfu() {
        // 345m 345p 345s 789s 11s, winning on the middle 4m.
        let winning = tiles("345m345p345s789s11s");
        let readings = winning_readings(&winning, tiles("4m")[0], Wind::East, Wind::South, &[], 0);

        assert!(
            readings
                .iter()
                .any(|reading| reading.has(Yaku::SanshokuDoujun)),
            "the hand is sanshoku"
        );
        assert!(
            readings.iter().all(|reading| !reading.has(Yaku::Pinfu)),
            "a closed 4m wait is not pinfu"
        );
    }

    #[test]
    fn a_side_wait_run_is_pinfu_and_not_sanshoku() {
        // 456m 345p 345s 789s 11s, winning on the end 4m of 456m.
        let winning = tiles("456m345p345s789s11s");
        let readings = winning_readings(&winning, tiles("4m")[0], Wind::East, Wind::South, &[], 0);

        assert!(
            readings.iter().any(|reading| reading.has(Yaku::Pinfu)),
            "the side wait is pinfu"
        );
        assert!(
            readings
                .iter()
                .all(|reading| !reading.has(Yaku::SanshokuDoujun)),
            "456m does not make 345 sanshoku"
        );
    }

    #[test]
    fn a_tanyao_hand_reports_the_extra_yaku() {
        // All simples, so both the side wait and the closed wait are tanyao.
        let winning = tiles("456m345p345s678s22s");
        let readings = winning_readings(&winning, tiles("4m")[0], Wind::East, Wind::South, &[], 0);

        assert!(readings.iter().any(|reading| reading.has(Yaku::Pinfu)));
        assert!(readings.iter().any(|reading| reading.has(Yaku::Tanyao)));
    }

    #[test]
    fn dora_is_counted_from_the_indicator() {
        let hand = tiles("123m456p789s11z");
        // 4m is dora when the indicator is 3m.
        let indicator = tiles("3m")[0];
        let mut with_four = hand.clone();
        with_four.push(tiles("4m")[0]);
        assert_eq!(dora_count(&hand, &[indicator]), 0);
        assert_eq!(dora_count(&with_four, &[indicator]), 1);
    }

    #[test]
    fn discard_lines_enumerate_the_book_floating_decision() {
        // 3m5m6m 345p 345s 789s 11s: discard 3m for the side wait, or 6m
        // for the closed-wait sanshoku.
        let hand = tiles("3m5m6m345p345s789s11s");
        let lines = discard_lines(&hand, Wind::East, Wind::South, &[], 0);

        let three = lines
            .iter()
            .find(|line| line.discard == tiles("3m")[0])
            .expect("discarding 3m leaves tenpai");
        let six = lines
            .iter()
            .find(|line| line.discard == tiles("6m")[0])
            .expect("discarding 6m leaves tenpai");

        assert!(three.all_have(Yaku::Pinfu));
        assert!(!three.has(Yaku::SanshokuDoujun));
        assert!(six.all_have(Yaku::SanshokuDoujun));
        assert!(!six.has(Yaku::Pinfu));
    }

    #[test]
    fn a_non_tenpai_hand_has_no_discard_lines() {
        let hand = tiles("123m789p22z13s79s");
        assert!(discard_lines(&hand, Wind::East, Wind::South, &[], 0).is_empty());
    }
}
