/**
 * Isolated side-pond lean lab.
 *
 *   cd frontend && npm run pond:review
 *
 * Renders one right-hand pond at 4x with the four candidate reads:
 *
 *   straight        no lean
 *   z-centre        the current production transform: whole-zone Z rotation
 *                   about the pond body centre
 *   z-near          whole-zone Z rotation about the near (bottom) edge
 *   shear           upright tile sprites on a sheared grid: the top shifts
 *                   toward the centre, the bottom stays put
 *   z-opposite      the same centre rotation in the other direction
 *
 * The sheet writes `tools/render/build/review/pond-lean-lab-4x.png` under the
 * gitignored build tree. Shadows are omitted so the row orientation is the only
 * variable; this is for the user's visual pick (AGENTS.md §6), not an agent
 * sign-off.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { parseShellsManifest } from '../src/table/shellManifest';
import { TileAtlas } from '../src/table/TileAtlas';
import type { AtlasCanvas, AtlasImage } from '../src/table/TileAtlasBuilder';
import { layoutPond } from '../src/table/zoneLayout';
import type { LayoutZone } from '../src/table/zoneLayout';
import { drawZoneLayer } from '../src/table/TableCompositor';
import type { BoardCanvas } from '../src/table/TableCompositor';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const tableDir = resolve(scriptDir, '../public/table');
const outDir = resolve(scriptDir, '../../tools/render/build/review');
const SCALE = 4;

const manifest = parseShellsManifest(
  JSON.parse(readFileSync(join(tableDir, 'shells.json'), 'utf8')),
);
const atlas = await TileAtlas.load({
  baseUrl: tableDir,
  fetchJson: async (url) => JSON.parse(readFileSync(url, 'utf8')),
  loadImage: async (url) =>
    (await loadImage(readFileSync(url))) as unknown as AtlasImage,
  createCanvas: (width, height) => createCanvas(width, height) as unknown as AtlasCanvas,
  pixelRatio: 1,
});

const FACES = ['1m', '2m', '3m', '4p', '5p', '6p'] as const;
const discards = FACES.map((face) => ({ face }));
const asBoardCanvas = (width: number, height: number): BoardCanvas =>
  createCanvas(width, height) as unknown as BoardCanvas;

const base = layoutPond(manifest, { discards, side: 'right', leanDeg: 0 });
const bodyBottom = Math.max(
  ...base.bodies.map((tile) => tile.gridY + manifest.shells[tile.shell].texHeight),
);

function leanZone(zone: LayoutZone, degrees: number, pivotY?: number): {
  readonly zone: LayoutZone;
  readonly layer: ReturnType<typeof drawZoneLayer>;
} {
  const transformed = { ...zone, rotationDeg: degrees, pivotY: pivotY ?? zone.pivotY };
  const layer = drawZoneLayer(
    {
      id: 'lab',
      zone: transformed,
      layer: transformed.layer,
      x: 0,
      y: 0,
      rotationPad: 40,
      bounds: { x: 0, y: 0, width: zone.width, height: zone.height },
    },
    manifest,
    atlas,
    new Map(),
    [],
    asBoardCanvas,
  );
  return { zone: transformed, layer };
}

function shearedBody(degrees: number): ReturnType<typeof drawZoneLayer> {
  const radians = (degrees * Math.PI) / 180;
  const tan = Math.tan(radians);
  const shift = (tile: LayoutZone['bodies'][number]): number =>
    (tile.gridY - bodyBottom) * tan;
  const bodies = base.bodies.map((tile) => {
    const dx = shift(tile);
    return {
      ...tile,
      drawX: Math.round(tile.drawX + dx),
      gridX: tile.gridX + dx,
      faceX: tile.faceX + dx,
      hitBox: { ...tile.hitBox, x: tile.hitBox.x + dx },
    };
  });
  const zone: LayoutZone = { ...base, bodies, rotationDeg: 0 };
  return drawZoneLayer(
    {
      id: 'lab',
      zone,
      layer: zone.layer,
      x: 0,
      y: 0,
      rotationPad: 70,
      bounds: { x: 0, y: 0, width: zone.width + 90, height: zone.height },
    },
    manifest,
    atlas,
    new Map(),
    [],
    asBoardCanvas,
  );
}

const variants = [
  { label: 'straight (no lean)', layer: leanZone(base, 0).layer },
  { label: 'z-centre (current, −5°)', layer: leanZone(base, -5).layer },
  { label: 'z-near (bottom edge, −5°)', layer: leanZone(base, -5, base.height).layer },
  { label: 'shear (upright sprites, top −5°)', layer: shearedBody(-5) },
  { label: 'z opposite (centre, +5°)', layer: leanZone(base, 5).layer },
];

const labelHeight = 34;
const gap = 26;
const margin = 24;
const panelWidth = Math.max(...variants.map((variant) => variant.layer.canvas.width * SCALE));
const sheetWidth = margin * 2 + panelWidth;
const panelHeights = variants.map(
  (variant) => labelHeight + variant.layer.canvas.height * SCALE,
);
const sheetHeight =
  margin * 2 + panelHeights.reduce((total, height) => total + height, 0) + gap * (variants.length - 1);

const sheet = createCanvas(sheetWidth, sheetHeight);
const context = sheet.getContext('2d');
context.fillStyle = '#10161a';
context.fillRect(0, 0, sheetWidth, sheetHeight);
context.fillStyle = '#f2ead6';
context.font = 'bold 22px sans-serif';
context.fillText('Side pond lean lab — right pond, 4x, shadows omitted', margin, margin + 6);
let y = margin + 18;
for (let index = 0; index < variants.length; index += 1) {
  y += labelHeight;
  const variant = variants[index];
  context.fillStyle = '#ffd479';
  context.font = 'bold 18px sans-serif';
  context.fillText(variant.label, margin, y - 10);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(
    variant.layer.canvas as unknown as CanvasImageSource,
    margin,
    y,
    variant.layer.canvas.width * SCALE,
    variant.layer.canvas.height * SCALE,
  );
  y += variant.layer.canvas.height * SCALE + gap;
}

mkdirSync(outDir, { recursive: true });
const out = join(outDir, 'pond-lean-lab-4x.png');
writeFileSync(out, sheet.toBuffer('image/png'));
console.log(`WROTE ${out}`);
for (const variant of variants) {
  console.log(`  ${variant.label}: ${variant.layer.canvas.width}×${variant.layer.canvas.height} @1x`);
}
