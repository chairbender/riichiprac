//! Friendly tile names for text that reaches the player.
//!
//! The data model keeps the compact `1m`..`7z` codes, and those stay in JSON
//! fields, scenario ids, and comparison logic. This module is the single place
//! that turns a code into what the UI prints:
//!
//! - honours use the book's shorthand: winds `E S W N` (`1z`..`4z`) and
//!   dragons `Wh G R` for `5z`..`7z` (Haku, Hatsu, Chun), with the lowercase
//!   `h` on Haku;
//! - a red five prints as `R5s`, `R5p`, or `R5m`;
//! - every other code passes through unchanged.

/// Friendly name for one tile code.
///
/// Set `red_five` only for an actual aka-dora copy; number tiles otherwise keep
/// their plain code (for example `5s`).
pub fn format_tile_for_display(code: &str, red_five: bool) -> String {
    if red_five
        && let Some(suit) = code.strip_prefix('5')
        && matches!(suit, "m" | "p" | "s")
    {
        return format!("R5{suit}");
    }

    match code {
        "1z" => "E".to_string(),
        "2z" => "S".to_string(),
        "3z" => "W".to_string(),
        "4z" => "N".to_string(),
        "5z" => "Wh".to_string(),
        "6z" => "G".to_string(),
        "7z" => "R".to_string(),
        other => other.to_string(),
    }
}

/// Friendly name for a Mortal discard tile, which marks a red five with a
/// trailing `r` (`5sr`).
pub fn format_mortal_tile_for_display(tile: &str) -> String {
    match tile.strip_suffix('r') {
        Some(base) => format_tile_for_display(base, true),
        None => format_tile_for_display(tile, false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn honours_use_the_book_shorthand() {
        let pairs = [
            ("1z", "E"),
            ("2z", "S"),
            ("3z", "W"),
            ("4z", "N"),
            ("5z", "Wh"),
            ("6z", "G"),
            ("7z", "R"),
        ];

        for (code, name) in pairs {
            assert_eq!(format_tile_for_display(code, false), name);
        }
        assert_eq!(
            ["1z", "2z", "3z", "4z", "5z", "6z", "7z"]
                .map(|code| format_tile_for_display(code, false))
                .concat(),
            "ESWNWhGR"
        );
    }

    #[test]
    fn dragons_render_wh_for_haku_and_r_for_chun() {
        assert_eq!(format_tile_for_display("5z", false), "Wh");
        assert_eq!(format_tile_for_display("6z", false), "G");
        assert_eq!(format_tile_for_display("7z", false), "R");
    }

    #[test]
    fn numbered_tiles_pass_through() {
        assert_eq!(format_tile_for_display("3m", false), "3m");
        assert_eq!(format_tile_for_display("5s", false), "5s");
        assert_eq!(format_tile_for_display("9p", false), "9p");
    }

    #[test]
    fn red_fives_use_the_r5_name() {
        assert_eq!(format_tile_for_display("5s", true), "R5s");
        assert_eq!(format_tile_for_display("5p", true), "R5p");
        assert_eq!(format_tile_for_display("5m", true), "R5m");
    }

    #[test]
    fn mortal_suffix_marks_the_red_five() {
        assert_eq!(format_mortal_tile_for_display("5sr"), "R5s");
        assert_eq!(format_mortal_tile_for_display("5s"), "5s");
        assert_eq!(format_mortal_tile_for_display("1z"), "E");
    }
}
