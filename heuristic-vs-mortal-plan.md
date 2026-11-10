# Heuristic vs. Mortal: Equal-Weight Verdicts, Always-On Mortal

Status: implemented.

This document describes how the trainer stops treating the book heuristic as the
only ground truth. Every puzzle will carry two graded perspectives — the
Riichi Book 1 rule the scenario encodes and the embedded Mortal v4 policy — and
the UI will present them side by side, with the book side always explained and
cited. An answer is only called wrong when both perspectives disagree with it.

## Problem

The app teaches book heuristics, but it grades as if the book were the only
authority and Mortal were an optional second opinion:

- `GameState.correct_action` (Rust, `src/state.rs`) is the graded answer. It is
  produced by the scenario generator from a hard-coded book heuristic.
- Mortal lives behind an opt-in button. `AiEvaluatorPanel.tsx` shows "Evaluate
  with AI" until the user presses it, and `App.tsx` only renders that panel when
  `!isAiScenario` (line ~345). The per-tile probability overlay in `HandDock.tsx`
  is gated by `revealAi={!isAiScenario || feedback !== null}` (line ~380), so for
  book scenarios the badges appear as soon as an evaluation happens to exist.
- The one exception is inverted: in `ai_best_action`, Mortal *is* the answer
  (`CorrectAction::Best`, `AiDecisionExplanation.tsx`), and the UI has to
  apologise for it ("AI recommendation, not ground truth").
- `selectTile()` in `useGameStore.ts` grades with `selectedType === correctAction.type`
  plus a tile compare. `submitChoice()` grades `best` with a string compare. Both
  encode a single authority into the feedback object, `AnswerFeedback.isCorrect`.
- `FeedbackToast.tsx` therefore prints "Incorrect" for any book mismatch, even
  when the model would play exactly that move — and prints "Correct!" for a book
  match even when the model considers the move a blunder.

Two secondary gaps make the "book perspective" weaker than it looks:

- **Rationale lives in React.** `ScenarioExplanation.tsx` hard-codes
  `RIICHI_LABELS` / `DAMA_LABELS`, one short English sentence per trigger, with
  no chapter reference. That is game-knowledge text in the thin layer AGENTS.md
  says must not contain rules, and it cannot be exported or tested.
- **Two scenarios have no book explanation at all.** `ryanmen_protorun` sets
  `riichi_triggers: Vec::new()` and `dama_reasons: Vec::new()`
  (`src/generator/block_theory/ryanmen_protorun/board.rs:234-236`), so
  `ScenarioExplanation` returns `null`. `shouminkan_decision` has
  `shouminkan_triggers` but `ScenarioExplanation` returns `null` for
  `kan`/`discard` actions, so its justification exists only as a one-line toast.

The result is a trainer that can mark a defensible move wrong, hides the
disagreement that the app was built to expose, and cannot say which sentence of
the book a scenario is teaching.

## Goals

- One canonical grading model in Rust that answers: *does the book agree with
  this answer, does Mortal agree, and what do we call the combination?*
- Mortal evaluated for every puzzle automatically, with no button, and presented
  with the same visual weight as the book.
- The book recommendation always explained, always cited: scenario → book rule
  → chapter/section → short quote.
- The word "wrong"/"Incorrect" reserved for the single case where both
  perspectives reject the answer.
- Honest single-perspective and unavailable-perspective states, never a silent
  downgrade to "wrong".
- No game rules added to React; no new frontend dependencies; no test runner
  invented to compensate.
- The 4-row stacked table, bottom hand dock, and mobile-first portrait layout
  stay exactly as they are.

## Non-Goals

- No new generator scenarios, no changes to generation constraints, rejection
  sampling, or the CSP.
- No attempt to explain *why* the book and Mortal disagree. The UI shows both
  recommendations; it does not narrate the gap.
- No model ensemble, no strength estimate for Mortal, no per-decision
  calibration work.
- No Web Worker in v1 (see "Cost model" and Future Work).
- No change to the report file's purpose or its import semantics; only the
  verdict block grows.
- No re-litigating AGENTS.md or the generator architecture.

## Key Design Decisions

### 1. The verdict is two perspective results plus one derived outcome

Three orthogonal facts, one label:

```rust
// src/verdict.rs
#[serde(rename_all = "snake_case")]
pub enum PerspectiveResult { Agrees, Disagrees, Unavailable }

#[serde(rename_all = "snake_case")]
pub enum AnswerOutcome {
    BothAgree,                  // both perspectives accept the answer
    BookAgreesMortalDoesNot,    // book accepts, Mortal rejects
    MortalAgreesBookDoesNot,    // Mortal accepts, book rejects
    NeitherAgrees,              // the only state that may be called wrong
    OnlyAvailableAgrees,        // exactly one perspective exists and accepts
    OnlyAvailableDisagrees,     // exactly one perspective exists and rejects
    Ungraded,                   // no perspective available
}
```

`outcome` is a pure function of `(book, mortal)`; there is no precedence order
and no fallthrough, because the mapping is total:

| book \ mortal | `Agrees` | `Disagrees` | `Unavailable` |
| --- | --- | --- | --- |
| `Agrees` | `BothAgree` | `BookAgreesMortalDoesNot` | `OnlyAvailableAgrees` |
| `Disagrees` | `MortalAgreesBookDoesNot` | `NeitherAgrees` | `OnlyAvailableDisagrees` |
| `Unavailable` | `OnlyAvailableAgrees` | `OnlyAvailableDisagrees` | `Ungraded` |

`OnlyAvailableAgrees` / `OnlyAvailableDisagrees` pair with a runtime
`GradingMode` (`BookOnly`, `MortalOnly`, `BookAndMortal`, `Ungraded`) that says
*which* perspective survived, so one outcome value never needs to encode two
different meanings in its name.

**Invariant:** `is_wrong == (outcome == NeitherAgrees)`. Every single-source
outcome is rendered as a statement about that source, never as a judgement about
the player. Encode this once, in Rust, and let the frontend switch on `outcome`;
no component may re-derive "wrong" from `!book.is_action_correct`.

**UI vocabulary** (one word per state, used in the toast headline, the outcome
chip, and the report summary):

| outcome | mode | chip | toast headline |
| --- | --- | --- | --- |
| `BothAgree` | `BookAndMortal` | Both agree | Correct |
| `BookAgreesMortalDoesNot` | `BookAndMortal` | Book answer | Book answer |
| `MortalAgreesBookDoesNot` | `BookAndMortal` | Mortal's line | Mortal's line |
| `NeitherAgrees` | `BookAndMortal` | Off both lines | Incorrect |
| `OnlyAvailableAgrees` | `BookOnly` | Book answer | Book answer |
| `OnlyAvailableDisagrees` | `BookOnly` | Not the book's line | Not the book's line |
| `OnlyAvailableAgrees` | `MortalOnly` | Matches Mortal | Matches Mortal |
| `OnlyAvailableDisagrees` | `MortalOnly` | Off Mortal's line | Off Mortal's line |
| `Ungraded` | `Ungraded` | Not graded | Not graded yet |

`NeitherAgrees` is the *only* state that receives the existing
`feedback-toast--incorrect` styling. `BookAgreesMortalDoesNot` and
`MortalAgreesBookDoesNot` get a third, neutral style
(`feedback-toast--contested`) so a split decision does not look like a failure.

**The two cases the task calls out, resolved explicitly:**

- *Book and Mortal disagree with each other, player picks one of them.* The
  player is in `BookAgreesMortalDoesNot` or `MortalAgreesBookDoesNot`. Not
  wrong. The toast names what the other side said and the comparison block marks
  that column with a cross. The hand may be tagged "Split verdict" as a property
  of the *authorities*, not of the answer.
- *Book and Mortal disagree with each other, player picks neither.* The player is
  in `NeitherAgrees`, because the rule is about the player: both perspectives
  reject the chosen answer. Copy: "Incorrect — the book and Mortal each pick
  something else." This is the one place a split hand still produces a wrong
  answer, and it is correct to do so.

Note the asymmetry that falls out of this, and accept it: when the two
authorities agree, exactly one answer is "not wrong"; when they disagree, exactly
two answers are "not wrong" and everything else is wrong.

`GradingMode` is `BookAndMortal` when both perspectives exist, `BookOnly` when
the model is missing for a book lesson, `MortalOnly` for the declared Mortal
drill, and `Ungraded` when a Mortal-only drill is graded without a model. It is
computed in Rust from the manifest's declared grading plus runtime availability;
it is never guessed in React.

### 2. "Mortal agrees" means top-1, with uncertainty shown but not graded

`MortalGrade.agrees` is `true` only when the submitted answer is the model's
argmax action (after red-five normalization). No probability band, no tie
tolerance. Justification:

1. **One meaning everywhere.** `evaluation.recommended_action` is already "what
   Mortal would play" in `AiDecisionExplanation`, `ReportBanner`, and
   `AiComparison.ai_agrees_with_app`. A band would make "Mortal agrees" mean
   something different from "Mortal's recommendation", and every existing report
   comparison would silently change meaning.
2. **Version stability.** Probabilities are a softmax over 46 action logits
   (`ACTION_SPACE`) and can move between candle versions and platforms;
   `scenario-report-plan.md` already lists AI nondeterminism as a risk and forbids
   asserting exact probabilities. A thresholded band would make *correctness*
   depend on those floats, so a weights refresh could retroactively make
   yesterday's answers wrong.
3. **Honesty of the lesson.** The training claim is "Mortal would play X". If we
   graded a 31% second choice as agreement with a 34% top choice, the UI would
   have to say "Mortal also agrees, sort of", which is worse pedagogy than
   "Mortal prefers X, but only 34% — it is nearly split".

Uncertainty is therefore **display-only** and cannot change `agrees`:

```rust
#[serde(rename_all = "snake_case")]
pub enum MortalConfidence { High, Medium, Low }   // >= 0.50, >= 0.25, else

pub struct MortalGrade {
    pub model: String,
    pub recommended_action: String,   // raw argmax, may end in `r`
    pub recommended_base: String,     // red-five collapsed
    pub answer_action: String,        // the answer in Mortal's vocabulary
    pub agrees: bool,
    pub answer_probability: f32,      // red-five variants summed
    pub top_probability: f32,
    pub confidence: MortalConfidence,
    pub close_second: bool,           // |top - answer| <= 0.05, display only
}
```

`CLOSE_SECOND_GAP = 0.05` and the confidence cut-points are display constants in
`src/verdict.rs`, documented as arbitrary bands that must not be used for
grading. They let the copy soften `NeitherAgrees` ("Mortal is nearly split
here") without weakening the taxonomy. A band was considered and rejected for
exactly this reason: the copy can be soft while the verdict stays crisp.

**Red-five normalization.** `Discard_5mr` and `Discard_5m` are distinct model
actions but one tap target (`5m`), because `HandDock` passes tile codes and
`red_fives` is positional metadata. Normalize both sides with the existing
`normalize_mortal_action` (`src/ai/finalize.rs`, already `pub`) before comparing,
and aggregate probabilities with the existing `probability_for_action`
(`src/report/mod.rs:284`), which sums the red variant into the base action. The
raw argmax stays in `recommended_action` for attribution.

**Tile-level vs. action-level.** Mortal's vocabulary has no `Riichi_<tile>`; that
name does not exist in this codebase and the plan does not introduce it. A
`Riichi` recommendation carries no discard, and `CorrectAction::Best { action:
"Riichi", tile }` carries the discard out-of-band from the generator's second
pass (`ai-scenario-plan.md` §3.6). Comparison is therefore:

| Mortal recommendation | compare | note |
| --- | --- | --- |
| `Discard_<tile>` (incl. `Discard_5mr`) | family + tile | red collapsed first |
| `Riichi` | family only | the discard is not part of the model action |
| `Pon` / `Chi_Low` / `Chi_Mid` / `Chi_High` / `Kan` / `Pass` / `Agari` / `Ryukyoku` | family only | no tile in the model action |
| drill answer (`correct_action: Best`) | family + tile | the drill's `Best.tile` is Mortal's second-pass discard |

Consequence, stated so nobody is surprised: declaring Riichi on the "wrong"
tile is graded `book: tile miss`, `mortal: agree` → `MortalAgreesBookDoesNot`.
That is a truthful report of what the model said, and the book column still shows
the tile miss. Synthesizing a Riichi discard the model never chose would be
inventing a second forward pass for lessons that do not need one.

### 3. Compute eagerly, reveal after submit, make peeking deliberate

Mortal runs for every puzzle on load, but its recommendation is **hidden until
the answer is submitted**.

Reasons:

- `ai_best_action`'s `correct_action` *is* the argmax; revealing it pre-answer
  turns the drill into a copy exercise. `ai-scenario-plan.md` §3.9 already made
  this call for AI scenarios; we generalize it.
- On book scenarios, showing "Mortal would play 5s" before the answer turns a
  recall drill into a lookup, and it leaks the answer whenever book and Mortal
  happen to agree — which is most hands.
- The requirement is that both perspectives carry equal weight in *grading* and
  in *the post-answer presentation*. Nothing about equal weight requires
  pre-answer disclosure.

Concretely:

- The comparison block is present pre-answer but collapsed to one line of
  status (see wireframes). It never contains an action name until `feedback`
  exists or the user peeks.
- `HandDock`'s per-tile probability badges must be gated on
  `feedback !== null || peeked`, not on "an evaluation exists". This is a real
  current leak waiting to happen: `revealAi={!isAiScenario || feedback !== null}`
  becomes true the moment `evaluation` is non-null for a book scenario.
- A **"Peek"** button in the collapsed block reveals the full Mortal ranking
  before answering. It is per-puzzle, resets on load, and records
  `peekedBeforeAnswer` so the exported report can say so. Peeking is not
  punished; it is recorded. `correct_action` and the `ai_decision` ranking are
  already in the payload, so this is honesty about training, not security.
- What replaces the **"Evaluate with AI"** button: nothing. The button is
  deleted along with `AiEvaluatorPanel.tsx`. Its status/error rendering moves
  into the Mortal column of the new block, which has no action verb except
  "Retry" on failure.
- `AiDecisionExplanation.tsx` is deleted. Its ranking becomes the Mortal
  column's expanded state, shared by every scenario.
- `ScenarioExplanation.tsx` is rewritten to render `state.book_rationale` and is
  no longer gated on `!isAiScenario`, so the book column looks the same for
  every lesson that has a book rule.

### 4. Cost model: one evaluation per puzzle, seeded from the payload when it exists

Today the weights are already fetched on first paint for every user
(`App.tsx` lines 144-147 call `initializeAi()` unconditionally), so always-on
evaluation adds **CPU**, not network. The added work per puzzle is:

- one synchronous forward pass inside `WasmMortalEvaluator::evaluate`
  (`src/ai/wasm_bridge.rs`), currently preceded by a single `setTimeout(0)` yield
  in `evaluateWithAi`, and
- for `ai_best_action`, *nothing*: the generator already embedded the full
  ranking in `GameState.ai_decision`. The store should seed `evaluation` from
  `ai_decision` on load instead of paying for a second identical pass. That also
  removes the current duplicate source of truth (`App.tsx` builds
  `reportEvaluation` from `ai_decision` precisely because `evaluation` is empty
  for that scenario).

Rules:

1. **Warm at first paint** — keep the existing effect. No change.
2. **Auto-evaluate on puzzle load** — after `loadFromJson` sets `gameState`, request
   an evaluation for that exact state. Implement as `requestEvaluation(state)`
   called at the end of `loadFromJson` (not a React effect), so imports and
   report retries get it too.
3. **Seed from payload** — if `gameState.ai_decision` exists, set `evaluation`
   from it synchronously and skip the pass.
4. **Keep the identity guard** — `evaluateWithAi` already discards a result whose
   `gameState` is no longer current (`if (get().gameState === gameState)`). Keep
   that check and add a one-slot retry: if a newer state arrived while the pass
   was running, run once more for the current state instead of silently dropping
   the request. Concretely, replace the `isEvaluating` early-return with
   `runEvaluationLoop()` that remembers the state it last evaluated and re-checks
   after each pass.
5. **Never block answering** — the hand dock and action bar are enabled
   regardless of `aiStatus`. If the player answers before the pass finishes, the
   answer is graded `BookOnly` immediately and **re-graded** when the evaluation
   lands (the store keeps `submittedAnswer`, so this is a pure re-derive, not a
   second submission).
6. **Web Worker: not now.** The 43 MB safetensors parse and the forward pass are
   main-thread work, and always-on inference makes that cost unavoidable rather
   than opt-in. But moving it to a worker is a bounded project with real
   coupling: the worker would have to own the model (wasm-bindgen classes cannot
   share memory across threads), so `generate_ai_puzzle` moves with it, and the
   `Evaluation` boundary becomes `postMessage` + structured clone with request
   ids. Do it only if phase 0 shows the pass stalls the UI. **Latency is
   unmeasured; instrument in phase 0** — `WasmMortalEvaluator::new` duration,
   `evaluate()` duration, and long-task/frame-gap counts, on desktop and on one
   mid-tier phone.
7. **Status copy instead of a button**, in the collapsed block:
   - `idle`/`loading`: "Mortal: loading the model once (~43 MB)…" with the
     existing spinner class.
   - `ready`, pass queued/running: "Mortal: thinking about this hand…".
   - `ready`, result hidden: "Mortal has an opinion. Answer first, or Peek."
   - `error`: "Mortal unavailable — this hand is graded against the book only."
     with Retry.

### 5. Degradation is a first-class grading mode, not a fallback

Mortal can be absent four ways: weights missing (404), fetch/`content-type`
error, `WasmMortalEvaluator` construction failure, and "puzzle generated before
the model finished loading". All four land in the same place: `evaluation ===
null`, `aiStatus === 'error'` or `'loading'`.

- The grade becomes `GradingMode::BookOnly`; `book` is computed; `mortal` is
  `None`; outcome is `OnlyAvailableAgrees` or `OnlyAvailableDisagrees`.
- **No answer is called wrong in this mode.** This is the deliberate cost of the
  rule. A book-only miss reads "Not the book's line", with the second line
  "Mortal isn't loaded, so this isn't graded as wrong." Training value is
  preserved (the book's answer and rationale are still shown); only the
  condemnation is withheld until a second perspective exists.
- The block shows the book column at full weight and a muted Mortal column
  reading "unavailable", never an empty space, so the layout does not shift when
  the model arrives.
- Recovery is automatic: `initializeAi` retry, or the next puzzle, upgrades the
  mode. A submitted answer is re-graded in place.
- `Ungraded` is reserved for the Mortal-only drill with no model (only reachable
  by importing an `ai_best_action` report in a broken build). It renders "Not
  graded — Mortal isn't loaded", never a check or a cross.

### 6. Book rationale moves into Rust, next to the trigger enums

React stops containing game knowledge. Every trigger/reason variant gets an
exhaustive match — so adding a variant without handling it is a compile error,
not an empty panel — but only variants the book actually argues for carry a rule
statement, a citation, and a quote. Variants that encode the *absence* of a
justification return `None` and get a plain "not this hand" note instead:

```rust
// src/rationale.rs, beside the exhaustive `rationale()` impls for the enums
// in `src/state.rs`
pub struct RuleText {
    /// One-sentence statement of the rule, in the trainer's words.
    pub rule: &'static str,
    /// Short verbatim quote from the book (<= 25 words), LaTeX macros stripped
    /// to plain text: `{\jap tanyao}` reads "tanyao".
    pub quote: &'static str,
    /// Where the rule and quote come from.
    pub citation: Citation,
}

pub struct Citation {
    pub book: &'static str,          // "Riichi Book 1"
    pub chapter: u8,                 // 7
    pub chapter_title: &'static str, // "Riichi judgement"
    pub section: &'static str,       // "Chiitoitsu not waiting for dora"
    pub source_file: &'static str,   // "RiichiBook1-ch7-riichi.tex"
    pub source_line: u32,            // 349, informational only
    /// Substring that appears verbatim in `source_file` (LaTeX macros and all),
    /// used by a test to detect source drift. This is the *raw* form of `quote`.
    pub source_needle: &'static str, // "waiting for 4,5,6"
}

impl RiichiTrigger {
    pub fn rationale(self) -> RuleText { /* exhaustive match */ }
}
impl ShouminkanTrigger {
    pub fn rationale(self) -> RuleText { /* exhaustive match */ }
}
impl DamaReason {
    /// `None` for reasons that are the *absence* of a Riichi justification
    /// (`no_tanyao`, `no_red_five_wait`, `no_suji_trap`): the book states nothing
    /// positive to cite, so the UI must not pretend it does.
    pub fn rationale(self) -> Option<RuleText> { /* exhaustive match */ }
    /// One line explaining an absent justification, e.g.
    /// "No red five wait, so that Riichi justification does not apply."
    pub fn absent_note(self) -> Option<&'static str> { /* exhaustive match */ }
}
```

`src/rationale.rs` only assembles — it adds the scenario-level summary and the
"why this hand" line, which is the one part that must read the state:

```rust
pub struct BookRationale {
    /// What the scenario is teaching, e.g. "Keep the side-wait protorun."
    pub summary: String,
    /// One entry per rule the book actually states for this answer.
    pub rules: Vec<BookRule>,
    /// Riichi justifications that do not hold here. No quote, no citation: the
    /// book never argued for them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub absent: Vec<AbsentRule>,
    /// Primary source for the scenario as a whole.
    pub source: Citation,
    /// Straightforward caveats, e.g. the chankan risk on a kakan.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub caveats: Vec<String>,
}

pub struct BookRule {
    /// Trigger id, e.g. "dealer" or "good_wait_and_value".
    pub id: String,
    pub rule: String,
    pub quote: String,
    pub citation: Citation,
    /// Why this hand satisfies the rule, in one line.
    pub applies: String,
}

pub struct AbsentRule {
    pub id: String,
    pub note: String,
}

pub fn rationale_for(state: &GameState) -> Option<BookRationale>;
```

`rationale_for` is attached at the single generation boundary, not inside each
generator, and recomputed on import:

- `generator::generate_puzzle` sets `state.book_rationale = rationale_for(&state)`
  after dispatch;
- `WasmMortalEvaluator::generate_ai_puzzle` does the same for the drill;
- `report::parse_report` recomputes it (same "never trust a recomputable value"
  rule already used for the verdict and `human_readable`).

`rationale_for` returns `None` when a scenario has no book rule (the drill) or
when there is neither a trigger list nor a category rule to render (a bare or
imported state). The UI then renders the book column as "No book rule for this
hand", not as blankness.

#### Citation plan, verified against the checked-out book

Every quote below was read in `/home/kylehipke/workspaces/RiichiBooks`. Chapter
titles are the `\chapter{}` lines; section names are the headings immediately
above the cited text. Line numbers are hints for reviewers and must not be
asserted by tests.

**`chiitoitsu_riichi_vs_dama` — Riichi triggers.** All six come from one box,
ch7 *Riichi judgement*, §"Chiitoitsu not waiting for dora",
`RiichiBook1-ch7-riichi.tex:345-356` (`\label{ch:riichi}`):

| trigger | rule | quote | needle |
| --- | --- | --- | --- |
| `dealer` | Being the dealer justifies Riichi on a chiitoitsu that is not waiting on dora. | "You are the dealer;" | `You are the dealer` |
| `tanyao` | Tanyao justifies Riichi even with an awkward wait. | "You have tanyao;" | `You have {\jap tanyao}` |
| `red_five_wait` | Holding the red five means the wait is the regular five, which justifies Riichi. | "You have one red five, waiting for a regular five;" | `waiting for a regular five` |
| `suji_trap` | A suji-trap wait justifies Riichi because the wait looks safe to opponents. | "The wait is a suji-trap wait;" | `trap wait` |
| `wait_outside_456` | A single wait other than 4/5/6 justifies Riichi. | "The wait is any tile other than 4, 5, 6;" | `any tile other than 4, 5, 6` |
| `score_below_mangan` | A hand worth less than mangan without Riichi justifies Riichi. | "The score without riichi is below mangan." | `below {\jap mangan}` |

Two of these have a second, better specific example that is worth using as the
`applies` line rather than the box text: `red_five_wait` — ch7:401 "waiting for a
5 is not ideal, but having a red five justifies riichi"; `tanyao` — ch7:385
"Waiting for a 6 is not ideal, but having tanyao justifies riichi". The
`wait_outside_456` rule's *reason* is at ch7:430-436 ("4,5,6 tiles make for the
worst kind of single wait… your opponents are not very likely to discard
them"), which is the right `applies` text for that one. `suji_trap`'s definition
lives in ch8 *Defense judgement*, §"Understanding suji" / "Suji trap",
`RiichiBook1-ch8-defense.tex:163` (`\label{ch:defense}`): "When you wait for a
tile that is a suji tile of some tiles you have discarded yourself, we say you
have a suji-trap wait." Use that as the quote for the rule and the ch7 box item
as the citation for the *decision*.

**`chiitoitsu_riichi_vs_dama` — Dama reasons.** ch7:359 states the dama case
directly: "the only two cases where you should go dama are (a) when you are a
non-dealer and you are waiting for 4,5,6, and (b) you have honitsu (Half Flush) or
chinitsu (Full Flush) chiitoitsu."

Only three of the six `DamaReason` variants are things the book actually argues.
The generator emits all six on every dama hand, but four of them are the *absence*
of a Riichi justification, and presenting them as book rules would invent
citations. Split them:

| reason | book support | rule / note | quote | needle |
| --- | --- | --- | --- | --- |
| `not_dealer` | positive (half of case a) | Non-dealer halves the dama condition. | "when you are a non-dealer" | `when you are a non-dealer` |
| `middle_wait` | positive (half of case a) | A 4/5/6 single wait is the worst kind, and together with non-dealer it is the book's dama case. | "waiting for 4,5,6" | `waiting for 4,5,6` |
| `mangan` | positive (case b / §High scoring hand) | A hand already worth mangan keeps its value without Riichi. | "it is OK to go dama" (ch7, §High scoring hand) | `it is OK to go {\jap dama}` |
| `no_tanyao` | **absent** | "No tanyao, so that Riichi justification does not apply." | — | — |
| `no_red_five_wait` | **absent** | "No red five waiting on the five, so that justification does not apply." | — | — |
| `no_suji_trap` | **absent** | "No suji of the wait in the river, so the trap justification does not apply." | — | — |

`rationale()` returns `Some` for the first three and `None` for the last three;
`absent_note()` provides the one-liners. The book column renders `rules` as
"The book's reasons" and `absent` as a short "Not this hand" list, with no quote
and no citation chip — which is exactly the honesty AGENTS.md asks for.

Also worth putting in `caveats`: the book's case (b) is specifically
honitsu/chinitsu chiitoitsu, not "mangan" in general. The generator uses the
broader mangan test for its dama branch; say so in `applies` ("already mangan, at
or above the book's 5200/7700 cut-point") rather than claiming the book says any
mangan hand should stay dama.

**`shouminkan_decision`.** ch9 *Melding judgement*, §"From an open set to an open
quad (kakan)", `RiichiBook1-ch9-call.tex:360-371` (`\label{ch:call}`), four bullet
conditions:

| trigger | rule | quote | needle |
| --- | --- | --- | --- |
| `good_wait_and_value` | Extend when the hand is close to ready with a good wait and at least two han. | "the hand is 1-away or better with a good wait, and it has two han or more" | `two {\jap han} or more` |
| `late_game` | Extend when there are few draws left. | "the hand is 1-away or better, and there are not many turns left to draw tiles" | `not many turns left` |
| `placement_desperation` | Extend when dora or minipoints are needed to improve placement, especially South-4. | "you need more dora or minipoints to improve the placement (especially in South-4)" | `improve the placement` |
| `losing_badly` | Extend when losing badly. | "you are losing badly." | `losing badly` |

Caveat to include verbatim in `caveats` (ch9:362): "this is riskier than making a
concealed quad because you may be running the risk of giving your opponents a
chance to get chankan (Robbing the Kong)". Also note which thresholds are the
trainer's, not the book's: the generator requires `shanten == 0` (the book says
"1-away or better"), `tiles_remaining < 20` with every river at 13+ for
`late_game`, a 2,000-point gap for `placement_desperation`, and a 12,000-point
gap for `losing_badly`. The book gives no numbers for the last three; the
`applies` text must say "the trainer treats this as …" rather than implying the
book defines it.

**`ryanmen_protorun`.** This scenario has no trigger list, so the rationale is
scenario-level, with two rules. Note the lesson is *which tile to discard* under
`TargetAction::NaniKiru`, even though `correct_action` is a `Dama { discard }`
value; the book column's headline must say "keep the ryanmen" and cite ch4/ch3
tile efficiency, not ch7 riichi judgement. The `dama` action type is an encoding
detail of "concealed discard", not the teaching point.

1. *Redundant tile.* ch4 *The five-block method*, §"Finding a redundant tile",
   box "Five-block method" (`RiichiBook1-ch4-five.tex:44,55-61`,
   `\label{ch:five}`): "(2) each block has at most three tiles"; and the worked
   example's reasoning at line 44: "`tong2` is completely redundant; the hand can
   accept `tong3` without having `tong2`." Rule: from the three-tile `XXY`/`XYY`
   shape, the duplicated tile is the redundant one; keeping it duplicates a tile
   the hand can already use.
2. *Keep the side-wait protorun.* ch3 *Riichi mahjong basics*, §"Protoruns",
   `RiichiBook1-ch3-basics.tex:205` (`\label{ch:basic}`): "a side-wait (ryanmen)
   protorun can accept twice as many tiles as a closed-wait (kanchan) protorun or
   an edge-wait (penchan) protorun can." Rule: discarding the duplicate leaves
   `XY`, a live side-wait; any other discard destroys the ryanmen or the head.

Supporting quote for "don't make a block too weak" (ch4:48 footnote): "any block
that is weaker than a side-wait protorun is a weak block." Use it in `applies`,
not as the headline rule.

This scenario needs no schema change to gain a rationale: its rules are
category-keyed in `rationale_for`, not trigger-keyed. If more tile-efficiency
scenarios land later, add a `DiscardReason` enum and move these two rules onto
it (Future Work).

**`ai_best_action`.** No book rule. `rationale_for` returns `None`; the scenario's
manifest grading is `MortalOnly` and the book column renders "No book rule — this
is a Mortal drill." Do not fabricate a citation.

### 7. `ai_best_action` becomes a declared Mortal-only drill

Under the new rule, a scenario with no book perspective can never produce
`NeitherAgrees`, so keeping it in the default rotation would quietly exempt one
puzzle from the app's own promise. Options considered:

- *Drop the scenario.* Rejected: it is the only source of call/reaction decisions
  (chi, pon, agari, pass) and the only end-to-end test of the encoder on reaction
  states; `src/generator/ai_best_action/` carries over a thousand lines of
  validation tests.
- *Pretend the book agrees with Mortal.* Rejected: it fabricates a citation and
  makes the book column meaningless exactly where the model is strongest.
- *Keep it and grade book-only.* Impossible: there is no book answer.

**Recommendation: keep it, declare it.**

- Add `grading` to `ScenarioMeta` and to the serialized manifest:
  `pub enum ScenarioGrading { BookAndMortal, MortalOnly }`; `ai_best_action` is
  `MortalOnly`, the other three are `BookAndMortal`.
- `pickRandomScenario` excludes `MortalOnly` scenarios from the "All scenarios"
  pool (they stay selectable by name). Selecting "All" then always means "a
  lesson with both perspectives", which is what the new UI promises.
- The drill uses `GradingMode::MortalOnly` and grades against `correct_action`
  (which *is* Mortal's answer, including the second-pass Riichi discard). Its
  toast is explicitly labelled: "Mortal drill — graded by the model alone."
  This is a declared, visible exception to the both-disagree rule, not a silent
  one. It is the only mode where a single perspective may produce a negative
  verdict, and the UI says so in the same sentence.
- `CorrectAction::Best` stays, because the drill still needs it and because
  imported reports in the wild contain `best` answers.

What breaks, concretely:

- `App.tsx`'s `isAiScenario` branching disappears; `ActionBar` becomes gated on
  `availableActions.length > 0` (reaction states) rather than on `ai_decision`.
- `AiDecisionExplanation.tsx` is deleted; the drill's ranking lives in the
  Mortal column.
- `toggleRiichi`'s `correct_action.type === 'best'` special case and
  `submitChoice` remain, but now produce a `SubmittedAnswer` and route through
  the Rust grader.
- `pickRandomScenario(options, aiReady)` gains a third exclusion rule; its
  existing "exclude AI until ready" behaviour is unchanged.
- `tests/wasm_tests.rs::test_list_scenarios_payload` must assert the new
  `grading` field.

### 8. Grading lives in Rust, because there is no JS test runner

`frontend/package.json` has only `dev`, `build`, `lint`, `preview`: no vitest, no
jest. Adding one is a dependency addition (out of scope) and would put the very
rules AGENTS.md keeps out of React *into* React. So:

- `src/verdict.rs` owns comparison, normalization, and the outcome mapping.
- `src/rationale.rs` owns the book text and citations.
- The store calls one WASM function and stores the result; it formats nothing
  that decides correctness.
- Tests are `cargo test --lib` (fast, no browser) plus `cargo test --test
  wasm_tests` for the boundary. The React side is covered by `npm run build`,
  `npm run lint`, and a manual QA matrix — the same bargain `scenario-report-plan.md`
  struck, and it holds here for the same reason: the correctness logic moved
  somewhere testable instead of being duplicated.

## Data Model Changes

### Rust payloads

```rust
// src/verdict.rs — new
pub struct BookGrade {
    pub is_action_correct: bool,
    pub is_tile_correct: bool,
    pub expected_action: CorrectActionType,
    pub expected_tile: String,
}

pub struct DualGrade {
    pub mode: GradingMode,
    /// None for a Mortal-only drill.
    pub book: Option<BookGrade>,
    /// None when no evaluation exists.
    pub mortal: Option<MortalGrade>,
    pub outcome: AnswerOutcome,
}

pub fn grade_answer(
    state: &GameState,
    answer: &ReportedAction,
    evaluation: Option<&Evaluation>,
) -> DualGrade;

pub fn grade_answer_json(request_json: &str) -> Result<String, String>;
```

```rust
// src/lib.rs — new WASM export, matching the report module's style
#[wasm_bindgen]
pub fn grade_answer_json(request_json: &str) -> String;
// request: {"table": GameState, "answer": ReportedAction, "evaluation": Evaluation|null}
// success: DualGrade JSON; failure: {"error": "..."}
```

The request carries the whole `GameState` because the book side needs
`correct_action` and the drill side needs `category`; it is already client-side
and `evaluate` already round-trips the same object.

### `GameState` additions

```rust
/// Book rationale for this scenario's `correct_action`, rendered from the
/// trigger lists and the scenario rule table. Derived: recomputed at generation
/// and on report import.
#[serde(default, skip_serializing_if = "Option::is_none")]
pub book_rationale: Option<crate::rationale::BookRationale>,
```

It belongs in `GameState`, not in a side channel, because (a) it is a pure
function of the state plus static book text, (b) it must travel with the state
into reports and the AI drill, and (c) `#[serde(default)]` keeps every existing
fixture and imported report parseable. It is roughly the size of the existing
trigger arrays, so payload growth is negligible.

### Scenario manifest

```rust
pub enum ScenarioGrading { BookAndMortal, MortalOnly }

pub struct ScenarioMeta {
    // ...existing fields...
    pub grading: ScenarioGrading,
}
```

Serialized into `list_scenarios()` as `"grading": "book_and_mortal" | "mortal_only"`,
mirrored in `frontend/src/scenarios.ts`.

## File-by-File Changes

### Rust

| file | change |
| --- | --- |
| `src/verdict.rs` (new) | `PerspectiveResult`, `AnswerOutcome`, `GradingMode`, `BookGrade`, `MortalGrade`, `MortalConfidence`, `DualGrade`; `grade_answer`, `grade_answer_json`; red-five + tile/action comparison; unit tests. |
| `src/rationale.rs` (new) | `BookRationale`, `BookRule`, `AbsentRule`, `rationale_for`; assembly, caveats, scenario summaries; citation tests. |
| `src/state.rs` | `RuleText`/`Citation` beside the trigger enums; `impl {RiichiTrigger, DamaReason, ShouminkanTrigger}::rationale()`; `book_rationale` field on `GameState`. |
| `src/generator/mod.rs` | `ScenarioGrading` in `ScenarioMeta` + manifest JSON; attach `book_rationale` in `generate_puzzle`; tests for grading field and rationale coverage. |
| `src/ai/wasm_bridge.rs` | Attach `book_rationale` in `generate_ai_puzzle` (or call a shared `generator::finalize_state`). |
| `src/report/model.rs` | `ReportVerdict` gains `outcome`, `mode`, `mortal: Option<MortalVerdict>`; `ReportedAi.peeked_before_answer`. |
| `src/report/mod.rs` | `REPORT_VERSION = 2`; build/parse call `verdict::grade_answer`; import derives the mortal side from `report.ai.evaluation`; warning comparison limited to book fields. |
| `src/report/verdict.rs` | `evaluate` delegates to `verdict::grade_answer`; `answer_tile_visible` unchanged; add `book_equivalent` for v1 comparison. |
| `src/report/summary.rs` | Replace the single `Verdict:` line with `Book:` / `Mortal:` / `Outcome:` lines and the book quote + citation. |
| `src/lib.rs` | `pub fn grade_answer_json`, re-exports (`DualGrade`, `AnswerOutcome`, `BookRationale`, ...). |
| `src/bin/dual_verdict_survey.rs` (new, phase 0) | Native survey: N hands per scenario, real weights, tallies agreement/confidence/latency. |

`src/ai/finalize.rs::normalize_mortal_action` and
`src/report/mod.rs::{mortal_action_for_correct, probability_for_action}` are
reused, not duplicated; `mortal_action_for_correct` moves to `verdict.rs` and is
re-exported from `report` for the existing call sites.

### Frontend

| file | change |
| --- | --- |
| `src/types/verdict.ts` (new) | Mirrors `AnswerOutcome`, `GradingMode`, `BookGrade`, `MortalGrade`, `DualGrade`. |
| `src/types/game.ts` | `book_rationale?: BookRationale \| null` (+ `BookRationale`/`BookRule`/`Citation` mirrors). |
| `src/types/report.ts` | `ReportVerdict` additions; `REPORT_VERSION = 2`. |
| `src/store/useGameStore.ts` | `submittedAnswer`, `dualGrade`, `peekedBeforeAnswer`; seed `evaluation` from `ai_decision`; `requestEvaluation(state)` + retry loop; `regrade()`; `gradeAnswer()` calling the WASM export; `AnswerFeedback` retained as a view-model derived from `DualGrade` (rename `isCorrect` → `bookIsCorrect` and `isTileCorrect` → `bookIsTileCorrect`, add `outcome`). |
| `src/App.tsx` | Delete `isAiScenario` explanation branching; render the new block for every puzzle; call `requestEvaluation` via the store on load; `ActionBar` gated on available actions; `HandDock` uses `revealMortal`. |
| `src/components/ScenarioExplanation.tsx` | Rewrite: renders `state.book_rationale` (summary, rules, quotes, citation chips, caveats); no hard-coded label maps. |
| `src/components/VerdictPanel.tsx` (new) | The two-column comparison block; pre-answer status/peek; post-answer full view; Mortal loading/error/retry; owns the ranking expansion (uses `ActionRanking`). |
| `src/components/AiEvaluatorPanel.tsx` | Delete. |
| `src/components/AiDecisionExplanation.tsx` | Delete. |
| `src/components/FeedbackToast.tsx` | Switch on `DualGrade.outcome`; new copy table; three tone classes; keep `role="status"`/`aria-live`. |
| `src/components/HandDock.tsx` | `revealAi` → `revealMortal`; badges gated on answered-or-peeked; dashed ring for Mortal's tile post-answer. |
| `src/components/ReportBanner.tsx` | Show the dual outcome; keep the existing app/reporter/Mortal vocabulary. |
| `src/report.ts` | Add `outcomeLabel`; keep `mortalActionFor*`/`probabilityForAction` as display-only helpers; export uses the stored `submittedAnswer`. |
| `src/App.css` | `.dual-verdict` grid, book/mortal column styles, outcome chip tones, `feedback-toast--contested`, citation chip, peek button, dashed mortal tile ring. |
| `README.md` | Short section: what the two columns mean, why a split answer is not wrong. |

## UI

Placement is unchanged structurally: header → `ReportControls` → `ReportBanner`
→ toast → `TableInfo` → **dual verdict block** → 4-row `table-stack` → action bar
(drill only) → `HandDock`. The block replaces both `ScenarioExplanation` and
`AiDecisionExplanation`, so it sits exactly where they did.

App max width is 680px (`App.css`), two columns fit comfortably at 360px; below
340px the grid collapses to stacked rows.

### Post-answer (book and Mortal disagree, player chose the book)

```text
+----------------------------------------------------------+
| YOUR ANSWER   Riichi . discard 3p                        |
+---------------------------+------------------------------+
| BOOK   ch7 Riichi         | MORTAL  mortal_298k          |
|        judgement          |         41% . Medium conf.   |
| Riichi . 3p               | Discard 5s                   |
| check action  check tile  | cross  not Mortal's pick     |
|                           | 2nd: Riichi 19% . 3p 12%     |
| Non-dealer waiting 4,5,6  |                              |
| "waiting for 4,5,6 ..."   | [ Full ranking ]             |
| [ Why this rule ]         |                              |
+---------------------------+------------------------------+
| MORTAL'S LINE - not wrong. Mortal would play 5s;        |
| the book teaches Riichi here.                           |
+----------------------------------------------------------+
```

- Column headers are the provenance labels: `BOOK` plus chapter/section, and
  `MORTAL` plus the exact weights filename (already the model identity in
  `Evaluation.model`).
- Tile visuals: `Tile` for `Discard_<tile>` and for the book's discard/Kan tile;
  `RiichiStick` for a `Riichi` recommendation; text for calls. Same tile is
  rendered once per column, so a match is visually identical in both.
- Each column shows its own check/cross row. There is no shared "correct" mark;
  that is the whole point.
- The book column always contains at least the summary; `[Why this rule]`
  expands the per-trigger rules, quotes, and citation chips
  (`ch7 . Riichi judgement . Chiitoitsu not waiting for dora`). Absent
  justifications render as a short "Not this hand" list with no citations, so
  the column never implies the book argued for something it did not.
- The Mortal column's ranking is collapsed behind `[Full ranking]` (reuse
  `ActionRanking`) so the default view stays short on a phone.
- The outcome band under the columns is the single sentence that settles the
  verdict, in the vocabulary from §1.

### Pre-answer

```text
+----------------------------------------------------------+
| Mortal has an opinion about this hand.                   |
| Answer first, or [ Peek ].                               |
+----------------------------------------------------------+
```

States: loading ("Mortal: loading the model once (~43 MB)…"), thinking
("Mortal: thinking about this hand…"), unavailable ("Mortal unavailable — this
hand is graded against the book only. [Retry]"). No action names, no
probabilities, no ranking, no per-tile badges.

### Mortal unavailable, answered

```text
+---------------------------+------------------------------+
| BOOK   ch7 Riichi ...     | MORTAL  unavailable          |
| Riichi . 3p               | mortal_298k.safetensors      |
| check action  check tile  | HTTP 404 . [ Retry ]         |
| "waiting for 4,5,6 ..."   |                              |
+---------------------------+------------------------------+
| BOOK ANSWER. Mortal isn't loaded, so this is graded      |
| against the book only.                                   |
+----------------------------------------------------------+
```

### Feedback toast copy, by outcome

| outcome (mode) | headline | second line |
| --- | --- | --- |
| `BothAgree` | Correct | "The book and Mortal agree." |
| `BookAgreesMortalDoesNot` | Book answer | "Mortal would play Discard 5s (41%)." |
| `MortalAgreesBookDoesNot` | Mortal's line | "The book says Riichi, discarding 3p." |
| `NeitherAgrees` | Incorrect | "Neither the book nor Mortal picks this." (`+ " Mortal is nearly split here."` when `confidence == Low`) |
| `OnlyAvailableAgrees` (book) | Book answer | "Mortal isn't loaded, so this is graded against the book only." |
| `OnlyAvailableDisagrees` (book) | Not the book's line | "Mortal isn't loaded, so this isn't graded as wrong." |
| `OnlyAvailableAgrees` (drill) | Matches Mortal | "Mortal drill — graded by the model alone." |
| `OnlyAvailableDisagrees` (drill) | Off Mortal's line | "Mortal drill — graded by the model alone." |
| `Ungraded` | Not graded yet | "Mortal isn't loaded, so this hand can't be graded." |

The existing per-part check/cross rows stay, but now sit inside their own column:
the book row keeps `Action` / `Discard` sub-grades; the Mortal row shows one
match mark plus the probability. Only `NeitherAgrees` uses
`feedback-toast--incorrect`.

### HandDock

Post-answer, the book's answer tile keeps the solid
`hand-tile-button--answer` ring and Mortal's recommended discard gets a dashed
`hand-tile-button--mortal` ring (both rings when they coincide, plus a small
"both" tag). Pre-answer, nothing new is shown; the existing probability badges
are gated on `feedback !== null || peeked`.

## Report and Export Impact

- **`REPORT_VERSION` 1 → 2.** Technically the new verdict fields could be
  additive with serde defaults, and v1 files would still deserialize. The bump is
  about *semantics*, not parsing: a v2 report was produced under always-on Mortal
  and dual grading, so `verdict.outcome` is meaningful and `ai` is present unless
  the model failed. A reader that treats `decision.verdict.is_correct` as "the
  user was wrong" is already wrong in v1 when Mortal was never run; in v2 it can
  tell. Encoding that in `version` is cheaper than a separate flag.
- **`ReportVerdict`** keeps its three existing booleans with their existing
  meaning (**book**), so every v1 reader and the committed fixture keep working,
  and gains:
  ```rust
  pub outcome: AnswerOutcome,
  pub mode: GradingMode,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub mortal: Option<MortalVerdict>,   // recommends, agrees, probability, confidence
  ```
- **`AiComparison` unchanged.** `app_action` / `reporter_action` /
  `ai_agrees_with_*` keep their exact meaning (argmax equality), which under §2
  is exactly `mortal.agrees` for the book side. Leaving it byte-compatible keeps
  `ReportBanner` and `verify_report` working.
- **`ReportedAi`** gains `#[serde(default)] peeked_before_answer: bool`.
- **`human_readable`** replaces `Verdict: CORRECT|INCORRECT (…)` with three lines:
  ```text
  Book: AGREES - Riichi, discarding 3p
    Rule: non-dealer waiting 4,5,6 (Riichi Book 1 ch7, Chiitoitsu not waiting for dora)
  Mortal: DISAGREES - recommends Discard_5s (41%); answer scored 12%
  Outcome: book_agrees_mortal_does_not (not wrong)
  ```
  `human_readable` is explicitly non-authoritative, so this alone would not force
  a bump; the verdict schema does.
- **Import stays compatible.** v1: all new fields default, the recomputed book
  fields are compared (not the whole struct) so no spurious "saved verdict
  disagrees" warning, `mortal` is derived from `ai.evaluation` when present, and
  `outcome` is recomputed. v2 read by an old build is rejected with the existing
  "Unsupported report version" message — acceptable for a client-only app whose
  stale tabs are short-lived.
- **`verify_report`** prints the dual verdict and exits non-zero only on an
  invalid file, not on `NeitherAgrees` (a disputed answer is the point).

## Testing

Rust native (`cargo test --lib`):

- `src/verdict.rs`
  - `outcome_table_is_total` — all nine `(book, mortal)` pairs map as the matrix
    says, including both `Unavailable` on one side.
  - `only_neither_agrees_is_wrong` — asserts `is_wrong(outcome)` over every
    variant and every mode.
  - `red_five_answer_matches_its_plain_tile` — `Discard_5mr` vs `5m` and the
    reverse; probability is the sum of both entries, not one.
  - `riichi_agreement_ignores_the_discard_tile` — answer Riichi + any tile vs a
    `Riichi` recommendation is `Agrees`; the book side still records the tile
    miss.
  - `book_only_never_returns_a_wrong_verdict` — `BookOnly` + book miss yields
    `OnlyAvailableDisagrees`, and `is_wrong` is false.
  - `mortal_drill_grades_against_correct_action` — `MortalOnly`, `Best { Riichi,
    tile }`, answer on the wrong tile is a miss; answer on the right tile agrees,
    including with only `ai_decision`-seeded probabilities.
  - `unavailable_evaluation_produces_ungraded_for_a_drill`.
- `src/rationale.rs`
  - `every_positive_variant_has_a_rule_and_citation` — exhaustive match over each
    enum; `RiichiTrigger`/`ShouminkanTrigger` all return `RuleText`, and
    `DamaReason` returns `Some` for `not_dealer`/`middle_wait`/`mangan` and `None`
    (with an `absent_note`) for the other three.
  - `every_manifest_scenario_with_a_book_rule_produces_a_rationale` — generate
    each scenario once; `book_rationale.is_some()` for the three book lessons and
    `is_none()` for the drill. A dama hand must carry exactly three `rules`
    entries and three `absent` entries, so a silently dropped reason fails the
    test.
  - `citations_point_at_real_sources` — reads
    `$RIIICHI_BOOK_SRC/RiichiBook1-ch*.tex` (default
    `/home/kylehipke/workspaces/RiichiBooks`), asserts each `source_needle`
    appears in its `source_file`; **skips with a printed note when the directory
    is absent**, matching the weights-test pattern in `wasm_bridge.rs`.
- `src/report`
  - `v1_fixture_parses_without_warnings` — commit
    `tests/fixtures/scenario_report_v2.json` alongside; assert the v1 fixture
    still loads and produces no "saved verdict disagrees" warning.
  - `v2_round_trip_preserves_dual_verdict` — build → serialize → parse → equal
    `outcome`, `mode`, `mortal`, and recomputed `human_readable`.
  - `summary_prints_both_perspectives` — asserts the `Book:` / `Mortal:` /
    `Outcome:` lines and the citation line.
  - `import_derives_mortal_from_embedded_evaluation` — a report with `ai` but no
    live model still yields a `mortal` grade.
- `src/bin/dual_verdict_survey.rs` (phase 0, not a test)

WASM / browser (`wasm-pack test --headless --chrome`, `tests/wasm_tests.rs`):

- `grade_answer_json_round_trip` — generate a book puzzle, answer it with the
  book's action, grade with `null` evaluation, assert
  `mode == "book_only"`, `outcome == "only_available_agrees"`.
- extend `test_list_scenarios_payload` for the `grading` field.
- `generate_puzzle` payloads all contain `book_rationale` for book lessons.

Frontend (no test runner; deliberate):

- Gates: `npm run build`, `npm run lint`.
- Manual QA matrix: each scenario × {answer matches book, matches Mortal,
  matches neither, matches both where possible} × {model ready, model failed,
  answer before evaluation lands}. Check the toast headline, column marks, chip
  colour, and that no pre-answer surface shows an action name or probability.
- A dev-only assertion in `VerdictPanel`: the rendered headline is looked up from
  `outcome` via a `Record<AnswerOutcome, string>`, so a missing case is a compile
  error rather than a blank toast.

Verification gates, unchanged from `scenario-report-plan.md`:

```bash
cargo fmt --check
cargo test --lib
cargo clippy --lib --tests -- -D warnings
cargo check --target wasm32-unknown-unknown
wasm-pack test --headless --chrome
wasm-pack build --target web
cd frontend && npm run build && npm run lint
```

## Implementation Phases

Each phase after 0 is independently shippable; the app works at every boundary
(phase 3 ships a dual verdict with the old panel still present, phase 4 only
changes presentation).

**Phase 0 — measurement and verification (no user-visible change).**

- Instrument `WasmMortalEvaluator::new` and `evaluate()` wall-clock in the
  browser (`performance.now()` around the calls, dev-only, exposed on
  `window.__riichiMetrics`) and record desktop + one phone. Decide whether a
  Worker is needed. **All latency figures in this document are unmeasured.**
- Add `src/bin/dual_verdict_survey.rs`: N=200 hands per book scenario with the
  real weights, tallying
  `{both, book_only, mortal_only, neither, mortal_missing}`, Mortal confidence in
  the disagreement cases, and mean evaluation ms. Record the numbers in the phase
  0 PR description and in an Implementation Notes section appended to this file —
  the split rate decides how noisy the UI feels.
- Verify every citation by hand against the checked-out LaTeX (done for this
  document; re-verify after any generator change) and land the
  `citations_point_at_real_sources` test.
- Gate: survey runs, numbers recorded, gate list green.

**Phase 1 — Rust verdict core.**

- `src/verdict.rs` + `grade_answer_json` + `lib.rs` export; full native test
  suite. No UI change; the store does not call it yet.
- Gate: `cargo test --lib`, clippy, fmt, wasm build.

**Phase 2 — Rust rationale.**

- `RuleText`/`Citation` on the enums, `src/rationale.rs`, `GameState.book_rationale`,
  attach at generation + `generate_ai_puzzle`, `ScenarioGrading` in the manifest,
  recompute on import.
- Rewrite `ScenarioExplanation.tsx` as a pure renderer. Book explanations gain
  citations in the old panel position; Mortal still behind the button.
- Ship check: `ryanmen_protorun` and `shouminkan_decision` finally explain
  themselves.

**Phase 3 — store wiring and eager evaluation.**

- `submittedAnswer`, `dualGrade`, `gradeAnswer()`, evaluation seeded from
  `ai_decision`, `requestEvaluation` + retry loop, re-grade on evaluation
  arrival, `revealMortal` gating (fixes the pre-answer badge leak).
- `FeedbackToast` switches on `outcome`. This is the first user-visible verdict
  change; keep `AiEvaluatorPanel` for this phase but gate its `evaluation` prop on
  `feedback !== null || peeked`, the same rule as `HandDock`, so phase 3 does not
  ship a pre-answer leak.
- Gate: manual QA for all outcomes using the phase 0 knowledge of which
  scenarios produce which split.

**Phase 4 — presentation.**

- `VerdictPanel.tsx` (two columns, outcome band, peek, status states), delete
  `AiEvaluatorPanel.tsx` and `AiDecisionExplanation.tsx`, HandDock rings, CSS.
- Gate: portrait QA at 320/360/680px, keyboard focus on Peek/Retry/expanders,
  screen-reader announcement contains the outcome word.

**Phase 5 — report v2.**

- `ReportVerdict` additions, `REPORT_VERSION = 2`, `summary.rs`, import
  compatibility, `scenario_report_v2.json` fixture, `ReportBanner` dual outcome,
  `verify_report` output.
- Gate: export v2 → import → identical board, `outcome`, and no warnings; import
  the v1 fixture → book-only grade, no warnings.

**Phase 6 — drill re-scope.**

- `pickRandomScenario` exclusion, drill copy, book-column "no book rule" state,
  README.
- Gate: "All scenarios" never yields `ai_best_action`; selecting it by name still
  works and is labelled.

**Phase 7 — cleanup.** Remove `LEGACY_LABELS` duplication where it now has a
single source, delete dead props, update `scenario-report-plan.md`'s version
references, note the new module in the README architecture section.

## Edge Cases

- **Answer submitted before the evaluation lands.** Grade `BookOnly`
  immediately; re-grade in place when the result arrives. The toast must not
  flicker from "Not graded" to a verdict — hence `BookOnly` (not `Ungraded`) is
  the pre-evaluation state for book lessons.
- **Puzzle changes during the pass.** The identity guard discards the stale
  result and the one-slot retry evaluates the new state. Never attach an
  evaluation to a different `gameState` object.
- **Peek then new puzzle.** `peekedBeforeAnswer` resets in `emptyState`.
- **Report import while loading.** `importReport` already fires
  `evaluateWithAi` when ready; switch it to `requestEvaluation` so it also seeds
  from `ai_decision`.
- **Imported v1 report, no `ai`.** Book-only grade plus a banner line; the
  import path must not invent a Mortal column value.
- **Imported v2 report from a newer build.** Rejected by the existing version
  check.
- **`mock_table` and unknown categories.** `rationale_for` returns `None`;
  book column shows "No book rule for this hand" rather than an empty box.
- **Missing/corrupt weights mid-session.** `aiStatus === 'error'`, existing
  evaluation cleared on the next load, mode degrades; Retry re-runs
  `initializeAi`.
- **`ai_best_action` without a model.** The drill still grades `MortalOnly`
  against the `best` action captured at generation, with
  `MortalConfidence::Unknown` and no probabilities. `Ungraded` remains only for
  a state with neither perspective. Do not treat `correct_action` as a book rule
  to fall back on.
- **Red-five ties.** Two taps of `5m` (one red) are indistinguishable by code, so
  both agree with either variant. This matches the current `selectTile`
  behaviour; keep the clicked `tile_index` in `submittedAnswer` for reports only.
- **Tile that is both the book answer and Mortal's answer.** One ring with a
  "both" tag, not two overlapping outlines.

## Risks

- **The disagreement rate may be high** (`unmeasured, instrument in phase 0`). If
  Mortal disagrees with the book on most chiitoitsu hands, the block will read as
  noise. Mitigation: show `MortalConfidence` and `close_second`, and treat the
  survey number as a go/no-go input for the copy, not for the taxonomy.
- **Always-on inference on low-end phones** could stall the UI. Mitigation:
  phase 0 gate before phase 3; Worker in Future Work with a scoped design
  (`generate_ai_puzzle` moves with the model).
- **The 43 MB fetch becomes load-bearing.** It is already unconditional in
  `App.tsx`, so the network cost itself is unchanged; what changes is that a
  failed or slow fetch now affects every hand's verdict rather than an optional
  extra. Mitigation: the `BookOnly` mode is complete, not a stub, and the column
  says exactly what is missing.
- **Book quote drift.** A one-sentence quote can fall out of date if a scenario's
  rule is re-encoded. Mitigation: `source_needle` test, and a reviewable
  `RuleText` block next to each enum.
- **Copyright.** The app ships one short quote per rule, not book text; the full
  PDF is not bundled. Keep quotes under ~25 words and cite chapter + section.
- **Semantic version bite.** A v2 report read by an old tab fails to import.
  Accepted for a client-only app; the error message already explains it.
- **Taxonomy creep.** Seven outcomes invite an eighth. Rule: a new outcome must
  be a new cell in the 3×3 matrix, or it is copy, not a verdict.
- **`human_readable` consumers.** `verify_report` and any external agent parsing
  the old `Verdict:` line must be updated in the same phase as the summary
  change.

## Future Work

- **Web Worker evaluation** if phase 0 shows >~100–150 ms passes or visible
  frame stalls. Design: worker owns `WasmMortalEvaluator`, main thread sends
  `{requestId, state}` and receives `{requestId, evaluation}`; `generate_ai_puzzle`
  moves with it; the store's `requestEvaluation` becomes a promise map.
- **`DiscardReason` enum** for tile-efficiency lessons so `rationale_for` stops
  keying on `category`.
- **Probability-band grading**, if the survey shows top-1 flips are frequent at
  low confidence. Would require a version bump to the verdict, and the plan's
  copy-first approach is the cheaper experiment.
- **Book-vs-Mortal calibration report**: aggregate the survey into a static
  table of "areas where this trainer and Mortal disagree", which is genuinely
  useful teaching material.
- **Peek analytics in reports** (already recorded) promoted into
  `verify_report`'s summary so a reviewer knows whether the reporter had seen
  Mortal's line.

## Open Questions

- Whether the phase 0 disagreement rate justifies keeping the book scenarios'
  current trigger distributions at all. If Mortal rejects the book answer on, say,
  half the dama hands, the scenario itself may need revisiting — but that is a
  generator question, deliberately out of scope here.
- Whether Peek should be global (a session setting) or per-puzzle. This plan
  chooses per-puzzle and resets on load; making it global is a one-line change if
  users ask.

Resolved during implementation: **there is no Mortal quote.** The policy net
emits no text (`AiDecision.reasoning` is always absent), so `human_readable`
prints a book quote and only Mortal's action and probabilities. Writing prose
for Mortal would be the trainer's words, not a quotation, and the plan's
non-goal forbids narrating the disagreement.

## Acceptance Criteria

- Answering any book scenario shows two columns: a book recommendation with at
  least one rule, a quote, and a chapter/section citation; and a Mortal
  recommendation with its probability and model identity.
- "Incorrect" appears if and only if both the book and Mortal reject the answer.
  A reviewer can confirm this by answering with Mortal's pick on a known split
  hand and seeing no negative verdict.
- No "Evaluate with AI" button exists anywhere; Mortal is evaluated on load for
  every book scenario, and the payload's ranking is reused for the drill.
- Before answering, no surface reveals Mortal's action name, probability, or
  per-tile badges, except via the explicit Peek affordance.
- With the weights removed, the app still trains: book column renders, Mortal
  column says unavailable with Retry, no answer is labelled wrong, and importing
  a report still works.
- Every scenario in the manifest produces a `book_rationale` when it has a book
  rule, and `ai_best_action` is visibly marked as a Mortal-only drill and excluded
  from the "All scenarios" pool.
- Exporting produces a v2 report whose `verdict` carries `outcome`, `mode`, and
  `mortal`; importing either the v1 fixture or the new v2 fixture yields the same
  board, no spurious warnings, and a coherent `human_readable` block.
- The 4-row stacked table, hand dock, and portrait layout are unchanged, and the
  two-column block collapses below 340px.
- All verification gates pass, and `cargo test --lib` covers the outcome matrix,
  red-five normalization, Riichi tile semantics, book-only neutrality, and
  citation presence.


## Implementation Notes

- Where the pieces landed: `src/verdict.rs` (dual grading, red-five and
  tile/action comparison, `grade_answer_json`), `src/rationale.rs`
  (`RuleText`/`Citation` plus the exhaustive `rationale()` impls for the three
  trigger enums, and `rationale_for`), `GameState::book_rationale`,
  `ScenarioGrading` in the scenario manifest, `REPORT_VERSION = 2`.
- The rationale types live in `src/rationale.rs` rather than directly under the
  enums in `src/state.rs`. The compile-time guard is unchanged: each enum's
  `rationale()` match is exhaustive, so a new variant fails to build.
- Reports recompute the rationale on both build and import, so a stale embedded
  block cannot survive a round trip.
- Three of the six `DamaReason` variants are treated as *absent* justifications
  (`no_tanyao`, `no_red_five_wait`, `no_suji_trap`): no quote, no citation. The
  other three carry book citations.
- Pre-answer Peek reveals **Mortal only**. The book rationale is itself the
  answer's explanation ("Declare Riichi…"), so showing it before the answer
  would leak the book side.
- A Mortal drill without a model still grades against the stored `best` action
  (MortalOnly, `unknown` confidence, no probabilities) instead of `Ungraded`.
- The kakan lessons added on `main` merged in cleanly: the new `needs_dora`
  trigger carries the ch9 placement clause, and `shouminkan_decline` gets a
  category rationale quoting the book's "since it is 2-away from ready, calling
  kan ... is not justifiable" example. The exhaustive match in `rationale.rs`
  refused to compile until `needs_dora` was handled, which is the intended
  guard.
- `REPORT_VERSION` is 2. `tests/fixtures/scenario_report_v2.json` is committed
  next to the v1 fixture; the v1 fixture still imports without warnings because
  the importer compares only the book fields.
- The v1 report booleans keep their book meaning for book lessons, so
  `ReportBanner`, `verify_report`, and the fuzz runner are unchanged. For a
  Mortal drill they grade the drill's `best` answer (Mortal's), and
  `expected_tile` still carries the discard/kan tile.
- `AiComparison.ai_agrees_with_*` now normalizes red fives before comparing, so
  a `Discard_5mr` recommendation agrees with an app answer of `Discard_5m`.
  The field keeps its argmax-equality meaning; only the red-five corner case got
  more correct.
- Gates run: `cargo fmt --check`, `cargo test --lib` (154 tests),
  `cargo clippy --lib --tests -- -D warnings`, `cargo check --target
  wasm32-unknown-unknown`, `wasm-pack build --target web`, `npm run build`,
  `npm run lint`.
- Phase 0 measurement is still outstanding: no weights file was present in the
  worktree, so the survey and latency numbers are not recorded. Nothing in the
  design depends on them, but the Web Worker decision does.
