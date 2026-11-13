/**
 * Friendly tile names for text that reaches the player.
 *
 * The data model keeps the compact `1m`..`7z` codes in JSON fields, scenario
 * ids, and comparison logic. Only display text maps them:
 *
 * - winds use `E S W N` (`1z`..`4z`);
 * - dragons use `Wh G R` for `5z`..`7z` (Haku, Hatsu, Chun), with the
 *   lowercase `h` on Haku;
 * - a red five prints as `R5s`, `R5p`, or `R5m`;
 * - every other code passes through unchanged.
 */

const HONOR_NAMES: Record<string, string> = {
  '1z': 'E',
  '2z': 'S',
  '3z': 'W',
  '4z': 'N',
  '5z': 'Wh',
  '6z': 'G',
  '7z': 'R',
};

/** Friendly name for one tile code, e.g. `7z` -> `R` or `5s` + red -> `R5s`. */
export function formatTileForDisplay(code: string, redFive = false): string {
  if (redFive && code.length === 2 && code[0] === '5' && 'mps'.includes(code[1])) {
    return `R5${code[1]}`;
  }
  return HONOR_NAMES[code] ?? code;
}

/**
 * Friendly name for a tile in Mortal's vocabulary, which marks a red five with
 * a trailing `r` (`5sr`).
 */
export function formatMortalTileForDisplay(tile: string): string {
  return tile.endsWith('r')
    ? formatTileForDisplay(tile.slice(0, -1), true)
    : formatTileForDisplay(tile);
}

/**
 * Flag which copies of each tile are red fives, one flag per tile.
 *
 * `redFives` lists tile codes, not positions, so a hand holding two 5p with one
 * red five marks the first 5p in hand order and leaves the second normal. Both
 * the docked hand and the isometric hand use this, so the same copy is red in
 * every view.
 */
export function redFiveFlags(
  tiles: readonly string[],
  redFives: readonly string[],
): boolean[] {
  const remaining = new Map<string, number>();
  for (const code of redFives) {
    remaining.set(code, (remaining.get(code) ?? 0) + 1);
  }

  return tiles.map((tile) => {
    const count = remaining.get(tile) ?? 0;
    if (count === 0) return false;
    remaining.set(tile, count - 1);
    return true;
  });
}
