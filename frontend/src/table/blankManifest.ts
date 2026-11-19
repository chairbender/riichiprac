/**
 * Parser for the committed `frontend/public/table/blanks.json` (Task 4).
 *
 * The Task 4A shadow sprites (`shadows.json`, `ao_seams.json`) were baked
 * against the same *reference frame* as these blanks: a 1920 x 1080 board whose
 * tiles are ~48 x 69 px. The runtime, however, draws the per-slot shells from
 * `shells.json`, which are baked at a closer camera (~72 x 102 px for the same
 * tile) — shell space is 1.25-1.6x the reference frame depending on the family.
 *
 * Task 6A therefore needs the reference body size of a bucket to scale its
 * sprites into shell space. That is all this module exposes: the measured
 * `alpha.alphaBBox` of each bucket's blank, converted to @1x px. Nothing else
 * from `blanks.json` is used at runtime.
 */
export interface BlankBucket {
  readonly bucket: string;
  readonly family: string;
  readonly textureFile: string;
  readonly pixelRatio: number;
  /** The opaque body's bounding box in @1x px. */
  readonly bodyWidth: number;
  readonly bodyHeight: number;
}

export interface BlanksManifest {
  readonly version: 1;
  readonly generatedBy: string;
  readonly pixelRatio: number;
  readonly buckets: Readonly<Record<string, BlankBucket>>;
}

function fail(message: string): never {
  throw new Error(`blanks.json: ${message}`);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Validate the parts of `blanks.json` Task 6A reads. */
export function parseBlanksManifest(raw: unknown): BlanksManifest {
  if (!isObject(raw)) fail('document must be an object');
  if (raw.version !== 1) fail('version must be 1');
  if (!isObject(raw.blanks)) fail('blanks must be an object');
  const buckets: Record<string, BlankBucket> = {};
  for (const [bucket, value] of Object.entries(raw.blanks)) {
    if (!isObject(value)) fail(`blanks.${bucket} must be an object`);
    const pixelRatio = value.pixelRatio;
    if (typeof pixelRatio !== 'number' || pixelRatio <= 0) {
      fail(`blanks.${bucket}.pixelRatio must be a positive number`);
    }
    if (!isObject(value.alpha) || !isObject(value.alpha.alphaBBox)) {
      fail(`blanks.${bucket}.alpha.alphaBBox must be an object`);
    }
    const box = value.alpha.alphaBBox;
    const read = (key: string): number => {
      const entry = box[key];
      if (typeof entry !== 'number' || !Number.isFinite(entry)) {
        fail(`blanks.${bucket}.alpha.alphaBBox.${key} must be a number`);
      }
      return entry;
    };
    const width = (read('right') - read('left') + 1) / pixelRatio;
    const height = (read('bottom') - read('top') + 1) / pixelRatio;
    if (width <= 0 || height <= 0) fail(`blanks.${bucket} has an empty body box`);
    buckets[bucket] = {
      bucket,
      family: typeof value.family === 'string' ? value.family : '',
      textureFile: typeof value.textureFile === 'string' ? value.textureFile : '',
      pixelRatio,
      bodyWidth: width,
      bodyHeight: height,
    };
  }
  if (Object.keys(buckets).length === 0) fail('blanks must not be empty');
  return {
    version: 1,
    generatedBy: typeof raw.generatedBy === 'string' ? raw.generatedBy : '',
    pixelRatio: typeof raw.pixelRatio === 'number' ? raw.pixelRatio : 1,
    buckets,
  };
}
