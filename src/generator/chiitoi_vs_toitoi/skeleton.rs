use agari::parse::to_counts;
use agari::shanten::{ShantenType, calculate_shanten, calculate_ukeire};
use agari::tile::{Honor, Suit, Tile};

use crate::generator::support::deck::{ALL_TILES, Deck};
use crate::rng::{choose, gen_range, shuffle};

/// Which answer the book gives for this hand.
///
/// Riichi Book 1, ch. 5, "Toitoi vs. chiitoitsu", starts from a 1-away
/// chiitoitsu hand whose drawn tile turned one pair into a set, and lists three
/// reasons to stay with chiitoitsu:
///
/// - "There is a futile pair in your hand." (ch5:611)
/// - "There is no pair of value tiles in your hand." (ch5:612)
/// - "There are three or more pairs of simple tiles between 3 and 7 in your
///   hand." (ch5:613)
///
/// The first condition is "by far the most important one": a futile pair can
/// never become a set, so toitoi is dead and "you must stick with chiitoitsu"
/// (ch5:618). Without one, "you can go for toitoi" (ch5:618). The drill draws
/// one of the two hands, so the player has to read the rivers instead of
/// pattern-matching the shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Variant {
    /// One pair has both remaining copies in the opponents' rivers: chiitoitsu.
    FutilePair,
    /// No pair is dead and a value pair makes toitoi worth chasing.
    BuildToitoi,
}

impl Variant {
    /// The variants in the order the drill draws them.
    pub(super) const ALL: [Variant; 2] = [Variant::FutilePair, Variant::BuildToitoi];
}

/// The constructed parts of one "chiitoitsu vs toitoi" puzzle.
///
/// The 14-tile hand is always four pairs, the triplet the draw just completed,
/// and three lone tiles: the book's own `77m 88m 1p 333p 55s 7s EE S` shape.
/// The 13-tile hand before the draw is the same hand with only two copies of
/// the triplet tile, so the draw is literally "one of the pairs becomes a set".
///
/// - [`Variant::FutilePair`] plants two copies of one pair in the opponents'
///   rivers. The pair is dead, so the answer is the drawn third copy: discarding
///   it restores all five pairs.
/// - [`Variant::BuildToitoi`] leaves every pair live and gives the hand a dragon
///   pair, so the answer is a lone tile: keeping the triplet makes the hand
///   2-away for toitoi (ch5:603) while the chiitoitsu discard keeps more tiles.
///
/// Anki 1463247702867 ("in which 3 situations should you choose chiitoitsu over
/// toitoi?") and 1463250507888 ("when should you pursue run-based hands over
/// set-based hands?").
pub(super) struct ChiitoiSkeleton {
    /// Which decision this hand asks for.
    pub variant: Variant,
    /// The four pairs that remain pairs (eight tiles).
    pub pairs: [Tile; 4],
    /// The tile that was a pair before the draw and is a triplet after it.
    pub triplet: Tile,
    /// The three lone tiles.
    pub singles: [Tile; 3],
    /// The tile just drawn: the third copy of [`Self::triplet`].
    pub draw: Tile,
    /// The book's discard.
    pub answer_tile: Tile,
    /// Discards graded as the same answer. Only the toitoi branch has any: its
    /// three lone tiles are interchangeable, so all three are accepted.
    pub equivalent_tiles: Vec<Tile>,
    /// The pair whose two remaining copies sit in the opponents' rivers. Always
    /// one of [`Self::pairs`], and `None` on the toitoi branch.
    pub futile_pair: Option<Tile>,
}

impl ChiitoiSkeleton {
    /// The 14 tiles after the draw.
    pub(super) fn full_tiles(&self) -> Vec<Tile> {
        self.tiles_with_triplet_copies(3)
    }

    /// The 13 concealed tiles before the draw (the triplet is still a pair).
    pub(super) fn pre_draw_tiles(&self) -> Vec<Tile> {
        self.tiles_with_triplet_copies(2)
    }

    fn tiles_with_triplet_copies(&self, triplet_copies: usize) -> Vec<Tile> {
        let mut tiles = Vec::with_capacity(13 + triplet_copies);
        for pair in self.pairs {
            tiles.push(pair);
            tiles.push(pair);
        }
        for _ in 0..triplet_copies {
            tiles.push(self.triplet);
        }
        tiles.extend(self.singles.iter().copied());
        tiles
    }

    /// The hand after the book's discard.
    pub(super) fn post_discard_tiles(&self) -> Vec<Tile> {
        let mut tiles = self.full_tiles();
        let index = tiles
            .iter()
            .position(|tile| *tile == self.answer_tile)
            .expect("the answer must be in the hand");
        tiles.remove(index);
        tiles
    }
}

/// Picks the variant the next puzzle will ask about, before the hand is built
/// so rejection inside one variant never starves the other.
pub(super) fn random_variant() -> Variant {
    Variant::ALL[gen_range(0, Variant::ALL.len())]
}

/// Builds and proves one hand for `variant`.
pub(super) fn build_variant(variant: Variant) -> Result<ChiitoiSkeleton, String> {
    match variant {
        Variant::FutilePair => build_futile_pair(),
        Variant::BuildToitoi => build_toitoi(),
    }
}

/// A hand whose chiitoitsu reason is a dead pair (ch5:611, ch5:618).
///
/// All four pairs are simple tiles between 3 and 7 and none is a value pair,
/// so the book's second and third chiitoitsu conditions point the same way as
/// the first. The futile pair is one of them; the board puts its other two
/// copies in two opponents' rivers.
fn build_futile_pair() -> Result<ChiitoiSkeleton, String> {
    for _ in 0..512 {
        let mut deck = Deck::fresh();

        let middle = middle_simple_tiles();
        let mut shuffled = middle.clone();
        shuffle(&mut shuffled);
        let Some(pairs) = take_distinct(&mut shuffled, 4) else {
            continue;
        };

        // The triplet stays a middle simple as well, like the book's 3p.
        let triplet_pool: Vec<Tile> = middle
            .iter()
            .copied()
            .filter(|tile| !pairs.contains(tile))
            .collect();
        let Some(triplet) = choose(&triplet_pool) else {
            continue;
        };

        let single_pool: Vec<Tile> = ALL_TILES
            .iter()
            .copied()
            .filter(|tile| !pairs.contains(tile) && *tile != triplet)
            .collect();
        let Some(singles) = take_distinct(&mut shuffled_tiles(single_pool), 3) else {
            continue;
        };

        let futile_pair = match choose(&pairs) {
            Some(pair) => pair,
            None => continue,
        };

        let skeleton = ChiitoiSkeleton {
            variant: Variant::FutilePair,
            pairs: [pairs[0], pairs[1], pairs[2], pairs[3]],
            triplet,
            singles: [singles[0], singles[1], singles[2]],
            draw: triplet,
            answer_tile: triplet,
            equivalent_tiles: Vec::new(),
            futile_pair: Some(futile_pair),
        };

        if take_hand(&mut deck, &skeleton.full_tiles()).is_err() {
            continue;
        }
        if verify_futile_pair(&skeleton).is_ok() {
            return Ok(skeleton);
        }
    }

    Err("Failed to construct a futile-pair chiitoitsu hand".to_string())
}

/// A hand with no dead pair, one dragon pair, and at most two middle simples
/// among the pairs: every book condition for toitoi now points away from
/// chiitoitsu (ch5:611-613, ch5:621), so the answer is a lone tile.
fn build_toitoi() -> Result<ChiitoiSkeleton, String> {
    for _ in 0..512 {
        let mut deck = Deck::fresh();

        // The value pair that makes toitoi worth 5200 rather than a bare 2000
        // (ch5:621). Dragons are value tiles regardless of the round.
        let dragons = [Honor::White, Honor::Green, Honor::Red];
        let Some(dragon) = choose(&dragons) else {
            continue;
        };
        let value_pair = Tile::Honor(dragon);

        // Two middle simples at most: with three or more the book's third
        // chiitoitsu condition would fire (ch5:613). The remaining pair is a
        // terminal or a wind, which keeps it off that count.
        let mut middle = middle_simple_tiles();
        shuffle(&mut middle);
        let Some(middle_pairs) = take_distinct(&mut middle, 2) else {
            continue;
        };
        let mut outside = outside_pair_tiles();
        shuffle(&mut outside);
        let Some(outside_pair) = outside.first().copied() else {
            continue;
        };

        let pairs = [value_pair, middle_pairs[0], middle_pairs[1], outside_pair];

        // A suited triplet: the draw completes a set without adding a second
        // value block, so the decision stays the book's pair read.
        let suited: Vec<Tile> = ALL_TILES
            .iter()
            .copied()
            .filter(|tile| tile.suit().is_some() && !pairs.contains(tile))
            .collect();
        let Some(triplet) = choose(&suited) else {
            continue;
        };

        // Three lone suited tiles. None is an honor, so discarding any one of
        // them is the same toitoi move: no lone dragon or seat wind is at
        // stake.
        let singles_pool: Vec<Tile> = suited
            .iter()
            .copied()
            .filter(|tile| *tile != triplet)
            .collect();
        let Some(singles) = take_distinct(&mut shuffled_tiles(singles_pool), 3) else {
            continue;
        };
        let Some(answer) = choose(&singles) else {
            continue;
        };
        let mut equivalents: Vec<Tile> = singles
            .iter()
            .copied()
            .filter(|tile| *tile != answer)
            .collect();
        if equivalents.len() != 2 {
            continue;
        }
        // Stable order so the payload does not depend on draw order.
        equivalents.sort();

        let skeleton = ChiitoiSkeleton {
            variant: Variant::BuildToitoi,
            pairs,
            triplet,
            singles: [singles[0], singles[1], singles[2]],
            draw: triplet,
            answer_tile: answer,
            equivalent_tiles: equivalents,
            futile_pair: None,
        };

        if take_hand(&mut deck, &skeleton.full_tiles()).is_err() {
            continue;
        }
        if verify_toitoi(&skeleton).is_ok() {
            return Ok(skeleton);
        }
    }

    Err("Failed to construct a toitoi chiitoitsu hand".to_string())
}

/// Proves the futile-pair answer on the skeleton alone:
///
/// - the drawn hand is 1-away with chiitoitsu as its best reading;
/// - exactly one pair is marked futile, and it is one of the four pairs;
/// - discarding the drawn third copy restores five pairs and three lone tiles
///   and waits on exactly those three lone tiles.
pub(super) fn verify_futile_pair(skeleton: &ChiitoiSkeleton) -> Result<(), String> {
    verify_base_shape(skeleton)?;
    if skeleton.variant != Variant::FutilePair {
        return Err("not a futile-pair hand".to_string());
    }
    if skeleton.answer_tile != skeleton.draw {
        return Err("the futile-pair answer must be the drawn third copy".to_string());
    }
    let Some(futile) = skeleton.futile_pair else {
        return Err("the futile-pair hand must name its dead pair".to_string());
    };
    if !skeleton.pairs.contains(&futile) {
        return Err("the futile pair must be one of the four pairs".to_string());
    }

    let post = skeleton.post_discard_tiles();
    let counts = to_counts(&post);
    assert_five_pairs_three_singles(&counts)?;
    if calculate_chiitoitsu_shanten(&post) != 1 {
        return Err("the answer must leave the hand 1-away chiitoitsu".to_string());
    }

    let ukeire = calculate_ukeire(&counts);
    let mut waited: Vec<Tile> = ukeire.tiles.iter().map(|tile| tile.tile).collect();
    let mut expected = skeleton.singles.to_vec();
    waited.sort();
    expected.sort();
    if waited != expected {
        return Err(format!(
            "the chiitoitsu waits must be the three lone tiles, got {waited:?}"
        ));
    }
    if ukeire.total_count != 9 {
        return Err(format!(
            "five pairs plus three lone tiles must accept nine tiles, got {}",
            ukeire.total_count
        ));
    }

    Ok(())
}

/// Proves the toitoi answer on the skeleton alone:
///
/// - the drawn hand is 1-away with chiitoitsu as its best reading;
/// - no pair is futile;
/// - discarding a lone tile keeps the new triplet and four pairs (the book's
///   2-away toitoi shape, ch5:603) and leaves only the other two lone tiles as
///   chiitoitsu waits;
/// - discarding the drawn third copy instead accepts strictly more tiles, so
///   counting acceptance alone picks the wrong move.
pub(super) fn verify_toitoi(skeleton: &ChiitoiSkeleton) -> Result<(), String> {
    verify_base_shape(skeleton)?;
    if skeleton.variant != Variant::BuildToitoi {
        return Err("not a toitoi hand".to_string());
    }
    if skeleton.futile_pair.is_some() {
        return Err("the toitoi hand must not mark a futile pair".to_string());
    }
    if !skeleton.singles.contains(&skeleton.answer_tile) {
        return Err("the toitoi answer must be one of the lone tiles".to_string());
    }
    // A dragon pair guarantees the toitoi plan has value (ch5:621); without it
    // the hand would match the book's second chiitoitsu condition instead.
    if !skeleton.pairs.iter().any(|pair| pair.is_dragon()) {
        return Err("the toitoi hand needs a value pair".to_string());
    }
    if skeleton.equivalent_tiles.len() != 2 {
        return Err("the other two lone tiles must be accepted too".to_string());
    }
    for equivalent in &skeleton.equivalent_tiles {
        if !skeleton.singles.contains(equivalent) || *equivalent == skeleton.answer_tile {
            return Err("equivalent answers must be the other lone tiles".to_string());
        }
    }
    if skeleton
        .full_tiles()
        .iter()
        .filter(|held| **held == skeleton.triplet)
        .count()
        != 3
    {
        return Err("the triplet must be held exactly three times".to_string());
    }

    let post = skeleton.post_discard_tiles();
    let counts = to_counts(&post);
    // Keeping the triplet makes the hand four pairs plus a set.
    if counts.get(&skeleton.triplet) != Some(&3) {
        return Err("the answer must keep the new triplet".to_string());
    }
    let pairs = pair_tiles(&post);
    if pairs.len() != 4 {
        return Err(format!(
            "keeping the triplet must leave four pairs, got {pairs:?}"
        ));
    }
    let lone: Vec<Tile> = skeleton
        .singles
        .iter()
        .copied()
        .filter(|tile| *tile != skeleton.answer_tile)
        .collect();
    if lone.len() != 2 {
        return Err("two lone tiles must remain after the answer".to_string());
    }
    if calculate_chiitoitsu_shanten(&post) != 1 {
        return Err("the toitoi answer must leave the hand 1-away chiitoitsu".to_string());
    }

    let answer_ukeire = calculate_ukeire(&counts);
    let mut waited: Vec<Tile> = answer_ukeire.tiles.iter().map(|tile| tile.tile).collect();
    let mut expected = lone.clone();
    waited.sort();
    expected.sort();
    if waited != expected {
        return Err(format!(
            "keeping the triplet must wait on the two lone tiles, got {waited:?}"
        ));
    }
    if answer_ukeire.total_count != 6 {
        return Err(format!(
            "the toitoi answer must accept six tiles, got {}",
            answer_ukeire.total_count
        ));
    }

    // The trap: dropping the third copy restores five live pairs and accepts
    // more tiles, but it gives up the toitoi possibility.
    let chiitoitsu_counts = to_counts(&skeleton.full_tiles());
    let chiitoitsu_ukeire = calculate_ukeire(&chiitoitsu_counts);
    if chiitoitsu_ukeire.total_count <= answer_ukeire.total_count {
        return Err(format!(
            "the chiitoitsu discard must accept more tiles ({} vs {})",
            chiitoitsu_ukeire.total_count, answer_ukeire.total_count
        ));
    }

    Ok(())
}

/// Shape checks common to both answers.
fn verify_base_shape(skeleton: &ChiitoiSkeleton) -> Result<(), String> {
    let full = skeleton.full_tiles();
    if full.len() != 14 {
        return Err(format!(
            "a turn hand must hold fourteen tiles, got {}",
            full.len()
        ));
    }
    let pre = skeleton.pre_draw_tiles();
    if pre.len() != 13 {
        return Err(format!(
            "a concealed hand must hold thirteen tiles, got {}",
            pre.len()
        ));
    }
    if skeleton.draw != skeleton.triplet {
        return Err("the draw must be the third copy of the triplet".to_string());
    }

    let counts = to_counts(&full);
    if counts.len() != 8 {
        return Err("the hand must hold eight distinct tile types".to_string());
    }
    if counts.get(&skeleton.triplet) != Some(&3) {
        return Err("the drawn tile must make a triplet".to_string());
    }
    for pair in skeleton.pairs {
        if counts.get(&pair) != Some(&2) {
            return Err(format!("{pair} must be a pair"));
        }
    }
    for single in skeleton.singles {
        if counts.get(&single) != Some(&1) {
            return Err(format!("{single} must be a lone tile"));
        }
    }

    let pre_shanten = calculate_shanten(&to_counts(&pre));
    if pre_shanten.shanten != 1 || pre_shanten.best_type != ShantenType::Chiitoitsu {
        return Err(format!(
            "the hand before the draw must be 1-away chiitoitsu, got {:?}",
            pre_shanten
        ));
    }
    let full_shanten = calculate_shanten(&counts);
    if full_shanten.shanten != 1 || full_shanten.best_type != ShantenType::Chiitoitsu {
        return Err(format!(
            "the drawn hand must still be 1-away chiitoitsu, got {:?}",
            full_shanten
        ));
    }

    Ok(())
}

/// The chiitoitsu shanten of a tile collection, by the book's pair count.
fn calculate_chiitoitsu_shanten(tiles: &[Tile]) -> i8 {
    agari::shanten::calculate_chiitoitsu_shanten(&to_counts(tiles))
}

/// Confirms a 13-tile hand is exactly five pairs plus three lone tiles.
fn assert_five_pairs_three_singles(
    counts: &std::collections::HashMap<Tile, u8>,
) -> Result<(), String> {
    let mut pairs = 0;
    let mut singles = 0;
    for count in counts.values() {
        match count {
            2 => pairs += 1,
            1 => singles += 1,
            other => return Err(format!("unexpected tile count {other}")),
        }
    }
    if pairs != 5 || singles != 3 {
        return Err(format!(
            "expected five pairs and three lone tiles, got {pairs} pairs and {singles} singles"
        ));
    }
    Ok(())
}

/// The tiles of a 14-tile hand that are pairs (exactly two copies).
fn pair_tiles(tiles: &[Tile]) -> Vec<Tile> {
    let counts = to_counts(tiles);
    let mut pairs: Vec<Tile> = counts
        .iter()
        .filter(|(_, count)| **count == 2)
        .map(|(tile, _)| *tile)
        .collect();
    pairs.sort();
    pairs
}

/// Simple suited tiles between 3 and 7, the book's third pair condition.
fn middle_simple_tiles() -> Vec<Tile> {
    let mut tiles = Vec::new();
    for suit in [Suit::Man, Suit::Pin, Suit::Sou] {
        for value in 3..=7u8 {
            tiles.push(Tile::Suited { suit, value });
        }
    }
    tiles
}

/// Terminal and wind tiles: anything that is not a simple tile between 3 and 7.
fn outside_pair_tiles() -> Vec<Tile> {
    let mut tiles = Vec::new();
    for suit in [Suit::Man, Suit::Pin, Suit::Sou] {
        tiles.push(Tile::Suited { suit, value: 1 });
        tiles.push(Tile::Suited { suit, value: 9 });
    }
    tiles.extend([
        Tile::Honor(Honor::East),
        Tile::Honor(Honor::South),
        Tile::Honor(Honor::West),
        Tile::Honor(Honor::North),
    ]);
    tiles
}

fn shuffled_tiles(mut tiles: Vec<Tile>) -> Vec<Tile> {
    shuffle(&mut tiles);
    tiles
}

/// Takes `count` distinct tiles off the front of an already-shuffled pool.
fn take_distinct(tiles: &mut Vec<Tile>, count: usize) -> Option<Vec<Tile>> {
    if tiles.len() < count {
        return None;
    }
    Some(tiles.drain(..count).collect())
}

fn take_hand(deck: &mut Deck, tiles: &[Tile]) -> Result<(), String> {
    for tile in tiles {
        deck.take(*tile)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn every_variant_builds_and_proves_its_rule() {
        let mut suits = HashSet::new();
        let mut answers = HashSet::new();

        for _ in 0..80 {
            for variant in Variant::ALL {
                let skeleton = build_variant(variant).expect("skeleton must build");
                assert_eq!(skeleton.variant, variant);
                assert_eq!(skeleton.full_tiles().len(), 14);
                assert_eq!(skeleton.pre_draw_tiles().len(), 13);
                assert_eq!(skeleton.draw, skeleton.triplet);
                assert_eq!(
                    skeleton
                        .full_tiles()
                        .iter()
                        .filter(|tile| **tile == skeleton.triplet)
                        .count(),
                    3
                );

                match variant {
                    Variant::FutilePair => {
                        verify_futile_pair(&skeleton).expect("futile-pair check");
                        assert_eq!(skeleton.answer_tile, skeleton.draw);
                        assert!(skeleton.equivalent_tiles.is_empty());
                        assert!(skeleton.futile_pair.is_some());
                        // Every pair is a simple tile between 3 and 7.
                        for pair in skeleton.pairs {
                            let Tile::Suited { value, .. } = pair else {
                                panic!("futile-pair hands use simple tiles");
                            };
                            assert!((3..=7).contains(&value));
                        }
                    }
                    Variant::BuildToitoi => {
                        verify_toitoi(&skeleton).expect("toitoi check");
                        assert_ne!(skeleton.answer_tile, skeleton.draw);
                        assert_eq!(skeleton.equivalent_tiles.len(), 2);
                        assert!(skeleton.futile_pair.is_none());
                        // A dragon pair is the value pair.
                        assert!(
                            skeleton.pairs.iter().any(|pair| pair.is_dragon()),
                            "toitoi needs a value pair"
                        );
                        // At most two middle-simple pairs.
                        let middle = skeleton
                            .pairs
                            .iter()
                            .filter(|pair| {
                                pair.value().is_some_and(|value| (3..=7).contains(&value))
                            })
                            .count();
                        assert!(middle <= 2, "the third chiitoitsu condition must not fire");
                    }
                }

                if let Some(suit) = skeleton.triplet.suit() {
                    suits.insert(suit);
                }
                answers.insert(skeleton.answer_tile.to_string());
            }
        }

        assert!(suits.len() > 1, "the generator must cover several suits");
        assert!(
            answers.len() > 2,
            "the drill must ask for more than two tiles"
        );
    }

    #[test]
    fn the_chiitoitsu_discard_always_looks_better_by_raw_acceptance() {
        for _ in 0..60 {
            let skeleton = build_variant(Variant::BuildToitoi).expect("toitoi skeleton");
            let answer = calculate_ukeire(&to_counts(&skeleton.post_discard_tiles()));
            let chiitoitsu = calculate_ukeire(&to_counts(&skeleton.full_tiles()));
            assert!(
                chiitoitsu.total_count > answer.total_count,
                "the counted line must beat the book's line, {} vs {}",
                chiitoitsu.total_count,
                answer.total_count
            );
        }
    }

    #[test]
    fn the_futile_branch_always_restores_five_live_pairs() {
        for _ in 0..60 {
            let skeleton = build_variant(Variant::FutilePair).expect("futile skeleton");
            let post = skeleton.post_discard_tiles();
            let pairs = pair_tiles(&post);
            assert_eq!(pairs.len(), 5);
            assert!(pairs.contains(&skeleton.triplet));
            let singles = skeleton.singles;
            assert_eq!(
                calculate_ukeire(&to_counts(&post)).total_count,
                3 * singles.len() as u8
            );
        }
    }
}
