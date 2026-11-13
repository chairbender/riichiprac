import { describe, expect, it } from 'vitest';
import { redFiveFlags } from './display';

describe('redFiveFlags', () => {
  it('marks the copies listed in red_fives and no others', () => {
    expect(
      redFiveFlags(['5p', '5p', '1m'], ['5p']),
    ).toEqual([true, false, false]);
  });

  it('marks one copy per entry when a hand holds two red fives', () => {
    expect(
      redFiveFlags(['5m', '5s', '5m'], ['5m', '5m']),
    ).toEqual([true, false, true]);
  });

  it('leaves an ordinary hand alone', () => {
    expect(redFiveFlags(['1m', '2p', '7z'], [])).toEqual([
      false,
      false,
      false,
    ]);
  });
});
