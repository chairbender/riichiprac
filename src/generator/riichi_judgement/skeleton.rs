//! Constructive skeleton for the general Riichi-judgement lesson.
//!
//! Every hand is a standard closed tenpai: three complete sets, a pair, a
//! two-tile wait shape, and an isolated floater. The player is 1-shanten before
//! the draw, so the draw is what reaches tenpai: one half of the wait shape is
//! the drawn tile and the other was already in hand, and the floater is
//! discarded from the hand (tedashi). Discarding the draw instead (tsumogiri)
//! would mean the player was already tenpai on an earlier turn and passed up
//! Riichi then, which is not the question this lesson asks.
//!
//! The skeleton also rejects any hand where another discard would leave tenpai,
//! so the lesson is about Riichi vs dama and never about which tile to throw.
//! It rejects four copies of one tile too: that would make a closed kan legal,
//! a decision this lesson does not ask about.

use std::collections::HashMap;

use agari::hand::{HandStructure, decompose_hand};
use agari::parse::{to_counts, validate_hand};
use agari::scoring::ScoreLevel;
use agari::shanten::{calculate_shanten, calculate_ukeire};
use agari::tile::Tile;

use super::judgement::{
    self, Conditions, GOOD_WAIT_MIN_KINDS, GOOD_WAIT_MIN_TILES, MIN_LIVE_TILES, WaitQuality,
};
use super::shapes::{self, WaitShape};
use crate::generator::support::deck::Deck;
use crate::generator::support::draw;
use crate::rng::{gen_bool, gen_range};
use crate::state::Wind;

/// Where the hand's first han (condition 1) comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ValueSource {
    /// A dragon triplet: a closed yakuhai worth one han on any wait.
    Yakuhai,
    /// All simples: tanyao, worth one han on any wait.
    Tanyao,
}

/// A constructed, validated hand before the table is dealt.
pub(super) struct Skeleton {
    /// The 13-tile tenpai hand the player keeps after the discard.
    pub tenpai_tiles: Vec<Tile>,
    /// The tile just drawn: one half of the wait protorun, which stays in the
    /// hand. The other half was already there, so the draw reaches tenpai.
    pub drawn_tile: Tile,
    /// The isolated floater the player discards from the hand (tedashi). It was
    /// in the 13-tile hand before the draw and cannot extend the tenpai.
    pub discard_tile: Tile,
    /// The winning tiles of `tenpai_tiles`, sorted.
    pub wait_tiles: Vec<Tile>,
}

impl Skeleton {
    /// The fourteen visible tiles: pre-draw hand plus the active draw.
    pub(super) fn full_tiles(&self) -> Vec<Tile> {
        let mut tiles = self.tenpai_tiles.clone();
        tiles.push(self.discard_tile);
        tiles
    }

    /// The 13-tile hand as it stood before the draw: what `PlayerState::hand`
    /// displays, with the draw shown separately.
    pub(super) fn pre_draw_tiles(&self) -> Vec<Tile> {
        draw::pre_draw_tiles(&self.tenpai_tiles, self.drawn_tile, self.discard_tile)
    }
}

/// Relative draw weights for the eight parameter sets.
///
/// The pool is the book's dama case followed by [`Conditions::RIICHI_SETS`].
/// A uniform draw over the eight sets meant only three eighths of the hands
/// isolated one condition; the rest stacked two or three conditions on one
/// hand, so a player could answer from whichever condition was easiest to spot
/// and never learn the others. The isolated cases are the point of the box, so
/// they carry the highest weight:
///
/// | set | weight |
/// |---|---|
/// | dama (no condition) | 2 |
/// | one condition | 5 each |
/// | two conditions | 2 each |
/// | all three conditions | 1 |
///
/// That puts five eighths of the draw on an isolated condition, while the
/// combinations stay reachable (and the dama case stays the rarer answer, as
/// the book's rule makes it).
pub(super) const TARGET_WEIGHTS: [u32; 8] = [2, 5, 5, 5, 2, 2, 2, 1];

/// Sum of [`TARGET_WEIGHTS`]; the draw is a uniform roll in this range.
pub(super) const TOTAL_TARGET_WEIGHT: u32 = 24;

/// The parameter set at `index`, and its weight.
fn target_at(index: usize) -> (Conditions, u32) {
    let target = if index == 0 {
        Conditions::default()
    } else {
        Conditions::RIICHI_SETS[index - 1]
    };
    (target, TARGET_WEIGHTS[index])
}

/// Maps one roll in `[0, TOTAL_TARGET_WEIGHT)` onto its weighted set.
///
/// Pure so the weight table can be asserted exactly instead of sampled.
pub(super) fn target_for_roll(roll: u32) -> Conditions {
    let mut remaining = roll % TOTAL_TARGET_WEIGHT;
    for index in 0..TARGET_WEIGHTS.len() {
        let (target, weight) = target_at(index);
        if remaining < weight {
            return target;
        }
        remaining -= weight;
    }
    Conditions::default()
}

/// Picks the answer the next hand should teach.
///
/// One draw per puzzle request; the tile fill then retries under this same set
/// (see [`super::generate_with_target`]).
pub(super) fn random_target() -> Conditions {
    target_for_roll(gen_range(0, TOTAL_TARGET_WEIGHT as usize) as u32)
}

/// Builds a hand that satisfies `target` exactly.
pub(super) fn build(target: Conditions) -> Result<Skeleton, String> {
    for _ in 0..512 {
        let value = if target.extra_han {
            Some(if gen_bool(0.5) {
                ValueSource::Yakuhai
            } else {
                ValueSource::Tanyao
            })
        } else {
            None
        };
        let shape = WaitShape::for_conditions(target);

        let mut deck = Deck::fresh();
        let (wait_shape_tiles, wait_tiles, _suit) =
            shapes::draw_wait_shape(&mut deck, shape, value)?;

        let mut sets: Vec<Vec<Tile>> = Vec::with_capacity(3);
        if value == Some(ValueSource::Yakuhai) {
            sets.push(shapes::draw_dragon_triplet(&mut deck)?);
        }
        let pair = shapes::draw_pair(&mut deck, value)?;
        while sets.len() < 3 {
            sets.push(shapes::draw_set(&mut deck, value)?);
        }

        let mut tenpai_tiles = Vec::with_capacity(13);
        for set in &sets {
            tenpai_tiles.extend(set.iter().copied());
        }
        tenpai_tiles.push(pair);
        tenpai_tiles.push(pair);
        tenpai_tiles.extend(wait_shape_tiles.iter().copied());
        if tenpai_tiles.len() != 13 {
            continue;
        }

        // The floater is a hand tile, not the draw: it is discarded tedashi so
        // the table never implies the player dama'd on an earlier turn. It is
        // isolated from every kept tile, so the hand after it goes has exactly
        // the protorun's wait.
        let discard_tile = match shapes::draw_floater(&mut deck, &tenpai_tiles) {
            Ok(tile) => tile,
            Err(_) => continue,
        };
        let mut full_tiles = tenpai_tiles.clone();
        full_tiles.push(discard_tile);
        // Four concealed copies would make a closed kan (ankan) legal. This
        // lesson asks Riichi or dama, and the UI only offers the Kan call on a
        // Kan lesson, so a quad would leave Mortal evaluating an action the
        // player cannot take.
        if holds_four_of_a_kind(&full_tiles) {
            continue;
        }
        if validate_hand(&full_tiles).is_err() {
            continue;
        }
        if calculate_shanten(&to_counts(&full_tiles)).shanten != 0 {
            continue;
        }
        if unique_tenpai_discard(&full_tiles) != Some(discard_tile) {
            continue;
        }

        // One half of the protorun was already in the hand, the other is the
        // tile just drawn. The draw must be what reaches tenpai: the hand
        // before it may not already be tenpai, or the table would imply an
        // earlier dama.
        let Some(drawn_tile) =
            draw::choose_drawn_tile(&wait_shape_tiles, &tenpai_tiles, discard_tile)
        else {
            continue;
        };

        let tenpai_counts = to_counts(&tenpai_tiles);
        if calculate_shanten(&tenpai_counts).shanten != 0 {
            continue;
        }
        let ukeire = calculate_ukeire(&tenpai_counts);
        if ukeire.tiles.len() != wait_tiles.len()
            || !wait_tiles
                .iter()
                .all(|wait| ukeire.tiles.iter().any(|entry| entry.tile == *wait))
        {
            continue;
        }

        // Every winning hand must be a standard hand, never chiitoitsu.
        let mut winning_hands = Vec::with_capacity(wait_tiles.len());
        for &wait in &wait_tiles {
            let mut winning_tiles = tenpai_tiles.clone();
            winning_tiles.push(wait);
            let structures = decompose_hand(&to_counts(&winning_tiles));
            if !structures
                .iter()
                .any(|structure| matches!(structure, HandStructure::Standard { .. }))
            {
                winning_hands.clear();
                break;
            }
            winning_hands.push(winning_tiles);
        }
        if winning_hands.len() != wait_tiles.len() {
            continue;
        }

        // The idle wait quality must already match the target before any
        // visible tile is dealt; the board re-checks it with the real table.
        let no_visible = std::collections::HashMap::new();
        let idle_quality = judgement::wait_quality(&tenpai_tiles, &no_visible);
        if !wait_quality_matches(idle_quality, target) {
            continue;
        }

        // Condition 1, with no dora: the board never makes these tiles dora.
        match value {
            Some(_) => {
                if judgement::min_han_without_riichi(
                    &tenpai_tiles,
                    &wait_tiles,
                    Wind::East,
                    Wind::South,
                    &[],
                ) < 1
                {
                    continue;
                }
                let scores_too_high =
                    wait_tiles
                        .iter()
                        .zip(&winning_hands)
                        .any(|(&wait, winning_tiles)| {
                            judgement::worst_score_level(
                                winning_tiles,
                                wait,
                                Wind::East,
                                Wind::South,
                                &[],
                            ) >= ScoreLevel::Mangan
                        });
                if scores_too_high {
                    continue;
                }
            }
            None => {
                if judgement::min_han_without_riichi(
                    &tenpai_tiles,
                    &wait_tiles,
                    Wind::East,
                    Wind::South,
                    &[],
                ) != 0
                {
                    continue;
                }
            }
        }

        tenpai_tiles.sort();
        let mut wait_tiles = wait_tiles;
        wait_tiles.sort();

        return Ok(Skeleton {
            tenpai_tiles,
            drawn_tile,
            discard_tile,
            wait_tiles,
        });
    }

    Err(format!(
        "Failed to construct a Riichi-judgement hand for {target:?}"
    ))
}

/// True when an idle (fully live) wait already has the target quality.
fn wait_quality_matches(quality: WaitQuality, target: Conditions) -> bool {
    let good =
        quality.live_kinds >= GOOD_WAIT_MIN_KINDS && quality.live_tiles >= GOOD_WAIT_MIN_TILES;
    let usable = quality.live_tiles >= MIN_LIVE_TILES;
    usable && good == target.good_wait
}

/// True when the hand holds four copies of one tile.
///
/// The four copies make a closed kan (ankan) legal. This lesson asks Riichi or
/// dama, so a quad would add a decision the answer and the UI never offer.
fn holds_four_of_a_kind(tiles: &[Tile]) -> bool {
    let mut counts: HashMap<Tile, u8> = HashMap::new();
    tiles.iter().any(|&tile| {
        let count = counts.entry(tile).or_default();
        *count += 1;
        *count >= 4
    })
}

/// The tile codes whose removal leaves a tenpai hand, if there is exactly one.
fn unique_tenpai_discard(full_tiles: &[Tile]) -> Option<Tile> {
    let mut codes = full_tiles.to_vec();
    codes.sort();
    codes.dedup();

    let mut tenpai_discards = Vec::new();
    for code in codes {
        let mut rest = full_tiles.to_vec();
        let index = rest
            .iter()
            .position(|tile| *tile == code)
            .expect("code came from the hand");
        rest.remove(index);
        if calculate_shanten(&to_counts(&rest)).shanten == 0 {
            tenpai_discards.push(code);
        }
    }

    if tenpai_discards.len() == 1 {
        Some(tenpai_discards[0])
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn random_targets_cover_the_whole_rule() {
        let mut riichi = 0;
        let mut dama = 0;
        for _ in 0..1_000 {
            if random_target().picks_riichi() {
                riichi += 1;
            } else {
                dama += 1;
            }
        }
        assert!(riichi > 0 && dama > 0, "riichi {riichi}, dama {dama}");
    }

    /// The weight table covers exactly the dama case plus the seven non-empty
    /// condition sets, and each slot is exactly as wide as its weight.
    #[test]
    fn every_roll_maps_onto_its_weighted_slot() {
        assert_eq!(
            TARGET_WEIGHTS.iter().sum::<u32>(),
            TOTAL_TARGET_WEIGHT,
            "the pool total must match the table"
        );

        let expected: Vec<Conditions> = std::iter::once(Conditions::default())
            .chain(Conditions::RIICHI_SETS)
            .collect();
        assert_eq!(expected.len(), TARGET_WEIGHTS.len());

        let mut counts = vec![0u32; expected.len()];
        for roll in 0..TOTAL_TARGET_WEIGHT {
            let target = target_for_roll(roll);
            let index = expected
                .iter()
                .position(|candidate| *candidate == target)
                .expect("the roll must land on a real set");
            counts[index] += 1;
        }
        assert_eq!(counts, TARGET_WEIGHTS.to_vec());
    }

    /// The reweighting is the point of the task: an isolated condition should
    /// dominate the draw, because those are the cases the book's box teaches.
    #[test]
    fn single_condition_sets_dominate_the_draw() {
        let single_weight: u32 = TARGET_WEIGHTS[1..=3].iter().sum();
        let single_share = f64::from(single_weight) / f64::from(TOTAL_TARGET_WEIGHT);
        assert!(
            single_share > 0.6,
            "isolated conditions are only {single_share:.2} of the pool"
        );

        crate::rng::seed(0x0005_eed1_1603);
        let mut single = 0usize;
        let mut combined = 0usize;
        let mut dama = 0usize;
        let mut singles = [0usize; 3];
        let draws = 4_000;
        for _ in 0..draws {
            let target = random_target();
            match (target.extra_han, target.good_wait, target.dealer) {
                (false, false, false) => dama += 1,
                (true, false, false) => {
                    single += 1;
                    singles[0] += 1;
                }
                (false, true, false) => {
                    single += 1;
                    singles[1] += 1;
                }
                (false, false, true) => {
                    single += 1;
                    singles[2] += 1;
                }
                _ => combined += 1,
            }
        }

        assert!(
            singles.iter().all(|&count| count > 0),
            "every isolated condition must appear: {singles:?}"
        );
        assert!(dama > 0, "the dama case must still appear");
        assert!(combined > 0, "the combinations must still appear");
        assert!(
            single as f64 / draws as f64 > 0.55,
            "only {single}/{draws} draws isolated a condition"
        );
    }

    #[test]
    fn every_condition_combination_builds() {
        let targets = Conditions::RIICHI_SETS
            .into_iter()
            .chain(std::iter::once(Conditions::default()));

        for target in targets {
            let skeleton =
                build(target).unwrap_or_else(|err| panic!("{target:?} must build: {err}"));
            assert_eq!(skeleton.tenpai_tiles.len(), 13);
            assert_eq!(skeleton.full_tiles().len(), 14);
            assert!(agari::parse::validate_hand(&skeleton.full_tiles()).is_ok());
            assert_eq!(
                unique_tenpai_discard(&skeleton.full_tiles()),
                Some(skeleton.discard_tile)
            );

            // The draw reaches tenpai and is a kept tile; the answer comes
            // out of the hand, never off the draw.
            let pre_draw = skeleton.pre_draw_tiles();
            assert_eq!(pre_draw.len(), 13);
            assert_eq!(calculate_shanten(&to_counts(&pre_draw)).shanten, 1);
            assert!(skeleton.tenpai_tiles.contains(&skeleton.drawn_tile));
            assert!(pre_draw.contains(&skeleton.discard_tile));
            assert_ne!(skeleton.drawn_tile, skeleton.discard_tile);
        }
    }
}
