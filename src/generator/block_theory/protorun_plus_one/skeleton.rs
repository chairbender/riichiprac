use agari::parse::{to_counts, validate_hand};
use agari::shanten::{calculate_shanten, calculate_ukeire};
use agari::tile::{Honor, Suit, Tile};

use crate::generator::support::deck::Deck;
use crate::rng::{choose, gen_bool, gen_range, shuffle};

/// One three-tile protorun plus one shape.
///
/// Riichi Book 1, ch. 3, "Protorun plus one shape" classifies the shapes by the
/// protorun they cover (the table at ch3:533):
///
/// - side wait + one, `334`: the protorun is `34`, the extra `3` is the cover;
/// - closed wait + one, `224`: the protorun is `24`, the extra `2` is the cover;
/// - edge wait + one, `889`: excluded here because its protorun is an edge wait.
///
/// A protorun plus one "can accept two additional tiles that an isolated
/// protorun cannot" (ch3:545): the extra copy can also become a triplet with
/// the two live copies of the pair tile.
///
/// Anki 1463192845266 — definition of the shape.
/// Anki 1463192901441 — the two extra tiles a protorun plus one accepts.
#[derive(Debug, Clone, Copy)]
pub(super) struct PlusOneShape {
    /// The tile held twice: one copy is a protorun tile, the other is the cover.
    pub pair: Tile,
    /// The protorun's other tile: one rank above `pair` (side wait) or two
    /// ranks above it (closed wait).
    pub partner: Tile,
    /// True for the side-wait shape (`334`), false for the closed-wait one
    /// (`224`). The edge-wait shape is never generated.
    pub side_wait: bool,
}

impl PlusOneShape {
    /// The cover tile. Discarding it breaks the shape down to its protorun.
    pub fn cover(self) -> Tile {
        self.pair
    }

    /// The protorun's own winning tiles: two kinds for a side wait, one kind
    /// for a closed wait.
    pub fn completions(self) -> Vec<Tile> {
        let Tile::Suited { suit, value } = self.partner else {
            return Vec::new();
        };
        if self.side_wait {
            // pair..pair+1 waits on pair-1 and pair+2.
            vec![suited(suit, value - 2), suited(suit, value + 1)]
        } else {
            // pair..pair+2 waits on pair+1.
            vec![suited(suit, value - 1)]
        }
    }

    /// The three tiles the shape occupies in the hand.
    pub fn tiles(self) -> [Tile; 3] {
        [self.pair, self.pair, self.partner]
    }
}

/// The constructed parts of a "which protorun plus one do I break?" puzzle.
///
/// Riichi Book 1, ch. 3, "Protorun plus one shape":
///
/// - "A protorun plus one can accept two additional tiles that an isolated
///   protorun cannot." (ch3:545)
/// - "When choosing between which protoruns plus one to break, priority should
///   be given to the weaker one." (ch3:574)
///
/// The book's worked example is `4m4m6m` (closed wait `4m6m` plus the cover
/// `4m`) next to `3p3p4p` (side wait `3p4p` plus the cover `3p`). It keeps the
/// closed wait covered and discards the side wait's cover:
///
/// > "the side-wait protorun 3p4p is so strong that we do not need to provide a
/// > cover by maintaining the plus-one tile, 3p ... the closed-wait protorun
/// > 4m6m is weaker so we should cover it by keeping another 4m as a back-up.
/// > You should thus discard 3p." (ch3:574)
///
/// Anki 1463192939504 — which protorun plus one to break, and why.
///
/// ## Why this drill is not decided by raw acceptance
///
/// A cover adds exactly two tiles (one kind) to *either* protorun: the two live
/// copies of the pair tile. So keeping the weak shape whole and the strong one
/// bare accepts `(weak + 2) + strong`, and the mirror accepts
/// `(strong + 2) + weak`: the same total and the same number of kinds. The
/// generator therefore proves the tie ([`verify_lesson`]) and grades the
/// book's cover rule, exactly as the book frames the question ("We have to
/// break one of the two ... Which one should we choose?").
///
/// ## Structure
///
/// The skeleton keeps the block-theory scaffold: an open Yakuhai dragon Pon,
/// one concealed run, the head, and the two protorun-plus-one shapes in the
/// other two suits. The draw is one of the two covers, so drawing it creates
/// the second plus-one shape and asks the question.
pub(super) struct ProtorunPlusOneSkeleton {
    /// All 14 tiles for evaluation, including the open Yakuhai meld.
    pub full_tiles: Vec<Tile>,
    /// The 11 concealed tiles including the draw.
    pub concealed_tiles: Vec<Tile>,
    /// The cover just drawn; it stays in the hand when the answer is not it.
    pub draw: Tile,
    /// The side-wait plus one (`334`): the book breaks this shape's cover.
    pub strong: PlusOneShape,
    /// The closed-wait plus one (`224`): the book keeps its cover as a back-up.
    pub weak: PlusOneShape,
    /// The head, an honor held twice.
    pub head: Tile,
    /// The concealed run.
    pub run: [Tile; 3],
    /// The three tiles of the open Yakuhai meld.
    pub open_meld_tiles: Vec<Tile>,
    /// The cover of the side-wait shape: the answer.
    pub answer_tile: Tile,
    /// The cover of the closed-wait shape: the tied but wrong discard.
    pub rival_tile: Tile,
}

/// Builds the two-plus-one hand and proves the book's cover rule on it.
pub(super) fn build_skeleton() -> Result<ProtorunPlusOneSkeleton, String> {
    'attempt: for _ in 0..512 {
        let mut deck = Deck::fresh();

        // One shape per suit plus the run in the third suit: the blocks then
        // never share a tile or a completion, so the acceptance comparison is
        // exactly the book's block comparison.
        let mut suits = [Suit::Man, Suit::Pin, Suit::Sou];
        shuffle(&mut suits);
        let weak_suit = suits[0];
        let strong_suit = suits[1];
        let run_suit = suits[2];

        // The closed wait plus one: w w (w+2), with w in 1..=7. The completions
        // and the pair are all distinct tiles, so no shape doubles up.
        let weak_base = gen_range(1, 8) as u8;
        let weak = PlusOneShape {
            pair: suited(weak_suit, weak_base),
            partner: suited(weak_suit, weak_base + 2),
            side_wait: false,
        };

        // The side wait plus one: s s (s+1), with s in 2..=7 so both side
        // completions sit on the board and the shape is never an edge wait.
        let strong_base = gen_range(2, 8) as u8;
        let strong = PlusOneShape {
            pair: suited(strong_suit, strong_base),
            partner: suited(strong_suit, strong_base + 1),
            side_wait: true,
        };

        for tile in weak.tiles().into_iter().chain(strong.tiles()) {
            if deck.take(tile).is_err() {
                continue 'attempt;
            }
        }

        // A complete run in the third suit, so the rest of the hand is
        // "more or less self-sufficient" (ch3:572) and the choice is purely
        // between the two complex shapes.
        let run_start = gen_range(1, 8) as u8;
        let run = [
            suited(run_suit, run_start),
            suited(run_suit, run_start + 1),
            suited(run_suit, run_start + 2),
        ];
        for tile in run {
            if deck.take(tile).is_err() {
                continue 'attempt;
            }
        }

        // Open Yakuhai triplet: any dragon guarantees a yaku, and the open meld
        // makes Riichi illegal so the lesson is the discard alone (dama).
        let dragons = [
            Tile::Honor(Honor::White),
            Tile::Honor(Honor::Green),
            Tile::Honor(Honor::Red),
        ];
        let Some(dragon) = choose(&dragons) else {
            continue 'attempt;
        };
        let open_meld_tiles = vec![dragon, dragon, dragon];
        if deck.take_n(dragon, 3).is_err() {
            continue 'attempt;
        }

        // The head is a valueless wind so its third copy can never add a
        // yakuhai to the winning hand. The human is East, and the round wind is
        // never West or North.
        let head_candidates: Vec<Tile> = [Honor::West, Honor::North]
            .into_iter()
            .map(Tile::Honor)
            .filter(|tile| deck.count(*tile) >= 2)
            .collect();
        let Some(head) = choose(&head_candidates) else {
            continue 'attempt;
        };
        if deck.take_n(head, 2).is_err() {
            continue 'attempt;
        }

        let mut concealed_tiles = Vec::with_capacity(11);
        concealed_tiles.extend(weak.tiles());
        concealed_tiles.extend(strong.tiles());
        concealed_tiles.extend(run);
        concealed_tiles.extend([head, head]);

        let mut full_tiles = concealed_tiles.clone();
        full_tiles.extend(open_meld_tiles.iter().copied());
        if validate_hand(&full_tiles).is_err() {
            continue 'attempt;
        }

        // The draw is one of the two covers: it creates the second protorun
        // plus one and asks which shape to break. Drawing the weak cover puts
        // the answer in the hand; drawing the strong cover makes the answer the
        // drawn tile, so the drill is never just "always discard the draw".
        let draw = if gen_bool(0.5) {
            weak.cover()
        } else {
            strong.cover()
        };

        let skeleton = ProtorunPlusOneSkeleton {
            full_tiles,
            concealed_tiles,
            draw,
            strong,
            weak,
            head,
            run,
            open_meld_tiles,
            answer_tile: strong.cover(),
            rival_tile: weak.cover(),
        };

        // Verify inside the loop so a hand the rule does not decide cleanly is
        // re-rolled like any other rejected candidate.
        if verify_lesson(&skeleton).is_err() {
            continue 'attempt;
        }

        return Ok(skeleton);
    }

    Err("Failed to construct a valid protorun plus one hand".to_string())
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

/// Proves the book's cover rule on one hand.
///
/// (a) the hand is 1-away;
/// (b) both breaks keep it 1-away and accept the *same* tiles, so raw
///     acceptance cannot decide the drill (a cover adds exactly two tiles to
///     either shape, so the two lines differ only in which protorun keeps it);
/// (c) the book's discard keeps the closed wait's cover and leaves the side
///     wait bare; the rival does the mirror image;
/// (d) the answer accepts exactly the side wait, the covered closed wait and
///     the head, and the rival accepts exactly the side wait's covered set --
///     the difference is one cover kind each;
/// (e) every other discard either raises shanten or accepts strictly fewer
///     tiles, so the question really is "which of the two covers".
///
/// The rule that breaks the tie is ch3:574: cover the weaker protorun, because
/// the side-wait protorun is strong enough without a cover.
pub(super) fn verify_lesson(skeleton: &ProtorunPlusOneSkeleton) -> Result<(), String> {
    if calculate_shanten(&to_counts(&skeleton.full_tiles)).shanten != 1 {
        return Err("the protorun plus one hand must be 1-away".to_string());
    }

    if skeleton.answer_tile != skeleton.strong.cover() {
        return Err("the answer must be the side-wait shape's cover".to_string());
    }
    if skeleton.rival_tile != skeleton.weak.cover() {
        return Err("the rival must be the closed-wait shape's cover".to_string());
    }
    if skeleton.draw != skeleton.answer_tile && skeleton.draw != skeleton.rival_tile {
        return Err("the draw must be one of the two covers".to_string());
    }

    let answer = evaluate_discard(&skeleton.full_tiles, skeleton.answer_tile)?;
    let rival = evaluate_discard(&skeleton.full_tiles, skeleton.rival_tile)?;

    if answer.shanten != 1 || rival.shanten != 1 {
        return Err("breaking either cover must leave the hand 1-away".to_string());
    }

    // The premise of the book's question: the two breaks are equally good on
    // raw acceptance, so only the cover rule can choose between them.
    if answer.total != rival.total {
        return Err(format!(
            "the two cover breaks must tie: {} vs {}",
            answer.total, rival.total
        ));
    }
    if answer.tiles.len() != rival.tiles.len() {
        return Err(format!(
            "the two cover breaks must accept the same kinds: {} vs {}",
            answer.tiles.len(),
            rival.tiles.len()
        ));
    }

    // The answer keeps the closed wait covered and leaves the side wait bare.
    let mut expected_answer = skeleton.strong.completions();
    expected_answer.extend(skeleton.weak.completions());
    expected_answer.push(skeleton.weak.cover());
    expected_answer.push(skeleton.head);

    // The rival is the mirror: it keeps the side wait covered and leaves the
    // closed wait bare, which is the block the book refuses to weaken.
    let mut expected_rival = skeleton.strong.completions();
    expected_rival.push(skeleton.strong.cover());
    expected_rival.extend(skeleton.weak.completions());
    expected_rival.push(skeleton.head);

    if sorted(&answer.tiles) != sorted(&expected_answer) {
        return Err(format!(
            "discarding {} must accept exactly {:?}, not {:?}",
            skeleton.answer_tile,
            sorted(&expected_answer),
            sorted(&answer.tiles)
        ));
    }
    if sorted(&rival.tiles) != sorted(&expected_rival) {
        return Err(format!(
            "discarding {} must accept exactly {:?}, not {:?}",
            skeleton.rival_tile,
            sorted(&expected_rival),
            sorted(&rival.tiles)
        ));
    }

    // No third discard may tie or beat the answer while keeping 1-away.
    let mut seen: Vec<Tile> = Vec::new();
    for tile in &skeleton.concealed_tiles {
        if *tile == skeleton.answer_tile || *tile == skeleton.rival_tile {
            continue;
        }
        if seen.contains(tile) {
            continue;
        }
        seen.push(*tile);

        let discarded = evaluate_discard(&skeleton.full_tiles, *tile)?;
        if discarded.shanten == 0 {
            return Err(format!("discarding {tile} makes the hand ready"));
        }
        if discarded.shanten == answer.shanten && discarded.total >= answer.total {
            return Err(format!(
                "discarding {tile} keeps {} tiles against the cover break's {}",
                discarded.total, answer.total
            ));
        }
    }

    Ok(())
}

fn sorted(tiles: &[Tile]) -> Vec<Tile> {
    let mut sorted = tiles.to_vec();
    sorted.sort();
    sorted.dedup();
    sorted
}

fn suited(suit: Suit, value: u8) -> Tile {
    Tile::Suited { suit, value }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn skeleton_generalizes_across_suits_and_shapes() {
        let mut weak_bases = HashSet::new();
        let mut strong_bases = HashSet::new();
        let mut suits = HashSet::new();
        let mut draws_were_the_answer = HashSet::new();

        for _ in 0..100 {
            let skeleton = build_skeleton().expect("protorun plus one skeleton must build");

            assert_eq!(skeleton.full_tiles.len(), 14);
            assert_eq!(skeleton.concealed_tiles.len(), 11);
            assert_eq!(skeleton.open_meld_tiles.len(), 3);
            assert!(validate_hand(&skeleton.full_tiles).is_ok());

            // The weak shape is a closed wait plus one: w w (w+2).
            let (
                Tile::Suited { suit, value },
                Tile::Suited {
                    suit: s2,
                    value: v2,
                },
            ) = (skeleton.weak.pair, skeleton.weak.partner)
            else {
                panic!("the closed wait must be suited");
            };
            assert!(!skeleton.weak.side_wait);
            assert_eq!(suit, s2);
            assert_eq!(v2, value + 2);
            assert!((1..=7).contains(&value));
            assert_eq!(skeleton.weak.completions(), vec![suited(suit, value + 1)]);
            weak_bases.insert(value);

            // The strong shape is a side wait plus one: s s (s+1).
            let (
                Tile::Suited {
                    suit: strong_suit,
                    value: strong_value,
                },
                Tile::Suited {
                    suit: strong_suit2,
                    value: strong_v2,
                },
            ) = (skeleton.strong.pair, skeleton.strong.partner)
            else {
                panic!("the side wait must be suited");
            };
            assert!(skeleton.strong.side_wait);
            assert_eq!(strong_suit, strong_suit2);
            assert_ne!(strong_suit, suit);
            assert_eq!(strong_v2, strong_value + 1);
            assert!((2..=7).contains(&strong_value));
            assert_eq!(
                skeleton.strong.completions(),
                vec![
                    suited(strong_suit, strong_value - 1),
                    suited(strong_suit, strong_value + 2)
                ]
            );
            strong_bases.insert(strong_value);
            suits.insert(suit);
            suits.insert(strong_suit);

            // The answer and the rival are the two covers, never equal.
            assert_eq!(skeleton.answer_tile, skeleton.strong.pair);
            assert_eq!(skeleton.rival_tile, skeleton.weak.pair);
            assert_ne!(skeleton.answer_tile, skeleton.rival_tile);
            draws_were_the_answer.insert(skeleton.draw == skeleton.answer_tile);
        }

        assert!(weak_bases.len() > 2, "must cover several closed waits");
        assert!(strong_bases.len() > 2, "must cover several side waits");
        assert_eq!(suits.len(), 3, "the shapes and the run use three suits");
        assert!(
            draws_were_the_answer.contains(&true) && draws_were_the_answer.contains(&false),
            "the draw must sometimes be the answer and sometimes the rival"
        );
    }

    #[test]
    fn every_skeleton_proves_the_cover_rule() {
        for _ in 0..80 {
            let skeleton = build_skeleton().expect("protorun plus one skeleton must build");
            verify_lesson(&skeleton).expect("every skeleton must prove the cover rule");
        }
    }

    #[test]
    fn both_cover_breaks_accept_the_same_sixteen_tiles() {
        for _ in 0..50 {
            let skeleton = build_skeleton().expect("protorun plus one skeleton must build");
            let answer = evaluate_discard(&skeleton.full_tiles, skeleton.answer_tile)
                .expect("the answer is in the hand");
            let rival = evaluate_discard(&skeleton.full_tiles, skeleton.rival_tile)
                .expect("the rival is in the hand");

            assert_eq!(answer.shanten, 1);
            assert_eq!(rival.shanten, 1);
            assert_eq!(
                answer.total, 16,
                "the side wait 8 + covered closed wait 6 + head 2"
            );
            assert_eq!(
                rival.total, 16,
                "the covered side wait 10 + bare closed wait 4 + head 2"
            );
            assert_eq!(answer.tiles.len(), 5);
            assert_eq!(rival.tiles.len(), 5);

            // The two sets differ only by which cover kind stays live.
            let answer_only: Vec<Tile> = answer
                .tiles
                .iter()
                .copied()
                .filter(|tile| !rival.tiles.contains(tile))
                .collect();
            let rival_only: Vec<Tile> = rival
                .tiles
                .iter()
                .copied()
                .filter(|tile| !answer.tiles.contains(tile))
                .collect();
            assert_eq!(answer_only, vec![skeleton.weak.cover()]);
            assert_eq!(rival_only, vec![skeleton.strong.cover()]);
        }
    }

    #[test]
    fn no_other_discard_keeps_the_covers_acceptance() {
        for _ in 0..50 {
            let skeleton = build_skeleton().expect("protorun plus one skeleton must build");
            let answer = evaluate_discard(&skeleton.full_tiles, skeleton.answer_tile)
                .expect("answer in hand");

            let mut seen = HashSet::new();
            for tile in &skeleton.concealed_tiles {
                if *tile == skeleton.answer_tile || *tile == skeleton.rival_tile {
                    continue;
                }
                if !seen.insert(*tile) {
                    continue;
                }
                let rival = evaluate_discard(&skeleton.full_tiles, *tile).expect("tile in hand");
                assert_ne!(rival.shanten, 0, "no discard may leave the hand ready");
                if rival.shanten == 1 {
                    assert!(
                        rival.total < answer.total,
                        "discarding {tile} kept {} against {}",
                        rival.total,
                        answer.total
                    );
                }
            }
        }
    }
}
