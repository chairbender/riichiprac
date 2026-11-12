//! Constructive skeletons for the ch. 8.1 push/fold lesson.
//!
//! Both branches build the same fourteen-tile shape: two complete sets, two
//! protoruns and two pairs. The tile just drawn completed the second pair, so
//! the shape is exactly the book's own perfect-1-away example's:
//!
//! > Notice that this is a perfect 1-away hand; no matter how this hand becomes
//! > ready, you can \emph{always} choose to have a side wait. — ch8:77
//!
//! Breaking either pair leaves the book's other perfect shape — two sets, two
//! protoruns, one pair and a float — so the shape-preserving discards are the
//! pair tiles. Every other discard either keeps only two blocks or loses the
//! wait. The two branches differ only in the wait quality and value, which are
//! exactly the two conditions the book weighs for a 1-away hand:
//!
//! > Pushing with a 1-away hand is acceptable only when \emph{both} of the
//! > other two conditions are met. — ch8:62
//!
//! - [`Target::Push`]: the protoruns are side waits, so every completion can
//!   still choose one (ch8:68), and a concealed dragon triplet that is also
//!   three dora makes the worst winning tile a mangan (ch8:65's "minimum hand
//!   value is 7700"). Both conditions hold, so the answer is a pair tile.
//! - [`Target::Fold`]: the protoruns are closed waits and the hand has no yaku,
//!   so neither condition holds. The answer is the threat's genbutsu instead,
//!   which visibly breaks a complete set.
//!
//! Every pair and the drawn tile is a 4-6 tile, so the shape-preserving discards
//! sit on the chart's most dangerous Rank D row. That is the row the book only
//! lets a 1-away hand throw when its hand is already a guaranteed mangan.

use agari::parse::to_counts;
use agari::shanten::calculate_shanten;
use agari::tile::{Honor, Suit, Tile};

use crate::generator::support::completion::completion_lines;
use crate::generator::support::value::{Value, worst_completion_value};
use crate::rng::{choose, gen_range};
use crate::state::Wind;

/// How many tile fills to try before giving up on a target.
const MAX_ATTEMPTS: usize = 2_000;

/// Which cell of the ch. 8 push/fold box the hand is built for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Target {
    /// 1-away, high score, good wait: two push conditions, so push.
    Push,
    /// 1-away, low score, bad wait: fold.
    Fold,
}

impl Target {
    /// Draws the next request's cell; both are equally likely.
    pub(crate) fn sample() -> Self {
        if gen_range(0, 2) == 0 {
            Self::Push
        } else {
            Self::Fold
        }
    }

    /// The parameter list shown in the agreement report.
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Push => "push: 1-away, guaranteed mangan, perfect wait",
            Self::Fold => "fold: 1-away, low score, bad wait",
        }
    }

    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Push => "push",
            Self::Fold => "fold",
        }
    }
}

/// A finished hand plus everything the board needs to place it.
#[derive(Debug, Clone)]
pub(super) struct Skeleton {
    /// The fourteen tiles, sorted.
    pub tiles: Vec<Tile>,
    /// The thirteen tiles left after the shape-preserving discard.
    pub core: Vec<Tile>,
    /// The tile just drawn: one copy of the second pair.
    pub drawn: Tile,
    /// The discard the lesson grades correct.
    pub answer: Tile,
    /// The other pair's tile: the second shape-preserving discard. Both are
    /// Rank D, so the push branch accepts either.
    pub equivalent: Option<Tile>,
    /// A complete-set tile that sits in the threat's river, so it is 100% safe.
    pub safe_tile: Tile,
    pub dora_indicator: Tile,
    /// The hand's worst completion value without Riichi (`None` = a completion
    /// with no yaku at all).
    pub value: Option<Value>,
    pub good_wait: bool,
}

/// Builds one hand for `target`.
pub(super) fn build(target: Target, round_wind: Wind, seat_wind: Wind) -> Result<Skeleton, String> {
    let mut last = String::new();
    for _ in 0..MAX_ATTEMPTS {
        match attempt(target, round_wind, seat_wind) {
            Ok(skeleton) => return Ok(skeleton),
            Err(err) => last = err,
        }
    }
    Err(format!(
        "could not build a {} push/fold hand: {last}",
        target.as_str()
    ))
}

fn attempt(target: Target, round_wind: Wind, seat_wind: Wind) -> Result<Skeleton, String> {
    let dragon = choose(&DRAGONS).ok_or_else(|| "no dragon available".to_string())?;
    let dora_indicator = indicator_for(dragon);

    let mut groups: Vec<Vec<Tile>> = Vec::with_capacity(6);

    // Set A: a run. The fold branch starts it on a terminal, so no completion
    // can pick up tanyao.
    let run_suit = random_suit();
    let run_start = match target {
        Target::Push => gen_range(2, 6) as u8,
        Target::Fold => choose(&[1u8, 7]).ok_or_else(|| "no run start".to_string())?,
    };
    let run: Vec<Tile> = (run_start..run_start + 3)
        .map(|value| Tile::suited(run_suit, value))
        .collect();
    groups.push(run.clone());

    // Set B: three dora and a yakuhai on the push branch; a valueless triplet
    // on the fold branch.
    match target {
        Target::Push => groups.push(vec![dragon, dragon, dragon]),
        Target::Fold => {
            let winds: Vec<Tile> = WIND_TILES
                .iter()
                .copied()
                .filter(|tile| *tile != wind_tile(round_wind) && *tile != wind_tile(seat_wind))
                .collect();
            let triplet = choose(&winds).ok_or_else(|| "no valueless wind".to_string())?;
            groups.push(vec![triplet, triplet, triplet]);
        }
    }

    // The two pairs. Both are 4-6 tiles so the pair tiles — the
    // shape-preserving discards — sit on the chart's Rank D row.
    let mut pairs: Vec<Tile> = Vec::with_capacity(2);
    for _ in 0..200 {
        if pairs.len() == 2 {
            break;
        }
        let tile = Tile::suited(random_suit(), gen_range(4, 7) as u8);
        if pairs.contains(&tile) {
            continue;
        }
        let candidate = vec![tile, tile];
        if !tile_group_is_separated(&candidate, &groups) {
            continue;
        }
        groups.push(candidate);
        pairs.push(tile);
    }
    if pairs.len() != 2 {
        return Err("no room for two separate middle pairs".to_string());
    }

    // The two protoruns. The push branch needs side waits; the fold branch
    // needs the closed waits that make every completion a bad wait. Each is
    // placed where it cannot merge with a block already in its suit.
    for _ in 0..2 {
        let step = match target {
            Target::Push => 1,
            Target::Fold => 2,
        };
        let starts: Vec<u8> = match target {
            Target::Push => (3..7).collect(),
            Target::Fold => (1..8).collect(),
        };
        let mut options: Vec<Vec<Tile>> = Vec::new();
        for suit in SUITS {
            for &start in &starts {
                let candidate = vec![Tile::suited(suit, start), Tile::suited(suit, start + step)];
                if !groups.contains(&candidate) && tile_group_is_separated(&candidate, &groups) {
                    options.push(candidate);
                }
            }
        }
        let protorun =
            choose(&options).ok_or_else(|| "no separated protorun placement".to_string())?;
        groups.push(protorun);
    }

    let mut tiles: Vec<Tile> = groups.into_iter().flatten().collect();
    tiles.sort();
    ensure_copy_limits(&tiles)?;
    if tiles.len() != 14 {
        return Err(format!("the hand has {} tiles, not 14", tiles.len()));
    }

    // The draw completed the second pair; discarding it again is the
    // shape-preserving move.
    let drawn = pairs[1];
    let core = without(&tiles, drawn)?;
    let pair_tile = pairs[0];

    let shanten = calculate_shanten(&to_counts(&tiles)).shanten;
    if shanten != 1 {
        return Err(format!("the fourteen tiles are {shanten}-away, not 1-away"));
    }

    let wait_is_good = good_wait(&core);
    let value = worst_completion_value(&core, round_wind, seat_wind, &[dora_indicator], 0);

    match target {
        Target::Push => {
            if !wait_is_good {
                return Err("the core is not a perfect 1-away shape".to_string());
            }
            if !value.is_some_and(Value::is_high_scoring) {
                return Err(format!(
                    "the core's minimum value is {:?}, below 7700",
                    value.map(|value| value.points)
                ));
            }
            // The other pair is the second shape-preserving discard, so the
            // hand has to be a push without it too.
            let kept = without(&tiles, pair_tile)?;
            if !good_wait(&kept)
                || !worst_completion_value(&kept, round_wind, seat_wind, &[dora_indicator], 0)
                    .is_some_and(Value::is_high_scoring)
            {
                return Err("the other pair is not an interchangeable push discard".to_string());
            }
        }
        Target::Fold => {
            if wait_is_good {
                return Err("the core still reaches a side wait".to_string());
            }
            if value.is_some_and(Value::is_high_scoring) {
                return Err("the core is a high scoring hand".to_string());
            }
        }
    }

    // The safe tile comes from the complete run, so folding visibly breaks a
    // set the hand could use rather than throwing a tile it would discard
    // anyway.
    let safe_tile = choose(&run).ok_or_else(|| "no run tile to make safe".to_string())?;

    let answer = match target {
        Target::Push => drawn,
        Target::Fold => safe_tile,
    };

    if target == Target::Push {
        let broken = without(&tiles, safe_tile)?;
        let broken_shanten = calculate_shanten(&to_counts(&broken)).shanten;
        if broken_shanten < 2 {
            return Err(format!(
                "discarding the safe tile leaves a {broken_shanten}-away hand"
            ));
        }
    }

    let equivalent = match target {
        Target::Push => Some(pair_tile),
        Target::Fold => None,
    };

    Ok(Skeleton {
        tiles,
        core,
        drawn,
        answer,
        equivalent,
        safe_tile,
        dora_indicator,
        value,
        good_wait: wait_is_good,
    })
}

/// True when every way the hand can become ready can still choose a side wait.
///
/// This is the book's test for a 1-away hand's wait (ch8:68): "your judgement
/// should be based on the \emph{best} possible wait pattern you can choose when
/// the hand becomes ready in the \emph{worst} possible manner". A hand passes
/// only when *every* acceptance tile has at least one discard that leaves
/// tenpai on a side wait (see [`completion_lines`]).
pub(crate) fn good_wait(tiles: &[Tile]) -> bool {
    let lines = completion_lines(tiles);
    if lines.is_empty() {
        return false;
    }

    let mut draws: Vec<Tile> = lines.iter().map(|line| line.draw).collect();
    draws.sort();
    draws.dedup();

    draws.iter().all(|draw| {
        lines
            .iter()
            .filter(|line| line.draw == *draw)
            .any(|line| line.has_side_wait())
    })
}

/// True when `candidate` shares no rank with, and no rank adjacent to, the
/// same-suit groups.
///
/// Without this the run, a side wait and the pair can fuse (a run plus its
/// neighbouring pair reads as a bulging float), which changes the shape the
/// lesson claims to be teaching even when the enumeration still passes. A gap
/// of one rank is enough to keep two blocks apart: `34` and `67` still read as
/// two protoruns, `34` and `45` read as one shape.
fn tile_group_is_separated(candidate: &[Tile], groups: &[Vec<Tile>]) -> bool {
    candidate.iter().all(|tile| {
        let (Some(suit), Some(value)) = (tile.suit(), tile.value()) else {
            return true;
        };
        groups.iter().flatten().all(|other| {
            let (Some(other_suit), Some(other_value)) = (other.suit(), other.value()) else {
                return true;
            };
            suit != other_suit || value.abs_diff(other_value) >= 2
        })
    })
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

fn ensure_copy_limits(tiles: &[Tile]) -> Result<(), String> {
    let counts = to_counts(tiles);
    if let Some((tile, count)) = counts.iter().find(|(_, count)| **count > 4) {
        return Err(format!("{tile} appears {count} times"));
    }
    Ok(())
}

fn random_suit() -> Suit {
    choose(&SUITS).expect("three suits")
}

const SUITS: [Suit; 3] = [Suit::Man, Suit::Pin, Suit::Sou];

/// The indicator that makes `dora` the dora tile.
pub(super) fn indicator_for(dora: Tile) -> Tile {
    match dora {
        Tile::Suited { suit, value } => {
            let previous = if value == 1 { 9 } else { value - 1 };
            Tile::suited(suit, previous)
        }
        Tile::Honor(honor) => Tile::honor(match honor {
            Honor::White => Honor::Red,
            Honor::Green => Honor::White,
            Honor::Red => Honor::Green,
            Honor::East => Honor::North,
            Honor::South => Honor::East,
            Honor::West => Honor::South,
            Honor::North => Honor::West,
        }),
    }
}

fn wind_tile(wind: Wind) -> Tile {
    Tile::honor(match wind {
        Wind::East => Honor::East,
        Wind::South => Honor::South,
        Wind::West => Honor::West,
        Wind::North => Honor::North,
    })
}

const DRAGONS: [Tile; 3] = [
    Tile::Honor(Honor::White),
    Tile::Honor(Honor::Green),
    Tile::Honor(Honor::Red),
];

const WIND_TILES: [Tile; 4] = [
    Tile::Honor(Honor::East),
    Tile::Honor(Honor::South),
    Tile::Honor(Honor::West),
    Tile::Honor(Honor::North),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_built_hand_matches_its_target() {
        for target in [Target::Push, Target::Fold] {
            for run in 0..25 {
                let skeleton = build(target, Wind::East, Wind::South)
                    .unwrap_or_else(|err| panic!("{} run {run}: {err}", target.as_str()));

                assert_eq!(skeleton.tiles.len(), 14);
                assert_eq!(skeleton.core.len(), 13);

                let full = calculate_shanten(&to_counts(&skeleton.tiles)).shanten;
                assert_eq!(full, 1, "{} run {run} must be 1-away", target.as_str());

                match target {
                    Target::Push => {
                        assert!(skeleton.good_wait);
                        let value = skeleton.value.expect("a guaranteed mangan has a value");
                        assert!(value.points >= 7_700);
                        assert_eq!(skeleton.answer, skeleton.drawn);
                        assert_ne!(skeleton.safe_tile, skeleton.drawn);
                        assert!(skeleton.equivalent.is_some());
                    }
                    Target::Fold => {
                        assert!(!skeleton.good_wait);
                        assert!(skeleton.value.is_none_or(|value| value.points < 7_700));
                        assert_eq!(skeleton.answer, skeleton.safe_tile);
                        assert_ne!(skeleton.answer, skeleton.drawn);
                        assert!(skeleton.equivalent.is_none());
                    }
                }
            }
        }
    }

    #[test]
    fn the_dora_indicator_makes_the_dragon_the_dora() {
        for dragon in DRAGONS {
            let indicator = indicator_for(dragon);
            assert_eq!(agari::context::indicator_to_dora(indicator), dragon);
        }
    }

    #[test]
    fn the_pair_tiles_are_middle_tiles() {
        for _ in 0..20 {
            let skeleton = build(Target::Push, Wind::East, Wind::South).expect("push hand");
            let value = skeleton.drawn.value().expect("a suited tile");
            assert!((4..=6).contains(&value));
            let equivalent = skeleton.equivalent.expect("the other pair");
            assert!((4..=6).contains(&equivalent.value().expect("a suited tile")));
        }
    }

    #[test]
    fn a_perfect_side_wait_shape_passes_the_good_wait_test() {
        // Ch8:77's shape: two sets, two side waits, a pair and a float.
        let tiles = agari::parse::parse_hand("23555m456p3499s2z").expect("hand must parse");
        assert!(good_wait(&tiles));
    }

    #[test]
    fn closed_waits_fail_the_good_wait_test() {
        let tiles = agari::parse::parse_hand("123m555p13s79p55m2z").expect("hand must parse");
        assert!(!good_wait(&tiles));
    }
}
