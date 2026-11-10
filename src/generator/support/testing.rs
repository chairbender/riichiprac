use agari::parse::parse_hand;
use agari::tile::Tile;

/// Parses a single tile code such as "5p" in tests.
pub(crate) fn parse_tile(code: &str) -> Tile {
    parse_hand(code).expect("tile code must parse").remove(0)
}
