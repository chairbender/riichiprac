/**
 * Pure logic for the scenario-review browser view (Q2r2).
 *
 * The review queue is `reviews/<pack>/review-queue.jsonl`: one
 * `riichiprac.review-item` v1 per line with an embedded
 * `riichiprac.scenario-report`. The append-only sidecar is
 * `dispositions.jsonl`. Nothing here writes to either file: the browser view
 * folds an in-memory session log and exports it as a
 * `riichiprac.review-verdicts` document, which is the same bulk path
 * `mine_replays review --verdicts` already validates. That keeps P1b's
 * "every queued item has a disposition" gate intact.
 *
 * The modules here are plain ES modules so the page runs from any static file
 * server (`python3 -m http.server`) with no build step, and `vitest` can test
 * them directly.
 */

export const QUEUE_SCHEMA = "riichiprac.review-item";
export const QUEUE_VERSION = 1;
export const DISPOSITION_SCHEMA = "riichiprac.review-disposition";
export const DISPOSITION_VERSION = 1;
export const VERDICTS_SCHEMA = "riichiprac.review-verdicts";
export const VERDICTS_VERSION = 1;

export const STATUSES = /** @type {const} */ (["pending", "accepted", "rejected"]);
export const TURN_BUCKETS = /** @type {const} */ (["early", "mid", "late"]);
export const DEFAULT_SEED = "q2r2";

/**
 * Parse a review queue file. A malformed line names its 1-based line number, so
 * a reviewer can open the file rather than guess.
 *
 * @param {string} text
 * @returns {any[]}
 */
export function parseQueue(text) {
  const items = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === "") continue;
    let item;
    try {
      item = JSON.parse(line);
    } catch (error) {
      throw new Error(`queue line ${index + 1}: ${error.message}`);
    }
    if (item.schema !== QUEUE_SCHEMA) {
      throw new Error(
        `queue line ${index + 1}: schema \`${item.schema}\` is not \`${QUEUE_SCHEMA}\``,
      );
    }
    if (typeof item.version !== "number" || item.version > QUEUE_VERSION) {
      throw new Error(
        `queue line ${index + 1}: version ${item.version} is newer than ${QUEUE_VERSION}`,
      );
    }
    if (typeof item.queue_id !== "string" || item.queue_id.trim() === "") {
      throw new Error(`queue line ${index + 1}: item has no queue id`);
    }
    items.push(item);
  }
  return items;
}

/**
 * Parse a disposition sidecar. A missing file is the empty log.
 *
 * @param {string} text
 * @returns {any[]}
 */
export function parseDispositions(text) {
  const dispositions = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === "") continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (error) {
      throw new Error(`disposition line ${index + 1}: ${error.message}`);
    }
    if (entry.schema !== DISPOSITION_SCHEMA) {
      throw new Error(
        `disposition line ${index + 1}: schema \`${entry.schema}\` is not \`${DISPOSITION_SCHEMA}\``,
      );
    }
    dispositions.push(entry);
  }
  return dispositions;
}

/**
 * Fold an append-only disposition log: the last entry for a queue id wins.
 *
 * @param {any[]} dispositions
 * @returns {Map<string, any>}
 */
export function latestVerdicts(dispositions) {
  const latest = new Map();
  for (const entry of dispositions) {
    if (!entry || typeof entry.queue_id !== "string") continue;
    latest.set(entry.queue_id, entry);
  }
  return latest;
}

/** @param {any} verdict */
function normalizeVerdict(verdict) {
  return verdict === "accepted" || verdict === "rejected" ? verdict : null;
}

/**
 * The disposition state of one item.
 *
 * @param {any} item
 * @param {Map<string, any>} latest
 * @returns {"pending" | "accepted" | "rejected"}
 */
export function statusOf(item, latest) {
  return normalizeVerdict(latest.get(item.queue_id)?.verdict) ?? "pending";
}

/**
 * Session progress. Counts cover the whole queue, never the filtered view, so
 * "how much is left?" has the same answer whatever filter is on screen.
 *
 * @param {any[]} items
 * @param {Map<string, any>} latest
 */
export function summarize(items, latest) {
  const summary = {
    total: items.length,
    pending: 0,
    accepted: 0,
    rejected: 0,
    byLesson: /** @type {Record<string, number>} */ ({}),
    bySection: /** @type {Record<string, number>} */ ({}),
    byFamily: /** @type {Record<string, number>} */ ({}),
    byTurn: /** @type {Record<string, number>} */ ({}),
  };
  for (const item of items) {
    summary[statusOf(item, latest)] += 1;
    const lesson = item.lesson ?? "-";
    summary.byLesson[lesson] = (summary.byLesson[lesson] ?? 0) + 1;
    const section = item.book_section ?? "-";
    summary.bySection[section] = (summary.bySection[section] ?? 0) + 1;
    const family = item.replay_family ?? "-";
    summary.byFamily[family] = (summary.byFamily[family] ?? 0) + 1;
    const turn = item.turn_bucket ?? "-";
    summary.byTurn[turn] = (summary.byTurn[turn] ?? 0) + 1;
  }
  return summary;
}

/** @param {string} section @param {string} wanted */
function sectionMatches(section, wanted) {
  return section === wanted || section.startsWith(`${wanted}.`);
}

/** @param {any} item @param {string} wanted */
function turnMatches(item, wanted) {
  if (item.turn_bucket === wanted) return true;
  if (!/^\d+$/.test(wanted)) return false;
  return item.turn === Number.parseInt(wanted, 10);
}

/**
 * Narrow the queue. Empty arrays mean "do not filter"; populated dimensions AND
 * together. Mirrors `ReviewFilter` in `src/miner/select/review.rs`, so the CLI
 * and the browser show the same rows for the same filter.
 *
 * @param {any[]} items
 * @param {Map<string, any>} latest
 * @param {{lessons?: string[], sections?: string[], families?: string[], turns?: string[], statuses?: string[]}} filter
 * @returns {any[]}
 */
export function filterItems(items, latest, filter = {}) {
  const lessons = filter.lessons ?? [];
  const sections = filter.sections ?? [];
  const families = filter.families ?? [];
  const turns = filter.turns ?? [];
  const statuses = filter.statuses ?? [];
  return items.filter((item) => {
    if (lessons.length > 0 && !lessons.includes(item.lesson)) return false;
    if (
      sections.length > 0 &&
      !sections.some((wanted) => sectionMatches(item.book_section ?? "", wanted))
    ) {
      return false;
    }
    if (families.length > 0 && !families.includes(item.replay_family)) return false;
    if (turns.length > 0 && !turns.some((wanted) => turnMatches(item, wanted))) return false;
    if (statuses.length > 0 && !statuses.includes(statusOf(item, latest))) return false;
    return true;
  });
}

const MASK64 = (1n << 64n) - 1n;

/**
 * FNV-1a 64 over `seed\0queue_id`.
 *
 * @param {string} seed
 * @param {string} queueId
 * @returns {bigint}
 */
export function fnv1a64(seed, queueId) {
  const bytes = new TextEncoder().encode(`${seed}\u0000${queueId}`);
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & MASK64;
  }
  return hash;
}

/**
 * The sample order key: FNV-1a 64 then the SplitMix64 finalizer.
 *
 * FNV alone keeps sequential queue ids (`-001`, `-002`, ...) in order, which
 * would turn a "sample" into "the first N". The finalizer scatters them.
 * `src/miner/select/review.rs::sample_key` implements the same rule and pins
 * the same vectors, so both tools draw the same sample for a seed.
 *
 * @param {string} seed
 * @param {string} queueId
 * @returns {bigint}
 */
export function sampleKey(seed, queueId) {
  let hash = fnv1a64(seed, queueId);
  hash = ((hash ^ (hash >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  hash = ((hash ^ (hash >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return (hash ^ (hash >> 31n)) & MASK64;
}

/**
 * Deterministic sample: rank by `sampleKey`, take `count`, then restore queue
 * order so a batch pass walks the file the way `select` wrote it.
 *
 * @param {any[]} items
 * @param {number} count
 * @param {string} seed
 * @returns {any[]}
 */
export function sampleItems(items, count, seed) {
  if (!Number.isFinite(count) || count <= 0) return [];
  if (count >= items.length) return items.slice();
  const ranked = items.map((item, index) => ({
    index,
    key: sampleKey(seed, item.queue_id),
    id: item.queue_id,
  }));
  ranked.sort((a, b) => {
    if (a.key < b.key) return -1;
    if (a.key > b.key) return 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return ranked
    .slice(0, count)
    .map((row) => row.index)
    .sort((a, b) => a - b)
    .map((index) => items[index]);
}

/**
 * The graded answer as the CLI prints it (`fold 3m`, `riichi 5s`, `pass`).
 *
 * @param {any} action `table.correct_action`
 * @returns {string}
 */
export function answerText(action) {
  if (!action || typeof action !== "object") return String(action ?? "?");
  switch (action.type) {
    case "riichi":
      return `riichi ${action.discard}`;
    case "dama":
      return `dama ${action.discard}`;
    case "fold":
      return `fold ${action.discard}`;
    case "kan":
      return `kan ${action.tile}`;
    case "discard":
      return `discard ${action.tile}`;
    case "pass":
      return "pass";
    case "best":
      return `best ${action.label ?? action.action ?? "?"}`;
    default:
      return String(action.type ?? "?");
  }
}

/**
 * One-line context for a queue row: round, scores, dora and riichi players.
 *
 * @param {any} table
 * @returns {string}
 */
export function contextLine(table) {
  if (!table) return "";
  const round = `${table.round_wind ?? "?"}${table.hand_number ?? "?"}`;
  const honba = table.honba ? ` h${table.honba}` : "";
  const scores = (table.players ?? [])
    .map((player) => {
      const name = player.is_human ? "You" : (player.wind ?? "?");
      return `${name} ${Math.trunc((player.score ?? 0) / 100)}`;
    })
    .join(", ");
  const dora = (table.dora_indicators ?? []).join("") || "-";
  const riichi = (table.players ?? [])
    .filter((player) => player.is_riichi)
    .map((player) => (player.is_human ? "You" : (player.wind ?? "?")))
    .join(",");
  return `${round}${honba}; ${scores}; dora ${dora}; riichi ${riichi || "-"}; shanten ${table.shanten ?? "?"}`;
}

/**
 * The Mortal ranking a reviewer reads, highest probability first.
 *
 * @param {any} item
 * @param {number} [limit]
 * @returns {{label: string, action: string, probability: number}[]}
 */
export function mortalRanking(item, limit = 5) {
  const entries = item?.review?.ai?.evaluation?.evaluations;
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => ({
      label: entry.label ?? entry.action ?? "?",
      action: entry.action ?? "?",
      probability: typeof entry.probability === "number" ? entry.probability : 0,
    }))
    .sort((a, b) => b.probability - a.probability)
    .slice(0, limit);
}

/**
 * A `YYYYMMDD-HHMMSS` UTC stamp, matching `utc_stamp` in the miner.
 *
 * @param {Date} [date]
 * @returns {string}
 */
export function utcStamp(date = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

/**
 * Build one append-only disposition line for the session log.
 *
 * @param {any} item
 * @param {"accepted" | "rejected"} verdict
 * @param {string} note
 * @param {Date} [now]
 */
export function dispositionFor(item, verdict, note, now = new Date()) {
  const entry = {
    schema: DISPOSITION_SCHEMA,
    version: DISPOSITION_VERSION,
    queue_id: item.queue_id,
    decision_id: item.decision_id ?? "",
    verdict,
    reviewed_at: utcStamp(now),
  };
  const trimmed = note?.trim();
  if (trimmed) entry.note = trimmed;
  return entry;
}

/**
 * The latest session entry per item, as a `riichiprac.review-verdicts` v1
 * document. Duplicate queue ids would be rejected by `read_verdicts`, so only
 * the newest entry per id is exported: latest wins, exactly like the sidecar.
 *
 * @param {any[]} sessionEntries
 * @param {string} [note] run-wide fallback note
 */
export function buildVerdictsDocument(sessionEntries, note = "") {
  const latest = latestVerdicts(sessionEntries);
  const verdicts = [...latest.values()]
    .map((entry) => {
      const verdict = { queue_id: entry.queue_id, verdict: entry.verdict };
      if (entry.note) verdict.reason = entry.note;
      return verdict;
    })
    .sort((a, b) => (a.queue_id < b.queue_id ? -1 : a.queue_id > b.queue_id ? 1 : 0));
  const document = {
    schema: VERDICTS_SCHEMA,
    version: VERDICTS_VERSION,
    verdicts,
  };
  const trimmed = note?.trim();
  if (trimmed) document.note = trimmed;
  return document;
}

/**
 * Serialize session entries as a disposition sidecar body. Appending this to
 * `dispositions.jsonl` is equivalent to `mine_replays review --verdicts` but
 * keeps the browser's note text per line.
 *
 * @param {any[]} sessionEntries
 * @returns {string}
 */
export function dispositionsJsonl(sessionEntries) {
  if (sessionEntries.length === 0) return "";
  return `${sessionEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}
