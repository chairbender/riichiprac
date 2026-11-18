//! The close-call, speed-vs-value and blunder selectors (implementation unit S3).
//!
//! S1 raises recall with cheap triggers; S2 applies the hard gates, ranks and
//! balances a pack. S3 is the concrete logic for the three non-book families
//! (`replay-implementation-plan.md` §5.3, `replay-strategy.md` §5.4, §5.5,
//! §5.6.1):
//!
//! | Selector | Accepts when | Never |
//! | --- | --- | --- |
//! | [`Family::CloseCall`] | the label's top-two gap is at or below its decision family's close percentile ([`crate::miner::label::thresholds`]) | guesses a percentile from an absolute constant |
//! | [`Family::SpeedValue`] | a quiet 1-shanten turn offers two legal discards that strictly trade acceptance for worst-completion value | calls two near tiles a divergence |
//! | [`Family::Mistake`] | a **weak agent's** played action sits at or above its family's confidence percentile below the Mortal top action | reads the kyoku result or the score |
//!
//! # No absolute point thresholds
//!
//! Every closeness decision is a percentile of the same decision family
//! (`<decision kind>/<turn bucket>`) built from the corpus' own labels. The
//! selector declines when the family has no sample; it never substitutes a
//! "400 points" or "250 points" literal. The speed/value selector records the
//! plans' worst-completion ron value gap for the reviewer, but the *test* for a
//! divergence is an ordering (value plan worth more, speed plan accepting more),
//! not a point threshold.
//!
//! # No outcome bias
//!
//! A blunder is measured only between the recorded action and the Mortal label:
//! the weak agent's Q gap and its percentile in the family. The selector never
//! reads a kyoku result, a final score, a win/loss flag or `ura_dora`. A bad
//! move that got lucky stays a blunder; a good move that dealt in does not
//! become one.
//!
//! # Equivalent tiles
//!
//! A tie is the app's own equivalence: the same discard tile, including the
//! red-five spelling (`Discard_5m` / `Discard_5mr`, which the grader
//! normalises), or a tile the state's classifier already listed in
//! [`crate::state::GameState::equivalent_tiles`]. A genuinely different second
//! action is **shown** as the alternative but is not graded as correct. Two
//! mirror-image discards are different tiles in the same river, not the same
//! answer, so structural symmetry alone is never enough.
//!
//! # Where a verdict goes
//!
//! [`evaluate_specials`] returns one verdict per family. [`crate::miner::select`]
//! keeps only accepted verdicts, uses them to confirm or drop the family a
//! trigger proposed, extends the accepted tile set for equivalence ties, and
//! stores the verdict on the candidate and review item. The dedicated corpus
//! sample lives in [`report`].

pub mod report;

#[cfg(test)]
mod tests;

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::ai::actions::legal_actions;
use crate::ai::finalize::{action_info, normalize_mortal_action};
use crate::decision::{ActionInfo, ActionKind};
use crate::miner::label::ModelLabel;
use crate::miner::label::thresholds::{Band, table_turn};
use crate::miner::provenance::AgentKind;
use crate::miner::trigger::families::Family;
use crate::miner::trigger::{
    DiscardPlan, LabelCuts, acceptance_gap_possible, acceptance_plans, fill_plan_values, played_gap,
};
use crate::replay::walk::{DecisionKind, DecisionSnapshot};

/// The families S3 owns.
pub const SPECIAL_FAMILIES: [Family; 3] = [Family::CloseCall, Family::SpeedValue, Family::Mistake];

/// Whether a family is one of the three S3 selectors.
#[must_use]
pub fn is_special_family(family: Family) -> bool {
    SPECIAL_FAMILIES.contains(&family)
}

/// The S1 trigger that proposes a selector's family.
///
/// The selector is the stricter second step: this mapping keeps the sample
/// report and the selection run naming the same trigger.
#[must_use]
pub fn trigger_for(family: Family) -> Option<crate::miner::trigger::TriggerKind> {
    match family {
        Family::CloseCall => Some(crate::miner::trigger::TriggerKind::CloseCall),
        Family::SpeedValue => Some(crate::miner::trigger::TriggerKind::OffensiveArchitecture),
        Family::Mistake => Some(crate::miner::trigger::TriggerKind::Blunder),
        _ => None,
    }
}

/// The selector thresholds that are genuinely structural.
///
/// There is deliberately no point threshold here. `speed_value_min_ukeire_gap`
/// is a tile count (the smallest acceptance difference worth showing) and the
/// turn window is the strategy's §5.6.1 scope. Closeness is a percentile from
/// the corpus, not a field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpecialConfig {
    /// Inclusive table-turn window for the speed/value selector.
    pub speed_value_turns: (usize, usize),
    /// Minimum acceptance gap between the speed and value plans, in tiles.
    pub speed_value_min_ukeire_gap: u16,
}

impl Default for SpecialConfig {
    fn default() -> Self {
        Self {
            speed_value_turns: (5, 12),
            speed_value_min_ukeire_gap: 1,
        }
    }
}

impl SpecialConfig {
    /// Reject a configuration that cannot describe a decision.
    pub fn validate(&self) -> Result<(), String> {
        let (first, last) = self.speed_value_turns;
        if first > last || last > 100 {
            return Err(format!(
                "speed/value turns {first}..={last} are not a usable window"
            ));
        }
        if self.speed_value_min_ukeire_gap == 0 {
            return Err("speed/value acceptance gap must be at least one tile".to_string());
        }
        Ok(())
    }
}

/// One seat's policy, as the replay provenance recorded it.
///
/// The blunder selector needs to know that the actor was the **weaker** policy,
/// not merely that it disagreed with the Mortal label: a Mortal-vs-Mortal
/// sampling difference is not a mistake drill. A rule engine (Akochan) or a
/// heuristic baseline is weak; the neural labeler is not.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SeatPolicy {
    /// Seat index in the resolved game.
    pub seat: usize,
    /// Stable agent id, for example `akochan` or `efficiency-safety-v1`.
    pub agent_id: String,
    /// The policy family.
    pub kind: AgentKind,
    /// Engine name, for example `akochan`.
    pub engine: String,
}

impl SeatPolicy {
    /// A rule-based, heuristic or external policy is the weaker half of a
    /// blunder comparison. A neural policy is the labeler's peer.
    #[must_use]
    pub fn is_weak(&self) -> bool {
        matches!(
            self.kind,
            AgentKind::Rule | AgentKind::Heuristic | AgentKind::External
        )
    }
}

/// Which plan an accepted speed/value answer belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnswerPlan {
    /// The answer keeps more live tiles.
    Speed,
    /// The answer keeps more hand value.
    Value,
    /// The Mortal answer is neither of the two divergent plans.
    Neither,
}

impl AnswerPlan {
    /// The JSON spelling.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Speed => "speed",
            Self::Value => "value",
            Self::Neither => "neither",
        }
    }
}

/// Why a selector declined a decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Decline {
    /// No cached label, so neither family can be measured.
    NoLabel,
    /// The label ranks fewer than two legal actions.
    NoTopTwo,
    /// The decision family has fewer than the minimum percentile samples.
    NoPercentileSample,
    /// The gap sits in the middle or confident band, not the close band.
    NotClose,
    /// Only a self turn offers discard plans.
    NotSelfTurn,
    /// The table is not a four-player state.
    TableShape,
    /// An opponent has declared Riichi; this is a defence position.
    RiichiActive,
    /// The actor is not 1-shanten.
    NotOneShanten,
    /// The speed/value completion walk is closed-hand only.
    OpenHand,
    /// The actor has no draw, so there is no discard decision.
    NoDraw,
    /// The table turn is outside the speed/value window.
    TurnOutsideWindow,
    /// No two legal discards trade acceptance for value.
    NoDivergence,
    /// The Mortal top action is neither the speed nor the value plan.
    AnswerNotInPair,
    /// The label's action does not resolve to a legal action.
    AnswerIllegal,
    /// The recorded actor is not a weak (rule/heuristic) policy.
    ActorNotWeak,
    /// The record played the Mortal top action; there is nothing to correct.
    PlayedTopAction,
    /// The played action has no Q value, so no gap can be measured.
    PlayedUnscored,
    /// The played-action gap is not in the family's confidence band.
    NotConfident,
}

impl Decline {
    /// The stable report/JSON spelling.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::NoLabel => "no_label",
            Self::NoTopTwo => "no_top_two",
            Self::NoPercentileSample => "no_percentile_sample",
            Self::NotClose => "not_close",
            Self::NotSelfTurn => "not_self_turn",
            Self::TableShape => "table_shape",
            Self::RiichiActive => "riichi_active",
            Self::NotOneShanten => "not_one_shanten",
            Self::OpenHand => "open_hand",
            Self::NoDraw => "no_draw",
            Self::TurnOutsideWindow => "turn_outside_window",
            Self::NoDivergence => "no_divergence",
            Self::AnswerNotInPair => "answer_not_in_pair",
            Self::AnswerIllegal => "answer_illegal",
            Self::ActorNotWeak => "actor_not_weak",
            Self::PlayedTopAction => "played_top_action",
            Self::PlayedUnscored => "played_unscored",
            Self::NotConfident => "not_confident",
        }
    }
}

/// One action a selector shows, with the measured facts behind it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SpecialAction {
    /// Legal-action name, for example `Discard_3m`.
    pub action: String,
    /// The role this action plays in the drill.
    pub role: SpecialRole,
    /// Base tile for a discard.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tile: Option<String>,
    /// Softmax probability from the label.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub probability: Option<f32>,
    /// Raw Q value, model utility.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub q_value: Option<f32>,
    /// `q(best) - q(this)`, model utility.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub q_gap: Option<f32>,
    /// Post-discard live tiles (speed/value only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ukeire: Option<u16>,
    /// Worst-completion ron value in points (speed/value only). Descriptive:
    /// the selector compares plan *ordering*, never this number to a constant.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worst_value: Option<u32>,
}

/// The role an action plays in an S3 drill.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpecialRole {
    /// The graded answer.
    Best,
    /// The second near-best action a close call shows.
    CloseAlternative,
    /// The plan that keeps more acceptance.
    Speed,
    /// The plan that keeps more value.
    Value,
    /// The weak agent's recorded action in a blunder drill.
    Played,
}

/// A speed/value divergence, with the two plans' measured facts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Divergence {
    /// The speed plan's action.
    pub speed_action: String,
    /// The value plan's action.
    pub value_action: String,
    /// Live-tile advantage of the speed plan.
    pub ukeire_gap: u16,
    /// Worst-completion value advantage of the value plan, in ron points.
    /// Descriptive only; it is never compared to an absolute threshold.
    pub worst_value_gap: u32,
    /// Which plan the Mortal top action is, or [`AnswerPlan::Neither`].
    pub answer_plan: AnswerPlan,
}

/// One selector's verdict for one decision.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SpecialVerdict {
    /// The family this verdict is about.
    pub family: Family,
    /// Whether the selector accepts the decision as a drill.
    pub accepted: bool,
    /// Why it declined; `None` when accepted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decline: Option<Decline>,
    /// The percentile band of the deciding gap, when the family had a sample.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub band: Option<Band>,
    /// The family's percentile sample size.
    pub sample_size: usize,
    /// Whether the drill must be presented as a close call.
    pub close: bool,
    /// The graded answer's legal action name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer: Option<String>,
    /// Extra discards the answer accepts (label-preserving equivalence ties).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub accepted_tiles: Vec<String>,
    /// The actions the drill shows, best action first.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub actions: Vec<SpecialAction>,
    /// The speed/value divergence, when this is that family.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub divergence: Option<Divergence>,
    /// The weak actor behind a blunder drill.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weak_policy: Option<SeatPolicy>,
}

impl SpecialVerdict {
    fn declined(family: Family, decline: Decline) -> Self {
        Self {
            family,
            accepted: false,
            decline: Some(decline),
            band: None,
            sample_size: 0,
            close: false,
            answer: None,
            accepted_tiles: Vec::new(),
            actions: Vec::new(),
            divergence: None,
            weak_policy: None,
        }
    }

    fn accepted(family: Family) -> Self {
        Self {
            family,
            accepted: true,
            decline: None,
            band: None,
            sample_size: 0,
            close: false,
            answer: None,
            accepted_tiles: Vec::new(),
            actions: Vec::new(),
            divergence: None,
            weak_policy: None,
        }
    }
}

/// Evaluate all three selectors on one decision.
///
/// `weak` is the recorded actor's policy from the replay provenance; pass
/// `None` when the provenance is unknown or the actor is the neural labeler
/// itself. The function never reads the kyoku outcome.
#[must_use]
pub fn evaluate_specials(
    snapshot: &DecisionSnapshot,
    label: Option<&ModelLabel>,
    cuts: &LabelCuts,
    weak: Option<&SeatPolicy>,
    config: &SpecialConfig,
) -> Vec<SpecialVerdict> {
    vec![
        close_call_verdict(snapshot, label, cuts),
        speed_value_verdict(snapshot, label, cuts, config),
        blunder_verdict(snapshot, label, cuts, weak),
    ]
}

/// The close-call selector: the top-two gap is in its family's close band.
#[must_use]
pub fn close_call_verdict(
    snapshot: &DecisionSnapshot,
    label: Option<&ModelLabel>,
    cuts: &LabelCuts,
) -> SpecialVerdict {
    let family = Family::CloseCall;
    let Some(label) = label else {
        return SpecialVerdict::declined(family, Decline::NoLabel);
    };
    let Some(gap) = label.top2_gap() else {
        return SpecialVerdict::declined(family, Decline::NoTopTwo);
    };
    let family_key = crate::miner::label::thresholds::DecisionFamily::of(snapshot).key();
    let Some(cut) = cuts.close_call.families.get(&family_key) else {
        return SpecialVerdict::declined(family, Decline::NoPercentileSample);
    };
    let band = cut.band(gap);
    if band != Some(Band::Close) {
        let mut verdict = SpecialVerdict::declined(family, Decline::NotClose);
        verdict.band = band;
        verdict.sample_size = cut.sample_size;
        return verdict;
    }
    let Some(top) = resolve_action(&snapshot.state, &label.top_action) else {
        return SpecialVerdict::declined(family, Decline::AnswerIllegal);
    };
    let Some(second) = label
        .ranking
        .iter()
        .find(|ranked| ranked.action != label.top_action)
    else {
        return SpecialVerdict::declined(family, Decline::NoTopTwo);
    };
    let Some(second_info) = resolve_action(&snapshot.state, &second.action) else {
        return SpecialVerdict::declined(family, Decline::AnswerIllegal);
    };

    let mut verdict = SpecialVerdict::accepted(family);
    verdict.band = Some(Band::Close);
    verdict.sample_size = cut.sample_size;
    verdict.close = true;
    verdict.answer = Some(top.action.clone());
    verdict.accepted_tiles = equivalent_discard_tiles(&snapshot.state, &top, &second_info);
    verdict.actions = vec![
        action_facts(label, &top, SpecialRole::Best),
        action_facts(label, &second_info, SpecialRole::CloseAlternative),
    ];
    verdict
}

/// The speed-vs-value selector: two legal discards strictly trade acceptance
/// for worst-completion value on a quiet 1-shanten turn.
#[must_use]
pub fn speed_value_verdict(
    snapshot: &DecisionSnapshot,
    label: Option<&ModelLabel>,
    cuts: &LabelCuts,
    config: &SpecialConfig,
) -> SpecialVerdict {
    let family = Family::SpeedValue;
    let Some(label) = label else {
        return SpecialVerdict::declined(family, Decline::NoLabel);
    };
    if snapshot.kind != DecisionKind::SelfTurn {
        return SpecialVerdict::declined(family, Decline::NotSelfTurn);
    }
    let state = &snapshot.state;
    if state.players.len() != 4 {
        return SpecialVerdict::declined(family, Decline::TableShape);
    }
    if state.players.iter().any(|player| player.is_riichi) {
        return SpecialVerdict::declined(family, Decline::RiichiActive);
    }
    if state.shanten != 1 {
        return SpecialVerdict::declined(family, Decline::NotOneShanten);
    }
    let Some(actor) = state.players.first() else {
        return SpecialVerdict::declined(family, Decline::OpenHand);
    };
    if !actor.melds.is_empty() {
        // The completion walk is the closed-hand `agari` reading. An open hand
        // would need a meld-aware walk this selector does not own; declining is
        // the fail-closed choice.
        return SpecialVerdict::declined(family, Decline::OpenHand);
    }
    if actor.draw.is_none() {
        return SpecialVerdict::declined(family, Decline::NoDraw);
    }
    let (first, last) = config.speed_value_turns;
    let turn = table_turn(snapshot);
    if !(first..=last).contains(&turn) {
        return SpecialVerdict::declined(family, Decline::TurnOutsideWindow);
    }

    let mut plans = acceptance_plans(snapshot);
    if !acceptance_gap_possible(&plans, config.speed_value_min_ukeire_gap) {
        return SpecialVerdict::declined(family, Decline::NoDivergence);
    }
    fill_plan_values(state, &mut plans);
    let Some((speed, value)) = speed_value_pair(&plans, config.speed_value_min_ukeire_gap) else {
        return SpecialVerdict::declined(family, Decline::NoDivergence);
    };

    let Some(top) = resolve_action(state, &label.top_action) else {
        return SpecialVerdict::declined(family, Decline::AnswerIllegal);
    };
    let answer_plan = match top.tile.as_deref() {
        Some(tile) if tile == speed.tile => AnswerPlan::Speed,
        Some(tile) if tile == value.tile => AnswerPlan::Value,
        _ => AnswerPlan::Neither,
    };
    if answer_plan == AnswerPlan::Neither {
        return SpecialVerdict::declined(family, Decline::AnswerNotInPair);
    }

    let mut verdict = SpecialVerdict::accepted(family);
    verdict.answer = Some(top.action.clone());
    verdict.actions = vec![
        plan_action(label, speed, SpecialRole::Speed),
        plan_action(label, value, SpecialRole::Value),
    ];
    verdict.divergence = Some(Divergence {
        speed_action: speed_action_name(speed),
        value_action: speed_action_name(value),
        ukeire_gap: speed.ukeire.saturating_sub(value.ukeire),
        worst_value_gap: value.value.saturating_sub(speed.value),
        answer_plan,
    });
    // Closeness is the Q gap between the two plans, banded by the family's
    // top-two-gap percentile. No sample means "not known close", never a
    // guessed close flag.
    let other_tile = if answer_plan == AnswerPlan::Speed {
        value.tile.as_str()
    } else {
        speed.tile.as_str()
    };
    let family_key = crate::miner::label::thresholds::DecisionFamily::of(snapshot).key();
    if let Some(gap) = pair_gap(label, other_tile)
        && let Some(cut) = cuts.close_call.families.get(&family_key)
        && let Some(band) = cut.band(gap)
    {
        verdict.band = Some(band);
        verdict.sample_size = cut.sample_size;
        verdict.close = band == Band::Close;
    }
    verdict
}

/// `q(best) - q(tile)` for the other plan, found by tile so a red/plain
/// spelling difference cannot hide the gap.
fn pair_gap(label: &ModelLabel, tile: &str) -> Option<f32> {
    let best_q = label
        .q_values
        .get(&label.top_action)
        .copied()
        .or_else(|| label.ranking.first().and_then(|ranked| ranked.q_value))?;
    let other_q = label
        .ranking
        .iter()
        .find(|ranked| ranked.tile.as_deref() == Some(tile))
        .and_then(|ranked| ranked.q_value)
        .or_else(|| {
            let wanted = format!("Discard_{tile}");
            label
                .q_values
                .iter()
                .find(|(action, _)| normalize_mortal_action(action) == wanted)
                .map(|(_, q)| *q)
        })?;
    Some((best_q - other_q).max(0.0))
}

/// The blunder selector: a weak agent's recorded action is far below the
/// Mortal top action, by its family's confidence percentile.
#[must_use]
pub fn blunder_verdict(
    snapshot: &DecisionSnapshot,
    label: Option<&ModelLabel>,
    cuts: &LabelCuts,
    weak: Option<&SeatPolicy>,
) -> SpecialVerdict {
    let family = Family::Mistake;
    let Some(label) = label else {
        return SpecialVerdict::declined(family, Decline::NoLabel);
    };
    let Some(weak) = weak.filter(|policy| policy.is_weak()) else {
        return SpecialVerdict::declined(family, Decline::ActorNotWeak);
    };
    let played = &snapshot.played.action;
    if played == &label.top_action {
        return SpecialVerdict::declined(family, Decline::PlayedTopAction);
    }
    let Some(gap) = played_gap(played, label) else {
        return SpecialVerdict::declined(family, Decline::PlayedUnscored);
    };
    if gap <= 0.0 {
        return SpecialVerdict::declined(family, Decline::PlayedTopAction);
    }
    let family_key = crate::miner::label::thresholds::DecisionFamily::of(snapshot).key();
    let Some(cut) = cuts.blunder.families.get(&family_key) else {
        return SpecialVerdict::declined(family, Decline::NoPercentileSample);
    };
    let band = cut.band(gap);
    if band != Some(Band::Confident) {
        let mut verdict = SpecialVerdict::declined(family, Decline::NotConfident);
        verdict.band = band;
        verdict.sample_size = cut.sample_size;
        return verdict;
    }
    let Some(top) = resolve_action(&snapshot.state, &label.top_action) else {
        return SpecialVerdict::declined(family, Decline::AnswerIllegal);
    };
    let Some(played_info) = resolve_action(&snapshot.state, played) else {
        return SpecialVerdict::declined(family, Decline::AnswerIllegal);
    };

    let mut verdict = SpecialVerdict::accepted(family);
    verdict.band = Some(Band::Confident);
    verdict.sample_size = cut.sample_size;
    verdict.answer = Some(top.action.clone());
    verdict.accepted_tiles = equivalent_discard_tiles(&snapshot.state, &top, &played_info);
    verdict.actions = vec![
        action_facts(label, &top, SpecialRole::Best),
        action_facts(label, &played_info, SpecialRole::Played),
    ];
    verdict.weak_policy = Some(weak.clone());
    verdict
}

/// Two plans that strictly trade acceptance for value.
///
/// The speed plan keeps at least `min_ukeire_gap` more live tiles **and** the
/// value plan's worst completion is worth strictly more. The chosen pair has the
/// largest acceptance gap, then the largest value gap, then the lowest tile
/// names, so the report is deterministic. A pairing that only differs in
/// acceptance (or only in value) is not a speed/value drill.
#[must_use]
pub(crate) fn speed_value_pair(
    plans: &[DiscardPlan],
    min_ukeire_gap: u16,
) -> Option<(&DiscardPlan, &DiscardPlan)> {
    let by_tile = plans_by_tile(plans);
    let mut pairs: Vec<(&DiscardPlan, &DiscardPlan)> = Vec::new();
    for (speed_tile, speed) in &by_tile {
        for (value_tile, value) in &by_tile {
            if speed_tile == value_tile {
                continue;
            }
            if speed.ukeire < value.ukeire.saturating_add(min_ukeire_gap) {
                continue;
            }
            if value.value <= speed.value {
                continue;
            }
            pairs.push((*speed, *value));
        }
    }
    pairs.sort_by(|left, right| {
        right
            .0
            .ukeire
            .saturating_sub(right.1.ukeire)
            .cmp(&left.0.ukeire.saturating_sub(left.1.ukeire))
            .then_with(|| {
                right
                    .1
                    .value
                    .saturating_sub(right.0.value)
                    .cmp(&left.1.value.saturating_sub(left.0.value))
            })
            .then_with(|| left.0.tile.cmp(&right.0.tile))
            .then_with(|| left.1.tile.cmp(&right.1.tile))
    });
    pairs.into_iter().next()
}

/// One plan per tile, preferring the higher-value copy (a red five) so a tile
/// is never compared with itself through its red/non-red variants.
fn plans_by_tile(plans: &[DiscardPlan]) -> BTreeMap<&str, &DiscardPlan> {
    let mut by_tile: BTreeMap<&str, &DiscardPlan> = BTreeMap::new();
    for plan in plans {
        by_tile
            .entry(plan.tile.as_str())
            .and_modify(|current| {
                if plan.value > current.value
                    || (plan.value == current.value && !plan.red && current.red)
                {
                    *current = plan;
                }
            })
            .or_insert(plan);
    }
    by_tile
}

fn speed_action_name(plan: &DiscardPlan) -> String {
    if plan.red {
        format!("Discard_{}r", plan.tile)
    } else {
        format!("Discard_{}", plan.tile)
    }
}

fn plan_action(label: &ModelLabel, plan: &DiscardPlan, role: SpecialRole) -> SpecialAction {
    let action = speed_action_name(plan);
    let mut facts = action_facts(
        label,
        &ActionInfo {
            action: action.clone(),
            label: action.replace('_', " "),
            kind: ActionKind::Discard,
            tile_index: None,
            tile: Some(plan.tile.clone()),
            tiles: Vec::new(),
            kan_kind: None,
        },
        role,
    );
    facts.ukeire = Some(plan.ukeire);
    facts.worst_value = Some(plan.value);
    facts
}

/// The label's probability/Q facts for one resolved action.
fn action_facts(label: &ModelLabel, info: &ActionInfo, role: SpecialRole) -> SpecialAction {
    let ranked = label.ranking.iter().find(|ranked| {
        ranked.action == info.action || ranked.action == normalize_mortal_action(&info.action)
    });
    let q = label
        .q_values
        .get(&info.action)
        .copied()
        .or_else(|| ranked.and_then(|ranked| ranked.q_value));
    let best_q = label
        .q_values
        .get(&label.top_action)
        .copied()
        .or_else(|| label.ranking.first().and_then(|ranked| ranked.q_value));
    let q_gap = q.zip(best_q).map(|(q, best)| (best - q).max(0.0));
    SpecialAction {
        action: info.action.clone(),
        role,
        tile: info.tile.clone(),
        probability: ranked.map(|ranked| ranked.probability),
        q_value: q,
        q_gap,
        ukeire: None,
        worst_value: None,
    }
}

/// Resolve a Mortal action name to a legal action, tolerating a red-five
/// spelling difference between the label and the hand.
fn resolve_action(state: &crate::state::GameState, action: &str) -> Option<ActionInfo> {
    action_info(state, action).or_else(|| {
        let wanted = normalize_mortal_action(action);
        legal_actions(state)
            .into_iter()
            .find(|info| normalize_mortal_action(&info.action) == wanted)
    })
}

/// Discards the app grades as the same answer. Empty unless both actions are
/// discards and either name the same tile (a red/plain five spelling) or the
/// state's classifier already lists one in `equivalent_tiles`. A genuinely
/// different second action is not a tie; the drill shows it instead.
#[must_use]
pub fn equivalent_discard_tiles(
    state: &crate::state::GameState,
    first: &ActionInfo,
    second: &ActionInfo,
) -> Vec<String> {
    if first.action == second.action {
        return Vec::new();
    }
    let (Some(first_tile), Some(second_tile)) = (first.tile.as_deref(), second.tile.as_deref())
    else {
        return Vec::new();
    };
    if first.kind != ActionKind::Discard || second.kind != ActionKind::Discard {
        return Vec::new();
    }
    let same_tile = first_tile == second_tile;
    let classifier_tie = state
        .equivalent_tiles
        .iter()
        .any(|tile| tile == second_tile);
    if !same_tile && !classifier_tie {
        return Vec::new();
    }
    let mut tiles = vec![first_tile.to_string(), second_tile.to_string()];
    tiles.sort();
    tiles.dedup();
    tiles
}
