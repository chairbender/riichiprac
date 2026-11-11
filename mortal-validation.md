# Validating our Mortal wiring through mjai.ekyu.moe

The app ships a client-side Mortal v4 port: [`src/ai/encoder.rs`](../src/ai/encoder.rs)
builds libriichi's 1012×34 observation from a [`GameState`](../src/state.rs) and
[`src/ai/wasm_bridge.rs`](../src/ai/wasm_bridge.rs) runs the checkpoint. If either
side is wrong the model still answers, so nothing in the app can tell. This
document describes the two pieces that let an outside engine check the wiring:

1. **Export** – [`src/export/tenhou6.rs`](../src/export/tenhou6.rs) writes a
   `tenhou.net/6` game log of a generated state, which is the "custom log"
   input of <https://mjai.ekyu.moe>.
2. **Compare** – [`scripts/validate_mortal_review.py`](../scripts/validate_mortal_review.py)
   reads the reviewer's report and diffs its Mortal output against our own
   `evaluate_state` result for the same decision.

Both are deliberately outside the UI: nothing the player sees changed.

## Why there is a manual step

The reviewer's form is behind a Cloudflare Turnstile. A direct POST to
`/review` carrying the form fields (input method `tenhou6`, the log,
`player-id`, engine, model tag) is rejected with `403 invalid captcha
response` — verified. There is no JSON API behind the form either: from a
non-browser client every route except `/robots.txt` answers 403, including
`/`, `/review`, `/api` and `/report/`, so the only interface is the HTML form
and its Turnstile token. That token is minted per browser session, and solving
the challenge programmatically would mean defeating the control the site
operator put there to gate exactly this kind of submission, so this tool does
not attempt it.

The fallback the operator asked for is what shipped: a generated
`tenhou.net/6` fixture for manual upload, and an automated comparison of the
pasted result. Upload by hand, paste the report URL (or save the page and pass
it, or pipe it through `--report -`), and the script does the rest:

```bash
# 1. Export a log of a generated scenario, together with our evaluation.
cargo run --release --bin export_tenhou6 -- \
    --scenario riichi_judgement \
    --out /tmp/fixture.tenhou6.json \
    --evaluate --evaluation-out /tmp/ours.json
#    → prints the player id, any fidelity warnings, and the upload hint.

# 2. Upload /tmp/fixture.tenhou6.json at https://mjai.ekyu.moe:
#    "Custom log (tenhou.net/6 JSON)", target player = the printed id,
#    engine Mortal, network 4.0, advanced options → temperature 1.00.

# 3. Paste the report URL back into the comparison.
scripts/validate_mortal_review.py --report <report-url> --evaluation /tmp/ours.json
#    (a saved page or a piped paste works too: --report page.html, --report -)
```

`--all` exports every scenario the exporter can represent, and `--out-dir`
writes one file per scenario. `scripts/validate_mortal_review.py --selftest`
checks the report parser without any network access.

`export_tenhou6_json(state_json)` exposes the same export to the WASM build,
so the app can offer the log later without new game logic.

## What the log represents

`tenhou.net/6` is a tuple per kyoku:

```
[ [kyoku, honba, kyotaku], [scores], [dora], [ura],
  [haipai, takes, discards] × 4, result ]
```

with tiles as `suit*10 + rank` (`11` = 1m … `47` = chun), `51/52/53` for the red
fives, `60` for tsumogiri, `"r<id>"` for a Riichi discard, and naki strings
(`p`/`c`/`m`, plus `a`/`k` inside *discards*) for calls. The parser that defines
these is mjai-reviewer's [`convlog`](https://github.com/Equim-chan/mjai-reviewer),
and the strings are written in exactly the forms it accepts — including the
marker position that encodes which seat the claimed tile came from.

The reviewer's Mortal observation depends on each seat's river (in order, with
tsumogiri and Riichi flags), each seat's melds, the dora, the scores and the
round — never on how the rivers interleave. So the exporter:

* fixes the kyoku number, round wind, dealer, honba and riichi sticks from the
  state, rotating the seats so tenhou's `kyoku % 4` dealer lines up;
* searches for any legal turn order that consumes the given rivers, placing
  every claim on a real discard;
* reconstructs haipai and draws by walking the sequence backwards from the
  state's hands, which makes the target's final hand exact and every tile
  physically accounted for;
* ends the kyoku on the decision the state presents: for a self turn the human
  draws and discards once more (the answer tile), for a reaction the next seat
  draws so the reviewer records the reaction, and for a chankan the source's
  added kan is the last event;
* reports anything it had to pick rather than derive as a warning on stderr.

The log's own end is a ryukyoku with zero deltas; only the position matters.

## What the comparison means

The report's last decision is the snapshot our log was built to reach. The
script prints:

| field | meaning |
| --- | --- |
| `our top action` / `their top action` | our argmax vs Mortal's highest-Q action |
| `top action match` | the behavioural check: are we steering with the same policy? |
| `max |dP|` | over actions both sides list, after rescaling both to the page's temperature; a few 1e-3 means the same weights on the same observation |
| `only in report` / `missing from report` | legal-mask differences — the most likely wiring bug |

Both report layouts are parsed: the default (KillerDucky) page keeps exact
values in `title` attributes, and the classic page renders five-decimal spans.
If the page does not state its temperature the script assumes the reviewer's
own default of 0.1 rather than 1.0, so the comparison cannot silently mix two
distributions; pass `--temperature` to override.

`pip`/`tau` (Mortal's softmax temperature) only rescales the probabilities, so
the script re-derives ours at whatever temperature the page reports
(`p_i ∝ exp(log p_i · τ_source / τ_target)`), which makes the comparison valid
at τ = 0.1 as well as τ = 1.

Mortal's per-action `Q` is not comparable with our `expected_value`: the report
shows `Q(s,a)` (and `Φ`, the pt EV), while output 0 of the network is `V(s)`.
Only the action distribution and its ordering are compared.

**Our checkpoint is not the reviewer's network.** `mortal_298k` is
`VoidShine/mortal-298k`: a checkpoint trained with the Mortal framework (298k
steps, 2025–2026 Tenhou hanchan logs) whose card reports "AI similarity
83%–92% on mjai.ekyu.moe". It is the right *architecture* (v4, 1012 channels,
46 actions) and the right *rules*, but not the same weights as any network tag
the site offers. Consequences:

* the **top action** is the meaningful check — two runs of this recipe agree on
  most decisions, so agreement is evidence that the observation is wired
  correctly;
* `max |dP|` is **not** a pass/fail signal against the site's networks. It only
  becomes one with `--same-weights`, i.e. when you deliberately upload against
  a network you know is identical (for example by hosting our checkpoint in a
  local reviewer).

A wrong *mask* is the failure mode worth hunting, because it makes agreement
impossible rather than merely unlikely: the harness prints `only in report`
and `missing from report` for exactly that.

## First manual run (report `7f1324f5dd05e502`)

Fixture: `riichi_judgement`, East 2 honba 1, human = dealer, no calls. Uploaded
with target player 1, network 4.0, temperature 1.00.

**The table arrived intact.** The review's own state for the last decision has
`shanten 0`, `tiles_left 61`, and a 14-tile hand equal to ours; the page's
re-serialised log has the same kyoku meta, scores, dora, haipai, draws and
discards we wrote. Nothing was dropped or reordered by the parser.

**Four decisions, four agreements, after one mask fix.** Our evaluation of each
position (the site gives its top action and its full legal set per entry; ours
comes from `evaluate_state` on a state built from the same position):

| # | position | site's 4.0 | ours, before | ours, after |
| --- | --- | --- | --- | --- |
| 1 | first discard (2-shanten) | `Discard_6s` | `Discard_6s` ✅ | `Discard_6s` ✅ |
| 2 | chi opportunity on 8m | `Pass` | `Pass` ✅ | `Pass` ✅ |
| 3 | second discard (1-shanten) | `Riichi` | `Discard_4p` ❌ | `Riichi` ✅ |
| 4 | final decision (tenpai) | `Riichi` | `Riichi` ✅ | `Riichi` ✅ |

Entry 3 was not a model disagreement, it was a **missing action**: our
evaluation for that position had no `Riichi` at all (the comparator reported it
as `only in report`). `ai::actions::can_riichi` required `state.shanten == 0`,
while libriichi (`update.rs`, `tsumo`) allows

```rust
self.is_menzen && self.tiles_left >= 4 && self.scores[0] >= 1000
    && (self.shanten == 0 || self.shanten == 1 && self.has_next_shanten_discard)
```

where `has_next_shanten_discard` is "some tile in hand can be discarded to
reduce shanten" — i.e. **Riichi is legal from 1-shanten whenever a discard
reaches tenpai**, because the declaration is made on that discard.

Fixed in `ai::actions::can_riichi` + a new `can_discard_into_tenpai` helper that
reuses the encoder's own shanten function (`ai::sp::calc_all`), so the mask and
the `can_riichi` plane (row 879) cannot disagree. `wasm_bridge`'s test now
covers 1-shanten with and without a tenpai discard, asserting both the mask and
the plane.

After the fix the four positions have **identical legal sets** to the review's
(`only in report` / `missing from report` empty everywhere) and the same top
action on all four; entry 3's top two even line up (`Riichi`, `Discard_6m`).
A 12-per-scenario sweep shows no book lesson's `can_riichi` flipping — the
open-pon lessons fail the closed-hand test and the defense/wind hands are far
from tenpai — so the visible effect is confined to closed 1-shanten hands,
i.e. AI drills and any future lesson in that shape.

Probabilities, for the record: our distribution is far sharper (final decision:
`Riichi` 0.608 / `Discard_5z` 0.388) than the site's (`0.245` / `0.203`). That
is expected from the two different checkpoints; the top two actions are the
same and in the same order.

## Findings

### 1. Open-meld lessons generate tables that cannot be written as a real log

`validate_melds` checks that a meld's tiles form a legal shape and that the
caller is allowed to claim from `called_from`, but nothing checks that the
discarder's river actually contains the claimed tile. The generators pick the
pon/chi tiles from the hand skeleton and then draw the opponents' rivers from
the deck, so the claimed tile is usually *not* in any river. A real log has no
way to express that: a claim must land on an actual discard.

Measured over 12 generated tables per scenario:

| scenario | log written | rejected |
| --- | --- | --- |
| ryanmen_protorun | 0 | 12 |
| nakabukure_ready | 2 | 10 |
| protorun_priority | 2 | 10 |
| ryankan_break | 1 | 11 |
| shouminkan_decision | 0 | 12 |
| chiitoitsu_riichi_vs_dama | 12 | 0 |
| riichi_judgement | 12 | 0 |
| wind_discard_order | 12 | 0 |
| defense_safety_chart | 12 | 0 |
| defense_stuck_heuristic | 12 | 0 |

The exporter refuses those states (`no eligible river contains that tile`)
instead of quietly changing the table, because a substituted river would make
the comparison meaningless. The fix belongs in the generators: put the claimed
tile in the discarder's river, the way `ai_best_action`'s reaction builder
already does for its claim. Once that lands, the four block-theory lessons and
the Added Kan lesson become exportable too.

When the tile *is* in a river but in the wrong seat's river, the exporter
claims it there and warns: the observation only sees the meld, not who
discarded the tile, so that substitution is faithful.

### 2. `chiitoitsu_riichi_vs_dama` reports one wall tile too few

`board/setup.rs::build_deck` removes the 14-tile hand, *two* dora indicators
and one ura indicator from the deck, and `board/mod.rs` then subtracts 12 for
the dead wall. With two indicators that is 15 tiles off a 14-tile dead wall, so
`tiles_remaining` is 1 lower than the position implies. The exporter notices
exactly that: every chiitoitsu log warns

```
tiles_remaining is 43 but the reconstructed timeline draws 26 wall tiles,
so Mortal sees 44 left
```

That is a direct hit on the `tiles_left / 69` plane (row 717) for every
chiitoitsu state. The other lessons draw one indicator and agree exactly.

### 3. Post-call discards can be marked tsumogiri

`discards_from_tiles` flips a coin for every river tile, including the discard
that immediately follows a call, which no real player can make tsumogiri. The
log has to replay it as tedashi (a `60` entry after a call would be a naki
discard, which `convlog` cannot represent), so the exporter warns:

```
seat 2 discards tsumogiri right after a call in the state, which cannot
happen; the log replays it as a tedashi
```

Post-call discards feed the opponents' `tedashi` summary plane, so those states
differ from Mortal on that row. `main` already fixed the generator
(`c2e41e8 Force tedashi after calls, record tsumogiri answers`); this branch
predates it, and the warning disappears once the branches meet.

### 4. libriichi pads rivers with empty slots, our encoder does not

Read from [`libriichi`](https://github.com/Equim-chan/Mortal/tree/main/libriichi):

* `pad_kawa_at_start` inserts one `None` into the rivers of every relative
  seat before the dealer;
* `pad_kawa_for_pon_or_daiminkan` inserts a `None` into every seat skipped by a
  call;
* `encode_self_kawa(None)` writes nothing but still advances the cursor, so a
  padded slot shifts every later discard one position in the 6-first /
  18-last river blocks and in the `exp(-0.2 · turns_ago)` summaries, whose
  `max_kawa_len` includes the padding.

Our encoder stores rivers compactly and uses `max(discards.len())`. When the
human is the dealer and no call skipped a seat the two agree exactly; otherwise
the river planes are shifted and the recency weights are scaled per seat (and
per call). `encode_kawa` also writes the tiles consumed for a chi/pon into the
river slot, which we leave zero because a `CalledMeld` does not record which
discard it consumed.

This one is a prediction to be confirmed with the harness: compare
`riichi_judgement`/`defense_safety_chart` states where the human is the dealer
(should be tight) with states where they are not (expected to show a
larger `|dP|` while usually keeping the same top action).

### 5. Chankan states need a pon plus an added kan

The chankan state stores a four-tile `MeldType::Kan` with `called_from: Some(0)`
(a placeholder; the human is in fact the one who can ron it), and the source's
river is random, so the required "pon then added kan" history cannot be built.
The exporter renders it as pon + kakan when a river holds the tile and
otherwise refuses. A chankan state is only representable if the generator
places the pon tile in some river, as above.

## Limits

* Only the decision the log ends on is compared. The report also contains the
  target's earlier decisions, but those positions are reconstructed
  intermediate hands, so their Q values say nothing about the final state.
* The reviewer needs a Mortal-capable network tag; `4.0` is the right family
  for `mortal_298k`. A different tag invalidates the `|dP|` check but not the
  top-action check.
* A single decision proves nothing on its own. Run several scenarios, and
  prefer the self-turn lessons (`riichi_judgement`, the defense pair) where the
  hand is concealed and the river padding is the only expected difference.
* The exporter writes one kyoku and ends it with a ryukyoku; it never tries to
  build a hanchan.

## Layout

| path | role |
| --- | --- |
| `src/export/tenhou6.rs` | the exporter (format, turn-order search, reverse walk) |
| `src/export/tenhou6_test.rs` | native tests, including an independent replay of the emitted JSON |
| `src/bin/export_tenhou6.rs` | CLI: generate/load a state, write the log, run our evaluation (`--evaluate-only` skips the log) |
| `scripts/validate_mortal_review.py` | report scraper and comparison |
