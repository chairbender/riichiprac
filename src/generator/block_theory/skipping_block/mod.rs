mod board;
mod skeleton;

use crate::generator::support::retry::generate_with_retries;
use crate::state::GameState;

pub(crate) use skeleton::{isolated_turns, skipping_turns};

/// Generates the "skipping shape" lesson: a 2-away hand holding a skipping
/// float (`3567`, `4678`, `2346`, `3457`) and an isolated float of the same
/// rank. The skipping tile is the one to keep.
///
/// Riichi Book 1, ch. 3 *Skipping shape* (ch3:713): a floating tile two ranks
/// from a run "is more valuable than isolated {3}, because it increases the
/// kinds of tiles the hand can accept to produce a protorun or a 3-way
/// side-wait shape". Table `tbl:skipping` (ch3:716) gives the counts, and the
/// book's own example (ch3:787) answers "keep `3p` and discard `3m`" (ch3:795).
///
/// Both discards leave the hand 2-away with the same raw acceptance, so the
/// hand's count alone does not decide; the skeleton keeps only the shapes whose
/// protorun draws strictly beat the isolated tile's (see
/// [`skeleton::skipping_turns`]).
pub fn generate(category: &str) -> Result<GameState, String> {
    generate_with_retries("skipping_block", 10_000, || {
        let skeleton = skeleton::build_skeleton()?;
        board::build_board(category, &skeleton)
    })
}
