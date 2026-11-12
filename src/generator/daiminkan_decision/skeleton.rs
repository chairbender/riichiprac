//! Hand skeletons for the open-quad (daiminkan) lesson.
//!
//! Riichi Book 1, ch. 9, "Open quad (daiminkan)" gives the three situations in
//! which an open quad is acceptable:
//!
//! > the hand is ready with a good wait, and the hand value is between 2000 and
//! > 5200 points; — ch9:323
//! > you need more dora or minipoints to improve the placement (especially in
//! > South-4); — ch9:324
//! > you are losing badly. — ch9:325
//!
//! and three worked boxes that draw the line:
//!
//! - a 2000-point ready hand with a **good** wait calls the quad (ch9:336);
//! - the same 2000-point hand with a **bad** wait does not (ch9:348);
//! - a 1000-point ready hand with a good wait does not (ch9:358).
//!
//! Every skeleton below is the book's box: one called run (its 123p chi), one
//! concealed run, an honor pair, a two-tile protorun that is the wait, and a
//! dragon triplet that the opponent's discard can turn into the quad. Three
//! suits hold the three suited blocks, so the wait shape is the protorun's and
//! nothing else, and the dragon is the hand's only yaku. The drawn dora is what
//! separates the 2000-point hand from the 1000-point one.

use agari::parse::{to_counts, validate_hand};
use agari::shanten::{calculate_shanten, calculate_ukeire};
use agari::tile::{Honor, Suit, Tile};

use crate::generator::support::deck::Deck;
use crate::rng::{choose, gen_bool, gen_range, shuffle};

/// Which of the book's hand values a board is built for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum DaiminkanShape {
    /// Ready with a good wait and a dora: the book's 2000-point "call it" box.
    GoodWaitValue,
    /// Ready with a bad wait, same 2000 points: the book's "not when the wait
    /// is bad" box.
    BadWaitValue,
    /// Ready with a good wait but no dora: the book's 1000-point box.
    CheapGoodWait,
}

impl DaiminkanShape {
    /// Whether the hand must hold exactly one dora.
    pub(super) fn wants_dora(self) -> bool {
        !matches!(self, Self::CheapGoodWait)
    }

    /// Whether the wait block is a side wait.
    pub(super) fn wants_good_wait(self) -> bool {
        !matches!(self, Self::BadWaitValue)
    }
}

/// A constructed open-quad hand.
pub(super) struct DaiminkanSkeleton {
    /// The dragon held three times; the fourth copy is offered as the quad.
    pub quad_tile: Tile,
    /// The called run (the human's chi meld), lowest tile first.
    pub open_run: Vec<Tile>,
    /// The ten concealed tiles: a run, a pair, the wait block and three copies
    /// of [`Self::quad_tile`].
    pub concealed_tiles: Vec<Tile>,
    /// Every winning tile of the ready hand.
    pub wait_tiles: Vec<Tile>,
    /// Whether the wait block is a side wait.
    pub good_wait: bool,
}

impl DaiminkanSkeleton {
    /// The human's thirteen visible tiles: ten concealed plus the called run.
    pub(super) fn hand_tiles(&self) -> Vec<Tile> {
        let mut tiles = self.concealed_tiles.clone();
        tiles.extend(self.open_run.iter().copied());
        tiles
    }

    /// The fourteen tiles that include the offered fourth copy.
    pub(super) fn full_tiles(&self) -> Vec<Tile> {
        let mut tiles = self.hand_tiles();
        tiles.push(self.quad_tile);
        tiles
    }

    /// Lowest tile of the called run, which is how the meld is recorded.
    pub(super) fn open_run_start(&self) -> Tile {
        self.open_run[0]
    }
}

const DRAGONS: [Honor; 3] = [Honor::White, Honor::Green, Honor::Red];
const WINDS: [Honor; 4] = [Honor::East, Honor::South, Honor::West, Honor::North];

/// Builds a skeleton for the requested shape.
pub(super) fn build(shape: DaiminkanShape) -> Result<DaiminkanSkeleton, String> {
    for _ in 0..256 {
        let mut deck = Deck::fresh();

        // The quad is an honor: its fourth copy completes a dead triplet, so
        // the call costs the hand no acceptance, and the triplet is the yaku
        // that keeps the open hand legal.
        let quad_tile = Tile::honor(
            choose(&DRAGONS).ok_or_else(|| "No dragon available for the quad".to_string())?,
        );
        deck.take_n(quad_tile, 4)?;

        let mut suits = [Suit::Man, Suit::Pin, Suit::Sou];
        shuffle(&mut suits);
        let (open_suit, run_suit, wait_suit) = (suits[0], suits[1], suits[2]);

        // One block per suit: the called run, a complete concealed run, and the
        // wait block. Nothing shares a suit, so no accidental shape can widen
        // the wait or add a yaku.
        let open_run = run(open_suit, gen_range(1, 8) as u8);
        for tile in &open_run {
            deck.take(*tile)?;
        }

        let concealed_run = run(run_suit, gen_range(1, 8) as u8);
        for tile in &concealed_run {
            deck.take(*tile)?;
        }

        let (wait_block, wait_tiles) = build_wait_block(wait_suit, shape)?;
        for tile in &wait_block {
            deck.take(*tile)?;
        }
        // Both winning tiles have to still be drawable.
        if wait_tiles.iter().any(|tile| !deck.has(*tile)) {
            continue;
        }

        // An honor pair: it scores no yaku, so the hand's value stays the
        // dragon's. A value-wind pair only adds 2 fu, which rounds inside the
        // same 30-fu band.
        let pair_tile = Tile::honor(
            choose(&WINDS).ok_or_else(|| "No wind available for the pair".to_string())?,
        );
        deck.take_n(pair_tile, 2)?;

        let mut concealed_tiles = Vec::with_capacity(10);
        concealed_tiles.extend(concealed_run);
        concealed_tiles.extend([quad_tile; 3]);
        concealed_tiles.extend([pair_tile, pair_tile]);
        concealed_tiles.extend(wait_block);

        if concealed_tiles.len() != 10 {
            continue;
        }
        if verify(
            &DaiminkanSkeleton {
                quad_tile,
                open_run: open_run.clone(),
                concealed_tiles: concealed_tiles.clone(),
                wait_tiles: wait_tiles.clone(),
                good_wait: shape.wants_good_wait(),
            },
            shape,
        )
        .is_err()
        {
            continue;
        }

        concealed_tiles.sort();
        let mut wait_tiles = wait_tiles;
        wait_tiles.sort();

        return Ok(DaiminkanSkeleton {
            quad_tile,
            open_run,
            concealed_tiles,
            wait_tiles,
            good_wait: shape.wants_good_wait(),
        });
    }

    Err(format!(
        "Failed to construct an open-quad skeleton of shape {shape:?}"
    ))
}

/// The protorun that is the hand's wait, plus the tiles it wins on.
///
/// The good shape is a side wait (`45` waiting on 3/6). The bad shape is the
/// book's own edge wait (`89` waiting on 7) or a closed wait (`46` waiting on
/// 5), both of which the book refuses the quad on.
fn build_wait_block(suit: Suit, shape: DaiminkanShape) -> Result<(Vec<Tile>, Vec<Tile>), String> {
    if shape.wants_good_wait() {
        // Both ends of a side wait must stay on the table: 2..=7.
        let start = gen_range(2, 8) as u8;
        return Ok((
            vec![Tile::suited(suit, start), Tile::suited(suit, start + 1)],
            vec![Tile::suited(suit, start - 1), Tile::suited(suit, start + 2)],
        ));
    }

    if gen_bool(0.5) {
        // Edge wait: 12 waits on 3, 89 waits on 7.
        let (low, high, wait) = if gen_bool(0.5) { (1, 2, 3) } else { (8, 9, 7) };
        Ok((
            vec![Tile::suited(suit, low), Tile::suited(suit, high)],
            vec![Tile::suited(suit, wait)],
        ))
    } else {
        // Closed (kanchan) wait: one rank apart, winning on the tile between.
        let start = gen_range(1, 8) as u8;
        Ok((
            vec![Tile::suited(suit, start), Tile::suited(suit, start + 2)],
            vec![Tile::suited(suit, start + 1)],
        ))
    }
}

/// Three consecutive tiles starting at `start`.
fn run(suit: Suit, start: u8) -> Vec<Tile> {
    vec![
        Tile::suited(suit, start),
        Tile::suited(suit, start + 1),
        Tile::suited(suit, start + 2),
    ]
}

/// Re-checks the shape the book's argument rests on.
fn verify(skeleton: &DaiminkanSkeleton, shape: DaiminkanShape) -> Result<(), String> {
    let full = skeleton.full_tiles();
    if full.len() != 14 || validate_hand(&full).is_err() {
        return Err("open-quad hand is not fourteen legal tiles".to_string());
    }
    if skeleton.concealed_tiles.len() != 10 {
        return Err("concealed hand must hold ten tiles next to the quad".to_string());
    }
    if skeleton.open_run.len() != 3 {
        return Err("the called run must have three tiles".to_string());
    }
    if skeleton
        .concealed_tiles
        .iter()
        .filter(|tile| **tile == skeleton.quad_tile)
        .count()
        != 3
    {
        return Err("the hand must hold exactly three copies of the quad tile".to_string());
    }

    let hand = skeleton.hand_tiles();
    let counts = to_counts(&hand);
    if calculate_shanten(&counts).shanten != 0 {
        return Err("the open-quad hand must be ready".to_string());
    }

    // The wait has to be exactly the protorun's: a wider wait would mean an
    // accidental shape, and the book's band is about this hand's value.
    let ukeire = calculate_ukeire(&counts);
    let mut found: Vec<Tile> = ukeire.tiles.iter().map(|tile| tile.tile).collect();
    found.sort();
    let mut expected = skeleton.wait_tiles.clone();
    expected.sort();
    if found != expected {
        return Err(format!(
            "the hand must wait only on {expected:?}, got {found:?}"
        ));
    }
    if skeleton.good_wait != shape.wants_good_wait() {
        return Err("the wait block does not match the lesson's wait shape".to_string());
    }
    if found.len() != if skeleton.good_wait { 2 } else { 1 } {
        return Err("the wait block's winning tiles contradict its wait shape".to_string());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn good_wait_hands_wait_on_two_side_wait_tiles() {
        for _ in 0..50 {
            let skeleton = build(DaiminkanShape::GoodWaitValue).expect("skeleton must build");
            assert!(skeleton.good_wait);
            assert_eq!(skeleton.concealed_tiles.len(), 10);
            assert_eq!(skeleton.hand_tiles().len(), 13);
            assert_eq!(skeleton.full_tiles().len(), 14);
            assert_eq!(skeleton.wait_tiles.len(), 2);
            assert!(matches!(skeleton.quad_tile, Tile::Honor(_)));

            let counts = to_counts(&skeleton.hand_tiles());
            assert_eq!(calculate_shanten(&counts).shanten, 0);
            let ukeire: Vec<Tile> = calculate_ukeire(&counts)
                .tiles
                .iter()
                .map(|tile| tile.tile)
                .collect();
            assert_eq!(ukeire.len(), 2);
            assert!(skeleton.wait_tiles.iter().all(|tile| ukeire.contains(tile)));
        }
    }

    #[test]
    fn bad_wait_hands_wait_on_one_tile() {
        for _ in 0..50 {
            let skeleton = build(DaiminkanShape::BadWaitValue).expect("skeleton must build");
            assert!(!skeleton.good_wait);
            assert_eq!(skeleton.wait_tiles.len(), 1);
            let counts = to_counts(&skeleton.hand_tiles());
            assert_eq!(calculate_shanten(&counts).shanten, 0);
        }
    }

    #[test]
    fn cheap_hands_are_the_same_shape_without_the_dora() {
        let good = build(DaiminkanShape::CheapGoodWait).expect("skeleton must build");
        assert!(good.good_wait);
        assert!(!DaiminkanShape::CheapGoodWait.wants_dora());
        assert!(DaiminkanShape::GoodWaitValue.wants_dora());
    }

    #[test]
    fn every_block_uses_its_own_suit() {
        for _ in 0..50 {
            let skeleton = build(DaiminkanShape::GoodWaitValue).expect("skeleton must build");
            let mut suits: Vec<Suit> = Vec::new();
            for tile in skeleton
                .open_run
                .iter()
                .chain(skeleton.concealed_tiles.iter())
            {
                if let Some(suit) = tile.suit()
                    && !suits.contains(&suit)
                {
                    suits.push(suit);
                }
            }
            assert_eq!(suits.len(), 3, "three suited blocks, one per suit");
        }
    }
}
