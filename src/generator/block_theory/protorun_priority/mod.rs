mod board;
mod skeleton;

use crate::generator::support::retry::generate_with_retries;
use crate::state::GameState;

/// Generates the "ryanmen before kanchan" lesson: a 1-away hand with one block
/// too many (an open Yakuhai set, a concealed set, the head, two side waits and
/// one closed wait) where the cheapest block to break is the closed wait.
///
/// Riichi Book 1, ch. 3 "Protoruns (taatsu)": a side-wait protorun accepts twice
/// as many tiles as a closed-wait one (ch3:205), and the value box ranks them
/// "side wait > closed wait > edge wait" (ch3:230).
pub fn generate(category: &str) -> Result<GameState, String> {
    generate_with_retries("protorun_priority", 10_000, || {
        let skeleton = skeleton::build_skeleton()?;
        board::build_board(category, &skeleton)
    })
}
