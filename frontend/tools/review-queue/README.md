# Scenario review page (Q2r2)

A thin, static browser view over a `reviews/<pack>/review-queue.jsonl` and its
append-only `dispositions.jsonl`. It is a developer/reviewer tool, not part of
the shipped app: nothing here is imported by `src/`, nothing is uploaded, and it
never writes to the data root.

```bash
cd frontend/tools/review-queue
python3 -m http.server 8787
# open http://localhost:8787/  (?seed=... matches a CLI --sample seed)
```

Load the queue (required) and the sidecar (optional) with the file inputs. The
list is answer-free; opening a row shows its embedded
`riichiprac.scenario-report` (table, graded answer, Mortal ranking, provenance).
`Accept`/`Reject` (or `a`/`r`; `j`/`k` move) append to a `localStorage` session
keyed by pack + first/last queue id, so a reload resumes. Export
`review-verdicts.json` and apply it with:

```bash
"$BIN" --data-dir "$RIICHI_DATA_DIR" review --pack <pack> --verdicts review-verdicts.json
```

The full review workflow, what the human judges, and the CLI batch surface are in
[`reviewing-scenario-packs.md`](../../../reviewing-scenario-packs.md).

## Tests

`review-core.mjs` (parsing, filters, progress, deterministic sampling, exports)
and `review-session.mjs` are pure; `review-ui.mjs` renders plain DOM. All are
covered by the frontend suite:

```bash
cd frontend && npx vitest run tools/review-queue
```
