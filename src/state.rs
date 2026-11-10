use serde::{Deserialize, Serialize};

/// Seat / round wind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Wind {
    East,
    South,
    West,
    North,
}

impl Wind {
    /// All winds in seating order starting from East.
    pub const ALL: [Wind; 4] = [Wind::East, Wind::South, Wind::West, Wind::North];

    /// Zero-based seat index for the wind (East = 0).
    pub fn index(self) -> usize {
        match self {
            Wind::East => 0,
            Wind::South => 1,
            Wind::West => 2,
            Wind::North => 3,
        }
    }

    /// Wind reached after advancing `steps` seats.
    pub fn next(self, steps: usize) -> Wind {
        Wind::ALL[(self.index() + steps) % Wind::ALL.len()]
    }
}

/// The kind of open (or closed kan) call a player has made.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MeldType {
    Chi,
    Pon,
    Kan,
    Ankan,
}

/// Decision the current puzzle is asking the player to make.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TargetAction {
    Riichi,
    Dama,
    Push,
    Fold,
    NaniKiru,
}

/// The kind of action the trainer expects from the player.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CorrectActionType {
    /// Declare Riichi on the accompanying discard.
    Riichi,
    /// Stay in dama (concealed tenpai) and discard without declaring Riichi.
    Dama,
}

/// The expected answer for the current scenario.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CorrectAction {
    /// Action kind; serialized as `"type"` because `type` is reserved in Rust.
    #[serde(rename = "type")]
    pub action_type: CorrectActionType,
    /// Tile the player should discard (e.g. "6p").
    pub discard: String,
}

/// Discard tile in a player's river.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DiscardTile {
    /// Tile string representation (e.g. "1m", "5z").
    pub tile: String,
    /// Whether this tile was discarded when declaring Riichi (rendered rotated 90 degrees).
    pub is_riichi: bool,
    /// Whether this tile was discarded immediately after being drawn (tsumogiri).
    pub is_tsumogiri: bool,
}

impl DiscardTile {
    pub fn new(tile: impl Into<String>) -> Self {
        Self {
            tile: tile.into(),
            is_riichi: false,
            is_tsumogiri: false,
        }
    }

    pub fn riichi(tile: impl Into<String>) -> Self {
        Self {
            tile: tile.into(),
            is_riichi: true,
            is_tsumogiri: false,
        }
    }

    pub fn tsumogiri(tile: impl Into<String>) -> Self {
        Self {
            tile: tile.into(),
            is_riichi: false,
            is_tsumogiri: true,
        }
    }
}

/// An open/called meld (Chi, Pon, Kan, Ankan).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CalledMeld {
    /// Type of meld.
    pub meld_type: MeldType,
    /// Tiles forming the meld (e.g. ["2s", "3s", "4s"] or ["5z", "5z", "5z"]).
    pub tiles: Vec<String>,
    /// Seat relative to this player from which the tile was called (None for closed kans).
    pub called_from: Option<usize>,
}

/// State for an individual player (1 of 4 at the table).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlayerState {
    /// Seat index: 0 = Human (Self), 1 = Shimocha (Right), 2 = Toimen (Across), 3 = Kamicha (Left).
    pub seat: usize,
    /// Display name (e.g. "You", "Shimocha", "Toimen", "Kamicha").
    pub name: String,
    /// True for the human user.
    pub is_human: bool,
    /// Seat wind.
    pub wind: Wind,
    /// Current point total (e.g. 25000).
    pub score: i32,
    /// Concealed tiles (normally 13, or 3 fewer per open meld).
    /// The active draw is kept separately in `draw`.
    pub hand: Vec<String>,
    /// The active drawn tile (14th tile), if currently this player's turn.
    pub draw: Option<String>,
    /// Discard river, in the order the tiles were discarded.
    pub discards: Vec<DiscardTile>,
    /// Open called melds.
    pub melds: Vec<CalledMeld>,
    /// Whether the player has declared Riichi.
    pub is_riichi: bool,
    /// Index in `discards` where the Riichi declaration tile was discarded.
    pub riichi_discard_index: Option<usize>,
}

/// Complete Mahjong Game and Table State.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GameState {
    // Scenario / Puzzle metadata
    pub category: String,
    pub target_action: TargetAction,
    pub correct_action: CorrectAction,

    // Hand evaluation (Human player)
    pub hand_string: String,
    pub tiles: Vec<String>,
    pub shanten: i8,
    pub is_agari: bool,
    pub decompositions_count: usize,
    pub ukeire_tiles: Vec<String>,
    pub ukeire_total: u8,

    // Global table state
    pub round_wind: Wind,
    pub hand_number: u8,
    pub honba: u8,
    pub riichi_sticks: u8,
    pub dora_indicators: Vec<String>,
    pub ura_dora_indicators: Vec<String>,
    pub tiles_remaining: u8,

    // 4 Player states
    pub current_turn: usize,
    pub players: Vec<PlayerState>,
}
