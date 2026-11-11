use agari::parse::to_counts;
use agari::shanten::calculate_shanten;
use agari::tile::{Honor, Suit, Tile};

use crate::generator::support::analysis::evaluate_hand;
use crate::generator::support::deck::{ALL_TILES, Deck};
use crate::generator::support::format::format_hand_compact;
use crate::generator::support::table::{
    dealer_seat, discards_from_tiles, force_tedashi, plan_rivers, random_round, random_table_scores,
};
use crate::rng::{choose, gen_range};
use crate::state::{CorrectAction, DecisionContext, GameState, PlayerState, TargetAction, Wind};

/// Build a reaction candidate: chi, pon, daiminkan, or ron.
pub fn build_candidate(category: &str) -> Result<GameState, String> {
    let mut last_error = String::new();
    for _ in 0..40 {
        match try_build(category) {
            Ok(state) => return Ok(state),
            Err(err) => last_error = err,
        }
    }
    Err(format!(
        "failed to build a reaction candidate after 40 attempts: {last_error}"
    ))
}

fn try_build(category: &str) -> Result<GameState, String> {
    let family = gen_range(0, 5);
    match family {
        0 => build_chi(category),
        1 => build_pon(category),
        2 => build_daiminkan(category),
        3 => build_ron(category),
        _ => build_chankan(category),
    }
}

fn build_chi(category: &str) -> Result<GameState, String> {
    let mut deck = Deck::fresh();
    let suited: Vec<Tile> = ALL_TILES
        .iter()
        .copied()
        .filter(|tile| tile.suit().is_some())
        .collect();
    for _ in 0..50 {
        let claimed = choose(&suited).expect("suited tiles exist");
        let Some(index) = tile_index(&claimed) else {
            continue;
        };
        let value = index % 9 + 1;
        let mut options: Vec<[usize; 2]> = Vec::new();
        if value <= 7 {
            options.push([index + 1, index + 2]);
        }
        if (2..=8).contains(&value) {
            options.push([index - 1, index + 1]);
        }
        if value >= 3 {
            options.push([index - 2, index - 1]);
        }
        let Some(option) = choose(&options) else {
            continue;
        };
        let consumed: Vec<Tile> = option
            .iter()
            .filter_map(|&tile_index| tile_from_index(tile_index))
            .collect();
        if consumed.len() != 2 {
            continue;
        }
        if consumed.iter().any(|tile| deck.count(*tile) == 0) {
            continue;
        }
        if deck.count(claimed) == 0 {
            continue;
        }
        deck.take(claimed)?;
        for tile in &consumed {
            deck.take(*tile)?;
        }
        return assemble(category, &mut deck, 3, claimed, consumed, None);
    }
    Err("could not deal a chi shape".to_string())
}

fn build_pon(category: &str) -> Result<GameState, String> {
    build_matching_call(category, 2, 3)
}

fn build_daiminkan(category: &str) -> Result<GameState, String> {
    build_matching_call(category, 3, 4)
}

fn build_matching_call(
    category: &str,
    hand_copies: usize,
    needed_copies: u8,
) -> Result<GameState, String> {
    let mut deck = Deck::fresh();
    for _ in 0..50 {
        let candidates: Vec<Tile> = ALL_TILES
            .iter()
            .copied()
            .filter(|tile| deck.count(*tile) >= needed_copies)
            .collect();
        let Some(claimed) = choose(&candidates) else {
            continue;
        };
        deck.take(claimed)?;
        let mut matching = Vec::new();
        for _ in 0..hand_copies {
            if deck.take(claimed).is_err() {
                matching.clear();
                break;
            }
            matching.push(claimed);
        }
        if matching.len() != hand_copies {
            continue;
        }
        let from = 1 + gen_range(0, 3);
        return assemble(category, &mut deck, from, claimed, matching, None);
    }
    Err("could not deal a matching call".to_string())
}

fn build_ron(category: &str) -> Result<GameState, String> {
    let mut deck = Deck::fresh();
    for _ in 0..80 {
        let (hand, claimed, waits) = match build_ron_shape(&mut deck) {
            Ok(shape) => shape,
            Err(_) => {
                deck = Deck::fresh();
                continue;
            }
        };
        let from = 1 + gen_range(0, 3);
        return assemble_with_waits(category, &mut deck, from, claimed, hand, waits, false);
    }
    Err("could not deal a ron shape".to_string())
}

fn build_chankan(category: &str) -> Result<GameState, String> {
    let mut deck = Deck::fresh();
    for _ in 0..80 {
        let (hand, claimed, waits) = match build_ron_shape(&mut deck) {
            Ok(shape) => shape,
            Err(_) => {
                deck = Deck::fresh();
                continue;
            }
        };
        let from = 1 + gen_range(0, 3);
        return assemble_with_waits(category, &mut deck, from, claimed, hand, waits, true);
    }
    Err("could not deal a chankan shape".to_string())
}

/// Build a complete 14-tile winning hand with a dragon yaku.
pub(super) fn build_complete_hand() -> Result<Vec<Tile>, String> {
    let mut deck = Deck::fresh();
    for _ in 0..80 {
        if let Ok((mut hand, claimed, _)) = build_ron_shape(&mut deck) {
            hand.push(claimed);
            return Ok(hand);
        }
        deck = Deck::fresh();
    }
    Err("could not build a complete hand".to_string())
}

fn build_ron_shape(deck: &mut Deck) -> Result<(Vec<Tile>, Tile, Vec<Tile>), String> {
    let dragons = [
        Tile::Honor(Honor::White),
        Tile::Honor(Honor::Green),
        Tile::Honor(Honor::Red),
    ];
    let pairs = [
        Tile::suited(Suit::Man, 1),
        Tile::suited(Suit::Man, 9),
        Tile::suited(Suit::Pin, 1),
        Tile::suited(Suit::Pin, 9),
        Tile::suited(Suit::Sou, 1),
        Tile::suited(Suit::Sou, 9),
        Tile::Honor(Honor::East),
        Tile::Honor(Honor::South),
        Tile::Honor(Honor::North),
    ];
    let dragon = choose(&dragons).expect("dragons");
    let pair = choose(&pairs).expect("pairs");

    let mut sequences: Vec<[Tile; 3]> = Vec::new();
    for _ in 0..3 {
        let suit = match gen_range(0, 3) {
            0 => Suit::Man,
            1 => Suit::Pin,
            _ => Suit::Sou,
        };
        let start = gen_range(1, 8) as u8;
        sequences.push([
            Tile::suited(suit, start),
            Tile::suited(suit, start + 1),
            Tile::suited(suit, start + 2),
        ]);
    }

    let mut complete: Vec<Tile> = vec![dragon; 3];
    for sequence in &sequences {
        complete.extend(sequence);
    }
    complete.extend([pair; 2]);

    let mut counts: std::collections::HashMap<Tile, u8> = std::collections::HashMap::new();
    for &tile in &complete {
        *counts.entry(tile).or_insert(0) += 1;
    }
    for (tile, count) in &counts {
        if *count > 4 {
            return Err("ron shape needs more than four copies".to_string());
        }
        if deck.count(*tile) < *count {
            return Err("ron shape is not available in the deck".to_string());
        }
    }
    for (tile, count) in &counts {
        deck.take_n(*tile, *count)?;
    }

    // Remove a middle tile from one sequence; that becomes the ron tile.
    let sequence_index = gen_range(0, sequences.len());
    let claimed = sequences[sequence_index][1];
    let Some(position) = complete.iter().position(|tile| *tile == claimed) else {
        return Err("could not find the ron tile".to_string());
    };
    complete.remove(position);
    if complete.contains(&claimed) {
        return Err("ron tile is duplicated in the concealed hand".to_string());
    }

    let shanten = calculate_shanten(&to_counts(&complete)).shanten;
    if shanten != 0 {
        return Err(format!("ron shape is {shanten}-shanten after removal"));
    }
    let waits = calculate_waits(&complete);
    if !waits.contains(&claimed) {
        return Err("removed tile is not a wait".to_string());
    }
    Ok((complete, claimed, waits))
}

fn calculate_waits(hand: &[Tile]) -> Vec<Tile> {
    let counts = to_counts(hand);
    agari::shanten::calculate_ukeire(&counts)
        .tiles
        .iter()
        .map(|ukeire| ukeire.tile)
        .collect()
}

fn assemble(
    category: &str,
    deck: &mut Deck,
    from: usize,
    claimed: Tile,
    matching: Vec<Tile>,
    waits: Option<Vec<Tile>>,
) -> Result<GameState, String> {
    assemble_with_waits(
        category,
        deck,
        from,
        claimed,
        matching,
        waits.unwrap_or_default(),
        false,
    )
}

fn assemble_with_waits(
    category: &str,
    deck: &mut Deck,
    from: usize,
    claimed: Tile,
    mut hand: Vec<Tile>,
    waits: Vec<Tile>,
    chankan: bool,
) -> Result<GameState, String> {
    while hand.len() < 13 {
        let tile = deck
            .draw()
            .ok_or_else(|| "deck ran out while filling the reaction hand".to_string())?;
        hand.push(tile);
    }
    if hand.len() != 13 {
        return Err("reaction hand is not thirteen tiles".to_string());
    }
    hand.sort();

    let mut excluded: Vec<Tile> = hand.clone();
    excluded.push(claimed);
    excluded.extend(waits.iter().copied());

    // A chankan shows the source's completed kan (four copies of the tile).
    // `build_ron_shape` already reserved one copy as the winning tile.
    if chankan {
        deck.take_n(claimed, 3)?;
    }

    let (round_wind, hand_number) = random_round();
    let scores = random_table_scores();
    let human_wind = Wind::ALL[gen_range(0, 4)];
    let min_river = gen_range(3, 10).max(2);
    // One legal timeline fixes every river length. A regular reaction ends on
    // the source's discard; a chankan happens after the source draws, which
    // follows their Kamicha's discard.
    let plan = if chankan {
        plan_rivers(dealer_seat(human_wind), (from + 3) % 4, &[], min_river)
    } else {
        plan_rivers(dealer_seat(human_wind), from, &[], min_river)
    };
    let counts = plan.counts;

    let human_river = deck
        .draw_excluding(counts[0], &excluded)
        .ok_or_else(|| "deck ran out while dealing the human river".to_string())?;

    let mut players = Vec::with_capacity(4);
    players.push(PlayerState {
        seat: 0,
        name: "You".to_string(),
        is_human: true,
        wind: human_wind,
        score: scores[0],
        hand: hand.iter().map(|tile| tile.to_string()).collect(),
        draw: None,
        red_fives: Vec::new(),
        discards: {
            let mut discards = discards_from_tiles(&human_river);
            force_tedashi(&mut discards, &plan.hand_discards[0]);
            discards
        },
        melds: Vec::new(),
        is_riichi: false,
        riichi_discard_index: None,
    });

    for (seat, score) in (1..=3).zip(scores.iter().skip(1)) {
        // A kan meld costs three concealed tiles: the fourth tile is the
        // replacement draw, not a 14th hand tile.
        let concealed_count = if seat == from && chankan { 10 } else { 13 };
        let concealed = deck
            .draw_n(concealed_count)
            .ok_or_else(|| "deck ran out while dealing an opponent".to_string())?;
        let river = if seat == from && !chankan {
            let mut river = deck
                .draw_n(counts[seat] - 1)
                .ok_or_else(|| "deck ran out while dealing the claim river".to_string())?;
            river.push(claimed);
            river
        } else {
            deck.draw_n(counts[seat])
                .ok_or_else(|| "deck ran out while dealing an opponent river".to_string())?
        };
        let melds = if seat == from && chankan {
            vec![crate::state::CalledMeld {
                meld_type: crate::state::MeldType::Kan,
                tiles: vec![claimed.to_string(); 4],
                called_from: Some(0),
            }]
        } else {
            Vec::new()
        };
        players.push(PlayerState {
            seat,
            name: match seat {
                1 => "Shimocha",
                2 => "Toimen",
                _ => "Kamicha",
            }
            .to_string(),
            is_human: false,
            wind: human_wind.next(seat),
            score: *score,
            hand: concealed.iter().map(|tile| tile.to_string()).collect(),
            draw: None,
            red_fives: Vec::new(),
            discards: {
                let mut discards = discards_from_tiles(&river);
                force_tedashi(&mut discards, &plan.hand_discards[seat]);
                discards
            },
            melds,
            is_riichi: false,
            riichi_discard_index: None,
        });
    }

    let mut dead_wall = deck
        .draw_n(14)
        .ok_or_else(|| "deck ran out while dealing the dead wall".to_string())?;
    let dora = dead_wall.remove(0);
    let ura = dead_wall.remove(0);
    let metrics = evaluate_hand(&hand);
    let hand_string = format_hand_compact(&hand);
    let tile_strings: Vec<String> = hand.iter().map(|tile| tile.to_string()).collect();

    let state = GameState {
        category: category.to_string(),
        target_action: TargetAction::Best,
        correct_action: CorrectAction::best("Pass", None, Vec::new(), "Pending"),
        equivalent_tiles: Vec::new(),
        decision: if chankan {
            DecisionContext::ReactToKan {
                from,
                tile: claimed.to_string(),
            }
        } else {
            DecisionContext::ReactToDiscard {
                from,
                tile: claimed.to_string(),
            }
        },
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
        is_agari: false,
        decompositions_count: metrics.decompositions_count,
        ukeire_tiles: metrics.ukeire_tiles,
        ukeire_total: metrics.ukeire_total,
        round_wind,
        hand_number,
        honba: gen_range(0, 4) as u8,
        riichi_sticks: gen_range(0, 3) as u8,
        dora_indicators: vec![dora.to_string()],
        ura_dora_indicators: vec![ura.to_string()],
        tiles_remaining: deck.remaining() as u8,
        current_turn: from,
        players,
    };

    super::validate::validate_reaction_candidate(&state)?;
    Ok(state)
}

fn tile_index(tile: &Tile) -> Option<usize> {
    // Use the trainer string form so the mapping stays in one place.
    crate::ai::encoder::tile_index(&tile.to_string())
}

fn tile_from_index(index: usize) -> Option<Tile> {
    let name = crate::ai::encoder::tile_name(index)?;
    agari::parse::parse_hand(&name).ok()?.into_iter().next()
}
