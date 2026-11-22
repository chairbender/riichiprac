# Q3 — ch. 7 riichi/dama replay pack

Implementation unit Q3 of the replay-first rollout
([`replay-first-rollout.md`](replay-first-rollout.md) → *Wave 1*). This is the
second chapter pack (after ch. 8 defense): the ch. 7 **riichi vs dama**
declaration family, mined from the same 1,542-game AI self-play corpus and
classifier v3 (B4 landed the seven-pairs recogniser this pack exercises).

**Shipped artifact:** `frontend/public/scenarios/`, pack
`replay.ch7-riichi-dama.2026-11`, **2,846 reviewed bases, 0 variants,
2,183,692 bytes**, six lessons across ch7.1/ch7.2/ch7.3. Every lesson clears the
40-base coverage floor, so all six become **replay-default**.

**Refreshed 2026-11-21 (task 261120-2242).** `dama_improving_hand`'s Details
line now lists the hand's improving kinds and their live copies instead of the
generic "at least six kinds" sentence, and names any three-han step. The pack
was reassembled from the same reviewed queue and republished: every scenario,
base and lesson count is unchanged; the body is now 2,183,692 bytes (SHA-256
`e08472e483c58d43a7f3d41030034a87479ee84f085fceae4ceec9911fd0c018`). The Q3
measurements below are the original 2026-11-19 run; this task's reports are in
[`testdata/reports/261120-2242/`](testdata/reports/261120-2242/). The only
per-scenario change is `book_rationale`; the reassembly also stamps the current
`generator.classifier_version` (4) while the reviewed bases and labels remain
the Q3 v3 selection.
`node scripts/check-improving-hand-details.mjs` re-checks the shipped text
(57/57 bases at this assembly): every listed kind and `(N left)` must agree
with the tiles visible on the table.

## Lessons and coverage

| Section | Lesson | Stable labels | Selected | Shipped bases | Floor |
| --- | --- | ---: | ---: | ---: | --- |
| ch7.1 | `riichi_judgement` | 3,182 | 1,452 | 1,426 | yes |
| ch7.2 | `chiitoitsu_riichi_vs_dama` | 252 | 153 | 151 | yes (B4.1) |
| ch7.3 | `dama_bad_wait` | 2,664 | 1,003 | 982 | yes |
| ch7.3 | `dama_expensive_hand` | 566 | 112 | 111 | yes |
| ch7.3 | `dama_genbutsu_wait` | 494 | 121 | 119 | yes |
| ch7.3 | `dama_improving_hand` | 137 | 60 | 57 | yes |
| **Total** | | **7,295** | **2,901** | **2,846** | |

The shipped-count differences are assembly's actor-hand dedupe (66 bases), not
lesson floors: every lesson stays above 40 after dedupe.

## Pipeline

```bash
export RIICHI_DATA_DIR="$HOME/riichiprac-data/q2-ch8-defense-2026-11"
BIN=target/release/mine_replays
cargo build --release --features miner --bin mine_replays

# 1. Labels are classifier v3 from B4 (the one label pass already ran); the
#    ch. 7 pack reuses them, so this task does not re-evaluate Mortal.
#    Weights: AGENTS.md §5c (not needed for a stable-book selection or a
#    book-only transform).

# 2. Select one section-scoped queue. The six lessons are named explicitly so a
#    later ch. 8 pack cannot leak in through a shared section prefix.
$BIN --data-dir "$RIICHI_DATA_DIR" select \
  --pack-id replay.ch7-riichi-dama.2026-11 \
  --size 3000 --held-out-share 0.05 --seed q3-ch7-2026-11 \
  --section ch7 \
  --lesson riichi_judgement,chiitoitsu_riichi_vs_dama,dama_bad_wait,dama_genbutsu_wait,dama_expensive_hand,dama_improving_hand \
  --stable-book-only \
  --corpus-family mortal_mirror,mortal_sampling_sweep,akochan_tactics,akochan_vs_mortal,heterogeneous_table \
  --max-per-replay 2 --extracted-only --workers 0 --progress \
  --max-section-share 0.50 --max-kind-share 0.90 --max-turn-share 0.90 \
  --json > testdata/reports/q3-ch7/selection-report.json

# 3. Mechanical review (chapter-scoped; a riichi/dama decision is tenpai, so
#    the ch. 8 ready-hand rejection does not apply), then bulk dispositions.
python3 scripts/review-q2-queue.py \
  "$RIICHI_DATA_DIR/reviews/replay.ch7-riichi-dama.2026-11/review-queue.jsonl" \
  --chapter ch7 --verdicts-out testdata/reports/q3-ch7/verdicts.json \
  > testdata/reports/q3-ch7/mechanical-review.json
$BIN --data-dir "$RIICHI_DATA_DIR" review --pack replay.ch7-riichi-dama.2026-11 \
  --verdicts testdata/reports/q3-ch7/verdicts.json --json \
  > testdata/reports/q3-ch7/review-report.json

# 4. Sampled content sheet for the human sign-off (all 60 dama_improving_hand
#    bases are included because that lesson is the thin one).
python3 scripts/sample-review-sheet.py \
  "$RIICHI_DATA_DIR/reviews/replay.ch7-riichi-dama.2026-11/review-queue.jsonl" \
  --sample 220 --per-lesson 30 --per-family 20 --include-all-below 60 \
  --seed q3-ch7-2026-11 --out-json testdata/reports/q3-ch7/review-sample.json \
  > testdata/reports/q3-ch7/review-sample.md

# 5. Persist the reviewed bases (variants are disabled by product decision;
#    the stage still runs its label-preservation check).
$BIN --data-dir "$RIICHI_DATA_DIR" transform \
  --pack-id replay.ch7-riichi-dama.2026-11 --variants 1 \
  --seed q3-ch7-2026-11 --generated-at 2026-11-19T00:00:00Z \
  --workers 0 --progress --json \
  > testdata/reports/q3-ch7/variant-report-disabled.json

# 6. Assemble the reviewed bases only, drop duplicate actor hands, enforce the
#    40-base lesson floor, audit, and publish all three hosted packs together.
$BIN --data-dir "$RIICHI_DATA_DIR" pack assemble \
  --pack replay.ch7-riichi-dama.2026-11 \
  --queue "$RIICHI_DATA_DIR/reviews/replay.ch7-riichi-dama.2026-11/review-queue.jsonl" \
  --no-variants --unique-hands --min-bases-per-lesson 40 --max-scenarios 3500 \
  --licence CC-BY-4.0 --attribution "<corpus attribution, see the pack>" \
  --generated-at 2026-11-19T00:00:00Z --commit q3-ch7-2026-11 --json \
  > testdata/reports/q3-ch7/assembly-report.json
$BIN --data-dir "$RIICHI_DATA_DIR" pack publish \
  --packs replay.ch7-riichi-dama.2026-11,replay.ch8-defense.2026-11,replay.ch8-defense-multi-threat.2026-11 \
  --updated-at 2026-11-19T00:00:00Z --json \
  > testdata/reports/q3-ch7/publish-report.json
node scripts/check-pack-hosting.mjs
node scripts/check-ch8-pack.mjs --allow-no-variants
node scripts/check-ch8-pack.mjs --pack replay.ch8-defense-multi-threat.2026-11 --allow-no-variants
node scripts/check-ch8-pack.mjs --chapter ch7 --allow-no-variants
node scripts/replay-coverage-report.mjs --json > testdata/reports/q3-ch7/coverage.json
```

The publish command lists all three packs on purpose: `--packs` replaces the
hosted set with exactly the ids given, so omitting the ch. 8 packs would prune
their bodies.

## Selection

Machine-readable report:
[`testdata/reports/q3-ch7/selection-report.json`](../testdata/reports/q3-ch7/selection-report.json).

- 14 workers, 63 min 58 s wall (three passes over 1,542 replays).
- Funnel: 1,542 parsed/valid → 787,052 decisions → 646,776 trigger hits →
  113,094 book matches → **7,295 gate passes** → 150 held out → **2,901
  selected**.
- 6,281 selection attempts were skipped by `--max-per-replay 2`; 201 selected
  scenarios were beyond a section/kind/turn cap after the remaining pool filled
  (recorded as `cap_relaxed`), and 850 slots came from the relaxed fill.
- Section mix: ch7.1 1,452, ch7.2 153, ch7.3 1,296. All candidates are
  `self_turn` discards; the kind cap was not binding.
- Corpus mix (no `--corpus-cap`, the family cap is not a crowding-out rule for
  this pack): `mortal_mirror` 1,410, `mortal_sampling_sweep` 1,409,
  `akochan_vs_mortal` 30, `heterogeneous_table` 27, `akochan_tactics` 25.
- The scope rejected 58,848 out-of-scope and 46,951 contested labels, exactly
  as the stable-book filter requires.

The thinnest lesson, `dama_improving_hand`, still supplied 60 selected bases
(137 stable labels in the corpus); the section/kind caps did not starve it
because ch7.3's cap is 1,500 and the lesson is inside that bucket.

**Held-out QA:** 150 items, disjoint from the pack, deterministic under
`--seed q3-ch7-2026-11`, all stable book labels. The held-out set is not part
of the pack and is not dispositioned.

## Review

- **Mechanical review** (`scripts/review-q2-queue.py --chapter ch7`): 2,901
  items, **2,901 accepted, 0 rejected**, no invalid reports. The ch. 7 rules
  reject out-of-scope sections/lessons, non-book or contested labels,
  report/lesson mismatches, illegal answers, duplicate exact/visible states and
  dirty walks; unlike ch. 8 they do not reject ready hands, because a
  riichi/dama decision is tenpai by definition.
- **Bulk dispositions** (`review --verdicts`): 2,901 accepted, 0 rejected,
  0 pending, 2,901 valid reports.
- **Sampled content review:** 304 rows
  ([`review-sample.md`](../testdata/reports/q3-ch7/review-sample.md),
  [`review-sample.json`](../testdata/reports/q3-ch7/review-sample.json)) —
  per-lesson guarantees (30 each), per-family guarantees (20 each) and **all 60
  `dama_improving_hand` bases**. The user sign-off is recorded below when
  received.

## Pack

| Pack measurement | Value |
| --- | ---: |
| Scenarios | 2,846 |
| Reviewed bases | 2,846 |
| Variants | 0 (disabled) |
| Distinct lessons | 6 (`riichi_judgement`, `chiitoitsu_riichi_vs_dama`, `dama_bad_wait`, `dama_genbutsu_wait`, `dama_expensive_hand`, `dama_improving_hand`) |
| Book sections | ch7.1, ch7.2, ch7.3 |
| Body bytes | 2,176,750 |
| Uncompressed body | 21,813,400 |
| Manifest bytes | 2,533 (three packs) |
| Distinct source replays | 1,509 |
| Adjacent same-replay bases | 0 |
| Actor hands | 2,846 unique |
| Licence | CC-BY-4.0 (data) |
| `data_commercial_use` | false (Akochan) |
| `requires_model` | false (all book answers) |
| Pack SHA-256 | `08cbeacac15ff8704d40846a92f40a56d06df413fc4442084863b996a92b692d` |
| Audit (hosted manifest) | clean, 0 findings |
| Load/decode (Node, this box) | 33.9 ms gunzip + 119.1 ms JSON parse |

Assembly dropped 66 duplicate actor hands (2,901 → 2,846) and 5,473 variant
rows; the transform stage persisted 5,592 gated variants for the
label-preservation report, none ship. The assembly report accounts for every
row.

The pack is 2.18 MB. The hosted set is now three bodies: 2,176,750 + 2,260,809
+ 591,096 bytes + a 2,533-byte manifest = **5,031,188 bytes**, inside the 50 MB
same-origin budget and still small enough that only the manifest is fetched at
startup.

## Checks

| Gate | Result |
| --- | --- |
| Audit (source export) | 0 errors (2 `lesson_counts_missing` warnings on the legacy ch8 source entries; republished manifest derives them) |
| Audit (hosted manifest) | clean, 0 findings |
| Hosting (source) | 113/113 |
| Hosting (dist after build) | 113/113 |
| ch7 content (`--chapter ch7`) | 27/27, source and dist |
| ch8 content | 27/27 for each ch8 pack, source and dist |
| Serving | 20/20 (all three bodies: `application/gzip`, no `Content-Encoding`, exact bytes/SHA-256) |
| Frontend | 783 passed, 1 skipped; build pass; lint pass |
| Q1 end-to-end | PASS |
| Q1 loader smoke (ch7 body) | pass: manifest → content-addressed body → hash/byte check → gzip → schema |
| Old pack bodies | unchanged (`6ae2c924…` and `15fe519c…`) |

## Coverage

[`coverage.json`](../testdata/reports/q3-ch7/coverage.json) names every lesson
and its floor decision. All six ch. 7 lessons are now **replay-default**; the
five ch. 8 lessons at or above 40 keep their existing defaults, and the three
thin ch. 8 lessons (`defense_stuck_heuristic` 32, `kabe_one_chance` 17,
`kabe_double_one_chance` 13) stay opt-in rows under their pack.

## User sign-off

The 304-row sample and the published pack were presented on 2026-11-19.
**User sign-off: approved** ("1") for the 2,846-base, 0-variant pack and the
sampled content review.

## Related links

- [`replay-first-rollout.md`](replay-first-rollout.md) — Q3 task, coverage floor,
  pack granularity and the source-model contract.
- [`replay-implementation-plan.md`](replay-implementation-plan.md) §11 — the
  replay-first rollout constraints.
- [`replay-miner-operations.md`](replay-miner-operations.md) — selection scope,
  review, assembly, manifest `lesson_counts` and the chapter-scoped mechanical
  rules.
- [`testdata/reports/b4-classifiers/label-yield-report.md`](../testdata/reports/b4-classifiers/label-yield-report.md)
  — the classifier-v3 yield this pack consumes.
