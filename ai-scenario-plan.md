# AI Best Action Scenario Plan

Status: implemented (v1). Chankan and the nine-terminals draw are included;
multiple-kan selection and model-provided prose reasoning remain deferred.

This document describes a new scenario type where the app generates a random,
valid table state in which the human faces **any supported decision** (discard,
Riichi, win, or a call), and the correct answer is **whatever the loaded Mortal
v4 model says is best**. The explanation is either the model's reasoning (if a
future model provides it) or the attribution line:

> Best answer per `<model>`

followed by the full ranked report of every legal action, reusing the existing
AI evaluation styles.

The work is split into small, independently verifiable tasks. Do not start a
task until the previous task's verification gate passes.

---

## 1. Goal

Add a scenario with:

- A randomized, deck-consistent four-player table.
- A human decision drawn from a supported matrix:
  - self-turn discard,
  - Riichi vs. dama,
  - tsumo / ron,
  - chi (low / mid / high),
  - pon,
  - daiminkan / ankan / kakan,
  - pass.
- `correct_action` equal to the model's highest-probability legal action.
- A payload that contains every legal action and the model's probability for
  each, so the UI can:
  - render the available call buttons before answering,
  - show the full ranked report after answering,
  - attribute the answer to the exact loaded model.
- No game logic in React. The model runs in Rust/WASM, as it does today.

Non-goals for v1:

- Replaying a full hand after the decision (no follow-up discard after a call).
- A model that writes prose reasoning.
- Multiple simultaneous kan choices (`OFF_AT_KAN_SELECT`).
- Chankan and nine-terminals draw are deferred to an optional final task.
- Changing the existing lesson generators or their answers.

---

## 2. Current gaps

These are the concrete blockers in the current code:

1. **The state is self-turn-only.**
   `GameState` (`src/state.rs`) assumes `players[0]` is acting, with an optional
   `draw` as the 14th tile. There is no way to say "react to player 3's discard
   of `4m`" or "react to an added kan".

2. **The legal-action mask excludes calls by design.**
   `legal_action_mask` (`src/ai/wasm_bridge.rs`) only marks hand discards, red
   fives, Riichi, and agari. Its own comment says calls belong to reaction
   states that do not exist yet.

3. **The encoder leaves call features at zero.**
   `encode_decision_features` (`src/ai/encoder.rs`) does not populate
   `OFF_CALL_TILE`, `OFF_CAN_CHI`, `OFF_CAN_PON`, `OFF_CAN_DAIMINKAN`,
   `OFF_CAN_ANKAN`, `OFF_CAN_KAKAN`, or `OFF_AT_KAN_SELECT`. A reaction state
   would be encoded as an ordinary self-turn position and the model would score
   the wrong actions.

4. **The answer vocabulary is lesson-specific.**
   `CorrectAction` only supports `riichi`, `dama`, `kan`, and `discard`.
   `CorrectActionType` and the frontend grader have the same limitation.

5. **The frontend only supports one decision shape.**
   `HandDock` offers a Riichi toggle, an Added-Kan toggle, and tile taps.
   `useGameStore.selectTile` infers the selected action from those toggles.
   There is no generic call bar, and `AnswerFeedback` compares only an action
   family plus one tile.

6. **The answer is not model-derived.**
   `generate_puzzle` is model-free. The model is loaded separately in the
   frontend, and `evaluateWithAi` is an optional user action, not part of
   generation.

7. **The AI panel would spoil the puzzle.**
   `AiEvaluatorPanel` is always visible, shows the top actions before answering,
   and `HandDock` renders probability badges. For a model-defined answer, that
   displays the answer. The new scenario must hide both until after submission.

---

## 3. Core design decisions

### 3.1 The model decides at generation time

The scenario payload is finalized in Rust:

```text
random decision-ready state
  -> encode -> Mortal forward pass
  -> legal-action mask + softmax
  -> argmax
  -> correct_action + available actions + full ranking
  -> JSON to React
```

React never decides which action is correct and never needs to run the model to
grade an AI puzzle. The model remains loaded once in `WasmMortalEvaluator`;
generation is exposed as a method on that evaluator:

```rust
#[wasm_bindgen]
impl WasmMortalEvaluator {
    pub fn generate_ai_puzzle(&self, category: &str) -> Result<String, JsValue>;
}
```

Native tests and future CLIs use a plain function:

```rust
generator::ai_best_action::generate(
    model: &MortalV4Model,
    model_name: &str,
    category: &str,
) -> Result<GameState, String>
```

`generate_puzzle("ai_best_action")` must return a clear error explaining that
the scenario needs a loaded evaluator. It must not silently fall back to
`ryanmen_protorun`.

### 3.2 The state describes the decision, not the lesson

Add a `DecisionContext` to `GameState`:

```rust
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DecisionContext {
    /// Normal turn: the human has `hand` plus `draw`, and must discard.
    #[default]
    SelfTurn,
    /// The human may call or ron the last discard of `from`.
    ReactToDiscard { from: usize, tile: String },
    /// The human may ron an added kan (deferred).
    ReactToKan { from: usize, tile: String },
}
```

Invariants:

- `SelfTurn`: `current_turn == 0`, `players[0].draw.is_some()`, concealed count
  is `14 - 3 * meld_count`.
- `ReactToDiscard`: `current_turn == from`, `players[0].draw.is_none()`,
  concealed count is `13 - 3 * meld_count`, and `players[from].discards.last()`
  is `tile`.
- `ReactToKan`: same shape as a reaction, with the added-kan tile.

The model encoder already reads `state.players[0]`; it now also reads
`state.decision` to fill the call rows.

### 3.3 One legal-action resolver is the source of truth

Create `src/ai/actions.rs` (split into submodules if it grows past ~350 lines).
The shared payload types live in a small top-level `src/decision.rs` so
`state.rs` does not have to depend on the `ai` module:

```rust
// src/decision.rs
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionKind { Discard, Riichi, Chi, Pon, Kan, Agari, Ryukyoku, Pass }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KanKind { Daiminkan, Ankan, Kakan }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActionInfo {
    /// Mortal action name, e.g. `Discard_3m`, `Riichi`, `Chi_Low`, `Pon`,
    /// `Kan`, `Agari`, `Ryukyoku`, `Pass`.
    pub action: String,
    /// Human-readable label, e.g. `Discard 3m`, `Chi 2m 3m on 4m`.
    pub label: String,
    /// Coarse family understood by the frontend. Serialized as `type` so the
    /// existing AI panel keeps its JSON contract.
    #[serde(rename = "type")]
    pub kind: ActionKind,
    /// Mortal's 0..=33 tile index for discards; `None` for calls.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tile_index: Option<usize>,
    /// Base tile code for tile actions (`5m`, not `5mr`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tile: Option<String>,
    /// Additional concrete tiles consumed by a call (chi).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tiles: Vec<String>,
    /// Which kan shape is offered (open / added / closed).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kan_kind: Option<KanKind>,
}

pub fn legal_actions(state: &GameState) -> Vec<ActionInfo>;
pub fn legal_action_mask(state: &GameState) -> Vec<bool>;
pub fn action_index(action: &str) -> Option<usize>;
```

`legal_actions` is used by all of these, so they cannot drift:

- `legal_action_mask` (model masking),
- `encode_decision_features` (observation features),
- the generator's validation ("the model's argmax is an action we can render"),
- the payload's `available_actions` (call buttons),
- grading (match the player's choice to a known action),
- the ranked report labels.

Replace the existing `wasm_bridge::legal_action_mask` and `describe_action` with
re-exports or move all callers to `ai::actions`. Keep the old public names
working if it is cheap; otherwise update the small number of call sites.

#### Action semantics

| Mortal index | Action | Concrete meaning |
| --- | --- | --- |
| 0..=33 | `Discard_<tile>` | Discard the tile code. |
| 34..=36 | `Discard_<tile>r` | Discard the red five; normalized to the base tile for grading. |
| 37 | `Riichi` | Declare Riichi. The answer also needs a discard (see 3.6). |
| 38 | `Chi_Low` | The called tile is the low tile: consume `v+1, v+2`. |
| 39 | `Chi_Mid` | The called tile is the middle tile: consume `v-1, v+1`. |
| 40 | `Chi_High` | The called tile is the high tile: consume `v-1, v-2`. |
| 41 | `Pon` | Consume two copies from hand. |
| 42 | `Kan` | One of daiminkan / ankan / kakan. |
| 43 | `Agari` | Ron or tsumo. |
| 44 | `Ryukyoku` | Nine terminals (deferred). |
| 45 | `Pass` | Decline a call or ron. |

The chi mapping must be verified against `libriichi` while implementing Task 2,
with table-driven tests for called tiles 3, 4, 5, 6, and 7. Do not guess and leave
it untested.

#### Legality rules

`legal_actions` implements, at minimum:

- **Discards:** every tile code in `hand` + `draw`, deduplicated, with red-five
  variants when the corresponding `red_fives` entry is held.
- **Riichi:** self-turn, menzen (only ankans), tenpai, score >= 1000, wall >= 4,
  not already Riichi.
- **Agari:** self-turn when `hand + draw` is a winning hand; reaction when
  `hand + claimed_tile` is winning with at least one yaku and the hand is not
  furiten.
- **Chi:** only from kamicha (relative seat 3), suited, sequence within 1..9,
  and the human holds the two other tiles.
- **Pon:** reaction, human holds two copies of the claimed tile.
- **Daiminkan:** reaction, human holds three copies.
- **Ankan:** self-turn, human holds four copies.
- **Kakan:** self-turn, human has an open Pon and the fourth copy.
- **Pass:** any reaction state.
- **Ryukyoku:** deferred; mask it off in v1 unless the final optional task is
  taken.
- **Furiten:** a winning tile in the human's own river blocks ron.
- **Riichi hands:** a Riichi player may ron or pass only; chi/pon/kan disabled.

If a state has more than one kan candidate, the generator rejects it in v1.
`legal_action_mask` still marks the single `Kan` index, but the UI cannot ask
which kan to use yet.

### 3.4 Accept the argmax; do not rejection-sample the model

The expensive step is the Candle forward pass. Do **not** generate a hand,
evaluate it, and re-roll because the answer is not what a human lesson would
expect. That would be both slow and contrary to the feature.

Instead:

1. Construct a **decision-ready** state whose legal action set is fully
   representable by the UI.
2. Do cheap structural rejection **before** inference:
   - deck/copy consistency,
   - correct concealed hand size,
   - reaction tile present as the last discard,
   - at least two legal actions (avoid a trivial one-button puzzle),
   - at most one kan candidate,
   - no unsupported action families.
3. Run the model **once**.
4. Take the argmax as the answer.
5. Only if the forward pass errors or produces no legal action, build another
   candidate (small fixed retry count, e.g. 3).

This means a generated puzzle can be a surprising or even dubious Mahjong
decision. That is the feature: the model is the oracle. The UI must label it as
the model's recommendation, not ground truth.

### 3.5 Extend `CorrectAction` with a `best` variant

Do not overload `riichi`/`dama`/`kan`/`discard` with call meanings. Add one new
tagged variant, leaving all existing shapes byte-for-byte compatible:

```rust
#[serde(tag = "type", rename_all = "lowercase")]
pub enum CorrectAction {
    Riichi { discard: String },
    Dama { discard: String },
    Kan { tile: String },
    Discard { tile: String },
    /// AI scenario: the model's top action, with any concrete tiles needed
    /// to render or grade it.
    Best {
        /// Mortal action name, e.g. `Pon`, `Chi_Low`, `Discard_3m`.
        action: String,
        /// Base tile code for discard/pon/kan/agari answers.
        #[serde(skip_serializing_if = "Option::is_none")]
        tile: Option<String>,
        /// Additional tiles consumed by a call (chi).
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        tiles: Vec<String>,
        /// Human-readable label, e.g. `Chi 2m 3m on 4m`.
        label: String,
    },
}
```

`CorrectActionType` gains `Best`. Change `CorrectAction::tile()` to return
`Option<&str>` because `Pass` has no tile, and update the handful of callers.
Where an existing generator test knows the variant is a legacy tile action, use
`.tile().expect("legacy action has a tile")`.

The frontend `CorrectAction` union and `actions.ts` validator gain `best`.
Legacy scenarios keep their current payload shape and grading behavior.

### 3.6 Riichi semantics

Mortal's action space has a single `Riichi` action, but the trainer grades one
action plus a tile. Define the answer as:

1. Run the model on the state.
2. If the top action is **not** `Riichi`, the answer is the normal action.
3. If the top action **is** `Riichi`:
   - clone the state with `players[0].is_riichi = true`,
   - evaluate again with the `Riichi` action masked off,
   - take the highest-probability **discard** action from that second pass
     (ignore any non-discard action that is also legal there),
   - the answer is `Best { action: "Riichi", tile: <discard>, ... }`.

The ranked report still shows the first evaluation, including `Riichi` at the
top. The answer card shows `Riichi — discard <tile>`. The second pass models the
post-declaration discard decision as closely as the current encoder allows. Add
a note in code that this is a two-step approximation, because the app presents
one answer.

If the second pass has no legal discard (should be impossible with a 14-tile
hand), reject the candidate.

### 3.7 Red-five grading

`Discard_5mr` and `Discard_5m` are separate model actions but the UI taps a tile
code. Grade by base tile:

- normalize the model's red-discard recommendation to `Discard_5m`,
- keep the raw model action in `ai_decision.recommended_action` for the report,
- accept a tap on any `5m` for a red-five recommendation.

The ranked report can show the raw red/normal entries separately, because that
is what the model actually scored. Document the normalization in the answer
label so it is not surprising.

### 3.8 Model attribution and reasoning

The loaded weights filename is the model identity:

- Extend `WasmMortalEvaluator::new` to accept `model_name: &str`.
- Store the name on the evaluator.
- Add `model: String` to `Evaluation`, populated by the evaluator.
- Add `reasoning: Option<String>` to the AI decision payload.

The frontend explanation renders:

- `reasoning` when present,
- otherwise exactly `Best answer per <model>`.

The model name should be the filename without a path, e.g.
`mortal_298k.safetensors`. The UI may render `Mortal v4 · mortal_298k.safetensors`
if the evaluator supplies a display label, but the attribution line must contain
the exact model identity.

### 3.9 Spoiler control

The payload necessarily contains `correct_action` and the full ranking. The UI
must not reveal it before submission:

- For an AI scenario, hide the existing `AiEvaluatorPanel` until the answer is
  submitted. After submission, the AI explanation replaces it.
- Disable the `HandDock` probability badges for AI scenarios while
  `feedback === null`. The easiest implementation is to pass
  `aiEvaluation={null}` until answered, or add a `revealAi` prop.
- Do not render the ranked action list in the explanation until `feedback`
  exists; `App` already gates `ScenarioExplanation` on `feedback`.
- The call bar shows only action labels, never probabilities.
- Add a small note: "AI recommendation, not ground truth."

---

## 4. Data model changes

### 4.1 `GameState`

Add:

```rust
#[serde(default)]
pub decision: DecisionContext,

#[serde(default, skip_serializing_if = "Option::is_none")]
pub ai_decision: Option<AiDecision>,
```

`GameState` currently derives `Eq`. `AiDecision` contains `f32` probabilities,
so remove `Eq` from `GameState` (keep `PartialEq`). `PlayerState` can keep `Eq`.
Check for any map/set usage; there should be none.

Every existing `GameState { ... }` literal must add `decision:
DecisionContext::SelfTurn` and `ai_decision: None`. There are five production
literals plus test/fixture literals; the list is in section 9, Task 1.

`TargetAction` gains `Best` for the new scenario. Existing values are unchanged.

### 4.2 Action and decision payloads

Add a top-level `src/decision.rs` for the shared payload types:

- `ActionKind`, `KanKind`, and `ActionInfo` (section 3.3),
- `ActionEvaluation`, moved out of `ai::wasm_bridge`,
- `AiDecision`.

`src/state.rs` imports `AiDecision` from `crate::decision`, and `ai/actions.rs`
imports `ActionInfo`/`ActionKind`/`KanKind`. `ai::wasm_bridge` re-exports
`ActionEvaluation` so existing callers compile. This keeps the dependency
direction one-way: `state` and `ai` both depend on `decision`, never on each
other's payloads.

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AiDecision {
    /// Exact model identity, e.g. `mortal_298k.safetensors`.
    pub model: String,
    /// Optional model-provided explanation. `None` for the current policy net.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    /// Mortal's expected-value head for the position.
    pub expected_value: f32,
    /// Raw argmax, including a red-five suffix if applicable.
    pub recommended_action: String,
    /// Every legal action, highest probability first.
    pub evaluations: Vec<ActionEvaluation>,
    /// Every legal action with render/grade details, no probabilities.
    pub actions: Vec<ActionInfo>,
}
```

`ActionEvaluation` (moved to `src/decision.rs`, re-exported from
`ai::wasm_bridge`) gains a flattened `ActionInfo`. All payload types in
`decision.rs` must derive both `Serialize` and `Deserialize`, because
`GameState` embeds `AiDecision` and must still deserialize when the frontend
sends the state back to `evaluate`:

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActionEvaluation {
    #[serde(flatten)]
    pub info: ActionInfo,
    pub probability: f32,
}
```

This lets the frontend render a label and a probability from one object. The
existing `action`, `type`, and `tile_index` fields remain available through the
flattened info; keep the JSON field names stable where the existing panel uses
them. Add `label`, `tile`, and `tiles` fields. Update `frontend/src/types/ai.ts`
to match.

`available_actions` lives inside `ai_decision.actions` so legacy scenarios do not
grow a new top-level field. If the UI needs the actions before the ranking is
revealed, it can read `gameState.ai_decision.actions` and simply not render the
probabilities. Keep the action list deterministic: calls / Riichi / win / pass
first, then discards sorted by tile code. The `evaluations` list remains sorted
by probability, descending.

### 4.3 Scenario metadata

Add:

- `ScenarioCategory::AiDecision` -> `"ai_decision"`.
- `ScenarioMeta.requires_ai: bool`.
- `ScenarioId::AiBestAction` -> `"ai_best_action"`.
- Manifest entry:
  - label: `"AI Best Action"`,
  - description: `"Any decision: discard, call, or win — the answer is Mortal v4's top action."`,
  - category: `ai_decision`,
  - tags: `["ai", "mortal", "discard", "call", "any_decision"]`,
  - `requires_ai: true`.

`list_scenarios_json` serializes `requires_ai`. The frontend
`ScenarioOption` gains `requires_ai: boolean`, and `parseScenarioManifest`
validates it.

`ScenarioId::ALL` includes the AI scenario. `ScenarioId::generate` returns a
clear error for it. Update the existing registry tests:
- `list_scenarios` count changes from 3 to 4,
- the "every scenario generates" test skips the AI scenario and asserts its
  error,
- the manifest test verifies `requires_ai`.

---

## 5. Generation pipeline

### 5.1 Module layout

```text
src/generator/ai_best_action/
├── mod.rs          # public generate(), family selection, retry budget
├── table.rs        # random round, scores, dora, wall, opponent deal, rivers
├── self_turn.rs    # self-turn hand construction (discard, riichi, tsumo, kan)
├── reaction.rs     # reaction hand construction (chi, pon, kan, ron, pass)
├── validate.rs     # structural validity + deck conservation + representability
└── finalize.rs     # evaluate, choose answer, build AiDecision, assemble GameState
```

Keep every file under roughly 350 lines. Reuse:
- `support::deck::Deck` for copy limits and wall count,
- `support::table` for rounds/scores,
- `support::analysis` for shanten/ukeire,
- `support::format` for `hand_string`,
- `agari` for winning hands, yaku, furiten, and waits.

### 5.2 Candidate construction

Build a **table first**, then a decision-ready human hand, all from one `Deck`:

1. Choose a round (`East 1..South 2`), scores summing to 100,000, honba,
   riichi sticks, dora indicator, and ura indicator.
2. Deal three opponent hands and rivers from the same deck. Rivers are 3-15
   tiles; the discarder's last tile is reserved for a reaction state.
3. Build the human hand:
   - **Self turn:** concealed count `14 - 3 * meld_count`; put one tile in
     `draw`. The remaining tiles are filled from the deck.
   - **Reaction:** concealed count `13 - 3 * meld_count`; no `draw`. Reserve the
     claimed tile and any matching tiles in the human hand.
4. Mark at most one held five as red (human only, matching the current
   convention).
5. Draw a 14-tile dead wall from the deck. Expose one dora indicator and one ura
   indicator; keep the other twelve hidden but accounted for. Set
   `tiles_remaining = deck.remaining()` so the live wall is realistic (0..=70)
   instead of the raw remainder including the dead wall.
6. Compute `shanten`, `is_agari`, `ukeire_tiles`, `ukeire_total`, and
   `decompositions_count` with `agari`:
   - self turn: `hand + draw`,
   - reaction: `hand` for shanten/ukeire; `hand + claimed` for ron checks.

For a reaction state, `players[from].discards` must end with the claimed tile.
The human's river must not contain a winning tile for a ron state (no accidental
furiten). Opponent rivers should be plausible; do not put the claimed tile in
the human's river.

Opponent melds and riichi states are optional texture in v1. Start without them
in Task 5, add inexpensive random melds in Task 7 if they do not complicate deck
accounting. Do not set an opponent in Riichi for a call state in v1.

### 5.3 Decision families and phases

| Family | State | Expected legal actions | Phase |
| --- | --- | --- | --- |
| Pure discard | self turn, no Riichi/kan/agari | 2+ discards | Task 5 |
| Chi | reaction from kamicha | Chi_Low/Mid/High, Pass | Task 7 |
| Pon | reaction, pair held | Pon, Pass | Task 7 |
| Daiminkan | reaction, triplet held | Kan, Pass | Task 7 |
| Ron | reaction, winning + yaku, not furiten | Agari, possibly calls, Pass | Task 7 |
| Riichi / dama | self turn, menzen tenpai | Riichi, discards | Task 8 |
| Tsumo | self turn, winning hand | Agari, discards | Task 8 |
| Ankan / kakan | self turn, four copies / open Pon + fourth | Kan, discards | Task 8 |
| Chankan | reaction to added kan | Agari, Pass | Task 7 |
| Nine terminals | self turn, first draw | Ryukyoku, discards | Task 8 |

Task 5 deliberately avoids Riichi/kan/agari so the first vertical slice is a
pure discard decision. Later families reuse the same finalization path.

### 5.4 Validation

`validate.rs` runs before inference and returns `Result<(), String>`:

- Four players, human at seat 0, valid winds and seats.
- Exact concealed hand size for the meld count and decision context.
- Reaction: `current_turn == from`, no human draw, claimed tile is the last
  discard of `from`, claimed tile not in the human's hand beyond the legal
  copies.
- Self turn: human draw present, `current_turn == 0`.
- No tile copy exceeds 4 across hands, draws, melds, rivers, indicators, and
  the hidden dead-wall tiles.
- `tiles_remaining` equals the live wall after the 14-tile dead wall is
  reserved, and the ledger closes:
  `known_tiles + 14 + tiles_remaining == 136`.
- At least two legal actions.
- Every legal action is renderable:
  - `Chi_*` has concrete consumed tiles,
  - `Pon`/`Kan` have a concrete tile and kan kind,
  - `Agari` has a winning tile and ron/tsumo,
  - `Pass` has no tile,
  - `Riichi` has a hand that can discard.
- At most one kan candidate.
- For ron: the hand + claimed tile is a winning hand with at least one yaku, and
  the human is not furiten.
- For Riichi: menzen, tenpai, score >= 1000, wall >= 4.
- The finished table is a reachable position
  (`generator::support::state_validation::validate_reachable_state`, applied to
  every generated lesson, not just the AI one):
  - every player holds `13 - 3 * melds` concealed tiles, because a kan's fourth
    tile is the replacement draw;
  - every meld is a real shape (chi run, triplet, quad) called from a seat that
    could have discarded it (a chi only from the previous seat);
  - the rivers are the discards of one turn order: the walk starts at the dealer
    and advances one seat per discard, and only a call from a seat other than the
    previous one can move it, which is why equal rivers are *not* the normal
    case for a non-dealer human;
  - the decision context fixes the last discard: a self turn ends on Kamicha's
    discard (the human just drew), a reaction on the source's discard, and a
    chankan on the source's Kamicha's discard.

Generators must plan rivers with `support::table::river_counts` /
`self_turn_river_counts` instead of choosing a count per seat; that simulator
produces exactly the timelines the reachability check accepts.

Structural rejection uses `generate_with_retries("ai_best_action", 2_000, ...)`
or a tighter loop; this is cheap. Inference is **not** inside that loop.

### 5.5 Finalization

`finalize.rs`:

1. Call `evaluate_state(model, &candidate, model_name)`.
2. Verify the evaluation's actions match `legal_actions(&candidate)` exactly.
   If not, return an error and force a new candidate; this catches resolver /
   encoder drift.
3. Take `recommended_action`.
4. Map it to `CorrectAction::Best`:
   - normalize `Discard_5mr` -> `Discard_5m` for `tile`,
   - attach `tiles` for chi,
   - attach `kan_kind`-derived labels for kan,
   - for `Agari`, attach the winning tile and whether it is ron/tsumo,
   - for `Pass`, no tile.
5. If the recommendation is `Riichi`, run the second pass described in 3.6.
6. Build `AiDecision` with the raw recommendation, full evaluations, available
   actions, expected value, model name, and `reasoning: None`.
7. Set `target_action = TargetAction::Best`, fill the legacy trigger vectors
   empty, and assemble the final `GameState`.

The final state must satisfy:

```text
correct_action.action == ai_decision.recommended_action (normalized as documented)
correct_action is one of ai_decision.actions
ai_decision.evaluations covers every legal action
probabilities sum to 1.0 within tolerance
```

### 5.6 Error handling / retries

- Structural failure after the retry budget: return a clear generator error.
- Forward-pass error (e.g., NaN): build a new candidate up to 3 times; then
  return an error.
- No legal action after masking: same.
- Model unavailable: the frontend must not call the generator; see section 7.

---

## 6. Encoder and legal mask

### 6.1 Shared resolver

Refactor `encode_decision_features` to call `legal_actions(state)` and set:

- `OFF_CAN_RIICHI` when a `Riichi` action exists.
- `OFF_CAN_CHI + 0..2` for `Chi_Low/Mid/High`.
- `OFF_CAN_PON` for `Pon`.
- `OFF_CAN_DAIMINKAN` / `OFF_CAN_ANKAN` / `OFF_CAN_KAKAN` for the corresponding
  `KanKind`.
- `OFF_CAN_AGARI` for `Agari`.
- `OFF_CAN_RYUKYOKU` only if nine terminals is supported.
- `OFF_AT_KAN_SELECT` only if multiple kan choices are supported (v1: false).
- `OFF_DISCARD_CANDIDATES` only for `SelfTurn`; set rows for hand tiles and the
  self-riichi flag.
- `OFF_CALL_TILE` for `ReactToDiscard` / `ReactToKan`: set the claimed tile
  column, red flag if tracked, dora flag if the claimed tile is dora.

The encoder and mask must use the same resolver so a legal action cannot be
missing from the observation.

### 6.2 Reaction-state details

- Hand encoding already iterates `hand` and `draw`; a reaction state simply has
  no draw, so the hand is 13 minus melds.
- `OFF_WAITS`: for a tenpai 13-tile reaction hand, `ukeire_tiles` are the waits;
  the claimed tile is one of them for a ron state.
- `OFF_FURITEN`: compute from waits and the human's own discards.
- `OFF_SELF_RIICHI`: set if the human is already in Riichi; a Riichi player's
  call actions are masked by the resolver.
- Opponent rivers/melds already encode normally.

### 6.3 Claimed-tile UI

The UI should highlight the last discard of `from` when `decision.kind` is a
reaction. Add a `river-slot--claim` class to `PlayerRow` for that tile. This is
a small UI affordance, not game logic.

---

## 7. WASM API and model identity

### 7.1 `WasmMortalEvaluator`

Change the constructor:

```rust
#[wasm_bindgen(constructor)]
pub fn new(weights_bytes: &[u8], model_name: &str) -> Result<WasmMortalEvaluator, JsValue>;
```

Add:

```rust
#[wasm_bindgen]
pub fn generate_ai_puzzle(&self, category: &str) -> Result<String, JsValue>;
```

`generate_ai_puzzle`:

- validates `category == "ai_best_action"` (or dispatches through the AI module),
- calls `generator::ai_best_action::generate(&self.model, &self.model_name, category)`,
- serializes the final `GameState` to JSON.

Also extend `evaluate` to set `Evaluation.model = self.model_name`.

### 7.2 Native `Evaluation` changes

- Add `model: String` to `Evaluation`.
- Add `label`, `tile`, `tiles`, `kan_kind` through `ActionInfo`.
- Add an evaluation options path for the Riichi second pass:

```rust
pub struct EvaluationOptions<'a> {
    pub model_name: &'a str,
    pub forbid: &'a [usize],
}
pub fn evaluate_state_with_options(
    model: &MortalV4Model,
    state: &GameState,
    options: EvaluationOptions<'_>,
) -> candle_core::Result<Evaluation>;
```

Keep `evaluate_state(model, state)` as a wrapper using a default model name and
no forbidden actions, so existing tests and callers compile with minimal churn.
Update the existing tests to assert the model field and labels.

### 7.3 Frontend initialization

`initializeAi` passes the model filename:

```ts
const modelName = WEIGHTS_URL.split('/').pop() ?? 'Mortal v4';
const evaluator = new WasmMortalEvaluator(bytes, modelName);
```

The store keeps the evaluator. The AI scenario's payload carries the same name
through `ai_decision.model`.

---

## 8. Frontend behavior

### 8.1 Scenario routing and loading

Add a shared helper:

```ts
export function scenarioRequiresAi(category: string, scenarios: ScenarioOption[]): boolean;
```

`App.loadPuzzle`:

- If the selected scenario has `requires_ai === true`:
  - call `await initializeAi()` first,
  - read the evaluator from the store,
  - show a loading label such as `Asking Mortal…`,
  - call `evaluator.generate_ai_puzzle(category)` and pass the JSON to
    `loadFromJson`,
  - if the model failed to load, show the existing AI error with a retry, and do
    not call the generator.
- Otherwise, use the existing `generate_puzzle(category)` path.

For `All scenarios`:

- When `aiStatus !== 'ready'`, filter `requires_ai` scenarios out of the random
  pool so a first launch does not block on a 43 MB model.
- When ready, include them.
- If the pool becomes empty (not expected), fall back to the non-AI scenarios.

Respect the existing `loadRequestId` so a late model load or generation cannot
overwrite a newer puzzle.

### 8.2 Generic action bar

New `frontend/src/components/ActionBar.tsx`:

- Props:
  - `actions: AiActionInfo[]`,
  - `disabled: boolean`,
  - `selectedRiichi: boolean`,
  - `onAction: (action: AiActionInfo) => void`,
  - `onToggleRiichi: () => void` (or handle Riichi inside `onAction`).
- Render non-discard actions:
  - `Riichi` -> arm the Riichi toggle; a tile tap submits `Riichi + discard`.
  - `Chi_*` -> button with the consumed tiles in the label; one tap submits.
  - `Pon` -> one tap.
  - `Kan` -> one tap, label includes the kan kind.
  - `Agari` -> label `Win` / `Ron` / `Tsumo`; one tap.
  - `Pass` -> one tap.
- Do not render discard actions in the bar; `HandDock` handles them.
- Keep the existing Riichi/Kan toggles for legacy scenarios. For AI scenarios,
  the generic bar replaces the legacy toggles to avoid duplicate controls.

`HandDock` changes:

- New props: `availableActions`, `canDiscard`, `onSelectTile` (existing),
  `revealAi`.
- For AI scenarios:
  - if `canDiscard` is false (reaction state), disable tile buttons and change
    the hint to "Choose a call or Pass".
  - if `callRiichi` is armed, a tile tap submits `Riichi + tile`.
  - otherwise a tile tap submits `Discard_<tile>`.
  - probability badges are hidden until `revealAi` is true.
- For legacy scenarios, keep the current behavior exactly.

### 8.3 Store and grading

Add a generic choice type:

```ts
export interface PlayerChoice {
  action: string;        // Mortal action name
  tile?: string;         // clicked / claimed tile code
  tiles?: string[];      // chi consumed tiles
}
```

Add `submitChoice(choice: PlayerChoice)` to the store:

- If `gameState.correct_action.type === 'best'`:
  - find the chosen action in `gameState.ai_decision.actions`,
  - compare the action names, normalizing red-five discards to the base action,
  - for `Riichi` and discards, compare the tile code,
  - for chi, the action name is enough because the concrete tiles are fixed,
  - for pon/kan/agari/pass, the action name is enough,
  - set `AnswerFeedback` with labels and optional consumed tiles.
- Otherwise, delegate to the existing `selectTile` logic.

Extend `AnswerFeedback` with:

```ts
selectedLabel: string;
correctLabel: string;
selectedTiles: string[];
correctTiles: string[];
isMortalDecision: boolean;
```

Keep the existing fields for legacy feedback. `FeedbackToast` branches on
`isMortalDecision`:

- "You chose: Pon 5p" vs "Best per Mortal: Chi 2m 3m on 4m".
- No separate action/tile grades for a call; show the labels and a single
  correct/incorrect badge.
- For a discard or Riichi answer, the existing tile rendering can be reused.

`HandDock` highlighting:

- highlight `feedback.selectedTiles` / `feedback.correctTiles` when present;
- otherwise use the existing `selectedTile` / `correctTile` logic.

### 8.4 Explanation

New `frontend/src/components/AiDecisionExplanation.tsx`:

- Render only when `gameState.ai_decision` exists and `feedback` is present.
- Header:
  - `ai_decision.reasoning` when present,
  - otherwise `Best answer per {ai_decision.model}`.
- Subline: `Expected value {expected_value.toFixed(2)}`.
- Full ranked list of `ai_decision.evaluations`, not just the top 6:
  - label from `ActionInfo.label`,
  - probability bar,
  - top row highlighted,
  - red-five entries may appear separately.
- If the answer was Riichi, show `Riichi — discard {tile}` near the top.
- A note: "This scenario uses the model's top action as the answer. It is not a
  hand-written lesson and may disagree with human heuristics."

Extract the ranked-row rendering from `AiEvaluatorPanel` into a shared
`ActionRanking` component:

- `AiEvaluatorPanel` uses it with `limit={6}` and the "+N more" behavior.
- `AiDecisionExplanation` uses it with `limit={Infinity}` or an expandable list.

`ScenarioExplanation` continues to handle only `riichi`/`dama`; for `best` it
returns `null`, and `AiDecisionExplanation` renders instead.

### 8.5 UI gates for AI scenarios

In `App`:

- Hide `AiEvaluatorPanel` for AI scenarios before `feedback`; after `feedback`,
  render `AiDecisionExplanation` instead. Do not render both.
- Pass `aiEvaluation={null}` or `revealAi={feedback !== null}` to `HandDock`.
- Render `ActionBar` above `HandDock` for AI scenarios.
- Keep the table rows and `TableInfo` unchanged.
- Add the claimed-discard highlight to `PlayerRow` based on `decision`.

---

## 9. Task breakdown

Each task ends with a gate. Commit and push after a task passes.

### Task 1 — State model and payload types

Scope:

- Add `DecisionContext` and `TargetAction::Best`.
- Add `CorrectAction::Best` and `CorrectActionType::Best`.
- Change `CorrectAction::tile()` to an optional accessor; update callers/tests.
- Add `src/decision.rs` with `ActionInfo`, `ActionKind`, `KanKind`,
  `ActionEvaluation`, and `AiDecision`; re-export `ActionEvaluation` from
  `ai::wasm_bridge` for compatibility.
- Add `GameState.decision` and `GameState.ai_decision`; drop `Eq` from
  `GameState` if needed for `f32`.
- Update `frontend/src/types/ai.ts` and `frontend/src/types/game.ts` mirrors.
- Update all `GameState` literals:
  - `src/generator/block_theory/ryanmen_protorun/board.rs`
  - `src/generator/chiitoitsu_riichi_vs_dama/board/mod.rs`
  - `src/generator/shouminkan_decision/board.rs`
  - `src/fixtures/mock_table.rs`
  - `src/ai/wasm_bridge.rs` tests
  - `src/ai/encoder_test.rs`
- Add the matching TypeScript types and `isCorrectAction` validation for
  `best`; keep legacy shapes working.

Tests:

- Serde round-trip for `DecisionContext` and `CorrectAction::Best`.
- Legacy `GameState` serialization does not contain `ai_decision`.
- `CorrectAction::tile()` behavior for all variants.
- Frontend types compile.

Gate:

```bash
cargo fmt --check
cargo test --lib
cargo clippy --lib --tests -- -D warnings
cargo check --target wasm32-unknown-unknown
cd frontend && npm run build && npm run lint
```

### Task 2 — Shared legal-action resolver

Scope:

- Add `src/ai/actions.rs` (or a small submodule tree).
- Implement `legal_actions`, `legal_action_mask`, `action_index`, labels, chi
  mapping, furiten, ron yaku, riichi, kan kinds, and pass.
- Replace `wasm_bridge::legal_action_mask` and `describe_action` with re-exports
  or update all call sites.
- Keep the resolver behavior identical for existing self-turn states, with one
  intentional exception: the shared resolver now exposes now-legal kan actions
  (for example the Shouminkan lesson) and reaction calls to the AI report. That
  changes what `Evaluate with AI` lists for those states, but it must not change
  any lesson's generated `correct_action` or its UI grading.

Tests:

- Table-driven tests for every action family.
- Chi mapping for called tiles 3..7.
- Furiten blocks ron.
- Riichi requires menzen/tenpai/score/wall.
- Red-five mask behavior.
- Existing `wasm_bridge` mask tests still pass (possibly moved).

Gate: Rust gates above.

### Task 3 — Encoder reaction and call features

Scope:

- Use `legal_actions` in `encode_decision_features`.
- Populate `OFF_CALL_TILE`, `OFF_CAN_CHI`, `OFF_CAN_PON`,
  `OFF_CAN_DAIMINKAN`, `OFF_CAN_ANKAN`, `OFF_CAN_KAKAN`, `OFF_CAN_AGARI`,
  `OFF_CAN_RIICHI`, `OFF_CAN_RYUKYOKU`, `OFF_AT_KAN_SELECT`.
- Set `OFF_DISCARD_CANDIDATES` only for self-turn.
- Ensure `OFF_FURITEN`, `OFF_WAITS`, and `OFF_SELF_RIICHI` are correct for
  reaction states.

Tests:

- Reaction state: call tile, chi/pon/kan/ron flags, no discard candidates.
- Self-turn state: no call flags, discard candidates present.
- Resolver/mask/encoder consistency over a table of states.
- Existing encoder tests pass.

Gate: Rust gates.

### Task 4 — Evaluation enrichment and finalization primitives

Scope:

- Add `model` to `Evaluation`; add `ActionInfo` fields to `ActionEvaluation`.
- Add `EvaluationOptions` and `evaluate_state_with_options` for the Riichi
  second pass.
- Implement:
  - `evaluation_actions_match_legal_actions`,
  - `recommendation_to_correct_action`,
  - `build_ai_decision`,
  - red-five normalization.
- Add `model_name` to `WasmMortalEvaluator` and update the constructor.
- Update `initializeAi` to pass the weights filename.

Tests:

- Every action index maps to a non-empty label and a valid `ActionKind`.
- Red-five normalization.
- Riichi second pass picks a legal discard.
- `AiDecision` serialization and probability normalization.
- Existing model tests with real weights (skipped if missing).

Gate: Rust gates + frontend build/lint.

### Task 5 — AI scenario table builder and pure-discard generator

Scope:

- Add `src/generator/ai_best_action/{mod,table,self_turn,validate,finalize}.rs`.
- Implement random table construction with one deck, consistent wall count,
  opponent deal, rivers, dora/ura indicators, and scores.
- Implement the pure-discard family: self-turn, no Riichi/kan/agari, at least two
  discards.
- Implement `finalize` using the model and the Task 4 primitives.
- Add `WasmMortalEvaluator::generate_ai_puzzle`.
- Register `ScenarioId::AiBestAction`, `ScenarioCategory::AiDecision`,
  `ScenarioMeta.requires_ai`, and the manifest entry.
- `generate_puzzle("ai_best_action")` returns a clear error.
- Update `tests/wasm_tests.rs` manifest count and registry tests.
- Minimal frontend routing is **not** required yet; the scenario can be marked
  `requires_ai` and tested through native/WASM APIs. Until Task 6 lands,
  selecting it in the existing UI returns the clear backend error; that is
  expected for this intermediate commit.

Tests:

- Structural generation without inference: 200 candidates, assert invariants
  and deck conservation.
- With real weights (skip if missing): 20 generated puzzles, assert
  `target_action == Best`, `ai_decision` present, correct action is in the
  available actions, probabilities sum to ~1, and the recommended action is a
  discard.
- Error path when the model is not supplied / wrong category.

Gate: Rust gates + `cargo check --target wasm32-unknown-unknown`.

### Task 6 — Frontend `best` scenario rendering and grading

Scope:

- Add `ActionBar`.
- Extend `HandDock` with `availableActions`, `canDiscard`, `revealAi`, and the
  Ai-scenario discard/Riichi flow.
- Extend the store with `submitChoice`, `AnswerFeedback` fields, and `best`
  grading.
- Update `FeedbackToast` for mortal answers.
- Add `AiDecisionExplanation` with the attribution line and full ranking.
- Extract `ActionRanking` from `AiEvaluatorPanel` and reuse it.
- Hide `AiEvaluatorPanel` and probability badges for AI scenarios before the
  answer.
- Add the claimed-discard highlight in `PlayerRow`.
- Add minimal explicit routing in `App.loadPuzzle`: when the selected
  scenario has `requires_ai`, await `initializeAi`, then call
  `evaluator.generate_ai_puzzle`. Task 9 adds the polished all-scenarios
  filtering, loading label, and failure UX.

Tests/manual QA:

- Pure-discard AI puzzle: tap a tile, get correct/incorrect feedback, see the
  full ranking and the "Best answer per <model>" line.
- Spoiler check: before answering, no probabilities or recommended action are
  visible.
- Legacy scenarios still render and grade exactly as before.
- `npm run build`, `npm run lint`.

Gate: frontend build/lint + manual QA on the pure-discard scenario.

### Task 7 — Reaction decision generators

Scope:

- Implement `reaction.rs`:
  - chi (kamicha only, concrete consumed tiles),
  - pon,
  - daiminkan,
  - ron (winning + yaku + not furiten),
  - pass.
- Add the family selection in `mod.rs`.
- Validate reaction invariants and representability.
- Add optional inexpensive opponent melds only if deck accounting stays simple.

Tests:

- 20 model-backed generations per family (skip if weights missing).
- Structural tests for chi/pon/kan/ron/pass.
- Assert the claimed tile is the last discard of `from`, the hand size is 13
  minus melds, and no human draw.
- Assert at least one non-pass call is legal.
- Assert the correct action is one of the rendered actions.
- Resolver/encoder consistency for reaction states.

Gate: Rust gates + manual QA of each call button.

### Task 8 — Self-turn special decisions

Scope:

- Implement `self_turn.rs` families:
  - Riichi/dama (menzen tenpai),
  - tsumo (winning hand),
  - ankan,
  - kakan.
- Implement the Riichi second pass from 3.6.
- Reject multiple kan candidates in v1.
- Ensure the UI can submit the new actions without changes (the action bar is
  generic).

Tests:

- Model-backed generation for Riichi, tsumo, ankan, and kakan (20 each, skip
  without weights).
- Riichi answer has a discard and the second pass is deterministic.
- Tsumo answer is `Agari` when the model selects it; a model discard answer is
  still valid.
- Ankan/kakan answer includes the kan kind and concrete tile.
- No multiple-kan states.

Gate: Rust gates + manual QA of Riichi, Win, and Kan buttons.

### Task 9 — Loading, selection, spoiler audit, docs, and QA

Scope:

- `All scenarios` random pool excludes `requires_ai` until `aiStatus === 'ready'`.
- Explicit AI selection awaits the model and shows `Asking Mortal…`.
- Model load failure shows the existing AI error and does not clear the current
  puzzle unexpectedly.
- Respect `loadRequestId` for AI loads.
- Audit the AI scenario payload/UI for pre-answer leakage.
- Add a README section:
  - what the scenario is,
  - the model identity,
  - the "not ground truth" caveat,
  - how the answer is generated,
  - how to load/convert weights.
- Add a note to `scenario-report-plan.md` that the report format must accept
  `correct_action.type = "best"` and the model action vocabulary if/when it is
  implemented.
- Full manual QA matrix (see section 11).

Gate: all verification gates.

### Optional Task 10 — Deferred decisions and future model reasoning

- Chankan reactions (`ReactToKan`).
- Nine-terminals draw (`Ryukyoku`).
- Multiple kan selection (`OFF_AT_KAN_SELECT`) and a kan-choice UI.
- Model-provided `reasoning` if a text/reasoning model is added.
- Seeded generation for reproducible AI puzzles.
- Report export/import support for `best` answers.

---

## 10. Acceptance criteria

- The scenario picker lists `AI Best Action` and marks it as requiring the
  model.
- Selecting it loads the model if needed, generates a valid table, and presents
  a decision.
- The correct answer is the model's top legal action for the encoded position.
- Every legal action is rendered as a usable control:
  - discards via hand tiles,
  - Riichi via the Riichi control plus a discard,
  - chi via labeled buttons,
  - pon / kan / win / pass via buttons.
- Submitting an answer grades the action and, where applicable, the tile.
- After answering, the explanation shows:
  - `Best answer per <model>` (or the model's reasoning if present),
  - the full ranked list of every legal action with probabilities,
  - the expected value,
  - the chosen answer and the model's answer.
- Before answering, no probabilities, recommendation, or ranking are visible.
- Legacy scenarios behave exactly as before.
- The generator is deck-consistent: no tile copy exceeds four, hand sizes match
  melds, and `tiles_remaining` matches the live wall after the dead wall.
- All Rust, WASM, and frontend gates pass.

---

## 11. Verification gates

Run after every Rust task:

```bash
cargo fmt --check
cargo test --lib
cargo clippy --lib --tests -- -D warnings
cargo check --target wasm32-unknown-unknown
```

Run after WASM-facing changes:

```bash
wasm-pack test --headless --chrome
wasm-pack build --target web
```

Run after frontend changes:

```bash
cd frontend && npm run build && npm run lint
```

Manual QA matrix for the AI scenario:

- Pure discard: answer with the model's top discard, then a different discard.
- Riichi: model picks Riichi; verify the discard sub-answer.
- Tsumo: model picks Win.
- Ron: model picks Win from a reaction.
- Chi low / mid / high.
- Pon.
- Daiminkan.
- Ankan.
- Kakan.
- Pass.
- Model loading: select the AI scenario before weights finish; confirm the
  loading state and eventual puzzle.
- Model failure: block the weights request; confirm a useful error and that the
  app does not hang.
- All-scenarios random: confirm the AI scenario is only picked when ready.
- Legacy scenarios: one Riichi/dama and one Kan puzzle still grade correctly.
- Portrait mobile: action bar, hand dock, and explanation are usable.
- Spoiler audit: inspect the DOM before answering; confirm no probabilities or
  recommendation text.

---

## 12. Risks and edge cases

- **Forward-pass cost in WASM.** One pass per generation plus one for a Riichi
  answer. Show a loading state and avoid model-based rejection sampling.
- **Model/platform nondeterminism.** Do not assert exact probabilities in tests;
  assert legality, normalization, and recommendation consistency.
- **Payload size.** Only AI scenarios carry `ai_decision`; legacy payloads keep
  `ai_decision` absent.
- **Chi mapping.** Verify the low/mid/high convention against `libriichi` before
  trusting it; table-driven tests are mandatory.
- **Multiple kan choices.** Reject in v1; the model has one `Kan` action and the
  UI cannot select among candidates yet.
- **Riichi discard approximation.** The second pass is a pragmatic way to
  produce a single action + tile answer. Document it in code.
- **Red-five ambiguity.** Grade by base tile; keep the raw model action in the
  report.
- **Furiten and yaku.** Ron must be both structurally winning and legally
  callable. Use `agari` and the human's own river.
- **Deck conservation.** Build everything from one `Deck`; do not invent tiles
  after dealing. Indicators and ura indicators also consume copies.
- **Trivial puzzles.** Require at least two legal actions. For reaction states,
  require at least one real call/win in addition to `Pass`.
- **Spoilers.** The payload contains the answer. The UI must keep the ranking and
  probability badges hidden until submission.
- **Scenario regression.** Adding fields to `GameState` touches every generator
  literal. Do it once in Task 1 and keep legacy tests green.
- **`Eq` removal.** `AiDecision` contains `f32`; drop `Eq` from `GameState` only
  if necessary and verify no map/set keys are affected.
- **Model identity.** Always carry the exact weights filename so a report or
  screenshot can be traced to the model that produced the answer.

---

## 13. Pointers for the implementer

- The current mask is in `src/ai/wasm_bridge.rs`; the encoder call rows are in
  `src/ai/encoder.rs`. Move the shared logic into `src/ai/actions.rs` before
  writing a generator.
- `agari` already provides shanten, ukeire, decomposition, yaku, and scoring.
  Reuse `support::analysis` wrappers where possible.
- `Deck` in `src/generator/support/deck.rs` tracks copy limits; use it for every
  dealt tile and for `tiles_remaining`.
- `GameState` literals are in the three lesson board builders, the mock fixture,
  and the AI tests; update them all when adding fields.
- The frontend's `loadPuzzle` already has a `loadRequestId` race guard; reuse it
  for the model-gated AI path.
- The existing AI panel's `actionLabel` should be replaced by the Rust-provided
  `label`. Keep the TS fallback only for defensive rendering.
