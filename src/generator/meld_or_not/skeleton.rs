//! Constructive skeleton for the "never meld a cheap and slow hand" lesson.
//!
//! Riichi Book 1, ch. 9.1, defines a slow hand as "2-away or worse after
//! melding (i.e. 3-away or worse before melding) and with a bad wait" and its
//! canonical example is a White Dragon pair Pon that leaves the hand 2-away.
//!
//! The skeleton therefore plants, before the call:
//!
//! * two copies of a dragon (the tile an opponent will discard, so a Pon is
//!   actually offered and the opened hand would still have its yakuhai),
//! * one pair,
//! * four protoruns, and
//! * one floating tile.
//!
//! The protoruns are drawn from [`SPACED_PATTERNS`], which only ever produces
//! closed waits (`13`, `24`, ... `79`) and edge waits (`12`, `89`): no two
//! suited tiles in the resulting hand are ever adjacent inside the 2..8 range,
//! so the hand cannot show a side wait (`23`...`78`). That is the mechanical
//! half of the book's "bad wait" clause, and it also rules out the "cheap but
//! fast" exception, which needs *good* waits.
//!
//! After the Pon the hand is exactly 2-away for every discard, which `board`
//! re-derives from the finished state.
//!
//! Deck cards: 1463255782615, 1463256320218, 1463256486957 (the ch. 9.1
//! "cheap and slow" cards).

use agari::tile::{Honor, Suit, Tile};

use crate::rng::{gen_range, shuffle};

/// Four-tile patterns with two protoruns each and no side-wait pair.
///
/// Every pair of values inside a pattern is either two apart (a closed wait) or
/// is the edge pair `12`/`89`, so no two tiles are adjacent between 2 and 8.
const SPACED_PATTERNS: [[u8; 4]; 15] = [
    [1, 2, 4, 6],
    [1, 2, 5, 7],
    [1, 2, 6, 8],
    [1, 2, 7, 9],
    [1, 2, 8, 9],
    [1, 3, 5, 7],
    [1, 3, 6, 8],
    [1, 3, 7, 9],
    [1, 3, 8, 9],
    [2, 4, 6, 8],
    [2, 4, 7, 9],
    [2, 4, 8, 9],
    [3, 5, 7, 9],
    [3, 5, 8, 9],
    [4, 6, 8, 9],
];

/// The tiles and seats one board is built around.
#[derive(Debug, Clone)]
pub struct Skeleton {
    /// The dragon an opponent discards. The hand holds the other two copies, so
    /// a Pon is offered and the opened hand would score its yakuhai.
    pub dragon: Tile,
    /// Seat that discards the dragon (never the human).
    pub from: usize,
    /// The human's thirteen concealed tiles (two dragons included).
    pub hand: Vec<Tile>,
    /// The pair the hand keeps as its head.
    pub pair: Tile,
    /// The floating tile that would be discarded after the Pon.
    pub floater: Tile,
    /// The four closed/edge protoruns, two tiles each.
    pub protoruns: Vec<[Tile; 2]>,
}

impl Skeleton {
    /// The eleven tiles left after the Pon consumes two dragons.
    pub fn after_pon(&self) -> Vec<Tile> {
        let mut tiles = self.hand.clone();
        for _ in 0..2 {
            let index = tiles
                .iter()
                .position(|tile| *tile == self.dragon)
                .expect("the skeleton plants two dragon copies");
            tiles.remove(index);
        }
        tiles
    }
}

/// Builds one skeleton, rejecting any hand that breaks the lesson's shape.
pub fn build() -> Result<Skeleton, String> {
    let dragon = crate::rng::choose(&[
        Tile::Honor(Honor::White),
        Tile::Honor(Honor::Green),
        Tile::Honor(Honor::Red),
    ])
    .ok_or_else(|| "no dragon is available".to_string())?;

    let mut suits = [Suit::Man, Suit::Pin, Suit::Sou];
    shuffle(&mut suits);
    let (block_suits, pair_suit) = suits.split_at(2);

    let mut patterns: Vec<[u8; 4]> = SPACED_PATTERNS.to_vec();
    shuffle(&mut patterns);
    let pattern_a = patterns[0];
    let pattern_b = patterns[1];

    let mut protoruns = Vec::with_capacity(4);
    for (suit, pattern) in [(block_suits[0], pattern_a), (block_suits[1], pattern_b)] {
        protoruns.extend(protoruns_for(suit, pattern));
    }

    // The head is a simple tile, so the hand can never be junchan/chantai: those
    // yaku require every block *and* the head to contain a terminal or honour.
    let pair_value = gen_range(2, 8) as u8;
    let pair = Tile::suited(pair_suit[0], pair_value);

    // The float sits in the head's suit but never next to it, so the pair and
    // the float cannot form a side wait either.
    let floater = loop {
        let value = gen_range(1, 10) as u8;
        let gap = value.abs_diff(pair_value);
        if gap >= 2 {
            break Tile::suited(pair_suit[0], value);
        }
    };

    let mut hand = Vec::with_capacity(13);
    hand.push(dragon);
    hand.push(dragon);
    hand.push(pair);
    hand.push(pair);
    for protorun in &protoruns {
        hand.extend(protorun);
    }
    hand.push(floater);
    hand.sort();

    if hand.len() != 13 {
        return Err(format!(
            "the skeleton has {} tiles, expected 13",
            hand.len()
        ));
    }

    let skeleton = Skeleton {
        dragon,
        from: 1 + gen_range(0, 3),
        hand,
        pair,
        floater,
        protoruns,
    };
    skeleton.validate()?;
    Ok(skeleton)
}

impl Skeleton {
    /// Re-derives the shape promises that the rest of the lesson relies on.
    fn validate(&self) -> Result<(), String> {
        if self
            .hand
            .iter()
            .filter(|tile| **tile == self.dragon)
            .count()
            != 2
        {
            return Err("the hand must hold exactly two copies of the offered dragon".to_string());
        }
        if self.hand.iter().filter(|tile| **tile == self.pair).count() != 2 {
            return Err("the hand must hold exactly one pair".to_string());
        }
        if self.pair.suit().is_none() || !matches!(self.pair.value(), Some(2..=8)) {
            return Err("the head must be a simple tile".to_string());
        }
        if self.protoruns.len() != 4 {
            return Err("the skeleton needs four protoruns".to_string());
        }
        if !self.hand.contains(&self.floater) {
            return Err("the floating tile must be in the hand".to_string());
        }
        if self.floater.suit() == self.pair.suit()
            && self
                .floater
                .value()
                .zip(self.pair.value())
                .is_some_and(|(float, pair)| float.abs_diff(pair) < 2)
        {
            return Err("the float must not sit next to the head".to_string());
        }

        let after = self.after_pon();
        if after.len() != 11 {
            return Err(format!("the post-Pon hand has {} tiles", after.len()));
        }
        if has_side_wait_pair(&after) {
            return Err("the hand shows a side-wait protorun and is not slow".to_string());
        }
        if has_triplet(&after) {
            return Err("the hand already holds a triplet".to_string());
        }
        Ok(())
    }
}

/// Splits a four-value pattern into its two protoruns.
fn protoruns_for(suit: Suit, pattern: [u8; 4]) -> Vec<[Tile; 2]> {
    // The patterns are built so the only valid two-and-two split is the first
    // pair against the second pair. `(1,2,4,6)` is `12` + `46`, `(1,3,5,7)` is
    // `13` + `57`, and so on.
    let first = [
        Tile::suited(suit, pattern[0]),
        Tile::suited(suit, pattern[1]),
    ];
    let second = [
        Tile::suited(suit, pattern[2]),
        Tile::suited(suit, pattern[3]),
    ];
    vec![first, second]
}

/// True when any two suited tiles are adjacent inside the 2..8 range, i.e. the
/// hand shows a side-wait (ryanmen) protorun.
///
/// The check is over the whole hand, not per block, so two blocks that happen
/// to line up cannot create a side wait either.
pub fn has_side_wait_pair(tiles: &[Tile]) -> bool {
    for (index, tile) in tiles.iter().enumerate() {
        let (Some(suit), Some(value)) = (tile.suit(), tile.value()) else {
            continue;
        };
        for other in tiles.iter().skip(index + 1) {
            if other.suit() != Some(suit) {
                continue;
            }
            let Some(other_value) = other.value() else {
                continue;
            };
            let low = value.min(other_value);
            if other_value.abs_diff(value) == 1 && (2..=7).contains(&low) {
                return true;
            }
        }
    }
    false
}

/// True when three copies of the same tile are in the hand.
pub fn has_triplet(tiles: &[Tile]) -> bool {
    tiles
        .iter()
        .any(|tile| tiles.iter().filter(|other| *other == tile).count() >= 3)
}

#[cfg(test)]
mod tests {
    use super::*;
    use agari::parse::to_counts;
    use agari::shanten::calculate_shanten;

    #[test]
    fn every_pattern_really_is_two_closed_or_edge_waits() {
        for pattern in SPACED_PATTERNS {
            // No pair of values may be a side-wait pair: adjacent inside 2..8.
            for (index, value) in pattern.iter().enumerate() {
                for other in pattern.iter().skip(index + 1) {
                    let low = (*value).min(*other);
                    assert!(
                        value.abs_diff(*other) != 1 || low == 1 || low >= 8,
                        "pattern {pattern:?} contains side-wait pair {value}-{other}"
                    );
                }
            }
            // And the four values must split into two protoruns (diff <= 2).
            let mut values = pattern.to_vec();
            values.sort_unstable();
            assert!(
                values[1] - values[0] <= 2 && values[3] - values[2] <= 2,
                "pattern {pattern:?} does not split into two protoruns"
            );
        }
    }

    #[test]
    fn skeletons_are_three_away_before_the_call() {
        for run in 0..200 {
            let skeleton = build().unwrap_or_else(|err| panic!("run {run}: {err}"));
            let shanten = calculate_shanten(&to_counts(&skeleton.hand)).shanten;
            assert_eq!(shanten, 3, "run {run}: pre-call hand is {shanten}-away");
            assert!(!has_side_wait_pair(&skeleton.after_pon()), "run {run}");
            assert!(!has_triplet(&skeleton.after_pon()), "run {run}");
        }
    }

    #[test]
    fn every_skeleton_offers_a_dragon_pon() {
        for run in 0..200 {
            let skeleton = build().unwrap_or_else(|err| panic!("run {run}: {err}"));
            assert!(matches!(
                skeleton.dragon,
                Tile::Honor(Honor::White | Honor::Green | Honor::Red)
            ));
            assert!((1..=3).contains(&skeleton.from));
        }
    }
}
