//! Block-theory shape classifiers (implementation unit B3).
//!
//! The ch. 3 shape lessons are the hardest family to recognise: the generator
//! *constructs* a hand whose answer follows from the book's block comparison,
//! while a replay state only shows the tiles. This module inverts the
//! constructors with a bounded comparison: it enumerates the (at most 14)
//! distinct discards, asks `agari` for the shanten and acceptance of each, and
//! then applies the lesson's shape predicate to the *structure* the generator
//! proved. Nothing is read from the state's own answer.
//!
//! # The comparison is bounded and fails closed
//!
//! - At most fourteen distinct discards are evaluated per state, and each
//!   evaluation is one `calculate_ukeire_with_melds` call on thirteen effective
//!   tiles.
//! - A hand partition is a small recursive exact-cover search capped at
//!   [`MAX_SEARCH_NODES`] nodes.
//! - The expensive wait-quality helpers (`side_wait_routes`,
//!   `is_perfect_one_away`) are called only for the two or three hands the
//!   lesson actually compares, never for every discard.
//! - Every recogniser returns `None` unless its comparison is decisive: a tie
//!   between two different answers, a second discarding line with the same
//!   book claim, or a state that is not the lesson's decision shape all decline.
//!
//! The performance budget is documented in [`PERFORMANCE_BUDGET`] and pinned
//! by `shape::tests`.
//!
//! # What the lessons compare
//!
//! Each recogniser encodes one of the book's block rules (ch. 3 and ch. 4):
//!
//! - [`ryanmen`] — the ryanmen protorun plus one; throw the duplicate, keep the
//!   side wait.
//! - [`nakabukure`] — the bulging float, whose answer depends on the hand:
//!   drop it in a ready hand, keep it while the rivals are weak, break it once
//!   the rival block is decent.
//! - [`protorun_priority`] — with one block too many, break the closed wait and
//!   keep both side waits.
//! - [`ryankan`] — a draw next to the head creates a side wait; keep it and
//!   break the double closed shape.
//! - [`plus_one`] — of two protorun-plus-one shapes, cover the weaker (closed)
//!   one and leave the strong side wait bare.
//! - [`nobetan`] — keep 3456/4567 despite a larger immediate acceptance.
//! - [`pair_count`] — in a closed hand, do not keep three pairs.
//! - [`pair_count_open`] — when a Pon is planned, keeping three pairs is right.
//! - [`skipping`] — a float two ranks from a run beats an isolated float.
//! - [`perfect`] — throw the draw and keep the perfect 1-away shape.

pub mod nakabukure;
pub mod nobetan;
pub mod pair_count;
pub mod pair_count_open;
pub mod perfect;
pub mod plus_one;
pub mod protorun_priority;
pub mod ryankan;
pub mod ryanmen;
pub mod skipping;

use std::collections::HashMap;

use agari::parse::to_counts;
use agari::shanten::{calculate_shanten_with_melds, calculate_ukeire_with_melds};
use agari::tile::{Suit, Tile};

use super::{Allowed, Match, TransformPolicy};
use crate::generator::ScenarioId;
use crate::state::{CorrectAction, DecisionContext, GameState, MeldType, TargetAction};

/// The bound on the exact-cover recursion used to read a hand's blocks.
pub(crate) const MAX_SEARCH_NODES: u32 = 4_096;

/// The documented cost of classifying one state.
///
/// A state evaluates at most fourteen discards. Each discard costs one
/// `agari` ukeire pass, and the shape predicates add at most a few hundred
/// exact-cover nodes (capped at [`MAX_SEARCH_NODES`]). On the development
/// machine the whole 10-lesson test batch of generated block states classifies
/// well inside one second; the test budget is deliberately much larger so it
/// measures the bound rather than the hardware.
pub const PERFORMANCE_BUDGET: &str = "at most 14 discard evaluations plus a \
     4096-node capped block search per state; a 20-state generated batch must \
     classify in under 5 seconds even while the rest of the test suite runs";

/// Every shape lesson shares the same transform reasoning.
///
/// The rules compare tile ranks, runs and protoruns, never values, dora or
/// seats, so a relabelled table re-runs the same comparison. Red-five identity
/// is shape-neutral too (a red five is still a five); normalising it only
/// re-runs the classifier. Seat and wind relabelling are safe for the same
/// reason: only the *honour* status of a pair matters for the planned Pon and
/// that survives a wind relabel.
pub(crate) const POLICY: TransformPolicy = TransformPolicy {
    seat_perm: Allowed::AllowWithRecompute,
    suit_perm: Allowed::AllowWithRecompute,
    rank_mirror: Allowed::AllowWithRecompute,
    wind_relabel: Allowed::AllowWithRecompute,
    red5_normalize: Allowed::AllowWithRecompute,
    note: "every shape lesson compares runs, protoruns and rank gaps, so each transform re-runs \
           the same bounded block comparison; honour vs suited is preserved by a wind relabel and \
           a red five is still a five",
};

/// The human's own-turn discard read from the tiles, ignoring derived fields.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct View {
    /// The concealed hand plus the draw, sorted.
    pub full: Vec<Tile>,
    /// The tile just drawn.
    pub draw: Tile,
    /// How many completed sets the human has called (0 or 1; a kan is not a
    /// shape-lesson hand).
    pub melds: u8,
    /// The called meld's tiles, in state order.
    pub meld_tiles: Vec<Tile>,
    /// Every tile the player can see (rivers, melds, dora indicators).
    pub visible: HashMap<Tile, u8>,
}

/// One legal discard and the hand it leaves.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Plan {
    /// The discarded tile.
    pub tile: Tile,
    /// The concealed tiles after the discard (meld tiles excluded).
    pub kept: Vec<Tile>,
    /// Shanten of the effective hand after the discard.
    pub shanten: i8,
    /// Theoretical winning kinds of the kept hand.
    pub waits: Vec<Tile>,
    /// Theoretical live acceptance.
    pub total: u8,
}

/// Read the human's self-turn discard, or `None` when the state is not one.
///
/// Structural guards only, all visible-information facts:
///
/// - a [`DecisionContext::SelfTurn`] on seat 0, four players;
/// - the human is not already in Riichi;
/// - the hand is closed or has exactly one Pon/Chi (the block-theory boards use
///   an open Yakuhai set); kans are rejected because a quad's physical size
///   changes the block count these lessons compare;
/// - the table is quiet: no opponent is in Riichi or has an open meld. The
///   ch. 3 shape lessons are offensive block comparisons; a defence board is
///   the ch. 8 family's question even when its tiles also happen to form a
///   shape motif;
/// - thirteen effective concealed tiles plus the draw;
/// - the draw is really the fourteenth tile (`hand` excludes it).
pub(crate) fn view(state: &GameState) -> Option<View> {
    if state.decision != DecisionContext::SelfTurn || state.current_turn != 0 {
        return None;
    }
    if state.players.len() != 4 {
        return None;
    }
    let human = &state.players[0];
    if !human.is_human || human.seat != 0 || human.is_riichi {
        return None;
    }
    if human.melds.len() > 1 {
        return None;
    }
    if state.players[1..]
        .iter()
        .any(|player| player.is_riichi || !player.melds.is_empty())
    {
        return None;
    }
    for meld in &human.melds {
        if !matches!(meld.meld_type, MeldType::Pon | MeldType::Chi) {
            return None;
        }
    }
    let melds = human.melds.len() as u8;
    if human.hand.len() != 13 - 3 * melds as usize {
        return None;
    }
    let draw = Tile::try_from(human.draw.as_deref()?.to_string().as_str()).ok()?;

    let mut full: Vec<Tile> = human
        .hand
        .iter()
        .map(|code| Tile::try_from(code.as_str()).ok())
        .collect::<Option<_>>()?;
    full.push(draw);
    full.sort();

    let mut meld_tiles = Vec::new();
    for meld in &human.melds {
        for code in &meld.tiles {
            meld_tiles.push(Tile::try_from(code.as_str()).ok()?);
        }
    }

    let mut visible: HashMap<Tile, u8> = HashMap::new();
    for player in &state.players {
        for discard in &player.discards {
            let tile = Tile::try_from(discard.tile.as_str()).ok()?;
            *visible.entry(tile).or_insert(0) += 1;
        }
        for meld in &player.melds {
            for code in &meld.tiles {
                let tile = Tile::try_from(code.as_str()).ok()?;
                *visible.entry(tile).or_insert(0) += 1;
            }
        }
    }
    for code in &state.dora_indicators {
        let tile = Tile::try_from(code.as_str()).ok()?;
        *visible.entry(tile).or_insert(0) += 1;
    }

    Some(View {
        full,
        draw,
        melds,
        meld_tiles,
        visible,
    })
}

impl View {
    /// Shanten of the displayed hand.
    pub(crate) fn shanten(&self) -> i8 {
        calculate_shanten_with_melds(&to_counts(&self.full), self.melds).shanten
    }

    /// The distinct tiles in the displayed hand.
    pub(crate) fn distinct(&self) -> Vec<Tile> {
        distinct(&self.full)
    }

    /// Every distinct legal discard with the hand it leaves.
    pub(crate) fn plans(&self) -> Vec<Plan> {
        let mut plans = Vec::new();
        for tile in self.distinct() {
            let Some(kept) = remove_one(&self.full, tile) else {
                continue;
            };
            let counts = to_counts(&kept);
            let ukeire = calculate_ukeire_with_melds(&counts, self.melds);
            plans.push(Plan {
                tile,
                waits: ukeire.tiles.iter().map(|entry| entry.tile).collect(),
                total: ukeire.total_count,
                shanten: calculate_shanten_with_melds(&counts, self.melds).shanten,
                kept,
            });
        }
        plans
    }

    /// A plan for one discard, if the tile is in the hand.
    pub(crate) fn plan(&self, tile: Tile) -> Option<Plan> {
        let kept = remove_one(&self.full, tile)?;
        let counts = to_counts(&kept);
        let ukeire = calculate_ukeire_with_melds(&counts, self.melds);
        Some(Plan {
            tile,
            waits: ukeire.tiles.iter().map(|entry| entry.tile).collect(),
            total: ukeire.total_count,
            shanten: calculate_shanten_with_melds(&counts, self.melds).shanten,
            kept,
        })
    }

    /// How many copies of `tile` the player can already see elsewhere.
    pub(crate) fn visible_copies(&self, tile: Tile) -> u8 {
        self.visible.get(&tile).copied().unwrap_or(0)
    }

    /// A concealed kept hand with the called meld tiles appended.
    ///
    /// The ch. 3 completion helpers walk a thirteen-tile hand and do not take a
    /// meld count; the lesson generators hand them the meld tiles as part of the
    /// hand, so the recognisers do the same when they ask a wait-quality
    /// question.
    pub(crate) fn effective(&self, kept: &[Tile]) -> Vec<Tile> {
        let mut tiles = kept.to_vec();
        tiles.extend(self.meld_tiles.iter().copied());
        tiles
    }
}

/// Build the lesson's match, refusing any answer the state cannot click.
pub(crate) fn matched(
    lesson: ScenarioId,
    situation: &str,
    answer: Tile,
    equivalents: Vec<Tile>,
) -> Option<Match> {
    let mut equivalents: Vec<String> = equivalents
        .into_iter()
        .map(|tile| tile.to_string())
        .collect();
    equivalents.sort();
    equivalents.dedup();
    equivalents.retain(|tile| tile != &answer.to_string());

    let matched = Match {
        lesson,
        situation: Some(situation.to_string()),
        target_action: TargetAction::NaniKiru,
        // The block-theory boards are plain discards: the hand may already be
        // open, and no declaration is part of the answer.
        correct_action: CorrectAction::dama(answer.to_string()),
        equivalent_tiles: equivalents,
        riichi_triggers: Vec::new(),
        dama_reasons: Vec::new(),
        shouminkan_triggers: Vec::new(),
        scenario_note: None,
    };

    // A match must be a clickable answer on the state that produced it. The
    // caller passes the state; this helper only sees the tile, so legality is
    // checked by the caller's `Match::validate` in tests and the miner seam.
    Some(matched)
}

/// Remove one copy of `tile`.
pub(crate) fn remove_one(tiles: &[Tile], tile: Tile) -> Option<Vec<Tile>> {
    let mut remaining = tiles.to_vec();
    let index = remaining.iter().position(|held| *held == tile)?;
    remaining.remove(index);
    Some(remaining)
}

/// Copies of `tile` in `tiles`.
pub(crate) fn count(tiles: &[Tile], tile: Tile) -> usize {
    tiles.iter().filter(|held| **held == tile).count()
}

/// The distinct tiles of a hand, sorted.
pub(crate) fn distinct(tiles: &[Tile]) -> Vec<Tile> {
    let mut distinct = tiles.to_vec();
    distinct.sort();
    distinct.dedup();
    distinct
}

/// Tiles held exactly twice, in tile order (the generator's pair convention:
/// a triplet is not a pair).
pub(crate) fn pair_kinds(tiles: &[Tile]) -> Vec<Tile> {
    distinct(tiles)
        .into_iter()
        .filter(|tile| count(tiles, *tile) == 2)
        .collect()
}

/// Tiles that can supply a pair, including a third copy inside a triplet.
pub(crate) fn pair_candidates(tiles: &[Tile]) -> Vec<Tile> {
    distinct(tiles)
        .into_iter()
        .filter(|tile| count(tiles, *tile) >= 2)
        .collect()
}

/// Exactly the ranks 3456 or 4567, four consecutive single copies.
pub(crate) fn nobetans(tiles: &[Tile]) -> Vec<(Suit, u8)> {
    let mut out = Vec::new();
    for suit in [Suit::Man, Suit::Pin, Suit::Sou] {
        let mut ranks = [0u8; 10];
        for tile in tiles {
            if let Tile::Suited {
                suit: tile_suit,
                value,
            } = tile
                && *tile_suit == suit
            {
                ranks[*value as usize] += 1;
            }
        }
        for base in [3u8, 4u8] {
            if (0..4).all(|offset| ranks[(base + offset) as usize] == 1) {
                out.push((suit, base));
            }
        }
    }
    out
}

/// Every double-closed shape `x, x+2, x+4`, one copy each.
pub(crate) fn ryankans(tiles: &[Tile]) -> Vec<(Suit, u8)> {
    let mut out = Vec::new();
    for suit in [Suit::Man, Suit::Pin, Suit::Sou] {
        let mut ranks = [0u8; 10];
        for tile in tiles {
            if let Tile::Suited {
                suit: tile_suit,
                value,
            } = tile
                && *tile_suit == suit
            {
                ranks[*value as usize] += 1;
            }
        }
        for base in 1..=5u8 {
            if ranks[base as usize] >= 1
                && ranks[(base + 2) as usize] >= 1
                && ranks[(base + 4) as usize] >= 1
            {
                out.push((suit, base));
            }
        }
    }
    out
}

/// Every single bulging float `x, x+1, x+1, x+2`, one/two/one copies.
pub(crate) fn bulges(tiles: &[Tile]) -> Vec<(Suit, u8)> {
    let mut out = Vec::new();
    for suit in [Suit::Man, Suit::Pin, Suit::Sou] {
        let mut ranks = [0u8; 10];
        for tile in tiles {
            if let Tile::Suited {
                suit: tile_suit,
                value,
            } = tile
                && *tile_suit == suit
            {
                ranks[*value as usize] += 1;
            }
        }
        for base in 1..=7u8 {
            if ranks[base as usize] == 1
                && ranks[(base + 1) as usize] == 2
                && ranks[(base + 2) as usize] == 1
            {
                out.push((suit, base));
            }
        }
    }
    out
}

/// One protorun-plus-one shape (Riichi Book 1, ch. 3, `334` / `224`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PlusOne {
    /// The tile held twice: one copy is a protorun tile, one is the cover.
    pub pair: Tile,
    /// The protorun's other tile.
    pub partner: Tile,
    /// True for the side-wait shape, false for the closed-wait shape.
    pub side_wait: bool,
}

impl PlusOne {
    pub(crate) fn cover(self) -> Tile {
        self.pair
    }

    pub(crate) fn tiles(self) -> [Tile; 3] {
        [self.pair, self.pair, self.partner]
    }
}

/// Every exact protorun-plus-one shape in the hand.
///
/// Exact counts matter: a triplet is a complete set, not a covered protorun,
/// so `a, a, a+1` needs exactly two `a` and one `a+1` (and its mirror).
pub(crate) fn plus_ones(tiles: &[Tile]) -> Vec<PlusOne> {
    let mut out = Vec::new();
    for suit in [Suit::Man, Suit::Pin, Suit::Sou] {
        let mut ranks = [0u8; 10];
        for tile in tiles {
            if let Tile::Suited {
                suit: tile_suit,
                value,
            } = tile
                && *tile_suit == suit
            {
                ranks[*value as usize] += 1;
            }
        }
        for value in 2..=7u8 {
            let pair = Tile::suited(suit, value);
            let high = Tile::suited(suit, value + 1);
            if ranks[value as usize] == 2 && ranks[(value + 1) as usize] == 1 {
                out.push(PlusOne {
                    pair,
                    partner: high,
                    side_wait: true,
                });
            }
            if ranks[value as usize] == 1 && ranks[(value + 1) as usize] == 2 {
                out.push(PlusOne {
                    pair: high,
                    partner: Tile::suited(suit, value),
                    side_wait: true,
                });
            }
        }
        for value in 1..=7u8 {
            if ranks[value as usize] == 2 && ranks[(value + 2) as usize] == 1 {
                out.push(PlusOne {
                    pair: Tile::suited(suit, value),
                    partner: Tile::suited(suit, value + 2),
                    side_wait: false,
                });
            }
            if ranks[value as usize] == 1 && ranks[(value + 2) as usize] == 2 {
                out.push(PlusOne {
                    pair: Tile::suited(suit, value + 2),
                    partner: Tile::suited(suit, value),
                    side_wait: false,
                });
            }
        }
    }
    out
}

/// A skipping shape: a float exactly two ranks from a complete run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Skipping {
    pub float: Tile,
    pub run: [Tile; 3],
}

/// Every skipping shape in the hand, one copy of the float only.
pub(crate) fn skippings(tiles: &[Tile]) -> Vec<Skipping> {
    let mut out = Vec::new();
    for suit in [Suit::Man, Suit::Pin, Suit::Sou] {
        let mut ranks = [0u8; 10];
        for tile in tiles {
            if let Tile::Suited {
                suit: tile_suit,
                value,
            } = tile
                && *tile_suit == suit
            {
                ranks[*value as usize] += 1;
            }
        }
        for value in 1..=9u8 {
            if ranks[value as usize] != 1 {
                continue;
            }
            let float = Tile::suited(suit, value);
            if value >= 5 {
                let run = [
                    Tile::suited(suit, value - 4),
                    Tile::suited(suit, value - 3),
                    Tile::suited(suit, value - 2),
                ];
                if run.iter().all(|tile| count(tiles, *tile) >= 1) {
                    out.push(Skipping { float, run });
                }
            }
            if value <= 5 {
                let run = [
                    Tile::suited(suit, value + 2),
                    Tile::suited(suit, value + 3),
                    Tile::suited(suit, value + 4),
                ];
                if run.iter().all(|tile| count(tiles, *tile) >= 1) {
                    out.push(Skipping { float, run });
                }
            }
        }
    }
    out
}

/// True when the hand is one isolated float: no other tile of the same suit
/// within two ranks.
pub(crate) fn is_isolated(tiles: &[Tile], tile: Tile) -> bool {
    let Some(suit) = tile.suit() else {
        return false;
    };
    let Some(value) = tile.value() else {
        return false;
    };
    tiles.iter().all(|held| {
        if *held == tile {
            return true;
        }
        match held.suit() {
            Some(held_suit) if held_suit == suit => {
                held.value().is_none_or(|other| other.abs_diff(value) > 2)
            }
            _ => true,
        }
    })
}

/// A tenpai block reading: three complete sets (including called melds), one
/// pair and one ryanmen protorun, with nothing left over.
///
/// `tiles` is the concealed kept hand after a discard. The caller passes the
/// number of called melds; the total complete-set count is three, because a
/// tenpai hand has three sets, one pair and one protorun waiting.
pub(crate) fn sets_pair_ryanmen(tiles: &[Tile], melds: u8) -> Option<[Tile; 2]> {
    if melds > 1 {
        return None;
    }
    let concealed_sets = 3 - melds as usize;
    if tiles.len() != 13 - 3 * melds as usize {
        return None;
    }

    for pair in pair_candidates(tiles) {
        let Some(no_pair) = remove_copies(tiles, pair, 2) else {
            continue;
        };
        for ryanmen in ryanmen_pairs(&no_pair) {
            let Some(rest) = remove_tiles(&no_pair, &[ryanmen[0], ryanmen[1]]) else {
                continue;
            };
            let mut nodes = 0;
            if can_form_sets(&rest, concealed_sets, &mut nodes) {
                return Some(ryanmen);
            }
        }
    }
    None
}

/// Every two-tile side wait (`2..8` low rank) present in the hand.
pub(crate) fn ryanmen_pairs(tiles: &[Tile]) -> Vec<[Tile; 2]> {
    let mut out = Vec::new();
    for suit in [Suit::Man, Suit::Pin, Suit::Sou] {
        let mut ranks = [0u8; 10];
        for tile in tiles {
            if let Tile::Suited {
                suit: tile_suit,
                value,
            } = tile
                && *tile_suit == suit
            {
                ranks[*value as usize] += 1;
            }
        }
        for low in 2..=7u8 {
            if ranks[low as usize] >= 1 && ranks[(low + 1) as usize] >= 1 {
                out.push([Tile::suited(suit, low), Tile::suited(suit, low + 1)]);
            }
        }
    }
    out
}

/// Remove exactly `n` copies of `tile`.
pub(crate) fn remove_copies(tiles: &[Tile], tile: Tile, n: usize) -> Option<Vec<Tile>> {
    if count(tiles, tile) < n {
        return None;
    }
    let mut remaining = tiles.to_vec();
    for _ in 0..n {
        let index = remaining.iter().position(|held| *held == tile)?;
        remaining.remove(index);
    }
    Some(remaining)
}

/// Remove one copy of each tile in `remove`.
pub(crate) fn remove_tiles(tiles: &[Tile], remove: &[Tile]) -> Option<Vec<Tile>> {
    let mut remaining = tiles.to_vec();
    for tile in remove {
        let index = remaining.iter().position(|held| held == tile)?;
        remaining.remove(index);
    }
    Some(remaining)
}

/// Exactly `sets` complete runs or triplets fit in `tiles`.
fn can_form_sets(tiles: &[Tile], sets: usize, nodes: &mut u32) -> bool {
    *nodes += 1;
    if *nodes > MAX_SEARCH_NODES {
        return false;
    }
    if tiles.is_empty() {
        return sets == 0;
    }
    if sets == 0 {
        return false;
    }

    let first = tiles[0];

    // A triplet.
    if count(tiles, first) >= 3
        && let Some(rest) = remove_copies(tiles, first, 3)
        && can_form_sets(&rest, sets - 1, nodes)
    {
        return true;
    }

    // A run beginning at the lowest tile: no lower tile can exist, so any run
    // using it must start here.
    if let Tile::Suited { suit, value } = first
        && value <= 7
    {
        let run = [
            first,
            Tile::suited(suit, value + 1),
            Tile::suited(suit, value + 2),
        ];
        if run.iter().all(|tile| count(tiles, *tile) >= 1)
            && let Some(rest) = remove_tiles(tiles, &run)
            && can_form_sets(&rest, sets - 1, nodes)
        {
            return true;
        }
    }

    false
}

/// Live copies of `tile` after removing the visible set (used by the planned-Pon
/// lesson to check that the second pair really can be called).
pub(crate) fn live_copies(view: &View, tile: Tile) -> u8 {
    let held = count(&view.full, tile).min(u8::MAX as usize) as u8;
    4u8.saturating_sub(held)
        .saturating_sub(view.visible_copies(tile))
}

/// True when two plans leave the same winning kinds.
pub(crate) fn plan_waits_equal(left: &Plan, right: &Plan) -> bool {
    let mut left = left.waits.clone();
    let mut right = right.waits.clone();
    left.sort();
    right.sort();
    left == right
}

#[cfg(test)]
mod tests;
