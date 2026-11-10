# Scenario Report Plan: Export / Import a Disputed Decision

Status: implemented.

This document describes a self-contained bug-report format and the UI needed to
export a disputed puzzle, re-import it into the trainer, and re-run the Mortal
evaluation against the exact same position.

## Problem

The generator decides the "correct answer" up front. When a generated state
contains a bad `correct_action`, a bad explanation trigger, or a missing
constraint, the report needs to capture the **exact table** the user saw. Today
the only evidence is a screenshot plus prose, and `generate_puzzle` is not
seeded, so the same hand cannot be regenerated on demand.

The report must also let a maintainer verify the decision with the Mortal model
without manually rebuilding the hand.

## Goals

- One-click export of the current puzzle after the user answers.
- Export a single, pretty-printed JSON file containing:
  - the complete `GameState` (the exact board, hand, rivers, melds, dora, and
    `correct_action`),
  - the scenario metadata snapshot,
  - the user's submitted answer and the app's expected answer,
  - the reported verdict, plus optional free-text note and reason,
  - the Mortal evaluation at export time, if one was run,
  - a `human_readable` block for humans and LLM agents.
- Import the file in the same app: restore the exact table, show the reported
  answer vs the expected answer, and let the reviewer run (or automatically
  re-run) the Mortal double check.
- Keep the frontend thin: the report schema, verdict validation, and summary
  rendering live in Rust/WASM, next to the game types.
- Never trust a value in an imported report that can be recomputed.

## Non-Goals

- No server, upload endpoint, telemetry, or GitHub API integration. The app is
  fully client-side; the user attaches the downloaded file to an issue.
- No attempt to re-run the scenario generator. Exact state replaces exact seed
  for this feature.
- No change to puzzle generation, rejection sampling, or scoring.
- No "fix the answer" editing UI.

## Key Design Decisions

### Embed the full state, not a seed

`src/rng.rs` currently uses `js_sys::Math::random()`, and generation is a
rejection-sampling loop. A seed alone would require changing the RNG and
replaying the whole generator; the state is the canonical artifact.

`GameState` (`src/state.rs`) already contains everything the UI and the Mortal
encoder need: all four players, hands, draws, melds, discards, riichi flags,
dora/ura indicators, round, scores, and `correct_action`. The report embeds that
object verbatim.

Seeded generation is worth doing later (see Future Work) because it would let us
replay generator bugs, but it is not required for this feature.

### Rust owns the format; TypeScript owns file I/O

The report is a data contract around game types, so it belongs beside
`GameState` and the `agari`/Mortal logic:

- Rust defines the versioned schema and derives the verdict.
- Rust renders `human_readable` from the same state used by the app.
- Rust validates imported reports and recomputes the verdict.
- TypeScript builds the small request envelope, downloads the returned JSON,
  reads files, and renders the UI.

This avoids duplicating tile formatting and correctness rules in React and gives
us native tests for the whole format.

### Recompute on import; treat embedded verdicts as hints

On import:

- `decision.verdict` and `human_readable` are **derived and non-authoritative**.
- The importer recomputes the verdict from `table.correct_action` and
  `decision.answer`.
- If the embedded and recomputed verdicts disagree, the report still loads, but
  the UI shows a warning. That mismatch is itself useful evidence (for example,
  the user exported from an older build with different rules).
- The embedded AI evaluation is shown as "AI at export time"; a fresh
  evaluation is run locally for the double check. If the model is unavailable,
  the snapshot is still readable.

### AI double check is a first-class part of report mode

Mortal's output is deterministic given `GameState` + weights. Importing a report
will re-run `WasmMortalEvaluator.evaluate` when the weights are ready and show a
three-way comparison:

- what the app said (`table.correct_action`),
- what the reporter answered (`decision.answer`),
- what Mortal recommends now (`evaluation.recommended_action`).

Probabilities are shown for the app's action and the reporter's action. Dama and
normal discard both map to `Discard_<tile>`; Kan maps to `Kan`; Riichi maps to
`Riichi`. For a red five, aggregate the regular and red-five discard actions.

## Report File Format

- File extension: `.json`
- Suggested filename:
  `riichiprac-report-<scenario>-<YYYYMMDD-HHmmss>-<short-id>.json`
- Top-level `schema`: `"riichiprac.scenario-report"`
- Top-level `version`: `1`
- Pretty-printed, stable field order, all keys `snake_case`.
- Tile codes are the existing trainer codes (`1m`..`9m`, `1p`..`9p`,
  `1s`..`9s`, `1z`..`7z`).

Example (`jsonc`; the `table` value is the complete serialized `GameState`):

```jsonc
{
  "schema": "riichiprac.scenario-report",
  "version": 1,
  "report_id": "8b0e5c0e-4f1b-4f7e-9b3e-2a7c1d9e6f10",
  "created_at": "2026-11-10T08:42:11.031Z",

  "app": {
    "app_version": "0.1.0",
    "commit": "d63f935",
    "build_time": "2026-11-10T08:00:00.000Z"
  },

  "scenario": {
    "id": "chiitoitsu_riichi_vs_dama",
    "label": "Chiitoitsu Riichi vs Dama",
    "description": "Seven pairs: decide whether to declare Riichi or stay dama.",
    "category": "riichi_decision",
    "tags": ["chiitoitsu", "riichi", "dama"]
  },

  "decision": {
    "prompt": "Declare Riichi, or stay dama?",
    "reason": "wrong_expected_action",
    "note": "Dama keeps the tanyao and the hand is already mangan.",
    "answer": { "action": "riichi", "tile": "3p" },
    "verdict": {
      "is_correct": false,
      "is_action_correct": false,
      "is_tile_correct": true,
      "expected_action": "dama",
      "expected_tile": "3p"
    }
  },

  // Complete GameState. Do not summarize or re-derive this on import.
  "table": {
    "category": "chiitoitsu_riichi_vs_dama",
    "target_action": "Dama",
    "correct_action": { "type": "dama", "discard": "3p" },
    "riichi_triggers": [],
    "dama_reasons": ["not_dealer", "middle_wait", "mangan"],
    "shouminkan_triggers": [],
    "hand_string": "112233m 44p 66p 77s 3p",
    "tiles": ["..."],
    "shanten": 0,
    "is_agari": false,
    "decompositions_count": 1,
    "ukeire_tiles": ["3p"],
    "ukeire_total": 2,
    "round_wind": "East",
    "hand_number": 2,
    "honba": 0,
    "riichi_sticks": 0,
    "dora_indicators": ["4s"],
    "ura_dora_indicators": ["6m"],
    "tiles_remaining": 42,
    "current_turn": 0,
    "players": [
      // four complete PlayerState objects
    ]
  },

  // Optional: only present if the reporter had run the AI before exporting.
  "ai": {
    "model": "mortal_298k.safetensors",
    "evaluated_at": "2026-11-10T08:42:05.000Z",
    "evaluation": {
      "expected_value": 0.041,
      "recommended_action": "Discard_3p",
      "evaluations": [
        {
          "action": "Discard_3p",
          "type": "discard",
          "tile_index": 11,
          "probability": 0.62
        },
        {
          "action": "Riichi",
          "type": "riichi",
          "tile_index": null,
          "probability": 0.21
        }
      ]
    },
    // Derived convenience block for humans/agents; recomputed on import.
    "comparison": {
      "app_action": "Discard_3p",
      "app_probability": 0.62,
      "reporter_action": "Riichi",
      "reporter_probability": 0.21,
      "ai_agrees_with_app": true,
      "ai_agrees_with_reporter": false
    }
  },

  // Derived, informational. Rebuilt on import; never parsed for correctness.
  // One string per line keeps the pretty-printed JSON readable.
  "human_readable": [
    "Riichi Trainer scenario report",
    "Scenario: Chiitoitsu Riichi vs Dama (chiitoitsu_riichi_vs_dama)",
    "..."
  ]
}
```

### Field rules

- `table` is the exact `serde_json::to_string_pretty(&GameState)` output.
- `scenario` is a snapshot from `SCENARIO_MANIFEST` at export time, so reports
  remain readable if a lesson is renamed or removed. `mock_table` falls back to
  the category string.
- `decision.reason` is one of:
  - `expected_action_wrong` (Riichi vs Dama, Kan vs Discard),
  - `expected_tile_wrong` (right action family, wrong discard),
  - `explanation_wrong` (right answer, bad trigger/reasoning),
  - `ai_evaluation_wrong` (Mortal output itself looks wrong),
  - `other`.
- `decision.answer` is the submitted action + tile, in the same lowercase
  action vocabulary as `CorrectActionType`.
- `decision.verdict` mirrors the app's `AnswerFeedback` at export time. It is
  recomputed on import and compared, not trusted.
- `ai` is `null`/absent when no evaluation exists.
- `human_readable` is an array of text lines containing: round/honba/sticks,
  dora, all four hands/melds/rivers, the prompt, the app's answer, the
  reporter's answer, the triggers/reasons, the AI top actions, and the note. It
  is deliberately redundant so a human or an LLM can read the file without
  understanding the schema, and the line array keeps the pretty-printed JSON
  readable.

## Import Semantics

1. Read the file as text with a size cap (for example 2 MiB) and a clear error
   for oversized or non-JSON files.
2. Pass the text to `parse_scenario_report`.
3. Rust validates:
   - `schema` and `version`,
   - deserialization of the full `ScenarioReport` (including `GameState`),
   - four players, a human player, and a valid `correct_action`,
   - the reported answer tile is present in the human hand/draw (warn, do not
     reject, if not),
   - the embedded verdict is consistent with the recomputed verdict (warn, do
     not reject, if not),
   - AI probabilities are finite and in a sane range (warn if not).
4. On error, show the message without touching the current puzzle.
5. On success:
   - load `report.table` through the same validation path as a generated
     puzzle,
   - reconstruct `AnswerFeedback` from the recomputed verdict so the hand
     highlights the reporter's answer,
   - show a report banner with the scenario snapshot, reporter answer, app
     answer, and any warnings,
   - start an AI evaluation automatically when the model is already loaded; if
     it is still loading, leave the normal "Evaluate with AI" button available,
   - offer "Try this puzzle" (clears `feedback` so the reviewer can answer it
     themselves while keeping the banner) and "Exit report".

Importing a bare `GameState` JSON (no report envelope) should be accepted as a
convenience for manual/agent-crafted states, with a warning that no decision was
attached. This is cheap and useful for debugging.

## UI

Mobile-first, no new layout paradigm.

- Add a small **Report** group in the header next to the scenario controls:
  - `Report bad answer` — disabled until `feedback` exists; opens a dialog with
    a reason select and a note textarea, then downloads the JSON.
  - `Import report` — always enabled; hidden file input with
    `accept=".json,application/json"`.
- Add `ReportDialog` (accessible `<dialog>` or a simple overlay) for the reason
  and note. Cap the note length (for example 4000 characters) and show the
  filename before download.
- Add `ReportBanner` above the table when `reportMode` is active:
  - imported timestamp, scenario label, app commit,
  - "App said: … · You said: … · Verdict: …",
  - warnings (for example "embedded verdict disagrees with the recomputed
    verdict"),
  - the AI comparison line once evaluation finishes,
  - "Try this puzzle", "Exit report".
- After export, show a transient confirmation with the filename.
- After import, keep the existing explanation panel visible; it shows the
  triggers that justify the app's answer, which is exactly what the reporter is
  disputing.

The download itself is a standard Blob + temporary `<a download>` (with a
new-tab fallback for browsers that ignore `download` on blobs). No File System
Access API dependency.

## Code Changes

### Rust

New module:

```text
src/report/
├── mod.rs        # constants, public native API, WASM wrappers
├── model.rs      # ScenarioReport, AppInfo, ScenarioSnapshot,
│                 # ReportDecision, ReportedAction, ReportedAi, ReportReason
├── verdict.rs    # ReportVerdict derivation + consistency checks
└── summary.rs    # human_readable rendering
```

Public native API (also used by tests and the CLI):

```rust
pub const REPORT_SCHEMA: &str = "riichiprac.scenario-report";
pub const REPORT_VERSION: u32 = 1;

pub fn build_report(request: BuildReportRequest) -> Result<ScenarioReport, ReportError>;
pub fn parse_report(json: &str) -> Result<ParsedReport, ReportError>;

pub struct ParsedReport {
    pub report: ScenarioReport,
    pub verdict: ReportVerdict, // recomputed
    pub warnings: Vec<String>,
}
```

WASM wrappers in `src/lib.rs`, matching the existing JSON-string style:

```rust
#[wasm_bindgen]
pub fn build_scenario_report(request_json: &str) -> String;
// success: report JSON (pretty); failure: {"error": "..."}

#[wasm_bindgen]
pub fn parse_scenario_report(report_json: &str) -> String;
// success: {"report": ..., "verdict": ..., "warnings": [...]}
// failure: {"error": "..."}
```

`BuildReportRequest` is the minimal envelope from TypeScript:

```text
table, answer, reason, note, created_at, report_id, commit, build_time, ai
```

Rust fills in `schema`, `version`, `app.app_version`, `scenario`, the verdict,
and `human_readable`.

Other Rust changes:

- Add `Deserialize` to `ai::wasm_bridge::Evaluation` and `ActionEvaluation` so
  the AI snapshot round-trips through the report.
- Reuse `SCENARIO_MANIFEST` to snapshot scenario metadata.
- Map `TargetAction` to a human prompt; map `CorrectAction`/answer to a Mortal
  action name for the AI comparison.
- Keep report code independent of generation so generation behavior is
  untouched.

### Frontend

New files:

```text
frontend/src/types/report.ts        # mirrors the Rust report types
frontend/src/report.ts              # request assembly, download, file reading,
                                    # Mortal-action mapping + probability lookup
frontend/src/components/ReportControls.tsx
frontend/src/components/ReportDialog.tsx
frontend/src/components/ReportBanner.tsx
```

Changes:

- `frontend/src/store/useGameStore.ts`
  - add `reportMode: { report, verdict, warnings } | null`,
  - add `importReport(text): Promise<void>` (calls the WASM parser, validates,
    loads the table, reconstructs feedback, auto-evaluates when ready),
  - add `retryImportedPuzzle()` and `exitReportMode()`,
  - clear `reportMode` in `loadFromJson` and `reset`,
  - optionally have `selectTile` carry the clicked tile index (see edge cases).
- `frontend/src/App.tsx`
  - render `ReportControls` in the header,
  - render `ReportBanner` when `reportMode` is set,
  - pass the report export request data (state, feedback, evaluation).
- `frontend/vite.config.ts` + `frontend/src/vite-env.d.ts`
  - inject `__BUILD_COMMIT__` (short git SHA) and `__BUILD_TIME__` at build time,
    fall back to `"dev"` / unknown.
- `frontend/src/App.css`
  - report bar, dialog, banner, warning list; reuse existing colors/spacing and
    the mobile-first stacked layout.
- `README.md`
  - a short "Reporting a bad answer" section with the workflow.

### Optional agent CLI

`src/bin/verify_report.rs` reuses `report::parse_report` and
`ai::evaluate_state`:

```bash
cargo run --release --bin verify_report -- report.json \
  --weights frontend/public/models/mortal_298k.safetensors
```

It prints the summary, the recomputed verdict, and the Mortal ranking, supports
`--json` for machine consumption, and exits non-zero on an invalid report. This
is the easiest path for an agent that wants to check a report outside the
browser. It does not affect `wasm-pack build`.

## Testing

Rust native tests (`cargo test --lib`):

- `verdict.rs`: table-driven tests for all four action types and
  action/tile match combinations.
- `model.rs`: serialization round-trip; unknown fields ignored; missing fields
  rejected; future `version` rejected; wrong `schema` rejected.
- Build/parse round-trip: `mock_table` fixture + a synthetic answer produces a
  report whose parsed `table` equals the original `GameState` exactly
  (`PartialEq`).
- Tampered report: changing the embedded verdict produces a warning but still
  loads; removing the answer tile from the hand produces a warning.
- `summary.rs`: asserts the readable block contains the round, dora, all four
  players, the app answer, the reporter answer, and the note.
- AI round-trip: an `Evaluation` serializes into the report and deserializes
  back; a native test with real weights (skipped when the model file is
  missing) evaluates a fixture report and asserts a legal recommendation and a
  normalized probability sum.
- CLI smoke test (if added): a committed fixture report parses and verifies.

WASM browser tests (`wasm-pack test --headless --chrome`):

- `build_scenario_report` returns valid JSON with the expected schema.
- `parse_scenario_report` accepts that output, returns no error, and preserves
  the table's `category`, `correct_action`, and 14 human tiles.

Frontend:

- No new test runner is required for v1; the correctness logic lives in Rust.
  The UI is covered by `npm run build`, `npm run lint`, and a manual QA matrix.
- Manual QA:
  - export after each scenario type (Riichi, Dama, Kan, NaniKiru),
  - verify the file parses as JSON and the `human_readable` block is coherent,
  - import the file, confirm the exact same board and highlighted answer,
  - confirm the AI comparison appears after evaluation,
  - import a tampered file / wrong schema / huge file and confirm the current
    puzzle is untouched,
  - check portrait mobile width and keyboard focus in the dialog.

Verification gates (from `generator-refactor-plan.md`):

```bash
cargo fmt --check
cargo test --lib
cargo clippy --lib --tests -- -D warnings
cargo check --target wasm32-unknown-unknown
wasm-pack test --headless --chrome

wasm-pack build --target web
cd frontend && npm run build && npm run lint
```

## Implementation Phases

1. **Format and Rust core**
   - Add `src/report/{model,verdict,summary,mod}.rs`.
   - Add `Deserialize` to the AI evaluation types.
   - Native tests + a committed `tests/fixtures/scenario_report_v1.json`.
   - Gate: `cargo test --lib`, clippy, fmt.
2. **WASM boundary**
   - Add `build_scenario_report` / `parse_scenario_report` to `src/lib.rs`.
   - Add browser test(s).
   - Gate: `wasm-pack build --target web`, WASM tests.
3. **Frontend export/import**
   - Types, `report.ts`, dialog, header buttons, store import path, build
     metadata defines.
   - Gate: `npm run build`, `npm run lint`, manual export → import round-trip.
4. **Report mode and AI verification**
   - Banner, reconstructed feedback, auto-evaluation, three-way comparison,
     retry/exit actions.
   - Gate: manual QA on all scenarios.
5. **Agent CLI and docs**
   - `src/bin/verify_report.rs`, README section, fixture documentation.
   - Optional: "Copy as Markdown" for pasting into a GitHub issue.

## Edge Cases

- **Not answered yet:** export is disabled; a tooltip explains why.
- **No AI evaluation at export:** `ai` is omitted; import can still run it.
- **Model weights unavailable:** import loads the report and shows the snapshot
  if present; the AI panel keeps its existing error/retry behavior.
- **Duplicate tile codes / red fives:** correctness uses tile codes, matching
  `selectTile`. Optionally pass the clicked tile index from `HandDock` into
  `selectTile` and record it in `decision.answer.tile_index` so an ambiguous
  physical copy is reproducible too. The verdict remains code-based.
- **Unknown scenario ID:** load the table and show the snapshot label; do not
  force the scenario picker to an invalid value.
- **Future report version:** reject with "This report was created by a newer
  version of the trainer" rather than silently mis-parsing.
- **Schema drift in `GameState`:** `REPORT_VERSION` is the format version; if a
  required `GameState` field is added later, either add a serde default or bump
  the version and add a migration. Keep the committed fixture as the guard.
- **Privacy:** reports contain only the table, the reporter's answer/note, and
  build metadata. Do not include user agent, IP, account, or local storage
  data. Add a short note in the dialog that the note is included in the file.
- **Large notes / files:** cap both in the UI and in Rust validation.
- **Import while generating:** cancel/ignore the in-flight generation request
  (reuse the existing `loadRequestId` pattern) so a late `generate_puzzle`
  cannot overwrite the imported table.

## Risks

- **Schema drift** as `GameState` evolves. Mitigated by a version field, a
  round-trip test against `mock_table`, and a committed fixture.
- **AI nondeterminism across candle versions/platforms.** Show and record the
  model filename and build commit, but do not assert exact probabilities in
  tests; compare legality and recommendation where safe.
- **Redundant `human_readable` block.** Treat it as derived output, rebuild it
  on import, and never parse it for correctness.
- **Feature creep into a bug tracker.** v1 stops at export + import + local AI
  verification. Hosting, accounts, and issue creation stay out.

## Future Work

- **Seeded generation:** replace `js_sys::Math::random()` behind a seedable RNG
  and add `generate_puzzle_seeded(category, seed)`. Include the seed in reports
  so a generator constraint bug can be replayed, not just the resulting state.
  This also enables deterministic fuzzing of scenario invariants.
- **Copy as Markdown / GitHub issue body:** a one-click summary with the
  `human_readable` block, the three-way AI comparison, and the JSON attached.
- **Share links:** compressed state in the URL hash, if reports stay small.
- **Batch reports:** a small bundle format if repeated bad states point at one
  constraint.
- **Automatic regression tests from reports:** turn a confirmed bad report into
  a fixture that asserts the generator never emits that state again.

## Acceptance Criteria

- After answering any scenario, one click downloads a valid
  `riichiprac.scenario-report` v1 JSON file.
- The file contains the exact `GameState`, the scenario snapshot, the app's
  answer, the reporter's answer, a recomputed verdict, an optional note/reason,
  optional AI output, and a readable summary.
- Importing that file restores the identical board and highlights the
  reporter's submitted answer, with the app's expected answer and the disputed
  reason visible.
- Importing the file with the Mortal weights available re-runs the evaluation
  and shows whether Mortal agrees with the app or the reporter.
- Invalid imports show an actionable error and never replace the current puzzle.
- Puzzle generation, scoring, and existing UI behavior are unchanged.
- All verification gates pass.

## Implementation Notes

- The Rust module lives in `src/report/` and the CLI in
  `src/bin/verify_report.rs`.
- `tests/fixtures/scenario_report_v1.json` is a committed sample report used by
  the importer tests and the CLI.
- Bare `GameState` imports are accepted through the UI as a debugging
  convenience; they load the table without a reported answer.
- Clicked tile indices are recorded as `decision.answer.tile_index` so an
  ambiguous physical copy (for example a red five) can be reproduced.
- Seeded generation remains future work; reports embed the exact state instead.
