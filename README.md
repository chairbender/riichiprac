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

## Hosting the model weights

Production builds never bundle the ~43 MB `mortal_298k.safetensors` file. At
runtime the app fetches it from the first source that answers, then caches the
bytes in IndexedDB so a returning visitor downloads nothing:

1. `VITE_WEIGHTS_URL` (build-time override, optional)
2. Hugging Face: `https://huggingface.co/chairbender/mortal-weights/resolve/main/mortal_298k.safetensors`
3. GitHub Release: `https://github.com/chairbender/riichiprac/releases/download/weights-v1/mortal_298k.safetensors`
4. Same origin: `/models/mortal_298k.safetensors` (local dev with the gitignored
   file in `frontend/public/models/`)

Publish the file once (Hugging Face shown; a GitHub Release asset works too):

```bash
pip install -U huggingface_hub
hf auth login
hf upload chairbender/mortal-weights \
  frontend/public/models/mortal_298k.safetensors mortal_298k.safetensors
```

Both hosts send `Access-Control-Allow-Origin: *`, so the browser can fetch the
file from GitHub Pages. Full runbook, including the one-time Pages setup and how
to invalidate the browser cache after replacing the weights:
[`hosting-plan.md`](hosting-plan.md).

## Deploying

Pushing to `main` runs `.github/workflows/deploy.yml`, which builds the WASM
package, builds `frontend/` with the `/riichiprac/` base path, and publishes
`frontend/dist` to GitHub Pages at
<https://chairbender.github.io/riichiprac/>. Pages must be enabled once with
**Settings → Pages → Source: GitHub Actions**.

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
