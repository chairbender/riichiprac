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

# Frontend unit tests (Vitest).
npm test
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
mistake, and the outcome line says so. When a lesson accepts more than one
answer (two interchangeable discards, for example) and Mortal prefers a
different one of them, the outcome says the pick is book-accepted and names the
alternative Mortal preferred, rather than reading as a contradiction.

Mortal is evaluated automatically for every hand. Its recommendation is hidden
until you answer so the drill is still a decision; **Peek** reveals Mortal's line
early. The book side is always explained — "Not this hand" lists the
justifications that do not apply, without inventing a citation for them.

The checkpoint lives in a dedicated Web Worker, so the forward passes (the
automatic evaluation, Peek, the AI drill, and agreement sampling) run off the UI
thread and the page stays interactive while Mortal thinks.

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

The scenario requires the model weights. Until the model is ready it stays out
of the "All scenarios" pool so a first launch does not block on the download.
After that it is drawn like any other lesson: the verdict panel renders the
single Mortal perspective, with no book column and no agreement sampling.
Select it by name to drill it directly.

The AI scenario is generated entirely in Rust/WASM: the state is built from the
shared deck, validated, encoded, evaluated once (plus a second pass when the
model chooses Riichi), and returned to React with `correct_action`, the legal
action list, and the evaluation. React only renders and grades.

## Defense scenarios

Four lessons train defense. Three answer an opponent's Riichi and the fourth
reads an open hand's post-`chii` discard. None asks about hand value: the
generated hand is never ready, so the question is only which tile is safest to
let go. All are graded by the book's rule; Mortal's answer appears beside it
after you answer.

**Defense: Safest Discard** builds a board where Riichi Book 1, ch. 8's safety
ranking (`tbl:safety`) has a real answer — a genbutsu, a suji tile, a no-chance
tile behind a blockade, or an honor ranked by its visible copies — and fills the
rest of the hand with tiles the chart ranks strictly lower, so the safest
discard is unique. The book panel names the chart row the answer sits on and
lists the other tiles with their ranks ("Not this hand").

**Defense: Suji / No-Chance Ranking** is the same fold board without the
freebie: the answer is never genbutsu, only a suji or no-chance tile. The hand
also holds a tile exactly one row down `tbl:safety`, and every other tile is
further down the table, so the drill is about the gap between neighbouring
rows rather than about spotting a 100% tile. The answer must sit inside a pair,
a set, or a protorun, so the fold visibly breaks the hand up; the variants cover
the suji-terminal rows (`A+`, `AA-`, `AA`), `BBB` (suji 4-5-6 or no chance),
`BB+`, and `BB-`.

**Defense: Nothing Is Safe** is the chapter's fallback, "What to discard when
you get stuck". Nothing in the hand is Rank B or safer, so the chart identifies
nothing; the learner applies the book's fallback list — break up a pair or
concealed set, avoid the dora and its neighbours, stay outside the opponent's
early discards, and prefer a terminal so the discard cannot deal into tanyao.
The generated hand holds the answer twice, so the copy you keep is your
follow-up discard.

**Open Hand: Post-Chi Discard** is ch. 8.4, "Discard upon chii". An opponent
with three open melds calls `chii` and discards: when the discard is in the same
suit as the `chii`, the neighbourhood of that discard is relatively safe, and
the learner discards the hand's only tile in it. The different-suit variant is
the trap: the neighbourhood is dangerous, the tempting tile is one of the
opponent's actual winning tiles, and the answer is the 100% genbutsu just
outside it. The generated threat is genuinely tenpai on the block it kept, so
the read is true on the hidden hand as well as the visible table.

The safety chart itself is `src/safety.rs`: the fifteen rows of `tbl:safety`
plus the suji and blockade arithmetic they are derived from, and the
`in_open_hand_neighbourhood` helper the ch. 8.4 lesson shares with its
rationale. The generator only places tiles; every rank is recomputed from what
the defender can see (the threat's river, all four rivers, open melds, the dora
indicator, and the defender's own hand).

## Immediate suji-trap Riichi

`Riichi: Immediate Suji Trap` is the offense side of ch. 8's suji defense.
The chapter defines the trap and its immediate form:

> When you wait for a tile that is a suji tile of some tiles you have discarded
> yourself, we say you have a suji-trap wait. In particular, when your wait is a
> suji tile of the riichi declaration tile, we say it is an immediate suji-trap
> wait. — ch8:165

> If you call riichi by discarding the 6, the hand waits for 3, which is a suji
> tile of 6 (immediate suji-trap riichi). — ch8:170

The generated hand has **two** discards that leave the *same* single wait and
the same number of live winning tiles, so acceptance cannot separate them: one
discard is three ranks from the wait, making it look like a safe suji, and the
other is six ranks away. The answer is Riichi on the trap discard.

Two things make the trap the only reason to declare. The hand is riichi-only,
the human is not the dealer, and two copies of the winning tile are already
visible, so ch. 7's general three-condition rule (ch7:55-59) and its bad-wait
box (ch7:521-522) both keep it dama. And the human river holds neither the wait
nor any suji of it, so the plain discard leaves no trap — there is exactly one
right answer. The book rationale cites the immediate-trap definition, and the
caveat notes the section's own limit: suji defense only works against side
waits, so the trap pays off when opponents read the wait as a ryanmen.

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

## Pinfu head

`Pinfu: Build the Head` is the ch. 5 "Building the head" exercise:

> To claim pinfu, the head must be a pair of number tiles or valueless wind
> tiles. Therefore, try not to discard terminals or valueless wind tiles
> lightly when having a pinfu hand. Keep this in mind especially when a hand is
> lacking any pair. — ch5:449

> The hand has a potential to have pinfu, so we should not discard any of
> 1m 9p E at this point. All of these three tiles may appear useless, but they
> can be the head of a pinfu hand when any of them grows into a pair. On the
> other hand, the value tile fa cannot be the head of pinfu. We should discard
> fa in this case. — ch5:458

Every hand is closed, 2-away, and holds **no pair yet**: two complete runs and
two side-wait protoruns, three lone terminals or valueless winds with nothing of
their suit within two ranks, and one lone value honor — a dragon, the round wind,
or the seat wind. The answer is the value honor, and it is proved structurally
rather than by score or acceptance: it is the only tile in the fourteen that can
never be the pinfu head, so the three seemingly useless singles stay.

The first-turn table has no calls, Riichi, or furiten, and the dora is never the
answer, so nothing but the head rule can decide the discard. The book panel
names the tiles kept and why the value honor is barred, and "Not this hand"
notes that pairing the value honor would give a yakuhai head instead — a
different hand from pinfu.

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

## Exporting and importing a position

**Export** downloads the current table as a plain
`riichiprac-state-<scenario>-<timestamp>.json` file. The payload is the complete
`GameState` — all four players, hands, melds, rivers, dora, round, scores, and
the expected answer — inside a small `riichiprac.position` envelope. It carries
no submitted answer, reason, or report metadata, so it can be shared or reloaded
without framing it as a bug report. The **Description** field above the buttons
is optional; when filled, it is trimmed, capped, and written into the file as
plain-text context. A blank description is omitted, so the file stays a plain
position.

**Import** loads such a file and restores the exact table. A file with a
description shows that text in a dismissible card just below the import/export
controls, so anyone opening a shared position can see why it was saved. The card
is plain text, never HTML.

For compatibility, importing a bare `GameState` file (the shape older exports
used) still works, as does a `riichiprac.scenario-report` file from the old
report workflow (or from `verify_report` / `fuzz_scenarios`): the app loads the
report's table as a plain position and shows the report note as the description.
The report review banner and reason dialog no longer exist in the app.

The scenario-report format remains as an internal/advanced path for the native
CLI and the generator fuzzer.

### Verifying scenario reports from the CLI

```bash
cargo run --release --bin verify_report -- report.json
cargo run --release --bin verify_report -- report.json \
  --weights frontend/public/models/mortal_298k.safetensors
```

The CLI prints the readable summary and, when weights are supplied, the Mortal
ranking. Add `--json` for a machine-readable verification payload.

## Checking our Mortal wiring against mjai.ekyu.moe

`export_tenhou6` writes a `tenhou.net/6` game log of a generated state — the
"custom log" input of <https://mjai.ekyu.moe> — so an outside Mortal can
evaluate the same table. `scripts/validate_mortal_review.py` then diffs the
reviewer's report against our own `evaluate_state` output. This is a wiring
check for the encoder and the WASM bridge, not a UI feature:

```bash
cargo run --release --bin export_tenhou6 -- \
  --scenario riichi_judgement --out /tmp/fixture.tenhou6.json \
  --evaluate --evaluation-out /tmp/ours.json
# upload /tmp/fixture.tenhou6.json at mjai.ekyu.moe with the printed player id,
# engine Mortal, temperature 1.00, then:
scripts/validate_mortal_review.py --report <report-url> --evaluation /tmp/ours.json
```

`--all` covers every scenario the exporter can represent. Open-meld lessons
currently cannot be written as a real log (their claimed tile never appears in
a river), which the tool reports instead of hiding; see `mortal-validation.md`
for the workflow, the format notes and the findings.

## Mortal-agreement generation (opt-in)

The lessons are written from Riichi Book 1, and Mortal does not always play the
book's move. `fuzz_scenarios` measures that gap; the generator can also filter it
at the source. `generator::generate_puzzle_with_agreement` draws a candidate,
evaluates it with the loaded checkpoint, and discards the candidate unless
Mortal's **top-ranked action** is one of the lesson's accepted answers —
`correct_action` plus `equivalent_tiles` — compared on the full action, so a
Riichi is only accepted when Mortal would also declare on that discard.

```rust
use riichiprac::generator::{
    MortalAgreementOptions, generate_puzzle_with_agreement,
};

let puzzle = generate_puzzle_with_agreement(
    "chiitoitsu_riichi_vs_dama",
    &model,
    "mortal_298k.safetensors",
    MortalAgreementOptions::new(40),
)?;
assert!(puzzle.agreement.expect("report").accepted);
```

From the WASM evaluator the same filter is
`evaluator.generate_puzzle_with_agreement(category, '{"enabled": true, "max_candidates": 40}')`,
which returns `{"state": GameState, "agreement": MortalAgreementReport}`. The
report records the bound, `attempts`, `evaluations`, rejects split into
`action`, `tile`, `incomparable`, and `evaluation_failed`, and — for a lesson
with situation parameters — the `situation` string naming the condition set the
hand was built to isolate (for example `riichi: good wait only`). Passing
`{"enabled": false}` (or `MortalAgreementOptions::disabled()`) returns the plain
`generate_puzzle` candidate with no report, so a host can keep one settings blob
and toggle the filter.

The filter draws the lesson's **situation parameters once per request** and
re-fills the hand under that same set on every rejected candidate. Filtering
cannot change the question, so "Mortal must agree" cannot drift the drill toward
its most obvious hands. A lesson without a parameter concept (the block-theory
discards, the safety, call and kan lessons, and `dama_genbutsu_wait` /
`dama_improving_hand` / `suji_trap_riichi`, whose answer is fixed) keeps the old
per-candidate draw. If
the pinned set cannot be built at all the call fails with an error naming it,
rather than silently choosing a different situation.

The `riichi_judgement` draw is also weighted toward the isolated conditions now:
a uniform draw over the eight sets spent five eighths of the hands on two or
three conditions at once, so the drill rarely tested one condition on its own.
Single-condition sets (good wait only, extra han only, dealer only) carry five
times the weight of the all-three set, which puts five eighths of the draw on an
isolated condition while keeping every combination reachable.

In the app it is the **Mortal must agree** checkbox beside the scenario picker.
It is per-session and stays disabled until the model is ready; turning it on
re-deals the hand on screen through the filter, and a short note under the table
says how many candidates were rejected and why (for example "accepted on 5
candidates (4 rejected: 3 tile mismatches, 1 incomparable answer)"), followed by
the pinned situation when the lesson has one. The filter only applies to
book-graded lessons: a Mortal drill has no book answer for Mortal to agree
with, so it is dealt as usual and graded by the model alone. The default
page load stays book-only and instant, and a browser without the weights can
never enable it. The sampling runs in the inference worker, so the table stays
interactive while it searches.

A candidate costs one forward pass (about 41 ms per pass with `mortal_298k` on a
desktop CPU, and roughly twice that when Mortal chooses Riichi, because its
declaration action carries no tile and the evaluator resolves the discard in a
second pass). The default bound is 40 candidates. Agreement varies by lesson — a
survey measured about 100% for `protorun_priority` and `defense_safety_chart` but
about 9% for `ryankan_break`, whose book answer is an off-by-one tile choice on
nearly every hand — so raise `max_candidates` for the low-agreement families.
When the bound runs out the call returns an error naming the rejection counts
instead of a hand the model would not play.

`ai_best_action` is not sampled here (its answer is Mortal's own argmax; use
`generate_ai_puzzle`), but it still takes part in the app's random rotation. The
`mock_table` UI fixture is returned unchanged with no report.

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
opened with **Import** or checked with `verify_report`:

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
