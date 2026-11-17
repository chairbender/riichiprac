/**
 * Shared whole-table reference camera model.
 *
 * The Blender bake (`bake_table_reference.py`) and the Node publisher/checker
 * both implement this pinhole exactly: camera from the spec candidate, a
 * top-left-origin pixel projection, tile body-box corners, and the calibration
 * metrics. `bake_table_reference.py` asserts its Python pinhole against
 * Blender's own `world_to_camera_view`; the checker asserts that this JS
 * implementation reproduces the recorded bake numbers.
 */

const EPSILON = 1e-9;

function subtract(left, right) {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function dot(left, right) {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function cross(left, right) {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function normalize(value) {
  const length = Math.hypot(value[0], value[1], value[2]);
  if (length < EPSILON) throw new Error('table camera: cannot normalize a zero vector');
  return [value[0] / length, value[1] / length, value[2] / length];
}

/** Resolve a spec candidate into the explicit camera the bake records. */
export function cameraFromCandidate(candidate, resolution) {
  const [width, height] = resolution;
  const target = candidate.target;
  const elevation = (candidate.elevationDeg * Math.PI) / 180;
  if (candidate.mode === 'orthographic') {
    const distance = candidate.eyeDistanceUnits;
    const eye = [
      target[0],
      target[1] - distance * Math.cos(elevation),
      target[2] + distance * Math.sin(elevation),
    ];
    return {
      mode: 'orthographic',
      eye,
      target,
      elevationDeg: candidate.elevationDeg,
      distanceUnits: distance,
      orthoScaleUnits: candidate.orthoScaleUnits,
      shiftX: 0,
      shiftY: 0,
      resolution: [width, height],
      sensorFit: 'HORIZONTAL',
    };
  }
  const eye = candidate.eye;
  const distance = Math.hypot(
    eye[0] - target[0],
    eye[1] - target[1],
    eye[2] - target[2],
  );
  return {
    mode: 'perspective',
    eye,
    target,
    elevationDeg: candidate.elevationDeg,
    distanceUnits: distance,
    lensMm: candidate.lensMm,
    sensorWidthMm: candidate.sensorWidthMm,
    sensorFit: candidate.sensorFit ?? 'HORIZONTAL',
    shiftX: candidate.shiftX ?? 0,
    shiftY: candidate.shiftY ?? 0,
    focalPixels: (candidate.lensMm / candidate.sensorWidthMm) * width,
    pixelsPerUnitAtTarget: ((candidate.lensMm / candidate.sensorWidthMm) * width) / distance,
    resolution: [width, height],
  };
}

export function cameraBasis(camera) {
  const forward = normalize(subtract(camera.target, camera.eye));
  const right = normalize(cross(forward, [0, 0, 1]));
  const up = cross(right, forward);
  return { right, up, forward };
}

/** Pinhole projection with a top-left origin, in pixels. */
export function projectPoint(camera, point) {
  const { right, up, forward } = cameraBasis(camera);
  const [width, height] = camera.resolution;
  const value = subtract(point, camera.eye);
  const depth = dot(value, forward);
  if (camera.mode === 'orthographic') {
    const scale = camera.orthoScaleUnits / width;
    return [
      width / 2 + camera.shiftX * width + dot(value, right) / scale,
      height / 2 - camera.shiftY * height - dot(value, up) / scale,
    ];
  }
  if (depth <= 0) throw new Error('table camera: point behind the camera');
  const focal = camera.focalPixels;
  return [
    width / 2 + camera.shiftX * width + (focal * dot(value, right)) / depth,
    height / 2 - camera.shiftY * height - (focal * dot(value, up)) / depth,
  ];
}

function rotate(matrix, vector) {
  return [
    matrix[0] * vector[0] + matrix[1] * vector[1] + matrix[2] * vector[2],
    matrix[3] * vector[0] + matrix[4] * vector[1] + matrix[5] * vector[2],
    matrix[6] * vector[0] + matrix[7] * vector[1] + matrix[8] * vector[2],
  ];
}

/** World corners of a tile's pre-bevel body box, as recorded by the bake. */
export function tileBoxCorners(tile) {
  const halfWidth = tile.dimensions.width / 2;
  const halfHeight = tile.dimensions.height / 2;
  const thickness = tile.dimensions.thickness;
  const corners = [];
  for (const x of [-halfWidth, halfWidth]) {
    for (const y of [-halfHeight, halfHeight]) {
      for (const z of [0, thickness]) {
        corners.push(
          rotate(tile.rotation, [x, y, z]).map((value, axis) => value + tile.origin[axis]),
        );
      }
    }
  }
  return corners;
}

export function tileBBoxPx(camera, tile) {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const corner of tileBoxCorners(tile)) {
    const [u, v] = projectPoint(camera, corner);
    left = Math.min(left, u);
    top = Math.min(top, v);
    right = Math.max(right, u);
    bottom = Math.max(bottom, v);
  }
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

export function tileSizePx(camera, tile) {
  const box = tileBBoxPx(camera, tile);
  return Math.max(box.width, box.height);
}

/** Projected length of the tile's local long axis (its 28 mm edge) at the face plane. */
export function tileLongAxisPx(camera, tile) {
  const half = tile.dimensions.height / 2;
  const z = tile.dimensions.thickness;
  const low = rotate(tile.rotation, [0, -half, z]).map((v, i) => v + tile.origin[i]);
  const high = rotate(tile.rotation, [0, half, z]).map((v, i) => v + tile.origin[i]);
  const a = projectPoint(camera, low);
  const b = projectPoint(camera, high);
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

function rotateSeat(degrees, point) {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [point[0] * cos - point[1] * sin, point[0] * sin + point[1] * cos, point[2]];
}

export function projectedRun(camera, radius, seatDeg, halfSpan, vertical) {
  const localA = vertical ? [radius, -halfSpan, 0] : [-halfSpan, -radius, 0];
  const localB = vertical ? [radius, halfSpan, 0] : [halfSpan, -radius, 0];
  return [projectPoint(camera, rotateSeat(seatDeg, localA)), projectPoint(camera, rotateSeat(seatDeg, localB))];
}

export function lineAngleError(angleDeg, expectedDeg) {
  const value = ((angleDeg % 180) + 180) % 180;
  const delta = Math.abs(value - expectedDeg);
  return Math.min(delta, 180 - delta);
}

/** Every recorded metric, recomputed from the camera and the tile placements. */
export function measureScene(camera, tiles, spec) {
  const [width, height] = camera.resolution;
  const byId = new Map(tiles.map((tile) => [tile.id, tile]));
  const tileAt = (id) => {
    const tile = byId.get(id);
    if (!tile) throw new Error(`table reference: no tile ${id}`);
    return tile;
  };

  const pondSizes = ['bottom', 'right', 'top', 'left'].map((seat) =>
    tileSizePx(camera, tileAt(`pond-${seat}-12`)),
  );
  const scaleSpread = Math.max(...pondSizes) / Math.min(...pondSizes);

  const wall = spec.table.wall;
  const halfSpan = wall.stackCentreSpanUnits / 2 + wall.stackPitchUnits / 2;
  const [frontA, frontB] = projectedRun(camera, wall.radiusUnits, 0, halfSpan, false);
  const [backA, backB] = projectedRun(camera, wall.radiusUnits, 180, halfSpan, false);
  const [leftA, leftB] = projectedRun(camera, wall.radiusUnits, 270, halfSpan, true);
  const [rightA, rightB] = projectedRun(camera, wall.radiusUnits, 90, halfSpan, true);
  const length = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const frontLength = length(frontA, frontB);
  const backLength = length(backA, backB);
  const leftLength = length(leftA, leftB);
  const rightLength = length(rightA, rightB);
  const angle = (a, b) => (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;

  const frontAngle = angle(frontA, frontB);
  const backAngle = angle(backA, backB);
  const leftAngle = angle(leftA, leftB) - 90;
  const rightAngle = angle(rightA, rightB) + 90;

  const bottomHand = tileLongAxisPx(camera, tileAt('hand-bottom-06'));
  const topHand = tileLongAxisPx(camera, tileAt('hand-top-06'));
  const frontGround = Math.abs(camera.eye[1] + wall.radiusUnits);
  const reveal =
    camera.mode === 'orthographic'
      ? 0
      : (Math.atan(wall.stackCentreSpanUnits / 2 / frontGround) * 180) / Math.PI;

  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const tile of tiles) {
    for (const corner of tileBoxCorners(tile)) {
      const [u, v] = projectPoint(camera, corner);
      left = Math.min(left, u);
      top = Math.min(top, v);
      right = Math.max(right, u);
      bottom = Math.max(bottom, v);
    }
  }
  const margins = {
    left,
    top,
    right: width - right,
    bottom: height - bottom,
  };

  return {
    pondTileSizePx: pondSizes.map((value) => Number(value.toFixed(4))),
    scaleSpread: Number(scaleSpread.toFixed(6)),
    frontRunLengthPx: Number(frontLength.toFixed(3)),
    backRunLengthPx: Number(backLength.toFixed(3)),
    leftRunLengthPx: Number(leftLength.toFixed(3)),
    rightRunLengthPx: Number(rightLength.toFixed(3)),
    frontBackRunRatio: Number((Math.max(frontLength, backLength) / Math.min(frontLength, backLength)).toFixed(6)),
    leftRightRunRatio: Number((Math.max(leftLength, rightLength) / Math.min(leftLength, rightLength)).toFixed(6)),
    runAnglesDeg: {
      front: Number(frontAngle.toFixed(6)),
      back: Number(backAngle.toFixed(6)),
      left: Number(leftAngle.toFixed(6)),
      right: Number(rightAngle.toFixed(6)),
    },
    runAngleErrorDeg: {
      front: Number(lineAngleError(frontAngle, 0).toFixed(6)),
      back: Number(lineAngleError(backAngle, 0).toFixed(6)),
      left: Number(lineAngleError(leftAngle, 90).toFixed(6)),
      right: Number(lineAngleError(rightAngle, 90).toFixed(6)),
    },
    bottomTopHandRatio: Number((bottomHand / topHand).toFixed(6)),
    frontOuterRevealDeg: Number(reveal.toFixed(4)),
    tableBoundsPx: {
      left: Number(left.toFixed(2)),
      top: Number(top.toFixed(2)),
      right: Number(right.toFixed(2)),
      bottom: Number(bottom.toFixed(2)),
    },
    frameMarginsPx: {
      left: Number(margins.left.toFixed(2)),
      top: Number(margins.top.toFixed(2)),
      right: Number(margins.right.toFixed(2)),
      bottom: Number(margins.bottom.toFixed(2)),
    },
    minFrameMarginPx: Number(Math.min(...Object.values(margins)).toFixed(3)),
  };
}

/** Element-family crop plan: family id -> kind + seat. */
export const CROP_PLAN = {
  'wall-front': ['wall', 'bottom'],
  'wall-back': ['wall', 'top'],
  'wall-left': ['wall', 'left'],
  'wall-right': ['wall', 'right'],
  'pond-bottom': ['pond', 'bottom'],
  'pond-right': ['pond', 'right'],
  'pond-top': ['pond', 'top'],
  'pond-left': ['pond', 'left'],
  'hand-bottom': ['hand', 'bottom'],
  'hand-top': ['hand', 'top'],
  'hand-left': ['hand', 'left'],
  'hand-right': ['hand', 'right'],
  'meld-bottom': ['meld', 'bottom'],
  'meld-right': ['meld', 'right'],
  'meld-top': ['meld', 'top'],
  'meld-left': ['meld', 'left'],
  'drawn-tile': ['drawn', 'bottom'],
};

export function zoneTileIds(index, kind, seat) {
  if (kind === 'drawn') return index.drawn.drawn;
  return index[kind][`${kind}-${seat}`];
}

/** Crop rect at the 2x master resolution for one family. */
export function cropRect(camera2x, tiles, ids, margin) {
  const wanted = new Set(ids);
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const tile of tiles) {
    if (!wanted.has(tile.id)) continue;
    const box = tileBBoxPx(camera2x, tile);
    left = Math.min(left, box.left);
    top = Math.min(top, box.top);
    right = Math.max(right, box.right);
    bottom = Math.max(bottom, box.bottom);
  }
  const [width, height] = camera2x.resolution;
  const x = Math.max(0, Math.floor(left) - margin);
  const y = Math.max(0, Math.floor(top) - margin);
  return {
    x,
    y,
    width: Math.min(width - x, Math.ceil(right) + margin - x),
    height: Math.min(height - y, Math.ceil(bottom) + margin - y),
    zoneBounds: {
      left: Number(left.toFixed(3)),
      top: Number(top.toFixed(3)),
      right: Number(right.toFixed(3)),
      bottom: Number(bottom.toFixed(3)),
    },
  };
}
