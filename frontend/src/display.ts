/**
 * Friendly tile names for text that reaches the player.
 *
 * The data model keeps the compact `1m`..`7z` codes in JSON fields, scenario
 * ids, and comparison logic. Only display text maps them:
 *
 * - winds use `E S W N` (`1z`..`4z`);
 * - dragons use `R G Wh` (`5z`..`7z`, with the lowercase `h` on Haku);
 * - a red five prints as `R5s`, `R5p`, or `R5m`;
 * - every other code passes through unchanged.
 */

const HONOR_NAMES: Record<string, string> = {
  '1z': 'E',
  '2z': 'S',
  '3z': 'W',
  '4z': 'N',
  '5z': 'R',
  '6z': 'G',
  '7z': 'Wh',
};

/** Friendly name for one tile code, e.g. `5z` -> `R` or `5s` + red -> `R5s`. */
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
