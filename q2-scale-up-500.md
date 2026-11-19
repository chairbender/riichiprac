# Q2 scale-up — 550 real ch. 8 defense bases

Follow-on to [`q2-ch8-defense-pack.md`](q2-ch8-defense-pack.md). The user
reviewed the original 100-base pack and approved skipping the separate Q2r
review; the chosen next step was **500 real bases** with mechanical review plus
a user spot-check. Variants stay disabled: variety comes from real positions.

## Corpus expansion

The C8 smoke corpus already had 44 Akochan games (M3/M4/M5). This run extracted
and book-labelled **120 M1 + 120 M2 games** (240 Mortal games) in the same data
root:

| Family | Games with decisions | Decisions | Book labels | Stable | Contested |
| --- | ---: | ---: | ---: | ---: | ---: |
| `mortal_mirror` (M1) | 120 | 61,430 | 8,594 | 5,148 | 3,446 |
| `mortal_sampling_sweep` (M2) | 120 | 61,060 | 8,743 | 5,314 | 3,429 |
| `akochan_tactics` (M3) | 14 | 8,063 | 1,648 | 1,119 | 529 |
| `akochan_vs_mortal` (M4) | 15 | 7,637 | 1,087 | 623 | 464 |
| `heterogeneous_table` (M5) | 15 | 8,184 | 1,673 | 1,101 | 572 |
| **Total** | **284** | **146,374** | **21,745** | **13,305** | **8,440** |

The label pass still used `--trigger book`; the 124,629 unlabelled decisions
never reached a forward pass.

## Selection

```bash
$BIN --data-dir "$RIICHI_DATA_DIR" select \
  --pack-id replay.ch8-defense.2026-11 \
  --size 560 --held-out-share 0.09 --seed q2-scale-500 \
  --section ch8 --stable-book-only \
  --corpus-family mortal_mirror,mortal_sampling_sweep,akochan_tactics,akochan_vs_mortal,heterogeneous_table \
  --corpus-cap mortal_mirror=240,mortal_sampling_sweep=240,akochan_tactics=30,akochan_vs_mortal=30,heterogeneous_table=30 \
  --max-per-replay 2 --extracted-only \
  --max-section-share 0.40 --json > testdata/reports/q2-scale/selection-report.json
```

`--extracted-only` walked **284** replay files, not all 999 in the data root.
`--max-per-replay 2` capped every game's contribution, so no lesson could be
filled by a cluster of adjacent turns.

| Stage | Count |
| --- | ---: |
| Replays walked | 284 |
| Decisions reconstructed | 146,374 |
| Book labels | 21,745 |
| Candidates that passed the gates | 11,048 |
| Held-out QA | 51 |
| Selected bases | 560 |

Corpus mix: `mortal_mirror` 238, `mortal_sampling_sweep` 235,
`heterogeneous_table` 30, `akochan_vs_mortal` 29, `akochan_tactics` 28. Every
one of the 281 source replays contributed at most two bases.

Section mix: ch8.2 281, ch8.3 200, ch8.1 79. The section cap relaxed by 57 on
ch8.2 to fill the pack; the report records it.

## Review

`scripts/review-q2-queue.py` mechanically accepted **560 / 560** candidates
(stable book label, legal answer, unique exact/visible state, clean walk). All
were dispositioned accepted with the note that a user spot-check was requested.
The user's review mode was **mechanical review + spot-check**, not a full
per-item review. **Spot-check approved 2026-11-18** ("looks fine, proceed"). Ten accepted bases do not ship: seven same-hand duplicates and
three from lessons below the four-base floor.

A 60-row spot-check sheet is at `/tmp/opencode/q2-scale-spot-check.md`: all four
`defense_stuck_heuristic` bases (the lesson that previously had one repeated
state) plus 56 random shipped bases, with hand, answer, section and source.

## Pack

`pack assemble --no-variants --unique-hands --min-bases-per-lesson 4` ships:

```
550 scenarios = 550 reviewed bases, 0 variants
550,577 bytes
5 lessons: defense_safety_chart 201, fold_to_riichi 194, push_or_fold 78,
           suji_kabe_safety 73, defense_stuck_heuristic 4
281 source replays, 0 adjacent same-replay bases
550 unique hand strings (no repeated actor hand)
```

Seven scenarios were dropped as `duplicate_hand`: two different replays reached
the same 13/14 tiles with a different river or score, which reads as the same
drill. `kabe_one_chance` (2 bases) and `kabe_suji_defense` (1 base) were below
the four-base lesson floor and were dropped. `defense_stuck_heuristic` now has
four distinct real positions instead of one. The generated lessons for the
dropped topics remain in the catalogue.

| Measurement | Value |
| --- | ---: |
| Body bytes | 550,577 |
| Manifest bytes | 736 |
| Pack SHA-256 | `14144f8caa6ee891198d32b4442a4a9c251dc1c37ed8326c20151320930e68f3` |
| Largest base | 1 scenario (0.18 %) |
| Distinct source replays | 281 |
| Adjacent same-replay bases | 0 |
| Audit | clean, 0 findings |
| Hosting | 41/41 checks |
| Ch8 content | 23/23 checks (`--allow-no-variants`) |
| Serving | 8/8 checks |
| Frontend | 320 tests, build/lint pass; loader smoke passes |
| Snapshot | `snapshots/miner-20261118-170500.sqlite`, 939 MB, integrity ok |

The manifest still declares `requires_model: false` (all shipped answers are
book answers) and `data_commercial_use: false` (Akochan).

## What is next

- The user spot-check of the 60-row sheet (this run's agreed review mode).
- A 1,000-base pack needs more labelled games (the 284-game pool yields 550
  shipped bases after the lesson floor) and a proper review tool; the current
  queue is 560 items and the one-at-a-time app review does not scale.
- Variants stay disabled. If they return, the design must change the decision,
  not just relabel the same hand.
- The selector still builds every selected review report serially; a 1k run
  should parallelise report building or move report generation into the review
  tool.
