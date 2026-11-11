use agari::context::indicator_to_dora;
use agari::parse::{to_counts, validate_hand};
use agari::tile::Tile;

use super::skeleton::{self, ShouminkanSkeleton};
use super::triggers::ShouminkanTriggerSet;
use crate::generator::support::analysis::{HandMetrics, evaluate_counts, visible_tile_counts};
use crate::generator::support::deck::{ALL_TILES, Deck};
use crate::generator::support::format::format_hand_compact;
use crate::generator::support::table::{
    OpponentDeal, deal_opponents, discards_from_tiles, losing_badly_ranked_scores,
    placement_desperation_ranked_scores, random_round, random_table_scores, scores_for_seats,
};
use crate::rng::{choose, gen_range, shuffle};
use crate::state::{
    CalledMeld, CorrectAction, DecisionContext, GameState, MeldType, PlayerState, TargetAction,
    Wind,
};

/// What the board asks the player to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ShouminkanAnswer {
    /// Upgrade the Pon to an Added Kan.
    Kan,
    /// Keep the Pon and discard the drawn fourth tile.
    Decline,
}

/// The validated hand shapes for one Added Kan puzzle.
struct PreparedHand {
    full_tiles: Vec<Tile>,
    concealed_hand: Vec<Tile>,
    metrics: HandMetrics,
}

/// Board-level values chosen after the hand and indicators are fixed.
struct TableContext {
    round_wind: Wind,
    hand_number: u8,
    human_wind: Wind,
    dora_indicator: Tile,
    ura_indicator: Tile,
    scores: [i32; 4],
    human_river: Vec<Tile>,
    deal: OpponentDeal,
    tiles_remaining: u8,
}

/// Builds and validates a complete Added Kan board.
pub(super) fn build(
    category: &str,
    skeleton: &ShouminkanSkeleton,
    triggers: ShouminkanTriggerSet,
    answer: ShouminkanAnswer,
) -> Result<GameState, String> {
    let prepared = prepare_hand(skeleton)?;
    let (mut deck, dora_indicator, ura_indicator) = build_deck(skeleton)?;
    let (round_wind, hand_number, scores) = choose_round_and_scores(triggers, skeleton)?;
    // The decline lesson teaches that a value-rich 2-away hand should keep the
    // Pon. A placement or score emergency would justify the Kan on its own
    // (book bullets 3 and 4), so those tables have to be rejected rather than
    // winning a random draw.
    if answer == ShouminkanAnswer::Decline && table_is_desperate(round_wind, hand_number, &scores) {
        return Err("Decline scenario cannot be a placement or score emergency".to_string());
    }
    let human_wind = choose(&Wind::ALL).ok_or_else(|| "No seat wind available".to_string())?;
    let discard_count = choose_discard_count(triggers);

    let deal = deal_opponents(&mut deck, human_wind, &scores, discard_count)
        .ok_or_else(|| "Deck exhausted drawing the opponents".to_string())?;

    // The human is not furiten: neither wait may appear in their river.
    let human_river = deck
        .draw_excluding(discard_count, &skeleton.wait_tiles)
        .ok_or_else(|| "Deck exhausted drawing the human river".to_string())?;

    validate_visible_waits(skeleton, &deal.rivers, dora_indicator, ura_indicator)?;

    let tiles_remaining = deck.remaining().saturating_sub(12).min(u8::MAX as usize) as u8;
    validate_board_constraints(skeleton, triggers, answer, &prepared, tiles_remaining)?;

    Ok(assemble_state(
        category,
        skeleton,
        triggers,
        answer,
        prepared,
        TableContext {
            round_wind,
            hand_number,
            human_wind,
            dora_indicator,
            ura_indicator,
            scores,
            human_river,
            deal,
            tiles_remaining,
        },
    ))
}

/// Validates the visible tiles and evaluates the post-discard hand.
fn prepare_hand(skeleton: &ShouminkanSkeleton) -> Result<PreparedHand, String> {
    let full_tiles = skeleton.full_tiles();
    validate_hand(&full_tiles)?;

    let mut concealed_hand = skeleton.concealed_tiles.clone();
    concealed_hand.sort();

    let mut post_discard_tiles = concealed_hand.clone();
    post_discard_tiles.extend(skeleton.open_pon_tiles.iter().copied());
    let metrics = evaluate_counts(&to_counts(&post_discard_tiles));

    Ok(PreparedHand {
        full_tiles,
        concealed_hand,
        metrics,
    })
}

/// Removes the hand from the deck and draws the dora and ura indicators.
fn build_deck(skeleton: &ShouminkanSkeleton) -> Result<(Deck, Tile, Tile), String> {
    let mut deck = Deck::fresh();
    for tile in &skeleton.full_tiles() {
        deck.take(*tile)?;
    }

    // Never make the Pon tile itself dora; the lesson's value must come
    // from hand structure rather than an obvious Kan dora.
    let dora_candidates: Vec<Tile> = ALL_TILES
        .iter()
        .copied()
        .filter(|&indicator| {
            indicator_to_dora(indicator) != skeleton.drawn_tile && deck.has(indicator)
        })
        .collect();
    let dora_indicator =
        choose(&dora_candidates).ok_or_else(|| "No legal dora indicator".to_string())?;
    deck.take(dora_indicator)?;

    let ura_candidates: Vec<Tile> = ALL_TILES
        .iter()
        .copied()
        .filter(|&indicator| {
            indicator_to_dora(indicator) != skeleton.drawn_tile && deck.has(indicator)
        })
        .collect();
    let ura_indicator =
        choose(&ura_candidates).ok_or_else(|| "No legal ura indicator".to_string())?;
    deck.take(ura_indicator)?;

    Ok((deck, dora_indicator, ura_indicator))
}

/// Chooses the round and seat-ordered scores that match the active lesson.
fn choose_round_and_scores(
    triggers: ShouminkanTriggerSet,
    skeleton: &ShouminkanSkeleton,
) -> Result<(Wind, u8, [i32; 4]), String> {
    let (round_wind, hand_number) = if triggers.placement_desperation {
        (Wind::South, 4)
    } else {
        random_round()
    };

    let scores = if triggers.placement_desperation {
        let gap = placement_gap(skeleton)?;
        let human_rank = gen_range(1, 3);
        scores_for_seats(
            placement_desperation_ranked_scores(human_rank, gap),
            human_rank,
        )
    } else if triggers.losing_badly {
        scores_for_seats(losing_badly_ranked_scores(), 3)
    } else {
        let mut scores = random_table_scores();
        shuffle(&mut scores);
        scores
    };

    if triggers.placement_desperation {
        let human_score = scores[0];
        let above = scores
            .iter()
            .copied()
            .filter(|&score| score > human_score)
            .min()
            .ok_or_else(|| "Placement scenario has nobody above the human".to_string())?;
        let rank = 1 + scores.iter().filter(|&&score| score > human_score).count();
        if !(rank == 2 || rank == 3) {
            return Err(format!(
                "Human must be 2nd or 3rd in a placement scenario, got rank {rank}"
            ));
        }
        // The gap has to fall inside the hand's value window: keeping the Pon
        // leaves the human short of the player above, and only the Kan's extra
        // minipoints close it.
        let window = skeleton::value::placement_window(skeleton.min_han).ok_or_else(|| {
            "This hand gains no value from the Kan, so it cannot decide a placement".to_string()
        })?;
        let gap = above - human_score;
        if gap <= window.dama as i32 || gap > window.kan as i32 {
            return Err(format!(
                "Placement gap {gap} is outside the Kan window ({} , {}]",
                window.dama, window.kan
            ));
        }
    }

    if triggers.losing_badly {
        let human_score = scores[0];
        let rank = 1 + scores.iter().filter(|&&score| score > human_score).count();
        let mut sorted_scores = scores;
        sorted_scores.sort_by(|a, b| b.cmp(a));
        if rank != 4 || sorted_scores[2] - human_score <= 12_000 {
            return Err("Losing scenario must be 4th by more than 12,000".to_string());
        }
    }

    Ok((round_wind, hand_number, scores))
}

/// The gap to the player above that only the Kan's minipoints can close.
///
/// Sampled from the hand's own value window, in whole hundreds of points, so
/// every placement puzzle asks the same question: the Pon's hand is not worth
/// enough to catch the player above, and the Kan's added minipoints are.
fn placement_gap(skeleton: &ShouminkanSkeleton) -> Result<i32, String> {
    let window = skeleton::value::placement_window(skeleton.min_han).ok_or_else(|| {
        "This hand gains no value from the Kan, so it cannot decide a placement".to_string()
    })?;

    let first_hundred = window.dama / 100 + 1;
    let last_hundred = window.kan / 100;
    if first_hundred > last_hundred {
        return Err("Kan window has no whole-hundred gap".to_string());
    }

    let steps: Vec<i32> = (first_hundred..=last_hundred)
        .map(|h| h as i32 * 100)
        .collect();
    choose(&steps).ok_or_else(|| "No placement gap available".to_string())
}

/// True when the table position alone justifies an Added Kan: South-4 within
/// the hand's Kan value window, or fourth place more than 12,000 behind third.
/// These are Riichi Book 1, ch. 9's third and fourth kakan conditions.
fn table_is_desperate(round_wind: Wind, hand_number: u8, scores: &[i32; 4]) -> bool {
    let human_score = scores[0];
    let above = scores
        .iter()
        .copied()
        .filter(|&score| score > human_score)
        .min();
    let rank = 1 + scores.iter().filter(|&&score| score > human_score).count();

    let placement = round_wind == Wind::South
        && hand_number == 4
        && matches!(rank, 2 | 3)
        && above.is_some_and(|score| score - human_score < 2_000);

    let mut sorted = *scores;
    sorted.sort_by(|a, b| b.cmp(a));
    let losing_badly = rank == 4 && sorted[2] - human_score > 12_000;

    placement || losing_badly
}

/// Chooses how many discards each player has made for the active lesson.
fn choose_discard_count(triggers: ShouminkanTriggerSet) -> usize {
    if triggers.late_game {
        gen_range(13, 17)
    } else if triggers.placement_desperation || triggers.losing_badly {
        gen_range(8, 13)
    } else {
        gen_range(2, 7)
    }
}

/// Rejects a wait whose every copy is already visible in a river or indicator.
fn validate_visible_waits(
    skeleton: &ShouminkanSkeleton,
    opponent_rivers: &[Vec<Tile>],
    dora_indicator: Tile,
    ura_indicator: Tile,
) -> Result<(), String> {
    let visible_wait_counts =
        visible_tile_counts(opponent_rivers, &[dora_indicator, ura_indicator]);
    for wait_tile in &skeleton.wait_tiles {
        if visible_wait_counts.get(wait_tile).copied().unwrap_or(0) >= 4 {
            return Err(format!("Wait tile {wait_tile} is completely visible"));
        }
    }

    Ok(())
}

/// Rejects hands that do not satisfy the lesson's wait/wall constraints.
fn validate_board_constraints(
    skeleton: &ShouminkanSkeleton,
    triggers: ShouminkanTriggerSet,
    answer: ShouminkanAnswer,
    prepared: &PreparedHand,
    tiles_remaining: u8,
) -> Result<(), String> {
    if prepared.metrics.shanten != skeleton.expected_shanten {
        return Err(format!(
            "Added Kan discard must leave a {}-shanten hand, got {}",
            skeleton.expected_shanten, prepared.metrics.shanten
        ));
    }
    if triggers.good_wait_and_value && !matches!(skeleton.wait_tiles.len(), 2 | 3) {
        return Err("Good-wait scenario must have a ryanmen or three-sided wait".to_string());
    }
    // Book bullets 3 and 4 stand on their own: the hand is not close to ready
    // and the Kan is about the dora and minipoints.
    if triggers.needs_dora && prepared.metrics.shanten < 2 {
        return Err(format!(
            "Needs-dora scenario must be 2-away or worse, got shanten {}",
            prepared.metrics.shanten
        ));
    }
    if answer == ShouminkanAnswer::Decline {
        if prepared.metrics.shanten < 2 {
            return Err(format!(
                "Decline scenario must be 2-away or worse, got shanten {}",
                prepared.metrics.shanten
            ));
        }
        if triggers.any() {
            return Err("Decline scenario has no reason to call the Kan".to_string());
        }
    }
    if tiles_remaining == 0 {
        return Err("No drawable tiles remain".to_string());
    }
    if triggers.late_game && tiles_remaining >= 20 {
        return Err(format!(
            "Late-game scenario must leave fewer than 20 wall tiles, got {tiles_remaining}"
        ));
    }

    Ok(())
}

/// Assembles the public `GameState` from the validated pieces.
fn assemble_state(
    category: &str,
    skeleton: &ShouminkanSkeleton,
    triggers: ShouminkanTriggerSet,
    answer: ShouminkanAnswer,
    prepared: PreparedHand,
    context: TableContext,
) -> GameState {
    let PreparedHand {
        full_tiles,
        concealed_hand,
        metrics,
    } = prepared;
    let TableContext {
        round_wind,
        hand_number,
        human_wind,
        dora_indicator,
        ura_indicator,
        scores,
        human_river,
        deal,
        tiles_remaining,
    } = context;

    let mut display_tiles = full_tiles;
    display_tiles.sort();
    let hand_string = format_hand_compact(&display_tiles);
    let tile_strings: Vec<String> = display_tiles.iter().map(|tile| tile.to_string()).collect();
    let meld_tiles: Vec<String> = skeleton
        .open_pon_tiles
        .iter()
        .map(|tile| tile.to_string())
        .collect();

    let human_player = PlayerState {
        seat: 0,
        name: "You".to_string(),
        is_human: true,
        wind: human_wind,
        score: scores[0],
        hand: concealed_hand.iter().map(|tile| tile.to_string()).collect(),
        draw: Some(skeleton.drawn_tile.to_string()),
        red_fives: Vec::new(),
        discards: discards_from_tiles(&human_river),
        melds: vec![CalledMeld {
            meld_type: MeldType::Pon,
            tiles: meld_tiles,
            called_from: Some(1),
        }],
        is_riichi: false,
        riichi_discard_index: None,
    };

    let mut players = Vec::with_capacity(4);
    players.push(human_player);
    players.extend(deal.players);

    // Both questions are "Call Shouminkan, or discard?", so the prompt stays
    // the same; only the expected answer changes.
    let (correct_action, shouminkan_triggers) = match answer {
        ShouminkanAnswer::Kan => (
            CorrectAction::kan(skeleton.drawn_tile.to_string()),
            triggers.to_vec(),
        ),
        ShouminkanAnswer::Decline => (
            CorrectAction::discard(skeleton.drawn_tile.to_string()),
            Vec::new(),
        ),
    };

    GameState {
        category: category.to_string(),
        target_action: TargetAction::Kan,
        correct_action,
        decision: DecisionContext::SelfTurn,
        ai_decision: None,
        riichi_triggers: Vec::new(),
        dama_reasons: Vec::new(),
        shouminkan_triggers,
        book_rationale: None,
        hand_string,
        tiles: tile_strings,
        shanten: metrics.shanten,
        is_agari: false,
        decompositions_count: metrics.decompositions_count,
        ukeire_tiles: metrics.ukeire_tiles,
        ukeire_total: metrics.ukeire_total,
        round_wind,
        hand_number,
        honba: gen_range(0, 4) as u8,
        riichi_sticks: 0,
        dora_indicators: vec![dora_indicator.to_string()],
        ura_dora_indicators: vec![ura_indicator.to_string()],
        tiles_remaining,
        current_turn: 0,
        players,
    }
}
