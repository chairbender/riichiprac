//! Board assembly for the pure-defense lessons.
//!
//! The board is built around one threat player who has just declared Riichi.
//! Their river is the theme's pattern plus random tiles, every other opponent
//! river carries any extra visible copies the theme needs, and the learner's
//! hand is filled constructively: every filler must sit strictly lower on the
//! book's safety chart than the answer, so the "safest discard" is unique.

use std::collections::HashMap;

use agari::parse::to_counts;
use agari::tile::Tile;

use super::theme::{SafetyTheme, ThemePlan};
use crate::generator::support::analysis::evaluate_counts;
use crate::generator::support::deck::{ALL_TILES, Deck};
use crate::generator::support::format::format_hand_compact;
use crate::generator::support::table::{
    discards_from_tiles, random_round, random_scores_with_human_first,
};
use crate::rng::{choose, gen_range, shuffle};
use crate::safety::{is_near_dora, SafetyFacts, SafetyRank};
use crate::state::{
    CorrectAction, DecisionContext, GameState, PlayerState, TargetAction, Wind,
};

/// Which defense question the board is asking.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Lesson {
    /// The chart has a genuinely safe tile: find the safest discard.
    SafetyChart,
    /// Nothing is identified safe: apply the chapter's fallback list.
    StuckHeuristic,
}

/// Builds a validated safety-chart board.
pub(super) fn build_safety_chart(category: &str, plan: ThemePlan) -> Result<GameState, String> {
    build(category, plan, Lesson::SafetyChart)
}

/// Builds a validated fallback-heuristic board.
pub(super) fn build_stuck(category: &str, plan: ThemePlan) -> Result<GameState, String> {
    build(category, plan, Lesson::StuckHeuristic)
}

/// The learner's hand must not be ready. The book's advice against Rank D
/// discards applies "until your hand becomes ready", so a 1-away hand is still
/// in scope for these fold lessons; tenpai is not.
const MIN_SHANTEN: i8 = 1;

fn build(category: &str, plan: ThemePlan, lesson: Lesson) -> Result<GameState, String> {
    let (round_wind, hand_number) = random_round();
    let scores = random_scores_with_human_first();
    let human_wind = choose(&Wind::ALL).ok_or_else(|| "No seat wind available".to_string())?;
    let threat_seat = gen_range(1, 4);
    let threat_wind = human_wind.next(threat_seat);

    let mut deck = Deck::fresh();
    let mut visible: HashMap<Tile, u8> = HashMap::new();

    // Reserve the answer before anything else, so no other placement can
    // consume its last copy. The fallback lesson needs the pair, so it holds
    // two: one concealed and one as the draw.
    let answer_copies = if lesson == Lesson::StuckHeuristic { 2 } else { 1 };
    for _ in 0..answer_copies {
        take(&mut deck, &mut visible, plan.answer)?;
    }

    // The threat's river: the theme's pattern in the early turns, then filler.
    let discard_count = gen_range(8, 15);
    let mut threat_river = Vec::with_capacity(discard_count);
    for &tile in &plan.threat_discards {
        if threat_river.len() >= discard_count {
            return Err("Theme needs more early discards than the river holds".to_string());
        }
        take(&mut deck, &mut visible, tile)?;
        threat_river.push(tile);
    }
    while threat_river.len() < discard_count {
        let tile = deck
            .draw_excluding(1, &plan.threat_avoid)
            .and_then(|mut drawn| drawn.pop())
            .ok_or_else(|| "Deck exhausted drawing the threat river".to_string())?;
        increment(&mut visible, tile);
        threat_river.push(tile);
    }

    // Theme copies that must be visible somewhere other than the threat river.
    let mut extra = Vec::with_capacity(plan.extra_visible.len());
    for &tile in &plan.extra_visible {
        take(&mut deck, &mut visible, tile)?;
        extra.push(tile);
    }

    let others: Vec<usize> = (1..4).filter(|seat| *seat != threat_seat).collect();
    let mut extra_by_seat: HashMap<usize, Vec<Tile>> = HashMap::new();
    for (index, tile) in extra.iter().enumerate() {
        let seat = others[index % others.len()];
        extra_by_seat.entry(seat).or_default().push(*tile);
    }

    let mut players = Vec::with_capacity(4);
    let opponent_meta = [(1usize, "Shimocha"), (2, "Toimen"), (3, "Kamicha")];
    for (seat, name) in opponent_meta {
        let hand = deck
            .draw_n(13)
            .ok_or_else(|| "Deck exhausted dealing an opponent".to_string())?;

        let river = if seat == threat_seat {
            threat_river.clone()
        } else {
            let mut river = extra_by_seat.remove(&seat).unwrap_or_default();
            while river.len() < discard_count {
                let tile = deck
                    .draw()
                    .ok_or_else(|| "Deck exhausted drawing an opponent river".to_string())?;
                increment(&mut visible, tile);
                river.push(tile);
            }
            river
        };

        let mut discards = discards_from_tiles(&river);
        let is_threat = seat == threat_seat;
        if is_threat && let Some(last) = discards.last_mut() {
            // The declaration tile is discarded from the hand, never tsumogiri.
            last.is_riichi = true;
            last.is_tsumogiri = false;
        }

        players.push(PlayerState {
            seat,
            name: name.to_string(),
            is_human: false,
            wind: human_wind.next(seat),
            score: scores[seat],
            hand: hand.iter().map(ToString::to_string).collect(),
            draw: None,
            red_fives: Vec::new(),
            discards,
            melds: Vec::new(),
            is_riichi: is_threat,
            riichi_discard_index: is_threat.then(|| river.len() - 1),
        });
    }

    // Keep the dora away from the answer so the fallback lesson's "avoid the
    // dora" rule has something to say. The indicator itself is still visible.
    let dora_candidates: Vec<Tile> = ALL_TILES
        .iter()
        .copied()
        .filter(|&indicator| {
            deck.count(indicator) > 0 && !is_near_dora(plan.answer, &[indicator])
        })
        .collect();
    let dora_indicator =
        choose(&dora_candidates).ok_or_else(|| "No legal dora indicator".to_string())?;
    deck.take(dora_indicator)?;
    increment(&mut visible, dora_indicator);
    let ura_indicator = deck
        .draw()
        .ok_or_else(|| "Deck exhausted drawing the ura indicator".to_string())?;

    let human_river = deck
        .draw_n(discard_count)
        .ok_or_else(|| "Deck exhausted drawing the human river".to_string())?;
    for &tile in &human_river {
        increment(&mut visible, tile);
    }

    let table_facts = facts_now(round_wind, threat_wind, &threat_river, &visible);
    let answer_rank = table_facts.rank(plan.answer);
    if !accepts_answer(lesson, plan.theme, answer_rank) {
        return Err(format!(
            "Theme {} cannot be built: the answer is Rank {}",
            plan.theme.as_str(),
            answer_rank.code()
        ));
    }
    // A number tile with all four copies visible cannot be waited on at all, so
    // the chart's row would understate its safety. Reject the board before
    // paying for the hand fill.
    if !plan.answer.is_honor() && table_facts.visible_of(plan.answer) >= 4 {
        return Err("The answer tile is completely visible".to_string());
    }

    // Fill the concealed hand with tiles below the lesson's chart floor. The
    // check runs after every pick because added copies can silently promote a
    // filler through a blockade.
    let concealed_target = if lesson == Lesson::StuckHeuristic { 12 } else { 13 };
    let mut concealed: Vec<Tile> = Vec::with_capacity(13);
    for _ in 0..concealed_target {
        // The cheap pass drops tiles that are already at least as safe as the
        // answer (adding a copy can only move a tile *up* the chart), then the
        // live check below confirms the pick against the enlarged visible set.
        let current = facts_now(round_wind, threat_wind, &threat_river, &visible);
        let floor = filler_floor(lesson, plan.answer, &current);
        let mut pool: Vec<Tile> = ALL_TILES
            .iter()
            .copied()
            .filter(|&tile| tile != plan.answer && deck.count(tile) > 0)
            .filter(|&tile| current.rank(tile).order() > floor)
            .filter(|&tile| current.visible_of(tile) < 4)
            .filter(|&tile| {
                lesson != Lesson::StuckHeuristic || !current.outside_early_discards(tile)
            })
            .collect();
        shuffle(&mut pool);

        let mut placed = None;
        for tile in pool {
            let mut trial = visible.clone();
            increment(&mut trial, tile);
            let trial_facts = facts_now(round_wind, threat_wind, &threat_river, &trial);
            if filler_is_legal(lesson, plan.answer, &trial_facts, &concealed, tile) {
                deck.take(tile)?;
                visible = trial;
                concealed.push(tile);
                placed = Some(tile);
                break;
            }
        }

        placed.ok_or_else(|| "No filler tile is ranked below the answer".to_string())?;
    }

    // The fallback lesson teaches the pair: one copy concealed, one as the draw.
    if lesson == Lesson::StuckHeuristic {
        concealed.push(plan.answer);
    }

    concealed.sort();
    let mut full_tiles = concealed.clone();
    full_tiles.push(plan.answer);
    full_tiles.sort();

    let metrics = evaluate_counts(&to_counts(&full_tiles));
    if metrics.shanten < MIN_SHANTEN {
        return Err(format!(
            "Defense hand must be at least {MIN_SHANTEN}-away, got {}",
            metrics.shanten
        ));
    }

    let hand_string = format_hand_compact(&full_tiles);
    let tile_strings: Vec<String> = full_tiles.iter().map(ToString::to_string).collect();

    let human_player = PlayerState {
        seat: 0,
        name: "You".to_string(),
        is_human: true,
        wind: human_wind,
        score: scores[0],
        hand: concealed.iter().map(ToString::to_string).collect(),
        draw: Some(plan.answer.to_string()),
        red_fives: Vec::new(),
        discards: discards_from_tiles(&human_river),
        melds: Vec::new(),
        is_riichi: false,
        riichi_discard_index: None,
    };

    players.insert(0, human_player);
    players.sort_by_key(|player| player.seat);

    let tiles_remaining = deck.remaining().saturating_sub(12).min(u8::MAX as usize) as u8;
    if tiles_remaining == 0 {
        return Err("No drawable tiles remain".to_string());
    }

    let state = GameState {
        category: category.to_string(),
        target_action: TargetAction::Defend,
        correct_action: CorrectAction::fold(plan.answer.to_string()),
        decision: DecisionContext::SelfTurn,
        ai_decision: None,
        riichi_triggers: Vec::new(),
        dama_reasons: Vec::new(),
        shouminkan_triggers: Vec::new(),
        book_rationale: None,
        hand_string,
        tiles: tile_strings,
        shanten: metrics.shanten,
        is_agari: metrics.is_agari,
        decompositions_count: metrics.decompositions_count,
        ukeire_tiles: metrics.ukeire_tiles,
        ukeire_total: metrics.ukeire_total,
        round_wind,
        hand_number,
        honba: gen_range(0, 4) as u8,
        riichi_sticks: 1,
        dora_indicators: vec![dora_indicator.to_string()],
        ura_dora_indicators: vec![ura_indicator.to_string()],
        tiles_remaining,
        current_turn: 0,
        players,
    };

    validate(&state, threat_seat, lesson, plan.theme)?;

    Ok(state)
}

/// True when the answer's chart row is the one the theme is teaching.
fn accepts_answer(lesson: Lesson, theme: SafetyTheme, rank: SafetyRank) -> bool {
    match lesson {
        // The fallback lesson needs nothing identified as safe. A terminal is
        // either a non-suji terminal (CC) or, once its protorun shows three
        // copies, a one-chance tile (C); both are outside the chart's useful
        // range, which is exactly when the chapter's fallback list applies.
        Lesson::StuckHeuristic => matches!(rank, SafetyRank::Cc | SafetyRank::C),
        // A chart lesson must always offer something better than a non-suji
        // middle tile, or there is nothing to identify on the chart.
        Lesson::SafetyChart if rank.order() > SafetyRank::Cc.order() => false,
        Lesson::SafetyChart => match theme {
            SafetyTheme::Genbutsu => rank == SafetyRank::Genbutsu,
            SafetyTheme::SujiTerminal => matches!(
                rank,
                SafetyRank::APlus | SafetyRank::AaMinus | SafetyRank::Aa | SafetyRank::Aaa
            ),
            SafetyTheme::SujiSimple => {
                matches!(rank, SafetyRank::BbPlus | SafetyRank::BbMinus)
            }
            SafetyTheme::SujiMiddle | SafetyTheme::NoChance => rank == SafetyRank::Bbb,
            SafetyTheme::HonorCount => matches!(
                rank,
                SafetyRank::APlus | SafetyRank::A | SafetyRank::Aa | SafetyRank::Aaa
            ),
            SafetyTheme::NonSuji => rank == SafetyRank::Cc,
        },
    }
}

/// The chart row a filler must be worse than.
///
/// Chart lessons keep every filler strictly below the answer, so the answer is
/// the unique best tile. The fallback lesson only requires that nothing in the
/// hand is identified as safe; the pair and early-discard rules then pick the
/// answer, and the generator re-checks that they pick it alone.
fn filler_floor(lesson: Lesson, answer: Tile, facts: &SafetyFacts) -> u8 {
    match lesson {
        Lesson::StuckHeuristic => SafetyRank::B.order(),
        Lesson::SafetyChart => facts.rank(answer).order(),
    }
}

fn filler_is_legal(
    lesson: Lesson,
    answer: Tile,
    facts: &SafetyFacts,
    placed: &[Tile],
    tile: Tile,
) -> bool {
    let floor = filler_floor(lesson, answer, facts);
    let legal_order = |candidate: Tile| facts.rank(candidate).order() > floor;

    // Never let the hand complete a blockade of its own, and keep the fill
    // varied: four visible copies would silently promote the neighbours.
    if facts.visible_of(tile) >= 4 {
        return false;
    }
    if placed.iter().filter(|placed_tile| **placed_tile == tile).count() >= 2 {
        return false;
    }

    legal_order(tile) && placed.iter().all(|&placed_tile| legal_order(placed_tile))
}

/// Re-derives the safety chart from the finished state and re-checks the lesson.
fn validate(
    state: &GameState,
    threat_seat: usize,
    lesson: Lesson,
    theme: SafetyTheme,
) -> Result<(), String> {
    let facts = SafetyFacts::from_state(state, threat_seat)
        .ok_or_else(|| "No safety facts for the threat seat".to_string())?;

    let human = state
        .players
        .iter()
        .find(|player| player.is_human)
        .ok_or_else(|| "No human player".to_string())?;

    let threat = state
        .players
        .iter()
        .find(|player| player.seat == threat_seat)
        .ok_or_else(|| "No threat player".to_string())?;

    if !threat.is_riichi || threat.riichi_discard_index.is_none() {
        return Err("The threat must be in Riichi".to_string());
    }
    if !threat.melds.is_empty() {
        return Err("The threat must have no open melds".to_string());
    }

    let mut hand_tiles: Vec<Tile> = human
        .hand
        .iter()
        .filter_map(|code| Tile::try_from(code.as_str()).ok())
        .collect();
    if let Some(draw) = &human.draw {
        hand_tiles.push(Tile::try_from(draw.as_str()).map_err(|err| err.to_string())?);
    }
    if hand_tiles.len() != 14 {
        return Err(format!(
            "The defender must hold 14 tiles, got {}",
            hand_tiles.len()
        ));
    }
    if !human.melds.is_empty() || human.is_riichi {
        return Err("The defender must be concealed and not in Riichi".to_string());
    }

    let answer = Tile::try_from(
        state
            .correct_action
            .tile()
            .ok_or_else(|| "The fold answer must name a tile".to_string())?,
    )
    .map_err(|err| err.to_string())?;
    let answer_rank = facts.rank(answer);
    if !accepts_answer(lesson, theme, answer_rank) {
        return Err(format!(
            "The answer is Rank {} but the theme needs a safer row",
            answer_rank.code()
        ));
    }

    // A number tile with all four copies visible cannot be waited on at all, so
    // the chart's row would understate its safety. Generation rejects that
    // board instead of teaching a rank the book would not defend.
    if !answer.is_honor() && facts.visible_of(answer) >= 4 {
        return Err("The answer tile is completely visible".to_string());
    }

    let floor = filler_floor(lesson, answer, &facts);
    let mut seen = Vec::new();
    for tile in &hand_tiles {
        if *tile == answer || seen.contains(tile) {
            continue;
        }
        seen.push(*tile);
        if facts.rank(*tile).order() <= floor {
            return Err(format!(
                "{} is Rank {}, inside the lesson's safe range",
                tile,
                facts.rank(*tile).code()
            ));
        }
    }

    if lesson == Lesson::StuckHeuristic {
        let copies = hand_tiles.iter().filter(|tile| **tile == answer).count();
        if copies != 2 {
            return Err(format!(
                "The fallback lesson needs a pair of the answer, got {copies} copies"
            ));
        }
        if !facts.outside_early_discards(answer) {
            return Err("The answer must sit outside the threat's early discards".to_string());
        }

        // The fallback list, not the chart, has to pick the answer alone.
        let indicators: Vec<Tile> = state
            .dora_indicators
            .iter()
            .filter_map(|code| Tile::try_from(code.as_str()).ok())
            .collect();
        let mut unique: Vec<Tile> = hand_tiles.clone();
        unique.sort();
        unique.dedup();
        let counts = hand_counts(state);
        match facts.stuck_choice(&unique, &counts, &indicators) {
            Some((choice, _)) if choice == answer => {}
            other => {
                return Err(format!(
                    "The fallback list does not uniquely pick the answer: {other:?}"
                ));
            }
        }
    }

    let discard_counts: Vec<usize> = state
        .players
        .iter()
        .map(|player| player.discards.len())
        .collect();
    if discard_counts.windows(2).any(|pair| pair[0] != pair[1]) {
        return Err(format!(
            "Every player must have discarded the same number of times: {discard_counts:?}"
        ));
    }

    Ok(())
}

/// The learner's visible hand counts, for the fallback ordering.
fn hand_counts(state: &GameState) -> HashMap<Tile, u8> {
    let mut counts = HashMap::new();
    let Some(human) = state.players.iter().find(|player| player.is_human) else {
        return counts;
    };

    for code in human.hand.iter().chain(human.draw.iter()) {
        if let Ok(tile) = Tile::try_from(code.as_str()) {
            increment(&mut counts, tile);
        }
    }

    counts
}

fn facts_now(
    round_wind: Wind,
    threat_wind: Wind,
    threat_river: &[Tile],
    visible: &HashMap<Tile, u8>,
) -> SafetyFacts {
    SafetyFacts::new(
        round_wind,
        threat_wind,
        threat_river.to_vec(),
        visible.clone(),
    )
}

fn take(deck: &mut Deck, visible: &mut HashMap<Tile, u8>, tile: Tile) -> Result<(), String> {
    deck.take(tile)?;
    increment(visible, tile);
    Ok(())
}

fn increment(counts: &mut HashMap<Tile, u8>, tile: Tile) {
    *counts.entry(tile).or_insert(0) += 1;
}

#[cfg(test)]
mod tests {
    use super::super::{generate_safety_chart, generate_stuck};
    use super::*;

    fn human(state: &GameState) -> &PlayerState {
        state
            .players
            .iter()
            .find(|player| player.is_human)
            .expect("human player")
    }

    fn threat(state: &GameState) -> &PlayerState {
        state
            .players
            .iter()
            .find(|player| player.is_riichi)
            .expect("threat player")
    }

    fn answer_tile(state: &GameState) -> Tile {
        Tile::try_from(state.correct_action.tile().expect("answer tile"))
            .expect("answer tile must parse")
    }

    #[test]
    fn chart_lesson_offers_a_unique_safest_discard() {
        for run in 0..40 {
            let state = generate_safety_chart("defense_safety_chart")
                .unwrap_or_else(|err| panic!("run {run} failed: {err}"));

            assert_eq!(state.category, "defense_safety_chart");
            assert_eq!(state.target_action, TargetAction::Defend);
            assert!(matches!(state.correct_action, CorrectAction::Fold { .. }));

            let threat = threat(&state);
            assert!(threat.riichi_discard_index.is_some());
            assert!(threat.discards.last().expect("a riichi discard").is_riichi);

            let human = human(&state);
            assert_eq!(human.hand.len() + usize::from(human.draw.is_some()), 14);
            assert!(human.melds.is_empty());
            assert!(!human.is_riichi);
            assert_eq!(human.draw.as_deref(), state.correct_action.tile());

            let facts = SafetyFacts::from_state(&state, threat.seat).expect("facts");
            let answer = answer_tile(&state);
            let answer_rank = facts.rank(answer);
            assert!(answer_rank.order() <= SafetyRank::Cc.order());

            for tile in state.tiles.iter().map(|code| Tile::try_from(code.as_str())) {
                let tile = tile.expect("tile code");
                if tile == answer {
                    continue;
                }
                assert!(
                    facts.rank(tile).order() > answer_rank.order(),
                    "run {run}: {tile} is not strictly worse than the answer"
                );
            }

            assert!(state.shanten >= MIN_SHANTEN);
            assert_eq!(state.riichi_sticks, 1);
            assert!(state.book_rationale.is_none(), "finalize stamps it later");
        }
    }

    #[test]
    fn stuck_lesson_teaches_the_pair_break() {
        for run in 0..40 {
            let state = generate_stuck("defense_stuck_heuristic")
                .unwrap_or_else(|err| panic!("run {run} failed: {err}"));

            assert_eq!(state.category, "defense_stuck_heuristic");
            assert_eq!(state.target_action, TargetAction::Defend);

            let threat = threat(&state);
            let facts = SafetyFacts::from_state(&state, threat.seat).expect("facts");
            let answer = answer_tile(&state);

            assert!(matches!(
                facts.rank(answer),
                SafetyRank::Cc | SafetyRank::C
            ));
            assert!(
                facts.outside_early_discards(answer),
                "run {run}: the answer must sit outside the early discards"
            );

            let copies = state
                .tiles
                .iter()
                .filter(|code| code.as_str() == state.correct_action.tile().unwrap())
                .count();
            assert_eq!(copies, 2, "run {run}: the fallback lesson needs a pair");

            for code in &state.tiles {
                let tile = Tile::try_from(code.as_str()).expect("tile code");
                if tile == answer {
                    continue;
                }
                assert!(
                    facts.rank(tile).order() > SafetyRank::B.order(),
                    "run {run}: {tile} is identified as safe, so this is not a fallback lesson"
                );
            }

            // The fallback list, not the chart, must pick the answer alone.
            let counts = hand_counts(&state);
            let indicators: Vec<Tile> = state
                .dora_indicators
                .iter()
                .filter_map(|code| Tile::try_from(code.as_str()).ok())
                .collect();
            let mut unique: Vec<Tile> = state
                .tiles
                .iter()
                .filter_map(|code| Tile::try_from(code.as_str()).ok())
                .collect();
            unique.sort();
            unique.dedup();
            let (choice, rules) = facts
                .stuck_choice(&unique, &counts, &indicators)
                .unwrap_or_else(|| panic!("run {run}: the fallback list must pick a tile"));
            assert_eq!(choice, answer, "run {run}: the fallback list picked {choice}");
            assert!(rules.pair_or_set);
            assert!(rules.outside_early);
        }
    }

    #[test]
    fn theme_acceptance_matches_the_chart_families() {
        assert!(accepts_answer(
            Lesson::SafetyChart,
            SafetyTheme::Genbutsu,
            SafetyRank::Genbutsu
        ));
        assert!(!accepts_answer(
            Lesson::SafetyChart,
            SafetyTheme::Genbutsu,
            SafetyRank::Aaa
        ));
        assert!(accepts_answer(
            Lesson::SafetyChart,
            SafetyTheme::SujiTerminal,
            SafetyRank::AaMinus
        ));
        assert!(accepts_answer(
            Lesson::SafetyChart,
            SafetyTheme::NoChance,
            SafetyRank::Bbb
        ));
        assert!(!accepts_answer(
            Lesson::SafetyChart,
            SafetyTheme::NonSuji,
            SafetyRank::Dd
        ));
        assert!(accepts_answer(
            Lesson::StuckHeuristic,
            SafetyTheme::NonSuji,
            SafetyRank::Cc
        ));
        assert!(!accepts_answer(
            Lesson::StuckHeuristic,
            SafetyTheme::NonSuji,
            SafetyRank::B
        ));
    }
}

