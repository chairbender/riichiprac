use agari::tile::{Honor, Suit, Tile};

/// Formats a list of tiles into standard compact Mahjong notation (e.g. "123m456p789s11122z").
pub fn format_hand_compact(tiles: &[Tile]) -> String {
    let mut sorted = tiles.to_vec();
    sorted.sort();

    let mut result = String::new();
    let mut m_vals = Vec::new();
    let mut p_vals = Vec::new();
    let mut s_vals = Vec::new();
    let mut z_vals = Vec::new();

    for tile in sorted {
        match tile {
            Tile::Suited {
                suit: Suit::Man,
                value,
            } => m_vals.push(value),
            Tile::Suited {
                suit: Suit::Pin,
                value,
            } => p_vals.push(value),
            Tile::Suited {
                suit: Suit::Sou,
                value,
            } => s_vals.push(value),
            Tile::Honor(h) => {
                let v = match h {
                    Honor::East => 1,
                    Honor::South => 2,
                    Honor::West => 3,
                    Honor::North => 4,
                    Honor::White => 5,
                    Honor::Green => 6,
                    Honor::Red => 7,
                };
                z_vals.push(v);
            }
        }
    }

    if !m_vals.is_empty() {
        for v in m_vals {
            result.push_str(&v.to_string());
        }
        result.push('m');
    }
    if !p_vals.is_empty() {
        for v in p_vals {
            result.push_str(&v.to_string());
        }
        result.push('p');
    }
    if !s_vals.is_empty() {
        for v in s_vals {
            result.push_str(&v.to_string());
        }
        result.push('s');
    }
    if !z_vals.is_empty() {
        for v in z_vals {
            result.push_str(&v.to_string());
        }
        result.push('z');
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use agari::parse::parse_hand;

    #[test]
    fn compact_format_round_trips_through_agari() {
        let tiles = parse_hand("123m456p789s11122z").expect("hand must parse");
        let compact = format_hand_compact(&tiles);

        assert_eq!(compact, "123m456p789s11122z");
        assert_eq!(parse_hand(&compact).expect("compact must parse").len(), 14);
    }
}
