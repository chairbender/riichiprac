mod board;
mod skeleton;

pub(crate) use skeleton::nobetan_starts;

use crate::generator::support::retry::generate_with_retries;
use crate::state::GameState;

/// Generates a "keep the stretched single" puzzle (ch. 3.3, nobetan).
///
/// The hand is 2-away and holds `3456` or `4567`. Discarding either end of the
/// shape accepts the most tiles right now, but it turns the four-tile shape
/// into a completed run and leaves the remaining protoruns closed and edge
/// waits. Riichi Book 1 ch3:662 calls that "too myopic" and keeps the shape;
/// ch3:669 makes it the rule for 3456 and 4567 until the hand is ready or
/// 1-away.
pub fn generate(category: &str) -> Result<GameState, String> {
    // The hand proof is the expensive part (it enumerates two-step
    // completions), so it runs once and only the board is re-rolled when a
    // table-level constraint fails.
    let skeleton = skeleton::build_skeleton()?;
    generate_with_retries("nobetan_keep", 10_000, || {
        board::build_board(category, &skeleton)
    })
}
