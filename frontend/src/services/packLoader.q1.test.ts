import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  fetchPackManifest,
  loadPack,
  packCacheKey,
  parsePackManifest,
} from './packLoader';
import type { PackCache, PackManifestEntry } from './packLoader';

/**
 * Q1 loader smoke.
 *
 * The normal loader test reads the committed `frontend/public/scenarios` smoke
 * pack. This one reads the pack the `mine_replays qa fixture` pipeline just
 * produced (`Q1_PACK_DIR`), so CI proves the end-to-end artifact loads through
 * the same manifest → content-addressed body → hash/byte check → gzip → schema
 * path as the shipped pack. It is skipped when no pipeline artifact is given.
 */

const packDir = process.env.Q1_PACK_DIR;

function memoryCache(): PackCache {
  const store = new Map<string, ArrayBuffer>();
  return {
    async read(key) {
      return store.get(key) ?? null;
    },
    async write(key, bytes) {
      store.set(key, bytes);
    },
    async remove(key) {
      store.delete(key);
    },
  };
}

function fixture(entry: PackManifestEntry) {
  const manifestText = readFileSync(join(packDir as string, 'manifest.json'), 'utf8');
  const bytes = readFileSync(join(packDir as string, entry.path));
  return { manifestText, bytes };
}

const run =
  packDir && existsSync(join(packDir, 'manifest.json')) ? it : it.skip;

describe('Q1 pipeline pack loader smoke', () => {
  run('loads the audited pipeline pack through the runtime loader', async () => {
    const manifestText = readFileSync(join(packDir as string, 'manifest.json'), 'utf8');
    const manifest = parsePackManifest(manifestText);
    expect(manifest.packs.length).toBeGreaterThan(0);
    const entry = manifest.packs[0];
    expect(entry.path.endsWith('.json.gz')).toBe(true);
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.scenario_count).toBeGreaterThan(0);

    const { bytes } = fixture(entry);
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('manifest.json')) {
        return new Response(manifestText, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(bytes, {
        status: 200,
        headers: { 'content-type': 'application/gzip' },
      });
    });

    const fetched = await fetchPackManifest(fetchImpl);
    expect(fetched.packs.map((pack) => pack.id)).toEqual(manifest.packs.map((pack) => pack.id));

    const cache = memoryCache();
    const loaded = await loadPack(entry, { fetchImpl, cache });
    expect(loaded.fromCache).toBe(false);
    expect(loaded.pack.pack_id).toBe(entry.id);
    expect(loaded.pack.scenarios.length).toBe(entry.scenario_count);
    expect(loaded.byLesson.size).toBeGreaterThan(0);
    for (const scenario of loaded.pack.scenarios) {
      expect(scenario.state).toBeTruthy();
      expect(scenario.correct_action).toBeTruthy();
      expect(scenario.title.length).toBeGreaterThan(0);
      expect(scenario.prompt.length).toBeGreaterThan(0);
    }

    // The cache key is the content address, so a second load never downloads.
    expect(await cache.read(packCacheKey(entry))).not.toBeNull();
    const before = calls.length;
    const cached = await loadPack(entry, { fetchImpl, cache });
    expect(cached.fromCache).toBe(true);
    expect(calls.length).toBe(before);
  });
});
