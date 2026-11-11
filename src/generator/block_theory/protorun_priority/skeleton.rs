#[cfg(test)]
use agari::parse::TileCounts;
use agari::parse::{to_counts, validate_hand};
use agari::shanten::{calculate_shanten, calculate_ukeire};
use agari::tile::{Honor, Suit, Tile};

use crate::generator::support::deck::Deck;
use crate::rng::{choose, gen_bool, gen_range, shuffle};

/// The constructed parts of a "which protorun do I break?" puzzle.
///
/// Riichi Book 1, ch. 3, "Protoruns (taatsu)" ranks the two-tile shapes by how
/// many tiles they accept (the table at ch3:190, and the value box at ch3:230):
///
/// - "a side-wait (ryanmen) protorun can accept twice as many tiles as a
///   closed-wait (kanchan) protorun or an edge-wait (penchan) protorun can."
///   (ch3:205)
/// - "side wait > closed wait > edge wait" (ch3:230)
/// - "35, 46, 57 > 13, 24, 68, 79" (ch3:263) ranks the closed waits themselves.
///
/// Anki 1463190904723 — the three protoruns accept 8 / 4 / 4 tiles.
/// Anki 1463191027124 — rank them by value (the box above).
/// Anki 1463191427816 — rank the closed-wait protoruns by versatility.
///
/// The skeleton is the one-block-too-many hand the ranking decides: six blocks
/// (two complete sets, the head, two side waits and one closed wait) for five
/// slots. None of the tiles is redundant on its own, so the hand must break a
/// protorun, and the closed wait is the cheapest block to lose:
///
/// - breaking the closed wait keeps both side waits: 8 + 8 tiles;
/// - breaking either side wait keeps only the closed wait plus the other side
///   wait: 4 + 8 tiles.
///
/// The two tiles of a closed wait are the *same* discard, so the answer is the
/// one the player just drew and [`Self::equivalent_tile`] is graded as equal.
pub(super) struct ProtorunPrioritySkeleton {
    /// All 14 tiles for evaluation, including the open Yakuhai meld.
    pub full_tiles: Vec<Tile>,
    /// The 11 concealed tiles before the discard.
    pub concealed_tiles: Vec<Tile>,
    /// The two side-wait protoruns that must survive the discard.
    pub ryanmen: [[Tile; 2]; 2],
    /// The completion tiles of each side wait, in the same order as `ryanmen`.
    pub ryanmen_waits: [[Tile; 2]; 2],
    /// The closed-wait protorun: two tiles exactly two ranks apart.
    pub kanchan: [Tile; 2],
    /// The single tile that completes the closed wait.
    pub kanchan_wait: Tile,
    /// The tile the answer discards: the closed-wait tile the player drew.
    pub answer_tile: Tile,
    /// The other closed-wait tile: the identical shape decision.
    pub equivalent_tile: Tile,
    /// The three tiles of the open Yakuhai meld.
    pub open_meld_tiles: Vec<Tile>,
}

/// Builds the six-block 1-away hand. [`verify_lesson`] proves the ranking.
pub(super) fn build_skeleton() -> Result<ProtorunPrioritySkeleton, String> {
    'attempt: for _ in 0..512 {
        let mut deck = Deck::fresh();

        // One protorun per suit: the blocks then never share a tile or a
        // completion, so the ukeire comparison is exactly the book's table.
        let mut suits = [Suit::Man, Suit::Pin, Suit::Sou];
        shuffle(&mut suits);
        let mut suit_iter = suits.into_iter();

        // Two side waits. The lower tile stays inside 2..=7 so both remaining
        // tiles are real ryanmen completions (23-24 ... 78-79 style), never an
        // edge-wait 1-2 or 8-9.
        let mut ryanmen = [[Tile::Honor(Honor::East); 2]; 2];
        let mut ryanmen_waits = [[Tile::Honor(Honor::East); 2]; 2];
        for slot in 0..2 {
            let Some(suit) = suit_iter.next() else {
                continue 'attempt;
            };
            let base = gen_range(2, 8) as u8;
            let low = suited(suit, base);
            let high = suited(suit, base + 1);
            for tile in [low, high] {
                if deck.take(tile).is_err() {
                    continue 'attempt;
                }
            }
            ryanmen[slot] = [low, high];
            ryanmen_waits[slot] = [suited(suit, base - 1), suited(suit, base + 2)];
        }

        // The closed wait, in the third suit: 13, 24, ... 79 all accept exactly
        // one kind--four tiles.
        let Some(suit) = suit_iter.next() else {
            continue 'attempt;
        };
        let base = gen_range(1, 8) as u8;
        let kanchan = [suited(suit, base), suited(suit, base + 2)];
        let kanchan_wait = suited(suit, base + 1);
        for tile in kanchan {
            if deck.take(tile).is_err() {
                continue 'attempt;
            }
        }

        // Open Yakuhai triplet: any dragon guarantees a yaku, and the open meld
        // makes Riichi illegal, so the answer is the discard alone (dama).
        let dragons = [
            Tile::Honor(Honor::White),
            Tile::Honor(Honor::Green),
            Tile::Honor(Honor::Red),
        ];
        let dragon = match choose(&dragons) {
            Some(tile) => tile,
            None => continue 'attempt,
        };
        let open_meld_tiles = vec![dragon, dragon, dragon];
        if deck.take_n(dragon, 3).is_err() {
            continue 'attempt;
        }

        // A second complete set and the head, both in honours, so they cannot
        // recombine with the suited blocks into a seventh block. The wind
        // triplet avoids East: the human is the dealer, so an East triplet
        // would be a second yakuhai.
        let wind_candidates: Vec<Tile> = [Honor::South, Honor::West, Honor::North]
            .into_iter()
            .map(Tile::Honor)
            .filter(|tile| deck.count(*tile) >= 3)
            .collect();
        let Some(wind) = choose(&wind_candidates) else {
            continue 'attempt;
        };
        if deck.take_n(wind, 3).is_err() {
            continue 'attempt;
        }

        let pair_candidates: Vec<Tile> = [
            Honor::East,
            Honor::South,
            Honor::West,
            Honor::North,
            Honor::White,
            Honor::Green,
            Honor::Red,
        ]
        .into_iter()
        .map(Tile::Honor)
        .filter(|tile| *tile != wind && deck.count(*tile) >= 2)
        .collect();
        let Some(pair) = choose(&pair_candidates) else {
            continue 'attempt;
        };
        if deck.take_n(pair, 2).is_err() {
            continue 'attempt;
        }

        let mut concealed_tiles = Vec::with_capacity(11);
        concealed_tiles.extend(ryanmen.iter().flatten().copied());
        concealed_tiles.extend(kanchan.iter().copied());
        concealed_tiles.extend([wind, wind, wind]);
        concealed_tiles.extend([pair, pair]);

        let mut full_tiles = concealed_tiles.clone();
        full_tiles.extend(open_meld_tiles.iter().copied());
        if validate_hand(&full_tiles).is_err() {
            continue 'attempt;
        }

        // The player has just drawn the closed wait's other tile: the draw is
        // what made the sixth block, so it is the natural discard.
        let (answer_tile, equivalent_tile) = if gen_bool(0.5) {
            (kanchan[0], kanchan[1])
        } else {
            (kanchan[1], kanchan[0])
        };

        let skeleton = ProtorunPrioritySkeleton {
            full_tiles,
            concealed_tiles,
            ryanmen,
            ryanmen_waits,
            kanchan,
            kanchan_wait,
            answer_tile,
            equivalent_tile,
            open_meld_tiles,
        };

        // Verify inside the loop so a hand the ranking does not decide cleanly
        // is simply re-rolled, like any other rejected candidate.
        if verify_lesson(&skeleton).is_err() {
            continue 'attempt;
        }

        return Ok(skeleton);
    }

    Err("Failed to construct a valid protorun priority hand".to_string())
}

/// One candidate discard's shanten and acceptance.
pub(super) struct DiscardEvaluation {
    pub shanten: i8,
    pub tiles: Vec<Tile>,
    pub total: u8,
}

/// Evaluates the full hand after discarding one copy of `tile`.
pub(super) fn evaluate_discard(
    full_tiles: &[Tile],
    tile: Tile,
) -> Result<DiscardEvaluation, String> {
    let mut remaining = full_tiles.to_vec();
    let index = remaining
        .iter()
        .position(|held| *held == tile)
        .ok_or_else(|| format!("{tile} is not in the hand"))?;
    remaining.remove(index);

    let counts = to_counts(&remaining);
    let result = calculate_ukeire(&counts);
    Ok(DiscardEvaluation {
        shanten: result.shanten,
        tiles: result.tiles.iter().map(|ukeire| ukeire.tile).collect(),
        total: result.total_count,
    })
}

/// Proves the lesson for one hand: the closed wait is the block to break.
///
/// Riichi Book 1, ch. 3 (ch3:205, ch3:230): a side wait accepts twice as many
/// tiles as a closed wait. With one block too many, every discard either raises
/// shanten or breaks a block, so the discard that keeps both side waits must
/// have the largest acceptance -- and it must be strictly larger than every
/// other shape-preserving discard. Ties are rejected: a hand where breaking the
/// closed wait merely ties another discard cannot teach the ranking.
///
/// Both tiles of the closed wait are the same decision, so they are allowed to
/// tie with each other (and only with each other).
pub(super) fn verify_lesson(skeleton: &ProtorunPrioritySkeleton) -> Result<(), String> {
    if calculate_shanten(&to_counts(&skeleton.full_tiles)).shanten != 1 {
        return Err("protorun priority hand must be 1-away".to_string());
    }

    // The answer has to be a tile of the closed wait, and its twin the other one.
    if !skeleton.kanchan.contains(&skeleton.answer_tile)
        || !skeleton.kanchan.contains(&skeleton.equivalent_tile)
    {
        return Err("the answer must break the closed-wait protorun".to_string());
    }

    let answer = evaluate_discard(&skeleton.full_tiles, skeleton.answer_tile)?;
    let equivalent = evaluate_discard(&skeleton.full_tiles, skeleton.equivalent_tile)?;

    if answer.shanten != 1 || equivalent.shanten != 1 {
        return Err("breaking the closed wait must leave the hand 1-away".to_string());
    }
    if answer.total != equivalent.total {
        return Err(format!(
            "the closed wait's two tiles must be equivalent: {} vs {}",
            answer.total, equivalent.total
        ));
    }
    if answer.tiles.contains(&skeleton.kanchan_wait) {
        return Err("breaking the closed wait must not keep waiting on it".to_string());
    }

    // Both side waits have to survive: each completion stays live.
    let waits: Vec<Tile> = skeleton.ryanmen_waits.iter().flatten().copied().collect();
    for wait in &waits {
        if !answer.tiles.contains(wait) {
            return Err(format!(
                "discarding {} kills the side wait on {wait}",
                skeleton.answer_tile
            ));
        }
    }
    if answer.tiles.len() != waits.len() {
        return Err("the only acceptance must be the two side waits".to_string());
    }

    // No other discard may keep 1-shanten at the same or better acceptance.
    let mut seen: Vec<Tile> = Vec::new();
    for tile in &skeleton.concealed_tiles {
        if *tile == skeleton.answer_tile || *tile == skeleton.equivalent_tile {
            continue;
        }
        if seen.contains(tile) {
            continue;
        }
        seen.push(*tile);

        let rival = evaluate_discard(&skeleton.full_tiles, *tile)?;
        if rival.shanten == 0 {
            return Err(format!("discarding {tile} makes the hand ready"));
        }
        if rival.shanten == 1 && rival.total >= answer.total {
            return Err(format!(
                "discarding {tile} keeps {} tiles against the closed wait's {}",
                rival.total, answer.total
            ));
        }
    }

    Ok(())
}

fn suited(suit: Suit, value: u8) -> Tile {
    Tile::Suited { suit, value }
}

/// Counts the hand after removing one copy of `discard`.
#[cfg(test)]
fn counts_without(tiles: &[Tile], discard: Tile) -> Option<TileCounts> {
    let mut remaining = tiles.to_vec();
    let index = remaining.iter().position(|tile| *tile == discard)?;
    remaining.remove(index);
    Some(to_counts(&remaining))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn skeleton_generalizes_across_suits_and_shapes() {
        let mut kanchan_bases = HashSet::new();
        let mut ryanmen_bases = HashSet::new();

        for _ in 0..100 {
            let skeleton = build_skeleton().expect("protorun priority skeleton must build");

            assert_eq!(skeleton.full_tiles.len(), 14);
            assert_eq!(skeleton.concealed_tiles.len(), 11);
            assert_eq!(skeleton.open_meld_tiles.len(), 3);
            assert!(validate_hand(&skeleton.full_tiles).is_ok());

            // The two side waits are adjacent tiles in their own suits.
            let mut suits = HashSet::new();
            for (slot, [low, high]) in skeleton.ryanmen.iter().enumerate() {
                let (
                    Tile::Suited { suit, value },
                    Tile::Suited {
                        suit: suit2,
                        value: high_value,
                    },
                ) = (*low, *high)
                else {
                    panic!("side waits must be suited");
                };
                assert_eq!(suit, suit2);
                assert_eq!(high_value, value + 1, "side wait tiles must be adjacent");
                assert!(
                    (2..=7).contains(&value),
                    "side wait base must stay in 2..=7"
                );
                assert!(
                    suits.insert(suit),
                    "each protorun must live in its own suit"
                );
                assert_eq!(
                    skeleton.ryanmen_waits[slot],
                    [suited(suit, value - 1), suited(suit, value + 2)]
                );
                ryanmen_bases.insert(value);
            }

            // The closed wait is two ranks apart in the third suit.
            let [low, high] = skeleton.kanchan;
            let (
                Tile::Suited { suit, value },
                Tile::Suited {
                    suit: suit2,
                    value: high_value,
                },
            ) = (low, high)
            else {
                panic!("the closed wait must be suited");
            };
            assert_eq!(suit, suit2);
            assert_eq!(high_value, value + 2, "closed wait tiles are two apart");
            assert!((1..=7).contains(&value));
            assert!(suits.insert(suit), "the closed wait needs its own suit");
            assert_eq!(skeleton.kanchan_wait, suited(suit, value + 1));
            kanchan_bases.insert(value);

            // The answer and its equivalent are exactly the closed wait.
            let mut closed = [skeleton.answer_tile, skeleton.equivalent_tile];
            closed.sort();
            let mut expected = skeleton.kanchan;
            expected.sort();
            assert_eq!(closed, expected);
            assert!(
                !skeleton
                    .ryanmen
                    .iter()
                    .flatten()
                    .any(|tile| *tile == skeleton.answer_tile)
            );
        }

        assert!(
            kanchan_bases.len() > 2,
            "generator must cover several closed waits"
        );
        assert!(
            ryanmen_bases.len() > 2,
            "generator must cover several side waits"
        );
    }

    #[test]
    fn breaking_the_closed_wait_keeps_both_side_waits() {
        for _ in 0..50 {
            let skeleton = build_skeleton().expect("protorun priority skeleton must build");
            verify_lesson(&skeleton).expect("every skeleton must prove the ranking");

            let answer = evaluate_discard(&skeleton.full_tiles, skeleton.answer_tile)
                .expect("the answer is in the hand");
            assert_eq!(answer.shanten, 1);
            assert_eq!(answer.tiles.len(), 4, "two live completions per side wait");
            assert_eq!(answer.total, 16, "8 + 8 theoretical tiles");

            // Breaking a side wait keeps the closed wait instead: 4 + 8.
            for [low, _high] in skeleton.ryanmen {
                let rival =
                    evaluate_discard(&skeleton.full_tiles, low).expect("side wait tile in hand");
                assert_eq!(rival.shanten, 1);
                assert_eq!(rival.total, 12);
                assert!(answer.total > rival.total);
            }
        }
    }

    #[test]
    fn no_other_discard_reaches_the_closed_wait_acceptance() {
        for _ in 0..50 {
            let skeleton = build_skeleton().expect("protorun priority skeleton must build");
            let answer = evaluate_discard(&skeleton.full_tiles, skeleton.answer_tile)
                .expect("answer in hand");

            let mut best_rival = 0;
            let mut seen = HashSet::new();
            for tile in &skeleton.concealed_tiles {
                if *tile == skeleton.answer_tile || *tile == skeleton.equivalent_tile {
                    continue;
                }
                if !seen.insert(*tile) {
                    continue;
                }
                let rival = evaluate_discard(&skeleton.full_tiles, *tile).expect("tile in hand");
                assert_ne!(rival.shanten, 0, "no discard may leave the hand ready");
                if rival.shanten == 1 {
                    best_rival = best_rival.max(rival.total);
                }
            }
            assert!(
                best_rival < answer.total,
                "a rival discard kept {best_rival} against {}",
                answer.total
            );
        }
    }

    #[test]
    fn the_drawn_closed_wait_tile_is_the_answer() {
        for _ in 0..50 {
            let skeleton = build_skeleton().expect("protorun priority skeleton must build");

            // The hand without the drawn tile still holds the other closed-wait
            // tile as a float, and is still 1-away with both side waits live.
            let counts =
                counts_without(&skeleton.full_tiles, skeleton.answer_tile).expect("answer in hand");
            assert_eq!(calculate_shanten(&counts).shanten, 1);
            let ukeire = calculate_ukeire(&counts);
            assert_eq!(ukeire.total_count, 16);
            assert!(skeleton.equivalent_tile != skeleton.answer_tile);
        }
    }
}
