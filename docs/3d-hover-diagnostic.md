# 3D hover-lift diagnostic (live site)

> **Outcome (2026-11-21).** Run against the failing Windows 10 / Chrome machine,
> step 4a reported `reducedMotion: true` **and** `mediaReduce: true` (the Windows
> "Show animations" setting was off, or Chrome's DevTools media emulation was
> set to `reduce`). 4b showed only `null` clears reaching `setHoverTile`, and 4c
> showed raw pointer events arriving normally. The lift was suppressed by the
> motion preference, not broken. The recorded decision was then changed: the
> hover/focus lift now applies under every motion preference (it is a discrete
> pose change, not an animation); only the deal-in is suppressed. See
> `3d_renderer_implementation_plan.md` §9 decision 8.

Run these in Chrome DevTools → Console on the machine where the 3D hand tile
does **not** rise on hover. Load the 3D view first
(`https://chairbender.github.io/riichiprac/?renderer=3d`) and wait until the
hand is drawn.

Chrome may ask you to type `allow pasting` the first time you paste code into
the console.

What we knew before the run:

- the pointer reaches the projected button and clicking discards correctly
- Tab moves focus through the hand
- the browser is running the current 3D chunk

So the remaining question was: does the scene apply the 0.5-unit lift and the
machine fails to show it, or does the lift never get applied?

---

## Step 1 — grab the live renderer

React attaches its fiber to DOM nodes, and the host's `rendererRef` is in the
hook list. This finds the object that owns `setHoverTile` and stores it on
`window.__r`.

```js
(() => {
  const el = document.querySelector('.renderer-3d-tile');
  const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
  let f = el[key];
  let found = null;
  while (f && !found) {
    let s = f.memoizedState;
    while (s) {
      const v = s.memoizedState;
      if (v && typeof v === 'object' && v.current && typeof v.current.setHoverTile === 'function') {
        found = v.current;
        break;
      }
      s = s.next;
    }
    f = f.return;
  }
  window.__r = found;
  console.log('renderer found:', !!window.__r);
})();
```

Expected: `renderer found: true`.

If it prints `false`, stop here and report that — it means the React hook
layout differs from what we expect on that build.

---

## Step 2 — read the scene while a tile is hovered

**Keep the mouse resting on a hand tile** (do not move it while running this),
then paste:

```js
(() => {
  const r = window.__r;
  const h = r.hover;
  if (!h) return 'no hover ref reached the scene';
  const i = r.layout.tiles.findIndex(
    (t) => t.seat === h.seat && t.zone === h.zone && t.slot === h.slot,
  );
  const y = r.board.tiles.mesh.instanceMatrix.array[i * 16 + 13];
  const poseY = r.layout.tiles[i].pose.position[1];
  return {
    hover: h,
    reducedMotion: r.reducedMotion,
    board: !!r.board,
    layout: !!r.layout,
    instance: i,
    matrixY: y,
    poseY,
    dy: y - poseY, // 0.5 means the scene applied the lift
    meshVisible: r.board.tiles.mesh.visible,
    meshCount: r.board.tiles.mesh.count,
  };
})();
```

Run it once more after moving the pointer **off** the hand, to confirm it
clears (`hover: null`, or `'no hover ref reached the scene'`).

---

## Step 3 — floating HUD clearance

The HUD panel is anchored 8 px above the un-lifted hand band, so the space the
tile rises into may be behind an opaque panel.

```js
(() => {
  const p = document.querySelector('.hud-panel')?.getBoundingClientRect();
  const b = document.querySelectorAll('.renderer-3d-tile')[2].getBoundingClientRect();
  return {
    panelBottom: p?.bottom ?? null,
    tileTop: b.top,
    tileHeight: b.height,
    clearance: p ? b.top - p.bottom : null,
    innerHeight,
    dpr: devicePixelRatio,
    zoom: visualViewport?.scale,
  };
})();
```

---

## Step 4 — instrument the event seam

Run this when step 2 says `'no hover ref reached the scene'`. It finds the
`useRef` object the host actually calls (`__ref.current.setHoverTile`), records
the scene's flags, and lets us call the button's React handlers directly.

### 4a — capture the ref object and the button's props

```js
(() => {
  const el = document.querySelectorAll('.renderer-3d-tile')[2];
  const fk = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
  let f = el[fk];
  let ref = null;
  while (f && !ref) {
    let s = f.memoizedState;
    while (s) {
      const v = s.memoizedState;
      if (v && typeof v === 'object' && v.current && typeof v.current.setHoverTile === 'function') {
        ref = v;
        break;
      }
      s = s.next;
    }
    f = f.return;
  }
  window.__ref = ref;
  window.__r = ref?.current ?? null;
  window.__props = el[fk].memoizedProps;
  window.__seen = [];
  return {
    scene: window.__r?.constructor?.name ?? null,
    disposed: window.__r?.disposed ?? 'no scene',
    reducedMotion: window.__r?.reducedMotion ?? 'no scene',
    mediaReduce: matchMedia('(prefers-reduced-motion: reduce)').matches,
    hover: window.__r?.hover ?? 'no scene',
    hasBoard: !!window.__r?.board,
    hasLayout: !!window.__r?.layout,
    pointerEnterProp: typeof window.__props.onPointerEnter,
    focusProp: typeof window.__props.onFocus,
    pointerType: matchMedia('(pointer: fine)').matches ? 'fine' : 'coarse/no-mouse',
    maxTouchPoints: navigator.maxTouchPoints,
  };
})();
```

### 4b — call the button's own handlers, and tap the seam

This wraps the live `setHoverTile` (the host looks the method up at call time,
so the wrapper is used) and invokes the overlay's `onPointerEnter` / focus
handler as React would.

```js
(async () => {
  const r = window.__r;
  const props = window.__props;
  const original = r.setHoverTile.bind(r);
  r.setHoverTile = (tile) => {
    window.__seen.push(tile);
    return original(tile);
  };

  props.onPointerEnter();
  await new Promise((res) => setTimeout(res, 100));
  const afterEnter = r.hover;

  props.onPointerLeave?.();
  await new Promise((res) => setTimeout(res, 100));
  const afterLeave = r.hover;

  props.onFocus?.();
  await new Promise((res) => setTimeout(res, 100));
  const afterFocus = r.hover;

  return {
    seen: window.__seen,
    afterEnter,
    afterLeave,
    afterFocus,
    reducedMotion: r.reducedMotion,
  };
})();
```

### 4c — real pointer

With 4b's wrapper installed, move the mouse over a hand tile for a second, then
run:

```js
({
  hover: window.__ref.current?.hover ?? 'no scene',
  seen: window.__seen,
  disposed: window.__ref.current?.disposed ?? 'no scene',
});
```

If `seen` does not grow during real hovering while 4b added entries, the DOM is
not delivering `pointerenter` to the button (input mode, emulation, or a layer
in front). The next check is whether raw DOM events reach the element:

```js
(() => {
  const el = document.querySelectorAll('.renderer-3d-tile')[2];
  window.__domEvents = [];
  for (const type of ['pointerover', 'pointerenter', 'pointerdown', 'mouseover', 'mouseenter', 'focus']) {
    el.addEventListener(type, (e) => window.__domEvents.push(type), true);
  }
  return 'listening — hover the tile, then run window.__domEvents';
})();
```

---

## How to read the results

| Result | Meaning | Next fix |
| --- | --- | --- |
| Step 2 `dy ≈ 0.5` | The scene applies the lift; the machine is not showing it. Compare `clearance` with `tileHeight / 2`: at 8 px clearance the HUD panel hides the rise. | HUD clearance / composition |
| Step 2 `dy = 0` (with `hover` set) | Hover reaches the scene but the instance buffer is not lifting. | Scene `syncTiles` / `boardInstances` |
| Step 2 `'no hover ref reached the scene'` | The overlay/host is not reporting the hover. Go to step 4. | Event seam |
| 4a `reducedMotion: true` while `mediaReduce: false` | The host resolved reduce-motion true even though the page media query is false (stale preference or wrong prop). | Host preference wiring |
| 4a `disposed: true` or `hasBoard: false` | The captured scene is not the live one. | Re-run 4a from a live tile |
| 4a `pointerEnterProp` is not `'function'` | These buttons are not the overlay's, or the DOM is stale. | RendererHost / overlay mount |
| 4b `seen` has entries and `afterEnter` is set | The handler and the scene work when called directly. | Look at step 4c: input delivery |
| 4b `seen` empty with `reducedMotion: false` | The overlay's `hover()` suppresses, or `onHoverTile` is missing. | Overlay → host wiring |
| 4c `seen` does not grow on real hover | `pointerenter` is not reaching the button. | Input mode / layer in front |

## What to send back

- The full output of step 2 **while hovering** and **after leaving**
- The full output of step 3
- The full outputs of 4a, 4b, and 4c
- Whether the visible effect is "nothing moves at all" or "the tile's bottom
  edge lifts a little while its top disappears behind the panel"
- Window size and browser zoom level
