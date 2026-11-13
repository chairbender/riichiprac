#!/usr/bin/env node
/**
 * Local parameter tuner for the carved, painted face decal.
 *
 *   node tools/render/tune.mjs        # then open http://localhost:7457
 *
 * Serves a small browser UI with sliders for the carve depth, the independent
 * top/bottom fillet spreads (cubic Bézier control), the blur, the paint edge and
 * the manzu red. "Render preview" writes a fast decal-only spec, rasterises the
 * recoloured symbol and renders just the decal, then shows it. "Apply to spec"
 * writes the values back into scene-spec.json for a full regeneration.
 *
 * This is a developer tool: it is never bundled or shipped.
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const renderDir = resolve(dirname(fileURLToPath(import.meta.url)));
const baseSpecPath = join(renderDir, 'scene-spec.json');
const previewSpecPath = join(renderDir, 'tune-spec.json');
const previewOut = join(renderDir, 'build', 'tune-out');
const uiPath = join(renderDir, 'tune.html');
const blender =
  process.env.BLENDER ?? '/home/kylehipke/.local/opt/blender-4.5.9/blender';
const port = Number(process.env.PORT ?? 7457);

const base = JSON.parse(readFileSync(baseSpecPath, 'utf8'));
const decalFile = base.outputs.decal
  .replace('{code}', base.spike.decal.code)
  .replace('{orientation}', base.spike.decal.orientation);

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const mmPerUnit = base.tile.proportionsMm.height;

function currentParams() {
  const carve = base.decals.carve;
  return {
    depth: carve.depthFractionOfThickness,
    topSpread: carve.profile.topSpread,
    bottomSpread: carve.profile.bottomSpread,
    blurMm: carve.blurUnits * mmPerUnit,
    transitionMm: carve.transitionUnits * mmPerUnit,
    paintEdge: carve.paintEdge,
    paintRed: base.tile.materials.paint.red,
    samples: 48,
    tileThicknessMm: base.tile.proportionsMm.thickness,
    faceHeightMm: mmPerUnit,
  };
}

function buildPreviewSpec(params) {
  const spec = structuredClone(base);
  const carve = spec.decals.carve;
  spec.scene.samples = Math.round(clamp(num(params.samples, 48), 8, 96));
  spec.decals.renderScale = 2;
  carve.depthFractionOfThickness = clamp(
    num(params.depth, carve.depthFractionOfThickness),
    0,
    0.03,
  );
  carve.blurUnits = clamp(num(params.blurMm, carve.blurUnits * mmPerUnit), 0.02, 0.6) / mmPerUnit;
  carve.transitionUnits =
    clamp(num(params.transitionMm, carve.transitionUnits * mmPerUnit), 0.02, 1.6) / mmPerUnit;
  carve.paintEdge = clamp(num(params.paintEdge, carve.paintEdge), 0, 1);
  carve.gridScale = 0.6;
  carve.occlusionSamples = 4;
  carve.profile.topSpread = clamp(
    num(params.topSpread, carve.profile.topSpread),
    0,
    1,
  );
  carve.profile.bottomSpread = clamp(
    num(params.bottomSpread, carve.profile.bottomSpread),
    0,
    1,
  );
  if (/^#[0-9a-f]{6}$/i.test(params.paintRed ?? '')) {
    spec.tile.materials.paint.red = params.paintRed;
  }
  spec.preview = { decalOnly: true };
  return spec;
}

function applyParams(params) {
  const spec = JSON.parse(readFileSync(baseSpecPath, 'utf8'));
  const carve = spec.decals.carve;
  carve.depthFractionOfThickness = clamp(
    num(params.depth, carve.depthFractionOfThickness),
    0,
    0.03,
  );
  carve.blurUnits = clamp(num(params.blurMm, carve.blurUnits * mmPerUnit), 0.02, 0.6) / mmPerUnit;
  carve.transitionUnits =
    clamp(num(params.transitionMm, carve.transitionUnits * mmPerUnit), 0.02, 1.6) / mmPerUnit;
  carve.paintEdge = clamp(num(params.paintEdge, carve.paintEdge), 0, 1);
  carve.profile.topSpread = clamp(
    num(params.topSpread, carve.profile.topSpread),
    0,
    1,
  );
  carve.profile.bottomSpread = clamp(
    num(params.bottomSpread, carve.profile.bottomSpread),
    0,
    1,
  );
  if (/^#[0-9a-f]{6}$/i.test(params.paintRed ?? '')) {
    spec.tile.materials.paint.red = params.paintRed;
  }
  writeFileSync(baseSpecPath, JSON.stringify(spec, null, 2) + '\n');
}

function run(command, args) {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd: renderDir });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('close', (code) => done({ code, output }));
    child.on('error', (error) => done({ code: -1, output: String(error) }));
  });
}

let busy = false;

async function renderPreview(params) {
  mkdirSync(previewOut, { recursive: true });
  writeFileSync(previewSpecPath, JSON.stringify(buildPreviewSpec(params), null, 2) + '\n');

  const raster = await run(process.execPath, [
    join(renderDir, 'scripts', 'rasterize-face.mjs'),
    previewSpecPath,
  ]);
  if (raster.code !== 0) throw new Error(raster.output);

  const render = await run(blender, [
    '--background',
    '--python-exit-code',
    '1',
    '--python',
    join(renderDir, 'build_and_render.py'),
    '--',
    previewSpecPath,
    previewOut,
  ]);
  if (render.code !== 0) throw new Error(render.output);
  return render.output;
}

function readBody(request) {
  return new Promise((done, fail) => {
    let data = '';
    request.on('data', (chunk) => (data += chunk));
    request.on('end', () => {
      try {
        done(JSON.parse(data || '{}'));
      } catch (error) {
        fail(error);
      }
    });
  });
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://localhost:${port}`);

  try {
    if (request.method === 'GET' && url.pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(readFileSync(uiPath));
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/state') {
      sendJson(response, 200, {
        params: currentParams(),
        blender,
        blenderFound: existsSync(blender),
        decal: `/decal.png?v=${Date.now()}`,
        decalExists: existsSync(join(previewOut, decalFile)),
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/render') {
      if (busy) {
        sendJson(response, 409, { ok: false, error: 'a render is already running' });
        return;
      }
      const params = await readBody(request);
      busy = true;
      const started = Date.now();
      console.log(`[tune] preview render with ${JSON.stringify(params)}`);
      try {
        const output = await renderPreview(params);
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        console.log(`[tune] preview done in ${elapsed}s`);
        sendJson(response, 200, {
          ok: true,
          elapsed,
          decal: `/decal.png?v=${Date.now()}`,
          log: output.split('\n').filter((line) => line.includes('[render]')).slice(-6),
        });
      } catch (error) {
        console.error('[tune] preview failed');
        sendJson(response, 500, {
          ok: false,
          error: String(error?.message ?? error).slice(-4000),
        });
      } finally {
        busy = false;
      }
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/apply') {
      const params = await readBody(request);
      applyParams(params);
      console.log('[tune] applied parameters to scene-spec.json');
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/decal.png') {
      const file = join(previewOut, decalFile);
      if (!existsSync(file)) {
        response.writeHead(404);
        response.end('render a preview first');
        return;
      }
      response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      createReadStream(file).pipe(response);
      return;
    }

    response.writeHead(404);
    response.end('not found');
  } catch (error) {
    console.error('[tune] request failed', error);
    sendJson(response, 500, { ok: false, error: String(error?.message ?? error) });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[tune] open http://localhost:${port}`);
  if (!existsSync(blender)) {
    console.warn(`[tune] Blender not found at ${blender}; set BLENDER=...`);
  }
});
