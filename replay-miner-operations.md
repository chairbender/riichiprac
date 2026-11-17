# Replay miner operations: data root, provenance, storage, replays, labels and candidate triggers (F1, R1, R2, L1, L2, S1)

Status: implemented foundation (F1), replay reader/validator (R1), the walker /
`GameState` reconstruction (R2), the native Mortal labeler with Q values and
the label cache (L1), book/Mortal agreement with contested marking,
percentile hooks and optional calibration (L2), and the cheap candidate
triggers with family filters (S1) of
[`replay-implementation-plan.md`](replay-implementation-plan.md) §5.3. This
document is the operator contract for the native-only miner. It does not re-open
the source decision: [`replay-strategy.md`](replay-strategy.md) §2 fixes AI
self-play as the only replay source.

F1 creates the feature boundary, provenance types, source/licence/rule gates,
the local data root, the SQLite schema, atomic writes, a funnel counter and the
CLI stubs. R1 adds the gzipped mjai reader and the structural replay validator in
`src/replay/` plus its fixtures. R2 adds `src/replay/walk.rs`: the kyoku walker,
the seat-normalised `GameState` snapshots, decision enumeration and the
`tenhou6` reviewer export. L1 adds `src/miner/label/`: native batch inference
with the app's own MIT Candle port, the per-action Q values the browser drops,
the `q_gap_top2`/`q_gap_safe` measurements, the book/Mortal label and the
`model_labels` cache behind `mine_replays label`. L2 adds the
`stable`/`contested`/`unresolved` agreement classification, the optional
multi-model vote path, the per-family percentile-threshold hook and the optional
versioned Q→point calibration, all in `src/miner/label/`. S1 adds
`src/miner/trigger/`: the model-free defensive/offensive/book/call/score
triggers, the label-derived close-call/blunder triggers, the candidate-family
mapping and filter, and the corpus sample precision/recall report. Book
classification (B1/B2/B3) already exists in `src/classifier/`; the remaining
selection stages, transforms and the pack publisher remain S2/S3 and P1a onward.

## Build boundary

The miner is native-only. `src/miner/`, `src/replay/` and
`src/bin/mine_replays.rs` are behind the `miner` Cargo feature; the binary
declares `required-features = ["miner"]`.

```bash
# Shipped app target: no miner modules, no native dependencies, WASM-clean.
cargo check --target wasm32-unknown-unknown
cargo test --lib

# Miner library and CLI (native only).
cargo test --features miner
cargo clippy --all-targets --features miner -- -D warnings
cargo run --features miner --bin mine_replays -- --help
```

`cargo tree --features miner` must contain no `libriichi`. Mortal code and
weights stay in the separate `riichiprac-corpus` process/repo; the app labels a
reconstructed `GameState` with its own MIT inference.

Enabling `miner` for `wasm32` is a compile error by design.

## CLI surface

```text
mine_replays [--data-dir DIR] <command>

  corpus [report]   generate mixed-agent self-play corpora / report by family
  ingest            ingest and validate raw self-play logs
  extract           reconstruct decision points from validated logs
  label             label reconstructed decisions with Mortal + book classifiers
  triggers          report cheap candidate triggers and family precision/recall
  transform         generate label-preserving scenario variants
  pack              assemble, audit and export scenario packs
  audit             audit provenance, licences and pack integrity
  review            work the human review queue
```

`label` (L1 with the L2 agreement/calibration extensions), `triggers` (S1) and
`pack fixture`, `pack report` and `audit` (P1a) are implemented. The remaining
commands still resolve the data root, report the command they would run, and
exit with code 2, so a script cannot treat a stub as a successful run.

```bash
cargo run --features miner --bin mine_replays -- label \
  --weights frontend/public/models/mortal_298k.safetensors \
  [--models OTHER.safetensors,...] [--calibration CAL.json] \
  [--replays DIR] [--family NAME] [--limit N] \
  [--classifier-version V] [--gamma F] [--pts a,b,c,d] \
  [--trigger book,defensive_riichi,...] [--json]
```

`label` walks every `$RIICHI_DATA_DIR/replays/<family>/*.jsonl.gz` replay (or
`--replays`/`--family`), labels each R2 decision and writes the cache plus any
existing `decisions` row. Exit code is 1 when a replay or decision failed and 2
when the run could not start (missing weights/replay dir, DB error): a partial
run is never reported as success. `--json` prints the machine-readable report.

`--models` names **additional** checkpoints for the optional multi-model vote
pass; `--weights` is still the primary labeler. With no extra checkpoint the run
is single-model, which is the normal path and is never described as an ensemble
or a consensus. `--calibration` applies a versioned Q→point calibration (see
"Q→point calibration" below); it is recomputed from the cached raw Q values, so
changing it never re-runs the model.

`--trigger` is the S1 cheap prefilter: a decision whose selected trigger does not
fire is skipped **before** the forward pass. The accepted names are `book`,
`defensive_riichi`, `offensive_architecture`, `call_kan` and `score_placement`
(the strategy's short forms `defensive`, `offensive`, `call` and `score` are
aliases). `close_call` and `blunder` are rejected here: they read a model label,
so they cannot decide whether a model pass is needed. The trigger reasons are
written onto an existing `decisions` row even for a filtered-out decision.

```bash
cargo run --features miner --bin mine_replays -- triggers \
  [--replays DIR] [--family NAME] [--limit N] [--families LIST] \
  [--dry-run] [--json]
```

`triggers` walks the shard, evaluates every model-free trigger plus the
label-derived triggers when a cached label exists, reads labels from
`decisions.label_json` then the `model_labels` cache (never a forward pass), and
prints one row per trigger with fired/measured/target counts, precision/recall
and the evidence basis. It never inserts a `decisions` row; with no extracted
row it still reports, and `--dry-run` skips the trigger-column writes. The
committed acceptance sample is [`selection-trigger-sample.md`](selection-trigger-sample.md).

The trigger codes are `book:<section>` (`book:ch8.4`), `defensive_riichi`,
`offensive_architecture`, `call_kan`, `score_placement`, `close_call` and
`blunder`. `decisions.trigger` holds the most specific code and
`decisions.trigger_detail` holds the full `riichiprac.candidate-trigger` v1 JSON,
so selection can read every reason and the candidate families.

## Data root

Default: `$RIICHI_DATA_DIR`, else `$HOME/riichiprac-data`. The root lives
outside both repositories. If an operator puts it inside a checkout, the
provided `.gitignore` entries keep the logs, databases and packs out of git.

```text
$RIICHI_DATA_DIR/
├── replays/
│   └── <family>/<replay_id>.jsonl.gz       # immutable raw self-play logs
├── db/
│   └── miner.sqlite                        # operational DB / source of truth
├── snapshots/
│   └── miner-YYYYMMDD-HHMMSS.sqlite        # VACUUM INTO snapshots
├── packs/
│   └── <pack-id>-<sha256-prefix>.json.gz   # generated pack exports
├── tmp/                                    # atomic-write staging
└── logs/                                   # run and backup logs
```

`analytics.duckdb` / Parquet is an optional derived export from `miner.sqlite`,
not a backup target and not part of F1.

The miner runs **local-only**. It never reads or writes a live database on a
Google Drive mount. Drive is backup/transport; see the rclone contract below.

### Relative paths

The database stores paths relative to the data root and never an absolute host
path or a username. `validate_relative_path` rejects:

- absolute paths (`/...`) and Windows drive prefixes (`C:...`);
- `..` traversal, `.` components and backslashes;
- empty paths.

A replay log is exactly
`replays/<family>/<64-hex replay_id>.jsonl.gz`. `replay_id` is the SHA-256 of
the canonical raw log. Raw logs are immutable: a regenerated game with a
different hash is a new file, never an overwrite. A seed mismatch is a
reproducibility bug to investigate.

## JSON schemas and versioning

Every serialised miner document carries `schema` and `version`.

| Schema string | Constant | Document |
| --- | --- | --- |
| `riichiprac.corpus-game` | `CORPUS_GAME_SCHEMA` | one generated game's provenance |
| `riichiprac.corpus-match-plan` | `CORPUS_MATCH_PLAN_SCHEMA` | corpus match plan |
| `riichiprac.scenario-transforms` | `SCENARIO_TRANSFORMS_SCHEMA` | transform chain |
| `riichiprac.scenario-pack` | `SCENARIO_PACK_SCHEMA` | shipped scenario pack |
| `riichiprac.scenario-pack-manifest` | `SCENARIO_PACK_MANIFEST_SCHEMA` | pack manifest |

A match plan stores `rule_profile` as a `RuleProfile` object (not just a profile
name) so the exact red-five/kuitan/starting-score/return/uma/kan-dora settings
travel with the plan. A game's log path must be exactly
`replays/<family>/<replay_id>.jsonl.gz`; validation rejects any other relative
path, because the replay store is content-addressed and family-scoped.

Rules:

- Within a version, change is **additive**: new optional fields use
  `#[serde(default)]`, and unknown fields are ignored so an old reader can read
  a newer file that only added fields.
- A breaking change (renamed/removed field, changed meaning or units) increments
  `version`. A reader rejects an unknown version rather than guessing.
- `source` is not additive: a value other than `ai_selfplay` fails to
  deserialize. There is no "unknown source" fallback.
- The pack and transform schema names are declared in F1 so later units cannot
  invent a second spelling.

## Source gate (fail closed)

`SourceKind` can only hold `ai_selfplay`. `SourceGate::check` trims and requires
an exact match; `SourceKind` deserialization rejects everything else, so a
third-party corpus cannot enter through a JSON field. The `replays` table also
has `CHECK (source = 'ai_selfplay')` as a second line of defence.

Rejected examples (all covered by tests): `tenhou`, `tenhou_houou`, `tenhou6`,
`mjlog`, `mahjong_soul`, `majsoul`, `riichi_city`, `hime_mahjong`, `m_league`,
`user_import`, `byo_replay`, `huggingface`, `kaggle`, `human`, and blank or
case-varied spellings. A new source needs a new product/legal decision and an
allowlist change, not a data-file value.

## Licence gate

`LicenseInfo` records `id`, `attribution`, `data_commercial_use` and
`source_url`. Validation rejects an empty/unknown id, an empty attribution, a
missing URL and a non-http(s) URL.

- Known ids: `CC-BY-4.0`, `CC0-1.0`, `MIT` (data and code), `AGPL-3.0` (Mortal
  code/weights), `akochan-custom` (Akochan terms).
- Shipped pack **data** must use one of `CC-BY-4.0`, `CC0-1.0`, `MIT`.
- `data_commercial_use` for a pack is the logical AND over every contributing
  agent. A pack with any Akochan game is non-commercial even if another agent's
  flag is true; no contributors means no commercial grant.

The publisher (P1a) enforces the allowlist and the commercial profile; F1
defines the types and the helper.

## Rule profile

`RuleProfile` records the canonical profile name plus the exact engine settings:
red-five count, kuitan, starting score, return score, uma and kan dora, with a
hash of the full engine configuration. A match plan's `rule_profile` field is
this object, not just the profile string, so the exact engine configuration is
recorded with every plan.

Only `tenhou-4p-hanchan` is supported. Validation rejects a different profile,
a different red-five count, no kuitan, a starting score other than 25000, a
return score other than 30000, or kan dora disabled. A sanma or local-yaku
engine cannot be silently normalised into the app's `GameState`; it is rejected
for that corpus. `uma` is recorded verbatim from the engine because the app
state model does not use it.

## Operational database

`db/miner.sqlite` is the source of truth for candidate and curated scenarios.
It is a single transactional SQLite file, created and migrated on open
(`PRAGMA user_version = 2`).

| Table | Purpose |
| --- | --- |
| `corpus_runs` | one generation run: plan, family, replay count, local/Drive dir, snapshot, rclone status |
| `replays` | one immutable game: source, licence, rule profile, log path/bytes/hash, validation, agent roster, full provenance JSON |
| `decisions` | one decision point: state hash/JSON, legal/played actions, trigger, book match, Mortal label, Q values (units `model_utility`), L2 `label_kind`/`label_source` agreement classification, selection fields |
| `model_labels` | L1 cache: status/attempts/label JSON per `(state_hash, model_sha256, classifier_version, options_hash)` |
| `selected_scenarios` | curated rows: decision, pack, lesson, correct/accepted action, label fields, variant base, transform chain, provenance |
| `variants` | transform output: base scenario, chain, seed, label-preserved flag, rejection reason |
| `packs` | generated pack metadata: hash, bytes, count, source mix, licence, commercial flag, export path, DB snapshot |
| `backups` | replay copies and DB snapshots with hash/bytes/verification |

Foreign keys are enabled per connection. The schema extends the strategy §4.2
sketch with `family`, `match_plan_id`, the agent roster, trigger fields, Q-value
units and label provenance.

`decisions.state_json` holds the complete reconstructed `GameState`; a pack is a
deterministic export of `selected_scenarios` + `variants`, and the app never
loads SQLite.

### Snapshot and integrity check

Never copy a live SQLite file and never put one on a Drive mount. Snapshot with
`VACUUM INTO` and verify the copy:

```bash
STAMP=$(date +%Y%m%d-%H%M%S)
SNAP="$RIICHI_DATA_DIR/snapshots/miner-$STAMP.sqlite"
sqlite3 "$RIICHI_DATA_DIR/db/miner.sqlite" "VACUUM INTO '$SNAP'"
sqlite3 "$SNAP" "PRAGMA integrity_check;"   # must print: ok
```

The code path is `snapshot_database`: it refuses to overwrite an existing
snapshot and runs `PRAGMA integrity_check` on the new file. Snapshot after each
corpus run, labelling pass, selection pass and pack build. Keep the last N
snapshots (for example 7 daily + 4 weekly).

## Optional Google Drive backup (rclone)

Drive backup is a separate operator task, not a code dependency. The miner must
run with no remote configured. Credentials and the remote name live in the
operator's rclone config, never in either repository.

Configure the remote for the process:

```bash
export RIICHI_RCLONE_REMOTE='gdrive:riichiprac'
```

When it is unset, `plan_replay_backup` and `plan_snapshot_backup` return
`Skipped` and no command runs (tested). When set, the plans are:

```bash
# Append-only raw-log copy. `copy` never deletes and `--immutable` refuses to
# overwrite an existing raw log.
rclone copy --checksum --immutable \
  "$RIICHI_DATA_DIR/replays" gdrive:riichiprac/replays
rclone check "$RIICHI_DATA_DIR/replays" gdrive:riichiprac/replays --checksum

# Timestamped DB snapshot, never the live database.
rclone copy "$SNAP" gdrive:riichiprac/db/
```

F1 only prepares these commands; the corpus/ops units execute them and record
the result in `corpus_runs.rclone_status` (`ok`, `failed`, or `skipped`).

### Restore

1. Restore the replay folder: `rclone copy gdrive:riichiprac/replays \
   "$RIICHI_DATA_DIR/replays"`.
2. Pick a timestamped `miner-*.sqlite` from `gdrive:riichiprac/db/` and copy it
   to `$RIICHI_DATA_DIR/db/miner.sqlite` (or a scratch name).
3. Run `PRAGMA integrity_check` and confirm it prints `ok`.
4. Verify a sample of `replay_id` hashes against the restored log files.

The database is also rebuildable from the raw corpus plus
`(model_sha256, classifier_version, transform_version)`; the raw logs and the
curated rows are what the backup protects.

## Atomic writes

`write_atomic(path, bytes)` writes a unique sibling temp file, syncs it, renames
it over the target and syncs the directory. On any error the old target remains
untouched and the temp file is removed. It is used for logs, snapshots metadata,
manifests and pack exports; generated images/assets are not part of F1.

## Replay format and validation contract (R1)

Status: implemented. `src/replay/` reads gzipped mjai JSONL and rejects a
structurally impossible game before R2 reconstructs anything.

### Accepted input

- One complete game, one JSON object per line, gzip-compressed. The ingestion
  entry point is `ReplayReader::read_path`; it requires the gzip magic and
  rejects a plain file behind a `.jsonl.gz` name.
- Events: `start_game` (optional, first), `start_kyoku`, `tsumo`, `dahai`,
  `chi`, `pon`, `daiminkan`, `ankan`, `kakan`, `dora`, `reach`,
  `reach_accepted`, `hora`, `ryukyoku`, `end_kyoku`, `end_game`.
- Deliberate narrowings of the mjai schema: four seats only; `start_kyoku`
  must carry `scores` and four 13-tile `tehais`; `?` is rejected because a
  replay has no hidden tiles. `hora` and `ryukyoku` accept the union of fields
  the common writers emit (`pai`, `deltas`, `scores`, `ura_markers`, `reason`,
  `tehais`); absent optional fields are tolerated.
- Rejected: `hello`, `join`, `none`, unknown events, and any
  Tenhou/Mahjong Soul/Riichi City/Hime document. There is no third-party
  parser in this path.

### Structural rules

- A game starts at E1 with 25 000 each and ends with `end_game`. Every kyoku is
  `start_kyoku` … `(hora|ryukyoku)` … `end_kyoku`.
- Turn order: the dealer draws first; after a discard the next seat may call or
  draw; after chi/pon the caller discards; after a kan its owner draws the
  replacement. `tsumogiri=true` must name the tile just drawn.
- Calls: only the open discard can be claimed; chi only by the seat on the
  discarder's left; the consumed tiles are held; chi is a run, pon/daiminkan a
  triplet/four-of-a-kind, kakan upgrades an existing pon; a riichi seat cannot
  call (an ankan is allowed; R2 checks that the wait is unchanged).
- Ledger: 52 tiles are dealt and every draw adds one; hands + melds + rivers
  must equal `52 + draws` at `end_kyoku`. Each seat holds `13 - 3·melds`
  concealed tiles (`14 - 3·melds` while holding a draw). No fifth copy of a
  tile and no second red five of a suit, including the dead-wall indicators.
- Wall: 70 live draws. A kan's replacement draw is a `tsumo` and counts as one
  draw (the dead wall is replenished from the live wall), so an exhaustive draw
  ends at exactly 70. R2's `tiles_remaining` is `70 - tsumo_events`.
- Dora: the `start_kyoku` marker plus one new `dora` per **completed** kan
  (`1 + revealed kan dora`). A robbed kakan never reveals its indicator. A
  pending indicator must appear before the kan's owner next discards; a
  chankan `hora` may end the hand first.
- Chankan: a `hora` immediately after an `ankan` or `kakan` is accepted, with
  the declared tile as the winning tile.
- Scores: `Σscores + 1000·kyotaku == 100 000` at every kyoku boundary, and the
  next `start_kyoku` scores equal the previous result after riichi deductions
  and deltas. A dealer win repeats the round; a non-dealer win advances it; an
  abortive draw repeats it; an exhaustive draw may repeat or advance because
  tenpai is not in the record.
- Yaku, waits, furiten and point values are not validated here. A `hora`
  without `deltas`/`scores` is accepted structurally; R2 owns the label.

### Fixtures

- `testdata/replays/one_kyoku_hora.jsonl` — one kyoku with chi, pon,
  daiminkan, ankan, kakan, three kan dora, a riichi declaration/acceptance and
  a ron with ura markers; every event kind except `ryukyoku`.
- `testdata/replays/one_kyoku_ryukyoku.jsonl` — a 70-draw exhaustive draw.
- Both are generated by `src/replay/fixtures.rs` (test-only). The
  `committed_fixtures_are_current` test fails if code and files drift;
  regenerate with
  `cargo test --features miner regenerate_committed_fixtures -- --ignored`.

## R1 acceptance evidence
- `cargo test --features miner` covers the tile mapping including red fives,
  every event shape, line-numbered parse errors, the expected event list of the
  1-kyoku fixture, a typed error for every malformed fixture, the tile ledger,
  the 70-draw wall, the score/kyotaku chain, a chankan, an abortive draw, a
  two-kyoku game, gzip path ingestion and 100 synthetic games.
- `cargo clippy --all-targets --features miner -- -D warnings` and
  `cargo check --target wasm32-unknown-unknown` stay clean;
  `cargo tree --features miner` contains no `libriichi`.
- Visual sign-off is not involved in R1.

## Replay walker and `GameState` reconstruction contract (R2)

Status: implemented. `src/replay/walk.rs` turns a replay R1 accepted into the
app's own `GameState` at every decision point. It never decides the answer: the
book classifiers (B1/B2) and the Mortal labeler (L1) attach the lesson and the
model answer later. The catch-all module docs are in `src/replay/walk.rs`.

### API

```rust
use riichiprac::miner::provenance::ReplayId;
use riichiprac::replay::{walk_path, walk_replay};

// Path form: reads, validates, hashes the raw bytes into the replay id.
let walk = walk_path(std::path::Path::new("replays/m1/<id>.jsonl.gz"))?;
assert!(walk.is_clean(), "{:?}", walk.skipped);

// In-memory form: re-runs `validate_game`, then walks.
let walk = walk_replay(&file, ReplayId::from_bytes(&raw_gz_bytes))?;
for decision in &walk.decisions {
    let _ = &decision.state;      // serialises as the app's GameState
    let _ = &decision.legal_actions;
    let _ = &decision.played;     // the recorded action, as an ActionInfo
    let _ = &decision.decision_id;
    let export = decision.review_export(); // tenhou.net/6 for a human reviewer
}
```

`ReplayWalk` carries `decisions`, `skipped`, `warnings`, `events` and
`kyoku_count`. A decision that fails a reconstruction check is **never**
emitted; it lands in `skipped` with the event, seat, kind and reason.

### Where a snapshot is taken

| Resolving event | `DecisionKind` | `DecisionContext` |
| --- | --- | --- |
| `dahai` right after that seat's `tsumo` | `self_turn` | `SelfTurn` |
| `reach` | `self_turn` | `SelfTurn` |
| `ankan`, `kakan` | `self_turn` | `SelfTurn` |
| `hora` by the drawing seat | `self_turn` | `SelfTurn` |
| `chi`, `pon`, `daiminkan` | `call` | `ReactToDiscard` + `call_offer` |
| `hora` on a discard (ron) | `react_discard` | `ReactToDiscard` |
| `hora` on a just-declared kan | `react_kan` | `ReactToKan` |

Not decisions in this model: a `dahai` that follows the seat's own call (the app
has no "discard without a draw" context, and the call question is already the
graded one) and `ryukyoku` (the mjai event has no actor, so an abortive draw
cannot be attributed). The decision id is
`sha256(replay_id, kyoku_index, event_index)` with bare lowercase hex, where
`kyoku_index` is the 0-based kyoku ordinal in the game; `start_kyoku.kyoku`
repeats every round and is not unique.

### Normalisation and derived fields

Every snapshot rotates the table so the actor is `players[0]`: hands, draws,
rivers, melds, `called_from`, scores, winds, `current_turn` and the reaction
`from` move together; the round wind, the dealer derivation
(`dealer_seat(players[0].wind)`) and the river indices stay consistent. Seat 0
is the human (`You`), seats 1–3 are `Shimocha`, `Toimen`, `Kamicha`.

Filled from the replay and the app's own helpers:

- `hand_string`, `tiles`, `shanten`, `is_agari`, `decompositions_count`,
  `ukeire_tiles`, `ukeire_total` from `generator::evaluate_hand` on the
  concealed tiles (hand plus draw), the generators' open-hand convention;
- `can_riichi` and `book_rationale` stamped by `generator::finalize_state`;
- `dora_indicators` only as revealed at the decision (a kan dora is a later
  `dora` event; a robbed kan reveals none);
- `tiles_remaining = 70 - tsumo events in the kyoku` (a kan's replacement draw
  is one of the 70, matching R1's wall rule);
- red fives out of band in `red_fives`, with the plain tile in `hand`/`tiles`;
- `riichi_sticks` from the kyoku's kyotaku plus accepted declarations, and
  scores with each accepted declaration's 1000-point payment;
- `call_offer` on a call decision (Pon, Chi or the open quad).

Deliberately **not** filled:

- `ura_dora_indicators` on the state. The record only reveals the ura when the
  kyoku ends, so they are stored on `DecisionSnapshot::ura_dora_indicators` for
  post-answer display and copied into a clone only for the reviewer export.
- `category` (`replay_<kind>`), `target_action` (`Call` for a call, otherwise
  `Best`) and `correct_action` (the recorded action) are **provisional**: R2
  never decides the answer, but `GameState` requires the fields. B1/L1 replace
  them; do not ship them as answers.
- Furiten is not a `GameState` field. The snapshot records the actor's waits and
  whether its own river already contains one (permanent furiten). Temporary
  furiten leaves no event and is not reconstructed.

### Triaged rejections

`ReplayWalk::skipped` is the triage path; a rejection is a reconstruction bug
(fix the walker) or a documented validator gap, never something to bypass.

| Case | Handling |
| --- | --- |
| ankan robbed by kokushi | The reachability validator's chankan check accepts only an **open** four-tile kan, so the `react_kan` snapshot is skipped. `ReplayWalk::skipped` names the seat and the validator's reason. |
| a ron by a permanently furiten player | `GameState` cannot represent furiten and such a ron is not a legal game; the decision is skipped with a reason naming the wait and the river. |
| the record plays an action the app's legal set refuses | The decision is kept, `played_is_legal` is `false`, and a warning is recorded. The app's yaku set and the engine's can disagree on a ron; a corpus reviewer decides. |
| a `hora` with no winning tile at all | A warning names the event; no decision is emitted. |

The structural fixture corpus (the hand-scripted game, the exhaustive draw, two
kyokus, the robbed kakan, the furiten ron and 100 synthetic games) produces zero
reachability skips and every recorded action is in the app's legal set.

### Reviewer export

`DecisionSnapshot::review_export()` reuses `src/export/tenhou6.rs` (the same
tile-id/naki mapping as the app's export) with the record's ura indicators
attached, so a position can be loaded at <https://mjai.ekyu.moe>. tenhou6 stays
an output; the walker never reads it. The writer only covers East/South rounds,
and a reaction state now carries a future draw in its tail so the log parses; a
state the writer cannot represent returns its typed error instead of failing the
walk.

## R2 acceptance evidence

- `cargo test --features miner` covers: the first decision of the hand-scripted
  game is the dealer's draw before the discard (hand, draw, dora, wall, round);
  the red-five identity stays out of band; a chi is rotated with the caller at
  seat 0 and its `call_offer`; a riichi decision precedes its discard and the
  discard is not a second decision; a ron is a `ReactToDiscard` with waits and no
  draw; a robbed kakan is a `ReactToKan`; a robbed ankan is skipped with its
  reason; a furiten ron is skipped with its reason; every decision kind is
  reached; every fixture snapshot passes `validate_reachable_state` and its
  played action is legal; 100 synthetic games produce zero invalid states; the
  wall count only shrinks and ends at 0; the kan dora appears only from its own
  event; the ura indicators are stored but never in the state; the reviewer log
  is loadable and reports the replay's wall; a live kyoku rotated by any shift
  normalises to the identical table; a four-meld hand still reconstructs;
  rerunning the same replay is deterministic; decision ids are position- and
  content-addressed.
- `cargo clippy --all-targets --features miner -- -D warnings` and
  `cargo check --target wasm32-unknown-unknown` stay clean;
  `cargo tree --features miner` contains no `libriichi`.
- Visual sign-off is not involved in R2.

## Mortal labeler contract (L1)

Status: implemented. `src/miner/label/` labels a reconstructed `GameState` with
the app's own MIT Candle port (`src/ai/model.rs`), never `libriichi`. The
checkpoint is parsed and bound once per process (`Labeler::load`) and reused for
every state in the shard; the forward pass is
`evaluate_state_with_q_values`, which masks illegal actions exactly like the
browser's `evaluate_state_named` and additionally keeps each action's raw Q
value.

### Label document (`riichiprac.model-label` v1)

Stored as `decisions.label_json` and in the cache. It records:

- `model`, `model_sha256`, optional `gamma`/`pts` (only when the operator
  supplies them; the deployed `mortal_298k.safetensors` carries neither);
- `q_units` and `value_units`, both `"model_utility"`, plus the note
  `Q values are model utility, not points.`;
- `expected_value`, `top_action`, `top_probability`, `probability_margin`, the
  full `ranking` with per-action `q_value`, and the raw `q_values` map;
- `q_gap_top2 = q(best) - q(second)` and
  `q_gap_safe = q(best) - q(safest)`, where the safe action is chosen by
  `safety::SafetyFacts` (the ch. 8 chart against every opponent in Riichi), not
  by the model's preference, with the `safe_action` recorded;
- `riichi_discard`, the second-pass discard when the model declares Riichi;
- the book half: lesson, answer, accepted tiles, `resolution`
  (`single`/`agreement`/`mortal_tiebreak`) and `agreement` from
  `fuzz::compare_action_set` (including `equivalent_tiles` and the Riichi
  second pass). A disagreement the model cannot settle is recorded as
  `book_conflict` instead, never silently picked;
- `generator` (model + hash) only when the replay's generator differs from the
  labeler, taken from the `replays` row when ingest recorded it.

No field claims points, and the Q values are never overwritten.

### Cache and reruns

`model_labels` is keyed by
`(state_hash, model_sha256, classifier_version, options_hash)`. `state_hash` is
the SHA-256 of the v4 observation, i.e. the model-visible position: scenario
metadata, rationale and display-only metrics do not invalidate a cache entry,
while the shanten/wait inputs the encoder reads do. `options_hash` is the hash of
`LabelOptions` (`q_values`, `safe_gap`).

- `status = 'ok'` with a decodable label is finished work: a rerun performs no
  forward pass for that state (duplicate positions in one run share it too).
- `status = 'failed'` stores `last_error` and increments `attempts`; a later run
  retries it and records success. An unreadable cached payload is retried rather
  than trusted.

L1 also updates the `decisions` row when `extract` has created one
(`mortal_top`, `mortal_top_prob`, `mortal_margin`, `mortal_ranking`,
`q_values_json`, `q_units`, `labeler_model`, `labeler_model_sha256`,
`classifier_version`, `label_json`). L2 then writes `label_kind` and
`label_source` from the agreement classification; `selection_reason` is left to
S2.

### Parity

`cargo test --features miner` includes a parity test that evaluates every
decision of the committed fixture replay with both the browser path
(`evaluate_state_named`) and the labeler and requires identical top-1 action,
ranking order, probabilities, expected value and Riichi second-pass discard,
with the Q values finite and `q_gap_top2` equal to the top-two Q difference.
The test needs the gitignored checkpoint: set
`RIICHI_MORTAL_WEIGHTS=/path/mortal_298k.safetensors` (or place
`frontend/public/models/mortal_298k.safetensors`); without it the test prints an
explicit skip message instead of passing silently. The same applies to the
end-to-end shard test, which labels a fixture replay, asserts the `decisions`
row, and asserts that a rerun is fully cached.

## L1 acceptance evidence

- `cargo test --features miner` covers: state-hash stability against metadata
  re-stamping (and sensitivity to the real position), the `model_utility` units
  and identity on every label, `q_gap_top2`/`probability_margin` arithmetic, the
  softmax-over-Q consistency, the `safety::SafetyFacts` source of
  `q_gap_safe`/`safe_action` (and its absence without a Riichi threat), the book
  label and agreement/discrepancy outcomes from `compare_action_set`, call
  mapping from `legal_actions`, generator identity recording only when it
  differs, cache key coverage, cache skip/retry, replay discovery, the shard
  limit, the `decisions` row write (including that selection columns are not
  overwritten), a full rerun that evaluates nothing, and the weights-gated
  parity and real-shard tests described above.
- The browser payload is unchanged: `ActionEvaluation::q_value` is `None` on the
  browser path and is skipped in JSON; a default-build test pins that the
  `evaluations[*]` objects gain no `q_value` key.
- `cargo clippy --all-targets --features miner -- -D warnings`,
  `cargo check --target wasm32-unknown-unknown`, `cargo test --lib` and
  `cargo tree --features miner` (no `libriichi`) stay clean.

Visual sign-off is not involved in L1.

## Book agreement, contested states and calibration (L2)

Status: implemented. L2 turns L1's book half into an explicit agreement
classification and adds the optional hooks below. It adds no model and no
second opinion: with one `mortal_298k` checkpoint, a label is one model's view.

### Agreement: `stable` vs `contested`

A label carries two derived fields, in `label_json` and (for the kind) on the
`decisions` row:

| Field | Values | Meaning |
| --- | --- | --- |
| `stability` | `stable`, `contested`, `unresolved` | Do the book and the model name one answer? |
| `label_kind` | `book`, `contested`, `mortal`, `none` | What would a drill grade? |

Rules (`src/miner/label/agreement.rs`):

- **Agreement is the app's comparison rule.** The book answer is compared with
  the model by `fuzz::compare_action_set`, i.e. the same rule as
  `generator::mortal_agreement`: `equivalent_tiles` count as the same answer and
  a Riichi answer must match the evaluator's second-pass discard. A test pins
  that `classifier::mortal_agrees` and `mortal_agreement::rejection_for` agree
  on the same stamped state.
- `stable` + `book`: the model's top action is the book answer.
- `contested` + `contested`: the model prefers a different action. **The book
  answer stays the answer**, the model's action is recorded beside it, and the
  candidate may ship only as a dual-verdict drill (replay-strategy §5.2).
- `unresolved` + `none`: the book rules disagree with each other and the model
  agrees with none of them. The decision is not shippable.
- A position no lesson recognises is `label_kind: mortal` with no `stability`:
  there is no book perspective to agree or disagree with.
- The Mortal tiebreak between two book lessons is already explicit in L1's
  `resolution: mortal_tiebreak` plus the rejected lesson list; it is never a
  silent choice. `book_conflict` remains the fail-closed case.

`label_kind`/`label_source` are written onto the `decisions` row by the shard
run (`book+mortal` for book and contested labels, `mortal` for Mortal-only,
`none` for an unresolved conflict), so a book/Mortal disagreement is queryable
instead of looking like an ordinary book label. `selection_reason` stays with
S2.

### Multi-model votes (optional, future)

`mine_replays label --models OTHER.safetensors,...` evaluates additional
checkpoints and records one `ModelVote` (identity, hash, top action,
probability, margin, and whether it agrees with the book answer) per member.
Two or more members produce a `ModelConsensus` with `unanimous`/`contested`;
a split marks the label `contested`. With zero extras the field is absent and
nothing is called an ensemble: one checkpoint is a label, not a consensus. The
multi-model path deliberately does not use the single-model cache (its key would
need the whole labeler set) and no gate or quota depends on it. The single-model
labeler remains `mortal_298k`.

A checkpoint mismatch is never hidden: L1 keeps `generator` when the replay's
generator differs from the labeler, and every vote carries its own identity and
SHA-256.

### Percentile thresholds per decision family

`src/miner/label/thresholds.rs` is the S3 hook, not a selector:

- a family is `<decision_kind>/<turn_bucket>` (`turns 0–5`, `6–11`, `12+`, using
  the longest river on the table), e.g. `self_turn/mid`;
- `PercentileThresholds` holds the close-call and confidence percentiles
  (defaults 10% / 90%), overridable per family in `PercentileConfig` (JSON). An
  unknown family key is an error, not a silent default;
- `PercentileCut` computes both cuts from a family's sample with the
  order-independent nearest-rank method (`f32::total_cmp`); a family with fewer
  than 8 usable values has no cuts, and `band()` returns `close`, `middle` or
  `confident`;
- `ModelLabel::top2_gap()` is `q_gap_top2`, falling back to the probability
  margin when Q values were not recorded. `thresholds::family_gap(snapshot,
  label)` joins a label to its family and gap, which is what S3 groups; no
  absolute point threshold exists.

### Q→point calibration

`src/miner/label/calibration.rs` defines `riichiprac.q-point-calibration` v1: a
separate, versioned document (`calibration_id`, method, fit provenance, units,
and strictly increasing `(q_gap, point_diff)` breakpoints anchored at `(0, 0)`).
`apply_calibration` derives `expected_point_diffs` (per action, in `points`)
from the stored raw Q values and records `calibration_version` = the calibration
id **beside** the Q values; it never changes `q_values`, the ranking or
`q_gap_*`. A mapping clamps at its last breakpoint instead of extrapolating.

No calibration ships. Without one, no label field claims points. Calibration is
not part of the cache key: a cached raw label can be recalibrated with no
forward pass, so changing the calibration never invalidates evaluations. A
non-monotone, unanchored, non-finite, wrong-unit or wrong-version document is
rejected at load.

## L2 acceptance evidence

- `cargo test --features miner` covers: `stable`/`contested`/`unresolved` and the
  four label kinds (including a contested label keeping the book answer and
  `json["stability"]`), a Mortal-only label having no stability, the
  `mortal_agrees` ↔ `mortal_agreement::rejection_for` cross-check, consensus
  only existing with two or more checkpoints, unanimous vs contested votes
  (including red-five normalisation), `top2_gap` falling back to the probability
  margin, percentile determinism and order-independence, nearest-rank cuts,
  per-family config validation, small-family refusal, calibration validation
  (schema/version/units/anchor/monotonicity), point estimates without touching
  Q values, recalibrating a cached label with no forward pass, and the shard
  writing `label_kind`/`label_source` and the recalibration/cache report.
- The CLI parses `--models`/`--calibration`; a single-model run has neither.
- `cargo clippy --all-targets --features miner -- -D warnings`,
  `cargo check --target wasm32-unknown-unknown`, `cargo test --lib` and
  `cargo tree --features miner` (no `libriichi`) stay clean.

Visual sign-off is not involved in L2.

## Scenario pack format, gate and audit (P1a)

Implemented in `src/miner/pack/`. This is the executable form of the pack half
of G8: the format exists and is validated before P1b wires real selection output
into it.

### Documents

| Document | Schema | Where |
| --- | --- | --- |
| pack body | `riichiprac.scenario-pack` v1 | one gzipped JSON file per pack |
| manifest | `riichiprac.scenario-pack-manifest` v1 | `<packs>/manifest.json` |
| provenance source | `riichiprac.corpus-game` v1 | JSONL rows the audit checks against |

The body is `replay-strategy.md` §6.7's shape extended with a complete
`source.agents` union (each contributor's `agent_id`, `kind`, `engine`,
`engine_version`, `weights_sha256`, licence and attribution),
`provenance.variant_of`, `provenance.transform_chain` (the V1
`riichiprac.scenario-transforms` document), `provenance.label_check`,
`played.agent` and `data_commercial_use` on the manifest entry. Every scenario
carries the complete `GameState` plus its own `correct_action`/`accepted`; the
audit recomputes the state's copy and rejects a mismatch. A single candidate is
reviewed through the existing `scenario-report` path (it takes the same
`GameState` the pack embeds); P1a adds no pack-specific review format.

Versioning is additive within v1: new fields are optional/defaulted and unknown
fields are ignored. A breaking change bumps `version`. `source.kind`
deserialises through the F1 `SourceKind`, so any value except `ai_selfplay` is a
parse error rather than a gate warning.

### Pack-time gate

`audit_pack(pack, context)` runs every check and returns stable finding codes;
`publish_pack` refuses any pack with an error finding.

| Gate | What it enforces |
| --- | --- |
| schema | known schema/version, non-empty pack, unique scenario ids and state hashes, non-empty title/prompt/lesson, book key `ch<chapter>.<section>`, `lesson_id` = state `category` |
| source/licence | `source.kind = ai_selfplay`; data licence on `CC-BY-4.0`/`CC0-1.0`/`MIT`; attribution present; `redistributable`; known and complete agent licences; `data_commercial_use` = logical AND of contributors |
| commercial profile | a commercial publish refuses a pack whose data or any agent licence forbids commercial use (explicitly naming Akochan) |
| provenance | every `replay_id` has a matching `GameProvenance` row; the game validates and is publishable; its `corpus_id` matches `source.corpus_id`; `source.agents` is exactly the union of contributing seats with the same licence ids/commercial flags |
| legal answer | the answer is on `ai::actions::legal_actions`; a Riichi answer names a legal discard; a `Pass` answer has a `call_offer`; equivalents are legal discards; `accepted` is exactly the answer plus `equivalent_tiles`, sorted |
| reachable state | `validate_reachable_state`; the build record says `state_valid`, `answer_recomputed` and `visible_info_only` |
| no spoiler | title, prompt, pre-answer note, book label, provenance labels and selection tags print no answer or tenpai-wait tile code; a visibly offered call tile is not a wait |
| variant honesty | a transform chain validates, `provenance.transforms` matches it, and a variant carries `label_check.preserved = true` |
| budget | encoded gzip body within `max_bytes` (default 50 MB), scenario count within `max_scenarios` (2000), manifest within 512 KiB |
| manifest integrity | entry path is safe and content-addressed, hash/bytes/scenario count match the body, and convenience metadata drift is a strict-mode warning |

A missing corpus row is a hard failure, not a warning, including when the whole
`games.jsonl` source is absent: a pack whose provenance cannot be checked is not
publishable.

### Deterministic encoding and atomic publishing

`encode_pack` writes compact struct-order JSON through a fixed gzip level with
no header timestamp, so the same pack always has the same bytes and SHA-256.
The body includes `generated_at`, which is an input like any other: a
reproducibility run must pin it (the encoder never adds a timestamp of its own).
`publish_pack` audits, writes `<pack-id>-<sha256-prefix>.json.gz` with
`storage::write_atomic`, then merges the manifest entry and writes
`manifest.json` the same way. A failed manifest write removes a body this call
created; an existing content-addressed body is never deleted. Republishing an
unchanged pack rewrites the same file and the same single manifest entry.

### CLI

```bash
# Publish the built-in fixture pack, manifest and provenance rows.
cargo run --features miner --bin mine_replays -- \
  pack fixture [--out "$RIICHI_DATA_DIR/packs"] [--max-bytes N] [--json]

# Print the per-pack report from the manifest.
cargo run --features miner --bin mine_replays -- \
  pack report [--manifest FILE] [--json]

# Audit a manifest and every body it lists.
cargo run --features miner --bin mine_replays -- \
  audit [--manifest FILE] [--games FILE] [--strict] [--commercial] [--json]
```

Defaults: manifest `<packs>/manifest.json`, provenance `<packs>/games.jsonl`.
`audit` exits 0 clean, 1 dirty, 2 unreadable. `--strict` turns recoverable
manifest metadata drift and unlisted bodies into failures. `--commercial`
applies the commercial profile. `pack fixture` writes
`replay.fixture.2026-11-<sha>.json.gz`, `manifest.json` and `games.jsonl`; the
fixture is two generated lessons with two synthetic-but-valid game rows, honest
about having no replay round-trip and no precomputed model label
(`requires_model = true`, `generator.commit = fixture`).

### P1a acceptance evidence

- `cargo test --features miner` covers: pack/manifest round-trip and unknown
  field tolerance; the non-self-play source parse failure; every source/licence
  negative (unknown data licence, empty attribution, non-redistributable, no
  agents, invalid agent licence, commercial-flag mismatch, commercial-profile
  refusal); missing/unpublishable/corpus-mismatched/duplicate game provenance;
  missing, unexpected and mis-licensed agents; every legal-answer negative
  (illegal discard, Riichi without a discard, Pass without an offer, accepted
  mismatch, illegal/duplicate equivalents); a spoiler in the title and in the
  scenario note; structural negatives (schema/version/empty/duplicate
  id/duplicate state/lesson/book/answer/accepted); state reachability; a variant
  without a preserved label check; byte, manifest and scenario-count budgets;
  deterministic encoding; content-addressed atomic publish with no temp files
  and an untouched existing path on failure; a dirty pack writing nothing;
  manifest byte/hash/id/count tampering; strict-only manifest drift and unlisted
  bodies; a missing provenance source; manifest entry path/hash/licence
  validation; JSONL round-trip; and the fixture pack auditing clean in normal
  and strict mode.
- The fixture publisher and `audit` were run end to end on a scratch data root;
  `audit` and `audit --strict` both report clean.
- `cargo fmt --check`, `cargo clippy --all-targets --features miner -- -D
  warnings`, `cargo test --lib`, and `cargo check --target wasm32-unknown-unknown`
  stay clean.

Visual sign-off is not involved in P1a.

## F1 acceptance evidence

- `cargo test --features miner` covers schema round-trips, DB create/migrate on a
  fixture, the complete row insert across all eight tables, foreign keys, the
  DB source `CHECK`, relative-path rules, snapshot + `PRAGMA integrity_check`,
  atomic-write failure cleanup, the source and licence allowlists, the funnel
  counter, and CLI parsing for all eight subcommands.
- `cargo check --target wasm32-unknown-unknown` (default features) stays clean.
- `cargo tree --features miner` contains no `libriichi`.

Visual sign-off is not involved in F1.
