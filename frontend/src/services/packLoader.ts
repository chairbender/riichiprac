/**
 * Loads the published scenario-pack manifest and one pack body at a time.
 *
 * The startup path fetches only the small same-origin manifest
 * (`scenarios/manifest.json`). A pack body is fetched the first time a lesson
 * from that pack is dealt, verified against the manifest's SHA-256 and byte
 * count *before* it is parsed, and cached in IndexedDB so a returning visitor
 * downloads nothing. The body is a gzipped `riichiprac.scenario-pack` v1
 * document; each scenario's `state` is a complete engine `GameState`, so the
 * app renders it through the same import path as any other hand and adds no
 * game logic.
 *
 * This mirrors `weightLoader.ts` deliberately: an ordered source list
 * (same-origin first, optional mirror second), an HTML-fallback guard, a
 * versioned IndexedDB key, and swallowed cache failures. The pack-specific
 * difference is that the cache key includes the content address, so a new body
 * can never be served under an old hash.
 *
 * Hosting contract: `hosting-plan.md` §7. The body must arrive as the exact
 * bytes on disk (`application/gzip`, **no** `Content-Encoding`); a server that
 * decompresses `.gz` responses makes the byte-count/SHA-256 check fail before
 * the loader can parse anything. Publishing/audit contract:
 * `replay-miner-operations.md`.
 *
 * First deal (RF4): a launch may open with a replay hand, so the app awaits the
 * manifest and then one body before drawing anything. Both phases are bounded
 * by {@link FIRST_DEAL_BUDGET_MS} through {@link withDeadline}, and a phase that
 * misses its budget deals the generated hand instead of holding the table.
 */
import { pickUnseen } from '../session';
import { isCorrectAction } from '../actions';

/** Schema names shared with `src/miner/pack/model.rs`. */
export const PACK_SCHEMA = 'riichiprac.scenario-pack';
export const PACK_MANIFEST_SCHEMA = 'riichiprac.scenario-pack-manifest';
export const PACK_SCHEMA_VERSION = 1;

/**
 * Bump when the cached value's meaning changes. Part of the IndexedDB key, so a
 * new version re-downloads instead of reusing an incompatible entry.
 */
export const PACK_CACHE_VERSION = 'v1';

/** The manifest is tiny; anything larger is an error page or a wrong file. */
export const MAX_MANIFEST_BYTES = 512 * 1024;

/**
 * Sanity ceiling for one declared body. The Pages budget is 50 MB for the whole
 * set and the fixture is a few KiB; a larger declaration is treated as a bad
 * manifest rather than something to attempt.
 */
export const MAX_PACK_BYTES = 64 * 1024 * 1024;

/** Manifest file name inside the hosting directory. */
export const MANIFEST_FILE_NAME = 'manifest.json';

/** Same-origin directory Vite copies from `frontend/public/scenarios/`. */
export const PACKS_DIRECTORY = `${import.meta.env.BASE_URL}scenarios/`;

/**
 * How long the first deal of a launch may spend on **each** of its pack phases
 * (the manifest, then one body) before falling back to the generated hand.
 *
 * RF4 makes the first hand replay-first at the cost of one small manifest and
 * one section body (measured in `replay-first-rollout.md`, "First deal"). A
 * slow or captive network must not hold the table hostage, so the deal gives a
 * phase this budget and then deals generated; the losing request is not
 * cancelled, so a late body still lands in the IndexedDB cache for the next
 * hand.
 */
export const FIRST_DEAL_BUDGET_MS = 2500;

/** Optional build-time manifest override (`VITE_PACK_MANIFEST_URL`). */
const OVERRIDE_MANIFEST_URL = import.meta.env.VITE_PACK_MANIFEST_URL;

/**
 * Optional mirror for the bodies (`VITE_PACK_MIRROR_URL`), for example
 * `https://mirror.example/scenarios/`. The manifest always stays same-origin;
 * the mirror only serves the same relative body paths, as documented in
 * `hosting-plan.md`.
 */
const MIRROR_BASE = import.meta.env.VITE_PACK_MIRROR_URL;

/** One runtime manifest entry (`ManifestEntry` in Rust). */
export interface PackManifestEntry {
  id: string;
  path: string;
  sha256: string;
  bytes: number;
  scenario_count: number;
  lesson_ids: string[];
  /**
   * Shipped reviewed bases per lesson id.
   *
   * The replay-first coverage floor is measured in reviewed bases, so variants
   * do not add to a lesson's count. The field is additive within manifest v1:
   * `undefined` means the manifest was published before it existed, and then
   * only a body can supply coverage. `pack publish` writes it for every pack.
   */
  lesson_counts?: Record<string, number>;
  book_sections: string[];
  licence: string;
  requires_model: boolean;
  data_commercial_use: boolean;
}

/** The runtime manifest (`riichiprac.scenario-pack-manifest` v1). */
export interface PackManifest {
  schema: string;
  version: number;
  updated_at: string;
  packs: PackManifestEntry[];
}

/** One contributing agent, kept for the provenance line and validation only. */
export interface PackAgent {
  agent_id?: string;
  kind?: string;
  engine?: string;
  engine_version?: string;
  licence?: { id?: string; attribution?: string };
}

/** The pack-level source/licence record the runtime fails closed on. */
export interface PackSource {
  kind?: string;
  corpus_id?: string;
  licence?: string;
  attribution?: string;
  redistributable?: boolean;
  data_commercial_use?: boolean;
  agents?: PackAgent[];
}

/** The book section a pack scenario belongs to, when it has one. */
export interface PackScenarioBook {
  chapter: number;
  section: number;
  key: string;
  label: string;
}

/**
 * One shipped scenario.
 *
 * `state` is deliberately not narrowed to the frontend `GameState` here: the
 * loader checks the minimum rendering contract and hands the JSON to the
 * existing import path, which validates it again. Everything except the fields
 * the picker/loader actually needs is tolerated and carried through untouched.
 */
export interface PackScenario {
  id: string;
  lesson_id: string;
  book?: PackScenarioBook | null;
  title: string;
  prompt: string;
  state: Record<string, unknown>;
  correct_action: Record<string, unknown>;
  accepted?: string[];
  [extra: string]: unknown;
}

/** A decoded, verified pack body. */
export interface ScenarioPack {
  schema: string;
  version: number;
  pack_id: string;
  generated_at?: string;
  source: PackSource;
  scenarios: PackScenario[];
}

/** A loaded pack plus the lesson lookup the picker/dealer needs. */
export interface LoadedPack {
  entry: PackManifestEntry;
  pack: ScenarioPack;
  /** Scenarios grouped by lesson id, in body order. */
  byLesson: Map<string, PackScenario[]>;
  /** True when the bytes came from IndexedDB, not the network. */
  fromCache: boolean;
}

/** How the manifest fetch ended; drives the picker's loading/empty/error note. */
export type PackManifestStatus = 'loading' | 'ready' | 'empty' | 'error';

/** Error category, so callers can distinguish a bad document from a network miss. */
export type PackErrorKind = 'manifest' | 'fetch' | 'integrity' | 'gzip' | 'schema';

/** A pack failure with a user-safe message (never contains an answer). */
export class PackLoadError extends Error {
  readonly kind: PackErrorKind;

  constructor(kind: PackErrorKind, message: string) {
    super(message);
    this.name = 'PackLoadError';
    this.kind = kind;
  }
}

/** Where the manifest is fetched from: override, otherwise same-origin. */
export function packManifestUrl(): string {
  return OVERRIDE_MANIFEST_URL || `${PACKS_DIRECTORY}${MANIFEST_FILE_NAME}`;
}

/**
 * Settle with `promise`, or reject with a {@link PackLoadError} once `ms` pass.
 *
 * The first deal uses this so a manifest or body that never arrives cannot
 * leave the table on a loading state: the deal falls back to the generated
 * hand. The losing promise is deliberately not cancelled — a body that lands
 * after the deadline still reaches the IndexedDB cache for the next hand — and
 * its rejection is consumed here so nothing surfaces as an unhandled error.
 */
export function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  description: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new PackLoadError(
          'fetch',
          `Timed out after ${ms} ms waiting for ${description}.`,
        ),
      );
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Body URLs `loadPack` tries, in order: same-origin, then the optional mirror.
 * Duplicates are dropped so an override equal to the primary is one request.
 */
export function packBodyUrls(
  entry: PackManifestEntry,
  mirrorBase: string | null | undefined = MIRROR_BASE,
): string[] {
  const urls: string[] = [`${PACKS_DIRECTORY}${entry.path}`];
  if (typeof mirrorBase === 'string' && mirrorBase.trim() !== '') {
    const base = mirrorBase.endsWith('/') ? mirrorBase : `${mirrorBase}/`;
    urls.push(`${base}${entry.path}`);
  }
  return urls.filter((url, index) => urls.indexOf(url) === index);
}

/** IndexedDB key: pack id + content address + cache version. */
export function packCacheKey(entry: PackManifestEntry): string {
  return `${entry.id}@${entry.sha256.toLowerCase()}@${PACK_CACHE_VERSION}`;
}

/* -------------------------------------------------------------------------- */
/* Manifest                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Fetch and validate the runtime manifest.
 *
 * A missing or malformed manifest is an error the picker can display; it must
 * never stop the generated lessons from working. An empty `packs` array is
 * valid (the picker shows an empty state) so a deployment mid-publish still
 * starts.
 */
export async function fetchPackManifest(
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<PackManifest> {
  const url = packManifestUrl();
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (err) {
    throw new PackLoadError(
      'fetch',
      `Could not reach the replay pack manifest (${url}): ${errorMessage(err)}`,
    );
  }
  if (!response.ok) {
    throw new PackLoadError(
      'fetch',
      `The replay pack manifest (${url}) answered HTTP ${response.status}.`,
    );
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_MANIFEST_BYTES) {
    throw new PackLoadError(
      'manifest',
      `The replay pack manifest is ${bytes.byteLength} bytes, above the ${MAX_MANIFEST_BYTES}-byte ceiling.`,
    );
  }
  if (looksLikeHtml(response, bytes)) {
    throw new PackLoadError(
      'manifest',
      `The replay pack manifest (${url}) is an HTML page, not JSON.`,
    );
  }

  return parsePackManifest(decodeUtf8(bytes));
}

/** Parse and validate the manifest JSON. Throws {@link PackLoadError}. */
export function parsePackManifest(text: string): PackManifest {
  const value = parseJson(text, 'The replay pack manifest is not valid JSON.');

  if (!isRecord(value)) {
    throw new PackLoadError('manifest', 'The replay pack manifest is not a JSON object.');
  }
  if (value.schema !== PACK_MANIFEST_SCHEMA) {
    throw new PackLoadError(
      'manifest',
      `Unsupported replay pack manifest schema "${String(value.schema)}" (expected ${PACK_MANIFEST_SCHEMA}).`,
    );
  }
  if (value.version !== PACK_SCHEMA_VERSION) {
    throw new PackLoadError(
      'manifest',
      `Unsupported replay pack manifest version ${String(value.version)} (expected ${PACK_SCHEMA_VERSION}).`,
    );
  }
  if (typeof value.updated_at !== 'string' || value.updated_at.trim() === '') {
    throw new PackLoadError('manifest', 'The replay pack manifest has no updated_at timestamp.');
  }
  if (!Array.isArray(value.packs)) {
    throw new PackLoadError('manifest', 'The replay pack manifest has no packs array.');
  }

  const ids = new Set<string>();
  const packs = value.packs.map((raw, index) => {
    const entry = parseManifestEntry(raw, index);
    if (ids.has(entry.id)) {
      throw new PackLoadError('manifest', `The replay pack manifest lists "${entry.id}" twice.`);
    }
    ids.add(entry.id);
    return entry;
  });

  return {
    schema: PACK_MANIFEST_SCHEMA,
    version: PACK_SCHEMA_VERSION,
    updated_at: value.updated_at,
    packs,
  };
}

function parseManifestEntry(raw: unknown, index: number): PackManifestEntry {
  const label = `Replay pack entry ${index + 1}`;
  if (!isRecord(raw)) {
    throw new PackLoadError('manifest', `${label} is not an object.`);
  }
  if (!isSlug(raw.id)) {
    throw new PackLoadError('manifest', `${label}: id is not a safe pack id.`);
  }
  if (!isSafePackPath(raw.path)) {
    throw new PackLoadError(
      'manifest',
      `${label} (${raw.id}): path is not a safe relative .json.gz file name.`,
    );
  }
  if (!isSha256(raw.sha256)) {
    throw new PackLoadError('manifest', `${label} (${raw.id}): sha256 is not 64 hex characters.`);
  }
  if (!isPositiveInteger(raw.bytes) || raw.bytes > MAX_PACK_BYTES) {
    throw new PackLoadError(
      'manifest',
      `${label} (${raw.id}): bytes must be a positive integer no larger than ${MAX_PACK_BYTES}.`,
    );
  }
  if (!isPositiveInteger(raw.scenario_count)) {
    throw new PackLoadError('manifest', `${label} (${raw.id}): scenario_count must be positive.`);
  }
  if (!isStringArray(raw.lesson_ids) || raw.lesson_ids.length === 0) {
    throw new PackLoadError('manifest', `${label} (${raw.id}): lesson_ids must be a non-empty string array.`);
  }
  if (!isStringArray(raw.book_sections)) {
    throw new PackLoadError('manifest', `${label} (${raw.id}): book_sections must be a string array.`);
  }
  if (typeof raw.licence !== 'string' || raw.licence.trim() === '') {
    throw new PackLoadError('manifest', `${label} (${raw.id}): licence is missing.`);
  }
  if (typeof raw.requires_model !== 'boolean') {
    throw new PackLoadError('manifest', `${label} (${raw.id}): requires_model must be a boolean.`);
  }
  if (typeof raw.data_commercial_use !== 'boolean') {
    throw new PackLoadError('manifest', `${label} (${raw.id}): data_commercial_use must be a boolean.`);
  }

  const lessonIds = [...new Set(raw.lesson_ids)];
  let lessonCounts: Record<string, number> | undefined;
  if (raw.lesson_counts !== undefined && raw.lesson_counts !== null) {
    if (!isRecord(raw.lesson_counts)) {
      throw new PackLoadError('manifest', `${label} (${raw.id}): lesson_counts must be an object.`);
    }
    const counts: Record<string, number> = {};
    for (const [lesson, count] of Object.entries(raw.lesson_counts)) {
      if (!isSlug(lesson)) {
        throw new PackLoadError(
          'manifest',
          `${label} (${raw.id}): lesson_counts names an invalid lesson id.`,
        );
      }
      if (!isPositiveInteger(count)) {
        throw new PackLoadError(
          'manifest',
          `${label} (${raw.id}): lesson_counts "${lesson}" must be a positive integer.`,
        );
      }
      counts[lesson] = count;
    }
    if (!sameStringArray(Object.keys(counts).sort(), [...lessonIds].sort())) {
      throw new PackLoadError(
        'manifest',
        `${label} (${raw.id}): lesson_counts must cover exactly its lesson_ids.`,
      );
    }
    const counted = Object.values(counts).reduce((sum, count) => sum + count, 0);
    if (counted > raw.scenario_count) {
      throw new PackLoadError(
        'manifest',
        `${label} (${raw.id}): lesson_counts total ${counted}, above its ${raw.scenario_count} scenario(s).`,
      );
    }
    lessonCounts = counts;
  }

  const entry: PackManifestEntry = {
    id: raw.id,
    path: raw.path,
    sha256: raw.sha256.toLowerCase(),
    bytes: raw.bytes,
    scenario_count: raw.scenario_count,
    lesson_ids: lessonIds,
    book_sections: [...new Set(raw.book_sections)],
    licence: raw.licence,
    requires_model: raw.requires_model,
    data_commercial_use: raw.data_commercial_use,
  };
  if (lessonCounts) entry.lesson_counts = lessonCounts;
  return entry;
}

/* -------------------------------------------------------------------------- */
/* Pack body                                                                  */
/* -------------------------------------------------------------------------- */

/** Storage the loader uses for verified bodies; the default is IndexedDB. */
export interface PackCache {
  read(key: string): Promise<ArrayBuffer | null>;
  write(key: string, bytes: ArrayBuffer): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface LoadPackOptions {
  /** Fetch to use; defaults to the global one (tests inject a stub). */
  fetchImpl?: typeof fetch;
  /** Cache to use; defaults to the IndexedDB store. */
  cache?: PackCache;
  /** Optional mirror base for the body; defaults to `VITE_PACK_MIRROR_URL`. */
  mirrorBase?: string | null;
}

/**
 * Load, verify, decode and cache one pack body.
 *
 * Order: cache (re-verified against the manifest) → same-origin → optional
 * mirror. A downloaded body is rejected before parsing unless its byte count
 * and SHA-256 match the manifest exactly.
 */
export async function loadPack(
  entry: PackManifestEntry,
  options: LoadPackOptions = {},
): Promise<LoadedPack> {
  const cache = options.cache ?? indexedDbPackCache;
  const key = packCacheKey(entry);

  const cached = await safeCacheRead(cache, key);
  if (cached) {
    const bytes = new Uint8Array(cached);
    try {
      await verifyPackBytes(bytes, entry);
      return await decodePack(bytes, entry, true);
    } catch {
      // A cached body that no longer matches or decodes is dropped and
      // re-fetched; a corrupt cache must never fail a deal.
      await safeCacheRemove(cache, key);
    }
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const errors: string[] = [];
  for (const url of packBodyUrls(entry, options.mirrorBase)) {
    try {
      const bytes = await downloadPack(fetchImpl, url);
      await verifyPackBytes(bytes, entry);
      const loaded = await decodePack(bytes, entry, false);
      await safeCacheWrite(cache, key, toArrayBuffer(bytes));
      return loaded;
    } catch (err) {
      errors.push(`${url}: ${errorMessage(err)}`);
    }
  }

  throw new PackLoadError(
    'fetch',
    `Could not load replay pack "${entry.id}". Tried:\n${errors.join('\n')}`,
  );
}

/** Validate the body's byte count and SHA-256 against the manifest entry. */
export async function verifyPackBytes(
  bytes: Uint8Array,
  entry: PackManifestEntry,
): Promise<void> {
  if (bytes.byteLength !== entry.bytes) {
    throw new PackLoadError(
      'integrity',
      `Replay pack "${entry.id}" is ${bytes.byteLength} bytes; the manifest says ${entry.bytes}.`,
    );
  }
  const digest = await sha256Hex(bytes);
  if (digest !== entry.sha256.toLowerCase()) {
    throw new PackLoadError(
      'integrity',
      `Replay pack "${entry.id}" hashes to ${digest}; the manifest says ${entry.sha256}.`,
    );
  }
}

/**
 * Parse and validate one gzip body. The manifest is the authority for the
 * lesson/count/licence metadata; a body that disagrees is rejected rather than
 * silently trusted.
 */
export async function parsePackBody(
  bytes: Uint8Array,
  entry: PackManifestEntry,
): Promise<ScenarioPack> {
  const text = decodeUtf8(await gunzip(bytes, entry.id));
  const value = parseJson(
    text,
    `Replay pack "${entry.id}" did not contain valid JSON after decompression.`,
  );

  if (!isRecord(value)) {
    throw new PackLoadError('schema', `Replay pack "${entry.id}" is not a JSON object.`);
  }
  if (value.schema !== PACK_SCHEMA) {
    throw new PackLoadError(
      'schema',
      `Replay pack "${entry.id}" has schema "${String(value.schema)}" (expected ${PACK_SCHEMA}).`,
    );
  }
  if (value.version !== PACK_SCHEMA_VERSION) {
    throw new PackLoadError(
      'schema',
      `Replay pack "${entry.id}" has version ${String(value.version)} (expected ${PACK_SCHEMA_VERSION}).`,
    );
  }
  if (value.pack_id !== entry.id) {
    throw new PackLoadError(
      'schema',
      `Replay pack body is "${String(value.pack_id)}", but the manifest lists "${entry.id}".`,
    );
  }
  if (!isRecord(value.source)) {
    throw new PackLoadError('schema', `Replay pack "${entry.id}" has no source record.`);
  }
  const source = value.source;

  // Fail closed on the source/licence gate the publisher enforces.
  if (source.kind !== 'ai_selfplay') {
    throw new PackLoadError(
      'schema',
      `Replay pack "${entry.id}" has source kind "${String(source.kind)}" (only ai_selfplay is accepted).`,
    );
  }
  if (source.redistributable !== true) {
    throw new PackLoadError('schema', `Replay pack "${entry.id}" is not marked redistributable.`);
  }
  if (typeof source.attribution !== 'string' || source.attribution.trim() === '') {
    throw new PackLoadError('schema', `Replay pack "${entry.id}" carries no attribution.`);
  }
  if (!Array.isArray(source.agents) || source.agents.length === 0) {
    throw new PackLoadError('schema', `Replay pack "${entry.id}" names no contributing agent.`);
  }
  if (!source.agents.every((agent) => isRecord(agent) && isRecord(agent.licence) && typeof agent.licence.id === 'string' && agent.licence.id !== '')) {
    throw new PackLoadError('schema', `Replay pack "${entry.id}" has an agent with no licence.`);
  }
  if (source.licence !== entry.licence) {
    throw new PackLoadError(
      'schema',
      `Replay pack "${entry.id}" licence "${String(source.licence)}" disagrees with the manifest.`,
    );
  }
  if (typeof source.data_commercial_use !== 'boolean' || source.data_commercial_use !== entry.data_commercial_use) {
    throw new PackLoadError(
      'schema',
      `Replay pack "${entry.id}" data_commercial_use disagrees with the manifest.`,
    );
  }
  if (!Array.isArray(value.scenarios)) {
    throw new PackLoadError('schema', `Replay pack "${entry.id}" has no scenarios array.`);
  }

  const scenarios = value.scenarios.map((raw, index) =>
    parseScenario(raw, entry, index),
  );
  if (scenarios.length !== entry.scenario_count) {
    throw new PackLoadError(
      'schema',
      `Replay pack "${entry.id}" has ${scenarios.length} scenarios; the manifest says ${entry.scenario_count}.`,
    );
  }
  if (new Set(scenarios.map((scenario) => scenario.id)).size !== scenarios.length) {
    throw new PackLoadError('schema', `Replay pack "${entry.id}" repeats a scenario id.`);
  }

  const lessonIds = [...new Set(scenarios.map((scenario) => scenario.lesson_id))].sort();
  if (!sameStringArray(lessonIds, [...entry.lesson_ids].sort())) {
    throw new PackLoadError(
      'schema',
      `Replay pack "${entry.id}" lesson_ids disagree with the manifest.`,
    );
  }
  // The manifest is the authority for coverage, and the same check the Rust
  // audit runs: a recorded per-lesson count must match the body's reviewed
  // bases. A manifest without counts stays acceptable (older deployments).
  if (entry.lesson_counts) {
    const bodyCounts = reviewedBasesByLesson(scenarios);
    if (!sameLessonCounts(bodyCounts, entry.lesson_counts)) {
      throw new PackLoadError(
        'schema',
        `Replay pack "${entry.id}" lesson_counts disagree with the body.`,
      );
    }
  }
  const bookSections = [
    ...new Set(
      scenarios
        .map((scenario) => scenario.book?.key)
        .filter((key): key is string => typeof key === 'string'),
    ),
  ].sort();
  if (!sameStringArray(bookSections, [...entry.book_sections].sort())) {
    throw new PackLoadError(
      'schema',
      `Replay pack "${entry.id}" book_sections disagree with the manifest.`,
    );
  }
  const requiresModel = scenarios.some((scenario) => scenario.mortal == null);
  if (requiresModel !== entry.requires_model) {
    throw new PackLoadError(
      'schema',
      `Replay pack "${entry.id}" requires_model disagrees with the manifest.`,
    );
  }

  return {
    schema: PACK_SCHEMA,
    version: PACK_SCHEMA_VERSION,
    pack_id: entry.id,
    generated_at: typeof value.generated_at === 'string' ? value.generated_at : undefined,
    source: source as PackSource,
    scenarios,
  };
}

function parseScenario(
  raw: unknown,
  entry: PackManifestEntry,
  index: number,
): PackScenario {
  const label = `Replay pack "${entry.id}" scenario ${index + 1}`;
  if (!isRecord(raw)) {
    throw new PackLoadError('schema', `${label} is not an object.`);
  }
  if (!isSlug(raw.id)) {
    throw new PackLoadError('schema', `${label}: id is not a safe scenario id.`);
  }
  if (typeof raw.lesson_id !== 'string' || raw.lesson_id.trim() === '') {
    throw new PackLoadError('schema', `${label}: lesson_id is missing.`);
  }
  if (!entry.lesson_ids.includes(raw.lesson_id)) {
    throw new PackLoadError('schema', `${label}: lesson "${raw.lesson_id}" is not in the manifest entry.`);
  }
  if (typeof raw.title !== 'string' || typeof raw.prompt !== 'string') {
    throw new PackLoadError('schema', `${label}: title/prompt are missing.`);
  }
  if (!isCorrectAction(raw.correct_action)) {
    throw new PackLoadError('schema', `${label}: correct_action is not a valid answer shape.`);
  }
  assertRenderableState(raw.state, label);

  let book: PackScenarioBook | null | undefined;
  if (raw.book !== undefined && raw.book !== null) {
    const candidate = raw.book;
    if (
      !isRecord(candidate) ||
      typeof candidate.chapter !== 'number' ||
      typeof candidate.section !== 'number' ||
      typeof candidate.key !== 'string' ||
      typeof candidate.label !== 'string'
    ) {
      throw new PackLoadError('schema', `${label}: book section is malformed.`);
    }
    book = {
      chapter: candidate.chapter,
      section: candidate.section,
      key: candidate.key,
      label: candidate.label,
    };
  } else {
    book = null;
  }

  const scenario: PackScenario = {
    ...raw,
    id: raw.id,
    lesson_id: raw.lesson_id,
    title: raw.title,
    prompt: raw.prompt,
    state: raw.state,
    correct_action: raw.correct_action,
    book,
  };
  if (Array.isArray(raw.accepted)) scenario.accepted = raw.accepted as string[];
  return scenario;
}

/**
 * The minimum contract `useGameStore.loadFromJson` needs to draw a table. The
 * engine and the pack audit own the rules; this only prevents a malformed body
 * from reaching the renderer.
 */
function assertRenderableState(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new PackLoadError('schema', `${label}: state is not an object.`);
  }
  if (!Array.isArray(value.players) || value.players.length !== 4) {
    throw new PackLoadError('schema', `${label}: state does not have four players.`);
  }
  if (!value.players.some((player) => isRecord(player) && player.is_human === true)) {
    throw new PackLoadError('schema', `${label}: state has no human player.`);
  }
  if (!Array.isArray(value.tiles)) {
    throw new PackLoadError('schema', `${label}: state has no tile list.`);
  }
  if (typeof value.category !== 'string') {
    throw new PackLoadError('schema', `${label}: state has no lesson category.`);
  }
  if (!isCorrectAction(value.correct_action)) {
    throw new PackLoadError('schema', `${label}: state has no valid correct action.`);
  }
}

/* -------------------------------------------------------------------------- */
/* Lesson lookup                                                              */
/* -------------------------------------------------------------------------- */

/** Group a decoded body's scenarios by lesson id, preserving body order. */
export function groupScenariosByLesson(pack: ScenarioPack): Map<string, PackScenario[]> {
  const byLesson = new Map<string, PackScenario[]>();
  for (const scenario of pack.scenarios) {
    const list = byLesson.get(scenario.lesson_id);
    if (list) {
      list.push(scenario);
    } else {
      byLesson.set(scenario.lesson_id, [scenario]);
    }
  }
  return byLesson;
}

/**
 * Pick one scenario for a lesson. A random draw across the pack's scenarios of
 * that lesson keeps repeated deals from always showing the same hand.
 */
export function pickPackScenario(
  loaded: LoadedPack,
  lessonId: string,
  random: () => number = Math.random,
): PackScenario {
  const candidates = loaded.byLesson.get(lessonId) ?? [];
  if (candidates.length === 0) {
    throw new PackLoadError(
      'schema',
      `Replay pack "${loaded.entry.id}" has no scenario for lesson "${lessonId}".`,
    );
  }
  const index = Math.min(
    candidates.length - 1,
    Math.max(0, Math.floor(random() * candidates.length)),
  );
  return candidates[index];
}

/**
 * Pick one scenario for a lesson, skipping ids the session has already seen.
 *
 * `seen` is the caller's session set for this pack + lesson. When every
 * scenario in the lesson has been seen, the helper starts a new cycle for that
 * lesson and returns `reset: true`. The set is updated with the returned id.
 */
export function pickUnseenPackScenario(
  loaded: LoadedPack,
  lessonId: string,
  seen: Set<string>,
  random: () => number = Math.random,
): { scenario: PackScenario; reset: boolean } {
  const candidates = loaded.byLesson.get(lessonId) ?? [];
  if (candidates.length === 0) {
    throw new PackLoadError(
      'schema',
      `Replay pack "${loaded.entry.id}" has no scenario for lesson "${lessonId}".`,
    );
  }
  const picked = pickUnseen(candidates, (scenario) => scenario.id, seen, random);
  return { scenario: picked.value, reset: picked.reset };
}

/* -------------------------------------------------------------------------- */
/* Hashing                                                                    */
/* -------------------------------------------------------------------------- */

/** Lowercase hex SHA-256 of the exact body bytes. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    try {
      const digest = await subtle.digest('SHA-256', bytes as unknown as BufferSource);
      return toHex(new Uint8Array(digest));
    } catch {
      // Non-secure context or an unimplemented SubtleCrypto: fall through.
    }
  }
  return sha256FallbackHex(bytes);
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * Pure-JS SHA-256, used where `crypto.subtle` is unavailable (a non-secure
 * context, or a test DOM without WebCrypto). Exported so the two paths can be
 * pinned against the same known-answer vectors.
 */
export function sha256FallbackHex(bytes: Uint8Array): string {
  const bitLength = bytes.length * 8;
  // Message + 0x80 + 64-bit length, rounded up to a 64-byte block. For an empty
  // input this is one block; a 56-byte input already needs two.
  const paddedLength = (((bytes.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4);
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];

    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i += 1) {
    outView.setUint32(i * 4, h[i]);
  }
  return toHex(out);
}

function rotr(value: number, shift: number): number {
  return ((value >>> shift) | (value << (32 - shift))) >>> 0;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* IndexedDB cache                                                            */
/* -------------------------------------------------------------------------- */

const DB_NAME = 'riichiprac-packs';
const DB_VERSION = 1;
const STORE_NAME = 'packs';

const indexedDbPackCache: PackCache = {
  read: readCachedPack,
  write: writeCachedPack,
  remove: removeCachedPack,
};

async function safeCacheRead(cache: PackCache, key: string): Promise<ArrayBuffer | null> {
  try {
    return await cache.read(key);
  } catch {
    return null;
  }
}

async function safeCacheWrite(cache: PackCache, key: string, bytes: ArrayBuffer): Promise<void> {
  try {
    await cache.write(key, bytes);
  } catch {
    // The download still succeeded; a full/disabled cache must never fail a deal.
  }
}

async function safeCacheRemove(cache: PackCache, key: string): Promise<void> {
  try {
    await cache.remove(key);
  } catch {
    // Ignored for the same reason a failed write is.
  }
}

function getIndexedDb(): IDBFactory | null {
  try {
    return typeof indexedDB === 'undefined' ? null : indexedDB;
  } catch {
    // Some browsers throw on access in private mode.
    return null;
  }
}

/** Open the pack cache, resolving to null when IndexedDB is unavailable. */
function openDatabase(): Promise<IDBDatabase | null> {
  const factory = getIndexedDb();
  if (!factory) return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (db: IDBDatabase | null) => {
      if (settled) return;
      settled = true;
      resolve(db);
    };

    let request: IDBOpenDBRequest;
    try {
      request = factory.open(DB_NAME, DB_VERSION);
    } catch {
      finish(null);
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      try {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      } catch {
        // A concurrent open may have created it already.
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      finish(db);
    };
    request.onerror = () => finish(null);
    request.onblocked = () => finish(null);
  });
}

async function readCachedPack(key: string): Promise<ArrayBuffer | null> {
  const db = await openDatabase();
  if (!db) return null;

  try {
    const value = await new Promise<unknown>((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const request = tx.objectStore(STORE_NAME).get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(undefined);
        tx.onabort = () => resolve(undefined);
      } catch {
        resolve(undefined);
      }
    });

    if (value instanceof ArrayBuffer) return value;
    if (value instanceof Uint8Array) return toArrayBuffer(value);
    return null;
  } finally {
    db.close();
  }
}

async function writeCachedPack(key: string, bytes: ArrayBuffer): Promise<void> {
  const db = await openDatabase();
  if (!db) return;

  try {
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(bytes, key);
        tx.oncomplete = () => resolve();
        // Quota exceeded and friends: the load still succeeded, so ignore.
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
  } finally {
    db.close();
  }
}

async function removeCachedPack(key: string): Promise<void> {
  const db = await openDatabase();
  if (!db) return;

  try {
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
  } finally {
    db.close();
  }
}

/* -------------------------------------------------------------------------- */
/* Fetch / decode helpers                                                     */
/* -------------------------------------------------------------------------- */

async function downloadPack(fetchImpl: typeof fetch, url: string): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (err) {
    throw new PackLoadError('fetch', `network error: ${errorMessage(err)}`);
  }
  if (!response.ok) {
    throw new PackLoadError('fetch', `HTTP ${response.status}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (looksLikeHtml(response, bytes)) {
    throw new PackLoadError('fetch', 'served an HTML page instead of a pack');
  }
  if (bytes.byteLength === 0) {
    throw new PackLoadError('fetch', 'served an empty response');
  }
  return bytes;
}

function looksLikeHtml(response: Response, bytes: Uint8Array): boolean {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.toLowerCase().includes('text/html')) return true;
  // A Pages/CDN 404 can be HTML with a 200. Ignore leading whitespace.
  let index = 0;
  while (index < bytes.length && (bytes[index] === 0x20 || bytes[index] === 0x09 || bytes[index] === 0x0a || bytes[index] === 0x0d)) {
    index += 1;
  }
  return bytes[index] === 0x3c; /* '<' */
}

async function decodePack(
  bytes: Uint8Array,
  entry: PackManifestEntry,
  fromCache: boolean,
): Promise<LoadedPack> {
  const pack = await parsePackBody(bytes, entry);
  return {
    entry,
    pack,
    byLesson: groupScenariosByLesson(pack),
    fromCache,
  };
}

async function gunzip(bytes: Uint8Array, packId: string): Promise<Uint8Array> {
  if (bytes.length < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    throw new PackLoadError('gzip', `Replay pack "${packId}" is not a gzip document.`);
  }
  if (typeof DecompressionStream === 'undefined') {
    throw new PackLoadError('gzip', 'This browser cannot decompress replay packs.');
  }
  try {
    const body = new Response(bytes).body;
    if (!body) {
      throw new PackLoadError('gzip', `Replay pack "${packId}" had no readable body.`);
    }
    const stream = body.pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (err) {
    throw err instanceof PackLoadError
      ? err
      : new PackLoadError(
          'gzip',
          `Replay pack "${packId}" could not be decompressed: ${errorMessage(err)}`,
        );
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function parseJson(text: string, message: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new PackLoadError('schema', message);
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value);
}

function isSlug(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 96 &&
    value !== '.' &&
    value !== '..' &&
    /^[A-Za-z0-9._-]+$/.test(value)
  );
}

function isSafePackPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false;
  if (!value.endsWith('.json.gz')) return false;
  if (value.includes('\\')) return false;
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  const parts = value.split('/');
  return parts.every((part) => part !== '' && part !== '.' && part !== '..');
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Reviewed bases per lesson, the same definition the Rust `Pack::lesson_counts`
 * and the hosting check use: a variant is derived from one base and adds no
 * review coverage, so only non-variant scenarios count.
 */
export function reviewedBasesByLesson(
  scenarios: PackScenario[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const scenario of scenarios) {
    if (isVariantScenario(scenario)) continue;
    counts[scenario.lesson_id] = (counts[scenario.lesson_id] ?? 0) + 1;
  }
  return counts;
}

function isVariantScenario(scenario: PackScenario): boolean {
  const provenance = scenario.provenance;
  if (!isRecord(provenance)) return false;
  if (provenance.variant_of !== undefined && provenance.variant_of !== null) return true;
  return Array.isArray(provenance.transforms) && provenance.transforms.length > 0;
}

function sameLessonCounts(
  left: Record<string, number>,
  right: Record<string, number>,
): boolean {
  const keys = Object.keys(left).sort();
  if (!sameStringArray(keys, Object.keys(right).sort())) return false;
  return keys.every((key) => left[key] === right[key]);
}
