//! Fold to Riichi: throw the one tile the book calls 100% safe.
//!
//! This is ch. 8's flagship defense drill. "A simple principle" gives the
//! push/fold shortcut, and the hand here meets two of the fold conditions:
//!
//! > **Fold** if **two** of the following conditions are met: 1-away (or worse)
//! > hand; Low scoring hand; Bad wait. — ch8:31-36
//!
//! > We say a hand is a high scoring one if the minimum hand value is 7700;
//! > otherwise it is a low scoring hand. — ch8:65
//!
//! With the hand settled, "Defense against riichi" says what to discard:
//!
//! > Do not discard **Rank D** tiles against an opponent's riichi until your
//! > hand becomes ready. — ch8:334
//!
//! > If you cannot satisfy the above criteria, you must completely fold
//! > (betaori). — ch8:340
//!
//! and "Defense basics" gives the free answer:
//!
//! > Genbutsu tiles of player X are 100% safe against X — ch8:100
//!
//! > 100% & Genbutsu — ch8:301
//!
//! The generated board isolates exactly that: an opponent in Riichi from a deep
//! river, a hand that is 2-away with no dora and no value, and **one** tile the
//! chapter calls 100% safe (the opponent's own genbutsu), held inside a pair, a
//! protorun, or a run so discarding it visibly gives up a block. Every other
//! hand tile is strictly more dangerous on the chart, so the answer is unique.
//!
//! The answer is a plain fold discard: [`crate::state::CorrectAction::Fold`]
//! with [`crate::state::TargetAction::Defend`], the same carrier the other
//! defense lessons use. Nothing about a Kan is involved, so no new vocabulary
//! is needed and the report reads "Fold, discarding the safest tile X".
//!
//! Deck cards this lesson teaches (Anki):
//! 1463247110997 (what is a safety tile), 1463251851184, 1463251902123 (the
//! push/fold conditions), 1463251955444 (genbutsu tiles), 1463252064018 (how
//! safe genbutsu are), 1463252072584 (the three kinds of 100% tiles),
//! 1463254499575 (the safety table), 1463254667324 (defending against riichi),
//! 1463255088593 (what to discard when stuck), 1463254363324 (the same-letter
//! rows are close).

mod board;
mod skeleton;

use crate::generator::support::retry::generate_with_retries;
use crate::state::GameState;

/// Generates a junk hand facing a declared Riichi with one 100% safe tile.
pub fn generate(category: &str) -> Result<GameState, String> {
    generate_with_retries("fold_to_riichi", 2_000, || {
        let skeleton = skeleton::build()?;
        board::build(category, &skeleton)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    use agari::tile::Tile;

    use crate::generator::generate_puzzle;
    use crate::safety::{SafetyFacts, SafetyRank};
    use crate::state::{CorrectActionType, TargetAction};

    fn answer_tile(state: &GameState) -> Tile {
        Tile::try_from(state.correct_action.tile().expect("answer tile"))
            .expect("answer must parse")
    }

    /// The full payload: the fold answer, the ch. 8 rationale, and the fact
    /// that Riichi is not on offer to a hand this slow.
    #[test]
    fn the_payload_folds_and_cites_the_betaori_rule() {
        for run in 0..40 {
            let state = generate_puzzle("fold_to_riichi")
                .unwrap_or_else(|err| panic!("run {run} failed: {err}"));

            assert_eq!(state.category, "fold_to_riichi");
            assert_eq!(state.target_action, TargetAction::Defend);
            assert_eq!(state.correct_action.action_type(), CorrectActionType::Fold);
            assert!(!state.can_riichi, "run {run}: a 2-away hand cannot declare");
            assert!(state.equivalent_tiles.is_empty());

            let answer = answer_tile(&state);
            let threat = state
                .players
                .iter()
                .find(|player| player.is_riichi)
                .expect("one threat");
            let facts = SafetyFacts::from_state(&state, threat.seat).expect("facts");
            assert_eq!(facts.rank(answer), SafetyRank::Genbutsu);
            assert!(
                facts.read(answer).reason.contains("river"),
                "run {run}: the reason must name the river"
            );

            let rationale = state
                .book_rationale
                .as_ref()
                .expect("finalize must stamp the book rationale");
            assert_eq!(rationale.source.chapter, 8, "run {run}");
            assert_eq!(rationale.source.section, "Defense against riichi");
            assert_eq!(rationale.source.source_line, 340);
            assert!(
                rationale.summary.contains("Fold"),
                "run {run}: {}",
                rationale.summary
            );

            let ids: Vec<&str> = rationale
                .rules
                .iter()
                .map(|rule| rule.id.as_str())
                .collect();
            for id in ["genbutsu", "fold_conditions", "low_scoring", "betaori"] {
                assert!(ids.contains(&id), "run {run}: missing rule {id} in {ids:?}");
            }

            for rule in &rationale.rules {
                assert!(!rule.applies.is_empty(), "run {run}: {}", rule.id);
                assert!(!rule.quote.is_empty(), "run {run}: {}", rule.id);
                assert_eq!(rule.citation.chapter, 8, "run {run}: {}", rule.id);
            }

            // The other tiles are listed under "Not this hand", each more
            // dangerous than the answer.
            assert!(!rationale.absent.is_empty(), "run {run}");
            for absent in &rationale.absent {
                assert!(
                    absent.note.contains("more dangerous than the answer"),
                    "run {run}: {}",
                    absent.note
                );
            }

            // The fold gives up a block, and the rationale says so.
            let betaori = rationale
                .rules
                .iter()
                .find(|rule| rule.id == "betaori")
                .expect("the betaori rule");
            assert!(
                betaori.applies.contains("sits in the hand's")
                    || betaori.applies.contains("gives that block up"),
                "run {run}: {}",
                betaori.applies
            );
            assert!(
                rationale
                    .caveats
                    .iter()
                    .any(|caveat| caveat.contains("betaori")),
                "run {run}: the cost caveat must cite the instruction"
            );
        }
    }

    /// The payload round-trips through JSON like every other lesson.
    #[test]
    fn the_state_round_trips_through_json() {
        let state = generate_puzzle("fold_to_riichi").expect("must generate");
        let json = serde_json::to_string(&state).expect("state must serialize");
        let parsed: GameState = serde_json::from_str(&json).expect("state must parse back");

        assert_eq!(parsed.category, state.category);
        assert_eq!(parsed.correct_action, state.correct_action);
        assert_eq!(
            parsed.book_rationale.as_ref().map(|r| r.rules.len()),
            state.book_rationale.as_ref().map(|r| r.rules.len())
        );
    }
}
