# Q2 — first curated ch. 8 defense pack

Implementation unit Q2 (`replay-implementation-plan.md` §5.3, phase 8). This is
the first curated pack: **100 reviewed ch. 8 defense bases** from the C8 smoke
corpus, labelled with `mortal_298k`, selected with a lesson scope and a
per-corpus-family mix, expanded into label-preserving variants, audited and
published to the same-origin Pages directory.

The shipped artifact is `frontend/public/scenarios/`. The raw corpus, SQLite
database and review queue stay outside git under
`$RIICHI_DATA_DIR/q2-ch8-defense-2026-11/`; the machine-readable evidence is
committed under [`testdata/reports/q2/`](../testdata/reports/q2/).

**Pack:** `replay.ch8-defense.2026-11`, 200 scenarios (100 reviewed bases + 100
label-preserving variants), 143,528 bytes, 6 ch. 8 lessons across ch8.1/ch8.2/
ch8.3, four agents, non-commercial data flag. Largest base share 1 %.

## Pipeline

```bash
export RIICHI_DATA_DIR="$HOME/riichiprac-data/q2-ch8-defense-2026-11"
BIN=target/release/mine_replays

# 1. Persist the reconstructed decisions P1b needs (it rebuilds state_json).
$BIN --data-dir "$RIICHI_DATA_DIR" extract --family akochan_tactics --json
$BIN --data-dir "$RIICHI_DATA_DIR" extract --family akochan_vs_mortal --json
$BIN --data-dir "$RIICHI_DATA_DIR" extract --family heterogeneous_table --json
$BIN --data-dir "$RIICHI_DATA_DIR" extract --family mortal_mirror --limit 20 --json
$BIN --data-dir "$RIICHI_DATA_DIR" extract --family mortal_sampling_sweep --limit 20 --json

# 2. Label only the book-classifier matches (the ch. 8 candidate triggers).
$BIN --data-dir "$RIICHI_DATA_DIR" label \
  --weights frontend/public/models/mortal_298k.safetensors \
  --trigger book --json

# 3. Select 100 reviewed bases + 10 held-out QA, scoped to ch. 8.
$BIN --data-dir "$RIICHI_DATA_DIR" select \
  --pack-id replay.ch8-defense.2026-11 \
  --size 110 --held-out-share 0.09 --seed q2-ch8-2026-11 \
  --section ch8 --stable-book-only \
  --corpus-family mortal_mirror,mortal_sampling_sweep,akochan_tactics,akochan_vs_mortal,heterogeneous_table \
  --corpus-cap mortal_mirror=10,mortal_sampling_sweep=10,akochan_tactics=30,akochan_vs_mortal=30,heterogeneous_table=30 \
  --max-section-share 0.40 --json > testdata/reports/q2/selection-report.json

# 4. Mechanical review, then reviewer dispositions (the human review is Q2r).
python3 scripts/review-q2-queue.py "$RIICHI_DATA_DIR/reviews/replay.ch8-defense.2026-11/review-queue.jsonl"
$BIN --data-dir "$RIICHI_DATA_DIR" review --pack replay.ch8-defense.2026-11 \
  --accept <100 ids> --note "q2 agent review: stable ch8 book label, legal answer, unique visible state, clean walk"
$BIN --data-dir "$RIICHI_DATA_DIR" review --pack replay.ch8-defense.2026-11 \
  --reject <10 ids> --note "q2 curation: valid ch8.2 safety-chart candidate, rejected as redundant section crowding to keep the reviewed pack at 100"

# 5. Expand one label-preserving variant per base.
$BIN --data-dir "$RIICHI_DATA_DIR" transform \
  --queue "$RIICHI_DATA_DIR/reviews/replay.ch8-defense.2026-11/review-queue.jsonl" \
  --pack-id replay.ch8-defense.2026-11 \
  --variants 1 --max-per-base 1 --share 0.01 --pack-size 100 --min-yield 0 \
  --seed q2-ch8-2026-11 --json > testdata/reports/q2/variant-report.json

# 6. Assemble, audit and publish through the same-origin manifest.
$BIN --data-dir "$RIICHI_DATA_DIR" pack assemble \
  --pack replay.ch8-defense.2026-11 \
  --queue "$RIICHI_DATA_DIR/reviews/replay.ch8-defense.2026-11/review-queue.jsonl" \
  --licence CC-BY-4.0 --attribution "<all four agents>" \
  --generated-at 2026-11-18T00:00:00Z --json > testdata/reports/q2/assembly-report.json
$BIN --data-dir "$RIICHI_DATA_DIR" audit --json > testdata/reports/q2/audit-report.json
$BIN --data-dir "$RIICHI_DATA_DIR" pack publish \
  --packs replay.ch8-defense.2026-11 --updated-at 2026-11-18T00:00:00Z
node scripts/check-pack-hosting.mjs
node scripts/check-ch8-pack.mjs
```

`extract` is the R2 → `decisions` stage Q2 needed because P1b rebuilds a base
from `decisions.state_json`; it did not exist as an implemented command before
this unit (see `replay-miner-operations.md`). The selection scope
(`--section`, `--stable-book-only`, `--corpus-family`, `--corpus-cap`) is also
new here.

## Corpus and labels

The C8 smoke corpus (`replays/` + `db/miner.sqlite`) was produced by
`riichiprac-corpus` from the pinned `mortal_298k` checkpoint and the local
Akochan `master-53188a0-minimum` build. This unit extracted and labelled 84
games across five families:

| Family | Engine | Games | Decisions | Book labels | Stable | Contested |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `akochan_tactics` (M3) | Akochan | 14 | 8,063 | 1,648 | 1,119 | 529 |
| `akochan_vs_mortal` (M4) | Akochan + Mortal | 15 | 7,637 | 1,087 | 623 | 464 |
| `heterogeneous_table` (M5) | Akochan + Mortal + H2/H3 | 15 | 8,184 | 1,673 | 1,101 | 572 |
| `mortal_mirror` (M1) | Mortal | 20 | 10,311 | 1,610 | 1,022 | 588 |
| `mortal_sampling_sweep` (M2) | Mortal | 20 | 10,488 | 1,577 | 957 | 620 |
| **Total** | | **84** | **44,683** | **7,595** | **4,822** | **2,773** |

The label run used `--trigger book`, so Mortal ran only on states a book
classifier recognised (7,595 of 44,683 reconstructed; the rest were filtered
before a forward pass). Of those book labels, 63.5 % were stable and 36.5 %
contested. The pack scope keeps **stable** labels only, because the first
curated pack must not ask a learner to arbitrate a book/Mortal disagreement.

The stable ch. 8 candidates by section were ch8.1 295, ch8.2 1,545, ch8.3 2,237
(4,077 total), so the pack had about 40 candidates per base slot.

## Selection

Machine-readable report:
[`testdata/reports/q2/selection-report.json`](../testdata/reports/q2/selection-report.json).

| Stage | Count |
| --- | ---: |
| Replays walked (all five scoped families) | 544 |
| Replays failed | 0 |
| Decisions reconstructed | 278,517 |
| Book labels | 7,679 |
| Candidates that passed gates 1–6 and 8 | 4,112 |
| Held out for QA | 10 |
| Selected bases | 110 |

Funnel:
`games_requested=544 → parsed=544 → valid=544 → decisions=278517 → trigger=228668
→ reconstructed=278517 → book_matches=7679 → labelled=7679 → gate_passed=4112
→ held_out=10 → selected=110 → packed=0`.

The 544 replays are every file in the five scoped family directories; only the
84 extracted/labelled games produced labels, which is why `no_label` is
270,838. Scope rejections were `out_of_scope=762` and
`scope_not_stable_book=2,805`. All eight hard gates were clean on the remaining
pool (`reachable`, `answer_legal`, `visible_information`, `label_confidence`,
`provenance`, `duplicate`, `spoiler` = 0 failures).

Corpus mix (the cap is the mix rule):

| Family | Cap | Candidates | Selected |
| --- | ---: | ---: | ---: |
| `akochan_tactics` | 30 | 944 | 30 |
| `akochan_vs_mortal` | 30 | 518 | 30 |
| `heterogeneous_table` | 30 | 934 | 30 |
| `mortal_mirror` | 10 | 887 | 10 |
| `mortal_sampling_sweep` | 10 | 819 | 10 |

Section mix of the 110 selected: ch8.1 18, ch8.2 58, ch8.3 34. The section cap
(44 at `--max-section-share 0.40`) was relaxed by 14 on ch8.2 to fill the pack;
the report records that. The decision-kind cap was relaxed by 44 because every
ch. 8 defense decision in this corpus is a self-turn discard (110/110);
the pack is not padded with calls it does not have.

Selection-family mix: book 44, coverage 22, close_call 15, mistake 11,
table_read 11, placement 7. `contested`, `mortal_best` and `speed_value` report
`no_candidates`, as expected under the stable-book scope.

**Held-out QA:** 10 items, disjoint from the pack, deterministic under
`--seed q2-ch8-2026-11`: ch8.2 7 / ch8.3 3; `defense_safety_chart` 6,
`fold_to_riichi` 3, `suji_kabe_safety` 1; all 10 stable book labels, all
answers legal, all visible states unique, all walks clean.

## Review

`scripts/review-q2-queue.py` is the mechanical pre-review. It rejects
out-of-scope sections/lessons, non-book or contested labels, report/lesson
mismatches, ready hands, duplicate exact/visible states and dirty walks. On the
110 selected bases it reported **110 accepted, 0 rejected**.

The reviewer dispositions then accepted 100 and rejected 10 valid
`defense_safety_chart` candidates with the lowest selection scores, purely to
keep the pack at exactly 100 reviewed bases and reduce ch8.2 crowding:

- queue: 110 items, 110 valid reports, 0 invalid, 0 pending;
- accepted 100, rejected 10;
- assembly's review gate: `checked, 100 accepted, 10 rejected`.

The 10 held-out QA items are not part of the pack and are not dispositioned.
The human content review is Q2r (a separate task); this unit supplies the 100
reviewed, mechanically clean candidates and the evidence.

## Variants and pack

Machine-readable reports: [`variant-report.json`](../testdata/reports/q2/variant-report.json)
and [`assembly-report.json`](../testdata/reports/q2/assembly-report.json).

The transform stage attempted all five transform families per base (500
attempts), preserved 336 chains, and shipped one per base (per-base cap 1). It
dropped 203 preserved chains by the per-base cap, 33 duplicate states, 134
unreachable transformed states, 13 transform rejections, 5 missing lessons, 8
no-ops, 3 changed answers and 1 changed answer set. All 100 shipped variants
passed the label-preservation gate as `book` labels. Shipped families are
`seat_perm` and `suit_perm` (two distinct families; the DoD requires at least
two). Every base has exactly one variant, so no base dominates.

| Pack measurement | Value |
| --- | ---: |
| Scenarios | 200 |
| Reviewed bases | 100 |
| Variants | 100 (50.0 %) |
| Distinct lessons | 6 |
| Book sections | ch8.1, ch8.2, ch8.3 |
| Body bytes | 143,528 |
| Manifest bytes | 763 |
| Largest base | 2 scenarios (1.0 %) |
| Agents | Akochan, Mortal 298k, `efficiency-safety-v1`, `isolated-first-v1` |
| Licence | CC-BY-4.0 (data) |
| `data_commercial_use` | false (Akochan) |
| `requires_model` | false (all book answers) |
| Audit | clean, 0 findings |
| Pack SHA-256 | `323404f8dcb782246b46c2b172c77f1092ef71fb08d3a11ce90ccef48e307830` |

The pack body is 143 KB, far below the 50 MB pack ceiling. `pack publish`
pruned the old 2-scenario fixture body and installed the ch8 pack plus its
763-byte manifest as the only same-origin pack.

## Measurements

| Measurement | Result |
| --- | --- |
| Pack body | 143,528 bytes (200 scenarios, ~718 B/scenario) |
| Manifest | 763 bytes; the only file fetched at startup |
| Initial load | Unaffected: the loader fetches only `/scenarios/manifest.json` at startup; the body is fetched when a pack lesson is picked (asserted by the App pack test) |
| Lazy body fetch | Exactly one content-addressed body request for the first pack lesson; no `.json.gz` request while the picker is open |
| Cache | `Q1_PACK_DIR=frontend/public/scenarios` loader test passes: second load is served from the in-memory cache with no second fetch |
| Answer accuracy | 100/100 shipped bases are stable book labels (Mortal top-1 agrees with the book answer); 0 contested shipped. 10/10 held-out QA stable and legal |
| Audit | 0 findings; every answer recomputed and legal; source/licence/provenance complete |
| Hosting | 41/41 `check-pack-hosting.mjs` checks; 221/221 `check-ch8-pack.mjs` checks |
| Frontend | 313 tests pass, build/lint pass; Q1 loader smoke passes on the ch8 pack |
| Too easy / too hard | Not collected yet: no learner traffic. Q2r human review and the in-app feedback path are the next measurement |
| Snapshot | `snapshots/miner-20261118-031900.sqlite`, 304,259,072 bytes, `PRAGMA integrity_check = ok`, 999 replays / 44,683 decisions / 200 selected / 200 pack scenarios; every content-addressed replay path exists |

The selector walked all 544 replay files in the five scoped family directories
even though only 84 had extracted decisions; that is why the selection run took
about 70 minutes. A scale-up should skip replays with no extracted row (or
point the run at a selection-only replay root) before growing the corpus
further.

## Scale-up decision

**Ship this pack; scale to 500 reviewed bases next, not 10,000.**

Reasons:

- The artifact is small: 200 scenarios cost 143 KB, so 1,000 scenarios are
  ~0.7 MB, well inside the 4 MB initial-load and 50 MB hosting budgets.
- The corpus is not the limit: 84 games produced 4,077 stable ch. 8 candidates,
  40 per base slot.
- Selection is the limit: walking 544 replays and building 110 review reports
  took ~70 minutes. A 500-base pack needs roughly 4–5× the reports; fix the
  "walk only extracted replays" waste and parallelise report building before
  that run.
- Human review is the other limit: 100 candidates are reviewable by one person;
  500 need the S2 review tool and a second reviewer (risk 8). Q2r is the gate
  for the first 100.
- No scale-up until Q2r signs off the first pack and the learner feedback path
  records too-easy/too-hard signals.

Out of scope for Q2: ch8.4 open-hand defense (the generator lesson has no B
classifier yet), multi-model labels, and the 10k corpus. Those are follow-ups,
not blockers for this pack.

## Related links

- [`replay-implementation-plan.md`](../replay-implementation-plan.md) §5.3 Q2,
  §9 definition of done.
- [`replay-miner-operations.md`](../replay-miner-operations.md) — extraction,
  selection scope/corpus mix, variants and pack contracts.
- [`replay-strategy.md`](../replay-strategy.md) — source/licence, scenario
  families and pack format.
- `riichiprac-corpus` `docs/c8-corpus-integration.md` — the 1k smoke corpus this
  pack consumes.
