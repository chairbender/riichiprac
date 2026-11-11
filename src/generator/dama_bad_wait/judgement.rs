//! The ch. 7 "bad wait" dama box, which the `dama_bad_wait` lesson grades.
//!
//! Riichi Book 1, ch. 7, "Bad wait", §1 "The number of winning tiles left":
//!
//! > Call riichi if there are three or more winning tiles left in the board.
//! > Go dama if there are only one or two simple tiles left to win on.
//! > (When waiting for an honor/terminal tile, you can call riichi even when
//! > only one tile is left in the board.) — ch7:521-522
//!
//! The count is over *live* tiles, exactly as the section's title asks:
//! "keep in mind that you should count the kinds and the number of live tiles
//! to win on, not merely the ideal numbers suggested by the hand shape"
//! (ch7:491).
//!
//! The general three-condition rule (ch7:55-59) forbids a bad-wait riichi-only
//! hand by a non-dealer. This box is the one case that overrides it, so the
//! lesson holds the other conditions at their dama values and lets the live
//! tile count — or the honor/terminal footnote — decide.

use agari::tile::Tile;

use crate::state::{DamaReason, RiichiTrigger};

/// Three live winning tiles is the box's riichi threshold (ch7:521).
pub(super) const RIICHI_MIN_LIVE_TILES: u8 = 3;

/// The box's verdict for one wait.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Verdict {
    /// At least three live winning tiles: call riichi (ch7:521).
    ThreeLiveTiles,
    /// One or two live tiles on an honor/terminal wait: riichi anyway
    /// (ch7:522 footnote).
    HonorTerminalWait,
    /// One or two live simple tiles: stay dama (ch7:522).
    DamaFewSimpleTiles,
}

impl Verdict {
    /// True when the box tells the player to declare Riichi.
    pub(super) fn picks_riichi(self) -> bool {
        !matches!(self, Self::DamaFewSimpleTiles)
    }

    /// The trigger that explains a riichi answer.
    pub(super) fn trigger(self) -> Option<RiichiTrigger> {
        match self {
            Self::ThreeLiveTiles => Some(RiichiTrigger::ThreeLiveWinningTiles),
            Self::HonorTerminalWait => Some(RiichiTrigger::HonorTerminalWait),
            Self::DamaFewSimpleTiles => None,
        }
    }
}

/// Applies the box to a bad wait and its live tile count.
///
/// The count comes from the riichi-judgement `wait_quality` helper, which
/// subtracts the hand's own copies and every table-visible copy. A wait with
/// two kinds (the dual pon wait) still counts only the live tiles in total.
pub(super) fn verdict(wait_tiles: &[Tile], live_tiles: u8) -> Verdict {
    if live_tiles >= RIICHI_MIN_LIVE_TILES {
        Verdict::ThreeLiveTiles
    } else if live_tiles >= 1 && wait_tiles.iter().any(|tile| tile.is_terminal_or_honor()) {
        Verdict::HonorTerminalWait
    } else {
        Verdict::DamaFewSimpleTiles
    }
}

/// The dama reasons for the box's 1-2 simple tile case.
///
/// The general rule's failures come first, then the box's own reason:
/// riichi-only and non-dealer are what make the general rule say dama, and the
/// small live-tile count is what keeps it dama under this section.
pub(super) fn dama_reasons() -> Vec<DamaReason> {
    vec![
        DamaReason::NotDealer,
        DamaReason::BadWait,
        DamaReason::NoExtraHan,
        DamaReason::FewLiveWinningTiles,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generator::support::testing::parse_tile;

    #[test]
    fn three_or_more_live_tiles_call_riichi() {
        for live in 3..=4 {
            assert_eq!(
                verdict(&[parse_tile("3m")], live),
                Verdict::ThreeLiveTiles,
                "live {live}"
            );
            assert!(verdict(&[parse_tile("3m")], live).picks_riichi());
        }
    }

    #[test]
    fn one_or_two_live_simples_stay_dama() {
        for live in 1..=2 {
            let verdict = verdict(&[parse_tile("5p")], live);
            assert_eq!(verdict, Verdict::DamaFewSimpleTiles, "live {live}");
            assert!(!verdict.picks_riichi());
            assert!(verdict.trigger().is_none());
        }
    }

    #[test]
    fn one_or_two_live_honors_and_terminals_still_call_riichi() {
        for tile in ["1m", "9s", "1z", "5z"] {
            for live in 1..=2 {
                let verdict = verdict(&[parse_tile(tile)], live);
                assert_eq!(verdict, Verdict::HonorTerminalWait, "{tile} live {live}");
                assert!(verdict.picks_riichi());
                assert_eq!(verdict.trigger(), Some(RiichiTrigger::HonorTerminalWait));
            }
        }
    }

    #[test]
    fn a_dead_wait_is_not_rescued_by_the_honor_footnote() {
        assert_eq!(verdict(&[parse_tile("1z")], 0), Verdict::DamaFewSimpleTiles);
    }

    #[test]
    fn the_dama_answer_cites_the_box_after_the_general_rule() {
        assert_eq!(
            dama_reasons(),
            vec![
                DamaReason::NotDealer,
                DamaReason::BadWait,
                DamaReason::NoExtraHan,
                DamaReason::FewLiveWinningTiles,
            ]
        );
    }

    #[test]
    fn a_plain_honor_tanki_hand_is_riichi_only() {
        use agari::parse::parse_hand;

        use crate::generator::riichi_judgement::judgement as riichi;
        use crate::state::Wind;

        // Three terminal runs, a middle run, and a lone East wind waiting to
        // pair. No yaku: not ittsu (the runs are in different suits), not
        // tanyao (terminals), not pinfu (the pair wait is not two-sided).
        let tenpai = parse_hand("123m789s123p456p1z").expect("hand must parse");
        assert_eq!(
            riichi::min_han_without_riichi(
                &tenpai,
                &[parse_tile("1z")],
                Wind::East,
                Wind::South,
                &[],
            ),
            0
        );
    }
}
