//! `daiminkan_decision`: Riichi Book 1, ch. 9.3.2 "Open quad (daiminkan)".
//!
//! The book's rule:
//!
//! > You can make an open quad in any of the following situations:
//! > - the hand is ready with a good wait, and the hand value is between 2000
//! >   and 5200 points; — ch9:323
//! > - you need more dora or minipoints to improve the placement (especially in
//! >   South-4); — ch9:324
//! > - you are losing badly. — ch9:325
//!
//! and three boxes that draw its edges (ch9:336, ch9:348, ch9:358): the same
//! ready hand calls the quad at 2000 points with a good wait, but not when the
//! wait is bad, and not when it is only worth 1000.
//!
//! The drill deals the book's own shape — a called run, a concealed run, an
//! honor pair, a two-tile protorun and three concealed copies of a dragon —
//! and has the player's right-hand opponent discard the fourth copy. The
//! question is one neutral call: **Call the Kan, or pass?** (`TargetAction::Call`,
//! the same book-call prompt `meld_or_not` uses, because the decline answer is a
//! pass rather than a discard). Half the puzzles are the book's yes and half
//! its no, and the coin flip happens before rejection sampling so the prompt
//! never telegraphs the answer.
//!
//! Every number the lesson argues from is recomputed from the finished state by
//! [`facts`]: the hand's ron value before and after the quad, the wait shape,
//! and the score line. `rationale::daiminkan_rationale` reads the same facts.
//!
//! Anki cards: 1463256729338 ("In what 3 situations is it okay to make a melded
//! quad?").

mod board;
mod skeleton;
mod value;

use agari::parse::to_counts;
use agari::shanten::{calculate_shanten, calculate_ukeire};
use agari::tile::Tile;

use crate::generator::support::retry::generate_with_retries;
use crate::rng::{gen_bool, gen_range};
use crate::state::GameState;

use skeleton::{DaiminkanShape, DaiminkanSkeleton};

/// Seat index the human occupies, whose called run always came from Kamicha.
const HUMAN_SEAT: usize = 0;

/// The value band the book calls justifiable.
const BAND_LOW: u32 = 2_000;
const BAND_HIGH: u32 = 5_200;

/// Riichi Book 1's "losing badly" scale, shared with the kakan lesson: more
/// than 12,000 behind the player in third.
const LOSING_BADLY_GAP: i32 = 12_000;

/// Generates one open-quad decision.
///
/// One lesson, one neutral question, so the coin flip happens before rejection
/// sampling: half the puzzles are the book's Kan and half are the book's pass.
pub fn generate(category: &str) -> Result<GameState, String> {
    if gen_bool(0.5) {
        generate_kan(category)
    } else {
        generate_pass(category)
    }
}

/// The book's yes: one of the three situations justifies the open quad.
fn generate_kan(category: &str) -> Result<GameState, String> {
    generate_with_retries("daiminkan (kan)", 20_000, || {
        let (shape, table) = match gen_range(0, 3) {
            // "ready with a good wait, and the hand value is between 2000 and
            // 5200 points": the book's own box.
            0 => (
                DaiminkanShape::GoodWaitValue,
                board::DaiminkanTable::Balanced,
            ),
            // "you need more dora or minipoints to improve the placement
            // (especially in South-4)": a 1000-point hand, one place behind by
            // a gap only the quad's minipoints close.
            1 => (
                DaiminkanShape::CheapGoodWait,
                board::DaiminkanTable::PlacementDesperation,
            ),
            // "you are losing badly": the same cheap hand far behind in fourth.
            _ => (
                if gen_bool(0.5) {
                    DaiminkanShape::CheapGoodWait
                } else {
                    DaiminkanShape::BadWaitValue
                },
                board::DaiminkanTable::LosingBadly,
            ),
        };
        let skeleton = skeleton::build(shape)?;
        board::build(
            category,
            &skeleton,
            shape,
            board::DaiminkanAnswer::Kan,
            table,
        )
    })
}

/// The book's no: a ready hand that misses all three situations.
///
/// The two boxes the book uses to draw the line: a 2000-point hand on a bad
/// wait, and a 1000-point hand on a good wait. Neither is score-pressured, so
/// the decline is the whole answer.
fn generate_pass(category: &str) -> Result<GameState, String> {
    generate_with_retries("daiminkan (pass)", 20_000, || {
        let shape = if gen_bool(0.5) {
            DaiminkanShape::CheapGoodWait
        } else {
            DaiminkanShape::BadWaitValue
        };
        let skeleton = skeleton::build(shape)?;
        board::build(
            category,
            &skeleton,
            shape,
            board::DaiminkanAnswer::Pass,
            board::DaiminkanTable::Balanced,
        )
    })
}

/// The three situations ch. 9.3.2 lists, as the flags one board satisfies.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) struct DaiminkanTriggerSet {
    /// Ready with a good wait and a hand worth 2000-5200.
    pub good_wait_and_value: bool,
    /// South-4, one place behind by a gap the quad's minipoints close.
    pub placement_desperation: bool,
    /// Fourth place, far behind.
    pub losing_badly: bool,
}

impl DaiminkanTriggerSet {
    pub(crate) fn any(self) -> bool {
        self.good_wait_and_value || self.placement_desperation || self.losing_badly
    }
}

/// The hand values the placement argument trades between.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct QuadWindow {
    /// What the ready hand wins for while the fourth copy stays in the river.
    pub dama: u32,
    /// What the same wait wins for once the fourth copy joins the quad.
    pub kan: u32,
}

/// Everything the lesson claims about one finished table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DaiminkanFacts {
    /// The dragon the opponent offered.
    pub quad: Tile,
    pub han: u8,
    pub fu: u8,
    /// Ron value of the ready hand as it stands.
    pub value: u32,
    /// Ron value of the same wait once the quad is called (before any new
    /// dora the quad turns up).
    pub quad_value: u32,
    /// How many kinds of tile the hand wins on.
    pub wait_kinds: usize,
    /// True when the wait is a side wait (two kinds).
    pub good_wait: bool,
    /// True when the ready hand sits inside the book's 2000-5200 band.
    pub in_value_band: bool,
    /// South-4, 2nd or 3rd, behind by a gap only the quad closes.
    pub placement: bool,
    /// Fourth place, far behind.
    pub losing_badly: bool,
    /// The human's current place at the table, 1-based.
    pub rank: usize,
    /// Points between the human and the player directly above, if any.
    pub gap_to_above: Option<i32>,
}

impl DaiminkanFacts {
    /// Which of the book's three situations this table satisfies.
    pub(crate) fn triggers(&self) -> DaiminkanTriggerSet {
        DaiminkanTriggerSet {
            good_wait_and_value: self.good_wait && self.in_value_band,
            placement_desperation: self.placement,
            losing_badly: self.losing_badly,
        }
    }
}

/// Reads the lesson's claims off a finished table.
///
/// Returns `None` when the state is not an open-quad reaction (no offer, no
/// called run, or the human does not hold three copies), so an imported report
/// of some other lesson cannot claim this rationale.
pub(crate) fn facts(state: &GameState) -> Option<DaiminkanFacts> {
    let human = state.players.iter().find(|player| player.is_human)?;
    if human.seat != HUMAN_SEAT || human.melds.len() != 1 {
        return None;
    }
    let quad = Tile::try_from(state.call_offer.as_ref()?.tile.as_str()).ok()?;
    let hand: Vec<Tile> = human
        .hand
        .iter()
        .filter_map(|code| Tile::try_from(code.as_str()).ok())
        .collect();
    if hand.len() != 10 || hand.iter().filter(|tile| **tile == quad).count() != 3 {
        return None;
    }
    let open_run = human
        .melds
        .first()?
        .tiles
        .iter()
        .filter_map(|code| Tile::try_from(code.as_str()).ok())
        .min()?;

    let mut blocks = hand.clone();
    for _ in 0..3 {
        let index = blocks.iter().position(|tile| *tile == quad)?;
        blocks.remove(index);
    }

    // Recompute the wait rather than trusting the payload's copy.
    let hand_with_meld: Vec<Tile> = hand
        .iter()
        .copied()
        .chain(
            human
                .melds
                .first()?
                .tiles
                .iter()
                .filter_map(|code| Tile::try_from(code.as_str()).ok()),
        )
        .collect();
    let counts = to_counts(&hand_with_meld);
    if calculate_shanten(&counts).shanten != 0 {
        return None;
    }
    let waits: Vec<Tile> = calculate_ukeire(&counts)
        .tiles
        .iter()
        .map(|tile| tile.tile)
        .collect();

    let dora_indicators: Vec<Tile> = state
        .dora_indicators
        .iter()
        .filter_map(|code| Tile::try_from(code.as_str()).ok())
        .collect();
    let values = values_for(
        &blocks,
        open_run,
        quad,
        &waits,
        state.round_wind,
        human.wind,
        &dora_indicators,
    )?;

    let human_score = human.score;
    let mut scores: Vec<i32> = state.players.iter().map(|player| player.score).collect();
    scores.sort_by(|a, b| b.cmp(a));
    let rank = 1 + scores.iter().filter(|score| **score > human_score).count();
    let above = state
        .players
        .iter()
        .map(|player| player.score)
        .filter(|score| *score > human_score)
        .min();
    let gap_to_above = above.map(|score| score - human_score);

    let in_value_band = (BAND_LOW..=BAND_HIGH).contains(&values.current.points);
    let placement = state.round_wind == crate::state::Wind::South
        && state.hand_number == 4
        && matches!(rank, 2 | 3)
        && gap_to_above.is_some_and(|gap| {
            gap > 0 && (gap as u32) > values.current.points && (gap as u32) <= values.quad.points
        });
    let third = scores.get(2).copied().unwrap_or_default();
    let losing_badly = rank == 4 && third - human_score > LOSING_BADLY_GAP;

    Some(DaiminkanFacts {
        quad,
        han: values.current.han,
        fu: values.current.fu,
        value: values.current.points,
        quad_value: values.quad.points,
        wait_kinds: waits.len(),
        good_wait: waits.len() >= 2,
        in_value_band,
        placement,
        losing_badly,
        rank,
        gap_to_above,
    })
}

struct Values {
    current: value::RonValue,
    quad: value::RonValue,
}

fn values_for(
    blocks: &[Tile],
    open_run: Tile,
    quad: Tile,
    waits: &[Tile],
    round_wind: crate::state::Wind,
    seat_wind: crate::state::Wind,
    dora_indicators: &[Tile],
) -> Option<Values> {
    let hand = value::OpenQuadHand {
        blocks,
        open_run,
        quad,
        waits,
        round_wind,
        seat_wind,
        dora_indicators,
        aka: 0,
    };
    Some(Values {
        current: hand.current_value()?,
        quad: hand.quad_value()?,
    })
}

/// The hand's two ron values from a skeleton, before a table exists.
fn quad_window(
    skeleton: &DaiminkanSkeleton,
    round_wind: crate::state::Wind,
    seat_wind: crate::state::Wind,
    dora_indicators: &[Tile],
) -> Option<QuadWindow> {
    // The ten concealed tiles hold the three copies; the called run is a meld
    // and must not be scored as part of the concealed hand.
    let mut blocks = skeleton.concealed_tiles.clone();
    for _ in 0..3 {
        let index = blocks.iter().position(|tile| *tile == skeleton.quad_tile)?;
        blocks.remove(index);
    }
    let values = values_for(
        &blocks,
        skeleton.open_run_start(),
        skeleton.quad_tile,
        &skeleton.wait_tiles,
        round_wind,
        seat_wind,
        dora_indicators,
    )?;
    Some(QuadWindow {
        dama: values.current.points,
        kan: values.quad.points,
    })
}

#[cfg(test)]
mod tests {
    use super::board::{DaiminkanAnswer, DaiminkanTable};
    use super::*;

    use agari::context::indicator_to_dora;

    use crate::generator::support::testing::parse_tile;
    use crate::state::{CorrectActionType, DecisionContext, MeldType, TargetAction};

    fn assert_common(state: &GameState) {
        assert_eq!(state.category, "daiminkan_decision");
        assert_eq!(state.target_action, TargetAction::Call);
        assert_eq!(state.players.len(), 4);
        assert_eq!(state.dora_indicators.len(), 1);
        assert_eq!(state.ura_dora_indicators.len(), 1);
        assert!(state.tiles_remaining > 0);
        assert!(state.riichi_triggers.is_empty());
        assert!(state.dama_reasons.is_empty());
        assert!(state.shouminkan_triggers.is_empty());
        assert_eq!(state.shanten, 0, "the drill is a ready hand");
        assert!(!state.is_agari);

        let human = &state.players[0];
        assert!(human.is_human);
        assert_eq!(human.hand.len(), 10);
        assert!(human.draw.is_none());
        assert!(!human.is_riichi);
        assert_eq!(human.melds.len(), 1);
        assert_eq!(human.melds[0].meld_type, MeldType::Chi);
        assert_eq!(human.melds[0].tiles.len(), 3);
        assert_eq!(human.melds[0].called_from, Some(3));

        let offer = state
            .call_offer
            .as_ref()
            .expect("the offer is in the payload");
        assert_eq!(offer.action, "Kan");
        assert!(offer.label.starts_with("Kan "));
        let quad = parse_tile(&offer.tile);
        assert_eq!(
            human
                .hand
                .iter()
                .filter(|tile| **tile == offer.tile)
                .count(),
            3,
            "the human holds three copies and the fourth is offered"
        );
        assert_eq!(
            human
                .melds
                .iter()
                .flat_map(|meld| meld.tiles.iter())
                .filter(|tile| **tile == offer.tile)
                .count(),
            0,
            "the quad tile is never already open"
        );

        let DecisionContext::ReactToDiscard { from, tile } = &state.decision else {
            panic!("the lesson is a call reaction");
        };
        assert_eq!(tile, &offer.tile);
        assert_eq!(state.current_turn, *from);
        assert!((1..=3).contains(from));
        let source = &state.players[*from];
        let last = source.discards.last().expect("the source has a discard");
        assert_eq!(last.tile, offer.tile);
        assert!(!last.is_tsumogiri);
        assert!(
            state
                .scenario_note
                .as_deref()
                .is_some_and(|note| note.contains(&offer.label[4..])),
            "the prompt must name the offered tile"
        );

        // The quad tile is never dora, so the lesson's value comes from the
        // hand rather than the offered tile.
        let indicator = parse_tile(&state.dora_indicators[0]);
        assert_ne!(indicator_to_dora(indicator), quad);

        // The human is not furiten on any winning tile.
        for wait in &state.ukeire_tiles {
            assert!(
                !human.discards.iter().any(|discard| &discard.tile == wait),
                "the human river holds the winning tile {wait}"
            );
        }

        let total_score: i32 = state.players.iter().map(|player| player.score).sum();
        assert_eq!(total_score, 100_000);
    }

    fn assert_kan(state: &GameState) {
        assert_common(state);
        assert_eq!(state.correct_action.action_type(), CorrectActionType::Kan);
        let offer = state.call_offer.as_ref().expect("offer");
        assert_eq!(
            state.correct_action.tile(),
            Some(offer.tile.as_str()),
            "the answer is to call the quad on the offered tile"
        );
        let facts = facts(state).expect("facts");
        assert!(
            facts.triggers().any(),
            "the Kan must satisfy one of the book's conditions: {facts:?}"
        );
    }

    fn assert_pass(state: &GameState) {
        assert_common(state);
        assert_eq!(state.correct_action.action_type(), CorrectActionType::Pass);
        assert_eq!(state.correct_action.tile(), None);
        let facts = facts(state).expect("facts");
        assert!(
            !facts.triggers().any(),
            "the pass must miss every condition: {facts:?}"
        );
    }

    #[test]
    fn test_daiminkan_decision_constraints() {
        let started = std::time::Instant::now();
        let mut kan_count = 0usize;
        let mut pass_count = 0usize;
        let mut band = 0usize;
        let mut placement = 0usize;
        let mut losing = 0usize;
        let mut bad_wait = 0usize;
        let mut cheap = 0usize;

        for run in 0..400 {
            let state = generate("daiminkan_decision")
                .unwrap_or_else(|err| panic!("run {run} failed: {err}"));
            match state.correct_action.action_type() {
                CorrectActionType::Kan => {
                    kan_count += 1;
                    assert_kan(&state);
                    let facts = facts(&state).expect("facts");
                    let triggers = facts.triggers();
                    if triggers.good_wait_and_value {
                        band += 1;
                        assert!(
                            (BAND_LOW..=BAND_HIGH).contains(&facts.value),
                            "run {run}: {} points is outside the book's band",
                            facts.value
                        );
                        assert!(facts.good_wait);
                    }
                    if triggers.placement_desperation {
                        placement += 1;
                        assert_eq!(state.round_wind, crate::state::Wind::South);
                        assert_eq!(state.hand_number, 4);
                        assert!(matches!(facts.rank, 2 | 3));
                        let gap = facts.gap_to_above.expect("a gap exists");
                        assert!(gap as u32 > facts.value && gap as u32 <= facts.quad_value);
                    }
                    if triggers.losing_badly {
                        losing += 1;
                        assert_eq!(facts.rank, 4);
                    }
                }
                CorrectActionType::Pass => {
                    pass_count += 1;
                    assert_pass(&state);
                    let facts = facts(&state).expect("facts");
                    if facts.good_wait {
                        cheap += 1;
                        assert!(facts.value < BAND_LOW, "the cheap box is 1000 points");
                    } else {
                        bad_wait += 1;
                        assert!(
                            (BAND_LOW..=BAND_HIGH).contains(&facts.value),
                            "the bad-wait box is the book's 2000-point hand"
                        );
                    }
                }
                other => panic!("run {run}: unexpected answer {other:?}"),
            }
        }

        println!(
            "answer coverage: {kan_count} Kan / {pass_count} pass; \
             situations: {band} band / {placement} placement / {losing} losing; \
             passes: {bad_wait} bad wait / {cheap} cheap"
        );
        assert!(
            kan_count >= 120 && pass_count >= 120,
            "the coin flip must land roughly 50/50, got {kan_count}/{pass_count}"
        );
        assert!(
            band > 0 && placement > 0 && losing > 0,
            "all three situations must appear"
        );
        assert!(
            bad_wait > 0 && cheap > 0,
            "both of the book's decline boxes must appear"
        );

        let elapsed = started.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(20),
            "400 daiminkan generations took {elapsed:?}"
        );
    }

    #[test]
    fn test_daiminkan_facts_ignore_other_lessons() {
        assert!(
            facts(&crate::fixtures::mock_table::generate("mock_table").expect("fixture")).is_none(),
            "only an open-quad reaction carries these facts"
        );
    }

    #[test]
    fn test_each_book_situation_can_be_built() {
        for (shape, table, answer) in [
            (
                DaiminkanShape::GoodWaitValue,
                DaiminkanTable::Balanced,
                DaiminkanAnswer::Kan,
            ),
            (
                DaiminkanShape::CheapGoodWait,
                DaiminkanTable::PlacementDesperation,
                DaiminkanAnswer::Kan,
            ),
            (
                DaiminkanShape::CheapGoodWait,
                DaiminkanTable::LosingBadly,
                DaiminkanAnswer::Kan,
            ),
            (
                DaiminkanShape::BadWaitValue,
                DaiminkanTable::Balanced,
                DaiminkanAnswer::Pass,
            ),
            (
                DaiminkanShape::CheapGoodWait,
                DaiminkanTable::Balanced,
                DaiminkanAnswer::Pass,
            ),
        ] {
            let mut built = None;
            for _ in 0..200 {
                let Ok(skeleton) = skeleton::build(shape) else {
                    continue;
                };
                if let Ok(state) =
                    board::build("daiminkan_decision", &skeleton, shape, answer, table)
                {
                    built = Some(state);
                    break;
                }
            }
            let state =
                built.unwrap_or_else(|| panic!("could not build {shape:?} on a {table:?} table"));
            assert_common(&state);
            assert_eq!(
                state.correct_action.action_type() == CorrectActionType::Kan,
                answer == DaiminkanAnswer::Kan
            );
            let parsed = facts(&state).unwrap_or_else(|| panic!("no facts for {state:?}"));
            assert_eq!(parsed.triggers(), {
                let mut expected = table.trigger();
                expected.good_wait_and_value = shape.wants_dora() && shape.wants_good_wait();
                expected
            });
        }
    }

    #[test]
    fn test_skeletons_hold_their_waits() {
        for shape in [
            DaiminkanShape::GoodWaitValue,
            DaiminkanShape::BadWaitValue,
            DaiminkanShape::CheapGoodWait,
        ] {
            let skeleton = skeleton::build(shape).expect("skeleton must build");
            assert_eq!(
                skeleton.wait_tiles.len(),
                if skeleton.good_wait { 2 } else { 1 }
            );
            let counts = to_counts(&skeleton.hand_tiles());
            assert_eq!(calculate_shanten(&counts).shanten, 0);
        }
    }

    #[test]
    fn test_the_offered_quad_and_pass_are_both_legal() {
        use crate::ai::actions::{KAN_ACTION, PASS_ACTION, legal_action_mask};

        for _ in 0..20 {
            let state = generate("daiminkan_decision").expect("lesson must generate");
            let mask = legal_action_mask(&state);
            assert!(mask[KAN_ACTION], "the daiminkan must be a legal action");
            assert!(mask[PASS_ACTION], "passing must be a legal action");
            assert!(
                !mask[crate::ai::actions::AGARI_ACTION],
                "the fourth copy never completes the hand"
            );
        }
    }

    #[test]
    fn test_the_value_band_is_the_books() {
        // The book's boxes: 2000 with a dora, 1000 without.
        assert!(DaiminkanShape::GoodWaitValue.wants_dora());
        assert!(!DaiminkanShape::CheapGoodWait.wants_dora());
        assert!(DaiminkanShape::GoodWaitValue.wants_good_wait());
        assert!(!DaiminkanShape::BadWaitValue.wants_good_wait());
    }
}
