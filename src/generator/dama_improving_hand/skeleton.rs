//! Constructive skeleton for the ch. 7 improving-hand lesson.
//!
//! Every hand is the shape of the book's own worked example: four complete
//! runs plus **two isolated singles**, so discarding either single leaves a
//! four-set tanki wait and the hand is ready (ch7:710-714).
//!
//! The decision the table asks about is the section's box:
//!
//! > It makes sense to wait in dama only when **both** of the following two
//! > conditions are met. 1. It is still an early turn (8th turn or before);
//! > 2. There are at least six kinds of tiles that can improve the scores
//! > and/or the wait, or there is at least one kind of tiles that can improve
//! > the score by at least three han in one step. — ch7:656-660
//!
//! so the skeleton builds the six-kind case directly and lets
//! [`super::improvement`] prove it:
//!
//! - four runs in the three suits, which gives the book's many one-tile
//!   extensions (each run end is worth a pinfu side wait or a stretched single
//!   wait);
//! - two singles that sit clear of every run, so the ready hand is exactly a
//!   tanki and the two discards are genuinely interchangeable;
//! - one dora in a run, so the hand has a han without Riichi and the general
//!   ch7:55-59 rule would pick Riichi — that is what makes the improving box
//!   the thing deciding the answer;
//! - every draw that improves the hand must be a kind the table can still
//!   supply, which is what the board's rivers then protect.
//!
//! The improving kinds come out of the run extensions (the book's own example
//! counts fourteen); the skeleton accepts a hand only when the computed count
//! clears the box for **both** singles, because both discards are graded as the
//! same answer.

use agari::parse::to_counts;
use agari::shanten::{calculate_shanten, calculate_ukeire};
use agari::tile::{Suit, Tile};

use super::improvement::{self, Improvement};
use crate::generator::riichi_judgement::judgement;
use crate::generator::support::deck::{ALL_TILES, Deck};
use crate::rng::choose;
use crate::state::Wind;

/// The box's six-kind threshold.
///
/// The board re-checks liveness on the finished table, so a kind whose last
/// live copy would have to be visible is rejected rather than counted.
const ACCEPTED_KINDS: usize = improvement::MANY_IMPROVING_KINDS;
/// Above this the hand stops being the chapter's improving case and starts
/// overlapping the expensive-hand lesson (ch7:569, minimum 7700).
const MAX_HAN: u8 = 3;

/// A constructed, validated hand before the table is dealt.
pub(super) struct Skeleton {
    /// The thirteen kept tiles: four runs plus `wait_tile`.
    pub tenpai_tiles: Vec<Tile>,
    /// The tanki wait of the kept hand (the single kept out of the two).
    pub wait_tile: Tile,
    /// The spare single: the tile shown as the active draw and discarded.
    pub drawn_tile: Tile,
    /// The improving kinds of the kept hand.
    pub improvement: Improvement,
    /// The improving kinds of the hand that keeps the other single.
    pub equivalent_improvement: Improvement,
    /// One visible indicator that makes exactly one kept run tile dora.
    pub dora_indicator: Tile,
    /// The round wind.
    pub round_wind: Wind,
    /// The human's non-dealer seat wind.
    pub human_wind: Wind,
}

impl Skeleton {
    /// The fourteen tiles the human sees: the kept hand plus the spare single.
    pub(super) fn full_tiles(&self) -> Vec<Tile> {
        let mut tiles = self.tenpai_tiles.clone();
        tiles.push(self.drawn_tile);
        tiles
    }

    /// The other ready hand, keeping the spare single instead.
    pub(super) fn twin_tiles(&self) -> Vec<Tile> {
        let mut tiles = self.tenpai_tiles.clone();
        let index = tiles
            .iter()
            .position(|tile| *tile == self.wait_tile)
            .expect("the kept single is in the hand");
        tiles.remove(index);
        tiles.push(self.drawn_tile);
        tiles
    }

    /// The other accepted discard: dropping the kept single leaves the twin
    /// tanki on the spare, so both singles are the same answer.
    pub(super) fn equivalent_discard(&self) -> Tile {
        self.wait_tile
    }
}

/// The indicator that makes `tile` dora.
fn dora_indicator_for(tile: Tile) -> Tile {
    match tile {
        Tile::Suited { suit, value } => Tile::suited(suit, if value == 1 { 9 } else { value - 1 }),
        Tile::Honor(_) => unreachable!("the dora is always a run tile"),
    }
}

/// True when `single` cannot pair with or extend any tile of `runs`.
///
/// An isolated single is what makes the ready hand a pure tanki: a single next
/// to a run would open other interpretations and other waits.
fn is_isolated(single: Tile, runs: &[Tile]) -> bool {
    runs.iter().all(|&tile| {
        if single.is_honor() || tile.is_honor() {
            single != tile
        } else {
            single.suit() != tile.suit()
                || single.value().unwrap().abs_diff(tile.value().unwrap()) > 2
        }
    })
}

/// Four runs, each a random three-tile sequence, within the deck's four copies.
fn draw_runs(deck: &mut Deck) -> Option<Vec<Tile>> {
    let mut runs = Vec::with_capacity(12);
    for _ in 0..4 {
        let mut candidates = Vec::new();
        for suit in [Suit::Man, Suit::Pin, Suit::Sou] {
            for start in 1..=7u8 {
                let run = [
                    Tile::suited(suit, start),
                    Tile::suited(suit, start + 1),
                    Tile::suited(suit, start + 2),
                ];
                if run.iter().all(|tile| deck.has(*tile)) {
                    candidates.push(run);
                }
            }
        }
        let run = choose(&candidates)?;
        for tile in run {
            if deck.take(tile).is_err() {
                return None;
            }
            runs.push(tile);
        }
    }
    Some(runs)
}

/// Builds a hand whose kept tanki and its twin both clear the box.
pub(super) fn build() -> Result<Skeleton, String> {
    let mut last_reason = String::new();

    for _ in 0..512 {
        let round_wind = choose(&[Wind::East, Wind::South]).unwrap_or(Wind::East);
        let human_wind = choose(&[Wind::South, Wind::West, Wind::North]).unwrap_or(Wind::South);

        let mut deck = Deck::fresh();
        let Some(runs) = draw_runs(&mut deck) else {
            last_reason = "no four runs fit in the deck".to_string();
            continue;
        };

        // The two singles: isolated, distinct, and each available.
        let singles: Vec<Tile> = ALL_TILES
            .iter()
            .copied()
            .filter(|&tile| deck.has(tile) && is_isolated(tile, &runs))
            .collect();
        let Some(first) = choose(&singles) else {
            last_reason = "no isolated single available".to_string();
            continue;
        };
        let rest: Vec<Tile> = singles
            .iter()
            .copied()
            .filter(|tile| *tile != first)
            .collect();
        let Some(second) = choose(&rest) else {
            last_reason = "no second isolated single".to_string();
            continue;
        };
        deck.take(first)?;
        deck.take(second)?;

        // Both rows of four runs plus one single are a ready tanki.
        let mut kept = runs.clone();
        kept.push(first);
        kept.sort();
        if calculate_shanten(&to_counts(&kept)).shanten != 0 {
            last_reason = "the four-run tanki is not tenpai".to_string();
            continue;
        }
        let waits = calculate_ukeire(&to_counts(&kept));
        if waits.tiles.len() != 1 || waits.tiles[0].tile != first {
            last_reason = "the kept hand waits on more than the single".to_string();
            continue;
        }

        // One dora in a run: the hand has a han, so ch7:55-59 would riichi.
        // The indicator may not be a single, a wait, or an improving kind.
        let dora_candidates: Vec<Tile> = ALL_TILES
            .iter()
            .copied()
            .filter(|&tile| {
                deck.has(tile)
                    && runs.iter().filter(|candidate| **candidate == tile).count() == 1
                    && tile != first
                    && tile != second
                    && dora_indicator_for(tile) != first
                    && dora_indicator_for(tile) != second
            })
            .collect();
        let Some(dora_tile) = choose(&dora_candidates) else {
            last_reason = "no run tile can be made dora".to_string();
            continue;
        };
        let dora_indicator = dora_indicator_for(dora_tile);
        if !deck.has(dora_indicator) {
            last_reason = "the dora indicator is not available".to_string();
            continue;
        }

        let dora = [dora_indicator];

        // The cheap shape and value checks run first: the improving count is
        // the expensive test, so it should only see hands that could pass.
        //
        // The hand must have value but not too much: one dora plus the odd
        // structural yaku is the chapter's improving case, not ch7's expensive
        // hand (ch7:569) or a haneman (ch7:646).
        let han = judgement::min_han_without_riichi(&kept, &[first], round_wind, human_wind, &dora);
        if han == 0 {
            last_reason = "the hand has no han without riichi".to_string();
            continue;
        }
        if han > MAX_HAN {
            last_reason = format!("the hand is worth {han} han, above the lesson's ceiling");
            continue;
        }

        let mut twin = runs.clone();
        twin.push(second);
        twin.sort();
        if calculate_shanten(&to_counts(&twin)).shanten != 0 {
            last_reason = "the twin tanki is not tenpai".to_string();
            continue;
        }
        let twin_waits = calculate_ukeire(&to_counts(&twin));
        if twin_waits.tiles.len() != 1 || twin_waits.tiles[0].tile != second {
            last_reason = "the twin hand waits on more than the single".to_string();
            continue;
        }
        let twin_han =
            judgement::min_han_without_riichi(&twin, &[second], round_wind, human_wind, &dora);
        if twin_han == 0 || twin_han > MAX_HAN {
            last_reason = format!("the twin hand is worth {twin_han} han");
            continue;
        }

        // Exactly the two singles are ready discards: the lesson's tile choice
        // stays a choice between the interchangeable tanki singles.
        let mut full = kept.clone();
        full.push(second);
        let mut expected = vec![first, second];
        expected.sort();
        if tenpai_discards(&full) != expected {
            last_reason = "another discard also leaves tenpai".to_string();
            continue;
        }

        let improvement = improvement::count(&kept, round_wind, human_wind, &dora);
        if !improvement.qualifies() {
            last_reason = format!(
                "only {} improving kinds and no three-han step, the box needs \
                 {ACCEPTED_KINDS}",
                improvement.kinds()
            );
            continue;
        }
        // The indicator must not spend an improving kind's last live copy.
        if improvement.tiles.contains(&dora_indicator) {
            last_reason = "the dora indicator is an improving kind".to_string();
            continue;
        }

        let equivalent_improvement = improvement::count(&twin, round_wind, human_wind, &dora);
        if !equivalent_improvement.qualifies() {
            last_reason = format!(
                "the twin has only {} improving kinds and no three-han step",
                equivalent_improvement.kinds()
            );
            continue;
        }
        if equivalent_improvement.tiles.contains(&dora_indicator) {
            last_reason = "the dora indicator is a twin improving kind".to_string();
            continue;
        }

        // Which single the player keeps is a coin flip; the other is the spare
        // that the answer throws. Both hands clear the box, so both discards
        // grade as the same answer.
        let (wait_tile, drawn_tile, kept_improvement, spare_improvement) =
            if crate::rng::gen_bool(0.5) {
                (first, second, improvement, equivalent_improvement)
            } else {
                (second, first, equivalent_improvement, improvement)
            };
        if kept_improvement.tiles.contains(&drawn_tile) {
            last_reason = "the spare single is itself an improving draw".to_string();
            continue;
        }

        let mut tenpai_tiles = runs;
        tenpai_tiles.push(wait_tile);
        tenpai_tiles.sort();

        return Ok(Skeleton {
            tenpai_tiles,
            wait_tile,
            drawn_tile,
            improvement: kept_improvement,
            equivalent_improvement: spare_improvement,
            dora_indicator,
            round_wind,
            human_wind,
        });
    }

    Err(format!(
        "Failed to construct an improving hand: {last_reason}"
    ))
}

/// The distinct tiles whose removal leaves a tenpai hand, sorted.
fn tenpai_discards(full_tiles: &[Tile]) -> Vec<Tile> {
    let mut codes = full_tiles.to_vec();
    codes.sort();
    codes.dedup();

    let mut tenpai = Vec::new();
    for code in codes {
        let mut rest = full_tiles.to_vec();
        let index = rest
            .iter()
            .position(|tile| *tile == code)
            .expect("code came from the hand");
        rest.remove(index);
        if calculate_shanten(&to_counts(&rest)).shanten == 0 {
            tenpai.push(code);
        }
    }
    tenpai.sort();
    tenpai
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_hand_is_the_books_four_run_tanki_with_two_singles() {
        let skeleton = build().expect("the improving hand must build");

        assert_eq!(skeleton.tenpai_tiles.len(), 13);
        assert_eq!(skeleton.full_tiles().len(), 14);
        assert!(skeleton.tenpai_tiles.contains(&skeleton.wait_tile));
        assert!(skeleton.full_tiles().contains(&skeleton.drawn_tile));
        assert_eq!(
            skeleton.twin_tiles().len(),
            13,
            "the twin hand keeps the other single"
        );
        assert!(skeleton.twin_tiles().contains(&skeleton.drawn_tile));
        assert!(!skeleton.twin_tiles().contains(&skeleton.wait_tile));

        assert_eq!(
            calculate_shanten(&to_counts(&skeleton.tenpai_tiles)).shanten,
            0
        );
        assert_eq!(
            calculate_shanten(&to_counts(&skeleton.twin_tiles())).shanten,
            0
        );
        assert!(
            skeleton.improvement.kinds() >= ACCEPTED_KINDS,
            "kept hand: {} kinds",
            skeleton.improvement.kinds()
        );
        assert!(
            skeleton.equivalent_improvement.kinds() >= ACCEPTED_KINDS,
            "twin hand: {} kinds",
            skeleton.equivalent_improvement.kinds()
        );
        assert_ne!(skeleton.wait_tile, skeleton.drawn_tile);
    }

    #[test]
    fn the_two_singles_are_the_only_ready_discards() {
        for _ in 0..20 {
            let skeleton = build().expect("the improving hand must build");
            let mut expected = vec![skeleton.wait_tile, skeleton.drawn_tile];
            expected.sort();
            assert_eq!(tenpai_discards(&skeleton.full_tiles()), expected);
        }
    }

    #[test]
    fn an_isolated_single_rejects_neighbours() {
        let runs = agari::parse::parse_hand("123m456p789s").expect("runs must parse");
        assert!(!is_isolated(
            agari::parse::parse_hand("4m").expect("tile")[0],
            &runs
        ));
        assert!(!is_isolated(
            agari::parse::parse_hand("3p").expect("tile")[0],
            &runs
        ));
        assert!(is_isolated(
            agari::parse::parse_hand("1p").expect("tile")[0],
            &runs
        ));
        assert!(is_isolated(
            agari::parse::parse_hand("5z").expect("tile")[0],
            &runs
        ));
    }

    #[test]
    fn the_dora_indicator_makes_one_run_tile_dora() {
        for _ in 0..20 {
            let skeleton = build().expect("the improving hand must build");
            let dora = agari::context::indicator_to_dora(skeleton.dora_indicator);
            assert_eq!(
                skeleton
                    .tenpai_tiles
                    .iter()
                    .filter(|tile| **tile == dora)
                    .count(),
                1,
                "{dora} must be exactly one kept tile"
            );
        }
    }
}
