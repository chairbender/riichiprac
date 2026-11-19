# Q2 scale-up — 1,038 real ch. 8 defense bases

Follow-on to [`q2-scale-up-500.md`](q2-scale-up-500.md). The user approved the
550-base spot-check and asked to continue scaling. Variants remain disabled;
variety comes from real positions.

## Corpus

All **250 M1 + 250 M2** games plus the 44 Akochan games are extracted and
book-labelled:

| Family | Games | Decisions | Book labels | Stable | Contested |
| --- | ---: | ---: | ---: | ---: | ---: |
| `mortal_mirror` (M1) | 250 | 126,205 | 18,312 | 10,895 | 7,417 |
| `mortal_sampling_sweep` (M2) | 250 | 128,428 | 18,289 | 11,070 | 7,219 |
| `akochan_tactics` (M3) | 14 | 8,063 | 1,648 | 1,119 | 529 |
| `akochan_vs_mortal` (M4) | 15 | 7,637 | 1,087 | 623 | 464 |
| `heterogeneous_table` (M5) | 15 | 8,184 | 1,673 | 1,101 | 572 |
| **Total** | **544** | **278,517** | **41,009** | **24,808** | **16,201** |

The label pass used `--trigger book`; 237,508 unlabelled decisions never touched
the model.

## Selection

```bash
$BIN --data-dir "$RIICHI_DATA_DIR" select \
  --pack-id replay.ch8-defense.2026-11 \
  --size 1080 --held-out-share 0.05 --seed q2-scale-1000 \
  --section ch8 --stable-book-only \
  --corpus-family mortal_mirror,mortal_sampling_sweep,akochan_tactics,akochan_vs_mortal,heterogeneous_table \
  --corpus-cap mortal_mirror=500,mortal_sampling_sweep=500,akochan_tactics=30,akochan_vs_mortal=30,heterogeneous_table=30 \
  --max-per-replay 2 --extracted-only \
  --workers 0 --progress --max-section-share 0.40 --json > testdata/reports/q2-scale-1k/selection-report.json
```

- **14 worker threads** (all cores), peak ~1,200 % CPU, **~45 minutes** wall
  time for 544 files / 278,517 decisions / 1,080 selected bases.
- `--progress` printed pass 1/2/3 file counts every 10 %, so progress was
  measured, not guessed.
- `--extracted-only` restricted the walk to the 544 extracted games.
- `--max-per-replay 2` capped each game at two bases.
- 20,640 valid candidates; 1,080 selected + 54 held out.
- Corpus mix: M1 498, M2 494, M3 28, M4 30, M5 30.
- Sections: ch8.2 553, ch8.3 370, ch8.1 157.

## Review

Mechanical review accepted **1,080 / 1,080** (stable book label, legal answer,
unique exact/visible state, clean walk); all were dispositioned accepted with a
spot-check request. The 100-row sheet is at
`/tmp/opencode/q2-scale-1k-spot-check.md`: all 11 shipped
`defense_stuck_heuristic` bases plus 89 random shipped bases.

## Pack

`pack assemble --no-variants --unique-hands --min-bases-per-lesson 4`:

```
1,038 scenarios = 1,038 reviewed bases, 0 variants
1,047,001 bytes
6 lessons: defense_safety_chart 391, fold_to_riichi 350, push_or_fold 152,
           suji_kabe_safety 126, defense_stuck_heuristic 11, kabe_one_chance 8
539 source replays, 0 adjacent same-replay bases
1,038 unique actor hands (0 repeated hand)
```

Drops: **40 `duplicate_hand`** (different rivers/scores that reached the same
13/14 tiles) and **2 `lesson_too_small`** (`kabe_suji_defense` had two reviewed
bases). `defense_stuck_heuristic` now has 11 distinct positions.

| Measurement | Value |
| --- | ---: |
| Body bytes | 1,047,001 |
| Manifest bytes | 736 |
| Pack SHA-256 | `3bdcc1736670aba63b9c9fd8d8fce8426a8a8d1799f8b125d2397a3cc782ef17` |
| Largest base | 1 scenario (0.096 %) |
| Distinct source replays | 539 |
| Adjacent same-replay bases | 0 |
| Actor hands | 1,038 unique |
| Audit | clean, 0 findings |
| Hosting | 41/41 |
| Ch8 content | 23/23 (`--allow-no-variants`) |
| Serving | 8/8 |
| Frontend | 320 tests, build/lint, loader smoke pass |
| Rust | 1,122 lib tests, clippy/fmt clean* |
| Q1 end-to-end | PASS |
| Snapshot | `snapshots/miner-20261118-194500.sqlite`, 1.77 GB, integrity ok |

`*` The only full-suite failure observed under heavy machine load was the
pre-existing 100-run generator timing assertion
(`test_pair_count_open_constraints_100_runs`); it passes alone (5.18 s) and is
not related to the miner. Run performance tests on an otherwise idle machine.

## Compute policy note (Q2p, 2026-11-18)

Selection and review-report building use `--workers 0` (every core) and print
measured progress. **Extraction, labelling and transform now do too**: each
takes `--workers N` (default `0` = every available core) and `--progress`,
parallelises per replay file (extract, label) or per base scenario (transform),
merges the per-unit results in the serial order, and records the resolved
`workers` and `wall_time_ms` in its report. `src/miner/parallel.rs` holds the
shared pool, progress and single-writer connection helpers. See
[`replay-miner-operations.md`](replay-miner-operations.md) "Parallel execution
(Q2p)" for the contract and the two documented cache-sharing caveats.

### Measured passes

The Q2 corpus (544 games / 278,517 decisions in five families) was re-extracted
and re-labelled from a copy of the same replay files into a scratch data root
that was seeded with the reference `replays` rows, so the output can be compared
row for row against the serial Q2 pass in
`~/riichiprac-data/q2-ch8-defense-2026-11`.

```bash
BIN=./target/release/mine_replays
$BIN --data-dir /tmp/opencode/q2p-bench extract --workers 0 --progress --json
$BIN --data-dir /tmp/opencode/q2p-bench label \
  --weights frontend/public/models/mortal_298k.safetensors \
  --trigger book --workers 0 --progress --json
```

| Pass | Output | Wall time | Worker threads | Notes |
| --- | --- | ---: | ---: | --- |
| `extract --workers 0` | 278,517 decisions, 544 replays | 12 min 28 s | 14 | 9.5 cores of CPU on average (`ps %cpu`) |
| `label --trigger book --workers 0` | 41,009 labels (40,429 evaluations, 580 in-run cache reuses) | 9 min 26 s | 14 | 6,412 s user+sys ⇒ 11.3 cores of useful work |
| `extract` (serial, Q2) | the reference rows | not recorded | 1 | the comparison baseline |
| `label` (serial, Q2) | 40,429 cached labels | not recorded | 1 | the comparison baseline |
| `transform --rehearsal 100` | 265 shipped variants from 590 attempts | 4.96 s | 1 | pinned stamp/pack id |
| `transform --rehearsal 100 --workers 0` | the same 265 variants | 3.37 s | 14 | report identical to the serial run |

`--progress` printed the phase header (`extract: 544 replay file(s), 14 worker
thread(s)`) and one line per tenth of the shard (`walk 54/544`, `108/544`, ...),
so the run's progress was measured rather than guessed. The recorded report
fields are `workers: 14`, `wall_time_ms: 748350` (extract) and `wall_time_ms:
565535` (label).

The host was shared while these ran (a Blender bake from another worktree held
8–10 cores for part of the extract pass, load average 2.4–32), so the wall times
understate a clean machine's throughput. The label pass's own accounting
(6,346.8 s user + 64.9 s sys against 565.6 s wall) shows 11.3 cores busy on
average; the extract pass averaged 9.5 cores (`ps %cpu`) under heavier
contention.

### Identical output to the serial pass

Extraction was compared with the serial Q2 database, row for row, over every
column extract owns:

```
rows_here|278517      only_here|0      only_ref|0
differing|0           (family, kyoku, honba, event_index, turn, seat,
                       decision_kind, state_hash, visible_info_hash,
                       played_action, legal_actions, state_json)
```

The label pass produced the same 40,429 cache rows (no key missing, none extra),
the same 41,009 labels, and the same per-decision `label_kind`/`label_source`
split as the serial pass (24,808 `book`, 16,201 `contested`, 0 unresolved). 281
cache payloads (0.7 %) and the 562 decisions that share those states (1.4 %)
differ in exactly one field: `generator`, the provenance line that names the
*source replay's* engine. Two replays from different engine families can reach
the same model-visible position; the observation does not carry the generator,
so the cache keeps whichever claimant recorded it first, and with 14 workers that
claimant need not be the serial order's. Every answer-bearing field
(`top_action`, `ranking`, `q_values`, `q_gap_*`, the book half, `stability`,
`label_kind`) is identical in all 41,009 labels. This is the documented
`label` caveat (see `replay-miner-operations.md`), and the cache-row count and
the report's answer counts are unaffected.

Unit coverage for the same property is in the Rust suite:
`miner::extract::tests::parallel_and_serial_extraction_write_the_same_rows_and_report`,
`miner::label::run::tests::parallel_and_serial_label_runs_write_the_same_rows_and_report`
and `miner::variant::tests::a_parallel_stage_matches_the_serial_stage`, plus the
`--workers`/`--progress` CLI parse test in `src/bin/mine_replays.rs`.

The transform stage's rehearsal was also compared end to end with a pinned
stamp and pack id:

```bash
$BIN --data-dir /tmp/opencode/tx-bench transform --rehearsal 100 --workers 1 \
  --dry-run --generated-at 2026-11-18T00:00:00Z --pack-id q2p-tx-bench --json
$BIN --data-dir /tmp/opencode/tx-bench transform --rehearsal 100 --workers 0 \
  --dry-run --generated-at 2026-11-18T00:00:00Z --pack-id q2p-tx-bench --json
```

Both runs report 100 bases, 590 attempts, 284 preserved, 265 shipped, and the
two reports are equal with only `workers` and `wall_time_ms` removed. A book-only
rehearsal has little model work, so the gain there is modest (4.96 s → 3.37 s);
a Mortal-base queue run parallelises the label re-run as well.

## What is next

- User spot-check of the 100-row sheet.
- 2,000 bases needs more labelled games (544 games yielded 1,038 after the
  hand/lesson filters) and a proper review tool; one-at-a-time app review does
  not scale past about 1k.
- Variants stay disabled; a future design must change the decision, not just
  relabel the tiles.
