# S1 trigger corpus sample report

Implementation unit S1 (`replay-implementation-plan.md` §5.3, phase 5) adds the
cheap candidate triggers and family filters that run before the Mortal pass.
This page records the acceptance sample, the fixture precision/recall, and how to
reproduce both. The raw replay logs and the operational SQLite DB are outside
git; the machine-readable report is committed beside this file at
[`testdata/reports/s1-trigger-sample-mortal-mirror-2.json`](testdata/reports/s1-trigger-sample-mortal-mirror-2.json).

## Corpus sample

- Replays: two `mortal_mirror` games under `$RIICHI_DATA_DIR/replays/mortal_mirror/`
  from the C8 smoke corpus.
- Labels: generated once by the L1/L2 shard runner and read from the
  `model_labels` cache; the trigger pass never runs the model.
  `mortal_298k.safetensors`, SHA-256 `afb911473ac8…`, classifier version `1`.
- Report: generated `20261117-061344`, `riichiprac.candidate-trigger` v1.
- 2 replays walked, 0 failed; 1,210 decisions reconstructed, 0 dropped; 944
  decisions carried at least one trigger; 1,210 labelled, 0 unlabelled.

| Trigger | Fired | Measured | Target | Precision | Recall | Evidence |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `book` | 176 | 176 | 177 | 1.00 | 0.99 | book label (settled, else model-free) |
| `defensive_riichi` | 177 | 177 | 166 | 0.63 | 0.67 | ch.7/ch.8 book label |
| `offensive_architecture` | 23 | 23 | 7 | 0.00 | 0.00 | ch.4/ch.5 book label; non-book speed/value not labelled |
| `call_kan` | 57 | 57 | 1 | 0.02 | 1.00 | ch.9 book label; non-book calls not labelled |
| `score_placement` | 899 | 899 | 1,210 | 1.00 | 0.74 | any shippable label |
| `close_call` | 121 | 121 | 121 | 1.00 | 1.00 | label-derived (exact by construction) |
| `blunder` | 10 | 10 | 10 | 1.00 | 1.00 | label-derived (exact by construction) |

Candidate families (a decision can feed several):

| Family | Candidates |
| --- | ---: |
| `book` | 177 |
| `contested` | 75 |
| `mortal_best` | 1,033 |
| `mistake` | 10 |
| `close_call` | 121 |
| `speed_value` | 23 |
| `coverage` | 177 |
| `table_read` | 177 |
| `placement` | 899 |
| `multi_step` | 0 |

### How to read the numbers

- **`book`** is near-exact because the model-free classifier is its own evidence;
  the one missing target is a book state the model-free path leaves as a conflict
  and the cached L2 label settles with Mortal.
- **`defensive_riichi`** is a recall filter with a measurable cost: 0.67 recall
  is the price of requiring an opponent Riichi, a 0–2-shanten actor, a visible
  genbutsu/suji and a tenpai threat in the record. Precision 0.63 means most of
  its fires are not ch.7/ch.8 book cells, which is expected — the family it feeds
  is table reading, not only the book.
- **`offensive_architecture`** and **`call_kan`** are non-book families judged
  here against the nearest book evidence. Their low book-label precision is not
  a failure of the trigger: the speed/value family has no book label yet, and
  most calls are Mortal-only candidates. S2 quotas and S3 labels are the right
  place to rank them.
- **`score_placement`** is deliberately broad: 0.74 recall at 1.00 precision
  says almost every labelled decision in this sample also sits in a placement
  context (honba, Riichi sticks or a large spread). It is a quota family, not a
  drill by itself.
- **`close_call`** and **`blunder`** read the cached label and the L2 percentile
  cuts. When the sample has no cuts they stay silent; they never invent an
  absolute threshold, and their precision/recall are exact by construction.

## Fixture precision/recall

`src/miner/trigger/tests.rs` pins a positive and one or more near-miss negatives
for every trigger:

- a quiet board fires nothing;
- a Riichi threat with no safe tile, an actor too far from tenpai, and a threat
  that is not tenpai all decline `defensive_riichi`;
- a 1-shanten hand with no acceptance/value divergence and the same hand outside
  turns 5–12 both decline `offensive_architecture`;
- a Pon/Chi/Kan offer fires `call_kan`, a plain self turn does not;
- all-last, honba, Riichi sticks and a large score spread each fire
  `score_placement`, a neutral East-1 board does not;
- a book lesson fires `book`, the quiet hand does not;
- label gaps at/inside and outside the close and confidence cuts fire and
  decline `close_call` / `blunder`.

The constrained fixture cases give precision 1.00 and recall 1.00 for all seven
triggers. `cargo test --features miner --lib trigger::tests` runs them. The same
suite proves the trigger filter rejects label-derived triggers, that a report
round-trips through its JSON, and that the reason is written onto an existing
`decisions` row (and cleared by a later report with no hits).

## Reproduce

```bash
# 1. Label a shard once (the slow, model stage).
cargo run --release --features miner --bin mine_replays -- \
  --data-dir "$RIICHI_DATA_DIR" label \
  --weights frontend/public/models/mortal_298k.safetensors \
  --family mortal_mirror --limit 2 --json

# 2. Report the cheap triggers; labels come from the cache, no forward pass.
cargo run --release --features miner --bin mine_replays -- \
  --data-dir "$RIICHI_DATA_DIR" triggers \
  --family mortal_mirror --limit 2 --json \
  > testdata/reports/s1-trigger-sample-mortal-mirror-2.json
```
