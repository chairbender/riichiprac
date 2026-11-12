mod board;
mod skeleton;

use crate::generator::support::retry::generate_with_retries;
use crate::state::GameState;

/// Generates the "break the weaker protorun plus one" lesson: a 1-away hand
/// holding two protorun-plus-one shapes, one covering a side wait and one
/// covering a closed wait, plus an open Yakuhai set, a concealed run and the
/// head.
///
/// Riichi Book 1, ch. 3, "Protorun plus one shape": a cover adds the same two
/// tiles to either shape, so the two breaks accept the same tiles. The book
/// breaks the *side* wait's cover and keeps the closed wait's cover as a
/// back-up, because the side-wait protorun is strong enough without one
/// (ch3:574). The discard is graded as the answer; the tied rival is explained
/// rather than accepted.
pub fn generate(category: &str) -> Result<GameState, String> {
    generate_with_retries("protorun_plus_one", 10_000, || {
        let skeleton = skeleton::build_skeleton()?;
        board::build_board(category, &skeleton)
    })
}
