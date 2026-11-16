//! Structural validation of a parsed mjai replay.
//!
//! The validator decides whether a game is a legal four-player Tenhou hanchan
//! *before* R2 reconstructs any [`crate::state::GameState`]. It does not know
//! about yaku, waits or scoring values; it checks the facts a replay must
//! satisfy on its own:
//!
//! - **Event order.** One `start_kyoku` … `end_kyoku` per kyoku, a final
//!   `end_game`, turns that follow the discard, and a call only from the claim
//!   window of the tile just discarded.
//! - **Actor/seat consistency.** The acting seat, the called seat, chi from the
//!   left player only, and which seat must draw next.
//! - **Call legality.** The consumed tiles are held, a chi is a run, a pon is a
//!   triplet, a kan has four copies, and kakan upgrades an existing pon.
//! - **Tile ledger.** Every physical tile occurs at most once. The four hands
//!   hold `13 - 3·melds` concealed tiles (`14 - 3·melds` while holding a draw),
//!   and the end of every kyoku reconciles `hands + melds + rivers == 52 +
//!   draws`. Red fives are unique per suit. The dead-wall dora and ura
//!   indicators are counted too.
//! - **Wall.** 70 live-wall draws per kyoku. A kan's replacement draw is a
//!   `tsumo` event and counts against the wall; libriichi takes it from the
//!   dead wall and replenishes that wall from the live wall, so the net cost is
//!   one live tile per draw, not an extra per kan. An exhaustive draw ends with
//!   exactly 0 draws left.
//! - **Dora timing.** One dora at the start, one new indicator per kan, and a
//!   new indicator must appear before the kan's owner next discards (or before
//!   a chankan ron ends the hand).
//! - **Scores.** A full game starts at 25 000 each and E1. Every `start_kyoku`
//!   score vector must equal the previous kyoku's result after the riichi
//!   deductions and deltas, and `Σscores + 1000·kyotaku == 100 000` holds at
//!   every kyoku boundary. Dealer wins repeat the round; non-dealer wins
//!   advance it; an abortive draw repeats it; an exhaustive draw may repeat or
//!   advance because tenpai is not recorded.
//!
//! A replay is a **complete** game. A clip of one kyoku out of a hanchan with
//! non-initial scores is not a replay and is rejected; the corpus runner writes
//! whole games.
//!
//! [`crate::state::GameState`]: ../../state/struct.GameState.html

use serde::Serialize;
use thiserror::Error;

use super::mjai::{EventKind, MjaiEvent, ReplayFile};
use super::tile::{TILE_KINDS, Tile};

/// The table's total score; riichi sticks move 1000 points out of it.
const TABLE_SCORE: i32 = 100_000;
/// Live-wall draws in one kyoku.
const WALL_DRAWS: u16 = 70;
/// Riichi costs 1000 points.
const RIICHI_COST: i32 = 1_000;
/// Dead-wall dora (and ura) indicator slots.
const DEAD_INDICATORS: usize = 5;

/// Validate a complete game and return its summary.
pub fn validate_game(file: &ReplayFile) -> Result<GameSummary, ReplayError> {
    let mut validator = Validator::new();
    for (index, event) in file.events().iter().enumerate() {
        validator.on_event(index, event)?;
    }
    validator.finish()
}

/// Read a gzipped replay and validate it in one step.
pub fn read_and_validate_path(
    path: &std::path::Path,
) -> Result<(ReplayFile, GameSummary), ReplayError> {
    let file = super::mjai::ReplayReader::read_path(path)?;
    let summary = validate_game(&file)?;
    Ok((file, summary))
}

/// Any structural rejection, tagged with its event context.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ReplayError {
    /// A reader failure.
    #[error(transparent)]
    Parse(#[from] super::mjai::ParseError),
    /// The event sequence is impossible.
    #[error(transparent)]
    EventOrder(#[from] EventOrderError),
    /// A tile or hand count is impossible.
    #[error(transparent)]
    Ledger(#[from] LedgerError),
    /// A call is not legal.
    #[error(transparent)]
    Call(#[from] CallError),
    /// The wall or dora timing is impossible.
    #[error(transparent)]
    Wall(#[from] WallError),
    /// The score ledger is inconsistent.
    #[error(transparent)]
    Score(#[from] ScoreError),
}

/// An event-order failure at a specific line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventOrderError {
    pub line: usize,
    pub index: usize,
    pub kind: EventOrderKind,
}

impl std::fmt::Display for EventOrderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.index == usize::MAX {
            write!(f, "at the end of the replay: {}", self.kind)
        } else {
            write!(
                f,
                "line {} (event {}): {}",
                self.line, self.index, self.kind
            )
        }
    }
}

impl std::error::Error for EventOrderError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.kind)
    }
}

/// Why the event sequence cannot happen.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum EventOrderKind {
    #[error("event `{event}` appears outside a kyoku (the game must announce `start_kyoku` first)")]
    EventOutsideKyoku { event: &'static str },
    #[error("a second `start_game`")]
    DuplicateStartGame,
    #[error("`start_game` must be the first event")]
    StartGameNotFirst,
    #[error("`{event}` is not legal while {phase}")]
    UnexpectedEvent {
        phase: &'static str,
        event: &'static str,
    },
    #[error("expected seat {expected} to act, found seat {found}")]
    WrongActor { expected: u8, found: u8 },
    #[error("`start_kyoku` while a kyoku is still open")]
    DuplicateStartKyoku,
    #[error("`end_kyoku` before a `hora` or `ryukyoku`")]
    EndKyokuBeforeResult,
    #[error("`end_game` while a kyoku is still open")]
    EndGameInsideKyoku,
    #[error("`end_game` before any kyoku")]
    EndGameBeforeKyoku,
    #[error("the replay ends without `end_game`")]
    MissingEndGame,
    #[error("the replay ends with an open kyoku")]
    MissingEndKyoku,
    #[error("`{event}` appears after `end_game`")]
    AfterEndGame { event: &'static str },
    #[error("`tsumogiri` is true but the discard is not the drawn tile (`{pai}` vs `{drawn}`)")]
    TsumogiriMismatch { pai: String, drawn: String },
    #[error("a `reach` declaration must be followed by that seat's discard")]
    ReachNotFollowedByDiscard,
    #[error(
        "a discard that declares riichi must be accepted (`reach_accepted`) before the next draw or call"
    )]
    ReachNotAccepted,
    #[error("`reach_accepted` without a pending riichi declaration discard by that seat")]
    ReachAcceptedWithoutDeclaration,
    #[error("a second riichi declaration by the same seat")]
    DuplicateReach,
    #[error("`bakaze` must be one of E, S, W, N, found `{tile}`")]
    InvalidBakaze { tile: String },
    #[error("kyoku header does not continue the game: expected {expected}, found {found}")]
    KyokuHeaderMismatch { expected: String, found: String },
    #[error("a second `hora` on the same discard by seat {seat}")]
    DuplicateHoraActor { seat: u8 },
    #[error("a tsumo win (`hora`) must be declared by the drawing seat")]
    HoraTargetNotActor,
    #[error("a ron (`hora`) must target the seat that just discarded")]
    HoraTargetNotDiscarder,
    #[error("`{event}` cannot follow a completed kyoku result")]
    AfterResult { event: &'static str },
}

/// A tile-ledger failure at a specific line.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("line {line} (event {index}): {kind}")]
pub struct LedgerError {
    pub line: usize,
    pub index: usize,
    pub kind: LedgerErrorKind,
}

/// Why the tile ledger is impossible.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum LedgerErrorKind {
    #[error("seat {seat} holds {found} concealed tiles, expected {expected} {when}")]
    HandSize {
        seat: u8,
        expected: usize,
        found: usize,
        when: &'static str,
    },
    #[error("seat {seat} does not hold `{tile}`")]
    DiscardNotHeld { seat: u8, tile: String },
    #[error("the replay contains {found} copies of `{tile}`; a tile has four")]
    TileCount { tile: String, found: u8 },
    #[error("the replay contains more than one red five of `{tile}`")]
    DuplicateRedFive { tile: String },
    #[error(
        "tile conservation failed: {found} tiles are in hands/melds/rivers, expected {expected} from 52 dealt + {draws} draws"
    )]
    Conservation {
        expected: usize,
        found: usize,
        draws: u16,
    },
    #[error(
        "seat {seat} holds {found} ura markers; the record reveals {expected} (1 + revealed kan dora)"
    )]
    UraCount {
        seat: u8,
        expected: usize,
        found: usize,
    },
    #[error("seat {seat} has ura markers but never had a riichi accepted")]
    UraWithoutRiichi { seat: u8 },
}

/// A call-legality failure at a specific line.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("line {line} (event {index}): {kind}")]
pub struct CallError {
    pub line: usize,
    pub index: usize,
    pub kind: CallErrorKind,
}

/// Why a call is not legal.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum CallErrorKind {
    #[error("a call must target the seat that just discarded, expected {expected}, found {found}")]
    WrongTarget { expected: u8, found: u8 },
    #[error("a seat cannot call its own discard")]
    SelfTarget,
    #[error("no discard is open for a call")]
    NoDiscard,
    #[error("the call names `{found}` but the open discard is `{expected}`")]
    NotLastDiscard { expected: String, found: String },
    #[error("seat {seat} already declared riichi and cannot call")]
    RiichiCall { seat: u8 },
    #[error("seat {seat} has an open hand and cannot declare riichi")]
    ReachWithOpenHand { seat: u8 },
    #[error("seat {seat} cannot add a kan after declaring riichi")]
    RiichiKan { seat: u8 },
    #[error("seat {seat} does not hold the consumed tiles ({missing})")]
    ConsumedNotHeld { seat: u8, missing: String },
    #[error("chi must come from the seat on the caller's left, expected {expected}, found {found}")]
    ChiFromWrongSeat { expected: u8, found: u8 },
    #[error("`{tiles}` is not a chi run")]
    NotARun { tiles: String },
    #[error("`{tiles}` is not a triplet")]
    NotATriplet { tiles: String },
    #[error("`{tiles}` is not a kan of one tile kind")]
    NotAKan { tiles: String },
    #[error("kakan needs an existing pon of `{tile}`, which seat {seat} does not have")]
    NoPon { seat: u8, tile: String },
    #[error("the kakan consumed set `{consumed}` does not match the existing pon `{pon}`")]
    PonMismatch { consumed: String, pon: String },
    #[error("a kan must be declared on your own turn while holding a draw")]
    KanWithoutDraw,
}

/// A wall or dora-timing failure at a specific line.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("line {line} (event {index}): {kind}")]
pub struct WallError {
    pub line: usize,
    pub index: usize,
    pub kind: WallErrorKind,
}

/// Why the wall or dora timing is impossible.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum WallErrorKind {
    #[error("the wall already has 0 draws left")]
    Exhausted,
    #[error("a `dora` event appeared without a kan")]
    UnexpectedDora,
    #[error("a kan's new dora indicator did not appear before the next discard")]
    DoraMissing { pending: u8 },
    #[error("the dead wall has only {max} indicators")]
    NoDoraSlot { max: usize },
    #[error(
        "the kyoku revealed {found} dora indicators, expected {expected} (1 + revealed kan dora)"
    )]
    DoraCount { expected: usize, found: usize },
    #[error("a `ryukyoku` with reason `exhaustive_draw` must have no wall draws left")]
    NotExhaustive,
    #[error("a riichi declaration needs at least four wall tiles; {remaining} remain")]
    ShortWall { remaining: u16 },
}

/// A score-ledger failure at a specific line.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("line {line} (event {index}): {kind}")]
pub struct ScoreError {
    pub line: usize,
    pub index: usize,
    pub kind: ScoreErrorKind,
}

/// Why the score ledger is inconsistent.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ScoreErrorKind {
    #[error(
        "scores must sum to 100000 (plus 1000 per riichi stick): found {found} with kyotaku {kyotaku}"
    )]
    SumMismatch { found: i32, kyotaku: u8 },
    #[error("scores do not continue the previous kyoku: expected {expected:?}, found {found:?}")]
    ChainMismatch { expected: [i32; 4], found: [i32; 4] },
    #[error("kyotaku does not continue the previous kyoku: expected {expected}, found {found}")]
    KyotakuMismatch { expected: u8, found: u8 },
    #[error("a score delta {delta} is not a multiple of 100")]
    DeltaNotMultipleOf100 { delta: i32 },
    #[error("a score delta overflows the score ledger")]
    DeltaOverflow,
    #[error("a riichi declaration needs at least 1000 points; seat {seat} has {score}")]
    InsufficientScore { seat: u8, score: i32 },
}

/// One kyoku's validated result, kept in the game summary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct KyokuSummary {
    /// Round wind (`E`, `S`, `W`, `N`).
    pub bakaze: String,
    /// 1-based kyoku number within the round.
    pub kyoku: u8,
    pub honba: u8,
    pub kyotaku: u8,
    pub oya: u8,
    pub start_scores: [i32; 4],
    pub end_scores: [i32; 4],
    /// Live-wall draws consumed (a kan's replacement draw is one of them).
    pub tsumos: u16,
    pub kans: u8,
    pub reaches: u8,
    pub calls: u8,
    pub wall_remaining: u16,
    pub result: KyokuResultSummary,
}

/// How a kyoku ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum KyokuResultSummary {
    Hora {
        actors: Vec<u8>,
        tsumo: bool,
        /// `ryukyoku`-style reason is not present on a win; kept for symmetry.
        ura_markers: usize,
    },
    Ryukyoku {
        reason: Option<String>,
        /// Whether the wall reached zero (an exhaustive draw) or the hand was
        /// aborted earlier (nine terminals, four winds, four riichi, four kans).
        exhaustive: bool,
    },
}

/// Totals for a validated game.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GameSummary {
    pub events: usize,
    pub kyoku_count: usize,
    pub tsumos: u32,
    pub kans: u32,
    pub reaches: u32,
    pub calls: u32,
    pub horas: u32,
    pub ryukyoku: u32,
    pub final_scores: [i32; 4],
    /// Riichi sticks carried past the last kyoku (0 after a win).
    pub final_kyotaku: u8,
    pub kyoku: Vec<KyokuSummary>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    /// The named seat must draw.
    Draw { actor: u8 },
    /// The named seat must discard; `drawn` is the tile from their `tsumo`, if
    /// this turn began with a draw rather than a call.
    Discard { actor: u8, drawn: Option<Tile> },
    /// The last discard may be called or won.
    Claims { from: u8 },
    /// A `hora` or `ryukyoku` ended the kyoku; only `end_kyoku` (and further
    /// `hora` events on a multi-ron) remain.
    Ended,
}

impl Phase {
    fn name(self) -> &'static str {
        match self {
            Self::Draw { .. } => "waiting for a draw",
            Self::Discard { .. } => "waiting for a discard",
            Self::Claims { .. } => "waiting for a call or the next draw",
            Self::Ended => "after the kyoku result",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MeldKind {
    Chi,
    Pon,
    Daiminkan,
    Ankan,
    Kakan,
}

impl MeldKind {
    fn is_open(self) -> bool {
        !matches!(self, Self::Ankan)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Meld {
    kind: MeldKind,
    tiles: Vec<Tile>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Seat {
    hand: Vec<Tile>,
    melds: Vec<Meld>,
    river: Vec<Tile>,
    riichi: bool,
    /// A `reach` was declared and the declaration discard is still due.
    reach_pending: bool,
    /// The declaration discard is down and `reach_accepted` is still due.
    reach_declared: bool,
}

impl Seat {
    fn new(hand: Vec<Tile>) -> Self {
        Self {
            hand,
            melds: Vec::new(),
            river: Vec::new(),
            riichi: false,
            reach_pending: false,
            reach_declared: false,
        }
    }

    fn concealed_target(&self, holding_draw: bool) -> usize {
        let base = if holding_draw { 14 } else { 13 };
        base - 3 * self.melds.len()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct OpenDiscard {
    from: u8,
    tile: Tile,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Outcome {
    Hora {
        actors: Vec<u8>,
        tsumo: bool,
        ura_markers: usize,
    },
    Ryukyoku {
        reason: Option<String>,
        exhaustive: bool,
    },
}

struct Kyoku {
    oya: u8,
    kyoku: u8,
    /// 0 = east, 1 = south, 2 = west, 3 = north.
    round_wind: u8,
    honba: u8,
    kyotaku: u8,
    start_scores: [i32; 4],
    scores: [i32; 4],
    seats: [Seat; 4],
    phase: Phase,
    open_discard: Option<OpenDiscard>,
    tsumos: u16,
    /// Kan events declared. A robbed kan still counts here.
    kans: u8,
    /// Kan dora indicators actually revealed. A robbed kan never reveals one,
    /// so this is what the dora and ura counts key on.
    kan_dora: u8,
    /// Kans whose new dora indicator has not been emitted yet.
    pending_dora: u8,
    /// The tile a just-declared ankan/kakan offered to a chankan ron.
    chankan: Option<(u8, Tile)>,
    dora_markers: Vec<Tile>,
    ura_markers: Vec<Tile>,
    accepts: u8,
    reaches: u8,
    calls: u8,
    outcome: Option<Outcome>,
}

struct Validator {
    game_started: bool,
    game_ended: bool,
    kyoku: Option<Kyoku>,
    summary: GameSummary,
    /// Table state carried into the next kyoku.
    scores: [i32; 4],
    kyotaku: u8,
    honba: u8,
    oya: u8,
    round: u8,
    last_outcome: Option<Outcome>,
    last_reaches: u8,
}

impl Validator {
    fn new() -> Self {
        Self {
            game_started: false,
            game_ended: false,
            kyoku: None,
            summary: GameSummary {
                events: 0,
                kyoku_count: 0,
                tsumos: 0,
                kans: 0,
                reaches: 0,
                calls: 0,
                horas: 0,
                ryukyoku: 0,
                final_scores: [25_000; 4],
                final_kyotaku: 0,
                kyoku: Vec::new(),
            },
            scores: [25_000; 4],
            kyotaku: 0,
            honba: 0,
            oya: 0,
            round: 0,
            last_outcome: None,
            last_reaches: 0,
        }
    }

    fn on_event(&mut self, index: usize, event: &MjaiEvent) -> Result<(), ReplayError> {
        self.summary.events += 1;
        if self.game_ended {
            return Err(order(
                index,
                event.line,
                EventOrderKind::AfterEndGame {
                    event: event.kind.name(),
                },
            ));
        }

        // A declared reach owns the very next event: its declaration discard.
        if let Some(kyoku) = &self.kyoku
            && let Phase::Discard { actor, .. } = kyoku.phase
            && kyoku.seats[usize::from(actor)].reach_pending
            && !matches!(event.kind, EventKind::Dahai { actor: a, .. } if a == actor)
        {
            return Err(order(
                index,
                event.line,
                EventOrderKind::ReachNotFollowedByDiscard,
            ));
        }

        match &event.kind {
            EventKind::StartGame { .. } => self.on_start_game(index, event),
            EventKind::StartKyoku { .. } => self.on_start_kyoku(index, event),
            EventKind::Tsumo { .. } => self.on_tsumo(index, event),
            EventKind::Dahai { .. } => self.on_dahai(index, event),
            EventKind::Chi { .. } => self.on_call(index, event, MeldKind::Chi),
            EventKind::Pon { .. } => self.on_call(index, event, MeldKind::Pon),
            EventKind::Daiminkan { .. } => self.on_call(index, event, MeldKind::Daiminkan),
            EventKind::Ankan { .. } => self.on_ankan(index, event),
            EventKind::Kakan { .. } => self.on_kakan(index, event),
            EventKind::Dora { .. } => self.on_dora(index, event),
            EventKind::Reach { .. } => self.on_reach(index, event),
            EventKind::ReachAccepted { .. } => self.on_reach_accepted(index, event),
            EventKind::Hora { .. } => self.on_hora(index, event),
            EventKind::Ryukyoku { .. } => self.on_ryukyoku(index, event),
            EventKind::EndKyoku => self.on_end_kyoku(index, event),
            EventKind::EndGame => self.on_end_game(index, event),
        }
    }

    fn finish(self) -> Result<GameSummary, ReplayError> {
        if self.kyoku.is_some() {
            return Err(order_final(EventOrderKind::MissingEndKyoku));
        }
        if !self.game_ended {
            return Err(order_final(EventOrderKind::MissingEndGame));
        }
        Ok(self.summary)
    }

    fn on_start_game(&mut self, index: usize, event: &MjaiEvent) -> Result<(), ReplayError> {
        if self.summary.kyoku_count > 0 {
            return Err(order(index, event.line, EventOrderKind::StartGameNotFirst));
        }
        if self.game_started {
            return Err(order(index, event.line, EventOrderKind::DuplicateStartGame));
        }
        self.game_started = true;
        Ok(())
    }

    fn on_start_kyoku(&mut self, index: usize, event: &MjaiEvent) -> Result<(), ReplayError> {
        if self.kyoku.is_some() {
            return Err(order(
                index,
                event.line,
                EventOrderKind::DuplicateStartKyoku,
            ));
        }
        let EventKind::StartKyoku {
            bakaze,
            dora_marker,
            kyoku,
            honba,
            kyotaku,
            oya,
            scores,
            tehais,
        } = &event.kind
        else {
            unreachable!("on_start_kyoku only sees start_kyoku")
        };

        let round_wind = wind_index(*bakaze).ok_or_else(|| {
            order(
                index,
                event.line,
                EventOrderKind::InvalidBakaze {
                    tile: bakaze.to_string(),
                },
            )
        })?;

        self.check_header(
            index, event.line, *kyoku, *honba, *kyotaku, *oya, round_wind, *scores,
        )?;

        let mut seats: [Seat; 4] = std::array::from_fn(|_| Seat::new(Vec::new()));
        for (seat, hand) in seats.iter_mut().zip(tehais) {
            seat.hand = hand.to_vec();
            seat.hand.sort_unstable();
        }
        // A fresh deal plus the opening dora indicator is 53 distinct physical
        // tiles; a fifth copy or a second red five is already an impossible
        // game, not something to discover at the end of the kyoku.
        let mut kinds = [0_u8; TILE_KINDS];
        let mut reds = [0_u8; TILE_KINDS];
        for tile in tehais
            .iter()
            .flat_map(|hand| hand.iter())
            .chain(std::iter::once(dora_marker))
        {
            count_tile(index, event.line, *tile, &mut kinds, &mut reds)?;
        }
        self.kyoku = Some(Kyoku {
            oya: *oya,
            kyoku: *kyoku,
            round_wind,
            honba: *honba,
            kyotaku: *kyotaku,
            start_scores: *scores,
            scores: *scores,
            seats,
            // The dealer draws first; libriichi emits that tsumo immediately
            // after `start_kyoku`.
            phase: Phase::Draw { actor: *oya },
            open_discard: None,
            tsumos: 0,
            kans: 0,
            kan_dora: 0,
            pending_dora: 0,
            chankan: None,
            dora_markers: vec![*dora_marker],
            ura_markers: Vec::new(),
            accepts: 0,
            reaches: 0,
            calls: 0,
            outcome: None,
        });
        self.summary.kyoku_count += 1;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn check_header(
        &self,
        index: usize,
        line: usize,
        kyoku: u8,
        honba: u8,
        kyotaku: u8,
        oya: u8,
        round_wind: u8,
        scores: [i32; 4],
    ) -> Result<(), ReplayError> {
        check_score_sum(index, line, scores, kyotaku)?;
        let expected_kyotaku = match &self.last_outcome {
            None => 0,
            Some(Outcome::Hora { .. }) => 0,
            Some(Outcome::Ryukyoku { .. }) => self.kyotaku + self.last_reaches,
        };
        if kyotaku != expected_kyotaku {
            return Err(score_error(
                index,
                line,
                ScoreErrorKind::KyotakuMismatch {
                    expected: expected_kyotaku,
                    found: kyotaku,
                },
            ));
        }
        if scores != self.scores {
            return Err(score_error(
                index,
                line,
                ScoreErrorKind::ChainMismatch {
                    expected: self.scores,
                    found: scores,
                },
            ));
        }

        let candidates = self.header_candidates();
        let found = format!(
            "{}{} honba {honba} oya {oya} kyotaku {kyotaku}",
            wind_name(round_wind),
            kyoku
        );
        let matches = candidates.iter().any(|candidate| {
            candidate.round_wind == round_wind
                && candidate.kyoku == kyoku
                && candidate.honba == honba
                && candidate.oya == oya
        });
        if !matches {
            return Err(order(
                index,
                line,
                EventOrderKind::KyokuHeaderMismatch {
                    expected: candidates
                        .iter()
                        .map(HeaderCandidate::describe)
                        .collect::<Vec<_>>()
                        .join(" or "),
                    found,
                },
            ));
        }
        Ok(())
    }

    fn header_candidates(&self) -> Vec<HeaderCandidate> {
        let Some(outcome) = &self.last_outcome else {
            return vec![HeaderCandidate {
                oya: 0,
                honba: 0,
                round_wind: 0,
                kyoku: 1,
            }];
        };
        let dealer_won = match outcome {
            Outcome::Hora { actors, .. } => actors.contains(&self.oya),
            Outcome::Ryukyoku { .. } => false,
        };
        // An abortive draw (nine terminals, four winds, four riichi, four
        // kans) always repeats the dealer. An exhaustive draw repeats or
        // advances depending on tenpai, which the record does not carry.
        let (may_repeat, may_advance) = match outcome {
            Outcome::Hora { .. } => (dealer_won, !dealer_won),
            Outcome::Ryukyoku { exhaustive, .. } => (true, *exhaustive),
        };
        let mut candidates = Vec::new();
        if may_repeat {
            candidates.push(HeaderCandidate {
                oya: self.oya,
                honba: self.honba.saturating_add(1),
                round_wind: self.round / 4,
                kyoku: self.oya + 1,
            });
        }
        if may_advance {
            let next_round = self.round.saturating_add(1);
            let next_oya = (self.oya + 1) % 4;
            let next_honba = match outcome {
                Outcome::Hora { .. } => 0,
                Outcome::Ryukyoku { .. } => self.honba.saturating_add(1),
            };
            candidates.push(HeaderCandidate {
                oya: next_oya,
                honba: next_honba,
                round_wind: next_round / 4,
                kyoku: next_oya + 1,
            });
        }
        candidates
    }

    fn on_tsumo(&mut self, index: usize, event: &MjaiEvent) -> Result<(), ReplayError> {
        let EventKind::Tsumo { actor, pai } = &event.kind else {
            unreachable!()
        };
        let (actor, pai) = (*actor, *pai);
        let kyoku = self.kyoku.as_mut().ok_or_else(|| {
            order(
                index,
                event.line,
                EventOrderKind::EventOutsideKyoku { event: "tsumo" },
            )
        })?;

        match kyoku.phase {
            Phase::Draw { actor: expected } => {
                if expected != actor {
                    return Err(order(
                        index,
                        event.line,
                        EventOrderKind::WrongActor {
                            expected,
                            found: actor,
                        },
                    ));
                }
            }
            Phase::Claims { from } => {
                let expected = (from + 1) % 4;
                if expected != actor {
                    return Err(order(
                        index,
                        event.line,
                        EventOrderKind::WrongActor {
                            expected,
                            found: actor,
                        },
                    ));
                }
                if kyoku.seats[usize::from(from)].reach_declared {
                    return Err(order(index, event.line, EventOrderKind::ReachNotAccepted));
                }
            }
            _ => {
                return Err(order(
                    index,
                    event.line,
                    EventOrderKind::UnexpectedEvent {
                        phase: kyoku.phase.name(),
                        event: "tsumo",
                    },
                ));
            }
        }

        if kyoku.tsumos >= WALL_DRAWS {
            return Err(wall(index, event.line, WallErrorKind::Exhausted));
        }

        let seat = &mut kyoku.seats[usize::from(actor)];
        seat.hand.push(pai);
        let expected = seat.concealed_target(true);
        if seat.hand.len() != expected {
            return Err(ledger(
                index,
                event.line,
                LedgerErrorKind::HandSize {
                    seat: actor,
                    expected,
                    found: seat.hand.len(),
                    when: "after a draw",
                },
            ));
        }
        kyoku.tsumos += 1;
        kyoku.open_discard = None;
        kyoku.chankan = None;
        kyoku.phase = Phase::Discard {
            actor,
            drawn: Some(pai),
        };
        Ok(())
    }

    fn on_dahai(&mut self, index: usize, event: &MjaiEvent) -> Result<(), ReplayError> {
        let EventKind::Dahai {
            actor,
            pai,
            tsumogiri,
        } = &event.kind
        else {
            unreachable!()
        };
        let (actor, pai, tsumogiri) = (*actor, *pai, *tsumogiri);
        let kyoku = self.kyoku.as_mut().ok_or_else(|| {
            order(
                index,
                event.line,
                EventOrderKind::EventOutsideKyoku { event: "dahai" },
            )
        })?;

        let Phase::Discard {
            actor: expected,
            drawn,
        } = kyoku.phase
        else {
            return Err(order(
                index,
                event.line,
                EventOrderKind::UnexpectedEvent {
                    phase: kyoku.phase.name(),
                    event: "dahai",
                },
            ));
        };
        if expected != actor {
            return Err(order(
                index,
                event.line,
                EventOrderKind::WrongActor {
                    expected,
                    found: actor,
                },
            ));
        }
        if tsumogiri && drawn != Some(pai) {
            return Err(order(
                index,
                event.line,
                EventOrderKind::TsumogiriMismatch {
                    pai: pai.to_string(),
                    drawn: drawn.map_or_else(|| "none".to_string(), |tile| tile.to_string()),
                },
            ));
        }
        if kyoku.pending_dora > 0 {
            return Err(wall(
                index,
                event.line,
                WallErrorKind::DoraMissing {
                    pending: kyoku.pending_dora,
                },
            ));
        }

        let seat = &mut kyoku.seats[usize::from(actor)];
        let Some(position) = seat.hand.iter().position(|held| *held == pai) else {
            return Err(ledger(
                index,
                event.line,
                LedgerErrorKind::DiscardNotHeld {
                    seat: actor,
                    tile: pai.to_string(),
                },
            ));
        };
        seat.hand.remove(position);
        let expected = seat.concealed_target(false);
        if seat.hand.len() != expected {
            return Err(ledger(
                index,
                event.line,
                LedgerErrorKind::HandSize {
                    seat: actor,
                    expected,
                    found: seat.hand.len(),
                    when: "after a discard",
                },
            ));
        }
        seat.river.push(pai);
        if seat.reach_pending {
            seat.reach_pending = false;
            seat.reach_declared = true;
            kyoku.reaches += 1;
        }
        kyoku.open_discard = Some(OpenDiscard {
            from: actor,
            tile: pai,
        });
        kyoku.chankan = None;
        kyoku.phase = Phase::Claims { from: actor };
        Ok(())
    }

    fn on_call(
        &mut self,
        index: usize,
        event: &MjaiEvent,
        meld_kind: MeldKind,
    ) -> Result<(), ReplayError> {
        let (actor, target, pai, consumed): (u8, u8, Tile, Vec<Tile>) = match &event.kind {
            EventKind::Chi {
                actor,
                target,
                pai,
                consumed,
            }
            | EventKind::Pon {
                actor,
                target,
                pai,
                consumed,
            } => (*actor, *target, *pai, consumed.to_vec()),
            EventKind::Daiminkan {
                actor,
                target,
                pai,
                consumed,
            } => (*actor, *target, *pai, consumed.to_vec()),
            _ => unreachable!("on_call only sees chi/pon/daiminkan"),
        };
        let kyoku = self.kyoku.as_mut().ok_or_else(|| {
            order(
                index,
                event.line,
                EventOrderKind::EventOutsideKyoku {
                    event: event.kind.name(),
                },
            )
        })?;

        let Phase::Claims { from } = kyoku.phase else {
            return Err(order(
                index,
                event.line,
                EventOrderKind::UnexpectedEvent {
                    phase: kyoku.phase.name(),
                    event: event.kind.name(),
                },
            ));
        };
        let Some(open) = kyoku.open_discard else {
            return Err(call(index, event.line, CallErrorKind::NoDiscard));
        };
        if target != from {
            return Err(call(
                index,
                event.line,
                CallErrorKind::WrongTarget {
                    expected: from,
                    found: target,
                },
            ));
        }
        if actor == target {
            return Err(call(index, event.line, CallErrorKind::SelfTarget));
        }
        if pai != open.tile {
            return Err(call(
                index,
                event.line,
                CallErrorKind::NotLastDiscard {
                    expected: open.tile.to_string(),
                    found: pai.to_string(),
                },
            ));
        }
        if kyoku.seats[usize::from(actor)].riichi {
            return Err(call(
                index,
                event.line,
                CallErrorKind::RiichiCall { seat: actor },
            ));
        }
        if kyoku.seats[usize::from(target)].reach_declared {
            return Err(order(index, event.line, EventOrderKind::ReachNotAccepted));
        }
        if meld_kind == MeldKind::Chi {
            let expected = (actor + 3) % 4;
            if target != expected {
                return Err(call(
                    index,
                    event.line,
                    CallErrorKind::ChiFromWrongSeat {
                        expected,
                        found: target,
                    },
                ));
            }
            let mut tiles = consumed.clone();
            tiles.push(pai);
            if !is_run(&tiles) {
                return Err(call(
                    index,
                    event.line,
                    CallErrorKind::NotARun {
                        tiles: names(&tiles),
                    },
                ));
            }
        } else {
            let matches = consumed.iter().all(|tile| tile.same_kind(pai));
            if !matches {
                return Err(call(
                    index,
                    event.line,
                    CallErrorKind::NotATriplet {
                        tiles: names(&consumed),
                    },
                ));
            }
        }

        let seat = &mut kyoku.seats[usize::from(actor)];
        let expected = seat.concealed_target(false);
        if seat.hand.len() != expected {
            return Err(ledger(
                index,
                event.line,
                LedgerErrorKind::HandSize {
                    seat: actor,
                    expected,
                    found: seat.hand.len(),
                    when: "before a call",
                },
            ));
        }
        if !has_tiles(&seat.hand, &consumed) {
            let missing = missing_tiles(&seat.hand, &consumed);
            return Err(call(
                index,
                event.line,
                CallErrorKind::ConsumedNotHeld {
                    seat: actor,
                    missing: names(&missing),
                },
            ));
        }

        // The claim is legal: take the tile out of the discarder's river and
        // put the meld in front of the caller.
        let Some(claimed) = kyoku.seats[usize::from(target)].river.pop() else {
            return Err(call(index, event.line, CallErrorKind::NoDiscard));
        };
        debug_assert_eq!(claimed, pai);

        let seat = &mut kyoku.seats[usize::from(actor)];
        remove_tiles(&mut seat.hand, &consumed).expect("checked by has_tiles");
        let mut tiles = consumed;
        tiles.push(pai);
        debug_assert!(meld_kind != MeldKind::Daiminkan || is_kan(&tiles));
        seat.melds.push(Meld {
            kind: meld_kind,
            tiles,
        });
        kyoku.calls += 1;
        kyoku.open_discard = None;
        if meld_kind == MeldKind::Daiminkan {
            kyoku.kans += 1;
            kyoku.pending_dora += 1;
            kyoku.phase = Phase::Draw { actor };
        } else {
            let expected = seat.concealed_target(true);
            if seat.hand.len() != expected {
                return Err(ledger(
                    index,
                    event.line,
                    LedgerErrorKind::HandSize {
                        seat: actor,
                        expected,
                        found: seat.hand.len(),
                        when: "after a call",
                    },
                ));
            }
            kyoku.phase = Phase::Discard { actor, drawn: None };
        }
        Ok(())
    }

    fn on_ankan(&mut self, index: usize, event: &MjaiEvent) -> Result<(), ReplayError> {
        let EventKind::Ankan { actor, consumed } = &event.kind else {
            unreachable!()
        };
        let (actor, consumed) = (*actor, consumed.to_vec());
        let kyoku = self.kyoku.as_mut().ok_or_else(|| {
            order(
                index,
                event.line,
                EventOrderKind::EventOutsideKyoku { event: "ankan" },
            )
        })?;
        let Phase::Discard {
            actor: expected,
            drawn,
        } = kyoku.phase
        else {
            return Err(order(
                index,
                event.line,
                EventOrderKind::UnexpectedEvent {
                    phase: kyoku.phase.name(),
                    event: "ankan",
                },
            ));
        };
        if expected != actor {
            return Err(order(
                index,
                event.line,
                EventOrderKind::WrongActor {
                    expected,
                    found: actor,
                },
            ));
        }
        if drawn.is_none() {
            return Err(call(index, event.line, CallErrorKind::KanWithoutDraw));
        }
        if !is_kan(&consumed) {
            return Err(call(
                index,
                event.line,
                CallErrorKind::NotAKan {
                    tiles: names(&consumed),
                },
            ));
        }
        let seat = &mut kyoku.seats[usize::from(actor)];
        let expected_hand = seat.concealed_target(true);
        if seat.hand.len() != expected_hand {
            return Err(ledger(
                index,
                event.line,
                LedgerErrorKind::HandSize {
                    seat: actor,
                    expected: expected_hand,
                    found: seat.hand.len(),
                    when: "before ankan",
                },
            ));
        }
        remove_tiles(&mut seat.hand, &consumed).map_err(|missing| {
            call(
                index,
                event.line,
                CallErrorKind::ConsumedNotHeld {
                    seat: actor,
                    missing: names(&missing),
                },
            )
        })?;
        let chankan_tile = consumed[0];
        seat.melds.push(Meld {
            kind: MeldKind::Ankan,
            tiles: consumed,
        });
        kyoku.kans += 1;
        kyoku.pending_dora += 1;
        kyoku.chankan = Some((actor, chankan_tile));
        kyoku.phase = Phase::Draw { actor };
        Ok(())
    }

    fn on_kakan(&mut self, index: usize, event: &MjaiEvent) -> Result<(), ReplayError> {
        let EventKind::Kakan {
            actor,
            pai,
            consumed,
        } = &event.kind
        else {
            unreachable!()
        };
        let (actor, pai, consumed) = (*actor, *pai, consumed.to_vec());
        let kyoku = self.kyoku.as_mut().ok_or_else(|| {
            order(
                index,
                event.line,
                EventOrderKind::EventOutsideKyoku { event: "kakan" },
            )
        })?;
        let Phase::Discard {
            actor: expected,
            drawn,
        } = kyoku.phase
        else {
            return Err(order(
                index,
                event.line,
                EventOrderKind::UnexpectedEvent {
                    phase: kyoku.phase.name(),
                    event: "kakan",
                },
            ));
        };
        if expected != actor {
            return Err(order(
                index,
                event.line,
                EventOrderKind::WrongActor {
                    expected,
                    found: actor,
                },
            ));
        }
        if drawn.is_none() {
            return Err(call(index, event.line, CallErrorKind::KanWithoutDraw));
        }
        let seat = &mut kyoku.seats[usize::from(actor)];
        if seat.riichi {
            return Err(call(
                index,
                event.line,
                CallErrorKind::RiichiKan { seat: actor },
            ));
        }
        let Some(pon_index) = seat.melds.iter().position(|meld| {
            meld.kind == MeldKind::Pon && meld.tiles.iter().all(|t| t.same_kind(pai))
        }) else {
            return Err(call(
                index,
                event.line,
                CallErrorKind::NoPon {
                    seat: actor,
                    tile: pai.to_string(),
                },
            ));
        };
        let pon_tiles = seat.melds[pon_index].tiles.clone();
        if !same_multiset(&pon_tiles, &consumed) {
            return Err(call(
                index,
                event.line,
                CallErrorKind::PonMismatch {
                    consumed: names(&consumed),
                    pon: names(&pon_tiles),
                },
            ));
        }
        let position = seat
            .hand
            .iter()
            .position(|held| *held == pai)
            .ok_or_else(|| {
                call(
                    index,
                    event.line,
                    CallErrorKind::ConsumedNotHeld {
                        seat: actor,
                        missing: pai.to_string(),
                    },
                )
            })?;
        seat.hand.remove(position);
        let meld = &mut seat.melds[pon_index];
        meld.kind = MeldKind::Kakan;
        meld.tiles = pon_tiles;
        meld.tiles.push(pai);
        kyoku.kans += 1;
        kyoku.pending_dora += 1;
        kyoku.chankan = Some((actor, pai));
        kyoku.phase = Phase::Draw { actor };
        Ok(())
    }

    fn on_dora(&mut self, index: usize, event: &MjaiEvent) -> Result<(), ReplayError> {
        let EventKind::Dora { dora_marker } = &event.kind else {
            unreachable!()
        };
        let kyoku = self.kyoku.as_mut().ok_or_else(|| {
            order(
                index,
                event.line,
                EventOrderKind::EventOutsideKyoku { event: "dora" },
            )
        })?;
        if kyoku.pending_dora == 0 {
            return Err(wall(index, event.line, WallErrorKind::UnexpectedDora));
        }
        if kyoku.dora_markers.len() >= DEAD_INDICATORS {
            return Err(wall(
                index,
                event.line,
                WallErrorKind::NoDoraSlot {
                    max: DEAD_INDICATORS,
                },
            ));
        }
        kyoku.dora_markers.push(*dora_marker);
        kyoku.kan_dora += 1;
        kyoku.pending_dora -= 1;
        Ok(())
    }

    fn on_reach(&mut self, index: usize, event: &MjaiEvent) -> Result<(), ReplayError> {
        let EventKind::Reach { actor } = &event.kind else {
            unreachable!()
        };
        let actor = *actor;
        let kyoku = self.kyoku.as_mut().ok_or_else(|| {
            order(
                index,
                event.line,
                EventOrderKind::EventOutsideKyoku { event: "reach" },
            )
        })?;
        let Phase::Discard {
            actor: expected,
            drawn,
        } = kyoku.phase
        else {
            return Err(order(
                index,
                event.line,
                EventOrderKind::UnexpectedEvent {
                    phase: kyoku.phase.name(),
                    event: "reach",
                },
            ));
        };
        if expected != actor {
            return Err(order(
                index,
                event.line,
                EventOrderKind::WrongActor {
                    expected,
                    found: actor,
                },
            ));
        }
        if drawn.is_none() {
            return Err(order(
                index,
                event.line,
                EventOrderKind::UnexpectedEvent {
                    phase: "after a call",
                    event: "reach",
                },
            ));
        }
        let seat = &kyoku.seats[usize::from(actor)];
        if seat.riichi || seat.reach_pending || seat.reach_declared {
            return Err(order(index, event.line, EventOrderKind::DuplicateReach));
        }
        if seat.melds.iter().any(|meld| meld.kind.is_open()) {
            return Err(call(
                index,
                event.line,
                CallErrorKind::ReachWithOpenHand { seat: actor },
            ));
        }
        let score = kyoku.scores[usize::from(actor)];
        if score < RIICHI_COST {
            return Err(score_error(
                index,
                event.line,
                ScoreErrorKind::InsufficientScore { seat: actor, score },
            ));
        }
        let remaining = WALL_DRAWS - kyoku.tsumos;
        if remaining < 4 {
            return Err(wall(
                index,
                event.line,
                WallErrorKind::ShortWall { remaining },
            ));
        }
        kyoku.seats[usize::from(actor)].reach_pending = true;
        Ok(())
    }

    fn on_reach_accepted(&mut self, index: usize, event: &MjaiEvent) -> Result<(), ReplayError> {
        let EventKind::ReachAccepted { actor } = &event.kind else {
            unreachable!()
        };
        let actor = *actor;
        let kyoku = self.kyoku.as_mut().ok_or_else(|| {
            order(
                index,
                event.line,
                EventOrderKind::EventOutsideKyoku {
                    event: "reach_accepted",
                },
            )
        })?;
        let Phase::Claims { from } = kyoku.phase else {
            return Err(order(
                index,
                event.line,
                EventOrderKind::UnexpectedEvent {
                    phase: kyoku.phase.name(),
                    event: "reach_accepted",
                },
            ));
        };
        if from != actor || !kyoku.seats[usize::from(actor)].reach_declared {
            return Err(order(
                index,
                event.line,
                EventOrderKind::ReachAcceptedWithoutDeclaration,
            ));
        }
        let seat = &mut kyoku.seats[usize::from(actor)];
        seat.reach_declared = false;
        seat.riichi = true;
        kyoku.scores[usize::from(actor)] -= RIICHI_COST;
        kyoku.accepts += 1;
        Ok(())
    }

    fn on_hora(&mut self, index: usize, event: &MjaiEvent) -> Result<(), ReplayError> {
        let EventKind::Hora {
            actor,
            target,
            pai,
            deltas,
            scores,
            ura_markers,
        } = &event.kind
        else {
            unreachable!()
        };
        let (actor, target, pai) = (*actor, *target, *pai);
        let kyoku = self.kyoku.as_mut().ok_or_else(|| {
            order(
                index,
                event.line,
                EventOrderKind::EventOutsideKyoku { event: "hora" },
            )
        })?;

        let tsumo = match kyoku.phase {
            Phase::Discard {
                actor: discard_actor,
                drawn,
            } => {
                if discard_actor != actor {
                    return Err(order(
                        index,
                        event.line,
                        EventOrderKind::WrongActor {
                            expected: discard_actor,
                            found: actor,
                        },
                    ));
                }
                if target != actor {
                    return Err(order(index, event.line, EventOrderKind::HoraTargetNotActor));
                }
                if let Some(pai) = pai
                    && drawn != Some(pai)
                {
                    return Err(ledger(
                        index,
                        event.line,
                        LedgerErrorKind::DiscardNotHeld {
                            seat: actor,
                            tile: pai.to_string(),
                        },
                    ));
                }
                let seat = &kyoku.seats[usize::from(actor)];
                let expected = seat.concealed_target(true);
                if seat.hand.len() != expected {
                    return Err(ledger(
                        index,
                        event.line,
                        LedgerErrorKind::HandSize {
                            seat: actor,
                            expected,
                            found: seat.hand.len(),
                            when: "before a tsumo win",
                        },
                    ));
                }
                true
            }
            Phase::Claims { from } => {
                if target != from {
                    return Err(order(
                        index,
                        event.line,
                        EventOrderKind::HoraTargetNotDiscarder,
                    ));
                }
                if actor == target {
                    return Err(order(
                        index,
                        event.line,
                        EventOrderKind::HoraTargetNotDiscarder,
                    ));
                }
                let Some(open) = kyoku.open_discard else {
                    return Err(call(index, event.line, CallErrorKind::NoDiscard));
                };
                if let Some(pai) = pai
                    && pai != open.tile
                {
                    return Err(call(
                        index,
                        event.line,
                        CallErrorKind::NotLastDiscard {
                            expected: open.tile.to_string(),
                            found: pai.to_string(),
                        },
                    ));
                }
                let seat = &kyoku.seats[usize::from(actor)];
                let expected = seat.concealed_target(false);
                if seat.hand.len() != expected {
                    return Err(ledger(
                        index,
                        event.line,
                        LedgerErrorKind::HandSize {
                            seat: actor,
                            expected,
                            found: seat.hand.len(),
                            when: "before a ron",
                        },
                    ));
                }
                // A ron cancels a pending riichi acceptance: the declaration
                // discard was called away, so it never becomes an accepted
                // riichi.
                kyoku.seats[usize::from(target)].reach_declared = false;
                false
            }
            Phase::Ended => {
                let Some(Outcome::Hora {
                    actors,
                    tsumo: ended_by_tsumo,
                    ..
                }) = &kyoku.outcome
                else {
                    return Err(order(
                        index,
                        event.line,
                        EventOrderKind::AfterResult { event: "hora" },
                    ));
                };
                let Some(open) = kyoku.open_discard else {
                    return Err(order(
                        index,
                        event.line,
                        EventOrderKind::DuplicateHoraActor { seat: actor },
                    ));
                };
                if *ended_by_tsumo
                    || target != open.from
                    || pai.is_some_and(|pai| pai != open.tile)
                    || actors.contains(&actor)
                {
                    return Err(order(
                        index,
                        event.line,
                        EventOrderKind::DuplicateHoraActor { seat: actor },
                    ));
                }
                false
            }
            Phase::Draw { actor: kan_actor } => {
                // A just-declared ankan or kakan can be robbed (chankan). The
                // kan's own replacement draw has not happened yet, so this is a
                // ron with the winner at their normal 13-tile size and no new
                // dora indicator.
                let Some((offered_by, offered)) = kyoku.chankan else {
                    return Err(order(
                        index,
                        event.line,
                        EventOrderKind::UnexpectedEvent {
                            phase: kyoku.phase.name(),
                            event: "hora",
                        },
                    ));
                };
                if target != kan_actor || target != offered_by || actor == target {
                    return Err(order(
                        index,
                        event.line,
                        EventOrderKind::HoraTargetNotDiscarder,
                    ));
                }
                if let Some(pai) = pai
                    && pai != offered
                {
                    return Err(call(
                        index,
                        event.line,
                        CallErrorKind::NotLastDiscard {
                            expected: offered.to_string(),
                            found: pai.to_string(),
                        },
                    ));
                }
                let seat = &kyoku.seats[usize::from(actor)];
                let expected = seat.concealed_target(false);
                if seat.hand.len() != expected {
                    return Err(ledger(
                        index,
                        event.line,
                        LedgerErrorKind::HandSize {
                            seat: actor,
                            expected,
                            found: seat.hand.len(),
                            when: "before a chankan ron",
                        },
                    ));
                }
                false
            }
        };

        apply_score_event(index, event.line, kyoku, *deltas, *scores)?;

        if let Some(ura) = ura_markers
            && !ura.is_empty()
        {
            if !kyoku.seats[usize::from(actor)].riichi {
                return Err(ledger(
                    index,
                    event.line,
                    LedgerErrorKind::UraWithoutRiichi { seat: actor },
                ));
            }
            let expected = 1 + usize::from(kyoku.kan_dora);
            if ura.len() != expected {
                return Err(ledger(
                    index,
                    event.line,
                    LedgerErrorKind::UraCount {
                        seat: actor,
                        expected,
                        found: ura.len(),
                    },
                ));
            }
            kyoku.ura_markers.extend_from_slice(ura);
        }

        kyoku.pending_dora = 0;
        kyoku.phase = Phase::Ended;
        match &mut kyoku.outcome {
            Some(Outcome::Hora { actors, .. }) => {
                if !actors.contains(&actor) {
                    actors.push(actor);
                }
            }
            Some(Outcome::Ryukyoku { .. }) => unreachable!("a hora cannot follow ryukyoku"),
            None => {
                kyoku.outcome = Some(Outcome::Hora {
                    actors: vec![actor],
                    tsumo,
                    ura_markers: ura_markers.as_ref().map_or(0, Vec::len),
                });
            }
        }
        self.summary.horas += 1;
        Ok(())
    }

    fn on_ryukyoku(&mut self, index: usize, event: &MjaiEvent) -> Result<(), ReplayError> {
        let EventKind::Ryukyoku {
            reason,
            deltas,
            scores,
            ..
        } = &event.kind
        else {
            unreachable!()
        };
        let kyoku = self.kyoku.as_mut().ok_or_else(|| {
            order(
                index,
                event.line,
                EventOrderKind::EventOutsideKyoku { event: "ryukyoku" },
            )
        })?;
        if kyoku.phase == Phase::Ended {
            return Err(order(
                index,
                event.line,
                EventOrderKind::AfterResult { event: "ryukyoku" },
            ));
        }
        if kyoku.seats.iter().any(|seat| seat.reach_pending) {
            return Err(order(
                index,
                event.line,
                EventOrderKind::ReachNotFollowedByDiscard,
            ));
        }
        let exhaustive = kyoku.tsumos == WALL_DRAWS;
        // A riichi declared on the final discard never completes: libriichi
        // ends the hand before `reach_accepted`, so the stick is not paid. An
        // abortive draw, in contrast, cannot interrupt a pending acceptance.
        if !exhaustive && kyoku.seats.iter().any(|seat| seat.reach_declared) {
            return Err(order(index, event.line, EventOrderKind::ReachNotAccepted));
        }
        if kyoku.pending_dora > 0 {
            return Err(wall(
                index,
                event.line,
                WallErrorKind::DoraMissing {
                    pending: kyoku.pending_dora,
                },
            ));
        }
        if reason.as_deref() == Some("exhaustive_draw") && !exhaustive {
            return Err(wall(index, event.line, WallErrorKind::NotExhaustive));
        }
        apply_score_event(index, event.line, kyoku, *deltas, *scores)?;
        kyoku.phase = Phase::Ended;
        kyoku.outcome = Some(Outcome::Ryukyoku {
            reason: reason.clone(),
            exhaustive,
        });
        self.summary.ryukyoku += 1;
        Ok(())
    }

    fn on_end_kyoku(&mut self, index: usize, event: &MjaiEvent) -> Result<(), ReplayError> {
        let Some(kyoku) = self.kyoku.take() else {
            return Err(order(
                index,
                event.line,
                EventOrderKind::EventOutsideKyoku { event: "end_kyoku" },
            ));
        };
        if kyoku.outcome.is_none() || kyoku.phase != Phase::Ended {
            self.kyoku = Some(kyoku);
            return Err(order(
                index,
                event.line,
                EventOrderKind::EndKyokuBeforeResult,
            ));
        }
        self.finalize_kyoku(index, event.line, kyoku)
    }

    fn finalize_kyoku(
        &mut self,
        index: usize,
        line: usize,
        kyoku: Kyoku,
    ) -> Result<(), ReplayError> {
        let outcome = kyoku.outcome.clone().expect("checked above");
        let tsumo_winner = match &outcome {
            Outcome::Hora {
                actors,
                tsumo: true,
                ..
            } => actors.first().copied(),
            _ => None,
        };

        let mut in_play = 0_usize;
        let mut kinds = [0_u8; TILE_KINDS];
        let mut reds = [0_u8; TILE_KINDS];
        for (seat_index, seat) in kyoku.seats.iter().enumerate() {
            let expected = if Some(seat_index as u8) == tsumo_winner {
                seat.concealed_target(true)
            } else {
                seat.concealed_target(false)
            };
            if seat.hand.len() != expected {
                return Err(ledger(
                    index,
                    line,
                    LedgerErrorKind::HandSize {
                        seat: seat_index as u8,
                        expected,
                        found: seat.hand.len(),
                        when: "at end_kyoku",
                    },
                ));
            }
            in_play += seat.hand.len() + seat.river.len();
            for tile in seat
                .hand
                .iter()
                .chain(&seat.river)
                .chain(seat.melds.iter().flat_map(|meld| meld.tiles.iter()))
            {
                count_tile(index, line, *tile, &mut kinds, &mut reds)?;
            }
            in_play += seat
                .melds
                .iter()
                .map(|meld| meld.tiles.len())
                .sum::<usize>();
        }
        for tile in kyoku.dora_markers.iter().chain(&kyoku.ura_markers) {
            count_tile(index, line, *tile, &mut kinds, &mut reds)?;
        }

        let expected_in_play = 52 + usize::from(kyoku.tsumos);
        if in_play != expected_in_play {
            return Err(ledger(
                index,
                line,
                LedgerErrorKind::Conservation {
                    expected: expected_in_play,
                    found: in_play,
                    draws: kyoku.tsumos,
                },
            ));
        }

        let expected_dora = 1 + usize::from(kyoku.kan_dora);
        if kyoku.dora_markers.len() != expected_dora {
            return Err(wall(
                index,
                line,
                WallErrorKind::DoraCount {
                    expected: expected_dora,
                    found: kyoku.dora_markers.len(),
                },
            ));
        }

        let kyotaku_next = match &outcome {
            Outcome::Hora { .. } => 0,
            Outcome::Ryukyoku { .. } => kyoku.kyotaku + kyoku.accepts,
        };
        check_score_sum(index, line, kyoku.scores, kyotaku_next)?;

        self.summary.tsumos += u32::from(kyoku.tsumos);
        self.summary.kans += u32::from(kyoku.kans);
        self.summary.reaches += u32::from(kyoku.reaches);
        self.summary.calls += u32::from(kyoku.calls);
        self.summary.final_scores = kyoku.scores;
        self.summary.final_kyotaku = kyotaku_next;

        let result = match &outcome {
            Outcome::Hora {
                actors,
                tsumo,
                ura_markers,
            } => KyokuResultSummary::Hora {
                actors: actors.clone(),
                tsumo: *tsumo,
                ura_markers: *ura_markers,
            },
            Outcome::Ryukyoku { reason, exhaustive } => KyokuResultSummary::Ryukyoku {
                reason: reason.clone(),
                exhaustive: *exhaustive,
            },
        };
        self.summary.kyoku.push(KyokuSummary {
            bakaze: wind_name(kyoku.round_wind).to_string(),
            kyoku: kyoku.kyoku,
            honba: kyoku.honba,
            kyotaku: kyoku.kyotaku,
            oya: kyoku.oya,
            start_scores: kyoku.start_scores,
            end_scores: kyoku.scores,
            tsumos: kyoku.tsumos,
            kans: kyoku.kans,
            reaches: kyoku.reaches,
            calls: kyoku.calls,
            wall_remaining: WALL_DRAWS - kyoku.tsumos,
            result,
        });

        self.scores = kyoku.scores;
        self.kyotaku = kyotaku_next;
        // `round` is the absolute kyoku index (E1 = 0). `oya` cycles every
        // four kyoku, so the wind block is `round / 4`.
        self.round = kyoku.round_wind * 4 + kyoku.oya;
        self.oya = kyoku.oya;
        self.honba = kyoku.honba;
        self.last_reaches = kyoku.reaches;
        self.last_outcome = Some(outcome);
        Ok(())
    }

    fn on_end_game(&mut self, index: usize, event: &MjaiEvent) -> Result<(), ReplayError> {
        if self.kyoku.is_some() {
            return Err(order(index, event.line, EventOrderKind::EndGameInsideKyoku));
        }
        if self.summary.kyoku_count == 0 {
            return Err(order(index, event.line, EventOrderKind::EndGameBeforeKyoku));
        }
        self.game_ended = true;
        Ok(())
    }
}

/// The header a legal next kyoku may carry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct HeaderCandidate {
    oya: u8,
    honba: u8,
    round_wind: u8,
    kyoku: u8,
}

impl HeaderCandidate {
    fn describe(&self) -> String {
        format!(
            "{}{} honba {} oya {}",
            wind_name(self.round_wind),
            self.kyoku,
            self.honba,
            self.oya
        )
    }
}

fn check_score_sum(
    index: usize,
    line: usize,
    scores: [i32; 4],
    kyotaku: u8,
) -> Result<(), ReplayError> {
    let total: i32 = scores.iter().sum();
    let expected = TABLE_SCORE - i32::from(kyotaku) * RIICHI_COST;
    if total != expected {
        return Err(score_error(
            index,
            line,
            ScoreErrorKind::SumMismatch {
                found: total,
                kyotaku,
            },
        ));
    }
    Ok(())
}

fn apply_score_event(
    index: usize,
    line: usize,
    kyoku: &mut Kyoku,
    deltas: Option<[i32; 4]>,
    scores: Option<[i32; 4]>,
) -> Result<(), ReplayError> {
    match (deltas, scores) {
        (Some(deltas), recorded) => {
            for delta in deltas {
                if delta % 100 != 0 {
                    return Err(score_error(
                        index,
                        line,
                        ScoreErrorKind::DeltaNotMultipleOf100 { delta },
                    ));
                }
            }
            for (score, delta) in kyoku.scores.iter_mut().zip(deltas) {
                *score = score
                    .checked_add(delta)
                    .ok_or_else(|| score_error(index, line, ScoreErrorKind::DeltaOverflow))?;
            }
            if let Some(recorded) = recorded
                && recorded != kyoku.scores
            {
                return Err(score_error(
                    index,
                    line,
                    ScoreErrorKind::ChainMismatch {
                        expected: kyoku.scores,
                        found: recorded,
                    },
                ));
            }
        }
        (None, Some(recorded)) => kyoku.scores = recorded,
        (None, None) => {}
    }
    Ok(())
}

fn count_tile(
    index: usize,
    line: usize,
    tile: Tile,
    kinds: &mut [u8; TILE_KINDS],
    reds: &mut [u8; TILE_KINDS],
) -> Result<(), ReplayError> {
    let kind = tile.kind();
    kinds[kind] = kinds[kind].saturating_add(1);
    if kinds[kind] > 4 {
        return Err(ledger(
            index,
            line,
            LedgerErrorKind::TileCount {
                tile: tile.app_name(),
                found: kinds[kind],
            },
        ));
    }
    if tile.is_aka() {
        reds[kind] = reds[kind].saturating_add(1);
        if reds[kind] > 1 {
            return Err(ledger(
                index,
                line,
                LedgerErrorKind::DuplicateRedFive {
                    tile: tile.mjai_name(),
                },
            ));
        }
    }
    Ok(())
}

fn has_tiles(hand: &[Tile], tiles: &[Tile]) -> bool {
    missing_tiles(hand, tiles).is_empty()
}

fn missing_tiles(hand: &[Tile], tiles: &[Tile]) -> Vec<Tile> {
    let mut pool = hand.to_vec();
    let mut missing = Vec::new();
    for tile in tiles {
        if let Some(position) = pool.iter().position(|held| held == tile) {
            pool.remove(position);
        } else {
            missing.push(*tile);
        }
    }
    missing
}

fn remove_tiles(hand: &mut Vec<Tile>, tiles: &[Tile]) -> Result<(), Vec<Tile>> {
    let missing = missing_tiles(hand, tiles);
    if missing.is_empty() {
        for tile in tiles {
            if let Some(position) = hand.iter().position(|held| held == tile) {
                hand.remove(position);
            }
        }
        Ok(())
    } else {
        Err(missing)
    }
}

fn same_multiset(left: &[Tile], right: &[Tile]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut left = left.to_vec();
    let mut right = right.to_vec();
    left.sort_unstable();
    right.sort_unstable();
    left == right
}

fn is_run(tiles: &[Tile]) -> bool {
    if tiles.len() != 3 || tiles.iter().any(|tile| tile.is_honor()) {
        return false;
    }
    let suit = tiles[0].kind() / 9;
    if tiles.iter().any(|tile| tile.kind() / 9 != suit) {
        return false;
    }
    let mut ranks: Vec<usize> = tiles.iter().map(|tile| tile.kind() % 9).collect();
    ranks.sort_unstable();
    ranks[0] + 1 == ranks[1] && ranks[1] + 1 == ranks[2]
}

fn is_kan(tiles: &[Tile]) -> bool {
    tiles.len() == 4 && tiles.iter().all(|tile| tile.same_kind(tiles[0]))
}

fn names(tiles: &[Tile]) -> String {
    tiles
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(" ")
}

fn wind_index(tile: Tile) -> Option<u8> {
    match tile.kind() {
        27 => Some(0),
        28 => Some(1),
        29 => Some(2),
        30 => Some(3),
        _ => None,
    }
}

fn wind_name(round_wind: u8) -> &'static str {
    ["E", "S", "W", "N"][usize::from(round_wind)]
}

fn order(index: usize, line: usize, kind: EventOrderKind) -> ReplayError {
    EventOrderError { line, index, kind }.into()
}

fn order_final(kind: EventOrderKind) -> ReplayError {
    EventOrderError {
        line: 0,
        index: usize::MAX,
        kind,
    }
    .into()
}

fn ledger(index: usize, line: usize, kind: LedgerErrorKind) -> ReplayError {
    LedgerError { line, index, kind }.into()
}

fn call(index: usize, line: usize, kind: CallErrorKind) -> ReplayError {
    CallError { line, index, kind }.into()
}

fn wall(index: usize, line: usize, kind: WallErrorKind) -> ReplayError {
    WallError { line, index, kind }.into()
}

fn score_error(index: usize, line: usize, kind: ScoreErrorKind) -> ReplayError {
    ScoreError { line, index, kind }.into()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::fs;
    use std::path::Path;

    use super::*;
    use crate::replay::SUPPORTED_EVENTS;
    use crate::replay::fixtures;
    use crate::replay::mjai::{ParseErrorKind, ReplayReader};

    fn read(events: &[EventKind]) -> ReplayFile {
        ReplayReader::read_jsonl(&fixtures::to_jsonl(events)).expect("fixture must parse")
    }

    fn validate(events: &[EventKind]) -> Result<GameSummary, ReplayError> {
        validate_game(&read(events))
    }

    fn order_kind(error: ReplayError) -> EventOrderKind {
        match error {
            ReplayError::EventOrder(error) => error.kind,
            other => panic!("expected an event-order error, found {other:?}"),
        }
    }

    fn ledger_kind(error: ReplayError) -> LedgerErrorKind {
        match error {
            ReplayError::Ledger(error) => error.kind,
            other => panic!("expected a ledger error, found {other:?}"),
        }
    }

    fn call_kind(error: ReplayError) -> CallErrorKind {
        match error {
            ReplayError::Call(error) => error.kind,
            other => panic!("expected a call error, found {other:?}"),
        }
    }

    fn wall_kind(error: ReplayError) -> WallErrorKind {
        match error {
            ReplayError::Wall(error) => error.kind,
            other => panic!("expected a wall error, found {other:?}"),
        }
    }

    fn score_kind(error: ReplayError) -> ScoreErrorKind {
        match error {
            ReplayError::Score(error) => error.kind,
            other => panic!("expected a score error, found {other:?}"),
        }
    }

    fn first(events: &[EventKind], predicate: impl Fn(&EventKind) -> bool) -> usize {
        events
            .iter()
            .position(predicate)
            .expect("fixture event not found")
    }

    fn last(events: &[EventKind], predicate: impl Fn(&EventKind) -> bool) -> usize {
        events
            .iter()
            .rposition(predicate)
            .expect("fixture event not found")
    }

    #[test]
    fn all_events_fixture_produces_the_expected_event_list() {
        let expected = fixtures::all_events_game();
        let file = read(&expected);
        let parsed: Vec<EventKind> = file
            .events()
            .iter()
            .map(|event| event.kind.clone())
            .collect();
        assert_eq!(parsed, expected);
        assert_eq!(parsed.len(), 59);

        // The scripted game covers every supported kind except a draw.
        let seen: BTreeSet<&'static str> = parsed.iter().map(EventKind::name).collect();
        for name in SUPPORTED_EVENTS {
            if *name != "ryukyoku" {
                assert!(seen.contains(name), "fixture lacks `{name}`");
            }
        }

        let summary = validate_game(&file).expect("the all-events fixture must validate");
        assert_eq!(summary.kyoku_count, 1);
        assert_eq!(summary.tsumos, 22);
        assert_eq!(summary.kans, 3);
        assert_eq!(summary.reaches, 1);
        assert_eq!(summary.calls, 3);
        assert_eq!(summary.horas, 1);
        assert_eq!(summary.ryukyoku, 0);
        assert_eq!(summary.final_scores, [33_000, 25_000, 25_000, 17_000]);
        assert_eq!(summary.final_kyotaku, 0);
        let kyoku = &summary.kyoku[0];
        assert_eq!(
            (kyoku.bakaze.as_str(), kyoku.kyoku, kyoku.honba),
            ("E", 1, 0)
        );
        assert_eq!(kyoku.wall_remaining, 70 - 22);
        assert!(matches!(
            kyoku.result,
            KyokuResultSummary::Hora {
                ref actors,
                tsumo: false,
                ura_markers: 4,
            } if actors == &[0]
        ));
    }

    #[test]
    fn exhaustive_fixture_validates_with_a_full_wall() {
        let game = fixtures::exhaustive_game(1);
        let summary = validate(&game).expect("the exhaustive fixture must validate");
        assert_eq!(summary.kyoku_count, 1);
        assert_eq!(summary.tsumos, 70);
        assert_eq!(summary.ryukyoku, 1);
        assert_eq!(summary.horas, 0);
        assert_eq!(summary.final_scores, [25_000; 4]);
        assert_eq!(summary.final_kyotaku, 0);
        let kyoku = &summary.kyoku[0];
        assert_eq!(kyoku.wall_remaining, 0);
        assert!(matches!(
            kyoku.result,
            KyokuResultSummary::Ryukyoku {
                ref reason,
                exhaustive: true,
            } if reason.as_deref() == Some("exhaustive_draw")
        ));
    }

    #[test]
    fn every_supported_event_kind_appears_across_the_committed_fixtures() {
        let mut seen: BTreeSet<&'static str> = fixtures::all_events_game()
            .iter()
            .map(EventKind::name)
            .collect();
        seen.extend(fixtures::exhaustive_game(1).iter().map(EventKind::name));
        for name in SUPPORTED_EVENTS {
            assert!(seen.contains(name), "fixture corpus lacks `{name}`");
        }
    }

    #[test]
    fn start_game_is_optional_and_not_repeated() {
        let mut without = fixtures::all_events_game();
        assert!(matches!(without[0], EventKind::StartGame { .. }));
        without.remove(0);
        validate(&without).expect("a log may omit start_game");

        let mut twice = fixtures::all_events_game();
        twice.insert(1, fixtures::start_game());
        assert!(matches!(
            order_kind(validate(&twice).expect_err("two start_game events")),
            EventOrderKind::DuplicateStartGame
        ));
    }

    #[test]
    fn a_kakan_can_be_robbed_by_chankan() {
        let mut game = fixtures::all_events_game();
        let kakan = first(&game, |event| matches!(event, EventKind::Kakan { .. }));
        game.truncate(kakan + 1);
        game.push(EventKind::Hora {
            actor: 1,
            target: 2,
            pai: Some(Tile::parse("E").unwrap()),
            deltas: Some([0, 8_000, -8_000, 0]),
            scores: None,
            ura_markers: None,
        });
        game.push(EventKind::EndKyoku);
        game.push(EventKind::EndGame);

        let summary = validate(&game).expect("a robbed kakan must validate");
        assert_eq!(summary.horas, 1);
        assert_eq!(summary.kans, 3);
        assert_eq!(summary.final_scores, [25_000, 33_000, 17_000, 25_000]);
        assert_eq!(
            summary.kyoku[0].result,
            KyokuResultSummary::Hora {
                actors: vec![1],
                tsumo: false,
                ura_markers: 0,
            }
        );
    }

    #[test]
    fn an_abortive_draw_must_repeat_the_dealer() {
        let mut first = fixtures::exhaustive_kyoku(1, (0, 1, 0, [25_000; 4]));
        first.truncate(3); // start_kyoku, one draw, one discard
        first.push(EventKind::Ryukyoku {
            reason: Some("nine_terminals".to_string()),
            deltas: Some([0; 4]),
            scores: Some([25_000; 4]),
            tehais: None,
            ura_markers: None,
        });
        first.push(EventKind::EndKyoku);

        let mut advancing = vec![fixtures::start_game()];
        advancing.extend(first.clone());
        // E2 is not a legal continuation of an abortive draw.
        advancing.extend(fixtures::exhaustive_kyoku(2, (1, 2, 1, [25_000; 4])));
        advancing.push(EventKind::EndGame);
        assert!(matches!(
            order_kind(validate(&advancing).expect_err("abortive draw advanced")),
            EventOrderKind::KyokuHeaderMismatch { .. }
        ));

        let mut repeating = vec![fixtures::start_game()];
        repeating.extend(first);
        // The dealer repeats at E1 with honba 1.
        repeating.extend(fixtures::exhaustive_kyoku(2, (0, 1, 1, [25_000; 4])));
        repeating.push(EventKind::EndGame);
        validate(&repeating).expect("an abortive draw repeats the dealer");
    }

    #[test]
    fn two_kyoku_game_continues_the_score_and_round_ledger() {
        let game = fixtures::two_kyoku_game();
        let summary = validate(&game).expect("two kyoku must validate");
        assert_eq!(summary.kyoku_count, 2);
        let second = &summary.kyoku[1];
        assert_eq!(second.bakaze, "E");
        assert_eq!(second.kyoku, 2);
        assert_eq!(second.honba, 1);
        assert_eq!(second.oya, 1);
        assert_eq!(second.start_scores, [25_000; 4]);
    }

    #[test]
    fn one_hundred_synthetic_games_parse_and_validate() {
        let games = fixtures::synthetic_games(100);
        let mut calls = 0;
        for (seed, game) in games.iter().enumerate() {
            let summary = validate(game).unwrap_or_else(|error| panic!("seed {seed}: {error}"));
            assert_eq!(summary.kyoku_count, 1, "seed {seed}");
            assert_eq!(summary.tsumos, 70, "seed {seed}");
            assert_eq!(summary.kyoku[0].wall_remaining, 0, "seed {seed}");
            calls += summary.calls;
        }
        assert!(calls > 0, "the synthetic corpus must exercise calls");
    }

    #[test]
    fn gzipped_replay_reads_through_the_path_entry_point() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("one_kyoku.jsonl.gz");
        let text = fixtures::to_jsonl(&fixtures::all_events_game());
        fs::write(&path, fixtures::gzip(&text)).expect("write fixture");

        let (file, summary) = read_and_validate_path(&path).expect("gzip fixture must validate");
        assert_eq!(file.len(), 59);
        assert_eq!(summary.final_scores, [33_000, 25_000, 25_000, 17_000]);
    }

    #[test]
    fn committed_fixtures_are_current() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/replays");
        let hora = fs::read_to_string(dir.join("one_kyoku_hora.jsonl"))
            .expect("testdata/replays/one_kyoku_hora.jsonl");
        assert_eq!(hora, fixtures::to_jsonl(&fixtures::all_events_game()));

        let ryukyoku = fs::read_to_string(dir.join("one_kyoku_ryukyoku.jsonl"))
            .expect("testdata/replays/one_kyoku_ryukyoku.jsonl");
        assert_eq!(ryukyoku, fixtures::to_jsonl(&fixtures::exhaustive_game(1)));
    }

    /// Regenerate the committed fixtures:
    /// `cargo test --features miner regenerate_committed_fixtures -- --ignored`
    #[test]
    #[ignore = "writes the committed fixtures"]
    fn regenerate_committed_fixtures() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/replays");
        fs::create_dir_all(&dir).expect("create testdata/replays");
        fs::write(
            dir.join("one_kyoku_hora.jsonl"),
            fixtures::to_jsonl(&fixtures::all_events_game()),
        )
        .expect("write hora fixture");
        fs::write(
            dir.join("one_kyoku_ryukyoku.jsonl"),
            fixtures::to_jsonl(&fixtures::exhaustive_game(1)),
        )
        .expect("write ryukyoku fixture");
    }

    // --- Malformed fixtures -------------------------------------------------

    #[test]
    fn malformed_fixtures_have_typed_errors() {
        // Reader-level failures.
        let err = ReplayReader::read_jsonl("{not json}\n").expect_err("bad JSON");
        assert!(matches!(err.kind, ParseErrorKind::InvalidJson(_)));

        let err =
            ReplayReader::read_jsonl("{\"type\":\"mahjong_soul\"}\n").expect_err("unknown event");
        assert_eq!(
            err.kind,
            ParseErrorKind::UnknownEvent("mahjong_soul".to_string())
        );

        let err = ReplayReader::read_jsonl("{\"type\":\"tsumo\",\"actor\":0,\"pai\":\"?\"}\n")
            .expect_err("hidden tile");
        assert!(matches!(err.kind, ParseErrorKind::InvalidTile { .. }));

        let err = ReplayReader::read_jsonl(
            "{\"type\":\"ankan\",\"actor\":3,\"consumed\":[\"8s\",\"8s\",\"8s\"]}\n",
        )
        .expect_err("three-tile ankan");
        assert_eq!(
            err.kind,
            ParseErrorKind::WrongLength {
                field: "consumed",
                expected: 4,
                found: 3,
            }
        );

        // A tenhou6 document is not an mjai event stream.
        let err = ReplayReader::read_jsonl("{\"title\":\"x\",\"log\":[]}\n")
            .expect_err("tenhou6 must not parse");
        assert_eq!(err.kind, ParseErrorKind::MissingType);

        // A fifth copy of a tile.
        let mut game = fixtures::all_events_game();
        let start = first(&game, |event| matches!(event, EventKind::StartKyoku { .. }));
        if let EventKind::StartKyoku { tehais, .. } = &mut game[start] {
            tehais[0][0] = Tile::parse("8s").unwrap();
        }
        let err = validate(&game).expect_err("five 8s");
        assert!(matches!(
            ledger_kind(err),
            LedgerErrorKind::TileCount { ref tile, found: 5 } if tile == "8s"
        ));

        // A second red five of the same suit.
        let mut game = fixtures::all_events_game();
        let start = first(&game, |event| matches!(event, EventKind::StartKyoku { .. }));
        if let EventKind::StartKyoku { tehais, .. } = &mut game[start] {
            tehais[0][0] = Tile::parse("5mr").unwrap();
        }
        let err = validate(&game).expect_err("two red 5m");
        assert!(matches!(
            ledger_kind(err),
            LedgerErrorKind::DuplicateRedFive { .. }
        ));

        // Wrong actor on a discard.
        let mut game = fixtures::all_events_game();
        let dahai = first(&game, |event| matches!(event, EventKind::Dahai { .. }));
        if let EventKind::Dahai { actor, .. } = &mut game[dahai] {
            *actor = 1;
        }
        assert!(matches!(
            order_kind(validate(&game).expect_err("wrong actor")),
            EventOrderKind::WrongActor {
                expected: 0,
                found: 1
            }
        ));

        // Discarding a tile the seat does not hold.
        let mut game = fixtures::all_events_game();
        let dahai = first(&game, |event| matches!(event, EventKind::Dahai { .. }));
        if let EventKind::Dahai { pai, tsumogiri, .. } = &mut game[dahai] {
            *pai = Tile::parse("1p").unwrap();
            *tsumogiri = false;
        }
        assert!(matches!(
            ledger_kind(validate(&game).expect_err("unheld discard")),
            LedgerErrorKind::DiscardNotHeld { seat: 0, .. }
        ));

        // Chi from a seat that is not the discarder's left neighbour.
        let mut game = fixtures::all_events_game();
        let chi = first(&game, |event| matches!(event, EventKind::Chi { .. }));
        if let EventKind::Chi { actor, .. } = &mut game[chi] {
            *actor = 2;
        }
        assert!(matches!(
            call_kind(validate(&game).expect_err("illegal chi seat")),
            CallErrorKind::ChiFromWrongSeat { .. }
        ));

        // Pon of a tile the caller does not hold.
        let mut game = fixtures::all_events_game();
        let pon = first(&game, |event| matches!(event, EventKind::Pon { .. }));
        if let EventKind::Pon { consumed, .. } = &mut game[pon] {
            *consumed = [Tile::parse("N").unwrap(), Tile::parse("N").unwrap()];
        }
        assert!(matches!(
            call_kind(validate(&game).expect_err("illegal pon tiles")),
            CallErrorKind::NotATriplet { .. }
        ));

        // Kakan without a matching pon.
        let mut game = fixtures::all_events_game();
        let kakan = first(&game, |event| matches!(event, EventKind::Kakan { .. }));
        if let EventKind::Kakan { pai, .. } = &mut game[kakan] {
            *pai = Tile::parse("N").unwrap();
        }
        assert!(matches!(
            call_kind(validate(&game).expect_err("kakan without pon")),
            CallErrorKind::NoPon { .. }
        ));

        // A dora event without a kan.
        let mut game = fixtures::all_events_game();
        let tsumo = first(&game, |event| matches!(event, EventKind::Tsumo { .. }));
        game.insert(
            tsumo,
            EventKind::Dora {
                dora_marker: Tile::parse("S").unwrap(),
            },
        );
        assert!(matches!(
            wall_kind(validate(&game).expect_err("dora without kan")),
            WallErrorKind::UnexpectedDora
        ));

        // A kan whose new dora indicator never appears.
        let mut game = fixtures::all_events_game();
        let ankan = first(&game, |event| matches!(event, EventKind::Ankan { .. }));
        assert!(matches!(game[ankan + 1], EventKind::Dora { .. }));
        game.remove(ankan + 1);
        assert!(matches!(
            wall_kind(validate(&game).expect_err("missing kan dora")),
            WallErrorKind::DoraMissing { pending: 1 }
        ));

        // A riichi discard that is never accepted.
        let mut game = fixtures::all_events_game();
        let accepted = first(&game, |event| {
            matches!(event, EventKind::ReachAccepted { .. })
        });
        game.remove(accepted);
        assert!(matches!(
            order_kind(validate(&game).expect_err("missing reach_accepted")),
            EventOrderKind::ReachNotAccepted
        ));

        // A wrong recorded score on the win.
        let mut game = fixtures::all_events_game();
        let hora = first(&game, |event| matches!(event, EventKind::Hora { .. }));
        if let EventKind::Hora { scores, .. } = &mut game[hora] {
            *scores = Some([33_000, 25_000, 25_000, 18_000]);
        }
        assert!(matches!(
            score_kind(validate(&game).expect_err("wrong win scores")),
            ScoreErrorKind::ChainMismatch { .. }
        ));

        // A score vector that does not sum to the table total.
        let mut game = fixtures::all_events_game();
        let start = first(&game, |event| matches!(event, EventKind::StartKyoku { .. }));
        if let EventKind::StartKyoku { scores, .. } = &mut game[start] {
            *scores = [26_000, 25_000, 25_000, 25_000];
        }
        assert!(matches!(
            score_kind(validate(&game).expect_err("bad score total")),
            ScoreErrorKind::SumMismatch { .. }
        ));

        // A 71st draw.
        let mut game = fixtures::exhaustive_game(1);
        let discard = last(&game, |event| matches!(event, EventKind::Dahai { .. }));
        let actor = match &game[discard] {
            EventKind::Dahai { actor, .. } => (*actor + 1) % 4,
            _ => unreachable!(),
        };
        let ryukyoku = first(&game, |event| matches!(event, EventKind::Ryukyoku { .. }));
        game.insert(
            ryukyoku,
            EventKind::Tsumo {
                actor,
                pai: Tile::parse("1m").unwrap(),
            },
        );
        assert!(matches!(
            wall_kind(validate(&game).expect_err("71st draw")),
            WallErrorKind::Exhausted
        ));

        // Missing end_game.
        let mut game = fixtures::all_events_game();
        game.pop();
        assert!(matches!(
            order_kind(validate(&game).expect_err("missing end_game")),
            EventOrderKind::MissingEndGame
        ));

        // An event after end_game.
        let mut game = fixtures::all_events_game();
        game.push(EventKind::EndKyoku);
        assert!(matches!(
            order_kind(validate(&game).expect_err("after end_game")),
            EventOrderKind::AfterEndGame { .. }
        ));

        // A second start_kyoku while one is open.
        let mut game = fixtures::all_events_game();
        let start = first(&game, |event| matches!(event, EventKind::StartKyoku { .. }));
        game.insert(start + 1, game[start].clone());
        assert!(matches!(
            order_kind(validate(&game).expect_err("double start_kyoku")),
            EventOrderKind::DuplicateStartKyoku
        ));

        // The wrong honba on the second kyoku.
        let mut game = fixtures::two_kyoku_game();
        let starts: Vec<usize> = game
            .iter()
            .enumerate()
            .filter(|(_, event)| matches!(event, EventKind::StartKyoku { .. }))
            .map(|(index, _)| index)
            .collect();
        if let EventKind::StartKyoku { honba, .. } = &mut game[starts[1]] {
            *honba = 0;
        }
        assert!(matches!(
            order_kind(validate(&game).expect_err("wrong honba")),
            EventOrderKind::KyokuHeaderMismatch { .. }
        ));

        // A carried riichi stick where the ledger says there is none.
        let mut game = fixtures::two_kyoku_game();
        let starts: Vec<usize> = game
            .iter()
            .enumerate()
            .filter(|(_, event)| matches!(event, EventKind::StartKyoku { .. }))
            .map(|(index, _)| index)
            .collect();
        if let EventKind::StartKyoku {
            kyotaku, scores, ..
        } = &mut game[starts[1]]
        {
            *kyotaku = 1;
            *scores = [24_000, 25_000, 25_000, 25_000];
        }
        assert!(matches!(
            score_kind(validate(&game).expect_err("wrong kyotaku")),
            ScoreErrorKind::KyotakuMismatch { .. }
        ));

        // end_kyoku without a result.
        let mut game = fixtures::all_events_game();
        let hora = first(&game, |event| matches!(event, EventKind::Hora { .. }));
        game.remove(hora);
        assert!(matches!(
            order_kind(validate(&game).expect_err("end_kyoku before result")),
            EventOrderKind::EndKyokuBeforeResult
        ));

        // A ron that names the wrong discarder.
        let mut game = fixtures::all_events_game();
        let hora = first(&game, |event| matches!(event, EventKind::Hora { .. }));
        if let EventKind::Hora { target, .. } = &mut game[hora] {
            *target = 2;
        }
        assert!(matches!(
            order_kind(validate(&game).expect_err("wrong ron target")),
            EventOrderKind::HoraTargetNotDiscarder
        ));
    }
}
