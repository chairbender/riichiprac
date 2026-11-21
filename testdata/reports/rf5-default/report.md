# RF5 — replay-first is the shipped default

Task `261119-2340`, 2026-11-20. Acceptance/rollout pass for
[`replay-first-rollout.md`](../../../replay-first-rollout.md) RF5.

## What was already in the build

RF2 set the source model (`DEFAULT_PREFER_REPLAY = true`,
`DEFAULT_SOURCE_FILTER = 'both'`), RF3 added the Replay/Generated/Both filter
and the GENERATED alternative, and RF4 made the first deal fetch a section body
and open on a replay hand. RF5 therefore confirms the shipped behaviour rather
than adding a new switch; the flip itself is the documented default plus the
rollback below.

## Shipped coverage

`node scripts/replay-coverage-report.mjs` over the committed manifest
(`frontend/public/scenarios/manifest.json`):

- 22 of 25 hosted lessons are replay-default at the 40-review-base floor.
- 8,942 reviewed bases across six packs.
- Below the floor (generated default, replay row opt-in): `defense_stuck_heuristic`
  32, `kabe_one_chance` 17, `kabe_double_one_chance` 13.
- No replay row (generated only): `shouminkan_decision`, `daiminkan_decision`,
  `meld_or_not`, `sanshoku_pursuit`.

Machine-readable output and the full table: `coverage.json`, `coverage.txt`.

## Acceptance checks

The suite pins the shipped rule at three levels:

- store: `DEFAULT_PREFER_REPLAY` is true for a fresh browser and a stored
  `preferReplay: false` survives a reload (`useSettingsStore.test.ts`);
- model: a covered lesson's `all` entry is its replay id, a thin lesson keeps
  the generated id, `preferReplay: false` and a missing manifest return the
  generated pool unchanged, and the first deal never picks a thin lesson
  (`scenarios.test.ts`, including the new committed-manifest block);
- app: with the committed manifest, the first deal is a replay hand, the next
  hand is replay too, the picker shows the replay row first with the GENERATED
  opt-in, and the Generated filter persists `preferReplay: false`, deals
  generated hands and requests no further body (`App.pack.test.tsx`,
  `ScenarioPicker.test.tsx`).

Commands and captured output:

| Command | Result | Evidence |
| --- | --- | --- |
| `cd frontend && npm test` | pass — 74 files, 1,539 tests | `frontend-test.txt` |
| `cd frontend && npm run build` | pass | `frontend-build.txt` |
| `cd frontend && npm run lint` | pass | `frontend-lint.txt` |
| `node scripts/replay-coverage-report.mjs --json` | success | `coverage.json` |
| `node scripts/check-pack-hosting.mjs` | PASS (215 checks) | `hosting-check.txt` |

The build prints its usual chunk-size warning; it is advisory and unrelated to
this change.

## Rollback

Recorded in `replay-first-rollout.md` ("Rolling back to generated-first"):

- per user/session: Source → Generated (writes `preferReplay: false`), or tick
  the lesson's GENERATED row;
- build-wide: `DEFAULT_PREFER_REPLAY = false` in
  `frontend/src/store/useSettingsStore.ts`, noting that stored `true` values
  are not migrated;
- the whole source model can stay in place; with the setting off the RF4
  bootstrap returns before requesting a body.

## Sign-off

**Approved 2026-11-20** for the picker and the replay-first default, after the
AGENTS.md §6 hand-off on the live app (`cd frontend && npm run dev`): the
covered lessons' replay-first row order, the GENERATED alternative, the Source
filter starting on Both, and the persisted Generated choice were reviewed
against the description above.
