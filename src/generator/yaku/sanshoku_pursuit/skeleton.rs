//! The hand for the ch. 5.1 floating sanshoku lesson.
//!
//! Riichi Book 1, ch. 5, "Floating":
//!
//! > 3 in this hand is essentially a redundant floating tile from a pure tile
//! > efficiency perspective; we do not need it to accept 4. However, if we keep
//! > it and discard North instead, we can hope to get sanshoku of 345. — ch5:62
//!
//! > If a hand has at least one dora or tanyao (All Simples), we should discard
//! > 3 to choose a side wait pinfu hand. Only when there is no other yaku or
//! > dora in a pinfu hand, it is OK to choose closed-wait sanshoku over
//! > side-wait pinfu. — ch5:74
//!
//! Anki 1463199499575, 1463199674777 ("what is the floating method, and when
//! should you do it?"), and 1463199600827 (the seven methods).
//!
//! The book's second floating hand is the gated decision: after drawing 5s the
//! hand is tenpai with an extra tile, and the player chooses the closed-wait
//! sanshoku of 345 by discarding 6m, or the side-wait pinfu by discarding 3m.
//! The skeleton rebuilds exactly that shape:
//!
//! - the floating suit holds `x, x+2, x+3` (3m 5m 6m);
//! - two other suits hold the completed `x, x+1, x+2` runs;
//! - the third suit holds one of those runs, an extra run and the pair.
//!
//! The 14th tile is the draw `x+2` in the third suit, so the 13-tile hand
//! shown to the player is 1-away and the draw completes the third run. The
//! full hand is tenpai; the decision is which tenpai wait to keep.
//!
//! The gate is the book's: with no other yaku and no dora, keep the float and
//! chase sanshoku; with a dora or tanyao, discard the float for the side wait.
//! The third shape (tanyao) is the book's "such as tanyao" case; the dora shape
//! is the "at least one dora" case.

use agari::context::indicator_to_dora;
use agari::parse::{to_counts, validate_hand};
use agari::shanten::calculate_shanten;
use agari::tile::{Suit, Tile};
use agari::yaku::Yaku;

use crate::generator::support::deck::ALL_TILES;
use crate::generator::support::yaku::{DiscardLine, discard_lines, dora_count, other_yaku};
use crate::rng::{choose, gen_range, shuffle};
use crate::state::Wind;

/// Which reason the hand gives up sanshoku, if any.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum ValueCondition {
    /// No dora, no tanyao, no other yaku: the book chases sanshoku.
    NoOtherValue,
    /// At least one dora in the hand: the book takes the side wait.
    Dora,
    /// The hand is all simples, so tanyao is another yaku: the book takes the
    /// side wait.
    Tanyao,
}

impl ValueCondition {
    fn expects_chase(self) -> bool {
        self == Self::NoOtherValue
    }
}

/// The constructed floating-sanshoku hand.
#[allow(dead_code)]
pub(super) struct SanshokuSkeleton {
    /// All 14 tiles: the 13-tile hand plus the draw.
    pub full_tiles: Vec<Tile>,
    /// The 13 concealed tiles shown as the hand.
    pub hand_tiles: Vec<Tile>,
    /// The tile drawn to reach the 14-tile decision.
    pub draw: Tile,
    /// The suit whose floating tile is kept for sanshoku.
    pub sanshoku_suit: Suit,
    /// The shared run's low value (`x`).
    pub run_value: u8,
    /// The floating tile (`x` in `sanshoku_suit`).
    pub floating_tile: Tile,
    /// The discard that keeps the float and chases sanshoku (`x+3`).
    pub chase_discard: Tile,
    /// The discard that keeps the side wait (`x`).
    pub efficiency_discard: Tile,
    /// The book's discard for this hand.
    pub answer: Tile,
    /// Why the hand does or does not chase.
    pub condition: ValueCondition,
    /// The visible dora indicator chosen for the hand.
    pub dora_indicator: Tile,
    /// The dora tile when the condition is [`ValueCondition::Dora`].
    pub dora_tile: Option<Tile>,
}

/// Builds a hand the book's gate decides cleanly.
pub(super) fn build_skeleton() -> Result<SanshokuSkeleton, String> {
    'attempt: for _ in 0..512 {
        let condition = match gen_range(0, 3) {
            0 => ValueCondition::NoOtherValue,
            1 => ValueCondition::Dora,
            _ => ValueCondition::Tanyao,
        };

        let mut suits = [Suit::Man, Suit::Pin, Suit::Sou];
        shuffle(&mut suits);
        let sanshoku_suit = suits[0];
        let second_suit = suits[1];
        let third_suit = suits[2];

        // 2..=5 covers every non-terminal sanshoku run whose tail is a real
        // side wait: 234 through 567. A higher x would make x+2,x+3 an edge
        // wait, and a lower one would add a terminal to the sanshoku run,
        // creating junchan or chanta alongside the intended yaku.
        let x = gen_range(2, 6) as u8;

        let mut full_tiles = Vec::with_capacity(14);
        let floating_tile = suited(sanshoku_suit, x);
        let chase_discard = suited(sanshoku_suit, x + 3);
        let efficiency_discard = floating_tile;
        full_tiles.push(floating_tile);
        full_tiles.push(suited(sanshoku_suit, x + 2));
        full_tiles.push(chase_discard);

        for value in [x, x + 1, x + 2] {
            full_tiles.push(suited(second_suit, value));
            full_tiles.push(suited(third_suit, value));
        }

        let (extra_run, pair) = match condition {
            // The book's own hand: 345s + 789s + 1s1s. The terminal pair and
            // the 9 break tanyao, so the only yaku are pinfu / sanshoku.
            ValueCondition::NoOtherValue | ValueCondition::Dora => ([7u8, 8, 9], [1u8, 1]),
            // All simples: tanyao is the "other yaku" the book names.
            ValueCondition::Tanyao => ([6u8, 7, 8], [2u8, 2]),
        };
        for value in extra_run {
            full_tiles.push(suited(third_suit, value));
        }
        full_tiles.push(suited(third_suit, pair[0]));
        full_tiles.push(suited(third_suit, pair[1]));

        if validate_hand(&full_tiles).is_err() {
            continue 'attempt;
        }

        // The draw is the third run's top tile, exactly the book's 5s draw.
        let draw = suited(third_suit, x + 2);
        let Some(mut hand_tiles) = without(&full_tiles, draw) else {
            continue 'attempt;
        };
        hand_tiles.sort();

        let Some((dora_indicator, dora_tile)) = choose_dora(&full_tiles, condition, second_suit, x)
        else {
            continue 'attempt;
        };

        let mut skeleton = SanshokuSkeleton {
            full_tiles,
            hand_tiles,
            draw,
            sanshoku_suit,
            run_value: x,
            floating_tile,
            chase_discard,
            efficiency_discard,
            // Filled below from the yaku gate so the answer is never a literal.
            answer: chase_discard,
            condition,
            dora_indicator,
            dora_tile,
        };

        let facts = match analyze(&skeleton) {
            Ok(facts) => facts,
            Err(_) => continue 'attempt,
        };
        if facts.has_other_value == condition.expects_chase() {
            continue 'attempt;
        }
        skeleton.answer = if facts.has_other_value {
            efficiency_discard
        } else {
            chase_discard
        };

        if verify(&skeleton).is_err() {
            continue 'attempt;
        }

        return Ok(skeleton);
    }

    Err("Failed to construct a valid floating sanshoku hand".to_string())
}

/// The yaku read from the hand's tenpai lines.
pub(super) struct AnswerFacts {
    /// Every tenpai discard, every winning tile, every yaku reading.
    pub lines: Vec<DiscardLine>,
    /// Dora copies in the 14-tile hand.
    pub dora: u8,
    /// Yaku other than pinfu / sanshoku that any line can claim.
    pub other_yaku: Vec<Yaku>,
    /// True when the book's gate says take the side wait.
    pub has_other_value: bool,
}

/// Reads the book's gate from the finished skeleton.
pub(super) fn analyze(skeleton: &SanshokuSkeleton) -> Result<AnswerFacts, String> {
    let lines = discard_lines(
        &skeleton.full_tiles,
        Wind::East,
        Wind::South,
        &[skeleton.dora_indicator],
        0,
    );

    if lines.is_empty() {
        return Err("the hand has no tenpai discard".to_string());
    }

    let dora = dora_count(&skeleton.full_tiles, &[skeleton.dora_indicator]);
    let mut yaku_list = Vec::new();
    for line in &lines {
        for yaku in other_yaku(&line.wins) {
            if !yaku_list.contains(&yaku) {
                yaku_list.push(yaku);
            }
        }
    }

    Ok(AnswerFacts {
        lines,
        dora,
        has_other_value: dora > 0 || !yaku_list.is_empty(),
        other_yaku: yaku_list,
    })
}

/// Proves the book's claim on one hand.
pub(super) fn verify(skeleton: &SanshokuSkeleton) -> Result<(), String> {
    if skeleton.full_tiles.len() != 14 || skeleton.hand_tiles.len() != 13 {
        return Err("the floating hand must be 13 tiles plus a draw".to_string());
    }
    if calculate_shanten(&to_counts(&skeleton.full_tiles)).shanten != 0 {
        return Err("the 14-tile floating hand must be tenpai with an extra tile".to_string());
    }

    let facts = analyze(skeleton)?;
    let efficiency = facts
        .lines
        .iter()
        .find(|line| line.discard == skeleton.efficiency_discard)
        .ok_or_else(|| "discarding the floating tile must leave tenpai".to_string())?;
    let chase = facts
        .lines
        .iter()
        .find(|line| line.discard == skeleton.chase_discard)
        .ok_or_else(|| "keeping the floating tile must leave tenpai".to_string())?;

    if !efficiency.all_have(Yaku::Pinfu) {
        return Err("the side-wait line must be pinfu on every winning tile".to_string());
    }
    if efficiency.has(Yaku::SanshokuDoujun) {
        return Err("the efficiency line must not reach sanshoku".to_string());
    }
    if !chase.all_have(Yaku::SanshokuDoujun) {
        return Err("the chase line must be sanshoku on every winning tile".to_string());
    }
    if chase.has(Yaku::Pinfu) {
        return Err("the chase line must keep a closed wait, so not pinfu".to_string());
    }

    // The only other yaku allowed is tanyao in its own shape. A stray iipeiko,
    // chanta, or yakuhai would make the gate's comparison dishonest.
    for yaku in &facts.other_yaku {
        if *yaku != Yaku::Tanyao {
            return Err(format!("unintended other yaku {yaku:?}"));
        }
    }
    let expected_tanyao = skeleton.condition == ValueCondition::Tanyao;
    if expected_tanyao != facts.other_yaku.contains(&Yaku::Tanyao) {
        return Err("the tanyao condition does not match the hand".to_string());
    }

    let expected_dora = skeleton.condition == ValueCondition::Dora;
    if (facts.dora > 0) != expected_dora {
        return Err("the dora condition does not match the hand".to_string());
    }

    let expected_answer = if facts.has_other_value {
        skeleton.efficiency_discard
    } else {
        skeleton.chase_discard
    };
    if skeleton.answer != expected_answer {
        return Err("the answer does not follow the book's no-other-yaku gate".to_string());
    }

    // No third tenpai discard may reach either teaching yaku, or the drill
    // would have a second correct answer.
    for line in &facts.lines {
        if line.discard == skeleton.efficiency_discard || line.discard == skeleton.chase_discard {
            continue;
        }
        if line.has(Yaku::Pinfu) || line.has(Yaku::SanshokuDoujun) {
            return Err(format!(
                "discarding {} also reaches the teaching yaku",
                line.discard
            ));
        }
    }

    // ch5:110: never chase sanshoku by reverting the hand to 2-away. The chase
    // discard here leaves tenpai, the strongest possible outcome.
    let chase_hand = without(&skeleton.full_tiles, skeleton.chase_discard)
        .ok_or_else(|| "the chase discard is not in the hand".to_string())?;
    if calculate_shanten(&to_counts(&chase_hand)).shanten > 0 {
        return Err("the chase discard must not step the hand back".to_string());
    }

    Ok(())
}

fn choose_dora(
    full: &[Tile],
    condition: ValueCondition,
    second_suit: Suit,
    x: u8,
) -> Option<(Tile, Option<Tile>)> {
    match condition {
        ValueCondition::Dora => {
            // The middle tile of the completed run in another suit is kept on
            // both candidate lines, so the dora is worth the same one han
            // whichever wait the player chooses.
            let dora = suited(second_suit, x + 1);
            let indicator = indicator_for_dora(dora)?;
            if full.iter().filter(|tile| **tile == indicator).count() >= 4 {
                return None;
            }
            Some((indicator, Some(dora)))
        }
        ValueCondition::NoOtherValue | ValueCondition::Tanyao => {
            let candidates: Vec<Tile> = ALL_TILES
                .iter()
                .copied()
                .filter(|indicator| {
                    !full.contains(&indicator_to_dora(*indicator))
                        && full.iter().filter(|tile| **tile == *indicator).count() < 4
                })
                .collect();
            choose(&candidates).map(|indicator| (indicator, None))
        }
    }
}

fn indicator_for_dora(dora: Tile) -> Option<Tile> {
    ALL_TILES
        .iter()
        .copied()
        .find(|indicator| indicator_to_dora(*indicator) == dora)
}

fn suited(suit: Suit, value: u8) -> Tile {
    Tile::Suited { suit, value }
}

fn without(tiles: &[Tile], discard: Tile) -> Option<Vec<Tile>> {
    let mut remaining = tiles.to_vec();
    let index = remaining.iter().position(|tile| *tile == discard)?;
    remaining.remove(index);
    Some(remaining)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skeleton_generalizes_across_suits_values_and_gates() {
        let mut suits = Vec::new();
        let mut values = Vec::new();
        let mut conditions = Vec::new();

        for _ in 0..80 {
            let skeleton = build_skeleton().expect("sanshoku skeleton must build");
            verify(&skeleton).expect("every skeleton must prove the gate");

            assert_eq!(skeleton.full_tiles.len(), 14);
            assert_eq!(skeleton.hand_tiles.len(), 13);
            assert!(skeleton.hand_tiles.contains(&skeleton.answer));
            assert!(
                skeleton
                    .full_tiles
                    .iter()
                    .filter(|tile| **tile == skeleton.draw)
                    .count()
                    > skeleton
                        .hand_tiles
                        .iter()
                        .filter(|tile| **tile == skeleton.draw)
                        .count()
            );
            assert_eq!(
                calculate_shanten(&to_counts(&skeleton.full_tiles)).shanten,
                0
            );

            suits.push(skeleton.sanshoku_suit);
            values.push(skeleton.run_value);
            conditions.push(skeleton.condition);
        }

        suits.sort();
        suits.dedup();
        values.sort_unstable();
        values.dedup();
        conditions.sort();
        conditions.dedup();

        assert_eq!(suits.len(), 3, "all three suits must be covered");
        assert!(values.len() >= 3, "the run value must vary");
        assert_eq!(conditions.len(), 3, "all three gate cases must be covered");
    }

    #[test]
    fn the_chase_line_keeps_the_closed_wait_and_the_efficiency_line_is_pinfu() {
        for _ in 0..40 {
            let skeleton = build_skeleton().expect("sanshoku skeleton must build");
            let facts = analyze(&skeleton).expect("facts");

            let chase = facts
                .lines
                .iter()
                .find(|line| line.discard == skeleton.chase_discard)
                .expect("chase line");
            let efficiency = facts
                .lines
                .iter()
                .find(|line| line.discard == skeleton.efficiency_discard)
                .expect("efficiency line");

            assert!(chase.all_have(Yaku::SanshokuDoujun));
            assert!(!chase.has(Yaku::Pinfu));
            assert!(efficiency.all_have(Yaku::Pinfu));
            assert!(!efficiency.has(Yaku::SanshokuDoujun));
        }
    }

    #[test]
    fn the_answer_follows_the_no_other_yaku_or_dora_gate() {
        let mut saw_chase = false;
        let mut saw_dora = false;
        let mut saw_tanyao = false;

        for _ in 0..80 {
            let skeleton = build_skeleton().expect("sanshoku skeleton must build");
            match skeleton.condition {
                ValueCondition::NoOtherValue => {
                    saw_chase = true;
                    assert_eq!(skeleton.answer, skeleton.chase_discard);
                }
                ValueCondition::Dora => {
                    saw_dora = true;
                    assert_eq!(skeleton.answer, skeleton.efficiency_discard);
                    assert!(skeleton.dora_tile.is_some());
                }
                ValueCondition::Tanyao => {
                    saw_tanyao = true;
                    assert_eq!(skeleton.answer, skeleton.efficiency_discard);
                }
            }
        }

        assert!(saw_chase && saw_dora && saw_tanyao);
    }
}
