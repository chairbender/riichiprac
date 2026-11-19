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

## Compute policy note

Selection and review-report building now use `--workers 0` (every core; 14
threads here) and print measured progress. The **extraction and labelling**
stages used by the corpus expansion are still serial; that is the next pipeline
throughput fix and is recorded as remaining work, not accepted default
behaviour, in `AGENTS.md` §5b and `replay-implementation-plan.md` §7.1. The
corpus generator already had per-family workers; the mining stages are catching
up.

## What is next

- User spot-check of the 100-row sheet.
- 2,000 bases needs more labelled games (544 games yielded 1,038 after the
  hand/lesson filters) and a proper review tool; one-at-a-time app review does
  not scale past about 1k.
- Parallelise extraction and labelling with the same `--workers`/progress
  contract, then transform.
- Variants stay disabled; a future design must change the decision, not just
  relabel the tiles.
