//! Board patterns for the two pure-defense lessons.
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
}

/// A random safety-chart lesson.
pub(super) fn plan_safety() -> Result<ThemePlan, String> {
    let suit = random_suit()?;

    match gen_range(0, 7) {
        0 => {
            let value = gen_range(1, 10) as u8;
            let answer = Tile::suited(suit, value);
            Ok(ThemePlan {
                theme: SafetyTheme::Genbutsu,
                answer,
                threat_discards: vec![answer],
                extra_visible: Vec::new(),
                threat_avoid: Vec::new(),
            })
        }
        1 => {
            let middle = choose(&[4u8, 5, 6]).ok_or("no suji middle")?;
            let value = if gen_range(0, 2) == 0 {
                middle - 3
            } else {
                middle + 3
            };
            let answer = Tile::suited(suit, value);
            Ok(ThemePlan {
                theme: SafetyTheme::SujiTerminal,
                answer,
                threat_discards: vec![Tile::suited(suit, middle)],
                extra_visible: Vec::new(),
                threat_avoid: vec![answer],
            })
        }
        2 => {
            let (value, middle) =
                choose(&[(2u8, 5u8), (8, 5), (3, 6), (7, 6)]).ok_or("no suji simple")?;
            let answer = Tile::suited(suit, value);
            Ok(ThemePlan {
                theme: SafetyTheme::SujiSimple,
                answer,
                threat_discards: vec![Tile::suited(suit, middle)],
                extra_visible: Vec::new(),
                threat_avoid: vec![answer],
            })
        }
        3 => {
            let (value, ends) =
                choose(&[(4u8, [1u8, 7u8]), (5, [2, 8]), (6, [3, 9])]).ok_or("no suji middle")?;
            let answer = Tile::suited(suit, value);
            Ok(ThemePlan {
                theme: SafetyTheme::SujiMiddle,
                answer,
                threat_discards: ends.iter().map(|&end| Tile::suited(suit, end)).collect(),
                extra_visible: Vec::new(),
                threat_avoid: vec![answer],
            })
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
            Ok(ThemePlan {
                theme: SafetyTheme::NoChance,
                answer,
                threat_discards: Vec::new(),
                extra_visible: vec![blockade; 4],
                threat_avoid: vec![answer],
            })
        }
        5 => {
            let honor = choose(&[
                Honor::East,
                Honor::South,
                Honor::West,
                Honor::North,
                Honor::White,
                Honor::Green,
                Honor::Red,
            ])
            .ok_or("no honor")?;
            let copies = gen_range(1, 4);
            let honor = Tile::Honor(honor);

            Ok(ThemePlan {
                theme: SafetyTheme::HonorCount,
                answer: honor,
                threat_discards: Vec::new(),
                extra_visible: vec![honor; copies],
                threat_avoid: vec![honor],
            })
        }
        _ => {
            let value = if gen_range(0, 2) == 0 { 1 } else { 9 };
            let answer = Tile::suited(suit, value);
            // The denier is the tile that would make this terminal suji.
            let denier = if value == 1 { 4 } else { 6 };
            Ok(ThemePlan {
                theme: SafetyTheme::NonSuji,
                answer,
                threat_discards: Vec::new(),
                extra_visible: Vec::new(),
                threat_avoid: vec![answer, Tile::suited(suit, denier)],
            })
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

    Ok(ThemePlan {
        theme: SafetyTheme::NonSuji,
        answer,
        threat_discards: vec![Tile::suited(suit, protector)],
        extra_visible: Vec::new(),
        threat_avoid: vec![answer, Tile::suited(suit, denier)],
    })
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
}
