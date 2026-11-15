#!/usr/bin/env node
/**
 * Fast single-shell blob-shadow preview, with no Blender and no catalogue bake.
 *
 *   node tools/render/scripts/preview-shadow.mjs --id shell_flat_upright
 *
 * The committed body PNG and its measured table-contact footprint are already
 * in `shells.json`, so the shadow can be regenerated from the current
 * `shell-spec.json` parameters in a fraction of a second. This writes
 * `build/preview/shadow-<id>-1x.png`, a 3x zoom, and the shadow-only sprite.
 *
 * This is a preview only. The canonical shadow is baked by `bake_shells.py`;
 * the math below mirrors the rounded-rectangle branches in
 * `blob_shadow()` so the preview and the bake agree.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drawSprite, encodePng, readPng, zoomNearest } from './png.mjs';

const renderDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const idIndex = args.indexOf('--id');
const id = idIndex >= 0 ? args[idIndex + 1] : 'shell_flat_upright';
const outIndex = args.indexOf('--out');
const outDir = outIndex >= 0 ? resolve(args[outIndex + 1]) : join(renderDir, 'build', 'preview');

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const spec = await readJson(join(renderDir, 'shell-spec.json'));
const feltSpec = await readJson(join(renderDir, 'felt-spec.json'));
const manifestPath = join(renderDir, spec.outputs.manifest);
const manifest = await readJson(manifestPath);
const tableDir = resolve(dirname(manifestPath));
const shell = manifest.shells[id];
if (!shell) throw new Error(`shells.json has no ${id}`);

const bake = spec.bake;
const shadow = bake.shadow;
const lying = shell.shadowBlob?.lying === true;
const pads = lying ? shadow.padding1x : shadow.standingPadding1x ?? shadow.padding1x;
const scale = 1; // the preview is @1x
const coreAlpha = shadow.coreAlpha;
const offset = shadow.offsetPx1x.map((value) => value * scale);

const body = readPng(resolve(tableDir, shell.textureFile));
const bodyAnchor = [shell.anchorX, shell.anchorY];
const advance = [shell.advanceWidth, shell.advanceHeight];
const shadowWidth = advance[0] + pads.left + pads.right;
const shadowHeight = advance[1] + pads.top + pads.bottom;
const bodyCentre = [pads.left + advance[0] / 2, pads.top + advance[1] / 2];

// The committed contact quad is in the old shadow box; move it to body-box coords.
const contact = (shell.measured?.contactQuadPx ?? []).map(([x, y]) => [
  x - shell.shadowAnchorX,
  y - shell.shadowAnchorY,
]);
if (contact.length < 2) throw new Error(`${id} has no measured contact footprint`);

function gaussianBlur(field, width, height, value) {
  if (value <= 0) return field;
  const radius = Math.max(1, Math.ceil(3 * value));
  const kernel = [];
  let sum = 0;
  for (let i = -radius; i <= radius; i += 1) {
    const weight = Math.exp(-0.5 * (i / value) ** 2);
    kernel.push(weight);
    sum += weight;
  }
  for (let i = 0; i < kernel.length; i += 1) kernel[i] /= sum;

  const paddedWidth = width + 2 * radius;
  const padded = new Float32Array(paddedWidth * (height + 2 * radius));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      padded[(y + radius) * paddedWidth + x + radius] = field[y * width + x];
    }
  }

  // Vertical pass first, then horizontal, so both tails keep their padding.
  const rows = new Float32Array(paddedWidth * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < paddedWidth; x += 1) {
      let valueAt = 0;
      for (let k = 0; k < kernel.length; k += 1) {
        valueAt += kernel[k] * padded[(y + k) * paddedWidth + x];
      }
      rows[y * paddedWidth + x] = valueAt;
    }
  }
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let valueAt = 0;
      for (let k = 0; k < kernel.length; k += 1) {
        valueAt += kernel[k] * rows[y * paddedWidth + x + k];
      }
      out[y * width + x] = valueAt;
    }
  }
  return out;
}

function principalAxes(points) {
  const cx = points.reduce((sum, p) => sum + p[0], 0) / points.length;
  const cy = points.reduce((sum, p) => sum + p[1], 0) / points.length;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const [x, y] of points) {
    const dx = x - cx;
    const dy = y - cy;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const n = Math.max(1, points.length - 1);
  sxx /= n;
  sxy /= n;
  syy /= n;
  const trace = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const root = Math.sqrt(Math.max(0, (trace * trace) / 4 - det));
  const lambda = trace / 2 + root;
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const majorAxis = [Math.cos(angle), Math.sin(angle)];
  const minorAxis = [-Math.sin(angle), Math.cos(angle)];
  const extent = (axis) =>
    Math.max(...points.map(([x, y]) => Math.abs((x - cx) * axis[0] + (y - cy) * axis[1])));
  return {
    centre: [cx, cy],
    majorAxis,
    minorAxis,
    major: extent(majorAxis),
    minor: extent(minorAxis),
  };
}

const sigma = (lying ? shadow.sigmaPx1x : shadow.standingSigmaPx1x ?? shadow.sigmaPx1x) * scale;
const alpha = new Float32Array(shadowWidth * shadowHeight);
let radius = 0;
let maxContactDistance = 0;
// The contact quad is body-relative; move it into the current shadow box.
const contactShadow = contact.map(([x, y]) => [x + pads.left, y + pads.top]);

if (lying) {
  const trim = shadow.topTrimPx1x ?? 0;
  const cx = bodyCentre[0] + offset[0];
  const cy = bodyCentre[1] + offset[1] + trim / 2;
  const half = [
    (advance[0] / 2) * shadow.rectScale + shadow.rectPaddingPx1x,
    (advance[1] / 2) * shadow.rectScale + shadow.rectPaddingPx1x,
  ];
  half[1] = Math.max(half[1] - trim / 2, 1);
  const corner = Math.min(...half) * shadow.cornerRadiusFraction;
  maxContactDistance = Math.max(
    ...contactShadow.map(([x, y]) =>
      Math.max(Math.abs(x - cx) - half[0], Math.abs(y - cy) - half[1]),
    ),
  );
  for (let y = 0; y < shadowHeight; y += 1) {
    for (let x = 0; x < shadowWidth; x += 1) {
      const dx = Math.abs(x + 0.5 - cx) - (half[0] - corner);
      const dy = Math.abs(y + 0.5 - cy) - (half[1] - corner);
      const outside = Math.max(dx, 0) ** 2 + Math.max(dy, 0) ** 2;
      alpha[y * shadowWidth + x] =
        outside <= corner * corner &&
        Math.abs(x + 0.5 - cx) <= half[0] &&
        Math.abs(y + 0.5 - cy) <= half[1]
          ? 1
          : 0;
    }
  }
  radius = 0;
} else {
  const axes = principalAxes(contactShadow);
  const minimum = shadow.minHalfWidthPx1x;
  const half = [
    Math.max(axes.major * shadow.standingRectScale + shadow.standingRectPaddingPx1x, minimum),
    Math.max(axes.minor * shadow.standingRectScale + shadow.standingRectPaddingPx1x, minimum),
  ];
  const corner = Math.min(...half) * shadow.standingCornerRadiusFraction;
  const cx = axes.centre[0] + offset[0];
  const cy = axes.centre[1] + offset[1];
  const ux = axes.majorAxis[0];
  const uy = axes.majorAxis[1];
  const vx = axes.minorAxis[0];
  const vy = axes.minorAxis[1];
  for (let y = 0; y < shadowHeight; y += 1) {
    for (let x = 0; x < shadowWidth; x += 1) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const u = dx * ux + dy * uy;
      const v = dx * vx + dy * vy;
      const qx = Math.abs(u) - (half[0] - corner);
      const qy = Math.abs(v) - (half[1] - corner);
      const outside = Math.max(qx, 0) ** 2 + Math.max(qy, 0) ** 2;
      alpha[y * shadowWidth + x] =
        outside <= corner * corner && Math.abs(u) <= half[0] && Math.abs(v) <= half[1] ? 1 : 0;
    }
  }
  radius = 0;
}

const blurred = gaussianBlur(alpha, shadowWidth, shadowHeight, sigma);
const [sr, sg, sb] = shadow.colorHex
  .replace('#', '')
  .match(/../g)
  .map((value) => parseInt(value, 16));
const shadowRgba = {
  width: shadowWidth,
  height: shadowHeight,
  channels: 4,
  stride: shadowWidth * 4,
  data: Buffer.alloc(shadowWidth * shadowHeight * 4),
};
for (let i = 0; i < blurred.length; i += 1) {
  shadowRgba.data[i * 4] = sr;
  shadowRgba.data[i * 4 + 1] = sg;
  shadowRgba.data[i * 4 + 2] = sb;
  shadowRgba.data[i * 4 + 3] = Math.round(Math.min(1, Math.max(0, blurred[i] * coreAlpha)) * 255);
}

// Body and shadow compose on the felt at the same grid point.
const pad = 24;
const sheetWidth = Math.max(shadowWidth, pads.left - bodyAnchor[0] + body.width) + 2 * pad;
const sheetHeight = Math.max(shadowHeight, pads.top - bodyAnchor[1] + body.height) + 2 * pad;
const [fr, fg, fb] = feltSpec.baseColor;
const sheet = {
  width: sheetWidth,
  height: sheetHeight,
  channels: 4,
  stride: sheetWidth * 4,
  data: Buffer.alloc(sheetWidth * sheetHeight * 4),
};
for (let i = 0; i < sheetWidth * sheetHeight; i += 1) {
  sheet.data[i * 4] = fr;
  sheet.data[i * 4 + 1] = fg;
  sheet.data[i * 4 + 2] = fb;
  sheet.data[i * 4 + 3] = 255;
}
drawSprite(sheet, shadowRgba, pad, pad);
drawSprite(
  sheet,
  body,
  pad + pads.left - bodyAnchor[0],
  pad + pads.top - bodyAnchor[1],
);

const transparent = {
  width: shadowWidth,
  height: shadowHeight,
  channels: 4,
  stride: shadowWidth * 4,
  data: Buffer.alloc(shadowWidth * shadowHeight * 4),
};
drawSprite(transparent, shadowRgba, 0, 0);

mkdirSync(outDir, { recursive: true });
const write = (name, image) => {
  const path = join(outDir, name);
  const bytes = encodePng(image.width, image.height, image.channels, image.data);
  writeFileSync(path, bytes);
  console.log(`${path}  ${image.width}x${image.height}  ${bytes.length} B`);
};
write(`shadow-${id}-1x.png`, sheet);
write(`shadow-${id}-3x.png`, zoomNearest(sheet, 0, 0, sheet.width, sheet.height, 3));
write(`shadow-${id}-sprite.png`, transparent);

// Numeric base-coverage and edge report (the visual call stays with the user).
const bodyBox = {
  x0: pads.left,
  y0: pads.top,
  x1: pads.left + advance[0] - 1,
  y1: pads.top + advance[1] - 1,
};
const extent = { left: 0, top: 0, right: 0, bottom: 0 };
const peak = { left: 0, top: 0, right: 0, bottom: 0 };
for (let y = 0; y < shadowHeight; y += 1) {
  for (let x = 0; x < shadowWidth; x += 1) {
    const value = shadowRgba.data[(y * shadowWidth + x) * 4 + 3] / 255;
    if (value <= 2 / 255) continue;
    if (x > bodyBox.x1) {
      extent.right = Math.max(extent.right, x - bodyBox.x1);
      if (y >= bodyBox.y0 && y <= bodyBox.y1) peak.right = Math.max(peak.right, value);
    }
    if (x < bodyBox.x0) {
      extent.left = Math.max(extent.left, bodyBox.x0 - x);
      if (y >= bodyBox.y0 && y <= bodyBox.y1) peak.left = Math.max(peak.left, value);
    }
    if (y > bodyBox.y1) {
      extent.bottom = Math.max(extent.bottom, y - bodyBox.y1);
      if (x >= bodyBox.x0 && x <= bodyBox.x1) peak.bottom = Math.max(peak.bottom, value);
    }
    if (y < bodyBox.y0) {
      extent.top = Math.max(extent.top, bodyBox.y0 - y);
      if (x >= bodyBox.x0 && x <= bodyBox.x1) peak.top = Math.max(peak.top, value);
    }
  }
}
console.log(
  `PREVIEW ${id}: rounded-rect, sigma ${sigma} px, ` +
    `core ${coreAlpha}, offset ${offset.join(',')}`,
);
if (lying) {
  const half = [
    (advance[0] / 2) * shadow.rectScale + shadow.rectPaddingPx1x,
    (advance[1] / 2) * shadow.rectScale + shadow.rectPaddingPx1x,
  ];
  half[1] = Math.max(half[1] - (shadow.topTrimPx1x ?? 0) / 2, 1);
  console.log(
    `  contact coverage: contact point is ${maxContactDistance <= 0 ? 'inside' : 'OUTSIDE'} the ` +
      `rounded rect (max overhang ${maxContactDistance.toFixed(1)} px; rect ` +
      `${(half[0] * 2).toFixed(1)}x${(half[1] * 2).toFixed(1)}, corner ` +
      `${(Math.min(...half) * shadow.cornerRadiusFraction).toFixed(1)})`,
  );
}
console.log(
  `  shadow box ${shadowWidth}x${shadowHeight}, extent L${extent.left}/T${extent.top}/` +
    `R${extent.right}/B${extent.bottom}, edge alpha L${peak.left.toFixed(3)}/T${peak.top.toFixed(3)}/` +
    `R${peak.right.toFixed(3)}/B${peak.bottom.toFixed(3)}`,
);
