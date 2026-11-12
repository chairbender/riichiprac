use agari::parse::{TileCounts, to_counts, validate_hand};
use agari::shanten::{calculate_shanten, calculate_ukeire};
use agari::tile::{Honor, Suit, Tile};

use crate::generator::support::deck::{ALL_TILES, Deck};
use crate::rng::{choose, gen_bool, gen_range, shuffle};

/// Which bulging-float decision the hand asks for.
///
/// The book's ready-hand example and its 1-away examples pull in opposite
/// directions, and that contrast is the lesson:
///
/// - [`Variant::ReadyDrop`] — a ready hand. Keeping the bulge waits on the tile
///   the hand already holds twice, so the book discards the bulge tile
///   (ch3:702).
/// - [`Variant::OneAwayKeep`] — a 1-away hand whose other blocks are weak. The
///   book keeps the bulge and throws a tile from a rival pair instead, even
///   though breaking the bulge would accept more tiles right now (ch4:694,
///   ch3:690).
/// - [`Variant::OneAwayBreak`] — a 1-away hand whose rival block has just
///   become decent. The same book now discards the bulge tile (ch4:725).
///
/// The answer therefore depends on the hand, not on the shape's name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Variant {
    ReadyDrop,
    OneAwayKeep,
    OneAwayBreak,
}

impl Variant {
    /// The variants in the order the drill draws them.
    pub(super) const ALL: [Variant; 3] = [
        Variant::ReadyDrop,
        Variant::OneAwayKeep,
        Variant::OneAwayBreak,
    ];
}

/// The constructed parts of one "bulging float" puzzle.
///
/// Riichi Book 1, ch. 3, "Four-tile complex shapes 2: nakabukure":
///
/// - "Any bulging float shapes from 2334 through 6778 can accept four kinds of
///   tiles to produce a side-wait protorun and a complete run." (ch3:681)
/// - "Try to keep a bulging float shape until a hand becomes 1-away." (ch3:708)
/// - "It is waiting for wan4, but we are already using two of it in the hand,
///   leaving only two winning tiles. We should rather discard wan4 to wait for
///   bei." (ch3:702)
///
/// and ch. 4's 5-block exercises, which show the same shape being kept in one
/// 1-away hand (Answer 13, ch4:694) and broken in the next (Exercise 14,
/// ch4:725).
pub(super) struct NakabukureSkeleton {
    /// Which decision this hand asks for.
    pub variant: Variant,
    /// All 14 tiles for evaluation, including any open Yakuhai meld.
    pub full_tiles: Vec<Tile>,
    /// The concealed tiles before the discard, including the drawn tile.
    pub concealed_tiles: Vec<Tile>,
    /// The four tiles of the bulging float (`x, x+1, x+1, x+2`).
    pub bulge_tiles: [Tile; 4],
    /// The middle tile `x+1`.
    pub bulge_tile: Tile,
    /// The tile just drawn.
    pub draw: Tile,
    /// The book's discard for this hand.
    pub answer_tile: Tile,
    /// The three tiles of the open Yakuhai meld, empty for a closed hand.
    pub open_meld_tiles: Vec<Tile>,
}

impl NakabukureSkeleton {
    /// The suit and base rank of the hand's one bulge, when it still has it.
    pub(super) fn bulge_start(&self) -> (Suit, u8) {
        bulge_start(self.bulge_tiles)
    }

    /// True when the book's discard leaves the whole bulging float intact.
    #[cfg(test)]
    pub(super) fn keeps_the_bulge(&self) -> bool {
        let keep = without(&self.full_tiles, self.answer_tile);
        keep.is_some_and(|tiles| bulge_starts(&tiles) == vec![self.bulge_start()])
    }

    /// True when the book's discard breaks the bulging float.
    #[cfg(test)]
    pub(super) fn breaks_the_bulge(&self) -> bool {
        let break_tiles = without(&self.full_tiles, self.answer_tile);
        break_tiles.is_some_and(|tiles| !bulge_starts(&tiles).contains(&self.bulge_start()))
    }
}

/// Picks the variant the next puzzle will ask about.
///
/// The variant is chosen before the hand is built so that the three answers
/// stay evenly mixed: rejection inside one variant never starves another.
pub(super) fn random_variant() -> Variant {
    Variant::ALL[gen_range(0, Variant::ALL.len())]
}

/// Builds the hand for one variant.
pub(super) fn build_variant(variant: Variant) -> Result<NakabukureSkeleton, String> {
    match variant {
        Variant::ReadyDrop => build_ready_drop(),
        Variant::OneAwayKeep => build_one_away_keep(),
        Variant::OneAwayBreak => build_one_away_break(),
    }
}

/// The book's ready-hand example (ch3:702): three complete sets, the bulging
/// float `x, x+1, x+1, x+2`, and one floating honour. The correct answer is the
/// bulge tile `x+1`; the tempting mistake is the floating honour.
fn build_ready_drop() -> Result<NakabukureSkeleton, String> {
    'attempt: for _ in 0..512 {
        let mut deck = Deck::fresh();

        let suits = [Suit::Man, Suit::Pin, Suit::Sou];
        let suit = choose(&suits).ok_or_else(|| "No suits available".to_string())?;

        // The book lists 2334 through 6778, so the run starts at 2..=6 and the
        // middle tile x+1 stays a 3..=7 middle tile.
        let base = gen_range(2, 7) as u8;
        let low = suited(suit, base);
        let mid = suited(suit, base + 1);
        let high = suited(suit, base + 2);
        let bulge_tiles = [low, mid, mid, high];
        for tile in &bulge_tiles {
            if deck.take(*tile).is_err() {
                continue 'attempt;
            }
        }

        // Open Yakuhai triplet: any dragon guarantees a yaku and makes Riichi
        // illegal, so the answer is the discard alone (dama).
        let dragons = [
            Tile::Honor(Honor::White),
            Tile::Honor(Honor::Green),
            Tile::Honor(Honor::Red),
        ];
        let dragon = choose(&dragons).ok_or_else(|| "No dragons available".to_string())?;
        let open_meld_tiles = vec![dragon, dragon, dragon];
        if deck.take_n(dragon, 3).is_err() {
            continue 'attempt;
        }

        // Two complete sets, both outside the bulge's suit. If a set shared the
        // suit, breaking it could recombine with the bulge into two sets and
        // leave a second, equally good tenpai discard.
        let other_suits: Vec<Suit> = suits.iter().copied().filter(|s| *s != suit).collect();
        let mut concealed_tiles = Vec::with_capacity(11);
        for _ in 0..2 {
            if !add_set(&mut concealed_tiles, &mut deck, &other_suits) {
                continue 'attempt;
            }
        }

        // One floating honor: the single-tile wait after the bulge is gone.
        let float_candidates: Vec<Tile> = ALL_TILES
            .iter()
            .copied()
            .filter(|tile| matches!(tile, Tile::Honor(_)) && *tile != dragon && deck.has(*tile))
            .collect();
        let float_tile = match choose(&float_candidates) {
            Some(tile) => tile,
            None => continue 'attempt,
        };
        if deck.take(float_tile).is_err() {
            continue 'attempt;
        }

        concealed_tiles.extend(bulge_tiles.iter().copied());
        concealed_tiles.push(float_tile);

        let mut full_tiles = concealed_tiles.clone();
        full_tiles.extend(open_meld_tiles.iter().copied());
        if validate_hand(&full_tiles).is_err() {
            continue 'attempt;
        }

        let skeleton = NakabukureSkeleton {
            variant: Variant::ReadyDrop,
            full_tiles,
            concealed_tiles,
            bulge_tiles,
            bulge_tile: mid,
            draw: float_tile,
            answer_tile: mid,
            open_meld_tiles,
        };

        if verify_ready_drop(&skeleton).is_ok() {
            return Ok(skeleton);
        }
    }

    Err("Failed to construct a valid nakabukure ready hand".to_string())
}

/// The ch. 4 Answer 13 hand (ch4:694): a 1-away hand where the bulge is the
/// best block left, so the book keeps it and throws a tile from the rival pair.
///
/// Shapes:
/// - the bulging float in a suit of its own, `x, x+1, x+1, x+2`;
/// - a rival pair plus a closed-wait protorun in the second suit;
/// - a pair with the drawn tile beside it, plus a complete run, in the third.
///
/// The answer is one copy of the third suit's pair: dropping it leaves the pair
/// partner beside the draw as a side-wait protorun. Breaking the bulge instead
/// accepts strictly more tiles, which is exactly the trap ch3:690 describes;
/// the book still keeps the bulge because the rest of the hand is weak.
fn build_one_away_keep() -> Result<NakabukureSkeleton, String> {
    'attempt: for _ in 0..1_024 {
        let mut deck = Deck::fresh();
        let [bulge_suit, rival_suit, answer_suit] = shuffled_suits();

        let base = gen_range(2, 7) as u8;
        let bulge_tiles = [
            suited(bulge_suit, base),
            suited(bulge_suit, base + 1),
            suited(bulge_suit, base + 1),
            suited(bulge_suit, base + 2),
        ];

        // Rival block: a closed-wait protorun and an unrelated pair.
        let closed_base = gen_range(1, 8) as u8;
        let rival = [
            suited(rival_suit, closed_base),
            suited(rival_suit, closed_base + 2),
        ];
        let rival_pair_value = gen_range(1, 10) as u8;
        let rival_pair = [suited(rival_suit, rival_pair_value); 2];

        // Answer block: a pair the draw just joined, and a complete run.
        let pair_value = gen_range(1, 9) as u8;
        let pair = [suited(answer_suit, pair_value); 2];
        let draw = suited(answer_suit, pair_value + 1);
        let run_base = gen_range(1, 8) as u8;
        let run = [
            suited(answer_suit, run_base),
            suited(answer_suit, run_base + 1),
            suited(answer_suit, run_base + 2),
        ];

        let mut concealed_tiles = Vec::with_capacity(14);
        concealed_tiles.extend(bulge_tiles.iter().copied());
        concealed_tiles.extend(rival.iter().copied());
        concealed_tiles.extend(rival_pair.iter().copied());
        concealed_tiles.extend(pair.iter().copied());
        concealed_tiles.push(draw);
        concealed_tiles.extend(run.iter().copied());

        if !take_all(&mut deck, &concealed_tiles) {
            continue 'attempt;
        }
        if validate_hand(&concealed_tiles).is_err() {
            continue 'attempt;
        }

        let skeleton = NakabukureSkeleton {
            variant: Variant::OneAwayKeep,
            full_tiles: concealed_tiles.clone(),
            concealed_tiles,
            bulge_tiles,
            bulge_tile: bulge_tiles[1],
            draw,
            answer_tile: pair[0],
            open_meld_tiles: Vec::new(),
        };

        if verify_one_away_keep(&skeleton).is_ok() {
            return Ok(skeleton);
        }
    }

    Err("Failed to construct a nakabukure keep-bulge hand".to_string())
}

/// The ch. 4 Exercise 14 hand (ch4:725): the rival block has become decent, so
/// the book discards the bulge tile to keep it.
///
/// Shapes:
/// - the bulging float in a suit of its own, `x, x+1, x+1, x+2`;
/// - a "group and head" block: two pairs with the drawn tile between them, so a
///   draw of either pair tile or either neighbour makes a run plus the head
///   (the book's `1m 1m 3m 5m 5m` waitting on `1m 2m 4m 5m`, ch4:725);
/// - a side-wait protorun and a complete run in the third suit.
///
/// The answer is the bulge tile: unlike the keep variant, counting tiles and
/// keeping the side waits point the same way here.
fn build_one_away_break() -> Result<NakabukureSkeleton, String> {
    'attempt: for _ in 0..1_024 {
        let mut deck = Deck::fresh();
        let [bulge_suit, rival_suit, wait_suit] = shuffled_suits();

        let base = gen_range(2, 7) as u8;
        let bulge_tiles = [
            suited(bulge_suit, base),
            suited(bulge_suit, base + 1),
            suited(bulge_suit, base + 1),
            suited(bulge_suit, base + 2),
        ];

        // The book's rival block: 1m 1m 3m 5m 5m with the 3m drawn. The float
        // sits two ranks below one pair and two above the other, so it accepts
        // four kinds to become a group and the head.
        let float_value = gen_range(3, 8) as u8;
        let rival = [
            suited(rival_suit, float_value - 2),
            suited(rival_suit, float_value - 2),
            suited(rival_suit, float_value),
            suited(rival_suit, float_value + 2),
            suited(rival_suit, float_value + 2),
        ];

        // Side-wait protorun and a complete run in the third suit.
        let side_base = gen_range(1, 9) as u8;
        let side = [
            suited(wait_suit, side_base),
            suited(wait_suit, side_base + 1),
        ];
        let run_base = gen_range(1, 8) as u8;
        let run = [
            suited(wait_suit, run_base),
            suited(wait_suit, run_base + 1),
            suited(wait_suit, run_base + 2),
        ];

        let mut concealed_tiles = Vec::with_capacity(14);
        concealed_tiles.extend(bulge_tiles.iter().copied());
        concealed_tiles.extend(rival.iter().copied());
        concealed_tiles.extend(side.iter().copied());
        concealed_tiles.extend(run.iter().copied());

        if !take_all(&mut deck, &concealed_tiles) {
            continue 'attempt;
        }
        if validate_hand(&concealed_tiles).is_err() {
            continue 'attempt;
        }

        let skeleton = NakabukureSkeleton {
            variant: Variant::OneAwayBreak,
            full_tiles: concealed_tiles.clone(),
            concealed_tiles,
            bulge_tiles,
            bulge_tile: bulge_tiles[1],
            draw: rival[2],
            answer_tile: bulge_tiles[1],
            open_meld_tiles: Vec::new(),
        };

        if verify_one_away_break(&skeleton).is_ok() {
            return Ok(skeleton);
        }
    }

    Err("Failed to construct a nakabukure break-bulge hand".to_string())
}

/// Confirms the ready-hand decision: both candidates leave tenpai, the bulge
/// discard waits on the floating honour, and it keeps strictly more winning
/// tiles than keeping the bulge would.
pub(super) fn verify_ready_drop(skeleton: &NakabukureSkeleton) -> Result<(), String> {
    if calculate_shanten(&to_counts(&skeleton.full_tiles)).shanten != 0 {
        return Err("A ready-hand skeleton must start out tenpai".to_string());
    }
    // A second bulge would give the hand a different, equally valid reading of
    // the same lesson, so the drill builds exactly one.
    if bulge_starts(&skeleton.full_tiles) != vec![skeleton.bulge_start()] {
        return Err("A ready-hand skeleton must hold exactly one bulging float".to_string());
    }

    let bulge_discard =
        calculate_ukeire(&counts_without(&skeleton.full_tiles, skeleton.bulge_tile)?);
    let float_discard = calculate_ukeire(&counts_without(&skeleton.full_tiles, skeleton.draw)?);

    if bulge_discard.shanten != 0 || float_discard.shanten != 0 {
        return Err("A candidate discard does not leave tenpai".to_string());
    }
    if bulge_discard.tiles.len() != 1 || bulge_discard.tiles[0].tile != skeleton.draw {
        return Err("Discarding the bulge must wait on the floating honor alone".to_string());
    }
    if float_discard.tiles.len() != 1 || float_discard.tiles[0].tile != skeleton.bulge_tile {
        return Err("Discarding the honor must wait on the bulge tile alone".to_string());
    }
    if bulge_discard.total_count <= float_discard.total_count {
        return Err("The bulge discard must keep strictly more winning tiles".to_string());
    }

    Ok(())
}

/// Confirms the keep-bulge decision (ch4:694, ch3:690):
///
/// - the hand is 1-away;
/// - the book's discard leaves 1-away with the whole bulge intact, and it is
///   the best bulge-preserving discard by raw acceptance;
/// - breaking the bulge also leaves 1-away and accepts *more* tiles, so the
///   lesson cannot be graded by counting acceptance alone.
pub(super) fn verify_one_away_keep(skeleton: &NakabukureSkeleton) -> Result<(), String> {
    let start = skeleton.bulge_start();
    let full_shanten = calculate_shanten(&to_counts(&skeleton.full_tiles)).shanten;
    if full_shanten != 1 {
        return Err(format!(
            "A keep-bulge skeleton must be 1-away, got {full_shanten}"
        ));
    }
    if bulge_starts(&skeleton.full_tiles) != vec![start] {
        return Err("A keep-bulge skeleton must hold exactly one bulging float".to_string());
    }

    let kept = without(&skeleton.full_tiles, skeleton.answer_tile)
        .ok_or_else(|| "The answer tile is not in the hand".to_string())?;
    if bulge_starts(&kept) != vec![start] {
        return Err("The book's discard must keep the bulging float".to_string());
    }
    if calculate_shanten(&to_counts(&kept)).shanten != 1 {
        return Err("The book's discard must leave the hand 1-away".to_string());
    }
    let kept_acceptance = calculate_ukeire(&to_counts(&kept)).total_count;

    let broken = without(&skeleton.full_tiles, skeleton.bulge_tile)
        .ok_or_else(|| "The bulge tile is not in the hand".to_string())?;
    if bulge_starts(&broken).contains(&start) {
        return Err("Discarding the bulge tile must break the float".to_string());
    }
    if calculate_shanten(&to_counts(&broken)).shanten != 1 {
        return Err("Breaking the bulge must leave the hand 1-away".to_string());
    }
    let broken_acceptance = calculate_ukeire(&to_counts(&broken)).total_count;
    if broken_acceptance <= kept_acceptance {
        return Err(
            "Breaking the bulge must accept more tiles than the book's keep discard".to_string(),
        );
    }

    // Among the discards that keep the bulge and 1-away, the book's answer has
    // to be the one that accepts the most; otherwise the drill would have a
    // second, equally defensible keep discard.
    for tile in distinct_tiles(&skeleton.full_tiles) {
        if tile == skeleton.answer_tile || tile == skeleton.bulge_tile {
            continue;
        }
        let Some(remaining) = without(&skeleton.full_tiles, tile) else {
            continue;
        };
        if bulge_starts(&remaining) != vec![start] {
            continue;
        }
        if calculate_shanten(&to_counts(&remaining)).shanten != 1 {
            continue;
        }
        let acceptance = calculate_ukeire(&to_counts(&remaining)).total_count;
        if acceptance >= kept_acceptance {
            return Err("Another bulge-preserving discard is at least as good".to_string());
        }
    }

    Ok(())
}

/// Confirms the break-bulge decision (ch4:725):
///
/// - the hand is 1-away;
/// - the bulge discard leaves 1-away and breaks the float;
/// - at least one other discard keeps the bulge and 1-away (the tempting
///   "keep it" answer), and the bulge discard accepts strictly more tiles than
///   any of them.
pub(super) fn verify_one_away_break(skeleton: &NakabukureSkeleton) -> Result<(), String> {
    let start = skeleton.bulge_start();
    let full_shanten = calculate_shanten(&to_counts(&skeleton.full_tiles)).shanten;
    if full_shanten != 1 {
        return Err(format!(
            "A break-bulge skeleton must be 1-away, got {full_shanten}"
        ));
    }
    if bulge_starts(&skeleton.full_tiles) != vec![start] {
        return Err("A break-bulge skeleton must hold exactly one bulging float".to_string());
    }

    let broken = without(&skeleton.full_tiles, skeleton.answer_tile)
        .ok_or_else(|| "The answer tile is not in the hand".to_string())?;
    if bulge_starts(&broken).contains(&start) {
        return Err("The book's discard must break the bulging float".to_string());
    }
    if calculate_shanten(&to_counts(&broken)).shanten != 1 {
        return Err("Breaking the bulge must leave the hand 1-away".to_string());
    }
    let broken_acceptance = calculate_ukeire(&to_counts(&broken)).total_count;

    let mut keep_discard_exists = false;
    for tile in distinct_tiles(&skeleton.full_tiles) {
        if tile == skeleton.answer_tile {
            continue;
        }
        let Some(remaining) = without(&skeleton.full_tiles, tile) else {
            continue;
        };
        if calculate_shanten(&to_counts(&remaining)).shanten != 1 {
            continue;
        }
        if bulge_starts(&remaining) == vec![start] {
            keep_discard_exists = true;
        }
        let acceptance = calculate_ukeire(&to_counts(&remaining)).total_count;
        if acceptance >= broken_acceptance {
            return Err("The break discard must accept strictly more tiles".to_string());
        }
    }
    if !keep_discard_exists {
        return Err("The hand needs a real keep-the-bulge alternative".to_string());
    }

    Ok(())
}

/// Adds a random complete set (sequence or triplet) in one of `suits`.
fn add_set(hand: &mut Vec<Tile>, deck: &mut Deck, suits: &[Suit]) -> bool {
    let mut sequences: Vec<[Tile; 3]> = Vec::new();
    let mut triplets: Vec<[Tile; 3]> = Vec::new();

    for &suit in suits {
        for start in 1..=7u8 {
            let meld = [
                suited(suit, start),
                suited(suit, start + 1),
                suited(suit, start + 2),
            ];
            if meld.iter().all(|tile| deck.has(*tile)) {
                sequences.push(meld);
            }
        }
        for value in 1..=9u8 {
            let tile = suited(suit, value);
            if deck.count(tile) >= 3 {
                triplets.push([tile; 3]);
            }
        }
    }

    let pick = if gen_bool(0.65) {
        choose(&sequences).or_else(|| choose(&triplets))
    } else {
        choose(&triplets).or_else(|| choose(&sequences))
    };
    let Some(meld) = pick else {
        return false;
    };
    for tile in meld {
        if deck.take(tile).is_err() {
            return false;
        }
    }
    hand.extend(meld);
    true
}

/// Three distinct suits, shuffled, so each hand shape gets its own suit.
fn shuffled_suits() -> [Suit; 3] {
    let mut suits = [Suit::Man, Suit::Pin, Suit::Sou];
    shuffle(&mut suits);
    suits
}

fn take_all(deck: &mut Deck, tiles: &[Tile]) -> bool {
    for tile in tiles {
        if deck.take(*tile).is_err() {
            return false;
        }
    }
    true
}

fn suited(suit: Suit, value: u8) -> Tile {
    Tile::Suited { suit, value }
}

/// The suit and base rank of a bulging float's four tiles.
fn bulge_start(tiles: [Tile; 4]) -> (Suit, u8) {
    match tiles[0] {
        Tile::Suited { suit, value } => (suit, value),
        _ => unreachable!("a bulging float is always suited"),
    }
}

/// Every bulging float (`x, x+1, x+1, x+2`) in a hand, in tile order.
fn bulge_starts(tiles: &[Tile]) -> Vec<(Suit, u8)> {
    let mut found = Vec::new();
    for suit in [Suit::Man, Suit::Pin, Suit::Sou] {
        let mut counts = [0u8; 10];
        for tile in tiles {
            if let Tile::Suited {
                suit: tile_suit,
                value,
            } = tile
                && *tile_suit == suit
            {
                counts[*value as usize] += 1;
            }
        }
        for base in 1..=7u8 {
            if counts[base as usize] >= 1
                && counts[base as usize + 1] >= 2
                && counts[base as usize + 2] >= 1
            {
                found.push((suit, base));
            }
        }
    }
    found
}

fn distinct_tiles(tiles: &[Tile]) -> Vec<Tile> {
    let mut distinct = tiles.to_vec();
    distinct.sort();
    distinct.dedup();
    distinct
}

/// The hand after removing one copy of `discard`.
fn without(tiles: &[Tile], discard: Tile) -> Option<Vec<Tile>> {
    let mut remaining = tiles.to_vec();
    let index = remaining.iter().position(|tile| *tile == discard)?;
    remaining.remove(index);
    Some(remaining)
}

/// Counts the hand after removing one copy of `discard`.
fn counts_without(tiles: &[Tile], discard: Tile) -> Result<TileCounts, String> {
    without(tiles, discard)
        .map(|remaining| to_counts(&remaining))
        .ok_or_else(|| format!("{discard} is not in the hand"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn every_variant_builds_and_generalizes() {
        let mut bulge_suits = HashSet::new();
        let mut bases = HashSet::new();
        let mut answers = HashSet::new();

        for _ in 0..60 {
            for variant in Variant::ALL {
                let skeleton = build_variant(variant).expect("skeleton must build");

                assert_eq!(skeleton.variant, variant);
                assert_eq!(skeleton.full_tiles.len(), 14);
                assert!(validate_hand(&skeleton.full_tiles).is_ok());

                let [low, mid_a, mid_b, high] = skeleton.bulge_tiles;
                assert_eq!(mid_a, mid_b, "the bulge repeats its middle tile");
                assert_eq!(skeleton.bulge_tile, mid_a);
                let (
                    Tile::Suited { suit, value },
                    Tile::Suited {
                        suit: high_suit, ..
                    },
                ) = (low, high)
                else {
                    panic!("the bulge must be a suited shape");
                };
                assert_eq!(suit, high_suit);
                assert_eq!(mid_a, suited(suit, value + 1));
                assert_eq!(high, suited(suit, value + 2));
                assert!(
                    (2..=6).contains(&value),
                    "bulge bases must stay inside the book's 2334-6778 range"
                );
                bulge_suits.insert(suit);
                bases.insert(value);
                answers.insert(skeleton.answer_tile.to_string());

                // The drawn tile and the answer are both in the hand.
                assert!(skeleton.full_tiles.contains(&skeleton.draw));
                assert!(skeleton.full_tiles.contains(&skeleton.answer_tile));

                match variant {
                    Variant::ReadyDrop => {
                        assert_eq!(skeleton.answer_tile, skeleton.bulge_tile);
                        assert!(skeleton.breaks_the_bulge());
                        assert_eq!(skeleton.open_meld_tiles.len(), 3);
                        assert_eq!(skeleton.concealed_tiles.len(), 11);
                        assert!(matches!(skeleton.draw, Tile::Honor(_)));
                    }
                    Variant::OneAwayKeep => {
                        assert_ne!(skeleton.answer_tile, skeleton.bulge_tile);
                        assert!(skeleton.keeps_the_bulge());
                        assert!(skeleton.open_meld_tiles.is_empty());
                        assert_eq!(skeleton.concealed_tiles.len(), 14);
                    }
                    Variant::OneAwayBreak => {
                        assert_eq!(skeleton.answer_tile, skeleton.bulge_tile);
                        assert!(skeleton.breaks_the_bulge());
                        assert!(skeleton.open_meld_tiles.is_empty());
                        assert_eq!(skeleton.concealed_tiles.len(), 14);
                        assert_ne!(skeleton.draw, skeleton.answer_tile);
                    }
                }
            }
        }

        assert!(bulge_suits.len() > 1, "generator must cover multiple suits");
        assert!(bases.len() > 1, "generator must cover multiple bases");
        assert!(
            answers.len() > 1,
            "the drill must ask for more than one tile"
        );
    }

    #[test]
    fn the_two_one_away_variants_pull_in_opposite_directions() {
        for _ in 0..40 {
            let keep = build_variant(Variant::OneAwayKeep).expect("keep skeleton");
            verify_one_away_keep(&keep).expect("keep check");

            let start = keep.bulge_start();
            let kept = without(&keep.full_tiles, keep.answer_tile).expect("answer in hand");
            let broken = without(&keep.full_tiles, keep.bulge_tile).expect("bulge in hand");
            assert_eq!(bulge_starts(&kept), vec![start]);
            assert!(!bulge_starts(&broken).contains(&start));
            assert!(
                calculate_ukeire(&to_counts(&broken)).total_count
                    > calculate_ukeire(&to_counts(&kept)).total_count,
                "breaking the bulge must look better by raw acceptance"
            );

            let brk = build_variant(Variant::OneAwayBreak).expect("break skeleton");
            verify_one_away_break(&brk).expect("break check");
            let start = brk.bulge_start();
            let broken = without(&brk.full_tiles, brk.answer_tile).expect("answer in hand");
            assert!(!bulge_starts(&broken).contains(&start));

            let mut keep_acceptance = 0;
            for tile in distinct_tiles(&brk.full_tiles) {
                if tile == brk.answer_tile {
                    continue;
                }
                let Some(remaining) = without(&brk.full_tiles, tile) else {
                    continue;
                };
                if bulge_starts(&remaining) == vec![start]
                    && calculate_shanten(&to_counts(&remaining)).shanten == 1
                {
                    keep_acceptance =
                        keep_acceptance.max(calculate_ukeire(&to_counts(&remaining)).total_count);
                }
            }
            assert!(
                keep_acceptance > 0,
                "the break variant needs a keep alternative"
            );
            assert!(
                calculate_ukeire(&to_counts(&broken)).total_count > keep_acceptance,
                "the break discard must accept more tiles than keeping the bulge"
            );
        }
    }

    #[test]
    fn ready_drop_leaves_exactly_two_tenpai_discards() {
        for _ in 0..40 {
            let skeleton = build_variant(Variant::ReadyDrop).expect("ready skeleton");
            verify_ready_drop(&skeleton).expect("ready check");

            let mut tenpai_discards = Vec::new();
            for tile in distinct_tiles(&skeleton.full_tiles) {
                let counts = counts_without(&skeleton.full_tiles, tile).expect("tile in hand");
                if calculate_shanten(&counts).shanten == 0 {
                    tenpai_discards.push(tile);
                }
            }
            tenpai_discards.sort();
            let mut expected = vec![skeleton.bulge_tile, skeleton.draw];
            expected.sort();
            assert_eq!(
                tenpai_discards, expected,
                "exactly the bulge tile and the floating honor may leave tenpai"
            );
        }
    }

    #[test]
    fn ready_drop_keeps_strictly_more_winning_tiles() {
        for _ in 0..40 {
            let skeleton = build_variant(Variant::ReadyDrop).expect("ready skeleton");
            let bulge_counts =
                counts_without(&skeleton.full_tiles, skeleton.bulge_tile).expect("bulge in hand");
            let float_counts =
                counts_without(&skeleton.full_tiles, skeleton.draw).expect("float in hand");

            let bulge_discard = calculate_ukeire(&bulge_counts);
            let float_discard = calculate_ukeire(&float_counts);

            assert_eq!(bulge_discard.shanten, 0);
            assert_eq!(float_discard.shanten, 0);
            assert_eq!(bulge_discard.tiles.len(), 1);
            assert_eq!(bulge_discard.tiles[0].tile, skeleton.draw);
            assert_eq!(float_discard.tiles.len(), 1);
            assert_eq!(float_discard.tiles[0].tile, skeleton.bulge_tile);
            assert_eq!(bulge_discard.total_count, 3);
            assert_eq!(float_discard.total_count, 2);
        }
    }
}
