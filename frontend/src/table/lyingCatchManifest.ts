/**
 * Parser/types for the committed lying-family catches
 * (`frontend/public/table/lying-catches.json`).
 *
 * A lying catch is the same target-space 3-D physical + contact-AO overlay as
 * the standing catches, but a lying target can be touched by more than one
 * caster. Its identity is the target shell + zone side + the nearest *primary*
 * contact per side (caster shell + relative draw offset + contact side), so the
 * same asset is reused across every pond/meld position that has that signature.
 */
export interface LyingCatchCaster {
  readonly shell: string;
  readonly side: string;
  readonly dx: number;
  readonly dy: number;
}

export interface LyingCatchRecord {
  readonly id: string;
  readonly target: string;
  readonly zoneSide: string;
  /** The canonical signature key. */
  readonly signature: string;
  readonly casters: readonly LyingCatchCaster[];
  readonly textureFile: string;
  readonly textureFile2x: string;
  readonly texWidth: number;
  readonly texHeight: number;
  readonly peakAlpha: number;
  readonly meanAlpha: number;
  readonly supportPx: number;
  readonly sha256: { readonly decodedRgba1x: string; readonly decodedRgba2x: string };
  readonly bytes1x: number;
  readonly bytes2x: number;
}

export interface LyingCatchesManifest {
  readonly version: 1;
  readonly generatedBy: string;
  readonly model: 'target-space-3d-catch';
  readonly combination: string;
  readonly catches: Readonly<Record<string, LyingCatchRecord>>;
}

function fail(message: string): never {
  throw new Error(`lying-catches.json: ${message}`);
}
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} must be a number`);
  return value;
};
const positive = (value: unknown, label: string): number => {
  const n = finite(value, label);
  if (n <= 0) fail(`${label} must be positive`);
  return n;
};
const integer = (value: unknown, label: string): number => {
  const n = finite(value, label);
  if (!Number.isInteger(n)) fail(`${label} must be an integer`);
  return n;
};
const shellName = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.startsWith('shell_')) fail(`${label} must name a shell`);
  return value;
};

function parseRecord(key: string, raw: unknown): LyingCatchRecord {
  if (!isObject(raw)) fail(`catches.${key} must be an object`);
  if (key !== raw.signature) fail(`catches.${key} is not keyed by its signature`);
  if (!Array.isArray(raw.casters)) fail(`catches.${key}.casters must be an array`);
  const casters = raw.casters.map((caster, index) => {
    if (!isObject(caster)) fail(`catches.${key}.casters[${index}] must be an object`);
    return {
      shell: shellName(caster.shell, `casters[${index}].shell`),
      side: typeof caster.side === 'string' ? caster.side : fail(`casters[${index}].side`),
      dx: integer(caster.dx, `casters[${index}].dx`),
      dy: integer(caster.dy, `casters[${index}].dy`),
    };
  });
  const sha = raw.sha256;
  if (!isObject(sha) || typeof sha.decodedRgba1x !== 'string' || typeof sha.decodedRgba2x !== 'string') {
    fail(`catches.${key}.sha256 must publish decodedRgba1x/2x`);
  }
  const textureFile = typeof raw.textureFile === 'string' ? raw.textureFile : '';
  const textureFile2x = typeof raw.textureFile2x === 'string' ? raw.textureFile2x : '';
  if (!textureFile.startsWith('overlays/lying/')) {
    fail(`catches.${key}.textureFile must live in overlays/lying/`);
  }
  if (!textureFile2x.startsWith('overlays/lying/2x/')) {
    fail(`catches.${key}.textureFile2x must live in overlays/lying/2x/`);
  }
  return {
    id: typeof raw.id === 'string' ? raw.id : fail(`catches.${key}.id`),
    target: shellName(raw.target, `catches.${key}.target`),
    zoneSide: typeof raw.zoneSide === 'string' ? raw.zoneSide : fail(`catches.${key}.zoneSide`),
    signature: key,
    casters,
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

export function parseLyingCatchesManifest(raw: unknown): LyingCatchesManifest {
  if (!isObject(raw)) fail('document must be an object');
  if (raw.version !== 1) fail('version must be 1');
  if (raw.model !== 'target-space-3d-catch') fail('model must be target-space-3d-catch');
  if (typeof raw.generatedBy !== 'string' || !raw.generatedBy) fail('generatedBy');
  if (typeof raw.combination !== 'string' || !raw.combination) fail('combination');
  if (!isObject(raw.catches)) fail('catches must be an object');
  const catches: Record<string, LyingCatchRecord> = {};
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

export function lyingCatchFor(
  manifest: LyingCatchesManifest | null | undefined,
  signature: string,
): LyingCatchRecord | null {
  if (!manifest) return null;
  return manifest.catches[signature] ?? null;
}
