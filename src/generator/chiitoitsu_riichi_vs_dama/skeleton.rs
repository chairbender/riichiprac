use agari::parse::to_counts;
use agari::tile::Tile;

use super::triggers::RiichiTriggerSet;

/// Whether a chiitoitsu puzzle asks for Riichi or a dama declaration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ChiitoitsuDecision {
    Riichi,
    Dama,
}

/// A six-pair chiitoitsu hand before the extra singleton is discarded.
pub(super) struct ChiitoitsuSkeleton {
    /// Six distinct pair tiles.
    pub pairs: Vec<Tile>,
    /// The singleton that stays in hand and becomes the winning wait.
    pub wait_tile: Tile,
    /// The unwanted singleton that should be discarded.
    pub discard_tile: Tile,
    /// Whether the correct answer is Riichi or dama.
    pub decision: ChiitoitsuDecision,
    /// Whether the wait singleton is a red five (Riichi path only).
    pub red_five_wait: bool,
    /// Heuristics that justify Riichi (empty on the dama path).
    pub triggers: RiichiTriggerSet,
    /// Dama path: two pair tiles that are made dora by the indicators.
    pub dora_pairs: Vec<Tile>,
}

impl ChiitoitsuSkeleton {
    /// Full 14-tile hand before the discard (six pairs + two singletons).
    pub(super) fn full_tiles(&self) -> Vec<Tile> {
        let mut tiles = Vec::with_capacity(14);
        for &pair in &self.pairs {
            tiles.push(pair);
            tiles.push(pair);
        }
        tiles.push(self.wait_tile);
        tiles.push(self.discard_tile);
        tiles
    }

    /// The 13-tile tenpai hand after discarding the unwanted singleton.
    pub(super) fn tenpai_tiles(&self) -> Vec<Tile> {
        let mut tiles = Vec::with_capacity(13);
        for &pair in &self.pairs {
            tiles.push(pair);
            tiles.push(pair);
        }
        tiles.push(self.wait_tile);
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
