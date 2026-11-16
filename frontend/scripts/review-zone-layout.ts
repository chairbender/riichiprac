/**
 * Review sheet and numbers for the zone layout engine (Phase 3).
 *
 *   cd frontend && npm run layout:review
 *
 * Builds the real `zoneLayout` zones with the committed shells.json and the
 * real startup atlas, then writes, under `tools/render/build/review/`
 * (gitignored):
 *
 *   zone-layouts-1x.png    every representative zone at 1:1 with real art
 *   pond-layouts-1x.png    the four seat ponds with their seat shells and frames
 *   zone-layout-numbers.json  per-zone bounds, counts and draw-order facts
 *
 * AGENTS.md §6: the PNG is evidence for the user to inspect, not for the agent
 * to sign off. The printed numbers are the scripted check.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { parseShellsManifest } from '../src/table/shellManifest';
import type { ShellsManifest } from '../src/table/shellManifest';
import { TileAtlas } from '../src/table/TileAtlas';
import type { AtlasCanvas, AtlasImage } from '../src/table/TileAtlasBuilder';
import { isFaceUpShellId, tileRenderKey } from '../src/table/tiles';
import type { FaceUpShellId, TileFaceId } from '../src/table/tiles';
import {
  faceCentreOf,
  flatShellsForSeat,
  layoutPond,
  layoutSideHand,
  representativeZones,
} from '../src/table/zoneLayout';
import type { LayoutZone, PlacedTile, PondDiscard } from '../src/table/zoneLayout';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const tableDir = resolve(scriptDir, '../public/table');
const outDir = resolve(scriptDir, '../../tools/render/build/review');

const manifest: ShellsManifest = parseShellsManifest(
  JSON.parse(readFileSync(join(tableDir, 'shells.json'), 'utf8')),
);

const WARM_SHELLS: FaceUpShellId[] = [
  'shell_hand_slot_00',
  'shell_hand_slot_01',
  'shell_hand_slot_02',
  'shell_hand_slot_03',
  'shell_hand_slot_04',
  'shell_hand_slot_05',
  'shell_hand_slot_06',
  'shell_hand_slot_07',
  'shell_hand_slot_08',
  'shell_hand_slot_09',
  'shell_hand_slot_10',
  'shell_hand_slot_11',
  'shell_hand_slot_12',
  'shell_hand_slot_draw',
  'shell_flat_upright',
  'shell_flat_sideways',
  'shell_flat_upright_180',
  'shell_flat_sideways_270',
];

const atlas = await TileAtlas.load({
  baseUrl: tableDir,
  fetchJson: async (url) => JSON.parse(readFileSync(url, 'utf8')),
  loadImage: async (url) => (await loadImage(readFileSync(url))) as unknown as AtlasImage,
  createCanvas: (width, height) => createCanvas(width, height) as unknown as AtlasCanvas,
  pixelRatio: 1,
  decalsUrl: null,
  warmShells: WARM_SHELLS,
});

const imageCache = new Map<string, AtlasImage>();
const imageFor = async (shellId: string): Promise<AtlasImage> => {
  const cached = imageCache.get(shellId);
  if (cached) return cached;
  const shell = manifest.shells[shellId];
  if (!shell) throw new Error(`no shell ${shellId}`);
  const image = (await loadImage(
    readFileSync(join(tableDir, shell.textureFile)),
  )) as unknown as AtlasImage;
  imageCache.set(shellId, image);
  return image;
};

/** Resolve the 16 face-up pages once, then draw the sheet. */
for (const shellId of WARM_SHELLS) {
  if (!atlas.hasShell(shellId)) throw new Error(`atlas did not warm ${shellId}`);
}

const FELT = '#1a5038';
const INK = '#f3ead7';
const MUTED = '#b9c9b6';
const RULE = '#2d6a4a';
const MARGIN = 24;
const LABEL_H = 42;

type SheetContext = ReturnType<ReturnType<typeof createCanvas>['getContext']>;

interface Panel {
  zone: LayoutZone;
  width: number;
  height: number;
}

const zones = [
  ...representativeZones(manifest),
  layoutSideHand(manifest, { side: 'left' }),
  layoutSideHand(manifest, { side: 'right' }),
];
const panels: Panel[] = zones.map((zone) => ({
  zone,
  width: Math.max(1, zone.width),
  height: Math.max(1, zone.height),
}));

const sheetWidth =
  MARGIN * 2 + Math.max(...panels.map((panel) => panel.width));
const sheetHeight =
  MARGIN * 2 + panels.reduce((sum, panel) => sum + LABEL_H + panel.height + MARGIN, 0);
const canvas = createCanvas(sheetWidth, sheetHeight);
const context = canvas.getContext('2d');
context.fillStyle = FELT;
context.fillRect(0, 0, sheetWidth, sheetHeight);

context.fillStyle = INK;
context.font = 'bold 18px sans-serif';
context.fillText(
  'Zone layout engine — representative zones at @1x — tile bodies, face-centre anchored',
  MARGIN,
  MARGIN + 4,
);
context.font = '12px sans-serif';
context.fillStyle = MUTED;
context.fillText(
  `${Object.keys(manifest.shells).length} committed shells · ` +
    'draw positions are whole @1x px · hit boxes are the published advance box',
  MARGIN,
  MARGIN + 24,
);

let y = MARGIN + LABEL_H + 12;

async function drawTile(
  target: SheetContext,
  tile: PlacedTile,
  originX: number,
  originY: number,
): Promise<void> {
  const shell = manifest.shells[tile.shell];
  if (!shell) throw new Error(`no shell ${tile.shell}`);
  if (tile.face && isFaceUpShellId(tile.shell)) {
    const sprite = atlas.getSprite(tileRenderKey(tile.shell, tile.face));
    const page = atlas.getPage(sprite);
    target.drawImage(
      page.canvas as never,
      sprite.uv.x,
      sprite.uv.y,
      sprite.uv.width,
      sprite.uv.height,
      originX + tile.drawX,
      originY + tile.drawY,
      sprite.texWidth,
      sprite.texHeight,
    );
    return;
  }
  const image = await imageFor(tile.shell);
  target.drawImage(
    image as never,
    originX + tile.drawX,
    originY + tile.drawY,
    shell.texWidth,
    shell.texHeight,
  );
}

const numbers: Record<string, unknown>[] = [];

for (const panel of panels) {
  const { zone } = panel;
  context.fillStyle = INK;
  context.font = 'bold 13px sans-serif';
  context.textAlign = 'left';
  context.fillText(
    `${zone.id} · ${zone.width}×${zone.height} px · ${zone.bodies.length} bodies / ` +
      `${zone.shadows.length} shadows · layer ${zone.layer} · ` +
      `sigma ${zone.sigmaPx1x} px · pad ${zone.blurPad}`,
    MARGIN,
    y,
  );
  context.font = '11px sans-serif';
  context.fillStyle = MUTED;
  context.fillText(
    `group ${zone.shadowGroup} · local origin (0, 0) at the top-left of the bounds`,
    MARGIN,
    y + 16,
  );

  const panelY = y + 24;
  context.strokeStyle = RULE;
  context.lineWidth = 1;
  context.strokeRect(MARGIN + 0.5, panelY + 0.5, panel.width, panel.height);

  for (const tile of zone.bodies) {
    await drawTile(context, tile, MARGIN, panelY);
  }

  numbers.push({
    id: zone.id,
    kind: zone.kind,
    side: zone.side,
    layer: zone.layer,
    shadowGroup: zone.shadowGroup,
    width: zone.width,
    height: zone.height,
    bodies: zone.bodies.length,
    shadows: zone.shadows.length,
    sigmaPx1x: zone.sigmaPx1x,
    blurPad: zone.blurPad,
    firstBody: zone.bodies[0]
      ? {
          shell: zone.bodies[0].shell,
          face: zone.bodies[0].face,
          gridX: zone.bodies[0].gridX,
          gridY: zone.bodies[0].gridY,
          drawX: zone.bodies[0].drawX,
          drawY: zone.bodies[0].drawY,
          hitBox: zone.bodies[0].hitBox,
        }
      : null,
    lastBody: zone.bodies.at(-1)
      ? {
          shell: zone.bodies.at(-1)!.shell,
          face: zone.bodies.at(-1)!.face,
          gridX: zone.bodies.at(-1)!.gridX,
          gridY: zone.bodies.at(-1)!.gridY,
          drawX: zone.bodies.at(-1)!.drawX,
          drawY: zone.bodies.at(-1)!.drawY,
          hitBox: zone.bodies.at(-1)!.hitBox,
        }
      : null,
  });

  y = panelY + panel.height + MARGIN;
}

// --------------------------------------------------------------------------- //
// The four ponds: same discard sequence, each seat's shell family and frame.
// --------------------------------------------------------------------------- //

const POND_FACES: TileFaceId[] = [
  '1m',
  '2m',
  '3m',
  '4m',
  '5m',
  '6m',
  '7m',
  '8m',
  '9m',
  '1p',
  '2p',
  '3p',
  '4p',
  '5p',
  '6p',
  '7p',
  '8p',
  '9p',
  '1s',
  '2s',
  '3s',
  '4s',
  '5s',
  '6s',
];
const pondDiscards: PondDiscard[] = POND_FACES.map((face, index) => ({
  face,
  riichi: index === 16,
}));
const POND_SEATS = ['bottom', 'right', 'top', 'left'] as const;
const POND_SIDE_LABEL = {
  bottom: 'bottom · human',
  right: 'right · shimocha',
  top: 'top · toimen',
  left: 'left · kamicha',
} as const;
const pondZones = POND_SEATS.map((side) =>
  layoutPond(manifest, { discards: pondDiscards, side }),
);

const POND_GAP = 28;
const POND_LABEL_H = 46;
const pondCellW = Math.max(...pondZones.map((zone) => zone.width)) + POND_GAP;
const pondCellH = Math.max(...pondZones.map((zone) => zone.height)) + POND_LABEL_H + POND_GAP;
const pondSheetWidth = MARGIN * 2 + pondCellW * 2;
const pondSheetHeight = MARGIN * 2 + 56 + pondCellH * 2;
const pondCanvas = createCanvas(pondSheetWidth, pondSheetHeight);
const pondContext = pondCanvas.getContext('2d');
pondContext.fillStyle = FELT;
pondContext.fillRect(0, 0, pondSheetWidth, pondSheetHeight);
pondContext.fillStyle = INK;
pondContext.font = 'bold 18px sans-serif';
pondContext.fillText(
  'Ponds by seat — 24 discards, riichi at row 2 column 4 — each seat’s shells and frame',
  MARGIN,
  MARGIN + 6,
);
pondContext.font = '12px sans-serif';
pondContext.fillStyle = MUTED;
pondContext.fillText(
  'Each panel is the pond in that seat’s own frame; the riichi tile lies sideways ' +
    'and keeps the normal face gap. Bodies draw furthest first, right-to-left in each depth line.',
  MARGIN,
  MARGIN + 26,
);

const pondNumbers = pondZones.map((zone, index) => {
  const side = POND_SEATS[index];
  const shells = flatShellsForSeat(manifest, side);
  const column = index % 2;
  const row = Math.floor(index / 2);
  const originX = MARGIN + column * pondCellW;
  const originY = MARGIN + 56 + row * pondCellH;

  pondContext.fillStyle = INK;
  pondContext.font = 'bold 13px sans-serif';
  pondContext.textAlign = 'left';
  pondContext.fillText(
    `${POND_SIDE_LABEL[side]} · ${zone.width}×${zone.height} · ${zone.bodies.length} bodies`,
    originX,
    originY + 14,
  );
  pondContext.font = '11px sans-serif';
  pondContext.fillStyle = MUTED;
  pondContext.fillText(
    `${shells.normalId} → ${shells.turnedId} · layer ${zone.layer} · ` +
      `${zone.shadowGroup} · σ ${zone.sigmaPx1x}`,
    originX,
    originY + 30,
  );
  pondContext.strokeStyle = RULE;
  pondContext.lineWidth = 1;
  pondContext.strokeRect(originX + 0.5, originY + POND_LABEL_H + 0.5, zone.width, zone.height);

  return {
    side,
    width: zone.width,
    height: zone.height,
    bodies: zone.bodies.length,
    shadows: zone.shadows.length,
    layer: zone.layer,
    shadowGroup: zone.shadowGroup,
    normalShell: shells.normalId,
    turnedShell: shells.turnedId,
    normalColumnDelta: [
      zone.shadows[1].faceX - zone.shadows[0].faceX,
      zone.shadows[1].faceY - zone.shadows[0].faceY,
    ],
    rowDelta: [
      zone.shadows[6].faceX - zone.shadows[0].faceX,
      zone.shadows[6].faceY - zone.shadows[0].faceY,
    ],
    riichiAdvance: [
      zone.shadows[17].faceX - zone.shadows[16].faceX,
      zone.shadows[17].faceY - zone.shadows[16].faceY,
    ],
    firstBody: zone.bodies[0]
      ? {
          shell: zone.bodies[0].shell,
          face: zone.bodies[0].face,
          faceX: zone.bodies[0].faceX,
          faceY: zone.bodies[0].faceY,
        }
      : null,
    lastBody: zone.bodies.at(-1)
      ? {
          shell: zone.bodies.at(-1)!.shell,
          face: zone.bodies.at(-1)!.face,
          faceX: zone.bodies.at(-1)!.faceX,
          faceY: zone.bodies.at(-1)!.faceY,
        }
      : null,
    riichiBody: zone.bodies.find((tile) => tile.riichi) ?? null,
  };
});

for (let index = 0; index < pondZones.length; index += 1) {
  const zone = pondZones[index];
  const column = index % 2;
  const row = Math.floor(index / 2);
  const originX = MARGIN + column * pondCellW;
  const originY = MARGIN + 56 + row * pondCellH + POND_LABEL_H;
  for (const tile of zone.bodies) {
    await drawTile(pondContext, tile, originX, originY);
  }
}

const allTiles = zones.flatMap((zone) => [...zone.bodies, ...zone.shadows]);const fractionalDraw = allTiles.filter(
  (tile) => !Number.isInteger(tile.drawX) || !Number.isInteger(tile.drawY),
).length;
const anchorErrors = zones.flatMap((zone) =>
  zone.bodies.map((tile) => {
    const shell = manifest.shells[tile.shell];
    const centre = faceCentreOf(shell);
    return Math.abs(tile.gridX - (tile.faceX - (centre[0] - shell.anchorX)));
  }),
);
const hitBoxErrors = zones.flatMap((zone) =>
  zone.bodies.filter((tile) => {
    const shell = manifest.shells[tile.shell];
    return (
      tile.hitBox.width !== shell.advanceWidth || tile.hitBox.height !== shell.advanceHeight
    );
  }),
).length;

const report = {
  generatedBy: 'frontend/scripts/review-zone-layout.ts',
  coordinateSpace: '@1x CSS px, top-left origin, each zone normalised to (0, 0)',
  zoneCount: zones.length,
  tileCount: allTiles.length,
  fractionalDrawPositions: fractionalDraw,
  maxFaceAnchorErrorPx: Math.max(0, ...anchorErrors),
  hitBoxesNotAdvanceBox: hitBoxErrors,
  zones: numbers,
  ponds: pondNumbers,
};

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'zone-layouts-1x.png'), canvas.toBuffer('image/png'));
writeFileSync(join(outDir, 'pond-layouts-1x.png'), pondCanvas.toBuffer('image/png'));
writeFileSync(join(outDir, 'zone-layout-numbers.json'), `${JSON.stringify(report, null, 2)}\n`);

console.log(
  `zone layout: ${zones.length} zones, ${allTiles.length} tiles, ` +
    `${fractionalDraw} fractional draw positions, ` +
    `max face-anchor error ${report.maxFaceAnchorErrorPx.toExponential(2)} px, ` +
    `${hitBoxErrors} hit boxes not on the advance box`,
);
for (const zone of zones) {
  console.log(
    `  ${zone.id.padEnd(18)} ${String(zone.width).padStart(4)}×${String(zone.height).padEnd(4)} ` +
      `${String(zone.bodies.length).padStart(3)} bodies ` +
      `${String(zone.shadows.length).padStart(3)} shadows ` +
      `layer ${zone.layer}  ${zone.shadowGroup}`,
  );
}
for (const pond of pondNumbers) {
  console.log(
    `  pond ${pond.side.padEnd(6)} ${String(pond.width).padStart(4)}×${String(pond.height).padEnd(4)} ` +
      `${pond.bodies} bodies · ${pond.normalShell} → ${pond.turnedShell}`,
  );
}
console.log(`wrote ${join(outDir, 'zone-layouts-1x.png')}`);
console.log(`wrote ${join(outDir, 'pond-layouts-1x.png')}`);
console.log(`wrote ${join(outDir, 'zone-layout-numbers.json')}`);

if (fractionalDraw !== 0 || hitBoxErrors !== 0 || report.maxFaceAnchorErrorPx > 1e-9) {
  throw new Error(
    `zone layout check failed: ${fractionalDraw} fractional draw position(s), ` +
      `${hitBoxErrors} hit box(es) off the advance box, ` +
      `max face-anchor error ${report.maxFaceAnchorErrorPx} px`,
  );
}
