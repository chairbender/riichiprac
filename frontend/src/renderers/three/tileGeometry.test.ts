import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TILE } from '../layoutConstants';
import {
  FACE_ZONE_ATTRIBUTE,
  TILE_GEOMETRY_ATTRIBUTES,
  TILE_MESH,
  TILE_TRIANGLE_BUDGET,
  buildTileGeometry,
  facePlateUv,
} from './tileGeometry';
import type { TileGeometryData } from './tileGeometry';

/**
 * 3D-04 acceptance, as numbers.
 *
 * These tests pin the mesh's contract with the rest of the 3D chain: the
 * committed proportions, the plate's UV frame, the `faceZone` split the shader
 * branches on, unit normals and tangents, outward winding, the triangle budget
 * and byte-identical rebuilds. None of it inspects a render (AGENTS.md §6).
 */

const HALF_T = TILE.thicknessUnits / 2;

function trianglePositions(
  geometry: TileGeometryData,
  triangle: number,
): [[number, number, number], [number, number, number], [number, number, number]] {
  const read = (offset: number): [number, number, number] => {
    const i = geometry.indices[triangle * 3 + offset] * 3;
    return [
      geometry.positions[i],
      geometry.positions[i + 1],
      geometry.positions[i + 2],
    ];
  };
  return [read(0), read(1), read(2)];
}

function cross(
  a: [number, number, number],
  b: [number, number, number],
): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function subtract(
  a: [number, number, number],
  b: [number, number, number],
): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(
  a: [number, number, number],
  b: [number, number, number],
): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function length(a: [number, number, number]): number {
  return Math.hypot(a[0], a[1], a[2]);
}

/** Twice the triangle area; asserts the mesh has no collapsed triangles. */
function triangleArea(geometry: TileGeometryData, triangle: number): number {
  const [a, b, c] = trianglePositions(geometry, triangle);
  return length(cross(subtract(b, a), subtract(c, a)));
}

/** The closed-mesh signed volume: positive exactly when winding is outward. */
function signedVolume(geometry: TileGeometryData): number {
  let volume = 0;
  for (let triangle = 0; triangle < geometry.triangleCount; triangle++) {
    const [a, b, c] = trianglePositions(geometry, triangle);
    volume += dot(a, cross(b, c)) / 6;
  }
  return volume;
}

function vertex(
  geometry: TileGeometryData,
  index: number,
): [number, number, number] {
  const i = index * 3;
  return [geometry.positions[i], geometry.positions[i + 1], geometry.positions[i + 2]];
}

function normal(geometry: TileGeometryData, index: number): [number, number, number] {
  const i = index * 3;
  return [
    geometry.normals[i],
    geometry.normals[i + 1],
    geometry.normals[i + 2],
  ];
}

function tangent(geometry: TileGeometryData, index: number): [number, number, number] {
  const i = index * 4;
  return [
    geometry.tangents[i],
    geometry.tangents[i + 1],
    geometry.tangents[i + 2],
  ];
}

/** A position-keyed edge census, so duplicated cap rings still merge. */
function edgeCensus(geometry: TileGeometryData): Map<string, number> {
  const key = (position: [number, number, number]): string =>
    position.map((value) => Math.round(value * 1e6)).join(',');
  const edges = new Map<string, number>();
  const bump = (a: [number, number, number], b: [number, number, number]) => {
    const [first, second] = [key(a), key(b)].sort();
    const id = `${first}|${second}`;
    edges.set(id, (edges.get(id) ?? 0) + 1);
  };
  for (let triangle = 0; triangle < geometry.triangleCount; triangle++) {
    const [a, b, c] = trianglePositions(geometry, triangle);
    bump(a, b);
    bump(b, c);
    bump(c, a);
  }
  return edges;
}

function fnv1a(values: Float32Array | Uint16Array): number {
  const bytes = new Uint8Array(
    values.buffer,
    values.byteOffset,
    values.byteLength,
  );
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }
  return hash;
}

describe('tile geometry: committed proportions', () => {
  const geometry = buildTileGeometry();

  it('is exactly the 0.75 x 1.0 x 0.58929-unit tile', () => {
    // 21 x 28 x 16.5 mm at 1 unit = 28 mm, centred on the local origin. The
    // plan's printed "0.58929" is 16.5 / 28 rounded to five decimals, so the
    // exact proportion is the tighter assertion.
    expect(geometry.boundsUnits.width).toBeCloseTo(0.75, 6);
    expect(geometry.boundsUnits.height).toBeCloseTo(1, 6);
    expect(geometry.boundsUnits.thickness).toBeCloseTo(16.5 / 28, 6);
    expect(Math.abs(geometry.boundsUnits.width - 0.75)).toBeLessThanOrEqual(1e-6);
    expect(Math.abs(geometry.boundsUnits.height - 1)).toBeLessThanOrEqual(1e-6);
    expect(
      Math.abs(geometry.boundsUnits.thickness - 16.5 / 28),
    ).toBeLessThanOrEqual(1e-6);
    // 16.5 / 28 = 0.589285714...; the plan's 0.58929 differs by 4.3e-6, so it
    // can only be pinned to five decimals.
    expect(Math.abs(geometry.boundsUnits.thickness - 0.58929)).toBeLessThan(
      1e-5,
    );
  });

  it('centres the body on the origin and puts the face on +Z', () => {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < geometry.vertexCount; i++) {
      const [x, y, z] = vertex(geometry, i);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
    expect(minX).toBeCloseTo(-TILE.widthUnits / 2, 6);
    expect(maxX).toBeCloseTo(TILE.widthUnits / 2, 6);
    expect(minY).toBeCloseTo(-TILE.heightUnits / 2, 6);
    expect(maxY).toBeCloseTo(TILE.heightUnits / 2, 6);
    expect(maxZ).toBeCloseTo(HALF_T, 6);
    expect(minZ).toBeCloseTo(-HALF_T, 6);
  });
});

describe('tile geometry: carved face plate', () => {
  const geometry = buildTileGeometry();

  const plateau: number[] = [];
  for (let i = 0; i < geometry.vertexCount; i++) {
    if (geometry.faceZone[i] === 1) plateau.push(i);
  }

  it('insets the 0.64 x 0.89-unit plateau by the 0.055-unit bevel', () => {
    expect(TILE_MESH.facePlateWidthUnits).toBeCloseTo(TILE.facePlateWidthUnits, 9);
    expect(TILE_MESH.facePlateHeightUnits).toBeCloseTo(
      TILE.facePlateHeightUnits,
      9,
    );

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const index of plateau) {
      const [x, y, z] = vertex(geometry, index);
      expect(z).toBeCloseTo(HALF_T, 6);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    expect(minX).toBeCloseTo(-0.32, 6);
    expect(maxX).toBeCloseTo(0.32, 6);
    expect(minY).toBeCloseTo(-0.445, 6);
    expect(maxY).toBeCloseTo(0.445, 6);
    expect(maxX - minX).toBeCloseTo(0.64, 6);
    expect(maxY - minY).toBeCloseTo(0.89, 6);
    // Centred on the tile: the body is 0.75 x 1.0.
    expect(minX + maxX).toBeCloseTo(0, 6);
    expect(minY + maxY).toBeCloseTo(0, 6);
  });

  it('maps the plate to UV with (0,0) top-left and V down the glyph', () => {
    expect(facePlateUv(-0.32, 0.445).u).toBeCloseTo(0, 9);
    expect(facePlateUv(-0.32, 0.445).v).toBeCloseTo(0, 9);
    expect(facePlateUv(0.32, -0.445).u).toBeCloseTo(1, 9);
    expect(facePlateUv(0.32, -0.445).v).toBeCloseTo(1, 9);
    // V increases as Y decreases: the glyph runs down the face.
    expect(facePlateUv(0, 0.4).v).toBeLessThan(facePlateUv(0, 0).v);
    expect(facePlateUv(0, 0).v).toBeLessThan(facePlateUv(0, -0.4).v);

    for (const index of plateau) {
      const [x, y] = vertex(geometry, index);
      const uv = facePlateUv(x, y);
      expect(geometry.uvs[index * 2]).toBeCloseTo(uv.u, 6);
      expect(geometry.uvs[index * 2 + 1]).toBeCloseTo(uv.v, 6);
    }
    // The plate's own extremes actually reach the corners of the UV square.
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const index of plateau) {
      minU = Math.min(minU, geometry.uvs[index * 2]);
      maxU = Math.max(maxU, geometry.uvs[index * 2]);
      minV = Math.min(minV, geometry.uvs[index * 2 + 1]);
      maxV = Math.max(maxV, geometry.uvs[index * 2 + 1]);
    }
    expect(minU).toBeCloseTo(0, 6);
    expect(maxU).toBeCloseTo(1, 6);
    expect(minV).toBeCloseTo(0, 6);
    expect(maxV).toBeCloseTo(1, 6);
  });

  it('publishes +X tangents with a -1 bitangent on the plate (V down)', () => {
    for (const index of plateau) {
      const t = tangent(geometry, index);
      expect(t[0]).toBeCloseTo(1, 6);
      expect(t[1]).toBeCloseTo(0, 6);
      expect(t[2]).toBeCloseTo(0, 6);
      // bitangent = w * cross(+Z, +X) must run along -Y, the +V direction.
      expect(geometry.tangents[index * 4 + 3]).toBe(-1);
    }
  });

  it('is exactly the plateau ring and its centre, and nothing else', () => {
    // 4 corners x (4 arc steps + 1) outline points, plus the fan centre.
    expect(plateau).toHaveLength(TILE_MESH.loopVertexCount + 1);
    expect(TILE_MESH.loopVertexCount).toBe(
      4 * (TILE_MESH.loopSegmentsPerCorner + 1),
    );
    for (let i = 0; i < geometry.vertexCount; i++) {
      const expected = plateau.includes(i) ? 1 : 0;
      expect(geometry.faceZone[i]).toBe(expected);
    }
    // Every plateau normal points straight out of the face.
    for (const index of plateau) {
      const [x, y, z] = normal(geometry, index);
      expect(x).toBeCloseTo(0, 6);
      expect(y).toBeCloseTo(0, 6);
      expect(z).toBeCloseTo(1, 6);
    }
  });
});

describe('tile geometry: shading attributes', () => {
  const geometry = buildTileGeometry();

  it('has unit normals and unit tangents orthogonal to their normal', () => {
    for (let i = 0; i < geometry.vertexCount; i++) {
      const n = normal(geometry, i);
      const t = tangent(geometry, i);
      expect(Math.abs(length(n) - 1)).toBeLessThanOrEqual(1e-5);
      expect(Math.abs(length(t) - 1)).toBeLessThanOrEqual(1e-5);
      expect(Math.abs(dot(n, t))).toBeLessThanOrEqual(1e-5);
      const w = geometry.tangents[i * 4 + 3];
      expect(Math.abs(w)).toBe(1);
    }
  });

  it('publishes the attribute table the GPU wrapper expects', () => {
    for (const attribute of TILE_GEOMETRY_ATTRIBUTES) {
      const values = geometry[attribute.key];
      expect(values.length).toBe(geometry.vertexCount * attribute.itemSize);
    }
    expect(FACE_ZONE_ATTRIBUTE).toBe('faceZone');
    expect(TILE_GEOMETRY_ATTRIBUTES.map((attribute) => attribute.name)).toEqual([
      'position',
      'normal',
      'uv',
      'tangent',
      'faceZone',
    ]);
  });
});

describe('tile geometry: topology and budget', () => {
  const geometry = buildTileGeometry();

  it('winds every triangle outward', () => {
    expect(signedVolume(geometry)).toBeGreaterThan(0);
    // A rounded box is smaller than its 0.75 x 1.0 x 0.58929 envelope, but
    // within a few percent of it.
    const envelope = 0.75 * 1 * (16.5 / 28);
    const volume = signedVolume(geometry);
    expect(volume).toBeLessThan(envelope);
    expect(volume).toBeGreaterThan(envelope * 0.9);
  });

  it('agrees with its own vertex normals on every triangle', () => {
    for (let triangle = 0; triangle < geometry.triangleCount; triangle++) {
      const [a, b, c] = trianglePositions(geometry, triangle);
      const faceNormal = cross(subtract(b, a), subtract(c, a));
      const indices = [
        geometry.indices[triangle * 3],
        geometry.indices[triangle * 3 + 1],
        geometry.indices[triangle * 3 + 2],
      ];
      const averaged: [number, number, number] = [0, 0, 0];
      for (const index of indices) {
        const n = normal(geometry, index);
        averaged[0] += n[0];
        averaged[1] += n[1];
        averaged[2] += n[2];
      }
      expect(dot(faceNormal, averaged)).toBeGreaterThan(0);
    }
  });

  it('is a closed, non-degenerate surface', () => {
    for (let triangle = 0; triangle < geometry.triangleCount; triangle++) {
      expect(triangleArea(geometry, triangle)).toBeGreaterThan(1e-9);
      for (let corner = 0; corner < 3; corner++) {
        expect(geometry.indices[triangle * 3 + corner]).toBeLessThan(
          geometry.vertexCount,
        );
      }
    }
    const edges = edgeCensus(geometry);
    const unbalanced = [...edges.values()].filter((count) => count !== 2);
    expect(unbalanced).toEqual([]);
  });

  it('stays inside the 600-triangle budget', () => {
    expect(geometry.triangleCount).toBeLessThanOrEqual(TILE_TRIANGLE_BUDGET);
    expect(TILE_TRIANGLE_BUDGET).toBe(600);
    // The committed flat back: 6 front + 1 side + 4 back bands, two caps.
    expect(geometry.triangleCount).toBe(480);
    expect(geometry.indices.length).toBe(geometry.triangleCount * 3);
  });
});

describe('tile geometry: determinism', () => {
  it('rebuilds byte-identical buffers', () => {
    const first = buildTileGeometry();
    const second = buildTileGeometry();
    expect(second.positions).toEqual(first.positions);
    expect(second.normals).toEqual(first.normals);
    expect(second.uvs).toEqual(first.uvs);
    expect(second.tangents).toEqual(first.tangents);
    expect(second.faceZone).toEqual(first.faceZone);
    expect(second.indices).toEqual(first.indices);
    expect(fnv1a(second.positions)).toBe(fnv1a(first.positions));
    expect(fnv1a(second.normals)).toBe(fnv1a(first.normals));
    expect(fnv1a(second.uvs)).toBe(fnv1a(first.uvs));
    expect(fnv1a(second.tangents)).toBe(fnv1a(first.tangents));
    expect(fnv1a(second.faceZone)).toBe(fnv1a(first.faceZone));
    expect(fnv1a(second.indices)).toBe(fnv1a(first.indices));
  });

  it('does not use Math.random or any asset input', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./tileGeometry.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toMatch(/Math\.random/);
    expect(source).not.toMatch(/fetch\(|new Image|\.png|\.json/);
  });

  it('imports nothing outside the renderer directory and no three.js', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./tileGeometry.ts', import.meta.url)),
      'utf8',
    );
    const specifiers = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(
      (match) => match[1],
    );
    expect(specifiers).toEqual(['../layoutConstants']);
    expect(source).not.toMatch(/import\(\s*['"]/);
    expect(source).not.toMatch(/from\s+['"]three(\/|['"])/);
  });
});

describe('tile geometry: optional back crown', () => {
  const domed = buildTileGeometry({ backDomeUnits: 0.02 });

  it('keeps the committed envelope and budget', () => {
    expect(domed.boundsUnits.width).toBeCloseTo(TILE.widthUnits, 6);
    expect(domed.boundsUnits.height).toBeCloseTo(TILE.heightUnits, 6);
    expect(domed.boundsUnits.thickness).toBeCloseTo(16.5 / 28, 6);
    expect(domed.triangleCount).toBeLessThanOrEqual(TILE_TRIANGLE_BUDGET);
    // The flat back's 20-triangle cap becomes a rim band plus an apex fan.
    expect(domed.triangleCount).toBe(520);
  });

  it('reaches the back plane at the apex with outward winding', () => {
    let minZ = Infinity;
    for (let i = 0; i < domed.vertexCount; i++) {
      minZ = Math.min(minZ, vertex(domed, i)[2]);
    }
    expect(minZ).toBeCloseTo(-HALF_T, 6);
    expect(signedVolume(domed)).toBeGreaterThan(0);
    for (let i = 0; i < domed.vertexCount; i++) {
      const n = normal(domed, i);
      const t = tangent(domed, i);
      expect(Math.abs(length(n) - 1)).toBeLessThanOrEqual(1e-5);
      expect(Math.abs(length(t) - 1)).toBeLessThanOrEqual(1e-5);
      expect(Math.abs(dot(n, t))).toBeLessThanOrEqual(1e-5);
    }
    // The crown is still a closed surface.
    const unbalanced = [...edgeCensus(domed).values()].filter(
      (count) => count !== 2,
    );
    expect(unbalanced).toEqual([]);
  });

  it('is deterministic and rejects a dome that would break the envelope', () => {
    expect(buildTileGeometry({ backDomeUnits: 0.02 }).positions).toEqual(
      domed.positions,
    );
    expect(() => buildTileGeometry({ backDomeUnits: -0.01 })).toThrow(RangeError);
    expect(() => buildTileGeometry({ backDomeUnits: 0.5 })).toThrow(RangeError);
    expect(() => buildTileGeometry({ backDomeUnits: Number.NaN })).toThrow(
      RangeError,
    );
  });
});
