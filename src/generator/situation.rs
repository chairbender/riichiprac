//! The situation parameters a lesson draws *before* it fills any tile.
//!
//! Every lesson is a constrained random hand, but the part worth training is
//! not the random tiles: it is the *condition* the hand is built to test.
//! Ch. 7's Riichi/dama box, for example, asks three yes/no questions (a han
//! without Riichi, a good wait, the deal) and the drill only teaches the rule
//! when the hand isolates them. A hand that carries all three conditions at
//! once cannot show the player which one the rule actually turned on.
//!
//! [`Situation`] is that condition set as one typed value per family:
//!
//! | lesson | drawn parameters |
//! |---|---|
//! | `riichi_judgement` | which of the three ch. 7 conditions hold |
//! | `dama_bad_wait` | which cell of the live-winning-tile box (ch7:521-522) |
//! | `dama_expensive_hand` | the hand value band: 7700 or haneman (ch7:569) |
//! | `chiitoitsu_riichi_vs_dama` | Riichi with its justification, or dama |
//! | `push_or_fold` | which ch. 8.1 cell: mangan + perfect wait, or cheap bad wait |
//! | `honitsu_decision` | which ch. 5.4 cell: commit, already 5200, or honitsu-only |
//!
//! The value is drawn once per puzzle request ([`super::sample_situation`])
//! and then handed to [`Situation::fill`] on every attempt. That is what keeps
//! rejection sampling honest: a filter such as "Mortal must agree" can discard
//! a hundred fills, but it can never quietly walk the parameters toward the
//! easy cases, because it is not allowed to draw new ones. A pinned set that
//! cannot be built is an error, never a silent re-draw.
//!
//! Lessons with no parameter concept return `None` and keep the old behaviour,
//! where every candidate is an independent full draw: the block-theory
//! discards, the defense/safety lessons, the call and kan lessons, and the
//! dama lessons whose answer is fixed by the hand shape (`dama_genbutsu_wait`,
//! `dama_improving_hand`, `suji_trap_riichi`).

use crate::state::GameState;

use super::chiitoitsu_riichi_vs_dama::{self, Target as ChiitoitsuTarget};
use super::dama_bad_wait::{self, Target as BadWaitTarget};
use super::dama_expensive_hand::{self, Target as ExpensiveHandTarget};
use super::honitsu_decision::{self, Variant as HonitsuTarget};
use super::push_or_fold::{self, Target as PushOrFoldTarget};
use super::riichi_judgement::{self, judgement::Conditions};

/// One drawn set of situation parameters.
///
/// The payload is the family's own target type, so the parameters cannot drift
/// away from what the family builds: the same value picks the skeleton and is
/// compared against the finished table by the family's own grading pass.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Situation {
    /// Ch. 7's three-condition Riichi/dama rule.
    RiichiJudgement(Conditions),
    /// Ch. 7's bad-wait live-tile box.
    DamaBadWait(BadWaitTarget),
    /// Ch. 7's high-scoring-hand exception.
    DamaExpensiveHand(ExpensiveHandTarget),
    /// Seven pairs: Riichi (with the heuristic that justifies it) or dama.
    Chiitoitsu(ChiitoitsuTarget),
    /// Ch. 8.1's push/fold box, isolated on its 1-away cell.
    PushOrFold(PushOrFoldTarget),
    /// Ch. 5.4's honitsu decision: commit, or play for efficiency.
    HonitsuDecision(HonitsuTarget),
}

impl Situation {
    /// Fills one complete hand and table under exactly these parameters.
    ///
    /// A family may retry the tile fill many times — a random shape can trip
    /// one of the lesson's own guards — but it never redraws the parameters,
    /// so every attempt in this loop is still the situation the caller asked
    /// for.
    pub(crate) fn fill(self, category: &str) -> Result<GameState, String> {
        match self {
            Self::RiichiJudgement(target) => {
                riichi_judgement::generate_with_target(category, target)
            }
            Self::DamaBadWait(target) => dama_bad_wait::generate_with_target(category, target),
            Self::DamaExpensiveHand(target) => {
                dama_expensive_hand::generate_with_target(category, target)
            }
            Self::Chiitoitsu(target) => {
                chiitoitsu_riichi_vs_dama::generate_with_target(category, target)
            }
            Self::PushOrFold(target) => push_or_fold::generate_with_target(category, target),
            Self::HonitsuDecision(target) => {
                honitsu_decision::generate_with_target(category, target)
            }
        }
    }

    /// The parameter list, for the agreement report and the UI note.
    ///
    /// The wording names the isolated condition in plain English, e.g. `extra
    /// han, good wait, non-dealer` or `one or two live simple winning tiles`, so
    /// a player (or a bug report) can see which cell of the lesson's box the
    /// hand was deliberately built for.
    ///
    /// It still never names the recommended action: recognizing the situation
    /// is the whole drill, and a label such as `riichi: good wait only` or
    /// `dama: 7700 without riichi` is the answer in textbook form. The frontend
    /// withholds the clause until the player has answered, so a label that
    /// smuggled the verdict in would leak the moment any screen showed it
    /// earlier. Every family label therefore states table facts only; see
    /// `mortal_agreement::the_situation_label_never_names_the_answer`.
    pub(crate) fn label(self) -> String {
        match self {
            Self::RiichiJudgement(target) => target.label().to_string(),
            Self::DamaBadWait(target) => target.label().to_string(),
            Self::DamaExpensiveHand(target) => target.label().to_string(),
            Self::Chiitoitsu(target) => target.label(),
            Self::PushOrFold(target) => target.label().to_string(),
            Self::HonitsuDecision(target) => target.label().to_string(),
        }
    }
}
