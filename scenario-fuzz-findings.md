# Scenario fuzz findings — 2026-11-10

Review of the first two `fuzz_scenarios` runs against
`frontend/public/models/mortal_298k.safetensors`, plus the code paths that
explain the disagreements. The runner design and comparison rules live in
`scenario-fuzz-plan.md`; this file is the human analysis of what it found.

## Run log

| Run | Command | Result |
| --- | --- | --- |
| 1 | `fuzz_scenarios --iterations 100000` (before `d6165a7`) | 50 iterations, 13 generator failures, 20 files |
| 2 | `fuzz_scenarios --iterations 100000 --out fuzz-reports/run-2` | 46 iterations, 0 generator failures, 20 files |
| 3 | `fuzz_scenarios --iterations 100000 --min-margin 0.05 --out fuzz-reports/run-3` | 62 iterations, 41 agreements, 20 files, 1 below margin |
| 4 | `fuzz_scenarios --iterations 100000 --out fuzz-reports/run-4` (after the SP planes merged in `b458a71`) | 56 iterations, 36 agreements, 20 files |

Run 1 wasted 26% of its budget on `ai_best_action`, which `generate_puzzle`
always rejects because it needs the loaded model. `d6165a7` dropped it from the
default set and made `--scenario ai_best_action` a bad-argument error, so run 2
evaluated a real state on every iteration.

Runs 1-4 stopped on the default `--limit 20`, so their file counts are not
agreement rates. The rates below come from full fixed-budget runs.

## Before and after the SP planes

`e0d5e6d` populated the EV, required-tile and SP-table planes that this file's
original analysis blamed for the Riichi behaviour. `ai::oracle_test::matches_libriichi_v4_observation`
compares the encoder cell-for-cell against `encode_obs(4, false)` from libriichi
and passes, so the planes match the reference implementation.

Full 200-iteration runs (different random states, so the comparison is
statistical):

| Metric | Before (`ff68e3f`) | After (`b458a71`) |
| --- | --- | --- |
| Overall agreements | 26/46 (57%) | 140/200 (70%) |
| `chiitoitsu_riichi_vs_dama` | 1/16 (6%) | 35/78 (45%) |
| `ryanmen_protorun` | 9/13 (69%) | 44/58 (76%) |
| `shouminkan_decision` | 16/17 (94%) | 61/64 (95%) |
| app-**Riichi** cases agreed | **0/10**, p = 0.01-0.15 | **19/36**, p = 0.51-0.99 |
| Mortal's Riichi probability, agreeing cases | n/a (never chose Riichi) | 0.51-0.99 |

The systematic bias is gone: Mortal now picks Riichi with genuine confidence, and
Riichi is a real contender instead of a 1% floor artifact. The remaining
`chiitoitsu` disagreements split in **both** directions, which is the signature
of a heuristic boundary rather than an encoder defect:

| Direction | Files (run after) |
| --- | --- |
| app Riichi vs Mortal discard | 17 |
| app Dama vs Mortal **Riichi** | 15 |
| app Dama vs Mortal different discard | 11 |

The app-Riichi cases Mortal still rejects cluster on the marginal triggers:
`red_five_wait` (7), `dealer+score_below_mangan` (5), `suji_trap` (4),
`wait_outside_456` (2). Those are exactly the cases where the book heuristic
says "riichi for value" and a strong model says "dama keeps the hand alive", so
the remaining work is generator heuristic tuning, not encoding.

## Composition of run 2's 20 disagreements

| Family | Files | Nature |
| --- | --- | --- |
| `chiitoitsu_riichi_vs_dama` | 15 | 10 app=**Riichi** vs Mortal discard, 5 app=Dama-tile vs different tile |
| `ryanmen_protorun` (`tile_efficiency`) | 4 | all off-by-one discard choices |
| `shouminkan_decision` (`kan_decision`) | 1 | app=**Kan** (haku) vs Mortal discard |

## 1. Mortal essentially never likes Riichi in the chiitoitsu family — resolved by the SP planes

This was the dominant finding and it turned out to be a harness fidelity
problem, not 16 independent generator mistakes. `e0d5e6d` fixed it; see
"Before and after the SP planes" above. The rest of this section is the original
evidence, kept for context.

Across runs 1 and 2, 36 states were evaluated and 16 of them had `Riichi` as the
app answer. Mortal disagreed with **every single one**. Its Riichi probability
was:

```
0.01 x6, 0.02, 0.03, 0.04, 0.06 x2, 0.07, 0.08, 0.15, 0.34   (median 0.01)
```

The five files where the app answered *Dama* are just as telling: Mortal's
Riichi share there was still only 1-18%. So the model gives Riichi a
floor-level probability **regardless of which answer the app expects**. The
harness currently cannot discriminate riichi-vs-dama in this family at all, and
those cases will consume the whole 20-file budget on every run.

The board data in those reports is clean, so the states are not malformed:

- scores 22,000-28,000, round East, hand 1-2, no riichi sticks, honba 0,
- 3-4 discards per player, `tiles_remaining` 53/57, which matches live-wall
  arithmetic (70 starting live tiles minus discards minus the drawn tile),
- hand is genuinely chiitoitsu tenpai: 6 pairs plus 2 singles, `shanten` 0,
  `ukeire_total` 3 for the tanki wait.

The likeliest cause is the documented encoder gap in `src/ai/encoder.rs`
(lines 7-11 and the `OFF_DISCARD_CANDIDATES` comment):

- `OFF_REQUIRED_TILES` and the 3x17 tenpai/win/EV `OFF_SP_TABLE` rows are left
  at zero, because filling them needs Mortal's single-player EV solver.
- The per-discard `keep-shanten`, `next-shanten` and `tenpai` rows of
  `OFF_DISCARD_CANDIDATES` are never written; only the candidate row and the
  self-riichi row are.

Those planes are what libriichi populates with shanten/EV analysis, and the
value of declaring riichi depends on exactly that information. Now that they are
populated the bias is gone, so the remaining chiitoitsu disagreements are real
differences of opinion about marginal hands, not a floor artifact.

## 2. Ryanmen disagreements are mostly noise, one is a genuine tie

Margins, app probability vs AI probability:

| App | AI | Margin |
| --- | --- | --- |
| `Discard_6s` 0.21 | `Discard_7s` 0.57 | 36.8 |
| `Discard_8s` 0.34 | `Discard_5s` 0.49 | 15.6 |
| `Discard_8m` 0.37 | `Discard_7m` 0.37 | **0.15** |
| `Discard_6m` 0.00 | `Discard_3s` 0.85 | 85.0 |

`Discard_7m 37.10%` vs `Discard_8m 36.95%` is a statistical tie that the exact
argmax comparison promotes to a report file. `compare_expected_action` applies
no margin by default (per `scenario-fuzz-plan.md` step 5), so this class of
noise is expected; `--min-margin 0.05` filters it and counts the skipped cases
as `below --min-margin`. Only the 0.00 vs 0.85 case is a clear real miss.

## 3. The Kan disagreements are Mortal vs the book, not a generator defect

Reviewed against the source text of Riichi Book 1, cloned at
`/home/kylehipke/workspaces/RiichiBooks` (LaTeX, so greppable):
`RiichiBook1-ch9-call.tex`, subsection *From an open set to an open quad
(kakan)*, starting at the `\subsection{From an open set to an open quad` line.

The book's conditions for extending a pon to a kan, verbatim:

> You can extend an open set to an open quad in any of the following situations:
>
> - the hand is 1-away or better with a good wait, and it has two han or more;
> - the hand is 1-away or better, and there are not many turns left to draw
>   tiles;
> - you need more dora or minipoints to improve the placement (especially in
>   South-4);
> - you are losing badly.

with the accompanying examples: 1-away + two han + good wait means kan is
justifiable, and three han + good wait but 2-away is *not* justifiable.

### The generator mirrors the book one-to-one

| Book bullet | Trigger | Enforced by |
| --- | --- | --- |
| 1-away or better, good wait, two han or more | `good_wait_and_value` | `skeleton` builds a ready hand with a ryanmen or three-sided wait; a second dragon triplet guarantees two han, and `shouminkan_min_wait_han` re-checks every wait tile |
| 1-away or better, few turns left | `late_game` | `tiles_remaining < 20` and every seat has 13 or more discards (`validate_board_constraints`, `choose_discard_count`) |
| need dora/minipoints for placement, South-4 | `placement_desperation` | round wind South, hand 4, human 2nd/3rd within 2,000 points |
| losing badly | `losing_badly` | human 4th, more than 12,000 behind third |

Every generated state is tenpai (`shanten == 0`) with a 2- or 3-tile wait, so
the "1-away or better" precondition holds in all four variants, including the
`late_game` one. `src/generator/shouminkan_decision/mod.rs` asserts each
emitted trigger against the finished state (`shouminkan_trigger_holds`), so the
labels cannot drift from the board.

The five reports sampled across runs confirm it — every one is South-4 with the
human 2nd or 3rd, e.g. `South 4`, scores `30723/26629/31649/10999`, 17 tiles
left, waits `3m 6m 9m`.

### Correction to the earlier claim

An earlier revision of this file said `late_game` was a contradictory trigger
because late game argues *against* kanning. That was wrong: the book lists late
game as an explicit justification (bullet 2), conditioned on being 1-away or
better, which the generator always satisfies. There is no trigger mismatch.

### What the book counts as cost, and which costs apply here

The book names two costs: you may lose safety tiles, and the new dora may go to
the opponents. It also warns that kakan risks chankan (robbing the kong). For
this scenario:

- **Chankan is structurally impossible.** The pon holds three copies and the
  fourth is in hand, so no opponent can be waiting on that tile. The generator
  never puts opponents in riichi either.
- **The new dora to opponents is the real cost**, and it is exactly where
  Mortal disagrees. Those reports cluster on `placement_desperation` (2nd/3rd
  within 2,000 points), where handing the table a new dora is genuinely risky.
  Discarding the fourth dragon is also a 100% safe tile for the same reason
  chankan is impossible: nobody can ron a tile with zero live copies.

So the scenario's answer is book-faithful and should not change. The
disagreements are Mortal weighing the book's *costs* more heavily than the
book's *criteria* on near-tied table positions:

```
app Kan (p=0.31) vs AI Discard_6z (p=0.68)
app Kan (p=0.43) vs AI Discard_7z (p=0.57)
app Kan (p=0.45) vs AI Discard_6z (p=0.53)
```

### The one real gap: coverage, not correctness

The generator is *stricter* than the book. Every puzzle is ready with a good
wait, so all four triggers land comfortably inside the book's safest zone.
The book explicitly allows kanning when the hand is not close to ready if you
need dora or are desperate (bullets 3 and 4), and its second worked example is a
*negative* case (three han, good wait, 2-away, do not kan) that we never
generate. Adding those marginal and negative cases would test the boundary the
book actually cares about; today's puzzles test only the easy side of it.

### Coverage added: the 2-away lessons, in both directions

Both gaps are now closed:

| Lesson | Hand | Table | Answer |
| --- | --- | --- | --- |
| `needs_dora` on `shouminkan_decision` | 2-away, only the dragon Pon (1 han) | South-4 within 2,000, or 4th by 12,000 | Kan |
| `shouminkan_decline` | 2-away, dragon Pon plus a second dragon triplet (2 han) | no placement or score pressure | discard the drawn 4th tile |

`needs_dora` is a new `ShouminkanTrigger` for the far-from-ready half of the
book's list; it only pairs with `placement_desperation` or `losing_badly`, and
it excludes the two conditions that require 1-away or better. The decline
scenario reuses the same 2-away skeleton and keeps `shouminkan_triggers` empty,
because the schema only carries reasons *for* the Kan.

"Improve the placement" is now quantified instead of assumed. The gap to the
player above is derived from the hand rather than sampled blindly:
`skeleton::value::placement_window` values both lines at their guaranteed
minimum (`ron_value(min_han, min_fu)`, 1 han at 30 fu versus 40 fu once the Kan
adds its minipoints), and the board samples the gap from the band between them,
in whole hundreds. So keeping the Pon leaves the human short and the Kan's
minipoints are what closes the gap, which is the book's own arithmetic ("at
least 60 minipoints, so 2000 points with one han").

The Kan's new dora, the rinshan draw and the tsumo score swing are ignored, so
this is a conservative floor. `value.rs` records the upgrade path: `crate::ai::sp`
now exists, so both lines could be scored with real expected values instead of
the guaranteed-minipoints bound.


The decline hand guarantees two han where the book's example has three. The
decisive factor in the book's sentence is the 2-away distance, not the han
count, so two is enough for the same lesson; it is noted in the skeleton docs.

Mortal disagrees with both, in opposite directions:

| Lesson | Agreement | Mortal's view |
| --- | --- | --- |
| `needs_dora` (2-away, desperate) | 2 of 15 disagreements describe it; prefers a discard | Kan p 0.01-0.42 |
| `shouminkan_decline` (2-away, value, calm) | 1 of 84 | Kan p median 0.59, max 0.93 |

Mortal wants to kan the comfortable value hand and to decline the desperate
one, the opposite of the book on both. That is a coherent difference in method
rather than a bug: Mortal optimises EV, and for it the fourth dragon is a dead
tile, so kanning is nearly free value plus an extra draw, while the new dora is
a shared risk that hurts most when somebody else is the one who needs it. The
book's 2-away rules are proximity heuristics, and proximity is exactly where an
EV model and the book part ways.

`AGENTS.md` makes the book the authority for a scenario's answer, so both
answers keep their book-faithful rules. Operationally, the decline half of the
merged `shouminkan_decision` lesson is skipped from the fuzz default sample (it
would bury unknown disagreements under a known one) while naming
`--scenario shouminkan_decision` explicitly fuzzes both halves. The numbers
above are the expected baseline for either half.

## 4. Bug (fixed): `legal_action_mask` marked an impossible plain discard for a red five

In a report with `red_fives: ["5s"]` and a hand holding exactly one 5s, which is
the red one, Mortal's ranking was:

```
Discard_5s   76.93%   <- impossible, there is no plain 5s in hand
Discard_5sr  18.62    <- the only legal 5s discard
Discard_5p    1.80
Riichi        1.32
```

`self_turn_actions` (`src/ai/actions.rs:162-171`) pushes the plain discard for
every held tile, then also pushes the red variant whenever `red_fives` contains
that tile. A single red five therefore yields two actions for the same physical
tile. The existing test `legal_mask_covers_hand_discards_red_five_and_riichi`
(`src/ai/wasm_bridge.rs:318`) asserts that the red variant is legal but never
checks that the plain one became impossible, which is why this slipped through.

Impact was not limited to fuzzing: it split roughly 19% of the probability mass
onto an illegal action for the live AI hint, and it let the runner report the
impossible action as Mortal's recommendation. Fixed in `self_turn_actions`,
which now emits one discard action per distinct tile and drops the plain variant
when the only held copy is the red five.

## 5. Gap (fixed): Riichi comparisons ignore the riichi discard

`compare_expected_action` mapped every riichi answer to the single action
`Riichi`, with no tile. A riichi that discards the wrong tile could therefore
never be detected, and the exported report echoed the app's tile instead of
Mortal's. For riichi-vs-dama scenarios the comparison was effectively
action-only.

Fixed by resolving Mortal's riichi discard in the evaluator itself:
`evaluate_state_named` runs the second pass (human marked as in Riichi, `Riichi`
masked off) whenever the top action is Riichi and records the result as
`Evaluation::riichi_discard`. `compare_expected_action` now treats a Riichi-vs-
Riichi pair with different discards as a `Tile` discrepancy, and
`reported_action_for_ai` writes Mortal's discard into the report instead of the
app's. The same field drives the app's dual grade (`MortalGrade::
recommended_riichi` / `recommended_discard`) and the UI, so the drill and the
offline runner cannot disagree about what Mortal would declare on.

## 6. Update after the EV / required-tile / SP-table planes (2026-11-10)

`am/sp-planes` fills rows 875-877 and 889-1011 from libriichi's shanten and
single-player EV solver. Re-running the same fuzz protocol with the same
weights changed both families substantially.

### chiitoitsu_riichi_vs_dama

Exact acceptance command (`--iterations 200 --limit 20`):

```
iterations: 34, agreements: 14, discrepancies: 20
```

Larger sample for a stable Riichi number (`--iterations 400 --limit 100`):

| Metric | Before (`e306c63`) | After |
| --- | --- | --- |
| Evaluations | 132 | 187 |
| All agreements | 32 (24.2%) | 87 (46.5%) |
| App-Riichi cases | 58 (all disagree) | 86 |
| App-Riichi agreements | **0 / 58** | **56 / 86 (65%)** |
| Mortal Riichi probability, median | 0.032 | 0.57 |
| Mortal Riichi probability, median on agreements | — | 0.78 |

The old documented baseline (0 of 16, median 0.01) reproduces in kind: the
pre-change worktree gives 58 app-Riichi disagreements with median Riichi
probability 0.032 in the larger sample. The remaining 30 after-change
disagreements are no longer a floor: their median Riichi probability is 0.27,
and the cases Mortal does agree on are mostly confident Riichi (median 0.78).

### ryanmen_protorun

Same command (`--iterations 200 --limit 20`) on the pre-change worktree and on
this branch:

| Run | Evaluations | Agreements | Discrepancies |
| --- | --- | --- | --- |
| Before (`e306c63`) | 46 | 26 (56.5%) | 20 |
| After (`am/sp-planes`) | 106 | 86 (81.1%) | 20 |

Phase A did not regress discard-tile decisions; the agreement rate improved
from 56.5% to 81.1% on this sample and the remaining misses are the same
off-by-one tile class described in §2.

## Suggested next steps

- [x] Fix the red-five double legality in `self_turn_actions`, and extend
      `legal_mask_covers_hand_discards_red_five_and_riichi` to assert the plain
      discard is masked when the only held copy is red. Done: `self_turn_actions`
      now emits one discard per distinct tile and suppresses the plain action
      when the only held copy is red, matching
      `agent_helper.rs:65-68`. Re-scoring the `445588m2256677p5s` report drops
      the impossible `Discard_5s` and lifts `Discard_5sr` from 18.62% to 80.71%.
- [x] Add a `--min-margin <p>` flag to the runner so near-ties stop producing
      report files. Done: `--min-margin` filters on `ai_probability -
      app_probability`, and the summary reports the filtered count as
      `below --min-margin`.
- [x] Populate the required-tile and sp-table planes. Done in `e0d5e6d` +
      `c4bc610` (see `sp-planes-plan.md`); the oracle test against libriichi
      passes and the Riichi bias is gone. The family still fills the 20-file
      budget, but now with genuine disagreements.
- [x] Human-review the Kan report against the book. Done: the generator maps
      1:1 onto the book's four kakan criteria and every state satisfies them
      (see section 3). No generator change needed; the earlier `late_game`
      complaint was wrong.
- [x] Extend `shouminkan_decision` coverage to the book's boundary. Done: the
      `needs_dora` trigger covers the not-close-to-ready desperation cases, and
      the merged lesson's decline half covers the book's negative example.
- [ ] Score both Kan lines with `crate::ai::sp` and derive the placement gap
      from real expected values instead of the guaranteed-minipoints floor
      (noted in `skeleton/value.rs`).
- [ ] Consider encoding the riichi discard tile so riichi answers can be
      compared on the tile as well as the action.
