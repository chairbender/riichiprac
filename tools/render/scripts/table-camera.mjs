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

/**
 * Pinhole projection with a top-left origin, in pixels.
 *
 * Blender measures lens shift against the sensor *width* (not height) and its
 * positive Shift Y moves the image down, so the vertical offset is
 * `+ shiftY * width`. This was corrected in Task 2 (2026-11-17); it had only
 * ever run with shift 0 before the rig.
 */
export function projectPoint(camera, point) {
  const { right, up, forward } = cameraBasis(camera);
  const [width, height] = camera.resolution;
  const value = subtract(point, camera.eye);
  const depth = dot(value, forward);
  if (camera.mode === 'orthographic') {
    const scale = camera.orthoScaleUnits / width;
    return [
      width / 2 + camera.shiftX * width + dot(value, right) / scale,
      height / 2 + camera.shiftY * width - dot(value, up) / scale,
    ];
  }
  if (depth <= 0) throw new Error('table camera: point behind the camera');
  const focal = camera.focalPixels;
  return [
    width / 2 + camera.shiftX * width + (focal * dot(value, right)) / depth,
    height / 2 + camera.shiftY * width - (focal * dot(value, up)) / depth,
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
  const halfSpan = wall.stackSpanUnits / 2;
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
      : (Math.atan(wall.stackSpanUnits / 2 / frontGround) * 180) / Math.PI;

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
    rimFrame: rimFrameMetrics(camera, spec),
  };
}

export function rimFrameMetrics(camera, spec) {
  const [width, height] = camera.resolution;
  const matHalf = spec.table.playingMat.sizeUnits / 2;
  const rim = spec.table.rim;
  const rimOuter = rim.innerHalfUnits + rim.widthUnits;
  const points = [];
  for (const [half, top] of [
    [matHalf, 0],
    [rimOuter, 0],
    [rimOuter, rim.heightUnits],
  ]) {
    for (const x of [-half, half]) {
      for (const y of [-half, half]) {
        points.push([x, y, top]);
      }
    }
  }
  const projected = points.map((point) => projectPoint(camera, point));
  const left = Math.min(...projected.map((point) => point[0]));
  const top = Math.min(...projected.map((point) => point[1]));
  const right = Math.max(...projected.map((point) => point[0]));
  const bottom = Math.max(...projected.map((point) => point[1]));
  return {
    matHalfUnits: matHalf,
    rimOuterHalfUnits: rimOuter,
    boundsPx: {
      left: Number(left.toFixed(2)),
      top: Number(top.toFixed(2)),
      right: Number(right.toFixed(2)),
      bottom: Number(bottom.toFixed(2)),
    },
    marginsPx: {
      left: Number(left.toFixed(2)),
      top: Number(top.toFixed(2)),
      right: Number((width - right).toFixed(2)),
      bottom: Number((height - bottom).toFixed(2)),
    },
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

// --------------------------------------------------------------------------- //
// The 2.5D rig (Task 2 of 2_5d_implementation_plan.md)
// --------------------------------------------------------------------------- //

function tileFaceCorners(tile, axis, sign) {
  // The recorded tile origin is the body box's z = 0 corner in x/y centre, so
  // the two axes across a face are centred in x/y but run 0..thickness in z.
  const across = [tile.dimensions.width / 2, tile.dimensions.height / 2, null];
  const axes = [0, 1, 2].filter((value) => value !== axis);
  const values = (index) => (index === 2 ? [0, tile.dimensions.thickness] : [-across[index], across[index]]);
  const corners = [];
  for (const first of values(axes[0])) {
    for (const second of values(axes[1])) {
      const local = [0, 0, 0];
      if (axis === 2) local[axis] = sign > 0 ? tile.dimensions.thickness : 0;
      else local[axis] = sign * across[axis];
      local[axes[0]] = first;
      local[axes[1]] = second;
      corners.push({ local, world: rotate(tile.rotation, local).map((value, i) => value + tile.origin[i]) });
    }
  }
  return corners;
}

function faceNormalWorld(tile, axis, sign) {
  const local = [0, 0, 0];
  local[axis] = sign;
  return rotate(tile.rotation, local);
}

function polygonArea(points) {
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    total += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(total) / 2;
}

function projectedFace(camera, tile, axis, sign) {
  const points = tileFaceCorners(tile, axis, sign).map((corner) => projectPoint(camera, corner.world));
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  return {
    widthPx: Math.max(...xs) - Math.min(...xs),
    heightPx: Math.max(...ys) - Math.min(...ys),
    areaPx: polygonArea(points),
    centre: [points.reduce((sum, point) => sum + point[0], 0) / points.length,
      points.reduce((sum, point) => sum + point[1], 0) / points.length],
    points,
  };
}

/** The horizontal face of a tile whose normal points most toward `toward` (world XY). */
export function innerFaceOf(tile, toward) {
  const length = Math.hypot(toward[0], toward[1]) || 1;
  const direction = [toward[0] / length, toward[1] / length];
  let best = null;
  for (const axis of [0, 1, 2]) {
    for (const sign of [-1, 1]) {
      const normal = faceNormalWorld(tile, axis, sign);
      if (Math.abs(normal[2]) > 1e-6) continue;
      const score = normal[0] * direction[0] + normal[1] * direction[1];
      if (!best || score > best.score) best = { axis, sign, normal, score };
    }
  }
  return best;
}

const round = (value, digits = 4) => Number(value.toFixed(digits));

/** Face-plate corners (the quad the runtime maps a glyph onto) in world space. */
export function plateCorners(tile, faceInset) {
  const halfX = tile.dimensions.width / 2 - faceInset;
  const halfY = tile.dimensions.height / 2 - faceInset;
  const corners = [
    [-halfX, halfY, tile.dimensions.thickness],
    [halfX, halfY, tile.dimensions.thickness],
    [halfX, -halfY, tile.dimensions.thickness],
    [-halfX, -halfY, tile.dimensions.thickness],
  ];
  return corners.map((local) => rotate(tile.rotation, local).map((value, index) => value + tile.origin[index]));
}

/**
 * The acceptance numbers of the 2.5D rig, recomputed from the camera and the
 * recorded tile placements. Facts, not looks (AGENTS.md 6):
 *
 *   - the +Y vanishing point the two side-wall runs converge on;
 *   - the projected width of every side-wall inner vertical face;
 *   - the south hand's straight-on centre and outer-slot side slivers;
 *   - the signed lean of every south-hand plate edge (inward vs outward);
 *   - the frame margins of the full table width and the player's hand.
 */
export function rigMetrics(camera, tiles, spec, shellSpec) {
  const [width, height] = camera.resolution;
  const { right, up, forward } = cameraBasis(camera);
  const focal = camera.focalPixels;
  const directionY = [0, 1, 0];
  const depthY = dot(directionY, forward);
  const vanishingPoint = {
    x: width / 2 + camera.shiftX * width + (focal * dot(directionY, right)) / depthY,
    y: height / 2 + camera.shiftY * width - (focal * dot(directionY, up)) / depthY,
  };
  const rim = rimFrameMetrics(camera, spec);
  const faceInset = shellSpec.tile.faceInset;

  const byId = new Map(tiles.map((tile) => [tile.id, tile]));
  const seatHands = (seat) => tiles
    .filter((tile) => tile.kind === 'hand' && tile.seat === seat)
    .sort((a, b) => a.cell.slot - b.cell.slot);
  const hand = seatHands('bottom');
  const handRows = hand.map((tile) => {
    const toward = [tile.origin[0] === 0 ? 1 : -Math.sign(tile.origin[0]), 0];
    const face = innerFaceOf(tile, toward);
    const projected = projectedFace(camera, tile, face.axis, face.sign);
    const quad = plateCorners(tile, faceInset).map((point) => projectPoint(camera, point));
    const centreX = quad.reduce((sum, point) => sum + point[0], 0) / 4;
    const outward = centreX <= width / 2 ? -1 : 1;
    const topWidth = Math.abs(quad[1][0] - quad[0][0]);
    const bottomWidth = Math.abs(quad[2][0] - quad[3][0]);
    const outwardLeanLeft = (quad[0][0] - quad[3][0]) * outward; // > 0 = top away from centre
    const outwardLeanRight = (quad[1][0] - quad[2][0]) * outward;
    return {
      slot: tile.cell.slot,
      centreX: round(centreX, 3),
      innerFaceNormal: face.normal.map((value) => round(value, 4)),
      innerFaceDot: round(face.score, 4),
      sideSliverPx: round(projected.widthPx, 4),
      topWidthPx: round(topWidth, 4),
      bottomWidthPx: round(bottomWidth, 4),
      outwardLeanLeftPx: round(outwardLeanLeft, 4),
      outwardLeanRightPx: round(outwardLeanRight, 4),
    };
  });

  const wallFaces = [];
  for (const seat of ['left', 'right']) {
    for (const tile of tiles.filter((entry) => entry.kind === 'wall' && entry.seat === seat)) {
      const face = innerFaceOf(tile, [-tile.origin[0], -tile.origin[1]]);
      const projected = projectedFace(camera, tile, face.axis, face.sign);
      const view = subtract(camera.eye, tile.origin);
      const viewLength = Math.hypot(...view) || 1;
      wallFaces.push({
        id: tile.id,
        seat,
        slot: tile.cell.slot,
        tier: tile.cell.tier,
        normalDotInward: round(face.score, 4),
        normalDotView: round(dot(face.normal, view.map((value) => value / viewLength)), 4),
        widthPx: round(projected.widthPx, 4),
        centre: [round(projected.centre[0], 3), round(projected.centre[1], 3)],
      });
    }
  }

  // The two runs' inner-face centre lines extended must meet at the +Y
  // vanishing point (the convergence the play read depends on). Only the
  // radial inner faces (dot > 0.9 toward the centre) define a run's line; at
  // the very end of a run the "most inward" face can be the end face instead,
  // which is not part of the long inner edge.
  const runLine = (seat) => {
    const entries = wallFaces
      .filter(
        (entry) => entry.seat === seat && entry.tier === 0 && entry.normalDotInward > 0.9,
      )
      .sort((a, b) => a.slot - b.slot);
    if (entries.length < 2) {
      return { slotRange: null, origin: null, direction: null, maxDeviationPx: null };
    }
    const near = entries[0];
    const far = entries[entries.length - 1];
    const dx = far.centre[0] - near.centre[0];
    const dy = far.centre[1] - near.centre[1];
    const length = Math.hypot(dx, dy) || 1;
    const stray = Math.max(
      ...entries.map((entry) => Math.abs(
        (entry.centre[0] - near.centre[0]) * (dy / length) -
        (entry.centre[1] - near.centre[1]) * (dx / length),
      )),
    );
    return {
      slotRange: [near.slot, far.slot],
      origin: near.centre,
      direction: [dx / length, dy / length],
      maxDeviationPx: round(stray, 4),
    };
  };
  const leftLine = runLine('left');
  const rightLine = runLine('right');
  let runConvergence = null;
  const denominator = leftLine.direction && rightLine.direction
    ? leftLine.direction[0] * rightLine.direction[1] -
      leftLine.direction[1] * rightLine.direction[0]
    : 0;
  if (Math.abs(denominator) > 1e-9) {
    const t = ((rightLine.origin[0] - leftLine.origin[0]) * rightLine.direction[1] -
      (rightLine.origin[1] - leftLine.origin[1]) * rightLine.direction[0]) / denominator;
    runConvergence = [
      round(leftLine.origin[0] + leftLine.direction[0] * t, 3),
      round(leftLine.origin[1] + leftLine.direction[1] * t, 3),
    ];
  }

  const handBottom = Math.max(...hand.map((tile) => tileBBoxPx(camera, tile).bottom));
  const handTop = Math.min(...hand.map((tile) => tileBBoxPx(camera, tile).top));
  const handQuads = hand.map((tile) => plateCorners(tile, faceInset).map((point) => projectPoint(camera, point)));
  const handLeft = Math.min(...handQuads.flat().map((point) => point[0]));
  const handRight = Math.max(...handQuads.flat().map((point) => point[0]));

  let tileLeft = Infinity;
  let tileTop = Infinity;
  let tileRight = -Infinity;
  let tileBottom = -Infinity;
  for (const tile of tiles) {
    const halfWidth = tile.dimensions.width / 2;
    const halfHeight = tile.dimensions.height / 2;
    for (const x of [-halfWidth, halfWidth]) {
      for (const y of [-halfHeight, halfHeight]) {
        for (const z of [0, tile.dimensions.thickness]) {
          const world = rotate(tile.rotation, [x, y, z]).map((value, index) => value + tile.origin[index]);
          const [u, v] = projectPoint(camera, world);
          tileLeft = Math.min(tileLeft, u);
          tileTop = Math.min(tileTop, v);
          tileRight = Math.max(tileRight, u);
          tileBottom = Math.max(tileBottom, v);
        }
      }
    }
  }
  const tileMargins = {
    left: tileLeft,
    top: tileTop,
    right: width - tileRight,
    bottom: height - tileBottom,
  };

  return {
    resolution: camera.resolution,
    camera: {
      mode: camera.mode,
      eye: camera.eye.map((value) => round(value, 6)),
      target: camera.target.map((value) => round(value, 6)),
      lensMm: camera.lensMm,
      sensorWidthMm: camera.sensorWidthMm,
      shiftX: camera.shiftX,
      shiftY: camera.shiftY,
      elevationDeg: camera.elevationDeg,
      distanceUnits: round(camera.distanceUnits, 6),
      focalPixels: round(focal, 6),
      right: right.map((value) => round(value, 9)),
      up: up.map((value) => round(value, 9)),
      forward: forward.map((value) => round(value, 9)),
    },
    vanishingPoint: { x: round(vanishingPoint.x, 4), y: round(vanishingPoint.y, 4) },
    runConvergencePx: runConvergence,
    runConvergenceDeltaPx: runConvergence
      ? round(Math.hypot(runConvergence[0] - vanishingPoint.x, runConvergence[1] - vanishingPoint.y), 4)
      : null,
    runs: {
      left: { slotRange: leftLine.slotRange, maxDeviationPx: leftLine.maxDeviationPx },
      right: { slotRange: rightLine.slotRange, maxDeviationPx: rightLine.maxDeviationPx },
    },
    rim: { marginsPx: rim.marginsPx, boundsPx: rim.boundsPx },
    tileMarginsPx: {
      left: round(tileMargins.left, 4),
      top: round(tileMargins.top, 4),
      right: round(tileMargins.right, 4),
      bottom: round(tileMargins.bottom, 4),
    },
    hand: {
      bottomMarginPx: round(height - handBottom, 4),
      topMarginPx: round(handTop, 4),
      leftMarginPx: round(handLeft, 4),
      rightMarginPx: round(width - handRight, 4),
      rows: handRows,
    },
    wallInnerFaces: wallFaces,
    wallInnerFaceMinPx: {
      left: round(Math.min(...wallFaces.filter((entry) => entry.seat === 'left').map((entry) => entry.widthPx)), 4),
      right: round(Math.min(...wallFaces.filter((entry) => entry.seat === 'right').map((entry) => entry.widthPx)), 4),
    },
    tiles: {
      count: tiles.length,
      ids: byId.size,
    },
  };
}

/**
 * Pixel probes for the rig's lighting facts, in the rig render's own space.
 *
 * Point probes average a small window; the side-wall inner faces are only
 * ~3.5 px wide at 1920, so they are averaged over the projected face polygon
 * instead of a window that would spill onto the felt.
 */
export function rigLightingSamples(camera, tiles, spec, shellSpec, rig = spec.rig) {
  const byId = new Map(tiles.map((tile) => [tile.id, tile]));
  const thickness = tiles[0].dimensions.thickness;
  const rigSamples = rig?.samples ?? {};
  const point = (tileId, localPoint, radiusPx) => {
    const tile = byId.get(tileId);
    if (!tile) throw new Error(`rig sample: no tile ${tileId}`);
    const world = rotate(tile.rotation, localPoint).map((value, index) => value + tile.origin[index]);
    const [x, y] = projectPoint(camera, world);
    return {
      kind: 'point',
      tile: tileId,
      localPoint,
      world: world.map((value) => round(value, 6)),
      pixel: [round(x, 3), round(y, 3)],
      radiusPx,
    };
  };
  const facePolygon = (tileId) => {
    const tile = byId.get(tileId);
    if (!tile) throw new Error(`rig sample: no tile ${tileId}`);
    const face = innerFaceOf(tile, [-tile.origin[0], -tile.origin[1]]);
    const polygon = tileFaceCorners(tile, face.axis, face.sign)
      .map((corner) => projectPoint(camera, corner.world))
      .map(([x, y]) => [round(x, 3), round(y, 3)]);
    return {
      kind: 'polygon',
      tile: tileId,
      axis: face.axis,
      sign: face.sign,
      polygon,
      centre: [
        round(polygon.reduce((sum, entry) => sum + entry[0], 0) / polygon.length, 3),
        round(polygon.reduce((sum, entry) => sum + entry[1], 0) / polygon.length, 3),
      ],
    };
  };
  const matWorld = rigSamples.matWorldPoint ?? [0, 6, 0];
  const [matX, matY] = projectPoint(camera, matWorld);
  const samples = {
    face: {
      ...point(spec.faces.sampleTileId, [0, 0, thickness], 3),
      localZ: 'paint face',
    },
    blue: {
      ...point(rigSamples.blueTileId ?? 'wall-bottom-slot-08-t1', [0, 0, 0.001], 3),
      localZ: 'back face',
    },
    handFace: {
      ...point(rigSamples.handFaceTileId ?? 'hand-bottom-06', [0, 0, thickness], 2),
      localZ: 'paint face (the rig scene forces 5z here)',
    },
    sideLeft: facePolygon((rigSamples.sideWallTileIds ?? ['wall-left-slot-08-t0'])[0]),
    sideRight: facePolygon(
      (rigSamples.sideWallTileIds ?? [null, 'wall-right-slot-08-t0'])[1],
    ),
    mat: {
      kind: 'point',
      tile: null,
      world: matWorld.map((value) => round(value, 6)),
      pixel: [round(matX, 3), round(matY, 3)],
      radiusPx: 3,
    },
  };
  // Felt probes south of the player's hand front edge, for the fake under-hand
  // shadow: where it starts, how dark it is, and how fast it fades.
  const shadowProbes = rigSamples.handShadow;
  if (shadowProbes) {
    const bottomHand = tiles
      .filter((tile) => tile.seat === 'bottom' && tile.kind === 'hand')
      .sort((a, b) => Math.abs(a.origin[0]) - Math.abs(b.origin[0]))[0];
    if (bottomHand) {
      const radial = (corner) => -corner[1];
      let front = tileBoxCorners(bottomHand)[0];
      for (const corner of tileBoxCorners(bottomHand)) {
        if (radial(corner) > radial(front)) front = corner;
      }
      const startRadius = radial(front) -
        front[2] / Math.tan((camera.elevationDeg * Math.PI) / 180);
      for (const [index, offset] of shadowProbes.offsetsUnits.entries()) {
        const world = [0, -(startRadius + offset), 0];
        const [px, py] = projectPoint(camera, world);
        samples[`handShadow${index}`] = {
          kind: 'point',
          tile: null,
          world: world.map((value) => round(value, 6)),
          pixel: [round(px, 3), round(py, 3)],
          radiusPx: shadowProbes.radiusPx ?? 1,
          offsetUnits: offset,
        };
      }
      // Just outside the row's left and right ends: does the shadow wrap?
      const row = tiles.filter((tile) => tile.seat === 'bottom' && tile.kind === 'hand');
      if (row.length) {
        const half = row[0].dimensions.width / 2;
        const xs = row.map((tile) => tile.origin[0]);
        for (const [name, x] of [
          ['handWrapLeft', Math.min(...xs) - half - 0.08],
          ['handWrapRight', Math.max(...xs) + half + 0.08],
        ]) {
          const world = [x, -(startRadius + shadowProbes.offsetsUnits[0]), 0];
          const [px, py] = projectPoint(camera, world);
          samples[name] = {
            kind: 'point',
            tile: null,
            world: world.map((value) => round(value, 6)),
            pixel: [round(px, 3), round(py, 3)],
            radiusPx: shadowProbes.radiusPx ?? 1,
            offsetUnits: shadowProbes.offsetsUnits[0],
          };
        }
      }
    }
  }

  // The south wall's outer face, inside and outside the player's hand span;
  // the shadow cheat's "nothing on the wall behind" fact.
  const wall = rigSamples.southWallFace;
  if (wall) {
    for (const [index, x] of wall.x.entries()) {
      const world = [x, wall.y, wall.z];
      const [px, py] = projectPoint(camera, world);
      samples[`wallFace${index}`] = {
        kind: 'point',
        tile: null,
        world: world.map((value) => round(value, 6)),
        pixel: [round(px, 3), round(py, 3)],
        radiusPx: wall.radiusPx ?? 1,
      };
    }
  }
  return samples;
}
