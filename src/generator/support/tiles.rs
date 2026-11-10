use agari::tile::Tile;

/// True when the tile is not a 4, 5, or 6, including every honor tile.
pub fn is_outside_456(tile: Tile) -> bool {
    match tile.value() {
        Some(value) => !(4..=6).contains(&value),
        None => true,
    }
}

/// Suji tiles for a wait: the same-suit tiles three ranks away.
///
/// Waiting on 2 makes 5 safe, waiting on 5 makes 2 and 8 safe, and so on.
pub fn suji_tiles(tile: Tile) -> Vec<Tile> {
    let (Some(suit), Some(value)) = (tile.suit(), tile.value()) else {
        return Vec::new();
    };

    let mut suji = Vec::with_capacity(2);
    if value > 3 {
        suji.push(Tile::suited(suit, value - 3));
    }
    if value + 3 <= 9 {
        suji.push(Tile::suited(suit, value + 3));
    }
    suji
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outside_456_rejects_middle_tiles_and_honors() {
        let two = Tile::suited(agari::tile::Suit::Man, 2);
        let five = Tile::suited(agari::tile::Suit::Man, 5);
        let east = Tile::Honor(agari::tile::Honor::East);

        assert!(is_outside_456(two));
        assert!(!is_outside_456(five));
        assert!(is_outside_456(east));
    }

    #[test]
    fn suji_tiles_are_three_ranks_away() {
        let five = Tile::suited(agari::tile::Suit::Pin, 5);
        let suji = suji_tiles(five);

        assert!(suji.contains(&Tile::suited(agari::tile::Suit::Pin, 2)));
        assert!(suji.contains(&Tile::suited(agari::tile::Suit::Pin, 8)));
    }
}
