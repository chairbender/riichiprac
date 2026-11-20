//! The ch. 7 Riichi/dama recognisers: `riichi_judgement` and the four `dama_*`
//! lessons.
//!
//! Every lesson in this family asks the same structural question — the human
//! holds a closed 14-tile hand whose one tenpai discard is the answer to
//! "declare Riichi or stay in dama?" — and differs only in which ch. 7 cell
//! decides. The recognisers therefore share one tenpai reading
//! ([`super::support`]) and one unanimity rule: every discard that leaves the
//! hand tenpai must land in the same cell, or the state is not this lesson's
//! question.
//!
//! The book cells, as the generators encode them:
//!
//! - [`super::ScenarioId::RiichiJudgement`] — the general three-condition rule
//!   (ch7:55-59): riichi if at least one of extra han, good wait, dealer holds.
//!   Its dama cell (the empty condition set) and the 1-2 live-tile cells belong
//!   to the later bad-wait box, and the other dama sections own their hands, so
//!   this recogniser defers all of them.
//! - [`super::ScenarioId::DamaBadWait`] — the ch7:521 box: 3+ live winning tiles
//!   call riichi; 1-2 live simple tiles stay dama; 1-2 live honor/terminal tiles
//!   may call riichi.
//! - [`super::ScenarioId::DamaGenbutsuWait`] — ch7:539: dama when one winning
//!   tile is the genbutsu of the player drawing all the attention.
//! - [`super::ScenarioId::DamaExpensiveHand`] — ch7:569/598/646: dama when the
//!   worst ron value without riichi is 7700, and never riichi at haneman.
//! - [`super::ScenarioId::DamaImprovingHand`] — ch7:656-660: dama on an early
//!   turn when six kinds (or one three-han step) improve the ready hand.
//!
//! The dama exceptions that the book leaves to board reading (in the lead,
//! cheap/expensive waits, trap waits) are **not** modelled: a classifier that
//! cannot read the exception returns `None` rather than claiming dama.
//!
//! See the module-level note in [`super`] on the ch. 7 disagreement. The lesson
//! generators now build disjoint cells, so a *generated* state never needs the
//! Mortal tiebreak; an arbitrary replay state can still hit two sections at
//! once, and `classify_with_mortal` settles it.
//!
//! # The seven-pairs cell and the ch. 5.1 deferral
//!
//! [`chiitoitsu_riichi_vs_dama`] is ch. 7.2's seven-pairs rule (ch7:337/345-359).
//! Its hand is six pairs plus two lone tiles, so none of the standard-hand
//! recognisers in this module can read it (`Kept::is_standard` refuses a
//! chiitoitsu wait) and it can never be double-labelled inside the family.
//!
//! Every recogniser here also declines a table that ch. 5.1's floating-sanshoku
//! cell claims: that hand is a *wait-choice* question (an extra tile and two
//! teaching waits, ch5:62/74) and the app ships it as
//! [`ScenarioId::SanshokuPursuit`], not as a declaration.

use agari::context::indicator_to_dora;
use agari::parse::to_counts;
use agari::scoring::ScoreLevel;
use agari::tile::Tile;

use crate::generator::ScenarioId;
use crate::generator::chiitoitsu_riichi_vs_dama::scoring;
use crate::generator::dama_bad_wait::judgement as bad_wait;
use crate::generator::dama_expensive_hand::judgement as expensive;
use crate::generator::dama_genbutsu_wait::judgement as genbutsu;
use crate::generator::dama_improving_hand::improvement;
use crate::generator::support::tiles::{is_outside_456, suji_tiles};
use crate::safety::SafetyFacts;
use crate::state::{CorrectAction, DamaReason, GameState, RiichiTrigger, TargetAction, Wind};

use super::support::{self, Candidate, Kept, Turn};
use super::{Allowed, Match, TransformPolicy};

/// The declaration a riichi/dama cell picks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Declaration {
    Riichi,
    Dama,
}

/// ch. 7 labels survive suit/rank/wind/seat relabelling once the label is
/// recomputed; red-five normalisation changes the hand's value (ch7:569's 7700
/// is a red-five rule), so it stays denied (`replay-implementation-plan` §4.5).
pub(crate) const DAMA_POLICY: TransformPolicy = TransformPolicy {
    seat_perm: Allowed::AllowWithRecompute,
    suit_perm: Allowed::AllowWithRecompute,
    rank_mirror: Allowed::AllowWithRecompute,
    wind_relabel: Allowed::AllowWithRecompute,
    red5_normalize: Allowed::Deny,
    note: "ch7 riichi/dama cells are shape, wait and value rules; the label must be \
           recomputed after any seat/suit/rank/wind relabelling. A red five is worth one \
           han, so normalising it can move a hand across the 7700 and extra-han thresholds.",
};

/// The seven-pairs cell shares the ch. 7 reasoning, and the red five is even
/// more load-bearing here: ch7:345-353 makes "one red five, waiting for a
/// regular five" a Riichi criterion *and* the single-answer variant of the
/// drill, so normalising it rewrites the question.
pub(crate) const CHIITOITSU_POLICY: TransformPolicy = TransformPolicy {
    seat_perm: Allowed::AllowWithRecompute,
    suit_perm: Allowed::AllowWithRecompute,
    rank_mirror: Allowed::AllowWithRecompute,
    wind_relabel: Allowed::AllowWithRecompute,
    red5_normalize: Allowed::Deny,
    note: "the seven-pairs cell is a shape, wait and value rule (dealer, tanyao, suji trap, \
           wait rank, below-mangan), so every relabelling re-runs it; the red-five variant's \
           whole answer is which lone tile is kept, so normalising a red five rewrites the \
           question",
};

/// The general three-condition rule (ch7:55-59), on the cells it owns.
///
/// The chapter's later dama sections refine the general rule, and the shipped
/// lessons encode each one. This recogniser therefore **defers** every cell a
/// dedicated lesson owns, so the two never answer the same hand differently:
///
/// - `dama_bad_wait` owns bad waits (the 1-2 live-tile cells and the
///   three-condition empty set, which is the same bad-wait box's territory);
/// - `dama_genbutsu_wait`, `dama_expensive_hand` and `dama_improving_hand` own
///   the hands their sections keep in dama.
///
/// What remains is the general rule's riichi cells, so the answer here is
/// always Riichi.
pub fn riichi_judgement(state: &GameState) -> Option<Match> {
    let turn = support::turn(state)?;
    // ch. 5.1's floating-sanshoku cell owns a wait-choice table; the
    // declaration question is not shipped there (see `super::sanshoku`).
    if super::sanshoku::takes_wait_choice(&turn, state) {
        return None;
    }

    let candidates = support::candidates(&turn)?;
    let facts =
        support::sole_riichi_threat(state).and_then(|seat| SafetyFacts::from_state(state, seat));
    let (_, chosen, equivalents) = unanimity_index(&turn, &candidates, |turn, kept| {
        if !is_book_tenpai(kept) {
            return None;
        }
        // The bad-wait box owns every bad-wait cell: the 1-2 live tiles by its
        // own threshold (ch7:521) and the empty three-condition set, which is a
        // bad-wait riichi-only non-dealer hand.
        if kept.quality.live_tiles <= 2 || !kept.conditions.picks_riichi() {
            return None;
        }
        // The later ch7 dama sections own their hands.
        if facts
            .as_ref()
            .is_some_and(|facts| genbutsu::applies(&kept.waits, facts))
        {
            return None;
        }
        if expensive_cell(turn, kept).is_some() || improving_cell(turn, kept).is_some() {
            return None;
        }
        Some(())
    })?;

    if !riichi_is_legal(state) {
        return None;
    }
    let conditions = candidates[chosen].kept.conditions;
    let mut triggers = Vec::new();
    if conditions.extra_han {
        triggers.push(RiichiTrigger::HasExtraHan);
    }
    if conditions.good_wait {
        triggers.push(RiichiTrigger::GoodWait);
    }
    if conditions.dealer {
        triggers.push(RiichiTrigger::Dealer);
    }

    Some(declaration_match(
        ScenarioId::RiichiJudgement,
        Some(conditions.label().to_string()),
        Declaration::Riichi,
        candidates[chosen].discard,
        equivalents,
        Hints {
            triggers,
            reasons: Vec::new(),
        },
        None,
    ))
}

/// ch7:521's bad-wait box.
pub fn dama_bad_wait(state: &GameState) -> Option<Match> {
    let turn = support::turn(state)?;
    // ch. 5.1's floating-sanshoku cell owns a wait-choice table; the
    // declaration question is not shipped there (see `super::sanshoku`).
    if super::sanshoku::takes_wait_choice(&turn, state) {
        return None;
    }

    let candidates = support::candidates(&turn)?;
    // The immediate-suji-trap lesson is a refinement of this box's dama cell:
    // when a trap discard exists, ch7:512 makes the declaration right and the
    // box must not also call the hand dama.
    if super::suji::trap_cell(state, &candidates).is_some() {
        return None;
    }
    let (verdict, chosen, equivalents) = unanimity_index(&turn, &candidates, |_, kept| {
        if !is_book_tenpai(kept) {
            return None;
        }
        let live = kept.quality.live_tiles;
        if !(1..=4u8).contains(&live) {
            return None;
        }
        Some(bad_wait::verdict(&kept.waits, live))
    })?;

    let declaration = if verdict.picks_riichi() {
        Declaration::Riichi
    } else {
        Declaration::Dama
    };
    if declaration == Declaration::Riichi && !riichi_is_legal(state) {
        return None;
    }
    let kept = &candidates[chosen].kept;
    let live = kept.quality.live_tiles;

    let mut triggers = Vec::new();
    let mut reasons = Vec::new();
    if let Some(trigger) = verdict.trigger() {
        triggers.push(trigger);
    } else {
        // The general rule's other dama conditions, only where they hold.
        if !kept.conditions.dealer {
            reasons.push(DamaReason::NotDealer);
        }
        reasons.push(DamaReason::BadWait);
        if !kept.conditions.extra_han {
            reasons.push(DamaReason::NoExtraHan);
        }
        reasons.push(DamaReason::FewLiveWinningTiles);
    }

    Some(declaration_match(
        ScenarioId::DamaBadWait,
        Some(if verdict == bad_wait::Verdict::HonorTerminalWait {
            format!("bad wait, {live} live honor/terminal winning tiles")
        } else {
            format!("bad wait, {live} live winning tiles")
        }),
        declaration,
        candidates[chosen].discard,
        equivalents,
        Hints { triggers, reasons },
        None,
    ))
}

/// ch7:539's genbutsu wait.
pub fn dama_genbutsu_wait(state: &GameState) -> Option<Match> {
    let turn = support::turn(state)?;
    // ch. 5.1's floating-sanshoku cell owns a wait-choice table; the
    // declaration question is not shipped there (see `super::sanshoku`).
    if super::sanshoku::takes_wait_choice(&turn, state) {
        return None;
    }

    let candidates = support::candidates(&turn)?;
    let threat = support::sole_riichi_threat(state)?;
    let facts = SafetyFacts::from_state(state, threat)?;

    let (_, chosen, equivalents) = unanimity_index(&turn, &candidates, |_, kept| {
        if !is_book_tenpai(kept) {
            return None;
        }
        // The section is an exception to riichi: if the general rule already
        // says dama, this is a different dama reason.
        if !kept.conditions.picks_riichi() {
            return None;
        }
        if !genbutsu::applies(&kept.waits, &facts) {
            return None;
        }
        Some(Declaration::Dama)
    })?;

    // The situation label is miner metadata and must stay answer-free, so it
    // does not name the wait tiles (one of them can be in the threat's river).
    Some(declaration_match(
        ScenarioId::DamaGenbutsuWait,
        Some("one winning tile is the threat's genbutsu".to_string()),
        Declaration::Dama,
        candidates[chosen].discard,
        equivalents,
        Hints {
            triggers: Vec::new(),
            reasons: genbutsu::dama_reasons(),
        },
        None,
    ))
}

/// ch7:569/598/646's high-scoring hand.
pub fn dama_expensive_hand(state: &GameState) -> Option<Match> {
    let turn = support::turn(state)?;
    // ch. 5.1's floating-sanshoku cell owns a wait-choice table; the
    // declaration question is not shipped there (see `super::sanshoku`).
    if super::sanshoku::takes_wait_choice(&turn, state) {
        return None;
    }

    let candidates = support::candidates(&turn)?;

    let (_, chosen, equivalents) = unanimity_index(&turn, &candidates, |turn, kept| {
        expensive_cell(turn, kept).map(|_| Declaration::Dama)
    })?;

    let kept = &candidates[chosen].kept;
    let (cell, points) = expensive_cell(&turn, kept)?;
    Some(declaration_match(
        ScenarioId::DamaExpensiveHand,
        Some(format!("minimum ron value {points} without riichi")),
        Declaration::Dama,
        candidates[chosen].discard,
        equivalents,
        Hints {
            triggers: Vec::new(),
            reasons: cell.dama_reasons(),
        },
        None,
    ))
}

/// The ch7:656-660 improving-hand cell for one kept hand.
///
/// The count scores the hand with the generators' aka-free value model, so a
/// table where the human holds a red five is outside what this recogniser can
/// certify and returns `None`.
fn improving_cell(turn: &Turn, kept: &Kept) -> Option<improvement::Improvement> {
    if turn.aka > 0 || !is_book_tenpai(kept) {
        return None;
    }
    // The box is an exception to riichi: the general rule must pick riichi for
    // this cell to be the reason the hand stays concealed.
    if !kept.conditions.picks_riichi() {
        return None;
    }
    // ch7:658: an early turn (8th turn or before).
    if turn.turn > 8 {
        return None;
    }
    let count = improvement::count(&kept.tiles, turn.round_wind, turn.human_wind, &turn.dora);
    if !count.qualifies() {
        return None;
    }
    Some(count)
}

/// The expensive-hand cell for one kept hand, or `None` when a ch7:641
/// "riichi anyway" clause applies.
fn expensive_cell(turn: &Turn, kept: &Kept) -> Option<(expensive::Verdict, u32)> {
    if !is_book_tenpai(kept) {
        return None;
    }
    let value = kept.worst_value?;
    let cell = expensive::verdict(value.points)?;
    if cell == expensive::Verdict::DamaExpensive {
        // ch7:641: riichi if it is the 6th turn or before and the wait is a
        // two-way side wait or better, or the 10th turn or before and the wait
        // is a three-way side wait or better.
        if turn.turn <= 6 {
            return None;
        }
        if turn.turn <= 10 && kept.side_waits >= 3 {
            return None;
        }
        // "Riichi if you are far behind from other players": the classifier
        // takes the generator's conservative reading (the human must be in
        // front) and returns no match otherwise.
        if !turn.human_is_in_front() {
            return None;
        }
    }
    Some((cell, value.points))
}

/// ch7:656-660's many improving kinds.
pub fn dama_improving_hand(state: &GameState) -> Option<Match> {
    let turn = support::turn(state)?;
    // ch. 5.1's floating-sanshoku cell owns a wait-choice table; the
    // declaration question is not shipped there (see `super::sanshoku`).
    if super::sanshoku::takes_wait_choice(&turn, state) {
        return None;
    }

    let candidates = support::candidates(&turn)?;

    let (_, chosen, equivalents) = unanimity_index(&turn, &candidates, |turn, kept| {
        improving_cell(turn, kept).map(|_| Declaration::Dama)
    })?;
    let count = improving_cell(&turn, &candidates[chosen].kept)?;

    Some(declaration_match(
        ScenarioId::DamaImprovingHand,
        Some(if count.has_big_step() {
            format!(
                "{}, {} improving kinds, at least one three-han step",
                "early turn",
                count.kinds()
            )
        } else {
            format!("early turn, {} improving kinds", count.kinds())
        }),
        Declaration::Dama,
        candidates[chosen].discard,
        equivalents,
        Hints {
            triggers: Vec::new(),
            reasons: vec![DamaReason::EarlyTurn, DamaReason::ImprovingHand],
        },
        None,
    ))
}

/// True when the kept hand is a standard tenpai hand with a live winning tile.
fn is_book_tenpai(kept: &Kept) -> bool {
    kept.is_standard() && kept.is_live()
}

// ---------------------------------------------------------------------------
// ch. 7.2 — the seven-pairs cell.
// ---------------------------------------------------------------------------

/// One discard that leaves a seven-pairs tenpai.
struct ChiitoitsuCandidate {
    /// The lone tile that would be discarded.
    discard: Tile,
    /// The thirteen kept tiles: six pairs and the singleton wait.
    kept: Vec<Tile>,
    /// The singleton that completes the seventh pair.
    wait: Tile,
    /// False when the wait is furiten or has no live copy.
    live: bool,
}

/// ch7:337/345-359's seven-pairs Riichi/dama cell.
///
/// The hand is 1-away from ready in the book's own shape: six pairs and two lone
/// tiles, so dropping either lone tile leaves a seven-pairs tenpai on the other.
/// The book's rule (ch7:337/345-353):
///
/// > Riichi any chiitoitsu hand if waiting for dora!
/// >
/// > Do insta-riichi with chiitoitsu (not waiting for dora) if one or more of
/// > the following holds: you are the dealer; you have tanyao; you have one red
/// > five, waiting for a regular five; the wait is a suji-trap wait; the wait is
/// > any tile other than 4, 5, 6; the score without riichi is below mangan.
///
/// and the two dama cases (ch7:359): a non-dealer waiting 4/5/6, or a
/// honitsu/chinitsu chiitoitsu.
///
/// Both lone tiles usually leave the same question, so both are graded as the
/// same answer. The exception is the book's red-five line: when the hand holds
/// exactly one red five and it is one of the two lone tiles, the red five is the
/// wait the rule names and the only accepted discard is the other lone tile —
/// the generator's single-answer variant.
///
/// A line whose wait is already in the human's own river (furiten) or has no
/// live copy is dropped rather than the whole state: the drill's other lone
/// tile can still leave the hand's real wait, and the generator itself allows
/// the unaccepted twin to sit in the river. When only one line survives, it is
/// the answer; when both survive they must land in the same cell.
///
/// The honitsu/chinitsu dama case is ch7:359(b) and is modelled: the one-suit
/// hand stays concealed. The all-honours hand is the book's footnote exception
/// ("I would riichi"), so it is read by the six-condition box instead.
pub fn chiitoitsu_riichi_vs_dama(state: &GameState) -> Option<Match> {
    let turn = support::turn(state)?;
    let all = chiitoitsu_candidates(&turn)?;
    let red_fives = &state.players[0].red_fives;

    // A furiten line, or a wait with no live copy, is not one the book keeps.
    let candidates: Vec<&ChiitoitsuCandidate> =
        all.iter().filter(|candidate| candidate.live).collect();
    if candidates.is_empty() {
        return None;
    }

    // The red-five line is a single answer: keep the red five and throw the
    // other lone tile (ch7:345-353, "waiting for a regular five").
    let red: Vec<usize> = candidates
        .iter()
        .enumerate()
        .filter(|(_, candidate)| is_red_five(candidate.wait, red_fives))
        .map(|(index, _)| index)
        .collect();
    if let [only] = red.as_slice() {
        let candidate = candidates[*only];
        let declaration = chiitoitsu_cell(&turn, candidate, true)?;
        if declaration == Declaration::Riichi && !riichi_is_legal(state) {
            return None;
        }
        return Some(chiitoitsu_match(
            &turn,
            candidate,
            true,
            declaration,
            Vec::new(),
        ));
    }

    // Otherwise every tenpai discard must land in the same cell.
    let mut verdicts = Vec::with_capacity(candidates.len());
    for candidate in &candidates {
        verdicts.push(chiitoitsu_cell(&turn, candidate, false)?);
    }
    if verdicts[1..].iter().any(|other| *other != verdicts[0]) {
        return None;
    }
    if verdicts[0] == Declaration::Riichi && !riichi_is_legal(state) {
        return None;
    }
    let equivalents = candidates[1..]
        .iter()
        .map(|candidate| candidate.discard.to_string())
        .collect();
    Some(chiitoitsu_match(
        &turn,
        candidates[0],
        false,
        verdicts[0],
        equivalents,
    ))
}

/// The two lone-tile discards of a six-pairs-plus-two-singletons hand.
fn chiitoitsu_candidates(turn: &Turn) -> Option<Vec<ChiitoitsuCandidate>> {
    let counts = to_counts(&turn.hand);
    let mut pairs = 0usize;
    let mut singles = Vec::new();
    for (tile, count) in &counts {
        match *count {
            2 => pairs += 1,
            1 => singles.push(*tile),
            _ => return None,
        }
    }
    if pairs != 6 || singles.len() != 2 {
        return None;
    }
    singles.sort();

    let mut out = Vec::with_capacity(2);
    for discard in singles.iter().copied() {
        let mut kept = turn.hand.clone();
        let index = kept.iter().position(|tile| *tile == discard)?;
        kept.remove(index);
        let wait = *singles.iter().find(|tile| **tile != discard)?;
        // A wait already in the human's river is furiten; the kept hand holds
        // one copy of the wait, so three visible copies leave none in the wall.
        let live = !turn.river.contains(&wait) && turn.visible.get(&wait).copied().unwrap_or(0) < 3;
        out.push(ChiitoitsuCandidate {
            discard,
            kept,
            wait,
            live,
        });
    }
    Some(out)
}

/// The ch. 7.2 verdict for one kept seven-pairs tenpai hand.
fn chiitoitsu_cell(
    turn: &Turn,
    candidate: &ChiitoitsuCandidate,
    red_five_wait: bool,
) -> Option<Declaration> {
    let kept = &candidate.kept;
    let wait = candidate.wait;
    let mut winning = kept.clone();
    winning.push(wait);

    // ch7:337: "Riichi any chiitoitsu hand if waiting for dora!"
    if turn
        .dora
        .iter()
        .any(|&indicator| indicator_to_dora(indicator) == wait)
    {
        return Some(Declaration::Riichi);
    }

    // ch7:359's second dama case: "you have honitsu or chinitsu chiitoitsu".
    if scoring::is_flush(&winning) {
        return Some(Declaration::Dama);
    }

    let mut riichi = false;
    if turn.human_wind == Wind::East {
        riichi = true;
    }
    if kept
        .iter()
        .chain(std::iter::once(&wait))
        .all(Tile::is_simple)
    {
        riichi = true;
    }
    if red_five_wait {
        riichi = true;
    }
    // "The wait is a suji-trap wait": a suji of the wait is already in the
    // human's river, so the winning tile looks safe to the table.
    if suji_tiles(wait)
        .iter()
        .any(|suji| turn.river.contains(suji))
    {
        riichi = true;
    }
    if is_outside_456(wait) {
        riichi = true;
    }

    if scoring::score_level(
        &winning,
        wait,
        turn.round_wind,
        turn.human_wind,
        &turn.dora,
        turn.aka,
    ) == Some(ScoreLevel::Normal)
    {
        riichi = true;
    }

    Some(if riichi {
        Declaration::Riichi
    } else {
        Declaration::Dama
    })
}

/// True when `tile` is one of the human's red fives.
fn is_red_five(tile: Tile, red_fives: &[String]) -> bool {
    tile.value() == Some(5) && red_fives.iter().any(|code| code == &tile.to_string())
}

/// Build the ch. 7.2 [`Match`] with its ch. 7 trigger/reason vocabulary.
fn chiitoitsu_match(
    turn: &Turn,
    candidate: &ChiitoitsuCandidate,
    red_five_wait: bool,
    declaration: Declaration,
    equivalents: Vec<String>,
) -> Match {
    let waits_dora = turn
        .dora
        .iter()
        .any(|&indicator| indicator_to_dora(indicator) == candidate.wait);

    let mut triggers = Vec::new();
    let mut reasons = Vec::new();
    let mut labels: Vec<&str> = Vec::new();
    match declaration {
        Declaration::Riichi => {
            if turn.human_wind == Wind::East {
                triggers.push(RiichiTrigger::Dealer);
                labels.push("dealer");
            }
            if candidate
                .kept
                .iter()
                .chain(std::iter::once(&candidate.wait))
                .all(Tile::is_simple)
            {
                triggers.push(RiichiTrigger::Tanyao);
                labels.push("tanyao");
            }
            if red_five_wait {
                triggers.push(RiichiTrigger::RedFiveWait);
                labels.push("red-five wait");
            }
            if suji_tiles(candidate.wait)
                .iter()
                .any(|suji| turn.river.contains(suji))
            {
                triggers.push(RiichiTrigger::SujiTrap);
                labels.push("suji trap");
            }
            if is_outside_456(candidate.wait) {
                triggers.push(RiichiTrigger::WaitOutside456);
                labels.push("wait outside 4-5-6");
            }
            let mut winning = candidate.kept.clone();
            winning.push(candidate.wait);
            if scoring::score_level(
                &winning,
                candidate.wait,
                turn.round_wind,
                turn.human_wind,
                &turn.dora,
                turn.aka,
            ) == Some(ScoreLevel::Normal)
            {
                triggers.push(RiichiTrigger::ScoreBelowMangan);
                labels.push("score below mangan");
            }
            if waits_dora {
                // A dora wait is an extra han, which is the ch. 7 vocabulary
                // the rationale speaks for this hand.
                if !triggers.contains(&RiichiTrigger::HasExtraHan) {
                    triggers.insert(0, RiichiTrigger::HasExtraHan);
                }
                labels.insert(0, "waiting on the dora");
            }
        }
        Declaration::Dama => {
            let mut winning = candidate.kept.clone();
            winning.push(candidate.wait);
            if scoring::is_flush(&winning) {
                // ch7:359(b): the flush hand stays concealed.
                reasons = vec![DamaReason::Honitsu];
                labels.push("honitsu/chinitsu");
            } else {
                // The six-condition box's dama cell, with the generator's own
                // reason list for it.
                reasons = vec![
                    DamaReason::NotDealer,
                    DamaReason::NoTanyao,
                    DamaReason::MiddleWait,
                    DamaReason::NoRedFiveWait,
                    DamaReason::NoSujiTrap,
                    DamaReason::Mangan,
                ];
                labels.push("non-dealer waiting 4-5-6");
            }
        }
    }
    let situation = format!("seven pairs, {}", labels.join(" + "));
    declaration_match(
        ScenarioId::ChiitoitsuRiichiVsDama,
        Some(situation),
        declaration,
        candidate.discard,
        equivalents,
        Hints { triggers, reasons },
        None,
    )
}

/// True when the table lets the human declare Riichi.
pub(super) fn riichi_is_legal(state: &GameState) -> bool {
    let human = &state.players[0];
    human.score >= 1_000
        && state.tiles_remaining >= 4
        && !human.is_riichi
        && human
            .melds
            .iter()
            .all(|meld| meld.meld_type == crate::state::MeldType::Ankan)
}

/// Every candidate must land on the same verdict; returns it, the index of the
/// first candidate, and the equivalent discards.
fn unanimity_index<T: PartialEq>(
    turn: &Turn,
    candidates: &[Candidate],
    mut verdict: impl FnMut(&Turn, &Kept) -> Option<T>,
) -> Option<(T, usize, Vec<String>)> {
    let mut agreed: Option<(T, usize)> = None;
    let mut equivalents = Vec::new();
    for (index, candidate) in candidates.iter().enumerate() {
        let value = verdict(turn, &candidate.kept)?;
        match &agreed {
            None => agreed = Some((value, index)),
            Some((current, _)) if *current == value => {
                equivalents.push(candidate.discard.to_string());
            }
            Some(_) => return None,
        }
    }
    let (value, index) = agreed?;
    Some((value, index, equivalents))
}

/// The book trigger vocabulary a ch. 7 declaration's rationale is built from.
struct Hints {
    triggers: Vec<RiichiTrigger>,
    reasons: Vec<DamaReason>,
}

/// Build the [`Match`] for one riichi/dama cell.
fn declaration_match(
    lesson: ScenarioId,
    situation: Option<String>,
    declaration: Declaration,
    discard: Tile,
    equivalents: Vec<String>,
    hints: Hints,
    scenario_note: Option<String>,
) -> Match {
    let (target_action, correct_action) = match declaration {
        Declaration::Riichi => (
            TargetAction::Riichi,
            CorrectAction::riichi(discard.to_string()),
        ),
        Declaration::Dama => (TargetAction::Dama, CorrectAction::dama(discard.to_string())),
    };
    Match {
        lesson,
        situation,
        target_action,
        correct_action,
        equivalent_tiles: equivalents,
        riichi_triggers: hints.triggers,
        dama_reasons: hints.reasons,
        shouminkan_triggers: Vec::new(),
        scenario_note,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::generator::generate_puzzle;

    fn generated(category: &str) -> GameState {
        generate_puzzle(category).unwrap_or_else(|err| panic!("{category}: {err}"))
    }

    fn assert_matches_own_lesson(category: &str) {
        let state = generated(category);
        let lesson = ScenarioId::from_id(category).expect("a real lesson");
        let matched = super::super::classify(&state, lesson)
            .unwrap_or_else(|| panic!("{category} must classify as itself"));
        matched
            .validate(&state)
            .unwrap_or_else(|err| panic!("{category}: {err}"));
        assert_eq!(matched.lesson, lesson);
        assert_eq!(
            matched.correct_action.action_type(),
            state.correct_action.action_type(),
            "{category}: the action family must agree with the lesson"
        );
        assert_eq!(
            matched.answer_set(),
            {
                let mut expected = state.equivalent_tiles.clone();
                expected.push(
                    state
                        .correct_action
                        .tile()
                        .expect("the lesson answer names a tile")
                        .to_string(),
                );
                expected.sort();
                expected.dedup();
                expected
            },
            "{category}: the accepted tiles must agree with the lesson"
        );
        assert_eq!(
            matched.target_action, state.target_action,
            "{category}: the decision must agree with the lesson"
        );
    }

    #[test]
    fn the_general_rule_recognises_its_own_lesson() {
        for _ in 0..12 {
            assert_matches_own_lesson("riichi_judgement");
        }
    }

    #[test]
    fn the_bad_wait_box_recognises_its_own_lesson() {
        for _ in 0..12 {
            assert_matches_own_lesson("dama_bad_wait");
        }
    }

    #[test]
    fn the_genbutsu_wait_recognises_its_own_lesson() {
        for _ in 0..8 {
            assert_matches_own_lesson("dama_genbutsu_wait");
        }
    }

    #[test]
    fn the_expensive_hand_recognises_its_own_lesson() {
        for _ in 0..8 {
            assert_matches_own_lesson("dama_expensive_hand");
        }
    }

    #[test]
    fn the_improving_hand_recognises_its_own_lesson() {
        for _ in 0..6 {
            assert_matches_own_lesson("dama_improving_hand");
        }
    }

    #[test]
    fn a_hand_that_reaches_tenpai_on_several_discards_needs_agreement() {
        // A riichi-judgement hand whose displayed draw is a spare tile: both
        // dropping the draw and dropping the lesson's answer can leave tenpai.
        // The classifier must either agree on the declaration (and list the
        // other discard as equivalent) or refuse the state.
        for _ in 0..20 {
            let state = generated("riichi_judgement");
            let Some(turn) = support::turn(&state) else {
                continue;
            };
            let Some(candidates) = support::candidates(&turn) else {
                continue;
            };
            let matched = riichi_judgement(&state);
            match matched {
                None => continue,
                Some(matched) => {
                    // Every candidate discard must be in the accepted set.
                    for candidate in &candidates {
                        assert!(
                            matched
                                .answer_set()
                                .iter()
                                .any(|tile| *tile == candidate.discard.to_string())
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn a_non_tenpai_hand_has_no_riichi_judgement() {
        let mut state = generated("riichi_judgement");
        // Replace the draw with a tile that cannot reach tenpai from any
        // discard: keep drawing a copy of a tile the hand already holds twice.
        let spare = state.players[0]
            .hand
            .iter()
            .find(|code| {
                state.players[0]
                    .hand
                    .iter()
                    .filter(|other| other == code)
                    .count()
                    >= 2
            })
            .cloned();
        let Some(spare) = spare else { return };
        state.players[0].draw = Some(spare);
        let Some(turn) = support::turn(&state) else {
            return;
        };
        if support::candidates(&turn).is_some() {
            // Still tenpai after some discard; this fixture cannot test the
            // guard, and the near-miss set in `super::tests` covers it.
            return;
        }
        assert!(riichi_judgement(&state).is_none());
        assert!(dama_bad_wait(&state).is_none());
    }

    #[test]
    fn a_furiten_candidate_removes_the_whole_state() {
        let mut state = generated("riichi_judgement");
        let waits = state.ukeire_tiles.clone();
        let Some(wait) = waits.first().cloned() else {
            return;
        };
        state.players[0]
            .discards
            .push(crate::state::DiscardTile::new(wait));
        assert!(support::candidates(&support::turn(&state).expect("a turn")).is_none());
        assert!(riichi_judgement(&state).is_none());
        assert!(dama_bad_wait(&state).is_none());
    }

    #[test]
    fn the_bad_wait_box_needs_a_bad_wait() {
        let state = generated("dama_bad_wait");
        let matched = dama_bad_wait(&state).expect("the lesson's own cell");
        assert!(!matched.dama_reasons.is_empty() || !matched.riichi_triggers.is_empty());
    }

    #[test]
    fn a_chiitoitsu_tenpai_is_not_a_standard_hand_rule() {
        for _ in 0..6 {
            let state = generated("chiitoitsu_riichi_vs_dama");
            assert!(riichi_judgement(&state).is_none());
            assert!(dama_bad_wait(&state).is_none());
            assert!(dama_improving_hand(&state).is_none());
        }
    }

    #[test]
    fn a_good_wait_hand_is_not_the_bad_wait_box() {
        let mut checked = 0;
        for _ in 0..24 {
            let state = generated("riichi_judgement");
            if !state.riichi_triggers.contains(&RiichiTrigger::GoodWait) {
                continue;
            }
            checked += 1;
            assert!(
                dama_bad_wait(&state).is_none(),
                "a good wait is not the bad-wait box"
            );
        }
        assert!(checked > 0, "the generator must produce a good wait");
    }

    #[test]
    fn a_threatless_table_is_not_the_genbutsu_lesson() {
        let mut state = generated("dama_genbutsu_wait");
        for player in &mut state.players {
            player.is_riichi = false;
            player.riichi_discard_index = None;
            for discard in &mut player.discards {
                discard.is_riichi = false;
            }
        }
        assert!(dama_genbutsu_wait(&state).is_none());
    }

    #[test]
    fn a_wait_without_a_genbutsu_side_is_not_the_genbutsu_lesson() {
        let mut state = generated("dama_genbutsu_wait");
        let threat = support::sole_riichi_threat(&state).expect("one threat");
        let waits = state.ukeire_tiles.clone();
        state.players[threat]
            .discards
            .retain(|discard| !waits.iter().any(|wait| wait == &discard.tile));
        assert!(dama_genbutsu_wait(&state).is_none());
    }

    #[test]
    fn a_hand_with_no_yaku_floor_is_not_the_expensive_lesson() {
        let mut checked = 0;
        for _ in 0..80 {
            let state = generated("dama_bad_wait");
            if !state.dama_reasons.contains(&DamaReason::NoExtraHan) {
                continue;
            }
            checked += 1;
            assert!(
                dama_expensive_hand(&state).is_none(),
                "a riichi-only hand has no ron value to protect"
            );
        }
        assert!(checked > 0, "the generator must produce a riichi-only hand");
    }

    #[test]
    fn a_hand_past_the_eighth_turn_is_not_the_improving_lesson() {
        let mut state = generated("dama_improving_hand");
        let fillers = ["1z", "2z", "3z", "4z", "5z", "6z", "7z", "1p", "9p"];
        for (index, tile) in fillers.iter().enumerate() {
            state.players[0]
                .discards
                .push(crate::state::DiscardTile::new(*tile));
            let _ = index;
        }
        assert!(state.players[0].discards.len() > 8);
        assert!(dama_improving_hand(&state).is_none());
    }

    #[test]
    fn a_red_five_is_outside_the_improving_count() {
        let mut state = generated("dama_improving_hand");
        let five = state.players[0]
            .hand
            .iter()
            .find(|code| code.ends_with('m') || code.ends_with('p') || code.ends_with('s'))
            .cloned();
        if let Some(five) = five {
            state.players[0].red_fives = vec![five];
            assert!(dama_improving_hand(&state).is_none());
        }
    }

    #[test]
    fn the_general_rule_defers_to_the_bad_wait_box() {
        // The box owns bad waits and the empty three-condition set; the general
        // rule must not also claim them with the old dama answer.
        let mut riichi_only = 0;
        let mut one_or_two_live = 0;
        for _ in 0..40 {
            let state = generated("dama_bad_wait");
            let boxed = dama_bad_wait(&state).expect("the box's own cell");
            assert!(
                riichi_judgement(&state).is_none(),
                "the general rule must defer to the box"
            );
            if state.dama_reasons.contains(&DamaReason::NoExtraHan) {
                riichi_only += 1;
            }
            if boxed
                .dama_reasons
                .contains(&DamaReason::FewLiveWinningTiles)
            {
                one_or_two_live += 1;
            }
        }
        assert!(riichi_only > 0, "the box must produce a riichi-only hand");
        assert!(
            one_or_two_live > 0,
            "the box must produce its 1-2 live dama cell"
        );
    }

    #[test]
    fn the_general_rule_defers_to_every_ch7_dama_section() {
        for category in [
            "dama_bad_wait",
            "dama_genbutsu_wait",
            "dama_expensive_hand",
            "dama_improving_hand",
        ] {
            for _ in 0..4 {
                let state = generated(category);
                assert!(
                    riichi_judgement(&state).is_none(),
                    "{category} is a later ch7 section's cell"
                );
            }
        }
    }

    #[test]
    fn the_lesson_generator_never_builds_another_dama_cell() {
        // The content alignment: `riichi_judgement` only draws the general
        // rule's riichi cells, so its own states never match a dama lesson.
        for _ in 0..16 {
            let state = generated("riichi_judgement");
            let matched = riichi_judgement(&state).expect("the lesson's own cell");
            assert_eq!(
                matched.correct_action.action_type(),
                crate::state::CorrectActionType::Riichi
            );
            // Another later section may still read the same hand for the same
            // answer (the bad-wait box calls a 3-4 live bad wait riichi too);
            // what must never happen is a different answer.
            for category in [
                "dama_bad_wait",
                "dama_genbutsu_wait",
                "dama_expensive_hand",
                "dama_improving_hand",
            ] {
                if let Some(other) = super::super::classify(
                    &state,
                    crate::generator::ScenarioId::from_id(category).expect("a lesson"),
                ) {
                    assert!(
                        matched.same_answer(&other),
                        "{category} disagrees with the general rule"
                    );
                }
            }
        }
    }
}
