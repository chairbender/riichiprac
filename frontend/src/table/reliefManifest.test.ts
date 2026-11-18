import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseReliefManifest, reliefCellFor } from './reliefManifest';

const tableDir = fileURLToPath(new URL('../../public/table/', import.meta.url));
const raw = JSON.parse(readFileSync(join(tableDir, 'relief.json'), 'utf8'));
const relief = parseReliefManifest(raw);

describe('relief.json contract', () => {
  it('parses the three committed atlases and 37 face cells', () => {
    expect(relief.raster).toMatchObject({
      cellWidth: 256,
      cellHeight: 340,
      columns: 6,
      rows: 7,
      atlasWidth: 1536,
      atlasHeight: 2380,
    });
    expect(relief.atlases.albedo.file).toBe('relief/face_albedo.png');
    expect(relief.atlases.normalDepth.file).toBe('relief/face_normal_depth.png');
    expect(relief.atlases.aoRoughness.file).toBe('relief/face_ao_roughness.png');
    expect(Object.keys(relief.cells)).toHaveLength(37);
    expect(relief.cells.blank).toBeUndefined();
    expect(reliefCellFor(relief, 'blank')).toBeNull();
    expect(relief.cells['1m']).toMatchObject({ index: 0, column: 0, row: 0, x: 0, y: 0 });
    expect(relief.cells['5z'].x).toBe(4 * 256);
    // The carve's physical depth is published in tile units (28 mm tile).
    expect(relief.carve.depthUnits).toBeCloseTo(0.55 / 28, 6);
    expect(relief.carve.wallRunUnits).toBeGreaterThan(0);
  });

  it('rejects a missing face, an unknown face and a cell outside the atlas', () => {
    const clone = () => JSON.parse(JSON.stringify(raw));
    const missing = clone();
    delete missing.raster.cells['1m'];
    expect(() => parseReliefManifest(missing)).toThrow(/no cell for 1m/);

    const unknown = clone();
    unknown.raster.cells['9z'] = { ...unknown.raster.cells['1m'] };
    expect(() => parseReliefManifest(unknown)).toThrow(/unknown face 9z/);

    const outside = clone();
    outside.raster.cells['1m'].x = outside.raster.atlasWidth - 10;
    expect(() => parseReliefManifest(outside)).toThrow(/outside the 1536x2380 atlas/);

    const badRect = clone();
    badRect.raster.cells['1m'].rect = [0, 0, 1];
    expect(() => parseReliefManifest(badRect)).toThrow(/must be \[x0, y0, x1, y1\]/);
  });
});
