//! Who drew what: the tile that turns a 1-shanten hand into tenpai.
//!
//! The Riichi/dama lessons all present the moment a hand first reaches tenpai.
//! If the 13 tiles were already tenpai and the player threw the draw instead
//! (tsumogiri), the table implies they passed up Riichi on an earlier turn,
//! which is not the decision the lesson asks about. So those hands are built the
//! other way round: one half of the wait shape is the tile just drawn and stays
//! in the hand, while a floater that was already in the hand is discarded
//! (tedashi).

use agari::parse::to_counts;
use agari::shanten::calculate_shanten;
use agari::tile::Tile;

use crate::rng::choose;

/// The 13 tiles a player held before drawing `drawn`.
///
/// `post_discard` is the 13-tile tenpai hand left after the answer goes, and
/// `discard` is that answer, which was in the hand before the draw.
pub fn pre_draw_tiles(post_discard: &[Tile], drawn: Tile, discard: Tile) -> Vec<Tile> {
    let mut tiles = post_discard.to_vec();
    let index = tiles
        .iter()
        .position(|tile| *tile == drawn)
        .expect("the drawn tile is part of the post-discard hand");
    tiles.remove(index);
    tiles.push(discard);
    tiles
}

/// Picks which tile from the kept wait shape is the one just drawn.
///
/// A candidate is usable only when removing it from the tenpai hand and adding
/// the discarded floater leaves a 1-shanten hand: the draw has to be what
/// reaches tenpai, never a tile drawn onto an already-tenpai hand. Returns
/// `None` when no candidate works, which the caller handles by re-rolling.
pub fn choose_drawn_tile(
    candidates: &[Tile],
    post_discard: &[Tile],
    discard: Tile,
) -> Option<Tile> {
    let mut distinct = candidates.to_vec();
    distinct.sort();
    distinct.dedup();

    let viable: Vec<Tile> = distinct
        .into_iter()
        .filter(|drawn| {
            post_discard.contains(drawn)
                && calculate_shanten(&to_counts(&pre_draw_tiles(post_discard, *drawn, discard)))
                    .shanten
                    == 1
        })
        .collect();

    choose(&viable)
}

#[cfg(test)]
mod tests {
    use super::*;

    use agari::parse::parse_hand;

    use crate::generator::support::testing::parse_tile;

    /// A tenpai hand: three sets, a pair, and a ryanmen protorun.
    fn tenpai() -> Vec<Tile> {
        parse_hand("123m456p789s11z34m").expect("hand must parse")
    }

    #[test]
    fn the_pre_draw_hand_swaps_the_draw_for_the_discarded_floater() {
        let post = tenpai();
        let draw = parse_tile("3m");
        let discard = parse_tile("9p");

        let mut pre = pre_draw_tiles(&post, draw, discard);
        pre.sort();

        let mut expected = post.clone();
        let index = expected
            .iter()
            .position(|tile| *tile == draw)
            .expect("the draw is in the tenpai hand");
        expected.remove(index);
        expected.push(discard);
        expected.sort();

        assert_eq!(pre, expected);
        assert_eq!(pre.len(), 13);
        assert!(pre.contains(&discard));
        assert_eq!(calculate_shanten(&to_counts(&pre)).shanten, 1);
    }

    #[test]
    fn only_a_candidate_that_reaches_tenpai_is_chosen() {
        let post = tenpai();
        let discard = parse_tile("9p");

        // 5z is not in the hand at all, so it can never be the draw.
        let chosen = choose_drawn_tile(
            &[parse_tile("3m"), parse_tile("4m"), parse_tile("5z")],
            &post,
            discard,
        )
        .expect("a protorun tile must be usable");
        assert!(chosen == parse_tile("3m") || chosen == parse_tile("4m"));
        assert!(post.contains(&chosen));
    }

    #[test]
    fn a_draw_onto_an_already_tenpai_hand_is_rejected() {
        // 111m 222m 333m 44m 56m is tenpai on 4m/7m. Throwing a 4m and keeping
        // the 6m draw makes 444m plus a lone 5m: 4 sets and a single, still
        // tenpai. The pre-draw hand must not already be tenpai, so 6m cannot be
        // the draw here.
        let post = parse_hand("111m222m333m44m56m").expect("hand must parse");
        let discard = parse_tile("4m");

        assert_eq!(calculate_shanten(&to_counts(&post)).shanten, 0);
        assert_eq!(
            calculate_shanten(&to_counts(&pre_draw_tiles(
                &post,
                parse_tile("6m"),
                discard
            )))
            .shanten,
            0,
            "the fixture must expose the already-tenpai shape"
        );
        assert_eq!(
            choose_drawn_tile(&[parse_tile("5m"), parse_tile("6m")], &post, discard),
            None
        );
    }
}
