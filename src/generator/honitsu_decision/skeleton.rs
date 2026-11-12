//! Constructive skeletons for the ch. 5 honitsu lesson.
//!
//! Riichi Book 1, ch. 5, "Conditions to go for honitsu", names the two factors
//! the decision turns on (ch5:468):
//!
//! > five-block potential and hand values with and without honitsu
//!
//! All three branches build the *same* block picture: four blocks in the target
//! suit plus honors and at least one floating tile, so the honitsu material
//! always has the book's five blocks or block candidates. Only the value
//! changes, which is exactly the lesson: five-block potential is necessary but
//! not sufficient (ch5:506, "Although this hand has five tile blocks necessary
//! for honitsu, you should not go for honitsu").
//!
//! - [`Variant::Commit`]: the honitsu group holds two fanpai pairs, so the
//!   honitsu hand can add two yakuhai — a real hand, unlike the same tiles
//!   played straight, which have no yaku. Answer: start discarding the
//!   off-suit tiles ("you can go for honitsu with this hand", ch5:492).
//! - [`Variant::AlreadyHigh`]: the hand already scores at least 5200 without
//!   honitsu (a dragon triplet, the seat-wind triplet and a red five, the
//!   book's own Honitsu 3 arithmetic). Answer: keep the side-wait protorun and
//!   throw the in-suit floating tile, because "when the hand value is
//!   sufficiently high (>= 5200) without honitsu, you should not go for
//!   honitsu at the cost of tile efficiency" (ch5:517).
//! - [`Variant::HonitsuOnly`]: the honitsu group has no fanpai at all, so the
//!   plan would end as a "honitsu-only hand, which is very cheap (2000 or 2600
//!   points)". Answer: throw the valueless honor floater and keep the
//!   off-suit blocks; "you should try to make the hand ready without melding
//!   and go for riichi" (ch5:506).
//!
//! Every branch is verified by score enumeration, not by the constructor: the
//! honitsu group is completed into the best fourteen-tile winning hand it can
//! reach and scored ([`honitsu_reading`]), while the same tiles played straight
//! are scored at their worst completion ([`worst_completion_value`]). The block
//! count is checked over the suit and honor tiles alone.
//!
//! The cheap branch's "2000 or 2600 points" is the book's open, two-han value;
//! this crate scores a closed honitsu at three han, so that branch is graded on
//! its yaku list (honitsu and nothing else) rather than on the closed score.

use std::collections::BTreeMap;

use agari::parse::to_counts;
use agari::shanten::{calculate_shanten, calculate_ukeire};
use agari::tile::{Honor, Suit, Tile};
use agari::yaku::Yaku;

use crate::generator::support::analysis::wind_to_honor;
use crate::generator::support::completion::completion_lines;
use crate::generator::support::value::{Value, worst_completion_value};
use crate::rng::{choose, gen_range, shuffle};
use crate::state::Wind;

use super::value::{Blocks, DRAGONS, HONORS, Reading, SUITS, blocks_and_floaters, honitsu_reading};

/// How many tile fills to try before giving up on one branch.
const MAX_ATTEMPTS: usize = 4_000;

/// The book's "sufficiently high" floor without honitsu (ch5:517).
const HIGH_VALUE_FLOOR: u32 = 5_200;

/// Which of the section's answers the next hand teaches.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Variant {
    /// Go for honitsu: five blocks and a honitsu worth more than the straight
    /// hand.
    Commit,
    /// Do not go: the hand is already worth at least 5200 without honitsu.
    AlreadyHigh,
    /// Do not go: the honitsu would be honitsu-only and cheap.
    HonitsuOnly,
}

impl Variant {
    /// Draws the next request's branch. All three are equally likely.
    pub(crate) fn sample() -> Self {
        match gen_range(0, 3) {
            0 => Self::Commit,
            1 => Self::AlreadyHigh,
            _ => Self::HonitsuOnly,
        }
    }

    /// The parameter list shown in the agreement report.
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Commit => "commit: five blocks and a honitsu with two yakuhai",
            Self::AlreadyHigh => "efficiency: already worth at least 5200 without honitsu",
            Self::HonitsuOnly => "efficiency: honitsu would be honitsu-only (2000/2600)",
        }
    }

    /// Short stable name for tests and diagnostics.
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Commit => "commit",
            Self::AlreadyHigh => "already_high",
            Self::HonitsuOnly => "honitsu_only",
        }
    }
}

/// A constructed, validated honitsu hand before the table is dealt.
#[derive(Debug, Clone)]
pub(super) struct Skeleton {
    /// The branch this hand teaches.
    pub variant: Variant,
    /// The suit the honitsu plan collects.
    pub suit: Suit,
    /// The fourteen visible tiles, sorted.
    pub tiles: Vec<Tile>,
    /// The discard the lesson grades correct.
    pub answer: Tile,
    /// Other discards that grade as the same answer. The commit branch accepts
    /// any redundant off-suit tile, because the book names the whole group as
    /// redundant and discarding them all is a multi-turn plan.
    pub equivalents: Vec<Tile>,
    /// The suit-plus-honor block reading: always four blocks and a floater.
    pub blocks: Blocks,
    /// The worst value the same tiles win for without honitsu (`None` = some
    /// completion has no yaku at all).
    pub value_without: Option<Value>,
    /// The score of the hand the honitsu plan completes to. `None` when the
    /// group cannot be completed into one hand (the already-valuable branch,
    /// whose plan is not the point of the lesson).
    pub honitsu: Option<Reading>,
}

/// Builds one hand for `variant` under an already-drawn round and seat wind.
pub(super) fn build(
    variant: Variant,
    round_wind: Wind,
    seat_wind: Wind,
) -> Result<Skeleton, String> {
    let mut last = String::new();
    for _ in 0..MAX_ATTEMPTS {
        let attempt = match variant {
            Variant::Commit => commit(round_wind, seat_wind),
            Variant::AlreadyHigh => already_high(round_wind, seat_wind),
            Variant::HonitsuOnly => honitsu_only(round_wind, seat_wind),
        };
        match attempt {
            Ok(skeleton) => return Ok(skeleton),
            Err(err) => last = err,
        }
    }
    Err(format!(
        "could not build a {} honitsu hand: {last}",
        variant.as_str()
    ))
}

/// The book's Honitsu 1 hand: two runs, two fanpai pairs and a floating tile.
fn commit(round_wind: Wind, seat_wind: Wind) -> Result<Skeleton, String> {
    let suit = choose(&SUITS).ok_or_else(|| "no suit".to_string())?;
    let (run_a, run_b) = two_separated_runs(suit)?;

    let mut dragons = DRAGONS.to_vec();
    shuffle(&mut dragons);
    let first_dragon = Tile::Honor(dragons[0]);
    let second_dragon = Tile::Honor(dragons[1]);

    let mut hand = Vec::with_capacity(14);
    hand.extend(run_a);
    hand.extend(run_b);
    hand.extend([first_dragon; 2]);
    hand.extend([second_dragon; 2]);

    // The floating tile that becomes the fifth block.
    let floater = free_tile(suit, &hand, 2).ok_or_else(|| "no room for a floater".to_string())?;
    hand.push(floater);

    // The redundant off-suit group: an isolated tile and a closed-wait
    // protorun, the two shapes the book names as "made redundant" (ch5:495).
    let (kanchan, isolated) = off_suit_junk(suit, &hand)?;
    hand.extend(kanchan);
    hand.push(isolated);

    check_shape(&hand, suit)?;

    let honitsu = honitsu_tiles(&hand, suit);
    let blocks = blocks_and_floaters(&honitsu);
    if !blocks.has_five_block_potential() {
        return Err(format!(
            "the honitsu group has {} blocks and {} floaters",
            blocks.blocks,
            blocks.floaters.len()
        ));
    }
    let reading = honitsu_reading(&honitsu, suit, round_wind, seat_wind, &[], 0)
        .ok_or_else(|| "the honitsu group does not complete")?;
    if !reading.yaku.contains(&Yaku::Honitsu) {
        return Err("the projection is not a honitsu hand".to_string());
    }
    if reading.is_honitsu_only() {
        return Err("the commit hand's honitsu plan is honitsu-only, not valuable".to_string());
    }
    if reading.value.points < HIGH_VALUE_FLOOR {
        return Err(format!(
            "the honitsu hand is only {} points",
            reading.value.points
        ));
    }

    // Without honitsu the same tiles have no yaku: the fanpai pairs are not a
    // yaku until they become triplets.
    let answer = isolated;
    let post = without(&hand, answer)?;
    let value_without = worst_completion_value(&post, round_wind, seat_wind, &[], 0);
    if value_without.is_some_and(|value| value.points >= HIGH_VALUE_FLOOR) {
        return Err("the straight hand is already worth 5200".to_string());
    }

    Ok(Skeleton {
        variant: Variant::Commit,
        suit,
        tiles: sorted(hand),
        answer,
        equivalents: sorted(kanchan.to_vec()),
        blocks,
        value_without,
        honitsu: Some(reading),
    })
}

/// The book's Honitsu 3 hand: 5200 without honitsu, so efficiency wins.
///
/// The kept hand is the book's own shape: two honor triplets, a pair, a
/// side-wait protorun holding the red five, an off-suit side-wait protorun and
/// a floating dragon. The answer throws the in-suit floating tile, which keeps
/// the "side & side 1-away" status (ch5:520).
fn already_high(round_wind: Wind, seat_wind: Wind) -> Result<Skeleton, String> {
    let suit = choose(&SUITS).ok_or_else(|| "no suit".to_string())?;

    // The protorun holding the red five: 45 or 56, so the red five sits in a
    // shape every completion has to use.
    let start = choose(&[4u8, 5]).ok_or_else(|| "no red-five protorun".to_string())?;
    let red_five = Tile::suited(suit, 5);
    let mut hand: Vec<Tile> = vec![Tile::suited(suit, start), Tile::suited(suit, start + 1)];

    let pair = free_value(suit, &hand, 3).ok_or_else(|| "no room for the pair".to_string())?;
    hand.extend([Tile::suited(suit, pair); 2]);

    let floater =
        free_value(suit, &hand, 2).ok_or_else(|| "no room for the floater".to_string())?;
    hand.push(Tile::suited(suit, floater));

    // The two fanpai that make the hand worth 5200 on their own: a dragon and
    // the seat wind (the human is never the dealer in this lesson).
    let dragon = Tile::Honor(choose(&DRAGONS).ok_or_else(|| "no dragon".to_string())?);
    hand.extend([dragon; 3]);
    hand.extend([wind_honor(seat_wind); 3]);

    // A floating dragon the hand keeps: yaku potential the answer does not
    // throw away.
    let triplet_honor = match dragon {
        Tile::Honor(honor) => honor,
        Tile::Suited { .. } => return Err("a dragon must be an honor".to_string()),
    };
    let other_dragon = Tile::Honor(
        choose(
            &DRAGONS
                .iter()
                .copied()
                .filter(|candidate| *candidate != triplet_honor)
                .collect::<Vec<_>>(),
        )
        .ok_or_else(|| "no second dragon".to_string())?,
    );
    hand.push(other_dragon);

    // The off-suit block the player keeps: a side-wait protorun.
    let off_suit = choose(
        &SUITS
            .iter()
            .copied()
            .filter(|candidate| *candidate != suit)
            .collect::<Vec<_>>(),
    )
    .ok_or_else(|| "no off-suit suit".to_string())?;
    let protorun_start = gen_range(2, 8) as u8;
    hand.extend([
        Tile::suited(off_suit, protorun_start),
        Tile::suited(off_suit, protorun_start + 1),
    ]);

    check_shape(&hand, suit)?;
    if !hand.contains(&red_five) {
        return Err("the hand lost its red five".to_string());
    }

    let honitsu = honitsu_tiles(&hand, suit);
    let blocks = blocks_and_floaters(&honitsu);
    if !blocks.has_five_block_potential() {
        return Err(format!(
            "the honitsu group has {} blocks and {} floaters",
            blocks.blocks,
            blocks.floaters.len()
        ));
    }

    // The book's own test for this cell: the hand is already sufficiently
    // valuable without honitsu, at every way it can become ready.
    let answer = Tile::suited(suit, floater);
    let post = without(&hand, answer)?;
    // The red-five han the scorer adds is only real if every completion keeps
    // the tile, so no completion may discard it.
    if completion_lines(&post)
        .iter()
        .any(|line| line.discard == red_five)
    {
        return Err("a completion discards the red five".to_string());
    }
    let value_without =
        worst_completion_value(&post, round_wind, seat_wind, &[], 1).ok_or_else(|| {
            "a completion of the straight hand has no yaku (not the 5200 case)".to_string()
        })?;
    if value_without.points < HIGH_VALUE_FLOOR {
        return Err(format!(
            "the straight hand's worst completion is only {} points",
            value_without.points
        ));
    }

    Ok(Skeleton {
        variant: Variant::AlreadyHigh,
        suit,
        tiles: sorted(hand),
        answer,
        equivalents: Vec::new(),
        blocks,
        value_without: Some(value_without),
        honitsu: None,
    })
}

/// The book's Honitsu 2 hand: five blocks, but a honitsu-only (cheap) plan.
///
/// The suit-plus-honor group is two runs, two closed protoruns and one
/// valueless honor. Completing it gives four runs and an honor pair, so the
/// plan's only yaku is honitsu — the "very cheap" hand of ch5:506. The answer
/// throws the honor: it was the fifth block candidate, so giving it up leaves
/// the off-suit side-wait protorun (and the other off-suit tile) for a closed
/// riichi hand instead.
fn honitsu_only(round_wind: Wind, seat_wind: Wind) -> Result<Skeleton, String> {
    let suit = choose(&SUITS).ok_or_else(|| "no suit".to_string())?;
    let template =
        choose(&HONITSU_ONLY_TEMPLATES).ok_or_else(|| "no honitsu-only template".to_string())?;

    let mut hand: Vec<Tile> = template_runs(suit, template)
        .into_iter()
        .flatten()
        .collect();

    // A valueless honor: the fifth block candidate, and the answer.
    let round_honor = wind_to_honor(round_wind);
    let seat_honor = wind_to_honor(seat_wind);
    let valueless: Vec<Honor> = HONORS
        .iter()
        .copied()
        .filter(|honor| is_wind(*honor))
        .filter(|honor| *honor != round_honor && *honor != seat_honor)
        .collect();
    if valueless.is_empty() {
        return Err("not enough valueless winds".to_string());
    }
    let answer = Tile::Honor(valueless[0]);
    hand.push(answer);

    // The off-suit material the answer keeps: a side-wait protorun and an
    // isolated tile.
    let mut off_suit_suits: Vec<Suit> = SUITS
        .iter()
        .copied()
        .filter(|candidate| *candidate != suit)
        .collect();
    shuffle(&mut off_suit_suits);
    let protorun_suit = off_suit_suits[0];
    let isolated_suit = off_suit_suits[1];
    let off_start = gen_range(2, 8) as u8;
    hand.extend([
        Tile::suited(protorun_suit, off_start),
        Tile::suited(protorun_suit, off_start + 1),
    ]);
    let isolated = choose(
        &(1..=9u8)
            .map(|value| Tile::suited(isolated_suit, value))
            .filter(|tile| !hand.contains(tile))
            .collect::<Vec<_>>(),
    )
    .ok_or_else(|| "no isolated off-suit tile".to_string())?;
    hand.push(isolated);

    check_shape(&hand, suit)?;

    let honitsu = honitsu_tiles(&hand, suit);
    let blocks = blocks_and_floaters(&honitsu);
    if !blocks.has_five_block_potential() {
        return Err(format!(
            "the honitsu group has {} blocks and {} floaters",
            blocks.blocks,
            blocks.floaters.len()
        ));
    }
    let reading = honitsu_reading(&honitsu, suit, round_wind, seat_wind, &[], 0)
        .ok_or_else(|| "the honitsu group does not complete")?;
    if !reading.is_honitsu_only() {
        return Err(format!(
            "the honitsu plan also claims {:?}, so it is not honitsu-only",
            reading
                .yaku
                .iter()
                .filter(|yaku| **yaku != Yaku::Honitsu)
                .collect::<Vec<_>>()
        ));
    }
    // The plan has nothing else to add: no fanpai triplet, no dora and no red
    // five, so the only han it can claim is the honitsu itself. The book's
    // "2000 or 2600 points" is the open, two-han value of a plan that melds.

    let post = without(&hand, answer)?;
    let value_without = worst_completion_value(&post, round_wind, seat_wind, &[], 0);
    if value_without.is_some_and(|value| value.points >= HIGH_VALUE_FLOOR) {
        return Err("the straight hand is already worth 5200".to_string());
    }

    // The answer must be the efficient discard: it keeps the off-suit blocks,
    // so it is closer to ready than giving one of them up for the honitsu plan.
    let kept = closeness(&post)?;
    for tile in off_suit_block_tiles(&hand, suit) {
        let broken = without(&hand, tile)?;
        if closeness(&broken)? <= kept {
            return Err(format!(
                "discarding {tile} is as close to ready as the honor floater"
            ));
        }
    }

    Ok(Skeleton {
        variant: Variant::HonitsuOnly,
        suit,
        tiles: sorted(hand),
        answer,
        equivalents: Vec::new(),
        blocks,
        value_without,
        honitsu: Some(reading),
    })
}

/// The (two runs, two closed protoruns) shapes the cheap branch may use.
///
/// Every template avoids the accidental yaku that would stop the plan being
/// honitsu-only: a terminal run kills tanyao, a middle run kills chanta, the
/// completed runs are all distinct (no iipeikou), and no template can complete
/// into 123 + 456 + 789 (no ittsu).
const HONITSU_ONLY_TEMPLATES: [([u8; 3], [u8; 3], [u8; 2], [u8; 2]); 3] = [
    ([1, 2, 3], [5, 6, 7], [2, 4], [7, 9]),
    ([1, 2, 3], [6, 7, 8], [2, 4], [4, 6]),
    ([2, 3, 4], [6, 7, 8], [1, 3], [5, 7]),
];

/// The four template groups as tiles of `suit`.
fn template_runs(suit: Suit, template: ([u8; 3], [u8; 3], [u8; 2], [u8; 2])) -> [Vec<Tile>; 4] {
    let (run_a, run_b, first, second) = template;
    [
        run_a
            .iter()
            .map(|value| Tile::suited(suit, *value))
            .collect(),
        run_b
            .iter()
            .map(|value| Tile::suited(suit, *value))
            .collect(),
        first
            .iter()
            .map(|value| Tile::suited(suit, *value))
            .collect(),
        second
            .iter()
            .map(|value| Tile::suited(suit, *value))
            .collect(),
    ]
}

/// The tiles of `hand` that belong to the honitsu plan: the target suit and
/// every honor.
fn honitsu_tiles(hand: &[Tile], suit: Suit) -> Vec<Tile> {
    hand.iter()
        .copied()
        .filter(|tile| match tile.suit() {
            Some(tile_suit) => tile_suit == suit,
            None => true,
        })
        .collect()
}

/// True for a wind honor.
fn is_wind(honor: Honor) -> bool {
    matches!(
        honor,
        Honor::East | Honor::South | Honor::West | Honor::North
    )
}

/// The honor tile of a seat/round wind.
fn wind_honor(wind: Wind) -> Tile {
    Tile::Honor(wind_to_honor(wind))
}

/// A three-tile run starting at `start`.
fn run(suit: Suit, start: u8) -> [Tile; 3] {
    [
        Tile::suited(suit, start),
        Tile::suited(suit, start + 1),
        Tile::suited(suit, start + 2),
    ]
}

/// Two non-overlapping runs of `suit`, so the projection cannot read them as
/// one straight or an iipeikou pair.
fn two_separated_runs(suit: Suit) -> Result<([Tile; 3], [Tile; 3]), String> {
    let mut options = Vec::new();
    for first in 1..=7u8 {
        for second in 1..=7u8 {
            if first == second || first.abs_diff(second) < 3 {
                continue;
            }
            options.push((first, second));
        }
    }
    let (first, second) = choose(&options).ok_or_else(|| "no separated runs".to_string())?;
    Ok((run(suit, first), run(suit, second)))
}

/// A value in `suit` at least `gap` ranks away from every same-suit tile held.
fn free_value(suit: Suit, hand: &[Tile], gap: u8) -> Option<u8> {
    let candidates: Vec<u8> = (1..=9u8)
        .filter(|value| {
            hand.iter().all(|tile| match tile.suit() {
                Some(tile_suit) if tile_suit == suit => tile
                    .value()
                    .is_some_and(|held| held.abs_diff(*value) >= gap),
                _ => true,
            })
        })
        .collect();
    choose(&candidates)
}

/// One floating tile in `suit`, at least `gap` ranks from the rest of the suit.
fn free_tile(suit: Suit, hand: &[Tile], gap: u8) -> Option<Tile> {
    free_value(suit, hand, gap).map(|value| Tile::suited(suit, value))
}

/// The redundant off-suit group: a closed-wait protorun and an isolated tile.
fn off_suit_junk(suit: Suit, hand: &[Tile]) -> Result<([Tile; 2], Tile), String> {
    let mut other_suits: Vec<Suit> = SUITS
        .iter()
        .copied()
        .filter(|candidate| *candidate != suit)
        .collect();
    shuffle(&mut other_suits);

    // The closed-wait protorun lives in one suit, the isolated tile in the
    // other, so neither can fuse with the block the player keeps.
    let kanchan_suit = other_suits[0];
    let isolated_suit = other_suits[1];
    let start = gen_range(1, 8) as u8;
    let kanchan = [
        Tile::suited(kanchan_suit, start),
        Tile::suited(kanchan_suit, start + 2),
    ];

    let candidates: Vec<Tile> = (1..=9u8)
        .map(|value| Tile::suited(isolated_suit, value))
        .filter(|tile| !hand.contains(tile))
        .collect();
    let isolated = choose(&candidates).ok_or_else(|| "no isolated off-suit tile".to_string())?;

    Ok((kanchan, isolated))
}

/// Every off-suit tile of `hand` that is part of a block: the tiles the honitsu
/// plan would give up.
fn off_suit_block_tiles(hand: &[Tile], suit: Suit) -> Vec<Tile> {
    let mut counts: BTreeMap<Tile, u8> = BTreeMap::new();
    for &tile in hand {
        if tile.suit().is_some_and(|tile_suit| tile_suit != suit) {
            *counts.entry(tile).or_insert(0) += 1;
        }
    }

    let mut tiles: Vec<Tile> = counts
        .iter()
        .filter(|(_, count)| **count >= 2)
        .map(|(tile, _)| *tile)
        .collect();
    for tile_suit in SUITS {
        for value in 1..=8u8 {
            let low = Tile::suited(tile_suit, value);
            let high = Tile::suited(tile_suit, value + 1);
            if counts.contains_key(&low) && counts.contains_key(&high) {
                tiles.extend([low, high]);
            }
        }
    }
    tiles.sort();
    tiles.dedup();
    tiles
}

/// How close a hand is to ready: shanten first, then acceptance (negated so a
/// smaller value is better).
fn closeness(tiles: &[Tile]) -> Result<(i8, i16), String> {
    let counts = to_counts(tiles);
    let shanten = calculate_shanten(&counts).shanten;
    let acceptance = calculate_ukeire(&counts).total_count as i16;
    Ok((shanten, -acceptance))
}

/// The hand must be a real, unfinished hand with no forgotten fifth copy.
fn check_shape(hand: &[Tile], suit: Suit) -> Result<(), String> {
    if hand.len() != 14 {
        return Err(format!("the hand has {} tiles, not 14", hand.len()));
    }
    let counts = to_counts(hand);
    if let Some((tile, count)) = counts.iter().find(|(_, count)| **count > 4) {
        return Err(format!("{tile} appears {count} times"));
    }
    let shanten = calculate_shanten(&counts).shanten;
    if shanten == -1 {
        return Err("the hand is already complete".to_string());
    }
    if shanten > 2 {
        return Err(format!(
            "the hand is {shanten}-away, too slow for the lesson"
        ));
    }
    if !honitsu_tiles(hand, suit)
        .iter()
        .any(|tile| tile.suit() == Some(suit))
    {
        return Err("the hand has no tile in the honitsu suit".to_string());
    }
    Ok(())
}

/// Removes one copy of `tile` from `tiles`.
fn without(tiles: &[Tile], tile: Tile) -> Result<Vec<Tile>, String> {
    let mut rest = tiles.to_vec();
    let index = rest
        .iter()
        .position(|candidate| *candidate == tile)
        .ok_or_else(|| format!("{tile} is not in the hand"))?;
    rest.remove(index);
    Ok(rest)
}

fn sorted(mut tiles: Vec<Tile>) -> Vec<Tile> {
    tiles.sort();
    tiles
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_branch_builds_its_own_case() {
        for variant in [Variant::Commit, Variant::AlreadyHigh, Variant::HonitsuOnly] {
            for run in 0..25 {
                let skeleton = build(variant, Wind::East, Wind::South)
                    .unwrap_or_else(|err| panic!("{} run {run}: {err}", variant.as_str()));

                assert_eq!(skeleton.tiles.len(), 14);
                assert!(skeleton.blocks.has_five_block_potential(), "{variant:?}");

                match variant {
                    Variant::Commit => {
                        let reading = skeleton.honitsu.as_ref().expect("a honitsu plan");
                        assert!(!reading.is_honitsu_only());
                        assert!(reading.value.points >= HIGH_VALUE_FLOOR);
                        assert_eq!(skeleton.equivalents.len(), 2);
                        assert!(skeleton.tiles.contains(&skeleton.answer));
                    }
                    Variant::AlreadyHigh => {
                        let value = skeleton.value_without.expect("the book's 5200 case");
                        assert!(value.points >= HIGH_VALUE_FLOOR);
                        assert!(skeleton.equivalents.is_empty());
                    }
                    Variant::HonitsuOnly => {
                        let reading = skeleton.honitsu.as_ref().expect("a honitsu plan");
                        assert!(reading.is_honitsu_only());
                        assert_eq!(reading.value.han, 3);
                        assert!(matches!(skeleton.answer, Tile::Honor(_)));
                    }
                }
            }
        }
    }

    #[test]
    fn the_cheap_branch_never_claims_a_second_yaku() {
        for _ in 0..40 {
            let skeleton = build(Variant::HonitsuOnly, Wind::East, Wind::West).expect("hand");
            assert_eq!(
                skeleton
                    .honitsu
                    .as_ref()
                    .expect("a honitsu plan")
                    .yaku
                    .iter()
                    .filter(|yaku| **yaku != Yaku::Honitsu)
                    .count(),
                0,
                "{:?}",
                skeleton.honitsu.as_ref().map(|reading| &reading.yaku)
            );
        }
    }

    #[test]
    fn the_honitsu_only_answer_is_a_valueless_honor() {
        for _ in 0..40 {
            let skeleton = build(Variant::HonitsuOnly, Wind::East, Wind::South).expect("hand");
            assert!(matches!(skeleton.answer, Tile::Honor(_)));
            assert_ne!(skeleton.answer, wind_honor(Wind::East));
            assert_ne!(skeleton.answer, wind_honor(Wind::South));
        }
    }
}
