# Enhanced scenario selector — plan

Task 261111-0817. Replace the single `<select>` in the app header with a
book-grouped, multi-select pool.

## 1. Metadata: one group per book section, owned by Rust

`SCENARIO_MANIFEST` in `src/generator/mod.rs` already carries the catalogue, and
`rationale::scenario_source` already maps every lesson to the Riichi Book 1
citation its verdict panel shows. Rather than hardcoding a parallel list in
React, add a `book: Option<BookSection>` field to `ScenarioMeta`:

- `BookSection { chapter, chapter_title, section, section_title }`, where
  `section` is the book's own numbered `\section` (4.1, 7.3, 8.4, 9.3, …), so
  groups line up with the chapter/section language the verdict panel uses.
  `key()` gives `ch8.4`, `label()` gives `ch8.4 · Defense against open hands`.
- Every lesson gets its group from the citation it already teaches (verified
  against `rationale::scenario_source` and the LaTeX section list in
  `/home/kylehipke/workspaces/RiichiBooks`); `ai_best_action` has no book rule,
  so it is `None` and the UI files it under "Other".
- `list_scenarios_json()` serializes it as a `book` object, so the frontend gets
  chapters/sections from the same manifest it already parses.
- A Rust test pins every lesson to a group (except the Mortal drill) and checks
  the group's chapter against `rationale::scenario_source` so the two cannot
  drift apart.

## 2. Frontend selection model

`frontend/src/scenarios.ts`:

- `ScenarioSelection` becomes `{ kind: 'all' } | { kind: 'selected', ids }`.
  "All" keeps the existing behaviour (AI drills stay out of the pool until the
  model is ready); an explicit subset is taken literally, because the user asked
  for those lessons.
- `selectionPool(...)` resolves a selection against the catalogue (with the
  `requires_ai` rule for "all" and the fallback catalogue when empty), and
  `pickRandomScenarioFrom(...)` draws uniformly from it. `pickRandomScenario`
  stays as the "all" wrapper so current call sites and tests keep working.
- `groupScenarios(...)` buckets the catalogue by `book.key`, sorts by
  chapter/section, and appends a final "Other" group for lessons with no book
  tie.

## 3. UI: popup panel with staged edits

New `frontend/src/components/ScenarioPicker.tsx`, replacing the `<select>` in
`App.tsx`'s header (the title block stays untouched):

- A header button shows the committed pool — "All scenarios (random)", the
  lesson name when one is selected, or "N scenarios (random)". It is the
  scenario identity in the header.
- Clicking opens an absolutely positioned panel (a bottom sheet on phones) with:
  - an "All scenarios (random)" row;
  - one section per book chapter/section, each with a tri-state header checkbox
    (checked / indeterminate / unchecked) that selects or clears the whole
    group, a count, and the book label ("ch8.4 · Defense against open hands");
  - one checkbox row per lesson, with its description as a tooltip;
  - a small "Only" action on each row to deal that lesson immediately, which
    keeps the one-click single-scenario workflow the old dropdown had.
- Edits are staged in a draft so ticking six boxes does not generate six hands
  (or six Mortal forward passes). The footer shows the draft pool
  ("5 scenarios · 3 groups"), a Cancel button, and "Deal from pool"; Escape,
  outside click, or Cancel discard the draft.
- The panel is a labelled `role="dialog"` with real checkbox inputs, keyboard
  operable rows, and focus returned to the trigger on close.

## 4. Verification

- `frontend/src/scenarios.test.ts`: selection resolution ("all" still hides AI
  lessons, an explicit subset is literal, empty pools fall back), grouping
  (chapter/section order, "Other" last), and random draws from a subset.
- Rust manifest tests for the new metadata.
- Gates: `npm run build`, `npm run lint`, `cargo fmt --check`, `cargo test
  --lib`, `cargo clippy`, `wasm-pack build --target web`.
