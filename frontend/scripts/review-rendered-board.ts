/**
 * Full-board review artifact for the rendered 2.5D view.
 *
 *   cd frontend && npm run rendered:review
 *
 * Writes, under `tools/render/build/review/` (gitignored):
 *
 *   rendered-board-1920x1080.png   a real committed hand at a desktop window
 *   rendered-board-stress.png      a stress board: 18 discards and 4 melds a
 *                                  seat, all four hands full (rendering only,
 *                                  not a legal state)
 *   rendered-board-portrait.png    the packed hand at a phone window
 *   rendered-board-numbers.json    the plan, the fit and every scripted check
 *
 * The canvas is the runtime compositor, not a second implementation: the script
 * loads the same atlas and manifests the app does and calls `prepare()`/`draw()`.
 * Every judgement here is a number or a printed check (AGENTS.md §6); whether the
 * board *looks* right is the user's call.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { GameState, MeldType, PlayerState } from '../src/types/game';
import { BoardRenderer, feltSidePx } from '../src/table/BoardRenderer';
import type { BoardViewport } from '../src/table/BoardRenderer';
import { buildBoardPlan } from '../src/table/boardPlan';
import type { BoardPlan } from '../src/table/boardPlan';
import { checkBoardPlan, failedChecks, rectOf } from '../src/table/boardChecks';
import { loadBoardAssets } from '../src/table/boardAssets';
import { TileAtlas } from '../src/table/TileAtlas';
import type { AtlasCanvas, AtlasImage } from '../src/table/TileAtlasBuilder';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const frontendDir = resolve(scriptDir, '..');
const tableDir = join(frontendDir, 'public/table');
const outDir = resolve(frontendDir, '../tools/render/build/review');

const readJson = (path: string): unknown =>
  JSON.parse(readFileSync(path, 'utf8'));

const scenariosDir = join(frontendDir, 'public/scenarios');
const packManifest = readJson(join(scenariosDir, 'manifest.json')) as {
  packs: Array<{ path: string }>;
};
const pack = JSON.parse(
  gunzipSync(
    readFileSync(join(scenariosDir, packManifest.packs[0].path)),
  ).toString('utf8'),
) as { scenarios: Array<{ lesson_id: string; state: GameState }> };
const packedHand = pack.scenarios.find(
  (scenario) => scenario.lesson_id === 'ryanmen_protorun',
);
if (!packedHand) throw new Error('committed pack is missing ryanmen_protorun');

const atlas = await TileAtlas.load({
  baseUrl: tableDir,
  fetchJson: async (url) => readJson(url),
  loadImage: async (url) =>
    (await loadImage(readFileSync(url))) as unknown as AtlasImage,
  createCanvas: (width, height) =>
    createCanvas(width, height) as unknown as AtlasCanvas,
  pixelRatio: 1,
});

const assets = await loadBoardAssets({
  urlFor: (path) => join(tableDir, path),
  fetchJson: async (url) => readJson(url),
});

const renderer = new BoardRenderer(atlas, assets, {
  createCanvas: (width, height) =>
    createCanvas(width, height) as unknown as HTMLCanvasElement,
  loadImage: async (url) =>
    (await loadImage(readFileSync(url))) as unknown as HTMLImageElement,
  resolveUrl: (file) => join(tableDir, file),
});

/** A rendering stress board: full ponds, four melds a seat, all hands full. */
function stressState(source: GameState): GameState {
  const state = structuredClone(source);
  const faces = [
    '1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m',
    '1p', '2p', '3p', '5s', '6z',
  ];
  const melds: Array<{ type: MeldType; tiles: string[]; offset: number }> = [
    { type: 'Chi', tiles: ['4m', '5m', '6m'], offset: 3 },
    { type: 'Pon', tiles: ['7z', '7z', '7z'], offset: 2 },
    { type: 'Kan', tiles: ['3s', '3s', '3s', '3s'], offset: 1 },
    { type: 'Ankan', tiles: ['9p', '9p', '9p', '9p'], offset: 0 },
  ];
  state.players = state.players.map((player) => {
    const next: PlayerState = structuredClone(player);
    next.hand = faces.slice(0, 13);
    next.draw = player.is_human ? '5p' : null;
    next.red_fives = [];
    next.discards = Array.from({ length: 18 }, (_, index) => ({
      tile: faces[index % faces.length],
      is_riichi: index === 8,
      is_tsumogiri: index % 3 === 0,
      is_red: false,
    }));
    next.is_riichi = true;
    next.riichi_discard_index = 8;
    next.melds = melds.map((meld) => ({
      meld_type: meld.type,
      tiles: meld.tiles,
      called_from:
        meld.type === 'Ankan' ? null : (player.seat + meld.offset) % 4,
    }));
    return next;
  });
  state.dora_indicators = ['1z', '5s', '2m'];
  return state;
}

interface Artifact {
  readonly name: string;
  readonly state: GameState;
  readonly viewport: BoardViewport;
}

/**
 * The floating HUD (action strip + hand dock) is not drawn in these artifacts,
 * but the browser reserves its measured height. Reserve a representative share
 * so the hand's position in the PNG matches what a player sees.
 */
function hudInsetFor(cssWidth: number, cssHeight: number): number {
  return Math.round(cssHeight * (cssWidth < 600 ? 0.3 : 0.19));
}

const artifacts: Artifact[] = [
  {
    name: 'rendered-board-1920x1080.png',
    state: packedHand.state,
    viewport: {
      cssWidth: 1920,
      cssHeight: 1080,
      dpr: 1,
      bottomInset: hudInsetFor(1920, 1080),
    },
  },
  {
    name: 'rendered-board-stress.png',
    state: stressState(packedHand.state),
    viewport: {
      cssWidth: 1920,
      cssHeight: 1080,
      dpr: 1,
      bottomInset: hudInsetFor(1920, 1080),
    },
  },
  {
    name: 'rendered-board-portrait.png',
    state: packedHand.state,
    viewport: {
      cssWidth: 390,
      cssHeight: 844,
      dpr: 1,
      bottomInset: hudInsetFor(390, 844),
    },
  },
];

interface ArtifactNumbers {
  name: string;
  viewport: BoardViewport;
  plan: {
    width: number;
    height: number;
    centreGapPx: number;
    centreX: number;
    centreY: number;
    zones: number;
    bodies: number;
    overlays: number;
    layers: number[];
  };
  fit: { scale: number; originX: number; originY: number; feltSide: number };
  zoneRows: Array<{
    id: string;
    layer: number;
    x: number;
    y: number;
    width: number;
    height: number;
    scale: number;
    bodies: number;
    shadows: number;
    covered: number;
  }>;
  checks: { name: string; ok: boolean; detail: string }[];
  pixels: {
    bright: number;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    visibleLeft: number;
    visibleRight: number;
  };
}

mkdirSync(outDir, { recursive: true });
const numbers: ArtifactNumbers[] = [];

for (const artifact of artifacts) {
  const plan: BoardPlan = buildBoardPlan(artifact.state, atlas.shells);
  await renderer.prepare(plan);

  const board = createCanvas(
    artifact.viewport.cssWidth,
    artifact.viewport.cssHeight,
  ) as unknown as HTMLCanvasElement;
  const result = renderer.draw(plan, board, artifact.viewport);
  if (!result) throw new Error(`${artifact.name}: no 2D context`);
  const fit = result.fit;

  // Per-zone coverage on the transparent board canvas: every zone that owns a
  // body must have drawn opaque pixels inside its fitted rect. This is the
  // scripted proof that the whole board reached the canvas, not just its
  // brightest hand.
  const boardPixels = board
    .getContext('2d')
    .getImageData(0, 0, board.width, board.height).data;
  const zoneCoverage = plan.zones.map((entry) => {
    const rect = rectOf(entry);
    const x0 = Math.max(0, Math.floor(fit.originX + rect.left * fit.scale));
    const y0 = Math.max(0, Math.floor(fit.originY + rect.top * fit.scale));
    const x1 = Math.min(
      board.width,
      Math.ceil(fit.originX + rect.right * fit.scale),
    );
    const y1 = Math.min(
      board.height,
      Math.ceil(fit.originY + rect.bottom * fit.scale),
    );
    let covered = 0;
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        if (boardPixels[(y * board.width + x) * 4 + 3] > 16) covered += 1;
      }
    }
    return { id: entry.zone.id, bodies: entry.zone.bodies.length, covered };
  });
  const undrawn = zoneCoverage.filter(
    (entry) => entry.bodies > 0 && entry.covered < 50,
  );

  // Compose the artifact the way the browser does: dark scene, square felt
  // touching the top and bottom of the frame, then the transparent board.
  const output = createCanvas(
    artifact.viewport.cssWidth,
    artifact.viewport.cssHeight,
  );
  const context = output.getContext('2d');
  context.fillStyle = '#0b1116';
  context.fillRect(0, 0, output.width, output.height);
  const side = feltSidePx(artifact.viewport.cssWidth, artifact.viewport.cssHeight);
  const feltLeft = (artifact.viewport.cssWidth - side) / 2;
  const felt = await loadImage(join(tableDir, 'felt.png'));
  context.drawImage(felt, feltLeft, 0, side, artifact.viewport.cssHeight);
  context.drawImage(
    board as unknown as Parameters<typeof context.drawImage>[0],
    0,
    0,
  );
  writeFileSync(join(outDir, artifact.name), output.toBuffer('image/png'));

  // A decoded-pixel fact about the file just written: the drawn tile faces are
  // the bright pixels, so their count and bbox prove the board reached the
  // felt, and that it stayed inside the visible square.
  const pixels = context.getImageData(0, 0, output.width, output.height).data;
  let bright = 0;
  let minX = output.width;
  let minY = output.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < output.height; y += 1) {
    for (let x = 0; x < output.width; x += 1) {
      const index = (y * output.width + x) * 4;
      const luma =
        0.2126 * pixels[index] +
        0.7152 * pixels[index + 1] +
        0.0722 * pixels[index + 2];
      if (luma < 120) continue;
      bright += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  const visibleLeft = Math.max(0, feltLeft);
  const visibleRight = Math.min(output.width, feltLeft + side);
  const pixelsOk =
    bright > 5000 && minX >= visibleLeft && maxX <= visibleRight;

  const checks = checkBoardPlan(plan, artifact.state);
  checks.push({
    name: 'the written PNG has a drawn board inside the visible square',
    ok: pixelsOk,
    detail: `${bright} bright px · bbox ${minX},${minY}..${maxX},${maxY} · visible x ${visibleLeft}..${visibleRight}`,
  });
  checks.push({
    name: 'every zone with a body drew opaque pixels in its fitted rect',
    ok: undrawn.length === 0,
    detail:
      undrawn.length === 0
        ? `${zoneCoverage.length} zones`
        : undrawn
            .map((entry) => `${entry.id}:${entry.covered}px`)
            .join(', '),
  });
  const bodies = plan.zones.reduce(
    (total, entry) => total + entry.zone.bodies.length,
    0,
  );
  numbers.push({
    name: artifact.name,
    viewport: artifact.viewport,
    plan: {
      width: plan.width,
      height: plan.height,
      centreGapPx: plan.centreGapPx,
      centreX: plan.centreX,
      centreY: plan.centreY,
      zones: plan.zones.length,
      bodies,
      overlays: renderer.resolvedOverlays,
      layers: plan.zones.map((entry) => entry.zone.layer),
    },
    fit: {
      scale: fit.scale,
      originX: fit.originX,
      originY: fit.originY,
      feltSide: side,
    },
    zoneRows: plan.zones.map((entry) => {
      const rect = rectOf(entry);
      const coverage = zoneCoverage.find(
        (candidate) => candidate.id === entry.zone.id,
      );
      return {
        id: entry.zone.id,
        layer: entry.zone.layer,
        x: Math.round(rect.left * 10) / 10,
        y: Math.round(rect.top * 10) / 10,
        width: entry.zone.width,
        height: entry.zone.height,
        scale: entry.scale,
        bodies: entry.zone.bodies.length,
        shadows: entry.zone.shadows.length,
        covered: coverage?.covered ?? 0,
      };
    }),
    checks,
    pixels: { bright, minX, minY, maxX, maxY, visibleLeft, visibleRight },
  });

  console.log(`\n${artifact.name}`);
  console.log(
    `  viewport ${artifact.viewport.cssWidth}x${artifact.viewport.cssHeight} @${artifact.viewport.dpr} · ` +
      `felt square ${side}px at x ${feltLeft.toFixed(0)} · board scale ${fit.scale.toFixed(4)}`,
  );
  console.log(
    `  board ${plan.width.toFixed(0)}x${plan.height.toFixed(0)} · ` +
      `${plan.zones.length} zones · ${bodies} bodies · ${renderer.resolvedOverlays} contact decals · ` +
      `${renderer.loadedImages} images`,
  );
  console.log(
    `  bright pixels ${bright} · bbox ${minX},${minY}..${maxX},${maxY}`,
  );
  const failures = failedChecks(checks);
  console.log(`  checks ${checks.length - failures.length}/${checks.length} passed`);
  for (const failure of failures) {
    console.log(`  FAIL ${failure.name}: ${failure.detail}`);
  }
}

writeFileSync(
  join(outDir, 'rendered-board-numbers.json'),
  `${JSON.stringify(
    {
      generatedBy: 'frontend/scripts/review-rendered-board.ts',
      coordinateSpace: '@1x CSS px; the plan normalises the table to (0, 0), the fit scales it into the square felt',
      atlas: {
        pixelRatio: atlas.pixelRatio,
        shells: atlas.stats.shells,
        sprites: atlas.stats.sprites,
        decalSprites: atlas.stats.decalSprites,
      },
      overlayPolicy: assets.overlays?.enabled ?? null,
      artifacts: numbers,
    },
    null,
    2,
  )}\n`,
);

console.log(`\nartifacts in ${outDir}`);
if (numbers.some((entry) => failedChecks(entry.checks).length > 0)) {
  process.exitCode = 1;
}
