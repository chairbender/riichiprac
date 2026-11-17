/**
 * Parser and types for the committed `frontend/public/table/catches.json`.
 *
 * A **catch** is the 3D contact-shadow experiment's production form: one
 * target-space overlay per (target shell, adjacent caster shell) pair, baked by
 * `tools/render/bake_hand_catches.py`. It is already in the target shell's
 * texture coordinates, so the compositor draws it at the target's
 * `drawX/drawY`, after the target body and before the caster body.
 *
 * This is deliberately not the synthetic per-caster-side band in
 * `overlays.json`: every fan tile's caster is at a different camera offset, so
 * the target's caught shadow is unique. The synthetic bands remain the fallback
 * for a family without catches.
 */
export interface CatchRecord {
  readonly target: string;
  readonly caster: string;
  readonly textureFile: string;
  readonly textureFile2x: string;
  /** Equals the target shell's `texWidth/Height` at @1x. */
  readonly texWidth: number;
  readonly texHeight: number;
  readonly peakAlpha: number;
  readonly meanAlpha: number;
  readonly supportPx: number;
  readonly sha256: { readonly decodedRgba1x: string; readonly decodedRgba2x: string };
  readonly bytes1x: number;
  readonly bytes2x: number;
}

export interface CatchesManifest {
  readonly version: 1;
  readonly generatedBy: string;
  readonly model: 'target-space-3d-catch';
  readonly combination: string;
  /** Keyed `${targetShell}:${casterShell}`. */
  readonly catches: Readonly<Record<string, CatchRecord>>;
}

function fail(message: string): never {
  throw new Error(`catches.json: ${message}`);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const finite = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} must be a number`);
  return value;
};

const positive = (value: unknown, label: string): number => {
  const number = finite(value, label);
  if (number <= 0) fail(`${label} must be positive`);
  return number;
};

const integer = (value: unknown, label: string): number => {
  const number = finite(value, label);
  if (!Number.isInteger(number)) fail(`${label} must be an integer`);
  return number;
};

const shellName = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.startsWith('shell_')) {
    fail(`${label} must name a shell`);
  }
  return value;
};

function parseRecord(key: string, raw: unknown): CatchRecord {
  if (!isObject(raw)) fail(`catches.${key} must be an object`);
  const target = shellName(raw.target, `catches.${key}.target`);
  const caster = shellName(raw.caster, `catches.${key}.caster`);
  if (key !== `${target}:${caster}`) fail(`catches.${key} is keyed differently from target:caster`);
  const textureFile = typeof raw.textureFile === 'string' ? raw.textureFile : '';
  const textureFile2x = typeof raw.textureFile2x === 'string' ? raw.textureFile2x : '';
  if (!textureFile.startsWith('overlays/catches/')) {
    fail(`catches.${key}.textureFile must live in overlays/catches/`);
  }
  if (!textureFile2x.startsWith('overlays/catches/2x/')) {
    fail(`catches.${key}.textureFile2x must live in overlays/catches/2x/`);
  }
  const sha = raw.sha256;
  if (!isObject(sha) || typeof sha.decodedRgba1x !== 'string' || typeof sha.decodedRgba2x !== 'string') {
    fail(`catches.${key}.sha256 must publish decodedRgba1x and decodedRgba2x`);
  }
  return {
    target,
    caster,
    textureFile,
    textureFile2x,
    texWidth: positive(raw.texWidth, `catches.${key}.texWidth`),
    texHeight: positive(raw.texHeight, `catches.${key}.texHeight`),
    peakAlpha: positive(raw.peakAlpha, `catches.${key}.peakAlpha`),
    meanAlpha: positive(raw.meanAlpha, `catches.${key}.meanAlpha`),
    supportPx: integer(raw.supportPx, `catches.${key}.supportPx`),
    sha256: { decodedRgba1x: sha.decodedRgba1x, decodedRgba2x: sha.decodedRgba2x },
    bytes1x: positive(raw.bytes1x, `catches.${key}.bytes1x`),
    bytes2x: positive(raw.bytes2x, `catches.${key}.bytes2x`),
  };
}

/** Parse and validate a decoded `catches.json`. */
export function parseCatchesManifest(raw: unknown): CatchesManifest {
  if (!isObject(raw)) fail('document must be an object');
  if (raw.version !== 1) fail(`version must be 1, got ${String(raw.version)}`);
  if (raw.model !== 'target-space-3d-catch') fail(`unknown catch model ${String(raw.model)}`);
  if (typeof raw.generatedBy !== 'string' || raw.generatedBy.length === 0) {
    fail('generatedBy must name the baker');
  }
  if (typeof raw.combination !== 'string' || raw.combination.length === 0) {
    fail('combination must name the two terms (physical+ao)');
  }
  if (!isObject(raw.catches)) fail('catches must be an object');
  const catches: Record<string, CatchRecord> = {};
  for (const [key, value] of Object.entries(raw.catches)) catches[key] = parseRecord(key, value);
  if (Object.keys(catches).length === 0) fail('catches must not be empty');
  return {
    version: 1,
    generatedBy: raw.generatedBy,
    model: 'target-space-3d-catch',
    combination: raw.combination,
    catches,
  };
}

/** The catch for a target drawn under a caster, or null. */
export function catchFor(
  manifest: CatchesManifest | null | undefined,
  targetShell: string,
  casterShell: string,
): CatchRecord | null {
  if (!manifest) return null;
  return manifest.catches[`${targetShell}:${casterShell}`] ?? null;
}
