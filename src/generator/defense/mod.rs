//! Pure defense: choose the safest tile against an opponent's Riichi.
//!
//! All three lessons come from Riichi Book 1, ch. 8 ("Defense judgement"):
//!
//! - `defense_safety_chart` builds a board where the book's safety ranking
//!   (`tbl:safety`) has a genuine answer — genbutsu, a suji tile, a no-chance
//!   tile, or an honor ranked by its visible copies — and fills the rest of the
//!   hand with tiles the chart ranks strictly lower.
//! - `suji_kabe_safety` is the same fold board's ranking mode: the safest tile
//!   is a suji or no-chance tile (never the free genbutsu), the runner-up is
//!   exactly one row down `tbl:safety`, and the answer sits inside a block, so
//!   the learner has to read the table instead of taking the 100% tile.
//! - `defense_stuck_heuristic` is the chapter's fallback, "What to discard when
//!   you get stuck": nothing is identified as safe, so the learner breaks up a
//!   terminal pair that also sits outside the threat's early discards.
//!
//! None of the lessons asks about hand value: the hand is at least 1-away, so
//! the question is purely which tile is safest to let go.

mod board;
mod theme;

use crate::generator::support::retry::generate_with_retries;
use crate::state::GameState;

/// Generates a defense puzzle answered from the book's safety chart.
pub fn generate_safety_chart(category: &str) -> Result<GameState, String> {
    generate_with_retries("defense_safety_chart", 1_000, || {
        board::build_safety_chart(category, theme::plan_safety()?)
    })
}

/// Generates the ranking half of the fold lesson: the safest tile is a suji or
/// no-chance tile, and the runner-up is exactly one row worse.
pub fn generate_suji_kabe(category: &str) -> Result<GameState, String> {
    generate_with_retries("suji_kabe_safety", 2_000, || {
        board::build_suji_kabe(category, theme::plan_suji_kabe()?)
    })
}

/// Generates a defense puzzle answered from the chapter's fallback heuristics.
pub fn generate_stuck(category: &str) -> Result<GameState, String> {
    generate_with_retries("defense_stuck_heuristic", 1_000, || {
        board::build_stuck(category, theme::plan_stuck()?)
    })
}
