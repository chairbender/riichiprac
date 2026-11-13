//! Constructive skeleton for the ch. 7 high-scoring-hand lesson.
//!
//! Every hand is a closed, standard, tenpai hand whose winning tiles all score
//! at least 7700 by ron without Riichi — the book's "already expensive" case
//! (ch7:569, ch7:598). The value is built rather than searched for:
//!
//! - three runs, two of them identical, so tanyao, pinfu and iipeikou supply
//!   three han at every winning tile;
//! - a simple pair that is also the dora pair (two dora), with the one
//!   indicator that makes that pair dora;
//! - for the haneman branch, a single red five inside a run adds the third
//!   dora. Three yaku plus three dora is six han, haneman ron for a non-dealer.
//!
//! The wait is a `34`-style ryanmen whose two completions are both simples, so
//! neither side loses tanyao or pinfu. The generator still recomputes both
//! winning values with `agari` and rejects any hand that does not land in the
//! target band, which is what makes accidental extra yaku (sanshoku, a second
//! iipeikou reading, ...) harmless.
//!
//! The 14 visible tiles follow the other Riichi/dama lessons: the hand was
//! 1-shanten before the draw, the draw completes the kept wait shape, and the
//! answer is an isolated floater discarded from the hand (tedashi), never the
//! draw itself.

use std::collections::HashMap;

use agari::context::indicator_to_dora;
use agari::hand::{HandStructure, decompose_hand};
use agari::parse::to_counts;
use agari::shanten::{calculate_shanten, calculate_ukeire};
use agari::tile::{Suit, Tile};

use super::judgement::{self, Verdict};
use super::scoring;
use crate::generator::support::deck::{ALL_TILES, Deck};
use crate::generator::support::draw;
use crate::rng::{choose, shuffle};
use crate::state::Wind;

/// What the next hand should teach.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Target {
    /// Minimum 7700 but below haneman: dama is the book's acceptable play.
    Dama7700,
    /// Minimum haneman or better: the book says do not riichi.
    DamaHaneman,
}

impl Target {
    /// The value band named for the agreement report.
    ///
    /// The band is a fact about the finished hand, so the label states the
    /// value and leaves the play to the player standing at the table.
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Dama7700 => "hand worth 7700",
            Self::DamaHaneman => "hand worth at least a haneman",
        }
    }

    /// The section branch this target must produce.
    pub(super) fn expected_verdict(self) -> Verdict {
        match self {
            Self::Dama7700 => Verdict::DamaExpensive,
            Self::DamaHaneman => Verdict::DamaHaneman,
        }
    }

    /// How many dora the hand should carry: the dora pair, plus a red five for
    /// the haneman branch.
    fn red_five_required(self) -> bool {
        matches!(self, Self::DamaHaneman)
    }
}

/// A constructed, validated hand before the table is dealt.
pub(super) struct Skeleton {
    /// The 13-tile tenpai hand the player keeps after the discard.
    pub tenpai_tiles: Vec<Tile>,
    /// The tile just drawn: one half of the wait block, which stays in the hand.
    pub drawn_tile: Tile,
    /// The isolated floater the player discards from the hand (tedashi).
    pub discard_tile: Tile,
    /// The two winning tiles of `tenpai_tiles`.
    pub wait_tiles: Vec<Tile>,
    /// The one visible dora indicator that makes the pair dora.
    pub dora_indicator: Tile,
    /// The tile that indicator makes dora: the hand's pair.
    pub dora_tile: Tile,
    /// The single red five in the hand, if this hand carries one.
    pub red_five: Option<Tile>,
    /// Red-five count passed to the scorer: one when `red_five` is set.
    pub aka_count: u8,
    /// The round wind.
    pub round_wind: Wind,
    /// The human's non-dealer seat wind.
    pub human_wind: Wind,
}

impl Skeleton {
    /// The fourteen visible tiles: pre-draw hand plus the active draw.
    pub(super) fn full_tiles(&self) -> Vec<Tile> {
        let mut tiles = self.tenpai_tiles.clone();
        tiles.push(self.discard_tile);
        tiles
    }

    /// The 13-tile hand as it stood before the draw.
    pub(super) fn pre_draw_tiles(&self) -> Vec<Tile> {
        draw::pre_draw_tiles(&self.tenpai_tiles, self.drawn_tile, self.discard_tile)
    }
}

/// Picks the branch the next hand should teach.
///
/// The two branches are equally likely: the 7700 case is the section's
/// "acceptable to go dama" cell and the haneman case its hard "don't riichi".
pub(super) fn random_target() -> Target {
    if crate::rng::gen_bool(0.5) {
        Target::Dama7700
    } else {
        Target::DamaHaneman
    }
}

/// The indicator that turns `tile` into dora.
fn dora_indicator_for(tile: Tile) -> Tile {
    match tile {
        Tile::Suited { suit, value } => Tile::suited(suit, if value == 1 { 9 } else { value - 1 }),
        Tile::Honor(_) => unreachable!("the lesson's dora pair is always a simple tile"),
    }
}

/// Three distinct suits for the two run blocks and the wait block.
fn choose_run_suits() -> [Suit; 3] {
    let mut suits = [Suit::Man, Suit::Pin, Suit::Sou];
    shuffle(&mut suits);
    suits
}

/// A run of three starting at `start`.
fn run(suit: Suit, start: u8) -> [Tile; 3] {
    [
        Tile::suited(suit, start),
        Tile::suited(suit, start + 1),
        Tile::suited(suit, start + 2),
    ]
}

/// Builds a hand that lands in `target`'s branch.
pub(super) fn build(target: Target) -> Result<Skeleton, String> {
    let mut last_reason = String::new();

    for _ in 0..2_048 {
        let round_wind = choose(&[Wind::East, Wind::South]).unwrap_or(Wind::East);
        let human_wind = choose(&[Wind::South, Wind::West, Wind::North]).unwrap_or(Wind::South);

        // The iipeikou pair of runs, the third run, and the wait block all sit
        // in different suits: that keeps alternate readings (and third-copy
        // awkwardness) to a minimum.
        let [suit_a, suit_c, suit_t] = choose_run_suits();

        // All tiles stay within 2-8 so tanyao holds at both winning tiles.
        let a_start = 2 + crate::rng::gen_range(0, 5) as u8; // 2..=6
        // The haneman branch needs a five in the third run for its red five.
        let c_start = if target.red_five_required() {
            3 + crate::rng::gen_range(0, 3) as u8 // 3..=5
        } else {
            2 + crate::rng::gen_range(0, 5) as u8 // 2..=6
        };
        // A ryanmen taatsu on 34..67: both completions are simples, so neither
        // side loses tanyao or the two-sided wait.
        let t_start = 3 + crate::rng::gen_range(0, 4) as u8; // 3..=6

        let run_a = run(suit_a, a_start);
        let run_b = run_a;
        let run_c = run(suit_c, c_start);
        let taatsu = [
            Tile::suited(suit_t, t_start),
            Tile::suited(suit_t, t_start + 1),
        ];

        let mut used: Vec<Tile> = Vec::with_capacity(13);
        used.extend(run_a.iter().copied());
        used.extend(run_b.iter().copied());
        used.extend(run_c.iter().copied());
        used.extend(taatsu.iter().copied());

        // The pair is any simple tile the runs and wait do not already use.
        let pair_candidates: Vec<Tile> = ALL_TILES
            .iter()
            .copied()
            .filter(|tile| tile.is_simple() && !used.contains(tile))
            .collect();
        let pair = match choose(&pair_candidates) {
            Some(pair) => pair,
            None => {
                last_reason = "no free simple tile for the pair".to_string();
                continue;
            }
        };
        used.push(pair);
        used.push(pair);

        let mut counts: HashMap<Tile, u8> = HashMap::new();
        for tile in &used {
            *counts.entry(*tile).or_insert(0) += 1;
        }
        if counts.values().any(|&count| count > 4) {
            last_reason = "the shape needs more than four copies of a tile".to_string();
            continue;
        }

        let mut tenpai_tiles = used;
        tenpai_tiles.sort();
        if calculate_shanten(&to_counts(&tenpai_tiles)).shanten != 0 {
            last_reason = "the assembled shape is not tenpai".to_string();
            continue;
        }

        let ukeire = calculate_ukeire(&to_counts(&tenpai_tiles));
        if ukeire.tiles.len() != 2 {
            last_reason = format!("the shape waits on {} kinds, not two", ukeire.tiles.len());
            continue;
        }
        let wait_tiles: Vec<Tile> = ukeire.tiles.iter().map(|entry| entry.tile).collect();

        // Every winning hand must be a plain standard hand, never chiitoitsu.
        if !wait_tiles.iter().all(|&wait| {
            let mut winning = tenpai_tiles.clone();
            winning.push(wait);
            let structures = decompose_hand(&to_counts(&winning));
            structures
                .iter()
                .any(|structure| matches!(structure, HandStructure::Standard { .. }))
                && !structures
                    .iter()
                    .any(|structure| matches!(structure, HandStructure::Chiitoitsu { .. }))
        }) {
            last_reason = "a winning hand is not a plain standard hand".to_string();
            continue;
        }

        // The dora pair: one indicator, two copies in hand, and no winning
        // tile is the dora (that would change the value from side to side).
        let dora_indicator = dora_indicator_for(pair);
        let dora_tile = indicator_to_dora(dora_indicator);
        if dora_tile != pair
            || wait_tiles.contains(&dora_tile)
            || wait_tiles.contains(&dora_indicator)
        {
            last_reason = "the dora pair collides with the wait".to_string();
            continue;
        }
        let mut deck = Deck::fresh();
        let mut took_all = true;
        for &tile in &tenpai_tiles {
            if deck.take(tile).is_err() {
                took_all = false;
                break;
            }
        }
        if !took_all || deck.take(dora_indicator).is_err() {
            last_reason = "the dora indicator is not available".to_string();
            continue;
        }

        // A single red five inside a run adds the haneman branch's third dora.
        let red_five = if target.red_five_required() {
            let candidates: Vec<Tile> = tenpai_tiles
                .iter()
                .copied()
                .filter(|tile| {
                    tile.value() == Some(5)
                        && tenpai_tiles.iter().filter(|other| *other == tile).count() == 1
                })
                .collect();
            match choose(&candidates) {
                Some(tile) => Some(tile),
                None => {
                    last_reason = "no single five to mark red".to_string();
                    continue;
                }
            }
        } else {
            None
        };
        let aka_count = u8::from(red_five.is_some());

        // The book's test: the worst winning tile must clear the target's
        // threshold without Riichi.
        let Some(worst) = scoring::worst_value(
            &tenpai_tiles,
            &wait_tiles,
            round_wind,
            human_wind,
            &[dora_indicator],
            aka_count,
        ) else {
            last_reason = "a winning tile has no yaku at all".to_string();
            continue;
        };
        match judgement::verdict(worst.points) {
            Some(verdict) if verdict == target.expected_verdict() => {}
            other => {
                last_reason = format!(
                    "the worst winning tile is worth {} points ({other:?}), not the {:?} band",
                    worst.points, target
                );
                continue;
            }
        }

        // The answer is an isolated floater already in the hand, so it must not
        // be one of the hand's own tiles or a winning tile.
        let floater_candidates: Vec<Tile> = ALL_TILES
            .iter()
            .copied()
            .filter(|tile| {
                deck.has(*tile)
                    && !tenpai_tiles.contains(tile)
                    && !wait_tiles.contains(tile)
                    && Some(*tile) != red_five
            })
            .collect();
        let Some(discard_tile) = choose(&floater_candidates) else {
            last_reason = "no floater left in the deck".to_string();
            continue;
        };

        let mut full_tiles = tenpai_tiles.clone();
        full_tiles.push(discard_tile);
        if agari::parse::validate_hand(&full_tiles).is_err() {
            last_reason = "the fourteen tiles are not a valid hand".to_string();
            continue;
        }
        if calculate_shanten(&to_counts(&full_tiles)).shanten != 0 {
            last_reason = "the fourteen tiles are not tenpai".to_string();
            continue;
        }
        // The lesson must ask Riichi-or-dama, not "which tile do I throw".
        if unique_tenpai_discard(&full_tiles) != Some(discard_tile) {
            last_reason = "another discard also leaves tenpai".to_string();
            continue;
        }

        // The draw completes the kept wait shape and is what reaches tenpai.
        let Some(drawn_tile) = draw::choose_drawn_tile(&taatsu, &tenpai_tiles, discard_tile) else {
            last_reason = "no wait-block tile reaches tenpai from 1-shanten".to_string();
            continue;
        };
        let pre_draw = draw::pre_draw_tiles(&tenpai_tiles, drawn_tile, discard_tile);
        if calculate_shanten(&to_counts(&pre_draw)).shanten != 1 {
            last_reason = "the pre-draw hand is not 1-shanten".to_string();
            continue;
        }

        return Ok(Skeleton {
            tenpai_tiles,
            drawn_tile,
            discard_tile,
            wait_tiles,
            dora_indicator,
            dora_tile,
            red_five,
            aka_count,
            round_wind,
            human_wind,
        });
    }

    Err(format!(
        "Failed to construct an expensive hand for {target:?}: {last_reason}"
    ))
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

    use crate::generator::support::analysis::regular_dora_in_hand;

    #[test]
    fn every_target_builds_its_branch() {
        for target in [Target::Dama7700, Target::DamaHaneman] {
            let skeleton =
                build(target).unwrap_or_else(|err| panic!("{target:?} must build: {err}"));

            assert_eq!(skeleton.tenpai_tiles.len(), 13);
            assert_eq!(skeleton.full_tiles().len(), 14);
            assert_eq!(skeleton.wait_tiles.len(), 2);
            assert_eq!(skeleton.aka_count, u8::from(skeleton.red_five.is_some()));
            assert_ne!(skeleton.human_wind, Wind::East);
            assert!(agari::parse::validate_hand(&skeleton.full_tiles()).is_ok());
            assert_eq!(
                unique_tenpai_discard(&skeleton.full_tiles()),
                Some(skeleton.discard_tile)
            );

            let pre_draw = skeleton.pre_draw_tiles();
            assert_eq!(calculate_shanten(&to_counts(&pre_draw)).shanten, 1);
            assert!(skeleton.tenpai_tiles.contains(&skeleton.drawn_tile));
            assert!(pre_draw.contains(&skeleton.discard_tile));
            assert_ne!(skeleton.drawn_tile, skeleton.discard_tile);

            // The dora pair is exactly two copies, and it is not the wait.
            let worst = scoring::worst_value(
                &skeleton.tenpai_tiles,
                &skeleton.wait_tiles,
                skeleton.round_wind,
                skeleton.human_wind,
                &[skeleton.dora_indicator],
                skeleton.aka_count,
            )
            .expect("both winning tiles have a value");
            assert_eq!(
                judgement::verdict(worst.points),
                Some(target.expected_verdict())
            );

            let mut winning = skeleton.tenpai_tiles.clone();
            winning.push(skeleton.wait_tiles[0]);
            assert_eq!(
                regular_dora_in_hand(&winning, skeleton.dora_indicator),
                2,
                "the pair is the only dora"
            );
        }
    }

    #[test]
    fn random_targets_cover_both_branches() {
        let mut saw_7700 = false;
        let mut saw_haneman = false;
        for _ in 0..200 {
            match random_target() {
                Target::Dama7700 => saw_7700 = true,
                Target::DamaHaneman => saw_haneman = true,
            }
        }
        assert!(saw_7700 && saw_haneman);
    }

    #[test]
    fn the_haneman_branch_always_carries_a_red_five() {
        for _ in 0..12 {
            let skeleton = build(Target::DamaHaneman).expect("target must build");
            assert_eq!(skeleton.aka_count, 1);
            let red = skeleton.red_five.expect("haneman needs a red five");
            assert_eq!(red.value(), Some(5));
            assert!(skeleton.tenpai_tiles.contains(&red));
            assert_ne!(skeleton.discard_tile, red);
        }
    }

    #[test]
    fn the_7700_branch_always_reaches_7700_without_riichi() {
        for _ in 0..12 {
            let skeleton = build(Target::Dama7700).expect("target must build");
            assert_eq!(skeleton.aka_count, 0);
            let worst = scoring::worst_value(
                &skeleton.tenpai_tiles,
                &skeleton.wait_tiles,
                skeleton.round_wind,
                skeleton.human_wind,
                &[skeleton.dora_indicator],
                0,
            )
            .expect("value");
            assert!(
                (7_700..12_000).contains(&worst.points),
                "worst value was {}",
                worst.points
            );
        }
    }
}
