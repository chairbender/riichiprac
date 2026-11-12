mod board;
mod skeleton;

use crate::generator::support::retry::generate_with_retries;
use crate::state::GameState;

/// Generates the "chiitoitsu vs toitoi" lesson (Riichi Book 1, ch. 5.5).
///
/// The hand is a 1-away chiitoitsu hand whose drawn tile just turned one of its
/// pairs into a set. The book's question is whether to throw that third copy and
/// stay with chiitoitsu, or keep it and build toitoi:
///
/// - "If there is one or more futile pair in your hand, you must stick with
///   chiitoitsu. If not, you can go for toitoi." (ch5:618)
///
/// A pair is futile when both of its remaining copies are already visible, so
/// the drill is answered by reading the rivers, not by counting acceptance:
///
/// - [`skeleton::Variant::FutilePair`] puts two copies of one pair in two
///   opponents' rivers. The answer is the drawn third copy.
/// - [`skeleton::Variant::BuildToitoi`] keeps every pair live and gives the hand
///   a dragon pair, so the answer is a lone tile. That discard *loses* raw
///   acceptance, which is exactly the trap the book warns about.
///
/// Anki 1463247702867 (the three chiitoitsu-over-toitoi situations) and
/// 1463250507888 (run-based vs set-based hands).
pub fn generate(category: &str) -> Result<GameState, String> {
    let variant = skeleton::random_variant();
    generate_with_retries("chiitoi_vs_toitoi", 10_000, || {
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
    generate_with_retries("chiitoi_vs_toitoi", 10_000, || {
        let skeleton = skeleton::build_variant(variant)?;
        board::build_board(category, &skeleton)
    })
}
