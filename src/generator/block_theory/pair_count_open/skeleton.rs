use std::collections::BTreeMap;

use agari::parse::to_counts;
use agari::shanten::{calculate_shanten_with_melds, calculate_ukeire_with_melds};
use agari::tile::{Honor, Suit, Tile};

use super::super::shapes::{distinct_tiles, pair_tiles, shanten, suited, ukeire, without};
use crate::generator::support::deck::Deck;
use crate::rng::{choose, gen_range, shuffle};

/// The two copies of the Pon target that are still live in the wall.
///
/// The hand holds the other two copies of the dragon, and the board keeps every
/// copy out of the visible rivers and the dora indicator, so a Pon really is
/// available for the plan this lesson asks about.
pub(super) const TARGET_LIVE_COPIES: u8 = 2;

/// The constructed parts of a "keep three pairs when a Pon is planned" puzzle.
///
/// Riichi Book 1, ch. 3, "Pairs and sets":
///
/// - "As long as we intend to keep the hand closed ... we should avoid having
///   three pairs in a hand." (ch3:336)
/// - The open-hand caveat: "When we intend to call {\jap pon}, having three
///   pairs is actually better than having two pairs. This is because the hand
///   will become a two-pair hand after we call {\jap pon} once." (ch3:351)
/// - The book's example: 11 35 45 2 44 789 ZZ, discard 5m and keep the three
///   pairs, because the Pon on Z will leave two pairs. After the Pon its two
///   follow-up floats are 3m and 2s. (ch3:353-366)
///
/// Anki 1463191498526 (2 pairs > 1 pair, 4 pairs > 3 pairs) and 1463192072762
/// (three pairs beat two only when you intend to Pon).
///
/// The skeleton mirrors the book's example: one completed run, one side-wait
/// protorun, one closed-wait protorun, two suited pairs, a dragon pair, and one
/// float. The draw completes the second suited pair, so the hand holds three
/// pairs and the closed-hand lesson would discard the drawn tile. The answer
/// keeps it instead and breaks the closed wait, because the planned Pon turns
/// the dragon pair into a set and leaves two pairs.
pub(super) struct PairCountOpenSkeleton {
    /// All 14 tiles: the concealed hand plus the draw.
    pub full_tiles: Vec<Tile>,
    /// The 13 concealed tiles before the draw.
    pub concealed_tiles: Vec<Tile>,
    /// The tile just drawn: it completes `second_pair`.
    pub draw: Tile,
    /// The dragon pair the hand intends to Pon.
    pub pon_target: Tile,
    /// The three pairs: both suited pairs and the dragon pair.
    pub pairs: [Tile; 3],
    /// The side-wait protorun the answer keeps.
    pub ryanmen: [Tile; 2],
    /// The closed-wait protorun the answer breaks, as `[low, high]`.
    pub kanchan: [Tile; 2],
    /// The completed run, so the hand is exactly 2-away.
    pub completed_run: [Tile; 3],
    /// The redundant tile. Discarding it before the Pon is the same set of
    /// discards as the answer, just in the other order.
    pub float: Tile,
    /// The book's discard: the high tile of the closed wait.
    pub answer_tile: Tile,
    /// The float, when discarding it first is the same hand as the answer.
    pub equivalent_tiles: Vec<Tile>,
    /// The tile the closed-hand lesson would discard: the drawn third pair.
    pub rival_tile: Tile,
    /// Closed acceptance after the book's discard, for the board to
    /// cross-check its own evaluation.
    pub answer_closed_acceptance: u8,
}

/// The acceptance numbers a skeleton must prove.
#[cfg_attr(not(test), allow(dead_code))]
pub(super) struct LessonScores {
    pub answer_closed: u8,
    pub rival_closed: u8,
    pub answer_pon: u8,
    pub rival_pon: u8,
    pub float_is_equivalent: bool,
}

/// Builds one 2-away hand with three pairs and proves the open-hand discard.
pub(super) fn build_skeleton() -> Result<PairCountOpenSkeleton, String> {
    'attempt: for _ in 0..2_000 {
        let mut deck = Deck::fresh();

        // The paired suit holds the pair the closed wait sits next to; the mixed
        // suit holds the second pair, the float and the run; the third suit
        // holds the side wait. Verification rejects any accidental overlap.
        let mut suits = [Suit::Man, Suit::Pin, Suit::Sou];
        shuffle(&mut suits);
        let pair_suit = suits[0];
        let mixed_suit = suits[1];
        let ryanmen_suit = suits[2];

        // The book's 1m1m + 3m5m shape: the pair, then the closed wait two and
        // four ranks above it. The answer is the high tile, so the kept low
        // tile sits next to the pair and is the useful float after the Pon.
        let pair_value = gen_range(1, 6) as u8;
        // The book's 4s4s pair with the 2s float two ranks below it.
        let second_pair_value = gen_range(3, 10) as u8;
        let ryanmen_start = gen_range(1, 9) as u8;
        let run_start = gen_range(1, 8) as u8;
        let pon_target =
            Tile::Honor(choose(&[Honor::White, Honor::Green, Honor::Red]).expect("three dragons"));

        let pair = suited(pair_suit, pair_value);
        let kanchan = [
            suited(pair_suit, pair_value + 2),
            suited(pair_suit, pair_value + 4),
        ];
        let second_pair = suited(mixed_suit, second_pair_value);
        let float = suited(mixed_suit, second_pair_value - 2);
        let ryanmen = [
            suited(ryanmen_suit, ryanmen_start),
            suited(ryanmen_suit, ryanmen_start + 1),
        ];
        let completed_run = [
            suited(mixed_suit, run_start),
            suited(mixed_suit, run_start + 1),
            suited(mixed_suit, run_start + 2),
        ];

        let mut full_tiles = Vec::with_capacity(14);
        full_tiles.extend(completed_run);
        full_tiles.extend(kanchan);
        full_tiles.extend(ryanmen);
        full_tiles.extend([pair, pair, second_pair, second_pair]);
        full_tiles.extend([pon_target, pon_target]);
        full_tiles.push(float);
        if full_tiles.len() != 14 {
            continue 'attempt;
        }
        if !expected_counts(
            &full_tiles,
            &[
                (completed_run[0], 1),
                (completed_run[1], 1),
                (completed_run[2], 1),
                (kanchan[0], 1),
                (kanchan[1], 1),
                (ryanmen[0], 1),
                (ryanmen[1], 1),
                (pair, 2),
                (second_pair, 2),
                (pon_target, 2),
                (float, 1),
            ],
        ) {
            continue 'attempt;
        }

        let draw = second_pair;
        let mut concealed_tiles = full_tiles.clone();
        let Some(draw_index) = concealed_tiles.iter().position(|tile| *tile == draw) else {
            continue 'attempt;
        };
        concealed_tiles.remove(draw_index);
        if concealed_tiles.len() != 13 {
            continue 'attempt;
        }

        for tile in &full_tiles {
            if deck.take(*tile).is_err() {
                continue 'attempt;
            }
        }

        let skeleton = PairCountOpenSkeleton {
            full_tiles,
            concealed_tiles,
            draw,
            pon_target,
            pairs: [pair, second_pair, pon_target],
            ryanmen,
            kanchan,
            completed_run,
            float,
            answer_tile: kanchan[1],
            equivalent_tiles: Vec::new(),
            rival_tile: draw,
            answer_closed_acceptance: 0,
        };

        let scores = match verify_lesson(&skeleton) {
            Ok(scores) => scores,
            Err(_) => continue 'attempt,
        };

        return Ok(PairCountOpenSkeleton {
            equivalent_tiles: scores
                .float_is_equivalent
                .then_some(skeleton.float)
                .into_iter()
                .collect(),
            answer_closed_acceptance: scores.answer_closed,
            ..skeleton
        });
    }

    Err("Failed to construct an open-hand three-pair lesson".to_string())
}

/// Proves the book's open-hand rule for one hand.
///
/// (a) the hand is 2-away both before and after the draw and holds three pairs,
///     one of them the Pon target;
/// (b) the answer is not a pair tile and not the Pon target: it breaks the
///     closed wait, so the hand still holds all three pairs;
/// (c) the planned Pon leaves a 1-shanten hand, and the best follow-up discard
///     still holds two pairs;
/// (d) the closed-hand rival (break a pair) is also 1-shanten after the Pon but
///     holds only one pair, and the book line accepts strictly more;
/// (e) the closed-hand ukeire oracle prefers the rival, and the Pon target's two
///     live copies cover that gap;
/// (f) no other discard is better after the Pon. Only the redundant float may
///     tie, and then it is the same two discards in the other order.
pub(super) fn verify_lesson(skeleton: &PairCountOpenSkeleton) -> Result<LessonScores, String> {
    if skeleton.full_tiles.len() != 14 {
        return Err("a turn hand must hold fourteen tiles".to_string());
    }
    if skeleton.concealed_tiles.len() != 13 {
        return Err("a closed hand must hold thirteen concealed tiles".to_string());
    }
    if shanten(&skeleton.concealed_tiles) != 2 {
        return Err("the hand before the draw must already be 2-away".to_string());
    }
    if shanten(&skeleton.full_tiles) != 2 {
        return Err("the drawn hand must still be 2-away".to_string());
    }
    if count(&skeleton.concealed_tiles, skeleton.pairs[1]) != 1 {
        return Err("the draw must complete the second pair from a single tile".to_string());
    }

    let pairs = pair_tiles(&skeleton.full_tiles);
    if pairs.len() != 3 {
        return Err(format!(
            "the drawn hand must hold exactly three pairs, found {pairs:?}"
        ));
    }
    for pair in skeleton.pairs {
        if !pairs.contains(&pair) {
            return Err(format!("the {pair} pair must be in the hand"));
        }
    }
    if count(&skeleton.full_tiles, skeleton.pon_target) != 2 {
        return Err("the Pon target must be a pair".to_string());
    }
    if skeleton.pon_target.suit().is_some() {
        return Err("the Pon target must be an honour".to_string());
    }

    let answer_hand = without(&skeleton.full_tiles, skeleton.answer_tile)?;
    if skeleton.answer_tile == skeleton.pon_target {
        return Err("the answer cannot be the Pon target".to_string());
    }
    if pairs.contains(&skeleton.answer_tile) {
        return Err("the answer must not break a pair".to_string());
    }
    if shanten(&answer_hand) != 2 {
        return Err("the book's discard must leave the hand 2-away".to_string());
    }
    if pair_tiles(&answer_hand).len() != 3 {
        return Err("the book's discard must keep all three pairs".to_string());
    }
    if count(&answer_hand, skeleton.pon_target) != 2 {
        return Err("the book's discard must keep the Pon target pair".to_string());
    }
    for tile in skeleton.kanchan[..1]
        .iter()
        .chain(skeleton.ryanmen.iter())
        .chain(skeleton.completed_run.iter())
    {
        if !answer_hand.contains(tile) {
            return Err(format!("the {tile} block tile must stay in the hand"));
        }
    }
    let answer_closed = ukeire(&answer_hand);

    let (answer_pon_shanten, answer_pon_acceptance) =
        pon_line(&answer_hand, skeleton.pon_target)
            .ok_or_else(|| "the Pon target pair must survive the answer".to_string())?;
    if answer_pon_shanten != 1 {
        return Err("the planned Pon must leave the hand 1-away".to_string());
    }
    let answer_follow_up = best_follow_up_pairs(&answer_hand, skeleton.pon_target)
        .ok_or_else(|| "the hand after the Pon needs a follow-up discard".to_string())?;
    if answer_follow_up.iter().any(|pairs| *pairs != 2) {
        return Err("the best discard after the Pon must leave two pairs".to_string());
    }

    let rival_hand = without(&skeleton.full_tiles, skeleton.rival_tile)?;
    if pair_tiles(&rival_hand).len() != 2 {
        return Err("the closed-hand rival must break a pair".to_string());
    }
    if shanten(&rival_hand) != 2 {
        return Err("the closed-hand rival must also leave the hand 2-away".to_string());
    }
    let rival_closed = ukeire(&rival_hand);
    if rival_closed <= answer_closed {
        return Err(format!(
            "the closed-hand oracle must prefer the pair break ({rival_closed} vs \
             {answer_closed}); otherwise this is not the open-hand lesson"
        ));
    }
    if answer_closed + TARGET_LIVE_COPIES < rival_closed {
        return Err(format!(
            "the Pon's {TARGET_LIVE_COPIES} live copies do not cover the closed gap \
             ({answer_closed} vs {rival_closed})"
        ));
    }

    let (rival_pon_shanten, rival_pon_acceptance) = pon_line(&rival_hand, skeleton.pon_target)
        .ok_or_else(|| "the rival must keep the Pon target pair".to_string())?;
    if rival_pon_shanten != 1 {
        return Err("the rival's planned Pon must also leave the hand 1-away".to_string());
    }
    if answer_pon_acceptance <= rival_pon_acceptance {
        return Err(format!(
            "the book's line must accept more after the Pon ({answer_pon_acceptance} vs \
             {rival_pon_acceptance})"
        ));
    }
    let rival_follow_up = best_follow_up_pairs(&rival_hand, skeleton.pon_target)
        .ok_or_else(|| "the rival after the Pon needs a follow-up discard".to_string())?;
    if rival_follow_up.iter().any(|pairs| *pairs != 1) {
        return Err("the rival must hold only one pair after the Pon".to_string());
    }

    let mut float_is_equivalent = false;
    for tile in distinct_tiles(&skeleton.full_tiles) {
        if tile == skeleton.answer_tile {
            continue;
        }
        let remaining = without(&skeleton.full_tiles, tile)?;
        let Some((line_shanten, line_acceptance)) = pon_line(&remaining, skeleton.pon_target)
        else {
            continue;
        };
        let better = line_shanten < answer_pon_shanten
            || (line_shanten == answer_pon_shanten && line_acceptance > answer_pon_acceptance);
        if better {
            return Err(format!(
                "discarding {tile} is better after the Pon ({line_shanten}-away, \
                 {line_acceptance} tiles)"
            ));
        }
        if tile == skeleton.float {
            float_is_equivalent = line_shanten == answer_pon_shanten
                && line_acceptance == answer_pon_acceptance
                && ukeire(&remaining) == answer_closed;
        } else if line_shanten == answer_pon_shanten && line_acceptance == answer_pon_acceptance {
            return Err(format!(
                "only the redundant float may tie the book's discard, {tile} ties it"
            ));
        }
    }

    Ok(LessonScores {
        answer_closed,
        rival_closed,
        answer_pon: answer_pon_acceptance,
        rival_pon: rival_pon_acceptance,
        float_is_equivalent,
    })
}

/// Acceptance after the planned Pon, before the mandatory follow-up discard.
///
/// The pair is removed from the concealed tiles and counted as one called meld,
/// which is exactly the 14-effective-tile position the player sees after the
/// call. Returns `None` when the target pair is no longer in the hand.
pub(super) fn pon_line(tiles: &[Tile], target: Tile) -> Option<(i8, u8)> {
    if count(tiles, target) != 2 {
        return None;
    }
    let concealed: Vec<Tile> = tiles
        .iter()
        .copied()
        .filter(|tile| *tile != target)
        .collect();
    let counts = to_counts(&concealed);
    Some((
        calculate_shanten_with_melds(&counts, 1).shanten,
        calculate_ukeire_with_melds(&counts, 1).total_count,
    ))
}

/// Pair counts of every best follow-up discard after the planned Pon.
///
/// "Best" is the lowest shanten, then the highest acceptance, matching the
/// ordinary discard order. The caller requires every such line to leave the
/// same number of pairs, so the post-Pon shape is unambiguous.
pub(super) fn best_follow_up_pairs(tiles: &[Tile], target: Tile) -> Option<Vec<usize>> {
    let concealed: Vec<Tile> = tiles
        .iter()
        .copied()
        .filter(|tile| *tile != target)
        .collect();
    let mut candidates = Vec::new();
    for discard in distinct_tiles(&concealed) {
        let remaining = without(&concealed, discard).ok()?;
        let counts = to_counts(&remaining);
        candidates.push((
            calculate_shanten_with_melds(&counts, 1).shanten,
            calculate_ukeire_with_melds(&counts, 1).total_count,
            pair_tiles(&remaining).len(),
        ));
    }
    let best_shanten = candidates.iter().map(|candidate| candidate.0).min()?;
    let best_acceptance = candidates
        .iter()
        .filter(|candidate| candidate.0 == best_shanten)
        .map(|candidate| candidate.1)
        .max()?;
    Some(
        candidates
            .into_iter()
            .filter(|candidate| candidate.0 == best_shanten && candidate.1 == best_acceptance)
            .map(|candidate| candidate.2)
            .collect(),
    )
}

/// True when `tiles` holds exactly the expected tile types and counts.
fn expected_counts(tiles: &[Tile], expected: &[(Tile, usize)]) -> bool {
    let mut counts: BTreeMap<Tile, usize> = BTreeMap::new();
    for tile in tiles {
        *counts.entry(*tile).or_insert(0) += 1;
    }
    counts.len() == expected.len()
        && expected
            .iter()
            .all(|(tile, count)| counts.get(tile) == Some(count))
}

fn count(tiles: &[Tile], tile: Tile) -> usize {
    tiles.iter().filter(|held| **held == tile).count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn skeleton_generalizes_across_suits_and_targets() {
        let mut pair_suits = HashSet::new();
        let mut targets = HashSet::new();
        let mut values = HashSet::new();

        for _ in 0..100 {
            let skeleton = build_skeleton().expect("open-hand skeleton must build");

            assert_eq!(skeleton.full_tiles.len(), 14);
            assert_eq!(skeleton.concealed_tiles.len(), 13);
            assert_eq!(pair_tiles(&skeleton.full_tiles).len(), 3);
            assert_eq!(skeleton.pairs.len(), 3);
            assert!(skeleton.pairs.contains(&skeleton.pon_target));
            assert_eq!(count(&skeleton.full_tiles, skeleton.pon_target), 2);
            assert_eq!(skeleton.answer_tile, skeleton.kanchan[1]);
            assert!(!skeleton.pairs.contains(&skeleton.answer_tile));
            assert_eq!(skeleton.rival_tile, skeleton.draw);
            assert_eq!(count(&skeleton.concealed_tiles, skeleton.draw), 1);

            let Tile::Suited {
                suit: pair_suit, ..
            } = skeleton.pairs[0]
            else {
                panic!("the first pair is suited");
            };
            pair_suits.insert(pair_suit);
            targets.insert(skeleton.pon_target);
            values.insert(skeleton.pairs[0]);
        }

        assert!(
            pair_suits.len() > 1,
            "the generator must cover several suits"
        );
        assert!(
            targets.len() > 1,
            "the generator must cover several dragons"
        );
        assert!(
            values.len() > 2,
            "the generator must cover several pair values"
        );
    }

    #[test]
    fn every_skeleton_proves_the_open_hand_rule() {
        for _ in 0..100 {
            let skeleton = build_skeleton().expect("open-hand skeleton must build");
            let scores = verify_lesson(&skeleton).expect("every skeleton must prove the discard");

            assert_eq!(scores.answer_closed, skeleton.answer_closed_acceptance);
            assert!(scores.rival_closed > scores.answer_closed);
            assert!(scores.answer_pon > scores.rival_pon);
            assert_eq!(
                skeleton.equivalent_tiles,
                scores
                    .float_is_equivalent
                    .then_some(skeleton.float)
                    .into_iter()
                    .collect::<Vec<_>>()
            );
        }
    }

    #[test]
    fn keeping_three_pairs_beats_the_closed_hand_rival_after_the_pon() {
        for _ in 0..50 {
            let skeleton = build_skeleton().expect("open-hand skeleton must build");

            let answer_hand = without(&skeleton.full_tiles, skeleton.answer_tile).unwrap();
            assert_eq!(pair_tiles(&answer_hand).len(), 3);
            assert_eq!(count(&answer_hand, skeleton.pon_target), 2);

            let (answer_shanten, answer_pon) = pon_line(&answer_hand, skeleton.pon_target).unwrap();
            assert_eq!(answer_shanten, 1);

            let rival_hand = without(&skeleton.full_tiles, skeleton.rival_tile).unwrap();
            assert_eq!(pair_tiles(&rival_hand).len(), 2);
            let (rival_shanten, rival_pon) = pon_line(&rival_hand, skeleton.pon_target).unwrap();
            assert_eq!(rival_shanten, 1);
            assert!(answer_pon > rival_pon);

            // And the ordinary closed oracle picks the other way, which is the
            // comparison the explanation has to show.
            assert!(ukeire(&rival_hand) > ukeire(&answer_hand));
        }
    }

    #[test]
    fn the_float_discards_the_same_two_tiles_in_the_other_order() {
        for _ in 0..50 {
            let skeleton = build_skeleton().expect("open-hand skeleton must build");

            if !skeleton.equivalent_tiles.contains(&skeleton.float) {
                continue;
            }

            let answer_hand = without(&skeleton.full_tiles, skeleton.answer_tile).unwrap();
            let float_hand = without(&skeleton.full_tiles, skeleton.float).unwrap();
            assert_eq!(ukeire(&float_hand), ukeire(&answer_hand));
            assert_eq!(
                pon_line(&float_hand, skeleton.pon_target),
                pon_line(&answer_hand, skeleton.pon_target)
            );
            assert_eq!(pair_tiles(&float_hand).len(), 3);
        }
    }
}
