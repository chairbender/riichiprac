# Variants V2: label-preservation gate and rehearsal report

Implementation unit V2 (`replay-implementation-plan.md` §4 and §5.3) turns the
V1 permutation engine into a pipeline stage: selected base scenarios expand into
drill variants, each transform chain is gated by re-running the classifier or
labeler, unreliable transform/lesson pairs are disabled by measured yield, and
only gated variants reach a pack. This page records the §4.7 acceptance
rehearsal, the measured findings and how to reproduce them.

The machine-readable report is committed at
[`testdata/reports/v2-variant-report.json`](testdata/reports/v2-variant-report.json).
The pack body and the review artifacts are **not** committed: the rehearsal is
generated, and the variant files carry the answers.

## What the stage does

```text
selected bases ─► per-lesson policy ─► planned chain(s) ─► V1 apply
      ─► finalize_state ─► reachability + tile ledger
      ─► label-preservation gate (book / contested / mortal / mistake)
      ─► pair yield ► disable < 50 % pairs ► dedupe ► per-base/per-pack caps
      ─► gated PackScenarios ► build_pack ► P1a gate
```

The gate rejects with a stable code and the report counts it. The full rule
list is in [`replay-miner-operations.md`](replay-miner-operations.md#variants-label-preservation-gate-and-pipeline-stage-v2).

## Reproducing the rehearsal

There is no committed replay corpus, so the §4.7 rehearsal builds its 100 base
scenarios from the app's own seeded lesson generators, stamped with their own
classifier answers (the same construction P1a's fixture uses), with P1a's
fixture provenance so the pack source gate can audit them.

```bash
cargo build --release --features miner --bin mine_replays
rm -rf /tmp/riichi-rehearsal
target/release/mine_replays --data-dir /tmp/riichi-rehearsal \
  transform --rehearsal 100 --pack
target/release/mine_replays --data-dir /tmp/riichi-rehearsal audit
target/release/mine_replays --data-dir /tmp/riichi-rehearsal pack report
```

The report is written to
`/tmp/riichi-rehearsal/reviews/<pack-id>/variants/variant-report.json`. The test
suite runs the same check (slower, in debug) with:

```bash
cargo test --features miner --lib miner::variant::tests::a_hundred_base_rehearsal \
  -- --ignored
```

## Rehearsal results

Run `variant-rehearsal-20261117-181241`, generated 2026-11-17. Defaults:
3 variants per base, per-base cap 8, per-pack share 20 %, minimum yield 50 %,
no checkpoint (book labels only).

| Stage | Count |
| --- | ---: |
| Base scenarios | 100 |
| Planned chain attempts | 590 |
| Labels preserved | 284 |
| Shipped variants | 265 |
| Withdrawn because a pair was disabled | 19 |
| Dropped by the per-base cap | 0 |
| Duplicate state hashes | 0 |
| Unusable bases | 0 |

The funnel by rejection code (per-chain first failure):

| Code | Count | Meaning |
| --- | ---: | --- |
| `state_unreachable` | 198 | mostly the wind rotation (see below), plus seat permutations whose river counts stop fitting a legal turn order |
| `transform_noop` | 79 | a red-five normalisation on a state with no red five |
| `disabled_pair` | 19 | preserved, then withdrawn because its pair measured below 50 % |
| `lesson_missing` | 16 | the transformed state no longer matches the lesson |
| `label_conflict` | 7 | the transformed state's rules disagree and no label can be settled |
| `transform_rejected` | 6 | V1 refused the chain (a chi that stops coming from kamicha, etc.) |

### Yield by transform family

Every pair is counted once per base it was attempted on; a composed chain counts
under each family it contains.

| Family | Attempted | Preserved | Yield | Lessons disabled |
| --- | ---: | ---: | ---: | ---: |
| `suit_perm` | 199 | 146 | 73.4 % | 1 |
| `rank_mirror` | 156 | 129 | 82.7 % | 4 |
| `seat_perm` | 154 | 57 | 37.0 % | 16 |
| `wind_relabel` | 113 | 0 | 0.0 % | 31 |
| `red5_normalize` | 85 | 0 | 0.0 % | 26 |

152 `(lesson, family)` pairs were measured; 78 were disabled (`below_threshold`).
`wind_relabel` and `red5_normalize` are disabled for every lesson whose policy
allows them, `seat_perm` for 16 of 31 lessons, and one `suit_perm` pair (the
call lesson, where a chi's source seat is not suit-invariant).

### Shipped variants

| Slice | Count |
| --- | ---: |
| `suit_perm` (first family) | 135 |
| `rank_mirror` | 87 |
| `seat_perm` | 43 |
| composed `suit_perm+rank_mirror` | 38 |
| composed `seat_perm+suit_perm` | 4 |
| Book-labelled | 265 |
| Mortal-labelled | 0 (no checkpoint supplied) |

The rehearsal ships **three transform families**, satisfying §4.7's "at least
two". The largest single base contributes 4 scenarios (the base plus 3
variants), far below the effective cap of 8.

### Pack

- 365 scenarios (100 bases + 265 variants), 72.6 % variants.
- 225,741 encoded bytes, CC BY 4.0 data, agents `mortal-298k` (libriichi,
  AGPL-3.0) and `heuristic-v1` (MIT), generated from two fixture games.
- `mine_replays audit`: 0 failures, 0 warnings.
- `pack report`: variants 265 (73 %), largest base share 1 %.

### Finding: the wind rotation is unstable under the reachability validator

`wind_relabel` rotates the round wind and all four seat winds while the rivers
stay put. The walker/validator derives the dealer seat from the actor's seat
wind (`dealer_seat(players[0].wind)`), so the rotation changes which seat the
validator believes dealt without moving any discards; most rotated tables stop
being a legal turn order (`rivers [...] cannot be reached from dealer ...`). The
gate therefore measures 0 % for every wind pair and the default stage disables
them all.

That is the §4.7 rule working as specified: a low-yield pair is disabled by
default until reviewed, and a reviewer can re-enable one through
`--yield-policy`. Whether the validator should account for the round wind, or
whether the wind transform should rotate seats as well, is a policy/engine
question for a later unit; V2 reports the measurement and fails closed rather
than shipping a rotated drill.

`red5_normalize` is disabled for the same "measure and fail closed" reason: 79
of its 85 attempts on generated book puzzles had no red five to normalise (a
no-op chain is rejected), so the family has no demonstrated volume on this
sample. It remains available for lessons whose states commonly hold a red five.

## Test evidence

`cargo test --features miner` (V2 module, 49 tests plus one ignored slow test):

- **§4.7 checklist.** Every shipped variant is reachable, ledger-valid, has a
  legal answer, no spoiler, a unique state hash, `variant_of`, the resolved
  `transform_chain`, a non-empty `transform_seed` and a preserved `label_check`;
  the pack ships no base above the cap and spans two or more families.
- **§4.8 cases.** Inverse round-trip through the gate; wrong-answer rejection;
  no fifth copy (the V1 ledger runs on every variant); tile-conserving chains;
  classifier re-runs over the rehearsal for suit/rank/seat/wind/red-five;
  explicit honitsu, suji-trap, pinfu-head, wind-order, red-five and
  absent-lesson (sanshoku/ittsu/placement) cases; a close-call top-1 flip and a
  band change both rejected; the model label cache serving a rerun; duplicate
  state and commuting-chain collisions; per-base and per-pack caps with the
  report recording each truncation; the replay-queue runner, dry run, published
  pack and DB persistence.
- **Gates.** `cargo test --lib` (745), `cargo test --features miner` (1081),
  `cargo clippy --all-targets --features miner -- -D warnings`,
  `cargo fmt --check`, `cargo check --target wasm32-unknown-unknown`, and
  `cargo tree --features miner` contains no `libriichi`.

Visual sign-off is not involved in V2: the stage produces JSON and a pack body,
not a rendered view.
