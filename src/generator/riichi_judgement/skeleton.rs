//! Constructive skeleton for the general Riichi-judgement lesson.
//!
//! Every hand is a standard closed tenpai: three complete sets, a pair, a
//! two-tile wait shape, and an isolated tile that has just been drawn. The
//! drawn tile is the answer's discard, and the skeleton rejects any hand where
//! another discard would also leave tenpai, so the lesson is about Riichi vs
//! dama and never about which tile to throw.

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
    /// The isolated drawn tile the player must discard.
    pub discard_tile: Tile,
    /// The winning tiles of `tenpai_tiles`, sorted.
    pub wait_tiles: Vec<Tile>,
}

impl Skeleton {
    /// The fourteen visible tiles: tenpai hand plus the active draw.
    pub(super) fn full_tiles(&self) -> Vec<Tile> {
        let mut tiles = self.tenpai_tiles.clone();
        tiles.push(self.discard_tile);
        tiles
    }
}

/// Picks the answer the next hand should teach.
///
/// One hand in eight is the book's dama case; the rest carry one or more of
/// the three conditions, so every condition (and every combination) is seen.
pub(super) fn random_target() -> Conditions {
    let roll = gen_range(0, 8);
    if roll == 0 {
        Conditions::default()
    } else {
        Conditions::RIICHI_SETS[roll - 1]
    }
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

        // The draw must be isolated, and the hand after it must be tenpai on
        // exactly one discard: the drawn tile.
        let discard_tile = match shapes::draw_isolated(&mut deck, &tenpai_tiles) {
            Ok(tile) => tile,
            Err(_) => continue,
        };
        let mut full_tiles = tenpai_tiles.clone();
        full_tiles.push(discard_tile);
        if validate_hand(&full_tiles).is_err() {
            continue;
        }
        if calculate_shanten(&to_counts(&full_tiles)).shanten != 0 {
            continue;
        }
        if unique_tenpai_discard(&full_tiles) != Some(discard_tile) {
            continue;
        }

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
        }
    }
}
