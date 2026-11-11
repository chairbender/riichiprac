//! The constructive skeleton for the ch. 8.4 open-hand lesson.
//!
//! Riichi Book 1, ch. 8, "Discard upon chii":
//!
//! > `chii -> discard a tile in the same suit`
//! > `=> the neighborhood of the last discard is safe` — ch8:567–568
//! > `chii -> discard a tile in a different suit`
//! > `=> the neighborhood of the last discard is dangerous` — ch8:569–570
//!
//! The lesson is one opponent with three open melds. Their last call is the
//! chii; their last discard is the tile they threw immediately after it, so the
//! human draws straight after the discard they are reading. Three open sets is
//! also the chapter's own "assume they are ready" shortcut (ch8:412), and the
//! skeleton makes that literal: the two tiles left over after the chii are a
//! pair plus one protorun, so the threat really is tenpai on that protorun.
//!
//! The wait is the whole lesson:
//!
//! - same-suit case: the kept protorun is in a suit different from the
//!   post-chii discard, so the discard's neighbourhood is the one place the
//!   threat is *not* waiting. The answer is a tile in that neighbourhood, and
//!   every other tile in the human's hand is outside it.
//! - different-suit case (the trap): the kept protorun is in the discard's
//!   suit, with one of its winning tiles inside the neighbourhood. The tempting
//!   block is exactly that tile; the answer is the 100%-safe genbutsu the human
//!   holds just outside the neighbourhood, so "pick the tile near their last
//!   discard" is wrong here.

use std::collections::HashMap;

use agari::parse::to_counts;
use agari::shanten::calculate_shanten_with_melds;
use agari::tile::{Honor, Suit, Tile};

use crate::rng::{choose, gen_range, shuffle};
use crate::safety::in_open_hand_neighbourhood;

/// The chii caller is always Kamicha (seat 3): the human draws straight after
/// their post-chii discard, so the tile being read is the last discard on the
/// table.
pub(super) const THREAT_SEAT: usize = 3;

/// Which of the book's three cases the board teaches.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum OpenHandCase {
    /// `chii` and the post-chii discard share a suit: the neighbourhood is safe.
    SameSuit,
    /// `chii` and the post-chii discard are in different suits: the
    /// neighbourhood is dangerous. The trap board.
    DifferentSuit,
}

/// One fixed, verified open-hand lesson before the table is assembled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Skeleton {
    pub case: OpenHandCase,
    /// The suit the last chii was called in.
    pub chi_suit: Suit,
    /// The tile the threat discarded immediately after that chii.
    pub post_chi: Tile,
    /// The human's correct discard.
    pub answer: Tile,
    /// The tile the answer forms a protorun with. This is what makes the fold
    /// visible instead of an incidental float.
    pub block_partner: Tile,
    /// The honor triplet the threat made earlier.
    pub prior_pon: Tile,
    /// The run the threat called earlier, in a third suit.
    pub prior_chi: Vec<Tile>,
    /// The run the threat called on the lesson's chii.
    pub final_chi: Vec<Tile>,
    /// The four tiles the threat still conceals: a pair plus a protorun.
    pub threat_concealed: Vec<Tile>,
    /// The protorun's winning tiles.
    pub threat_wait: Vec<Tile>,
}

/// Builds and verifies one skeleton. Fails instead of returning an
/// unrepresentable board; the caller retries.
pub(super) fn build() -> Result<Skeleton, String> {
    let case = if gen_range(0, 2) == 0 {
        OpenHandCase::SameSuit
    } else {
        OpenHandCase::DifferentSuit
    };

    let post_suit = choose(&[Suit::Man, Suit::Pin, Suit::Sou])
        .ok_or_else(|| "no suit available".to_string())?;
    let other_suits: Vec<Suit> = [Suit::Man, Suit::Pin, Suit::Sou]
        .into_iter()
        .filter(|suit| *suit != post_suit)
        .collect();
    let (chi_suit, wait_suit, prior_chi_suit) = match case {
        // The chii is in the same suit as the discard; the kept block is in
        // one of the other two suits.
        OpenHandCase::SameSuit => (post_suit, other_suits[0], other_suits[1]),
        // The chii is in another suit; the kept block is in the discard's suit.
        OpenHandCase::DifferentSuit => (other_suits[0], post_suit, other_suits[1]),
    };

    // 3..=7 leaves room on both sides of the neighbourhood. It also keeps the
    // neighbourhood four tiles wide, so the human's fill has plenty of room.
    let centre = gen_range(3, 8) as u8;
    let post_chi = Tile::suited(post_suit, centre);

    let (answer, block_partner) = choose_answer(case, post_suit, centre)?;

    // The chii must be a real run that does not reuse the answer, its partner,
    // or the discard (the discard is a separate physical tile).
    let final_chi = choose_run(chi_suit, &[post_chi, answer])?;
    let prior_chi = choose_run(prior_chi_suit, &[])?;

    let prior_pon = Tile::Honor(
        choose(&[
            Honor::East,
            Honor::South,
            Honor::West,
            Honor::North,
            Honor::White,
            Honor::Green,
            Honor::Red,
        ])
        .ok_or_else(|| "no honor available".to_string())?,
    );

    let (threat_concealed, threat_wait) =
        choose_kept_block(case, wait_suit, post_chi, block_partner)?;

    let skeleton = Skeleton {
        case,
        chi_suit,
        post_chi,
        answer,
        block_partner,
        prior_pon,
        prior_chi,
        final_chi,
        threat_concealed,
        threat_wait,
    };

    verify(&skeleton)?;
    Ok(skeleton)
}

/// Picks the answer and the tile it forms a protorun with.
///
/// Same-suit case: the answer is inside the post-chii discard's neighbourhood
/// and its partner is outside it, so the unique neighbourhood tile is a real
/// block tile rather than a float.
///
/// Different-suit case (trap): the answer is just outside the neighbourhood and
/// its partner is the tempting tile inside it.
fn choose_answer(case: OpenHandCase, suit: Suit, centre: u8) -> Result<(Tile, Tile), String> {
    let centre = i8::try_from(centre).map_err(|err| err.to_string())?;
    let post_chi = Tile::suited(suit, centre as u8);
    let mut candidates = Vec::new();

    for direction in [-1i8, 1] {
        match case {
            OpenHandCase::SameSuit => {
                for answer_distance in [1i8, 2] {
                    let answer = centre + direction * answer_distance;
                    for step in [1i8, 2] {
                        let partner = answer + direction * step;
                        if !valid_rank(answer) || !valid_rank(partner) {
                            continue;
                        }
                        let answer_tile = Tile::suited(suit, answer as u8);
                        let partner_tile = Tile::suited(suit, partner as u8);
                        if in_open_hand_neighbourhood(answer_tile, post_chi)
                            && !in_open_hand_neighbourhood(partner_tile, post_chi)
                        {
                            candidates.push((answer_tile, partner_tile));
                        }
                    }
                }
            }
            OpenHandCase::DifferentSuit => {
                for answer_distance in [3i8, 4] {
                    let answer = centre + direction * answer_distance;
                    for step in [1i8, 2] {
                        let partner = answer - direction * step;
                        if !valid_rank(answer) || !valid_rank(partner) {
                            continue;
                        }
                        let answer_tile = Tile::suited(suit, answer as u8);
                        let partner_tile = Tile::suited(suit, partner as u8);
                        if !in_open_hand_neighbourhood(answer_tile, post_chi)
                            && in_open_hand_neighbourhood(partner_tile, post_chi)
                        {
                            candidates.push((answer_tile, partner_tile));
                        }
                    }
                }
            }
        }
    }

    choose(&candidates).ok_or_else(|| "no answer/partner pair fits the neighbourhood".to_string())
}

/// The threat's kept pair plus protorun, and that protorun's winning tiles.
///
/// Same-suit case: any protorun in the other suit; its wait is automatically
/// outside the post-chii discard's neighbourhood.
///
/// Different-suit case: the protorun is in the discard's suit and one of its
/// winning tiles must be the human's tempting `block_partner`, so the trap is
/// a genuinely live tile rather than a lookalike.
fn choose_kept_block(
    case: OpenHandCase,
    suit: Suit,
    post_chi: Tile,
    block_partner: Tile,
) -> Result<(Vec<Tile>, Vec<Tile>), String> {
    let mut candidates = Vec::new();
    for pair_value in 1..=9u8 {
        let pair = Tile::suited(suit, pair_value);
        for start in 1..=8u8 {
            for step in [1u8, 2] {
                let second = start + step;
                if second > 9 {
                    continue;
                }
                let run = [Tile::suited(suit, start), Tile::suited(suit, second)];
                if run.contains(&pair) {
                    continue;
                }
                let waits = protorun_waits(start, step);
                if waits.is_empty() {
                    continue;
                }
                let waits = waits
                    .into_iter()
                    .map(|value| Tile::suited(suit, value))
                    .collect::<Vec<_>>();
                if waits.contains(&post_chi) {
                    continue;
                }

                match case {
                    OpenHandCase::SameSuit => {
                        if waits
                            .iter()
                            .any(|tile| in_open_hand_neighbourhood(*tile, post_chi))
                        {
                            continue;
                        }
                    }
                    OpenHandCase::DifferentSuit => {
                        if !waits.contains(&block_partner) {
                            continue;
                        }
                        // The whole wait must sit inside the dangerous
                        // neighbourhood: that is the trap's premise.
                        if waits
                            .iter()
                            .any(|tile| !in_open_hand_neighbourhood(*tile, post_chi))
                        {
                            continue;
                        }
                    }
                }

                let mut concealed = vec![pair, pair, run[0], run[1]];
                concealed.sort();
                candidates.push((concealed, waits));
            }
        }
    }

    choose(&candidates).ok_or_else(|| "no kept block fits the case".to_string())
}

/// Winning tiles of a two-tile protorun, as ranks.
fn protorun_waits(start: u8, step: u8) -> Vec<u8> {
    match step {
        1 if start == 1 => vec![3],
        1 if start == 8 => vec![7],
        1 => vec![start - 1, start + 2],
        2 => vec![start + 1],
        _ => Vec::new(),
    }
}

fn valid_rank(rank: i8) -> bool {
    (1..=9).contains(&rank)
}

/// Picks a run in `suit` that uses none of `avoid`.
fn choose_run(suit: Suit, avoid: &[Tile]) -> Result<Vec<Tile>, String> {
    let mut starts: Vec<u8> = (1..=7)
        .filter(|start| {
            let run = [
                Tile::suited(suit, *start),
                Tile::suited(suit, start + 1),
                Tile::suited(suit, start + 2),
            ];
            run.iter().all(|tile| !avoid.contains(tile))
        })
        .collect();
    if starts.is_empty() {
        return Err("no run avoids the lesson tiles".to_string());
    }
    shuffle(&mut starts);
    let start = starts[0];
    Ok(vec![
        Tile::suited(suit, start),
        Tile::suited(suit, start + 1),
        Tile::suited(suit, start + 2),
    ])
}

/// Re-checks every structural promise the board relies on.
pub(super) fn verify(skeleton: &Skeleton) -> Result<(), String> {
    if !is_run(&skeleton.final_chi, Some(skeleton.chi_suit)) {
        return Err("the last chii is not a run in the chii suit".to_string());
    }
    if !is_run(&skeleton.prior_chi, None) {
        return Err("the earlier chii is not a run".to_string());
    }
    if skeleton.prior_chi.first().and_then(Tile::suit) == Some(skeleton.chi_suit) {
        return Err("the earlier chii must be in another suit".to_string());
    }
    if skeleton.threat_concealed.len() != 4 {
        return Err("the threat must keep four concealed tiles".to_string());
    }

    let answer_neighbourhood = in_open_hand_neighbourhood(skeleton.answer, skeleton.post_chi);
    let partner_neighbourhood =
        in_open_hand_neighbourhood(skeleton.block_partner, skeleton.post_chi);
    match skeleton.case {
        OpenHandCase::SameSuit => {
            if !answer_neighbourhood {
                return Err("the same-suit answer must sit inside the neighbourhood".to_string());
            }
            if partner_neighbourhood {
                return Err("the block partner must sit outside the neighbourhood".to_string());
            }
            if skeleton
                .threat_wait
                .iter()
                .any(|tile| in_open_hand_neighbourhood(*tile, skeleton.post_chi))
            {
                return Err("the same-suit threat must not wait in the neighbourhood".to_string());
            }
        }
        OpenHandCase::DifferentSuit => {
            if answer_neighbourhood {
                return Err("the trap answer must sit outside the neighbourhood".to_string());
            }
            if !partner_neighbourhood {
                return Err("the trap tile must sit inside the neighbourhood".to_string());
            }
            if !skeleton.threat_wait.contains(&skeleton.block_partner) {
                return Err("the trap tile must be one of the threat's winning tiles".to_string());
            }
            if skeleton
                .threat_wait
                .iter()
                .any(|tile| !in_open_hand_neighbourhood(*tile, skeleton.post_chi))
            {
                return Err(
                    "the different-suit threat must wait inside the neighbourhood".to_string(),
                );
            }
        }
    }

    // The block itself.
    let (Some(answer_suit), Some(answer_value)) = (skeleton.answer.suit(), skeleton.answer.value())
    else {
        return Err("the answer must be a suited tile".to_string());
    };
    let (Some(partner_suit), Some(partner_value)) = (
        skeleton.block_partner.suit(),
        skeleton.block_partner.value(),
    ) else {
        return Err("the block partner must be a suited tile".to_string());
    };
    if answer_suit != partner_suit || !(1..=2).contains(&answer_value.abs_diff(partner_value)) {
        return Err("the answer and its partner must form a protorun".to_string());
    }

    // The threat really must be tenpai with three melds.
    let shanten = calculate_shanten_with_melds(&to_counts(&skeleton.threat_concealed), 3).shanten;
    if shanten != 0 {
        return Err(format!(
            "the three-meld threat must be tenpai, got shanten {shanten}"
        ));
    }

    // No structural tile may need a fifth copy.
    let mut counts: HashMap<Tile, u8> = HashMap::new();
    let structural = skeleton
        .prior_chi
        .iter()
        .chain(skeleton.final_chi.iter())
        .chain(skeleton.threat_concealed.iter())
        .copied()
        .chain([skeleton.post_chi, skeleton.answer, skeleton.block_partner]);
    for tile in structural {
        let count = counts.entry(tile).or_insert(0);
        *count += 1;
        if *count > 4 {
            return Err(format!("the skeleton needs too many copies of {tile}"));
        }
    }
    let pon_count = counts.entry(skeleton.prior_pon).or_insert(0);
    if *pon_count + 3 > 4 {
        return Err(format!(
            "the skeleton needs too many copies of {}",
            skeleton.prior_pon
        ));
    }

    Ok(())
}

/// True when `run` is three consecutive ranks in `suit` (or any single suit
/// when `suit` is `None`).
fn is_run(run: &[Tile], suit: Option<Suit>) -> bool {
    if run.len() != 3 {
        return false;
    }
    let mut values = Vec::with_capacity(3);
    for tile in run {
        let Some(tile_suit) = tile.suit() else {
            return false;
        };
        if suit.is_some_and(|expected| expected != tile_suit) {
            return false;
        }
        let Some(value) = tile.value() else {
            return false;
        };
        values.push(value);
    }
    values.sort_unstable();
    values.windows(2).all(|pair| pair[1] == pair[0] + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_skeleton_keeps_its_structural_promises() {
        let mut saw_same_suit = false;
        let mut saw_different_suit = false;

        for _ in 0..300 {
            let skeleton = build().expect("skeleton must build");
            verify(&skeleton).expect("skeleton must verify");

            match skeleton.case {
                OpenHandCase::SameSuit => {
                    saw_same_suit = true;
                    assert!(in_open_hand_neighbourhood(
                        skeleton.answer,
                        skeleton.post_chi
                    ));
                    assert!(!in_open_hand_neighbourhood(
                        skeleton.block_partner,
                        skeleton.post_chi
                    ));
                    assert!(
                        skeleton
                            .threat_wait
                            .iter()
                            .all(|tile| !in_open_hand_neighbourhood(*tile, skeleton.post_chi)),
                        "the same-suit threat must wait elsewhere"
                    );
                }
                OpenHandCase::DifferentSuit => {
                    saw_different_suit = true;
                    assert!(!in_open_hand_neighbourhood(
                        skeleton.answer,
                        skeleton.post_chi
                    ));
                    assert!(in_open_hand_neighbourhood(
                        skeleton.block_partner,
                        skeleton.post_chi
                    ));
                    assert!(skeleton.threat_wait.contains(&skeleton.block_partner));
                    assert!(
                        skeleton
                            .threat_wait
                            .iter()
                            .all(|tile| in_open_hand_neighbourhood(*tile, skeleton.post_chi)),
                        "the trap threat must wait in the neighbourhood"
                    );
                }
            }

            assert_eq!(
                skeleton.chi_suit == skeleton.post_chi.suit().expect("suited"),
                skeleton.case == OpenHandCase::SameSuit
            );
        }

        assert!(saw_same_suit && saw_different_suit);
    }

    #[test]
    fn the_chii_never_reuses_the_post_chi_discard() {
        for _ in 0..200 {
            let skeleton = build().expect("skeleton");
            assert!(!skeleton.final_chi.contains(&skeleton.post_chi));
            assert!(!skeleton.prior_chi.contains(&skeleton.post_chi));
        }
    }

    #[test]
    fn a_protorun_wait_table_covers_edges_and_kanchan() {
        assert_eq!(protorun_waits(1, 1), vec![3]);
        assert_eq!(protorun_waits(8, 1), vec![7]);
        assert_eq!(protorun_waits(3, 1), vec![2, 5]);
        assert_eq!(protorun_waits(3, 2), vec![4]);
    }
}
