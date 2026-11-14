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
  it('defaults to the stacked view when nothing is stored', async () => {
    setLocalStorage(memoryStorage());

    const { useSettingsStore, SETTINGS_STORAGE_KEY } =
      await loadSettingsStore();

    expect(SETTINGS_STORAGE_KEY).toBe('riichiprac.settings');
    expect(useSettingsStore.getState().view).toBe('stacked');
  });

  it('persists every view and keeps it across a reload', async () => {
    const storage = memoryStorage();
    setLocalStorage(storage);

    const { useSettingsStore, SETTINGS_STORAGE_KEY } =
      await loadSettingsStore();

    for (const view of ['topdown', 'rendered', 'stacked'] as const) {
      useSettingsStore.getState().setView(view);
      expect(
        JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY) ?? 'null'),
      ).toEqual({ version: 1, view });

      const reloaded = await loadSettingsStore();
      expect(reloaded.useSettingsStore.getState().view).toBe(view);
    }
  });

  it('keeps the stacked layout as the default when nothing is stored', async () => {
    setLocalStorage(memoryStorage());
    const { DEFAULT_TABLE_VIEW } = await loadSettingsStore();
    expect(DEFAULT_TABLE_VIEW).toBe('stacked');
  });

  it('migrates a stored experimental isometric view to the default', async () => {
    const storage = memoryStorage();
    setLocalStorage(storage);
    storage.setItem(
      'riichiprac.settings',
      JSON.stringify({ version: 1, view: 'isometric' }),
    );

    const { DEFAULT_TABLE_VIEW, useSettingsStore } =
      await loadSettingsStore();

    expect(DEFAULT_TABLE_VIEW).toBe('stacked');
    expect(useSettingsStore.getState().view).toBe('stacked');
  });

  it('falls back to stacked for malformed or unknown stored values', async () => {
    const storage = memoryStorage();
    setLocalStorage(storage);

    for (const raw of [
      'not json',
      'null',
      '[]',
      JSON.stringify({ version: 1, view: 'physical' }),
      JSON.stringify({ version: 1, view: 'sideways' }),
      JSON.stringify({ version: 1, view: 'isometric' }),
      JSON.stringify({ version: 1 }),
    ]) {
      storage.setItem('riichiprac.settings', raw);
      const { useSettingsStore } = await loadSettingsStore();
      expect(useSettingsStore.getState().view).toBe('stacked');
    }
  });

  it('still switches in memory when storage is unavailable', async () => {
    setLocalStorage(null);

    const { useSettingsStore } = await loadSettingsStore();
    expect(useSettingsStore.getState().view).toBe('stacked');

    expect(() => useSettingsStore.getState().setView('topdown')).not.toThrow();
    expect(useSettingsStore.getState().view).toBe('topdown');
  });
});
