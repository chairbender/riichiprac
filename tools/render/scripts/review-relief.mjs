#!/usr/bin/env node
/**
 * Review sheets for the Task 4B orthographic carved relief maps.
 *
 *   node tools/render/scripts/review-relief.mjs [--build]
 *
 * These are throwaway artefacts for the user's visual sign-off (AGENTS.md §6),
 * never shipped and never committed (`build/` is gitignored). They are built
 * from the committed atlases and the manifest — not from a hand-composed
 * mock-up — so what they show is exactly the pixels the runtime will sample:
 *
 *   relief-contact-sheet.png   every face, four panels per face: the albedo
 *                              over ivory, the normal+depth RGB, cavity AO (R)
 *                              and roughness (G) as grey, with the measured
 *                              wall angle and AO printed per face
 *   relief-zoom-<face>-4x.png  4x nearest zoom of a dense crop, all four panels
 *                              side by side
 *   relief-alignment-<face>.png  4x alignment proof: the paint silhouette drawn
 *                              in red over each map, so a shift of the paint,
 *                              the carve wall, the depth ramp or the roughness
 *                              gate would be visible as a red line off the
 *                              feature; the printed numbers are the same ones
 *                              check-relief.mjs asserts
 *   relief-numbers.json        the numbers the sheet prints
 *
 * AGENTS.md §6: the agent does not judge these images. Hand the paths to the
 * user with the numbers already checked.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng, readPng, zoomNearest } from './png.mjs';
import { drawText, textWidth } from './label-font.mjs';

const renderDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tableDir = resolve(renderDir, '../../frontend/public/table');
const build = process.argv.includes('--build');
const outIndex = process.argv.indexOf('--out');
const outDir = outIndex >= 0 ? resolve(process.argv[outIndex + 1]) : join(renderDir, 'build/relief/review');
const manifestPath = build ? join(renderDir, 'build/relief/preview.json') : join(tableDir, 'relief.json');
const assetRoot = build ? join(renderDir, 'build/relief') : tableDir;

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const spec = JSON.parse(readFileSync(join(renderDir, 'relief-spec.json'), 'utf8'));
const facesSpec = JSON.parse(readFileSync(join(renderDir, spec.source.facesSpec), 'utf8'));
const ivory = [0xf5, 0xf0, 0xeb];
const cellWidth = manifest.raster.cellWidth;
const cellHeight = manifest.raster.cellHeight;

const atlases = {
  albedo: readPng(join(assetRoot, manifest.atlases.face_albedo.file)),
  normal: readPng(join(assetRoot, manifest.atlases.face_normal_depth.file)),
  material: readPng(join(assetRoot, manifest.atlases.face_ao_roughness.file)),
};

function canvas(width, height, rgb = [20, 24, 28]) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return { width, height, data, channels: 4 };
}

function put(target, x, y, rgb) {
  if (x < 0 || y < 0 || x >= target.width || y >= target.height) return;
  const i = (y * target.width + x) * 4;
  target.data[i] = rgb[0];
  target.data[i + 1] = rgb[1];
  target.data[i + 2] = rgb[2];
  target.data[i + 3] = 255;
}

function fill(target, x, y, width, height, rgb) {
  for (let dy = 0; dy < height; dy += 1) {
    for (let dx = 0; dx < width; dx += 1) put(target, x + dx, y + dy, rgb);
  }
}

function cellPixel(image, cell, x, y) {
  const index = ((cell.y + y) * image.width + (cell.x + x)) * 4;
  return [
    image.data[index],
    image.data[index + 1],
    image.data[index + 2],
    image.data[index + 3],
  ];
}

/** One panel of `scale`-downsampled cell, mode picks the channel to show. */
function drawPanel(target, x, y, cell, mode, scale) {
  const panelWidth = Math.floor(cellWidth / scale);
  const panelHeight = Math.floor(cellHeight / scale);
  for (let py = 0; py < panelHeight; py += 1) {
    for (let px = 0; px < panelWidth; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const sx = Math.min(cellWidth - 1, px * scale + dx);
          const sy = Math.min(cellHeight - 1, py * scale + dy);
          let sample;
          if (mode === 'albedo') sample = cellPixel(atlases.albedo, cell, sx, sy);
          else if (mode === 'normal') sample = cellPixel(atlases.normal, cell, sx, sy);
          else if (mode === 'ao') {
            const material = cellPixel(atlases.material, cell, sx, sy);
            sample = [material[0], material[0], material[0], 255];
          } else if (mode === 'roughness') {
            const material = cellPixel(atlases.material, cell, sx, sy);
            sample = [material[1], material[1], material[1], 255];
          } else {
            throw new Error(`unknown panel mode ${mode}`);
          }
          r += sample[0];
          g += sample[1];
          b += sample[2];
          a += sample[3];
          count += 1;
        }
      }
      r /= count;
      g /= count;
      b /= count;
      a /= count / 255;
      if (mode === 'albedo') {
        // Straight-alpha composite of the pigment over the shell's ivory face:
        // un-carved resin shows the ivory, the painted groove shows pigment.
        const alpha = a / 255;
        put(target, x + px, y + py, [
          Math.round(r * alpha + ivory[0] * (1 - alpha)),
          Math.round(g * alpha + ivory[1] * (1 - alpha)),
          Math.round(b * alpha + ivory[2] * (1 - alpha)),
        ]);
      } else {
        put(target, x + px, y + py, [Math.round(r), Math.round(g), Math.round(b)]);
      }
    }
  }
}

function panelWidth(scale) {
  return Math.floor(cellWidth / scale);
}
function panelHeight(scale) {
  return Math.floor(cellHeight / scale);
}

function label(target, text, x, y, scale = 1, rgb = [220, 226, 220]) {
  drawText(target, text, x, y, { scale, rgb });
}

const item = (id) => manifest.faces[id];

function contactSheet() {
  const scale = 2;
  const pw = panelWidth(scale);
  const ph = panelHeight(scale);
  const labelWidth = 150;
  const gap = 8;
  const blockWidth = labelWidth + 4 * pw + 3 * gap;
  const perRow = 3;
  const rows = Math.ceil(Object.keys(manifest.faces).length / perRow);
  const header = 42;
  const titleRgb = [255, 235, 160];
  const width = perRow * (blockWidth + 16) + 16;
  const height = header + rows * (ph + 30) + 16;
  const sheet = canvas(width, height);
  label(sheet, 'RELIEF CONTACT SHEET - ALBEDO / NORMAL+DEPTH / AO / ROUGHNESS', 14, 12, 2, titleRgb);
  label(
    sheet,
    `${manifest.raster.atlasWidth}X${manifest.raster.atlasHeight} ATLAS, ${cellWidth}X${cellHeight} PER FACE, ${manifest.raster.faceCount ?? Object.keys(manifest.faces).length} FACES - PANELS AT 1/2`,
    14,
    30,
    1,
  );
  const ids = Object.keys(manifest.faces);
  ids.forEach((id, index) => {
    const column = index % perRow;
    const row = Math.floor(index / perRow);
    const x = 16 + column * (blockWidth + 16);
    const y = header + row * (ph + 30);
    const cell = item(id).cell;
    const measured = item(id).measured;
    drawPanel(sheet, x + labelWidth, y, cell, 'albedo', scale);
    drawPanel(sheet, x + labelWidth + pw + gap, y, cell, 'normal', scale);
    drawPanel(sheet, x + labelWidth + 2 * (pw + gap), y, cell, 'ao', scale);
    drawPanel(sheet, x + labelWidth + 3 * (pw + gap), y, cell, 'roughness', scale);
    label(sheet, id.toUpperCase(), x, y + 4, 2, titleRgb);
    const lines = [
      `PIGMENT A ${measured.paintPixels} PX`,
      `WALL P50 ${measured.wallAngleP50} P90 ${measured.wallAngleP90} DEG`,
      `AO MIN ${measured.aoMin}`,
      `DEPTH 1 -> ${measured.depthMin}`,
    ];
    lines.forEach((line, lineIndex) => label(sheet, line, x, y + 30 + lineIndex * 11, 1));
    label(sheet, 'ALBEDO', x + labelWidth + 2, y + ph + 2, 1);
    label(sheet, 'NORMAL', x + labelWidth + pw + gap + 2, y + ph + 2, 1);
    label(sheet, 'AO', x + labelWidth + 2 * (pw + gap) + 2, y + ph + 2, 1);
    label(sheet, 'ROUGH', x + labelWidth + 3 * (pw + gap) + 2, y + ph + 2, 1);
  });
  return sheet;
}

function densestCrop(cell, size) {
  // The densest 1/4-scale paint window in the cell, so the zoom lands on a
  // stroke junction rather than an empty corner.
  const step = 4;
  let best = { x: 0, y: 0, score: -1 };
  for (let y = 0; y + size <= cellHeight; y += step) {
    for (let x = 0; x + size <= cellWidth; x += step) {
      let score = 0;
      for (let dy = 0; dy < size; dy += 4) {
        for (let dx = 0; dx < size; dx += 4) {
          if (cellPixel(atlases.albedo, cell, x + dx, y + dy)[3] > 127) score += 1;
        }
      }
      if (score > best.score) best = { x, y, score };
    }
  }
  return best;
}

function zoomPanel(cell, originX, originY, size, mode, factor) {
  const panel = { width: size, height: size, data: Buffer.alloc(size * size * 4), channels: 4 };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let sample;
      if (mode === 'albedo') sample = cellPixel(atlases.albedo, cell, originX + x, originY + y);
      else if (mode === 'normal') sample = cellPixel(atlases.normal, cell, originX + x, originY + y);
      else if (mode === 'depth') {
        const depth = cellPixel(atlases.normal, cell, originX + x, originY + y)[3];
        sample = [depth, depth, depth, 255];
      } else if (mode === 'ao') {
        const ao = cellPixel(atlases.material, cell, originX + x, originY + y)[0];
        sample = [ao, ao, ao, 255];
      } else if (mode === 'roughness') {
        const rough = cellPixel(atlases.material, cell, originX + x, originY + y)[1];
        sample = [rough, rough, rough, 255];
      } else throw new Error(`unknown zoom mode ${mode}`);
      const offset = (y * size + x) * 4;
      panel.data[offset] = sample[0];
      panel.data[offset + 1] = sample[1];
      panel.data[offset + 2] = sample[2];
      panel.data[offset + 3] = 255;
    }
  }
  return zoomNearest(panel, 0, 0, size, size, factor);
}

function boundaryMask(cell, size, originX, originY) {
  // Paint boundary = paint minus its 1 px erosion, over the crop.
  const paint = (x, y) => cellPixel(atlases.albedo, cell, x, y)[3] > 127;
  const mask = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const cx = originX + x;
      const cy = originY + y;
      if (!paint(cx, cy)) continue;
      let edge = false;
      for (const [dx, dy] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ]) {
        if (!paint(cx + dx, cy + dy)) {
          edge = true;
          break;
        }
      }
      if (edge) mask.push([x, y]);
    }
  }
  return mask;
}

function withBoundary(panel, boundary, factor) {
  for (const [x, y] of boundary) {
    for (let dy = 0; dy < factor; dy += 1) {
      for (let dx = 0; dx < factor; dx += 1) {
        const px = x * factor + dx;
        const py = y * factor + dy;
        const offset = (py * panel.width + px) * 4;
        panel.data[offset] = 255;
        panel.data[offset + 1] = 40;
        panel.data[offset + 2] = 40;
        panel.data[offset + 3] = 255;
      }
    }
  }
  return panel;
}

function alignmentSheet(faceId) {
  const cell = item(faceId).cell;
  const measured = item(faceId).measured;
  const size = 96;
  const factor = 4;
  const origin = densestCrop(cell, size);
  const boundary = boundaryMask(cell, size, origin.x, origin.y);
  const modes = ['albedo', 'depth', 'ao', 'roughness'];
  const titles = ['ALBEDO + PAINT EDGE', 'DEPTH + PAINT EDGE', 'AO + PAINT EDGE', 'ROUGHNESS + PAINT EDGE'];
  const zoomed = modes.map((mode) => withBoundary(zoomPanel(cell, origin.x, origin.y, size, mode, factor), boundary, factor));
  const panel = zoomed[0].width;
  const gap = 12;
  const header = 66;
  const footer = 74;
  const width = 16 + modes.length * panel + (modes.length - 1) * gap + 16;
  const height = header + panel + footer;
  const sheet = canvas(width, height);
  label(sheet, `ALIGNMENT PROOF - ${faceId.toUpperCase()} - 4X ZOOM`, 16, 12, 2, [255, 235, 160]);
  label(
    sheet,
    `PAINT EDGE DRAWN IN RED ON ALL THREE MAPS; IT MUST SIT ON THE SAME STROKE OUTLINE. ` +
      `CROP ${size}X${size} AT (${origin.x},${origin.y}).`,
    16,
    32,
    1,
  );
  zoomed.forEach((image, index) => {
    const x = 16 + index * (panel + gap);
    for (let y = 0; y < image.height; y += 1) {
      for (let px = 0; px < image.width; px += 1) {
        const source = (y * image.width + px) * 4;
        put(sheet, x + px, header + y, [
          image.data[source],
          image.data[source + 1],
          image.data[source + 2],
        ]);
      }
    }
    label(sheet, titles[index], x, header - 14, 1);
  });
  const lines = [
    `PAINT ${measured.paintPixels} PX   WALL P50 ${measured.wallAngleP50} / P90 ${measured.wallAngleP90} / MAX ${measured.wallAngleMax} DEG`,
    `AO MIN ${measured.aoMin}   AO OPEN MEAN ${measured.aoOpenMean}   DEPTH 1 -> ${measured.depthMin}   OPEN FACE ${(measured.openFaceFraction * 100).toFixed(1)}%`,
    `ROUGH PAINT ${measured.roughnessPaintMean}   ROUGH OPEN ${measured.roughnessOpenMean}   ALBEDO CORNERS ${measured.cornerAlpha.join('/')}`,
  ];
  lines.forEach((line, index) => label(sheet, line, 16, header + panel + 12 + index * 13, 1));
  return { sheet, origin, size };
}

mkdirSync(outDir, { recursive: true });

const sheet = contactSheet();
writeFileSync(join(outDir, 'relief-contact-sheet.png'), encodePng(sheet.width, sheet.height, 4, sheet.data));
console.log(`[relief-review] contact sheet: ${outDir}/relief-contact-sheet.png (${sheet.width}x${sheet.height})`);

const inked = Object.keys(manifest.faces).filter((id) => item(id).measured.paintPixels > 0);
const zoomFace =
  inked.find((id) => id === '8s') ??
  inked.sort((a, b) => item(b).measured.paintPixels - item(a).measured.paintPixels)[0] ??
  Object.keys(manifest.faces)[0];
{
  const cell = item(zoomFace).cell;
  const size = 96;
  const factor = 4;
  const origin = densestCrop(cell, size);
  const modes = ['albedo', 'normal', 'ao', 'roughness'];
  const titles = ['ALBEDO', 'NORMAL+DEPTH', 'CAVITY AO (R)', 'ROUGHNESS (G)'];
  const panels = modes.map((mode) => zoomPanel(cell, origin.x, origin.y, size, mode, factor));
  const panel = panels[0].width;
  const gap = 12;
  const header = 56;
  const width = 16 + panels.length * panel + (panels.length - 1) * gap + 16;
  const height = header + panel + 30;
  const zoomSheet = canvas(width, height);
  label(zoomSheet, `RELIEF ${zoomFace.toUpperCase()} - 4X ZOOM, ONE CROP THROUGH ALL MAPS`, 16, 12, 2, [255, 235, 160]);
  label(zoomSheet, `CROP ${size}X${size} AT (${origin.x},${origin.y}); PANELS ARE THE SAME PIXELS.`, 16, 32, 1);
  panels.forEach((image, index) => {
    const x = 16 + index * (panel + gap);
    for (let y = 0; y < image.height; y += 1) {
      for (let px = 0; px < image.width; px += 1) {
        const source = (y * image.width + px) * 4;
        put(zoomSheet, x + px, header + y, [
          image.data[source],
          image.data[source + 1],
          image.data[source + 2],
        ]);
      }
    }
    label(zoomSheet, titles[index], x, header - 14, 1);
  });
  writeFileSync(
    join(outDir, `relief-zoom-${zoomFace}-4x.png`),
    encodePng(zoomSheet.width, zoomSheet.height, 4, zoomSheet.data),
  );
  console.log(`[relief-review] zoom sheet: ${outDir}/relief-zoom-${zoomFace}-4x.png`);
}

const alignment = alignmentSheet(zoomFace);
writeFileSync(
  join(outDir, `relief-alignment-${zoomFace}.png`),
  encodePng(alignment.sheet.width, alignment.sheet.height, 4, alignment.sheet.data),
);
console.log(`[relief-review] alignment sheet: ${outDir}/relief-alignment-${zoomFace}.png`);

const numbers = {
  manifest: manifestPath,
  atlases: manifest.atlases,
  faces: manifest.faces,
  totals: manifest.totals,
  alignmentCrop: { face: zoomFace, size: alignment.size, x: alignment.origin.x, y: alignment.origin.y },
};
writeFileSync(join(outDir, 'relief-numbers.json'), JSON.stringify(numbers, null, 2) + '\n');
console.log(`[relief-review] numbers: ${outDir}/relief-numbers.json`);
