# riichiprac
Practice riichi mahjong strategy

## Development

Requires Rust, [`wasm-pack`](https://rustwasm.github.io/wasm-pack/), and Node.js.

```bash
# Build the WASM package used by the frontend.
wasm-pack build --target web

cd frontend
npm install
npm run dev
```

The Mortal AI evaluator is optional. Its weights are not committed; generate them
with `scripts/convert_weights.py` (see `scripts/README.md`). Without the weights,
the app runs normally and the AI panel reports that the model is unavailable.

## Reporting a bad answer

After answering a puzzle, use **Report bad answer** to pick a reason, add an
optional note, and download a
`riichiprac.scenario-report` JSON file. The file contains the exact table, the
reporter's answer, the app's expected answer, the scenario metadata, and an AI
snapshot when one was available. It also includes a `human_readable` summary.

Use **Import report** to load that file back into the trainer. The imported
table is restored with the reported answer highlighted, and the app re-runs the
Mortal evaluation when the weights are ready. The report banner shows the app's
answer, the reporter's answer, and Mortal's recommendation side by side.

Reports can also be verified from a native build:

```bash
cargo run --release --bin verify_report -- report.json
cargo run --release --bin verify_report -- report.json \
  --weights frontend/public/models/mortal_298k.safetensors
```

The CLI prints the same readable summary and, when weights are supplied, the
Mortal ranking. Add `--json` for a machine-readable verification payload.

## Fuzzing for generator / Mortal disagreements

`fuzz_scenarios` samples real scenarios, asks the local Mortal checkpoint what
it would do, and writes a standard scenario report for every case where the
generator's expected answer and Mortal's top action disagree. It is an offline
review tool; it does not affect the browser app or the WASM build.

Generate the weights first (see `scripts/README.md`), then run:

```bash
# All scenarios, 200 generation attempts, at most 20 report files.
cargo run --release --bin fuzz_scenarios

# Smaller run with an explicit output directory.
cargo run --release --bin fuzz_scenarios -- \
  --iterations 40 --limit 3 --out /tmp/fuzz-smoke
```

Reports are written to `fuzz-reports/` by default (git-ignored) using the normal
`riichiprac-report-<scenario>-<timestamp>-<short-id>.json` name. Each file can be
opened with **Import report** or checked with `verify_report`:

```bash
cargo run --release --bin verify_report -- \
  fuzz-reports/riichiprac-report-chiitoitsu_riichi_vs_dama-20261110-170052-1edf1410.json \
  --weights frontend/public/models/mortal_298k.safetensors
```

Useful flags:

- `--scenario <id>` limits sampling to one scenario and is repeatable.
- `--include-incomparable` also exports cases whose expected action has no legal
  Mortal equivalent, such as an expected Kan (Kan is never in this action space).
- `--json` prints only the final summary JSON on stdout; progress stays on
  stderr, so it can be piped into `jq`.

Exit codes are `0` for a completed run (including zero disagreements), `2` for
bad arguments or missing weights, and `3` for a fatal model or generation
failure. See `scenario-fuzz-plan.md` for the full comparison rules, and
`cargo run --bin fuzz_scenarios -- --help` for the flag reference.
