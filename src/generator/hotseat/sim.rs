//! A minimal four-seat riichi round played by the loaded Mortal model.
//!
//! The simulator is a rules engine, not a generator: it deals one deck, keeps
//! the four concealed hands, and asks the model for every decision (discard,
//! Riichi, call, kan, win). Each time the inserted seat has a real decision,
//! the position is recorded. Generation then picks one of those recorded
//! positions at random, so the returned state is a position that actually
//! occurred in the played hand.
//!
//! Scope is a single round, which is what the drill needs: no continuation,
//! no score settlement, and no multi-round match. The engine does model the
//! parts of a round that change the position: calls, riichi, kans, replacement
//! draws, dora reveals, furiten via [`crate::ai::actions`], tsumo and ron.
//!
//! Red fives are deliberately not modelled: the deck is the 136-tile set of
//! base codes, so a hand never offers a `Discard_5mr` action. The model still
//! reads the same tiles; only the aka axis is absent.

use std::collections::BTreeSet;

use agari::tile::Tile;

use crate::ai::actions::legal_actions;
use crate::ai::model::MortalV4Model;
use crate::ai::wasm_bridge::{Evaluation, evaluate_state_named};
use crate::decision::{ActionInfo, ActionKind};
use crate::generator::support::deck::ALL_TILES;
use crate::generator::support::format::format_hand_compact;
use crate::rng::{gen_range, shuffle};
use crate::state::{
    CalledMeld, CorrectAction, DecisionContext, DiscardTile, GameState, MeldType, PlayerState,
    TargetAction, Wind,
};

use super::bridge::{actor_state, code_counts, is_tsumo_win};
use super::options::StartingConditions;

/// How many self-turn/kan steps one simulated round may take. A full live wall
/// is 69 draws; the bound only protects against a rules bug.
const MAX_STEPS: usize = 4096;

/// A position the inserted seat faced, with the model's evaluation of it.
#[derive(Debug, Clone)]
pub struct DecisionRecord {
    pub state: GameState,
    pub evaluation: Evaluation,
    /// One-based full-turn index (four live-wall draws per turn) at the
    /// decision.
    pub turn: u8,
}

/// Progress reported while a round is being played.
///
/// `turn` is one-based and counts **full turns** (four live-wall draws). A
/// round dealt from a 69-tile live wall has 17 full turns; the 69th draw is a
/// partial eighteenth turn that only the dealer reaches, so the uniform target
/// range is 1..=17.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct TurnProgress {
    /// One-based simulated-round number; retries increment it.
    pub attempt: usize,
    pub turn: u8,
    /// Live-wall draws made so far.
    pub drawn: u8,
    /// Tiles left in the live wall.
    pub wall_left: u8,
}

/// How one simulated round ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Win { winner: usize },
    Draw,
}

/// The decision source for the simulator.
///
/// Production uses [`ModelPolicy`], which runs the loaded Mortal checkpoint.
/// Tests substitute a deterministic cheap policy so the rules engine can be
/// exercised without dozens of debug-build forward passes.
pub(crate) trait Policy {
    fn evaluate(&self, state: &GameState) -> Result<Evaluation, String>;
}

/// The loaded Mortal model as the simulator's policy.
pub(crate) struct ModelPolicy<'a> {
    pub(crate) model: &'a MortalV4Model,
    pub(crate) name: &'a str,
}

impl Policy for ModelPolicy<'_> {
    fn evaluate(&self, state: &GameState) -> Result<Evaluation, String> {
        evaluate_state_named(self.model, state, self.name)
            .map_err(|err| format!("model evaluation failed: {err}"))
    }
}

/// One seat's live state during the simulation.
#[derive(Debug, Clone)]
pub(crate) struct SimPlayer {
    pub(crate) hand: Vec<String>,
    pub(crate) draw: Option<String>,
    pub(crate) melds: Vec<CalledMeld>,
    pub(crate) discards: Vec<DiscardTile>,
    pub(crate) is_riichi: bool,
    pub(crate) riichi_discard_index: Option<usize>,
    pub(crate) score: i32,
    pub(crate) wind: Wind,
}

impl SimPlayer {
    fn remove_one(&mut self, code: &str) -> bool {
        if self.draw.as_deref() == Some(code) {
            self.draw = None;
            return true;
        }
        if let Some(index) = self.hand.iter().position(|tile| tile == code) {
            self.hand.remove(index);
            return true;
        }
        false
    }

    fn sort_hand(&mut self) {
        self.hand.sort();
    }

    fn fold_draw_into_hand(&mut self) {
        if let Some(draw) = self.draw.take() {
            self.hand.push(draw);
            self.sort_hand();
        }
    }
}

/// The table one round is played on.
pub(crate) struct SimTable {
    pub(crate) conditions: StartingConditions,
    pub(crate) round_wind: Wind,
    pub(crate) hand_number: u8,
    pub(crate) honba: u8,
    pub(crate) riichi_sticks: u8,
    pub(crate) dealer: usize,
    pub(crate) target: usize,
    pub(crate) wall: Vec<String>,
    pub(crate) dead_wall: Vec<String>,
    pub(crate) dora_indicators: Vec<String>,
    pub(crate) ura_dora_indicators: Vec<String>,
    pub(crate) players: Vec<SimPlayer>,
    pub(crate) records: Vec<DecisionRecord>,
    kan_count: usize,
    rinshan_index: usize,
}

impl SimTable {
    /// Deal a fresh round under `conditions`.
    pub(crate) fn deal(conditions: StartingConditions) -> Self {
        let (round_wind, hand_number) = conditions.round.parts();
        let player_seat = conditions.seat.wind().index();
        let scores = conditions.disparity.scores_for(player_seat);

        let mut wall = fresh_deck();
        let dead_wall: Vec<String> = wall.split_off(wall.len() - 14);
        let dora_indicators = vec![dead_wall[4].clone()];
        let ura_dora_indicators = vec![dead_wall[9].clone()];

        let mut players = Vec::with_capacity(4);
        for (seat, &score) in scores.iter().enumerate() {
            let mut hand: Vec<String> = wall.drain(0..13).collect();
            hand.sort();
            players.push(SimPlayer {
                hand,
                draw: None,
                melds: Vec::new(),
                discards: Vec::new(),
                is_riichi: false,
                riichi_discard_index: None,
                score,
                wind: Wind::ALL[seat],
            });
        }
        // The dealer opens with the fourteenth tile.
        players[0].draw = Some(wall.remove(0));

        Self {
            conditions,
            round_wind,
            hand_number,
            honba: gen_range(0, 3) as u8,
            riichi_sticks: gen_range(0, 3) as u8,
            dealer: 0,
            target: player_seat,
            wall,
            dead_wall,
            dora_indicators,
            ura_dora_indicators,
            players,
            records: Vec::new(),
            // The first dora indicator is already revealed at dead wall index
            // 4, so the next kan reveals index 5.
            kan_count: 1,
            rinshan_index: 0,
        }
    }

    /// The current full-turn index: one-based, four live-wall draws per turn.
    pub(crate) fn turn(&self) -> u8 {
        let drawn = 69u16.saturating_sub(self.wall.len() as u16) as u8;
        drawn.div_ceil(4)
    }

    /// Play the round without reporting progress.
    #[cfg(test)]
    pub(crate) fn play(&mut self, policy: &dyn Policy) -> Result<Outcome, String> {
        self.play_with_progress(policy, 1, &mut |_| {})
    }

    /// Play the round to its end, recording the inserted seat's decisions and
    /// reporting each new full turn through `progress`.
    pub(crate) fn play_with_progress(
        &mut self,
        policy: &dyn Policy,
        attempt: usize,
        progress: &mut dyn FnMut(TurnProgress),
    ) -> Result<Outcome, String> {
        let mut seat = self.dealer;
        let mut needs_draw = true;
        // True when the seat reached this discard by calling, not by drawing.
        // Such a position is real, but the trainer's `SelfTurn` context assumes
        // the draw followed kamicha, so it is not a valid insertion point.
        let mut post_call = false;
        let mut steps = 0usize;
        let mut last_turn = 0u8;

        loop {
            steps += 1;
            if steps > MAX_STEPS {
                return Err("the simulated round exceeded its step budget".to_string());
            }

            if needs_draw {
                let Some(tile) = self.wall.first().cloned() else {
                    // The live wall is empty and the last discard has already
                    // been offered: the hand is an exhaustive draw.
                    return Ok(Outcome::Draw);
                };
                self.wall.remove(0);
                self.players[seat].draw = Some(tile);
            }

            let turn = self.turn();
            if turn != last_turn {
                last_turn = turn;
                progress(TurnProgress {
                    attempt,
                    turn,
                    drawn: 69u16.saturating_sub(self.wall.len() as u16) as u8,
                    wall_left: self.wall.len() as u8,
                });
            }

            let riichi = self.players[seat].is_riichi;
            let state = self.actor_state(seat, DecisionSource::SelfTurn);

            let (discard, declare_riichi) = if riichi {
                // A declared hand must throw what it draws.
                let draw = self.players[seat]
                    .draw
                    .clone()
                    .ok_or_else(|| "a Riichi turn has no draw".to_string())?;
                if is_tsumo_win(self.round_wind, &state.players[0]) {
                    return Ok(Outcome::Win { winner: seat });
                }
                (draw, false)
            } else {
                let evaluation = policy.evaluate(&state)?;
                if seat == self.target
                    && !post_call
                    && recordable(&state)
                    && !evaluation_offers_a_win(&evaluation)
                {
                    self.records.push(DecisionRecord {
                        state: state.clone(),
                        evaluation: evaluation.clone(),
                        turn: self.turn(),
                    });
                }
                let top = evaluation
                    .evaluations
                    .first()
                    .cloned()
                    .ok_or_else(|| "the model returned no legal action".to_string())?;
                match top.info.kind {
                    ActionKind::Agari => return Ok(Outcome::Win { winner: seat }),
                    ActionKind::Ryukyoku => return Ok(Outcome::Draw),
                    ActionKind::Kan => {
                        let tile = top
                            .info
                            .tile
                            .clone()
                            .ok_or_else(|| "a Kan action has no tile".to_string())?;
                        let kind = top
                            .info
                            .kan_kind
                            .ok_or_else(|| "a Kan action has no shape".to_string())?;
                        if let Some(outcome) = self.apply_kan(seat, &tile, kind, policy)? {
                            return Ok(outcome);
                        }
                        // The replacement draw is already in the draw slot.
                        needs_draw = false;
                        continue;
                    }
                    ActionKind::Riichi => {
                        let discard = evaluation
                            .riichi_discard
                            .clone()
                            .ok_or_else(|| "Riichi has no declaration discard".to_string())?;
                        (discard, true)
                    }
                    ActionKind::Discard => {
                        let tile = top
                            .info
                            .tile
                            .clone()
                            .ok_or_else(|| "a discard action has no tile".to_string())?;
                        (tile, false)
                    }
                    other => return Err(format!("unexpected self-turn action {other:?}")),
                }
            };

            self.apply_discard(seat, &discard, declare_riichi)?;

            match self.resolve_reactions(seat, &discard, policy)? {
                Reaction::None => {
                    seat = (seat + 1) % 4;
                    needs_draw = true;
                    post_call = false;
                }
                Reaction::Call { caller } => {
                    seat = caller;
                    needs_draw = false;
                    post_call = true;
                }
                Reaction::Ron { winner } => return Ok(Outcome::Win { winner }),
            }
        }
    }

    /// The position one seat is deciding in, rotated so that seat is player 0.
    pub(crate) fn actor_state(&self, seat: usize, source: DecisionSource) -> GameState {
        actor_state(self, seat, source)
    }

    /// Apply a discard (and, when requested, the Riichi declaration on it).
    fn apply_discard(
        &mut self,
        seat: usize,
        tile: &str,
        declare_riichi: bool,
    ) -> Result<(), String> {
        let mut tsumogiri = false;
        let player = &mut self.players[seat];
        if let Some(draw) = player.draw.take() {
            if draw == tile {
                tsumogiri = true;
            } else {
                player.hand.push(draw);
                player.sort_hand();
                if !player.remove_one(tile) {
                    return Err(format!("seat {seat} does not hold {tile} to discard"));
                }
            }
        } else if !player.remove_one(tile) {
            return Err(format!("seat {seat} does not hold {tile} to discard"));
        }

        let mut discard = if tsumogiri {
            DiscardTile::tsumogiri(tile)
        } else {
            DiscardTile::new(tile)
        };
        if declare_riichi {
            discard.is_riichi = true;
            player.is_riichi = true;
            player.riichi_discard_index = Some(player.discards.len());
            player.score -= 1_000;
            self.riichi_sticks = self.riichi_sticks.saturating_add(1);
        }
        player.discards.push(discard);
        Ok(())
    }

    /// Ask every other seat whether it claims the discard, then apply the
    /// winner. Ron beats calls; a pon/kan beats a chi; ties go to the nearer
    /// seat in turn order.
    fn resolve_reactions(
        &mut self,
        discarder: usize,
        tile: &str,
        policy: &dyn Policy,
    ) -> Result<Reaction, String> {
        let mut decisions: Vec<(usize, ActionInfo)> = Vec::new();

        for offset in 1..4 {
            let seat = (discarder + offset) % 4;
            let state = self.actor_state(
                seat,
                DecisionSource::React {
                    from: discarder,
                    tile: tile.to_string(),
                },
            );
            let actions = legal_actions(&state);
            if actions.len() <= 1 {
                // Only Pass is offered: do not spend a forward pass.
                continue;
            }
            let evaluation = policy.evaluate(&state)?;
            let top = evaluation
                .evaluations
                .first()
                .cloned()
                .ok_or_else(|| "the policy returned no reaction".to_string())?;
            if seat == self.target
                && recordable_reaction(&state)
                && !evaluation_offers_a_win(&evaluation)
            {
                self.records.push(DecisionRecord {
                    state: state.clone(),
                    evaluation: evaluation.clone(),
                    turn: self.turn(),
                });
            }
            decisions.push((seat, top.info));
        }

        // Ron first, in turn order.
        if let Some((winner, _)) = decisions
            .iter()
            .find(|(_, info)| info.kind == ActionKind::Agari)
        {
            return Ok(Reaction::Ron { winner: *winner });
        }

        for wanted in [ActionKind::Pon, ActionKind::Kan, ActionKind::Chi] {
            if let Some((caller, info)) = decisions.iter().find(|(_, info)| info.kind == wanted) {
                self.apply_call(*caller, discarder, info)?;
                return Ok(Reaction::Call { caller: *caller });
            }
        }

        Ok(Reaction::None)
    }

    fn apply_call(
        &mut self,
        caller: usize,
        discarder: usize,
        info: &ActionInfo,
    ) -> Result<(), String> {
        let tile = info
            .tile
            .clone()
            .ok_or_else(|| "a call has no claimed tile".to_string())?;
        match info.kind {
            ActionKind::Chi => {
                let mut meld_tiles = vec![tile.clone()];
                for consumed in &info.tiles {
                    if !self.players[caller].remove_one(consumed) {
                        return Err(format!("seat {caller} does not hold {consumed} for a chi"));
                    }
                    meld_tiles.push(consumed.clone());
                }
                meld_tiles.sort();
                self.players[caller].melds.push(CalledMeld {
                    meld_type: MeldType::Chi,
                    tiles: meld_tiles,
                    called_from: Some(discarder),
                });
            }
            ActionKind::Pon => {
                for _ in 0..2 {
                    if !self.players[caller].remove_one(&tile) {
                        return Err(format!("seat {caller} does not hold two {tile} for a pon"));
                    }
                }
                self.players[caller].melds.push(CalledMeld {
                    meld_type: MeldType::Pon,
                    tiles: vec![tile; 3],
                    called_from: Some(discarder),
                });
            }
            ActionKind::Kan => {
                for _ in 0..3 {
                    if !self.players[caller].remove_one(&tile) {
                        return Err(format!(
                            "seat {caller} does not hold three {tile} for a kan"
                        ));
                    }
                }
                self.players[caller].melds.push(CalledMeld {
                    meld_type: MeldType::Kan,
                    tiles: vec![tile; 4],
                    called_from: Some(discarder),
                });
                self.reveal_dora();
                self.draw_replacement(caller)?;
            }
            other => return Err(format!("cannot apply call action {other:?}")),
        }
        self.players[caller].sort_hand();
        Ok(())
    }

    /// Apply a closed or added kan. Returns a round-ending outcome when an
    /// added kan is robbed (chankan).
    fn apply_kan(
        &mut self,
        seat: usize,
        tile: &str,
        kind: crate::decision::KanKind,
        policy: &dyn Policy,
    ) -> Result<Option<Outcome>, String> {
        use crate::decision::KanKind;
        match kind {
            KanKind::Ankan => {
                // Fold the draw in first: the four copies may be split across
                // the hand and the drawn tile, and the draw itself is one of
                // the four removed tiles.
                self.players[seat].fold_draw_into_hand();
                for _ in 0..4 {
                    if !self.players[seat].remove_one(tile) {
                        return Err(format!(
                            "seat {seat} does not hold four {tile} for an ankan"
                        ));
                    }
                }
                self.players[seat].melds.push(CalledMeld {
                    meld_type: MeldType::Ankan,
                    tiles: vec![tile.to_string(); 4],
                    called_from: None,
                });
                self.players[seat].sort_hand();
                self.reveal_dora();
                self.draw_replacement(seat)?;
            }
            KanKind::Kakan => {
                let Some(meld) = self.players[seat].melds.iter_mut().find(|meld| {
                    meld.meld_type == MeldType::Pon
                        && meld.tiles.first().map(String::as_str) == Some(tile)
                }) else {
                    return Err(format!("seat {seat} has no pon of {tile} to add to"));
                };
                meld.meld_type = MeldType::Kan;
                meld.tiles.push(tile.to_string());
                if !self.players[seat].remove_one(tile) {
                    return Err(format!("seat {seat} does not hold the fourth {tile}"));
                }
                // Chankan happens before the replacement draw: the hand is
                // momentarily a 13-tile shape with the added kan on the table.
                self.players[seat].fold_draw_into_hand();
                self.reveal_dora();
                if let Some(outcome) = self.resolve_chankan(seat, tile, policy)? {
                    return Ok(Some(outcome));
                }
                self.draw_replacement(seat)?;
            }
            KanKind::Daiminkan => {
                return Err("a daiminkan is resolved as a reaction, not a self-turn kan".into());
            }
        }
        Ok(None)
    }

    fn resolve_chankan(
        &mut self,
        kan_seat: usize,
        tile: &str,
        policy: &dyn Policy,
    ) -> Result<Option<Outcome>, String> {
        for offset in 1..4 {
            let seat = (kan_seat + offset) % 4;
            let state = self.actor_state(
                seat,
                DecisionSource::ReactKan {
                    from: kan_seat,
                    tile: tile.to_string(),
                },
            );
            let actions = legal_actions(&state);
            if actions.len() <= 1 {
                continue;
            }
            let evaluation = policy.evaluate(&state)?;
            let top = evaluation
                .evaluations
                .first()
                .cloned()
                .ok_or_else(|| "the policy returned no chankan reaction".to_string())?;
            if seat == self.target
                && recordable_reaction(&state)
                && !evaluation_offers_a_win(&evaluation)
            {
                self.records.push(DecisionRecord {
                    state: state.clone(),
                    evaluation: evaluation.clone(),
                    turn: self.turn(),
                });
            }
            if top.info.kind == ActionKind::Agari {
                return Ok(Some(Outcome::Win { winner: seat }));
            }
        }
        Ok(None)
    }

    fn reveal_dora(&mut self) {
        if self.kan_count >= 5 {
            return;
        }
        if let Some(indicator) = self.dead_wall.get(4 + self.kan_count) {
            self.dora_indicators.push(indicator.clone());
        }
        if let Some(indicator) = self.dead_wall.get(9 + self.kan_count) {
            self.ura_dora_indicators.push(indicator.clone());
        }
        self.kan_count += 1;
    }

    fn draw_replacement(&mut self, seat: usize) -> Result<(), String> {
        let Some(tile) = self.dead_wall.get(self.rinshan_index).cloned() else {
            return Err("the dead wall has no replacement draw left".to_string());
        };
        self.rinshan_index += 1;
        self.players[seat].draw = Some(tile);
        Ok(())
    }
}

/// The kind of position being built for a seat.
#[derive(Debug, Clone)]
pub(crate) enum DecisionSource {
    SelfTurn,
    React { from: usize, tile: String },
    ReactKan { from: usize, tile: String },
}

enum Reaction {
    None,
    Call { caller: usize },
    Ron { winner: usize },
}

/// True when a winning action is legal at the position.
///
/// A win is not an insertion point: handing the player "do you want to win?"
/// is a round-ending action, not a turn to play. Tsumo and ron are both
/// [`ActionKind::Agari`]. This checks every legal action, not just the model's
/// top one, so a position where Mortal chose to pass on a win is excluded too.
fn evaluation_offers_a_win(evaluation: &Evaluation) -> bool {
    evaluation
        .evaluations
        .iter()
        .any(|scored| scored.info.kind == ActionKind::Agari)
}

fn recordable(state: &GameState) -> bool {
    if state.players[0].is_riichi {
        // A declared hand must throw what it draws; there is nothing to decide.
        return false;
    }
    let actions = legal_actions(state);
    let discards: BTreeSet<&str> = actions
        .iter()
        .filter(|info| info.kind == ActionKind::Discard)
        .filter_map(|info| info.tile.as_deref())
        .collect();
    discards.len() > 1 || actions.iter().any(|info| info.kind != ActionKind::Discard)
}

fn recordable_reaction(state: &GameState) -> bool {
    legal_actions(state).len() > 1
}

fn fresh_deck() -> Vec<String> {
    let mut codes = Vec::with_capacity(136);
    for tile in ALL_TILES {
        for _ in 0..4 {
            codes.push(tile.to_string());
        }
    }
    shuffle(&mut codes);
    codes
}

/// Parse one tile code into an agari tile.
pub(crate) fn tile_of(code: &str) -> Option<Tile> {
    agari::parse::parse_hand(code).ok()?.into_iter().next()
}

/// Parse a tile list for formatting or agari helpers.
pub(crate) fn tiles_of(codes: &[String]) -> Vec<Tile> {
    codes.iter().filter_map(|code| tile_of(code)).collect()
}

/// The compact display string for a tile list.
pub(crate) fn compact(codes: &[String]) -> String {
    format_hand_compact(&tiles_of(codes))
}

/// The shanten of a hand that is about to discard from `codes`, after the best
/// possible discard. Used for the one discard turn that follows a call, where
/// the engine holds 14 - 3 * melds effective tiles but no real draw.
pub(crate) fn best_post_discard_shanten(codes: &[String], melds: usize) -> i8 {
    let len_div3 = 4u8.saturating_sub(melds as u8);
    let mut counts = code_counts(codes);
    let mut best = 8i8;
    for index in 0..34 {
        if counts[index] == 0 {
            continue;
        }
        counts[index] -= 1;
        let after = crate::ai::sp::calc_all(&counts, len_div3);
        counts[index] += 1;
        best = best.min(after);
    }
    best
}

/// Winning-tile acceptance for a tenpai concealed hand, including melds.
pub(crate) fn ukeire(codes: &[String], melds: usize) -> (Vec<String>, u8) {
    let counts = agari::parse::to_counts(&tiles_of(codes));
    let result = agari::shanten::calculate_ukeire_with_melds(&counts, melds as u8);
    let tiles = result
        .tiles
        .iter()
        .map(|tile| tile.tile.to_string())
        .collect();
    (tiles, result.total_count)
}

/// A placeholder answer for candidate states; the generator replaces it with
/// the evaluated top action before returning the position.
pub(crate) fn pending_answer() -> CorrectAction {
    CorrectAction::best("Pass", None, Vec::new(), "Pending")
}

/// Build a candidate state's base metadata.
#[allow(clippy::too_many_arguments)]
pub(crate) fn base_state(
    category: &str,
    note: Option<String>,
    round_wind: Wind,
    hand_number: u8,
    honba: u8,
    riichi_sticks: u8,
    tiles_remaining: u8,
    dora_indicators: Vec<String>,
    ura_dora_indicators: Vec<String>,
    players: Vec<PlayerState>,
    decision: DecisionContext,
    current_turn: usize,
    shanten: i8,
    is_agari: bool,
    tiles: Vec<String>,
    hand_string: String,
    ukeire_tiles: Vec<String>,
    ukeire_total: u8,
) -> GameState {
    GameState {
        category: category.to_string(),
        target_action: TargetAction::Best,
        correct_action: pending_answer(),
        equivalent_tiles: Vec::new(),
        decision,
        scenario_note: note,
        call_offer: None,
        ai_decision: None,
        riichi_triggers: Vec::new(),
        dama_reasons: Vec::new(),
        shouminkan_triggers: Vec::new(),
        book_rationale: None,
        can_riichi: false,
        hand_string,
        tiles,
        shanten,
        is_agari,
        decompositions_count: 0,
        ukeire_tiles,
        ukeire_total,
        round_wind,
        hand_number,
        honba,
        riichi_sticks,
        dora_indicators,
        ura_dora_indicators,
        tiles_remaining,
        current_turn,
        players,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generator::hotseat::options::{Disparity, HotseatRound, HotseatSeat};
    use crate::generator::hotseat::test_support::FastPolicy;

    fn conditions() -> StartingConditions {
        StartingConditions {
            round: HotseatRound::East1,
            disparity: Disparity::AboutEqualAll,
            seat: HotseatSeat::East,
        }
    }

    #[test]
    fn a_dealt_round_has_a_full_wall_and_four_legal_seats() {
        let table = SimTable::deal(conditions());
        assert_eq!(table.wall.len(), 69);
        assert_eq!(table.dead_wall.len(), 14);
        assert_eq!(table.players.len(), 4);
        for (seat, player) in table.players.iter().enumerate() {
            assert_eq!(player.hand.len(), 13);
            assert_eq!(player.draw.is_none(), seat != 0);
        }
        assert_eq!(table.target, 0);
        assert_eq!(table.dealer, 0);
        assert_eq!(table.players.iter().map(|p| p.score).sum::<i32>(), 100_000);
    }

    #[test]
    fn a_played_round_records_reachable_target_decisions() {
        let policy = FastPolicy::default();
        let mut table = SimTable::deal(conditions());
        table.play(&policy).expect("round plays");
        assert!(
            !table.records.is_empty(),
            "the dealer faces a first discard"
        );
        for record in &table.records {
            let state = &record.state;
            assert_eq!(state.category, "hotseat_pending");
            assert!(state.players[0].is_human);
            assert_eq!(state.players[0].wind, conditions().seat.wind());
            assert_eq!(state.round_wind, conditions().round.parts().0);
            assert_eq!(state.hand_number, 1);
            let actions = legal_actions(state);
            assert!(!actions.is_empty());
            assert!(actions.iter().any(|info| {
                record
                    .evaluation
                    .evaluations
                    .iter()
                    .any(|scored| scored.info.action == info.action)
            }));
        }
    }

    #[test]
    fn wins_are_never_recorded_as_insertion_points() {
        use crate::decision::{ActionEvaluation, ActionInfo};
        let scored = |kind: ActionKind, probability: f32| ActionEvaluation {
            info: ActionInfo {
                action: format!("{kind:?}"),
                label: format!("{kind:?}"),
                kind,
                tile_index: None,
                tile: Some("1m".to_string()),
                tiles: Vec::new(),
                kan_kind: None,
            },
            probability,
            q_value: None,
        };
        let evaluation = |top: ActionKind, rest: Vec<ActionKind>| Evaluation {
            model: "test".to_string(),
            expected_value: 0.0,
            recommended_action: format!("{top:?}"),
            riichi_discard: None,
            evaluations: std::iter::once(scored(top, 0.6))
                .chain(rest.into_iter().map(|kind| scored(kind, 0.2)))
                .collect(),
        };
        assert!(evaluation_offers_a_win(&evaluation(
            ActionKind::Agari,
            Vec::new()
        )));
        assert!(
            evaluation_offers_a_win(&evaluation(ActionKind::Pass, vec![ActionKind::Agari])),
            "a legal win is excluded even when the model's top action is Pass"
        );
        assert!(!evaluation_offers_a_win(&evaluation(
            ActionKind::Discard,
            vec![ActionKind::Pass]
        )));
        assert!(!evaluation_offers_a_win(&evaluation(
            ActionKind::Pass,
            Vec::new()
        )));
    }

    #[test]
    fn a_winning_policy_never_leaves_a_winning_record() {
        use crate::generator::hotseat::test_support::{FastMode, FastPolicy};

        let policy = FastPolicy::new(FastMode::CallsAndWins);
        for run in 0..20 {
            let mut table = SimTable::deal(conditions());
            table
                .play(&policy)
                .unwrap_or_else(|err| panic!("run {run}: {err}"));
            for record in &table.records {
                assert!(
                    !evaluation_offers_a_win(&record.evaluation),
                    "run {run} recorded a win as an insertion point"
                );
            }
        }
    }

    #[test]
    fn progress_reports_each_full_turn() {
        use crate::generator::hotseat::test_support::FastPolicy;

        let policy = FastPolicy::default();
        let mut table = SimTable::deal(conditions());
        let mut events = Vec::new();
        table
            .play_with_progress(&policy, 2, &mut |progress| events.push(progress))
            .expect("round plays");

        assert!(!events.is_empty());
        assert_eq!(events[0].attempt, 2);
        assert_eq!(events[0].turn, 1);
        assert!(
            events
                .windows(2)
                .all(|pair| { pair[1].turn >= pair[0].turn && pair[1].drawn > pair[0].drawn }),
            "progress must advance: {events:?}"
        );
        let last = events.last().expect("a last progress event");
        assert!(
            last.turn >= 17,
            "a no-win round reaches the late game: {last:?}"
        );
        assert_eq!(last.drawn + last.wall_left, 69);
    }

    #[test]
    fn the_fresh_deck_holds_four_copies_of_every_tile() {
        let codes = fresh_deck();
        assert_eq!(codes.len(), 136);
        for tile in ALL_TILES {
            assert_eq!(
                codes
                    .iter()
                    .filter(|code| code.as_str() == tile.to_string())
                    .count(),
                4
            );
        }
    }

    #[test]
    fn calls_and_riichi_rounds_still_record_reachable_tables() {
        use crate::generator::hotseat::test_support::{FastMode, FastPolicy};
        use crate::generator::support::state_validation::validate_reachable_state;

        for mode in [FastMode::CallsAndWins, FastMode::Riichi] {
            let policy = FastPolicy::new(mode);
            for run in 0..15 {
                let mut table = SimTable::deal(StartingConditions {
                    round: HotseatRound::East2,
                    disparity: Disparity::AboutEqualAll,
                    seat: HotseatSeat::South,
                });
                table
                    .play(&policy)
                    .unwrap_or_else(|err| panic!("{mode:?} run {run}: {err}"));
                for record in &table.records {
                    validate_reachable_state(&record.state).unwrap_or_else(|err| {
                        panic!("{mode:?} run {run} recorded an unreachable table: {err}")
                    });
                }
            }
        }
    }

    #[test]
    fn a_non_dealer_target_records_after_the_dealer_opens() {
        use crate::generator::hotseat::test_support::{FastMode, FastPolicy};

        let policy = FastPolicy::new(FastMode::CallsAndWins);
        let mut table = SimTable::deal(StartingConditions {
            round: HotseatRound::East1,
            disparity: Disparity::OneBigGapToFirst,
            seat: HotseatSeat::North,
        });
        table.play(&policy).expect("round plays");
        for record in &table.records {
            assert_eq!(record.state.players[0].wind, Wind::North);
            assert_eq!(record.state.players[0].seat, 0);
            assert_eq!(record.state.players[0].score, 27_000);
        }
    }

    #[test]
    fn closed_and_added_kans_draw_from_the_dead_wall_and_reveal_a_dora() {
        use crate::decision::KanKind;
        use crate::generator::hotseat::test_support::FastPolicy;

        let policy = FastPolicy::default();
        let mut table = SimTable::deal(conditions());
        let dora_before = table.dora_indicators.len();
        let ura_before = table.ura_dora_indicators.len();
        let rinshan = table.dead_wall[0].clone();

        table.players[0].hand = vec![
            "5m", "5m", "5m", "5m", "1p", "2p", "3p", "4p", "6p", "7p", "8p", "1s", "2s",
        ]
        .into_iter()
        .map(str::to_string)
        .collect();
        table.players[0].draw = Some("1p".to_string());

        assert!(
            table
                .apply_kan(0, "5m", KanKind::Ankan, &policy)
                .expect("ankan applies")
                .is_none(),
            "an ankan is not robbed"
        );
        assert!(table.players[0].melds.iter().any(|meld| {
            meld.meld_type == MeldType::Ankan && meld.tiles.len() == 4 && meld.called_from.is_none()
        }));
        assert_eq!(table.players[0].hand.len(), 10);
        assert_eq!(table.players[0].draw.as_deref(), Some(rinshan.as_str()));
        assert_eq!(table.dora_indicators.len(), dora_before + 1);
        assert_eq!(table.ura_dora_indicators.len(), ura_before + 1);
        assert_eq!(
            table.dora_indicators[1], table.dead_wall[5],
            "the first kan reveals the second indicator, not the first again"
        );

        // Added kan: one more 5m on top of an existing pon.
        let mut table = SimTable::deal(conditions());
        table.players[0].melds = vec![CalledMeld {
            meld_type: MeldType::Pon,
            tiles: vec!["5m".to_string(); 3],
            called_from: Some(1),
        }];
        table.players[0].hand = vec!["5m", "1p", "2p", "3p", "4p", "6p", "7p", "8p", "1s", "2s"]
            .into_iter()
            .map(str::to_string)
            .collect();
        assert!(
            table
                .apply_kan(0, "5m", KanKind::Kakan, &policy)
                .expect("kakan applies")
                .is_none(),
            "nobody robs this kakan"
        );
        let kan = table.players[0]
            .melds
            .iter()
            .find(|meld| meld.meld_type == MeldType::Kan)
            .expect("the pon became a kan");
        assert_eq!(kan.tiles, vec!["5m".to_string(); 4]);
        assert!(table.players[0].draw.is_some(), "replacement draw");
    }

    #[test]
    fn a_daiminkan_claims_three_copies_and_draws_a_replacement() {
        use crate::decision::KanKind;

        let mut table = SimTable::deal(conditions());
        let dora_before = table.dora_indicators.len();
        table.players[1].hand = vec![
            "5m", "5m", "5m", "1p", "2p", "3p", "4p", "6p", "7p", "8p", "1s", "2s", "3s",
        ]
        .into_iter()
        .map(str::to_string)
        .collect();
        let info = ActionInfo {
            action: "Kan".to_string(),
            label: "Daiminkan 5m".to_string(),
            kind: ActionKind::Kan,
            tile_index: Some(4),
            tile: Some("5m".to_string()),
            tiles: Vec::new(),
            kan_kind: Some(KanKind::Daiminkan),
        };
        table.apply_call(1, 0, &info).expect("daiminkan applies");
        assert!(table.players[1].melds.iter().any(|meld| {
            meld.meld_type == MeldType::Kan && meld.tiles.len() == 4 && meld.called_from == Some(0)
        }));
        assert_eq!(table.players[1].hand.len(), 10);
        assert!(table.players[1].draw.is_some());
        assert_eq!(table.dora_indicators.len(), dora_before + 1);
    }
}
