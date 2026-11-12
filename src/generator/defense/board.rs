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
    dealer_seat, discards_from_tiles, force_tedashi, random_round, random_scores_with_human_first,
    self_turn_river_plan,
};
use crate::rng::{choose, gen_range, shuffle};
use crate::safety::{SafetyFacts, SafetyMechanism, SafetyRank, is_near_dora, post_riichi_discards};
use crate::state::{CorrectAction, DecisionContext, GameState, PlayerState, TargetAction, Wind};

/// Which defense question the board is asking.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Lesson {
    /// The chart has a genuinely safe tile: find the safest discard.
    SafetyChart,
    /// The chart's ranking is the lesson: the safest tile is a suji or
    /// no-chance tile and the runner-up is exactly one row worse.
    SujiKabe,
    /// Nothing is identified safe: apply the chapter's fallback list.
    StuckHeuristic,
}

/// Builds a validated safety-chart board.
pub(super) fn build_safety_chart(category: &str, plan: ThemePlan) -> Result<GameState, String> {
    build(category, plan, Lesson::SafetyChart)
}

/// Builds the ranking mode of the fold lesson.
pub(super) fn build_suji_kabe(category: &str, plan: ThemePlan) -> Result<GameState, String> {
    build(category, plan, Lesson::SujiKabe)
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
    // two: one concealed and one as the draw. The ranking lesson's terminal
    // variants deliberately hold a pair or triplet, because the visible-copy
    // count is what picks the suji terminal's row.
    let answer_copies = match lesson {
        Lesson::StuckHeuristic => 2,
        Lesson::SujiKabe => 1 + plan.answer_concealed,
        Lesson::SafetyChart => 1,
    };
    for _ in 0..answer_copies {
        take(&mut deck, &mut visible, plan.answer)?;
    }

    // The ranking lesson seeds the concealed hand before the fill: the extra
    // answer copies and the runner-up, both already counted as visible above.
    let mut concealed: Vec<Tile> = Vec::with_capacity(13);
    if lesson == Lesson::SujiKabe {
        for _ in 0..plan.answer_concealed {
            concealed.push(plan.answer);
        }
        if let Some(runner_up) = plan.runner_up {
            for _ in 0..runner_up.copies {
                take(&mut deck, &mut visible, runner_up.tile)?;
                concealed.push(runner_up.tile);
            }
        }
    }

    // The threat's river: the theme's pattern in the early turns, then filler.
    // Every river comes from one legal timeline ending on Kamicha's discard,
    // so the seat counts line up no matter which seat the human holds.
    let river_plan = self_turn_river_plan(human_wind, &[], gen_range(8, 15));
    let discard_count = river_plan.counts[threat_seat];
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
    let mut rivers: [Vec<Tile>; 4] = std::array::from_fn(|_| Vec::new());
    let opponent_meta = [(1usize, "Shimocha"), (2, "Toimen"), (3, "Kamicha")];
    for (seat, name) in opponent_meta {
        let hand = deck
            .draw_n(13)
            .ok_or_else(|| "Deck exhausted dealing an opponent".to_string())?;

        let river = if seat == threat_seat {
            threat_river.clone()
        } else {
            let mut river = extra_by_seat.remove(&seat).unwrap_or_default();
            while river.len() < river_plan.counts[seat] {
                let tile = deck
                    .draw_excluding(1, &plan.all_avoid)
                    .and_then(|mut drawn| drawn.pop())
                    .ok_or_else(|| "Deck exhausted drawing an opponent river".to_string())?;
                increment(&mut visible, tile);
                river.push(tile);
            }
            river
        };
        rivers[seat] = river.clone();

        let mut discards = discards_from_tiles(&river);
        force_tedashi(&mut discards, &river_plan.hand_discards[seat]);
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
        .filter(|&indicator| deck.count(indicator) > 0 && !is_near_dora(plan.answer, &[indicator]))
        .filter(|indicator| !plan.all_avoid.contains(indicator))
        .collect();
    let dora_indicator =
        choose(&dora_candidates).ok_or_else(|| "No legal dora indicator".to_string())?;
    deck.take(dora_indicator)?;
    increment(&mut visible, dora_indicator);
    let ura_indicator = deck
        .draw()
        .ok_or_else(|| "Deck exhausted drawing the ura indicator".to_string())?;

    let mut human_river = Vec::with_capacity(river_plan.counts[0]);
    for _ in 0..river_plan.counts[0] {
        let tile = deck
            .draw_excluding(1, &plan.all_avoid)
            .and_then(|mut drawn| drawn.pop())
            .ok_or_else(|| "Deck exhausted drawing the human river".to_string())?;
        increment(&mut visible, tile);
        human_river.push(tile);
    }
    rivers[0] = human_river.clone();

    // Riichi Book 1, ch. 8: anything anyone discarded after the declaration is
    // genbutsu too. The generator has to know, or it can fill the learner's
    // hand with a tile that is just as safe as the answer (or safer) and then
    // reject a board the book would call correct.
    let post_riichi = post_riichi_discards(
        &rivers,
        dealer_seat(human_wind),
        threat_seat,
        threat_river.len() - 1,
    );

    let table_facts = facts_now(
        round_wind,
        threat_wind,
        &threat_river,
        &post_riichi,
        &visible,
    );
    let answer_rank = table_facts.rank(plan.answer);
    let answer_order = answer_rank.order();
    if lesson == Lesson::SujiKabe {
        let read = table_facts.read(plan.answer);
        if !accepts_suji_kabe(&read) {
            return Err(format!(
                "The ranking answer is Rank {} ({}), not a suji or no-chance tile",
                read.rank.code(),
                read.rank.label()
            ));
        }
        if let Some(runner_up) = plan.runner_up {
            let runner_order = table_facts.rank(runner_up.tile).order();
            if runner_order != answer_order + 1 {
                return Err(format!(
                    "The runner-up is Rank {}, not one row below Rank {}",
                    table_facts.rank(runner_up.tile).code(),
                    read.rank.code()
                ));
            }
        }
    } else if !accepts_answer(lesson, plan.theme, answer_rank) {
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
    let concealed_target: usize = if lesson == Lesson::StuckHeuristic {
        12
    } else {
        13
    };
    // The ranking lesson may already hold its answer copies and runner-up. A
    // pair or triplet is itself the block; a single answer needs a partner.
    let fill_count = concealed_target.saturating_sub(concealed.len());
    let mut needs_block = lesson == Lesson::SujiKabe
        && plan.answer_concealed == 0
        && !concealed.iter().any(|&tile| same_block(tile, plan.answer));
    for _ in 0..fill_count {
        // The cheap pass drops tiles that are already at least as safe as the
        // answer (adding a copy can only move a tile *up* the chart), then the
        // live check below confirms the pick against the enlarged visible set.
        let current = facts_now(
            round_wind,
            threat_wind,
            &threat_river,
            &post_riichi,
            &visible,
        );
        let floor = match lesson {
            Lesson::SujiKabe => answer_order + 1,
            _ => filler_floor(lesson, plan.answer, &current),
        };
        let runner_up_tile = plan.runner_up.map(|runner_up| runner_up.tile);
        let mut pool: Vec<Tile> = ALL_TILES
            .iter()
            .copied()
            .filter(|&tile| tile != plan.answer && Some(tile) != runner_up_tile)
            .filter(|&tile| deck.count(tile) > 0)
            .filter(|&tile| rank_is_legal(current.rank(tile), floor))
            .filter(|&tile| current.visible_of(tile) < 4)
            .filter(|&tile| !needs_block || same_block(tile, plan.answer))
            .filter(|&tile| {
                lesson != Lesson::StuckHeuristic || !current.outside_early_discards(tile)
            })
            .collect();
        shuffle(&mut pool);

        let mut placed = false;
        for tile in pool {
            let mut trial = visible.clone();
            increment(&mut trial, tile);
            let trial_facts =
                facts_now(round_wind, threat_wind, &threat_river, &post_riichi, &trial);
            let legal = match lesson {
                Lesson::SujiKabe => suji_kabe_filler_is_legal(
                    plan.answer,
                    runner_up_tile,
                    answer_order,
                    &trial_facts,
                    &concealed,
                    tile,
                ),
                _ => filler_is_legal(lesson, plan.answer, &trial_facts, &concealed, tile),
            };
            if legal {
                deck.take(tile)?;
                visible = trial;
                concealed.push(tile);
                placed = true;
                break;
            }
        }

        if !placed {
            return Err("No filler tile is ranked below the answer".to_string());
        }
        if needs_block && shares_block(&concealed, plan.answer) {
            needs_block = false;
        }
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
        discards: {
            let mut discards = discards_from_tiles(&human_river);
            force_tedashi(&mut discards, &river_plan.hand_discards[0]);
            discards
        },
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

    let mut state = GameState {
        category: category.to_string(),
        target_action: TargetAction::Defend,
        correct_action: CorrectAction::fold(plan.answer.to_string()),
        equivalent_tiles: Vec::new(),
        decision: DecisionContext::SelfTurn,
        scenario_note: None,
        call_offer: None,
        ai_decision: None,
        riichi_triggers: Vec::new(),
        dama_reasons: Vec::new(),
        shouminkan_triggers: Vec::new(),
        book_rationale: None,
        can_riichi: false,
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
    state.equivalent_tiles = genbutsu_ties(&state, threat_seat)?;

    if lesson == Lesson::SujiKabe {
        validate_suji_kabe(&state, threat_seat)?;
    } else {
        validate(&state, threat_seat, lesson, plan.theme)?;
    }

    Ok(state)
}

/// Every hand tile that ties the answer on the chart's 100% row.
///
/// The threat's river and every discard anyone made after the threat declared
/// Riichi are all genbutsu (ch. 8 lists both kinds), so a held copy of any of
/// them is exactly as safe as the answer. The generator keeps the board and
/// names the tie as an equivalent answer instead of re-rolling against the
/// model's pick.
fn genbutsu_ties(state: &GameState, threat_seat: usize) -> Result<Vec<String>, String> {
    let facts = SafetyFacts::from_state(state, threat_seat)
        .ok_or_else(|| "No safety facts for the threat seat".to_string())?;
    let answer = Tile::try_from(
        state
            .correct_action
            .tile()
            .ok_or_else(|| "The fold answer must name a tile".to_string())?,
    )
    .map_err(|err| err.to_string())?;
    if facts.rank(answer) != SafetyRank::Genbutsu {
        return Ok(Vec::new());
    }

    let mut ties: Vec<String> = state
        .tiles
        .iter()
        .filter_map(|code| Tile::try_from(code.as_str()).ok())
        .filter(|tile| *tile != answer && facts.rank(*tile) == SafetyRank::Genbutsu)
        .map(|tile| tile.to_string())
        .collect();
    ties.sort();
    ties.dedup();

    Ok(ties)
}

/// True when the answer sits inside a block the learner would be breaking.
///
/// The ranking lesson's design rule: the safest discard must be a pair, a set,
/// a run, or a protorun tile, not an isolated float or a lone honor. A pair is
/// two copies of the answer; a run or protorun is another suited tile within
/// two ranks (ch. 3's protorun width).
fn shares_block(hand: &[Tile], answer: Tile) -> bool {
    let copies = hand.iter().filter(|&&tile| tile == answer).count();
    if copies >= 2 {
        return true;
    }

    hand.iter()
        .any(|&tile| tile != answer && same_block(tile, answer))
}

/// True when two tiles belong to one block: a pair, a run, or a protorun.
fn same_block(a: Tile, b: Tile) -> bool {
    if a == b {
        return true;
    }

    match (a.suit(), a.value(), b.suit(), b.value()) {
        (Some(a_suit), Some(a_value), Some(b_suit), Some(b_value)) => {
            a_suit == b_suit && a_value.abs_diff(b_value) <= 2
        }
        _ => false,
    }
}

/// True when the ranking lesson's answer is a suji or no-chance tile.
///
/// Riichi Book 1, ch. 8, `tbl:safety`: the suji-terminal rows (`A+` down to
/// `AA`), `BBB` (suji 4-5-6 or no chance), `BB+` and `BB-`. Honors are excluded
/// even where their visible-count row overlaps: the lesson is about suji and
/// blockade arithmetic, not honor counting.
fn accepts_suji_kabe(read: &crate::safety::TileRead) -> bool {
    matches!(
        read.mechanism,
        SafetyMechanism::Suji | SafetyMechanism::NoChance
    ) && read.rank.order() <= SafetyRank::BbMinus.order()
}

/// Keep the ranking lesson's answer and runner-up on their exact chart rows
/// while the rest of the hand fills in strictly below both.
fn suji_kabe_filler_is_legal(
    answer: Tile,
    runner_up: Option<Tile>,
    answer_order: u8,
    facts: &SafetyFacts,
    placed: &[Tile],
    tile: Tile,
) -> bool {
    if facts.visible_of(tile) >= 4 {
        return false;
    }
    if placed
        .iter()
        .filter(|placed_tile| **placed_tile == tile)
        .count()
        >= 2
    {
        return false;
    }
    if facts.rank(answer).order() != answer_order {
        return false;
    }
    if let Some(runner_up) = runner_up
        && facts.rank(runner_up).order() != answer_order + 1
    {
        return false;
    }
    if facts.rank(tile).order() < answer_order + 2 {
        return false;
    }

    placed
        .iter()
        .filter(|placed_tile| **placed_tile != answer && Some(**placed_tile) != runner_up)
        .all(|placed_tile| facts.rank(*placed_tile).order() >= answer_order + 2)
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
        // The ranking mode is accepted by mechanism, not by theme row.
        Lesson::SujiKabe => false,
    }
}

/// The chart row a filler must be worse than.
///
/// Chart lessons keep every filler below the answer, so the answer is the best
/// tile. The fallback lesson only requires that nothing in the hand is
/// identified as safe; the pair and early-discard rules then pick the answer,
/// and the generator re-checks that they pick it alone.
fn filler_floor(lesson: Lesson, answer: Tile, facts: &SafetyFacts) -> u8 {
    match lesson {
        Lesson::StuckHeuristic => SafetyRank::B.order(),
        Lesson::SafetyChart => facts.rank(answer).order(),
        // The caller supplies the floor for the ranking mode; this arm only
        // keeps the match exhaustive.
        Lesson::SujiKabe => facts.rank(answer).order() + 1,
    }
}

/// True when a tile on `rank` is allowed next to the answer at `floor`.
///
/// Strictly worse is always allowed. A tie is allowed only on the 100% row: if
/// the answer is genbutsu, another genbutsu tile the learner holds (a copy of
/// the threat's river, or of anyone's post-riichi discard) is equally safe
/// (ch. 8), and the generator keeps that board instead of re-rolling. Every
/// other row still needs a strict gap, or the "safest discard" would not be the
/// answer.
fn rank_is_legal(rank: SafetyRank, floor: u8) -> bool {
    rank.order() > floor || (rank.order() == floor && rank == SafetyRank::Genbutsu)
}

fn filler_is_legal(
    lesson: Lesson,
    answer: Tile,
    facts: &SafetyFacts,
    placed: &[Tile],
    tile: Tile,
) -> bool {
    let floor = filler_floor(lesson, answer, facts);
    let legal_order = |candidate: Tile| rank_is_legal(facts.rank(candidate), floor);

    // Never let the hand complete a blockade of its own, and keep the fill
    // varied: four visible copies would silently promote the neighbours.
    if facts.visible_of(tile) >= 4 {
        return false;
    }
    if placed
        .iter()
        .filter(|placed_tile| **placed_tile == tile)
        .count()
        >= 2
    {
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
        let rank = facts.rank(*tile);
        if !rank_is_legal(rank, floor) {
            return Err(format!(
                "{} is Rank {}, inside the lesson's safe range",
                tile,
                rank.code()
            ));
        }
    }

    // A genbutsu tie is graded as the same answer, so it has to be recorded.
    let mut expected_ties: Vec<String> = hand_tiles
        .iter()
        .filter(|tile| **tile != answer)
        .filter(|tile| facts.rank(**tile) == SafetyRank::Genbutsu)
        .map(|tile| tile.to_string())
        .collect();
    expected_ties.sort();
    expected_ties.dedup();
    if expected_ties != state.equivalent_tiles {
        return Err(format!(
            "The genbutsu ties are {:?}, but the state lists {:?}",
            expected_ties, state.equivalent_tiles
        ));
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

    // The table must be a reachable position: rivers, melds, and the draw all
    // line up with one legal turn order.
    crate::generator::support::state_validation::validate_reachable_state(state)?;

    Ok(())
}

/// Re-derives the ranking lesson from the finished state.
fn validate_suji_kabe(state: &GameState, threat_seat: usize) -> Result<(), String> {
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
    let read = facts.read(answer);
    if !accepts_suji_kabe(&read) {
        return Err(format!(
            "The answer is Rank {} ({}), not a suji or no-chance tile",
            read.rank.code(),
            read.rank.label()
        ));
    }
    if !answer.is_honor() && facts.visible_of(answer) >= 4 {
        return Err("The answer tile is completely visible".to_string());
    }

    // The answer must be the unique best row, with the runner-up exactly one
    // row down the book's table. A tie at the answer's row is rejected so the
    // drill always has one right discard.
    let mut distinct = hand_tiles.clone();
    distinct.sort();
    distinct.dedup();
    let best_other = distinct
        .iter()
        .filter(|tile| **tile != answer)
        .map(|tile| facts.rank(*tile).order())
        .min();
    match best_other {
        Some(order) if order == read.rank.order() + 1 => {}
        Some(order) => {
            return Err(format!(
                "The runner-up is row {order}, not one row below the answer's row {}",
                read.rank.order()
            ));
        }
        None => return Err("The hand has no tile to rank beside the answer".to_string()),
    }

    if !shares_block(&hand_tiles, answer) {
        return Err("The answer is not part of a block".to_string());
    }

    if !state.equivalent_tiles.is_empty() {
        return Err(format!(
            "The ranking lesson must not have genbutsu ties, got {:?}",
            state.equivalent_tiles
        ));
    }

    // The table must be a reachable position: rivers, melds, and the draw all
    // line up with one legal turn order.
    crate::generator::support::state_validation::validate_reachable_state(state)?;

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
    post_riichi: &[Tile],
    visible: &HashMap<Tile, u8>,
) -> SafetyFacts {
    SafetyFacts::new(
        round_wind,
        threat_wind,
        threat_river.to_vec(),
        visible.clone(),
    )
    .with_post_riichi_genbutsu(post_riichi.iter().copied())
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
    use super::super::{generate_safety_chart, generate_stuck, generate_suji_kabe};
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
    fn chart_lesson_names_the_safest_discard() {
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

            for code in &state.tiles {
                let tile = Tile::try_from(code.as_str()).expect("tile code");
                if tile == answer {
                    continue;
                }
                let rank = facts.rank(tile);
                // Another player's post-riichi discard of the same tile ties
                // the answer on the 100% row (ch. 8 calls both genbutsu), so
                // the board keeps that tie as an equivalent answer. Every
                // other tile must be strictly worse.
                let tie = rank == SafetyRank::Genbutsu && answer_rank == SafetyRank::Genbutsu;
                assert!(
                    tie || rank.order() > answer_rank.order(),
                    "run {run}: {tile} is not strictly worse than the answer"
                );
                if tie {
                    assert!(
                        state.equivalent_tiles.contains(&tile.to_string()),
                        "run {run}: the genbutsu tie {tile} must grade as correct"
                    );
                }
            }

            for equivalent in &state.equivalent_tiles {
                let tile = Tile::try_from(equivalent.as_str()).expect("equivalent tile");
                assert_ne!(tile, answer);
                assert_eq!(facts.rank(tile), SafetyRank::Genbutsu);
                assert!(state.tiles.contains(equivalent));
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

            assert!(matches!(facts.rank(answer), SafetyRank::Cc | SafetyRank::C));
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
            assert_eq!(
                choice, answer,
                "run {run}: the fallback list picked {choice}"
            );
            assert!(rules.pair_or_set);
            assert!(rules.outside_early);
        }
    }

    #[test]
    fn genbutsu_ties_are_legal_but_no_other_tie_is() {
        // A second 100% tile ties the genbutsu answer and is accepted.
        assert!(rank_is_legal(
            SafetyRank::Genbutsu,
            SafetyRank::Genbutsu.order()
        ));
        // Anything strictly below the answer is fine.
        assert!(rank_is_legal(SafetyRank::Bbb, SafetyRank::Genbutsu.order()));
        // A tie on any other row is not: the answer would not be unique.
        assert!(!rank_is_legal(SafetyRank::Bbb, SafetyRank::Bbb.order()));
        assert!(!rank_is_legal(SafetyRank::A, SafetyRank::B.order()));
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

    #[test]
    fn suji_kabe_lesson_ranks_the_table() {
        let mut rows: Vec<u8> = Vec::new();

        for run in 0..60 {
            let state = generate_suji_kabe("suji_kabe_safety")
                .unwrap_or_else(|err| panic!("run {run} failed: {err}"));

            assert_eq!(state.category, "suji_kabe_safety");
            assert_eq!(state.target_action, TargetAction::Defend);
            assert!(matches!(state.correct_action, CorrectAction::Fold { .. }));

            let threat = threat(&state);
            assert!(threat.riichi_discard_index.is_some());

            let human = human(&state);
            assert_eq!(human.hand.len() + usize::from(human.draw.is_some()), 14);
            assert_eq!(human.draw.as_deref(), state.correct_action.tile());
            assert!(human.melds.is_empty());
            assert!(!human.is_riichi);
            assert!(state.shanten >= MIN_SHANTEN);

            let facts = SafetyFacts::from_state(&state, threat.seat).expect("facts");
            let answer = answer_tile(&state);
            let read = facts.read(answer);

            // The ranking lesson never takes the free genbutsu: the answer is
            // always a suji or no-chance tile.
            assert!(
                matches!(
                    read.mechanism,
                    SafetyMechanism::Suji | SafetyMechanism::NoChance
                ),
                "run {run}: the answer is {:?}",
                read.mechanism
            );
            assert_ne!(read.rank, SafetyRank::Genbutsu);

            // The answer is the unique best row and the runner-up is exactly
            // one row down the book's table.
            let mut rivals: Vec<SafetyRank> = state
                .tiles
                .iter()
                .filter_map(|code| Tile::try_from(code.as_str()).ok())
                .filter(|tile| *tile != answer)
                .map(|tile| facts.rank(tile))
                .collect();
            rivals.sort_by_key(|rank| rank.order());
            assert_eq!(
                rivals[0].order(),
                read.rank.order() + 1,
                "run {run}: the runner-up is {} but the answer is {}",
                rivals[0].code(),
                read.rank.code()
            );
            assert!(
                rivals
                    .iter()
                    .all(|rank| rank.order() == read.rank.order() + 1
                        || rank.order() > read.rank.order() + 1),
                "run {run}: a rival ties or beats the answer"
            );

            // The answer must be part of a block, so the fold breaks shape.
            let hand_tiles: Vec<Tile> = human
                .hand
                .iter()
                .chain(human.draw.iter())
                .filter_map(|code| Tile::try_from(code.as_str()).ok())
                .collect();
            assert!(
                shares_block(&hand_tiles, answer),
                "run {run}: {answer} is an isolated tile"
            );

            // No genbutsu ties: only the answer sits on its row.
            assert!(state.equivalent_tiles.is_empty());

            if !rows.contains(&read.rank.order()) {
                rows.push(read.rank.order());
            }
        }

        assert!(
            rows.len() >= 5,
            "the ranking lesson only showed rows {rows:?}"
        );
    }
}
