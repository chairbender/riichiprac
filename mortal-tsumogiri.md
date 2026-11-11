# Tsumogiri: river indicator and whether Mortal uses it

Status: implemented (indicator, generator timeline fix, report field); analysis
below.

Tsumogiri is a discard thrown straight off the draw, i.e. the player keeps their
hand and throws the tile they just took. It is the read that a discard "means
nothing" about the hand, so the trainer marks it in the river. This note records
the marker, the generator rule that keeps the flag honest, and whether the
embedded Mortal model actually consumes the signal.

## UI indicator

- `frontend/src/components/PlayerRow.tsx` adds a `river-slot--tsumogiri` class
  and a `title` on any slot whose `DiscardTile.is_tsumogiri` is true. The flag
  already came over the wire from Rust (`src/state.rs`, `DiscardTile`), so only
  rendering was missing.
- `frontend/src/App.css` darkens the tile slightly
  (`filter: brightness(0.72) saturate(0.85)`) and draws a small teal dot in the
  slot's top-right corner. Neither moves the tile, so the 6-per-row river grid
  keeps its size on mobile, and both compose with the existing rotated-Riichi
  and claim-highlight styles.
- `frontend/src/components/TableInfo.tsx` shows a one-line legend ("Tsumogiri
  (straight from the draw)") only when some river on the table contains a
  tsumogiri discard, so boards without one stay uncluttered.

A Riichi declaration tile can be tsumogiri in real mahjong (the drawn tile
leaves the hand tenpai), so the two markers are allowed to appear together. The
defense generator deliberately uses a tedashi declaration tile
(`src/generator/defense/board.rs`), but the encoder accepts either shape.

## Generator: the discard after a call is always tedashi

River tiles are still filler drawn from the wall, so the trainer cannot know
which *other* discards were taken off the draw; those keep the 25% roll in
`discards_from_tiles`. What it can know is the turn structure:

- `src/generator/support/table.rs` now plans rivers with `plan_rivers` /
  `self_turn_river_plan`, returning a `RiverPlan { counts, hand_discards }`.
  `hand_discards` holds the index of each discard made immediately after a call.
- `force_tedashi(discards, indices)` clears the tsumogiri flag at those indices.
  `deal_opponents` and every generator that plans a call now apply it, so a
  player who has just called (chi, pon, daiminkan) always discards from the
  hand. Planned calls are treated as open calls; a kan's replacement draw is not
  modelled, so added/closed kans are unaffected.
- Tests: `plan_rivers` marks the right index for a call before and inside the
  river, `force_tedashi` clears only the listed entries, and the block-theory /
  shouminkan generators assert that the discard after their Pon is never
  tsumogiri.

## Report and submission

- `SubmittedAnswer` (`src/verdict.rs`) gained `is_tsumogiri`. It serializes only
  when true and defaults to false, so existing reports still parse.
  `ReportedAction` is the same type, so report JSON carries it automatically.
- The store (`frontend/src/store/useGameStore.ts`) sets it when the submitted
  discard is the tile in `players[0].draw`; calls and Kan choices never qualify.
  Both book and AI-scenario answer paths use the same helper.
- The plain-text report (`src/report/summary.rs`) and the report banner
  (`describeReportedAction` in `frontend/src/report.ts`) append "(tsumogiri)".
  Grading still compares only the action family and the tile.

## Does Mortal factor it in?

Yes — for the **other players' rivers only**. Mortal v4 encodes tedashi (the
complement of tsumogiri) in three observation planes, and the policy reads them
when judging danger. Verified against the reference checkout at
`/tmp/opencode/mortal` (`libriichi`).

| What | Reference (`libriichi/src/state/obs_repr.rs`) | Our rows (`src/ai/encoder.rs`) |
| --- | --- | --- |
| Opponent river item: +6 is the tedashi flag, +7 is the Riichi flag | `encode_kawa`, lines 736-773 | `encode_opponent_kawa_item`, lines 362-386 |
| Opponent river summary: recency-weighted bags of tile / tedashi / Riichi (`exp(-0.2 * turns_ago)`) | lines 261-277 (v3/v4 branch) | `encode_opponent_rivers`, lines 344-358 |
| `last_tedashis`: each opponent's most recent hand discard as tile / aka / dora | lines 337-351 | `encode_last_discards`, lines 544-565 |

How the flags are produced in the reference:

- `update.rs:311-337` (`dahai`) builds each river item with
  `is_tedashi: !tsumogiri` and refreshes `last_tedashis[actor]` **only when the
  discard is tedashi**, so a later tsumogiri never overwrites the last real
  hand-discard read.
- `action.rs:118-128` derives `tsumogiri` from action legality: the flag is
  only accepted when the discarded tile equals `last_self_tsumo`. The action
  space itself is per-tile, so the model does not choose "tsumogiri vs tedashi"
  as a separate decision; discarding the drawn tile is what makes it tsumogiri.

### What is *not* encoded

The player's own river uses `encode_self_kawa` (`obs_repr.rs:714-734`), which
has four channels: kan tiles, the discarded tile, an aka flag and a dora flag.
There is no tedashi/tsumogiri channel there, and the self summary row
(`obs_repr.rs:222-232`) only bags the tile. So Mortal never sees whether *you*
tsumogiri'd earlier; the signal is purely an opponent read.

Our encoder matches that split exactly: `encode_self_kawa_item`
(`src/ai/encoder.rs:295-312`) writes no tedashi bit, and
`encoder_test.rs::self_river_is_newest_first_and_tedashi_is_flagged` pins it.

### Verification

`encoder_test.rs::opponent_tsumogiri_leaves_the_tedashi_channels_clear` (added
here) asserts for a fixture whose shimocha discards `1s` (tedashi) then `9m`
(tsumogiri) that:

- the `9m` item sets the tile channel but not channel +6;
- the `1s` item sets +6;
- the summary separates them the same way;
- `last_tedashis` stays on `1s` and is not replaced by the tsumogiri `9m`.

Together with the existing Riichi/tedashi test this covers all three planes.

## Consequences for the generator

- Filler rivers still mark `DiscardTile::tsumogiri` at a 25% rate, because the
  trainer does not simulate the wall draw by draw. That is fine for Mortal's
  input (the flag is plausible board texture either way) and no scenario's
  `correct_action` depends on it. The one structural rule the timeline does
  know — the discard after a call is tedashi — is now enforced by `RiverPlan`
  and `force_tedashi`, as described above.
- The report answers now distinguish a tsumogiri submission, but grading and
  Mortal's action space are per-tile, so the flag is analysis metadata rather
  than a correctness criterion.
- Because Mortal ignores the human's own tedashi history, the indicator is
  informative for the learner (it is how the book reads a river) without
  changing any model verdict.
