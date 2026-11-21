# 3D HUD: composition spec and overlay contract

**Status: proposed 2026-11-19 — awaiting the user's verdict (AGENTS.md §6).**
This is implementation unit 3D-H1 of the 3D HUD chain. It changes no app code:
it is the composition and the overlay contract that 3D-H2 … 3D-H5 implement
against, and the answers to §12 are the only thing still open. The units'
dependency and gate table is §11 of
[`3d_renderer_implementation_plan.md`](3d_renderer_implementation_plan.md).

The board is the interface. The 3D view owns the whole window, so every pixel
of chrome is borrowed from the table; this document decides exactly which
pixels are borrowed, what they hold, and what may never be covered.

Numbers in this document are **measurements**, not authored constants. They come
from the committed projection (`hitRects()`, `compassPlateRect()`,
`frameForAspect()`) applied to the full board fixture, at CSS pixels. The gate
re-computes them; if a future layout change moves the table, the numbers here
and the gate move together and the composition rules below stay the same.

---

## 1. Principles

1. **The app's name is the only identity** (user decision 2026-11-19; brand
   added 2026-11-20). "riichiprac" sits on the very top-left of the top bar with
   the setup trigger under it — user request 2026-11-20. Never a scenario name
   and never a lesson label: what this hand is for lives in the setup sheet, one
   tap away, and a visible lesson name is also an answer hint.
2. **The board is not resized for chrome.** The camera rig is the committed,
   signed-off one (plan §2.4, §9 decision 2). The HUD floats over the scene and
   reserves nothing from the canvas; it positions itself in the gaps the table
   leaves.
3. **One hand.** The hand and draw tiles are the projected DOM buttons from
   3D-08. The HUD never renders a second hand, a tile strip, or a thumbnail of
   them.
4. **Pre-answer, only the calls.** Next hand is always in the top bar; the only
   other chrome is the **isolated call row** above the hand while there is a
   call to make. There is no over-hand panel, hint line or Mortal chip (user
   change 2026-11-21). The one panel is the result card, and it appears only
   after an answer. **Everything else is a sheet or a toast** (user decision
   2026-11-19).
5. **A sheet is a modal, not a column.** It covers the scene while open, the
   scene is `inert`, and one is open at most.
6. **The result starts small.** A result card summarises; only a tap opens the
   full verdict. Nothing auto-expands over the board (user decision).
7. **Nothing is judged by eye.** Every rule below is a rect, a clearance, a
   contrast ratio or a token; the gate prints them (AGENTS.md §6).

---

## 2. Region map

Five named HUD regions, plus the scene rung they float over. The pre-answer
call row is a bare rect of buttons (no surface); the one panel is the
post-answer result card.

```
┌─ stage (fixed, whole window) ─────────────────────────────────────────┐
│  canvas + scene overlay (3D-08 hand buttons, 3D-09 compass)           │
│                                                                       │
│   ┌─ TOP BAR ────────────────────────────────────────────────────┐    │
│   │  riichiprac                                                  │    │
│   │  setup ▸                    Next hand ▸   full screen ▸      │    │
│   └──────────────────────────────────────────────────────────────┘    │
│                                                                       │
│                        compass (scene)                                │
│                                                                       │
│                       [ Chi ][ Pon ][ Pass ]  (call row, bare)        │
│                   ┌─ RESULT PANEL (after an answer) ─┐                 │
│                   │  outcome row + picks line        │                 │
│                   └──────────────────────────────────┘                 │
│                hand + draw (scene, projected buttons)                 │
│                                                                       │
│  sheet (modal, on demand)      toast stack (top centre, transient)    │
└───────────────────────────────────────────────────────────────────────┘
```

| Region | Contents | Visibility | Owner |
| --- | --- | --- | --- |
| **Top bar** | the app name (top-left) with the setup trigger under it, plus Next hand on the right (the result card and the verdict sheet carry their own after an answer, §4) and the full-screen toggle | always | H2/H4 |
| **Call row** (pre-answer) | the shared `CallControls` bar (Chi/Pon/Kan/Riichi/Pass, then a tile pick) plus any remaining non-call drill action, as **isolated buttons with no panel surface**, right-aligned to the hand band | while unanswered and non-empty | H3 |
| **Result panel** (post-answer) | one anchored surface with the compact result (`AnswerSummary` + one line of verdict) and its own Next control | after an answer only | H5 |
| **Setup sheet** | scenario pool, AI Hotseat, settings, position, table info, notes | on demand | H4 |
| **Verdict sheet** | full `VerdictPanel` (book, Mortal, ranking, explanation, peek) | on demand | H5 |
| **Toast stack** | status, error and file notices | transient/persistent, max 3 | H3 |
| **Scene rung** (unchanged) | canvas, hand buttons, compass, host notices, debug/perf HUDs | — | 3D-02/08/09/10/13 |

There is **no pre-answer panel** (user change 2026-11-21): the call row is a
bare rect of buttons, so nothing surfaces over the felt until the player has
answered. The result panel is the only panel, and it exists only after the
answer. The call row is *unmounted when it would be empty* (a plain discard
lesson with no riichi/call), so the board is never covered by an empty box.
There is no hint line and no Mortal chip in 3D.

Toasts stack under the top bar, newest first, at most three; each is at most two
lines with an ellipsis and a Details affordance when it has more. Loading
status persists while it is true (`statusMessage`), an error persists until the
next deal (`role="alert"`), and a file notice is dismissible. Nothing toasts
over the hand, the panel or the compass — the stack is measured into the
collision set like any other rect.

---

## 3. Control inventory

Every element the 2D shell renders today, and where it goes in 3D. "Dropped"
means the control does not exist in the 3D view; it always comes with the
reason. No element of `App.tsx`'s 2D return is left unmapped.

Legend for the destination column: **TOP BAR**, **CALL ROW** (the isolated
pre-answer row, §2), **RESULT CARD** (the one post-answer panel), **SETUP
SHEET**, **VERDICT SHEET**, **TOAST**, **SCENE** (3D-02/08/09, unchanged),
**DROPPED**, **2D ONLY**.

| # | Element (source) | Today | In 3D | Unit |
| --- | --- | --- | --- | --- |
| 1 | `.app-title` "riichiprac" (`App.tsx`) | header brand | **TOP BAR** — the app's name only, on the very top-left with the setup trigger under it (user request 2026-11-20); no scenario or lesson name | H2/H4 |
| 2 | Sticky `.app-header` column | 2D shell header | **DROPPED** — replaced by the floating top bar | H2 |
| 3 | `ScenarioPicker` trigger + caret | header control | **SETUP SHEET** — the pool section; the setup trigger is its front door | H4 |
| 4 | `selectionLabel` (pool name in the trigger) | header | **SETUP SHEET** only (pool summary); never in the top bar | H4 |
| 5 | "Scenario pool" heading + hint | panel | **SETUP SHEET** | H4 |
| 6 | Pack note (`role="status"`, pack loading/error/empty) | panel | **SETUP SHEET** | H4 |
| 7 | "All scenarios (random)" checkbox | panel | **SETUP SHEET** | H4 |
| 8 | Section tri-state checkbox + label + count | panel | **SETUP SHEET** | H4 |
| 9 | Lesson checkbox + label + AI/REPLAY badges | panel | **SETUP SHEET** | H4 |
| 10 | Per-lesson "Only" / "Setup" button | panel | **SETUP SHEET** | H4 |
| 11 | Pool summary (`aria-live`) | panel | **SETUP SHEET** | H4 |
| 12 | Cancel / "Deal from pool" | panel | **SETUP SHEET**; a deal closes the sheet | H4 |
| 13 | Panel dismiss (outside click, Escape) | panel | the H2 sheet's own rules (§6.5) | H2/H4 |
| 14 | "Mortal must agree" checkbox + label + hint tooltip + `disabled` when Mortal is not ready | header | **SETUP SHEET**, settings section, hint inline | H4 |
| 15 | View label + select (stacked / top-down / rendered3d) + hint | header | **SETUP SHEET**, settings section (adding the 3D value is R14's) | H4 |
| 16 | `NextScenarioButton` (header variant) | header | **TOP BAR** — always visible; the post-answer result card and the verdict sheet also carry one (user request 2026-11-20) | H2 |
| 17 | Export button | header | **SETUP SHEET**, position section | H4 |
| 18 | Import button + hidden file input + "Importing…" | header | **SETUP SHEET**, position section | H4 |
| 19 | Description label + textarea + max length | header | **SETUP SHEET**, position section | H4 |
| 20 | `fileError` (`role="alert"`) | inline | **TOAST** (error tone); the sheet also shows it inline | H3/H4 |
| 21 | `fileNotice` + Dismiss (`role="status"`) | inline | **TOAST**, dismissible | H3 |
| 22 | `FullscreenButton` (built, unmounted) | — | **TOP BAR**, right cluster, only when the API exists | H2 |
| 23 | `HotseatCard` backdrop / dialog / title / hint | modal card | **SETUP SHEET** body — one sheet, so no second scrim | H4 |
| 24 | Hotseat round / disparity / seat rows (random + select + note) | card | **SETUP SHEET** | H4 |
| 25 | Hotseat draft summary (`aria-live`) | card | **SETUP SHEET** | H4 |
| 26 | Hotseat Cancel | card | **SETUP SHEET** (returns to the pool) | H4 |
| 27 | "Play the round" / "Playing…" | card | **SETUP SHEET**; closes, then deals | H4 |
| 28 | Hotseat generation progress (`statusMessage`) | inline status | **TOAST** | H3 |
| 29 | `TableInfo`: round, honba, tiles left, riichi sticks, dora tiles, river-marker legend | above the rows | **SETUP SHEET**, "Table info" | H4 |
| 30 | Agreement note (`role="status"`) | inline | **SETUP SHEET**, "Table info" | H4 |
| 31 | Scenario note | inline | **SETUP SHEET**, "Table info" | H4 |
| 32 | `PositionDescriptionCard` + Dismiss | inline | **TOAST** (first line + Details); full text in **SETUP SHEET**, "Table info" | H3/H4 |
| 33 | Pre-answer verdict status line (tone + text) | verdict panel | **DROPPED in 3D** (2026-11-21) — no pre-answer Mortal chip; the full line is in the post-answer **VERDICT SHEET** | H5 |
| 34 | Peek button | verdict panel | **VERDICT SHEET** (pre-answer) | H5 |
| 35 | Retry (pre-answer Mortal error) | verdict panel | **VERDICT SHEET** | H5 |
| 36 | Peeked-Mortal card | verdict panel | **VERDICT SHEET** | H5 |
| 37 | Book column: header, source citation, recommendation, expected tile, marks | verdict panel | **VERDICT SHEET**; one line on the **RESULT CARD** | H5 |
| 38 | `ScenarioExplanation`: summary, rules, quotes, citations, "not this hand", caveats | verdict panel | **VERDICT SHEET** | H5 |
| 39 | Mortal column: header, model, recommendation, probability, confidence | verdict panel | **VERDICT SHEET**; one line on the **RESULT CARD** | H5 |
| 40 | `CallReport` | verdict panel | **VERDICT SHEET** | H5 |
| 41 | Your-answer probability + "nearly tied" note | verdict panel | **VERDICT SHEET** | H5 |
| 42 | Full ranking (`<details>` + `ActionRanking`) | verdict panel | **VERDICT SHEET**, still a disclosure | H5 |
| 43 | Outcome band (chip + sentence) | verdict panel | **RESULT CARD** headline/detail + **VERDICT SHEET** band | H5 |
| 44 | `MortalUnavailable` + Retry (post-answer) | verdict panel | **VERDICT SHEET** | H5 |
| 45 | `#verdict-panel` anchor, `showVerdict` smooth scroll and `focus()` | App | **DROPPED** — Details opens the sheet; no page scroll exists in the stage | H5 |
| 46 | `AnswerSummary` (mark, headline, detail, book/Mortal chips, Details) | dock | **RESULT CARD** | H5 |
| 47 | `HandDock` section "Your hand" | dock | **SCENE** — the 3D overlay's group keeps that name; no duplicate group | 3D-08 |
| 48 | Hand + draw tile buttons (labels, order, disabled, answer marks, AI badges) | dock | **SCENE** — the projected buttons; the HUD renders none | 3D-08 |
| 49 | `hand` grid + `Tile` SVGs | dock | **SCENE** (canvas) | 3D-07/08 |
| 50 | Call bar (`CallControls`: Chi/Pon/Kan/Riichi/Pass, then its tile pick) | dock | **CALL ROW** — the same component, not a copy | H3 |
| 51 | Call pick prompt and Cancel (2026-11-20 click-then-pick flow) | dock | **CALL ROW** beside the call bar | H3 |
| 52 | Hint line (`.hand-dock-label`, `aria-live`) | dock | **DROPPED in 3D** (2026-11-21) — the call row's pick prompt is the only instruction | H3 |
| 53 | Dock `NextScenarioButton` | dock | **DROPPED** — the top bar, the post-answer result card and the verdict sheet carry Next; the dock's is not re-mounted | H3/H5 |
| 54 | `ActionBar` (the drill's remaining non-call actions, labels, probabilities) | below the table | **CALL ROW** | H3 |
| 55 | `DecisionPopup` (built, never mounted) | — | **DROPPED** — the call row is the only call surface; do not mount a second one | H3 |
| 56 | `statusMessage` (loading table/pack/agreement/Mortal/hotseat) | `role="status"` | **TOAST**, persistent while loading | H3 |
| 57 | `error` (`role="alert"`) | inline | **TOAST**, error tone, until the next deal | H3 |
| 58 | `threeNotice` + Dismiss (3D-11 degrade notice) | 2D shell | **2D ONLY** — it appears only after returning to a 2D view | — |
| 59 | Host notices (`.renderer-3d-*`: loading, unsupported, failed, degraded) | scene | **SCENE** rung, unchanged, below the HUD | 3D-02/11 |
| 60 | Debug legends (`?debug=`) and perf HUD (`?perf=1`) | scene | **SCENE** rung, debug-only, exempt from the collision gate (§7.6) | 3D-10/13 |
| 61 | Scene-loading line (`.status-msg` in the 3D mount) | scene | **TOAST** from H3; the host's first-mount line stays in the scene | 3D-02/H3 |
| 62 | 2D table (`PlayerRow`s / `PhysicalTable`) | main | **DROPPED in 3D** — the 3D board replaces it; the 2D views are untouched | — |
| 63 | Browser Back/Forward history entries | App | unchanged (no UI surface) | — |

---

## 4. The `HandDock` split

`HandDock` is one component that does two different jobs: it *is* the hand, and
it carries the hand's controls. In 3D those jobs go to different rungs, because
the hand is a projected scene overlay (3D-08) and the controls cannot be a
second strip of tiles.

| `HandDock` part | Destination | Why |
| --- | --- | --- |
| `section.hand-dock` "Your hand" group | **scene group** — the 3D-08 overlay keeps the same accessible name | the group must describe the real buttons, and there is only one set |
| `AnswerSummary` (mark, headline, detail, chips, Details) | **result card** (H5) | user decision: a compact result; it replaces both panel rows, never the hand |
| Call bar (Chi/Pon/Kan/Riichi/Pass) | **isolated call row** (H3) | a decision, not hand chrome; a press either completes the call or opens a tile pick with Cancel. It is bare buttons, not a panel. |
| Hint line (`handHint`, `aria-live`) | **dropped in 3D** (2026-11-21) | the user wants the call prompt only; the call row's own pick prompt and Cancel explain the step, and there is no Mortal chip |
| Hand + draw tile buttons | **scene** (3D-08) | the projected buttons; the HUD never renders a second hand |
| `hand` grid + tile images | **scene** (canvas) | drawn in 3D |
| Dock `NextScenarioButton` | **dropped** | the top bar, the post-answer result card and the verdict sheet each carry Next (user request 2026-11-20); the dock's is not re-mounted |
| Dock post-answer pair (`Reset` beside `Next`) | **result card** | `PostAnswerControls` is one shared component: the 2D dock renders it after an answer, the 3D card renders the same pair, so Reset and Next cannot drift or duplicate. Reset returns the same hand to unanswered (`resetAnswer`), with no re-deal |
| Hint row post-answer | **folded into the result card** | "Answer submitted" is redundant beside the result; the outcome is the message |

Consequences the units must honour:

- **Exactly one DOM control per hand tile plus the draw** (3D-08's overlay). A
  test asserts the count, and that mounting the call row adds none.
- The call row renders the shared call bar and any non-call drill action —
  **never** tile buttons, and no hint or Mortal chip.
- The 2D `HandDock` is unchanged. It is not split into new components for 3D;
  H3 extracts the controls into a bar that both shells use. The 2D rendering
  must be structurally unchanged either way.
- **This document supersedes the draft H3 task text** where it says the
  tile-less dock renders `AnswerSummary` and `NextScenarioButton`. Here the
  summary is the result panel (H5) and Next is the top bar's single control
  (H2). Two summaries or two Next buttons would be a duplicate control, not a
  convenience.

---

## 5. Layout by aspect

The 3D stage is the window (plan §2.1). The supported aspects are the gate's
own list, `CAMERA.supportedAspects`: **21:9, 16:9, 3:2, 4:3, 1:1, 3:4, 9:16**,
plus the two phone sizes the compass test already pins (390 × 844 and
320 × 568) as compatibility rows.

Pre-answer the composition has **no panel**. The call row is
`44 px` (`92 px` when it wraps to two rows), spans the hand band's own width
so its **right edge is the hand's right edge**, and sits **`8 px` above the hand
band** — or below it on the two phones, where the gap above the hand is too
small. Its controls are right-aligned, so more calls grow the row to the left.

After an answer the one panel is the result card:

| Panel row | Height | When |
| --- | --- | --- |
| result card | `104 px` (two `44 px` rows: outcome, then picks + Reset + Next) | after an answer |

It is `min(36rem, stageW − 16)` wide, centred on the stage, and sits `8 px`
above the hand band (or below it on the phones).

When a sheet opens, the call row and the result panel are hidden, so no visible
control is inert. The sheet's bottom is `8 px` above the hand band (or the
stage-height cap, whichever binds first).

**Projection note (2026-11-21, task 261120-2225).** The meld lines now sit
inside each hand's row (plan §2.4b), so the camera no longer pulls back when a
player declares a meld. The board solves closer (16:9: `52.73 → 50.26`), which
moves the hand band and everything anchored to it down the screen. **The numbers
under each stage are re-measured and authoritative; the schematic drawings show
the structure, not the exact rows.** The meld board itself was signed off on
2026-11-21 ("This looks good"); these anchored rects are the same composition
rules at the closer camera, and are the remaining live-view check on a real hand.

Every aspect below is drawn on the same rule set:

- top bar: full width, `78 px` at inset `0` — a `18 px` brand line, a `4 px` gap,
  a `44 px` control row and `6 px` padding above and below, with the top pad
  `max(6px, safeTop)`;
- compass: scene-owned, never touched;
- call row / result panel: as above;
- sheet (when open): centred, `min(78dvh, 52rem)` tall, bottom edge `8 px`
  above the hand band's top (or the stage-height cap).

Diagram legend: `-` top bar, `c` compass, `a` call row (pre-answer) or result
card (post-answer), `h` hand band, `s` open sheet. The landscape cells are about
`w/64 × h/18`; the portrait drawings use finer grids. The `8 px` gap between the
row/panel and the hand is under one cell at several sizes, so the boxes can touch
in a drawing while the numbers below them keep the gap.

**The diagrams are the reference hand**: the board fixture's default one meld
per seat (10 concealed + the draw). Since 261120-2225 the projected band is
fixed across meld states (§7.4): at 16:9 the compass and the band are identical
with none, one or four melds, and at 9:16 they move by at most `3 px`. The
anchored rects follow the band, which is why the gate runs every state rather
than one fixture.

### 21:9 — 2520 × 1080

```text
[top bar 78px]
                                                                        
                                                                        
                                                                        
                                                                        
                                                                        
                                                                        
                                cccccccc                                
                                cccccccc                                
                                cccccccc                                
                                cccccccc                                
                                cccccccc                                
                                                                        
                                                                        
                           aaaaaaaaaaaaaaaaaa                           
                           aaaaaaaaaaaaaaaaaa                           
                           hhhhhhhhhhhhhhhhhhhhh                        
                           hhhhhhhhhhhhhhhhhhhhh                        
                                                                        
```

compass `1120,403–1400,683` · hand band `818,961–1559,1058` (`741 px` wide) ·
call row `909–953` (`226 px` above the compass) · result panel `849–953` ·
sheet `86–918` (`832 px`). Nothing collapses.

### 16:9 — 1920 × 1080 (reference aspect)

```text
[top bar 78px]
                                                                
                                                                
                                                                
                                                                
                                                                
                           cccccccccc                           
                           cccccccccc                           
                           cccccccccc                           
                           cccccccccc                           
                           cccccccccc                           
                                                                
                                                                
                      aaaaaaaaaaaaaaaaaaaa                      
                      aaaaaaaaaaaaaaaaaaaa                      
                     hhhhhhhhhhhhhhhhhhhhhhhhh                  
                     hhhhhhhhhhhhhhhhhhhhhhhhh                  
                                                                
```

compass `820,392–1100,671` · hand band `508,958–1266,1058` (`759 px`) · call
row `906–950` (`235 px`) · result panel `846–950` · sheet `86–918` (`832 px`).

### 3:2 — 1440 × 960

```text
[top bar 78px]
--------------------------------------------------------
                                                        
                                                        
                                                        
                                                        
                       cccccccccc                       
                       cccccccccc                       
                       cccccccccc                       
                       cccccccccc                       
                       cccccccccc                       
                                                        
                                                        
                aaaaaaaaaaaaaaaaaaaaaaaa                
                aaaaaaaaaaaaaaaaaaaaaaaa                
                hhhhhhhhhhhhhhhhhhhhhhhhhhh             
                hhhhhhhhhhhhhhhhhhhhhhhhhhh             
                                                        
```

compass `596,341–844,588` · hand band `311,849–997,941` (`687 px`) · call row
`797–841` (`209 px`) · result panel `737–841` · sheet `86–835` (`749 px`).

### 4:3 — 1280 × 960

```text
[top bar 78px]
----------------------------------------------------
                                                    
                                                    
                                                    
                                                    
                     cccccccccc                     
                     cccccccccc                     
                     cccccccccc                     
                     cccccccccc                     
                     cccccccccc                     
                                                    
                                                    
              aaaaaaaaaaaaaaaaaaaaaaaa              
              aaaaaaaaaaaaaaaaaaaaaaaa              
               hhhhhhhhhhhhhhhhhhhhhhhhh            
               hhhhhhhhhhhhhhhhhhhhhhhhh            
                                                    
```

compass `529,361–751,584` · hand band `270,819–890,902` (`620 px`) · call row
`767–811` (`183 px`) · result panel `707–811` · sheet `86–811` (`725 px`).

### 1:1 — 1000 × 1000

```text
[top bar 78px]
--------------------------------------------
                                            
                                            
                                            
                                            
                                            
                                            
                  cccccccc                  
                  cccccccc                  
                  cccccccc                  
                  cccccccc                  
                                            
         aaaaaaaaaaaaaaaaaaaaaaaaaa         
         aaaaaaaaaaaaaaaaaaaaaaaaaa         
            hhhhhhhhhhhhhhhhhhhhhh          
            hhhhhhhhhhhhhhhhhhhhhh          
                                            
                                            
                                            
```

compass `413,407–587,581` · hand band `211,765–696,830` (`484 px`) · call row
`713–757` (`132 px`) · result panel `653–757` · sheet `86–757` (`671 px`).

### 3:4 — 900 × 1200

```text
[top bar 78px]
----------------------------------------
                                        
                                        
                                        
                                        
                                        
                                        
                                        
                                        
                cccccccc                
                cccccccc                
                cccccccc                
                cccccccc                
                                        
       aaaaaaaaaaaaaaaaaaaaaaaaaa       
       aaaaaaaaaaaaaaaaaaaaaaaaaa       
           hhhhhhhhhhhhhhhhhhhh         
           hhhhhhhhhhhhhhhhhhhh         
                                        
                                        
                                        
                                        
                                        
```

compass `358,500–542,683` · hand band `193,880–625,939` (`433 px`) · call row
`828–872` (`145 px`) · result panel `768–872` · sheet `86–872` (`786 px`).

### 9:16 — 810 × 1440

```text
[top bar 78px]
------------------------------------
                                    
                                    
                                    
                                    
                                    
                                    
                                    
                                    
                                    
                                    
                                    
              cccccccc              
              cccccccc              
              cccccccc              
              cccccccc              
                                    
     aaaaaaaaaaaaaaaaaaaaaaaaaa     
     aaaaaaaaaaaaaaaaaaaaaaaaaa     
          hhhhhhhhhhhhhhhhhh        
          hhhhhhhhhhhhhhhhhh        
                                    
                                    
                                    
                                    
                                    
                                    
                                    
                                    
                                    
```

compass `323,630–487,795` · hand band `174,972–565,1025` (`391 px`) · call row
`920–964` (`125 px`) · result panel `860–964` · sheet `86–918` (`832 px`; the
stage-height cap binds). A four-meld hand moves the band by under `4 px`
(`969–1022`), so the call row and both clearances barely move (`123 px` and
`63 px`).

### 9:16 with the sheet open

```text
[top bar 78px]
ssssssssssssssssssssssssssssssssssss
ssssssssssssssssssssssssssssssssssss
ssssssssssssssssssssssssssssssssssss
ssssssssssssssssssssssssssssssssssss
ssssssssssssssssssssssssssssssssssss
ssssssssssssssssssssssssssssssssssss
ssssssssssssssssssssssssssssssssssss
ssssssssssssssssssssssssssssssssssss
ssssssssssssssssssssssssssssssssssss
ssssssssssssssssssssssssssssssssssss
ssssssssssssssssssssssssssssssssssss
ssssssssssssssssssssssssssssssssssss
ssssssssssssssccccccccssssssssssssss
ssssssssssssssccccccccssssssssssssss
ssssssssssssssccccccccssssssssssssss
ssssssssssssssccccccccssssssssssssss
ssssssssssssssssssssssssssssssssssss
ssssssssssssssssssssssssssssssssssss
     aaaaaaaaaaaaaaaaaaaaaaaaaa     
          hhhhhhhhhhhhhhhhhh        
          hhhhhhhhhhhhhhhhhh        
                                    
                                    
                                    
                                    
                                    
                                    
                                    
                                    
```

The sheet is a **centred modal panel**, not a column: `left/right` gutter `8`,
top `86` (the `78 px` bar plus the `8 px` gutter), and its bottom edge is the
lower of `8 px` above the **hand band's** top and the stage-height cap. The scrim
spans the whole window at `45 %` (not the 2D modal's `68 %`) so the board behind
it is clearly dimmed. The sheet covers the compass and the upper board by
design; everything behind the scrim is `inert`, and the call row and result
panel are hidden while it is open. Its body scrolls internally; the page does
not scroll.

### Phone compatibility rows

| Stage | anchored row | reason |
| --- | --- | --- |
| 390 × 844 | call row **below** the hand when its gap above is too small | the gap above the hand is smaller than the row + `8 px` |
| 320 × 568 | call row **below** the hand | same, with the narrower band |

The fallback is one rule, not a second layout: when
`handBand.top − 8 − rowHeight < compassBox.bottom + 8`, the row docks **below**
the hand band at `handBand.bottom + 8`. The result card uses the same anchor.
The collision gate checks whichever anchor was chosen.

### What collapses, and when

| Band | Call row pre-answer | Top bar | Toast |
| --- | --- | --- | --- |
| wide (≥ 3:2) | one row; labels, probabilities | Next labelled, setup labelled, full screen | 2 lines, `32rem` |
| square (4:3 – 1:1) | one row; probability badges hidden (they live in the verdict sheet) | Next labelled, icons | 2 lines |
| portrait (< 1) | up to two rows; labels only; below the hand on phones | Next labelled, setup icon-only | full width minus gutters |
| 21:9 | as wide; right-aligned to the hand | unchanged | unchanged |

Collapse never removes a control, only its decoration: probabilities,
wordmark and the setup label are the only things that disappear. A control that
would lose its accessible name keeps a visually-hidden one.

### Sheet geometry, stated once

```
sheetTop    = topBar.height + 8
sheetBottom = min(handBand.top − 8, sheetTop + min(0.78 · stageH, 832))
sheetWidth  = min(832, stageW − 16)
```

The pre-answer call row is `handBand.{left,right}` at
`handBand.top − 8 − rowHeight` (`rowHeight` is `44` or `92`); when that would
reach the compass it docks at `handBand.bottom + 8`. The result panel uses the
same anchor with `104 px`.

At 21:9 this is `86 → 918` (`832 px`); 16:9 `86 → 918` (`832 px`); 3:2
`86 → 835` (`749 px`, the stage-height fraction binds); 4:3 `86 → 811`
(`725 px`, the hand binds); 1:1 `86 → 757` (`671 px`, the hand binds); 3:4
`86 → 872` (`786 px`, the hand binds); 9:16 `86 → 918` (`832 px`, the
stage-height cap binds); 390 × 844 `86 → 536` (`450 px`); 320 × 568
`86 → 376` (`290 px`). The hand band, the hand and the felt under it all stay
below the sheet at every size.

---

## 6. Overlay contract

### 6.1 Z-index ladder

```
canvas  <  scene overlay  <  HUD  <  sheet  <  toast
```

| Rung | Token | Value | Contents | Owner |
| --- | --- | --- | --- | --- |
| Canvas | `--hud-z-canvas` | `0` | the fixed `.table-3d` stage and the canvas | 3D-02 |
| Scene overlay | `--hud-z-scene` | `10` | hand buttons (3D-08), compass (3D-09), host notices, debug/perf panels | 3D-08/09/10/13 |
| HUD | `--hud-z-hud` | `20` | layer root, top bar, call row and result panel | H2–H5 |
| Sheet scrim | `--hud-z-sheet-scrim` | `30` | the scrim, the whole window at `45 %` | H2 |
| Sheet | `--hud-z-sheet` | `40` | the sheet panel | H2 |
| Toast | `--hud-z-toast` | `50` | the toast stack | H3 |

Rules:

- The values live in one token block (`hud/tokens.css`, H2). No HUD rule may
  write a bare `z-index`; a test greps the HUD stylesheet for numbers.
- The scene overlay keeps its internal `1/2/3` values inside its own stacking
  context; the rung is what it sits at relative to the HUD.
- The 2D shell's values (`header 40`, `hand dock 30`, `hotseat backdrop 80`) are
  **not** part of this ladder: no 2D chrome is mounted in 3D. H4 must not nest
  `.hotseat-backdrop` inside the sheet — the sheet provides the only scrim.
- Debug panels stay on the scene rung on purpose: product chrome outranks
  diagnostics, and a debug HUD is exempt from the collision gate.

### 6.2 Pointer events

- `.hud-root`: `pointer-events: none`. The felt, the canvas and the projected
  hand buttons stay reachable through it.
- Every panel and control: `pointer-events: auto`. A panel's surface swallows a
  tap inside its own rect; it never extends its hit area beyond its border.
- The scrim is `auto` across the whole window (a tap outside the panel
  closes); the sheet panel is `auto` and owns its own focus.
- Toasts are `none` at the root; a toast with a Dismiss/Details affordance is
  `auto` on its box only.
- No rule may set `pointer-events: auto` on a full-window HUD node. That is the
  single mistake that would make the board inert, and the H2 structural test
  asserts the root's computed value is `none`.

### 6.3 Safe areas and viewport units

- The stage is `position: fixed; inset: 0` and `height: 100dvh` (with `100vh`
  as the fallback, as the shell already does).
- Insets are **inputs to the layout**, not CSS padding on a full-window node:
  `hudLayout()` takes `{ top, right, bottom, left }` and the HUD reads them
  from `env(safe-area-inset-*)` once per resize. Tests pass `0`.
- The panel gutter is `8 px`; a safe inset enters the layout as
  `max(6px, env(safe-area-inset-*))`, so a device with no notch is unchanged
  (the panel's `8 px` gap to the hand is a layout gap, not an inset).
- The hand is the lowest scene element, and in landscape it ends `40–76 px`
  above the stage bottom (reference hand, 21:9, `1080 − 1010 = 70 px`), which
  clears a `34 px` home indicator without any HUD involvement. The call row and
  the result panel are above the hand, so no HUD rect competes for the bottom
  inset.
- `dvh` changes when mobile browser chrome shows/hides. The HUD recomputes on
  `resize` (and `orientationchange`, and `fullscreenchange`) through one
  `ResizeObserver` on the stage; the renderer already re-fits on resize, so the
  two stay in step.
- Full screen: the Fullscreen API element is the **shell**, not the canvas, so
  the HUD travels with the scene. Entering or leaving full screen changes the
  safe insets; recompute, do not cache.

### 6.4 Reduced motion

- `prefers-reduced-motion: reduce` is read once through the existing
  `usePrefersReducedMotion` (3D-08) and passed into the HUD.
- Sheets, toasts and the result card appear with **no** transform, scale or
  slide: either instantly or a plain opacity change of at most `120 ms`.
- No HUD element animates continuously. The only 3D motion the HUD can cause is
  the 3D-08 hover lift, which still applies under reduced motion because it is a
  discrete pose change; reduced motion suppresses only the time-based deal-in.
- Nothing auto-scrolls in 3D, so there is no smooth-scroll special case to
  honour (the 2D `showVerdict` scroll is 2D-only).

### 6.5 Focus, Escape, inert

1. A sheet is `role="dialog"`, `aria-modal="true"`, labelled by its visible
   heading ("Setup" / "Verdict").
2. Opening focuses the sheet's **heading** (`tabIndex={-1}`): it announces the
   dialog and cannot accidentally activate a control.
3. Tab and Shift+Tab cycle inside the sheet only. Focus never reaches the HUD
   or the scene behind the scrim.
4. Escape closes the topmost layer only. A nested popover consumes the first
   Escape (the `ScenarioPicker` panel and `HotseatCard` already do this with
   their own handler and `stopPropagation`); the next Escape closes the sheet.
5. Closing by Escape, scrim tap or a close button returns focus to the element
   that opened the sheet. If that element no longer exists (the result card
   vanished because a new hand dealt), focus goes to the top bar's Next hand.
6. While a sheet is open, the HUD root and the stage are `inert`, and the
   scrim spans the whole window at `45 %`. The pre-answer call row and the
   result panel are hidden, so no visible control is dead. The scrim is not
   focusable and contains no text.
7. The page does not scroll. The sheet body is the only scroll container
   (`overflow: auto; overscroll-behavior: contain`).
8. At most one sheet exists at a time. `sheetRoot` mounts one panel.
9. Answering never moves focus and never opens anything. The result card is
   announced by its live region; its Details button is the only way in.
10. Toasts never take focus. Errors are `role="alert"`; status lines are
    `role="status"`. A message is announced once, not per render.

---

## 7. The collision contract

### 7.1 What the HUD may never cover

The **exclusion set** `E` for the current state and viewport is:

```
E = union(handBand, compassBox)
```

- `handBand` — the human's concealed + draw tile projection as one rectangle.
  It is the *interaction* union (the same rects 3D-08 publishes, including the
  44 px minimum target), computed **even when the hand is locked**, so the
  result card has an anchor after answering. This is one small addition to the
  renderer contract (H2): `TableRenderer.handBandRect(): BandRect | null`,
  computed by the same code path as `hitRects()` without the lock gate.
  `hitRects()` itself stays exactly as 3D-08 landed it and remains the
  interaction contract.
- `compassBox` — the DOM compass square from 3D-09 (`compassBox(compassRect())`),
  which is already inset inside the projected compass plate.

The compass is in the exclusion set because it is the table's readout: covering
it hides the round, scores and tiles left. The hand/draw buttons are in it
because covering them would take away the only way to answer.

The screen regions the HUD reserves, and the only things allowed to cross them:

| Reserved region | Rect (from §5/§7.3) | May cross it |
| --- | --- | --- |
| Top bar | full width, `78 px` at inset `0` | nothing (it is the top edge) |
| Call row (pre-answer) | the hand band's width, right-aligned to its right edge; `44` px (`92` when wrapped); `8 px` above the hand (below it on phones) | the open sheet's scrim |
| Result panel (post-answer) | `min(36rem, stageW − 16)` wide, centred; `104` px; `8 px` above the hand (below it on phones) | the open sheet's scrim and panel, debug panels |
| Toast stack | `32rem` centred, under the top bar | nothing |
| Sheet (open) | §5's formula | nothing (it is the top layer) |

When the call row would be empty it is **unmounted**, not reserved: a plain
discard lesson with no Riichi, Kan or call shows nothing over the board until
the answer, then the result panel. The HUD reserves no canvas pixels and
changes no camera framing.

### 7.2 The rule

A rect `R` is legal iff, for every `e ∈ E`:

```
R does not intersect expand(e, 8)
```

`8 px` is the HUD gutter. A panel may sit exactly `8 px` from the hand's top
edge and still block a hover lift visually — that is expected: the HUD is above
the scene, and the lift is a 14 mm mesh move behind the panel.

### 7.3 Anchors

`hudLayout(stage, anchors, state)` is a **pure** function in
`frontend/src/renderers/hud/hudLayout.ts` (H2). It takes the stage size, the
two anchor rects, the safe insets and a tiny state
(`{ slot: 'none' | 'actions' | 'result', sheet: boolean, toasts: number }`)
and returns every HUD rect. No DOM reads, no renderer calls; it is unit-tested
in Node against the real projection.

- Top bar: `0,0 → stageW, 18 + 4 + 44 + 6 + max(6px, safeTop)` — the brand line,
  the gap, the control row and the padding.
- Hand panel, primary anchor:
  `width = min(36rem, stageW − 16)`, `left = (stageW − width) / 2`,
  `height = 84` (actions, one row) / `128` (two rows) / `40` (hint only, and
  whenever a sheet is open) / `104` (result card),
  `top = handBand.top − 8 − height`.
- Call row / result panel, fallback anchor (when
  `handBand.top − 8 − height < compassBox.bottom + 8`):
  `top = handBand.bottom + 8`, full width minus the gutters.
- Toast stack: `top = topBar.bottom + 8`, `width = min(32rem, stageW − 16)`,
  centred.
- Sheet: §5's formula, on the hand band's top (or the stage-height cap).

If **no anchor exists** (the scene has not published a projection yet), the top
bar and the toast root still mount — they do not depend on the board — and the
call row and result panel are **not mounted**. The HUD never guesses a hand
position, so nothing jumps on first paint.

Width does not affect the collision rule: the panel is above or below the band,
never beside it, so its width can be a constant without becoming illegal.

### 7.4 The measured reference

Clearance from the compass's bottom edge to the nearest at-rest HUD rect for
the reference hand, at the gate aspects:

| Aspect | compass bottom | call row top | clearance | result card |
| --- | --- | --- | --- | --- |
| 21:9 | 683 | 909 | 226 px | 166 px |
| 16:9 | 671 | 906 | 235 px | 175 px |
| 3:2 | 588 | 797 | 209 px | 149 px |
| 4:3 | 584 | 767 | 183 px | 123 px |
| 1:1 | 581 | 713 | 132 px | 72 px |
| 3:4 | 683 | 828 | 145 px | 85 px |
| 9:16 | 795 | 920 | 125 px | 65 px |
| 390 × 844 | 484 | 577 (below) | 90 px, belt and braces | — |
| 320 × 568 | 347 | 413 (below) | 63 px | — |

The band is **not at a fixed screen position** across aspects, and neither is
the compass: the camera fits the board, so the aspect changes the projection.
What changed on 2026-11-21 (task 261120-2225) is that the **meld state no longer
moves it**: the meld lines sit inside each hand's row, so at 16:9 the compass's
bottom edge (`671 px`) and the hand band's top (`958 px`) are identical with no
melds, one meld per seat, or four melds per seat including a kan; at 9:16 the
band moves by at most `3 px`. The anchor is still the live projection, and the
gate still runs every hand state rather than one fixture.

At 9:16, the tightest gate aspect, the call row's clearance by hand state is:

| Human hand | buttons | call row clearance | result-card clearance |
| --- | --- | --- | --- |
| 13 + draw (no melds) | 14 | 124 px | 64 px |
| 10 + draw (one meld) | 11 | 125 px | 65 px |
| 7 + draw (two melds) | 8 | 125 px | 65 px |
| 4 + draw (three melds) | 5 | 125 px | 65 px |
| 1 + draw (four melds) | 2 | 124 px | 64 px |
| 1 + draw (four melds, one a kan) | 2 | 123 px | 63 px |

Across all seven gate aspects and all six states, the worst call-row clearance is
`123 px` and the worst result-card clearance is `63 px`, both at 9:16 with a
four-meld kan hand. Both are legal against the `8 px` rule, and they are the
numbers the gate must beat. They are also why the result card has a **fixed
shape**: a headline, one clamped detail line and the chips, capped at `104 px`
— a card that grew with its text would break the contract at 9:16.

A **wrapped** call row (`92 px`) at 9:16 with a four-meld hand can still fit
above the hand; when it cannot, the fallback moves the row below the hand, where
there is room. That is the fallback doing its job, not an exception: the gate
asserts whichever anchor is chosen. The collision test also pins the fallback
with a synthetic low compass so the rule cannot rot.

The top bar ends at `78 px`; the compass's top edge is never above `323 px` in
any measured state and aspect now that the camera is closer, so the bar cannot
reach it. Every gate aspect keeps the call row's and card's bottom edges
`≥ 8 px` above the hand band, and both are inside the stage in every state.

### 7.5 Who enforces it

- **H2** lands `hudLayout.ts` with the rect set and its test: the seven aspects
  × six hand states (no melds, one, two, three, four, and four including a kan),
  each unanswered and answered/locked, with the real `hitRects()` and
  `compassPlateRect()` output. A violation prints the rect pair, the aspect and
  the clearance, and fails.
- **H3** adds the call row's real content height (wrapping up to two rows) to
  the state and re-runs the same matrix, including the below-the-hand fallback.
- **H4** adds the top bar's setup trigger and asserts the open sheet's bottom
  edge; **H5** adds the result card (2 lines + chips, the tallest form) and
  asserts the closed state.
- **R15 (3D-15)** runs the whole matrix on the stress fixture: all zones full,
  four riichi, a kan, three-row rivers, answered and unanswered, plus the
  handoff screenshots. A HUD rect that intersects is a failure there too.
- Command: `cd frontend && npx vitest run src/renderers/hud` (H2 onwards).
  No GPU, no browser.

### 7.6 Exemptions, stated so they are not smuggled in

- The **open sheet and its scrim** may cover the hand, the compass and the
  board. They are excluded from `E`; the sheet is still bound by the
  collapsed-panel rule, and by its height cap.
- **Debug and perf panels** (`?debug=`, `?perf=1`) may cover anything: they are
  diagnostics, mounted only by a query flag, and deliberately on a lower rung.
- The 3D-08 **hover lift** crosses the panel's `8 px` gap visually. It is a
  mesh move, not a rect, and it does not change any hit target.
- The scene's **own** notices (`renderer-3d-notice`, hero/carve panels) are not
  HUD chrome; they keep their positions and their tests.

---

## 8. Visual tokens

The HUD is a dark glass surface over a lit green felt. Legibility is a number,
not an opinion: the table below is the sRGB composite over the felt's base
(`#1a5038`) and its lit highlight (`#2f7a55`), with the WCAG 2.1 contrast
formula. `#12141a` and `rgba(9, 14, 19, α)` are the palette `App.css` already
uses; the tone colours are `AnswerSummary`'s.

| Token | Value | Use |
| --- | --- | --- |
| `--hud-surface` | `rgba(9, 14, 19, 0.88)` | panels over the felt (alpha floor **0.84**) |
| `--hud-surface-solid` | `#12141a` | long text, sheet body, lists |
| `--hud-sheet-surface` | `#141b25` | sheet panel (the `.hotseat-card` colour) |
| `--hud-border` | `1px solid #2a3442` | every panel |
| `--hud-border-accent` | `#34506e` | interactive controls |
| `--hud-radius` | `10px` panel, `8px` control, `999px` chip | shape |
| `--hud-shadow` | `0 8px 24px rgba(0, 0, 0, 0.45)` | sheet and result card only |
| `--hud-scrim` | `rgba(5, 8, 13, 0.45)` | the sheet's scrim (`45 %`, not the 2D modal's `68 %`) |
| `--hud-backdrop` | `blur(8px) saturate(1.1)` | enhancement only; never required |
| `--hud-text` | `#e7ecf3` | primary |
| `--hud-text-muted` | `#8b94a7` | secondary, unit labels |
| `--hud-accent` | `#a5d8ff` | links, the Next hand label, focus text |
| `--hud-focus` | `2px solid #74c0fc`, offset `2px` | focus ring, as `App.css` |
| `--hud-ok` / `--hud-warn` / `--hud-bad` | `#8ce99a` / `#ffd43b` / `#ff8a8a` | tone marks |
| tone surfaces | `#122018` / `#1f1a12` / `#241717` (opaque) | result card by outcome |
| `--hud-text-xs` | `0.72rem / 1.3` | chips, probabilities |
| `--hud-text-sm` | `0.78rem / 1.35` | controls, captions |
| `--hud-text-md` | `0.86rem / 1.3` | result headline |
| `--hud-space` | `8px` | gutter, padding unit |
| `--hud-tap` | `44px` | minimum control height |

Measured contrast (primary / muted / accent):

- translucent surface at `α 0.88` over the lit felt (`#2f7a55`): `14.8:1` /
  `5.8:1` / `11.6:1`; over the bright felt (`#409668`): `14.4:1` / `5.6:1` /
  `11.3:1`;
- the solid sheet surface `#12141a`: `15.5:1` / `6.0:1` / `12.2:1`;
- the three tone surfaces: `14.2:1`, `14.6:1`, `14.6:1` for primary text;
- the call row's buttons over the felt: each carries its own opaque surface, so
  the numbers above hold there too.

Rules:

1. **No text on the felt.** Every panel paints a surface; the alpha floor is
   `0.84`, which is what keeps the muted text at AA (`≥ 4.5:1`) even on the
   felt's brightest point. The top bar's brand line is the one exception: it is
   a name, not content, and it carries a `1 px` dark text shadow
   (`0 1px 3px rgba(5, 8, 13, 0.75)`) instead of a plate (user request
   2026-11-20; see §9, H4).
2. `backdrop-filter` is additive. If a browser ignores it, the same alpha
   carries the text; the HUD must never rely on blur for contrast or layout.
3. Text scale is fixed (`rem`), not `vw`: a HUD that shrinks its type on a
   narrow stage becomes unreadable. Controls keep `44 px` height; only their
   decoration collapses (§5).
4. Numerals in probabilities and scores are `tabular-nums` so they do not jitter.
5. Each tone is a border/mark accent on the standard surface, except the result
   card, which uses the existing opaque tone surfaces — they are already
   readable and already the learner's visual language.

---

## 9. Seams for H2 – H5

All HUD code lives under `frontend/src/renderers/hud/` (the 3D chain's
directory). `App.tsx` is touched only at the 3D mount seam.

| Unit | Files (new unless noted) | App seam |
| --- | --- | --- |
| **H1** | `3d_hud.md`, plan §11 and pointers | none |
| **H2** | `hud/{HudLayer.tsx,Hud.css,tokens.css,hudLayout.ts,Sheet.tsx,toast root}`, `hud/*.test.*`; `renderers/contract.ts` + `three/hitTest.ts` + `three/Scene.ts` + `RendererHost.tsx` (arm `handBandRect`), `RendererHost.css` (scene rung unchanged) | mounts `<HudLayer>` before `<main className="table-3d">` for the 3D mount only |
| **H3** | `hud/{ActionRail.tsx,HandRail.tsx,toast.tsx}`, `components/HandDock.tsx` (opt-out prop or extracted rail), `hudLayout.ts` (rail heights) | passes the existing store handlers through |
| **H4** | `hud/{SetupSheet.tsx,...}`, reuses `ScenarioPicker`, `HotseatCard` (body only), `ExportImportControls`, `TableInfo`, notes | the setup trigger and sheet wiring |
| **H5** | `hud/{ResultCard.tsx,VerdictSheet.tsx}`, reuses `VerdictPanel`/`AnswerSummary` | Details → sheet; Next hand unchanged |

Order and gates:

- H2 depends on H1 and on R14's view-switch mount (it mounts into the 3D
  branch). H3 depends on H2. H4 depends on H2. H5 depends on H2 and H3.
- R15 (3D-15) runs last and verifies the whole composition; its report gains
  the HUD matrix and the user's verdict on the composition diagrams.
- Each unit keeps the frontend gate green and extends the collision test; none
  touches Rust, `GameState`, the 2D layouts or the retired 2.5D pipeline.

The scene-side contract addition H2 needs, stated exactly:

```ts
/** A lock-independent projection rect, in CSS px, relative to the stage. */
export interface BandRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface TableRenderer {
  /** Hand + draw interaction targets; empty when locked (3D-08, unchanged). */
  hitRects(): readonly HitRect[];
  /** Hand + draw union with the same 44 px expansion, computed when locked too. */
  handBandRect(): BandRect | null;
  /** The compass plate's projected box (3D-09, unchanged). */
  compassRect(): CompassRect | null;
}
```

`handBandRect()` must come from the same `frameForAspect` + `hitRects` code
path as the interaction rects (a drift test asserts the union equality while
unanswered), so the anchor cannot diverge from the buttons it describes.

### As built (3D-H2, 2026-11-19)

H2 landed the shell exactly as specified above. The facts H3–H5 build on:

- **Files.** `renderers/hud/{HudLayer.tsx, Hud.css, tokens.css, hudLayout.ts,
  Sheet.tsx, hudAnchors.ts, domMetrics.ts}` plus their tests, and the contract
  addition `BandRect` + `TableRenderer.handBandRect()` in `renderers/contract.ts`,
  `three/hitTest.ts`, `three/Scene.ts`. `App.tsx` changed only at the 3D mount
  seam: it renders `<HudLayer>` as the fixed sibling of `<main className="table-3d">`
  and passes the shell/stage refs, the next-hand handler and its disabled flag.
- **The anchor seam.** `RendererHost` publishes `{ handBand, compass }` into
  `hud/hudAnchors.ts` on every re-projection (resize, new snapshot, board ready)
  and clears them on unmount or degrade; `HudLayer` subscribes with
  `useSyncExternalStore`. The renderer never reaches into the HUD and the HUD
  never calls the renderer, so `hudLayout()` stays pure.
- **Safe areas.** `.hud-inset-probe` is the only element that reads
  `env(safe-area-inset-*)`; `domMetrics.readSafeAreaInsets()` reads its computed
  padding once per resize pass and the numbers enter `hudLayout()`. The top bar's
  inline padding is `max(6px, inset)` on each side and `max(6px, safeTop)` above.
- **Slots.** `HudLayer` takes `callBar`, `resultCard`, `toasts` + `toastCount`,
  and `sheet` + `onCloseSheet`. The call row mounts only when it has content and
  is hidden behind a sheet; the panel exists only for the post-answer result card
  (`104 px`). H3 fills the call row and the toast root, H5 the result card,
  H4/H5 the sheet body.
- **Nested layers.** A native document-level Escape listener cannot be stopped
  by a descendant's `stopPropagation` (both run on `document`), so the sheet
  consumes the first Escape when its body contains
  `[data-hud-popover="open"]` (exported as `NESTED_LAYER_ATTRIBUTE`). H4 sets
  that attribute on its open scenario picker; its hotseat form is a block of
  the sheet, not a nested layer, so it needs no marker.
- **Retired.** The `?preview=deal` review aid (3D-12) is gone: the top bar's
  Next Scenario control is the real one, so the deal-in is one tap away. The
  `preview` query value is `sticks | null` only.

### As built (3D-H3, 2026-11-20; revised 2026-11-21)

The playing state is the isolated call row; the one panel is the post-answer
result card. This is what the next units build on.

- **Files.** `renderers/hud/{ActionRail.tsx, actionRail.ts, ToastStack.tsx,
  toastModel.ts}` plus `hudLayout.ts`'s row state and the shared
  `components/CallControls.tsx` (which replaced the Riichi/Kan `CallToggles` in
  the 2026-11-20 click-then-pick flow). `HandRail.tsx`/`handRail.ts` existed for
  the pre-answer hint and Mortal chip and were deleted with that panel on
  2026-11-21. `components/HandDock.tsx` renders the same `CallControls` and the
  same `handHint()`, so the two shells cannot drift. `App.tsx` changed only at
  the 3D mount seam.
- **One hand.** The call row and the result panel render no tile control at all — in 3D
  the only hand buttons are 3D-08's projected ones. `PracticeHud.test.tsx`
  composes the real overlay with the real HUD and asserts exactly one button per
  concealed tile plus the draw, that the row adds none, and that Tab reaches the
  rail's controls before the hand's buttons. It also proves the call path: the
  rail's call buttons call the store's `beginCall`, a projected tile click calls
  the store's `selectTile`, and the answer arrives as `riichi`/`kan`/`call` with
  no renderer in between. A one-option call (the lone quad in the fixture) is
  submitted by the press alone; Escape cancels a pick and returns focus.
- **Call placement (2026-11-20).** The call bar is the rail's right-aligned
  group: its right edge stays above the right side of the hand and each added
  control grows the row towards the left. `.call-controls` owns that
  `justify-content: flex-end`, and `CallControls.test.tsx` pins it in CSS text
  (AGENTS.md §6: no visual judgement by the agent).
- **Hover preview and pick highlighting (2026-11-21).** Hovering or focusing a
  call button raises the hand tiles its press would use (the union across every
  legal option; for Riichi, the engine's legal discards). Leaving the button, or
  opening the pick, lowers them. While the pick is open every hand tile outside
  the legal set is darkened and inert; picked tiles stay raised. A Chi pick
  toggles: clicking a raised tile lowers it, and clicking a tile that cannot
  join the raised one replaces it, so only the clicked tile stays up. The 3D
  scene lifts the real mesh
  (`TableRenderer.setLiftedTiles`, a set, not one hover) and the overlay paints
  a dim layer; the 2D dock lifts the tile buttons and filters the rest.
- **Review aid: `?preview=calls`.** The crafted cases in
  `frontend/src/callDemo.ts` are dealt instead of a generated hand, and Next
  hand walks them: `pon-single`, `pon-red`, `chi-single`, `chi-multi`,
  `kan-single`, `riichi-one`, `riichi-many`, `drill-chi`. Add
  `&case=chi-multi` to start at one; both 2D and 3D views work. The states are
  complete payloads, so they go through the same store, overlay and grading path
  as a dealt hand.
- **The call row is layout.** `hudLayout()` returns `callBar` (one or two 44 px
  rows, from `actionRows`) beside the post-answer `panel`; `hudAtRestRects()`
  lists it as `call bar`, so the collision matrix checks it against the hand and
  the compass. `Panel` exists only for `slot: 'result'`. `HudLayer` treats a
  null `callBar`/`resultCard` as absent.
- **No pre-answer popup (user change 2026-11-21).** The 3D HUD shows the call
  row only: no panel, no hint line, no Mortal chip. The `HandRail` component and
  its `mortalChip` data were deleted; the verdict sheet is entered post-answer
  through the result card's Details. `HudLayer`'s props are now `callBar` and
  `resultCard` (plus the sheet, toasts and top bar).
- **The rail measures its wrap.** The action row's real height depends on the
  stage width, so `ActionRail` observes its own content box and reports `1` or
  `2` rows (`actionRail.railRowsForHeight`); `App` passes that as `actionRows`,
  and `hudLayout()` turns it into the 84/128 px panel. No second layout path.
- **Messages are toasts.** `toastModel.buildHudToasts()` is the priority list
  (error, file error, imported description, file notice, loading status), capped
  at three, and `ToastStack` renders each as `role="alert"`/`role="status"` with
  a Dismiss control only where one was asked for. The 3D stage now holds the
  scene and nothing in flow: App's `statusMessage` and `error` no longer render
  as `.status-msg`/`.error-msg` siblings of the canvas.
- **Departs from the draft task text, per §4.** The pre-answer surface is the
  isolated call row only (user change 2026-11-21): no hint line and no Mortal
  chip. `AnswerSummary` is H5's result panel and Next is the top bar's single
  control, so a second summary or Next button would be a duplicate control.
- **Collision result.** The matrix runs the seven gate aspects and two phone
  rows × six hand states × answered/unanswered × `none`/`actions ×1`/
  `actions ×2`/`result`, on the real projection, with 2 toasts at rest. Every
  row is at least `8 px` clear of the hand band and the compass, and the
  below-the-hand fallback is pinned separately.
- **Not done here.** The verdict sheet and result card (H5) and the setup sheet
  (H4). The rail's chip has no action until H5; nothing else in the rail is
  inert.
- **User verdict (2026-11-20):** accepted — "looks fine" on the running dev
  server, with the pre-answer controls and the toasts as composed here (the
  controls later became the isolated call row, 2026-11-21).
- **Follow-up landed with the sign-off (2026-11-20, user request):** the snapshot
  now carries every hand in **display order** (manzu, pinzu, souzu, then honors,
  by rank) instead of the engine's order, so the painted hand on the 3D canvas
  and the projected buttons describe the same hand. Red fives are still allocated
  in the engine's hand order and then the draw, and the flag travels with its
  copy through the sort; the dock's `sortHandForDisplay` already did both for the
  2D views. `renderers/snapshot.ts` + `contract.ts`'s `SnapshotSeat.concealed`
  document it, and `snapshot.test.ts` pins the sort, the slot reassignment and
  the red five staying on its copy. Nothing else in the HUD or the 2D layouts
  changed.

### As built (3D-H5, 2026-11-20)

The result and its full verdict are in. This is what remains for 3D-15/16.

- **Files.** `renderers/hud/{ResultCard.tsx, VerdictSheet.tsx}`, plus the
  shared wording module `src/verdictText.ts` (the 2D `AnswerSummary` and
  `VerdictPanel` now call the same functions, so the card cannot drift).
  `AnswerSummary` gained a `live` prop (default `true`; the 3D card passes
  `false`), `HandRail`'s Mortal chip became the pre-answer sheet trigger, and
  `HudLayer` gained one persistent `role="status"` announcer. `App.tsx` gained
  `verdictOpen` and the slot wiring at the 3D mount seam.
- **The card.** It is the 2D answer summary (mark, headline, detail,
  Book/Mortal chips, Details) inside one fixed 104 px tone surface, plus one
  clamped line: `Book: <pick> · Mortal: <pick>`. The tone background and its
  green/amber/red outline are the **panel's** — the whole card's edge — so the
  panel's own padding keeps the buttons clear of the outline (user request
  2026-11-20). It replaces both panel rows and
  never expands on its own; Details is the only way into the sheet. The card's
  two rows are both `44 px` — the outcome row, then the picks line with the
  card's own post-answer pair on its right: **Reset** beside **Next Scenario**
  (task 261120-2319; both come from the shared `PostAnswerControls`, as in the
  2D dock), so dealing again or retrying the same hand does not require the top
  bar. Reset calls the store's `resetAnswer`: the same `GameState` returns to
  unanswered (answer, verdict, peek, evaluation and armed calls cleared, no
  re-deal), and the card unmounts as the hand's pre-answer rail returns.
- **Next is on the sheet too.** The sheet header carries the same Next control
  beside Close (always visible, no scrolling the body); it closes the sheet and
  deals. The top bar's Next remains, and the 2D dock has the same Reset + Next
  pair the card does. Reset is not duplicated into the sheet: the card is its one
  home, and closing the sheet returns to it.
- **The sheet.** `VerdictSheet` is the 2D `VerdictPanel` unchanged: grade
  columns, `ActionRanking`, `CallReport`, `ScenarioExplanation`, the outcome
  band, the peek card and Retry. The sheet is entered post-answer from the
  result card's Details. Opening or closing it
  changes no `GameState` and re-runs neither the deal nor the grade; a new hand
  closes it; the sheet holds the full-size Peek and Retry controls.
- **Announcement and focus.** `HudLayer`'s announcer is mounted for the life of
  the HUD and only its text changes, so one answer is announced once even
  though the card unmounts while the sheet is open. When the control that had focus went away with the
  answer (a projected tile or a rail action), the card focuses its Details
  button; otherwise focus is left alone. The card's only motion is a plain
  `120 ms` opacity fade, suppressed by reduced motion.
- **Layout.** `hudLayout()` now returns the result card's content box and its
  Details trigger (`hudPanelRows`), and `hudAtRestRects()` lists them as
  `result card` and `sheet trigger`. The collision matrix runs the seven gate
  aspects and two phone rows × six hand states × answered/unanswered ×
  `none`/`hint`/`actions ×1`/`actions ×2`/`result`, including the individual
  projected targets; every row is at least `8 px` clear, and the worst
  result-card clearance is the `63 px` published in §7.4.
- **Not done here.** The setup sheet (H4). 3D-15 runs the stress-fixture matrix
  and the handoff screenshots, and 3D-16 records the chain.
- **Composition handoff (AGENTS.md §6): pending the user's verdict.** Run the
  dev server (`cd frontend && npm run dev`) and open
  `http://localhost:5173/?renderer=3d`, answer a hand, and look at the card and
  the Verdict sheet on the board. The numbers above are the scripted checks;
  the look is the user's call.

### As built (3D-H4, 2026-11-20)

Everything that is not the live hand now lives in one setup sheet behind one
trigger. This is what remains for 3D-15/16 and what the chain may build on.

- **Files.** `renderers/hud/{SetupSheet.tsx, SetupSheet.test.tsx}`, plus
  `hudLayout.ts` (the trigger's rect and its name in the at-rest set),
  `HudLayer.tsx` (`setupTrigger`), the shared extractions
  `components/{AgreementToggle,ViewPicker}.tsx` (both shells render them, so the
  label and the disabled state cannot drift), `components/HotseatCard.tsx`
  (`HotseatCardBody` + the 2D modal host), `components/ScenarioPicker.tsx`
  (`nestedLayerAttribute`), `hud/toastModel.ts` + `ToastStack.tsx` (a toast's
  Details action), and `App.tsx` at the 3D mount seam.
- **One front door.** The top bar's start holds the app's name ("riichiprac",
  an `h1`, on the very top-left) with the setup trigger ("Setup",
  `aria-haspopup="dialog"`) under it — the brand line is the user's request of
  2026-11-20 and the bar grew to `78 px` for it (`HUD_TOP_BAR_BRAND` +
  `HUD_TOP_BAR_BRAND_GAP`). No scenario name and no label of what is loaded. Its box is a layout number, `96 × 44` at
  `topBarPadding.left/top` (`HUD_SETUP_TRIGGER_WIDTH`/`HEIGHT`), and `Hud.css`
  pins the same `min-width`, so `hudAtRestRects()` names and checks the painted
  button rather than trusting the bar's rect. The collision matrix therefore
  covers the trigger at every aspect and hand state.
- **One sheet, one state.** App keeps `hudSheet: 'setup' | 'verdict' | null`
  (replacing H5's `verdictOpen`), so at most one exists (§6.5.8). Opening or
  closing it changes no `GameState`, re-runs neither the deal nor the grade, and
  never remounts the scene. A deal started from the sheet closes it first; so
  does a new hand from any other route and leaving the 3D view.
- **The body.** Four sections in one scrolling column: **Scenario** (the 2D
  `ScenarioPicker` unchanged, staged draft and all; its "Setup" row on the AI
  Hotseat lesson opens the shared `HotseatCardBody` in place, so there is no
  second scrim and no second `dialog`); **Settings** (`AgreementToggle` with its
  tooltip text repeated inline and disabled until Mortal is `ready`,
  `ViewPicker` with the unsupported reason on its option); **Position**
  (`ExportImportControls` from the same props object the 2D header mounts); and
  **Table info** (`TableInfo`, the agreement/scenario notes, and the imported
  position's full `PositionDescriptionCard`). The description's toast now
  carries a **Details** action that opens this sheet; the first line stays in
  the toast.
- **R14 still holds from the sheet.** The View picker calls App's existing
  handler, so switching away from 3D exits full screen exactly as the header
  does; `App.viewSwitch.test.tsx` drives it from the sheet.
- **Nested Escape.** `ScenarioPicker`'s open panel sets
  `NESTED_LAYER_ATTRIBUTE="open"` (only when a host asks, so the 2D header is
  unchanged), which is what the sheet checks: the first Escape closes the panel,
  the second the sheet. The hotseat form needs no marker — it is a block of the
  sheet, not a layer.
- **Layout departs from the draft task text, per §3.** The picker's panel is in
  flow inside the sheet (`position: static`, the sheet body is the only scroll
  container), not an absolutely positioned popover clipped by it. The
  sheet's own sections are exempt from the collision set (§7.6); their bottom is
  still bounded by the collapsed 40 px panel, which the matrix asserts at every
  aspect. The top bar keeps its labels at every aspect: §5's portrait icon-only
  collapse is not implemented in H2–H4, so the trigger's 96 px is its box at
  every size.
- **Not done here.** 3D-15 runs the stress-fixture matrix and the handoff
  screenshots; 3D-16 records the chain.
- **User verdict (2026-11-20): accepted.** The user reviewed the running dev
  server — the setup sheet's four sections, the pool opened and ticked, the
  inline hotseat form, both settings, the position/table blocks — and the top
  bar with the app's name above the Setup trigger, and accepted the composition
  ("this task looks good now"). The brand line (added at the same time, 78 px
  bar) is part of that accepted composition. The numbers above are the scripted
  checks; the look was the user's call.

---

## 10. Non-goals

- No change to `App.tsx`, any component, `App.css`, the store, Rust, `GameState`
  or the snapshot in H1.
- No change to the stacked or top-down layouts, and no return of the retired
  2.5D pipeline (`docs/2_5d-removal.md`).
- No new camera framing, no new tile geometry, no new asset. The signed-off rig
  (75 mm, 50° pitch, portrait 62°) and the committed carve stay as they are.
- No new grading, verdict or scenario logic; the HUD only re-hosts what exists.
- No second hand, no tile thumbnails, no miniature board.
- No persistent HUD settings beyond what the app already stores (view, quality).

---

## 11. Provenance of the numbers

- Aspects: `CAMERA.supportedAspects` plus the two phone sizes already pinned by
  `compassOverlay.test.ts`.
- Projections: `layoutBoard(boardFixture())`, `frameForAspect()`, `hitRects()`,
  `compassPlateRect()`, `compassBox()` at the stage sizes named above, CSS px,
  DPR 1. The fixture's default is one meld per seat; the no-meld, two-, three-
  and four-meld variants (and a four-meld kan) were measured through
  `boardFixture({ meldCounts, kan })` for §7.4's table.
- Compass clearance: `compassBox()`'s bottom edge (the DOM square, not the
  plate).
- Contrast: sRGB composite of the panel alpha over the felt colour, WCAG 2.1
  relative luminance; the felt colours are `FELT`'s `#1a5038` and a lit
  highlight measured from the felt shader's range.
- Nothing here is a visual judgement; §12 is the only human call.

---

## 12. Questions for the user (the handoff)

**Historical, pre-H2.** These were the open choices before the HUD was built;
the as-built sections above supersede them, including the 2026-11-21 change that
removed the pre-answer panel in favour of the isolated call row.

1. **Top bar contents.** Next hand is its one labelled control; the setup
   trigger and the full-screen toggle are icon buttons at the other end. Is
   "next-hand only" meant that strictly (no setup trigger there either, and the
   sheet opens from a corner), or is this reading right?
2. **One anchored result panel; a bare call row before the answer.** The call
   row is isolated buttons over the hand's right edge, and the result card is a
   single `36rem` panel above the hand (worst clearance `123 px` at 9:16 with a
   four-meld hand), falling below it on phones. The alternative is a fixed
   bottom-left panel that never moves. Which do you want?
3. **Mortal chip.** Pre-answer, the hint row carries a one-line Mortal chip
   that opens the verdict sheet (so Peek survives). Alternatively the chip moves
   to the top bar, or pre-answer Peek is dropped in 3D and stays a 2D feature.
4. **Result card slot.** The card replaces both panel rows above the hand (same
   pixels), and its shape is fixed at `104 px` so the 9:16 clearance holds. The
   hint's redundant "Answer submitted" line is dropped post-answer.
5. **Sheet on portrait.** A centred panel from `64 px` to above the collapsed
   hint row, over a `45 %` scrim that keeps the hint readable while the board is
   dimmed. Or should it be a bottom drawer that fully covers the hint row?
6. **Toasts.** Top-centre under the top bar, up to three, no auto-dismiss for
   errors. Accept?
7. **Tokens.** `0.88` panel alpha (floor `0.84`), `10/8 px` radii, `0.78rem`
   controls, tone surfaces reused from `AnswerSummary`. Accept?
