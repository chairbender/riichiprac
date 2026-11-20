# Q4 — ch. 5 value replay pack

Implementation unit Q4 of the replay-first rollout
([`replay-first-rollout.md`](replay-first-rollout.md) → *Wave 2*). This is the
third chapter pack (after ch. 8 defense and ch. 7 riichi/dama): the ch. 5
**hand value** family — the honitsu plan, the pinfu head, and the
chiitoitsu/toitoi crossroad — mined from the same 1,542-game AI self-play corpus
and classifier v3 (B4.2/B4.3 landed the two new recognisers).

**Shipped artifact:** `frontend/public/scenarios/`, pack
`replay.ch5-values.2026-11`, **1,670 reviewed bases, 0 variants,
1,176,300 bytes**, three lessons across ch5.3/ch5.4/ch5.5. Every shipped lesson
clears the 40-base coverage floor, so all three become **replay-default**;
`sanshoku_pursuit` (2 stable labels) is not shipped.

## Lessons and coverage

| Section | Lesson | Stable labels | Selected | Shipped bases | Floor |
| --- | --- | ---: | ---: | ---: | --- |
| ch5.3 | `pinfu_head` | 353 | 270 | 257 | yes |
| ch5.4 | `honitsu_decision` | 2,527 | 1,378 | 1,319 | yes |
| ch5.5 | `chiitoi_vs_toitoi` | 120 | 97 | 94 | yes (B4.2) |
| ch5.1 | `sanshoku_pursuit` | 2 | — | — | **no** (corpus growth C9) |
| **Total** | | **3,002** | **1,745** | **1,670** | |

The shipped-count differences are assembly's actor-hand dedupe (75 bases), not
lesson floors: every lesson stays above 40 after dedupe. `sanshoku_pursuit` is
excluded from the selection scope on purpose — at 2 stable labels it is far
below the floor and must not ship thin.

## Pipeline

```bash
export RIICHI_DATA_DIR="$HOME/riichiprac-data/q2-ch8-defense-2026-11"
BIN=target/release/mine_replays
cargo build --release --features miner --bin mine_replays

# 1. Labels are classifier v3 from B4 (the one label pass already ran); this
#    pack reuses them, so it does not re-evaluate Mortal. Weights: AGENTS.md
#    §5c (not needed for a stable-book selection or a book-only transform).

# 2. Select one section-scoped queue. The three shippable lessons are named
#    explicitly; sanshoku_pursuit is deliberately absent.
$BIN --data-dir "$RIICHI_DATA_DIR" select \
  --pack-id replay.ch5-values.2026-11 \
  --size 3000 --held-out-share 0.05 --seed q4-ch5-2026-11 \
  --section ch5 \
  --lesson honitsu_decision,pinfu_head,chiitoi_vs_toitoi \
  --stable-book-only \
  --corpus-family mortal_mirror,mortal_sampling_sweep,akochan_tactics,akochan_vs_mortal,heterogeneous_table \
  --max-per-replay 2 --extracted-only --workers 0 --progress \
  --max-section-share 0.50 --max-kind-share 0.90 --max-turn-share 0.90 \
  --json > testdata/reports/q4-ch5/selection-report.json

# 3. Mechanical review (chapter-scoped). The three shipped shapes are 1-away or
#    slower, so a ready hand is rejected; then bulk dispositions.
python3 scripts/review-q2-queue.py \
  "$RIICHI_DATA_DIR/reviews/replay.ch5-values.2026-11/review-queue.jsonl" \
  --chapter ch5 --verdicts-out testdata/reports/q4-ch5/verdicts.json \
  > testdata/reports/q4-ch5/mechanical-review.json
$BIN --data-dir "$RIICHI_DATA_DIR" review --pack replay.ch5-values.2026-11 \
  --verdicts testdata/reports/q4-ch5/verdicts.json --json \
  > testdata/reports/q4-ch5/review-report.json

# 4. Sampled content sheet for the human sign-off (all 97 chiitoi bases are
#    included because that lesson is the thin one).
python3 scripts/sample-review-sheet.py \
  "$RIICHI_DATA_DIR/reviews/replay.ch5-values.2026-11/review-queue.jsonl" \
  --sample 220 --per-lesson 30 --per-family 20 --include-all-below 120 \
  --seed q4-ch5-2026-11 --out-json testdata/reports/q4-ch5/review-sample.json \
  > testdata/reports/q4-ch5/review-sample.md

# 5. Persist the reviewed bases (variants are disabled by product decision;
#    the stage still runs its label-preservation check).
$BIN --data-dir "$RIICHI_DATA_DIR" transform \
  --pack-id replay.ch5-values.2026-11 --variants 1 \
  --seed q4-ch5-2026-11 --generated-at 2026-11-20T00:00:00Z \
  --workers 0 --progress --json \
  > testdata/reports/q4-ch5/variant-report-disabled.json

# 6. Assemble the reviewed bases only, drop duplicate actor hands, enforce the
#    40-base lesson floor, audit, and publish all four hosted packs together.
$BIN --data-dir "$RIICHI_DATA_DIR" pack assemble \
  --pack replay.ch5-values.2026-11 \
  --queue "$RIICHI_DATA_DIR/reviews/replay.ch5-values.2026-11/review-queue.jsonl" \
  --no-variants --unique-hands --min-bases-per-lesson 40 --max-scenarios 3500 \
  --licence CC-BY-4.0 --attribution "Ch.5 value pack. <corpus attribution, see the pack>" \
  --generated-at 2026-11-20T00:00:00Z --commit q4-ch5-2026-11 --json \
  > testdata/reports/q4-ch5/assembly-report.json
$BIN --data-dir "$RIICHI_DATA_DIR" pack publish \
  --packs replay.ch5-values.2026-11,replay.ch7-riichi-dama.2026-11,replay.ch8-defense.2026-11,replay.ch8-defense-multi-threat.2026-11 \
  --updated-at 2026-11-20T00:00:00Z --json \
  > testdata/reports/q4-ch5/publish-report.json
node scripts/check-pack-hosting.mjs
node scripts/check-ch8-pack.mjs --allow-no-variants
node scripts/check-ch8-pack.mjs --pack replay.ch8-defense-multi-threat.2026-11 --allow-no-variants
node scripts/check-ch8-pack.mjs --chapter ch7 --allow-no-variants
node scripts/check-ch8-pack.mjs --chapter ch5 --allow-no-variants
node scripts/replay-coverage-report.mjs --json > testdata/reports/q4-ch5/coverage.json
```

The publish command lists all four packs on purpose: `--packs` replaces the
hosted set with exactly the ids given, so omitting the ch. 7/ch. 8 packs would
prune their bodies.

## Selection

Machine-readable report:
[`testdata/reports/q4-ch5/selection-report.json`](../testdata/reports/q4-ch5/selection-report.json).

- 14 workers, 65 min 24 s wall (three passes over 1,542 replays).
- Funnel: 1,542 parsed/valid → 787,052 decisions → 646,776 trigger hits →
  113,094 book matches → **3,000 gate passes** → 150 held out → **1,745
  selected**.
- 4,082 selection attempts were skipped by `--max-per-replay 2`; 6 slots came
  from the relaxed fill, and 0 selected scenarios were beyond a section/kind/turn
  cap (`cap_relaxed` 0).
- Section mix: ch5.3 270, ch5.4 1,378, ch5.5 97. All candidates are
  `self_turn` discards; the section, kind and turn caps were not binding.
- Corpus mix (no `--corpus-cap`): `mortal_mirror` 857,
  `mortal_sampling_sweep` 818, `heterogeneous_table` 27, `akochan_tactics` 23,
  `akochan_vs_mortal` 20.
- The scope rejected 63,143 out-of-scope and 46,951 contested labels, exactly
  as the stable-book filter requires.

**Why 1,745 and not 3,000.** All ch. 5 candidates are stable-book shapes, so
they only populate the `book`, `coverage` and `placement` quota families (plus
partial `close_call`/`speed_value`/`mistake`). Those family quotas are 900 + 450
+ 150 of a 3,000 pack, and the fill stops when the remaining candidates belong
only to already-met families: book 904, coverage 452, placement 150, close_call
132, speed_value 87, mistake 20 = **1,745 selected**. A larger `--size` would
raise every quota proportionally; this run trades pack size for the quota mix
the selector was configured for, and every lesson still has hundreds (or 94)
bases of real variety.

> **Correction (2026-11-20, task 261120-0843).** The quota mix was not the
> binding limit. The stable-book pool is replay-clustered: the 3,000 stable
> labels sit in 1,096 games, and 712 of those games hold two or more. Under
> `--max-per-replay 2` that pool tops out at 1,808 bases, and the held-out split
> (150, drawn before selection) plus the 18 exact duplicates account for the
> observed 1,745 — the family quotas were met (book 904/900, coverage 452/450,
> placement 150/150) and the final fill was already allowed to exceed them. The
> selector now treats the per-replay cap like the section/kind/turn caps: a
> last-resort fill relaxes it when the remaining pool has nothing else to offer
> and records `source_replay_relaxed`, so a re-run with `--size 3000` can reach
> the pack room instead of stopping at 1,745. See `replay-miner-operations.md`
> (`--max-per-replay`). This shipped pack was not re-selected.

The thinnest lesson, `chiitoi_vs_toitoi`, supplied 97 selected bases (120 stable
labels in the corpus, 114 candidates); the section/kind caps did not starve it.

**Held-out QA:** 150 items, disjoint from the pack, deterministic under
`--seed q4-ch5-2026-11`, all stable book labels. The held-out set is not part of
the pack and is not dispositioned.

## Review

- **Mechanical review** (`scripts/review-q2-queue.py --chapter ch5`): 1,745
  items, **1,745 accepted, 0 rejected**, no invalid reports. The new ch. 5 scope
  rejects out-of-scope sections/lessons, non-book or contested labels,
  report/lesson mismatches, illegal answers, duplicate exact/visible states,
  dirty walks, and ready hands. The ready-hand rule is decided from the shipped
  shapes, not copied from ch. 8: `honitsu_decision` only matches 1-2 shanten and
  refuses a discard into tenpai, `chiitoi_vs_toitoi` is exactly 1-away, and
  `pinfu_head` needs two or more shanten. The one ch. 5 tenpai lesson
  (`sanshoku_pursuit`) is below the floor and out of scope.
- **Bulk dispositions** (`review --verdicts`): 1,745 accepted, 0 rejected,
  0 pending, 1,745 valid reports.
- **Sampled content review:** 248 rows
  ([`review-sample.md`](../testdata/reports/q4-ch5/review-sample.md),
  [`review-sample.json`](../testdata/reports/q4-ch5/review-sample.json)) —
  per-lesson guarantees (30 each), per-family guarantees (20 each) and **all 97
  `chiitoi_vs_toitoi` bases** (110 `honitsu_decision`, 41 `pinfu_head`). The user
  sign-off is recorded below when received.

## Pack

| Pack measurement | Value |
| --- | ---: |
| Scenarios | 1,670 |
| Reviewed bases | 1,670 |
| Variants | 0 (disabled) |
| Distinct lessons | 3 (`honitsu_decision`, `pinfu_head`, `chiitoi_vs_toitoi`) |
| Book sections | ch5.3, ch5.4, ch5.5 |
| Body bytes | 1,176,300 |
| Uncompressed body | 12,302,233 |
| Manifest bytes | 3,205 (four packs) |
| Distinct source replays | 1,041 |
| Adjacent same-replay bases | 0 |
| Actor hands | 1,670 unique |
| Licence | CC-BY-4.0 (data) |
| `data_commercial_use` | false (Akochan) |
| `requires_model` | false (all book answers) |
| Pack SHA-256 | `5d0b01e6badb331b6771c239e50c4fac2659bbfcf338641199dc6bdb447f5864` |
| Audit (hosted manifest) | clean, 0 findings |
| Load/decode (Node, this box) | 19.2 ms gunzip + 66.3 ms JSON parse |

Assembly dropped 75 duplicate actor hands (1,745 → 1,670). Counting the variant
rows too, 1,495 rows were duplicate hands (75 bases + 1,420 variants), 194
variant rows lost their base to that dedupe, and 3,267 variant rows were
disabled. The transform stage persisted 4,881 gated variants for the
label-preservation report, none ship. The assembly report accounts for every
row (`rows_read` 6,626 = 1,745 bases + 4,881 variants; 4,956 dropped).

The hosted set is now four bodies: 1,176,300 + 2,176,750 + 2,260,809 + 591,096
bytes + a 3,205-byte manifest = **6,208,160 bytes**, inside the 50 MB
same-origin budget and still small enough that only the manifest is fetched at
startup.

## Checks

| Gate | Result |
| --- | --- |
| Audit (source export) | clean |
| Audit (hosted manifest) | clean, 0 findings |
| Hosting (source) | 147/147 |
| Hosting (dist after build) | 147/147 |
| ch5 content (`--chapter ch5`) | 27/27, source and dist |
| ch7 content (`--chapter ch7`) | 27/27, source and dist |
| ch8 content | 27/27 for each ch8 pack, source and dist |
| Serving | 26/26 (all four bodies: `application/gzip`, no `Content-Encoding`, exact bytes/SHA-256) |
| Frontend | 811 passed, 1 skipped; build pass; lint pass |
| Q1 end-to-end | PASS |
| Q1 loader smoke (ch5 body) | pass: manifest → content-addressed body → hash/byte check → gzip → schema |
| Old pack bodies | unchanged (`08cbeacac15f…`, `6ae2c924e80c…`, `15fe519c65df…`) |

## Coverage

[`coverage.json`](../testdata/reports/q4-ch5/coverage.json) names every lesson
and its floor decision. The three shipped ch. 5 lessons are now
**replay-default**; the five ch. 8 lessons and six ch. 7 lessons at or above
forty keep their existing defaults. The thin ch. 8 lessons
(`defense_stuck_heuristic` 32, `kabe_one_chance` 17,
`kabe_double_one_chance` 13) stay opt-in rows under their pack, and
`sanshoku_pursuit` gains no replay row until `C9` grows the corpus.

## User sign-off

The 248-row sample and the published pack were presented on 2026-11-20.
**User sign-off: approved** ("Approve") for the 1,670-base, 0-variant pack and
the sampled content review.

## Related links

- [`replay-first-rollout.md`](replay-first-rollout.md) — Q4 task, coverage floor,
  pack granularity and the source-model contract.
- [`replay-implementation-plan.md`](replay-implementation-plan.md) §11 — the
  replay-first rollout constraints.
- [`replay-miner-operations.md`](replay-miner-operations.md) — selection scope,
  review, assembly, manifest `lesson_counts` and the chapter-scoped mechanical
  rules.
- [`q3-ch7-riichi-dama-pack.md`](q3-ch7-riichi-dama-pack.md) — the pipeline shape
  this pack follows.
- [`testdata/reports/b4-classifiers/label-yield-report.md`](../testdata/reports/b4-classifiers/label-yield-report.md)
  — the classifier-v3 yield this pack consumes (B4.2 `chiitoi_vs_toitoi`).
