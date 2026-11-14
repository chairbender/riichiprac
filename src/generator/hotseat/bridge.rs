//! Translate a live simulator table into the trainer's [`GameState`] shape.
//!
//! The simulator stores the whole table in absolute seat order (East = 0).
//! A [`GameState`] is always written from the acting seat's perspective, with
//! that seat as `players[0]` and relative winds 0..3. Every river, meld, call
//! source, draw, and decision context is rotated here so the existing encoder,
//! legal-action vocabularies, and frontend keep working unchanged.

use agari::context::WinType;

use crate::ai::actions::winning_hand;
use crate::ai::encoder::tile_index;
use crate::state::{CalledMeld, DecisionContext, GameState, PlayerState, Wind};

use super::sim::{
    DecisionSource, SimTable, base_state, best_post_discard_shanten, compact, ukeire,
};

const SEAT_NAMES: [&str; 4] = ["You", "Shimocha", "Toimen", "Kamicha"];

/// Build the position one seat is deciding in.
pub(crate) fn actor_state(table: &SimTable, seat: usize, source: DecisionSource) -> GameState {
    let player = &table.players[seat];
    let (decision, current_turn, self_turn) = relative_decision(&source, seat);

    let mut hand = player.hand.clone();
    let mut draw = player.draw.clone();

    // A post-call discard turn has no drawn tile, but it does hold one more
    // tile than the resting 13 - 3 * melds. The state keeps that extra tile in
    // the draw slot so the whole hand is discardable; it stays tedashi because
    // the engine knows no tile was actually drawn.
    let synthetic_draw = if self_turn && draw.is_none() && hand.len() == 14 - 3 * player.melds.len()
    {
        hand.pop()
    } else {
        None
    };
    if let Some(tile) = &synthetic_draw {
        draw = Some(tile.clone());
    }

    let melds = player.melds.len();
    let len_div3 = 4u8.saturating_sub(melds as u8);
    let concealed: Vec<String> = hand.iter().chain(draw.iter()).cloned().collect();
    let shanten = if self_turn && synthetic_draw.is_some() {
        best_post_discard_shanten(&concealed, melds)
    } else {
        crate::ai::sp::calc_all(&code_counts(&hand), len_div3)
    };
    let (ukeire_tiles, ukeire_total) = if shanten == 0 {
        ukeire(&hand, melds)
    } else {
        (Vec::new(), 0)
    };

    let tiles: Vec<String> = if self_turn {
        concealed.clone()
    } else {
        hand.clone()
    };
    let hand_string = compact(&tiles);

    let mut players = Vec::with_capacity(4);
    for (index, offset) in (0..4).enumerate() {
        let absolute = (seat + offset) % 4;
        let source_player = &table.players[absolute];
        let (state_hand, state_draw) = if index == 0 {
            (hand.clone(), draw.clone())
        } else {
            (source_player.hand.clone(), source_player.draw.clone())
        };
        players.push(PlayerState {
            seat: index,
            name: SEAT_NAMES[index].to_string(),
            is_human: index == 0,
            wind: source_player.wind,
            score: source_player.score,
            hand: state_hand,
            draw: state_draw,
            red_fives: Vec::new(),
            discards: source_player.discards.clone(),
            melds: source_player
                .melds
                .iter()
                .map(|meld| rotate_meld(meld, seat))
                .collect(),
            is_riichi: source_player.is_riichi,
            riichi_discard_index: source_player.riichi_discard_index,
        });
    }

    let is_agari =
        self_turn && synthetic_draw.is_none() && is_tsumo_win(table.round_wind, &players[0]);

    let mut state = base_state(
        "hotseat_pending",
        Some(table.conditions.note()),
        table.round_wind,
        table.hand_number,
        table.honba,
        table.riichi_sticks,
        table.wall.len() as u8,
        table.dora_indicators.clone(),
        table.ura_dora_indicators.clone(),
        players,
        decision,
        current_turn,
        shanten,
        is_agari,
        tiles,
        hand_string,
        ukeire_tiles,
        ukeire_total,
    );
    state.can_riichi = false;
    state
}

/// Rotate a called meld's source seat into the acting seat's frame.
fn rotate_meld(meld: &CalledMeld, actor: usize) -> CalledMeld {
    CalledMeld {
        meld_type: meld.meld_type,
        tiles: meld.tiles.clone(),
        called_from: meld.called_from.map(|from| (from + 4 - actor) % 4),
    }
}

/// The decision context, the state's `current_turn`, and whether this is the
/// seat's own turn.
fn relative_decision(source: &DecisionSource, actor: usize) -> (DecisionContext, usize, bool) {
    match source {
        DecisionSource::SelfTurn => (DecisionContext::SelfTurn, 0, true),
        DecisionSource::React { from, tile } => {
            let relative = (from + 4 - actor) % 4;
            (
                DecisionContext::ReactToDiscard {
                    from: relative,
                    tile: tile.clone(),
                },
                relative,
                false,
            )
        }
        DecisionSource::ReactKan { from, tile } => {
            let relative = (from + 4 - actor) % 4;
            (
                DecisionContext::ReactToKan {
                    from: relative,
                    tile: tile.clone(),
                },
                relative,
                false,
            )
        }
    }
}

/// Whether the player's draw completes a legal, yaku-bearing tsumo.
pub(crate) fn is_tsumo_win(round_wind: Wind, player: &PlayerState) -> bool {
    let Some(draw) = player.draw.as_deref() else {
        return false;
    };
    winning_hand(
        round_wind,
        player.wind,
        &player.hand,
        &player.melds,
        draw,
        WinType::Tsumo,
        player.is_riichi,
    )
}

/// A 34-entry count vector from tile codes.
pub(crate) fn code_counts(codes: &[String]) -> [u8; 34] {
    let mut counts = [0u8; 34];
    for code in codes {
        if let Some(index) = tile_index(code) {
            counts[index] = counts[index].saturating_add(1);
        }
    }
    counts
}
