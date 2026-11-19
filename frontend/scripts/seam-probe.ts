/**
 * The headless seam probe's page script (3D-20).
 *
 *   node frontend/scripts/check-3d-seams.mjs          # drives this page
 *   cd frontend && npm run dev                         # or open it by hand at
 *   #   http://localhost:5173/scripts/seam-probe.html?aa=0
 *
 * It mounts the real `TableScene` on the fixture board, waits for the committed
 * relief assets, draws, and prints one JSON blob of measured numbers into
 * `<pre id="report">`: the four seams' read-back scanlines and the perf figures.
 * Nothing here decides anything — `check-3d-seams.mjs` and the user do.
 *
 * Query parameters:
 *
 *   w, h      CSS size of the canvas (default 1920 x 1080)
 *   dpr       device pixel ratio handed to `setSize` (default 1)
 *   tier      quality tier (default `high`)
 *   aa        1/0 forces MSAA on/off; absent follows `antiAliasFor(tier)`
 *   debug     a debug view (`albedo`, `height`, `normal`, `steps`, `pom-off`)
 *   crevice   0 draws the pre-3D-20 body (the crevice profile off)
 *   png       1 also returns the frame as a PNG data URL
 *
 * The PNG is taken in the same task as `seamReport()`'s draw, because the
 * context is created with `preserveDrawingBuffer: false`.
 */

import { antiAliasFor } from '../src/renderers/capabilities';
import type { DebugMode, QualityTier, TableRenderer } from '../src/renderers/contract';
import { BOARD_FAILED_EVENT, BOARD_READY_EVENT } from '../src/renderers/contract';
import { boardFixture } from '../src/renderers/three/boardFixture';
import { TableScene } from '../src/renderers/three/Scene';

const params = new URLSearchParams(window.location.search);
const width = Number(params.get('w') ?? 1920);
const height = Number(params.get('h') ?? 1080);
const dpr = Number(params.get('dpr') ?? 1);
const tier = (params.get('tier') ?? 'high') as QualityTier;
const debugParam = params.get('debug');
const debug = debugParam ? (debugParam as DebugMode) : null;
const aaParam = params.get('aa');
const antialias = aaParam === null ? antiAliasFor(tier) : aaParam !== '0';
const creviceOn = params.get('crevice') !== '0';
const wantPng = params.get('png') === '1';

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const output = document.getElementById('report') as HTMLPreElement;
canvas.style.width = `${width}px`;
canvas.style.height = `${height}px`;

declare global {
  interface Window {
    /** The report `check-3d-seams.mjs` reads over the DevTools protocol. */
    __seamReport?: unknown;
  }
}

function publish(payload: unknown): void {
  window.__seamReport = payload;
  output.textContent = JSON.stringify(payload, null, 2).slice(0, 20_000);
}

// A failure anywhere in the page becomes the report, so the driver never has to
// guess why the block stayed "pending".
window.addEventListener('error', (event) => {
  publish({ error: `page error: ${event.message}` });
});
window.addEventListener('unhandledrejection', (event) => {
  publish({ error: `unhandled rejection: ${String(event.reason)}` });
});

try {
  const scene = new TableScene(canvas, {
    tier,
    debug,
    perfHud: false,
    reducedMotion: true,
    antialias,
  });
  const renderer: TableRenderer = scene;

  const done = (): void => {
    // The before/after switch: `?crevice=0` draws the pre-3D-20 body, which is
    // how the gate proves the defect exists and that the profile removes it.
    if (!creviceOn) scene.setCreviceScale(0);
    renderer.syncState(boardFixture());
    renderer.setSize(width, height, dpr);
    const seams = renderer.seamReport?.() ?? null;
    const png = wantPng ? canvas.toDataURL('image/png') : null;
    publish({
      options: { width, height, dpr, tier, antialias, debug, crevice: creviceOn },
      seams,
      stats: renderer.measure(),
      png,
    });
  };

  canvas.addEventListener(BOARD_READY_EVENT, done, { once: true });
  canvas.addEventListener(
    BOARD_FAILED_EVENT,
    (event) => {
      publish({ error: `board failed: ${String((event as CustomEvent).detail)}` });
    },
    { once: true },
  );
} catch (error) {
  publish({ error: error instanceof Error ? error.message : String(error) });
}
