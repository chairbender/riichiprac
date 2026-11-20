/**
 * The browser view's append-only session log (Q2r2).
 *
 * A review session must survive a page reload and be resumable: the queue and
 * the sidecar live on disk, so the browser only owns the entries recorded since
 * the page loaded. They are kept in a keyed `localStorage` slot, appended to in
 * the same order the reviewer clicked, and exported through the existing bulk
 * verdicts path. Entries are never rewritten; a later accept/reject for the
 * same queue id is a new line and wins.
 */

import { dispositionFor, latestVerdicts } from "./review-core.mjs";

export const SESSION_PREFIX = "riichiprac.review-session:";

/**
 * The storage key for a queue. Pack id plus the first and last queue id keeps
 * two packs (or a re-selected pack) from silently sharing a session.
 *
 * @param {any[]} items
 * @returns {string}
 */
export function sessionKey(items) {
  const first = items[0];
  const last = items[items.length - 1];
  const pack = first?.pack_id ?? "unknown-pack";
  return `${SESSION_PREFIX}${pack}:${first?.queue_id ?? "-"}:${last?.queue_id ?? "-"}`;
}

/**
 * A session over any `localStorage`-shaped object (`getItem`/`setItem`).
 *
 * @param {Storage} storage
 * @param {string} key
 */
export function createSession(storage, key) {
  const read = () => {
    const raw = storage.getItem(key);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed?.entries) ? parsed.entries : [];
    } catch {
      // A corrupted slot must not take the reviewer's queue down with it. The
      // file-based dispositions are still authoritative; only the unsaved
      // browser entries are lost.
      return [];
    }
  };

  const write = (entries) => {
    storage.setItem(key, JSON.stringify({ schema: "riichiprac.review-session", version: 1, entries }));
  };

  return {
    /** Every session entry, oldest first. */
    entries: () => read().slice(),
    /** Latest entry per queue id. */
    latest: () => latestVerdicts(read()),
    /** Record a verdict and return the new entry. */
    record(item, verdict, note, now) {
      const entries = read();
      const entry = dispositionFor(item, verdict, note, now);
      entries.push(entry);
      write(entries);
      return entry;
    },
    /** Drop the whole session (the on-disk sidecar is untouched). */
    clear() {
      storage.setItem(key, JSON.stringify({ schema: "riichiprac.review-session", version: 1, entries: [] }));
    },
  };
}
