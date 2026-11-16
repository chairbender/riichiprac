/**
 * Tile codes, face ids, face variants and render keys for the 2.5D rendered
 * view.
 *
 * A *face* is the art on one tile: the 34 standard codes, the three red fives
 * (`5mr`/`5pr`/`5sr`) and the assetless `blank`. A *render key* adds the shell
 * and the shell's face variant, because the atlas stores one composited sprite
 * per `(shellType, faceVariant, tileFace)`.
 *
 * The Phase 2 atlas covers the 16 face-up shells that exist today: the 14
 * standing-hand slots and the two straight-on pond/meld shells. The 34
 * per-slot dora shells (§10.5 of the architecture) are a later face-variant
 * family and deliberately have no keys here; a revealed dora indicator is
 * still drawn as a bare/future shell. Face-down wall shells are bare and
 * contribute no atlas entries.
 */

/** The 14 standing-hand slots, in row order then the drawn tile. */
export const HAND_SLOT_IDS = [
  '00',
  '01',
  '02',
  '03',
  '04',
  '05',
  '06',
  '07',
  '08',
  '09',
  '10',
  '11',
  '12',
  'draw',
] as const;

export type HandSlotId = (typeof HAND_SLOT_IDS)[number];

/**
 * The face-up shells the Phase 2 atlas bakes, in catalogue order: the 14 hand
 * slots first, then the two straight-on pond/meld shells.
 */
export const FACE_UP_SHELL_IDS = [
  ...HAND_SLOT_IDS.map((slot) => `shell_hand_slot_${slot}` as const),
  'shell_flat_upright',
  'shell_flat_sideways',
] as const;

export type FaceUpShellId = (typeof FACE_UP_SHELL_IDS)[number];

/** Face-down wall shells. Bare: no glyph, no face variant, no atlas entry. */
export const FACE_DOWN_SHELL_IDS = [
  'shell_wall_horizontal',
  'shell_wall_side_left',
  'shell_wall_side_right',
] as const;

/**
 * Face variant id per face-up shell. A variant names a *perspective slot*, not
 * a camera angle: the Phase 1b pick fixes the angle behind the slot, so the id
 * survives a later angle nudge. Adding a later treatment (for example a lifted
 * hand decal) is a new variant entry, never a glyph swapped at draw time.
 */
export const FACE_VARIANT_BY_SHELL: Readonly<Record<FaceUpShellId, string>> = {
  shell_hand_slot_00: 'standing-front-00',
  shell_hand_slot_01: 'standing-front-01',
  shell_hand_slot_02: 'standing-front-02',
  shell_hand_slot_03: 'standing-front-03',
  shell_hand_slot_04: 'standing-front-04',
  shell_hand_slot_05: 'standing-front-05',
  shell_hand_slot_06: 'standing-front-06',
  shell_hand_slot_07: 'standing-front-07',
  shell_hand_slot_08: 'standing-front-08',
  shell_hand_slot_09: 'standing-front-09',
  shell_hand_slot_10: 'standing-front-10',
  shell_hand_slot_11: 'standing-front-11',
  shell_hand_slot_12: 'standing-front-12',
  shell_hand_slot_draw: 'standing-front-draw',
  shell_flat_upright: 'flat-topdown',
  shell_flat_sideways: 'flat-rot90',
};

/** All 38 face ids, in atlas order. `blank` has no glyph asset. */
export const TILE_FACE_IDS = [
  '1m',
  '2m',
  '3m',
  '4m',
  '5m',
  '6m',
  '7m',
  '8m',
  '9m',
  '1p',
  '2p',
  '3p',
  '4p',
  '5p',
  '6p',
  '7p',
  '8p',
  '9p',
  '1s',
  '2s',
  '3s',
  '4s',
  '5s',
  '6s',
  '7s',
  '8s',
  '9s',
  '5mr',
  '5pr',
  '5sr',
  '1z',
  '2z',
  '3z',
  '4z',
  '5z',
  '6z',
  '7z',
  'blank',
] as const;

export type TileFaceId = (typeof TILE_FACE_IDS)[number];

/** `${shell}:${faceVariant}:${face}`; the atlas' only lookup key. */
export type TileRenderKey = `${string}:${string}:${TileFaceId}`;

const FACE_ID_SET: ReadonlySet<string> = new Set(TILE_FACE_IDS);
const FACE_UP_SHELL_SET: ReadonlySet<string> = new Set(FACE_UP_SHELL_IDS);
const RED_FIVE_FACES: ReadonlySet<string> = new Set(['5mr', '5pr', '5sr']);

/** Narrow a string to a {@link TileFaceId}. */
export function isTileFaceId(value: unknown): value is TileFaceId {
  return typeof value === 'string' && FACE_ID_SET.has(value);
}

/** True for the Phase 2 face-up shells (the atlas' shell catalogue). */
export function isFaceUpShellId(value: unknown): value is FaceUpShellId {
  return typeof value === 'string' && FACE_UP_SHELL_SET.has(value);
}

/** True for the three aka-dora face ids. */
export function isRedFiveFace(face: TileFaceId): boolean {
  return RED_FIVE_FACES.has(face);
}

/**
 * The variant id for a face-up shell. Throws for a face-down wall shell or a
 * face-up shell outside the Phase 2 catalogue, because silently inventing a
 * variant would ship an atlas key nothing can draw.
 */
export function faceVariantForShell(shell: string): string {
  if (isFaceUpShellId(shell)) return FACE_VARIANT_BY_SHELL[shell];
  if ((FACE_DOWN_SHELL_IDS as readonly string[]).includes(shell)) {
    throw new Error(`${shell} is face-down and bare: it has no face variant`);
  }
  throw new Error(
    `${shell} is not in the Phase 2 face-variant catalogue (${FACE_UP_SHELL_IDS.length} face-up shells)`,
  );
}

/** Build the atlas key from an explicit triple. */
export function tileRenderKeyFor(
  shell: string,
  variant: string,
  face: TileFaceId,
): TileRenderKey {
  return `${shell}:${variant}:${face}`;
}

/**
 * Build the atlas key from a face-up shell and face. The variant follows from
 * the shell's perspective slot, so callers cannot pair a shell with the wrong
 * treatment by mistake.
 */
export function tileRenderKey(shell: FaceUpShellId, face: TileFaceId): TileRenderKey {
  return tileRenderKeyFor(shell, faceVariantForShell(shell), face);
}

/**
 * Resolve a game tile code (`1m` … `7z`, or `blank`) plus its red-five flag to
 * the atlas face. `5m` + `red` becomes `5mr`; any other code keeps its own id.
 *
 * Throws on an unknown code rather than silently rendering a blank tile: a
 * typo in the generator must fail loudly at the atlas boundary.
 */
export function faceIdForTile(code: string, redFive = false): TileFaceId {
  if (code === 'blank' || code === '') return 'blank';
  if (redFive) {
    if (code === '5m' || code === '5p' || code === '5s') {
      return `${code}r` as TileFaceId;
    }
    throw new Error(`tile ${code} cannot be a red five`);
  }
  if (!isTileFaceId(code)) {
    throw new Error(`unknown tile code ${JSON.stringify(code)}`);
  }
  return code;
}

/** Every key the Phase 2 atlas must resolve: 16 shells x 38 faces. */
export const ALL_TILE_RENDER_KEYS: readonly TileRenderKey[] = FACE_UP_SHELL_IDS.flatMap(
  (shell) => TILE_FACE_IDS.map((face) => tileRenderKey(shell, face)),
);
