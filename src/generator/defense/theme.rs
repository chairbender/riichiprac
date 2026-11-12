//! Board patterns for the pure-defense lessons.
//!
//! Each plan is a small constructive skeleton: one answer tile plus the tiles
//! the threat (and the other two opponents) must have on the table for the
//! book's chart to say what the theme promises. The random fill and the
//! rejection sampling in `board` do the rest.
//!
//! Suji deniers are always planted inside the threat's first
//! [`crate::safety::EARLY_TURN_LIMIT`] discards: the book's reliable suji read
//! is the suji of an early discard, while a suji tile of the declaration
//! discard is as dangerous as a non-suji tile.
//!
//! `plan_suji_kabe` builds the second fold mode: the answer is a suji or
//! no-chance tile, the hand also holds a runner-up one chart row worse, and
//! the answer sits inside a block (a pair, a set, or a protorun) so the
//! discard visibly breaks the hand up. Riichi Book 1, ch. 8's ranking table
//! (`tbl:safety`) is the oracle for both rows.

use agari::tile::{Honor, Suit, Tile};

use crate::rng::{choose, gen_range};

/// One safety-chart row the board is built to teach.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SafetyTheme {
    /// A tile in the threat's river: 100%.
    Genbutsu,
    /// A 1/9 that is suji of the threat's 4/6 discard.
    SujiTerminal,
    /// A 2/8 (or 3/7) that is suji of the threat's 5/6 discard.
    SujiSimple,
    /// A 4/5/6 with both ends in the threat's river: suji 4-5-6.
    SujiMiddle,
    /// A tile whose every side wait is denied by a full blockade.
    NoChance,
    /// An honor ranked by how many copies are visible.
    HonorCount,
    /// A non-suji terminal, the chart's best non-suji row.
    NonSuji,
}

impl SafetyTheme {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            SafetyTheme::Genbutsu => "genbutsu",
            SafetyTheme::SujiTerminal => "suji_terminal",
            SafetyTheme::SujiSimple => "suji_simple",
            SafetyTheme::SujiMiddle => "suji_middle",
            SafetyTheme::NoChance => "no_chance",
            SafetyTheme::HonorCount => "honor_count",
            SafetyTheme::NonSuji => "non_suji",
        }
    }
}

/// A hand-independent plan for one defense board.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ThemePlan {
    pub theme: SafetyTheme,
    /// The tile the learner must discard.
    pub answer: Tile,
    /// Extra copies of the answer held in the concealed hand, beyond the draw.
    ///
    /// 0 leaves the draw as the only copy, 1 makes a pair and 2 a triplet. The
    /// suji-terminal ranks are set by how many copies are visible, so the
    /// pair/triplet variants teach the AA- and AA rows.
    pub answer_concealed: u8,
    /// Discards the threat must make, in river order. All of them land inside
    /// the book's "early" turns.
    pub threat_discards: Vec<Tile>,
    /// Visible copies placed outside the threat's river — the other players'
    /// rivers and the dora indicator — to build blockades and honor counts.
    pub extra_visible: Vec<Tile>,
    /// Tiles the threat may not discard at random. Keeping the answer out of
    /// their river is what stops a random draw from turning it into genbutsu;
    /// keeping its suji deniers out stops the same for a suji theme.
    pub threat_avoid: Vec<Tile>,
    /// A tile one chart row *worse* than the answer that the hand holds. Only
    /// the ranking lesson needs it: it makes the runner-up exact instead of
    /// merely "some worse tile".
    pub runner_up: Option<RunnerUp>,
    /// Tiles no random river or dora indicator may contain.
    ///
    /// The ranking lesson needs the answer's and runner-up's visible counts to
    /// stay exactly what the plan placed, because those counts decide the
    /// suji-terminal and honor rows. Empty for the other lessons.
    pub all_avoid: Vec<Tile>,
}

/// The hand's second-best tile on the chart, and how many copies it holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct RunnerUp {
    pub tile: Tile,
    pub copies: u8,
}

impl ThemePlan {
    /// A chart lesson with no ranking bits.
    fn chart(
        theme: SafetyTheme,
        answer: Tile,
        threat_discards: Vec<Tile>,
        extra_visible: Vec<Tile>,
        threat_avoid: Vec<Tile>,
    ) -> Self {
        Self {
            theme,
            answer,
            answer_concealed: 0,
            threat_discards,
            extra_visible,
            threat_avoid,
            runner_up: None,
            all_avoid: Vec::new(),
        }
    }

    /// The ranking mode's plan: an exact answer row plus one row below it.
    fn ranking(
        theme: SafetyTheme,
        answer: Tile,
        answer_concealed: u8,
        threat_discards: Vec<Tile>,
        extra_visible: Vec<Tile>,
        runner_up: RunnerUp,
        all_avoid: Vec<Tile>,
    ) -> Self {
        let mut avoid = all_avoid;
        avoid.push(answer);
        avoid.push(runner_up.tile);
        avoid.sort();
        avoid.dedup();

        Self {
            theme,
            answer,
            answer_concealed,
            threat_discards,
            extra_visible,
            threat_avoid: avoid.clone(),
            runner_up: Some(runner_up),
            all_avoid: avoid,
        }
    }
}

/// A random safety-chart lesson.
pub(super) fn plan_safety() -> Result<ThemePlan, String> {
    let suit = random_suit()?;

    match gen_range(0, 7) {
        0 => {
            let value = gen_range(1, 10) as u8;
            let answer = Tile::suited(suit, value);
            Ok(ThemePlan::chart(
                SafetyTheme::Genbutsu,
                answer,
                vec![answer],
                Vec::new(),
                Vec::new(),
            ))
        }
        1 => {
            let middle = choose(&[4u8, 5, 6]).ok_or("no suji middle")?;
            let value = if gen_range(0, 2) == 0 {
                middle - 3
            } else {
                middle + 3
            };
            let answer = Tile::suited(suit, value);
            Ok(ThemePlan::chart(
                SafetyTheme::SujiTerminal,
                answer,
                vec![Tile::suited(suit, middle)],
                Vec::new(),
                vec![answer],
            ))
        }
        2 => {
            let (value, middle) =
                choose(&[(2u8, 5u8), (8, 5), (3, 6), (7, 6)]).ok_or("no suji simple")?;
            let answer = Tile::suited(suit, value);
            Ok(ThemePlan::chart(
                SafetyTheme::SujiSimple,
                answer,
                vec![Tile::suited(suit, middle)],
                Vec::new(),
                vec![answer],
            ))
        }
        3 => {
            let (value, ends) =
                choose(&[(4u8, [1u8, 7u8]), (5, [2, 8]), (6, [3, 9])]).ok_or("no suji middle")?;
            let answer = Tile::suited(suit, value);
            Ok(ThemePlan::chart(
                SafetyTheme::SujiMiddle,
                answer,
                ends.iter().map(|&end| Tile::suited(suit, end)).collect(),
                Vec::new(),
                vec![answer],
            ))
        }
        4 => {
            // A terminal is no chance when the tile next to it is blockaded:
            // 1m needs a 2-3 protorun, so four visible 2m deny every 1-4 wait.
            let (value, blockade) = if gen_range(0, 2) == 0 {
                (1u8, 2u8)
            } else {
                (9, 8)
            };
            let blockade = Tile::suited(suit, blockade);
            let answer = Tile::suited(suit, value);
            Ok(ThemePlan::chart(
                SafetyTheme::NoChance,
                answer,
                Vec::new(),
                vec![blockade; 4],
                vec![answer],
            ))
        }
        5 => {
            let honor = random_honor()?;
            let copies = gen_range(1, 4);

            Ok(ThemePlan::chart(
                SafetyTheme::HonorCount,
                honor,
                Vec::new(),
                vec![honor; copies],
                vec![honor],
            ))
        }
        _ => {
            let value = if gen_range(0, 2) == 0 { 1 } else { 9 };
            let answer = Tile::suited(suit, value);
            // The denier is the tile that would make this terminal suji.
            let denier = if value == 1 { 4 } else { 6 };
            Ok(ThemePlan::chart(
                SafetyTheme::NonSuji,
                answer,
                Vec::new(),
                Vec::new(),
                vec![answer, Tile::suited(suit, denier)],
            ))
        }
    }
}

/// The fallback lesson: no tile is safe, so break up the pair instead.
///
/// The answer is a terminal (Rank CC, the best row that is still "not
/// identified safe") that the learner holds twice. The threat discarded a tile
/// from every protorun that could wait for it early, so the book's "outside
/// early discards" note also applies.
pub(super) fn plan_stuck() -> Result<ThemePlan, String> {
    let suit = random_suit()?;
    let value = if gen_range(0, 2) == 0 { 1u8 } else { 9 };
    let protector = match value {
        1 => choose(&[2u8, 3]).ok_or("no protector")?,
        _ => choose(&[7u8, 8]).ok_or("no protector")?,
    };

    let answer = Tile::suited(suit, value);
    let denier = if value == 1 { 4 } else { 6 };

    Ok(ThemePlan::chart(
        SafetyTheme::NonSuji,
        answer,
        vec![Tile::suited(suit, protector)],
        Vec::new(),
        vec![answer, Tile::suited(suit, denier)],
    ))
}

/// One board for the suji/no-chance ranking lesson.
///
/// Riichi Book 1, ch. 8, `tbl:safety`: the answer is a suji or no-chance tile,
/// and the hand also holds a tile exactly one row worse. The variants cover the
/// rows the book derives: the suji-terminal rows (`A+`, `AA-`, `AA`), the
/// middle `BBB` row, `BB+`, and `BB-` with the `B` row as its runner-up.
pub(super) fn plan_suji_kabe() -> Result<ThemePlan, String> {
    let suit = random_suit()?;

    match gen_range(0, 7) {
        // A+: a single suji terminal. The next row down is A, the second copy
        // of an honor, so the hand holds a dragon pair.
        0 => {
            let (value, denier) = if gen_range(0, 2) == 0 {
                (1u8, 4u8)
            } else {
                (9, 6)
            };
            let answer = Tile::suited(suit, value);
            let runner_up = random_dragon()?;

            Ok(ThemePlan::ranking(
                SafetyTheme::SujiTerminal,
                answer,
                0,
                vec![Tile::suited(suit, denier)],
                Vec::new(),
                RunnerUp {
                    tile: runner_up,
                    copies: 2,
                },
                Vec::new(),
            ))
        }
        // AA-: a pair of suji terminals makes two copies visible. The runner-up
        // is the other terminal, whose single copy is the A+ row.
        1 => {
            let (value, denier, other, other_denier) = if gen_range(0, 2) == 0 {
                (1u8, 4u8, 9u8, 6u8)
            } else {
                (9, 6, 1, 4)
            };
            let answer = Tile::suited(suit, value);

            Ok(ThemePlan::ranking(
                SafetyTheme::SujiTerminal,
                answer,
                1,
                vec![Tile::suited(suit, denier), Tile::suited(suit, other_denier)],
                Vec::new(),
                RunnerUp {
                    tile: Tile::suited(suit, other),
                    copies: 1,
                },
                Vec::new(),
            ))
        }
        // AA: three copies of the answer are visible. The runner-up is a pair
        // of the other terminal, which is the AA- row.
        2 => {
            let (value, denier, other, other_denier) = if gen_range(0, 2) == 0 {
                (1u8, 4u8, 9u8, 6u8)
            } else {
                (9, 6, 1, 4)
            };
            let answer = Tile::suited(suit, value);

            Ok(ThemePlan::ranking(
                SafetyTheme::SujiTerminal,
                answer,
                2,
                vec![Tile::suited(suit, denier), Tile::suited(suit, other_denier)],
                Vec::new(),
                RunnerUp {
                    tile: Tile::suited(suit, other),
                    copies: 2,
                },
                Vec::new(),
            ))
        }
        // BBB: a suji 4/5/6. The runner-up is a BB+ suji 2/8 in another suit,
        // so the 5 that makes it suji cannot touch the answer.
        3 => {
            let (value, ends) =
                choose(&[(4u8, [1u8, 7u8]), (5, [2, 8]), (6, [3, 9])]).ok_or("no suji middle")?;
            let answer = Tile::suited(suit, value);
            let runner_suit = other_suit(suit)?;
            let runner_up = choose(&[2u8, 8]).ok_or("no suji simple")?;

            Ok(ThemePlan::ranking(
                SafetyTheme::SujiMiddle,
                answer,
                0,
                [
                    ends.iter()
                        .map(|&end| Tile::suited(suit, end))
                        .collect::<Vec<_>>(),
                    vec![Tile::suited(runner_suit, 5)],
                ]
                .concat(),
                Vec::new(),
                RunnerUp {
                    tile: Tile::suited(runner_suit, runner_up),
                    copies: 1,
                },
                Vec::new(),
            ))
        }
        // BB+: a suji 2/8. The next row is BB-, the suji 3/7 beside it: a 6
        // (or 4) in the river makes the neighbour a suji 3-7.
        4 => {
            let (value, denier, neighbour, neighbour_denier) = if gen_range(0, 2) == 0 {
                (2u8, 5u8, 3u8, 6u8)
            } else {
                (8, 5, 7, 4)
            };
            let answer = Tile::suited(suit, value);

            Ok(ThemePlan::ranking(
                SafetyTheme::SujiSimple,
                answer,
                0,
                vec![
                    Tile::suited(suit, denier),
                    Tile::suited(suit, neighbour_denier),
                ],
                Vec::new(),
                RunnerUp {
                    tile: Tile::suited(suit, neighbour),
                    copies: 1,
                },
                Vec::new(),
            ))
        }
        // BB-: a suji 3/7. The next row is B, the first copy of an honor, so
        // the hand holds exactly one quiet honor.
        5 => {
            let (value, denier) = if gen_range(0, 2) == 0 {
                (3u8, 6u8)
            } else {
                (7, 4)
            };
            let answer = Tile::suited(suit, value);
            let runner_up = random_honor()?;

            Ok(ThemePlan::ranking(
                SafetyTheme::SujiSimple,
                answer,
                0,
                vec![Tile::suited(suit, denier)],
                Vec::new(),
                RunnerUp {
                    tile: runner_up,
                    copies: 1,
                },
                Vec::new(),
            ))
        }
        // BBB no chance: a terminal whose only wait is blockaded by four
        // visible copies of its neighbour. The runner-up is a BB+ suji 2/8 in
        // another suit.
        _ => {
            let (value, blockade) = if gen_range(0, 2) == 0 {
                (1u8, 2u8)
            } else {
                (9, 8)
            };
            let answer = Tile::suited(suit, value);
            let runner_suit = other_suit(suit)?;
            let runner_up = choose(&[2u8, 8]).ok_or("no suji simple")?;

            Ok(ThemePlan::ranking(
                SafetyTheme::NoChance,
                answer,
                0,
                vec![Tile::suited(runner_suit, 5)],
                vec![Tile::suited(suit, blockade); 4],
                RunnerUp {
                    tile: Tile::suited(runner_suit, runner_up),
                    copies: 1,
                },
                Vec::new(),
            ))
        }
    }
}

fn random_honor() -> Result<Tile, String> {
    choose(&[
        Honor::East,
        Honor::South,
        Honor::West,
        Honor::North,
        Honor::White,
        Honor::Green,
        Honor::Red,
    ])
    .map(Tile::Honor)
    .ok_or_else(|| "no honor".to_string())
}

fn random_dragon() -> Result<Tile, String> {
    choose(&[Honor::White, Honor::Green, Honor::Red])
        .map(Tile::Honor)
        .ok_or_else(|| "no dragon".to_string())
}

fn other_suit(suit: Suit) -> Result<Suit, String> {
    let options: Vec<Suit> = [Suit::Man, Suit::Pin, Suit::Sou]
        .into_iter()
        .filter(|candidate| *candidate != suit)
        .collect();
    choose(&options).ok_or_else(|| "no other suit".to_string())
}

fn random_suit() -> Result<Suit, String> {
    choose(&[Suit::Man, Suit::Pin, Suit::Sou]).ok_or_else(|| "no suit available".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::safety::EARLY_TURN_LIMIT;
    use std::collections::HashSet;

    const THEMES: [SafetyTheme; 7] = [
        SafetyTheme::Genbutsu,
        SafetyTheme::SujiTerminal,
        SafetyTheme::SujiSimple,
        SafetyTheme::SujiMiddle,
        SafetyTheme::NoChance,
        SafetyTheme::HonorCount,
        SafetyTheme::NonSuji,
    ];

    #[test]
    fn every_theme_has_a_stable_id() {
        let ids: HashSet<&str> = THEMES.iter().map(|theme| theme.as_str()).collect();
        assert_eq!(ids.len(), THEMES.len());
    }

    #[test]
    fn plans_stay_inside_the_early_turns() {
        let mut seen = HashSet::new();
        for _ in 0..300 {
            let plan = plan_safety().expect("safety plan");
            assert!(plan.threat_discards.len() <= EARLY_TURN_LIMIT);
            seen.insert(plan.theme.as_str());
        }

        assert!(seen.len() >= 5, "only saw {seen:?}");
        for _ in 0..50 {
            let plan = plan_stuck().expect("stuck plan");
            assert_eq!(plan.threat_discards.len(), 1);
            assert_eq!(plan.theme, SafetyTheme::NonSuji);
        }
    }

    #[test]
    fn no_chance_plan_blockades_the_neighbour() {
        for _ in 0..50 {
            let plan = plan_safety().expect("plan");
            if plan.theme != SafetyTheme::NoChance {
                continue;
            }
            assert_eq!(plan.extra_visible.len(), 4);
            let blockade = plan.extra_visible[0];
            let answer_value = plan.answer.value().expect("a number tile");
            let blockade_value = blockade.value().expect("a number tile");
            assert_eq!(plan.answer.suit(), blockade.suit());
            assert_eq!(answer_value.abs_diff(blockade_value), 1);
        }
    }

    #[test]
    fn suji_kabe_plans_hold_a_runner_up_and_keep_the_answer_out_of_rivers() {
        let mut saw_extra_copies = false;

        for _ in 0..300 {
            let plan = plan_suji_kabe().expect("suji kabe plan");
            assert!(plan.threat_discards.len() <= EARLY_TURN_LIMIT);

            let runner_up = plan
                .runner_up
                .expect("the ranking lesson needs a runner-up");
            assert_ne!(runner_up.tile, plan.answer);
            assert!(runner_up.copies >= 1);
            assert!(plan.all_avoid.contains(&plan.answer));
            assert!(plan.all_avoid.contains(&runner_up.tile));
            assert_eq!(plan.threat_avoid, plan.all_avoid);

            if plan.answer_concealed > 0 {
                saw_extra_copies = true;
            }
        }

        assert!(
            saw_extra_copies,
            "the pair/triplet terminal variants must be generated"
        );
    }
}
