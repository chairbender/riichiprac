# S2 selection corpus sample report

Implementation unit S2 (`replay-implementation-plan.md` §5.3, phase 5) selects a
balanced, legal, non-duplicated candidate set from a replay shard. This page
records the acceptance sample, the fixture evidence and how to reproduce both.
The raw replay logs and the operational SQLite DB are outside git; the
machine-readable report is committed at
[`testdata/reports/s2-selection-sample.json`](testdata/reports/s2-selection-sample.json).
The review queue itself is **not** committed: it contains the answers the
reviewer must see, and P1b builds the trainee payload from the selected
scenarios, never from the queue.

## Corpus sample

- Replays: the same two `mortal_mirror` games as the S1 sample, under
  `$RIICHI_DATA_DIR/replays/mortal_mirror/`.
- Labels: read from the L1/L2 `model_labels` cache; selection never runs a
  forward pass. `mortal_298k.safetensors`, SHA-256 `afb911473ac8…`, classifier
  version `1`.
- Report: `riichiprac.selection-report` v1, generated `20261117-142651`.
- Pack: `s2-smoke`, 100 requested, 100 selected.

| Stage | Count |
| --- | ---: |
| Replay files | 2 |
| Replays walked / failed | 2 / 0 |
| Decisions reconstructed | 1,210 |
| Decisions with a trigger | 944 |
| Decisions with a book label | 177 |
| Decisions with a cached label | 1,210 |
| Candidates that passed gates 1–6 and 8 | 1,015 |
| Held out for QA | 10 (10 requested) |
| Selected | 100 |
| Packed | 0 (P1b owns the pack) |

The funnel is `raw=2 → generated=0 → parsed=2 → games_valid=2 → decisions=1210
→ trigger=944 → reconstructed=1210 → classified=177 → labelled=1210 → valid=1015
→ held_out=10 → selected=100 → packed=0`. `generated` is always 0 for a
selection run (it consumes an existing corpus) and `packed` is 0 until P1b.
Gates run after labelling because the confidence gate reads the label, so
`valid` follows `labelled` rather than preceding it.

## Hard gates

| Gate | First failures | Meaning |
| --- | ---: | --- |
| `reachable` | 0 | the walker already dropped unreachable decisions |
| `answer_defined` | 3 | three unresolved book conflicts |
| `answer_legal` | 0 | every accepted answer is legal on its table |
| `visible_information` | 0 | every answer survives removing opponent concealed hands |
| `label_confidence` | 192 | Mortal-only labels below the family confidence band and the probability fallback |
| `provenance` | 0 | both games are `ai_selfplay`, `CC-BY-4.0`, with validated provenance |
| `duplicate` | 0 | applied during the fill; the sample had no duplicate |
| `spoiler` | 0 | no accepted answer or wait tile in the pre-answer text |

The 192 `label_confidence` failures are the gate doing its job: a Mortal-only
drill needs a decisive label, and a 0.4 top probability is not a "best" answer.
Book and contested labels pass by definition because the rule is exact.

## Family quotas

| Family | Quota | Selected | Candidates | Shortfall |
| --- | ---: | ---: | ---: | --- |
| `book` | 30 | 31 | 174 | — |
| `contested` | 5 | 5 | 74 | — |
| `mortal_best` | 10 | 10 | 831 | — |
| `mistake` | 10 | 9 | 9 | `shared_with_other_families` |
| `close_call` | 10 | 10 | 38 | — |
| `speed_value` | 8 | 8 | 22 | — |
| `coverage` | 15 | 15 | 174 | — |
| `table_read` | 7 | 7 | 165 | — |
| `placement` | 5 | 5 | 733 | — |
| `multi_step` | 0 | 0 | 0 | reserved for the product stage |

No family exceeds 31 % of the pack and the largest single family is `book`, the
family the app is built around. Every family met its quota except `mistake`,
which has only nine candidates in this shard and reports
`shared_with_other_families`; nothing was substituted. `book` is one over its
quota because the relaxed fill repaired the under-quota families and then took
the best remaining candidate rather than ship a 99-scenario "100 pack". The
report records the relaxation as `cap_relaxed=26` and `relaxed_fill=26`: 26
slots could not be filled inside the section/kind caps, so the quota round's
leftover capacity was repaired before the pack filled. This is a crowding-out
guard, not a hard ceiling; a cap leaves a slot empty only when a better
candidate exists inside another cap.

## Diversity

Book sections (cap 20):

| Section | Selected | Candidates |
| --- | ---: | ---: |
| `ch3.2` | 1 | 1 |
| `ch3.3` | 1 | 2 |
| `ch5.3` | 2 | 3 |
| `ch5.4` | 2 | 4 |
| `ch7.1` | 2 | 16 |
| `ch7.3` | 15 | 26 |
| `ch8.1` | 3 | 12 |
| `ch8.2` | 16 | 50 |
| `ch8.3` | 23 | 59 |
| `ch9.3` | 1 | 1 |
| no book section | 34 | 831 |

`ch8.3` went three over its cap in the relaxed fill while the pack was still
short; the JSON records `relaxed: 3` on that row. The no-book section is
uncapped by design: a Mortal-only drill has no book section to spread across.

Decision kind (cap 60): `self_turn` 86 (60 + 26 relaxed), `call` 10,
`react_discard` 4. Turn bucket (cap 60): `late` 48, `mid` 37, `early` 15.
The 86/100 self-turn share is the measured mix of this two-game corpus; the
kind cap is a crowding-out guard, not a hard ceiling, so the remaining slots
went to self-turn candidates only after the other kinds were exhausted. A
larger, more varied corpus is the way to change that mix, not a hidden default.

## Dedupe and held-out QA

- Exact state-hash duplicates skipped: 0.
- Visible-table near duplicates skipped: 0.
- The 100 queue rows have 100 distinct decision ids, 100 distinct exact hashes
  and 100 distinct visible-info fingerprints.
- Held-out QA: 10 of 10 requested, disjoint from the queue, chosen
  deterministically by `sha256("riichiprac.held-out.v1:s2:<exact_hash>")` from
  `--seed s2` (the default salt).

The visible-info fingerprint hashes literal tile codes and excludes opponent
concealed hands. A suit-permuted variant therefore has a different fingerprint;
V1 records the explicit `variant_of` lineage and V2 caps variants per base.

## Review queue

The run writes `$RIICHI_DATA_DIR/reviews/s2-smoke/`:

- `review-queue.jsonl`: 100 `riichiprac.review-item` v1 lines, each embedding a
  complete `riichiprac.scenario-report` v2 for one candidate;
- `held-out.jsonl`: the 10 QA items in the same shape;
- `selection-report.json`: this report;
- `dispositions.jsonl`: created by the reviewer, append-only.

`mine_replays review --pack s2-smoke --dry-run` re-parses all 100 embedded
reports through the app's importer: **100 valid, 0 invalid, 100 pending,
0 warnings**. A disposition is recorded with `--accept`/`--reject`; the latest
verdict per item wins and the queue file is never rewritten.

**The human review is the remaining acceptance step.** S2 ships the queue, not
a verdict on whether a position teaches; that judgement is the reviewer's
(replay-strategy §7.5, AGENTS.md §6). P1b must refuse to pack a queue with a
pending item or an invalid embedded report.

## Fixture evidence

`src/miner/select/tests.rs` pins one positive and one near-miss negative per
gate:

- a valid Mortal candidate passes; a label-less decision, an unresolved label,
  an illegal answer, an unconfident Mortal label and each provenance leg fail
  closed;
- the visible-info gate's redaction removes opponent hands without changing the
  model-visible hash or the legal set;
- a pre-answer text containing the answer tile is a spoiler; the same text
  without a tile token is not;
- family quotas balance two families, a family with no candidates reports a
  shortfall, and a section cap stops one section filling the pack (then the
  relaxed fill repairs it and records the overage);
- exact and near duplicates are skipped once, not retried;
- the held-out split is deterministic and disjoint from the pack;
- novelty prefers the rare book section;
- a partial-share mix fills its open slots;
- the JSONL item round-trips through `parse_report`, dispositions are
  append-only with the latest verdict winning, and a dry run writes nothing;
- a full shard run writes the queue, the held-out set, the report and `LATEST`,
  then re-reads the queue through `review`.

`cargo test --features miner --lib select::` runs them.

## Reproduce

```bash
# 1. Label the shard once (the slow, model stage). The sample reuses the S1
#    labels; a fresh data root needs this step.
cargo run --release --features miner --bin mine_replays -- \
  --data-dir "$RIICHI_DATA_DIR" label \
  --weights frontend/public/models/mortal_298k.safetensors \
  --family mortal_mirror --limit 2 --json

# 2. Select the 100-scenario queue; labels come from the cache.
cargo run --release --features miner --bin mine_replays -- \
  --data-dir "$RIICHI_DATA_DIR" select \
  --family mortal_mirror --limit 2 --pack-id s2-smoke --size 100 --json \
  > testdata/reports/s2-selection-sample.json

# 3. Review the queue: list it, open one report, then disposition it.
cargo run --release --features miner --bin mine_replays -- \
  --data-dir "$RIICHI_DATA_DIR" review --pack s2-smoke --list --dry-run
cargo run --release --features miner --bin mine_replays -- \
  --data-dir "$RIICHI_DATA_DIR" review --pack s2-smoke --show s2-smoke-001
cargo run --release --features miner --bin mine_replays -- \
  --data-dir "$RIICHI_DATA_DIR" review --pack s2-smoke \
  --accept s2-smoke-001 --note "clear ch.7 rod"
```

The reviewed queue and the report are working data under
`$RIICHI_DATA_DIR/reviews/`; only the aggregate report above belongs in git.
