use agari::context::{GameContext, WinType};
use agari::hand::{Meld, decompose_hand_with_melds};
use agari::parse::to_counts;
use agari::tile::{Honor, Tile};
use agari::yaku::detect_yaku_with_context;

pub(crate) fn min_wait_han(
    concealed_tiles: &[Tile],
    open_pon_tile: Tile,
    wait_tiles: &[Tile],
) -> u8 {
    let open_meld = Meld::koutsu_open(open_pon_tile);
    let mut min_han = u8::MAX;

    for &wait_tile in wait_tiles {
        let mut concealed_with_win = concealed_tiles.to_vec();
        concealed_with_win.push(wait_tile);
        let concealed_counts = to_counts(&concealed_with_win);
        let structures =
            decompose_hand_with_melds(&concealed_counts, std::slice::from_ref(&open_meld));
        if structures.is_empty() {
            return 0;
        }

        let mut full_with_win = concealed_with_win;
        full_with_win.extend([open_pon_tile; 3]);
        let full_counts = to_counts(&full_with_win);
        let context = GameContext::new(WinType::Ron, Honor::East, Honor::East)
            .with_winning_tile(wait_tile)
            .open();

        let han = structures
            .iter()
            .map(|structure| detect_yaku_with_context(structure, &full_counts, &context).total_han)
            .min()
            .unwrap_or(0);
        min_han = min_han.min(han);
    }

    if wait_tiles.is_empty() { 0 } else { min_han }
}

/// Verifies every winning tile scores at least `min_han` before Kan dora.
pub(crate) fn waits_have_value(
    concealed_tiles: &[Tile],
    open_pon_tile: Tile,
    wait_tiles: &[Tile],
    min_han: u8,
) -> bool {
    min_wait_han(concealed_tiles, open_pon_tile, wait_tiles) >= min_han
}
