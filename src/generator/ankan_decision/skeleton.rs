//! Hand skeletons for the concealed-quad (ankan) decision.
//!
//! Riichi Book 1, ch. 9, "Concealed quad (ankan)" gives two lists:
//!
//! - the conditions that justify the quad: "1-away, where at least one block
//!   has a good wait" and "2-away, where all the blocks have a good wait",
//!   plus table-position escapes this lesson does not model; and
//! - the cases where the quad is wrong even when the hand is (close to)
//!   ready: above all "one of the four tiles can be used a good floating
//!   tile".
//!
//! Each shape below builds the ten concealed tiles that sit next to the quad.
//! The drawn fourth copy is added by the board, so the tables themselves are
//! pure block constructions with the wait quality the lesson claims: the
//! skeleton records its blocks and [`verify`] re-checks the shanten and the
//! acceptance the book's argument rests on.

use agari::parse::{to_counts, validate_hand};
use agari::shanten::{
    calculate_shanten, calculate_shanten_with_melds, calculate_ukeire, calculate_ukeire_with_melds,
};
use agari::tile::{Honor, Suit, Tile};

use crate::generator::support::deck::Deck;
use crate::rng::{choose, gen_range, shuffle};

/// The lesson one skeleton serves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum AnkanShape {
    /// 1-away with at least one side-wait block: the book says call the quad.
    OneAwayGoodWait,
    /// 2-away with every block on a side wait: the book says call the quad.
    TwoAwayAllGoodWaits,
    /// Close to ready, but one copy is a good floating tile: the book says
    /// keep the hand closed and discard the useless tile.
    FloatingTileDecline,
}

impl AnkanShape {
    /// Shanten the book's condition names for this shape, read after the quad.
    pub(super) fn expected_shanten(self) -> i8 {
        match self {
            Self::OneAwayGoodWait => 1,
            Self::TwoAwayAllGoodWaits => 2,
            // Both lines of the decline hand are 1-away: the book's point is
            // that the quad does not make a close-to-ready hand better.
            Self::FloatingTileDecline => 1,
        }
    }
}

/// One block of the constructed hand, recorded so tests can assert the shape
/// the lesson promises rather than only its aggregate shanten.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum AnkanBlock {
    /// The four copies that make the quad.
    Quad,
    /// A complete run.
    Set,
    /// A pair.
    Pair,
    /// A two-sided protorun: the book's "good wait" block.
    SideWait,
    /// A closed (kanchan) or edge protorun: a bad wait.
    ClosedWait,
    /// A lone tile with no protorun, such as a single honor.
    Floater,
}

/// A constructed concealed-quad hand.
pub(super) struct AnkanSkeleton {
    /// The tile held four times.
    pub quad_tile: Tile,
    /// The ten concealed tiles next to the quad. For
    /// [`AnkanShape::FloatingTileDecline`] this includes the tile the book
    /// discards.
    pub concealed_tiles: Vec<Tile>,
    /// The blocks that make up [`Self::concealed_tiles`], in no fixed order.
    pub blocks: Vec<AnkanBlock>,
    /// For the decline shape, the tile the book throws instead of the quad.
    pub decline_discard: Option<Tile>,
}

impl AnkanSkeleton {
    /// The fourteen displayed tiles: the concealed hand plus all four copies.
    pub(super) fn full_tiles(&self) -> Vec<Tile> {
        let mut tiles = self.concealed_tiles.clone();
        tiles.extend([self.quad_tile; 4]);
        tiles
    }

    /// The ten tiles left once the quad is declared.
    pub(super) fn post_kan_tiles(&self) -> Vec<Tile> {
        self.concealed_tiles.clone()
    }
}

const WINDS: [Honor; 4] = [Honor::East, Honor::South, Honor::West, Honor::North];
const DRAGONS: [Honor; 3] = [Honor::White, Honor::Green, Honor::Red];

/// Builds a skeleton for the requested lesson.
pub(super) fn build(shape: AnkanShape) -> Result<AnkanSkeleton, String> {
    match shape {
        AnkanShape::OneAwayGoodWait => build_one_away(),
        AnkanShape::TwoAwayAllGoodWaits => build_two_away(),
        AnkanShape::FloatingTileDecline => build_floating_decline(),
    }
}

/// One complete set, an honor pair, one side wait, one closed wait and a dead
/// honor floater: 1-away with exactly one good-wait block.
///
/// This is the book's example (1): "This hand is 1-away, and one block has a
/// good wait and another has a bad wait. You can call kan."
fn build_one_away() -> Result<AnkanSkeleton, String> {
    for _ in 0..256 {
        let mut deck = Deck::fresh();

        // Honors make the quad: the fourth copy is dead, so the quad costs no
        // acceptance. This is also the shape the book's own examples use.
        let quad = Tile::honor(choose(&DRAGONS).ok_or("no dragon")?);
        deck.take_n(quad, 4)?;

        let pair_honor = choose(&WINDS).ok_or("no wind for the pair")?;
        let pair_tile = Tile::honor(pair_honor);
        deck.take_n(pair_tile, 2)?;

        let floater_honor = choose(
            &WINDS
                .iter()
                .copied()
                .filter(|honor| *honor != pair_honor)
                .collect::<Vec<_>>(),
        )
        .ok_or("no wind for the floater")?;
        let floater = Tile::honor(floater_honor);
        deck.take(floater)?;

        let mut suits = [Suit::Man, Suit::Pin, Suit::Sou];
        shuffle(&mut suits);

        let set_start = gen_range(1, 8) as u8;
        let set = run(suits[0], set_start);
        let side_start = gen_range(2, 8) as u8;
        let side = run(suits[1], side_start)[..2].to_vec();
        let closed_start = gen_range(1, 8) as u8;
        let closed = vec![
            Tile::suited(suits[2], closed_start),
            Tile::suited(suits[2], closed_start + 2),
        ];

        for tile in set.iter().chain(side.iter()).chain(closed.iter()) {
            deck.take(*tile)?;
        }

        let mut concealed = Vec::with_capacity(10);
        concealed.extend(set);
        concealed.extend([pair_tile, pair_tile]);
        concealed.extend(side);
        concealed.extend(closed);
        concealed.push(floater);

        let skeleton = AnkanSkeleton {
            quad_tile: quad,
            concealed_tiles: concealed,
            blocks: vec![
                AnkanBlock::Quad,
                AnkanBlock::Set,
                AnkanBlock::Pair,
                AnkanBlock::SideWait,
                AnkanBlock::ClosedWait,
                AnkanBlock::Floater,
            ],
            decline_discard: None,
        };

        if verify(&skeleton, AnkanShape::OneAwayGoodWait).is_ok() {
            return Ok(skeleton);
        }
    }

    Err("failed to build a 1-away concealed-quad hand".to_string())
}

/// Three side waits, an honor pair and two dead honor floaters: the book's
/// "perfect 2-away hand", where every block has a good wait.
///
/// This is example (3): "This is a perfect 2-away hand, so you can call kan."
fn build_two_away() -> Result<AnkanSkeleton, String> {
    for _ in 0..256 {
        let mut deck = Deck::fresh();

        let quad = Tile::honor(choose(&DRAGONS).ok_or("no dragon")?);
        deck.take_n(quad, 4)?;

        let mut winds = WINDS.to_vec();
        shuffle(&mut winds);
        let pair_tile = Tile::honor(winds[0]);
        deck.take_n(pair_tile, 2)?;
        let floaters = [Tile::honor(winds[1]), Tile::honor(winds[2])];
        for floater in floaters {
            deck.take(floater)?;
        }

        let mut suits = [Suit::Man, Suit::Pin, Suit::Sou];
        shuffle(&mut suits);

        let mut side_waits = Vec::with_capacity(3);
        for suit in suits {
            let start = gen_range(2, 8) as u8;
            let side = run(suit, start)[..2].to_vec();
            for tile in &side {
                deck.take(*tile)?;
            }
            side_waits.push(side);
        }

        let mut concealed = Vec::with_capacity(10);
        concealed.extend([pair_tile, pair_tile]);
        for side in side_waits {
            concealed.extend(side);
        }
        concealed.extend(floaters);

        let skeleton = AnkanSkeleton {
            quad_tile: quad,
            concealed_tiles: concealed,
            blocks: vec![
                AnkanBlock::Quad,
                AnkanBlock::Pair,
                AnkanBlock::SideWait,
                AnkanBlock::SideWait,
                AnkanBlock::SideWait,
                AnkanBlock::Floater,
                AnkanBlock::Floater,
            ],
            decline_discard: None,
        };

        if verify(&skeleton, AnkanShape::TwoAwayAllGoodWaits).is_ok() {
            return Ok(skeleton);
        }
    }

    Err("failed to build a 2-away concealed-quad hand".to_string())
}

/// The book's "one of the four tiles can be used a good floating tile" hand:
/// the quad is a middle tile (4 or 6), the pair sits four ranks away, and a
/// bulging float plus a run leave one lone tile to throw.
///
/// This follows the book's own box: `4444m 88m 4567p 456s 8s`, where "you can
/// treat one of the four tiles of 4m as a floating tile that could form a
/// side-wait protorun" and the answer is to discard the 8s.
fn build_floating_decline() -> Result<AnkanSkeleton, String> {
    for _ in 0..256 {
        let mut deck = Deck::fresh();

        let mut suits = [Suit::Man, Suit::Pin, Suit::Sou];
        shuffle(&mut suits);

        // 4 or 6: either way the floating copy forms three side waits (34/45/46
        // for 4, 46/56/67 for 6), which is the book's argument.
        let quad_rank = if crate::rng::gen_bool(0.5) { 4 } else { 6 };
        let quad = Tile::suited(suits[0], quad_rank);
        deck.take_n(quad, 4)?;

        let pair_rank = if quad_rank == 4 { 8 } else { 2 };
        let pair_tile = Tile::suited(suits[0], pair_rank);
        deck.take_n(pair_tile, 2)?;

        // The book's bulging float (nakabukure): a run plus one floating tile.
        let bulging = run(suits[1], 4);
        let bulging_extra = Tile::suited(suits[1], 7);
        let bulging = [bulging, vec![bulging_extra]].concat();
        for tile in &bulging {
            deck.take(*tile)?;
        }

        // A complete run and the lone tile two ranks above it that the book
        // throws (the 8s next to the 456s).
        let run_tiles = run(suits[2], 4);
        let discard = Tile::suited(suits[2], 8);
        for tile in run_tiles.iter().chain([&discard]) {
            deck.take(*tile)?;
        }

        let mut concealed = Vec::with_capacity(10);
        concealed.extend([pair_tile, pair_tile]);
        concealed.extend(bulging);
        concealed.extend(run_tiles);
        concealed.push(discard);

        let skeleton = AnkanSkeleton {
            quad_tile: quad,
            concealed_tiles: concealed,
            blocks: vec![
                AnkanBlock::Quad,
                AnkanBlock::Pair,
                AnkanBlock::Set,
                AnkanBlock::Floater,
                AnkanBlock::Set,
                AnkanBlock::Floater,
            ],
            decline_discard: Some(discard),
        };

        if verify(&skeleton, AnkanShape::FloatingTileDecline).is_ok() {
            return Ok(skeleton);
        }
    }

    Err("failed to build a floating-tile concealed-quad hand".to_string())
}

/// Three consecutive tiles starting at `start`.
fn run(suit: Suit, start: u8) -> Vec<Tile> {
    vec![
        Tile::suited(suit, start),
        Tile::suited(suit, start + 1),
        Tile::suited(suit, start + 2),
    ]
}

/// The ranked tiles the floating fourth copy can accept in a side-wait or
/// closed-wait protorun.
///
/// Riichi Book 1, ch. 9: with four 4m, "if you draw 3m/5m ... the hand will be
/// ready", and calling kan "will lose the ability to accept 2m 3m 5m 6m".
pub(super) use crate::generator::support::analysis::floating_quad_acceptance as floating_acceptance;

/// Re-checks the shanten and acceptance the book's argument rests on.
fn verify(skeleton: &AnkanSkeleton, shape: AnkanShape) -> Result<(), String> {
    let full = skeleton.full_tiles();
    if full.len() != 14 || validate_hand(&full).is_err() {
        return Err("concealed-quad hand is not fourteen legal tiles".to_string());
    }
    if skeleton.concealed_tiles.len() != 10 {
        return Err("concealed hand must hold ten tiles next to the quad".to_string());
    }

    let expected = shape.expected_shanten();
    let post_counts = to_counts(&skeleton.post_kan_tiles());
    let post_kan = calculate_shanten_with_melds(&post_counts, 1).shanten;
    if post_kan != expected {
        return Err(format!(
            "{} hand must be {expected}-away after the quad, got {post_kan}",
            shape_name(shape)
        ));
    }
    if calculate_ukeire(&post_counts).tiles.is_empty() {
        return Err("concealed-quad hand accepts nothing".to_string());
    }

    // The table displays the four copies, so its own shanten has to match the
    // condition the lesson names.
    let displayed = calculate_shanten(&to_counts(&full)).shanten;
    if displayed != expected {
        return Err(format!(
            "{} hand must read {expected}-away on the table, got {displayed}",
            shape_name(shape)
        ));
    }

    match shape {
        AnkanShape::OneAwayGoodWait | AnkanShape::TwoAwayAllGoodWaits => {
            let side_waits = skeleton
                .blocks
                .iter()
                .filter(|block| **block == AnkanBlock::SideWait)
                .count();
            if shape == AnkanShape::OneAwayGoodWait && side_waits == 0 {
                return Err("the 1-away lesson needs one side-wait block".to_string());
            }
            if shape == AnkanShape::TwoAwayAllGoodWaits && side_waits != 3 {
                return Err("the 2-away lesson needs every block on a side wait".to_string());
            }
        }
        AnkanShape::FloatingTileDecline => {
            verify_floating_decline(skeleton)?;
        }
    }

    Ok(())
}

/// The decline hand must accept the float's protoruns, and the quad line must
/// not: that is exactly the book's argument for keeping the four copies.
fn verify_floating_decline(skeleton: &AnkanSkeleton) -> Result<(), String> {
    let discard = skeleton
        .decline_discard
        .ok_or("the decline hand must name its discard")?;

    let mut kept = skeleton.concealed_tiles.clone();
    let index = kept
        .iter()
        .position(|tile| *tile == discard)
        .ok_or("the decline discard is not in the concealed hand")?;
    kept.remove(index);

    // The closed line: all four copies stay in hand, so hand + quad.
    let mut float_line = kept.clone();
    float_line.extend([skeleton.quad_tile; 4]);
    if float_line.len() != 13 {
        return Err("keeping the quad must leave a thirteen-tile hand".to_string());
    }
    let float_counts = to_counts(&float_line);
    if calculate_shanten(&float_counts).shanten != 1 {
        return Err("keeping the quad must leave a 1-away hand".to_string());
    }
    let float_acceptance = calculate_ukeire(&float_counts);
    let float_tiles: Vec<Tile> = float_acceptance.tiles.iter().map(|u| u.tile).collect();

    // The quad line: four tiles leave the hand, one meld replaces them.
    let kan_counts = to_counts(&kept);
    let kan_acceptance = calculate_ukeire_with_melds(&kan_counts, 1);
    let kan_tiles: Vec<Tile> = kan_acceptance.tiles.iter().map(|u| u.tile).collect();

    for target in floating_acceptance(skeleton.quad_tile) {
        if !float_tiles.contains(&target) {
            return Err(format!(
                "keeping the quad must accept {target} from the floating copy"
            ));
        }
        if kan_tiles.contains(&target) {
            return Err(format!(
                "the quad line must not accept {target} from the floating copy"
            ));
        }
    }

    Ok(())
}

fn shape_name(shape: AnkanShape) -> &'static str {
    match shape {
        AnkanShape::OneAwayGoodWait => "1-away side-wait",
        AnkanShape::TwoAwayAllGoodWaits => "2-away all-side-wait",
        AnkanShape::FloatingTileDecline => "floating-tile",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_away_hands_carry_one_side_wait_block() {
        for _ in 0..50 {
            let skeleton = build(AnkanShape::OneAwayGoodWait).expect("skeleton must build");
            assert!(matches!(skeleton.quad_tile, Tile::Honor(_)));
            assert_eq!(skeleton.concealed_tiles.len(), 10);
            assert_eq!(skeleton.post_kan_tiles().len(), 10);
            assert_eq!(skeleton.full_tiles().len(), 14);
            assert_eq!(
                calculate_shanten_with_melds(&to_counts(&skeleton.post_kan_tiles()), 1).shanten,
                1
            );

            let side_waits = skeleton
                .blocks
                .iter()
                .filter(|block| **block == AnkanBlock::SideWait)
                .count();
            assert_eq!(side_waits, 1);
            assert!(skeleton.blocks.contains(&AnkanBlock::ClosedWait));
            assert!(skeleton.decline_discard.is_none());
        }
    }

    #[test]
    fn two_away_hands_have_only_side_wait_blocks() {
        for _ in 0..50 {
            let skeleton = build(AnkanShape::TwoAwayAllGoodWaits).expect("skeleton must build");
            assert_eq!(skeleton.concealed_tiles.len(), 10);
            assert_eq!(
                calculate_shanten_with_melds(&to_counts(&skeleton.post_kan_tiles()), 1).shanten,
                2
            );

            let side_waits = skeleton
                .blocks
                .iter()
                .filter(|block| **block == AnkanBlock::SideWait)
                .count();
            assert_eq!(side_waits, 3);
            assert!(!skeleton.blocks.contains(&AnkanBlock::ClosedWait));
            // Every non-honor tile is inside a side wait; no kanchan or
            // penchan shape survives in the block list.
            assert_eq!(
                skeleton
                    .blocks
                    .iter()
                    .filter(|block| **block == AnkanBlock::Set)
                    .count(),
                0
            );
        }
    }

    #[test]
    fn floating_decline_hands_keep_the_fourth_copy_useful() {
        for _ in 0..50 {
            let skeleton = build(AnkanShape::FloatingTileDecline).expect("skeleton must build");
            let Tile::Suited { value, .. } = skeleton.quad_tile else {
                panic!("the decline quad must be a suited middle tile");
            };
            assert!(value == 4 || value == 6);

            let discard = skeleton.decline_discard.expect("decline discard");
            let targets = floating_acceptance(skeleton.quad_tile);
            assert_eq!(targets.len(), 4, "four ranks accept the floating copy");
            assert!(
                !targets.contains(&discard),
                "the discard is not a float target"
            );
        }
    }

    #[test]
    fn floating_acceptance_matches_the_book_lists() {
        let four = Tile::suited(Suit::Man, 4);
        assert_eq!(
            floating_acceptance(four),
            vec![
                Tile::suited(Suit::Man, 2),
                Tile::suited(Suit::Man, 3),
                Tile::suited(Suit::Man, 5),
                Tile::suited(Suit::Man, 6),
            ],
            "ch. 9: calling kan on 4m loses the ability to accept 2m 3m 5m 6m"
        );

        let six = Tile::suited(Suit::Pin, 6);
        assert_eq!(
            floating_acceptance(six),
            vec![
                Tile::suited(Suit::Pin, 4),
                Tile::suited(Suit::Pin, 5),
                Tile::suited(Suit::Pin, 7),
                Tile::suited(Suit::Pin, 8),
            ]
        );

        // Honors cannot form protoruns, so the quad costs nothing there.
        assert!(floating_acceptance(Tile::honor(Honor::White)).is_empty());
    }
}
