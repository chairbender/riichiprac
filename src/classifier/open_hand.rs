//! The ch. 8.4 open-hand read (`open_hand_defense`).
//!
//! Riichi Book 1, ch. 8, "Discard upon chii":
//!
//! > chii -> discard a tile in the same suit
//! > => the neighborhood of the last discard is safe — ch8:567-568
//! >
//! > chii -> discard a tile in a different suit
//! > => the neighborhood of the last discard is dangerous — ch8:569-570
//!
//! The recogniser reads an arbitrary table the way the chapter does: the last
//! call an open hand made was a chii, and the human is about to discard right
//! after the tile that hand threw next. Everything is visible information — the
//! threat's melds, its river, the human's own hand and the table's visible
//! copies — and the threat's concealed hand is **never** read (the answer cannot
//! depend on it).
//!
//! # The two boards
//!
//! - **Same suit** (the safe read): the chii and the post-chii discard share a
//!   suit, so the discard's neighbourhood (same suit, one or two ranks away;
//!   [`in_open_hand_neighbourhood`]) is the one place the threat is unlikely to
//!   wait. The answer is the human's only neighbourhood tile. A table that also
//!   holds a 100% safe tile elsewhere (genbutsu, a fourth honour, a no-chance
//!   tile) is refused: that tile would be the answer for a different reason than
//!   the lesson, and the generator rejects the same board.
//! - **Different suit** (the trap): the chii and the discard are in different
//!   suits, so the neighbourhood is dangerous. The tempting block tile inside
//!   the neighbourhood is a real wait, and the answer is the human's unique
//!   100% safe tile outside it. The trap only reads as the chapter's lesson when
//!   there *is* a neighbourhood tile to reject, so a board without one declines.
//!
//! # Structural guards (fail closed)
//!
//! The human is at seat 0 and is about to discard, so the last tile on the table
//! belongs to Kamicha: the threat must be seat 3. The threat must be the only
//! live opponent (ch. 8's "three or more open sets" makes it ready), so a table
//! with a second ready hand is the multi-threat lesson's and returns `None`. The
//! hand must be slow (2-away or worse, the generator's shape): a ready hand's
//! discard is the riichi/dama or sanshoku question instead. The post-chii
//! discard must come from the hand (a discard after a call is never tsumogiri),
//! which pins it to the call rather than to a coincidence of the river order.
//!
//! # Overlap
//!
//! The ch. 8.1-8.3 family reads a Riichi threat's river through the safety
//! chart; this board has no Riichi (the threat is open), and
//! `defense_multi_threat` needs two live threats, so the three families are
//! disjoint by construction. `super::tests` pins that on generated boards.

use agari::tile::Tile;

use crate::generator::ScenarioId;
use crate::safety::{SafetyFacts, in_open_hand_neighbourhood};
use crate::state::{CorrectAction, GameState, MeldType, TargetAction};

use super::defense::ready_threat_seats;
use super::support::{self};
use super::{Allowed, Match, TransformPolicy};

/// The threat is the seat that discards immediately before the human.
const THREAT_SEAT: usize = 3;

/// The ch. 8.4 read is a structural safety rule: every relabelling re-runs it.
/// A red five is an ordinary tile for it (no value is read), so normalising one
/// only re-runs the read.
pub(crate) const POLICY: TransformPolicy = TransformPolicy {
    seat_perm: Allowed::AllowWithRecompute,
    suit_perm: Allowed::AllowWithRecompute,
    rank_mirror: Allowed::AllowWithRecompute,
    wind_relabel: Allowed::AllowWithRecompute,
    red5_normalize: Allowed::AllowWithRecompute,
    note: "the open-hand chii read is the suji-neighbourhood and genbutsu structure around the \
           threat's last discard, so every relabelling re-runs the same read; a red five carries \
           no value here",
};

/// Recognise the ch. 8.4 chii-discard read.
pub fn open_hand_defense(state: &GameState) -> Option<Match> {
    let turn = support::turn(state)?;
    // The lesson is a fold read on a hand that is not close to ready. A ready
    // hand is the riichi/dama or sanshoku question, not this one.
    if turn.shanten < 2 {
        return None;
    }

    // The human is about to discard, so Kamicha's discard is the last tile on
    // the table. Exactly one live threat may exist: a second ready hand is the
    // multi-threat lesson's board.
    if ready_threat_seats(state) != [THREAT_SEAT] {
        return None;
    }
    let threat = state
        .players
        .iter()
        .find(|player| player.seat == THREAT_SEAT)?;

    // The last call must be a chii, and the tile the human is reading must be
    // the tile thrown after it (from the hand, never tsumogiri).
    let last_meld = threat.melds.last()?;
    if last_meld.meld_type != MeldType::Chi {
        return None;
    }
    let chi_suit = run_suit(&last_meld.tiles)?;
    let post_chi = threat.discards.last()?;
    if post_chi.is_tsumogiri {
        return None;
    }
    let post_chi = Tile::try_from(post_chi.tile.as_str()).ok()?;
    let post_suit = post_chi.suit()?;

    let facts = SafetyFacts::from_state(state, THREAT_SEAT)?;
    let hand = support::distinct(&turn.hand);
    let neighbourhood: Vec<Tile> = hand
        .iter()
        .copied()
        .filter(|tile| in_open_hand_neighbourhood(*tile, post_chi))
        .collect();
    let safe: Vec<Tile> = hand
        .iter()
        .copied()
        .filter(|tile| facts.is_absolutely_safe(*tile))
        .collect();

    if chi_suit == post_suit {
        // Same suit: the neighbourhood is the relatively safe zone.
        if neighbourhood.len() != 1 {
            return None;
        }
        let answer = neighbourhood[0];
        // A 100% safe tile elsewhere would be the answer for a different
        // reason; the generator rejects the same board.
        if safe.iter().any(|tile| *tile != answer) {
            return None;
        }
        Some(fold_match(
            answer,
            "chii in the discard's suit: its neighbourhood is safe",
        ))
    } else {
        // Different suit (the trap): the neighbourhood is dangerous and the
        // answer is the unique 100% safe tile outside it.
        if safe.len() != 1 {
            return None;
        }
        let answer = safe[0];
        if in_open_hand_neighbourhood(answer, post_chi) {
            return None;
        }
        if neighbourhood.is_empty() {
            return None;
        }
        Some(fold_match(
            answer,
            "chii in another suit: the discard's neighbourhood is dangerous",
        ))
    }
}

/// The one suit a chii's three tiles share, or `None` when the meld is not a
/// real run in a single suit.
fn run_suit(codes: &[String]) -> Option<agari::tile::Suit> {
    if codes.len() != 3 {
        return None;
    }
    let tiles: Vec<Tile> = codes
        .iter()
        .map(|code| Tile::try_from(code.as_str()).ok())
        .collect::<Option<_>>()?;
    let suit = tiles.first()?.suit()?;
    let mut ranks = Vec::with_capacity(3);
    for tile in &tiles {
        if tile.suit()? != suit {
            return None;
        }
        ranks.push(tile.value()?);
    }
    ranks.sort_unstable();
    if ranks.windows(2).all(|pair| pair[1] == pair[0] + 1) {
        Some(suit)
    } else {
        None
    }
}

/// Build the fold answer.
fn fold_match(answer: Tile, situation: &str) -> Match {
    Match {
        lesson: ScenarioId::OpenHandDefense,
        situation: Some(situation.to_string()),
        target_action: TargetAction::Defend,
        correct_action: CorrectAction::fold(answer.to_string()),
        equivalent_tiles: Vec::new(),
        riichi_triggers: Vec::new(),
        dama_reasons: Vec::new(),
        shouminkan_triggers: Vec::new(),
        scenario_note: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::generator::generate_puzzle;

    fn generated() -> GameState {
        generate_puzzle("open_hand_defense").expect("open_hand_defense must generate")
    }

    fn threat(state: &GameState) -> &crate::state::PlayerState {
        state
            .players
            .iter()
            .find(|player| player.seat == THREAT_SEAT)
            .expect("the threat seat")
    }

    #[test]
    fn the_lesson_recognises_its_own_boards() {
        let mut same_suit = 0;
        let mut different_suit = 0;
        for run in 0..40 {
            let state = generated();
            let matched = open_hand_defense(&state)
                .unwrap_or_else(|| panic!("run {run}: the lesson's own board must classify"));
            matched
                .validate(&state)
                .unwrap_or_else(|err| panic!("run {run}: illegal answer: {err}"));
            assert_eq!(matched.lesson, ScenarioId::OpenHandDefense);
            assert_eq!(matched.target_action, TargetAction::Defend);
            assert_eq!(
                matched.correct_action.tile(),
                state.correct_action.tile(),
                "run {run}: the answer must be the skeleton's"
            );
            assert!(matched.equivalent_tiles.is_empty());

            let threat = threat(&state);
            let post_chi = Tile::try_from(threat.discards.last().expect("a discard").tile.as_str())
                .expect("the post-chii discard parses");
            let chi = threat
                .melds
                .last()
                .expect("the last meld")
                .tiles
                .first()
                .expect("a chi tile");
            let chi_suit = Tile::try_from(chi.as_str()).expect("a chi tile").suit();
            if chi_suit == post_chi.suit() {
                same_suit += 1;
            } else {
                different_suit += 1;
            }
        }
        assert!(same_suit > 0, "the drill must deal the safe read");
        assert!(
            different_suit > 0,
            "the drill must deal the different-suit trap"
        );
    }

    #[test]
    fn a_last_call_that_is_not_a_chii_is_refused() {
        // The same table with the last chii replaced by a pon: the chapter's
        // read is about chii, and a pon says the wait can be anything.
        let mut checked = 0;
        for _ in 0..20 {
            let mut state = generated();
            let seat = THREAT_SEAT;
            let Some(last) = state.players[seat].melds.last().cloned() else {
                continue;
            };
            if last.meld_type != MeldType::Chi {
                continue;
            }
            // A pon of the chii's first tile is the same three tiles, but the
            // call is not a chii.
            let tile = last.tiles[0].clone();
            let mut pon = last.clone();
            pon.meld_type = MeldType::Pon;
            pon.tiles = vec![tile; 3];
            state.players[seat].melds.pop();
            state.players[seat].melds.push(pon);
            assert!(
                open_hand_defense(&state).is_none(),
                "a pon is not the ch. 8.4 read"
            );
            checked += 1;
        }
        assert!(checked > 0, "the drill must deal a chii");
    }

    #[test]
    fn a_two_meld_threat_is_not_a_live_open_hand() {
        // Ch. 8.4's "assume ready" shortcut needs three or more open sets. With
        // two, the table does not identify a ready hand and the read stops.
        let mut state = generated();
        state.players[THREAT_SEAT].melds.pop();
        assert!(open_hand_defense(&state).is_none());
    }

    #[test]
    fn a_second_ready_opponent_is_refused() {
        let mut state = generated();
        let other = state
            .players
            .iter()
            .position(|player| player.seat != THREAT_SEAT && !player.is_human)
            .expect("another opponent");
        state.players[other].is_riichi = true;
        state.players[other].riichi_discard_index = Some(0);
        assert!(open_hand_defense(&state).is_none());
    }

    #[test]
    fn a_closed_hand_is_not_the_open_hand_read() {
        let mut state = generated();
        for meld in &mut state.players[THREAT_SEAT].melds {
            meld.meld_type = MeldType::Ankan;
        }
        assert!(
            open_hand_defense(&state).is_none(),
            "an ankan is not an open set"
        );
    }
}
