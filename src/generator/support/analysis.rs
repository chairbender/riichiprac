use std::collections::HashMap;

use agari::context::indicator_to_dora;
use agari::hand::decompose_hand;
use agari::parse::to_counts;
use agari::shanten::{calculate_shanten, calculate_ukeire};
use agari::tile::{Honor, Tile};

use crate::state::Wind;

/// Summary of a hand as evaluated by `agari`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandMetrics {
    pub shanten: i8,
    pub is_agari: bool,
    pub decompositions_count: usize,
    pub ukeire_tiles: Vec<String>,
    pub ukeire_total: u8,
}

/// Evaluates an arbitrary tile collection.
pub fn evaluate_hand(tiles: &[Tile]) -> HandMetrics {
    evaluate_counts(&to_counts(tiles))
}

/// Evaluates an existing tile-count map.
pub fn evaluate_counts(counts: &HashMap<Tile, u8>) -> HandMetrics {
    let shanten = calculate_shanten(counts);
    let decompositions = decompose_hand(counts);
    let ukeire = calculate_ukeire(counts);

    HandMetrics {
        shanten: shanten.shanten,
        is_agari: shanten.shanten == -1,
        decompositions_count: decompositions.len(),
        ukeire_tiles: ukeire.tiles.iter().map(|u| u.tile.to_string()).collect(),
        ukeire_total: ukeire.total_count,
    }
}

/// Converts a seat/round wind into the honor used by agari's game context.
pub fn wind_to_honor(wind: Wind) -> Honor {
    match wind {
        Wind::East => Honor::East,
        Wind::South => Honor::South,
        Wind::West => Honor::West,
        Wind::North => Honor::North,
    }
}

/// Counts regular dora in a final winning hand for one indicator.
pub fn regular_dora_in_hand(winning_tiles: &[Tile], indicator: Tile) -> u8 {
    let dora = indicator_to_dora(indicator);
    winning_tiles
        .iter()
        .filter(|tile| **tile == dora)
        .count()
        .min(u8::MAX as usize) as u8
}

/// Counts every visible tile across rivers and indicators.
pub fn visible_tile_counts(rivers: &[Vec<Tile>], indicators: &[Tile]) -> HashMap<Tile, u8> {
    let mut counts: HashMap<Tile, u8> = HashMap::new();
    for river in rivers {
        for &tile in river {
            *counts.entry(tile).or_insert(0) += 1;
        }
    }
    for &indicator in indicators {
        *counts.entry(indicator).or_insert(0) += 1;
    }
    counts
}

#[cfg(test)]
mod tests {
    use super::*;
    use agari::parse::parse_hand;

    #[test]
    fn hand_metrics_match_agari_results() {
        let tiles = parse_hand("123m456p789s11122z").expect("hand must parse");
        let metrics = evaluate_hand(&tiles);

        assert_eq!(metrics.shanten, -1);
        assert!(metrics.is_agari);
        assert!(metrics.decompositions_count > 0);
    }

    #[test]
    fn regular_dora_counts_each_copy() {
        let tiles = parse_hand("111m22p").expect("hand must parse");
        let indicator = parse_hand("9m").expect("indicator must parse")[0];

        assert_eq!(regular_dora_in_hand(&tiles, indicator), 3);
    }

    #[test]
    fn visible_counts_include_rivers_and_indicators() {
        let east = parse_hand("1z").expect("tile must parse")[0];
        let south = parse_hand("2z").expect("tile must parse")[0];
        let counts = visible_tile_counts(&[vec![east, east]], &[south]);

        assert_eq!(counts.get(&east), Some(&2));
        assert_eq!(counts.get(&south), Some(&1));
    }
}
