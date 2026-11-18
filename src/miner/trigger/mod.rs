//! Cheap candidate triggers and family filters (implementation unit S1).
//!
//! Replay-strategy §6.5.1 lists the decision-node filters that raise recall
//! before the expensive Mortal pass. This module implements them. It is a
//! **recall filter**, not a selector: a hit means "worth inspecting", never
//! "this is a scenario". S2 owns quotas, dedupe and review; S3 refines the
//! close-call and blunder thresholds.
//!
//! # The triggers
//!
//! | [`TriggerKind`] | Fires when | Model needed |
//! | --- | --- | --- |
//! | [`TriggerKind::DefensiveRiichi`] | an opponent declared Riichi, the actor is 0–2-shanten, a genbutsu or suji is in hand, and a Riichi threat is tenpai in the record | no |
//! | [`TriggerKind::OffensiveArchitecture`] | no active Riichi, the actor is 1-shanten, the table is in turns 5–12, and two legal discards diverge in **both** acceptance and hand value | no |
//! | [`TriggerKind::Book`] | a B1/B2/B3 classifier returns a unique match | no |
//! | [`TriggerKind::CallKan`] | a Chi, Pon or Kan is legal | no |
//! | [`TriggerKind::ScorePlacement`] | all-last, honba, Riichi sticks or a large score spread | no |
//! | [`TriggerKind::CloseCall`] | the label's top-two gap is in its family's close band | yes, **cached** |
//! | [`TriggerKind::Blunder`] | the played action sits below the label's top action by the family's confidence margin | yes, **cached** |
//!
//! The five cheap triggers never run the model: [`evaluate_cheap`] uses the
//! replay's own snapshot, the book classifiers, `agari` and the safety chart.
//! The two label-derived triggers read an already-computed [`ModelLabel`]; they
//! never cause a forward pass. A shard run can therefore use the cheap triggers
//! as a prefilter and evaluate only the decisions one of them keeps
//! ([`TriggerFilter`]).
//!
//! # Why each fired
//!
//! Every hit carries a stable code and a short structured detail:
//!
//! ```text
//! trigger: "defensive_riichi"
//! detail:  "riichi=2;shanten=1;safe=9p(genbutsu),1m(suji);tenpai=2"
//!
//! trigger: "book:ch8.4"
//! detail:  "lesson=fold_to_riichi;section=ch8.4"
//! ```
//!
//! [`TriggerReport::primary_code`] is the most specific hit, which is what the
//! `decisions.trigger` column stores; `decisions.trigger_detail` stores the
//! whole report as `riichiprac.candidate-trigger` v1 JSON. [`record_triggers`]
//! writes both onto an existing row without creating one: extraction owns row
//! creation.
//!
//! # What a trigger deliberately does not claim
//!
//! - It does not name the graded answer. A book hit records the lesson and its
//!   book section, not the tile. The defensive/offensive details list candidate
//!   tiles because that *is* the reason the trigger fired; those details are
//!   selection metadata, never pre-answer UI or pack provenance.
//! - It does not use hidden information to formulate the question. The
//!   defensive trigger reads the Riichi threat's concealed hand only to confirm
//!   the record says the threat is tenpai, which is a provenance check; the
//!   drill is still solvable from the visible river and hand. The strategy
//!   explicitly allows hidden-hand facts to *validate* a scenario (§7.1 gate 4).
//! - It does not use the game outcome. The blunder trigger compares the played
//!   action with the labeler's top action, never with the result of the kyoku.
//! - It does not invent a percentile. Without a [`LabelCuts`] sample, the
//!   close-call and blunder triggers stay silent; they are not guessed from an
//!   absolute threshold.
//!
//! # Families
//!
//! [`families::families_for`] maps the hits plus the label kind onto the
//! strategy's candidate families, and [`families::FamilyFilter`] decides
//! whether a candidate is still in scope. See [`families`].

pub mod families;
pub mod report;

#[cfg(test)]
mod tests;

use std::collections::{BTreeMap, BTreeSet};

use agari::parse::to_counts;
use agari::shanten::calculate_shanten_with_melds;
use agari::tile::Tile;
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::decision::ActionKind;
use crate::generator::SCENARIO_MANIFEST;
use crate::generator::support::analysis::evaluate_hand;
use crate::generator::support::value::worst_completion_value;
use crate::miner::classifier::classify_decision;
use crate::miner::label::ModelLabel;
use crate::miner::label::thresholds::{
    Band, DecisionFamily, PercentileCuts, ThresholdError, table_turn,
};
use crate::replay::walk::{DecisionKind, DecisionSnapshot};
use crate::safety::{SafetyFacts, SafetyMechanism};
use crate::state::{GameState, PlayerState, Wind};
use families::{Family, families_for};

pub use families::FamilyFilter;

/// Schema name carried by a serialised trigger report.
pub const TRIGGER_SCHEMA: &str = "riichiprac.candidate-trigger";

/// Version of the trigger report schema.
pub const TRIGGER_VERSION: u32 = 1;

/// The candidate trigger families.
///
/// Declaration order is precedence order: the first fired hit is the most
/// specific one and becomes `decisions.trigger`. A book cell is the most
/// specific label; a score context is the least.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TriggerKind {
    /// A unique book classifier match.
    Book,
    /// An opponent declared Riichi and the actor has a safe tile.
    DefensiveRiichi,
    /// A quiet 1-shanten turn with a speed/value divergence.
    OffensiveArchitecture,
    /// A call or kan is offered/legal.
    CallKan,
    /// All-last, honba, Riichi sticks or a large score spread.
    ScorePlacement,
    /// The top-two model gap is in the family's close band.
    CloseCall,
    /// The played action is far below the model's top action.
    Blunder,
}

impl TriggerKind {
    /// Every trigger, in precedence order.
    pub const ALL: [Self; 7] = [
        Self::Book,
        Self::DefensiveRiichi,
        Self::OffensiveArchitecture,
        Self::CallKan,
        Self::ScorePlacement,
        Self::CloseCall,
        Self::Blunder,
    ];

    /// The triggers a model-free pass can evaluate.
    pub const CHEAP: [Self; 5] = [
        Self::Book,
        Self::DefensiveRiichi,
        Self::OffensiveArchitecture,
        Self::CallKan,
        Self::ScorePlacement,
    ];

    /// The database/report spelling of the trigger family.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Book => "book",
            Self::DefensiveRiichi => "defensive_riichi",
            Self::OffensiveArchitecture => "offensive_architecture",
            Self::CallKan => "call_kan",
            Self::ScorePlacement => "score_placement",
            Self::CloseCall => "close_call",
            Self::Blunder => "blunder",
        }
    }

    /// Parse a trigger name. The strategy's short CLI names are accepted.
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        let normalised = raw.trim().to_ascii_lowercase().replace('-', "_");
        match normalised.as_str() {
            "book" | "book_matcher" => Some(Self::Book),
            "defensive" | "defensive_riichi" | "riichi_defense" => Some(Self::DefensiveRiichi),
            "offensive" | "offensive_architecture" | "architecture" => {
                Some(Self::OffensiveArchitecture)
            }
            "call" | "call_kan" | "kan" => Some(Self::CallKan),
            "score" | "score_placement" | "placement" => Some(Self::ScorePlacement),
            "close" | "close_call" => Some(Self::CloseCall),
            "blunder" | "mistake" => Some(Self::Blunder),
            _ => None,
        }
    }

    /// True when the trigger reads a model label.
    #[must_use]
    pub const fn needs_label(self) -> bool {
        matches!(self, Self::CloseCall | Self::Blunder)
    }

    /// True when the trigger is model-free.
    #[must_use]
    pub const fn is_cheap(self) -> bool {
        !self.needs_label()
    }
}

impl std::fmt::Display for TriggerKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One trigger that fired, with its stable code and recorded reason.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TriggerHit {
    /// The trigger family.
    pub trigger: TriggerKind,
    /// Stable code, e.g. `defensive_riichi` or `book:ch8.4`.
    pub code: String,
    /// Short structured facts explaining the hit. Answer-free metadata.
    pub detail: String,
}

impl TriggerHit {
    /// A hit with its code and detail.
    #[must_use]
    pub fn new(trigger: TriggerKind, code: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            trigger,
            code: code.into(),
            detail: detail.into(),
        }
    }
}

/// Every trigger that fired for one decision, plus its candidate families.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TriggerReport {
    /// [`TRIGGER_SCHEMA`].
    pub schema: String,
    /// [`TRIGGER_VERSION`].
    pub version: u32,
    /// Fired triggers, in precedence order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hits: Vec<TriggerHit>,
    /// Families this candidate can feed, in report order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub families: Vec<Family>,
    /// Non-fatal reasons a trigger declined to fire (a book conflict, a
    /// missing label, a malformed tile).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
}

impl Default for TriggerReport {
    fn default() -> Self {
        Self::new()
    }
}

impl TriggerReport {
    /// An empty report.
    #[must_use]
    pub fn new() -> Self {
        Self {
            schema: TRIGGER_SCHEMA.to_string(),
            version: TRIGGER_VERSION,
            hits: Vec::new(),
            families: Vec::new(),
            notes: Vec::new(),
        }
    }

    /// Add a hit, keeping precedence order and one hit per family.
    pub fn add_hit(&mut self, hit: TriggerHit) {
        if self
            .hits
            .iter()
            .any(|existing| existing.trigger == hit.trigger)
        {
            return;
        }
        self.hits.push(hit);
        self.hits.sort_by_key(|hit| hit.trigger);
    }

    /// Recompute the family list from the hits and an optional label.
    pub fn refresh_families(&mut self, label: Option<&ModelLabel>) {
        self.families = families_for(&self.hits, label).into_iter().collect();
    }

    /// True when any trigger fired.
    #[must_use]
    pub fn has_any(&self) -> bool {
        !self.hits.is_empty()
    }

    /// Whether one trigger family fired.
    #[must_use]
    pub fn fired(&self, trigger: TriggerKind) -> bool {
        self.hits.iter().any(|hit| hit.trigger == trigger)
    }

    /// The most specific hit's code, or `None`.
    #[must_use]
    pub fn primary_code(&self) -> Option<&str> {
        self.hits.first().map(|hit| hit.code.as_str())
    }

    /// The families as a set, for [`FamilyFilter`].
    #[must_use]
    pub fn family_set(&self) -> BTreeSet<Family> {
        self.families.iter().copied().collect()
    }

    /// The full report as `trigger_detail` JSON.
    pub fn to_json(&self) -> Result<String, TriggerError> {
        Ok(serde_json::to_string(self)?)
    }
}

/// The thresholds the cheap triggers use.
///
/// The defaults are the strategy's stated windows, not tuned constants:
/// defensive 0–2-shanten (§6.5.1), offensive turns 5–12 (§6.5.1), and a
/// divergence that needs a visible gap between the plans. The two divergence
/// gaps are structural recalls, not point claims: `min_value_gap` is in ron
/// points because `worst_completion_value` is, and `min_ukeire_gap` is a tile
/// count.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TriggerConfig {
    /// Highest actor shanten the defensive trigger accepts.
    pub defensive_max_shanten: i8,
    /// Inclusive table-turn window for the offensive trigger.
    pub offensive_turns: (usize, usize),
    /// Minimum ukeire gap between the speed plan and the value plan.
    pub offensive_min_ukeire_gap: u16,
    /// Minimum worst-value gap (ron points) between the value and speed plans.
    pub offensive_min_value_gap: u32,
    /// Score spread (max − min) that counts as a placement context.
    pub large_score_gap: i32,
}

impl Default for TriggerConfig {
    fn default() -> Self {
        Self {
            defensive_max_shanten: 2,
            offensive_turns: (5, 12),
            offensive_min_ukeire_gap: 2,
            offensive_min_value_gap: 1_000,
            large_score_gap: 15_000,
        }
    }
}

impl TriggerConfig {
    /// Reject a window or gap that cannot describe a decision.
    pub fn validate(&self) -> Result<(), TriggerError> {
        if !(0..=6).contains(&self.defensive_max_shanten) {
            return Err(TriggerError::InvalidConfig {
                message: format!(
                    "defensive_max_shanten {} is outside 0..=6",
                    self.defensive_max_shanten
                ),
            });
        }
        let (first, last) = self.offensive_turns;
        if first > last || last > 100 {
            return Err(TriggerError::InvalidConfig {
                message: format!("offensive turns {first}..={last} is not a usable window"),
            });
        }
        if self.offensive_min_ukeire_gap == 0 {
            return Err(TriggerError::InvalidConfig {
                message: "offensive_min_ukeire_gap must be at least one tile".to_string(),
            });
        }
        if self.offensive_min_value_gap == 0 {
            return Err(TriggerError::InvalidConfig {
                message: "offensive_min_value_gap must be at least one point".to_string(),
            });
        }
        if self.large_score_gap < 0 {
            return Err(TriggerError::InvalidConfig {
                message: "large_score_gap cannot be negative".to_string(),
            });
        }
        Ok(())
    }
}

/// A pre-model trigger filter.
///
/// The enabled set is restricted to [`TriggerKind::CHEAP`]: a label-derived
/// trigger cannot decide whether a model pass is needed, because the model pass
/// is what produces its input. A shard run evaluates a decision only when one of
/// these triggers fires.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TriggerFilter {
    enabled: BTreeSet<TriggerKind>,
}

impl TriggerFilter {
    /// Build a filter from trigger names. An empty list means no filter.
    ///
    /// A label-derived name is a hard error, not a silent no-op.
    pub fn parse(names: &[String]) -> Result<Option<Self>, TriggerError> {
        if names.is_empty() {
            return Ok(None);
        }
        let mut enabled = BTreeSet::new();
        for name in names {
            let trigger = TriggerKind::parse(name)
                .ok_or_else(|| TriggerError::UnknownTrigger { name: name.clone() })?;
            if trigger.needs_label() {
                return Err(TriggerError::LabelDerivedPrefilter {
                    name: trigger.as_str().to_string(),
                });
            }
            enabled.insert(trigger);
        }
        if enabled.is_empty() {
            return Ok(None);
        }
        Ok(Some(Self { enabled }))
    }

    /// A filter over the given cheap triggers.
    pub fn only(kinds: impl IntoIterator<Item = TriggerKind>) -> Result<Self, TriggerError> {
        let mut enabled = BTreeSet::new();
        for trigger in kinds {
            if trigger.needs_label() {
                return Err(TriggerError::LabelDerivedPrefilter {
                    name: trigger.as_str().to_string(),
                });
            }
            enabled.insert(trigger);
        }
        if enabled.is_empty() {
            return Err(TriggerError::InvalidConfig {
                message: "a trigger filter needs at least one trigger".to_string(),
            });
        }
        Ok(Self { enabled })
    }

    /// The enabled cheap triggers.
    #[must_use]
    pub fn enabled(&self) -> Vec<TriggerKind> {
        TriggerKind::ALL
            .into_iter()
            .filter(|trigger| self.enabled.contains(trigger))
            .collect()
    }

    /// Evaluate only the enabled triggers.
    #[must_use]
    pub fn report(&self, snapshot: &DecisionSnapshot, config: &TriggerConfig) -> TriggerReport {
        evaluate_selected(snapshot, config, &self.enabled)
    }
}

/// Evaluate every model-free trigger.
#[must_use]
pub fn evaluate_cheap(snapshot: &DecisionSnapshot, config: &TriggerConfig) -> TriggerReport {
    let enabled: BTreeSet<TriggerKind> = TriggerKind::CHEAP.into_iter().collect();
    evaluate_selected(snapshot, config, &enabled)
}

/// Evaluate the selected model-free triggers.
#[must_use]
pub fn evaluate_selected(
    snapshot: &DecisionSnapshot,
    config: &TriggerConfig,
    enabled: &BTreeSet<TriggerKind>,
) -> TriggerReport {
    let mut report = TriggerReport::new();
    if snapshot.state.players.len() != 4 {
        report.notes.push(format!(
            "expected four players, found {}",
            snapshot.state.players.len()
        ));
        return report;
    }
    if enabled.contains(&TriggerKind::Book) {
        book_trigger(snapshot, &mut report);
    }
    if enabled.contains(&TriggerKind::DefensiveRiichi) {
        defensive_trigger(snapshot, config, &mut report);
    }
    if enabled.contains(&TriggerKind::OffensiveArchitecture) {
        offensive_trigger(snapshot, config, &mut report);
    }
    if enabled.contains(&TriggerKind::CallKan) {
        call_kan_trigger(snapshot, &mut report);
    }
    if enabled.contains(&TriggerKind::ScorePlacement) {
        score_placement_trigger(snapshot, config, &mut report);
    }
    report.refresh_families(None);
    report
}

/// Evaluate every trigger, adding the label-derived ones from a cached label.
#[must_use]
pub fn evaluate_with_label(
    snapshot: &DecisionSnapshot,
    label: &ModelLabel,
    cuts: &LabelCuts,
    config: &TriggerConfig,
) -> TriggerReport {
    let mut report = evaluate_cheap(snapshot, config);
    let family = DecisionFamily::of(snapshot).key();
    if let Some(hit) = close_call_hit(&family, label, &cuts.close_call) {
        report.add_hit(hit);
    }
    if let Some(hit) = blunder_hit(&family, &snapshot.played.action, label, &cuts.blunder) {
        report.add_hit(hit);
    }
    report.refresh_families(Some(label));
    report
}

/// Percentile cuts for the two label-derived triggers.
///
/// They are kept apart because they measure different gaps: a close call bands
/// the top-two gap, a blunder bands the gap between the played action and the
/// top action. Both are in model-utility units and come from the corpus sample,
/// never from an absolute constant.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LabelCuts {
    /// Cuts for [`TriggerKind::CloseCall`], built from top-two gaps.
    pub close_call: PercentileCuts,
    /// Cuts for [`TriggerKind::Blunder`], built from played-action gaps.
    pub blunder: PercentileCuts,
}

impl LabelCuts {
    /// Empty cuts: no family reaches the eight-sample minimum, so neither
    /// label-derived trigger fires.
    #[must_use]
    pub fn empty() -> Self {
        Self {
            close_call: PercentileCuts {
                families: BTreeMap::new(),
            },
            blunder: PercentileCuts {
                families: BTreeMap::new(),
            },
        }
    }
}

/// Whether a decision's label puts its top-two gap in the close band.
#[must_use]
pub fn close_call_hit(
    family: &str,
    label: &ModelLabel,
    cuts: &PercentileCuts,
) -> Option<TriggerHit> {
    let gap = label.top2_gap()?;
    let cut = cuts.families.get(family)?;
    if cut.band(gap)? != Band::Close {
        return None;
    }
    let boundary = cut
        .close_at_or_below
        .map_or_else(|| "unknown".to_string(), |value| format!("{value:.4}"));
    Some(TriggerHit::new(
        TriggerKind::CloseCall,
        "close_call",
        format!("family={family};gap={gap:.4};close_cut={boundary}"),
    ))
}

/// The gap between the label's top action and the action the record played.
///
/// `None` when the played action is the top action, is not scored, or has no
/// positive gap. The gap is `q(top) − q(played)` in model-utility units.
#[must_use]
pub fn played_gap(played_action: &str, label: &ModelLabel) -> Option<f32> {
    if played_action == label.top_action {
        return None;
    }
    let top = label.q_values.get(&label.top_action)?;
    let played = label.q_values.get(played_action)?;
    let gap = top - played;
    gap.is_finite().then_some(gap)
}

/// Whether the played action is far enough below the model's top action.
#[must_use]
pub fn blunder_hit(
    family: &str,
    played_action: &str,
    label: &ModelLabel,
    cuts: &PercentileCuts,
) -> Option<TriggerHit> {
    let gap = played_gap(played_action, label)?;
    let cut = cuts.families.get(family)?;
    if cut.band(gap)? != Band::Confident {
        return None;
    }
    let boundary = cut
        .confident_at_or_above
        .map_or_else(|| "unknown".to_string(), |value| format!("{value:.4}"));
    Some(TriggerHit::new(
        TriggerKind::Blunder,
        "blunder",
        format!(
            "family={family};q_gap_played={gap:.4};confidence_cut={boundary};played={played_action}"
        ),
    ))
}

// --- Cheap triggers -------------------------------------------------------

/// A unique book match. A conflict keeps the trigger silent and records why.
fn book_trigger(snapshot: &DecisionSnapshot, report: &mut TriggerReport) {
    if snapshot.furiten {
        report
            .notes
            .push("book: furiten state is not mined".to_string());
        return;
    }
    match classify_decision(snapshot) {
        Ok(Some(matched)) => {
            let lesson = matched.lesson;
            let section = SCENARIO_MANIFEST
                .iter()
                .find(|meta| meta.id == lesson)
                .and_then(|meta| meta.book);
            let section_key = section.map(|section| section.key());
            let code = section_key.as_ref().map_or_else(
                || format!("book:{}", lesson.as_str()),
                |key| format!("book:{key}"),
            );
            let detail = format!(
                "lesson={};section={}",
                lesson.as_str(),
                section_key.as_deref().unwrap_or("none")
            );
            report.add_hit(TriggerHit::new(TriggerKind::Book, code, detail));
        }
        Ok(None) => {}
        Err(conflict) => {
            let lessons: Vec<&str> = conflict
                .matches
                .iter()
                .map(|matched| matched.lesson.as_str())
                .collect();
            report.notes.push(format!(
                "book: unresolved conflict between {}",
                lessons.join(",")
            ));
        }
    }
}

/// An opponent's Riichi plus a safe tile in the actor's hand.
fn defensive_trigger(
    snapshot: &DecisionSnapshot,
    config: &TriggerConfig,
    report: &mut TriggerReport,
) {
    let state = &snapshot.state;
    let riichi: Vec<usize> = state
        .players
        .iter()
        .filter(|player| player.seat != 0 && player.is_riichi)
        .map(|player| player.seat)
        .collect();
    if riichi.is_empty() {
        return;
    }
    let shanten = actor_shanten(state);
    if shanten < 0 || shanten > config.defensive_max_shanten {
        return;
    }

    let concealed = concealed_tiles(&state.players[0]);
    let mut safe: Vec<String> = Vec::new();
    let mut tenpai: Vec<usize> = Vec::new();
    for &threat_seat in &riichi {
        let Some(threat) = state
            .players
            .iter()
            .find(|player| player.seat == threat_seat)
        else {
            continue;
        };
        if threat_is_tenpai(threat) {
            tenpai.push(threat_seat);
        }
        let Some(facts) = SafetyFacts::from_state(state, threat_seat) else {
            continue;
        };
        for code in &concealed {
            let Ok(tile) = Tile::try_from(code.as_str()) else {
                continue;
            };
            let read = facts.read(tile);
            if let Some(mechanism) = safety_mechanism(read.mechanism) {
                safe.push(format!("{code}({mechanism})"));
            }
        }
    }
    if safe.is_empty() || tenpai.is_empty() {
        return;
    }
    safe.sort();
    safe.dedup();
    let riichi_list: Vec<String> = riichi.iter().map(usize::to_string).collect();
    let tenpai_list: Vec<String> = tenpai.iter().map(usize::to_string).collect();
    report.add_hit(TriggerHit::new(
        TriggerKind::DefensiveRiichi,
        "defensive_riichi",
        format!(
            "riichi={};shanten={};safe={};tenpai={}",
            riichi_list.join(","),
            shanten,
            safe.join(","),
            tenpai_list.join(",")
        ),
    ));
}

/// A quiet 1-shanten turn whose two best plans trade acceptance for value.
fn offensive_trigger(
    snapshot: &DecisionSnapshot,
    config: &TriggerConfig,
    report: &mut TriggerReport,
) {
    let state = &snapshot.state;
    if snapshot.kind != DecisionKind::SelfTurn {
        return;
    }
    if state.players.iter().any(|player| player.is_riichi) {
        return;
    }
    if state.shanten != 1 {
        return;
    }
    if !state.players[0].melds.is_empty() {
        // The post-discard evaluation is the closed-hand `agari` reading; an
        // open shape would need a meld-aware completion walk this trigger does
        // not own yet. Staying silent is the fail-closed choice.
        return;
    }
    let (first, last) = config.offensive_turns;
    let turn = table_turn(snapshot);
    if !(first..=last).contains(&turn) {
        return;
    }
    if state.players[0].draw.is_none() {
        return;
    }

    // Acceptance is cheap; value is not. A hand whose discards all keep the
    // same acceptance cannot diverge, so its completion tree is never walked.
    let mut plans = acceptance_plans(snapshot);
    if !acceptance_gap_possible(&plans, config.offensive_min_ukeire_gap) {
        return;
    }
    fill_plan_values(state, &mut plans);
    let Some((speed, value)) = divergent_pair(&plans, config) else {
        return;
    };
    report.add_hit(TriggerHit::new(
        TriggerKind::OffensiveArchitecture,
        "offensive_architecture",
        format!(
            "turn={turn};speed={}(ukeire={},value={});value={}(ukeire={},value={})",
            speed.tile, speed.ukeire, speed.value, value.tile, value.ukeire, value.value
        ),
    ));
}

/// A Chi, Pon or Kan in the legal-action set.
fn call_kan_trigger(snapshot: &DecisionSnapshot, report: &mut TriggerReport) {
    let mut offers: Vec<&'static str> = Vec::new();
    for action in &snapshot.legal_actions {
        let name = match action.kind {
            ActionKind::Chi => Some("chi"),
            ActionKind::Pon => Some("pon"),
            ActionKind::Kan => Some("kan"),
            _ => None,
        };
        if let Some(name) = name
            && !offers.contains(&name)
        {
            offers.push(name);
        }
    }
    if offers.is_empty() {
        return;
    }
    report.add_hit(TriggerHit::new(
        TriggerKind::CallKan,
        "call_kan",
        format!("offers={}", offers.join(",")),
    ));
}

/// All-last, honba, Riichi sticks or a large score spread.
fn score_placement_trigger(
    snapshot: &DecisionSnapshot,
    config: &TriggerConfig,
    report: &mut TriggerReport,
) {
    let state = &snapshot.state;
    let all_last = state.round_wind == Wind::South && state.hand_number >= 4;
    let renchan = state.honba > 0;
    let sticks = state.riichi_sticks > 0;
    let spread = score_spread(state);
    let large_gap = spread >= config.large_score_gap;
    if !(all_last || renchan || sticks || large_gap) {
        return;
    }
    report.add_hit(TriggerHit::new(
        TriggerKind::ScorePlacement,
        "score_placement",
        format!(
            "all_last={all_last};honba={};riichi_sticks={};spread={spread}",
            state.honba, state.riichi_sticks
        ),
    ));
}

// --- Offensive plans ------------------------------------------------------

/// One legal discard's post-discard plan.
///
/// Shared with the S3 speed/vs-value selector (`select::special`): the trigger
/// and the selector must measure the same plans, or a trigger hit and a selector
/// verdict could disagree about what the hand offers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DiscardPlan {
    pub(crate) tile: String,
    /// True when the discarded copy is a red five; the completion value then
    /// loses its aka-dora bonus.
    pub(crate) red: bool,
    pub(crate) ukeire: u16,
    pub(crate) value: u32,
}

/// Every legal discard that keeps the hand 1-shanten, with its acceptance.
///
/// `value` is filled separately by [`fill_plan_values`], because the completion
/// walk behind it is the expensive part of the trigger.
pub(crate) fn acceptance_plans(snapshot: &DecisionSnapshot) -> Vec<DiscardPlan> {
    let state = &snapshot.state;
    let concealed = concealed_tiles(&state.players[0]);
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut plans = Vec::new();
    for action in &snapshot.legal_actions {
        if action.kind != ActionKind::Discard {
            continue;
        }
        let Some(tile) = action.tile.as_deref() else {
            continue;
        };
        if !seen.insert(action.action.clone()) {
            continue;
        }
        let mut tiles: Vec<Tile> = concealed
            .iter()
            .filter_map(|code| Tile::try_from(code.as_str()).ok())
            .collect();
        let Some(position) = tiles.iter().position(|held| held.to_string() == tile) else {
            continue;
        };
        tiles.remove(position);
        if tiles.len() != 13 {
            continue;
        }
        let metrics = evaluate_hand(&tiles);
        if metrics.shanten != 1 {
            continue;
        }
        plans.push(DiscardPlan {
            tile: tile.to_string(),
            red: action.action.ends_with('r'),
            ukeire: u16::from(metrics.ukeire_total),
            value: 0,
        });
    }
    plans
}

/// Whether any two plans keep a large enough acceptance gap to be worth a
/// completion walk.
pub(crate) fn acceptance_gap_possible(plans: &[DiscardPlan], min_ukeire_gap: u16) -> bool {
    plans.iter().any(|speed| {
        plans.iter().any(|value| {
            speed.tile != value.tile && speed.ukeire >= value.ukeire.saturating_add(min_ukeire_gap)
        })
    })
}

/// Fill each plan's worst-completion value.
pub(crate) fn fill_plan_values(state: &GameState, plans: &mut [DiscardPlan]) {
    let concealed = concealed_tiles(&state.players[0]);
    let dora: Vec<Tile> = state
        .dora_indicators
        .iter()
        .filter_map(|code| Tile::try_from(code.as_str()).ok())
        .collect();
    for plan in plans {
        let mut tiles: Vec<Tile> = concealed
            .iter()
            .filter_map(|code| Tile::try_from(code.as_str()).ok())
            .collect();
        let Some(position) = tiles.iter().position(|held| held.to_string() == plan.tile) else {
            continue;
        };
        tiles.remove(position);
        if tiles.len() != 13 {
            continue;
        }
        let aka = state.players[0].red_fives.len().min(u8::MAX as usize) as u8;
        plan.value =
            worst_completion_value(&tiles, state.round_wind, state.players[0].wind, &dora, aka)
                .map_or(0, |value| value.points);
    }
}

/// The clearest speed-vs-value pair, if one exists.
///
/// A pair qualifies only when the speed plan keeps **both** more acceptance (by
/// the configured tile gap) **and** less value (by the configured point gap)
/// than the value plan. The chosen pair is the one with the largest speed
/// acceptance, then the largest value, then the first tile name, so the report
/// is deterministic.
fn divergent_pair<'a>(
    plans: &'a [DiscardPlan],
    config: &TriggerConfig,
) -> Option<(&'a DiscardPlan, &'a DiscardPlan)> {
    let mut pairs: Vec<(&DiscardPlan, &DiscardPlan)> = Vec::new();
    for speed in plans {
        for value in plans {
            if speed.tile == value.tile {
                continue;
            }
            if speed.ukeire < value.ukeire.saturating_add(config.offensive_min_ukeire_gap) {
                continue;
            }
            if value.value < speed.value.saturating_add(config.offensive_min_value_gap) {
                continue;
            }
            pairs.push((speed, value));
        }
    }
    pairs.sort_by(|left, right| {
        right
            .0
            .ukeire
            .cmp(&left.0.ukeire)
            .then_with(|| right.1.value.cmp(&left.1.value))
            .then_with(|| left.0.tile.cmp(&right.0.tile))
            .then_with(|| left.1.tile.cmp(&right.1.tile))
    });
    pairs.into_iter().next()
}

// --- Helpers --------------------------------------------------------------

fn concealed_tiles(player: &PlayerState) -> Vec<String> {
    player
        .hand
        .iter()
        .chain(player.draw.iter())
        .cloned()
        .collect()
}

/// The actor's shanten with called melds counted.
///
/// `GameState::shanten` is the walker's closed-hand reading; an open hand needs
/// the meld count or a 1-shanten hand looks further away than it is.
fn actor_shanten(state: &GameState) -> i8 {
    let tiles: Vec<Tile> = concealed_tiles(&state.players[0])
        .iter()
        .filter_map(|code| Tile::try_from(code.as_str()).ok())
        .collect();
    calculate_shanten_with_melds(
        &to_counts(&tiles),
        state.players[0].melds.len().min(u8::MAX as usize) as u8,
    )
    .shanten
}

/// Whether a Riichi threat's reconstructed hand is tenpai.
///
/// This is the record check the strategy allows ("threat is tenpai in the
/// record"), not the answer: the drill reads the visible river and hand.
fn threat_is_tenpai(player: &PlayerState) -> bool {
    let tiles: Vec<Tile> = player
        .hand
        .iter()
        .filter_map(|code| Tile::try_from(code.as_str()).ok())
        .collect();
    if tiles.len() + 3 * player.melds.len() != 13 {
        return false;
    }
    calculate_shanten_with_melds(&to_counts(&tiles), player.melds.len() as u8).shanten == 0
}

/// The safety-chart mechanism names that count as "a genbutsu or suji exists".
fn safety_mechanism(mechanism: SafetyMechanism) -> Option<&'static str> {
    match mechanism {
        SafetyMechanism::Genbutsu => Some("genbutsu"),
        SafetyMechanism::PostRiichiGenbutsu => Some("post_riichi_genbutsu"),
        SafetyMechanism::Suji => Some("suji"),
        SafetyMechanism::BlockadeSuji => Some("blockade_suji"),
        _ => None,
    }
}

fn score_spread(state: &GameState) -> i32 {
    let Some(first) = state.players.first() else {
        return 0;
    };
    let mut low = first.score;
    let mut high = first.score;
    for player in &state.players[1..] {
        low = low.min(player.score);
        high = high.max(player.score);
    }
    high - low
}

/// Write a trigger report onto an existing `decisions` row.
///
/// Returns the number of rows changed. Extraction owns row creation; a report
/// for an extracted-but-not-stored decision therefore changes nothing and is
/// still valid. A decision with no hit clears the columns, so a rerun with a
/// narrower filter cannot leave a stale reason behind.
pub fn record_triggers(
    connection: &Connection,
    decision_id: &str,
    report: &TriggerReport,
) -> Result<usize, TriggerError> {
    let (trigger, detail) = match report.primary_code() {
        Some(code) => (Some(code.to_string()), Some(report.to_json()?)),
        None => (None, None),
    };
    let changed = connection.execute(
        "UPDATE decisions SET trigger = ?1, trigger_detail = ?2 WHERE decision_id = ?3",
        params![trigger, detail, decision_id],
    )?;
    Ok(changed)
}

/// Any failure while evaluating, reading or writing triggers.
#[derive(Debug, Error)]
pub enum TriggerError {
    /// The trigger name is not in the vocabulary.
    #[error(
        "unknown trigger `{name}`; expected book, defensive_riichi, offensive_architecture, \
         call_kan, score_placement, close_call or blunder"
    )]
    UnknownTrigger { name: String },
    /// A label-derived trigger was asked to prefilter the model pass.
    #[error(
        "trigger `{name}` reads a model label, so it cannot prefilter the model pass; \
         use the cheap triggers (book, defensive_riichi, offensive_architecture, call_kan, \
         score_placement)"
    )]
    LabelDerivedPrefilter { name: String },
    /// The family name is not in the vocabulary.
    #[error("unknown candidate family `{name}`")]
    UnknownFamily { name: String },
    /// A trigger configuration cannot describe a decision.
    #[error("invalid trigger configuration: {message}")]
    InvalidConfig { message: String },
    /// A percentile configuration was rejected by L2.
    #[error(transparent)]
    Threshold(#[from] ThresholdError),
    /// A report could not be serialised.
    #[error("trigger JSON error: {0}")]
    Json(#[from] serde_json::Error),
    /// SQLite failed.
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    /// The data root or replay store failed.
    #[error(transparent)]
    Storage(#[from] crate::miner::storage::StorageError),
    /// A replay could not be walked.
    #[error(transparent)]
    Walk(#[from] crate::replay::WalkError),
    /// The replay directory does not exist.
    #[error("replay directory `{0}` does not exist")]
    MissingReplays(String),
    /// Replay discovery failed for another reason.
    #[error("cannot discover replays: {0}")]
    LabelDiscovery(String),
    /// A file could not be read.
    #[error("I/O error at `{path}`: {source}")]
    Io {
        path: String,
        source: std::io::Error,
    },
}
