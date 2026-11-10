use agari::tile::Tile;

use crate::generator::support::deck::Deck;
use crate::rng::{gen_bool, gen_range, shuffle};
use crate::state::{DiscardTile, PlayerState, Wind};

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

/// Rank-ordered scores where the human is 2nd or 3rd, close behind.
pub fn placement_desperation_ranked_scores(human_rank: usize) -> [i32; 4] {
    assert!(human_rank == 1 || human_rank == 2);

    loop {
        let gap = gen_range(300, 2_000) as i32;

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
/// Scores are seat-ordered with the human at index 0.
pub fn deal_opponents(
    deck: &mut Deck,
    human_wind: Wind,
    scores: &[i32; 4],
    discard_count: usize,
) -> Option<OpponentDeal> {
    let opponent_meta = [(1usize, "Shimocha"), (2, "Toimen"), (3, "Kamicha")];

    let mut players = Vec::with_capacity(3);
    let mut rivers = Vec::with_capacity(3);
    for (index, (seat, name)) in opponent_meta.iter().enumerate() {
        let hand = deck.draw_n(13)?;
        let river = deck.draw_n(discard_count)?;
        rivers.push(river.clone());
        players.push(PlayerState {
            seat: *seat,
            name: name.to_string(),
            is_human: false,
            wind: human_wind.next(*seat),
            score: scores[index + 1],
            hand: hand.iter().map(|tile| tile.to_string()).collect(),
            draw: None,
            red_fives: Vec::new(),
            discards: discards_from_tiles(&river),
            melds: Vec::new(),
            is_riichi: false,
            riichi_discard_index: None,
        });
    }

    Some(OpponentDeal { players, rivers })
}

#[cfg(test)]
mod tests {
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
}
