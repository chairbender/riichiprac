use agari::parse::validate_hand;

use crate::generator::{evaluate_hand, format_hand_compact, generate_random_hand};
use crate::state::{
    CalledMeld, CorrectAction, DiscardTile, GameState, MeldType, PlayerState, TargetAction, Wind,
};

/// Evaluates a random 14-tile hand and populates the complete mocked
/// `GameState` table used by the Phase 2 UI fixture.
pub(crate) fn generate(category: &str) -> Result<GameState, String> {
    let tiles = generate_random_hand();
    validate_hand(&tiles)?;

    let metrics = evaluate_hand(&tiles);

    let hand_string = format_hand_compact(&tiles);
    let tile_strings: Vec<String> = tiles.iter().map(|t| t.to_string()).collect();

    // Separate human hand into 13 standing hand tiles + 1 active draw
    let human_standing_hand: Vec<String> = tile_strings[0..13].to_vec();
    let human_draw: Option<String> = tile_strings.get(13).cloned();
    let correct_discard = human_draw
        .clone()
        .or_else(|| human_standing_hand.first().cloned())
        .unwrap_or_default();

    // Player 0: Human User (Dealer / East)
    let player0 = PlayerState {
        seat: 0,
        name: "You".to_string(),
        is_human: true,
        wind: Wind::East,
        score: 25000,
        hand: human_standing_hand,
        draw: human_draw,
        red_fives: Vec::new(),
        discards: vec![
            DiscardTile::new("1z"),
            DiscardTile::new("9m"),
            DiscardTile::new("1p"),
            DiscardTile::tsumogiri("9s"),
            DiscardTile::new("2z"),
            DiscardTile::tsumogiri("8s"),
        ],
        melds: Vec::new(),
        is_riichi: false,
        riichi_discard_index: None,
    };

    // Player 1: Shimocha (South) - Has called Chi
    let player1 = PlayerState {
        seat: 1,
        name: "Shimocha".to_string(),
        is_human: false,
        wind: Wind::South,
        score: 25000,
        hand: vec![
            "1m".into(),
            "1m".into(),
            "2m".into(),
            "3m".into(),
            "4p".into(),
            "5p".into(),
            "6p".into(),
            "7s".into(),
            "8s".into(),
            "9s".into(),
        ],
        draw: None,
        red_fives: Vec::new(),
        discards: vec![
            DiscardTile::new("9m"),
            DiscardTile::new("1s"),
            DiscardTile::new("4z"),
            DiscardTile::tsumogiri("8p"),
            DiscardTile::new("2m"),
            DiscardTile::tsumogiri("3p"),
        ],
        melds: vec![CalledMeld {
            meld_type: MeldType::Chi,
            tiles: vec!["2s".to_string(), "3s".to_string(), "4s".to_string()],
            called_from: Some(0),
        }],
        is_riichi: false,
        riichi_discard_index: None,
    };

    // Player 2: Toimen (West) - In Riichi! Discard #5 ("6p") was the Riichi declaration tile
    let player2 = PlayerState {
        seat: 2,
        name: "Toimen".to_string(),
        is_human: false,
        wind: Wind::West,
        score: 24000, // Deducted 1000 for Riichi stick
        hand: vec![
            "1p".into(),
            "2p".into(),
            "3p".into(),
            "4s".into(),
            "5s".into(),
            "6s".into(),
            "7m".into(),
            "8m".into(),
            "9m".into(),
            "1m".into(),
            "2m".into(),
            "3m".into(),
            "7z".into(),
        ],
        draw: None,
        red_fives: Vec::new(),
        discards: vec![
            DiscardTile::new("1z"),
            DiscardTile::new("9p"),
            DiscardTile::new("1m"),
            DiscardTile::tsumogiri("7s"),
            DiscardTile::new("3z"),
            DiscardTile::riichi("6p"), // Riichi declaration tile (rotated in UI)
            DiscardTile::tsumogiri("8m"),
        ],
        melds: Vec::new(),
        is_riichi: true,
        riichi_discard_index: Some(5),
    };

    // Player 3: Kamicha (North) - Has called Pon of White Dragons
    let player3 = PlayerState {
        seat: 3,
        name: "Kamicha".to_string(),
        is_human: false,
        wind: Wind::North,
        score: 26000,
        hand: vec![
            "3m".into(),
            "4m".into(),
            "5m".into(),
            "2p".into(),
            "3p".into(),
            "4p".into(),
            "6s".into(),
            "7s".into(),
            "8s".into(),
            "1z".into(),
        ],
        draw: None,
        red_fives: Vec::new(),
        discards: vec![
            DiscardTile::new("7z"),
            DiscardTile::new("1s"),
            DiscardTile::new("9s"),
            DiscardTile::tsumogiri("2m"),
            DiscardTile::new("1m"),
            DiscardTile::tsumogiri("4p"),
        ],
        melds: vec![CalledMeld {
            meld_type: MeldType::Pon,
            tiles: vec!["5z".to_string(), "5z".to_string(), "5z".to_string()],
            called_from: Some(2),
        }],
        is_riichi: false,
        riichi_discard_index: None,
    };

    Ok(GameState {
        category: category.to_string(),
        target_action: TargetAction::Riichi,
        correct_action: CorrectAction::riichi(correct_discard),
        riichi_triggers: Vec::new(),
        dama_reasons: Vec::new(),
        shouminkan_triggers: Vec::new(),

        hand_string,
        tiles: tile_strings,
        shanten: metrics.shanten,
        is_agari: metrics.is_agari,
        decompositions_count: metrics.decompositions_count,
        ukeire_tiles: metrics.ukeire_tiles,
        ukeire_total: metrics.ukeire_total,

        round_wind: Wind::East,
        hand_number: 1,
        honba: 1,
        riichi_sticks: 1,
        dora_indicators: vec!["5p".to_string()],
        ura_dora_indicators: vec!["9s".to_string()],
        tiles_remaining: 62,

        current_turn: 0,
        players: vec![player0, player1, player2, player3],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mock_table_fixture_still_serves_phase2_shape() {
        let state = generate("mock_table").expect("Mock table fixture must build");

        assert_eq!(state.category, "mock_table");
        assert_eq!(state.players[0].hand.len(), 13);
        assert!(state.players[2].is_riichi);
        assert_eq!(state.tiles.len(), 14);
    }
}
