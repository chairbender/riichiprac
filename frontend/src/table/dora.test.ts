import { describe, expect, it } from 'vitest';
import { doraCodes, doraTileForIndicator } from './dora';

describe('dora indicators', () => {
  it('wraps suited ranks', () => {
    expect(doraTileForIndicator('1m')).toBe('2m');
    expect(doraTileForIndicator('8p')).toBe('9p');
    expect(doraTileForIndicator('9s')).toBe('1s');
  });

  it('cycles only within the winds and within the dragons', () => {
    expect(doraTileForIndicator('1z')).toBe('2z');
    expect(doraTileForIndicator('4z')).toBe('1z');
    expect(doraTileForIndicator('5z')).toBe('6z');
    expect(doraTileForIndicator('7z')).toBe('5z');
  });

  it('rejects malformed indicators rather than guessing', () => {
    expect(doraTileForIndicator('0m')).toBeNull();
    expect(doraTileForIndicator('5mr')).toBeNull();
    expect(doraTileForIndicator('m1')).toBeNull();
    expect(doraTileForIndicator('')).toBeNull();
  });

  it('collects every dora code, tolerating a missing list', () => {
    expect([...doraCodes(['1m', '4z', '5z', 'bad'])]).toEqual([
      '2m',
      '1z',
      '6z',
    ]);
    expect(doraCodes(undefined).size).toBe(0);
  });
});
