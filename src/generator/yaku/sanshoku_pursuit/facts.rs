//! Facts the rationale and the generator share for `sanshoku_pursuit`.
//!
//! The generator knows the floating suit and the two candidate discards; a
//! report only has the finished table. This module reads the same shape back
//! off the state, then re-runs the yaku gate on the tiles the table actually
//! shows, so an imported report cannot keep a stale explanation.

use agari::parse::to_counts;
use agari::shanten::calculate_shanten;
use agari::tile::{Suit, Tile};
use agari::yaku::Yaku;

use crate::generator::support::yaku::{DiscardLine, discard_lines, dora_count, other_yaku};
use crate::state::GameState;

/// The readable shape of one floating-sanshoku hand.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SanshokuFacts {
    /// The suit holding the floating tile.
    pub sanshoku_suit: Suit,
    /// The shared run's low value.
    pub run_value: u8,
    /// The floating tile (`x` in `sanshoku_suit`).
    pub floating_tile: Tile,
    /// The discard that keeps the float (`x+3`).
    pub chase_discard: Tile,
    /// The discard that keeps the side wait (`x`).
    pub efficiency_discard: Tile,
    /// The tile the state grades as correct.
    pub answer: Tile,
    /// True when the correct answer is the chase discard.
    pub chases: bool,
    /// Dora copies in the visible 14-tile hand.
    pub dora: u8,
    /// Yaku other than pinfu / sanshoku on any tenpai line.
    pub other_yaku: Vec<Yaku>,
    /// True when dora or another yaku makes the book take the side wait.
    pub has_other_value: bool,
    /// Winning tiles of the chase line.
    pub chase_waits: Vec<Tile>,
    /// Winning tiles of the efficiency line.
    pub efficiency_waits: Vec<Tile>,
}

/// Reads the floating-sanshoku shape and its ch. 5.1 gate off a finished state.
pub(crate) fn from_state(state: &GameState) -> Option<SanshokuFacts> {
    let tiles: Vec<Tile> = state
        .tiles
        .iter()
        .map(|code| Tile::try_from(code.as_str()))
        .collect::<Result<_, _>>()
        .ok()?;
    if tiles.len() != 14 {
        return None;
    }
    if calculate_shanten(&to_counts(&tiles)).shanten != 0 {
        return None;
    }

    let answer = Tile::try_from(state.correct_action.tile()?).ok()?;
    let (sanshoku_suit, run_value) = find_shape(&tiles, answer)?;

    let floating_tile = suited(sanshoku_suit, run_value);
    let chase_discard = suited(sanshoku_suit, run_value + 3);
    let efficiency_discard = floating_tile;
    if answer != floating_tile && answer != chase_discard {
        return None;
    }

    let indicators: Vec<Tile> = state
        .dora_indicators
        .iter()
        .map(|code| Tile::try_from(code.as_str()))
        .collect::<Result<_, _>>()
        .ok()?;
    let lines = discard_lines(
        &tiles,
        state.round_wind,
        state.players.first()?.wind,
        &indicators,
        0,
    );

    let chase = find_line(&lines, chase_discard)?;
    let efficiency = find_line(&lines, efficiency_discard)?;

    let mut yaku_list = Vec::new();
    for line in &lines {
        for yaku in other_yaku(&line.wins) {
            if !yaku_list.contains(&yaku) {
                yaku_list.push(yaku);
            }
        }
    }

    let dora = dora_count(&tiles, &indicators);
    Some(SanshokuFacts {
        sanshoku_suit,
        run_value,
        floating_tile,
        chase_discard,
        efficiency_discard,
        answer,
        chases: answer == chase_discard,
        dora,
        has_other_value: dora > 0 || !yaku_list.is_empty(),
        other_yaku: yaku_list,
        chase_waits: chase.waits(),
        efficiency_waits: efficiency.waits(),
    })
}

fn find_line(lines: &[DiscardLine], discard: Tile) -> Option<&DiscardLine> {
    lines.iter().find(|line| line.discard == discard)
}

/// Finds the suit whose `x, x+2, x+3` shape is the floating tile, with the
/// other two suits holding the completed `x, x+1, x+2` run.
fn find_shape(tiles: &[Tile], answer: Tile) -> Option<(Suit, u8)> {
    let suits = [Suit::Man, Suit::Pin, Suit::Sou];
    let mut fallback = None;

    for x in 2..=5u8 {
        for &suit in &suits {
            let count = |target: Tile| tiles.iter().filter(|tile| **tile == target).count();
            if count(suited(suit, x)) == 0
                || count(suited(suit, x + 2)) == 0
                || count(suited(suit, x + 3)) == 0
            {
                continue;
            }

            let others: Vec<Suit> = suits
                .iter()
                .copied()
                .filter(|other| *other != suit)
                .collect();
            let complete = others.iter().all(|&other| {
                count(suited(other, x)) > 0
                    && count(suited(other, x + 1)) > 0
                    && count(suited(other, x + 2)) > 0
            });
            if !complete {
                continue;
            }

            let candidate = (suit, x);
            if answer == suited(suit, x) || answer == suited(suit, x + 3) {
                return Some(candidate);
            }
            fallback.get_or_insert(candidate);
        }
    }

    fallback
}

fn suited(suit: Suit, value: u8) -> Tile {
    Tile::Suited { suit, value }
}
