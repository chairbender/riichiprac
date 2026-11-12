//! The ch. 7 "many possibilities of improving the hand" count.
//!
//! Riichi Book 1, ch. 7, "Many possibilities of improving the hand":
//!
//! > It makes sense to wait in dama only when **both** of the following two
//! > conditions are met. 1. It is still an early turn (8th turn or before);
//! > 2. There are at least six kinds of tiles that can improve the scores
//! > and/or the wait, **or** there is at least one kind of tiles that can
//! > improve the score by at least three han in one step. — ch7:656-660
//!
//! The section's worked example is a ready hand whose count the book states
//! explicitly, so this module uses it as its fixture: the tenpai hand
//! `345m 8m 345p 123s 678s` (four runs plus the single 8m) has exactly
//! fourteen improving kinds — `2m 3m 5m 6m 2p 3p 5p 6p 1s 4s 5s 6s 8s 9s`
//! (ch7:723, "14 kinds--49 tiles"), each turning the tanki into a pinfu side
//! wait or a stretched single wait.
//!
//! A **kind** is one of the thirty-four tile types. Drawing it improves the
//! ready hand when some discard leaves a *tenpai* hand that is strictly better:
//!
//! - **the score**, because the worst winning tile is worth more han without
//!   Riichi than the current worst winning tile; or
//! - **the wait**, because it crosses the chapter's good-wait line — at least
//!   two kinds and more than four live tiles (ch7:491) — where the current
//!   wait did not. A one-tile reshuffle of a wait that was already wide is
//!   deliberately *not* an improvement; the book's phrase is about the hand
//!   becoming better, not about ties.
//!
//! A **three-han step** is a draw whose best winning tile is at least three
//! han above the best winning tile the hand has now (ch7:660). The book's
//! second example uses that clause instead of the count clause.
//!
//! Counts are made without Riichi — the declaration is exactly what the
//! lesson decides — and with the table's dora, because dora is part of the
//! score the book asks about. Nothing else on the board enters the count: the
//! generator keeps every counted kind live, and the wait comparison is the
//! same theoretical (four-copies) count `agari` reports for `ukeire`.

use std::collections::HashMap;

use agari::parse::to_counts;
use agari::shanten::{calculate_shanten, calculate_ukeire};
use agari::tile::Tile;

use crate::generator::riichi_judgement::judgement::han_without_riichi;
use crate::generator::support::deck::ALL_TILES;
use crate::state::Wind;

/// The box's count clause: at least six kinds that improve the hand.
pub(super) const MANY_IMPROVING_KINDS: usize = 6;
/// The box's alternative clause: one draw that adds at least three han.
pub(super) const BIG_STEP_HAN: u8 = 3;
/// ch7:491: a wait is good with at least two kinds ...
const GOOD_WAIT_MIN_KINDS: usize = 2;
/// ... and more than four live tiles.
const GOOD_WAIT_MIN_TILES: u8 = 5;

/// What one ready hand can draw to improve itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Improvement {
    /// Every kind whose draw keeps the hand ready and improves it.
    pub tiles: Vec<Tile>,
    /// The kinds whose draw adds at least three han in one step.
    pub big_steps: Vec<Tile>,
    /// The hand's han without Riichi at its worst winning tile, with dora.
    pub baseline_han: u8,
}

impl Improvement {
    /// The number of improving kinds (the box's first clause).
    pub(super) fn kinds(&self) -> usize {
        self.tiles.len()
    }

    /// Whether the hand meets the box's second clause through the big step.
    pub(super) fn has_big_step(&self) -> bool {
        !self.big_steps.is_empty()
    }

    /// Whether the box's improving-hand conditions hold for this hand.
    pub(super) fn qualifies(&self) -> bool {
        self.kinds() >= MANY_IMPROVING_KINDS || self.has_big_step()
    }

    /// The empty answer for a hand that is not a real ready hand.
    fn none() -> Self {
        Self {
            tiles: Vec::new(),
            big_steps: Vec::new(),
            baseline_han: 0,
        }
    }
}

/// The han one winning tile scores without Riichi.
fn han_of(hand: &[Tile], wait: Tile, round_wind: Wind, seat_wind: Wind, dora: &[Tile]) -> u8 {
    let mut winning = hand.to_vec();
    winning.push(wait);
    han_without_riichi(&winning, wait, round_wind, seat_wind, dora)
}

/// True when *every* winning tile scores more than `bound` han.
///
/// This is the box's "improves the score" test for one line, and it
/// short-circuits on the first winning tile that does not beat the bound —
/// the common case, since most lines keep the hand's current value.
fn every_wait_beats(
    hand: &[Tile],
    waits: &[Tile],
    round_wind: Wind,
    seat_wind: Wind,
    dora: &[Tile],
    bound: u8,
) -> bool {
    waits
        .iter()
        .all(|&wait| han_of(hand, wait, round_wind, seat_wind, dora) > bound)
}

/// The best han any winning tile of `hand` scores without Riichi.
fn best_han(hand: &[Tile], waits: &[Tile], round_wind: Wind, seat_wind: Wind, dora: &[Tile]) -> u8 {
    waits
        .iter()
        .map(|&wait| han_of(hand, wait, round_wind, seat_wind, dora))
        .max()
        .unwrap_or(0)
}

/// True when `drawn` could be a strict improvement, for the count's pruning.
///
/// An honor that the hand does not hold can only ever become its pair, and a
/// pair of one absent honor is worth exactly what a pair of another is: the
/// same three live copies, the same yaku. Drawing one can therefore never be a
/// strict improvement, so those seven kinds are pruned. Suited tiles are all
/// kept: even an isolated one can replace the head, and a suit head can turn
/// junchan or pinfu on where an honor head had turned it off (the book's
/// improving count is exactly that kind of step).
fn worth_testing(drawn: Tile, counts: &HashMap<Tile, u8>) -> bool {
    !drawn.is_honor() || *counts.get(&drawn).unwrap_or(&0) > 0
}

/// How many kinds improve `tenpai`, and whether any adds three han.
pub(super) fn count(
    tenpai: &[Tile],
    round_wind: Wind,
    seat_wind: Wind,
    dora: &[Tile],
) -> Improvement {
    count_with(tenpai, round_wind, seat_wind, dora, true)
}

/// The count, optionally without the connection pruning.
fn count_with(
    tenpai: &[Tile],
    round_wind: Wind,
    seat_wind: Wind,
    dora: &[Tile],
    prune: bool,
) -> Improvement {
    let counts = to_counts(tenpai);
    let current = calculate_ukeire(&counts);
    let current_waits: Vec<Tile> = current.tiles.iter().map(|entry| entry.tile).collect();
    if current_waits.is_empty() {
        // Not a real ready hand (a degenerate kan-shaped thirteen tiles, or a
        // hand that is already complete): there is nothing to improve.
        return Improvement::none();
    }

    let base_kinds = current
        .tiles
        .iter()
        .filter(|tile| tile.available > 0)
        .count();
    let base_good = base_kinds >= GOOD_WAIT_MIN_KINDS && current.total_count >= GOOD_WAIT_MIN_TILES;
    let base_han: Vec<u8> = current_waits
        .iter()
        .map(|&wait| han_of(tenpai, wait, round_wind, seat_wind, dora))
        .collect();
    let base_worst = base_han.iter().copied().min().unwrap_or(0);
    let base_best = base_han.iter().copied().max().unwrap_or(0);

    let mut improving = Vec::new();
    let mut big_steps = Vec::new();

    for drawn in ALL_TILES {
        // A winning draw ends the hand; it does not improve a ready hand, and
        // the hand cannot hold a fifth copy. An absent honor can only become
        // the head, which no honor changes in value, so it is pruned too.
        if current_waits.contains(&drawn)
            || *counts.get(&drawn).unwrap_or(&0) >= 4
            || (prune && !worth_testing(drawn, &counts))
        {
            continue;
        }

        // The fourteen tiles after the draw: the hand plus one copy.
        let mut drawn_counts: HashMap<Tile, u8> = counts.clone();
        *drawn_counts.entry(drawn).or_insert(0) += 1;

        let mut best_line: Option<u8> = None;
        for discard in ALL_TILES {
            let held = *drawn_counts.get(&discard).unwrap_or(&0);
            if held == 0 {
                continue;
            }
            let mut kept = drawn_counts.clone();
            kept.insert(discard, held - 1);
            if held == 1 {
                kept.remove(&discard);
            }

            if calculate_shanten(&kept).shanten != 0 {
                continue;
            }
            let ukeire = calculate_ukeire(&kept);
            if ukeire.tiles.is_empty() {
                continue;
            }
            let waits: Vec<Tile> = ukeire.tiles.iter().map(|entry| entry.tile).collect();
            let kinds = ukeire
                .tiles
                .iter()
                .filter(|entry| entry.available > 0)
                .count();
            let tiles = ukeire.total_count;
            let new_good = kinds >= GOOD_WAIT_MIN_KINDS && tiles >= GOOD_WAIT_MIN_TILES;
            let wait_better = new_good && !base_good;
            let kept_tiles = expand(&kept);

            // Score first, then the wait's class. Ties are not improvements.
            let score_better =
                every_wait_beats(&kept_tiles, &waits, round_wind, seat_wind, dora, base_worst);
            if !score_better && !wait_better {
                continue;
            }

            let best = best_han(&kept_tiles, &waits, round_wind, seat_wind, dora);
            best_line = Some(best_line.map_or(best, |current| current.max(best)));
        }

        let Some(best) = best_line else {
            continue;
        };
        improving.push(drawn);
        if best >= base_best.saturating_add(BIG_STEP_HAN) {
            big_steps.push(drawn);
        }
    }

    improving.sort();
    big_steps.sort();
    big_steps.retain(|tile| improving.contains(tile));

    Improvement {
        tiles: improving,
        big_steps,
        baseline_han: base_worst,
    }
}

/// Expands a tile count map back into a sorted tile list.
fn expand(counts: &HashMap<Tile, u8>) -> Vec<Tile> {
    let mut tiles = Vec::new();
    for tile in ALL_TILES {
        for _ in 0..*counts.get(&tile).unwrap_or(&0) {
            tiles.push(tile);
        }
    }
    tiles
}

#[cfg(test)]
mod tests {
    use super::*;

    use agari::parse::parse_hand;

    use crate::generator::support::testing::parse_tile;

    fn hand(code: &str) -> Vec<Tile> {
        parse_hand(code).expect("hand must parse")
    }

    fn probe(code: &str) -> Improvement {
        let tiles = hand(code);
        assert_eq!(
            calculate_shanten(&to_counts(&tiles)).shanten,
            0,
            "{code} must be tenpai"
        );
        count(&tiles, Wind::East, Wind::South, &[])
    }

    /// The book's own worked example, and the anchor for this oracle: the
    /// tenpai hand `345m 8m 345p 123s 678s` has exactly these fourteen kinds
    /// (ch7:723).
    #[test]
    fn the_books_improving_example_lists_fourteen_kinds() {
        let improvement = probe("3458m345p123678s");
        let expected: Vec<Tile> = [
            "2m", "3m", "5m", "6m", "2p", "3p", "5p", "6p", "1s", "4s", "5s", "6s", "8s", "9s",
        ]
        .iter()
        .map(|code| parse_tile(code))
        .collect();

        assert_eq!(improvement.tiles, expected, "ch7:714-723");
        assert_eq!(improvement.kinds(), 14);
        assert!(improvement.qualifies());
        assert!(!improvement.has_big_step());
    }

    /// The book's ready hand with only two *score* improvements (ch7:674): the
    /// kanchan can only be upgraded by the tiles beside 5s. It has five kinds
    /// under this module's wait reading, still short of the box's six, and it
    /// carries the other clause instead: drawing 8s makes junchan + sanshoku,
    /// the "at least three han in one step" case.
    #[test]
    fn the_books_kanchan_example_is_short_of_six_kinds() {
        let improvement = probe("123789m78999p57s");
        assert!(
            improvement.tiles.contains(&parse_tile("4s"))
                && improvement.tiles.contains(&parse_tile("8s")),
            "drawing 4s or 8s makes the side wait, got {:?}",
            improvement.tiles
        );
        assert!(
            improvement.kinds() < MANY_IMPROVING_KINDS,
            "the book wants this hand reverted to 1-away, got {} kinds",
            improvement.kinds()
        );
        assert!(
            improvement.big_steps.contains(&parse_tile("8s")),
            "8s completes junchan + sanshoku for the six-han step"
        );
    }

    /// The connection pruning must never hide an improving kind. A brute-force
    /// count over every draw is compared with the pruned one on the book's
    /// hands and on a few random ready shapes.
    #[test]
    fn pruning_matches_the_brute_force_count() {
        for code in [
            "3458m345p123678s",
            "123789m78999p57s",
            "234m234m345p66p34s",
            "123m456m789m234p5s",
            "123m789p123789s1z",
        ] {
            let tiles = hand(code);
            if calculate_shanten(&to_counts(&tiles)).shanten != 0 {
                continue;
            }
            let pruned = count_with(&tiles, Wind::East, Wind::South, &[], true);
            let brute = count_with(&tiles, Wind::East, Wind::South, &[], false);
            assert_eq!(pruned.tiles, brute.tiles, "{code}");
            assert_eq!(pruned.big_steps, brute.big_steps, "{code}");
        }
    }

    #[test]
    fn a_flat_tanyao_pinfu_wait_has_nothing_to_improve() {
        let improvement = probe("234m234m345p66p34s");
        assert_eq!(improvement.tiles, Vec::new());
        assert!(!improvement.qualifies());
    }

    #[test]
    fn dora_counts_toward_the_baseline_and_can_add_improving_kinds() {
        let hand = hand("3458m345p123678s");
        let plain = count(&hand, Wind::East, Wind::South, &[]);
        // 2s indicator makes 3s dora, and the hand holds one 3s.
        let dora = count(&hand, Wind::East, Wind::South, &[parse_tile("2s")]);
        assert_eq!(plain.baseline_han, 0);
        assert_eq!(dora.baseline_han, 1, "one dora is a han without riichi");
        // Drawing and keeping more dora is a score improvement, so the dora
        // can only add kinds, never remove them.
        assert!(
            dora.kinds() >= plain.kinds(),
            "dora must not hide an improvement: {} vs {}",
            dora.kinds(),
            plain.kinds()
        );
    }

    #[test]
    fn a_big_step_is_recognised_and_counted_as_an_improving_kind() {
        // The book's kanchan hand: drawing 8s (or 9s) and dropping 5s leaves 78s, and
        // winning on 9s is junchan + sanshoku + pinfu — a six-han jump from a
        // yaku-less hand, so the second clause of the box applies.
        let improvement = probe("123789m78999p57s");
        assert!(improvement.big_steps.contains(&parse_tile("8s")));
        assert!(improvement.has_big_step());
        assert!(improvement.qualifies(), "the box's other clause holds");
        for tile in &improvement.big_steps {
            assert!(improvement.tiles.contains(tile), "{tile} must also improve");
        }
    }
}
