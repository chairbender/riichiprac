use agari::parse::{to_counts, validate_hand};
use agari::shanten::{calculate_shanten, calculate_ukeire};
use agari::tile::{Honor, Suit, Tile};

use crate::generator::support::deck::Deck;
use crate::rng::{choose, shuffle};

/// The constructed parts of a "keep the skipping tile, throw the isolated one"
/// puzzle.
///
/// Riichi Book 1, ch. 3, *Skipping shape*, defines the shape and states its
/// value in one sentence (ch3:713):
///
/// > When we have a floating tile two tiles away from a run, we have a skipping
/// > shape. ... `3` in a skipping shape is more valuable than isolated `3`,
/// > because it increases the kinds of tiles the hand can accept to produce a
/// > protorun or a 3-way side-wait shape.
///
/// Table `tbl:skipping` (ch3:716) lists the ten shapes and the tiles each one
/// accepts; the book's own example hand (ch3:787) holds `3m` isolated and `3p`
/// jumping to `567p`, and answers "keep `3p` and discard `3m`" (ch3:795).
///
/// The hand is the book's, generalised: two complete sets (the skipping run and
/// a dragon triplet), three protoruns, and the two competing floats. In that
/// shape both discards leave the hand 2-away and accept exactly the same tiles
/// — the two floats are worth only their own kind — so the hand's acceptance
/// does not decide. What decides is the book's count: the skipping group turns
/// into a run plus a protorun on five kinds of draws, the isolated tile on four
/// (see [`skipping_turns`] and [`isolated_turns`]).
///
/// Anki 1463194258219 (definition) and 1463194377641 (value over an isolated
/// float).
pub(super) struct SkippingBlockSkeleton {
    /// All 14 tiles for evaluation.
    pub full_tiles: Vec<Tile>,
    /// The 13 concealed tiles before the discard.
    pub concealed_tiles: Vec<Tile>,
    /// The skipping float, kept by the answer.
    pub skipping_float: Tile,
    /// The complete run the float skips to.
    pub run: [Tile; 3],
    /// The isolated float, thrown by the answer.
    pub isolated_float: Tile,
    /// The three protoruns the rest of the hand waits on.
    pub protoruns: [[Tile; 2]; 3],
    /// The triplet that completes the second set.
    pub set_tile: Tile,
    /// The tile the player just drew: the isolated float.
    pub draw: Tile,
    /// The tile the answer discards.
    pub answer_tile: Tile,
}

/// Builds the book's hand and proves the skipping-versus-isolated comparison.
pub(super) fn build_skeleton() -> Result<SkippingBlockSkeleton, String> {
    'attempt: for _ in 0..512 {
        let mut deck = Deck::fresh();

        // One suit for the skipping group and one for the isolated float, with
        // the two protoruns that share its suit kept three ranks away; nothing
        // can then recombine with something else by accident.
        let mut suits = [Suit::Man, Suit::Pin, Suit::Sou];
        shuffle(&mut suits);
        let (skip_suit, isolated_suit, protorun_suit) = (suits[0], suits[1], suits[2]);

        // Every skipping shape the book lists (ch3:716): the float skips one
        // empty rank to a complete run. `verify_lesson` then keeps only the ones
        // whose protorun draws strictly beat an isolated float of the same rank,
        // so the two shapes whose float is a middle 5 (5789 and 1235), which
        // only tie with an isolated 5, never reach a player.
        let mut shapes: Vec<(Tile, [Tile; 3])> = Vec::new();
        for value in 1..=9u8 {
            let float = suited(skip_suit, value);
            // The run above the float: 3 + 567, 4 + 678, ...
            if value + 4 <= 9 {
                shapes.push((
                    float,
                    [
                        suited(skip_suit, value + 2),
                        suited(skip_suit, value + 3),
                        suited(skip_suit, value + 4),
                    ],
                ));
            }
            // The run below the float: 234 + 6, 345 + 7, ...
            if value >= 5 {
                shapes.push((
                    float,
                    [
                        suited(skip_suit, value - 4),
                        suited(skip_suit, value - 3),
                        suited(skip_suit, value - 2),
                    ],
                ));
            }
        }
        shapes.retain(|(float, run)| skipping_turns(*float, *run) > isolated_turns(*float));
        let Some((skipping_float, run)) = choose(&shapes) else {
            continue 'attempt;
        };

        // The book's example compares two tiles of the *same* rank (3m against
        // 3p), so the question is the shape alone and not the tile's number.
        let value = value_of(skipping_float);
        let isolated_float = suited(isolated_suit, value);
        if isolated_turns(isolated_float).len() != isolated_turns(skipping_float).len() {
            continue 'attempt;
        }

        // One protorun sharing the isolated float's suit, kept three ranks away
        // so the float really is isolated and the two cannot combine.
        let mut isolated_suit_protoruns: Vec<[Tile; 2]> = Vec::new();
        for low in 1..=7u8 {
            for width in [1u8, 2] {
                let protorun = [
                    suited(isolated_suit, low),
                    suited(isolated_suit, low + width),
                ];
                if protorun
                    .iter()
                    .all(|tile| value_of(*tile).abs_diff(value) >= 3)
                {
                    isolated_suit_protoruns.push(protorun);
                }
            }
        }
        let Some(isolated_suit_protorun) = choose(&isolated_suit_protoruns) else {
            continue 'attempt;
        };

        // Two protoruns in the third suit, with at least two empty ranks between
        // them so they stay separate blocks.
        let mut pair_candidates: Vec<([Tile; 2], [Tile; 2])> = Vec::new();
        for first_low in 1..=7u8 {
            for first_width in [1u8, 2] {
                let first = [
                    suited(protorun_suit, first_low),
                    suited(protorun_suit, first_low + first_width),
                ];
                for second_low in 1..=7u8 {
                    for second_width in [1u8, 2] {
                        let second = [
                            suited(protorun_suit, second_low),
                            suited(protorun_suit, second_low + second_width),
                        ];
                        let first_high = first_low + first_width;
                        if second_low < first_high + 3 {
                            continue;
                        }
                        pair_candidates.push((first, second));
                    }
                }
            }
        }
        let Some((second_protorun, third_protorun)) = choose(&pair_candidates) else {
            continue 'attempt;
        };

        // A dragon triplet gives the hand a yaku without touching the suit
        // blocks, so the decision stays a pure shape question.
        let dragons = [
            Tile::Honor(Honor::White),
            Tile::Honor(Honor::Green),
            Tile::Honor(Honor::Red),
        ];
        let Some(set_tile) = choose(&dragons) else {
            continue 'attempt;
        };

        let protoruns = [isolated_suit_protorun, second_protorun, third_protorun];
        let mut concealed_tiles: Vec<Tile> = Vec::with_capacity(13);
        concealed_tiles.push(skipping_float);
        concealed_tiles.extend(run);
        concealed_tiles.extend([set_tile; 3]);
        concealed_tiles.extend(protoruns.iter().flatten().copied());

        let mut full_tiles = concealed_tiles.clone();
        full_tiles.push(isolated_float);

        for tile in &full_tiles {
            if deck.take(*tile).is_err() {
                continue 'attempt;
            }
        }
        if validate_hand(&full_tiles).is_err() {
            continue 'attempt;
        }

        let skeleton = SkippingBlockSkeleton {
            full_tiles,
            concealed_tiles,
            skipping_float,
            run,
            isolated_float,
            protoruns,
            set_tile,
            draw: isolated_float,
            answer_tile: isolated_float,
        };

        // Verify inside the loop so a hand the count does not decide cleanly is
        // simply re-rolled, like any other rejected candidate.
        if verify_lesson(&skeleton).is_err() {
            continue 'attempt;
        }

        return Ok(skeleton);
    }

    Err("Failed to construct a valid skipping-shape hand".to_string())
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

/// Proves the lesson for one hand: the skipping tile is the one to keep.
///
/// Three things have to hold, and together they are the book's argument:
///
/// 1. the hand is 2-away, so the question is which float to keep and not a
///    ready-hand wait;
/// 2. discarding either float leaves the hand 2-away with *the same*
///    acceptance, so the hand's own count does not decide the discard — the
///    two floats are worth only their own kind;
/// 3. the skipping group turns into a run plus a protorun on strictly more
///    kinds of draws than the isolated tile does (ch3:713, `tbl:skipping`).
///
/// A shape that fails (3) only ties the isolated float of its own rank - the
/// `5789` and `1235` shapes, whose float is a middle 5 - so it is re-rolled
/// instead of being taught as a rule.
pub(super) fn verify_lesson(skeleton: &SkippingBlockSkeleton) -> Result<(), String> {
    if calculate_shanten(&to_counts(&skeleton.full_tiles)).shanten != 2 {
        return Err("skipping-shape hand must be 2-away".to_string());
    }

    if skeleton.answer_tile != skeleton.isolated_float {
        return Err("the answer must discard the isolated float".to_string());
    }

    // The rest of the hand is the book's: an honour triplet and three protoruns.
    if skeleton
        .full_tiles
        .iter()
        .filter(|tile| **tile == skeleton.set_tile)
        .count()
        != 3
    {
        return Err("the hand needs its honour triplet".to_string());
    }
    for protorun in &skeleton.protoruns {
        for tile in protorun {
            if !skeleton.full_tiles.contains(tile) {
                return Err(format!("the hand is missing protorun tile {tile}"));
            }
        }
    }

    // The isolated float has to be alone in its suit, or it is not isolated.
    let Tile::Suited {
        suit: isolated_suit,
        value: isolated_value,
    } = skeleton.isolated_float
    else {
        return Err("the isolated float must be a suited tile".to_string());
    };
    for tile in &skeleton.full_tiles {
        if let Tile::Suited { suit, value } = *tile
            && suit == isolated_suit
            && value != isolated_value
            && value.abs_diff(isolated_value) <= 2
        {
            return Err(format!(
                "{} is not isolated: it holds {tile} within two ranks",
                skeleton.isolated_float
            ));
        }
    }

    // The skipping float has to really skip to its run.
    let Tile::Suited {
        suit: skip_suit,
        value: skip_value,
    } = skeleton.skipping_float
    else {
        return Err("the skipping float must be a suited tile".to_string());
    };
    let run_low = value_of(skeleton.run[0]);
    // The float is either two ranks below the run or two ranks above it.
    let skips = run_low == skip_value + 2 || skip_value == run_low + 4;
    if !skips
        || skeleton
            .run
            .iter()
            .any(|tile| tile.suit() != Some(skip_suit))
    {
        return Err("the skipping float must sit two ranks from its run".to_string());
    }
    for (index, tile) in skeleton.run.iter().enumerate() {
        if value_of(*tile) != run_low + index as u8 {
            return Err("the skipping run must be three consecutive tiles".to_string());
        }
    }

    let keep_skipping = evaluate_discard(&skeleton.full_tiles, skeleton.isolated_float)?;
    let keep_isolated = evaluate_discard(&skeleton.full_tiles, skeleton.skipping_float)?;

    if keep_skipping.shanten != 2 || keep_isolated.shanten != 2 {
        return Err("both discards must leave the hand 2-away".to_string());
    }
    if keep_skipping.total != keep_isolated.total
        || keep_skipping.tiles.len() != keep_isolated.tiles.len()
    {
        return Err(format!(
            "the two floats must accept the same tiles on their own: {} vs {}",
            keep_skipping.total, keep_isolated.total
        ));
    }

    let keeping = skipping_turns(skeleton.skipping_float, skeleton.run).len();
    let throwing = isolated_turns(skeleton.isolated_float).len();
    if keeping <= throwing {
        return Err(format!(
            "the skipping shape accepts {keeping} protorun draws against the isolated \
             tile's {throwing}: the book's count does not decide this hand"
        ));
    }

    Ok(())
}

/// The draws that turn a lone floating tile into a protorun.
///
/// Riichi Book 1, ch. 3 (ch3:713): an isolated tile accepts the two ranks on
/// either side of it - side waits one rank away, closed waits two ranks away.
/// The edge shapes 12 and 89 are edge waits, which the book still counts as
/// protoruns (`tbl:skipping` lists `1345` accepting `2`).
pub(crate) fn isolated_turns(tile: Tile) -> Vec<Tile> {
    let Tile::Suited { suit, value } = tile else {
        return Vec::new();
    };

    let mut turns = Vec::new();
    for delta in [-2i16, -1, 1, 2] {
        let target = value as i16 + delta;
        if !(1..=9).contains(&target) {
            continue;
        }
        turns.push(Tile::Suited {
            suit,
            value: target as u8,
        });
    }
    turns
}

/// The draws that turn the skipping group into a complete run *and* a protorun.
///
/// This is the count `tbl:skipping` reports: `3567` accepts five kinds of draws
/// (1, 2, 4, 5, 8) for a protorun next to the run, plus the pair on `3`; the
/// terminal shapes - `1345`, `2456`, `4568`, `5679` - accept three or four,
/// which still beats an isolated terminal, and `5789`/`1235` accept four, the
/// same number an isolated middle 5 accepts.
pub(crate) fn skipping_turns(float: Tile, run: [Tile; 3]) -> Vec<Tile> {
    let Tile::Suited { suit, .. } = float else {
        return Vec::new();
    };

    let mut group: Vec<Tile> = run.to_vec();
    group.push(float);

    let mut turns = Vec::new();
    for value in 1..=9u8 {
        let candidate = Tile::Suited { suit, value };
        if group.iter().filter(|held| **held == candidate).count() >= 4 {
            continue;
        }
        let mut drawn = group.clone();
        drawn.push(candidate);
        if run_plus_protorun(&drawn, suit) {
            turns.push(candidate);
        }
    }
    turns
}

/// True when `tiles` hold a complete run and a protorun disjoint from it.
fn run_plus_protorun(tiles: &[Tile], suit: Suit) -> bool {
    for low in 1..=7u8 {
        let run = [
            suited(suit, low),
            suited(suit, low + 1),
            suited(suit, low + 2),
        ];
        let mut rest = tiles.to_vec();
        let mut complete = true;
        for tile in run {
            match rest.iter().position(|held| *held == tile) {
                Some(index) => {
                    rest.remove(index);
                }
                None => {
                    complete = false;
                    break;
                }
            }
        }
        if !complete {
            continue;
        }

        for (index, first) in rest.iter().enumerate() {
            for second in &rest[index + 1..] {
                if first.suit() == Some(suit)
                    && second.suit() == Some(suit)
                    && (1..=2).contains(&value_of(*first).abs_diff(value_of(*second)))
                {
                    return true;
                }
            }
        }
    }
    false
}

fn suited(suit: Suit, value: u8) -> Tile {
    Tile::Suited { suit, value }
}

/// The rank of a suited tile; honours have no rank.
fn value_of(tile: Tile) -> u8 {
    match tile {
        Tile::Suited { value, .. } => value,
        Tile::Honor(_) => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn parse(code: &str) -> Tile {
        Tile::try_from(code).expect("test tile must parse")
    }

    #[test]
    fn the_book_counts_five_draws_for_the_strong_shapes() {
        // 3p skipping to 567p: the book's own example (ch3:788).
        let turns = skipping_turns(parse("3p"), [parse("5p"), parse("6p"), parse("7p")]);
        let codes: Vec<String> = turns.iter().map(|tile| tile.to_string()).collect();
        assert_eq!(codes, vec!["1p", "2p", "4p", "5p", "8p"]);

        // The weak shape 2456 accepts only four: 1, 3, 4, 7.
        let turns = skipping_turns(parse("2p"), [parse("4p"), parse("5p"), parse("6p")]);
        let codes: Vec<String> = turns.iter().map(|tile| tile.to_string()).collect();
        assert_eq!(codes, vec!["1p", "3p", "4p", "7p"]);
    }

    #[test]
    fn an_isolated_middle_tile_accepts_four_draws() {
        let codes: Vec<String> = isolated_turns(parse("3m"))
            .iter()
            .map(|tile| tile.to_string())
            .collect();
        assert_eq!(codes, vec!["1m", "2m", "4m", "5m"]);
    }

    #[test]
    fn the_book_ranks_every_skipping_shape_above_a_isolated_tile_of_the_same_rank() {
        // Table `tbl:skipping` (ch3:716), recomputed rather than copied: the
        // middle shapes (3567, 4678, 2346, 3457) accept five protorun draws,
        // the terminal ones (1345, 5679) three, and none of the ten is ever
        // worse than an isolated tile of the same rank.
        for suit in [Suit::Man, Suit::Pin, Suit::Sou] {
            for float_value in 1..=9u8 {
                let float = suited(suit, float_value);
                let mut checked = 0;
                for run_low in 1..=7u8 {
                    let run = [
                        suited(suit, run_low),
                        suited(suit, run_low + 1),
                        suited(suit, run_low + 2),
                    ];
                    let two_below = float_value + 2 == run_low;
                    let two_above = run_low + 2 + 2 == float_value;
                    if !two_below && !two_above {
                        continue;
                    }
                    checked += 1;

                    let keeping = skipping_turns(float, run).len();
                    let throwing = isolated_turns(float).len();
                    assert!(
                        keeping >= throwing,
                        "{float} + {run:?} must never be worse than an isolated tile"
                    );

                    // The middle shapes are the book's strongest
                    // ("6 kinds--22 tiles").
                    if (3..=4).contains(&float_value) || (6..=7).contains(&float_value) {
                        assert_eq!(keeping, 5, "{float} + {run:?} should accept five draws");
                        assert!(keeping > throwing);
                    }
                }
                assert!(checked > 0, "{float} must sit in some skipping shape");
            }
        }
    }

    #[test]
    fn skeleton_generalizes_across_suits_and_shapes() {
        let mut floats = HashSet::new();
        let mut runs = HashSet::new();

        for _ in 0..100 {
            let skeleton = build_skeleton().expect("skipping-shape skeleton must build");
            verify_lesson(&skeleton).expect("every skeleton must prove the lesson");

            assert_eq!(skeleton.full_tiles.len(), 14);
            assert_eq!(skeleton.concealed_tiles.len(), 13);
            assert_eq!(skeleton.protoruns.len(), 3);
            assert!(skeleton.full_tiles.contains(&skeleton.draw));
            assert!(skeleton.concealed_tiles.contains(&skeleton.skipping_float));
            assert!(!skeleton.concealed_tiles.contains(&skeleton.isolated_float));

            // The skipping float and the isolated float share a rank, and they
            // live in different suits.
            assert_eq!(
                value_of(skeleton.skipping_float),
                value_of(skeleton.isolated_float)
            );
            assert_ne!(
                skeleton.skipping_float.suit(),
                skeleton.isolated_float.suit()
            );
            floats.insert(skeleton.skipping_float.to_string());
            runs.insert(skeleton.run[0].to_string());
        }

        assert!(floats.len() > 2, "the drill must cover several floats");
        assert!(runs.len() > 2, "the drill must cover several runs");
    }

    #[test]
    fn both_discards_leave_the_same_acceptance() {
        for _ in 0..50 {
            let skeleton = build_skeleton().expect("skipping-shape skeleton must build");
            let keep_skipping =
                evaluate_discard(&skeleton.full_tiles, skeleton.isolated_float).expect("in hand");
            let keep_isolated =
                evaluate_discard(&skeleton.full_tiles, skeleton.skipping_float).expect("in hand");

            assert_eq!(keep_skipping.shanten, 2);
            assert_eq!(keep_isolated.shanten, 2);
            assert_eq!(
                keep_skipping.total, keep_isolated.total,
                "the hand's own acceptance must not decide the discard"
            );
        }
    }
}
