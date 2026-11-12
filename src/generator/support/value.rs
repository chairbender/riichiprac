//! Ron values without Riichi: the shared scoring walk behind the ch. 7
//! "high scoring hand" lesson and ch. 8's push/fold value condition.
//!
//! Ch. 7 measures a hand at "a tile that gives you the lowest possible score"
//! (ch7:598), so a wait is scored tile by tile and the smallest result decides.
//! Each winning tile is scored under its best yaku reading, which is what a
//! player would actually claim, and without Riichi or ura dora: the
//! declaration is exactly what the lessons deciding it are asking about, and
//! the ura indicator is hidden when the decision is made.
//!
//! Only ron matters. A non-dealer's ron values are the ones the book's 7700 and
//! mangan thresholds name, and the lessons keep the human off the dealer seat.

use agari::context::{GameContext, WinType};
use agari::hand::{HandStructure, decompose_hand};
use agari::parse::to_counts;
use agari::scoring::calculate_score;
use agari::tile::Tile;
use agari::yaku::detect_yaku_with_context;

use crate::generator::support::analysis::wind_to_honor;
use crate::generator::support::completion::completion_lines;
use crate::state::Wind;

/// The value of one winning tile without Riichi.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Value {
    /// Ron points the hand would collect from the discarder.
    pub points: u32,
    /// Total han, including dora and the red-five bonus.
    pub han: u8,
}

impl Value {
    /// True when the value reaches the book's "high scoring hand" floor.
    ///
    /// Riichi Book 1, ch. 8, "Three conditions to push/fold": "We say a hand is
    /// a high scoring one if the minimum hand value is 7700" (ch8:65).
    pub fn is_high_scoring(self) -> bool {
        self.points >= 7_700
    }
}

/// The best ron value a winning tile can produce without Riichi.
///
/// `None` when no decomposition has a yaku: ron is illegal on a hand with no
/// yaku, so the tile has no value at all.
pub fn value_at(
    winning_tiles: &[Tile],
    wait: Tile,
    round_wind: Wind,
    seat_wind: Wind,
    dora_indicators: &[Tile],
    aka_count: u8,
) -> Option<Value> {
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
        .filter_map(|structure| {
            let yaku = detect_yaku_with_context(structure, &counts, &context);
            if yaku.yaku_list.is_empty() {
                // Dora alone is not a yaku: the hand cannot ron.
                return None;
            }
            let score = calculate_score(structure, &yaku, &context);
            Some(Value {
                points: score.payment.total,
                han: score.han,
            })
        })
        .max_by_key(|value| value.points)
}

/// The lowest ron value across every winning tile of one wait.
pub fn worst_value(
    tenpai_tiles: &[Tile],
    wait_tiles: &[Tile],
    round_wind: Wind,
    seat_wind: Wind,
    dora_indicators: &[Tile],
    aka_count: u8,
) -> Option<Value> {
    let mut worst: Option<Value> = None;
    for &wait in wait_tiles {
        let mut winning_tiles = tenpai_tiles.to_vec();
        winning_tiles.push(wait);
        let value = value_at(
            &winning_tiles,
            wait,
            round_wind,
            seat_wind,
            dora_indicators,
            aka_count,
        )?;
        worst = Some(match worst {
            Some(current) if current.points <= value.points => current,
            _ => value,
        });
    }
    worst
}

/// The worst hand this 1-away shape can end up with.
///
/// Enumerates every way the hand can become ready ([`completion_lines`]), scores
/// every winning tile of every resulting wait, and keeps the smallest value.
/// `None` means at least one completion produces a hand with no yaku at all (or
/// the hand is not 1-away), which is the lowest possible value.
///
/// Riichi Book 1, ch. 8, "Three conditions to push/fold", judges a 1-away
/// hand's value this way: the score that decides is "the minimum hand value"
/// (ch8:65), not the best one.
pub fn worst_completion_value(
    one_away_tiles: &[Tile],
    round_wind: Wind,
    seat_wind: Wind,
    dora_indicators: &[Tile],
    aka_count: u8,
) -> Option<Value> {
    let lines = completion_lines(one_away_tiles);
    if lines.is_empty() {
        return None;
    }

    let mut worst: Option<Value> = None;
    for line in lines {
        let mut drawn = one_away_tiles.to_vec();
        drawn.push(line.draw);
        let Some(index) = drawn.iter().position(|tile| *tile == line.discard) else {
            continue;
        };
        drawn.remove(index);

        let value = worst_value(
            &drawn,
            &line.waits,
            round_wind,
            seat_wind,
            dora_indicators,
            aka_count,
        )?;
        worst = Some(match worst {
            Some(current) if current.points <= value.points => current,
            _ => value,
        });
    }

    worst
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::generator::support::testing::parse_tile;

    fn tiles(hand: &str) -> Vec<Tile> {
        agari::parse::parse_hand(hand).expect("hand must parse")
    }

    #[test]
    fn a_hand_with_no_yaku_has_no_ron_value() {
        let value = value_at(
            &tiles("123m567p789s22z24m3m"),
            parse_tile("3m"),
            Wind::East,
            Wind::South,
            &[],
            0,
        );
        assert_eq!(value, None);
    }

    #[test]
    fn a_1_away_hand_whose_completions_have_no_yaku_has_no_minimum_value() {
        // Terminals break tanyao, and the closed waits break pinfu.
        let hand = tiles("123m789p22z13s79s");
        assert_eq!(
            worst_completion_value(&hand, Wind::East, Wind::South, &[], 0),
            None
        );
    }

    #[test]
    fn a_1_away_hand_with_a_guaranteed_yaku_has_a_minimum_value() {
        // A concealed dragon triplet cannot be rearranged into runs, so every
        // completion keeps the yakuhai and all three dora.
        let hand = tiles("234m555z34s67s88m2z");
        let value = worst_completion_value(&hand, Wind::East, Wind::South, &[parse_tile("7z")], 0)
            .expect("every completion keeps the dragon triplet");
        assert!(
            value.is_high_scoring(),
            "the minimum value was only {}",
            value.points
        );
        assert_eq!(value.han, 4, "one yakuhai han plus three dora");
    }
}
