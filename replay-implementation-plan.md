# Replay miner implementation breakdown and task sequence

Status: planning. Drafted 2026-11-15 from the merged authoritative
[`replay-strategy.md`](replay-strategy.md) (2026-11-14). This document does not
re-open the source or licensing decision; it turns that design into an
architecture decomposition, an ordered implementation sequence, and a proposed
command-center task slice.

Task: 261114-100729 ("Break down replay strategy into implementation task
sequence").

Read `replay-strategy.md` first for the evidence and the legal analysis. This
document is the build order.

**Two requirements are promoted here from supporting material to required
pipeline stages:**

1. **Mixed-agent corpora.** `replay-strategy.md` §3.3 is no longer an optional
   recipe table. The corpus runner accepts pluggable neural, rule and heuristic
   agents; every game records per-seat agent identity, configuration, sampling
   (including temperature-like knobs) and seed; each matchup family has its own
   corpus unit, quota and acceptance gate. See §3.
2. **Scenario permutation.** `replay-strategy.md` §5.9 is no longer a later
   nice-to-have. It is a named pipeline stage with a label-preservation gate,
   a lesson-invariance matrix and its own unit sequence. See §4.

**One correction is folded in.** The plan does not assume the Mortal
4.1a/b/c/3.0 weights are available offline; only the community `mortal_298k`
checkpoint is. The offline policy set is that checkpoint, Akochan, and
heuristic/reference policies. See §3.2.

The planning task that produced this document implemented no miner code and made
no frontend change. The only code-facing deliverables here are the proposed
interfaces and gates.

**At a glance.** The sequence has 27 implementation units plus one human-review
task: 3 foundation and replay units (F1, R1, R2), 8 corpus units (C1–C8, one per
matchup family plus the shared runner and integration gate), 3 classifier units
(B1–B3), 2 labeler units (L1–L2), 3 selector units (S1–S3), 2 permutation units
(V1–V2), 4 pack units (P1a, P1b, P2, P3), and 2 validation/ship units (Q1, Q2)
plus the Q2r review task. The critical path to the first pack runs through the
parser, reconstructor, shared corpus runner, the M1 and M3 families, the
classifier/labeler, selection, the permutation gate, pack assembly, the loader
and the end-to-end harness. B1/B2, L1/L2, V1 and the additional corpus families
can run in parallel around that path.

---

## 0. Scope and non-goals

**In scope for the implementation sequence:**

- a native-only replay library: mjai self-play reader, replay walker,
  `GameState` reconstruction, structural validation, tenhou6 review export;
- a corpus runner that generates mixed-agent self-play games and records
  provenance;
- book classifiers that recognise existing lessons in arbitrary states;
- a native Mortal labeler that exposes per-action Q values and caches results;
- trigger, counterfactual and interestingness selection with family quotas;
- a scenario permutation generator with label-preservation checks;
- pack/manifest schema, publisher, audit and hosting;
- a lazy frontend pack loader;
- end-to-end validation and the first curated pack.

**Out of scope (some permanently, some deferred):**

- any Tenhou, Mahjong Soul, Riichi City, Hime, M-League, Hugging Face or Kaggle
  replay corpus; no BYO replay; no human-expert-line family
  (`replay-strategy.md` §2, §5.10);
- linking Mortal's `libriichi` (AGPL) into the shipped MIT/WASM app;
- implementing the miner inside the WASM build or the frontend bundle;
- point-denominated EV copy before a versioned Q→point calibration exists;
- multi-step replay drills in the first pack (keep `replay_id` + `event_index`
  in every scenario so they can be added later);
- visual sign-off by an agent (AGENTS.md §6: hand the artifact to the user).

---

## 1. Decisions preserved

The strategy document is the authority. These are the decisions every unit is
gated on, with the place that enforces them.

| Decision | Enforcement point | Units |
| --- | --- | --- |
| AI self-play is the only replay source; no third-party corpus is acquired, ingested or shipped | `source.kind` allowlist at corpus ingest **and** pack publish; typed rejection, not a warning | F1, C1, P1a |
| Published packs are `source.kind = "ai_selfplay"` with model/seed/agent provenance | pack schema + publisher audit; missing provenance is a hard failure | F1, P1a, Q1 |
| Mortal code and weights are AGPL-3.0 and never enter the shipped MIT/WASM build | separate `riichiprac-corpus` process/repo; no `libriichi` dependency in this crate; app-side labelling uses the existing MIT `MortalV4Model` | C1, C2, L1 |
| Akochan is a rule-based generator whose outputs are non-commercial with attribution | per-game licence record; pack `data_commercial_use`; publisher refuses a commercial pack containing Akochan data | C5, P1a |
| Use the complete `GameState` and existing validation/rationale/legal-action code | reuse `GameState`, `validate_reachable_state`, `finalize_state`, `rationale_for`, `legal_actions`, `compare_action_set`; no parallel scenario model | R2, B1, L1, V1 |
| Mortal per-action values are Q values / model utility, not points | store `q_values` with `q_units: "model_utility"`; select by probability margin / Q-gap percentiles; calibrate before any point copy | L1, L2, S3 |
| Pack hosting follows the existing Pages / Release / HF pattern | same-origin manifest + content-addressed packs; Release asset only as a CI copy step; optional R2/HF mirror | P2 |
| The miner is native-only and must not break the WASM build | Cargo feature `miner`; `required-features` on the binary; default `cargo check --target wasm32-unknown-unknown` stays clean | F1, every Rust unit |
| Human review is the last mile; an agent does not sign off its own visual work | review queue + AGENTS.md §6 handoff | S2, Q2 |

Do not add a "third-party corpus" or "BYO replay" unit later in the sequence.
Those are rejected alternatives, not deferred phases.

`agari` remains the hand-analysis crate (shanten, yaku, ukeire, scoring). It is
not a four-player simulator, a replay walker, or the legal-action engine; R2 and
the classifiers use `src/state.rs` and `src/ai/actions.rs` for state and
legality.

---

## 2. Architecture decomposition

### 2.1 Repository and build boundaries

The split exists to keep the MIT app and the AGPL generation stack legally and
technically separate.

| Piece | Where it lives | Licence | Build | Ships? |
| --- | --- | --- | --- | --- |
| App + rules + `GameState` + MIT Mortal inference | this repo (`riichiprac`) | MIT | default native/WASM | yes |
| Replay library (`src/replay/`) | this repo | MIT | native, behind `miner` feature | no |
| Miner tooling (`src/miner/`, `src/bin/mine_replays.rs`) | this repo | MIT | `--features miner` | no |
| Book classifiers, labeler, selection, transforms, pack tools | this repo (`src/miner/`) | MIT | `--features miner` | no |
| Corpus runner and match orchestration | new **private** repo `riichiprac-corpus` | AGPL-3.0 (because it links `libriichi`); private until a later publication decision | native | no |
| Mortal `libriichi` adapter + model weights | `riichiprac-corpus` (private) | AGPL-3.0 | native | no |
| Akochan adapter / bridge | `riichiprac-corpus` (private) | AGPL-3.0 repo with Akochan NOTICE; user-supplied binary, private repo if bundled | native | no |
| Pack publisher / audit | this repo | MIT | `--features miner` | tool only |
| Frontend pack loader | this repo (`frontend/`) | MIT | Vite | yes |

Rules for the boundary:

- **No `libriichi` in this repo's `Cargo.toml`, in any feature.** The corpus
  repo may depend on this crate's `miner` feature; the dependency direction is
  one-way and the app never depends on the corpus repo.
- The `miner` feature gates `clap`, gzip, SQLite/DuckDB, `rayon` and other
  native-only dependencies. The default build must remain the current shipped
  target.
- `src/bin/mine_replays.rs` uses `required-features = ["miner"]`, so a plain
  `cargo build` does not try to build it.
- The corpus repo is where `libriichi` and Akochan live. It is never a build
  input of the app, never a Pages asset, and never a git submodule of this repo.
- If the corpus repo only invokes engines as subprocesses, it may choose MIT,
  but the conservative default is **AGPL-3.0**, because that is the licence of
  the code it links. The app stays MIT either way.

### 2.2 Component map

| # | Component | Responsibility | Home | Existing code to reuse |
| --- | --- | --- | --- | --- |
| 0 | Provenance / source / licence gate | define `AgentSpec`, `GameProvenance`, `RuleProfile`, `LicenseInfo`; reject non-self-play sources | this repo, `src/miner/` | serde types in `state.rs`, `report/model.rs` |
| 1 | mjai reader + replay validator | parse gzipped mjai JSONL; validate event order, tile ledger, scores, wall count | this repo, `src/replay/` | none (new) |
| 2 | Replay walker + `GameState` reconstruction | snapshot before decisions; rotate actor to seat 0; fill derived fields; validate reachable | this repo, `src/replay/` | `GameState`, `validate_reachable_state`, `finalize_state`, `ai::actions` |
| 3 | Decision enumeration + trigger prefilter | enumerate self-turn/call/riichi/kan/win decisions; label why a trigger fired | this repo, `src/miner/` | `legal_actions`, `can_riichi`, `safety` |
| 4 | Agent protocol + match runner | pluggable agents, match plans, seat/seed schedules, raw log emission | `riichiprac-corpus` | hotseat `Policy` concept as a reference |
| 5 | Corpus families + adapters | Mortal arena, Akochan, heuristic/reference; per-family reports | `riichiprac-corpus` | corpus protocol, `GameProvenance` |
| 6 | Book classifiers | `matches(state) -> Option<Match>` per lesson; `TransformPolicy` | this repo, `src/miner/` or next to lessons | `analysis`, `safety`, `completion`, `rationale` |
| 7 | Mortal labeler | batch evaluation, Q values, cache, book agreement, optional future multi-model labels | this repo, `src/miner/` | `MortalV4Model`, `evaluate_state_named`, `compare_action_set` |
| 8 | Interestingness + selection | hard gates, family quotas, dedupe, review queue | this repo, `src/miner/` | `scenario-report`, fuzz comparison |
| 9 | Permutation engine | label-preserving seat/suit/rank/wind/red-five variants | this repo, `src/miner/transform/` | `GameState` tile helpers, `finalize_state` |
| 10 | Pack schema + publisher + audit | pack/manifest types, source/licence gate, hash/byte budget, atomic write | this repo, `src/miner/pack/` | `export/tenhou6.rs` for review only |
| 11 | Frontend pack loader | manifest fetch, schema check, IndexedDB cache, picker integration, ARIA parity | this repo, `frontend/src/` | `services/weightLoader.ts`, `scenarios.ts`, `App.tsx` |
| 12 | Review / validation harness | end-to-end pipeline test, review queue, funnel report | this repo + corpus repo | `verify_report`, `fuzz_scenarios`, `scenario-report` |
| 13 | Corpus storage / ops | local data root + SQLite scenario DB + Google Drive backup via rclone; dataset card; no raw data in git | corpus repo + operator | §2.5 |

### 2.3 End-to-end pipeline

This is the strategy's §6.2 pipeline with the two promoted stages made explicit
and with the corpus generation separated from ingestion.

```text
[0] policy + schema + source gate
        │  (source allowlist = ai_selfplay; agent/licence/rule provenance types)
        ▼
[1] corpus generation — mixed agents, per-game provenance
        │  (match plan: M1 Mortal mirror, M2 Mortal sampling sweep,
        │   M3 Akochan tactics, M4 Akochan vs Mortal, M5 heterogeneous
        │   table if cross-engine, M6 rule baseline)
        ▼
[2] ingest + replay validation
        │  (parse mjai, tile ledger, scores, event order, rule profile)
        ▼
[3] enumerate decision points + trigger prefilter
        │  (self-turn discard, call, riichi, kan, win/pass; defensive/offensive/
        │   book/call/score triggers; record why each fired)
        ▼
[4] reconstruct GameState + structural validation
        │  (rotate actor to seat 0; hands/rivers/melds/dora/scores/turn;
        │   decision context, call offer, can_riichi; validate_reachable_state)
        ▼
[5] book classification
        │  (unique lesson match, visible-info answer, exact/equivalence class)
        ▼
[6] Mortal labelling + counterfactual Q pass
        │  (top-1, ranking, probability margin, raw Q values, q_gap_top2,
        │   q_gap_safe, riichi second pass, call mapping)
        ▼
[7] interestingness + selection (base scenarios)
        │  (hard gates, family quotas, dedupe, held-out QA, review queue)
        ▼
[8] scenario permutation + label-preservation gate  ← REQUIRED STAGE
        │  (seat/opponent, suit, rank, wind, red-five transforms; re-run
        │   classifier/label; reject any variant whose lesson breaks)
        ▼
[9] pack assembly + manifest + audit
        │  (schema, hash, byte budget, source/licence gate, atomic write)
        ▼
[10] publish + loader smoke test
        │  (Pages / R2 / HF; manifest; IndexedDB cache; vitest)
```

Why permutation is stage [8], after selection and before packing:

- generating every variant for every candidate would multiply the expensive
  labeler pass by the transform count;
- packing before permutation would let an unverified variant ship;
- selecting before permutation keeps curriculum quotas based on base scenarios,
  while variants serve anti-memorisation and volume.

### 2.4 Shared contracts

The units share a small set of serialisable types. Names are proposals; keep
them stable once a pack uses them.

| Contract | JSON schema name | Purpose |
| --- | --- | --- |
| `AgentSpec` | part of `riichiprac.corpus-match-plan` | identity/config/sampling/temperature/seed/licence of one seat |
| `MatchPlan` | `riichiprac.corpus-match-plan` v1 | family, games, seat schedule, seed schedule, rule profile |
| `GameProvenance` | `riichiprac.corpus-game` v1 | one generated game's full roster, seeds, config hashes, log hash, validation |
| `TransformChain` | `riichiprac.scenario-transforms` v1 | ordered transforms and parameters applied to a scenario |
| `ScenarioPack` | `riichiprac.scenario-pack` v1 | the existing strategy §6.7 shape, plus agent/variant provenance |
| `PackManifest` | `riichiprac.scenario-pack-manifest` v1 | the existing strategy §6.7 shape |

Sketch of the corpus-side types:

```rust
pub enum AgentKind { Neural, Rule, Heuristic, External }

pub struct AgentSpec {
    pub agent_id: String,          // "mortal-298k", "akochan-<ver>", "heuristic-v1"
    pub kind: AgentKind,
    pub engine: String,            // "libriichi", "akochan", "corpus-reference"
    pub engine_version: String,
    pub engine_sha256: Option<String>,
    pub weights_sha256: Option<String>,
    pub config: serde_json::Value,
    pub config_hash: String,
    pub temperature: Option<f32>,  // None when the engine is deterministic
    pub sampling: String,          // "argmax" | "softmax" | "engine_default"
    pub seed: Option<String>,
    pub reproducible: bool,        // false when the engine/config cannot replay the seed
    pub licence: LicenseInfo,
}

pub struct GameProvenance {
    pub replay_id: String,         // sha256 of canonical raw log
    pub corpus_id: String,
    pub family: String,            // "mortal_mirror", "akochan_tactics", ...
    pub match_plan_id: String,
    pub match_plan_sha256: String,
    pub rule_profile: String,
    pub rule_config_hash: String,
    pub generated_at: String,
    pub generator: String,         // corpus repo + commit
    pub seats: [AgentSpec; 4],
    pub game_seed: String,
    pub seat_schedule: String,
    pub log: LogRef,               // format, path, bytes, sha256
    pub validation: ValidationSummary,
}
```

`LicenseInfo` must carry, at minimum: licence id, attribution string,
`data_commercial_use: bool`, and a source URL. Unknown or missing licence data
fails the publisher.

### 2.5 Storage and backup (local working copy + Google Drive)

The miner never reads or writes its working data directly on a Google Drive
mount. The initial pipeline writes only to a local data root; **Google Drive
backup via rclone is a separate operator task and is not a code dependency**.
When it is configured, rclone copies the local root to Drive.

**Local data root.** One configurable directory, default
`~/riichiprac-data` (`RIICHI_DATA_DIR`):

```text
$RIICHI_DATA_DIR/
├── replays/
│   └── <family>/<replay_id>.jsonl.gz       # immutable raw self-play logs
├── db/
│   ├── miner.sqlite                        # operational scenario/candidate DB
│   └── analytics.duckdb                    # optional derived analytics
├── snapshots/
│   └── miner-YYYYMMDD-HHMMSS.sqlite        # point-in-time DB snapshots
├── packs/
│   └── <pack-id>-<sha256-prefix>.json.gz   # generated static pack exports
├── tmp/                                    # atomic-write staging
└── logs/                                   # rclone/run logs
```

The data root is outside the repos; if an operator places it inside one, it must
be gitignored. Raw logs, DBs, snapshots and generated packs are never committed
to either repo. Only the runner code, schemas, match plans and small fixtures
live in `riichiprac-corpus` / `riichiprac`.

**Replay store.**

- One gzipped mjai JSONL file per game, content-addressed by `replay_id`
  (sha256 of the canonical raw log), under `replays/<family>/<replay_id>.jsonl.gz`.
- The `replays` row stores the path **relative to the data root**, the byte
  count and the sha256; never an absolute path or a username.
- Logs are immutable. A regenerated game with a different hash is a new file,
  not an overwrite; a seed mismatch is a reproducibility bug to investigate.
- Optional Google Drive backup (separate operator task): `gdrive:riichiprac/replays/`.
  When configured, `rclone copy --checksum --immutable \
  "$RIICHI_DATA_DIR/replays" gdrive:riichiprac/replays`; `copy` never deletes,
  and `--immutable` prevents accidental overwrite of a raw log. The miner must
  still run with no rclone remote configured.
- Keep a `SHA256SUMS` / index manifest in the Drive folder for restore checks.

**Scenario DB.**

- `miner.sqlite` is the operational DB and the source of truth for candidate and
  curated scenarios. It is a single file, transactional, and easy to snapshot.
- Tables: `replays`, `corpus_runs`, `decisions`, `selected_scenarios`,
  `variants`, `packs`, `backups`. `decisions.state_json` holds the complete
  reconstructed `GameState`; `selected_scenarios` holds the curated rows that
  will be exported; `packs` / `variants` hold pack and transform metadata.
- `analytics.duckdb` / Parquet is optional and derived from `miner.sqlite`; it
  is reproducible, so it is not the primary backup target.
- Optional Google Drive backup uses **snapshots**, not a copy of the live DB:
  `sqlite3 "$RIICHI_DATA_DIR/db/miner.sqlite" "VACUUM INTO \
  '$RIICHI_DATA_DIR/snapshots/miner-YYYYMMDD-HHMMSS.sqlite'"`, then, when the
  operator has configured rclone,
  `rclone copy "$RIICHI_DATA_DIR/snapshots/" gdrive:riichiprac/db/`.
  Keep the last N snapshots (for example 7 daily + 4 weekly); do not
  `rclone sync` the snapshot directory with delete semantics. The local snapshot
  and `PRAGMA integrity_check` are required even without Drive.
- Verify after upload with `rclone check`; periodically restore a snapshot,
  run `PRAGMA integrity_check`, and compare replay hashes.
- Never `rclone mount` Google Drive and point SQLite at it. WAL/locking on a
  network mount is not a supported backup strategy.

**Curated scenarios and packs.**

- The DB is the source of truth; a pack is a deterministic **export** of
  `selected_scenarios` + `variants` + provenance.
- The app still loads static gzipped JSON packs, never SQLite or Google Drive.
  Pack files are written under `$RIICHI_DATA_DIR/packs/`, audited, then
  published to `frontend/public/scenarios/` or R2/HF with a same-origin
  manifest.
- The DB backup therefore preserves the exact curated rows needed to regenerate
  a pack, while the pack remains the small runtime artifact.
- Pack exports may also be copied to `gdrive:riichiprac/packs/` for convenience,
  but they are reproducible from the DB and are not the backup source of truth.

**Cadence and recovery.**

- After each corpus run, labelling pass, selection pass or pack build: snapshot
  the DB locally. If a Drive remote is configured, also copy the replay folder
  and the new snapshot.
- Recovery: restore `replays/` from the local copy or Drive, restore the latest
  `miner-*.sqlite` snapshot, run `PRAGMA integrity_check`, then verify a sample
  of `replay_id` hashes. The DB can also be rebuilt from the raw corpus plus
  `(model_sha256, classifier_version, transform_version)`.
- The Drive backup contains self-play data only: the source allowlist still
  applies, and no third-party or human logs are stored there. rclone credentials
  and the remote name live in the operator's rclone config, never in a repo.
  Until the separate rclone task is done, local-only operation is expected.

**Backup fields.** Add to `replays`, `packs` or a `backups` table:
`storage_backend` (`local` / `gdrive`), `storage_path`, `backed_up_at`,
`backup_sha256`, `last_verified_at`. `corpus_runs` records the run's local
directory, Drive destination, replay count, snapshot name and rclone status.

---

## 3. Corpus variety is a first-class pipeline requirement

### 3.1 Requirement

The corpus is **not** four clones of one strong policy. A useful corpus is a
mix of strong lines, realistic mistakes, contested positions and genuinely
different policies. That mix is the main source of the states worth mining, and
it is a property of the corpus generator, not a post-hoc filter.

Therefore:

- the corpus runner accepts **pluggable agents/policies**, including non-neural
  rule or heuristic engines such as Akochan;
- every game records **per-seat agent identity and configuration**, generation
  sampling (including temperature-like knobs) and seeds, engine/weights hashes,
  rule profile and licence;
- the matchup families in `replay-strategy.md` §3.3 are the **minimum family
  set**, each with its own corpus unit, quota and acceptance gate;
- a family that is disabled or misses its quota is visible in the corpus report;
  it cannot silently disappear from a pack;
- licensing constraints from `replay-strategy.md` §3.4 remain intact: Mortal is
  AGPL and stays out of the shipped app; Akochan outputs are non-commercial with
  attribution; pack data carries its own licence.

### 3.2 Agent model

**Availability check (2026-11-15).** The upstream Mortal project does **not**
publish trained weights. Its documentation's "Okay cool now give me the weights!"
section points at the author's post, whose latest update (2022-08-19) says there
is currently no plan to release the trained model. The 4.1a/b/c, 4.0 and 3.0
names are networks used by the **online review service** at
<https://mjai.ekyu.moe>; they are not downloadable checkpoints. The only Mortal
checkpoint we have is the community `VoidShine/mortal-298k`
(`mortal_298k.safetensors`), which this app already uses.

| Engine | Available offline? | Evidence | Intended role |
| --- | --- | --- | --- |
| **Mortal `mortal_298k`** | **yes** | `VoidShine/mortal-298k` HF checkpoint; converted weights already in the app | primary Mortal generator and labeler |
| Mortal 4.1a / 4.1b / 4.1c | **no** | online-service networks; upstream weights unreleased | not a corpus source; do not name them in a match plan |
| Mortal 4.0 / 3.0 | **no** | same | not a corpus source |
| **Akochan** | **yes** (user-supplied binary) | C++ engine under its own terms | second, non-neural policy; self-match and, if feasible, cross-engine |
| **Heuristic / reference** | **yes** | our corpus-repo code | weak/baseline policy, deterministic fixtures |
| Kanachan / NAGA / Suphx | **no** usable weights | no shipped models / proprietary / paper only | not usable |

Consequences for the corpus recipe:

- **One Mortal checkpoint, one Akochan, and heuristic baselines are the offline
  policy set.** M1 and M2 below use the same Mortal checkpoint with different
  sampling settings; they are **not** different AIs and must not be described as
  a network mix.
- **Policy variety starts at M3 (Akochan) and M6 (heuristic).** A pack that only
  contains M1/M2 games is a clone corpus and does not satisfy the variety
  requirement.
- **Multi-model ensembles are parked.** L2 can accept more than one labeler if a
  checkpoint is ever obtained, but no family, quota or gate depends on it. With
  one Mortal model there is no neural ensemble to run.
- **Do not scrape or automate the online service.** It is a review UI, not a
  batch self-play API, and its terms are not a corpus grant.
- **If more neural policies are wanted later**, the options are explicit: obtain
  permission/weights, train our own checkpoint (a separate, large RL/data
  project), or add another open engine through the same agent protocol. None of
  those is assumed by this sequence.
- **Weights provenance is separate from replay provenance.** The `mortal_298k`
  model card says it was trained on Tenhou hanchan data. That is a fact about the
  weights we already ship, not a licence to ingest Tenhou replays; review it
  separately before any commercial use.

**Reference heuristic baselines (M6).** These are small, deterministic policies
we own, not learned agents. They exist to keep the pipeline testable without
weights and to generate weak-policy deviations from the Mortal label. They are
not a substitute for Akochan or for the Mortal labeler.

| ID | Policy | What it is for | What it is not |
| --- | --- | --- | --- |
| H0 `tsumogiri-v1` | On a self turn, discard the tile just drawn; take a win if offered; otherwise pass calls/kans and never declare Riichi | parser/walker smoke tests, a legal lowest-skill baseline, deterministic fixtures | a realistic player; never ship its scenarios unlabelled |
| H1 `random-legal-v1` | Uniform random choice over the legal actions, driven by the recorded seed | fuzzing the walker/selector with unusual calls, kans and riichi lines; checking that illegal states are rejected | a quality corpus; most decisions are noise |
| H2 `isolated-first-v1` | Discard isolated honours first, then isolated terminals, then isolated simples; keep pairs and connected shapes; no calls, no defence | a cheap weak opponent that makes obvious shape mistakes; beginner/contrast material | a plausible intermediate player; its mistakes are often too easy |
| H3 `efficiency-safety-v1` | Use `agari` to compare each legal discard's resulting shanten/ukeire; pick the smallest acceptance loss (seed tie-break); if an opponent has declared Riichi, prefer genbutsu/suji/kabe from `src/safety.rs` when available; declare Riichi when tenpai and legal | a plausible non-neural policy, useful for defence states and a stronger ablation baseline; still Mortal-labelled when shipped | a labeler or ground truth; it has no hand-reading or score model |

Why keep them:

- **Weights-free instrumentation.** H0/H1 let the parser, walker, selector,
  transforms and pack gates run in CI on any machine, with no GPU, no AGPL
  weights and no corpus download.
- **Mistake generation without human data.** H2/H3 often play a different move
  from the Mortal top action; the position before that move is a "what should
  you have done?" drill. The Mortal label supplies the answer, not the
  heuristic.
- **A genuine non-neural diversity axis.** Even after Akochan lands, the
  heuristics provide a cheap third policy and a way to test whether the
  mixed-agent corpus is actually adding variety or just relabelling the same
  Mortal lines.
- **An ablation baseline.** If an M6-only pack looks as good as an
  Akochan/Mortal pack, the selection is not doing its job; if M6 produces only
  trivial blunders, the interestingness gates are working.
- **A fallback while the Akochan bridge is unresolved.** M6 keeps the pipeline
  end-to-end testable, but it is not enough for the first curated pack; that
  needs M3 (Akochan), per §9.

`H0`/`H1` are fixtures and fuzzers: do not ship their scenarios as drills.
`H2`/`H3` may be shipped only when a Mortal/book label is attached and the
scenario is explicitly marked as weak-opponent material.

The runner is agent-agnostic. It does not assume every seat is a Mortal
checkpoint, and it does not assume a "best" network is the only generator.

`AgentSpec` (above) captures:

- **identity**: stable `agent_id`, plus engine name/version and hashes;
- **kind**: `neural`, `rule`, `heuristic`, or `external`;
- **config**: the full engine configuration object plus a canonical
  `config_hash`; a name alone is not provenance;
- **sampling**: `boltzmann_epsilon` / `boltzmann_temp` / `top_p` for Mortal;
  `temperature` / `top_p` for engines that expose it; or `engine_default`;
  `None` when deterministic. Record the full sampling object in `config` and the
  canonical temperature-like knob in `temperature`.
- **seed**: per-seat seed where the engine accepts one; `None` with an explicit
  `reproducible: false` marker when it does not;
- **licence**: licence id, attribution, data-commercial-use flag.

Match plans also record:

- **rule profile**: the canonical `tenhou-4p-hanchan` profile plus the exact
  red-five/kuitan/starting-score/return/uma/kan-dora settings the engine used.
  All four seats in a game must agree; a mismatch is rejected, not normalised;
- **seat schedule**: rotate the lineup through all four seats across games so no
  agent gains a fixed seat/dealer advantage; record the resolved seats per game;
- **seed schedule**: a corpus-level schedule plus the resolved per-game and
  per-seat seeds, so a game can be reproduced from `(corpus_id, family,
  game_index, lineup)`.

**Generation sampling vs label sampling.** Mortal's engine exposes
`boltzmann_epsilon` (a mixture of greedy and sampled actions),
`boltzmann_temp`, and `top_p`; record all three in `config` and the canonical
temperature-like knob in `temperature`. Self-play may sample for diversity;
labels are always argmax (`boltzmann_epsilon = 0`). The labeler's model identity
is recorded separately. Never record one sampling setting for both.

A match plan is a small, reviewable document:

```jsonc
{
  "schema": "riichiprac.corpus-match-plan",
  "version": 1,
  "corpus_id": "mixed-2026-11",
  "family": "mortal_mirror",
  "rule_profile": "tenhou-4p-hanchan",
  "games": 1000,
  "seat_schedule": "rotate_each_game",
  "seed_schedule": { "kind": "sequence", "start": 1000, "step": 1 },
  "seats": [ /* four AgentSpec objects; see §3.4 */ ],
  "log_dir": "replays/mortal_mirror"
}
```

The runner writes the resolved per-game roster and seeds into
`GameProvenance`, so the plan plus the plan hash are enough to audit a game.

**Non-neural engines are generators and opponents first.** Akochan can be a
generator, a second opinion and a source of different play. It is not the pack
labeler unless its values are mapped and calibrated; the default labeler is the
one `mortal_298k` checkpoint via the app's MIT inference.

### 3.3 Matchup families and acceptance gates

These are the families the first corpus must support. Each is a separate
implementation unit in §5 (C2–C7), so a failure in one does not block the
others.

| ID | Family | Seats (available offline) | What it feeds | Family-specific acceptance gate |
| --- | --- | --- | --- | --- |
| **M1** | Mortal mirror | `mortal_298k` vs itself, sampled self-play (`boltzmann_epsilon` > 0), rotated seats | high-quality lines, book-aligned states, label baseline | configured games generated; 100 % logs parse; 0 invalid reconstructed states on the smoke sample; every game has complete per-seat provenance; rule profile matches; family report emitted |
| **M2** | Mortal sampling sweep | same `mortal_298k`, several `boltzmann_epsilon` / `boltzmann_temp` / `top_p` profiles, seat/dealer rotations | wider state coverage, mild style variation | M1 gates, plus a measured action-distribution divergence from M1; provenance records `policy_variety: "sampling"` and the same model hash; never describe this as a different agent or network |
| **M3** | Akochan tactic sweep | Akochan vs Akochan, different tactic/config profiles when supported; otherwise one profile | genuinely different rule-based policy, style contrast, mistakes | parseable logs; per-seat identity/config; rule profile verified; Akochan licence/attribution/commercial flags; measured divergence from M1; `cross_engine: false`; family report |
| **M4** | Akochan vs Mortal | Akochan vs `mortal_298k` if the cross-engine bridge is feasible; otherwise a **corpus-level** M3+M1 mix, not a same-table claim | cross-policy contested states | spike decision + adapter; `cross_engine` flag is truthful; per-seat identity; rule profile; Akochan flags; 0 invalid states; configured diversity yield |
| **M5** | Heterogeneous table | one Mortal + Akochan + heuristic seats, only if the cross-engine bridge is feasible; otherwise deferred | multi-policy table texture | M4 gates plus three distinct agents in the seat roster; no silent fallback; if not feasible, the family is marked deferred and no heterogeneous games are claimed |
| **M6** | Rule / heuristic baseline | H0 `tsumogiri`, H1 `random-legal`, H2 `isolated-first`, H3 `efficiency-safety`; self-play or vs another supported seat | cheap pipeline fixtures, deterministic tests, weak-policy mistakes, beginner material | deterministic by seed; no weights; logs parse; provenance complete; H0/H1 are fixtures/fuzzers only; H2/H3 are Mortal/book-labelled and marked weak-opponent when shipped; no claim that the heuristic is ground truth |

Family rules:

- **M1 is the baseline, not the corpus.** It satisfies quality and label
  stability; it is not allowed to fill a pack on its own. M1 and M2 use the same
  Mortal checkpoint with different sampling settings, so neither counts as
  policy variety.
- **Policy variety starts at M3.** Akochan is the first genuinely different
  engine; M6 is the weak/baseline policy. A shipped pack must include at least
  one M3–M6 family, not just M1/M2.
- **M3 does not claim cross-play.** Akochan self-match is useful and honest; the
  game record says `cross_engine: false`.
- **M4 has two truthful modes.** Same-table cross-play and a corpus-level mix are
  both useful; the game record and family report say which one ran. Never label a
  corpus-level mix "Akochan vs Mortal at the same table".
- **M5 is conditional.** If the bridge is not feasible, defer it; do not fake a
  heterogeneous table by relabelling a corpus-level mix.
- **M6 is not a quality corpus by itself.** It is excellent for deterministic
  plumbing and can produce beginner-visible mistakes, but a label must come from
  the Mortal checkpoint or a book classifier. H0/H1 never ship; H2/H3 ship only
  as clearly marked weak-opponent, Mortal/book-labelled material.
- **No ensemble family.** With one Mortal checkpoint there is no neural ensemble
  to run. Multi-model labelling is an optional future capability in L2, not a
  corpus family or gate.

### 3.4 Per-game provenance (required, not optional)

Every generated game carries a record like this. The raw log path is a logical
corpus path, never an absolute local path or a username.

```jsonc
{
  "schema": "riichiprac.corpus-game",
  "version": 1,
  "replay_id": "sha256:...",
  "corpus_id": "mortal298k-heuristic-2026-11",
  "family": "rule_baseline",
  "match_plan_id": "m6-rule-baseline-2026-11",
  "match_plan_sha256": "sha256:...",
  "rule": {
    "profile": "tenhou-4p-hanchan",
    "config_hash": "sha256:...",
    "red_fives": 3,
    "kuitan": true
  },
  "generated_at": "2026-11-15T12:00:00Z",
  "generator": {
    "repo": "riichiprac-corpus",
    "version": "0.1.0",
    "commit": "abc1234"
  },
  "game_seed": "0x9f2c1a7b",
  "seat_schedule": "rotate_each_game",
  "seats": [
    {
      "seat": 0,
      "agent_id": "mortal-298k",
      "kind": "neural",
      "engine": "libriichi",
      "engine_version": "0.4.x",
      "engine_sha256": "sha256:...",
      "weights_sha256": "sha256:...",
      "config": { "boltzmann_epsilon": 0.05, "boltzmann_temp": 1.0, "top_p": 1.0 },
      "config_hash": "sha256:...",
      "temperature": 1.0,
      "sampling": "boltzmann_epsilon",
      "seed": "0x01",
      "reproducible": true,
      "licence": {
        "id": "AGPL-3.0",
        "attribution": "Mortal 298k checkpoint ...",
        "data_commercial_use": true
      }
    },
    {
      "seat": 1,
      "agent_id": "heuristic-v1",
      "kind": "heuristic",
      "engine": "corpus-reference",
      "engine_version": "0.1.0",
      "config": { "style": "isolated-honor-first" },
      "config_hash": "sha256:...",
      "temperature": null,
      "sampling": "deterministic",
      "seed": "0x02",
      "reproducible": true,
      "licence": {
        "id": "MIT",
        "attribution": "riichiprac corpus reference policy",
        "data_commercial_use": true
      }
    }
    // seats 2 and 3 omitted for brevity; a real record always has all four
  ],
  "log": {
    "format": "mjai",
    "path": "replays/rule_baseline/<replay_id>.jsonl.gz",
    "bytes": 41234,
    "sha256": "sha256:..."
  },
  "validation": {
    "status": "ok",
    "events": 812,
    "tile_ledger": true,
    "score_ledger": true,
    "rule_profile_match": true
  }
}
```

The pack publisher requires the matching `GameProvenance` row for every
`replay_id` it ships. A scenario whose game record is missing, incomplete, or
has an unknown licence is rejected.

### 3.5 Licensing and rule-profile gates

- **Mortal.** AGPL-3.0 code and weights live in the corpus repo/process. The
  generated log is data; it is published with attribution to Mortal and the
  model version, and the weights are never in the dataset. The app's MIT
  inference may label a reconstructed `GameState`. `data_commercial_use: true`
  in the example records the strategy's data position; if the product owner
  prefers the stricter reading, set it to `false` for every corpus generated
  with AGPL weights and treat the pack as non-commercial. The publisher enforces
  the flag; it does not adjudicate the law.
- **Akochan.** Its terms allow non-commercial reproduction of outputs with
  attribution. Every Akochan game carries `data_commercial_use: false` and an
  attribution string. A pack containing any Akochan game is marked
  `data_commercial_use: false`; the publisher refuses to publish it under a
  commercial profile. If the app ever becomes commercial, replace the Akochan
  data or obtain permission. The corpus repo is private for now; even so, prefer
  a user-supplied Akochan binary and do not redistribute its code or binaries.
  Only the generated logs (with attribution) enter the corpus and pack.
- **Heuristic / corpus-repo.** Our code and generated data; use the repo's
  licence for code and CC BY 4.0 for data, with attribution to the project.
- **Unknown / external.** Unknown licence means reject at ingest and at publish.
  "Public on the internet" is not a licence.
- **Rule profile.** The app's `GameState` represents the Tenhou 4p-hanchan
  profile. An engine whose rules cannot be represented (different red-five
  count, no kuitan, sanma, local yaku, different starting score) is rejected for
  that corpus. Do not silently normalise a different game into the app's state.
- **Raw logs.** Never commit raw corpus logs, weights or third-party data. Keep
  curated packs small and source-addressed. The raw corpus lives in the local
  data root and is backed up to Google Drive via rclone; only curated packs go to
  Pages/R2/HF. Keep a dataset card with the corpus.

A pack's `source` block is the union of every contributing game's agents, not a
per-scenario guess:

```jsonc
"source": {
  "kind": "ai_selfplay",
  "corpus_id": "mixed-2026-11",
  "licence": "CC-BY-4.0",
  "attribution": "Games generated with Mortal 298k (AGPL-3.0) and Akochan (non-commercial, attribution). Scenario pack CC BY 4.0.",
  "redistributable": true,
  "data_commercial_use": false,
  "agents": [
    { "agent_id": "mortal-298k", "kind": "neural", "licence": "AGPL-3.0",
      "attribution": "Mortal 298k checkpoint ...", "data_commercial_use": true },
    { "agent_id": "akochan-<ver>", "kind": "rule", "licence": "akochan-custom",
      "attribution": "Akochan ...", "data_commercial_use": false }
  ]
}
```

`data_commercial_use` is the logical AND of the contributing agents. A pack with
any `false` agent is non-commercial even if other agents permit commercial use.

### 3.6 Corpus reports and quotas

`mine_replays corpus report` prints one row per family:

- games requested / generated / parsed / valid;
- decision points and trigger hits;
- book matches, Mortal labels, contested, blunders, close calls, selected;
- rejection reasons, deduped counts;
- agent roster and seat distribution;
- sampling/temperature and seed ranges;
- licence flags and rule profile;
- quota shortfalls.

Selection quotas are configured per family, book section, decision kind and
turn bucket. A family that under-delivers is reported as a shortfall; the
pipeline does not silently substitute M1 games.

---

## 4. Scenario permutation is a required generator stage

### 4.1 Position and purpose

Permutation is stage [8] in §2.3: after base selection, before pack assembly.
Its purpose is anti-memorisation and volume:

- a player must not memorise the exact states in the database;
- one mined scenario should yield several drill variants that teach the same
  lesson;
- a variant is only shippable if the transformed state still has the same
  lesson and the same answer after the inverse mapping.

This is not "generate more random hands". It is a controlled transformation of a
validated scenario, followed by a full label re-check.

### 4.2 Normalisation is not a variant

The replay walker already rotates the acting seat to `players[0]`. That is
**normalisation**, and it is not a variant. Rotating all four players and then
normalising the actor back to seat 0 is a no-op.

A real seat variant permutes the **three opponents relative to the actor**:
their hands, melds, rivers, winds, scores and any `from` references move
together, while the actor stays at seat 0. This changes who is across, who is
dealer, and who is on the left, without changing the actor's decision.

### 4.3 Transform catalogue

| Transform | Operation | Fields touched | Label risk | Default |
| --- | --- | --- | --- | --- |
| `seat_perm` | permute opponents 1–3; actor stays 0 | `players[1..4]`, `current_turn`, `DecisionContext.from`, `call_offer` tiles (not seats), dealer derivation, rivers/melds/scores | seat/dealer/placement lessons; `wind_discard_order` | requires policy opt-in |
| `suit_perm` | one of 6 bijections on m/p/s | hands, draws, melds, rivers, dora/ura indicators, `call_offer` tiles, `correct_action` tiles, `equivalent_tiles`, `hand_string`, `tiles`, `ukeire_tiles`; remap action names such as `Discard_3m`/`Chi_*` and re-label | sanshoku, honitsu, ittsu, suit-specific value | recompute; usually allowed |
| `rank_mirror` | rank `r → 10-r` within a suit | same tile-bearing fields as `suit_perm`; remap action names and re-label | ittsu/outside-hand/terminal patterns, pinfu head, waits | recompute |
| `wind_relabel` | rotate player winds, wind honour tiles (`1z`–`4z`) and round wind by `k` | player winds, wind tiles everywhere, `round_wind`, dealer derivation | `wind_discard_order`, seat/dealer/placement context | requires policy opt-in |
| `red5_normalize` | replace a red five's aka identity with a normal five | hands/draws/melds/rivers; recompute dora and scoring | red-five-dependent scoring, dora value, hand value | only if no red-five dependence; recompute |

Explicitly **not** transformed:

- river order, turn number, wall composition, dora count;
- scores (except as they move with a permuted player), honba, riichi sticks;
- hand contents (other than the transform itself);
- hidden information in a way that is inconsistent with the game record.

A transform chain is ordered and recorded. The engine must implement the
inverse mapping for labels and for the `correct_action` tile.

### 4.4 Label-preservation gate

For every candidate variant:

1. Clone the base state and apply the transform chain.
2. Recompute derived fields (`hand_string`, `tiles`, shanten, ukeire,
   `can_riichi`, `book_rationale`) through `finalize_state`.
3. Run `validate_reachable_state` and the tile ledger. Reject on failure.
4. Determine the label kind:
   - **book**: run the lesson's `matches()` on the transformed state. Require the
     same lesson id, a unique answer, and that the transformed `correct_action`
     is the inverse-mapped original answer (or in its equivalence class).
   - **Mortal-only**: run the labeler on the transformed state. Require the
     top-1 action to inverse-map to the original top-1. For a close call, reject
     if the top-1 flips or the calibrated margin band changes materially.
   - **multi-model (optional, future)**: if more than one labeler ever exists,
     require every member's top-1 to inverse-map, or preserve the original
     `contested` marking. With one Mortal checkpoint this kind is not used.
   - **mistake / played action**: inverse-map the played action too; the
     "find the mistake" lesson must still show the same mistake relative to the
     same answer.
5. Check legal actions: the answer is legal; a riichi answer has a legal
   discard; a call answer has an offer.
6. Check spoilers: prompt/title/provenance do not name the answer or wait.
7. Check dedupe: exact state hash is new to the pack; the per-base cap is not
   exceeded.
8. Record the transform chain, inverse mapping, label-check result and any
   rejection reason.

If any check fails, **reject the variant**. Never hand-edit the label to make a
variant fit.

Model labels are cached by `(transformed_state_hash, model_sha256,
classifier_version, transform_chain)`, so a rerun does not pay for the same
evaluation twice.

### 4.5 Lesson invariance matrix

The transform engine must not guess. Each classifier declares a
`TransformPolicy`:

```rust
pub struct TransformPolicy {
    pub seat_perm: Allowed,
    pub suit_perm: Allowed,
    pub rank_mirror: Allowed,
    pub wind_relabel: Allowed,
    pub red5_normalize: Allowed,
    pub note: &'static str,
}

pub enum Allowed {
    Deny,
    AllowWithRecompute,
}
```

The default is `Deny` for every transform until a lesson opts in. This is
deliberately conservative: a missing opt-in loses volume, while a wrong opt-in
ships a broken drill.

Starting matrix (to be confirmed by tests, not assumed):

| Lesson family | Seat | Suit | Rank | Wind | Red five |
| --- | --- | --- | --- | --- | --- |
| `riichi_judgement`, dama lessons | allow* | allow | allow | allow* | deny if scoring depends on red five |
| `push_or_fold`, `fold_to_riichi`, defense safety | allow* | allow | allow | allow* | allow with recompute |
| `suji_trap_riichi` | allow* | allow | allow with recompute | allow* | allow with recompute |
| `pinfu_head` | allow* | allow | allow with recompute | allow* | deny |
| `honitsu_decision` | allow* | allow | allow | allow* | allow with recompute |
| `meld_or_not`, kan lessons | allow* | allow | allow | allow* | allow with recompute |
| `wind_discard_order` | deny | allow | allow | deny | allow |
| placement / score-context lessons | deny unless score labels are preserved | allow | allow | deny unless preserved | allow with recompute |
| replay score/placement family | deny unless preserved | allow | allow | deny unless preserved | allow with recompute |
| any red-five-dependent family | allow* | allow | allow | allow* | deny |

`allow*` means "allow only when the re-run gate confirms the same lesson and a
legal answer"; the table is a starting policy, not a licence to skip the gate.

Special cases to test explicitly:

- **Sanshoku**: suit permutation usually preserves the same-rank-in-three-suits
  relation, but the classifier must still return the same lesson.
- **Honitsu**: suit permutation preserves the one-suit property; value/scoring
  can change, so re-run.
- **Ittsu / outside hand**: rank mirror can change the terminal relation; re-run.
- **Red-five scoring**: normalising a red five can change han/dora; reject if the
  label changes.
- **Wind discard order**: seat and wind transforms generally break the seating
  arithmetic; deny them.
- **Placement**: seat permutation can change dealer/placement; deny unless the
  transformed state still carries the same placement lesson.

### 4.6 Variant identity, dedupe and caps

Each variant records:

```jsonc
{
  "id": "replay-9f2c1a7b-v3",
  "variant_of": "replay-9f2c1a7b",
  "transform_chain": [
    { "kind": "suit_perm", "params": { "map": { "m": "p", "p": "s", "s": "m" } } },
    { "kind": "rank_mirror", "params": {} }
  ],
  "transform_seed": "0x51",
  "label_check": {
    "kind": "book",
    "preserved": true,
    "classifier_version": "1",
    "model_sha256": null
  },
  "provenance": {
    "replay_id": "sha256:...",
    "decision_index": 42,
    "original_seat": 2
  }
}
```

Rules:

- exact duplicate state hashes collapse;
- variants are grouped by `variant_of` / base fingerprint for analytics and
  review;
- per-base cap is configurable (default 8) and per-pack share is capped (default
  20 %) so one base cannot fill a pack;
- novelty/coverage quotas count **base scenarios**, not variants;
- a pack may ship several variants of a base, but each must be a distinct state
  and pass the gate; "six suit permutations of the same hand" is a cap problem,
  not automatic value.

### 4.7 Acceptance gate for the permutation stage

The stage is done when all of these hold:

- 100 % of shipped variants pass `validate_reachable_state`, the tile ledger and
  the legal-answer check;
- every shipped variant passes the label-preservation gate for its label kind;
- a per-transform/per-lesson yield report exists (attempted, preserved,
  rejected by reason, disabled pairs);
- any transform-lesson pair below a configured yield (initial suggestion: 50 %)
  is disabled by default until reviewed;
- no duplicate state hashes in a pack; per-base and per-pack caps enforced;
- every variant carries `variant_of`, `transform_chain`, `transform_seed` and
  `label_check`;
- the pack report shows variant share and the largest single-base share;
- a 100-scenario rehearsal pack contains variants from at least two transform
  families and no base above the cap.

### 4.8 Tests for the permutation stage

- inverse round-trip for each transform and for a composed chain;
- tile ledger conserved; no fifth copy of a tile;
- red-five identity preserved or deliberately normalised, with scoring
  recomputed;
- classifier re-run on generated book states for every transform pair in the
  matrix;
- explicit sanshoku, honitsu, ittsu, pinfu-head, wind-order, red-five and
  placement cases;
- labeler re-run on a fixed fixture with the app model; top-1 inverse-maps;
- a close-call fixture whose top-1 flips under a transform is rejected;
- dedupe: two transforms that produce the same state collide;
- caps: a base with more than the cap is truncated, and the report says so.

---

## 5. Ordered implementation sequence

### 5.1 Dependency graph

```text
F1  (scaffold + provenance + source gate)
├── R1  mjai reader + replay validator
│   └── R2  walker + GameState + decision enumeration + tenhou6 export
│       ├── C1  agent protocol + match plan + reference runners
│       │   ├── C2  Mortal libriichi backend + M1 Mortal mirror
│       │   │   └── C3  M2 Mortal sampling sweep
│       │   ├── C4  M3 Akochan tactic sweep
│       │   │   └── C5  M4 Akochan vs Mortal (spike first)
│       │   ├── C7  M6 rule/heuristic baseline
│       │   └── C6  M5 heterogeneous table (conditional; needs C2 + C5 + C7)
│       └── L1  native batch labeler + Q values + cache
│           └── L2  agreement + contested + optional future labels + calibration hooks
├── B1  classifier framework + broad batch 1
│   └── B2  classifier batch 2
│       └── B3  shape/block-theory classifiers
├── V1  transform engine
└── P1a pack/manifest schema + audit (fixture packs only)

C2 + C3 + C4 + C5 + C6 + C7 ── C8  corpus integration + quotas + smoke corpus
B1 + L1 + C8 ── S1  triggers
B1/B2 + L2 + S1 ── S2  interestingness + quotas + dedupe + review queue
L2 + S1 ── S3  close-call / speed-value / blunder selectors
V1 + B1/B2 + L2 + S2 ── V2  label-preservation gate + pipeline integration
P1a + S2 + V2 ── P1b  pack assembly from selected, gated scenarios
P1b ── P2  hosting/publisher
P1a + P2 ── P3  frontend pack loader
V2 + P2 + P3 ── Q1  end-to-end acceptance harness
Q1 ── Q2  first curated pack
```

### 5.2 Waves

| Wave | Can start together | Why |
| --- | --- | --- |
| 0 | F1 | every unit needs the feature boundary and provenance types |
| 1 | R1, B1 (fixtures), V1 (synthetic states), P1a (schema with fixtures) | these do not need a real corpus |
| 2 | R2, B2, C1 | parser output is ready; classifiers can grow; runner can start |
| 3 | C2, C7, L1, B3 | Mortal backend starts; rule baseline is independent; labeler and hard classifiers run in parallel |
| 4 | C3, C4, C5, C6, L2 | sampling sweep, Akochan tactics, cross-engine and heterogeneous families; label agreement |
| 5 | C8, S1 | corpus integration and cheap trigger filters |
| 6 | S2, S3 | selection, dedupe and family-specific ranking |
| 7 | V2, P1b | variants need selected bases and stable labels; pack assembly needs variants |
| 8 | P2, P3 | publish and load a real pack |
| 9 | Q1, Q2 | end-to-end acceptance and first curated pack |

Waves group units that become available around the same time. A unit may start as
soon as **its own** dependencies are merged, even if the rest of its wave is
still running; the table is a scheduling guide, not a barrier.

The **critical path to the first pack** is:

```text
F1 → R1 → R2 → { (B1 → L1) ∥ (C1 → { C2, C4 } → C8) } → S1 → S2
   → V2 → P1b → P2 → P3 → Q1 → Q2
```

B1/B2, L1/L2, V1, and the additional corpus families (C3, C5, C6, C7) can run in
parallel around that path. The first curated pack needs at least one
Akochan-derived family, so C4 is on the critical path; M6 (C7) is useful for
pipeline smoke but is not enough for the first curated pack.
Do not start S2 before B1/B2 and L1/L2 are stable; a selector on top of an
unstable classifier produces plausible-looking but wrong drills
(`replay-strategy.md` §6.11).

### 5.3 Unit specifications

Each unit is independently startable once its dependencies are merged. The
"Accepts" bullets are the unit's acceptance criteria; its verification gate is
the relevant shared command set in §7.1 plus the named evidence. A unit is not
done because the code compiles or a screenshot looks plausible.

#### Phase 0 — Foundation

##### F1 — Miner scaffold, provenance schema and source gate

**Goal.** Create the native-only miner skeleton and the metadata contracts every
later unit uses.

**Scope.**

- Add a `miner` Cargo feature, optional native dependencies, and
  `src/bin/mine_replays.rs` with subcommand stubs: `corpus`, `ingest`,
  `extract`, `label`, `transform`, `pack`, `audit`, `review`.
- Add `src/miner/{mod,provenance,source,licence,storage,funnel}.rs` with
  `AgentSpec`, `AgentKind`, `LicenseInfo`, `RuleProfile`, `GameProvenance`,
  `MatchPlan`, `CorpusId`, `ReplayId`.
- Add the source allowlist (`ai_selfplay` only), typed rejection errors, an
  atomic write helper, and a funnel counter.
- Define the candidate/curated DB schema from strategy §4.2 (`replays`,
  `corpus_runs`, `decisions`, `selected_scenarios`, `variants`, `packs`,
  `backups`), extended with `family`, `match_plan_id`, `agents`, `trigger`,
  `variant_of`, `transform_chain` and label/unit fields. SQLite is the
  operational DB; Parquet/DuckDB is an optional derived analytics export.
- Define the local data root (`RIICHI_DATA_DIR`) and its `replays/`, `db/`,
  `snapshots/`, `packs/`, `tmp/` and `logs/` layout from §2.5; store relative
  paths in the DB, never absolute host paths.
- Define the rclone backup contract: Drive remote/folder names, append-only
  raw-log copy, timestamped DB snapshots, `rclone check`, and a restore/integrity
  test. Do not put rclone credentials in either repo.
- Document the JSON schema names and versioning rule.
- No `libriichi` dependency; no AGPL code in this repo.

**Accepts.** Schema round-trip; the DB schema creates/migrates on a fixture;
the data-root layout and relative-path rule are tested; a SQLite `VACUUM INTO`
snapshot passes `PRAGMA integrity_check`; the optional rclone backup/restore
commands are documented and no-op when no remote is configured; allowlist rejects
every other source; atomic write leaves no partial file on error; `cargo tree
--features miner` contains no `libriichi`; default WASM check stays clean.

**Depends on.** Nothing.

**CC slice.** `worktree` / `riichiprac`.

#### Phase 1 — Replay library

##### R1 — mjai reader, replay validator and fixtures

**Goal.** Parse self-play mjai JSONL and reject a malformed game before
reconstruction.

**Scope.**

- Gzipped mjai JSONL reader; event enum for `start_kyoku`, `tsumo`, `dahai`,
  `chi`, `pon`, `daiminkan`, `ankan`, `kakan`, `dora`, `reach`,
  `reach_accepted`, `hora`, `ryukyoku`, `end_kyoku`, `end_game`.
- Tile code mapping including red fives; no Tenhou/Mahjong Soul/Riichi City
  parsers in the ingestion path.
- Structural validation: tile conservation, wall count, scores, event order,
  actor/seat consistency, call legality, dora timing.
- Typed error taxonomy (`ParseError`, `LedgerError`, `EventOrderError`, etc.).
- Synthetic 1-kyoku fixtures and malformed fixtures; a tiny fixture writer for
  tests only.

**Accepts.** The 1-kyoku fixture produces the expected event list; 100 % of
fixture events are represented; every malformed fixture has a typed error; the
tile ledger is conserved; 100 synthetic games parse; no third-party format is an
input.

**Depends on.** F1.

**CC slice.** `worktree` / `riichiprac`.

##### R2 — Replay walker, `GameState` reconstruction, decision enumeration, tenhou6 export

**Goal.** Turn a validated replay into complete `GameState` snapshots at every
decision point, using the app's existing state and validation code.

**Scope.**

- Walk the replay and snapshot **before** applying each action.
- Rotate seats so the actor is `players[0]`; rotate winds, scores, dealer,
  `current_turn`, `from`/`called_from` references and river indices.
- Fill `DecisionContext::SelfTurn`, `ReactToDiscard`, `ReactToKan`, and
  `CallOffer` for call lessons.
- Compute `hand_string`, `tiles`, shanten, agari, decompositions, ukeire,
  `can_riichi` and `book_rationale` through the same helpers the generators use;
  call `validate_reachable_state` and `finalize_state`.
- `tiles_remaining`: prefer the replay's wall count; otherwise the documented
  `70 - live_wall_draws` convention adjusted for kans; assert against the event
  stream.
- Ura dora, kan dora timing, red fives and furiten policy: store the actual ura
  indicators from the record for post-answer display but never expose them
  pre-answer; use only the dora/kan-dora indicators revealed at the decision;
  compute furiten from the replay where possible, and reject a decision whose
  legality/answer depends on furiten if the state model cannot represent it.
- Enumerate decision IDs `sha256(replay_id, kyoku, event_index)`; keep
  `replay_id` + `event_index` on every snapshot for future multi-step drills.
- Reuse the tile-id/naki mapping in `src/export/tenhou6.rs` for a review export;
  extend it to a full-replay log only if the review path needs one. tenhou6 is
  an output, not an input.

**Accepts.** A synthetic 1-kyoku game reaches the expected state at every event;
every reconstructed snapshot passes `validate_reachable_state`; all decision
kinds are covered; rotation invariance holds; tenhou6 export produces a
reviewer-loadable log; 100 fixture games produce 0 invalid states; rerunning the
same replay is deterministic. A validator rejection is triaged as a
reconstruction bug or a documented validator gap; never bypass it silently.

**Depends on.** R1.

**CC slice.** `worktree` / `riichiprac`.

#### Phase 2 — Corpus generation

##### C1 — Agent protocol, match plan and reference runners

**Goal.** Make the corpus runner agent-agnostic and define the metadata it must
write.

**Scope.**

- Create the `riichiprac-corpus` repo as a **private** repository (AGPL-3.0
  licence file if it links `libriichi`; README and Akochan NOTICE).
- Add an `Agent`/`Policy` contract that can wrap a neural model, a rule engine,
  a heuristic, or an external process speaking the chosen protocol.
- Add `MatchPlan` parsing: family, games, seat schedule, seed schedule, rule
  profile, agent list, log directory.
- Add the reference agents H0 `tsumogiri`, H1 `random-legal`, H2
  `isolated-first`, H3 `efficiency-safety` from §3.2. Reuse the hotseat `Policy`
  idea if practical; do not expand the shipped WASM hotseat into a full corpus
  engine.
- Write `GameProvenance` per game and per seat; emit raw logs as
  `$RIICHI_DATA_DIR/replays/<family>/<replay_id>.jsonl.gz` with relative paths
  in the DB.
- Add the optional rclone backup hook: after a shard, copy the immutable replay
  folder to `gdrive:riichiprac/replays/` **if** a remote is configured; record
  the result in `corpus_runs`. A missing remote is a normal local-only run, not
  an error.
- Document the referee/protocol decision and what it guarantees.

**Accepts.** H0 and H1 complete a kyoku; H2/H3 are config-selectable without
changing the runner; the same seed produces the same log; every game has complete
per-seat provenance; replay paths are content-addressed and relative; the source/
licence gates pass; the logs parse through R1/R2; the backup hook is optional and
no-ops when no remote is configured; no weights or AGPL code are needed for the
reference family.

**Depends on.** F1, R1, R2.

**CC slice.** `worktree` / `riichiprac-corpus` (create the repo first if it does
not exist; a `scratch` spike is acceptable before the repo exists).

##### C2 — Mortal `libriichi` backend and M1 Mortal mirror

**Goal.** Generate Mortal-vs-Mortal games with the one available checkpoint and
prove the baseline family.

**Scope.**

- `libriichi::arena` (or the Mortal mjai interface) adapter: load weights once
  per process, batch a shard, dump gzipped mjai logs.
- Pin model identity: file name, sha256, engine commit, config hash. The only
  supported checkpoint is `mortal_298k`; do not accept a match plan naming a
  4.1/3.0 model that we do not have.
- Generation sampling profiles (`boltzmann_epsilon` / `boltzmann_temp` /
  `top_p`) for diversity; labels later at argmax.
- Seat rotation across games; record resolved seats.
- M1 plan: `mortal_298k` vs itself, rotated seats.
- A few-hundred-game M1 smoke corpus (enough to prove the backend and family);
  the 1k total-across-families corpus is C8.
- Per-family report; validate through R1/R2.
- Keep `libriichi` out of this repo's dependency graph.

**Accepts.** Configured M1 games generated; 100 % parse; 0 invalid reconstructed
states on the smoke sample; per-seat provenance complete; rule profile matches;
licence/attribution recorded; the same seed reproduces the seat roster and, when
the engine is deterministic, the log (otherwise `reproducible: false` is
recorded); family report emitted; `cargo tree` in this repo still has no
`libriichi`.

**Depends on.** C1; external weights and a machine that can run them.

**CC slice.** `worktree` / `riichiprac-corpus`.

##### C3 — M2 Mortal sampling sweep

**Goal.** Widen state coverage and produce mild style variation from the same
Mortal checkpoint. This is **not** a different agent and must not be described as
a network mix.

**Scope.**

- M2 plan: `mortal_298k` with several `boltzmann_epsilon` /
  `boltzmann_temp` / `top_p` profiles, rotated seats and dealer positions.
- Record `policy_variety: "sampling"` and the same `weights_sha256` for every
  seat; the config hash differs only by sampling parameters.
- Record action distributions and compare them with M1.
- Feed the wider state set to the selector; do not claim policy diversity from
  this family.

**Accepts.** M1 gates plus a measured divergence from M1; provenance names the
same model hash and marks the variation as sampling; no field claims a
different agent; the family report explains the state-coverage gain.

**Depends on.** C2.

**CC slice.** `worktree` / `riichiprac-corpus`.

##### C4 — M3 Akochan tactic sweep

**Goal.** Add a genuinely different, non-neural rule-based policy and use it to
create style contrast and realistic mistakes.

**Scope.**

- M3 plan: Akochan vs Akochan, using different tactic/config profiles when the
  engine supports them; otherwise a single documented profile.
- Record every seat's Akochan version, config/tactic and seed; `cross_engine:
  false` for self-match.
- If Akochan's native log format is not mjai, convert it in the corpus repo and
  validate the converted log through R1/R2; never add an Akochan parser to the
  app's WASM path.
- Map Akochan's rule/configuration to the canonical rule profile; reject
  mismatches.
- Licence: `data_commercial_use: false`, attribution required, Akochan NOTICE;
  user-supplied binary; no Akochan code or binary in the app repo.
- Record played actions; the Mortal labeler attaches the strong top action/Q gap
  later. Do not use game outcome as a label.

**Accepts.** Parseable logs; per-seat identity/config; rule-profile verification;
Akochan licence flags/attribution; 0 invalid states; measured divergence from
M1; `cross_engine: false`; family report.

**Depends on.** C1, R1/R2; an Akochan binary and a compatible environment.

**CC slice.** `worktree` / `riichiprac-corpus`.

##### C5 — M4 Akochan vs Mortal (spike + adapter)

**Goal.** Determine whether Akochan can share a table with the Mortal checkpoint,
and build the adapter only if it can.

**Scope.**

- **Spike first:** determine whether Akochan can play in the same match as a
  `mortal_298k` agent (mjai/API/process referee) or only self-match. Record the
  answer and the evidence. Do not assume a bridge exists. Lead: Mortal's tree
  contains `libriichi/src/agent/akochan.rs`; inspect whether it is a usable
  bridge before building one from scratch.
- If cross-play is feasible: build the adapter in the corpus repo; record
  `cross_engine: true`; generate M4 same-table games.
- If not: do **not** build a fake cross-play family. Record the decision, mark
  M4 same-table deferred, and satisfy policy mix at the **corpus level** by
  combining M3 (Akochan) and M1/M2 (Mortal) logs in C8. Never describe that mix
  as a same-table Akochan-vs-Mortal game.
- Map Akochan's rule/configuration to the canonical rule profile; reject
  mismatches. Record its version, config, tactic and seed.
- Licence: `data_commercial_use: false`, attribution required, Akochan NOTICE in
  the private corpus repo; no Akochan code or binary in the app repo.
- Diversity metric against M1 (action distribution / state novelty).

**Accepts.** A written spike decision with evidence; if feasible, parseable
same-table logs with per-seat identity/config and `cross_engine: true`; if not,
no same-table claim and a documented corpus-level fallback; rule-profile
verification; Akochan licence flags/attribution; 0 invalid states; configured
diversity yield.

**Depends on.** C1, C4, R1/R2; an Akochan binary and a compatible environment.

**CC slice.** `scratch` for the spike; then `worktree` / `riichiprac-corpus`
for the adapter only if the spike says cross-play is feasible.

##### C6 — M5 heterogeneous table (conditional)

**Goal.** If cross-engine play is feasible, generate tables with a mix of Mortal,
Akochan and heuristic seats.

**Scope.**

- M5 plan: one `mortal_298k` seat, one Akochan seat, one heuristic/reference
  seat (and a fourth supported agent), rotated across seats.
- Record the full roster; no hidden model substitution or relabelled corpus mix.
- Feed multi-policy contested states to selection.
- If C5 says cross-play is not feasible, **defer this unit**. Do not relabel a
  corpus-level mix as a heterogeneous table.

**Accepts.** If feasible: M4 gates plus at least three distinct agents in the
roster, per-seat provenance and a family report. If not feasible: the family is
marked deferred and the corpus report says so; no heterogeneous games are
claimed.

**Depends on.** C2, C5, C7.

**CC slice.** `worktree` / `riichiprac-corpus` only if C5 is feasible;
otherwise close it as deferred.

##### C7 — M6 rule/heuristic baseline family

**Goal.** A deterministic, weights-free corpus for plumbing, tests and optional
beginner material.

**Scope.**

- Implement H0 `tsumogiri`, H1 `random-legal`, H2 `isolated-first` and H3
  `efficiency-safety` as specified in §3.2, in the corpus repo.
- H0/H1 are fixture/fuzzer agents: they must never enter a curated pack.
- H2/H3 may be shipped only after a Mortal/book label is attached and the
  scenario is marked weak-opponent.
- Deterministic by seed; no weights.

**Accepts.** Each baseline is deterministic by seed; H0/H1 are rejected by the
pack gate; H2/H3 are Mortal/book-labelled and marked weak-opponent; logs parse;
provenance complete; family report; the pipeline can run end-to-end on this
family alone.

**Depends on.** C1.

**CC slice.** `worktree` / `riichiprac-corpus`.

##### C8 — Corpus integration: quotas, funnel and 1k smoke corpus

**Goal.** Prove the families work together and produce an ingestible corpus.

**Scope.**

- A single corpus config listing enabled families, games, seat schedules, seed
  ranges and quotas.
- Run all enabled families; produce a funnel report and per-family shortfalls.
- Ingest into the scenario DB; validate through R1/R2; verify provenance rows.
- Write the local data-root layout from §2.5; snapshot the DB with
  `VACUUM INTO` and record the snapshot in `corpus_runs` / `backups`. If the
  separate rclone task is configured, also copy the replay folder and snapshot
  to Google Drive; otherwise record `skipped`.
- Dataset card, storage layout, retention note; raw logs outside git.
- Deterministic rerun of a small shard.

**Accepts.** A configured 1k-game smoke corpus (or the agreed size) across
families; 100 % parse; 0 invalid states; complete provenance; funnel counts match
the per-family reports; quotas/shortfalls visible; the replay folder and DB
snapshot are present under the data root; a restored DB snapshot passes
`PRAGMA integrity_check`; when the separate rclone task is configured,
`rclone check` passes, otherwise the run records `skipped` and local-only
operation is valid; dataset card; no raw logs or weights in git; no third-party
source. 10k games is the scale target only after this smoke gate passes.

**Depends on.** C2–C7.

**CC slice.** `worktree` / `riichiprac-corpus` for the runner; a `none` or
`scratch` ops task for the actual run if it needs a GPU box.

#### Phase 3 — Book classifiers

##### B1 — Classifier framework and broad batch 1

**Goal.** Recognise arbitrary states that satisfy a book lesson and return the
lesson's unique answer.

**Scope.**

- Add `matches(state: &GameState) -> Option<Match>` and `Match { lesson,
  situation, target_action, correct_action, equivalent_tiles }`.
- Add `TransformPolicy` to the classifier contract (default deny).
- Batch 1: `riichi_judgement`, the four `dama_*` lessons, `push_or_fold`,
  `fold_to_riichi`, and the defense safety lessons.
- Reuse `analysis`, `safety`, `completion`, `rationale`; no RNG or generator
  skeleton; recompute the answer; visible information only for the answer.
- Add near-miss tests and generated-state positive tests.

**Accepts.** Existing generators' states classify as their lesson; near misses
return `None`; every returned answer is legal; rotation invariance after seat
normalisation; no dependence on generator RNG; transform policy declared; tests.

**Depends on.** F1 (can use existing generators for fixtures); integration with
R2 for replay states.

**CC slice.** `worktree` / `riichiprac`.

> **Status (2026-11-16, B1 branch).** Recognisers live in `src/classifier/`
> (`riichi.rs`, `push_fold.rs`, `defense.rs`, shared `support.rs`) and the miner
> seam in `src/miner/classifier.rs`; the module is **not** behind the `miner`
> feature because the B1 gate is the default app gate. `Match` carries the
> plan's five fields plus the trigger/reason lists and pre-answer note the
> shipped rationale needs, and `Match::stamp` writes them onto a state through
> `finalize_state`. When two book rules read the same visible state differently,
> **Mortal is the tiebreaker**: `classify_with_mortal` keeps the lesson whose
> answer the model's top action agrees with (the app's existing
> `compare_action_set` rule, including `equivalent_tiles` and the Riichi
> second-pass discard) and records `Resolution::MortalTiebreak { rejected }` for
> provenance. Without an evaluation, `classify_unique` fails closed with a
> `Conflict`. `src/miner/classifier.rs` mirrors both paths for the walker
> (`classify_decision`, `classify_decision_with_mortal`).
>
> Two label overlaps are settled by the same Mortal rule, and the lesson
> content was aligned so they cannot arise from generated states: (a) inside
> ch. 7, the generators now build disjoint cells — `riichi_judgement` only draws
> its riichi sets, `dama_bad_wait` owns every bad wait, the improving board
> plants two live simple tanki so the box agrees, and the expensive board keeps
> a good wait. An *arbitrary replay* state can still satisfy two specific ch. 7
> sections at once; `classify_all` shows both and Mortal picks the label. (b) In
> ch. 8, a `CC` board is the safety chart's `non_suji` answer *and* the fallback
> lesson's board, and the two can name different tiles; both recognisers return
> their match and Mortal decides. Without an evaluation either overlap is a
> `Conflict` and the state is not shipped.

##### B2 — Classifier batch 2

**Goal.** Cover the medium-difficulty lessons that produce valuable replay
families.

**Scope.**

- `suji_trap_riichi`, `pinfu_head`, `honitsu_decision`, `meld_or_not`,
  `ankan_decision`, `shouminkan_decision`, `daiminkan_decision`,
  `wind_discard_order`.
- Same contract and tests as B1.

**Accepts.** B1 criteria for each lesson; no cross-lesson misclassification in
the near-miss set; transform policy declared.

**Depends on.** B1.

**CC slice.** `worktree` / `riichiprac`.

> **Status (2026-11-16, B2 branch).** Recognisers live beside B1 in
> `src/classifier/`: `suji.rs`, `pinfu.rs`, `honitsu.rs`, `call.rs` (meld/Pon and
> open quad), `kan.rs` (concealed and added quad) and `wind.rs`. All six files
> are on the default app build and share B1's `support`, `Match` and registry.
> `Match::validate` now grades every answer against the state's own
> `legal_actions` list, so a **Kan** or **Pass** answer is checked exactly like a
> discard, and `Match::stamp` preserves the decision context and `call_offer`
> (a ch. 9 call's offer is part of its question, not its answer). `Match` also
> carries the recomputed `shouminkan_triggers` so a mined kakan state keeps the
> book rationale.
>
> Cell overlaps were settled rather than left to Mortal: (a) `suji_trap_riichi`
> refines the bad-wait box's **dama** cell, so `dama_bad_wait` defers to it — a
> trap state can never also be labelled dama; (b) `honitsu_decision` refuses an
> opening hand, a hand with a discard into tenpai, and any table with a call or
> Riichi, so the ch. 7 and ch. 8 families own those states (the generated
> honitsu boards are quiet mid-hand plans); (c) the concealed-quad decline owns
> the floating-tile case and takes the throw with the highest floating-line
> acceptance, so it cannot steal a justified quad; (d) `pinfu_head` and
> `wind_discard_order` are opening-turn-only, and `honitsu_decision` is
> mid-turn-only, which keeps the three disjoint. Generated states now enumerate
> as disjoint in the framework test.
>
> Transform policies follow §4.5: `pinfu_head` and `wind_discard_order` declare
> their denials (red-five for pinfu; seat and wind for the seating tip) with
> notes, and the other B2 families opt in only through the recompute gate. The
> gate covers `cargo fmt --check`, `cargo test --lib`, the classifier
> positive/near-miss/legal/rotation tests (G4), `cargo clippy --lib --tests`,
> the `miner` seam tests, and `cargo check --target wasm32-unknown-unknown`.

##### B3 — Shape/block-theory classifiers

**Goal.** Extend recognition to arbitrary-state shape/efficiency comparisons.

**Scope.**

- Block-theory shape lessons that are harder to recognise than to construct.
- Bound the search; return `None` when the comparison is not decisive.
- Add performance budget tests.

**Accepts.** B1 criteria plus a documented performance bound and no
misclassification of ambiguous shapes.

**Depends on.** B2.

**CC slice.** `worktree` / `riichiprac`.

> **Status (2026-11-16, B3 branch).** All ten ch. 3/ch. 4 block-theory lessons
> are recognised from arbitrary states in `src/classifier/shape/`: `ryanmen`,
> `nakabukure`, `protorun_priority`, `ryankan`, `plus_one`, `nobetan`,
> `pair_count`, `pair_count_open`, `skipping` and `perfect`, registered on the
> default app build with B1/B2. The recognisers never read the state's answer:
> they enumerate the at most fourteen distinct discards, ask `agari` for the
> effective-hand shanten/acceptance, and apply the shape predicate the lesson's
> constructor proves. `Match::validate` still grades every returned tile
> against the state's own legal discards, and `Match::stamp` preserves the
> decision context.
>
> **Bounded and fail closed.** A hand partition is an exact-cover search capped
> at `MAX_SEARCH_NODES = 4096`; the expensive completion helpers
> (`side_wait_routes`, `is_perfect_one_away`, `can_reach_side_wait`) run only on
> the two or three hands a lesson compares. Every recogniser declines a tie, a
> second line with the same book claim, or a state outside its cell:
> - ryanmen requires the drawn duplicate, a sets + pair + bare side-wait
>   partition, and exactly two winning kinds;
> - nakabukure separates the ready cell (strictly best tenpai discard) from
>   1-away keep/break by the draw's rival block (adjacent to one pair vs between
>   two pairs), so the same shape can teach all three answers;
> - protorun priority requires the closed wait's two tiles to be the unique
>   tied maximum and the kept hand to show two side waits;
> - ryankan requires the draw one rank below the head, the low terminal to keep
>   a side wait, and both the draw and the high terminal to lose it;
> - protorun plus one requires exactly one side-wait and one closed-wait cover
>   tying at the top;
> - nobetan requires the one 3456/4567, two pairs, the shape-preserving best
>   discard, both ends accepting more, and more side-wait routes kept;
> - pair count requires three suited pairs, the drawn pair as the strict best
>   break, and every other pair break tying it;
> - pair count open requires one live honour pair (the visible Pon plan), the
>   closed oracle preferring the pair break but the post-Pon line reversing it,
>   and only the redundant float tying;
> - skipping requires same-rank isolated competition, equal current acceptance
>   and a strictly larger protorun-draw count;
> - perfect requires exactly one perfect-1-away discard and a non-perfect rival
>   that accepts more.
>
> **Family boundaries.** The shape rules are offensive block comparisons, so
> `shape::view` refuses a table with an opponent Riichi or open meld (the ch. 8
> defence family owns those boards), and protorun priority defers to
> `push_or_fold` when that box also fires. The two pair-count cells are
> disjoint by construction: the closed lesson refuses an honour pair and the
> open lesson requires a live one. Generated boards across B1–B3 are proven
> disjoint by the framework test.
>
> **Performance and transform policy.** `shape::PERFORMANCE_BUDGET` documents
> the bound (14 discard evaluations plus the capped block search per state; a
> 20-state generated batch must classify in under 5 s even while the suite
> runs), and `the_shape_family_stays_within_its_performance_budget` pins it.
> The family opts into seat, suit, rank-mirror, wind-relabel and red-five
> variants with recompute: the rules compare runs, protoruns and rank gaps,
> never values, dora or seats. The gate run was `cargo fmt --check`,
> `cargo test --lib` (745 tests, three consecutive runs),
> `cargo clippy --lib --tests -- -D warnings`,
> `cargo check --target wasm32-unknown-unknown` and, for the miner seam,
> `cargo test --features miner --lib` (884 tests).

#### Phase 4 — Mortal labeler

##### L1 — Native batch labeler, Q values and cache

**Goal.** Label a reconstructed `GameState` with the app's MIT inference and keep
the per-action Q values the browser currently discards.

**Scope.**

- Add a mining-only `q_value` to `ActionEvaluation` (or a separate
  `CounterfactualEvaluation`); do not change the browser payload unless the UI
  needs it.
- Batch native evaluation with `MortalV4Model` and
  `evaluate_state_named`; load weights once per process.
- Record `model`, `model_sha256`, `q_units: "model_utility"`, `gamma`/`pts` when
  known, `q_values`, `q_gap_top2`, `q_gap_safe`, `probability_margin`.
- Riichi second pass; call mapping through `legal_actions`; agreement uses
  `compare_action_set` (including `equivalent_tiles`).
- Cache by `(state_hash, model_sha256, classifier_version, options)`; rerunning a
  shard skips finished work and retries failures.
- Parity test against `evaluate_state`; no `libriichi` link.

**Accepts.** Exact top-1/ranking parity on a fixed fixture; Q values match the
model metadata; probabilities are the softmax/Q-derived values; no field claims
points; rerun does not re-evaluate finished states; every label records the
labeler model identity, hash and units, and both labeler and generator identities
when they differ; tests.

**Depends on.** R2, F1.

**CC slice.** `worktree` / `riichiprac`.

##### L2 — Book agreement, contested states and calibration hooks

**Goal.** Make book/Mortal disagreement explicit and prepare (but do not fake)
point equity.

**Scope.**

- Single-model labels from `mortal_298k`: record the model identity/hash and
  units on every label.
- Book agreement using `generator::mortal_agreement` /
  `fuzz::compare_action_set`; `stable` vs `contested`; no silent tie-break.
- Optional future multi-model support: accept a `--models` list and record each
  member's identity/votes if more checkpoints are ever obtained. With one Mortal
  model this path is unused; do **not** call one model an ensemble.
- Percentile thresholds per decision family for close calls and confidence.
- Optional Q→point calibration: a separate versioned mapping, a separate
  `expected_point_diffs` field, raw Q values never overwritten.
- Model identity mismatch (e.g. a future checkpoint vs 298k) is recorded, not
  hidden.

**Accepts.** Single-model labels work end to end; book/Mortal disagreement is
flagged `contested`; agreement uses the existing comparison rules; percentile
selection is deterministic and configurable; calibration is versioned and
separate; raw Q values preserved; multi-model is an optional, tested path that
no gate depends on; tests.

**Depends on.** L1, B1.

**CC slice.** `worktree` / `riichiprac`.

> **Status (2026-11-16, L2 branch).** Implemented in `src/miner/label/`:
> `agreement.rs` derives `stability` (`stable`/`contested`/`unresolved`) and
> `label_kind` (`book`/`contested`/`mortal`/`none`) from the book half and an
> optional multi-model consensus; a discrepancy keeps the book answer and marks
> the label `contested`, never silently preferring the model. Agreement is
> `fuzz::compare_action_set`, the same rule as `generator::mortal_agreement`
> (a test pins the two together). The shard run writes `label_kind`/
> `label_source` onto the `decisions` row. `--models` accepts extra checkpoints
> for the optional vote path (two or more members only; one model is never called
> an ensemble; the path skips the single-model cache). `thresholds.rs` provides
> per-family (`<decision_kind>/<turn_bucket>`) configurable close-call/confidence
> percentiles with deterministic nearest-rank cuts as the S3 hook.
> `calibration.rs` defines the separate versioned `riichiprac.q-point-calibration`
> v1 mapping and an `expected_point_diffs` field derived from the raw Q values;
> it is not in the cache key, so recalibrating a cached label runs no forward
> pass, and no field claims points without an explicit calibration.

#### Phase 5 — Selection

##### S1 — Triggers and family filters

**Goal.** Raise recall cheaply before the expensive model pass.

**Scope.**

- Defensive/riichi: an opponent has declared Riichi; target 0/1/2-shanten; a
  genbutsu or suji exists; threat is tenpai in the record.
- Offensive/architecture: no active Riichi; target 1-shanten; turns 5–12; two
  legal discards with divergent speed/value plans.
- Book matcher, call/kan, score/placement, close-call and blunder triggers.
- Record why each fired (`trigger: "defensive_riichi"`, `"book:ch8.1"`, etc.).
- Run cheap structural/book filters before Mortal.

**Accepts.** Fixtures fire and do not fire correctly; reasons are recorded; a
corpus sample report shows recall/precision; no model pass for cheap filters;
tests.

**Depends on.** B1, L1, C8.

**CC slice.** `worktree` / `riichiprac`.

##### S2 — Interestingness, quotas, dedupe and review queue

**Goal.** Select a balanced, legal, non-duplicated candidate set.

**Scope.**

- Hard gates from `replay-strategy.md` §7.1: legal/reachable, well-defined
  answer, legal answer, visible-info answer, label confidence,
  source/licence/provenance, not a duplicate, no spoiler.
- Ranking signals and the composite score from `replay-strategy.md` §7.2, used
  **within** a family after the gates.
- Family quotas (book, contested, mortal_best, mistake, close_call, speed_value,
  coverage, table_read, placement, multi_step later); per-book-section,
  per-decision-kind and per-turn bucket quotas.
- Dedupe: exact state hash + visible-info fingerprint; transformed states do not
  collide by accident.
- Held-out QA set; review queue as JSONL using the existing
  `riichiprac.scenario-report` for a single candidate.
- Funnel report: raw → trigger → reconstructed → valid → classified → labelled →
  selected → packed.

**Accepts.** A 100-scenario hand-reviewed smoke pack with no duplicates or
invalids; quotas enforced; held-out set kept; review queue consumed; source/
licence gates pass; no single family crowding out the others.

**Depends on.** S1, L2, B1/B2, C8.

**CC slice.** `worktree` / `riichiprac`; the human review itself is `none`.

##### S3 — Close-call, speed-vs-value and blunder selectors

**Goal.** Implement the non-book families with concrete, non-guessed logic.

**Scope.**

- Close call: top-2 probability/Q-gap percentile per family; mark "close"; use
  `equivalent_tiles` for ties; show both actions when they genuinely differ.
- Speed vs value: 1-shanten, no active Riichi, two legal discards whose
  resulting states diverge in both acceptance (shanten/ukeire) and hand value
  (`evaluate_hand`/`agari`); label one speed, one value; Q gap decides closeness.
- Blunder: the weaker policy's played action (Akochan or heuristic) vs the
  Mortal labeler's top action; require a confidence threshold; never use the
  game outcome.
- No absolute point thresholds; the agent-spec 400/250 numbers are calibration
  hypotheses, not constants.

**Accepts.** Fixture tests for each selector; a real corpus sample report; no
absolute point claim; no outcome bias; labels/answers legal.

**Depends on.** L2, S1.

**CC slice.** `worktree` / `riichiprac`.

#### Phase 6 — Permutation

##### V1 — Transform engine

**Goal.** Implement the transforms with inverses and complete field coverage.

**Scope.**

- `Transform` enum/chain for `seat_perm`, `suit_perm`, `rank_mirror`,
  `wind_relabel`, `red5_normalize`.
- Apply to every tile-bearing field; update `DecisionContext`/`call_offer`
  references; recompute derived fields only in the gate, not silently in the
  transform.
- Implement the inverse mapping for labels and answers.
- Record transform params and seed.
- Property tests for round-trip and tile conservation.

**Accepts.** Every transform is reversible; all fields are covered (a synthetic
state with every field populated changes consistently); tile ledger conserved;
no panic on edge cases (kans, red fives, ura dora, calls, riichi); tests.

**Depends on.** F1 for generated-state fixtures; R2 for replay-state
integration.

**CC slice.** `worktree` / `riichiprac`.

> **Status (2026-11-16, V1 branch).** The engine lives in `src/miner/transform/`
> (miner feature), as `seat` (opponent permutations), `tiles` (suit bijections
> and kind maps), `mapping` (one relabelling step and the answer/text
> vocabulary), `apply` (the `GameState` rewrite and the red-five record),
> `ledger` (the visible-tile ledger) and `chain` (the transform chain, its
> inverse and the `riichiprac.scenario-transforms` v1 document).
>
> **The chain.** `TransformChain` holds the schema/version, the
> `transform_seed`, the ordered `Transform` list and — once applied — the
> red-five copies a `red5_normalize` cleared. `apply` returns the transformed
> state plus the resolved chain (the provenance document); `Resolved::inverse`
> gives an `InverseChain` that applies the inverse mappings in reverse order and
> restores the red-five flags. Answers and model labels map through both
> directions: `map_correct_action`, `map_action_info`, `map_action_name`,
> `map_tile`, `map_text`, including `Discard_5mr` suffixes, the `tile_index` a
> ranking carries, and the rank-relative `Chi_Low`/`Chi_High` names (a rank
> mirror swaps them). `fingerprint` is the seed-independent dedupe key.
>
> **Field coverage.** Every tile-bearing `GameState` field is rewritten: hands,
> draws, red-five lists, rivers (with `is_red`), meld tiles, dora/ura indicators,
> `hand_string`, `tiles`, `ukeire_tiles`, `equivalent_tiles`, `correct_action`,
> `call_offer` (tiles and label), `decision.tile`, the whole `ai_decision`
> payload, `scenario_note`, `round_wind`, the players' winds, `current_turn`,
> every `called_from` and `decision.from`. Free text is rewritten token by token
> (codes and the book display names `E`/`S`/`W`/`N`/`Wh`/`G`/`R`/`R5m`), which is
> a bijection on the tokens it recognises and leaves other words alone.
> `book_rationale` is deliberately untouched: §4.4 recomputes it through
> `finalize_state`, and its book quotations must stay verbatim (they say
> `wan4`, `suo2` and `zhong`, not app codes).
>
> **Decisions worth knowing.**
> - A seat wind belongs to the seat, so a permuted player takes the destination
>   seat's wind (the labels move only with `wind_relabel`). Letting winds travel
>   with players would leave the table out of wind order, which
>   `validate_reachable_state` rejects; `apply` also refuses a table whose winds
>   are not the seat-0 sequence when a seat permutation runs.
> - A chi may only claim the caller's kamicha, and the opponents' adjacency is
>   not permutation-invariant. `apply` therefore rejects a seat permutation that
>   would move a chi meld (or a chi offer's source) off the previous seat; that
>   is a structural impossibility, not a label question.
> - `red5_normalize` clears every aka flag and records the slots it cleared
>   (`Concealed`/`River`), which is the only information the inverse cannot
>   derive. It refuses a state whose graded answer — `correct_action` or any
>   action in the `ai_decision` payload — names a red discard (`Discard_5mr`):
>   that action stops existing once the copy is plain, and the label must be
>   re-derived rather than rewrapped. Transform the base state before labelling.
> - A called tile is written twice in this model (the caller's meld and the
>   source's river record), so `TileLedger` skips the river record. The matcher
>   moved into `state_validation::claim_records`, shared with
>   `validate_meld_claims`, with a flag for the validator's "all four copies
>   already held, no witness needed" exception.
>
> **Evidence.** 56 engine tests: per-transform and composed round trips on a
> synthetic state with every field populated; explicit field-by-field suit/
> seat/rank/wind/redeye assertions; ledger conservation and the no-fifth-copy
> rule; answer/label inverse mapping; fail-closed cases (chi seating, red
> answers, bad tile, bad seat, foreign schema/version, duplicate normalisation);
> every walked `all_events_game` snapshot round-tripping through all five
> transforms, still reachable after a suit or rank relabel (kans, red fives, ura
> dora, calls and riichi included). The gate run was `cargo fmt --check`,
> `cargo test --lib` (744 tests), `cargo clippy --lib --tests -- -D warnings`,
> `cargo check --target wasm32-unknown-unknown`, and for the miner library
> `cargo test --features miner` (939 tests),
> `cargo clippy --all-targets --features miner -- -D warnings` and
> `! cargo tree --features miner | grep -qi libriichi`. The headless browser gate
> was not run: this machine has no Chrome, and no wasm-exposed behaviour changed.

##### V2 — Label-preservation gate and pipeline integration

**Goal.** Make permutation a real pipeline stage, not a helper.

**Scope.**

- `transform` subcommand: take selected base scenarios, expand each into a
  configured number of variants, apply the lesson's `TransformPolicy`, re-run the
  classifier/labeler, reject failures, dedupe, enforce caps.
- Store `variant_of`, `transform_chain`, `transform_seed`, `label_check`.
- Per-transform/per-lesson yield report; disable pairs below the threshold.
- Integrate with `pack` so only gated variants enter a pack.
- Cache model labels.
- Tests from §4.8.

**Accepts.** §4.7 acceptance gate; a 100-scenario rehearsal with variants from at
least two transform families; no base above the cap; every shipped variant
label-preserving; report.

**Depends on.** V1, B1/B2, L2, S2.

**CC slice.** `worktree` / `riichiprac`.

#### Phase 7 — Pack and publish

##### P1a — Pack/manifest schema, audit and fixture publisher

**Goal.** Define and validate the static pack format before wiring the full
selection/permutation output into it.

**Scope.**

- `PackSource` (kind, corpus_id, licence, attribution, redistributable,
  `data_commercial_use`, `agents`), `PackScenario`, `PackManifest`.
- Extend the existing strategy §6.7 shape with `source.agents`,
  `provenance.variant_of`, `transform_chain`, `label_check`, `played.agent`.
- Schema version 1; required fields; unknown fields tolerated only where the
  app can ignore them safely.
- Source/licence gate: reject non-`ai_selfplay`, missing/unknown licence,
  incomplete agent provenance, missing `GameProvenance` for a scenario's
  `replay_id`, commercial pack containing Akochan data.
- Legal-answer check, spoiler check, hash/byte budget, atomic write, deterministic
  pack hash.
- `audit` subcommand with `--strict`; `pack report`.
- Reuse `scenario-report` for single-candidate review.
- A fixture pack written by hand/tests is enough for this unit.

**Accepts.** Schema round-trip; source/licence gate rejects every negative case,
including a scenario with no matching game provenance; every `correct_action`
legal and included in `accepted`; no spoiler; pack bytes within budget; atomic
write; audit clean; fixture pack.

**Depends on.** F1.

**CC slice.** `worktree` / `riichiprac`.

> **Status (2026-11-16, P1a branch).** Implemented in `src/miner/pack/`:
> `model.rs` defines `riichiprac.scenario-pack` v1 and
> `riichiprac.scenario-pack-manifest` v1 with the extended `source.agents`,
> `provenance.variant_of`/`transform_chain`/`label_check` and `played.agent`;
> `gate.rs` runs the executable G8 gate and returns stable finding codes;
> `check.rs` covers state reachability, legal/accepted answers, spoilers, units
> and variant honesty; `write.rs` provides deterministic gzip encoding,
> content-addressed atomic publishing and the atomic manifest; `audit.rs` audits
> a directory (manifest budget, hash/bytes/count, per-body gate, strict-only
> drift and unlisted bodies); `fixture.rs` is a seeded two-lesson fixture pack
> with valid synthetic game provenance; `report.rs` is the pack report. The CLI
> gained `pack fixture`, `pack report` and `audit [--strict] [--commercial]`.
> The gate refuses a missing `GameProvenance`, a commercial profile over
> non-commercial/Akochan data, a variant without a preserved label check, an
> illegal answer, a spoiler and an over-budget body. A `games.jsonl` provenance
> source (default beside the manifest) is how P1a checks G0 before P1b reads the
> DB. Tests cover every negative case in the acceptance list, deterministic
> hashes, atomic writes and the clean fixture audit; the operator contract is in
> `replay-miner-operations.md`.

##### P1b — Pack assembly from selected, gated scenarios

**Goal.** Turn the selector's base scenarios and the permutation stage's
variants into a real, audited pack.

**Scope.**

- Read selected decisions + gated variants from the DB (`selected_scenarios`,
  `variants`); emit `PackScenario` records with provenance and transform chains.
- Write the pack to `$RIICHI_DATA_DIR/packs/<pack-id>-<sha256-prefix>.json.gz`
  and record it in `packs` / `pack_scenarios`; the DB is the source of truth, the
  JSON file is the runtime export.
- Apply family quotas, per-base caps, dedupe and the pack byte budget.
- Re-run the audit and write the manifest atomically.
- Emit a pack report: family mix, variant share, largest base share, byte size,
  licence/agent union.

**Accepts.** A pack assembled from a real (or realistic fixture) selection;
audit clean; quotas/caps/dedupe enforced; deterministic pack hash; the DB rows
and JSON export agree exactly; pack report.

**Depends on.** P1a, S2, V2.

**CC slice.** `worktree` / `riichiprac`.

##### P2 — Hosting/publisher (Pages / R2 / HF)

**Goal.** Publish packs with the existing hosting pattern without shipping the
corpus.

**Scope.**

- Same-origin manifest + content-addressed packs under
  `frontend/public/scenarios/`; the bodies come from the audited exports in
  `$RIICHI_DATA_DIR/packs/`. Keep total committed packs within the agreed
  budget (default 50 MB; move to R2/HF when larger). The AGENTS.md 8 MB
  committed-asset budget is already mostly consumed by the rendered-view
  shell/felt assets (~7.2 MB), so packs default to a lazy external source or a
  very small same-origin pack; do not assume pack bodies fit in the remaining
  repo budget.
- Google Drive is a backup for the corpus/DB, **not** a runtime pack host; the
  browser loads Pages/R2/HF, never Drive.
- Optional R2/HF mirror; manifest stays same-origin; loader tries same-origin
  first.
- GitHub Release asset path only as a CI copy step, because Release assets send
  no CORS headers (hosting-plan.md).
- Deploy workflow copies selected packs; no raw corpus, no weights, no LFS.
- Runbook + CORS/byte checks.

**Accepts.** A smoke pack publishes; manifest loads; hash/bytes verified; Pages
build includes the packs; CORS check for an external mirror; runbook; no raw
corpus/weights in the artifact.

**Depends on.** P1b.

**CC slice.** `worktree` / `riichiprac`; account setup steps are `none`.

##### P3 — Frontend pack loader

**Goal.** Load the manifest and one pack lazily without changing game logic.

**Scope.**

- Manifest fetch + schema check; content-addressed pack fetch; verify hash/bytes
  before parsing.
- IndexedDB cache (follow `services/weightLoader.ts`): key by pack id + sha256;
  cache version; swallow cache failures.
- Merge WASM `list_scenarios()` metadata with pack lesson metadata; add replay
  lesson IDs to `SCENARIO_MANIFEST` where a picker entry is needed.
- Loading/error/empty states; no answer spoilers; no new game rules in React.
- ARIA parity with the existing picker and table; interaction tests in vitest.
- No visual sign-off by the agent; hand the dev URL to the user (AGENTS.md §6).

**Accepts.** `npm test`, `npm run build`, `npm run lint`; manifest/pack load;
cache hit on reload; hash mismatch/error path; picker can select a pack lesson;
ARIA assertions; no new game logic; initial load budget unaffected (manifest
only).

**Depends on.** P1a (fixture manifest); P2 for a real pack.

**CC slice.** `worktree` / `riichiprac`.

#### Phase 8 — Validation and first ship

##### Q1 — End-to-end pipeline acceptance harness

**Goal.** Make the whole pipeline reproducible and testable without a GPU or a
network.

**Scope.**

- Scripted pipeline: fixture corpus → ingest → extract → classify → label
  (fixture model or skipped) → select → transform → pack → audit → loader smoke.
- Determinism check: same inputs → same pack hash.
- Gate matrix: source/licence, provenance, legal answers, no spoilers, size
  budget, dedupe, variant preservation.
- CI job for fixtures and schema; real corpus generation stays offline.
- Review queue + held-out QA.

**Accepts.** The pipeline passes on fixtures in CI; the same inputs produce the
same pack hash; every gate has a failing test; no third-party source; docs.

**Depends on.** P2, P3, V2.

**CC slice.** `worktree` / `riichiprac`.

##### Q2 — First curated pack: 100 ch. 8 defense scenarios

**Goal.** Ship one small pack and measure it before scaling.

**Scope.**

- Generate/choose the corpus families needed for ch. 8 defense; use M1/M2
  Mortal plus M3 Akochan (or M4/M5 if cross-engine), not M1/M2 alone; classify
  with `fold_to_riichi`/defense safety; label with Mortal; select; expand
  variants; pack; audit.
- Human/agent-assisted review of all 100; reject ambiguous, illegal, spoiling or
  unteachable scenarios.
- Publish through the Pages manifest; loader smoke test.
- Measure pack bytes, initial load, cache behaviour, answer accuracy and
  "too easy/too hard" feedback (local or consented aggregate).
- Record results and decide whether to scale.

**Accepts.** 100 reviewed scenarios; no duplicates/invalids; source/licence/
provenance complete; pack loads; byte/initial-load budgets; measurements
recorded; user sign-off on the artifact; docs updated.

**Depends on.** Q1.

**CC slice.** `worktree` / `riichiprac` for the pack; `none` for the human
review/sign-off. Q2r in §6 is that review task; it produces no code and is not
counted as an implementation unit.

### 5.4 Critical path and parallel tracks

- **Critical path:** F1 → R1 → R2 → C1 → C2 → C8 → B1 → L1 → S1 → S2 → V2 →
  P2 → P3 → Q1 → Q2.
- **Parallel early:** B1/B2 can start after F1 using existing generators; V1 can
  start after R2; P1a can start after F1 with fixture packs.
- **Parallel corpus:** C3–C7 all start after C2 (or C1 for C7) and can run on
  separate machines; C8 is the integration gate.
- **Do not reorder:** S2 before classifiers/labels are stable; V2 before P2;
  P2 before P3's real-pack acceptance; Q1 before Q2.

---

## 6. Proposed command-center slicing

One task per implementation unit. All repo work is a **worktree** on the named
repo. There is no `shared` project checkout in this plan; the only non-repo
workspaces are the Akochan feasibility spike (`scratch`) and operational/human
review tasks (`none`).

| Unit | Proposed task title | Type | Repo / project | Depends on |
| --- | --- | --- | --- | --- |
| F1 | Replay miner F1: scaffold, provenance schema, source gate | worktree | `riichiprac` | — |
| R1 | Replay miner R1: mjai reader, validator, fixtures | worktree | `riichiprac` | F1 |
| R2 | Replay miner R2: walker, GameState reconstruction, tenhou6 export | worktree | `riichiprac` | R1 |
| C1 | Corpus C1: agent protocol, match plan, reference runners | worktree | `riichiprac-corpus` | F1, R1, R2 |
| C2 | Corpus C2: Mortal libriichi backend + M1 Mortal mirror | worktree | `riichiprac-corpus` | C1 |
| C3 | Corpus C3: M2 Mortal sampling sweep | worktree | `riichiprac-corpus` | C2 |
| C4 | Corpus C4: M3 Akochan tactic sweep | worktree | `riichiprac-corpus` | C1, R1/R2 |
| C5a | Corpus C5a: Akochan cross-play feasibility spike | scratch | — | C1, C4 |
| C5b | Corpus C5b: M4 Akochan-vs-Mortal adapter (only if feasible) | worktree | `riichiprac-corpus` | C5a, C1, C4, R1/R2 |
| C6 | Corpus C6: M5 heterogeneous table (conditional, only if cross-play) | worktree | `riichiprac-corpus` | C2, C5b, C7 |
| C7 | Corpus C7: M6 rule/heuristic baseline family | worktree | `riichiprac-corpus` | C1 |
| C8 | Corpus C8: family quotas, funnel, 1k smoke corpus | worktree | `riichiprac-corpus` | C2–C7 |
| B1 | Classifiers B1: framework + broad batch 1 | worktree | `riichiprac` | F1 |
| B2 | Classifiers B2: batch 2 | worktree | `riichiprac` | B1 |
| B3 | Classifiers B3: shape/block-theory classifiers | worktree | `riichiprac` | B2 |
| L1 | Labeler L1: native batch labels + Q values + cache | worktree | `riichiprac` | R2, F1 |
| L2 | Labeler L2: book agreement, contested states, calibration hooks | worktree | `riichiprac` | L1, B1 |
| S1 | Selector S1: triggers and family filters | worktree | `riichiprac` | B1, L1, C8 |
| S2 | Selector S2: interestingness, quotas, dedupe, review queue | worktree | `riichiprac` | S1, L2, B1/B2, C8 |
| S3 | Selector S3: close-call, speed-value, blunder selectors | worktree | `riichiprac` | L2, S1 |
| V1 | Variants V1: transform engine and inverses | worktree | `riichiprac` | F1 (R2 for replay states) |
| V2 | Variants V2: label-preservation gate + pipeline stage | worktree | `riichiprac` | V1, B1/B2, L2, S2 |
| P1a | Pack P1a: schema, audit, fixture publisher | worktree | `riichiprac` | F1 |
| P1b | Pack P1b: assembly from selected, gated scenarios | worktree | `riichiprac` | P1a, S2, V2 |
| P2 | Pack P2: Pages/R2/HF hosting and CI | worktree | `riichiprac` | P1b |
| P3 | Pack P3: lazy frontend loader + picker | worktree | `riichiprac` | P1a, P2 |
| Q1 | QA Q1: end-to-end acceptance harness | worktree | `riichiprac` | P2, P3, V2 |
| Q2 | Ship Q2: first 100-scenario ch. 8 defense pack | worktree | `riichiprac` | Q1 |
| Q2r | Review Q2r: human review of the first pack | none | — | Q2 |

Before C1, create the `riichiprac-corpus` repo as a **private** repository
(AGPL-3.0 licence file, README, Akochan NOTICE). We will consider making it
public later; do not publish it, its logs or its engine bundle until that
decision is made. C1's worktree requires an existing repo. Do not create C2–C8
worktrees before that repo exists. C5 is deliberately split into a `scratch`
feasibility spike (C5a) and an adapter unit (C5b) because the cross-play mode is
not known yet; C6 is created only if C5 says cross-play is feasible. Every other
row is one implementation unit.

Suggested creation pattern (do not create the whole list at once; create the
current wave):

```bash
cc-task new "Replay miner F1: scaffold, provenance schema, source gate" \
  --open --type worktree --repo riichiprac <<'EOF'
Implementation unit F1 from replay-implementation-plan.md. Read
replay-strategy.md and the plan; implement only this unit.
EOF
```

For the corpus repo:

```bash
cc-task new "Corpus C2: Mortal libriichi backend + M1 Mortal mirror" \
  --open --type worktree --repo riichiprac-corpus <<'EOF'
Implementation unit C2 from riichiprac/replay-implementation-plan.md. Private
AGPL corpus repo; do not link libriichi into the app repo.
EOF
```

For the Akochan spike, use a `scratch` task with no repo, and record the answer
in the corpus repo's README/decision log. Do not create the adapter task until
the spike says which mode is feasible.

---

## 7. Verification gates

### 7.1 Shared commands

Define these once; unit gates reference them.

```bash
# Default app gate (no miner feature, shipped target).
cargo fmt --check
cargo test --lib
cargo clippy --lib --tests -- -D warnings
cargo check --target wasm32-unknown-unknown

# Miner library gate (native only).
cargo fmt --check
cargo test --features miner
cargo clippy --all-targets --features miner -- -D warnings
cargo check --target wasm32-unknown-unknown   # default features must stay clean
! cargo tree --features miner | grep -qi libriichi

# WASM browser gate (unchanged).
wasm-pack test --headless --chrome

# Frontend gate.
cd frontend && npm test && npm run build && npm run lint
```

Storage/backup check (operator machine; rclone lines only after the separate
rclone task is configured):

```bash
STAMP=$(date +%s)
SNAP="$RIICHI_DATA_DIR/snapshots/miner-check-$STAMP.sqlite"
sqlite3 "$RIICHI_DATA_DIR/db/miner.sqlite" "VACUUM INTO '$SNAP'"
sqlite3 "$SNAP" "PRAGMA integrity_check;"
# Optional, after the rclone task:
rclone check "$RIICHI_DATA_DIR/replays" gdrive:riichiprac/replays --checksum
rclone copy "$SNAP" gdrive:riichiprac/db/
```

If the baseline `cargo fmt --check` is red on `main` for an unrelated file, fix
or quarantine that separately; do not let it hide a real failure in a miner
unit.

Which gate applies:

| Unit group | Gate |
| --- | --- |
| F1, R1, R2 | default app gate + miner library gate; R2 also G1/G2 |
| C1–C8 | corpus repo's native tests + G1/G2/G3 on the generated sample |
| B1–B3 | default app gate + the classifier positive/near-miss tests (G4) |
| L1–L2 | default app gate + miner library gate + label parity/cache tests (G5) |
| S1–S3 | default app gate + corpus sample selection report (G6) |
| V1–V2 | default app gate + transform inverse/preservation tests (G7) |
| P1a–P1b | miner library gate + pack audit (G8) |
| P2 | Pages/CI build + manifest/hash/CORS checks |
| P3 | frontend gate + loader/cache/ARIA tests (G9) |
| Q1–Q2 | all of the above + end-to-end fixture pipeline (G10) |

### 7.2 Pipeline gates

| Gate | Evidence | Blocks |
| --- | --- | --- |
| G0 Source/provenance | every game has `source.kind = ai_selfplay`, a `GameProvenance` row, a licence allowlist entry | ingest, pack |
| G1 Parser | 1-kyoku fixture + 100-game fixture corpus; 0 malformed passes; tile ledger | R2, C1 |
| G2 Reconstruction | every sampled snapshot passes `validate_reachable_state`; 0 invalid | R2, C1 |
| G3 Corpus families | per-family report: games, parse rate, valid rate, provenance, rule profile, licence flags, quota/shortfall | C2–C8 |
| G4 Classifiers | generated positive tests + near-miss negatives; legal answers; rotation invariance | B1–B3 |
| G5 Labels | top-1/ranking parity with `evaluate_state`; Q units documented; cache hit on rerun | L1–L2 |
| G6 Selection | hard gates; family quotas; dedupe; held-out QA; review queue | S1–S3 |
| G7 Variants | every shipped variant label-preserving; invalid rejected; caps/dedupe; yield report | V1–V2 |
| G8 Pack | schema; source/licence; legal answers; no spoilers; hash/byte budget; atomic write | P1a–P1b |
| G9 Loader | vitest, build, lint; manifest/pack load; cache; ARIA parity | P3 |
| G10 End-to-end | fixture pipeline in CI; deterministic pack hash; all gates have a failing test | Q1 |
| G11 Storage/backup | local data-root layout; content-addressed replay paths; SQLite snapshot + `PRAGMA integrity_check`; when the separate rclone task is configured, `rclone check` and a restore sample; otherwise `skipped` | F1, C1, C8, Q1 |

### 7.3 Pack and loader gates

- `source.kind` exactly `ai_selfplay`; any other value is a hard rejection.
- Complete `source.agents` union with licence and attribution; unknown licence
  fails.
- If any Akochan game contributes, `data_commercial_use` is false and the
  publisher refuses a commercial profile.
- Every `correct_action` is legal; `accepted` contains it; a riichi answer has a
  discard; a call answer has an offer.
- No prompt/title/provenance spoiler.
- Manifest + pack hash/bytes match; pack bytes within budget; manifest is small
  and same-origin.
- Pack loads through the same import/render path; no new React game logic.
- Initial hand + board load is unaffected because only the manifest is loaded at
  startup; packs are lazy.

### 7.4 Visual work

The agent does not sign off a render, screenshot, layout or "does it look
right" judgement. For any visual change:

1. save the artifact to a path inside the worktree (or `/tmp/opencode`);
2. give the user the path and the command to view it;
3. say what to compare and what question needs an answer;
4. state the numeric checks already run;
5. wait for the user's verdict before calling it done.

For the loader, prefer vitest DOM/ARIA/geometry assertions. For the felt/shells,
follow AGENTS.md §6 and `tools/render/README.md`.

---

## 8. Risks and open decisions

| # | Risk / decision | Why it matters | Unit that resolves it |
| --- | --- | --- | --- |
| 1 | Is Akochan cross-play feasible, or only self-match? | The M4 family must not claim a mixed table it did not run; the licence applies to both modes | C5a spike |
| 2 | Only one Mortal checkpoint (`mortal_298k`) is available offline; the 4.1a/b/c/3.0 networks are online-service only and their weights are unreleased | Policy variety cannot come from the Mortal ladder; M2 is sampling-only, and Akochan/heuristic carry the real diversity | C4, C5, C6 |
| 3 | Rule-profile mismatch (Akochan defaults vs Tenhou 4p-hanchan) | A state from a different rule set is not a valid app state | C5, C8, R1 |
| 4 | Furiten is not explicitly modelled | Furiten-dependent decisions must be computed or rejected, not silently mined | R2, B1 |
| 5 | Ura/kan dora display timing | The snapshot must use indicators visible at the decision | R2, P3 |
| 6 | Q→point calibration | The UI must not call a Q gap "points" before a versioned calibration exists | L2, S3 |
| 7 | Precomputed labels vs on-load labels | Labels make packs useful without weights but spoil the answer in JSON and can go stale | P1a, P3 |
| 8 | Human review budget | 100 scenarios can be reviewed; 10k cannot without a review tool | S2, Q2 |
| 9 | Variant caps vs anti-memorisation volume | Too many variants of one base is duplication; too few loses the benefit | V2 |
| 10 | Data licence CC BY 4.0 vs CC0 | The app code is MIT; data needs its own clear licence | P1a (product-owner decision) |
| 11 | Hosting budget | Pages is simple but has site/bandwidth limits; R2/HF are cheap and CORS-friendly | P2 |
| 12 | Multi-step drills | They need a step engine and grading/history behavior; keep IDs now, ship later | P1a, P3 |
| 13 | `mortal_298k` is a community checkpoint whose model card says it was trained on Tenhou hanchan data | This is a weights-provenance question, separate from the no-third-party-replay rule; review before commercial use | product owner; P1a licence gate |
| 14 | Google Drive is backup, not a live database; rclone copy/delete semantics, quota and latency can lose or corrupt data | Use a local SQLite DB, `VACUUM INTO` snapshots, append-only `rclone copy --immutable` for replays, `rclone check` and a restore test; never mount Drive and point SQLite at it | F1, C8, Q1 |

---

## 9. Definition of done for the first shipped pack

The first pack (Q2) is done when all of these are true:

- 100 scenarios, all `source.kind = "ai_selfplay"`, with complete per-game
  agent/config/sampling/seed provenance and licence/attribution;
- at least two families contribute, including at least one Akochan-derived family
  (M3, or M4/M5 if cross-engine) and one book-aligned family; M1/M2 alone are
  not enough. M6-only is acceptable for a pipeline smoke pack, not for the first
  curated pack;
- every scenario passes the legal/reachable/answer/no-spoiler gates;
- variants are label-preserving, deduped, capped, and reported; the pack contains
  variants from at least two transform families and at least 20 % of scenarios
  are variants, or the pack report justifies a lower share; no single base
  dominates the pack;
- the pack and manifest pass audit, hash/byte budgets, and the source/licence
  gate; the source DB and replay folder have a local snapshot/restore check, and
  a Drive copy when the separate rclone task is configured;
- the frontend loads the manifest, fetches the pack lazily, caches it in
  IndexedDB, and grades with the existing WASM path; vitest/build/lint pass;
- a human has reviewed the 100 candidates (and the user has signed off any
  visual artifact, per AGENTS.md §6);
- measured pack size, initial load, cache behavior and answer accuracy are
  recorded, and the scale-up decision is explicit.

---

## 10. Related docs

- [`replay-strategy.md`](replay-strategy.md) — authoritative source, licensing,
  scenario families, pack format, existing-code appendix.
- [`replay-miner-operations.md`](replay-miner-operations.md) — F1 operator
  contract (feature boundary, data root, provenance schemas, source/licence
  gates, SQLite schema, snapshots, optional rclone backup) and the R1 replay
  format/validation contract (accepted mjai events, ledger, wall, dora, scores,
  fixtures).
- [`hosting-plan.md`](hosting-plan.md) — Pages/Release/HF pattern, CORS findings,
  weights licence boundary.
- [rclone Google Drive](https://rclone.org/drive/) and
  [SQLite `VACUUM INTO`](https://www.sqlite.org/lang_vacuum.html) — the backup
  mechanics used by §2.5.
- [`scenario-report-plan.md`](scenario-report-plan.md) — single-candidate report
  envelope, useful for the review queue.
- [`scenario-fuzz-plan.md`](scenario-fuzz-plan.md),
  [`scenario-fuzz-findings.md`](scenario-fuzz-findings.md) — existing
  book/Mortal comparison rules and real disagreement classes.
- [`ai-scenario-plan.md`](ai-scenario-plan.md) — AI decision payloads, legal
  actions, model identity and spoiler control.
- [`mortal-validation.md`](mortal-validation.md) — model parity/validation
  discipline.
- [`generator-refactor-plan.md`](generator-refactor-plan.md) — lesson module
  layout and shared analysis helpers.
- `src/generator/hotseat/` — existing policy-agnostic one-round simulator; a
  reference for the corpus protocol, not a substitute for a full native runner.
- `src/ai/wasm_bridge.rs`, `src/ai/model.rs`, `src/decision.rs` — the MIT
  inference path and the place to add a mining-only Q value.
- `frontend/src/services/weightLoader.ts` — the ordered-source + IndexedDB
  pattern to reuse for packs.

---

## Appendix A — What changed from the strategy document

This plan deliberately does not rewrite the strategy's analysis. It makes two
implicit stages explicit and gives them units and gates:

1. **§3.3 corpus recipe → §3 corpus requirement + C2–C7.** The family table is
   now a set of independently gated corpus products; the runner must accept
   pluggable agents and record per-game agent identity/config/sampling/seed.
2. **§5.9 transformations → §4 permutation stage + V1–V2.** The transform list is
   now a required stage after selection, with a `TransformPolicy` per lesson, a
   re-run label gate, and a variant-level acceptance gate.
3. **§3.1/§3.3 model availability → one Mortal checkpoint + Akochan +
   heuristic.** The plan no longer assumes the 4.1a/b/c/3.0 weights exist
   offline; M1/M2 are the same `mortal_298k` checkpoint at different
   sampling settings, M3–M6 provide the actual policy variety, and multi-model
   ensembles are parked.

Everything else follows the strategy: `GameState` reuse, source allowlist,
AGPL separation, Q-value units, pack hosting and human review.

## Appendix B — Unit-to-code map

| Unit | Primary files / repos |
| --- | --- |
| F1 | `Cargo.toml`, `src/bin/mine_replays.rs`, `src/miner/` |
| R1 | `src/replay/mod.rs`, `src/replay/mjai.rs`, `src/replay/validate.rs`, fixtures |
| R2 | `src/replay/walker.rs`, `src/replay/reconstruct.rs`, `src/export/tenhou6.rs` |
| C1–C8 | `riichiprac-corpus` (new private repo): `src/agent/`, `src/plan/`, `src/engine/`, `src/report/` |
| B1–B3 | `src/classifier/` (framework + per-family recognisers; it must build on the default app gate, so it is not behind `miner`), plus `src/miner/classifier.rs` for the replay-walker seam |
| L1–L2 | `src/miner/label/`, `src/decision.rs`, `src/ai/wasm_bridge.rs` |
| S1–S3 | `src/miner/select/`, `src/miner/triggers/` |
| V1–V2 | `src/miner/transform/` |
| P1a–P1b, P2 | `src/miner/pack/`, `frontend/public/scenarios/`, `.github/workflows/deploy.yml` |
| P3 | `frontend/src/services/packLoader.ts`, `frontend/src/scenarios.ts`, `App.tsx` |
| Q1–Q2 | `tests/`, `src/bin/mine_replays.rs`, `scripts/` |
