mod board;
mod skeleton;

use crate::generator::support::retry::generate_with_retries;
use crate::state::GameState;

/// Generates the "avoid three pairs in a closed hand" puzzle (ch. 3.2).
///
/// The hand is 2-away and closed. The draw pairs a tile of a side-wait
/// protorun, so the hand now holds three pairs. Riichi Book 1 ch3:336 says to
/// avoid three pairs in a closed hand, and its own arithmetic (ch3:331) shows
/// why: keeping the new pair gains two tiles but loses the side wait's eight,
/// so the discard is the tile you just drew.
pub fn generate(category: &str) -> Result<GameState, String> {
    generate_with_retries("pair_count", 10_000, || {
        let skeleton = skeleton::build_skeleton()?;
        board::build_board(category, &skeleton)
    })
}
