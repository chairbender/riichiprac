# Replay-first scenario rollout

Status: **approved 2026-11-19**. Wave-1 tasks are in the command center; the
later waves are scheduled as the earlier packs land. This file is the durable
plan; the command-center task ids are recorded in the slicing table at the end.

## Goal

Make **replay-based scenarios the default and prominent source** for every
lesson type that has enough reviewed replay coverage, with the generated
scenarios kept as an explicitly chosen alternative. Lessons without enough
replay coverage keep the generated default until a pack can cover them, so the
app never degrades.

**Every book lesson is in scope.** Where a lesson still has no classifier (four
today), adding that classifier is part of this rollout, not a reason to leave the
lesson replay-less. No lesson is accepted as permanently generated-only without
an explicit decision.

Two product rules:

1. **Replay-first, coverage-aware.** A lesson is "replay-default" only when its
   shipped pack has at least `MIN_REPLAY_BASES` reviewed bases. Until then its
   generated lesson is the default and the replay row (if any) is opt-in, which
   is today's behaviour.
2. **Generated stays available.** Every lesson keeps its generated drill. It
   moves out of the default pool and behind a **Generated** source filter (and
   an optional per-lesson "generated alternative" row). Users can always opt
   into it; nobody loses a lesson.

This is a product-level inversion of the current picker, not a flag:
`ALL_SCENARIOS` currently excludes pack entries, and pack rows are opt-in.

## What exists today

- **Generated lessons** are computed in WASM; nothing is hosted.
- **Two replay packs** ship in `frontend/public/scenarios/`:
  - `replay.ch8-defense.2026-11` — 2,211 bases, 7 ch8 lessons.
  - `replay.ch8-defense-multi-threat.2026-11` — 764 bases, `defense_multi_threat`.
- The picker merges one opt-in row per pack/lesson (`replay:<pack>:<lesson>`);
  `ALL_SCENARIOS` excludes pack rows; replay bodies are fetched lazily and
  verified/cached in IndexedDB. (After RF2 a covered lesson's replay row is the
  default pool entry instead; uncovered rows stay opt-in.)
- The miner/selector can already scope by `--section` and `--lesson`, and the
  classifier covers most lesson families.
- **Four lessons have no classifier at all** and therefore no mining path today:
  `chiitoitsu_riichi_vs_dama` (ch7.2), `chiitoi_vs_toitoi` (ch5.5),
  `sanshoku_pursuit` (ch5.1), `open_hand_defense` (ch8.4). `B4` closes this.

**Gap:** the plan (`replay-implementation-plan.md`) ends at Q2, the first ch8
defense pack. It does not cover replay alternatives for the other chapters, the
per-lesson coverage contract, the classifier gaps, or the replay-first default.
The queued tasks `261112-1826` (real game database as a source) and
`261119-1133` (share the replay database) are adjacent but not this rollout.

## Coverage available from the current corpus

Stable book labels from the 1,542-game AI self-play corpus, classifier v2.
These are raw labels before selection gates and duplicate-hand/lesson floors, so
shipped bases will be lower (the multi-threat lesson: 1,153 labels → 780
selected → 764 shipped).

| Section | Lesson | Stable | Contested | Mining dependency |
| --- | --- | ---: | ---: | --- |
| ch3.2 | protorun_priority | 337 | 37 | ready |
| ch3.2 | pair_count | 223 | 67 | ready |
| ch3.2 | perfect_one_away | 25 | 34 | ready (below floor; corpus C9) |
| ch3.2 | pair_count_open | 21 | 40 | ready (below floor; corpus C9) |
| ch3.3 | skipping_block | 166 | 176 | ready |
| ch3.3 | protorun_plus_one | 108 | 35 | ready |
| ch3.3 | nakabukure_ready | 67 | 160 | ready |
| ch3.3 | nobetan_keep | 3 | 4 | ready (below floor; corpus C9) |
| ch3.3 | ryankan_break | 1 | 3 | ready (below floor; corpus C9) |
| ch4.1 | ryanmen_protorun | 66 | 24 | ready |
| ch5.1 | sanshoku_pursuit | TBD | — | **B4.3 classifier** |
| ch5.3 | pinfu_head | 353 | 1,656 | ready |
| ch5.4 | honitsu_decision | 2,540 | 3,535 | ready |
| ch5.5 | chiitoi_vs_toitoi | TBD | — | **B4.2 classifier** |
| ch7.1 | riichi_judgement | 3,184 | 6,141 | ready |
| ch7.2 | chiitoitsu_riichi_vs_dama | TBD | — | **B4.1 classifier** |
| ch7.3 | dama_bad_wait | 2,664 | 13,071 | ready |
| ch7.3 | dama_genbutsu_wait | 494 | 214 | ready |
| ch7.3 | dama_expensive_hand | 566 | 52 | ready |
| ch7.3 | dama_improving_hand | 137 | 71 | ready |
| ch8.1 | push_or_fold | 4,877 | 4,020 | ready |
| ch8.2 | defense_safety_chart | 17,190 | 7,082 | ready |
| ch8.2 | suji_kabe_safety | 1,755 | 1,683 | ready |
| ch8.2 | defense_multi_threat | 1,153 | 451 | ready |
| ch8.2 | suji_trap_riichi | 0 | 0 | ready (corpus C9) |
| ch8.2 | kabe_no_chance | 0 | 0 | ready (corpus C9) |
| ch8.2 | kabe_one_chance | 60 | 88 | ready |
| ch8.2 | kabe_double_one_chance | 55 | 84 | ready |
| ch8.2 | kabe_suji_defense | 32 | 28 | ready (below floor; corpus C9) |
| ch8.3 | fold_to_riichi | 28,694 | 5,182 | ready |
| ch8.3 | defense_stuck_heuristic | 211 | 217 | ready |
| ch8.4 | open_hand_defense | TBD | — | **B4.4 classifier** |
| ch9.1 | meld_or_not | 0 | 15 | ready (corpus C9) |
| ch9.3 | ankan_decision | 69 | 41 | ready |
| ch9.3 | shouminkan_decision | 20 | 26 | ready (below floor; corpus C9) |
| ch9.3 | daiminkan_decision | 8 | 1 | ready (below floor; corpus C9) |
| ch9.4 | wind_discard_order | 701 | 364 | ready |

Proposed coverage floor: **40 reviewed bases per lesson** (product decision, see
open questions). Lessons at or above the floor can become replay-default; the
rest stay generated by default until coverage exists. No book lesson is excluded:
the four classifier-less lessons get a recogniser in `B4`, and the
classifier-ready but thin/zero lessons are corpus-growth targets (`C9`).

## Design decisions

### Source tiers

- `replay` — a curated pack row; default when `coverage >= floor`.
- `generated` — the WASM lesson; default when there is no coverage, and an
  explicit alternative everywhere else.
- The picker's default pool is built per lesson: replay id if covered and
  `preferReplay` is on, otherwise the generated id.
- A per-session/per-user setting `preferReplay` (default **on**) and a picker
  source filter: **Replay (default) · Generated · Both**.
- For a covered lesson, both rows exist; the generated row is labelled
  "generated" and sits after the replay row, or behind the filter.

**Status (RF2, 2026-11-19).** The source model is implemented in
`frontend/src/scenarios.ts`: `lessonReplayCoverage()` reads the manifest's
`lesson_counts` without a body, and `allScenarioIds()` / `selectionPool()` swap
a covered lesson's generated id for its replay row (`replay:<pack>:<lesson>`)
when `preferReplay` is on and the count reaches `MIN_REPLAY_BASES` (40, with a
per-call override). `preferReplay` is in the settings store, default on and
persisted under `riichiprac.settings`. Everything else is unchanged: an
uncovered lesson, a missing/empty manifest, or `preferReplay: false` produces
the generated pool exactly as before, and generated rows stay pickable by name.
The pool is defined over the generated catalogue, so a pack-only lesson (no
generated sibling) is not dealt from `all` — it has no generated fallback. A
deal snapshots the manifest when it starts, so a launch's first hand is still
generated until RF4 fetches a section body. A replay body that fails (offline,
stale cache, integrity) falls back to the same lesson's generated drill for that
hand and leaves the reason in the picker's pack note.

**Status (RF3, 2026-11-19).** The picker now carries a **Source** filter with
three states — Replay, Generated, Both — plus the per-row source labels. A
lesson at or above the floor lists its replay row first and its generated row
second, marked **GENERATED** as the opt-in alternative; a lesson below the floor
keeps the pre-RF2 order (generated, then its opt-in replay row) and a lesson
with no replay row is always listed as generated, even under the Replay filter,
so it stays reachable. Filtering changes which rows are listed, not the ticks
already made. The Generated filter is also the user-facing form of
`preferReplay`: it persists the setting as off and makes `all` deal generated
ids, while Replay and Both turn it back on. `mergePackLessons` now copies each
row's reviewed-base count onto `pack.bases`, and `defaultScenarioIds` expands
`all` from the merged catalogue so the picker's ticks match what the deal will
actually draw (a covered lesson stands for its replay row). The picker's pack
note explains the model instead of calling replay rows opt-in. Tests cover the
filter's DOM/ARIA, row order and badges, tab order into the filter, the filter
and ticks surviving a selection change, and both row kinds still dealing their
own lesson.

### Per-lesson counts in the manifest

The app must decide coverage **without downloading bodies**. Today the manifest
lists `lesson_ids` but not counts. Extend the manifest entry with
`lesson_counts` (lesson id → shipped reviewed bases) at publish time, validated
against the body in `pack publish`/the pack checks. A **base** is a scenario
selected from the corpus; a variant derives from one base and adds no review
coverage, so it is not counted. A recorded count that disagrees with the body is
an audit error; an absent map is accepted (and warned about under `--strict`),
so a manifest published before the field still loads. This is
backward-compatible within manifest v1 as an optional field (bump the schema
only if the parser requires it).

### Pack granularity

One pack per **book section** (ch3.2, ch3.3, ch4.1, ch5.1/5.3/5.4/5.5, ch7.1,
ch7.2/7.3, ch8.2, ch8.4, ch9.3, ch9.4), not one pack per lesson:

- one body fetch covers several lessons;
- the manifest stays small and the per-lesson coverage is explicit;
- the existing ch8 pack and multi-threat pack remain as the first two.

Only add a **starter pack** if the first-deal strategy needs one (below).

### First deal

If replay is the default, the first deal needs a pack body. Options:

- **A. Starter pack**: a small cross-section pack for the first deal. Extra pack
  type and curation; best cold-start cost.
- **B. Warmup**: first deal is generated; replay-first applies after the
  manifest load / the next deal. No new pack, but the first impression is still
  generated.
- **C. Fetch the default section on first deal**: pick a default lesson among
  the prominent covered sections, fetch its body, show a brief loading state,
  and fall back to generated if offline or slow.

Recommendation: **C**, measured. It makes replay-first true from the first deal
at the cost of one section body (roughly 0.2–2 MB, cached by content address).
A starter pack can be added later if cold-start measurements justify it.

### Classifier gaps are in scope (`B4`)

Four lessons have a generator but no classifier, so nothing can mine them. A
replay alternative for them requires the recogniser first:

| Lesson | Section | Task | Notes |
| --- | --- | --- | --- |
| `chiitoitsu_riichi_vs_dama` | ch7.2 | B4.1 | Riichi/dama cell; may overlap `riichi_judgement`/`dama_*`; use the existing Mortal tiebreak |
| `chiitoi_vs_toitoi` | ch5.5 | B4.2 | Yaku-choice cell: keep chiitoitsu when a pair is futile, else build toitoi |
| `sanshoku_pursuit` | ch5.1 | B4.3 | Floating-tile pursuit: keep the redundant tile only without another yaku/dora |
| `open_hand_defense` | ch8.4 | B4.4 | Hardest: read the post-chii neighbourhood from an arbitrary table, positive and trap cases |

**One `B4` task covers all four**, because `CLASSIFIER_VERSION` is part of the
label cache key: each classifier change bumps the version and invalidates every
cached label (~1 hour of Mortal re-evaluation on the 14-core box). Splitting the
four across four tasks would pay that four times. The task lands four
recognisers, one version bump, one label pass, and a per-lesson
stable/contested yield report. If the work needs to be split, the split is
code-only branches that land together before the bump.

Acceptance for each recogniser:

- recognises the generator's own boards and refuses the documented near-misses;
- registered in `CLASSIFIERS` with a transform policy;
- `Match::validate` passes on its own boards;
- the cross-lesson disagreement guards still hold (or the conflict is
  documented and Mortal-arbitrated);
- the label pass reports the stable/contested yield, which feeds the pack task.

### Realism: AI self-play vs human games

Today's "replay" is **AI self-play** (Mortal/Akochan). It is more realistic than
a constructed hand but not a human game. The real-human-game source is a separate
workstream (existing task `261112-1826`; data-sharing question `261119-1133`).
The rollout should state this explicitly so "replay-first" does not silently
claim human realism. A research task (D1) decides whether and when to add a
human corpus and what licence/profile it needs.

## Work breakdown

Sizes are worktree-sized. Each pack task includes select → mechanical review →
sampled review → assemble → audit → publish → checks. Each classifier task
includes its recogniser tests and a label-yield pass.

### Wave 1 — classifiers, foundation, highest-yield pack

**B4 — Classifiers for the four generated-only lessons** (`riichiprac`, worktree)
- `chiitoitsu_riichi_vs_dama`, `chiitoi_vs_toitoi`, `sanshoku_pursuit`,
  `open_hand_defense` (B4.1–B4.4), one `CLASSIFIER_VERSION` bump, one label pass,
  per-lesson yield report.
- Unlocks ch7.2, ch5.1, ch5.5, ch8.4 for every later pack.
- Accept: recognisers/tests/registration; labels stable/contested reported;
  existing lesson labels unchanged except documented conflicts.

**RF1 — Pack manifest per-lesson coverage** (`riichiprac`, worktree)
- Add `lesson_counts` to the pack manifest/publish; validate against the body
  and the audit; update `check-pack-hosting`/`check-ch8-pack` and the frontend
  parser.
- Accept: counts present for both existing packs, validated, no body download
  needed to read them; tests.

**RF2 — Replay-first source model** (`riichiprac`, worktree)
- Per-lesson coverage from the manifest + floor; default pool builder uses the
  replay id where covered and the generated id otherwise; `preferReplay` setting
  (default on); generated rows remain selectable.
- Accept: unit tests for covered/uncovered/forced-generated/offline; no change
  to the generated-only behaviour when no manifest exists.
- Landed 2026-11-19: see "Status (RF2)" under *Source tiers*; the picker note
  still describes the pre-filter behaviour until RF3.

**Q3 — ch7 riichi/dama pack** (`riichiprac`, worktree)
- Lessons: `riichi_judgement`, **`chiitoitsu_riichi_vs_dama` (from B4.1)**,
  `dama_bad_wait`, `dama_genbutsu_wait`, `dama_expensive_hand`,
  `dama_improving_hand`; target ≥40 bases each.
- Select `--section ch7`; mechanical + sampled review; publish as
  `replay.ch7-riichi-dama.2026-11`; update the manifest.
- Accept: all gates, coverage report, picker rows.

**RF3 — Picker source filter and generated opt-in** (`riichiprac`, worktree)
- Replay/Generated/Both filter, per-row source labels, help text; generated
  rows secondary for covered lessons.
- Accept: vitest DOM/ARIA assertions; keyboard/focus order; selection persists.
- Landed 2026-11-19: see "Status (RF3)" under *Source tiers*.

### Wave 2 — more packs + first-deal

**RF4 — First-deal loading** (`riichiprac`, worktree)
- Implement strategy C (or the chosen alternative); loading/fallback state;
  cold-start measurement (manifest + body bytes, ms, cache hit); record in the
  docs.
- Accept: first deal is replay when online and covered; generated fallback when
  offline/error; no pack body when replay is off.

**Q4 — ch5 value pack** (`riichiprac`, worktree)
- `honitsu_decision` (2,540), `pinfu_head` (353), **`sanshoku_pursuit` (B4.3)**,
  **`chiitoi_vs_toitoi` (B4.2)**; target ≥40 each (chiitoi/sanshoku measured
  after B4's label pass).

**Q5 — ch9 seating/kan pack** (`riichiprac`, worktree)
- `wind_discard_order` (701) first; decide whether the thin kan/call lessons
  (`ankan` 69, `shouminkan` 20, `daiminkan` 8, `meld_or_not` 0) ship now, later,
  or stay generated until C9.

**C9 — corpus growth for thin lessons** (`riichiprac-corpus`, worktree)
- Grow the AI self-play corpus for the below-floor lessons (perfect_one_away,
  pair_count_open, nobetan_keep, ryankan_break, kabe_suji_defense,
  shouminkan_decision, daiminkan_decision, meld_or_not, suji_trap_riichi,
  kabe_no_chance) and any B4 lesson that lands thin; report stable yield per
  lesson per 100 games.

### Wave 3 — coverage completion + default flip

**Q6 — ch3/4 shape pack** (`riichiprac`, worktree)
- `protorun_priority` (337), `pair_count` (223), `skipping_block` (166),
  `protorun_plus_one` (108), `nakabukure_ready` (67), `ryanmen_protorun` (66).
  Thin lessons stay generated until C9.

**Q7 — ch8 completion** (`riichiprac`, worktree)
- **`open_hand_defense` (B4.4)**, plus `suji_trap_riichi`, `kabe_no_chance`,
  `kabe_suji_defense` as coverage allows; record anything still generated-only.

**RF5 — Flip to replay-first by default** (`riichiprac`, worktree)
- Turn `preferReplay` on for the build after coverage is sufficient; keep the
  setting and a documented rollback; update README/hosting/picker docs.
- Accept: replay-default for every covered lesson; generated default for the
  rest; a user can force generated; sign-off on the picker.

**D1 — Real-game source evaluation** (research, `none` or scratch)
- Licensing/format/rule-profile review for a human corpus; compare to AI
  self-play; decide whether "replay-first" should eventually mean human games.
- Reference `261112-1826` and `261119-1133`.

### Sequencing

```text
B4 (4 classifiers + label pass) ─┬─ Q3 (ch7, incl. chiitoitsu)
                                 ├─ Q4 (ch5, incl. sanshoku + chiitoi)
                                 └─ Q7 (ch8, incl. open-hand defense)
RF1 ── RF2 ── RF3 ── RF4 ── RF5
Q5, Q6 ────────────────────── increment coverage; each enables that lesson's flip
C9 ────────────────────────── grows the below-floor lessons
D1 ────────────────────────── independent research
```

B4 is the first task because three of the later packs depend on it; RF1/RF2 can
run in parallel because they need no new classifier. Create wave 1 now (B4, RF1,
RF2, Q3, RF3); the later tasks once the first packs and the source model land,
per the plan's own "create the current wave" rule.

## Acceptance gates (every pack)

- ≥ `MIN_REPLAY_BASES` reviewed bases for each shipped lesson; a lesson below
  the floor is not shipped (or is shipped as opt-in, never as the default).
- Mechanical review 100%; sampled human review and user sign-off.
- Audit clean; hosting, ch8-content and serving checks pass for the whole
  hosted set; old pack bodies/hashes unchanged.
- Manifest carries `lesson_counts`; the picker shows the replay row; the
  coverage report names which lessons are replay-default.
- No regression for generated lessons; the app still works with no manifest.

## Open questions for the user

1. **Coverage floor**: 40 reviewed bases per lesson (recommended) or another
   number? This decides which thin lessons become replay-default.
2. **Pack granularity**: one pack per book section (recommended) or one pack per
   chapter, or per lesson?
3. **First deal**: fetch a default section body (recommended), a starter pack,
   or a generated warmup deal?
4. **Generated visibility**: behind a source filter (recommended) or kept
   visible as a secondary row for every covered lesson?
5. **Real games**: is "replay-based" expected to mean human games eventually
   (D1), or is AI self-play sufficient for now?
6. **B4 batching**: one task covering all four classifiers (recommended, one
   `CLASSIFIER_VERSION` bump and one label pass) or four tasks that pay the
   cache invalidation four times?
7. **Rollout order**: ch7 first (recommended, highest yield and core decision)
   vs ch5/honitsu next.

## Docs to update when this is approved

- `replay-implementation-plan.md`: add this rollout as §11, extend §0 scope and
  §9's definition of done from "first pack" to "replay-first catalogue".
- `replay-strategy.md`: product policy (replay-first, coverage floor, generated
  fallback), the four classifier gaps, and the AI-vs-human distinction.
- `replay-miner-operations.md`: manifest `lesson_counts`, per-section packs,
  coverage reporting, per-lesson floors, and the classifier-version bump rule
  for new recognisers.
- `hosting-plan.md` §7: multiple packs, budget as sections accumulate, mirror
  threshold.
- `README.md`: scenario sources, default behaviour, how to choose generated.
- `AGENTS.md` §4: state that replay is the default source when covered and
  generated is the fallback/opt-in (once RF5 lands).

## Command-center slicing (proposed)

Create the current wave only:

| Task title | id | Type | Depends on |
| --- | --- | --- | --- |
| `Replay B4: classifiers for the four generated-only lessons` | `261119-1718` | worktree `riichiprac` | — |
| `Replay-first RF1: pack manifest per-lesson coverage` | `261119-1719` | worktree `riichiprac` | — |
| `Replay-first RF2: replay-default source model and pool` | `261119-171918` | worktree `riichiprac` | RF1 |
| `Replay-first RF3: picker source filter and generated opt-in` | `261119-171926` | worktree `riichiprac` | RF2 |
| `Replay Q3: ch7 riichi/dama pack` | `261119-171935` | worktree `riichiprac` | B4 |

Later waves: RF4, Q4, Q5, C9, Q6, Q7, RF5, D1 as above.

## Expected end state

- Every book lesson has a replay alternative; the picker opens with replay rows
  for every covered lesson and generated rows are still there but not the
  default.
- The four classifier gaps are closed, so `chiitoitsu_riichi_vs_dama`,
  `chiitoi_vs_toitoi`, `sanshoku_pursuit` and `open_hand_defense` have real
  replay bases like the rest.
- A user who wants generated drills selects the Generated filter; nothing is
  removed.
- Coverage is explicit and measured; a lesson with insufficient replay data
  quietly keeps the generated default instead of shipping a thin replay pack.
- The live app serves several small section packs same-origin, with the manifest
  and lazy bodies as today; the first deal may fetch one section body, measured
  and documented.
