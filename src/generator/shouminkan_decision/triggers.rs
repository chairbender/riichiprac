use crate::rng::gen_range;
use crate::state::ShouminkanTrigger;

/// The set of heuristics that make an Added Kan correct for one puzzle.
///
/// Each field maps onto one of the four conditions in Riichi Book 1, ch. 9,
/// "From an open set to an open quad (kakan)":
///
/// 1. 1-away or better with a good wait, and two han or more,
/// 2. 1-away or better, and not many turns left to draw,
/// 3. you need more dora or minipoints to improve the placement (South 4),
/// 4. you are losing badly.
///
/// `needs_dora` is the far-from-ready side of conditions 3 and 4: the book's
/// own example is a 2-away hand that should still kan.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct ShouminkanTriggerSet {
    pub good_wait_and_value: bool,
    pub late_game: bool,
    pub placement_desperation: bool,
    pub losing_badly: bool,
    pub needs_dora: bool,
}

impl ShouminkanTriggerSet {
    pub(super) fn any(self) -> bool {
        self.good_wait_and_value
            || self.late_game
            || self.placement_desperation
            || self.losing_badly
            || self.needs_dora
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
        if self.needs_dora {
            triggers.push(ShouminkanTrigger::NeedsDora);
        }
        triggers
    }
}

/// Draws a random non-empty subset of compatible Added Kan triggers.
pub(super) fn random() -> ShouminkanTriggerSet {
    loop {
        let mask = gen_range(1, 32) as u8;
        let triggers = ShouminkanTriggerSet {
            good_wait_and_value: mask & 1 != 0,
            late_game: mask & 2 != 0,
            placement_desperation: mask & 4 != 0,
            losing_badly: mask & 8 != 0,
            needs_dora: mask & 16 != 0,
        };

        // South 4 placement desperation and being 12,000 behind in fourth
        // place describe opposite table positions.
        if !triggers.any() || (triggers.placement_desperation && triggers.losing_badly) {
            continue;
        }

        // `needs_dora` only exists inside a placement or losing-badly table,
        // and it rests on the hand being 2-away or worse, which contradicts
        // the two conditions that require 1-away or better.
        if triggers.needs_dora
            && (!(triggers.placement_desperation || triggers.losing_badly)
                || triggers.good_wait_and_value
                || triggers.late_game)
        {
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
            if triggers.needs_dora {
                assert!(
                    triggers.placement_desperation || triggers.losing_badly,
                    "needs_dora requires a desperation table"
                );
                assert!(
                    !triggers.good_wait_and_value && !triggers.late_game,
                    "needs_dora contradicts the 1-away conditions"
                );
            }
        }
    }
}
