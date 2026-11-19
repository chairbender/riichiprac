# Defense against two or more opponents (ch. 8)

Implementation record for task `261118-1315`: multi-threat defense scenarios.
The shipped lesson is `defense_multi_threat` ("Defense: Two or More Threats").

## What the book says

The ch. 8 lessons that shipped before this one all read **one** threat. The
chapter is explicit that this is not enough when several opponents are live
(`RiichiBook1-ch8-defense.tex`, "Genbutsu and other absolutely safe tiles",
ch8:100–116):

> Genbutsu tiles of player X are 100% safe against X, but not necessarily safe
> against the other two players. … There are three kinds of tiles that are 100%
> safe against all of the opponents.
>
> 1. The tile that was just discarded by your left player.
> 2. A fourth honor tile when there is no possibility of Thirteen Orphans.
> 3. An absolute “no chance” tile.

and the chapter's own footnote:

> a tile discarded by all three of your opponents is safe against all three
> players.

Two further sections matter for the shapes:

- ch. 8.3, "Defense against riichi", is the fold box: a 2-away-or-worse hand may
  push only on Rank B or safer tiles.
- ch. 8.4, "Defense against open hands": *"Assume an opponent has a ready hand
  … They have three or more open sets / runs."* The same section warns that
  suji and blockade theories are "completely useless" against a `toitoi` hand,
  which is why this lesson never counts an open hand's suji rows as safe.

## The lesson

`defense_multi_threat` asks for the safest discard while **every live opponent**
is considered. A live opponent is

- a player in Riichi, or
- an opponent with **three or more open melds** (ch. 8.4's shortcut).

The defender's hand is always at least 2-away, so the question is a complete
fold (the betaori cell), never a push.

Three table shapes are generated, each evenly:

| Shape | Threats | Extra |
| --- | --- | --- |
| `two_riichi` | two Riichi declarations | — |
| `riichi_and_open_hand` | one Riichi + one three-meld open hand | the open hand is real tenpai |
| `three_threats` | two Riichi + one three-meld open hand | — |

The three shapes are all the same question at different table loads: two live
opponents, then the two ways an opponent becomes live, then all three at once.
Rounds, scores and seats are drawn the ordinary way for every shape; the score
line is never part of the answer.

### The answer

The answer is one of ch. 8's three 100%-against-everyone kinds, sampled evenly:

| `AnswerMode` | Answer tile | Why it is safe against everyone |
| --- | --- | --- |
| `fourth_honor` | an honor with all four copies visible | ch8:103 |
| `every_river` | a tile in every live opponent's river | ch8:100 footnote |
| `left_discard` | Kamicha's most recent discard | temporary furiten, ch8:102/106 |

`SafetyFacts::is_certain_safe` is the per-threat test: a tile is certain safe
against one opponent only when all four copies are visible, or the tile is that
opponent's genbutsu (own river, or a post-declaration discard after a Riichi).
This is deliberately stricter than the chart's `is_absolutely_safe`:

- a suji or `kabe` row is a relative argument about **side** waits;
- a `kabesuji` read is not certain either ("dual pon wait and single wait … is
  still possible", ch8:214);
- an open hand may not even have a side wait, so its suji rows are not used.

`MultiThreatFacts` (in `src/safety.rs`) composes the per-threat reads:

```text
certain_safe(tile) =
    tile == left player's last discard
    or every live threat says certain_safe(tile)
```

The *left discard* is table-wide because temporary furiten protects the tile
against every opponent for this turn; nothing else is.

### The trap

Every board keeps a **trap**: a hand tile that is certain safe against one live
opponent but not all of them. On the two-Riichi table it is a number tile in
the first threat's river (safe against that Riichi, live against the other). On
the open-hand shapes it is one of the open hand's real winning tiles, planted
in the Riichi player's river: safe against the Riichi, a live ron for the open
hand. Without the trap, the position would not teach the composition rule, so
the classifier only recognises boards that have one.

## Generation (`src/generator/defense_multi_threat/`)

1. Pick the shape, the threat seats, the trap and the answer — all before any
   random fill.
2. For the open-hand shapes, build a real tenpai hand with three melds: the
   concealed four are a pair plus a protorun, the protorun's wait contains the
   trap, and the three melds are claimed from the seat that plays immediately
   before the open hand, so the calls stay inside the natural rotation.
3. Plan one legal self-turn river timeline (`self_turn_river_plan`) with the
   open hand's calls, at least five discards per seat.
4. Reserve every structural copy in the deck (answer, trap, open melds,
   claimed copies, concealed tiles). Rivers plant the claims where the plan
   says, the trap early in the trap seat's river (so it precedes every
   declaration and cannot become post-riichi genbutsu), and the answer's
   visible copies.
5. Fill the remaining river slots and opponent hands at random.
6. Fill the human hand around the answer and the trap. Each candidate is
   checked against a provisional state through `MultiThreatFacts`: it must be
   Rank B or worse against the opponent who fears it most, and after adding it
   the **only** certain-safe hand tile must still be the answer.
7. Reject the board (retry) unless the finished hand is 2-away or worse, is not
   a winning hand, and the open hand really is tenpai on the trap.
8. `validate_reachable_state` proves the table is a legal, reachable position.

`generate_with_retries("defense_multi_threat", 6_000, ...)` absorbs the rare
rejected draw. Typical runs take single-digit milliseconds per board.

## Classification (`src/classifier/defense.rs`)

`defense_multi_threat` recognises a mined position when:

- the human is on a closed self turn, the hand is 2-away or worse, and not
  agari;
- at least two live threats exist (Riichi, or three-or-more melds);
- exactly one distinct hand tile is certain safe against all of them;
- a trap exists (another hand tile that is certain safe against some threats
  but not all).

The one-threat ch. 8 recognisers now refuse a table with a second live threat:
`sole_riichi_threat` already rejected two Riichi declarations, and `view()` now
also refuses when another opponent has three or more open melds. That closes a
real gap: a riichi plus a three-meld open hand used to be graded as a
single-threat chart board, ignoring the open hand that ch. 8.4 says to treat as
ready.

## Rationale (`src/rationale.rs`)

`multi_threat_rationale` always emits:

- `safe_against_all` — the composition rule, ch8:100;
- the answer's kind — `left_player_discard`, `fourth_honor`, `dead_tile`, and/or
  `every_river`;
- `safety_does_not_compose` — names the trap, the threat(s) that cannot ron it,
  and the threat(s) that can;
- `open_hand_ready` when the shape has an open hand (ch8.4).

Caveats state that the answer is *certain* safety rather than a chart row, keep
the 2-away push line out of it, and note that the left-discard kind lasts one
turn.

## Tests

- `src/generator/defense_multi_threat/board.rs`: each board's constraints, all
  three shapes, all three answer modes, the open hand is real tenpai with a
  claim behind every meld, and repeated generation never repeats a visible
  table.
- `src/safety.rs`: certainty needs every threat to deny the tile; a shared
  genbutsu works; suji and blockade rows are not certain, especially against
  open hands; the left discard is temporarily safe against everyone;
  `worst_rank` takes the most dangerous read.
- `src/classifier/defense.rs`: the lesson recognises its own boards; a
  single-threat board is not this lesson; a second three-meld opponent is not
  the single-threat chart; a 1-away hand is not the multi-threat fold.
- `src/classifier/tests.rs`: the cross-lesson disagreement guards include the
  new recogniser.
- `src/rationale.rs`: the rationale cites ch8's "absolutely safe tiles" section
  and explains the trap.

Run them with:

```bash
cargo test --lib defense_multi_threat
cargo test --lib safety::
cargo test --lib classifier::
cargo test --lib rationale::tests::multi_threat
```

## Not in scope

- The shipped `replay.ch8-defense.2026-11` pack is unchanged. A future replay
  mining pass can now label multi-threat positions with the new classifier.
- The lesson is not in the Tenhou/6 exporter's `EXPORTABLE` allow-list yet. Its
  meld claims are planted and could be exported; that is a separate decision.
