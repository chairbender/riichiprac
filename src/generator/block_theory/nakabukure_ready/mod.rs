mod board;
mod skeleton;

use crate::generator::support::retry::generate_with_retries;
use crate::state::GameState;

/// Generates the "bulging float in a ready hand" lesson: a hand that is
/// already tenpai with a nakabukure (bulging float) block plus a lone honour.
///
/// Riichi Book 1, ch. 3, "Bulging float (nakabukure)": the shape is worth
/// keeping only "until a hand becomes 1-away" (ch3:708). In a ready hand it
/// waits on the middle tile the hand already holds twice, so the book's
/// ready-hand example says "we should rather discard wan4 to wait for bei"
/// (ch3:702). The answer is therefore the bulge tile: it leaves the lone
/// honour as a three-tile tanki wait, while discarding the honour leaves the
/// bulge tile as a two-tile wait.
pub fn generate(category: &str) -> Result<GameState, String> {
    generate_with_retries("nakabukure_ready", 10_000, || {
        let skeleton = skeleton::build_skeleton()?;
        board::build_board(category, &skeleton)
    })
}
