# Reviewing 1k–2k scenario candidates

How a human reviews a large replay-mined pack before it ships, and what the
reviewer is actually judging. Companion to
[`replay-miner-operations.md`](replay-miner-operations.md) §"Review queue" /
§"Bulk review and the sampled flow (Q2r2)" and the pack notes in
[`q2-scale-up-1000.md`](q2-scale-up-1000.md) and
[`q2-scale-up-2000.md`](q2-scale-up-2000.md).

The review step exists because the labeler and the interestingness score cannot
tell whether a position **teaches**. They can only tell whether a book rule
applies and whether the answer grades correctly. A human still has to look at
enough positions to trust the set.

## The flow at a glance

```
select ──► review-queue.jsonl
              │
              ├─ mechanical pass (scripts/review-q2-queue.py --verdicts-out)
              │     └─ bulk dispositions: mine_replays review --verdicts FILE
              │
              ├─ human surface (CLI filters / browser view)
              │     └─ accept/reject ──► dispositions.jsonl (append-only)
              │
              └─ deterministic sampled sheet (scripts/sample-review-sheet.py)
                    └─ the evidence that the remaining positions teach
```

P1b still refuses to assemble a pack until **every** queue item has a
disposition, and the mechanical pass is still a gate rather than a judgement.
The tooling below makes that gate practical above ~1,000 candidates; it does
not relax it.

Build the miner once and keep its path in `$BIN` for the commands below:

```bash
cargo build --release --features miner --bin mine_replays
BIN=target/release/mine_replays
```

### 1. Mechanical pre-review (whole queue)

```bash
python3 scripts/review-q2-queue.py \
  "$RIICHI_DATA_DIR/reviews/replay.ch8-defense.2026-11/review-queue.jsonl" \
  --verdicts-out /tmp/opencode/mechanical-verdicts.json

"$BIN" --data-dir "$RIICHI_DATA_DIR" review \
  --pack replay.ch8-defense.2026-11 --verdicts /tmp/opencode/mechanical-verdicts.json
```

The script rejects out-of-scope sections/lessons, non-book or contested labels,
report/lesson mismatches, illegal answers, ready hands, duplicate exact/visible
states and dirty walks. Everything it accepts is a *candidate*: the human still
has to sample it.

### 2. Work the queue

The CLI is the batch surface. Every flag composes with the existing
`--accept`/`--reject`/`--verdicts`/`--show`/`--list`/`--json`:

```bash
# Progress over the whole queue, whatever filter is on screen.
$BIN review --pack replay.ch8-defense.2026-11 --list --limit 20

# One lesson, still pending, in queue order.
$BIN review --pack replay.ch8-defense.2026-11 \
  --lesson kabe_one_chance --status pending --list

# A section prefix and a source family, with the report of one row.
$BIN review --pack replay.ch8-defense.2026-11 \
  --section ch8.2 --family akochan_tactics --list
$BIN review --pack replay.ch8-defense.2026-11 --show replay.ch8-defense.2026-11-0042

# End the lesson in one scoped pass. A bulk verdict needs a filter and a note.
$BIN review --pack replay.ch8-defense.2026-11 \
  --lesson kabe_one_chance --bulk-verdict accepted \
  --note "spot-check 2026-11-19: kabe reads match ch.8 safety order"

# Export the same selection as an editable verdicts document instead.
$BIN review --pack replay.ch8-defense.2026-11 --section ch8.3 --status pending \
  --bulk-verdict rejected --note "needs a closer read" \
  --verdicts-out /tmp/opencode/ch83-verdicts.json --dry-run
```

Filters:

| Flag | Matches |
| --- | --- |
| `--lesson` | exact lesson id (`fold_to_riichi`, `kabe_one_chance`, ...) |
| `--section` | dotted prefix (`ch8` includes `ch8.2`; `ch8.2` does not match `ch8.20`) |
| `--family` | source replay family (`mortal_mirror`, `akochan_tactics`, ...) |
| `--turn` | bucket (`early`, `mid`, `late`) or exact table turn (`--turn 9`) |
| `--status` | `pending`, `accepted`, `rejected` (latest disposition wins) |

`--list` prints one row per shown item: queue id, verdict, lesson, section, turn
bucket, hand, correct answer, source family. `--json` emits the full
`riichiprac.review-report`, including per-row `lesson`, `hand`, `answer`, `turn`
and `selection_reason`. `--show <id>` prints the embedded
`riichiprac.scenario-report` (table, graded answer, book rationale, Mortal
ranking) for a deeper read.

Every run reports session progress: `valid/invalid`, `pending/accepted/rejected`,
the dispositioned percentage, and how many rows the filters selected. Resume is
just the filter plus the sidecar: `--status pending` never re-shows work.

### 3. Deterministic sampling

`--sample N --seed TEXT` draws N of the filtered rows and `--limit` caps the
printed rows. The order is deterministic: every candidate is ranked by FNV-1a 64
over `seed\0queue_id` (then a SplitMix64 finalizer, so sequential `-001`, `-002`
ids do not make the "sample" the first N), the first N are taken, and the output
returns to queue order.

```bash
$BIN review --pack replay.ch8-defense.2026-11 --status pending \
  --sample 120 --seed q2-scale-2000 --list
```

The browser view implements the same rule with the same vector pins, so the CLI
and the page draw the **same** sample for the same seed. Re-running a session is
reproducible; changing the seed is the deliberate way to draw a different one.

The stratified review sheet is still the human-facing evidence artifact:

```bash
python3 scripts/sample-review-sheet.py \
  "$RIICHI_DATA_DIR/reviews/replay.ch8-defense.2026-11/review-queue.jsonl" \
  --sample 220 --per-lesson 25 --per-family 20 --include-all-below 30 \
  --seed q2-scale-2000 --out-json testdata/reports/q2-scale-2k/review-sample.json
```

It guarantees rare lessons in full and per-lesson/per-family coverage, then fills
with a seeded sample. The sheet and its JSON go in the run report.

### 4. Browser view (thin, optional)

`frontend/tools/review-queue/` is a static page: no build step, no server-side
data access, nothing uploaded. It reads the queue (and optionally an existing
`dispositions.jsonl`) through file inputs and shows the same filters, progress,
rows and embedded report as the CLI.

```bash
cd frontend/tools/review-queue
python3 -m http.server 8787
# open http://localhost:8787/ (add ?seed=q2-scale-2000 to match a CLI sample)
```

The broken-out modules are tested by the frontend suite:

```bash
cd frontend && npx vitest run tools/review-queue
```

What the page does:

* lists queue id / lesson / section / turn / source / hand / status — **never**
  the answer, so the list itself is spoiler-free;
* opening a row shows the embedded `riichiprac.scenario-report`: prompt, graded
  answer, table snapshot (hand, draw, shanten, dora, each player's river/melds),
  Mortal ranking, and provenance (decision/replay/event/selection reason, label
  kind and stability, report id and app build);
* `Accept`/`Reject` (buttons, or `a`/`r`; `j`/`k` move) append to a session log
  in `localStorage`, keyed by pack + first/last queue id, so a reload resumes;
* `Export verdicts JSON` writes the latest entry per item as a
  `riichiprac.review-verdicts` v1 document; `Export dispositions JSONL` writes
  the append-only lines. Either round-trips through the miner:

```bash
"$BIN" --data-dir "$RIICHI_DATA_DIR" review \
  --pack replay.ch8-defense.2026-11 \
  --verdicts ~/Downloads/review-verdicts.json
```

On-disk dispositions already imported into the page are shown as status but are
not re-exported: only the browser's new entries go into the document.

## What the human is judging

The mechanical pass proves an item is *eligible*. The human sample proves it
*teaches*. For each sampled position, look at the hand, the table and the
answer, and ask:

1. **Is the answer right by the book?** Read the rationale/citation in the
   report. The pack is stable-book only, so a defensible-but-different answer
   means the item belongs in a contested set, not this pack.
2. **Is the answer the only sensible one?** A fold where two tiles are equally
   safe, or a push where every discard is close, teaches by luck. Prefer the
   position where the book rule picks one tile for a stated reason.
3. **Can the reason be seen on the table?** The declared wait, the riichi
   discard, the visible suji/kabe tiles, the dora and the scores must support the
   answer. If it takes unseen information, reject it.
4. **Is it the lesson it claims?** `defense_safety_chart`, `kabe_one_chance`,
   `suji_kabe_safety`, `fold_to_riichi` and `push_or_fold` are different
   judgements; a position filed under the wrong label teaches the wrong habit.
5. **Is it readable?** A 14-tile hand with a trivially obvious answer, a
   nearly-empty river, or a table state that reads as noise wastes a slot.
6. **Is it a duplicate in disguise?** Exact and visible-state duplicates are
   already rejected; near-duplicates (same actor hand, different river) still
   read as repetition and are what `--unique-hands` drops at assembly.
7. **Is the label stable?** `label_kind=book` and `label_stability=stable` are
   the only accepted labels. Contested or Mortal-only labels do not ship here.

A rejection is cheap and reversible: the sidecar is append-only, so a later
`--accept` overrides it and the latest entry wins. Record the reason as the
disposition note so the next reviewer can see what was judged, not just the
verdict.

## Verifying the round trip

`mine_replays review` revalidates every embedded report on read, and the bulk
document is checked for schema, version, duplicate ids and ids missing from the
queue before anything is written. After a session:

```bash
# Counts, pending work and per-row verdicts (exit 1 if any report is invalid).
"$BIN" --data-dir "$RIICHI_DATA_DIR" review --pack replay.ch8-defense.2026-11 --json \
  > testdata/reports/q2-scale-2k/review-report.json

# The disposition log is append-only; the latest entry per item wins.
wc -l "$RIICHI_DATA_DIR/reviews/replay.ch8-defense.2026-11/dispositions.jsonl"
```

Store the report and the sampled sheet beside the pack's other run reports. A
pack may not assemble until `pending == 0` (P1b's gate), and `--dry-run` is the
way to inspect a selection without writing.

## Scale notes

* The browser page is a convenience for reading reports and sampling; the CLI
  is the batch surface and the one to script. Neither is required: the existing
  `--accept`/`--reject`/`--verdicts` path still works for small queues.
* `--sample`/`--seed` are reproducible across the CLI and the page; the
  stratified sheet (`sample-review-sheet.py`) is the artifact for sign-off,
  because it guarantees rare-lesson coverage that a flat sample does not.
* The 2k pack (2,250 candidates) was reviewed with one mechanical pass applied
  as bulk dispositions plus a 251-row stratified sheet; see
  [`q2-scale-up-2000.md`](q2-scale-up-2000.md) §Review.
