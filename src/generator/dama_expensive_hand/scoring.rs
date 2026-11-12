//! Ron values for the ch. 7 high-scoring-hand lesson.
//!
//! The section measures a hand at "a tile that gives you the lowest possible
//! score" (ch7:598), so every winning tile of the wait is scored on its own and
//! the smallest result decides. The implementation lives in
//! [`crate::generator::support::value`], because ch. 8's push/fold lesson scores
//! a 1-away hand's completions the same way.
//!
//! Only ron matters here. A non-dealer's ron values are the ones the book's
//! 7700 and haneman thresholds name, and the lesson keeps the human off the
//! dealer seat.

pub(super) use crate::generator::support::value::worst_value;

#[cfg(test)]
mod tests {
    use super::*;

    use agari::tile::Tile;

    use crate::generator::support::testing::parse_tile;
    use crate::generator::support::value::value_at;
    use crate::state::Wind;

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
