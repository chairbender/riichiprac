#!/usr/bin/env node
/**
 * The POM cost measurement (3D-S1): how many depth-march steps fit in a frame
 * on this machine's real GPU, measured with the shader 3D-05 actually built.
 *
 *   cd frontend && npm run pom:measure
 *   node frontend/scripts/check-3d-pom.mjs --sizes=1920x1080@1,3840x2160@1
 *   node frontend/scripts/check-3d-pom.mjs --steps=0,8,12,16 --shadow=4
 *   node frontend/scripts/check-3d-pom.mjs --samples=30 --batch=6 --ramp=25000
 *   node frontend/scripts/check-3d-pom.mjs --swiftshader      # software control
 *   node frontend/scripts/check-3d-pom.mjs --headful          # real window
 *
 * This is a measurement, not a gate: it changes nothing and asserts only that
 * the page reported numbers. It serves `scripts/pom-probe.html` through the
 * frontend's own Vite install, drives it in Chrome, and prints the table the
 * plan records (§2.8). The page mounts the real `TableScene` on the fixture
 * board (~252 tile instances, five draw calls), disables 3D-11's downgrade
 * monitor so the tier cannot change under the measurement, ramps the GPU's
 * clocks, then times six-frame batches with `EXT_disjoint_timer_query_webgl2`.
 * CPU submission is printed beside the GPU time rather than folded into it.
 *
 * Backend. By default Chrome is asked for ANGLE over the desktop GL driver,
 * which in headless mode on this machine resolves to the real Intel GPU
 * (`ANGLE (Intel, Mesa Intel(R) Graphics (MTL), OpenGL ES 3.2)`); `--swiftshader`
 * asks for the software rasteriser instead as a control. The measured renderer
 * string is printed and recorded, so a run is never mistaken for the other.
 *
 * Requirements: Chrome/Chromium on PATH (or `CHROME=/path/to/chrome`) and
 * `npm ci` in frontend/.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const FRONTEND_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Parse `--name=value` flags. */
function flags(argv) {
  const out = new Map();
  for (const argument of argv) {
    const match = /^--([a-zA-Z-]+)(?:=(.*))?$/.exec(argument);
    if (match) out.set(match[1], match[2] ?? 'true');
  }
  return out;
}

const options = flags(process.argv.slice(2));
const sizes = (options.get('sizes') ?? '1920x1080@1,3840x2160@1')
  .split(',')
  .map((entry) => {
    const match = /^(\d+)x(\d+)(?:@(\d+(?:\.\d+)?))?$/.exec(entry.trim());
    if (!match) throw new Error(`--sizes entries must look like 1920x1080@1, not ${entry}`);
    return { width: Number(match[1]), height: Number(match[2]), dpr: Number(match[3] ?? 1) };
  });
const steps = options.get('steps') ?? '0,8,12,16';
const tier = options.get('tier') ?? 'high';
const shadow = options.get('shadow') ?? null;
const samples = options.get('samples') ?? '12';
const batch = options.get('batch') ?? '8';
const ramp = options.get('ramp') ?? '15000';
const swiftshader = options.has('swiftshader');
const headful = options.has('headful');
const keepOut = options.get('out') ?? '/tmp/opencode/pom-probe';

/** Every Chrome binary worth trying, in order. */
function chromeBinary() {
  const candidates = [
    process.env.CHROME,
    'google-chrome-stable',
    'google-chrome',
    'chromium',
    'chromium-browser',
  ].filter((value) => typeof value === 'string' && value.length > 0);
  return candidates[0];
}

/** Start the app's Vite server in middleware mode and return its URL. */
async function startServer() {
  let createServer;
  try {
    ({ createServer } = await import('vite'));
  } catch {
    throw new Error(
      "this probe loads the app through the frontend's own Vite install; run `npm ci` in frontend/ first",
    );
  }
  const server = await createServer({
    root: FRONTEND_ROOT,
    configFile: false,
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') {
    await server.close();
    throw new Error('vite did not report a port');
  }
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

/** Read the page's published report, polling in real time. */
const WAIT_EXPRESSION = `new Promise((resolve) => {
  const started = Date.now();
  const tick = () => {
    if (window.__pomReport) resolve(window.__pomReport);
    else if (Date.now() - started > 240000) resolve({ error: 'the page did not publish a report within 240 s' });
    else setTimeout(tick, 100);
  };
  tick();
})`;

/** The rendering backend flags for one run. */
function backendFlags() {
  if (swiftshader) {
    return ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  }
  // ANGLE over the desktop GL driver: headless Chrome keeps the real GPU
  // instead of falling back to SwiftShader. `--enable-unsafe-swiftshader`
  // stays as a last resort so a driverless machine still produces a report
  // (which then names SwiftShader in its renderer string).
  return [
    '--use-gl=angle',
    '--use-angle=gl',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    // No swap-chain throttle: a frame budget benchmark must not measure the
    // display's vblank, and the timer query otherwise reports one vsync
    // interval per frame no matter how little work the frame contains.
    '--disable-gpu-vsync',
    '--disable-frame-rate-limit',
    '--enable-unsafe-swiftshader',
  ];
}

/** Drive Chrome over the DevTools protocol and return the page's report. */
async function renderReport(chrome, url, timeoutMs) {
  const profile = mkdtempSync(join(tmpdir(), 'chrome-pom-'));
  const child = spawn(
    chrome,
    [
      ...(headful ? [] : ['--headless=new']),
      '--no-sandbox',
      '--disable-gpu-sandbox',
      ...backendFlags(),
      '--window-size=1920,1080',
      ...(headful ? ['--window-position=-4000,-4000', '--disable-background-timer-throttling'] : []),
      '--hide-scrollbars',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      url,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const wsUrl = await new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(
      () => reject(new Error(`chrome printed no DevTools endpoint; stderr:\n${stderr.slice(-2000)}`)),
      timeoutMs,
    );
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  const endpoint = new URL(wsUrl);
  const pageSocketUrl = await (async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const response = await fetch(`http://${endpoint.host}/json/list`);
        const targets = await response.json();
        const page = targets.find(
          (target) => target.type === 'page' && String(target.url).startsWith('http'),
        );
        if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
      } catch {
        // The endpoint is not up yet; keep waiting.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('chrome never exposed a page target');
  })();

  const socket = new WebSocket(pageSocketUrl);
  const pending = new Map();
  const consoleErrors = [];
  let nextId = 1;
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
      return;
    }
    if (
      message.method === 'Runtime.exceptionThrown' ||
      (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error')
    ) {
      consoleErrors.push(JSON.stringify(message.params).slice(0, 600));
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });

  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('the DevTools socket failed')), {
      once: true,
    });
  });
  try {
    await send('Runtime.enable');
    let result = null;
    for (let attempt = 0; attempt < 5 && !result; attempt += 1) {
      try {
        result = await send('Runtime.evaluate', {
          expression: WAIT_EXPRESSION,
          awaitPromise: true,
          returnByValue: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('Execution context was destroyed')) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    if (!result) return { error: 'the page execution context was destroyed repeatedly' };
    if (!result?.result) return { error: 'the page evaluation returned nothing' };
    if (result.result.subtype === 'error') {
      return { error: `the page failed: ${result.result.description ?? 'unknown error'}` };
    }
    const report = result.result.value;
    if (report && report.error && consoleErrors.length > 0) {
      report.console = consoleErrors.slice(0, 4);
    }
    return report ?? { error: 'the page evaluated to nothing' };
  } finally {
    socket.close();
    child.kill('SIGKILL');
    rmSync(profile, { recursive: true, force: true });
  }
}

/** `12.34` padded for a stable column. */
function ms(value) {
  return value === null || value === undefined ? '   n/a' : value.toFixed(2).padStart(6);
}

/** Print one size's table and return the report. */
function printSize(label, report) {
  if (report.error) {
    console.log(`  FAIL  ${label}: ${report.error}`);
    if (report.console) for (const entry of report.console) console.log(`    console: ${entry}`);
    return null;
  }
  const backend = report.backend;
  const stats = report.stats;
  console.log(
    `  ${label}: canvas ${report.options.width} x ${report.options.height} @ dpr ${report.options.dpr}` +
      ` -> drawing buffer ${backend.drawingBuffer[0]} x ${backend.drawingBuffer[1]}` +
      ` (${(backend.drawingBufferPixels / 1e6).toFixed(2)} MP)`,
  );
  console.log(
    `    renderer: ${backend.renderer}`,
  );
  console.log(
    `    tier ${stats.tier}, MSAA ${backend.contextAttributes.antialias ? 'on' : 'off'}` +
      `, ${stats.instances} instances, ${stats.drawCalls} draw calls, ${stats.triangles} triangles` +
      `, relief ${stats.relief} (${stats.reliefVerification ?? 'n/a'})`,
  );
  console.log(
    `    live steps depth ${stats.pomSteps} / shadow ${stats.shadowSteps}` +
      `, timer query ${backend.timerQuery ? 'yes' : 'NO (wall clock only)'}` +
      `, warm ${report.options.warmup}, measured ${report.options.samples} frames per step in batches of ${report.options.batch}`,
  );
  console.log(
    '    steps   GPU p50   GPU p95   GPU min   GPU max   vs 0 steps   submit   headroom',
  );
  for (const row of report.results) {
    const gpu = row.gpu;
    const submit = row.submit;
    const headroom = gpu === null ? null : report.frameBudgetMs - gpu.median;
    console.log(
      `    ${String(row.steps).padStart(5)}   ${ms(gpu?.median)} ms  ${ms(gpu?.p95)} ms  ` +
        `${ms(gpu?.min)} ms  ${ms(gpu?.max)} ms  ${ms(row.vsZero)} ms  ` +
        `${ms(submit?.median)} ms  ${headroom === null ? '   n/a' : `${headroom.toFixed(2).padStart(6)} ms`}`,
    );
  }
  console.log(
    `    60 fps budget is ${report.frameBudgetMs.toFixed(2)} ms; headroom is that minus the median.`,
  );
  return report;
}

async function main() {
  const chrome = chromeBinary();
  if (!chrome) throw new Error('no Chrome/Chromium found; set CHROME=/path/to/chrome');

  console.log('3D POM cost measurement (3D-S1)\n');
  mkdirSync(keepOut, { recursive: true });
  const { server, origin } = await startServer();
  const reports = [];
  try {
    for (const size of sizes) {
      const query = new URLSearchParams({
        w: String(size.width),
        h: String(size.height),
        dpr: String(size.dpr),
        tier,
        steps,
        samples,
        batch,
        ramp,
      });
      if (shadow !== null) query.set('shadow', shadow);
      const url = `${origin}/scripts/pom-probe.html?${query.toString()}`;
      const label = `${size.width}x${size.height}@${size.dpr}`;
      const report = await renderReport(chrome, url, 120_000);
      printSize(label, report);
      if (!report.error) {
        const file = join(keepOut, `pom-${label.replace(/[^a-z0-9]+/gi, '-')}.json`);
        writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
        console.log(`    json: ${file}`);
        reports.push({ label, report });
      }
      console.log();
    }
  } finally {
    await server.close();
  }

  if (reports.length === 0) {
    console.log('pom measurement: FAIL (no size reported numbers)');
    process.exitCode = 1;
    return;
  }
  console.log(
    `pom measurement: ${reports.length}/${sizes.length} sizes measured` +
      (swiftshader ? ' (SwiftShader software control)' : ' (real GPU requested via ANGLE/GL)'),
  );
}

main().catch((error) => {
  console.error(`pom measurement: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
