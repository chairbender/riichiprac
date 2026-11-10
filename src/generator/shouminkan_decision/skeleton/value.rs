use agari::context::{GameContext, WinType};
use agari::hand::{Meld, decompose_hand_with_melds};
use agari::parse::to_counts;
use agari::scoring::{calculate_basic_points, calculate_payment};
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

/// Fu from the open meld: an open Pon of honors is 4, an added Kan of honors
/// is 16. Everything else is deliberately left out.
const BASE_FU: u8 = 20;
const OPEN_HONOR_PON_FU: u8 = 4;
const OPEN_HONOR_KAN_FU: u8 = 16;

/// The lowest fu this hand can win for.
///
/// Only the parts every completion shares are counted: the 20 base and the open
/// meld, rounded up to the next ten. Pair, wait and triplet bonuses are left
/// out on purpose so the number is a floor, not an average.
pub(crate) fn min_fu(kan: bool) -> u8 {
    let meld = if kan {
        OPEN_HONOR_KAN_FU
    } else {
        OPEN_HONOR_PON_FU
    };
    (BASE_FU + meld).div_ceil(10) * 10
}

/// Non-dealer ron value of `han` at `fu`, rounded the way the table pays it.
pub(crate) fn ron_value(han: u8, fu: u8) -> u32 {
    let basic = calculate_basic_points(han, fu, false);
    calculate_payment(basic, false, WinType::Ron).total
}

/// The point window that makes an Added Kan decide the placement.
///
/// `dama` is what the hand wins for while the Pon stays a Pon, `kan` is the
/// same hand once the fourth tile joins it. Keeping the Pon leaves the hand
/// short of `dama`..`kan`, so only the Kan's extra minipoints close the gap to
/// the player above. Riichi Book 1, ch. 9 makes the same argument for its
/// 2-away example: "as the hand will have at least 60 minipoints, you can get
/// 2000 points with one han".
///
/// The Kan's *other* benefits are deliberately ignored, which makes this a
/// conservative floor:
///
/// - the new dora indicator (it may add han, it may also add nothing),
/// - the rinshan draw, which mostly buys win probability rather than points,
/// - the Kan's effect on the opponents' scores when the hand is won by tsumo.
///
/// TODO: replace this arithmetic with a real EV comparison. `crate::ai::sp`
/// now carries a port of libriichi's single-player calculator, so both lines
/// (keep the Pon / take the Kan) could be scored with their true expected
/// values, including dora and rinshan, instead of the guaranteed-minipoints
/// bound used here. That would also let the generator *rank* candidate boards
/// by how decisive the Kan is rather than only rejecting the ones where the
/// arithmetic does not work out.
///
/// Returns `None` when the hand has no guaranteed yaku at all, or when the Kan
/// raises the value by nothing at this fu/han; either way no placement gap can
/// be built.
pub(crate) fn placement_window(min_han: u8) -> Option<PlacementWindow> {
    if min_han == 0 {
        return None;
    }

    let dama = ron_value(min_han, min_fu(false));
    let kan = ron_value(min_han, min_fu(true));
    (kan > dama).then_some(PlacementWindow { dama, kan })
}

/// The two point values a placement decision trades between.
pub(crate) struct PlacementWindow {
    /// Win value while the Pon stays a Pon.
    pub dama: u32,
    /// Win value with the fourth tile added to the Pon.
    pub kan: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_kan_raises_fu_but_not_han() {
        // Open Pon of honors 4 fu, open Kan of honors 16 fu, both rounded up.
        assert_eq!(min_fu(false), 30);
        assert_eq!(min_fu(true), 40);
    }

    #[test]
    fn placement_windows_match_the_book_arithmetic() {
        // Riichi Book 1, ch. 9: "you can get 2000 points with one han" once the
        // hand carries 60 minipoints. Our floor is 40 fu, so 1 han pays 1300
        // and the window is the band between the Pon's hand and the Kan's.
        let one_han = placement_window(1).expect("one han has a window");
        assert_eq!((one_han.dama, one_han.kan), (1_000, 1_300));

        let two_han = placement_window(2).expect("two han has a window");
        assert_eq!((two_han.dama, two_han.kan), (2_000, 2_600));

        assert!(placement_window(0).is_none(), "no han is no hand");
    }

    #[test]
    fn ron_values_round_like_the_table() {
        assert_eq!(ron_value(1, 30), 1_000);
        assert_eq!(ron_value(1, 40), 1_300);
        assert_eq!(ron_value(2, 40), 2_600);
        assert_eq!(ron_value(3, 40), 5_200);
    }
}
