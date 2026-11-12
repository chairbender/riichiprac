//! Board assembly for the ch. 8.1 push/fold lesson.
//!
//! The table is the defense lessons' shape: one opponent has just declared
//! Riichi, the human is about to discard after drawing, and every river is
//! dealt from one legal timeline so the position is reachable. The lesson adds
//! the piece that makes push/fold a decision rather than a tile-hunting drill:
//!
//! - the hand's 13-tile core is built to hit a cell of the book's box, so the
//!   answer follows from the hand rather than from the safety chart alone;
//! - one core tile is planted in the threat's river, which makes it 100% safe.
//!   On the fold branch that tile is the answer, so folding is a visible
//!   sacrifice of a block tile; on the push branch it is the temptation the
//!   learner has to decline;
//! - the tile the lesson calls the shape-preserving discard is a non-suji 4-6
//!   tile (the chart's Rank D), which is exactly the row the book lets a
//!   guaranteed mangan throw (ch. 8, "Defense against riichi").
//!
//! Every filler river tile avoids the human's hand and the drawn tile's suji
//! deniers, so no accidental genbutsu or suji can steal either branch's answer.

use agari::parse::to_counts;
use agari::shanten::calculate_shanten;
use agari::tile::Tile;

use super::skeleton::{self, Target};
use crate::generator::support::analysis::evaluate_hand;
use crate::generator::support::deck::Deck;
use crate::generator::support::format::format_hand_compact;
use crate::generator::support::table::{
    discards_from_tiles, force_tedashi, random_round, random_scores_with_human_first,
    self_turn_river_plan,
};
use crate::rng::{choose, gen_range};
use crate::safety::{SafetyFacts, SafetyRank, suji_deniers};
use crate::state::{CorrectAction, DecisionContext, GameState, PlayerState, TargetAction, Wind};

/// Builds one validated push/fold board for `target`.
pub(super) fn build(category: &str, target: Target) -> Result<GameState, String> {
    let (round_wind, hand_number) = random_round();
    let scores = random_scores_with_human_first();
    // The book's 7700 floor is the non-dealer ron value, so the human never
    // sits on the dealer seat.
    let human_wind = choose(&[Wind::South, Wind::West, Wind::North])
        .ok_or_else(|| "No non-dealer wind available".to_string())?;
    let threat_seat = gen_range(1, 4);

    let skeleton = skeleton::build(target, round_wind, human_wind)?;
    let hand_tiles = skeleton.tiles.clone();

    let mut deck = Deck::fresh();
    for &tile in &hand_tiles {
        deck.take(tile)?;
    }
    deck.take(skeleton.dora_indicator)?;
    let ura_indicator = deck
        .draw()
        .ok_or_else(|| "Deck exhausted drawing the ura indicator".to_string())?;

    // Nothing in any river may repeat a hand tile: a copy of a hand tile in a
    // river would be genbutsu too, which would either steal the fold answer or
    // turn the push discard into a safe tile.
    let mut avoid = hand_tiles.clone();
    // The push discard must stay on the chart's Rank D row, so its suji
    // deniers (the 1/7, 2/8 or 3/9 tiles of its suit) must not appear.
    avoid.extend(suji_deniers(skeleton.drawn));
    avoid.sort();
    avoid.dedup();

    let river_plan = self_turn_river_plan(human_wind, &[], gen_range(9, 15));
    let threat_discards = river_plan.counts[threat_seat];

    // The threat's river: the planted safe tile first, then filler.
    let mut threat_river = Vec::with_capacity(threat_discards);
    deck.take(skeleton.safe_tile)?;
    threat_river.push(skeleton.safe_tile);
    while threat_river.len() < threat_discards {
        let tile = deck
            .draw_excluding(1, &avoid)
            .and_then(|mut drawn| drawn.pop())
            .ok_or_else(|| "Deck exhausted drawing the threat river".to_string())?;
        threat_river.push(tile);
    }

    let human_river = deck
        .draw_excluding(river_plan.counts[0], &avoid)
        .ok_or_else(|| "Deck exhausted drawing the human river".to_string())?;

    let mut players = Vec::with_capacity(4);
    let opponent_meta = [(1usize, "Shimocha"), (2, "Toimen"), (3, "Kamicha")];
    for (seat, name) in opponent_meta {
        let hand = deck
            .draw_n(13)
            .ok_or_else(|| "Deck exhausted dealing an opponent".to_string())?;
        let river = if seat == threat_seat {
            threat_river.clone()
        } else {
            deck.draw_excluding(river_plan.counts[seat], &avoid)
                .ok_or_else(|| "Deck exhausted drawing an opponent river".to_string())?
        };

        let mut discards = discards_from_tiles(&river);
        force_tedashi(&mut discards, &river_plan.hand_discards[seat]);
        let is_threat = seat == threat_seat;
        if is_threat && let Some(last) = discards.last_mut() {
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

    let metrics = evaluate_hand(&hand_tiles);
    if metrics.shanten != 1 {
        return Err(format!(
            "The push/fold hand must be 1-away, got {}",
            metrics.shanten
        ));
    }

    let hand_string = format_hand_compact(&hand_tiles);
    let tile_strings: Vec<String> = hand_tiles.iter().map(ToString::to_string).collect();

    let human_player = PlayerState {
        seat: 0,
        name: "You".to_string(),
        is_human: true,
        wind: human_wind,
        score: scores[0],
        hand: skeleton.core.iter().map(ToString::to_string).collect(),
        draw: Some(skeleton.drawn.to_string()),
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

    let (target_action, correct_action) = match target {
        Target::Push => (
            TargetAction::Push,
            CorrectAction::dama(skeleton.answer.to_string()),
        ),
        Target::Fold => (
            TargetAction::Fold,
            CorrectAction::fold(skeleton.answer.to_string()),
        ),
    };

    let state = GameState {
        category: category.to_string(),
        target_action,
        correct_action,
        equivalent_tiles: skeleton
            .equivalent
            .map(|tile| vec![tile.to_string()])
            .unwrap_or_default(),
        decision: DecisionContext::SelfTurn,
        scenario_note: Some(threat_note(&skeleton)),
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
        dora_indicators: vec![skeleton.dora_indicator.to_string()],
        ura_dora_indicators: vec![ura_indicator.to_string()],
        tiles_remaining,
        current_turn: 0,
        players,
    };

    validate(&state, threat_seat, target, &skeleton)?;

    Ok(state)
}

/// The one-line note shown above the board.
///
/// It states the two facts the book's box asks the player to judge — the
/// minimum value and the best wait still available — without naming the
/// conclusion, so the decision is still the learner's.
fn threat_note(skeleton: &skeleton::Skeleton) -> String {
    let value = match skeleton.value {
        Some(value) => format!(
            "the worst winning tile is already worth {} points without Riichi",
            value.points
        ),
        None => "at least one way the hand can win has no yaku at all".to_string(),
    };
    let wait = if skeleton.good_wait {
        "every completion can still choose a side wait"
    } else {
        "at least one completion can only reach a closed, edge or single wait"
    };
    format!("An opponent has declared Riichi. You are 1-away: {value}, and {wait}.")
}

/// Re-derives the lesson's answer from the finished table.
fn validate(
    state: &GameState,
    threat_seat: usize,
    target: Target,
    skeleton: &skeleton::Skeleton,
) -> Result<(), String> {
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
    if !human.melds.is_empty() || human.is_riichi {
        return Err("The defender must be concealed and not in Riichi".to_string());
    }

    let mut hand_tiles: Vec<Tile> = human
        .hand
        .iter()
        .filter_map(|code| Tile::try_from(code.as_str()).ok())
        .collect();
    let drawn = human
        .draw
        .as_deref()
        .ok_or_else(|| "The defender must have drawn a tile".to_string())
        .and_then(|code| Tile::try_from(code).map_err(|err| err.to_string()))?;
    hand_tiles.push(drawn);
    if hand_tiles.len() != 14 {
        return Err(format!(
            "The defender must hold 14 tiles, got {}",
            hand_tiles.len()
        ));
    }
    hand_tiles.sort();

    let answer = Tile::try_from(
        state
            .correct_action
            .tile()
            .ok_or_else(|| "The push/fold answer must name a tile".to_string())?,
    )
    .map_err(|err| err.to_string())?;
    if answer != skeleton.answer || drawn != skeleton.drawn {
        return Err("The state's answer does not match the skeleton".to_string());
    }

    let facts = SafetyFacts::from_state(state, threat_seat)
        .ok_or_else(|| "No safety facts for the threat seat".to_string())?;
    let answer_rank = facts.rank(answer);

    // The planted safe tile must be 100% safe, and no other hand tile may be.
    if facts.rank(skeleton.safe_tile) != SafetyRank::Genbutsu {
        return Err(format!(
            "The planted tile is Rank {}, not genbutsu",
            facts.rank(skeleton.safe_tile).code()
        ));
    }
    for &tile in &hand_tiles {
        if tile == skeleton.safe_tile || tile == answer {
            continue;
        }
        if facts.rank(tile) == SafetyRank::Genbutsu {
            return Err(format!(
                "{tile} is genbutsu too, so the safest discard is not unique"
            ));
        }
    }

    match target {
        Target::Push => {
            if answer != drawn {
                return Err("Pushing must keep the perfect core".to_string());
            }
            if answer_rank != SafetyRank::D {
                return Err(format!(
                    "The push discard must be Rank D, got {}",
                    answer_rank.code()
                ));
            }
            // The core float is the other shape-preserving discard, so it has
            // to be just as dangerous and just as good a push; otherwise one
            // of the two correct answers would be graded wrong.
            if let Some(equivalent) = skeleton.equivalent {
                if equivalent == answer || !hand_tiles.contains(&equivalent) {
                    return Err("The equivalent push tile must be another hand tile".to_string());
                }
                if state.equivalent_tiles != vec![equivalent.to_string()] {
                    return Err("The equivalent push tile must be recorded".to_string());
                }
                let rank = facts.rank(equivalent);
                if rank != SafetyRank::D {
                    return Err(format!(
                        "The equivalent push discard is Rank {}, not D",
                        rank.code()
                    ));
                }
                let kept = without(&hand_tiles, equivalent)?;
                let dora = dora_tiles(state);
                let alternative =
                    super::hand_conditions(&kept, state.round_wind, human.wind, &dora);
                if !alternative.pushes() {
                    return Err(
                        "Discarding the core float does not keep the push conditions".to_string(),
                    );
                }
            }
            // The safe tile is the fold temptation: throwing it has to break
            // the hand.
            let broken = without(&hand_tiles, skeleton.safe_tile)?;
            let shanten = calculate_shanten(&to_counts(&broken)).shanten;
            if shanten < 2 {
                return Err(format!(
                    "Discarding the safe tile leaves a {shanten}-away hand, so folding \
                     would not cost anything"
                ));
            }
        }
        Target::Fold => {
            if answer != skeleton.safe_tile {
                return Err("Folding must throw the safest tile".to_string());
            }
            if answer_rank != SafetyRank::Genbutsu {
                return Err(format!(
                    "The fold answer must be 100% safe, got Rank {}",
                    answer_rank.code()
                ));
            }
            if !state.equivalent_tiles.is_empty() {
                return Err("The fold answer has no equivalent tile".to_string());
            }
        }
    }

    // Re-derive the two conditions the answer depends on from the shipped
    // tiles, never from the constructor.
    let core: Vec<Tile> = {
        let mut core = hand_tiles.clone();
        let index = core
            .iter()
            .position(|tile| *tile == drawn)
            .ok_or_else(|| "The drawn tile is not in the hand".to_string())?;
        core.remove(index);
        core
    };
    let dora = dora_tiles(state);
    let conditions = super::hand_conditions(&core, state.round_wind, human.wind, &dora);
    let value = conditions.value;
    let good_wait = conditions.good_wait;
    let wants_push = conditions.pushes();
    match target {
        Target::Push if !wants_push => {
            return Err(format!(
                "A 1-away hand pushes only with both other conditions: value {value:?}, \
                 good wait {good_wait}"
            ));
        }
        Target::Fold if wants_push => {
            return Err("The fold hand actually meets both push conditions".to_string());
        }
        _ => {}
    }

    // The table must be a reachable position: rivers, melds, and the draw all
    // line up with one legal turn order.
    crate::generator::support::state_validation::validate_reachable_state(state)?;

    Ok(())
}

/// The dora indicator tiles, parsed.
fn dora_tiles(state: &GameState) -> Vec<Tile> {
    state
        .dora_indicators
        .iter()
        .filter_map(|code| Tile::try_from(code.as_str()).ok())
        .collect()
}

/// Removes one copy of `tile` from `tiles`.
fn without(tiles: &[Tile], tile: Tile) -> Result<Vec<Tile>, String> {
    let mut rest = tiles.to_vec();
    let index = rest
        .iter()
        .position(|candidate| *candidate == tile)
        .ok_or_else(|| format!("{tile} is not in the hand"))?;
    rest.remove(index);
    Ok(rest)
}
