/**
 * Tile codes, face ids and render keys for the 2.5D rendered view.
 *
 * A *face* is the art on one tile: the 34 standard codes, the three red fives
 * (`5mr`, `5pr`, `5sr`) and `blank`. A *render key* adds the shell the face is
 * composited onto, because the atlas stores one sprite per `(shell, face)`.
 *
 * The game keeps a red five as the normal code plus `is_red`/`red_fives`, so
 * {@link faceIdForTile} is the only place that turns game state into an atlas
 * face. Never derive a face id by string concatenation elsewhere.
 */

/** The six canonical shell ids published by `tools/render/bake_shells.py`. */
export const SHELL_IDS = [
  'shell_hand_standing',
  'shell_flat_upright',
  'shell_flat_sideways',
  'shell_wall_horizontal',
  'shell_wall_side_left',
  'shell_wall_side_right',
] as const;

export type ShellId = (typeof SHELL_IDS)[number];

/** Face-up shells: a glyph is visible on these. */
export const FACE_UP_SHELL_IDS = [
  'shell_hand_standing',
  'shell_flat_upright',
  'shell_flat_sideways',
] as const satisfies readonly ShellId[];

/** Face-down shells: the blue resin back is visible, so no glyph is drawn. */
export const FACE_DOWN_SHELL_IDS = [
  'shell_wall_horizontal',
  'shell_wall_side_left',
  'shell_wall_side_right',
] as const satisfies readonly ShellId[];

/** All 38 face ids, in atlas order. */
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

/** `${shell}:${face}`; the atlas' only lookup key. */
export type TileRenderKey = `${ShellId}:${TileFaceId}`;

const FACE_ID_SET: ReadonlySet<string> = new Set(TILE_FACE_IDS);
const SHELL_ID_SET: ReadonlySet<string> = new Set(SHELL_IDS);
const RED_FIVE_FACES: ReadonlySet<string> = new Set(['5mr', '5pr', '5sr']);

/** Narrow a string to a {@link ShellId}. */
export function isShellId(value: unknown): value is ShellId {
  return typeof value === 'string' && SHELL_ID_SET.has(value);
}

/** Narrow a string to a {@link TileFaceId}. */
export function isTileFaceId(value: unknown): value is TileFaceId {
  return typeof value === 'string' && FACE_ID_SET.has(value);
}

/** True for the three aka-dora face ids. */
export function isRedFiveFace(face: TileFaceId): boolean {
  return RED_FIVE_FACES.has(face);
}

/**
 * Build the atlas key. Typed so a missing shell or face is a compile error.
 */
export function tileRenderKey(shell: ShellId, face: TileFaceId): TileRenderKey {
  return `${shell}:${face}`;
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

/**
 * Every key the atlas must resolve: 6 shells x 38 faces. The face-down shells
 * resolve too, to a bare back sprite, so callers never have to special-case a
 * missing key.
 */
export const ALL_TILE_RENDER_KEYS: readonly TileRenderKey[] = SHELL_IDS.flatMap(
  (shell) => TILE_FACE_IDS.map((face) => tileRenderKey(shell, face)),
);
