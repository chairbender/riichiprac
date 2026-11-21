# Q7 — ch. 8 completion: measurement and decision

Implementation unit Q7 of the replay-first rollout
([`replay-first-rollout.md`](replay-first-rollout.md) → *Wave 3*). This is the
**last chapter pack**: after ch. 8 defense/multi-threat, ch. 7, ch. 5, ch. 9 and
Q6's ch. 3/4 shapes, only four ch. 8 lessons had no replay coverage —
`open_hand_defense` (ch8.4), `suji_trap_riichi` (ch8.2), `kabe_no_chance`
(ch8.2) and `kabe_suji_defense` (ch8.2).

**Decision: no pack ships in Q7.** Re-measured on the current data root, all
four lessons are below the 40-reviewed-base floor, so there is nothing that may
ship without relaxing `--stable-book-only` or the floor. The six hosted packs
are byte-for-byte unchanged. The four lessons stay **generated-only** and are
recorded as `C9` corpus-growth targets with their measured supply. The ch. 8
mechanical-review scope and the ch. 8 content-check lesson set were completed in
this unit so a future C9 pack is ready to select, review and gate, but no
scenario, body, manifest or hash changed.

## Measured supply (classifier v3, current corpus)

Data root: `~/riichiprac-data/q2-ch8-defense-2026-11`, the same 1,542-game
AI self-play corpus B4 measured (`mortal_mirror` 750, `mortal_sampling_sweep`
748, `akochan_tactics` 14, `akochan_vs_mortal` 15, `heterogeneous_table` 15).
The 455 `rule_baseline` replays in the root are unlabelled and outside the B4
corpus, so they are excluded; no new corpus games have landed since B4 (the
latest replay is 2026-11-19), and the C9 corpus-growth task (`261119-233553`)
has not ingested any yet.

| Section | Lesson | Stable | Contested | Shipped bases | Floor decision |
| --- | --- | ---: | ---: | ---: | --- |
| ch8.1 | `push_or_fold` | 4,877 | 4,020 | 295 | **replay-default** |
| ch8.2 | `defense_multi_threat` | 1,153 | 451 | 764 | **replay-default** |
| ch8.2 | `defense_safety_chart` | 17,190 | 7,082 | 766 | **replay-default** |
| ch8.2 | `suji_kabe_safety` | 1,755 | 1,683 | 357 | **replay-default** |
| ch8.2 | `kabe_one_chance` | 60 | 88 | 17 | thin (opt-in under the ch8 pack) |
| ch8.2 | `kabe_double_one_chance` | 55 | 84 | 13 | thin (opt-in under the ch8 pack) |
| ch8.3 | `defense_stuck_heuristic` | 211 | 217 | 32 | thin (opt-in under the ch8 pack) |
| ch8.3 | `fold_to_riichi` | 28,694 | 5,182 | 731 | **replay-default** |
| ch8.2 | `kabe_suji_defense` | 32 | 28 | — | **generated-only (Q7, C9)** |
| ch8.4 | `open_hand_defense` | 4 | 15 | — | **generated-only (Q7, C9)** |
| ch8.2 | `suji_trap_riichi` | **0** | **0** | — | **generated-only (Q7, C9)** |
| ch8.2 | `kabe_no_chance` | **0** | **0** | — | **generated-only (Q7, C9)** |

Twelve ch. 8 lessons: five replay-default, three thin-but-opt-in, four
generated-only. The four Q7 lessons have no replay row in the picker at all
(not even an opt-in one), because none of them reaches the floor and Q7 does not
ship a below-floor body.

The zero rows are not a classifier bug: the B4 report and the label pass agree,
and the recognisers' own generator/classifier tests pass. Zero **contested**
labels too means the position was not even a Mortal-visible book cell in these
1,542 games — these shapes are simply absent from generic AI self-play.

`supply-by-family.json` confirms where the non-zero supply comes from:
`kabe_suji_defense` 17 stable in `mortal_mirror` and 15 in
`mortal_sampling_sweep`; `open_hand_defense` 2 + 2; the three small Akochan
families contribute nothing stable for either. The two zero lessons have no
label row in any family.

## Why no pack

The rollout's product rule is per lesson: a lesson is replay-default only when
its shipped pack has at least 40 reviewed bases, and Q7's brief explicitly says
not to relax `--stable-book-only` or the floor. With 4 / 0 / 0 / 32 stable
labels, even a perfect selection could not reach 40 reviewed bases for any of
the four, and the zeros cannot be selected at all. Shipping a 32-base opt-in
`kabe_suji_defense` body would add a pack that could never be replay-default
and would need replacing after C9; Q7 does not do that.

No new lesson is shipped, so no new lesson can violate the floor. The three
pre-existing thin ch8 rows (`defense_stuck_heuristic` 32, `kabe_one_chance` 17,
`kabe_double_one_chance` 13) stay exactly as Q2/Q5 left them: opt-in under
`replay.ch8-defense.2026-11`, never replay-default, which the rollout's
acceptance rule explicitly allows.

This is the same outcome Q4/Q5/Q6 recorded for their thin lessons, and it keeps
the acceptance gate honest: **every shipped lesson stays at or above 40 bases**,
and everything thin is named here and in the coverage report.

## What C9 has to grow

Rates are stable labels per 100 games on the 1,542-game corpus, and the
games-to-floor estimate targets **45–50 stable labels** so the 40-base floor
survives selection losses and the assembly duplicate-hand dedupe (Q6's 868
selected bases became 822 shipped).

| Lesson | Stable / 1,542 games | Stable per 100 | Games per stable label | More games for 45 stable | More games for 50 stable |
| --- | ---: | ---: | ---: | ---: | ---: |
| `kabe_suji_defense` | 32 | 2.075 | 48.2 | **627** | **868** |
| `open_hand_defense` | 4 | 0.259 | 385.5 | **15,806** | **17,734** |
| `suji_trap_riichi` | 0 | not measurable | — | no estimate | no estimate |
| `kabe_no_chance` | 0 | not measurable | — | no estimate | no estimate |

For the two zero lessons the rule of three gives only a 95 % upper bound of
0.195 labels per 100 games (about one label per 513 games), so even at that
bound 45 stable labels would need ~21,500 more games. The honest reading is that
**generic self-play growth is not a credible route for `open_hand_defense`,
`suji_trap_riichi` or `kabe_no_chance`**: C9 must either target those shapes
with a family/pre-filter that raises their incidence, or record them as
generated-only by product decision. `kabe_suji_defense` is the one realistic
self-play target (~900 more games for a comfortable margin).

The actionable C9 brief, as measured here:

- `kabe_suji_defense`: grow the corpus by ~900+ games (or run a targeted kabe
  family) and re-measure; it should clear 40 without a new classifier.
- `open_hand_defense`: needs ~16k–18k more games at the current rate, or a
  targeted chii/open-hand family. Generic growth alone is not viable.
- `suji_trap_riichi`, `kabe_no_chance`: no observed rate in 1,542 games; a
  targeted generation family or an explicit generated-only decision is required
  before any pack claim.
- Report the per-lesson rate per 100 new games for all four, so the next Q7
  attempt can re-run this table instead of re-deriving it.

## Pipeline readiness (for the C9 follow-up)

No selection, review, transform, assembly, publish or audit ran in Q7, because
there was nothing above the floor to select. The commands are unchanged from Q6
and are ready to run when C9 lands:

```bash
export RIICHI_DATA_DIR="$HOME/riichiprac-data/q2-ch8-defense-2026-11"
BIN=target/release/mine_replays

$BIN --data-dir "$RIICHI_DATA_DIR" select \
  --pack-id replay.ch8-completion.2026-11 \
  --size 3000 --held-out-share 0.03 --seed q7-ch8-2026-11 \
  --section ch8 --lesson <lessons that clear 40> \
  --stable-book-only \
  --corpus-family mortal_mirror,mortal_sampling_sweep,akochan_tactics,akochan_vs_mortal,heterogeneous_table \
  --max-per-replay 2 --extracted-only --workers 0 --progress \
  --max-section-share 0.60 --max-kind-share 0.95 --max-turn-share 0.95 \
  --json > testdata/reports/q7-ch8/selection-report.json

python3 scripts/review-q2-queue.py \
  "$RIICHI_DATA_DIR/reviews/replay.ch8-completion.2026-11/review-queue.jsonl" \
  --chapter ch8 --verdicts-out testdata/reports/q7-ch8/verdicts.json \
  > testdata/reports/q7-ch8/mechanical-review.json
# ... review --verdicts, sampled sheet, transform --variants 1,
# pack assemble --no-variants --unique-hands --min-bases-per-lesson 40,
# pack publish with all seven hosted packs, then the six checks below.
```

Two pipeline gaps that would have bitten that run were fixed here:

1. **Mechanical review scope** (`scripts/review-q2-queue.py`). The `ch8` scope
   was missing `open_hand_defense` and `suji_trap_riichi`, so a C9 queue would
   have rejected every selected candidate as `out_of_scope_lesson`. It is now
   the complete twelve-lesson chapter. The ready-hand rule is **lesson-scoped**
   for the first time in ch8: `suji_trap_riichi` is a *riichi declaration*
   (`src/classifier/suji.rs`, citing Riichi Book 1 ch8:165 and ch7:512, answers
   Riichi on the trap discard), so its ready hand is in shape and must be kept;
   every other ch8 lesson — including `open_hand_defense`, whose recogniser
   requires 2-away or worse (`src/classifier/open_hand.rs`, ch8:567-570) — keeps
   the ready-hand rejection. A synthetic queue check (`review-scope-check.txt`)
   proves the four cases:
   suji-trap-ready accepted, open-hand-ready rejected, kabe-suji-slow accepted,
   kabe-no-chance-ready rejected.
2. **Content gate lesson set** (`scripts/check-ch8-pack.mjs`). `ch8` now names
   all twelve ch8 lessons, including `suji_trap_riichi` (the only missing id),
   so the existing CI step `node scripts/check-ch8-pack.mjs --allow-no-variants`
   already gates the lesson set a future ch8 completion pack ships. A new CI
   step also runs `scripts/replay-coverage-report.mjs --catalogue
   testdata/reports/q7-ch8/lesson-catalogue.json`, so the all-lessons coverage
   report is exercised on every build.

## Coverage report

[`coverage.json`](testdata/reports/q7-ch8/coverage.json) (generated with the
app's own lesson catalogue, `--catalogue lesson-catalogue.json`) names **all 37
book lessons and their floor decision**, not just the hosted ones:

- **22 replay-default**, including the five ch8 default lessons above;
- **3 thin, opt-in** (`defense_stuck_heuristic` 32, `kabe_one_chance` 17,
  `kabe_double_one_chance` 13 — all in `replay.ch8-defense.2026-11`);
- **12 not shipped** (`not_shipped`), including the four Q7 ch8 lessons and the
  eight other below-floor ch3/ch5/ch9 lessons.

[`ch8-supply.json`](testdata/reports/q7-ch8/ch8-supply.json) is the same
chapter view with measured stable/contested labels, shipped bases, decision and
the C9 games-to-floor estimates. The catalogue snapshot was produced by

```bash
cargo run --quiet --bin dump_scenarios > testdata/reports/q7-ch8/lesson-catalogue.json
node scripts/replay-coverage-report.mjs --catalogue testdata/reports/q7-ch8/lesson-catalogue.json \
  --json > testdata/reports/q7-ch8/coverage.json
```

`--catalogue` is a new, generic option (it merges `list_scenarios_json()` into
the manifest report and adds a `not-shipped` row for every book lesson no pack
carries); the old manifest-only form is unchanged for the six-pack check.

## Checks

| Gate | Result |
| --- | --- |
| Fresh label-yield pass (classifier v3) | `label-supply.json`, 37 lessons, no version mismatch |
| Hosting (source) | `hosting-check.json`, pass |
| Hosting (dist after build) | `hosting-dist-check.json`, pass |
| ch8 content (`--pack replay.ch8-defense`) | `ch8-check.json` / `ch8-dist-check.json`, 0 problems, 2,211 scenarios |
| ch8 multi-threat content | `ch8-multi-{check,dist-check}.json`, 0 problems, 764 |
| ch7 / ch5 / ch9 / ch34 content (source and dist) | 0 problems each; 2,846 / 1,670 / 629 / 822 scenarios |
| Serving (all six bodies) | `serving-check.txt`, 38/38 |
| Coverage report (all book lessons) | `coverage.txt`, 22 default / 3 thin / 12 not shipped, CI step added |
| Pack bodies unchanged | `pack-hashes.json`, every body matches the manifest; `git status frontend/public/scenarios` empty |
| Frontend tests | `frontend-test.txt`, 1,532 passed, 1 skipped |
| Frontend build / lint | `frontend-build.txt` pass, `frontend-lint.txt` pass |
| Q1 end-to-end | `q1-e2e.txt`, PASS (10 fixture-gate tests + byte-identical packs + loader) |
| Rust tests / clippy / fmt / wasm check | 1,173 lib+miner tests pass; clippy, fmt, `cargo check --target wasm32-unknown-unknown` clean |

No pack body, manifest or hash changed, so there is no new visual artifact and
no new user sign-off question. The six hosted packs and their coverage remain
exactly as Q6 left them.

## Related links

- [`replay-first-rollout.md`](replay-first-rollout.md) — Q7, the C9 brief and
  the per-lesson coverage floor.
- [`q6-ch34-shapes-pack.md`](q6-ch34-shapes-pack.md) — the latest packed
  pipeline shape this unit would reuse.
- [`q2-ch8-defense-pack.md`](q2-ch8-defense-pack.md) and
  [`q2-multi-threat.md`](q2-multi-threat.md) — the two ch8 packs and their
  lesson scopes.
- [`replay-miner-operations.md`](replay-miner-operations.md) — selection,
  review, assembly and the chapter mechanical rules.
- [`testdata/reports/b4-classifiers/label-yield-report.md`](testdata/reports/b4-classifiers/label-yield-report.md)
  — the classifier-v3 yield this measurement re-checks.
