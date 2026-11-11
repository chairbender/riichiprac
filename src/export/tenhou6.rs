//! Export a [`GameState`] as a `tenhou.net/6` JSON game log.
//!
//! The log is the "custom log" input of <https://mjai.ekyu.moe>: a hanchan
//! ruleset document holding one kyoku that ends exactly on the decision the
//! [`GameState`] presents. Feed it to the reviewer with the player id this
//! module reports and Mortal's per-action Q values for that position can be
//! compared with [`crate::ai::wasm_bridge::evaluate_state`].
//!
//! # Format
//!
//! A log is `{"title", "name", "rule", "log"}`. Each kyoku is a tuple of
//!
//! 1. `[kyoku_num, honba, kyotaku]` — `kyoku_num` counts from 0, so E1 = 0 and
//!    the dealer sits at `kyoku_num % 4`;
//! 2. the four scores;
//! 3. dora indicators, then 4. ura indicators;
//! 5. four times `[haipai(13), takes, discards]`;
//! 6. the kyoku result.
//!
//! A tile is two digits: `suit * 10 + rank` (`11` = 1m … `47` = chun), with
//! `51`/`52`/`53` for the red 5m/5p/5s. A take is a drawn tile or a naki
//! string (`"p…"` pon, `"c…"` chi, `"m…"` open kan; `"k…"`/`"a…"` appear inside
//! *discards* for an added/closed kan). A discard is a tile, `60` for
//! tsumogiri, or `"r<id>"` for a Riichi declaration that doubles as the
//! discard. The parser that defines all of this is mjai-reviewer's `convlog`
//! crate; the strings below follow the forms it accepts.
//!
//! # Fidelity
//!
//! The observation Mortal builds depends only on each seat's river (in order,
//! with tsumogiri and Riichi flags), each seat's melds, the dora, the scores
//! and the round — never on the global interleaving of the rivers. Two
//! consequences shape this exporter:
//!
//! - it may choose *any* legal turn order that consumes the given rivers;
//! - a claim only needs some seat to have discarded the meld's tile, so a state
//!   whose `called_from` river lacks it (our generators often draw the claimed
//!   tile from the deck instead of discarding it) still exports, with a warning
//!   naming the substitution.
//!
//! Opponents' concealed tiles are hidden information, so their haipai and draws
//! are reconstructed from their rivers; the target's hand is exact by
//! construction. Because the reverse walk only relabels which held tile came
//! from which draw, the log's tiles are exactly the state's tiles: no tile is
//! invented and every haipai lands on 13 tiles.

use serde_json::{Value, json};

use crate::ai::encoder::tile_index;
use crate::state::{DecisionContext, DiscardTile, GameState, MeldType, PlayerState};

/// Tile kinds in Mortal's tile order (1m..9m, 1p..9p, 1s..9s, E..chun).
const TILE_KINDS: usize = 34;
/// tenhou.net/6 marker for a discard that came straight from the draw.
const TSUMOGIRI: u8 = 60;
/// `rule.disp` of a hanchan, the only length the Mortal reviewer accepts. No
/// `東`/`三` characters: those would mean tonpuu/sanma.
const HANCHAN_RULE: &str = "般南喰赤";
/// The reviewer starts counting the wall at 70 tiles.
const WALL_TILES: i32 = 70;
/// Safety bound on the turn-order search.
const MAX_WALK_STEPS: usize = 200_000;

// --- Tiles ----------------------------------------------------------------

/// A tile in a log: Mortal's tile kind plus the red-five flag.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct Tile {
    kind: usize,
    aka: bool,
}

impl Tile {
    fn plain(code: &str) -> Option<Self> {
        tile_index(code).map(|kind| Self { kind, aka: false })
    }

    fn from_discard(discard: &DiscardTile) -> Option<Self> {
        tile_index(&discard.tile).map(|kind| Self {
            kind,
            aka: discard.is_red,
        })
    }

    /// The `tenhou.net/6` tile id.
    fn id(self) -> u8 {
        if self.aka {
            match self.kind {
                4 => return 51,
                13 => return 52,
                22 => return 53,
                _ => {}
            }
        }
        match self.kind {
            0..=26 => {
                let suit = self.kind / 9 + 1;
                let rank = self.kind % 9 + 1;
                (suit * 10 + rank) as u8
            }
            _ => 41 + (self.kind - 27) as u8,
        }
    }

    /// The two-digit id exactly as it appears inside a naki string.
    fn pair(self) -> String {
        format!("{:02}", self.id())
    }

    fn code(self) -> String {
        crate::ai::encoder::tile_name(self.kind).unwrap_or_else(|| "?".to_string())
    }
}

// --- Public payload -------------------------------------------------------

/// Counts that describe what the exported log contains.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tenhou6Summary {
    /// `0..=7`, in `tenhou.net/6`'s 0-based numbering (E1 = 0).
    pub kyoku_num: u8,
    /// Seat of the round's dealer in [`GameState::players`] order.
    pub dealer_seat: usize,
    /// Absolute seat of `players[0]` in the log; this is the reviewer's
    /// `player-id`.
    pub player_id: u8,
    /// Take entries (draws and calls) in the log.
    pub takes: usize,
    /// Wall draws implied by the log up to the snapshot.
    pub wall_draws: usize,
    /// Of those, draws that replace a kan rather than come off the live wall.
    pub replacement_draws: usize,
    /// `70 - wall_draws`, i.e. what Mortal will believe is left in the wall.
    pub implied_tiles_left: i32,
    /// The state's own `tiles_remaining`.
    pub state_tiles_remaining: u8,
    pub log_bytes: usize,
}

/// A finished export.
#[derive(Debug, Clone)]
pub struct Tenhou6Export {
    /// Pretty-printed `tenhou.net/6` JSON.
    pub json: String,
    /// The reviewer's `player-id` for this log.
    pub player_id: u8,
    /// Non-fatal fidelity notes: choices the state does not pin down.
    pub warnings: Vec<String>,
    pub summary: Tenhou6Summary,
}

/// Export a state, returning only the serialized log.
pub fn export_tenhou6_json(state: &GameState) -> Result<String, String> {
    export_tenhou6(state).map(|export| export.json)
}

// --- Export ---------------------------------------------------------------

/// Export `state` as a single-kyoku `tenhou.net/6` log.
pub fn export_tenhou6(state: &GameState) -> Result<Tenhou6Export, String> {
    let mut warnings = Vec::new();
    validate_shape(state)?;

    let kyoku_num = kyoku_number(state)?;
    let dealer = state.dealer_seat();
    // tenhou.net/6 fixes who deals from the kyoku number alone, so rotate the
    // table: absolute seat `(state seat + rotation) % 4` holds `state seat`.
    let rotation = (usize::from(kyoku_num) % 4 + 4 - dealer) % 4;
    let player_id = rotation as u8;

    let river = collect_rivers(state)?;
    let claims = plan_claims(state, &river, &mut warnings)?;
    let walk = plan_walk(state, &river, &claims)?;
    let mut turns = assemble_turns(state, &river, &claims, &walk, &mut warnings)?;
    insert_kans(state, &mut turns)?;
    let future = append_decision_turn(state, &river, &claims, &mut turns)?;

    let haipai = reverse_walk(state, &river, &mut turns)?;

    let mut take_count = 0usize;
    let mut wall_draws = 0usize;
    let mut replacement_draws = 0usize;
    for turn in &turns {
        for pair in &turn.pairs {
            if pair.tail {
                continue;
            }
            take_count += 1;
            if let Take::Draw { rinshan, .. } = pair.take {
                wall_draws += 1;
                replacement_draws += usize::from(rinshan);
            }
        }
    }
    let implied_tiles_left = WALL_TILES - wall_draws as i32;
    if implied_tiles_left != i32::from(state.tiles_remaining) {
        warnings.push(format!(
            "tiles_remaining is {} but the reconstructed timeline draws {wall_draws} wall tiles, \
             so Mortal sees {implied_tiles_left} left",
            state.tiles_remaining
        ));
    }
    if implied_tiles_left < 0 {
        return Err(format!(
            "the timeline needs {wall_draws} wall draws, more than the {WALL_TILES} a kyoku has"
        ));
    }
    if future.needs_dora {
        if let Some(extra) = future.extra_dora_indicator {
            warnings.push(format!(
                "the chankan tail reveals the kan dora; the log carries one extra indicator \
                 ({}) that the decision itself cannot see",
                extra.code()
            ));
        } else {
            return Err(
                "a chankan tail needs a spare dora indicator and no tile has a free copy"
                    .to_string(),
            );
        }
    }

    let scripts = serialise_scripts(state, &river, &turns)?;
    let mut dora: Vec<u8> = state
        .dora_indicators
        .iter()
        .map(|code| {
            Tile::plain(code)
                .map(|tile| tile.id())
                .ok_or_else(|| format!("unparseable dora indicator {code:?}"))
        })
        .collect::<Result<_, _>>()?;
    if let Some(extra) = future.extra_dora_indicator {
        dora.push(extra.id());
    }
    let ura: Vec<u8> = state
        .ura_dora_indicators
        .iter()
        .filter_map(|code| Tile::plain(code).map(|tile| tile.id()))
        .collect();

    let mut kyoku: Vec<Value> = Vec::with_capacity(20);
    kyoku.push(json!([kyoku_num, state.honba, state.riichi_sticks]));
    kyoku.push(json!(scores_in_log_order(state, rotation)));
    kyoku.push(json!(dora));
    kyoku.push(json!(ura));
    for absolute in 0..4usize {
        let seat = (absolute + 4 - rotation) % 4;
        let mut haipai = haipai[seat].clone();
        haipai.sort();
        let ids: Vec<u8> = haipai.iter().map(|tile| tile.id()).collect();
        kyoku.push(json!(ids));
        kyoku.push(json!(&scripts[seat].0));
        kyoku.push(json!(&scripts[seat].1));
    }
    kyoku.push(json!(["流局", [0, 0, 0, 0]]));

    let names: Vec<&str> = (0..4usize)
        .map(|absolute| state.players[(absolute + 4 - rotation) % 4].name.as_str())
        .collect();

    let document = json!({
        "title": ["riichiprac", ""],
        "name": names,
        "rule": { "disp": HANCHAN_RULE, "aka": 1 },
        "log": [kyoku],
    });

    let json = serde_json::to_string_pretty(&document)
        .map_err(|err| format!("failed to serialize log: {err}"))?;

    Ok(Tenhou6Export {
        summary: Tenhou6Summary {
            kyoku_num,
            dealer_seat: dealer,
            player_id,
            takes: take_count,
            wall_draws,
            replacement_draws,
            implied_tiles_left,
            state_tiles_remaining: state.tiles_remaining,
            log_bytes: json.len(),
        },
        json,
        player_id,
        warnings,
    })
}

fn validate_shape(state: &GameState) -> Result<(), String> {
    if state.players.len() != 4 {
        return Err(format!(
            "a log needs four players, got {}",
            state.players.len()
        ));
    }
    if state.dora_indicators.is_empty() {
        return Err("a tenhou.net/6 kyoku needs at least one dora indicator".to_string());
    }
    if state.hand_number == 0 {
        return Err("hand_number must be 1-based".to_string());
    }
    let drawn: Vec<usize> = state
        .players
        .iter()
        .enumerate()
        .filter(|(_, player)| player.draw.is_some())
        .map(|(seat, _)| seat)
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
        DecisionContext::ReactToDiscard { from, .. } | DecisionContext::ReactToKan { from, .. } => {
            if !drawn.is_empty() {
                return Err(format!("a reaction has an active draw at seats {drawn:?}"));
            }
            if *from == 0 || *from >= state.players.len() {
                return Err(format!("reaction source seat {from} is invalid"));
            }
        }
    }
    Ok(())
}

/// `tenhou.net/6`'s 0-based kyoku number (E1 = 0, S1 = 4, …).
fn kyoku_number(state: &GameState) -> Result<u8, String> {
    let round = state.round_wind.index();
    if round > 1 {
        return Err(format!(
            "round wind {:?} is not supported: the exporter writes East/South rounds only",
            state.round_wind
        ));
    }
    let hand = usize::from(state.hand_number).saturating_sub(1);
    if hand > 3 {
        return Err(format!("hand_number {} is out of range", state.hand_number));
    }
    Ok((round * 4 + hand) as u8)
}

fn collect_rivers(state: &GameState) -> Result<Vec<Vec<Tile>>, String> {
    state
        .players
        .iter()
        .map(|player| {
            player
                .discards
                .iter()
                .map(|discard| {
                    Tile::from_discard(discard).ok_or_else(|| {
                        format!(
                            "seat {} discarded an unknown tile {:?}",
                            player.seat, discard.tile
                        )
                    })
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .collect()
}

fn scores_in_log_order(state: &GameState, rotation: usize) -> [i32; 4] {
    std::array::from_fn(|absolute| state.players[(absolute + 4 - rotation) % 4].score)
}

// --- Calls ----------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ClaimKind {
    Chi,
    Pon,
    Daiminkan,
    /// A pon that is later upgraded to an added kan (chankan playback).
    KakanPon,
}

/// An open call the log has to place on some discard.
#[derive(Debug, Clone)]
struct Claim {
    seat: usize,
    meld: usize,
    kind: ClaimKind,
    /// The meld's tiles (four for a daiminkan, three otherwise).
    tiles: Vec<Tile>,
    /// Seats whose river holds a tile this call can claim, best first.
    sources: Vec<usize>,
}

impl Claim {
    fn claimed_matches(&self, tile: Tile) -> bool {
        match self.kind {
            ClaimKind::Chi => self.tiles.iter().any(|meld| meld.kind == tile.kind),
            _ => self
                .tiles
                .first()
                .is_some_and(|meld| meld.kind == tile.kind),
        }
    }

    /// The tiles the caller contributed from its own hand.
    fn consumed(&self, claimed: Tile) -> Vec<Tile> {
        match self.kind {
            ClaimKind::Chi => {
                let mut rest = Vec::with_capacity(2);
                let mut skipped = false;
                for tile in &self.tiles {
                    if !skipped && tile.kind == claimed.kind {
                        skipped = true;
                        continue;
                    }
                    rest.push(*tile);
                }
                rest
            }
            ClaimKind::Pon | ClaimKind::KakanPon => vec![claimed; 2],
            ClaimKind::Daiminkan => vec![claimed; 3],
        }
    }

    fn is_daiminkan(&self) -> bool {
        self.kind == ClaimKind::Daiminkan
    }
}

fn plan_claims(
    state: &GameState,
    river: &[Vec<Tile>],
    warnings: &mut Vec<String>,
) -> Result<Vec<Claim>, String> {
    let mut claims = Vec::new();
    for player in &state.players {
        for (meld_index, meld) in player.melds.iter().enumerate() {
            let tiles: Vec<Tile> = meld
                .tiles
                .iter()
                .map(|code| Tile::plain(code).ok_or_else(|| format!("unknown meld tile {code:?}")))
                .collect::<Result<_, _>>()?;
            let chankan = state.chankan_target().is_some_and(|(seat, tile)| {
                seat == player.seat && meld.tiles.iter().all(|held| held == tile)
            });
            let kind = match meld.meld_type {
                MeldType::Ankan => continue,
                MeldType::Chi => ClaimKind::Chi,
                MeldType::Pon => {
                    if chankan {
                        ClaimKind::KakanPon
                    } else {
                        ClaimKind::Pon
                    }
                }
                MeldType::Kan => {
                    if chankan {
                        // A chankan can only ron an added kan, so replay the
                        // four-tile kan as a pon plus the added kan.
                        claims.push(place_claim(
                            player,
                            meld_index,
                            ClaimKind::KakanPon,
                            vec![tiles[0]; 3],
                            None,
                            river,
                            warnings,
                        )?);
                        continue;
                    }
                    ClaimKind::Daiminkan
                }
            };
            let needed = match kind {
                ClaimKind::Chi | ClaimKind::Pon | ClaimKind::KakanPon => 3,
                ClaimKind::Daiminkan => 4,
            };
            if tiles.len() != needed {
                return Err(format!(
                    "meld {kind:?} at seat {} has {} tiles, expected {needed}",
                    player.seat,
                    tiles.len()
                ));
            }
            let called_from = if chankan { None } else { meld.called_from };
            claims.push(place_claim(
                player,
                meld_index,
                kind,
                tiles,
                called_from,
                river,
                warnings,
            )?);
        }
    }
    Ok(claims)
}

fn place_claim(
    player: &PlayerState,
    meld_index: usize,
    kind: ClaimKind,
    tiles: Vec<Tile>,
    called_from: Option<usize>,
    river: &[Vec<Tile>],
    warnings: &mut Vec<String>,
) -> Result<Claim, String> {
    if let Some(from) = called_from
        && (from == player.seat || from >= 4)
    {
        return Err(format!(
            "seat {} cannot claim from seat {from}",
            player.seat
        ));
    }
    let matches = |tile: &Tile| match kind {
        ClaimKind::Chi => tiles.iter().any(|meld| meld.kind == tile.kind),
        _ => tiles.first().is_some_and(|meld| meld.kind == tile.kind),
    };

    let allowed = |seat: usize| -> bool {
        seat != player.seat
            && match kind {
                // A chi can only claim the previous seat's discard.
                ClaimKind::Chi => seat == (player.seat + 3) % 4,
                _ => true,
            }
    };

    let mut sources: Vec<usize> = Vec::new();
    if let Some(from) = called_from
        && allowed(from)
        && river[from].iter().any(matches)
    {
        sources.push(from);
    }
    for (seat, discards) in river.iter().enumerate() {
        if sources.contains(&seat) || !allowed(seat) {
            continue;
        }
        if discards.iter().any(matches) {
            sources.push(seat);
        }
    }
    if sources.is_empty() {
        let tile = tiles
            .first()
            .map(|tile| tile.code())
            .unwrap_or_else(|| "?".to_string());
        let hint = if kind == ClaimKind::Chi {
            format!(
                "; a chi can only claim seat {}'s river",
                (player.seat + 3) % 4
            )
        } else {
            String::new()
        };
        return Err(format!(
            "seat {} holds a {kind:?} meld of {tile} but no eligible river contains that tile{hint}",
            player.seat
        ));
    }
    if let Some(from) = called_from
        && sources.first() != Some(&from)
    {
        warnings.push(format!(
            "seat {} holds a {kind:?} meld called from seat {from}, whose river never shows that \
             tile; the log replays the claim from seat {} instead, which the observation cannot \
             tell apart (it sees the meld, not who discarded the tile)",
            player.seat, sources[0]
        ));
    }
    Ok(Claim {
        seat: player.seat,
        meld: meld_index,
        kind,
        tiles,
        sources,
    })
}

impl GameState {
    /// The `(seat, tile)` a chankan decision is waiting on, if any.
    fn chankan_target(&self) -> Option<(usize, &str)> {
        match &self.decision {
            DecisionContext::ReactToKan { from, tile } => Some((*from, tile.as_str())),
            _ => None,
        }
    }
}

// --- Turn order -----------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WalkStep {
    Discard { seat: usize, index: usize },
    Claim { claim: usize },
}

struct WalkPlanner<'a> {
    river: &'a [Vec<Tile>],
    claims: &'a [Claim],
    expected_last: usize,
    visited: usize,
}

fn plan_walk(
    state: &GameState,
    river: &[Vec<Tile>],
    claims: &[Claim],
) -> Result<Vec<WalkStep>, String> {
    let expected_last = match &state.decision {
        DecisionContext::SelfTurn => 3,
        DecisionContext::ReactToDiscard { from, .. } => *from,
        DecisionContext::ReactToKan { from, .. } => (*from + 3) % 4,
    };
    if river.iter().all(|discards| discards.is_empty()) {
        // Only the dealer's opening draw, with nothing discarded yet.
        if !claims.is_empty() {
            return Err("a call needs a discard to claim".to_string());
        }
        if !matches!(state.decision, DecisionContext::SelfTurn) {
            return Err("a reaction cannot happen before the first discard".to_string());
        }
        return Ok(Vec::new());
    }

    let mut planner = WalkPlanner {
        river,
        claims,
        expected_last,
        visited: 0,
    };
    let mut cursor = [0usize; 4];
    let mut placed = vec![false; claims.len()];
    let mut steps = Vec::new();
    if planner.search(state.dealer_seat(), &mut cursor, &mut placed, &mut steps) {
        Ok(steps)
    } else {
        Err(format!(
            "the rivers {:?} and {} calls cannot be replayed as one turn order ending on seat \
             {expected_last}",
            river.iter().map(Vec::len).collect::<Vec<_>>(),
            claims.len()
        ))
    }
}

impl WalkPlanner<'_> {
    fn search(
        &mut self,
        seat: usize,
        cursor: &mut [usize; 4],
        placed: &mut [bool],
        steps: &mut Vec<WalkStep>,
    ) -> bool {
        self.visited += 1;
        if self.visited > MAX_WALK_STEPS {
            return false;
        }
        let remaining: usize = (0..4)
            .map(|index| self.river[index].len() - cursor[index])
            .sum();
        if remaining == 0 {
            return placed.iter().all(|&done| done)
                && matches!(
                    steps.last(),
                    Some(WalkStep::Discard { seat, .. }) if *seat == self.expected_last
                );
        }
        if cursor[seat] >= self.river[seat].len() {
            return false;
        }

        let index = cursor[seat];
        let tile = self.river[seat][index];
        cursor[seat] += 1;
        steps.push(WalkStep::Discard { seat, index });

        for (claim_index, claim) in self.claims.iter().enumerate() {
            if placed[claim_index]
                || claim.seat == seat
                || !claim.sources.contains(&seat)
                || !claim.claimed_matches(tile)
            {
                continue;
            }
            placed[claim_index] = true;
            steps.push(WalkStep::Claim { claim: claim_index });
            if self.search(claim.seat, cursor, placed, steps) {
                return true;
            }
            steps.pop();
            placed[claim_index] = false;
        }

        if self.search((seat + 1) % 4, cursor, placed, steps) {
            return true;
        }
        steps.pop();
        cursor[seat] -= 1;
        false
    }
}

// --- Turns ----------------------------------------------------------------

#[derive(Debug, Clone)]
enum Take {
    Draw {
        /// Fixed when the take is not a free draw: a kan's fourth tile, or the
        /// snapshot's own draw.
        tile: Option<Tile>,
        rinshan: bool,
    },
    Naki(Naki),
}

#[derive(Debug, Clone)]
struct Naki {
    /// The naki string exactly as the log carries it.
    text: String,
    /// The tiles the caller took from its own hand.
    consumed: Vec<Tile>,
}

#[derive(Debug, Clone)]
enum DiscardEntry {
    /// One of the state's river tiles.
    River { index: usize },
    /// A discard that happens after the snapshot (the answer tile or a tail).
    Appended { tile: Tile, tsumogiri: bool },
    /// A closed kan declared instead of this turn's discard.
    Ankan { meld: usize },
    /// An added kan declared instead of this turn's discard.
    Kakan { meld: usize },
}

#[derive(Debug, Clone)]
struct Pair {
    take: Take,
    discard: Option<DiscardEntry>,
    /// The pair happens after the snapshot and is skipped by the reverse walk.
    tail: bool,
}

#[derive(Debug, Clone)]
struct Turn {
    seat: usize,
    pairs: Vec<Pair>,
}

fn assemble_turns(
    state: &GameState,
    river: &[Vec<Tile>],
    claims: &[Claim],
    walk: &[WalkStep],
    warnings: &mut Vec<String>,
) -> Result<Vec<Turn>, String> {
    let mut pending: [Option<(usize, Naki)>; 4] = [None, None, None, None];
    let mut turns: Vec<Turn> = Vec::new();
    let mut last_discard: Option<(usize, usize)> = None;

    for step in walk {
        match *step {
            WalkStep::Claim { claim } => {
                let claim_ref = &claims[claim];
                let (source_seat, source_index) = last_discard.ok_or_else(|| {
                    "internal: a claim was planned before any discard".to_string()
                })?;
                let claimed = river[source_seat][source_index];
                pending[claim_ref.seat] = Some((
                    claim,
                    Naki {
                        text: naki_string(claim_ref, source_seat, claimed),
                        consumed: claim_ref.consumed(claimed),
                    },
                ));
            }
            WalkStep::Discard { seat, index } => {
                last_discard = Some((seat, index));
                let tsumogiri_in_state = state.players[seat]
                    .discards
                    .get(index)
                    .is_some_and(|discard| discard.is_tsumogiri);
                let mut pairs = Vec::with_capacity(2);
                if let Some((claim, naki)) = pending[seat].take() {
                    if tsumogiri_in_state {
                        warnings.push(format!(
                            "seat {seat} discards tsumogiri right after a call in the state, \
                             which cannot happen; the log replays it as a tedashi"
                        ));
                    }
                    if claims[claim].is_daiminkan() {
                        // An open kan is followed by the replacement draw and
                        // then the discard.
                        pairs.push(Pair {
                            take: Take::Naki(naki),
                            discard: None,
                            tail: false,
                        });
                        pairs.push(Pair {
                            take: Take::Draw {
                                tile: None,
                                rinshan: true,
                            },
                            discard: Some(DiscardEntry::River { index }),
                            tail: false,
                        });
                    } else {
                        // A pon or chi discards straight after claiming.
                        pairs.push(Pair {
                            take: Take::Naki(naki),
                            discard: Some(DiscardEntry::River { index }),
                            tail: false,
                        });
                    }
                } else {
                    pairs.push(Pair {
                        take: Take::Draw {
                            tile: None,
                            rinshan: false,
                        },
                        discard: Some(DiscardEntry::River { index }),
                        tail: false,
                    });
                }
                turns.push(Turn { seat, pairs });
            }
        }
    }
    Ok(turns)
}

/// Splice each seat's closed kans into its last turn that starts from a draw.
///
/// A kan replaces that turn's discard, and the replacement draw plus the
/// original discard become the rest of the turn.
fn insert_kans(state: &GameState, turns: &mut [Turn]) -> Result<(), String> {
    for (seat, player) in state.players.iter().enumerate() {
        let kanned: Vec<(usize, Tile)> = player
            .melds
            .iter()
            .enumerate()
            .filter(|(_, meld)| meld.meld_type == MeldType::Ankan)
            .map(|(index, meld)| {
                meld.tiles
                    .first()
                    .and_then(|code| Tile::plain(code))
                    .map(|tile| (index, tile))
                    .ok_or_else(|| format!("seat {seat} has an unparseable closed kan"))
            })
            .collect::<Result<_, _>>()?;
        if kanned.is_empty() {
            continue;
        }

        let Some(turn_index) = turns.iter().rposition(|turn| {
            turn.seat == seat
                && !turn.pairs.iter().any(|pair| pair.tail)
                && turn.pairs.len() == 1
                && matches!(turn.pairs[0].take, Take::Draw { .. })
                && matches!(turn.pairs[0].discard, Some(DiscardEntry::River { .. }))
        }) else {
            return Err(format!(
                "seat {seat} has a closed kan but no turn with a plain draw to declare it on"
            ));
        };

        let original = turns[turn_index].pairs.pop();
        let Some(original) = original else {
            return Err("internal: empty turn while splicing a kan".to_string());
        };
        let mut pairs = Vec::with_capacity(kanned.len() + 1);
        for (position, (meld, tile)) in kanned.iter().enumerate() {
            pairs.push(Pair {
                take: Take::Draw {
                    tile: (*meld == kanned[0].0).then_some(*tile),
                    rinshan: position > 0,
                },
                discard: Some(DiscardEntry::Ankan { meld: *meld }),
                tail: false,
            });
        }
        pairs.push(Pair {
            take: Take::Draw {
                tile: None,
                rinshan: true,
            },
            ..original
        });
        turns[turn_index].pairs = pairs;
    }
    Ok(())
}

struct FutureTurns {
    needs_dora: bool,
    extra_dora_indicator: Option<Tile>,
}

/// Add the turn that carries the decision the state is asking about.
fn append_decision_turn(
    state: &GameState,
    river: &[Vec<Tile>],
    claims: &[Claim],
    turns: &mut Vec<Turn>,
) -> Result<FutureTurns, String> {
    match &state.decision {
        DecisionContext::SelfTurn => {
            let draw = state.players[0]
                .draw
                .as_deref()
                .ok_or_else(|| "a self turn needs the human's drawn tile".to_string())?;
            let draw = Tile::plain(draw).ok_or_else(|| format!("unknown draw {draw:?}"))?;
            let (answer, tsumogiri) = answer_discard(state, draw);
            turns.push(Turn {
                seat: 0,
                pairs: vec![Pair {
                    take: Take::Draw {
                        tile: Some(draw),
                        rinshan: false,
                    },
                    discard: Some(DiscardEntry::Appended {
                        tile: answer,
                        tsumogiri,
                    }),
                    tail: false,
                }],
            });
            Ok(FutureTurns {
                needs_dora: false,
                extra_dora_indicator: None,
            })
        }
        DecisionContext::ReactToDiscard { from, .. } => {
            // The reviewer only records a reaction when the game continues, so
            // let the next seat draw and end the kyoku on it. Nothing after the
            // snapshot exists in the state.
            turns.push(Turn {
                seat: (from + 1) % 4,
                pairs: vec![Pair {
                    take: Take::Draw {
                        tile: None,
                        rinshan: false,
                    },
                    discard: None,
                    tail: true,
                }],
            });
            Ok(FutureTurns {
                needs_dora: false,
                extra_dora_indicator: None,
            })
        }
        DecisionContext::ReactToKan { from, tile } => {
            let tile = Tile::plain(tile).ok_or_else(|| format!("unknown kan tile {tile:?}"))?;
            let claim = claims
                .iter()
                .find(|claim| claim.seat == *from && claim.kind == ClaimKind::KakanPon)
                .ok_or_else(|| {
                    format!("chankan state has no four-tile kan at seat {from} to add to")
                })?;
            turns.push(Turn {
                seat: *from,
                pairs: vec![
                    Pair {
                        take: Take::Draw {
                            tile: Some(tile),
                            rinshan: false,
                        },
                        discard: Some(DiscardEntry::Kakan { meld: claim.meld }),
                        tail: false,
                    },
                    Pair {
                        take: Take::Draw {
                            tile: None,
                            rinshan: true,
                        },
                        discard: Some(DiscardEntry::Appended {
                            tile,
                            tsumogiri: true,
                        }),
                        tail: false,
                    },
                ],
            });
            let _ = river;
            Ok(FutureTurns {
                needs_dora: true,
                extra_dora_indicator: spare_indicator(state),
            })
        }
    }
}

/// The tile the log shows the human discarding, and whether it is tsumogiri.
///
/// Mortal's evaluation happens *before* this discard, so its only job is to be
/// a legal, unremarkable action: the state's answer when that tile is in hand,
/// otherwise the drawn tile.
fn answer_discard(state: &GameState, draw: Tile) -> (Tile, bool) {
    let player = &state.players[0];
    if player.is_riichi {
        return (draw, true);
    }
    let mut held: Vec<usize> = player
        .hand
        .iter()
        .filter_map(|code| tile_index(code))
        .collect();
    if let Some(code) = player.draw.as_deref() {
        held.extend(tile_index(code));
    }
    if let Some(answer) = state.correct_action.tile()
        && let Some(kind) = tile_index(answer)
        && kind != draw.kind
        && held.contains(&kind)
    {
        // Keep the red-five identity when the only copy held is the aka, so
        // the log's discard matches the hand it came from.
        let copies = held.iter().filter(|held_kind| **held_kind == kind).count();
        let aka = copies == 1
            && player
                .red_fives
                .iter()
                .any(|red| tile_index(red) == Some(kind));
        return (Tile { kind, aka }, false);
    }
    (draw, true)
}

/// A dora indicator that keeps the four-copy budget intact.
fn spare_indicator(state: &GameState) -> Option<Tile> {
    let mut used = [0u8; TILE_KINDS];
    let mut note = |code: &str| {
        if let Some(kind) = tile_index(code) {
            used[kind] = used[kind].saturating_add(1);
        }
    };
    for player in &state.players {
        for code in &player.hand {
            note(code);
        }
        if let Some(draw) = &player.draw {
            note(draw);
        }
        for discard in &player.discards {
            note(&discard.tile);
        }
        for meld in &player.melds {
            for code in &meld.tiles {
                note(code);
            }
        }
    }
    for code in state
        .dora_indicators
        .iter()
        .chain(&state.ura_dora_indicators)
    {
        note(code);
    }
    (0..TILE_KINDS)
        .find(|kind| used[*kind] < 4)
        .map(|kind| Tile { kind, aka: false })
}

// --- Reverse walk ---------------------------------------------------------

/// Reconstruct haipai from the state's hands by undoing the log backwards.
fn reverse_walk(
    state: &GameState,
    river: &[Vec<Tile>],
    turns: &mut [Turn],
) -> Result<Vec<Vec<Tile>>, String> {
    let mut hands: Vec<Vec<Tile>> = Vec::with_capacity(4);
    for (seat, player) in state.players.iter().enumerate() {
        let mut hand: Vec<Tile> = player
            .hand
            .iter()
            .map(|code| Tile::plain(code).ok_or_else(|| format!("unknown tile {code:?}")))
            .collect::<Result<_, _>>()?;
        if seat == 0
            && let Some(draw) = &player.draw
        {
            hand.push(Tile::plain(draw).ok_or_else(|| format!("unknown draw {draw:?}"))?);
        }
        hands.push(hand);
    }
    mark_aka(state, &mut hands)?;

    for turn in turns.iter_mut().rev() {
        let seat = turn.seat;
        for pair in turn.pairs.iter_mut().rev() {
            if pair.tail {
                continue;
            }
            undo_pair(state, river, &mut hands, seat, pair)?;
        }
    }

    for (seat, hand) in hands.iter().enumerate() {
        if hand.len() != 13 {
            return Err(format!(
                "reconstruction left seat {seat} with {} tiles instead of 13: {:?}",
                hand.len(),
                hand.iter().map(|tile| tile.code()).collect::<Vec<_>>()
            ));
        }
    }
    Ok(hands)
}

/// Move the state's red-five flags onto the right hand tiles.
fn mark_aka(state: &GameState, hands: &mut [Vec<Tile>]) -> Result<(), String> {
    for (seat, player) in state.players.iter().enumerate() {
        for red in &player.red_fives {
            let kind = tile_index(red).ok_or_else(|| format!("unknown red five {red:?}"))?;
            let Some(tile) = hands[seat]
                .iter_mut()
                .find(|tile| tile.kind == kind && !tile.aka)
            else {
                return Err(format!(
                    "seat {seat} lists a red {red} that its hand does not hold"
                ));
            };
            tile.aka = true;
        }
    }
    Ok(())
}

fn undo_pair(
    state: &GameState,
    river: &[Vec<Tile>],
    hands: &mut [Vec<Tile>],
    seat: usize,
    pair: &mut Pair,
) -> Result<(), String> {
    // 1. Undo the discard: it goes back into the hand. A kan consumed four
    //    held tiles instead (three from hand plus the draw), so it restores
    //    them before the draw is removed below.
    match &pair.discard {
        Some(DiscardEntry::River { index }) => {
            let tile = river[seat][*index];
            hands[seat].push(tile);
        }
        Some(DiscardEntry::Ankan { meld }) => {
            let tiles = meld_tiles(state, seat, *meld)?;
            hands[seat].extend(tiles);
        }
        Some(DiscardEntry::Kakan { meld }) => {
            let tile = meld_tiles(state, seat, *meld)?
                .first()
                .copied()
                .ok_or_else(|| "added-kan meld has no tile".to_string())?;
            hands[seat].push(tile);
        }
        Some(DiscardEntry::Appended { .. }) | None => {}
    }

    // 2. Undo the take.
    let fixed = match &pair.take {
        Take::Draw { tile, .. } => Some(*tile),
        Take::Naki(_) => None,
    };
    match fixed {
        Some(Some(tile)) => {
            remove_one(&mut hands[seat], tile).ok_or_else(|| {
                format!(
                    "seat {seat} drew {} but its reconstructed hand does not hold it",
                    tile.code()
                )
            })?;
        }
        Some(None) => {
            let chosen = choose_draw(state, river, &hands[seat], seat, pair)?;
            remove_one(&mut hands[seat], chosen).ok_or_else(|| {
                format!(
                    "seat {seat} drew {} but its reconstructed hand does not hold it",
                    chosen.code()
                )
            })?;
            if let Take::Draw { tile, .. } = &mut pair.take {
                *tile = Some(chosen);
            }
            if let Some(DiscardEntry::Appended { tile, .. }) = &mut pair.discard {
                *tile = chosen;
            }
        }
        None => {
            if let Take::Naki(naki) = &pair.take {
                hands[seat].extend(naki.consumed.iter().copied());
            }
        }
    }
    Ok(())
}

fn meld_tiles(state: &GameState, seat: usize, meld: usize) -> Result<Vec<Tile>, String> {
    state.players[seat]
        .melds
        .get(meld)
        .ok_or_else(|| format!("seat {seat} has no meld {meld}"))?
        .tiles
        .iter()
        .map(|code| Tile::plain(code).ok_or_else(|| format!("unknown tile {code:?}")))
        .collect()
}

/// Which tile the draw at this pair was.
fn choose_draw(
    state: &GameState,
    river: &[Vec<Tile>],
    hand: &[Tile],
    seat: usize,
    pair: &Pair,
) -> Result<Tile, String> {
    // A kan turn draws the fourth tile of the kan.
    if let Some(DiscardEntry::Ankan { meld }) = pair.discard {
        let tiles = meld_tiles(state, seat, meld)?;
        if let Some(tile) = tiles.first().copied() {
            return Ok(tile);
        }
    }

    let tsumogiri = match &pair.discard {
        Some(DiscardEntry::River { index }) => state.players[seat].discards[*index].is_tsumogiri,
        Some(DiscardEntry::Appended { tsumogiri, .. }) => *tsumogiri,
        _ => false,
    };
    if tsumogiri && let Some(DiscardEntry::River { index }) = &pair.discard {
        let tile = river[seat][*index];
        if hand.contains(&tile) {
            return Ok(tile);
        }
    }

    // Otherwise the player changed tiles (tedashi): it drew something else.
    let discarded = match &pair.discard {
        Some(DiscardEntry::River { index }) => Some(river[seat][*index]),
        _ => None,
    };
    hand.iter()
        .find(|tile| discarded.is_none_or(|discard| **tile != discard))
        .copied()
        .or_else(|| hand.first().copied())
        .ok_or_else(|| format!("seat {seat} has an empty hand while a draw is being undone"))
}

fn remove_one(hand: &mut Vec<Tile>, tile: Tile) -> Option<()> {
    let position = hand.iter().position(|held| *held == tile)?;
    hand.remove(position);
    Some(())
}

// --- Naki strings ---------------------------------------------------------

/// Build the naki string for `claim`, claimed from `source_seat`.
///
/// The marker's position encodes the direction: a tile claimed from the
/// previous seat leads, one from the across seat is second, one from the next
/// seat is last. A chi is always from the previous seat, so its marker leads.
fn naki_string(claim: &Claim, source_seat: usize, claimed: Tile) -> String {
    let marker = match claim.kind {
        ClaimKind::Chi => "c".to_string(),
        ClaimKind::Pon | ClaimKind::KakanPon => "p".to_string(),
        ClaimKind::Daiminkan => "m".to_string(),
    };
    let consumed = claim.consumed(claimed);
    let direction = (claim.seat + 4 - source_seat) % 4;

    if claim.kind == ClaimKind::Chi {
        let mut text = String::from("c");
        text.push_str(&claimed.pair());
        for tile in consumed {
            text.push_str(&tile.pair());
        }
        return text;
    }

    // Assemble the claimed tile plus the caller's own (identical) copies, then
    // insert the marker where the claimed tile sits for that direction.
    let slot = match (direction, claim.kind) {
        (3, _) => 0,                    // kamicha: the claimed tile leads
        (2, _) => 1,                    // toimen: the claimed tile is second
        (1, ClaimKind::Daiminkan) => 3, // shimocha, four tiles: the claimed tile is last
        (1, _) => 2,                    // shimocha: the claimed tile is third
        _ => 0,
    };
    let tiles = vec![claimed; consumed.len() + 1];
    let digits: String = tiles.iter().map(|tile| tile.pair()).collect();
    // The order only matters for where the marker goes, which is `slot * 2`
    // characters into the digit string.
    let split = (slot * 2).min(digits.len());
    format!("{}{}{}", &digits[..split], marker, &digits[split..])
}

// --- Serialization --------------------------------------------------------

/// `(takes, discards)` per state seat.
type Script = (Vec<Value>, Vec<Value>);

fn serialise_scripts(
    state: &GameState,
    river: &[Vec<Tile>],
    turns: &[Turn],
) -> Result<Vec<Script>, String> {
    let mut scripts: Vec<Script> = (0..4).map(|_| (Vec::new(), Vec::new())).collect();

    for turn in turns {
        let seat = turn.seat;
        for pair in &turn.pairs {
            match &pair.take {
                Take::Draw { tile, .. } => {
                    let tile = tile.ok_or_else(|| "internal: unassigned draw".to_string())?;
                    scripts[seat].0.push(json!(tile.id()));
                }
                Take::Naki(naki) => scripts[seat].0.push(json!(naki.text)),
            }

            match &pair.discard {
                Some(DiscardEntry::River { index }) => {
                    let discard = state.players[seat]
                        .discards
                        .get(*index)
                        .ok_or_else(|| format!("seat {seat} has no discard {index}"))?;
                    let tile = river[seat][*index];
                    let after_call = matches!(pair.take, Take::Naki(_));
                    let entry = if !after_call && discard.is_riichi {
                        let id = if discard.is_tsumogiri {
                            TSUMOGIRI
                        } else {
                            tile.id()
                        };
                        json!(format!("r{id}"))
                    } else if !after_call && discard.is_tsumogiri {
                        json!(TSUMOGIRI)
                    } else {
                        // A discard straight after a call is always tedashi.
                        json!(tile.id())
                    };
                    scripts[seat].1.push(entry);
                }
                Some(DiscardEntry::Appended { tile, tsumogiri }) => {
                    if *tsumogiri {
                        scripts[seat].1.push(json!(TSUMOGIRI));
                    } else {
                        scripts[seat].1.push(json!(tile.id()));
                    }
                }
                Some(DiscardEntry::Ankan { meld }) => {
                    let tile = meld_tiles(state, seat, *meld)?
                        .first()
                        .copied()
                        .unwrap_or(Tile {
                            kind: 0,
                            aka: false,
                        });
                    let pair = tile.pair();
                    scripts[seat]
                        .1
                        .push(json!(format!("{pair}{pair}{pair}a{pair}")));
                }
                Some(DiscardEntry::Kakan { meld }) => {
                    let tile = meld_tiles(state, seat, *meld)?
                        .first()
                        .copied()
                        .unwrap_or(Tile {
                            kind: 0,
                            aka: false,
                        });
                    let pair = tile.pair();
                    scripts[seat]
                        .1
                        .push(json!(format!("{pair}k{pair}{pair}{pair}")));
                }
                None => {}
            }
        }
    }

    Ok(scripts)
}

#[cfg(test)]
#[path = "tenhou6_test.rs"]
mod tenhou6_test;
