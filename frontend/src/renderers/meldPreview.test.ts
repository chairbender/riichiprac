import { describe, expect, it } from 'vitest';
import {
  clampMeldCount,
  DEFAULT_MELD_PREVIEW,
  MAX_MELDS,
  meldPreviewFixture,
  meldPreviewSearch,
  parseMeldPreviewOptions,
} from './meldPreview';

describe('meld layout preview: URL options', () => {
  it('defaults to the widest board: four melds per seat, a kan, human at 0', () => {
    const options = parseMeldPreviewOptions('');
    expect(options).toEqual(DEFAULT_MELD_PREVIEW);
    expect(options.meldCounts).toEqual([4, 4, 4, 4]);
    expect(options.kan).toBe(true);
    expect(options.humanSeat).toBe(0);
  });

  it('reads one count for every seat or four counts in seat order', () => {
    expect(parseMeldPreviewOptions('?melds=2').meldCounts).toEqual([2, 2, 2, 2]);
    expect(parseMeldPreviewOptions('?melds=0').meldCounts).toEqual([0, 0, 0, 0]);
    expect(parseMeldPreviewOptions('?melds=4,3,2,1').meldCounts).toEqual([
      4, 3, 2, 1,
    ]);
    // Whitespace and a leading '?' are both tolerated.
    expect(parseMeldPreviewOptions('melds=1, 2,3, 4').meldCounts).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it('clamps legal integers and falls back on malformed counts', () => {
    expect(parseMeldPreviewOptions('?melds=9').meldCounts).toEqual([4, 4, 4, 4]);
    expect(parseMeldPreviewOptions('?melds=-2').meldCounts).toEqual([0, 0, 0, 0]);
    expect(parseMeldPreviewOptions('?melds=9,8,7,6').meldCounts).toEqual([
      4, 4, 4, 4,
    ]);
    // A short list, a word or a missing entry is not a layout request.
    for (const search of ['?melds=1,2', '?melds=one', '?melds=1,2,3,x']) {
      expect(parseMeldPreviewOptions(search).meldCounts, search).toEqual(
        DEFAULT_MELD_PREVIEW.meldCounts,
      );
    }
  });

  it('reads the kan flag and the human seat strictly', () => {
    expect(parseMeldPreviewOptions('?kan=0').kan).toBe(false);
    expect(parseMeldPreviewOptions('?kan=false').kan).toBe(false);
    expect(parseMeldPreviewOptions('?kan=1').kan).toBe(true);
    expect(parseMeldPreviewOptions('?kan=true').kan).toBe(true);
    expect(parseMeldPreviewOptions('?kan').kan).toBe(true);
    expect(parseMeldPreviewOptions('?human=2').humanSeat).toBe(2);
    expect(parseMeldPreviewOptions('?human=9').humanSeat).toBe(0);
    expect(parseMeldPreviewOptions('?human=left').humanSeat).toBe(0);
  });

  it('round-trips an options set through the URL', () => {
    const options = parseMeldPreviewOptions('?melds=4,2,0,3&kan=0&human=1');
    const search = meldPreviewSearch(options);
    expect(parseMeldPreviewOptions(search)).toEqual(options);
    expect(search).toContain('preview=melds');
    expect(search).toContain('melds=4%2C2%2C0%2C3');
  });

  it('clamps counts for the controls', () => {
    expect(clampMeldCount(0)).toBe(0);
    expect(clampMeldCount(MAX_MELDS)).toBe(MAX_MELDS);
    expect(clampMeldCount(9)).toBe(MAX_MELDS);
    expect(clampMeldCount(-1)).toBe(0);
    expect(clampMeldCount(2.9)).toBe(2);
    expect(clampMeldCount(Number.NaN)).toBe(0);
  });
});

describe('meld layout preview: fixture board', () => {
  it('builds the requested melds for every seat at the requested revision', () => {
    const options = parseMeldPreviewOptions('?melds=4,3,2,1&kan=1&human=2');
    const snapshot = meldPreviewFixture(options, 7);
    expect(snapshot.revision).toBe(7);
    expect(snapshot.humanSeat).toBe(2);
    expect(snapshot.seats.map((seat) => seat.melds.length)).toEqual([
      4, 3, 2, 1,
    ]);
    // The fixture's first meld of every seat is the kan; the rest are pons.
    for (const seat of snapshot.seats) {
      for (const [index, meld] of seat.melds.entries()) {
        expect(meld.tiles).toHaveLength(index === 0 ? 4 : 3);
      }
    }
    // A four-meld hand leaves one concealed tile and a draw.
    expect(snapshot.seats[0].concealed).toHaveLength(1);
    expect(snapshot.seats[0].draw).not.toBeNull();
  });

  it('can build a meld-free board (the control baseline)', () => {
    const snapshot = meldPreviewFixture(
      parseMeldPreviewOptions('?melds=0&kan=0'),
      1,
    );
    expect(snapshot.seats.every((seat) => seat.melds.length === 0)).toBe(true);
    expect(snapshot.seats.every((seat) => seat.concealed.length === 13)).toBe(
      true,
    );
  });
});
