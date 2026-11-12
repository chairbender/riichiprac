mod board;
mod skeleton;

use crate::generator::support::retry::generate_with_retries;
use crate::state::GameState;

/// Generates the "which discard makes the hand perfect 1-away?" puzzle (ch. 3.2).
///
/// The player holds the book's perfect 1-away: two side-wait protoruns and two
/// pairs, with one of the side waits sharing a tile with a pair. The draw lands
/// two ranks below the complex run, turning it into a double closed (ryankan)
/// shape. Riichi Book 1 ch3:382 defines the perfect shape and ch3:389 says why
/// it is perfect — "no matter how a hand becomes ready, you will always have the
/// option to choose side wait as the final wait" — so the book's answer is to
/// discard the draw and keep the shape, even though keeping the double closed
/// shape accepts slightly more tiles on paper.
pub fn generate(category: &str) -> Result<GameState, String> {
    generate_with_retries("perfect_one_away", 10_000, || {
        let skeleton = skeleton::build_skeleton()?;
        board::build_board(category, &skeleton)
    })
}
