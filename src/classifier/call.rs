//! The ch. 9 call recognisers: `meld_or_not` and `daiminkan_decision`.
//!
//! Both lessons are reactions to an opponent's discard, so the state must be a
//! [`crate::state::DecisionContext::ReactToDiscard`] with the offered call in
//! [`crate::state::GameState::call_offer`]. Unlike the discard lessons they are
//! not questions about a closed 14-tile hand, and a ron would make both moot:
//! the recognisers refuse any state where Agari is legal.
//!
//! - [`meld_or_not`] — ch. 9.1's "Don't meld with a cheap and slow hand!" The
//!   answer is always **pass**. The recogniser re-derives both halves of the
//!   book's test from the finished table: *slow* (3-away or worse before the
//!   call, 2-away or worse for every discard the Pon leaves, no side-wait
//!   protorun and no existing triplet) and *cheap* (no dora, no red five, and
//!   no honor besides the offered dragon pair, so the only value is the
//!   yakuhai).
//! - [`daiminkan_decision`] — ch. 9.3.2's three situations that justify an open
//!   quad. The generator's own `facts` recomputes the wait, the hand value
//!   before and after the quad, and the score line; the answer is **Kan** when
//!   one of the situations holds and **pass** when none does.
//!
//! The two are disjoint by the offer: a Pon is never a Kan offer.

use agari::context::indicator_to_dora;
use agari::parse::to_counts;
use agari::shanten::{calculate_shanten, calculate_shanten_with_melds};
use agari::tile::{Honor, Tile};

use crate::ai::actions::legal_actions;
use crate::decision::ActionKind;
use crate::generator::ScenarioId;
use crate::generator::daiminkan_facts;
use crate::generator::meld_or_not::skeleton::{has_side_wait_pair, has_triplet};
use crate::state::{CorrectAction, DecisionContext, GameState, TargetAction};

use super::support;
use super::{Allowed, Match, TransformPolicy};

/// The book's "slow" threshold: 2-away or worse after melding.
const SLOW_AFTER_MELD: i8 = 2;
/// The book's parenthetical: 3-away or worse before melding.
const SLOW_BEFORE_MELD: i8 = 3;

/// ch. 9.1 is a shape/value/safety rule: every label is recomputed from the
/// relabelled tiles. Red-five normalisation changes the "cheap" test, so it is
/// recompute-gated too.
pub(crate) const MELD_POLICY: TransformPolicy = TransformPolicy {
    seat_perm: Allowed::AllowWithRecompute,
    suit_perm: Allowed::AllowWithRecompute,
    rank_mirror: Allowed::AllowWithRecompute,
    wind_relabel: Allowed::AllowWithRecompute,
    red5_normalize: Allowed::AllowWithRecompute,
    note: "the cheap-and-slow call is a shanten, shape and value rule, so every relabelling \
           re-runs it; a red five is a dora, so normalising one must recompute the cheap test.",
};

/// ch. 9.3.2's open-quad value and score-line rule. Seat/wind/rank relabelling
/// moves the scores' meaning with the seats, so the label is recomputed.
pub(crate) const DAIMINKAN_POLICY: TransformPolicy = TransformPolicy {
    seat_perm: Allowed::AllowWithRecompute,
    suit_perm: Allowed::AllowWithRecompute,
    rank_mirror: Allowed::AllowWithRecompute,
    wind_relabel: Allowed::AllowWithRecompute,
    red5_normalize: Allowed::AllowWithRecompute,
    note: "the open-quad decision is the hand's ron value, its wait shape and the score line, so \
           every transform re-runs it; a red five can change the value against the 2000-5200 \
           band and the placement window.",
};

/// Recognise the ch. 9.1 cheap-and-slow call decision.
pub fn meld_or_not(state: &GameState) -> Option<Match> {
    let (from, offered) = reaction(state, "Pon")?;
    let human = &state.players[0];
    if !human.melds.is_empty() || human.is_riichi || human.draw.is_some() || human.hand.len() != 13
    {
        return None;
    }
    if !matches!(
        offered,
        Tile::Honor(Honor::White | Honor::Green | Honor::Red)
    ) {
        return None;
    }

    let tiles = support::parse_codes(human.hand.iter())?;
    if tiles.iter().filter(|tile| **tile == offered).count() != 2 {
        return None;
    }
    // Cheap: the offered dragon is the hand's only honor, no hand tile is the
    // dora, and no red five is held. Anything else can add value the book's
    // 1000-point argument does not cover.
    if tiles
        .iter()
        .any(|tile| matches!(tile, Tile::Honor(_)) && *tile != offered)
    {
        return None;
    }
    if !human.red_fives.is_empty() {
        return None;
    }
    let dora: Vec<Tile> = state
        .dora_indicators
        .iter()
        .filter_map(|code| Tile::try_from(code.as_str()).ok())
        .map(indicator_to_dora)
        .collect();
    if tiles.iter().any(|tile| dora.contains(tile)) {
        return None;
    }

    // The offer really is the seat's own last discard.
    let source = state.players.get(from)?;
    if source.discards.last()?.tile != offered.to_string() {
        return None;
    }

    // Slow: 3-away or worse before the call, and 2-away or worse for *every*
    // discard the Pon would leave.
    if calculate_shanten(&to_counts(&tiles)).shanten < SLOW_BEFORE_MELD {
        return None;
    }
    let mut after_pon = tiles.clone();
    for _ in 0..2 {
        let index = after_pon.iter().position(|tile| *tile == offered)?;
        after_pon.remove(index);
    }
    if has_side_wait_pair(&after_pon) || has_triplet(&after_pon) {
        return None;
    }
    for discard in support::distinct(&after_pon) {
        let mut after = after_pon.clone();
        let index = after
            .iter()
            .position(|tile| *tile == discard)
            .expect("the tile came from the hand");
        after.remove(index);
        if calculate_shanten_with_melds(&to_counts(&after), 1).shanten < SLOW_AFTER_MELD {
            return None;
        }
    }

    Some(Match {
        lesson: ScenarioId::MeldOrNot,
        situation: Some(
            "cheap and slow: one yakuhai and 2-away or worse after the call".to_string(),
        ),
        target_action: TargetAction::Call,
        correct_action: CorrectAction::pass(),
        equivalent_tiles: Vec::new(),
        riichi_triggers: Vec::new(),
        dama_reasons: Vec::new(),
        shouminkan_triggers: Vec::new(),
        scenario_note: None,
    })
}

/// Recognise the ch. 9.3.2 open-quad decision.
pub fn daiminkan_decision(state: &GameState) -> Option<Match> {
    let (_, offered) = reaction(state, "Kan")?;
    let facts = daiminkan_facts(state)?;
    if facts.quad != offered {
        return None;
    }

    let triggers = facts.triggers();
    if triggers.any() {
        let situation = if triggers.good_wait_and_value {
            "ready on a good wait with the hand worth 2000 to 5200".to_string()
        } else if triggers.placement_desperation {
            "South-4 placement: only the quad's minipoints close the gap".to_string()
        } else {
            "losing badly: the quad is for dora and minipoints".to_string()
        };
        Some(Match {
            lesson: ScenarioId::DaiminkanDecision,
            situation: Some(situation),
            target_action: TargetAction::Call,
            correct_action: CorrectAction::kan(offered.to_string()),
            equivalent_tiles: Vec::new(),
            riichi_triggers: Vec::new(),
            dama_reasons: Vec::new(),
            shouminkan_triggers: Vec::new(),
            scenario_note: None,
        })
    } else {
        // The book's two decline boxes: a 2000-point hand on a bad wait, and a
        // 1000-point hand on a good wait. Neither is score-pressured.
        Some(Match {
            lesson: ScenarioId::DaiminkanDecision,
            situation: Some(
                "ready but outside the book's three situations: no score pressure".to_string(),
            ),
            target_action: TargetAction::Call,
            correct_action: CorrectAction::pass(),
            equivalent_tiles: Vec::new(),
            riichi_triggers: Vec::new(),
            dama_reasons: Vec::new(),
            shouminkan_triggers: Vec::new(),
            scenario_note: None,
        })
    }
}

/// The reaction's offering seat and tile, when this is a legal call decision
/// with no ron available.
fn reaction(state: &GameState, action: &str) -> Option<(usize, Tile)> {
    let human = state.players.first()?;
    if !human.is_human || human.seat != 0 {
        return None;
    }
    let DecisionContext::ReactToDiscard { from, tile } = &state.decision else {
        return None;
    };
    if !(1..=3).contains(from) {
        return None;
    }
    let offer = state.call_offer.as_ref()?;
    if offer.action != action || offer.tile != *tile {
        return None;
    }
    let legal = legal_actions(state);
    // A winning hand would make the call/pass question moot; the miner must not
    // label a ron as a call decision.
    if legal.iter().any(|info| info.kind == ActionKind::Agari) {
        return None;
    }
    // The offer has to be one of the actions the rules actually allow: a Pon
    // from a Riichi hand, or a Kan on the last wall tile, is not this lesson.
    let kind = match action {
        "Pon" => ActionKind::Pon,
        "Kan" => ActionKind::Kan,
        _ => return None,
    };
    if !legal
        .iter()
        .any(|info| info.kind == kind && info.tile.as_deref() == Some(tile.as_str()))
    {
        return None;
    }
    Some((*from, Tile::try_from(tile.as_str()).ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::generator::generate_puzzle;
    use crate::state::CorrectActionType;

    #[test]
    fn the_cheap_and_slow_call_recognises_its_own_lesson() {
        for run in 0..12 {
            let state =
                generate_puzzle("meld_or_not").unwrap_or_else(|err| panic!("run {run}: {err}"));
            let matched = meld_or_not(&state).unwrap_or_else(|| panic!("run {run}: no match"));
            matched
                .validate(&state)
                .unwrap_or_else(|err| panic!("run {run}: illegal answer: {err}"));
            assert_eq!(matched.lesson, ScenarioId::MeldOrNot);
            assert_eq!(matched.target_action, TargetAction::Call);
            assert_eq!(
                matched.correct_action.action_type(),
                CorrectActionType::Pass
            );
            assert_eq!(
                state.call_offer.as_ref().map(|offer| offer.action.as_str()),
                Some("Pon")
            );
        }
    }

    #[test]
    fn the_open_quad_recognises_both_answers() {
        let mut kans = 0;
        let mut passes = 0;
        for _ in 0..60 {
            let state = generate_puzzle("daiminkan_decision").expect("must generate");
            let matched = daiminkan_decision(&state).expect("every board must match");
            matched
                .validate(&state)
                .expect("the answer must be a legal action");
            assert_eq!(matched.lesson, ScenarioId::DaiminkanDecision);
            match state.correct_action.action_type() {
                CorrectActionType::Kan => {
                    kans += 1;
                    assert_eq!(matched.correct_action.action_type(), CorrectActionType::Kan);
                }
                CorrectActionType::Pass => {
                    passes += 1;
                    assert_eq!(
                        matched.correct_action.action_type(),
                        CorrectActionType::Pass
                    );
                }
                other => panic!("unexpected lesson answer {other:?}"),
            }
        }
        assert!(kans > 0 && passes > 0, "both cells must be covered");
    }

    #[test]
    fn a_pon_offer_is_not_the_open_quad_lesson() {
        let state = generate_puzzle("meld_or_not").expect("must generate");
        assert!(daiminkan_decision(&state).is_none());
    }

    #[test]
    fn a_kan_offer_is_not_the_cheap_and_slow_pon() {
        let state = generate_puzzle("daiminkan_decision").expect("must generate");
        assert!(meld_or_not(&state).is_none());
    }

    #[test]
    fn a_closed_self_turn_is_not_a_call_decision() {
        let state = generate_puzzle("wind_discard_order").expect("must generate");
        assert!(meld_or_not(&state).is_none());
        assert!(daiminkan_decision(&state).is_none());
    }

    #[test]
    fn a_pon_with_a_valuable_hand_is_outside_the_cheap_cell() {
        // A dora in the hand makes it not cheap; the book's rule no longer
        // covers the call, so the recogniser refuses it.
        let mut state = generate_puzzle("meld_or_not").expect("must generate");
        let Some(spare) = state.players[0]
            .hand
            .iter()
            .find(|code| Tile::try_from(code.as_str()).is_ok_and(|tile| tile.suit().is_some()))
            .cloned()
        else {
            return;
        };
        // Keep the offer and hand intact; make the held tile the visible dora by
        // choosing the indicator one rank below it.
        let tile = Tile::try_from(spare.as_str()).expect("a tile");
        let Some(predecessor) = predecessor(tile) else {
            return;
        };
        state.dora_indicators[0] = predecessor.to_string();
        assert!(meld_or_not(&state).is_none());
    }

    /// The indicator whose dora is `tile`, or `None` for a tile with no
    /// predecessor in its cycle (honors are skipped to keep the test simple).
    fn predecessor(tile: Tile) -> Option<Tile> {
        let Tile::Suited { suit, value } = tile else {
            return None;
        };
        Some(Tile::suited(suit, if value == 1 { 9 } else { value - 1 }))
    }
}
