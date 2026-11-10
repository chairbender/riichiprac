# Free Hosting Plan — GitHub Pages + external weights CDN

Status: code complete (2026-11-10). Remaining work is the human-only
"Manual one-time setup" section at the bottom. This is the living status
document for making the app deployable at $0.

Goal: the single-page trainer is served from **GitHub Pages**
(`https://chairbender.github.io/riichiprac/`) and the ~43 MB Mortal weights file
is fetched at runtime from a free external CDN (Hugging Face first, GitHub
Release asset as the alternative) and cached in the browser's IndexedDB. The
weights are never bundled into `dist/` and never committed.

Why this works at $0:

| Piece | Host | Cost | Limits that matter here |
| --- | --- | --- | --- |
| App (`frontend/dist`) | GitHub Pages | free for public repos | 1 GB site, 100 GB/month soft bandwidth |
| Mortal weights (43 MB) | Hugging Face model repo (public) or GitHub Release asset | free | multi-GB files are fine on HF (via LFS/xet); GH release assets max 2 GiB per file |
| Repeat downloads | Browser IndexedDB cache | free | one download per browser per weights version |

GitHub Pages does not support custom response headers, so nothing can set
`Cross-Origin-*` or `Cache-Control` there; see the MIME section in task 4.

---

## 1. External weights hosting — code + runbook

- [x] `frontend/src/services/weightLoader.ts` (new): ordered source list
      (`VITE_WEIGHTS_URL` override → Hugging Face → GitHub Release →
      same-origin `BASE_URL/models/...` dev fallback), payload validation,
      IndexedDB cache with versioned key, `clearWeightCache()`,
      `getWeightsSource()`.
- [x] `frontend/src/store/useGameStore.ts`: `initializeAi` calls `loadWeights()`
      instead of fetching a single hard-coded URL; keeps the
      `requestAnimationFrame` yield, the `aiInitPromise` retry reset, and the
      HTML-fallback guard (now inside the loader). Error text names the URLs
      tried and points here.
- [x] `frontend/src/aiModel.ts`: keeps only `AI_MODEL_ID` (used by `App.tsx`
      reports). The old `WEIGHTS_URL` export was removed rather than kept or
      re-exported: `services/weightLoader.ts` owns every URL and imports
      `AI_MODEL_ID` for the filename, so there is exactly one definition of each
      and no circular import.
- [x] `frontend/src/vite-env.d.ts`: `ImportMetaEnv.VITE_WEIGHTS_URL` typing.
- [x] Runbook in this file + a "Hosting the model weights" section in
      `README.md`.

Files touched: `frontend/src/services/weightLoader.ts`,
`frontend/src/store/useGameStore.ts`, `frontend/src/aiModel.ts`,
`frontend/src/vite-env.d.ts`, `README.md`, `hosting-plan.md`.

Acceptance criteria:

- A fresh browser loads weights from Hugging Face and the AI panel reaches
  `ready`; a second load reads IndexedDB and issues no network request.
- If the primary URL 404s, the fallback URL is tried; if both fail the AI panel
  shows an error naming the URLs and pointing at this file.
- A 404 that returns an HTML page is rejected by the payload validator rather
  than being handed to `WasmMortalEvaluator`.
- Private-mode / no-IndexedDB browsers still load weights (network only).
- No new npm dependencies; no service worker; no Cache API.

## 2. GitHub Actions deploy workflow

- [x] `.github/workflows/deploy.yml` (new): build on push to `main` +
      `workflow_dispatch`; `wasm32-unknown-unknown` target; wasm-pack build from
      the repo root; Node 20 with npm cache; `npm ci && npm run build` in
      `frontend/`; `configure-pages` → `upload-pages-artifact`
      (`frontend/dist`) → `deploy-pages`.
- [x] Permissions `contents: read`, `pages: write`, `id-token: write`;
      concurrency group `pages`, `cancel-in-progress: false`.
- [x] No weights file, no `pkg/`, no `dist/` in the workflow or the commit.
- [x] wasm-opt note (see "MIME / wasm-opt conclusions" in task 4) rather than
      silently disabling it.

Files touched: `.github/workflows/deploy.yml`.

Acceptance criteria:

- `python3 -c "import yaml,sys;yaml.safe_load(open('.github/workflows/deploy.yml'))"`
  parses.
- Action versions are real and current majors (checked against
  `api.github.com/repos/<repo>/releases/latest` on 2026-11-10):
  `actions/checkout@v7`, `dtolnay/rust-toolchain@stable`,
  `Swatinem/rust-cache@v2`, `jetli/wasm-pack-action@v0.4.0`,
  `actions/setup-node@v7`, `actions/configure-pages@v6`,
  `actions/upload-pages-artifact@v5`, `actions/deploy-pages@v5`.
  (The older `checkout@v4` / `setup-node@v4` / `configure-pages@v5` /
  `upload-pages-artifact@v3` / `deploy-pages@v4` majors named in the original
  brief still work; the newer majors above are what the API reports today.)
- CI uses Node 20 per the brief (local dev is Node 18). Node 20 is at/near
  end-of-life, so bumping to the current LTS is a cheap follow-up, not a
  blocker.

## 3. Vite config for the Pages subpath

- [x] `frontend/vite.config.ts`: `base` = `VITE_BASE_PATH` (explicit override)
      → `/riichiprac/` when `GITHUB_ACTIONS` is set → `/` otherwise.
- [x] `frontend/public/.nojekyll` (empty, committed) so Pages skips Jekyll and
      keeps files/dirs starting with `_`.
- [x] Confirm `import.meta.env.BASE_URL` consumers (the local weights fallback
      and any asset URLs) resolve against the subpath.

Files touched: `frontend/vite.config.ts`, `frontend/public/.nojekyll`,
`hosting-plan.md`.

Acceptance criteria:

- `GITHUB_ACTIONS=true npm run build` → `dist/index.html` references
  `/riichiprac/assets/...`; plain `npm run build` → `/assets/...`.
- `dist/assets/*.wasm` exists (hashed, standalone); `dist/` contains no
  `models/*.safetensors`.
- `npm run dev` still works at `/` with no env vars set.

## 4. MIME / wasm-opt conclusions (recorded, not changed)

- GitHub Pages serves `.wasm` as `application/wasm` from its built-in MIME
  table, so `instantiateStreaming` works. Pages cannot send custom headers, so a
  `_headers` file would be inert — deliberately **not** added.
- `frontend/src/wasm.ts` passes a URL (`riichiprac/riichiprac_bg.wasm?url`) to
  `init({ module_or_path })`. Verified in the generated bindings
  (`pkg/riichiprac.js`, `__wbg_load`): a URL becomes `fetch(url)`, and if
  `instantiateStreaming` rejects because the response is not
  `application/wasm`, wasm-bindgen warns and falls back to
  `WebAssembly.instantiate(await response.arrayBuffer())`. **Conclusion: a wrong
  wasm MIME degrades to a slower instantiation, it does not break the app.**
- Local `wasm-pack build --target web --release` took **1m31s** wall clock and
  did not OOM on this machine (wasm-opt included, 1.52 MB output
  `riichiprac_bg-*.wasm`). CI runners are smaller, so this stays the top
  build-time risk: if the Actions job runs out of memory or exceeds the timeout,
  add `--no-opt` to the wasm-pack step and record the reason here. Not disabled
  pre-emptively.
- The built `dist/assets/index-*.js` contains the base-correct URL
  (`/riichiprac/assets/riichiprac_bg-*.wasm` under `GITHUB_ACTIONS=true`,
  `/assets/...` otherwise), confirming `?url` imports follow `base`.

## 5. Verification (acceptance)

All green on 2026-11-10 (local: rustc 1.93, wasm-pack 0.13.1, Node 18.19.1).

- [x] `cd frontend && npm run lint` → no output, exit 0.
- [x] `cd frontend && npm run build` → `dist/index.html` references
      `/assets/index-*.js`, `dist/assets/riichiprac_bg-CxuwJUo9.wasm` (1.52 MB)
      emitted standalone, `dist/` has no `*.safetensors` (2.2 MB total).
- [x] `GITHUB_ACTIONS=true npm run build` → `/riichiprac/assets/...` in
      `index.html` and `/riichiprac/assets/riichiprac_bg-*.wasm` in the bundle;
      `dist/.nojekyll` present; `find dist -name '*.safetensors'` → 0.
- [x] No source file imports the gitignored weights file; the filename is
      defined once in `frontend/src/aiModel.ts` (`AI_MODEL_ID`) and the loader
      builds every URL from it.
- [x] `cargo fmt --check` clean, `cargo test --lib` 87 passed,
      `cargo clippy --lib --tests -- -D warnings` clean,
      `cargo check --target wasm32-unknown-unknown` clean.
- [x] `deploy.yml` parses as YAML (`on`, `permissions`, `concurrency`,
      `jobs.build`, `jobs.deploy`).
- [x] `wasm-pack build --target web --release` from the repo root: 1m31s.

---

## Manual one-time setup (human)

Nothing below can be done by an agent: it needs GitHub and Hugging Face
credentials, and the repo/branch push rights.

### A. Publish the weights (pick ONE; Hugging Face is the default)

The file to upload is `frontend/public/models/mortal_298k.safetensors`
(43,555,532 bytes), generated by `scripts/convert_weights.py`. It is gitignored,
so it only exists on a machine that ran the conversion.

**Option 1 — Hugging Face (primary URL in the code):**

```bash
pip install -U huggingface_hub
hf auth login                       # or: huggingface-cli login
# create the public model repo (web UI: https://huggingface.co/new  -> Model,
# owner chairbender, name mortal-weights, visibility Public), then:
hf upload chairbender/mortal-weights \
  frontend/public/models/mortal_298k.safetensors mortal_298k.safetensors
```

Resulting URL (already the `PRIMARY_WEIGHTS_URL` constant):

```
https://huggingface.co/chairbender/mortal-weights/resolve/main/mortal_298k.safetensors
```

**Option 2 — GitHub Release asset (fallback URL in the code):**

```bash
gh auth login
gh release create weights-v1 \
  frontend/public/models/mortal_298k.safetensors \
  --title "Mortal weights v1" \
  --notes "Mortal 298k Safetensors weights for the riichiprac WASM evaluator."
```

Resulting URL (already the `FALLBACK_WEIGHTS_URL` constant):

```
https://github.com/chairbender/riichiprac/releases/download/weights-v1/mortal_298k.safetensors
```

**CORS:** both hosts send `Access-Control-Allow-Origin: *` for public
artifacts — HF `resolve/` redirects to a CDN that allows `*`, and GitHub release
assets (`release-assets.githubusercontent.com`) also send `*`. So a
`fetch()` from `https://chairbender.github.io` works without a proxy.

If the HF repo/owner differs from `chairbender/mortal-weights`, edit
`PRIMARY_WEIGHTS_URL` in `frontend/src/services/weightLoader.ts`, or set the
build-time override `VITE_WEIGHTS_URL` in the workflow env instead of editing
code.

### B. Enable GitHub Pages (required before the first deploy succeeds)

Repo → **Settings → Pages → Build and deployment → Source: GitHub Actions**.
Without this the `deploy-pages` job fails with "Get Pages site failed".

### C. Confirm CORS + weights in a real browser

Open the deployed app, open DevTools → Network, and check the weights request:

- status 200, `content-type` not `text/html`, `access-control-allow-origin: *`;
- a reload shows no weights request at all (served from IndexedDB);
- the AI panel reaches "ready".

Quick non-browser sanity check of the URLs:

```bash
curl -I https://huggingface.co/chairbender/mortal-weights/resolve/main/mortal_298k.safetensors
curl -I https://github.com/chairbender/riichiprac/releases/download/weights-v1/mortal_298k.safetensors
```

Both returned **401/404** at the time this plan was written, because neither
artifact has been published yet. That is expected. (Recorded 2026-11-10:
HF `401`, GitHub release `404`, `https://chairbender.github.io/riichiprac/`
`404` because Pages has never deployed.)

### D. Post-deploy smoke check

```bash
curl -I https://chairbender.github.io/riichiprac/
curl -I https://chairbender.github.io/riichiprac/assets/<hashed>.wasm   # expect 200 + application/wasm
```

The hashed wasm filename comes from the workflow's build log (or from
`frontend/dist/assets/` after a local `GITHUB_ACTIONS=true npm run build`).

---

## Placeholders a human must replace / verify

| Constant | File | Placeholder |
| --- | --- | --- |
| `PRIMARY_WEIGHTS_URL` | `frontend/src/services/weightLoader.ts` | `chairbender/mortal-weights` HF repo (assumed; create it or change the URL) |
| `FALLBACK_WEIGHTS_URL` | `frontend/src/services/weightLoader.ts` | `weights-v1` GitHub release tag (create it or change the URL) |
| `CACHE_VERSION` | `frontend/src/services/weightLoader.ts` | bump when the weights file changes, to invalidate browser caches |
| Pages URL | repo Settings → Pages | `https://chairbender.github.io/riichiprac/` |
