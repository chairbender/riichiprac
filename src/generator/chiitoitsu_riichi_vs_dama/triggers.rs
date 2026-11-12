use crate::rng::gen_range;
use crate::state::RiichiTrigger;

/// The set of heuristics that make Riichi correct for one chiitoitsu puzzle.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct RiichiTriggerSet {
    pub dealer: bool,
    pub tanyao: bool,
    pub red_five_wait: bool,
    pub suji_trap: bool,
    pub wait_outside_456: bool,
    pub score_below_mangan: bool,
}

impl RiichiTriggerSet {
    /// The heuristics named for the agreement report.
    ///
    /// The set is the situation parameter for this lesson, so the label spells
    /// out every active justification: `riichi: dealer + tanyao` is a
    /// different question from `riichi: suji trap`.
    pub(crate) fn label(self) -> String {
        let mut parts = Vec::new();
        if self.dealer {
            parts.push("dealer");
        }
        if self.tanyao {
            parts.push("tanyao");
        }
        if self.red_five_wait {
            parts.push("red-five wait");
        }
        if self.suji_trap {
            parts.push("suji trap");
        }
        if self.wait_outside_456 {
            parts.push("wait outside 4-5-6");
        }
        if self.score_below_mangan {
            parts.push("score below mangan");
        }
        parts.join(" + ")
    }

    pub(super) fn any(self) -> bool {
        self.dealer
            || self.tanyao
            || self.red_five_wait
            || self.suji_trap
            || self.wait_outside_456
            || self.score_below_mangan
    }

    pub(super) fn to_vec(self) -> Vec<RiichiTrigger> {
        let mut triggers = Vec::new();
        if self.dealer {
            triggers.push(RiichiTrigger::Dealer);
        }
        if self.tanyao {
            triggers.push(RiichiTrigger::Tanyao);
        }
        if self.red_five_wait {
            triggers.push(RiichiTrigger::RedFiveWait);
        }
        if self.suji_trap {
            triggers.push(RiichiTrigger::SujiTrap);
        }
        if self.wait_outside_456 {
            triggers.push(RiichiTrigger::WaitOutside456);
        }
        if self.score_below_mangan {
            triggers.push(RiichiTrigger::ScoreBelowMangan);
        }
        triggers
    }
}

/// Draws a random non-empty subset of compatible Riichi triggers.
///
/// The red-five trigger is emitted on its own. It is a single-answer variant:
/// the kept wait is the hand's only red five and the only accepted discard is
/// the other lone tile. Pairing it with any other trigger would leave that
/// other trigger justifying Riichi after the red five is discarded, turning
/// the discard into a value judgement instead of the book's one answer.
pub(super) fn random() -> RiichiTriggerSet {
    if gen_range(0, 6) == 0 {
        return RiichiTriggerSet {
            red_five_wait: true,
            ..Default::default()
        };
    }

    loop {
        let mask = gen_range(0, 32) as u8;
        let triggers = RiichiTriggerSet {
            dealer: mask & 1 != 0,
            tanyao: mask & 2 != 0,
            red_five_wait: false,
            suji_trap: mask & 4 != 0,
            wait_outside_456: mask & 8 != 0,
            score_below_mangan: mask & 16 != 0,
        };
        if !triggers.any() {
            continue;
        }

        return triggers;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn random_trigger_sets_are_non_empty_and_compatible() {
        for _ in 0..1_000 {
            let triggers = random();
            assert!(triggers.any());
            if triggers.red_five_wait {
                assert_eq!(
                    triggers,
                    RiichiTriggerSet {
                        red_five_wait: true,
                        ..Default::default()
                    },
                    "the red-five lesson must stand alone"
                );
            }
            assert!(!(triggers.red_five_wait && triggers.wait_outside_456));
        }
    }
}
