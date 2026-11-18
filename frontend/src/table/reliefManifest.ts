/**
 * Parser and types for `frontend/public/table/relief.json` (Task 4B).
 *
 * The bake publishes three pixel-aligned atlases and one cell rect per face:
 *
 *  - `face_albedo.png`: RGB pure pigment (no baked light), A paint mask;
 *  - `face_normal_depth.png`: RGB tangent normal (x right, y down, z out),
 *    A normalized height in [0, 1] (1 un-carved, 0 deepest engraving);
 *  - `face_ao_roughness.png`: R cavity AO, G enamel roughness.
 *
 * A cell maps the inset face plate exactly like the flat glyph in `faces.json`,
 * so the Task 5A compositor can shade one cell in world space and paste it onto
 * the same `faceQuad` for every rotation. Nothing here is per-orientation art.
 */
import { TILE_FACE_IDS, isTileFaceId } from './tiles';
import type { TileFaceId } from './tiles';

export interface ReliefCell {
  readonly face: TileFaceId;
  readonly index: number;
  readonly column: number;
  readonly row: number;
  /** Cell origin in atlas pixels. */
  readonly x: number;
  readonly y: number;
  /** `[x0, y0, x1, y1]` in normalized atlas space (the bake's convention). */
  readonly rect: readonly [number, number, number, number];
}

export interface ReliefAtlasEntry {
  readonly file: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

export interface ReliefManifest {
  readonly version: number;
  readonly generatedBy: string;
  readonly raster: {
    readonly cellWidth: number;
    readonly cellHeight: number;
    readonly columns: number;
    readonly rows: number;
    readonly atlasWidth: number;
    readonly atlasHeight: number;
  };
  readonly carve: {
    readonly depthMm: number;
    readonly depthUnits: number;
    /** The V-carve wall run in tile units; the depth cue's physical scale. */
    readonly wallRunUnits: number;
  };
  readonly atlases: {
    readonly albedo: ReliefAtlasEntry;
    readonly normalDepth: ReliefAtlasEntry;
    readonly aoRoughness: ReliefAtlasEntry;
  };
  readonly cells: Readonly<Record<string, ReliefCell>>;
}

function fail(message: string): never {
  throw new Error(`relief.json: ${message}`);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function finite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${field} must be a finite number`);
  }
  return value;
}

function positive(value: unknown, field: string): number {
  const valueNumber = finite(value, field);
  if (valueNumber <= 0) fail(`${field} must be positive`);
  return valueNumber;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${field} must be a string`);
  return value;
}

function atlas(raw: unknown, field: string): ReliefAtlasEntry {
  const entry = object(raw, field);
  return {
    file: text(entry.file, `${field}.file`),
    width: positive(entry.width, `${field}.width`),
    height: positive(entry.height, `${field}.height`),
    bytes: positive(entry.bytes, `${field}.bytes`),
  };
}

export function parseReliefManifest(raw: unknown): ReliefManifest {
  const root = object(raw, 'root');
  const raster = object(root.raster, 'raster');
  const carve = object(root.carve, 'carve');
  const atlases = object(root.atlases, 'atlases');
  const cellsRaw = object(raster.cells ?? root.cells, 'raster.cells');
  const cellWidth = positive(raster.cellWidth, 'raster.cellWidth');
  const cellHeight = positive(raster.cellHeight, 'raster.cellHeight');
  const atlasWidth = positive(raster.atlasWidth, 'raster.atlasWidth');
  const atlasHeight = positive(raster.atlasHeight, 'raster.atlasHeight');

  const cells: Record<string, ReliefCell> = {};
  for (const [face, rawCell] of Object.entries(cellsRaw)) {
    if (!isTileFaceId(face)) fail(`unknown face ${face}`);
    const cell = object(rawCell, `cells.${face}`);
    const rect = cell.rect;
    if (!Array.isArray(rect) || rect.length !== 4) {
      fail(`cells.${face}.rect must be [x0, y0, x1, y1]`);
    }
    const parsed: ReliefCell = {
      face,
      index: finite(cell.index, `cells.${face}.index`),
      column: finite(cell.column, `cells.${face}.column`),
      row: finite(cell.row, `cells.${face}.row`),
      x: finite(cell.x, `cells.${face}.x`),
      y: finite(cell.y, `cells.${face}.y`),
      rect: [
        finite(rect[0], `cells.${face}.rect[0]`),
        finite(rect[1], `cells.${face}.rect[1]`),
        finite(rect[2], `cells.${face}.rect[2]`),
        finite(rect[3], `cells.${face}.rect[3]`),
      ] as const,
    };
    if (parsed.x < 0 || parsed.y < 0) fail(`cells.${face} origin must be non-negative`);
    if (parsed.x + cellWidth > atlasWidth || parsed.y + cellHeight > atlasHeight) {
      fail(`cells.${face} lies outside the ${atlasWidth}x${atlasHeight} atlas`);
    }
    cells[face] = parsed;
  }

  const inked = TILE_FACE_IDS.filter((face) => face !== 'blank');
  const missing = inked.filter((face) => !cells[face]);
  if (missing.length > 0) fail(`no cell for ${missing.join(', ')}`);

  return {
    version: finite(root.version, 'version'),
    generatedBy: text(root.generatedBy, 'generatedBy'),
    raster: {
      cellWidth,
      cellHeight,
      columns: positive(raster.columns, 'raster.columns'),
      rows: positive(raster.rows, 'raster.rows'),
      atlasWidth,
      atlasHeight,
    },
    carve: {
      depthMm: positive(carve.depthMm, 'carve.depthMm'),
      // The depth cue is scaled by the published engraving depth. Older bakes
      // may omit depthUnits; derive it from mm and the tile's 28 mm height.
      depthUnits:
        carve.depthUnits === undefined
          ? positive(carve.depthMm, 'carve.depthMm') / 28
          : positive(carve.depthUnits, 'carve.depthUnits'),
      wallRunUnits:
        carve.wallRunUnits === undefined
          ? 0.023409
          : positive(carve.wallRunUnits, 'carve.wallRunUnits'),
    },
    atlases: {
      albedo: atlas(atlases.face_albedo, 'atlases.face_albedo'),
      normalDepth: atlas(atlases.face_normal_depth, 'atlases.face_normal_depth'),
      aoRoughness: atlas(atlases.face_ao_roughness, 'atlases.face_ao_roughness'),
    },
    cells,
  };
}

/** The relief cell for a face, or null for `blank` (and any future gap). */
export function reliefCellFor(
  manifest: ReliefManifest | null | undefined,
  face: TileFaceId,
): ReliefCell | null {
  if (!manifest) return null;
  return manifest.cells[face] ?? null;
}
