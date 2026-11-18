import { describe, expect, it } from 'vitest';
import {
  TILE_FACE_IDS,
  faceIdForTile,
  isRedFiveFace,
  isTileFaceId,
} from './contract';

describe('3D face vocabulary', () => {
  it('lists the 34 standard faces, the three red fives and blank, in atlas order', () => {
    expect(TILE_FACE_IDS).toHaveLength(38);
    expect(new Set(TILE_FACE_IDS).size).toBe(38);
    expect(TILE_FACE_IDS.slice(0, 9)).toEqual([
      '1m',
      '2m',
      '3m',
      '4m',
      '5m',
      '6m',
      '7m',
      '8m',
      '9m',
    ]);
    expect(TILE_FACE_IDS.slice(9, 18)).toEqual([
      '1p',
      '2p',
      '3p',
      '4p',
      '5p',
      '6p',
      '7p',
      '8p',
      '9p',
    ]);
    expect(TILE_FACE_IDS.slice(18, 27)).toEqual([
      '1s',
      '2s',
      '3s',
      '4s',
      '5s',
      '6s',
      '7s',
      '8s',
      '9s',
    ]);
    expect(TILE_FACE_IDS.slice(27)).toEqual([
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
    ]);
  });

  it('narrows only committed face ids', () => {
    expect(isTileFaceId('5m')).toBe(true);
    expect(isTileFaceId('5mr')).toBe(true);
    expect(isTileFaceId('blank')).toBe(true);
    expect(isTileFaceId('0m')).toBe(false);
    expect(isTileFaceId('8z')).toBe(false);
    expect(isTileFaceId('')).toBe(false);
    expect(isTileFaceId(5)).toBe(false);
  });

  it('names the three red-five faces', () => {
    expect(TILE_FACE_IDS.filter(isRedFiveFace)).toEqual([
      '5mr',
      '5pr',
      '5sr',
    ]);
  });

  it('keeps a plain five plain and promotes only a flagged five', () => {
    expect(faceIdForTile('5m')).toBe('5m');
    expect(faceIdForTile('5m', true)).toBe('5mr');
    expect(faceIdForTile('5p', true)).toBe('5pr');
    expect(faceIdForTile('5s', true)).toBe('5sr');
    expect(faceIdForTile('1z')).toBe('1z');
    expect(faceIdForTile('blank')).toBe('blank');
    expect(faceIdForTile('')).toBe('blank');
  });

  it('fails loudly on an impossible red five or an unknown code', () => {
    expect(() => faceIdForTile('4m', true)).toThrow(/cannot be a red five/);
    expect(() => faceIdForTile('0m')).toThrow(/unknown tile code/);
    expect(() => faceIdForTile('5x')).toThrow(/unknown tile code/);
    expect(() => faceIdForTile('8z')).toThrow(/unknown tile code/);
  });
});
