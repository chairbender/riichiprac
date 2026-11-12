//! Shared board plumbing for the block-theory lessons.

use agari::tile::Tile;

use crate::generator::support::deck::Deck;
use crate::generator::support::table::{
    ClaimPlant, OpponentDeal, RiverPlan, deal_opponents, deal_opponents_claiming,
};
use crate::state::Wind;

/// Deals the opponents with the human's open Pon backed by a real discard.
///
/// The human sits at seat 0 and every block-theory Pon was called from Shimocha
/// (seat 1), so seat 1's river has to show the tile the human took: a call
/// consumes a discard, and [`super::support::state_validation`] rejects a meld
/// with no discard behind it. The claimed copy is the fourth tile of the kind,
/// so it is reserved before the opponents draw and cannot land in an opponent's
/// hand instead.
pub(super) fn deal_with_pon_claim(
    deck: &mut Deck,
    scores: &[i32; 4],
    plan: &RiverPlan,
    pon_tiles: &[Tile],
) -> Result<OpponentDeal, String> {
    let exhausted = || "Deck exhausted drawing the opponents".to_string();
    let Some(claim) = plan
        .calls
        .iter()
        .find(|call| call.caller == 0 && call.source == 1)
    else {
        // No open meld on this board (nakabukure_ready deals both shapes).
        return deal_opponents(deck, Wind::East, scores, plan).ok_or_else(exhausted);
    };

    let tile = *pon_tiles
        .first()
        .ok_or_else(|| "the human's open Pon has no tiles".to_string())?;
    deck.take(tile)
        .map_err(|err| format!("the claimed tile has no spare copy: {err}"))?;

    deal_opponents_claiming(
        deck,
        Wind::East,
        scores,
        plan,
        &[ClaimPlant {
            source: claim.source,
            index: claim.index,
            tile,
            meld: pon_tiles.to_vec(),
        }],
    )
    .ok_or_else(exhausted)
}
