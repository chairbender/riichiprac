//! Shared state reading for the book classifiers.
//!
//! Every B1 classifier answers the same shape of question: *the human is about
//! to discard on their own turn, the hand is closed, and the book rule decides
//! what to do.* This module turns a [`GameState`] into that view **from the
//! state's own tiles**, never from its derived fields:
//!
//! - the 14-tile hand is rebuilt from `players[0].hand + players[0].draw`;
//! - the live-wait count is rebuilt with the visible set the player can see
//!   (every river, every meld, the dora indicators);
//! - the ch. 7 three conditions are re-evaluated with the hand's red fives;
//! - every discard that leaves the hand tenpai is enumerated, so a lesson whose
//!   answer does not depend on which of those discards is taken can report the
//!   equivalence class the app already grades (`equivalent_tiles`).
//!
//! Anything the classifier cannot read from visible information returns `None`
//! instead of guessing (replay-strategy §6.4, "fail closed").

use std::collections::HashMap;

use agari::hand::{HandStructure, decompose_hand};
use agari::parse::to_counts;
use agari::shanten::{calculate_shanten, calculate_ukeire, calculate_ukeire_with_visible};
use agari::tile::Tile;

use crate::generator::riichi_judgement::judgement::{self, Conditions, WaitQuality};
use crate::generator::support::analysis::evaluate_hand;
use crate::generator::support::completion::{WaitShape, wait_shapes};
use crate::generator::support::value::{Value, worst_value};
use crate::state::{DecisionContext, GameState, Wind};

/// One legal discard from the displayed hand that leaves the hand tenpai.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Candidate {
    /// The tile that leaves the hand tenpai when it is discarded.
    pub discard: Tile,
    /// The 13-tile tenpai hand that remains.
    pub kept: Kept,
}

/// A tenpai hand, read from the table.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Kept {
    /// The 13 kept tiles, sorted.
    pub tiles: Vec<Tile>,
    /// The nominal winning kinds (theoretical four copies).
    pub waits: Vec<Tile>,
    /// The winning kinds that still have at least one live copy.
    pub live_waits: Vec<Tile>,
    /// The book's live-wait quality count (kinds and live tiles).
    pub quality: WaitQuality,
    /// The ch. 7 three conditions.
    pub conditions: Conditions,
    /// The worst ron value without Riichi, including dora and red fives.
    pub worst_value: Option<Value>,
    /// How many winning kinds can be a side (ryanmen) wait.
    pub side_waits: usize,
}

impl Kept {
    /// A wait with no live copy at all cannot win, so it is not a drill.
    pub(crate) fn is_live(&self) -> bool {
        !self.live_waits.is_empty()
    }

    /// True when every winning tile can be read as a standard hand.
    ///
    /// The chiitoitsu lesson owns seven pairs; a B1 riichi/dama classifier must
    /// not claim it, because the book's shape rules (pinfu, extra han) are about
    /// the standard decomposition.
    pub(crate) fn is_standard(&self) -> bool {
        !self.waits.is_empty()
            && self.waits.iter().all(|&wait| {
                let mut winning = self.tiles.clone();
                winning.push(wait);
                decompose_hand(&to_counts(&winning))
                    .iter()
                    .any(|structure| matches!(structure, HandStructure::Standard { .. }))
            })
    }
}

/// The table facts a self-turn discard classifier needs.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Turn {
    /// The human's seat wind.
    pub human_wind: Wind,
    /// The round wind.
    pub round_wind: Wind,
    /// Revealed dora indicators.
    pub dora: Vec<Tile>,
    /// How many red fives the human holds.
    pub aka: u8,
    /// The 14 displayed tiles (`hand` + `draw`), sorted.
    pub hand: Vec<Tile>,
    /// The tile just drawn (the 14th tile).
    pub draw: Tile,
    /// The human's own river, for the furiten guard.
    pub river: Vec<Tile>,
    /// The turn number about to be played (`discards.len() + 1`).
    pub turn: usize,
    /// Every seat's score, in seat order.
    pub scores: [i32; 4],
    /// Everything the player can see: rivers, melds and dora indicators.
    pub visible: HashMap<Tile, u8>,
    /// The recomputed shanten of the 14-tile hand.
    pub shanten: i8,
}

impl Turn {
    /// True when the human's score is at least every opponent's.
    ///
    /// ch. 7's expensive-hand box says "Riichi if you are far behind from other
    /// players". The book gives no threshold; the `dama_expensive_hand` lesson
    /// reads "not far behind" as "the human is in front" (its board comments
    /// cite ch7:641 and place the human in first). The classifier uses the same
    /// conservative reading and returns no match when the human is behind, so a
    /// position where the "far behind" exception might apply is never shipped
    /// as a dama drill.
    pub(crate) fn human_is_in_front(&self) -> bool {
        self.scores[1..]
            .iter()
            .all(|score| *score <= self.scores[0])
    }
}

/// Read the human's self-turn discard decision, or `None` when this state is
/// not that shape of decision.
///
/// Guards, all structural and visible-info only:
///
/// - a [`DecisionContext::SelfTurn`] on the human's own turn (`seat 0`);
/// - a closed hand (`melds` empty — an open hand is a different lesson family);
/// - 13 concealed tiles plus a draw (14 tiles), not a winning hand;
/// - a Riichi hand is already declared, so it is not a decision.
pub(crate) fn turn(state: &GameState) -> Option<Turn> {
    if state.decision != DecisionContext::SelfTurn || state.current_turn != 0 {
        return None;
    }
    if state.players.len() != 4 {
        return None;
    }
    let human = &state.players[0];
    if !human.is_human || human.seat != 0 || human.is_riichi || !human.melds.is_empty() {
        return None;
    }
    let draw = human.draw.as_deref()?;
    if human.hand.len() != 13 {
        return None;
    }

    let mut hand: Vec<Tile> = human
        .hand
        .iter()
        .map(|code| Tile::try_from(code.as_str()).ok())
        .collect::<Option<_>>()?;
    let draw = Tile::try_from(draw).ok()?;
    hand.push(draw);
    hand.sort();
    if evaluate_hand(&hand).is_agari {
        return None;
    }

    let dora: Vec<Tile> = state
        .dora_indicators
        .iter()
        .map(|code| Tile::try_from(code.as_str()).ok())
        .collect::<Option<_>>()?;
    let river: Vec<Tile> = human
        .discards
        .iter()
        .map(|discard| Tile::try_from(discard.tile.as_str()).ok())
        .collect::<Option<_>>()?;

    let mut visible: HashMap<Tile, u8> = HashMap::new();
    for player in &state.players {
        for discard in &player.discards {
            let tile = Tile::try_from(discard.tile.as_str()).ok()?;
            increment(&mut visible, tile);
        }
        for meld in &player.melds {
            for code in &meld.tiles {
                let tile = Tile::try_from(code.as_str()).ok()?;
                increment(&mut visible, tile);
            }
        }
    }
    for &tile in &dora {
        increment(&mut visible, tile);
    }

    let shanten = calculate_shanten(&to_counts(&hand)).shanten;
    if shanten < 0 {
        return None;
    }

    Some(Turn {
        human_wind: human.wind,
        round_wind: state.round_wind,
        dora,
        aka: human.red_fives.len().min(u8::MAX as usize) as u8,
        hand,
        draw,
        river,
        turn: human.discards.len() + 1,
        scores: [
            state.players[0].score,
            state.players[1].score,
            state.players[2].score,
            state.players[3].score,
        ],
        visible,
        shanten,
    })
}

/// Every distinct discard that leaves the hand tenpai, in tile order.
///
/// A furiten outcome is dropped: if a wait tile is already in the human's own
/// river the hand cannot ron it, so the riichi/dama decision would depend on
/// information the state does not model (replay-strategy §6.3's furiten open
/// question). A state with *any* such candidate returns no view at all, so the
/// answer set is never narrowed by a filter the player cannot see.
pub(crate) fn candidates(turn: &Turn) -> Option<Vec<Candidate>> {
    let mut seen: Vec<Tile> = Vec::new();
    let mut out = Vec::new();

    for &discard in &turn.hand {
        if seen.contains(&discard) {
            continue;
        }
        seen.push(discard);

        let mut kept = turn.hand.clone();
        let index = kept
            .iter()
            .position(|tile| *tile == discard)
            .expect("the tile came from the hand");
        kept.remove(index);
        if calculate_shanten(&to_counts(&kept)).shanten != 0 {
            continue;
        }

        let analysis = analyse_kept(&kept, turn);
        if analysis.waits.iter().any(|wait| turn.river.contains(wait)) {
            return None;
        }
        out.push(Candidate {
            discard,
            kept: analysis,
        });
    }

    if out.is_empty() { None } else { Some(out) }
}

fn analyse_kept(tiles: &[Tile], turn: &Turn) -> Kept {
    let counts = to_counts(tiles);
    let waits: Vec<Tile> = calculate_ukeire(&counts)
        .tiles
        .iter()
        .map(|entry| entry.tile)
        .collect();
    let live_waits: Vec<Tile> = calculate_ukeire_with_visible(&counts, &turn.visible)
        .tiles
        .iter()
        .filter(|entry| entry.available > 0)
        .map(|entry| entry.tile)
        .collect();
    let quality = judgement::wait_quality(tiles, &turn.visible);
    let conditions = judgement::evaluate_with_aka(
        tiles,
        &waits,
        turn.round_wind,
        turn.human_wind,
        &turn.dora,
        turn.aka,
        &turn.visible,
    );
    let worst_value = worst_value(
        tiles,
        &waits,
        turn.round_wind,
        turn.human_wind,
        &turn.dora,
        turn.aka,
    );
    let side_waits = waits
        .iter()
        .filter(|&&wait| wait_shapes(tiles, wait).contains(&WaitShape::Ryanmen))
        .count();

    Kept {
        tiles: tiles.to_vec(),
        waits,
        live_waits,
        quality,
        conditions,
        worst_value,
        side_waits,
    }
}

/// The one opponent who has declared Riichi, if exactly one has.
///
/// The defense classifiers read a single threat's river; a two-riichi table is
/// a different (unsupported) read, and `SafetyFacts` would answer for only one
/// of them. Returning `None` is the fail-closed choice.
pub(crate) fn sole_riichi_threat(state: &GameState) -> Option<usize> {
    let mut threats = state
        .players
        .iter()
        .filter(|player| player.is_riichi)
        .map(|player| player.seat);
    let seat = threats.next()?;
    if threats.next().is_some() {
        return None;
    }
    let threat = state.players.iter().find(|player| player.seat == seat)?;
    threat.riichi_discard_index?;
    Some(seat)
}

/// The distinct hand tiles, in tile order.
pub(crate) fn distinct(tiles: &[Tile]) -> Vec<Tile> {
    let mut distinct = tiles.to_vec();
    distinct.sort();
    distinct.dedup();
    distinct
}

/// Increment a visible-copy count.
pub(crate) fn increment(counts: &mut HashMap<Tile, u8>, tile: Tile) {
    *counts.entry(tile).or_insert(0) += 1;
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::generator::generate_puzzle;
    use crate::state::{CorrectAction, TargetAction};

    #[test]
    fn a_generated_riichi_state_reads_its_tenpai_discard() {
        let state = generate_puzzle("riichi_judgement").expect("must generate");
        let turn = turn(&state).expect("a self-turn discard decision");
        assert_eq!(turn.hand.len(), 14);

        let candidates = candidates(&turn).expect("at least one tenpai discard");
        let answer = state.correct_action.tile().expect("an answer tile");
        assert!(
            candidates
                .iter()
                .any(|candidate| candidate.discard.to_string() == answer),
            "the lesson's answer must be one of the tenpai discards"
        );
        assert!(candidates.iter().all(|candidate| candidate.kept.is_live()));
    }

    #[test]
    fn a_reaction_decision_is_not_a_self_turn() {
        let mut state = generate_puzzle("riichi_judgement").expect("must generate");
        state.decision = DecisionContext::ReactToDiscard {
            from: 3,
            tile: "4m".to_string(),
        };
        assert!(turn(&state).is_none());
    }

    #[test]
    fn an_open_hand_is_not_a_book_discard_decision() {
        let mut state = generate_puzzle("riichi_judgement").expect("must generate");
        state.players[0].melds.push(crate::state::CalledMeld {
            meld_type: crate::state::MeldType::Pon,
            tiles: vec!["5z".to_string(); 3],
            called_from: Some(3),
        });
        assert!(turn(&state).is_none());
    }

    #[test]
    fn an_agari_state_is_not_a_discard_decision() {
        let mut state = generate_puzzle("riichi_judgement").expect("must generate");
        let tiles =
            agari::parse::parse_hand("123m456m789m123p55s").expect("a complete hand must parse");
        state.players[0].hand = tiles[..13].iter().map(ToString::to_string).collect();
        state.players[0].draw = Some(tiles[13].to_string());
        assert!(turn(&state).is_none());
    }

    #[test]
    fn a_missing_draw_is_not_a_self_turn() {
        let mut state = generate_puzzle("riichi_judgement").expect("must generate");
        let draw = state.players[0].draw.take().expect("a draw");
        state.players[0].hand.push(draw);
        assert!(turn(&state).is_none());
    }

    #[test]
    fn a_two_threat_table_has_no_sole_threat() {
        let mut state = generate_puzzle("fold_to_riichi").expect("must generate");
        let other = state
            .players
            .iter()
            .position(|player| !player.is_riichi && !player.is_human)
            .expect("an opponent");
        state.players[other].is_riichi = true;
        state.players[other].riichi_discard_index = Some(0);
        assert!(sole_riichi_threat(&state).is_none());
    }

    #[test]
    fn in_front_means_the_human_leads_the_table() {
        let state = generate_puzzle("riichi_judgement").expect("must generate");
        let mut turn = turn(&state).expect("a turn");
        turn.scores = [30_000, 20_000, 20_000, 20_000];
        assert!(turn.human_is_in_front());
        turn.scores = [20_000, 30_000, 20_000, 20_000];
        assert!(!turn.human_is_in_front());
    }

    #[test]
    fn the_state_answers_are_the_lessons_own_carriers() {
        // Sanity anchor for the tests above: the fixture really is a riichi
        // judgement state with a tenpai discard answer.
        let state = generate_puzzle("riichi_judgement").expect("must generate");
        assert!(matches!(
            state.target_action,
            TargetAction::Riichi | TargetAction::Dama
        ));
        assert!(matches!(
            state.correct_action,
            CorrectAction::Riichi { .. } | CorrectAction::Dama { .. }
        ));
    }
}
