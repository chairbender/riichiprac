/**
 * Representative groups for the shadow research (browser-safe).
 *
 * Each zone is a list of placed shells in a local coordinate space, using the
 * manifest's own steps. The layouts are the contract's steps, not a guess:
 * `gridStepPx` is the projected tile axis through the *face centre*, so a fan
 * row is anchored on its faces (a body-box-left anchor makes the right half
 * spread, because the visible side reveal widens the outer slots inward).
 *
 * Zones carry two lists:
 *   - `tiles`: where a shadow footprint is cast (walls use the lower tier once);
 *   - `bodies`: draw order (fans outermost-to-innermost both halves, centre
 *     last; ponds top-to-bottom, each row right-to-left; wall tiers bottom then
 *     top).
 */
import { deriveShadowShape, shapeBounds } from './shadow-group.mjs';

const faceCentre = (entry) => [
  entry.faceQuad.reduce((sum, point) => sum + point[0], 0) / 4,
  entry.faceQuad.reduce((sum, point) => sum + point[1], 0) / 4,
];

const pad2 = (index) => String(index).padStart(2, '0');

const entryOf = (shells, id) => {
  const entry = shells[id];
  if (!entry) throw new Error(`group layout names a missing shell: ${id}`);
  return entry;
};

/**
 * Place a tile so its projected face centre sits at `facePosition`. `step` is
 * the tile-axis step; `origin` is the face position of the first tile.
 */
function faceAnchored(entry, facePosition) {
  const face = faceCentre(entry);
  return {
    gridX: facePosition[0] - (face[0] - entry.anchorX),
    gridY: facePosition[1] - (face[1] - entry.anchorY),
  };
}

function fanOrder(count, centreIndex) {
  const order = [];
  for (let offset = 0; offset < Math.floor(count / 2); offset += 1) {
    order.push(offset, count - 1 - offset);
  }
  order.push(centreIndex);
  return order;
}

function handZone(shells, options) {
  const {
    id,
    label,
    note,
    prefix,
    rowCount,
    centreIndex,
    drawId = null,
    drawOffsetUnits = 0,
    stepUnits,
  } = options;
  const ids = Array.from({ length: rowCount }, (_, index) => `${prefix}${pad2(index)}`);
  const centre = entryOf(shells, ids[centreIndex]);
  const step = centre.gridStepPx.x[0];
  const slotOf = (entry) => entry.handSlot ?? entry.topHandSlot;
  const originOffset = slotOf(entryOf(shells, ids[0])).offsetUnits;
  const faceAt = (offsetUnits) => [((offsetUnits - originOffset) / stepUnits) * step, 0];
  const tiles = ids.map((tileId, index) => {
    const entry = entryOf(shells, tileId);
    const position = faceAt(slotOf(entry).offsetUnits);
    return { id: tileId, ...faceAnchored(entry, position) };
  });
  const bodies = fanOrder(rowCount, centreIndex).map((index) => tiles[index]);
  if (drawId) {
    const entry = entryOf(shells, drawId);
    const position = faceAt(drawOffsetUnits);
    const drawn = { id: drawId, ...faceAnchored(entry, position) };
    tiles.push(drawn);
    bodies.push(drawn);
  }
  return { id, label, note, tiles, bodies };
}

function pondZone(shells, options) {
  const { id, label, note, rows, columns, riichi = null } = options;
  const upright = entryOf(shells, 'shell_flat_upright');
  const sideways = entryOf(shells, 'shell_flat_sideways');
  const stepX = upright.gridStepPx.x[0];
  const stepY = upright.gridStepPx.y[1];
  const sidewaysStep = sideways.gridStepPx.y[0];
  const rowsOfTiles = [];
  for (let row = 0; row < rows; row += 1) {
    const rowTiles = [];
    let faceX = 0;
    for (let column = 0; column < columns; column += 1) {
      const isRiichi = riichi && riichi.row === row && riichi.column === column;
      const entry = isRiichi ? sideways : upright;
      const shellId = isRiichi ? 'shell_flat_sideways' : 'shell_flat_upright';
      const drop = isRiichi ? upright.advanceHeight - sideways.advanceHeight : 0;
      const position = [faceX, row * stepY + drop];
      rowTiles.push({ id: shellId, ...faceAnchored(entry, position) });
      faceX += isRiichi ? sidewaysStep : stepX;
    }
    rowsOfTiles.push(rowTiles);
  }
  const tiles = rowsOfTiles.flat();
  const bodies = rowsOfTiles.flatMap((rowTiles) => [...rowTiles].reverse());
  return { id, label, note, tiles, bodies };
}

function wallZone(shells, options) {
  const { id, label, note, wall, count, doraIndex } = options;
  const downId = (index) => `shell_wall_${wall}_slot_${pad2(index)}`;
  const upId = (index) =>
    index === doraIndex
      ? `shell_wall_${wall}_slot_${pad2(index)}_faceup`
      : `shell_wall_${wall}_slot_${pad2(index)}`;
  const centre = entryOf(shells, downId(Math.floor(count / 2)));
  const step = centre.gridStepPx.x[0];
  const tiles = [];
  const bodies = [];
  const order = fanOrder(count, Math.floor(count / 2));
  const placed = Array.from({ length: count }, (_, index) => {
    const entry = entryOf(shells, downId(index));
    return { id: downId(index), ...faceAnchored(entry, [index * step, 0]) };
  });
  for (const index of order) {
    const lower = placed[index];
    tiles.push(lower);
    bodies.push(lower);
  }
  for (const index of order) {
    const lower = placed[index];
    const down = entryOf(shells, downId(index));
    bodies.push({
      id: upId(index),
      gridX: lower.gridX + down.stackStepPx[0],
      gridY: lower.gridY + down.stackStepPx[1],
    });
  }
  return { id, label, note, tiles, bodies };
}

function sideWallZone(shells, options) {
  const { id, label, note, side, count, faceUpIndex } = options;
  const baseId = `shell_wall_side_${side}`;
  const base = entryOf(shells, baseId);
  const down = Math.abs(base.gridStepPx.x[1]) >= Math.abs(base.gridStepPx.y[1])
    ? base.gridStepPx.x
    : base.gridStepPx.y;
  const step = down[1] < 0 ? [-down[0], -down[1]] : down;
  const tiles = [];
  const bodies = [];
  const placed = Array.from({ length: count }, (_, index) => ({
    id: baseId,
    ...faceAnchored(base, [index * step[0], index * step[1]]),
  }));
  for (let index = 0; index < count; index += 1) {
    const lower = placed[index];
    tiles.push(lower);
    bodies.push(lower);
    const upEntry = index === faceUpIndex ? `${baseId}_faceup` : baseId;
    bodies.push({
      id: upEntry,
      gridX: lower.gridX + base.stackStepPx[0],
      gridY: lower.gridY + base.stackStepPx[1],
    });
  }
  return { id, label, note, tiles, bodies };
}

function singleZone(shells, options) {
  const { id, label, note, shellId } = options;
  const entry = entryOf(shells, shellId);
  const tile = { id: shellId, ...faceAnchored(entry, [0, 0]) };
  return { id, label, note, tiles: [tile], bodies: [tile] };
}

/**
 * All zones, normalised so their body/shadow bounds start at (0, 0). The
 * renderer adds `blurPad` around the zone for the Gaussian's tail; the shapes
 * are then shifted by that pad.
 */
export function buildZones(manifest, spec) {
  const shells = manifest.shells;
  const handBlock = spec.handSlots;
  const topHandBlock = spec.topHand;
  const zones = [
    singleZone(shells, {
      id: 'single-hand',
      label: 'Single standing tile',
      note: 'The approved one-tile shadow, the reference for everything else.',
      shellId: `shell_hand_slot_${pad2(handBlock.centreIndex)}`,
    }),
    singleZone(shells, {
      id: 'single-flat',
      label: 'Single lying tile',
      note: 'The approved lying shadow: rounded rectangle, top edge trimmed.',
      shellId: 'shell_flat_upright',
    }),
    handZone(shells, {
      id: 'hand-13',
      label: 'Human hand, 13 tiles',
      note: 'A per-slot fan: every slot has its own silhouette.',
      prefix: 'shell_hand_slot_',
      rowCount: handBlock.rowCount,
      centreIndex: handBlock.centreIndex,
      stepUnits: handBlock.stepUnits,
    }),
    handZone(shells, {
      id: 'hand-14',
      label: 'Human hand, 13 + drawn tile',
      note: 'The drawn tile unions with the row; no 14th-length asset.',
      prefix: 'shell_hand_slot_',
      rowCount: handBlock.rowCount,
      centreIndex: handBlock.centreIndex,
      drawId: 'shell_hand_slot_draw',
      drawOffsetUnits: handBlock.drawOffsetUnits,
      stepUnits: handBlock.stepUnits,
    }),
    handZone(shells, {
      id: 'top-hand-13',
      label: 'Top hand, 13 tiles',
      note: 'The opposite seat: a second, differently shaped fan.',
      prefix: 'shell_hand_top_slot_',
      rowCount: topHandBlock.rowCount,
      centreIndex: topHandBlock.centreIndex,
      stepUnits: topHandBlock.stepUnits,
    }),
    (() => {
      const entry = entryOf(shells, 'shell_flat_upright');
      const step = entry.gridStepPx.x[0];
      const tiles = Array.from({ length: 3 }, (_, index) => ({
        id: 'shell_flat_upright',
        ...faceAnchored(entry, [index * step, 0]),
      }));
      return {
        id: 'meld-3',
        label: 'Open meld, 3 tiles',
        note: 'The same lying family as the pond, at a meld length.',
        tiles,
        bodies: [...tiles].reverse(),
      };
    })(),
    pondZone(shells, {
      id: 'pond-row-6',
      label: 'Pond row, 6 discards',
      note: 'A uniform row: this is the case the old middle-period tile map solved exactly.',
      rows: 1,
      columns: 6,
    }),
    pondZone(shells, {
      id: 'pond-4x6-riichi',
      label: 'Pond, 4 rows with a riichi tile',
      note: 'Rows overlap vertically by ~97 px, so per-row strips cannot be unioned by drawing them.',
      rows: 4,
      columns: 6,
      riichi: { row: 2, column: 4 },
    }),
    wallZone(shells, {
      id: 'wall-front-17',
      label: 'Front wall, 17 stacks',
      note: 'Two tiers over one footprint; the run shrinks as tiles are drawn.',
      wall: 'front',
      count: 17,
      doraIndex: 12,
    }),
    sideWallZone(shells, {
      id: 'wall-side-left-17',
      label: 'Left side wall, 17 stacks',
      note: 'The wall column recedes, so its face steps drift left as they go down.',
      side: 'left',
      count: 17,
      faceUpIndex: 5,
    }),
  ];
  return zones.map((zone) => normalise(zone, shells, spec));
}

function normalise(zone, shells, spec) {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  const include = (x0, y0, x1, y1) => {
    left = Math.min(left, x0);
    top = Math.min(top, y0);
    right = Math.max(right, x1);
    bottom = Math.max(bottom, y1);
  };
  for (const tile of zone.bodies) {
    const entry = entryOf(shells, tile.id);
    include(
      tile.gridX - entry.anchorX,
      tile.gridY - entry.anchorY,
      tile.gridX - entry.anchorX + entry.texWidth,
      tile.gridY - entry.anchorY + entry.texHeight,
    );
  }
  for (const tile of zone.tiles) {
    const shape = deriveShadowShape(entryOf(shells, tile.id), spec);
    if (!shape) continue;
    const bounds = shapeBounds(shape);
    include(
      tile.gridX + bounds.left,
      tile.gridY + bounds.top,
      tile.gridX + bounds.right,
      tile.gridY + bounds.bottom,
    );
  }
  const shift = (tile) => ({ ...tile, gridX: tile.gridX - left, gridY: tile.gridY - top });
  const tiles = zone.tiles.map(shift);
  const bodies = zone.bodies.map(shift);
  const sigma = deriveShadowShape(entryOf(shells, tiles[0].id), spec)?.sigmaPx1x ?? 0;
  for (const tile of tiles) {
    const tileSigma = deriveShadowShape(entryOf(shells, tile.id), spec)?.sigmaPx1x ?? 0;
    if (Math.abs(tileSigma - sigma) > 1e-9) {
      throw new Error(`${zone.id} mixes shadow sigmas (${sigma} vs ${tileSigma})`);
    }
  }
  return {
    ...zone,
    tiles,
    bodies,
    width: Math.ceil(right - left),
    height: Math.ceil(bottom - top),
    sigma,
    blurPad: Math.ceil(3 * sigma),
  };
}
