# S3 close-call, speed-vs-value and blunder selector sample

Implementation unit S3 (`replay-implementation-plan.md` §5.3, phase 5) turns
the three non-book families from ranking signals into concrete selectors. This
page records the acceptance sample, the fixture evidence and how to reproduce
both. The raw replay logs and the operational SQLite DB are outside git; the
machine-readable report is committed at
[`testdata/reports/s3-selector-sample.json`](testdata/reports/s3-selector-sample.json).

## What a selector is, and what a trigger is not

S1's triggers are a **recall** filter: a hit says "worth inspecting". S3's
selectors are the stricter second step that decides whether a decision really
is a close call, a speed-vs-value drill or a blunder. `mine_replays selectors`
reports both numbers side by side, so the refinement is visible:

- `close_call` agrees with its trigger exactly, because both use the same L2
  top-two percentile.
- `speed_value` accepts fewer decisions than the offensive trigger: the Mortal
  top action must be one of the two divergent plans.
- `mistake` accepts far fewer than the label-derived blunder trigger: the
  recorded actor must be a **weak policy**, not the Mortal labeler disagreeing
  with itself.

The selector is also wired into `mine_replays select`: an accepted verdict keeps
the family on the candidate and extends the accepted tile set for a real
equivalent-tile tie; a declined verdict drops the family the trigger proposed.
The accepted verdict (the close alternative, the speed/value plan pair, or the
weak agent's played action) is stored on the review-queue item's `special` field.

## Corpus sample

- Replays: 12 games — four each of `mortal_mirror` (Mortal vs Mortal),
  `akochan_vs_mortal` (one Akochan seat, three Mortal seats) and
  `heterogeneous_table` (Akochan plus the `efficiency-safety-v1` and
  `isolated-first-v1` heuristics).
- Labels: every decision was labelled by `mortal_298k.safetensors`
  (SHA-256 `afb911473ac8…`, classifier version `1`) and read from the L1/L2
  `model_labels` cache. The selector run never runs a forward pass.
- Report: `riichiprac.selector-sample` v1, generated `20261118-035035`.

| Stage | Count |
| --- | ---: |
| Replay files | 12 |
| Replays walked / failed | 12 / 0 |
| Decisions reconstructed | 6,734 |
| Decisions with a cached label | 6,734 |
| Decisions whose actor is a weak policy | 2,203 |

All 6,734 decisions carry a label, because the sample labelled every decision of
all three families before the run. The 2,203 weak-policy decisions are every
Akochan and heuristic seat; the 2,029 `mortal_mirror` decisions have none.

## Selectors

| Selector | Triggered | Evaluated | Accepted | Close | Ties | Divergences |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `close_call` | 675 | 6,734 | 675 | 675 | 0 | — |
| `speed_value` | 130 | 6,734 | 115 | 5 | 0 | 115 |
| `mistake` (blunder) | 124 | 6,734 | 112 | 0 | 0 | — |

`Evaluated` is every labelled decision the selector could measure; a selector
that does not apply (a defence turn for `speed_value`, a neural actor for
`mistake`) declines with a counted reason.

Per replay family:

| Replay family | Replays | Decisions | Weak-policy | `close_call` | `speed_value` | `mistake` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `mortal_mirror` | 4 | 2,029 | 0 | 181 | 25 | 0 |
| `akochan_vs_mortal` | 4 | 2,628 | 658 | 293 | 38 | 5 |
| `heterogeneous_table` | 4 | 2,077 | 1,545 | 201 | 52 | 107 |

The `mortal_mirror` row is the clearest evidence for the blunder rule: 2,029
Mortal decisions produced **zero** blunders even though the label-derived
trigger proposed 124 across the corpus. A Mortal-vs-Mortal sampling difference
is not a mistake drill. The heuristics in `heterogeneous_table` produce many more
blunders (107) than Akochan (5), which is the expected ordering of policy
strength, not an outcome effect.

### Close call

Accepted 675 of 6,734 labelled decisions. The default close-call percentile is
10 %, and 675 is the bottom decile of the per-family samples (each of the twelve
`<kind>/<turn>` families contributes its own cut). The 6,046 `not_close`
declines are the rest of the labelled pool; 13 decisions have fewer than two
legal actions and decline `no_top_two`. The measured gap bands are 675 close
(all accepted), 676 confident and 5,368 middle (all declines); two gaps were not
finite and recorded no band.

No close call in this corpus is an equivalent-tile tie. A tie is the app's own
equivalence — the same discard tile including the red/plain five spelling, or a
tile the classifier lists in `equivalent_tiles` — so an ordinary second-best
action is **shown** as the alternative but is not graded as correct. Structural
symmetry (1m vs 9m in a mirror-image hand) is deliberately not enough: those are
different tiles in the same river.

### Speed vs value

The offensive trigger proposed 130; the selector accepted 115. The 26
`answer_not_in_pair` declines are decisions where the Mortal top action is
neither the speed nor the value plan, so the drill would not teach the
trade-off. The other declines are the scope conditions: 3,599 `not_one_shanten`,
1,746 `riichi_active`, 643 `no_divergence`, 310 `turn_outside_window` and 295
`not_self_turn`.

The accepted verdicts carry both plans with their post-discard shanten, ukeire
and worst-completion ron value. The value plan is worth **strictly** more and the
speed plan keeps at least one more live tile; no point threshold is compared.
Closeness is the Q gap between the two plans, banded by the family's top-two-gap
percentile: 5 accepted drills are close, 56 are middle and 54 are confident, so
a speed/value drill can be a close call too.

### Blunder

The label-derived trigger proposed 124; the selector accepted 112. The 4,531
`actor_not_weak` declines are the rule doing its job: 2,029 Mortal-mirror
decisions plus every Mortal seat in the mixed games. A further 788 had a played
gap in the family's close or middle band (71 close, 709 middle, and 8 with no
finite gap), 1,295 played the Mortal top action, and 8 played an action with no
Q value.

Every accepted blunder is in its family's confident band; the confidence test is
the L2 percentile of the played-action gap, not a point threshold. The selector
reads the recorded action and the label's Q values only. It never reads the
kyoku result, the final score or `ura_dora`; a fixture changes all three and
asserts the verdict is identical.

## Selection integration

A `select` run over the same twelve replays (`--pack-id s3-smoke-all --size 30`)
fills all three special quotas from selector-accepted candidates. The queue's
`special` field carries the verdict; for example a `speed_value` item lists the
speed and value actions with their ukeire and worst value, and a `mistake` item
lists the Mortal answer and the weak agent's played action. The pre-answer
scenario report never contains those actions; they are post-answer review data.

One candidate keeps one graded answer. When the label is `book` or `contested`,
that answer is the book answer, and the S3 verdict records the Mortal
alternative or plan pair beside it; the review queue shows both. A pack that
wants the Mortal close-call/blunder presentation should take the verdict's
answer, which is P1b's decision, not a second answer forked here.

## Fixture evidence

`src/miner/select/special/tests.rs` pins one positive and one near-miss
negative per selector:

- close call: a gap in the close band is accepted and marked close; a middle
  gap, a missing family sample, and a gap measured in another family decline;
  the second action is shown but not graded; a classifier-listed equivalent
  tile is graded as a tie, while a structural mirror image is not;
- speed vs value: the 1-shanten fixture accepts with speed `1z` and value `4p`
  (both plans recorded, `speed` role first); the no-divergence hand declines;
  an active Riichi, an out-of-window turn, and a Mortal answer outside the pair
  decline; the 0.4 Q gap is middle, not close;
- blunder: a weak Akochan actor with a confident gap accepts and records the
  played action; a neural actor and a missing provenance decline
  `actor_not_weak`; the top action, an unscored action, a middle gap and a
  missing sample decline; changing the score, honba and ura indicators leaves
  the verdict unchanged;
- every accepted answer and every accepted tie is a legal action;
- the config rejects a reversed window and a zero acceptance gap;
- every selector family maps to an S1 trigger and has a report row.

`cargo test --features miner --lib select::special` runs them.

## No absolute point claim

The only point number in a verdict is `worst_value_gap`, the recorded plans'
worst-completion ron value difference. It is descriptive: the selector accepts
on the ordering (value plan strictly worth more, speed plan strictly accepting
more), not on `>= 400` or `>= 250`. Closeness is always a band from the same
decision family's percentile, and a family with fewer than eight samples declines
with `no_percentile_sample`. No calibrated point equity is claimed.

## Reproduce

```bash
# 1. Label the shard once (the slow, model stage). The committed sample used
#    the same cache; a fresh data root needs all three commands.
for family in mortal_mirror akochan_vs_mortal heterogeneous_table; do
  cargo run --release --features miner --bin mine_replays -- \
    --data-dir "$RIICHI_DATA_DIR" label \
    --weights frontend/public/models/mortal_298k.safetensors \
    --family "$family" --limit 4 --json
done

# 2. Report the three selectors; no forward pass, no queue, no pack.
cargo run --release --features miner --bin mine_replays -- \
  --data-dir "$RIICHI_DATA_DIR" selectors --limit 12 --json \
  > testdata/reports/s3-selector-sample.json

# 3. Exercise the selector inside selection and inspect the queue verdicts.
cargo run --release --features miner --bin mine_replays -- \
  --data-dir "$RIICHI_DATA_DIR" select --limit 12 \
  --pack-id s3-smoke-all --size 30 --json
cargo run --release --features miner --bin mine_replays -- \
  --data-dir "$RIICHI_DATA_DIR" review --pack s3-smoke-all --list --dry-run
```

The review queue and the report are working data under `$RIICHI_DATA_DIR`;
only the aggregate report above belongs in git.

## Residuals

- The sample is twelve games and 6,734 decisions. The blunder family is the
  thinnest (112 accepted, 5 from Akochan), so a larger mixed corpus is the way
  to grow it, not a looser threshold.
- No equivalent-tile tie occurs in this corpus, so that path is covered by the
  fixture, not by the sample. Red/plain five ties and classifier-listed twins
  are the intended cases; structural symmetry is explicitly not a tie.
- The speed/value selector is closed-hand only, because the completion walk is
  the closed-hand `agari` reading; an open 1-shanten hand declines `open_hand`
  until a meld-aware walk exists. This is the only scope cut that hides
  candidates rather than explaining them.
- The close-call count tracks the configured percentile by construction. That is
  a calibration choice for S2's quotas, not evidence about the corpus.
