//! Book-side rationale: the rule, the quote, and the citation for a scenario.
//!
//! The generator decides the answer from a Riichi Book 1 heuristic; this module
//! says which rule that is, in words that came from the book. Every trigger
//! enum variant is handled by an exhaustive match on
//! [`RiichiTrigger`], [`DamaReason`], and [`ShouminkanTrigger`], so adding a
//! variant without a rationale is a compile error rather than an empty panel.
//!
//! Variants that record the *absence* of a justification (`no_tanyao`,
//! `no_red_five_wait`, `no_suji_trap`) return `None` and get an [`AbsentRule`]
//! note instead: the book never argued for them, and inventing a citation would
//! be worse than showing none.
//!
//! Quotes are verbatim from the checked-out LaTeX, with formatting macros
//! stripped (`{\jap tanyao}` reads "tanyao"). [`Citation::source_needle`] keeps
//! the raw form so a test can detect source drift.

use serde::{Deserialize, Serialize};

use crate::state::{
    CorrectAction, CorrectActionType, DamaReason, GameState, RiichiTrigger, ShouminkanTrigger,
};

/// A book reference. Line numbers are hints for reviewers, not stable anchors;
/// `source_needle` is what the drift test checks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Citation {
    pub book: String,
    pub chapter: u8,
    pub chapter_title: String,
    pub section: String,
    pub source_file: String,
    pub source_line: u32,
    pub source_needle: String,
}

impl Citation {
    /// One-line provenance label for the UI, e.g.
    /// `ch7 · Riichi judgement · Chiitoitsu not waiting for dora`.
    pub fn label(&self) -> String {
        format!(
            "ch{} · {} · {}",
            self.chapter, self.chapter_title, self.section
        )
    }
}

/// The rule text for one trigger or reason.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuleText {
    /// One-sentence statement of the rule, in the trainer's words.
    pub rule: &'static str,
    /// Short verbatim quote from the book.
    pub quote: &'static str,
    pub citation: Citation,
}

fn citation(
    chapter: u8,
    chapter_title: &str,
    section: &str,
    source_file: &str,
    source_line: u32,
    source_needle: &str,
) -> Citation {
    Citation {
        book: "Riichi Book 1".to_string(),
        chapter,
        chapter_title: chapter_title.to_string(),
        section: section.to_string(),
        source_file: source_file.to_string(),
        source_line,
        source_needle: source_needle.to_string(),
    }
}

fn ch7(section: &str, line: u32, needle: &str) -> Citation {
    citation(
        7,
        "Riichi judgement",
        section,
        "RiichiBook1-ch7-riichi.tex",
        line,
        needle,
    )
}

fn ch9(line: u32, needle: &str) -> Citation {
    citation(
        9,
        "Melding judgement",
        "From an open set to an open quad (kakan)",
        "RiichiBook1-ch9-call.tex",
        line,
        needle,
    )
}

fn ch8(needle: &str) -> Citation {
    citation(
        8,
        "Defense judgement",
        "Understanding suji",
        "RiichiBook1-ch8-defense.tex",
        163,
        needle,
    )
}

fn ch4(line: u32, needle: &str) -> Citation {
    citation(
        4,
        "The five-block method",
        "Finding a redundant tile",
        "RiichiBook1-ch4-five.tex",
        line,
        needle,
    )
}

fn ch3(line: u32, needle: &str) -> Citation {
    citation(
        3,
        "Riichi mahjong basics",
        "Protoruns (taatsu)",
        "RiichiBook1-ch3-basics.tex",
        line,
        needle,
    )
}

const CHIITOITSU_BOX: &str = "Chiitoitsu not waiting for dora";

impl RiichiTrigger {
    /// Stable id matching the serialized enum name.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Dealer => "dealer",
            Self::Tanyao => "tanyao",
            Self::RedFiveWait => "red_five_wait",
            Self::SujiTrap => "suji_trap",
            Self::WaitOutside456 => "wait_outside_456",
            Self::ScoreBelowMangan => "score_below_mangan",
        }
    }

    /// The book rule this trigger encodes.
    pub fn rationale(self) -> RuleText {
        match self {
            Self::Dealer => RuleText {
                rule: "Being the dealer adds enough value to justify Riichi on a \
                       chiitoitsu hand that is not waiting on the dora.",
                quote: "You are the dealer;",
                citation: ch7(CHIITOITSU_BOX, 349, "You are the dealer"),
            },
            Self::Tanyao => RuleText {
                rule: "Tanyao justifies Riichi even when the wait itself is awkward.",
                quote: "You have tanyao;",
                citation: ch7(CHIITOITSU_BOX, 350, "You have {\\jap tanyao}"),
            },
            Self::RedFiveWait => RuleText {
                rule: "Holding the red five means the wait is the regular five, \
                       which justifies Riichi.",
                quote: "You have one red five, waiting for a regular five;",
                citation: ch7(CHIITOITSU_BOX, 351, "waiting for a regular five"),
            },
            // The definition lives in the defense chapter; the decision rule is
            // the chiitoitsu box item that references it.
            Self::SujiTrap => RuleText {
                rule: "A suji-trap wait makes the winning tile look safe to the \
                       opponents, which justifies Riichi.",
                quote: "When you wait for a tile that is a suji tile of some tiles \
                        you have discarded yourself, we say you have a suji-trap wait.",
                citation: ch8("we say you have a"),
            },
            Self::WaitOutside456 => RuleText {
                rule: "A single wait other than 4, 5, or 6 justifies Riichi: \
                       middle tiles are the ones opponents are least likely to discard.",
                quote: "The wait is any tile other than 4, 5, 6;",
                citation: ch7(CHIITOITSU_BOX, 353, "any tile other than 4, 5, 6"),
            },
            Self::ScoreBelowMangan => RuleText {
                rule: "A hand worth less than mangan without Riichi justifies Riichi.",
                quote: "The score without riichi is below mangan.",
                citation: ch7(CHIITOITSU_BOX, 354, "below {\\jap mangan}"),
            },
        }
    }
}

impl DamaReason {
    /// Stable id matching the serialized enum name.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotDealer => "not_dealer",
            Self::NoTanyao => "no_tanyao",
            Self::MiddleWait => "middle_wait",
            Self::NoRedFiveWait => "no_red_five_wait",
            Self::NoSujiTrap => "no_suji_trap",
            Self::Mangan => "mangan",
        }
    }

    /// The book rule, or `None` when this reason only records that a Riichi
    /// justification is absent.
    pub fn rationale(self) -> Option<RuleText> {
        match self {
            Self::NotDealer => Some(RuleText {
                rule: "A non-dealer waiting on 4, 5, or 6 is one of the two cases \
                       where the book keeps the hand in dama.",
                quote: "when you are a non-dealer",
                citation: ch7(CHIITOITSU_BOX, 359, "when you are a non-dealer"),
            }),
            Self::MiddleWait => Some(RuleText {
                rule: "A 4/5/6 single wait is the worst kind of wait, so it is the \
                       wait half of the book's dama case.",
                quote: "waiting for 4,5,6",
                citation: ch7(CHIITOITSU_BOX, 359, "waiting for 4,5,6"),
            }),
            Self::Mangan => Some(RuleText {
                rule: "A hand already worth mangan keeps its value without Riichi, \
                       which is above the book's 5200/7700 cut-point.",
                quote: "it is OK to go dama",
                citation: ch7("High scoring hand", 569, "it is OK to go {\\jap dama}"),
            }),
            Self::NoTanyao | Self::NoRedFiveWait | Self::NoSujiTrap => None,
        }
    }

    /// One line explaining an absent justification.
    pub fn absent_note(self) -> Option<&'static str> {
        match self {
            Self::NoTanyao => Some("No tanyao, so that Riichi justification does not apply."),
            Self::NoRedFiveWait => {
                Some("No red five on the wait, so that justification does not apply.")
            }
            Self::NoSujiTrap => {
                Some("No suji of the wait in the river, so the trap justification does not apply.")
            }
            Self::NotDealer | Self::MiddleWait | Self::Mangan => None,
        }
    }
}

impl ShouminkanTrigger {
    /// Stable id matching the serialized enum name.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::GoodWaitAndValue => "good_wait_and_value",
            Self::LateGame => "late_game",
            Self::PlacementDesperation => "placement_desperation",
            Self::LosingBadly => "losing_badly",
        }
    }

    /// The book rule this trigger encodes.
    pub fn rationale(self) -> RuleText {
        match self {
            Self::GoodWaitAndValue => RuleText {
                rule: "Extend the open Pon when the hand is close to ready with a \
                       good wait and at least two han.",
                quote: "the hand is 1-away or better with a good wait, and it has \
                        two han or more",
                citation: ch9(367, "two {\\jap han} or more"),
            },
            Self::LateGame => RuleText {
                rule: "Extend when there are not many turns left to draw.",
                quote: "the hand is 1-away or better, and there are not many turns \
                        left to draw tiles",
                citation: ch9(368, "not many turns left"),
            },
            Self::PlacementDesperation => RuleText {
                rule: "Extend when extra dora or minipoints are needed to improve \
                       the placement, especially in South 4.",
                quote: "you need more dora or minipoints to improve the placement \
                        (especially in South-4)",
                citation: ch9(369, "improve the placement"),
            },
            Self::LosingBadly => RuleText {
                rule: "Extend when you are losing badly.",
                quote: "you are losing badly.",
                citation: ch9(370, "losing badly"),
            },
        }
    }
}

/// One rule the book states for this answer, with the reason it applies here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BookRule {
    /// Trigger id, e.g. `dealer` or `good_wait_and_value`.
    pub id: String,
    pub rule: String,
    pub quote: String,
    pub citation: Citation,
    /// Why this hand satisfies the rule, in one line.
    pub applies: String,
}

/// A Riichi justification that does not hold for this hand. No citation: the
/// book never argued for an absent condition.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AbsentRule {
    pub id: String,
    pub note: String,
}

/// The book's side of the verdict for one scenario.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BookRationale {
    /// What the scenario is teaching, in one line.
    pub summary: String,
    /// Rules the book actually states for this answer.
    pub rules: Vec<BookRule>,
    /// Riichi justifications that do not hold here.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub absent: Vec<AbsentRule>,
    /// Primary source for the scenario as a whole.
    pub source: Citation,
    /// Straightforward caveats, e.g. the chankan risk on a kakan.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub caveats: Vec<String>,
}

impl BookRationale {
    /// Rules that carry a citation, for rendering and drift tests.
    pub fn cited_rules(&self) -> impl Iterator<Item = &BookRule> {
        self.rules.iter()
    }
}

/// Build the book rationale for a generated or imported state.
///
/// Returns `None` for a Mortal drill (no book rule) or for a state with neither
/// triggers nor a category rule (a bare imported table).
pub fn rationale_for(state: &GameState) -> Option<BookRationale> {
    if matches!(state.correct_action, CorrectAction::Best { .. }) {
        return None;
    }

    let mut rules = Vec::new();
    let mut absent = Vec::new();

    for trigger in &state.riichi_triggers {
        let text = trigger.rationale();
        rules.push(book_rule(
            trigger.as_str(),
            text,
            applies_riichi(*trigger, state),
        ));
    }
    for reason in &state.dama_reasons {
        match reason.rationale() {
            Some(text) => rules.push(book_rule(
                reason.as_str(),
                text,
                applies_dama(*reason, state),
            )),
            None => {
                if let Some(note) = reason.absent_note() {
                    absent.push(AbsentRule {
                        id: reason.as_str().to_string(),
                        note: note.to_string(),
                    });
                }
            }
        }
    }
    for trigger in &state.shouminkan_triggers {
        let text = trigger.rationale();
        rules.push(book_rule(
            trigger.as_str(),
            text,
            applies_shouminkan(*trigger, state),
        ));
    }

    if rules.is_empty() && absent.is_empty() {
        return category_rationale(state);
    }

    let fallback = rules
        .first()
        .map(|rule| rule.citation.clone())
        .unwrap_or_else(|| ch7(CHIITOITSU_BOX, 345, "Riichi judgement"));

    Some(BookRationale {
        summary: summary_for(state),
        rules,
        absent,
        source: scenario_source(&state.category).unwrap_or(fallback),
        caveats: caveats_for(state),
    })
}

fn book_rule(id: &str, text: RuleText, applies: String) -> BookRule {
    BookRule {
        id: id.to_string(),
        rule: text.rule.to_string(),
        quote: text.quote.to_string(),
        citation: text.citation,
        applies,
    }
}

fn human(state: &GameState) -> Option<&crate::state::PlayerState> {
    state.players.iter().find(|player| player.is_human)
}

fn wait_tile(state: &GameState) -> String {
    state.ukeire_tiles.first().cloned().unwrap_or_default()
}

fn applies_riichi(trigger: RiichiTrigger, state: &GameState) -> String {
    let wait = wait_tile(state);
    match trigger {
        RiichiTrigger::Dealer => "You are the dealer (East).".to_string(),
        RiichiTrigger::Tanyao => "Every pair and the wait are simples.".to_string(),
        RiichiTrigger::RedFiveWait => {
            format!("The wait is {wait} and its red five is in hand.")
        }
        RiichiTrigger::SujiTrap => "A suji of the wait is already in your river.".to_string(),
        RiichiTrigger::WaitOutside456 => format!("The wait is {wait}, outside 4-5-6."),
        RiichiTrigger::ScoreBelowMangan => {
            "At most one dora, so the hand is below mangan without Riichi.".to_string()
        }
    }
}

fn applies_dama(reason: DamaReason, state: &GameState) -> String {
    let wind = human(state).map(|player| player.wind);
    let wait = wait_tile(state);
    match reason {
        DamaReason::NotDealer => match wind {
            Some(wind) => format!("Seat wind is {wind:?}, not East."),
            None => "You are not the dealer.".to_string(),
        },
        DamaReason::NoTanyao => "A terminal or honor pair rules out tanyao.".to_string(),
        DamaReason::MiddleWait => format!("The wait is {wait}, a middle tile."),
        DamaReason::NoRedFiveWait => "No red five is held.".to_string(),
        DamaReason::NoSujiTrap => "Your river holds no suji of the wait.".to_string(),
        DamaReason::Mangan => "The hand is already mangan without Riichi.".to_string(),
    }
}

fn applies_shouminkan(trigger: ShouminkanTrigger, state: &GameState) -> String {
    match trigger {
        ShouminkanTrigger::GoodWaitAndValue => format!(
            "{} shanten with {} live waits and at least two han.",
            state.shanten,
            state.ukeire_tiles.len()
        ),
        ShouminkanTrigger::LateGame => format!(
            "{} tiles left in the wall and every river has at least 13 discards.",
            state.tiles_remaining
        ),
        ShouminkanTrigger::PlacementDesperation => {
            "South 4, within 2,000 points of the player directly above.".to_string()
        }
        ShouminkanTrigger::LosingBadly => {
            "Fourth place, more than 12,000 points behind third.".to_string()
        }
    }
}

fn summary_for(state: &GameState) -> String {
    if !state.shouminkan_triggers.is_empty() {
        return "Upgrade the open Pon to an Added Kan: the book's kakan criteria pick this \
                hand."
            .to_string();
    }
    if !state.riichi_triggers.is_empty() {
        return "Declare Riichi: the book's chiitoitsu criteria pick this hand.".to_string();
    }
    "Stay in dama: the book keeps this chiitoitsu hand concealed.".to_string()
}

fn caveats_for(state: &GameState) -> Vec<String> {
    let mut caveats = Vec::new();

    if !state.dama_reasons.is_empty() {
        caveats.push(
            "The book's second dama case is specifically honitsu/chinitsu chiitoitsu; this \
             trainer uses a mangan-or-better test instead."
                .to_string(),
        );
        caveats.push(
            "The book's cut-point is 5200/7700 without Riichi; this hand is above it.".to_string(),
        );
    }
    if !state.shouminkan_triggers.is_empty() {
        caveats.push(
            "Extending an open Pon is riskier than a concealed quad: an opponent may rob the \
             Kong (chankan)."
                .to_string(),
        );
    }

    caveats
}

fn scenario_source(category: &str) -> Option<Citation> {
    match category {
        "chiitoitsu_riichi_vs_dama" => Some(ch7(CHIITOITSU_BOX, 345, "Riichi judgement")),
        "shouminkan_decision" => Some(ch9(360, "From an open set to an open quad")),
        "ryanmen_protorun" => Some(ch4(44, "completely redundant")),
        _ => None,
    }
}

/// Tile-efficiency lessons have no trigger enum; their rules are category-level.
fn category_rationale(state: &GameState) -> Option<BookRationale> {
    if state.category != "ryanmen_protorun" {
        return None;
    }

    let discard = state.correct_action.tile().unwrap_or_default().to_string();
    let waits = &state.ukeire_tiles;
    let wait_text = if waits.len() == 2 {
        format!("{} / {}", waits[0], waits[1])
    } else {
        waits.join(" / ")
    };

    let rules = vec![
        BookRule {
            id: "redundant_tile".to_string(),
            rule: "From a three-tile XXY/XYY shape, the duplicated tile is the redundant \
                   one: the hand can already use the other two tiles as a side-wait \
                   protorun."
                .to_string(),
            quote: "is completely redundant; the hand can accept tong3 without having tong2"
                .to_string(),
            citation: ch4(44, "completely redundant"),
            applies: format!("Discarding {discard} leaves {wait_text} as the wait."),
        },
        BookRule {
            id: "side_wait_protorun".to_string(),
            rule: "A side-wait (ryanmen) protorun accepts twice as many tiles as a closed or \
                   edge wait, so the discard must leave the ryanmen intact."
                .to_string(),
            quote: "a side-wait (ryanmen) protorun can accept twice as many tiles as a \
                    closed-wait (kanchan) protorun or an edge-wait (penchan) protorun can."
                .to_string(),
            citation: ch3(205, "can accept twice as many tiles"),
            applies: format!("After the discard the hand waits on {wait_text}."),
        },
    ];

    Some(BookRationale {
        summary: "Discard the duplicate: it is the redundant tile, and the other two tiles \
                  stay a live side-wait protorun."
            .to_string(),
        rules,
        absent: Vec::new(),
        source: ch4(44, "completely redundant"),
        caveats: Vec::new(),
    })
}

/// Grade a `CorrectActionType` mismatch as text, used by the UI's "should be"
/// line without re-deriving rules in React.
pub fn action_type_label(action: CorrectActionType) -> &'static str {
    match action {
        CorrectActionType::Riichi => "Riichi",
        CorrectActionType::Dama => "Dama",
        CorrectActionType::Kan => "Kan",
        CorrectActionType::Discard => "No Kan",
        CorrectActionType::Best => "Mortal action",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generator::generate_puzzle;

    #[test]
    fn every_riichi_trigger_has_a_rule_quote_and_citation() {
        for trigger in [
            RiichiTrigger::Dealer,
            RiichiTrigger::Tanyao,
            RiichiTrigger::RedFiveWait,
            RiichiTrigger::SujiTrap,
            RiichiTrigger::WaitOutside456,
            RiichiTrigger::ScoreBelowMangan,
        ] {
            let text = trigger.rationale();
            assert!(!text.rule.is_empty(), "{trigger:?} rule");
            assert!(!text.quote.is_empty(), "{trigger:?} quote");
            assert!(
                !text.citation.source_needle.is_empty(),
                "{trigger:?} needle"
            );
            assert!(!text.citation.chapter_title.is_empty(), "{trigger:?} title");
        }
    }

    #[test]
    fn dama_reasons_split_into_positive_and_absent() {
        let positive = [
            DamaReason::NotDealer,
            DamaReason::MiddleWait,
            DamaReason::Mangan,
        ];
        let absent = [
            DamaReason::NoTanyao,
            DamaReason::NoRedFiveWait,
            DamaReason::NoSujiTrap,
        ];

        for reason in positive {
            assert!(
                reason.rationale().is_some(),
                "{reason:?} must cite the book"
            );
            assert!(reason.absent_note().is_none());
        }
        for reason in absent {
            assert!(
                reason.rationale().is_none(),
                "{reason:?} has nothing to cite"
            );
            assert!(reason.absent_note().is_some(), "{reason:?} needs a note");
        }
    }

    #[test]
    fn every_shouminkan_trigger_has_a_rule_quote_and_citation() {
        for trigger in [
            ShouminkanTrigger::GoodWaitAndValue,
            ShouminkanTrigger::LateGame,
            ShouminkanTrigger::PlacementDesperation,
            ShouminkanTrigger::LosingBadly,
        ] {
            let text = trigger.rationale();
            assert!(!text.rule.is_empty(), "{trigger:?} rule");
            assert!(!text.quote.is_empty(), "{trigger:?} quote");
            assert!(
                !text.citation.source_needle.is_empty(),
                "{trigger:?} needle"
            );
        }
    }

    #[test]
    fn dama_hands_render_rules_and_absent_reasons_separately() {
        let mut state = crate::fixtures::mock_table::generate("mock_table").unwrap();
        state.riichi_triggers.clear();
        state.dama_reasons = vec![
            DamaReason::NotDealer,
            DamaReason::NoTanyao,
            DamaReason::MiddleWait,
            DamaReason::NoRedFiveWait,
            DamaReason::NoSujiTrap,
            DamaReason::Mangan,
        ];
        state.correct_action = CorrectAction::dama("3p");

        let rationale = rationale_for(&state).expect("dama state needs a rationale");

        assert_eq!(rationale.rules.len(), 3);
        assert_eq!(rationale.absent.len(), 3);
        assert!(rationale.caveats.iter().any(|c| c.contains("honitsu")));
    }

    #[test]
    fn ryanmen_hand_gets_a_category_rationale() {
        let state = generate_puzzle("ryanmen_protorun").expect("ryanmen must generate");

        let rationale = rationale_for(&state).expect("ryanmen needs a rationale");

        assert_eq!(rationale.rules.len(), 2);
        assert!(rationale.absent.is_empty());
        assert!(rationale.rules.iter().all(|rule| !rule.applies.is_empty()));
        assert_eq!(rationale.source.chapter, 4);
    }

    #[test]
    fn generated_book_scenarios_carry_a_rationale() {
        for category in [
            "ryanmen_protorun",
            "chiitoitsu_riichi_vs_dama",
            "shouminkan_decision",
        ] {
            let state = generate_puzzle(category).expect("scenario must generate");
            assert!(
                state.book_rationale.is_some(),
                "{category} must carry a rationale"
            );
            let rationale = state.book_rationale.unwrap();
            assert!(!rationale.summary.is_empty());
            assert!(!rationale.rules.is_empty());
        }
    }

    #[test]
    fn drill_has_no_book_rationale() {
        let mut state = crate::fixtures::mock_table::generate("mock_table").unwrap();
        state.correct_action = CorrectAction::best(
            "Discard_3p",
            Some("3p".to_string()),
            Vec::new(),
            "Discard 3p".to_string(),
        );

        assert!(rationale_for(&state).is_none());
    }

    #[test]
    fn citations_point_at_real_sources() {
        let root = std::env::var("RIIICHI_BOOK_SRC")
            .unwrap_or_else(|_| "/home/kylehipke/workspaces/RiichiBooks".to_string());
        let root = std::path::Path::new(&root);
        if !root.is_dir() {
            eprintln!(
                "skipping citation drift test: {} is missing (set RIIICHI_BOOK_SRC)",
                root.display()
            );
            return;
        }

        let mut citations: Vec<Citation> = Vec::new();
        for trigger in [
            RiichiTrigger::Dealer,
            RiichiTrigger::Tanyao,
            RiichiTrigger::RedFiveWait,
            RiichiTrigger::SujiTrap,
            RiichiTrigger::WaitOutside456,
            RiichiTrigger::ScoreBelowMangan,
        ] {
            citations.push(trigger.rationale().citation);
        }
        for reason in [
            DamaReason::NotDealer,
            DamaReason::MiddleWait,
            DamaReason::Mangan,
        ] {
            citations.push(reason.rationale().expect("positive reason").citation);
        }
        for trigger in [
            ShouminkanTrigger::GoodWaitAndValue,
            ShouminkanTrigger::LateGame,
            ShouminkanTrigger::PlacementDesperation,
            ShouminkanTrigger::LosingBadly,
        ] {
            citations.push(trigger.rationale().citation);
        }

        let ryanmen = generate_puzzle("ryanmen_protorun").expect("ryanmen must generate");
        citations.extend(
            rationale_for(&ryanmen)
                .expect("rationale")
                .rules
                .into_iter()
                .map(|rule| rule.citation),
        );

        for citation in citations {
            let path = root.join(&citation.source_file);
            let text = std::fs::read_to_string(&path).unwrap_or_else(|err| {
                panic!("cannot read {}: {err}", path.display());
            });
            assert!(
                text.contains(&citation.source_needle),
                "{} no longer contains {:?} (section {:?})",
                citation.source_file,
                citation.source_needle,
                citation.section
            );
        }
    }

    #[test]
    fn action_type_labels_are_stable() {
        assert_eq!(action_type_label(CorrectActionType::Riichi), "Riichi");
        assert_eq!(action_type_label(CorrectActionType::Dama), "Dama");
        assert_eq!(action_type_label(CorrectActionType::Kan), "Kan");
        assert_eq!(action_type_label(CorrectActionType::Discard), "No Kan");
    }
}
