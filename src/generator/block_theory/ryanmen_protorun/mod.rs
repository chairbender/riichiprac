mod board;
mod skeleton;

use crate::generator::support::retry::generate_with_retries;
use crate::state::GameState;

/// Generates the first Block Theory scenario: a ryanmen protorun (XXY/XYY)
/// with an open Yakuhai meld, two completed sets, and a separate pair.
///
/// The duplicate tile is the correct discard because it leaves the
/// consecutive pair intact as a live ryanmen wait.
pub fn generate(category: &str) -> Result<GameState, String> {
    generate_with_retries("ryanmen", 10_000, || {
        let skeleton = skeleton::build_skeleton()?;
        board::build_board(category, &skeleton)
    })
}
