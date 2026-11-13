//! Constructive skeleton for the ch. 7 bad-wait lesson.
//!
//! Every hand is a closed standard tenpai with a bad wait, no yaku or dora
//! without Riichi, and the human in a non-dealer seat. Those are exactly the
//! general rule's three dama conditions (ch7:55-59), so the ch. 7 bad-wait box
//! (ch7:521-522) is the only thing left to decide the answer.
//!
//! The lesson builds three kinds of hand:
//!
//! - [`Target::DamaFewSimples`]: one or two live simple winning tiles, the
//!   box's dama case;
//! - [`Target::RiichiManyLive`]: three or four live winning tiles, the box's
//!   riichi case;
//! - [`Target::RiichiHonorTerminal`]: one or two live winning tiles on an
//!   honor/terminal wait, the box's footnote exception.
//!
//! The live count is decided here as a target; the board plants the visible
//! copies that make it true and then re-counts from the table.
//!
//! The 13 tiles held before the draw are 1-shanten: one half of the wait block
//! is the drawn tile and stays in the hand, the other was already held, and an
//! isolated floater is discarded from the hand (tedashi). Discarding the draw
//! instead (tsumogiri) would mean the player was already tenpai on an earlier
//! turn, which is not the decision this lesson asks about.

use agari::hand::{HandStructure, decompose_hand};
use agari::parse::{to_counts, validate_hand};
use agari::shanten::{calculate_shanten, calculate_ukeire};
use agari::tile::Tile;

use super::judgement::Verdict;
use super::shapes::{self, WaitClass, WaitShape};
use crate::generator::riichi_judgement::judgement;
use crate::generator::support::analysis::wind_to_honor;
use crate::generator::support::deck::{ALL_TILES, Deck};
use crate::generator::support::draw;
use crate::rng::{choose, gen_range};
use crate::state::Wind;

/// What the next hand should teach.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Target {
    /// One or two live simple winning tiles: stay dama (ch7:522).
    DamaFewSimples,
    /// Three or four live winning tiles: call riichi (ch7:521).
    RiichiManyLive,
    /// One or two live tiles on an honor/terminal wait: riichi (ch7:522).
    RiichiHonorTerminal,
}

impl Target {
    /// The parameter named for the agreement report.
    ///
    /// Each target already isolates one cell of the box, so the wording names
    /// the cell rather than a list of conditions. It names only the live-tile
    /// count, never the action the box picks for it: the note is shown before
    /// the player answers.
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::DamaFewSimples => "one or two live simple winning tiles",
            Self::RiichiManyLive => "three or more live winning tiles",
            Self::RiichiHonorTerminal => "one or two live honor/terminal winning tiles",
        }
    }
}

impl Target {
    /// The box branch this target must produce.
    pub(super) fn expected_verdict(self) -> Verdict {
        match self {
            Self::DamaFewSimples => Verdict::DamaFewSimpleTiles,
            Self::RiichiManyLive => Verdict::ThreeLiveTiles,
            Self::RiichiHonorTerminal => Verdict::HonorTerminalWait,
        }
    }

    /// The wait shape to construct.
    fn shape(self) -> WaitShape {
        match self {
            // The honor/terminal footnote needs a wait that can complete an
            // honor or terminal; the dual pon wait is the only bad-wait shape
            // that can (a tanki would leave two correct discards).
            Self::RiichiHonorTerminal => WaitShape::Shanpon,
            Self::DamaFewSimples | Self::RiichiManyLive => {
                choose(&[WaitShape::Kanchan, WaitShape::Penchan, WaitShape::Shanpon])
                    .unwrap_or(WaitShape::Kanchan)
            }
        }
    }

    /// What the winning tile may be. The honor/terminal branch curates its
    /// own wait list, so the shape helper is unrestricted there.
    fn wait_class(self) -> WaitClass {
        match self {
            Self::RiichiHonorTerminal => WaitClass::Any,
            Self::DamaFewSimples | Self::RiichiManyLive => WaitClass::Simple,
        }
    }

    /// A live-tile count that lands in this target's branch.
    ///
    /// The most a bad wait can have is four live tiles: two kinds with two
    /// copies each (a dual pon wait), or one kind with all four still unseen.
    fn desired_live(self) -> u8 {
        match self {
            Self::DamaFewSimples | Self::RiichiHonorTerminal => 1 + gen_range(0, 2) as u8,
            Self::RiichiManyLive => 3 + gen_range(0, 2) as u8,
        }
    }
}

/// A constructed, validated hand before the table is dealt.
pub(super) struct Skeleton {
    /// The 13-tile tenpai hand the player keeps after the discard.
    pub tenpai_tiles: Vec<Tile>,
    /// The tile just drawn: one half of the wait block, which stays in the
    /// hand. The other half was already there, so the draw reaches tenpai.
    pub drawn_tile: Tile,
    /// The isolated floater the player discards from the hand (tedashi). It was
    /// in the 13-tile hand before the draw and cannot extend the tenpai.
    pub discard_tile: Tile,
    /// The winning tiles of `tenpai_tiles`.
    pub wait_tiles: Vec<Tile>,
    /// Copies of the winning tiles that must be visible on the table.
    pub planted: Vec<Tile>,
    /// How many live winning tiles the planted copies leave.
    pub live_tiles: u8,
    /// The round wind, chosen with the hand so honor waits can be valueless.
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

    /// The 13-tile hand as it stood before the draw: what `PlayerState::hand`
    /// displays, with the draw shown separately.
    pub(super) fn pre_draw_tiles(&self) -> Vec<Tile> {
        draw::pre_draw_tiles(&self.tenpai_tiles, self.drawn_tile, self.discard_tile)
    }
}

/// Picks the branch the next hand should teach.
///
/// The two riichi cases outnumber the dama case, because the lesson's point is
/// that a bad wait is not an automatic dama when enough tiles are left.
pub(super) fn random_target() -> Target {
    match gen_range(0, 3) {
        0 => Target::DamaFewSimples,
        1 => Target::RiichiManyLive,
        _ => Target::RiichiHonorTerminal,
    }
}

/// Builds a hand that lands in `target`'s branch.
pub(super) fn build(target: Target) -> Result<Skeleton, String> {
    let mut last_reason = String::new();
    for _ in 0..512 {
        let mut deck = Deck::fresh();
        let (round_wind, human_wind) = choose_winds();
        let shape = target.shape();

        let block = if target == Target::RiichiHonorTerminal {
            let candidates = honor_terminal_waits(round_wind, human_wind);
            let waits = match choose_two(&candidates) {
                Some(waits) => waits,
                None => {
                    last_reason = "no valueless honor/terminal wait pair".to_string();
                    continue;
                }
            };
            match shapes::draw_shanpon_pairs(&mut deck, &waits) {
                Ok(block) => block,
                Err(err) => {
                    last_reason = err;
                    continue;
                }
            }
        } else {
            match shapes::draw_wait_block(&mut deck, shape, target.wait_class()) {
                Ok(block) => block,
                Err(err) => {
                    last_reason = err;
                    continue;
                }
            }
        };

        // Take every remaining copy of each winning tile out of the deck, so
        // no complete set or drawn tile can share a wait. The live count is
        // then exactly the copies the board chooses to leave visible.
        let mut held_per_wait = Vec::with_capacity(block.waits.len());
        let mut removed = false;
        for &wait in &block.waits {
            let held = block.tiles.iter().filter(|&&tile| tile == wait).count() as u8;
            if let Err(err) = deck.take_n(wait, 4 - held) {
                last_reason = err;
                removed = true;
                break;
            }
            held_per_wait.push(held);
        }
        if removed {
            continue;
        }

        let (sets, pair) = match shape {
            WaitShape::Shanpon => {
                let mut sets = Vec::with_capacity(3);
                while sets.len() < 3 {
                    match shapes::draw_set(&mut deck) {
                        Ok(set) => sets.push(set),
                        Err(_) => break,
                    }
                }
                (sets, None)
            }
            WaitShape::Kanchan | WaitShape::Penchan => {
                let mut sets = Vec::with_capacity(3);
                while sets.len() < 3 {
                    match shapes::draw_set(&mut deck) {
                        Ok(set) => sets.push(set),
                        Err(_) => break,
                    }
                }
                let pair = shapes::draw_pair(&mut deck).ok();
                (sets, pair)
            }
        };

        let mut tenpai_tiles = Vec::with_capacity(13);
        for set in &sets {
            tenpai_tiles.extend(set.iter().copied());
        }
        if let Some(pair) = pair {
            tenpai_tiles.push(pair);
            tenpai_tiles.push(pair);
        }
        tenpai_tiles.extend(block.tiles.iter().copied());
        if tenpai_tiles.len() != 13 {
            last_reason = format!("assembled {} tiles", tenpai_tiles.len());
            continue;
        }

        let nominal_live: u8 =
            4 * block.waits.len() as u8 - held_per_wait.iter().copied().sum::<u8>();
        let live_tiles = target.desired_live();
        if live_tiles > nominal_live {
            last_reason = format!("{live_tiles} live tiles do not fit a {shape:?} wait");
            continue;
        }
        let Some(planted) =
            distribute_plants(&block.waits, &held_per_wait, nominal_live - live_tiles)
        else {
            last_reason = "could not distribute the visible wait copies".to_string();
            continue;
        };

        let discard_tile = match shapes::draw_floater(&mut deck, &tenpai_tiles) {
            Ok(tile) => tile,
            Err(err) => {
                last_reason = err;
                continue;
            }
        };
        let mut full_tiles = tenpai_tiles.clone();
        full_tiles.push(discard_tile);
        if let Err(err) = validate_hand(&full_tiles) {
            last_reason = format!("invalid hand: {err:?}");
            continue;
        }
        if calculate_shanten(&to_counts(&full_tiles)).shanten != 0 {
            last_reason = "the fourteen tiles are not tenpai".to_string();
            continue;
        }
        // The answer is the only discard that leaves tenpai.
        if unique_tenpai_discard(&full_tiles) != Some(discard_tile) {
            last_reason = "another discard also leaves tenpai".to_string();
            continue;
        }

        // One half of the wait block was already in the hand, the other is the
        // tile just drawn. The draw must be what reaches tenpai: the hand before
        // it may not already be tenpai, or the table would imply an earlier dama.
        let Some(drawn_tile) = draw::choose_drawn_tile(&block.tiles, &tenpai_tiles, discard_tile)
        else {
            last_reason = "no wait-block tile reaches tenpai from 1-shanten".to_string();
            continue;
        };

        let tenpai_counts = to_counts(&tenpai_tiles);
        if calculate_shanten(&tenpai_counts).shanten != 0 {
            last_reason = "the kept hand is not tenpai".to_string();
            continue;
        }
        let ukeire = calculate_ukeire(&tenpai_counts);
        if ukeire.tiles.len() != block.waits.len()
            || !block
                .waits
                .iter()
                .all(|wait| ukeire.tiles.iter().any(|entry| entry.tile == *wait))
        {
            last_reason = "the wait block is not the hand's only ukeire".to_string();
            continue;
        }

        // Every winning hand must be a standard hand, never chiitoitsu.
        let mut all_standard = true;
        for &wait in &block.waits {
            let mut winning_tiles = tenpai_tiles.clone();
            winning_tiles.push(wait);
            let structures = decompose_hand(&to_counts(&winning_tiles));
            if !structures
                .iter()
                .any(|structure| matches!(structure, HandStructure::Standard { .. }))
                || structures
                    .iter()
                    .any(|structure| matches!(structure, HandStructure::Chiitoitsu { .. }))
            {
                all_standard = false;
                break;
            }
        }
        if !all_standard {
            last_reason = "winning hand is not a plain standard hand".to_string();
            continue;
        }

        // Every winning tile must score no han without Riichi, so the general
        // rule's first condition never decides.
        if !riichi_only(&tenpai_tiles, &block.waits, round_wind, human_wind) {
            last_reason = "the hand has a yaku without riichi".to_string();
            continue;
        }

        tenpai_tiles.sort();
        return Ok(Skeleton {
            tenpai_tiles,
            drawn_tile,
            discard_tile,
            wait_tiles: block.waits,
            planted,
            live_tiles,
            round_wind,
            human_wind,
        });
    }

    Err(format!(
        "Failed to construct a bad-wait hand for {target:?}: {last_reason}"
    ))
}

/// Picks a round and a non-dealer seat for the hand.
fn choose_winds() -> (Wind, Wind) {
    let round = choose(&[Wind::East, Wind::South]).unwrap_or(Wind::East);
    let seat = choose(&[Wind::South, Wind::West, Wind::North]).unwrap_or(Wind::South);
    (round, seat)
}

/// Terminals plus winds that are not the round or seat wind.
///
/// A dual pon wait completes a triplet, so a dragon or value-wind wait would
/// add a yaku and break the riichi-only premise. Terminals and valueless winds
/// are safe.
fn honor_terminal_waits(round_wind: Wind, human_wind: Wind) -> Vec<Tile> {
    let round_honor = Tile::Honor(wind_to_honor(round_wind));
    let seat_honor = Tile::Honor(wind_to_honor(human_wind));

    ALL_TILES
        .iter()
        .copied()
        .filter(|tile| {
            tile.is_terminal() || (tile.is_wind() && *tile != round_honor && *tile != seat_honor)
        })
        .collect()
}

/// Picks two distinct tiles from `candidates`.
fn choose_two(candidates: &[Tile]) -> Option<Vec<Tile>> {
    let first = choose(candidates)?;
    let rest: Vec<Tile> = candidates
        .iter()
        .copied()
        .filter(|&tile| tile != first)
        .collect();
    let second = choose(&rest)?;
    Some(vec![first, second])
}

/// Chooses which copies of the winning tiles become visible.
///
/// `held` is the copies already in the hand; each kind can show at most the
/// rest of its four copies. `total` is the number of copies that must be
/// planted so the live count reaches the target.
fn distribute_plants(waits: &[Tile], held: &[u8], total: u8) -> Option<Vec<Tile>> {
    if waits.len() != held.len() {
        return None;
    }

    let caps: Vec<u8> = held.iter().map(|&held| 4 - held).collect();
    if total > caps.iter().copied().sum::<u8>() {
        return None;
    }

    let mut counts = vec![0u8; waits.len()];
    for _ in 0..total {
        let options: Vec<usize> = (0..waits.len())
            .filter(|&index| counts[index] < caps[index])
            .collect();
        let index = choose(&options)?;
        counts[index] += 1;
    }

    let mut planted = Vec::with_capacity(total as usize);
    for (index, &wait) in waits.iter().enumerate() {
        for _ in 0..counts[index] {
            planted.push(wait);
        }
    }
    Some(planted)
}

/// True when every winning hand scores no han without Riichi.
fn riichi_only(tenpai_tiles: &[Tile], waits: &[Tile], round_wind: Wind, seat_wind: Wind) -> bool {
    waits.iter().all(|&wait| {
        judgement::min_han_without_riichi(tenpai_tiles, &[wait], round_wind, seat_wind, &[]) == 0
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
    fn every_target_builds_its_branch() {
        for target in [
            Target::DamaFewSimples,
            Target::RiichiManyLive,
            Target::RiichiHonorTerminal,
        ] {
            let skeleton =
                build(target).unwrap_or_else(|err| panic!("{target:?} must build: {err}"));
            assert_eq!(skeleton.tenpai_tiles.len(), 13);
            assert_eq!(skeleton.full_tiles().len(), 14);
            assert!(!skeleton.wait_tiles.is_empty());
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

            let quality =
                judgement::wait_quality(&skeleton.tenpai_tiles, &std::collections::HashMap::new());
            assert!(!quality.is_good(), "{target:?}");
            assert_eq!(
                skeleton.live_tiles as usize,
                quality.live_tiles as usize - skeleton.planted.len()
            );

            let verdict =
                super::super::judgement::verdict(&skeleton.wait_tiles, skeleton.live_tiles);
            assert_eq!(verdict, target.expected_verdict(), "{target:?}");
        }
    }

    #[test]
    fn random_targets_cover_every_branch() {
        let mut seen = [0usize; 3];
        for _ in 0..300 {
            match random_target() {
                Target::DamaFewSimples => seen[0] += 1,
                Target::RiichiManyLive => seen[1] += 1,
                Target::RiichiHonorTerminal => seen[2] += 1,
            }
        }
        assert!(seen.iter().all(|&count| count > 0), "{seen:?}");
    }

    #[test]
    fn the_honor_terminal_target_always_waits_on_one() {
        for _ in 0..24 {
            let skeleton = build(Target::RiichiHonorTerminal).expect("target must build");
            assert!(
                skeleton
                    .wait_tiles
                    .iter()
                    .all(|wait| wait.is_terminal_or_honor())
            );
            assert!((1..=2).contains(&skeleton.live_tiles));
            // A dragon or value wind would be a yaku on the pon.
            for wait in &skeleton.wait_tiles {
                assert!(!wait.is_dragon());
                if wait.is_wind() {
                    assert_ne!(*wait, Tile::Honor(wind_to_honor(skeleton.round_wind)));
                    assert_ne!(*wait, Tile::Honor(wind_to_honor(skeleton.human_wind)));
                }
            }
        }
    }
}
