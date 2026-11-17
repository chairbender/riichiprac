//! The ch. 9 kan recognisers: `ankan_decision` and `shouminkan_decision`.
//!
//! Both lessons ask one neutral question — *call the quad, or discard?* — and
//! differ only in the shape of the quad:
//!
//! - [`ankan_decision`] — ch. 9, "Concealed quad (ankan)". The book justifies
//!   the quad "1-away, where at least one block has a good wait" and "2-away,
//!   where all the blocks have a good wait", and warns that it is wrong even
//!   when close to ready if "one of the four tiles can be used a good floating
//!   tile". The recogniser re-derives the post-quad block shape and compares
//!   the floating line against the quad line exactly as the generator's tests
//!   do.
//! - [`shouminkan_decision`] — ch. 9, "From an open set to an open quad
//!   (kakan)". The quad is justifiable when the hand is 1-away or better with a
//!   good wait and two han, when the wall is nearly empty, when a South-4
//!   placement gap needs the quad's minipoints, or when the player is losing
//!   badly; the 2-away hand with its value already secured keeps the Pon and
//!   discards the drawn fourth copy.
//!
//! Both recognisers recompute every number from the tiles and the score line;
//! neither reads the state's own triggers or answer.

use agari::parse::to_counts;
use agari::shanten::{
    calculate_shanten, calculate_shanten_with_melds, calculate_ukeire, calculate_ukeire_with_melds,
};
use agari::tile::{Honor, Suit, Tile};

use crate::generator::ScenarioId;
use crate::generator::shouminkan_decision::skeleton::value as kakan_value;
use crate::generator::support::analysis::floating_quad_acceptance;
use crate::state::{
    CorrectAction, DecisionContext, GameState, MeldType, ShouminkanTrigger, TargetAction, Wind,
};

use super::support;
use super::{Allowed, Match, TransformPolicy};

/// Riichi Book 1's "losing badly" scale, shared with the open-quad lesson: more
/// than 12,000 behind the player in third.
const LOSING_BADLY_GAP: i32 = 12_000;

/// The quad is a block-shape and wait-quality rule: relabelling recomputes it.
/// A red five is a dora and can change the hand value the kakan decision rests
/// on, so it goes through the same gate.
pub(crate) const POLICY: TransformPolicy = TransformPolicy {
    seat_perm: Allowed::AllowWithRecompute,
    suit_perm: Allowed::AllowWithRecompute,
    rank_mirror: Allowed::AllowWithRecompute,
    wind_relabel: Allowed::AllowWithRecompute,
    red5_normalize: Allowed::AllowWithRecompute,
    note: "both quad lessons are wait-shape, block-quality, hand-value and score-line rules, so \
           every transform re-runs the decision; a red five is a han and can move the kakan \
           placement window.",
};

/// Recognise the ch. 9 concealed-quad decision.
pub fn ankan_decision(state: &GameState) -> Option<Match> {
    let turn = support::turn(state)?;
    let quad = turn.draw;
    // All four copies concealed: three in the hand plus the active draw.
    if turn.hand.iter().filter(|tile| **tile == quad).count() != 4 {
        return None;
    }
    let post: Vec<Tile> = turn
        .hand
        .iter()
        .copied()
        .filter(|tile| *tile != quad)
        .collect();
    if post.len() != 10 {
        return None;
    }
    let kan_shanten = calculate_shanten_with_melds(&to_counts(&post), 1).shanten;
    // The generator's boards read the same shanten on the table and after the
    // quad. A table where they disagree is not the lesson's shape.
    if turn.shanten != kan_shanten {
        return None;
    }

    let kan_acceptance = tile_acceptance_with_melds(&post);

    // The book's floating-tile objection: the fourth copy can still build a
    // protorun, and the quad line loses those draws. Compare the two lines and
    // ask for one unambiguous useless tile to throw instead.
    let float_targets = floating_quad_acceptance(quad);
    if !float_targets.is_empty() && kan_shanten == 1 {
        let mut throws: Vec<(Tile, u8)> = Vec::new();
        for discard in support::distinct(&turn.hand) {
            if discard == quad {
                continue;
            }
            let mut kept = turn.hand.clone();
            let index = kept
                .iter()
                .position(|tile| *tile == discard)
                .expect("the tile came from the hand");
            kept.remove(index);
            if calculate_shanten(&to_counts(&kept)).shanten != 1 {
                continue;
            }
            let float_acceptance = tile_acceptance(&kept);
            let keeps_float = float_targets
                .iter()
                .all(|target| float_acceptance.contains(target));
            let loses_float = float_targets
                .iter()
                .all(|target| !kan_acceptance.contains(target));
            if keeps_float && loses_float {
                let acceptance = calculate_ukeire(&to_counts(&kept)).total_count;
                throws.push((discard, acceptance));
            }
        }
        // The book's answer is the useless tile: the throw that leaves the
        // floating line with the most acceptance. A tie is not decisive, and a
        // board with no such throw falls through to the quad conditions.
        let best = throws.iter().map(|(_, acceptance)| *acceptance).max();
        let best: Vec<Tile> = throws
            .iter()
            .filter(|(_, acceptance)| Some(*acceptance) == best)
            .map(|(discard, _)| *discard)
            .collect();
        match best.as_slice() {
            [discard] => {
                return Some(quad_match(
                    CorrectAction::discard(discard.to_string()),
                    "the fourth copy is a good floating tile; keep the quad concealed and throw \
                     the useless tile",
                    Vec::new(),
                ));
            }
            [] => {}
            _ => return None,
        }
    }

    // The two conditions the book gives for the quad (ch. 9): 1-away with at
    // least one good-wait block, or 2-away with every block on a good wait.
    let justified = match kan_shanten {
        1 => has_side_wait_block(&post),
        2 => all_blocks_are_side_waits(&post),
        _ => false,
    };
    if !justified {
        return None;
    }
    Some(quad_match(
        CorrectAction::kan(quad.to_string()),
        "the quad keeps a close hand with a good-wait block",
        Vec::new(),
    ))
}

/// Recognise the ch. 9 added-quad (kakan) decision.
pub fn shouminkan_decision(state: &GameState) -> Option<Match> {
    let human = state.players.first()?;
    if !human.is_human
        || human.seat != 0
        || state.decision != DecisionContext::SelfTurn
        || state.current_turn != 0
        || human.is_riichi
        || human.melds.len() != 1
        || human.hand.len() != 10
    {
        return None;
    }
    let meld = &human.melds[0];
    if meld.meld_type != MeldType::Pon || meld.tiles.len() != 3 {
        return None;
    }
    let pon = Tile::try_from(meld.tiles[0].as_str()).ok()?;
    if !is_dragon(pon) || meld.tiles.iter().any(|tile| tile != &meld.tiles[0]) {
        return None;
    }
    if human.draw.as_deref() != Some(pon.to_string().as_str()) {
        return None;
    }
    let concealed = support::parse_codes(human.hand.iter())?;
    if concealed.contains(&pon) {
        return None;
    }

    let facts = KakanFacts::read(state, &concealed, pon)?;
    let triggers = facts.triggers();
    if triggers.is_empty() {
        // The book's decline example: a hand with its value secured that is
        // still 2-away. A closer or valueless hand with no listed reason is not
        // the lesson's question; fail closed.
        if facts.shanten < 2 || facts.min_han < 2 {
            return None;
        }
        return Some(Match {
            lesson: ScenarioId::ShouminkanDecision,
            situation: Some(
                "2-away with its value already secured: keep the Pon and discard the fourth copy"
                    .to_string(),
            ),
            target_action: TargetAction::Kan,
            correct_action: CorrectAction::discard(pon.to_string()),
            equivalent_tiles: Vec::new(),
            riichi_triggers: Vec::new(),
            dama_reasons: Vec::new(),
            shouminkan_triggers: Vec::new(),
            scenario_note: None,
        });
    }

    let mut quoted = triggers.clone();
    quoted.sort_by_key(|trigger| trigger_order(*trigger));
    Some(Match {
        lesson: ScenarioId::ShouminkanDecision,
        situation: Some(format!("{} book kakan condition(s) hold", quoted.len())),
        target_action: TargetAction::Kan,
        correct_action: CorrectAction::kan(pon.to_string()),
        equivalent_tiles: Vec::new(),
        riichi_triggers: Vec::new(),
        dama_reasons: Vec::new(),
        shouminkan_triggers: quoted,
        scenario_note: None,
    })
}

/// Everything the kakan lesson argues from, recomputed from the table.
struct KakanFacts {
    shanten: i8,
    /// Guaranteed han before any Kan dora.
    min_han: u8,
    wait_kinds: usize,
    rank: usize,
    round_wind: Wind,
    hand_number: u8,
    gap_to_above: Option<i32>,
    tiles_remaining: u8,
    every_river_is_late: bool,
    /// Points between the human and third place, when the human is fourth.
    gap_to_third: Option<i32>,
    placement_dama: Option<u32>,
    placement_kan: Option<u32>,
}

impl KakanFacts {
    fn read(state: &GameState, concealed: &[Tile], pon: Tile) -> Option<Self> {
        let mut post = concealed.to_vec();
        post.extend([pon; 3]);
        let counts = to_counts(&post);
        let shanten = calculate_shanten(&counts).shanten;
        let waits: Vec<Tile> = calculate_ukeire(&counts)
            .tiles
            .iter()
            .map(|entry| entry.tile)
            .collect();
        let min_han = if shanten == 0 {
            kakan_value::min_wait_han(concealed, pon, &waits)
        } else {
            // The open Pon is one han; a second dragon triplet adds another.
            1 + u8::from(second_dragon_triplet(concealed, pon))
        };

        let human_score = state.players[0].score;
        let mut sorted: Vec<i32> = state.players.iter().map(|player| player.score).collect();
        sorted.sort_by(|a, b| b.cmp(a));
        let rank = 1 + sorted.iter().filter(|score| **score > human_score).count();
        let gap_to_above = sorted
            .iter()
            .copied()
            .filter(|score| *score > human_score)
            .min()
            .map(|score| score - human_score);
        let gap_to_third = sorted.get(2).map(|third| third - human_score);

        Some(Self {
            shanten,
            min_han,
            wait_kinds: waits.len(),
            rank,
            round_wind: state.round_wind,
            hand_number: state.hand_number,
            gap_to_above,
            tiles_remaining: state.tiles_remaining,
            every_river_is_late: state
                .players
                .iter()
                .all(|player| player.discards.len() >= 13),
            gap_to_third,
            placement_dama: kakan_value::placement_window(min_han).map(|window| window.dama),
            placement_kan: kakan_value::placement_window(min_han).map(|window| window.kan),
        })
    }

    /// The book's kakan conditions that hold, in enum order.
    fn triggers(&self) -> Vec<ShouminkanTrigger> {
        let mut triggers = Vec::new();
        let placement = self.placement_desperation();
        let losing = self.losing_badly();
        if self.shanten == 0 && (2..=3).contains(&self.wait_kinds) && self.min_han >= 2 {
            triggers.push(ShouminkanTrigger::GoodWaitAndValue);
        }
        if self.tiles_remaining < 20 && self.every_river_is_late {
            triggers.push(ShouminkanTrigger::LateGame);
        }
        if placement {
            triggers.push(ShouminkanTrigger::PlacementDesperation);
        }
        if losing {
            triggers.push(ShouminkanTrigger::LosingBadly);
        }
        if self.shanten >= 2 && (placement || losing) {
            triggers.push(ShouminkanTrigger::NeedsDora);
        }
        triggers
    }

    /// South-4, 2nd or 3rd, behind by a gap only the quad's minipoints close.
    fn placement_desperation(&self) -> bool {
        if self.round_wind != Wind::South || self.hand_number != 4 {
            return false;
        }
        if !matches!(self.rank, 2 | 3) {
            return false;
        }
        let (Some(gap), Some(dama), Some(kan)) =
            (self.gap_to_above, self.placement_dama, self.placement_kan)
        else {
            return false;
        };
        gap > dama as i32 && gap <= kan as i32
    }

    /// Fourth place, more than 12,000 behind third.
    fn losing_badly(&self) -> bool {
        self.rank == 4 && self.gap_to_third.is_some_and(|gap| gap > LOSING_BADLY_GAP)
    }
}

/// The `PlacementDesperation` etc. order the generator records.
fn trigger_order(trigger: ShouminkanTrigger) -> u8 {
    match trigger {
        ShouminkanTrigger::GoodWaitAndValue => 0,
        ShouminkanTrigger::LateGame => 1,
        ShouminkanTrigger::PlacementDesperation => 2,
        ShouminkanTrigger::LosingBadly => 3,
        ShouminkanTrigger::NeedsDora => 4,
    }
}

/// Build a kan-lesson match with the shared answer-free shape.
fn quad_match(action: CorrectAction, situation: &str, equivalents: Vec<String>) -> Match {
    Match {
        lesson: ScenarioId::AnkanDecision,
        situation: Some(situation.to_string()),
        target_action: TargetAction::Kan,
        correct_action: action,
        equivalent_tiles: equivalents,
        riichi_triggers: Vec::new(),
        dama_reasons: Vec::new(),
        shouminkan_triggers: Vec::new(),
        scenario_note: None,
    }
}

/// True when three copies of a second dragon sit in the concealed hand.
fn second_dragon_triplet(concealed: &[Tile], pon: Tile) -> bool {
    [Honor::White, Honor::Green, Honor::Red]
        .into_iter()
        .map(Tile::Honor)
        .filter(|tile| *tile != pon)
        .any(|dragon| concealed.iter().filter(|tile| **tile == dragon).count() == 3)
}

fn is_dragon(tile: Tile) -> bool {
    matches!(tile, Tile::Honor(Honor::White | Honor::Green | Honor::Red))
}

/// Every tile a 13-tile hand accepts, as a set.
fn tile_acceptance(tiles: &[Tile]) -> Vec<Tile> {
    calculate_ukeire(&to_counts(tiles))
        .tiles
        .iter()
        .map(|entry| entry.tile)
        .collect()
}

/// Every tile a 10-tile hand plus one meld accepts, as a set.
fn tile_acceptance_with_melds(tiles: &[Tile]) -> Vec<Tile> {
    calculate_ukeire_with_melds(&to_counts(tiles), 1)
        .tiles
        .iter()
        .map(|entry| entry.tile)
        .collect()
}

/// The distinct ranks per suit, used for the book's block reading.
fn suited_ranks(tiles: &[Tile]) -> [Vec<u8>; 3] {
    let mut ranks = [Vec::new(), Vec::new(), Vec::new()];
    for tile in tiles {
        let Tile::Suited { suit, value } = tile else {
            continue;
        };
        let index = match suit {
            Suit::Man => 0,
            Suit::Pin => 1,
            Suit::Sou => 2,
        };
        ranks[index].push(*value);
    }
    for ranks in &mut ranks {
        ranks.sort_unstable();
        ranks.dedup();
    }
    ranks
}

fn is_side_wait(ranks: &[u8]) -> bool {
    ranks.len() == 2 && ranks[1] == ranks[0] + 1 && (2..=7).contains(&ranks[0])
}

fn has_side_wait_block(tiles: &[Tile]) -> bool {
    suited_ranks(tiles).iter().any(|ranks| is_side_wait(ranks))
}

fn all_blocks_are_side_waits(tiles: &[Tile]) -> bool {
    suited_ranks(tiles)
        .iter()
        .all(|ranks| ranks.is_empty() || is_side_wait(ranks))
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::generator::generate_puzzle;
    use crate::state::CorrectActionType;

    #[test]
    fn the_concealed_quad_recognises_both_answers() {
        let mut kans = 0;
        let mut declines = 0;
        for run in 0..120 {
            let state =
                generate_puzzle("ankan_decision").unwrap_or_else(|err| panic!("run {run}: {err}"));
            let matched = ankan_decision(&state).unwrap_or_else(|| {
                panic!("run {run}: a generated quad board must classify as itself")
            });
            matched
                .validate(&state)
                .unwrap_or_else(|err| panic!("run {run}: illegal answer: {err}"));
            match state.correct_action.action_type() {
                CorrectActionType::Kan => {
                    kans += 1;
                    assert_eq!(
                        matched.correct_action.action_type(),
                        CorrectActionType::Kan,
                        "run {run}"
                    );
                }
                CorrectActionType::Discard => {
                    declines += 1;
                    assert_eq!(
                        matched.correct_action.action_type(),
                        CorrectActionType::Discard,
                        "run {run}"
                    );
                }
                other => panic!("run {run}: unexpected lesson answer {other:?}"),
            }
        }
        assert!(kans > 0, "the Kan cell must be recognised");
        assert!(declines > 0, "the floating-tile decline must be recognised");
    }

    #[test]
    fn a_kan_hand_with_a_valuable_floating_copy_declines() {
        for _ in 0..80 {
            let state = generate_puzzle("ankan_decision").expect("must generate");
            if state.correct_action.action_type() != CorrectActionType::Discard {
                continue;
            }
            let matched = ankan_decision(&state).expect("the decline cell");
            assert_eq!(matched.correct_action.tile(), state.correct_action.tile());
            break;
        }
    }

    #[test]
    fn the_added_quad_recognises_both_answers() {
        let mut kans = 0;
        let mut declines = 0;
        for run in 0..80 {
            let state = generate_puzzle("shouminkan_decision")
                .unwrap_or_else(|err| panic!("run {run}: {err}"));
            let matched = shouminkan_decision(&state).unwrap_or_else(|| {
                panic!("run {run}: a generated kakan board must classify as itself")
            });
            matched
                .validate(&state)
                .unwrap_or_else(|err| panic!("run {run}: illegal answer: {err}"));
            match state.correct_action.action_type() {
                CorrectActionType::Kan => {
                    kans += 1;
                    assert_eq!(
                        matched.correct_action.action_type(),
                        CorrectActionType::Kan,
                        "run {run}"
                    );
                    assert_eq!(
                        matched.shouminkan_triggers, state.shouminkan_triggers,
                        "run {run}: the recomputed triggers must agree"
                    );
                }
                CorrectActionType::Discard => {
                    declines += 1;
                    assert_eq!(
                        matched.correct_action.action_type(),
                        CorrectActionType::Discard,
                        "run {run}"
                    );
                    assert!(matched.shouminkan_triggers.is_empty());
                }
                other => panic!("run {run}: unexpected lesson answer {other:?}"),
            }
        }
        assert!(kans > 0 && declines > 0, "both cells must be covered");
    }

    #[test]
    fn a_closed_hand_is_not_the_added_quad() {
        let state = generate_puzzle("ankan_decision").expect("must generate");
        assert!(shouminkan_decision(&state).is_none());
        assert!(ankan_decision(&state).is_some());
    }

    #[test]
    fn a_non_quad_hand_is_not_the_concealed_quad() {
        let state = generate_puzzle("pinfu_head").expect("must generate");
        assert!(ankan_decision(&state).is_none());
    }

    #[test]
    fn the_block_readings_are_the_books() {
        let side: Vec<Tile> = ["2m", "3m"]
            .iter()
            .map(|code| Tile::try_from(*code).expect("tile"))
            .collect();
        let closed: Vec<Tile> = ["2m", "4m"]
            .iter()
            .map(|code| Tile::try_from(*code).expect("tile"))
            .collect();
        assert!(has_side_wait_block(&side));
        assert!(!has_side_wait_block(&closed));
        assert!(all_blocks_are_side_waits(&side));
        assert!(!all_blocks_are_side_waits(&closed));
    }
}
