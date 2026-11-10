use std::collections::HashMap;

use agari::context::{GameContext, WinType, indicator_to_dora};
use agari::hand::{HandStructure, Meld, decompose_hand, decompose_hand_with_melds};
use agari::parse::{to_counts, validate_hand};
use agari::scoring::{ScoreLevel, calculate_score};
use agari::shanten::{calculate_shanten, calculate_ukeire};
use agari::tile::{Honor, Suit, Tile};
use agari::yaku::{Yaku, detect_yaku_with_context};

use crate::rng::{choose, gen_bool, gen_range, shuffle};
use crate::state::{
    CalledMeld, CorrectAction, DamaReason, DiscardTile, GameState, MeldType, PlayerState,
    RiichiTrigger, ShouminkanTrigger, TargetAction, Wind,
};

pub type PuzzleResponse = GameState;

/// All 34 standard Mahjong tile types.
pub const ALL_TILES: [Tile; 34] = [
    // Manzu (Characters)
    Tile::Suited {
        suit: Suit::Man,
        value: 1,
    },
    Tile::Suited {
        suit: Suit::Man,
        value: 2,
    },
    Tile::Suited {
        suit: Suit::Man,
        value: 3,
    },
    Tile::Suited {
        suit: Suit::Man,
        value: 4,
    },
    Tile::Suited {
        suit: Suit::Man,
        value: 5,
    },
    Tile::Suited {
        suit: Suit::Man,
        value: 6,
    },
    Tile::Suited {
        suit: Suit::Man,
        value: 7,
    },
    Tile::Suited {
        suit: Suit::Man,
        value: 8,
    },
    Tile::Suited {
        suit: Suit::Man,
        value: 9,
    },
    // Pinzu (Dots)
    Tile::Suited {
        suit: Suit::Pin,
        value: 1,
    },
    Tile::Suited {
        suit: Suit::Pin,
        value: 2,
    },
    Tile::Suited {
        suit: Suit::Pin,
        value: 3,
    },
    Tile::Suited {
        suit: Suit::Pin,
        value: 4,
    },
    Tile::Suited {
        suit: Suit::Pin,
        value: 5,
    },
    Tile::Suited {
        suit: Suit::Pin,
        value: 6,
    },
    Tile::Suited {
        suit: Suit::Pin,
        value: 7,
    },
    Tile::Suited {
        suit: Suit::Pin,
        value: 8,
    },
    Tile::Suited {
        suit: Suit::Pin,
        value: 9,
    },
    // Souzu (Bamboo)
    Tile::Suited {
        suit: Suit::Sou,
        value: 1,
    },
    Tile::Suited {
        suit: Suit::Sou,
        value: 2,
    },
    Tile::Suited {
        suit: Suit::Sou,
        value: 3,
    },
    Tile::Suited {
        suit: Suit::Sou,
        value: 4,
    },
    Tile::Suited {
        suit: Suit::Sou,
        value: 5,
    },
    Tile::Suited {
        suit: Suit::Sou,
        value: 6,
    },
    Tile::Suited {
        suit: Suit::Sou,
        value: 7,
    },
    Tile::Suited {
        suit: Suit::Sou,
        value: 8,
    },
    Tile::Suited {
        suit: Suit::Sou,
        value: 9,
    },
    // Honors: Winds
    Tile::Honor(Honor::East),
    Tile::Honor(Honor::South),
    Tile::Honor(Honor::West),
    Tile::Honor(Honor::North),
    // Honors: Dragons
    Tile::Honor(Honor::White),
    Tile::Honor(Honor::Green),
    Tile::Honor(Honor::Red),
];

/// Builds a fresh 136-tile deck with four copies of every tile.
fn fresh_deck() -> HashMap<Tile, u8> {
    ALL_TILES.iter().map(|&tile| (tile, 4)).collect()
}

/// The constructed parts of a "Ryanmen protorun + 1" hand.
struct RyanmenSkeleton {
    /// All 14 tiles for evaluation, including the open Yakuhai meld.
    full_tiles: Vec<Tile>,
    /// The 11 concealed tiles before the duplicate is discarded.
    concealed_tiles: Vec<Tile>,
    /// The three-tile shape (XXY or XYY).
    shape_tiles: [Tile; 3],
    /// The two tiles that complete the ryanmen.
    wait_tiles: [Tile; 2],
    /// The three tiles of the open Yakuhai meld.
    open_meld_tiles: Vec<Tile>,
    /// The duplicate tile that should be discarded.
    correct_tile: Tile,
}

/// The set of heuristics that make Riichi correct for one chiitoitsu puzzle.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct RiichiTriggerSet {
    dealer: bool,
    tanyao: bool,
    red_five_wait: bool,
    suji_trap: bool,
    wait_outside_456: bool,
    score_below_mangan: bool,
}

impl RiichiTriggerSet {
    fn any(self) -> bool {
        self.dealer
            || self.tanyao
            || self.red_five_wait
            || self.suji_trap
            || self.wait_outside_456
            || self.score_below_mangan
    }

    fn to_vec(self) -> Vec<RiichiTrigger> {
        let mut triggers = Vec::new();
        if self.dealer {
            triggers.push(RiichiTrigger::Dealer);
        }
        if self.tanyao {
            triggers.push(RiichiTrigger::Tanyao);
        }
        if self.red_five_wait {
            triggers.push(RiichiTrigger::RedFiveWait);
        }
        if self.suji_trap {
            triggers.push(RiichiTrigger::SujiTrap);
        }
        if self.wait_outside_456 {
            triggers.push(RiichiTrigger::WaitOutside456);
        }
        if self.score_below_mangan {
            triggers.push(RiichiTrigger::ScoreBelowMangan);
        }
        triggers
    }
}

/// Whether a chiitoitsu puzzle asks for Riichi or a dama declaration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChiitoitsuDecision {
    Riichi,
    Dama,
}

/// A six-pair chiitoitsu hand before the extra singleton is discarded.
struct ChiitoitsuSkeleton {
    /// Six distinct pair tiles.
    pairs: Vec<Tile>,
    /// The singleton that stays in hand and becomes the winning wait.
    wait_tile: Tile,
    /// The unwanted singleton that should be discarded.
    discard_tile: Tile,
    /// Whether the correct answer is Riichi or dama.
    decision: ChiitoitsuDecision,
    /// Whether the wait singleton is a red five (Riichi path only).
    red_five_wait: bool,
    /// Heuristics that justify Riichi (empty on the dama path).
    triggers: RiichiTriggerSet,
    /// Dama path: two pair tiles that are made dora by the indicators.
    dora_pairs: Vec<Tile>,
}

impl ChiitoitsuSkeleton {
    /// Full 14-tile hand before the discard (six pairs + two singletons).
    fn full_tiles(&self) -> Vec<Tile> {
        let mut tiles = Vec::with_capacity(14);
        for &pair in &self.pairs {
            tiles.push(pair);
            tiles.push(pair);
        }
        tiles.push(self.wait_tile);
        tiles.push(self.discard_tile);
        tiles
    }

    /// The 13-tile tenpai hand after discarding the unwanted singleton.
    fn tenpai_tiles(&self) -> Vec<Tile> {
        let mut tiles = Vec::with_capacity(13);
        for &pair in &self.pairs {
            tiles.push(pair);
            tiles.push(pair);
        }
        tiles.push(self.wait_tile);
        tiles
    }
}

/// The set of heuristics that make an Added Kan correct for one puzzle.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct ShouminkanTriggerSet {
    good_wait_and_value: bool,
    late_game: bool,
    placement_desperation: bool,
    losing_badly: bool,
}

impl ShouminkanTriggerSet {
    fn any(self) -> bool {
        self.good_wait_and_value
            || self.late_game
            || self.placement_desperation
            || self.losing_badly
    }

    fn to_vec(self) -> Vec<ShouminkanTrigger> {
        let mut triggers = Vec::new();
        if self.good_wait_and_value {
            triggers.push(ShouminkanTrigger::GoodWaitAndValue);
        }
        if self.late_game {
            triggers.push(ShouminkanTrigger::LateGame);
        }
        if self.placement_desperation {
            triggers.push(ShouminkanTrigger::PlacementDesperation);
        }
        if self.losing_badly {
            triggers.push(ShouminkanTrigger::LosingBadly);
        }
        triggers
    }
}

/// Whether the supplied wait completes with two or three winning tiles.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShouminkanWaitShape {
    Ryanmen,
    ThreeSided,
}

/// The constructed parts of an Added Kan hand.
struct ShouminkanSkeleton {
    /// The three tiles already called as an open Pon.
    open_pon_tiles: Vec<Tile>,
    /// The fourth copy of the Pon tile, currently drawn.
    drawn_tile: Tile,
    /// The ten concealed tiles left after discarding the drawn tile.
    concealed_tiles: Vec<Tile>,
    /// Winning tiles for the tenpai hand (2 for ryanmen, 3 for three-sided).
    wait_tiles: Vec<Tile>,
}

impl ShouminkanSkeleton {
    /// The fourteen visible tiles: concealed hand + draw + open Pon.
    fn full_tiles(&self) -> Vec<Tile> {
        let mut tiles = Vec::with_capacity(14);
        tiles.extend(self.concealed_tiles.iter().copied());
        tiles.push(self.drawn_tile);
        tiles.extend(self.open_pon_tiles.iter().copied());
        tiles
    }
}

/// Removes one copy of `tile` from the deck, failing if none remain.
fn remove_tile(deck: &mut HashMap<Tile, u8>, tile: &Tile) -> Result<(), String> {
    match deck.get_mut(tile) {
        Some(count) if *count > 0 => {
            *count -= 1;
            Ok(())
        }
        _ => Err(format!("Tile {tile} is unavailable in the deck")),
    }
}

/// Draws a random available tile from the deck.
fn draw_tile(deck: &mut HashMap<Tile, u8>) -> Option<Tile> {
    let available: Vec<Tile> = ALL_TILES
        .iter()
        .copied()
        .filter(|tile| deck.get(tile).copied().unwrap_or(0) > 0)
        .collect();
    let tile = choose(&available)?;
    *deck.get_mut(&tile)? -= 1;
    Some(tile)
}

/// Draws `count` random tiles from the deck.
fn draw_tiles(deck: &mut HashMap<Tile, u8>, count: usize) -> Option<Vec<Tile>> {
    let mut tiles = Vec::with_capacity(count);
    for _ in 0..count {
        tiles.push(draw_tile(deck)?);
    }
    Some(tiles)
}

/// Draws `count` random tiles while never selecting an excluded tile.
fn draw_tiles_excluding(
    deck: &mut HashMap<Tile, u8>,
    count: usize,
    excluded: &[Tile],
) -> Option<Vec<Tile>> {
    let mut tiles = Vec::with_capacity(count);
    for _ in 0..count {
        let available: Vec<Tile> = ALL_TILES
            .iter()
            .copied()
            .filter(|tile| !excluded.contains(tile) && deck.get(tile).copied().unwrap_or(0) > 0)
            .collect();
        let tile = choose(&available)?;
        *deck.get_mut(&tile)? -= 1;
        tiles.push(tile);
    }
    Some(tiles)
}

/// Converts tiles into river entries, randomizing tsumogiri flags.
fn discards_from_tiles(tiles: &[Tile]) -> Vec<DiscardTile> {
    tiles
        .iter()
        .map(|&tile| {
            if gen_bool(0.25) {
                DiscardTile::tsumogiri(tile.to_string())
            } else {
                DiscardTile::new(tile.to_string())
            }
        })
        .collect()
}

/// Picks a round that is South 2 or earlier.
fn random_round() -> (Wind, u8) {
    let index = gen_range(0, 6);
    if index < 4 {
        (Wind::East, index as u8 + 1)
    } else {
        (Wind::South, index as u8 - 3)
    }
}

/// Four plausible scores that sum to 100,000.
fn random_table_scores() -> [i32; 4] {
    loop {
        let mut scores = [0i32; 4];
        let mut total = 0;
        for score in scores.iter_mut().take(3) {
            *score = 15_000 + 1_000 * gen_range(0, 16) as i32;
            total += *score;
        }
        let last = 100_000 - total;
        if (10_000..=40_000).contains(&last) {
            scores[3] = last;
            return scores;
        }
    }
}

/// Turns rank-ordered scores into seat-ordered scores with the human first.
fn scores_for_seats(ranked: [i32; 4], human_rank: usize) -> [i32; 4] {
    let mut opponents: Vec<i32> = ranked
        .iter()
        .enumerate()
        .filter(|(index, _)| *index != human_rank)
        .map(|(_, score)| *score)
        .collect();
    shuffle(&mut opponents);

    [ranked[human_rank], opponents[0], opponents[1], opponents[2]]
}

/// Rank-ordered scores where the human is 2nd or 3rd, close behind.
fn placement_desperation_ranked_scores(human_rank: usize) -> [i32; 4] {
    assert!(human_rank == 1 || human_rank == 2);

    loop {
        let gap = gen_range(300, 2_000) as i32;

        if human_rank == 1 {
            let human = gen_range(26_000, 33_001) as i32;
            let above = human + gap;
            let remaining = 100_000 - above - human;
            if remaining <= 2_000 {
                continue;
            }

            // Both lower scores must fit below the human.
            let lower = ((remaining / 2) + 1).max(10_000);
            let upper = human - 1;
            if lower >= upper {
                continue;
            }

            let third = gen_range(lower as usize, upper as usize) as i32;
            let fourth = remaining - third;
            if fourth > 0 && fourth < third {
                return [above, human, third, fourth];
            }
        } else {
            let human = gen_range(22_000, 29_001) as i32;
            let second = human + gap;
            let remaining = 100_000 - second - human;

            // The fourth-place score must leave the leader above second.
            let upper = (human - 1).min(remaining - second - 1);
            if upper <= 8_000 {
                continue;
            }

            let fourth = gen_range(8_000, upper as usize) as i32;
            let first = remaining - fourth;
            if first > second && fourth < human {
                return [first, second, human, fourth];
            }
        }
    }
}

/// Rank-ordered scores where the human is 4th and more than 12,000 behind 3rd.
fn losing_badly_ranked_scores() -> [i32; 4] {
    loop {
        let human = gen_range(8_000, 16_001) as i32;
        let gap = gen_range(13_000, 20_001) as i32;
        let third = human + gap;
        let remaining = 100_000 - human - third;

        if remaining < 2 * third + 2_000 {
            continue;
        }

        let second = gen_range((third + 1_000) as usize, (remaining - 1_000) as usize) as i32;
        let first = remaining - second;
        if first > second && second > third {
            return [first, second, third, human];
        }
    }
}

/// Converts a seat/round wind into the honor used by agari's game context.
fn wind_to_honor(wind: Wind) -> Honor {
    match wind {
        Wind::East => Honor::East,
        Wind::South => Honor::South,
        Wind::West => Honor::West,
        Wind::North => Honor::North,
    }
}

/// True when the tile is not a 4, 5, or 6, including every honor tile.
fn is_outside_456(tile: Tile) -> bool {
    match tile.value() {
        Some(value) => !(4..=6).contains(&value),
        None => true,
    }
}

/// Suji tiles for a wait: the same-suit tiles three ranks away.
///
/// Waiting on 2 makes 5 safe, waiting on 5 makes 2 and 8 safe, and so on.
fn suji_tiles(tile: Tile) -> Vec<Tile> {
    let (Some(suit), Some(value)) = (tile.suit(), tile.value()) else {
        return Vec::new();
    };

    let mut suji = Vec::with_capacity(2);
    if value > 3 {
        suji.push(Tile::suited(suit, value - 3));
    }
    if value + 3 <= 9 {
        suji.push(Tile::suited(suit, value + 3));
    }
    suji
}

/// Draws a random non-empty subset of compatible Riichi triggers.
fn random_riichi_triggers() -> RiichiTriggerSet {
    loop {
        let mask = gen_range(0, 64) as u8;
        if mask == 0 {
            continue;
        }

        let triggers = RiichiTriggerSet {
            dealer: mask & 1 != 0,
            tanyao: mask & 2 != 0,
            red_five_wait: mask & 4 != 0,
            suji_trap: mask & 8 != 0,
            wait_outside_456: mask & 16 != 0,
            score_below_mangan: mask & 32 != 0,
        };

        if !triggers.any() {
            continue;
        }

        // A red-five wait is always the 5, so it cannot also be outside 4-5-6.
        if triggers.red_five_wait && triggers.wait_outside_456 {
            continue;
        }

        return triggers;
    }
}

/// Draws a random non-empty subset of compatible Added Kan triggers.
fn random_shouminkan_triggers() -> ShouminkanTriggerSet {
    loop {
        let mask = gen_range(1, 16) as u8;
        let triggers = ShouminkanTriggerSet {
            good_wait_and_value: mask & 1 != 0,
            late_game: mask & 2 != 0,
            placement_desperation: mask & 4 != 0,
            losing_badly: mask & 8 != 0,
        };

        // South 4 placement desperation and being 12,000 behind in fourth
        // place describe opposite table positions.
        if !triggers.any() || (triggers.placement_desperation && triggers.losing_badly) {
            continue;
        }

        return triggers;
    }
}

/// Counts regular dora in a final winning hand for one indicator.
fn regular_dora_in_hand(winning_tiles: &[Tile], indicator: Tile) -> u8 {
    let dora = indicator_to_dora(indicator);
    winning_tiles
        .iter()
        .filter(|tile| **tile == dora)
        .count()
        .min(u8::MAX as usize) as u8
}

/// True when a 13-tile hand is exactly six pairs plus the intended singleton.
fn has_six_pairs_and_singleton(tiles: &[Tile], wait_tile: Tile) -> bool {
    let counts = to_counts(tiles);
    if counts.len() != 7 {
        return false;
    }

    let mut pairs = 0;
    let mut singletons = 0;
    for &count in counts.values() {
        match count {
            2 => pairs += 1,
            1 => singletons += 1,
            _ => return false,
        }
    }

    pairs == 6 && singletons == 1 && counts.get(&wait_tile) == Some(&1)
}

/// Builds the human river, optionally forcing a same-suit suji of the wait
/// while never allowing the wait tile itself to appear (furiten).
fn build_chiitoitsu_human_river(
    deck: &mut HashMap<Tile, u8>,
    count: usize,
    wait_tile: Tile,
    suji_trap: bool,
) -> Result<Vec<Tile>, String> {
    let mut river = Vec::with_capacity(count);

    if suji_trap {
        let suji = suji_tiles(wait_tile);
        let tile = choose(&suji).ok_or_else(|| "No suji available for the wait".to_string())?;
        remove_tile(deck, &tile)?;
        river.push(tile);
    }

    let remaining = count.saturating_sub(river.len());
    let mut extra = draw_tiles_excluding(deck, remaining, &[wait_tile])
        .ok_or_else(|| "Deck exhausted drawing the human river".to_string())?;
    river.append(&mut extra);
    shuffle(&mut river);

    Ok(river)
}

/// Builds a human river that contains neither the wait nor any suji of it.
fn build_dama_human_river(
    deck: &mut HashMap<Tile, u8>,
    count: usize,
    wait_tile: Tile,
) -> Result<Vec<Tile>, String> {
    let mut excluded = vec![wait_tile];
    excluded.extend(suji_tiles(wait_tile));

    let mut river = draw_tiles_excluding(deck, count, &excluded)
        .ok_or_else(|| "Deck exhausted drawing the human river".to_string())?;
    shuffle(&mut river);

    Ok(river)
}

/// The dora indicator that produces `tile` as dora.
fn dora_indicator_for(tile: Tile) -> Tile {
    match tile {
        Tile::Suited { suit, value } => Tile::suited(suit, if value == 1 { 9 } else { value - 1 }),
        Tile::Honor(honor) => Tile::honor(match honor {
            Honor::East => Honor::North,
            Honor::South => Honor::East,
            Honor::West => Honor::South,
            Honor::North => Honor::West,
            Honor::White => Honor::Red,
            Honor::Green => Honor::White,
            Honor::Red => Honor::Green,
        }),
    }
}

/// Scores a completed chiitoitsu hand without Riichi.
fn chiitoitsu_score_level(
    winning_tiles: &[Tile],
    wait_tile: Tile,
    round_wind: Wind,
    seat_wind: Wind,
    dora_indicators: &[Tile],
    aka_count: u8,
) -> Option<ScoreLevel> {
    let counts = to_counts(winning_tiles);
    let chiitoitsu = decompose_hand(&counts)
        .into_iter()
        .find(|structure| matches!(structure, HandStructure::Chiitoitsu { .. }))?;

    let context = GameContext::new(
        WinType::Ron,
        wind_to_honor(round_wind),
        wind_to_honor(seat_wind),
    )
    .with_winning_tile(wait_tile)
    .with_dora(dora_indicators.to_vec())
    .with_aka(aka_count);

    let yaku = detect_yaku_with_context(&chiitoitsu, &counts, &context);
    if !yaku.yaku_list.contains(&Yaku::Chiitoitsu) {
        return None;
    }

    Some(calculate_score(&chiitoitsu, &yaku, &context).score_level)
}

/// Scores a completed chiitoitsu hand without Riichi and reports whether it
/// stays below Mangan.
fn chiitoitsu_scores_below_mangan(
    winning_tiles: &[Tile],
    wait_tile: Tile,
    round_wind: Wind,
    seat_wind: Wind,
    dora_indicator: Tile,
    aka_count: u8,
) -> bool {
    chiitoitsu_score_level(
        winning_tiles,
        wait_tile,
        round_wind,
        seat_wind,
        &[dora_indicator],
        aka_count,
    ) == Some(ScoreLevel::Normal)
}

/// Formats a list of tiles into standard compact Mahjong notation (e.g. "123m456p789s11122z").
pub fn format_hand_compact(tiles: &[Tile]) -> String {
    let mut sorted = tiles.to_vec();
    sorted.sort();

    let mut result = String::new();
    let mut m_vals = Vec::new();
    let mut p_vals = Vec::new();
    let mut s_vals = Vec::new();
    let mut z_vals = Vec::new();

    for tile in sorted {
        match tile {
            Tile::Suited {
                suit: Suit::Man,
                value,
            } => m_vals.push(value),
            Tile::Suited {
                suit: Suit::Pin,
                value,
            } => p_vals.push(value),
            Tile::Suited {
                suit: Suit::Sou,
                value,
            } => s_vals.push(value),
            Tile::Honor(h) => {
                let v = match h {
                    Honor::East => 1,
                    Honor::South => 2,
                    Honor::West => 3,
                    Honor::North => 4,
                    Honor::White => 5,
                    Honor::Green => 6,
                    Honor::Red => 7,
                };
                z_vals.push(v);
            }
        }
    }

    if !m_vals.is_empty() {
        for v in m_vals {
            result.push_str(&v.to_string());
        }
        result.push('m');
    }
    if !p_vals.is_empty() {
        for v in p_vals {
            result.push_str(&v.to_string());
        }
        result.push('p');
    }
    if !s_vals.is_empty() {
        for v in s_vals {
            result.push_str(&v.to_string());
        }
        result.push('s');
    }
    if !z_vals.is_empty() {
        for v in z_vals {
            result.push_str(&v.to_string());
        }
        result.push('z');
    }

    result
}

/// Scenario generator that implements 5-block theory hand generation.
#[derive(Debug, Default, Clone)]
pub struct ScenarioGenerator;

impl ScenarioGenerator {
    pub fn new() -> Self {
        Self
    }

    /// Generates a randomized 14-tile hand using 5-block theory (4 melds + 1 pair)
    /// sampled from a fresh 136-tile pool.
    pub fn generate_random_hand(&self) -> Vec<Tile> {
        let mut deck = fresh_deck();

        let mut hand: Vec<Tile> = Vec::with_capacity(14);

        // Block 1: The Pair (Jantou)
        let pair_candidates: Vec<Tile> = ALL_TILES
            .iter()
            .copied()
            .filter(|t| deck.get(t).copied().unwrap_or(0) >= 2)
            .collect();

        if let Some(pair_tile) = choose(&pair_candidates) {
            hand.push(pair_tile);
            hand.push(pair_tile);
            *deck.entry(pair_tile).or_insert(0) -= 2;
        }

        // Blocks 2 to 5: 4 Melds (Mentsu) - either sequence (shuntsu) or triplet (koutsu)
        for _ in 0..4 {
            let want_sequence = gen_bool(0.65);
            let meld_formed = if want_sequence {
                self.try_add_sequence(&mut hand, &mut deck)
                    || self.try_add_triplet(&mut hand, &mut deck)
            } else {
                self.try_add_triplet(&mut hand, &mut deck)
                    || self.try_add_sequence(&mut hand, &mut deck)
            };

            // Fallback: if neither meld could be formed, fill with available tiles
            if !meld_formed {
                for _ in 0..3 {
                    let available: Vec<Tile> = ALL_TILES
                        .iter()
                        .copied()
                        .filter(|t| deck.get(t).copied().unwrap_or(0) > 0)
                        .collect();
                    if let Some(t) = choose(&available) {
                        hand.push(t);
                        *deck.entry(t).or_insert(0) -= 1;
                    }
                }
            }
        }

        // Ensure hand is padded to 14 tiles if any step lacked tiles
        while hand.len() < 14 {
            let available: Vec<Tile> = ALL_TILES
                .iter()
                .copied()
                .filter(|t| deck.get(t).copied().unwrap_or(0) > 0)
                .collect();
            if let Some(t) = choose(&available) {
                hand.push(t);
                *deck.entry(t).or_insert(0) -= 1;
            } else {
                break;
            }
        }

        hand.sort();
        hand
    }

    fn try_add_sequence(&self, hand: &mut Vec<Tile>, deck: &mut HashMap<Tile, u8>) -> bool {
        let suits = [Suit::Man, Suit::Pin, Suit::Sou];
        let mut candidates = Vec::new();

        for &suit in &suits {
            for start_val in 1..=7 {
                let t1 = Tile::Suited {
                    suit,
                    value: start_val,
                };
                let t2 = Tile::Suited {
                    suit,
                    value: start_val + 1,
                };
                let t3 = Tile::Suited {
                    suit,
                    value: start_val + 2,
                };

                if deck.get(&t1).copied().unwrap_or(0) >= 1
                    && deck.get(&t2).copied().unwrap_or(0) >= 1
                    && deck.get(&t3).copied().unwrap_or(0) >= 1
                {
                    candidates.push((t1, t2, t3));
                }
            }
        }

        if let Some((t1, t2, t3)) = choose(&candidates) {
            hand.push(t1);
            hand.push(t2);
            hand.push(t3);
            *deck.entry(t1).or_insert(0) -= 1;
            *deck.entry(t2).or_insert(0) -= 1;
            *deck.entry(t3).or_insert(0) -= 1;
            true
        } else {
            false
        }
    }

    fn try_add_triplet(&self, hand: &mut Vec<Tile>, deck: &mut HashMap<Tile, u8>) -> bool {
        let candidates: Vec<Tile> = ALL_TILES
            .iter()
            .copied()
            .filter(|t| deck.get(t).copied().unwrap_or(0) >= 3)
            .collect();

        if let Some(tile) = choose(&candidates) {
            hand.push(tile);
            hand.push(tile);
            hand.push(tile);
            *deck.entry(tile).or_insert(0) -= 3;
            true
        } else {
            false
        }
    }

    /// Generates the first Block Theory scenario: a ryanmen protorun (XXY/XYY)
    /// with an open Yakuhai meld, two completed sets, and a separate pair.
    ///
    /// The duplicate tile is the correct discard because it leaves the
    /// consecutive pair intact as a live ryanmen wait.
    pub fn generate_ryanmen_protorun(&self, category: &str) -> Result<GameState, String> {
        const MAX_ATTEMPTS: usize = 10_000;
        let mut last_error = String::new();

        for _ in 0..MAX_ATTEMPTS {
            let skeleton = match self.build_ryanmen_skeleton() {
                Ok(skeleton) => skeleton,
                Err(err) => {
                    last_error = err;
                    continue;
                }
            };

            match self.build_ryanmen_board(category, &skeleton) {
                Ok(state) => return Ok(state),
                Err(err) => last_error = err,
            }
        }

        Err(format!(
            "Failed to satisfy ryanmen scenario constraints after {MAX_ATTEMPTS} attempts: {last_error}"
        ))
    }

    /// Builds and validates a complete board for an already-valid hand skeleton.
    fn build_ryanmen_board(
        &self,
        category: &str,
        skeleton: &RyanmenSkeleton,
    ) -> Result<GameState, String> {
        if !skeleton.shape_tiles.contains(&skeleton.correct_tile) {
            return Err("Ryanmen skeleton is missing its duplicate tile".to_string());
        }

        let mut deck = fresh_deck();
        for tile in &skeleton.full_tiles {
            remove_tile(&mut deck, tile)?;
        }

        let dora_indicator = draw_tile(&mut deck)
            .ok_or_else(|| "Deck exhausted drawing the dora indicator".to_string())?;
        let ura_indicator = draw_tile(&mut deck)
            .ok_or_else(|| "Deck exhausted drawing the ura indicator".to_string())?;

        if indicator_to_dora(dora_indicator) == skeleton.correct_tile {
            return Err("The duplicate tile cannot be the dora".to_string());
        }

        let (round_wind, hand_number) = random_round();
        let honba = gen_range(0, 4) as u8;

        let mut opponent_scores = Vec::with_capacity(3);
        let mut opponent_total = 0;
        for _ in 0..3 {
            let score = 20_000 + 1_000 * gen_range(0, 11) as i32;
            opponent_scores.push(score);
            opponent_total += score;
        }
        let human_score = 100_000 - opponent_total;

        let opponent_meta = [
            (1usize, "Shimocha", Wind::South),
            (2, "Toimen", Wind::West),
            (3, "Kamicha", Wind::North),
        ];

        // The human is the current player (about to discard), so every player
        // has completed the same number of turns and made one discard per turn.
        // At least one turn has passed because the human has an open Pon.
        let discard_count = gen_range(1, 7);

        let mut opponent_players = Vec::with_capacity(3);
        let mut opponent_rivers: Vec<Vec<Tile>> = Vec::with_capacity(3);
        for (index, (seat, name, wind)) in opponent_meta.iter().enumerate() {
            let hand = draw_tiles(&mut deck, 13)
                .ok_or_else(|| "Deck exhausted drawing an opponent hand".to_string())?;
            let river = draw_tiles(&mut deck, discard_count)
                .ok_or_else(|| "Deck exhausted drawing an opponent river".to_string())?;
            opponent_rivers.push(river.clone());
            opponent_players.push(PlayerState {
                seat: *seat,
                name: name.to_string(),
                is_human: false,
                wind: *wind,
                score: opponent_scores[index],
                hand: hand.iter().map(|tile| tile.to_string()).collect(),
                draw: None,
                red_fives: Vec::new(),
                discards: discards_from_tiles(&river),
                melds: Vec::new(),
                is_riichi: false,
                riichi_discard_index: None,
            });
        }

        // Furiten: the human's river cannot contain either ryanmen wait tile.
        let human_river = draw_tiles_excluding(&mut deck, discard_count, &skeleton.wait_tiles)
            .ok_or_else(|| "Deck exhausted drawing the human river".to_string())?;

        // Wait chance: at most two winning-tile copies may be visible.
        let mut visible_wait_tiles = 0;
        for river in &opponent_rivers {
            for tile in river {
                if skeleton.wait_tiles.contains(tile) {
                    visible_wait_tiles += 1;
                }
            }
        }
        if skeleton.wait_tiles.contains(&dora_indicator) {
            visible_wait_tiles += 1;
        }
        if visible_wait_tiles > 2 {
            return Err(format!(
                "{visible_wait_tiles} ryanmen wait tiles are already visible"
            ));
        }

        let mut human_hand = skeleton.concealed_tiles.clone();
        let duplicate_index = human_hand
            .iter()
            .position(|tile| *tile == skeleton.correct_tile)
            .ok_or_else(|| "Ryanmen skeleton is missing its duplicate tile".to_string())?;
        human_hand.remove(duplicate_index);
        human_hand.sort();

        let mut full_tiles = skeleton.full_tiles.clone();
        full_tiles.sort();

        let mut post_discard_tiles = full_tiles.clone();
        let post_discard_index = post_discard_tiles
            .iter()
            .position(|tile| *tile == skeleton.correct_tile)
            .ok_or_else(|| "Ryanmen skeleton is missing its duplicate tile".to_string())?;
        post_discard_tiles.remove(post_discard_index);

        let counts = to_counts(&post_discard_tiles);
        let shanten_res = calculate_shanten(&counts);
        let decompositions = decompose_hand(&counts);
        let ukeire_res = calculate_ukeire(&counts);

        // Reject hands that gain any yaku beyond the intended open Yakuhai.
        if self.has_unintended_yaku(skeleton, &human_hand, round_wind, dora_indicator) {
            return Err("Candidate hand has unintended yaku".to_string());
        }

        let remaining_tiles: usize = deck.values().map(|&count| count as usize).sum();
        let tiles_remaining = remaining_tiles.saturating_sub(12).min(u8::MAX as usize) as u8;
        if tiles_remaining == 0 {
            return Err("No drawable tiles remain".to_string());
        }

        let hand_string = format_hand_compact(&full_tiles);
        let tile_strings: Vec<String> = full_tiles.iter().map(|tile| tile.to_string()).collect();
        let ukeire_tiles: Vec<String> = ukeire_res
            .tiles
            .iter()
            .map(|u| u.tile.to_string())
            .collect();
        let meld_tiles: Vec<String> = skeleton
            .open_meld_tiles
            .iter()
            .map(|tile| tile.to_string())
            .collect();

        let human_player = PlayerState {
            seat: 0,
            name: "You".to_string(),
            is_human: true,
            wind: Wind::East,
            score: human_score,
            hand: human_hand.iter().map(|tile| tile.to_string()).collect(),
            draw: Some(skeleton.correct_tile.to_string()),
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
        players.extend(opponent_players);

        Ok(GameState {
            category: category.to_string(),
            target_action: TargetAction::NaniKiru,
            // The open Yakuhai meld makes Riichi illegal, so staying dama is
            // the only legal declaration for this hand.
            correct_action: CorrectAction::dama(skeleton.correct_tile.to_string()),
            riichi_triggers: Vec::new(),
            dama_reasons: Vec::new(),
            shouminkan_triggers: Vec::new(),
            hand_string,
            tiles: tile_strings,
            shanten: shanten_res.shanten,
            is_agari: shanten_res.shanten == -1,
            decompositions_count: decompositions.len(),
            ukeire_tiles,
            ukeire_total: ukeire_res.total_count,
            round_wind,
            hand_number,
            honba,
            riichi_sticks: 0,
            dora_indicators: vec![dora_indicator.to_string()],
            ura_dora_indicators: vec![ura_indicator.to_string()],
            tiles_remaining,
            current_turn: 0,
            players,
        })
    }

    /// Rejects any winning decomposition whose only yaku is not the open
    /// dragon yakuhai. This keeps the scenario a pure tile-efficiency problem.
    fn has_unintended_yaku(
        &self,
        skeleton: &RyanmenSkeleton,
        human_hand: &[Tile],
        round_wind: Wind,
        dora_indicator: Tile,
    ) -> bool {
        let open_tile = skeleton.open_meld_tiles[0];
        let open_honor = match open_tile {
            Tile::Honor(honor) => honor,
            _ => return true,
        };
        let allowed_yaku = Yaku::Yakuhai(open_honor);
        let round_honor = match round_wind {
            Wind::East => Honor::East,
            Wind::South => Honor::South,
            Wind::West => Honor::West,
            Wind::North => Honor::North,
        };
        let open_meld = Meld::koutsu_open(open_tile);

        for &wait_tile in &skeleton.wait_tiles {
            let mut concealed_with_win = human_hand.to_vec();
            concealed_with_win.push(wait_tile);
            let concealed_counts = to_counts(&concealed_with_win);
            let structures =
                decompose_hand_with_melds(&concealed_counts, std::slice::from_ref(&open_meld));
            if structures.is_empty() {
                return true;
            }

            let mut full_with_win = human_hand.to_vec();
            full_with_win.extend(skeleton.open_meld_tiles.iter().copied());
            full_with_win.push(wait_tile);
            let full_counts = to_counts(&full_with_win);

            let mut context = GameContext::new(WinType::Ron, round_honor, Honor::East)
                .with_winning_tile(wait_tile)
                .open();
            context.dora_indicators = vec![dora_indicator];

            for structure in &structures {
                let result = detect_yaku_with_context(structure, &full_counts, &context);
                if result.yaku_list.len() != 1 || result.yaku_list[0] != allowed_yaku {
                    return true;
                }
            }
        }

        false
    }

    /// Constructs a valid "Ryanmen protorun + 1" skeleton from a fresh deck.
    fn build_ryanmen_skeleton(&self) -> Result<RyanmenSkeleton, String> {
        'attempt: for _ in 0..256 {
            let mut deck = fresh_deck();

            let suits = [Suit::Man, Suit::Pin, Suit::Sou];
            let suit = choose(&suits).ok_or_else(|| "No suits available".to_string())?;

            // X and X+1 stay inside 2..=8 so the remaining two tiles are a
            // true ryanmen (23, 34, ... 78) rather than a terminal penchan.
            let base = gen_range(2, 8) as u8;
            let x = Tile::Suited { suit, value: base };
            let y = Tile::Suited {
                suit,
                value: base + 1,
            };
            let wait_low = Tile::Suited {
                suit,
                value: base - 1,
            };
            let wait_high = Tile::Suited {
                suit,
                value: base + 2,
            };

            // XXY leaves X as the duplicate; XYY leaves Y as the duplicate.
            let (shape_tiles, correct_tile) = if gen_bool(0.5) {
                ([x, x, y], x)
            } else {
                ([x, y, y], y)
            };

            let mut shape_can_be_removed = true;
            for tile in &shape_tiles {
                match deck.get_mut(tile) {
                    Some(count) if *count > 0 => *count -= 1,
                    _ => shape_can_be_removed = false,
                }
            }
            if !shape_can_be_removed {
                continue 'attempt;
            }

            // Open Yakuhai triplet: any dragon guarantees a yaku.
            let dragons = [
                Tile::Honor(Honor::White),
                Tile::Honor(Honor::Green),
                Tile::Honor(Honor::Red),
            ];
            let dragon = choose(&dragons).ok_or_else(|| "No dragons available".to_string())?;
            let open_meld_tiles = vec![dragon, dragon, dragon];
            for _ in 0..3 {
                if let Some(count) = deck.get_mut(&dragon) {
                    *count -= 1;
                }
            }

            // Two completed sets, either sequences or triplets.
            let mut concealed_tiles = Vec::with_capacity(11);
            for _ in 0..2 {
                let added = if gen_bool(0.65) {
                    self.try_add_sequence(&mut concealed_tiles, &mut deck)
                        || self.try_add_triplet(&mut concealed_tiles, &mut deck)
                } else {
                    self.try_add_triplet(&mut concealed_tiles, &mut deck)
                        || self.try_add_sequence(&mut concealed_tiles, &mut deck)
                };
                if !added {
                    continue 'attempt;
                }
            }

            // A separate pair, deliberately not overlapping the special shape.
            let pair_candidates: Vec<Tile> = ALL_TILES
                .iter()
                .copied()
                .filter(|tile| {
                    !shape_tiles.contains(tile) && deck.get(tile).copied().unwrap_or(0) >= 2
                })
                .collect();
            let pair_tile = match choose(&pair_candidates) {
                Some(tile) => tile,
                None => continue 'attempt,
            };
            concealed_tiles.push(pair_tile);
            concealed_tiles.push(pair_tile);
            *deck
                .get_mut(&pair_tile)
                .expect("pair tile must exist in the deck") -= 2;

            concealed_tiles.extend(shape_tiles.iter().copied());

            let mut full_tiles = concealed_tiles.clone();
            full_tiles.extend(open_meld_tiles.iter().copied());

            if validate_hand(&full_tiles).is_err() {
                continue 'attempt;
            }

            // Confirm the duplicate discard leaves a tenpai hand, that the
            // ryanmen is the only wait, and that both sides remain live.
            if deck.get(&wait_low).copied().unwrap_or(0) == 0
                || deck.get(&wait_high).copied().unwrap_or(0) == 0
            {
                continue 'attempt;
            }

            let mut post_discard = full_tiles.clone();
            let Some(duplicate_index) = post_discard.iter().position(|tile| *tile == correct_tile)
            else {
                continue 'attempt;
            };
            post_discard.remove(duplicate_index);
            let post_counts = to_counts(&post_discard);
            if calculate_shanten(&post_counts).shanten != 0 {
                continue 'attempt;
            }

            let post_ukeire = calculate_ukeire(&post_counts);
            let post_wait_tiles: Vec<Tile> = post_ukeire.tiles.iter().map(|u| u.tile).collect();
            if post_wait_tiles.len() != 2
                || !post_wait_tiles.contains(&wait_low)
                || !post_wait_tiles.contains(&wait_high)
            {
                continue 'attempt;
            }

            return Ok(RyanmenSkeleton {
                full_tiles,
                concealed_tiles,
                shape_tiles,
                wait_tiles: [wait_low, wait_high],
                open_meld_tiles,
                correct_tile,
            });
        }

        Err("Failed to construct a valid ryanmen protorun hand".to_string())
    }

    /// Generates a seven-pairs tenpai that randomly asks for Riichi or dama.
    ///
    /// The Riichi path applies at least one Riichi heuristic and keeps the wait
    /// off the dora. The dama path inverts those conditions and guarantees a
    /// Mangan-or-better hand through two dora pairs.
    pub fn generate_chiitoitsu_riichi_vs_dama(&self, category: &str) -> Result<GameState, String> {
        const MAX_ATTEMPTS: usize = 20_000;
        let mut last_error = String::new();

        for _ in 0..MAX_ATTEMPTS {
            let skeleton = if gen_bool(0.5) {
                let triggers = random_riichi_triggers();
                self.build_chiitoitsu_skeleton(triggers)
            } else {
                self.build_dama_chiitoitsu_skeleton()
            };

            let skeleton = match skeleton {
                Ok(skeleton) => skeleton,
                Err(err) => {
                    last_error = err;
                    continue;
                }
            };

            match self.build_chiitoitsu_board(category, &skeleton) {
                Ok(state) => return Ok(state),
                Err(err) => last_error = err,
            }
        }

        Err(format!(
            "Failed to satisfy chiitoitsu scenario constraints after {MAX_ATTEMPTS} attempts: {last_error}"
        ))
    }

    /// Builds six distinct pairs plus a wait singleton and an unwanted
    /// singleton that will be discarded.
    fn build_chiitoitsu_skeleton(
        &self,
        triggers: RiichiTriggerSet,
    ) -> Result<ChiitoitsuSkeleton, String> {
        let wait_candidates: Vec<Tile> = ALL_TILES
            .iter()
            .copied()
            .filter(|&tile| {
                if triggers.red_five_wait && tile.value() != Some(5) {
                    return false;
                }
                if triggers.tanyao && !tile.is_simple() {
                    return false;
                }
                if triggers.wait_outside_456 && !is_outside_456(tile) {
                    return false;
                }
                if triggers.suji_trap && tile.suit().is_none() {
                    return false;
                }
                true
            })
            .collect();

        let wait_tile =
            choose(&wait_candidates).ok_or_else(|| "No compatible wait tile".to_string())?;

        let mut deck = fresh_deck();
        remove_tile(&mut deck, &wait_tile)?;

        let mut pairs = Vec::with_capacity(6);
        for _ in 0..6 {
            let candidates: Vec<Tile> = ALL_TILES
                .iter()
                .copied()
                .filter(|&tile| {
                    tile != wait_tile
                        && !pairs.contains(&tile)
                        && deck.get(&tile).copied().unwrap_or(0) >= 2
                        && (!triggers.tanyao || tile.is_simple())
                })
                .collect();

            let pair = choose(&candidates).ok_or_else(|| "No pair candidates left".to_string())?;
            remove_tile(&mut deck, &pair)?;
            remove_tile(&mut deck, &pair)?;
            pairs.push(pair);
        }

        let discard_candidates: Vec<Tile> = ALL_TILES
            .iter()
            .copied()
            .filter(|&tile| {
                tile != wait_tile
                    && !pairs.contains(&tile)
                    && deck.get(&tile).copied().unwrap_or(0) >= 1
            })
            .collect();
        let discard_tile =
            choose(&discard_candidates).ok_or_else(|| "No discard candidates left".to_string())?;

        Ok(ChiitoitsuSkeleton {
            pairs,
            wait_tile,
            discard_tile,
            decision: ChiitoitsuDecision::Riichi,
            red_five_wait: triggers.red_five_wait,
            triggers,
            dora_pairs: Vec::new(),
        })
    }

    /// Builds a chiitoitsu skeleton for the strict dama lesson: non-dealer,
    /// no Tanyao, middle wait, no red-five wait, and two dora pairs.
    fn build_dama_chiitoitsu_skeleton(&self) -> Result<ChiitoitsuSkeleton, String> {
        let wait_candidates: Vec<Tile> = ALL_TILES
            .iter()
            .copied()
            .filter(|&tile| matches!(tile.value(), Some(4..=6)))
            .collect();
        let wait_tile =
            choose(&wait_candidates).ok_or_else(|| "No middle wait tile".to_string())?;

        let mut deck = fresh_deck();
        remove_tile(&mut deck, &wait_tile)?;

        // At least one terminal/honor pair is mandatory, so the hand cannot
        // have Tanyao.
        let non_simple_candidates: Vec<Tile> = ALL_TILES
            .iter()
            .copied()
            .filter(|&tile| {
                tile != wait_tile && !tile.is_simple() && deck.get(&tile).copied().unwrap_or(0) >= 2
            })
            .collect();
        let required_pair = choose(&non_simple_candidates)
            .ok_or_else(|| "No terminal/honor pair available".to_string())?;
        remove_tile(&mut deck, &required_pair)?;
        remove_tile(&mut deck, &required_pair)?;

        let mut pairs = vec![required_pair];
        for _ in 0..5 {
            let candidates: Vec<Tile> = ALL_TILES
                .iter()
                .copied()
                .filter(|&tile| {
                    tile != wait_tile
                        && !pairs.contains(&tile)
                        && deck.get(&tile).copied().unwrap_or(0) >= 2
                })
                .collect();

            let pair = choose(&candidates).ok_or_else(|| "No pair candidates left".to_string())?;
            remove_tile(&mut deck, &pair)?;
            remove_tile(&mut deck, &pair)?;
            pairs.push(pair);
        }

        let discard_candidates: Vec<Tile> = ALL_TILES
            .iter()
            .copied()
            .filter(|&tile| {
                tile != wait_tile
                    && !pairs.contains(&tile)
                    && deck.get(&tile).copied().unwrap_or(0) >= 1
            })
            .collect();
        let discard_tile =
            choose(&discard_candidates).ok_or_else(|| "No discard candidates left".to_string())?;

        // Two of the six pairs become dora pairs. Each pair is two dora tiles,
        // so the final hand has exactly four dora.
        let mut dora_pairs = pairs.clone();
        shuffle(&mut dora_pairs);
        dora_pairs.truncate(2);
        if dora_pairs.len() != 2 {
            return Err("Could not select two dora pairs".to_string());
        }

        Ok(ChiitoitsuSkeleton {
            pairs,
            wait_tile,
            discard_tile,
            decision: ChiitoitsuDecision::Dama,
            red_five_wait: false,
            triggers: RiichiTriggerSet::default(),
            dora_pairs,
        })
    }

    /// Builds and validates a complete board for a chiitoitsu skeleton.
    fn build_chiitoitsu_board(
        &self,
        category: &str,
        skeleton: &ChiitoitsuSkeleton,
    ) -> Result<GameState, String> {
        let full_tiles = skeleton.full_tiles();
        validate_hand(&full_tiles)?;

        let tenpai_tiles = skeleton.tenpai_tiles();
        if !has_six_pairs_and_singleton(&tenpai_tiles, skeleton.wait_tile) {
            return Err("Chiitoitsu skeleton is not six pairs plus one singleton".to_string());
        }

        let post_counts = to_counts(&tenpai_tiles);
        let shanten = calculate_shanten(&post_counts);
        if shanten.shanten != 0 {
            return Err("Chiitoitsu discard must leave a tenpai hand".to_string());
        }

        let ukeire = calculate_ukeire(&post_counts);
        if ukeire.tiles.len() != 1 || ukeire.tiles[0].tile != skeleton.wait_tile {
            return Err("Chiitoitsu hand must have exactly the intended wait".to_string());
        }

        let mut winning_tiles = tenpai_tiles.clone();
        winning_tiles.push(skeleton.wait_tile);
        let winning_counts = to_counts(&winning_tiles);
        let decompositions = decompose_hand(&winning_counts);

        let (round_wind, hand_number) = random_round();
        let human_wind =
            if skeleton.decision == ChiitoitsuDecision::Riichi && skeleton.triggers.dealer {
                Wind::East
            } else {
                choose(&[Wind::South, Wind::West, Wind::North])
                    .ok_or_else(|| "No non-dealer winds available".to_string())?
            };

        let aka_count = u8::from(skeleton.red_five_wait);

        // The wait must never be dora. On the Riichi path the hand also has
        // to stay below Mangan; on the dama path two pair tiles are forced to
        // be dora, giving exactly four dora tiles.
        let dora_indicators: Vec<Tile> = match skeleton.decision {
            ChiitoitsuDecision::Riichi => {
                let dora_candidates: Vec<Tile> = ALL_TILES
                    .iter()
                    .copied()
                    .filter(|&indicator| {
                        if indicator_to_dora(indicator) == skeleton.wait_tile {
                            return false;
                        }
                        if skeleton.triggers.score_below_mangan {
                            regular_dora_in_hand(&winning_tiles, indicator) + aka_count <= 1
                        } else {
                            true
                        }
                    })
                    .collect();
                vec![
                    choose(&dora_candidates)
                        .ok_or_else(|| "No legal dora indicator".to_string())?,
                ]
            }
            ChiitoitsuDecision::Dama => {
                if skeleton.dora_pairs.len() != 2 {
                    return Err("Dama hand must have exactly two dora pairs".to_string());
                }

                let indicators: Vec<Tile> = skeleton
                    .dora_pairs
                    .iter()
                    .map(|&tile| dora_indicator_for(tile))
                    .collect();
                if indicators
                    .iter()
                    .any(|&indicator| indicator_to_dora(indicator) == skeleton.wait_tile)
                {
                    return Err("Dama wait must not be dora".to_string());
                }

                let total_dora: u8 = indicators
                    .iter()
                    .map(|&indicator| regular_dora_in_hand(&winning_tiles, indicator))
                    .sum();
                if total_dora != 4 {
                    return Err(format!(
                        "Dama hand must contain exactly four dora, found {total_dora}"
                    ));
                }

                indicators
            }
        };

        match skeleton.decision {
            ChiitoitsuDecision::Riichi => {
                if !chiitoitsu_scores_below_mangan(
                    &winning_tiles,
                    skeleton.wait_tile,
                    round_wind,
                    human_wind,
                    dora_indicators[0],
                    aka_count,
                ) {
                    return Err(
                        "Completed chiitoitsu hand is not below Mangan without Riichi".to_string(),
                    );
                }
            }
            ChiitoitsuDecision::Dama => {
                let score_level = chiitoitsu_score_level(
                    &winning_tiles,
                    skeleton.wait_tile,
                    round_wind,
                    human_wind,
                    &dora_indicators,
                    aka_count,
                )
                .ok_or_else(|| "Dama hand did not score as chiitoitsu".to_string())?;

                if score_level < ScoreLevel::Mangan {
                    return Err(format!(
                        "Dama hand must be Mangan or better without Riichi, got {score_level:?}"
                    ));
                }
            }
        }

        let mut deck = fresh_deck();
        for tile in &full_tiles {
            remove_tile(&mut deck, tile)?;
        }
        for indicator in &dora_indicators {
            remove_tile(&mut deck, indicator)?;
        }

        let ura_candidates: Vec<Tile> = ALL_TILES
            .iter()
            .copied()
            .filter(|&indicator| {
                indicator_to_dora(indicator) != skeleton.wait_tile
                    && deck.get(&indicator).copied().unwrap_or(0) > 0
            })
            .collect();
        let ura_indicator =
            choose(&ura_candidates).ok_or_else(|| "No legal ura indicator".to_string())?;
        remove_tile(&mut deck, &ura_indicator)?;

        let mut opponent_scores = Vec::with_capacity(3);
        let mut opponent_total = 0;
        for _ in 0..3 {
            let score = 20_000 + 1_000 * gen_range(0, 11) as i32;
            opponent_scores.push(score);
            opponent_total += score;
        }
        let human_score = 100_000 - opponent_total;

        // The human is about to discard, so every player has completed the
        // same number of turns and made one discard per turn.
        let discard_count = gen_range(2, 7);

        let opponent_meta = [(1usize, "Shimocha"), (2, "Toimen"), (3, "Kamicha")];

        let mut opponent_players = Vec::with_capacity(3);
        let mut opponent_rivers: Vec<Vec<Tile>> = Vec::with_capacity(3);
        for (index, (seat, name)) in opponent_meta.iter().enumerate() {
            let hand = draw_tiles(&mut deck, 13)
                .ok_or_else(|| "Deck exhausted drawing an opponent hand".to_string())?;
            let river = draw_tiles(&mut deck, discard_count)
                .ok_or_else(|| "Deck exhausted drawing an opponent river".to_string())?;
            opponent_rivers.push(river.clone());
            opponent_players.push(PlayerState {
                seat: *seat,
                name: name.to_string(),
                is_human: false,
                wind: human_wind.next(*seat),
                score: opponent_scores[index],
                hand: hand.iter().map(|tile| tile.to_string()).collect(),
                draw: None,
                red_fives: Vec::new(),
                discards: discards_from_tiles(&river),
                melds: Vec::new(),
                is_riichi: false,
                riichi_discard_index: None,
            });
        }

        // The human river cannot contain the wait tile (furiten). On the
        // Riichi path it may be forced to contain a suji; on the dama path
        // every suji is forbidden.
        let human_river = match skeleton.decision {
            ChiitoitsuDecision::Riichi => build_chiitoitsu_human_river(
                &mut deck,
                discard_count,
                skeleton.wait_tile,
                skeleton.triggers.suji_trap,
            )?,
            ChiitoitsuDecision::Dama => {
                let river = build_dama_human_river(&mut deck, discard_count, skeleton.wait_tile)?;
                let suji = suji_tiles(skeleton.wait_tile);
                if river.iter().any(|tile| suji.contains(tile)) {
                    return Err("Dama river must not contain a wait suji".to_string());
                }
                river
            }
        };

        // Wait chance: at most two winning-tile copies may be visible.
        let mut visible_wait_tiles = 0;
        for river in &opponent_rivers {
            for tile in river {
                if *tile == skeleton.wait_tile {
                    visible_wait_tiles += 1;
                }
            }
        }
        for indicator in &dora_indicators {
            if *indicator == skeleton.wait_tile {
                visible_wait_tiles += 1;
            }
        }
        if visible_wait_tiles > 2 {
            return Err(format!(
                "{visible_wait_tiles} chiitoitsu wait tiles are already visible"
            ));
        }

        if skeleton.decision == ChiitoitsuDecision::Dama {
            if human_wind == Wind::East {
                return Err("Dama player must not be the dealer".to_string());
            }
            if !matches!(skeleton.wait_tile.value(), Some(4..=6)) {
                return Err("Dama wait must be exactly 4, 5, or 6".to_string());
            }
            if skeleton.red_five_wait {
                return Err("Dama wait must not be a red five".to_string());
            }
            if skeleton.pairs.iter().all(|pair| pair.is_simple()) {
                return Err("Dama hand must contain a terminal or honor pair".to_string());
            }
            if aka_count != 0 {
                return Err("Dama hand must not rely on red fives".to_string());
            }
        }

        let remaining_tiles: usize = deck.values().map(|&count| count as usize).sum();
        let tiles_remaining = remaining_tiles.saturating_sub(12).min(u8::MAX as usize) as u8;
        if tiles_remaining == 0 {
            return Err("No drawable tiles remain".to_string());
        }

        let mut display_tiles = full_tiles.clone();
        display_tiles.sort();
        let mut sorted_hand = tenpai_tiles.clone();
        sorted_hand.sort();

        let hand_string = format_hand_compact(&display_tiles);
        let tile_strings: Vec<String> = display_tiles.iter().map(|tile| tile.to_string()).collect();
        let ukeire_tiles: Vec<String> = ukeire.tiles.iter().map(|u| u.tile.to_string()).collect();
        let human_red_fives = if skeleton.red_five_wait {
            vec![skeleton.wait_tile.to_string()]
        } else {
            Vec::new()
        };

        let human_player = PlayerState {
            seat: 0,
            name: "You".to_string(),
            is_human: true,
            wind: human_wind,
            score: human_score,
            hand: sorted_hand.iter().map(|tile| tile.to_string()).collect(),
            draw: Some(skeleton.discard_tile.to_string()),
            red_fives: human_red_fives,
            discards: discards_from_tiles(&human_river),
            melds: Vec::new(),
            is_riichi: false,
            riichi_discard_index: None,
        };

        let mut players = Vec::with_capacity(4);
        players.push(human_player);
        players.extend(opponent_players);

        let (target_action, correct_action) = match skeleton.decision {
            ChiitoitsuDecision::Riichi => (
                TargetAction::Riichi,
                CorrectAction::riichi(skeleton.discard_tile.to_string()),
            ),
            ChiitoitsuDecision::Dama => (
                TargetAction::Dama,
                CorrectAction::dama(skeleton.discard_tile.to_string()),
            ),
        };
        let dama_reasons = match skeleton.decision {
            ChiitoitsuDecision::Riichi => Vec::new(),
            ChiitoitsuDecision::Dama => vec![
                DamaReason::NotDealer,
                DamaReason::NoTanyao,
                DamaReason::MiddleWait,
                DamaReason::NoRedFiveWait,
                DamaReason::NoSujiTrap,
                DamaReason::Mangan,
            ],
        };

        Ok(GameState {
            category: category.to_string(),
            target_action,
            correct_action,
            riichi_triggers: skeleton.triggers.to_vec(),
            dama_reasons,
            shouminkan_triggers: Vec::new(),
            hand_string,
            tiles: tile_strings,
            shanten: shanten.shanten,
            is_agari: false,
            decompositions_count: decompositions.len(),
            ukeire_tiles,
            ukeire_total: ukeire.total_count,
            round_wind,
            hand_number,
            honba: gen_range(0, 4) as u8,
            riichi_sticks: 0,
            dora_indicators: dora_indicators
                .iter()
                .map(|indicator| indicator.to_string())
                .collect(),
            ura_dora_indicators: vec![ura_indicator.to_string()],
            tiles_remaining,
            current_turn: 0,
            players,
        })
    }

    /// Generates a hand where the player has drawn the fourth tile of an open
    /// Pon and must decide whether to upgrade it to an Added Kan.
    pub fn generate_shouminkan_decision(&self, category: &str) -> Result<GameState, String> {
        const MAX_ATTEMPTS: usize = 20_000;
        let mut last_error = String::new();

        for _ in 0..MAX_ATTEMPTS {
            let triggers = random_shouminkan_triggers();
            let skeleton = match self.build_shouminkan_skeleton(triggers) {
                Ok(skeleton) => skeleton,
                Err(err) => {
                    last_error = err;
                    continue;
                }
            };

            match self.build_shouminkan_board(category, &skeleton, triggers) {
                Ok(state) => return Ok(state),
                Err(err) => last_error = err,
            }
        }

        Err(format!(
            "Failed to satisfy shouminkan scenario constraints after {MAX_ATTEMPTS} attempts: {last_error}"
        ))
    }

    /// Builds a tenpai hand with an open dragon Pon, the fourth copy drawn,
    /// a second dragon triplet for guaranteed value, and a ryanmen or
    /// three-sided wait.
    fn build_shouminkan_skeleton(
        &self,
        triggers: ShouminkanTriggerSet,
    ) -> Result<ShouminkanSkeleton, String> {
        for _ in 0..512 {
            let mut deck = fresh_deck();

            let dragons = [
                Tile::Honor(Honor::White),
                Tile::Honor(Honor::Green),
                Tile::Honor(Honor::Red),
            ];
            let pon_tile =
                choose(&dragons).ok_or_else(|| "No dragon available for the Pon".to_string())?;
            for _ in 0..3 {
                remove_tile(&mut deck, &pon_tile)?;
            }
            // Keep the fourth copy aside as the active draw.
            remove_tile(&mut deck, &pon_tile)?;
            let open_pon_tiles = vec![pon_tile; 3];

            let mut concealed_tiles = Vec::with_capacity(10);

            // The Good Wait & Value lesson forces a second dragon triplet so
            // the hand is worth at least two han before any Kan dora.
            let value_tile = if triggers.good_wait_and_value {
                let value_candidates: Vec<Tile> = dragons
                    .iter()
                    .copied()
                    .filter(|&tile| tile != pon_tile)
                    .collect();
                let value_tile = choose(&value_candidates)
                    .ok_or_else(|| "No second dragon for guaranteed value".to_string())?;
                for _ in 0..3 {
                    remove_tile(&mut deck, &value_tile)?;
                }
                concealed_tiles.extend([value_tile; 3]);
                Some(value_tile)
            } else {
                None
            };

            let wait_shape = if gen_bool(0.5) {
                ShouminkanWaitShape::ThreeSided
            } else {
                ShouminkanWaitShape::Ryanmen
            };
            let (shape_tiles, wait_tiles, shape_suit) =
                self.build_shouminkan_wait_shape(&mut deck, wait_shape)?;
            concealed_tiles.extend(shape_tiles);

            // An honor pair cannot interact with the suited wait shape.
            let pair_tile = self.draw_shouminkan_pair(&mut deck, pon_tile, value_tile)?;
            concealed_tiles.push(pair_tile);
            concealed_tiles.push(pair_tile);

            // Complete the remaining blocks in suits untouched by the wait.
            // A ryanmen shape needs two extra sets without the value triplet;
            // a three-sided shape needs one.
            let extra_sets = match (wait_shape, value_tile.is_some()) {
                (ShouminkanWaitShape::Ryanmen, false) => 2,
                (ShouminkanWaitShape::Ryanmen, true) => 1,
                (ShouminkanWaitShape::ThreeSided, false) => 1,
                (ShouminkanWaitShape::ThreeSided, true) => 0,
            };
            let mut used_suits = Vec::new();
            for _ in 0..extra_sets {
                let candidates: Vec<Suit> = [Suit::Man, Suit::Pin, Suit::Sou]
                    .into_iter()
                    .filter(|&suit| suit != shape_suit && !used_suits.contains(&suit))
                    .collect();
                let set_suit =
                    choose(&candidates).ok_or_else(|| "No secondary suit available".to_string())?;
                used_suits.push(set_suit);
                concealed_tiles.extend(self.draw_shouminkan_set(&mut deck, set_suit)?);
            }

            if concealed_tiles.len() != 10 {
                continue;
            }

            // Every winning tile must still be live in the wall.
            if wait_tiles
                .iter()
                .any(|tile| deck.get(tile).copied().unwrap_or(0) == 0)
            {
                continue;
            }

            let mut full_tiles = concealed_tiles.clone();
            full_tiles.push(pon_tile);
            full_tiles.extend(open_pon_tiles.iter().copied());
            if full_tiles.len() != 14 || validate_hand(&full_tiles).is_err() {
                continue;
            }

            let mut post_discard_tiles = concealed_tiles.clone();
            post_discard_tiles.extend(open_pon_tiles.iter().copied());
            let post_counts = to_counts(&post_discard_tiles);
            if calculate_shanten(&post_counts).shanten != 0 {
                continue;
            }

            let ukeire = calculate_ukeire(&post_counts);
            let ukeire_tiles: Vec<Tile> = ukeire.tiles.iter().map(|u| u.tile).collect();
            if ukeire_tiles.len() != wait_tiles.len()
                || !wait_tiles.iter().all(|tile| ukeire_tiles.contains(tile))
            {
                continue;
            }

            let min_han = if triggers.good_wait_and_value { 2 } else { 1 };
            if !self.shouminkan_waits_have_value(&concealed_tiles, pon_tile, &wait_tiles, min_han) {
                continue;
            }

            concealed_tiles.sort();
            let mut wait_tiles = wait_tiles;
            wait_tiles.sort();

            return Ok(ShouminkanSkeleton {
                open_pon_tiles,
                drawn_tile: pon_tile,
                concealed_tiles,
                wait_tiles,
            });
        }

        Err("Failed to construct a valid Added Kan skeleton".to_string())
    }

    /// Chooses the suited tiles that form a two-sided or three-sided wait.
    fn build_shouminkan_wait_shape(
        &self,
        deck: &mut HashMap<Tile, u8>,
        wait_shape: ShouminkanWaitShape,
    ) -> Result<(Vec<Tile>, Vec<Tile>, Suit), String> {
        let suits = [Suit::Man, Suit::Pin, Suit::Sou];
        let suit = choose(&suits).ok_or_else(|| "No suit available".to_string())?;

        let (shape_tiles, wait_tiles) = match wait_shape {
            ShouminkanWaitShape::Ryanmen => {
                // 23 waits on 1/4, 78 waits on 6/9.
                let base = gen_range(2, 8) as u8;
                (
                    vec![Tile::suited(suit, base), Tile::suited(suit, base + 1)],
                    vec![Tile::suited(suit, base - 1), Tile::suited(suit, base + 2)],
                )
            }
            ShouminkanWaitShape::ThreeSided => {
                // 23456 waits on 1/4/7, 34567 on 2/5/8, 45678 on 3/6/9.
                let start = gen_range(2, 5) as u8;
                let shape_tiles = (start..start + 5)
                    .map(|value| Tile::suited(suit, value))
                    .collect();
                let wait_tiles = vec![
                    Tile::suited(suit, start - 1),
                    Tile::suited(suit, start + 2),
                    Tile::suited(suit, start + 5),
                ];
                (shape_tiles, wait_tiles)
            }
        };

        for tile in &shape_tiles {
            remove_tile(deck, tile)?;
        }

        Ok((shape_tiles, wait_tiles, suit))
    }

    /// Draws an honor pair that does not collide with the dragon triplets.
    fn draw_shouminkan_pair(
        &self,
        deck: &mut HashMap<Tile, u8>,
        pon_tile: Tile,
        value_tile: Option<Tile>,
    ) -> Result<Tile, String> {
        let candidates: Vec<Tile> = ALL_TILES
            .iter()
            .copied()
            .filter(|&tile| {
                tile.is_honor()
                    && tile != pon_tile
                    && Some(tile) != value_tile
                    && deck.get(&tile).copied().unwrap_or(0) >= 2
            })
            .collect();
        let pair = choose(&candidates).ok_or_else(|| "No honor pair available".to_string())?;
        remove_tile(deck, &pair)?;
        remove_tile(deck, &pair)?;
        Ok(pair)
    }

    /// Draws a complete sequence or triplet from one suit.
    fn draw_shouminkan_set(
        &self,
        deck: &mut HashMap<Tile, u8>,
        suit: Suit,
    ) -> Result<Vec<Tile>, String> {
        let mut candidates: Vec<Vec<Tile>> = Vec::new();

        for start in 1..=7u8 {
            let tiles = vec![
                Tile::suited(suit, start),
                Tile::suited(suit, start + 1),
                Tile::suited(suit, start + 2),
            ];
            if tiles
                .iter()
                .all(|tile| deck.get(tile).copied().unwrap_or(0) > 0)
            {
                candidates.push(tiles);
            }
        }

        for value in 1..=9u8 {
            let tile = Tile::suited(suit, value);
            if deck.get(&tile).copied().unwrap_or(0) >= 3 {
                candidates.push(vec![tile; 3]);
            }
        }

        let set = choose(&candidates)
            .ok_or_else(|| "No complete set available in the selected suit".to_string())?;
        for tile in &set {
            remove_tile(deck, tile)?;
        }
        Ok(set)
    }

    /// The lowest yaku han across every winning tile, before any Kan dora.
    fn shouminkan_min_wait_han(
        &self,
        concealed_tiles: &[Tile],
        open_pon_tile: Tile,
        wait_tiles: &[Tile],
    ) -> u8 {
        let open_meld = Meld::koutsu_open(open_pon_tile);
        let mut min_han = u8::MAX;

        for &wait_tile in wait_tiles {
            let mut concealed_with_win = concealed_tiles.to_vec();
            concealed_with_win.push(wait_tile);
            let concealed_counts = to_counts(&concealed_with_win);
            let structures =
                decompose_hand_with_melds(&concealed_counts, std::slice::from_ref(&open_meld));
            if structures.is_empty() {
                return 0;
            }

            let mut full_with_win = concealed_with_win;
            full_with_win.extend([open_pon_tile; 3]);
            let full_counts = to_counts(&full_with_win);
            let context = GameContext::new(WinType::Ron, Honor::East, Honor::East)
                .with_winning_tile(wait_tile)
                .open();

            let han = structures
                .iter()
                .map(|structure| {
                    detect_yaku_with_context(structure, &full_counts, &context).total_han
                })
                .min()
                .unwrap_or(0);
            min_han = min_han.min(han);
        }

        if wait_tiles.is_empty() { 0 } else { min_han }
    }

    /// Verifies every winning tile scores at least `min_han` before Kan dora.
    fn shouminkan_waits_have_value(
        &self,
        concealed_tiles: &[Tile],
        open_pon_tile: Tile,
        wait_tiles: &[Tile],
        min_han: u8,
    ) -> bool {
        self.shouminkan_min_wait_han(concealed_tiles, open_pon_tile, wait_tiles) >= min_han
    }

    /// Builds and validates a complete Added Kan board.
    fn build_shouminkan_board(
        &self,
        category: &str,
        skeleton: &ShouminkanSkeleton,
        triggers: ShouminkanTriggerSet,
    ) -> Result<GameState, String> {
        let full_tiles = skeleton.full_tiles();
        validate_hand(&full_tiles)?;

        let mut deck = fresh_deck();
        for tile in &full_tiles {
            remove_tile(&mut deck, tile)?;
        }

        // Never make the Pon tile itself dora; the lesson's value must come
        // from hand structure rather than an obvious Kan dora.
        let dora_candidates: Vec<Tile> = ALL_TILES
            .iter()
            .copied()
            .filter(|&indicator| {
                indicator_to_dora(indicator) != skeleton.drawn_tile
                    && deck.get(&indicator).copied().unwrap_or(0) > 0
            })
            .collect();
        let dora_indicator =
            choose(&dora_candidates).ok_or_else(|| "No legal dora indicator".to_string())?;
        remove_tile(&mut deck, &dora_indicator)?;

        let ura_candidates: Vec<Tile> = ALL_TILES
            .iter()
            .copied()
            .filter(|&indicator| {
                indicator_to_dora(indicator) != skeleton.drawn_tile
                    && deck.get(&indicator).copied().unwrap_or(0) > 0
            })
            .collect();
        let ura_indicator =
            choose(&ura_candidates).ok_or_else(|| "No legal ura indicator".to_string())?;
        remove_tile(&mut deck, &ura_indicator)?;

        let (round_wind, hand_number) = if triggers.placement_desperation {
            (Wind::South, 4)
        } else {
            random_round()
        };
        let human_wind = choose(&Wind::ALL).ok_or_else(|| "No seat wind available".to_string())?;

        let scores = if triggers.placement_desperation {
            let human_rank = gen_range(1, 3);
            scores_for_seats(placement_desperation_ranked_scores(human_rank), human_rank)
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
            if !(rank == 2 || rank == 3) || above - human_score >= 2_000 {
                return Err(format!(
                    "Human must be 2nd/3rd within 2,000 points, got rank {rank} and gap {}",
                    above - human_score
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

        let discard_count = if triggers.late_game {
            gen_range(13, 17)
        } else if triggers.placement_desperation || triggers.losing_badly {
            gen_range(8, 13)
        } else {
            gen_range(2, 7)
        };

        let opponent_meta = [(1usize, "Shimocha"), (2, "Toimen"), (3, "Kamicha")];

        let mut opponent_players = Vec::with_capacity(3);
        let mut opponent_rivers: Vec<Vec<Tile>> = Vec::with_capacity(3);
        for (index, (seat, name)) in opponent_meta.iter().enumerate() {
            let hand = draw_tiles(&mut deck, 13)
                .ok_or_else(|| "Deck exhausted drawing an opponent hand".to_string())?;
            let river = draw_tiles(&mut deck, discard_count)
                .ok_or_else(|| "Deck exhausted drawing an opponent river".to_string())?;
            opponent_rivers.push(river.clone());
            opponent_players.push(PlayerState {
                seat: *seat,
                name: name.to_string(),
                is_human: false,
                wind: human_wind.next(*seat),
                score: scores[index + 1],
                hand: hand.iter().map(|tile| tile.to_string()).collect(),
                draw: None,
                red_fives: Vec::new(),
                discards: discards_from_tiles(&river),
                melds: Vec::new(),
                is_riichi: false,
                riichi_discard_index: None,
            });
        }

        // The human is not furiten: neither wait may appear in their river.
        let human_river = draw_tiles_excluding(&mut deck, discard_count, &skeleton.wait_tiles)
            .ok_or_else(|| "Deck exhausted drawing the human river".to_string())?;

        // Reject a wait whose every copy is already visible in a river or the
        // dora indicators.
        let mut visible_wait_counts: HashMap<Tile, u8> = HashMap::new();
        for river in &opponent_rivers {
            for &tile in river {
                *visible_wait_counts.entry(tile).or_insert(0) += 1;
            }
        }
        for indicator in [dora_indicator, ura_indicator] {
            *visible_wait_counts.entry(indicator).or_insert(0) += 1;
        }
        for wait_tile in &skeleton.wait_tiles {
            if visible_wait_counts.get(wait_tile).copied().unwrap_or(0) >= 4 {
                return Err(format!("Wait tile {wait_tile} is completely visible"));
            }
        }

        let mut concealed_hand = skeleton.concealed_tiles.clone();
        concealed_hand.sort();

        let mut post_discard_tiles = concealed_hand.clone();
        post_discard_tiles.extend(skeleton.open_pon_tiles.iter().copied());
        let post_counts = to_counts(&post_discard_tiles);
        let shanten_res = calculate_shanten(&post_counts);
        let decompositions = decompose_hand(&post_counts);
        let ukeire_res = calculate_ukeire(&post_counts);

        if shanten_res.shanten != 0 {
            return Err("Added Kan discard must leave a tenpai hand".to_string());
        }
        if triggers.good_wait_and_value && !matches!(skeleton.wait_tiles.len(), 2 | 3) {
            return Err("Good-wait scenario must have a ryanmen or three-sided wait".to_string());
        }

        let remaining_tiles: usize = deck.values().map(|&count| count as usize).sum();
        let tiles_remaining = remaining_tiles.saturating_sub(12).min(u8::MAX as usize) as u8;
        if tiles_remaining == 0 {
            return Err("No drawable tiles remain".to_string());
        }
        if triggers.late_game && tiles_remaining >= 20 {
            return Err(format!(
                "Late-game scenario must leave fewer than 20 wall tiles, got {tiles_remaining}"
            ));
        }

        let mut display_tiles = full_tiles.clone();
        display_tiles.sort();
        let hand_string = format_hand_compact(&display_tiles);
        let tile_strings: Vec<String> = display_tiles.iter().map(|tile| tile.to_string()).collect();
        let ukeire_tiles: Vec<String> = ukeire_res
            .tiles
            .iter()
            .map(|u| u.tile.to_string())
            .collect();
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
        players.extend(opponent_players);

        Ok(GameState {
            category: category.to_string(),
            target_action: TargetAction::Kan,
            correct_action: CorrectAction::kan(skeleton.drawn_tile.to_string()),
            riichi_triggers: Vec::new(),
            dama_reasons: Vec::new(),
            shouminkan_triggers: triggers.to_vec(),
            hand_string,
            tiles: tile_strings,
            shanten: shanten_res.shanten,
            is_agari: false,
            decompositions_count: decompositions.len(),
            ukeire_tiles,
            ukeire_total: ukeire_res.total_count,
            round_wind,
            hand_number,
            honba: gen_range(0, 4) as u8,
            riichi_sticks: 0,
            dora_indicators: vec![dora_indicator.to_string()],
            ura_dora_indicators: vec![ura_indicator.to_string()],
            tiles_remaining,
            current_turn: 0,
            players,
        })
    }

    /// Dispatches to the requested scenario. Unknown categories fall back to
    /// the first real Block Theory scenario; "mock_table" keeps the Phase 2
    /// fixture available for UI scaffolding and tests.
    pub fn generate_puzzle(&self, category: &str) -> Result<GameState, String> {
        match category {
            "mock_table" => self.generate_mock_puzzle(category),
            "chiitoitsu_riichi_vs_dama" => self.generate_chiitoitsu_riichi_vs_dama(category),
            "shouminkan_decision" => self.generate_shouminkan_decision(category),
            _ => self.generate_ryanmen_protorun(category),
        }
    }

    /// Evaluates a random 14-tile hand and populates the complete mocked
    /// `GameState` table used by the Phase 2 UI fixture.
    fn generate_mock_puzzle(&self, category: &str) -> Result<GameState, String> {
        let tiles = self.generate_random_hand();
        validate_hand(&tiles)?;

        let counts = to_counts(&tiles);
        let shanten_res = calculate_shanten(&counts);
        let decompositions = decompose_hand(&counts);
        let ukeire_res = calculate_ukeire(&counts);

        let hand_string = format_hand_compact(&tiles);
        let tile_strings: Vec<String> = tiles.iter().map(|t| t.to_string()).collect();
        let ukeire_tiles: Vec<String> = ukeire_res
            .tiles
            .iter()
            .map(|u| u.tile.to_string())
            .collect();

        // Separate human hand into 13 standing hand tiles + 1 active draw
        let human_standing_hand: Vec<String> = tile_strings[0..13].to_vec();
        let human_draw: Option<String> = tile_strings.get(13).cloned();
        let correct_discard = human_draw
            .clone()
            .or_else(|| human_standing_hand.first().cloned())
            .unwrap_or_default();

        // Player 0: Human User (Dealer / East)
        let player0 = PlayerState {
            seat: 0,
            name: "You".to_string(),
            is_human: true,
            wind: Wind::East,
            score: 25000,
            hand: human_standing_hand,
            draw: human_draw,
            red_fives: Vec::new(),
            discards: vec![
                DiscardTile::new("1z"),
                DiscardTile::new("9m"),
                DiscardTile::new("1p"),
                DiscardTile::tsumogiri("9s"),
                DiscardTile::new("2z"),
                DiscardTile::tsumogiri("8s"),
            ],
            melds: Vec::new(),
            is_riichi: false,
            riichi_discard_index: None,
        };

        // Player 1: Shimocha (South) - Has called Chi
        let player1 = PlayerState {
            seat: 1,
            name: "Shimocha".to_string(),
            is_human: false,
            wind: Wind::South,
            score: 25000,
            hand: vec![
                "1m".into(),
                "1m".into(),
                "2m".into(),
                "3m".into(),
                "4p".into(),
                "5p".into(),
                "6p".into(),
                "7s".into(),
                "8s".into(),
                "9s".into(),
            ],
            draw: None,
            red_fives: Vec::new(),
            discards: vec![
                DiscardTile::new("9m"),
                DiscardTile::new("1s"),
                DiscardTile::new("4z"),
                DiscardTile::tsumogiri("8p"),
                DiscardTile::new("2m"),
                DiscardTile::tsumogiri("3p"),
            ],
            melds: vec![CalledMeld {
                meld_type: MeldType::Chi,
                tiles: vec!["2s".to_string(), "3s".to_string(), "4s".to_string()],
                called_from: Some(0),
            }],
            is_riichi: false,
            riichi_discard_index: None,
        };

        // Player 2: Toimen (West) - In Riichi! Discard #5 ("6p") was the Riichi declaration tile
        let player2 = PlayerState {
            seat: 2,
            name: "Toimen".to_string(),
            is_human: false,
            wind: Wind::West,
            score: 24000, // Deducted 1000 for Riichi stick
            hand: vec![
                "1p".into(),
                "2p".into(),
                "3p".into(),
                "4s".into(),
                "5s".into(),
                "6s".into(),
                "7m".into(),
                "8m".into(),
                "9m".into(),
                "1m".into(),
                "2m".into(),
                "3m".into(),
                "7z".into(),
            ],
            draw: None,
            red_fives: Vec::new(),
            discards: vec![
                DiscardTile::new("1z"),
                DiscardTile::new("9p"),
                DiscardTile::new("1m"),
                DiscardTile::tsumogiri("7s"),
                DiscardTile::new("3z"),
                DiscardTile::riichi("6p"), // Riichi declaration tile (rotated in UI)
                DiscardTile::tsumogiri("8m"),
            ],
            melds: Vec::new(),
            is_riichi: true,
            riichi_discard_index: Some(5),
        };

        // Player 3: Kamicha (North) - Has called Pon of White Dragons
        let player3 = PlayerState {
            seat: 3,
            name: "Kamicha".to_string(),
            is_human: false,
            wind: Wind::North,
            score: 26000,
            hand: vec![
                "3m".into(),
                "4m".into(),
                "5m".into(),
                "2p".into(),
                "3p".into(),
                "4p".into(),
                "6s".into(),
                "7s".into(),
                "8s".into(),
                "1z".into(),
            ],
            draw: None,
            red_fives: Vec::new(),
            discards: vec![
                DiscardTile::new("7z"),
                DiscardTile::new("1s"),
                DiscardTile::new("9s"),
                DiscardTile::tsumogiri("2m"),
                DiscardTile::new("1m"),
                DiscardTile::tsumogiri("4p"),
            ],
            melds: vec![CalledMeld {
                meld_type: MeldType::Pon,
                tiles: vec!["5z".to_string(), "5z".to_string(), "5z".to_string()],
                called_from: Some(2),
            }],
            is_riichi: false,
            riichi_discard_index: None,
        };

        Ok(GameState {
            category: category.to_string(),
            target_action: TargetAction::Riichi,
            correct_action: CorrectAction::riichi(correct_discard),
            riichi_triggers: Vec::new(),
            dama_reasons: Vec::new(),
            shouminkan_triggers: Vec::new(),

            hand_string,
            tiles: tile_strings,
            shanten: shanten_res.shanten,
            is_agari: shanten_res.shanten == -1,
            decompositions_count: decompositions.len(),
            ukeire_tiles,
            ukeire_total: ukeire_res.total_count,

            round_wind: Wind::East,
            hand_number: 1,
            honba: 1,
            riichi_sticks: 1,
            dora_indicators: vec!["5p".to_string()],
            ura_dora_indicators: vec!["9s".to_string()],
            tiles_remaining: 62,

            current_turn: 0,
            players: vec![player0, player1, player2, player3],
        })
    }
}

/// Standalone function for generating a 14-tile hand via 5-block theory.
pub fn generate_random_hand() -> Vec<Tile> {
    ScenarioGenerator::new().generate_random_hand()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::CorrectActionType;
    use agari::context::indicator_to_dora;
    use agari::parse::parse_hand;

    fn assert_ryanmen_constraints(state: &GameState) {
        assert_eq!(state.category, "ryanmen_protorun");
        assert_eq!(state.target_action, TargetAction::NaniKiru);
        assert_eq!(state.correct_action.action_type(), CorrectActionType::Dama);
        assert_eq!(state.tiles.len(), 14);
        assert_eq!(state.players.len(), 4);

        // Round constraint: South 2 or earlier.
        match (state.round_wind, state.hand_number) {
            (Wind::East, 1..=4) | (Wind::South, 1..=2) => {}
            other => panic!("invalid round: {other:?}"),
        }
        assert_eq!(state.riichi_sticks, 0);
        assert_eq!(state.dora_indicators.len(), 1);
        assert_eq!(state.ura_dora_indicators.len(), 1);
        assert!(state.tiles_remaining > 0);

        // Threat constraint: no opponent is in riichi or has an open meld.
        for opponent in &state.players[1..] {
            assert!(!opponent.is_riichi, "opponent must not be in riichi");
            assert!(opponent.melds.is_empty(), "opponent must have no melds");
            assert!(opponent.riichi_discard_index.is_none());
        }

        // Human hand, open Yakuhai, and draw.
        let human = &state.players[0];
        assert!(human.is_human);
        assert!(!human.is_riichi);
        assert_eq!(human.hand.len(), 10);
        assert_eq!(human.draw.as_deref(), Some(state.correct_action.tile()));
        assert_eq!(human.melds.len(), 1);
        assert_eq!(human.melds[0].meld_type, MeldType::Pon);
        assert_eq!(human.melds[0].tiles.len(), 3);
        assert!(
            human.melds[0]
                .tiles
                .iter()
                .all(|tile| tile == &human.melds[0].tiles[0])
        );
        assert!(matches!(
            human.melds[0].tiles[0].as_str(),
            "5z" | "6z" | "7z"
        ));

        // Every player has taken the same number of turns and discarded once
        // per turn. The human is currently about to discard.
        let discard_counts: Vec<usize> = state
            .players
            .iter()
            .map(|player| player.discards.len())
            .collect();
        assert!(
            discard_counts
                .iter()
                .all(|&count| count == discard_counts[0]),
            "discard counts must line up: {discard_counts:?}"
        );
        assert!((1..=6).contains(&discard_counts[0]));

        // The only wait is the live two-sided ryanmen.
        assert_eq!(state.ukeire_tiles.len(), 2);
        let wait_tiles = &state.ukeire_tiles;

        // Furiten constraint: the human river excludes both wait tiles.
        for discard in &human.discards {
            assert!(
                !wait_tiles.contains(&discard.tile),
                "human river contains furiten tile {}",
                discard.tile
            );
        }

        // Wait chance constraint: <= 2 wait tiles visible in opponent rivers
        // or the dora indicator.
        let mut visible_wait_tiles = 0;
        for opponent in &state.players[1..] {
            for discard in &opponent.discards {
                if wait_tiles.contains(&discard.tile) {
                    visible_wait_tiles += 1;
                }
            }
        }
        for indicator in &state.dora_indicators {
            if wait_tiles.contains(indicator) {
                visible_wait_tiles += 1;
            }
        }
        assert!(
            visible_wait_tiles <= 2,
            "{visible_wait_tiles} wait tiles are visible"
        );
        assert!(8 - visible_wait_tiles >= 2);

        // Value constraint: the duplicate is not the actual dora.
        let indicator = parse_hand(&state.dora_indicators[0])
            .expect("dora indicator must parse")
            .remove(0);
        assert_ne!(
            indicator_to_dora(indicator).to_string(),
            state.correct_action.tile()
        );

        // Scores stay on the 100,000-point table.
        let total_score: i32 = state.players.iter().map(|player| player.score).sum();
        assert_eq!(total_score, 100_000);

        // The visible full hand is exactly hand + draw + open meld.
        let mut expected: Vec<String> = human.hand.clone();
        expected.push(human.draw.clone().expect("human must have a draw"));
        expected.extend(human.melds[0].tiles.iter().cloned());
        expected.sort();
        let mut actual = state.tiles.clone();
        actual.sort();
        assert_eq!(actual, expected);
    }

    fn parse_tile(code: &str) -> Tile {
        parse_hand(code).expect("tile code must parse").remove(0)
    }

    fn chiitoitsu_state_tiles(state: &GameState) -> (Vec<Tile>, Tile, Tile) {
        let human = &state.players[0];
        let hand_tiles: Vec<Tile> = human.hand.iter().map(|tile| parse_tile(tile)).collect();
        let wait = parse_tile(&state.ukeire_tiles[0]);
        let discard = parse_tile(
            human
                .draw
                .as_deref()
                .expect("chiitoitsu human must have a draw"),
        );
        let mut winning = hand_tiles;
        winning.push(wait);
        (winning, wait, discard)
    }

    fn chiitoitsu_trigger_holds(state: &GameState, trigger: RiichiTrigger) -> bool {
        let human = &state.players[0];
        let (winning, wait, _) = chiitoitsu_state_tiles(state);
        let counts = to_counts(&winning);

        match trigger {
            RiichiTrigger::Dealer => human.wind == Wind::East,
            RiichiTrigger::Tanyao => {
                counts
                    .iter()
                    .filter(|(_, count)| **count == 2)
                    .all(|(&tile, _)| tile.is_simple())
                    && wait.is_simple()
            }
            RiichiTrigger::RedFiveWait => {
                wait.value() == Some(5)
                    && human.red_fives.iter().any(|tile| tile == &wait.to_string())
            }
            RiichiTrigger::SujiTrap => {
                let suji: Vec<String> = suji_tiles(wait)
                    .iter()
                    .map(|tile| tile.to_string())
                    .collect();
                human
                    .discards
                    .iter()
                    .any(|discard| suji.contains(&discard.tile))
            }
            RiichiTrigger::WaitOutside456 => is_outside_456(wait),
            RiichiTrigger::ScoreBelowMangan => {
                let indicator = parse_tile(&state.dora_indicators[0]);
                let aka = human.red_fives.len() as u8;
                regular_dora_in_hand(&winning, indicator) + aka <= 1
            }
        }
    }

    #[test]
    fn test_chiitoitsu_riichi_vs_dama_constraints() {
        let generator = ScenarioGenerator::new();
        let mut riichi_count = 0;
        let mut dama_count = 0;

        for run in 0..200 {
            let state = generator
                .generate_puzzle("chiitoitsu_riichi_vs_dama")
                .unwrap_or_else(|err| panic!("run {run} failed: {err}"));

            assert_eq!(state.category, "chiitoitsu_riichi_vs_dama");

            let human = &state.players[0];
            assert!(human.is_human);
            assert!(human.melds.is_empty());
            assert!(!human.is_riichi);
            assert_eq!(human.hand.len(), 13);
            let draw = human
                .draw
                .clone()
                .expect("chiitoitsu human must have a draw");
            assert_eq!(draw, state.correct_action.tile());

            let mut expected = human.hand.clone();
            expected.push(draw);
            expected.sort();
            let mut actual = state.tiles.clone();
            actual.sort();
            assert_eq!(actual, expected, "run {run}: displayed tiles must match");

            let (winning, wait, discard) = chiitoitsu_state_tiles(&state);
            assert_eq!(winning.len(), 14);
            assert_ne!(wait, discard);

            let hand_counts = to_counts(
                &human
                    .hand
                    .iter()
                    .map(|tile| parse_tile(tile))
                    .collect::<Vec<_>>(),
            );
            let pair_count = hand_counts.values().filter(|&&count| count == 2).count();
            let singleton_count = hand_counts.values().filter(|&&count| count == 1).count();
            assert_eq!(hand_counts.len(), 7);
            assert_eq!(pair_count, 6);
            assert_eq!(singleton_count, 1);
            assert_eq!(hand_counts.get(&wait), Some(&1));
            assert!(!hand_counts.contains_key(&discard));

            assert_eq!(state.ukeire_tiles.len(), 1);
            assert_eq!(calculate_shanten(&hand_counts).shanten, 0);
            let ukeire = calculate_ukeire(&hand_counts);
            assert_eq!(ukeire.tiles.len(), 1);
            assert_eq!(ukeire.tiles[0].tile, wait);

            for indicator in &state.dora_indicators {
                assert_ne!(
                    indicator_to_dora(parse_tile(indicator)),
                    wait,
                    "run {run}: the wait must never be the dora"
                );
            }
            let ura_indicator = parse_tile(&state.ura_dora_indicators[0]);
            assert_ne!(indicator_to_dora(ura_indicator), wait);

            for discard_tile in &human.discards {
                assert_ne!(
                    discard_tile.tile,
                    wait.to_string(),
                    "run {run}: the human river is furiten"
                );
            }

            match state.correct_action.action_type() {
                CorrectActionType::Riichi => {
                    riichi_count += 1;
                    assert_eq!(state.target_action, TargetAction::Riichi);
                    assert!(
                        !state.riichi_triggers.is_empty(),
                        "run {run}: at least one Riichi trigger must apply"
                    );
                    assert!(state.dama_reasons.is_empty());
                    assert_eq!(state.dora_indicators.len(), 1);

                    for trigger in &state.riichi_triggers {
                        assert!(
                            chiitoitsu_trigger_holds(&state, *trigger),
                            "run {run}: trigger {trigger:?} does not hold"
                        );
                    }

                    let indicator = parse_tile(&state.dora_indicators[0]);
                    let aka = human.red_fives.len() as u8;
                    assert!(aka <= 1);
                    assert!(chiitoitsu_scores_below_mangan(
                        &winning,
                        wait,
                        state.round_wind,
                        human.wind,
                        indicator,
                        aka
                    ));
                }
                CorrectActionType::Dama => {
                    dama_count += 1;
                    assert_eq!(state.target_action, TargetAction::Dama);
                    assert!(state.riichi_triggers.is_empty());
                    assert_eq!(
                        state.dama_reasons,
                        vec![
                            DamaReason::NotDealer,
                            DamaReason::NoTanyao,
                            DamaReason::MiddleWait,
                            DamaReason::NoRedFiveWait,
                            DamaReason::NoSujiTrap,
                            DamaReason::Mangan,
                        ]
                    );
                    assert_eq!(state.dora_indicators.len(), 2);
                    assert_ne!(human.wind, Wind::East);
                    assert!(matches!(wait.value(), Some(4..=6)));
                    assert!(human.red_fives.is_empty());
                    assert!(!human.red_fives.iter().any(|tile| tile == &wait.to_string()));

                    let has_non_simple_pair = hand_counts
                        .iter()
                        .any(|(&tile, &count)| count == 2 && !tile.is_simple());
                    assert!(
                        has_non_simple_pair,
                        "run {run}: dama hand needs a terminal/honor pair"
                    );

                    let suji = suji_tiles(wait);
                    assert!(
                        !human.discards.iter().any(|discard| {
                            suji.iter().any(|suji| suji.to_string() == discard.tile)
                        }),
                        "run {run}: dama river contains a wait suji"
                    );

                    let total_dora: u8 = state
                        .dora_indicators
                        .iter()
                        .map(|indicator| regular_dora_in_hand(&winning, parse_tile(indicator)))
                        .sum();
                    assert_eq!(total_dora, 4, "run {run}: dama hand must inject four dora");

                    let indicators: Vec<Tile> = state
                        .dora_indicators
                        .iter()
                        .map(|t| parse_tile(t))
                        .collect();
                    let score_level = chiitoitsu_score_level(
                        &winning,
                        wait,
                        state.round_wind,
                        human.wind,
                        &indicators,
                        0,
                    )
                    .expect("dama hand must score as chiitoitsu");
                    assert!(
                        score_level >= ScoreLevel::Mangan,
                        "run {run}: dama hand is {score_level:?}, not Mangan or better"
                    );
                }
                CorrectActionType::Kan | CorrectActionType::Discard => {
                    panic!("run {run}: chiitoitsu scenario returned a Kan action")
                }
            }
        }

        assert!(riichi_count > 0, "no Riichi states were generated");
        assert!(dama_count > 0, "no dama states were generated");
    }

    #[test]
    fn test_dora_indicator_for_round_trips() {
        for &tile in &ALL_TILES {
            assert_eq!(indicator_to_dora(dora_indicator_for(tile)), tile);
        }
    }

    #[test]
    fn test_chiitoitsu_dama_rejection_sampling_100_hands() {
        let generator = ScenarioGenerator::new();
        let started = std::time::Instant::now();

        for run in 0..100 {
            let mut generated = None;
            for _ in 0..50 {
                let Ok(skeleton) = generator.build_dama_chiitoitsu_skeleton() else {
                    continue;
                };
                if let Ok(state) =
                    generator.build_chiitoitsu_board("chiitoitsu_riichi_vs_dama", &skeleton)
                {
                    generated = Some(state);
                    break;
                }
            }
            let state =
                generated.unwrap_or_else(|| panic!("run {run}: dama board failed after retries"));

            assert_eq!(state.target_action, TargetAction::Dama);
            assert_eq!(state.correct_action.action_type(), CorrectActionType::Dama);
            assert!(state.riichi_triggers.is_empty());
            assert_eq!(
                state.dama_reasons,
                vec![
                    DamaReason::NotDealer,
                    DamaReason::NoTanyao,
                    DamaReason::MiddleWait,
                    DamaReason::NoRedFiveWait,
                    DamaReason::NoSujiTrap,
                    DamaReason::Mangan,
                ]
            );

            let human = &state.players[0];
            let (winning, wait, _) = chiitoitsu_state_tiles(&state);
            let hand_counts = to_counts(
                &human
                    .hand
                    .iter()
                    .map(|tile| parse_tile(tile))
                    .collect::<Vec<_>>(),
            );

            assert_ne!(human.wind, Wind::East);
            assert!(matches!(wait.value(), Some(4..=6)));
            assert!(human.red_fives.is_empty());
            assert!(
                hand_counts
                    .iter()
                    .any(|(&tile, &count)| count == 2 && !tile.is_simple())
            );

            let suji = suji_tiles(wait);
            assert!(
                !human
                    .discards
                    .iter()
                    .any(|discard| suji.iter().any(|suji| suji.to_string() == discard.tile))
            );

            let indicators: Vec<Tile> = state
                .dora_indicators
                .iter()
                .map(|t| parse_tile(t))
                .collect();
            assert_eq!(indicators.len(), 2);
            let total_dora: u8 = indicators
                .iter()
                .map(|&indicator| regular_dora_in_hand(&winning, indicator))
                .sum();
            assert_eq!(total_dora, 4);

            let score_level = chiitoitsu_score_level(
                &winning,
                wait,
                state.round_wind,
                human.wind,
                &indicators,
                0,
            )
            .expect("dama hand must score as chiitoitsu");
            assert!(score_level >= ScoreLevel::Mangan);
        }

        let elapsed = started.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(5),
            "100 dama rejection-sampled hands took {elapsed:?}"
        );
    }

    #[test]
    fn test_chiitoitsu_each_trigger_can_be_applied() {
        let generator = ScenarioGenerator::new();
        let trigger_sets = [
            RiichiTriggerSet {
                dealer: true,
                ..Default::default()
            },
            RiichiTriggerSet {
                tanyao: true,
                ..Default::default()
            },
            RiichiTriggerSet {
                red_five_wait: true,
                ..Default::default()
            },
            RiichiTriggerSet {
                suji_trap: true,
                ..Default::default()
            },
            RiichiTriggerSet {
                wait_outside_456: true,
                ..Default::default()
            },
            RiichiTriggerSet {
                score_below_mangan: true,
                ..Default::default()
            },
        ];

        for triggers in trigger_sets {
            let mut generated = None;
            for _ in 0..50 {
                let Ok(skeleton) = generator.build_chiitoitsu_skeleton(triggers) else {
                    continue;
                };
                if let Ok(state) =
                    generator.build_chiitoitsu_board("chiitoitsu_riichi_vs_dama", &skeleton)
                {
                    generated = Some(state);
                    break;
                }
            }

            let state = generated
                .unwrap_or_else(|| panic!("could not generate a board for triggers {triggers:?}"));

            let expected = triggers.to_vec();
            assert_eq!(state.riichi_triggers, expected);
            for trigger in expected {
                assert!(chiitoitsu_trigger_holds(&state, trigger));
            }
        }
    }

    #[test]
    fn test_generate_random_hand_structure() {
        let generator = ScenarioGenerator::new();
        for _ in 0..20 {
            let hand = generator.generate_random_hand();
            assert_eq!(hand.len(), 14, "Hand must have exactly 14 tiles");

            assert!(validate_hand(&hand).is_ok());

            let compact = format_hand_compact(&hand);
            let parsed = parse_hand(&compact).expect("Compact notation must parse in agari");
            assert_eq!(parsed.len(), 14);
        }
    }

    #[test]
    fn test_generate_puzzle_game_state() {
        let generator = ScenarioGenerator::new();
        let state = generator
            .generate_puzzle("ryanmen_protorun")
            .expect("Puzzle generation must succeed");

        assert_ryanmen_constraints(&state);
        assert_eq!(state.shanten, 0);
        assert_eq!(state.ukeire_tiles.len(), 2);
        assert!(
            state
                .tiles
                .iter()
                .any(|tile| tile == state.correct_action.tile())
        );

        // Discarding the duplicate leaves the two-sided ryanmen wait.
        let mut post_discard = state.tiles.clone();
        let duplicate_index = post_discard
            .iter()
            .position(|tile| tile == state.correct_action.tile())
            .expect("correct tile must be in the full hand");
        post_discard.remove(duplicate_index);
        let post_tiles =
            parse_hand(&post_discard.join("")).expect("post-discard hand must parse in agari");
        let post_counts = to_counts(&post_tiles);
        assert_eq!(calculate_shanten(&post_counts).shanten, 0);
        let ukeire = calculate_ukeire(&post_counts);
        assert_eq!(ukeire.tiles.len(), 2);
        assert!(ukeire.total_count > 0);
    }

    #[test]
    fn test_unintended_yaku_is_rejected() {
        let generator = ScenarioGenerator::new();
        let pin = |value: u8| Tile::Suited {
            suit: Suit::Pin,
            value,
        };
        let man = |value: u8| Tile::Suited {
            suit: Suit::Man,
            value,
        };
        let sou = |value: u8| Tile::Suited {
            suit: Suit::Sou,
            value,
        };
        let haku = Tile::Honor(Honor::White);
        let dora_indicator = man(1);

        let make_skeleton = |concealed: Vec<Tile>| {
            let open = vec![haku, haku, haku];
            let mut full = concealed.clone();
            full.extend(open.iter().copied());
            let mut human_hand = concealed.clone();
            let duplicate_index = human_hand
                .iter()
                .position(|tile| *tile == pin(6))
                .expect("duplicate must be in concealed hand");
            human_hand.remove(duplicate_index);
            (
                RyanmenSkeleton {
                    full_tiles: full,
                    concealed_tiles: concealed,
                    shape_tiles: [pin(6), pin(6), pin(7)],
                    wait_tiles: [pin(5), pin(8)],
                    open_meld_tiles: open,
                    correct_tile: pin(6),
                },
                human_hand,
            )
        };

        // All-pinzu concealed hand plus the open Haku is Honitsu + Yakuhai.
        let (honitsu, honitsu_hand) = make_skeleton(vec![
            pin(1),
            pin(2),
            pin(3),
            pin(2),
            pin(3),
            pin(4),
            pin(9),
            pin(9),
            pin(6),
            pin(6),
            pin(7),
        ]);
        assert!(generator.has_unintended_yaku(&honitsu, &honitsu_hand, Wind::East, dora_indicator));

        // Sets spread across suits leave only the open Yakuhai.
        let (clean, clean_hand) = make_skeleton(vec![
            man(1),
            man(2),
            man(3),
            sou(2),
            sou(3),
            sou(4),
            sou(9),
            sou(9),
            pin(6),
            pin(6),
            pin(7),
        ]);
        assert!(!generator.has_unintended_yaku(&clean, &clean_hand, Wind::East, dora_indicator));
    }

    #[test]
    fn test_ryanmen_constraints_100_runs() {
        let generator = ScenarioGenerator::new();
        let start = std::time::Instant::now();

        for run in 0..100 {
            let state = generator
                .generate_puzzle("ryanmen_protorun")
                .unwrap_or_else(|err| panic!("run {run} failed: {err}"));
            assert_ryanmen_constraints(&state);
        }

        let elapsed = start.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(5),
            "100 rejected-sample generations took {elapsed:?}"
        );
    }

    #[test]
    fn test_mock_table_fixture_still_serves_phase2_shape() {
        let generator = ScenarioGenerator::new();
        let state = generator
            .generate_puzzle("mock_table")
            .expect("Mock table fixture must build");

        assert_eq!(state.category, "mock_table");
        assert_eq!(state.players[0].hand.len(), 13);
        assert!(state.players[2].is_riichi);
    }

    #[test]
    fn test_ryanmen_skeleton_generalizes() {
        use std::collections::HashSet;

        let generator = ScenarioGenerator::new();
        let mut suits = HashSet::new();
        let mut bases = HashSet::new();

        for _ in 0..100 {
            let skeleton = generator
                .build_ryanmen_skeleton()
                .expect("Ryanmen skeleton must build");

            assert_eq!(skeleton.full_tiles.len(), 14);
            assert_eq!(skeleton.concealed_tiles.len(), 11);
            assert_eq!(skeleton.open_meld_tiles.len(), 3);
            assert!(validate_hand(&skeleton.full_tiles).is_ok());

            let mut assembled = skeleton.concealed_tiles.clone();
            assembled.extend(skeleton.open_meld_tiles.iter().copied());
            assembled.sort();
            let mut full = skeleton.full_tiles.clone();
            full.sort();
            assert_eq!(assembled, full);

            let [a, b, c] = skeleton.shape_tiles;
            assert!(a == b || b == c, "shape must be XXY or XYY");
            let duplicate = if a == b { a } else { c };
            assert_eq!(skeleton.correct_tile, duplicate);

            let (x, y) = if a == b { (a, c) } else { (a, b) };
            let (wait_low, wait_high) = match (x, y) {
                (
                    Tile::Suited {
                        suit: suit_x,
                        value: value_x,
                    },
                    Tile::Suited {
                        suit: suit_y,
                        value: value_y,
                    },
                ) => {
                    assert_eq!(suit_x, suit_y);
                    assert_eq!(value_y, value_x + 1, "ryanmen tiles must be adjacent");
                    assert!(
                        (2..=7).contains(&value_x),
                        "lower ryanmen tile must stay within 2-7"
                    );
                    suits.insert(suit_x);
                    bases.insert(value_x);

                    (
                        Tile::Suited {
                            suit: suit_x,
                            value: value_x - 1,
                        },
                        Tile::Suited {
                            suit: suit_x,
                            value: value_x + 2,
                        },
                    )
                }
                _ => panic!("ryanmen shape must use suited tiles"),
            };
            assert_eq!(skeleton.wait_tiles, [wait_low, wait_high]);

            // The duplicate is the only discard that preserves the ryanmen.
            let mut post_discard = skeleton.full_tiles.clone();
            let duplicate_index = post_discard
                .iter()
                .position(|tile| *tile == skeleton.correct_tile)
                .expect("duplicate must be present");
            post_discard.remove(duplicate_index);
            assert_eq!(
                calculate_shanten(&to_counts(&post_discard)).shanten,
                0,
                "discarding the duplicate must leave tenpai"
            );

            let post_ukeire = calculate_ukeire(&to_counts(&post_discard));
            let wait_tiles: Vec<Tile> = post_ukeire.tiles.iter().map(|u| u.tile).collect();
            assert_eq!(wait_tiles.len(), 2);
            assert!(
                wait_tiles.contains(&wait_low) && wait_tiles.contains(&wait_high),
                "both sides of the ryanmen must remain live"
            );
        }

        assert!(suits.len() > 1, "generator must cover multiple suits");
        assert!(
            bases.len() > 1,
            "generator must cover multiple base numbers"
        );
    }

    fn human_rank(state: &GameState) -> usize {
        let human_score = state.players[0].score;
        1 + state
            .players
            .iter()
            .filter(|player| player.score > human_score)
            .count()
    }

    fn shouminkan_min_wait_han(state: &GameState, wait: Tile) -> u8 {
        let human = &state.players[0];
        let open_tile = parse_tile(&human.melds[0].tiles[0]);
        let open_meld = Meld::koutsu_open(open_tile);

        let mut concealed_with_win: Vec<Tile> =
            human.hand.iter().map(|tile| parse_tile(tile)).collect();
        concealed_with_win.push(wait);
        let concealed_counts = to_counts(&concealed_with_win);
        let structures = decompose_hand_with_melds(&concealed_counts, &[open_meld]);

        let mut full_with_win = concealed_with_win;
        full_with_win.extend([open_tile; 3]);
        let full_counts = to_counts(&full_with_win);
        let context = GameContext::new(
            WinType::Ron,
            wind_to_honor(state.round_wind),
            wind_to_honor(human.wind),
        )
        .with_winning_tile(wait)
        .open();

        structures
            .iter()
            .map(|structure| detect_yaku_with_context(structure, &full_counts, &context).total_han)
            .min()
            .unwrap_or(0)
    }

    fn shouminkan_trigger_holds(state: &GameState, trigger: ShouminkanTrigger) -> bool {
        let human = &state.players[0];

        match trigger {
            ShouminkanTrigger::GoodWaitAndValue => {
                if state.shanten != 0 || !matches!(state.ukeire_tiles.len(), 2 | 3) {
                    return false;
                }
                state
                    .ukeire_tiles
                    .iter()
                    .all(|tile| shouminkan_min_wait_han(state, parse_tile(tile)) >= 2)
            }
            ShouminkanTrigger::LateGame => {
                state.tiles_remaining < 20
                    && state
                        .players
                        .iter()
                        .all(|player| player.discards.len() >= 13)
            }
            ShouminkanTrigger::PlacementDesperation => {
                if state.round_wind != Wind::South || state.hand_number != 4 {
                    return false;
                }
                let human_score = human.score;
                let Some(above) = state
                    .players
                    .iter()
                    .filter(|player| player.score > human_score)
                    .map(|player| player.score)
                    .min()
                else {
                    return false;
                };
                matches!(human_rank(state), 2 | 3) && above - human_score < 2_000
            }
            ShouminkanTrigger::LosingBadly => {
                let human_score = human.score;
                let mut scores: Vec<i32> =
                    state.players.iter().map(|player| player.score).collect();
                scores.sort_by(|a, b| b.cmp(a));
                human_rank(state) == 4 && scores[2] - human_score > 12_000
            }
        }
    }

    fn assert_shouminkan_constraints(state: &GameState) {
        assert_eq!(state.category, "shouminkan_decision");
        assert_eq!(state.target_action, TargetAction::Kan);
        assert_eq!(state.correct_action.action_type(), CorrectActionType::Kan);
        assert_eq!(state.tiles.len(), 14);
        assert_eq!(state.players.len(), 4);
        assert_eq!(state.shanten, 0);
        assert!(matches!(state.ukeire_tiles.len(), 2 | 3));
        assert!(!state.shouminkan_triggers.is_empty());
        assert!(state.riichi_triggers.is_empty());
        assert!(state.dama_reasons.is_empty());
        assert_eq!(state.dora_indicators.len(), 1);
        assert_eq!(state.ura_dora_indicators.len(), 1);
        assert!(state.tiles_remaining > 0);

        let human = &state.players[0];
        assert!(human.is_human);
        assert!(!human.is_riichi);
        assert_eq!(human.hand.len(), 10);
        assert_eq!(human.melds.len(), 1);
        assert_eq!(human.melds[0].meld_type, MeldType::Pon);
        assert_eq!(human.melds[0].tiles.len(), 3);
        assert!(
            human.melds[0]
                .tiles
                .iter()
                .all(|tile| tile == &human.melds[0].tiles[0])
        );
        assert!(matches!(
            human.melds[0].tiles[0].as_str(),
            "5z" | "6z" | "7z"
        ));

        let draw = human
            .draw
            .as_deref()
            .expect("shouminkan human must have a draw");
        assert_eq!(draw, human.melds[0].tiles[0]);
        assert_eq!(draw, state.correct_action.tile());
        assert!(
            !human.hand.iter().any(|tile| tile == draw),
            "the only fourth copy must be the active draw"
        );

        let mut expected = human.hand.clone();
        expected.push(draw.to_string());
        expected.extend(human.melds[0].tiles.iter().cloned());
        expected.sort();
        let mut actual = state.tiles.clone();
        actual.sort();
        assert_eq!(actual, expected, "displayed tiles must match the hand");

        // The open Pon is the only meld at the table.
        for opponent in &state.players[1..] {
            assert!(opponent.melds.is_empty());
            assert!(!opponent.is_riichi);
        }

        // The human is not furiten on any winning tile.
        for wait in &state.ukeire_tiles {
            assert!(
                !human.discards.iter().any(|discard| &discard.tile == wait),
                "human river contains furiten tile {wait}"
            );
        }

        // The Pon tile is never the visible dora, so the Kan decision does not
        // lean on an accidental dora.
        let indicator = parse_tile(&state.dora_indicators[0]);
        assert_ne!(indicator_to_dora(indicator).to_string(), draw);
        let ura_indicator = parse_tile(&state.ura_dora_indicators[0]);
        assert_ne!(indicator_to_dora(ura_indicator).to_string(), draw);

        let total_score: i32 = state.players.iter().map(|player| player.score).sum();
        assert_eq!(total_score, 100_000);

        for trigger in &state.shouminkan_triggers {
            assert!(
                shouminkan_trigger_holds(state, *trigger),
                "trigger {trigger:?} does not hold"
            );
        }
    }

    #[test]
    fn test_shouminkan_decision_constraints() {
        let generator = ScenarioGenerator::new();
        let started = std::time::Instant::now();
        let mut counts = [0usize; 4];

        for run in 0..200 {
            let state = generator
                .generate_puzzle("shouminkan_decision")
                .unwrap_or_else(|err| panic!("run {run} failed: {err}"));
            assert_shouminkan_constraints(&state);

            for trigger in &state.shouminkan_triggers {
                let index = match trigger {
                    ShouminkanTrigger::GoodWaitAndValue => 0,
                    ShouminkanTrigger::LateGame => 1,
                    ShouminkanTrigger::PlacementDesperation => 2,
                    ShouminkanTrigger::LosingBadly => 3,
                };
                counts[index] += 1;
            }
        }

        assert!(
            counts.iter().all(|&count| count > 0),
            "trigger coverage: {counts:?}"
        );
        let elapsed = started.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(10),
            "200 shouminkan generations took {elapsed:?}"
        );
    }

    #[test]
    fn test_shouminkan_each_trigger_can_be_applied() {
        let generator = ScenarioGenerator::new();
        let trigger_sets = [
            ShouminkanTriggerSet {
                good_wait_and_value: true,
                ..Default::default()
            },
            ShouminkanTriggerSet {
                late_game: true,
                ..Default::default()
            },
            ShouminkanTriggerSet {
                placement_desperation: true,
                ..Default::default()
            },
            ShouminkanTriggerSet {
                losing_badly: true,
                ..Default::default()
            },
            ShouminkanTriggerSet {
                good_wait_and_value: true,
                late_game: true,
                ..Default::default()
            },
        ];

        for triggers in trigger_sets {
            let mut generated = None;
            for _ in 0..50 {
                let Ok(skeleton) = generator.build_shouminkan_skeleton(triggers) else {
                    continue;
                };
                if let Ok(state) =
                    generator.build_shouminkan_board("shouminkan_decision", &skeleton, triggers)
                {
                    generated = Some(state);
                    break;
                }
            }

            let state = generated
                .unwrap_or_else(|| panic!("could not generate a board for triggers {triggers:?}"));
            assert_eq!(state.shouminkan_triggers, triggers.to_vec());
            for trigger in triggers.to_vec() {
                assert!(shouminkan_trigger_holds(&state, trigger));
            }
        }
    }

    #[test]
    fn test_shouminkan_skeleton_generalizes() {
        let generator = ScenarioGenerator::new();

        for _ in 0..100 {
            let skeleton = generator
                .build_shouminkan_skeleton(ShouminkanTriggerSet {
                    good_wait_and_value: true,
                    ..Default::default()
                })
                .expect("shouminkan skeleton must build");

            assert_eq!(skeleton.full_tiles().len(), 14);
            assert_eq!(skeleton.concealed_tiles.len(), 10);
            assert_eq!(skeleton.open_pon_tiles.len(), 3);
            assert_eq!(skeleton.open_pon_tiles[0], skeleton.drawn_tile);
            assert_eq!(skeleton.open_pon_tiles[1], skeleton.drawn_tile);
            assert_eq!(skeleton.open_pon_tiles[2], skeleton.drawn_tile);
            assert!(validate_hand(&skeleton.full_tiles()).is_ok());

            let mut post_discard = skeleton.concealed_tiles.clone();
            post_discard.extend(skeleton.open_pon_tiles.iter().copied());
            let counts = to_counts(&post_discard);
            assert_eq!(calculate_shanten(&counts).shanten, 0);
            let ukeire = calculate_ukeire(&counts);
            let wait_tiles: Vec<Tile> = ukeire.tiles.iter().map(|u| u.tile).collect();
            assert_eq!(wait_tiles.len(), skeleton.wait_tiles.len());
            assert!(
                skeleton
                    .wait_tiles
                    .iter()
                    .all(|wait| wait_tiles.contains(wait))
            );

            for wait in &skeleton.wait_tiles {
                assert!(
                    generator.shouminkan_waits_have_value(
                        &skeleton.concealed_tiles,
                        skeleton.drawn_tile,
                        &[*wait],
                        2,
                    ),
                    "wait {wait} must score at least two han"
                );
            }
        }
    }

    #[test]
    fn test_shouminkan_non_good_hands_can_be_light() {
        let generator = ScenarioGenerator::new();
        let mut light_hands = 0;

        for _ in 0..50 {
            let skeleton = generator
                .build_shouminkan_skeleton(ShouminkanTriggerSet::default())
                .expect("non-good shouminkan skeleton must build");
            let han = generator.shouminkan_min_wait_han(
                &skeleton.concealed_tiles,
                skeleton.drawn_tile,
                &skeleton.wait_tiles,
            );
            assert!(han >= 1, "the open dragon Pon must always provide a yaku");
            if han < 2 {
                light_hands += 1;
            }
        }

        assert!(
            light_hands > 0,
            "non-good hands must not always guarantee two han"
        );
    }

    #[test]
    fn test_shouminkan_trigger_sets_are_non_empty_and_compatible() {
        for _ in 0..1_000 {
            let triggers = random_shouminkan_triggers();
            assert!(triggers.any());
            assert!(
                !(triggers.placement_desperation && triggers.losing_badly),
                "placement and losing triggers must not coexist"
            );
        }
    }
}
