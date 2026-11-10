use std::collections::HashMap;

use crate::ai::actions::legal_actions;
use crate::decision::ActionKind;
use crate::state::{DecisionContext, GameState};

/// Structural checks that run before the model is asked to score a candidate.
#[cfg(test)]
pub fn validate_candidate(state: &GameState) -> Result<(), String> {
    if state.players.len() != 4 {
        return Err("candidate does not have four players".to_string());
    }
    if !state.players[0].is_human {
        return Err("candidate human is not seat zero".to_string());
    }
    if !matches!(state.decision, DecisionContext::SelfTurn) {
        return Err("pure-discard candidate is not a self turn".to_string());
    }

    let human = &state.players[0];
    if human.draw.is_none() {
        return Err("self-turn candidate has no draw".to_string());
    }
    if human.hand.len() + 1 + human.melds.len() * 3 != 14 {
        return Err(format!(
            "self-turn concealed count is {} with {} melds",
            human.hand.len() + 1,
            human.melds.len()
        ));
    }
    if state.shanten < 1 || state.is_agari {
        return Err("pure-discard candidate must not be tenpai or complete".to_string());
    }

    let mut expected = human.hand.clone();
    expected.extend(human.draw.iter().cloned());
    expected.extend(
        human
            .melds
            .iter()
            .flat_map(|meld| meld.tiles.iter().cloned()),
    );
    expected.sort();
    let mut actual = state.tiles.clone();
    actual.sort();
    if actual != expected {
        return Err("displayed tiles do not match the human hand".to_string());
    }

    let actions = legal_actions(state);
    if actions.len() < 2 {
        return Err("candidate has fewer than two legal actions".to_string());
    }
    if actions
        .iter()
        .any(|action| action.kind != ActionKind::Discard)
    {
        return Err("pure-discard candidate offers a non-discard action".to_string());
    }

    validate_tile_ledger(state)?;
    Ok(())
}

/// Structural checks for any self-turn candidate, including Riichi, tsumo, and
/// ankan decisions.
pub fn validate_self_turn_candidate(state: &GameState) -> Result<(), String> {
    if state.players.len() != 4 {
        return Err("candidate does not have four players".to_string());
    }
    if !state.players[0].is_human {
        return Err("candidate human is not seat zero".to_string());
    }
    if !matches!(state.decision, DecisionContext::SelfTurn) {
        return Err("self-turn candidate is not a self turn".to_string());
    }

    let human = &state.players[0];
    if human.draw.is_none() {
        return Err("self-turn candidate has no draw".to_string());
    }
    if human.hand.len() + 1 + human.melds.len() * 3 != 14 {
        return Err(format!(
            "self-turn concealed count is {} with {} melds",
            human.hand.len() + 1,
            human.melds.len()
        ));
    }

    let mut expected = human.hand.clone();
    expected.extend(human.draw.iter().cloned());
    expected.extend(
        human
            .melds
            .iter()
            .flat_map(|meld| meld.tiles.iter().cloned()),
    );
    expected.sort();
    let mut actual = state.tiles.clone();
    actual.sort();
    if actual != expected {
        return Err("displayed tiles do not match the human hand".to_string());
    }

    let actions = legal_actions(state);
    if actions.len() < 2 {
        return Err("candidate has fewer than two legal actions".to_string());
    }
    if actions.iter().any(|action| {
        matches!(
            action.kind,
            ActionKind::Chi | ActionKind::Pon | ActionKind::Pass
        )
    }) {
        return Err("self-turn candidate offers a reaction action".to_string());
    }
    if actions
        .iter()
        .filter(|action| action.kind == ActionKind::Kan)
        .count()
        > 1
    {
        return Err("candidate offers more than one kan choice".to_string());
    }

    validate_tile_ledger(state)?;
    Ok(())
}

/// Structural checks for a reaction candidate.
pub fn validate_reaction_candidate(state: &GameState) -> Result<(), String> {
    if state.players.len() != 4 {
        return Err("reaction candidate does not have four players".to_string());
    }
    if !state.players[0].is_human {
        return Err("reaction human is not seat zero".to_string());
    }
    let (from, tile, chankan) = match &state.decision {
        DecisionContext::ReactToDiscard { from, tile } => (from, tile, false),
        DecisionContext::ReactToKan { from, tile } => (from, tile, true),
        DecisionContext::SelfTurn => {
            return Err("reaction candidate is not a reaction".to_string());
        }
    };
    if *from == 0 || *from > 3 {
        return Err(format!("reaction source seat {from} is invalid"));
    }
    if state.current_turn != *from {
        return Err("reaction current_turn does not match the source seat".to_string());
    }
    let human = &state.players[0];
    if human.draw.is_some() {
        return Err("reaction candidate has an active draw".to_string());
    }
    if !human.melds.is_empty() {
        return Err("v1 reaction candidates use a closed hand".to_string());
    }
    if human.hand.len() != 13 {
        return Err(format!(
            "reaction hand has {} concealed tiles, expected 13",
            human.hand.len()
        ));
    }

    let source = &state.players[*from];
    if chankan {
        let has_kan = source.melds.iter().any(|meld| {
            meld.meld_type == crate::state::MeldType::Kan
                && meld.tiles.len() == 4
                && meld.tiles.iter().all(|held| held == tile)
        });
        if !has_kan {
            return Err(format!("chankan source has no four-tile kan of {tile}"));
        }
    } else {
        let claimed = source
            .discards
            .last()
            .ok_or_else(|| "reaction source has no discards".to_string())?;
        if claimed.tile != *tile {
            return Err(format!(
                "reaction tile {tile} is not the source's last discard {}",
                claimed.tile
            ));
        }
    }

    let mut expected = human.hand.clone();
    expected.sort();
    let mut actual = state.tiles.clone();
    actual.sort();
    if actual != expected {
        return Err("displayed tiles do not match the reaction hand".to_string());
    }

    let actions = legal_actions(state);
    if !actions.iter().any(|action| action.kind == ActionKind::Pass) {
        return Err("reaction candidate has no Pass action".to_string());
    }
    if !actions.iter().any(|action| action.kind != ActionKind::Pass) {
        return Err("reaction candidate has no call or win action".to_string());
    }
    if actions
        .iter()
        .filter(|action| action.kind == ActionKind::Kan)
        .count()
        > 1
    {
        return Err("reaction candidate offers more than one kan choice".to_string());
    }

    validate_tile_ledger(state)?;
    Ok(())
}

/// Check copy limits and that the 14-tile dead wall + live wall closes the deck.
pub fn validate_tile_ledger(state: &GameState) -> Result<(), String> {
    let mut counts: HashMap<String, u8> = HashMap::new();
    let mut known = 0usize;
    for player in &state.players {
        for tile in player.hand.iter().chain(player.draw.iter()) {
            *counts.entry(tile.clone()).or_insert(0) += 1;
            known += 1;
        }
        for meld in &player.melds {
            for tile in &meld.tiles {
                *counts.entry(tile.clone()).or_insert(0) += 1;
                known += 1;
            }
        }
        for discard in &player.discards {
            *counts.entry(discard.tile.clone()).or_insert(0) += 1;
            known += 1;
        }
    }
    for tile in state
        .dora_indicators
        .iter()
        .chain(state.ura_dora_indicators.iter())
    {
        *counts.entry(tile.clone()).or_insert(0) += 1;
        known += 1;
    }

    if let Some((tile, count)) = counts.iter().find(|(_, count)| **count > 4) {
        return Err(format!("tile {tile} appears {count} times"));
    }

    // Twelve dead-wall tiles are hidden; the two indicators are already known.
    if known + 12 + state.tiles_remaining as usize != 136 {
        return Err(format!(
            "tile ledger does not close: known {known} + 12 dead + {} live = {}",
            state.tiles_remaining,
            known + 12 + state.tiles_remaining as usize
        ));
    }

    Ok(())
}
