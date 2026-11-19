# Q2s — 2,211 real ch. 8 defense bases

Follow-on to [`q2-scale-up-1000.md`](q2-scale-up-1000.md). The user asked to
scale the curated ch. 8 defense pack from the shipped 1,038 real bases to
**at least 2,000**, with variants still disabled. Variety comes from real
positions: the corpus was grown first, the review flow was made bulk/sampled
(Q2r2), and the pack was rebuilt from the reviewed bases only.

**Shipped artifact:** `frontend/public/scenarios/`, pack
`replay.ch8-defense.2026-11`, **2,211 bases, 0 variants, 2,260,809 bytes**,
seven ch. 8 lessons, 1,257 source replays, 2,211 unique actor hands, 0 adjacent
same-replay bases, non-commercial data flag because Akochan contributes.

## Corpus growth

Two further family runs extend the same `c8-smoke-2026-11` corpus. The corpus id
stays one because P1b's source gate refuses a pack whose games disagree about
the corpus; the new plans carry their own match-plan ids and seed ranges and are
recorded as separate `corpus_runs` rows.

| family | plan | games | seeds | jobs | generated | policy decisions | wall |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: |
| M1 `mortal_mirror` | `plans/c8/q2s-m1-mortal-mirror-500.json` | 500 | 10000–10499 | 14 | 500 | 322,142 | 1 h 24 m |
| M2 `mortal_sampling_sweep` | `plans/c8/q2s-m2-mortal-sampling-sweep-500.json` | 500 | 12000–12499 | 14 | 500 | 316,814 | 1 h 15 m |

4,312,725 compressed replay bytes. The run-level corpus gate then exited 1 at
its final provenance check: **two M2 replays are `partial`**
(`reconstruction_skip`, 0.4 %). Their files and rows were excluded from the Q2
data root; 998 of 1,000 new games are valid. This is recorded as a corpus
finding in `riichiprac-corpus`'s C8 doc, not hidden by regenerating.

The scoped corpus is now **1,542 games** across the five families
(M1 750, M2 748, Akochan 44), plus 455 unextracted rule-baseline games.

| Stage | Value |
| --- | ---: |
| Replays walked | 1,542 |
| Decision points | 787,052 |
| Decisions re-verified unchanged | 278,517 |
| Decisions inserted | 508,535 |
| Walk failures | 0 |

## Labels

`label --trigger book` on the five families, 14 workers:

| Measurement | Value |
| --- | ---: |
| Book labels | 110,577 |
| — cached from the 1k corpus | 41,009 |
| — evaluated in this pass | 69,568 |
| Stable | 65,744 |
| Contested | 44,833 |
| Label failures | 0 |

The scope keeps **stable book labels only**, so the contested 44,833 decisions
never reach the review queue.

## Selection

```bash
$BIN --data-dir "$RIICHI_DATA_DIR" select \
  --pack-id replay.ch8-defense.2026-11 \
  --size 2250 --held-out-share 0.05 --seed q2-scale-2000 \
  --section ch8 --stable-book-only \
  --corpus-family mortal_mirror,mortal_sampling_sweep,akochan_tactics,akochan_vs_mortal,heterogeneous_table \
  --corpus-cap mortal_mirror=1200,mortal_sampling_sweep=1200,akochan_tactics=30,akochan_vs_mortal=30,heterogeneous_table=30 \
  --max-per-replay 2 --extracted-only \
  --workers 0 --progress --max-section-share 0.40 --json
```

- 14 workers, **54.6 min** wall time; `--progress` printed all three passes.
- 53,991 valid candidates; 113 held out; **2,250 selected**.
- `--max-per-replay 2` (no higher cap), `--extracted-only`, all five families.
- Mix: M1 1,065, M2 1,102, M3 28, M4 25, M5 30.
- Sections: ch8.1 297, ch8.2 1,180, ch8.3 773.
- 900 scenarios were selected in the relaxed fill beyond a
  section/kind/turn cap; the report records it (`cap_relaxed: 900`).
- Funnel: 1,542 parsed/valid → 787,052 decisions → 646,277 trigger hits →
  110,577 book labels → 53,991 gate passes → 113 held out → 2,250 selected.

The queue is larger than one pack body on purpose, so `select --size` now
accepts 1–5,000 (the pack ceiling is assembly's job). The shipped set after
dedupe is below the selection size.

## Review (Q2r2)

One-at-a-time review does not scale past roughly a thousand candidates, so this
pack used the new bulk/sampled flow:

1. **Mechanical review** (`scripts/review-q2-queue.py --verdicts-out`) checked
   every item against the stable-book ch. 8 rules: **2,250 accepted, 0
   rejected**, no invalid reports, no out-of-scope/ready-hand/duplicate/spoiling
   candidates.
2. **Bulk dispositions** (`mine_replays review --verdicts`) applied all 2,250 in
   one run (append-only log; 0 pending).
3. **Sampled content sheet** (`scripts/sample-review-sheet.py --sample 220
   --per-lesson 25 --per-family 20 --include-all-below 30 --seed
   q2-scale-2000`) produced **251 rows**: every item of every lesson with ≤ 30
   candidates (including all 13 `kabe_double_one_chance`, 17 `kabe_one_chance`,
   2 `kabe_suji_defense`, 25 of 35 `defense_stuck_heuristic`), plus per-lesson
   and per-family guarantees and a random fill. The sheet is
   [`testdata/reports/q2-scale-2k/review-sample.md`](../testdata/reports/q2-scale-2k/review-sample.md)
   and its machine-readable summary is `review-sample.json`.

The human sample review and sign-off are recorded below when received.

## Pack

`pack assemble --no-variants --unique-hands --min-bases-per-lesson 4
--max-scenarios 3000`:

```
2,211 scenarios = 2,211 reviewed bases, 0 variants
2,260,809 bytes
7 lessons: defense_safety_chart 766, fold_to_riichi 731, suji_kabe_safety 357,
           push_or_fold 295, defense_stuck_heuristic 32, kabe_one_chance 17,
           kabe_double_one_chance 13
1,257 source replays, 0 adjacent same-replay bases
2,211 unique actor hands (0 repeated hand)
```

Drops from the 2,250 reviewed bases: **37 duplicate_hand** (a different
river/score reached the same actor hand) and **2 lesson_too_small**
(`kabe_suji_defense` had two reviewed bases, below the four-base floor). The
transform stage persisted 2,203 gated variants for the label-preservation
report; none ship. The assembly report accounts for all of them: 2,159 dropped
by `--no-variants`, 7 because their base was a duplicate hand, and 37 because
their base was dropped for repeating another hand.

| Measurement | Value |
| --- | ---: |
| Body bytes | 2,260,809 |
| Manifest bytes | 799 |
| Pack SHA-256 | `6ae2c924e80cac88248b553bddd161e98a1b0f2b4a4b50df493738d17f836d43` |
| Uncompressed body | 21,743,261 bytes |
| Largest base share | 1 scenario (0.045 %) |
| Distinct source replays | 1,257 |
| Adjacent same-replay bases | 0 |
| Actor hands | 2,211 unique |
| Licence | CC-BY-4.0 |
| Agents | Akochan `master-53188a0-minimum`, `mortal-298k` (`v4-candle+7e8134c`), two MIT reference policies |
| Data commercial use | false (Akochan contributes) |
| `requires_model` | false |

### Load and cache

The manifest is loaded first (799 bytes); the body is fetched lazily and cached
in IndexedDB. Decoding the 2.26 MB body measured **34.8 ms gunzip + 103.6 ms
JSON parse** (2,211 scenarios, 21.7 MB of JSON) in Node on this box. It stays
inside the advisory 4 MB initial-load and 50 MB hosting budgets; the
committed-asset budget is not treated as an acceptance criterion
([AGENTS.md §1c](../AGENTS.md)).

## Checks

| Gate | Result |
| --- | --- |
| Audit | clean, 0 findings (2,211 scenarios, 2,260,809 bytes) |
| Hosting (source) | 41/41 |
| Hosting (dist after build) | 41/41 |
| Ch8 content | 23/23 (`--allow-no-variants --min-scenarios 2000`) |
| Serving | 8/8 |
| Frontend | build pass, lint pass, 611 tests passed + 1 skipped |
| Rust | fmt clean, clippy clean, wasm check clean, 1,132 lib tests passed (4 ignored) |
| Q1 end-to-end | PASS |

Versioned reports: `testdata/reports/q2-scale-2k/` (`selection-report.json`,
`mechanical-review.json`, `review-report.json`, `variant-report-disabled.json`,
`review-sample.json`, `assembly-report.json`, `audit-report.json`,
`hosting-check.json`, `hosting-dist-check.json`, `ch8-check.json`,
`serving-check.txt`, `q1-e2e.txt`, `measurements.json`, and the gate logs).

## Storage

Snapshot after assembly:
`snapshots/miner-20261119-042726.sqlite`, 4.97 GB, `PRAGMA integrity_check = ok`;
1,997 replay rows, 787,052 decisions, 2,211 `pack_scenarios` rows.

## Sign-off

The 251-row sample at
[`testdata/reports/q2-scale-2k/review-sample.md`](../testdata/reports/q2-scale-2k/review-sample.md)
and the published pack were presented to the user on 2026-11-19. Verdict:
_pending_ (recorded here once received).

## Scale decision (Q2s)

Ship 2,211 real bases with **0 variants**. The 2k target is met with a margin
(2,211 after the hand/lesson drops), all bases are stable book answers, the
pack is 2.26 MB, and the review flow now scales (one bulk mechanical pass plus
a 251-row stratified sample). Variants stay disabled; the next lever is more
real games, not relabelled copies. The 2,000-scenario audit ceiling was raised
to 5,000 as a sanity split bound (the byte budget remains the real guard)
because the shipped pack is deliberately larger than one old default.
