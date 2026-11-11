//! The book's tile-safety chart and fallback heuristics (Riichi Book 1, ch. 8).
//!
//! [`SafetyRank`] is the chart from ch. 8, "Safety ranking"
//! (`RiichiBook1-ch8-defense.tex`, `tbl:safety`): fifteen rows, from 100%
//! genbutsu down to a non-suji 4/5/6. [`SafetyFacts::read`] places one tile on
//! that chart using only what the defender can see — the threat's river
//! (genbutsu), every tile anyone discarded after the threat declared Riichi
//! (also genbutsu), every visible copy (all four rivers, open melds, the dora
//! indicator, the defender's own hand) — plus the suji and blockade arithmetic
//! from the same chapter.
//!
//! [`SafetyFacts::stuck_rules`] encodes the chapter's fallback list, "What to
//! discard when you get stuck": break up pairs and concealed sets, avoid the
//! dora and its neighbours, and prefer tiles outside the threat's early
//! discards.
//!
//! Two limits, both stated in the book and repeated in the scenario caveats:
//!
//! - The chart's AAA row is only dangerous against Thirteen Orphans. The
//!   trainer keeps the table's conservative rank rather than promoting a
//!   fourth copy to 100%.
//! - The book gives no turn number for the one-chance split between "earlier"
//!   (BB-) and "later" (C) turns; [`EARLY_TURN_LIMIT`] is the trainer's cut.

use std::cmp::Ordering;
use std::collections::HashMap;

use agari::context::indicator_to_dora;
use agari::tile::{Honor, Suit, Tile};
use serde::{Deserialize, Serialize};

use crate::state::{GameState, Wind, is_out_of_rotation_call};

/// Discards the threat may have made before the book's one-chance read drops
/// from "earlier turns" (BB-) to "later turns" (C).
pub const EARLY_TURN_LIMIT: usize = 6;

/// One row of Riichi Book 1's safety ranking (`tbl:safety`), safest first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SafetyRank {
    Genbutsu,
    Aaa,
    Aa,
    AaMinus,
    APlus,
    A,
    Bbb,
    BbPlus,
    BbMinus,
    B,
    Cc,
    C,
    Ddd,
    Dd,
    D,
}

impl SafetyRank {
    /// Every rank, safest first.
    pub const ALL: [SafetyRank; 15] = [
        SafetyRank::Genbutsu,
        SafetyRank::Aaa,
        SafetyRank::Aa,
        SafetyRank::AaMinus,
        SafetyRank::APlus,
        SafetyRank::A,
        SafetyRank::Bbb,
        SafetyRank::BbPlus,
        SafetyRank::BbMinus,
        SafetyRank::B,
        SafetyRank::Cc,
        SafetyRank::C,
        SafetyRank::Ddd,
        SafetyRank::Dd,
        SafetyRank::D,
    ];

    /// Position on the chart: 0 is the safest row, 14 the most dangerous.
    pub fn order(self) -> u8 {
        match self {
            SafetyRank::Genbutsu => 0,
            SafetyRank::Aaa => 1,
            SafetyRank::Aa => 2,
            SafetyRank::AaMinus => 3,
            SafetyRank::APlus => 4,
            SafetyRank::A => 5,
            SafetyRank::Bbb => 6,
            SafetyRank::BbPlus => 7,
            SafetyRank::BbMinus => 8,
            SafetyRank::B => 9,
            SafetyRank::Cc => 10,
            SafetyRank::C => 11,
            SafetyRank::Ddd => 12,
            SafetyRank::Dd => 13,
            SafetyRank::D => 14,
        }
    }

    /// The chart's own label, e.g. `AAA`.
    pub fn code(self) -> &'static str {
        match self {
            SafetyRank::Genbutsu => "100%",
            SafetyRank::Aaa => "AAA",
            SafetyRank::Aa => "AA",
            SafetyRank::AaMinus => "AA-",
            SafetyRank::APlus => "A+",
            SafetyRank::A => "A",
            SafetyRank::Bbb => "BBB",
            SafetyRank::BbPlus => "BB+",
            SafetyRank::BbMinus => "BB-",
            SafetyRank::B => "B",
            SafetyRank::Cc => "CC",
            SafetyRank::C => "C",
            SafetyRank::Ddd => "DDD",
            SafetyRank::Dd => "DD",
            SafetyRank::D => "D",
        }
    }

    /// The chart row's wording from the book.
    pub fn label(self) -> &'static str {
        match self {
            SafetyRank::Genbutsu => "Genbutsu",
            SafetyRank::Aaa => "Fourth suji terminal / fourth honor tile",
            SafetyRank::Aa => "Third suji terminal / third honor tile",
            SafetyRank::AaMinus => "Second suji terminal",
            SafetyRank::APlus => "Second valueless wind / first suji terminal",
            SafetyRank::A => "Second honor tile",
            SafetyRank::Bbb => "Suji 4-5-6 / no-chance tile",
            SafetyRank::BbPlus => "Suji 2-8",
            SafetyRank::BbMinus => "Suji 3-7 / one-chance tile (early)",
            SafetyRank::B => "First honor tile",
            SafetyRank::Cc => "Non-suji terminal",
            SafetyRank::C => "One-chance tile (late)",
            SafetyRank::Ddd => "Non-suji 2-8",
            SafetyRank::Dd => "Non-suji 3-7",
            SafetyRank::D => "Non-suji 4-5-6",
        }
    }

    /// True for the rows the book only fears against Thirteen Orphans.
    pub fn is_kokushi_only(self) -> bool {
        self == SafetyRank::Aaa
    }
}

/// Which part of the chapter's argument places a tile on the chart.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SafetyMechanism {
    /// The tile is in the threat's river.
    Genbutsu,
    /// Anyone discarded the tile after the threat declared Riichi, so the
    /// threat's fixed wait cannot ron it.
    PostRiichiGenbutsu,
    /// An honor ranked by its visible copies.
    Honor,
    /// A side wait denied because the middle tile is genbutsu.
    Suji,
    /// Every side wait denied by a full blockade (or the combined table).
    NoChance,
    /// Every side wait needs the last copy of a protorun tile.
    OneChance,
    /// Nothing above applies; the tile is ranked by its versatility.
    NonSuji,
}

/// The book's read for one tile, with the short reason shown to the learner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TileRead {
    pub rank: SafetyRank,
    pub mechanism: SafetyMechanism,
    /// Short phrase, e.g. `suji of 4m` or `all four 2m are visible`.
    pub reason: String,
}

/// What the defender can see, from one threat player's point of view.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SafetyFacts {
    pub round_wind: Wind,
    pub threat_wind: Wind,
    /// The threat's own discards, in river order.
    pub genbutsu: Vec<Tile>,
    /// Tiles anyone discarded after the threat declared Riichi. They are 100%
    /// safe too: the declaration fixes the threat's wait, so it cannot ron
    /// them.
    ///
    /// Ch. 8, "Genbutsu and other absolutely safe tiles": "if X has called
    /// riichi, then all the tiles discarded by anyone after riichi (and passed
    /// up by X) are also called X's genbutsu tiles."
    pub post_riichi_genbutsu: Vec<Tile>,
    /// The first [`EARLY_TURN_LIMIT`] of the threat's own discards.
    pub early_discards: Vec<Tile>,
    /// Every visible copy: all rivers, open melds, dora indicators, and the
    /// defender's own hand and draw. Hidden hands are not visible.
    pub visible: HashMap<Tile, u8>,
}

impl SafetyFacts {
    /// Build the facts from a threat river and an already-counted visibility map.
    ///
    /// Use [`Self::with_post_riichi_genbutsu`] to add the tiles anyone
    /// discarded after the Riichi declaration.
    pub fn new(
        round_wind: Wind,
        threat_wind: Wind,
        genbutsu: Vec<Tile>,
        visible: HashMap<Tile, u8>,
    ) -> Self {
        let early = genbutsu.len().min(EARLY_TURN_LIMIT);
        let early_discards = genbutsu[..early].to_vec();

        Self {
            round_wind,
            threat_wind,
            genbutsu,
            post_riichi_genbutsu: Vec::new(),
            early_discards,
            visible,
        }
    }

    /// Add every tile anyone discarded after the threat declared Riichi.
    ///
    /// These are genbutsu too (ch. 8), so they are exactly as safe as the
    /// threat's own river. They are kept apart from [`Self::genbutsu`] because
    /// the chapter's early/late reads are about the threat's own river only.
    pub fn with_post_riichi_genbutsu(mut self, tiles: impl IntoIterator<Item = Tile>) -> Self {
        self.post_riichi_genbutsu = tiles.into_iter().collect();
        self.post_riichi_genbutsu.sort();
        self.post_riichi_genbutsu.dedup();
        self
    }

    /// Build the facts from a finished table state.
    ///
    /// Returns `None` when `threat_seat` names no player or a discard is not a
    /// parseable tile code.
    pub fn from_state(state: &GameState, threat_seat: usize) -> Option<Self> {
        let threat = state
            .players
            .iter()
            .find(|player| player.seat == threat_seat)?;

        let mut genbutsu = Vec::with_capacity(threat.discards.len());
        for discard in &threat.discards {
            genbutsu.push(Tile::try_from(discard.tile.as_str()).ok()?);
        }

        let mut visible: HashMap<Tile, u8> = HashMap::new();
        let mut rivers: Vec<Vec<Tile>> = Vec::with_capacity(state.players.len());
        for player in &state.players {
            let mut river = Vec::with_capacity(player.discards.len());
            for discard in &player.discards {
                if let Ok(tile) = Tile::try_from(discard.tile.as_str()) {
                    increment(&mut visible, tile);
                    river.push(tile);
                }
            }
            rivers.push(river);
        }
        for player in &state.players {
            for meld in &player.melds {
                for code in &meld.tiles {
                    if let Ok(tile) = Tile::try_from(code.as_str()) {
                        increment(&mut visible, tile);
                    }
                }
            }
            if player.is_human {
                for code in &player.hand {
                    if let Ok(tile) = Tile::try_from(code.as_str()) {
                        increment(&mut visible, tile);
                    }
                }
                if let Some(draw) = &player.draw
                    && let Ok(tile) = Tile::try_from(draw.as_str())
                {
                    increment(&mut visible, tile);
                }
            }
        }
        for code in &state.dora_indicators {
            if let Ok(tile) = Tile::try_from(code.as_str()) {
                increment(&mut visible, tile);
            }
        }

        let facts = Self::new(state.round_wind, threat.wind, genbutsu, visible);

        // Calls move the walk out of the natural rotation, so the discard the
        // declaration landed on is no longer fixed by the river positions.
        // The defense lessons never deal a meld, so only skip the read when a
        // call actually breaks the rotation.
        let Some(declaration_index) = threat.riichi_discard_index.filter(|_| threat.is_riichi)
        else {
            return Some(facts);
        };
        if state.players.iter().any(|player| {
            player
                .melds
                .iter()
                .any(|meld| is_out_of_rotation_call(player.seat, meld))
        }) {
            return Some(facts);
        }

        let post_riichi =
            post_riichi_discards(&rivers, state.dealer_seat(), threat_seat, declaration_index);
        Some(facts.with_post_riichi_genbutsu(post_riichi))
    }

    /// How many copies of `tile` the defender can see.
    pub fn visible_of(&self, tile: Tile) -> u8 {
        self.visible.get(&tile).copied().unwrap_or(0)
    }

    /// True while the threat is still in the book's "earlier turns".
    pub fn is_early_hand(&self) -> bool {
        self.genbutsu.len() <= EARLY_TURN_LIMIT
    }

    /// True for a tile the riichi player's fixed wait cannot ron: a tile in its
    /// own river, or anything anyone discarded after the declaration.
    pub fn is_genbutsu(&self, tile: Tile) -> bool {
        self.genbutsu.contains(&tile) || self.post_riichi_genbutsu.contains(&tile)
    }

    /// Place one tile on the safety chart.
    pub fn read(&self, tile: Tile) -> TileRead {
        if self.genbutsu.contains(&tile) {
            return TileRead {
                rank: SafetyRank::Genbutsu,
                mechanism: SafetyMechanism::Genbutsu,
                reason: format!("in the riichi player's river ({tile})"),
            };
        }
        if self.post_riichi_genbutsu.contains(&tile) {
            return TileRead {
                rank: SafetyRank::Genbutsu,
                mechanism: SafetyMechanism::PostRiichiGenbutsu,
                reason: format!("discarded by someone after the riichi call ({tile})"),
            };
        }

        match tile {
            Tile::Honor(honor) => self.read_honor(tile, honor),
            Tile::Suited { suit, value } => self.read_suited(tile, suit, value),
        }
    }

    /// The rank alone, for sorting and generation filters.
    pub fn rank(&self, tile: Tile) -> SafetyRank {
        self.read(tile).rank
    }

    fn read_honor(&self, tile: Tile, honor: Honor) -> TileRead {
        let (rank, reason) = match self.visible_of(tile) {
            4 => (SafetyRank::Aaa, "all four copies are visible"),
            3 => (SafetyRank::Aa, "three copies are visible"),
            2 if self.valueless_wind(honor) => {
                (SafetyRank::APlus, "second copy of a valueless wind")
            }
            2 => (SafetyRank::A, "two copies are visible"),
            _ => (SafetyRank::B, "only this copy is visible"),
        };

        TileRead {
            rank,
            mechanism: SafetyMechanism::Honor,
            reason: reason.to_string(),
        }
    }

    fn read_suited(&self, tile: Tile, suit: Suit, value: u8) -> TileRead {
        let intervals = suji_intervals(value);
        let visible = self.visible_of(tile);

        // Suji: every side wait that could catch this tile is denied because
        // its middle tile is genbutsu (ch. 8, "Understanding suji").
        let by_suji: Vec<bool> = intervals
            .iter()
            .map(|(denier, _)| self.is_suited_genbutsu(suit, *denier))
            .collect();
        if by_suji.iter().all(|&denied| denied) {
            let deniers: Vec<Tile> = intervals
                .iter()
                .map(|(denier, _)| Tile::suited(suit, *denier))
                .collect();
            let suji_of = join_tiles(&deniers);
            // Suji of early discards is the reliable form: the book warns that a
            // suji tile of the declaration discard is as dangerous as a non-suji.
            let early = deniers
                .iter()
                .all(|denier| self.early_discards.contains(denier));
            let (rank, note) = match value {
                1 | 9 => (
                    match visible {
                        4 => SafetyRank::Aaa,
                        3 => SafetyRank::Aa,
                        2 => SafetyRank::AaMinus,
                        _ => SafetyRank::APlus,
                    },
                    "suji terminal",
                ),
                2 | 8 => (SafetyRank::BbPlus, "suji 2-8"),
                3 | 7 => (SafetyRank::BbMinus, "suji 3-7"),
                _ => (SafetyRank::Bbb, "suji 4-5-6"),
            };

            let reason = if early {
                format!("{note}: suji of {suji_of} in the early turns")
            } else {
                format!("{note}: suji of {suji_of}")
            };

            return TileRead {
                rank,
                mechanism: SafetyMechanism::Suji,
                reason,
            };
        }

        // Denied by a full blockade of one of the interval's protorun tiles
        // (ch. 8, "Understanding tile blockade"). A mix of suji and blockades is
        // the book's combined table (`tbl:kabesuji`): no side wait is left.
        let by_blockade: Vec<bool> = intervals
            .iter()
            .map(|(_, protorun)| self.interval_denied(suit, *protorun))
            .collect();
        if intervals
            .iter()
            .enumerate()
            .all(|(index, _)| by_suji[index] || by_blockade[index])
        {
            let blocker = intervals
                .iter()
                .zip(&by_blockade)
                .flat_map(|((_, protorun), _)| protorun.iter().copied())
                .find(|&tile_value| self.suited_visible(suit, tile_value) >= 4);

            let reason = match blocker {
                Some(blocker) => format!(
                    "no chance: all four {} are visible",
                    Tile::suited(suit, blocker)
                ),
                None => "no chance: the riichi player's discards deny every side wait".to_string(),
            };

            return TileRead {
                rank: SafetyRank::Bbb,
                mechanism: SafetyMechanism::NoChance,
                reason,
            };
        }

        // One chance: every side wait is denied or needs the last copy of a
        // protorun tile (ch. 8, "One chance").
        let one_chance = intervals.iter().enumerate().all(|(index, (_, protorun))| {
            by_suji[index] || by_blockade[index] || self.interval_one_chance(suit, *protorun)
        });
        if one_chance {
            let blocker = intervals
                .iter()
                .flat_map(|(_, protorun)| protorun.iter().copied())
                .find(|&tile_value| self.suited_visible(suit, tile_value) == 3)
                .unwrap_or(value);
            let rank = if self.is_early_hand() {
                SafetyRank::BbMinus
            } else {
                SafetyRank::C
            };

            return TileRead {
                rank,
                mechanism: SafetyMechanism::OneChance,
                reason: format!(
                    "one chance: three {} are visible",
                    Tile::suited(suit, blocker)
                ),
            };
        }

        let (rank, reason) = match value {
            1 | 9 => (SafetyRank::Cc, "non-suji terminal"),
            2 | 8 => (SafetyRank::Ddd, "non-suji 2-8"),
            3 | 7 => (SafetyRank::Dd, "non-suji 3-7"),
            _ => (SafetyRank::D, "non-suji 4-5-6"),
        };

        TileRead {
            rank,
            mechanism: SafetyMechanism::NonSuji,
            reason: reason.to_string(),
        }
    }

    fn suited_visible(&self, suit: Suit, value: u8) -> u8 {
        self.visible_of(Tile::suited(suit, value))
    }

    fn is_suited_genbutsu(&self, suit: Suit, value: u8) -> bool {
        self.is_genbutsu(Tile::suited(suit, value))
    }

    /// A protorun tile is fully blockaded when all four copies are visible.
    fn interval_denied(&self, suit: Suit, protorun: [u8; 2]) -> bool {
        protorun
            .iter()
            .any(|&value| self.suited_visible(suit, value) >= 4)
    }

    /// An incomplete blockade: exactly three copies are visible.
    fn interval_one_chance(&self, suit: Suit, protorun: [u8; 2]) -> bool {
        protorun
            .iter()
            .any(|&value| self.suited_visible(suit, value) == 3)
    }

    /// True for a wind that is neither the round wind nor the threat's seat
    /// wind, so it is worth nothing to that player.
    fn valueless_wind(&self, honor: Honor) -> bool {
        let wind = match honor {
            Honor::East => Wind::East,
            Honor::South => Wind::South,
            Honor::West => Wind::West,
            Honor::North => Wind::North,
            _ => return false,
        };

        wind != self.round_wind && wind != self.threat_wind
    }

    /// True when every side wait for `tile` needs a tile the threat discarded
    /// early, so the book's "tiles outside early discards" argument applies.
    pub fn outside_early_discards(&self, tile: Tile) -> bool {
        let (Some(suit), Some(value)) = (tile.suit(), tile.value()) else {
            return false;
        };

        suji_intervals(value).iter().all(|(_, protorun)| {
            protorun.iter().any(|&protorn_value| {
                self.early_discards
                    .contains(&Tile::suited(suit, protorn_value))
            })
        })
    }

    /// The book's fallback list for a tile, as booleans the caller can order.
    pub fn stuck_rules(
        &self,
        tile: Tile,
        hand: &HashMap<Tile, u8>,
        dora_indicators: &[Tile],
    ) -> StuckRules {
        StuckRules {
            pair_or_set: hand.get(&tile).copied().unwrap_or(0) >= 2,
            outside_early: self.outside_early_discards(tile),
            avoids_dora: !is_near_dora(tile, dora_indicators),
            avoids_tanyao: !tile.is_simple(),
        }
    }

    /// The fallback list's unique pick, or `None` when the rules tie.
    ///
    /// The book lists these as a fallback "when you cannot identify safe tiles
    /// at all", so the order is the chapter's own: tile chunks first, then
    /// avoiding expensive hands, then early-discard neighbours.
    pub fn stuck_choice(
        &self,
        candidates: &[Tile],
        hand: &HashMap<Tile, u8>,
        dora_indicators: &[Tile],
    ) -> Option<(Tile, StuckRules)> {
        let mut best: Option<(Tile, StuckRules, [u8; 4])> = None;
        let mut tied = false;

        for &tile in candidates {
            let rules = self.stuck_rules(tile, hand, dora_indicators);
            let score = rules.score();

            match &best {
                None => best = Some((tile, rules, score)),
                Some((best_tile, _, best_score)) => {
                    if *best_tile == tile {
                        continue;
                    }
                    match score.cmp(best_score) {
                        Ordering::Less => {
                            best = Some((tile, rules, score));
                            tied = false;
                        }
                        Ordering::Equal => tied = true,
                        Ordering::Greater => {}
                    }
                }
            }
        }

        if tied {
            return None;
        }

        best.map(|(tile, rules, _)| (tile, rules))
    }
}

/// The book's fallback rules as they apply to one candidate tile.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StuckRules {
    /// "Discard pairs and concealed sets."
    pub pair_or_set: bool,
    /// "Tiles that are outside those discarded in early turns are relatively safe."
    pub outside_early: bool,
    /// "Try not to discard the dora indicator tile ... and any tiles close to dora."
    pub avoids_dora: bool,
    /// "If you discard terminals, you can avoid dealing into a tanyao hand."
    pub avoids_tanyao: bool,
}

impl StuckRules {
    /// Ordered fallback keys; a lower value is the book's preference.
    pub fn score(self) -> [u8; 4] {
        [
            u8::from(!self.pair_or_set),
            u8::from(!self.outside_early),
            u8::from(!self.avoids_dora),
            u8::from(!self.avoids_tanyao),
        ]
    }
}

/// Every discard made after `threat_seat` declared Riichi at
/// `declaration_index` in its river.
///
/// Riichi Book 1, ch. 8, "Genbutsu and other absolutely safe tiles": "if X has
/// called riichi, then all the tiles discarded by anyone after riichi (and
/// passed up by X) are also called X's genbutsu tiles." They are 100% safe
/// because the declaration fixes X's wait.
///
/// The rivers interleave, and a player's river does not record turn numbers.
/// A plain rotation (the dealer, then one seat per discard) fixes each seat's
/// position relative to the declaration, so `rivers[seat].skip(before)` is
/// exactly the set of that seat's post-declaration discards. Callers must have
/// ruled out out-of-rotation calls, which break the arithmetic.
pub(crate) fn post_riichi_discards(
    rivers: &[Vec<Tile>],
    dealer: usize,
    threat_seat: usize,
    declaration_index: usize,
) -> Vec<Tile> {
    let declaration_step = seat_offset(threat_seat, dealer) as usize + 4 * declaration_index;

    let mut tiles = Vec::new();
    for (seat, river) in rivers.iter().enumerate() {
        if seat == threat_seat {
            continue;
        }
        let seat_step = seat_offset(seat, dealer) as usize;
        let before = if seat_step <= declaration_step {
            (declaration_step - seat_step) / 4 + 1
        } else {
            0
        };

        for &tile in river.iter().skip(before) {
            if !tiles.contains(&tile) {
                tiles.push(tile);
            }
        }
    }

    tiles
}

/// How many seats after the dealer `seat` plays in the opening rotation.
fn seat_offset(seat: usize, dealer: usize) -> u8 {
    ((seat + 4 - dealer) % 4) as u8
}

/// Upgrade a dora indicator into the dora, then test the tile and its neighbours.
pub fn is_near_dora(tile: Tile, dora_indicators: &[Tile]) -> bool {
    dora_indicators.iter().any(|&indicator| {
        let dora = indicator_to_dora(indicator);
        if tile == indicator || tile == dora {
            return true;
        }

        match (tile.suit(), tile.value(), dora.suit(), dora.value()) {
            (Some(a), Some(a_value), Some(b), Some(b_value)) => {
                a == b && a_value.abs_diff(b_value) <= 1
            }
            _ => false,
        }
    })
}

/// The side-wait intervals that can catch a number tile: `(denier, protorun)`.
///
/// A tile is `suji` when every denier is genbutsu — the opponent cannot wait on
/// this tile when the *other* end of that interval is in their river. A tile is
/// `no chance` when every protorun has a fully visible tile — the two rows of
/// `tbl:kabe` and `tbl:sujic`, derived instead of hand-copied.
fn suji_intervals(value: u8) -> &'static [(u8, [u8; 2])] {
    match value {
        1 => &[(4, [2, 3])],
        2 => &[(5, [3, 4])],
        3 => &[(6, [4, 5])],
        4 => &[(1, [2, 3]), (7, [5, 6])],
        5 => &[(2, [3, 4]), (8, [6, 7])],
        6 => &[(3, [4, 5]), (9, [7, 8])],
        7 => &[(4, [5, 6])],
        8 => &[(5, [6, 7])],
        _ => &[(6, [7, 8])],
    }
}

fn increment(counts: &mut HashMap<Tile, u8>, tile: Tile) {
    *counts.entry(tile).or_insert(0) += 1;
}

fn join_tiles(tiles: &[Tile]) -> String {
    tiles
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(" and ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::PlayerState;

    fn tile(code: &str) -> Tile {
        Tile::try_from(code).expect("tile code must parse")
    }

    fn with_visibility(
        genbutsu: &[&str],
        visible: &[&str],
        wind: Wind,
        round: Wind,
    ) -> SafetyFacts {
        let iter = genbutsu.iter().map(|code| tile(code)).collect();
        let mut counts = HashMap::new();
        for code in visible {
            increment(&mut counts, tile(code));
        }
        SafetyFacts::new(round, wind, iter, counts)
    }

    fn no_visibility(genbutsu: &[&str], wind: Wind) -> SafetyFacts {
        with_visibility(genbutsu, &[], wind, Wind::East)
    }

    fn player(
        seat: usize,
        wind: Wind,
        hand: &[&str],
        draw: Option<&str>,
        river: &[&str],
    ) -> PlayerState {
        PlayerState {
            seat,
            name: format!("seat {seat}"),
            is_human: seat == 0,
            wind,
            score: 25_000,
            hand: hand.iter().map(|code| code.to_string()).collect(),
            draw: draw.map(ToString::to_string),
            red_fives: Vec::new(),
            discards: river
                .iter()
                .map(|code| crate::state::DiscardTile::new(*code))
                .collect(),
            melds: Vec::new(),
            is_riichi: false,
            riichi_discard_index: None,
        }
    }

    fn empty_state(players: Vec<PlayerState>) -> GameState {
        GameState {
            category: "safety_test".to_string(),
            target_action: crate::state::TargetAction::Defend,
            correct_action: crate::state::CorrectAction::fold("1m"),
            equivalent_tiles: Vec::new(),
            decision: crate::state::DecisionContext::SelfTurn,
            ai_decision: None,
            riichi_triggers: Vec::new(),
            dama_reasons: Vec::new(),
            shouminkan_triggers: Vec::new(),
            book_rationale: None,
            can_riichi: false,
            hand_string: String::new(),
            tiles: Vec::new(),
            shanten: 2,
            is_agari: false,
            decompositions_count: 0,
            ukeire_tiles: Vec::new(),
            ukeire_total: 0,
            round_wind: Wind::East,
            hand_number: 1,
            honba: 0,
            riichi_sticks: 1,
            dora_indicators: Vec::new(),
            ura_dora_indicators: Vec::new(),
            tiles_remaining: 40,
            current_turn: 0,
            players,
        }
    }

    /// A self-turn table where seat 2 declared Riichi on its last discard and
    /// Kamicha (seat 3) discarded afterwards.
    ///
    /// East (seat 0) is the dealer, so the turn order is 0, 1, 2, 3. Seat 2's
    /// sixth discard is the declaration, which means seat 3's sixth discard
    /// comes after it; seat 0's and seat 1's sixth discards came before it.
    fn post_riichi_state() -> GameState {
        let mut players = vec![
            player(
                0,
                Wind::East,
                &[
                    "1m", "2m", "3m", "5m", "6m", "7m", "8m", "9m", "2s", "3s", "5s", "6s", "8s",
                ],
                Some("9s"),
                &["2p", "3p", "4p", "5p", "6p", "7p"],
            ),
            player(
                1,
                Wind::South,
                &[
                    "1p", "3p", "5p", "7p", "9p", "2z", "3z", "4z", "6z", "7z", "4s", "7s", "9s",
                ],
                None,
                &["1s", "3s", "4s", "5s", "7s", "8s"],
            ),
            player(
                2,
                Wind::West,
                &[
                    "1m", "3m", "5m", "7m", "9m", "1p", "3p", "5p", "7p", "9p", "2s", "4s", "6s",
                ],
                None,
                &["9s", "8s", "7s", "6s", "5s", "1z"],
            ),
            player(
                3,
                Wind::North,
                &[
                    "2m", "4m", "6m", "8m", "2p", "4p", "6p", "8p", "2s", "4s", "6s", "8s", "2z",
                ],
                None,
                &["6z", "5z", "4z", "3z", "2z", "4m"],
            ),
        ];
        players[2].is_riichi = true;
        players[2].riichi_discard_index = Some(5);
        players[2].discards[5] = crate::state::DiscardTile::riichi("1z");

        empty_state(players)
    }

    #[test]
    fn post_riichi_discards_follow_the_turn_order() {
        let state = post_riichi_state();
        let rivers: Vec<Vec<Tile>> = state
            .players
            .iter()
            .map(|player| {
                player
                    .discards
                    .iter()
                    .map(|discard| tile(&discard.tile))
                    .collect()
            })
            .collect();

        let after = post_riichi_discards(&rivers, state.dealer_seat(), 2, 5);

        // Only Kamicha plays after the declaration in this timeline, and only
        // her sixth discard does.
        assert_eq!(after, vec![tile("4m")]);
    }

    #[test]
    fn post_riichi_discards_are_genbutsu_like_the_threats_own_river() {
        let state = post_riichi_state();
        let facts = SafetyFacts::from_state(&state, 2).expect("facts must build");

        // The riichi player's own river is still the source of the original
        // genbutsu, and is not polluted by the post-declaration discards.
        assert_eq!(facts.genbutsu.len(), 6);
        assert_eq!(facts.post_riichi_genbutsu, vec![tile("4m")]);

        let own = facts.read(tile("1z"));
        let other = facts.read(tile("4m"));

        assert_eq!(own.rank, SafetyRank::Genbutsu);
        assert_eq!(own.mechanism, SafetyMechanism::Genbutsu);
        assert_eq!(other.rank, SafetyRank::Genbutsu);
        assert_eq!(other.mechanism, SafetyMechanism::PostRiichiGenbutsu);
        assert!(
            other.reason.contains("after the riichi call"),
            "{}",
            other.reason
        );

        // A discard made before the declaration is not genbutsu.
        let before = facts.read(tile("2z"));
        assert_ne!(before.rank, SafetyRank::Genbutsu);
        assert_eq!(before.mechanism, SafetyMechanism::Honor);

        // The post-riichi genbutsu feeds the suji arithmetic too: 4m denies the
        // 1-4 wait, so the 1m the defender holds is a suji terminal.
        assert_eq!(facts.read(tile("1m")).rank, SafetyRank::APlus);
    }

    #[test]
    fn out_of_rotation_calls_skip_the_post_riichi_read() {
        let mut state = post_riichi_state();
        state.players[1].melds.push(crate::state::CalledMeld {
            meld_type: crate::state::MeldType::Pon,
            tiles: vec!["5z".to_string(); 3],
            called_from: Some(3),
        });

        let facts = SafetyFacts::from_state(&state, 2).expect("facts must build");

        assert!(facts.post_riichi_genbutsu.is_empty());
        assert_ne!(facts.read(tile("4m")).rank, SafetyRank::Genbutsu);
    }

    #[test]
    fn chart_orders_runs_from_genbutsu_to_non_suji_middle() {
        assert_eq!(SafetyRank::ALL.len(), 15);
        for pair in SafetyRank::ALL.windows(2) {
            assert_eq!(pair[1].order(), pair[0].order() + 1);
            assert!(pair[0] < pair[1], "{:?} must beat {:?}", pair[0], pair[1]);
        }
        assert_eq!(SafetyRank::ALL[0].code(), "100%");
        assert_eq!(SafetyRank::ALL[14].code(), "D");
    }

    #[test]
    fn genbutsu_is_the_top_row() {
        let facts = no_visibility(&["3p"], Wind::South);
        let read = facts.read(tile("3p"));

        assert_eq!(read.rank, SafetyRank::Genbutsu);
        assert!(read.reason.contains("3p"));
    }

    #[test]
    fn suji_terminals_rank_by_visible_copies() {
        let facts = no_visibility(&["4m"], Wind::South);
        assert_eq!(facts.read(tile("1m")).rank, SafetyRank::APlus);
        // 7m is a suji 3-7 tile, one row below the suji terminal.
        assert_eq!(facts.read(tile("7m")).rank, SafetyRank::BbMinus);

        // One copy is the one in the defender's hand; each extra copy moves the
        // terminal one row up the chart.
        let facts = with_visibility(&["4m"], &["1m", "1m"], Wind::South, Wind::East);
        assert_eq!(facts.read(tile("1m")).rank, SafetyRank::AaMinus);

        let facts = with_visibility(&["4m"], &["1m", "1m", "1m"], Wind::South, Wind::East);
        assert_eq!(facts.read(tile("1m")).rank, SafetyRank::Aa);

        let facts = with_visibility(&["4m"], &["1m", "1m", "1m", "1m"], Wind::South, Wind::East);
        assert_eq!(facts.read(tile("1m")).rank, SafetyRank::Aaa);
    }

    #[test]
    fn suji_reason_marks_whether_the_denier_was_early() {
        let facts = no_visibility(&["4m"], Wind::South);
        assert!(facts.read(tile("1m")).reason.contains("early turns"));

        // The same denier in a late river is not the reliable form.
        let mut late = no_visibility(&["4m"], Wind::South);
        late.genbutsu = vec![tile("9p"); EARLY_TURN_LIMIT];
        late.genbutsu.push(tile("4m"));
        late.early_discards = late.genbutsu[..EARLY_TURN_LIMIT].to_vec();

        assert_eq!(late.read(tile("1m")).rank, SafetyRank::APlus);
        assert!(!late.read(tile("1m")).reason.contains("early turns"));
    }

    #[test]
    fn suji_simples_follow_the_middle_discard() {
        let facts = no_visibility(&["5m"], Wind::South);
        assert_eq!(facts.read(tile("2m")).rank, SafetyRank::BbPlus);
        assert_eq!(facts.read(tile("8m")).rank, SafetyRank::BbPlus);

        let facts = no_visibility(&["6m"], Wind::South);
        assert_eq!(facts.read(tile("3m")).rank, SafetyRank::BbMinus);
        assert_eq!(facts.read(tile("9m")).rank, SafetyRank::APlus);
    }

    #[test]
    fn suji_middle_needs_both_ends_and_ranks_bbb() {
        assert_eq!(
            no_visibility(&["1m"], Wind::South).read(tile("4m")).rank,
            SafetyRank::D
        );
        assert_eq!(
            no_visibility(&["7m"], Wind::South).read(tile("4m")).rank,
            SafetyRank::D
        );
        assert_eq!(
            no_visibility(&["1m", "7m"], Wind::South)
                .read(tile("4m"))
                .rank,
            SafetyRank::Bbb
        );
    }

    #[test]
    fn blockades_make_the_neighbouring_terminal_no_chance() {
        let facts = with_visibility(&[], &["2m", "2m", "2m", "2m"], Wind::South, Wind::East);
        let read = facts.read(tile("1m"));

        assert_eq!(read.rank, SafetyRank::Bbb);
        assert!(read.reason.contains("2m"));
    }

    #[test]
    fn a_blockade_of_two_and_genbutsu_of_seven_makes_four_no_chance() {
        // The book's combined blockade + suji table (`tbl:kabesuji`): a 2m
        // blockade denies the 1-4 wait and 7m's genbutsu denies the 4-7 wait,
        // so no side wait can catch 4m even though it is not plain suji.
        let facts = with_visibility(&["7m"], &["2m", "2m", "2m", "2m"], Wind::South, Wind::East);

        assert_eq!(facts.read(tile("4m")).rank, SafetyRank::Bbb);
    }

    #[test]
    fn one_chance_splits_on_the_turn_number() {
        let early = with_visibility(&[], &["3p", "3p", "3p"], Wind::South, Wind::East);
        assert_eq!(early.read(tile("2p")).rank, SafetyRank::BbMinus);
        assert!(early.is_early_hand());

        let mut late = early.clone();
        late.genbutsu = (0..EARLY_TURN_LIMIT + 1)
            .map(|_| tile("9s"))
            .collect::<Vec<_>>();
        late.early_discards = late.genbutsu[..EARLY_TURN_LIMIT].to_vec();
        assert_eq!(late.read(tile("2p")).rank, SafetyRank::C);
    }

    #[test]
    fn non_suji_ranks_follow_versatility() {
        let facts = no_visibility(&[], Wind::South);

        assert_eq!(facts.read(tile("1m")).rank, SafetyRank::Cc);
        assert_eq!(facts.read(tile("2m")).rank, SafetyRank::Ddd);
        assert_eq!(facts.read(tile("3m")).rank, SafetyRank::Dd);
        assert_eq!(facts.read(tile("5m")).rank, SafetyRank::D);
    }

    #[test]
    fn honors_rank_by_visible_copies_and_valueless_winds() {
        let facts = no_visibility(&[], Wind::East);
        assert_eq!(facts.read(tile("1z")).rank, SafetyRank::B);

        // East is both the round wind and the threat's seat wind: not valueless.
        let facts = with_visibility(&[], &["1z", "1z"], Wind::East, Wind::East);
        assert_eq!(facts.read(tile("1z")).rank, SafetyRank::A);

        // A guest wind with the same count ranks one row higher.
        let facts = with_visibility(&[], &["3z", "3z"], Wind::East, Wind::East);
        assert_eq!(facts.read(tile("3z")).rank, SafetyRank::APlus);

        let facts = with_visibility(&[], &["3z", "3z", "3z"], Wind::East, Wind::East);
        assert_eq!(facts.read(tile("3z")).rank, SafetyRank::Aa);

        let facts = with_visibility(&[], &["3z", "3z", "3z", "3z"], Wind::East, Wind::East);
        assert_eq!(facts.read(tile("3z")).rank, SafetyRank::Aaa);
    }

    #[test]
    fn outside_early_discards_needs_every_protorun_covered() {
        let facts = no_visibility(&["2m"], Wind::South);

        // 1m only needs the 2-3 protorun.
        assert!(facts.outside_early_discards(tile("1m")));
        // 4m needs both 2-3 and 5-6.
        assert!(!facts.outside_early_discards(tile("4m")));

        let facts = no_visibility(&["2m", "5m"], Wind::South);
        assert!(facts.outside_early_discards(tile("4m")));
    }

    #[test]
    fn stuck_rules_put_pairs_before_a_marginal_rank() {
        let facts = no_visibility(&["2m", "5m"], Wind::South);
        let paired = tile("4m");
        let single = tile("3p");

        let mut hand = HashMap::new();
        hand.insert(paired, 2);
        hand.insert(single, 1);

        let choice = facts
            .stuck_choice(&[paired, single], &hand, &[tile("9p")])
            .expect("rules must pick a tile");

        assert_eq!(choice.0, paired);
        assert!(choice.1.pair_or_set);
        assert!(choice.1.outside_early);
        assert!(choice.1.avoids_dora);
        assert!(!choice.1.avoids_tanyao, "4m is a simple tile");
    }

    #[test]
    fn stuck_choice_reports_a_tie_instead_of_guessing() {
        let facts = no_visibility(&[], Wind::South);
        let mut hand = HashMap::new();
        hand.insert(tile("4m"), 1);
        hand.insert(tile("5m"), 1);

        assert!(
            facts
                .stuck_choice(&[tile("4m"), tile("5m")], &hand, &[tile("9p")])
                .is_none()
        );
    }

    #[test]
    fn near_dora_covers_the_indicator_the_dora_and_its_neighbours() {
        let indicators = [tile("4p")];

        assert!(is_near_dora(tile("4p"), &indicators));
        assert!(is_near_dora(tile("5p"), &indicators));
        assert!(is_near_dora(tile("6p"), &indicators));
        assert!(!is_near_dora(tile("3p"), &indicators));
        assert!(!is_near_dora(tile("7p"), &indicators));
        assert!(!is_near_dora(tile("5m"), &indicators));
    }

    #[test]
    fn facts_from_state_count_only_visible_copies() {
        let state = crate::fixtures::mock_table::generate("mock_table").unwrap();
        let threat = state
            .players
            .iter()
            .find(|player| !player.is_human)
            .expect("mock table has opponents")
            .clone();
        let seat = threat.seat;

        let facts = SafetyFacts::from_state(&state, seat).expect("facts must build");
        assert_eq!(facts.genbutsu.len(), threat.discards.len());
        assert_eq!(facts.threat_wind, threat.wind);

        let human = state
            .players
            .iter()
            .find(|player| player.is_human)
            .expect("mock table has a human");
        for code in &human.hand {
            assert!(
                facts.visible_of(tile(code)) >= 1,
                "the human hand is visible to the defender"
            );
        }
        // Hidden hands are not visible: the opponents' hand tiles are not
        // counted unless they also appear in a river or the human's hand.
        let opponent = state
            .players
            .iter()
            .find(|player| player.seat != 0 && player.seat != seat)
            .expect("a third player");
        let hidden_only: Vec<&String> = opponent
            .hand
            .iter()
            .filter(|code| !human.hand.contains(code))
            .collect();
        assert!(!hidden_only.is_empty());
    }

    #[test]
    fn from_state_rejects_an_unknown_seat() {
        let state = crate::fixtures::mock_table::generate("mock_table").unwrap();
        assert!(SafetyFacts::from_state(&state, 9).is_none());
    }

    #[test]
    fn player_state_stays_comparable_for_fixtures() {
        // `SafetyFacts` is a read-only view; nothing about the table changes.
        let state = crate::fixtures::mock_table::generate("mock_table").unwrap();
        let _: &Vec<PlayerState> = &state.players;
    }
}
