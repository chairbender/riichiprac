#!/usr/bin/env node
/**
 * Bake the Task 4 flat tile-face atlas (`tile_faces.png` + `tile_faces.json`).
 *
 *   node tools/render/scripts/bake-tile-faces-atlas.mjs
 *
 * Task 4 of `2_5d_implementation_plan.md`: pack flat, orthographic, high
 * contrast graphics for the 34 standard faces plus the three red fives into one
 * atlas with a machine-readable region map. The masters are exactly the
 * `faces-spec.json` glyphs and the `face-raster.mjs` configuration the committed
 * `faces/*.png` set uses: one 288 x 384 transparent cell per face, the upstream
 * symbol-only SVG at its uniform 0.96 canvas scale, red fills recoloured with
 * the same paint pair. There is no perspective, no body shading and no
 * per-bucket variant.
 *
 * The atlas is a stable contract, not throwaway art: Task 4B carves the glyphs
 * into 3D and bakes the relief atlases from this same order, and Task 5 maps a
 * cell rect onto a blank's published `faceQuad`. The order is therefore the 34
 * standard faces (1m-9m, 1p-9p, 1s-9s, 1z-7z) followed by the three red fives,
 * row-major in a 6 x 7 grid. Appending is safe; re-sorting the first 37 is not.
 *
 * The red fives are published under the repository's `5mr`/`5pr`/`5sr` ids with
 * the implementation plan's `0m`/`0p`/`0s` names as lookup aliases.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recolourReds, rasterizeSvg } from './face-raster.mjs';
import { decodePng, encodePng } from './png.mjs';

const renderDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const spec = JSON.parse(readFileSync(join(renderDir, 'faces-spec.json'), 'utf8'));
const atlasSpec = JSON.parse(readFileSync(join(renderDir, 'board-assets-spec.json'), 'utf8'));

const columns = Number(atlasSpec.atlas.columns);
const rows = Number(atlasSpec.atlas.rows);
const cellWidth = Number(spec.raster.width);
const cellHeight = Number(spec.raster.height);
const shapeRendering = spec.raster.shapeRendering;
const paint = spec.raster.paint ?? {};
const atlasWidth = columns * cellWidth;
const atlasHeight = rows * cellHeight;
const threshold = 8;

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

const STANDARD = [
  ...['m', 'p', 's'].flatMap((suit) => Array.from({ length: 9 }, (_, i) => `${i + 1}${suit}`)),
  ...Array.from({ length: 7 }, (_, i) => `${i + 1}z`),
];
const REDS = ['5mr', '5pr', '5sr'];
const ORDER = [...STANDARD, ...REDS];
const ALIASES = { '0m': '5mr', '0p': '5pr', '0s': '5sr' };

const specFaces = new Map(spec.faces.map((face) => [face.id, face]));
if (ORDER.length !== 37) throw new Error(`atlas order has ${ORDER.length} faces, expected 37`);
for (const id of ORDER) {
  if (!specFaces.has(id)) throw new Error(`faces-spec.json has no face ${id}`);
}
if (columns * rows < ORDER.length) {
  throw new Error(`the ${columns} x ${rows} atlas has only ${columns * rows} cells`);
}

const atlas = Buffer.alloc(atlasWidth * atlasHeight * 4);
const faces = {};
const order = [];

function measure(data, width, height) {
  let inkPixels = 0;
  let opaquePixels = 0;
  let redPixels = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      if (a > threshold) {
        inkPixels += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (a > 250) opaquePixels += 1;
        if (r > g + 40 && r > b + 40) redPixels += 1;
      }
    }
  }
  return {
    inkPixels,
    inkFraction: Number((inkPixels / (width * height)).toFixed(4)),
    opaquePixels,
    redPixels,
    inkBBox: maxX < 0 ? null : { left: minX, top: minY, right: maxX, bottom: maxY },
  };
}

function pickFaceMeta(face) {
  const meta = { kind: face.kind };
  if (face.suit) meta.suit = face.suit;
  if (face.rank) meta.rank = face.rank;
  if (face.red) meta.red = face.red;
  if (face.honour) meta.honour = face.honour;
  return meta;
}

ORDER.forEach((id, index) => {
  const face = specFaces.get(id);
  const sourcePath = resolve(renderDir, face.source);
  const svg = readFileSync(sourcePath, 'utf8');
  const recoloured = recolourReds(svg, paint.redBase, paint.red);
  const rendered = rasterizeSvg(recoloured.svg, { width: cellWidth, shapeRendering });
  const png = rendered.asPng();
  const glyph = decodePng(png, `atlas/${id}`);
  if (glyph.width !== cellWidth || glyph.height !== cellHeight) {
    throw new Error(
      `atlas/${id} rasterised to ${glyph.width}x${glyph.height}, expected ${cellWidth}x${cellHeight}`,
    );
  }
  const column = index % columns;
  const row = Math.floor(index / columns);
  const x = column * cellWidth;
  const y = row * cellHeight;

  // Copy the glyph straight into its cell. resvg's RGB is premultiplied-free
  // straight alpha and the destination starts zeroed, so this is an exact copy
  // of the master, not a reduction.
  for (let py = 0; py < cellHeight; py += 1) {
    glyph.data.copy(
      atlas,
      ((y + py) * atlasWidth + x) * 4,
      py * cellWidth * 4,
      (py + 1) * cellWidth * 4,
    );
  }

  const measured = measure(glyph.data, cellWidth, cellHeight);
  const region = { x, y, width: cellWidth, height: cellHeight };
  faces[id] = {
    index,
    row,
    column,
    region,
    sourceSvg: face.source,
    upstreamPath: `${spec.source.path}/${face.source.split('/').pop()}`,
    ...pickFaceMeta(face),
    redFillsRecoloured: recoloured.replaced,
    measured,
    sha256: { decodedRgba: sha256(glyph.data) },
  };
  order.push(id);
  console.log(
    `[atlas] ${id.padEnd(4)} cell ${column},${row} (${x},${y}) ink ${measured.inkPixels}`,
  );
});

const atlasPath = resolve(renderDir, atlasSpec.atlas.file);
const manifestPath = resolve(renderDir, atlasSpec.atlas.manifest);
mkdirSync(dirname(atlasPath), { recursive: true });
const atlasPng = encodePng(atlasWidth, atlasHeight, 4, atlas);
writeFileSync(atlasPath, atlasPng);

const inked = ORDER.filter((id) => (faces[id].measured.inkPixels ?? 0) > 0);
const emptyFaces = ORDER.filter((id) => (faces[id].measured.inkPixels ?? 0) === 0);
const manifest = {
  version: 1,
  generatedBy: 'tools/render/scripts/bake-tile-faces-atlas.mjs',
  source: spec.source,
  order,
  aliases: ALIASES,
  coordinateSpace:
    'One 288 x 384 RGBA cell per face on a transparent background, row-major in a ' +
    '6 x 7 atlas. A cell rect maps directly onto a blank tile\'s faceQuad (TL, TR, BR, BL); ' +
    'there is no perspective and no per-bucket copy. Cells are laid out in the published ' +
    'order array: the 34 standard faces then the three red fives.',
  raster: {
    cellWidth,
    cellHeight,
    columns,
    rows,
    gutterPx: 0,
    format: '8-bit RGBA PNG',
    shapeRendering,
    paint,
    note:
      'Each face uses the same faces-spec.json raster width, the same uniform upstream ' +
      '0.96 canvas scale and the same resvg geometric-precision mode, so every glyph has ' +
      'one radial scale and one centre across the atlas.',
  },
  atlas: {
    file: 'tile_faces.png',
    width: atlasWidth,
    height: atlasHeight,
    columns,
    rows,
    cellWidth,
    cellHeight,
    gutterPx: 0,
    bytes: atlasPng.length,
    sha256: { decodedRgba: sha256(atlas) },
  },
  blank: {
    face: '5z',
    reason:
      'A white dragon has no printed symbol, so its symbol-only SVG rasterises to zero ' +
      'ink. It is still a real face id with its own cell; the compositor draws the bare ' +
      'ivory body for it, exactly like faces.json records.',
  },
  totals: {
    faces: ORDER.length,
    inkedFaces: inked.length,
    emptyFaces: emptyFaces.length,
    cells: columns * rows,
    atlasBytes: atlasPng.length,
  },
  faces,
};

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `[atlas] ${ORDER.length} faces (${inked.length} inked) in ${atlasWidth}x${atlasHeight}, ` +
    `${atlasPng.length} B`,
);
console.log(`[atlas] ${atlasPath}`);
console.log(`[atlas] ${manifestPath}`);
