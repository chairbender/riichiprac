# Plan: populate Mortal's EV / required-tile / SP-table observation planes

Handoff document. The Mortal observation encoder currently leaves 122 of
Mortal v4's 1012 channels at zero, including the two planes a strong model uses
to judge riichi-vs-dama and discard quality. This doc describes exactly what is
missing, what the reference implementation writes there, and how to implement
and verify it.

Read alongside `scenario-fuzz-findings.md` §1, which is the symptom that
motivated this work.

## TL;DR

- `src/ai/encoder.rs` writes rows `0..=888` correctly and leaves
  `889..=1011` blank (12% of the observation).
- In libriichi v4 those rows are filled from the **single-player EV solver**
  (`libriichi/src/algo/sp/`, a port of nekobean's mahjong-cpp calculator) which
  is run on every decision at inference time.
- Result today: the model never values Riichi in the chiitoitsu family. 16/16
  app-Riichi cases across two fuzz runs disagreed, with Riichi probability
  median 0.01. The observations the model sees are out of distribution.
- Work splits into three phases of very different cost: the discard-candidate
  sub-rows (cheap, pure shanten), the required-tile plane (medium, ukeire), and
  the SP table + EV (large: the actual solver).

## Scope: exactly which rows are blank

`src/ai/encoder.rs` constants; reference offsets from
`libriichi/src/state/obs_repr.rs` (v4 branch, `encode_obs`):

| Rows | Count | Constant | Meaning | Status |
| --- | --- | --- | --- | --- |
| 874-878 | 5 | `OFF_DISCARD_CANDIDATES` | discard candidates + keep-shanten + next-shanten + unconditional-tenpai + riichi | only rows 874 and 878 written |
| 889-890 | 2 | `OFF_EV` | best EV / 100000, then min(EV, 30000)/30000 | **blank** |
| 891-958 | 68 | `OFF_REQUIRED_TILES` | 2 x 34: per-discard required tiles, split by shanten-down | **blank** |
| 959 | 1 | `OFF_REQUIRED_BEST` | discard with the most required tiles | **blank** |
| 960 | 1 | — | unused padding (`idx += 2` after the best row) | n/a |
| 961-1011 | 51 | `OFF_SP_TABLE` | 3 x 17 turn-indexed tenpai / win / EV tables | **blank** |

`OFF_EV` is not just unimplemented: it is never referenced by the encoder at
all, so it is zero even in cases where libriichi would write a simple fallback
value (see below).

## Reference semantics

Source: `libriichi/src/state/obs_repr.rs` v4 block, lines ~565-700. The
authoritative constants are `MAX_NUM_TURNS = 17` (`obs_repr.rs:16`, "aka the
actual practical `MAX_TSUMOS_LEFT`") and `2 * 34 + 2 + 3 * MAX_NUM_TURNS`.

### 1. EV (rows 889-890)

```rust
self.encode_ev(max_ev);   // max_ev = max_ev_table[0].exp_values[0]
// ev / 100000 clamped to [0, 100000]  -> row 889
// min(ev, 30000) / 30000              -> row 890
```

`max_ev_table` is sorted by EV descending, so `[0]` is the global best.

### 2. Required tiles (rows 891-958) and best (959)

```rust
if cans.can_discard {
    for candidate in &max_ev_table {            // all discard candidates
        let discard_tid = candidate.tile.deaka().as_usize();
        for r in &candidate.required_tiles {
            let required_tid = r.tile.deaka().as_usize();
            if candidate.shanten_down {
                self.arr.assign(self.idx + 34 + discard_tid, required_tid, 1.);
            } else {
                self.arr.assign(self.idx + discard_tid, required_tid, 1.);
            }
        }
    }
    self.idx += 2 * 34;
    let max_required_tiles_tid = max_ev_table.iter()
        .max_by(|l, r| l.cmp(r, CandidateColumn::NotShantenDown))
        .unwrap().tile.deaka().as_usize();
    self.arr.assign(self.idx, max_required_tiles_tid, 1.);
    self.idx += 2;                              // row 960 stays empty
}
```

Notes that are easy to get wrong:

- The first 34 rows are "discards that keep shanten", the second 34 are
  "discards that are shanten-down" (`shanten_down == true`). Both blocks are
  indexed by the **discard** tile id, values are **required (ukeire)** tile ids.
- Everything is `deaka()`d, i.e. red fives collapse onto their base tile.
- `CandidateColumn::NotShantenDown` is not a simple argmax; it is a comparator
  chain (`libriichi/src/algo/sp/candidate.rs:74-105`): prefer
  `!shanten_down`, then more `num_required_tiles`, then higher discard priority
  (`tile.cmp_discard_priority`). Mirror it exactly, or pick a documented
  approximation and note the deviation.

### 3. SP table (rows 961-1011)

```rust
let ev_scale = if max_ev < 1. { 0. } else { 1. / max_ev };
self.encode_sp_table(max_ev_table, cans.can_discard, ev_scale);
```

Layout (`obs_repr.rs:644-693`): three consecutive 17-row blocks, **indexed by
turn offset, not by tile**. Within a block, each candidate writes into its own
tile column:

```
row 961 + t          tenpai_probs[t]        per candidate (t = 0..16)
row 961 + 17 + t     win_probs[t]
row 961 + 34 + t     (exp_values[t] * ev_scale).min(1.)
```

- Candidates only fill turns while `tenpai_probs[t] > 0`
  (`take_while`), so later turns stay zero.
- If the whole table is missing (`shanten >= 4`) or the first candidate's
  `tenpai_probs` is empty/zero, libriichi writes **nothing** and just advances
  the cursor by 51 rows. That is the case our encoder currently always hits.
- For reaction decisions (`can_discard == false`) the tables are filled
  row-wide (`fill`) with the single candidate instead of per tile column.
- `ev_scale` normalizes EV to the best candidate, so the best EV cell is 1.0
  unless every EV is below 1.

### 4. Fallback when the solver refuses to run

`obs_repr.rs:607-623`. If `single_player_tables()` returns `Err`, the encoder
writes the **minimum tsumo agari value** (no uradora) into `OFF_EV`, then skips
`2 * 34 + 2 + 3 * MAX_NUM_TURNS` rows. Solver preconditions that produce this
(`libriichi/src/state/agent_helper.rs:509-530`):

- `tiles_left < 4` (fewer than one more tsumo),
- real-time shanten `< 0` (already a complete hand),
- `tsumos_left < 1`.

Ours must reproduce this fallback rather than crash or leave zeros, because
zeros-vs-fallback is itself a distribution shift.

### 5. Discard-candidate sub-rows (874-878)

Reference `obs_repr.rs:431-479`:

| Row | Content | Rule |
| --- | --- | --- |
| +0 | discard candidates | set for every legal discard, aka collapsed to base tile |
| +1 | keep-shanten discards | `shanten::calc_all(hand - tile) == shanten` |
| +2 | next-shanten discards | `shanten::calc_all(hand - tile) < shanten` |
| +3 | unconditional-tenpai discards | only when `shanten <= 1`; see `discard_candidates_with_unconditional_tenpai` (`agent_helper.rs:88-160`) for the furiten/tsumogiri/riichi edge cases |
| +4 | `fill` all 34 columns when `riichi_declared[0]` | our encoder writes this only when `is_riichi`, same idea |

All of these are pure shanten arithmetic — no solver. This is the cheapest
phase and probably explains part of the discard-tile disagreements
(`scenario-fuzz-findings.md` §2), because the model currently cannot tell which
discards keep tenpai.

## The solver (the expensive part)

Inventory of `libriichi/src/algo/sp/`:

| File | Lines | Role |
| --- | --- | --- |
| `calc.rs` | 1008 | `SPCalculator::calc`: recursive draw/discard EV over the wall, memoized per shanten layer, with `agari` scoring and uradora expectation |
| `state.rs` | 206 | `State` / `InitState`: hand, `tiles_in_wall`, `akas_in_wall`, discard/draw transitions |
| `candidate.rs` | 182 | `Candidate`: `tile`, `tenpai_probs[17]`, `win_probs[17]`, `exp_values[17]`, `required_tiles`, `num_required_tiles`, `shanten_down`, plus the comparators |
| `tile.rs` | 20 | `RequiredTile { tile, count }` |
| `data/uradora_prob_table.txt` | 1 | `[[f32; 13]; 5]` uradora expectation table, `include!`d |

Exactly the flags libriichi uses when building the observation
(`agent_helper.rs:567-583`) — do not invent your own:

```rust
sort_result: true,
maximize_win_prob: false,
calc_tegawari: false,       // no hand-change (tegawari) search
calc_shanten_down: false,   // still reports shanten_down on candidates
```

Other inputs it needs: `tsumos_left = tiles_left / 4`, `calc_haitei =
tiles_left % 4 == 0`, `prefer_riichi = scores[0] >= 1000`, `calc_double_riichi =
can_discard && can_double_riichi`, doras owned outside the hand
(fuuro/ankan), round and seat wind, `is_menzen`, and a `tiles_seen` /
`akas_seen` array built from every player's discards, melds, dora indicators and
own hand.

Availability in our project:

- `agari::shanten::calculate_shanten_with_melds` returns the minimum across
  standard / chiitoitsu / kokushi, i.e. the equivalent of libriichi's
  `shanten::calc_all`, and handles called melds. Good enough for every shanten
  call in the SP solver and for rows 874-878.
- `agari::scoring::{calculate_score, calculate_payment, calculate_fu}` plus
  `agari::context::GameContext` cover the win-value side, so libriichi's
  `AgariCalculator` does **not** need porting.
- `agari::shanten::calculate_ukeire_with_visible*` already accounts for visible
  tiles, which is what the required-tile planes need.
- libriichi's solver uses `ahash`, `anyhow`, `tinyvec`, `Rc` and recursion. The
  wasm build has no threads; the solver itself is single-threaded, but
  `AHashMap`/`tinyvec` would become new dependencies. Prefer `std::collections`
  and fixed arrays to keep the wasm dependency surface unchanged.

## Suggested phasing

Phase A — discard-candidate sub-rows (rows 875-877). No solver. Deliverable:
`encode_decision_features` fills keep-shanten / next-shanten /
unconditional-tenpai from `agari` shanten calls. Add the shared "shanten of
`hand - tile`" helper once and reuse it in phase B.

Phase B — required tiles (891-959). Per legal discard compute
`shanten_down` (shanten rises without the tile) and `required_tiles`
(ukeire restricted to unseen copies), then write the two 34-row blocks and the
best-discard row using the `NotShantenDown` comparator chain. No EV solver
needed for this phase's `required_tiles`; but `OFF_REQUIRED_BEST` and the EV
rows are still blank until phase C, which means the plane is half-consistent —
acceptable for testing, not for a release.

Phase C — EV and SP table (889-890, 961-1011). Port the solver, or implement a
reduced one. Reduced option that keeps the semantics: same recursion over
`tiles_in_wall` with memoization by hand+wall state, same `Candidate` fields,
same uradora expectation table, but skip tegawari (already false) and cap the
turn horizon at the actual `tsumos_left`. Document any deviation from
libriichi explicitly; then verify against the golden oracle below.

## Verification

1. **Golden oracle.** We already have a Mortal checkout at
   `/tmp/opencode/mortal` (remote `https://github.com/Equim-chan/Mortal`,
   commit `0cff2b5`; re-clone if `/tmp` was cleared). `libriichi/src/state/test.rs`
   contains inline mjai event logs plus `PlayerState::from_log`, and
   `validate()` already calls `encode_obs` for every version. Add a throwaway
   binary or `#[test]` there that prints `encode_obs(4, false)` as JSON for a
   fixed log, save the output, and assert our encoder matches it for the same
   position (exact for 0/1 planes, `1e-4` for solver outputs). This is the only
   way to catch subtle indexing mistakes in the 34/17 layouts.
2. **Unit tests.** `src/ai/encoder_test.rs` already asserts individual cells
   (see `waits_furiten_shanten_and_discard_candidates`). Extend it with a
   tenpai hand whose ukeire is known by hand, and assert the two required-tile
   blocks land in the right row and the right tile columns, including a
   shanten-down discard in the 925-958 block.
3. **Fuzz regression metric.** The point of the work is behavioural:
   ```
   cargo run --release --bin fuzz_scenarios -- \
     --scenario chiitoitsu_riichi_vs_dama --iterations 200 --limit 20 \
     --out fuzz-reports/sp-check
   ```
   Baseline today: 0 of 16 app-Riichi cases agree, Riichi probability median
   0.01. Success is app-Riichi cases becoming majority agreements with Riichi
   probability well above 0.5 in the obvious textbook hands. Also re-check
   `ryanmen_protorun` agreements to confirm phase A did not regress the
   discard-tile decisions.

## Acceptance criteria

- Encoder writes every row `889..=1011` for the `can_discard` path, and the
  documented fallback (min tsumo agari EV + zeroed solver rows) when the solver
  preconditions fail — no panics, no silently blank planes.
- Golden-oracle diff clean for at least three positions (self-turn, reaction
  decision, and a shanten >= 4 hand that hits the fallback).
- `cargo test` green, `cargo clippy --bins` clean, and
  `cargo check --target wasm32-unknown-unknown` still passes (`scenario-fuzz-plan.md`
  gates the same pair).
- Fuzz baseline in the command above improves substantially; document the new
  numbers in `scenario-fuzz-findings.md`.

## Risks

- **Cost.** Mortal's own agent comments that feature encoding "can be very
  CPU-intensive, especially for the sp feature (since v4)"
  (`libriichi/src/agent/mortal.rs:260`), and runs it on a worker thread per
  decision. The browser app has no threads. Measure `encode_v4_observation`
  before and after; if a single state exceeds a few tens of milliseconds,
  consider memoizing by (hand, wall, melds) or making the solver opt-in behind
  a feature flag with a cheaper approximation as the default.
- **Fidelity trap.** Half-populated planes may be worse than none. Land phases
  A+B+C behind one change, or gate the new rows off until C is done.
- **Unrelated small bug worth fixing in the same PR.** `self_turn_actions`
  (`src/ai/actions.rs:162-171`) marks both `Discard_5s` and `Discard_5sr` legal
  when the only 5s in hand is the red one. libriichi explicitly does not
  (`agent_helper.rs:65-68`: `ret[tuz!(5m)] = self.tehai[tuz!(5m)] > 1`), so this
  is a genuine deviation from the reference. It splits about 19% of the
  probability mass onto an impossible action.

## Reference material

- `/tmp/opencode/mortal/libriichi/src/state/obs_repr.rs` — v4 observation
  layout, rows 564-700.
- `/tmp/opencode/mortal/libriichi/src/state/agent_helper.rs` — discard
  candidates (24-160), `single_player_tables` (509-600), aka suppression
  (65-68).
- `/tmp/opencode/mortal/libriichi/src/algo/sp/` — the solver and its data.
- `/tmp/opencode/mortal/libriichi/src/agent/mortal.rs` — how the production
  agent feeds the observation.
- `scenario-fuzz-plan.md` — runner contract, gates, comparison rules.
- `scenario-fuzz-findings.md` — the observed symptoms and the other open items.
