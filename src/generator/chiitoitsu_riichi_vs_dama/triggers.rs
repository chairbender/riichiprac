use crate::rng::gen_range;
use crate::state::RiichiTrigger;

/// The set of heuristics that make Riichi correct for one chiitoitsu puzzle.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct RiichiTriggerSet {
    pub dealer: bool,
    pub tanyao: bool,
    pub red_five_wait: bool,
    pub suji_trap: bool,
    pub wait_outside_456: bool,
    pub score_below_mangan: bool,
}

impl RiichiTriggerSet {
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
pub(super) fn random() -> RiichiTriggerSet {
    loop {
        let mask = gen_range(0, 64) as u8;
        if mask == 0 {
            continue;
        }

        let triggers = RiichiTriggerSet {
            dealer: mask & 1 != 0,
            tanyao: mask & 2 != 0,
            red_five_wait: mask & 4 != 0,
            suji_trap: mask & 8 != 0,
            wait_outside_456: mask & 16 != 0,
            score_below_mangan: mask & 32 != 0,
        };

        if !triggers.any() {
            continue;
        }

        // A red-five wait is always the 5, so it cannot also be outside 4-5-6.
        if triggers.red_five_wait && triggers.wait_outside_456 {
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
            assert!(!(triggers.red_five_wait && triggers.wait_outside_456));
        }
    }
}
