//! Applying one relabelling step to a [`GameState`].
//!
//! The state is the app's whole table payload, so "complete field coverage"
//! means every field that names a seat, a tile or a wind is rewritten here:
//!
//! | Field group | Seat perm | Kind map | Wind relabel | Red-five normalise |
//! | --- | --- | --- | --- | --- |
//! | `players[]` hand, draw, rivers, melds, red fives | moves with the player | codes relabelled | wind honours relabelled | aka flags cleared |
//! | `players[].scores`, `is_riichi`, `riichi_discard_index` | moves with the player | — | — | — |
//! | `players[].wind` | becomes the destination seat's wind | — | rotated | — |
//! | `players[].melds[].called_from`, `current_turn`, `decision.from` | remapped | — | — | — |
//! | `dora_indicators`, `ura_dora_indicators` | — | relabelled | wind indicators rotated | — |
//! | `hand_string`, `tiles`, `ukeire_tiles` | — | rebuilt | rebuilt | — |
//! | `correct_action`, `equivalent_tiles`, `call_offer` | — | relabelled | relabelled | refused if red |
//! | `decision.tile` | — | relabelled | relabelled | — |
//! | `ai_decision` (recommendation, ranking, labels) | — | relabelled | relabelled | refused if red |
//! | `scenario_note` | — | tokens relabelled | tokens relabelled | — |
//! | `round_wind` | — | — | rotated | — |
//!
//! Deliberately untouched: `book_rationale` (derived text the gate recomputes
//! through `finalize_state`; its book quotations must stay verbatim), `category`
//! (a lesson id), and every score/board field §4.3 lists as not transformed.
//! Derived hand metrics (shanten, agari, decomposition count, ukeire total) stay
//! correct because every kind map here is a bijection on the 34 kinds.

use serde::{Deserialize, Serialize};

use crate::ai::encoder::tile_index;
use crate::decision::AiDecision;
use crate::state::{DecisionContext, GameState, MeldType, SEAT_NAMES};

use super::TransformError;
use super::mapping::Mapping;
use super::seat::SeatPerm;

/// One red five whose aka identity a `red5_normalize` step cleared.
///
/// The record is the inverse mapping for the one transform that is not
/// information-preserving on its own: a normalised five looks exactly like a
/// plain five, so only the slot list can put the red copy back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "where", rename_all = "snake_case")]
pub enum RedFiveSlot {
    /// A red five among the player's concealed hand or active draw.
    Concealed { player: usize, tile: String },
    /// A red five in the player's river at `index`.
    River {
        player: usize,
        index: usize,
        tile: String,
    },
}

/// Apply one mapping step to a table.
///
/// Fails closed on a table that is not four seats, a seat index outside the
/// table, or a tile string that is not an app code.
pub(crate) fn apply_mapping(
    state: &mut GameState,
    mapping: &Mapping,
) -> Result<(), TransformError> {
    if state.players.len() != 4 {
        return Err(TransformError::TableShape {
            players: state.players.len(),
        });
    }
    if !mapping.seat.is_identity() {
        permute_players(state, mapping.seat)?;
    }
    if !mapping.kinds.is_identity() {
        map_tiles(state, mapping)?;
    }
    if mapping.wind_steps != 0 {
        let steps = usize::from(mapping.wind_steps % 4);
        state.round_wind = state.round_wind.next(steps);
        for player in &mut state.players {
            player.wind = player.wind.next(steps);
        }
    }
    Ok(())
}

/// Rotate the four players, their references and the turn pointer.
///
/// A seat wind belongs to the **seat**, not to the player, so a permuted player
/// takes the destination seat's wind: after the permutation the table still runs
/// East, South, West, North from seat 0, exactly as every other state does. (A
/// player whose old seat wind travelled with them would leave the table with
/// winds out of order, which no legal position has and
/// `validate_reachable_state` rejects.) Moving the wind *labels* is what the
/// separate `wind_relabel` transform is for.
fn permute_players(state: &mut GameState, seat: SeatPerm) -> Result<(), TransformError> {
    let actor_wind = state.players[0].wind;
    for (index, player) in state.players.iter().enumerate() {
        if player.wind != actor_wind.next(index) {
            return Err(TransformError::WindOrder { seat: index });
        }
    }

    let old = std::mem::take(&mut state.players);
    let mut players = Vec::with_capacity(4);
    for new_seat in 0..4 {
        let mut player = old[seat.source(new_seat)].clone();
        player.seat = new_seat;
        player.name = SEAT_NAMES[new_seat].to_string();
        player.is_human = new_seat == 0;
        player.wind = actor_wind.next(new_seat);
        for meld in &mut player.melds {
            if let Some(from) = meld.called_from {
                meld.called_from = Some(mapped_seat(seat, from)?);
            }
        }
        players.push(player);
    }
    state.players = players;
    state.current_turn = mapped_seat(seat, state.current_turn)?;

    let decision = std::mem::take(&mut state.decision);
    state.decision = match decision {
        DecisionContext::SelfTurn => DecisionContext::SelfTurn,
        DecisionContext::ReactToDiscard { from, tile } => DecisionContext::ReactToDiscard {
            from: mapped_seat(seat, from)?,
            tile,
        },
        DecisionContext::ReactToKan { from, tile } => DecisionContext::ReactToKan {
            from: mapped_seat(seat, from)?,
            tile,
        },
    };
    Ok(())
}

/// Where an old seat sits after the permutation, refusing an out-of-table seat.
fn mapped_seat(seat: SeatPerm, index: usize) -> Result<usize, TransformError> {
    if index >= 4 {
        return Err(TransformError::InvalidSeat { seat: index });
    }
    Ok(seat.dest(index))
}

/// Relabel every tile-bearing field of the table.
fn map_tiles(state: &mut GameState, mapping: &Mapping) -> Result<(), TransformError> {
    for player in &mut state.players {
        mapping.map_codes(&mut player.hand)?;
        if let Some(draw) = &mut player.draw {
            *draw = mapping.map_code(draw)?;
        }
        mapping.map_codes(&mut player.red_fives)?;
        for discard in &mut player.discards {
            discard.tile = mapping.map_code(&discard.tile)?;
        }
        for meld in &mut player.melds {
            mapping.map_codes(&mut meld.tiles)?;
        }
    }

    mapping.map_codes(&mut state.dora_indicators)?;
    mapping.map_codes(&mut state.ura_dora_indicators)?;
    mapping.map_codes(&mut state.tiles)?;
    sort_codes(&mut state.tiles);
    mapping.map_codes(&mut state.ukeire_tiles)?;
    sort_codes(&mut state.ukeire_tiles);
    state.hand_string = mapping.map_hand_string(&state.hand_string)?;

    mapping.map_codes(&mut state.equivalent_tiles)?;
    state.correct_action = mapping.map_correct_action(&state.correct_action)?;
    if let Some(offer) = &mut state.call_offer {
        offer.tile = mapping.map_code(&offer.tile)?;
        mapping.map_codes(&mut offer.tiles)?;
        offer.label = mapping.map_text(&offer.label);
    }
    if let Some(note) = &mut state.scenario_note {
        *note = mapping.map_text(note);
    }
    match &mut state.decision {
        DecisionContext::SelfTurn => {}
        DecisionContext::ReactToDiscard { tile, .. } | DecisionContext::ReactToKan { tile, .. } => {
            *tile = mapping.map_code(tile)?;
        }
    }
    if let Some(ai) = &mut state.ai_decision {
        map_ai_decision(ai, mapping)?;
    }
    Ok(())
}

/// Keep the sorted hand lists in the app's kind order after relabelling.
fn sort_codes(codes: &mut [String]) {
    codes.sort_by_key(|code| tile_index(code).unwrap_or(usize::MAX));
}

/// Relabel the model payload attached to an AI scenario.
fn map_ai_decision(ai: &mut AiDecision, mapping: &Mapping) -> Result<(), TransformError> {
    ai.recommended_action = mapping.map_action_name(&ai.recommended_action)?;
    if let Some(discard) = &ai.riichi_discard {
        ai.riichi_discard = Some(mapping.map_code(discard)?);
    }
    for evaluation in &mut ai.evaluations {
        evaluation.info = mapping.map_action_info(&evaluation.info)?;
    }
    for info in &mut ai.actions {
        *info = mapping.map_action_info(info)?;
    }
    if let Some(reasoning) = &mut ai.reasoning {
        *reasoning = mapping.map_text(reasoning);
    }
    Ok(())
}

/// Clear every aka identity on the table and return the copies that had one.
///
/// A meld tile carries no aka flag in this model, so a red five that was called
/// into a meld has no identity to clear here; the ledger records the limitation.
pub(crate) fn clear_red_fives(state: &mut GameState) -> Vec<RedFiveSlot> {
    let mut slots = Vec::new();
    for (player_index, player) in state.players.iter_mut().enumerate() {
        for tile in std::mem::take(&mut player.red_fives) {
            slots.push(RedFiveSlot::Concealed {
                player: player_index,
                tile,
            });
        }
        for (index, discard) in player.discards.iter_mut().enumerate() {
            if std::mem::take(&mut discard.is_red) {
                slots.push(RedFiveSlot::River {
                    player: player_index,
                    index,
                    tile: discard.tile.clone(),
                });
            }
        }
    }
    slots
}

/// Put the recorded red-five identities back.
pub(crate) fn restore_red_fives(
    state: &mut GameState,
    slots: &[RedFiveSlot],
) -> Result<(), TransformError> {
    for slot in slots {
        match slot {
            RedFiveSlot::Concealed { player, tile } => {
                let seated = state
                    .players
                    .get_mut(*player)
                    .ok_or(TransformError::InvalidSeat { seat: *player })?;
                seated.red_fives.push(tile.clone());
            }
            RedFiveSlot::River {
                player,
                index,
                tile,
            } => {
                let seated = state
                    .players
                    .get_mut(*player)
                    .ok_or(TransformError::InvalidSeat { seat: *player })?;
                let discard =
                    seated
                        .discards
                        .get_mut(*index)
                        .ok_or(TransformError::InvalidRedFiveSlot {
                            player: *player,
                            index: *index,
                            tile: tile.clone(),
                        })?;
                discard.is_red = true;
            }
        }
    }
    Ok(())
}

/// Reject a seat permutation that would break a chi's seating arithmetic.
///
/// A chi may only claim the caller's kamicha (the previous seat), and the
/// validator enforces that on every state the app accepts. Permuting the
/// opponents moves the caller and the source by different amounts unless the
/// permutation happens to preserve their adjacency, so a state with a chi meld
/// (or a chi offer) is only transformable by the permutations that keep it.
pub(crate) fn check_chi_seats(state: &GameState, seat: SeatPerm) -> Result<(), TransformError> {
    if seat.is_identity() {
        return Ok(());
    }
    if state.players.len() != 4 {
        return Err(TransformError::TableShape {
            players: state.players.len(),
        });
    }
    for (caller, player) in state.players.iter().enumerate() {
        for meld in &player.melds {
            if meld.meld_type != MeldType::Chi {
                continue;
            }
            let Some(source) = meld.called_from else {
                continue;
            };
            let new_caller = mapped_seat(seat, caller)?;
            let new_source = mapped_seat(seat, source)?;
            if new_source != (new_caller + 3) % 4 {
                return Err(TransformError::ChiNotFromPreviousSeat {
                    caller: new_caller,
                    from: new_source,
                });
            }
        }
    }

    let offers_chi = state
        .call_offer
        .as_ref()
        .is_some_and(|offer| offer.action == "Chi");
    if offers_chi && let DecisionContext::ReactToDiscard { from, .. } = state.decision {
        let new_from = mapped_seat(seat, from)?;
        if new_from != 3 {
            return Err(TransformError::ChiOfferNotFromKamicha { from: new_from });
        }
    }
    Ok(())
}

/// Reject a red-five normalisation that would have to relabel a red answer.
///
/// `Discard_5mr` means "discard the red copy". Once that copy is plain, the
/// action no longer exists, and its inverse cannot know which plain five used to
/// be red. A variant of such a state must be rejected, not rewrapped: the label
/// has to be re-derived on the transformed table (implementation-plan §4.4), and
/// a red-five-dependent lesson denies the transform outright (§4.5).
pub(crate) fn check_red_five_answers(state: &GameState) -> Result<(), TransformError> {
    let mut actions: Vec<&str> = Vec::new();
    if let crate::state::CorrectAction::Best { action, .. } = &state.correct_action {
        actions.push(action);
    }
    if let Some(ai) = &state.ai_decision {
        actions.push(&ai.recommended_action);
        actions.extend(
            ai.evaluations
                .iter()
                .map(|entry| entry.info.action.as_str()),
        );
        actions.extend(ai.actions.iter().map(|entry| entry.action.as_str()));
    }
    for action in actions {
        if is_red_discard(action) {
            return Err(TransformError::RedFiveAction {
                action: action.to_string(),
            });
        }
    }
    Ok(())
}

/// True for a Mortal discard name carrying the red-five suffix (`Discard_5mr`).
fn is_red_discard(action: &str) -> bool {
    action
        .strip_prefix("Discard_")
        .is_some_and(|rest| rest.ends_with('r'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::miner::transform::mapping::Mapping;
    use crate::miner::transform::seat::SeatPerm;
    use crate::miner::transform::tests::synthetic_state;

    #[test]
    fn a_seat_permutation_moves_players_and_their_references() {
        let state = synthetic_state();
        let seat = SeatPerm::new([2, 3, 1]).expect("permutation");
        let mut out = state.clone();
        apply_mapping(
            &mut out,
            &Mapping {
                seat,
                ..Mapping::identity()
            },
        )
        .expect("applies");

        // New seat 2 held old seat 3.
        assert_eq!(out.players[2].score, state.players[3].score);
        assert_eq!(out.players[2].hand, state.players[3].hand);
        assert_eq!(out.players[2].seat, 2);
        assert_eq!(out.players[2].name, "Toimen");
        assert!(!out.players[2].is_human);
        assert!(out.players[0].is_human);
        // Old seat 3 called from old seat 2, and both move together.
        assert_eq!(out.players[2].melds[0].called_from, Some(1));
        assert_eq!(out.current_turn, seat.dest(state.current_turn));
        match out.decision {
            DecisionContext::ReactToDiscard { from, tile } => {
                assert_eq!(from, seat.dest(1));
                assert_eq!(tile, "5z");
            }
            other => panic!("decision changed shape: {other:?}"),
        }
    }

    #[test]
    fn red_fives_are_recorded_and_restored() {
        let state = synthetic_state();
        let mut out = state.clone();
        let slots = clear_red_fives(&mut out);
        assert!(!slots.is_empty());
        assert!(out.players.iter().all(|player| player.red_fives.is_empty()));

        restore_red_fives(&mut out, &slots).expect("restores");
        assert_eq!(out, state);
    }

    #[test]
    fn a_chi_can_only_survive_a_permutation_that_keeps_its_seat() {
        let state = synthetic_state();
        // Player 3's chi claims seat 2. This permutation sends 3 to 2 and 2 to 1,
        // which is still the previous seat.
        let keeps = SeatPerm::new([2, 3, 1]).expect("permutation");
        check_chi_seats(&state, keeps).expect("a chi from the previous seat survives");
        // This one sends 3 to 1 and 2 to 2, so the chi would claim across.
        let broken = SeatPerm::new([1, 3, 2]).expect("permutation");
        assert!(matches!(
            check_chi_seats(&state, broken),
            Err(TransformError::ChiNotFromPreviousSeat { .. })
        ));
    }
}
