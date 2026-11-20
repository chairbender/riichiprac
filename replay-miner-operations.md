# Replay miner operations: data root, provenance, storage, replays, labels, candidate triggers, selection, variants, packs and the Q1 harness (F1, R1, R2, L1, L2, S1, S2, V2, P1a, P1b, P2, Q1)

Status: implemented foundation (F1), replay reader/validator (R1), the walker /
`GameState` reconstruction (R2), the native Mortal labeler with Q values and
the label cache (L1), book/Mortal agreement with contested marking,
percentile hooks and optional calibration (L2), the cheap candidate triggers with
family filters (S1), the hard gates, ranking, quotas, dedupe, held-out QA and
review queue (S2), the label-preserving variant stage (V2), the scenario-pack
format/gate/audit (P1a) with DB-backed assembly (P1b), and same-origin hosting
with CI copy, byte/CORS checks and the optional R2/HF mirror (P2), and the
end-to-end fixture acceptance harness (Q1) of
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
mapping and filter, and the corpus sample precision/recall report. S2 adds
`src/miner/select/`: the eight hard gates from replay-strategy §7.1, the §7.2
signals and composite score, family quotas with section/kind/turn diversity
caps, exact and visible-info dedupe, the deterministic held-out QA split, and
the JSONL review queue that embeds a single-candidate
`riichiprac.scenario-report`. V2 adds `src/miner/variant/`: the per-lesson
transform policy, the label-preservation gate, the yield/disable/dedupe/cap
stage, the `riichiprac.variant-report` and the pack assembly path. P1a adds
`src/miner/pack/`: the `riichiprac.scenario-pack` and manifest documents, the
executable G8 pack gate, deterministic encoding, atomic content-addressed
publishing, the directory audit and the fixture publisher. P1b adds
`src/miner/pack/assemble.rs`: DB-backed assembly, the review gate, caps/dedupe,
the `packs`/`pack_scenarios` rows and the assembly report. P2 adds
`src/miner/pack/host.rs`: the same-origin publisher with the 50 MB budget,
curated copy and prune, the staged-directory verifier, plus
`scripts/check-pack-hosting.mjs` and `scripts/check-pack-cors.mjs` for CI and
the optional R2/HF mirror. Book classification (B1/B2/B3) already exists in
`src/classifier/`; S3's selectors remain, and P3's runtime half is
`frontend/src/services/packLoader.ts` plus the picker merge in
`frontend/src/scenarios.ts` (no miner code).

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
  select            gate, rank, quota and dedupe a review queue
  transform         generate label-preserving scenario variants
  pack              assemble, audit and export scenario packs
  audit             audit provenance, licences and pack integrity
  qa fixture        run the Q1 end-to-end acceptance harness on fixtures
  review            work the human review queue
```

`extract` (R2 → `decisions`), `label` (L1 with the L2 agreement/calibration
extensions), `triggers` (S1), `select` and `review` (S2), `transform` (V2), and
`pack fixture`, `pack assemble`, `pack publish`, `pack report` and `audit`
(P1a/P1b/P2) are implemented. `ingest` and `corpus` are still stubs: they
resolve the data root, report the command they would run, and exit with code 2,
so a script cannot treat a stub as a successful run.

```bash
cargo run --features miner --bin mine_replays -- label \
  --weights frontend/public/models/mortal_298k.safetensors \
  [--models OTHER.safetensors,...] [--calibration CAL.json] \
  [--replays DIR] [--family NAME] [--limit N] \
  [--classifier-version V] [--workers N] [--progress] \
  [--gamma F] [--pts a,b,c,d] \
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

`--workers N` (default `0` = every available core, Q2p) labels replay files in
parallel: workers walk their own files and run the forward pass outside the
database lock, and the cache lookup and every write happen under the stage's
single connection lock. Two decisions with the same model-visible state share
**one** evaluation (the first to claim the key evaluates it and the rest reuse
the cache row), so `decisions_labelled` still equals the forward passes and the
report matches a `--workers 1` run; it records the resolved `workers` and
`wall_time_ms`. `--progress` prints the measured file count. A position that
differs only in something the model observation does not carry (the actor's
permanent-furiten flag, the replay's generator identity) keeps the first label
recorded for its state hash; when several workers meet such a shared state the
one that claims it can differ from the serial order, so a corpus that mixes
those positions may record the other of the two labels.

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

```bash
cargo run --release --features miner --bin mine_replays -- select \
  [--replays DIR] [--family NAME] [--limit N] \
  [--pack-id ID] [--size N] [--held-out-share F] [--seed TEXT] \
  [--section LIST] [--lesson LIST] [--corpus-family LIST] \
  [--corpus-cap family=N,...] [--max-per-replay N] [--extracted-only] \
  [--stable-book-only] [--max-section-share F] [--max-kind-share F] \
  [--max-turn-share F] [--workers N] [--progress] \
  [--dry-run] [--json]

cargo run --release --features miner --bin mine_replays -- review \
  [--queue FILE | --pack ID] [--held-out] \
  [--accept ID,...] [--reject ID,...] [--verdicts FILE] [--note TEXT] \
  [--list] [--show QUEUE_ID] [--dry-run] [--json]
```

`select` walks the shard, reads labels from the DB cache (never a forward pass),
applies the eight gates, ranks the survivors, and writes
`reviews/<pack-id>/review-queue.jsonl`, `held-out.jsonl`,
`selection-report.json` and `reviews/LATEST`. `--size` defaults to 100 and
accepts 1–5,000; it is a review-queue size, not a pack body, so a 2.5k queue is
legitimate while `pack assemble` still owns the final scenario ceiling
(`--max-scenarios`). `--pack-id` defaults to `s2-<UTC stamp>`;
`--held-out-share` defaults to 0.10.
`--dry-run` builds and reports without writing, and exit code 1 means a replay
failed or a review item could not be built. S2 does not assemble a pack: the
funnel's `packed` row stays `0`.

`review` resolves the queue from `--queue`, else `--pack`, else the last
`select` run's `reviews/LATEST`. It re-parses every embedded report through
`riichiprac.scenario-report` (which recomputes the derived fields and never
trusts a saved verdict), appends `--accept`/`--reject` verdicts to
`dispositions.jsonl`, and reports pending/accepted/rejected counts. `--show`
prints one item's report; `--list` lists every item; `--dry-run` writes no
dispositions. A queue is never rewritten: the disposition log is append-only and
the latest verdict per item wins. `--verdicts FILE` applies a bulk
`riichiprac.review-verdicts` document in the same run (see "Bulk review and the
sampled flow (Q2r2)"); per-item `reason` text becomes the disposition note, and
an unknown id or a repeated id fails the run before anything is written.

## Parallel execution (Q2p)

`AGENTS.md` §5b and `replay-implementation-plan.md` §7.1 require the offline
stages to use the whole machine. `src/miner/parallel.rs` holds the shared
contract every implemented stage now uses:

- `--workers N`, default `0`, resolves to every available core
  (`select`, `extract`, `label`, `transform`); `--workers 1` is the bounded mode
  for tests, fixtures and debugging, and it is the mode the Q1 harness runs.
- The unit of work is one replay file (`extract`, `label`) or one base scenario
  (`transform`), and the per-unit results merge in the **serial** order (file
  order, base order). Dedupe, the early stop, the caps and every report counter
  therefore see the sequence a single-threaded run would see, so a parallel run
  writes the same rows and reports as `--workers 1` apart from the two
  shared-cache cases listed below.
- SQLite keeps a single writer, so the stage's connection sits behind
  `SharedDb`. Only the short statement work happens inside the lock; the
  expensive part (the replay walk, the model forward pass) runs outside it.
  `label` additionally shares one evaluation per model-visible state within a
  run, which is what keeps `decisions_labelled` equal to the forward-pass count
  and one cache row per unique state.
- `--progress` prints a phase header (`<stage>: N replay file(s), W worker
  thread(s)`) and one line per tenth of the shard, so a long run reports
  measured progress instead of a guess.
- Each report records the resolved `workers` and the run's `wall_time_ms`
  alongside its existing counters.

Two documented exceptions, both about a shared label cache row rather than the
shipped output: `label` keeps the first label recorded for a state hash when
positions differ only in something the model observation does not carry (the
actor's permanent-furiten flag, the replay's generator identity), and
`transform` reports `labels.evaluated`/`labels.cached` as its workers saw the
cache when two bases produce the same transformed state. The shipped set, the
rows and every other counter are unaffected.

Q2p evidence (14 cores, 2026-11-18) is recorded in
[`q2-scale-up-1000.md`](q2-scale-up-1000.md) and
[`testdata/reports/q2-scale-1k/`](testdata/reports/q2-scale-1k/): the 544-game
shard extracts in 12 min 28 s and labels in 9 min 26 s on 14 threads (the label
pass reports 6,412 s CPU over 566 s wall = 11.3 cores busy), the extract rows are
identical to the serial Q2 pass in every column, and the label pass produces the
same 40,429 cache rows, 41,009 labels and `label_kind` split. The same property
is asserted on fixtures by
`extract::tests::parallel_and_serial_extraction_write_the_same_rows_and_report`,
`label::run::tests::parallel_and_serial_label_runs_write_the_same_rows_and_report`
and `variant::tests::a_parallel_stage_matches_the_serial_stage`, and the CLI
parses the flags on all three commands
(`tests::the_offline_stages_parse_their_worker_and_progress_flags`).

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
├── reviews/
│   ├── LATEST                              # pack id of the last select run
│   └── <pack-id>/
│       ├── review-queue.jsonl              # selected candidates, one report per line
│       ├── held-out.jsonl                  # QA split, never packed
│       ├── dispositions.jsonl              # append-only reviewer verdicts
│       └── selection-report.json           # funnel, gates, quotas, dedupe, samples
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
| `riichiprac.model-label` | `MODEL_LABEL_SCHEMA` | one Mortal label (L1) |
| `riichiprac.candidate-trigger` | `TRIGGER_SCHEMA` | one candidate's trigger report (S1) |
| `riichiprac.selection-report` | `SELECTION_SCHEMA` | one selection run's report (S2) |
| `riichiprac.extraction-report` | `EXTRACT_SCHEMA` | one `extract` run's replay/decision counts |
| `riichiprac.review-item` | `REVIEW_SCHEMA` | one review-queue line (S2) |
| `riichiprac.review-disposition` | `DISPOSITION_SCHEMA` | one reviewer verdict (S2) |
| `riichiprac.pack-assembly-report` | `ASSEMBLY_SCHEMA` | one pack-assembly run's report (P1b) |

The review item embeds the app's own `riichiprac.scenario-report` v2 for that
single candidate, so the existing report importer validates it unchanged.

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
(`PRAGMA user_version = 3`).

| Table | Purpose |
| --- | --- |
| `corpus_runs` | one generation run: plan, family, replay count, local/Drive dir, snapshot, rclone status |
| `replays` | one immutable game: source, licence, rule profile, log path/bytes/hash, validation, agent roster, full provenance JSON |
| `decisions` | one decision point: state hash/JSON, legal/played actions, trigger, book match, Mortal label, Q values (units `model_utility`), L2 `label_kind`/`label_source` agreement classification, selection fields |
| `model_labels` | L1 cache: status/attempts/label JSON per `(state_hash, model_sha256, classifier_version, options_hash)` |
| `selected_scenarios` | curated rows: decision, pack, lesson, correct/accepted action, label fields, selection family, variant base, transform chain, provenance |
| `variants` | transform output: base scenario, chain, seed, label-preserved flag, rejection reason |
| `packs` | generated pack metadata: hash, bytes, count, source mix, licence, commercial flag, export path, DB snapshot |
| `pack_scenarios` | one row per published scenario: ordinal, base (for a variant), lesson, family, exact state hash, serialised-scenario hash, variant flag |
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

## Decision extraction (R2 → database)

Status: implemented in `src/miner/extract.rs`; Q2 added it because P1b cannot
rebuild a packed base without a `decisions.state_json` row. `extract` walks a
validated replay shard with the same R2 `walk_path` the labeler and selector use
and upserts one row per reconstructed decision.

```bash
cargo run --release --features miner --bin mine_replays -- extract \
  [--replays DIR] [--family NAME] [--limit N] \
  [--workers N] [--progress] [--dry-run] [--json]
```

`decisions` stores:

| Column | Value |
| --- | --- |
| `decision_id` | R2's `sha256(replay_id, kyoku_index, event_index)` |
| `family` | the replay family directory (`akochan_tactics`, `mortal_mirror`, ...) |
| `kyoku` / `honba` / `event_index` / `turn` / `seat` / `decision_kind` | the reconstruction's own fields |
| `state_json` | the complete `GameState` P1b rebuilds the base from |
| `state_hash` | the L1 v4-observation hash (label cache key) |
| `visible_info_hash` | the literal visible-table fingerprint (dedupe) |
| `legal_actions` | JSON array of the legal action strings |
| `played_action` | the action string the record played |

It is idempotent and **does not clobber later stages**: a rerun refreshes the
state/ledger columns and leaves `trigger`, `book_match`, `mortal_*`,
`label_json`, `label_kind`, `selection_reason` and `pack_id` untouched. The
report (`riichiprac.extraction-report` v1) carries per-family replay, decision,
inserted and refreshed counts; exit code 1 means at least one replay failed.

Extraction is model-free and can run before or after `label`; `label` reads the
decision id/state from its own walk and writes the label columns when a row
exists. The Q2 pack run extracts the selected corpus families only, so a
100-scenario pack does not pay for 999 games of unrelated state.

`--workers N` (default `0` = every available core, Q2p) walks replay files in
parallel: a worker walks its own files and upserts their rows under the stage's
single database lock, and the per-file counts merge in file order. The report
therefore matches a `--workers 1` run and records the resolved `workers` and
`wall_time_ms`; `--progress` prints the measured file count.

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

A **filtered** run only labels the decisions whose triggers fire, so a classifier
bump would leave the retired rule set's label on every skipped decision. The
shard clears all `decisions` labels whose `classifier_version` differs from
`--classifier-version` before the workers start and reports the count as
`stale_labels_cleared`. The version-keyed `model_labels` cache is left alone;
old generations stay available when a reproducer explicitly asks for one.

Adding or changing a recogniser is a **classifier-generation change**: bump
`CLASSIFIER_VERSION`, then re-label. A full `label --trigger book` pass on the
current corpus re-evaluates ~113k candidates (about 30-60 minutes on 14
workers), so batch related recognisers into one task and one version bump
rather than bumping per recogniser. The replay-first rollout's `B4` (four
missing classifiers) is the first example: classifier v3 labelled 112,504
candidates in 52 min 45 s at 14 workers, and the per-lesson yield is in
`testdata/reports/b4-classifiers/label-yield-report.md`.

One trap: the stale-label clear is **version**-based, not rule-based. If a
recogniser changes while the version stays the same (mid-development fix before
the bump lands), a rerun leaves the retired v3 `decisions` labels in place and
the version-keyed `model_labels` rows still carry the old book label. Either
bump the version again, or, while the generation has not shipped, delete the
`model_labels` rows and reset the `decisions` label columns for that version
before relabelling.

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
- Re-verified 2026-11-20 against the deployed `mortal_298k` checkpoint
  (`afb91147…`): `cargo test --features miner --lib miner::label` passed all 56
  label/cache tests, including `label_parity_with_evaluate_state_on_a_fixed_fixture`
  ("label parity checked on 26 decisions") and
  `a_real_checkpoint_labels_a_shard_and_the_rerun_is_cached`;
  `cargo clippy --all-targets --features miner -- -D warnings`,
  `cargo check --target wasm32-unknown-unknown` and
  `cargo tree --features miner` (no `libriichi`) were clean. The full suites
  were red only on the pre-existing wall-clock budget tests
  (`test_pair_count_open_constraints_100_runs`,
  `test_perfect_one_away_constraints_100_runs`,
  `test_protorun_priority_constraints_100_runs`,
  `test_chiitoitsu_dama_rejection_sampling_100_hands`); each passes when run
  alone (2.8–4.6 s against its 5–10 s budget), so that is suite-load timing
  sensitivity in the generators, not the labeler.

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

## Selection: gates, quotas, dedupe and the review queue (S2)

Status: implemented in `src/miner/select/`. Replay-strategy §6.6 makes selection
a quota problem rather than one sort, §7.1 separates hard gates from ranking, and
§7.5 keeps a human in the loop. The pipeline is:

```text
decisions -> gates 1-6, 8 -> valid candidates -> held-out QA split
                                               -> novelty + composite score
                                               -> family buckets
                                               -> quotas + section/kind/turn caps
                                               -> gate 7 (dedupe) during fill
                                               -> review-queue.jsonl
```

Labels are read only at the current `CLASSIFIER_VERSION`: a `decisions` row or
`model_labels` cache row from another generation is treated as unlabelled. This
is the read-side half of the labeler's stale-label clear, so a selection can
never publish an answer produced by a retired rule set.

### Hard gates (§7.1)

| # | Gate | What it checks |
| --- | --- | --- |
| 1 | `reachable` | four seats, a non-empty legal set, and (for a hand-built candidate) `validate_reachable_state`; the walker already dropped unreachable decisions |
| 2 | `answer_defined` | a shippable label, no unresolved `book_conflict`, a non-empty accepted set for a book answer, and at least two legal actions for a Mortal-only drill |
| 3 | `answer_legal` | the answer is a legal discard/Riichi/Kan/Pass/call on this state, and every accepted equivalent is a legal discard |
| 4 | `visible_information` | the model-visible hash is unchanged when opponent concealed hands are removed; the legal set survives the redaction; a discard answer is in the actor's visible hand |
| 5 | `label_confidence` | a book answer is exact; a Mortal-only answer needs the family's L2 confidence band, or the configured top-1 probability/margin fallback when the family has fewer than eight samples |
| 6 | `provenance` | `source = ai_selfplay`, an allowlisted data licence, a validated `GameProvenance` and a publishable validation summary |
| 7 | `duplicate` | exact state hash and visible-info fingerprint are both new (applied during the fill) |
| 8 | `spoiler` | the pre-answer texts (lesson label/description, situation note, selection reason, provenance line) contain no accepted answer tile and no wait tile |

Gates fail closed and short-circuit in that order, so the report's per-gate
counts are first failures and add up to the funnel's `valid` row. Gate 7 lives in
`dedupe.rs` because it depends on what the pack already holds.

### Ranking signals (§7.2)

Every signal is `0.0..=1.0`; `ScoreWeights::score` is their weighted mean, with
the §7.2 defaults `0.25/0.15/0.15/0.15/0.15/0.10/0.05` and configurable weights.

- `book_match`: a cited book answer (0/1).
- `label_confidence`: percentile rank of the top-two gap inside the decision
  family, falling back to the pooled sample and then to `top_probability`.
- `counterfactual_tension`: one minus that rank, plus one minus the safe-gap
  rank when `q_gap_safe` exists.
- `stakes`: a documented visible-state proxy (`score_leverage`, `hand_value`,
  `threat`); never a point claim.
- `discrimination`: the played-action gap's percentile rank, or the thin-gap
  fallback when the record played the model's top action.
- `novelty`: inverse frequency of the book section, decision kind and turn
  bucket in the valid pool (coverage, not rarity for its own sake).
- `realism`: a clean walk and publishable provenance, reduced per reconstruction
  warning.

The score ranks **within** a family after the gates; it never rescues a
candidate that failed one.

### Quotas, caps and the relaxed fill

`QuotaConfig` holds family shares (`book` 0.30, `coverage` 0.15,
`mortal_best`/`mistake`/`close_call` 0.10, `speed_value` 0.08,
`table_read` 0.07, `contested`/`placement` 0.05, `multi_step` 0.00) and the
diversity shares (book section 0.20, decision kind 0.60, turn bucket 0.60).
Shares become integer quotas by largest remainder and caps by ceiling. The fill
is round-robin, deepest deficit first, so one rich family cannot starve a scarce
one.

A cap is a "do not let this bucket crowd out the others" rule, not a reason to
ship a short pack. If slots remain and every remaining candidate sits in a bucket
that has met its cap, the selector relaxes the cap rather than leave the slot
empty; under-quota families are repaired first, then the best remaining
candidates fill the rest. The report records `relaxed_fill` and `cap_relaxed`,
the per-bucket `relaxed` count, and a shortfall reason per family
(`no_candidates`, `shared_with_other_families`, `cap_limited`, `exhausted`,
`pack_full`). A family is never silently substituted.

### Lesson scope and corpus mix (Q2)

A curated lesson pack needs selection to be scoped, not just balanced. Four
optional filters sit before the gates:

- `--section ch8` (or `ch8.2`) keeps only book sections with that prefix. A
  Mortal-only candidate has no section and is rejected while a section scope is
  active, because a ch. 8 pack is a book-lesson pack.
- `--lesson fold_to_riichi,defense_safety_chart` keeps exact lesson ids.
- `--corpus-family` keeps only those replay family directories; selection also
  stops walking files outside the list, so a scoped run does not pay for the
  whole corpus.
- `--stable-book-only` keeps `label_kind = book` and rejects a contested
  book/Mortal disagreement. The first curated pack uses this so a learner is not
  asked to arbitrate an unsettled position.

`--corpus-cap family=N` is a **mix rule**, not a crowding-out guard: no more than
N selected bases may come from that corpus family, it is enforced in both the
quota round and the relaxed fill, and the pack reports a shortfall rather than
exceeding it. The report's `replay_families` rows record each family's cap,
candidate count, selected count and whether the cap was reached. The scope is
also written into the report notes, so the queue explains why a candidate was
rejected (`out_of_scope`, `scope_not_stable_book`).

`--extracted-only` drops replay files that have no `decisions` rows before the
walk (a 999-file data root may hold only a few hundred extracted games).
`--max-per-replay N` caps one source game's contribution, so adjacent turns
cannot look like repeats. `--workers N` (default `0`) uses every available core;
`--progress` prints phase/file progress to stderr. The selection passes are
parallelised per replay file and merged in file order, so the report and pack
are deterministic for a given worker count.

The lesson scope does not change the family quotas: a scoped candidate still
feeds `book`, `coverage`, `table_read`, `placement` or whichever families its
triggers name, and the quota fill balances those as usual. A lesson-scoped pack
also needs a higher section cap (`--max-section-share`, default 0.20) because
three ch. 8 sections cannot fill 100 slots under a 20-scenario per-section cap.

### Dedupe

`exact_state_hash` is the L1 cache key (the SHA-256 of the v4 observation), so
the selector and labeler agree on "the same position". `visible_info_fingerprint`
is a SHA-256 over the literal visible table (actor hand/draw, every meld and
river, dora, scores, round, decision context). Opponent concealed hands are
excluded; tile codes are never canonicalised, so a suit-permuted variant has a
different fingerprint and is not mistaken for its base (V1 records the explicit
`variant_of` lineage; V2 expands, gates and caps the variants per base).

### Held-out QA and the funnel

The held-out split takes `ceil(held_out_share * pack_size)` candidates (default
10 of a 100 pack) in a deterministic `sha256(salt, exact_hash)` order, dedupes
them among themselves and removes them from the pack pool. It is reproducible;
changing `--seed` re-draws it deliberately.

The selection report carries the ordered funnel `raw (replays requested) →
generated (always 0 for a selection run) → parsed → games_valid → decisions →
trigger → reconstructed → classified → labelled → valid → held_out → selected →
packed (always 0; P1b owns the pack)`. Gates run after labelling because gate 5
reads the label, so `valid` follows `labelled` rather than preceding it.

### Review queue

Each `review-queue.jsonl` line is a `riichiprac.review-item` v1 with the
answer-free selection metadata plus a complete `riichiprac.scenario-report` for
that one candidate. The report is built by the existing `report::build_report`:
the walker snapshot is re-stamped with the label's answer (book lesson and target
action, or the Mortal action vocabulary), the AI block is reconstructed from the
cached ranking, and the note records the selection reason and the fragment
hashes. The reviewer therefore sees the table, the graded answer, the book
rationale and the Mortal ranking in the same document the app's importer
validates. The queue contains the answer and is never published; P1b emits the
trainee payload from the selected scenarios.

### Bulk review and the sampled flow (Q2r2)

One-at-a-time review does not scale past roughly a thousand candidates. Two
additions make a ~2,000-candidate queue reviewable:

- **Bulk verdicts.** `scripts/review-q2-queue.py --verdicts-out FILE` applies the
  mechanical chapter rules (`--chapter ch8` by default, or `ch7` for the
  riichi/dama queue, where the ready-hand rejection does not apply) to the whole
  queue and writes one
  `riichiprac.review-verdicts` v1 document:
  `{"schema": "riichiprac.review-verdicts", "version": 1, "note": "...",
  "verdicts": [{"queue_id": "...", "verdict": "accepted"|"rejected",
  "reason": "..."}]}`. `mine_replays review --verdicts FILE` reads it, checks
  the schema/version and that no queue id repeats or is missing from the queue,
  and appends every disposition in one run. The document is append-only in the
  same way a single verdict is: the latest disposition per item wins, so a
  later reviewer can override a mechanical rejection.
- **Sampled review sheet.** `scripts/sample-review-sheet.py` selects a
  deterministic, stratified sample (seed, per-lesson and per-family guarantees,
  and every item of a lesson below `--include-all-below`) and prints the
  answer-bearing fields as a markdown sheet. `--out-json` records the sampled
  ids and per-lesson/per-family counts, which is what the run report cites as
  the review evidence.

The mechanical pass is still a gate, not a judgement: it rejects out-of-scope
sections/lessons, non-book or contested labels, report/lesson mismatches,
illegal answers, duplicate exact/visible states and dirty walks. The ch. 8
scope also rejects a ready hand (that is an offense drill); the ch. 7 scope
keeps it, because a riichi/dama decision is tenpai by definition. The human
sample is the evidence that the remaining positions teach.

#### Filtering, progress and the review surface (Q2r2)

The same `review` command lists and narrows the queue instead of applying one
verdict per id. `--lesson`, `--section` (dotted prefix), `--family` (source
replay family), `--turn` (bucket or exact table turn) and `--status`
(`pending`/`accepted`/`rejected`, latest disposition wins) compose as an AND
filter. The run reports session progress over the whole queue — `pending`,
`accepted`, `rejected`, the dispositioned percentage — plus how many rows the
filter selected, so `--status pending` resumes exactly where the reviewer
stopped. `--list` prints the shown rows with hand and answer; `--json` adds the
per-row `lesson`, `turn`, `hand`, `answer` and `selection_reason`; `--show <id>`
still prints one embedded report.

`--sample N --seed TEXT` draws a deterministic sample of the filtered rows:
candidates rank by FNV-1a 64 over `seed\0queue_id` plus a SplitMix64 finalizer
(so sequential ids do not turn the sample into the first N), the first N are
taken, and the rows return in queue order. `--limit` caps the printed rows.
`--bulk-verdict accepted|rejected` applies a verdict to exactly the shown
selection and refuses to run without at least one filter and a `--note`;
`--verdicts-out FILE` writes that selection as an editable
`riichiprac.review-verdicts` document instead. Neither changes the P1b gate: the
sidecar is still append-only, latest-wins, and assembly still requires zero
pending items.

`frontend/tools/review-queue/` is a thin static browser view over the same queue
and sidecar: filters and progress, rows without the answer (the list stays
spoiler-free), and one embedded report at a time with the table, graded answer,
Mortal ranking and provenance. Accept/reject entries are kept in a keyed
`localStorage` session so a reload resumes, then exported as the same bulk
verdicts document (or as append-only JSONL) and applied with
`mine_replays review --verdicts`. The page never writes to the data root and is
not part of the shipped app. `reviewing-scenario-packs.md` documents the 1k–2k
workflow, what the human is judging, and how to verify the round trip.


### S2 acceptance evidence

- `cargo test --features miner` covers a positive and a near-miss negative for
  every gate, the redaction test that removes opponent hands, quota balance and
  shortfalls, section/kind caps plus the relaxed fill, exact and near dedupe, the
  deterministic held-out split, novelty ordering, the partial-share open fill,
  the JSONL item round-trip through `parse_report`, append-only dispositions and
  the latest verdict winning, a dry run writing nothing, and a full shard run
  that writes the queue, the held-out set, the report and `LATEST` and then
  re-reads the queue through `review`.
- The corpus acceptance sample is [`selection-s2-sample.md`](selection-s2-sample.md)
  with its machine-readable report at
  [`testdata/reports/s2-selection-sample.json`](testdata/reports/s2-selection-sample.json):
  a 100-scenario queue from four `mortal_mirror` games, 0 duplicates, 0 invalid
  reports, a 10-item held-out set and a balanced family mix. Human review of
  those 100 items is the remaining step; S2 ships the queue, not a verdict on
  whether a position teaches.
- `cargo clippy --all-targets --features miner -- -D warnings`,
  `cargo check --target wasm32-unknown-unknown`, `cargo test --lib` and
  `cargo tree --features miner` (no `libriichi`) stay clean.

Visual sign-off is not involved in S2.

## Variants: label-preservation gate and pipeline stage (V2)

Implemented in `src/miner/variant/`. This is stage 8 of the pipeline
(`replay-implementation-plan.md` §4): after selection and before pack assembly,
each selected base scenario is expanded into drill variants that teach the same
lesson. A variant is never hand-edited: it ships only when the transformed state
is legal and its label survives a full re-run.

```text
selected bases (review queue)
        │  per-lesson TransformPolicy (§4.5)
        ▼
  planned chain ──► V1 apply ──► finalize_state
        │                              │
        │                  reachability + tile ledger + legal answer
        │                              │
        │                 label-preservation gate (§4.4)
        │        book      contested      mortal        mistake
        │     lesson +    book + top-1   top-1 + L2    played action
        │     answer set                 margin band    still a mistake
        ▼                              │
  reject with a stable code ◄──────────┘
        │
        ▼
  per-pair yield ──► disable < 50 % pairs ──► dedupe ──► per-base/per-pack caps
        │
        ▼
  gated PackScenarios ──► build_pack ──► P1a gate ──► publish
```

### CLI

```bash
# Real run: the latest select run's queue (or --queue FILE), book bases only.
cargo run --features miner --bin mine_replays -- transform \
  [--queue FILE] [--pack-id ID] [--variants N] [--max-per-base N] \
  [--share F] [--pack-size N] [--min-yield F] [--seed TEXT] \
  [--yield-policy FILE] [--weights MORTAL.safetensors] \
  [--workers N] [--progress] \
  [--out DIR] [--pack] [--dry-run] [--json]

# The §4.7 rehearsal: generated book puzzles, no corpus or checkpoint.
cargo run --release --features miner --bin mine_replays -- \
  --data-dir /tmp/riichi-rehearsal transform --rehearsal 100 --pack
```

`--weights` is required for Mortal-only bases (and for the book tiebreak that a
contested base needs); a book base runs without it. `--yield-policy` is the
reviewer's decision file: a pair the stage disabled stays disabled unless an
entry says `enabled: true`. The queue reader skips held-out QA items and
reviewer-rejected items; a pending item is transformed (P1b still refuses to
ship a pack with a pending disposition). `--pack` assembles the bases and the
gated variants and publishes through P1a, which re-runs the
source/licence, provenance, answer, spoiler and variant-honesty gate; a
rehearsal supplies P1a's fixture provenance, so it needs no corpus.

`--workers N` (default `0` = every available core, Q2p) plans and gates bases in
parallel: each worker transforms its base and re-runs its label outside the
database lock, and the results merge in base order, where dedupe, the early stop
and the caps apply exactly as the serial run applies them. The shipped set,
the rejected list and the report therefore do not depend on the worker count
(the report records the resolved `workers` and `wall_time_ms`; `--progress`
prints the base count). One overlap is recorded rather than hidden: two bases
whose chains produce the same transformed state share one cache row, so
`labels.evaluated`/`labels.cached` can differ between a serial and a parallel
run by that overlap while the shipped set stays identical.

### Outputs

```text
$RIICHI_DATA_DIR/reviews/<pack-id>/variants/
  variant-report.json   riichiprac.variant-report v1
  variants.jsonl        one gated PackScenario per line (answer-bearing; review-side)
  rejected.jsonl        every attempted chain that did not ship, with its code
$RIICHI_DATA_DIR/packs/ …                        only with --pack (P1a body + manifest)
selected_scenarios / variants                    queue runs, DB rows for P1b
```

The variant files are review artifacts and are never published. `--dry-run`
writes neither the files nor the pack, and `--pack` with `--dry-run` is refused.

### Policy

The opt-in lives on the classifier (V1's `TransformPolicy`), because the lesson
is what declares its own invariance; §4.5's matrix is the starting point and the
gate, not the table, decides. A label with no lesson (Mortal-only) uses
`VariantConfig::mortal_policy`, which defaults to **deny everywhere**: the
catalogue rule is "a missing opt-in loses volume, a wrong opt-in ships a broken
drill". The planner draws non-identity chains deterministically from
`sha256(seed|base|attempt)`; the first attempts are one family each, then two
distinct composed families. Every allowed family is attempted at least once per
base, so a family's yield is measured even when the base reaches its variant
target early.

### Decisions worth knowing

- **Cache key.** The model labels are cached through L1's existing
  `(state_hash, model_sha256, classifier_version, options_hash)` key. The
  transform chain is not in the key: the model sees the transformed state, so
  two chains that produce the same state must share one evaluation, and adding
  the chain would only fragment the cache. The chain is recorded on the variant.
- **Furiten.** The gate passes the base's permanent-furiten value (the walker
  rejects a furiten decision before it is ever selected). Every catalogue
  transform relabels the actor's river and waits together, so the flag is
  invariant; a furiten base never becomes a book drill by relabelling.
- **Seed.** `transform_seed` lives in the `riichiprac.scenario-transforms`
  document and is copied to `provenance.transform_seed` for consumers that do
  not parse the chain; P1a rejects a variant whose two copies disagree.
- **Label kinds.** A book base is checked against its classifier; a contested
  base against both halves; a Mortal base against the model; a mistake base adds
  the forward-mapped played action. A base with no label kind (`none`) is not
  transformed at all.

### Gate

- **Apply and recompute.** V1 `apply` fails closed on an impossible table (a chi
  that stops coming from kamicha, a red-five answer). `finalize_state` refreshes
  the derived fields.
- **State checks.** `validate_reachable_state`, the V1 `TileLedger` (no fifth
  copy) and the legal-answer check run on the transformed state.
- **Book.** The classifier must still name the same lesson; the inverse-mapped
  answer type, named answer and **whole accepted set** must equal the base's.
  A book re-run that leaves a conflict the model cannot settle is rejected.
- **Contested.** The book half plus the model's top-1 must both survive.
- **Mortal.** The model's top-1 must inverse-map to the base top-1. When the
  base's decision family has L2 percentile cuts, the top-two gap must stay in
  the same band: a close call that becomes obvious is a different drill.
- **Mistake.** The book half plus the recorded played action, forward-mapped, is
  still not the answer.
- **No-op.** A chain that leaves the state unchanged (typically a red-five
  normalisation on a state with no red five) is rejected as `transform_noop`.
- **Spoiler.** The assembled scenario runs P1a's `find_spoiler` before it can
  ship.

Every rejection has a stable code (`state_unreachable`, `tile_ledger`,
`transform_rejected`, `transform_noop`, `lesson_missing`, `lesson_changed`,
`label_conflict`, `answer_changed`, `answer_set_changed`, `top1_changed`,
`margin_band_changed`, `mistake_resolved`, `answer_illegal`, `duplicate_state`,
`spoiler`, `labeler_required`, …), which is what the yield report counts.

### Yield, disable, dedupe and caps

The report counts attempts/preserves/rejections per `(lesson, transform family)`.
A composed chain counts once under each family it contains. A pair below
`min_yield` (default 50 %) is disabled **for this run**: its preserved variants
are withdrawn before the caps, and the pair is listed with its ratio. Reviewer
overrides can keep it enabled (`--yield-policy`) or disable it explicitly.
Exact model-visible state hashes collapse, including against the base states.
The effective per-base cap is `min(max_per_base (8), floor(max_pack_share (20 %)
× pack_size))`, so a share binds first in a small pack; every truncation is in
`cap_limited` with its cause. The report also carries the variant share, the
largest single-base share, the shipped families and the label cache activity.

### Storage and pack integration

A queue run upserts each base into `selected_scenarios` and each attempt into
`variants` (`label_preserved` 0/1 with the rejection reason), and a shipped
variant also gets a `selected_scenarios` row with `variant_of`,
`transform_chain` and `label_check`. The pack scenario copies the seed onto
`provenance.transform_seed` (the chain document also carries it); P1a's audit
rejects a variant with no seed or with a seed that disagrees with the chain.
P1b can rebuild the transformed state by applying the recorded chain to the base
decision's state, so the DB stores references and provenance, not a second copy
of every table. `build_pack` refuses a variant with a missing/failed
`label_check`, no chain, no seed or a base outside the pack, and the P1a gate
re-checks the same fields.

### Known finding: the wind rotation is disabled

`wind_relabel` measured below 50 % for every lesson in the 100-base rehearsal
(mostly 0 %). The engine rotates the round wind and all seat winds, but the
reachability validator derives the dealer from the actor's seat wind
(`dealer_seat(players[0].wind)`), which the rotation changes while the rivers
stay put; most rotated tables are therefore not a legal discard timeline. V2's
job is to measure and fail closed, which it does: the pairs are disabled by
default until a policy/validator review opts them back in. The rehearsal's
`state_unreachable` rejections are almost all this case plus genuine seat
permutations whose river counts no longer fit a legal order.

### V2 acceptance evidence

- `cargo test --features miner` covers the §4.7 checklist and the §4.8 cases:
  every shipped variant reachable/ledger-clean/legal/spoiler-free and carrying
  `variant_of`/`transform_chain`/`transform_seed`/`label_check`; reproducible
  draws; threshold-disabled and reviewer-overridden pairs; both cap causes;
  duplicate-base and commuting-chain dedupe; wind-order denial; honitsu and
  suji-trap suit survival; pinfu-head rank re-runs; the absent
  sanshoku/ittsu/placement lessons failing closed; red-five denial and no-op
  rejection; Mortal labeler-required/top-1-flip/stable-cache/band-change cases;
  DB persistence; the pack gate refusing an ungated or baseless variant; and the
  runner's files, dry run and published pack.
- The 100-base rehearsal is
  [`variants-v2-sample.md`](variants-v2-sample.md) with its machine-readable
  report at [`testdata/reports/v2-variant-report.json`](testdata/reports/v2-variant-report.json):
  100 bases → 590 attempts → 284 preserved → 265 shipped (3 families:
  `suit_perm` 135, `rank_mirror` 87, `seat_perm` 43), 78 disabled pairs, 19
  withdrawn, no base above 4 of the 8 cap, a 365-scenario pack (72.6 % variants)
  and a clean P1a audit. `cargo test --features miner`'s ignored
  `a_hundred_base_rehearsal_meets_the_acceptance_gate` runs the same check.
- `cargo clippy --all-targets --features miner -- -D warnings`, `cargo fmt
  --check`, `cargo test --lib` and `cargo check --target wasm32-unknown-unknown`
  stay clean. No wasm behaviour changed.

Visual sign-off is not involved in V2.

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
`riichiprac.scenario-transforms` document), `provenance.transform_seed`,
`provenance.label_check`, `played.agent` and `data_commercial_use` on the
manifest entry. Every scenario
carries the complete `GameState` plus its own `correct_action`/`accepted`; the
audit recomputes the state's copy and rejects a mismatch. A single candidate is
reviewed through the existing `scenario-report` path (it takes the same
`GameState` the pack embeds); P1a adds no pack-specific review format.

**Lesson coverage (replay-first rollout).** The manifest entry gains a
`lesson_counts` map (lesson id → shipped reviewed bases) written by `pack
publish` and validated against the body, so the frontend can decide which
lessons are replay-default without downloading a body. A **base** is a scenario
selected from the corpus; a variant derives from one base and adds no review
coverage, so it is not counted. `pack publish` derives the map from the decoded
body, which is also how a source manifest published before the field existed
gets counts on the next hosted publish. A recorded count that disagrees with the
body is an audit error (`lesson_count_mismatch`); a map that is absent is a
strict-mode warning (`lesson_counts_missing`) so an old manifest still audits,
while the hosting verifier and `scripts/check-pack-hosting.mjs` require it on a
published artifact. The field is additive within manifest v1: a reader accepts a
manifest with or without it. Packs are published one per book section (ch3, ch4,
ch5, ch7, ch8 completion, ch9) rather than per lesson, and a lesson becomes
replay-default only when its shipped count reaches the coverage floor (40
reviewed bases, proposed). The full contract, coverage table and task sequence
are in [`replay-first-rollout.md`](replay-first-rollout.md).

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
| variant honesty | a transform chain validates, `provenance.transforms` matches it, and a variant carries `label_check.preserved = true` (V2 emits exactly this record; the audit re-checks it) |
| budget | encoded gzip body within `max_bytes` (default 50 MB), scenario count within `max_scenarios` (default 5,000; a sanity split bound, not a pack target), manifest within 512 KiB |
| manifest integrity | entry path is safe and content-addressed, hash/bytes/scenario count match the body, convenience metadata drift is a strict-mode warning, and a recorded `lesson_counts` map matches the body's reviewed bases (an error, not drift) |

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

## Pack assembly from the selected, gated rows (P1b)

Implemented in `src/miner/pack/assemble.rs`. P1b is the export half of the pack
pipeline: it reads the rows S2/V2 wrote and turns them into an audited,
content-addressed pack plus the `packs`/`pack_scenarios` records.

```text
selected_scenarios + variants + decisions + replays
   │  rebuild each PackScenario (base state, or base + recorded chain)
   ├─ review gate: pending disposition / invalid embedded report refuses the pack
   ├─ exact-state dedupe
   ├─ per-base cap (§4.6; defaults 8 variants / 20 % of the pack)
   ├─ optional family quotas (counted in base scenarios)
   ├─ optional global variant ceiling (`--max-variants`, evenly spaced)
   └─ byte/scenario budget → refuse, never trim
          ▼
   P1a encode + audit → packs/<pack-id>-<sha256-prefix>.json.gz + manifest.json
          ▼
   packs + pack_scenarios rows → reviews/<pack-id>/assembly-report.json
```

### What is rebuilt, and from what

The DB stores references and provenance, not a second copy of every table. A
base scenario is rebuilt from the walked `decisions.state_json`; a variant is
rebuilt by applying the recorded `variants.transform_chain` to that base state.
Both are then re-stamped through the lesson's classifier, which re-derives the
situation note, triggers and answer set. The rebuilt answer and `accepted` set
must equal the stored ones — a disagreement is a stale/corrupt row and refuses
the pack rather than being papered over. A `mortal_best` row has no classifier;
its stored answer is stamped with the target action derived from the action kind.

A selected row is read with its decision and replay row; a missing decision or
replay, a variant without a `variants` row, or a `variants` row whose
`label_preserved` is 0 are all hard failures. A variant whose recorded chain,
seed or label check disagrees with the provenance JSON is also refused.

### Review gate

When `reviews/<pack-id>/review-queue.jsonl` exists (or `--queue` is passed), every
non-held-out item needs a disposition, the embedded `riichiprac.scenario-report`
must parse, and the queue must belong to the pack. A pending item or an invalid
embedded report refuses the whole pack. A reviewer-rejected base is dropped with
reason `reviewer_rejected`, and its variants with `base_dropped`. A selected base
that is not in the queue at all is refused as unreviewed.

### Limits and determinism

- **Dedupe** by exact state hash, in pack order. The body is ordered **all bases
  first, then all variants** (each block in base-id order); the picker deals in
  body order, so a learner sees every distinct position before any relabelled
  repeat, and `pack_scenarios.ordinal` uses the same order.
- **Per-base cap** = `min(max_per_base, floor(max_pack_share * planned
  scenarios))`, counted in variants (§4.6 defaults 8 and 20 %; a 100-scenario
  pack allows 20). The report's `largest_base_share` counts the base plus its
  variants.
- **Global variant ceiling** (`--max-variants N`) keeps at most N variants,
  evenly spaced across the remaining pack order rather than truncating the tail.
  Excess variants are reported as `variant_limit`; the base block is untouched.
- **Variants disabled** (`--no-variants`) drops every variant with reason
  `variants_disabled` and ships the reviewed bases only. This is a product
  decision for a pack that gets its variety from real scenarios; the variant
  stage and its label-preservation gate stay available for a future design.
- **Minimum bases per lesson** (`--min-bases-per-lesson N`, default 1) drops a
  lesson whose base count is below N with reason `lesson_too_small`. A replay
  lesson with one state would otherwise deal that same position every time it
  is drawn; the generated lesson remains available for that topic.
- **Unique actor hands** (`--unique-hands`) keeps the first scenario for each
  13/14-tile actor hand and drops later states with the same hand as
  `duplicate_hand`. Different rivers/scores make these distinct state hashes,
  but a learner still reads them as the same drill.
- **Family quotas** (`--family-quota book=30,coverage=15`) are optional explicit
  ceilings counted in **base** scenarios (§4.6: quotas count bases, not
  variants). S2 already balanced the selection, so the default leaves the
  reviewed rows alone.
- **Budget.** A body over `PackBudget::max_bytes` (50 MB) or a scenario count over
  `max_scenarios` (2 000) is refused; split the pack instead of shipping a
  different selection.
- **Determinism.** The scenario order is fixed, `generated_at` defaults to the
  latest selected row's `created_at` (not the wall clock), and the encoder is
  already deterministic, so re-assembling the same rows produces the same
  SHA-256. `--generated-at` pins it explicitly; `generator.commit` defaults to
  the label `db`, never a fake SHA.

### DB records and the assembly report

`packs` gets one upserted row per export: schema/version, manifest path, body
SHA-256/bytes/count, `source_mix` (the per-family mix + variant share),
licence, `data_commercial_use`, publish/created timestamps and the root-relative
`export_path`. `pack_scenarios` gets one row per scenario: ordinal, base id (for
a variant), lesson, selection family, exact state hash, SHA-256 of the serialised
`PackScenario`, and the variant flag. The re-audit (`audit_pack_dir`) runs after
publishing; the report records `audited`/`audit_clean`.

The report (`riichiprac.pack-assembly-report` v1) at
`reviews/<pack-id>/assembly-report.json` carries the family mix, variant share,
largest base share, byte size, licence, commercial flag, agent union, every drop
with its stable reason, the caps/quotas applied and the review summary.

### CLI

```bash
# Export the latest `select` pack from the miner DB.
cargo run --features miner --bin mine_replays -- pack assemble \
  [--pack ID] [--queue FILE] [--licence ID] [--attribution TEXT] \
  [--max-bytes N] [--max-scenarios N] [--max-per-base N] [--share F32] \
  [--family-quota book=30,coverage=15] [--max-variants N] [--no-variants] \
  [--min-bases-per-lesson N] [--unique-hands] \
  [--generated-at ISO] [--commit TEXT] \
  [--dry-run] [--json]
```

`--licence`/`--attribution` default to the packed replays' shared values; a
disagreement asks for them explicitly. `--dry-run` builds and audits the pack in
memory but writes no body, manifest, DB rows or report. Exit codes: 0 clean,
1 a failed pack audit, 2 an unreadable/unassemblable selection.

### P1b acceptance evidence

- `cargo test --features miner` covers: a realistic selection (three rehearsal
  bases persisted through the V2 stage with real chains/gates) assembling into a
  clean pack whose decoded body equals the manifest entry, the `packs` row and
  every `pack_scenarios` row (id, ordinal, base, lesson, state hash, scenario
  hash, variant flag); the directory audit clean; the report round-trip;
  determinism (a second assembly produces the same SHA-256); the per-base cap,
  exact-state dedupe and family quotas (both directly and through the DB); the
  byte and scenario ceilings; the review gate (accepted/rejected split, a pending
  item, an invalid embedded report); a missing selection; an ungated variant; the
  family-quota parser and variant-cap bounds; and DB stamp→ISO normalisation.
- `cargo fmt --check`, `cargo clippy --all-targets --features miner -- -D
  warnings`, `cargo test --lib` (745), `cargo test --features miner` (1 091) and
  `cargo check --target wasm32-unknown-unknown` are clean. No wasm behaviour
  changed and no visual output is involved.

## Same-origin pack hosting, CI copy and mirrors (P2)

Implemented in `src/miner/pack/host.rs`, `scripts/check-pack-hosting.mjs`,
`scripts/check-pack-cors.mjs` and the Pages workflow. P2 publishes the audited
P1b export without shipping the corpus: the browser loads a small same-origin
manifest and content-addressed pack bodies, and the miner's export directory is
never part of the artifact.

### Layout and the source of truth

```text
$RIICHI_DATA_DIR/packs/                  # audited export (operator machine)
├── manifest.json
├── <pack-id>-<sha256-prefix>.json.gz    # bodies
└── games.jsonl                          # GameProvenance rows, audit-only

frontend/public/scenarios/               # same-origin hosting (committed/CI)
├── manifest.json                        # same-origin, fetched on page visit
└── <pack-id>-<sha256-prefix>.json.gz    # identical bytes, no games.jsonl
```

`pack assemble` / `pack fixture` write the left-hand tree. `pack publish` copies
only the manifest and the manifest-listed bodies into the right-hand tree; it
never copies `games.jsonl`, raw replays, databases or weights. It derives each
entry's `lesson_counts` from the decoded body while copying, so the hosted
manifest always records per-lesson coverage even when the source manifest
predates the field. The P1a/P1b directory audit (which does use `games.jsonl`)
runs on the **source** before any copy, so a pack that cannot prove its
provenance never reaches Pages. The hosted
directory therefore carries no provenance rows: re-audit the export, not the
artifact. `scripts/check-pack-hosting.mjs` is the artifact-side verification.

The manifest is same-origin and every path in it is relative. That is
deliberate: the loader tries the same-origin manifest/body first, and an
optional external mirror is only a second base for the same relative path. A
pack is never loaded from Google Drive.

**Raw-body serving.** The loader checks a body's byte count and SHA-256 before
it gunzips it, so the body must arrive as the exact stored bytes:
`Content-Type: application/gzip` and no `Content-Encoding`. GitHub Pages already
does that; `frontend/vite.config.ts` installs a `rawScenarioPackBodies`
middleware for `vite dev`/`vite preview`, and a mirror must configure the same.
`scripts/check-pack-serving.mjs` starts the preview server and asserts the
headers, bytes and hash. A server that decompresses `.gz` responses makes the
loader see the JSON document and reject the pack.

### Budgets

| Budget | Default | Enforced by |
| --- | --- | --- |
| one pack body | 50 MB | P1a gate during `pack assemble`/`pack fixture` |
| all hosted bodies | **50 MB** | `pack publish` (`HostBudget`) and the CI check |
| manifest | 512 KB | `pack publish` and the CI check |

The AGENTS.md 8 MB committed-asset budget is mostly consumed by the
rendered-view shells/felt, so packs do not get it. Stay same-origin only while
the whole hosted set is small; a larger set moves to the R2/HF mirror. An
over-budget set is **refused**, never trimmed: which pack to drop is an operator
decision, not a silent publisher decision.

### Publisher

```bash
# Stage the full audited export (default source <data-dir>/packs,
# default destination frontend/public/scenarios).
cargo run --features miner --bin mine_replays -- pack publish \
  [--from DIR] [--to DIR] [--packs ID,...] [--max-total-bytes N] \
  [--updated-at ISO] [--commercial] [--dry-run] [--json]
```

- **Audit first.** `audit_pack_dir` on the source must be clean under the chosen
  profile; a dirty source or a missing `games.jsonl` is refused.
- **Allowlist copy.** Only `manifest.json` and the selected content-addressed
  bodies are written. Every body is re-hashed and re-sized while copying, and
  its `lesson_counts` are re-derived from the decoded pack.
- **Selection.** With no `--packs`, every source entry is hosted. With ids, the
  hosted set becomes exactly those packs, and bodies the new manifest no longer
  lists are pruned (content-addressed names change with every edit, so pruning
  is what keeps the artifact from growing forever).
- **Foreign files.** The destination may contain only `manifest.json` and
  `.json.gz` bodies. A README, hidden file or weights file refuses the publish
  without touching anything.
- **Atomic and verified.** Bodies and the manifest go through
  `write_atomic`; the staged directory is read back through
  `verify_hosted_dir`, which re-hashes, decodes and compares the manifest's id,
  count, lesson ids, per-lesson `lesson_counts`, book sections, licence,
  `requires_model` and `data_commercial_use` with the body.
- `--dry-run` reports the planned bodies and stale files and writes nothing.
- Exit codes: 0 published/verified, 1 refused (dirty source, unknown pack,
  over budget, invalid staged directory), 2 unreadable input.

`--generated-at` on `pack fixture` pins the smoke pack's timestamp, so the
committed `frontend/public/scenarios/` artifact is reproducible.

### CI: Pages build, copy and checks

`.github/workflows/deploy.yml`:

1. **Optional Release copy** (`vars.PACK_RELEASE_TAG`). GitHub Release assets
   send no `access-control-allow-origin` header (hosting-plan.md), so they are
   never a browser source. When the variable is set, CI replaces
   `frontend/public/scenarios/` (in the CI workspace only) with the release
   `manifest.json` and `*.json.gz`; without it the committed smoke pack is used.
2. **Before the build**, `node scripts/check-pack-hosting.mjs` verifies the
   staged directory: manifest schema/version/size/sort, safe relative
   content-addressed names, every body's bytes and SHA-256, the gzip/JSON
   decode, manifest↔body metadata, `source.kind = ai_selfplay`,
   redistributability/attribution/agents, the 50 MB total and the "only packs
   in this directory" rule.
3. **After the build**, the same check runs on `frontend/dist/scenarios`, which
   proves the Pages artifact includes the packs at `/riichiprac/scenarios/`.
   (The weights under `dist/models/` are intentional and outside this
   directory; the check's rule is about the pack artifact, not the app bundle.)
4. **Optional mirror CORS check** (`vars.PACK_MIRROR_BODY_URL`) runs
   `scripts/check-pack-cors.mjs` with `Origin: https://chairbender.github.io`.
   It passes only on `200`, a non-HTML content type and
   `access-control-allow-origin: *` (or the Pages origin), and can also assert
   `content-length` and the exact SHA-256 of the audited body.

Both scripts are dependency-free and print numbers and pass/fail; neither judges
a render (AGENTS.md §6).

### Optional R2 / Hugging Face mirror

The manifest stays on Pages. Mirror the **same `scenarios/` directory layout**
and point a loader at `<mirror-base>` as a fallback for the same relative
paths. The mirror never replaces the manifest.

```bash
# Cloudflare R2 (rclone remote `r2:riichiprac`; credentials stay in rclone's
# config, never in the repo).
rclone copy frontend/public/scenarios r2:riichiprac/scenarios --checksum

# Hugging Face dataset repo (public, browser-fetchable).
hf upload chairbender/riichiprac-packs frontend/public/scenarios scenarios \
  --repo-type dataset
```

R2 bucket CORS must allow `GET`/`HEAD` from `https://chairbender.github.io`
(or `*`), and expose `content-length`/`content-type` if the loader needs them.
Measure it rather than trusting the console:

```bash
node scripts/check-pack-cors.mjs \
  --url https://<mirror>/scenarios/<pack-id>-<sha>.json.gz \
  --sha256 <64-hex> --bytes <n>
```

No URL configured is a normal "skipped" run (exit 0): the mirror is optional and
never blocks a deploy. Google Drive remains a corpus/DB backup only (rclone
`copy`, snapshots, `rclone check`) and has no role in the runtime pack chain.

### P2 acceptance evidence

- `cargo test --features miner --lib pack::host` (16 tests): full publish copies
  only the manifest + content-addressed body (never `games.jsonl`, notes or
  weights); a dirty source (missing provenance) is refused; an unknown pack id
  is refused with the available ids; over-budget body and manifest ceilings are
  refused without trimming; a dry run writes nothing; publishing twice is
  byte-identical; stale bodies are pruned after the manifest write while foreign
  files refuse before any write; a subset publish replaces the hosted set; a
  tampered body, missing body, unlisted body and a `.safetensors` file all fail
  verification; source-equals-destination and an empty timestamp are refused.
- `node scripts/check-pack-hosting.mjs` passes on the committed smoke pack
  (`replay.fixture.2026-11`, 3 572 body bytes, 614-byte manifest, 41 checks) and
  fails on a missing/tampered body, a manifest/body metadata drift and a raw
  corpus/weights file.
- `node scripts/check-pack-cors.mjs` was measured against a local server: a
  cross-origin response with `access-control-allow-origin: *` passes, the same
  response without the header fails, same-origin needs no CORS header, and the
  `--sha256/--bytes` mode verifies the downloaded body.
- The deploy workflow parses and includes the optional Release copy, the
  pre-build staging check, the post-build artifact check and the optional mirror
  CORS check. `frontend/public/scenarios/` contains only the smoke manifest and
  body. `GITHUB_ACTIONS=true npm run build` copies them to
  `frontend/dist/scenarios/`, where the check passes 41 assertions.
- `npm run lint`, `npm test` (215 tests) and the Rust gates above are clean. No
  raw corpus, database, weights or LFS object is hosted. No wasm behaviour
  changed and no visual output is involved.


## End-to-end acceptance harness (Q1)

Status: implemented. Q1 makes the whole pipeline runnable in CI from committed
fixtures, with no GPU, network, real corpus or Mortal checkpoint. Real corpus
generation stays offline (C1–C8); Q1 does not generate a corpus.

```bash
# One full fixture run (data root is scratch; every artifact is reproducible).
cargo run --release --features miner --bin mine_replays -- \
  --data-dir target/q1-smoke qa fixture \
  --corpus testdata/replays --generated-at 2026-11-17T00:00:00Z --json

# The CI wrapper: two runs, same-pack-hash check, hosting check, loader smoke
# and the failing-gate matrix.
bash scripts/check-pipeline-e2e.sh
```

### What `qa fixture` runs

```text
testdata/replays/*.jsonl
  └─ ingest ─► replays/mortal_mirror/<sha256>.jsonl.gz + valid GameProvenance rows
       └─ label (FixtureEvaluator) ─► model_labels cache
            └─ select ─► review-queue.jsonl + held-out.jsonl + selection-report.json
                 └─ review (auto-accept the fixture) ─► dispositions
                      └─ transform rehearsal (seeded book bases) ─► variants + pack
                           └─ audit ─► publish_hosted ─► verify_hosted_dir
                                └─ snapshot + PRAGMA integrity_check
```

There are deliberately two sources in one run. The committed replay fixtures
contain no table a book classifier recognises, so the replay branch proves
ingest → label → select → review → held-out QA. The variant/pack branch uses
the V2 seeded book rehearsal (`rehearsal_bases`) because a Mortal-only base
cannot be label-verified without a checkpoint. The report names both branches;
it never pretends one produced the other.

`ingest` is still a CLI stub. Q1's ingest step writes the same
content-addressed replay files and `replays` rows that command will own, and the
label/selection stages walk the validated replay through R2 — the same
reconstruction `extract` now persists as `decisions` rows (Q2 implemented that
stage; see “Decision extraction” above). Q1 therefore exercises the parser,
validator, walker, classifier and label path without a stub pretending to have
run.

The `qa fixture` command exits 0 only when every `checks` entry is true: corpus
ingested, labels clean, selection non-empty, held-out present, review complete,
variants shipped, pack published, audit clean, hosting verified, storage
integrity ok, and every replay path content-addressed.

### Fixture evaluator (not a model)

`miner::label::fixture::FixtureEvaluator` is the Q1 stand-in for Mortal. It puts
the first book classifier's answer on top when the table matches one, otherwise
the first legal discard, and scores the rest deterministically. Every label
records `model = q1-fixture-evaluator` with a fixed hash, so it can never be
mistaken for `mortal_298k`. It is not used to grade a shipped drill; Q2 labels
with the real checkpoint. A Mortal-only base's variants are not verified with
this evaluator (its fallback is not equivariant under relabelling), which is why
the pack branch is the seeded book rehearsal.

### Determinism

Every pack/manifest timestamp is the caller's pinned `--generated-at`; the
fixture corpus gzip uses a fixed header; the fixture evaluator is pure; the
rehearsal is seeded (it reseeds before every draw). `transform` therefore gained
`--generated-at` and `VariantRunOptions::generated_at`. Two runs with the same
inputs write the same pack bytes and SHA-256. `scripts/check-pipeline-e2e.sh`
runs `qa fixture` twice into separate data roots and compares the pack hash,
byte count, scenario count and selected/held-out counts. The DB snapshot is not
compared byte-for-byte (SQLite page layout is not the determinism contract); its
`PRAGMA integrity_check` must be `ok`.

### Gate matrix

`tests/q1_gates.rs` is the failing-test matrix: G0 source/provenance, G1 parser,
G2 reachability, G3 corpus family slug, G4 classifier positive/near-miss, G5
label cache + Q values, G6 illegal selection answer, G7 label-preservation
mismatch, G8 pack source licence/illegal answer/spoiler/byte budget/missing
provenance, and G11 snapshot integrity/content-addressed paths/rclone skip.
G9 loader is the frontend suite plus `frontend/src/services/packLoader.q1.test.ts`,
which loads the pipeline's own pack when `Q1_PACK_DIR` is set. G10 is the
two-run pack-hash comparison. G3's full per-family report is offline corpus work
(C1–C8); the fixture checks the provenance family rule every fixture run uses.

### Storage and backup (G11)

The harness snapshots the miner DB through `snapshot_database` (VACUUM INTO plus
`PRAGMA integrity_check`), reports row counts and verifies
`replays/<family>/<replay_id>.jsonl.gz` for every row. The rclone plan is
reported as `skipped` when no `RIICHI_RCLONE_REMOTE` is configured; the harness
never runs rclone. The operator commands remain in §7.1 of the plan.

### CI

`.github/workflows/checks.yml` runs the default library tests, the miner tests,
clippy, the WASM check, the no-`libriichi` check, `scripts/check-pipeline-e2e.sh`
and the frontend test/build/lint jobs. The pipeline job uses committed fixtures
and needs no secrets. It is independent of the Pages deploy workflow.

### Q1 acceptance evidence

- `bash scripts/check-pipeline-e2e.sh` passes: 2 fixture replays, 99 labels, 8
  selected + 2 held-out, 24 shipped variants from 12 seeded bases across
  `rank_mirror`/`seat_perm`/`suit_perm`, a 36-scenario pack, clean audit, 41
  hosting checks, loader smoke and the 10-test gate matrix.
- The two runs report the same pack SHA-256
  (`9cbf1e4a3eccbcc4e5ac2e087be0923f41720a2b0a428361ddf8db3910347c96` in the
  recorded 2026-11-17 run), byte count and scenario count.
- `cargo test --features miner --test q1_gates` passes all ten negative tests;
  `cargo test --features miner` and the §7.1 shared commands stay clean.
- The loader smoke passed with the pack at `Q1_PACK_DIR` and the cache path
  re-used the content-addressed key.
- No visual judgement is involved: the harness only checks bytes, schemas,
  hashes, row counts and `PRAGMA integrity_check`.

## First curated ch. 8 defense pack (Q2)

Status: shipped. The pack is `replay.ch8-defense.2026-11`:

- 100 reviewed base scenarios, **no variants** (disabled by product decision:
  the generated variants looked too similar; variety comes from real
  scenarios), 104,357 body bytes and a 763-byte manifest; bases from 47
  replays, 0 adjacent same-replay bases;
- 100 bases selected from 4,112 valid candidates after a ch. 8 scope, a
  stable-book-only rule and a five-family corpus cap (M3 30, M4 30, M5 30,
  M1 10, M2 10); 10 held-out QA items;
- four ch. 8 lessons across ch8.1/ch8.2/ch8.3, no other chapter;
  `--min-bases-per-lesson 3` dropped the two one-scenario lessons
  (`defense_stuck_heuristic`, `kabe_one_chance`) instead of repeating a single
  position;
- reviewers accepted 100 and rejected 10, then accepted two ch8.2 backfill
  candidates (102 accepted / 8 rejected); the pack ships 100 reviewed bases;
- four agents (Akochan, Mortal 298k, `efficiency-safety-v1`,
  `isolated-first-v1`), complete licences/attribution, `data_commercial_use` is
  false because Akochan contributes;
- clean audit, 41/41 hosting checks, 23/23 ch8-pack checks
  (`--allow-no-variants`), the loader smoke and the frontend suite pass.

Q2 also implemented the missing `extract` stage and the selection lesson scope
(`--section`, `--lesson`, `--corpus-family`, `--corpus-cap`,
`--stable-book-only`). The full command list, label counts, funnel, review and
measurements (including the scale-up decision) are in
[`q2-ch8-defense-pack.md`](q2-ch8-defense-pack.md); the machine-readable
evidence is in [`testdata/reports/q2/`](testdata/reports/q2/). The human content
review is Q2r.

**Scale-up (2026-11-18).** The user reviewed the 100 bases and skipped a separate
Q2r item. The follow-on run extracted and book-labelled 240 additional M1/M2
games (284 games / 146,374 decisions / 21,745 book labels in total), then used
`select --extracted-only --max-per-replay 2` to pick 560 bases (51 held out). It
ships **1,038 reviewed bases, 0 variants**, 1,047,001 bytes, six ch. 8 lessons;
`defense_stuck_heuristic` now has 11 distinct real positions instead of one.
`--unique-hands` removed seven same-hand near-duplicates, and
`--min-bases-per-lesson 4` dropped the two undersupplied topics. The pack is
`replay.ch8-defense.2026-11` and passes the same audit/hosting/serving checks.
Details: [`q2-scale-up-1000.md`](q2-scale-up-1000.md), evidence:
[`testdata/reports/q2-scale-1k/`](testdata/reports/q2-scale-1k/).

**2k scale-up (2026-11-19).** Two more family runs (500 `mortal_mirror` + 500
`mortal_sampling_sweep` games) grew the scoped corpus to 1,542 games / 787,052
decisions / 110,577 book labels (65,744 stable). `select --size 2250
--max-per-replay 2` returned 2,250 reviewed bases from 53,991 valid candidates
in 55 minutes on 14 workers; the new Q2r2 flow applied 2,250 mechanical
dispositions in one `review --verdicts` run and produced a 251-row stratified
sample. `pack assemble --no-variants --unique-hands --min-bases-per-lesson 4`
ships **2,211 bases, 0 variants**, 2,260,809 bytes, seven ch. 8 lessons, 1,257
source replays, 2,211 unique hands and 0 adjacent same-replay bases. Two M2
replays were `partial` and excluded from the data root (998/1,000 new games
valid). Details: [`q2-scale-up-2000.md`](q2-scale-up-2000.md), evidence:
[`testdata/reports/q2-scale-2k/`](testdata/reports/q2-scale-2k/).

**Multi-threat follow-up (Q2m).** Classifier v2 added `defense_multi_threat`
and re-labelled the corpus: 1,153 stable multi-threat labels produced the
dedicated `replay.ch8-defense-multi-threat.2026-11` pack (780 reviewed, 764
shipped after duplicate hands, 591,096 bytes). The run also fixed the stale-label
and selection-version contract above. Details:
[`q2-multi-threat.md`](q2-multi-threat.md).

**Ch. 7 riichi/dama pack (Q3, 2026-11-19).** The same corpus at classifier v3
(B4's seven-pairs recogniser) produced `replay.ch7-riichi-dama.2026-11`:
`select --section ch7` returned 2,901 reviewed bases from 7,295 gate passes
(2,846 shipped after `--unique-hands`), all six ch7 lessons at or above the
40-base floor, 2,176,750 bytes, 1,509 source replays, 2,846 unique hands. The
mechanical review now takes `--chapter ch7` (ready hands are not rejected: a
riichi/dama decision is tenpai), 2,901/2,901 were accepted, and a 304-row
stratified sample covers every lesson including all 60 `dama_improving_hand`
bases. Details: [`q3-ch7-riichi-dama-pack.md`](q3-ch7-riichi-dama-pack.md),
evidence: [`testdata/reports/q3-ch7/`](testdata/reports/q3-ch7/); coverage:
`node scripts/replay-coverage-report.mjs`.

**Replay-first rollout.** The next product phase extends packs to the remaining
book sections and makes replay the default source for covered lessons. Per-lesson
coverage, the four missing classifiers, the source-tier picker and the per-section
pack plan are in [`replay-first-rollout.md`](replay-first-rollout.md).

## F1 acceptance evidence

- `cargo test --features miner` covers schema round-trips, DB create/migrate on a
  fixture, the complete row insert across all eight tables, foreign keys, the
  DB source `CHECK`, relative-path rules, snapshot + `PRAGMA integrity_check`,
  atomic-write failure cleanup, the source and licence allowlists, the funnel
  counter, and CLI parsing for all eight subcommands.
- `cargo check --target wasm32-unknown-unknown` (default features) stays clean.
- `cargo tree --features miner` contains no `libriichi`.

Visual sign-off is not involved in F1.
