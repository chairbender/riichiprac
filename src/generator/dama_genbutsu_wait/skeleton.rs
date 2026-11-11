//! Constructive skeleton for the ch. 7 genbutsu-wait lesson.
//!
//! Every hand is the book's own example (ch7:558): a closed standard tenpai
//! that is ready for pinfu and waits on a side wait. That is deliberately the
//! *opposite* of the bad-wait lesson: the general three-
//! condition rule (ch7:55-59) would pick Riichi here, because the hand has a
//! han (pinfu) and a good wait. The later "Genbutsu wait" section is the
//! exception, so the wait has to contain a tile that the board then places in
//! the threatening player's river.
//!
//! Shape:
//!
//! - three sequences, a suited pair, and a ryanmen protorun;
//! - every copy of both winning tiles is kept out of those blocks, so the wait
//!   is exactly the two kinds with all copies unaccounted for;
//! - the drawn tile is isolated, so discarding it is the only way to stay
//!   tenpai.
//!
//! The skeleton also picks which side of the wait becomes the threat's
//! genbutsu, so the board knows which copy to plant in their river.

use agari::hand::{HandStructure, decompose_hand};
use agari::parse::{to_counts, validate_hand};
use agari::shanten::{calculate_shanten, calculate_ukeire};
use agari::tile::Tile;

use super::shapes;
use crate::generator::riichi_judgement::judgement as riichi;
use crate::generator::support::deck::Deck;
use crate::rng::choose;
use crate::state::Wind;

/// A constructed, validated hand before the table is dealt.
pub(super) struct Skeleton {
    /// The 13-tile tenpai hand the player keeps after the discard.
    pub tenpai_tiles: Vec<Tile>,
    /// The isolated drawn tile the player must discard.
    pub discard_tile: Tile,
    /// The two winning tiles of `tenpai_tiles` (a side wait).
    pub wait_tiles: Vec<Tile>,
    /// The winning tile the board plants in the threatening player's river.
    pub genbutsu_wait: Tile,
    /// The round wind, chosen with the hand so the pair is never a value wind.
    pub round_wind: Wind,
    /// The human's non-dealer seat wind.
    pub human_wind: Wind,
}

impl Skeleton {
    /// The fourteen visible tiles: tenpai hand plus the active draw.
    pub(super) fn full_tiles(&self) -> Vec<Tile> {
        let mut tiles = self.tenpai_tiles.clone();
        tiles.push(self.discard_tile);
        tiles
    }

    /// The other winning tile: the live side of the wait after the plant.
    pub(super) fn live_wait(&self) -> Tile {
        self.wait_tiles
            .iter()
            .copied()
            .find(|&tile| tile != self.genbutsu_wait)
            .expect("a side wait has two distinct winning tiles")
    }
}

/// Builds the book's pinfu hand and picks which winning tile goes to the river.
pub(super) fn build() -> Result<Skeleton, String> {
    let mut last_reason = String::new();
    for _ in 0..512 {
        match try_build() {
            Ok(skeleton) => return Ok(skeleton),
            Err(err) => last_reason = err,
        }
    }

    Err(format!(
        "Failed to construct a genbutsu-wait hand: {last_reason}"
    ))
}

fn try_build() -> Result<Skeleton, String> {
    let mut deck = Deck::fresh();
    let (round_wind, human_wind) = choose_winds();

    let block = shapes::draw_ryanmen(&mut deck)?;
    // Keep every copy of both winning tiles out of the rest of the hand: the
    // wait must be the only use of those kinds, so the board can plant one copy
    // and leave the rest live.
    for &wait in &block.waits {
        deck.take_n(wait, 4)?;
    }

    let mut tenpai_tiles = Vec::with_capacity(13);
    for _ in 0..3 {
        tenpai_tiles.extend(shapes::draw_sequence(&mut deck)?);
    }
    let pair = shapes::draw_suited_pair(&mut deck)?;
    tenpai_tiles.push(pair);
    tenpai_tiles.push(pair);
    tenpai_tiles.extend(block.tiles.iter().copied());
    if tenpai_tiles.len() != 13 {
        return Err(format!("assembled {} tiles", tenpai_tiles.len()));
    }

    let discard_tile = shapes::draw_isolated(&mut deck, &tenpai_tiles)?;
    let mut full_tiles = tenpai_tiles.clone();
    full_tiles.push(discard_tile);
    validate_hand(&full_tiles).map_err(|err| format!("invalid hand: {err:?}"))?;
    if calculate_shanten(&to_counts(&full_tiles)).shanten != 0 {
        return Err("the fourteen tiles are not tenpai".to_string());
    }
    // The drawn tile must be the only discard that leaves tenpai.
    if unique_tenpai_discard(&full_tiles) != Some(discard_tile) {
        return Err("another discard also leaves tenpai".to_string());
    }

    let tenpai_counts = to_counts(&tenpai_tiles);
    if calculate_shanten(&tenpai_counts).shanten != 0 {
        return Err("the kept hand is not tenpai".to_string());
    }
    let ukeire = calculate_ukeire(&tenpai_counts);
    if ukeire.tiles.len() != block.waits.len()
        || !block
            .waits
            .iter()
            .all(|wait| ukeire.tiles.iter().any(|entry| entry.tile == *wait))
    {
        return Err("the side wait is not the hand's only ukeire".to_string());
    }

    // Every winning hand must be a plain standard hand, never chiitoitsu.
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
            return Err("winning hand is not a plain standard hand".to_string());
        }
    }

    // The book's example is a pinfu hand: closed, four runs, a suited pair, and
    // a side wait. Assert the yaku rather than assume it, because condition 1 of
    // the general rule is exactly what this lesson is overriding.
    if riichi::min_han_without_riichi(&tenpai_tiles, &block.waits, round_wind, human_wind, &[]) < 1
    {
        return Err("the hand has no yaku without riichi".to_string());
    }

    let genbutsu_wait =
        choose(&block.waits).ok_or_else(|| "No winning tile to plant".to_string())?;

    tenpai_tiles.sort();
    Ok(Skeleton {
        tenpai_tiles,
        discard_tile,
        wait_tiles: block.waits,
        genbutsu_wait,
        round_wind,
        human_wind,
    })
}

/// Picks a round and a non-dealer seat for the hand.
///
/// The general rule's dealer condition is held false so the only reason this
/// hand can stay concealed is the genbutsu wait.
fn choose_winds() -> (Wind, Wind) {
    let round = choose(&[Wind::East, Wind::South]).unwrap_or(Wind::East);
    let seat = choose(&[Wind::South, Wind::West, Wind::North]).unwrap_or(Wind::South);
    (round, seat)
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
    fn the_hand_is_pinfu_with_a_side_wait() {
        for _ in 0..40 {
            let skeleton = build().expect("genbutsu-wait hand must build");

            assert_eq!(skeleton.tenpai_tiles.len(), 13);
            assert_eq!(skeleton.full_tiles().len(), 14);
            assert_eq!(skeleton.wait_tiles.len(), 2);
            assert!(skeleton.wait_tiles.contains(&skeleton.genbutsu_wait));
            assert_ne!(skeleton.live_wait(), skeleton.genbutsu_wait);

            assert_eq!(
                unique_tenpai_discard(&skeleton.full_tiles()),
                Some(skeleton.discard_tile)
            );

            // Condition 1 of the general rule holds: at least one han, from the
            // pinfu shape (other yaku such as sanshoku or ittsu may add more).
            assert!(
                riichi::min_han_without_riichi(
                    &skeleton.tenpai_tiles,
                    &skeleton.wait_tiles,
                    skeleton.round_wind,
                    skeleton.human_wind,
                    &[],
                ) >= 1,
                "the book's example is a pinfu hand"
            );

            // Condition 2 holds too: two kinds, and all eight nominal tiles are
            // live because no copy is anywhere on the hand.
            let quality =
                riichi::wait_quality(&skeleton.tenpai_tiles, &std::collections::HashMap::new());
            assert_eq!(quality.live_kinds, 2);
            assert_eq!(quality.live_tiles, 8);
            assert!(quality.is_good());

            // Condition 3 is held false.
            assert_ne!(skeleton.human_wind, Wind::East);
        }
    }

    #[test]
    fn both_sides_of_the_wait_get_planted_over_time() {
        let mut first = 0;
        let mut second = 0;
        for _ in 0..80 {
            let skeleton = build().expect("genbutsu-wait hand must build");
            if skeleton.genbutsu_wait == skeleton.wait_tiles[0] {
                first += 1;
            } else {
                second += 1;
            }
        }
        assert!(first > 0 && second > 0, "both sides must be planted");
    }
}
