# Mining the Anki deck for new scenarios

Status: research only. No generator code was written for this pass.

Source deck: `/home/kylehipke/Downloads/Riichi_Book_I__A_Mahjong_Strategy_Primer.apkg`
(Anki 2.0 package: `collection.anki2` SQLite + media; 126 notes, 2 note types,
`Riichi Book I - A Mahjong Strategy Primer` deck).
Reference text: `/home/kylehipke/workspaces/RiichiBooks` (read-only checkout of *Riichi Book 1*).

Every quote below was checked against the `.tex` source by script
(`/tmp/opencode/anki/verify_quotes.py`): 200 quote/line pairs, 0 mismatches.
Line numbers are hints; the quoted needle is what a `Citation::source_needle`
should carry, because the existing drift test
(`rationale::tests::citations_point_at_real_sources`) matches substrings, not lines.

---

## 1. Method

1. Unpacked the `.apkg`, read `notes` from `collection.anki2`, stripped HTML and
   media links, and grouped the 126 cards by their chapter tag (`3`…`9`) and
   section tag (`3.2`, `8.2`, …).
2. For each section, read the corresponding chapter in `RiichiBooks` and pulled the
   itembox/table the cards were written from.
3. Turned each cluster into a *candidate scenario*: the question the app would ask,
   the board constraints, the answer, and — critically — a **machine-checkable
   reason the answer is right**, so the generator can reject every other hand
   instead of trusting a hand-written example.
4. Marked each card as already covered, assigned to a candidate, or explicitly
   not drillable, so nothing in the deck is silently lost (Appendix A).

## 2. Deck shape

| Chapter | Cards | Sections present |
| --- | ---: | --- |
| 3 — Riichi mahjong basics | 31 | 3.2 protoruns (10), 3.3 complex shapes (16), 3.4 waits (5) |
| 4 — The five-block method | 5 | 4.1–4.4 (one each) + 1 general card |
| 5 — Pursuing yaku | 25 | 5.1 sanshoku (8), 5.2 ittsu (5), 5.3 pinfu (4), 5.4 honitsu (6), 5.5 toitoi/chiitoitsu (2) |
| 7 — Riichi judgement | 15 | 7.1 theory (5), 7.2 chiitoitsu/good-wait-vs-score (4), 7.3 dama cases (6) |
| 8 — Defense judgement | 41 | 8.1 push/fold (2), 8.2 defense basics (31), 8.3 vs riichi (4), 8.4 vs open hands (4) |
| 9 — Melding judgement | 9 | 9.1 when not to meld (1), 9.2 exceptions (2), 9.3 kan + misc (6) |

Two clusters dominate and neither is covered today: **8.2 (31 cards)** and
**3.3 (16 cards)**.

## 3. What the app already teaches

| Scenario | Encodes | Deck cards it covers |
| --- | --- | --- |
| `ryanmen_protorun` | ch4 "redundant tile" on an XXY/XYY shape; ch3 side-wait protorun value | 1463190904723, 1463191027124, 1463191128195 |
| `chiitoitsu_riichi_vs_dama` | ch7 chiitoitsu riichi/dama boxes | 1463250985834, 1463251061277, 1464147205450 |
| `shouminkan_decision` / `_decline` | ch9 kakan conditions | 1463256791280 |
| `ai_best_action` | Mortal drill, no book rule | — |

So **4 of 126 cards** are covered outright, plus 3 more that `ryanmen_protorun`
touches at a shallow level and that `protorun_priority` (§5.1) would teach properly.
The general riichi judgement (ch7.1), all of defense (ch8), all of yaku pursuit
(ch5), and meld/call judgement (ch9.1–9.2) are untouched.

One wart worth fixing while adding ch8 citations: `rationale::ch8(needle)`
hard-codes `source_line: 163` and the section "Understanding suji" for *every*
defense citation. ch8 has four sections and 41 cards; a real defense scenario will
need `ch8(§, line, needle)` helpers like the `ch7`/`ch9` ones.

---

## 4. Candidates at a glance

Effort assumes the existing skeleton/board/rejection-sampling architecture;
Value is "how much new teaching surface" per unit of work.

| id | Family | Question asked | Answer type | Book | Cards | Effort | Value |
| --- | --- | --- | --- | --- | ---: | --- | --- |
| `nakabukure_ready` | shape | Bulging float: keep it or break it? | Dama + tile | ch3.3, ch4 | 3 | S | High |
| `protorun_priority` | shape | Ryanmen vs kanchan: which protorun to keep? | Dama + tile | ch3.2 | 6 | S | High |
| `ryankan_break` | shape | Keep the new ryanmen and break the ryankan? | Dama + tile | ch3.3 | 3 | M | High |
| `wind_discard_order` | melding | Which valueless wind first? | Dama + tile | ch9.3 | 1 | S | Medium |
| `pair_count` | shape | Which of three pairs to break? | Dama + tile | ch3.2 | 2 | S | Medium |
| `riichi_judgement` | riichi | General 3-condition Riichi/dama rule | Riichi/Dama | ch7.1 | 7 | M | **Very high** |
| `dama_bad_wait` | riichi | Bad wait, 1–2 tiles left: riichi or dama? | Riichi/Dama | ch7.3 | 1 | M | High |
| `dama_genbutsu_wait` | riichi | Wait is an opponent's genbutsu: riichi or dama? | Riichi/Dama | ch7.3 | 1 | M | High |
| `dama_expensive_hand` | riichi | 7700+ without riichi: riichi or dama? | Riichi/Dama | ch7.3 | 2 | M | Medium |
| `dama_improving_hand` | riichi | Early turn, many improving tiles: riichi or dama? | Riichi/Dama | ch7.3 | 1 | M | Medium |
| `suji_trap_riichi` | defense/offense | Which discard creates the immediate suji trap? | Riichi + tile | ch8.2 | 1 | S | High |
| `fold_to_riichi` | defense | Opponent riichi, my hand is junk: which tile? | Discard + tile | ch8.1/8.2/8.3 | 6 | M | **Very high** |
| `suji_kabe_safety` | defense | Rank the safe tiles by the book's table | Discard + tile | ch8.2 | 27 | M | **Very high** |
| `open_hand_defense` | defense | Read safety from a post-chi discard | Discard + tile | ch8.4 | 4 | M | High |
| `push_or_fold` | defense | 1-away, high value, good wait: push or fold? | Discard + tile | ch8.1 | 2 | M | High |
| `ankan_decision` | melding | Four concealed copies: kan or not? | Kan/Discard | ch9.3 | 2 | M | Medium |
| `meld_or_not` | melding | Pon/chi offered on a cheap, slow hand | Call/Pass | ch9.1/9.2 | 4 | L | High |
| `daiminkan_decision` | melding | Open quad off a discard | Kan/Discard | ch9.3 | 1 | L | Low |
| `pinfu_head` | yaku | Build the pinfu head: which tile not to discard? | Dama + tile | ch5.3 | 3 | M | Medium |
| `sanshoku_pursuit` | yaku | Keep the floating tile for sanshoku? | Dama + tile | ch5.1 | 9 | L | Medium |
| `honitsu_decision` | yaku | Commit to honitsu or play efficiency? | Dama + tile | ch5.4 | 4 | L | Medium |
| `chiitoi_vs_toitoi` | yaku | Futile pair: stick to chiitoitsu? | Dama + tile | ch5.5 | 2 | M | Medium |
| `perfect_one_away` | shape | Which discard makes the hand perfect 1-away? | Dama + tile | ch3.2 | 2 | M | Medium |
| `nobetan_keep` | shape | Keep 3456 at a small acceptance cost? | Dama + tile | ch3.3 | 5 | M | High |
| `protorun_plus_one` | shape | Which protorun-plus-one to break? | Dama + tile | ch3.3 | 3 | M | Medium |
| `skipping_block` | shape | Skipping float vs isolated float | Dama + tile | ch3.3 | 2 | S | Low |


---

## 5. Candidate detail

### 5.1 Shape value (ch3)

#### `nakabukure_ready` — "Keep the bulge, or break it?"

**Cards.** 1463194085883 (definition), 1463194122718 (keep it until 1-away),
1463194188982 ("why not in a ready hand → pair wait on the bulge, only 2 winning tiles").

**Book.** ch3 §"Four-tile complex shapes", *Bulging float (nakabukure)*, plus the
ch4 5-block exercises that keep and break the same shape.

> `Any bulging float shapes from 2334 through 6778 can accept four kinds of tiles to produce a side-wait protorun and a complete run.` — ch3:681
> `Try to keep a bulging float shape until a hand becomes 1-away.` — ch3:708
> `Although doing so increases tile acceptance temporarily, the hand will be filled with closed-wait protoruns. Alternatively, you should discard {\LARGE\suo{8}} to maintain the bulging float shape.` — ch3:690
> `We should rather discard {\LARGE\wan{4}} to wait for {\LARGE\bei}.` — ch3:702
> `we should keep two {\LARGE\tong{4}} to maintain the bulging float block in {\jap pinzu} (dots) for now, hoping to get two runs out of it. We should thus discard {\LARGE\suo{2}}.` — ch4:694
> `As we drew another {\LARGE\wan{1}}, the block in {\jap manzu} (cracks) is now a decent shape. ... Therefore, we should discard {\LARGE\tong{4}} to break the bulging float shape.` — ch4:725

The book never says "always discard the bulge". It says keep it while the hand
is far from ready (ch3:690, ch4:694) and drop it once the ready-hand wait is too
small (ch3:702) or once a rival block has become a decent group-plus-head shape
(ch4:725). The drill therefore draws one of three hands:

| Variant | Hand | Answer |
| --- | --- | --- |
| `ReadyDrop` | ready hand, open Yakuhai Pon, bulge + floating honour | the bulge tile |
| `OneAwayKeep` | 1-away, closed; rival block is a pair + float | a rival pair's tile (bulge stays) |
| `OneAwayBreak` | 1-away, closed; rival block is two pairs + float | the bulge tile |

**Prompt.** Which tile do you discard?

**Generation.** Every variant constructs the bulge `x,x+1,x+1,x+2` in a suit of
its own (x = 2..=6, the book's 2334–6778 range) and randomises the other blocks.
1-away variants build the book's ch4 block shapes (`1m3m5m5m` and `1m1m3m5m5m`
generalised to any suit/base) so the rival block has the same character as the
book's. Rejection then checks the book's arithmetic on the finished hand.

**Verification.**
- `ReadyDrop`: both candidate discards leave tenpai; the bulge discard waits on
  the lone honour with exactly three live copies, the keep discard on the bulge
  tile with two. `calculate_ukeire` alone decides it.
- `OneAwayKeep`: the hand is 1-away and holds exactly one bulge; the book's
  discard leaves the bulge intact and is the best bulge-preserving discard by
  acceptance; breaking the bulge also leaves 1-away and accepts **strictly
  more** tiles. Counting acceptance alone therefore gives the wrong answer.
- `OneAwayBreak`: the hand is 1-away; the bulge discard breaks the float and
  accepts strictly more tiles than any keep-the-bulge discard; at least one
  keep-the-bulge discard exists.

**Why the mix matters.** The drill used to answer "the bulge tile" every time,
which let the player pattern-match the shape instead of judging the hand. Now
roughly a third of hands keep the bulge, and the rationale panel switches
between the ch3:702, ch3:690/ch4:694, and ch4:725 rules with the hand.

---

#### `protorun_priority` — "Ryanmen before kanchan"

**Cards.** 1463190904723 (8/4/4 acceptance), 1463191027124 (ranking),
1463191128195 (closed beats edge because it can evolve), 1463191427816
(`35,46,57 > 13,24,68,79`), 1463191196671 (tile versatility).

**Book.** ch3 §"Protoruns", the value-ranking and versatility boxes.

> `As we can see in the table, a {\bf side-wait} ({\jap ryanmen}) protorun can accept twice as many tiles as a {\bf closed-wait} ({\jap kanchan}) protorun or an {\bf edge-wait} ({\jap penchan}) protorun can.` — ch3:205
> `side wait > closed wait > edge wait` — ch3:230
> `35, 46, 57 > 13, 24, 68, 79` — ch3:263

**Drill.** 1-away hand holding one side-wait protorun and one closed-wait protorun,
plus a redundant tile. Which tile do you discard?

**Answer.** The tile that breaks the closed-wait protorun.

**Verification.** Enumerate all 14 discards that keep 1-shanten; require the book's
discard to have strictly the highest `ukeire.total_count`, and require the discard
to leave the side-wait protorun intact (i.e. its two tiles still in hand and still
on a side-wait completion). Ties are rejected, so the answer is never a coin flip.

**Note.** This is where the app currently has *only* the XXY duplicate case. Adding
this covers the acceptance-table reasoning properly instead of one shape.

---

#### `ryankan_break` — "Break the double closed shape"

**Cards.** 1463192521881 (definition), 1463192693530 (2 kinds–8 tiles),
1463192695124 (why it gets worse as the hand gets ready).

**Book.** ch3 §"Double closed (ryankan) shape".

> `When two closed-wait protoruns are combined, we have a {\bf double closed} ({\jap ryankan}) shape.` — ch3:477
> `Each shape accepts as many as 2 kinds--8 tiles.` — ch3:483
> `Double closed shapes are particularly useful when a hand is relatively far from ready (2-away or worse).` — ch3:505
> `it will ultimately become a single closed-wait protorun when this block remains incomplete when the hand is ready.` — ch3:506

The decisive rule is the next paragraph, which is a *direct discard instruction*:

> `when we draw a tile next to the head, creating a side-wait protorun, we should keep it and break the double closed shape instead` — ch3:523

**Drill.** 1-away hand holding `135p`; the draw is a tile next to the head that
creates `45p`. Discard a ryankan tile.

**Answer.** The ryankan terminal (`1p`), keeping both the new ryanmen and the
possibility of `24p`.

**Verification.** Three checks, all mechanical: (a) after the discard the hand is
still 1-shanten; (b) among the ukeire tiles at least one completes the new ryanmen
(so the side-wait survives); (c) discarding instead from the new ryanmen leaves a
hand whose completions are all closed/edge waits. (c) needs the completion
enumeration helper also used by `perfect_one_away`.

**Why it matters.** The deck spends three cards on this and it is the one shape rule
the book states as a *command* ("keep it and break the double closed shape"), which
makes it a better grading target than the ryankan's raw acceptance (8 tiles, which
naively looks good).

---

#### `pair_count` — "Two pairs, not three"

**Cards.** 1463191498526 (2 pairs > 1 pair, 4 pairs > 3 pairs),
1463192072762 (3 pairs > 2 pairs *when you intend to pon*).

**Book.** ch3 §"Pairs and sets".

> `we should avoid having three pairs in a hand` — ch3:336
> `2 pairs > 1 pair, 4 pairs > 3 pairs` — ch3:343
> `When we intend to call {\jap pon}, having three pairs is actually better than having two pairs.` — ch3:351

**Drill (closed variant).** 2-away hand with three pairs and a protorun; which pair
to break?

**Verification.** Ukeire comparison: keeping three pairs by discarding from the
protorun must lose more acceptance than discarding from the pair. The book even
does the arithmetic (`2 - 8 = -6`), so the oracle is exactly `ukeire_total`.

**Open variant (nice flip).** Same hand, but one pair is a dragon that an opponent
has just discarded, so a Pon is imminent. The book answer **inverts**: keep three
pairs. That flip is a great teaching moment and needs only a `pon_planned` flag on
the skeleton plus the existing `daiminkan`/call plumbing — or, without call UI,
state it in the prompt and grade the discard. Worth doing as `pair_count_open`.

---

#### `perfect_one_away` — "Make it perfect"

**Cards.** 1463192202158, 1463192282618 (definitions of perfect 1-away / 2-away).

**Book.** ch3 §"Perfect n-away".

> `When a 1-away hand has two side-wait protoruns and two pairs, it is called {\bf perfect 1-away}.` — ch3:382
> `no matter how a hand becomes ready, you will \emph{always} have the option to choose side wait as the final wait` — ch3:389

**Drill.** 1-away hand where one discard yields a perfect 1-away and another yields
a slightly higher raw acceptance but a non-perfect shape.

**Verification.** Structural: after the book's discard, decompose the hand's
1-shanten shape into exactly two side-wait protoruns + two pairs + completed sets.
The competing discard must either fail that decomposition or produce a lower
"best-case final wait" (checked by enumerating completions and looking for a
ryanmen wait).

**Risk.** Needs a shape decomposer for 1-shanten hands (agari gives shanten and
ukeire, not block partitions). Medium effort; the rule is crisp once built.

---

#### `nobetan_keep` — "Keep 3456 even at a small cost"

**Cards.** 1463193147898, 1463193166572, 1463193567734, 1463193918897, 1463193992139.

**Book.** ch3 §"Stretched single (nobetan)".

> `Try to keep a stretched single shape if a hand has one. In particular, 3456 and 4567 should be kept until the hand becomes ready or 1-away from ready.` — ch3:669
> `discarding {\LARGE\wan{3}} or {\LARGE\wan{6}} would lead to the greatest tile acceptance` … `However, doing so is too myopic.` — ch3:662
> `the middle two ones --- 3456 and 4567 --- are the most versatile` — ch3:649

**Drill.** 2-away hand holding `3456` where the maximum-acceptance discard breaks the
nobetan and the book's discard keeps it.

**Answer.** The discard that keeps the stretched single.

**Grading mode.** This is the one cluster where the book prefers *lower* tile
acceptance, so ukeire cannot be the oracle. It is graded on book authority, which we
have decided is acceptable. The oracle is a **completion enumeration**, not a raw
count, so the answer is still provable per hand:

1. Enumerate every ukeire tile for the book's discard and for each rival discard.
2. For each, enumerate the following discard and compute the resulting tenpai waits.
3. Require that the rival (max-acceptance) line can only reach a closed, edge, or
   pair wait, while the nobetan line can always reach a ryanmen wait.
4. Reject the hand if the rival line can also reach a ryanmen wait — then the book's
   claim does not hold for that hand and the drill would be genuinely ambiguous.

Step 3 is exactly the book's argument ("all the remaining protoruns will be
closed-wait or edge-wait ones"), and it is the same enumerator `ryankan_break` and
`perfect_one_away` need, so build it once in `support`.

**Rationale note.** Because the answer contradicts `ukeire_total`, the explanation
must show *why* (the wait-quality consequence) and not merely assert the rule, or a
player who did the arithmetic will feel cheated.

---

#### `protorun_plus_one` / `skipping_block`

Lower value duplicates of the same "which block to break" family; both are
provable by ukeire. Cards 1463192845266/1463192901441/1463192939504 (protorun plus
one, ch3:545 `A protorun plus one can accept two additional tiles that an isolated protorun cannot.`,
ch3:574 `When choosing between which protoruns plus one to break, priority should be given to the weaker one.`)
and 1463194258219/1463194377641 (skipping, ch3:713
`{\LARGE\wan{3}} in a skipping shape is more valuable than isolated {\LARGE\wan{3}}`).
Build only if the shape family proves popular.

---

### 5.2 Five-block method (ch4)

The two ch4 cards that matter are already the *principle* behind `ryanmen_protorun`:

> `Identify five tile blocks in a hand. Try to make sure:` … `there is no block that is too weak; and` … `each block has at most three tiles.` — ch4:55–61
> `tile efficiency;` / `hand value;` / `the safety of tiles to be discarded.` — ch4:342–344

Rather than a separate `five_block` scenario, I recommend **retitling the coverage**:
`ryanmen_protorun` already implements ch4's "redundant tile" idea. A general
`five_block_redundant` lesson (any 4-tile block with one redundant tile) would be a
refactor of that generator, not new content. `1463199372706` (three selection
criteria) is genuinely multi-criteria — an answer depends on board read (safety),
which the app cannot prove — so leave it as rationale prose, not a graded drill.

---

### 5.3 Yaku pursuit (ch5)

These are all *strategy* instead of *shape* lessons: the answer depends on how much
future value a block might produce. They are buildable but each needs an
enumerator over possible completions and a yaku/score check. Ranked by
cost-effectiveness:

**`pinfu_head`** — cheapest. Cards 1463246915402, 1463246941631, 1463247110997,
1463247167615.

> `To claim {\jap pinfu}, the head must be a pair of number tiles or valueless wind tiles.` — ch5:449
> `the value tile {\LARGE\fa} cannot be the head of {\jap pinfu}` — ch5:458

Drill: hand with no pair yet, holding a value honor plus terminals/valueless winds.
Answer: discard the value honor (it can never be the pinfu head). Verification is
structural (which single tiles can legally become the pinfu head), not score-based.
Cheap and exact.

**`chiitoi_vs_toitoi`** — medium. Card 1463247702867, 1463250507888.

> `If there is one or more futile pair in your hand, you must stick with {\jap chiitoitsu}.` — ch5:618
> `There are three or more pairs of simple tiles between 3 and 7 in your hand.` — ch5:613

Drill: 1-away chiitoitsu where one pair just became a set. Answer: keep the pair
(chiitoitsu) if any pair is dead (4 visible), otherwise build toitoi. Verification:
visible-count check on each pair — fully mechanical.

**Implemented.** `src/generator/chiitoi_vs_toitoi/` deals the book's own
`77m 88m 1p 333p 55s 7s EE S` shape: four pairs, the triplet the draw completed,
and three lone tiles. `skeleton::Variant::FutilePair` puts both remaining copies
of one pair in two opponents' rivers (all four visible), so the answer is the
drawn third copy; `Variant::BuildToitoi` leaves every pair live but gives the
hand a dragon pair, so the answer is a lone tile. The skeleton proves both
answers with `agari`: the chiitoitsu discard restores five pairs and waits on
three lone tiles (nine tiles), while the toitoi discard keeps the set and waits
on two (six), so raw acceptance prefers the wrong move on purpose. The board
re-derives the dead pairs from the finished payload (`board::validate`), and
`rationale::chiitoi_vs_toitoi_rationale` cites ch5:611/612/613/618/621, listing
the chiitoitsu criteria that do not hold in the "Not this hand" section on the
toitoi branch.

**`honitsu_decision`** — medium/large. Cards 1463247212821…1463247652943.

> `we should consider two factors --- five-block potential and hand values with and without {\jap honitsu}` — ch5:468
> `when the hand value is sufficiently high ($\geq$ 5200) \emph{without} {\jap honitsu}, you should not go for {\jap honitsu}` — ch5:517
> `you should not aim for {\jap honitsu}; you should try to make the hand ready without melding and go for riichi` — ch5:506

Answer = commit (discard off-suit) or not. Verification: value of the hand with and
without honitsu (score enumeration) plus a block-count check in the target suit.
The "discard all of one suit first so opponents can't read you" card
(1463247587777, ch5:543) is a multi-turn behaviour, not a single decision — keep it
as rationale text only.

**`sanshoku_pursuit`** — large. 8 cards. The gating rule is repeated three times in
the book: only chase the yaku when the hand has *no other yaku or dora*
(ch5:74, ch5:129), and never step back to 2-away to switch (ch5:110). Buildable,
but needs a yaku-enumeration oracle.

**Implemented.** `src/generator/yaku/sanshoku_pursuit/` rebuilds the book's
second floating hand: after drawing `5s`, `3m5m6m 345p 345s 789s 11s` is tenpai
with an extra tile, and the player chooses between the closed-wait `345`
sanshoku (discard `6m`) and the side-wait pinfu (discard `3m`). The skeleton
generalizes over the three suits and the run values `234`–`567`, and splits the
three gate cases:

| Half | Shape | Answer |
| --- | --- | --- |
| `NoOtherValue` | terminal pair + `789` extra run, no dora | Chase: discard `x+3` |
| `Dora` | the same shape with a dora on the completed run | Efficiency: discard `x` |
| `Tanyao` | all-simple pair + `678` extra run, no dora | Efficiency: discard `x` |

`support::yaku::discard_lines` enumerates every tenpai discard, every winning
tile and every yaku reading, so the skeleton proves the two candidate lines
without a hand-written score table: the efficiency line is pinfu-only, the
chase line is sanshoku-only (closed wait), no third discard reaches either
yaku, and the gate turns on exactly the dora / tanyao / other-yaku presence the
book names. `rationale::sanshoku_rationale` recomputes the same gate from the
finished state and cites ch5:62 (floating), ch5:74 (the gate), ch5:110
(no step back to 2-away), and ch5:129 (the double-closed companion).

**`ittsu_vs_side_wait`** — do **not** build as graded. The book itself weighs the two
by acceptance and then argues about melding:

> `Even though the kinds and the number of acceptable tiles are smaller, the second option would be more efficient if we take melding into account.` — ch5:393

That answer depends on whether calls are legal/available, which the app cannot
prove locally. Good rationale material for a future call lesson, poor grading target.

---

### 5.4 Riichi judgement (ch7) — the biggest rules gap

The app only ever asks the chiitoitsu version of this question. The general rule is
four cards and one box away:

> `Choose riichi over {\jap dama} if \underline{\large at least one} of the following three conditions is met.` — ch7:55
> `Your hand has at least one {\jap han} other than riichi.` — ch7:57
> `Your hand has a good wait.` — ch7:58
> `You are the dealer.` — ch7:59
> `the only type of riichi that these criteria prohibit is a bad-wait riichi-only hand by a non-dealer` — ch7:71

**`riichi_judgement`** is the single highest-value candidate in this document: it
generalises the one decision the app already grades well (from chiitoitsu to all
standard hands) and accounts for the ch7.1 cards plus the dealer/wait/han logic that
`RiichiTrigger` already models. Answer type `Riichi`/`Dama` already exists.

Verification: compute han-without-riichi at the *worst* winning tile (the existing
chiitoitsu generator already has this pattern in `scoring.rs`), classify the wait
as good/bad per ch7:491
(`a wait is said to be good if there are at least two kinds and more than four tiles left to win on`),
and check the seat wind. Then assert the expected action matches the 3-condition
rule.

The four sub-lessons the deck calls out, each a specialisation:

| id | Rule to encode | Card, quote |
| --- | --- | --- |
| `dama_bad_wait` | Riichi if ≥3 winning tiles left; dama at 1–2 simples (honor/terminal wait still riichi) | 1463251214364, ch7:521–522 |
| `dama_genbutsu_wait` | Dama when a winning tile is the threatening player's genbutsu | 1463251466860, ch7:539 / ch7:558 |
| `dama_expensive_hand` | 7700+ minimum without riichi ⇒ dama OK; also "haneman+ ⇒ don't riichi" | 1463251519343, ch7:569 / ch7:598 / ch7:646 |
| `dama_improving_hand` | Early turn (≤8) + ≥6 improving kinds (or one +3-han step) ⇒ dama | 1463251634384, ch7:656–660 |

`dama_bad_wait` is especially valuable because it is the *only* case the general
rule forbids, and the book gives a countable threshold (live winning tiles), which
the app can compute exactly.

---

### 5.5 Defense (ch8) — the largest content gap

41 cards, zero coverage. The chapter is unusually well specified, which makes it
ideal for CSP generation: the safety of a tile is a **total order over a finite
table**, not a judgement call.

#### `fold_to_riichi` — flagship defense drill

**Cards.** 1463251851184, 1463251902123 (push/fold conditions), 1463251955444,
1463252064018, 1463252072584 (genbutsu and 100 % safety), 1463254499575 (safety
table), 1463254667324 (defense-against-riichi box), 1463255088593 (what to discard
when stuck), 1463254363324 (same-letter ranks are close).

**Book.** ch8 §8.1 "A simple principle", §8.2 genbutsu, §8.3 "Defense against riichi".

> `{\large Fold} if {\bf two} of the following conditions are met:` — ch8:31
> `1-away (or worse) hand;` `Low scoring hand;` `Bad wait.` — ch8:34–36
> `If you cannot satisfy the above criteria, you must completely fold ({\jap betaori}).` — ch8:340
> `Do not discard {\bf Rank D} tiles against an opponent's riichi until your` — ch8:334
> `There are three kinds of tiles that are 100\% safe against all of the opponents.` — ch8:100
> `The tile that was just discarded by your left player.` — ch8:102
> `100\% & {\jap Genbutsu} \\` — ch8:301

**Drill.** One opponent has declared riichi. My hand is 1-away-or-worse, has no
value, and has a bad wait. Which tile do I discard?

**Answer.** The strictly safest tile: genbutsu if available, else the best rank on
the book's table.

**Generation.**
1. Build a human hand that is 2-away or worse (`shanten >= 2`) with `< 5200` value
   and no yaku, so all three fold conditions hold.
2. Pick a riichi opponent; give it a river with the declaration tile marked
   (`DiscardTile::riichi`, `riichi_discard_index`).
3. Plant exactly one tile that is 100 % safe (in the opponent's river, or kamicha's
   latest discard) and no other 100 %-safe tile.
4. **The answer tile must be part of a block** — a completed set, a pair, a run, or
   a protorun. Discarding it has to break something the hand could use, so the move
   visibly reads as folding rather than as an ordinary efficiency discard. Reject
   hands where the safe tile is an isolated floating tile or a lone honor.
5. Make the temptation real: every rival discard that *keeps* the shape must be
   strictly more dangerous than the answer.
6. Reject unless the answer is the *unique* best rank (ties mean the drill has two
   right answers) and the opponent's river is deep enough that the suji reading is
   stable (a 1-discard river makes almost nothing suji).

Step 4 has a pleasant side effect: it rules out the degenerate "the safe tile is a
dead honor I was never going to keep" hand, and it means a genbutsu answer is
usually a *pair* of a discarded honor sitting in the hand as the head.

**Verification.** A small `safety` module implementing ch8's table; assert the
answer tile's rank is strictly better than every other hand tile's rank, and assert
the answer tile shares a block with at least one other hand tile. Ties ⇒ re-roll.
This is the key design point: the *table* is the oracle, not a heuristic.

**Answer type.** A plain discard — **no new vocabulary**. The answer is the same
shape the ryanmen lesson already uses: click a tile, declare nothing. Two existing
carriers fit, and both already flow through `store.selectTile`:

- `CorrectAction::Dama { discard }` needs zero code changes (the store submits
  `dama` by default for non-Kan lessons), but the report line reads "Dama,
  discarding 3p", which is factually wrong for a 2-away hand.
- `CorrectAction::Discard { tile }` is the honest carrier — "discard, no call". Its
  wording is currently Kan-specific, in four places:
  `rationale::action_type_label` ("No Kan"), `report/summary.rs::describe_correct_action`
  and `describe_reported_action` ("Pass on the Kan and discard X"), and the frontend's
  `AnswerSummary.bookPick` ("No Kan, discard X"). Neutralise them to "Discard" /
  "Discard X". The only side effect is that `shouminkan_decline` feedback reads
  "Discard X" instead of "Pass on the Kan and discard X"; its prompt still says
  "Call Shouminkan, or discard?".

Recommendation: the second — four strings for a truthful report.

---

#### `suji_kabe_safety` — "Rank the safe tiles"

**Cards.** 27 of the 31 cards in 8.2 (the other four belong to `suji_trap_riichi`
and `fold_to_riichi`) — the suji definition and six intervals
(1463252155557, 1463252227416, 1463252322747, 1463252443086, plus the six
"when X is genbutsu" cards), suji reliability (1463253075169), kabe
(1463253121175 … 1463254032664), double one chance (1463253482504), the
blockade-vs-suji table (1463254149980, 1463254335887), and the alphabet table
(1463254499575, 1463254363324).

**Book.** ch8 §8.2.

> `No chance $>$ Double one chance $>$ One chance (earlier turns) $>$ One chance (later turns) $\simeq$ Non-{\jap suji}` — ch8:263
> `BBB & {\jap Suji} 4,5,6; No-chance tile` / `BB+ & {\jap Suji} 2, 8` / `D & Non-{\jap suji} 4,5,6` — ch8:307–315
> `Non-{\jap suji} 4,5,6 tiles are the most dangerous because they can be caught by two different {\jap suji} waits.` — ch8:325

**Drill.** Same board shape as `fold_to_riichi`, but the safest tile is a *suji*
or *no-chance* tile rather than genbutsu, so the player must use the table rather
than the freebie.

**Answer.** The unique highest-ranked tile.

**Verification.** Same `safety` module, plus the same "answer is part of a block"
generation rule as `fold_to_riichi`. Generation must additionally require the
answer to be a suji/no-chance tile and the runner-up to be one rank worse, so the
lesson is specifically about the ranking.

**Implementation note.** Treat this as the second mode of one module (like
`shouminkan_decision` / `shouminkan_decline`): `fold_to_riichi` is "answer is
genbutsu", `suji_kabe_safety` is "answer is suji/kabe". They share the board, the
skeleton, the block constraint, and the ranking.

A useful consequence of the block constraint here: a suji tile that is part of a
protorun (e.g. `4m` in `34m`) is exactly what you must break to fold, and its
danger is obvious from the shape you lose.

---

#### `open_hand_defense` — "Read the post-chi discard"

**Cards.** 1463255367640 (when to assume ready), 1463255468847 (estimate value),
1463255593155 (dangerous tiles from melds), 1463255694221 (the chi-discard rule).

**Book.** ch8 §8.4, "Discard upon chii".

> `{\jap chii} $\rightarrow$ discard a tile in the same suit \\` — ch8:567
> `$\Rightarrow$ the neighborhood of the last discard is {\large safe}` — ch8:568
> `{\jap chii} $\rightarrow$ discard a tile in a different suit \\` — ch8:569
> `$\Rightarrow$ the neighborhood of the last discard is {\large dangerous}` — ch8:570
> `{\jap pon} \\` — ch8:571
> `$\Rightarrow$ wait can be anything` — ch8:572

**Drill.** An opponent with three open melds has just chi'd and discarded a tile in
the *same* suit. Which tile is safest from my hand?

**Answer.** A tile in the neighbourhood of that post-chi discard.

**Verification.** Structural: the answer tile is within ±2 ranks of the opponent's
last discard, in the same suit; every alternative is outside that neighbourhood.
Generate the *different-suit* variant as the trap so the player cannot just pick
"'near their last discard' blindly". The answer should again be part of a block, so
the fold is visible rather than an incidental float.

This is the most "board-reading" drill in the deck and needs no scoring oracle.

---

#### `push_or_fold` — binary version

**Cards.** 1463251851184, 1463251902123 + ch3 1463192202158 (perfect 1-away).

> `{\large Push} if {\bf two} of the following conditions are met:` — ch8:23
> `We say a hand is a high scoring one if the minimum hand value is 7700` — ch8:65
> `wait is good if it is at least as good as stretched single or semi side wait` — ch8:68
> `Pushing with a 1-away hand is acceptable only when` — ch8:62

**Drill.** 1-away hand with high value and a *perfect* 1-away shape (so the
best-possible wait is good), opponent in riichi ⇒ push. Mirror it with a low-value
closed-wait hand ⇒ fold.

**Answer.** Push (discard the tile that keeps the shape) or Fold (discard the
safest tile).

> `Notice that this is a perfect 1-away hand; no matter how this hand becomes ready, you can \emph{always} choose to have a side wait.` — ch8:77

**Cost.** Low on the answer side: there is no `Push` answer to invent, because the
clicked tile *is* the decision — the shape-preserving discard is pushing, the safest
discard is folding. Both are ordinary discards.

The real cost is generation. The hand must meet exactly two of
{ready, high value (≥7700 minimum), good wait} for the push branch, or two of
{1-away or worse, low value, bad wait} for the fold branch, and the rival branch has
to be provably rejected. The awkward part is "good wait" on a non-ready hand: the
book judges it by the *best possible* wait in the *worst* case (ch8:77), which needs
the completion enumerator from `perfect_one_away`.

---

#### `suji_trap_riichi` — offense through a defense concept

**Cards.** 1463253028848 (suji trap), 1463251061277 (already a `RiichiTrigger`).

**Book.** ch8 §"Suji trap"; the app already cites this definition in
`rationale.rs` for `RiichiTrigger::SujiTrap`.

> `we say you have a {\jap suji}-trap wait` — ch8:165
> `If you call riichi by discarding the {\LARGE\wan{6}}, the hand waits for {\LARGE\wan{3}}, which is a {\jap suji} tile of {\LARGE\wan{6}} (immediate {\jap suji}-trap riichi).` — ch8:170

**Drill.** Tenpai hand where discarding tile A waits on a plain tile and discarding
tile B creates an immediate suji trap. Answer: Riichi, discarding B.

**Verification.** After B, the wait tile must be exactly ±3 from B (same suit), B is
not otherwise the unique tenpai discard, and the alternative discard yields a
non-trap wait with the same or fewer winning tiles. Cheap: answer type `Riichi`
already exists.

---

### 5.6 Melding (ch9)

**`wind_discard_order`** (cheap, no new machinery). Cards 1463256990069, 1463256846829.

> `When discarding valueless wind tiles, discard the right player's wind first, then the facing player's wind next.` — ch9:455

Drill: first turn, hand holds two or three valueless winds. Answer: the shimocha's
wind. Verification: pure seat-wind arithmetic. Excellent filler lesson and it
exposes the seating model the report already tracks.

**`ankan_decision`** (medium). Cards 1463256548176, 1463256655221.

> `In principle, your hand needs to be close to ready to justify making a concealed quad.` — ch9:269
> `1-away, where at least one block has a good wait;` / `2-away, where all the blocks have a good wait;` — ch9:233–234
> `one of the four tiles can be used a good floating tile;` — ch9:282

Close sibling of `shouminkan_decision`, same answer family (`Kan`/`Discard`). The
only plumbing gap: `findKanCandidateTile` in the frontend only detects an open Pon;
an Ankan needs four concealed copies. Small, bounded change.

**Implemented.** `src/generator/ankan_decision/` builds one neutral question and
splits it 50/50 before rejection sampling:

| Half | Shape | Answer |
| --- | --- | --- |
| `OneAwayGoodWait` | honor quad + complete run + honor pair + one side wait + one closed wait + dead honor floater; the book's example (1) | Kan |
| `TwoAwayAllGoodWaits` | honor quad + honor pair + three side waits + two dead honor floaters; example (3) | Kan |
| `FloatingTileDecline` | 4-or-6 middle-tile quad + pair + bulging float + run + lone tile; the book's `4444m 88m 4567p 456s 8s` box | Discard the lone tile |

The quad is an honor in the Kan halves (its fourth copy is dead) and a middle
tile in the decline half (its fourth copy still accepts 2/3/5/6 around 4m), so
the coin flip is the only thing that differs between the two answers. The
skeleton verifies the post-quad shanten with `agari` and, for the decline, that
keeping the four copies accepts the floating copy's protoruns while the quad
line accepts none of them; `rationale::ankan_rationale` recomputes both numbers
from the state and cites ch9:269 / 233–234 / 282 / 313. `findKanCandidateTile`
now also reports four concealed copies, and the Kan toggle is gated on
`target_action === 'Kan'` so an ordinary hand that happens to hold a quad is
never offered the call.

**`meld_or_not`** (large, high value). Cards 1463255782615, 1463256320218, 1463256486957.

> `Melding with a cheap \emph{and} slow hand is one of the two biggest sins in riichi mahjong.` — ch9:30
> `Don't meld with a cheap and slow hand!` — ch9:72
> `If you can eliminate a bad wait and make the hand ready, meld!` — ch9:134

The book calls this one of the two biggest sins, and the deck has only three cards
because it is a single decision. It needs a **call decision for book lessons**: today
the call/pass buttons are rendered only for AI scenarios (`availableActions`), so a
book lesson needs `DecisionContext::ReactToDiscard` plus a Pass answer type. Do it
once and it unlocks `daiminkan_decision`, the pon-seating tips, and the sanshoku
"melding makes it efficient" argument.

**`daiminkan_decision`** — lowest priority of the kan family; same UI cost as
`meld_or_not` for one card.

**Implemented.** `src/generator/daiminkan_decision/` deals the book's own shape
— a called run (chi), a concealed run, an honor pair, a two-tile protorun and
three concealed dragon copies — and has the player's right-hand player discard the
fourth copy. One neutral call ("Call the Kan, or pass?") is split 50/50 before
rejection sampling, so the prompt never hints the answer:

| Half | Shape | Table | Answer |
| --- | --- | --- | --- |
| `GoodWaitValue` | ready, side wait, 2000 points (chun + one dora) | even scores | Kan |
| `CheapGoodWait` | ready, side wait, 1000 points (chun only) | South-4, 2nd/3rd, gap inside the quad's 1000→1300 | Kan |
| `CheapGoodWait` / `BadWaitValue` | the same cheap hand, or the 2000-point hand on a bad wait | fourth, >12,000 behind third | Kan |
| `BadWaitValue` | ready, edge/closed wait, 2000 points | even scores | Pass |
| `CheapGoodWait` | ready, side wait, 1000 points | even scores | Pass |

The three Kan rows are exactly the book's three situations (ch9:323–325); the
two Pass rows are its two refusal boxes (ch9:350, ch9:358). `agari`'s scorer
measures the hand before and after the quad (`value.rs`), so the rationale
states real points — 2000→2600 and 1000→1300, i.e. the book's minipoint
argument without inventing the quad's new dora — and the placement gap is drawn
from that same window. `rationale::daiminkan_rationale` recomputes everything
from the state, and the frontend renders the offer as a **Kan** button beside
**Pass** (`call_offer.action == "Kan"`, graded as `kan` with the offer's tile).
The lesson is a `TargetAction::Call` board rather than `Kan` because its decline
answer is a pass, not a discard.

---

## 6. Rejected or deliberately deferred

| Idea | Why not (yet) |
| --- | --- |
| `honitsu` discard ordering (1463247587777) | Serial behaviour across turns ("discard all of one suit first", ch5:543). Cannot be graded from one decision. |
| "Defend when ahead / attack when behind" (1463255264912, 1463255328253) | Position/turn modifiers, not a tile choice. Better encoded as extra triggers on `push_or_fold` than as its own lesson. |
| Five-block "three criteria" selection (1463199372706) | Answer depends on board read + safety judgement; no mechanical oracle. Keep as rationale. |
| Wait taxonomy (1463194454726, 1463194687613, 1463194733126, 1463194761013, 1463194883251) | The five basic waits and the irregular-wait tables are the vocabulary the riichi/dama wait-quality tests need (§5.4); they are not a decision on their own. |
| `ittsu_vs_side_wait` | The book's own answer depends on melding (ch5:393). Not locally provable. |
| Kokushi / thirteen orphans | No cards in the deck. Out of scope. |
| "Which tile to call on" (1463247652943) | Requires a reaction/call UI and a multi-way call choice; superseded by `meld_or_not` as a first step. |

## 7. Recommended build order

1. **`nakabukure_ready`** — smallest possible new lesson; ukeire oracle; same answer
   type and board scaffolding as the existing ryanmen lesson.
2. **`protorun_priority`** — same machinery, covers the ch3.2 value table the deck
   spends 5 cards on.
3. **`riichi_judgement`** — biggest gap in an *already supported* answer type; the
   scoring plumbing exists in the chiitoitsu generator.
4. **`wind_discard_order`** — tiny, and it validates seat-aware generation.
5. **`nobetan_keep`** — first lesson graded on book authority over ukeire. Building it
   forces the completion enumerator (best possible final wait) that steps 6–7 need,
   so it is the right place to pay for it.
6. **`fold_to_riichi`**, then **`suji_kabe_safety`** — the defense family. Do them as
   one module with two modes, add the `safety` ranking module and the riichi-opponent
   board once, and neutralise the `Discard` wording. No new answer type.
7. **`open_hand_defense`**, **`suji_trap_riichi`**, **`perfect_one_away`** — reuse the
   defense board builder or the completion enumerator.
8. **`meld_or_not`** — only after deciding to build the book-lesson call UI.

## 8. File-level map for whoever builds these

- Scenario registry: `src/generator/mod.rs` (`SCENARIO_MANIFEST`, `ScenarioId`,
  `ScenarioId::ALL`, `generate_puzzle`).
- Rationale: `src/rationale.rs` — `category_rationale()` needs an arm per new
  category; add `ch8(§, line, needle)` citation helpers while doing defense.
- Answer vocabulary: `src/state.rs` (`CorrectAction`, `CorrectActionType`),
  `src/verdict.rs`, `src/report/summary.rs`, `src/fuzz.rs`, and the frontend mirrors.
  No new variants are needed for anything in this document.
- Tests: native `#[test]` in the module (100-run constraint sweeps) plus
  `tests/wasm_tests.rs` coverage of the JSON payload.
- The manifest is the single source for `list_scenarios` and the fuzz harness; a new
  `ScenarioId` that is missing from `SCENARIO_MANIFEST` fails
  `manifest_matches_the_registered_scenario_ids`.
- **Doc-comment convention:** every skeleton, board rule, or rationale arm that comes
  from a card carries the card id and its gist, e.g.
  `// Anki 1463194188982 — "not in a ready hand: the pair wait leaves 2 tiles"`.
  That keeps the mining traceable from code back to the deck and to this document.

## 9. Decisions

1. **No `Fold` (or `Push`) answer type.** A defense drill's answer is simply the
   safest discard. The generator additionally requires the safe tile to be part of a
   completed set, pair, run, or protorun, so discarding it visibly breaks the hand
   and reads as a fold rather than an efficiency move (§5.5).
2. **Book authority may outrank computed tile efficiency.** A drill may grade the
   book's line even when `ukeire` prefers another discard, provided the hand proves
   the book's claim (the `nobetan_keep` completion enumeration) and the explanation
   shows the comparison rather than asserting the rule (§5.1).
3. **Deck card ids go in generator doc comments** (convention in §8).

---

## Appendix A — Every card in the deck

`covered` means an existing lesson already teaches it; a backticked candidate id
means it belongs to that scenario; `rationale` means the card is deliberately not
drillable and only feeds explanation text (the reasoning is in the section that
discusses it, §5.x, or in §6).

| Card | Question | Goes to |
| --- | --- | --- |
| `1463190817231` | A protorun is a pair of tiles that can become a run with one more tile | `protorun_priority` |
| `1463190904723` | What are the three 2 tile protoruns? How many tiles can each of them accept? | `protorun_priority` |
| `1463191027124` | Rank the 2-tile protoruns according to their value | `protorun_priority` |
| `1463191128195` | Why is a closed wait more valuable than an edge wait? | `protorun_priority` |
| `1463191196671` | Rank the various tile numbers and honor tiles according to their versatility. Why are they ra… | `protorun_priority` |
| `1463191427816` | Rank the various closed-wait protoruns according to their versatility. Why are they ordered l… | `protorun_priority` |
| `1463191498526` | When keeping a closed hand, rank the value of having a certain number of pairs. Why are they… | `pair_count` |
| `1463192072762` | Rank the value of having 3 vs 2 pairs in a hand that you intend to open with PON. Explain why. | `pair_count` |
| `1463192202158` | What's a perfect 1-away hand? Why is it "perfect"? | `perfect_one_away` |
| `1463192282618` | What's a perfect 2-away hand? Why is it "perfect"? | `perfect_one_away` |
| `1463192521881` | A double closed (ryankan) block is a form consisting of 3 tiles spaced 1 apart (like 135) | `ryankan_break` |
| `1463192693530` | A double closed block can accept how many tiles? | `ryankan_break` |
| `1463192695124` | Why is a double closed block less useful as a hand becomes more ready? | `ryankan_break` |
| `1463192845266` | A protorun plus one is a form consisting of a protorun with an extra tile forming a pair (lik… | `protorun_plus_one` |
| `1463192901441` | How much tile acceptance does a protorun plus one add over a regular protorun? | `protorun_plus_one` |
| `1463192939504` | When choosing between protoruns plus one to break, which protoruns should be broken and why? | `protorun_plus_one` |
| `1463193147898` | A stretched single (nobetan) block is a form consisting of a sequence of four consecutive tiles | `nobetan_keep` |
| `1463193166572` | What should be done with a streched single (nobetan) block? Why? | `nobetan_keep` |
| `1463193567734` | What are the advantages of a stretched single (nobetan) block in a non-ready hand? | `nobetan_keep` |
| `1463193918897` | What are the advantages of a stretched single (nobetan) block in a ready hand? | `nobetan_keep` |
| `1463193992139` | What stretched single blocks are the most valuable? Why? | `nobetan_keep` |
| `1463194085883` | A bulging float (nakabukure) block is a form consisting of a sequence with an extra 4th tile… | `nakabukure_ready` |
| `1463194122718` | What should you do with a bulging float block? Why? | `nakabukure_ready` |
| `1463194188982` | Why should you not keep a bulging float (nakabukure) block in a ready hand? | `nakabukure_ready` |
| `1463194258219` | A skipping block is a form consisting of a sequence with a floating tile at one end (like 2456) | `skipping_block` |
| `1463194377641` | What is the value of a skipping block over an isolated floating tile? | `skipping_block` |
| `1463194454726` | What are the 5 basic waits and how many tiles do they accept? | rationale |
| `1463194687613` | How many tiles are accepted by a stretched single wait? | rationale |
| `1463194733126` | What is a semi side wait? How many tiles does it accept? | rationale |
| `1463194761013` | How many tiles does a wait with a sequence of 5 non terminal tiles accept? | rationale |
| `1463194883251` | What combinations of tiles can produce versatile but irregular waits? | rationale |
| `1463199189833` | The core idea of the five block method is to identify five tile blocks in a hand (four melds… | rationale |
| `1463199369886` | After identifying five tile blocks in a hand, what 2 things should you make sure of when disc… | rationale |
| `1463199372706` | In selecting which tile blocks to keep and discard, what 3 criteria should you focus on? | rationale |
| `1463199412875` | To master the five-block method, should you only envision the first block configuration and n… | rationale |
| `1463199499575` | What should you consider when building a new block when the hand has less than five blocks (d… | `sanshoku_pursuit` |
| `1463199600827` | What are the seven methods to get sanshoku? | `sanshoku_pursuit` |
| `1463199674777` | What is the "floating" method for getting sanshoku? When should you do it? | `sanshoku_pursuit` |
| `1463199757639` | What is the switching method for getting sanshoku? When should you not use it? | `sanshoku_pursuit` |
| `1463199890461` | What is the double closed block method for getting sanshoku? When should you do it? | `sanshoku_pursuit` |
| `1463200050641` | What is the stretched single method for getting sanshoku? | `sanshoku_pursuit` |
| `1463200126332` | What is the lining pairs method of getting sanshoku? | `sanshoku_pursuit` |
| `1463200307818` | What is the golden method of getting sanshoku? | `sanshoku_pursuit` |
| `1463200355010` | What is the crashing a meld method of getting sanshoku and when should you do it? | `sanshoku_pursuit` |
| `1463200442081` | What can make ittsu not worth pursuing? | rationale |
| `1463200614776` | What is the key pattern to getting ittsu? | rationale |
| `1463200676438` | Why is ittsu not realistic with a six-tile block with intervals (like 12 46 79)? | rationale |
| `1463200821315` | Other than two non-overlapping runs, what's another possibility for pursuing ittsu? Why? | rationale |
| `1463201098790` | Why might you choose to pursui ittsu instead of a side wait, despite ittsu having worse tile… | rationale |
| `1463246915402` | What is the key to getting pinfu? | `pinfu_head` |
| `1463246941631` | To build the head for pinfu, what tiles should you not discard and why? | `pinfu_head` |
| `1463247110997` | What is a safety tile? | `fold_to_riichi` |
| `1463247167615` | When building pinfu, when should you prefer keeping a floating tile over a safety tile? | `pinfu_head` |
| `1463247212821` | What are the 2 advantages of going for honitsu? | `honitsu_decision` |
| `1463247300823` | What 2 factors should you consider when going for honitsu? | `honitsu_decision` |
| `1463247331126` | When deciding whether to pursue honitsu, what does it mean to consider the five-block potential? | `honitsu_decision` |
| `1463247407711` | When deciding whether to pursue honitsu, based on your hand value, when should you not pursue… | `honitsu_decision` |
| `1463247587777` | How should you discard tiles when pursuing honitsu? | rationale |
| `1463247652943` | How should you meld when pursuing honitsu? | rationale |
| `1463247702867` | In which 3 situations should you choose chiitoitsu over toitoi? Why? | `chiitoi_vs_toitoi` |
| `1463250507888` | When should you pursue run-based hands over set based hands? | `chiitoi_vs_toitoi` |
| `1463250597539` | What are the 3 demerits of riichi? | `riichi_judgement` |
| `1463250740131` | What are the 3 merits of riichi? | `riichi_judgement` |
| `1463250803181` | What is dama? | `riichi_judgement` |
| `1463250831628` | When should you choose riichi over dama? | `riichi_judgement` |
| `1463250871381` | Should you wait to call riichi when your hand is ready and you intend to call it? | `riichi_judgement` |
| `1463250893952` | Under what circumstances are scores more important than good waits? When are good waits more… | `dama_expensive_hand` |
| `1463250985834` | When waiting for dora with chiitoitsu, when should you riichi? | covered |
| `1463251061277` | When not waiting for dora with chiitoitsu, when should you riichi (6 situations)? | covered |
| `1463251164340` | What are five situations where dama is justifiable? | `riichi_judgement` |
| `1463251214364` | When deciding whether to dama based on a bad wait, when should you riichi and when should you… | `dama_bad_wait` |
| `1463251466860` | What does it mean to go dama due to a genbutsu wait? | `dama_genbutsu_wait` |
| `1463251519343` | If you have an expensive hand, when should you riichi (3 situations)? When should you not (1… | `dama_expensive_hand` |
| `1463251634384` | What 2 conditions should be met for you to keep dama to improve your hand? | `dama_improving_hand` |
| `1463251760218` | With a yaku-less hand, what should you do (regarding riichi)? | `riichi_judgement` |
| `1463251851184` | When another player has a ready hand, when should you push? | `push_or_fold` |
| `1463251902123` | When another player has a ready hand, when should you fold? | `push_or_fold` |
| `1463251955444` | What are genbutsu tiles for a player? | `fold_to_riichi` |
| `1463252064018` | How safe are genbutsu tiles? | `fold_to_riichi` |
| `1463252072584` | What 3 kinds of tiles are 100% safe against all opponents? | `fold_to_riichi` |
| `1463252155557` | What is a suji? | `suji_kabe_safety` |
| `1463252227416` | What are all 6 suji intervals? | `suji_kabe_safety` |
| `1463252322747` | What is a suji tile? | `suji_kabe_safety` |
| `1463252443086` | Why is a suji tile safe? | `suji_kabe_safety` |
| `1463252773350` | When 4 is genbutsu, what are the suji tiles? | `suji_kabe_safety` |
| `1463252825944` | When 5 is genbutsu, what are the suji tiles? | `suji_kabe_safety` |
| `1463252827373` | When 6 is genbutsu, what are the suji tiles? | `suji_kabe_safety` |
| `1463252840950` | When 1 and 7 are genbutsu, what is the suji tile? | `suji_kabe_safety` |
| `1463252857644` | When 2 and 8 are genbutsu, what is the suji tile? | `suji_kabe_safety` |
| `1463252880019` | When 3 and 9 are genbutsu, what is the suji tile? | `suji_kabe_safety` |
| `1463252921641` | When one of 1, 2, 3, 7, 8, or 9 are genbutsu by themselves, what are the suji tiles? | `suji_kabe_safety` |
| `1463253028848` | What is a suji trap? | `suji_trap_riichi` |
| `1463253075169` | How does the reliability of suji tiles change during a hand? | `suji_kabe_safety` |
| `1463253121175` | What is a tile blockade (kabe)? | `suji_kabe_safety` |
| `1463253194289` | What does a tile blockade (kabe) make safe? | `suji_kabe_safety` |
| `1463253262703` | In a blockade, what is a no-chance situation? | `suji_kabe_safety` |
| `1463253321273` | In a blockade, for each number, what are the safe tiles? | `suji_kabe_safety` |
| `1463253370600` | Why does a blockade make other tiles safe? | `suji_kabe_safety` |
| `1463253482504` | What is a double one chance tile? How is it created by blockades? | `suji_kabe_safety` |
| `1463253627725` | Rank the types of tiles created by blockades according to their safety | `suji_kabe_safety` |
| `1463253866635` | What is an incomplete blockade? What safe tile situation do they create? | `suji_kabe_safety` |
| `1463253944854` | What are the 2 types of blockades? | `suji_kabe_safety` |
| `1463253993539` | How can blockades combine to make additional safe tiles? | `suji_kabe_safety` |
| `1463254032664` | How can blockades inform discarding decisions for the tiles they don't directly make safe? | `suji_kabe_safety` |
| `1463254149980` | What are the 6 possible combinations of suji and blockade tiles and what tiles do they make s… | `suji_kabe_safety` |
| `1463254335887` | How can a blockade combine with a suji to make additional tiles safe? | `suji_kabe_safety` |
| `1463254363324` | In the alphabet ranking of tile safety, how much safety difference is there between rows that… | `suji_kabe_safety` |
| `1463254499575` | Recite the alphabet safety ranking table | `suji_kabe_safety` |
| `1463254667324` | Using the alphabetical safety ranking, how should you defend against riichi? | `fold_to_riichi` |
| `1463255088593` | What can you discard when you cannot identify safe tiles (3 considerations)? | `fold_to_riichi` |
| `1463255264912` | When should you attack/defend, based on your current position in the game? | rationale |
| `1463255328253` | When should you attack/defend, based on how many turns have passed? | rationale |
| `1463255367640` | For defending against melded hands, when should you assume an opponent has a ready hand? | `open_hand_defense` |
| `1463255468847` | When an opponent has a melded hand, what should you determine in addition to whether they are… | `open_hand_defense` |
| `1463255593155` | When defending against a melded hand, how can you determine dangerous tiles by looking at the… | `open_hand_defense` |
| `1463255694221` | When an opponent discards upon chi, what can you consider safe or dangerous based on what the… | `open_hand_defense` |
| `1463255782615` | When should you not meld? | `meld_or_not` |
| `1463256320218` | What are 2 exceptions to the recommendations against melding for which it is okay to meld? | `meld_or_not` |
| `1463256486957` | What are three situations where you can meld with a cheap and slow hand (other than when you… | `meld_or_not` |
| `1463256548176` | When can you justify making a concealed quad? | `ankan_decision` |
| `1463256655221` | When should you not make a concealed quad (3 situations)? | `ankan_decision` |
| `1463256729338` | In what 3 situations is it okay to make a melded quad? | `daiminkan_decision` |
| `1463256791280` | When is it okay to declare kan for an already melded triplet? | covered |
| `1463256846829` | Relating to seating, what should you consider when calling pon? | `meld_or_not` |
| `1463256990069` | What order should you use when discarding valueless wind tiles? | `wind_discard_order` |
| `1464147205450` | When not waiting for dora with chiitoitsu, when should you dama (2 situations)? | covered |
