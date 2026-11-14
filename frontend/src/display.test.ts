import { describe, expect, it } from 'vitest';
import { sortHandForDisplay, tileSortValue } from './display';

describe('sortHandForDisplay', () => {
  it('orders manzu, pinzu, souzu, then honors', () => {
    const sorted = sortHandForDisplay(
      ['7z', '3s', '1p', '9m', '1z', '2m', '5p'],
      null,
    );
    expect(sorted.map((tile) => tile.code)).toEqual([
      '2m',
      '9m',
      '1p',
      '5p',
      '3s',
      '1z',
      '7z',
    ]);
  });

  it('sorts the drawn tile with the rest of the hand and keeps its flag', () => {
    const sorted = sortHandForDisplay(
      ['9s', '1m', '5p', '3m'],
      '2p',
      [],
    );
    expect(sorted.map((tile) => tile.code)).toEqual([
      '1m',
      '3m',
      '2p',
      '5p',
      '9s',
    ]);
    const draw = sorted.find((tile) => tile.isDraw);
    expect(draw).toMatchObject({ code: '2p', isDraw: true, isRed: false });
    expect(sorted.filter((tile) => !tile.isDraw)).toHaveLength(4);
  });

  it('keeps red-five flags on the copies they were assigned to', () => {
    const sorted = sortHandForDisplay(
      ['5p', '5p', '1m'],
      '5p',
      ['5p'],
    );
    expect(sorted.map((tile) => tile.code)).toEqual(['1m', '5p', '5p', '5p']);
    expect(sorted.filter((tile) => tile.isRed)).toHaveLength(1);
    expect(sorted.find((tile) => tile.isDraw)).toMatchObject({
      code: '5p',
      isDraw: true,
    });
  });

  it('marks an unrecognised code last instead of scrambling the hand', () => {
    expect(tileSortValue('1m')).toBeLessThan(tileSortValue('1p'));
    expect(tileSortValue('1p')).toBeLessThan(tileSortValue('1s'));
    expect(tileSortValue('9s')).toBeLessThan(tileSortValue('1z'));
    expect(tileSortValue('7z')).toBeLessThan(tileSortValue('?'));
  });
});
