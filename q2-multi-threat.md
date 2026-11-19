# Q2m — multi-threat ch. 8 defense mining pass

Follow-on to [`q2-scale-up-2000.md`](q2-scale-up-2000.md). The shipped ch. 8
pack is 2,211 bases but every one is a **single-threat** position; the new
[`defense_multi_threat`](multi-threat-defense.md) lesson fills the 2+ opponent
gap. This run labels the existing corpus with the new classifier, selects a
lesson-scoped review queue, passes mechanical + sampled review, and publishes a
dedicated pack.

**Shipped artifact:** `frontend/public/scenarios/`, pack
`replay.ch8-defense-multi-threat.2026-11`, **764 real bases, 0 variants,
591,096 bytes**, one lesson (`defense_multi_threat`, ch8.2).

## Why a separate pack

`defense_multi_threat` grades positions where several opponents are live:
two Riichi declarations, a Riichi plus a three-meld open hand, or all three.
Its answer is the hand's only tile that is certainly safe against every live
opponent (ch. 8.2's genbutsu / fourth honor / no-chance kinds), and every base
keeps a trap tile that is safe against one threat but live against another.
Mixing those into the existing single-threat pack would hide the teaching
point; a dedicated lesson-scoped pack keeps the picker honest.

## Labels

The ch. 8 classifier changed, so `CLASSIFIER_VERSION` moved from `1` to `2`
(the label cache key includes it, and the contract forbids reusing a book label
from an older rule set). Re-labelling therefore re-evaluated every book
candidate.

```bash
W=/home/kylehipke/workspaces/riichiprac/frontend/public/models/mortal_298k.safetensors
for fam in akochan_tactics akochan_vs_mortal heterogeneous_table mortal_mirror mortal_sampling_sweep; do
  mine_replays --data-dir "$RIICHI_DATA_DIR" label \
    --weights "$W" --family "$fam" --trigger book \
    --workers 0 --progress --json
done
```

14 workers, 33.5 min total:

| Measurement | Value |
| --- | ---: |
| Replays walked | 1,542 |
| Decision points | 787,052 |
| Book labels | 110,382 |
| — stable | 65,780 |
| — contested | 44,602 |
| Label failures | 0 |
| `defense_multi_threat` stable | **1,153** |
| `defense_multi_threat` contested | 451 |

The worktree does not carry the gitignored 42 MB checkpoint; the run used the
main checkout's `mortal_298k.safetensors`, SHA-256
`afb911473ac8e20cb249c4c71344cf92c780cfc98d405c60574f38f485ccc128` — the same
labeler identity as Q2s.

## Selection

```bash
mine_replays --data-dir "$RIICHI_DATA_DIR" select \
  --pack-id replay.ch8-defense-multi-threat.2026-11 \
  --size 1150 --held-out-share 0.05 --seed q2-multithreat-2026-11 \
  --section ch8 --lesson defense_multi_threat --stable-book-only \
  --corpus-family mortal_mirror,mortal_sampling_sweep,akochan_tactics,akochan_vs_mortal,heterogeneous_table \
  --corpus-cap mortal_mirror=600,mortal_sampling_sweep=600,akochan_tactics=60,akochan_vs_mortal=60,heterogeneous_table=60 \
  --max-per-replay 2 --extracted-only \
  --max-section-share 1.0 --max-kind-share 1.0 --max-turn-share 1.0 \
  --workers 0 --progress --json
```

- 14 workers, 54.7 min.
- Funnel: 1,542 parsed/valid → 787,052 decisions → 646,282 trigger hits →
  111,844 book matches → **1,153 gate passes** → 58 held out → **780 selected**.
  The book-match count includes the 1,462 stale v1 labels described below; the
  lesson scope excluded them and they were cleared after the run.
- Section: ch8.2 (780). Kind: self turn (780). `cap_relaxed: 0`.
- Families: `mortal_mirror` 377, `mortal_sampling_sweep` 364,
  `akochan_tactics` 18, `akochan_vs_mortal` 12, `heterogeneous_table` 9.
- 1,177 attempts were skipped by `--max-per-replay 2`; the queue stopped at 780
  of the 1,150 requested. A larger pack can be drawn with `--max-per-replay 3`,
  at the cost of more bases from one game.

The queue is
`$RIICHI_DATA_DIR/reviews/replay.ch8-defense-multi-threat.2026-11/review-queue.jsonl`
(780 items, all `defense_multi_threat`, all stable book labels).

## Review

Mechanical review (`scripts/review-q2-queue.py`) checked every item:

| Measurement | Value |
| --- | ---: |
| Queue items | 780 |
| Accepted | **780** |
| Rejected | 0 |
| Rejection reasons | none |
| Sections / lessons | ch8.2 / defense_multi_threat (all) |
| Decision kinds | self turn (all) |

The bulk verdicts were applied after sign-off (780 accepted, 0 pending). The
dispositions live in
`reviews/replay.ch8-defense-multi-threat.2026-11/dispositions.jsonl`.

The sampled content sheet is
[`testdata/reports/q2-multi-threat/review-sample.md`](testdata/reports/q2-multi-threat/review-sample.md):
**200 of 780** bases, seed `q2-multithreat-2026-11`, with every source family
represented (`mortal_mirror` 88, `mortal_sampling_sweep` 73,
`akochan_tactics` 18, `akochan_vs_mortal` 12, `heterogeneous_table` 9). Every
row shows the hand, the answer, the ch8.2 rationale summary, the round/scores,
the riichi count and the source family; the full report stays in the queue.

## Findings

1. **Cache invalidation is required and expensive.** The classifier version
   bump re-evaluated all ~110k book candidates (33.5 min on 14 workers). That
   is the correct behaviour; the alternative would reuse book labels from the
   old rule set.
2. **Stale labels survive a filtered re-label.** After the v2 pass, 1,462
   decisions still carried v1 labels for candidates the new classifier no
   longer recognises (the old riichi-plus-open-hand boards). Clearing them was
   a data-root fix:

   ```sql
   UPDATE decisions SET label_json=NULL, label_kind=NULL, label_source=NULL,
     mortal_top=NULL, mortal_top_prob=NULL, mortal_margin=NULL,
     mortal_ranking=NULL, q_values_json=NULL, q_units=NULL,
     labeler_model=NULL, labeler_model_sha256=NULL, classifier_version=NULL
   WHERE classifier_version='1';
   DELETE FROM model_labels WHERE classifier_version <> '2';
   ```

   `select` used to read any `label_json` (decision row, then cache) without a
   version filter, so those rows were candidates in a later full-ch8 selection.
   **Fixed in code:** a label run now clears every decision label whose
   `classifier_version` differs from the run's version before the workers start
   (`stale_labels_cleared` in the report), and `select` plus the trigger report
   only read labels at the current `CLASSIFIER_VERSION`. The one-off SQL above
   was the data-root cleanup for this already-labelled corpus.
3. **Yield is replay-clustered.** 1,153 stable labels produced 780 bases only
   because of the per-replay cap. Raise it if a larger pack is wanted.

## Pack

`pack assemble --no-variants --unique-hands --min-bases-per-lesson 3
--max-scenarios 1000`:

```
764 scenarios = 764 reviewed bases, 0 variants
591,096 bytes
1 lesson: defense_multi_threat 764
780 reviewed bases -> 16 dropped as duplicate_hand (another base repeats the
actor hand)
```

| Measurement | Value |
| --- | ---: |
| Body bytes | 591,096 |
| Manifest bytes | 1,289 (both hosted packs) |
| Pack SHA-256 | `15fe519c65df9c153abe88e4e2d19151f34c598ea7607baf0abf25d7ec2ece94` |
| uniq. actor hands | 764 |
| Largest base share | 1 scenario (0.13 %) |
| Licence | CC-BY-4.0 |
| `data_commercial_use` | false (Akochan contributes) |
| `requires_model` | false |

`pack publish` hosts both this pack and the existing
`replay.ch8-defense.2026-11`: 2,851,905 body bytes of the 50 MB ceiling.
The publish output is `frontend/public/scenarios/manifest.json`; the old pack's
body and hash are unchanged.

The mined bases add table shapes beyond the generator's three: 621 are
two-Riichi, 111 are Riichi + open hand, 20 are three-Riichi, 10 are
two-Riichi + open hand, and 2 are two open hands. All are 2+ live opponents,
which is the lesson's premise.

## Checks

| Gate | Result |
| --- | --- |
| Pack hosting | 71/71 PASS, 2 packs |
| Ch8 content | 23/23 PASS (`--allow-no-variants`) |
| Audit | clean, 0 findings |
| Serving | 14/14 PASS (`check-pack-serving.mjs`, both bodies) |
| Ch8 content (dist, old + new packs) | 23/23 PASS each |
| Frontend tests | 666 passed, 1 skipped |
| Frontend build / lint | build pass, lint clean |

## Reproduce

Everything outside git lives under
`$RIICHI_DATA_DIR` = `~/riichiprac-data/q2-ch8-defense-2026-11`. The pre-run
snapshot is `snapshots/miner-20261119-134451-pre-multithreat.sqlite`
(`PRAGMA integrity_check = ok`).

The reviewed run:

```bash
mine_replays --data-dir "$RIICHI_DATA_DIR" review \
  --pack replay.ch8-defense-multi-threat.2026-11 \
  --verdicts "$RIICHI_DATA_DIR/reviews/replay.ch8-defense-multi-threat.2026-11/mechanical-verdicts.json"
mine_replays --data-dir "$RIICHI_DATA_DIR" pack assemble \
  --pack replay.ch8-defense-multi-threat.2026-11 \
  --queue "$RIICHI_DATA_DIR/reviews/replay.ch8-defense-multi-threat.2026-11/review-queue.jsonl" \
  --no-variants --unique-hands --min-bases-per-lesson 3 --max-scenarios 1000 \
  --licence CC-BY-4.0 --attribution "<all four agents>" \
  --generated-at 2026-11-19T00:00:00Z --json
```

then `transform` (persists the `selected_scenarios` hand-off; its variants do
not ship because assembly uses `--no-variants`), `audit`, `pack publish` with
both pack ids, and the hosting/content/serving checks. The publish manifest now
lists both packs; the old pack's body and SHA-256 are untouched.

## Evidence

`testdata/reports/q2-multi-threat/`:

- `label-<family>.json` — the five per-family label reports;
- `selection-report.json` — the full selection funnel, quotas and queue paths;
- `mechanical-review.json` — 780 accepted / 0 rejected;
- `review-report.json` — the applied dispositions (780 accepted, 0 pending);
- `review-sample.md`, `review-sample.json` — the 200-row sample;
- `variant-report-disabled.json` — the transform stage (2,739 preserved
  states, 2,162 variants; none ship);
- `assembly-report.json`, `audit-report.json`, `publish-report.json` — the
  pack, audit (clean) and hosting publish;
- `hosting-check.json`, `ch8-check.json`, `ch8-check-dist*.txt`,
  `serving-check.txt` — the gates;
- `measurements.json` — the same numbers in one machine-readable document.
