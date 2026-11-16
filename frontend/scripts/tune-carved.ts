/**
 * Local tuner for the carved decal's LYING light rig.
 *
 *   cd frontend && npm run tune:carved     # then open http://localhost:7458
 *
 * Serves a small browser UI. "Render preview" writes a temporary decal spec,
 * runs the real Blender decal baker for the `1m` face with the lying rig at
 * four light rotations (0/90/180/270), then composites each result onto the
 * current `shell_flat_upright` through the real `TileAtlasBuilder`. "Apply lying
 * params" writes only `lighting.lying` (and the shared carve controls) back to
 * `tools/render/decal-spec.json`; the upright rig is never touched.
 *
 * This is a developer tool: it is never bundled or shipped.
 */
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { parseDecalsManifest } from '../src/table/decalManifest';
import type { DecalRotation, DecalsManifest } from '../src/table/decalManifest';
import { parseFacesManifest } from '../src/table/faceManifest';
import { parseShellsManifest } from '../src/table/shellManifest';
import { TileAtlasBuilder } from '../src/table/TileAtlasBuilder';
import type { AtlasCanvas, AtlasImage } from '../src/table/TileAtlasBuilder';
import { tileRenderKey } from '../src/table/tiles';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const frontendDir = resolve(scriptDir, '..');
const repoDir = resolve(frontendDir, '..');
const renderDir = resolve(repoDir, 'tools/render');
const tableDir = resolve(frontendDir, 'public/table');
const decalSpecPath = resolve(renderDir, 'decal-spec.json');
const tuneDir = resolve(renderDir, 'build/tune');
const tuneSpecPath = join(tuneDir, 'decal-spec.json');
const tuneManifestPath = join(tuneDir, 'decals.json');
const previewDir = join(tuneDir, 'preview');
const blender = process.env.BLENDER ?? '/home/kylehipke/.local/opt/blender-4.5.9/blender';
const port = Number(process.env.PORT ?? 7458);
const face = process.env.TUNE_FACE ?? '1m';
const rotations: DecalRotation[] = [0, 90, 180, 270];

const shells = parseShellsManifest(JSON.parse(readFileSync(join(tableDir, 'shells.json'), 'utf8')));
const faces = parseFacesManifest(JSON.parse(readFileSync(join(tableDir, 'faces.json'), 'utf8')));

type Params = Record<string, number | string | Record<string, Record<string, number>>>;
type LightParams = Record<string, number>;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const num = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

function readSpec(): Record<string, unknown> {
  return JSON.parse(readFileSync(decalSpecPath, 'utf8')) as Record<string, unknown>;
}

function currentParams(): Params {
  const spec = readSpec();
  const lying = (spec as { lighting: { lying: Record<string, unknown> } }).lighting.lying;
  const carve = (spec as { carve: Record<string, unknown> }).carve;
  const lights: Record<string, LightParams> = {};
  for (const entry of lying.lights as Record<string, unknown>[]) {
    lights[String(entry.id)] = {
      azimuthDeg: num(entry.azimuthDeg, 0),
      elevationDeg: num(entry.elevationDeg, 0),
      energyW: num(entry.energyW, 0),
      size: num(entry.size, 10),
      sizeY: num(entry.sizeY, 10),
      rollDeg: num(entry.rollDeg ?? 0, 0),
    };
  }
  return {
    lights,
    worldStrength: num((lying.world as Record<string, unknown>).strength, 0.4),
    depth: num(carve.depthFractionOfThickness, 0.0121),
    topSpread: num((carve.profile as Record<string, unknown>).topSpread, 0.6),
    bottomSpread: num((carve.profile as Record<string, unknown>).bottomSpread, 0.8),
    blurMm: num(carve.blurUnits, 0.0042857) * 28,
    transitionMm: num(carve.transitionUnits, 0.010714) * 28,
    paintEdge: num(carve.paintEdge, 0.18),
    occlusionStrength: num(carve.occlusionStrength, 0.75),
    occlusionDistance: num(carve.occlusionDistance, 0.2),
    samples: 48,
    gridScale: 0.6,
    occlusionSamples: 4,
  };
}

function applyParams(spec: Record<string, unknown>, params: Params, preview: boolean): void {
  const lying = (spec as { lighting: { lying: Record<string, unknown> } }).lighting.lying;
  const lights = params.lights as Record<string, Record<string, number>>;
  for (const entry of lying.lights as Record<string, unknown>[]) {
    const update = lights[String(entry.id)];
    if (!update) continue;
    entry.azimuthDeg = clamp(num(update.azimuthDeg, num(entry.azimuthDeg, 0)), 0, 360);
    entry.elevationDeg = clamp(num(update.elevationDeg, num(entry.elevationDeg, 0)), 0, 89);
    entry.energyW = clamp(num(update.energyW, num(entry.energyW, 0)), 0, 300000);
    if ('size' in update) {
      entry.size = clamp(num(update.size, num(entry.size, 10)), 2, 80);
      entry.sizeY = clamp(num(update.sizeY, num(entry.sizeY, 10)), 0.5, 80);
    }
    if ('rollDeg' in update) entry.rollDeg = clamp(num(update.rollDeg, 0), 0, 180);
  }
  (lying.world as Record<string, unknown>).strength = clamp(
    num(params.worldStrength, 0.4),
    0,
    2,
  );

  const carve = (spec as { carve: Record<string, unknown> }).carve;
  const profile = carve.profile as Record<string, unknown>;
  const mmPerUnit = 28;
  carve.depthFractionOfThickness = clamp(num(params.depth, 0.0121), 0, 0.03);
  profile.topSpread = clamp(num(params.topSpread, 0.6), 0, 1);
  profile.bottomSpread = clamp(num(params.bottomSpread, 0.8), 0, 1);
  carve.blurUnits = clamp(num(params.blurMm, 0.12), 0.02, 0.6) / mmPerUnit;
  carve.transitionUnits = clamp(num(params.transitionMm, 0.3), 0.02, 1.6) / mmPerUnit;
  carve.paintEdge = clamp(num(params.paintEdge, 0.18), 0, 1);
  carve.occlusionStrength = clamp(num(params.occlusionStrength, 0.75), 0, 1);
  carve.occlusionDistance = clamp(num(params.occlusionDistance, 0.2), 0.01, 2);

  if (preview) {
    spec.previewSamples = Math.round(clamp(num(params.samples, 48), 8, 128));
    carve.gridScale = clamp(num(params.gridScale, 0.6), 0.3, 1);
    carve.occlusionSamples = Math.round(clamp(num(params.occlusionSamples, 4), 1, 16));
    (spec as { output: Record<string, unknown> }).output.buildDir = 'build/tune/decals';
    (spec as { output: Record<string, unknown> }).output.buildManifest = 'build/tune/decals.json';
  }
}

function run(command: string, args: string[], cwd: string): Promise<{ code: number; output: string }> {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('close', (code) => done({ code: code ?? -1, output }));
    child.on('error', (error) => done({ code: -1, output: String(error) }));
  });
}

async function loadNapi(url: string): Promise<AtlasImage> {
  return (await loadImage(readFileSync(url))) as unknown as AtlasImage;
}

async function composePreviews(decalSet: DecalsManifest): Promise<void> {
  mkdirSync(previewDir, { recursive: true });
  for (const rotation of rotations) {
    const builder = new TileAtlasBuilder({
      shells,
      faces,
      decals: decalSet,
      resolveUrl: (relativePath) =>
        relativePath.startsWith('decals/') ? join(tuneDir, relativePath) : join(tableDir, relativePath),
      loadImage: loadNapi,
      createCanvas: (width, height) => createCanvas(width, height) as unknown as AtlasCanvas,
      pixelRatio: 2,
      forceDecalLightRotationDeg: rotation,
    });
    const atlas = await builder.build(['shell_flat_upright']);
    const sprite = atlas.sprites.get(tileRenderKey('shell_flat_upright', face as never));
    if (!sprite) throw new Error(`no sprite for ${face}`);
    const page = atlas.pages[sprite.pageIndex];
    const zoom = 2;
    const canvas = createCanvas(sprite.uv.width * zoom, sprite.uv.height * zoom);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      page.canvas as unknown as never,
      sprite.uv.x,
      sprite.uv.y,
      sprite.uv.width,
      sprite.uv.height,
      0,
      0,
      sprite.uv.width * zoom,
      sprite.uv.height * zoom,
    );
    writeFileSync(join(previewDir, `preview-${rotation}.png`), canvas.toBuffer('image/png'));
  }
}

let busy = false;

async function renderPreview(params: Params): Promise<{ elapsed: string; log: string[] }> {
  const started = Date.now();
  const spec = readSpec();
  applyParams(spec, params, true);
  mkdirSync(tuneDir, { recursive: true });
  writeFileSync(tuneSpecPath, JSON.stringify(spec, null, 2) + '\n');

  const render = await run(
    blender,
    [
      '--background',
      '--python-exit-code',
      '1',
      '--python',
      join(renderDir, 'bake_decals.py'),
      '--',
      '--spec',
      tuneSpecPath,
      '--build',
      '--surface',
      'lying',
      '--only',
      face,
      '--rotations',
      '0,90,180,270',
    ],
    renderDir,
  );
  if (render.code !== 0) throw new Error(render.output.slice(-6000));
  if (!existsSync(tuneManifestPath)) throw new Error('the preview bake wrote no manifest');
  const decalSet = parseDecalsManifest(JSON.parse(readFileSync(tuneManifestPath, 'utf8')));
  await composePreviews(decalSet);
  return {
    elapsed: ((Date.now() - started) / 1000).toFixed(1),
    log: render.output
      .split('\n')
      .filter((line) => line.includes('[shells]') || line.includes('Saved:'))
      .slice(-8),
  };
}

function readBody(request: http.IncomingMessage): Promise<Params> {
  return new Promise((done, fail) => {
    let data = '';
    request.on('data', (chunk) => (data += chunk));
    request.on('end', () => {
      try {
        done(JSON.parse(data || '{}') as Params);
      } catch (error) {
        fail(error);
      }
    });
  });
}

function sendJson(response: http.ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://localhost:${port}`);
  try {
    if (request.method === 'GET' && url.pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(readFileSync(join(scriptDir, 'tune-carved.html')));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/state') {
      sendJson(response, 200, {
        params: currentParams(),
        face,
        blender,
        blenderFound: existsSync(blender),
        previews: rotations.map((rotation) => ({
          rotation,
          url: `/preview/${rotation}.png?v=${Date.now()}`,
          exists: existsSync(join(previewDir, `preview-${rotation}.png`)),
        })),
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/render') {
      if (busy) {
        sendJson(response, 409, { ok: false, error: 'a render is already running' });
        return;
      }
      busy = true;
      try {
        const params = await readBody(request);
        console.log('[tune-carved] preview render');
        const result = await renderPreview(params);
        console.log(`[tune-carved] preview done in ${result.elapsed}s`);
        sendJson(response, 200, {
          ok: true,
          elapsed: result.elapsed,
          log: result.log,
          previews: rotations.map((rotation) => ({
            rotation,
            url: `/preview/${rotation}.png?v=${Date.now()}`,
          })),
        });
      } catch (error) {
        console.error('[tune-carved] preview failed');
        sendJson(response, 500, {
          ok: false,
          error: String((error as Error)?.message ?? error).slice(-6000),
        });
      } finally {
        busy = false;
      }
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/apply') {
      const params = await readBody(request);
      const spec = readSpec();
      applyParams(spec, params, false);
      writeFileSync(decalSpecPath, JSON.stringify(spec, null, 2) + '\n');
      console.log('[tune-carved] applied the lying params to decal-spec.json');
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method === 'GET' && url.pathname.startsWith('/preview/')) {
      const file = join(previewDir, url.pathname.slice('/preview/'.length));
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
    console.error('[tune-carved] request failed', error);
    sendJson(response, 500, { ok: false, error: String((error as Error)?.message ?? error) });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[tune-carved] lying decal tuner at http://localhost:${port}`);
  if (!existsSync(blender)) console.warn(`[tune-carved] Blender not found at ${blender}`);
});
