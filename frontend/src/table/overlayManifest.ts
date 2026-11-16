/**
 * Parser and types for the committed `frontend/public/table/overlays.json`.
 *
 * Phase 3.5 publishes the tile-to-tile contact shadows as small per-shell
 * decals. The group shadow (§10.12) is one blurred union under the bodies; it
 * cannot darken a neighbour's face where two tiles touch. These decals are
 * drawn between the bodies in `LayoutZone.bodies` painter order.
 *
 * A decal belongs to the tile that *casts* it (the one drawn later, which
 * overlaps a neighbour) and is anchored to that tile's drawn body box. The
 * neighbour's body is drawn first; the decal is drawn after it and clipped to
 * its advance box; then the caster's body covers the overlap. Only the
 * neighbour's exposed sliver darkens.
 *
 * Coordinates are CSS px of the @1x texture; the @2x file is exactly twice the
 * resolution, like the shell textures.
 */

/** A convex clip polygon in @1x px, absolute zone-local coordinates. */
export type ClipPoint = readonly [number, number];

/** The caster's screen edge that is in contact with an earlier neighbour. */
export type OverlaySide = 'up' | 'down' | 'left' | 'right';

export const OVERLAY_SIDES: readonly OverlaySide[] = ['up', 'down', 'left', 'right'];

/** A per-side override of the standing band (thinner/darker on one cast side). */
export interface OverlaySideOverride {
  readonly coreAlpha: number;
  readonly sigmaPx1x: number;
}

export interface OverlayModel {
  /** `contact-ao-band`: an outward half-Gaussian from the body contour. */
  readonly kind: string;
  /** Where the band's alpha starts, relative to the caster's drawn body box. */
  readonly anchor: string;
  /** How the compositor keeps it off the felt (the body polygon). */
  readonly clip: string;
  /** Peak alpha at the contact line. */
  readonly coreAlpha: number;
  /** Band falloff in @1x px, by the caster's pose. */
  readonly sigmaPx1x: { readonly lying: number; readonly standing: number };
  /** The band's alpha fades to zero over this many @1x px at each end. */
  readonly tangentFadePx1x: number;
  /** The support extends this many sigma outward from the contour. */
  readonly supportSigma: number;
  readonly colorHex: string;
  /** Per-side overrides; the hand's right casts are thinner and darker. */
  readonly sideOverrides: Readonly<Partial<Record<OverlaySide, OverlaySideOverride>>>;
}

/** One baked contact-shadow decal. */
export interface OverlayDecal {
  readonly shell: string;
  readonly contact: OverlaySide;
  readonly textureFile: string;
  readonly textureFile2x: string;
  /** Physical size of the decal texture in @1x px. */
  readonly texWidth: number;
  readonly texHeight: number;
  /**
   * Offset from the caster's drawn body-box top-left to the decal texture's
   * top-left. Negative means the decal starts above/left of the body.
   */
  readonly bodyAnchorX: number;
  readonly bodyAnchorY: number;
  /** The decal's nontransparent support in @1x px, body-box relative. */
  readonly supportPx: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly peakAlpha: number;
  readonly sha256: { readonly decodedRgba1x: string; readonly decodedRgba2x: string };
  readonly bytes1x: number;
  readonly bytes2x: number;
}

export interface OverlayManifest {
  readonly version: 1;
  readonly generatedBy: string;
  readonly pixelRatio: 2;
  readonly model: OverlayModel;
  /**
   * Shells that share another shell's decal because their drawn body geometry
   * is identical (the `_faceup` wall shells do not change the body silhouette).
   */
  readonly aliases: Readonly<Record<string, string>>;
  /**
   * Shell-family prefixes that currently have contact shadows. Phase 3.5
   * follow-up: only the human hand fan is enabled; the lying face-up ponds and
   * melds looked smudged and are deliberately unchanged. Re-enable by adding a
   * prefix and re-baking.
   */
  readonly enabled: { readonly families: readonly string[]; readonly note: string };
  /**
   * Clipping polygon per shell, in drawn body-box coordinates. An oblique
   * side-wall or standing-hand body does not fill its advance box, so the
   * compositor clips each decal to this inset convex hull, never to the box.
   * The polygon is a superset of the opaque silhouette, so the clip is
   * conservative; the decoded-pixel check asserts the felt stays untouched.
   */
  readonly bodyQuads: Readonly<Record<string, readonly ClipPoint[]>>;
  /** Keyed `${shell}:${side}`. */
  readonly decals: Readonly<Record<string, OverlayDecal>>;
}

function fail(message: string): never {
  throw new Error(`overlays.json: ${message}`);
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

const nonNegative = (value: unknown, label: string): number => {
  const number = finite(value, label);
  if (number < 0) fail(`${label} must not be negative`);
  return number;
};

const integer = (value: unknown, label: string): number => {
  const number = finite(value, label);
  if (!Number.isInteger(number)) fail(`${label} must be an integer`);
  return number;
};

const sideOf = (value: unknown, label: string): OverlaySide => {
  if (typeof value !== 'string' || !OVERLAY_SIDES.includes(value as OverlaySide)) {
    fail(`${label} must be one of ${OVERLAY_SIDES.join('/')}, got ${String(value)}`);
  }
  return value as OverlaySide;
};

const decalOf = (key: string, raw: unknown): OverlayDecal => {
  if (!isObject(raw)) fail(`decals.${key} must be an object`);
  const record = raw;
  const shell = typeof record.shell === 'string' ? record.shell : fail(`decals.${key}.shell`);
  if (!shell.startsWith('shell_')) fail(`decals.${key}.shell must name a shell`);
  const contact = sideOf(record.contact, `decals.${key}.contact`);
  if (key !== `${shell}:${contact}`) {
    fail(`decals.${key} is keyed differently from its shell:contact pair`);
  }
  const support = record.supportPx;
  if (!isObject(support)) fail(`decals.${key}.supportPx must be an object`);
  const supportPx = {
    x: integer(support.x, `decals.${key}.supportPx.x`),
    y: integer(support.y, `decals.${key}.supportPx.y`),
    width: positive(support.width, `decals.${key}.supportPx.width`),
    height: positive(support.height, `decals.${key}.supportPx.height`),
  };
  const texWidth = positive(record.texWidth, `decals.${key}.texWidth`);
  const texHeight = positive(record.texHeight, `decals.${key}.texHeight`);
  if (supportPx.width !== texWidth || supportPx.height !== texHeight) {
    fail(`decals.${key} supportPx/tex size disagree`);
  }
  const sha = record.sha256;
  if (!isObject(sha)) fail(`decals.${key}.sha256 must be an object`);
  const peakAlpha = finite(record.peakAlpha, `decals.${key}.peakAlpha`);
  if (peakAlpha <= 0 || peakAlpha > 1) fail(`decals.${key}.peakAlpha must be in (0, 1]`);
  const textureFile = typeof record.textureFile === 'string' ? record.textureFile : '';
  const textureFile2x = typeof record.textureFile2x === 'string' ? record.textureFile2x : '';
  if (!textureFile.startsWith('overlays/')) fail(`decals.${key}.textureFile must live in overlays/`);
  if (!textureFile2x.startsWith('overlays/2x/')) {
    fail(`decals.${key}.textureFile2x must live in overlays/2x/`);
  }
  if (typeof sha.decodedRgba1x !== 'string' || typeof sha.decodedRgba2x !== 'string') {
    fail(`decals.${key}.sha256 must publish decodedRgba1x and decodedRgba2x`);
  }
  return {
    shell,
    contact,
    textureFile,
    textureFile2x,
    texWidth,
    texHeight,
    bodyAnchorX: integer(record.bodyAnchorX, `decals.${key}.bodyAnchorX`),
    bodyAnchorY: integer(record.bodyAnchorY, `decals.${key}.bodyAnchorY`),
    supportPx,
    peakAlpha,
    sha256: {
      decodedRgba1x: sha.decodedRgba1x,
      decodedRgba2x: sha.decodedRgba2x,
    },
    bytes1x: positive(record.bytes1x, `decals.${key}.bytes1x`),
    bytes2x: positive(record.bytes2x, `decals.${key}.bytes2x`),
  };
};

/** Parse and validate a decoded `overlays.json`. */
export function parseOverlayManifest(raw: unknown): OverlayManifest {
  if (!isObject(raw)) fail('document must be an object');
  if (raw.version !== 1) fail(`version must be 1, got ${String(raw.version)}`);
  if (raw.pixelRatio !== 2) fail('pixelRatio must be 2');
  const generatedBy = typeof raw.generatedBy === 'string' ? raw.generatedBy : '';
  if (!generatedBy) fail('generatedBy must name the baker');
  if (!isObject(raw.model)) fail('model must be an object');
  const model = raw.model;
  if (model.kind !== 'contact-ao-band') fail(`unknown overlay model ${String(model.kind)}`);
  const sigmas = model.sigmaPx1x;
  if (!isObject(sigmas)) fail('model.sigmaPx1x must be an object');
  const sideOverrides: Partial<Record<OverlaySide, OverlaySideOverride>> = {};
  if (model.sideOverrides !== undefined) {
    if (!isObject(model.sideOverrides)) fail('model.sideOverrides must be an object');
    for (const [side, value] of Object.entries(model.sideOverrides)) {
      const key = sideOf(side, `model.sideOverrides.${side}`);
      if (!isObject(value)) fail(`model.sideOverrides.${side} must be an object`);
      sideOverrides[key] = {
        coreAlpha: positive(value.coreAlpha, `model.sideOverrides.${side}.coreAlpha`),
        sigmaPx1x: positive(value.sigmaPx1x, `model.sideOverrides.${side}.sigmaPx1x`),
      };
    }
  }
  const parsedModel: OverlayModel = {
    kind: 'contact-ao-band',
    anchor: typeof model.anchor === 'string' ? model.anchor : fail('model.anchor'),
    clip: typeof model.clip === 'string' ? model.clip : fail('model.clip'),
    coreAlpha: positive(model.coreAlpha, 'model.coreAlpha'),
    sigmaPx1x: {
      lying: positive(sigmas.lying, 'model.sigmaPx1x.lying'),
      standing: positive(sigmas.standing, 'model.sigmaPx1x.standing'),
    },
    tangentFadePx1x: nonNegative(model.tangentFadePx1x, 'model.tangentFadePx1x'),
    supportSigma: positive(model.supportSigma, 'model.supportSigma'),
    colorHex: typeof model.colorHex === 'string' ? model.colorHex : fail('model.colorHex'),
    sideOverrides,
  };
  if (parsedModel.coreAlpha > 1) fail('model.coreAlpha must be in (0, 1]');
  if (!/^#[0-9a-f]{6}$/i.test(parsedModel.colorHex)) fail('model.colorHex must be #rrggbb');

  if (!isObject(raw.enabled)) fail('enabled must be an object');
  const families = raw.enabled.families;
  if (!Array.isArray(families) || families.length === 0) {
    fail('enabled.families must be a non-empty array');
  }
  for (const family of families) {
    if (typeof family !== 'string' || !family.startsWith('shell_')) {
      fail(`enabled.families must contain shell prefixes, got ${String(family)}`);
    }
  }
  const enabled = {
    families: families as string[],
    note: typeof raw.enabled.note === 'string' ? raw.enabled.note : '',
  };

  if (!isObject(raw.aliases)) fail('aliases must be an object');
  const aliases: Record<string, string> = {};
  for (const [source, target] of Object.entries(raw.aliases)) {
    if (!source.startsWith('shell_') || typeof target !== 'string' || !target.startsWith('shell_')) {
      fail(`aliases.${source} must map one shell id to another`);
    }
    aliases[source] = target;
  }

  if (!isObject(raw.bodyQuads)) fail('bodyQuads must be an object');
  const bodyQuads: Record<string, ClipPoint[]> = {};
  for (const [shell, value] of Object.entries(raw.bodyQuads)) {
    if (!shell.startsWith('shell_')) fail(`bodyQuads.${shell} must name a shell`);
    if (!Array.isArray(value) || value.length < 3) {
      fail(`bodyQuads.${shell} must be a polygon of at least 3 points`);
    }
    bodyQuads[shell] = value.map((point, index) => {
      if (!Array.isArray(point) || point.length !== 2) {
        fail(`bodyQuads.${shell}[${index}] must be a 2-point array`);
      }
      return [integer(point[0], `bodyQuads.${shell}[${index}][0]`), integer(point[1], `bodyQuads.${shell}[${index}][1]`)] as const;
    });
  }

  if (!isObject(raw.decals)) fail('decals must be an object');
  const decals: Record<string, OverlayDecal> = {};
  for (const [key, record] of Object.entries(raw.decals)) {
    decals[key] = decalOf(key, record);
  }
  if (Object.keys(decals).length === 0) fail('decals must not be empty');
  for (const decal of Object.values(decals)) {
    if (!bodyQuads[decal.shell]) fail(`bodyQuads is missing a clip for ${decal.shell}`);
  }

  for (const source of Object.keys(aliases)) {
    if (decals[`${source}:up`] || decals[`${source}:left`]) {
      fail(`aliases.${source} must not own decals`);
    }
  }

  return {
    version: 1,
    generatedBy,
    pixelRatio: 2,
    model: parsedModel,
    enabled,
    aliases,
    bodyQuads,
    decals,
  };
}

/**
 * The decal for a caster shell and screen side, following the published alias.
 * Returns null when that shell does not cast on that side (a valid layout
 * situation in a short fan).
 */
export function overlayDecalFor(
  manifest: OverlayManifest,
  shell: string,
  side: OverlaySide,
): OverlayDecal | null {
  const resolved = manifest.aliases[shell] ?? shell;
  return manifest.decals[`${resolved}:${side}`] ?? null;
}

/** Whether the current policy gives this shell contact shadows. */
export function isOverlayEnabled(manifest: OverlayManifest, shell: string): boolean {
  return manifest.enabled.families.some((family) => shell.startsWith(family));
}

/** Every `(shell, side)` pair a caster can use, for coverage checks. */
export function publishedOverlayKeys(manifest: OverlayManifest): Set<string> {
  const keys = new Set(Object.keys(manifest.decals));
  for (const [source, target] of Object.entries(manifest.aliases)) {
    for (const side of OVERLAY_SIDES) {
      if (manifest.decals[`${target}:${side}`]) keys.add(`${source}:${side}`);
    }
  }
  return keys;
}
