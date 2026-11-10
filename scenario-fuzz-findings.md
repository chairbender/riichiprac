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

Run 1 wasted 26% of its budget on `ai_best_action`, which `generate_puzzle`
always rejects because it needs the loaded model. `d6165a7` dropped it from the
default set and made `--scenario ai_best_action` a bad-argument error, so run 2
evaluated a real state on every iteration.

Both runs stopped on the default `--limit 20`. Run 2's files are the ones
summarized below.

## Composition of the 20 disagreements

| Family | Files | Nature |
| --- | --- | --- |
| `chiitoitsu_riichi_vs_dama` | 15 | 10 app=**Riichi** vs Mortal discard, 5 app=Dama-tile vs different tile |
| `ryanmen_protorun` (`tile_efficiency`) | 4 | all off-by-one discard choices |
| `shouminkan_decision` (`kan_decision`) | 1 | app=**Kan** (haku) vs Mortal discard |

## 1. Mortal essentially never likes Riichi in the chiitoitsu family

This is the dominant finding and it looks like a harness fidelity problem, not
16 independent generator mistakes.

Across both runs, 36 states were evaluated and 16 of them had `Riichi` as the
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
value of declaring riichi depends on exactly that information. Until they are
populated, treat chiitoitsu Riichi discrepancies as harness noise. The app's
answers here (riichi, 6 pairs, 3-out tanki, flat scores, turn 3) are textbook
correct.

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
no margin (deliberate, per `scenario-fuzz-plan.md` step 5), so this class of
noise is expected. Only the 0.00 vs 0.85 case is a clear real miss.

## 3. The one Kan case is a legitimate judgment call

The `shouminkan_decision` report is the only disagreement of its kind so far and
is the one worth human review:

```
hand      45678m335555666z, pon of 5z (haku), holding the fourth 5z
board     13 discards, 17 tiles left, score 30,723
app       Kan (p=0.33), triggers: good_wait_and_value, late_game,
          placement_desperation
Mortal    Discard_5z 63.66%, Kan 32.77%       (EV -3.3689)
```

32.8% vs 63.7% is a real disagreement rather than an artifact. Note that the
trigger set is internally contradictory: `late_game` argues *against*
shouminkan (kan robbery, a dora for every opponent, fewer discards left to
defend with) yet it is listed as a trigger *for* it. The generator's heuristic
here probably needs tightening.

## 4. Bug: `legal_action_mask` marks an impossible plain discard for a red five

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

Impact is not limited to fuzzing: it splits roughly 19% of the probability mass
onto an illegal action for the live AI hint, and it lets the runner report the
impossible action as Mortal's recommendation.

## 5. Gap: Riichi comparisons ignore the riichi discard

`compare_expected_action` maps every riichi answer to the single action
`Riichi`, with no tile. A riichi that discards the wrong tile can therefore
never be detected, and the exported report echoes the app's tile instead of
Mortal's. For riichi-vs-dama scenarios the comparison is effectively
action-only.

## Suggested next steps

- [ ] Fix the red-five double legality in `self_turn_actions`, and extend
      `legal_mask_covers_hand_discards_red_five_and_riichi` to assert the plain
      discard is masked when the only held copy is red.
- [ ] Add a `--min-margin <p>` flag to the runner so near-ties stop producing
      report files.
- [ ] Decide whether riichi-vs-dama cases should be excluded or flagged until
      the required-tile and sp-table planes are populated; as-is they always
      fill the 20-file budget.
- [ ] Human-review the Kan report and tighten the `late_game` trigger semantics.
- [ ] Consider encoding the riichi discard tile so riichi answers can be
      compared on the tile as well as the action.
