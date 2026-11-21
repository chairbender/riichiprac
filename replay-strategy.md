# Replay strategy and offline miner (AI self-play only): sources, scenario design, and implementation plan

Status: research / design. No replay parser, miner, pack loader, or frontend
code was written in this pass. This is the **merged authoritative version** of
the replay analysis: it answers the six questions in task 261114-0906, folds in
the related capture `261112-1826` ("Real riichi game database as a scenario
source"), and incorporates the separate autonomous-miner agent specification
reviewed on 2026-11-14.

Implementation breakdown: [`replay-implementation-plan.md`](replay-implementation-plan.md)
turns this design into architecture components, an ordered unit sequence and a
proposed command-center task slice. Two stages there are normative requirements,
not options: mixed-agent corpora (§3.3 below) and scenario permutation (§5.9
below). It also corrects the model inventory: the 4.1a/b/c/3.0 Mortal networks
are online-service only; the one local checkpoint is `mortal_298k`.

> ## Decision (2026-11-14): AI self-play is the only replay source
>
> **We will not acquire, ingest, redistribute, or ship any third-party replay
> corpus — Tenhou, Mahjong Soul, Riichi City, Hime Mahjong, M-League, or any
> other human game-record service — and we will not ship scenarios derived from
> one.** This is a hard product decision, not a preference or a temporary
> default. It applies to raw logs, converted mjai/tenhou6 logs, mined
> `GameState` snapshots, labels, and evaluation data. No exception is planned
> for “research only”, “just a small sample”, or “we will anonymise it”.
>
> **The replay pipeline will be fed exclusively by AI self-play that we generate
> offline**, using Mortal (AGPL-3.0) and, where useful, Akochan as a second
> policy under its non-commercial output terms. The resulting games are ours to
> curate and publish as scenario packs. This also gives us direct control over
> the skill level, style and error distribution of the play: the Mortal
> checkpoint for strong lines, Akochan and heuristic policies for genuinely
> different play and realistic mistakes, and fixed seeds for reproducibility.
>
> **Consequences, all reflected below:**
>
> - no Tenhou/Mahjong Soul permission track, no scraping, no community dataset
>   ingestion, no human-game corpus;
> - no “human expert line” scenario family and no bring-your-own-replay feature
>   in this plan;
> - every published pack has `source.kind: "ai_selfplay"` and a provenance row
>   naming the model/network and seed; the publisher rejects anything else;
> - the legal analysis in Section 2 remains as the record of *why* this is the
>   decision, not as a menu of future options.

The merge is deliberate:

- the earlier document's source/licensing analysis, `GameState` integration,
  book classifiers, hosting plan and interestingness rubric are retained;
- the agent specification's concrete decision-node triggers, counterfactual
  evaluation pass, prototype JSON fields, and batch/SQLite operational rules are
  adopted;
- two of its assumptions are corrected: Mortal's per-action values are model
  utility/Q values, **not point-denominated EV**, and the `agari` crate does not
  provide a full game simulator or legal-action engine. Section 9 records the
  comparison and the resolution in detail.

External terms and limits were checked on **2026-11-14**. Platform terms change;
the legal analysis below is retained to justify the exclusion, not to invite
third-party data back into the pipeline.

---

## 0. Executive summary

**Decision: build the replay pipeline exclusively on AI self-play. Do not use
Tenhou, Mahjong Soul, or any other third-party human replay corpus.**

1. **The legal position is bad enough that we are not going to build on
   third-party logs.** Tenhou asserts copyright in its game records, explicitly
   prohibits redistribution, requires an application to download Houou records,
   and forbids using them to develop a product that competes with Tenhou.
   Mahjong Soul has no public API; its terms, as read by the Kanachan maintainer
   with a lawyer, make it risky to hand records obtained from an account to
   third parties. Riichi City, Hime Mahjong and M-League records are in the same
   position. Public Hugging Face/Kaggle datasets do not cure this: a derived
   dataset cannot grant a licence the source platform never gave, and a mined
   `GameState` is still derived from the record. We cannot produce a clean chain
   of title for an open-source app, so **the answer is no third-party corpus at
   all** — not for training, not for evaluation, not for a “small sample”, not
   anonymised, and not via a permission request that is not on the roadmap.

2. **AI self-play is the only replay source, not a fallback.** It gives us a
   corpus we own, strong labels, and direct control over skill level and error
   distribution. Mortal is open source (AGPL-3.0) and its `libriichi` emulator
   can play and dump mjai logs; the documentation claims up to 40,000
   hanchans/hour on a high-end desktop. We can run the one available
   `mortal_298k` checkpoint with different sampling settings for correct lines, Akochan
   as a genuinely different policy, and heuristic baselines for cheap mistakes,
   keep all of it out of the shipped app, and reproduce a corpus from seeds. The
   4.1/3.0 ladder is an online-service set of networks whose weights are not
   released, so it is not a local corpus source. Akochan is a useful second
   opinion / diversity source under its own non-commercial output terms. The app
   already has its own Rust reimplementation of Mortal v4 inference (`src/ai/`).
   That code ports AGPL-3.0 `libriichi`, which makes the repository
   AGPL-3.0-or-later; labelling a reconstructed `GameState` does not require
   linking the `libriichi` crate into the app.

3. **The deliverable is a small, curated, static scenario pack — not a huge
   replay database.** The app is a client-side trainer. Ship a manifest plus
   lazily loaded packs of complete `GameState` snapshots (a few MB each), cache
   them in IndexedDB, and keep the raw corpus and candidate database offline or
   on cheap object storage. The existing GitHub Pages + Release asset + optional
   Hugging Face pattern in `hosting-plan.md` is the right shape.

4. **Book alignment remains the best first filter, but it is not the only
   interestingness signal.** Start with replay states that satisfy an existing
   lesson's constraints *and* where Mortal agrees. Then add families the book
   cannot generate well: model-vs-model blunder mining, close calls, contested
   book/Mortal positions, self-play table-reading/defense states, score/placement
   states, and eventually multi-step replay drills.

5. **Do not implement the miner inside the WASM build.** Replay parsing,
   corpus storage, Mortal batch inference and pack publishing are a native-only
   offline tool. Keep it in a separate binary/feature (and, if it links
   `libriichi`, preferably a separate repository or process) so the shipped app
   and the offline tooling stay operationally separated.

6. **Use the agent specification's triggers and counterfactual pass as
   candidate-selection tools, not as the whole label.** The defensive and
   offensive triggers raise recall for push/fold and speed/value decisions;
   Mortal's per-action Q values order the alternatives. But Q values are model
   utility, not points, so thresholds must be calibrated or expressed as
   percentiles/probability margins. Section 6.5.1–6.5.2 and Section 9 cover the
   exact reconciliation.

The rest of this document explains the evidence and turns this into a design.

---

## 1. What a replay is, and what the app actually needs

### 1.1 Two different objects

A **replay** is a full game record: the initial deal, every draw, discard, call,
kan, riichi declaration, dora reveal, win and score change. A **scenario** is one
decision point inside that record: a complete table snapshot, the legal actions,
the expected answer, and enough explanation to grade and teach.

The app already has the second object: `GameState` in `src/state.rs`. It holds:

- the human's 13/14 tiles, shanten, ukeire, agari and decomposition data;
- all four players' hands, melds, rivers, riichi flags, winds and scores;
- round wind, hand number, honba, riichi sticks, dora/ura indicators, tiles
  remaining, current turn;
- the decision context (`SelfTurn`, `ReactToDiscard`, `ReactToKan`), an optional
  call offer, `can_riichi`, `correct_action`, `equivalent_tiles`, the book
  rationale and (for AI drills) `ai_decision`.

A replay is therefore a *source* of `GameState` snapshots. The miner's core job
is to walk a replay from the deal, snapshot the table before every decision,
and fill the fields the app needs. `GameState` is already serialisable, already
importable/exportable as `riichiprac.position`, and already validated by
`generator::support::state_validation::validate_reachable_state`; the replay
path should reuse all three rather than invent a parallel state model.

### 1.2 Replay formats worth knowing

| Format | Shape | Where it comes from | Full game | Snapshot | Notes |
| --- | --- | --- | --- | --- | --- |
| Tenhou `mjlog` XML (`*.xml.gz`) | gzipped XML, root `<mjloggm>` | Tenhou clients / Houou archive | yes | no | The original Tenhou format; contains the shuffle seed, all hands and every event. Downloaded as `.xml.gz`; the official manual says the log is gzipped XML. |
| `tenhou.net/6` JSON | JSON document with `title`, `name`, `rule`, `log[]` | Tenhou editor, mjai-reviewer custom log | yes | one kyoku per entry | The "custom log" accepted by <https://mjai.ekyu.moe>; tile ids are `11`–`47`, red fives `51`–`53`, `60` for tsumogiri, `r…` for riichi, `p…/c…/m…` for calls. Our `src/export/tenhou6.rs` already writes this shape for a generated state. |
| mjai JSON Lines | one JSON event per line: `start_kyoku`, `tsumo`, `dahai`, `chi`, `pon`, `daiminkan`, `ankan`, `kakan`, `dora`, `reach`, `reach_accepted`, `hora`, `ryukyoku`, `end_kyoku`, `end_game` | Mortal, Akochan, Kanachan adapters, most AI tools | yes | can reconstruct any point | The de facto hub format; the standardisation project is `Cryolite/mjai`. In **replay mode** all hands are visible; in **in-game mode** only the acting player's view is visible. |
| Mahjong Soul protobuf records | `fetchGameRecord` WebSocket response, wrapped in protobuf | Mahjong Soul client / account | yes | via events | No public API. The Kanachan README says records are obtained by capturing WebSocket messages with a proxy/browser extension; a hanchan is roughly 50–100 KB on the wire. |
| Riichi City / Hime Mahjong logs | client log id, then a proprietary record; community converters emit tenhou6 | Riichi City / Hime clients | yes | no | mjai-reviewer accepts a "Riichi City log ID" and "Hime Mahjong log ID". Terms are not an open licence. |
| `riichiprac.position` / `GameState` | the app's own JSON envelope | this app | no | yes | The natural shipped scenario format. Import/export already exists; it is not a replay format. |
| `riichiprac.scenario-report` | report envelope around a `GameState` plus answer/evaluation | this app, `verify_report`, `fuzz_scenarios` | no | yes | Useful for human review of a single mined candidate; not a bulk corpus format. |

**Canonical internal choice: mjai JSONL.** It is the only format that is
already the common denominator for AI logs, is easy to replay event by event,
and can be converted to every other format we care about. Store raw logs as
gzipped mjai JSONL, store the reconstructed `GameState` snapshots separately,
and use `tenhou6` only as an export/view for mjai-reviewer and outside tools.

The format table above is explanatory. Under the decision at the top of this
document, **only mjai self-play logs are ingested**; Tenhou/Mahjong Soul/Riichi
City/Hime/protobuf formats are not parsed as inputs. `tenhou6` remains an
export format for review, not a source.

### 1.3 What the app must be able to do with a mined state

The existing frontend already renders and grades a `GameState`. A replay pack
therefore only needs to provide:

- a complete `GameState` (the table, the decision, the answer, the rationale);
- optional provenance/metadata (source, model, turn, book section, tags);
- optional Mortal label data for users without weights;
- validation that the answer is legal and the state is reachable.

No new game logic belongs in React. The frontend may load a pack and call the
same Rust/WASM grading path; any book rationale and `can_riichi` should be
recomputed in Rust (`generator::finalize_state`) rather than trusted from the
file, exactly as report import already does.

---

## 2. Real-game replay sources, licensing and practical access (question 1)

### 2.1 Tenhou

**Availability.** Tenhou stores game records, and the client exposes recent
ones. The official manual says:

- the replay URL forms are `https://tenhou.net/0/?log=…` for the viewer,
  `/5/` for the HTML5 viewer and `/6/` for the editor;
- the replay history keeps up to 40 entries locally, and a paid membership can
  download records played as a paid member from the last 10 days via
  `https://tenhou.net/mjlog.html`;
- the log file is gzipped XML (`*.xml.gz`);
- the copyright notice reads **"※牌譜の著作権は天鳳にあるものとします"** —
  "the copyright of game records belongs to Tenhou";
- Tenhou may delete records without notice and may change the format.

Houou (Phoenix) records are the high-level corpus everyone uses. A 2017 official
blog post says Tenhou publishes all Houou records, for cheat detection and
strong-player analysis, and then adds the policy that matters here:

> 「天鳳と競合する製品への開発・応用を目的として天鳳の牌譜を使用していただくことはできません。」
>
> "Tenhou game records may not be used for the development or application of a
> product that competes with Tenhou."

The same post asks anyone downloading Houou records to apply first
(`support@c-egg.com`), and asks companies using the records to sponsor a Tenhou
event. Academic use has been tolerated, but tolerance is not a licence.

Community downloader `Apricot-S/houou-logs` puts the practical rule plainly:

> "Tenhou prohibits redistribution of game logs. Do not publish, share, mirror,
> or redistribute downloaded log data."

It also documents Tenhou's one-session rule: only one session may download logs
at a time, and running multiple instances violates the terms. Its fetch path
follows Tenhou's 20-minute update interval and uses the official FileIndex.

**What this means for us.**

- **We are not using Tenhou records at all.** The copyright assertion, the
  explicit no-redistribution rule, and the competing-product restriction are
  enough that an open-source app cannot build a clean corpus from them.
- Do not ship Tenhou logs or scenario packs derived from them. "The code is open
  source" does not launder the data.
- Do not scrape Tenhou in CI, in a browser, or from multiple workers. The
  platform explicitly cares about load and concurrency.
- A derived `GameState` is still derived from the record. Whether a court would
  treat it as a copyright work is uncertain; the contractual terms and Tenhou's
  stated policy do not depend on that answer.
- We are **not** pursuing a permission request. It would block the project, may
  be refused, and is unnecessary now that self-play is the chosen source.
- There is no “even with permission” branch in this plan. If the product ever
  reopens the question, it is a new decision with a new legal review.

### 2.2 Mahjong Soul

Mahjong Soul has no public game-record API. The record is a protobuf payload
returned to the client's WebSocket `fetchGameRecord` call; tools such as
Kanachan capture it with mitmproxy/Wireshark or a browser extension. Kanachan's
maintainer estimates a hanchan at ~50–100 KB and notes that downloading millions
of records directly from the server puts a significant load on it.

Licensing is the blocker. In the Kanachan discussion "Data Collection Strategies
for Mahjong Soul AI Training" (June 2024), the maintainer says he consulted a
lawyer and concluded that, at least under Japanese law and the Japanese Mahjong
Soul terms of service, **providing game records obtained with his own account to
third parties may violate the terms**. He therefore does not share his dataset.
He does intend to share simulation data generated by matches between trained
models, because, in his view, that data is not subject to Mahjong Soul's terms.

**What this means for us.** Treat Mahjong Soul records as all rights reserved
and not redistributable. Do not build a corpus from them, public or private. A
user-local "import my own log" feature is also not planned; see §2.6 and §5.10.

### 2.3 Riichi City, Hime Mahjong, M-League and others

- **Riichi City** exposes a per-game log id in the client; the community has
  parsers that convert it to tenhou6, and mjai-reviewer accepts the id directly.
  There is no open bulk API, and the terms are a standard game-service terms of
  service. **Excluded.**
- **Hime Mahjong** is supported by mjai-reviewer through a log id; same
  position. **Excluded.**
- **M-League** publishes match records in Tenhou-style form. The records are
  useful for study, but they are the league's publication, not an open dataset.
  **Excluded.**
- **Janryumon, Mahjong Fight Club, Sega NET MJ, etc.** are closed platforms.
  **Excluded.**

### 2.4 Public "open" datasets and licence laundering

There are large Hugging Face/Kaggle datasets built from Tenhou or Mahjong Soul:

| Dataset / project | What it is | Licence claim | Why it is still unsafe |
| --- | --- | --- | --- |
| `mitsutani/mahjonglm-dataset` | tokenised Tenhou corpus, 2011–2024, ~96.7 GB | `source-data-terms-apply` | The card itself says it is a derivative of third-party Tenhou data and subject to Tenhou's terms. |
| `nikketryhard/tenhou-houou-mjai` | Tenhou Houou → mjai | `other`; README says "No ownership claimed, no CC BY grant over the logs" | Honest about the problem; still not a grant from Tenhou. |
| `1nfrared218/tenhou-mjai-riichi-training` | Tenhou mjai training data | claims CC BY 4.0 | A converter cannot grant CC BY over Tenhou's records. |
| `pjura/mahjong_board_states` | 650M+ board states | check the card | A derived state dataset inherits the source restrictions. |
| Kaggle "Japanese Mahjong Board States" | Tenhou states | check the card | Same. |

A dataset licence only covers what the uploader actually owns: their conversion
code, annotations and selection. It cannot override the source platform's
copyright or terms. **Under the decision at the top of this document, none of
these datasets is used at all — not for training, not for evaluation, not for a
“small sample”.** They are listed so that no future contributor reintroduces
them by mistake.

### 2.5 What is usable: our AI self-play, and nothing else

| Source | Can we view it? | Can we redistribute raw logs? | Can we ship derived scenarios? | Decision |
| --- | --- | --- | --- | --- |
| Tenhou Houou logs | yes, publicly | **no** (explicitly prohibited) | **no** | **Excluded** |
| Tenhou own logs | yes | no | no | **Excluded** |
| Mahjong Soul records | with an account | no | no | **Excluded** |
| Riichi City / Hime records | with a log id | no | no | **Excluded** |
| M-League records | yes | no | no | **Excluded** |
| HF/Kaggle Tenhou derivatives | yes | claim is invalid | no | **Excluded** |
| **Our AI self-play** | we generate it | **yes** (our data) | **yes** | **The only source** |
| User's own log, imported locally | user has it | we never receive it | no | **Not planned** |

The "Can we view it?" column is descriptive only; the **Decision** column is
binding. No third-party row is an ingestion path. The only source that is
unambiguously free for an open-source app is **data we generate ourselves**.
That is not just the strategic preference; it is the decision. There is no
fallback source.

### 2.6 Why we are not pursuing permission or user-local import

A permission request and a user-local importer are the only theoretical paths
to human records. Both are rejected:

- **Permission is not a dependency we can schedule around.** Tenhou’s published
  position is that records may not be used to develop a competing product, and
  the copyright assertion is explicit. A free trainer might or might not be
  considered competing; waiting for a written answer would block the project,
  and a refusal would leave a half-built pipeline. We are not spending the
  project’s legal/relationship budget on it.
- **A user-local importer still normalises third-party records.** It avoids us
  hosting them, but it keeps us maintaining format parsers, platform-specific
  quirks and a feature whose output is still governed by someone else’s terms.
  It is not part of “AI self-play only”.
- **“Internal research only” is not a loophole.** If we used logs privately to
  design scenarios and then shipped the output, the provenance would be false
  and the legal analysis would not change. We are not doing it.

If the product ever revisits this, it is a new decision with a new legal review,
not an implicit extension of this document. The implemented pipeline is
self-play only.

### 2.7 A note on "MJLogs"

The task mentions "MJLogs". In practice the name is used for two related things:
the Tenhou **`mjlog` XML** format (the original gzipped XML record), and the
various **`mjlog`/mjai log collections** in the community. Both are Tenhou
records at bottom, so the Tenhou licensing analysis applies. The modern hub
format is **mjai JSONL**, not a new Tenhou format. Do not treat a file extension
as a licence; **none of these is an input under this decision**.

---

## 3. AI-generating our own replays (question 2)

**This is the only replay source.** The pipeline below never ingests a Tenhou,
Mahjong Soul, Riichi City, Hime, M-League or other human record, and never
converts one. It generates games locally, keeps the raw corpus private, and
publishes only curated scenario packs with `source.kind: "ai_selfplay"`.

### 3.1 The AI landscape

| AI | Code licence | Weights | Runs offline? | Self-play logs? | Verdict for us |
| --- | --- | --- | --- | --- | --- |
| **Mortal** (`Equim-chan/Mortal`) | **AGPL-3.0** | the community `VoidShine/mortal-298k` checkpoint is the one we have; upstream 4.1/3.0 weights are not released | yes, Rust `libriichi` + Python/Candle inference; CPU or GPU | yes: `libriichi::arena` has `OneVsThree` / `TwoVsTwo` and a `log_dir` that dumps gzipped mjai JSON logs | **Primary engine.** Strong, fast, open, and already the app's evaluator. Keep the native arena offline and out of the shipped binary; the app's own port already makes the shipped code AGPL-3.0-or-later. |
| **Akochan** (`critter-mj/akochan`) | custom Japanese terms (not OSI) | includes its own AI | yes, C++ | yes: `system.exe test <begin> <end>` with `setup_match.json` | Useful second opinion / diversity. Output reuse is allowed for non-commercial use **with attribution**; modification/redistribution is restricted. Do not make it the only source if the app might ever be commercial. |
| **Kanachan** (`Cryolite/kanachan`) | no `LICENSE` file in the repo (all rights reserved by default) | no trained models shipped | yes, but needs Mahjong Soul data | not a turnkey bot | Not a practical source. |
| **NAGA** (Dwango) | proprietary | proprietary | no (service) | no | Cannot run offline or ship. |
| **Suphx** (Microsoft Research) | paper only | no public code/weights | no | no | Not usable. |
| **Mortal online networks** (4.1a/b/c, 4.0, 3.0) | same AGPL project | **not downloadable**; used by the online review service | no (service only) | no | Do **not** plan a corpus around them. They are perspectives on <https://mjai.ekyu.moe>, not local engines. |

Other engines exist (forks, research simulators, `MjaiLogEngine`, `tsumogiri`
baselines). Before using one, check its licence and whether it can dump logs;
a strong engine with no log output is not useful here.

**Availability correction (2026-11-15).** The upstream Mortal documentation's
"Okay cool now give me the weights!" section points at the author's post, whose
latest update (2022-08-19) says there is currently no plan to release the trained
model. The 4.1a/b/c, 4.0 and 3.0 names are networks used by the online review
service at <https://mjai.ekyu.moe>, not downloadable checkpoints. The one Mortal
checkpoint we can run is the community `VoidShine/mortal-298k`
(`mortal_298k.safetensors`), already used by this app. Its model card says it was
trained on Tenhou hanchan data; that is a weights-provenance question separate
from the no-third-party-replay decision, and should be reviewed before commercial
use. Treat the 4.1/3.0 ladder as unavailable offline unless a checkpoint is
explicitly obtained; the corpus recipe below is written for **one Mortal snapshot
+ Akochan + heuristic baselines**, not a fleet of Mortal generations.

### 3.2 Mortal is the practical workhorse

Mortal's own documentation advertises:

- a fast Rust emulator with a Python interface, "up to 40K hanchans per hour"
  on an RTX 4090 + Ryzen 9 7950X with batch size 2000 (the exact number is a
  hardware claim, but the order of magnitude is what matters);
- an mjai interface;
- `libriichi::arena` self-play classes. `OneVsThree` runs a challenger against
  three champions across four seat splits and, when `log_dir` is set, writes
  one `*.json.gz` mjai log per game. `TwoVsTwo` does the same for two-vs-two.
  This is exactly the corpus generator we need.

Our app already has an independent Rust reimplementation of Mortal v4 inference
in `src/ai/` (`MortalV4Model`, `encode_v4_observation`, `evaluate_state`); it is
AGPL-3.0-or-later because it ports `libriichi`. That means:

- **Labelling a reconstructed `GameState`** can use the app's own native code,
  reading the AGPL weights as data, exactly as the browser does. No `libriichi`
  link is required for labelling.
- **Generating self-play games** still needs a simulator/agent loop. `libriichi`
  is the easiest, but it is AGPL. Keep that tool separate from the app: a
  separate repository, a separate binary invoked as a subprocess, or at minimum
  a clearly isolated optional tool with its own licence notice. Do not link it
  into the library that ships to WASM. The corpus repo (`riichiprac-corpus`)
  is **private by default**; making it public is a later decision, not part of
  this plan.

### 3.3 A corpus recipe that produces both correct lines and mistakes

The most valuable self-play corpus is not four clones of one strong policy.
It is a mix, but the available engines constrain what we can actually run:

| Match-up / family | What it gives us |
| --- | --- |
| `mortal_298k` vs itself (M1) | high-quality lines; book-aligned states; stable labels; low policy diversity |
| `mortal_298k` sampling/seat sweep (M2) | wider state coverage and mild sampling variation; the **same policy**, not a different AI |
| Akochan vs Akochan, tactic sweep (M3) | a genuinely different rule-based policy; style contrast; mistakes |
| Akochan vs `mortal_298k` (M4), only if a cross-engine bridge is feasible; otherwise a corpus-level M3+M1 mix | cross-policy contested states; style contrast |
| Mortal + Akochan + heuristic table (M5), only if the bridge is feasible | multi-policy table texture |
| heuristic/tsumogiri baseline (M6): H0 tsumogiri, H1 random-legal, H2 isolated-first, H3 efficiency-safety | deterministic fixtures, cheap mistakes, a weak ablation baseline; H0/H1 are fixtures only |

> **Status (2026-11-15): this is a first-class pipeline requirement, with a
> corrected model inventory.** The implementation plan (§3, families M1–M6 and
> corpus units C2–C7) makes each family a separately gated corpus product with
> its own quota, report and acceptance criteria. M1/M2 are the one
> `mortal_298k` checkpoint with different sampling settings and are **not** policy
> variety; M3–M6 provide the actual variety. The corpus runner must accept
> pluggable agents/policies, including non-neural rule/heuristic engines such as
> Akochan, and record per-game agent identity, configuration, sampling
> (including temperature-like knobs) and seeds. A family that is disabled or
> short is visible in the corpus report.

Practical defaults:

- **Labeller:** `mortal_298k`, the only checkpoint we have, for book agreement
  and default "best" labels. Do not claim an ensemble; there is one model.
- **Generator:** `mortal_298k` with sampled self-play
  (`boltzmann_epsilon` > 0); Akochan for a different policy; heuristic/tsumogiri
  for deterministic or weak baselines.
- **Sampling:** use a sampled profile for self-play diversity; argmax for labels.
  Record `boltzmann_epsilon` / `boltzmann_temp` / `top_p` and the model hash in
  provenance.
- **Seeds:** record the seed pair used by `libriichi::arena` so a game can be
  reproduced.
- **Rule set:** Tenhou standard four-player hanchan, because that is what
  Mortal's emulator and the app's model were built for. Do not assume sanma or
  non-standard local rules work without validation.
- **Volume:** start with a 1k-game smoke corpus, then 10,000 hanchans if the hit
  rate justifies it. 10k games at the advertised rate is roughly 15 minutes of
  self-play; storage is the bigger constraint.
- **Do not name 4.1a/b/c, 4.0 or 3.0 in a match plan.** They are online-service
  networks, not local checkpoints; a plan that names them should fail at engine
  startup.

**Model identity is not interchangeable.** The 4.1a/b/c and 3.0 names are the
mjai-reviewer/Mortal online ladder, not weights we can load. The app ships
`mortal_298k.safetensors` and binds it with `src/ai/model.rs`. If another
checkpoint is ever obtained, verify the observation/action space and convert it
through `scripts/convert_weights.py`; record both model identities in provenance.
Do not assume a 4.1 network file will load just because the name looks similar.

### 3.4 Licensing of AI-generated logs

This is not legal advice, but the conservative position is:

- **Code/weights:** Mortal is AGPL-3.0. Do not ship the native `libriichi` code
  or the weight files inside the shipped app. The app already carries translated
  ports of the encoder and solver, which is why it is AGPL-3.0-or-later, and it
  treats the weights as a separately fetched AGPL asset. Keep self-play
  generation out of the shipped binary.
- **Generated logs:** a game record produced by running a program is data, not
  the program's source. The community treats self-play logs as data
  (Kanachan's maintainer explicitly plans to share simulation data because, in
  his view, it is not subject to Mahjong Soul's terms). Publish them with clear
  attribution
  to Mortal and the model version, and keep the weights out of the dataset.
- **Akochan outputs:** its licence explicitly permits non-commercial
  reproduction of outputs (including game records and evaluation values) with
  attribution. If the app ever becomes commercial, get permission or replace
  Akochan-generated data.
- **Our own additions:** the selection, annotations, explanations and pack
  format are ours and can be licensed (CC BY 4.0 for the data;
  AGPL-3.0-or-later for the code).

The safest long-term option is a permissively licensed simulator/policy for the
raw corpus and Mortal only for labels. That is a larger engineering project; the
Mortal-self-play corpus is the pragmatic first step.

---

## 4. Replay database and hosting (question 3)

### 4.1 Three tiers, not one database

Do not try to serve full replays to the browser. Separate the data by purpose:

| Tier | Contents | Size (planning estimate) | Where it lives | Shipped? |
| --- | --- | --- | --- | --- |
| **Raw corpus** | self-play gzipped mjai JSONL per game, plus a small metadata row | ~20–60 KB/game compressed; 10k games ≈ 0.3–0.6 GB; 100k ≈ 3–6 GB | Local data root (`RIICHI_DATA_DIR/replays/`); optional Google Drive backup via rclone; never git | no |
| **Scenario DB** | one row per decision point, with state hash, reconstructed `GameState`, labels, scores, provenance; curated rows and pack metadata in the same DB | ~2–10 KB/decision; a 10k-game corpus has millions of decisions | Local SQLite (`RIICHI_DATA_DIR/db/miner.sqlite`); local snapshots, optional Drive copies; optional DuckDB/Parquet analytics derived from it | no |
| **Curated packs** | selected, validated, deduplicated scenarios in app format | ~5–15 KB/scenario raw; 1k ≈ 5–15 MB; 10k ≈ 50–150 MB (gzip roughly halves it) | Exported from the DB; Pages same-origin, HF, or R2 | yes, lazily |

The existing app already has a strict initial-load budget (AGENTS.md: initial
hand + board ≤ 4 MB, total assets ≤ 8 MB). Never load the whole corpus or all
packs at startup. Load a manifest, then one pack on demand.

**Storage rule:** local working copy first. Google Drive backup via rclone is a
separate operator task and is **not** a code dependency; the miner must run
local-only. Do not run the miner against a Drive mount and do not put a live
SQLite file on Drive. Replays are immutable and content-addressed; the DB is
snapshotted locally with `VACUUM INTO` and, when the operator has configured
rclone, uploaded as timestamped files, never as a live copy.

### 4.2 Schema sketch

Use a small relational schema offline; use JSON packs at runtime. SQLite
(`RIICHI_DATA_DIR/db/miner.sqlite`) is the operational DB and the source of truth
for candidate and curated scenarios. DuckDB/Parquet is an optional analytics
export, not the backup target.

**`replays`**

```text
replay_id          TEXT PRIMARY KEY   -- sha256 of canonical raw log
source             TEXT NOT NULL      -- CHECK (source = 'ai_selfplay')
licence            TEXT NOT NULL      -- CC-BY-4.0 / CC0 for our generated data
attribution        TEXT NOT NULL      -- Mortal/Akochan model + project credit
format             TEXT NOT NULL      -- 'mjai' for the corpus
rule               TEXT NOT NULL      -- 4p-hanchan (the supported rule set)
generated_at       TEXT NOT NULL
model              TEXT NOT NULL      -- e.g. mortal-298k, akochan-<ver>, heuristic-v1
model_sha256       TEXT NOT NULL
seed               TEXT NOT NULL
log_path           TEXT NOT NULL      -- relative to RIICHI_DATA_DIR
log_bytes          INTEGER NOT NULL
validation_status  TEXT NOT NULL      -- ok / bad / partial
ingested_at        TEXT NOT NULL
storage_backend    TEXT NOT NULL      -- local / gdrive
backed_up_at       TEXT NULL          -- null until the replay folder copy/check passes
backup_sha256      TEXT NULL          -- rclone check / manifest hash
```

**`decisions`**

```text
decision_id        TEXT PRIMARY KEY   -- sha256(replay_id + kyoku + event_index)
replay_id          TEXT REFERENCES replays
kyoku              INTEGER
honba              INTEGER
event_index        INTEGER
turn               INTEGER
seat               INTEGER           -- actor before rotation
decision_kind      TEXT              -- self_turn / react_discard / react_kan / call
state_hash         TEXT              -- canonical JSON hash
state_json         TEXT / BLOB       -- reconstructed GameState
visible_info_hash  TEXT              -- optional: dedupe after hiding hands
legal_actions      JSON
played_action      JSON              -- agent action in the self-play record
book_match         JSON NULL         -- lesson id, answer, situation label
mortal_top         TEXT NULL
mortal_top_prob    REAL NULL
mortal_margin      REAL NULL
mortal_ranking     JSON NULL
interestingness    REAL NULL
selection_reason   TEXT
pack_id            TEXT NULL
```

**`selected_scenarios`**

```text
scenario_id        TEXT PRIMARY KEY   -- stable curated id
decision_id        TEXT REFERENCES decisions
pack_id            TEXT NULL          -- assigned during pack assembly
lesson_id          TEXT NOT NULL
correct_action     JSON NOT NULL
accepted           JSON NOT NULL
variant_of         TEXT NULL          -- base scenario id
transform_chain    JSON NULL
label_check        JSON NULL
provenance         JSON NOT NULL
```

**`variants`**

```text
variant_id         TEXT PRIMARY KEY
base_scenario_id   TEXT REFERENCES selected_scenarios
transform_chain    JSON NOT NULL
transform_seed     TEXT NOT NULL
label_preserved    BOOLEAN NOT NULL
rejection_reason   TEXT NULL
```

**`packs`**

```text
pack_id            TEXT PRIMARY KEY
version            INTEGER
manifest_path      TEXT
sha256             TEXT
bytes              INTEGER
scenario_count     INTEGER
source_mix         JSON
licence            TEXT
published_at       TEXT
export_path        TEXT              -- RIICHI_DATA_DIR/packs/<pack-id>-<sha>.json.gz
db_backup_id       TEXT NULL         -- snapshot that contains this pack's rows
```

**`corpus_runs`**

```text
run_id             TEXT PRIMARY KEY
match_plan_id      TEXT
started_at         TEXT
finished_at        TEXT
replay_count       INTEGER
local_dir          TEXT              -- relative to RIICHI_DATA_DIR
gdrive_dir         TEXT              -- e.g. riichiprac/replays
db_snapshot        TEXT NULL
rclone_status      TEXT              -- ok / failed / skipped
```

**`backups`**

```text
backup_id          TEXT PRIMARY KEY
kind               TEXT              -- replay_copy / db_snapshot
path               TEXT              -- local snapshot/replay path
sha256             TEXT
bytes              INTEGER
created_at         TEXT
rclone_remote      TEXT
verified_at        TEXT NULL
```

For analytics, export `decisions` to Parquet and query with DuckDB. For a
one-off, SQLite is fine. The point is to keep the raw logs immutable and the
derived rows reproducible from `(replay_id, event_index, model_sha256,
classifier_version)`.

### 4.3 Hosting options

| Host | Free tier / limits | CORS | Best for | Risks |
| --- | --- | --- | --- | --- |
| **GitHub Pages** (current) | 1 GB site, 100 GB/month soft, 100 MB/file, no custom headers | same-origin only | app + curated packs + manifest | site size and bandwidth; no CORS/headers; repo bloat if packs are committed |
| **GitHub Release asset** | 2 GiB/asset, no total limit | **no ACAO** (measured; CI must copy) | frozen, versioned pack archives | not browser-fetchable; needs a CI download/copy step |
| **raw.githubusercontent.com** | normal Git repo limits | `access-control-allow-origin: *` (measured) | small manifests / sample packs | not a CDN for large files; rate limits; repo size |
| **jsDelivr** (GitHub-backed) | CDN, file/repo limits | `*` (measured) | small public assets | not for large data; cache/purge behaviour |
| **Hugging Face Hub** | public storage best-effort; private 100 GB; paid beyond; 500 GB/file hard, <200 GB recommended; <100k files/repo | `*` / origin echo (measured on `resolve` and CDN) | full corpus + candidate datasets + optional pack mirror | storage policy can change; public-repo "best effort"; not a transactional DB |
| **Cloudflare R2** | 10 GB-month free, 1M Class A / 10M Class B ops, zero egress | configurable | raw corpus / pack CDN / fallback | setup + account; 10 GB cap on free tier; CORS rules must be configured |
| **Google Drive** (rclone) | personal quota; not a CDN | not a browser host | durable backup/transport for raw replays and DB snapshots | never a live SQLite mount; rclone copy/delete semantics; restore checks required |
| **Backblaze B2** | 10 GB free, egress allowance | configurable | corpus backup | egress rules |

Measured on 2026-11-14 with `Origin: https://chairbender.github.io`:

- `huggingface.co/.../resolve/main/...` and the redirected CDN returned
  `access-control-allow-origin` (origin echo / `*`), so browser fetch works.
- `raw.githubusercontent.com` and `cdn.jsdelivr.net` returned
  `access-control-allow-origin: *`.
- GitHub Release assets returned no ACAO at all, matching the existing
  `hosting-plan.md` finding; CI must copy them same-origin.

### 4.4 Recommended hosting plan

**Default (small, cheap, matches the current app):**

1. Commit only a **manifest** and a small number of curated packs to the repo,
   under `frontend/public/scenarios/`. The pack bodies are exported from the
   DB's `packs`/`selected_scenarios` rows. Keep the total under ~50 MB.
2. The manifest is same-origin and tiny (<100 KB), so startup is unaffected.
3. Each pack is a gzipped JSON file, content-addressed
   (`packs/<pack-id>-<sha256-prefix>.json.gz`), fetched on demand and cached in
   IndexedDB. Content-addressed names avoid stale caches without custom headers.
4. Keep the raw corpus and DB out of git. Store them under a local data root
   (`RIICHI_DATA_DIR/replays`, `RIICHI_DATA_DIR/db`). The initial pipeline writes
   local-only; a separate operator task may mirror the folder to Google Drive
   with rclone (append-only replay copy, timestamped `VACUUM INTO` DB snapshots,
   `rclone check`). Drive is backup/transport, not a runtime host and not a live
   SQLite mount. If a corpus is ever made public for reproducibility, publish a
   curated export on R2/HF with a dataset card and
   licence notice rather than opening the Drive folder.

**When packs grow beyond the Pages budget:**

- Move pack bodies to R2 or HF, keep the manifest same-origin, and make the
  loader try same-origin → R2/HF mirror. This mirrors the weights loader's
  ordered-source pattern.
- Or publish a frozen pack archive as a GitHub Release and have the deploy
  workflow copy only the selected packs into `frontend/public/scenarios/`
  before the Pages build. Release assets are not browser-fetchable, but CI can
  download them without CORS.

**Do not** use Git LFS for packs: bandwidth quotas, clone cost and Pages build
complexity are all worse than the options above.

### 4.5 Integrity, privacy and retention

- **Hash everything.** SHA-256 over the canonical pack bytes; the manifest
  carries the hash and byte count; the loader verifies before parsing.
- **Version the schema.** `schema: "riichiprac.scenario-pack"`, `version: 1`.
  Old app versions ignore unknown packs rather than crashing.
- **Fail closed on source.** A pack is publishable only when
  `source.kind == "ai_selfplay"`, the model/seed/provenance fields are complete,
  and the data licence is on the publisher's allowlist. Any other `source.kind`
  is a hard rejection, not a warning.
- **Strip identities.** Self-play has no player identities to begin with; never
  add names, account ids, chat or IPs from any other source.
- **Backup and restore (optional operator task).** Raw replays are immutable and
  content-addressed; when rclone is configured, copy them to Google Drive with
  `rclone copy --checksum --immutable` (copy never deletes; no sync with delete
  semantics for the immutable corpus). The DB is snapshotted locally with
  `VACUUM INTO`; a configured backup uploads timestamped files, never a live
  copy. Verify with `rclone check`, restore a sample, and run
  `PRAGMA integrity_check`; local-only operation is valid until the separate
  rclone task is done.
- **Retention.** Raw self-play logs are reproducible from `(seed, model,
  code)`; keep them only as long as the candidate DB needs them. Keep the last N
  DB snapshots (for example 7 daily + 4 weekly). Curated packs are small and can
  be kept forever.

---

## 5. Scenario options with replays in hand (question 4)

The point of replay mining is not "random states from complete games" for its
own sake. It is to reach states the constructive generator cannot easily build, and
to label them with an independent evaluator. The families below are ordered by
how directly they fit the current app.

### 5.1 Book match + Mortal agreement (primary)

A replay state satisfies an existing lesson's constraints (for example ch. 8.1
push/fold, ch. 8's safety chart, ch. 7's Riichi/dama rule), and Mortal's top
action is one of the lesson's accepted answers.

- **Answer source:** the book rule (`correct_action` + `equivalent_tiles`).
- **Why it is valuable:** the table is a complete, reachable self-play position
  rather than a constructed one, and the two independent perspectives agree.
- **Caveat:** the existing generators are constructors, not classifiers. Each
  lesson needs a `matches(state) -> Option<Match>` predicate before this family
  can run. See §6.4.
- **Expected hit rate:** unknown; likely low for narrow lessons (a specific
  suji-trap or kabe board is rare in random self-play), higher for broad ones
  (Riichi/dama, push/fold, safety). Use quotas and targeted generation.

### 5.2 Book match, Mortal disagrees ("contested")

The state satisfies a book lesson, but Mortal prefers a different action. The
app already knows how to show both columns and call neither "wrong".

- **Answer source:** book; Mortal shown as the other perspective.
- **Why it is valuable:** these are exactly the positions where a human learner
  benefits from seeing that a strong model disagrees. They are also leads for
  finding bugs in the book encoding.
- **Caveat:** do not ship a contested scenario as a simple "book is right"
  drill without an explanation of the disagreement. The existing dual-verdict
  UI is built for this.

### 5.3 Mortal-only "best action" from a self-play game

Any decision point where the model is confident, with no book rule. This is the
replay analogue of the existing `AI Best Action` drill, but the table came from
a complete self-play game instead of a random construction.

- **Answer source:** Mortal top-1 (with `riichi_discard` resolved by the second
  pass, and call actions mapped through the existing legal-action resolver).
- **Why it is valuable:** realistic table texture, calls, kans, furiten, score
  context; covers decision types the book lessons do not.
- **Caveat:** it is only as good as the model. Ship it as a declared Mortal
  drill, not as ground truth, and require a confidence margin.

### 5.4 Mistake mining: weak agent vs strong label

Run Akochan with a different tactic (or a heuristic baseline) against the Mortal
checkpoint. At each decision, compare the weaker policy's played action with the
Mortal top action. A large gap is a "blunder" candidate: the position before the
bad move is the drill, and the Mortal checkpoint supplies the answer.

- **Answer source:** the one `mortal_298k` checkpoint. Do not claim an ensemble;
  there is one model.
- **Why it is valuable:** it is the closest we can get to "a human made a
  mistake here" without using human data, and it produces a natural teaching
  moment ("what should you have done?").
- **Caveat:** do not label by the game outcome. A bad move can get lucky; a good
  move can deal in. Use model probability/Q-gap and, for explanatory text, the
  book rule if one applies.
- **Variant:** after the player answers, show the weak agent's actual move and
  why it is worse. That is a "find the mistake" drill, not a "best action"
  drill.

### 5.5 Close calls

The top two actions are within a small probability margin. These are hard
discriminations: the position is genuinely ambiguous to the model, and the
learner must use a principle rather than a clear counterfactual gap.

- **Answer source:** Mortal top-1, but label it "close" and show the margin.
- **Why it is valuable:** trains judgement and tolerance for uncertainty; good
  for advanced players.
- **Caveat:** do not present a close call as a unique correct answer without
  saying the alternative is close. The app's `equivalent_tiles` mechanism can
  accept ties; for genuinely different actions, show both.

### 5.6 Real table reading and defense

Replays naturally contain riichi threats, open hands, rivers built over many
turns, suji relations, blockades, one-chance situations, and calls. Mine states
where the book's safety chart has a clear answer (genbutsu, suji, no-chance,
honor count) and the threat is genuinely tenpai in the hidden record.

- **Answer source:** the book's safety chart (`src/safety.rs`) or Mortal.
- **Why it is valuable:** the existing defense generators plant specific
  patterns; a real river gives the learner the messy version, with irrelevant
  discards, inconsistent shapes and multiple threats.
- **Caveat:** the answer must be derivable from visible information. If the
  "safe" tile is only safe because of an opponent's hidden hand, it is a read
  drill, not a safety-chart drill.

### 5.6.1 Speed vs value (from the agent specification)

A 1-shanten hand with no opponent riichi where the top two discard candidates
lead to genuinely different plans: one is the speed line (better ukeire,
ryanmen, more live tiles), the other is the value line (keep a pair/dora/yaku,
accept fewer tiles). The answer is whichever the book rule or the strong model
prefers; the drill teaches the trade-off rather than a tile.

- **Answer source:** book rule if one applies; otherwise Mortal, with the two
  candidates' hand values and acceptance shown after the answer.
- **How to find it:** target 1-shanten, no active riichi, turns 5–12, and two
  legal discards whose resulting states diverge in both acceptance and hand
  value. This is the agent specification's "offensive/architectural trigger",
  generalised.
- **Threshold:** the agent specification proposes `|EV(a1) - EV(a2)| < 250`
  points. That is a useful *product hypothesis*, not a literal: Mortal's Q
  values are not points. Start with a probability margin / Q-gap percentile,
  then calibrate to point equity if the product needs point copy.
- **Caveat:** "two discards near each other" is not enough. The candidates must
  actually produce different configurations, or the scenario is just a close
  call.

### 5.7 Score and placement decisions

Late-game states where the score, dealer/renchan, honba, riichi sticks or
all-last condition changes the correct line: push/fold, riichi/dama, call/no
call, keeping a hand or folding for placement.

- **Answer source:** book rule where one exists; otherwise Mortal (and ideally
  a placement-aware evaluation).
- **Why it is valuable:** the current generators mostly isolate a hand-shape or
  defense rule; real score context is hard to construct and easy to mine.
- **Caveat:** Mortal's value head is a kyoku/rank-utility model, not a
  placement-EV model. Do not claim placement optimality from Mortal alone; use
  it as one perspective, or add a placement-aware evaluator later.

### 5.8 Multi-step replay drills

Instead of one snapshot, store a short sequence of decisions from the same hand
(three to ten turns), and let the player play through it. Each step is a normal
`GameState`; the pack stores the sequence and the branching logic.

- **Answer source:** book/Mortal per step.
- **Why it is valuable:** teaches plan continuation, call timing and defense
  over time; much closer to a complete game than a single decision.
- **Caveat:** this is a UI/runtime feature, not just a data feature. Ship
  single snapshots first; keep `replay_id` + `event_index` in every scenario so
  sequences can be added later without re-mining.

### 5.9 Transformations and variants

Once a state is found, generate variants that preserve the decision logic:

- **Seat rotation:** rotate all four players so the acting seat is seat 0; rotate
  winds, scores, dealer, `current_turn` and all references.
- **Suit permutation:** permute m/p/s consistently across hands, rivers, melds,
  dora and waits. Recompute the label; do not assume it survives if the lesson
  depends on a specific suit (sanshoku, honitsu, ittsu).
- **Rank mirror:** map rank `r` to `10-r` within a suit; preserves terminal-ness
  but can break ittsu/outside-hand patterns. Recompute.
- **Wind relabeling:** rotate honor winds, keeping the round wind consistent.
- **Red-five normalization:** only if the lesson does not depend on red fives;
  recompute dora and scoring.

Do **not** transform river order, scores, turn number or dora count unless the
lesson explicitly says those do not matter. A transformation is only valid if
the classifier/label still passes after it; otherwise reject the variant.

> **Status (2026-11-15): this is a required generator stage, not a later
> nice-to-have.** It is pipeline stage [8] in
> [`replay-implementation-plan.md`](replay-implementation-plan.md) §4 (units
> V1–V2), after base selection and before pack assembly, with a
> label-preservation gate and a per-lesson `TransformPolicy`. Every shipped
> variant must re-run the classifier/label after transforming and is rejected if
> the lesson breaks. "Seat rotation" above is the reconstruction's normalisation;
> a seat *variant* should permute the opponents relative to the actor, because
> rotating all four and re-normalising the actor is a no-op.

### 5.10 Not in scope: third-party or human replay corpora

Bring-your-own-replay and human-expert-line scenarios are **not part of this
plan**. They are not “phase 8”; they are excluded by the decision at the top of
this document.

- A BYO importer still normalises third-party records and keeps us maintaining
  platform-specific parsers and terms. It is not “AI self-play only”.
- A human-expert line requires a human corpus, which we are not acquiring. The
  model-vs-model mistake family (Section 5.4) is the substitute: it gives us
  realistic errors and a strong label without using anyone else’s records.
- If the product ever revisits human data, it is a new decision with a new legal
  review. It is not an optional flag in this pipeline.

### 5.11 Family summary

| Family | Answer source | How found | Book-aligned? | Best for |
| --- | --- | --- | --- | --- |
| Book + Mortal | book | classifier + Mortal agreement | yes | core curriculum, realistic tables |
| Contested | book | classifier + Mortal disagreement | yes | advanced judgement, review |
| Mortal best | Mortal | confidence filter | no | coverage, calls/kans, realistic texture |
| Mistake mining | `mortal_298k` label | Akochan/heuristic vs Mortal gap | sometimes | teaching moments, common errors |
| Close call | Mortal | top-2 margin | sometimes | advanced discrimination |
| Speed vs value | book/Mortal | 1-shanten, divergent plans | sometimes | efficiency vs hand value |
| Table reading / defense | book/Mortal | safety chart + hidden threat | yes | messy rivers |
| Score/placement | book/Mortal | score/round context | sometimes | all-last, push/fold |
| Multi-step | book/Mortal | sequence of snapshots | sometimes | plan continuation |
| Transformed | same | seat/suit/wind transforms | same | anti-memorisation, volume |

---

## 6. Offline scenario generator design (question 5)

### 6.1 Principles

1. **Native-only.** The miner is a CLI; it must not be part of the WASM build
   or the frontend bundle. It can use `rayon`, `clap`, DuckDB/SQLite, file I/O
   and the native Candle model. Gate it behind a Cargo feature or a separate
   crate so `cargo check --target wasm32-unknown-unknown` still passes.
2. **One state model.** Reuse `GameState`, `CorrectAction`, `finalize_state`,
   `validate_reachable_state`, `rationale_for`, `evaluate_state`. Do not create
   a second JSON shape for scenarios.
3. **Provenance is mandatory.** Every candidate records where it came from,
   which model labelled it, and what licence applies. No anonymous rows.
4. **Fail closed.** Invalid state, unknown licence, non-reproducible label,
   duplicate, or illegal answer means "do not publish", not "publish anyway".
5. **Deterministic and resumable.** Same `(replay, event, model hash,
   classifier version)` produces the same candidate; a run can stop and resume
   without duplicating work.
6. **Cheap filters first.** Run book classifiers and structural gates before
   Mortal; the model pass is the expensive part.
7. **Human review for the last mile.** Automated scoring proposes; a human (or
   an agent-assisted review queue) disposes.

### 6.2 Pipeline

```text
self-play mjai JSONL (generated locally; no third-party input)
        │
        ▼
[1] ingest + validate provenance
        │  (source must be ai_selfplay; model/seed/rule; licence/provenance row)
        ▼
[2] validate replay
        │  (tile conservation, scores, wall count, event order)
        ▼
[3] enumerate decision points + trigger prefilter
        │  (before each self-turn discard, call, riichi, kan, win/pass;
        │   defensive, offensive, book, call, score triggers as recall filters)
        ▼
[4] reconstruct GameState
        │  (rotate actor to seat 0; fill hands, rivers, melds, dora, scores,
        │   tiles_remaining, decision context, call offer, can_riichi)
        ▼
[5] structural validation
        │  (validate_reachable_state + tile ledger + legal actions)
        ▼
[6] book classification
        │  (matches() per lesson; unique answer; situation label)
        ▼
[7] Mortal labelling + counterfactual Q pass
        │  (top-1, full ranking, margin, per-action Q values, safe action,
        │   riichi second pass, call mapping)
        ▼
[8] interestingness scoring + selection
        │  (families, quotas, dedupe, diversity)
        ▼
[9] augmentation
        │  (seat/suit/wind transforms; recompute labels)
        ▼
[10] pack + manifest
        │  (schema validation, hash, size budget, licence gate)
        ▼
[11] publish / audit
        │  (Pages / R2 / HF; loader smoke test; pack report)
```

### 6.3 Reconstructing a `GameState` from a replay

This is the core new library. It walks self-play mjai logs only; there is no
third-party format reader in the ingestion path. A replay walker keeps:

- per seat: hand, melds, river, riichi flag and declaration index, score, wind;
- table: round wind, hand number, honba, riichi sticks, dora indicators
  (revealed so far), ura indicators (from the record, for display after a win),
  wall draws consumed, current turn;
- per event: the actor, the action, the tile(s), and whether it was tsumogiri.

At each decision point:

1. **Snapshot before applying the action.** The actor's hand includes the drawn
   tile for a self turn (14 tiles), or not for a reaction.
2. **Rotate seats** so the actor is `players[0]`; rotate winds, scores, dealer,
   `current_turn`, all `from`/`called_from` references and the river indices.
3. **Fill the decision context:**
   - self turn: `DecisionContext::SelfTurn`, `current_turn = 0`;
   - reaction to a discard: `ReactToDiscard { from, tile }`, `current_turn =
     from`, no draw;
   - reaction to a kan: `ReactToKan { from, tile }`;
   - a call offer for a chi/pon/kan lesson: `CallOffer` with the offered tile
     and consumed tiles.
4. **Compute derived fields:** `hand_string`, `tiles`, `shanten`, `is_agari`,
   `decompositions_count`, `ukeire_tiles`, `ukeire_total` using the same
   helpers the generators use; `can_riichi` via `ai::actions::riichi_is_legal`;
   `book_rationale` via `rationale_for` after the answer is set.
5. **Compute `tiles_remaining`.** Prefer the replay's own wall count; otherwise
   `70 - live_wall_draws` (Tenhou standard), adjusted for kans. Document the
   convention and assert it against the event stream.
6. **Validate** with `validate_reachable_state`. A self-play replay should
   always pass; a failure means the reconstruction (not the game) is wrong.

Open questions to settle in the parser:

- **Ura dora:** store the actual ura indicators from the record, but hide them
  in the UI until a riichi win; or leave them empty for pre-answer simplicity.
  The current `GameState` carries them, so prefer storing them and letting the
  UI hide them.
- **Furiten:** the app may not model it explicitly yet. If a decision is
  furiten-dependent, either compute it in the classifier or reject the state
  until the state model supports it.
- **Kan dora timing:** Tenhou reveals kan dora at specific points; the snapshot
  must use the indicators visible at the decision, not the end-of-hand list.
- **Red fives:** map `5mr/5pr/5sr` (mjai) or `51/52/53` (tenhou6) to the app's
  red-five representation consistently; do not lose the aka flag in scoring.

### 6.4 Book classifiers

The existing lesson modules are **constructors**: they build a hand to satisfy
constraints. The miner needs the inverse: given an arbitrary state, does it
satisfy the lesson, and what is the answer?

Add a pure predicate per lesson, ideally next to the lesson:

```rust
pub(crate) fn matches(state: &GameState) -> Option<Match>;

pub(crate) struct Match {
    pub lesson: ScenarioId,
    pub situation: Option<String>,   // e.g. "extra han, good wait, non-dealer"
    pub target_action: TargetAction,
    pub correct_action: CorrectAction,
    pub equivalent_tiles: Vec<String>,
}
```

Rules for a classifier:

- It must return `None` unless **exactly one** action family/tile (or the
  lesson's declared equivalence class) is correct under the book rule.
- It must use only information visible to the player for the answer; hidden
  facts may be used to *validate* the scenario (e.g. "the threat really is
  tenpai"), but the explanation must not require the player to see them.
- It must not depend on the generator's skeleton or the RNG.
- It must recompute rather than trust `correct_action`/`book_rationale` from the
  state; set them itself.
- It should share the same analysis helpers as the generator (`evaluate_hand`,
  `safety`, `best_completion`, `side_wait_routes`, `ukeire`), so the rule cannot
  drift between construction and recognition.

Start with the broad, high-value lessons:

| Lesson | Classifier difficulty | Why |
| --- | --- | --- |
| `riichi_judgement` | medium | tenpai + legal riichi + the three ch. 7 conditions |
| `dama_bad_wait` / `dama_expensive_hand` / `dama_genbutsu_wait` / `dama_improving_hand` | medium | scoring/waits/genbutsu are computable |
| `push_or_fold` | medium | 1-away + value + wait + threat |
| `fold_to_riichi` / defense safety lessons | medium | safety chart + genbutsu + threat tenpai |
| `suji_trap_riichi` | medium | enumerate discards/waits/suji relations |
| `pinfu_head` | medium | hand shape + head eligibility |
| `honitsu_decision` | medium-hard | five-block potential + value with/without honitsu |
| `meld_or_not` | medium | call offer + hand value/speed |
| `ankan` / `shouminkan` / `daiminkan` | medium | quad shape + trigger conditions |
| `wind_discard_order` | easy | first-turn winds + seat arithmetic |
| block-theory shape lessons | hard | arbitrary-state shape/efficiency comparison; start later |

Tests:

- For each lesson, generate N states with the existing generator and assert
  `matches` returns that lesson (or a documented superset).
- Construct near-miss states and assert `matches` returns `None`.
- Assert every returned `correct_action` is legal in the state.
- Assert the classifier is rotation-invariant after seat normalization.

### 6.5 Mortal labelling

Reuse `ai::wasm_bridge::evaluate_state_named(&model, &state, model_name)` with a
native `MortalV4Model` loaded once. Pin the exact checkpoint (hash and model
name) in every label. The only checkpoint we have is
`mortal_298k.safetensors`; the 4.1/3.0 names are online-service networks, not
local files. If another checkpoint is ever obtained, verify its observation/
action space and convert it through `scripts/convert_weights.py`, then prove
parity with `evaluate_state`; record both identities in provenance. Do not assume
a 4.1 file will load. For each candidate:

- **Top action:** `evaluation.recommended_action`.
- **Ranking:** `evaluation.evaluations`, sorted by probability.
- **Margin:** `p_top - p_second` (and `log p_top - log p_second` if you prefer
  log-odds; store the definition in the schema).
- **Riichi:** when the top action is `Riichi`, the evaluator's second pass
  supplies `riichi_discard`; use it to build `CorrectAction::Riichi { discard }`.
- **Calls:** map `Chi_Low/Mid/High`, `Pon`, `Kan`, `Agari`, `Pass` to the
  existing `CorrectAction::Best` / `Pass` / `Kan` shapes, using the legal-action
  resolver and the call offer.
- **Agreement:** for a book lesson, accept only if the Mortal top action is in
  the lesson's accepted set (`correct_action` + `equivalent_tiles`), compared on
  the full action (a riichi declaration includes its discard). This is the same
  rule as `generator::mortal_agreement`.
- **Multi-model (optional, future):** if another checkpoint is obtained, evaluate
  with each and record the votes. With one model there is no ensemble; never
  call a single model's output "ensemble stable". If members disagree, mark the
  scenario "contested" or reject it; do not silently pick one.

Performance:

- The app's README measures ~41 ms per forward pass on a desktop CPU (roughly
  double when Mortal chooses Riichi because of the second pass). A native build
  with a GPU and batching will be much faster, but plan with the conservative
  number.
- 10,000 games × ~300 decision points ≈ 3M candidates. Labelling all of them at
  41 ms is ~34 hours. That is why the cheap filters come first: a 1–5% hit rate
  leaves 30k–150k evaluations, i.e. 20–100 minutes. With a GPU, more.
- Cache by `(state_hash, model_sha256, options)`; a rerun after a classifier
  change should not re-evaluate the same state.

### 6.5.1 Decision-node trigger filters (adopted from the agent specification)

The agent specification proposes two concrete triggers. They are useful recall
filters, but they are **not** the whole candidate space: a hard 5–12 turn window
would miss opening Riichi judgements, late all-last folds, calls and kans, and
many book lessons. Run them as labelled families with quotas, alongside the
book classifiers.

| Trigger | Precondition | Signal | Families it feeds | Failure mode |
| --- | --- | --- | --- | --- |
| **Defensive / riichi** | At least one opponent has an active Riichi | Target is 0/1/2-shanten; a genbutsu or suji exists; threat is tenpai in the record | push/fold, safety chart, betaori, suji trap | Misses folds before a riichi declaration and states where every tile is dangerous |
| **Offensive / architecture** | No active Riichi | Target is 1-shanten; turn 5–12; at least two legal discards lead to divergent speed/value plans | speed vs value, shape/efficiency, honitsu | Over-selects mid-game; misses 2-shanten value hands and late-game decisions |
| **Book matcher** | Any | A lesson classifier returns a unique match | all book lessons | Low hit rate for narrow motifs |
| **Call / kan** | Any | A chi/pon/kan offer exists, or a concealed/added quad is legal | meld/kan lessons, Mortal calls | Rare in some corpora |
| **Score / placement** | Any | All-last, dealer renchan, honba, riichi sticks, or a large score gap | placement push/fold, riichi/dama | Needs a placement-aware label |
| **Close call** | Any | Top-2 Mortal actions are within a calibrated margin | close-call drills | Can be ambiguous; mark as close |
| **Blunder** | Any | Weak agent's move is far below the strong model's top action | mistake mining | Outcome bias if not careful |

A trigger should record **why it fired** (`trigger: "defensive_riichi"`,
`trigger: "offensive_architecture"`, `trigger: "book:ch8.1"`), so selection can
balance families instead of silently taking the largest bucket.

The "multiple viable tile discard branches" test in the offensive trigger should
be concrete, not a vibe: compare the top two legal discards by the resulting
hand's shanten/ukeire and by `evaluate_hand` / `agari` scoring. Require both
acceptance divergence and value divergence, otherwise the candidate is a close
call or a duplicate.

### 6.5.2 Counterfactual evaluation and thresholds (corrected)

The agent specification asks for per-action EV in points and proposes
`|EV_opt - EV_safe| < 400` and `|EV(a1) - EV(a2)| < 250`. The *idea* is right:
find decisions where the alternatives are close or where the safe line is close
to the best line. The proposed units do not match our engine, though.

Mortal is a DQN. Its network emits a value plus one Q value per action, and
mjai-reviewer exposes those as `meta.q_values` before softmaxing them into the
displayed probabilities. The examples in Mortal's own documentation are values
like `-1.19`, `-1.56`, `-1.62` — model utility units, not mahjong points. The
training target is a kyoku reward/rank utility controlled by `gamma` and the
`pts` configuration, not a raw score delta. Our app's `Evaluation` currently
keeps only the probabilities and the scalar `expected_value`; the per-action
Q values are discarded at the WASM boundary.

So the merged design is:

1. **Expose Q values in the mining path.** The forward pass already computes
   them. Add a native/mining-only `ActionEvaluation.q_value` (or a separate
   `CounterfactualEvaluation`) rather than changing the browser payload unless
   the UI needs it. Keep the legal mask alongside.
2. **Store raw values and units.** Record `q_values`, `q_units:
   "model_utility"`, `model_sha256`, and the model's `pts`/`gamma` if known.
   Never call a raw Q difference "points".
3. **Compute the useful gaps.** `q_gap_top2 = q(best) - q(second)`,
   `q_gap_safe = q(best) - q(safest)`, plus the probability margin
   `p(best) - p(second)`. Absolute Q values are not comparable across positions;
   only differences within the same state are meaningful. The safe action comes
   from `src/safety.rs` (`SafetyFacts::is_absolutely_safe`, suji/kabe), not from
   "Mortal says so".
4. **Select by percentile or probability, not absolute points.** For example:
   "bottom 10% of `q_gap_top2` within this decision family" is a close call;
   "top 10% is an obvious move"; "`q_gap_safe` in the bottom 20% of defensive
   decisions" is a razor-thin push/fold. These are calibrated against the
   corpus, not guessed.
5. **Calibrate to point equity only if the product needs it.** If the copy must
   say "this is a 400-point decision", fit `q_gap -> expected point delta`
   (or rank-point equity) from replay outcomes or Monte Carlo rollouts and
   version the calibration. The agent specification's 400/250 numbers become
   hypotheses to test, not constants.
6. **For speed vs value, use hand analysis as well as Q.** Label one candidate
   "speed" (better ukeire/shanten) and one "value" (higher hand value/yaku/dora)
   using `evaluate_hand`/`agari`; require genuine divergence. Mortal's Q gap then
   tells you whether the trade-off is close.

The counterfactual block in a pack should look like this:

```jsonc
"counterfactual": {
  "model": "mortal_298k.safetensors",
  "model_sha256": "…",
  "q_units": "model_utility",
  "q_values": { "Discard_3z": -0.12, "Discard_7p": -0.58, "Discard_1s": -1.71 },
  "q_gap_top2": 0.46,
  "q_gap_safe": 0.11,
  "probability_margin": 0.18,
  "safe_action": "Discard_3z",
  "calibration_version": null,
  "note": "Q values are model utility, not points."
}
```

This preserves the agent specification's `expected_value_diffs` idea while
fixing the unit error. If a calibrated point delta is later added, put it in a
separate `expected_point_diffs` field with the calibration id; never overwrite
the raw Q values.

### 6.6 Interestingness and selection

See §7 for the full rubric. In the miner, selection is a quota problem, not a
single sort:

```text
for each family (book, contested, mortal_best, mistake, close_call, speed_value,
                 coverage, table_read, placement, multi_step):
    candidates = filter(candidates, family)
    candidates = gate(candidates)          # legality, uniqueness, confidence,
                                           # licence, visible-info, dedupe
    candidates = rank(candidates, family)  # family-specific score
    take top N per book section / decision kind / turn bucket
```

Quotas prevent the easiest family (usually `mortal_best`) from crowding out the
pedagogically valuable ones. Keep a small held-out set for QA.

### 6.7 Pack format

At runtime, a pack is a gzipped JSON document. This is the agent
specification's "chunked JSON scenario files destined for static hosting" with
a manifest, integrity metadata and a real `GameState` inside. Example
(abbreviated):

```jsonc
{
  "schema": "riichiprac.scenario-pack",
  "version": 1,
  "pack_id": "replay.ch8-defense.2026-11",
  "generated_at": "2026-11-14T12:00:00Z",
  "generator": {
    "tool": "mine_replays",
    "version": "0.1.0",
    "commit": "abc1234",
    "classifier_version": "1"
  },
  "source": {
    "kind": "ai_selfplay",
    "corpus_id": "mortal298k-akochan-mixed-2026-11",
    "licence": "CC-BY-4.0",
    "attribution": "Games generated with Mortal 298k (AGPL-3.0) and Akochan (non-commercial, attribution). Scenario pack CC BY 4.0.",
    "redistributable": true
  },
  "scenarios": [
    {
      "id": "replay-9f2c1a7b",
      "lesson_id": "replay_defense_safety",
      "book": { "chapter": 8, "section": 2, "key": "ch8.2", "label": "ch8.2 · Defense basics" },
      "title": "Safest discard against a riichi",
      "prompt": "Which tile do you discard?",
      "state": { /* complete GameState, including correct_action */ },
      "correct_action": { "type": "fold", "discard": "1z" },
      "accepted": ["1z"],
      "mortal": {
        "model": "mortal_298k.safetensors",
        "model_sha256": "…",
        "top_action": "Discard_1z",
        "top_probability": 0.62,
        "margin": 0.18,
        "expected_value": -0.02,
        "value_units": "model_utility",
        "ranking": [ /* full ActionEvaluation list */ ]
      },
      "counterfactual": {
        "q_units": "model_utility",
        "q_values": { "Discard_1z": -0.12, "Discard_5m": -1.71 },
        "q_gap_top2": 0.46,
        "q_gap_safe": 0.11,
        "probability_margin": 0.18,
        "safe_action": "Discard_1z",
        "calibration_version": null
      },
      "played": {
        "kind": "ai",
        "agent": "akochan-<ver>",
        "action": "Discard_5m",
        "mortal_probability": 0.03
      },
      "interestingness": {
        "score": 0.87,
        "book_match": true,
        "mortal_agreement": true,
        "counterfactual_tension": 0.80,
        "coverage": "new",
        "tags": ["defense", "riichi", "genbutsu", "all-last"]
      },
      "provenance": {
        "replay_id": "sha256:…",
        "decision_index": 42,
        "kyoku": "E3",
        "honba": 1,
        "turn": 7,
        "transforms": ["rotate_seat_2"]
      },
      "validation": {
        "state_valid": true,
        "replay_roundtrip": true,
        "answer_recomputed": true,
        "visible_info_only": true
      }
    }
  ]
}
```

**Manifest:**

```jsonc
{
  "schema": "riichiprac.scenario-pack-manifest",
  "version": 1,
  "updated_at": "2026-11-14T12:00:00Z",
  "packs": [
    {
      "id": "replay.ch8-defense.2026-11",
      "path": "packs/replay.ch8-defense.2026-11-9f2c1a7b.json.gz",
      "sha256": "…",
      "bytes": 123456,
      "scenario_count": 120,
      "lesson_ids": ["replay_defense_safety"],
      "book_sections": ["ch8.2"],
      "licence": "CC-BY-4.0",
      "requires_model": false
    }
  ]
}
```

Why this shape:

- The `state` is a complete existing `GameState`; the frontend can render it
  with no new logic.
- `correct_action`/`accepted` duplicate the state's own fields on purpose: the
  pack-level view is convenient for the picker and for validation; Rust
  recomputes the state's copy and rejects a mismatch.
- `mortal` is optional. If present, a user without weights can still see the
  label; if absent, the app recomputes when weights load.
- `counterfactual` stores raw Q values and their gaps in model units; a
  `calibration_version` is required before any field is rendered as points.
- `provenance` is small and does not reveal the answer.
- `validation` is a build-time record; the loader still revalidates the state.

### 6.8 CLI

A native binary, not shipped:

```bash
# Ingest the self-play mjai corpus (no third-party logs) into the local DB.
cargo run --release --features miner --bin mine_replays -- \
  ingest --input "$RIICHI_DATA_DIR/replays" \
  --db "$RIICHI_DATA_DIR/db/miner.sqlite"

# Walk the corpus and extract candidate decision states into the scenario DB.
cargo run --release --features miner --bin mine_replays -- \
  extract --db "$RIICHI_DATA_DIR/db/miner.sqlite"

# Classify against the book and label with Mortal.
cargo run --release --features miner --bin mine_replays -- \
  label --db "$RIICHI_DATA_DIR/db/miner.sqlite" \
  --weights frontend/public/models/mortal_298k.safetensors \
  --model-name mortal_298k.safetensors \
  --classifiers all --agreement

# Select per family/quota, dedupe, transform, and write pack exports.
cargo run --release --features miner --bin mine_replays -- \
  pack --db "$RIICHI_DATA_DIR/db/miner.sqlite" \
  --family book,contested,mistake,close_call,speed_value \
  --quota-per-book-section 50 --out "$RIICHI_DATA_DIR/packs" \
  --max-bytes 50000000

# Snapshot the DB; optionally copy replays + snapshot to Google Drive.
cargo run --release --features miner --bin mine_replays -- \
  backup --db "$RIICHI_DATA_DIR/db/miner.sqlite" \
  --replays "$RIICHI_DATA_DIR/replays" \
  --remote gdrive:riichiprac

# Audit a pack without publishing.
cargo run --release --features miner --bin mine_replays -- \
  audit --manifest "$RIICHI_DATA_DIR/packs/manifest.json" --strict
```

Flags that matter:

- `--source-allowlist ai_selfplay` (fail closed; any other source is rejected);
- `--model-sha256` and `--classifier-version` (cache/reproducibility);
- `--max-bytes`, `--max-scenarios`, `--quota-per-book-section`;
- `--min-margin`, `--min-book-confidence`, `--max-ambiguous`;
- `--trigger defensive,offensive,book,call,score` (enable/disable candidate
  triggers; all on by default, each with its own quota);
- `--q-gap-percentile 10` (close-call selection in model units, not points);
- `--calibration <file>` (optional Q→point-equity calibration);
- `--seed` for transforms;
- `--db <path>` (operational SQLite; default
  `$RIICHI_DATA_DIR/db/miner.sqlite`);
- `--out <dir>` (pack export directory; default `$RIICHI_DATA_DIR/packs`);
- `--remote <rclone:path>` and `--replays <dir>` for the backup command;
- `--json` for machine-readable summaries;
- `--dry-run` for a report without writing packs.

### 6.8.1 Execution rules and incremental tracking

The agent specification's operational advice is worth keeping:

- **Batch, do not thrash.** Load the weights once per process; process a shard
  at a time; expose `--batch-size` and `--max-parallel`; pause between shards
  if the machine is shared. A GPU run should not compete with the app's dev
  server or an interactive session.
- **Track processed work in the operational SQLite DB.** Keep
  `processed_replays(replay_id, sha256, status, attempts, last_error,
  updated_at)` and `processed_decisions(decision_id, state_hash, model_sha256,
  classifier_version, status)` alongside the scenario tables, not in the derived
  analytics DB. Rerunning a corpus skips finished work and retries only
  failures. This is cheaper and simpler than rebuilding the whole candidate
  table.
- **Use `rclone` only as an optional backup for our self-play corpus and DB
  snapshots.** The miner writes local-only and must not require rclone. When the
  operator has configured it, copy the immutable replay folder (`rclone copy
  --checksum --immutable`, never sync with delete semantics) and timestamped
  `VACUUM INTO` DB snapshots, then `rclone check`. Never mount Drive and point
  SQLite at it. It is not an ingestion path for third-party records; the source
  allowlist still runs at ingest and publish, and rclone credentials stay outside
  both repos.
- **Log the funnel.** Count raw events → trigger hits → reconstructed states →
  valid states → classifier matches → Mortal labels → selected → packed. A
  run that silently drops 99.9% of candidates is not a success until the
  reason is visible.
- **Write atomically.** Validate the pack bytes, hash them, write to a temporary
  file, then rename into `frontend/public/scenarios/`; a failed run must not
  leave a half-written pack that the manifest points at.
- **Fail closed.** Bad schema, unknown licence, illegal answer, failed
  validation, or non-reproducible label stops publication for that candidate,
  not the whole batch (unless `--strict` is set).

### 6.9 Validation and tests

The miner's tests should be a mixture of unit, fixture and integration tests:

| Area | Test |
| --- | --- |
| Format conversion | self-play mjai → `GameState` fixture round-trip; tenhou6 export fixture for mjai-reviewer; tile ids, red fives, calls, kans, riichi flags |
| Replay walk | a synthetic 1-kyoku game reaches the expected state at every event |
| State validity | every reconstructed snapshot passes `validate_reachable_state` |
| Tile ledger | 136 tiles conserved (minus kans/replacements), no duplicate fifth tile |
| Book classifier | generated lesson states classify as that lesson; near-misses do not |
| Trigger filter | defensive/offensive fixtures fire; unrelated states do not; each hit records why |
| Mortal label | fixed fixture + weights → exact top action/ranking (parity with `evaluate_state`) |
| Counterfactual units | Q values match Mortal's metadata; probabilities are softmax/Q-derived; no field claims points without calibration |
| Calibration | optional Q→point mapping is versioned; raw Q values are never overwritten |
| Incremental DB | rerunning a shard skips finished decisions and retries only failures |
| Pack schema | serde round-trip, required fields, no unknown answer shapes |
| Prototype mapping | the agent-spec `context`/`board_state`/`solution` fields map into `GameState`/pack fields without loss (Section 9.3) |
| Pack semantics | every `correct_action` is legal; `accepted` contains it; state/category agree |
| Dedupe | identical states collapse; transformed states do not collide |
| Source gate | any `source.kind` other than `ai_selfplay` refuses to pack; missing provenance/licence refuses |
| Storage layout | data root created; replay paths are content-addressed and relative; DB/raw logs are gitignored |
| DB snapshot/restore | `VACUUM INTO` snapshot passes `PRAGMA integrity_check`; restored sample replay hashes match |
| Drive backup (optional) | when the separate rclone task is configured, append-only replay copy and snapshot copy pass `rclone check`; otherwise local-only is valid and recorded as skipped |
| DB→pack export | `selected_scenarios`/`variants`/`packs` rows and the exported JSON pack agree exactly |
| Size budget | manifest + selected packs ≤ configured bytes |
| Frontend smoke | a pack loads through the same import path and renders (vitest; no visual judgement) |

Do not claim a pack is good because a screenshot looks plausible. For visual
work, follow AGENTS.md §6 and hand the artifact to the user.

### 6.10 Performance and storage estimates

These are planning numbers, not measurements:

| Corpus | Games | Raw logs (gz) | Decisions (≈300/game) | Mortal evals at 5% hit rate | Labelling time at 41 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Smoke | 100 | 3–6 MB | 30k | 1.5k | ~1 min |
| Small | 1,000 | 30–60 MB | 300k | 15k | ~10 min |
| Medium | 10,000 | 0.3–0.6 GB | 3M | 150k | ~1.7 h |
| Large | 100,000 | 3–6 GB | 30M | 1.5M | ~17 h |

Q values come from the same forward pass as the probabilities, so exposing them
does not add a model pass; the extra cost is storage and calibration. A
GPU/batched native inference will be much faster than the CPU bound above.
Self-play generation is not the bottleneck; label selection and human review
are.

### 6.11 Roadmap

| Phase | Deliverable | Gate |
| --- | --- | --- |
| **0. Policy** | This document; data-licence/provenance schema; source allowlist | Source allowlist is exactly `ai_selfplay`; any other source is rejected |
| **1. Parser + state** | `replay` module: mjai reader for self-play logs, replay walker, `GameState` reconstruction, `validate_reachable_state` integration, tenhou6 exporter for review | 1-kyoku fixture and 100 self-play games round-trip; all states valid |
| **2. Self-play corpus** | Separate Mortal `libriichi::arena` runner with a pluggable agent protocol; mixed-family plans (M1 Mortal mirror, M2 sampling sweep, M3 Akochan tactics, M4 Akochan vs Mortal if feasible, M5 heterogeneous table if feasible, M6 heuristic baseline); 1k-game smoke corpus; dataset card; local data root + Google Drive rclone backup | Every family report has per-game agent identity/config/sampling (including temperature)/seed provenance; 1k logs parse; 0 invalid states; licence/provenance complete; local replay folder + DB snapshot/integrity pass; when the separate rclone task is configured, backup/check and restore also pass |
| **3. Book classifiers** | `matches()` for the broad lessons; generated-state tests; near-miss tests | Every classifier passes generated/near-miss tests; answers legal |
| **4. Mortal labeler** | Native batch labeler; per-action Q values; caching; book agreement filter; optional future multi-model support; Q-unit calibration | Reproducible labels; parity with `evaluate_state`; Q units documented; no re-eval on rerun |
| **5. Selector** | Trigger families; interestingness rubric; family quotas; dedupe; review report | A 100-scenario hand-reviewed smoke pack with no duplicates/invalids |
| **6. Permutation** | Required stage: seat/suit/rank/wind/red-five variants; per-lesson `TransformPolicy`; re-run classifier/label; reject broken variants; caps/dedupe | Every shipped variant is label-preserving; invalid variants rejected; variant report and caps pass |
| **7. Pack + publish** | Pack/manifest schema; audit; Pages/R2/HF publisher; loader smoke test | Pack loads in the app; hash/byte budgets pass; licence gate passes |
| **8. Frontend loader** | Separate task: manifest fetch, IndexedDB cache, picker integration, ARIA parity | `vitest` + build; no visual judgement from the agent |

The implementation plan splits phases 2 and 5 into separate per-family and
per-transform units; [`replay-implementation-plan.md`](replay-implementation-plan.md)
§5 is the authoritative build order and gate list. Do not start the permutation
stage before the classifier/labeler are stable: a variant gate on top of an
unstable label ships plausible-looking but wrong drills.

Do not start Phase 5 before Phase 3/4 are stable: a selector on top of an
unstable classifier produces plausible-looking but wrong drills.

There is deliberately no BYO-import or human-corpus phase. Those are rejected
alternatives, not deferred work; see §2.6 and §5.10.

---

## 7. What makes a scenario "interesting"? (question 6)

"Interesting" is not one property. Separate **hard gates** (must be true or the
scenario is not shippable) from **ranking signals** (how good it is among
valid candidates).

### 7.1 Hard gates

A candidate is rejected unless all of these hold:

1. **Legal and reachable.** The state passes `validate_reachable_state`, the
   tile ledger is conserved, the melds are legal, and the rivers are a valid
   turn order.
2. **Answer is well-defined.** Either a book rule names a unique action (up to
   `equivalent_tiles`), or Mortal is confident enough for a Mortal drill. "No
   clear answer" is not a scenario.
3. **Answer is legal.** `correct_action` is in the legal action set; a riichi
   answer has a legal discard; a call answer has an offer.
4. **Visible information suffices.** The player can reach the answer from the
   table, their hand and the rules. Hidden-hand facts may validate the scenario
   but must not be required to solve it (unless it is explicitly a "read the
   hidden hand" drill, which is a different product).
5. **Label confidence.** Book match is exact, or Mortal top-1
   probability/Q-gap exceeds a configured (preferably percentile-based)
   threshold. A coin-flip is not a "best" answer.
6. **Source/licence/provenance.** `source.kind` is exactly `ai_selfplay`, the
   model/seed/rule provenance is complete, and the data licence is on the
   allowlist. Any other source, or an unknown licence, means no.
7. **Not a duplicate.** Exact state hash and a near-duplicate fingerprint are
   new to the pack.
8. **No spoiler.** The prompt, title, provenance and pre-answer UI do not name
   the answer or the wait.

### 7.2 Ranking signals

| Signal | How to measure | Why it matters |
| --- | --- | --- |
| **Book alignment** | classifier match + exact unique answer + citation | The book is the app's authority; a cited rule is teachable. |
| **Model agreement** | Mortal top-1 in the accepted set; margin | Two independent perspectives agreeing is stronger than either alone. |
| **Counterfactual gap** | `q_gap_top2`, `q_gap_safe`, probability margin; use percentiles | Razor-thin decisions are more instructive than an obvious 1-tile discard; huge gaps are easy drills. |
| **Decision stakes** | score swing / placement leverage / hand value / threat value | A decision that matters is more memorable than a 1000-point nothing. |
| **Discrimination** | weak agent fails, strong agent succeeds (or top-2 gap) | A scenario that separates good from bad play teaches something. |
| **Novelty/coverage** | distance from existing catalogue; book-section/turn/decision-kind quotas | Avoid a hundred variations of the same ryanmen discard. |
| **Realism** | came from a complete game; no synthetic anomalies; common patterns | Real rivers, calls and score context make the drill transferable. |
| **Explainability** | book citation or a clear model comparison | The player should learn *why*, not just *what*. |
| **Diversity** | per-section, per-turn, per-score, per-decision-kind quotas | A pack should not be one shape repeated. |

A useful composite (configurable, not sacred):

```text
score = 0.25 * book_match
      + 0.15 * label_confidence
      + 0.15 * counterfactual_tension
      + 0.15 * stakes
      + 0.15 * discrimination
      + 0.10 * novelty
      + 0.05 * realism
```

`counterfactual_tension` is the percentile-normalised version of
`q_gap_top2`/`q_gap_safe` from Section 6.5.2, not a raw point value. But keep
the score as a **ranking** within a family, after the gates. Do not let a
single scalar hide a licence failure or an ambiguous answer.

### 7.3 Interesting families beyond the book

The task specifically asks for ways to find interesting scenarios that do not
line up exactly with book lessons. These are the strongest:

1. **Model-vs-model blunder mining.** Use Akochan with a different tactic, or a
   heuristic baseline, against the `mortal_298k` labeller. The gap is a mistake;
   the position before it is a drill. This is the closest thing to "real human
   error" without human data.
2. **Policy disagreement.** Mortal vs Akochan disagree (same table if the bridge
   is feasible; otherwise compare across corpus games). Either ship as
   "contested" with both lines, or use the disagreement to find states where the
   "obvious" move is not obvious. Do not call sampling variants of the one
   Mortal checkpoint a model disagreement.
3. **Close calls.** Top-2 actions within a small margin. These train judgement
   and are naturally hard; label them as close rather than pretending there is a
   unique best.
4. **Speed vs value.** A 1-shanten hand where the speed line and the value line
   genuinely diverge (Section 5.6.1). It is a specific, teachable trade-off, not
   just a close call, and deserves its own quota.
5. **High-leverage / high-stakes.** All-last, dealer renchan, honba, riichi
   sticks, a big hand vs a big threat. The correct line may be book or Mortal,
   but the context is what makes it interesting.
6. **Coverage gaps.** Mine states that fill a book section, decision kind, turn
   range or score band the current catalogue under-represents. This is a
   curriculum-completion objective, not a "rare" objective.
7. **Rare motifs with a clear rule.** Suji traps, kabe, one-chance, double
   one-chance, genbutsu waits, dora traps, furiten. The motif is rare but the
   answer is principled; good for advanced drills.
8. **Table-reading drills.** Real rivers with irrelevant information: which
   tile is safest, which wait is plausible, which call changed the hand. The
   answer can come from the safety chart or from the hidden hand (for a read
   drill), but the scenario must say which kind it is.
9. **Continuation / multi-step.** A short sequence from a complete self-play
   game teaches plan continuity, call timing and defense over time. This is a product feature, not
   just a data filter.

### 7.4 Anti-patterns

- **Outcome bias.** Do not label a move "correct" because the player won, or
  "wrong" because they dealt in. Use the rule/model, not the result.
- **Hindsight.** Do not use future draws, ura dora or later discards to justify
  the answer. The snapshot must be the information available at the decision.
- **Hidden-information answers.** "Discard 1z because the opponent's hand is
  waiting on 2z" is not a defense-chart drill. Either make it a read drill or
  reject it.
- **False uniqueness.** If two actions are within noise, do not call one
  uniquely correct. Use `equivalent_tiles`, "close call", or "contested".
- **Rarity as value.** A one-in-a-million state is not automatically useful.
  Prefer common patterns that transfer.
- **Mortal worship.** Mortal is a strong policy, not ground truth. Prefer book
  agreement, or explicitly label a Mortal-only drill. With one checkpoint there
  is no ensemble to appeal to.
- **Spoiler leakage.** A provenance line that says "the wait was 3p" ruins the
  drill. Keep provenance about the game, not the answer.
- **Duplication.** Ten seat rotations of the same state are not ten scenarios.
  Dedupe after transforms.
- **Licence laundering.** "CC BY" on a Tenhou derivative is not permission.

### 7.5 Curation workflow

1. **Automatic gates** (above) produce a candidate set.
2. **Family ranking** proposes a shortlist per book section and per non-book
   family.
3. **Human/agent review** reads the candidate's table, rationale, Mortal
   ranking and provenance; rejects anything ambiguous, illegal, spoiling or
   unteachable.
4. **Pack assembly** applies quotas, dedupe and size budget.
5. **Post-ship telemetry** (local only, or aggregate with consent): answer
   accuracy, time, skip rate, "too easy"/"too hard", reported ambiguity. Retire
   or re-label bad scenarios; mine more of what works.

A human review step is not a luxury. The interestingness score can rank, but it
cannot tell whether a position *teaches* something. That is the same principle
as AGENTS.md §6: do not let the agent's own taste sign off the work.

---

## 8. Recommendation and open questions

### 8.1 Recommended build

1. **Adopt the policy:** AI self-play is the only replay source; no third-party
   corpus is acquired, ingested or shipped; packs carry model/seed provenance
   and a licence; the publisher rejects any other `source.kind`.
2. **Build the replay library first:** mjai self-play reader → replay walker →
   `GameState` → `validate_reachable_state`, with fixtures and tests, plus a
   tenhou6 exporter for mjai-reviewer. This is the highest-risk,
   highest-leverage piece.
3. **Build the self-play corpus runner separately:** Mortal `libriichi::arena`
   with the one `mortal_298k` checkpoint, plus Akochan and heuristic/reference
   policies; dump mjai logs to the local data root and back them up to Google
   Drive with rclone. The runner code lives in a **private** corpus repo outside
   the app repo; the raw logs do not live in that repo. Keep the native arena in
   the private repo or invoke it as a subprocess; the app repo is already
   AGPL-3.0-or-later because of its ports, and the native arena still stays out
   of the shipped build.
4. **Add book classifiers** for the broad lessons, starting with Riichi/dama,
   push/fold, defense safety, suji trap, pinfu head, honitsu and the call/kan
   lessons. Test them against the existing generators.
5. **Add the native Mortal labeler** using the app's existing `MortalV4Model`;
   expose per-action Q values, cache by state/model/classifier hash, and
   calibrate Q gaps before any point-denominated copy. With one checkpoint there
   is no ensemble to run; multi-model support is optional and future-only.
6. **Ship one small pack** (for example 100 ch. 8 defense scenarios) through a
   lazy-loaded manifest, and measure load size, cache behaviour, answer
   accuracy and user feedback before scaling.
7. **Only then** add the frontend pack loader as a separate task, and consider
   multi-step drills.

### 8.2 Open questions for the product owner

1. **How do we make self-play varied and human-like enough?** The decision is
   self-play only; the remaining question is the recipe (Akochan/heuristic
   frequency, sampling, seat schedule, seed schedule), not the source. With
   one Mortal checkpoint, the Mortal ladder is not a variety lever.
2. **Do we want more neural policies?** If so, the options are to obtain
   permission/weights, train our own checkpoint (a separate, large project), or
   add another open engine. None is assumed by this plan.
3. **What is the primary interestingness target?** Book-aligned drills,
   mistake mining, close calls, speed vs value, or coverage? The pack mix and UI
   copy differ.
4. **Data licence:** CC BY 4.0 for packs (attribution, simple) vs CC0 (maximum
   reuse) vs MIT (code-style, awkward for data)? The app code is
   AGPL-3.0-or-later; the data needs its own licence file.
5. **Pack hosting:** Pages-only for small packs, or R2/HF for pack bodies?
   The raw corpus and SQLite DB live locally and back up to Google Drive; Drive
   is not a pack host. Pages is simplest; R2 is cheap and CORS-friendly.
6. **Ship Mortal labels?** Precomputed labels make packs useful without the
   43 MB weights, but they can go stale and they spoil the answer in the JSON.
   Recompute on load is cleaner but requires weights. A hybrid is possible.
7. **How much human review?** A 100-scenario pack can be hand-reviewed; 10,000
   cannot without a review tool. What is the budget?
8. **Multi-step drills now or later?** Single snapshots reuse the current UI;
   sequences need a step engine and new grading/history behavior.
9. **Do we need point-denominated EV copy?** Q values are model utility. If the
   UI or explanations must say "a 400-point decision", we need a calibrated
   Q→point mapping and a validation set; otherwise use margins/percentiles.

### 8.3 What this document does not claim

- It does not claim that any Tenhou/Mahjong Soul-derived dataset is safe to
  ship. It says the opposite.
- It does not leave a third-party replay door open. The decision is AI
  self-play only; the licensing analysis is the reason, not a menu.
- It does not claim Mortal is ground truth. It is a strong policy and one
  perspective, which is why the app already shows book and Mortal side by side.
- It does not assume the 4.1/3.0 Mortal weights are available offline. Those are
  online-service networks; the only local checkpoint is `mortal_298k`.
- It does not claim the size/performance numbers are measured. They are planning
  estimates; the first smoke corpus should replace them with real numbers.
- It does not implement the miner, the pack loader or any frontend change. It is
  the design and the licensing analysis for the task that will.

---

## 9. Comparison with the autonomous-miner agent specification

The separate writeup (`riichi_replay_mining_scenario_agent_specification.md`,
reviewed 2026-11-14) is a short execution recipe for one backend agent. It is
not a licensing or product analysis. That is its strength: it names concrete
triggers, a counterfactual pass, two scenario categories, a prototype JSON
shape, and batch/checkpoint rules. This section records what we adopted, what
we corrected, and how its fields map into the merged design. The external file
is not checked in; this section is the durable record of the comparison.

At a glance:

| Dimension | This document (before merge) | Agent specification | Merged position |
| --- | --- | --- | --- |
| Scope | end-to-end: sources, licensing, scenario design, hosting, miner | one autonomous miner's execution recipe | end-to-end plan with a concrete miner recipe |
| Source/licensing | detailed; self-play recommended | not addressed; "personal storage" logs assumed | **self-play only**; any other source rejected |
| State model | full `GameState` + app validation | thin `board_state` | full `GameState`, prototype fields as metadata |
| Label source | book + Mortal, contested option | Mortal optimal vs played | book + Mortal + Akochan/heuristic agent; no neural ensemble with one checkpoint |
| Value units | probabilities + scalar value | per-action EV in points | raw Q values + probability; calibrated points only if needed |
| Triggers | broad families, no hard windows | defensive/offensive triggers | concrete triggers as recall filters with quotas |
| Output | pack + manifest schema | compact prototype JSON | pack schema with `GameState`; field mapping in 9.3 |
| Operations | pipeline + hosting | batch, SQLite, rclone, schema check | adopted in 6.8.1 |
| Validation | extensive table + gates | one line ("schema validation") | extensive table + Q-unit/trigger/calibration tests |

### 9.1 What it adds

1. **Concrete decision-node triggers.** Defensive: an opponent is in Riichi and
   the target is 1- or 2-shanten. Offensive/architectural: the target is
   1-shanten, turns 5–12, unthreatened, with multiple viable discard branches.
   These are useful recall filters and are now Section 6.5.1.
2. **A counterfactual evaluation pass.** Extract all legal actions, query Mortal
   for each, compare the model's best action with the played action. This is the
   right shape for mistake mining and close-call selection; it is now Section
   6.5.2.
3. **Two named product families:** `riichi_push_fold` and "speed vs value". The
   first maps to our push/fold and defense families; the second is a genuinely
   useful non-book family, now Section 5.6.1.
4. **A compact prototype schema.** `scenario_id`, `category`, `context`,
   `board_state`, `prompt`, `solution.optimal_discards`,
   `solution.expected_value_diffs`, `solution.mortal_commentary`. The field
   names are useful for a first smoke pack; Section 9.3 maps them to the real
   `GameState`/pack schema.
5. **Operational discipline.** Batch jobs, SQLite tracking to avoid
   reprocessing, schema validation before writing public assets, `rclone` for
   the self-play corpus. These are now Section 6.8.1.

### 9.2 Where it needs correction

| Agent-spec assumption | Why it does not hold | Merged resolution |
| --- | --- | --- |
| "Mortal EV" for every action, in points, with 400/250-point thresholds | Mortal is a DQN. The network emits a value plus one Q value per action; mjai-reviewer exposes `meta.q_values` and then softmaxes them into probabilities. Mortal's own examples are values like `-1.19`, `-1.56`, `-1.62` — model utility, not points. The training target is a kyoku reward/rank utility governed by `gamma`/`pts`. | Store raw Q values with `q_units: "model_utility"`; use probability margin and Q-gap percentiles; calibrate to point equity only if needed. Section 6.5.2. |
| `agari` provides "game rule validation, shanten calculations, and legal move generation" | `agari` is a hand-analysis crate (shanten, yaku, ukeire, scoring). It does not own a four-player game state, a replay walker, or the app's legal-action rules. | Use `agari` for hand analysis; use the replay walker plus the app's `GameState`/`src/ai/actions.rs` for legal actions and rule state. Section 6.3–6.4. |
| `board_state` is enough for the frontend | It omits opponents' hands/melds/rivers, winds, seat scores, turn, riichi state, ura dora, `can_riichi`, decision context and the book rationale. The app cannot render or grade it without rebuilding all of that. | Ship a complete `GameState`; keep the prototype fields as optional metadata/aliases. Section 6.7. |
| `solution.mortal_commentary` is model prose | Mortal's policy net does not produce prose. Inventing a "Mortal commentary" string would be fabricated attribution. | Use `book_rationale` for the book side; for the model side show the ranking/attribution line, or add a human-written explanation clearly marked as such. |
| `solution.optimal_discards: ["3z", "3z"]` | A discard names one tile type; two copies of the same tile are not two answers. The app distinguishes exact tile, equivalent tiles and action family. | Use `correct_action` + `accepted`/`equivalent_tiles`; a call uses `CorrectAction::Best` with `tiles`. |
| Fixed absolute thresholds are portable | "Razor-thin" depends on the decision family, model, round and score. A 400-point gap in one context is huge; a 250-point gap in another is obvious. Q units are not points at all. | Percentile/calibrated thresholds per family; the agent spec's numbers are hypotheses, not constants. |
| Input is "raw MJAI/JSON logs synced from personal storage" | The source could be Tenhou, Mahjong Soul or a private corpus; the spec has no licence/provenance gate. `rclone` does not create redistribution rights. | Source allowlist at ingest and publish is exactly `ai_selfplay`; any third-party log is rejected. Section 2 and Section 4.5. |
| Categories `riichi_push_fold` / speed-vs-value are the app's scenario IDs | The app's manifest uses `ScenarioId`/`lesson_id`, book sections and `category` enums (`riichi_decision`, `defense_decision`, ...). A new naming scheme would fork the picker and grading. | Add replay lesson IDs (for example `replay_push_fold`, `replay_speed_value`) under the existing manifest, with `book` metadata where applicable. |
| The "human player's actual choice" is always available | Self-play logs have an agent's played action, not a human's. Human corpora are excluded. | Call the field `played` with `kind: "ai"` and agent/model identity; there is no human-expert-line family. Section 5.10. |
| One pass over "all legal actions" is cheap | It is one forward pass per decision, not per action, but the candidate volume is still millions; without cheap filters the run is tens of hours. | Cheap structural/book/trigger filters first; one batched forward pass per retained state; cache. Section 6.5 and 6.10. |

### 9.3 Field mapping

| Agent-spec field | Merged field | Notes |
| --- | --- | --- |
| `scenario_id` | `id` | Keep a stable content hash; the agent-spec prefix is fine as a display id. |
| `category: "riichi_push_fold"` | `lesson_id: "replay_push_fold"` + `book` | Use the existing manifest; `category` remains the broad enum. |
| `context.round: "EAST_3"` | `state.round_wind`, `state.hand_number` | The app stores wind + hand number, not a display string. |
| `context.honba` / `riichi_sticks` | `state.honba` / `state.riichi_sticks` | Direct. |
| `context.player_seat` | `provenance.original_seat` | The state is rotated so the actor is seat 0; keep the original seat for provenance. |
| `context.scores` | `state.players[].score` | Rotated with the seats. |
| `context.dora_indicators` | `state.dora_indicators` | Only indicators visible at the decision; not future kan dora. |
| `board_state.hand` | `state.players[0].hand` (+ `draw` on a self turn) | Use the app's tile codes; no duplicate copy semantics. |
| `board_state.melds` | `state.players[].melds` | Include all four seats, not just the actor. |
| `board_state.discards_by_player` | `state.players[].discards` | Keep tile, tsumogiri flag, riichi flag and declaration index. |
| `board_state.wall_tile_count` | `state.tiles_remaining` | Document the 70-live-wall convention. |
| `prompt` | `prompt` / `scenario_note` | Must not name the answer or the wait. |
| `solution.optimal_discards` | `correct_action` + `accepted`/`equivalent_tiles` | One action family, not duplicate tile copies. |
| `solution.expected_value_diffs` | `counterfactual.q_values` + `q_gap_top2` / `q_gap_safe` | Raw model utility; optional `expected_point_diffs` only with a calibration id. |
| `solution.mortal_commentary` | `book_rationale` or a marked human explanation | Do not fabricate model prose. |
| *(missing)* opponents' hidden hands | `state.players[].hand` | Needed to validate threat tenpai; hidden by the UI. |
| *(missing)* `can_riichi`, decision context, call offer | `state.can_riichi`, `state.decision`, `state.call_offer` | Required for grading and UI. |
| *(missing)* validation/provenance/licence | `validation`, `provenance`, `source` | Required for publication. |

### 9.4 The merged position

- **Keep the agent specification's triggers** as labelled recall filters, not
  hard gates.
- **Keep its counterfactual pass**, but expose and store Q values in model
  units; use probability/Q-gap percentiles and calibrate before quoting points.
- **Keep its speed-vs-value family**, with concrete speed/value divergence via
  `evaluate_hand`/`agari`, not just "two close discards".
- **Keep its operational rules** (batch, SQLite, atomic writes, schema checks).
- **Replace its thin board schema with `GameState`**, and its duplicate
  `optimal_discards` with `correct_action`/`accepted`.
- **Add the missing source gate:** `ai_selfplay` only, with model/seed
  provenance, and the book/Mortal dual-label model.
- **Do not use its fixed 400/250-point thresholds as literals**; they become
  calibration hypotheses.

The result is one implementation path: AI self-play logs → replay walker →
`GameState` + triggers → book classifiers and Mortal Q/probability labels →
calibrated selection → validated static packs → lazy-loaded frontend. There is
no third-party or human-log branch in that path.

---

## 10. Product policy: replay-first scenarios (approved 2026-11-19)

The miner is not only a source of extra drills. The product target is that
**replay-based scenarios are the default and prominent source**, and generated
scenarios are the alternative a user opts into.

- **Coverage-aware default.** A lesson is replay-default when its shipped pack
  has at least 40 reviewed bases (the coverage floor). Below the floor, the
  generated drill remains the default; replay rows stay opt-in as today. The app
  reads per-lesson counts from the pack manifest (`lesson_counts`), never by
  downloading a body.
- **Generated is never removed.** The picker gains a Replay/Generated/Both
  source filter and a `preferReplay` setting. Every generated lesson remains
  selectable; it is demoted, not deleted.
- **Every lesson is in scope.** Four lessons had no classifier
  (`chiitoitsu_riichi_vs_dama`, `chiitoi_vs_toitoi`, `sanshoku_pursuit`,
  `open_hand_defense`) and therefore no mining path. Adding those recognisers
  was required work, not a reason to leave them generated-only; they landed in
  one task (`B4`) with one `CLASSIFIER_VERSION` bump (v3) and one label pass,
  because the version keys the label cache. The measured yield is in
  `testdata/reports/b4-classifiers/label-yield-report.md`.
- **Coverage is published as section packs.** One pack per book section keeps
  the lazy-load budget small and lets a single body serve several lessons. The
  existing ch8 packs remain the first two.
- **AI self-play is not human replay.** This strategy's source decision
  (Section 2) stays: the shipped replay source is AI self-play. A human corpus
  is a separate licensing/evaluation decision (the rollout's D1 task), so the
  product must not describe the current packs as human games.

The rollout, coverage table, task sequence and acceptance gates are in
[`replay-first-rollout.md`](replay-first-rollout.md).

---

## Appendix A — Source notes

Checked 2026-11-14:

- Agent specification compared in Section 9:
  `/home/kylehipke/Downloads/riichi_replay_mining_scenario_agent_specification.md`
  (external, not checked in).
- Tenhou manual: <https://tenhou.net/man/> (logs, `/0/ /5/ /6/` URLs, gzipped
  XML, 40-entry history, 10-day paid download, copyright notice, AI section).
- Tenhou 2017 policy post: <http://blog.tenhou.net/article/181504123.html>
  (Houou records public; no use for competing products; apply to download;
  companies sponsor).
- `Apricot-S/houou-logs`: <https://github.com/Apricot-S/houou-logs>
  ("Tenhou prohibits redistribution"; single session; 20-minute interval).
- mjai-reviewer: <https://github.com/Equim-chan/mjai-reviewer> (Tenhou/Mahjong
  Soul/Riichi City/Hime inputs; tenhou6 custom log; Mortal/akochan engines;
  Apache-2.0).
- mjai format standardisation: <https://github.com/Cryolite/mjai> (replay vs
  in-game mode; event names; hub-format rationale).
- Mortal: <https://github.com/Equim-chan/Mortal> (AGPL-3.0; emulator; mjai;
  `libriichi::arena`; 40K hanchans/hour claim; available checkpoint AGPL-3.0).
- Mortal docs and the "weights" statement:
  <https://mortal.ekyu.moe/> (the "Okay cool now give me the weights!" section
  points at the author's post below); the online service lists the 4.1a/b/c,
  4.0 and 3.0 networks at <https://mjai.ekyu.moe/>.
- Mortal author's weights post:
  <https://gist.github.com/Equim-chan/cf3f01735d5d98f1e7be02e94b288c56>
  (2022-08-19 update: no current plan to release the trained model).
- Available community checkpoint:
  <https://huggingface.co/VoidShine/mortal-298k> (`mortal_298k.pth`, AGPL-3.0;
  model card says it was trained on Tenhou hanchan data).
- Mortal's `q_values` metadata and example outputs:
  <https://github.com/Equim-chan/Mortal/blob/main/docs/src/user/docker.md>
  (the `-1.19`-style values that show Q values are model utility, not points).
- Mortal training reward configuration (`pts`, `gamma`):
  <https://github.com/Equim-chan/Mortal/blob/main/mortal/config.example.toml>
  and `mortal/reward_calculator.py`.
- mjai-reviewer's Mortal review path (reads `meta.q_values`, softmaxes to
  probabilities):
  <https://github.com/Equim-chan/mjai-reviewer/blob/master/src/review/mortal.rs>.
- Mortal arena source:
  <https://github.com/Equim-chan/Mortal/tree/main/libriichi/src/arena>.
- Akochan: <https://github.com/critter-mj/akochan> (custom licence; output
  reuse for non-commercial with attribution; self-match).
- Kanachan: <https://github.com/Cryolite/kanachan> (no public crawler, no
  training data, no trained models; Mahjong Soul data collection).
- Kanachan data discussion:
  <https://github.com/Cryolite/kanachan/discussions/71> (lawyer opinion on
  sharing records; self-play data not subject to Mahjong Soul terms).
- Suphx: <https://www.microsoft.com/en-us/research/project/suphx-mastering-mahjong-with-deep-reinforcement-learning/>
  (research project; no public code/weights).
- NAGA: <https://dmv.nico/ja/articles/mahjong_ai_naga/> (proprietary service).
- GitHub Pages limits:
  <https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits>
  (1 GB site, 100 GB/month soft).
- GitHub Releases:
  <https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases>
  (2 GiB per asset; no CORS for browser fetch).
- Hugging Face storage limits:
  <https://huggingface.co/docs/hub/en/storage-limits> (public best-effort;
  private 100 GB free; 500 GB/file hard; <200 GB recommended).
- Hugging Face pricing: <https://huggingface.co/pricing>.
- Cloudflare R2 pricing: <https://developers.cloudflare.com/r2/pricing/>
  (10 GB free, zero egress).
- rclone Google Drive backend: <https://rclone.org/drive/>
  (backup/transport; not a live database host).
- SQLite `VACUUM INTO`: <https://www.sqlite.org/lang_vacuum.html>
  (consistent DB snapshot without copying a live WAL).
- Existing app docs: `hosting-plan.md`, `mortal-validation.md`,
  `scenario-fuzz-plan.md`, `scenario-report-plan.md`, `ai-scenario-plan.md`,
  `README.md`.

## Appendix B — Existing code the miner should reuse

| Path | Role |
| --- | --- |
| `src/state.rs` | `GameState`, `CorrectAction`, `TargetAction`, `DecisionContext`, `CallOffer` |
| `src/generator/support/state_validation.rs` | `validate_reachable_state` and the reachability/timeline checks |
| `src/generator/mod.rs` | `SCENARIO_MANIFEST`, `generate_puzzle`, `finalize_state`, `GeneratedPuzzle` |
| `src/generator/mortal_agreement.rs` | the accepted-answer comparison rules; reuse them for replay agreement |
| `src/ai/wasm_bridge.rs` | `Evaluation`, `evaluate_state_named`, legal-action mask, riichi second pass |
| `src/ai/model.rs` | `MortalV4Model`; the native forward pass that already produces the 47 outputs |
| `src/ai/encoder.rs` | `encode_v4_observation`, tile index/name mapping |
| `src/decision.rs` | `ActionEvaluation` / `ActionInfo`; the place to add a mining-only Q value |
| `src/ai/actions.rs` | legal-action resolution; `riichi_is_legal` |
| `src/export/tenhou6.rs` | tenhou6 tile ids and naki strings; reuse for export/view |
| `src/report/model.rs` | `riichiprac.scenario-report`; a single-candidate review format |
| `src/rationale.rs` | book citations and `rationale_for` |
| `src/safety.rs` | ch. 8 safety chart, suji/kabe arithmetic, `SafetyFacts` |
| `src/generator/support/analysis.rs` | `evaluate_hand`, shanten/ukeire helpers |
| `src/generator/support/completion.rs` | waits/completion helpers used by shape lessons |
| `agari` (dependency) | shanten, yaku, ukeire and scoring analysis; **not** a four-player simulator or legal-action engine |

## Appendix C — Glossary

- **mjlog** — Tenhou's original gzipped XML game record.
- **tenhou6** — the `tenhou.net/6` JSON format used by the Tenhou editor and
  mjai-reviewer's "custom log" input.
- **mjai** — a JSON Lines event format for mahjong AI games; the de facto hub
  format for replay conversion.
- **hanchan** — a full East+South game (up to 8 kyoku).
- **kyoku** — one hand/round.
- **genbutsu** — a tile a player has already discarded after riichi; 100% safe
  against that riichi.
- **suji** — a tile that is relatively safe because of the discards around a
  wait; not absolute.
- **kabe / no-chance** — a tile that cannot be part of an opponent's wait
  because all four copies of a neighbouring tile are visible.
- **furiten** — a player cannot win on a tile they have discarded (or, for
  temporary furiten, have just passed on).
- **Q value** — Mortal's per-action value output from its DQN head. It is a
  model utility, not a mahjong point delta; the app currently softmaxes Q values
  into probabilities and does not expose them at the WASM boundary.
- **model utility** — the scale of Mortal's Q values/value head. The training
  target is a kyoku reward/rank utility controlled by `gamma` and `pts`, so
  raw values cannot be quoted as points without calibration.
