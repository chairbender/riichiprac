/**
 * Parse and build the `?preview=melds` layout board (task 261120-2225).
 *
 * The preview exists so the meld composition can be reviewed without dealing a
 * hand that happens to contain four melds: it draws the deterministic
 * {@link boardFixture} instead of game state, with controls for each seat's meld
 * count, the kan, and the human seat. Pure (no DOM): the component reads
 * `location.search` and writes the URL, and the parser/builder are directly
 * testable.
 *
 * URL shape:
 *
 *   ?preview=melds&melds=4,4,4,4&kan=1&human=0
 *
 * - `melds` is one count for every absolute seat (`4`) or four counts in seat
 *   order, 0-4 (`4,3,2,1`);
 * - `kan=1` makes each seat's first meld a four-tile kan;
 * - `human` is the human's absolute seat, 0-3.
 *
 * Anything absent or malformed falls back to {@link DEFAULT_MELD_PREVIEW}: the
 * widest board (four melds per seat, a kan, the human at seat 0).
 */

import type { Seat, TableSnapshot } from './contract';
import { boardFixture } from './three/boardFixture';

/** Four meld counts, in absolute seat order. */
export type MeldCounts = readonly [number, number, number, number];

export interface MeldPreviewOptions {
  readonly meldCounts: MeldCounts;
  /** Whether each seat's first meld is a four-tile kan. */
  readonly kan: boolean;
  readonly humanSeat: Seat;
}

export const MAX_MELDS = 4;

export const DEFAULT_MELD_PREVIEW: MeldPreviewOptions = {
  meldCounts: [MAX_MELDS, MAX_MELDS, MAX_MELDS, MAX_MELDS],
  kan: true,
  humanSeat: 0,
};

/** Clamp one meld count to the legal 0-4 range. */
export function clampMeldCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_MELDS, Math.max(0, Math.trunc(value)));
}

/** One count for every seat, or four comma-separated counts. */
function parseMeldCounts(raw: string | null): MeldCounts {
  if (raw === null) return DEFAULT_MELD_PREVIEW.meldCounts;
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 1) {
    const count = Number(parts[0]);
    if (!Number.isFinite(count)) return DEFAULT_MELD_PREVIEW.meldCounts;
    const clamped = clampMeldCount(count);
    return [clamped, clamped, clamped, clamped];
  }
  if (parts.length !== 4) return DEFAULT_MELD_PREVIEW.meldCounts;
  const counts = parts.map((part) => Number(part));
  if (counts.some((value) => !Number.isFinite(value))) {
    return DEFAULT_MELD_PREVIEW.meldCounts;
  }
  return counts.map(clampMeldCount) as unknown as MeldCounts;
}

/** A flag that is on for `?kan`, `?kan=1`, `?kan=true` and off otherwise. */
function parseKan(raw: string | null): boolean {
  if (raw === null) return DEFAULT_MELD_PREVIEW.kan;
  return raw === '' || raw === '1' || raw === 'true';
}

/** The human seat, 0-3; anything else is seat 0. */
function parseHuman(raw: string | null): Seat {
  const seat = raw === null ? Number.NaN : Number(raw);
  return Number.isInteger(seat) && seat >= 0 && seat <= 3
    ? (seat as Seat)
    : DEFAULT_MELD_PREVIEW.humanSeat;
}

/** Read the preview options from a URL search string (with or without `?`). */
export function parseMeldPreviewOptions(search: string): MeldPreviewOptions {
  const params = new URLSearchParams(
    search.startsWith('?') ? search.slice(1) : search,
  );
  return {
    meldCounts: parseMeldCounts(params.get('melds')),
    kan: parseKan(params.get('kan')),
    humanSeat: parseHuman(params.get('human')),
  };
}

/** The canonical URL for a preview options set. */
export function meldPreviewSearch(options: MeldPreviewOptions): string {
  const params = new URLSearchParams();
  params.set('preview', 'melds');
  params.set('melds', options.meldCounts.join(','));
  params.set('kan', options.kan ? '1' : '0');
  params.set('human', String(options.humanSeat));
  return `?${params.toString()}`;
}

/**
 * The fixture board for the preview.
 *
 * `revision` must change whenever the options change: the renderer treats a new
 * revision as a cut, so a control click redraws rather than animating a diff
 * between two unrelated boards.
 */
export function meldPreviewFixture(
  options: MeldPreviewOptions,
  revision: number,
): TableSnapshot {
  return {
    ...boardFixture({
      humanSeat: options.humanSeat,
      meldCounts: options.meldCounts,
      kan: options.kan,
    }),
    revision,
  };
}
