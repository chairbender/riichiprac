//! `honitsu_decision`: commit to honitsu, or play for efficiency?
//!
//! Riichi Book 1, ch. 5.4, "How to get honitsu", "Conditions to go for
//! honitsu". The section's rule:
//!
//! > When judging whether to go for honitsu or not, we should consider two
//! > factors --- five-block potential and hand values with and without honitsu.
//! > — ch5:468
//!
//! and its two "do not go" boxes:
//!
//! > In such situations, you should not aim for honitsu; you should try to make
//! > the hand ready without melding and go for riichi. — ch5:506
//! >
//! > At the same time, when the hand value is sufficiently high (>= 5200)
//! > *without* honitsu, you should not go for honitsu at the cost of tile
//! > efficiency. — ch5:517
//!
//! Every hand the drill deals has the *same* five-block potential in the target
//! suit plus honors: four blocks and at least one floating tile. That is
//! deliberate.
//! The book's Honitsu 2 hand also "has five tile blocks necessary for honitsu,
//! you should not go for honitsu" — so the drill teaches that block count alone
//! is not the decision, and the hand's value decides it:
//!
//! - [`Variant::Commit`] (book's Honitsu 1): the honitsu group holds two fanpai
//!   pairs, so the plan can add two yakuhai and reaches at least 5200, while
//!   the same tiles played straight have no yaku at all. The answer starts
//!   discarding the redundant off-suit tiles.
//! - [`Variant::AlreadyHigh`] (book's Honitsu 3): the hand already scores at
//!   least 5200 without honitsu (a dragon triplet, the seat wind and a red
//!   five), so the answer keeps the off-suit side-wait protorun and throws the
//!   in-suit floating tile.
//! - [`Variant::HonitsuOnly`] (book's Honitsu 2): the honitsu group holds no
//!   fanpai, so the plan would end as a "honitsu-only hand, which is very cheap
//!   (2000 or 2600 points)". The answer throws the valueless honor floater and
//!   keeps the off-suit blocks, leaving the closed riichi route open.
//!
//! Both factors are re-derived from the shipped tiles, never from the
//! constructor: the block count from the suit-and-honor tiles
//! ([`value::blocks_and_floaters`]), and the values by score enumeration
//! ([`facts`]). See `value.rs` for the projection the honitsu plan is scored
//! against.
//!
//! The multi-turn discard-order tip of the same section ("discard ... so that
//! the opponents cannot know if you are collecting manzu or pinzu", ch5:543) is
//! not graded here: it is a plan over several turns, not one discard. It is
//! mentioned in the commit rationales instead.

mod board;
mod skeleton;
mod value;

use agari::tile::Tile;

use crate::generator::support::retry::generate_with_retries;
use crate::generator::support::value::{Value, worst_completion_value};
use crate::state::{GameState, Wind};

pub(crate) use skeleton::Variant;
pub(crate) use value::{Blocks, Reading};

/// Generates a honitsu decision puzzle for the next request.
pub fn generate(category: &str) -> Result<GameState, String> {
    generate_with_target(category, sample_target())
}

/// Draws the branch the next request will teach, before any tile exists.
pub(crate) fn sample_target() -> Variant {
    Variant::sample()
}

/// Builds a hand and table under an already-drawn branch.
pub(crate) fn generate_with_target(category: &str, target: Variant) -> Result<GameState, String> {
    generate_with_retries("honitsu_decision", 200, || board::build(category, target))
}

/// The two book factors, re-derived from a finished table.
///
/// The rationale and the board validator both need them, and neither may trust
/// the constructor: a report imported from an older build has to be readable
/// with the same rules.
#[derive(Debug, Clone)]
pub(crate) struct Facts {
    /// Which branch the shipped answer belongs to.
    pub variant: Variant,
    /// The suit the honitsu plan collects (the best-represented suit).
    pub suit: agari::tile::Suit,
    /// The suit-and-honor block reading.
    pub blocks: Blocks,
    /// The honitsu plan's finished hand, scored. `None` when the group cannot
    /// be completed.
    pub honitsu: Option<Reading>,
    /// The worst value the same tiles win for without honitsu.
    pub value_without: Option<Value>,
    /// True when the graded discard leaves the honitsu suit.
    pub answer_is_off_suit: bool,
    /// How many fanpai blocks (pairs or triplets of dragons / value winds) the
    /// honitsu group holds.
    pub fanpai_blocks: usize,
}

/// Re-derives the honitsu facts from `state`, or `None` when the state is not a
/// honitsu decision.
pub(crate) fn facts(state: &GameState) -> Option<Facts> {
    let human = state.players.iter().find(|player| player.is_human)?;
    let tiles: Vec<Tile> = state
        .tiles
        .iter()
        .filter_map(|code| Tile::try_from(code.as_str()).ok())
        .collect();
    if tiles.len() != 14 {
        return None;
    }
    let answer = Tile::try_from(state.correct_action.tile()?).ok()?;

    let suit = honitsu_suit(&tiles)?;
    let group: Vec<Tile> = tiles
        .iter()
        .copied()
        .filter(|tile| match tile.suit() {
            Some(tile_suit) => tile_suit == suit,
            None => true,
        })
        .collect();
    let blocks = value::blocks_and_floaters(&group);

    let dora: Vec<Tile> = state
        .dora_indicators
        .iter()
        .filter_map(|code| Tile::try_from(code.as_str()).ok())
        .collect();
    let aka = human.red_fives.len().min(u8::MAX as usize) as u8;

    let honitsu = value::honitsu_reading(&group, suit, state.round_wind, human.wind, &dora, aka);

    let post: Vec<Tile> = {
        let mut rest = tiles.clone();
        let index = rest.iter().position(|tile| *tile == answer)?;
        rest.remove(index);
        rest
    };
    let value_without = worst_completion_value(&post, state.round_wind, human.wind, &dora, aka);

    let fanpai_blocks = fanpai_blocks(&group, state.round_wind, human.wind);
    let answer_is_off_suit = answer.suit().is_some_and(|answer_suit| answer_suit != suit);

    let variant = if answer_is_off_suit {
        Variant::Commit
    } else if honitsu.as_ref().is_some_and(Reading::is_honitsu_only) {
        Variant::HonitsuOnly
    } else {
        Variant::AlreadyHigh
    };

    Some(Facts {
        variant,
        suit,
        blocks,
        honitsu,
        value_without,
        answer_is_off_suit,
        fanpai_blocks,
    })
}

/// The suited suit with the most tiles.
///
/// Every hand holds at least five tiles of the honitsu suit and at most four of
/// either other suit, so the best-represented suit is the plan's suit without
/// having to trust a note.
fn honitsu_suit(tiles: &[Tile]) -> Option<agari::tile::Suit> {
    let mut best: Option<(agari::tile::Suit, usize)> = None;
    for suit in value::SUITS {
        let count = tiles
            .iter()
            .filter(|tile| tile.suit() == Some(suit))
            .count();
        match best {
            Some((_, best_count)) if best_count >= count => {}
            _ => best = Some((suit, count)),
        }
    }
    best.filter(|(_, count)| *count >= 5).map(|(suit, _)| suit)
}

/// The fanpai pairs and triplets in the honitsu group.
fn fanpai_blocks(group: &[Tile], round_wind: Wind, seat_wind: Wind) -> usize {
    let mut counts: std::collections::BTreeMap<Tile, usize> = std::collections::BTreeMap::new();
    for &tile in group {
        if value::is_fanpai(tile, round_wind, seat_wind) {
            *counts.entry(tile).or_insert(0) += 1;
        }
    }
    counts.values().filter(|count| **count >= 2).count()
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::state::{CorrectActionType, TargetAction};

    fn generate_for(variant: Variant) -> GameState {
        generate_with_target("honitsu_decision", variant)
            .unwrap_or_else(|err| panic!("{} must generate: {err}", variant.as_str()))
    }

    #[test]
    fn all_three_branches_are_generated_by_the_unpinned_entry_point() {
        let mut commit = 0;
        let mut already_high = 0;
        let mut honitsu_only = 0;

        for run in 0..90 {
            let state = generate("honitsu_decision")
                .unwrap_or_else(|err| panic!("run {run} failed: {err}"));
            assert_eq!(state.category, "honitsu_decision");
            assert_eq!(state.target_action, TargetAction::NaniKiru);
            assert_eq!(state.correct_action.action_type(), CorrectActionType::Dama);
            assert!(!state.is_agari);
            assert!(state.shanten >= 1);
            assert!(state.shanten <= 2);
            // The answer leaves a hand that is still 1-away, so no discard can
            // reach tenpai and the Riichi toggle must stay off.
            assert!(!state.can_riichi, "run {run}: an early hand offered Riichi");

            match facts(&state).expect("the table has honitsu facts").variant {
                Variant::Commit => commit += 1,
                Variant::AlreadyHigh => already_high += 1,
                Variant::HonitsuOnly => honitsu_only += 1,
            }
        }

        assert!(commit > 0, "no commit hands were generated");
        assert!(already_high > 0, "no already-high hands were generated");
        assert!(honitsu_only > 0, "no honitsu-only hands were generated");
    }

    #[test]
    fn every_branch_ships_a_reachable_five_block_table() {
        for variant in [Variant::Commit, Variant::AlreadyHigh, Variant::HonitsuOnly] {
            for run in 0..12 {
                let state = generate_for(variant);
                crate::generator::support::state_validation::validate_reachable_state(&state)
                    .unwrap_or_else(|err| {
                        panic!("{} run {run} is unreachable: {err}", variant.as_str())
                    });

                let human = state
                    .players
                    .iter()
                    .find(|player| player.is_human)
                    .expect("human");
                assert_eq!(human.hand.len(), 13);
                assert!(human.draw.is_some());
                assert!(human.melds.is_empty());
                assert!(!human.is_riichi);
                assert!(
                    state
                        .tiles
                        .iter()
                        .any(|code| code == state.correct_action.tile().unwrap()),
                    "the answer must be in the displayed hand"
                );

                let facts = facts(&state).expect("facts");
                assert_eq!(facts.variant, variant);
                assert!(facts.blocks.has_five_block_potential());
            }
        }
    }

    #[test]
    fn the_dora_never_touches_the_hand() {
        for variant in [Variant::Commit, Variant::AlreadyHigh, Variant::HonitsuOnly] {
            for _ in 0..10 {
                let state = generate_for(variant);
                for indicator in &state.dora_indicators {
                    let indicator =
                        Tile::try_from(indicator.as_str()).expect("the indicator parses");
                    let dora = agari::context::indicator_to_dora(indicator);
                    assert!(
                        !state.tiles.iter().any(|code| *code == dora.to_string()),
                        "{}: the dora {dora} is in the hand",
                        variant.as_str()
                    );
                }
            }
        }
    }

    #[test]
    fn the_commit_branch_accepts_every_redundant_off_suit_tile() {
        for _ in 0..8 {
            let state = generate_for(Variant::Commit);
            let facts = facts(&state).expect("facts");
            let mut redundant: Vec<String> = state
                .tiles
                .iter()
                .filter(|code| {
                    Tile::try_from(code.as_str())
                        .ok()
                        .and_then(|tile| tile.suit())
                        .is_some_and(|suit| suit != facts.suit)
                })
                .cloned()
                .collect();
            redundant.sort();
            redundant.dedup();

            let mut accepted = vec![state.correct_action.tile().expect("answer").to_string()];
            accepted.extend(state.equivalent_tiles.iter().cloned());
            accepted.sort();
            accepted.dedup();

            assert_eq!(
                accepted, redundant,
                "every off-suit tile is one of the book's redundant tiles"
            );
        }
    }

    #[test]
    fn the_already_high_branch_is_worth_5200_without_honitsu() {
        for _ in 0..10 {
            let state = generate_for(Variant::AlreadyHigh);
            let facts = facts(&state).expect("facts");
            let value = facts.value_without.expect("a guaranteed value");
            assert!(
                value.points >= 5_200,
                "the straight hand is only worth {}",
                value.points
            );
            assert!(!facts.answer_is_off_suit);
            // The red five is the third han of the book's arithmetic.
            assert!(!state.players[0].red_fives.is_empty());
        }
    }

    #[test]
    fn the_honitsu_only_branch_is_cheap_and_keeps_the_off_suit_blocks() {
        for _ in 0..10 {
            let state = generate_for(Variant::HonitsuOnly);
            let facts = facts(&state).expect("facts");
            let reading = facts.honitsu.expect("a honitsu reading");
            assert!(reading.is_honitsu_only());
            assert_eq!(reading.value.han, 3, "closed honitsu is three han");
            assert_eq!(facts.fanpai_blocks, 0);
            assert!(!facts.answer_is_off_suit);
        }
    }

    #[test]
    fn the_commit_branch_has_two_fanpai_blocks_and_a_valuable_plan() {
        for _ in 0..10 {
            let state = generate_for(Variant::Commit);
            let facts = facts(&state).expect("facts");
            assert!(facts.fanpai_blocks >= 2);
            let reading = facts.honitsu.expect("a honitsu reading");
            assert!(reading.value.points >= 5_200);
            assert!(!reading.is_honitsu_only());
        }
    }
}
