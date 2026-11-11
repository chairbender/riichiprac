//! Ron values for the ch. 7 high-scoring-hand lesson.
//!
//! The section measures a hand at "a tile that gives you the lowest possible
//! score" (ch7:598), so every winning tile of the wait is scored on its own and
//! the smallest result decides. Each tile is scored under its best yaku
//! reading, which is what a player would actually claim, and without Riichi or
//! ura dora: the declaration is exactly what the lesson is deciding, and the
//! ura indicator is hidden when the decision is made.
//!
//! Only ron matters here. A non-dealer's ron values are the ones the book's
//! 7700 and haneman thresholds name, and the lesson keeps the human off the
//! dealer seat.

use agari::context::{GameContext, WinType};
use agari::hand::{HandStructure, decompose_hand};
use agari::parse::to_counts;
use agari::scoring::calculate_score;
use agari::tile::Tile;
use agari::yaku::detect_yaku_with_context;

use crate::generator::support::analysis::wind_to_honor;
use crate::state::Wind;

/// The value of one winning tile without Riichi.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Value {
    /// Ron points the hand would collect from the discarder.
    pub points: u32,
    /// Total han, including dora and the red-five bonus.
    pub han: u8,
}

/// The best ron value a winning tile can produce without Riichi.
///
/// `None` when no decomposition has a yaku: ron is illegal on a hand with no
/// yaku, so the tile has no value at all.
pub(super) fn value_at(
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

/// The lowest ron value across every winning tile of the wait.
///
/// This is the book's "at least 7700 when winning on a tile that gives you the
/// lowest possible score" (ch7:598).
pub(super) fn worst_value(
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

#[cfg(test)]
mod tests {
    use super::*;

    use crate::generator::support::testing::parse_tile;

    fn tiles(hand: &str) -> Vec<Tile> {
        agari::parse::parse_hand(hand).expect("hand must parse")
    }

    /// The lesson's template: tanyao + pinfu + iipeikou, plus a dora pair.
    fn template() -> (Vec<Tile>, Vec<Tile>, Tile) {
        (
            tiles("234m234m345p66p34s"),
            vec![parse_tile("2s"), parse_tile("5s")],
            // 5p indicator makes 6p dora (the pair).
            parse_tile("5p"),
        )
    }

    #[test]
    fn a_plain_template_scores_7700_or_better_without_riichi() {
        let (tenpai, waits, indicator) = template();
        let value = worst_value(&tenpai, &waits, Wind::East, Wind::South, &[indicator], 0)
            .expect("the template must have a value");
        assert!(value.points >= 7_700, "template value was {}", value.points);
        assert_eq!(value.points, 8_000, "tanyao+pinfu+iipeikou+2 dora = mangan");
    }

    #[test]
    fn a_red_five_adds_a_han_to_the_dora_pair() {
        let (tenpai, waits, indicator) = template();
        let value = worst_value(&tenpai, &waits, Wind::East, Wind::South, &[indicator], 1)
            .expect("the template must have a value");
        assert_eq!(value.han, 6, "3 yaku + 2 dora + red five");
        assert_eq!(value.points, 12_000, "haneman ron for a non-dealer");
    }

    #[test]
    fn a_hand_with_no_yaku_has_no_ron_value() {
        // No yaku: terminals, a kanchan wait, and no dora.
        let tenpai = tiles("123m567p789s22z24m");
        let value = value_at(
            &tiles("123m567p789s22z24m3m"),
            parse_tile("3m"),
            Wind::East,
            Wind::South,
            &[],
            0,
        );
        assert_eq!(value, None);
        // A second wait on 3m would also be the only winning tile.
        assert_eq!(
            worst_value(
                &tenpai,
                &[parse_tile("3m")],
                Wind::East,
                Wind::South,
                &[],
                0
            ),
            None
        );
    }

    #[test]
    fn the_worst_side_of_the_wait_decides() {
        // 23m waits 1m/4m: 1m is a terminal, so the 1m side loses tanyao.
        let tenpai = tiles("234p234p66p234s23m");
        let waits = vec![parse_tile("1m"), parse_tile("4m")];
        let worst = worst_value(&tenpai, &waits, Wind::East, Wind::South, &[], 0)
            .expect("still a yaku on both sides");
        let four = value_at(
            &{
                let mut hand = tenpai.clone();
                hand.push(parse_tile("4m"));
                hand
            },
            parse_tile("4m"),
            Wind::East,
            Wind::South,
            &[],
            0,
        )
        .expect("the 4m side has a value");
        assert!(worst.points < four.points, "the worst side must be smaller");
    }
}
