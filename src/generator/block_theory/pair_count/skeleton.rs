use agari::tile::{Suit, Tile};

use super::super::shapes::{distinct_tiles, pair_tiles, shanten, suited, ukeire, without};
use crate::generator::support::deck::Deck;
use crate::rng::{choose, gen_range, shuffle};

/// The constructed parts of a "break a pair, not the protorun" puzzle.
///
/// Riichi Book 1, ch. 3, "Pairs and sets":
///
/// - "As long as we intend to keep the hand closed ... we should avoid having
///   three pairs in a hand. Having three pairs makes for the weakest form,
///   whereas having two pairs makes for the strongest form." (ch3:336)
/// - "2 pairs > 1 pair, 4 pairs > 3 pairs" (ch3:343)
/// - The book's own arithmetic: keeping three pairs "means the hand can no
///   longer accept" the ryanmen's two completions, so keeping the new pair
///   "gains two additional tiles" but loses 8: "The net tile acceptance gain
///   will be negative ($2-8 = -6$)." (ch3:331)
///
/// Anki 1463191498526 (rank the value of a pair count in a closed hand) and
/// 1463192072762 (three pairs beat two only when you intend to pon; that open
/// variant is a separate lesson).
///
/// The skeleton is the book's third example generalised: a 2-away hand made of
/// one completed run, three protoruns, and two pairs. The draw duplicates the
/// low tile of one ryanmen, so the hand now holds `X X X+1`: three pairs, with
/// the new pair sitting on a live side wait. Discarding the drawn tile keeps
/// two pairs *and* the `X, X+1` side wait, which is worth 8 tiles; discarding
/// the `X+1` keeps the third pair, which is worth only 2.
pub(super) struct PairCountSkeleton {
    /// All 14 tiles: the concealed hand plus the draw.
    pub full_tiles: Vec<Tile>,
    /// The 13 concealed tiles before the draw.
    pub concealed_tiles: Vec<Tile>,
    /// The tile just drawn: it duplicates the low tile of `ryanmen` and is the
    /// answer.
    pub draw: Tile,
    /// The three pairs of the 14-tile hand, including the draw's pair.
    pub pairs: [Tile; 3],
    /// The ryanmen protorun the draw duplicated, as `[draw, draw + 1]`.
    pub ryanmen: [Tile; 2],
    /// The completed run, so the hand is exactly 2-away.
    pub completed_run: [Tile; 3],
    /// The two protoruns unrelated to the decision.
    pub protoruns: [[Tile; 2]; 2],
    /// The book's discard: the tile that was just drawn.
    pub answer_tile: Tile,
    /// The other two pair tiles. Breaking any pair leaves the same two-pair
    /// hand, so they are graded as the same answer.
    pub equivalent_tiles: Vec<Tile>,
    /// The twin of the drawn tile: discarding it keeps three pairs, because
    /// the new pair survives and the side wait becomes a closed-wait float.
    pub rival_tile: Tile,
    /// Live acceptance after the book's discard.
    pub answer_acceptance: u8,
    /// Live acceptance after the rival discard that keeps three pairs.
    pub rival_acceptance: u8,
}

/// Builds one 2-away hand with three pairs and proves the book's discard on it.
pub(super) fn build_skeleton() -> Result<PairCountSkeleton, String> {
    'attempt: for _ in 0..2_000 {
        let mut deck = Deck::fresh();

        // One suit holds the completed run, one the pair plus the ryanmen that
        // the draw will duplicate, one the second pair plus a protorun. The
        // last protorun may share any suit; verification rejects a hand whose
        // blocks recombine.
        let mut suits = [Suit::Man, Suit::Pin, Suit::Sou];
        shuffle(&mut suits);
        let set_suit = suits[0];
        let pair_suit = suits[1];
        let second_pair_suit = suits[2];
        let Some(other_suit) = choose(&suits) else {
            continue 'attempt;
        };

        let run_start = gen_range(1, 8) as u8;
        let completed_run = [
            suited(set_suit, run_start),
            suited(set_suit, run_start + 1),
            suited(set_suit, run_start + 2),
        ];

        let pair_value = gen_range(1, 10) as u8;
        let second_pair_value = gen_range(1, 10) as u8;
        let ryanmen_start = gen_range(1, 9) as u8;
        let second_protorun_start = gen_range(1, 9) as u8;
        let third_protorun_start = gen_range(1, 9) as u8;

        let pair = suited(pair_suit, pair_value);
        let second_pair = suited(second_pair_suit, second_pair_value);
        let ryanmen = [
            suited(pair_suit, ryanmen_start),
            suited(pair_suit, ryanmen_start + 1),
        ];
        let protoruns = [
            [
                suited(second_pair_suit, second_protorun_start),
                suited(second_pair_suit, second_protorun_start + 1),
            ],
            [
                suited(other_suit, third_protorun_start),
                suited(other_suit, third_protorun_start + 1),
            ],
        ];

        // The draw is the second copy of the ryanmen's low tile, which makes
        // the third pair without touching any other pair.
        let draw = ryanmen[0];

        let mut concealed_tiles = Vec::with_capacity(13);
        concealed_tiles.extend(completed_run.iter().copied());
        concealed_tiles.extend([pair, pair, second_pair, second_pair]);
        concealed_tiles.extend(ryanmen.iter().copied());
        for protorun in protoruns {
            concealed_tiles.extend(protorun.iter().copied());
        }
        if concealed_tiles.len() != 13 {
            continue 'attempt;
        }
        for tile in concealed_tiles.iter().copied().chain(std::iter::once(draw)) {
            if deck.take(tile).is_err() {
                continue 'attempt;
            }
        }

        let mut full_tiles = concealed_tiles.clone();
        full_tiles.push(draw);

        let skeleton = PairCountSkeleton {
            full_tiles,
            concealed_tiles,
            draw,
            pairs: [pair, second_pair, draw],
            ryanmen,
            completed_run,
            protoruns,
            answer_tile: draw,
            equivalent_tiles: vec![pair, second_pair],
            rival_tile: ryanmen[1],
            answer_acceptance: 0,
            rival_acceptance: 0,
        };

        let (answer_acceptance, rival_acceptance) = match verify_lesson(&skeleton) {
            Ok(acceptance) => acceptance,
            Err(_) => continue 'attempt,
        };

        return Ok(PairCountSkeleton {
            answer_acceptance,
            rival_acceptance,
            ..skeleton
        });
    }

    Err("Failed to construct a three-pair hand".to_string())
}

/// Proves the book's rule for one hand, returning the two acceptance counts.
///
/// (a) the hand was already 2-away before the draw and still is after it;
/// (b) it holds exactly three pairs, one of them the drawn tile's;
/// (c) discarding the drawn tile breaks a pair, leaves 2-away, and keeps the
///     same acceptance as breaking either of the other two pairs;
/// (d) discarding the drawn tile's twin keeps all three pairs and accepts
///     strictly fewer tiles;
/// (e) every other discard that stays 2-away is also strictly worse, so the
///     answer is never a tie with a move that keeps three pairs.
pub(super) fn verify_lesson(skeleton: &PairCountSkeleton) -> Result<(u8, u8), String> {
    if skeleton.full_tiles.len() != 14 {
        return Err("a turn hand must hold fourteen tiles".to_string());
    }
    if shanten(&skeleton.concealed_tiles) != 2 {
        return Err("the hand before the draw must already be 2-away".to_string());
    }
    if shanten(&skeleton.full_tiles) != 2 {
        return Err("the drawn hand must still be 2-away".to_string());
    }

    let pairs = pair_tiles(&skeleton.full_tiles);
    if pairs.len() != 3 {
        return Err(format!(
            "the drawn hand must hold exactly three pairs, found {pairs:?}"
        ));
    }
    if !pairs.contains(&skeleton.draw) {
        return Err("the draw must complete one of the three pairs".to_string());
    }

    let answer_hand = without(&skeleton.full_tiles, skeleton.answer_tile)?;
    if shanten(&answer_hand) != 2 {
        return Err("the book's discard must leave the hand 2-away".to_string());
    }
    if pair_tiles(&answer_hand).len() != 2 {
        return Err("the book's discard must break a pair".to_string());
    }
    let answer_acceptance = ukeire(&answer_hand);

    let rival_hand = without(&skeleton.full_tiles, skeleton.rival_tile)?;
    if pair_tiles(&rival_hand).len() != 3 {
        return Err("the rival discard must keep all three pairs".to_string());
    }
    let rival_acceptance = ukeire(&rival_hand);
    if answer_acceptance <= rival_acceptance {
        return Err(format!(
            "the book's discard accepts {answer_acceptance} tiles, keeping three pairs \
             accepts {rival_acceptance}"
        ));
    }

    for tile in distinct_tiles(&skeleton.full_tiles) {
        if tile == skeleton.answer_tile {
            continue;
        }
        let remaining = without(&skeleton.full_tiles, tile)?;
        if shanten(&remaining) != 2 {
            continue;
        }
        let total = ukeire(&remaining);
        if pair_tiles(&remaining).len() == 2 {
            if total != answer_acceptance {
                return Err(format!(
                    "breaking the {tile} pair accepts {total}, not {answer_acceptance}: the \
                     pair choice would not be interchangeable"
                ));
            }
        } else if total >= answer_acceptance {
            return Err(format!(
                "discarding {tile} keeps three pairs but accepts {total} tiles, at least the \
                 book's {answer_acceptance}"
            ));
        }
    }

    Ok((answer_acceptance, rival_acceptance))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn skeleton_generalizes_across_suits_and_pairs() {
        let mut pair_suits = HashSet::new();
        let mut pair_values = HashSet::new();
        let mut ryanmen_starts = HashSet::new();

        for _ in 0..100 {
            let skeleton = build_skeleton().expect("three-pair skeleton must build");

            assert_eq!(skeleton.full_tiles.len(), 14);
            assert_eq!(skeleton.concealed_tiles.len(), 13);
            assert_eq!(pair_tiles(&skeleton.full_tiles).len(), 3);

            // The draw duplicates the low tile of the ryanmen.
            assert_eq!(skeleton.draw, skeleton.ryanmen[0]);
            assert_ne!(skeleton.draw, skeleton.ryanmen[1]);
            assert_eq!(skeleton.answer_tile, skeleton.draw);
            assert!(skeleton.pairs.contains(&skeleton.draw));

            // The answer's pair is the drawn one, so the pair tile is the draw
            // and the two interchangeable tiles are the other pairs.
            assert_eq!(skeleton.equivalent_tiles.len(), 2);
            assert!(!skeleton.equivalent_tiles.contains(&skeleton.draw));

            // The rival is the ryanmen twin and keeps the new pair.
            assert_eq!(skeleton.rival_tile, skeleton.ryanmen[1]);

            let Tile::Suited {
                suit: pair_suit,
                value: pair_value,
            } = skeleton.pairs[0]
            else {
                panic!("pairs are suited");
            };
            pair_suits.insert(pair_suit);
            pair_values.insert(pair_value);

            let Tile::Suited {
                suit: ryanmen_suit,
                value: ryanmen_value,
            } = skeleton.ryanmen[0]
            else {
                panic!("the ryanmen is suited");
            };
            assert_eq!(Some(ryanmen_suit), skeleton.pairs[0].suit());
            ryanmen_starts.insert((ryanmen_suit, ryanmen_value));
        }

        assert!(
            pair_suits.len() > 1,
            "the generator must cover several suits"
        );
        assert!(
            pair_values.len() > 2,
            "the generator must cover several pair values"
        );
        assert!(
            ryanmen_starts.len() > 4,
            "the generator must cover several side waits"
        );
    }

    #[test]
    fn every_skeleton_proves_the_book_rule() {
        for _ in 0..100 {
            let skeleton = build_skeleton().expect("three-pair skeleton must build");
            let (answer, rival) =
                verify_lesson(&skeleton).expect("every skeleton must prove the discard");

            assert_eq!(answer, skeleton.answer_acceptance);
            assert_eq!(rival, skeleton.rival_acceptance);
            assert!(
                answer > rival,
                "the book's discard must accept more tiles ({answer} vs {rival})"
            );
        }
    }

    #[test]
    fn the_answer_is_the_drawn_tile_and_breaking_the_other_pairs_is_equal() {
        for _ in 0..50 {
            let skeleton = build_skeleton().expect("three-pair skeleton must build");
            let answer_hand = without(&skeleton.full_tiles, skeleton.answer_tile).unwrap();
            let answer_acceptance = ukeire(&answer_hand);

            for tile in &skeleton.equivalent_tiles {
                let hand = without(&skeleton.full_tiles, *tile).unwrap();
                assert_eq!(pair_tiles(&hand).len(), 2, "{tile} must break a pair");
                assert_eq!(shanten(&hand), 2);
                assert_eq!(
                    ukeire(&hand),
                    answer_acceptance,
                    "breaking {tile} must be as good as the book's discard"
                );
            }

            // Keeping the third pair loses the side wait's eight tiles.
            let rival_hand = without(&skeleton.full_tiles, skeleton.rival_tile).unwrap();
            assert_eq!(pair_tiles(&rival_hand).len(), 3);
            assert!(ukeire(&rival_hand) < answer_acceptance);
        }
    }
}
