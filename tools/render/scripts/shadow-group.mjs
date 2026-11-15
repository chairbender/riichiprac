/**
 * The hard shadow footprint and the group shadow field (browser-safe).
 *
 * Phase 1d baked one *blurred* shadow sprite per shell. A group of tiles (a
 * hand fan, a pond row, a wall run) cannot be assembled from those sprites
 * without either seams (tile-map slices) or double-darkening (source-over
 * overlaps), because each slot's shadow is a different shape.
 *
 * The group recipe is the other way round: derive the *hard* rounded rectangle
 * the shadow is cast from, draw every placed tile's rectangle at full alpha so
 * overlaps merge, then blur the union once. That is `blur(union of footprints)`
 * rather than `max(blur(footprint_i))`: no seams, no darkening, any length.
 *
 * The derivation below mirrors `blob_shadow()` in `bake_shells.py` exactly, so a
 * shape rasterised here matches the committed per-shell shadow. Once the group
 * recipe is approved the same numbers are published as `shadowShape` in
 * `shells.json`; until then the manifest's `shadowBlob` + `contactQuadPx` are
 * enough to reproduce them.
 */

const DEFAULTS = {
  minHalfWidthPx1x: 2,
};

export function hexRgb(hex) {
  const value = hex.replace('#', '');
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

const mean = (points) => [
  points.reduce((sum, point) => sum + point[0], 0) / points.length,
  points.reduce((sum, point) => sum + point[1], 0) / points.length,
];

/**
 * Principal axes of a point set, major first, matching `numpy.linalg.eigh` on
 * the covariance matrix (the eigenvector sign is arbitrary and irrelevant for a
 * rectangle; the major/minor assignment is what matters).
 */
function principalAxes(points, centre) {
  const count = points.length;
  let xx = 0;
  let xy = 0;
  let yy = 0;
  for (const [x, y] of points) {
    const dx = x - centre[0];
    const dy = y - centre[1];
    xx += dx * dx;
    xy += dx * dy;
    yy += dy * dy;
  }
  xx /= count;
  xy /= count;
  yy /= count;
  const trace = xx + yy;
  const det = xx * yy - xy * xy;
  const disc = Math.sqrt(Math.max(0, (trace * trace) / 4 - det));
  const majorValue = trace / 2 + disc;
  let major;
  if (Math.abs(xy) > 1e-12) {
    const length = Math.hypot(xy, majorValue - xx);
    major = [xy / length, (majorValue - xx) / length];
  } else {
    major = xx >= yy ? [1, 0] : [0, 1];
  }
  return { major, minor: [-major[1], major[0]] };
}

function extentAlong(points, centre, axis) {
  let result = 0;
  for (const [x, y] of points) {
    result = Math.max(result, Math.abs((x - centre[0]) * axis[0] + (y - centre[1]) * axis[1]));
  }
  return result;
}

/**
 * The hard footprint of one shell's shadow, in @1x px relative to the tile's
 * grid anchor (the point the runtime places the shell at).
 *
 * A lying tile is an axis-aligned rounded rectangle around the body box, with
 * the top edge trimmed so nothing spills above the tile. A standing tile is a
 * rounded rectangle fitted to the projected base strip and rotated with it.
 */
export function deriveShadowShape(entry, spec) {
  const published = entry?.shadowShape;
  if (published) {
    return {
      kind: 'rounded-rect',
      centre: [...published.centrePx],
      half: [...published.halfPx],
      radius: published.radiusPx,
      angleDeg: published.angleDeg,
      sigmaPx1x: published.sigmaPx1x,
      coreAlpha: published.coreAlpha,
      colour: hexRgb(published.colorHex),
      lying: published.lying,
    };
  }
  const blob = entry?.shadowBlob;
  if (!blob) return null;
  // `shadowShape` is the published hard shape; otherwise derive it from the
  // record's own `shadowBlob` (the bake that produced this sprite), falling back
  // to the spec only when an older manifest does not carry a newer parameter.
  const params = spec?.bake?.shadow ?? {};
  const pick = (key) => blob[key] ?? params[key];
  const minimum = params.minHalfWidthPx1x ?? DEFAULTS.minHalfWidthPx1x;
  const offset = pick('offsetPx1x') ?? [0, 0];
  const anchorX = entry.shadowAnchorX ?? 0;
  const anchorY = entry.shadowAnchorY ?? 0;
  const width = entry.advanceWidth;
  const height = entry.advanceHeight;
  let centre;
  let half;
  let angleDeg = 0;
  let radius;
  if (blob.lying) {
    const trim = pick('topTrimPx1x') ?? 0;
    centre = [
      anchorX + width / 2 + offset[0],
      anchorY + height / 2 + offset[1] + trim / 2,
    ];
    half = [
      (width / 2) * pick('rectScale') + pick('rectPaddingPx1x'),
      Math.max((height / 2) * pick('rectScale') + pick('rectPaddingPx1x') - trim / 2, 1),
    ];
    radius = Math.min(...half) * pick('cornerRadiusFraction');
  } else {
    const points = entry.measured?.contactQuadPx ?? entry.contactQuadPx ?? [];
    if (points.length < 3) return null;
    const source = mean(points);
    const axes = principalAxes(points, source);
    centre = [source[0] + offset[0], source[1] + offset[1]];
    half = [
      Math.max(
        extentAlong(points, source, axes.major) * pick('standingRectScale') +
          pick('standingRectPaddingPx1x'),
        minimum,
      ),
      Math.max(
        extentAlong(points, source, axes.minor) * pick('standingRectScale') +
          pick('standingRectPaddingPx1x'),
        minimum,
      ),
    ];
    radius = Math.min(...half) * pick('standingCornerRadiusFraction');
    angleDeg = (Math.atan2(axes.major[1], axes.major[0]) * 180) / Math.PI;
    // Keep the angle in (-90, 90]; a rectangle rotated by 180 degrees is the
    // same rectangle, and a stable number is easier to diff.
    if (angleDeg > 90) angleDeg -= 180;
    if (angleDeg <= -90) angleDeg += 180;
  }
  return {
    kind: 'rounded-rect',
    centre: [centre[0] - anchorX, centre[1] - anchorY],
    half,
    radius,
    angleDeg,
    sigmaPx1x: blob.lying ? pick('sigmaPx1x') : pick('standingSigmaPx1x'),
    coreAlpha: pick('coreAlpha'),
    colour: hexRgb(pick('colorHex')),
    lying: blob.lying,
  };
}

/** Axis-aligned bounds of a rotated rounded rectangle, in shape space. */
export function shapeBounds(shape) {
  const radians = (shape.angleDeg * Math.PI) / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  const x = shape.half[0] * cos + shape.half[1] * sin;
  const y = shape.half[0] * sin + shape.half[1] * cos;
  return {
    left: shape.centre[0] - x,
    top: shape.centre[1] - y,
    right: shape.centre[0] + x,
    bottom: shape.centre[1] + y,
  };
}

/**
 * Fill `mask` (a Float64Array of `width * height` covering the rect
 * `[originX, originX + width) x [originY, originY + height)`) with the shape's
 * hard coverage. Pixel centres are at +0.5, the same convention as the baker.
 */
export function fillShape(mask, stride, originX, originY, width, height, shape) {
  const radians = (shape.angleDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const bounds = shapeBounds(shape);
  const x0 = Math.max(0, Math.floor(bounds.left - originX));
  const x1 = Math.min(width, Math.ceil(bounds.right - originX));
  const y0 = Math.max(0, Math.floor(bounds.top - originY));
  const y1 = Math.min(height, Math.ceil(bounds.bottom - originY));
  const [halfX, halfY] = shape.half;
  const innerX = halfX - shape.radius;
  const innerY = halfY - shape.radius;
  const radiusSquared = shape.radius * shape.radius;
  for (let y = y0; y < y1; y += 1) {
    const dy = originY + y + 0.5 - shape.centre[1];
    for (let x = x0; x < x1; x += 1) {
      const dx = originX + x + 0.5 - shape.centre[0];
      const u = dx * cos + dy * sin;
      const v = -dx * sin + dy * cos;
      if (Math.abs(u) > halfX || Math.abs(v) > halfY) continue;
      const qx = Math.abs(u) - innerX;
      const qy = Math.abs(v) - innerY;
      const outside = Math.max(qx, 0) ** 2 + Math.max(qy, 0) ** 2;
      if (outside <= radiusSquared) mask[y * stride + x] = 1;
    }
  }
}

/** Separable Gaussian blur with zero padding, matching the baker's kernel. */
export function gaussianBlur(field, width, height, sigma) {
  if (sigma <= 0) return field;
  const radius = Math.max(1, Math.ceil(3 * sigma));
  const kernel = new Float64Array(2 * radius + 1);
  let total = 0;
  for (let i = -radius; i <= radius; i += 1) {
    const weight = Math.exp(-0.5 * (i / sigma) ** 2);
    kernel[i + radius] = weight;
    total += weight;
  }
  for (let i = 0; i < kernel.length; i += 1) kernel[i] /= total;
  const rows = new Float64Array(field.length);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const sx = x + k;
        if (sx < 0 || sx >= width) continue;
        sum += kernel[k + radius] * field[row + sx];
      }
      rows[row + x] = sum;
    }
  }
  const out = new Float64Array(field.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const sy = y + k;
        if (sy < 0 || sy >= height) continue;
        sum += kernel[k + radius] * rows[sy * width + x];
      }
      out[y * width + x] = sum;
    }
  }
  return out;
}

/**
 * The shadow alpha field for a group.
 *
 * `shapes` are already in the layer's coordinate space (the caller adds the
 * blur padding). `mode` is the comparison switch:
 *   - `merged`   — the group recipe: union the hard shapes, blur once.
 *   - `perTile`  — the Phase 1d contract: blur each shape, take the max.
 * They agree for one tile and diverge where tiles touch.
 */
export function shadowAlpha(width, height, shapes, mode = 'merged') {
  if (shapes.length === 0) return new Float64Array(width * height);
  const sigma = shapes[0].sigmaPx1x;
  const coreAlpha = shapes[0].coreAlpha;
  if (mode === 'merged') {
    const mask = new Float64Array(width * height);
    for (const shape of shapes) fillShape(mask, width, 0, 0, width, height, shape);
    const blurred = gaussianBlur(mask, width, height, sigma);
    for (let i = 0; i < blurred.length; i += 1) blurred[i] = Math.min(1, blurred[i] * coreAlpha);
    return blurred;
  }
  const alpha = new Float64Array(width * height);
  const radius = Math.max(1, Math.ceil(3 * sigma));
  for (const shape of shapes) {
    const bounds = shapeBounds(shape);
    const left = Math.max(0, Math.floor(bounds.left) - radius);
    const top = Math.max(0, Math.floor(bounds.top) - radius);
    const right = Math.min(width, Math.ceil(bounds.right) + radius);
    const bottom = Math.min(height, Math.ceil(bounds.bottom) + radius);
    const w = right - left;
    const h = bottom - top;
    if (w <= 0 || h <= 0) continue;
    const mask = new Float64Array(w * h);
    fillShape(mask, w, left, top, w, h, shape);
    const blurred = gaussianBlur(mask, w, h, sigma);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const value = Math.min(1, blurred[y * w + x] * coreAlpha);
        const target = (top + y) * width + left + x;
        if (value > alpha[target]) alpha[target] = value;
      }
    }
  }
  return alpha;
}

/** Composite the shadow alpha field over an RGBA image (straight alpha). */
export function shadowOverRgba(image, alpha, colour) {
  const pixels = image.width * image.height;
  for (let i = 0; i < pixels; i += 1) {
    const a = alpha[i];
    if (a <= 0) continue;
    const base = i * 4;
    for (let c = 0; c < 3; c += 1) {
      image.data[base + c] = Math.round(image.data[base + c] * (1 - a) + colour[c] * a);
    }
    image.data[base + 3] = 255;
  }
}
