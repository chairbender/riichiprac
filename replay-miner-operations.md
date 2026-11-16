# Replay miner operations: data root, provenance and storage (F1)

Status: implemented foundation (F1 of
[`replay-implementation-plan.md`](replay-implementation-plan.md) §5.3). This
document is the operator contract for the native-only miner. It does not re-open
the source decision: [`replay-strategy.md`](replay-strategy.md) §2 fixes AI
self-play as the only replay source.

F1 creates the feature boundary, provenance types, source/licence/rule gates,
the local data root, the SQLite schema, atomic writes, a funnel counter and the
CLI stubs. It implements no replay parser, no Mortal inference and no pack
publisher; those are R1, R2, L1 and P1a onward.

## Build boundary

The miner is native-only. `src/miner/` and `src/bin/mine_replays.rs` are behind
the `miner` Cargo feature; the binary declares `required-features = ["miner"]`.

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

## CLI surface (F1 stubs)

```text
mine_replays [--data-dir DIR] <command>

  corpus [report]   generate mixed-agent self-play corpora / report by family
  ingest            ingest and validate raw self-play logs
  extract           reconstruct decision points from validated logs
  label             label candidates with book classifiers and Mortal
  transform         generate label-preserving scenario variants
  pack              assemble, audit and export scenario packs
  audit             audit provenance, licences and pack integrity
  review            work the human review queue
```

Each stub resolves the data root, reports the command it would run, and exits
with code 2. A script cannot treat a stub as a successful run.

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
(`PRAGMA user_version = 1`).

| Table | Purpose |
| --- | --- |
| `corpus_runs` | one generation run: plan, family, replay count, local/Drive dir, snapshot, rclone status |
| `replays` | one immutable game: source, licence, rule profile, log path/bytes/hash, validation, agent roster, full provenance JSON |
| `decisions` | one decision point: state hash/JSON, legal/played actions, trigger, book match, Mortal label, Q values (units `model_utility`), selection fields |
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

## F1 acceptance evidence

- `cargo test --features miner` covers schema round-trips, DB create/migrate on a
  fixture, the complete row insert across all seven tables, foreign keys, the
  DB source `CHECK`, relative-path rules, snapshot + `PRAGMA integrity_check`,
  atomic-write failure cleanup, the source and licence allowlists, the funnel
  counter, and CLI parsing for all eight subcommands.
- `cargo check --target wasm32-unknown-unknown` (default features) stays clean.
- `cargo tree --features miner` contains no `libriichi`.

Visual sign-off is not involved in F1.
