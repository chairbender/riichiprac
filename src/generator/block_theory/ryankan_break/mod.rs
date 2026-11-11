mod board;
mod skeleton;

use crate::generator::support::retry::generate_with_retries;
use crate::state::GameState;

/// Generates a "break the double closed shape" puzzle (ch. 3.3, ryankan).
///
/// The hand is 1-away with a ryankan and a head. The draw sits next to the head,
/// so keeping it gives the hand a side-wait protorun. Riichi Book 1 ch3:523 says
/// to keep that protorun and break the ryankan instead.
pub fn generate(category: &str) -> Result<GameState, String> {
    generate_with_retries("ryankan_break", 10_000, || {
        let skeleton = skeleton::build_skeleton()?;
        board::build_board(category, &skeleton)
    })
}
