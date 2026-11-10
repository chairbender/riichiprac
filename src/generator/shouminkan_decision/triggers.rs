use crate::rng::gen_range;
use crate::state::ShouminkanTrigger;

/// The set of heuristics that make an Added Kan correct for one puzzle.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct ShouminkanTriggerSet {
    pub good_wait_and_value: bool,
    pub late_game: bool,
    pub placement_desperation: bool,
    pub losing_badly: bool,
}

impl ShouminkanTriggerSet {
    pub(super) fn any(self) -> bool {
        self.good_wait_and_value
            || self.late_game
            || self.placement_desperation
            || self.losing_badly
    }

    pub(super) fn to_vec(self) -> Vec<ShouminkanTrigger> {
        let mut triggers = Vec::new();
        if self.good_wait_and_value {
            triggers.push(ShouminkanTrigger::GoodWaitAndValue);
        }
        if self.late_game {
            triggers.push(ShouminkanTrigger::LateGame);
        }
        if self.placement_desperation {
            triggers.push(ShouminkanTrigger::PlacementDesperation);
        }
        if self.losing_badly {
            triggers.push(ShouminkanTrigger::LosingBadly);
        }
        triggers
    }
}

/// Draws a random non-empty subset of compatible Added Kan triggers.
pub(super) fn random() -> ShouminkanTriggerSet {
    loop {
        let mask = gen_range(1, 16) as u8;
        let triggers = ShouminkanTriggerSet {
            good_wait_and_value: mask & 1 != 0,
            late_game: mask & 2 != 0,
            placement_desperation: mask & 4 != 0,
            losing_badly: mask & 8 != 0,
        };

        // South 4 placement desperation and being 12,000 behind in fourth
        // place describe opposite table positions.
        if !triggers.any() || (triggers.placement_desperation && triggers.losing_badly) {
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
            assert!(
                !(triggers.placement_desperation && triggers.losing_badly),
                "placement and losing triggers must not coexist"
            );
        }
    }
}
