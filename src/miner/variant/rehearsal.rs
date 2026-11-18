//! The 100-scenario rehearsal set.
//!
//! §4.7's acceptance gate ends with "a 100-scenario rehearsal pack contains
//! variants from at least two transform families and no base above the cap".
//! There is no committed replay corpus, so the rehearsal builds its bases the
//! way P1a's fixture builds its scenarios: from the app's own seeded lesson
//! generators, stamped with the classifier's own answer. The provenance rows
//! are P1a's fixture games, so the assembled pack passes the P1a source/licence
//! gate without a corpus.
//!
//! This is evidence, not a pack: the rehearsal's states are generated, so
//! `validation.replay_roundtrip` is false and the pack report says so.

use std::collections::BTreeSet;

use crate::generator::ScenarioId;
use crate::miner::pack::fixture_games;
use crate::miner::provenance::GameProvenance;
use crate::miner::select::dedupe::exact_state_hash;

use super::VariantError;
use super::base::BaseScenario;

/// Seed for the rehearsal's lesson draws.
pub const REHEARSAL_SEED: u64 = 0x5eed_2026;

/// A rehearsal's bases and the fixture games their provenance points at.
#[derive(Debug, Clone)]
pub struct Rehearsal {
    /// The book-labelled base scenarios, in draw order.
    pub bases: Vec<BaseScenario>,
    /// The fixture provenance rows (two games, so the agent union is not
    /// trivial).
    pub games: Vec<GameProvenance>,
    /// Lessons or draws that could not contribute a new base, with the reason.
    pub skipped: Vec<String>,
}

/// Build up to `count` distinct book bases, round-robin over the registered
/// classifiers.
///
/// The draw is seeded deterministically, and duplicate states collapse, so the
/// same `count` always produces the same rehearsal on the same build. A lesson
/// whose generator cannot produce a state (or whose state does not match its own
/// classifier) is skipped and recorded; the caller gets however many distinct
/// bases the remaining lessons could supply.
pub fn rehearsal_bases(count: usize) -> Result<Rehearsal, VariantError> {
    if count == 0 {
        return Err(VariantError::Config(
            "the rehearsal needs at least one base".to_string(),
        ));
    }
    let games = fixture_games();
    let lessons: Vec<ScenarioId> = crate::classifier::registered_lessons().collect();
    if lessons.is_empty() {
        return Err(VariantError::Config(
            "no classifier lesson is registered".to_string(),
        ));
    }

    let mut bases = Vec::with_capacity(count);
    let mut skipped = Vec::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut draw = 0_usize;
    let max_draws = count.saturating_mul(4).max(lessons.len());
    while bases.len() < count && draw < max_draws {
        let lesson = lessons[draw % lessons.len()];
        let index = draw;
        crate::rng::seed(REHEARSAL_SEED.wrapping_add(draw as u64));
        draw += 1;
        let replay = &games[index % games.len()];
        match BaseScenario::from_generated(lesson, index, replay) {
            Ok(base) => {
                let hash = exact_state_hash(&base.scenario.state);
                if seen.insert(hash) {
                    bases.push(base);
                } else {
                    if skipped.len() < 32 {
                        skipped.push(format!(
                            "draw {index}: `{}` produced a duplicate state",
                            lesson.as_str()
                        ));
                    }
                }
            }
            Err(err) => {
                if skipped.len() < 32 {
                    skipped.push(format!("draw {index}: {err}"));
                }
            }
        }
    }

    if bases.is_empty() {
        return Err(VariantError::Config(
            "the rehearsal could not build a single base scenario".to_string(),
        ));
    }
    Ok(Rehearsal {
        bases,
        games,
        skipped,
    })
}
