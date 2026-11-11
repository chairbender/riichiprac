mod board;
mod skeleton;

use crate::generator::support::retry::generate_with_retries;
use crate::state::GameState;

/// Generates the "keep three pairs when a Pon is planned" puzzle (ch. 3.2).
///
/// The hand is the open-hand companion of `pair_count`: 2-away, holding a
/// dragon pair the player intends to Pon, two suited pairs, a side wait, a
/// closed wait, a completed run, and a float. Riichi Book 1 ch3:351 says the
/// closed-hand warning does not apply here: "When we intend to call pon, having
/// three pairs is actually better than having two pairs. This is because the
/// hand will become a two-pair hand after we call pon once." So the discard
/// breaks the closed wait and keeps all three pairs, the mirror image of the
/// closed lesson's answer.
///
/// The hand is still closed at the moment of the decision and the game has no
/// call UI, so the planned Pon is stated in `scenario_note` and the answer is
/// graded as an ordinary discard. `skeleton::verify_lesson` proves the Pon both
/// leaves the book line 1-away with two pairs and that the closed-hand ukeire
/// oracle prefers the opposite discard; the book rationale shows that
/// comparison instead of asserting the rule.
pub fn generate(category: &str) -> Result<GameState, String> {
    generate_with_retries("pair_count_open", 10_000, || {
        let skeleton = skeleton::build_skeleton()?;
        board::build_board(category, &skeleton)
    })
}
