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
  it('defaults to the top-down view when nothing is stored', async () => {
    setLocalStorage(memoryStorage());

    const { useSettingsStore, SETTINGS_STORAGE_KEY } =
      await loadSettingsStore();

    expect(SETTINGS_STORAGE_KEY).toBe('riichiprac.settings');
    expect(useSettingsStore.getState().view).toBe('topdown');
  });

  it('persists the isometric view under the settings key', async () => {
    const storage = memoryStorage();
    setLocalStorage(storage);

    const { useSettingsStore, SETTINGS_STORAGE_KEY } =
      await loadSettingsStore();
    useSettingsStore.getState().setView('isometric');

    expect(JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY) ?? 'null')).toEqual(
      { version: 1, view: 'isometric' },
    );

    // A reload is a fresh module import reading the same storage.
    const reloaded = await loadSettingsStore();
    expect(reloaded.useSettingsStore.getState().view).toBe('isometric');
  });

  it('persists switching back to the top-down view', async () => {
    const storage = memoryStorage();
    storage.setItem(
      'riichiprac.settings',
      JSON.stringify({ version: 1, view: 'isometric' }),
    );
    setLocalStorage(storage);

    const { useSettingsStore } = await loadSettingsStore();
    expect(useSettingsStore.getState().view).toBe('isometric');

    useSettingsStore.getState().setView('topdown');
    expect(JSON.parse(storage.getItem('riichiprac.settings') ?? 'null')).toEqual(
      { version: 1, view: 'topdown' },
    );

    const reloaded = await loadSettingsStore();
    expect(reloaded.useSettingsStore.getState().view).toBe('topdown');
  });

  it('falls back to top-down for malformed or unknown stored values', async () => {
    const storage = memoryStorage();
    setLocalStorage(storage);

    for (const raw of [
      'not json',
      'null',
      '[]',
      JSON.stringify({ version: 1, view: 'sideways' }),
      JSON.stringify({ version: 1 }),
    ]) {
      storage.setItem('riichiprac.settings', raw);
      const { useSettingsStore } = await loadSettingsStore();
      expect(useSettingsStore.getState().view).toBe('topdown');
    }
  });

  it('still switches in memory when storage is unavailable', async () => {
    setLocalStorage(null);

    const { useSettingsStore } = await loadSettingsStore();
    expect(useSettingsStore.getState().view).toBe('topdown');

    expect(() => useSettingsStore.getState().setView('isometric')).not.toThrow();
    expect(useSettingsStore.getState().view).toBe('isometric');
  });
});
