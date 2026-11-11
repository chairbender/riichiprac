//! The ch. 7 "Genbutsu wait" dama section, which the `dama_genbutsu_wait`
//! lesson grades.
//!
//! Riichi Book 1, ch. 7, "Genbutsu wait":
//!
//! > The third case where going dama is OK is when another player is already
//! > getting a lot of attention from others (e.g., riichi, dora pon, or
//! > honitsu) and one of your winning tiles is among their genbutsu tiles.
//! > — ch7:538-539
//!
//! and the example that follows the section:
//!
//! > Suppose further that you manage to make your hand ready for pinfu, waiting
//! > for souzu 3 - souzu 6. Then, you should keep the hand dama, as souzu 6 is
//! > one of the dealer's genbutsu tiles. There is a good chance that the other
//! > two players fold against the dealer completely and try to discard nothing
//! > but their genbutsu tiles. — ch7:558
//!
//! The reason is the folding behaviour, not the wait's own tile count: the
//! players behind the threat want to throw tiles the threat cannot ron, and
//! those are exactly the threat's genbutsu. A winning tile that is the threat's
//! genbutsu is therefore likely to be discarded, so the hand keeps its value
//! without the Riichi that would warn the table.
//!
//! This is an exception to the general ch7.1 rule, which would pick Riichi for
//! the book's own example (pinfu plus a good wait). The lesson therefore builds
//! the book's hand: closed, pinfu, side wait, with exactly one winning tile
//! already in the threatening player's river.

use agari::tile::Tile;

use crate::safety::SafetyFacts;
use crate::state::DamaReason;

/// The winning tiles that are the threatening player's genbutsu, in tile order.
///
/// The safety facts already carry every genbutsu kind the book names: the
/// threat's own river and anything anyone discarded after the threat declared
/// Riichi (ch. 8, "Genbutsu and other absolutely safe tiles").
pub(super) fn genbutsu_waits(wait_tiles: &[Tile], facts: &SafetyFacts) -> Vec<Tile> {
    let mut waits: Vec<Tile> = wait_tiles
        .iter()
        .copied()
        .filter(|tile| facts.is_genbutsu(*tile))
        .collect();
    waits.sort();
    waits.dedup();
    waits
}

/// True when the section's case applies.
///
/// At least one winning tile must be the threat's genbutsu (ch7:539) and at
/// least one must not be: a wait whose every winning tile is already genbutsu is
/// dead, and the answer would be to change the wait, not to go dama.
pub(super) fn applies(wait_tiles: &[Tile], facts: &SafetyFacts) -> bool {
    !genbutsu_waits(wait_tiles, facts).is_empty()
        && wait_tiles.iter().any(|tile| !facts.is_genbutsu(*tile))
}

/// The dama reasons for the section's case.
///
/// The general rule's other conditions are *not* cited: this hand has a han and
/// a good wait, so `no_extra_han` and `bad_wait` would both be false. The
/// genbutsu wait is the whole reason the book keeps the hand concealed.
pub(super) fn dama_reasons() -> Vec<DamaReason> {
    vec![DamaReason::GenbutsuWait]
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use crate::generator::support::testing::parse_tile;
    use crate::state::Wind;

    use super::*;

    fn facts(genbutsu: &[&str]) -> SafetyFacts {
        let river = genbutsu.iter().map(|code| parse_tile(code)).collect();
        SafetyFacts::new(Wind::East, Wind::South, river, HashMap::new())
    }

    #[test]
    fn one_genbutsu_winning_tile_is_enough_to_stay_dama() {
        let facts = facts(&["6s", "1p"]);
        let waits = [parse_tile("3s"), parse_tile("6s")];

        assert!(applies(&waits, &facts));
        assert_eq!(genbutsu_waits(&waits, &facts), vec![parse_tile("6s")]);
        assert_eq!(dama_reasons(), vec![DamaReason::GenbutsuWait]);
    }

    #[test]
    fn a_wait_with_no_genbutsu_tile_is_a_riichi_hand() {
        let facts = facts(&["6s", "1p"]);
        let waits = [parse_tile("3s"), parse_tile("4s")];

        assert!(!applies(&waits, &facts));
        assert!(genbutsu_waits(&waits, &facts).is_empty());
    }

    #[test]
    fn a_dead_wait_is_not_the_section_case() {
        // Both winning tiles are the threat's genbutsu: there is no live side
        // of the wait to win on, so the hand needs a wait change, not dama.
        let facts = facts(&["3s", "6s"]);
        let waits = [parse_tile("3s"), parse_tile("6s")];

        assert!(!applies(&waits, &facts));
        assert_eq!(
            genbutsu_waits(&waits, &facts),
            vec![parse_tile("3s"), parse_tile("6s")]
        );
    }
}
