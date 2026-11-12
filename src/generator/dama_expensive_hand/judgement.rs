//! The ch. 7 "high scoring hand" dama rule, which `dama_expensive_hand`
//! grades.
//!
//! Riichi Book 1, ch. 7, "High scoring hand":
//!
//! > When your hand is already expensive without riichi (minimum of 7700 if
//! > playing with red fives; 5200 if playing without red fives), it is OK to
//! > go dama. — ch7:569
//!
//! > Note that, to justify dama your hand has to have *at least* 7700 when won
//! > by ron. This means that (1) your hand has to have at least one yaku
//! > (without it you cannot win by ron) and (2) its value is at least 7700 when
//! > winning on a tile that gives you the lowest possible score. — ch7:598
//!
//! The section closes with the box this lesson grades:
//!
//! > Riichi if you are far behind from other players. / Riichi if it is the 6th
//! > turn or before and the wait is 2-way side wait or better. / Riichi if it
//! > is the 10th turn or before and the wait is 3-way side wait or better. /
//! > Don't riichi if the minimum hand value is haneman or better. — ch7:641-646
//!
//! The generator holds the two "riichi anyway" timing exceptions off (in front,
//! past the 6th turn), so the section's two dama cells decide: 7700-or-better
//! makes dama acceptable, and haneman-or-better forbids the declaration
//! outright. Both verdicts are computed from the *minimum* ron value over every
//! winning tile of the wait, exactly as ch7:598 asks.

use crate::state::DamaReason;

/// The book's expensive-hand cut-point with red fives (ch7:569).
pub(super) const EXPENSIVE_MIN_POINTS: u32 = 7_700;

/// Haneman ron for a non-dealer: "Don't riichi if the minimum hand value is
/// haneman or better" (ch7:646).
pub(super) const HANEMAN_MIN_POINTS: u32 = 12_000;

/// The section's verdict for one hand, from its worst winning tile.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Verdict {
    /// At least 7700 but below haneman: dama is the book's acceptable play.
    DamaExpensive,
    /// Haneman or better at every winning tile: the book says do not riichi.
    DamaHaneman,
}

impl Verdict {
    /// The dama reasons that explain this verdict.
    pub(super) fn dama_reasons(self) -> Vec<DamaReason> {
        match self {
            Self::DamaExpensive => vec![DamaReason::Mangan],
            Self::DamaHaneman => vec![DamaReason::HanemanPlus],
        }
    }
}

/// Applies the section to the hand's minimum ron value without Riichi.
///
/// Returns `None` when the hand is not expensive enough: its dama cell only
/// starts at 7700 (ch7:569, ch7:598).
pub(super) fn verdict(min_points: u32) -> Option<Verdict> {
    if min_points >= HANEMAN_MIN_POINTS {
        Some(Verdict::DamaHaneman)
    } else if min_points >= EXPENSIVE_MIN_POINTS {
        Some(Verdict::DamaExpensive)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_two_dama_cells_follow_the_book_thresholds() {
        assert_eq!(verdict(7_700), Some(Verdict::DamaExpensive));
        assert_eq!(verdict(8_000), Some(Verdict::DamaExpensive));
        assert_eq!(verdict(11_999), Some(Verdict::DamaExpensive));
        assert_eq!(verdict(12_000), Some(Verdict::DamaHaneman));
        assert_eq!(verdict(24_000), Some(Verdict::DamaHaneman));
    }

    #[test]
    fn a_hand_below_7700_is_not_this_lessons_case() {
        assert_eq!(verdict(7_699), None);
        assert_eq!(verdict(5_200), None);
        assert_eq!(verdict(0), None);
    }

    #[test]
    fn haneman_cites_the_no_riichi_rule_and_7700_the_acceptable_dama_rule() {
        assert_eq!(
            Verdict::DamaExpensive.dama_reasons(),
            vec![DamaReason::Mangan]
        );
        assert_eq!(
            Verdict::DamaHaneman.dama_reasons(),
            vec![DamaReason::HanemanPlus]
        );
    }
}
