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

## Book vs. Mortal: how an answer is graded

Every puzzle is graded twice: against the Riichi Book 1 rule the scenario
encodes, and against the embedded Mortal v4 policy. The two recommendations are
shown side by side after you answer, each with its provenance. The book column
always says which rule the hand teaches and cites the chapter and section; the
Mortal column shows the model's top action, its probability, and the full
ranking. When the state offers a call (chi, pon, or kan), the Mortal column also
shows a separate call comparison — for example, how likely Mortal is to call the
Kan versus keeping the Pon — because the top action can otherwise just be the
safest discard. The same call probabilities appear on the call buttons when
Mortal's line is revealed.

Only one case is called **wrong**: when both the book and Mortal reject your
answer. Picking the book's line when Mortal disagrees is a **book answer**;
picking Mortal's line when the book disagrees is **Mortal's line**. Neither is a
mistake, and the outcome line says so.

Mortal is evaluated automatically for every hand. Its recommendation is hidden
until you answer so the drill is still a decision; **Peek** reveals Mortal's line
early (and is recorded in exported reports). The book side is always explained —
"Not this hand" lists the justifications that do not apply, without inventing a
citation for them.

Riichi is graded as a whole decision, not a single action name. When Mortal's top
action is Riichi, the evaluator runs a second pass (the position marked as
already in Riichi, `Riichi` masked off) to find the discard it would declare on;
the answer summary and the Mortal column show both ("Riichi · discard 3p"). The
submitted riichi/dama choice is compared against Mortal's, and when Mortal's
discard is known the tile is part of the comparison too, so a right declaration
on the wrong tile is not a full agreement.

The Riichi toggle is gated by a rule computed in Rust (`GameState::can_riichi`,
the same legal-action source the Mortal mask uses). An open hand, an
already-declared Riichi, a non-tenpai hand, a short wall, or a score under 1000
never offers the declaration — the open-hand block-theory lesson is the common
case.

If the weights are missing, the app still trains: the hand is graded against the
book only, the Mortal column says so, and no answer is labelled wrong.

## AI Best Action scenario

`AI Best Action` generates a random, deck-consistent table and presents whatever
decision the loaded Mortal v4 model can answer: discard, Riichi, tsumo/ron, chi,
pon, kan, or pass. The correct answer is the model's highest-probability legal
action at generation time; it is not a hand-written lesson. It is a declared
**Mortal drill**: the book column says there is no book rule, and the drill is
graded by the model alone.

The scenario requires the model weights. The picker marks it as model-backed,
and the "All scenarios" random pool always skips it so that the default rotation
only contains lessons with both perspectives. Select it by name to drill it.

The AI scenario is generated entirely in Rust/WASM: the state is built from the
shared deck, validated, encoded, evaluated once (plus a second pass when the
model chooses Riichi), and returned to React with `correct_action`, the legal
action list, and the evaluation. React only renders and grades.

## Defense scenarios

Two lessons train pure defense against an opponent's Riichi. Neither asks about
hand value: the generated hand is never ready, so the question is only which
tile is safest to let go. Both are graded by the book's rule; Mortal's
answer appears beside it after you answer.

**Defense: Safest Discard** builds a board where Riichi Book 1, ch. 8's safety
ranking (`tbl:safety`) has a real answer — a genbutsu, a suji tile, a no-chance
tile behind a blockade, or an honor ranked by its visible copies — and fills the
rest of the hand with tiles the chart ranks strictly lower, so the safest
discard is unique. The book panel names the chart row the answer sits on and
lists the other tiles with their ranks ("Not this hand").

**Defense: Nothing Is Safe** is the chapter's fallback, "What to discard when
you get stuck". Nothing in the hand is Rank B or safer, so the chart identifies
nothing; the learner applies the book's fallback list — break up a pair or
concealed set, avoid the dora and its neighbours, stay outside the opponent's
early discards, and prefer a terminal so the discard cannot deal into tanyao.
The generated hand holds the answer twice, so the copy you keep is your
follow-up discard.

The safety chart itself is `src/safety.rs`: the fifteen rows of `tbl:safety`
plus the suji and blockade arithmetic they are derived from. The generator only
places tiles; every rank is recomputed from what the defender can see (the
threat's river, all four rivers, open melds, the dora indicator, and the
defender's own hand).

## Wind discard order

`Wind Discard Order` teaches Riichi Book 1, ch. 9's seating tip
("Seating-related tip 2"): "When discarding valueless wind tiles, discard the
right player's wind first, then the facing player's wind next." The first-turn
hand holds two or three valueless winds, and only the right player's
(shimocha's) wind is accepted.

The answer is pure seat arithmetic: the shimocha is seat 1, so the correct
discard is the human's seat wind advanced one seat. The generator never deals
the round wind or the human's own wind, keeps every filler tile in a suit, and
uses a suit dora indicator, so each held wind really is valueless. When the
human is the dealer the table is the opening draw; on any other seat the board
stops right after Kamicha's first discard, which is when the human first draws.

## Hosting the model weights

The ~43 MB `mortal_298k.safetensors` file is not committed. It is published as a
GitHub Release asset (`weights-v1`). GitHub release assets send no CORS headers,
so the deploy workflow downloads it server-side and Pages serves it same-origin —
the browser never fetches GitHub directly. At runtime the app tries the first
source that answers, then caches the bytes in IndexedDB so a returning visitor
downloads nothing:

1. `VITE_WEIGHTS_URL` (build-time override, optional)
2. Same origin: `${BASE_URL}models/mortal_298k.safetensors` — placed there by CI
   (`/models/...` in dev when you have the gitignored file, `/riichiprac/models/...`
   on Pages)
3. Hugging Face: `https://huggingface.co/chairbender/mortal-weights/resolve/main/mortal_298k.safetensors`
   (optional mirror; the only browser-fetchable external source)

To replace the weights, upload a new release asset and bump `CACHE_VERSION`:

```bash
gh release create weights-v2 frontend/public/models/mortal_298k.safetensors \
  --title "Mortal weights v2" \
  --notes "AGPL-3.0, derived from VoidShine/mortal-298k; source: scripts/convert_weights.py"
```

then update the URL in `frontend/src/services/weightLoader.ts` and the `curl` in
`.github/workflows/deploy.yml`. Full runbook, including the CORS measurements and
the one-time Pages setup: [`hosting-plan.md`](hosting-plan.md).

## Model weights license

The app code in this repository is **MIT** (see `LICENSE`). The Mortal weights
are a separate work under **AGPL-3.0**: they come from
[`VoidShine/mortal-298k`](https://huggingface.co/VoidShine/mortal-298k), a
checkpoint of [`Equim-chan/Mortal`](https://github.com/Equim-chan/Mortal)
(AGPL-3.0), converted by `scripts/convert_weights.py`.

The weights are fetched at runtime and are never part of the build, so the app
and the weights are separate works: MIT here, AGPL-3.0 for the model file. If you
republish the converted file, keep it tagged `license: agpl-3.0` and point at the
conversion script as its source. Full reasoning, including the alternatives that
were rejected and why, is in
[`hosting-plan.md`](hosting-plan.md#5-licensing-weights-are-agpl-30-the-app-stays-mit).

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

## Fuzzing for generator / Mortal disagreements

`fuzz_scenarios` samples real scenarios, asks the local Mortal checkpoint what
it would do, and writes a standard scenario report for every case where the
generator's expected answer and Mortal's top action disagree. It is an offline
review tool; it does not affect the browser app or the WASM build.

Generate the weights first (see `scripts/README.md`), then run:

```bash
# Every fuzzable scenario, 200 generation attempts, at most 20 report files.
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
- `--min-margin 0.05` skips statistical ties, keeping only disagreements where
  Mortal leads the app's answer by at least that probability.
- `--json` prints only the final summary JSON on stdout; progress stays on
  stderr, so it can be piped into `jq`.

Exit codes are `0` for a completed run (including zero disagreements), `2` for
bad arguments or missing weights, and `3` for a fatal model or generation
failure. See `scenario-fuzz-plan.md` for the full comparison rules, and
`cargo run --bin fuzz_scenarios -- --help` for the flag reference. Analysis of
a completed run goes in `scenario-fuzz-findings.md`.
