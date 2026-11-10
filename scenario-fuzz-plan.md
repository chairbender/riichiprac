# Scenario Fuzz Runner Plan: Hunt Generator / Mortal Disagreements

Status: implemented.

This document describes an offline command-line runner that generates scenario
puzzles in bulk, asks the bundled Mortal model what it would do, and writes one
existing `riichiprac.scenario-report` JSON file for every disagreement. The
reports land in a git-ignored directory so a human or LLM can review them later.

The runner is a separate process (`cargo run --bin fuzz_scenarios`). It is not
part of the WASM module, the frontend, or the normal browser flow.

## Problem

The generator defines the correct answer up front and rejection-samples until a
state satisfies the lesson constraints. Mortal is an independent heuristic
policy. When the two disagree, the generator may encode a bad constraint or the
lesson may be teaching a heuristic Mortal does not share.

Finding those cases by hand means repeatedly opening the app, answering, opening
the AI panel, and eyeballing the ranking. There is no record of the exact table,
so a disagreement cannot be handed to another person or agent for review.

The report format already exists (`scenario-report-plan.md`, `src/report/`).
This runner only needs to automate sampling, comparison, and export.

## Goals

- A native-only CLI that samples the real scenarios through
  `generator::generate_puzzle`.
- Load the Mortal weights once per process and evaluate one generated state at
  a time with `ai::wasm_bridge::evaluate_state`.
- Compare the app's `correct_action` with Mortal's `recommended_action` using
  explicit, documented rules.
- Export each disagreement as a standard scenario report built by
  `report::build_report`; never invent a second format.
- Bound the work (`--iterations`) and the output (`--limit`) so a run is cheap
  and cannot fill the disk.
- Keep stdout machine-readable with `--json`; send all progress to stderr.
- Keep the library free of file I/O and native-only code so
  `cargo check --target wasm32-unknown-unknown` still passes.

## Non-Goals

- No frontend work, no UI, no new WASM exports.
- No changes to generators, constraints, scoring, rejection sampling, or RNG.
- No auto-fixing of the generator from a disagreement.
- No new crate dependencies (std + existing candle/serde/serde_json only).
- No seeded generator replay. The report embeds the exact state, which is
  enough to reproduce the disputed position.
- No statistical significance claim: a disagreement is a lead for review, not
  proof that the app is wrong.

## Key Design Decisions

### One process, weights loaded once

`MortalV4Model` is built once from
`frontend/public/models/mortal_298k.safetensors` with
`VarBuilder::from_buffered_safetensors` + `MortalV4Model::new`, the same path
`src/bin/verify_report.rs` uses. Every iteration reuses `&model`. Reloading per
state would dominate runtime.

### Pure comparison logic lives in the library

`src/fuzz.rs` contains only data-in/data-out helpers:

- Mortal action-name normalization and legality lookup,
- the comparison result and discrepancy classification,
- report-provenance note formatting,
- UTC timestamp / filename-stamp / report-id helpers,
- the serializable run summary.

The binary (`src/bin/fuzz_scenarios.rs`) owns argument parsing, weight loading,
generation, evaluation, memory of counters, directory creation, and file writes.
Splitting this way means the rules are covered by `cargo test --lib` and the
library still compiles for wasm32.

### Reuse the report module instead of duplicating it

The export path calls `report::build_report(BuildReportRequest)` and serializes
with `serde_json::to_string_pretty`. The mapping from `CorrectAction` to a
Mortal name comes from `report::mortal_action_for_correct`, and the aggregated
action probability (including red-five variants) comes from
`report::probability_for_action`. Those two items were made `pub` for this
runner; no report semantics changed.

`build_report` also fills `ai.comparison`, the verdict, the scenario snapshot,
and `human_readable` from the same state and evaluation, so the fuzz file is
indistinguishable from a report exported by the app.

### Compare with normalized action names

The trainer names tiles by plain code (`5m`), while Mortal emits separate
red-five actions (`Discard_5mr`). For comparison only, `Discard_5mr`,
`Discard_5pr`, and `Discard_5sr` are treated as equal to `Discard_5m`,
`Discard_5p`, and `Discard_5s`. The report's probability helper already sums
the plain and red variants, so the note reports the combined probability.

### Incomparable is a third outcome, not a discrepancy

`legal_action_mask` only enables plain discards, red-five discards, Riichi, and
Agari. Kan is never legal, so a `shouminkan_decision` puzzle whose expected
answer is Kan cannot be matched by Mortal in this action space. Those cases are
counted as `incomparable`; they are skipped unless `--include-incomparable` is
passed, and they never increment the discrepancy counters.

The same bucket is used when Mortal recommends an action the report vocabulary
cannot express (for example `Agari` in a state the generator marked complete).
That is recorded as `unsupported_ai_skipped` so it is not confused with a
legality mismatch.

### One generation attempt per iteration

`--iterations` is the generation-attempt budget. Each loop picks a scenario,
calls the generator once, and either evaluates or records a generator failure.
Failures consume budget and the run continues, which is the retry policy: the
CSP is allowed to fail some percentage of the time, and a run that exhausts the
budget with zero successful generations is a fatal (exit 3) error.

## CLI Interface

```text
fuzz_scenarios [--scenario <id>]... [--iterations <n>] [--limit <n>]
               [--out <dir>] [--weights <path>] [--include-incomparable]
               [--json] [--help]
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--scenario <id>` | every scenario except `ai_best_action` | Repeatable; limits sampling to the given scenario ids. Unknown ids are a bad-argument error, and so is `ai_best_action`, which is generated by the evaluator with the loaded Mortal model and cannot come from `generate_puzzle`. |
| `--iterations <n>` | `200` | Maximum generation attempts. |
| `--limit <n>` | `20` | Stop after writing this many report files. `0` stops before exporting anything. |
| `--out <dir>` | `<repo>/fuzz-reports` | Output directory, created if missing. |
| `--weights <path>` | `<repo>/frontend/public/models/mortal_298k.safetensors` | Mortal checkpoint. Missing file is a bad-argument error. |
| `--include-incomparable` | off | Also export expected answers that have no legal Mortal action (Kan). |
| `--json` | off | Print only the final summary as JSON on stdout. Progress is always stderr. |
| `--help` | — | Usage text, exit 0. |

`fuzz-reports/` is added to `.gitignore`; exported files are review artifacts,
not source.

Exit codes:

- `0` normal completion, including zero discrepancies and a reached limit,
- `2` bad arguments, unknown scenario, or missing weights file,
- `3` fatal model load/evaluation failure, or every generation attempt failed.

## Comparison Rules

1. Map the app answer to a Mortal action name:
   - `Riichi { .. }` -> `Riichi`
   - `Dama { discard }` -> `Discard_<discard>`
   - `Discard { tile }` -> `Discard_<tile>`
   - `Kan { .. }` -> `Kan`
2. Normalize red-five names (`Discard_5mr` -> `Discard_5m`, same for `p` and
   `s`) on both sides before comparing.
3. Legality: resolve the app action name to its action-space index and require
   `legal_action_mask(state)[index] == true`. If no legal index has that name,
   the case is **incomparable**.
4. If Mortal's normalized `recommended_action` equals the mapped app action,
   the case is an **agreement**.
5. Otherwise it is a **discrepancy**. Record both probabilities:
   - app probability: `report::probability_for_action(evaluation, app_name)`,
   - AI probability: `report::probability_for_action(evaluation, ai_name)`.
   The runner does not apply a probability margin: any different top pick counts,
   even if the two probabilities are close.
6. Discrepancy reason:
   - `expected_tile_wrong` when the app expects a discard (Riichi-style `Dama`
     or `Discard`) and Mortal's top action is also a discard, but the tile
     differs.
   - `expected_action_wrong` otherwise (Riichi vs discard, Kan vs discard, etc.).
7. The exported report's `decision.answer` is Mortal's recommendation converted
   to `ReportedAction`: `Riichi` -> riichi with the app's expected tile,
   `Discard_<tile>` -> discard with that tile (red names reduced to the plain
   code), `Kan` -> kan with the app's expected tile.

Provenance note written into `decision.note`:

```text
fuzz: iteration 37, scenario chiitoitsu_riichi_vs_dama,
model mortal_298k.safetensors, app Riichi (p=0.21) vs AI Discard_3p (p=0.62),
expected_value=0.041
```

Incomparable exports add a leading `incomparable: ` marker and name the missing
legal action.

## File Naming and Layout

Output directory (default): `<repo>/fuzz-reports/`, created on demand and
git-ignored.

File name convention from `scenario-report-plan.md`:

```text
riichiprac-report-<scenario>-<YYYYMMDD-HHmmss>-<short-id>.json
```

- `<scenario>` is `ScenarioId::as_str()`.
- `<YYYYMMDD-HHmmss>` is the UTC creation time.
- `<short-id>` is the first 8 hex characters of the report's 32-hex
  `report_id`.

Examples:

```text
riichiprac-report-chiitoitsu_riichi_vs_dama-20261110-084211-8b0e5c0e.json
riichiprac-report-shouminkan_decision-20261110-084219-1a2b3c4d.json
```

`report_id` and `created_at` are generated with std-only helpers: UTC civil-date
conversion from Unix seconds for RFC3339 + filename stamp, and two xorshift64
rounds seeded from the clock and an iteration counter for the id. No new
dependency, no UUID crate.

## Edge Cases

- **Generator rejects a state:** count `generator_failures`, log to stderr,
  continue to the next attempt.
- **Every attempt fails:** exit 3 with a clear message instead of an empty
  "success" run.
- **Expected Kan:** incomparable; skipped by default because the action mask
  never enables Kan. `--include-incomparable` exports it with the reason
  `expected_action_wrong`.
- **Mortal says Agari / Ryukyoku / Pass:** legal in principle but not
  representable as a `ReportedAction`; skip, count `unsupported_ai_skipped`,
  warn on stderr. Do not fabricate an answer.
- **Red five recommendation:** compare as the plain tile and export the plain
  tile code, matching the engine's tile naming.
- **Limit reached:** stop immediately after the write that reaches the limit;
  mark `limit_reached` in the summary. The partial iteration counts as done.
- **`--limit 0`:** create no files and stop before the first iteration.
- **Same-second files:** the short id comes from a counter-mixed seed, so names
  do not collide within a run.
- **Missing weights:** exit 2 before generation; do not silently run without AI.
- **Evaluation failure:** exit 3; the report format is not changed to work
  around a broken model.
- **stdout/stderr split:** with `--json`, only the summary JSON goes to stdout,
  so a caller can pipe it into `jq`.

## Testing

Library tests (`cargo test --lib`, `src/fuzz.rs`):

- action mapping for all four `CorrectAction` variants,
- red-five normalization on both app and AI sides,
- agreement, tile discrepancy, action discrepancy, incomparable Kan,
- legality lookup against a hand-built mask,
- `reported_action_for_ai` for Riichi / discard / red discard / Kan and the
  unrepresentable case,
- provenance note contains iteration, scenario, model, both probabilities, and
  expected value,
- UTC formatting for the Unix epoch and a known 2026 timestamp, filename stamp,
- 32-hex id shape, hex alphabet, and determinism per seed.

Binary-level coverage is the real-weights smoke run below; the binary has no
game rules of its own to test.

Verification gates:

```bash
cargo fmt --check
cargo test --lib
cargo clippy --lib --tests --bins -- -D warnings
cargo check --target wasm32-unknown-unknown
cargo run --release --bin fuzz_scenarios -- --iterations 40 --limit 3 --out /tmp/fuzz-smoke
cargo run --release --bin verify_report -- /tmp/fuzz-smoke/<one file>.json \
  --weights frontend/public/models/mortal_298k.safetensors
```

The last command proves an exported discrepancy is a valid report the existing
verifier accepts and can re-evaluate.

## Implementation Phases with Gates

1. **Plan and pure helpers**
   - Write this document.
   - Add `src/fuzz.rs` (normalization, comparison, note, timestamp/id,
     summary).
   - Make `report::mortal_action_for_correct` and
     `report::probability_for_action` `pub`; no behavior change.
   - Gate: `cargo test --lib`.
2. **CLI core**
   - Add `src/bin/fuzz_scenarios.rs`: flags, defaults, scenario sampling,
     generation, one-time weight loading, evaluation, counters, exit codes.
   - Gate: `cargo clippy --bins`, `cargo check --target wasm32-unknown-unknown`.
3. **Report export**
   - Build `BuildReportRequest` from the discrepancy, call `build_report`,
     write pretty JSON to the fuzz directory, enforce `--limit`.
   - Add `fuzz-reports/` to `.gitignore`.
   - Gate: smoke run with real weights and `verify_report` on one file.
4. **Verification and handoff**
   - Format, lint, test, wasm check, re-run the smoke test.
   - Commit and push the branch.

## Acceptance Criteria

- `cargo run --release --bin fuzz_scenarios -- --iterations N` samples the real
  scenarios, evaluates them with the local Mortal checkpoint, and prints a
  summary with iterations, generator failures, evaluations, agreements,
  per-scenario discrepancies, incomparable skips, files written, and whether the
  limit stopped the run.
- `--limit` reliably stops report writes.
- Every exported file is a v1 `riichiprac.scenario-report` accepted by
  `verify_report`, with `decision.answer` set to Mortal's recommendation,
  `decision.reason` / `decision.note` describing the disagreement, and `ai`
  carrying the model snapshot.
- Incomparable expected actions are never counted as discrepancies and are only
  exported with `--include-incomparable`.
- `--json` prints valid JSON and nothing else on stdout.
- No frontend, generator, scoring, RNG, or report-format semantic changes.
- All verification gates pass, including the wasm32 check.

## Future Work

- **Probability margin flag:** add `--min-prob` / `--margin` to ignore
  disagreements where the top-two probabilities are within a tolerance. Not
  implemented because the policy is currently "any different top pick is
  interesting"; the note already records both probabilities.
- **Seeded generation and replay:** log the generator seed once the RNG becomes
  seedable, so a constraint bug can be replayed without the exact state.
- **Multi-model sweeps:** evaluate the same sampled state with several
  checkpoints and export only cases where models disagree with the app and with
  each other.
- **Scenario mixing weights:** bias sampling toward scenarios that produce more
  disagreements instead of uniform selection.
- **Batch bundle:** one archive plus an index file for large fuzzing sessions.
- **Regression fixtures:** turn a confirmed report into a committed fixture that
  asserts the generator never emits that state again.
- **CI fuzz job:** a small nightly run that fails on new discrepancies in
  scenarios with strict constraints. Needs a stable weights artifact in CI.
