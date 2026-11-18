import { describe, expect, it } from 'vitest';
import { pickUnseen } from './session';

function pool(ids: string[]) {
  return ids.map((id) => ({ id }));
}

describe('pickUnseen', () => {
  it('draws every pool item once before repeating', () => {
    const seen = new Set<string>();
    const ids = ['a', 'b', 'c'];
    const draws = ids.map(
      () => pickUnseen(pool(ids), (value) => value.id, seen, () => 0).value.id,
    );
    expect(new Set(draws)).toEqual(new Set(ids));
    expect(seen).toEqual(new Set(ids));
  });

  it('starts a new cycle only after the whole pool is seen', () => {
    const seen = new Set<string>();
    const items = pool(['a', 'b']);

    expect(pickUnseen(items, (value) => value.id, seen, () => 0)).toEqual({
      value: { id: 'a' },
      reset: false,
    });
    expect(pickUnseen(items, (value) => value.id, seen, () => 0)).toEqual({
      value: { id: 'b' },
      reset: false,
    });
    expect(pickUnseen(items, (value) => value.id, seen, () => 0)).toEqual({
      value: { id: 'a' },
      reset: true,
    });
  });

  it('forgets only the exhausted pool when a cycle resets', () => {
    const seen = new Set(['outside', 'a']);
    const items = pool(['a']);
    expect(pickUnseen(items, (value) => value.id, seen).reset).toBe(true);
    expect(seen.has('outside')).toBe(true);
    expect(seen.has('a')).toBe(true);
  });

  it('never returns an id already seen while unseen siblings remain', () => {
    const items = pool(['a', 'b', 'c']);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const seen = new Set(['a']);
      const pick = pickUnseen(items, (value) => value.id, seen, Math.random);
      expect(pick.value.id).not.toBe('a');
      expect(pick.reset).toBe(false);
    }
  });

  it('clamps a random double outside [0, 1)', () => {
    const seen = new Set<string>();
    expect(pickUnseen(pool(['a', 'b']), (value) => value.id, seen, () => 2).value.id).toBe('b');
    expect(pickUnseen(pool(['a', 'b']), (value) => value.id, seen, () => -1).value.id).toBe('a');
  });

  it('rejects an empty pool', () => {
    expect(() => pickUnseen([], (value: string) => value, new Set())).toThrow(/non-empty/);
  });
});
