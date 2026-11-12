//! Final guard: a generated table must be a legal, reachable Mahjong position.
//!
//! Lesson generators decide the hand, the calls, and the rivers separately, so
//! nothing stopped a state from showing, say, six discards for one player and
//! three for everyone else with no calls to explain the gap. Such a table can
//! never come out of a real game, and it is confusing to practice against.
//!
//! This module reconstructs what the table would have had to look like:
//!
//! - every player holds `13 - 3 * melds` concealed tiles (the draw adds one),
//!   because a kan's fourth tile is the replacement draw, not an extra turn;
//! - each meld is a real shape (sequence, triplet, or quad) called by a seat
//!   that could legally have discarded it, and that seat's river shows the
//!   discard: a call consumes a discard, so a meld with nothing behind it could
//!   never have happened;
//! - the rivers are the discards of *one* turn order: the walk starts at the
//!   dealer, visits one seat per discard, and can only leave the rotation when
//!   a player calls on the discard that just happened. Calls claimed from the
//!   previous seat in the rotation are indistinguishable from a natural turn,
//!   so only out-of-rotation calls can move the walk;
//! - the state's decision context fixes which discard came last: a self turn
//!   means the human has just drawn after Kamicha (seat 3) discarded, and a
//!   reaction means the source has just discarded (or, for a chankan, has just
//!   drawn after Kamicha).
//!
//! [`river_counts`] builds the generation-side timeline that this check
//! accepts, so generators should plan rivers with it rather than pick a
//! discard count per seat.

use std::collections::{HashMap, HashSet};

use crate::generator::support::table::{dealer_seat, is_out_of_rotation_call};
use crate::state::{CalledMeld, DecisionContext, GameState, MeldType};

/// Upper bound on the reachability search. Reachable tables are found on the
/// first attempt; this only protects against pathological rejects.
const MAX_SEARCH_STATES: usize = 250_000;

/// Validates one generated table against the rules of a reachable position.
pub fn validate_reachable_state(state: &GameState) -> Result<(), String> {
    validate_table_shape(state)?;
    validate_player_tiles(state)?;
    validate_melds(state)?;
    validate_meld_claims(state)?;
    validate_decision_placement(state)?;
    validate_discard_timeline(state)
}

/// Four seats in order, winds rotating from seat 0.
fn validate_table_shape(state: &GameState) -> Result<(), String> {
    if state.players.len() != 4 {
        return Err(format!(
            "table has {} players, expected four",
            state.players.len()
        ));
    }
    for (index, player) in state.players.iter().enumerate() {
        if player.seat != index {
            return Err(format!(
                "player at index {index} reports seat {}",
                player.seat
            ));
        }
        let expected = state.players[0].wind.next(index);
        if player.wind != expected {
            return Err(format!(
                "seat {index} has wind {:?}, expected {:?} from seat 0's {:?}",
                player.wind, expected, state.players[0].wind
            ));
        }
    }
    Ok(())
}

/// Each player holds the concealed count its meld count implies, and a Riichi
/// declaration points at a real river entry.
fn validate_player_tiles(state: &GameState) -> Result<(), String> {
    for player in &state.players {
        let expected = 13usize.saturating_sub(3 * player.melds.len());
        if player.hand.len() != expected {
            return Err(format!(
                "seat {} holds {} concealed tiles with {} melds, expected {expected}",
                player.seat,
                player.hand.len(),
                player.melds.len()
            ));
        }

        if player.is_riichi {
            let Some(index) = player.riichi_discard_index else {
                return Err(format!(
                    "seat {} declares Riichi without a declaration discard",
                    player.seat
                ));
            };
            let Some(discard) = player.discards.get(index) else {
                return Err(format!(
                    "seat {} declares Riichi at discard {index} of {}",
                    player.seat,
                    player.discards.len()
                ));
            };
            if !discard.is_riichi {
                return Err(format!(
                    "seat {} Riichi discard {index} is not marked as the declaration",
                    player.seat
                ));
            }
        }
    }
    Ok(())
}

/// Every meld is a concrete, legally called shape.
fn validate_melds(state: &GameState) -> Result<(), String> {
    for player in &state.players {
        if player.melds.len() > 4 {
            return Err(format!(
                "seat {} has {} melds",
                player.seat,
                player.melds.len()
            ));
        }

        let previous = (player.seat + 3) % 4;
        for meld in &player.melds {
            if let Some(from) = meld.called_from {
                if from >= state.players.len() {
                    return Err(format!("meld called from invalid seat {from}"));
                }
                if from == player.seat {
                    return Err(format!("seat {} called its own discard", player.seat));
                }
            }

            match meld.meld_type {
                MeldType::Chi => {
                    if meld.tiles.len() != 3 {
                        return Err(format!(
                            "chi at seat {} has {} tiles",
                            player.seat,
                            meld.tiles.len()
                        ));
                    }
                    if !same_suit_run(&meld.tiles) {
                        return Err(format!(
                            "chi at seat {} is not a run: {:?}",
                            player.seat, meld.tiles
                        ));
                    }
                    // A chi can only claim the previous seat's discard.
                    if meld.called_from != Some(previous) {
                        return Err(format!(
                            "chi at seat {} claims seat {:?}, expected {previous}",
                            player.seat, meld.called_from
                        ));
                    }
                }
                MeldType::Pon => {
                    if meld.tiles.len() != 3 || !all_same(&meld.tiles) {
                        return Err(format!(
                            "pon at seat {} is not three of a kind: {:?}",
                            player.seat, meld.tiles
                        ));
                    }
                    if meld.called_from.is_none() {
                        return Err(format!("pon at seat {} has no source", player.seat));
                    }
                }
                MeldType::Kan => {
                    if meld.tiles.len() != 4 || !all_same(&meld.tiles) {
                        return Err(format!(
                            "open kan at seat {} is not four of a kind: {:?}",
                            player.seat, meld.tiles
                        ));
                    }
                    if meld.called_from.is_none() {
                        return Err(format!("open kan at seat {} has no source", player.seat));
                    }
                }
                MeldType::Ankan => {
                    if meld.tiles.len() != 4 || !all_same(&meld.tiles) {
                        return Err(format!(
                            "closed kan at seat {} is not four of a kind: {:?}",
                            player.seat, meld.tiles
                        ));
                    }
                    if meld.called_from.is_some() {
                        return Err(format!("closed kan at seat {} names a source", player.seat));
                    }
                }
            }
        }
    }
    Ok(())
}

fn all_same(tiles: &[String]) -> bool {
    tiles.windows(2).all(|pair| pair[0] == pair[1])
}

/// Every open meld must name a seat whose river shows the discard it claimed.
///
/// A call moves a tile from one player's river into the caller's meld, and the
/// state keeps the discard that produced it: [`super::table::RiverPlan`] sizes
/// the rivers with the call consumed, and the tenhou.net/6 exporter looks for
/// the claim in the source's river. A meld whose source never discarded the tile
/// therefore has no discard behind it at all. The reported
/// `open_hand_defense` board showed a Pon of 7z claimed from a seat whose five
/// discards were `2z 7m 2s 5z 3s`: the call was invented, not played.
///
/// Two calls on one seat need two discards, so claims are matched to distinct
/// river entries.
///
/// One shape cannot show a witness: when the caller's own meld and concealed
/// hand already use all four copies of the claimed kind, there is no spare copy
/// left to be a discarded tile, so the claimed tile must be one of the meld's
/// own. That is the added kan (a Pon plus the drawn fourth tile) and the open
/// kan. Those boards are accepted without a witness.
fn validate_meld_claims(state: &GameState) -> Result<(), String> {
    for (source, player) in state.players.iter().enumerate() {
        // Claims this seat has to answer for: (claiming seat, claimable tiles).
        let mut claims: Vec<(usize, Vec<&str>)> = Vec::new();
        for caller in &state.players {
            let held = copies_held_by(caller);
            for meld in &caller.melds {
                if meld.called_from != Some(source) {
                    continue;
                }
                let claimable = claimable_tiles(meld);
                if claimable.is_empty() {
                    return Err(format!(
                        "seat {} has an empty {:?} meld",
                        caller.seat, meld.meld_type
                    ));
                }
                if claimable
                    .iter()
                    .all(|tile| held.get(tile).copied().unwrap_or(0) >= 4)
                {
                    continue;
                }
                claims.push((caller.seat, claimable));
            }
        }
        if claims.is_empty() {
            continue;
        }

        let river: Vec<&str> = player
            .discards
            .iter()
            .map(|discard| discard.tile.as_str())
            .collect();
        let mut used = vec![false; river.len()];
        if !assign_claims(&claims, &river, &mut used, 0) {
            let wanted: Vec<String> = claims
                .iter()
                .map(|(seat, tiles)| format!("seat {seat} claims {tiles:?}"))
                .collect();
            return Err(format!(
                "seat {source}'s river {river:?} cannot back every call on it: {}",
                wanted.join(", ")
            ));
        }
    }

    Ok(())
}

/// The kinds a meld could have taken off another seat's discard.
fn claimable_tiles(meld: &CalledMeld) -> Vec<&str> {
    let mut claimable: Vec<&str> = match meld.meld_type {
        // Any tile of the run can be the claimed one.
        MeldType::Chi => meld.tiles.iter().map(String::as_str).collect(),
        MeldType::Pon | MeldType::Kan => meld
            .tiles
            .first()
            .map(|tile| vec![tile.as_str()])
            .unwrap_or_default(),
        MeldType::Ankan => Vec::new(),
    };
    claimable.sort_unstable();
    claimable.dedup();
    claimable
}

/// How many copies of each kind the player's own melds, hand and draw hold.
fn copies_held_by(player: &crate::state::PlayerState) -> HashMap<&str, usize> {
    let mut held: HashMap<&str, usize> = HashMap::new();
    let tiles = player
        .melds
        .iter()
        .flat_map(|meld| meld.tiles.iter())
        .chain(player.hand.iter())
        .chain(player.draw.iter());
    for tile in tiles {
        *held.entry(tile.as_str()).or_default() += 1;
    }
    held
}

/// Matches every claim to a distinct river entry of a kind it could claim.
fn assign_claims(
    claims: &[(usize, Vec<&str>)],
    river: &[&str],
    used: &mut [bool],
    index: usize,
) -> bool {
    if index == claims.len() {
        return true;
    }
    for slot in 0..river.len() {
        if used[slot] || !claims[index].1.contains(&river[slot]) {
            continue;
        }
        used[slot] = true;
        if assign_claims(claims, river, used, index + 1) {
            return true;
        }
        used[slot] = false;
    }
    false
}

fn same_suit_run(tiles: &[String]) -> bool {
    let mut values = Vec::with_capacity(tiles.len());
    let mut suit = None;
    for code in tiles {
        let Some((number, tile_suit)) = parse_number_and_suit(code) else {
            return false;
        };
        if let Some(known) = suit
            && known != tile_suit
        {
            return false;
        }
        suit = Some(tile_suit);
        values.push(number);
    }
    values.sort_unstable();
    values.windows(2).all(|pair| pair[1] == pair[0] + 1)
}

/// Splits a suited tile code (`2s`) into its number and suit letter.
fn parse_number_and_suit(code: &str) -> Option<(u8, char)> {
    let mut chars = code.chars();
    let number = chars.next()?.to_digit(10)?;
    let suit = chars.next()?;
    if !matches!(suit, 'm' | 'p' | 's') || chars.next().is_some() {
        return None;
    }
    Some((number as u8, suit))
}

/// The draw and the source of a reaction line up with the decision context.
fn validate_decision_placement(state: &GameState) -> Result<(), String> {
    let drawn: Vec<usize> = state
        .players
        .iter()
        .filter(|player| player.draw.is_some())
        .map(|player| player.seat)
        .collect();

    match &state.decision {
        DecisionContext::SelfTurn => {
            if state.current_turn != 0 {
                return Err(format!("self turn has current_turn {}", state.current_turn));
            }
            if drawn != [0] {
                return Err(format!(
                    "self turn must draw for the human only, got seats {drawn:?}"
                ));
            }
        }
        DecisionContext::ReactToDiscard { from, tile } => {
            if !drawn.is_empty() {
                return Err(format!("reaction has an active draw at seats {drawn:?}"));
            }
            validate_reaction_source(state, *from, tile, false)?;
        }
        DecisionContext::ReactToKan { from, tile } => {
            if !drawn.is_empty() {
                return Err(format!(
                    "kan reaction has an active draw at seats {drawn:?}"
                ));
            }
            validate_reaction_source(state, *from, tile, true)?;
        }
    }
    Ok(())
}

fn validate_reaction_source(
    state: &GameState,
    from: usize,
    tile: &str,
    chankan: bool,
) -> Result<(), String> {
    if from == 0 || from >= state.players.len() {
        return Err(format!("reaction source seat {from} is invalid"));
    }
    if state.current_turn != from {
        return Err(format!(
            "reaction current_turn {} does not match source {from}",
            state.current_turn
        ));
    }
    let source = &state.players[from];
    if chankan {
        let has_kan = source.melds.iter().any(|meld| {
            meld.meld_type == MeldType::Kan
                && meld.tiles.len() == 4
                && meld.tiles.iter().all(|held| held == tile)
        });
        if !has_kan {
            return Err(format!(
                "reaction source {from} has no four-tile kan of {tile}"
            ));
        }
    } else if source.discards.last().map(|discard| discard.tile.as_str()) != Some(tile) {
        return Err(format!(
            "reaction source {from} did not just discard {tile}"
        ));
    }
    Ok(())
}

/// The rivers must be the discards of one legal turn order.
fn validate_discard_timeline(state: &GameState) -> Result<(), String> {
    let counts: [usize; 4] = state
        .players
        .iter()
        .map(|player| player.discards.len())
        .collect::<Vec<_>>()
        .try_into()
        .map_err(|_| "table does not have four rivers".to_string())?;

    // An out-of-rotation call is the only thing that lets the walk skip a seat.
    let mut calls = [[0u8; 4]; 4];
    for player in &state.players {
        for meld in &player.melds {
            let Some(from) = meld.called_from else {
                continue;
            };
            if is_out_of_rotation_call(player.seat, meld) {
                calls[player.seat][from] = calls[player.seat][from].saturating_add(1);
            }
        }
    }

    let dealer = dealer_seat(state.players[0].wind);
    let last = last_discarder(state)?;

    let total: usize = counts.iter().sum();
    if total == 0 {
        // Only the opening draw is discard-free, and only the dealer takes it.
        if !matches!(state.decision, DecisionContext::SelfTurn) {
            return Err("a reaction cannot happen before the first discard".to_string());
        }
        if dealer != 0 {
            return Err(format!(
                "the first turn belongs to the dealer (seat {dealer}), not the human"
            ));
        }
        return Ok(());
    }

    if counts[dealer] == 0 {
        return Err(format!(
            "the dealer (seat {dealer}) has no discards but the hand is in progress"
        ));
    }

    let mut remaining: [u8; 4] = counts.map(|count| count as u8);
    remaining[dealer] -= 1;

    let mut search = TimelineSearch {
        remaining,
        calls,
        last,
        seen: HashSet::new(),
        visited: 0,
    };
    match search.walk(dealer)? {
        true => Ok(()),
        false => Err(format!(
            "rivers {counts:?} cannot be reached from dealer {dealer} ending on seat {last}"
        )),
    }
}

/// Which seat made the last discard, given the decision being presented.
fn last_discarder(state: &GameState) -> Result<usize, String> {
    match &state.decision {
        // The human only draws at the start of a natural turn, which follows
        // Kamicha's discard.
        DecisionContext::SelfTurn => Ok(3),
        DecisionContext::ReactToDiscard { from, .. } => Ok(*from),
        // A chankan happens after the kan player draws, which follows their
        // own Kamicha's discard.
        DecisionContext::ReactToKan { from, .. } => Ok((from + 3) % 4),
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct SearchKey {
    remaining: [u8; 4],
    calls: [[u8; 4]; 4],
    current: u8,
}

struct TimelineSearch {
    remaining: [u8; 4],
    calls: [[u8; 4]; 4],
    last: usize,
    seen: HashSet<SearchKey>,
    visited: usize,
}

impl TimelineSearch {
    fn walk(&mut self, current: usize) -> Result<bool, String> {
        if self.remaining.iter().all(|&count| count == 0) {
            return Ok(current == self.last);
        }

        let key = SearchKey {
            remaining: self.remaining,
            calls: self.calls,
            current: current as u8,
        };
        if !self.seen.insert(key) {
            return Ok(false);
        }
        self.visited += 1;
        if self.visited > MAX_SEARCH_STATES {
            return Err("discard reachability search exceeded its bound".to_string());
        }

        for step in 1..=3usize {
            let next = (current + step) % 4;
            if self.remaining[next] == 0 {
                continue;
            }

            // Leaving the rotation needs a call from the seat that just
            // discarded, and that call cannot have been made before.
            if step > 1 {
                if self.calls[next][current] == 0 {
                    continue;
                }
                self.calls[next][current] -= 1;
            }
            self.remaining[next] -= 1;

            let found = self.walk(next)?;

            self.remaining[next] += 1;
            if step > 1 {
                self.calls[next][current] += 1;
            }
            if found {
                return Ok(true);
            }
        }

        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generator::support::table::{dealer_seat, river_counts, self_turn_river_plan};
    use crate::state::{CalledMeld, DiscardTile, PlayerState, Wind};

    fn player(seat: usize, wind: Wind, discards: usize) -> PlayerState {
        PlayerState {
            seat,
            name: format!("seat {seat}"),
            is_human: seat == 0,
            wind,
            score: 25_000,
            hand: vec!["1m".to_string(); 13],
            draw: None,
            red_fives: Vec::new(),
            discards: vec![DiscardTile::new("9p"); discards],
            melds: Vec::new(),
            is_riichi: false,
            riichi_discard_index: None,
        }
    }

    fn self_turn_state(human_wind: Wind, counts: [usize; 4]) -> GameState {
        let mut players: Vec<PlayerState> = (0..4)
            .map(|seat| player(seat, human_wind.next(seat), counts[seat]))
            .collect();
        players[0].hand = vec!["1m".to_string(); 13];
        players[0].draw = Some("2p".to_string());
        GameState {
            category: "test".to_string(),
            target_action: crate::state::TargetAction::NaniKiru,
            correct_action: crate::state::CorrectAction::dama("2p"),
            equivalent_tiles: Vec::new(),
            decision: DecisionContext::SelfTurn,
            scenario_note: None,
            call_offer: None,
            ai_decision: None,
            riichi_triggers: Vec::new(),
            dama_reasons: Vec::new(),
            shouminkan_triggers: Vec::new(),
            book_rationale: None,
            can_riichi: false,
            hand_string: String::new(),
            tiles: vec!["1m".to_string(); 13]
                .into_iter()
                .chain(std::iter::once("2p".to_string()))
                .collect(),
            shanten: 1,
            is_agari: false,
            decompositions_count: 0,
            ukeire_tiles: Vec::new(),
            ukeire_total: 0,
            round_wind: Wind::East,
            hand_number: 1,
            honba: 0,
            riichi_sticks: 0,
            dora_indicators: Vec::new(),
            ura_dora_indicators: Vec::new(),
            tiles_remaining: 60,
            current_turn: 0,
            players,
        }
    }

    #[test]
    fn planned_self_turn_rivers_are_reachable_for_every_wind() {
        for wind in Wind::ALL {
            for min in [0, 1, 4, 9, 13] {
                let counts = self_turn_river_plan(wind, &[], min).counts;
                let state = self_turn_state(wind, counts);
                validate_reachable_state(&state).unwrap_or_else(|err| {
                    panic!("wind {wind:?} min {min} counts {counts:?}: {err}")
                });
            }
        }
    }

    #[test]
    fn planned_call_rivers_are_reachable() {
        for wind in Wind::ALL {
            let counts = self_turn_river_plan(wind, &[(0, 1)], 3).counts;
            let mut state = self_turn_state(wind, counts);
            state.players[0].hand = vec!["1m".to_string(); 10];
            state.players[0].melds = vec![CalledMeld {
                meld_type: MeldType::Pon,
                tiles: vec!["5z".to_string(); 3],
                called_from: Some(1),
            }];
            // The claim needs a discard behind it: seat 1's river shows the 5z.
            let last = state.players[1].discards.len() - 1;
            state.players[1].discards[last] = DiscardTile::new("5z");
            validate_reachable_state(&state)
                .unwrap_or_else(|err| panic!("wind {wind:?} counts {counts:?}: {err}"));
        }
    }

    #[test]
    fn a_call_with_no_discard_behind_it_is_rejected() {
        // The reported `open_hand_defense` shape: a Pon of 5z "claimed" from a
        // seat that never discarded one.
        let counts = self_turn_river_plan(Wind::East, &[(0, 1)], 3).counts;
        let mut state = self_turn_state(Wind::East, counts);
        state.players[0].hand = vec!["1m".to_string(); 10];
        state.players[0].melds = vec![CalledMeld {
            meld_type: MeldType::Pon,
            tiles: vec!["5z".to_string(); 3],
            called_from: Some(1),
        }];
        let err = validate_reachable_state(&state).expect_err("the call must be rejected");
        assert!(err.contains("cannot back every call"), "{err}");
    }

    /// The exact reported board: Kamicha (seat 3, South) holds a Pon of 7z and
    /// two chiis, all claimed from Toimen (seat 2, East), whose river was
    /// `2z 7m 2s 5z 3s`. Only the `1s2s3s` chii had a discard to claim.
    #[test]
    fn the_reported_open_hand_board_is_rejected() {
        let mut state = self_turn_state(Wind::West, [4, 4, 5, 5]);
        state.players[0].discards = discards(&["4s", "6p", "4p", "2p"]);
        state.players[1].discards = discards(&["9m", "2s", "6s", "5z"]);
        state.players[2].discards = discards(&["2z", "7m", "2s", "5z", "3s"]);
        state.players[3].discards = discards(&["9m", "4s", "9p", "3s", "6m"]);
        state.players[3].hand = ["2m", "2m", "8m", "9m"]
            .into_iter()
            .map(str::to_string)
            .collect();
        state.players[3].melds = vec![
            CalledMeld {
                meld_type: MeldType::Pon,
                tiles: vec!["7z".to_string(); 3],
                called_from: Some(2),
            },
            CalledMeld {
                meld_type: MeldType::Chi,
                tiles: vec!["1s".to_string(), "2s".to_string(), "3s".to_string()],
                called_from: Some(2),
            },
            CalledMeld {
                meld_type: MeldType::Chi,
                tiles: vec!["7p".to_string(), "8p".to_string(), "9p".to_string()],
                called_from: Some(2),
            },
        ];

        let err =
            validate_reachable_state(&state).expect_err("the reported board must be rejected");
        assert!(err.contains("cannot back every call"), "{err}");
    }

    /// The river of a seat, all tedashi.
    fn discards(tiles: &[&str]) -> Vec<DiscardTile> {
        tiles.iter().map(|tile| DiscardTile::new(*tile)).collect()
    }

    #[test]
    fn two_calls_on_one_seat_need_two_discards() {
        let counts = self_turn_river_plan(Wind::East, &[(0, 1), (0, 1)], 3).counts;
        let mut state = self_turn_state(Wind::East, counts);
        state.players[0].hand = vec!["1m".to_string(); 7];
        state.players[0].melds = vec![
            CalledMeld {
                meld_type: MeldType::Pon,
                tiles: vec!["5z".to_string(); 3],
                called_from: Some(1),
            },
            CalledMeld {
                meld_type: MeldType::Pon,
                tiles: vec!["6z".to_string(); 3],
                called_from: Some(1),
            },
        ];

        // One 5z and one 6z in the river backs both calls.
        let last = state.players[1].discards.len() - 1;
        state.players[1].discards[last] = DiscardTile::new("5z");
        state.players[1].discards[last - 1] = DiscardTile::new("6z");
        validate_reachable_state(&state).expect("both calls have a discard");

        // A single 5z cannot serve both claims.
        state.players[1].discards[last - 1] = DiscardTile::new("9p");
        let err = validate_reachable_state(&state).expect_err("the second call is unbacked");
        assert!(err.contains("cannot back every call"), "{err}");
    }

    #[test]
    fn a_call_the_callers_own_tiles_add_up_to_is_accepted() {
        // An added kan: the Pon holds three copies and the caller holds the
        // fourth, so no spare copy exists to be a witness discard.
        let counts = self_turn_river_plan(Wind::East, &[(0, 1)], 3).counts;
        let mut state = self_turn_state(Wind::East, counts);
        state.players[0].hand = vec!["1m".to_string(); 10];
        state.players[0].draw = Some("5z".to_string());
        state.players[0].melds = vec![CalledMeld {
            meld_type: MeldType::Pon,
            tiles: vec!["5z".to_string(); 3],
            called_from: Some(1),
        }];
        validate_reachable_state(&state)
            .expect("the fourth copy is in the caller's own hand, so there is no witness");
    }

    #[test]
    fn too_many_discards_without_calls_are_rejected() {
        // The reported bug: the human river is double the others with no call
        // to explain it.
        let mut state = self_turn_state(Wind::East, [3, 3, 3, 3]);
        state.players[0].discards = vec![DiscardTile::new("9p"); 6];
        let err = validate_reachable_state(&state).expect_err("state must be rejected");
        assert!(err.contains("cannot be reached"), "{err}");
    }

    #[test]
    fn reported_wind_and_counts_are_rejected() {
        // Same defect from the report: the human sits West with six discards
        // while everyone else has three.
        let mut state = self_turn_state(Wind::West, [3, 3, 3, 3]);
        state.players[0].discards = vec![DiscardTile::new("9p"); 6];
        assert!(validate_reachable_state(&state).is_err());
    }

    #[test]
    fn natural_counts_for_a_non_dealer_human_are_accepted() {
        for wind in [Wind::South, Wind::West, Wind::North] {
            let counts = river_counts(dealer_seat(wind), 3, &[], 4);
            validate_reachable_state(&self_turn_state(wind, counts))
                .unwrap_or_else(|err| panic!("wind {wind:?}: {err}"));
        }
    }

    #[test]
    fn a_meld_that_breaks_the_tile_count_is_rejected() {
        let counts = self_turn_river_plan(Wind::East, &[(0, 1)], 3).counts;
        let mut state = self_turn_state(Wind::East, counts);
        state.players[0].melds = vec![CalledMeld {
            meld_type: MeldType::Pon,
            tiles: vec!["5z".to_string(); 3],
            called_from: Some(1),
        }];
        // Hand still has 13 tiles: one meld means ten.
        let err = validate_reachable_state(&state).expect_err("state must be rejected");
        assert!(err.contains("concealed tiles"), "{err}");
    }

    #[test]
    fn a_chi_from_the_wrong_seat_is_rejected() {
        let counts = self_turn_river_plan(Wind::East, &[], 3).counts;
        let mut state = self_turn_state(Wind::East, counts);
        state.players[1].hand = vec!["1m".to_string(); 10];
        state.players[1].melds = vec![CalledMeld {
            meld_type: MeldType::Chi,
            tiles: vec!["2s".to_string(), "3s".to_string(), "4s".to_string()],
            called_from: Some(2),
        }];
        let err = validate_reachable_state(&state).expect_err("state must be rejected");
        assert!(err.contains("chi"), "{err}");
    }

    #[test]
    fn the_opening_draw_is_allowed_for_the_dealer_only() {
        let mut state = self_turn_state(Wind::East, [0; 4]);
        validate_reachable_state(&state).expect("dealer opening draw");

        state = self_turn_state(Wind::South, [0; 4]);
        assert!(validate_reachable_state(&state).is_err());
    }
}
