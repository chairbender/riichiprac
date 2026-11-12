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

use agari::parse::to_counts;
use agari::shanten::{
    calculate_shanten, calculate_shanten_with_melds, calculate_ukeire, calculate_ukeire_with_melds,
};
use agari::tile::{Suit, Tile};

use crate::display::format_tile_for_display;
use crate::generator::floating_quad_acceptance;
use crate::generator::{can_be_pinfu_head, wind_from_honor};
use crate::safety::{SafetyFacts, SafetyRank, in_open_hand_neighbourhood};
use crate::state::{
    CorrectAction, CorrectActionType, DamaReason, GameState, MeldType, RiichiTrigger,
    ShouminkanTrigger,
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

/// Riichi Book 1, ch. 9, "Concealed quad (ankan)" — the ankan conditions, the
/// floating-tile objection, and the "not even when close to ready" box.
fn ch9_ankan(line: u32, needle: &str) -> Citation {
    citation(
        9,
        "Melding judgement",
        "Concealed quad (ankan)",
        "RiichiBook1-ch9-call.tex",
        line,
        needle,
    )
}

/// Riichi Book 1, ch. 9, "Open quad (daiminkan)" — the three situations that
/// justify calling the fourth copy off a discard, and the two boxes that refuse
/// it.
fn ch9_daiminkan(line: u32, needle: &str) -> Citation {
    citation(
        9,
        "Melding judgement",
        "Open quad (daiminkan)",
        "RiichiBook1-ch9-call.tex",
        line,
        needle,
    )
}

fn ch9_seating(line: u32, needle: &str) -> Citation {
    citation(
        9,
        "Melding judgement",
        "Be mindful of the seating",
        "RiichiBook1-ch9-call.tex",
        line,
        needle,
    )
}

/// Riichi Book 1, ch. 9, "To meld or not to meld?" — the cheap-and-slow rule and
/// its exceptions.
fn ch9_meld(line: u32, needle: &str) -> Citation {
    citation(
        9,
        "Melding judgement",
        "To meld or not to meld?",
        "RiichiBook1-ch9-call.tex",
        line,
        needle,
    )
}

fn ch8(section: &str, line: u32, needle: &str) -> Citation {
    citation(
        8,
        "Defense judgement",
        section,
        "RiichiBook1-ch8-defense.tex",
        line,
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

/// Riichi Book 1, ch. 4, "Exercises: building a block" — the 5-block exercises
/// that keep (Answer 13) and break (Exercise 14) the same bulging float.
fn ch4_blocks(line: u32, needle: &str) -> Citation {
    citation(
        4,
        "The five-block method",
        "Exercises: building a block",
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

fn ch3_bulging(line: u32, needle: &str) -> Citation {
    citation(
        3,
        "Riichi mahjong basics",
        "Bulging float (nakabukure) shape",
        "RiichiBook1-ch3-basics.tex",
        line,
        needle,
    )
}

fn ch3_ryankan(line: u32, needle: &str) -> Citation {
    citation(
        3,
        "Riichi mahjong basics",
        "Double closed (ryankan) shape",
        "RiichiBook1-ch3-basics.tex",
        line,
        needle,
    )
}

fn ch3_pairs(line: u32, needle: &str) -> Citation {
    citation(
        3,
        "Riichi mahjong basics",
        "Pairs and sets",
        "RiichiBook1-ch3-basics.tex",
        line,
        needle,
    )
}

/// Riichi Book 1, ch. 5, "How to get pinfu", *Building the head*: the head must
/// be a pair of number tiles or valueless wind tiles, never a value honor.
fn ch5_pinfu_head(line: u32, needle: &str) -> Citation {
    citation(
        5,
        "Pursuing yaku",
        "Building the head",
        "RiichiBook1-ch5-yaku.tex",
        line,
        needle,
    )
}

const CHIITOITSU_BOX: &str = "Chiitoitsu not waiting for dora";
/// Riichi Book 1, ch. 7, "To riichi or not to riichi?": the general
/// three-condition rule the `riichi_judgement` lesson grades.
const GENERAL_RULE: &str = "To riichi or not to riichi?";

const CH8_GENBUTSU: &str = "Genbutsu and other absolutely safe tiles";
const CH8_SUJI: &str = "Understanding suji";
const CH8_KABE: &str = "Understanding tile blockade";
const CH8_RANKING: &str = "Safety ranking";
const CH8_BLOCKADE_RANKING: &str = "Tile blockade: Safety ranking";
const CH8_VS_RIICHI: &str = "Defense against riichi";
const CH8_STUCK: &str = "What to discard when you get stuck";
const CH8_READY_SHORTCUT: &str = "Guessing if an opponent has a ready hand";
const CH8_CHII_DISCARD: &str = "Discard upon chii";
const CH8_PUSH_FOLD: &str = "Three conditions to push/fold";

impl RiichiTrigger {
    /// Stable id matching the serialized enum name.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Dealer => "dealer",
            Self::HasExtraHan => "has_extra_han",
            Self::GoodWait => "good_wait",
            Self::ThreeLiveWinningTiles => "three_live_winning_tiles",
            Self::HonorTerminalWait => "honor_terminal_wait",
            Self::Tanyao => "tanyao",
            Self::RedFiveWait => "red_five_wait",
            Self::SujiTrap => "suji_trap",
            Self::ImmediateSujiTrap => "immediate_suji_trap",
            Self::WaitOutside456 => "wait_outside_456",
            Self::ScoreBelowMangan => "score_below_mangan",
        }
    }

    /// The book rule this trigger encodes.
    pub fn rationale(self) -> RuleText {
        match self {
            Self::Dealer => RuleText {
                rule: "Being the dealer adds enough value to justify Riichi, even on a \
                       yaku-less hand with a bad wait.",
                quote: "You are the dealer.",
                citation: ch7(GENERAL_RULE, 59, "You are the dealer"),
            },
            Self::HasExtraHan => RuleText {
                rule: "One han or more (a yaku or dora) without Riichi justifies \
                       Riichi, even with a bad wait.",
                quote: "Your hand has at least one {\\jap han} other than riichi.",
                citation: ch7(GENERAL_RULE, 57, "other than riichi"),
            },
            Self::GoodWait => RuleText {
                rule: "A good wait justifies Riichi: the book counts a wait as good \
                       when it has at least two kinds and more than four live tiles \
                       left to win on.",
                quote: "Your hand has a good wait.",
                citation: ch7(GENERAL_RULE, 58, "Your hand has a good wait"),
            },
            Self::ThreeLiveWinningTiles => RuleText {
                rule: "Even a bad wait justifies Riichi when three or more winning \
                       tiles are left in the board.",
                quote: "Call riichi if there are three or more winning tiles left in the board.",
                citation: ch7("Bad wait", 521, "three or more winning tiles"),
            },
            Self::HonorTerminalWait => RuleText {
                rule: "A bad wait on an honor or terminal tile can still be called with \
                       only one or two live tiles.",
                quote: "When waiting for an honor/terminal tile, you can call riichi even \
                        when only one tile is left in the board.",
                citation: ch7("Bad wait", 522, "honor/terminal tile"),
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
                citation: ch8("Understanding suji", 165, "we say you have a"),
            },
            Self::ImmediateSujiTrap => RuleText {
                rule: "Declare Riichi on the tile three ranks from the wait: the winning \
                       tile then looks like a safe suji of the declaration tile.",
                quote: "If you call riichi by discarding the 6, the hand waits for 3, \
                        which is a suji tile of 6 (immediate suji-trap riichi).",
                citation: ch8("Suji trap", 170, "immediate {\\jap suji}-trap riichi"),
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
            Self::BadWait => "bad_wait",
            Self::NoExtraHan => "no_extra_han",
            Self::FewLiveWinningTiles => "few_live_winning_tiles",
            Self::GenbutsuWait => "genbutsu_wait",
            Self::NoTanyao => "no_tanyao",
            Self::MiddleWait => "middle_wait",
            Self::NoRedFiveWait => "no_red_five_wait",
            Self::NoSujiTrap => "no_suji_trap",
            Self::Mangan => "mangan",
            Self::HanemanPlus => "haneman_plus",
            Self::EarlyTurn => "early_turn",
            Self::ImprovingHand => "improving_hand",
        }
    }

    /// The book rule, or `None` when this reason only records that a Riichi
    /// justification is absent.
    pub fn rationale(self) -> Option<RuleText> {
        match self {
            Self::NotDealer => Some(RuleText {
                rule: "The dealer condition does not hold: the book only gives the \
                       deal's extra value to the East seat.",
                quote: "You are the dealer.",
                citation: ch7(GENERAL_RULE, 59, "You are the dealer"),
            }),
            Self::BadWait => Some(RuleText {
                rule: "A bad wait is the wait half of the book's dama case: a wait \
                       needs at least two kinds and more than four live tiles to \
                       count as good.",
                quote: "a wait is said to be good if there are at least two kinds \
                        and more than four tiles left to win on",
                citation: ch7("Bad wait", 491, "at least two kinds"),
            }),
            Self::NoExtraHan => Some(RuleText {
                rule: "A hand with no yaku or dora other than Riichi is \
                       \"riichi-only\": the declaration is the only value it can add.",
                quote: "bad-wait riichi-only hand by a non-dealer",
                citation: ch7(GENERAL_RULE, 71, "riichi-only hand"),
            }),
            Self::FewLiveWinningTiles => Some(RuleText {
                rule: "A bad wait with only one or two live simple winning tiles is the \
                       section's dama case.",
                quote: "Go dama if there are only one or two simple tiles left to win on.",
                citation: ch7("Bad wait", 522, "one or two simple tiles"),
            }),
            Self::GenbutsuWait => Some(RuleText {
                rule: "When one of your winning tiles is the genbutsu of the player everyone \
                       is watching, keep the hand dama: the players folding to that threat \
                       discard exactly the tiles it cannot ron.",
                quote: "one of your winning tiles is among their genbutsu tiles",
                citation: ch7(
                    "Genbutsu wait",
                    539,
                    "one of your winning tiles is among their",
                ),
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
            Self::HanemanPlus => Some(RuleText {
                rule: "When even the worst winning tile scores a haneman or better \
                       without Riichi, the book does not declare Riichi at all.",
                quote: "Don't riichi if the minimum hand value is {\\jap haneman} or better.",
                citation: ch7(
                    "High scoring hand",
                    646,
                    "Don't riichi if the minimum hand value is",
                ),
            }),
            Self::EarlyTurn => Some(RuleText {
                rule: "The first half of the box: it is still an early turn \
                       (8th turn or before), so an improving draw still has time \
                       to arrive.",
                quote: "It is still an early turn (8th turn or before);",
                citation: ch7(
                    "Many possibilities of improving the hand",
                    658,
                    "It is still an early turn",
                ),
            }),
            Self::ImprovingHand => Some(RuleText {
                rule: "It makes sense to keep dama only when it is still an early turn \
                       and at least six kinds of tiles improve the score or the wait, or \
                       one kind improves the score by three han in one step.",
                quote: "There are at least six kinds of tiles that can improve the scores \
                        and/or the wait",
                citation: ch7(
                    "Many possibilities of improving the hand",
                    659,
                    "at least six kinds of tiles that can improve the scores",
                ),
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
            Self::NotDealer
            | Self::BadWait
            | Self::NoExtraHan
            | Self::FewLiveWinningTiles
            | Self::GenbutsuWait
            | Self::MiddleWait
            | Self::Mangan
            | Self::HanemanPlus
            | Self::EarlyTurn
            | Self::ImprovingHand => None,
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
            Self::NeedsDora => "needs_dora",
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
            // The book lists placement pressure as a reason on its own, without
            // the 1-away requirement of the first two conditions.
            Self::NeedsDora => RuleText {
                rule: "A hand that is not close to ready can still justify the Kan when                        its extra draw, dora, and minipoints are needed to improve the                        placement.",
                quote: "you need more dora or minipoints to improve the placement \
                        (especially in South-4)",
                citation: ch9(369, "improve the placement"),
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
    state
        .ukeire_tiles
        .first()
        .map(|code| format_tile_for_display(code, false))
        .unwrap_or_default()
}

/// Every winning tile, for the multi-tile waits of standard hands.
fn wait_tiles(state: &GameState) -> String {
    if state.ukeire_tiles.is_empty() {
        return "no live winning tiles".to_string();
    }
    state
        .ukeire_tiles
        .iter()
        .map(|code| format_tile_for_display(code, false))
        .collect::<Vec<_>>()
        .join(" / ")
}

fn applies_riichi(trigger: RiichiTrigger, state: &GameState) -> String {
    let wait = wait_tile(state);
    match trigger {
        RiichiTrigger::Dealer => "You are the dealer (East).".to_string(),
        RiichiTrigger::HasExtraHan => {
            "The finished hand scores at least one han without Riichi.".to_string()
        }
        RiichiTrigger::GoodWait => format!(
            "The wait on {} is good: at least two live kinds and more than four live tiles.",
            wait_tiles(state)
        ),
        RiichiTrigger::ThreeLiveWinningTiles => format!(
            "The wait on {} is bad, but three or more winning tiles are left in the board.",
            wait_tiles(state)
        ),
        RiichiTrigger::HonorTerminalWait => format!(
            "The wait on {} is a bad wait on an honor or terminal tile, so one or two \
             live tiles are enough.",
            wait_tiles(state)
        ),
        RiichiTrigger::Tanyao => "Every pair and the wait are simples.".to_string(),
        RiichiTrigger::RedFiveWait => {
            format!("The wait is {wait} and its red five is in hand.")
        }
        RiichiTrigger::SujiTrap => "A suji of the wait is already in your river.".to_string(),
        RiichiTrigger::ImmediateSujiTrap => {
            let discard = state
                .correct_action
                .tile()
                .map(|code| format_tile_for_display(code, false))
                .unwrap_or_default();
            format!(
                "Discarding {discard} makes the wait {wait} a suji tile of the declaration \
                 tile, so the opponents read it as safe."
            )
        }
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
        DamaReason::BadWait => format!(
            "The wait on {} is bad: fewer than two live kinds or at most four live tiles.",
            wait_tiles(state)
        ),
        DamaReason::NoExtraHan => {
            "The hand has no yaku or dora without Riichi, so it is riichi-only.".to_string()
        }
        DamaReason::FewLiveWinningTiles => format!(
            "The wait on {} has only one or two live simple winning tiles.",
            wait_tiles(state)
        ),
        DamaReason::GenbutsuWait => {
            let waits: Vec<Tile> = state
                .ukeire_tiles
                .iter()
                .filter_map(|code| Tile::try_from(code.as_str()).ok())
                .collect();
            let threat_read = state
                .players
                .iter()
                .find(|player| player.is_riichi)
                .and_then(|threat| {
                    SafetyFacts::from_state(state, threat.seat).map(|facts| {
                        let genbutsu: Vec<String> = waits
                            .iter()
                            .filter(|tile| facts.is_genbutsu(**tile))
                            .map(|tile| format_tile_for_display(&tile.to_string(), false))
                            .collect();
                        (threat, genbutsu)
                    })
                });
            match threat_read {
                Some((threat, genbutsu)) if !genbutsu.is_empty() => format!(
                    "{} is genbutsu for {} (in Riichi), so the players folding to that \
                     threat throw your winning tile.",
                    genbutsu.join(" / "),
                    threat.name
                ),
                _ => "One of the winning tiles is the threatening player's genbutsu.".to_string(),
            }
        }
        DamaReason::NoTanyao => "A terminal or honor pair rules out tanyao.".to_string(),
        DamaReason::MiddleWait => format!("The wait is {wait}, a middle tile."),
        DamaReason::NoRedFiveWait => "No red five is held.".to_string(),
        DamaReason::NoSujiTrap => "Your river holds no suji of the wait.".to_string(),
        DamaReason::Mangan => "The hand is already mangan without Riichi.".to_string(),
        DamaReason::HanemanPlus => {
            "Even the worst winning tile gives haneman or better without Riichi.".to_string()
        }
        DamaReason::EarlyTurn => {
            let discards = human(state).map_or(0, |player| player.discards.len());
            format!(
                "Only {discards} discards are in your river, so this is turn {} of the \
                 early turns the box names.",
                discards + 1
            )
        }
        DamaReason::ImprovingHand => {
            let turn = human(state).map_or(0, |player| player.discards.len() + 1);
            format!(
                "It is only the {turn}th turn and the ready hand has at least six kinds \
                 of draws that raise its score or improve its wait."
            )
        }
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
        ShouminkanTrigger::NeedsDora => format!(
            "{} shanten; the Kan is for the extra draw, minipoints, and dora, not the wait.",
            state.shanten
        ),
    }
}

fn summary_for(state: &GameState) -> String {
    if !state.shouminkan_triggers.is_empty() {
        return "Upgrade the open Pon to an Added Kan: the book's kakan criteria pick this \
                hand."
            .to_string();
    }
    if state.category == "riichi_judgement" {
        return if state.riichi_triggers.is_empty() {
            "Stay in dama: the hand is riichi-only with a bad wait, and you are not the \
             dealer."
                .to_string()
        } else {
            "Declare Riichi: at least one of the book's three conditions holds.".to_string()
        };
    }
    if state.category == "dama_bad_wait" {
        return if state
            .riichi_triggers
            .contains(&RiichiTrigger::ThreeLiveWinningTiles)
        {
            "Declare Riichi: the bad wait still has three or more live winning tiles.".to_string()
        } else if state
            .riichi_triggers
            .contains(&RiichiTrigger::HonorTerminalWait)
        {
            "Declare Riichi: the bad wait is on an honor or terminal tile, which the \
             book calls riichi even with one live tile left."
                .to_string()
        } else {
            "Stay in dama: the bad wait has only one or two live simple winning tiles.".to_string()
        };
    }
    if state.category == "dama_genbutsu_wait" {
        return "Stay in dama: one of your winning tiles is the threatening player's \
                genbutsu, so the players folding to that threat discard exactly that tile."
            .to_string();
    }
    if state.category == "suji_trap_riichi" {
        return "Declare Riichi on the trap discard: it leaves the same wait as the plain \
                discard, but makes the winning tile a suji of the declaration tile, so the \
                opponents read it as safe."
            .to_string();
    }
    if state.category == "dama_expensive_hand" {
        return if state.dama_reasons.contains(&DamaReason::HanemanPlus) {
            "Stay in dama: even the worst winning tile gives haneman or better without \
             Riichi, so the book does not declare."
                .to_string()
        } else {
            "Stay in dama: the hand is already worth at least 7700 without Riichi, so \
             the declaration would only warn the table."
                .to_string()
        };
    }
    if state.category == "dama_improving_hand" {
        return "Stay in dama: it is still an early turn, and the ready hand has at least \
                six kinds of draws that improve its score or its wait, so the book waits \
                for one of them."
            .to_string();
    }
    if !state.riichi_triggers.is_empty() {
        return "Declare Riichi: the book's chiitoitsu criteria pick this hand.".to_string();
    }
    "Stay in dama: the book keeps this chiitoitsu hand concealed.".to_string()
}

fn caveats_for(state: &GameState) -> Vec<String> {
    let mut caveats = Vec::new();

    if state.category == "riichi_judgement" {
        if !state.dama_reasons.is_empty() {
            caveats.push(
                "A riichi-only hand in dama can only win by tsumo; the book's rule still \
                 keeps this bad-wait non-dealer hand concealed."
                    .to_string(),
            );
        }
        caveats.push(
            "This lesson encodes only ch. 7's general three-condition rule. The later \
             dama cases (a 1-2 tile bad wait, being in the lead, a genbutsu wait, and a \
             hand already worth 7700+) are not modelled, so the generator avoids them."
                .to_string(),
        );
    } else if state.category == "dama_bad_wait" {
        caveats.push(
            "The other ch. 7 conditions are held fixed: the hand is riichi-only, you are \
             not the dealer, and the wait is a bad shape with at most four live tiles. \
             Only the bad-wait box's live winning-tile count decides, counted from the \
             tiles you can see."
                .to_string(),
        );
        if !state.dama_reasons.is_empty() {
            caveats.push(
                "A riichi-only hand in dama can only win by tsumo; the box still keeps \
                 this one or two tile wait concealed."
                    .to_string(),
            );
        }
    } else if state.category == "dama_genbutsu_wait" {
        caveats.push(
            "The threat is shown as a Riichi declaration, the chapter's first example of \
             a player everyone is watching. The general three-condition rule would still \
             pick Riichi here (this hand has a han and a good wait); the genbutsu-wait \
             section is the exception that keeps it concealed."
                .to_string(),
        );
        caveats.push(
            "The book only respects a loud player whose call is actually being feared: \
             against a bad call that nobody folds to, it says to declare Riichi even when \
             your winning tiles are that player's genbutsu (ch7:566)."
                .to_string(),
        );
    } else if state.category == "dama_improving_hand" {
        caveats.push(
            "The count comes from the ready hand's shape: the han without Riichi (with the \
             table's dora) and the theoretical four-copies wait. The generator keeps every \
             counted kind live, so the table never shows an improving tile in a river."
                .to_string(),
        );
        caveats.push(
            "The book stops preferring dama after the 9th turn: 'After passing the 9th turn \
             (the midpoint of the middle row of your discards), you'd better call riichi even \
             if the second condition is met' (ch7:665). This table keeps every river at seven \
             discards or fewer."
                .to_string(),
        );
        caveats.push(
            "Either single can be the tanki, so both tanki discards are graded as the same \
             answer; the count is verified for both kept hands."
                .to_string(),
        );
    } else if state.category == "dama_expensive_hand" {
        caveats.push(
            "The value is recomputed at the worst winning tile of the wait, counted by \
             ron and without Riichi: the book asks for at least 7700 (5200 without red \
             fives). Dora and a red five supply the value here, on top of tanyao, pinfu \
             and iipeikou."
                .to_string(),
        );
        caveats.push(
            "The book still allows Riichi with an expensive hand when you are far behind, \
             or early enough with a good enough wait. This table puts you in front and \
             past the 6th turn, so those exceptions do not apply."
                .to_string(),
        );
    } else if !state.dama_reasons.is_empty() {
        caveats.push(
            "The book's second dama case is specifically honitsu/chinitsu chiitoitsu; this \
             trainer uses a mangan-or-better test instead."
                .to_string(),
        );
        caveats.push(
            "The book's cut-point is 5200/7700 without Riichi; this hand is above it.".to_string(),
        );
    }

    if state.category == "suji_trap_riichi" {
        caveats.push(
            "The two candidate discards leave the same wait and the same number of live \
             winning tiles; the trap is the only difference, so the lesson is the discard \
             rather than the declaration."
                .to_string(),
        );
        caveats.push(
            "Suji defense only works against side waits, so a trap pays off exactly when \
             the opponents read the wait as a ryanmen: ch. 7's \"Trap waits\" calls this \
             factor a reason the hand is not automatically a bad-wait dama (ch7:512), not \
             a guarantee that the tile is thrown."
                .to_string(),
        );
    }

    if state.category == "chiitoitsu_riichi_vs_dama" {
        if state.equivalent_tiles.is_empty() {
            caveats.push(
                "The draw completed the sixth pair, leaving the red five as the kept wait. \
                 The book's red-five reason only holds while the red five is in hand, and \
                 throwing it away gives up a dora, so the only accepted discard is the other \
                 lone tile."
                    .to_string(),
            );
        } else {
            caveats.push(
                "The draw completed the sixth pair, so two lone tiles remain. Either can be \
                 discarded: both leave a seven-pairs tenpai on the other, and this hand is \
                 generated so the Riichi/dama judgement is the same for either wait. Both \
                 tiles are graded as correct, which keeps the lesson on the declaration."
                    .to_string(),
            );
        }
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
        "riichi_judgement" => Some(ch7(GENERAL_RULE, 55, "at least one")),
        "dama_bad_wait" => Some(ch7("Bad wait", 521, "three or more winning tiles")),
        "dama_genbutsu_wait" => Some(ch7(
            "Genbutsu wait",
            539,
            "one of your winning tiles is among their",
        )),
        "suji_trap_riichi" => Some(ch8("Suji trap", 170, "immediate {\\jap suji}-trap riichi")),
        "dama_expensive_hand" => Some(ch7("High scoring hand", 569, "it is OK to go {\\jap dama}")),
        "dama_improving_hand" => Some(ch7(
            "Many possibilities of improving the hand",
            723,
            "14 kinds--49 tiles",
        )),
        "shouminkan_decision" => Some(ch9(360, "From an open set to an open quad")),
        "ankan_decision" => Some(ch9_ankan(269, "needs to be close to ready")),
        "meld_or_not" => Some(ch9_meld(72, "Don't meld with a cheap and slow hand")),
        "daiminkan_decision" => Some(ch9_daiminkan(321, "You can make an open quad")),
        "wind_discard_order" => Some(ch9_seating(455, "discard the right player's wind first")),
        "ryanmen_protorun" => Some(ch4(44, "completely redundant")),
        "nakabukure_ready" => Some(ch3_bulging(681, "accept four kinds of tiles")),
        "protorun_priority" => Some(ch3(205, "can accept twice as many tiles")),
        "ryankan_break" => Some(ch3_ryankan(523, "break the double closed shape")),
        "pair_count" => Some(ch3_pairs(
            336,
            "we should avoid having three pairs in a hand",
        )),
        "pair_count_open" => Some(ch3_pairs(
            351,
            "having three pairs is actually better than having two pairs",
        )),
        "defense_safety_chart" => Some(ch8(CH8_RANKING, 292, "Safety ranking")),
        "fold_to_riichi" => Some(ch8(
            CH8_VS_RIICHI,
            340,
            "If you cannot satisfy the above criteria",
        )),
        "suji_kabe_safety" => Some(ch8(CH8_RANKING, 292, "Safety ranking")),
        "defense_stuck_heuristic" => {
            Some(ch8(CH8_STUCK, 344, "What to discard when you get stuck"))
        }
        "push_or_fold" => Some(ch8(
            CH8_PUSH_FOLD,
            23,
            "Push} if {\\bf two} of the following conditions are met",
        )),
        "open_hand_defense" => Some(ch8(
            CH8_CHII_DISCARD,
            567,
            "discard a tile in the same suit",
        )),
        "pinfu_head" => Some(ch5_pinfu_head(
            449,
            "the head must be a pair of number tiles or valueless wind tiles",
        )),
        _ => None,
    }
}

/// Lessons whose rule is not carried by a trigger enum.
fn category_rationale(state: &GameState) -> Option<BookRationale> {
    if let Some(defense) = defense_rationale(state) {
        return Some(defense);
    }
    if let Some(fold) = fold_to_riichi_rationale(state) {
        return Some(fold);
    }
    if let Some(open_hand) = open_hand_defense_rationale(state) {
        return Some(open_hand);
    }
    if let Some(push_fold) = push_or_fold_rationale(state) {
        return Some(push_fold);
    }

    if state.category == "wind_discard_order" {
        return wind_discard_rationale(state);
    }

    if state.category == "pinfu_head" {
        return pinfu_head_rationale(state);
    }

    if state.category == "meld_or_not" {
        return meld_or_not_rationale(state);
    }

    if state.category == "daiminkan_decision" {
        return daiminkan_rationale(state);
    }

    if state.category == "ankan_decision" {
        return ankan_rationale(state);
    }

    // `shouminkan_decline` is retired as a scenario id, but old saved reports
    // still carry it as their category. Accept it here so re-importing one keeps
    // the book side of its verdict instead of losing its rationale.
    if matches!(
        state.category.as_str(),
        "shouminkan_decision" | "shouminkan_decline"
    ) && state.correct_action.action_type() == CorrectActionType::Discard
    {
        let tile = format_tile_for_display(state.correct_action.tile().unwrap_or_default(), false);

        return Some(BookRationale {
            summary: "Keep the Pon and discard: the book's kakan conditions are not met."
                .to_string(),
            rules: vec![BookRule {
                id: "decline_kakan".to_string(),
                rule: "Extending an open Pon needs the hand to be 1-away or better with a \
                       good wait and two han, or another stated reason. A 2-away hand with \
                       its value already secured keeps the Pon."
                    .to_string(),
                quote: "since it is 2-away from ready, calling kan on zhong is not justifiable"
                    .to_string(),
                citation: ch9(391, "2-away from ready"),
                applies: format!(
                    "The hand is {} shanten with its value already secured, so discarding {} \
                     is the safe play.",
                    state.shanten, tile
                ),
            }],
            absent: Vec::new(),
            source: ch9(360, "From an open set to an open quad"),
            caveats: vec![
                "Extending an open Pon also risks chankan (Robbing the Kong).".to_string(),
            ],
        });
    }

    if state.category == "nakabukure_ready" {
        let answer_code = state.correct_action.tile().unwrap_or_default();
        let answer_tile = Tile::try_from(answer_code).ok();
        let discard = format_tile_for_display(answer_code, false);
        let wait = state
            .ukeire_tiles
            .first()
            .map(|code| format_tile_for_display(code, false))
            .unwrap_or_default();
        let drawn = human(state)
            .and_then(|player| player.draw.as_deref())
            .map(|code| format_tile_for_display(code, false))
            .unwrap_or_default();

        // The generator builds exactly one bulging float; its middle tile is
        // the discard that breaks it. An imported report from before the
        // variants existed may hold more, so look the answer up by value.
        let middles = bulge_middles(state);
        let answer_is_middle = answer_tile.is_some_and(|answer| middles.contains(&answer));
        let middle = middles.first().copied();
        let middle_text = middle
            .map(|tile| format_tile_for_display(&tile.to_string(), false))
            .unwrap_or_default();
        let middle_acceptance = middle
            .and_then(|tile| acceptance_without(state, tile))
            .unwrap_or_default();
        let keeps_bulge = !answer_is_middle && middle.is_some();

        if keeps_bulge {
            // ch. 4 Answer 13 / ch. 3's 2-away example: the book keeps the
            // float because every rival block is weak, and throws a tile that
            // costs the least shape even though breaking the bulge accepts
            // more tiles right now.
            let rules = vec![
                BookRule {
                    id: "keep_until_one_away".to_string(),
                    rule: "The bulging float is protected while the hand is far from ready; \
                           at 1-away whether it stays is a judgement about the rival blocks."
                        .to_string(),
                    quote: "Try to keep a bulging float shape until a hand becomes 1-away."
                        .to_string(),
                    citation: ch3_bulging(708, "until a hand becomes 1-away"),
                    applies: format!(
                        "The hand is {} shanten and every rival block is still only a pair plus \
                         a float or a closed wait, so the bulge is the best block left.",
                        state.shanten
                    ),
                },
                BookRule {
                    id: "keep_the_bulge".to_string(),
                    rule: "Breaking the bulge raises raw acceptance but fills the hand with \
                           closed-wait protoruns, so the book throws the tile that costs the \
                           least shape instead."
                        .to_string(),
                    quote: "Although doing so increases tile acceptance temporarily, the hand \
                            will be filled with closed-wait protoruns."
                        .to_string(),
                    citation: ch3_bulging(690, "increases tile acceptance temporarily"),
                    applies: format!(
                        "Discarding {discard} keeps the bulge; breaking it with {middle_text} \
                         would accept {middle_acceptance} tiles right now, against the {} this \
                         discard leaves. The book still keeps the float: raw acceptance is not \
                         the whole question when the rival blocks are weak.",
                        state.ukeire_total
                    ),
                },
                BookRule {
                    id: "keep_the_bulge_as_back_up".to_string(),
                    rule: "When a rival block is only a pair plus a float, the book keeps the \
                           bulging float as a back-up for two runs and discards the rival pair's \
                           spare tile."
                        .to_string(),
                    quote: "we should keep two tong4 to maintain the bulging float block in \
                            pinzu (dots) for now, hoping to get two runs out of it. We should \
                            thus discard suo2."
                        .to_string(),
                    citation: ch4_blocks(694, "hoping to get two runs out of it"),
                    applies: format!(
                        "Discarding {discard} leaves the rival pair's partner beside the draw as \
                         a side-wait protorun and keeps the whole bulge."
                    ),
                },
            ];

            return Some(BookRationale {
                summary: format!(
                    "Keep the bulging float: the hand is {} shanten and the rival blocks are \
                     weak, so the float is still the best block. Breaking it would accept \
                     {middle_acceptance} tiles right now, more than keeping it, but the book \
                     discards {discard} and keeps the two-run shape.",
                    state.shanten
                ),
                rules,
                absent: Vec::new(),
                source: ch3_bulging(708, "until a hand becomes 1-away"),
                caveats: vec![
                    "The book's 1-away examples disagree on purpose: with a weak rival block it \
                     keeps the bulge (ch4:694), and with a decent rival block it breaks it \
                     (ch4:725). Counting acceptance alone picks the wrong answer in the first \
                     case."
                        .to_string(),
                ],
            });
        }

        if state.shanten == 0 {
            // ch. 3's ready-hand example: the bulge waits on a tile the hand
            // already holds twice, so it is the discard.
            let rules = vec![
                BookRule {
                    id: "bulge_pair_wait".to_string(),
                    rule: "A bulging float left in a ready hand waits on its own middle tile, \
                           which the hand already holds twice, so only two winning tiles remain."
                        .to_string(),
                    quote:
                        "It is waiting for wan4, but we are already using two of it in the hand, \
                            leaving only two winning tiles."
                            .to_string(),
                    citation: ch3_bulging(702, "leaving only two winning tiles"),
                    applies: format!(
                        "Keeping the bulge and discarding {drawn} would wait on {discard}, which \
                         this hand holds twice: only two winning tiles."
                    ),
                },
                BookRule {
                    id: "discard_the_bulge".to_string(),
                    rule:
                        "In a ready hand the bulge tile itself is the discard: dropping it leaves \
                           the lone honour as a tanki wait with strictly more winning tiles."
                            .to_string(),
                    quote: "We should rather discard wan4 to wait for bei.".to_string(),
                    citation: ch3_bulging(702, "We should rather discard"),
                    applies: format!(
                        "Discarding {discard} waits on {wait} instead: {} live copies against the \
                         two the bulge would leave.",
                        state.ukeire_total
                    ),
                },
                BookRule {
                    id: "keep_until_one_away".to_string(),
                    rule: "The bulging float's value is in building a side-wait protorun, so the \
                           book keeps it only until the hand is 1-away."
                        .to_string(),
                    quote: "Try to keep a bulging float shape until a hand becomes 1-away."
                        .to_string(),
                    citation: ch3_bulging(708, "until a hand becomes 1-away"),
                    applies: "This hand is already ready, so the shape's protection has expired."
                        .to_string(),
                },
            ];

            return Some(BookRationale {
                summary: "Drop the bulging float: in a ready hand it waits on its own middle tile \
                          for only two tiles, while the lone honour has three live copies."
                    .to_string(),
                rules,
                absent: Vec::new(),
                source: ch3_bulging(681, "accept four kinds of tiles"),
                caveats: vec![
                    "The book's ready-hand example is closed; this trainer opens a Yakuhai Pon so \
                     Riichi cannot mask the discard lesson."
                        .to_string(),
                ],
            });
        }

        // ch. 4 Exercise 14: a 1-away hand whose rival block became decent, so
        // the same book now breaks the bulge.
        let rules = vec![
            BookRule {
                id: "rival_block_became_decent".to_string(),
                rule: "A rival block that accepts four kinds to become a group and the head is \
                       now a better block than the bulging float, so the bulge is the redundant \
                       tile."
                    .to_string(),
                quote: "As we drew another wan1, the block in manzu (cracks) is now a decent \
                        shape. This can become one group and the head with a draw of wan1 wan2 \
                        wan4 wan5."
                    .to_string(),
                citation: ch4_blocks(725, "This can become one group and the head with a draw of"),
                applies: format!(
                    "Discarding {discard} breaks the bulge but keeps the decent rival block, and \
                     the hand still accepts {} tiles: more than any keep-the-bulge discard.",
                    state.ukeire_total
                ),
            },
            BookRule {
                id: "keep_until_one_away".to_string(),
                rule: "The bulging float is kept only until the hand is 1-away, when a completed \
                       rival block can take its place."
                    .to_string(),
                quote: "Try to keep a bulging float shape until a hand becomes 1-away.".to_string(),
                citation: ch3_bulging(708, "until a hand becomes 1-away"),
                applies: "This hand is 1-away, so the shape's protection has expired.".to_string(),
            },
            BookRule {
                id: "break_the_bulge".to_string(),
                rule: "The bulge breaks into one complete run plus a float, so keeping the rival \
                       block is worth more than the float's two-run potential."
                    .to_string(),
                quote: "Therefore, we should discard tong4 to break the bulging float shape."
                    .to_string(),
                citation: ch4_blocks(725, "break the bulging float shape"),
                applies: format!(
                    "Discarding {discard} leaves the hand with the rival block and {} tiles of \
                     acceptance; keeping the bulge would accept fewer.",
                    state.ukeire_total
                ),
            },
        ];

        return Some(BookRationale {
            summary: format!(
                "Break the bulging float: the rival block became a decent group-and-head shape, \
                 so discarding {discard} keeps it and still accepts more tiles than keeping the \
                 bulge would."
            ),
            rules,
            absent: Vec::new(),
            source: ch4_blocks(725, "break the bulging float shape"),
            caveats: vec![
                "This is the same shape the 1-away keep hand preserves (ch4:694); the difference \
                 is the rival block, not the bulge itself."
                    .to_string(),
            ],
        });
    }

    if state.category == "protorun_priority" {
        let discard =
            format_tile_for_display(state.correct_action.tile().unwrap_or_default(), false);
        let equivalent = state
            .equivalent_tiles
            .first()
            .map(|code| format_tile_for_display(code, false))
            .unwrap_or_default();
        let waits = wait_tiles(state);
        let drawn = human(state)
            .and_then(|player| player.draw.as_deref())
            .map(|code| format_tile_for_display(code, false))
            .unwrap_or_else(|| discard.clone());

        let rules = vec![
            BookRule {
                id: "side_wait_acceptance".to_string(),
                rule: "A side-wait (ryanmen) protorun accepts 2 kinds--8 tiles, while a \
                       closed-wait (kanchan) protorun accepts only 1 kind--4 tiles. A hand with \
                       one block too many therefore gives up the closed wait."
                    .to_string(),
                quote: "a side-wait (ryanmen) protorun can accept twice as many tiles as a \
                        closed-wait (kanchan) protorun or an edge-wait (penchan) protorun can."
                    .to_string(),
                citation: ch3(205, "can accept twice as many tiles"),
                applies: format!(
                    "Discarding {discard} keeps both side waits live ({waits}): {} tiles, \
                     against the 12 a side-wait discard would leave with the closed wait.",
                    state.ukeire_total
                ),
            },
            BookRule {
                id: "protorun_ranking".to_string(),
                rule: "The book ranks the two-tile protoruns side wait > closed wait > edge wait, \
                       so the closed wait is the cheapest block to break."
                    .to_string(),
                quote: "side wait > closed wait > edge wait".to_string(),
                citation: ch3(230, "side wait > closed wait > edge wait"),
                applies: format!(
                    "The hand holds two side waits and one closed wait ({discard} / {equivalent}), \
                     so the closed wait is the block the ranking discards. Whichever of the two \
                     tiles is dropped, the other becomes a lone float outside every wait, so both \
                     discards leave the same 1-away shape and the same {} live tiles ({waits}).",
                    state.ukeire_total
                ),
            },
            BookRule {
                id: "closed_wait_ceiling".to_string(),
                rule: "Even the most versatile closed waits (35, 46, 57) accept half of what any \
                       side wait accepts, so which closed wait it is never closes the gap."
                    .to_string(),
                quote: "35, 46, 57 > 13, 24, 68, 79".to_string(),
                citation: ch3(263, "35, 46, 57 > 13, 24, 68, 79"),
                applies: concat!(
                    "The closed wait's single completion is worth 4 tiles; ",
                    "each side wait's two completions are worth 8."
                )
                .to_string(),
            },
        ];

        return Some(BookRationale {
            summary: format!(
                "Break the closed-wait protorun: a side wait accepts twice as many tiles, so \
                 losing the closed wait keeps both 8-tile waits alive. {discard} and {equivalent} \
                 are the same discard: either one leaves the same {} live tiles, so the grader \
                 accepts both.",
                state.ukeire_total
            ),
            rules,
            absent: Vec::new(),
            source: ch3(205, "can accept twice as many tiles"),
            caveats: vec![format!(
                "The closed-wait protorun is {discard} / {equivalent}. Discarding either tile \
                 leaves the other as a lone float, so the shape and the {}-tile acceptance are \
                 identical. The state names {drawn} because that is the tile you drew (the draw \
                 that completed the closed wait); the other tile is graded as equal.",
                state.ukeire_total
            )],
        });
    }

    if state.category == "ryankan_break" {
        let discard = state.correct_action.tile().unwrap_or_default().to_string();
        let waits = state.ukeire_tiles.join(" / ");
        let drawn = human(state)
            .and_then(|player| player.draw.clone())
            .unwrap_or_default();

        let rules = vec![
            BookRule {
                id: "ryankan_definition".to_string(),
                rule: "A double closed (ryankan) shape is two closed-wait protoruns \
                       sharing a tile (135, 246, ... 579). It accepts two kinds--eight \
                       tiles, twice an isolated closed wait."
                    .to_string(),
                quote: "When two closed-wait protoruns are combined, we have a double \
                        closed (ryankan) shape."
                    .to_string(),
                citation: ch3_ryankan(477, "two closed-wait protoruns are combined"),
                applies: format!(
                    "The hand holds a ryankan; discarding {discard} breaks it into one \
                     closed wait."
                ),
            },
            BookRule {
                id: "ryankan_gets_worse".to_string(),
                rule: "The ryankan takes three tiles even though it is not a complete \
                       group, so as the hand nears ready it becomes a single closed-wait \
                       protorun. It is only strong when the hand is 2-away or worse."
                    .to_string(),
                quote: "it will ultimately become a single closed-wait protorun when this \
                        block remains incomplete when the hand is ready."
                    .to_string(),
                citation: ch3_ryankan(506, "single closed-wait protorun"),
                applies: "This hand is already 1-away, so the shape's three-tile cost is \
                          no longer worth paying."
                    .to_string(),
            },
            BookRule {
                id: "keep_the_new_side_wait".to_string(),
                rule: "When a draw next to the head creates a side-wait protorun, keep \
                       that protorun and break the ryankan instead."
                    .to_string(),
                quote: "when we draw a tile next to the head, creating a side-wait \
                        protorun, we should keep it and break the double closed shape \
                        instead."
                    .to_string(),
                citation: ch3_ryankan(523, "break the double closed shape"),
                applies: format!(
                    "The draw {drawn} sits next to the head. Discarding {discard} keeps the \
                     new side wait and the hand's acceptance ({waits})."
                ),
            },
        ];

        return Some(BookRationale {
            summary: "Break the double closed shape: the drawn tile gives the head a side \
                      wait, and leaving the ryankan intact would make every completion a \
                      closed wait."
                .to_string(),
            rules,
            absent: Vec::new(),
            source: ch3_ryankan(523, "break the double closed shape"),
            caveats: vec![
                "The book's example is closed; this trainer opens a Yakuhai Pon so Riichi \
                 cannot mask the discard lesson."
                    .to_string(),
                "Only the low ryankan terminal keeps the side wait. The high ryankan \
                 terminal leaves closed waits only, so it is not graded as an equivalent \
                 discard."
                    .to_string(),
            ],
        });
    }

    if state.category == "pair_count_open" {
        let answer_code = state.correct_action.tile()?;
        let answer = format_tile_for_display(answer_code, false);
        let answer_tile = Tile::try_from(answer_code).ok()?;
        let target_code = dragon_pair(state)?;
        let target = format_tile_for_display(&target_code, false);
        let target_tile = Tile::try_from(target_code.as_str()).ok()?;
        let drawn = human(state)
            .and_then(|player| player.draw.clone())
            .unwrap_or_default();
        let drawn_display = format_tile_for_display(&drawn, false);
        let drawn_tile = Tile::try_from(drawn.as_str()).ok();
        let pairs = pair_codes(state)
            .iter()
            .map(|code| format_tile_for_display(code, false))
            .collect::<Vec<_>>()
            .join(" / ");
        let remaining_pairs = pair_codes(state)
            .iter()
            .filter(|code| code.as_str() != target_code)
            .map(|code| format_tile_for_display(code, false))
            .collect::<Vec<_>>()
            .join(" / ");

        // The closed oracle and the Pon-aware comparison, both from the state
        // so an imported report shows the same numbers.
        let answer_closed = state.ukeire_total;
        let rival_closed = drawn_tile
            .and_then(|tile| acceptance_without(state, tile))
            .unwrap_or_default();
        let answer_pon = pon_acceptance(state, answer_tile, target_tile).unwrap_or_default();
        let rival_pon = drawn_tile
            .and_then(|tile| pon_acceptance(state, tile, target_tile))
            .unwrap_or_default();
        let live = live_target_copies(state, &target_code);

        let rules = vec![
            BookRule {
                id: "three_pairs_when_ponning".to_string(),
                rule: "A closed hand avoids three pairs, but a hand that intends to Pon \
                       wants them: the call will consume one pair and leave two."
                    .to_string(),
                quote: "When we intend to call {\\jap pon}, having three pairs is actually \
                        better than having two pairs."
                    .to_string(),
                citation: ch3_pairs(
                    351,
                    "having three pairs is actually better than having two pairs",
                ),
                applies: format!(
                    "You hold a {target} pair to Pon; discarding {answer} keeps all three \
                     pairs, the hand's {pairs}."
                ),
            },
            BookRule {
                id: "two_pairs_after_pon".to_string(),
                rule: "The Pon turns one pair into a set, so the hand becomes a two-pair \
                       hand, the strongest count a closed hand can carry."
                    .to_string(),
                quote: "the hand will become a two-pair hand after we call {\\jap pon} once"
                    .to_string(),
                citation: ch3_pairs(351, "two-pair hand after we call"),
                applies: format!(
                    "After the Pon the kept pairs are {remaining_pairs}, and the hand still \
                     accepts {answer_pon} tiles; breaking a pair now leaves {rival_pon}."
                ),
            },
            BookRule {
                id: "closed_arithmetic".to_string(),
                rule: "The closed-hand rule still charges the third pair for the protorun it \
                       replaces. The open-hand caveat flips the choice, so the comparison is \
                       shown rather than asserted."
                    .to_string(),
                quote: "The net tile acceptance gain will be negative".to_string(),
                citation: ch3_pairs(331, "The net tile acceptance gain will be negative"),
                applies: format!(
                    "Closed, the pair break accepts {rival_closed} tiles and the book's \
                     discard {answer_closed}; the Pon's {live} live {target} copies are the \
                     value that reverses it."
                ),
            },
            BookRule {
                id: "keep_the_side_wait".to_string(),
                rule: "The discard comes from the closed wait, not the side wait: a side-wait \
                       protorun accepts twice as many tiles."
                    .to_string(),
                quote: "a side-wait (ryanmen) protorun can accept twice as many tiles as a \
                        closed-wait (kanchan) protorun"
                    .to_string(),
                citation: ch3(205, "can accept twice as many tiles"),
                applies: format!(
                    "Discarding {answer} breaks the closed wait and keeps the side wait; \
                     discarding the drawn {drawn_display} would break the third pair instead."
                ),
            },
        ];

        return Some(BookRationale {
            summary: format!(
                "Keep three pairs: the {target} pair is a planned Pon, so discard {answer} \
                 and let the call leave two pairs."
            ),
            rules,
            absent: Vec::new(),
            source: ch3_pairs(
                351,
                "having three pairs is actually better than having two pairs",
            ),
            caveats: vec![
                "The hand is still closed at the decision, so this is graded as an ordinary \
                 discard. The planned Pon is stated in the scenario note rather than shown as \
                 a call."
                    .to_string(),
                format!(
                    "Discarding the redundant float first is graded as the same answer: it \
                     discards the same two tiles in the other order. The book names {answer} \
                     because keeping both floats gives a choice after the Pon."
                ),
                "This is the open-hand companion of `pair_count`, which grades the opposite \
                 discard. The numbers above show the closed oracle preferring that line; the \
                 book's open-hand caveat is what reverses it."
                    .to_string(),
            ],
        });
    }

    if state.category == "pair_count" {
        let discard =
            format_tile_for_display(state.correct_action.tile().unwrap_or_default(), false);
        let pairs = pair_codes(state)
            .iter()
            .map(|code| format_tile_for_display(code, false))
            .collect::<Vec<_>>()
            .join(" / ");
        let drawn = human(state)
            .and_then(|player| player.draw.as_deref())
            .map(|code| format_tile_for_display(code, false))
            .unwrap_or_default();
        let rival = pair_twin(state);
        let rival_text = rival
            .map(|tile| format_tile_for_display(&tile.to_string(), false))
            .unwrap_or_else(|| "the side wait".to_string());
        let rival_acceptance = rival
            .and_then(|tile| acceptance_without(state, tile))
            .unwrap_or_default();

        let rules = vec![
            BookRule {
                id: "avoid_three_pairs".to_string(),
                rule: "A closed hand should avoid holding three pairs: the third pair is \
                       the weakest shape a closed hand can carry."
                    .to_string(),
                quote: "we should avoid having three pairs in a hand".to_string(),
                citation: ch3_pairs(336, "we should avoid having three pairs in a hand"),
                applies: format!("The draw {drawn} made a third pair, so the hand holds {pairs}."),
            },
            BookRule {
                id: "pair_count_ranking".to_string(),
                rule: "Two pairs are the strongest count a closed hand can hold, so the \
                       third pair is the one to give up."
                    .to_string(),
                quote: "2 pairs > 1 pair, 4 pairs > 3 pairs".to_string(),
                citation: ch3_pairs(343, "2 pairs > 1 pair, 4 pairs > 3 pairs"),
                applies: format!(
                    "Discarding {discard} leaves two pairs, which the book ranks above the \
                     three this hand can hold."
                ),
            },
            BookRule {
                id: "pair_or_protorun".to_string(),
                rule: "Keeping the new pair gains two tiles, but it costs the side wait it \
                       was drawn from, which accepts eight. The trade loses six tiles, so \
                       the pair goes and the protorun stays."
                    .to_string(),
                quote: "The net tile acceptance gain will be negative".to_string(),
                citation: ch3_pairs(331, "The net tile acceptance gain will be negative"),
                applies: format!(
                    "Discarding {discard} keeps {answer_total} improving tiles; keeping three \
                     pairs by discarding {rival_text} leaves {rival_acceptance}.",
                    answer_total = state.ukeire_total
                ),
            },
        ];

        return Some(BookRationale {
            summary: format!(
                "Break the pair: keeping three pairs trades the side wait's eight tiles for \
                 the new pair's two, so discard {discard}."
            ),
            rules,
            absent: Vec::new(),
            source: ch3_pairs(336, "we should avoid having three pairs in a hand"),
            caveats: vec![
                "The book's open-hand caveat reverses the ranking: when you intend to pon, \
                 three pairs beat two (ch3:351). This lesson is the closed variant."
                    .to_string(),
                "Each pair costs the same two tiles, so the trainer also grades the other two \
                 pair tiles as correct. Only keeping three pairs, by discarding the side wait \
                 instead, is wrong."
                    .to_string(),
            ],
        });
    }

    if state.category != "ryanmen_protorun" {
        return None;
    }

    let discard = format_tile_for_display(state.correct_action.tile().unwrap_or_default(), false);
    let waits = &state.ukeire_tiles;
    let wait_text = if waits.len() == 2 {
        format!(
            "{} / {}",
            format_tile_for_display(&waits[0], false),
            format_tile_for_display(&waits[1], false)
        )
    } else {
        waits
            .iter()
            .map(|code| format_tile_for_display(code, false))
            .collect::<Vec<_>>()
            .join(" / ")
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

/// Tile codes held exactly twice in the human hand, including the draw.
fn pair_codes(state: &GameState) -> Vec<String> {
    let Some(human) = human(state) else {
        return Vec::new();
    };

    let mut counts: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
    for code in human.hand.iter().chain(human.draw.iter()) {
        *counts.entry(code.clone()).or_insert(0) += 1;
    }
    counts
        .into_iter()
        .filter(|(_, count)| *count == 2)
        .map(|(code, _)| code)
        .collect()
}

/// The dragon pair of the open-hand pair-count lesson.
fn dragon_pair(state: &GameState) -> Option<String> {
    pair_codes(state)
        .into_iter()
        .find(|code| matches!(code.as_str(), "5z" | "6z" | "7z"))
}

/// Copies of the Pon target still unseen: the hand holds two, and anything in
/// a river or the face-up dora indicator is visible to everyone.
fn live_target_copies(state: &GameState, target_code: &str) -> u8 {
    let mut visible = 0u8;
    for player in &state.players {
        visible += player
            .discards
            .iter()
            .filter(|discard| discard.tile == target_code)
            .count() as u8;
    }
    if state.dora_indicators.iter().any(|code| code == target_code) {
        visible += 1;
    }
    4u8.saturating_sub(2 + visible)
}

/// Acceptance after the planned Pon for one discard.
///
/// Removes the discard and both copies of the target from the visible hand,
/// then counts the target pair as one called meld. This is the 14-effective-tile
/// position the player faces immediately after the Pon.
fn pon_acceptance(state: &GameState, discard: Tile, target: Tile) -> Option<u8> {
    let mut tiles: Vec<Tile> = state
        .tiles
        .iter()
        .filter_map(|code| Tile::try_from(code.as_str()).ok())
        .collect();
    let index = tiles.iter().position(|held| *held == discard)?;
    tiles.remove(index);
    if tiles.iter().filter(|held| **held == target).count() != 2 {
        return None;
    }
    let concealed: Vec<Tile> = tiles.into_iter().filter(|held| *held != target).collect();
    Some(calculate_ukeire_with_melds(&to_counts(&concealed), 1).total_count)
}

/// The tile one rank above the answer in its suit, when the hand still holds
/// it. It is the side wait the three-pair keep would have to give up.
fn pair_twin(state: &GameState) -> Option<Tile> {
    let answer = Tile::try_from(state.correct_action.tile()?).ok()?;
    let Tile::Suited { suit, value } = answer else {
        return None;
    };
    if value >= 9 {
        return None;
    }
    let twin = Tile::Suited {
        suit,
        value: value + 1,
    };
    let twin_code = twin.to_string();
    state
        .tiles
        .iter()
        .any(|code| code == &twin_code)
        .then_some(twin)
}

/// Acceptance after discarding one copy of `tile` from the visible hand.
fn acceptance_without(state: &GameState, tile: Tile) -> Option<u8> {
    let mut tiles: Vec<Tile> = state
        .tiles
        .iter()
        .filter_map(|code| Tile::try_from(code.as_str()).ok())
        .collect();
    let index = tiles.iter().position(|held| *held == tile)?;
    tiles.remove(index);
    Some(crate::generator::evaluate_hand(&tiles).ukeire_total)
}

/// The ch. 9 seating tip: throw the right player's valueless wind first.
///
/// The book is not saying the right player must never Pon you. A Pon on your
/// own discard comes from the caller's left player, which skips no turn; the
/// bad case is the right player pairing the wind and Ponning your left
/// player's discard later. Throwing the copy first spends it on the harmless
/// call and pulls the other copies out before a pair can form.
fn wind_discard_rationale(state: &GameState) -> Option<BookRationale> {
    let answer_code = state.correct_action.tile()?;
    let answer = format_tile_for_display(answer_code, false);
    let human = human(state)?;
    let shimocha_wind = human.wind.next(1);

    let other_winds: Vec<String> = state
        .tiles
        .iter()
        .filter(|code| is_wind_code(code) && code.as_str() != answer_code)
        .map(|code| format_tile_for_display(code, false))
        .collect();
    let others = if other_winds.is_empty() {
        "none".to_string()
    } else {
        other_winds.join(" / ")
    };

    let rules = vec![
        BookRule {
            id: "calls_move_turns".to_string(),
            rule: "A call transfers a turn, not just tiles: the caller's right player gains the \
                   tempo, so a Pon by the right player from your left player skips your turn."
                .to_string(),
            quote: "your act of calling pon/kan benefits the right player while penalizing the \
                    left and the facing players"
                .to_string(),
            citation: ch9_seating(440, "benefits the right player while penalizing"),
            applies: format!(
                "The right player's seat wind is {shimocha_wind:?}: a Pon on it, called from \
                 your left player, would skip your turn."
            ),
        },
        BookRule {
            id: "shimocha_wind_first".to_string(),
            rule: "Of the valueless winds, throw the right player's wind first and the facing \
                   player's second: both can skip your turn, while the left player's call \
                   cannot."
                .to_string(),
            quote: "When discarding valueless wind tiles, discard the right player's wind first, \
                    then the facing player's wind next."
                .to_string(),
            citation: ch9_seating(455, "discard the right player's wind first"),
            applies: format!(
                "{answer} is the right player's wind, so it goes before the other valueless \
                 winds ({others})."
            ),
        },
        BookRule {
            id: "pon_from_you_skips_nobody".to_string(),
            rule: "Throw it from your own hand: a Pon on your discard comes from the caller's \
                   left player, which skips nobody."
                .to_string(),
            quote: "you should do so sooner rather than later".to_string(),
            citation: ch9_seating(452, "sooner rather than later"),
            applies: "This is the first discard, so the copy leaves before the right player \
                      could pair it and call on someone else's tile."
                .to_string(),
        },
        BookRule {
            id: "pair_never_forms".to_string(),
            rule: "A first-turn wind tends to pull the other copies out in the same turn, so \
                   the pair never forms and the later Pon never happens."
                .to_string(),
            quote: "there is a good chance that another player may do the same in the 1st turn \
                    as well, lowering the chance that the South player builds a pair"
                .to_string(),
            citation: ch9_seating(452, "good chance that another player may do the same"),
            applies: "Everyone is choosing a first discard, so the other copies can leave the \
                      table before this one pairs."
                .to_string(),
        },
    ];

    Some(BookRationale {
        summary: format!(
            "Discard the right player's wind ({answer}) first: a Pon from them can skip your \
             turn, and a first-turn wind is unlikely to come back as a pair."
        ),
        rules,
        absent: Vec::new(),
        source: ch9_seating(455, "discard the right player's wind first"),
        caveats: vec![
            "The hand holds only valueless winds: the round wind and the seat wind are never \
             dealt, and the dora indicator is a suit tile."
                .to_string(),
            "In a two-wind hand the facing player's wind is not always held; the right player's \
             wind is still the first discard."
                .to_string(),
        ],
    })
}

fn is_wind_code(code: &str) -> bool {
    matches!(code, "1z" | "2z" | "3z" | "4z")
}

/// Riichi Book 1, ch. 5, *Building the head*: with no pair yet, which lone tiles
/// may still pair into the pinfu head, and which one never may.
///
/// The rule is structural: the book splits the tile types, not the hand. Every
/// number tile and every valueless wind can be the head; a value honor (a
/// dragon, the round wind, or the seat wind) cannot, because pairing it makes a
/// yakuhai head instead. The generated hand holds exactly one value honor and
/// nothing else that is barred, so the reason below reads straight off the
/// table.
fn pinfu_head_rationale(state: &GameState) -> Option<BookRationale> {
    let answer_code = state.correct_action.tile()?;
    let answer = format_tile_for_display(answer_code, false);
    let answer_tile = Tile::try_from(answer_code).ok()?;
    let round = state.round_wind;
    let seat = human(state)?.wind;

    let tiles: Vec<(String, Tile)> = state
        .tiles
        .iter()
        .filter_map(|code| {
            Tile::try_from(code.as_str())
                .ok()
                .map(|tile| (code.clone(), tile))
        })
        .collect();

    // The loose tiles the book says to keep: its lone terminals and its
    // valueless wind. The lesson keeps every terminal out of its blocks (the
    // bulges and protoruns are middle shapes), so these are exactly the hand's
    // spare floats, not tiles a run already needs.
    let kept: Vec<String> = tiles
        .iter()
        .filter(|(_, tile)| *tile != answer_tile)
        .filter(|(_, tile)| can_be_pinfu_head(*tile, round, seat))
        .filter(|(_, tile)| is_terminal_or_honor(*tile))
        .filter(|(_, tile)| tiles.iter().filter(|(_, other)| other == tile).count() == 1)
        .map(|(code, _)| format_tile_for_display(code, false))
        .collect();
    let kept_text = if kept.is_empty() {
        "the lone tiles in hand".to_string()
    } else {
        kept.join(" / ")
    };
    let kept_count = kept.len();

    // Which value honor the answer is, so the rule can say why it is barred.
    let role = match answer_tile {
        Tile::Honor(honor) => match wind_from_honor(honor) {
            Some(wind) if wind == round => format!("The round wind {answer}"),
            Some(wind) if wind == seat => format!("Your seat wind {answer}"),
            Some(_) => answer.to_string(),
            None => format!("The dragon {answer}"),
        },
        Tile::Suited { .. } => answer.to_string(),
    };

    let rules = vec![
        BookRule {
            id: "pinfu_head_rule".to_string(),
            rule: "The head of a pinfu hand must be a pair of number tiles or valueless wind \
                   tiles, so while the hand has no committed head those loose tiles are what it \
                   is waiting to pair."
                .to_string(),
            quote: "To claim pinfu, the head must be a pair of number tiles or valueless wind \
                    tiles."
                .to_string(),
            citation: ch5_pinfu_head(
                449,
                "the head must be a pair of number tiles or valueless wind tiles",
            ),
            applies: format!(
                "The hand has no committed head yet, so the head is still to be built: \
                 {kept_text} can each grow into it."
            ),
        },
        BookRule {
            id: "value_honor_cannot_be_head".to_string(),
            rule: "A value honor — a dragon, the round wind, or the seat wind — can never be the \
                   head of pinfu: pairing it makes a yakuhai head, which is a different hand."
                .to_string(),
            quote: "the value tile fa cannot be the head of pinfu".to_string(),
            citation: ch5_pinfu_head(458, "cannot be the head of {\\jap pinfu}"),
            applies: format!(
                "{role} is a value honor, so pairing it would give a yakuhai head instead: it \
                 is the one tile in these fourteen that can never be the pinfu head."
            ),
        },
        BookRule {
            id: "keep_terminals_and_winds".to_string(),
            rule: "Terminals and valueless winds look useless, but they are exactly the tiles \
                   that may grow into the pinfu head, so they go only once a pair exists."
                .to_string(),
            quote: "try not to discard terminals or valueless wind tiles lightly when having a \
                    pinfu hand"
                .to_string(),
            citation: ch5_pinfu_head(
                449,
                "try not to discard terminals or valueless wind tiles lightly",
            ),
            applies: format!("Discarding {answer} keeps {kept_text}."),
        },
    ];

    Some(BookRationale {
        summary: format!(
            "Discard {answer}: every other lone tile here can still pair into the pinfu head, \
             while the value honor never can."
        ),
        rules,
        absent: vec![AbsentRule {
            id: "yakuhai_head".to_string(),
            note: "Pairing the value honor would give a yakuhai head, but that is a different \
                   hand: this drill keeps pinfu alive rather than settling for the yakuhai."
                .to_string(),
        }],
        source: ch5_pinfu_head(
            449,
            "the head must be a pair of number tiles or valueless wind tiles",
        ),
        caveats: vec![
            "The head is not settled — the book's \"especially when a hand is lacking any \
             pair\" case. The hand's only duplicate sits inside a bulge, which splits into a \
             run plus a float, so it is shape rather than a committed head."
                .to_string(),
            "Value is held fixed: the answer is never the dora, and the hand is closed and \
             2-away, so the answer comes from the head rule rather than from score or a wait \
             comparison."
                .to_string(),
            format!(
                "The {kept_count} tiles kept beside the value honor are the hand's lone \
                 terminals and its valueless wind. They look useless the way the book's \
                 1m / 9p / E do: pairing one is their way into the head."
            ),
        ],
    })
}

/// True for a terminal or an honor: the tiles the book says to keep while the
/// pinfu head is still open.
fn is_terminal_or_honor(tile: Tile) -> bool {
    match tile {
        Tile::Honor(_) => true,
        Tile::Suited { value, .. } => value == 1 || value == 9,
    }
}

/// The ch. 9.1 lesson: never meld a hand that is both cheap and slow.
fn meld_or_not_rationale(state: &GameState) -> Option<BookRationale> {
    let offer = state.call_offer.as_ref()?;
    let claimed = format_tile_for_display(&offer.tile, false);

    // The book's "slow" test is the shanten *after* melding. Recompute the
    // best case over every discard the call would leave behind, so the note
    // never overstates the hand.
    let after_meld = state
        .players
        .iter()
        .find(|player| player.is_human)
        .and_then(|player| best_shanten_after_call(state, player));

    let slow = match after_meld {
        Some(shanten) => {
            format!("Even after the Pon and the best discard, the hand is still {shanten}-away.")
        }
        None => "Even after the call the hand is still far from ready.".to_string(),
    };
    let no_dora = if hand_holds_a_dora(state) {
        "The hand does hold a dora, so this board never claims that it is dora-free.".to_string()
    } else {
        format!(
            "It holds no dora and no other complete set, so as it stands its only yaku is the \
             {claimed} yakuhai: a 1000-point hand."
        )
    };

    let rules = vec![
        BookRule {
            id: "cheap_and_slow".to_string(),
            rule: "Do not meld a hand that is both cheap and far from ready: the call opens \
                   the hand, gives up safety tiles, and still wins little and late."
                .to_string(),
            quote: "Melding with a cheap and slow hand is one of the two biggest sins in \
                    riichi mahjong."
                .to_string(),
            citation: ch9_meld(30, "one of the two biggest sins"),
            applies: format!(
                "{slow} {no_dora} Passing on {claimed} keeps both the value and the safe tiles."
            ),
        },
        BookRule {
            id: "melding_judgement_1".to_string(),
            rule: "The rule's short form: a hand must be either expensive or fast before a \
                   call is worth making."
                .to_string(),
            quote: "Don't meld with a cheap and slow hand!".to_string(),
            citation: ch9_meld(72, "Don't meld with a cheap and slow hand"),
            applies: format!(
                "This hand is neither: the {claimed} Pon leaves it cheap, and the same call \
                 leaves it slow."
            ),
        },
        BookRule {
            id: "slow_definition".to_string(),
            rule: "Slow means 2-away or worse after melding, and with bad waits.".to_string(),
            quote: "we mean that the hand is 2-away or worse after melding".to_string(),
            citation: ch9_meld(33, "the hand is 2-away or worse"),
            applies: format!(
                "The shape left behind after the {claimed} Pon is built only from closed and \
                 edge protoruns, so there is no side wait to reach."
            ),
        },
    ];

    Some(BookRationale {
        summary: format!(
            "Pass on the {claimed}: the hand is cheap and slow, so the book's first melding \
             judgement forbids the call."
        ),
        rules,
        absent: vec![
            AbsentRule {
                id: "slow_but_expensive".to_string(),
                note: "Meld when a slow hand still has 7700+ potential: the book's own example \
                       calls a Pon and discards a 9p, because the open hand can reach 7700. \
                       This hand's only value is the yakuhai."
                    .to_string(),
            },
            AbsentRule {
                id: "cheap_but_fast".to_string(),
                note: "Meld when the call keeps the hand fast: \"all the remaining blocks have a \
                       good wait\" (ch. 9). Here every remaining block is closed or edge."
                    .to_string(),
            },
            AbsentRule {
                id: "eliminating_bad_wait".to_string(),
                note: "\"If you can eliminate a bad wait and make the hand ready, meld!\" \
                       (ch. 9). This call does not reach ready and does not remove a bad wait."
                    .to_string(),
            },
            AbsentRule {
                id: "concealed_value_tiles".to_string(),
                note: "\"If you have a concealed set of value tiles, you can meld with a cheap \
                       and slow hand\" (ch. 9). This hand holds no concealed value set: its \
                       remaining blocks are all suited."
                    .to_string(),
            },
        ],
        source: ch9_meld(72, "Don't meld with a cheap and slow hand"),
        caveats: vec![
            "The book also allows a cheap-and-slow call when you are ahead in South-4, when two \
             or more Riichi sticks are on the table, or when you are the losing dealer and want \
             to hurry the table."
                .to_string(),
        ],
    })
}

/// Riichi Book 1, ch. 9, "Open quad (daiminkan)".
///
/// The answer turns on the book's three situations ("the hand is ready with a
/// good wait, and the hand value is between 2000 and 5200 points", "you need
/// more dora or minipoints to improve the placement (especially in South-4)",
/// "you are losing badly") and on the two boxes that refuse the call: a
/// 2000-point hand with a bad wait, and a 1000-point hand with a good wait.
/// Every number is recomputed from the finished state through
/// [`crate::generator::daiminkan_facts`], so an imported report keeps an honest
/// rationale.
fn daiminkan_rationale(state: &GameState) -> Option<BookRationale> {
    let facts = crate::generator::daiminkan_facts(state)?;
    let quad = format_tile_for_display(&facts.quad.to_string(), false);
    let waits: Vec<String> = state
        .ukeire_tiles
        .iter()
        .map(|code| format_tile_for_display(code, false))
        .collect();
    let waits_text = waits.join(" / ");
    let wait_shape = if facts.good_wait {
        "a good wait"
    } else {
        "a bad wait"
    };
    let triggers = facts.triggers();
    let answered_kan = state.correct_action.action_type() == CorrectActionType::Kan;

    let conditions = BookRule {
        id: "open_quad_conditions".to_string(),
        rule: "An open quad needs one of three situations: a ready hand with a good wait worth \
               2000-5200 points, a placement that needs the quad's dora or minipoints, or a \
               score line that is already lost."
            .to_string(),
        quote: "You can make an open quad in any of the following situations:".to_string(),
        citation: ch9_daiminkan(321, "You can make an open quad"),
        applies: if triggers.good_wait_and_value {
            format!(
                "The ready hand holds {wait_shape} on {waits_text} and wins for {} points, \
                 inside the book's band.",
                facts.value
            )
        } else if triggers.placement_desperation {
            format!(
                "The hand is only worth {} points on {waits_text}, but you are {} at South-4 \
                 and the quad's minipoints take it to {}.",
                facts.value,
                rank_ordinal(facts.rank),
                facts.quad_value
            )
        } else if triggers.losing_badly {
            format!(
                "The hand is only worth {} points on {waits_text}, but you are fourth and far \
                 behind: the quad's extra draw, dora chance and minipoints are what the hand \
                 is short of.",
                facts.value
            )
        } else {
            format!(
                "None of them holds: the hand holds {wait_shape} on {waits_text} and is worth \
                 {} points, and the score line asks nothing of it.",
                facts.value
            )
        },
    };

    if answered_kan {
        let mut rules = vec![conditions];

        if triggers.good_wait_and_value {
            rules.push(BookRule {
                id: "good_wait_and_value".to_string(),
                rule: "A ready hand with a good wait and a value inside 2000-5200 can afford \
                       the quad: its extra minipoints and dora are almost free value."
                    .to_string(),
                quote: "the hand is ready with a good wait, and the hand value is between 2000 \
                        and 5200 points;"
                    .to_string(),
                citation: ch9_daiminkan(323, "the hand is ready with a good wait"),
                applies: format!(
                    "The hand waits on {waits_text} ({wait_shape}) and wins for {} points by \
                     ron, {hand_han} han at {hand_fu} fu. The same wait wins for {} once the \
                     quad's minipoints are added.",
                    facts.value,
                    facts.quad_value,
                    hand_han = facts.han,
                    hand_fu = facts.fu
                ),
            });
        }

        if triggers.placement_desperation {
            rules.push(BookRule {
                id: "placement_desperation".to_string(),
                rule: "Call the quad when the extra minipoints or dora decide the placement, \
                       especially at South-4."
                    .to_string(),
                quote: "you need more dora or minipoints to improve the placement (especially in \
                        South-4);"
                    .to_string(),
                citation: ch9_daiminkan(324, "or minipoints to improve the placement"),
                applies: format!(
                    "You are {} at South-4, {gap} points behind the player above. The same wait \
                     wins for {value} while the three {quad} stay concealed and {quad_value} once \
                     they become the open quad, so only the call closes the gap.",
                    rank_ordinal(facts.rank),
                    gap = facts.gap_to_above.unwrap_or_default(),
                    value = facts.value,
                    quad_value = facts.quad_value,
                ),
            });
        }

        if triggers.losing_badly {
            rules.push(BookRule {
                id: "losing_badly".to_string(),
                rule: "Call the quad when you are losing badly: its extra draw, dora chance and \
                       minipoints are worth more than the three tiles it spends."
                    .to_string(),
                quote: "you are losing badly.".to_string(),
                citation: ch9_daiminkan(325, "you are losing badly"),
                applies: format!(
                    "You are fourth, {gap} points behind third, and this {value}-point hand is \
                     not going to close that on its own.",
                    gap = facts.gap_to_above.unwrap_or_default(),
                    value = facts.value,
                ),
            });
        }

        // The situations that do not hold are still worth naming: they are the
        // reason this particular hand needs the one above.
        let mut absent = Vec::new();
        if !triggers.good_wait_and_value {
            absent.push(AbsentRule {
                id: "good_wait_and_value".to_string(),
                note: "The hand's own value is not inside the book's band with a good wait: it \
                       is the table, not the hand, that asks for this quad."
                    .to_string(),
            });
        }
        if !triggers.placement_desperation {
            absent.push(AbsentRule {
                id: "placement_desperation".to_string(),
                note: "No placement gap needs the quad's minipoints: the call is not being made \
                       to reach a particular score."
                    .to_string(),
            });
        }
        if !triggers.losing_badly {
            absent.push(AbsentRule {
                id: "losing_badly".to_string(),
                note: "You are not far behind in fourth, so the \"losing badly\" reason does not \
                       apply."
                    .to_string(),
            });
        }

        return Some(BookRationale {
            summary: format!("Call the open quad on {quad}: {}.", kan_reason(&triggers)),
            rules,
            absent,
            source: ch9_daiminkan(321, "You can make an open quad"),
            caveats: vec![
                "The quad spends the three concealed copies, so they stop being safe discards, \
                 and the new dora indicator it turns can help the opponents."
                    .to_string(),
                format!(
                    "The quad's own new dora is not counted above: it adds han on top of the \
                     {} -> {} minipoint gain, and the book's own example goes from 2000 to 5200 \
                     with one extra dora.",
                    facts.value, facts.quad_value
                ),
            ],
        });
    }

    // The book's two refusals: same hand, wrong wait or wrong value.
    let refusal = if !facts.good_wait {
        BookRule {
            id: "bad_wait".to_string(),
            rule: "Do not quad a ready hand whose wait is bad: the fourth copy buys minipoints \
                   and a dora draw, not a better wait, and a bad wait is what loses the hand."
                .to_string(),
            quote: "not justifiable when the wait is bad".to_string(),
            citation: ch9_daiminkan(348, "justifiable when the wait is bad"),
            applies: format!(
                "The hand is worth {} points but waits on {waits_text} only: the book's own \
                 2000-point box refuses the quad on exactly this shape.",
                facts.value
            ),
        }
    } else {
        BookRule {
            id: "too_cheap".to_string(),
            rule: "Do not quad a cheap ready hand: the extra minipoints move 1000 to 1300, \
                   which is not what the call costs."
                .to_string(),
            quote: "the hand value only increases from 1000 to 2600".to_string(),
            citation: ch9_daiminkan(358, "only increases from 1000 to 2600"),
            applies: format!(
                "The hand has {wait_shape} on {waits_text} but is only worth {} points \
                 ({hand_han} han at {hand_fu} fu); even with the quad's minipoints it reaches \
                 {}.",
                facts.value,
                facts.quad_value,
                hand_han = facts.han,
                hand_fu = facts.fu
            ),
        }
    };

    Some(BookRationale {
        summary: format!(
            "Pass on the {quad}: the hand is {} points with {wait_shape}, and no score line \
             asks for the quad.",
            facts.value
        ),
        rules: vec![conditions, refusal],
        absent: vec![
            AbsentRule {
                id: "placement_desperation".to_string(),
                note: "The placement escape would justify the quad, but this table is not \
                       South-4 with a gap the extra minipoints close."
                    .to_string(),
            },
            AbsentRule {
                id: "losing_badly".to_string(),
                note: "The \"losing badly\" escape would justify the quad, but you are not far \
                       behind in fourth here."
                    .to_string(),
            },
        ],
        source: ch9_daiminkan(321, "You can make an open quad"),
        caveats: vec![
            "The book allows the quad later: the same hand can call it once a draw improves the \
             wait or the value."
                .to_string(),
        ],
    })
}

/// One clause naming the situation that justified the quad.
fn kan_reason(triggers: &crate::generator::DaiminkanTriggerSet) -> &'static str {
    if triggers.good_wait_and_value {
        "the ready hand has a good wait and is worth 2000-5200"
    } else if triggers.placement_desperation {
        "South-4 needs its minipoints for the placement"
    } else {
        "you are losing badly"
    }
}

/// "2nd" / "3rd" / "4th", for the placement and score lines.
fn rank_ordinal(rank: usize) -> String {
    match rank {
        1 => "1st".to_string(),
        2 => "2nd".to_string(),
        3 => "3rd".to_string(),
        _ => format!("{rank}th"),
    }
}

/// The best (lowest) shanten the hand can reach after the offered call, over
/// every discard the call would leave.
fn best_shanten_after_call(state: &GameState, player: &crate::state::PlayerState) -> Option<i8> {
    let offer = state.call_offer.as_ref()?;
    let mut remaining: Vec<Tile> = player
        .hand
        .iter()
        .map(|code| Tile::try_from(code.as_str()).ok())
        .collect::<Option<Vec<_>>>()?;
    if remaining.len() != 13 {
        return None;
    }

    // Consume the hand tiles the call uses: two copies of the claimed tile for
    // a Pon, the two named tiles for a Chi.
    let consumed: Vec<Tile> = if offer.action == "Pon" {
        let tile = Tile::try_from(offer.tile.as_str()).ok()?;
        vec![tile, tile]
    } else {
        offer
            .tiles
            .iter()
            .map(|code| Tile::try_from(code.as_str()).ok())
            .collect::<Option<Vec<_>>>()?
    };
    for tile in consumed {
        let index = remaining.iter().position(|held| *held == tile)?;
        remaining.remove(index);
    }

    let mut best: Option<i8> = None;
    let mut seen = Vec::new();
    for discard in remaining.clone() {
        if seen.contains(&discard) {
            continue;
        }
        seen.push(discard);
        let mut after = remaining.clone();
        let index = after.iter().position(|tile| *tile == discard)?;
        after.remove(index);
        let shanten = agari::shanten::calculate_shanten_with_melds(&to_counts(&after), 1).shanten;
        best = Some(best.map_or(shanten, |current| current.min(shanten)));
    }
    best
}

/// Riichi Book 1, ch. 9, "Concealed quad (ankan)".
///
/// The answer turns on two of the book's lists: the conditions that justify a
/// concealed quad ("1-away, where at least one block has a good wait" and
/// "2-away, where all the blocks have a good wait"), and the refusals that
/// override them - above all "one of the four tiles can be used a good
/// floating tile". Every number in the `applies` text is recomputed from the
/// state, so an imported report keeps an honest rationale.
fn ankan_rationale(state: &GameState) -> Option<BookRationale> {
    let player = human(state)?;
    let mut tiles: Vec<Tile> = player
        .hand
        .iter()
        .filter_map(|code| Tile::try_from(code.as_str()).ok())
        .collect();
    if let Some(draw) = player
        .draw
        .as_deref()
        .and_then(|code| Tile::try_from(code).ok())
    {
        tiles.push(draw);
    }

    // The quad candidate is the tile held four times.
    let quad = tiles
        .iter()
        .copied()
        .find(|candidate| tiles.iter().filter(|tile| *tile == candidate).count() == 4)?;
    let quad_name = format_tile_for_display(&quad.to_string(), false);

    // The hand the quad would leave: ten concealed tiles and one called set.
    let post_kan: Vec<Tile> = tiles.iter().copied().filter(|tile| *tile != quad).collect();
    let post_kan_shanten = calculate_shanten_with_melds(&to_counts(&post_kan), 1).shanten;
    let post_kan_acceptance = calculate_ukeire_with_melds(&to_counts(&post_kan), 1);

    let judgement = BookRule {
        id: "kan_judgement_1".to_string(),
        rule: "A concealed quad needs the hand to be close to ready: it spends four tiles on \
               one set, so the hand has to be near enough for that to pay."
            .to_string(),
        quote: "In principle, your hand needs to be close to ready to justify making a concealed \
                quad."
            .to_string(),
        citation: ch9_ankan(269, "needs to be close to ready"),
        applies: format!(
            "After the quad of {quad_name} the hand is {post_kan_shanten}-away with {} of \
             draw to reach ready.",
            kinds(post_kan_acceptance.tiles.len())
        ),
    };

    if state.correct_action.action_type() == CorrectActionType::Kan {
        let (id, quote, line, applies) = if post_kan_shanten <= 1 {
            (
                "one_away_good_wait",
                "1-away, where at least one block has a good wait;",
                233,
                "The hand is 1-away and at least one of its protoruns is a side wait, so the \
                 quad's condition holds."
                    .to_string(),
            )
        } else {
            (
                "two_away_all_good_waits",
                "2-away, where all the blocks have a good wait;",
                234,
                "The hand is 2-away and every protorun in it is a side wait, the book's \
                 \"perfect 2-away hand\"."
                    .to_string(),
            )
        };

        return Some(BookRationale {
            summary: format!(
                "Call the concealed quad on {quad_name}: the hand is close to ready and the \
                 fourth copy has no floating-tile use."
            ),
            rules: vec![
                judgement,
                BookRule {
                    id: id.to_string(),
                    rule: "A close-to-ready hand may call the quad while at least one block \
                           holds a good wait; at 2-away every block has to be good."
                        .to_string(),
                    quote: quote.to_string(),
                    citation: ch9_ankan(line, quote),
                    applies,
                },
            ],
            absent: vec![AbsentRule {
                id: "placement_escape".to_string(),
                note: "The book's other quad conditions - needing dora or minipoints for the \
                       placement, or losing badly - are not the reason here: this hand is close \
                       to ready."
                    .to_string(),
            }],
            source: ch9_ankan(269, "needs to be close to ready"),
            caveats: vec![
                "The quad still costs something: the four tiles leave the hand, so they are no \
                 longer safe discards, and the new dora can help the opponents."
                    .to_string(),
            ],
        });
    }

    // The decline: keep all four copies and throw the tile the quad cannot use.
    let discard = state
        .correct_action
        .tile()
        .and_then(|code| Tile::try_from(code).ok())?;
    let discard_name = format_tile_for_display(&discard.to_string(), false);

    let mut float_line = tiles.clone();
    let index = float_line.iter().position(|tile| *tile == discard)?;
    float_line.remove(index);
    let float_shanten = calculate_shanten(&to_counts(&float_line)).shanten;
    let float_acceptance = calculate_ukeire(&to_counts(&float_line));
    let float_tiles: Vec<Tile> = float_acceptance.tiles.iter().map(|u| u.tile).collect();
    let float_targets: Vec<String> = floating_quad_acceptance(quad)
        .into_iter()
        .filter(|target| float_tiles.contains(target))
        .map(|target| format_tile_for_display(&target.to_string(), false))
        .collect();

    // The same hand with the quad called and the same tile discarded.
    let mut kan_line = post_kan.clone();
    let index = kan_line.iter().position(|tile| *tile == discard)?;
    kan_line.remove(index);
    let kan_acceptance = calculate_ukeire_with_melds(&to_counts(&kan_line), 1);

    Some(BookRationale {
        summary: format!(
            "Keep the four {quad_name} and discard {discard_name}: the fourth copy is a good \
             floating tile, so the book refuses the concealed quad even though the hand is \
             close to ready."
        ),
        rules: vec![
            BookRule {
                id: "floating_tile".to_string(),
                rule: "Do not quad a middle tile whose fourth copy is a good floating tile: the \
                       free copy still accepts side-wait protoruns, and the quad can never \
                       accept them."
                    .to_string(),
                quote: "one of the four tiles can be used a good floating tile;".to_string(),
                citation: ch9_ankan(282, "can be used a good floating tile"),
                applies: format!(
                    "Discarding {discard_name} leaves the hand {float_shanten}-away, and it \
                     accepts {} from the floating copy; the quad line accepts only {}, and none \
                     of the floating copy's.",
                    float_targets.join(" / "),
                    kinds(kan_acceptance.tiles.len())
                ),
            },
            BookRule {
                id: "not_even_when_ready".to_string(),
                rule: "Being close to ready does not settle the decision: the book's refusals \
                       override the quad conditions."
                    .to_string(),
                quote: "There are cases where we should not make a concealed quad even when the \
                        hand is (close to) ready."
                    .to_string(),
                citation: ch9_ankan(313, "even when the hand is (close to) ready"),
                applies: format!(
                    "Keeping the four copies leaves the hand {float_shanten}-away, and calling \
                     the quad does not bring it any closer."
                ),
            },
        ],
        absent: vec![AbsentRule {
            id: "honor_quad".to_string(),
            note: "An honor quad has no floating-tile use - its fourth copy can only pair, which \
                   the triplet already covers - so the book's objection cannot apply there."
                .to_string(),
        }],
        source: ch9_ankan(282, "can be used a good floating tile"),
        caveats: vec![
            "The book adds that you can still call the quad later if the hand becomes ready, so \
             declining now costs nothing."
                .to_string(),
        ],
    })
}

/// "1 kind" / "2 kinds", for the acceptance counts the ankan rationale states.
fn kinds(count: usize) -> String {
    if count == 1 {
        "1 kind".to_string()
    } else {
        format!("{count} kinds")
    }
}

/// Whether any tile the human holds is a dora.
fn hand_holds_a_dora(state: &GameState) -> bool {
    let Some(player) = human(state) else {
        return false;
    };
    let dora: Vec<Tile> = state
        .dora_indicators
        .iter()
        .filter_map(|code| Tile::try_from(code.as_str()).ok())
        .map(agari::context::indicator_to_dora)
        .collect();
    player
        .hand
        .iter()
        .chain(player.draw.iter())
        .filter_map(|code| Tile::try_from(code.as_str()).ok())
        .any(|tile| dora.contains(&tile))
}

/// The pure-defense lessons: the ch. 8 safety chart, its ranking mode and its
/// fallback list.
fn defense_rationale(state: &GameState) -> Option<BookRationale> {
    let is_chart = state.category == "defense_safety_chart";
    let is_ranking = state.category == "suji_kabe_safety";
    let is_stuck = state.category == "defense_stuck_heuristic";
    if !is_chart && !is_ranking && !is_stuck {
        return None;
    }

    let threat = state.players.iter().find(|player| player.is_riichi)?;
    let facts = crate::safety::SafetyFacts::from_state(state, threat.seat)?;
    let answer = Tile::try_from(state.correct_action.tile()?).ok()?;
    let answer_text = format_tile_for_display(&answer.to_string(), false);
    let read = facts.read(answer);

    let mut rules = Vec::new();
    let mut caveats = Vec::new();
    let summary = if is_ranking {
        rules.extend(mechanism_rules(&read, &answer_text));
        rules.push(chart_row_rule(&read, &answer_text, &state.equivalent_tiles));
        rules.push(runner_up_rule(state, &facts, answer, &answer_text));
        rules.push(push_fold_rule(state, &read, &answer_text));
        caveats.push(
            "The answer is inside a block in the hand (a pair, a set, or a protorun), so this \
             discard visibly breaks the hand up to fold; boards where the safest tile is a lone \
             float are rejected."
                .to_string(),
        );
        caveats.push(
            "Honor rows are excluded from this drill even where their visible-count row is as \
             safe: the lesson is the suji and blockade arithmetic in the answer column, not honor \
             counting."
                .to_string(),
        );
        format!(
            "Safest discard: {answer_text} is Rank {} ({}), with the runner-up exactly one row \
             worse.",
            read.rank.code(),
            read.rank.label()
        )
    } else if is_chart {
        rules.extend(mechanism_rules(&read, &answer_text));
        rules.push(chart_row_rule(&read, &answer_text, &state.equivalent_tiles));
        rules.push(push_fold_rule(state, &read, &answer_text));
        caveats.push(
            "The chart's AAA row is dangerous only against Thirteen Orphans; the trainer keeps \
             the table's conservative rank instead of promoting a fourth copy to 100%."
                .to_string(),
        );
        caveats.push(
            "The book gives no turn number for the one-chance split between BB- (earlier turns) \
             and C (later turns); the trainer cuts at six discards."
                .to_string(),
        );
        if read.rank.order() > push_threshold(state.shanten).order() {
            format!(
                "Fold: {answer_text} is Rank {} ({}); nothing reaches Rank {}.",
                read.rank.code(),
                read.rank.label(),
                push_threshold(state.shanten).code()
            )
        } else {
            format!(
                "Safest discard: {answer_text} is Rank {} ({}).",
                read.rank.code(),
                read.rank.label()
            )
        }
    } else {
        rules.extend(stuck_rule_set(&facts, state, answer, &answer_text));
        caveats.push(
            "Every tile here is Rank C or worse, so the chart identifies nothing safe; the \
             chapter's fallback list is what decides."
                .to_string(),
        );
        format!(
            "Nothing reaches Rank B: break up the {answer_text} pair and discard {answer_text}."
        )
    };

    let source = if is_chart || is_ranking {
        ch8(CH8_RANKING, 292, "Safety ranking")
    } else {
        ch8(CH8_STUCK, 344, "What to discard when you get stuck")
    };

    Some(BookRationale {
        summary,
        rules,
        absent: absent_tiles(&facts, state, answer),
        source,
        caveats,
    })
}

/// The ch. 8.1/8.3 fold lesson: an opponent's Riichi, a junk hand, and the one
/// tile the chapter calls 100% safe.
fn fold_to_riichi_rationale(state: &GameState) -> Option<BookRationale> {
    if state.category != "fold_to_riichi" {
        return None;
    }

    let threat = state.players.iter().find(|player| player.is_riichi)?;
    let facts = SafetyFacts::from_state(state, threat.seat)?;
    let answer = Tile::try_from(state.correct_action.tile()?).ok()?;
    let answer_text = format_tile_for_display(&answer.to_string(), false);
    let read = facts.read(answer);
    let block = answer_block(&human(state)?.hand, answer).unwrap_or("block");

    let mut rules = mechanism_rules(&read, &answer_text);

    // When the threat is Kamicha and the safe tile is its declaration discard,
    // the chapter's first absolutely-safe kind applies as well: the tile the
    // left player has just thrown is safe against the other two opponents too.
    let left_player_discard = threat.seat == 3
        && threat
            .discards
            .last()
            .is_some_and(|discard| discard.tile == answer.to_string());

    if left_player_discard {
        rules.push(BookRule {
            id: "left_player_discard".to_string(),
            rule: "The tile the left player has just discarded is 100% safe for this turn: \
                   the furiten rule stops both other opponents from ronning it."
                .to_string(),
            quote: "The tile that was just discarded by your left player.".to_string(),
            citation: ch8(CH8_GENBUTSU, 102, "just discarded by your left player"),
            applies: format!(
                "{answer_text} is Kamicha's declaration discard, so it is temporarily safe \
                 against the other two opponents as well."
            ),
        });
    }

    rules.push(BookRule {
        id: "fold_conditions".to_string(),
        rule: "The chapter folds when two of three hand conditions hold: a 1-away-or-worse \
               hand, a low scoring hand, or a bad wait."
            .to_string(),
        quote: "Fold if two of the following conditions are met: 1-away (or worse) hand; Low \
                scoring hand; Bad wait."
            .to_string(),
        citation: ch8(
            "A simple principle",
            31,
            "Fold} if {\\bf two} of the following conditions are met",
        ),
        applies: format!(
            "The hand is {}-away and holds no dora and no value set, so the 1-away-or-worse \
             condition and the low-scoring condition both hold.",
            state.shanten
        ),
    });
    rules.push(BookRule {
        id: "low_scoring".to_string(),
        rule: "A hand whose minimum value is below 7700 is a low scoring hand.".to_string(),
        quote: "We say a hand is a high scoring one if the minimum hand value is 7700; \
                otherwise it is a low scoring hand"
            .to_string(),
        citation: ch8(
            "Three conditions to push/fold",
            65,
            "high scoring one if the minimum hand value is 7700",
        ),
        applies: "The hand is lone honors plus suited blocks in two suits, with no dora, so \
                  nothing here is already worth 7700."
            .to_string(),
    });
    rules.push(BookRule {
        id: "betaori".to_string(),
        rule: "Once the push conditions fail, the hand folds completely: the safest tile wins \
               even though it costs the hand a block."
            .to_string(),
        quote: "If you cannot satisfy the above criteria, you must completely fold (betaori)."
            .to_string(),
        citation: ch8(
            CH8_VS_RIICHI,
            340,
            "If you cannot satisfy the above criteria",
        ),
        applies: format!(
            "The hand is {}-away, so a push would need Rank B or safer tiles; {answer_text} is \
             the only tile that qualifies, and it is one tile of the hand's {block}, so folding \
             gives that block up.",
            state.shanten
        ),
    });

    Some(BookRationale {
        summary: format!("Fold: {answer_text} is the hand's only 100% safe tile."),
        rules,
        absent: absent_tiles(&facts, state, answer),
        source: ch8(
            CH8_VS_RIICHI,
            340,
            "If you cannot satisfy the above criteria",
        ),
        caveats: vec![
            format!(
                "The chapter ranks tiles by danger, not by what they cost the hand. {answer_text} \
                 sits in a {block}, so the fold is the deliberate cost the betaori instruction \
                 asks for."
            ),
            "The book is more forgiving of dangerous discards in the early turns; this board \
             starts from a deep river, where it says the opposite."
                .to_string(),
            "Only the riichi player's own genbutsu is graded as safe here. The other two \
             opponents have not declared, and the chapter's absolute-safety kinds (a fourth \
             honor, a no-chance tile) are left out of the hand entirely."
                .to_string(),
        ],
    })
}

/// The block the safe tile sits in, as the book panel names it.
fn answer_block(hand: &[String], answer: Tile) -> Option<&'static str> {
    let tiles: Vec<Tile> = hand
        .iter()
        .filter_map(|code| Tile::try_from(code.as_str()).ok())
        .collect();

    if tiles.iter().filter(|tile| **tile == answer).count() >= 2 {
        return Some("pair");
    }

    let suit = answer.suit()?;
    let value = answer.value()?;
    let held: Vec<u8> = tiles
        .iter()
        .filter(|tile| tile.suit() == Some(suit))
        .filter_map(|tile| tile.value())
        .collect();

    let completes_a_run = (1..=7u8).any(|low| {
        value >= low
            && value <= low + 2
            && (low..low + 3).all(|rank| rank == value || held.contains(&rank))
    });
    if completes_a_run {
        return Some("completed run");
    }

    if held
        .iter()
        .any(|rank| *rank != value && rank.abs_diff(value) <= 2)
    {
        return Some("protorun");
    }

    None
}

/// The ch. 8.1 push/fold lesson: the box's 1-away cell.
///
/// The hand is always 1-away, so the "ready hand" condition never holds and the
/// answer is decided by the other two: the minimum value (ch8:65) and the best
/// wait the hand can still reach in the worst case (ch8:68, ch8:77).
fn push_or_fold_rationale(state: &GameState) -> Option<BookRationale> {
    if state.category != "push_or_fold" {
        return None;
    }

    human(state)?;
    let conditions = crate::generator::push_or_fold::conditions(state)?;
    let answer = Tile::try_from(state.correct_action.tile()?).ok()?;
    let answer_text = format_tile_for_display(&answer.to_string(), false);

    let value_text = match conditions.value {
        Some(value) => format!(
            "the worst winning tile still gives {} points and {} han",
            value.points, value.han
        ),
        None => "at least one completion has no yaku at all".to_string(),
    };
    let wait_text = if conditions.good_wait {
        "every completion can still choose a side wait"
    } else {
        "at least one completion can only reach a closed, edge or single wait"
    };

    let mut rules = Vec::new();
    let mut caveats = Vec::new();
    let mut absent = Vec::new();

    rules.push(BookRule {
        id: "push_fold_box".to_string(),
        rule: "Push when two of the three conditions hold (a ready hand, a high scoring \
               hand, a good wait); fold when two of their opposites do (1-away or worse, a \
               low scoring hand, a bad wait)."
            .to_string(),
        quote: "Push if two of the following conditions are met".to_string(),
        citation: ch8(
            CH8_PUSH_FOLD,
            23,
            "Push} if {\\bf two} of the following conditions are met",
        ),
        applies: format!(
            "The hand is {}-away, {value_text}, and {wait_text}.",
            state.shanten
        ),
    });

    rules.push(BookRule {
        id: "one_away_needs_both".to_string(),
        rule: "A 1-away hand is not a ready hand, so the book asks for both of the other \
               two push conditions."
            .to_string(),
        quote: "Pushing with a 1-away hand is acceptable only when both of the other two \
                conditions are met."
            .to_string(),
        citation: ch8(
            CH8_PUSH_FOLD,
            62,
            "Pushing with a 1-away hand is acceptable only when",
        ),
        applies: format!(
            "The hand is 1-away: {} and {}.",
            if conditions.is_high_scoring() {
                "high scoring"
            } else {
                "cheap"
            },
            if conditions.good_wait {
                "its wait is good"
            } else {
                "its wait is bad"
            }
        ),
    });

    rules.push(BookRule {
        id: "minimum_value".to_string(),
        rule: "A hand is high scoring when the minimum hand value is 7700, so even the \
               worst winning tile is already worth 7700 points without Riichi."
            .to_string(),
        quote: "We say a hand is a high scoring one if the minimum hand value is 7700".to_string(),
        citation: ch8(
            CH8_PUSH_FOLD,
            65,
            "We say a hand is a high scoring one if the minimum hand value is 7700",
        ),
        applies: value_text.clone(),
    });

    rules.push(BookRule {
        id: if conditions.good_wait {
            "perfect_one_away"
        } else {
            "bad_wait_in_worst_case"
        }
        .to_string(),
        rule: "A 1-away hand's wait is judged by the best wait it can still choose when it \
               becomes ready in the worst possible way."
            .to_string(),
        quote: if conditions.good_wait {
            "no matter how this hand becomes ready, you can always choose to have a side \
             wait"
        } else {
            "the best possible wait pattern in the worst-case scenario is not a good one"
        }
        .to_string(),
        citation: if conditions.good_wait {
            ch8(
                CH8_PUSH_FOLD,
                77,
                "Notice that this is a perfect 1-away hand; no matter how this hand becomes \
                 ready, you can \\emph{always} choose to have a side wait",
            )
        } else {
            ch8(
                CH8_PUSH_FOLD,
                87,
                "best} possible wait pattern in the \\emph{worst}-case scenario is not a good \
                 one",
            )
        },
        applies: wait_text.to_string(),
    });

    let summary = if conditions.pushes() {
        let facts = state
            .players
            .iter()
            .find(|player| player.is_riichi)
            .and_then(|threat| SafetyFacts::from_state(state, threat.seat));
        let rank = facts
            .as_ref()
            .map(|facts| facts.rank(answer))
            .unwrap_or(SafetyRank::D);
        rules.push(BookRule {
            id: "mangan_rank_d".to_string(),
            rule: "A guaranteed mangan is the one exception that lets a 1-away hand throw \
                   a Rank D tile while pushing."
                .to_string(),
            quote: "Only if your hand has a guaranteed mangan, you can discard Rank D tiles."
                .to_string(),
            citation: ch8(
                CH8_VS_RIICHI,
                337,
                "Only if your hand has a guaranteed {\\jap mangan}, you can discard {\\bf Rank D} tiles",
            ),
            applies: format!(
                "The minimum value is {}, and {answer_text} is Rank {} ({}).",
                conditions
                    .value
                    .map(|value| format!("{} points", value.points))
                    .unwrap_or_else(|| "below 7700".to_string()),
                rank.code(),
                rank.label()
            ),
        });
        caveats.push(
            "The chart's Rank D is the most dangerous row; the book only allows it here \
             because the hand is already worth a mangan before Riichi."
                .to_string(),
        );
        format!(
            "Push: discard {answer_text} and keep the perfect 1-away shape. The guaranteed \
             mangan covers the book's high-score condition and the shape covers the good \
             wait, so the hand meets both of the conditions the book asks of a 1-away hand."
        )
    } else {
        rules.push(BookRule {
            id: "betaori".to_string(),
            rule: "When the push conditions are not met, the book says to fold completely \
                   and take the safest tile."
                .to_string(),
            quote: "If you cannot satisfy the above criteria, you must completely fold \
                    (betaori)."
                .to_string(),
            citation: ch8(
                CH8_VS_RIICHI,
                340,
                "If you cannot satisfy the above criteria",
            ),
            applies: format!(
                "Neither push condition is left, so {answer_text} — the 100% safe tile — is \
                 the fold."
            ),
        });
        if let Some(threat) = state.players.iter().find(|player| player.is_riichi)
            && let Some(facts) = SafetyFacts::from_state(state, threat.seat)
        {
            let read = facts.read(answer);
            rules.push(BookRule {
                id: "genbutsu".to_string(),
                rule: "A tile in the riichi player's own river is 100% safe to discard."
                    .to_string(),
                quote: "Genbutsu tiles of player X are 100\\% safe against X".to_string(),
                citation: ch8(
                    CH8_GENBUTSU,
                    100,
                    "Genbutsu} tiles of player X are 100\\% safe against X",
                ),
                applies: format!("Safe because it is {}.", read.reason),
            });
        }
        caveats.push(
            "Folding here throws a tile that is part of a block, so the hand drops further \
             from ready; the book accepts that cost because the hand is both cheap and slow."
                .to_string(),
        );
        format!(
            "Fold: discard {answer_text}, the safest tile. The hand is cheap and its wait is \
             bad, so it meets neither condition the book asks of a 1-away hand."
        )
    };

    if !conditions.is_high_scoring() {
        absent.push(AbsentRule {
            id: "high_scoring_hand".to_string(),
            note: format!(
                "High scoring hand does not apply: {value_text}, below the book's 7700 floor."
            ),
        });
    }
    if !conditions.good_wait {
        absent.push(AbsentRule {
            id: "good_wait".to_string(),
            note: format!("Good wait does not apply: {wait_text}."),
        });
    }
    absent.push(AbsentRule {
        id: "ready_hand".to_string(),
        note: format!(
            "Ready hand does not apply: this hand is {}-away, so the book needs both other \
             conditions.",
            state.shanten
        ),
    });

    Some(BookRationale {
        summary,
        rules,
        absent,
        source: ch8(
            CH8_PUSH_FOLD,
            23,
            "Push} if {\\bf two} of the following conditions are met",
        ),
        caveats,
    })
}

/// The ch. 8.4 open-hand lesson: read the discard an opponent made after a chii.
fn open_hand_defense_rationale(state: &GameState) -> Option<BookRationale> {
    if state.category != "open_hand_defense" {
        return None;
    }

    let threat = state.players.iter().find(|player| {
        !player.is_human
            && player
                .melds
                .iter()
                .any(|meld| meld.meld_type == MeldType::Chi)
    })?;
    let last_chi = threat
        .melds
        .iter()
        .rev()
        .find(|meld| meld.meld_type == MeldType::Chi)?;
    let chi_tile = Tile::try_from(last_chi.tiles.first()?.as_str()).ok()?;
    let chi_suit = chi_tile.suit()?;
    let post_chi = Tile::try_from(threat.discards.last()?.tile.as_str()).ok()?;
    let post_suit = post_chi.suit()?;
    let answer = Tile::try_from(state.correct_action.tile()?).ok()?;
    let answer_text = format_tile_for_display(&answer.to_string(), false);
    let post_text = format_tile_for_display(&post_chi.to_string(), false);
    let same_suit = chi_suit == post_suit;

    let mut rules = vec![BookRule {
        id: "open_hand_ready".to_string(),
        rule: "Three or more open sets or runs is the chapter's shortcut for assuming an \
               opponent is ready."
            .to_string(),
        quote: "They have three or more open sets / runs.".to_string(),
        citation: ch8(CH8_READY_SHORTCUT, 412, "three or more open sets"),
        applies: "The threat has three open melds, so the defender treats it as ready.".to_string(),
    }];

    let mut caveats = vec![
        "The trainer reads the neighbourhood as the same suit within two ranks of the last \
         discard, not counting the discard itself. The book's example around 4p names \
         2,3,5,6,7; the generated boards use the symmetric ±2 part."
            .to_string(),
        "The book's read assumes the opponent had a good 1-away hand before the chii. Here the \
         threat is tenpai on the protorun it kept, so the neighbourhood is either genuinely \
         where the wait is or genuinely not."
            .to_string(),
        "A last pon would give no neighbourhood read at all: the book says the wait can be \
         anything (ch. 8.4, 'pon => wait can be anything'), so the generated threat always \
         calls chii for its last meld."
            .to_string(),
        "The chapter also asks the defender to estimate the open hand's value before folding. \
         This lesson only grades the tile read; the human hand is 2-away and the threat's value \
         is left out of the question."
            .to_string(),
    ];

    let summary = if same_suit {
        rules.push(BookRule {
            id: "chii_same_suit".to_string(),
            rule: "A chii followed by a discard in the same suit makes the neighbourhood of \
                   that discard relatively safe."
                .to_string(),
            quote: "the neighborhood of the last discard is safe".to_string(),
            citation: ch8(
                CH8_CHII_DISCARD,
                568,
                "the neighborhood of the last discard is",
            ),
            applies: format!(
                "The last call is a chii in the {} suit and {post_text} is in that same suit; \
                 {answer_text} sits inside the neighbourhood.",
                suit_word(chi_suit)
            ),
        });
        caveats.push(
            "The threat's kept protorun is in another suit, so its winning tiles are outside \
             the post-chii discard's neighbourhood. The answer is the hand's only \
             neighbourhood tile."
                .to_string(),
        );

        format!(
            "Discard {answer_text}: the chii and the last discard share the {} suit, so the \
             neighbourhood of {post_text} is relatively safe.",
            suit_word(chi_suit)
        )
    } else {
        rules.push(BookRule {
            id: "chii_different_suit".to_string(),
            rule: "A chii followed by a discard in a different suit makes the neighbourhood \
                   of that discard dangerous."
                .to_string(),
            quote: "the neighborhood of the last discard is dangerous".to_string(),
            citation: ch8(
                CH8_CHII_DISCARD,
                570,
                "the neighborhood of the last discard is",
            ),
            applies: format!(
                "The last call is a chii in the {} suit but {post_text} is in the {} suit, so \
                 the threat's wait sits in the {post_text} neighbourhood.",
                suit_word(chi_suit),
                suit_word(post_suit)
            ),
        });
        rules.push(BookRule {
            id: "genbutsu".to_string(),
            rule: "A tile in the opponent's river is 100% safe against that opponent.".to_string(),
            quote: "Genbutsu tiles of player X are 100% safe against X".to_string(),
            citation: ch8(CH8_GENBUTSU, 100, "100\\% safe against"),
            applies: format!(
                "{answer_text} is already in the threat's river and sits outside the dangerous \
                 neighbourhood; the held copy is the hand's only 100% tile."
            ),
        });
        caveats.push(
            "The trap tile inside the neighbourhood is one of the threat's actual winning \
             tiles. Picking it because it is near the last discard is exactly the mistake this \
             board teaches."
                .to_string(),
        );

        format!(
            "Discard {answer_text}: the chii and {post_text} are in different suits, so the \
             neighbourhood of {post_text} is dangerous; {answer_text} is 100% safe."
        )
    };

    // The structural read must agree with the board it is explaining.
    let answer_in_neighbourhood = in_open_hand_neighbourhood(answer, post_chi);
    if same_suit != answer_in_neighbourhood {
        return None;
    }

    let source = if same_suit {
        ch8(
            CH8_CHII_DISCARD,
            568,
            "the neighborhood of the last discard is",
        )
    } else {
        ch8(
            CH8_CHII_DISCARD,
            570,
            "the neighborhood of the last discard is",
        )
    };

    Some(BookRationale {
        summary,
        rules,
        absent: Vec::new(),
        source,
        caveats,
    })
}

fn suit_word(suit: Suit) -> &'static str {
    match suit {
        Suit::Man => "manzu",
        Suit::Pin => "pinzu",
        Suit::Sou => "souzu",
    }
}

/// The mechanism that places the answer on the chart.
fn mechanism_rules(read: &crate::safety::TileRead, answer_text: &str) -> Vec<BookRule> {
    use crate::safety::SafetyMechanism;

    let applies = format!("{answer_text}: {}.", read.reason);
    let rule = |id: &str, rule: &str, quote: &str, citation: Citation| BookRule {
        id: id.to_string(),
        rule: rule.to_string(),
        quote: quote.to_string(),
        citation,
        applies: applies.clone(),
    };

    match read.mechanism {
        SafetyMechanism::Genbutsu => vec![rule(
            "genbutsu",
            "A tile in the riichi player's river cannot be ronned by them: it is 100% safe.",
            "Genbutsu tiles of player X are 100% safe against X",
            ch8(CH8_GENBUTSU, 100, "100\\% safe against"),
        )],
        SafetyMechanism::PostRiichiGenbutsu => vec![rule(
            "genbutsu",
            "Anyone's discard after the riichi declaration is also genbutsu for that player: the \
             declaration fixes the wait, so it cannot ron the tile.",
            "if X has called riichi, then all the tiles discarded by anyone after riichi (and \
             passed up by X) are also called X's genbutsu tiles",
            ch8(CH8_GENBUTSU, 97, "also called X's"),
        )],
        SafetyMechanism::Suji => vec![rule(
            "suji",
            "A side wait is the most common Riichi wait, so a suji tile is safer than a \
             non-suji tile.",
            "Suji tiles are safer than non-suji tiles",
            ch8(CH8_SUJI, 139, "safer than non-"),
        )],
        SafetyMechanism::NoChance => vec![rule(
            "no_chance",
            "When all four copies of a tile are visible, every side wait that needs its \
             protorun is impossible, so the neighbours are no-chance tiles.",
            "we say we have a ``no chance'' situation",
            ch8(CH8_KABE, 206, "no chance'' situation"),
        )],
        SafetyMechanism::OneChance => vec![rule(
            "one_chance",
            "An incomplete blockade leaves the opponent only the last invisible copy, which is \
             safer than a plain non-suji tile.",
            "One-chance tiles are generally safer than non-suji tiles",
            ch8(
                CH8_KABE,
                248,
                "One-chance tiles are generally safer than non-",
            ),
        )],
        SafetyMechanism::Honor => vec![rule(
            "honor_count",
            "The chart ranks honors by how many copies are visible: the fourth is AAA, the \
             third AA, the second A, and the first B.",
            "Fourth tiles mean that three of that tile have already been discarded.",
            ch8(
                CH8_RANKING,
                322,
                "Fourth tiles mean that three of that tile have already been discarded",
            ),
        )],
        SafetyMechanism::NonSuji => vec![rule(
            "non_suji_terminal",
            "A non-suji terminal is the safest non-suji tile: it cannot be caught by an edge or \
             a closed wait.",
            "terminals cannot be caught by either an edge wait or closed wait",
            ch8(
                CH8_RANKING,
                325,
                "terminals cannot be caught by either an edge wait or closed wait",
            ),
        )],
    }
}

/// Why the chart row beats the rest of the hand.
fn chart_row_rule(
    read: &crate::safety::TileRead,
    answer_text: &str,
    equivalents: &[String],
) -> BookRule {
    let applies = if equivalents.is_empty() {
        format!(
            "{answer_text} is Rank {} ({}); every other tile in the hand ranks lower.",
            read.rank.code(),
            read.rank.label()
        )
    } else {
        format!(
            "{answer_text} is Rank {} ({}); the other genbutsu tiles ({}) tie it, so either \
             discard is correct.",
            read.rank.code(),
            read.rank.label(),
            equivalents
                .iter()
                .map(|code| format_tile_for_display(code, false))
                .collect::<Vec<_>>()
                .join(", ")
        )
    };

    BookRule {
        id: "safety_ranking".to_string(),
        rule: "The chart orders tiles by how many waits can catch them, and this row sits above \
               every other tile in the hand."
            .to_string(),
        quote: "Non-suji 4,5,6 tiles are the most dangerous because they can be caught by two \
                different suji waits"
            .to_string(),
        citation: ch8(CH8_RANKING, 325, "4,5,6 tiles are the most dangerous"),
        applies,
    }
}

/// Why the next-best tile cannot be confused with the answer.
///
/// The ranking lesson is built so the hand's second-best tile is exactly one
/// row down `tbl:safety`; that gap is what makes the answer learnable instead
/// of a pile of equally-wrong alternatives.
fn runner_up_rule(
    state: &GameState,
    facts: &crate::safety::SafetyFacts,
    answer: Tile,
    answer_text: &str,
) -> BookRule {
    let mut distinct: Vec<Tile> = state
        .tiles
        .iter()
        .filter_map(|code| Tile::try_from(code.as_str()).ok())
        .collect();
    distinct.sort();
    distinct.dedup();

    let runner = distinct
        .into_iter()
        .filter(|tile| *tile != answer)
        .min_by_key(|tile| facts.rank(*tile).order());

    let applies = match runner {
        Some(runner) => {
            let read = facts.read(runner);
            format!(
                "{} is Rank {} ({}), exactly one row below {answer_text}; every other tile is \
                 further down the table.",
                format_tile_for_display(&runner.to_string(), false),
                read.rank.code(),
                read.rank.label()
            )
        }
        None => format!("{answer_text} is the only tile left to compare."),
    };

    BookRule {
        id: "runner_up_row".to_string(),
        rule: "The second-best tile is exactly one row down the chart, so the answer's rank is \
               the only thing separating the two discards."
            .to_string(),
        quote: "No chance $>$ Double one chance $>$ One chance (earlier turns) $>$ One chance \
                (later turns) $\\simeq$ Non-{\\jap suji}"
            .to_string(),
        citation: ch8(CH8_BLOCKADE_RANKING, 263, "No chance $>$ Double one chance"),
        applies,
    }
}

/// The book's push threshold for a hand this far from ready.
///
/// Ch. 8, "Defense against riichi": a 1-away hand may push with Rank C or
/// safer, and a 2-away-or-worse hand only with Rank B or safer.
fn push_threshold(shanten: i8) -> SafetyRank {
    if shanten <= 1 {
        SafetyRank::C
    } else {
        SafetyRank::B
    }
}

/// The book's push threshold for a hand that is 1-away or worse.
fn push_fold_rule(
    state: &GameState,
    read: &crate::safety::TileRead,
    answer_text: &str,
) -> BookRule {
    let threshold = push_threshold(state.shanten);

    if read.rank.order() > threshold.order() {
        return BookRule {
            id: "betaori".to_string(),
            rule: format!(
                "A {}-away hand may only push with Rank {} or safer; with nothing that safe you \
                 fold completely.",
                state.shanten,
                threshold.code()
            ),
            quote: "If you cannot satisfy the above criteria, you must completely fold (betaori)."
                .to_string(),
            citation: ch8(
                CH8_VS_RIICHI,
                340,
                "If you cannot satisfy the above criteria",
            ),
            applies: format!(
                "The hand is {}-away and the safest tile is Rank {}.",
                state.shanten,
                read.rank.code()
            ),
        };
    }

    let (quote, citation) = if state.shanten <= 1 {
        (
            "you can discard Rank C or safer tiles".to_string(),
            ch8(CH8_VS_RIICHI, 336, "1-away from ready"),
        )
    } else {
        (
            "you can discard Rank B or safer tiles".to_string(),
            ch8(CH8_VS_RIICHI, 338, "2-away from ready or worse"),
        )
    };

    BookRule {
        id: "push_threshold".to_string(),
        rule: format!(
            "A {}-away hand may push with Rank {} or safer.",
            state.shanten,
            threshold.code()
        ),
        quote,
        citation,
        applies: format!(
            "The hand is {}-away and {answer_text} is Rank {}, inside the book's push threshold.",
            state.shanten,
            read.rank.code()
        ),
    }
}

/// The chapter's fallback list, as it applies to the answer.
fn stuck_rule_set(
    facts: &crate::safety::SafetyFacts,
    state: &GameState,
    answer: Tile,
    answer_text: &str,
) -> Vec<BookRule> {
    let hand = hand_counts(state);
    let indicators: Vec<Tile> = state
        .dora_indicators
        .iter()
        .filter_map(|code| Tile::try_from(code.as_str()).ok())
        .collect();
    let flags = facts.stuck_rules(answer, &hand, &indicators);

    let mut rules = Vec::new();

    if flags.pair_or_set {
        rules.push(BookRule {
            id: "pair_or_set".to_string(),
            rule: "Discard from a pair or a concealed set first: once one copy is passed, the \
                   other is safe for the next turn or two."
                .to_string(),
            quote: "Discard pairs and concealed sets.".to_string(),
            citation: ch8(CH8_STUCK, 348, "Discard pairs and concealed sets."),
            applies: format!(
                "You hold two copies of {answer_text}; the copy you keep is your follow-up \
                 discard."
            ),
        });
    }

    if flags.outside_early {
        rules.push(BookRule {
            id: "outside_early_discards".to_string(),
            rule: "Tiles that are outside the opponent's early discards are relatively safe."
                .to_string(),
            quote: "Tiles that are outside those discarded in ``early'' turns are relatively safe."
                .to_string(),
            citation: ch8(CH8_STUCK, 355, "outside those discarded"),
            applies: format!(
                "{} went early, so {answer_text} is outside the opponent's early discards.",
                early_protectors(facts, answer)
            ),
        });
    }

    if flags.avoids_dora {
        rules.push(BookRule {
            id: "avoid_dora".to_string(),
            rule: "Do not discard the dora, its indicator, or a tile next to it.".to_string(),
            quote: "try not to discard the dora indicator tile (when dora is a number tile) and \
                    any tiles close to dora, as well as the dora tile itself."
                .to_string(),
            citation: ch8(CH8_STUCK, 352, "try not to discard the"),
            applies: format!("{answer_text} is neither the dora nor next to it."),
        });
    }

    if flags.avoids_tanyao {
        rules.push(BookRule {
            id: "avoid_tanyao".to_string(),
            rule: "A terminal cannot deal into a tanyao hand.".to_string(),
            quote: "If you discard terminals, you can avoid dealing into a tanyao (All Simples) \
                    hand."
                .to_string(),
            citation: ch8(CH8_STUCK, 351, "avoid dealing into a"),
            applies: format!("{answer_text} is a terminal."),
        });
    }

    rules
}

/// The early discards that cover every protorun waiting for `answer`.
fn early_protectors(facts: &crate::safety::SafetyFacts, answer: Tile) -> String {
    let (Some(suit), Some(value)) = (answer.suit(), answer.value()) else {
        return "an early discard".to_string();
    };

    let mut protectors: Vec<Tile> = facts
        .early_discards
        .iter()
        .copied()
        .filter(|tile| tile.suit() == Some(suit))
        .filter(|tile| {
            tile.value()
                .is_some_and(|protector| protector != value && protector.abs_diff(value) <= 2)
        })
        .collect();
    protectors.sort();
    protectors.dedup();

    if protectors.is_empty() {
        return "an early discard".to_string();
    }

    protectors
        .iter()
        .map(|tile| format_tile_for_display(&tile.to_string(), false))
        .collect::<Vec<_>>()
        .join(" and ")
}

/// Every other tile the learner could click, with the rank it sits on.
fn absent_tiles(
    facts: &crate::safety::SafetyFacts,
    state: &GameState,
    answer: Tile,
) -> Vec<AbsentRule> {
    let mut tiles: Vec<Tile> = state
        .tiles
        .iter()
        .filter_map(|code| Tile::try_from(code.as_str()).ok())
        .collect();
    tiles.sort();
    tiles.dedup();
    tiles.retain(|tile| *tile != answer);

    let answer_rank = facts.rank(answer);
    let mut ranked: Vec<(crate::safety::SafetyRank, Tile)> = tiles
        .into_iter()
        .map(|tile| (facts.rank(tile), tile))
        .collect();
    ranked.sort_by_key(|(rank, tile)| (rank.order(), *tile));
    ranked.truncate(6);

    ranked
        .into_iter()
        .map(|(rank, tile)| {
            let equivalent = state
                .equivalent_tiles
                .iter()
                .any(|entry| entry == &tile.to_string());
            let comparison = match rank.order().cmp(&answer_rank.order()) {
                std::cmp::Ordering::Less => {
                    "the chart ranks it above the answer, but the fallback list decides"
                }
                std::cmp::Ordering::Equal if equivalent => {
                    "the same 100% row as the answer: both are genbutsu, so either discard is \
                     correct"
                }
                std::cmp::Ordering::Equal => "the same row as the answer, but not the pick",
                std::cmp::Ordering::Greater => "more dangerous than the answer",
            };

            AbsentRule {
                id: tile.to_string(),
                note: format!(
                    "{} · Rank {} ({}) — {comparison}.",
                    format_tile_for_display(&tile.to_string(), false),
                    rank.code(),
                    rank.label()
                ),
            }
        })
        .collect()
}

/// The middle tiles (`x+1` in `x, x+1, x+1, x+2`) of every bulging float in the
/// hand, in tile order.
///
/// Only the concealed hand is searched: the ready lesson's open Yakuhai Pon can
/// never form a bulge, and the generator builds one bulge per hand.
fn bulge_middles(state: &GameState) -> Vec<Tile> {
    let counts = hand_counts(state);
    let mut middles = Vec::new();
    for suit in [Suit::Man, Suit::Pin, Suit::Sou] {
        for base in 1..=7u8 {
            let low = Tile::Suited { suit, value: base };
            let mid = Tile::Suited {
                suit,
                value: base + 1,
            };
            let high = Tile::Suited {
                suit,
                value: base + 2,
            };
            let count = |tile: &Tile| counts.get(tile).copied().unwrap_or(0);
            if count(&low) >= 1 && count(&mid) >= 2 && count(&high) >= 1 {
                middles.push(mid);
            }
        }
    }
    middles
}

fn hand_counts(state: &GameState) -> std::collections::HashMap<Tile, u8> {
    let mut counts = std::collections::HashMap::new();
    let Some(human) = human(state) else {
        return counts;
    };

    let codes = human.hand.iter().chain(human.draw.iter());
    for code in codes {
        if let Ok(tile) = Tile::try_from(code.as_str()) {
            *counts.entry(tile).or_insert(0) += 1;
        }
    }

    counts
}

/// Grade a `CorrectActionType` mismatch as text, used by the UI's "should be"
/// line without re-deriving rules in React.
pub fn action_type_label(action: CorrectActionType) -> &'static str {
    match action {
        CorrectActionType::Riichi => "Riichi",
        CorrectActionType::Dama => "Dama",
        CorrectActionType::Fold => "Fold",
        CorrectActionType::Kan => "Kan",
        CorrectActionType::Discard => "No Kan",
        CorrectActionType::Pass => "Pass",
        CorrectActionType::Call => "Call",
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
            RiichiTrigger::HasExtraHan,
            RiichiTrigger::GoodWait,
            RiichiTrigger::ThreeLiveWinningTiles,
            RiichiTrigger::HonorTerminalWait,
            RiichiTrigger::Tanyao,
            RiichiTrigger::RedFiveWait,
            RiichiTrigger::SujiTrap,
            RiichiTrigger::ImmediateSujiTrap,
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
            DamaReason::BadWait,
            DamaReason::NoExtraHan,
            DamaReason::FewLiveWinningTiles,
            DamaReason::MiddleWait,
            DamaReason::Mangan,
            DamaReason::HanemanPlus,
            DamaReason::EarlyTurn,
            DamaReason::ImprovingHand,
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
    fn nakabukure_hand_gets_a_rationale_for_each_answer() {
        // The drill now mixes the ready-hand drop with the 1-away keep and
        // break hands, so the rationale has to follow whichever hand comes up.
        let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();

        for _ in 0..200 {
            let state = generate_puzzle("nakabukure_ready").expect("nakabukure must generate");
            let rationale = rationale_for(&state).expect("nakabukure needs a rationale");
            assert!(rationale.absent.is_empty());
            assert!(rationale.rules.iter().all(|rule| !rule.applies.is_empty()));
            assert!(!rationale.caveats.is_empty());

            let answer =
                Tile::try_from(state.correct_action.tile().expect("answer tile")).expect("tile");
            let middles = bulge_middles(&state);
            let kind = if !state.players[0].melds.is_empty() {
                "ready"
            } else if middles.contains(&answer) {
                "break"
            } else {
                "keep"
            };
            seen.insert(kind);

            let ids: Vec<&str> = rationale
                .rules
                .iter()
                .map(|rule| rule.id.as_str())
                .collect();
            match kind {
                "ready" => {
                    assert_eq!(state.shanten, 0);
                    assert_eq!(
                        ids,
                        vec![
                            "bulge_pair_wait",
                            "discard_the_bulge",
                            "keep_until_one_away"
                        ]
                    );
                    assert_eq!(rationale.source.chapter, 3);
                    assert_eq!(rationale.source.section, "Bulging float (nakabukure) shape");

                    let discard = state.correct_action.tile().expect("answer tile");
                    let wait = state.ukeire_tiles.first().expect("wait tile");
                    assert!(
                        rationale.rules[1]
                            .applies
                            .contains(&format_tile_for_display(discard, false)),
                        "the answer rule must name the discard"
                    );
                    assert!(
                        rationale.rules[1]
                            .applies
                            .contains(&format_tile_for_display(wait, false)),
                        "the answer rule must name the wait"
                    );
                }
                "keep" => {
                    assert_eq!(state.shanten, 1);
                    assert!(ids.contains(&"keep_the_bulge"));
                    assert_eq!(rationale.source.chapter, 3);
                    assert!(rationale.summary.contains("Keep the bulging float"));
                }
                "break" => {
                    assert_eq!(state.shanten, 1);
                    assert!(ids.contains(&"rival_block_became_decent"));
                    assert_eq!(rationale.source.chapter, 4);
                    assert!(rationale.summary.contains("Break the bulging float"));
                }
                other => panic!("unexpected nakabukure shape {other}"),
            }
        }

        assert_eq!(
            seen.len(),
            3,
            "200 draws must cover the ready, keep, and break hands: {seen:?}"
        );
    }

    #[test]
    fn protorun_priority_hand_names_the_closed_wait() {
        let state = generate_puzzle("protorun_priority").expect("protorun priority must generate");

        let rationale = rationale_for(&state).expect("protorun priority needs a rationale");

        assert_eq!(rationale.rules.len(), 3);
        assert!(rationale.absent.is_empty());
        assert!(rationale.rules.iter().all(|rule| !rule.applies.is_empty()));
        assert_eq!(rationale.source.chapter, 3);
        assert_eq!(rationale.source.section, "Protoruns (taatsu)");
        assert!(!rationale.caveats.is_empty());

        let discard = state.correct_action.tile().expect("answer tile");
        let equivalent = state
            .equivalent_tiles
            .first()
            .expect("the closed wait's other tile");
        let discard_name = format_tile_for_display(discard, false);
        let equivalent_name = format_tile_for_display(equivalent, false);
        assert!(
            rationale.rules[0].applies.contains(&discard_name),
            "the answer rule must name the discard"
        );
        assert!(
            rationale.rules[1].applies.contains(&discard_name)
                && rationale.rules[1].applies.contains(&equivalent_name),
            "the ranking rule must name both closed-wait tiles"
        );

        let ids: Vec<&str> = rationale
            .rules
            .iter()
            .map(|rule| rule.id.as_str())
            .collect();
        assert_eq!(
            ids,
            vec![
                "side_wait_acceptance",
                "protorun_ranking",
                "closed_wait_ceiling"
            ]
        );
    }

    #[test]
    fn protorun_priority_explains_why_either_closed_wait_tile_is_the_same_discard() {
        use agari::parse::{parse_hand, to_counts};
        use agari::shanten::calculate_ukeire;

        for _ in 0..10 {
            let state =
                generate_puzzle("protorun_priority").expect("protorun priority must generate");
            let rationale = rationale_for(&state).expect("protorun priority needs a rationale");

            let discard = state
                .correct_action
                .tile()
                .expect("answer tile")
                .to_string();
            let equivalent = state
                .equivalent_tiles
                .first()
                .expect("the closed wait's other tile")
                .clone();
            let discard_name = format_tile_for_display(&discard, false);
            let equivalent_name = format_tile_for_display(&equivalent, false);

            // The visible summary and ranking text must name the pair the
            // player is choosing between, not just the named answer tile.
            assert!(
                rationale.summary.contains(&discard_name)
                    && rationale.summary.contains(&equivalent_name),
                "the summary must name both closed-wait tiles: {}",
                rationale.summary
            );
            let ranking = rationale
                .rules
                .iter()
                .find(|rule| rule.id == "protorun_ranking")
                .expect("the ranking rule must exist");
            assert!(
                ranking.applies.contains(&discard_name)
                    && ranking.applies.contains(&equivalent_name),
                "the ranking rule must name both closed-wait tiles: {}",
                ranking.applies
            );
            assert!(
                ranking.applies.contains("same")
                    && ranking.applies.contains(&state.ukeire_total.to_string()),
                "the ranking rule must state that both discards keep the same acceptance: {}",
                ranking.applies
            );
            assert!(
                rationale
                    .caveats
                    .iter()
                    .any(|caveat| caveat.contains(&discard_name)
                        && caveat.contains(&equivalent_name)),
                "the caveat must name both closed-wait tiles: {:?}",
                rationale.caveats
            );

            // Recompute both acceptances: the explanation's claim is that
            // discarding either tile leaves the same 1-away shape.
            let acceptance = |tile: &str| {
                let mut remaining = state.tiles.clone();
                let index = remaining
                    .iter()
                    .position(|held| held == tile)
                    .expect("discard tile must be in the full hand");
                remaining.remove(index);
                let tiles = parse_hand(&remaining.join("")).expect("13-tile hand must parse");
                calculate_ukeire(&to_counts(&tiles)).total_count
            };
            let answer_acceptance = acceptance(&discard);
            let twin_acceptance = acceptance(&equivalent);
            assert_eq!(answer_acceptance, state.ukeire_total);
            assert_eq!(
                twin_acceptance, answer_acceptance,
                "discarding {equivalent} must keep the same acceptance as {discard}"
            );
            assert!(
                rationale.summary.contains(&answer_acceptance.to_string()),
                "the summary must state the shared acceptance: {}",
                rationale.summary
            );
        }
    }

    #[test]
    fn ryankan_break_hand_cites_the_wait_quality_instruction() {
        let state = generate_puzzle("ryankan_break").expect("ryankan break must generate");

        let rationale = rationale_for(&state).expect("ryankan break needs a rationale");

        assert_eq!(rationale.rules.len(), 3);
        assert!(rationale.absent.is_empty());
        assert!(rationale.rules.iter().all(|rule| !rule.applies.is_empty()));
        assert_eq!(rationale.source.chapter, 3);
        assert_eq!(rationale.source.section, "Double closed (ryankan) shape");
        assert!(!rationale.caveats.is_empty());

        let ids: Vec<&str> = rationale
            .rules
            .iter()
            .map(|rule| rule.id.as_str())
            .collect();
        assert_eq!(
            ids,
            vec![
                "ryankan_definition",
                "ryankan_gets_worse",
                "keep_the_new_side_wait"
            ]
        );

        let discard = state.correct_action.tile().expect("answer tile");
        assert!(
            rationale.rules[2].applies.contains(discard),
            "the answer rule must name the discard"
        );
        assert!(
            rationale
                .caveats
                .iter()
                .any(|caveat| caveat.contains("high ryankan terminal")),
            "the caveat must say why the other terminal is not equivalent"
        );
    }

    #[test]
    fn pair_count_hand_cites_the_three_pair_arithmetic() {
        let state = generate_puzzle("pair_count").expect("pair count must generate");

        let rationale = rationale_for(&state).expect("pair count needs a rationale");

        assert_eq!(rationale.rules.len(), 3);
        assert!(rationale.absent.is_empty());
        assert!(rationale.rules.iter().all(|rule| !rule.applies.is_empty()));
        assert_eq!(rationale.source.chapter, 3);
        assert_eq!(rationale.source.section, "Pairs and sets");

        let ids: Vec<&str> = rationale
            .rules
            .iter()
            .map(|rule| rule.id.as_str())
            .collect();
        assert_eq!(
            ids,
            vec![
                "avoid_three_pairs",
                "pair_count_ranking",
                "pair_or_protorun"
            ]
        );

        let discard = state.correct_action.tile().expect("answer tile");
        assert!(
            rationale.rules[2].applies.contains(discard),
            "the arithmetic rule must name the discard"
        );
        assert!(
            rationale.rules[2]
                .applies
                .contains(&state.ukeire_total.to_string()),
            "the arithmetic rule must quote the live acceptance"
        );
        assert!(
            rationale
                .caveats
                .iter()
                .any(|caveat| caveat.contains("three pairs beat two")),
            "the caveat must name the open-hand inversion"
        );
    }

    #[test]
    fn pair_count_open_hand_shows_the_pon_comparison() {
        let state = generate_puzzle("pair_count_open").expect("pair count open must generate");

        let rationale = rationale_for(&state).expect("pair count open needs a rationale");

        assert_eq!(rationale.rules.len(), 4);
        assert!(rationale.absent.is_empty());
        assert!(rationale.rules.iter().all(|rule| !rule.applies.is_empty()));
        assert_eq!(rationale.source.chapter, 3);
        assert_eq!(rationale.source.section, "Pairs and sets");
        assert!(rationale.summary.contains("Keep three pairs"));
        assert!(
            rationale
                .caveats
                .iter()
                .any(|caveat| caveat.contains("opposite")),
            "the explanation must say the closed variant grades the other way"
        );

        let ids: Vec<&str> = rationale
            .rules
            .iter()
            .map(|rule| rule.id.as_str())
            .collect();
        assert_eq!(
            ids,
            vec![
                "three_pairs_when_ponning",
                "two_pairs_after_pon",
                "closed_arithmetic",
                "keep_the_side_wait"
            ]
        );

        let discard = state.correct_action.tile().expect("answer tile");
        assert!(
            rationale.rules[0]
                .applies
                .contains(&format_tile_for_display(discard, false)),
            "the open-hand rule must name the discard"
        );
        assert!(
            rationale.rules[2]
                .applies
                .contains(&state.ukeire_total.to_string()),
            "the arithmetic rule must show the closed acceptance"
        );
        assert!(
            state
                .scenario_note
                .as_deref()
                .is_some_and(|note| note.contains("Pon")),
            "the plan must be visible before the answer"
        );
    }

    #[test]
    fn generated_book_scenarios_carry_a_rationale() {
        for category in [
            "ryanmen_protorun",
            "nakabukure_ready",
            "protorun_priority",
            "ryankan_break",
            "pair_count",
            "pair_count_open",
            "chiitoitsu_riichi_vs_dama",
            "riichi_judgement",
            "shouminkan_decision",
            "ankan_decision",
            "daiminkan_decision",
            "wind_discard_order",
            "fold_to_riichi",
            "push_or_fold",
            "defense_safety_chart",
            "suji_kabe_safety",
            "defense_stuck_heuristic",
            "open_hand_defense",
            "suji_trap_riichi",
            "pinfu_head",
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
    fn generated_rationales_never_show_raw_tile_codes() {
        for category in [
            "ryanmen_protorun",
            "nakabukure_ready",
            "protorun_priority",
            "pair_count",
            "pair_count_open",
            "chiitoitsu_riichi_vs_dama",
            "riichi_judgement",
            "shouminkan_decision",
            "ankan_decision",
            "wind_discard_order",
            "fold_to_riichi",
            "push_or_fold",
            "defense_safety_chart",
            "suji_kabe_safety",
            "defense_stuck_heuristic",
            "open_hand_defense",
            "suji_trap_riichi",
            "pinfu_head",
        ] {
            for _ in 0..10 {
                let state = generate_puzzle(category).expect("scenario must generate");
                let rationale = state
                    .book_rationale
                    .expect("scenario must carry a rationale");

                let mut texts = vec![rationale.summary];
                for rule in &rationale.rules {
                    texts.push(rule.rule.clone());
                    texts.push(rule.applies.clone());
                }
                for absent in &rationale.absent {
                    texts.push(absent.note.clone());
                }
                texts.extend(rationale.caveats);

                for text in texts {
                    assert!(
                        !has_raw_honor_code(&text),
                        "{category} rationale must not show an honor code: {text}"
                    );
                    assert!(
                        !text.contains("(red)"),
                        "{category} rationale must use the R5 name, not a red suffix: {text}"
                    );
                }
            }
        }
    }

    /// True for the internal `1z`..`7z` codes that must never reach display text.
    fn has_raw_honor_code(text: &str) -> bool {
        let bytes = text.as_bytes();
        bytes
            .windows(2)
            .any(|pair| (b'1'..=b'7').contains(&pair[0]) && pair[1] == b'z')
    }

    #[test]
    fn riichi_judgement_rationale_follows_the_three_condition_rule() {
        let mut saw_riichi = false;
        let mut saw_dama = false;

        for _ in 0..40 {
            let state = generate_puzzle("riichi_judgement").expect("scenario must generate");
            let rationale = state.book_rationale.clone().expect("rationale");

            assert_eq!(rationale.source.chapter, 7);
            assert!(
                rationale
                    .caveats
                    .iter()
                    .any(|caveat| caveat.contains("not modelled")),
                "the lesson must say which ch7 dama cases it leaves out"
            );

            if state.riichi_triggers.is_empty() {
                saw_dama = true;
                assert!(rationale.summary.contains("Stay in dama"));
                assert_eq!(rationale.rules.len(), 3);
                assert!(
                    rationale
                        .caveats
                        .iter()
                        .any(|caveat| caveat.contains("tsumo")),
                    "a riichi-only dama hand can only win by tsumo"
                );
            } else {
                saw_riichi = true;
                assert!(rationale.summary.contains("Declare Riichi"));
                assert!(!rationale.rules.is_empty());
            }
        }

        assert!(saw_riichi && saw_dama);
    }

    #[test]
    fn dama_bad_wait_rationale_cites_the_bad_wait_box() {
        let mut saw_many = false;
        let mut saw_honor = false;
        let mut saw_dama = false;

        for _ in 0..120 {
            let state = generate_puzzle("dama_bad_wait").expect("scenario must generate");
            let rationale = state.book_rationale.clone().expect("rationale");

            assert_eq!(rationale.source.chapter, 7);
            assert_eq!(rationale.source.section, "Bad wait");
            assert!(
                rationale
                    .caveats
                    .iter()
                    .any(|caveat| caveat.contains("live winning-tile count")),
                "the lesson must say the count decides"
            );

            if state
                .riichi_triggers
                .contains(&RiichiTrigger::ThreeLiveWinningTiles)
            {
                saw_many = true;
                assert!(
                    rationale
                        .summary
                        .contains("three or more live winning tiles")
                );
                assert_eq!(rationale.rules.len(), 1);
                assert_eq!(rationale.rules[0].id, "three_live_winning_tiles");
            } else if state
                .riichi_triggers
                .contains(&RiichiTrigger::HonorTerminalWait)
            {
                saw_honor = true;
                assert!(rationale.summary.contains("honor or terminal"));
                assert_eq!(rationale.rules.len(), 1);
                assert_eq!(rationale.rules[0].id, "honor_terminal_wait");
            } else {
                saw_dama = true;
                assert!(rationale.summary.contains("one or two live simple"));
                let ids: Vec<&str> = rationale
                    .rules
                    .iter()
                    .map(|rule| rule.id.as_str())
                    .collect();
                assert_eq!(
                    ids,
                    vec![
                        "not_dealer",
                        "bad_wait",
                        "no_extra_han",
                        "few_live_winning_tiles"
                    ]
                );
                assert!(
                    rationale
                        .caveats
                        .iter()
                        .any(|caveat| caveat.contains("tsumo")),
                    "a riichi-only dama hand can only win by tsumo"
                );
            }

            if saw_many && saw_honor && saw_dama {
                break;
            }
        }

        assert!(saw_many && saw_honor && saw_dama);
    }

    #[test]
    fn decline_lesson_gets_a_category_rationale() {
        let mut decline = None;
        for _ in 0..80 {
            let state = generate_puzzle("shouminkan_decision").expect("lesson must generate");
            if state.correct_action.action_type() == CorrectActionType::Discard {
                decline = Some(state);
                break;
            }
        }
        let state = decline.expect("the merged lesson must sometimes ask for the discard");

        let rationale = rationale_for(&state).expect("decline needs a rationale");

        assert_eq!(rationale.rules.len(), 1);
        assert_eq!(rationale.rules[0].id, "decline_kakan");
        assert_eq!(rationale.source.chapter, 9);
        assert!(rationale.rules[0].applies.contains("discarding"));
        assert!(!rationale.caveats.is_empty());

        // Old saved reports still carry the retired category id.
        let mut legacy = state;
        legacy.category = "shouminkan_decline".to_string();
        let legacy_rationale = rationale_for(&legacy).expect("old reports keep their rationale");
        assert_eq!(legacy_rationale.rules[0].id, "decline_kakan");
    }

    #[test]
    fn chiitoitsu_rationale_states_the_discard_rule() {
        let mut saw_twin = false;
        let mut saw_red_five = false;

        for _ in 0..300 {
            let state =
                generate_puzzle("chiitoitsu_riichi_vs_dama").expect("chiitoitsu must generate");
            let rationale = rationale_for(&state).expect("chiitoitsu needs a rationale");

            if state.equivalent_tiles.is_empty() {
                saw_red_five = true;
                assert!(
                    rationale
                        .caveats
                        .iter()
                        .any(|caveat| caveat.contains("red five")),
                    "the red-five lesson must say the kept red five is the answer"
                );
            } else {
                saw_twin = true;
                assert_eq!(
                    state.equivalent_tiles.len(),
                    1,
                    "the twin discard is the only equivalent tile"
                );
                assert!(
                    rationale
                        .caveats
                        .iter()
                        .any(|caveat| caveat.contains("Either can be discarded")),
                    "the twin lesson must state why both lone tiles are graded correct"
                );
            }

            if saw_twin && saw_red_five {
                break;
            }
        }

        assert!(
            saw_twin && saw_red_five,
            "both discard models should be generated"
        );
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
    fn ankan_rationale_cites_the_quad_conditions_and_the_floating_tile() {
        let mut seen_kan = false;
        let mut seen_decline = false;

        for _ in 0..60 {
            let state = generate_puzzle("ankan_decision").expect("lesson must generate");
            let rationale = rationale_for(&state).expect("ankan needs a rationale");
            assert_eq!(rationale.source.chapter, 9);
            assert_eq!(rationale.source.section, "Concealed quad (ankan)");

            match state.correct_action.action_type() {
                CorrectActionType::Kan => {
                    seen_kan = true;
                    assert!(
                        rationale.summary.starts_with("Call the concealed quad"),
                        "unexpected summary: {}",
                        rationale.summary
                    );
                    assert_eq!(rationale.rules[0].id, "kan_judgement_1");
                    assert!(
                        matches!(
                            rationale.rules[1].id.as_str(),
                            "one_away_good_wait" | "two_away_all_good_waits"
                        ),
                        "unexpected condition id: {}",
                        rationale.rules[1].id
                    );
                    assert!(rationale.rules[1].quote.contains("away"));
                }
                CorrectActionType::Discard => {
                    seen_decline = true;
                    assert!(
                        rationale.summary.starts_with("Keep the four"),
                        "unexpected summary: {}",
                        rationale.summary
                    );
                    assert_eq!(rationale.rules[0].id, "floating_tile");
                    assert!(rationale.rules[0].quote.contains("good floating tile"));
                    assert_eq!(
                        rationale.rules[1].id, "not_even_when_ready",
                        "the second judgement is what overrides the quad conditions"
                    );
                    assert!(
                        rationale.rules[0].applies.contains(" / "),
                        "the floating copy's accepting tiles must be listed: {}",
                        rationale.rules[0].applies
                    );
                }
                other => panic!("unexpected ankan answer {other:?}"),
            }
        }

        assert!(seen_kan && seen_decline, "both halves must be covered");
    }

    #[test]
    fn daiminkan_rationale_cites_the_three_situations_and_the_two_boxes() {
        let mut seen_kan = false;
        let mut seen_pass = false;
        let mut seen_band = false;
        let mut seen_placement = false;
        let mut seen_losing = false;

        for _ in 0..160 {
            let state = generate_puzzle("daiminkan_decision").expect("lesson must generate");
            let rationale = rationale_for(&state).expect("daiminkan needs a rationale");
            assert_eq!(rationale.source.chapter, 9);
            assert_eq!(rationale.source.section, "Open quad (daiminkan)");
            assert_eq!(rationale.rules[0].id, "open_quad_conditions");
            assert!(rationale.rules[0].quote.contains("open quad"));

            let facts = crate::generator::daiminkan_facts(&state).expect("facts");
            match state.correct_action.action_type() {
                CorrectActionType::Kan => {
                    seen_kan = true;
                    assert!(
                        rationale.summary.starts_with("Call the open quad"),
                        "unexpected summary: {}",
                        rationale.summary
                    );
                    assert!(rationale.rules.len() >= 2);
                    assert!(
                        rationale.rules[0]
                            .applies
                            .contains(&facts.value.to_string())
                    );
                    let ids: Vec<&str> = rationale
                        .rules
                        .iter()
                        .map(|rule| rule.id.as_str())
                        .collect();
                    assert!(
                        ids.iter().any(|id| matches!(
                            *id,
                            "good_wait_and_value" | "placement_desperation" | "losing_badly"
                        )),
                        "unexpected condition ids: {ids:?}"
                    );
                    seen_band |= ids.contains(&"good_wait_and_value");
                    seen_placement |= ids.contains(&"placement_desperation");
                    seen_losing |= ids.contains(&"losing_badly");
                }
                CorrectActionType::Pass => {
                    seen_pass = true;
                    assert!(
                        rationale.summary.starts_with("Pass on the"),
                        "unexpected summary: {}",
                        rationale.summary
                    );
                    assert!(matches!(
                        rationale.rules[1].id.as_str(),
                        "bad_wait" | "too_cheap"
                    ));
                    assert_eq!(
                        rationale.absent.len(),
                        2,
                        "both escapes are listed as absent"
                    );
                }
                other => panic!("unexpected daiminkan answer {other:?}"),
            }
        }

        assert!(seen_kan && seen_pass, "both halves must be covered");
        assert!(
            seen_band && seen_placement && seen_losing,
            "all three book situations must be explained"
        );
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
            RiichiTrigger::HasExtraHan,
            RiichiTrigger::GoodWait,
            RiichiTrigger::ThreeLiveWinningTiles,
            RiichiTrigger::HonorTerminalWait,
            RiichiTrigger::Tanyao,
            RiichiTrigger::RedFiveWait,
            RiichiTrigger::SujiTrap,
            RiichiTrigger::ImmediateSujiTrap,
            RiichiTrigger::WaitOutside456,
            RiichiTrigger::ScoreBelowMangan,
        ] {
            citations.push(trigger.rationale().citation);
        }
        for reason in [
            DamaReason::NotDealer,
            DamaReason::BadWait,
            DamaReason::NoExtraHan,
            DamaReason::FewLiveWinningTiles,
            DamaReason::GenbutsuWait,
            DamaReason::MiddleWait,
            DamaReason::Mangan,
            DamaReason::HanemanPlus,
            DamaReason::EarlyTurn,
            DamaReason::ImprovingHand,
        ] {
            citations.push(reason.rationale().expect("positive reason").citation);
        }
        for trigger in [
            ShouminkanTrigger::GoodWaitAndValue,
            ShouminkanTrigger::LateGame,
            ShouminkanTrigger::PlacementDesperation,
            ShouminkanTrigger::LosingBadly,
            ShouminkanTrigger::NeedsDora,
        ] {
            citations.push(trigger.rationale().citation);
        }

        for category in [
            "ryanmen_protorun",
            "nakabukure_ready",
            "protorun_priority",
            "ryankan_break",
            "pair_count",
            "pair_count_open",
            "riichi_judgement",
            "dama_bad_wait",
            "dama_genbutsu_wait",
            "shouminkan_decision",
            "meld_or_not",
            "ankan_decision",
            "daiminkan_decision",
            "wind_discard_order",
            "fold_to_riichi",
            "push_or_fold",
            "defense_safety_chart",
            "suji_kabe_safety",
            "defense_stuck_heuristic",
            "open_hand_defense",
            "suji_trap_riichi",
            "pinfu_head",
        ] {
            let state = generate_puzzle(category).expect("scenario must generate");
            citations.extend(
                rationale_for(&state)
                    .expect("rationale")
                    .rules
                    .into_iter()
                    .map(|rule| rule.citation),
            );
        }

        // The bulging-float drill serves three different rule sets, so one
        // draw could miss two of them; sample it until every answer is covered.
        for _ in 0..60 {
            let state = generate_puzzle("nakabukure_ready").expect("scenario must generate");
            citations.extend(
                rationale_for(&state)
                    .expect("rationale")
                    .rules
                    .into_iter()
                    .map(|rule| rule.citation),
            );
        }

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
    fn wind_discard_order_rationale_cites_the_seating_tip() {
        let state = generate_puzzle("wind_discard_order").expect("lesson must generate");
        let rationale = rationale_for(&state).expect("the seating tip needs a rationale");

        assert_eq!(rationale.source.chapter, 9);
        assert_eq!(rationale.source.section, "Be mindful of the seating");
        assert_eq!(
            rationale.source.source_needle,
            "discard the right player's wind first"
        );

        let ids: Vec<&str> = rationale
            .rules
            .iter()
            .map(|rule| rule.id.as_str())
            .collect();
        assert_eq!(
            ids,
            vec![
                "calls_move_turns",
                "shimocha_wind_first",
                "pon_from_you_skips_nobody",
                "pair_never_forms"
            ]
        );
        assert!(
            rationale
                .rules
                .iter()
                .all(|rule| rule.applies.contains("right player")
                    || rule.applies.contains("shimocha")
                    || rule.applies.contains("first discard")),
            "{:?}",
            rationale.rules
        );
        assert!(!rationale.summary.is_empty());
    }

    /// The seating tip's danger is a Pon the right player calls from our left
    /// player. A Pon on our own discard skips nobody, so the rationale must
    /// not promise a skipped turn for that case.
    #[test]
    fn wind_discard_rationale_pins_the_pon_source_of_the_skipped_turn() {
        let state = generate_puzzle("wind_discard_order").expect("lesson must generate");
        let rationale = rationale_for(&state).expect("the seating tip needs a rationale");

        let cost = rationale
            .rules
            .iter()
            .find(|rule| rule.id == "calls_move_turns")
            .expect("the seating cost must be stated");
        assert!(
            cost.applies.contains("from your left player"),
            "the skipped turn comes from the left player's discard: {}",
            cost.applies
        );

        let safe = rationale
            .rules
            .iter()
            .find(|rule| rule.id == "pon_from_you_skips_nobody")
            .expect("the harmless Pon source must be stated");
        assert!(
            safe.rule.contains("skips nobody"),
            "a Pon on our own discard must not be described as skipping a turn: {}",
            safe.rule
        );

        assert!(
            rationale
                .rules
                .iter()
                .any(|rule| rule.id == "pair_never_forms"),
            "the first-turn pair race must be stated"
        );
    }

    #[test]
    fn pinfu_head_rationale_cites_the_head_rule_for_every_answer() {
        let mut saw_dragon = false;
        let mut saw_table_wind = false;

        for run in 0..80 {
            let state = generate_puzzle("pinfu_head").expect("lesson must generate");
            let rationale = rationale_for(&state).expect("the head rule needs a rationale");

            assert_eq!(rationale.source.chapter, 5, "run {run}");
            assert_eq!(rationale.source.section, "Building the head", "run {run}");
            assert_eq!(
                rationale.source.source_needle,
                "the head must be a pair of number tiles or valueless wind tiles",
                "run {run}"
            );

            let ids: Vec<&str> = rationale
                .rules
                .iter()
                .map(|rule| rule.id.as_str())
                .collect();
            assert_eq!(
                ids,
                vec![
                    "pinfu_head_rule",
                    "value_honor_cannot_be_head",
                    "keep_terminals_and_winds"
                ],
                "run {run}"
            );

            let answer = state.correct_action.tile().expect("answer tile");
            let answer_name = format_tile_for_display(answer, false);
            assert!(
                rationale.summary.contains(&answer_name),
                "run {run}: {}",
                rationale.summary
            );
            assert!(
                rationale.rules[0].applies.contains("no committed head"),
                "run {run}: the head is still to be built"
            );
            assert!(
                rationale
                    .caveats
                    .iter()
                    .any(|caveat| caveat.contains("3 tiles kept")),
                "run {run}: the book's three keepers must be named"
            );
            assert!(
                rationale
                    .caveats
                    .iter()
                    .any(|caveat| caveat.contains("bulge")),
                "run {run}: the duplicate must be explained as the bulge"
            );
            assert!(
                rationale.rules[1].applies.contains(&answer_name)
                    && rationale.rules[1].applies.contains("value honor"),
                "run {run}: {}",
                rationale.rules[1].applies
            );
            assert!(
                rationale
                    .absent
                    .iter()
                    .any(|absent| absent.id == "yakuhai_head"),
                "run {run}: the yakuhai alternative must be named"
            );

            if matches!(answer, "5z" | "6z" | "7z") {
                saw_dragon = true;
                assert!(
                    rationale.rules[1].applies.contains("dragon"),
                    "run {run}: {}",
                    rationale.rules[1].applies
                );
            } else {
                saw_table_wind = true;
                assert!(
                    rationale.rules[1].applies.contains("round wind")
                        || rationale.rules[1].applies.contains("seat wind"),
                    "run {run}: {}",
                    rationale.rules[1].applies
                );
            }
        }

        assert!(saw_dragon, "a dragon answer must be generated");
        assert!(saw_table_wind, "a round/seat wind answer must be generated");
    }

    #[test]
    fn dama_genbutsu_wait_rationale_cites_the_genbutsu_section() {
        let state = generate_puzzle("dama_genbutsu_wait").expect("lesson must generate");
        let rationale = rationale_for(&state).expect("the genbutsu wait needs a rationale");

        assert_eq!(rationale.source.chapter, 7);
        assert_eq!(rationale.source.section, "Genbutsu wait");
        assert_eq!(
            rationale.source.source_needle,
            "one of your winning tiles is among their"
        );

        let ids: Vec<&str> = rationale
            .rules
            .iter()
            .map(|rule| rule.id.as_str())
            .collect();
        assert_eq!(ids, vec!["genbutsu_wait"]);
        assert!(
            rationale.rules[0].applies.contains("genbutsu"),
            "{}",
            rationale.rules[0].applies
        );
        assert!(rationale.summary.contains("dama"), "{}", rationale.summary);
        assert!(!rationale.absent.is_empty() || !rationale.caveats.is_empty());
    }

    /// The fold lesson cites the push/fold box, the betaori instruction, and —
    /// when the safe tile is Kamicha's declaration discard — the chapter's
    /// third absolute-safety kind.
    #[test]
    fn fold_to_riichi_cites_betaori_and_the_left_player_discard() {
        let mut saw_left_player = false;

        for _ in 0..80 {
            let state = generate_puzzle("fold_to_riichi").expect("fold must generate");
            let rationale = rationale_for(&state).expect("the fold needs a rationale");

            assert_eq!(rationale.source.chapter, 8);
            assert_eq!(rationale.source.section, "Defense against riichi");
            assert_eq!(rationale.source.source_line, 340);
            assert!(rationale.summary.contains("100%"), "{}", rationale.summary);

            let ids: Vec<&str> = rationale
                .rules
                .iter()
                .map(|rule| rule.id.as_str())
                .collect();
            for id in ["genbutsu", "fold_conditions", "low_scoring", "betaori"] {
                assert!(ids.contains(&id), "missing {id} in {ids:?}");
            }
            assert!(
                rationale
                    .rules
                    .iter()
                    .all(|rule| rule.citation.chapter == 8
                        && !rule.citation.source_needle.is_empty()),
                "{ids:?}"
            );

            // The answer is the hand's only 100% tile on the chart.
            let answer = Tile::try_from(
                state
                    .correct_action
                    .tile()
                    .expect("the fold answer names a tile"),
            )
            .expect("tile code");
            let threat = state
                .players
                .iter()
                .find(|player| player.is_riichi)
                .expect("one threat");
            let facts = SafetyFacts::from_state(&state, threat.seat).expect("facts");
            assert_eq!(facts.rank(answer), SafetyRank::Genbutsu);
            let human = state
                .players
                .iter()
                .find(|player| player.is_human)
                .expect("human");
            for code in human.hand.iter().chain(human.draw.iter()) {
                let tile = Tile::try_from(code.as_str()).expect("tile code");
                if tile != answer {
                    assert!(!facts.is_absolutely_safe(tile), "{tile} is also 100% safe");
                }
            }

            // The left-player rule only appears when it is true.
            let left_player = threat.seat == 3
                && threat
                    .discards
                    .last()
                    .is_some_and(|discard| discard.tile == answer.to_string());
            let cited = rationale
                .rules
                .iter()
                .find(|rule| rule.id == "left_player_discard");
            assert_eq!(left_player, cited.is_some(), "seat {}", threat.seat);
            if let Some(rule) = cited {
                saw_left_player = true;
                assert_eq!(rule.citation.source_line, 102);
                assert!(rule.applies.contains("Kamicha"));
            }
        }

        assert!(
            saw_left_player,
            "no board put the safe tile on Kamicha's declaration"
        );
    }

    #[test]
    fn defense_chart_lesson_cites_the_chart_and_ranks_the_alternatives() {
        let state = generate_puzzle("defense_safety_chart").expect("chart must generate");
        let rationale = rationale_for(&state).expect("defense needs a rationale");

        assert_eq!(rationale.source.chapter, 8);
        assert!(
            rationale
                .rules
                .iter()
                .any(|rule| rule.id == "safety_ranking")
        );
        assert!(
            rationale
                .rules
                .iter()
                .all(|rule| !rule.applies.is_empty() && !rule.citation.source_needle.is_empty())
        );
        assert!(!rationale.absent.is_empty(), "alternatives must be ranked");
        assert!(rationale.summary.contains("Rank"));
    }

    #[test]
    fn defense_fallback_lesson_lists_the_fallback_rules() {
        let state = generate_puzzle("defense_stuck_heuristic").expect("stuck must generate");
        let rationale = rationale_for(&state).expect("defense needs a rationale");

        assert_eq!(rationale.source.chapter, 8);
        assert!(rationale.rules.iter().any(|rule| rule.id == "pair_or_set"));
        assert!(
            rationale
                .rules
                .iter()
                .any(|rule| rule.id == "outside_early_discards")
        );
        assert!(rationale.summary.starts_with("Nothing reaches Rank B"));
        assert!(
            rationale
                .caveats
                .iter()
                .any(|caveat| caveat.contains("Rank C"))
        );
    }

    #[test]
    fn push_or_fold_cites_the_box_for_both_cells() {
        use crate::state::TargetAction;

        let mut saw_push = false;
        let mut saw_fold = false;
        for _ in 0..40 {
            let state = generate_puzzle("push_or_fold").expect("push/fold must generate");
            let rationale = rationale_for(&state).expect("push/fold needs a rationale");

            assert_eq!(rationale.source.chapter, 8);
            assert_eq!(rationale.source.source_line, 23);
            assert_eq!(rationale.rules[0].id, "push_fold_box");
            assert!(
                rationale
                    .rules
                    .iter()
                    .any(|rule| rule.id == "minimum_value"),
                "the 7700 value condition must be cited"
            );
            assert!(
                rationale.rules.iter().any(|rule| rule.id == "good_wait"
                    || rule.id == "bad_wait_in_worst_case"
                    || rule.id == "perfect_one_away"),
                "the wait condition must be cited"
            );
            assert!(
                rationale.absent.iter().any(|rule| rule.id == "ready_hand"),
                "a 1-away hand must say the ready condition does not hold"
            );

            match state.target_action {
                TargetAction::Push => {
                    saw_push = true;
                    assert!(rationale.summary.starts_with("Push"));
                    assert!(
                        rationale
                            .rules
                            .iter()
                            .any(|rule| rule.id == "mangan_rank_d")
                    );
                    assert!(
                        !rationale
                            .absent
                            .iter()
                            .any(|rule| rule.id == "high_scoring_hand")
                    );
                }
                TargetAction::Fold => {
                    saw_fold = true;
                    assert!(rationale.summary.starts_with("Fold"));
                    assert!(rationale.rules.iter().any(|rule| rule.id == "betaori"));
                    assert!(rationale.rules.iter().any(|rule| rule.id == "genbutsu"));
                }
                other => panic!("unexpected target action {other:?}"),
            }
        }
        assert!(saw_push && saw_fold, "both cells must be covered");
    }

    #[test]
    fn suji_trap_lesson_cites_the_immediate_trap_and_names_the_discard() {
        for _ in 0..20 {
            let state = generate_puzzle("suji_trap_riichi").expect("suji trap must generate");
            let rationale = rationale_for(&state).expect("suji trap needs a rationale");

            assert_eq!(rationale.source.chapter, 8);
            assert_eq!(rationale.source.section, "Suji trap");
            assert_eq!(rationale.source.source_line, 170);

            let rule = rationale
                .rules
                .iter()
                .find(|rule| rule.id == "immediate_suji_trap")
                .expect("the immediate-trap rule must be cited");
            assert!(rule.quote.contains("immediate"));
            assert!(!rule.applies.is_empty());
            assert!(rationale.summary.contains("trap"), "{}", rationale.summary);
            assert!(!rationale.caveats.is_empty());

            // The rule names the discard the player should declare on, in
            // display form rather than as a raw tile code.
            let discard = state.correct_action.tile().expect("answer tile");
            assert!(
                rule.applies
                    .contains(&format_tile_for_display(discard, false)),
                "{}",
                rule.applies
            );
        }
    }

    #[test]
    fn open_hand_defense_cites_the_chii_discard_rule_for_both_cases() {
        let mut saw_same_suit = false;
        let mut saw_different_suit = false;

        for _ in 0..120 {
            let state = generate_puzzle("open_hand_defense").expect("open hand must generate");
            let rationale = rationale_for(&state).expect("open hand needs a rationale");

            assert_eq!(rationale.source.chapter, 8);
            assert!(
                rationale
                    .rules
                    .iter()
                    .any(|rule| rule.id == "open_hand_ready")
            );

            let threat = state
                .players
                .iter()
                .find(|player| {
                    !player.is_human
                        && player
                            .melds
                            .iter()
                            .any(|meld| meld.meld_type == MeldType::Chi)
                })
                .expect("open hand threat");
            let last_chi = threat
                .melds
                .iter()
                .rev()
                .find(|meld| meld.meld_type == MeldType::Chi)
                .expect("last chii");
            let chi_suit = Tile::try_from(last_chi.tiles[0].as_str())
                .expect("chi tile")
                .suit()
                .expect("suited");
            let post_chi = Tile::try_from(threat.discards.last().expect("discard").tile.as_str())
                .expect("post-chi tile");

            if chi_suit == post_chi.suit().expect("suited") {
                saw_same_suit = true;
                assert!(
                    rationale
                        .rules
                        .iter()
                        .any(|rule| rule.id == "chii_same_suit"),
                    "same-suit board must cite the safe read"
                );
                assert!(rationale.summary.contains("relatively safe"));
                assert!(
                    rationale
                        .caveats
                        .iter()
                        .any(|caveat| caveat.contains("only neighbourhood tile"))
                );
            } else {
                saw_different_suit = true;
                assert!(
                    rationale
                        .rules
                        .iter()
                        .any(|rule| rule.id == "chii_different_suit"),
                    "trap board must cite the dangerous read"
                );
                assert!(
                    rationale.rules.iter().any(|rule| rule.id == "genbutsu"),
                    "trap board must explain the 100% answer"
                );
                assert!(rationale.summary.contains("100% safe"));
            }
        }

        assert!(saw_same_suit && saw_different_suit);
    }

    #[test]
    fn suji_kabe_rationale_names_the_runner_up_row() {
        for run in 0..25 {
            let state = generate_puzzle("suji_kabe_safety").expect("suji kabe must generate");
            let rationale = rationale_for(&state).expect("suji kabe needs a rationale");

            assert_eq!(rationale.source.chapter, 8);
            assert!(
                rationale
                    .summary
                    .contains("runner-up exactly one row worse")
            );
            assert!(
                rationale
                    .rules
                    .iter()
                    .any(|rule| rule.id == "suji" || rule.id == "no_chance"),
                "run {run}: the mechanism must be named"
            );
            let runner_up = rationale
                .rules
                .iter()
                .find(|rule| rule.id == "runner_up_row")
                .expect("the ranking gap must be explained");
            assert!(
                runner_up.applies.contains("exactly one row below"),
                "run {run}: {}",
                runner_up.applies
            );
            assert_eq!(runner_up.citation.source_line, 263);
        }
    }

    #[test]
    fn push_threshold_matches_the_book_bullets() {
        assert_eq!(push_threshold(0), SafetyRank::C);
        assert_eq!(push_threshold(1), SafetyRank::C);
        assert_eq!(push_threshold(2), SafetyRank::B);
        assert_eq!(push_threshold(4), SafetyRank::B);
    }

    #[test]
    fn action_type_labels_are_stable() {
        assert_eq!(action_type_label(CorrectActionType::Riichi), "Riichi");
        assert_eq!(action_type_label(CorrectActionType::Dama), "Dama");
        assert_eq!(action_type_label(CorrectActionType::Fold), "Fold");
        assert_eq!(action_type_label(CorrectActionType::Kan), "Kan");
        assert_eq!(action_type_label(CorrectActionType::Discard), "No Kan");
    }
}
