//! Permutations of the three opponents around the acting seat.
//!
//! A replay snapshot is normalised so the actor is `players[0]`; a **seat
//! variant** then reorders the other three seats without touching the actor's
//! decision (replay-implementation-plan §4.2). Seat 0 is fixed by contract, so a
//! [`SeatPerm`] only ever permutes seats 1, 2 and 3.

use serde::{Deserialize, Serialize};

use super::TransformError;

/// A permutation of the three opponents around the acting seat.
///
/// `order[new_seat - 1]` is the old seat now sitting at `new_seat`, so
/// `[1, 2, 3]` is the identity and `[2, 3, 1]` moves everyone one place to the
/// right. Seat 0 (the actor) never moves. The JSON form is the bare three-element
/// array.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "[u8; 3]", into = "[u8; 3]")]
pub struct SeatPerm {
    order: [u8; 3],
}

impl SeatPerm {
    /// The permutation that changes nothing.
    pub const IDENTITY: Self = Self { order: [1, 2, 3] };

    /// Validate a permutation of the three opponent seats.
    pub fn new(order: [u8; 3]) -> Result<Self, TransformError> {
        Self::try_from(order)
    }

    /// The stored order: `order[new_seat - 1]` is the old seat.
    #[must_use]
    pub fn order(self) -> [u8; 3] {
        self.order
    }

    /// True when no seat moves.
    #[must_use]
    pub fn is_identity(self) -> bool {
        self.order == [1, 2, 3]
    }

    /// The seat `old` moves to (seat 0 always maps to itself).
    ///
    /// Out-of-range seats return 0; callers validate the table first, so this
    /// never indexes out of bounds.
    #[must_use]
    pub fn dest(self, old: usize) -> usize {
        if old == 0 {
            return 0;
        }
        self.order
            .iter()
            .position(|seat| usize::from(*seat) == old)
            .map_or(0, |index| index + 1)
    }

    /// The old seat that now sits at `new` (seat 0 always maps to itself).
    #[must_use]
    pub fn source(self, new: usize) -> usize {
        match new {
            0 => 0,
            1..=3 => usize::from(self.order[new - 1]),
            _ => 0,
        }
    }

    /// The permutation that undoes this one.
    #[must_use]
    pub fn inverse(self) -> Self {
        let mut order = [0u8; 3];
        for (index, seat) in self.order.iter().enumerate() {
            order[usize::from(*seat) - 1] = (index + 1) as u8;
        }
        Self { order }
    }
}

impl TryFrom<[u8; 3]> for SeatPerm {
    type Error = TransformError;

    fn try_from(order: [u8; 3]) -> Result<Self, Self::Error> {
        let mut seen = [false; 4];
        for seat in order {
            if !(1..=3).contains(&seat) || seen[usize::from(seat)] {
                return Err(TransformError::InvalidSeatOrder { order });
            }
            seen[usize::from(seat)] = true;
        }
        Ok(Self { order })
    }
}

impl From<SeatPerm> for [u8; 3] {
    fn from(perm: SeatPerm) -> Self {
        perm.order
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_permutation_round_trips_its_destinations() {
        let permutations = [
            [1, 2, 3],
            [1, 3, 2],
            [2, 1, 3],
            [2, 3, 1],
            [3, 1, 2],
            [3, 2, 1],
        ];
        for order in permutations {
            let perm = SeatPerm::new(order).expect("a permutation of 1..3");
            assert_eq!(perm.dest(0), 0);
            for old in 1..=3 {
                let new = perm.dest(old);
                assert_eq!(perm.source(new), old, "order {order:?}");
            }
            let inverse = perm.inverse();
            for old in 0..4 {
                assert_eq!(inverse.dest(perm.dest(old)), old, "order {order:?}");
            }
        }
    }

    #[test]
    fn invalid_orders_are_rejected() {
        for order in [[0, 1, 2], [1, 1, 2], [1, 2, 4], [2, 3, 3]] {
            assert!(
                SeatPerm::new(order).is_err(),
                "{order:?} is not a permutation of 1..3"
            );
        }
    }

    #[test]
    fn json_is_the_bare_order_array() {
        let perm = SeatPerm::new([2, 3, 1]).expect("valid");
        let json = serde_json::to_string(&perm).expect("serialises");
        assert_eq!(json, "[2,3,1]");
        assert_eq!(
            serde_json::from_str::<SeatPerm>(&json).expect("parses"),
            perm
        );
        assert!(serde_json::from_str::<SeatPerm>("[1,1,2]").is_err());
    }

    #[test]
    fn the_default_is_the_identity() {
        assert!(SeatPerm::IDENTITY.is_identity());
        assert_eq!(SeatPerm::IDENTITY.inverse(), SeatPerm::IDENTITY);
        for seat in 0..4 {
            assert_eq!(SeatPerm::IDENTITY.dest(seat), seat);
            assert_eq!(SeatPerm::IDENTITY.source(seat), seat);
        }
    }
}
