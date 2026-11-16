//! The ch. 8 defense recognisers: `fold_to_riichi`, the safety-chart family and
//! the four blockade lessons.
//!
//! All of them read one threat's river through [`SafetyFacts`] — the same
//! chart oracle the generators validate with — and differ only in which row of
//! `tbl:safety` the answer must sit on:
//!
//! | Lesson | Answer row |
//! | --- | --- |
//! | `fold_to_riichi` | genbutsu, on a 2-away-or-worse hand (betaori) |
//! | `defense_safety_chart` | an identified row above the bottom two (`B` or better) |
//! | `suji_kabe_safety` | suji or no-chance, `BBB` or better |
//! | `kabe_no_chance` | a complete blockade's no-chance tile (`BBB`) |
//! | `kabe_one_chance` | a one-chance tile in the early turns (`BB-`) |
//! | `kabe_double_one_chance` | a double one-chance tile (`BBB-`) |
//! | `kabe_suji_defense` | one blockade plus one genbutsu (`BBB`) |
//! | `defense_stuck_heuristic` | nothing identified safe; the chapter's fallback |
//!
//! The **fold verdict** is checked first: a 1-away hand must not meet both push
//! conditions (ch8:62), a 2-away-or-worse hand is slow enough to fold on its
//! own, and a tenpai hand is not a defense drill at all. That keeps this family
//! from claiming a push cell.
//!
//! The safest tile must be **unique**, except on the 100% row where the book
//! counts both the threat's genbutsu and every post-declaration discard as
//! equally safe; those ties are listed as `equivalent_tiles`, exactly as the
//! generators record them.
//!
//! # The bottom two rows belong to the fallback
//!
//! ch. 8's fallback list ("What to discard when you get stuck") starts where
//! the chapter can no longer identify a safe tile. `CC` (a plain non-suji
//! terminal) and `C` (a late one-chance tile) are exactly those rows, so the
//! chart family stops at `B` and `defense_stuck_heuristic` owns `CC`/`C`. The
//! two families therefore never overlap.
//!
//! `defense_safety_chart`'s generator has a `non_suji` theme that answers with a
//! `CC` terminal. Under this split that board is the fallback's row, so the
//! chart recogniser refuses it and `defense_stuck_heuristic` may label it with
//! the fallback list's pick instead — the one documented place where a shipped
//! generator's answer is not reproduced. The alternative (letting both lessons
//! claim a `CC` board) lets the chart pick one tile and the fallback another on
//! the same visible table, which is a contradictory drill and cannot ship. The
//! generator's own module doc lists its themes as genbutsu, suji, no-chance and
//! honor rows, so the `non_suji` theme is the outlier.

use std::collections::HashMap;

use agari::tile::Tile;

use crate::generator::ScenarioId;
use crate::generator::push_or_fold;
use crate::safety::{SafetyFacts, SafetyMechanism, SafetyRank, TileRead};
use crate::state::{CorrectAction, GameState, TargetAction};

use super::support::{self, Turn};
use super::{Allowed, Match, TransformPolicy};

/// Ch. 8 defense is a safety-chart and hand-speed rule: every transform must be
/// recomputed, including red-five normalisation (it changes the fallback list's
/// "avoid the dora" key).
pub(crate) const POLICY: TransformPolicy = TransformPolicy {
    seat_perm: Allowed::AllowWithRecompute,
    suit_perm: Allowed::AllowWithRecompute,
    rank_mirror: Allowed::AllowWithRecompute,
    wind_relabel: Allowed::AllowWithRecompute,
    red5_normalize: Allowed::AllowWithRecompute,
    note: "ch8 defense answers are read off the safety chart, which is seat-, suit- and \
           rank-symmetric once the table is relabelled; the label must be recomputed.",
};

/// One table read for a defense lesson.
struct DefenseView {
    turn: Turn,
    facts: SafetyFacts,
}

/// The threat, the chart facts and the hand tiles, or `None` when the state is
/// not a defense decision this family can read.
fn view(state: &GameState) -> Option<DefenseView> {
    let turn = support::turn(state)?;
    // The defense lessons ask about a hand that is not ready yet.
    if turn.shanten < 1 {
        return None;
    }
    let threat = support::sole_riichi_threat(state)?;
    let threat_player = state.players.iter().find(|player| player.seat == threat)?;
    // The generators only build concealed threats; an open threat is the
    // open-hand-read lesson's board, not the safety chart's.
    if !threat_player.melds.is_empty() {
        return None;
    }
    let facts = SafetyFacts::from_state(state, threat)?;
    Some(DefenseView { turn, facts })
}

impl DefenseView {
    /// The distinct hand tiles, in tile order.
    fn tiles(&self) -> Vec<Tile> {
        support::distinct(&self.turn.hand)
    }

    /// The tiles on the safest chart row the hand can offer.
    fn safest(&self) -> Vec<Tile> {
        let best = self
            .tiles()
            .iter()
            .map(|tile| self.facts.rank(*tile).order())
            .min()
            .unwrap_or(u8::MAX);
        self.tiles()
            .into_iter()
            .filter(|tile| self.facts.rank(*tile).order() == best)
            .collect()
    }

    /// The unique safest tile, or `None` when the row is tied.
    fn unique_safest(&self) -> Option<(Tile, TileRead)> {
        let safest = self.safest();
        if safest.len() != 1 {
            return None;
        }
        let tile = safest[0];
        Some((tile, self.facts.read(tile)))
    }

    /// The ch. 8.1 fold verdict, or `None` when the box says push.
    ///
    /// A 1-away hand folds unless both non-ready push conditions hold; a
    /// 2-away-or-worse hand is already slow enough that the first fold
    /// condition holds on its own (ch8:31-36).
    fn folds(&self) -> bool {
        if self.turn.shanten >= 2 {
            return true;
        }
        let mut core = self.turn.hand.clone();
        if let Some(index) = core.iter().position(|tile| *tile == self.turn.draw) {
            core.remove(index);
        }
        let conditions = push_or_fold::hand_conditions(
            &core,
            self.turn.round_wind,
            self.turn.human_wind,
            &self.turn.dora,
        );
        !conditions.pushes()
    }
}

/// Build the fold answer.
fn fold_match(
    lesson: ScenarioId,
    situation: String,
    answer: Tile,
    equivalents: Vec<String>,
) -> Match {
    Match {
        lesson,
        situation: Some(situation),
        target_action: TargetAction::Defend,
        correct_action: CorrectAction::fold(answer.to_string()),
        equivalent_tiles: equivalents,
        riichi_triggers: Vec::new(),
        dama_reasons: Vec::new(),
        scenario_note: None,
    }
}

/// The answer plus its equivalence class: a unique best tile, or several ties
/// that are all 100% safe.
fn answer_set(view: &DefenseView, read: &TileRead) -> Option<(Tile, Vec<String>)> {
    let safest = view.safest();
    match safest.len() {
        0 => None,
        1 => Some((safest[0], Vec::new())),
        _ if read.rank == SafetyRank::Genbutsu => {
            let mut equivalents: Vec<String> =
                safest[1..].iter().map(ToString::to_string).collect();
            equivalents.sort();
            Some((safest[0], equivalents))
        }
        _ => None,
    }
}

/// ch. 8.3 betaori: a slow hand facing Riichi throws the one 100% safe tile.
pub fn fold_to_riichi(state: &GameState) -> Option<Match> {
    let view = view(state)?;
    // The betaori drill is the hand that cannot push at all: 2-away or worse.
    if view.turn.shanten < 2 {
        return None;
    }
    let read = view.facts.read(view.safest().first().copied()?);
    if read.rank != SafetyRank::Genbutsu {
        return None;
    }
    let (answer, equivalents) = answer_set(&view, &read)?;
    Some(fold_match(
        ScenarioId::FoldToRiichi,
        "2-away or worse, threat in Riichi, betaori".to_string(),
        answer,
        equivalents,
    ))
}

/// The ch. 8 safety chart's "find the safest discard" drill.
pub fn defense_safety_chart(state: &GameState) -> Option<Match> {
    let view = view(state)?;
    if !view.folds() {
        return None;
    }
    let read = view.facts.read(view.safest().first().copied()?);
    // ch. 8's chart "identifies" the rows above the bottom two: genbutsu, a
    // no-chance tile, a suji, an honor ranked by its visible copies, or a
    // one-chance tile. `CC` (a plain non-suji terminal) and `C` (a late
    // one-chance tile) are where the chapter says nothing is identified, and
    // its fallback list takes over — that is the `defense_stuck_heuristic`
    // lesson's board, not a chart answer.
    if read.rank.order() >= SafetyRank::Cc.order() {
        return None;
    }
    let (answer, equivalents) = answer_set(&view, &read)?;
    Some(fold_match(
        ScenarioId::DefenseSafetyChart,
        format!("safest row {} ({})", read.rank.code(), read.rank.label()),
        answer,
        equivalents,
    ))
}

/// The ranking half of the fold lesson: a suji or no-chance answer.
pub fn suji_kabe_safety(state: &GameState) -> Option<Match> {
    let view = view(state)?;
    if !view.folds() {
        return None;
    }
    let (answer, read) = view.unique_safest()?;
    if !matches!(
        read.mechanism,
        SafetyMechanism::Suji | SafetyMechanism::NoChance
    ) || read.rank.order() > SafetyRank::BbMinus.order()
    {
        return None;
    }
    Some(fold_match(
        ScenarioId::SujiKabeSafety,
        format!("{}: {}", read.rank.label(), mechanism_label(read.mechanism)),
        answer,
        Vec::new(),
    ))
}

/// A complete blockade's no-chance tile (`tbl:kabe`).
pub fn kabe_no_chance(state: &GameState) -> Option<Match> {
    kabe_match(
        state,
        ScenarioId::KabeNoChance,
        SafetyMechanism::NoChance,
        SafetyRank::Bbb,
        "complete blockade: a no-chance tile",
    )
}

/// A one-chance tile in the book's early turns.
pub fn kabe_one_chance(state: &GameState) -> Option<Match> {
    kabe_match(
        state,
        ScenarioId::KabeOneChance,
        SafetyMechanism::OneChance,
        SafetyRank::BbMinus,
        "incomplete blockade: a one-chance tile",
    )
}

/// A double one-chance tile.
pub fn kabe_double_one_chance(state: &GameState) -> Option<Match> {
    kabe_match(
        state,
        ScenarioId::KabeDoubleOneChance,
        SafetyMechanism::DoubleOneChance,
        SafetyRank::BbbMinus,
        "two incomplete blockades: a double one-chance tile",
    )
}

/// One blockade plus one genbutsu (`tbl:kabesuji`).
pub fn kabe_suji_defense(state: &GameState) -> Option<Match> {
    kabe_match(
        state,
        ScenarioId::KabeSujiDefense,
        SafetyMechanism::BlockadeSuji,
        SafetyRank::Bbb,
        "blockade plus genbutsu: a suji-denied tile",
    )
}

/// The shared blockade recogniser: the unique safest tile must be read by the
/// given mechanism at the given chart row.
fn kabe_match(
    state: &GameState,
    lesson: ScenarioId,
    mechanism: SafetyMechanism,
    rank: SafetyRank,
    situation: &str,
) -> Option<Match> {
    let view = view(state)?;
    if !view.folds() {
        return None;
    }
    let (answer, read) = view.unique_safest()?;
    if read.mechanism != mechanism || read.rank != rank {
        return None;
    }
    Some(fold_match(
        lesson,
        format!("{situation}, {}", mechanism_label(read.mechanism)),
        answer,
        Vec::new(),
    ))
}

/// The mechanism's teaching name, without naming any tile.
fn mechanism_label(mechanism: SafetyMechanism) -> &'static str {
    match mechanism {
        SafetyMechanism::Genbutsu => "the threat's river",
        SafetyMechanism::PostRiichiGenbutsu => "a post-declaration discard",
        SafetyMechanism::Honor => "an honor counted by its visible copies",
        SafetyMechanism::Suji => "a suji tile",
        SafetyMechanism::NoChance => "every side wait blocked",
        SafetyMechanism::BlockadeSuji => "one side blocked and one denied by genbutsu",
        SafetyMechanism::OneChance => "one side wait needs the last copy",
        SafetyMechanism::DoubleOneChance => "both side waits need last copies",
        SafetyMechanism::NonSuji => "a non-suji tile",
    }
}

/// ch. 8's fallback when nothing on the chart is identified safe: the
/// chapter's ordered lists pick the discard instead.
pub fn defense_stuck_heuristic(state: &GameState) -> Option<Match> {
    let view = view(state)?;
    if !view.folds() {
        return None;
    }
    let tiles = view.tiles();
    let best = tiles
        .iter()
        .map(|tile| view.facts.rank(*tile).order())
        .min()?;
    // The fallback starts only where the chart stops identifying tiles.
    if best < SafetyRank::Cc.order() {
        return None;
    }
    let mut counts: HashMap<Tile, u8> = HashMap::new();
    for &tile in &view.turn.hand {
        support::increment(&mut counts, tile);
    }
    let (choice, _) = view.facts.stuck_choice(&tiles, &counts, &view.turn.dora)?;
    // The generator's own cell: the fallback's unique pick is a `CC` or `C`
    // tile. The chart's best available row is at most `CC` here (checked
    // above), so this recogniser and the chart family never overlap.
    if !matches!(view.facts.rank(choice), SafetyRank::Cc | SafetyRank::C) {
        return None;
    }
    Some(fold_match(
        ScenarioId::DefenseStuckHeuristic,
        "nothing identified safe: the ch. 8 fallback list".to_string(),
        choice,
        Vec::new(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::generator::generate_puzzle;

    fn generated(category: &str) -> GameState {
        generate_puzzle(category).unwrap_or_else(|err| panic!("{category}: {err}"))
    }

    fn assert_own_lesson(category: &str, recogniser: fn(&GameState) -> Option<Match>) {
        let state = generated(category);
        let matched =
            recogniser(&state).unwrap_or_else(|| panic!("{category} must match its own lesson"));
        matched.validate(&state).expect("the answer must be legal");
        assert_eq!(
            matched.lesson,
            ScenarioId::from_id(category).expect("a lesson")
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
    }

    #[test]
    fn fold_to_riichi_recognises_its_own_lesson() {
        for _ in 0..10 {
            assert_own_lesson("fold_to_riichi", fold_to_riichi);
        }
    }

    #[test]
    fn the_safety_chart_recognises_its_own_lesson() {
        for _ in 0..20 {
            let state = generated("defense_safety_chart");
            let Some(matched) = defense_safety_chart(&state) else {
                // The generator's `non_suji` theme answers with a plain
                // non-suji terminal (`CC`), the bottom row the chapter does not
                // identify. It is the documented carve-out: the fallback lesson
                // owns that row, so this recogniser refuses it.
                let view = view(&state).expect("a defense read");
                let best = view
                    .tiles()
                    .iter()
                    .map(|tile| view.facts.rank(*tile).order())
                    .min()
                    .expect("a hand");
                assert_eq!(
                    best,
                    SafetyRank::Cc.order(),
                    "only the bottom-row theme may be refused"
                );
                continue;
            };
            matched.validate(&state).expect("the answer must be legal");
            assert_eq!(matched.answer_set(), {
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
            });
        }
    }

    #[test]
    fn the_suji_kabe_ranking_recognises_its_own_lesson() {
        for _ in 0..12 {
            assert_own_lesson("suji_kabe_safety", suji_kabe_safety);
        }
    }

    #[test]
    fn the_blockade_lessons_recognise_their_own_boards() {
        for _ in 0..6 {
            assert_own_lesson("kabe_no_chance", kabe_no_chance);
        }
        for _ in 0..6 {
            assert_own_lesson("kabe_one_chance", kabe_one_chance);
        }
        for _ in 0..6 {
            assert_own_lesson("kabe_double_one_chance", kabe_double_one_chance);
        }
        for _ in 0..6 {
            assert_own_lesson("kabe_suji_defense", kabe_suji_defense);
        }
    }

    #[test]
    fn the_fallback_recognises_its_own_lesson() {
        for _ in 0..8 {
            assert_own_lesson("defense_stuck_heuristic", defense_stuck_heuristic);
        }
    }

    #[test]
    fn a_one_away_push_hand_is_not_a_defense_board() {
        let mut pushes = 0;
        for _ in 0..40 {
            let state = generated("push_or_fold");
            if state.target_action != TargetAction::Push {
                continue;
            }
            pushes += 1;
            assert!(defense_safety_chart(&state).is_none());
            assert!(suji_kabe_safety(&state).is_none());
            assert!(fold_to_riichi(&state).is_none());
        }
        assert!(pushes > 0, "the generator must produce a push board");
    }

    #[test]
    fn a_tenpai_hand_is_not_a_defense_board() {
        let state = generated("riichi_judgement");
        for recogniser in [
            defense_safety_chart as fn(&GameState) -> Option<Match>,
            suji_kabe_safety,
            fold_to_riichi,
            kabe_no_chance,
            defense_stuck_heuristic,
        ] {
            assert!(recogniser(&state).is_none());
        }
    }

    #[test]
    fn a_stuck_board_is_not_a_suji_ranking() {
        for _ in 0..8 {
            let state = generated("defense_stuck_heuristic");
            assert!(suji_kabe_safety(&state).is_none());
        }
    }

    #[test]
    fn a_one_away_defense_board_is_not_the_betaori_lesson() {
        // The push/fold fold cell is exactly a 1-away board facing Riichi, so it
        // is the deterministic 1-away defense table to test the betaori guard on.
        let mut checked = 0;
        for _ in 0..40 {
            let state = generated("push_or_fold");
            if state.target_action != TargetAction::Fold {
                continue;
            }
            checked += 1;
            assert!(
                fold_to_riichi(&state).is_none(),
                "a 1-away hand is the push/fold box, not betaori"
            );
        }
        assert!(checked > 0, "the generator must produce a fold board");
    }

    #[test]
    fn an_open_threat_is_not_the_safety_chart() {
        let mut state = generated("defense_safety_chart");
        let threat = support::sole_riichi_threat(&state).expect("one threat");
        state.players[threat].melds.push(crate::state::CalledMeld {
            meld_type: crate::state::MeldType::Pon,
            tiles: vec!["5z".to_string(); 3],
            called_from: Some(3),
        });
        assert!(defense_safety_chart(&state).is_none());
    }

    #[test]
    fn a_chart_board_is_not_the_fallback() {
        for _ in 0..12 {
            let state = generated("defense_safety_chart");
            let Some(view) = view(&state) else { continue };
            let best = view
                .tiles()
                .iter()
                .map(|tile| view.facts.rank(*tile).order())
                .min()
                .expect("a hand");
            if best < SafetyRank::Cc.order() {
                assert!(
                    defense_stuck_heuristic(&state).is_none(),
                    "a chart answer is not the fallback's board"
                );
            }
        }
    }

    #[test]
    fn a_two_threat_table_has_no_defense_read() {
        let mut state = generated("defense_safety_chart");
        let other = state
            .players
            .iter()
            .position(|player| !player.is_riichi && !player.is_human)
            .expect("an opponent");
        state.players[other].is_riichi = true;
        state.players[other].riichi_discard_index = Some(0);
        assert!(defense_safety_chart(&state).is_none());
    }
}
