# Free Hosting Plan — GitHub Pages + external weights CDN

Status: code complete (2026-11-10). Remaining work is the human-only
"Manual one-time setup" section at the bottom. Licensing split (MIT app, AGPL
weights) is recorded in section 5. This is the living status document for
making the app deployable at $0.

Branch sync (2026-11-10): merged `origin/main` at `319fd6f` into
`am/free-hosting`. Two conflicts, both resolved by hand:

- `README.md` — kept both sets of sections: main's feature docs (Book vs.
  Mortal, AI Best Action, Defense scenarios) first, then the hosting/license/
  deploy sections from this branch.
- `frontend/src/store/useGameStore.ts` — took main's refactor wholesale
  (`runEvaluation`, `requestEvaluationFor`, dual grading) and re-applied the
  weight-loader change on top: `initializeAi` calls `loadWeights()` and passes
  `WEIGHTS_FILENAME` as the evaluator's model name, instead of fetching
  `WEIGHTS_URL` and deriving the name from the URL. `aiModel.ts` still exports
  only `AI_MODEL_ID`, so no `WEIGHTS_URL` remains anywhere.

Post-merge verification is in section 6.

Deployment state (2026-11-10, after the operator's setup):

- Repo made public so Pages is available; Pages source set to **GitHub Actions**.
- `weights-v1` GitHub Release published with the 43 MB asset (verified: `302` →
  `release-assets.githubusercontent.com`, `200`, `content-length: 43555532`).
- CORS measurement showed release assets send no `access-control-allow-origin`,
  so the workflow now downloads the asset server-side and Pages serves it
  same-origin (task 4, "CORS finding").
- `https://chairbender.github.io/riichiprac/` still returned `404` at the time of
  writing because no deploy had run yet; the first deploy happens when this
  branch lands on `main`.

Goal: the single-page trainer is served from **GitHub Pages**
(`https://chairbender.github.io/riichiprac/`) and the ~43 MB Mortal weights file
is kept out of git and out of the local build. It lives as a GitHub Release
asset; because release assets are **not** CORS-enabled, CI downloads it
server-side and Pages serves it same-origin. Bytes are cached in the browser's
IndexedDB. A Hugging Face repo is the optional browser-fetchable mirror.

Why this works at $0:

| Piece | Host | Cost | Limits that matter here |
| --- | --- | --- | --- |
| App + weights (`frontend/dist`) | GitHub Pages | free for public repos | 1 GB site, 100 GB/month soft bandwidth (~2,300 first-time weight downloads/month; repeat visits hit IndexedDB) |
| Weights artifact (43 MB) | GitHub Release asset `weights-v1` | free | 2 GiB per asset; no CORS, so it is fetched by CI, not the browser |
| Optional mirror | Hugging Face model repo (public) | free | sends `access-control-allow-origin: *`, so it is browser-fetchable |
| Repeat downloads | Browser IndexedDB cache | free | one download per browser per weights version |

GitHub Pages does not support custom response headers, so nothing can set
`Cross-Origin-*` or `Cache-Control` there; see the MIME section in task 4 and
the CORS finding in task 4.

---

## 1. External weights hosting — code + runbook

- [x] `frontend/src/services/weightLoader.ts` (new): ordered source list
      (`VITE_WEIGHTS_URL` override → same-origin `BASE_URL/models/...` →
      Hugging Face mirror), payload validation, IndexedDB cache with versioned
      key, `clearWeightCache()`, `getWeightsSource()`. `RELEASE_WEIGHTS_URL` is
      exported as the canonical artifact URL for CI, not as a browser source.
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

- A fresh browser loads the weights from the same-origin copy Pages serves and
  the AI panel reaches `ready`; a second load reads IndexedDB and issues no
  network request.
- If the same-origin copy is missing, the Hugging Face mirror is tried; if every
  source fails the AI panel shows an error naming the URLs and pointing here.
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
- [x] Downloads the `weights-v1` release asset server-side into
      `frontend/public/models/` before the build (release assets are not
      CORS-enabled; see the CORS finding in task 4), with a warning instead of a
      hard failure so a missing release still deploys a book-only app.
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

### CORS finding: GitHub release assets cannot be fetched by the browser

Measured 2026-11-10 against the live `weights-v1` asset with
`Origin: https://chairbender.github.io` and `Sec-Fetch-Mode: cors`:

| URL | `access-control-allow-origin` |
| --- | --- |
| `github.com/chairbender/riichiprac/releases/download/weights-v1/...` (302) | **none** |
| `release-assets.githubusercontent.com/...` (200, 43,555,532 B) | **none** |
| `huggingface.co/VoidShine/mortal-298k/resolve/main/mortal_298k.pth` (200) | `*` |

Consequence: a browser `fetch()` of the release asset from the Pages origin is
blocked by CORS, so the app must not put it in the runtime source list. Instead
`.github/workflows/deploy.yml` downloads the asset server-side (no CORS in CI)
into `frontend/public/models/` before `npm run build`, and Pages serves it
same-origin — no CORS involved at all. `RELEASE_WEIGHTS_URL` stays exported as
the canonical artifact URL for CI and documentation only.

Trade-off accepted: the 43 MB file is now part of the Pages artifact, so a
first-time visitor costs 43 MB against Pages' 100 GB/month soft bandwidth
(~2,300 first loads). Repeat visits read IndexedDB. Publishing the optional HF
mirror moves that traffic off Pages without any app change.

## 5. Licensing: weights are AGPL-3.0, the app stays MIT

- [x] License facts verified against GitHub/HF APIs and recorded below.
- [x] `README.md`: "Model weights license" section (MIT code, AGPL weights).
- [x] `scripts/README.md`: licensing note, since `convert_weights.py` is the
      corresponding source for the AGPL file.
- [x] Manual setup steps carry the `license: agpl-3.0` tag and provenance.
- [x] Research log of the rejected alternatives (direct `.pth`, CI conversion).

Files touched: `README.md`, `hosting-plan.md`, `scripts/README.md`.

Verified 2026-11-10, recorded here so the decision does not have to be
re-researched:

| Artifact | License | Evidence |
| --- | --- | --- |
| This repo (`LICENSE`) | **MIT** | `LICENSE` at the repo root |
| `Equim-chan/Mortal` (trained the weights) | **AGPL-3.0** | `api.github.com/repos/Equim-chan/Mortal` → `license.spdx_id` |
| `VoidShine/mortal-298k` (only published 298k checkpoint) | **AGPL-3.0** | repo `LICENSE` is the AGPL-3.0 text; model card has `license: agpl-3.0` |
| Crate dependencies | no GPL/AGPL | `cargo metadata`: MIT, Apache-2.0, MPL-2.0, BSD, ISC, Unicode only |

**There is no permissively licensed form of these weights.** Weights that bind
against `src/ai/model.rs` must be Mortal checkpoints (1012×34 input, 192
channels / 40 blocks, 46-action head), and every Mortal checkpoint descends from
AGPL-3.0 training code. HF and GitHub were searched for `mortal-298k`,
`mahjong`, and `riichi`: the only 298k artifact is the AGPL `.pth` above, and no
safetensors conversion exists. `critter/akochan` has no license file at all, so
it is not a cleaner substitute.

**Why the repo can stay MIT.** The app does not link the weights; it fetches
them as data at runtime (`services/weightLoader.ts`) and they are never part of
the build. The AGPL attaches to the weights and to works based on them, not to a
separate MIT program that reads a file as input — the familiar "MIT engine,
AGPL assets" arrangement.

**Obligations when publishing the converted file** (HF repo, release asset, or
`dist/models/`):

1. Tag it AGPL-3.0 (`license: agpl-3.0` in the model card / release notes) and
   include the license text.
2. Offer the corresponding source: `scripts/convert_weights.py` plus a pointer
   to `VoidShine/mortal-298k` (upstream `Equim-chan/Mortal`). No app source needs
   to be handed over.
3. Keep the "Model weights license" note in `README.md` accurate.

AGPL §13 (network use) targets users interacting with the *program* remotely;
serving static weight bytes is not that, but the source offer above covers it
cheaply either way.

Uncertainty worth stating: whether model weights are copyrightable at all is
unsettled and jurisdiction-dependent, and whether AGPL's "based on the Program"
reaches weights produced by AGPL training code is untested. Both point the same
way — keep the notice, do not relicense the app.

### Research log: alternatives considered and rejected

- **Fetch the upstream `.pth` directly** (`VoidShine/mortal-298k/mortal_298k.pth`,
  130,774,416 bytes). Rejected: wrong container (`wasm_bridge.rs:85` uses
  `VarBuilder::from_buffered_safetensors`, and `.pth` is a zip of pickled
  tensors), wrong key layout (training checkpoint with `mortal` /
  `current_dqn` / `aux_net` + optimizer state, which the converter renames and
  strips), and 3× the bytes. Converting pickle→safetensors in the browser, or
  adding a `.pth` reader to the WASM path, is not worth it.
- **Convert in CI and bundle into `dist/models/`** (no accounts needed).
  Rejected: +1–2 min CI (torch install ≈1 GB, 130 MB checkpoint download), every
  new visitor pulls 43 MB from Pages' 100 GB/month soft bandwidth (~2,300 first
  loads/month), and it makes the site artifact itself the distributor of the
  AGPL bytes for no benefit over the two-minute upload.
- **Point `VITE_WEIGHTS_URL` at the `.pth`**: does not work, same format and
  layout reasons.

If the AI panel is ever removed or made user-supplied-weights-only, the repo
becomes purely MIT with no weight licensing question at all.

## 6. Verification (acceptance)

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

### Post-merge re-verification (2026-11-10, after merging `origin/main` `319fd6f`)

- [x] `cd frontend && npm run lint` → clean.
- [x] `cd frontend && npm run build` → OK (708 kB JS, 25 kB CSS).
- [x] `GITHUB_ACTIONS=true npm run build` → `src="/riichiprac/assets/index-*.js"`,
      bundle references `/riichiprac/assets/riichiprac_bg-BeCrl1Wy.wasm`,
      `dist/.nojekyll` present, `find dist -name '*.safetensors'` → 0.
- [x] `wasm-pack build --target web --release` → 1m06s (fresh pkg for the new
      exports main added, e.g. `grade_answer_json`).
- [x] `cargo test --lib` → 187 passed, 0 failed.
- [x] `cargo clippy --lib --tests -- -D warnings` → clean.
- [x] `cargo check --target wasm32-unknown-unknown` → clean.
- [ ] `cargo fmt --check` → **already failing on `origin/main`**, unrelated to
      this branch. Verified in a clean worktree of `origin/main` (24 `Diff in`
      hunks in `src/generator/defense/board.rs`, `src/generator/defense/theme.rs`,
      `src/rationale.rs`, `src/safety.rs`). This branch touches no Rust files, so
      it is left for main to fix rather than reformatted here.

---

## Manual one-time setup (human)

Nothing below can be done by an agent: it needs GitHub and Hugging Face
credentials. Status as of 2026-11-10: the weights release exists (`weights-v1`)
and Pages is enabled; the Hugging Face mirror and the browser verification are
still outstanding.

### A. Publish the weights (GitHub Release: done; Hugging Face optional)

The file to upload is `frontend/public/models/mortal_298k.safetensors`
(43,555,532 bytes), generated by `scripts/convert_weights.py`. It is gitignored,
so it only exists on a machine that ran the conversion.

**Option 1 — GitHub Release asset (chosen; already published as `weights-v1`):**

```bash
gh auth login
gh release create weights-v1 \
  frontend/public/models/mortal_298k.safetensors \
  --title "Mortal weights v1" \
  --notes "Mortal 298k Safetensors weights for the riichiprac WASM evaluator. AGPL-3.0, derived from VoidShine/mortal-298k; conversion source: scripts/convert_weights.py."
```

Resulting URL (`RELEASE_WEIGHTS_URL`, also hard-coded in
`.github/workflows/deploy.yml`):

```
https://github.com/chairbender/riichiprac/releases/download/weights-v1/mortal_298k.safetensors
```

Verified live on 2026-11-10: `302` → `release-assets.githubusercontent.com`,
`200`, `content-length: 43555532`.

To replace the weights later: upload `weights-v2`, update the URL in
`weightLoader.ts` and in the workflow's `curl`, and bump `CACHE_VERSION`.

**Option 2 — Hugging Face (optional browser-fetchable mirror):**

```bash
pip install -U huggingface_hub
hf auth login                       # or: huggingface-cli login
# create the public model repo (web UI: https://huggingface.co/new  -> Model,
# owner chairbender, name mortal-weights, visibility Public), then:
hf upload chairbender/mortal-weights \
  frontend/public/models/mortal_298k.safetensors mortal_298k.safetensors
```

Then set the model card metadata to `license: agpl-3.0` (Edit model card → add
the YAML front-matter) and note the provenance: upstream
[`VoidShine/mortal-298k`](https://huggingface.co/VoidShine/mortal-298k) /
[`Equim-chan/Mortal`](https://github.com/Equim-chan/Mortal), converted with
`scripts/convert_weights.py`. See "5. Licensing" for why.

Resulting URL (`HF_WEIGHTS_URL`):

```
https://huggingface.co/chairbender/mortal-weights/resolve/main/mortal_298k.safetensors
```

**CORS (measured 2026-11-10, `Origin: https://chairbender.github.io`):**

| URL | `access-control-allow-origin` |
| --- | --- |
| `github.com/.../releases/download/weights-v1/...` (302) | **none** |
| `release-assets.githubusercontent.com/...` (200) | **none** |
| `huggingface.co/.../resolve/main/...` (200) | `*` |

So GitHub release assets **cannot** be fetched by the browser, and the app does
not try: `.github/workflows/deploy.yml` downloads the asset server-side into
`frontend/public/models/` before `npm run build`, and Pages serves it
same-origin. HF stays as the only browser-fetchable external mirror.

If the HF repo/owner differs from `chairbender/mortal-weights`, edit
`HF_WEIGHTS_URL` in `frontend/src/services/weightLoader.ts`, or set the
build-time override `VITE_WEIGHTS_URL` in the workflow env instead of editing
code.

### B. Enable GitHub Pages (required before the first deploy succeeds)

Repo → **Settings → Pages → Build and deployment → Source: GitHub Actions**.
Without this the `deploy-pages` job fails with "Get Pages site failed".

Status: enabled 2026-11-10 (the repo was also made public so Pages is available).

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
| `RELEASE_WEIGHTS_URL` | `frontend/src/services/weightLoader.ts` + `curl` in `.github/workflows/deploy.yml` | release tag `weights-v1` (published 2026-11-10); change both together |
| `HF_WEIGHTS_URL` | `frontend/src/services/weightLoader.ts` | `chairbender/mortal-weights` HF mirror (not published; optional) |
| `CACHE_VERSION` | `frontend/src/services/weightLoader.ts` | bump when the weights file changes, to invalidate browser caches |
| HF model card license | HF model repo | set `license: agpl-3.0` + provenance (see "5. Licensing") |
| Pages URL | repo Settings → Pages | `https://chairbender.github.io/riichiprac/` |
