# Q2r2 review-surface evidence (261118-202834)

Measured on 2026-11-19 against the shipped 2,250-candidate queue at
`$RIICHI_DATA_DIR/reviews/replay.ch8-defense.2026-11/review-queue.jsonl`
(the 2k pack from [`q2-scale-up-2000.md`](../../../q2-scale-up-2000.md)).

## Whole-queue pass

```bash
mine_replays --data-dir "$RIICHI_DATA_DIR" review \
  --pack replay.ch8-defense.2026-11 --dry-run --json \
  > testdata/reports/q2r2-review-tool/review-summary.json
```

| Measurement | Value |
| --- | ---: |
| Items | 2,250 |
| Reports valid / invalid | 2,250 / 0 |
| Pending / accepted / rejected | 0 / 2,250 / 0 |
| Filtered (no filter) | 2,250 |
| Wall time | 5.3 s |

`review-summary.json` is the full `riichiprac.review-report` with one row per
item (`lesson`, `section`, `turn`, `turn_bucket`, `hand`, `answer`,
`replay_family`, `selection_reason`, verdict). The earlier Q2s report
(`q2-scale-2k/review-report.json`) predates these row fields.

## Filters and resume

```bash
# One lesson: 17 rows.
mine_replays review --pack replay.ch8-defense.2026-11 \
  --lesson kabe_one_chance --list > kabe_one_chance.txt

# Resume: nothing is pending in the shipped queue.
mine_replays review --pack replay.ch8-defense.2026-11 --status pending --list
#   pending: 0; shown: 0 of 0 filtered

# Deterministic sample: 20 rows, seed q2r2.
mine_replays review --pack replay.ch8-defense.2026-11 \
  --sample 20 --seed q2r2 --list > sample-20.txt
```

## CLI and browser sampling agree

The browser tool's `sampleItems(items, 20, "q2r2")` over the same queue produced
the same 20 queue ids, in the same order, as `sample-20.txt`
(`PARITY_OK`). Both rank by FNV-1a 64 over `seed\0queue_id` with the SplitMix64
finalizer; the vectors are pinned in
`src/miner/select/review.rs::tests::a_sample_order_is_pinned_so_the_cli_and_the_browser_agree`
and `frontend/tools/review-queue/review-core.test.mjs`.

## Disposition round trip

A smoke queue from `qa fixture` (`--pack-size 6 --held-out-share 0`) was
reviewed without touching the shipped data root:

```bash
mine_replays review --pack q1-fixture --turn late --bulk-verdict accepted \
  --note "smoke: fixture checked" --verdicts-out /tmp/opencode/q2r2-smoke/verdicts.json
```

The run wrote one `riichiprac.review-verdicts` document and appended six
accepted dispositions; a follow-up `--status pending` reported `pending: 0`.
`--bulk-verdict` without a note or without a filter is refused. Rust tests cover
append-only latest-wins, the filter/status resume, scoped bulk verdicts and the
dry-run verdicts export (`src/miner/select/review.rs` tests).

## Gates

- `cargo test --features miner --lib`: 1,158 passed, 4 ignored.
- `cargo test --features miner --bin mine_replays`: 11 passed.
- `cargo clippy --all-targets --features miner -- -D warnings`: clean.
- `cargo fmt --check`: clean.
- `cargo check --target wasm32-unknown-unknown`: clean.
- Frontend: 769 passed, 1 skipped; `npm run lint` clean; `npm run build` OK;
  `npx vitest run tools/review-queue`: 27 passed.

## Visual sign-off (AGENTS.md §6)

The browser view is a new visual surface and is **not** self-approved. To review
it:

```bash
cd frontend/tools/review-queue
python3 -m http.server 8787
# open http://localhost:8787/ and load the 2k queue (and optionally its
# dispositions.jsonl) through the file inputs
```

Questions for the user: does the two-pane queue/report layout read at desktop
width and on a narrow window; is the row density usable for a long session; does
the report panel show the table, answer, Mortal ranking and provenance clearly
enough to judge a position; is the progress/status line legible. Recorded
verdict: _pending_.
