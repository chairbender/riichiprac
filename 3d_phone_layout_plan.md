# 3D table on phones: findings, causes and a plan

**Status: proposed and steered 2026-11-20 — awaiting the go-ahead to implement.**
This document changes no code. It records the user's issue list from a real
phone session, traces each item to a number in the HUD or renderer geometry, and
records the user's decision to move the hand to a bottom-edge strip (§4).

Session: task 261120-1754. Device: **Samsung S22 Ultra, Chrome**. Orientation:
**both, landscape preferred**. The app was served over the tailnet
(`https://cachyos-x8664.tail1e5f97.ts.net:8443/`) so the HTTPS origin gave real
`crypto.subtle` and the carved relief atlas, not the fallback.

All numbers below come from the committed pure functions — `frameForAspect()`,
`handBandRect()`, `compassBox()` and `hudLayout()` — evaluated at phone stage
sizes by a throwaway script. They are measurements, not opinions. Nothing in
this document is a judgement of how the table **looks**; that is the user's
call (AGENTS.md §6).

---

## 1. The user's issue list (authoritative scope)

Reported on the S22 Ultra in Chrome, both orientations:

1. **The hand panel / action rail is cut off or missing.**
2. **The hand tiles are too small to tap.**
3. **The discards and the player's hand are too small / blurry.**
4. **The popup after you make a choice is cut off, outside the screen, and not
   big enough to even scroll.**
5. **The setup sheet is unusable.**
6. **The page scrolls / zooms / moves.**

Items 1, 4 and 5 are one defect class: HUD geometry that assumes a tall window.
Item 2 and 3 are one cause: the camera fits the whole board. Item 6 is the
viewport.

---

## 2. Measured baseline

Reference hand (one meld per seat: 10 concealed + the draw = 11 projected
tiles). CSS pixels.

| Stage | Hand band | Tile width | Panel anchor | Panel visible | Sheet |
| --- | --- | --- | --- | --- | --- |
| 390 × 844 portrait | 185 × 25 @ 115,541 | **16.8 px** | below | 84 / 84 | 399 px |
| 412 × 915 portrait (S22 Ultra) | 196 × 26 @ 121,583 | **17.8 px** | below | 84 / 84 | 441 px |
| 844 × 390 landscape | 260 × 34 @ 309,331 | **23.6 px** | below | **17 / 84** | 189 px |
| 915 × 412 landscape | 274 × 35 @ 339,350 | **24.9 px** | below | **19 / 84** | 208 px |
| 932 × 430 landscape (S22 Ultra) | 286 × 37 @ 342,365 | **26.0 px** | below | **20 / 84** | 223 px |
| 844 × 330 (landscape after browser chrome) | 217 × 28 @ 295,280 | **19.7 px** | below | **13 / 84** | 223 px |

For comparison, the same measurements at the signed-off reference aspect
(1920 × 1080) give a **51 px** tile and an 84/84 px panel.

Two numbers frame everything else:

- the board's framing extent at 844 × 390 is `x 159…678` of 844 and
  `y 8…382` of 390 — the fit is **height-bound at every aspect**, so in
  landscape the table uses 62 % of the width and leaves ~160 px free on each
  side;
- 14 tiles cannot exceed `stageW / 14`: **27.8 px in a 390 px portrait window**
  (29.4 at 412) and **60.3 px in an 844 px landscape one** (66.6 at 932).

---

## 3. Issue by issue

### 3.1 Hand panel / action rail / result card off the screen (items 1 and 4)

**Cause.** `anchorPanel()` in `frontend/src/renderers/hud/hudLayout.ts` has two
anchors: above the hand at `handBand.top − 8 − height`, and — when that would
reach the compass — **below** the hand at `handBand.top + handBand.height + 8`
with no clamp to the stage bottom. On a landscape phone the hand band's bottom
is only 25 px above the stage bottom, so the 84 px panel lands at
`y 373…457` in a 390 px stage: **17 px visible, 67 px past the edge**. The
result card (104 px) is worse. That is exactly the user's "cut off, outside the
screen".

The above-the-hand anchor cannot rescue it: the free gap between the compass box
bottom and the hand band top is `band.top − 8 − compassBox.bottom − 8` =

| Stage | Free height above the hand | One action row needs |
| --- | --- | --- |
| 844 × 390 | 78 px | 84 px |
| 915 × 412 | 86 px | 84 px |
| 932 × 430 | 93 px | 84 px |
| 844 × 330 (chrome) | 39 px | 84 px |

So one action row does not fit above the hand on the two common landscape
phones, and nothing fits on the post-chrome one. Portrait is fine *only*
because there is 278 px of empty felt below the hand.

There is also no horizontal room: the board's framing extent leaves ~166 px on
the right at 844 × 390.

**Fix.** The hand strip (§4) changes this anchor outright on phones: the panel
sits **above** the strip, where there is room in both orientations (223/166 px of
strip-plus-panel in 844/390 px of stage). The generic fix is kept as the
contract that must hold whatever the anchor is:

- a hard clamp on every anchor: a panel whose bottom would exceed `stageH − 8`
  is re-anchored rather than drawn off-screen, and a panel that fits no anchor
  collapses to its hint row (40 px) and reports it, so the board is never
  covered by an empty or clipped box;
- the below-the-hand anchor stays for portrait, where it already fits.

**Numbers it changes.** `hudLayout()` gains the strip anchor and the clamp;
`hudAtRestRects()` and the collision matrix gain both; the `8 px` gutter, the
44 px control height and the panel's own 40/84/104/128 px heights do not change.

**2D risk.** None: the anchor lives in `hudLayout()` and the 2D views do not
call it.

**Belongs here or in 261120-1652?** Here. 1652 is the §5 *collapse table*
(icon-only setup trigger, probability badges, chip wordmark) — decoration, not
the anchor.

### 3.2 Hand and discards too small / blurry (items 2 and 3)

Two independent causes.

**(a) Too small — the camera fits the whole board.** `frameForAspect()` solves
the smallest distance that keeps every tile corner inside the 2 % safe area.
At every aspect the fit is height-bound, so a phone gets 17 px portrait /
24 px landscape tiles against the 44 px minimum
(`MIN_HIT_TARGET_PX`, `3d_hud.md` §8). The expansion in
`projectHandTargets()` cannot help: it may grow a target only inside the tile's
own cell (`intersect(…, cell) ?? body`), because growing past the cell makes
neighbours overlap. **A 44 px tap is physically impossible for a one-row
14-tile hand in portrait** (27.8 px cap at 390), and possible in landscape
(60.3 px cap at 844). This is the camera decision in §4.

**(b) Blurry — every touch device is forced onto the `compat` tier.**
`autoQualityTier()` returns `compat` when `touchPrimary` is true (or the
viewport is under 900 × 600), and `TIER_BACKING_STORE.compat` is
`maxDevicePixelRatio: 1` with `antialias: false`. On a DPR-3.5 phone that is
**1 backing pixel per 3.5 device pixels — 29 % of native — and no MSAA**. High
would be `DPR 2`, balanced `1.5`.

That is measurable and cheaply fixable: at 412 × 915, DPR 2 is a **1.51 MP**
backing store, far under both the 8.29 MP and the 4.67 MP caps. The tier should
be chosen by budget, not by whether the device has a touch screen — e.g. allow
`high` (or at least `balanced`) when `cssW × cssH × 2²` is under the tier's own
cap.

**Verify it yourself, no code change needed.** `?quality=` in the URL always
wins over the automatic tier (`resolveQualityTier`: URL > stored > auto). Open

```
https://cachyos-x8664.tail1e5f97.ts.net:8443/?renderer=3d&quality=high
```

and compare with `?quality=compat` (the automatic choice). If the sharpness
difference is what you reported, (b) is confirmed.

**Numbers it changes.** `autoQualityTier()`'s phone branch and
`TIER_BACKING_STORE` consumption in `Scene.ts`; the backing store goes from
0.38 MP to 1.51 MP at 412 × 915. No HUD rect moves.

**2D risk.** None (the 3D renderer only). **Belongs here.**

### 3.3 Setup sheet and verdict sheet unusable (items 4 and 5)

**Cause.** The sheet's height is bounded by the *collapsed hint panel*
(`sheetBottom = min(collapsedPanelTop − 8, sheetTop + 0.78·H)`) so that the hint
row stays visible under the scrim. On a phone the collapsed panel is pinned to
the hand, so the sheet gets whatever is left:

| Stage | Sheet today | If it used the stage below the bar |
| --- | --- | --- |
| 390 × 844 | 399 px (body 335) | **750 px** (body 686) |
| 412 × 915 | 441 px | **813 px** |
| 844 × 390 | 189 px (body 125) | **296 px** |
| 932 × 430 | 223 px | **328 px** |

A 125 px body for the scenario pool or a full verdict is the "not big enough to
even scroll" report. The body itself is correct (`flex: 1; min-height: 0;
overflow: auto; overscroll-behavior: contain`) — it is only starved of height.

**Fix.** On phone-class stages the sheet takes **the whole stage below the top
bar** (`topBar.bottom + 8` → `stageH − 8`) and the hint row is **hidden** while
it is open. The hint is informational and it is also duplicated at the top of
the result card; §7.6 already exempts the open sheet from the collision rule.
Keep the current bounded sheet on wide/square stages.

**Numbers it changes.** `hudLayout()`'s `sheet` rect gets a phone branch
(`sheetBottom = stageH − 8`); the panel's `panelSlot` becomes `'none'` instead
of `'hint'` on phones while a sheet is open; the sheet's `0.78·H` and 832 px
caps are unchanged elsewhere.

**2D risk.** None. **Belongs here** (the §5 "sheet is bounded by the collapsed
panel" rule is being amended, which is a `3d_hud.md` change the user signs off).

### 3.4 Scrolling / zooming / the page moves (item 6)

**Cause.** `frontend/index.html` declares
`<meta name="viewport" content="width=device-width, initial-scale=1.0">` with no
`viewport-fit=cover` and no scale clamp, and nothing sets `overflow`,
`overscroll-behavior` or `touch-action` on the stage. Consequences:

- **pinch and double-tap zoom are live** over the canvas, so a stray drag pans
  or zooms the page;
- `html`, `body` and `#root` have `min-height` but no `overflow: hidden`, so the
  page rubber-bands when the URL bar changes `dvh`;
- **`env(safe-area-inset-*)` is always 0 without `viewport-fit=cover`**, so the
  HUD's safe-area probe reads zeros and the existing
  `env(safe-area-inset-*)` padding in `App.css` (three rules) is dead code. The
  notch and the landscape camera cutout are not handled at all.

**Fix.** `viewport-fit=cover` in the meta; `touch-action: manipulation` (or
`none`) on the stage root and canvas; `overscroll-behavior: none` and
`overflow: hidden` scoped to the 3D shell (a class on `html`/`body` while the 3D
view is mounted), leaving the 2D views scrollable and pinch-zoomable. Do **not**
add a global `user-scalable=no`: that would take zoom away from the accessible
2D fallback.

**Numbers it changes.** Safe insets become real. With `viewport-fit=cover` the
top bar becomes `18 + 4 + 44 + 6 + max(6, safeTop)`: 78 px with no inset, 78 +
cutout in landscape on a device whose cutout is on the leading edge. Those are
already the formula's inputs; nothing new is invented.

**2D risk.** `viewport-fit=cover` *enables* the 2D shell's existing safe-area
padding, which is the intended behaviour; the `overflow`/`touch-action` rules
must be scoped so the stacked and top-down views are untouched.

**Belongs here.**

---

## 4. The decision (user, 2026-11-20): a hand strip on the bottom edge

> "For mobile, I'd like the player's hand to just be shoved up right on the
> bottom edge of their screen, no longer tied to the table, for maximum
> visibility. Just the player's hand and the discards and the compass are what
> most needs to be visible, everything else is just decoration. The melds need
> to be visible too, actually."

That settles the design fork: **the human's hand leaves the table** and becomes
a fixed HUD strip flush to the bottom safe edge, carrying the concealed tiles
and the draw. **The player's melds stay projected on the 3D table** (user's
answer to the follow-up question), and the 3D concealed hand is not drawn.
Opponents' hands and melds stay in 3D. The camera only has to make the **four
rivers**, the **compass** and the **players' melds** legible; the walls are
decoration and may crop.

### 4.1 Strip geometry

The strip is sized for the **worst case, 14 interactive tiles** (13 concealed +
the draw), so its height and tile never change when a hand is melded or
answered; a shorter hand is centred in the same row. Tiles are the 2D art's 3:4
(`riichi-mahjong-tiles` is `300 × 400`). Gutter 8 px, gap 4 px.

| | Portrait 390 × 844 | Landscape 844 × 390 |
| --- | --- | --- |
| Rows | 2 × 7 | 1 × 14 |
| Tile width | (390 − 16 − 6·4) / 7 = **50.0 px** | (844 − 16 − 13·4) / 14 = **55.4 px** |
| Tile height | **66.7 px** | **73.9 px** |
| Strip height (hint 24 + gap 4 + tiles + 4 top pad + 8 bottom pad) | **177 px** | **114 px** |
| With the action rail above it (+44 + 4) | 225 px | (beside, see below) |
| With the result card instead (+104 + 4) | 285 px | (beside) |

At 412 × 915 portrait the tile is 53.1 px wide (strip 186 px); at 932 × 430
landscape it is 61.7 px (strip 122 px). Both are 2–3.5× today's 17/24 px and
well past the 44 px tap minimum in both axes. For reference, the 2D stacked
view's own hand tiles cap at `--hand-tile-size`'s 38 px, so the phone strip is
*larger* than the accessible fallback's hand.

Two rows is the portrait maximum: three rows of 5 would be 71.6 px wide but
286 px of tile alone, taking a third of the screen. The 320 × 568 compatibility
row settles at 2 × 7 of 40 px — the one stage where two rows cannot reach 44,
because three rows would take 49 % of its height; the test records the number
rather than hiding it.

Where the action rail and the result card go:

- **Portrait**: above the strip, centred (§4.2). The strip already carries the
  hint, so the panel mounts only for an action rail or a result.
- **Landscape**: the **right control column**, `min(240, max(150, 24 % of the
  width))` wide (203 px at 844, 224 at 932), from under the top bar to the
  strip's top. It sits beside the board because a 390 px-tall stage has no room
  above the strip: the compass's own box leaves 19 px.
- The action row's second form (128 px) is what makes the strip reserve room:
  on a short landscape stage the strip yields height until the column fits, but
  never below the 44 px tile minimum.

### 4.2 What the strip costs the board

The strip is opaque HUD over the stage; the board keeps its committed rig and
the renderer is fitted into the box above the strip (`--hud-hand-strip` is the
stage's bottom inset, so nothing is ever covered). Measured board extent, with
the human's hand removed from the board:

| Stage | Strip | Board extent (full window → fitted) | Scale | Discard tile |
| --- | --- | --- | --- | --- |
| 390 × 844 portrait | 177 px | 369 × 299 → **369 × 299** | **1.000×** | 15.8 × 23.0 (unchanged) |
| 412 × 915 portrait | 186 px | 390 × 315 → **390 × 315** | **1.000×** | 16.7 × 24.3 (unchanged) |
| 844 × 390 landscape | 114 px | 520 × 374 → 360 × 265 | **0.693×** | 15.3 × 22.6 |
| 932 × 430 landscape | 122 px | 573 × 413 → 401 × 295 | **0.701×** | 17.1 × 25.2 |
| 844 × 330 landscape (+chrome) | 108 px | 434 × 317 → 287 × 213 | **0.661×** | 14.6 × 21.6 |

So in **portrait the strip is free** — the board is width-bound and does not move
at all. In **landscape it costs about 30 %** of the board's scale, because the
fit is height-bound and the strip takes 114 of 390 px.

This is the honest cost of the decision, stated as a number: landscape discards
go from 22 × 33 px to 15 × 23 px, which is where portrait's already are. The
levers, if the user wants them, are a shorter landscape strip (44 px tiles take
~99 px instead of 114 and recover ~7 % of board scale) or the fullscreen toggle
(the URL bar costs a further ~5 %).

This is also the honest ceiling for the discards: a 390 px portrait window shows
four rivers side by side, so a discard is ~16 px wide and cannot be enlarged
without cropping the east and west seats — which the user's "discards must be
visible" rules out. Landscape is ~8 % larger after the strip and is the better
discard view.

### 4.3 Consequences to sign off

1. `3d_hud.md` §1.3 ("the HUD never renders a second hand") is reversed **on
   phone-class stages only**: the strip is the human's only hand there, and the
   scene stops publishing a hand band. On tablet/desktop nothing changes.
2. The strip is **not a second implementation**: it is `HandDock`'s own tile
   buttons (`variant="strip"`) — same labels, disabled state, answer marks, AI
   badges, Riichi/Kan arming — so the one-control-per-tile test still holds
   with the strip mounted.
3. The player's melds **stay on the 3D table** (user decision): only the
   concealed tiles and the draw leave it.
4. The camera is unchanged in portrait. In landscape the scene is fitted into
   the box above the strip — a viewport inset, not a new rig: no pitch, lens or
   distance change.

### 4.4 Rejected alternatives

- **Shape B, fit the board to the width.** Gives 27.8 px portrait / 60.3 px
  landscape tiles but crops ~53 % / ~69 % of the depth and removes the free side
  strip the HUD needs. It also cannot beat a hand strip, which reaches the
  44 px minimum without cropping anything.
- **Shape A, keep the projected hand and side-dock the panel.** Fixes the
  clipping but leaves the tiles at 17/24 px, which is the user's item 2.
- **A blocking "turn your phone" gate.** Portrait is what the app lands in (3D
  is the default view) and iPhone cannot be locked (§5).

---

## 5. Orientation

The user's steer: **both, landscape preferred**.

- **`screen.orientation.lock()` needs fullscreen and is not universal.**
  Android Chrome supports it (inside fullscreen, which the app already has a
  button for). **iPhone Safari cannot**: the Screen Orientation API is present
  but `lock()` is not, and iPhone has no HTML fullscreen at all, so the lock
  could never be granted (WebKit bug 257695 — lock is iPad-only today).
- **Therefore "force landscape" cannot be the design.** It would work on
  Android and silently do nothing on iPhone, which is the worst of both.

**Recommendation.**

1. Both orientations stay supported; portrait keeps the below-the-strip panel.
2. Add a **"Rotate to landscape"** action to the setup sheet that enters
   fullscreen on the shell and then calls `screen.orientation.lock('landscape')`.
   Mount it only when both APIs exist (`document.fullscreenEnabled` and
   `screen.orientation.lock`), so iPhone and desktop simply do not show it.
3. On a phone in portrait, show a **dismissible one-line hint** near the top bar
   ("Landscape gives a bigger table"), never a blocking gate. It must not
   appear on desktop or in the 2D views.
4. Fallback when locking is unavailable: the browser's own rotation, plus
   portrait's layout, which is fully usable after §3.1/§3.3.

A blocking "turn your phone" gate is rejected: it would lock out portrait
users, and portrait is the orientation the app lands in today (3D is the
default view).

---

## 6. Unit breakdown

**As built 2026-11-20** — Unit 0 and Unit 1 landed together (user's choice).
The gate is green: `npm test` (1544 passed), `npm run build`, `npm run lint`,
`node frontend/scripts/check-3d-layout.mjs`.

Each unit keeps the frontend gate green and extends the collision matrix's phone
rows with the geometry it adds (the rows now live in `hudLayout.test.ts` as
`PHONE_STAGES`, and `phoneScene()` builds the same reduced viewport the renderer
gets).

**Unit 0 — phone defects, no design input (items 1, 4, 5, 6 and 3b).** First,
and independently reviewable on the phone.

- 0a. Viewport and touch: `viewport-fit=cover`, stage `touch-action`,
   `overscroll-behavior`/`overflow` scoped to the 3D shell. Gates: an
   `index.html` assertion + `hudCss.test.ts` rules; safe insets become non-zero
   and the existing top-bar formula is exercised with them.
- 0b. Tier: stop forcing `compat` for touch; pick by backing-store budget. Gate:
  `capabilities.test.ts` rows for a 412 × 915 and a 932 × 430 phone.
- 0c. Panel anchor: above the hand strip on phones, below the hand in portrait
  until 1a lands, plus a hard no-off-screen clamp. Gate: `hudLayout.test.ts`
  phone rows × six hand states × `{actions, result}` asserting
  `panel.bottom ≤ stageH − 8` and zero collisions; add the two phone stages the
  matrix lacks (a landscape phone and a post-chrome landscape phone).
- 0d. Sheet: full stage below the bar on phone-class stages. Gate: the phone
  rows assert `sheet.bottom = stageH − 8` and a body height over a floor.

**Unit 1 — the hand strip (items 2 and 3a), per §4.**

- 1a. `hudLayout()` gains the phone `handStrip` rect: one row of 14 in
  landscape, two rows of 7 in portrait, tile = `(w − 16 − gaps) / perRow`, tile
  height = 4/3 of its width, hint row 24 + 8 px pad + the bottom safe inset
  (§4.1). The action rail and the result card anchor above it.
- 1b. `RendererHost` / `Scene` hide the 3D human hand **and its melds** on
  phone-class stages, reserve the strip's band in the fit (§4.2), and stop
  publishing a hand band there.
- 1c. The strip reuses 3D-08's DOM tile buttons — labels, disabled state,
  answer marks, AI badges, Riichi/Kan arming — so the
  one-control-per-hand-tile test still holds with the strip mounted, and the
  player's melds are grouped after the draw.
- Gates: every strip tile is ≥ 44 px in both axes at 390 × 844, 412 × 915,
  844 × 390 and 844 × 330; the strip never intersects the compass; the board's
  reserved-band fit keeps the human's river clear of the strip (the §4.2
  clearances); the 2D views are unchanged.

**Unit 2 — orientation affordance (§5).** Setup-sheet action, capability
detection, the portrait hint, and tests that it is absent when the APIs are.

**Not in scope:** Rust/WASM, `GameState`, the 2D layouts, the retired 2.5D
pipeline, and any change to the carve or the table model.

---

## 7. Open questions

1. **Melds** — settled: they stay on the 3D table.
2. **Rows** — settled: portrait 2 × 7 (50 px tiles), landscape 1 × 14 (55 px).
3. **Blur** — `?quality=high` vs `?quality=compat` is still worth a look (§3.2);
   the automatic tier now picks `high` on a phone, so the URL is only a
   comparison.
4. **Landscape board cost** — the strip costs ~30 % of the board there
   (discards 22 × 33 → 15 × 23). If that reads as too much on the device, the
   one number to change is the landscape tile target (44 px tiles recover ~7 %).

---

## 8. What landed (2026-11-20)

| File | Change |
| --- | --- |
| `hud/hudLayout.ts` | `handStripFor()`, `isPhoneStage()`, the phone panel anchors (`above-strip`, `beside`), the phone sheet, side-docked phone toasts; `HudState.phone`, `HudLayout.handStrip` |
| `hud/HudLayer.tsx` | mounts the strip, publishes `--hud-hand-strip`, adds it to the sheet's inert set |
| `hud/Hud.css` | the opaque strip surface and its fixed-size tile row |
| `hud/usePhoneStage.ts` | the one phone answer, shared by App's HUD and renderer |
| `components/HandDock.tsx` | `variant="strip"`: the tiles alone, the same buttons |
| `App.tsx` / `App.css` | the shared `phoneStage`, the strip element, the stage's bottom inset, `touch-action`/`overflow`/`overscroll` |
| `index.html` | `viewport-fit=cover` (which is also what makes the existing `env(safe-area-inset-*)` rules work) |
| `renderers/capabilities.ts` | a phone viewport picks its tier by backing-store budget instead of being forced to `compat` |
| `renderers/contract.ts`, `RendererHost.tsx`, `three/Scene.ts` | `hideHumanHand`: the board is laid out without the human's concealed tiles and draw, so the strip is the only hand |
| `hud/hudLayout.test.ts` | `PHONE_STAGES` × slots × rows: strip geometry, the 44 px floor, anchors, no off-stage panel, no collisions, the phone sheet |
| `hud/HudLayer.test.tsx`, `hud/hudCss.test.ts` | the strip mounts, the stage inset is published, the surface rules |
| `capabilities.test.ts`, `RendererHost.test.tsx` | the new tier rule and the `hideHumanHand` flag |

**Not changed:** Rust/WASM, `GameState`, the 2D stacked/top-down layouts, the
camera rig, the carve, and the retired 2.5D pipeline.
