use serde::{Deserialize, Serialize};

use crate::decision::AiDecision;

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
    Kan,
    /// The correct answer is the loaded model's top legal action.
    Best,
}

/// The kind of action the trainer expects from the player.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CorrectActionType {
    /// Declare Riichi on the accompanying discard.
    Riichi,
    /// Stay in dama (concealed tenpai) and discard without declaring Riichi.
    Dama,
    /// Add the drawn fourth tile to an open Pon.
    Kan,
    /// Pass on the Kan and discard normally.
    Discard,
    /// The answer is the model's top action for an AI scenario.
    Best,
}

/// The expected answer for the current scenario.
///
/// Serializes as `{"type":"riichi|dama","discard":"..."}`,
/// `{"type":"kan|discard","tile":"..."}`, or the AI scenario's
/// `{"type":"best","action":"...","label":"..."}` shape.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum CorrectAction {
    /// Declare Riichi and discard `discard`.
    Riichi { discard: String },
    /// Stay in dama and discard `discard`.
    Dama { discard: String },
    /// Declare an Added Kan on `tile`.
    Kan { tile: String },
    /// Pass on the Kan and discard `tile`.
    Discard { tile: String },
    /// AI scenario: the model's top action, with any concrete tiles needed
    /// to render or grade it.
    Best {
        /// Mortal action name, e.g. `Pon`, `Chi_Low`, `Discard_3m`.
        action: String,
        /// Base tile code for discard/pon/kan/agari answers.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tile: Option<String>,
        /// Additional tiles consumed by a call (chi).
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        tiles: Vec<String>,
        /// Human-readable label, e.g. `Chi 2m 3m on 4m`.
        label: String,
    },
}

impl CorrectAction {
    pub fn riichi(discard: impl Into<String>) -> Self {
        Self::Riichi {
            discard: discard.into(),
        }
    }

    pub fn dama(discard: impl Into<String>) -> Self {
        Self::Dama {
            discard: discard.into(),
        }
    }

    pub fn kan(tile: impl Into<String>) -> Self {
        Self::Kan { tile: tile.into() }
    }

    pub fn discard(tile: impl Into<String>) -> Self {
        Self::Discard { tile: tile.into() }
    }

    /// Build an AI-scenario answer from a model action.
    pub fn best(
        action: impl Into<String>,
        tile: Option<String>,
        tiles: Vec<String>,
        label: impl Into<String>,
    ) -> Self {
        Self::Best {
            action: action.into(),
            tile,
            tiles,
            label: label.into(),
        }
    }

    /// The action kind, independent of the tile field name.
    pub fn action_type(&self) -> CorrectActionType {
        match self {
            Self::Riichi { .. } => CorrectActionType::Riichi,
            Self::Dama { .. } => CorrectActionType::Dama,
            Self::Kan { .. } => CorrectActionType::Kan,
            Self::Discard { .. } => CorrectActionType::Discard,
            Self::Best { .. } => CorrectActionType::Best,
        }
    }

    /// The tile the player must click, when the action has one.
    pub fn tile(&self) -> Option<&str> {
        match self {
            Self::Riichi { discard } | Self::Dama { discard } => Some(discard),
            Self::Kan { tile } | Self::Discard { tile } => Some(tile),
            Self::Best { tile, .. } => tile.as_deref(),
        }
    }
}

/// Reasons a scenario recommends upgrading an open Pon to an Added Kan.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShouminkanTrigger {
    /// The hand is tenpai or 1-shanten with a good wait and at least 2 han.
    GoodWaitAndValue,
    /// The wall is nearly empty and rivers are in the third row.
    LateGame,
    /// South 4 with the human close behind the player above them.
    PlacementDesperation,
    /// The human is far behind in fourth place.
    LosingBadly,
}

/// Reasons a scenario recommends declaring Riichi.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RiichiTrigger {
    /// The human player is the dealer (East seat).
    Dealer,
    /// Every pair and the wait tile is a simple tile (2-8).
    Tanyao,
    /// A red five is held, so the wait itself is the regular five.
    RedFiveWait,
    /// The human river contains a suji tile for the wait.
    SujiTrap,
    /// The wait tile is outside the 4-5-6 middle range, or is an honor.
    #[serde(rename = "wait_outside_456")]
    WaitOutside456,
    /// The hand has at most one dora, so it is below Mangan without Riichi.
    ScoreBelowMangan,
}

/// Reasons a scenario recommends staying in dama.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DamaReason {
    /// The player is not the dealer, reducing Riichi's value.
    NotDealer,
    /// A terminal/honor pair prevents Tanyao.
    NoTanyao,
    /// The wait is a middle tile (4, 5, or 6).
    MiddleWait,
    /// The wait is not a red five.
    NoRedFiveWait,
    /// The river contains no suji of the wait.
    NoSujiTrap,
    /// The hand is already Mangan or better without Riichi.
    Mangan,
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
    /// Red five tiles held in `hand` or `draw` (e.g. "5m").
    pub red_fives: Vec<String>,
    /// Discard river, in the order the tiles were discarded.
    pub discards: Vec<DiscardTile>,
    /// Open called melds.
    pub melds: Vec<CalledMeld>,
    /// Whether the player has declared Riichi.
    pub is_riichi: bool,
    /// Index in `discards` where the Riichi declaration tile was discarded.
    pub riichi_discard_index: Option<usize>,
}

/// What kind of decision the state is presenting.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DecisionContext {
    /// Normal turn: the human has `hand` plus `draw`, and must discard.
    #[default]
    SelfTurn,
    /// The human may call or ron the last discard of `from`.
    ReactToDiscard { from: usize, tile: String },
    /// The human may ron another player's added kan.
    ReactToKan { from: usize, tile: String },
}

/// Complete Mahjong Game and Table State.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GameState {
    // Scenario / Puzzle metadata
    pub category: String,
    pub target_action: TargetAction,
    pub correct_action: CorrectAction,
    /// What kind of decision this state presents.
    #[serde(default)]
    pub decision: DecisionContext,
    /// Model-derived answer and full ranking for AI scenarios.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_decision: Option<AiDecision>,
    /// Reasons this scenario recommends Riichi (empty when not applicable).
    pub riichi_triggers: Vec<RiichiTrigger>,
    /// Reasons this scenario recommends staying in dama (empty when not applicable).
    pub dama_reasons: Vec<DamaReason>,
    /// Reasons this scenario recommends declaring an Added Kan.
    pub shouminkan_triggers: Vec<ShouminkanTrigger>,

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
