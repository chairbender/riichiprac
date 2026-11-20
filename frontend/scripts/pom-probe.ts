/**
 * The POM cost probe's page script (3D-S1).
 *
 *   node frontend/scripts/check-3d-pom.mjs            # drives this page
 *   cd frontend && npm run dev                         # or open it at
 *   #   http://localhost:5173/scripts/pom-probe.html?w=3840&h=2160&steps=0,8,12,16
 *
 * It mounts the real `TableScene` on the fixture board — a full board's worth
 * of tile instances — then renders that board repeatedly with the depth march
 * at 0 / 8 / 12 / 16 steps, timing six-frame batches with
 * `EXT_disjoint_timer_query_webgl2` and reporting CPU submission separately.
 * One JSON blob of numbers goes into `<pre id="report">`; `check-3d-pom.mjs`
 * prints the table and the plan records it. Nothing here decides anything or
 * draws a conclusion from pixels.
 *
 * Query parameters:
 *
 *   w, h        CSS size of the canvas (default 1920 x 1080)
 *   dpr         device pixel ratio handed to `setSize` (default 1)
 *   tier        quality tier (default `high`)
 *   aa          1/0 forces MSAA on/off; absent follows `antiAliasFor(tier)`
 *   steps       comma-separated depth step counts (default 0,8,12,16)
 *   shadow      self-shadow march steps to hold constant (default the tier's)
 *   samples     measured batches per step, order alternating (default 24)
 *   batch       frames per timed batch (default 8)
 *   warmup      unmeasured frames per step before each batch (default 6)
 *   ramp        clock-ramp milliseconds before the first measurement (default 15000)
 *
 * The scene's own install-time tier monitor is stopped before measuring: a
 * 4K `high` frame can legitimately cross the downgrade threshold, and a
 * downgrade would silently change the step count this page is measuring.
 */

import { antiAliasFor } from '../src/renderers/capabilities';
import type { QualityTier } from '../src/renderers/contract';
import { BOARD_FAILED_EVENT, BOARD_READY_EVENT } from '../src/renderers/contract';
import { boardFixture } from '../src/renderers/three/boardFixture';
import { POM_STEPS, shadowStepsFor, type TileMaterialHandle } from '../src/renderers/three/tileMaterial';
import { TableScene } from '../src/renderers/three/Scene';

const params = new URLSearchParams(window.location.search);
const width = Number(params.get('w') ?? 1920);
const height = Number(params.get('h') ?? 1080);
const dpr = Number(params.get('dpr') ?? 1);
const tier = (params.get('tier') ?? 'high') as QualityTier;
const aaParam = params.get('aa');
const antialias = aaParam === null ? antiAliasFor(tier) : aaParam !== '0';
const stepCounts = (params.get('steps') ?? '0,8,12,16')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value >= 0);
const shadowSteps = Number(params.get('shadow') ?? shadowStepsFor(tier, null));
const samples = Math.max(1, Number(params.get('samples') ?? 24));
const warmup = Math.max(0, Number(params.get('warmup') ?? 6));
const batch = Math.max(1, Number(params.get('batch') ?? 8));
const rampMs = Math.max(0, Number(params.get('ramp') ?? 15000));

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const output = document.getElementById('report') as HTMLPreElement;
canvas.style.width = `${width}px`;
canvas.style.height = `${height}px`;

/** The private handles the probe needs; the page is the one caller in the repo. */
interface SceneInternals {
  readonly board?: { readonly material: TileMaterialHandle };
  draw(): void;
  sampleHandle: number | null;
  sampled: boolean;
}

declare global {
  interface Window {
    /** The report `check-3d-pom.mjs` reads over the DevTools protocol. */
    __pomReport?: unknown;
  }
}

function publish(payload: unknown): void {
  window.__pomReport = payload;
  output.textContent = JSON.stringify(payload, null, 2).slice(0, 40_000);
}

// A failure anywhere in the page becomes the report, so the driver never has to
// guess why the block stayed "pending".
window.addEventListener('error', (event) => {
  publish({ error: `page error: ${event.message}` });
});
window.addEventListener('unhandledrejection', (event) => {
  publish({ error: `unhandled rejection: ${String(event.reason)}` });
});

/** A nearest-rank percentile over an already-sorted array. */
function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)));
  return sorted[index];
}

/** Median / p95 / min / max of one measurement series. */
function summarise(values: readonly number[]): {
  median: number;
  p95: number;
  min: number;
  max: number;
  samples: number;
} {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    samples: sorted.length,
  };
}

/** The timer-query extension's shape (not in TypeScript 5.6's DOM lib). */
interface TimerQueryExtension {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

/** Counters for why timer-query results were unusable, if they ever are. */
interface TimerNotes {
  unavailable: number;
  disjoint: number;
  lastNs: number | null;
}

/**
 * Wait for a timer-query result.
 *
 * The renderer only learns that the GPU finished a query after the command
 * buffer's completion callback has run, so this yields to the event loop
 * between polls instead of spinning: a tight loop on the main thread can keep
 * the result unavailable forever (measured on Chrome 157 / ANGLE/GL).
 */
async function readQuery(
  gl: WebGL2RenderingContext,
  ext: TimerQueryExtension,
  query: WebGLQuery,
  notes: TimerNotes,
): Promise<number | null> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE) === true) {
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) === true;
      const ns = gl.getQueryParameter(query, gl.QUERY_RESULT) as number;
      if (disjoint) {
        notes.disjoint += 1;
        return null;
      }
      notes.lastNs = ns;
      return ns / 1e6;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  notes.unavailable += 1;
  return null;
}

/**
 * Render one batch of frames and return its GPU time and CPU submission time,
 * per frame.
 *
 * The GPU number comes from one `EXT_disjoint_timer_query_webgl2` query around
 * the batch. Two lessons are baked into that shape, both measured here on
 * Chrome 157 / ANGLE/GL:
 *
 * - A query must not be read while the main thread spins. `gl.finish()` and
 *   `fenceSync` + `clientWaitSync` both returned in 0.2 ms with a whole batch
 *   still queued, and a tight poll loop never sees `QUERY_RESULT_AVAILABLE`.
 *   The read below is async, so the renderer's completion callback can run.
 * - A query around one frame also brackets the gap to that frame's flush and
 *   reported one display interval (16.7 ms at 1080p for 0 and 12 steps alike).
 *   A batch amortises the markers.
 *
 * Submission time is reported separately rather than folded in: it is CPU work
 * and does not grow with the depth march.
 */
async function measureBatch(
  scene: SceneInternals,
  gl: WebGL2RenderingContext,
  ext: TimerQueryExtension | null,
  batchSize: number,
  notes: TimerNotes,
): Promise<{ gpuMs: number | null; submitMs: number }> {
  const query = ext ? gl.createQuery() : null;
  if (ext && query) gl.beginQuery(ext.TIME_ELAPSED_EXT, query);

  const submitted = performance.now();
  for (let index = 0; index < batchSize; index += 1) scene.draw();
  const submitMs = (performance.now() - submitted) / batchSize;

  if (!ext || !query) {
    gl.finish();
    return { gpuMs: null, submitMs };
  }
  gl.endQuery(ext.TIME_ELAPSED_EXT);
  gl.flush();
  const value = await readQuery(gl, ext, query, notes);
  gl.deleteQuery(query);
  return { gpuMs: value === null ? null : value / batchSize, submitMs };
}

// Create the context ourselves with `desynchronized: true` so presentation is
// not tied to the compositor's frame: a synchronized context puts a vblank
// wait inside every read-back, which is the difference between measuring this
// shader and measuring the display.
const createdContext = canvas.getContext('webgl2', {
  desynchronized: true,
  antialias,
  alpha: false,
  depth: true,
  stencil: false,
  powerPreference: 'high-performance',
  preserveDrawingBuffer: false,
});
if (!createdContext) throw new Error('WebGL2 is not available on this canvas');

try {
  const scene = new TableScene(canvas, {
    tier,
    debug: null,
    perfHud: false,
    reducedMotion: true,
    antialias,
  });
  const internals = scene as unknown as SceneInternals;

  const done = async (): Promise<void> => {
    scene.syncState(boardFixture());
    scene.setSize(width, height, dpr);

    // Stop 3D-11's install-time monitor: its whole job is to change the tier
    // when a frame is slow, which is exactly the variable under test here.
    const schedule = globalThis.cancelAnimationFrame;
    if (typeof schedule === 'function' && internals.sampleHandle !== null) {
      schedule.call(globalThis, internals.sampleHandle);
      internals.sampleHandle = null;
    }
    internals.sampled = true;

    const gl = canvas.getContext('webgl2') as WebGL2RenderingContext | null;
    if (!gl) throw new Error('the scene canvas has no WebGL2 context');
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerQueryExtension | null;
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    const material = internals.board?.material;
    if (!material) throw new Error('the board view never mounted');

    if (material.pomSteps() !== POM_STEPS[tier]) {
      throw new Error(
        `the material started at ${material.pomSteps()} steps, not the ${tier} tier's ${POM_STEPS[tier]}`,
      );
    }
    material.setShadowSteps(shadowSteps);

    const gpuMs: Record<number, number[]> = {};
    const submitMs: Record<number, number[]> = {};
    const timerNotes: TimerNotes = { unavailable: 0, disjoint: 0, lastNs: null };
    for (const steps of stepCounts) {
      gpuMs[steps] = [];
      submitMs[steps] = [];
    }

    // Ramp the GPU's clocks before the first measurement. This iGPU starts at
    // its idle point and needs seconds of real frames to boost: a 24-frame
    // ramp made the first measured step count (0) look 2x slower than the last
    // (16), which read as "more POM steps are faster". The measured first pass
    // after this ramp is the report's cold/warm note.
    material.setPomSteps(POM_STEPS[tier]);
    const rampStarted = performance.now();
    const rampPixel = new Uint8Array(4);
    let rampFrames = 0;
    while (performance.now() - rampStarted < rampMs) {
      for (let index = 0; index < 4; index += 1) internals.draw();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rampPixel);
      rampFrames += 4;
      if (rampFrames % 32 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }

    // Alternate the order every iteration (0,8,12,16 then 16,12,8,0): this GPU
    // drifts for seconds at a time (clock and thermal state), and measuring the
    // same relative order every time let that drift land on the first count.
    // Reversing each iteration cancels a monotonic drift; the medians below are
    // over the whole interleaved window, not one cold pass.
    for (let iteration = 0; iteration < samples; iteration += 1) {
      const order = iteration % 2 === 0 ? stepCounts : [...stepCounts].reverse();
      for (const steps of order) {
        material.setPomSteps(steps);
        // Warm-up frames bind the new uniform and settle the driver's clocks.
        for (let index = 0; index < warmup; index += 1) {
          internals.draw();
        }
        gl.flush();
        await new Promise((resolve) => setTimeout(resolve, 0));
        const timing = await measureBatch(internals, gl, ext, batch, timerNotes);
        if (timing.gpuMs !== null) gpuMs[steps].push(timing.gpuMs);
        submitMs[steps].push(timing.submitMs);
      }
    }

    // Restore the tier's own depth count so `measure()` reports the shipped view.
    material.setPomSteps(POM_STEPS[tier]);

    const results = stepCounts.map((steps) => {
      const gpuSummary = gpuMs[steps].length > 0 ? summarise(gpuMs[steps]) : null;
      const submitSummary = submitMs[steps].length > 0 ? summarise(submitMs[steps]) : null;
      const zero = gpuMs[0]?.length > 0 ? summarise(gpuMs[0]) : null;
      return {
        steps,
        gpu: gpuSummary,
        submit: submitSummary,
        // Cost attributable to the depth march: this count minus 0 steps.
        vsZero: gpuSummary && zero ? gpuSummary.median - zero.median : null,
      };
    });

    const stats = scene.measure();
    const budgetMs = 1000 / 60;
    const live = results.find((entry) => entry.steps === POM_STEPS[tier]);
    publish({
      options: {
        width,
        height,
        dpr,
        tier,
        antialias,
        shadowSteps,
        stepCounts,
        samples: samples * batch,
        batch,
        warmup,
        rampMs,
      },
      backend: {
        vendor: debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
        renderer: debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        version: gl.getParameter(gl.VERSION),
        timerQuery: ext !== null,
        timerQueryNotes: timerNotes,
        contextAttributes: gl.getContextAttributes(),
        drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
        drawingBufferPixels: gl.drawingBufferWidth * gl.drawingBufferHeight,
      },
      stats,
      results,
      frameBudgetMs: budgetMs,
      // Headroom of the tier's own step count against a 60 fps frame, in ms.
      headroom: live?.gpu ? budgetMs - live.gpu.median : null,
    });
  };

  canvas.addEventListener(BOARD_READY_EVENT, () => {
    done().catch((error: unknown) => {
      publish({ error: error instanceof Error ? error.message : String(error) });
    });
  }, { once: true });
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
