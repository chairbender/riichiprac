use agari::tile::Tile;

use crate::generator::support::deck::Deck;
use crate::rng::{gen_bool, gen_range, shuffle};
use crate::state::{DiscardTile, PlayerState, Wind};

pub use crate::state::{dealer_seat, is_out_of_rotation_call};

/// One legal, reachable timeline of discards.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RiverPlan {
    /// Number of discards each seat has made.
    pub counts: [usize; 4],
    /// For each seat, the indices of discards made immediately after a call.
    ///
    /// The caller discards from the concealed hand there, so those entries are
    /// always tedashi. Planned calls are treated as chi/pon/daiminkan; the
    /// timeline does not model closed/added kans, whose replacement draw does
    /// allow a tsumogiri follow-up.
    pub hand_discards: [Vec<usize>; 4],
    /// Every planned call, in the order the walk made it.
    ///
    /// A call consumes one of the source's discards, so its `index` is where the
    /// claimed tile has to sit in `state.players[source].discards`.
    pub calls: Vec<PlannedCall>,
}

/// One call inside a [`RiverPlan`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlannedCall {
    /// Seat that made the call.
    pub caller: usize,
    /// Seat whose discard it claimed.
    pub source: usize,
    /// Index of the claimed discard in the source's river.
    pub index: usize,
}

/// One tile an open meld claims from an opponent's river.
///
/// The claimed tile is a separate physical copy of the kind, because the state
/// keeps the discard that produced it: `state_validation` counts it as one of
/// the source's discards, and the tenhou.net/6 exporter looks for the claim
/// there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimPlant {
    /// Seat that discarded the claimed tile.
    pub source: usize,
    /// Index of that discard in the source's river.
    pub index: usize,
    /// The claimed tile, already taken out of the deck.
    pub tile: Tile,
    /// The meld's tiles: no other river entry may be claimable by it, so the
    /// claim can only land on `index`.
    pub meld: Vec<Tile>,
}

/// Plans one legal, reachable discard timeline.
///
/// The walk starts with the dealer and advances one seat per discard. A call
/// `(caller, called_from)` is inserted directly after the discard it claims, so
/// the caller discards next instead of the natural next seat. The walk stops
/// the first time `last_discarder` has just discarded and every seat has at
/// least `min_discards` tiles in its river.
///
/// This is the generation-side counterpart of
/// [`crate::generator::support::state_validation::validate_reachable_state`]:
/// rivers produced here always pass that check.
pub fn plan_rivers(
    dealer: usize,
    last_discarder: usize,
    calls: &[(usize, usize)],
    min_discards: usize,
) -> RiverPlan {
    assert!(dealer < 4, "dealer seat out of range");
    assert!(last_discarder < 4, "last discarder seat out of range");
    for &(caller, from) in calls {
        assert!(caller < 4 && from < 4 && caller != from, "invalid call");
    }

    let mut pending = calls.to_vec();
    let mut plan = RiverPlan::default();
    let mut seat = dealer;

    // Every call lands within one rotation, the stop seat within one more, and
    // the discard floor needs at most `4 * min_discards` landings, so this is a
    // hard safety bound.
    let limit = 4 * min_discards + 4 * calls.len() + 8;
    for _ in 0..limit {
        plan.counts[seat] += 1;
        let last = seat;

        if let Some(index) = pending.iter().position(|(_, from)| *from == seat) {
            let (caller, _) = pending.remove(index);
            // The caller's next discard is the entry at the current count, and
            // it comes from the hand rather than a draw.
            plan.hand_discards[caller].push(plan.counts[caller]);
            // The discard just made is the one the call claims.
            plan.calls.push(PlannedCall {
                caller,
                source: seat,
                index: plan.counts[seat] - 1,
            });
            seat = caller;
        } else {
            seat = (seat + 1) % 4;
        }

        if pending.is_empty()
            && last == last_discarder
            && plan.counts.iter().all(|&count| count >= min_discards)
        {
            return plan;
        }
    }

    panic!("river plan did not terminate for dealer {dealer} and calls {calls:?}");
}

/// Per-seat river lengths, for callers that do not need the call positions.
pub fn river_counts(
    dealer: usize,
    last_discarder: usize,
    calls: &[(usize, usize)],
    min_discards: usize,
) -> [usize; 4] {
    plan_rivers(dealer, last_discarder, calls, min_discards).counts
}

/// River plan for a state where the human (seat 0) has just drawn and is about
/// to discard.
///
/// The human draws after Kamicha (seat 3) discards, so the timeline has to end
/// on seat 3's discard.
pub fn self_turn_river_plan(
    human_wind: Wind,
    calls: &[(usize, usize)],
    min_discards: usize,
) -> RiverPlan {
    plan_rivers(dealer_seat(human_wind), 3, calls, min_discards)
}

/// Converts tiles into river entries, randomizing tsumogiri flags.
pub fn discards_from_tiles(tiles: &[Tile]) -> Vec<DiscardTile> {
    tiles
        .iter()
        .map(|&tile| {
            if gen_bool(0.25) {
                DiscardTile::tsumogiri(tile.to_string())
            } else {
                DiscardTile::new(tile.to_string())
            }
        })
        .collect()
}

/// Clears the tsumogiri flag on discards the timeline says came from the hand.
///
/// A player who has just called (chi, pon or daiminkan) discards from their
/// concealed hand, so the entry immediately after the call can never be
/// tsumogiri. Call with [`RiverPlan::hand_discards`] for the matching seat.
pub fn force_tedashi(discards: &mut [DiscardTile], hand_discards: &[usize]) {
    for &index in hand_discards {
        if let Some(discard) = discards.get_mut(index) {
            discard.is_tsumogiri = false;
        }
    }
}

/// Picks a round that is South 2 or earlier.
pub fn random_round() -> (Wind, u8) {
    let index = gen_range(0, 6);
    if index < 4 {
        (Wind::East, index as u8 + 1)
    } else {
        (Wind::South, index as u8 - 3)
    }
}

/// Four plausible scores that sum to 100,000.
pub fn random_table_scores() -> [i32; 4] {
    loop {
        let mut scores = [0i32; 4];
        let mut total = 0;
        for score in scores.iter_mut().take(3) {
            *score = 15_000 + 1_000 * gen_range(0, 16) as i32;
            total += *score;
        }
        let last = 100_000 - total;
        if (10_000..=40_000).contains(&last) {
            scores[3] = last;
            return scores;
        }
    }
}

/// Opponent scores around 20,000-30,000 with the human taking the remainder.
pub fn random_scores_with_human_first() -> [i32; 4] {
    let mut scores = [0i32; 4];
    let mut opponent_total = 0;
    for score in scores.iter_mut().skip(1) {
        *score = 20_000 + 1_000 * gen_range(0, 11) as i32;
        opponent_total += *score;
    }
    scores[0] = 100_000 - opponent_total;
    scores
}

/// Turns rank-ordered scores into seat-ordered scores with the human first.
pub fn scores_for_seats(ranked: [i32; 4], human_rank: usize) -> [i32; 4] {
    let mut opponents: Vec<i32> = ranked
        .iter()
        .enumerate()
        .filter(|(index, _)| *index != human_rank)
        .map(|(_, score)| *score)
        .collect();
    shuffle(&mut opponents);

    [ranked[human_rank], opponents[0], opponents[1], opponents[2]]
}

/// Rank-ordered scores where the human is 2nd or 3rd, `gap` points behind.
///
/// The caller supplies the gap, because it has to come from the hand: it must
/// sit between what the hand wins for with the Pon and what it wins for once
/// the fourth tile extends it, so that only the Kan decides the placement.
pub fn placement_desperation_ranked_scores(human_rank: usize, gap: i32) -> [i32; 4] {
    assert!(human_rank == 1 || human_rank == 2);
    assert!(gap > 0, "placement gap must be positive");

    loop {
        if human_rank == 1 {
            let human = gen_range(26_000, 33_001) as i32;
            let above = human + gap;
            let remaining = 100_000 - above - human;
            if remaining <= 2_000 {
                continue;
            }

            // Both lower scores must fit below the human.
            let lower = ((remaining / 2) + 1).max(10_000);
            let upper = human - 1;
            if lower >= upper {
                continue;
            }

            let third = gen_range(lower as usize, upper as usize) as i32;
            let fourth = remaining - third;
            if fourth > 0 && fourth < third {
                return [above, human, third, fourth];
            }
        } else {
            let human = gen_range(22_000, 29_001) as i32;
            let second = human + gap;
            let remaining = 100_000 - second - human;

            // The fourth-place score must leave the leader above second.
            let upper = (human - 1).min(remaining - second - 1);
            if upper <= 8_000 {
                continue;
            }

            let fourth = gen_range(8_000, upper as usize) as i32;
            let first = remaining - fourth;
            if first > second && fourth < human {
                return [first, second, human, fourth];
            }
        }
    }
}

/// Rank-ordered scores where the human is 4th and more than 12,000 behind 3rd.
pub fn losing_badly_ranked_scores() -> [i32; 4] {
    loop {
        let human = gen_range(8_000, 16_001) as i32;
        let gap = gen_range(13_000, 20_001) as i32;
        let third = human + gap;
        let remaining = 100_000 - human - third;

        if remaining < 2 * third + 2_000 {
            continue;
        }

        let second = gen_range((third + 1_000) as usize, (remaining - 1_000) as usize) as i32;
        let first = remaining - second;
        if first > second && second > third {
            return [first, second, third, human];
        }
    }
}

/// The pieces dealt to the three opponents.
pub struct OpponentDeal {
    /// Opponent player states, in seat order starting with Shimocha.
    pub players: Vec<PlayerState>,
    /// The raw rivers, kept so scenarios can inspect wait visibility.
    pub rivers: Vec<Vec<Tile>>,
}

/// Deals concealed hands and rivers to the three opponents.
///
/// Scores are seat-ordered with the human at index 0. `plan` holds the number
/// of discards each seat has made (plan it with [`plan_rivers`] so the
/// resulting table is a reachable position) plus the discards that follow a
/// call, which are forced to tedashi.
pub fn deal_opponents(
    deck: &mut Deck,
    human_wind: Wind,
    scores: &[i32; 4],
    plan: &RiverPlan,
) -> Option<OpponentDeal> {
    deal_opponents_claiming(deck, human_wind, scores, plan, &[])
}

/// Deals the three opponents, planting every claimed tile in the river it came
/// from.
///
/// A call consumes a discard, so the source's river has to show the tile the
/// caller took (see [`ClaimPlant`]). Each plant lands on its planned index, and
/// every other entry in that river steers clear of the claiming melds, so the
/// claim can only sit where it was planted.
pub fn deal_opponents_claiming(
    deck: &mut Deck,
    human_wind: Wind,
    scores: &[i32; 4],
    plan: &RiverPlan,
    claims: &[ClaimPlant],
) -> Option<OpponentDeal> {
    let opponent_meta = [(1usize, "Shimocha"), (2, "Toimen"), (3, "Kamicha")];

    let mut players = Vec::with_capacity(3);
    let mut rivers = Vec::with_capacity(3);
    for (index, (seat, name)) in opponent_meta.iter().enumerate() {
        let hand = deck.draw_n(13)?;
        let avoid: Vec<Tile> = claims
            .iter()
            .filter(|claim| claim.source == *seat)
            .flat_map(|claim| claim.meld.iter().copied())
            .collect();
        let mut river = Vec::with_capacity(plan.counts[*seat]);
        for slot in 0..plan.counts[*seat] {
            let planted = claims
                .iter()
                .find(|claim| claim.source == *seat && claim.index == slot);
            match planted {
                Some(claim) => river.push(claim.tile),
                None => river.push(deck.draw_excluding(1, &avoid)?.pop()?),
            }
        }
        rivers.push(river.clone());
        let mut discards = discards_from_tiles(&river);
        force_tedashi(&mut discards, &plan.hand_discards[*seat]);
        players.push(PlayerState {
            seat: *seat,
            name: name.to_string(),
            is_human: false,
            wind: human_wind.next(*seat),
            score: scores[index + 1],
            hand: hand.iter().map(|tile| tile.to_string()).collect(),
            draw: None,
            red_fives: Vec::new(),
            discards,
            melds: Vec::new(),
            is_riichi: false,
            riichi_discard_index: None,
        });
    }

    Some(OpponentDeal { players, rivers })
}

#[cfg(test)]
mod tests {
    use agari::tile::{Honor, Suit};

    use super::*;

    #[test]
    fn random_round_stays_in_east_one_to_south_two() {
        for _ in 0..200 {
            match random_round() {
                (Wind::East, 1..=4) | (Wind::South, 1..=2) => {}
                other => panic!("invalid round: {other:?}"),
            }
        }
    }

    #[test]
    fn random_table_scores_sum_to_one_hundred_thousand() {
        for _ in 0..100 {
            assert_eq!(random_table_scores().iter().sum::<i32>(), 100_000);
        }
    }

    #[test]
    fn random_human_first_scores_keep_the_human_at_seat_zero() {
        for _ in 0..100 {
            let scores = random_scores_with_human_first();
            assert_eq!(scores.iter().sum::<i32>(), 100_000);
            assert!(
                scores[1..]
                    .iter()
                    .all(|score| (20_000..=30_000).contains(score))
            );
        }
    }

    #[test]
    fn scores_for_seats_places_the_human_first_in_seat_zero() {
        for _ in 0..100 {
            let scores = scores_for_seats([40_000, 30_000, 20_000, 10_000], 2);
            assert_eq!(scores[0], 20_000);
            assert_eq!(scores.iter().sum::<i32>(), 100_000);
        }
    }

    #[test]
    fn river_plan_marks_the_discard_after_a_call_as_a_hand_discard() {
        // East dealer: seat 1 claims seat 0's opening discard, so seat 1's
        // first river entry (index 0) comes from the hand.
        let plan = plan_rivers(dealer_seat(Wind::East), 3, &[(1, 0)], 3);
        assert!(plan.hand_discards[0].is_empty());
        assert_eq!(plan.hand_discards[1], vec![0]);
        assert!(plan.hand_discards[2].is_empty());
        assert!(plan.hand_discards[3].is_empty());
    }

    #[test]
    fn river_plan_marks_a_mid_river_call_the_same_way() {
        // Seat 0 claims seat 1's first discard: seat 0 had already discarded
        // once, so its next entry (index 1) is the hand discard.
        let plan = plan_rivers(dealer_seat(Wind::East), 3, &[(0, 1)], 3);
        assert_eq!(plan.hand_discards[0], vec![1]);
        assert!(plan.hand_discards[1].is_empty());
    }

    #[test]
    fn river_plan_records_the_discard_each_call_claims() {
        let plan = plan_rivers(dealer_seat(Wind::East), 3, &[(0, 1)], 3);
        assert_eq!(
            plan.calls,
            vec![PlannedCall {
                caller: 0,
                source: 1,
                index: 0,
            }]
        );
    }

    #[test]
    fn a_claiming_deal_plants_the_claimed_tile_at_its_index() {
        let mut deck = Deck::fresh();
        let plan = plan_rivers(dealer_seat(Wind::East), 3, &[(0, 1)], 3);
        let call = plan.calls[0];
        let claimed = Tile::Honor(Honor::White);
        deck.take(claimed).expect("the claimed copy is available");
        let deal = deal_opponents_claiming(
            &mut deck,
            Wind::East,
            &[25_000; 4],
            &plan,
            &[ClaimPlant {
                source: call.source,
                index: call.index,
                tile: claimed,
                meld: vec![claimed; 3],
            }],
        )
        .expect("the deck supplies the rivers");

        // `rivers` runs in opponent order: seat 1 first.
        let source_river = &deal.rivers[call.source - 1];
        assert_eq!(source_river.len(), plan.counts[call.source]);
        assert_eq!(source_river[call.index], claimed);
        assert!(
            source_river
                .iter()
                .enumerate()
                .all(|(index, tile)| index == call.index || *tile != claimed),
            "only the planted slot may show the claimed tile: {source_river:?}"
        );
    }

    #[test]
    fn force_tedashi_clears_the_listed_discards() {
        let tiles = [
            Tile::suited(Suit::Man, 1),
            Tile::suited(Suit::Pin, 2),
            Tile::suited(Suit::Sou, 3),
        ];
        let mut discards = discards_from_tiles(&tiles);
        force_tedashi(&mut discards, &[0, 2]);
        assert!(!discards[0].is_tsumogiri);
        assert!(!discards[2].is_tsumogiri);
        // Out-of-range indices are ignored rather than panicking.
        force_tedashi(&mut discards, &[9]);
    }
}
