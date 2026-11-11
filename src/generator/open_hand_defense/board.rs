//! Table assembly for the open-hand chii-discard lesson.

use agari::context::indicator_to_dora;
use agari::parse::to_counts;
use agari::shanten::{calculate_shanten_with_melds, calculate_ukeire_with_melds};
use agari::tile::{Honor, Suit, Tile};

use super::skeleton::{OpenHandCase, Skeleton, THREAT_SEAT};
use crate::generator::support::analysis::evaluate_counts;
use crate::generator::support::deck::{ALL_TILES, Deck};
use crate::generator::support::format::format_hand_compact;
use crate::generator::support::table::{
    discards_from_tiles, force_tedashi, random_round, random_scores_with_human_first,
    self_turn_river_plan,
};
use crate::rng::{choose, gen_range, shuffle};
use crate::safety::in_open_hand_neighbourhood;
use crate::state::{
    CalledMeld, CorrectAction, DecisionContext, GameState, MeldType, PlayerState, TargetAction,
    Wind,
};

/// The human hand is built as two complete sets, one protorun, a pair, and four
/// lone honors. The answer is one tile of the protorun. That shape is exactly
/// 2-away, which keeps the lesson a fold rather than an efficiency puzzle, and
/// keeps Riichi off the table.
const HUMAN_SHANTEN: i8 = 2;

/// Builds one complete, validated open-hand chii-discard board.
pub(super) fn build_board(category: &str, skeleton: &Skeleton) -> Result<GameState, String> {
    let (round_wind, hand_number) = random_round();
    let honba = gen_range(0, 4) as u8;
    let scores = random_scores_with_human_first();
    let human_wind = choose(&Wind::ALL).ok_or_else(|| "no seat wind available".to_string())?;

    let mut deck = Deck::fresh();

    // Reserve every tile the lesson reasons about before any random fill can
    // consume a copy.
    reserve_threat(&mut deck, skeleton)?;
    let (human_concealed, draw) = build_human_hand(&mut deck, skeleton)?;
    let mut human_all = human_concealed.clone();
    human_all.push(draw);

    let plan = self_turn_river_plan(human_wind, &[], gen_range(3, 7));
    let counts = plan.counts;

    // The threat's river ends on the post-chii discard. Its earlier entries
    // stay clear of the human's hand so the same-suit board has no accidental
    // genbutsu, and clear of the threat's own wait so the threat is not furiten.
    let threat_river = build_threat_river(&mut deck, skeleton, &human_all, counts[THREAT_SEAT])?;

    let human_river = deck
        .draw_n(counts[0])
        .ok_or_else(|| "deck exhausted drawing the human river".to_string())?;

    let mut players = Vec::with_capacity(4);
    players.push(human_player(
        human_wind,
        scores[0],
        &human_concealed,
        &draw,
        &human_river,
        &plan,
    ));

    for (seat, name) in [(1usize, "Shimocha"), (2, "Toimen")] {
        let hand = deck
            .draw_n(13)
            .ok_or_else(|| "deck exhausted dealing an opponent".to_string())?;
        let river = deck
            .draw_n(counts[seat])
            .ok_or_else(|| "deck exhausted drawing an opponent river".to_string())?;
        let mut discards = discards_from_tiles(&river);
        force_tedashi(&mut discards, &plan.hand_discards[seat]);

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
            is_riichi: false,
            riichi_discard_index: None,
        });
    }

    players.push(threat_player(
        human_wind,
        scores[THREAT_SEAT],
        skeleton,
        &threat_river,
        &plan,
    ));
    players.sort_by_key(|player| player.seat);

    if players.iter().filter(|player| player.is_human).count() != 1 {
        return Err("the board must have exactly one human".to_string());
    }

    // Keep the answer out of the dora so the lesson never becomes a value
    // question.
    let dora_indicator = draw_dora(&mut deck, skeleton.answer)?;
    let ura_indicator = deck
        .draw()
        .ok_or_else(|| "deck exhausted drawing the ura indicator".to_string())?;

    let tiles_remaining = deck.remaining().saturating_sub(12).min(u8::MAX as usize) as u8;
    if tiles_remaining == 0 {
        return Err("no drawable tiles remain".to_string());
    }

    let mut full_tiles = human_all.clone();
    full_tiles.sort();
    let metrics = evaluate_counts(&to_counts(&full_tiles));
    if metrics.shanten != HUMAN_SHANTEN {
        return Err(format!(
            "the human hand must be {HUMAN_SHANTEN}-away, got {}",
            metrics.shanten
        ));
    }

    let state = GameState {
        category: category.to_string(),
        target_action: TargetAction::Defend,
        correct_action: CorrectAction::fold(skeleton.answer.to_string()),
        equivalent_tiles: Vec::new(),
        decision: DecisionContext::SelfTurn,
        scenario_note: None,
        ai_decision: None,
        riichi_triggers: Vec::new(),
        dama_reasons: Vec::new(),
        shouminkan_triggers: Vec::new(),
        book_rationale: None,
        can_riichi: false,
        hand_string: format_hand_compact(&full_tiles),
        tiles: full_tiles.iter().map(ToString::to_string).collect(),
        shanten: metrics.shanten,
        is_agari: metrics.is_agari,
        decompositions_count: metrics.decompositions_count,
        ukeire_tiles: metrics.ukeire_tiles,
        ukeire_total: metrics.ukeire_total,
        round_wind,
        hand_number,
        honba,
        riichi_sticks: 0,
        dora_indicators: vec![dora_indicator.to_string()],
        ura_dora_indicators: vec![ura_indicator.to_string()],
        tiles_remaining,
        current_turn: 0,
        players,
    };

    validate(&state, skeleton)?;
    Ok(state)
}

/// Takes every structural tile out of the deck. The trap needs one extra copy
/// of the answer for the threat's earlier discard.
fn reserve_threat(deck: &mut Deck, skeleton: &Skeleton) -> Result<(), String> {
    let mut take = |tile: Tile| deck.take(tile);

    for _ in 0..3 {
        take(skeleton.prior_pon)?;
    }
    for &tile in skeleton.prior_chi.iter().chain(skeleton.final_chi.iter()) {
        take(tile)?;
    }
    for &tile in &skeleton.threat_concealed {
        take(tile)?;
    }
    take(skeleton.post_chi)?;
    if skeleton.case == OpenHandCase::DifferentSuit {
        // The answer's other copy is the threat's earlier discard.
        take(skeleton.answer)?;
    }

    Ok(())
}

/// Builds the human's fourteen tiles and picks the drawn tile.
///
/// The shape is two complete sets, one protorun (the answer's block), a pair,
/// and four lone honors: exactly 2-away, so the lesson is a defensive fold and
/// Riichi is never on offer. Discarding the answer breaks the only protorun,
/// which is what makes the fold visible rather than an efficiency move.
fn build_human_hand(deck: &mut Deck, skeleton: &Skeleton) -> Result<(Vec<Tile>, Tile), String> {
    let mut tiles: Vec<Tile> = Vec::with_capacity(14);
    take(deck, &mut tiles, skeleton.answer)?;
    take(deck, &mut tiles, skeleton.block_partner)?;

    let allowed = |tile: Tile| -> bool {
        if tile == skeleton.answer {
            return false;
        }
        match skeleton.case {
            OpenHandCase::SameSuit => !in_open_hand_neighbourhood(tile, skeleton.post_chi),
            // The trap is about the one tempting neighbourhood tile, so the
            // rest of the hand may use any tile except another answer copy.
            OpenHandCase::DifferentSuit => true,
        }
    };

    // Pair.
    let pair = choose_pair(deck, &allowed)
        .ok_or_else(|| "no pair is available for the human hand".to_string())?;
    take_n(deck, &mut tiles, pair, 2)?;

    // Two complete sets.
    for _ in 0..2 {
        let block = choose_set(deck, &allowed)
            .ok_or_else(|| "no complete set is available for the human hand".to_string())?;
        for tile in block {
            take(deck, &mut tiles, tile)?;
        }
    }

    // Four lone honors. Honor singles never form a protorun with anything, so
    // the hand keeps exactly one partial block: the answer's protorun.
    let mut floats: Vec<Tile> = Vec::with_capacity(4);
    for honor in [
        Honor::East,
        Honor::South,
        Honor::West,
        Honor::North,
        Honor::White,
        Honor::Green,
        Honor::Red,
    ] {
        if floats.len() == 4 {
            break;
        }
        let tile = Tile::Honor(honor);
        if tiles.contains(&tile) || !allowed(tile) || !deck.has(tile) {
            continue;
        }
        take(deck, &mut tiles, tile)?;
        floats.push(tile);
    }
    if floats.len() < 4 {
        return Err("not enough honor floats for the human hand".to_string());
    }

    if tiles.len() != 14 {
        return Err(format!("the human hand has {} tiles", tiles.len()));
    }

    let metrics = evaluate_counts(&to_counts(&tiles));
    if metrics.shanten != HUMAN_SHANTEN {
        return Err(format!(
            "the human hand must be {HUMAN_SHANTEN}-away, got {}",
            metrics.shanten
        ));
    }

    // The draw is one of the lone honors, so the answer and its block partner
    // both stay in the concealed hand and the protorun is on screen.
    let draw = choose(&floats).ok_or_else(|| "no tile can be the draw".to_string())?;
    let mut concealed = tiles;
    let index = concealed
        .iter()
        .position(|tile| *tile == draw)
        .ok_or_else(|| "the chosen draw left the hand".to_string())?;
    concealed.remove(index);

    Ok((concealed, draw))
}

/// Chooses a pair tile the filler rules allow.
fn choose_pair<F>(deck: &Deck, allowed: &F) -> Option<Tile>
where
    F: Fn(Tile) -> bool,
{
    let mut candidates: Vec<Tile> = ALL_TILES
        .iter()
        .copied()
        .filter(|tile| allowed(*tile) && deck.count(*tile) >= 2)
        .collect();
    shuffle(&mut candidates);
    candidates.first().copied()
}

/// Chooses a complete run or triplet the filler rules allow.
fn choose_set<F>(deck: &Deck, allowed: &F) -> Option<Vec<Tile>>
where
    F: Fn(Tile) -> bool,
{
    let mut candidates: Vec<Vec<Tile>> = Vec::new();

    for suit in [Suit::Man, Suit::Pin, Suit::Sou] {
        for start in 1..=7u8 {
            let run = vec![
                Tile::suited(suit, start),
                Tile::suited(suit, start + 1),
                Tile::suited(suit, start + 2),
            ];
            if run.iter().all(|tile| allowed(*tile) && deck.has(*tile)) {
                candidates.push(run);
            }
        }
    }

    for &tile in ALL_TILES.iter() {
        if allowed(tile) && deck.count(tile) >= 3 {
            candidates.push(vec![tile, tile, tile]);
        }
    }

    shuffle(&mut candidates);
    candidates.into_iter().next()
}

fn take(deck: &mut Deck, tiles: &mut Vec<Tile>, tile: Tile) -> Result<(), String> {
    deck.take(tile)?;
    tiles.push(tile);
    Ok(())
}

fn take_n(deck: &mut Deck, tiles: &mut Vec<Tile>, tile: Tile, count: u8) -> Result<(), String> {
    for _ in 0..count {
        take(deck, tiles, tile)?;
    }
    Ok(())
}

/// Builds the threat's river, ending on the post-chii discard.
fn build_threat_river(
    deck: &mut Deck,
    skeleton: &Skeleton,
    human_full: &[Tile],
    count: usize,
) -> Result<Vec<Tile>, String> {
    let mut excluded: Vec<Tile> = human_full.to_vec();
    excluded.extend(skeleton.threat_wait.iter().copied());
    excluded.sort();
    excluded.dedup();

    let fixed = if skeleton.case == OpenHandCase::DifferentSuit {
        2
    } else {
        1
    };
    if count < fixed {
        return Err("the threat's river is too short for the lesson".to_string());
    }

    let mut river = deck
        .draw_excluding(count - fixed, &excluded)
        .ok_or_else(|| "deck exhausted drawing the threat river".to_string())?;
    if skeleton.case == OpenHandCase::DifferentSuit {
        // The answer is already on the table: that is what makes it 100% safe.
        river.insert(0, skeleton.answer);
    }
    river.push(skeleton.post_chi);

    Ok(river)
}

fn human_player(
    human_wind: Wind,
    score: i32,
    concealed: &[Tile],
    draw: &Tile,
    river: &[Tile],
    plan: &crate::generator::support::table::RiverPlan,
) -> PlayerState {
    let mut discards = discards_from_tiles(river);
    force_tedashi(&mut discards, &plan.hand_discards[0]);

    PlayerState {
        seat: 0,
        name: "You".to_string(),
        is_human: true,
        wind: human_wind,
        score,
        hand: concealed.iter().map(ToString::to_string).collect(),
        draw: Some(draw.to_string()),
        red_fives: Vec::new(),
        discards,
        melds: Vec::new(),
        is_riichi: false,
        riichi_discard_index: None,
    }
}

fn threat_player(
    human_wind: Wind,
    score: i32,
    skeleton: &Skeleton,
    river: &[Tile],
    plan: &crate::generator::support::table::RiverPlan,
) -> PlayerState {
    let mut discards = discards_from_tiles(river);
    force_tedashi(&mut discards, &plan.hand_discards[THREAT_SEAT]);
    // The post-chii discard is thrown from the hand, never tsumogiri.
    if let Some(last) = discards.last_mut() {
        last.is_tsumogiri = false;
    }

    let previous = (THREAT_SEAT + 3) % 4;
    PlayerState {
        seat: THREAT_SEAT,
        name: "Kamicha".to_string(),
        is_human: false,
        wind: human_wind.next(THREAT_SEAT),
        score,
        hand: skeleton
            .threat_concealed
            .iter()
            .map(ToString::to_string)
            .collect(),
        draw: None,
        red_fives: Vec::new(),
        discards,
        melds: vec![
            // Claimed from the previous seat as well, so the whole set of calls
            // stays inside the natural rotation and the planned rivers match.
            called_meld(MeldType::Pon, vec![skeleton.prior_pon; 3], Some(previous)),
            called_meld(MeldType::Chi, skeleton.prior_chi.clone(), Some(previous)),
            called_meld(MeldType::Chi, skeleton.final_chi.clone(), Some(previous)),
        ],
        is_riichi: false,
        riichi_discard_index: None,
    }
}

fn called_meld(
    meld_type: MeldType,
    mut tiles: Vec<Tile>,
    called_from: Option<usize>,
) -> CalledMeld {
    tiles.sort();
    CalledMeld {
        meld_type,
        tiles: tiles.iter().map(ToString::to_string).collect(),
        called_from,
    }
}

/// Picks a dora indicator whose dora is not the answer.
fn draw_dora(deck: &mut Deck, answer: Tile) -> Result<Tile, String> {
    let mut candidates: Vec<Tile> = ALL_TILES
        .iter()
        .copied()
        .filter(|indicator| deck.has(*indicator) && indicator_to_dora(*indicator) != answer)
        .collect();
    shuffle(&mut candidates);
    let indicator = candidates
        .first()
        .copied()
        .ok_or_else(|| "no legal dora indicator".to_string())?;
    deck.take(indicator)?;
    Ok(indicator)
}

/// Re-derives every structural promise from the finished table.
fn validate(state: &GameState, skeleton: &Skeleton) -> Result<(), String> {
    let human = state
        .players
        .iter()
        .find(|player| player.is_human)
        .ok_or_else(|| "no human player".to_string())?;
    let threat = state
        .players
        .iter()
        .find(|player| player.seat == THREAT_SEAT)
        .ok_or_else(|| "no threat player".to_string())?;

    if !human.melds.is_empty() || human.is_riichi {
        return Err("the defender must be concealed and not in Riichi".to_string());
    }
    if human.hand.len() != 13 || human.draw.is_none() {
        return Err("the defender must hold thirteen tiles plus the draw".to_string());
    }
    if state.shanten != HUMAN_SHANTEN {
        return Err(format!(
            "the defender must be {HUMAN_SHANTEN}-away, got {}",
            state.shanten
        ));
    }

    if threat.melds.len() != 3 {
        return Err(format!(
            "the threat must have three open melds, got {}",
            threat.melds.len()
        ));
    }
    let Some(last_chi) = threat
        .melds
        .iter()
        .rev()
        .find(|meld| meld.meld_type == MeldType::Chi)
    else {
        return Err("the threat's last call must be a chii".to_string());
    };
    let chi_tile = last_chi
        .tiles
        .first()
        .ok_or_else(|| "empty chii meld".to_string())?;
    let chi_suit = Tile::try_from(chi_tile.as_str())
        .map_err(|err| err.to_string())?
        .suit()
        .ok_or_else(|| "the final chii must be suited".to_string())?;
    if chi_suit != skeleton.chi_suit {
        return Err("the final chii suit does not match the skeleton".to_string());
    }

    let post_chi = Tile::try_from(
        threat
            .discards
            .last()
            .ok_or_else(|| "the threat has no discards".to_string())?
            .tile
            .as_str(),
    )
    .map_err(|err| err.to_string())?;
    if post_chi != skeleton.post_chi {
        return Err("the threat's last discard is not the post-chii discard".to_string());
    }

    let answer = Tile::try_from(
        state
            .correct_action
            .tile()
            .ok_or_else(|| "the fold answer must name a tile".to_string())?,
    )
    .map_err(|err| err.to_string())?;
    if answer != skeleton.answer {
        return Err("the answer does not match the skeleton".to_string());
    }

    let human_tiles: Vec<Tile> = human
        .hand
        .iter()
        .chain(human.draw.iter())
        .map(|code| Tile::try_from(code.as_str()).map_err(|err| err.to_string()))
        .collect::<Result<_, _>>()?;

    // The answer's block is on the table.
    let partner = skeleton.block_partner;
    if !human_tiles.contains(&partner) {
        return Err("the answer's block partner must stay in the hand".to_string());
    }
    let (Some(answer_suit), Some(answer_value)) = (answer.suit(), answer.value()) else {
        return Err("the answer must be suited".to_string());
    };
    let (Some(partner_suit), Some(partner_value)) = (partner.suit(), partner.value()) else {
        return Err("the block partner must be suited".to_string());
    };
    if answer_suit != partner_suit || !(1..=2).contains(&answer_value.abs_diff(partner_value)) {
        return Err("the answer must form a protorun with its partner".to_string());
    }

    // The neighbourhood read: same-suit boards have the answer as their only
    // neighbourhood tile; trap boards keep the tempting partner inside it.
    let unique_neighbourhood: Vec<Tile> = unique(human_tiles.iter().copied())
        .into_iter()
        .filter(|tile| in_open_hand_neighbourhood(*tile, post_chi))
        .collect();
    match skeleton.case {
        OpenHandCase::SameSuit => {
            if unique_neighbourhood != vec![answer] {
                return Err(format!(
                    "the same-suit board must have exactly one neighbourhood tile, got {unique_neighbourhood:?}"
                ));
            }
        }
        OpenHandCase::DifferentSuit => {
            if in_open_hand_neighbourhood(answer, post_chi) {
                return Err("the trap answer must sit outside the neighbourhood".to_string());
            }
            if !in_open_hand_neighbourhood(partner, post_chi) {
                return Err("the trap tile must sit inside the neighbourhood".to_string());
            }
        }
    }

    // Genbutsu bookkeeping: same-suit boards have none; trap boards have
    // exactly the answer.
    let threat_river: Vec<Tile> = threat
        .discards
        .iter()
        .map(|discard| Tile::try_from(discard.tile.as_str()).map_err(|err| err.to_string()))
        .collect::<Result<_, _>>()?;
    let held: Vec<Tile> = unique(human_tiles.iter().copied());
    let genbutsu: Vec<Tile> = held
        .iter()
        .copied()
        .filter(|tile| threat_river.contains(tile))
        .collect();
    match skeleton.case {
        OpenHandCase::SameSuit if !genbutsu.is_empty() => {
            return Err(format!(
                "the same-suit board must hold no genbutsu, found {genbutsu:?}"
            ));
        }
        OpenHandCase::DifferentSuit if genbutsu != vec![answer] => {
            return Err(format!(
                "the trap board's only genbutsu must be the answer, found {genbutsu:?}"
            ));
        }
        _ => {}
    }

    // The threat really is tenpai, and its wait is where the case says.
    let concealed: Vec<Tile> = threat
        .hand
        .iter()
        .map(|code| Tile::try_from(code.as_str()).map_err(|err| err.to_string()))
        .collect::<Result<_, _>>()?;
    let shanten = calculate_shanten_with_melds(&to_counts(&concealed), 3).shanten;
    if shanten != 0 {
        return Err(format!("the threat must be tenpai, got shanten {shanten}"));
    }
    let waits: Vec<Tile> = calculate_ukeire_with_melds(&to_counts(&concealed), 3)
        .tiles
        .iter()
        .map(|wait| wait.tile)
        .collect();
    match skeleton.case {
        OpenHandCase::SameSuit => {
            if waits
                .iter()
                .any(|tile| in_open_hand_neighbourhood(*tile, post_chi))
            {
                return Err("the threat must not wait in the neighbourhood".to_string());
            }
        }
        OpenHandCase::DifferentSuit => {
            if waits.is_empty()
                || waits
                    .iter()
                    .any(|tile| !in_open_hand_neighbourhood(*tile, post_chi))
            {
                return Err("the threat must wait inside the neighbourhood".to_string());
            }
            if !waits.contains(&partner) {
                return Err("the trap tile must be one of the threat's waits".to_string());
            }
        }
    }

    if !state.equivalent_tiles.is_empty() {
        return Err("this lesson has one exact answer".to_string());
    }
    crate::generator::support::state_validation::validate_reachable_state(state)?;

    Ok(())
}

fn unique(tiles: impl IntoIterator<Item = Tile>) -> Vec<Tile> {
    let mut unique: Vec<Tile> = tiles.into_iter().collect();
    unique.sort();
    unique.dedup();
    unique
}

#[cfg(test)]
mod tests {
    use super::super::generate;
    use super::*;
    use crate::state::CorrectActionType;

    fn answer_tile(state: &GameState) -> Tile {
        Tile::try_from(state.correct_action.tile().expect("answer tile"))
            .expect("answer must parse")
    }

    fn threat(state: &GameState) -> &PlayerState {
        state
            .players
            .iter()
            .find(|player| player.seat == THREAT_SEAT)
            .expect("threat player")
    }

    fn human(state: &GameState) -> &PlayerState {
        state
            .players
            .iter()
            .find(|player| player.is_human)
            .expect("human player")
    }

    fn assert_board(state: &GameState) {
        assert_eq!(state.category, "open_hand_defense");
        assert_eq!(state.target_action, TargetAction::Defend);
        assert_eq!(state.correct_action.action_type(), CorrectActionType::Fold);
        assert_eq!(state.players.len(), 4);
        assert_eq!(state.riichi_sticks, 0);
        assert_eq!(state.dora_indicators.len(), 1);
        assert_eq!(state.ura_dora_indicators.len(), 1);
        assert!(state.tiles_remaining > 0);
        assert_eq!(state.current_turn, 0);
        assert_eq!(state.decision, DecisionContext::SelfTurn);

        let human = human(state);
        assert!(human.is_human);
        assert_eq!(human.hand.len(), 13);
        assert!(human.draw.is_some());
        assert!(human.melds.is_empty());
        assert!(!human.is_riichi);
        assert_eq!(state.tiles.len(), 14);
        assert_eq!(state.shanten, HUMAN_SHANTEN);
        assert!(!state.is_agari);

        let answer = answer_tile(state);
        let human_tiles: Vec<Tile> = human
            .hand
            .iter()
            .chain(human.draw.iter())
            .map(|code| Tile::try_from(code.as_str()).expect("tile"))
            .collect();
        assert!(human_tiles.contains(&answer));
        assert_ne!(
            Some(answer.to_string()),
            human.draw,
            "the answer is a hand discard, so the fold is visible"
        );

        let threat = threat(state);
        assert!(!threat.is_riichi);
        assert_eq!(threat.melds.len(), 3);
        assert_eq!(
            threat
                .melds
                .iter()
                .filter(|meld| meld.meld_type == MeldType::Chi)
                .count(),
            2
        );
        assert_eq!(threat.hand.len(), 4);
        assert_eq!(
            threat
                .melds
                .iter()
                .rev()
                .find(|meld| meld.meld_type == MeldType::Chi)
                .expect("last chii")
                .meld_type,
            MeldType::Chi
        );

        let post_chi = Tile::try_from(threat.discards.last().expect("discard").tile.as_str())
            .expect("post-chi tile");
        let chi_suit = Tile::try_from(
            threat
                .melds
                .iter()
                .rev()
                .find(|meld| meld.meld_type == MeldType::Chi)
                .expect("last chii")
                .tiles[0]
                .as_str(),
        )
        .expect("chi tile")
        .suit()
        .expect("suited");

        let same_suit = chi_suit == post_chi.suit().expect("suited");
        let neighbourhood: Vec<Tile> = unique(human_tiles.iter().copied())
            .into_iter()
            .filter(|tile| in_open_hand_neighbourhood(*tile, post_chi))
            .collect();

        if same_suit {
            assert_eq!(
                neighbourhood,
                vec![answer],
                "the same-suit answer is the unique neighbourhood tile"
            );
        } else {
            assert!(
                !in_open_hand_neighbourhood(answer, post_chi),
                "the trap answer is outside the dangerous neighbourhood"
            );
            assert!(
                !neighbourhood.is_empty(),
                "the trap must show a tempting tile in the neighbourhood"
            );
            assert!(!neighbourhood.contains(&answer));
        }

        let threat_tiles: Vec<Tile> = threat
            .discards
            .iter()
            .map(|discard| Tile::try_from(discard.tile.as_str()).expect("tile"))
            .collect();
        let genbutsu: Vec<Tile> = unique(human_tiles.iter().copied())
            .into_iter()
            .filter(|tile| threat_tiles.contains(tile))
            .collect();
        if same_suit {
            assert!(genbutsu.is_empty(), "the same-suit board has no genbutsu");
        } else {
            assert_eq!(
                genbutsu,
                vec![answer],
                "the trap answer is the only genbutsu"
            );
        }

        // The threat is tenpai with three melds, and the wait is where the
        // book's read says it is.
        let concealed: Vec<Tile> = threat
            .hand
            .iter()
            .map(|code| Tile::try_from(code.as_str()).expect("tile"))
            .collect();
        assert_eq!(
            calculate_shanten_with_melds(&to_counts(&concealed), 3).shanten,
            0
        );
        let waits: Vec<Tile> = calculate_ukeire_with_melds(&to_counts(&concealed), 3)
            .tiles
            .iter()
            .map(|wait| wait.tile)
            .collect();
        assert!(!waits.is_empty());
        if same_suit {
            assert!(
                waits
                    .iter()
                    .all(|tile| !in_open_hand_neighbourhood(*tile, post_chi))
            );
            assert!(
                !waits.contains(&answer),
                "the safe answer must not be a winning tile"
            );
        } else {
            assert!(
                waits
                    .iter()
                    .all(|tile| in_open_hand_neighbourhood(*tile, post_chi))
            );
            assert!(
                waits
                    .iter()
                    .any(|wait| *wait != answer && human_tiles.contains(wait)),
                "the trap must hold a live winning tile as its tempting discard"
            );
        }

        let total_score: i32 = state.players.iter().map(|player| player.score).sum();
        assert_eq!(total_score, 100_000);

        let mut expected: Vec<String> = human.hand.clone();
        expected.push(human.draw.clone().expect("draw"));
        expected.sort();
        let mut actual = state.tiles.clone();
        actual.sort();
        assert_eq!(actual, expected);
    }

    #[test]
    fn test_generate_open_hand_defense() {
        let state = generate("open_hand_defense").expect("generation must succeed");
        assert_board(&state);
    }

    #[test]
    fn test_open_hand_defense_constraints_100_runs() {
        let start = std::time::Instant::now();
        for run in 0..100 {
            let state = generate("open_hand_defense")
                .unwrap_or_else(|err| panic!("run {run} failed: {err}"));
            assert_board(&state);
        }
        let elapsed = start.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(15),
            "100 generations took {elapsed:?}"
        );
    }

    #[test]
    fn both_book_cases_are_generated() {
        let mut same_suit = 0;
        let mut different_suit = 0;
        for _ in 0..200 {
            let state = generate("open_hand_defense").expect("generate");
            let threat = threat(&state);
            let chi_suit = Tile::try_from(
                threat
                    .melds
                    .iter()
                    .rev()
                    .find(|meld| meld.meld_type == MeldType::Chi)
                    .expect("last chii")
                    .tiles[0]
                    .as_str(),
            )
            .expect("chi tile")
            .suit()
            .expect("suited");
            let post_chi = Tile::try_from(threat.discards.last().expect("discard").tile.as_str())
                .expect("tile");
            if chi_suit == post_chi.suit().expect("suited") {
                same_suit += 1;
            } else {
                different_suit += 1;
            }
        }
        assert!(same_suit > 20, "same-suit case appeared {same_suit} times");
        assert!(
            different_suit > 20,
            "different-suit trap appeared {different_suit} times"
        );
    }
}
