//! Starting conditions for the AI hotseat scenario.
//!
//! Every field is optional: a missing field (or JSON `null`) is drawn at
//! generation time, and a set field pins the starting table. The frontend's
//! generation card sends the same shape, with `null` for each option the player
//! marked "Random".

use serde::{Deserialize, Serialize};

use crate::rng::{gen_range, shuffle};
use crate::state::Wind;

/// The round the Mortal self-play starts in.
///
/// The book's own progression is East 1-4, then South 1-4; the card exposes all
/// eight cells, unlike the generic generators that stop at South 2.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum HotseatRound {
    #[serde(rename = "east_1")]
    East1,
    #[serde(rename = "east_2")]
    East2,
    #[serde(rename = "east_3")]
    East3,
    #[serde(rename = "east_4")]
    East4,
    #[serde(rename = "south_1")]
    South1,
    #[serde(rename = "south_2")]
    South2,
    #[serde(rename = "south_3")]
    South3,
    #[serde(rename = "south_4")]
    South4,
}

impl HotseatRound {
    pub const ALL: [HotseatRound; 8] = [
        HotseatRound::East1,
        HotseatRound::East2,
        HotseatRound::East3,
        HotseatRound::East4,
        HotseatRound::South1,
        HotseatRound::South2,
        HotseatRound::South3,
        HotseatRound::South4,
    ];

    /// Round wind and one-based hand number.
    pub fn parts(self) -> (Wind, u8) {
        match self {
            HotseatRound::East1 => (Wind::East, 1),
            HotseatRound::East2 => (Wind::East, 2),
            HotseatRound::East3 => (Wind::East, 3),
            HotseatRound::East4 => (Wind::East, 4),
            HotseatRound::South1 => (Wind::South, 1),
            HotseatRound::South2 => (Wind::South, 2),
            HotseatRound::South3 => (Wind::South, 3),
            HotseatRound::South4 => (Wind::South, 4),
        }
    }

    /// Human-readable label for the generation card.
    pub fn label(self) -> &'static str {
        match self {
            HotseatRound::East1 => "East 1",
            HotseatRound::East2 => "East 2",
            HotseatRound::East3 => "East 3",
            HotseatRound::East4 => "East 4",
            HotseatRound::South1 => "South 1",
            HotseatRound::South2 => "South 2",
            HotseatRound::South3 => "South 3",
            HotseatRound::South4 => "South 4",
        }
    }

    fn random() -> Self {
        Self::ALL[gen_range(0, Self::ALL.len())]
    }
}

/// The seat wind the inserted player occupies.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HotseatSeat {
    East,
    South,
    West,
    North,
}

impl HotseatSeat {
    pub const ALL: [HotseatSeat; 4] = [
        HotseatSeat::East,
        HotseatSeat::South,
        HotseatSeat::West,
        HotseatSeat::North,
    ];

    pub fn wind(self) -> Wind {
        match self {
            HotseatSeat::East => Wind::East,
            HotseatSeat::South => Wind::South,
            HotseatSeat::West => Wind::West,
            HotseatSeat::North => Wind::North,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            HotseatSeat::East => "East",
            HotseatSeat::South => "South",
            HotseatSeat::West => "West",
            HotseatSeat::North => "North",
        }
    }

    fn random() -> Self {
        Self::ALL[gen_range(0, Self::ALL.len())]
    }
}

/// How the inserted player stands against the other three seats at the deal.
///
/// The nine cells are the ones the task's generation card lists. Each cell is a
/// fixed score pattern by finishing position; the inserted player takes the
/// position named by [`Disparity::player_rank`] and the other three ranks are
/// shuffled onto the remaining seats. The patterns sum to 100,000.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Disparity {
    /// Last, with a large gap to the player above.
    LosingBadlyAlone,
    /// Last, but third is near; first and second are far ahead of both.
    LosingBadlyWithThird,
    /// Second of a close top three, with a clear gap to fourth.
    AboutEqualWithTwo,
    /// Second, a long way behind first.
    OneBigGapToFirst,
    /// All four seats within a thousand points.
    AboutEqualAll,
    /// Level with one other player, with a gap to both remaining seats.
    AboutEqualBetweenTwo,
    /// Third, a long way ahead of fourth.
    LargeGapToFourth,
    /// Third of a close top three, with fourth well behind.
    AboutEqualWithFirstAndSecond,
    /// First by a large gap.
    InFirstByLargeGap,
}

impl Disparity {
    pub const ALL: [Disparity; 9] = [
        Disparity::LosingBadlyAlone,
        Disparity::LosingBadlyWithThird,
        Disparity::AboutEqualWithTwo,
        Disparity::OneBigGapToFirst,
        Disparity::AboutEqualAll,
        Disparity::AboutEqualBetweenTwo,
        Disparity::LargeGapToFourth,
        Disparity::AboutEqualWithFirstAndSecond,
        Disparity::InFirstByLargeGap,
    ];

    /// The inserted player's zero-based finish position (0 = first).
    pub fn player_rank(self) -> usize {
        match self {
            Disparity::LosingBadlyAlone | Disparity::LosingBadlyWithThird => 3,
            Disparity::AboutEqualWithTwo
            | Disparity::OneBigGapToFirst
            | Disparity::AboutEqualAll
            | Disparity::AboutEqualBetweenTwo => 1,
            Disparity::LargeGapToFourth | Disparity::AboutEqualWithFirstAndSecond => 2,
            Disparity::InFirstByLargeGap => 0,
        }
    }

    /// Scores by finish position (1st, 2nd, 3rd, 4th); they sum to 100,000.
    pub fn pattern(self) -> [i32; 4] {
        match self {
            Disparity::LosingBadlyAlone => [38_000, 30_000, 22_000, 10_000],
            Disparity::LosingBadlyWithThird => [34_000, 32_000, 18_000, 16_000],
            Disparity::AboutEqualWithTwo => [29_000, 28_000, 27_000, 16_000],
            Disparity::OneBigGapToFirst => [40_000, 27_000, 17_000, 16_000],
            Disparity::AboutEqualAll => [25_500, 25_000, 24_800, 24_700],
            Disparity::AboutEqualBetweenTwo => [30_000, 29_000, 21_000, 20_000],
            Disparity::LargeGapToFourth => [36_000, 30_000, 24_000, 10_000],
            Disparity::AboutEqualWithFirstAndSecond => [30_000, 29_000, 28_000, 13_000],
            Disparity::InFirstByLargeGap => [40_000, 28_000, 17_000, 15_000],
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Disparity::LosingBadlyAlone => "losing badly on your own",
            Disparity::LosingBadlyWithThird => "losing badly with third",
            Disparity::AboutEqualWithTwo => "level with two others",
            Disparity::OneBigGapToFirst => "one big gap to first",
            Disparity::AboutEqualAll => "level with all four",
            Disparity::AboutEqualBetweenTwo => "level with one other",
            Disparity::LargeGapToFourth => "a large gap to fourth",
            Disparity::AboutEqualWithFirstAndSecond => "level with first and second",
            Disparity::InFirstByLargeGap => "first by a large gap",
        }
    }

    /// Concrete scores indexed by seat wind, with `player` holding the cell's
    /// named position.
    pub fn scores_for(self, player: usize) -> [i32; 4] {
        let pattern = self.pattern();
        let rank = self.player_rank();
        let mut other_seats: Vec<usize> = (0..4).filter(|&seat| seat != player).collect();
        let mut other_scores: Vec<i32> = pattern
            .iter()
            .enumerate()
            .filter(|(index, _)| *index != rank)
            .map(|(_, score)| *score)
            .collect();
        shuffle(&mut other_seats);
        shuffle(&mut other_scores);

        let mut scores = [0i32; 4];
        scores[player] = pattern[rank];
        for (seat, score) in other_seats.into_iter().zip(other_scores) {
            scores[seat] = score;
        }
        scores
    }

    fn random() -> Self {
        Self::ALL[gen_range(0, Self::ALL.len())]
    }
}

/// The starting conditions chosen on the generation card.
///
/// `None` means "random": the generator draws that field when the hand starts.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HotseatOptions {
    #[serde(default)]
    pub round: Option<HotseatRound>,
    #[serde(default)]
    pub disparity: Option<Disparity>,
    #[serde(default)]
    pub seat: Option<HotseatSeat>,
}

impl HotseatOptions {
    /// Parse the card's JSON. Empty input means every option is random.
    pub fn from_json(json: &str) -> Result<Self, String> {
        if json.trim().is_empty() {
            return Ok(Self::default());
        }
        serde_json::from_str(json).map_err(|err| format!("invalid hotseat options JSON: {err}"))
    }

    /// Fill every unset field with a random draw.
    pub fn resolve(self) -> StartingConditions {
        StartingConditions {
            round: self.round.unwrap_or_else(HotseatRound::random),
            disparity: self.disparity.unwrap_or_else(Disparity::random),
            seat: self.seat.unwrap_or_else(HotseatSeat::random),
        }
    }
}

/// Every option resolved to a concrete value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StartingConditions {
    pub round: HotseatRound,
    pub disparity: Disparity,
    pub seat: HotseatSeat,
}

impl StartingConditions {
    /// The one-line note shown above the table. It names the starting
    /// conditions the hand was played from, never the decision's answer.
    pub fn note(self) -> String {
        format!(
            "Mortal self-play from {}: you are {}, {}.",
            self.round.label(),
            self.seat.label(),
            self.disparity.label()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_round_has_a_distinct_wind_and_hand_number() {
        let mut seen = Vec::new();
        for round in HotseatRound::ALL {
            let (wind, hand) = round.parts();
            assert!((1..=4).contains(&hand));
            assert!(matches!(wind, Wind::East | Wind::South));
            assert!(seen.iter().all(|other| other != &(wind, hand)));
            seen.push((wind, hand));
        }
        assert_eq!(seen.len(), 8);
    }

    #[test]
    fn every_disparity_pattern_sums_to_one_hundred_thousand() {
        for disparity in Disparity::ALL {
            let pattern = disparity.pattern();
            assert_eq!(
                pattern.iter().sum::<i32>(),
                100_000,
                "{} = {pattern:?}",
                disparity.label()
            );
            assert!(
                pattern.windows(2).all(|pair| pair[0] >= pair[1]),
                "{} pattern is not ordered: {pattern:?}",
                disparity.label()
            );
        }
    }

    #[test]
    fn scores_put_the_player_in_the_named_position() {
        for disparity in Disparity::ALL {
            for player in 0..4 {
                let scores = disparity.scores_for(player);
                assert_eq!(scores.iter().sum::<i32>(), 100_000);
                let player_score = scores[player];
                let rank = scores.iter().filter(|&&score| score > player_score).count();
                assert_eq!(
                    rank,
                    disparity.player_rank(),
                    "{} at seat {player}: {scores:?}",
                    disparity.label()
                );
            }
        }
    }

    #[test]
    fn options_deserialize_the_card_shape_and_default_to_random() {
        let pinned: HotseatOptions = serde_json::from_str(
            r#"{"round":"south_3","disparity":"in_first_by_large_gap","seat":"west"}"#,
        )
        .expect("card shape parses");
        assert_eq!(pinned.round, Some(HotseatRound::South3));
        assert_eq!(pinned.disparity, Some(Disparity::InFirstByLargeGap));
        assert_eq!(pinned.seat, Some(HotseatSeat::West));

        let random: HotseatOptions =
            serde_json::from_str(r#"{"round":null,"disparity":null,"seat":null}"#)
                .expect("nulls parse");
        assert_eq!(random, HotseatOptions::default());

        assert_eq!(
            HotseatOptions::from_json("").unwrap(),
            HotseatOptions::default()
        );
        assert_eq!(
            HotseatOptions::from_json("{}").unwrap(),
            HotseatOptions::default()
        );
        assert!(HotseatOptions::from_json("{not json").is_err());
    }

    #[test]
    fn resolved_conditions_are_always_concrete() {
        for _ in 0..100 {
            let conditions = HotseatOptions::default().resolve();
            let (wind, hand) = conditions.round.parts();
            assert!((1..=4).contains(&hand));
            assert!(matches!(wind, Wind::East | Wind::South));
            assert!(Disparity::ALL.contains(&conditions.disparity));
            assert!(HotseatSeat::ALL.contains(&conditions.seat));
        }
    }

    #[test]
    fn the_note_names_the_starting_conditions_not_the_answer() {
        let note = StartingConditions {
            round: HotseatRound::South2,
            disparity: Disparity::LosingBadlyAlone,
            seat: HotseatSeat::North,
        }
        .note();
        assert!(note.contains("South 2"));
        assert!(note.contains("North"));
        assert!(note.contains("losing badly"));
        assert!(!note.contains("discard"));
        assert!(!note.contains("Riichi"));
    }
}
