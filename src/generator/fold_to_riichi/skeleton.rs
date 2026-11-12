//! Constructive skeleton for the fold-to-Riichi lesson.
//!
//! Riichi Book 1, ch. 8, "A simple principle":
//!
//! > Fold if **two** of the following conditions are met:
//! > 1-away (or worse) hand; Low scoring hand; Bad wait. — ch8:31-36
//!
//! and "Defense against riichi":
//!
//! > If you cannot satisfy the above criteria, you must completely fold
//! > (betaori). — ch8:340
//!
//! The question is therefore only *which* tile to throw, and the chapter's
//! first answer is the 100% one: "Genbutsu tiles of player X are 100% safe
//! against X" (ch8:100). This skeleton fixes the two facts the board is built
//! around: the answer (the genbutsu tile) and the block it breaks.
//!
//! The block is what makes the drill read as a fold rather than as an
//! efficiency discard. The safe tile is one copy of a pair, one tile of a
//! side-wait protorun, or one tile of a completed run, so throwing it visibly
//! gives up something the hand could use. A lone floating honor would be a
//! free discard and teach the wrong lesson.

use agari::tile::{Honor, Suit, Tile};

use crate::rng::{choose, gen_range};

/// The block the answer sits in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum BlockKind {
    /// The answer is one copy of a pair; the kept copy is the head.
    Pair,
    /// The answer is one tile of a side-wait protorun.
    Ryanmen,
    /// The answer is one tile of a completed run.
    Run,
}

impl BlockKind {
    /// Every kind, for the tests.
    #[cfg(test)]
    pub(super) const ALL: [BlockKind; 3] = [BlockKind::Pair, BlockKind::Ryanmen, BlockKind::Run];

    /// Stable id, used by the tests and the skeleton's own diagnostics.
    pub(super) fn as_str(self) -> &'static str {
        match self {
            BlockKind::Pair => "pair",
            BlockKind::Ryanmen => "ryanmen",
            BlockKind::Run => "run",
        }
    }
}

/// A constructed answer and the tiles it shares a block with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Skeleton {
    /// The tile the learner must discard: the board makes it 100% safe.
    pub answer: Tile,
    pub kind: BlockKind,
    /// The other hand tiles of the answer's block: one for a pair or a
    /// protorun, two for a completed run.
    pub block: Vec<Tile>,
}

impl Skeleton {
    /// Every hand tile the skeleton already spent, in no particular order.
    pub(super) fn reserved(&self) -> Vec<Tile> {
        let mut tiles = self.block.clone();
        tiles.push(self.answer);
        tiles
    }
}

/// Builds one answer and its block.
pub(super) fn build() -> Result<Skeleton, String> {
    let suit = choose(&[Suit::Man, Suit::Pin, Suit::Sou])
        .ok_or_else(|| "no suit is available for the safe tile".to_string())?;

    match gen_range(0, 3) {
        // A pair: half of them are honors, the head the mining notes call the
        // usual genbutsu fold ("a pair of a discarded honor sitting in the
        // hand as the head").
        0 => {
            let answer = if gen_range(0, 2) == 0 {
                Tile::Honor(random_honor()?)
            } else {
                Tile::suited(suit, gen_range(1, 10) as u8)
            };

            Ok(Skeleton {
                answer,
                kind: BlockKind::Pair,
                block: vec![answer],
            })
        }
        // A side-wait protorun: two adjacent numbers, one of them the answer.
        1 => {
            let low = gen_range(1, 8) as u8;
            let (answer_value, partner_value) = if gen_range(0, 2) == 0 {
                (low, low + 1)
            } else {
                (low + 1, low)
            };

            Ok(Skeleton {
                answer: Tile::suited(suit, answer_value),
                kind: BlockKind::Ryanmen,
                block: vec![Tile::suited(suit, partner_value)],
            })
        }
        // A completed run: any of its three tiles can be the one to give up.
        _ => {
            let low = gen_range(1, 8) as u8;
            let answer = Tile::suited(suit, low + gen_range(0, 3) as u8);
            let block: Vec<Tile> = (0..3u8)
                .map(|offset| Tile::suited(suit, low + offset))
                .filter(|tile| *tile != answer)
                .collect();
            if block.len() != 2 {
                return Err("the run did not leave two partners".to_string());
            }

            Ok(Skeleton {
                answer,
                kind: BlockKind::Run,
                block,
            })
        }
    }
}

fn random_honor() -> Result<Honor, String> {
    choose(&[
        Honor::East,
        Honor::South,
        Honor::West,
        Honor::North,
        Honor::White,
        Honor::Green,
        Honor::Red,
    ])
    .ok_or_else(|| "no honor tile is available".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// True when two tiles are the same pair or a same-suit protorun.
    fn block_partners(a: Tile, b: Tile) -> bool {
        if a == b {
            return true;
        }
        match (a.suit(), a.value(), b.suit(), b.value()) {
            (Some(a_suit), Some(a_value), Some(b_suit), Some(b_value)) => {
                a_suit == b_suit && (1..=2).contains(&a_value.abs_diff(b_value))
            }
            _ => false,
        }
    }

    #[test]
    fn every_kind_is_generated_and_the_block_stays_attached() {
        let mut seen = HashSet::new();

        for _ in 0..300 {
            let skeleton = build().expect("skeleton must build");
            seen.insert(skeleton.kind.as_str());

            assert!(
                skeleton
                    .block
                    .iter()
                    .all(|tile| block_partners(skeleton.answer, *tile)),
                "{:?}: {:?} does not share a block with {}",
                skeleton.kind,
                skeleton.block,
                skeleton.answer
            );

            let expected = match skeleton.kind {
                BlockKind::Pair | BlockKind::Ryanmen => 1,
                BlockKind::Run => 2,
            };
            assert_eq!(skeleton.block.len(), expected);

            match skeleton.kind {
                BlockKind::Pair => {
                    assert_eq!(skeleton.block, vec![skeleton.answer]);
                }
                BlockKind::Ryanmen => {
                    let answer = skeleton.answer;
                    let partner = skeleton.block[0];
                    assert_ne!(answer, partner);
                    assert_eq!(
                        answer
                            .value()
                            .expect("suited")
                            .abs_diff(partner.value().expect("suited")),
                        1,
                        "{answer} and {partner} must be a side wait"
                    );
                }
                BlockKind::Run => {
                    let mut values: Vec<u8> = skeleton
                        .block
                        .iter()
                        .map(|tile| tile.value().expect("a run is suited"))
                        .collect();
                    values.push(skeleton.answer.value().expect("a run is suited"));
                    values.sort();
                    assert_eq!(values[1], values[0] + 1);
                    assert_eq!(values[2], values[1] + 1);
                }
            }
        }

        for kind in BlockKind::ALL {
            assert!(seen.contains(kind.as_str()), "{kind:?} was never generated");
        }
    }

    #[test]
    fn a_pair_never_needs_a_partner_tile() {
        for _ in 0..200 {
            let skeleton = build().expect("skeleton");
            if skeleton.kind == BlockKind::Pair {
                assert_eq!(skeleton.block, vec![skeleton.answer]);
                assert_eq!(skeleton.reserved().len(), 2);
            }
        }
    }
}
