# Q7 — ch. 8 completion replay pack

Implementation unit Q7 of the replay-first rollout
([`replay-first-rollout.md`](replay-first-rollout.md) → *Wave 3*). This is the
seventh curated pack (after ch. 8 defense, ch. 8 multi-threat, ch. 7
riichi/dama, ch. 5 value, ch. 9 seating/calls and ch. 3/4 shapes): the **thin and
missing ch. 8 lessons** mined from the same 1,542-game AI self-play corpus.

**Shipped artifact:** `frontend/public/scenarios/`, pack
`replay.ch8-completion.2026-11`, **386 reviewed bases**, 0 variants,
**330,933 bytes**, six lessons. Four of them clear the 40-base coverage floor
and become **replay-default**: `kabe_no_chance` 129,
`defense_stuck_heuristic` 183, `kabe_one_chance` 56 and
`kabe_double_one_chance` 49 (the last two summed with the older ch. 8 defense
pack's rows). `kabe_suji_defense` 27 and `open_hand_defense` 4 ship as **opt-in
rows below the floor**; `suji_trap_riichi` stays generated-only because the
corpus holds no stable label for it.

## Why the lessons are these, and what had to change

The ch8 section already had two shipped packs, but three of its lessons sat
below the floor and four had no row at all. Q7's measured supply on classifier
v3 (B4's label pass) was:

| Section | Lesson | Stable labels (v3) | What that meant |
| --- | --- | ---: | --- |
| ch8.2 | `kabe_suji_defense` | 32 | thin, no row |
| ch8.2 | `kabe_one_chance` | 60 | thin row, 17 shipped (pack-size share) |
| ch8.2 | `kabe_double_one_chance` | 55 | thin row, 13 shipped (pack-size share) |
| ch8.3 | `defense_stuck_heuristic` | 211 | thin row, 32 shipped (pack-size share) |
| ch8.4 | `open_hand_defense` | 4 | no row (B4.4, far below floor) |
| ch8.2 | `suji_trap_riichi` | 0 | no row (constructed shape) |
| ch8.2 | `kabe_no_chance` | **0** | no row — **unreachable** (see below) |

Two different causes, two different fixes:

1. **Three thin rows were a pack-size share, not a supply limit.** The 2,211-base
   ch8 defense pack was spread across seven lessons under a 2,250-scenario cap,
   so `defense_stuck_heuristic` shipped 32 of its 193 gate-passing bases and the
   two kabe lessons shipped 17 and 13 of theirs. A lesson-scoped selection (this
   pack) can ship the rest. No classifier or corpus change is involved.
2. **`kabe_no_chance` was unreachable, not rare.** Its recogniser matches a
   complete blockade (the `NoChance` mechanism at chart row `BBB`), and
   `suji_kabe_safety` accepts the same board and comes first in `CLASSIFIERS`, so
   every one of those states was attributed to the general ranking cell. The
   corpus already held 155 stable + 118 contested labels that belong to this
   lesson (measured by `261119-233553`'s C9 diagnosis in
   `riichiprac-corpus/docs/c9-below-floor-growth.md` §4). Q7 applies the
   attribution fix and pays the classifier bump (below); no new games are needed.

`suji_trap_riichi` remains generated-only: its recogniser needs the generator's
exact teaching comparison (two discards reaching the same wait where only one is
a suji of the declaration tile, a live 1–2 simple wait with two copies already
visible, and a contrasting plain discard). Random self-play produced zero labels
in 1,542 games; that is a constructed-shape limit, not a coverage one.

## The `kabe_no_chance` attribution fix (classifier v4)

- `src/classifier/mod.rs`: `KabeNoChance` now precedes `SujiKabeSafety` in
  `CLASSIFIERS`. Both name the same tile on a complete blockade, so **no answer
  changes**; only the attribution moves to the more specific lesson.
- `CLASSIFIER_VERSION` `3` → `4` (`src/miner/label/mod.rs`), because the version
  is part of the label cache key and an old label would otherwise keep the old
  attribution.
- One `label --trigger book` pass over all five scoped families at 14 workers
  re-labelled the corpus: 1,542 replays, 787,052 decisions, 113,094 book labels
  (66,143 stable), 111,391 forward passes in 81 min 12 s wall. That is slower
  than B4's 52 min because the `C9` corpus run shared the box; the worker count
  was still every core.
- New tests pin the attribution: `a_no_chance_board_is_attributed_to_kabe_no_chance`
  and `a_general_ranking_board_stays_suji_kabe_safety` in
  `src/classifier/tests.rs`.

Measured effect (stable labels, v3 → v4): `kabe_no_chance` `0 → 155`,
`suji_kabe_safety` `1,755 → 1,600` (both classifier cells read the same boards,
so the general ranking cell loses exactly what the specific cell gains; its
contested count moves `1,683 → 1,565` for the same reason). No other lesson
moved: every family's stable/contested totals are identical to B4's pass
(66,143 stable / 46,951 contested), so the bump changed attribution only.

## Lessons and coverage

| Section | Lesson | Stable labels (v4) | Selected | Shipped bases | Floor |
| --- | --- | ---: | ---: | ---: | --- |
| ch8.2 | `kabe_no_chance` | 155 | 131 | **129** | yes (129) |
| ch8.2 | `kabe_one_chance` | 60 | 39 | **39** | yes (39 + 17 = 56) |
| ch8.2 | `kabe_double_one_chance` | 55 | 37 | **36** | yes (36 + 13 = 49) |
| ch8.3 | `defense_stuck_heuristic` | 211 | 161 | **151** | yes (151 + 32 = 183) |
| ch8.2 | `kabe_suji_defense` | 32 | 28 | **27** | **no** (27; opt-in) |
| ch8.4 | `open_hand_defense` | 4 | 4 | **4** | **no** (4; opt-in) |
| ch8.2 | `suji_trap_riichi` | 0 | — | — | **no** (0 labels; constructed shape) |
| **Total** | | **517** | **400** | **386** | |

The parenthesised floor column is what the app reads: the per-lesson count is
summed across every pack that carries the lesson, so the three topped-up rows
clear the 40-base floor with the older ch. 8 defense pack's bases. 14 of the
400 reviewed bases lost to the actor-hand dedupe at assembly
(`defense_stuck_heuristic` 10, `kabe_no_chance` 2,
`kabe_double_one_chance` 1, `kabe_suji_defense` 1), so the shipped rows are
386.

## Pipeline

```bash
export RIICHI_DATA_DIR="$HOME/riichiprac-data/q2-ch8-defense-2026-11"
BIN=target/release/mine_replays
cargo build --release --features miner --bin mine_replays

# 1. The attribution fix + classifier bump, then one book-label pass over every
#    scoped family (weights: AGENTS.md §5c).
for fam in akochan_tactics akochan_vs_mortal heterogeneous_table \
           mortal_mirror mortal_sampling_sweep; do
  $BIN --data-dir "$RIICHI_DATA_DIR" label \
    --weights frontend/public/models/mortal_298k.safetensors \
    --family "$fam" --workers 0 --trigger book --progress --json \
    > testdata/reports/q7-ch8/label-$fam.json
done
scripts/label-yield-report.py --db "$RIICHI_DATA_DIR/db/miner.sqlite" \
  --classifier-version 4 --out testdata/reports/q7-ch8/label-yield.json

# 2. Select the six below-floor / missing ch. 8 lessons. `suji_trap_riichi` has
#    no supply and is deliberately absent from the scope.
$BIN --data-dir "$RIICHI_DATA_DIR" select \
  --pack-id replay.ch8-completion.2026-11 \
  --size 400 --held-out-share 0.03 --seed q7-ch8-2026-11 \
  --section ch8 \
  --lesson defense_stuck_heuristic,kabe_one_chance,kabe_double_one_chance,kabe_no_chance,kabe_suji_defense,open_hand_defense \
  --stable-book-only \
  --corpus-family mortal_mirror,mortal_sampling_sweep,akochan_tactics,akochan_vs_mortal,heterogeneous_table \
  --max-per-replay 2 --extracted-only --workers 0 --progress \
  --max-section-share 0.80 --max-kind-share 0.95 --max-turn-share 0.95 \
  --json > testdata/reports/q7-ch8/selection-report.json

# 3. Mechanical review with the extended ch8 scope, then bulk dispositions.
python3 scripts/review-q2-queue.py \
  "$RIICHI_DATA_DIR/reviews/replay.ch8-completion.2026-11/review-queue.jsonl" \
  --chapter ch8 --verdicts-out testdata/reports/q7-ch8/verdicts.json \
  > testdata/reports/q7-ch8/mechanical-review.json
$BIN --data-dir "$RIICHI_DATA_DIR" review --pack replay.ch8-completion.2026-11 \
  --verdicts testdata/reports/q7-ch8/verdicts.json --json \
  > testdata/reports/q7-ch8/review-report.json

# 4. Sampled content sheet for the human sign-off.
python3 scripts/sample-review-sheet.py \
  "$RIICHI_DATA_DIR/reviews/replay.ch8-completion.2026-11/review-queue.jsonl" \
  --sample 260 --per-lesson 30 --per-family 20 --include-all-below 120 \
  --seed q7-ch8-2026-11 --out-json testdata/reports/q7-ch8/review-sample.json \
  > testdata/reports/q7-ch8/review-sample.md

# 5. Persist the reviewed bases (variants stay disabled by product decision).
$BIN --data-dir "$RIICHI_DATA_DIR" transform \
  --pack-id replay.ch8-completion.2026-11 --variants 1 \
  --seed q7-ch8-2026-11 --generated-at 2026-11-20T00:00:00Z \
  --workers 0 --progress --json \
  > testdata/reports/q7-ch8/variant-report-disabled.json

# 6. Assemble the reviewed bases only, drop duplicate actor hands, audit and
#    publish all seven hosted packs.
$BIN --data-dir "$RIICHI_DATA_DIR" pack assemble \
  --pack replay.ch8-completion.2026-11 \
  --queue "$RIICHI_DATA_DIR/reviews/replay.ch8-completion.2026-11/review-queue.jsonl" \
  --no-variants --unique-hands --min-bases-per-lesson 3 --max-scenarios 2000 \
  --licence CC-BY-4.0 --attribution "Ch.8 completion pack. <corpus attribution, see the pack>" \
  --generated-at 2026-11-20T00:00:00Z --commit q7-ch8-2026-11 --json \
  > testdata/reports/q7-ch8/assembly-report.json
$BIN --data-dir "$RIICHI_DATA_DIR" audit --json \
  > testdata/reports/q7-ch8/audit-report.json
$BIN --data-dir "$RIICHI_DATA_DIR" pack publish \
  --packs replay.ch8-completion.2026-11,replay.ch34-shapes.2026-11,replay.ch9-seating-calls.2026-11,replay.ch5-values.2026-11,replay.ch7-riichi-dama.2026-11,replay.ch8-defense.2026-11,replay.ch8-defense-multi-threat.2026-11 \
  --updated-at 2026-11-20T00:00:00Z --json \
  > testdata/reports/q7-ch8/publish-report.json
node scripts/check-pack-hosting.mjs
node scripts/check-ch8-pack.mjs --allow-no-variants
node scripts/check-ch8-pack.mjs --pack replay.ch8-completion.2026-11 --allow-no-variants
node scripts/check-ch8-pack.mjs --pack replay.ch8-defense-multi-threat.2026-11 --allow-no-variants
node scripts/check-ch8-pack.mjs --chapter ch7 --allow-no-variants
node scripts/check-ch8-pack.mjs --chapter ch5 --allow-no-variants
node scripts/check-ch8-pack.mjs --chapter ch9 --allow-no-variants
node scripts/check-ch8-pack.mjs --chapter ch34 --allow-no-variants
node scripts/replay-coverage-report.mjs --json > testdata/reports/q7-ch8/coverage.json
```

The publish command lists all seven packs on purpose: `--packs` replaces the
hosted set with exactly the ids given, so omitting an older pack would prune its
body. The six pre-existing bodies keep their content addresses.

## Selection

Machine-readable report:
[`testdata/reports/q7-ch8/selection-report.json`](testdata/reports/q7-ch8/selection-report.json).

- 14 workers, 71 min 18 s wall (the `C9` corpus run shared the box for part of
  it).
- Funnel: 1,542 parsed/valid → 787,052 decisions → 646,776 trigger hits →
  113,094 book labels → 454 gate passes → 12 held out → **400 selected** (the
  `--size 400` cap bound; 42 eligible candidates did not fit).
- Rejections: 673,958 `no_label`, 65,626 `out_of_scope`, 46,951
  `scope_not_stable_book`, and **63 `already_packed`** — the bases the shipped
  ch. 8 defense pack already carries (`defense_stuck_heuristic` 32,
  `kabe_one_chance` 17, `kabe_double_one_chance` 13, `kabe_suji_defense` 1).
  That is Q7's cross-pack rule doing its job: the new pack ships new positions,
  so the manifest sum stays the real reviewed-base count
  ([`replay-miner-operations.md`](replay-miner-operations.md) §"Lesson scope").
- Section mix: ch8.2 235, ch8.3 161, ch8.4 4 (each section's cap was 320, none
  reached). Decision kind: 400 `self_turn`; the kind cap (380) was relaxed by
  20 because these lessons have no other decision kind — the pack fills rather
  than ships short.
- Turn mix: early 58, mid 225, late 117. 38 selection attempts were skipped by
  `--max-per-replay 2`; 141 slots came from the relaxed fill and `cap_relaxed`
  was 20. Dedupe dropped 1 exact state.
- Corpus mix: `mortal_sampling_sweep` 198, `mortal_mirror` 191,
  `akochan_tactics` 6, `heterogeneous_table` 3, `akochan_vs_mortal` 2.
- Selection family mix (after assembly): book 192, coverage 90, table_read 44,
  placement 30, close_call 29, mistake 1.

**Held-out QA:** 12 items, disjoint from the pack, deterministic under
`--seed q7-ch8-2026-11` (5 `kabe_no_chance`, 4 `defense_stuck_heuristic`,
2 `kabe_double_one_chance`, 1 `kabe_suji_defense`), all stable book labels.
The held-out set is not part of the pack and is not dispositioned.

## Review

- **Mechanical review** (`scripts/review-q2-queue.py --chapter ch8`): 400
  items, **400 accepted, 0 rejected**, no invalid reports, no duplicate
  exact/visible states, no dirty walks. The ch8 scope now names
  `open_hand_defense` and `suji_trap_riichi`; its ready-hand rule applies to
  every ch8 lesson except `suji_trap_riichi`, whose decision is a riichi/dama
  question (tenpai by definition). None of the six shipped lessons here is a
  declaration, so every queued row was a fold or a slow-hand read.
- **Bulk dispositions** (`review --verdicts`): 400 accepted, 0 rejected,
  0 pending, 400 valid reports.
- **Sampled content review:** 260 rows
  ([`review-sample.md`](testdata/reports/q7-ch8/review-sample.md),
  [`review-sample.json`](testdata/reports/q7-ch8/review-sample.json)) —
  per-lesson guarantees (30 each), per-family guarantees (20 each), and **all
  bases of the four lessons under 120**: 37 `kabe_double_one_chance`,
  39 `kabe_one_chance`, 28 `kabe_suji_defense` and 4 `open_hand_defense`, plus
  77 `defense_stuck_heuristic` and 75 `kabe_no_chance` rows. The user sign-off
  is recorded below when received.

## Pack

| Pack measurement | Value |
| --- | ---: |
| Scenarios | 386 |
| Reviewed bases | 386 |
| Variants | 0 (disabled) |
| Distinct lessons | 6 (`defense_stuck_heuristic` 151, `kabe_no_chance` 129, `kabe_one_chance` 39, `kabe_double_one_chance` 36, `kabe_suji_defense` 27, `open_hand_defense` 4) |
| Book sections | ch8.2, ch8.3, ch8.4 |
| Body bytes | 330,933 |
| Uncompressed body | 3,498,285 |
| Manifest bytes | 5,560 (seven packs) |
| Distinct source replays | 326 |
| Adjacent same-replay bases | 0 |
| Actor hands | 386 unique |
| Largest hand share | 0.26 % |
| Licence | CC-BY-4.0 (data) |
| `data_commercial_use` | false (Akochan) |
| `requires_model` | false (all book answers) |
| Pack SHA-256 | `5d5ba61a45383cf03a4f08ea8c1931f01ea5ea6fed8d2345d2e3864330afd184` |
| Audit (hosted manifest) | clean, 0 findings |
| Load/decode (Node, this box) | 26.1 ms gunzip + 78.6 ms JSON parse |

Assembly read 1,373 rows (400 bases + 973 gated variants). It shipped 386 bases:
14 bases lost to the actor-hand dedupe (`--unique-hands`) together with their
176 variant rows, 35 more variants lost their base to that dedupe, and the
remaining 762 variant rows were disabled by the product decision. The transform
stage preserved 1,349 variants across five transforms and staged 973 (one per
base); none ship.

The hosted set is now seven bodies: 330,933 + 724,376 + 363,061 + 1,176,300 +
2,176,750 + 2,260,809 + 591,096 bytes + a 5,560-byte manifest =
**7,623,325 body bytes**, inside the 50 MB same-origin budget and still small
enough that only the manifest is fetched at startup.

A lesson can now be carried by two packs (`defense_stuck_heuristic`,
`kabe_one_chance` and `kabe_double_one_chance` are in both the ch. 8 defense
pack and this one). The picker lists each pack's row, the manifest's
`lesson_counts` are summed per lesson, and the pack with the most bases supplies
the default row — so the default deal comes from this pack while the older pack
stays one row away.

## Checks

| Gate | Result |
| --- | --- |
| Audit (source export) | 0 errors; 2 pre-existing `lesson_counts_missing` warnings on the two ch8 packs assembled before RF1 added the field (the hosted manifest carries their counts) |
| Audit (hosted manifest, seven packs) | clean, 0 findings |
| Hosting (source) | 249/249 |
| Hosting (dist after build) | 249/249 |
| ch8 content (`replay.ch8-defense.2026-11`) | 27/27, source and dist |
| ch8 completion content | 27/27, source and dist |
| ch8 multi-threat content | 27/27, source and dist |
| ch7/ch5/ch9/ch34 content | 27/27 for each pack, source and dist |
| Serving | 44/44 (all seven bodies: `application/gzip`, no `Content-Encoding`, exact bytes/SHA-256) |
| Frontend | 1,541 passed, 1 skipped; build pass; lint pass |
| Rust | `cargo fmt --check`, `cargo clippy --all-targets --features miner -- -D warnings`, `cargo test --lib` 776 passed, `cargo test --features miner --lib` 1,176 passed, `cargo check --target wasm32-unknown-unknown` |
| Q1 end-to-end | PASS |
| Old pack bodies | unchanged (`1e7f3266ea8f…`, `5d0b01e6badb…`, `08cbeacac15f…`, `6ae2c924e80c…`, `15fe519c65df…`, `3deda6140a90…`) |

## Coverage

[`coverage.json`](testdata/reports/q7-ch8/coverage.json) names every hosted
lesson and its floor decision. The hosted set now covers **28 lesson ids across
seven packs, 26 of them replay-default, 9,328 reviewed bases** (RF5 measured
22/25 and 8,942). Q7 flipped four lessons to replay-default:

| Lesson | Bases | Default pack |
| --- | ---: | --- |
| `defense_stuck_heuristic` | 183 (151 + 32) | `replay.ch8-completion.2026-11` |
| `kabe_no_chance` | 129 | `replay.ch8-completion.2026-11` |
| `kabe_one_chance` | 56 (39 + 17) | `replay.ch8-completion.2026-11` |
| `kabe_double_one_chance` | 49 (36 + 13) | `replay.ch8-completion.2026-11` |

The two new opt-in rows are `kabe_suji_defense` 27 and `open_hand_defense` 4;
`suji_trap_riichi` has no row. No previously-default lesson regressed: the older
ch. 8 defense pack still ships its own bases, and every other pack body kept its
content address.

## What remains generated-only

- **`suji_trap_riichi`** — the recogniser needs the generator's exact teaching
  comparison (two discards that reach the same wait where only one is a suji of
  the declaration tile, a live 1–2 simple wait with two copies already visible,
  and a contrasting plain discard). The 1,542-game corpus produced **zero**
  labels for it. This is a constructed-shape limit, not a volume problem: more
  self-play will not produce it, and the lesson stays generated-default until a
  different mining strategy (or a corpus of human games) exists.
- **`kabe_suji_defense` (27) and `open_hand_defense` (4)** ship as opt-in replay
  rows below the 40-base floor, so both keep the generated default. At C9's
  measured `kabe_suji_defense` yield (2.07 stable labels per 100 games), roughly
  700–800 more games would add the ~13 shipped bases it needs; the C9 batch's
  1,000 new Mortal games are the next input. `open_hand_defense` is
  agreement-limited as well as rare (4 stable / 15 contested per 1,542 games),
  so it needs both corpus growth and a cell review, not just volume.

## User sign-off

The 260-row sample ([`review-sample.md`](testdata/reports/q7-ch8/review-sample.md))
and the published pack were presented on 2026-11-21:
`cd frontend && npm run dev` → `http://localhost:5173/?renderer=3d`, then pick
`kabe_no_chance` under **Replay**. Sign-off: **pending** (see the task
hand-off; the module-level numbers above are the scripted evidence, the sample
sheet is the human content review).

## Related links

- [`replay-first-rollout.md`](replay-first-rollout.md) — Q7 task, coverage
  floor, pack granularity and the source-model contract.
- [`q6-ch34-shapes-pack.md`](q6-ch34-shapes-pack.md) — the pipeline shape this
  pack follows.
- [`replay-miner-operations.md`](replay-miner-operations.md) — selection scope,
  the cross-pack `already_packed` rule, review, assembly and manifest
  `lesson_counts`.
- [`testdata/reports/b4-classifiers/label-yield-report.md`](testdata/reports/b4-classifiers/label-yield-report.md)
  — the classifier-v3 yield this pack starts from.
