//! Port of libriichi's single-player EV solver (`libriichi/src/algo/sp/`).
//!
//! Mortal v4 fills observation rows 889..=1011 from
//! `PlayerState::single_player_tables()`, which runs a recursive draw/discard
//! expectation calculation over the unseen wall. This module is a direct port
//! of that solver for the flags libriichi uses when building the observation:
//!
//! ```text
//! sort_result: true
//! maximize_win_prob: false
//! calc_tegawari: false
//! calc_shanten_down: false
//! ```
//!
//! Deliberate deviations from the reference:
//!
//! * `std::collections::HashMap` replaces `ahash::AHashMap`; fixed `[f32; 17]`
//!   buffers replace `tinyvec::ArrayVec`. The dependency surface for the wasm
//!   build stays unchanged.
//! * Shanten is a direct port of `agari`'s recursive algorithm, operating on
//!   `[u8; 34]` so the solver never allocates a `HashMap` per shanten call.
//!   `agari::shanten::calculate_shanten_with_melds` is the authority; the port
//!   mirrors its formulas exactly.
//! * Win values are scored with `agari`'s fu / yaku / payment functions
//!   instead of libriichi's `AgariCalculator`. This is the same scoring model;
//!   yakuman stacking uses `agari`'s `ScoreLevel::Yakuman(n)` convention.
//! * `calc_tegawari` is not implemented. Production encoding always passes
//!   `false` (see `agent_helper.rs:567-583`), so only that path exists here.
//!
//! All tile ids are Mortal's deakaized 0..=33 ids except discard candidates,
//! which may carry an aka id 34..=36 exactly like the reference.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::rc::Rc;

use agari::context::{GameContext, WinType};
use agari::hand::{KanType, Meld, decompose_hand, decompose_hand_with_melds};
use agari::parse::TileCounts;
use agari::scoring::{calculate_basic_points, calculate_fu, calculate_payment};
use agari::shanten::{array_to_tilecounts, index_to_tile, tile_to_index};
use agari::tile::Honor;
use agari::yaku::detect_yaku_with_context;

/// The practical maximum number of tsumos left (same as `obs_repr.rs`).
pub const MAX_TSUMOS_LEFT: usize = 17;
/// libriichi's `SHANTEN_THRES`: 3-shanten and better gets probabilities.
const SHANTEN_THRES: i8 = 3;
/// Upper bound used by libriichi's not-tsumo table.
const MAX_TILES_LEFT: usize = 34 * 4 - 1 - 13;

/// A tile that improves the hand, and how many copies are unseen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RequiredTile {
    pub tile: usize,
    pub count: u8,
}

/// One discard (or the draw for reaction decisions) and its computed values.
#[derive(Debug, Clone, Default)]
pub struct Candidate {
    /// Mortal tile id; may be an aka id (34..=36) for discards.
    pub tile: usize,
    pub tenpai_probs: Vec<f32>,
    pub win_probs: Vec<f32>,
    pub exp_values: Vec<f32>,
    pub required_tiles: Vec<RequiredTile>,
    pub num_required_tiles: u8,
    pub shanten_down: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CandidateColumn {
    Ev,
    WinProb,
    TenpaiProb,
    NotShantenDown,
    NumRequiredTiles,
    DiscardPriority,
}

impl Candidate {
    /// Mirrors `Candidate::cmp` in `libriichi/src/algo/sp/candidate.rs`.
    pub fn cmp(&self, other: &Self, by: CandidateColumn) -> Ordering {
        if self.tile == other.tile {
            return Ordering::Equal;
        }
        match by {
            CandidateColumn::Ev => match total_cmp(self.ev0(), other.ev0()) {
                Ordering::Equal => self.cmp(other, CandidateColumn::WinProb),
                o => o,
            },
            CandidateColumn::WinProb => match total_cmp(self.win0(), other.win0()) {
                Ordering::Equal => self.cmp(other, CandidateColumn::TenpaiProb),
                o => o,
            },
            CandidateColumn::TenpaiProb => match total_cmp(self.tenpai0(), other.tenpai0()) {
                Ordering::Equal => self.cmp(other, CandidateColumn::NotShantenDown),
                o => o,
            },
            CandidateColumn::NotShantenDown => match (self.shanten_down, other.shanten_down) {
                (false, true) => Ordering::Greater,
                (true, false) => Ordering::Less,
                _ => self.cmp(other, CandidateColumn::NumRequiredTiles),
            },
            CandidateColumn::NumRequiredTiles => {
                match self.num_required_tiles.cmp(&other.num_required_tiles) {
                    Ordering::Equal => self.cmp(other, CandidateColumn::DiscardPriority),
                    o => o,
                }
            }
            CandidateColumn::DiscardPriority => cmp_discard_priority(self.tile, other.tile),
        }
    }

    fn ev0(&self) -> f32 {
        self.exp_values.first().copied().unwrap_or(0.0)
    }

    fn win0(&self) -> f32 {
        self.win_probs.first().copied().unwrap_or(0.0)
    }

    fn tenpai0(&self) -> f32 {
        self.tenpai_probs.first().copied().unwrap_or(0.0)
    }
}

fn total_cmp(left: f32, right: f32) -> Ordering {
    left.total_cmp(&right)
}

/// libriichi's `DISCARD_PRIORITIES`, with higher values preferred.
const DISCARD_PRIORITIES: [u8; 38] = [
    6, 5, 4, 3, 2, 3, 4, 5, 6, // m
    6, 5, 4, 3, 2, 3, 4, 5, 6, // p
    6, 5, 4, 3, 2, 3, 4, 5, 6, // s
    7, 7, 7, 7, 7, 7, 7, // z
    1, 1, 1, // aka
    0, // unknown
];

/// Mirrors `Tile::cmp_discard_priority`.
pub fn cmp_discard_priority(left: usize, right: usize) -> Ordering {
    match DISCARD_PRIORITIES[left].cmp(&DISCARD_PRIORITIES[right]) {
        Ordering::Equal => right.cmp(&left),
        o => o,
    }
}

/// Resolve an aka tile id to its base tile id.
pub fn deaka(tile: usize) -> usize {
    match tile {
        34 => 4,  // 5mr -> 5m
        35 => 13, // 5pr -> 5p
        36 => 22, // 5sr -> 5s
        _ => tile,
    }
}

/// The base-tile index of a discarding aka tile, if `tile` is an aka id.
fn aka_suit(tile: usize) -> Option<usize> {
    match tile {
        34 => Some(0),
        35 => Some(1),
        36 => Some(2),
        _ => None,
    }
}

const URADORA_PROB_TABLE: [[f32; 13]; 5] = [
    [
        0.639485, 0.327801, 0.0327134, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    ],
    [
        0.406736, 0.42281, 0.147966, 0.021674, 0.0008142, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    ],
    [
        0.257516, 0.406819, 0.246851, 0.0757724, 0.0122266, 0.0008004, 0.0000143, 0.0, 0.0, 0.0,
        0.0, 0.0, 0.0,
    ],
    [
        0.162199, 0.346513, 0.301539, 0.142396, 0.0401276, 0.0066491, 0.0005575, 0.0000185, 0.0,
        0.0, 0.0, 0.0, 0.0,
    ],
    [
        0.101768, 0.275319, 0.313742, 0.20189, 0.081774, 0.0215394, 0.0035918, 0.0003607,
        0.0000152, 0.0000003, 0.0, 0.0, 0.0,
    ],
];

/// Immutable inputs to the solver.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct InitState {
    pub tehai: [u8; 34],
    pub akas_in_hand: [bool; 3],
    pub tiles_seen: [u8; 34],
    pub akas_seen: [bool; 3],
}

/// Solver configuration; mirrors the fields used by libriichi.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SPCalculator {
    /// Number of melds still to complete (4 for a closed hand).
    pub tehai_len_div3: u8,
    pub chis: Vec<u8>,
    pub pons: Vec<u8>,
    pub minkans: Vec<u8>,
    pub ankans: Vec<u8>,
    pub bakaze: u8,
    pub jikaze: u8,
    pub is_menzen: bool,
    /// Dora held in melds (including akas in melds).
    pub num_doras_in_fuuro: u8,
    pub dora_indicators: Vec<u8>,
    pub calc_double_riichi: bool,
    pub calc_haitei: bool,
    pub prefer_riichi: bool,
    pub sort_result: bool,
    pub maximize_win_prob: bool,
    pub calc_shanten_down: bool,
}

/// Why the solver refused to run. Mirrors libriichi's `ensure!` preconditions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SolverError {
    /// The hand is already complete (`real_time_shanten() < 0`).
    AlreadyAgari,
    /// No tsumo left after accounting for the reaction timing.
    NoTsumoLeft,
}

/// Top-level memo key: the exact inputs libriichi's observation encoder uses.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct SolverKey {
    init_state: InitState,
    calculator: SPCalculator,
    can_discard: bool,
    tsumos_left: u8,
    cur_shanten: i8,
}

thread_local! {
    /// The web app can encode the same position more than once (AI panel,
    /// re-render, report export). A deep 3-shanten solver run costs tens of
    /// milliseconds, so keep a small bounded cache keyed by the solver inputs.
    static SOLVER_CACHE: std::cell::RefCell<HashMap<SolverKey, Result<Vec<Candidate>, SolverError>>>
        = std::cell::RefCell::new(HashMap::new());
}

const SOLVER_CACHE_CAPACITY: usize = 32;

/// [`SPCalculator::calc`] with a bounded thread-local memo.
pub fn solve_cached(
    init_state: InitState,
    calculator: SPCalculator,
    can_discard: bool,
    tsumos_left: u8,
    cur_shanten: i8,
) -> Result<Vec<Candidate>, SolverError> {
    let key = SolverKey {
        init_state: init_state.clone(),
        calculator: calculator.clone(),
        can_discard,
        tsumos_left,
        cur_shanten,
    };
    if let Some(cached) = SOLVER_CACHE.with(|cache| cache.borrow().get(&key).cloned()) {
        return cached;
    }
    let result = calculator.calc(init_state, can_discard, tsumos_left, cur_shanten);
    SOLVER_CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        if cache.len() >= SOLVER_CACHE_CAPACITY {
            cache.clear();
        }
        cache.insert(key, result.clone());
    });
    result
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct State {
    tehai: [u8; 34],
    akas_in_hand: [bool; 3],
    tiles_in_wall: [u8; 34],
    akas_in_wall: [bool; 3],
    n_extra_tsumo: u8,
}

impl From<InitState> for State {
    fn from(init: InitState) -> Self {
        let mut tiles_in_wall = init.tiles_seen;
        for count in &mut tiles_in_wall {
            *count = 4u8.saturating_sub(*count);
        }
        let mut akas_in_wall = init.akas_seen;
        for seen in &mut akas_in_wall {
            *seen = !*seen;
        }
        Self {
            tehai: init.tehai,
            akas_in_hand: init.akas_in_hand,
            tiles_in_wall,
            akas_in_wall,
            n_extra_tsumo: 0,
        }
    }
}

impl State {
    fn discard(&mut self, tile: usize) {
        self.tehai[deaka(tile)] -= 1;
        if let Some(suit) = aka_suit(tile) {
            self.akas_in_hand[suit] = false;
        }
    }

    fn undo_discard(&mut self, tile: usize) {
        self.tehai[deaka(tile)] += 1;
        if let Some(suit) = aka_suit(tile) {
            self.akas_in_hand[suit] = true;
        }
    }

    fn deal(&mut self, tile: usize) {
        self.tiles_in_wall[deaka(tile)] -= 1;
        if let Some(suit) = aka_suit(tile) {
            self.akas_in_wall[suit] = false;
        }
        self.undo_discard(tile);
    }

    fn undo_deal(&mut self, tile: usize) {
        self.discard(tile);
        self.tiles_in_wall[deaka(tile)] += 1;
        if let Some(suit) = aka_suit(tile) {
            self.akas_in_wall[suit] = true;
        }
    }

    fn get_discard_tiles(
        &self,
        shanten: i8,
        len_div3: u8,
        cache: &mut HashMap<[u8; 34], i8>,
    ) -> Vec<(usize, i8)> {
        let mut out = Vec::with_capacity(14);
        let mut tehai = self.tehai;
        for tid in 0..34 {
            if tehai[tid] == 0 {
                continue;
            }
            tehai[tid] -= 1;
            let shanten_after = cached_shanten(cache, &tehai, len_div3);
            tehai[tid] += 1;

            let tile = match tid {
                4 if self.akas_in_hand[0] && tehai[tid] == 1 => 34,
                13 if self.akas_in_hand[1] && tehai[tid] == 1 => 35,
                22 if self.akas_in_hand[2] && tehai[tid] == 1 => 36,
                _ => tid,
            };
            out.push((tile, shanten_after - shanten));
        }
        out
    }

    fn get_draw_tiles(
        &self,
        shanten: i8,
        len_div3: u8,
        cache: &mut HashMap<[u8; 34], i8>,
    ) -> Vec<(usize, u8, i8)> {
        let mut out = Vec::with_capacity(37);
        let mut tehai = self.tehai;
        for (tid, &count) in self.tiles_in_wall.iter().enumerate() {
            if count == 0 {
                continue;
            }
            tehai[tid] += 1;
            let shanten_after = cached_shanten(cache, &tehai, len_div3);
            tehai[tid] -= 1;
            let diff = shanten_after - shanten;

            let aka = match tid {
                4 => self.akas_in_wall[0],
                13 => self.akas_in_wall[1],
                22 => self.akas_in_wall[2],
                _ => false,
            };
            if aka {
                if count >= 2 {
                    out.push((tid, count - 1, diff));
                }
                out.push((34 + (tid / 9), 1, diff));
            } else {
                out.push((tid, count, diff));
            }
        }
        out
    }

    fn get_required_tiles(
        &self,
        len_div3: u8,
        cache: &mut HashMap<[u8; 34], i8>,
    ) -> Vec<RequiredTile> {
        let mut tehai = self.tehai;
        let shanten = cached_shanten(cache, &tehai, len_div3);
        let mut out = Vec::with_capacity(34);
        for (tid, &count) in self.tiles_in_wall.iter().enumerate() {
            if count == 0 {
                continue;
            }
            tehai[tid] += 1;
            let shanten_after = cached_shanten(cache, &tehai, len_div3);
            tehai[tid] -= 1;
            if shanten_after < shanten {
                out.push(RequiredTile { tile: tid, count });
            }
        }
        out
    }

    fn sum_left_tiles(&self) -> u8 {
        self.tiles_in_wall
            .iter()
            .fold(0u8, |a, &b| a.saturating_add(b))
    }
}

#[derive(Debug, Clone, Default)]
struct Values {
    tenpai_probs: [f32; MAX_TSUMOS_LEFT],
    win_probs: [f32; MAX_TSUMOS_LEFT],
    exp_values: [f32; MAX_TSUMOS_LEFT],
}

enum ScoresOrValues {
    Scores([f32; 4]),
    Values(Rc<Values>),
}

struct SPCalculatorState<'a> {
    sup: &'a SPCalculator,
    state: State,
    max_tsumo: usize,
    tsumo_prob_table: Vec<[f32; MAX_TSUMOS_LEFT]>,
    not_tsumo_prob_table: Vec<[f32; MAX_TSUMOS_LEFT]>,
    discard_cache: [HashMap<State, Rc<Values>>; SHANTEN_THRES as usize + 1],
    draw_cache: [HashMap<State, Rc<Values>>; SHANTEN_THRES as usize + 1],
    shanten_cache: HashMap<[u8; 34], i8>,
}

impl SPCalculator {
    /// Run the solver. `can_discard` is false for reaction decisions.
    pub fn calc(
        &self,
        init_state: InitState,
        can_discard: bool,
        tsumos_left: u8,
        cur_shanten: i8,
    ) -> Result<Vec<Candidate>, SolverError> {
        if cur_shanten < 0 {
            return Err(SolverError::AlreadyAgari);
        }
        if tsumos_left < 1 {
            return Err(SolverError::NoTsumoLeft);
        }
        if tsumos_left as usize > MAX_TSUMOS_LEFT {
            return Err(SolverError::NoTsumoLeft);
        }

        let state = State::from(init_state);
        let n_left_tiles = state.sum_left_tiles() as usize;
        let max_tsumo = tsumos_left as usize;
        let tsumo_prob_table = build_tsumo_prob_table(n_left_tiles, max_tsumo);
        let not_tsumo_prob_table = build_not_tsumo_prob_table(n_left_tiles, max_tsumo);
        let mut calc_state = SPCalculatorState {
            sup: self,
            state,
            max_tsumo,
            tsumo_prob_table,
            not_tsumo_prob_table,
            discard_cache: Default::default(),
            draw_cache: Default::default(),
            shanten_cache: HashMap::new(),
        };
        Ok(calc_state.calc(can_discard, cur_shanten))
    }
}

fn build_tsumo_prob_table(n_left_tiles: usize, max_tsumo: usize) -> Vec<[f32; MAX_TSUMOS_LEFT]> {
    let mut table = vec![[0.0; MAX_TSUMOS_LEFT]; 4];
    for (i, row) in table.iter_mut().enumerate() {
        for (j, value) in row.iter_mut().take(max_tsumo).enumerate() {
            *value = (i + 1) as f32 / (n_left_tiles.saturating_sub(j)) as f32;
        }
    }
    table
}

fn build_not_tsumo_prob_table(
    n_left_tiles: usize,
    max_tsumo: usize,
) -> Vec<[f32; MAX_TSUMOS_LEFT]> {
    let rows = (MAX_TILES_LEFT + 1).max(n_left_tiles + 1);
    let mut table = vec![[0.0; MAX_TSUMOS_LEFT]; rows];
    for (i, row) in table.iter_mut().enumerate().take(n_left_tiles + 1) {
        row[0] = 1.0;
        for j in 0..(max_tsumo - 1).min(n_left_tiles - i) {
            row[j + 1] = row[j] * (n_left_tiles - i - j) as f32 / (n_left_tiles - j) as f32;
        }
    }
    table
}

impl SPCalculatorState<'_> {
    fn calc(&mut self, can_discard: bool, cur_shanten: i8) -> Vec<Candidate> {
        if cur_shanten <= SHANTEN_THRES {
            let mut candidates = if can_discard {
                self.analyze_discard(cur_shanten)
            } else {
                self.analyze_draw(cur_shanten)
            };
            if self.sup.sort_result && !candidates.is_empty() {
                let by = if self.sup.maximize_win_prob {
                    CandidateColumn::WinProb
                } else {
                    CandidateColumn::Ev
                };
                candidates.sort_by(|l, r| r.cmp(l, by));
            }
            candidates
        } else {
            let mut candidates = if can_discard {
                self.analyze_discard_simple(cur_shanten)
            } else {
                self.analyze_draw_simple()
            };
            if self.sup.sort_result && !candidates.is_empty() {
                candidates.sort_by(|l, r| r.cmp(l, CandidateColumn::NotShantenDown));
            }
            candidates
        }
    }

    fn analyze_discard(&mut self, shanten: i8) -> Vec<Candidate> {
        let discard_tiles =
            self.state
                .get_discard_tiles(shanten, self.sup.tehai_len_div3, &mut self.shanten_cache);
        let mut candidates = Vec::with_capacity(discard_tiles.len());

        for (tile, shanten_diff) in discard_tiles {
            if shanten_diff == 0 {
                self.state.discard(tile);
                let required_tiles = self
                    .state
                    .get_required_tiles(self.sup.tehai_len_div3, &mut self.shanten_cache);
                let values = self.draw(shanten);
                self.state.undo_discard(tile);

                let mut tenpai_probs = values.tenpai_probs;
                if shanten == 0 {
                    tenpai_probs[..self.max_tsumo].fill(1.0);
                }
                candidates.push(make_candidate(
                    tile,
                    &tenpai_probs[..self.max_tsumo],
                    &values.win_probs[..self.max_tsumo],
                    &values.exp_values[..self.max_tsumo],
                    required_tiles,
                    false,
                ));
            } else if self.sup.calc_shanten_down && shanten_diff == 1 && shanten < SHANTEN_THRES {
                self.state.discard(tile);
                let required_tiles = self
                    .state
                    .get_required_tiles(self.sup.tehai_len_div3, &mut self.shanten_cache);
                self.state.n_extra_tsumo += 1;
                let values = self.draw(shanten + 1);
                self.state.n_extra_tsumo -= 1;
                self.state.undo_discard(tile);

                candidates.push(make_candidate(
                    tile,
                    &values.tenpai_probs[..self.max_tsumo],
                    &values.win_probs[..self.max_tsumo],
                    &values.exp_values[..self.max_tsumo],
                    required_tiles,
                    true,
                ));
            }
        }
        candidates
    }

    fn analyze_draw(&mut self, shanten: i8) -> Vec<Candidate> {
        let required_tiles = self
            .state
            .get_required_tiles(self.sup.tehai_len_div3, &mut self.shanten_cache);
        let values = self.draw(shanten);
        let mut tenpai_probs = values.tenpai_probs;
        if shanten == 0 {
            tenpai_probs[..self.max_tsumo].fill(1.0);
        }
        vec![make_candidate(
            37,
            &tenpai_probs[..self.max_tsumo],
            &values.win_probs[..self.max_tsumo],
            &values.exp_values[..self.max_tsumo],
            required_tiles,
            false,
        )]
    }

    fn analyze_discard_simple(&mut self, shanten: i8) -> Vec<Candidate> {
        let discard_tiles =
            self.state
                .get_discard_tiles(shanten, self.sup.tehai_len_div3, &mut self.shanten_cache);
        discard_tiles
            .into_iter()
            .map(|(tile, shanten_diff)| {
                self.state.discard(tile);
                let required_tiles = self
                    .state
                    .get_required_tiles(self.sup.tehai_len_div3, &mut self.shanten_cache);
                self.state.undo_discard(tile);
                make_candidate(tile, &[], &[], &[], required_tiles, shanten_diff == 1)
            })
            .collect()
    }

    fn analyze_draw_simple(&mut self) -> Vec<Candidate> {
        let required_tiles = self
            .state
            .get_required_tiles(self.sup.tehai_len_div3, &mut self.shanten_cache);
        vec![make_candidate(37, &[], &[], &[], required_tiles, false)]
    }

    fn draw(&mut self, shanten: i8) -> Rc<Values> {
        if let Some(values) = self.draw_cache[shanten as usize].get(&self.state) {
            return Rc::clone(values);
        }
        self.draw_without_tegawari_slow(shanten)
    }

    fn draw_without_tegawari_slow(&mut self, shanten: i8) -> Rc<Values> {
        let mut tenpai_probs = [0.0; MAX_TSUMOS_LEFT];
        let mut win_probs = [0.0; MAX_TSUMOS_LEFT];
        let mut exp_values = [0.0; MAX_TSUMOS_LEFT];

        let draw_tiles =
            self.state
                .get_draw_tiles(shanten, self.sup.tehai_len_div3, &mut self.shanten_cache);
        let sum_required_tiles: u8 = draw_tiles
            .iter()
            .filter(|(_, _, diff)| *diff == -1)
            .map(|(_, count, _)| *count)
            .fold(0u8, u8::saturating_add);
        let not_tsumo_probs = self.not_tsumo_prob_table[sum_required_tiles as usize];

        for &(tile, count, shanten_diff) in &draw_tiles {
            if shanten_diff != -1 {
                continue;
            }

            self.state.deal(tile);
            let scores_or_values = if shanten > 0 {
                Some(ScoresOrValues::Values(self.discard(shanten - 1)))
            } else {
                self.get_score(tile).map(ScoresOrValues::Scores)
            };
            self.state.undo_deal(tile);

            let Some(scores_or_values) = scores_or_values else {
                continue;
            };

            let tsumo_probs = self.tsumo_prob_table[count as usize - 1];
            for i in 0..self.max_tsumo {
                let m = not_tsumo_probs[i];
                if m == 0.0 {
                    break;
                }
                for j in i..self.max_tsumo {
                    let n = not_tsumo_probs[j];
                    if n == 0.0 {
                        break;
                    }
                    let prob = tsumo_probs[j] * n / m;

                    match &scores_or_values {
                        ScoresOrValues::Scores(scores) => {
                            let assume_riichi = self.sup.is_menzen && self.sup.prefer_riichi;
                            let win_double_riichi =
                                assume_riichi && self.sup.calc_double_riichi && i == 0;
                            let win_ippatsu = assume_riichi && j == i;
                            let win_haitei = self.sup.calc_haitei && j == self.max_tsumo - 1;
                            let han_plus = win_double_riichi as usize
                                + win_ippatsu as usize
                                + win_haitei as usize;
                            win_probs[i] += prob;
                            exp_values[i] += prob * scores[han_plus];
                        }
                        ScoresOrValues::Values(next_values) => {
                            if shanten == 1 {
                                tenpai_probs[i] += prob;
                            }
                            if j < self.max_tsumo - 1 {
                                if shanten > 1 {
                                    tenpai_probs[i] += prob * next_values.tenpai_probs[j + 1];
                                }
                                win_probs[i] += prob * next_values.win_probs[j + 1];
                                exp_values[i] += prob * next_values.exp_values[j + 1];
                            }
                        }
                    }
                }
            }
        }

        let values = Rc::new(Values {
            tenpai_probs,
            win_probs,
            exp_values,
        });
        self.draw_cache[shanten as usize].insert(self.state.clone(), Rc::clone(&values));
        values
    }

    fn discard(&mut self, shanten: i8) -> Rc<Values> {
        if let Some(values) = self.discard_cache[shanten as usize].get(&self.state) {
            return Rc::clone(values);
        }
        self.discard_slow(shanten)
    }

    fn discard_slow(&mut self, shanten: i8) -> Rc<Values> {
        let discard_tiles =
            self.state
                .get_discard_tiles(shanten, self.sup.tehai_len_div3, &mut self.shanten_cache);

        let mut max_tenpai_probs = [f32::MIN; MAX_TSUMOS_LEFT];
        let mut max_win_probs = [f32::MIN; MAX_TSUMOS_LEFT];
        let mut max_exp_values = [f32::MIN; MAX_TSUMOS_LEFT];
        let mut max_tiles = [37usize; MAX_TSUMOS_LEFT];
        let mut max_values = [i32::MIN; MAX_TSUMOS_LEFT];

        for (tile, shanten_diff) in discard_tiles {
            let values = if shanten_diff == 0 {
                self.state.discard(tile);
                let values = self.draw(shanten);
                self.state.undo_discard(tile);
                values
            } else if self.sup.calc_shanten_down
                && self.state.n_extra_tsumo == 0
                && shanten_diff == 1
                && shanten < SHANTEN_THRES
            {
                self.state.discard(tile);
                self.state.n_extra_tsumo += 1;
                let values = self.draw(shanten + 1);
                self.state.n_extra_tsumo -= 1;
                self.state.undo_discard(tile);
                values
            } else {
                continue;
            };

            for i in 0..self.max_tsumo {
                let value = if self.sup.maximize_win_prob {
                    values.win_probs[i] * 1e5
                } else {
                    values.exp_values[i]
                } as i32;
                let max_value = max_values[i];
                let max_tile = max_tiles[i];

                if value > max_value
                    || value == max_value && cmp_discard_priority(tile, max_tile).is_gt()
                {
                    max_tenpai_probs[i] = values.tenpai_probs[i];
                    max_win_probs[i] = values.win_probs[i];
                    max_exp_values[i] = values.exp_values[i];
                    max_values[i] = value;
                    max_tiles[i] = tile;
                }
            }
        }

        let values = Rc::new(Values {
            tenpai_probs: max_tenpai_probs,
            win_probs: max_win_probs,
            exp_values: max_exp_values,
        });
        self.discard_cache[shanten as usize].insert(self.state.clone(), Rc::clone(&values));
        values
    }

    /// Port of `SPCalculator::get_score`. `None` means the hand has no yaku.
    fn get_score(&self, win_tile: usize) -> Option<[f32; 4]> {
        let hand_counts = array_to_tilecounts(&self.state.tehai);
        let melds = self.make_melds();
        let structures = if melds.is_empty() {
            decompose_hand(&hand_counts)
        } else {
            decompose_hand_with_melds(&hand_counts, &melds)
        };
        if structures.is_empty() {
            return None;
        }

        let is_open =
            !self.sup.chis.is_empty() || !self.sup.pons.is_empty() || !self.sup.minkans.is_empty();
        let context = GameContext::new(
            WinType::Tsumo,
            honor_from_index(self.sup.bakaze),
            honor_from_index(self.sup.jikaze),
        )
        .with_winning_tile(index_to_tile(deaka(win_tile)));
        let context = if is_open { context.open() } else { context };

        let full_counts = full_counts_with_melds(&hand_counts, &melds);
        let num_doras = self.num_doras();

        let mut best: Option<(u8, u8, bool)> = None;
        for structure in &structures {
            let yaku = detect_yaku_with_context(structure, &full_counts, &context);
            if yaku.yaku_list.is_empty() && !yaku.is_yakuman {
                continue;
            }
            let fu = if yaku.is_yakuman {
                0
            } else {
                calculate_fu(structure, &context).total
            };
            let han = if yaku.is_yakuman {
                yaku.total_han
            } else {
                yaku.total_han
                    .saturating_add(num_doras)
                    .saturating_add(self.sup.prefer_riichi as u8)
            };
            // libriichi's `search_yakus` picks the maximum by han, then fu.
            let replace = match best {
                None => true,
                Some((best_han, best_fu, _)) => (han, fu) > (best_han, best_fu),
            };
            if replace {
                best = Some((han, fu, yaku.is_yakuman));
            }
        }

        let (base_han, fu, is_yakuman) = best?;
        let is_oya = self.sup.jikaze == 0;
        let mut scores = [0.0; 4];
        let assume_riichi = self.sup.is_menzen && self.sup.prefer_riichi;

        if assume_riichi && self.sup.dora_indicators.len() == 1 {
            let mut n_indicators = [0u8; 5];
            let mut sum_indicators = 0u16;
            for (tid, &count) in self.state.tehai.iter().enumerate() {
                if count == 0 {
                    continue;
                }
                let prev = prev_tile(tid);
                let ind_count = self.state.tiles_in_wall[prev] as u16;
                n_indicators[count as usize] =
                    n_indicators[count as usize].saturating_add(ind_count as u8);
                sum_indicators += ind_count;
            }
            let n_left_tiles = self.state.sum_left_tiles() as u16;
            if n_left_tiles > 0 {
                let mut uradora_probs = [0.0f32; 5];
                uradora_probs[0] =
                    (n_left_tiles.saturating_sub(sum_indicators)) as f32 / n_left_tiles as f32;
                for i in 1..5 {
                    uradora_probs[i] = n_indicators[i] as f32 / n_left_tiles as f32;
                }
                for (i, score) in scores.iter_mut().enumerate() {
                    for (j, &prob) in uradora_probs.iter().enumerate() {
                        if prob == 0.0 {
                            continue;
                        }
                        let han = base_han as usize + i + j;
                        *score += tsumo_total(han, fu, is_yakuman, is_oya) * prob;
                    }
                }
            }
        } else if assume_riichi && self.sup.dora_indicators.len() > 1 {
            let row = &URADORA_PROB_TABLE[self.sup.dora_indicators.len() - 1];
            for (i, score) in scores.iter_mut().enumerate() {
                for (j, &prob) in row.iter().enumerate() {
                    if prob == 0.0 {
                        continue;
                    }
                    let han = base_han as usize + i + j;
                    *score += tsumo_total(han, fu, is_yakuman, is_oya) * prob;
                }
            }
        } else {
            for (i, score) in scores.iter_mut().enumerate() {
                *score = tsumo_total(base_han as usize + i, fu, is_yakuman, is_oya);
            }
        }

        Some(scores)
    }

    fn make_melds(&self) -> Vec<Meld> {
        let mut melds = Vec::new();
        for &tile in &self.sup.chis {
            melds.push(Meld::shuntsu_open(index_to_tile(tile as usize)));
        }
        for &tile in &self.sup.pons {
            melds.push(Meld::koutsu_open(index_to_tile(tile as usize)));
        }
        for &tile in &self.sup.minkans {
            melds.push(Meld::kan(index_to_tile(tile as usize), KanType::Open));
        }
        for &tile in &self.sup.ankans {
            melds.push(Meld::kan(index_to_tile(tile as usize), KanType::Closed));
        }
        melds
    }

    fn num_doras(&self) -> u8 {
        let mut total = 0u8;
        for &indicator in &self.sup.dora_indicators {
            let dora = next_tile(indicator as usize);
            total = total.saturating_add(self.state.tehai[dora]);
        }
        total = total.saturating_add(self.state.akas_in_hand.iter().filter(|&&b| b).count() as u8);
        total.saturating_add(self.sup.num_doras_in_fuuro)
    }
}

fn make_candidate(
    tile: usize,
    tenpai_probs: &[f32],
    win_probs: &[f32],
    exp_values: &[f32],
    required_tiles: Vec<RequiredTile>,
    shanten_down: bool,
) -> Candidate {
    let num_required_tiles = required_tiles
        .iter()
        .map(|r| r.count)
        .fold(0u8, u8::saturating_add);
    Candidate {
        tile,
        tenpai_probs: tenpai_probs.iter().map(|p| p.clamp(0.0, 1.0)).collect(),
        win_probs: win_probs.iter().map(|p| p.clamp(0.0, 1.0)).collect(),
        exp_values: exp_values.iter().map(|v| v.max(0.0)).collect(),
        required_tiles,
        num_required_tiles,
        shanten_down,
    }
}

fn tsumo_total(han: usize, fu: u8, is_yakuman: bool, is_oya: bool) -> f32 {
    let han = han.min(u8::MAX as usize) as u8;
    let basic = calculate_basic_points(han, fu, is_yakuman);
    calculate_payment(basic, is_oya, WinType::Tsumo).total as f32
}

fn honor_from_index(index: u8) -> Honor {
    match index {
        0 => Honor::East,
        1 => Honor::South,
        2 => Honor::West,
        3 => Honor::North,
        _ => Honor::East,
    }
}

fn full_counts_with_melds(hand: &TileCounts, melds: &[Meld]) -> TileCounts {
    let mut counts = hand.clone();
    for meld in melds {
        match meld {
            Meld::Shuntsu(start, _) => {
                let base = tile_to_index(*start);
                for index in base..base + 3 {
                    *counts.entry(index_to_tile(index)).or_insert(0) += 1;
                }
            }
            Meld::Koutsu(tile, _) => {
                *counts.entry(*tile).or_insert(0) += 3;
            }
            Meld::Kan(tile, _) => {
                *counts.entry(*tile).or_insert(0) += 4;
            }
        }
    }
    counts
}

/// The tile that makes `tile` dora when used as an indicator (inverse of
/// `next_tile`).
pub fn prev_tile(index: usize) -> usize {
    match index {
        0..=26 => {
            let base = index - index % 9;
            base + (index % 9 + 8) % 9
        }
        27..=30 => 27 + (index - 27 + 3) % 4,
        _ => 31 + (index - 31 + 2) % 3,
    }
}

/// The dora that an indicator in `index` makes.
pub fn next_tile(index: usize) -> usize {
    match index {
        0..=26 => {
            let base = index - index % 9;
            base + (index % 9 + 1) % 9
        }
        27..=30 => 27 + (index - 27 + 1) % 4,
        _ => 31 + (index - 31 + 1) % 3,
    }
}

// --- Shanten, ported from `agari::shanten` to avoid per-call HashMaps ------

fn cached_shanten(cache: &mut HashMap<[u8; 34], i8>, hand: &[u8; 34], len_div3: u8) -> i8 {
    if let Some(&value) = cache.get(hand) {
        return value;
    }
    let value = calc_all(hand, len_div3);
    cache.insert(*hand, value);
    value
}

/// Equivalent of `agari::shanten::calculate_shanten_with_melds(...).shanten`.
pub fn calc_all(tiles: &[u8; 34], len_div3: u8) -> i8 {
    let called_melds = 4u8.saturating_sub(len_div3);
    let standard = standard_shanten(tiles, called_melds);
    if standard <= 0 || called_melds > 0 {
        return standard;
    }
    standard
        .min(chiitoitsu_shanten(tiles))
        .min(kokushi_shanten(tiles))
}

fn standard_shanten(tiles: &[u8; 34], called_melds: u8) -> i8 {
    let total_hand_tiles: u8 = tiles.iter().fold(0u8, |a, &b| a.saturating_add(b));
    let min_tenpai_tiles = if called_melds >= 4 {
        1
    } else {
        13u8.saturating_sub(3 * called_melds)
    };
    let tile_deficit = min_tenpai_tiles.saturating_sub(total_hand_tiles);

    let mut best = 8i8;
    let (melds, taatsu) = count_melds_and_taatsu(tiles);
    best = best.min(shanten_value(
        melds,
        taatsu,
        false,
        called_melds,
        tile_deficit,
    ));

    for i in 0..34 {
        if tiles[i] >= 2 {
            let mut copy = *tiles;
            copy[i] -= 2;
            let (melds, taatsu) = count_melds_and_taatsu(&copy);
            best = best.min(shanten_value(
                melds,
                taatsu,
                true,
                called_melds,
                tile_deficit,
            ));
        }
    }
    best
}

fn chiitoitsu_shanten(tiles: &[u8; 34]) -> i8 {
    let mut pairs = 0i8;
    let mut unique = 0i8;
    for &count in tiles {
        if count >= 1 {
            unique += 1;
        }
        if count >= 2 {
            pairs += 1;
        }
    }
    6 - pairs + (7 - unique).max(0)
}

fn kokushi_shanten(tiles: &[u8; 34]) -> i8 {
    const KOKUSHI: [usize; 13] = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33];
    let mut unique = 0i8;
    let mut has_pair = false;
    for &index in &KOKUSHI {
        if tiles[index] >= 1 {
            unique += 1;
        }
        if tiles[index] >= 2 {
            has_pair = true;
        }
    }
    13 - unique - has_pair as i8
}

fn count_melds_and_taatsu(tiles: &[u8; 34]) -> (u8, u8) {
    let mut tiles = *tiles;
    let mut melds = 0u8;
    let mut taatsu = 0u8;

    for suit_start in [0, 9, 18] {
        let (suit_melds, suit_taatsu) = count_suit_melds(&mut tiles, suit_start);
        melds = melds.saturating_add(suit_melds);
        taatsu = taatsu.saturating_add(suit_taatsu);
    }

    for count in tiles.iter_mut().skip(27) {
        if *count >= 3 {
            melds += 1;
            *count -= 3;
        }
        if *count >= 2 {
            taatsu += 1;
            *count -= 2;
        }
    }
    (melds, taatsu)
}

fn count_suit_melds(tiles: &mut [u8; 34], start: usize) -> (u8, u8) {
    let mut suit = [0u8; 9];
    suit.copy_from_slice(&tiles[start..start + 9]);

    let max_melds = find_max_melds(&mut suit, 0);
    let mut best_taatsu = 0u8;
    find_best_taatsu_after_melds(&mut suit, 0, 0, max_melds, &mut best_taatsu);

    tiles[start..start + 9].fill(0);
    (max_melds, best_taatsu)
}

fn find_max_melds(suit: &mut [u8; 9], pos: usize) -> u8 {
    let mut p = pos;
    while p < 9 && suit[p] == 0 {
        p += 1;
    }
    if p >= 9 {
        return 0;
    }
    let mut best = 0u8;
    if suit[p] >= 3 {
        suit[p] -= 3;
        best = best.max(1 + find_max_melds(suit, p));
        suit[p] += 3;
    }
    if p + 2 < 9 && suit[p] >= 1 && suit[p + 1] >= 1 && suit[p + 2] >= 1 {
        suit[p] -= 1;
        suit[p + 1] -= 1;
        suit[p + 2] -= 1;
        best = best.max(1 + find_max_melds(suit, p));
        suit[p] += 1;
        suit[p + 1] += 1;
        suit[p + 2] += 1;
    }
    best.max(find_max_melds(suit, p + 1))
}

fn find_best_taatsu_after_melds(
    suit: &mut [u8; 9],
    pos: usize,
    melds_so_far: u8,
    target_melds: u8,
    best_taatsu: &mut u8,
) {
    if melds_so_far == target_melds {
        *best_taatsu = (*best_taatsu).max(count_suit_taatsu(suit));
        return;
    }

    let mut p = pos;
    while p < 9 && suit[p] == 0 {
        p += 1;
    }
    if p >= 9 {
        return;
    }
    let remaining_melds = target_melds - melds_so_far;

    if suit[p] >= 3 {
        suit[p] -= 3;
        find_best_taatsu_after_melds(suit, p, melds_so_far + 1, target_melds, best_taatsu);
        suit[p] += 3;
    }
    if p + 2 < 9 && suit[p] >= 1 && suit[p + 1] >= 1 && suit[p + 2] >= 1 {
        suit[p] -= 1;
        suit[p + 1] -= 1;
        suit[p + 2] -= 1;
        find_best_taatsu_after_melds(suit, p, melds_so_far + 1, target_melds, best_taatsu);
        suit[p] += 1;
        suit[p + 1] += 1;
        suit[p + 2] += 1;
    }
    if remaining_melds == 0 || p + 1 < 9 {
        find_best_taatsu_after_melds(suit, p + 1, melds_so_far, target_melds, best_taatsu);
    }
}

fn count_suit_taatsu(suit: &[u8; 9]) -> u8 {
    let mut suit = *suit;
    count_suit_taatsu_recursive(&mut suit, 0)
}

fn count_suit_taatsu_recursive(suit: &mut [u8; 9], pos: usize) -> u8 {
    let mut p = pos;
    while p < 9 && suit[p] == 0 {
        p += 1;
    }
    if p >= 9 {
        return 0;
    }

    let mut best = 0u8;
    if suit[p] >= 2 {
        suit[p] -= 2;
        best = best.max(1 + count_suit_taatsu_recursive(suit, p));
        suit[p] += 2;
    }
    if p + 1 < 9 && suit[p] >= 1 && suit[p + 1] >= 1 {
        suit[p] -= 1;
        suit[p + 1] -= 1;
        best = best.max(1 + count_suit_taatsu_recursive(suit, p));
        suit[p] += 1;
        suit[p + 1] += 1;
    }
    if p + 2 < 9 && suit[p] >= 1 && suit[p + 2] >= 1 {
        suit[p] -= 1;
        suit[p + 2] -= 1;
        best = best.max(1 + count_suit_taatsu_recursive(suit, p));
        suit[p] += 1;
        suit[p + 2] += 1;
    }
    best.max(count_suit_taatsu_recursive(suit, p + 1))
}

fn shanten_value(melds: u8, taatsu: u8, has_pair: bool, called_melds: u8, tile_deficit: u8) -> i8 {
    let total_melds = melds.saturating_add(called_melds);
    if total_melds >= 4 && has_pair && tile_deficit == 0 {
        return -1;
    }

    let max_useful_taatsu = 4u8.saturating_sub(total_melds);
    let useful_taatsu = taatsu.min(max_useful_taatsu);
    let mut shanten = 8i8 - (2 * total_melds.min(4) as i8) - (useful_taatsu as i8);
    if has_pair {
        shanten -= 1;
    }

    let total_blocks = total_melds.min(4) + useful_taatsu;
    if total_blocks > 4 {
        shanten += (total_blocks - 4) as i8;
    }
    if shanten >= 0 {
        shanten = shanten.max(tile_deficit as i8);
    }
    shanten
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shanten_matches_agari_for_sample_hands() {
        let hands = [
            "123m456p789s11122z",
            "19m19p19s1234567z1m",
            "112233m445566p77s",
            "45678m34789p3344z",
            "3667m23489p34688s",
            "9999m6677p88s335z1m",
        ];
        for hand in hands {
            let tiles = agari::parse::parse_hand(hand).unwrap();
            let counts = agari::parse::to_counts(&tiles);
            let array = agari::shanten::counts_to_array(&counts);
            let expected = agari::shanten::calculate_shanten(&counts).shanten;
            assert_eq!(calc_all(&array, 4), expected, "{hand}");
        }
    }

    #[test]
    fn tile_cycles_round_trip() {
        for index in 0..34 {
            assert_eq!(next_tile(prev_tile(index)), index);
        }
    }
}
