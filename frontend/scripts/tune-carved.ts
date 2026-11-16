/**
 * Local tuner for the carved decal's LYING light rig.
 *
 *   cd frontend && npm run tune:carved     # then open http://localhost:7458
 *
 * The shell bodies are rendered ONCE by the existing shell baker with the
 * existing shell/table lighting, not with the decal rig. This tuner previews
 * the four face-up orientations the player actually sees — the four discard
 * rivers — using one properly rotated shell for each:
 *
 *   0°   shell_flat_upright       bottom river
 *   90°  shell_flat_sideways      right river
 *   180° shell_flat_upright_180   top river
 *   270° shell_flat_sideways_270  left river
 *
 * The decal lighting is separate: each shell picks the lying decal whose baked
 * light rotation is `-quadRotation`, so the room light stays fixed in screen
 * space. The sliders below edit only `lighting.lying`; the upright rig and the
 * shell lighting are never touched. "Render preview" rebakes only the decals
 * (about 3 s) and composites them onto the cached shell bodies.
 *
 * This is a developer tool: it is never bundled or shipped.
 */
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { decalKey, parseDecalsManifest } from '../src/table/decalManifest';
import type { DecalRotation, DecalsManifest } from '../src/table/decalManifest';
import {
  normalizeRotationDeg,
  parseShellsManifest,
  screenRotationOfQuad,
} from '../src/table/shellManifest';
import type { ShellStats } from '../src/table/shellManifest';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const frontendDir = resolve(scriptDir, '..');
const repoDir = resolve(frontendDir, '..');
const renderDir = resolve(repoDir, 'tools/render');
const decalSpecPath = resolve(renderDir, 'decal-spec.json');
const tuneDir = resolve(renderDir, 'build/tune');
const tuneSpecPath = join(tuneDir, 'decal-spec.json');
const tuneManifestPath = join(tuneDir, 'decals.json');
const previewDir = join(tuneDir, 'preview');
const shellPreviewRoot = resolve(renderDir, 'build/preview');
const shellPreviewManifest = join(shellPreviewRoot, 'shells.json');
const blender = process.env.BLENDER ?? '/home/kylehipke/.local/opt/blender-4.5.9/blender';
const port = Number(process.env.PORT ?? 7458);
const host = process.env.HOST ?? '127.0.0.1';
const face = process.env.TUNE_FACE ?? '1m';

/** The four face-up orientations, one real shell each. */
const SHELL_ORIENTATIONS = [
  { rotation: 0, shell: 'shell_flat_upright', label: 'bottom river · 0°' },
  { rotation: 90, shell: 'shell_flat_sideways', label: 'right river · 90°' },
  { rotation: 180, shell: 'shell_flat_upright_180', label: 'top river · 180°' },
  { rotation: 270, shell: 'shell_flat_sideways_270', label: 'left river · 270°' },
] as const;

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
    const az = num(entry.azimuthDeg, 0);
    const el = num(entry.elevationDeg, 0);
    const normal = Math.cos((az * Math.PI) / 180) * Math.cos((el * Math.PI) / 180);
    const fallbackTilt = (Math.acos(Math.max(-1, Math.min(1, normal))) * 180) / Math.PI;
    const fallbackAround =
      (Math.atan2(Math.sin((az * Math.PI) / 180) * Math.cos((el * Math.PI) / 180), Math.sin((el * Math.PI) / 180)) *
        180) /
      Math.PI;
    lights[String(entry.id)] = {
      aroundDeg: num(entry.aroundDeg, (fallbackAround + 360) % 360),
      tiltDeg: num(entry.tiltDeg, fallbackTilt),
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
    entry.aroundDeg = clamp(num(update.aroundDeg, num(entry.aroundDeg, 0)), 0, 360);
    entry.tiltDeg = clamp(num(update.tiltDeg, num(entry.tiltDeg, 0)), 0, 180);
    delete entry.azimuthDeg;
    delete entry.elevationDeg;
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

function previewShellsReady(): boolean {
  if (!existsSync(shellPreviewManifest)) return false;
  try {
    const parsed = parseShellsManifest(JSON.parse(readFileSync(shellPreviewManifest, 'utf8')));
    return SHELL_ORIENTATIONS.every(({ shell }) => Boolean(parsed.shells[shell]));
  } catch {
    return false;
  }
}

let shellPromise: Promise<void> | null = null;

/** Render the four flat shell orientations once, with the existing shell rig. */
function ensurePreviewShells(): Promise<void> {
  if (previewShellsReady()) return Promise.resolve();
  if (shellPromise) return shellPromise;
  shellPromise = (async () => {
    const args = [
      '--background',
      '--python-exit-code',
      '1',
      '--python',
      join(renderDir, 'bake_shells.py'),
      '--',
      '--bake',
      '--preview',
    ];
    for (const { shell } of SHELL_ORIENTATIONS) args.push('--only', shell);
    console.log('[tune-carved] rendering the four flat shell orientations once');
    const result = await run(blender, args, renderDir);
    if (result.code !== 0) {
      shellPromise = null;
      throw new Error(result.output.slice(-6000));
    }
    console.log('[tune-carved] shell orientations ready');
  })();
  return shellPromise;
}

async function loadNapi(path: string): Promise<Awaited<ReturnType<typeof loadImage>>> {
  return loadImage(readFileSync(path));
}

function drawDecal(
  ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>,
  shell: ShellStats,
  decal: { facePlateRect: readonly [number, number, number, number] },
  decalImage: Awaited<ReturnType<typeof loadImage>>,
  scale: number,
): void {
  const quad = shell.faceQuad.map(([x, y]) => [x * scale, y * scale] as const);
  const [u0, v0, u1, v1] = decal.facePlateRect;
  const point = (u: number, v: number): readonly [number, number] => [
    quad[0][0] + u * (quad[1][0] - quad[0][0]) + v * (quad[3][0] - quad[0][0]),
    quad[0][1] + u * (quad[1][1] - quad[0][1]) + v * (quad[3][1] - quad[0][1]),
  ];
  const origin = point(u0, v0);
  const right = point(u1, v0);
  const down = point(u0, v1);
  const sourceX = u0 * decalImage.width;
  const sourceY = v0 * decalImage.height;
  const sourceWidth = (u1 - u0) * decalImage.width;
  const sourceHeight = (v1 - v0) * decalImage.height;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(quad[0][0], quad[0][1]);
  ctx.lineTo(quad[1][0], quad[1][1]);
  ctx.lineTo(quad[2][0], quad[2][1]);
  ctx.lineTo(quad[3][0], quad[3][1]);
  ctx.closePath();
  ctx.clip();
  const a = (right[0] - origin[0]) / sourceWidth;
  const b = (right[1] - origin[1]) / sourceWidth;
  const c = (down[0] - origin[0]) / sourceHeight;
  const d = (down[1] - origin[1]) / sourceHeight;
  ctx.setTransform(a, b, c, d, origin[0], origin[1]);
  ctx.drawImage(
    decalImage as unknown as never,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    sourceWidth,
    sourceHeight,
  );
  ctx.restore();
}

async function composePreviews(decalSet: DecalsManifest): Promise<
  Array<{ rotation: DecalRotation; shell: string; label: string; url: string }>
> {
  await ensurePreviewShells();
  const shells = parseShellsManifest(JSON.parse(readFileSync(shellPreviewManifest, 'utf8')));
  mkdirSync(previewDir, { recursive: true });
  const previews: Array<{ rotation: DecalRotation; shell: string; label: string; url: string }> = [];
  for (const orientation of SHELL_ORIENTATIONS) {
    const shell = shells.shells[orientation.shell];
    if (!shell) throw new Error(`preview shell ${orientation.shell} is missing`);
    const quadRotation = screenRotationOfQuad(shell.faceQuad);
    const light = normalizeRotationDeg(-quadRotation);
    const symbol = normalizeRotationDeg(shell.faceRotationDeg - quadRotation);
    const record = decalSet.decals[decalKey(face as never, 'lying', light, symbol)];
    if (!record) {
      throw new Error(
        `no lying decal for ${face} light ${light} symbol ${symbol} (${orientation.shell})`,
      );
    }
    const shellImage = await loadNapi(join(shellPreviewRoot, shell.textureFile2x));
    const decalImage = await loadNapi(join(tuneDir, record.textureFile));
    const canvas = createCanvas(shell.texWidth * 2, shell.texHeight * 2);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(shellImage as unknown as never, 0, 0);
    drawDecal(ctx, shell, record, decalImage, 2);
    const fileName = `flat-${orientation.rotation}.png`;
    writeFileSync(join(previewDir, fileName), canvas.toBuffer('image/png'));
    previews.push({
      rotation: orientation.rotation,
      shell: orientation.shell,
      label: orientation.label,
      url: `/preview/${fileName}?v=${Date.now()}`,
    });
  }
  return previews;
}

let busy = false;

async function renderPreview(params: Params): Promise<{
  elapsed: string;
  log: string[];
  previews: Array<{ rotation: DecalRotation; shell: string; label: string; url: string }>;
}> {
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
  const previews = await composePreviews(decalSet);
  return {
    elapsed: ((Date.now() - started) / 1000).toFixed(1),
    log: render.output
      .split('\n')
      .filter((line) => line.includes('[shells]') || line.includes('Saved:'))
      .slice(-8),
    previews,
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

function statePreviews() {
  return SHELL_ORIENTATIONS.map(({ rotation, shell, label }) => ({
    rotation,
    shell,
    label,
    url: `/preview/flat-${rotation}.png?v=${Date.now()}`,
    exists: existsSync(join(previewDir, `flat-${rotation}.png`)),
  }));
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
        shellsReady: previewShellsReady(),
        previews: statePreviews(),
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/shells') {
      shellPromise = null;
      try {
        await ensurePreviewShells();
        sendJson(response, 200, { ok: true, previews: statePreviews() });
      } catch (error) {
        sendJson(response, 500, {
          ok: false,
          error: String((error as Error)?.message ?? error).slice(-6000),
        });
      }
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
        sendJson(response, 200, { ok: true, ...result });
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
      const name = url.pathname.slice('/preview/'.length);
      const file = join(previewDir, name);
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

server.listen(port, host, () => {
  console.log(`[tune-carved] lying decal tuner at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  if (!existsSync(blender)) console.warn(`[tune-carved] Blender not found at ${blender}`);
  // Start the one-time shell render early so the first preview is quick.
  void ensurePreviewShells().catch((error) => console.error('[tune-carved] shell render failed', error));
});
