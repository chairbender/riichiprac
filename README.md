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
