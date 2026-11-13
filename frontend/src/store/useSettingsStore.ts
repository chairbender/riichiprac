import { create } from 'zustand';

/**
 * How the main area draws the table.
 *
 * `stacked` is the mobile-first four-row layout and the default, so a browser
 * that has never saved a setting sees exactly what it saw before. `topdown` is
 * the flat plan view (`PhysicalTable`), with the human anchored at the bottom
 * edge. `isometric` is the angled table view (`IsometricTable`), which is still
 * being built part by part and currently shows the empty table plane.
 */
export type TableView = 'stacked' | 'topdown' | 'isometric';

/** The view a browser with no stored choice gets. */
export const DEFAULT_TABLE_VIEW: TableView = 'stacked';

/** `localStorage` key holding every persisted frontend setting. */
export const SETTINGS_STORAGE_KEY = 'riichiprac.settings';

/** What lives under {@link SETTINGS_STORAGE_KEY}; one key per setting. */
export interface PersistedSettings {
  version: typeof SETTINGS_VERSION;
  view: TableView;
}

/**
 * Bump when a stored key changes meaning. Unknown versions are still read key
 * by key; the field exists so a future migration can recognise old blobs.
 */
const SETTINGS_VERSION = 1;

/** The settings the UI reads, with no store actions attached. */
export interface FrontendSettings {
  view: TableView;
}

/** Narrow an arbitrary value (select value, stored blob) to a {@link TableView}. */
export function isTableView(value: unknown): value is TableView {
  return value === 'stacked' || value === 'topdown' || value === 'isometric';
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
  return { view: DEFAULT_TABLE_VIEW };
}

/**
 * Read a stored settings blob, falling back per key.
 *
 * A missing, malformed, or partially unknown blob never breaks the app: every
 * key it cannot validate keeps its default, so an old or corrupt entry can only
 * cost the setting it belongs to.
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
  if (isTableView(stored.view)) {
    settings.view = stored.view;
  }
  return settings;
}

/** Read the persisted settings from `localStorage`, defaulting where absent. */
export function readSettings(): FrontendSettings {
  const storage = getStorage();
  if (!storage) return defaultSettings();

  try {
    return parseSettings(storage.getItem(SETTINGS_STORAGE_KEY));
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
    view: settings.view,
  };
  try {
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Storage full or blocked: keep the session value and move on.
  }
}

interface SettingsStore extends FrontendSettings {
  /** Choose how the main area draws the table, and persist it. */
  setView: (view: TableView) => void;
}

/**
 * Persisted frontend settings, shared by the header control and the table
 * mount point. The store is seeded from `localStorage` when the module loads,
 * so a reload keeps the player's choice; every setter writes the whole blob
 * back under one key.
 */
export const useSettingsStore = create<SettingsStore>((set) => ({
  ...readSettings(),

  setView: (view) =>
    set((state) => {
      if (state.view === view) return state;
      writeSettings({ view });
      return { view };
    }),
}));
