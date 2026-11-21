import { create } from 'zustand';

/**
 * How the main area draws the table.
 *
 * `rendered3d` is the real-time 3D table and the **default**: every browser
 * opens on it (user request 2026-11-20, superseding decision D13's "opt-in,
 * never default"). `stacked` is the mobile-first four-row layout and `topdown`
 * is the flat plan view (`PhysicalTable`, human at the bottom edge); both are
 * options in the View control, and the player's pick is remembered.
 *
 * The 3D value persists like any other view and `App` mounts it from the same
 * slot. A browser that cannot run it (no WebGL2, or the session closed it after
 * a degrade) falls back to {@link FALLBACK_TABLE_VIEW} **without rewriting** the
 * stored choice, so a temporarily unsupported device does not lose it.
 *
 * A stored `isometric` value is intentionally not a member any more: the
 * experimental angled view was removed, and an old blob that still names it
 * falls back to the default through {@link isTableView}.
 */
export type TableView = 'stacked' | 'topdown' | 'rendered3d';

/**
 * The view a browser that has never chosen one gets: the 3D table.
 *
 * This is the *first launch* answer, not a fallback. The 2D views are reachable
 * from the View control, and once the player picks one it is remembered under
 * {@link TABLE_VIEW_STORAGE_KEY}.
 */
export const DEFAULT_TABLE_VIEW: TableView = 'rendered3d';

/**
 * The 2D view drawn when the chosen 3D table cannot run here.
 *
 * It is never persisted: the player's choice stays in the store and in
 * `localStorage`, only the drawing falls back, so the next capable browser (or
 * the next launch after a fixed driver) opens 3D again. Stacked is the
 * accessible four-row layout.
 */
export const FALLBACK_TABLE_VIEW: Exclude<TableView, 'rendered3d'> = 'stacked';

/**
 * Whether replay packs are preferred over generated lessons where they have
 * coverage, when nothing is stored.
 *
 * Default **on**: the replay-first rollout (`replay-first-rollout.md`, RF2)
 * makes a covered lesson's default deal a real audited hand and keeps the
 * generated drill one explicit pick away. The setting only ever moves the
 * default pool — `selectionPool` still deals generated ids for lessons without
 * enough coverage, and for every lesson when this is off. With no pack manifest
 * the value changes nothing: the pool is generated-only either way.
 */
export const DEFAULT_PREFER_REPLAY = true;

/**
 * `localStorage` key holding the replay-source preference (the legacy settings
 * blob).
 *
 * It also used to hold `view`. That field is **ignored** now: a view stored
 * while 3D was opt-in could only have been a 2D pick, and the 2026-11-20
 * decision is that everyone sees 3D first. The blob keeps its shape (`version`
 * plus the setting) so an older build reading it still finds something sane.
 */
export const SETTINGS_STORAGE_KEY = 'riichiprac.settings';

/**
 * `localStorage` key holding the player's own table-view choice.
 *
 * Deliberately **separate** from {@link SETTINGS_STORAGE_KEY}. Because the key
 * is new, every browser starts with no choice and therefore opens the 3D table;
 * from then on the player's pick is remembered locally. This is what makes
 * "everyone sees 3D first" true without discarding the setting of anyone who
 * then chooses a 2D view.
 */
export const TABLE_VIEW_STORAGE_KEY = 'riichiprac.table-view';

/** What lives under {@link SETTINGS_STORAGE_KEY}; one key per setting. */
export interface PersistedSettings {
  version: typeof SETTINGS_VERSION;
  preferReplay: boolean;
}

/** What lives under {@link TABLE_VIEW_STORAGE_KEY}. */
export interface PersistedTableView {
  version: typeof TABLE_VIEW_VERSION;
  view: TableView;
}

/**
 * Bump when a stored key changes meaning. Unknown versions are still read key
 * by key; the field exists so a future migration can recognise old blobs.
 */
const SETTINGS_VERSION = 1;

/** The table-view blob's own version (its own key, its own lifetime). */
const TABLE_VIEW_VERSION = 1;

/** The settings the UI reads, with no store actions attached. */
export interface FrontendSettings {
  view: TableView;
  /** Deal replay hands for covered lessons instead of generated ones. */
  preferReplay: boolean;
}

/** Narrow an arbitrary value (select value, stored blob) to a {@link TableView}. */
export function isTableView(value: unknown): value is TableView {
  return value === 'stacked' || value === 'topdown' || value === 'rendered3d';
}

/**
 * `localStorage`, or null where it is unavailable. It can be absent (tests,
 * server rendering) or throw on access (storage disabled in some browsers), and
 * neither is an error: the app just runs without persistence.
 */
function getStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The default settings, used when nothing has been saved. */
function defaultSettings(): FrontendSettings {
  return { view: DEFAULT_TABLE_VIEW, preferReplay: DEFAULT_PREFER_REPLAY };
}

/**
 * Parse the table-view blob.
 *
 * A missing, malformed, unknown-version or foreign value is `null`, which the
 * store reads as "no choice yet" and answers with {@link DEFAULT_TABLE_VIEW}.
 * The version is checked so a future format cannot be mistaken for a view.
 */
export function parseStoredTableView(raw: string | null): TableView | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const stored = parsed as Record<string, unknown>;
  if (stored.version !== TABLE_VIEW_VERSION) return null;
  return isTableView(stored.view) ? stored.view : null;
}

/**
 * Read the legacy settings blob, falling back per key.
 *
 * A missing, malformed, or partially unknown blob never breaks the app: every
 * key it cannot validate keeps its default, so an old or corrupt entry can only
 * cost the setting it belongs to. A `view` field in this blob is deliberately
 * ignored — see {@link SETTINGS_STORAGE_KEY}.
 */
export function parseSettings(raw: string | null): FrontendSettings {
  const settings = defaultSettings();
  if (!raw) return settings;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return settings;
  }
  if (typeof parsed !== 'object' || parsed === null) return settings;

  const stored = parsed as Record<string, unknown>;
  if (typeof stored.preferReplay === 'boolean') {
    settings.preferReplay = stored.preferReplay;
  }
  return settings;
}

/** Read the persisted settings from `localStorage`, defaulting where absent. */
export function readSettings(): FrontendSettings {
  const storage = getStorage();
  if (!storage) return defaultSettings();

  try {
    const settings = parseSettings(storage.getItem(SETTINGS_STORAGE_KEY));
    const view = parseStoredTableView(storage.getItem(TABLE_VIEW_STORAGE_KEY));
    if (view) settings.view = view;
    return settings;
  } catch {
    return defaultSettings();
  }
}

/**
 * Persist settings. A browser that refuses storage (private mode, quota) still
 * gets the in-memory value for this session; only the reload persistence is
 * lost.
 */
export function writeSettings(settings: FrontendSettings): void {
  const storage = getStorage();
  if (!storage) return;

  const payload: PersistedSettings = {
    version: SETTINGS_VERSION,
    preferReplay: settings.preferReplay,
  };
  const viewPayload: PersistedTableView = {
    version: TABLE_VIEW_VERSION,
    view: settings.view,
  };
  try {
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(payload));
    storage.setItem(TABLE_VIEW_STORAGE_KEY, JSON.stringify(viewPayload));
  } catch {
    // Storage full or blocked: keep the session value and move on.
  }
}

interface SettingsStore extends FrontendSettings {
  /** Choose how the main area draws the table, and persist it. */
  setView: (view: TableView) => void;
  /** Choose whether covered lessons deal replay hands instead of generated ones. */
  setPreferReplay: (preferReplay: boolean) => void;
}

/**
 * Persisted frontend settings, shared by the header control and the table
 * mount point. The store is seeded from `localStorage` when the module loads,
 * so a reload keeps the player's choice; every setter writes both keys back.
 */
export const useSettingsStore = create<SettingsStore>((set) => ({
  ...readSettings(),

  setView: (view) =>
    set((state) => {
      if (state.view === view) return state;
      writeSettings({ view, preferReplay: state.preferReplay });
      return { view };
    }),

  setPreferReplay: (preferReplay) =>
    set((state) => {
      if (state.preferReplay === preferReplay) return state;
      writeSettings({ view: state.view, preferReplay });
      return { preferReplay };
    }),
}));
