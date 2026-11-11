use agari::parse::to_counts;
use agari::tile::Tile;

use super::triggers::RiichiTriggerSet;

/// Whether a chiitoitsu puzzle asks for Riichi or a dama declaration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ChiitoitsuDecision {
    Riichi,
    Dama,
}

/// A chiitoitsu hand one draw away from six pairs.
///
/// The 13-tile hand before the draw is five pairs plus three lone tiles. The
/// drawn tile is the second copy of [`ChiitoitsuSkeleton::drawn_tile`], so it
/// completes the sixth pair and the hand becomes tenpai on this draw only.
/// Two lone tiles remain. Discarding [`ChiitoitsuSkeleton::discard_tile`]
/// waits on [`ChiitoitsuSkeleton::wait_tile`]; discarding the wait instead
/// leaves the mirror wait on the discard tile. Both are real seven-pairs
/// tenpai hands, so both discards are accepted answers.
///
/// The generator constrains the hand so that the Riichi/dama judgement is the
/// same for either wait. The lesson therefore stays about the declaration, not
/// about ranking two single waits.
pub(super) struct ChiitoitsuSkeleton {
    /// Five distinct pair tiles.
    pub pairs: Vec<Tile>,
    /// The lone tile that the draw completes into the sixth pair.
    pub drawn_tile: Tile,
    /// The lone tile kept as the wait when `discard_tile` is discarded.
    pub wait_tile: Tile,
    /// The other lone tile, named by `correct_action` as the discard.
    pub discard_tile: Tile,
    /// Whether the correct answer is Riichi or dama.
    pub decision: ChiitoitsuDecision,
    /// Whether the lone tiles are red fives (Riichi path only).
    pub red_five_wait: bool,
    /// Heuristics that justify Riichi (empty on the dama path).
    pub triggers: RiichiTriggerSet,
    /// Dama path: two pair tiles that are made dora by the indicators.
    pub dora_pairs: Vec<Tile>,
}

impl ChiitoitsuSkeleton {
    /// Both lone tiles, which are the two accepted discards.
    pub(super) fn waits(&self) -> [Tile; 2] {
        [self.wait_tile, self.discard_tile]
    }

    /// Full 14-tile hand after the draw (five pairs, the completed pair, and
    /// the two lone tiles).
    pub(super) fn full_tiles(&self) -> Vec<Tile> {
        let mut tiles = Vec::with_capacity(14);
        for &pair in &self.pairs {
            tiles.push(pair);
            tiles.push(pair);
        }
        tiles.push(self.drawn_tile);
        tiles.push(self.drawn_tile);
        tiles.push(self.wait_tile);
        tiles.push(self.discard_tile);
        tiles
    }

    /// The 13-tile hand before the draw, which is what the state displays in
    /// `PlayerState::hand`.
    pub(super) fn pre_draw_tiles(&self) -> Vec<Tile> {
        let mut tiles = Vec::with_capacity(13);
        for &pair in &self.pairs {
            tiles.push(pair);
            tiles.push(pair);
        }
        tiles.push(self.drawn_tile);
        tiles.push(self.wait_tile);
        tiles.push(self.discard_tile);
        tiles
    }

    /// The 13-tile tenpai hand after discarding the lone tile that is not
    /// `wait_tile`.
    pub(super) fn tenpai_tiles(&self, wait_tile: Tile) -> Vec<Tile> {
        let mut tiles = Vec::with_capacity(13);
        for &pair in &self.pairs {
            tiles.push(pair);
            tiles.push(pair);
        }
        tiles.push(self.drawn_tile);
        tiles.push(self.drawn_tile);
        tiles.push(wait_tile);
        tiles
    }

    /// The 14-tile winning hand completed on `wait_tile`.
    pub(super) fn winning_tiles(&self, wait_tile: Tile) -> Vec<Tile> {
        let mut tiles = self.tenpai_tiles(wait_tile);
        tiles.push(wait_tile);
        tiles
    }
}

/// True when a 13-tile hand is exactly six pairs plus the intended singleton.
pub(super) fn has_six_pairs_and_singleton(tiles: &[Tile], wait_tile: Tile) -> bool {
    let counts = to_counts(tiles);
    if counts.len() != 7 {
        return false;
    }

    let mut pairs = 0;
    let mut singletons = 0;
    for &count in counts.values() {
        match count {
            2 => pairs += 1,
            1 => singletons += 1,
            _ => return false,
        }
    }

    pairs == 6 && singletons == 1 && counts.get(&wait_tile) == Some(&1)
}

/// True when a 13-tile hand is exactly five pairs plus three lone tiles.
pub(super) fn has_five_pairs_and_three_singletons(tiles: &[Tile]) -> bool {
    let counts = to_counts(tiles);
    if counts.len() != 8 {
        return false;
    }

    let mut pairs = 0;
    let mut singletons = 0;
    for &count in counts.values() {
        match count {
            2 => pairs += 1,
            1 => singletons += 1,
            _ => return false,
        }
    }

    pairs == 5 && singletons == 3
}
