//! Constructive skeleton for the ch. 8 "Suji trap" lesson.
//!
//! Riichi Book 1, ch. 8, "Suji trap":
//!
//! > When you wait for a tile that is a suji tile of some tiles you have
//! > discarded yourself, we say you have a suji-trap wait. In particular, when
//! > your wait is a suji tile of the riichi declaration tile, we say it is an
//! > immediate suji-trap wait. — ch8:165
//!
//! The chapter's example makes the wait a closed wait of 3 after discarding 6.
//! This lesson needs the same wait to be reachable from a *second* discard as
//! well, so the question is which tile to declare on rather than whether the
//! wait shape itself is right. The skeleton therefore builds the double
//! reading out of a one-suit complex shape:
//!
//! - `v, v+1, v+1, v+1, v+2, v+3` — drop `v` and it reads as a run plus a
//!   pair; drop `v+3` and it reads as the other run plus the same pair;
//! - a penchan protorun waiting on `w`, three ranks above `v+3` (or three
//!   ranks below `v` in the mirrored skeleton);
//! - two complete sets from the rest of the deck.
//!
//! Discarding `v+3` leaves the run-plus-pair reading and a wait on `w`; because
//! `w` is exactly three ranks from `v+3`, the wait becomes a suji tile of the
//! declaration tile. Discarding `v` leaves the *same* wait and the same number
//! of live winning tiles, but no suji relation, so the trap is the only
//! difference between the two answers.
//!
//! Only a penchan can serve as the wait here. A closed wait that is three ranks
//! from a discard always leaves the other tile of the closed shape two ranks
//! from the run's end, which opens a second tenpai discard and blunts the
//! lesson; the penchan's far tile is isolated, so exactly two discards keep the
//! hand ready. (The exhaustive check in [`build`] rejects anything else rather
//! than trusting the argument.)

use agari::hand::{HandStructure, decompose_hand};
use agari::parse::{to_counts, validate_hand};
use agari::shanten::{calculate_shanten, calculate_ukeire};
use agari::tile::{Suit, Tile};

use crate::generator::riichi_judgement::judgement;
use crate::generator::support::deck::Deck;
use crate::generator::support::draw;
use crate::generator::support::tiles::suji_tiles;
use crate::rng::choose;
use crate::state::Wind;

/// One of the two mirror-image one-suit shapes the lesson is built from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Family {
    /// `1 2 2 2 3 4` plus `8 9`: discard `4` and wait on `7`.
    Low,
    /// `6 7 7 7 8 9` plus `1 2`: discard `6` and wait on `3`.
    High,
}

impl Family {
    /// The six tiles of the double-run shape, in ascending order.
    fn group(self) -> [u8; 6] {
        match self {
            Self::Low => [1, 2, 2, 2, 3, 4],
            Self::High => [6, 7, 7, 7, 8, 9],
        }
    }

    /// The penchan protorun that completes the hand.
    fn protorun(self) -> [u8; 2] {
        match self {
            Self::Low => [8, 9],
            Self::High => [1, 2],
        }
    }

    /// The winning tile the protorun waits on.
    fn wait(self) -> u8 {
        match self {
            Self::Low => 7,
            Self::High => 3,
        }
    }

    /// The discard that turns the wait into an immediate suji trap.
    fn trap(self) -> u8 {
        match self {
            Self::Low => 4,
            Self::High => 6,
        }
    }

    /// The other discard that leaves tenpai, with no suji relation to the wait.
    fn plain(self) -> u8 {
        match self {
            Self::Low => 1,
            Self::High => 9,
        }
    }
}

/// A constructed, validated hand before the table is dealt.
pub(super) struct Skeleton {
    /// The 13-tile tenpai hand left after the trap discard.
    pub tenpai_tiles: Vec<Tile>,
    /// The tile just drawn: what turns the 1-shanten hand into tenpai.
    pub drawn_tile: Tile,
    /// The trap discard: the answer's discard, tedashi from the hand.
    pub trap_discard: Tile,
    /// The other discard that also leaves tenpai, kept for the tests.
    pub plain_discard: Tile,
    /// The one winning tile both discards leave.
    pub wait_tile: Tile,
    /// Copies of the winning tile the board plants in the opponents' rivers so
    /// the wait has two live tiles and stays a bad wait (ch7:521-522).
    pub planted: Vec<Tile>,
    /// The round wind, chosen with the hand so no wind yaku can appear.
    pub round_wind: Wind,
    /// The human's non-dealer seat wind.
    pub human_wind: Wind,
}

impl Skeleton {
    /// The fourteen visible tiles: pre-draw hand plus the active draw.
    pub(super) fn full_tiles(&self) -> Vec<Tile> {
        let mut tiles = self.tenpai_tiles.clone();
        tiles.push(self.trap_discard);
        tiles
    }

    /// The 13-tile hand as it stood before the draw: what `PlayerState::hand`
    /// displays, with the draw shown separately.
    pub(super) fn pre_draw_tiles(&self) -> Vec<Tile> {
        draw::pre_draw_tiles(&self.tenpai_tiles, self.drawn_tile, self.trap_discard)
    }
}

/// Builds one validated hand, re-rolling until every constraint holds.
pub(super) fn build() -> Result<Skeleton, String> {
    let mut last_reason = String::new();
    for _ in 0..512 {
        match try_build() {
            Ok(skeleton) => return Ok(skeleton),
            Err(err) => last_reason = err,
        }
    }

    Err(format!(
        "Failed to construct a suji-trap hand: {last_reason}"
    ))
}

fn try_build() -> Result<Skeleton, String> {
    let mut deck = Deck::fresh();
    let (round_wind, human_wind) = choose_winds();

    let family = choose(&[Family::Low, Family::High])
        .ok_or_else(|| "no suji-trap family available".to_string())?;
    let suit = choose(&[Suit::Man, Suit::Pin, Suit::Sou])
        .ok_or_else(|| "no suit available".to_string())?;

    let group: Vec<Tile> = family
        .group()
        .iter()
        .map(|&value| Tile::suited(suit, value))
        .collect();
    let protorun: Vec<Tile> = family
        .protorun()
        .iter()
        .map(|&value| Tile::suited(suit, value))
        .collect();
    let wait_tile = Tile::suited(suit, family.wait());
    let trap_discard = Tile::suited(suit, family.trap());
    let plain_discard = Tile::suited(suit, family.plain());

    for &tile in group.iter().chain(protorun.iter()) {
        deck.take(tile)?;
    }

    // Two complete sets finish the hand. They may reuse the trap suit, but may
    // not reuse a tile the trap shape already holds: that would put a fourth
    // copy of the trap discard or the wait in the hand and spoil the live count.
    let reserved: Vec<Tile> = group
        .iter()
        .chain(protorun.iter())
        .copied()
        .chain([wait_tile, trap_discard, plain_discard])
        .collect();
    let mut sets = Vec::with_capacity(2);
    for _ in 0..2 {
        sets.extend(draw_set(&mut deck, &reserved)?);
    }

    let mut full_tiles = group;
    full_tiles.extend(protorun);
    full_tiles.extend(sets);
    if full_tiles.len() != 14 {
        return Err(format!("assembled {} tiles", full_tiles.len()));
    }
    validate_hand(&full_tiles).map_err(|err| format!("invalid hand: {err:?}"))?;

    // The kept hand is the fourteen tiles minus the trap discard.
    let mut tenpai_tiles = full_tiles.clone();
    let trap_index = tenpai_tiles
        .iter()
        .position(|tile| *tile == trap_discard)
        .ok_or_else(|| "the trap discard is not in the assembled hand".to_string())?;
    tenpai_tiles.remove(trap_index);
    if tenpai_tiles.len() != 13 {
        return Err(format!("the kept hand has {} tiles", tenpai_tiles.len()));
    }
    if calculate_shanten(&to_counts(&full_tiles)).shanten != 0 {
        return Err("the fourteen tiles are not tenpai".to_string());
    }

    // Both ends of the double-run shape must be the only tenpai discards, and
    // both must leave exactly the one winning tile.
    let discards = tenpai_discards(&full_tiles);
    if discards.len() != 2 {
        return Err(format!(
            "{} discards reach tenpai, expected the two ends of the shape",
            discards.len()
        ));
    }
    for (tile, waits) in &discards {
        if waits != &vec![wait_tile] {
            return Err(format!(
                "discarding {tile} waits on {waits:?}, expected only {wait_tile}"
            ));
        }
    }
    if !discards.iter().any(|(tile, _)| *tile == trap_discard)
        || !discards.iter().any(|(tile, _)| *tile == plain_discard)
    {
        return Err("the two tenpai discards are not the shape's two ends".to_string());
    }

    // The lesson: one discard makes the wait a suji of the declaration tile,
    // the other does not.
    if !suji_tiles(trap_discard).contains(&wait_tile) {
        return Err(format!(
            "{wait_tile} is not a suji tile of the trap discard {trap_discard}"
        ));
    }
    if suji_tiles(plain_discard).contains(&wait_tile) {
        return Err(format!(
            "{wait_tile} is also a suji tile of the plain discard {plain_discard}"
        ));
    }

    let tenpai_counts = to_counts(&tenpai_tiles);
    if calculate_shanten(&tenpai_counts).shanten != 0 {
        return Err("the kept hand is not tenpai".to_string());
    }
    let ukeire = calculate_ukeire(&tenpai_counts);
    if ukeire.tiles.len() != 1 || ukeire.tiles[0].tile != wait_tile {
        return Err("the kept hand's only wait is not the trap wait".to_string());
    }

    // Every winning hand must be a plain standard hand, never chiitoitsu.
    let mut winning_tiles = tenpai_tiles.clone();
    winning_tiles.push(wait_tile);
    let structures = decompose_hand(&to_counts(&winning_tiles));
    if !structures
        .iter()
        .any(|structure| matches!(structure, HandStructure::Standard { .. }))
        || structures
            .iter()
            .any(|structure| matches!(structure, HandStructure::Chiitoitsu { .. }))
    {
        return Err("winning hand is not a plain standard hand".to_string());
    }

    // Riichi-only: no yaku without the declaration. Ch. 7's general rule then
    // keeps a bad-wait non-dealer hand concealed, leaving the trap as the only
    // reason to declare.
    if judgement::min_han_without_riichi(&tenpai_tiles, &[wait_tile], round_wind, human_wind, &[])
        != 0
    {
        return Err("the hand has a yaku without riichi".to_string());
    }

    // The draw is what reaches tenpai: the hand before it was 1-shanten, so the
    // table never implies that an earlier Riichi was passed up.
    let drawn_tile = choose_drawn_tile(&full_tiles, trap_discard)
        .ok_or_else(|| "no drawn tile reaches tenpai from 1-shanten".to_string())?;
    let pre_draw = draw::pre_draw_tiles(&tenpai_tiles, drawn_tile, trap_discard);
    if pre_draw.len() != 13 || calculate_shanten(&to_counts(&pre_draw)).shanten != 1 {
        return Err("the pre-draw hand is not 1-shanten".to_string());
    }

    tenpai_tiles.sort();
    Ok(Skeleton {
        tenpai_tiles,
        drawn_tile,
        trap_discard,
        plain_discard,
        wait_tile,
        // Two visible copies leave two live winning tiles: the ch. 7 bad-wait
        // box's dama case, which the trap overrides.
        planted: vec![wait_tile, wait_tile],
        round_wind,
        human_wind,
    })
}

/// Picks a round and a non-dealer seat for the hand.
///
/// The general rule's dealer condition is held false so the trap, not the deal,
/// is what justifies the declaration.
fn choose_winds() -> (Wind, Wind) {
    let round = choose(&[Wind::East, Wind::South]).unwrap_or(Wind::East);
    let seat = choose(&[Wind::South, Wind::West, Wind::North]).unwrap_or(Wind::South);
    (round, seat)
}

/// Draws one complete set from whatever the deck still holds.
///
/// `reserved` holds the tiles the trap shape already uses; a set may not reuse
/// one of them, so the wait stays fully out of the hand and no tile reaches a
/// fourth copy.
fn draw_set(deck: &mut Deck, reserved: &[Tile]) -> Result<Vec<Tile>, String> {
    let mut candidates: Vec<Vec<Tile>> = Vec::new();

    for suit in [Suit::Man, Suit::Pin, Suit::Sou] {
        for start in 1..=7u8 {
            let tiles = vec![
                Tile::suited(suit, start),
                Tile::suited(suit, start + 1),
                Tile::suited(suit, start + 2),
            ];
            if tiles.iter().all(|tile| deck.has(*tile))
                && tiles.iter().all(|tile| !reserved.contains(tile))
            {
                candidates.push(tiles);
            }
        }

        for value in 1..=9u8 {
            let tile = Tile::suited(suit, value);
            if deck.count(tile) >= 3 && !reserved.contains(&tile) {
                candidates.push(vec![tile; 3]);
            }
        }
    }

    let set = choose(&candidates).ok_or_else(|| "no complete set available".to_string())?;
    for &tile in &set {
        deck.take(tile)?;
    }
    Ok(set)
}

/// The tile codes whose removal leaves a tenpai hand, with their waits.
fn tenpai_discards(full_tiles: &[Tile]) -> Vec<(Tile, Vec<Tile>)> {
    let mut codes = full_tiles.to_vec();
    codes.sort();
    codes.dedup();

    let mut discards = Vec::new();
    for code in codes {
        let mut rest = full_tiles.to_vec();
        let index = rest
            .iter()
            .position(|tile| *tile == code)
            .expect("code came from the hand");
        rest.remove(index);
        if calculate_shanten(&to_counts(&rest)).shanten == 0 {
            let waits: Vec<Tile> = calculate_ukeire(&to_counts(&rest))
                .tiles
                .iter()
                .map(|entry| entry.tile)
                .collect();
            discards.push((code, waits));
        }
    }

    discards
}

/// Picks which tile of the fourteen was just drawn.
///
/// A candidate is usable only when removing it leaves a 1-shanten hand: the draw
/// has to be what reaches tenpai. Copies already held three times are skipped so
/// the hand never shows a concealed quad the lesson does not discuss.
fn choose_drawn_tile(full_tiles: &[Tile], trap_discard: Tile) -> Option<Tile> {
    let mut distinct = full_tiles.to_vec();
    distinct.sort();
    distinct.dedup();

    let viable: Vec<Tile> = distinct
        .into_iter()
        .filter(|&candidate| candidate != trap_discard)
        .filter(|&candidate| full_tiles.iter().filter(|tile| **tile == candidate).count() < 4)
        .filter(|&candidate| {
            let mut rest = full_tiles.to_vec();
            let index = rest
                .iter()
                .position(|tile| *tile == candidate)
                .expect("candidate came from the hand");
            rest.remove(index);
            calculate_shanten(&to_counts(&rest)).shanten == 1
        })
        .collect();

    choose(&viable)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_ends_of_the_shape_leave_the_same_single_wait() {
        for _ in 0..40 {
            let skeleton = build().expect("suji-trap hand must build");

            assert_eq!(skeleton.tenpai_tiles.len(), 13);
            assert_eq!(skeleton.full_tiles().len(), 14);
            assert_ne!(skeleton.trap_discard, skeleton.plain_discard);
            assert!(matches!(skeleton.wait_tile.value(), Some(3 | 7)));
            assert!(skeleton.tenpai_tiles.contains(&skeleton.plain_discard));

            // The trap discard is three ranks from the wait; the plain discard
            // has no suji relation to it at all.
            assert!(suji_tiles(skeleton.trap_discard).contains(&skeleton.wait_tile));
            assert!(!suji_tiles(skeleton.plain_discard).contains(&skeleton.wait_tile));

            // Both discards are tenpai discards and both wait on the same tile.
            let discards = tenpai_discards(&skeleton.full_tiles());
            assert_eq!(discards.len(), 2);
            for (tile, waits) in &discards {
                assert_eq!(waits, &vec![skeleton.wait_tile]);
                assert!(*tile == skeleton.trap_discard || *tile == skeleton.plain_discard);
            }

            // The draw reaches tenpai and is a kept tile; the answer comes out
            // of the hand, never off the draw.
            let pre_draw = skeleton.pre_draw_tiles();
            assert_eq!(pre_draw.len(), 13);
            assert_eq!(calculate_shanten(&to_counts(&pre_draw)).shanten, 1);
            assert!(skeleton.tenpai_tiles.contains(&skeleton.drawn_tile));
            assert!(pre_draw.contains(&skeleton.trap_discard));
            assert_ne!(skeleton.drawn_tile, skeleton.trap_discard);

            // Riichi-only and a bad wait: the trap is the only justification.
            use crate::generator::riichi_judgement::judgement as riichi;
            assert_eq!(
                riichi::min_han_without_riichi(
                    &skeleton.tenpai_tiles,
                    &[skeleton.wait_tile],
                    skeleton.round_wind,
                    skeleton.human_wind,
                    &[],
                ),
                0
            );
            let quality =
                riichi::wait_quality(&skeleton.tenpai_tiles, &std::collections::HashMap::new());
            assert_eq!(quality.live_kinds, 1);
            assert_eq!(quality.live_tiles, 4);
            assert!(!quality.is_good());
            assert_ne!(skeleton.human_wind, Wind::East);
        }
    }

    #[test]
    fn both_families_are_generated() {
        let mut low = 0;
        let mut high = 0;
        for _ in 0..120 {
            let skeleton = build().expect("hand must build");
            match skeleton.wait_tile.value() {
                Some(7) => low += 1,
                Some(3) => high += 1,
                other => panic!("unexpected wait value {other:?}"),
            }
        }
        assert!(low > 0 && high > 0, "low {low} high {high}");
    }
}
