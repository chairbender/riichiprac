//! `meld_or_not`: never meld a cheap and slow hand (Riichi Book 1, ch. 9.1).
//!
//! > `Melding with a cheap and slow hand is one of the two biggest sins in
//! > riichi mahjong.` — ch9:30
//! > `Don't meld with a cheap and slow hand!` — ch9:72
//! > `we mean that the hand is 2-away or worse after melding (i.e. 3-away or
//! > worse before melding) and with a bad wait.` — ch9:33
//!
//! The hand is dealt on an opponent's discard of a dragon the human holds a
//! pair of, so a Pon is genuinely offered and the opened hand would still have
//! its yakuhai. Calling leaves a 1000-point hand that is 2-away with only
//! closed and edge waits; passing keeps both the safety tiles and the option to
//! improve the shape. The generator re-derives both halves of the book's test
//! from the finished state:
//!
//! * **slow** — the hand is 3-away or worse before the call, and 2-away or
//!   worse for *every* discard the Pon would leave; no two suited tiles are
//!   adjacent inside 2..8, so the hand never shows a side-wait protorun.
//! * **cheap** — the hand holds no dora and no red fives, and its only value is
//!   the offered dragon's yakuhai: one han, 1000 points.
//!
//! The ch. 9.2 exceptions (a slow but expensive hand, a cheap but fast one, a
//! call that eliminates a bad wait and reaches ready, a concealed value set)
//! are all excluded by construction and are listed as absent rules in the
//! rationale, so the drill never teaches the exception as the rule.
//!
//! Deck cards: 1463255782615, 1463256320218, 1463256486957, 1463256846829.

mod board;
mod skeleton;

use crate::generator::support::retry::generate_with_retries;
use crate::state::GameState;

/// Generates the ch. 9.1 cheap-and-slow call decision.
pub fn generate(category: &str) -> Result<GameState, String> {
    generate_with_retries("meld_or_not", 2_000, || board::build_board(category))
}
