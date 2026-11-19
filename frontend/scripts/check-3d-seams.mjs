#!/usr/bin/env node
/**
 * The 3D seam gate (3D-20): render the board in headless Chrome and print the
 * numbers the white-seam defect is made of.
 *
 *   node frontend/scripts/check-3d-seams.mjs            # MSAA on and off, three sizes
 *   node frontend/scripts/check-3d-seams.mjs --aa=0      # one MSAA setting
 *   node frontend/scripts/check-3d-seams.mjs --debug=albedo --png
 *
 * AGENTS.md §6: this is the numeric half of the acceptance. It serves
 * `scripts/seam-probe.html` through the frontend's own Vite install (no new
 * package), drives it with whatever Chrome is installed, and reads the JSON the
 * page publishes after a real `readPixels` scanline across four seams between
 * touching tiles (`seamProbe.ts`). It never inspects an image: a seam passes when
 * **no** pixel in its core reads as the felt or the clear colour (the see-through
 * defect), and the gate separately measures how much smaller MSAA makes the
 * largest one-pixel step on the hand's silhouette.
 *
 * Requirements: Chrome/Chromium on PATH (or `CHROME=/path/to/chrome`) and
 * `npm ci` in frontend/. Software WebGL2 (SwiftShader) is enough and is what
 * `--headless=new` uses here, so the numbers are GPU-independent — they check
 * geometry and coverage, not a driver.
 *
 * Exit code: 0 when every seam passes on every variant that was asked for, 1
 * otherwise (including "the page never became ready").
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
const explicitAa = options.get('aa') ?? null;
const debug = options.get('debug') ?? null;
const wantPng = options.has('png');
const keepOut = options.get('out') ?? '/tmp/opencode/seam-probe';

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
      'this gate loads the app through the frontend\u2019s own Vite install; run `npm ci` in frontend/ first',
    );
  }
  // A real HTTP server (not middleware mode) so Chrome can fetch the module
  // graph: `seam-probe.html` imports `.ts` files Vite transforms on request.
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
    if (window.__seamReport) resolve(window.__seamReport);
    else if (Date.now() - started > 90000) resolve({ error: 'the page did not publish a report within 90 s' });
    else setTimeout(tick, 100);
  };
  tick();
})`;

/**
 * Drive Chrome over the DevTools protocol and return the page's report.
 *
 * `--dump-dom` cannot wait for an async WebGL scene (its virtual clock does not
 * include texture loading), so the gate talks to Chrome directly: spawn with a
 * debugging port, connect to the page target's WebSocket (Node's global
 * `WebSocket`), and `Runtime.evaluate` a promise that resolves when the page
 * sets `window.__seamReport`. Console errors are collected and printed if the
 * page never reports.
 */
async function renderReport(chrome, url, timeoutMs) {
  // A fresh profile per run: a killed run leaves a SingletonLock behind and
  // Chrome then refuses to start.
  const profile = mkdtempSync(join(tmpdir(), 'chrome-seam-'));
  const child = spawn(
    chrome,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu-sandbox',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--window-size=1920,1080',
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

  // `DevTools listening on` is the *browser* target; `Runtime.*` lives on the
  // page target, so ask the HTTP endpoint for it and retry while the page is
  // still being created.
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
    // Vite's dep optimiser can reload the page once on a cold start, which
    // destroys the execution context mid-evaluate; retry rather than fail.
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

function formatLuma(values) {
  return values.map((value) => String(Math.round(value)).padStart(4, ' ')).join('');
}

/** Print one variant's seams and return its pass count. */
function printVariant(label, report) {
  if (report.error) {
    console.log(`  FAIL  ${label}: ${report.error}`);
    return { ok: false, pass: 0, total: 0 };
  }
  const seams = report.seams;
  if (!seams || seams.seams.length === 0) {
    console.log(`  FAIL  ${label}: no seams were measured`);
    return { ok: false, pass: 0, total: 0 };
  }
  const { widthPx, heightPx, antialias, drawCalls } = seams;
  console.log(
    `  ${label}: ${widthPx} x ${heightPx}, MSAA ${antialias ? 'on' : 'off'}, ` +
      `${drawCalls} draw calls, ${report.stats?.instances ?? '?'} instances, ` +
      `relief ${report.stats?.relief ?? '?'} (${report.stats?.reliefVerification ?? '?'})`,
  );
  const glint = report.glint;
  if (glint) {
    const pct = (bucket) =>
      bucket.coverage > 0 ? (100 * bucket.bright) / bucket.coverage : 0;
    console.log(
      `    glint (>= ${glint.threshold} luma): plate ${glint.plate.bright}/${glint.plate.coverage} px` +
        ` (${pct(glint.plate).toFixed(1)} %), ivory band ${glint.ivoryBody.bright}/${glint.ivoryBody.coverage}` +
        ` (${pct(glint.ivoryBody).toFixed(1)} %), blue body ${glint.blueBody.bright}/${glint.blueBody.coverage}` +
        ` (${pct(glint.blueBody).toFixed(3)} %, must be <= 0.100 %) -> ${glint.pass ? 'ok' : 'FAIL'}`,
    );
  } else {
    console.log('    glint: not measured');
  }
  let pass = 0;
  for (const seam of seams.seams) {
    const verdict = seam.pass ? 'ok   ' : 'FAIL ';
    console.log(
      `    ${verdict}${seam.id.padEnd(11)} ${seam.aId} x ${seam.bId}` +
        `  gap ${seam.gapUnits.toFixed(4)} u / span ${seam.spanPx.toFixed(1)} px`,
    );
    console.log(`          luma${formatLuma(seam.luma)}`);
    console.log(
      `          faces ${seam.faceALuma.toFixed(1)} / ${seam.faceBLuma.toFixed(1)}` +
        ` (darker ${seam.faceLuma.toFixed(1)})` +
        `  core ${seam.coreMinLuma.toFixed(1)}..${seam.coreMaxLuma.toFixed(1)} (mean ${seam.coreMeanLuma.toFixed(1)})` +
        `  rim max ${seam.rimMaxLuma.toFixed(1)}`,
    );
    console.log(
      `          leak pixels ${seam.leakPixels} (0 allowed)` +
        `   brightest core rgb ${seam.brightestRgb.join(',')} -> ${seam.brightestClass}` +
        `   contrast ${seam.contrast.toFixed(1)} (information)`,
    );
    if (seam.detail) console.log(`          ${seam.detail}`);
    if (seam.pass) pass += 1;
  }
  const edge = seams.edge;
  if (edge) {
    console.log(
      `    edge ${edge.id}: light ${edge.lightLuma.toFixed(1)} / dark ${edge.darkLuma.toFixed(1)}, ` +
        `mean largest one-pixel step ${edge.maxStep.toFixed(1)} luma over ${edge.lines} lines` +
        ` (worst ${edge.worstStep.toFixed(1)}; ${edge.intermediates.toFixed(1)} intermediate columns)`,
    );
    console.log(`          luma${formatLuma(edge.luma)}`);
  } else {
    console.log('    edge: not measured');
  }
  if (report.png) {
    mkdirSync(keepOut, { recursive: true });
    const file = join(keepOut, `${label.replace(/[^a-z0-9]+/gi, '-')}.png`);
    writeFileSync(file, Buffer.from(report.png.split(',')[1] ?? '', 'base64'));
    console.log(`    artifact: ${file}`);
  }
  const glintOk = report.glint ? report.glint.pass : false;
  const ok = pass === seams.seams.length && glintOk;
  console.log(
    `    verdict: ${pass}/${seams.seams.length} seams have no leak, glint ${glintOk ? 'ok' : 'FAIL'}` +
      ` -> ${ok ? 'ok' : 'FAIL'}`,
  );
  return { ok, pass, total: seams.seams.length };
}

async function main() {
  const chrome = chromeBinary();
  if (!chrome) throw new Error('no Chrome/Chromium found; set CHROME=/path/to/chrome');

  console.log('3D seam gate (3D-20)\n');
  const { server, origin } = await startServer();
  // The sizes the gate measures. 1920 x 1080 is the reference frame the camera
  // was solved against; 1366 x 768 is a laptop and 820 x 1180 a portrait phone,
  // where the tile body is small enough that a 0.3 mm groove is one pixel.
  const sizes = (() => {
    const explicit = options.get('size');
    if (explicit) {
      const match = /^(\d+)x(\d+)(?:@(\d+(?:\.\d+)?))?$/.exec(explicit);
      if (!match) throw new Error(`--size must look like 1920x1080 or 820x1180@2, not ${explicit}`);
      return [[Number(match[1]), Number(match[2]), Number(match[3] ?? 1)]];
    }
    // A desktop window at dpr 1, a laptop window at dpr 1, and a portrait phone
    // at dpr 2 — the cap in `effectiveDevicePixelRatio` allows 2 there, which is
    // what keeps a phone's tile the same number of device pixels.
    return [
      [1920, 1080, 1],
      [1366, 768, 1],
      [820, 1180, 2],
    ];
  })();

  // The committed variants: the same scene at the same size with MSAA off and
  // on. The seam rule is size-independent (a slot is a slot), and the aliasing
  // comparison needs the pair.
  const variants = (() => {
    const list = [];
    for (const [width, height, dpr] of sizes) {
      const states = explicitAa === null ? ['0', '1'] : [explicitAa === '0' ? '0' : '1'];
      for (const aa of states) {
        list.push({
          label: `MSAA ${aa === '0' ? 'off' : 'on'}, ${width}x${height}@${dpr}`,
          aa,
          width,
          height,
          dpr,
        });
      }
    }
    return list;
  })();

  let ok = 0;
  const edges = [];
  try {
    for (const variant of variants) {
      const query = new URLSearchParams({
        aa: variant.aa,
        w: String(variant.width),
        h: String(variant.height),
        dpr: String(variant.dpr),
      });
      if (debug) query.set('debug', debug);
      if (wantPng) query.set('png', '1');
      const url = `${origin}/scripts/seam-probe.html?${query.toString()}`;
      const report = await renderReport(chrome, url, 60_000);
      if (report.console) {
        for (const entry of report.console) console.log(`    console: ${entry}`);
      }
      const result = printVariant(variant.label, report);
      if (result.ok) ok += 1;
      const edge = report.seams?.edge;
      if (edge) {
        edges.push({
          width: variant.width,
          height: variant.height,
          antialias: report.seams.antialias,
          maxStep: edge.maxStep,
        });
      }
      console.log();
    }
  } finally {
    await server.close();
  }

  // The aliasing comparison: at each size, the same scene drawn with and without
  // MSAA. The measure is the largest one-pixel luma step on the human hand's
  // outer silhouette; partial coverage has to shrink it by at least 10 %.
  let aliasOk = true;
  const sizesSeen = [...new Set(edges.map((entry) => `${entry.width}x${entry.height}`))];
  console.log('aliasing (largest one-pixel step on the hand silhouette)');
  for (const size of sizesSeen) {
    // The same scene at the same size: the only difference is MSAA.
    const off = edges.find(
      (entry) => `${entry.width}x${entry.height}` === size && !entry.antialias,
    );
    const on = edges.find(
      (entry) => `${entry.width}x${entry.height}` === size && entry.antialias,
    );
    if (!off || !on) {
      console.log(`  ${size}: needs both an MSAA-off and an MSAA-on run to compare`);
      aliasOk = aliasOk && true;
      continue;
    }
    const reduction = 1 - on.maxStep / off.maxStep;
    const pass = reduction >= 0.1;
    if (!pass) aliasOk = false;
    console.log(
      `  ${pass ? 'ok   ' : 'FAIL '}${size}: ${off.maxStep.toFixed(1)} -> ${on.maxStep.toFixed(1)} luma` +
        ` (${(reduction * 100).toFixed(0)} % smaller, needs >= 10 %)`,
    );
  }
  console.log();

  const all = ok === variants.length && aliasOk;
  console.log(
    `seam gate: ${all ? 'PASS' : 'FAIL'} (${ok}/${variants.length} variants met their expected verdict)`,
  );
  process.exitCode = all ? 0 : 1;
}

main().catch((error) => {
  console.error(`seam gate: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
