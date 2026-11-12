//! Ron values for the open-quad (daiminkan) lesson.
//!
//! Riichi Book 1, ch. 9 measures its open-quad examples in points: "This ready
//! hand is currently worth 2000 points", "only increases from 1000 to 2600
//! points", and the condition itself is a band — "the hand is ready with a good
//! wait, and the hand value is between 2000 and 5200 points". So the lesson has
//! to score the hand it deals, twice:
//!
//! - **now** — the open chi'd hand with the fourth copy still in an opponent's
//!   river (three concealed copies of the quad tile); and
//! - **after the quad** — the same hand with those four tiles moved into an open
//!   kan meld, which is what the extra minipoints come from.
//!
//! Both values are read off `agari`'s scorer rather than assembled from a fu
//! table, so an imported report can recompute them. Only ron is scored: the
//! book's examples are ron values and the human is kept off the dealer seat.

use agari::context::{GameContext, WinType};
use agari::hand::{HandStructure, KanType, Meld, decompose_hand_with_melds};
use agari::parse::to_counts;
use agari::scoring::calculate_score;
use agari::tile::Tile;
use agari::yaku::detect_yaku_with_context;

use crate::generator::support::analysis::wind_to_honor;
use crate::state::Wind;

/// Points, han and fu of one winning tile's best ron reading.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct RonValue {
    /// What a non-dealer collects from the discarder.
    pub points: u32,
    /// Total han, including dora and the red-five bonus.
    pub han: u8,
    pub fu: u8,
}

/// One open hand whose fourth tile is offered as a quad.
pub(super) struct OpenQuadHand<'a> {
    /// The seven concealed tiles beside the three copies of [`Self::quad`].
    pub blocks: &'a [Tile],
    /// Lowest tile of the called run (the chi meld).
    pub open_run: Tile,
    /// The tile held three times, offered as the fourth copy.
    pub quad: Tile,
    /// Every winning tile of the ready hand.
    pub waits: &'a [Tile],
    pub round_wind: Wind,
    pub seat_wind: Wind,
    pub dora_indicators: &'a [Tile],
    pub aka: u8,
}

impl OpenQuadHand<'_> {
    /// The ready hand as it stands, the fourth copy still in a river.
    pub(super) fn current_value(&self) -> Option<RonValue> {
        self.worst_value(false)
    }

    /// The same wait once the fourth copy has joined an open kan.
    pub(super) fn quad_value(&self) -> Option<RonValue> {
        self.worst_value(true)
    }

    /// The lowest ron value across every winning tile.
    ///
    /// The book values the whole hand, so the worst side of a wait decides; a
    /// tile that cannot be won on at all makes the hand worthless.
    fn worst_value(&self, quad: bool) -> Option<RonValue> {
        let mut worst: Option<RonValue> = None;
        for &wait in self.waits {
            let value = self.value_at(wait, quad)?;
            worst = Some(match worst {
                Some(current) if current.points <= value.points => current,
                _ => value,
            });
        }
        worst
    }

    /// The best ron reading of one winning tile.
    fn value_at(&self, wait: Tile, quad: bool) -> Option<RonValue> {
        let mut concealed: Vec<Tile> = self.blocks.to_vec();
        if !quad {
            concealed.extend([self.quad; 3]);
        }
        concealed.push(wait);

        let melds = if quad {
            vec![
                Meld::shuntsu_open(self.open_run),
                Meld::kan(self.quad, KanType::Open),
            ]
        } else {
            vec![Meld::shuntsu_open(self.open_run)]
        };

        let counts = to_counts(&concealed);
        let mut scored: Vec<Tile> = concealed;
        for meld in &melds {
            scored.extend(meld_tiles(meld));
        }
        let full_counts = to_counts(&scored);
        let context = GameContext::new(
            WinType::Ron,
            wind_to_honor(self.round_wind),
            wind_to_honor(self.seat_wind),
        )
        .with_winning_tile(wait)
        .with_dora(self.dora_indicators.to_vec())
        .with_aka(self.aka)
        .open();

        decompose_hand_with_melds(&counts, &melds)
            .iter()
            .filter(|structure| matches!(structure, HandStructure::Standard { .. }))
            .filter_map(|structure| {
                let yaku = detect_yaku_with_context(structure, &full_counts, &context);
                if yaku.yaku_list.is_empty() {
                    // Dora alone is not a yaku: the hand cannot ron.
                    return None;
                }
                let score = calculate_score(structure, &yaku, &context);
                Some(RonValue {
                    points: score.payment.total,
                    han: score.han,
                    fu: score.fu.total,
                })
            })
            .max_by_key(|value| value.points)
    }
}

/// The concrete tiles a decomposition's called meld stands for.
fn meld_tiles(meld: &Meld) -> Vec<Tile> {
    match meld {
        Meld::Shuntsu(start, _) => match (start.suit(), start.value()) {
            (Some(suit), Some(value)) => (0..3)
                .map(|step| Tile::suited(suit, value + step))
                .collect(),
            _ => vec![*start; 3],
        },
        Meld::Koutsu(tile, _) => vec![*tile; 3],
        Meld::Kan(tile, _) => vec![*tile; 4],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use agari::tile::{Honor, Suit};

    use crate::generator::support::testing::parse_tile;

    /// The book's own box: chi 123p, 67m, 88p pair, 123s run, 中中中, dora 3s.
    fn book_hand() -> (Vec<Tile>, Tile, Vec<Tile>) {
        let blocks = vec![
            parse_tile("6m"),
            parse_tile("7m"),
            parse_tile("8p"),
            parse_tile("8p"),
            parse_tile("1s"),
            parse_tile("2s"),
            parse_tile("3s"),
        ];
        (
            blocks,
            parse_tile("1p"),
            vec![parse_tile("5m"), parse_tile("8m")],
        )
    }

    #[test]
    fn the_book_example_is_worth_two_thousand_before_the_quad() {
        let (blocks, open_run, waits) = book_hand();
        // The 2s indicator makes 3s dora: the hand holds exactly one.
        let indicators = [parse_tile("2s")];
        let hand = OpenQuadHand {
            blocks: &blocks,
            open_run,
            quad: Tile::honor(Honor::Red),
            waits: &waits,
            round_wind: Wind::East,
            seat_wind: Wind::South,
            dora_indicators: &indicators,
            aka: 0,
        };

        let current = hand.current_value().expect("the hand must have a value");
        assert_eq!(current.han, 2, "chun plus one dora");
        assert_eq!(current.fu, 30, "open hand, concealed honor triplet");
        assert_eq!(current.points, 2_000, "the book's 2000-point hand");

        let quad = hand.quad_value().expect("the quad line must have a value");
        assert_eq!(quad.han, 2);
        assert_eq!(quad.fu, 40, "the open honor kan replaces the triplet");
        assert_eq!(
            quad.points, 2_600,
            "the quad's minipoints, before any new dora"
        );
    }

    #[test]
    fn the_cheap_hand_only_scores_one_han() {
        let (blocks, open_run, waits) = book_hand();
        // No dora in the hand: the 5p indicator makes 6p dora, which it lacks.
        let indicators = [parse_tile("5p")];
        let hand = OpenQuadHand {
            blocks: &blocks,
            open_run,
            quad: Tile::honor(Honor::Red),
            waits: &waits,
            round_wind: Wind::East,
            seat_wind: Wind::South,
            dora_indicators: &indicators,
            aka: 0,
        };

        let current = hand.current_value().expect("the hand must have a value");
        assert_eq!(current.han, 1);
        assert_eq!(current.points, 1_000, "the book's 1000-point hand");
        assert_eq!(
            hand.quad_value().expect("quad value").points,
            1_300,
            "1000 -> 1300 is the book's 'only increases' arithmetic"
        );
    }

    #[test]
    fn a_closed_wait_adds_fu_without_changing_the_band() {
        let blocks = vec![
            parse_tile("8m"),
            parse_tile("9m"),
            parse_tile("8p"),
            parse_tile("8p"),
            parse_tile("1s"),
            parse_tile("2s"),
            parse_tile("3s"),
        ];
        // 89m waits on 7m only: an edge wait, worth +2 fu.
        let waits = [parse_tile("7m")];
        let indicators = [parse_tile("2s")];
        let hand = OpenQuadHand {
            blocks: &blocks,
            open_run: parse_tile("1p"),
            quad: Tile::honor(Honor::White),
            waits: &waits,
            round_wind: Wind::East,
            seat_wind: Wind::North,
            dora_indicators: &indicators,
            aka: 0,
        };
        let value = hand.current_value().expect("value");
        assert_eq!(value.han, 2);
        assert_eq!(value.fu, 30, "28 fu from the wait rounds up to 30");
        assert_eq!(value.points, 2_000);
    }

    #[test]
    fn meld_tiles_spell_out_the_run() {
        let start = Tile::suited(Suit::Sou, 7);
        assert_eq!(
            meld_tiles(&Meld::shuntsu_open(start)),
            vec![
                Tile::suited(Suit::Sou, 7),
                Tile::suited(Suit::Sou, 8),
                Tile::suited(Suit::Sou, 9)
            ]
        );
    }
}
