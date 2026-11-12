mod board;
mod skeleton;

use crate::generator::support::retry::generate_with_retries;
use crate::state::GameState;

/// Generates the "bulging float" lesson: a hand holding a nakabukure
/// (bulging float) block, with the book's answer depending on the hand.
///
/// Riichi Book 1 warns both ways, so the drill cannot be answered by
/// pattern-matching the shape's name:
///
/// - "Try to keep a bulging float shape until a hand becomes 1-away."
///   (ch3:708). In a 1-away hand with weak rivals the book keeps the shape and
///   throws a tile from a rival pair (ch4:694).
/// - "It is waiting for wan4, but we are already using two of it in the hand,
///   leaving only two winning tiles. We should rather discard wan4 to wait for
///   bei." (ch3:702). In a ready hand the shape's wait is too small, so the
///   bulge tile goes.
/// - Once a rival block becomes a decent shape, the same book breaks the bulge
///   even at 1-away: "we should discard tong4 to break the bulging float
///   shape" (ch4:725).
///
/// The three hands are `skeleton::Variant::ReadyDrop`,
/// `OneAwayKeep`, and `OneAwayBreak`; the generator draws one at random so a
/// run of the drill mixes "drop the bulge" with "keep the bulge".
pub fn generate(category: &str) -> Result<GameState, String> {
    let variant = skeleton::random_variant();
    generate_with_retries("nakabukure_ready", 10_000, || {
        let skeleton = skeleton::build_variant(variant)?;
        board::build_board(category, &skeleton)
    })
}

/// Generates one specific variant, used by the tests.
#[cfg(test)]
pub(crate) fn generate_variant(
    category: &str,
    variant: skeleton::Variant,
) -> Result<GameState, String> {
    generate_with_retries("nakabukure_ready", 10_000, || {
        let skeleton = skeleton::build_variant(variant)?;
        board::build_board(category, &skeleton)
    })
}
