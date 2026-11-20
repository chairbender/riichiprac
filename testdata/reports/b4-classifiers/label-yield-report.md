# B4 — classifiers for the four generated-only lessons: label-yield report

Task `261119-1718` (replay-first rollout `B4`, see
[`replay-first-rollout.md`](../../../replay-first-rollout.md)). This report is
the acceptance evidence for the four new recognisers: they classify their own
generators' boards, refuse the documented near-misses, and this pass measures
what they find in the existing 1,542-game corpus.

- **Classifier generation:** `CLASSIFIER_VERSION = "3"` (was `"2"`). The version
  is part of the label cache key, so this one bump invalidated every cached
  label once, as the rollout doc requires.
- **Corpus / data root:** `~/riichiprac-data/q2-ch8-defense-2026-11` — the same
  1,542-game AI self-play corpus the v2 coverage table was measured on.
- **Labeler:** `mortal_298k.safetensors`, SHA-256
  `afb911473ac8e20cb249c4c71344cf92c780cfc98d405c60574f38f485ccc128`
  (`AGENTS.md` §5c).

## What ran

One `label --trigger book` pass per replay family, all cores (`--workers 0`,
resolved to 14), `--progress`, no failures and no unresolved book conflicts:

```bash
cargo build --release --features miner --bin mine_replays
for fam in akochan_tactics akochan_vs_mortal heterogeneous_table \
           mortal_mirror mortal_sampling_sweep; do
  ./target/release/mine_replays \
    --data-dir ~/riichiprac-data/q2-ch8-defense-2026-11 \
    label --weights <mortal_298k.safetensors> \
          --family "$fam" --workers 0 --trigger book --progress --json \
    > label-$fam.json
done
```

| family | replays | decisions | book-triggered | labelled | stable | contested | unresolved | workers | wall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| akochan_tactics | 14 | 8,063 | 1,719 | 1,719 | 1,166 | 553 | 0 | 14 | 1 min 3 s |
| akochan_vs_mortal | 15 | 7,637 | 1,116 | 1,116 | 628 | 488 | 0 | 14 | 32 s |
| heterogeneous_table | 15 | 8,184 | 1,700 | 1,700 | 1,106 | 594 | 0 | 14 | 50 s |
| mortal_mirror | 750 | 383,240 | 54,628 | 54,628 | 31,487 | 23,141 | 0 | 14 | 24 min 19 s |
| mortal_sampling_sweep | 748 | 379,928 | 53,931 | 53,341 | 31,756 | 22,175 | 0 | 14 | 26 min 0 s |
| **total** | **1,542** | **787,052** | **113,094** | **112,504** | **66,143** | **46,951** | **0** | 14 | **52 min 45 s** |

`labelled` counts forward passes; a duplicate model-visible position reuses its
cached label and still lands in the `decisions` table, so the
stable + contested column sums to the 113,094 book labels (590 reused labels in
`mortal_sampling_sweep`, none elsewhere).

The per-family reports are committed beside this file as
`label-<family>.json`; the per-lesson split is
[`label-yield.json`](label-yield.json), produced by
[`scripts/label-yield-report.py`](../../../scripts/label-yield-report.py):

```bash
scripts/label-yield-report.py \
  --db ~/riichiprac-data/q2-ch8-defense-2026-11/db/miner.sqlite \
  --classifier-version 3 --out testdata/reports/b4-classifiers/label-yield.json
```

## Yield for the four new lessons

Raw labels (before the selection gates and duplicate/lesson floors; the shipped
base count is lower — the multi-threat lesson's 1,153 labels produced 780
selected bases).

| Section | Lesson | Stable | Contested | Total | Coverage floor (40 stable) |
| --- | --- | ---: | ---: | ---: | --- |
| ch7.2 | `chiitoitsu_riichi_vs_dama` | **252** | 2,218 | 2,470 | clears it |
| ch5.5 | `chiitoi_vs_toitoi` | **120** | 133 | 253 | clears it |
| ch8.4 | `open_hand_defense` | **4** | 15 | 19 | **far below — corpus growth (`C9`)** |
| ch5.1 | `sanshoku_pursuit` | **2** | 1 | 3 | **far below — corpus growth (`C9`)** |

Both thin lessons are expected, and neither is a classifier bug:

- `open_hand_defense` needs *three open melds whose last call is a chii*, with
  the discard thrown after it, on a quiet hand of 2-away or worse. AI self-play
  rarely ends a slow hand facing a three-meld open hand that has just discarded
  after a chii.
- `sanshoku_pursuit` is a tenpai hand with an extra floating tile and two
  teaching waits (side-wait pinfu vs closed-wait sanshoku); that exact shape is
  rare in a random walk.

`Q3` (ch7) can ship `chiitoitsu_riichi_vs_dama` and `Q4` (ch5) can ship
`chiitoi_vs_toitoi` from this corpus; the ch8.4 and ch5.1 rows must wait for
`C9`'s corpus growth, so those lessons stay generated-default for now.

The 90 % contest rate on the seven-pairs cell matches the rest of the ch. 7
family (`riichi_judgement` is 3,182 / 6,139, `dama_bad_wait` 2,664 / 13,067):
Mortal declares Riichi far more often than the book's chiitoitsu box, so those
labels ship as contested drills or are filtered by the selection gates, exactly
like the other ch. 7 cells.

## Existing lessons: what moved and why

The only classifier changes that can move an existing label are the two
deferrals B4 adds (the ch. 5.5 pair shape from `honitsu_decision`, and the
ch. 5.1 wait-choice shape from the ch. 7 family). Measured against the v2 table
in `replay-first-rollout.md` (same corpus, same model), every other lesson is
identical:

| Lesson | v2 stable/contested | v3 stable/contested | Δ | Cause |
| --- | --- | --- | --- | --- |
| `honitsu_decision` | 2,540 / 3,535 | 2,527 / 3,523 | −13 / −12 | 25 hands now labelled `chiitoi_vs_toitoi` |
| `riichi_judgement` | 3,184 / 6,141 | 3,182 / 6,139 | −2 / −2 | 3 hands now labelled `sanshoku_pursuit`; 1 state loses its declaration match |
| `dama_bad_wait` | 2,664 / 13,071 | 2,664 / 13,067 | 0 / −4 | 3 hands now labelled `chiitoitsu_riichi_vs_dama` (same answer); 1 state loses its declaration match |

The attribution was measured, not guessed:

- of the 253 ch5.5 labels, **25** also matched `honitsu_decision` under the v2
  rule — exactly the honitsu delta;
- all **3** sanshoku labels also matched `riichi_judgement` under v2;
- **3** seven-pairs labels also match `dama_bad_wait`, with the *same* answer,
  so only the attribution moved (the seven-pairs cell is listed first).

Everything else, including `perfect_one_away`, is unchanged. Total labels went
from 110,382 (v2) to 113,094 (v3): +2,745 from the new lessons, −33 displaced
(25 + 4 + 4), +2,712 net.

## What each recogniser reads (and refuses)

### ch. 7.2 — `chiitoitsu_riichi_vs_dama` (`src/classifier/riichi.rs`)

Reads a six-pairs-plus-two-lone-tiles hand (the draw completed the sixth pair)
and applies ch7:337/345-359:

- waiting on dora → Riichi (ch7:337);
- honitsu/chinitsu seven pairs → dama (ch7:359(b));
- otherwise Riichi when one of the six conditions holds (dealer, tanyao, red
  five waiting for a regular five, suji-trap wait, wait outside 4-5-6, score
  below mangan);
- otherwise the dama cell (non-dealer waiting 4/5/6).

Near-misses refused: a standard tenpai hand (`riichi_judgement`'s boards — the
recogniser needs the seven-pairs shape), the ch. 5.5 1-away shape, and a hand
where the two lone-tile lines disagree about the declaration.

The red-five line is the single-answer variant: when exactly one lone tile is
the hand's red five, only the discard that keeps it is accepted
(`equivalent_tiles` empty), matching the generator. A line whose wait is
furiten or has no live copy is dropped instead of the whole state — the
generator itself lets the *unaccepted* twin sit in the river.

Book-rule correction in the generator: the Riichi branch now rejects a hand that
is honitsu/chinitsu for **any** accepted wait (`board/mod.rs`), because the book
keeps those in dama; without that guard the generator could build a "riichi"
board whose own rule says dama. `DamaReason::Honitsu` was added so the dama
rationale can cite ch7:359.

### ch. 5.5 — `chiitoi_vs_toitoi` (`src/classifier/chiitoi.rs`)

Reads the generator's own shape (four pairs, the drawn triplet, three lone
tiles) and applies the ch5:608-618 box:

- a futile pair (two more copies visible anywhere) → chiitoitsu: discard the
  drawn third copy (ch5:618, "you must stick with chiitoitsu");
- no pair of value tiles, or three or more 3–7 simple pairs → chiitoitsu
  (ch5:611-613);
- otherwise keep the set and discard a lone tile; the three lone tiles are the
  same answer (ch5:603).

Near-misses refused: the six-pair tenpai (ch. 7.2), a three-pair ch. 3 board,
and a draw that did not complete a set. A table with a Riichi or an open hand is
refused — that is the defense family's question.

Overlap with `honitsu_decision`: a 1-away hand can satisfy both the ch. 5.4 flush
plan and the ch. 5.5 pair shape. `honitsu_decision` now declines a table this
recogniser claims (25 labels moved), and it keeps the flush label on a
crossroad-shaped hand this lesson refuses.

### ch. 5.1 — `sanshoku_pursuit` (`src/classifier/sanshoku.rs`)

Reads the floating-sanshoku shape (`x, x+2, x+3` in one suit, the `x..x+2` run
complete in the other two) and the ch5:74 gate:

- a dora (red fives included) or any yaku other than pinfu/sanshoku on any
  tenpai line → discard the float, keep the side-wait pinfu;
- with neither → discard `x+3`, keep the closed wait and chase sanshoku.

The shape finder is the generator's own
(`generator::sanshoku_candidate_shapes`), so construction and recognition cannot
drift. Refused: a tenpai hand without the shape; a table where the side-wait line
is not pinfu, the chase line is not sanshoku on every winning tile, a third
tenpai discard reaches either teaching yaku (two correct answers), or a wait is
furiten.

Overlap: the ch. 7 declaration family reads tenpai hands too, so every ch. 7
recogniser now declines a table this cell claims (3 labels moved; the deferral
also costs one ch7 label on a state the wait-choice cell does not ship).

### ch. 8.4 — `open_hand_defense` (`src/classifier/open_hand.rs`)

Reads Kamicha's last call and the discard thrown after it, from visible
information only (melds, rivers, the human's hand, the dora; never the threat's
concealed hand):

- same-suit chii → the post-chii discard's neighbourhood (same suit, ±2 ranks) is
  the relatively safe zone: the answer is the hand's only neighbourhood tile;
- different-suit chii (the trap) → the neighbourhood is dangerous: the answer is
  the hand's unique 100 % safe tile outside it, and a neighbourhood tile must
  exist to reject.

Refused: the last call not a chii, a discard after a call marked tsumogiri, a
second live threat (that is `defense_multi_threat`), a two-meld threat (ch. 8's
"three or more open sets" shortcut), a ready hand (riichi/dama or sanshoku), a
same-suit board without exactly one neighbourhood tile, a trap without exactly
one safe tile, and a board where another 100 % safe tile (genbutsu, fourth
honour, no-chance) would outrank the read — the generator rejects the same
boards.

Overlap: none on generated boards. The ch. 8.1-8.3 family requires a Riichi
threat, and the multi-threat lesson requires two live threats, so the three are
disjoint (pinned by
`classifier::tests::b4_generated_states_never_disagree_across_lessons`).

## Regenerating this report

```bash
# 1. the classifiers' own gates
cargo fmt --check
cargo clippy --all-targets --features miner -- -D warnings
cargo test --lib
cargo test --features miner --lib

# 2. the label pass (above), then:
scripts/label-yield-report.py \
  --db ~/riichiprac-data/q2-ch8-defense-2026-11/db/miner.sqlite \
  --classifier-version 3 \
  --out testdata/reports/b4-classifiers/label-yield.json
```
