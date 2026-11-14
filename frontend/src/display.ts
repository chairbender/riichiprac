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
 * One tile as the player sees it in the hand dock.
 *
 * The engine's hand is deliberately left in its own order; this is a
 * presentation-only view. `isDraw` and `isRed` travel with the copy so sorting
 * cannot lose which tile was drawn (tsumogiri) or which copy is the red five.
 */
export interface DisplayTile {
  code: string;
  isDraw: boolean;
  isRed: boolean;
  /** Stable position in the source `hand` + `draw` list, used as a key. */
  sourceIndex: number;
}

/**
 * Sort value for a tile code: manzu, pinzu, souzu, then honors, 1-9/1-7.
 *
 * Kinds the encoder does not recognise sort last so a malformed hand cannot
 * scramble the rest.
 */
export function tileSortValue(code: string): number {
  const value = Number(code[0]);
  const suit = code[1];
  if (!Number.isInteger(value) || value < 1 || suit === undefined) return 99;
  const suitIndex = suit === 'm' ? 0 : suit === 'p' ? 1 : suit === 's' ? 2 : suit === 'z' ? 3 : -1;
  if (suitIndex < 0 || (suitIndex === 3 ? value > 7 : value > 9)) return 99;
  return suitIndex * 9 + value - 1;
}

/**
 * The hand `[...hand, draw]` sorted for display, keeping the draw and red-five
 * flags attached to their copies.
 */
export function sortHandForDisplay(
  hand: readonly string[],
  draw: string | null | undefined,
  redFives: readonly string[] = [],
): DisplayTile[] {
  const remainingRed = new Map<string, number>();
  for (const code of redFives) {
    remainingRed.set(code, (remainingRed.get(code) ?? 0) + 1);
  }
  const takeRed = (code: string) => {
    const remaining = remainingRed.get(code) ?? 0;
    if (remaining === 0) return false;
    remainingRed.set(code, remaining - 1);
    return true;
  };

  const tiles: DisplayTile[] = hand.map((code, index) => ({
    code,
    isDraw: false,
    isRed: takeRed(code),
    sourceIndex: index,
  }));
  if (draw) {
    tiles.push({
      code: draw,
      isDraw: true,
      isRed: takeRed(draw),
      sourceIndex: hand.length,
    });
  }

  return tiles.sort(
    (left, right) =>
      tileSortValue(left.code) - tileSortValue(right.code) ||
      left.sourceIndex - right.sourceIndex,
  );
}
