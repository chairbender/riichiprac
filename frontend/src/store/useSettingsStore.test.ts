import { afterEach, describe, expect, it, vi } from 'vitest';

/** Minimal in-memory `Storage`, enough for the settings store. */
function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => {
      items.delete(key);
    },
    setItem: (key, value) => {
      items.set(key, String(value));
    },
  };
}

/** Define (or remove) `localStorage` for the duration of one test. */
function setLocalStorage(storage: Storage | null): void {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: storage,
  });
}

/**
 * Import a fresh copy of the store. Each page load creates the module once, so
 * resetting the module registry is what a reload does here: the store must seed
 * itself from whatever is in `localStorage` at import time.
 */
async function loadSettingsStore() {
  vi.resetModules();
  return import('./useSettingsStore');
}

afterEach(() => {
  setLocalStorage(null);
  vi.resetModules();
});

describe('useSettingsStore', () => {
  it('opens the 3D table when nothing is stored (2026-11-20 decision)', async () => {
    setLocalStorage(memoryStorage());

    const {
      DEFAULT_TABLE_VIEW,
      SETTINGS_STORAGE_KEY,
      TABLE_VIEW_STORAGE_KEY,
      useSettingsStore,
    } = await loadSettingsStore();

    expect(DEFAULT_TABLE_VIEW).toBe('rendered3d');
    // The view has its own key, separate from the legacy settings blob.
    expect(SETTINGS_STORAGE_KEY).toBe('riichiprac.settings');
    expect(TABLE_VIEW_STORAGE_KEY).toBe('riichiprac.table-view');
    expect(useSettingsStore.getState().view).toBe('rendered3d');
  });

  it('persists every view under its own key and keeps it across a reload', async () => {
    const storage = memoryStorage();
    setLocalStorage(storage);

    const {
      SETTINGS_STORAGE_KEY,
      TABLE_VIEW_STORAGE_KEY,
      useSettingsStore,
    } = await loadSettingsStore();

    for (const view of ['stacked', 'topdown', 'rendered3d'] as const) {
      useSettingsStore.getState().setView(view);
      expect(
        JSON.parse(storage.getItem(TABLE_VIEW_STORAGE_KEY) ?? 'null'),
      ).toEqual({ version: 1, view });
      // The legacy blob never carries a view: it has one source of truth.
      expect(
        JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY) ?? 'null'),
      ).toEqual({ version: 1, preferReplay: true });

      const reloaded = await loadSettingsStore();
      expect(reloaded.useSettingsStore.getState().view).toBe(view);
    }
  });

  it('ignores a view stored in the old settings blob, so everyone sees 3D first', async () => {
    const storage = memoryStorage();
    setLocalStorage(storage);
    // A view a pre-3D-default build wrote: at that time 3D was opt-in, so a
    // `stacked` here says nothing about wanting 2D now.
    storage.setItem(
      'riichiprac.settings',
      JSON.stringify({ version: 1, view: 'stacked', preferReplay: false }),
    );

    const { useSettingsStore } = await loadSettingsStore();

    expect(useSettingsStore.getState().view).toBe('rendered3d');
    // The rest of that blob is still honoured.
    expect(useSettingsStore.getState().preferReplay).toBe(false);
    // And the ignored field is not resurrected on the next write.
    useSettingsStore.getState().setView('topdown');
    expect(
      JSON.parse(storage.getItem('riichiprac.settings') ?? 'null'),
    ).toEqual({ version: 1, preferReplay: false });
  });

  it('reads an explicit choice from the table-view key', async () => {
    const storage = memoryStorage();
    setLocalStorage(storage);
    storage.setItem(
      'riichiprac.table-view',
      JSON.stringify({ version: 1, view: 'stacked' }),
    );

    const { useSettingsStore } = await loadSettingsStore();
    expect(useSettingsStore.getState().view).toBe('stacked');
  });

  it('prefers replay hands for covered lessons by default', async () => {
    setLocalStorage(memoryStorage());

    const { DEFAULT_PREFER_REPLAY, useSettingsStore } =
      await loadSettingsStore();

    expect(DEFAULT_PREFER_REPLAY).toBe(true);
    expect(useSettingsStore.getState().preferReplay).toBe(true);
  });

  it('persists preferReplay and keeps it across a reload', async () => {
    const storage = memoryStorage();
    setLocalStorage(storage);

    const { SETTINGS_STORAGE_KEY, useSettingsStore } =
      await loadSettingsStore();

    useSettingsStore.getState().setPreferReplay(false);
    expect(
      JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY) ?? 'null'),
    ).toEqual({ version: 1, preferReplay: false });

    const reloaded = await loadSettingsStore();
    expect(reloaded.useSettingsStore.getState().preferReplay).toBe(false);
    // The view setting is untouched by a source-only change.
    expect(reloaded.useSettingsStore.getState().view).toBe('rendered3d');

    useSettingsStore.getState().setPreferReplay(true);
    const again = await loadSettingsStore();
    expect(again.useSettingsStore.getState().preferReplay).toBe(true);
  });

  it('keeps the default when the stored preferReplay is not a boolean', async () => {
    const storage = memoryStorage();
    setLocalStorage(storage);

    for (const raw of [
      JSON.stringify({ version: 1, preferReplay: 'yes' }),
      JSON.stringify({ version: 1, preferReplay: 1 }),
      JSON.stringify({ version: 1, preferReplay: null }),
    ]) {
      storage.setItem('riichiprac.settings', raw);
      const { useSettingsStore } = await loadSettingsStore();
      expect(useSettingsStore.getState().preferReplay).toBe(true);
      expect(useSettingsStore.getState().view).toBe('rendered3d');
    }
  });

  it('falls back to 3D for a malformed, unknown or retired table-view blob', async () => {
    const storage = memoryStorage();
    setLocalStorage(storage);

    for (const raw of [
      'not json',
      'null',
      '[]',
      JSON.stringify({ version: 1, view: 'physical' }),
      JSON.stringify({ version: 1, view: 'sideways' }),
      // The retired experimental angled view.
      JSON.stringify({ version: 1, view: 'isometric' }),
      JSON.stringify({ version: 1 }),
      // A future format is not read as a view.
      JSON.stringify({ version: 2, view: 'topdown' }),
      JSON.stringify({ view: 'topdown' }),
    ]) {
      storage.setItem('riichiprac.table-view', raw);
      const { useSettingsStore } = await loadSettingsStore();
      expect(useSettingsStore.getState().view).toBe('rendered3d');
    }
  });

  it('still switches in memory when storage is unavailable', async () => {
    setLocalStorage(null);

    const { useSettingsStore } = await loadSettingsStore();
    expect(useSettingsStore.getState().view).toBe('rendered3d');

    expect(() => useSettingsStore.getState().setView('topdown')).not.toThrow();
    expect(useSettingsStore.getState().view).toBe('topdown');
  });
});
