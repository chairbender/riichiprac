#!/usr/bin/env node
/**
 * 3D performance budget gate (3D-13).
 *
 *   cd frontend && npm run build && node scripts/check-3d-budget.mjs
 *   node scripts/check-3d-budget.mjs --dist=dist     # explicit build directory
 *
 * Prints the numbers the plan's budget is made of and exits non-zero when one
 * of them drifts:
 *
 * - the three committed carve atlases exist in the build, and their byte count,
 *   dimensions and SHA-256 match both `table/relief3d.json` and the pins the
 *   app ships (`three/reliefAssets.ts`);
 * - the atlas upload bytes per tier, the tier backing-store/DPR budgets and the
 *   MSAA buffer cost (printed; the published §2.8 atlas totals are pinned);
 * - the instanced tile capacity, the full/widest board instance counts and the
 *   tile/full-board triangle counts against the 600/200 k ceilings;
 * - the steady-state draw-call plan against the hard ceiling of 12;
 * - the lazy 3D chunk: it exists, the entry reaches it only through a dynamic
 *   `import()`, `three` appears in no other chunk, and its gzip size is reported
 *   against the advisory 200 KB (over advisory is a warning, never a failure).
 *
 * The plan's wording says "must match `relief.json`"; that file predates 3D-17,
 * which moved the carve bake to `relief3d/` + `relief3d.json`. The manifest
 * contract (`version`, `raster`, `atlases`, `faces`) is the same, and
 * `relief3d.json` is the committed source of truth today.
 *
 * Dependency-free: no package is added. Values that must agree with the app are
 * loaded from the app's own TypeScript through the frontend's existing Vite
 * install (the same technique as `check-3d-layout.mjs`); the rest is Node
 * `fs`/`crypto`/`zlib` over `dist/`.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const FRONTEND_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The hard draw-call ceiling including debug views (plan §2.8). */
const DRAW_CALL_CEILING = 12;

/** The steady-state draw count the plan states (tiles, shadows, sticks, plate, felt). */
const STEADY_STATE_DRAW_CALLS = 5;

/** The full-board triangle ceiling (plan §2.8). */
const BOARD_TRIANGLE_CEILING = 200_000;

/** The advisory lazy-chunk gzip budget; over it is printed as a warning (plan §6, 3D-13). */
const LAZY_CHUNK_GZIP_ADVISORY = 200_000;

/**
 * The published atlas GPU totals (§2.8/§2.5 arithmetic): 58.5 MB at full upload
 * (high and balanced share it) and 14.6 MB at the compat half-resolution
 * upload. Pinned so a raster or mip-policy change is a deliberate edit here.
 */
const PUBLISHED_ATLAS_GPU_BYTES = {
  high: 58_490_880,
  balanced: 58_490_880,
  compat: 14_622_720,
};

/** Three.js's own strings. Minification keeps them, and the app never contains them. */
const THREE_MARKERS = [/THREE\.WebGLRenderer/, /THREE\.WebGLProgram/];

const failures = [];
const warnings = [];

function check(label, ok, detail = '') {
  if (ok) {
    console.log(`  ok    ${label}${detail ? `  ${detail}` : ''}`);
  } else {
    console.log(`  FAIL  ${label}${detail ? `  ${detail}` : ''}`);
    failures.push(label);
  }
}

function warn(label, detail = '') {
  console.log(`  WARN  ${label}${detail ? `  ${detail}` : ''}`);
  warnings.push(label);
}

function number(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function bytes(value) {
  const mb = value / 1_000_000;
  return `${number(value)} B (${mb.toFixed(2)} MB)`;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function formatFlags(argv) {
  const options = new Map();
  for (const argument of argv) {
    const match = /^--([a-zA-Z-]+)(?:=(.*))?$/.exec(argument);
    if (match) options.set(match[1], match[2] ?? 'true');
  }
  return options;
}

/** Load the pure app modules whose constants the gate must agree with. */
async function loadModules() {
  let createServer;
  try {
    ({ createServer } = await import('vite'));
  } catch {
    throw new Error(
      'this gate loads the app\u2019s TypeScript through the frontend\u2019s own Vite install; run `npm ci` in frontend/ first',
    );
  }
  const server = await createServer({
    root: FRONTEND_ROOT,
    configFile: false,
    appType: 'custom',
    logLevel: 'error',
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true },
  });
  try {
    return {
      capabilities: await server.ssrLoadModule('/src/renderers/capabilities.ts'),
      relief: await server.ssrLoadModule(
        '/src/renderers/three/reliefAssets.ts',
      ),
      geometry: await server.ssrLoadModule(
        '/src/renderers/three/tileGeometry.ts',
      ),
      mesh: await server.ssrLoadModule('/src/renderers/three/boardMesh.ts'),
      scene: await server.ssrLoadModule('/src/renderers/three/Scene.ts'),
      layout: await server.ssrLoadModule(
        '/src/renderers/three/boardLayout.ts',
      ),
      fixture: await server.ssrLoadModule(
        '/src/renderers/three/boardFixture.ts',
      ),
    };
  } finally {
    await server.close();
  }
}

/** Every `.js` chunk in the build, with its bytes. */
function readChunks(distDir) {
  const assetsDir = join(distDir, 'assets');
  if (!existsSync(assetsDir)) return [];
  return readdirSync(assetsDir)
    .filter((file) => file.endsWith('.js'))
    .map((file) => {
      const path = join(assetsDir, file);
      return { file, path, text: readFileSync(path, 'utf8'), raw: statSync(path).size };
    });
}

function containsThree(text) {
  return THREE_MARKERS.some((marker) => marker.test(text));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function main() {
  const options = formatFlags(process.argv.slice(2));
  const distDir = options.get('dist')
    ? join(FRONTEND_ROOT, options.get('dist'))
    : join(FRONTEND_ROOT, 'dist');

  console.log('3D budget gate (3D-13)\n');
  console.log(`build: ${distDir.replace(FRONTEND_ROOT, 'frontend/')}\n`);

  if (!existsSync(join(distDir, 'index.html'))) {
    throw new Error(
      `no build at ${distDir}; run \`npm run build\` in frontend/ first`,
    );
  }

  const M = await loadModules();

  /* ---------------------------- atlases ------------------------------ */
  console.log('carve atlases (relief3d.json, pins, committed PNGs)');
  const manifestPath = join(distDir, M.relief.RELIEF3D_MANIFEST_PATH);
  let manifest = null;
  if (!existsSync(manifestPath)) {
    check(`manifest exists (${M.relief.RELIEF3D_MANIFEST_PATH})`, false);
  } else {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    check(`manifest exists (${M.relief.RELIEF3D_MANIFEST_PATH})`, true);
  }

  const pins = M.relief.PINNED_RELIEF3D_ATLASES;
  const atlasKeys = Object.keys(pins);
  check(
    'the carve set is three atlases',
    atlasKeys.length === 3,
    atlasKeys.join(', '),
  );

  if (manifest) {
    const raster = manifest.raster ?? {};
    check(
      'manifest grid matches the app raster',
      raster.cellWidth === M.relief.RELIEF_RASTER.cellWidth &&
        raster.cellHeight === M.relief.RELIEF_RASTER.cellHeight &&
        raster.columns === M.relief.RELIEF_RASTER.columns &&
        raster.rows === M.relief.RELIEF_RASTER.rows &&
        raster.atlasWidth === M.relief.RELIEF_RASTER.atlasWidth &&
        raster.atlasHeight === M.relief.RELIEF_RASTER.atlasHeight,
      `${M.relief.RELIEF_RASTER.atlasWidth} x ${M.relief.RELIEF_RASTER.atlasHeight}, ` +
        `${M.relief.RELIEF_RASTER.columns} x ${M.relief.RELIEF_RASTER.rows} cells`,
    );
    check(
      'manifest face count matches the app vocabulary',
      raster.faces === M.relief.RELIEF_RASTER.faceCount &&
        Object.keys(manifest.faces ?? {}).length ===
          M.relief.RELIEF_RASTER.faceCount,
      `${M.relief.RELIEF_RASTER.faceCount} faces`,
    );
  }

  let pngTotal = 0;
  for (const key of atlasKeys) {
    const pin = pins[key];
    const entry = manifest?.atlases?.[key];
    const filePath = join(distDir, 'table', pin.file);
    const manifestOk =
      entry?.file === pin.file &&
      entry.width === pin.width &&
      entry.height === pin.height &&
      entry.bytes === pin.bytes &&
      entry.sha256?.png === pin.sha256;
    check(`${key}: manifest matches the pinned contract`, manifestOk, pin.file);

    if (!existsSync(filePath)) {
      check(`${key}: atlas exists in the build`, false, pin.file);
      continue;
    }
    const actual = readFileSync(filePath);
    const digest = sha256(actual);
    pngTotal += actual.byteLength;
    check(
      `${key}: byte count`,
      actual.byteLength === pin.bytes,
      `${number(actual.byteLength)} B, pinned ${number(pin.bytes)}`,
    );
    check(`${key}: SHA-256`, digest === pin.sha256, digest.slice(0, 16));
    console.log(
      `        ${`${pin.width} x ${pin.height}`.padEnd(11)} ` +
        `${bytes(actual.byteLength)}`,
    );
  }
  console.log(`  total PNG payload: ${bytes(pngTotal)}\n`);

  /* --------------------------- GPU budget ---------------------------- */
  console.log('GPU bytes per tier (atlases, mips included; §2.8)');
  for (const tier of ['high', 'balanced', 'compat']) {
    const gpu = M.relief.reliefGpuBytes(tier);
    const upload = M.relief.reliefTextureSize(tier);
    const budget = M.capabilities.TIER_BACKING_STORE[tier];
    const samples = M.capabilities.antiAliasFor(tier)
      ? M.capabilities.MSAA_SAMPLES
      : 1;
    const buffers = M.capabilities.backingStoreBytes(
      budget.maxPixels,
      M.capabilities.antiAliasFor(tier),
    );
    console.log(
      `  ${tier.padEnd(8)} ${`${upload.width} x ${upload.height}`.padEnd(11)} ` +
        `mips ${M.relief.RELIEF_TIER_SETTINGS[tier].mipmaps ? 'on ' : 'off'}  ` +
        `atlas ${(gpu.total / 1_000_000).toFixed(2)} MB  ` +
        `backing <= ${(budget.maxPixels / 1_000_000).toFixed(2)} MP at DPR <= ${budget.maxDevicePixelRatio}  ` +
        `MSAA ${samples > 1 ? `${samples}x` : 'off'} -> ` +
        `colour+depth ${(buffers.total / 1_000_000).toFixed(1)} MB`,
    );
    check(
      `${tier}: atlas GPU bytes match the published total`,
      gpu.total === PUBLISHED_ATLAS_GPU_BYTES[tier],
      `${number(gpu.total)} B, published ${number(PUBLISHED_ATLAS_GPU_BYTES[tier])}`,
    );
  }
  console.log();

  /* ---------------------- instances and triangles -------------------- */
  console.log('instances and triangles');
  const capacity = M.mesh.BOARD_TILE_CAPACITY;
  const fixture = M.fixture.boardFixture();
  const board = M.layout.layoutBoard(fixture);
  const widest = M.layout.layoutBoard(
    M.fixture.boardFixture({
      humanSeat: 2,
      riverCounts: [22, 22, 22, 22],
      meldCounts: [4, 4, 4, 4],
      kan: true,
      doraCount: 5,
      riichiSeats: [0, 1, 2, 3],
    }),
  );
  const geometry = M.geometry.buildTileGeometry();
  const fullBoardTriangles = capacity * geometry.triangleCount;
  const fullBoardCeiling = capacity * M.geometry.TILE_TRIANGLE_BUDGET;
  const widestTriangles = widest.tiles.length * geometry.triangleCount;

  console.log(
    `  tile geometry: ${number(geometry.triangleCount)} tris, ` +
      `${number(geometry.vertexCount)} verts (budget ${M.geometry.TILE_TRIANGLE_BUDGET}/tile)`,
  );
  console.log(
    `  fixture board: ${board.tiles.length} tiles, ${board.sticks.length} sticks ` +
      `(${number(board.tiles.length * geometry.triangleCount)} tris)`,
  );
  console.log(
    `  widest board:  ${widest.tiles.length} tiles ` +
      `(${number(widestTriangles)} tris)`,
  );
  console.log(
    `  capacity:      ${capacity} instances -> ${number(fullBoardTriangles)} tris ` +
      `(ceiling ${number(BOARD_TRIANGLE_CEILING)})`,
  );
  check(
    'one tile geometry stays inside the 600-triangle budget',
    geometry.triangleCount <= M.geometry.TILE_TRIANGLE_BUDGET,
    `${geometry.triangleCount} <= ${M.geometry.TILE_TRIANGLE_BUDGET}`,
  );
  check(
    'the widest legal board fits the instance capacity',
    widest.tiles.length <= capacity,
    `${widest.tiles.length} <= ${capacity}`,
  );
  check(
    'a full capacity board fits the 200 k triangle ceiling',
    fullBoardTriangles <= BOARD_TRIANGLE_CEILING && fullBoardCeiling <= BOARD_TRIANGLE_CEILING,
    `${number(fullBoardTriangles)} <= ${number(BOARD_TRIANGLE_CEILING)} ` +
      `(budgeted ${number(fullBoardCeiling)})`,
  );
  console.log();

  /* ---------------------------- draw calls --------------------------- */
  console.log('draw calls');
  const plan = M.scene.SCENE_DRAW_CALLS;
  for (const [layer, count] of Object.entries(plan)) {
    console.log(`  ${layer.padEnd(13, '.')} ${count}`);
  }
  const steady = M.scene.steadyStateDrawCalls();
  console.log(`  ${'steady'.padEnd(13, '.')} ${steady}`);
  check(
    'the steady-state plan is the published five draws',
    steady === STEADY_STATE_DRAW_CALLS,
    `${steady} of ${STEADY_STATE_DRAW_CALLS}`,
  );
  check(
    'the steady-state plan is inside the hard ceiling',
    steady <= DRAW_CALL_CEILING,
    `${steady} <= ${DRAW_CALL_CEILING}`,
  );
  console.log();

  /* ----------------------------- chunks ------------------------------ */
  console.log('chunks (post-build dist/assets)');
  const html = readFileSync(join(distDir, 'index.html'), 'utf8');
  const entryMatch = /<script[^>]+src="([^"]+\.js)"/.exec(html);
  const chunks = readChunks(distDir);
  if (!entryMatch) {
    check('index.html names one entry script', false);
  } else {
    const entryFile = entryMatch[1].split('/').pop().split('?')[0];
    const entry = chunks.find((chunk) => chunk.file === entryFile);
    check('the entry script exists in the build', Boolean(entry), entryFile);

    if (entry) {
      const entryGzip = gzipSync(Buffer.from(entry.text)).length;
      console.log(
        `  entry ${entryFile}: ${bytes(entry.raw)}, gzip ${number(entryGzip)} B`,
      );

      // The lazy chunk is the host's `import('./three')`, which Vite names after
      // its entry module. Identify it by that name first, then by content, so a
      // rename in a future build reports a clear failure rather than a false pass.
      const named = chunks.filter(
        (chunk) => chunk.file !== entryFile && /^three-.*\.js$/.test(chunk.file),
      );
      const content = chunks.filter(
        (chunk) =>
          chunk.file !== entryFile &&
          !named.includes(chunk) &&
          containsThree(chunk.text),
      );
      const lazyCandidates = named.length > 0 ? named : content;
      check(
        'exactly one lazy 3D chunk exists',
        lazyCandidates.length === 1,
        lazyCandidates.map((chunk) => chunk.file).join(', ') || 'none',
      );

      const lazy = lazyCandidates[0];
      if (lazy) {
        check(
          'the lazy chunk really contains three.js',
          containsThree(lazy.text),
          THREE_MARKERS.map((marker) => marker.source).join(' | '),
        );
        const lazyGzip = gzipSync(Buffer.from(lazy.text)).length;
        console.log(
          `  3D chunk ${lazy.file}: ${bytes(lazy.raw)}, gzip ${number(lazyGzip)} B`,
        );
        if (lazyGzip > LAZY_CHUNK_GZIP_ADVISORY) {
          warn(
            'the lazy 3D chunk is over the 200 KB gzip advisory',
            `${number(lazyGzip)} B > ${number(LAZY_CHUNK_GZIP_ADVISORY)} B (advisory only)`,
          );
        } else {
          console.log(
            `  ok    the lazy 3D chunk is inside the 200 KB gzip advisory  ` +
              `${number(lazyGzip)} <= ${number(LAZY_CHUNK_GZIP_ADVISORY)} B`,
          );
        }

        const escaped = escapeRegExp(lazy.file);
        const dynamicImport = new RegExp(
          `import\\(\\s*["'][^"']*${escaped}["']\\s*\\)`,
        );
        const staticImport = new RegExp(
          `(?:from|import)\\s*["'][^"']*${escaped}["']`,
        );
        check(
          'the entry reaches the 3D chunk through a dynamic import()',
          dynamicImport.test(entry.text),
          `import(…${lazy.file})`,
        );
        check(
          'the entry has no static import of the 3D chunk',
          !staticImport.test(entry.text),
        );
        check(
          'index.html does not load or preload the 3D chunk',
          !html.includes(lazy.file),
        );

        // `three` may live in the lazy chunk and nowhere else: not in the entry,
        // not in a vendor chunk, not in a worker.
        const leaked = chunks.filter(
          (chunk) => chunk.file !== lazy.file && containsThree(chunk.text),
        );
        check(
          'three appears in no other chunk (entry included)',
          leaked.length === 0,
          leaked.map((chunk) => chunk.file).join(', '),
        );
      }
    }
  }

  console.log();
  if (failures.length) {
    console.log(`FAILED ${failures.length} budget check(s):`);
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `3D budget gate: PASS${warnings.length ? ` (${warnings.length} advisory warning)` : ''}`,
  );
}

main().catch((error) => {
  console.error(
    `3D budget gate crashed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
