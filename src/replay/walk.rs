//! Replay walker and `GameState` reconstruction (R2).
//!
//! R1 decides whether a game is structurally possible; this module turns one
//! **validated** replay into the app's own [`GameState`] snapshots at every
//! decision point. It does not decide what the answer is: the book classifiers
//! (B1/B2) and the Mortal labeler (L1) attach the lesson and the model answer
//! later. It does not invent game rules either: hand sizes, meld shapes, river
//! reachability and the decision placement are checked by the same
//! [`validate_reachable_state`] every generator runs.
//!
//! # Where a snapshot is taken
//!
//! The walker keeps a live kyoku state (four hands, draws, rivers, melds,
//! riichi flags, scores, dora, wall count) and snapshots **before** the event
//! that resolves a choice. One decision per resolving event, so the decision id
//! is `sha256(replay_id, kyoku_index, event_index)` as the plan requires, where
//! `kyoku_index` is the 0-based kyoku ordinal in the game (`start_kyoku.kyoku`
//! repeats every round, so it cannot identify a hand on its own).
//!
//! | Resolving event | [`DecisionKind`] | `DecisionContext` |
//! | --- | --- | --- |
//! | `dahai` right after that seat's `tsumo` | `SelfTurn` | `SelfTurn` |
//! | `reach` | `SelfTurn` | `SelfTurn` |
//! | `ankan`, `kakan` | `SelfTurn` | `SelfTurn` |
//! | `hora` declared by the drawing seat | `SelfTurn` | `SelfTurn` |
//! | `chi`, `pon`, `daiminkan` | `Call` | `ReactToDiscard` |
//! | `hora` on a discard (ron) | `ReactToDiscard` | `ReactToDiscard` |
//! | `hora` on a just-declared `ankan`/`kakan` | `ReactToKan` | `ReactToKan` |
//!
//! A `dahai` that follows the seat's own call is **not** a decision in this
//! model: the app has no decision context for "discard without a draw" (its
//! `SelfTurn` requires the actor's draw and `ReactTo*` requires no draw). The
//! call decision already asks the question the app can grade, and the discard
//! is part of executing the call. A `ryukyoku` is not a decision either: the
//! mjai event carries no actor, so the abortive-draw choice cannot be attributed
//! to a seat.
//!
//! # Normalisation
//!
//! Every snapshot is rotated so the actor is `players[0]`: hands, draws, rivers,
//! melds, `called_from`, scores, winds, `current_turn` and the reaction `from`
//! move together, and the round wind, dealer derivation and the river indices
//! stay consistent. This is normalisation, not a scenario variant; the variant
//! engine (V1) permutes the opponents around the actor differently.
//!
//! # What is filled and what is deliberately not
//!
//! - `hand_string`, `tiles`, shanten, agari, decompositions and ukeire come from
//!   the same [`crate::generator::evaluate_hand`] the generators use, on the
//!   concealed tiles (hand plus draw) — the app's convention for an open hand.
//! - `can_riichi` and `book_rationale` are stamped by
//!   [`crate::generator::finalize_state`], exactly as at a generation boundary.
//! - `tiles_remaining` is `70 - tsumo events in this kyoku`: a kan's replacement
//!   draw is one `tsumo`, which is the wall cost R1 already validates.
//! - `dora_indicators` holds only the indicators revealed **at** the decision: a
//!   kan dora arrives as a later `dora` event and a robbed kan reveals none.
//! - `ura_dora_indicators` is **not** on the snapshot's state. The record only
//!   reveals the ura markers when the kyoku ends, so they are stored on
//!   [`DecisionSnapshot::ura_dora_indicators`] for post-answer display and only
//!   copied into a state for the reviewer export.
//! - `category`, `target_action` and `correct_action` are **provisional**. R2
//!   never decides the answer, but `GameState` requires those fields, so the
//!   category names the decision kind, the target is `Call` for a call (which is
//!   what makes `call_offer` render) and otherwise `Best`, and `correct_action`
//!   repeats the action the record played so the payload is structurally
//!   complete. B1/L1 overwrite them; do not ship them as answers.
//! - Furiten is **not** part of `GameState`. The snapshot records the actor's
//!   waits and whether its own river already contains one (permanent furiten) so
//!   a ron decision can be triaged. Temporary furiten (a passed ron) leaves no
//!   event in the record and is not reconstructed; a decision that would only
//!   be legal because of it cannot occur, because the record contains no ron.
//!
//! # Rejection
//!
//! A decision whose reconstructed state fails [`validate_reachable_state`] is
//! **skipped**, never emitted: [`ReplayWalk::skipped`] carries the event, the
//! seat and the validator's reason. That is the triage path for a reconstruction
//! bug (fix it) or a documented validator gap (record it), not a licence to
//! bypass the check. The current known gap is an ankan robbed by kokushi: the
//! validator's chankan check only accepts an **open** four-tile kan, so the
//! `ReactToKan` snapshot for a robbed ankan is skipped. A ron by a player whose
//! own river holds one of its waits is skipped as well, because `GameState` has
//! no furiten field and such a ron is not a legal game; the skip reason names the
//! wait and the river. A played action missing from
//! [`crate::ai::actions::legal_actions`] is recorded as
//! [`DecisionSnapshot::played_is_legal`] `false` plus a warning instead of
//! dropping the decision, because the app's yaku set and the engine's can
//! legitimately disagree on a ron.
//!
//! # Reviewer export
//!
//! [`DecisionSnapshot::review_export`] reuses the `tenhou.net/6` writer in
//! [`crate::export::tenhou6`] (the tile-id/naki mapping) with the record's ura
//! indicators attached, so a reviewer can load the exact position in
//! <https://mjai.ekyu.moe>. tenhou6 stays an output; the walker never reads it.

use std::path::Path;

use agari::parse::to_counts;
use agari::shanten::calculate_ukeire_with_melds;
use agari::tile::Tile as AgariTile;
use thiserror::Error;

use crate::ai::actions::{discard_info, legal_actions};
use crate::decision::{ActionInfo, ActionKind, KanKind};
use crate::export::{Tenhou6Export, export_tenhou6};
use crate::generator::evaluate_hand;
use crate::generator::finalize_state;
use crate::generator::format_hand_compact;
use crate::generator::validate_reachable_state;
use crate::miner::provenance::{ReplayId, sha256_hex};
use crate::state::{
    CallOffer, CalledMeld, CorrectAction, DecisionContext, DiscardTile, GameState, MeldType,
    PlayerState, TargetAction, Wind,
};

use super::mjai::{EventKind, MjaiEvent, ParseError, ReplayFile, ReplayReader};
use super::tile::Tile as MjaiTile;
use super::validate::{ReplayError, validate_game};

/// Live-wall draws in one kyoku. A kan's replacement draw is one of them, which
/// is exactly how R1 counts the wall.
pub const WALL_DRAWS: u16 = 70;

/// The app's seat names after normalisation: the actor at seat 0, then the
/// right, across and left players, matching every generator's table.
const SEAT_NAMES: [&str; 4] = ["You", "Shimocha", "Toimen", "Kamicha"];

/// Which choice a snapshot presents.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum DecisionKind {
    /// The actor has just drawn and may discard, declare Riichi, kan or win.
    SelfTurn,
    /// The actor may call (chi, pon or the open quad) the last discard.
    Call,
    /// The actor may ron the last discard.
    ReactToDiscard,
    /// The actor may rob a just-declared kan.
    ReactToKan,
}

impl DecisionKind {
    /// The `decisions.decision_kind` spelling.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::SelfTurn => "self_turn",
            Self::Call => "call",
            Self::ReactToDiscard => "react_discard",
            Self::ReactToKan => "react_kan",
        }
    }

    /// Parse the database spelling.
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "self_turn" => Some(Self::SelfTurn),
            "call" => Some(Self::Call),
            "react_discard" => Some(Self::ReactToDiscard),
            "react_kan" => Some(Self::ReactToKan),
            _ => None,
        }
    }
}

impl std::fmt::Display for DecisionKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One reconstructed decision point.
#[derive(Debug, Clone, PartialEq)]
pub struct DecisionSnapshot {
    /// `sha256(replay_id, kyoku_index, event_index)` as bare lowercase hex.
    pub decision_id: String,
    /// The raw self-play log this state came from.
    pub replay_id: ReplayId,
    /// 0-based kyoku ordinal inside the game. `start_kyoku.kyoku` repeats every
    /// round, so the id uses this ordinal instead.
    pub kyoku_index: usize,
    /// The `start_kyoku.kyoku` field (1..=4).
    pub kyoku: u8,
    /// Index into the replay's event list of the event that resolves the choice.
    pub event_index: usize,
    /// 1-based line of that event in the decompressed JSONL.
    pub line: usize,
    /// The acting seat **before** normalisation.
    pub seat: usize,
    /// What kind of choice this is.
    pub kind: DecisionKind,
    /// The normalised table. The actor is `players[0]`.
    pub state: GameState,
    /// Every legal action for the actor, from [`crate::ai::actions`].
    pub legal_actions: Vec<ActionInfo>,
    /// The action the record actually played.
    pub played: ActionInfo,
    /// Whether `played` is one of `legal_actions`.
    pub played_is_legal: bool,
    /// The actor's winning tiles at a reaction decision (empty on a self turn).
    pub waits: Vec<String>,
    /// Whether the actor's own river already contains one of its waits
    /// (permanent furiten). Temporary furiten is not in the record.
    pub furiten: bool,
    /// Ura indicators from the kyoku result. Post-answer display only; never
    /// copied into `state`.
    pub ura_dora_indicators: Vec<String>,
    /// `tsumo` events consumed in this kyoku (the live-wall draws).
    pub wall_draws: u16,
    /// Non-fatal reconstruction notes for this decision.
    pub warnings: Vec<String>,
}

impl DecisionSnapshot {
    /// A `tenhou.net/6` log of this position for a human reviewer.
    ///
    /// The ura indicators are attached to a clone of the state, because the
    /// reviewer needs the whole record while the trainee must not see the ura
    /// before answering. The export is the existing writer's: East/South rounds
    /// only, and a state it cannot represent returns its typed error.
    pub fn review_export(&self) -> Result<Tenhou6Export, String> {
        let mut state = self.state.clone();
        state.ura_dora_indicators = self.ura_dora_indicators.clone();
        export_tenhou6(&state)
    }
}

/// A decision point the reconstruction had to drop, with the validator's reason.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkippedDecision {
    pub kyoku_index: usize,
    pub kyoku: u8,
    pub event_index: usize,
    pub line: usize,
    pub seat: usize,
    pub kind: DecisionKind,
    /// Why `validate_reachable_state` rejected the snapshot.
    pub reason: String,
}

/// The complete reconstruction of one replay.
#[derive(Debug, Clone, PartialEq)]
pub struct ReplayWalk {
    /// Content-addressed id of the log that was walked.
    pub replay_id: ReplayId,
    /// Events in the replay.
    pub events: usize,
    /// Kyoku started by the replay.
    pub kyoku_count: usize,
    /// Reconstructed decisions in replay order.
    pub decisions: Vec<DecisionSnapshot>,
    /// Decisions the reachability guard rejected.
    pub skipped: Vec<SkippedDecision>,
    /// Non-fatal reconstruction notes for the whole walk.
    pub warnings: Vec<String>,
}

impl ReplayWalk {
    /// True when no decision was rejected by the reachability guard.
    #[must_use]
    pub fn is_clean(&self) -> bool {
        self.skipped.is_empty()
    }

    /// Every decision of one kind, in replay order.
    pub fn of_kind(&self, kind: DecisionKind) -> impl Iterator<Item = &DecisionSnapshot> {
        self.decisions.iter().filter(move |d| d.kind == kind)
    }

    /// A reviewer log for every decision, paired with its decision id.
    ///
    /// The export is best-effort: a position the tenhou.net/6 writer cannot
    /// represent (for example a West-round state) reports its error instead of
    /// failing the walk.
    #[must_use]
    pub fn review_exports(&self) -> Vec<(&str, Result<Tenhou6Export, String>)> {
        self.decisions
            .iter()
            .map(|decision| (decision.decision_id.as_str(), decision.review_export()))
            .collect()
    }
}

/// Any reason the replay could not be walked at all.
///
/// A reachability rejection is **not** one of these; it is recorded per
/// decision in [`ReplayWalk::skipped`].
#[derive(Debug, Error)]
pub enum WalkError {
    /// The file could not be read.
    #[error("cannot read replay {path}: {source}")]
    Io {
        path: String,
        source: std::io::Error,
    },
    /// The gzip/JSONL reader rejected the file.
    #[error(transparent)]
    Parse(#[from] ParseError),
    /// The structural validator rejected the game.
    #[error(transparent)]
    Replay(#[from] ReplayError),
    /// `start_kyoku` named a round wind that is not E/S/W/N. R1 rejects this
    /// first; the variant is kept so the walker never guesses a round.
    #[error("`start_kyoku` names `{tile}` as `bakaze`, which is not a wind")]
    InvalidRoundWind { tile: String },
}

/// Decision id: `sha256(replay_id, kyoku_index, event_index)`.
#[must_use]
pub fn decision_id(replay_id: &ReplayId, kyoku_index: usize, event_index: usize) -> String {
    let canonical = format!("{}\n{kyoku_index}\n{event_index}", replay_id.as_str());
    sha256_hex(canonical.as_bytes())
}

/// Read, validate and walk a gzipped mjai replay from `path`.
///
/// The replay id is the SHA-256 of the raw file bytes, which is how the replay
/// store names the log (`replays/<family>/<replay_id>.jsonl.gz`).
pub fn walk_path(path: &Path) -> Result<ReplayWalk, WalkError> {
    let bytes = std::fs::read(path).map_err(|source| WalkError::Io {
        path: path.display().to_string(),
        source,
    })?;
    let file = ReplayReader::read_gzip(&bytes)?;
    let replay_id = ReplayId::from_bytes(&bytes);
    walk_replay(&file, replay_id)
}

/// Validate and walk an in-memory replay.
///
/// Structural validation is re-run here instead of trusting the caller, so a
/// reconstruction can never start from a game R1 would reject.
pub fn walk_replay(file: &ReplayFile, replay_id: ReplayId) -> Result<ReplayWalk, WalkError> {
    validate_game(file)?;
    let mut walker = Walker::new(replay_id, file.len());
    for (index, event) in file.events().iter().enumerate() {
        walker.on_event(index, event)?;
    }
    Ok(walker.finish())
}

// --- Live kyoku state -----------------------------------------------------

/// Where the current turn came from. A discard after a call is part of that
/// call, not a fresh decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Origin {
    None,
    Draw(u8),
    Call(u8),
}

/// One kyoku's reconstructed table.
struct Kyoku {
    index: usize,
    kyoku: u8,
    honba: u8,
    round_wind: Wind,
    dealer: usize,
    scores: [i32; 4],
    kyotaku: u8,
    hands: [Vec<MjaiTile>; 4],
    draws: [Option<MjaiTile>; 4],
    rivers: [Vec<DiscardTile>; 4],
    melds: [Vec<CalledMeld>; 4],
    riichi: [bool; 4],
    riichi_discard: [Option<usize>; 4],
    dora: Vec<MjaiTile>,
    wall_draws: u16,
    /// The most recent discard of each seat, kept as the exact mjai tile so a
    /// `hora` without a `pai` field can still name the winning tile.
    last_discard: [Option<MjaiTile>; 4],
    /// Indices into `Walker::decisions` for this kyoku, so the kyoku result can
    /// attach its ura markers.
    decision_slots: Vec<usize>,
}

impl Kyoku {
    fn new(index: usize, event: &EventKind) -> Option<Self> {
        let EventKind::StartKyoku {
            bakaze,
            dora_marker,
            kyoku,
            honba,
            kyotaku,
            oya,
            scores,
            tehais,
        } = event
        else {
            return None;
        };
        Some(Self {
            index,
            kyoku: *kyoku,
            honba: *honba,
            round_wind: round_wind(*bakaze)?,
            dealer: usize::from(*oya),
            scores: *scores,
            kyotaku: *kyotaku,
            hands: std::array::from_fn(|seat| tehais[seat].to_vec()),
            draws: [None; 4],
            rivers: std::array::from_fn(|_| Vec::new()),
            melds: std::array::from_fn(|_| Vec::new()),
            riichi: [false; 4],
            riichi_discard: [None; 4],
            dora: vec![*dora_marker],
            wall_draws: 0,
            last_discard: [None; 4],
            decision_slots: Vec::new(),
        })
    }

    /// Fold the active draw into the concealed hand. Any event that consumes or
    /// replaces the drawn tile ends the draw phase.
    fn merge_draw(&mut self, seat: usize) {
        if let Some(draw) = self.draws[seat].take() {
            self.hands[seat].push(draw);
        }
    }

    /// Remove one physical tile from the hand, then the draw.
    fn take_tile(&mut self, seat: usize, tile: MjaiTile) -> Result<(), String> {
        if let Some(position) = self.hands[seat].iter().position(|held| *held == tile) {
            self.hands[seat].remove(position);
            return Ok(());
        }
        if self.draws[seat] == Some(tile) {
            self.draws[seat] = None;
            return Ok(());
        }
        // A red five and its plain copy are the same tile kind to the engine; if
        // the record disagrees with the hand about which copy is red, take the
        // kind rather than failing the whole replay.
        if let Some(position) = self.hands[seat]
            .iter()
            .position(|held| held.same_kind(tile))
        {
            self.hands[seat].remove(position);
            return Ok(());
        }
        if self.draws[seat].is_some_and(|held| held.same_kind(tile)) {
            self.draws[seat] = None;
            return Ok(());
        }
        Err(format!(
            "seat {seat} does not hold `{tile}` to discard or call with"
        ))
    }

    /// The seat's concealed tile strings, draw included.
    fn concealed(&self, seat: usize) -> Vec<String> {
        self.hands[seat]
            .iter()
            .copied()
            .chain(self.draws[seat])
            .map(MjaiTile::app_name)
            .collect()
    }

    /// The seat's red fives, in the app's plain spelling.
    fn red_fives(&self, seat: usize) -> Vec<String> {
        self.hands[seat]
            .iter()
            .copied()
            .chain(self.draws[seat])
            .filter(|tile| tile.is_aka())
            .map(MjaiTile::app_name)
            .collect()
    }
}

/// A round wind, from the `bakaze` tile (`E`, `S`, `W`, `N`).
fn round_wind(tile: MjaiTile) -> Option<Wind> {
    match tile.kind() {
        27 => Some(Wind::East),
        28 => Some(Wind::South),
        29 => Some(Wind::West),
        30 => Some(Wind::North),
        _ => None,
    }
}

// --- Walker ---------------------------------------------------------------

struct Walker {
    replay_id: ReplayId,
    events: usize,
    kyoku: Option<Kyoku>,
    kyoku_count: usize,
    decisions: Vec<DecisionSnapshot>,
    skipped: Vec<SkippedDecision>,
    warnings: Vec<String>,
    origin: Origin,
    pending_reach: Option<u8>,
    /// The last `ankan`/`kakan` in the current turn: chankan attribution.
    last_kan: Option<(u8, MjaiTile)>,
}

impl Walker {
    fn new(replay_id: ReplayId, events: usize) -> Self {
        Self {
            replay_id,
            events,
            kyoku: None,
            kyoku_count: 0,
            decisions: Vec::new(),
            skipped: Vec::new(),
            warnings: Vec::new(),
            origin: Origin::None,
            pending_reach: None,
            last_kan: None,
        }
    }

    fn finish(self) -> ReplayWalk {
        ReplayWalk {
            replay_id: self.replay_id,
            events: self.events,
            kyoku_count: self.kyoku_count,
            decisions: self.decisions,
            skipped: self.skipped,
            warnings: self.warnings,
        }
    }

    fn on_event(&mut self, index: usize, event: &MjaiEvent) -> Result<(), WalkError> {
        let line = event.line;
        match &event.kind {
            EventKind::StartGame { .. } | EventKind::EndGame => {}
            EventKind::StartKyoku { .. } => {
                let kyoku = Kyoku::new(self.kyoku_count, &event.kind).ok_or_else(|| {
                    let tile = match &event.kind {
                        EventKind::StartKyoku { bakaze, .. } => bakaze.to_string(),
                        _ => String::new(),
                    };
                    WalkError::InvalidRoundWind { tile }
                })?;
                self.kyoku_count += 1;
                self.kyoku = Some(kyoku);
                self.origin = Origin::None;
                self.pending_reach = None;
                self.last_kan = None;
            }
            EventKind::Tsumo { actor, pai } => self.on_tsumo(*actor, *pai),
            EventKind::Dahai {
                actor,
                pai,
                tsumogiri,
            } => {
                if self.origin == Origin::Draw(*actor) && self.pending_reach != Some(*actor) {
                    self.decide(
                        index,
                        line,
                        DecisionKind::SelfTurn,
                        usize::from(*actor),
                        DecisionContext::SelfTurn,
                        Some(discard_action(*pai)),
                    );
                }
                self.on_dahai(*actor, *pai, *tsumogiri)?;
            }
            EventKind::Reach { actor } => {
                self.decide(
                    index,
                    line,
                    DecisionKind::SelfTurn,
                    usize::from(*actor),
                    DecisionContext::SelfTurn,
                    Some(riichi_action()),
                );
                self.pending_reach = Some(*actor);
            }
            EventKind::Ankan { actor, consumed } => {
                let tile = consumed[0];
                self.decide(
                    index,
                    line,
                    DecisionKind::SelfTurn,
                    usize::from(*actor),
                    DecisionContext::SelfTurn,
                    Some(kan_action(tile, KanKind::Ankan)),
                );
                self.on_ankan(*actor, consumed)?;
                self.last_kan = Some((*actor, tile));
            }
            EventKind::Kakan {
                actor,
                pai,
                consumed: _,
            } => {
                self.decide(
                    index,
                    line,
                    DecisionKind::SelfTurn,
                    usize::from(*actor),
                    DecisionContext::SelfTurn,
                    Some(kan_action(*pai, KanKind::Kakan)),
                );
                self.on_kakan(*actor, *pai)?;
                self.last_kan = Some((*actor, *pai));
            }
            EventKind::Chi {
                actor,
                target,
                pai,
                consumed,
            } => {
                self.decide(
                    index,
                    line,
                    DecisionKind::Call,
                    usize::from(*actor),
                    DecisionContext::ReactToDiscard {
                        from: usize::from(*target),
                        tile: pai.app_name(),
                    },
                    Some(chi_action(*pai, consumed)),
                );
                self.on_call(
                    *actor,
                    *target,
                    *pai,
                    consumed.iter().copied(),
                    MeldType::Chi,
                )?;
            }
            EventKind::Pon {
                actor,
                target,
                pai,
                consumed,
            } => {
                self.decide(
                    index,
                    line,
                    DecisionKind::Call,
                    usize::from(*actor),
                    DecisionContext::ReactToDiscard {
                        from: usize::from(*target),
                        tile: pai.app_name(),
                    },
                    Some(pon_action(*pai)),
                );
                self.on_call(
                    *actor,
                    *target,
                    *pai,
                    consumed.iter().copied(),
                    MeldType::Pon,
                )?;
            }
            EventKind::Daiminkan {
                actor,
                target,
                pai,
                consumed,
            } => {
                self.decide(
                    index,
                    line,
                    DecisionKind::Call,
                    usize::from(*actor),
                    DecisionContext::ReactToDiscard {
                        from: usize::from(*target),
                        tile: pai.app_name(),
                    },
                    Some(kan_action(*pai, KanKind::Daiminkan)),
                );
                self.on_call(
                    *actor,
                    *target,
                    *pai,
                    consumed.iter().copied(),
                    MeldType::Kan,
                )?;
            }
            EventKind::Dora { dora_marker } => {
                if let Some(kyoku) = &mut self.kyoku {
                    kyoku.dora.push(*dora_marker);
                }
            }
            EventKind::ReachAccepted { actor } => self.on_reach_accepted(*actor),
            EventKind::Hora {
                actor,
                target,
                pai,
                ura_markers,
                ..
            } => {
                let kind = if actor == target {
                    DecisionKind::SelfTurn
                } else if self.last_kan.is_some_and(|(seat, _)| seat == *target) {
                    DecisionKind::ReactToKan
                } else {
                    DecisionKind::ReactToDiscard
                };
                let mut tile = self.reaction_tile(kind, *target, *pai);
                if tile.is_none() && kind == DecisionKind::SelfTurn {
                    tile = self
                        .kyoku
                        .as_ref()
                        .and_then(|kyoku| kyoku.draws[usize::from(*actor)]);
                }
                if let Some(tile) = tile {
                    let context = match kind {
                        DecisionKind::SelfTurn => DecisionContext::SelfTurn,
                        DecisionKind::ReactToKan => DecisionContext::ReactToKan {
                            from: usize::from(*target),
                            tile: tile.app_name(),
                        },
                        DecisionKind::ReactToDiscard | DecisionKind::Call => {
                            DecisionContext::ReactToDiscard {
                                from: usize::from(*target),
                                tile: tile.app_name(),
                            }
                        }
                    };
                    let played = agari_action(kind, tile);
                    self.decide(
                        index,
                        line,
                        kind,
                        usize::from(*actor),
                        context,
                        Some(played),
                    );
                } else {
                    self.warnings.push(format!(
                        "event {index} (line {line}) names no winning tile; the decision is dropped"
                    ));
                }
                self.on_result(ura_markers.as_deref());
            }
            EventKind::Ryukyoku { ura_markers, .. } => {
                self.on_result(ura_markers.as_deref());
            }
            EventKind::EndKyoku => {
                self.kyoku = None;
                self.origin = Origin::None;
                self.pending_reach = None;
                self.last_kan = None;
            }
        }

        if !matches!(
            event.kind,
            EventKind::Ankan { .. } | EventKind::Kakan { .. }
        ) {
            self.last_kan = None;
        }
        Ok(())
    }

    fn on_tsumo(&mut self, actor: u8, pai: MjaiTile) {
        let Some(kyoku) = &mut self.kyoku else {
            return;
        };
        let seat = usize::from(actor);
        if kyoku.draws[seat].is_some() {
            self.warnings
                .push(format!("seat {actor} draws while still holding a draw"));
        }
        kyoku.draws[seat] = Some(pai);
        kyoku.wall_draws += 1;
        self.origin = Origin::Draw(actor);
    }

    fn on_dahai(&mut self, actor: u8, pai: MjaiTile, tsumogiri: bool) -> Result<(), WalkError> {
        let reach = self.pending_reach == Some(actor);
        self.pending_reach = None;
        let Some(kyoku) = &mut self.kyoku else {
            return Ok(());
        };
        let seat = usize::from(actor);
        if tsumogiri {
            // The drawn tile is the discard. It must leave the draw slot even
            // when the hand holds an identical copy, or the seat would lose a
            // tile.
            if kyoku.draws[seat] != Some(pai) {
                self.warnings.push(format!(
                    "seat {actor} discards `{pai}` tsumogiri but its draw is `{:?}`",
                    kyoku.draws[seat].map(|draw| draw.mjai_name())
                ));
            }
            kyoku.draws[seat] = None;
        } else {
            kyoku.merge_draw(seat);
            if let Err(reason) = kyoku.take_tile(seat, pai) {
                self.warnings.push(reason);
            }
        }
        let mut discard = DiscardTile::new(pai.app_name()).with_red(pai.is_aka());
        discard.is_tsumogiri = tsumogiri;
        if reach {
            discard.is_riichi = true;
            kyoku.riichi[seat] = true;
            kyoku.riichi_discard[seat] = Some(kyoku.rivers[seat].len());
        }
        kyoku.rivers[seat].push(discard);
        kyoku.last_discard[seat] = Some(pai);
        self.origin = Origin::None;
        Ok(())
    }

    fn on_ankan(&mut self, actor: u8, consumed: &[MjaiTile; 4]) -> Result<(), WalkError> {
        let Some(kyoku) = &mut self.kyoku else {
            return Ok(());
        };
        let seat = usize::from(actor);
        kyoku.merge_draw(seat);
        for tile in consumed {
            if let Err(reason) = kyoku.take_tile(seat, *tile) {
                self.warnings.push(reason);
            }
        }
        kyoku.melds[seat].push(CalledMeld {
            meld_type: MeldType::Ankan,
            tiles: consumed.iter().map(|tile| tile.app_name()).collect(),
            called_from: None,
        });
        self.origin = Origin::None;
        Ok(())
    }

    fn on_kakan(&mut self, actor: u8, pai: MjaiTile) -> Result<(), WalkError> {
        let Some(kyoku) = &mut self.kyoku else {
            return Ok(());
        };
        let seat = usize::from(actor);
        kyoku.merge_draw(seat);
        if let Err(reason) = kyoku.take_tile(seat, pai) {
            self.warnings.push(reason);
        }
        let name = pai.app_name();
        let pon = kyoku.melds[seat]
            .iter_mut()
            .find(|meld| meld.meld_type == MeldType::Pon && meld.tiles.first() == Some(&name));
        match pon {
            Some(meld) => {
                meld.meld_type = MeldType::Kan;
                meld.tiles.push(name);
            }
            None => self.warnings.push(format!(
                "seat {actor} adds `{name}` to a kan but has no Pon of it"
            )),
        }
        self.origin = Origin::None;
        Ok(())
    }

    fn on_call(
        &mut self,
        actor: u8,
        target: u8,
        pai: MjaiTile,
        consumed: impl Iterator<Item = MjaiTile>,
        meld_type: MeldType,
    ) -> Result<(), WalkError> {
        let Some(kyoku) = &mut self.kyoku else {
            return Ok(());
        };
        let seat = usize::from(actor);
        let consumed: Vec<MjaiTile> = consumed.collect();
        for tile in &consumed {
            if let Err(reason) = kyoku.take_tile(seat, *tile) {
                self.warnings.push(reason);
            }
        }
        let mut tiles = vec![pai.app_name()];
        tiles.extend(consumed.iter().map(|tile| tile.app_name()));
        kyoku.melds[seat].push(CalledMeld {
            meld_type,
            tiles,
            called_from: Some(usize::from(target)),
        });
        self.origin = Origin::Call(actor);
        Ok(())
    }

    fn on_reach_accepted(&mut self, actor: u8) {
        let Some(kyoku) = &mut self.kyoku else {
            return;
        };
        let seat = usize::from(actor);
        kyoku.scores[seat] -= 1000;
        kyoku.kyotaku = kyoku.kyotaku.saturating_add(1);
    }

    /// The tile a reaction is about: the `hora.pai` when the writer recorded it,
    /// otherwise the source's last discard.
    fn reaction_tile(
        &self,
        kind: DecisionKind,
        target: u8,
        pai: Option<MjaiTile>,
    ) -> Option<MjaiTile> {
        if let Some(pai) = pai {
            return Some(pai);
        }
        let kyoku = self.kyoku.as_ref()?;
        match kind {
            DecisionKind::ReactToKan => self
                .last_kan
                .filter(|(seat, _)| *seat == target)
                .map(|(_, tile)| tile),
            DecisionKind::ReactToDiscard => kyoku.last_discard[usize::from(target)],
            _ => None,
        }
    }

    /// Attach the kyoku result's ura markers to every decision of that kyoku.
    fn on_result(&mut self, ura_markers: Option<&[MjaiTile]>) {
        let Some(kyoku) = &mut self.kyoku else {
            return;
        };
        let Some(ura) = ura_markers else {
            return;
        };
        let codes: Vec<String> = ura.iter().map(|tile| tile.app_name()).collect();
        for slot in &kyoku.decision_slots {
            self.decisions[*slot].ura_dora_indicators = codes.clone();
        }
    }

    /// Build, finalize, validate and record one decision.
    fn decide(
        &mut self,
        event_index: usize,
        line: usize,
        kind: DecisionKind,
        seat: usize,
        context: DecisionContext,
        played: Option<ActionInfo>,
    ) {
        let Some(played) = played else {
            self.warnings.push(format!(
                "event {event_index} (line {line}) has no representable played action"
            ));
            return;
        };
        let Some(kyoku) = self.kyoku.as_ref() else {
            return;
        };
        let (kyoku_index, kyoku_number, wall_draws) = (kyoku.index, kyoku.kyoku, kyoku.wall_draws);
        let mut warnings = Vec::new();
        let state = kyoku.build_state(seat, kind, context, &played, &mut warnings);
        let state = finalize_state(state);
        let mut snapshot = DecisionSnapshot {
            decision_id: decision_id(&self.replay_id, kyoku_index, event_index),
            replay_id: self.replay_id.clone(),
            kyoku_index,
            kyoku: kyoku_number,
            event_index,
            line,
            seat,
            kind,
            state,
            legal_actions: Vec::new(),
            played,
            played_is_legal: false,
            waits: Vec::new(),
            furiten: false,
            ura_dora_indicators: Vec::new(),
            wall_draws,
            warnings,
        };
        snapshot.legal_actions = legal_actions(&snapshot.state);
        let (waits, furiten) = furiten_of(&snapshot.state);
        if let Err(reason) = validate_reachable_state(&snapshot.state) {
            self.skipped.push(SkippedDecision {
                kyoku_index,
                kyoku: kyoku_number,
                event_index,
                line,
                seat,
                kind,
                reason,
            });
            return;
        }
        // Furiten is not a field of `GameState`, so a ron by a player whose own
        // river holds a wait cannot be explained by the reconstructed table. The
        // record is impossible (or the reconstruction is wrong), so the decision
        // is triaged instead of shipped with a silently wrong answer.
        if snapshot.played.action == "Agari" && furiten {
            self.skipped.push(SkippedDecision {
                kyoku_index,
                kyoku: kyoku_number,
                event_index,
                line,
                seat,
                kind,
                reason: format!(
                    "seat {seat} rons while its own river holds a wait ({}); the state model \
                     has no furiten field",
                    waits.join(" ")
                ),
            });
            return;
        }
        snapshot.played_is_legal = snapshot
            .legal_actions
            .iter()
            .any(|legal| same_action(legal, &snapshot.played));
        if !snapshot.played_is_legal {
            snapshot.warnings.push(format!(
                "the record played `{}` but the app's legal-action set does not offer it",
                snapshot.played.action
            ));
        }
        snapshot.waits = waits;
        snapshot.furiten = furiten;
        let slot = self.decisions.len();
        self.decisions.push(snapshot);
        if let Some(kyoku) = &mut self.kyoku {
            kyoku.decision_slots.push(slot);
        }
    }
}

impl Kyoku {
    /// Rotate the table so `actor` is `players[0]` and fill every `GameState`
    /// field the app reads.
    fn build_state(
        &self,
        actor: usize,
        kind: DecisionKind,
        context: DecisionContext,
        played: &ActionInfo,
        warnings: &mut Vec<String>,
    ) -> GameState {
        let actor_wind = Wind::East.next((actor + 4 - self.dealer) % 4);
        let players: Vec<PlayerState> = (0..4)
            .map(|index| {
                let old = (actor + index) % 4;
                PlayerState {
                    seat: index,
                    name: SEAT_NAMES[index].to_string(),
                    is_human: index == 0,
                    wind: actor_wind.next(index),
                    score: self.scores[old],
                    hand: self.hands[old].iter().map(|tile| tile.app_name()).collect(),
                    draw: self.draws[old].map(MjaiTile::app_name),
                    red_fives: self.red_fives(old),
                    discards: self.rivers[old].clone(),
                    melds: self.melds[old]
                        .iter()
                        .map(|meld| CalledMeld {
                            meld_type: meld.meld_type,
                            tiles: meld.tiles.clone(),
                            called_from: meld.called_from.map(|from| (from + 4 - actor) % 4),
                        })
                        .collect(),
                    is_riichi: self.riichi[old],
                    riichi_discard_index: self.riichi_discard[old],
                }
            })
            .collect();

        let concealed = self.concealed(actor);
        let mut full_tiles: Vec<AgariTile> = concealed
            .iter()
            .filter_map(|code| AgariTile::try_from(code.as_str()).ok())
            .collect();
        full_tiles.sort();
        let metrics = evaluate_hand(&full_tiles);
        let hand_string = format_hand_compact(&full_tiles);
        let tiles: Vec<String> = full_tiles.iter().map(ToString::to_string).collect();

        let (current_turn, decision) = match context {
            DecisionContext::SelfTurn => (0, DecisionContext::SelfTurn),
            DecisionContext::ReactToDiscard { from, tile } => (
                (from + 4 - actor) % 4,
                DecisionContext::ReactToDiscard {
                    from: (from + 4 - actor) % 4,
                    tile,
                },
            ),
            DecisionContext::ReactToKan { from, tile } => (
                (from + 4 - actor) % 4,
                DecisionContext::ReactToKan {
                    from: (from + 4 - actor) % 4,
                    tile,
                },
            ),
        };

        let call_offer = match kind {
            DecisionKind::Call => call_offer_for(played),
            _ => None,
        };
        if kind == DecisionKind::Call && call_offer.is_none() {
            warnings.push("a call decision has no call offer".to_string());
        }

        // R1 already rejects a kyoku that draws more than the live wall allows;
        // this keeps the snapshot's wall tied to the event stream it walked.
        debug_assert!(
            self.wall_draws <= WALL_DRAWS,
            "the walk counted {} wall draws in one kyoku",
            self.wall_draws
        );
        let tiles_remaining = WALL_DRAWS.saturating_sub(self.wall_draws).min(255) as u8;
        GameState {
            category: format!("replay_{}", kind.as_str()),
            target_action: if kind == DecisionKind::Call {
                TargetAction::Call
            } else {
                TargetAction::Best
            },
            // Provisional: the record's played action. The classifier/labeler
            // replaces it; see the module docs.
            correct_action: CorrectAction::best(
                played.action.clone(),
                played.tile.clone(),
                played.tiles.clone(),
                played.label.clone(),
            ),
            equivalent_tiles: Vec::new(),
            decision,
            scenario_note: None,
            call_offer,
            ai_decision: None,
            riichi_triggers: Vec::new(),
            dama_reasons: Vec::new(),
            shouminkan_triggers: Vec::new(),
            book_rationale: None,
            can_riichi: false,
            hand_string,
            tiles,
            shanten: metrics.shanten,
            is_agari: metrics.is_agari,
            decompositions_count: metrics.decompositions_count,
            ukeire_tiles: metrics.ukeire_tiles,
            ukeire_total: metrics.ukeire_total,
            round_wind: self.round_wind,
            hand_number: self.kyoku,
            honba: self.honba,
            riichi_sticks: self.kyotaku,
            dora_indicators: self.dora.iter().map(|tile| tile.app_name()).collect(),
            ura_dora_indicators: Vec::new(),
            tiles_remaining,
            current_turn,
            players,
        }
    }
}

// --- Action and offer construction ---------------------------------------

/// The Mortal action for one played discard.
fn discard_action(tile: MjaiTile) -> ActionInfo {
    discard_info(&tile.app_name(), tile.is_aka()).unwrap_or_else(|| ActionInfo {
        action: format!("Discard_{}", tile.app_name()),
        label: format!("Discard {}", tile.app_name()),
        kind: ActionKind::Discard,
        tile_index: None,
        tile: Some(tile.app_name()),
        tiles: Vec::new(),
        kan_kind: None,
    })
}

fn riichi_action() -> ActionInfo {
    ActionInfo {
        action: "Riichi".to_string(),
        label: "Riichi".to_string(),
        kind: ActionKind::Riichi,
        tile_index: None,
        tile: None,
        tiles: Vec::new(),
        kan_kind: None,
    }
}

fn kan_action(tile: MjaiTile, kan_kind: KanKind) -> ActionInfo {
    let name = tile.app_name();
    let prefix = match kan_kind {
        KanKind::Daiminkan => "Daiminkan",
        KanKind::Ankan => "Ankan",
        KanKind::Kakan => "Kakan",
    };
    ActionInfo {
        action: "Kan".to_string(),
        label: format!(
            "{prefix} {}",
            crate::display::format_tile_for_display(&name, false)
        ),
        kind: ActionKind::Kan,
        tile_index: crate::ai::encoder::tile_index(&name),
        tile: Some(name),
        tiles: Vec::new(),
        kan_kind: Some(kan_kind),
    }
}

fn agari_action(kind: DecisionKind, tile: MjaiTile) -> ActionInfo {
    let name = tile.app_name();
    let label = match kind {
        DecisionKind::SelfTurn => "Tsumo".to_string(),
        DecisionKind::ReactToKan => format!(
            "Chankan {}",
            crate::display::format_tile_for_display(&name, false)
        ),
        _ => format!(
            "Ron {}",
            crate::display::format_tile_for_display(&name, false)
        ),
    };
    ActionInfo {
        action: "Agari".to_string(),
        label,
        kind: ActionKind::Agari,
        tile_index: crate::ai::encoder::tile_index(&name),
        tile: Some(name),
        tiles: Vec::new(),
        kan_kind: None,
    }
}

fn pon_action(tile: MjaiTile) -> ActionInfo {
    let name = tile.app_name();
    ActionInfo {
        action: "Pon".to_string(),
        label: format!(
            "Pon {}",
            crate::display::format_tile_for_display(&name, false)
        ),
        kind: ActionKind::Pon,
        tile_index: crate::ai::encoder::tile_index(&name),
        tile: Some(name),
        tiles: Vec::new(),
        kan_kind: None,
    }
}

fn chi_action(pai: MjaiTile, consumed: &[MjaiTile; 2]) -> ActionInfo {
    let mut kinds = [pai.kind(), consumed[0].kind(), consumed[1].kind()];
    kinds.sort_unstable();
    let action = if pai.kind() == kinds[0] {
        "Chi_Low"
    } else if pai.kind() == kinds[2] {
        "Chi_High"
    } else {
        "Chi_Mid"
    };
    let mut codes: Vec<String> = consumed.iter().map(|tile| tile.app_name()).collect();
    codes.sort();
    ActionInfo {
        action: action.to_string(),
        label: format!(
            "Chi {} {} on {}",
            crate::display::format_tile_for_display(&codes[0], false),
            crate::display::format_tile_for_display(&codes[1], false),
            crate::display::format_tile_for_display(&pai.app_name(), false)
        ),
        kind: ActionKind::Chi,
        tile_index: crate::ai::encoder::tile_index(&pai.app_name()),
        tile: Some(pai.app_name()),
        tiles: codes,
        kan_kind: None,
    }
}

/// The [`CallOffer`] a call decision presents to the UI.
fn call_offer_for(played: &ActionInfo) -> Option<CallOffer> {
    let action = match played.kind {
        ActionKind::Pon => "Pon",
        ActionKind::Chi => "Chi",
        ActionKind::Kan if played.kan_kind == Some(KanKind::Daiminkan) => "Kan",
        _ => return None,
    };
    Some(CallOffer {
        action: action.to_string(),
        label: played.label.clone(),
        tile: played.tile.clone()?,
        tiles: played.tiles.clone(),
    })
}

/// Whether two actions are the same choice. The Mortal name already encodes the
/// red-five identity, the chi shape and the tile, so the name plus the tile
/// index is enough.
fn same_action(a: &ActionInfo, b: &ActionInfo) -> bool {
    a.action == b.action && a.tile_index == b.tile_index
}

/// The actor's waits and permanent furiten at a reaction decision.
///
/// A self turn offers no ron, so it has no wait set to be furiten against.
fn furiten_of(state: &GameState) -> (Vec<String>, bool) {
    if matches!(state.decision, DecisionContext::SelfTurn) {
        return (Vec::new(), false);
    }
    let player = &state.players[0];
    if player.hand.len() % 3 != 1 {
        return (Vec::new(), false);
    }
    let tiles: Vec<AgariTile> = player
        .hand
        .iter()
        .filter_map(|code| AgariTile::try_from(code.as_str()).ok())
        .collect();
    let counts = to_counts(&tiles);
    let ukeire = calculate_ukeire_with_melds(&counts, player.melds.len() as u8);
    if ukeire.shanten != 0 {
        return (Vec::new(), false);
    }
    let waits: Vec<String> = ukeire
        .tiles
        .iter()
        .map(|ukeire| ukeire.tile.to_string())
        .collect();
    let furiten = waits
        .iter()
        .any(|wait| player.discards.iter().any(|discard| discard.tile == *wait));
    (waits, furiten)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;
    use crate::replay::fixtures;

    /// Parse, validate and walk a fixture event list through the real gzip path,
    /// so the replay id is the log's content hash.
    fn walk(events: &[EventKind]) -> ReplayWalk {
        let text = fixtures::to_jsonl(events);
        let bytes = fixtures::gzip(&text);
        let file = ReplayReader::read_gzip(&bytes).expect("fixture must parse");
        walk_replay(&file, ReplayId::from_bytes(&bytes)).expect("fixture must validate")
    }

    #[test]
    fn the_first_decision_is_the_dealers_draw_before_the_discard() {
        let walk = walk(&fixtures::all_events_game());
        assert!(walk.is_clean(), "{:?}", walk.skipped);
        let first = &walk.decisions[0];

        assert_eq!(first.kind, DecisionKind::SelfTurn);
        assert_eq!(first.seat, 0);
        assert_eq!(first.event_index, 3, "the `dahai` of 9m resolves it");
        assert_eq!(first.line, 4);
        assert_eq!(first.kyoku_index, 0);
        assert_eq!(first.kyoku, 1);
        assert_eq!(first.state.players[0].draw.as_deref(), Some("9m"));
        assert_eq!(first.state.players[0].hand.len(), 13);
        assert_eq!(first.state.tiles_remaining, 69);
        assert_eq!(first.state.current_turn, 0);
        assert_eq!(first.state.dora_indicators, vec!["5z".to_string()]);
        assert_eq!(first.state.hand_number, 1);
        assert_eq!(first.state.round_wind, Wind::East);
        assert_eq!(first.played.action, "Discard_9m");
        assert!(first.played_is_legal);
        assert_eq!(first.wall_draws, 1);
        assert!(first.state.can_riichi, "the dealt hand is already tenpai");
        assert_eq!(first.state.book_rationale, None);
        assert_eq!(first.state.category, "replay_self_turn");
    }

    #[test]
    fn a_red_five_keeps_its_identity_out_of_band() {
        let walk = walk(&fixtures::all_events_game());
        let first = &walk.decisions[0];

        assert!(
            first.state.players[0].red_fives.contains(&"5m".to_string()),
            "the dealt 5mr must be recorded as a red five"
        );
        assert!(
            first.state.tiles.contains(&"5m".to_string()),
            "the tile set stays in the app's plain spelling"
        );
        assert!(
            first
                .legal_actions
                .iter()
                .any(|action| action.action == "Discard_5mr"),
            "the only 5m held is red"
        );
        assert!(
            !first
                .legal_actions
                .iter()
                .any(|action| action.action == "Discard_5m"),
            "a plain discard of a hand holding only the red five is impossible"
        );
    }

    #[test]
    fn a_chi_is_rotated_so_the_caller_is_seat_zero() {
        let walk = walk(&fixtures::all_events_game());
        let call = walk
            .decisions
            .iter()
            .find(|decision| decision.kind == DecisionKind::Call)
            .expect("the fixture has a chi");

        assert_eq!(call.seat, 1);
        assert_eq!(call.state.players[0].wind, Wind::South);
        assert_eq!(
            call.state.decision,
            DecisionContext::ReactToDiscard {
                from: 3,
                tile: "9m".to_string(),
            }
        );
        assert_eq!(call.state.current_turn, 3);
        assert_eq!(
            call.state.players[0].discards.len(),
            0,
            "the caller has not discarded yet"
        );
        let offer = call
            .state
            .call_offer
            .as_ref()
            .expect("a call offers itself");
        assert_eq!(offer.action, "Chi");
        assert_eq!(offer.tile, "9m");
        assert_eq!(offer.tiles, vec!["7m".to_string(), "8m".to_string()]);
        assert_eq!(call.state.target_action, TargetAction::Call);
        assert!(call.played.action.starts_with("Chi_"));
        assert!(call.played_is_legal);
        // The state is the position *before* the call: the caller still holds
        // 13 tiles, has no meld yet, and the offer is what it may take.
        let caller = &call.state.players[0];
        assert_eq!(caller.hand.len(), 13);
        assert!(caller.melds.is_empty());
        assert_eq!(caller.draw, None);
    }

    #[test]
    fn the_riichi_decision_precedes_its_discard() {
        let walk = walk(&fixtures::all_events_game());
        let riichi = walk
            .decisions
            .iter()
            .find(|decision| decision.played.action == "Riichi")
            .expect("the fixture declares riichi");

        assert_eq!(riichi.kind, DecisionKind::SelfTurn);
        assert_eq!(riichi.state.current_turn, 0);
        assert!(
            riichi.state.players[0].draw.is_some(),
            "a riichi is declared on a discard, so the draw is still active"
        );
        assert!(!riichi.state.players[0].is_riichi, "not declared yet");
        assert_eq!(riichi.state.target_action, TargetAction::Best);
        assert!(
            riichi
                .legal_actions
                .iter()
                .any(|action| action.action == "Riichi"),
            "the app must offer the declaration the record made"
        );

        // The discard that follows the declaration is part of the same action,
        // so it must not produce a second decision for that seat.
        assert!(
            !walk.decisions.iter().any(|decision| {
                decision.event_index == riichi.event_index + 1 && decision.seat == riichi.seat
            }),
            "the riichi discard was turned into a second decision"
        );
    }

    #[test]
    fn a_ron_is_a_reaction_with_waits_and_no_draw() {
        let walk = walk(&fixtures::all_events_game());
        let ron = walk
            .decisions
            .iter()
            .find(|decision| decision.played.action == "Agari")
            .expect("the fixture ends on a ron");

        assert_eq!(ron.kind, DecisionKind::ReactToDiscard);
        assert_eq!(ron.played.label, "Ron 1s");
        assert_eq!(ron.state.players[0].draw, None);
        assert!(ron.state.players[0].is_riichi);
        assert!(ron.waits.contains(&"1s".to_string()), "{:?}", ron.waits);
        assert!(!ron.furiten);
        assert!(ron.played_is_legal);
        match &ron.state.decision {
            DecisionContext::ReactToDiscard { from, tile } => {
                assert_eq!(tile, "1s");
                assert_eq!(*from, ron.state.current_turn);
                assert_ne!(*from, 0);
                assert_eq!(
                    ron.state.players[*from]
                        .discards
                        .last()
                        .map(|d| d.tile.as_str()),
                    Some("1s")
                );
            }
            other => panic!("expected a discard reaction, got {other:?}"),
        }
    }

    #[test]
    fn a_robbed_kakan_is_a_kan_reaction() {
        let walk = walk(&fixtures::chankan_game());
        assert!(walk.is_clean(), "{:?}", walk.skipped);
        let chankan = walk
            .decisions
            .iter()
            .find(|decision| decision.kind == DecisionKind::ReactToKan)
            .expect("the fixture robs a kan");

        assert_eq!(chankan.seat, 1);
        assert_eq!(chankan.played.label, "Chankan 5s");
        assert_eq!(chankan.played.action, "Agari");
        assert!(chankan.waits.contains(&"5s".to_string()));
        assert!(chankan.played_is_legal);
        assert_eq!(chankan.state.players[0].draw, None);
        match &chankan.state.decision {
            DecisionContext::ReactToKan { from, tile } => {
                assert_eq!(tile, "5s");
                assert_eq!(*from, 1, "the robber's toimen holds the upgraded kan");
                let source = &chankan.state.players[*from];
                assert!(
                    source
                        .melds
                        .iter()
                        .any(|meld| meld.meld_type == MeldType::Kan
                            && meld.tiles.len() == 4
                            && meld.tiles.iter().all(|held| held == "5s"))
                );
            }
            other => panic!("expected a kan reaction, got {other:?}"),
        }
    }

    #[test]
    fn a_robbed_ankan_is_skipped_with_its_reason() {
        let walk = walk(&fixtures::ankan_chankan_game());

        assert_eq!(
            walk.skipped.len(),
            1,
            "the robbed ankan is the documented validator gap"
        );
        let skip = &walk.skipped[0];
        assert_eq!(skip.kind, DecisionKind::ReactToKan);
        assert_eq!(skip.seat, 1);
        assert!(
            skip.reason.contains("no four-tile kan"),
            "the reason must name the gap: {}",
            skip.reason
        );
        assert!(
            walk.decisions
                .iter()
                .all(|decision| decision.kind != DecisionKind::ReactToKan),
            "a skipped decision must never be emitted"
        );
        // Everything before the robbery is still a normal reconstruction.
        assert!(
            walk.decisions
                .iter()
                .any(|decision| decision.kind == DecisionKind::SelfTurn && decision.seat == 2)
        );
    }

    #[test]
    fn a_furiten_ron_is_triaged_instead_of_reconstructed() {
        let walk = walk(&fixtures::furiten_ron_game());

        assert_eq!(walk.skipped.len(), 1, "{:?}", walk.skipped);
        let skip = &walk.skipped[0];
        assert_eq!(skip.kind, DecisionKind::ReactToDiscard);
        assert_eq!(skip.seat, 1);
        assert!(
            skip.reason.contains("furiten"),
            "the reason must name furiten: {}",
            skip.reason
        );
        assert!(
            walk.decisions
                .iter()
                .all(|decision| decision.played.action != "Agari"),
            "a furiten ron must never be emitted"
        );
    }

    #[test]
    fn every_decision_kind_is_reached() {
        let mut kinds = BTreeSet::new();
        for game in [
            fixtures::all_events_game(),
            fixtures::chankan_game(),
            fixtures::exhaustive_game(1),
        ] {
            let walk = walk(&game);
            kinds.extend(walk.decisions.iter().map(|decision| decision.kind));
        }

        for kind in [
            DecisionKind::SelfTurn,
            DecisionKind::Call,
            DecisionKind::ReactToDiscard,
            DecisionKind::ReactToKan,
        ] {
            assert!(
                kinds.contains(&kind),
                "no `{kind}` decision was reconstructed"
            );
        }
    }

    #[test]
    fn every_fixture_snapshot_is_reachable_and_legal() {
        let mut games = vec![fixtures::all_events_game(), fixtures::chankan_game()];
        games.push(fixtures::exhaustive_game(1));
        games.push(fixtures::two_kyoku_game());
        games.extend(fixtures::synthetic_games(10));

        for (index, game) in games.iter().enumerate() {
            let walk = walk(game);
            assert!(
                walk.is_clean(),
                "game {index}: skipped decisions {:?}",
                walk.skipped
            );
            assert!(!walk.decisions.is_empty(), "game {index} has no decisions");
            for decision in &walk.decisions {
                assert!(
                    decision.played_is_legal,
                    "game {index} event {}: played `{}` is not legal in {:?}",
                    decision.event_index, decision.played.action, decision.legal_actions
                );
                assert!(
                    decision.warnings.is_empty(),
                    "game {index} event {}: {:?}",
                    decision.event_index,
                    decision.warnings
                );
                assert!(
                    decision
                        .legal_actions
                        .iter()
                        .any(|action| same_action(action, &decision.played)),
                    "game {index}: the played action is missing from the legal set"
                );
            }
        }
    }

    #[test]
    fn one_hundred_fixture_games_produce_no_invalid_states() {
        let mut decisions = 0usize;
        let mut walldraws = 0usize;
        let mut illegal = Vec::new();
        for (seed, game) in fixtures::synthetic_games(100).iter().enumerate() {
            let walk = walk(game);
            assert!(walk.is_clean(), "seed {seed}: {:?}", walk.skipped.first());
            assert_eq!(walk.kyoku_count, 1, "seed {seed}");
            decisions += walk.decisions.len();
            walldraws += walk
                .decisions
                .last()
                .map(|decision| usize::from(decision.wall_draws))
                .unwrap_or_default();
            for decision in &walk.decisions {
                assert!(
                    decision.warnings.is_empty(),
                    "seed {seed} event {}: {:?}",
                    decision.event_index,
                    decision.warnings
                );
                if !decision.played_is_legal {
                    illegal.push((
                        seed,
                        decision.event_index,
                        decision.played.action.clone(),
                        decision.state.tiles_remaining,
                        decision
                            .legal_actions
                            .iter()
                            .map(|a| a.action.clone())
                            .collect::<Vec<_>>(),
                    ));
                }
            }
        }
        assert!(
            decisions > 1_000,
            "only {decisions} decisions reconstructed"
        );
        assert!(walldraws > 0);
        assert!(
            illegal.is_empty(),
            "the record played an action the app's legal set refuses: {illegal:?}"
        );
    }

    #[test]
    fn walking_the_same_replay_twice_is_deterministic() {
        let game = fixtures::all_events_game();
        let first = walk(&game);
        let second = walk(&game);

        assert_eq!(first, second);
        let ids: BTreeSet<&str> = first
            .decisions
            .iter()
            .map(|decision| decision.decision_id.as_str())
            .collect();
        assert_eq!(ids.len(), first.decisions.len(), "decision ids collide");
        for decision in &first.decisions {
            assert_eq!(
                decision.decision_id,
                decision_id(&first.replay_id, decision.kyoku_index, decision.event_index)
            );
        }
    }

    #[test]
    fn decision_ids_are_content_and_position_addressed() {
        let replay = ReplayId::from_bytes(b"a log");
        let other = ReplayId::from_bytes(b"another log");
        let id = decision_id(&replay, 0, 3);

        assert_eq!(id.len(), 64);
        assert_eq!(id, decision_id(&replay, 0, 3));
        assert_ne!(id, decision_id(&replay, 1, 3));
        assert_ne!(id, decision_id(&replay, 0, 4));
        assert_ne!(id, decision_id(&other, 0, 3));
    }

    #[test]
    fn tiles_remaining_is_the_replay_wall_count() {
        let walk = walk(&fixtures::exhaustive_game(1));
        let counts: Vec<u8> = walk
            .of_kind(DecisionKind::SelfTurn)
            .map(|decision| decision.state.tiles_remaining)
            .collect();

        assert_eq!(
            counts.first().copied(),
            Some(69),
            "the dealer's opening draw is the first wall tile"
        );
        assert_eq!(counts.last().copied(), Some(0), "the last turn has no wall");
        assert!(
            counts.windows(2).all(|pair| pair[0] >= pair[1]),
            "the wall only shrinks"
        );
        let last = walk.decisions.last().expect("decisions exist");
        assert_eq!(last.wall_draws, 70);
    }

    #[test]
    fn a_kan_dora_is_only_visible_from_its_own_event() {
        let walk = walk(&fixtures::all_events_game());
        let before: Vec<Vec<String>> = walk
            .decisions
            .iter()
            .map(|decision| decision.state.dora_indicators.clone())
            .collect();

        assert!(before.iter().all(|dora| !dora.is_empty()));
        assert!(before.iter().any(|dora| dora.len() == 1));
        assert!(before.iter().any(|dora| dora.len() == 4));
        let mut lengths: Vec<usize> = before.iter().map(Vec::len).collect();
        lengths.dedup();
        assert_eq!(lengths, vec![1, 2, 3, 4], "{before:?}");
    }

    #[test]
    fn ura_indicators_are_stored_but_never_in_the_state() {
        let walk = walk(&fixtures::all_events_game());
        let last = walk.decisions.last().expect("decisions exist");

        assert_eq!(
            last.ura_dora_indicators,
            vec!["2z".to_string(); 4],
            "the ron records four ura markers (1 + three kans)"
        );
        assert!(
            walk.decisions
                .iter()
                .all(|decision| decision.state.ura_dora_indicators.is_empty()),
            "a pre-answer state must not carry the ura"
        );
    }

    #[test]
    fn the_review_export_is_a_loadable_tenhou6_log() {
        let walk = walk(&fixtures::all_events_game());
        let self_turn = walk
            .decisions
            .iter()
            .find(|decision| decision.kind == DecisionKind::SelfTurn)
            .expect("a self turn");
        let ron = walk
            .decisions
            .iter()
            .find(|decision| decision.kind == DecisionKind::ReactToDiscard)
            .expect("a ron");

        let export = self_turn.review_export().expect("self turn exports");
        assert!(
            !export
                .warnings
                .iter()
                .any(|warning| warning.contains("tiles_remaining")),
            "{:?}",
            export.warnings
        );
        assert_eq!(
            export.summary.implied_tiles_left,
            i32::from(self_turn.state.tiles_remaining),
            "the reviewer must see the replay's wall"
        );
        let document: serde_json::Value =
            serde_json::from_str(&export.json).expect("the log must be JSON");
        assert_eq!(document["rule"]["disp"], "般南喰赤");
        assert!(document["log"].as_array().is_some_and(|log| log.len() == 1));
        assert!(export.summary.log_bytes > 0);

        let export = ron.review_export().expect("a ron exports");
        assert!(
            !export
                .warnings
                .iter()
                .any(|warning| warning.contains("tiles_remaining")),
            "{:?}",
            export.warnings
        );
        assert_eq!(
            export.summary.implied_tiles_left,
            i32::from(ron.state.tiles_remaining)
        );
        let document: serde_json::Value = serde_json::from_str(&export.json).unwrap();
        let kyoku = document["log"][0].as_array().expect("a kyoku tuple");
        assert!(
            !kyoku[3].as_array().expect("ura indicators").is_empty(),
            "the reviewer log carries the record's ura indicators"
        );
        assert_eq!(
            walk.review_exports().len(),
            walk.decisions.len(),
            "every decision gets a review export attempt"
        );
    }

    #[test]
    fn seat_rotation_of_the_live_kyoku_normalises_identically() {
        let kyoku = sample_kyoku();
        let played = ActionInfo {
            action: "Discard_9m".to_string(),
            label: "Discard 9m".to_string(),
            kind: ActionKind::Discard,
            tile_index: crate::ai::encoder::tile_index("9m"),
            tile: Some("9m".to_string()),
            tiles: Vec::new(),
            kan_kind: None,
        };
        let mut warnings = Vec::new();
        let base = kyoku.build_state(
            1,
            DecisionKind::SelfTurn,
            DecisionContext::SelfTurn,
            &played,
            &mut warnings,
        );
        assert!(warnings.is_empty(), "{warnings:?}");

        for shift in 1..4usize {
            let rotated = rotate_kyoku(&kyoku, shift);
            let mut warnings = Vec::new();
            let other = rotated.build_state(
                (1 + shift) % 4,
                DecisionKind::SelfTurn,
                DecisionContext::SelfTurn,
                &played,
                &mut warnings,
            );
            assert!(warnings.is_empty(), "{warnings:?}");
            assert_eq!(base, other, "shift {shift}: the actor's table changed");
        }
    }

    #[test]
    fn a_four_meld_hand_still_reconstructs() {
        let mut kyoku = sample_kyoku();
        let tile = |code: &str| MjaiTile::parse(code).expect("a fixture tile");
        // Seat 1 holds four called melds, so its concealed hand is one tile.
        kyoku.hands[1] = vec![tile("2s")];
        kyoku.melds[1] = ["1p", "2p", "3p", "1s", "2s", "3s", "4m", "5m", "6m"]
            .chunks(3)
            .map(|run| CalledMeld {
                meld_type: MeldType::Chi,
                tiles: run.iter().map(|code| code.to_string()).collect(),
                called_from: Some(0),
            })
            .chain(std::iter::once(CalledMeld {
                meld_type: MeldType::Ankan,
                tiles: vec!["7m".to_string(); 4],
                called_from: None,
            }))
            .collect();
        kyoku.draws[1] = Some(tile("8s"));

        let played = ActionInfo {
            action: "Discard_8s".to_string(),
            label: "Discard 8s".to_string(),
            kind: ActionKind::Discard,
            tile_index: crate::ai::encoder::tile_index("8s"),
            tile: Some("8s".to_string()),
            tiles: Vec::new(),
            kan_kind: None,
        };
        let mut warnings = Vec::new();
        let state = kyoku.build_state(
            1,
            DecisionKind::SelfTurn,
            DecisionContext::SelfTurn,
            &played,
            &mut warnings,
        );

        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(state.players[0].hand.len(), 1);
        assert_eq!(state.players[0].draw.as_deref(), Some("8s"));
        assert_eq!(state.tiles.len(), 2);
        assert!(!state.hand_string.is_empty());
    }

    /// A live kyoku with every seat-bearing field populated: four distinct
    /// hands, rivers, an open call, a closed kan, a riichi flag, scores and a
    /// draw. Built directly so the rotation can be tested without a game the
    /// structural validator would have to accept.
    fn sample_kyoku() -> Kyoku {
        let tile = |code: &str| MjaiTile::parse(code).expect("a fixture tile");
        let hands = [
            vec![
                "1m", "2m", "3m", "4p", "5p", "6p", "7s", "8s", "9s", "E", "E", "5m", "5m",
            ],
            vec![
                "1p", "2p", "3p", "4m", "5m", "6m", "7p", "8p", "9p", "S", "S", "1s", "2s",
            ],
            vec![
                "3m", "4m", "5m", "6p", "7p", "8p", "1s", "3s", "5s", "7s", "9s", "W", "W",
            ],
            vec![
                "2m", "2m", "3s", "3s", "4s", "4s", "6s", "6s", "8m", "8m", "N", "N", "P",
            ],
        ];
        let mut kyoku = Kyoku::new(
            0,
            &EventKind::StartKyoku {
                bakaze: tile("E"),
                dora_marker: tile("F"),
                kyoku: 2,
                honba: 1,
                kyotaku: 2,
                oya: 1,
                scores: [25_000, 24_000, 26_000, 25_000],
                tehais: std::array::from_fn(|seat| {
                    hands[seat]
                        .iter()
                        .map(|code| tile(code))
                        .collect::<Vec<_>>()
                        .try_into()
                        .expect("13 dealt tiles")
                }),
            },
        )
        .expect("a valid start_kyoku");

        kyoku.hands = std::array::from_fn(|seat| {
            hands[seat]
                .iter()
                .map(|code| tile(code))
                .collect::<Vec<_>>()
        });
        // Seat 2 has called a chi from seat 1; seat 3 has a closed kan and is in
        // riichi; seat 0 has just drawn.
        kyoku.hands[2].truncate(10);
        kyoku.melds[2].push(CalledMeld {
            meld_type: MeldType::Chi,
            tiles: vec!["6p".to_string(), "7p".to_string(), "8p".to_string()],
            called_from: Some(1),
        });
        kyoku.rivers = [
            vec![DiscardTile::new("9p"), DiscardTile::new("1z")],
            vec![DiscardTile::new("2z")],
            vec![DiscardTile::new("8p")],
            vec![DiscardTile::new("1m")],
        ];
        kyoku.rivers[0][1].is_riichi = true;
        kyoku.rivers[0][1].is_tsumogiri = true;
        kyoku.riichi = [true, false, false, true];
        kyoku.riichi_discard = [Some(1), None, None, Some(0)];
        kyoku.draws[0] = Some(tile("9m"));
        kyoku.dora = vec![tile("F"), tile("E")];
        kyoku.wall_draws = 12;
        kyoku
    }

    /// Relabel every seat of a live kyoku by `+shift`, which is the same
    /// physical table with a different absolute seat numbering.
    fn rotate_kyoku(kyoku: &Kyoku, shift: usize) -> Kyoku {
        let map = |index: usize| (index + shift) % 4;
        let inverse = |index: usize| (index + 4 - shift) % 4;
        Kyoku {
            index: kyoku.index,
            kyoku: kyoku.kyoku,
            honba: kyoku.honba,
            round_wind: kyoku.round_wind,
            dealer: map(kyoku.dealer),
            scores: std::array::from_fn(|index| kyoku.scores[inverse(index)]),
            kyotaku: kyoku.kyotaku,
            hands: std::array::from_fn(|index| kyoku.hands[inverse(index)].clone()),
            draws: std::array::from_fn(|index| kyoku.draws[inverse(index)]),
            rivers: std::array::from_fn(|index| kyoku.rivers[inverse(index)].clone()),
            melds: std::array::from_fn(|index| {
                kyoku.melds[inverse(index)]
                    .iter()
                    .map(|meld| CalledMeld {
                        meld_type: meld.meld_type,
                        tiles: meld.tiles.clone(),
                        called_from: meld.called_from.map(map),
                    })
                    .collect()
            }),
            riichi: std::array::from_fn(|index| kyoku.riichi[inverse(index)]),
            riichi_discard: std::array::from_fn(|index| kyoku.riichi_discard[inverse(index)]),
            dora: kyoku.dora.clone(),
            wall_draws: kyoku.wall_draws,
            last_discard: std::array::from_fn(|index| kyoku.last_discard[inverse(index)]),
            decision_slots: Vec::new(),
        }
    }
}
