/**
 * Session-scoped "seen" picking.
 *
 * A drill should not repeat while it still has unseen siblings. The user sees
 * each id in a pool once, in random order; when the pool is exhausted the
 * caller starts a new cycle. The state is a plain `Set<string>` held in a ref,
 * so it lives for the page session only and a reload starts fresh.
 *
 * The helper removes only the exhausted pool's ids from the set. A generated
 * lesson's catalogue and a pack lesson's scenario list can therefore share one
 * guard without one pool's new cycle forgetting what the other pool has seen.
 */

/** One random draw from an unseen pool. */
export interface UnseenPick<T> {
  /** The chosen item. */
  value: T;
  /** True when every pool item had been seen and a new cycle started. */
  reset: boolean;
}

/**
 * Pick one item whose key is not in `seen`, marking it seen.
 *
 * When every item in `pool` is already seen, the pool's keys are removed from
 * `seen` (starting a new cycle) and one item is picked from the full pool. The
 * `random` value is clamped to the list, so a test double outside `[0, 1)` is
 * harmless.
 */
export function pickUnseen<T>(
  pool: readonly T[],
  keyOf: (value: T) => string,
  seen: Set<string>,
  random: () => number = Math.random,
): UnseenPick<T> {
  if (pool.length === 0) {
    throw new Error('pickUnseen needs a non-empty pool');
  }

  let available = pool.filter((value) => !seen.has(keyOf(value)));
  let reset = false;
  if (available.length === 0) {
    for (const value of pool) {
      seen.delete(keyOf(value));
    }
    available = [...pool];
    reset = true;
  }

  const index = Math.min(
    available.length - 1,
    Math.max(0, Math.floor(random() * available.length)),
  );
  const value = available[index];
  seen.add(keyOf(value));
  return { value, reset };
}
