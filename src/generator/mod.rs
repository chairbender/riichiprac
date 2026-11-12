//! Scenario generators, organized one module per lesson.
//!
//! - `block_theory`: 5-block random hands, the ryanmen protorun lesson, the
//!   protorun priority (side wait before closed wait) lesson, the
//!   nakabukure (bulging float) ready-hand lesson, the ryankan (double
//!   closed shape) break lesson, the pair count (avoid three pairs in a
//!   closed hand) lesson, and its open-hand companion (keep three pairs when
//!   a Pon is planned), and the skipping shape (a float two ranks from a run
//!   is worth more than an isolated float of the same rank).
//! - `yaku`: the ch. 5 yaku-pursuit decisions. `sanshoku_pursuit` is the
//!   floating method: keep the redundant tile for sanshoku only when the hand
//!   has no other yaku or dora.
//! - `chiitoi_vs_toitoi`: ch. 5.5's yaku choice: a 1-away chiitoitsu hand
//!   whose draw turned a pair into a set stays with chiitoitsu when a pair is
//!   futile, and builds toitoi otherwise.
//! - `chiitoitsu_riichi_vs_dama`: seven-pairs Riichi/dama family.
//! - `riichi_judgement`: ch. 7's general three-condition Riichi/dama rule.
//! - `dama_bad_wait`: ch. 7's bad-wait box: riichi with three or more live
//!   winning tiles, dama with one or two simple ones.
//! - `dama_genbutsu_wait`: ch. 7's genbutsu wait: dama when one winning tile is
//!   the genbutsu of the player everyone is folding to.
//! - `dama_expensive_hand`: ch. 7's high scoring hand: dama when the worst
//!   winning tile is already worth 7700, and never riichi at haneman or better.
//! - `dama_improving_hand`: ch. 7's improving hand: on an early turn, dama when
//!   at least six kinds of draws improve the ready hand's score or wait.
//! - `suji_trap_riichi`: ch. 8's immediate suji trap: declare Riichi on the
//!   discard that makes the wait look like a safe suji.
//! - `fold_to_riichi`: ch. 8.1/8.3's betaori drill: a junk hand facing a
//!   declared Riichi discards the one 100% safe tile, even though it breaks a
//!   block.
//! - `defense`: pure-defense "safest discard" lessons from the ch. 8 chart.
//!   `suji_kabe_safety` is the ranking mode of the fold board: the safest tile
//!   is a suji or no-chance tile, never the free genbutsu, and the runner-up is
//!   exactly one row down `tbl:safety`.
//! - `push_or_fold`: ch. 8.1's push/fold box, isolated on the 1-away cell:
//!   push a guaranteed mangan with a perfect wait, fold a cheap bad-wait hand.
//! - `open_hand_defense`: ch. 8.4's open-hand read: an opponent's chii followed
//!   by a discard in the same suit makes that discard's neighbourhood safe; a
//!   different-suit discard makes it dangerous.
//! - `shouminkan_decision`: Added Kan decision lesson (Kan or decline, one
//!   neutral prompt).
//! - `ankan_decision`: concealed quad decision lesson (Kan or decline, one
//!   neutral prompt): four concealed copies, close to ready or a good floating
//!   tile.
//! - `meld_or_not`: the ch. 9.1 call decision: pass on a Pon when the hand is
//!   both cheap and slow.
//! - `daiminkan_decision`: the ch. 9.3.2 open quad (daiminkan) call decision:
//!   take the fourth copy of a concealed dragon triplet only when the book's
//!   value band, placement pressure, or score line justifies it.
//! - `wind_discard_order`: the ch. 9 seating tip: which valueless wind to throw
//!   first (the right player's).
//! - `pinfu_head`: ch. 5's pinfu head: a hand with no pair yet keeps its
//!   terminals and valueless winds, because the value honor can never pair into
//!   the pinfu head.
//! - `honitsu_decision`: ch. 5.4's honitsu commitment: five-block potential plus
//!   the hand's value with and without honitsu decide whether to start
//!   discarding off-suit or to play for efficiency.
//! - `support`: shared deck, table, scoring, formatting, and retry helpers.
//!
//! The Phase 2 `mock_table` fixture lives in `crate::fixtures`, outside the
//! lesson registry.

pub mod ai_best_action;
mod ankan_decision;
mod block_theory;
mod chiitoi_vs_toitoi;
mod chiitoitsu_riichi_vs_dama;
mod daiminkan_decision;
mod dama_bad_wait;
mod dama_expensive_hand;
mod dama_genbutsu_wait;
mod dama_improving_hand;
mod defense;
mod fold_to_riichi;
mod honitsu_decision;
mod meld_or_not;
pub mod mortal_agreement;
mod open_hand_defense;
mod pinfu_head;
pub(crate) mod push_or_fold;
mod riichi_judgement;
mod shouminkan_decision;
mod situation;
mod suji_trap_riichi;
mod support;
mod wind_discard_order;
mod yaku;

use agari::tile::Tile;
use serde::Serialize;

use crate::ai::model::MortalV4Model;
use crate::state::GameState;
use situation::Situation;

pub(crate) use daiminkan_decision::{DaiminkanTriggerSet, facts as daiminkan_facts};
pub(crate) use honitsu_decision::{Variant as HonitsuVariant, facts as honitsu_facts};
pub(crate) use support::analysis::floating_quad_acceptance;
pub(crate) use support::analysis::wind_to_honor;
pub use support::analysis::{HandMetrics, evaluate_hand};
pub use support::deck::ALL_TILES;
pub use support::format::format_hand_compact;
pub(crate) use yaku::sanshoku_pursuit::{SanshokuFacts, facts as sanshoku_facts};

/// The ch. 3 skipping-shape counts, shared by the lesson and its rationale.
pub(crate) use block_theory::skipping_block::{isolated_turns, skipping_turns};

/// The ch. 5 pinfu-head rule, shared by the lesson and its rationale.
pub(crate) use pinfu_head::{can_be_pinfu_head, wind_from_honor};

pub use mortal_agreement::{
    AgreementRejection, AgreementRejections, MortalAgreementOptions, MortalAgreementReport,
};

pub type PuzzleResponse = GameState;

/// Broad grouping used by the scenario picker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScenarioCategory {
    TileEfficiency,
    RiichiDecision,
    KanDecision,
    AiDecision,
    DefenseDecision,
    MeldingDecision,
    /// Pursuing a yaku: the hand value, not the raw shape, decides the tile.
    YakuDecision,
}

impl ScenarioCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            ScenarioCategory::TileEfficiency => "tile_efficiency",
            ScenarioCategory::RiichiDecision => "riichi_decision",
            ScenarioCategory::KanDecision => "kan_decision",
            ScenarioCategory::AiDecision => "ai_decision",
            ScenarioCategory::DefenseDecision => "defense_decision",
            ScenarioCategory::MeldingDecision => "melding_decision",
            ScenarioCategory::YakuDecision => "yaku_decision",
        }
    }
}

/// Display metadata for one lesson.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScenarioMeta {
    pub id: ScenarioId,
    pub label: &'static str,
    pub description: &'static str,
    pub category: ScenarioCategory,
    pub tags: &'static [&'static str],
    /// True when generation needs the loaded Mortal evaluator.
    pub requires_ai: bool,
    /// Which perspectives grade this lesson.
    pub grading: ScenarioGrading,
    /// The Riichi Book 1 section the lesson teaches, when it has one. Groups
    /// the picker by chapter and section instead of the broad `category`.
    pub book: Option<BookSection>,
}

/// A numbered Riichi Book 1 section a lesson teaches.
///
/// `section` is the book's own `\section` number (`ch8.4`), not a subsection,
/// so picker groups line up with the chapter/section language the verdict panel
/// uses. The titles are the book's own heading text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BookSection {
    pub chapter: u8,
    pub chapter_title: &'static str,
    pub section: u8,
    pub section_title: &'static str,
}

impl BookSection {
    /// Stable grouping key, e.g. `ch8.4`.
    pub fn key(self) -> String {
        format!("ch{}.{}", self.chapter, self.section)
    }

    /// Picker label, e.g. `ch8.4 · Defense against open hands`.
    pub fn label(self) -> String {
        format!("{} · {}", self.key(), self.section_title)
    }
}

const BOOK_CH3_BASIC: BookSection = BookSection {
    chapter: 3,
    chapter_title: "Riichi mahjong basics",
    section: 2,
    section_title: "Basic building blocks",
};

const BOOK_CH3_SHAPES: BookSection = BookSection {
    chapter: 3,
    chapter_title: "Riichi mahjong basics",
    section: 3,
    section_title: "Complex shapes",
};

const BOOK_CH4_REDUNDANT: BookSection = BookSection {
    chapter: 4,
    chapter_title: "The five-block method",
    section: 1,
    section_title: "Finding a redundant tile",
};

const BOOK_CH7_RIICHI: BookSection = BookSection {
    chapter: 7,
    chapter_title: "Riichi judgement",
    section: 1,
    section_title: "To riichi or not to riichi?",
};

const BOOK_CH7_INSTA: BookSection = BookSection {
    chapter: 7,
    chapter_title: "Riichi judgement",
    section: 2,
    section_title: "Insta-riichi",
};

const BOOK_CH7_DAMA: BookSection = BookSection {
    chapter: 7,
    chapter_title: "Riichi judgement",
    section: 3,
    section_title: "When not to riichi",
};

const BOOK_CH8_PUSH_FOLD: BookSection = BookSection {
    chapter: 8,
    chapter_title: "Defense judgement",
    section: 1,
    section_title: "To push or to fold?",
};

const BOOK_CH8_BASICS: BookSection = BookSection {
    chapter: 8,
    chapter_title: "Defense judgement",
    section: 2,
    section_title: "Defense basics",
};

const BOOK_CH8_AGAINST_RIICHI: BookSection = BookSection {
    chapter: 8,
    chapter_title: "Defense judgement",
    section: 3,
    section_title: "Defense against riichi",
};

const BOOK_CH8_OPEN_HANDS: BookSection = BookSection {
    chapter: 8,
    chapter_title: "Defense judgement",
    section: 4,
    section_title: "Defense against open hands",
};

const BOOK_CH9_MELD: BookSection = BookSection {
    chapter: 9,
    chapter_title: "Melding judgement",
    section: 1,
    section_title: "To meld or not to meld?",
};

const BOOK_CH9_KAN: BookSection = BookSection {
    chapter: 9,
    chapter_title: "Melding judgement",
    section: 3,
    section_title: "Calling kan",
};

const BOOK_CH9_TIPS: BookSection = BookSection {
    chapter: 9,
    chapter_title: "Melding judgement",
    section: 4,
    section_title: "Miscellaneous tips for melding",
};

const BOOK_CH5_PINFU: BookSection = BookSection {
    chapter: 5,
    chapter_title: "Pursuing yaku",
    section: 3,
    section_title: "How to get pinfu",
};

const BOOK_CH5_HONITSU: BookSection = BookSection {
    chapter: 5,
    chapter_title: "Pursuing yaku",
    section: 4,
    section_title: "How to get honitsu",
};

const BOOK_CH5_TOITOI: BookSection = BookSection {
    chapter: 5,
    chapter_title: "Pursuing yaku",
    section: 5,
    section_title: "How to get toitoi / chiitoitsu",
};

const BOOK_CH5_SANSHOKU: BookSection = BookSection {
    chapter: 5,
    chapter_title: "Pursuing yaku",
    section: 1,
    section_title: "How to get sanshoku",
};

/// How an answer is graded for a lesson.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScenarioGrading {
    /// A book rule plus Mortal when the model is loaded.
    BookAndMortal,
    /// The state's answer is the model's own action; there is no book rule.
    MortalOnly,
}

impl ScenarioGrading {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::BookAndMortal => "book_and_mortal",
            Self::MortalOnly => "mortal_only",
        }
    }
}

/// The user-facing scenario catalogue. Fixtures are deliberately excluded.
pub const SCENARIO_MANIFEST: &[ScenarioMeta] = &[
    ScenarioMeta {
        id: ScenarioId::RyanmenProtorun,
        label: "Ryanmen Protorun",
        description: "Block theory: choose the discard that keeps the ryanmen wait.",
        category: ScenarioCategory::TileEfficiency,
        tags: &["block_theory", "discard", "ryanmen"],
        requires_ai: false,
        grading: ScenarioGrading::BookAndMortal,
        book: Some(BOOK_CH4_REDUNDANT),
    },
    ScenarioMeta {
        id: ScenarioId::NakabukureReady,
        label: "Bulging Float",
        description: "Block theory: the bulging float is a real decision — keep it for two \
                      runs, or break it for a better block or wait.",
        category: ScenarioCategory::TileEfficiency,
        tags: &[
            "block_theory",
            "discard",
            "nakabukure",
            "shape",
            "keep",
            "break",
        ],
        requires_ai: false,
        grading: ScenarioGrading::BookAndMortal,
        book: Some(BOOK_CH3_SHAPES),
    },
    ScenarioMeta {
        id: ScenarioId::ProtorunPriority,
        label: "Protorun Priority",
        description: "Block theory: break the closed wait and keep both side waits.",
        category: ScenarioCategory::TileEfficiency,
        tags: &["block_theory", "discard", "protorun", "ryanmen", "kanchan"],
        requires_ai: false,
        grading: ScenarioGrading::BookAndMortal,
        book: Some(BOOK_CH3_BASIC),
    },
    ScenarioMeta {
        id: ScenarioId::RyankanBreak,
        label: "Ryankan Break",
        description: "Block theory: keep the new side wait and break the double closed shape.",
        category: ScenarioCategory::TileEfficiency,
        tags: &["block_theory", "discard", "ryankan", "shape", "ryanmen"],
        requires_ai: false,
        grading: ScenarioGrading::BookAndMortal,
        book: Some(BOOK_CH3_SHAPES),
    },
    ScenarioMeta {
        id: ScenarioId::PairCount,
        label: "Pair Count",
        description: "Block theory: a third pair is weaker than the side wait it was drawn from.",
        category: ScenarioCategory::TileEfficiency,
        tags: &["block_theory", "discard", "pairs", "shape", "protorun"],
        requires_ai: false,
        grading: ScenarioGrading::BookAndMortal,
        book: Some(BOOK_CH3_BASIC),
    },
    ScenarioMeta {
        id: ScenarioId::SkippingBlock,
        label: "Skipping Shape",
        description: "Block theory: a float two ranks from a run is worth more than an \
                      isolated float of the same rank, so keep the skipping tile.",
        category: ScenarioCategory::TileEfficiency,
        tags: &[
            "block_theory",
            "discard",
            "skipping",
            "shape",
            "floating_tile",
        ],
        requires_ai: false,
        grading: ScenarioGrading::BookAndMortal,
        book: Some(BOOK_CH3_SHAPES),
    },
    ScenarioMeta {
        id: ScenarioId::PairCountOpen,
        label: "Pair Count: Pon Planned",
        description: "Block theory: with a dragon pair to Pon, keep three pairs and break \
                      the closed wait.",
        category: ScenarioCategory::TileEfficiency,
        tags: &[
            "block_theory",
            "discard",
            "pairs",
            "shape",
            "pon",
            "open_hand",
        ],
        requires_ai: false,
        grading: ScenarioGrading::BookAndMortal,
        book: Some(BOOK_CH3_BASIC),
    },
    ScenarioMeta {
        id: ScenarioId::ChiitoiVsToitoi,
        label: "Chiitoitsu vs Toitoi",
        description: "Yaku pursuit: a pair just became a set. Stay with chiitoitsu when a \
                      pair is futile; otherwise keep the set and build toitoi.",
        category: ScenarioCategory::YakuDecision,
        tags: &[
            "yaku",
            "chiitoitsu",
            "toitoi",
            "pairs",
            "futile_pair",
            "discard",
        ],
        requires_ai: false,
        grading: ScenarioGrading::BookAndMortal,
        book: Some(BOOK_CH5_TOITOI),
    },
    ScenarioMeta {
        id: ScenarioId::SanshokuPursuit,
        label: "Sanshoku Pursuit",
        description: "Ch. 5.1 floating method: keep the floating tile for sanshoku only when \
                      the hand has no other yaku or dora; otherwise take the side-wait pinfu.",
        category: ScenarioCategory::YakuDecision,
        tags: &[
            "yaku", "sanshoku", "pinfu", "floating", "dora", "tanyao", "discard",
        ],
        requires_ai: false,
        grading: ScenarioGrading::BookAndMortal,
        book: Some(BOOK_CH5_SANSHOKU),
    },
    ScenarioMeta {
        id: ScenarioId::ChiitoitsuRiichiVsDama,
        label: "Chiitoitsu Riichi vs Dama",
        description: "Seven pairs: decide whether to declare Riichi or stay dama.",
        category: ScenarioCategory::RiichiDecision,
        tags: &["chiitoitsu", "riichi", "dama"],
        requires_ai: false,
        grading: ScenarioGrading::BookAndMortal,
        book: Some(BOOK_CH7_INSTA),
    },
    ScenarioMeta {
        id: ScenarioId::RiichiJudgement,
        label: "Riichi Judgement",
        description: "The ch. 7 rule: Riichi if you have a han, a good wait, or the deal.",
        category: ScenarioCategory::RiichiDecision,
        tags: &["riichi", "dama", "wait", "dealer", "han"],
        requires_ai: false,
        grading: ScenarioGrading::BookAndMortal,
        book: Some(BOOK_CH7_RIICHI),
    },
    ScenarioMeta {
        id: ScenarioId::DamaBadWait,
        label: "Dama: Bad Wait",
        description: "Ch. 7 bad wait: Riichi with three or more live winning tiles, dama with \
                      one or two simple ones, but Riichi on an honor or terminal.",
        category: ScenarioCategory::RiichiDecision,
        tags: &["riichi", "dama", "bad_wait", "live_tiles", "honor_terminal"],
        requires_ai: false,
        grading: ScenarioGrading::BookAndMortal,
        book: Some(BOOK_CH7_DAMA),
    },
    ScenarioMeta {
        id: ScenarioId::DamaGenbutsuWait,
        label: "Dama: Genbutsu Wait",
        description: "Ch. 7 genbutsu wait: a riichi threat has already discarded one of \
                      your winning tiles, so the players folding to them throw it.",
        category: ScenarioCategory::RiichiDecision,
        tags: &["riichi", "dama", "genbutsu", "wait", "defense"],
        requires_ai: false,
        grading: ScenarioGrading::BookAndMortal,
        book: Some(BOOK_CH7_DAMA),
    },
    ScenarioMeta {
        id: ScenarioId::DamaExpensiveHand,
        label: "Dama: Expensive Hand",
        description: "Ch. 7 high scoring hand: the worst winning tile already scores 7700, \
                      so dama is fine and haneman+ means no riichi.",
        category: ScenarioCategory::RiichiDecision,
        tags: &[
            "riichi",
            "dama",
            "mangan",
            "haneman",
            "score",
            "expensive_hand",
        ],
        requires_ai: false,
        grading: ScenarioGrading::BookAndMortal,
        book: Some(BOOK_CH7_DAMA),
    },
    ScenarioMeta {
        id: ScenarioId::DamaImprovingHand,
        label: "Dama: Improving Hand",
        description: "Ch. 7 improving hand: an early ready hand with many improving \
                      draws stays dama instead of declaring Riichi.",
        category: ScenarioCategory::RiichiDecision,
        tags: &["riichi", "dama", "improving", "early_turn", "tanki", "wait"],
        requires_ai: false,
        grading: ScenarioGrading::BookAndMortal,
        book: Some(BOOK_CH7_DAMA),
    },
    ScenarioMeta {
        id: ScenarioId::SujiTrapRiichi,
        label: "Riichi: Immediate Suji Trap",
        description: "Ch. 8 suji trap: two discards leave the same wait, but only one \
                      makes the winning tile a suji of the declaration tile.",
        category: ScenarioCategory::RiichiDecision,
        tags: &["riichi", "suji", "trap", "wait", "discard", "defense"],
        requires_ai: false,
        grading: ScenarioGrading::BookAndMortal,
        book: Some(BOOK_CH8_BASICS),
    },
    ScenarioMeta {
        id: ScenarioId::ShouminkanDecision,
        label: "Added Kan Decision",
        description: "Open Pon, fourth tile drawn: decide whether to upgrade to an Added Kan or discard.",
        category: ScenarioCategory::KanDecision,
        tags: &["kan", "shouminkan", "decline"],
        requires_ai: false,
        grading: ScenarioGrading::BookAndMortal,
        book: Some(BOOK_CH9_KAN),
    },
    ScenarioMeta {
        id: ScenarioId::AnkanDecision,
        label: "Concealed Quad Decision",
        description: "Four concealed copies: declare the concealed quad only when the hand is \
                      close to ready, never when the fourth copy is a good floating tile.",
        category: ScenarioCategory::KanDecision,
        tags: &["kan", "ankan", "decline", "floating_tile"],
        requires_ai: false,
        grading: ScenarioGrading::BookAndMortal,
        book: Some(BOOK_CH9_KAN),
    },
    ScenarioMeta {
        id: ScenarioId::WindDiscardOrder,
        label: "Wind Discard Order",
        description: "First turn with two or three valueless winds: throw the right player's wind first.",
        category: ScenarioCategory::MeldingDecision,
        tags: &["melding", "seating", "wind", "discard", "first_turn"],
        requires_ai: false,
        grading: ScenarioGrading::BookAndMortal,
        book: Some(BOOK_CH9_TIPS),
    },
    ScenarioMeta {
        id: ScenarioId::MeldOrNot,
        label: "Meld or Not",
        description: "A Pon is offered on a cheap and slow hand: pass, unless the book's \
                      exceptions apply.",
        category: ScenarioCategory::MeldingDecision,
        tags: &["melding", "call", "pon", "pass", "cheap_slow"],
        requires_ai: false,
        grading: ScenarioGrading::BookAndMortal,
        book: Some(BOOK_CH9_MELD),
    },
    ScenarioMeta {
        id: ScenarioId::DaiminkanDecision,
        label: "Open Quad Decision",
        description: "An opponent discards the fourth copy of your dragon triplet: call the \
                      open quad only when the hand's value, the placement, or the score line \
                      asks for it.",
        category: ScenarioCategory::KanDecision,
        tags: &["kan", "daiminkan", "open_quad", "call", "value_band"],
        requires_ai: false,
        grading: ScenarioGrading::BookAndMortal,
        book: Some(BOOK_CH9_KAN),
    },
    ScenarioMeta {
        id: ScenarioId::AiBestAction,
        label: "AI Best Action",
        description: "Any decision: discard, call, or win — the answer is Mortal v4's top action.",
        category: ScenarioCategory::AiDecision,
        tags: &["ai", "mortal", "discard", "call", "any_decision"],
        requires_ai: true,
        grading: ScenarioGrading::MortalOnly,
        book: None,
    },
    ScenarioMeta {
        id: ScenarioId::FoldToRiichi,
        label: "Defense: Fold to Riichi",
        description: "An opponent has declared Riichi against a junk hand: discard the one \
                      tile the book calls 100% safe.",
        category: ScenarioCategory::DefenseDecision,
        tags: &["defense", "betaori", "fold", "genbutsu", "discard"],
        requires_ai: false,
        grading: ScenarioGrading::BookAndMortal,
        book: Some(BOOK_CH8_AGAINST_RIICHI),
    },
    ScenarioMeta {
        id: ScenarioId::PushOrFold,
        label: "Push or Fold",
        description: "Ch. 8.1 push/fold: a 1-away hand may push only with both a high \
                      score and a good wait; otherwise fold to the safest tile.",
        category: ScenarioCategory::DefenseDecision,
        tags: &[
            "defense",
            "push_fold",
            "betaori",
            "value",
            "wait",
            "discard",
        ],
        requires_ai: false,
        grading: ScenarioGrading::BookAndMortal,
        book: Some(BOOK_CH8_PUSH_FOLD),
    },
    ScenarioMeta {
        id: ScenarioId::DefenseSafetyChart,
        label: "Defense: Safest Discard",
        description: "An opponent has declared Riichi: discard the tile the book's safety chart ranks safest.",
        category: ScenarioCategory::DefenseDecision,
        tags: &["defense", "betaori", "safety_chart", "suji", "genbutsu"],
        requires_ai: false,
        grading: ScenarioGrading::BookAndMortal,
        book: Some(BOOK_CH8_BASICS),
    },
    ScenarioMeta {
        id: ScenarioId::SujiKabeSafety,
        label: "Defense: Suji / No-Chance Ranking",
        description: "The safest tile is a suji or no-chance tile: rank the hand on the book's \
                      table, where the runner-up is exactly one row worse.",
        category: ScenarioCategory::DefenseDecision,
        tags: &[
            "defense",
            "betaori",
            "suji",
            "kabe",
            "safety_chart",
            "ranking",
        ],
        requires_ai: false,
        grading: ScenarioGrading::BookAndMortal,
        book: Some(BOOK_CH8_BASICS),
    },
    ScenarioMeta {
        id: ScenarioId::DefenseStuckHeuristic,
        label: "Defense: Nothing Is Safe",
        description: "No tile is identified as safe: apply the book's fallback and break up the pair.",
        category: ScenarioCategory::DefenseDecision,
        tags: &["defense", "betaori", "heuristic", "pairs", "discard"],
        requires_ai: false,
        grading: ScenarioGrading::BookAndMortal,
        book: Some(BOOK_CH8_AGAINST_RIICHI),
    },
    ScenarioMeta {
        id: ScenarioId::OpenHandDefense,
        label: "Open Hand: Post-Chi Discard",
        description: "An opponent with three open melds chi'd, then discarded: read whether \
                      the neighbourhood of that discard is safe or dangerous.",
        category: ScenarioCategory::DefenseDecision,
        tags: &["defense", "open_hand", "chi", "neighbourhood", "discard"],
        requires_ai: false,
        grading: ScenarioGrading::BookAndMortal,
        book: Some(BOOK_CH8_OPEN_HANDS),
    },
    ScenarioMeta {
        id: ScenarioId::PinfuHead,
        label: "Pinfu: Build the Head",
        description: "The head is still open: keep the terminals and valueless winds, because \
                      the value honor can never be the pinfu head.",
        category: ScenarioCategory::YakuDecision,
        tags: &["yaku", "pinfu", "head", "discard", "honor"],
        requires_ai: false,
        grading: ScenarioGrading::BookAndMortal,
        book: Some(BOOK_CH5_PINFU),
    },
    ScenarioMeta {
        id: ScenarioId::HonitsuDecision,
        label: "Honitsu: Commit or Efficiency",
        description: "Ch. 5.4: five blocks in one suit plus honors is not enough on its own — \
                      commit to honitsu only when the plan is worth more than the hand played \
                      straight.",
        category: ScenarioCategory::YakuDecision,
        tags: &[
            "yaku",
            "honitsu",
            "commit",
            "efficiency",
            "five_blocks",
            "value",
        ],
        requires_ai: false,
        grading: ScenarioGrading::BookAndMortal,
        book: Some(BOOK_CH5_HONITSU),
    },
];

/// Serializes the scenario catalogue for the frontend picker.
pub fn list_scenarios_json() -> String {
    #[derive(Serialize)]
    struct BookSectionJson {
        chapter: u8,
        chapter_title: &'static str,
        section: u8,
        section_title: &'static str,
        /// Stable key the picker groups on, e.g. `ch8.4`.
        key: String,
        /// Ready-made display label, e.g. `ch8.4 · Defense against open hands`.
        label: String,
    }

    #[derive(Serialize)]
    struct ScenarioMetaJson {
        id: &'static str,
        label: &'static str,
        description: &'static str,
        category: &'static str,
        tags: &'static [&'static str],
        requires_ai: bool,
        grading: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        book: Option<BookSectionJson>,
    }

    let scenarios: Vec<ScenarioMetaJson> = SCENARIO_MANIFEST
        .iter()
        .map(|meta| ScenarioMetaJson {
            id: meta.id.as_str(),
            label: meta.label,
            description: meta.description,
            category: meta.category.as_str(),
            tags: meta.tags,
            requires_ai: meta.requires_ai,
            grading: meta.grading.as_str(),
            book: meta.book.map(|book| BookSectionJson {
                chapter: book.chapter,
                chapter_title: book.chapter_title,
                section: book.section,
                section_title: book.section_title,
                key: book.key(),
                label: book.label(),
            }),
        })
        .collect();

    serde_json::to_string(&scenarios)
        .unwrap_or_else(|err| format!("{{\"error\":\"Failed to serialize scenarios: {err}\"}}"))
}

/// Every scenario the generator can dispatch to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScenarioId {
    RyanmenProtorun,
    NakabukureReady,
    ProtorunPriority,
    RyankanBreak,
    PairCount,
    SkippingBlock,
    PairCountOpen,
    ChiitoiVsToitoi,
    SanshokuPursuit,
    ChiitoitsuRiichiVsDama,
    RiichiJudgement,
    DamaBadWait,
    DamaGenbutsuWait,
    DamaExpensiveHand,
    DamaImprovingHand,
    SujiTrapRiichi,
    ShouminkanDecision,
    AnkanDecision,
    MeldOrNot,
    DaiminkanDecision,
    WindDiscardOrder,
    AiBestAction,
    FoldToRiichi,
    PushOrFold,
    DefenseSafetyChart,
    SujiKabeSafety,
    DefenseStuckHeuristic,
    OpenHandDefense,
    PinfuHead,
    HonitsuDecision,
}

impl ScenarioId {
    /// Every real scenario, excluding the UI fixture.
    pub const ALL: &'static [ScenarioId] = &[
        ScenarioId::RyanmenProtorun,
        ScenarioId::NakabukureReady,
        ScenarioId::ProtorunPriority,
        ScenarioId::RyankanBreak,
        ScenarioId::PairCount,
        ScenarioId::SkippingBlock,
        ScenarioId::PairCountOpen,
        ScenarioId::ChiitoiVsToitoi,
        ScenarioId::SanshokuPursuit,
        ScenarioId::ChiitoitsuRiichiVsDama,
        ScenarioId::RiichiJudgement,
        ScenarioId::DamaBadWait,
        ScenarioId::DamaGenbutsuWait,
        ScenarioId::DamaExpensiveHand,
        ScenarioId::DamaImprovingHand,
        ScenarioId::SujiTrapRiichi,
        ScenarioId::ShouminkanDecision,
        ScenarioId::AnkanDecision,
        ScenarioId::WindDiscardOrder,
        ScenarioId::MeldOrNot,
        ScenarioId::DaiminkanDecision,
        ScenarioId::AiBestAction,
        ScenarioId::FoldToRiichi,
        ScenarioId::PushOrFold,
        ScenarioId::DefenseSafetyChart,
        ScenarioId::SujiKabeSafety,
        ScenarioId::DefenseStuckHeuristic,
        ScenarioId::OpenHandDefense,
        ScenarioId::PinfuHead,
        ScenarioId::HonitsuDecision,
    ];

    /// The category string understood by the WASM API.
    pub fn as_str(self) -> &'static str {
        match self {
            ScenarioId::RyanmenProtorun => "ryanmen_protorun",
            ScenarioId::NakabukureReady => "nakabukure_ready",
            ScenarioId::ProtorunPriority => "protorun_priority",
            ScenarioId::RyankanBreak => "ryankan_break",
            ScenarioId::PairCount => "pair_count",
            ScenarioId::SkippingBlock => "skipping_block",
            ScenarioId::PairCountOpen => "pair_count_open",
            ScenarioId::ChiitoiVsToitoi => "chiitoi_vs_toitoi",
            ScenarioId::SanshokuPursuit => "sanshoku_pursuit",
            ScenarioId::ChiitoitsuRiichiVsDama => "chiitoitsu_riichi_vs_dama",
            ScenarioId::RiichiJudgement => "riichi_judgement",
            ScenarioId::DamaBadWait => "dama_bad_wait",
            ScenarioId::DamaGenbutsuWait => "dama_genbutsu_wait",
            ScenarioId::DamaExpensiveHand => "dama_expensive_hand",
            ScenarioId::DamaImprovingHand => "dama_improving_hand",
            ScenarioId::SujiTrapRiichi => "suji_trap_riichi",
            ScenarioId::ShouminkanDecision => "shouminkan_decision",
            ScenarioId::AnkanDecision => "ankan_decision",
            ScenarioId::WindDiscardOrder => "wind_discard_order",
            ScenarioId::MeldOrNot => "meld_or_not",
            ScenarioId::DaiminkanDecision => "daiminkan_decision",
            ScenarioId::AiBestAction => "ai_best_action",
            ScenarioId::FoldToRiichi => "fold_to_riichi",
            ScenarioId::PushOrFold => "push_or_fold",
            ScenarioId::DefenseSafetyChart => "defense_safety_chart",
            ScenarioId::SujiKabeSafety => "suji_kabe_safety",
            ScenarioId::DefenseStuckHeuristic => "defense_stuck_heuristic",
            ScenarioId::OpenHandDefense => "open_hand_defense",
            ScenarioId::PinfuHead => "pinfu_head",
            ScenarioId::HonitsuDecision => "honitsu_decision",
        }
    }

    /// Resolves an incoming category string.
    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            "ryanmen_protorun" => Some(ScenarioId::RyanmenProtorun),
            "nakabukure_ready" => Some(ScenarioId::NakabukureReady),
            "protorun_priority" => Some(ScenarioId::ProtorunPriority),
            "ryankan_break" => Some(ScenarioId::RyankanBreak),
            "pair_count" => Some(ScenarioId::PairCount),
            "skipping_block" => Some(ScenarioId::SkippingBlock),
            "pair_count_open" => Some(ScenarioId::PairCountOpen),
            "chiitoi_vs_toitoi" => Some(ScenarioId::ChiitoiVsToitoi),
            "sanshoku_pursuit" => Some(ScenarioId::SanshokuPursuit),
            "chiitoitsu_riichi_vs_dama" => Some(ScenarioId::ChiitoitsuRiichiVsDama),
            "riichi_judgement" => Some(ScenarioId::RiichiJudgement),
            "dama_bad_wait" => Some(ScenarioId::DamaBadWait),
            "dama_genbutsu_wait" => Some(ScenarioId::DamaGenbutsuWait),
            "dama_expensive_hand" => Some(ScenarioId::DamaExpensiveHand),
            "dama_improving_hand" => Some(ScenarioId::DamaImprovingHand),
            "suji_trap_riichi" => Some(ScenarioId::SujiTrapRiichi),
            "shouminkan_decision" => Some(ScenarioId::ShouminkanDecision),
            "ankan_decision" => Some(ScenarioId::AnkanDecision),
            "wind_discard_order" => Some(ScenarioId::WindDiscardOrder),
            "meld_or_not" => Some(ScenarioId::MeldOrNot),
            "daiminkan_decision" => Some(ScenarioId::DaiminkanDecision),
            "ai_best_action" => Some(ScenarioId::AiBestAction),
            "fold_to_riichi" => Some(ScenarioId::FoldToRiichi),
            "push_or_fold" => Some(ScenarioId::PushOrFold),
            "defense_safety_chart" => Some(ScenarioId::DefenseSafetyChart),
            "suji_kabe_safety" => Some(ScenarioId::SujiKabeSafety),
            "defense_stuck_heuristic" => Some(ScenarioId::DefenseStuckHeuristic),
            "open_hand_defense" => Some(ScenarioId::OpenHandDefense),
            "pinfu_head" => Some(ScenarioId::PinfuHead),
            "honitsu_decision" => Some(ScenarioId::HonitsuDecision),
            _ => None,
        }
    }

    /// Generates a puzzle for this scenario, echoing `category` in the state.
    pub fn generate(self, category: &str) -> Result<GameState, String> {
        match self {
            ScenarioId::RyanmenProtorun => block_theory::ryanmen_protorun::generate(category),
            ScenarioId::NakabukureReady => block_theory::nakabukure_ready::generate(category),
            ScenarioId::ProtorunPriority => block_theory::protorun_priority::generate(category),
            ScenarioId::RyankanBreak => block_theory::ryankan_break::generate(category),
            ScenarioId::PairCount => block_theory::pair_count::generate(category),
            ScenarioId::SkippingBlock => block_theory::skipping_block::generate(category),
            ScenarioId::PairCountOpen => block_theory::pair_count_open::generate(category),
            ScenarioId::ChiitoiVsToitoi => chiitoi_vs_toitoi::generate(category),
            ScenarioId::SanshokuPursuit => yaku::sanshoku_pursuit::generate(category),
            ScenarioId::ChiitoitsuRiichiVsDama => chiitoitsu_riichi_vs_dama::generate(category),
            ScenarioId::RiichiJudgement => riichi_judgement::generate(category),
            ScenarioId::DamaBadWait => dama_bad_wait::generate(category),
            ScenarioId::DamaGenbutsuWait => dama_genbutsu_wait::generate(category),
            ScenarioId::DamaExpensiveHand => dama_expensive_hand::generate(category),
            ScenarioId::DamaImprovingHand => dama_improving_hand::generate(category),
            ScenarioId::SujiTrapRiichi => suji_trap_riichi::generate(category),
            ScenarioId::ShouminkanDecision => shouminkan_decision::generate(category),
            ScenarioId::AnkanDecision => ankan_decision::generate(category),
            ScenarioId::WindDiscardOrder => wind_discard_order::generate(category),
            ScenarioId::MeldOrNot => meld_or_not::generate(category),
            ScenarioId::DaiminkanDecision => daiminkan_decision::generate(category),
            ScenarioId::AiBestAction => Err(
                "ai_best_action requires the loaded Mortal model; use the evaluator's \
                 generate_ai_puzzle"
                    .to_string(),
            ),
            ScenarioId::FoldToRiichi => fold_to_riichi::generate(category),
            ScenarioId::PushOrFold => push_or_fold::generate(category),
            ScenarioId::DefenseSafetyChart => defense::generate_safety_chart(category),
            ScenarioId::SujiKabeSafety => defense::generate_suji_kabe(category),
            ScenarioId::DefenseStuckHeuristic => defense::generate_stuck(category),
            ScenarioId::OpenHandDefense => open_hand_defense::generate(category),
            ScenarioId::PinfuHead => pinfu_head::generate(category),
            ScenarioId::HonitsuDecision => honitsu_decision::generate(category),
        }
    }
}

/// Dispatches to the requested scenario. Unknown categories fall back to
/// the first real Block Theory scenario. The `mock_table` fixture is handled
/// separately so it stays out of the lesson manifest.
pub fn generate_puzzle(category: &str) -> Result<GameState, String> {
    generate_reachable_candidate(category).map(finalize_state)
}

/// Generate one lesson candidate that passes the reachability guard.
///
/// This is the generation half of [`generate_puzzle`], exposed inside the crate
/// so the Mortal-agreement sampler can draw one candidate at a time and decide
/// whether to keep it. The returned state is **not** finalized: callers must
/// apply [`finalize_state`] before handing it to a player or a report.
pub(crate) fn generate_reachable_candidate(category: &str) -> Result<GameState, String> {
    if category == "mock_table" {
        // The fixture is a fixed UI mock, not a played-out table, so it is not
        // held to the reachability rules.
        return crate::fixtures::mock_table::generate(category);
    }

    let mut last_error = String::new();
    for _ in 0..MAX_REACHABILITY_ATTEMPTS {
        let state = match ScenarioId::from_id(category) {
            Some(id) => id.generate(category)?,
            None => block_theory::ryanmen_protorun::generate(category)?,
        };

        // Final guard: a lesson may have shaped its rivers and melds freely,
        // but the finished table still has to be a position a real game could
        // have produced.
        match support::state_validation::validate_reachable_state(&state) {
            Ok(()) => return Ok(state),
            Err(err) => last_error = err,
        }
    }

    Err(format!(
        "generated {category} states were never reachable after \
         {MAX_REACHABILITY_ATTEMPTS} attempts: {last_error}"
    ))
}

/// Draws the situation parameters for one puzzle request, once.
///
/// This is the "pick the kind of situation first" half of generation: the
/// returned value names the condition the hand must isolate, and
/// [`generate_reachable_candidate_for`] then fills tiles under it. `None` means
/// the lesson has no parameter concept (the block-theory discards, the safety
/// lessons, the call and kan lessons, and the dama lessons whose answer is
/// fixed by the hand shape), so each candidate stays an independent full draw.
pub(crate) fn sample_situation(category: &str) -> Option<Situation> {
    match ScenarioId::from_id(category)? {
        ScenarioId::RiichiJudgement => {
            Some(Situation::RiichiJudgement(riichi_judgement::sample_target()))
        }
        ScenarioId::DamaBadWait => Some(Situation::DamaBadWait(dama_bad_wait::sample_target())),
        ScenarioId::DamaExpensiveHand => Some(Situation::DamaExpensiveHand(
            dama_expensive_hand::sample_target(),
        )),
        ScenarioId::ChiitoitsuRiichiVsDama => Some(Situation::Chiitoitsu(
            chiitoitsu_riichi_vs_dama::Target::sample(),
        )),
        ScenarioId::PushOrFold => Some(Situation::PushOrFold(push_or_fold::sample_target())),
        ScenarioId::HonitsuDecision => {
            Some(Situation::HonitsuDecision(honitsu_decision::sample_target()))
        }
        _ => None,
    }
}

/// Generate one lesson candidate under already-drawn situation parameters.
///
/// The same reachability guard as [`generate_reachable_candidate`], but the
/// parameters are **not** redrawn: every retry refills the tiles under the same
/// [`Situation`]. A failure here therefore means the drawn situation could not
/// be built, which the caller must report rather than paper over by sampling a
/// different situation — that silent re-draw is exactly what biases a filtered
/// drill toward its easiest cases.
pub(crate) fn generate_reachable_candidate_for(
    category: &str,
    situation: Situation,
) -> Result<GameState, String> {
    let mut last_error = String::new();
    for _ in 0..MAX_REACHABILITY_ATTEMPTS {
        match situation.fill(category) {
            Ok(state) => match support::state_validation::validate_reachable_state(&state) {
                Ok(()) => return Ok(state),
                Err(err) => last_error = err,
            },
            Err(err) => last_error = err,
        }
    }

    Err(format!(
        "failed to fill the drawn {category} situation ({}) after \
         {MAX_REACHABILITY_ATTEMPTS} attempt(s): {last_error}",
        situation.label()
    ))
}

/// Generate a lesson puzzle that the loaded Mortal model also plays.
///
/// This is [`generate_puzzle`] with the opt-in agreement filter applied: each
/// candidate is evaluated and discarded unless Mortal's top-ranked action is
/// one of the lesson's accepted answers (`correct_action` plus
/// `equivalent_tiles`, compared on the full action including the discard tile).
/// See [`mortal_agreement`] for the rule and the cost model.
///
/// `ai_best_action` is not accepted here: its answer *is* Mortal's argmax and it
/// is generated through the evaluator (`generate_ai_puzzle`), so the filter
/// would be vacuous. The `mock_table` fixture is returned unchanged with no
/// report, because it is a UI mock rather than a sampled position.
pub fn generate_puzzle_with_agreement(
    category: &str,
    model: &MortalV4Model,
    model_name: &str,
    options: MortalAgreementOptions,
) -> Result<GeneratedPuzzle, String> {
    mortal_agreement::generate_with_model(category, model, model_name, options)
}

/// A generated puzzle and, when sampling ran, what it cost.
#[derive(Debug, Clone, Serialize)]
pub struct GeneratedPuzzle {
    /// The finalized table, ready to render and grade.
    pub state: GameState,
    /// Present only when Mortal-agreement sampling ran.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agreement: Option<MortalAgreementReport>,
}

/// How many full generations to try before the reachability guard gives up.
const MAX_REACHABILITY_ATTEMPTS: usize = 8;

/// Attach derived fields that must never be trusted from a generator literal.
///
/// The book rationale is a pure function of the state plus the static rule
/// table, so it is stamped once at the generation boundary and recomputed on
/// report import.
pub fn finalize_state(mut state: GameState) -> GameState {
    state.book_rationale = crate::rationale::rationale_for(&state);
    // A Kan decision asks about the quad before anything else, so the Riichi
    // toggle must never appear on it even when the closed hand could declare.
    state.can_riichi = !matches!(state.target_action, crate::state::TargetAction::Kan)
        && crate::ai::actions::riichi_is_legal(&state);
    state
}

/// Standalone function for generating a 14-tile hand via 5-block theory.
pub fn generate_random_hand() -> Vec<Tile> {
    block_theory::random_hand::generate()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::CorrectActionType;

    #[test]
    fn every_scenario_id_generates_its_own_category() {
        for &id in ScenarioId::ALL {
            assert_eq!(ScenarioId::from_id(id.as_str()), Some(id));
            if id == ScenarioId::AiBestAction {
                assert!(id.generate(id.as_str()).is_err());
                continue;
            }
            let state = id
                .generate(id.as_str())
                .unwrap_or_else(|err| panic!("{} failed: {err}", id.as_str()));
            assert_eq!(state.category, id.as_str());
        }
    }

    #[test]
    fn manifest_matches_the_registered_scenario_ids() {
        let manifest_ids: Vec<ScenarioId> = SCENARIO_MANIFEST.iter().map(|meta| meta.id).collect();
        assert_eq!(manifest_ids, ScenarioId::ALL.to_vec());

        for meta in SCENARIO_MANIFEST {
            assert!(!meta.label.is_empty());
            assert!(!meta.description.is_empty());
            assert!(!meta.tags.is_empty());
        }
    }

    #[test]
    fn every_book_lesson_names_a_numbered_section() {
        for meta in SCENARIO_MANIFEST {
            match meta.book {
                // The Mortal drill has no book rule to cite, so the picker
                // files it under "Other" instead of inventing a group.
                None => assert_eq!(meta.id, ScenarioId::AiBestAction),
                Some(book) => {
                    assert!(
                        (1..=10).contains(&book.chapter),
                        "{}: chapter {} outside the book",
                        meta.id.as_str(),
                        book.chapter
                    );
                    assert!(
                        (1..=12).contains(&book.section),
                        "{}: section {} outside the chapter",
                        meta.id.as_str(),
                        book.section
                    );
                    assert!(!book.chapter_title.is_empty());
                    assert!(!book.section_title.is_empty());
                    assert_eq!(book.key(), format!("ch{}.{}", book.chapter, book.section));
                    assert!(book.label().starts_with(&book.key()));
                }
            }
        }
    }

    #[test]
    fn picker_group_matches_the_lesson_citation() {
        for meta in SCENARIO_MANIFEST {
            let Some(book) = meta.book else { continue };
            let citation = crate::rationale::scenario_source(meta.id.as_str())
                .unwrap_or_else(|| panic!("{} has no book citation", meta.id.as_str()));

            // The group is a section (ch7.3); the citation is the subsection
            // inside it, so only the chapter must line up.
            assert_eq!(
                book.chapter,
                citation.chapter,
                "{}: picker group ch{} but the citation is ch{}",
                meta.id.as_str(),
                book.chapter,
                citation.chapter
            );
            assert_eq!(
                book.chapter_title,
                citation.chapter_title,
                "{}: chapter title drifted from the citation",
                meta.id.as_str()
            );
        }
    }

    #[test]
    fn list_scenarios_json_serializes_the_manifest() {
        let parsed: serde_json::Value =
            serde_json::from_str(&list_scenarios_json()).expect("manifest must be valid JSON");
        let scenarios = parsed.as_array().expect("manifest must be an array");

        assert_eq!(scenarios.len(), ScenarioId::ALL.len());
        assert_eq!(scenarios[0]["id"], "ryanmen_protorun");
        assert_eq!(scenarios[0]["category"], "tile_efficiency");
        assert_eq!(scenarios[0]["requires_ai"], false);
        assert!(scenarios[0]["tags"].is_array());
        assert_eq!(scenarios[0]["book"]["chapter"], 4);
        assert_eq!(scenarios[0]["book"]["section"], 1);
        assert_eq!(scenarios[0]["book"]["key"], "ch4.1");
        assert_eq!(
            scenarios[0]["book"]["label"],
            "ch4.1 · Finding a redundant tile"
        );
        assert!(
            scenarios
                .iter()
                .any(|scenario| scenario["id"] == "ai_best_action"
                    && scenario["requires_ai"] == true
                    && scenario["book"].is_null())
        );
        assert!(
            scenarios
                .iter()
                .any(|scenario| scenario["id"] == "defense_safety_chart"
                    && scenario["category"] == "defense_decision")
        );
    }

    #[test]
    fn unknown_categories_fall_back_to_ryanmen_protorun() {
        let state = generate_puzzle("unknown_category").expect("fallback must generate");

        assert_eq!(state.category, "unknown_category");
        assert_eq!(state.players[0].melds.len(), 1);
        assert_eq!(state.correct_action.action_type(), CorrectActionType::Dama);
    }

    #[test]
    fn generate_random_hand_returns_fourteen_tiles() {
        assert_eq!(generate_random_hand().len(), 14);
    }

    #[test]
    fn mock_table_fixture_remains_reachable_for_payload_tests() {
        let state = generate_puzzle("mock_table").expect("mock table fixture must generate");

        assert_eq!(state.category, "mock_table");
    }

    #[test]
    fn every_generated_lesson_is_a_reachable_table() {
        use crate::generator::support::state_validation::validate_reachable_state;

        for &id in ScenarioId::ALL {
            if id == ScenarioId::AiBestAction {
                continue;
            }
            for run in 0..30 {
                let state = generate_puzzle(id.as_str())
                    .unwrap_or_else(|err| panic!("{} run {run} failed: {err}", id.as_str()));
                validate_reachable_state(&state).unwrap_or_else(|err| {
                    panic!(
                        "{} run {run} produced an unreachable table: {err}",
                        id.as_str()
                    )
                });
            }
        }
    }

    #[test]
    fn generated_rivers_never_invent_extra_discards() {
        use crate::generator::support::state_validation::validate_reachable_state;

        // The reported defect: one seat's river was two entries longer than the
        // others with no call to explain it. Every lesson must now keep the
        // rivers within one call's worth of the rotation.
        for category in [
            "ryanmen_protorun",
            "chiitoitsu_riichi_vs_dama",
            "shouminkan_decision",
            "defense_safety_chart",
            "defense_stuck_heuristic",
            "open_hand_defense",
        ] {
            for run in 0..20 {
                let state = generate_puzzle(category)
                    .unwrap_or_else(|err| panic!("{category} run {run} failed: {err}"));
                validate_reachable_state(&state)
                    .unwrap_or_else(|err| panic!("{category} run {run}: {err}"));

                let counts: Vec<usize> = state
                    .players
                    .iter()
                    .map(|player| player.discards.len())
                    .collect();
                let calls: usize = state.players.iter().map(|player| player.melds.len()).sum();
                let spread = counts.iter().max().unwrap() - counts.iter().min().unwrap();
                assert!(
                    spread <= 1 + calls,
                    "{category} run {run}: rivers {counts:?} with {calls} calls"
                );
            }
        }
    }

    #[test]
    fn generated_states_carry_the_riichi_gate() {
        for id in [
            ScenarioId::RyanmenProtorun,
            ScenarioId::ChiitoitsuRiichiVsDama,
            ScenarioId::ShouminkanDecision,
            ScenarioId::DefenseSafetyChart,
            ScenarioId::OpenHandDefense,
        ] {
            for run in 0..10 {
                let state = generate_puzzle(id.as_str())
                    .unwrap_or_else(|err| panic!("{} run {run}: {err}", id.as_str()));
                let expected = crate::ai::actions::riichi_is_legal(&state);
                assert_eq!(
                    state.can_riichi,
                    expected,
                    "{} run {run}: can_riichi must match the legal action set",
                    id.as_str()
                );
            }
        }

        // The block-theory lesson always holds an open Yakuhai Pon, so Riichi
        // is never legal there even when the hand is tenpai.
        let ryanmen = generate_puzzle(ScenarioId::RyanmenProtorun.as_str()).expect("ryanmen");
        assert!(!ryanmen.players[0].melds.is_empty());
        assert!(!ryanmen.can_riichi, "an open hand cannot declare Riichi");
    }

    #[test]
    fn chiitoitsu_riichi_lessons_offer_the_declaration() {
        for _ in 0..20 {
            let state = generate_puzzle(ScenarioId::ChiitoitsuRiichiVsDama.as_str())
                .expect("chiitoitsu lesson");
            if state.correct_action.action_type() == CorrectActionType::Riichi {
                assert!(
                    state.can_riichi,
                    "the book's Riichi answer must be an offerable declaration"
                );
                return;
            }
        }
        panic!("no Riichi chiitoitsu lesson was generated");
    }
}
