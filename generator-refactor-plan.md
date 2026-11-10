# Generator Refactor Plan

Status: complete.

This document is the working reference for the `src/generator` refactor. It captures the target architecture, the completed work, the remaining improvements, and the acceptance criteria we verify after each phase.

## Goals

- Keep game logic and generation in Rust/WASM.
- Make every scenario a self-contained module.
- Remove mega-methods: each board builder should be a short orchestration function over named phases.
- Share only genuinely reusable infrastructure: deck handling, table setup, scoring wrappers, formatting, retries.
- Model scenarios explicitly so adding a lesson is a small, predictable change.
- Keep the WASM-facing JSON contract stable while the internal layout changes.
- Keep rejection sampling and generation behavior unchanged during structural refactors.

## Target Architecture

```text
src/generator/
├── mod.rs                          # ScenarioId, manifest, dispatch, public API
├── support/
│   ├── deck.rs                     # Deck newtype, ALL_TILES, draw/take helpers
│   ├── table.rs                    # rounds, scores, opponent dealing, rivers
│   ├── analysis.rs                 # HandMetrics, dora, visibility helpers
│   ├── tiles.rs                    # suji / outside-456 predicates
│   ├── format.rs                   # format_hand_compact
│   ├── retry.rs                    # shared rejection-sampling loop
│   └── testing.rs                  # test-only tile parsing
├── block_theory/
│   ├── shapes.rs                   # sequence / triplet fill helpers
│   ├── random_hand.rs              # 5-block theory hand generator
│   └── ryanmen_protorun/           # ryanmen lesson
│       ├── mod.rs
│       ├── skeleton.rs
│       └── board.rs
├── chiitoitsu_riichi_vs_dama/
│   ├── mod.rs                      # riichi/dama dispatcher
│   ├── triggers.rs                 # RiichiTriggerSet
│   ├── riichi.rs                   # riichi skeleton, dora, river, scoring
│   ├── dama.rs                     # dama skeleton, dora, river, scoring
│   ├── skeleton.rs                 # shared chiitoitsu shape
│   ├── scoring.rs                  # chiitoitsu score helpers
│   └── board/
│       ├── mod.rs                  # board orchestration and assembly
│       └── setup.rs                # hand preparation, dora, deck, river
├── shouminkan_decision/
│   ├── mod.rs                      # Added Kan dispatcher + tests
│   ├── triggers.rs                 # ShouminkanTriggerSet
│   ├── skeleton/
│   │   ├── mod.rs                  # skeleton model + construction loop
│   │   ├── shapes.rs               # waits, pairs, sets
│   │   └── value.rs                # han checks
│   └── board.rs                    # score / round / river assembly
└── (fixtures live in src/fixtures/)
```

The final layout moves `mock_table` out of the generator registry into `src/fixtures/mock_table.rs` and removes the temporary `ScenarioGenerator` compatibility facade.

## Completed

- [x] `generator.rs` split into scenario-oriented modules.
- [x] Shared `Deck`, table, analysis, formatting, and retry helpers extracted.
- [x] `ryanmen_protorun` isolated.
- [x] `chiitoitsu_riichi_vs_dama` split into riichi/dama/skeleton/board.
- [x] `shouminkan_decision` split into triggers/skeleton/board.
- [x] Board builders split into named phases (`prepare_hand`, `build_deck`, `validate_*`, `assemble_state`).
- [x] `ScenarioId` registry introduced with `ALL`, `from_id`, and `generate`.
- [x] `ScenarioMeta` / `SCENARIO_MANIFEST` added with labels, descriptions, categories, and tags.
- [x] `list_scenarios()` WASM export added and consumed by the React picker.
- [x] `mock_table` moved to `src/fixtures` and excluded from the lesson manifest.
- [x] `ScenarioGenerator` compatibility facade removed.
- [x] Unit tests co-located with the scenario they exercise.
- [x] Public API preserved during the structural refactor.
- [x] Native tests: 40 passed.
- [x] Clippy with `-D warnings`: clean.
- [x] WASM browser tests: 9 passed.
- [x] Frontend `npm run build` and `npm run lint`: clean.

## Remaining Improvements

### 1. Strict file-size cleanup

- [x] Split `block_theory/ryanmen_protorun.rs` into `ryanmen_protorun/{mod,skeleton,board}.rs`.
- [x] Split `chiitoitsu_riichi_vs_dama/board.rs` into `board/{mod,setup}.rs`.
- [x] Split `shouminkan_decision/skeleton.rs` into `skeleton/{mod,shapes,value}.rs`.

Target: no production file above roughly 350 lines, with board orchestration functions under roughly 100 lines.

### 2. Scenario metadata manifest

- [x] Add `ScenarioCategory` and `ScenarioMeta`.
- [x] Add a single `SCENARIO_MANIFEST` containing label, description, category, and tags.
- [x] Expose `list_scenarios()` from WASM as JSON.
- [x] Update `frontend/src/scenarios.ts` and `App.tsx` to consume the WASM manifest instead of duplicating scenario metadata.

### 3. Fixture separation

- [x] Move the `mock_table` fixture out of the scenario registry.
- [x] Keep the fixture available for UI scaffolding and existing payload tests without treating it as a lesson.
- [x] Ensure `list_scenarios()` contains only real scenario IDs.

### 4. Remove the compatibility facade

- [x] Migrate `src/lib.rs` and `tests/wasm_tests.rs` off `ScenarioGenerator`.
- [x] Remove `ScenarioGenerator` from the public API.
- [x] Keep `generate_puzzle`, `generate_random_hand`, `format_hand_compact`, and `PuzzleResponse` stable.

## Verification Gates

Run after every phase:

```bash
cargo fmt --check
cargo test --lib
cargo clippy --lib --tests -- -D warnings
cargo check --target wasm32-unknown-unknown
wasm-pack test --headless --chrome
```

For the frontend manifest change, also run:

```bash
wasm-pack build --target web
cd frontend && npm run build && npm run lint
```

## Notes

- Preserve existing draw semantics: `Deck::draw` picks uniformly over available tile types, not weighted by remaining copies.
- Preserve unknown-category fallback to `ryanmen_protorun` unless intentionally changed.
- Keep trigger sets scenario-local until a second scenario needs them.
- `mock_table` is a fixture, not a lesson; it should not shape the lesson abstraction.
- Rejection-sampling timing guards must stay in place.
