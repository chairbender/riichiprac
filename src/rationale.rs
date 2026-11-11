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

use agari::tile::Tile;

use crate::display::format_tile_for_display;
use crate::safety::{SafetyFacts, SafetyRank};
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

const CHIITOITSU_BOX: &str = "Chiitoitsu not waiting for dora";
/// Riichi Book 1, ch. 7, "To riichi or not to riichi?": the general
/// three-condition rule the `riichi_judgement` lesson grades.
const GENERAL_RULE: &str = "To riichi or not to riichi?";

const CH8_GENBUTSU: &str = "Genbutsu and other absolutely safe tiles";
const CH8_SUJI: &str = "Understanding suji";
const CH8_KABE: &str = "Understanding tile blockade";
const CH8_RANKING: &str = "Safety ranking";
const CH8_VS_RIICHI: &str = "Defense against riichi";
const CH8_STUCK: &str = "What to discard when you get stuck";

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
            | Self::Mangan => None,
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
        "shouminkan_decision" => Some(ch9(360, "From an open set to an open quad")),
        "wind_discard_order" => Some(ch9_seating(455, "discard the right player's wind first")),
        "ryanmen_protorun" => Some(ch4(44, "completely redundant")),
        "nakabukure_ready" => Some(ch3_bulging(681, "accept four kinds of tiles")),
        "protorun_priority" => Some(ch3(205, "can accept twice as many tiles")),
        "ryankan_break" => Some(ch3_ryankan(523, "break the double closed shape")),
        "pair_count" => Some(ch3_pairs(
            336,
            "we should avoid having three pairs in a hand",
        )),
        "defense_safety_chart" => Some(ch8(CH8_RANKING, 292, "Safety ranking")),
        "defense_stuck_heuristic" => {
            Some(ch8(CH8_STUCK, 344, "What to discard when you get stuck"))
        }
        _ => None,
    }
}

/// Lessons whose rule is not carried by a trigger enum.
fn category_rationale(state: &GameState) -> Option<BookRationale> {
    if let Some(defense) = defense_rationale(state) {
        return Some(defense);
    }

    if state.category == "wind_discard_order" {
        return wind_discard_rationale(state);
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
        let discard =
            format_tile_for_display(state.correct_action.tile().unwrap_or_default(), false);
        let wait = state
            .ukeire_tiles
            .first()
            .map(|code| format_tile_for_display(code, false))
            .unwrap_or_default();
        let drawn = human(state)
            .and_then(|player| player.draw.as_deref())
            .map(|code| format_tile_for_display(code, false))
            .unwrap_or_default();

        let rules = vec![
            BookRule {
                id: "bulge_pair_wait".to_string(),
                rule: "A bulging float left in a ready hand waits on its own middle tile, \
                       which the hand already holds twice, so only two winning tiles remain."
                    .to_string(),
                quote: "It is waiting for wan4, but we are already using two of it in the hand, \
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
                rule: "In a ready hand the bulge tile itself is the discard: dropping it leaves \
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
                quote: "Try to keep a bulging float shape until a hand becomes 1-away.".to_string(),
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

    if state.category == "protorun_priority" {
        let discard =
            format_tile_for_display(state.correct_action.tile().unwrap_or_default(), false);
        let equivalent = state
            .equivalent_tiles
            .first()
            .map(|code| format_tile_for_display(code, false))
            .unwrap_or_default();
        let waits = state
            .ukeire_tiles
            .iter()
            .map(|code| format_tile_for_display(code, false))
            .collect::<Vec<_>>()
            .join(" / ");

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
                     so the closed wait is the block the ranking discards."
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
            summary: "Break the closed-wait protorun: a side wait accepts twice as many tiles, \
                      so losing the closed wait keeps both 8-tile waits alive."
                .to_string(),
            rules,
            absent: Vec::new(),
            source: ch3(205, "can accept twice as many tiles"),
            caveats: vec![
                "Both tiles of the closed wait are the same discard; the trainer names the tile \
                 you drew and grades the other closed-wait tile as equal."
                    .to_string(),
            ],
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
            id: "call_benefits_right_player".to_string(),
            rule: "A call by the right player skips the facing player's turn and gives the \
                   right player an extra draw, so the right player's call is the one most \
                   worth denying."
                .to_string(),
            quote: "your act of calling pon/kan benefits the right player while penalizing the \
                    left and the facing players"
                .to_string(),
            citation: ch9_seating(440, "benefits the right player while penalizing"),
            applies: format!(
                "The right player's seat wind is {shimocha_wind:?}: a Pon on it would skip the \
                 facing player and hand the right player the extra draw."
            ),
        },
        BookRule {
            id: "shimocha_wind_first".to_string(),
            rule: "Of the valueless winds, throw the right player's wind first and the facing \
                   player's wind second."
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
            id: "discard_it_early".to_string(),
            rule: "A wind worth denying to the right player is thrown as early as possible, \
                   before they can pair it."
                .to_string(),
            quote: "you should do so sooner rather than later".to_string(),
            citation: ch9_seating(452, "sooner rather than later"),
            applies: "This is the first discard, so the wind leaves before anyone has shown a \
                      pair."
                .to_string(),
        },
    ];

    Some(BookRationale {
        summary: format!(
            "Discard the right player's wind ({answer}) first: a Pon on their wind is the call \
             the book most wants to deny."
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

/// The two pure-defense lessons: the ch. 8 safety chart and its fallback list.
fn defense_rationale(state: &GameState) -> Option<BookRationale> {
    let is_chart = state.category == "defense_safety_chart";
    let is_stuck = state.category == "defense_stuck_heuristic";
    if !is_chart && !is_stuck {
        return None;
    }

    let threat = state.players.iter().find(|player| player.is_riichi)?;
    let facts = crate::safety::SafetyFacts::from_state(state, threat.seat)?;
    let answer = Tile::try_from(state.correct_action.tile()?).ok()?;
    let answer_text = format_tile_for_display(&answer.to_string(), false);
    let read = facts.read(answer);

    let mut rules = Vec::new();
    let mut caveats = Vec::new();
    let summary = if is_chart {
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

    let source = if is_chart {
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
    fn nakabukure_hand_gets_a_category_rationale() {
        let state = generate_puzzle("nakabukure_ready").expect("nakabukure must generate");

        let rationale = rationale_for(&state).expect("nakabukure needs a rationale");

        assert_eq!(rationale.rules.len(), 3);
        assert!(rationale.absent.is_empty());
        assert!(rationale.rules.iter().all(|rule| !rule.applies.is_empty()));
        assert_eq!(rationale.source.chapter, 3);
        assert_eq!(rationale.source.section, "Bulging float (nakabukure) shape");
        assert!(!rationale.caveats.is_empty());

        let ids: Vec<&str> = rationale
            .rules
            .iter()
            .map(|rule| rule.id.as_str())
            .collect();
        assert_eq!(
            ids,
            vec![
                "bulge_pair_wait",
                "discard_the_bulge",
                "keep_until_one_away"
            ]
        );

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
    fn generated_book_scenarios_carry_a_rationale() {
        for category in [
            "ryanmen_protorun",
            "nakabukure_ready",
            "protorun_priority",
            "ryankan_break",
            "pair_count",
            "chiitoitsu_riichi_vs_dama",
            "riichi_judgement",
            "shouminkan_decision",
            "wind_discard_order",
            "defense_safety_chart",
            "defense_stuck_heuristic",
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
            "chiitoitsu_riichi_vs_dama",
            "riichi_judgement",
            "shouminkan_decision",
            "wind_discard_order",
            "defense_safety_chart",
            "defense_stuck_heuristic",
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
            "riichi_judgement",
            "dama_bad_wait",
            "dama_genbutsu_wait",
            "shouminkan_decision",
            "wind_discard_order",
            "defense_safety_chart",
            "defense_stuck_heuristic",
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
                "call_benefits_right_player",
                "shimocha_wind_first",
                "discard_it_early"
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
