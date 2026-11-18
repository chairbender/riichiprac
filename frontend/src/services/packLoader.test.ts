import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_MANIFEST_BYTES,
  PACK_MANIFEST_SCHEMA,
  PACK_SCHEMA,
  PACK_SCHEMA_VERSION,
  PackLoadError,
  fetchPackManifest,
  groupScenariosByLesson,
  loadPack,
  packBodyUrls,
  packCacheKey,
  packManifestUrl,
  parsePackBody,
  parsePackManifest,
  pickPackScenario,
  sha256FallbackHex,
  sha256Hex,
} from './packLoader';
import type {
  PackCache,
  PackManifest,
  PackManifestEntry,
  PackScenario,
} from './packLoader';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const HASH = 'a'.repeat(64);

function state(category = 'fold_to_riichi'): Record<string, unknown> & {
  players: Array<Record<string, unknown>>;
} {
  return {
    category,
    correct_action: { type: 'dama', discard: '7m' },
    tiles: ['1m', '2m'],
    players: [
      { seat: 0, is_human: true },
      { seat: 1, is_human: false },
      { seat: 2, is_human: false },
      { seat: 3, is_human: false },
    ],
  };
}

function scenario(
  lessonId = 'fold_to_riichi',
  id = `fixture-${lessonId}`,
  extra: Record<string, unknown> = {},
): PackScenario {
  return {
    id,
    lesson_id: lessonId,
    book: {
      chapter: 8,
      section: 1,
      key: 'ch8.1',
      label: 'ch8.1 · To push or to fold?',
    },
    title: 'Fixture hand',
    prompt: 'Choose the correct action.',
    state: state(lessonId),
    correct_action: { type: 'dama', discard: '7m' },
    accepted: ['7m'],
    ...extra,
  };
}

function packJson(
  scenarios: PackScenario[],
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    schema: PACK_SCHEMA,
    version: PACK_SCHEMA_VERSION,
    pack_id: 'replay.fixture.2026-11',
    generated_at: '2026-11-17T00:00:00Z',
    source: {
      kind: 'ai_selfplay',
      corpus_id: 'fixture-corpus',
      licence: 'CC-BY-4.0',
      attribution: 'Fixture pack',
      redistributable: true,
      data_commercial_use: true,
      agents: [
        {
          agent_id: 'mortal-298k',
          kind: 'neural',
          engine: 'libriichi',
          engine_version: '1',
          licence: { id: 'AGPL-3.0', attribution: 'Mortal 298k' },
        },
      ],
    },
    scenarios,
    ...overrides,
  });
}

function entryFor(
  bytes: Uint8Array,
  overrides: Partial<PackManifestEntry> = {},
): PackManifestEntry {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return {
    id: 'replay.fixture.2026-11',
    path: `replay.fixture.2026-11-${sha256.slice(0, 12)}.json.gz`,
    sha256,
    bytes: bytes.byteLength,
    scenario_count: 1,
    lesson_ids: ['fold_to_riichi'],
    book_sections: ['ch8.1'],
    licence: 'CC-BY-4.0',
    requires_model: true,
    data_commercial_use: true,
    ...overrides,
  };
}

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function bodyResponse(
  bytes: Uint8Array,
  init: { status?: number; contentType?: string } = {},
): Response {
  return new Response(bytes, {
    status: init.status ?? 200,
    headers: { 'content-type': init.contentType ?? 'application/gzip' },
  });
}

function memoryCache(): {
  cache: PackCache;
  entries: Map<string, ArrayBuffer>;
  calls: { read: number; write: number; remove: number };
} {
  const entries = new Map<string, ArrayBuffer>();
  const calls = { read: 0, write: 0, remove: 0 };
  return {
    entries,
    calls,
    cache: {
      async read(key) {
        calls.read += 1;
        const value = entries.get(key);
        return value ? value.slice(0) : null;
      },
      async write(key, bytes) {
        calls.write += 1;
        entries.set(key, bytes.slice(0));
      },
      async remove(key) {
        calls.remove += 1;
        entries.delete(key);
      },
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The committed pack                                                   */
/* -------------------------------------------------------------------------- */

const fixtureDir = new URL('../../public/scenarios/', import.meta.url);
const fixtureManifestText = readFileSync(
  new URL('manifest.json', fixtureDir),
  'utf8',
);
const fixtureManifest = parsePackManifest(fixtureManifestText);
const fixtureEntry = fixtureManifest.packs[0];
const fixtureBody = new Uint8Array(
  readFileSync(new URL(fixtureEntry.path, fixtureDir)),
);

describe('committed pack', () => {
  it('validates the published manifest and carries the content address', async () => {
    expect(packManifestUrl()).toBe('/scenarios/manifest.json');
    expect(fixtureManifest.packs).toHaveLength(1);
    expect(fixtureEntry.path).toBe(
      `${fixtureEntry.id}-${fixtureEntry.sha256.slice(0, 12)}.json.gz`,
    );
    await expect(sha256Hex(fixtureBody)).resolves.toBe(fixtureEntry.sha256);
    expect(fixtureBody.byteLength).toBe(fixtureEntry.bytes);
  });

  it('loads, verifies and decodes the real body, then serves it from cache', async () => {
    const memory = memoryCache();
    const fetched: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      return bodyResponse(fixtureBody);
    });

    const loaded = await loadPack(fixtureEntry, {
      cache: memory.cache,
      fetchImpl,
    });

    expect(fetched).toEqual([`/scenarios/${fixtureEntry.path}`]);
    expect(loaded.fromCache).toBe(false);
    expect(loaded.pack.schema).toBe(PACK_SCHEMA);
    expect(loaded.pack.pack_id).toBe(fixtureEntry.id);
    expect(loaded.pack.scenarios).toHaveLength(fixtureEntry.scenario_count);
    expect([...loaded.byLesson.keys()].sort()).toEqual(
      [...fixtureEntry.lesson_ids].sort(),
    );
    expect(memory.calls.write).toBe(1);

    // Reload with the network disabled: the verified cache entry is enough.
    const offline = vi.fn(async () => {
      throw new Error('network disabled');
    });
    const again = await loadPack(fixtureEntry, {
      cache: memory.cache,
      fetchImpl: offline,
    });

    expect(offline).not.toHaveBeenCalled();
    expect(again.fromCache).toBe(true);
    expect(again.pack.scenarios).toHaveLength(fixtureEntry.scenario_count);
    for (const lesson of fixtureEntry.lesson_ids) {
      expect(again.byLesson.get(lesson)?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Manifest schema                                                            */
/* -------------------------------------------------------------------------- */

function manifestText(packs: unknown[]): string {
  return JSON.stringify({
    schema: PACK_MANIFEST_SCHEMA,
    version: PACK_SCHEMA_VERSION,
    updated_at: '2026-11-17T00:00:00Z',
    packs,
  });
}

function okEntry(overrides: Record<string, unknown> = {}): PackManifestEntry {
  return {
    id: 'replay.fixture.2026-11',
    path: 'replay.fixture.2026-11-aaaaaaaaaaaa.json.gz',
    sha256: HASH,
    bytes: 100,
    scenario_count: 1,
    lesson_ids: ['fold_to_riichi'],
    book_sections: ['ch8.1'],
    licence: 'CC-BY-4.0',
    requires_model: true,
    data_commercial_use: true,
    ...overrides,
  } as PackManifestEntry;
}

describe('parsePackManifest', () => {
  it('accepts an empty pack list as a valid empty state', () => {
    const manifest = parsePackManifest(manifestText([]));
    expect(manifest.packs).toEqual([]);
  });

  it('ignores unknown fields and normalises the hash case', () => {
    const manifest = parsePackManifest(
      manifestText([{ ...okEntry(), sha256: HASH.toUpperCase(), future: true }]),
    );
    expect(manifest.packs[0].sha256).toBe(HASH);
  });

  it.each([
    ['wrong schema', manifestText([]).replace(PACK_MANIFEST_SCHEMA, 'other')],
    ['wrong version', manifestText([]).replace('"version":1', '"version":2')],
    ['not an object', '[]'],
    ['invalid JSON', '{'],
  ])('rejects %s', (_label, text) => {
    expect(() => parsePackManifest(text)).toThrow(PackLoadError);
  });

  it.each([
    ['a traversal path', { path: '../secret.json.gz' }],
    ['an absolute path', { path: '/scenarios/x.json.gz' }],
    ['a non-gzip path', { path: 'pack.json' }],
    ['an empty part', { path: 'a//b.json.gz' }],
    ['a short hash', { sha256: 'abc' }],
    ['zero bytes', { bytes: 0 }],
    ['a fractional byte count', { bytes: 1.5 }],
    ['zero scenarios', { scenario_count: 0 }],
    ['no lessons', { lesson_ids: [] }],
    ['a non-string lesson', { lesson_ids: [1] }],
    ['a missing licence', { licence: '' }],
    ['a non-boolean requires_model', { requires_model: 'yes' }],
    ['a non-boolean data_commercial_use', { data_commercial_use: 1 }],
    ['an unsafe id', { id: '../pack' }],
  ])('rejects %s', (_label, overrides) => {
    expect(() => parsePackManifest(manifestText([okEntry(overrides)]))).toThrow(
      PackLoadError,
    );
  });

  it('rejects a duplicate pack id', () => {
    expect(() =>
      parsePackManifest(manifestText([okEntry(), okEntry()])),
    ).toThrow(/lists "replay\.fixture\.2026-11" twice/);
  });
});

describe('fetchPackManifest', () => {
  it('reads the same-origin manifest', async () => {
    const fetchImpl = vi.fn(async () => bodyResponse(new TextEncoder().encode(manifestText([okEntry()])), { contentType: 'application/json' }));
    const manifest = await fetchPackManifest(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith('/scenarios/manifest.json');
    expect(manifest.packs).toHaveLength(1);
  });

  it('fails closed on an HTTP error', async () => {
    const fetchImpl = async () => bodyResponse(new Uint8Array(), { status: 404 });
    await expect(fetchPackManifest(fetchImpl)).rejects.toThrow(/HTTP 404/);
  });

  it('rejects an HTML fallback served with a 200', async () => {
    const fetchImpl = async () =>
      bodyResponse(new TextEncoder().encode('<!doctype html><title>404</title>'), {
        contentType: 'text/html',
      });
    await expect(fetchPackManifest(fetchImpl)).rejects.toThrow(/HTML page/);
  });

  it('rejects a manifest above its byte ceiling', async () => {
    const big = new Uint8Array(MAX_MANIFEST_BYTES + 1).fill(0x20);
    const fetchImpl = async () => bodyResponse(big, { contentType: 'application/json' });
    await expect(fetchPackManifest(fetchImpl)).rejects.toThrow(/ceiling/);
  });

  it('reports a network failure with the URL', async () => {
    const fetchImpl = async () => {
      throw new Error('offline');
    };
    await expect(fetchPackManifest(fetchImpl)).rejects.toThrow(/offline/);
  });
});

/* -------------------------------------------------------------------------- */
/* Body verification                                                          */
/* -------------------------------------------------------------------------- */

describe('loadPack integrity', () => {
  it('rejects a body whose byte count disagrees with the manifest', async () => {
    const body = await gzip(packJson([scenario()]));
    const entry = entryFor(body, { bytes: body.byteLength + 1 });
    const fetchImpl = async () => bodyResponse(body);
    await expect(loadPack(entry, { fetchImpl, cache: memoryCache().cache })).rejects.toThrow(
      /is \d+ bytes; the manifest says/,
    );
  });

  it('rejects a body whose sha256 disagrees with the manifest', async () => {
    const body = await gzip(packJson([scenario()]));
    const entry = entryFor(body, { sha256: 'b'.repeat(64) });
    const fetchImpl = async () => bodyResponse(body);
    await expect(loadPack(entry, { fetchImpl, cache: memoryCache().cache })).rejects.toThrow(
      /hashes to [0-9a-f]{64}; the manifest says/,
    );
  });

  it('refetches when the cached bytes are corrupt', async () => {
    const body = await gzip(packJson([scenario()]));
    const entry = entryFor(body);
    const memory = memoryCache();
    // Same length, different contents: passes the byte check, fails the hash.
    memory.entries.set(
      packCacheKey(entry),
      body.slice().fill(0).buffer as ArrayBuffer,
    );

    let fetches = 0;
    const loaded = await loadPack(entry, {
      cache: memory.cache,
      fetchImpl: async () => {
        fetches += 1;
        return bodyResponse(body);
      },
    });

    expect(fetches).toBe(1);
    expect(loaded.fromCache).toBe(false);
    expect(memory.calls.remove).toBe(1);
    expect(memory.calls.write).toBe(1);
  });

  it('swallows a cache that always fails', async () => {
    const body = await gzip(packJson([scenario()]));
    const entry = entryFor(body);
    const broken: PackCache = {
      read: async () => {
        throw new Error('read failed');
      },
      write: async () => {
        throw new Error('quota');
      },
      remove: async () => {
        throw new Error('delete failed');
      },
    };

    const loaded = await loadPack(entry, {
      cache: broken,
      fetchImpl: async () => bodyResponse(body),
    });

    expect(loaded.pack.pack_id).toBe(entry.id);
  });

  it('falls back to the mirror after the same-origin body fails', async () => {
    const body = await gzip(packJson([scenario()]));
    const entry = entryFor(body);
    const seen: string[] = [];
    const loaded = await loadPack(entry, {
      cache: memoryCache().cache,
      mirrorBase: 'https://mirror.example/scenarios',
      fetchImpl: async (input) => {
        const url = String(input);
        seen.push(url);
        return url.startsWith('/scenarios/')
          ? bodyResponse(new Uint8Array(), { status: 404 })
          : bodyResponse(body);
      },
    });

    expect(seen).toEqual([
      `/scenarios/${entry.path}`,
      `https://mirror.example/scenarios/${entry.path}`,
    ]);
    expect(loaded.pack.pack_id).toBe(entry.id);
  });

  it('rejects an HTML body', async () => {
    const entry = okEntry({ bytes: 20 });
    await expect(
      loadPack(entry, {
        cache: memoryCache().cache,
        fetchImpl: async () =>
          bodyResponse(new TextEncoder().encode('<html>not a pack</html>'), {
            contentType: 'text/html',
          }),
      }),
    ).rejects.toThrow(/HTML page/);
  });

  it('rejects a body that is not gzip', async () => {
    const notGzip = new TextEncoder().encode('definitely not gzip bytes');
    const entry = entryFor(notGzip);
    await expect(
      loadPack(entry, {
        cache: memoryCache().cache,
        fetchImpl: async () => bodyResponse(notGzip),
      }),
    ).rejects.toThrow(/not a gzip document/);
  });
});

describe('packBodyUrls', () => {
  it('tries same-origin first and adds the mirror once', () => {
    const entry = okEntry();
    expect(packBodyUrls(entry, undefined)).toEqual([`/scenarios/${entry.path}`]);
    expect(packBodyUrls(entry, 'https://mirror.example/scenarios')).toEqual([
      `/scenarios/${entry.path}`,
      `https://mirror.example/scenarios/${entry.path}`,
    ]);
    expect(packBodyUrls(entry, 'https://mirror.example/scenarios/')).toHaveLength(2);
    expect(packBodyUrls(entry, '   ')).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Body schema                                                                */
/* -------------------------------------------------------------------------- */

async function expectBodyRejected(
  overrides: Record<string, unknown>,
  pattern: RegExp,
  scenarios: PackScenario[] = [scenario()],
): Promise<void> {
  const text = packJson(scenarios, overrides);
  const body = await gzip(text);
  const entry = entryFor(body);
  await expect(parsePackBody(body, entry)).rejects.toThrow(pattern);
}

describe('parsePackBody', () => {
  it('accepts a matching body and groups it by lesson', async () => {
    const scenarios = [scenario(), scenario('ryanmen_protorun', 'fixture-rya')];
    const body = await gzip(packJson(scenarios));
    const entry = entryFor(body, {
      scenario_count: 2,
      lesson_ids: ['fold_to_riichi', 'ryanmen_protorun'],
    });
    const pack = await parsePackBody(body, entry);
    expect(pack.scenarios).toHaveLength(2);
    const byLesson = groupScenariosByLesson(pack);
    expect(byLesson.get('fold_to_riichi')?.[0].id).toBe('fixture-fold_to_riichi');
    expect(byLesson.get('ryanmen_protorun')?.[0].id).toBe('fixture-rya');
  });

  it.each([
    ['a wrong schema', { schema: 'other' }, /has schema "other"/],
    ['a wrong version', { version: 2 }, /has version 2/],
    ['a different pack id', { pack_id: 'replay.other' }, /but the manifest lists/],
  ])('rejects %s', async (_label, overrides, pattern) => {
    await expectBodyRejected(overrides, pattern as RegExp);
  });

  it.each([
    ['a non-self-play source', { source: { ...(JSON.parse(packJson([])).source as object), kind: 'third_party' } }, /source kind "third_party"/],
    ['a non-redistributable source', { source: { ...(JSON.parse(packJson([])).source as object), redistributable: false } }, /not marked redistributable/],
    ['missing attribution', { source: { ...(JSON.parse(packJson([])).source as object), attribution: '' } }, /no attribution/],
    ['no agents', { source: { ...(JSON.parse(packJson([])).source as object), agents: [] } }, /names no contributing agent/],
    ['an agent with no licence', { source: { ...(JSON.parse(packJson([])).source as object), agents: [{ agent_id: 'x', licence: {} }] } }, /agent with no licence/],
    ['a licence mismatch', { source: { ...(JSON.parse(packJson([])).source as object), licence: 'MIT' } }, /disagrees with the manifest/],
    ['a commercial flag mismatch', { source: { ...(JSON.parse(packJson([])).source as object), data_commercial_use: false } }, /data_commercial_use disagrees/],
  ])('fails closed on %s', async (_label, overrides, pattern) => {
    await expectBodyRejected(overrides, pattern as RegExp);
  });

  it('rejects a scenario-count mismatch', async () => {
    const body = await gzip(packJson([scenario()]));
    const entry = entryFor(body, { scenario_count: 2 });
    await expect(parsePackBody(body, entry)).rejects.toThrow(/scenarios; the manifest says/);
  });

  it('rejects a lesson-id mismatch', async () => {
    const body = await gzip(packJson([scenario()]));
    const entry = entryFor(body, { lesson_ids: ['push_or_fold'] });
    await expect(parsePackBody(body, entry)).rejects.toThrow(
      /is not in the manifest entry/,
    );
  });

  it('rejects a book-section mismatch', async () => {
    const body = await gzip(packJson([scenario()]));
    const entry = entryFor(body, { book_sections: ['ch8.4'] });
    await expect(parsePackBody(body, entry)).rejects.toThrow(/book_sections disagree/);
  });

  it('rejects a requires_model mismatch', async () => {
    const body = await gzip(packJson([scenario()]));
    const entry = entryFor(body, { requires_model: false });
    await expect(parsePackBody(body, entry)).rejects.toThrow(/requires_model disagrees/);
  });

  it('accepts a fully labelled pack as not requiring a model', async () => {
    const labelled = scenario('fold_to_riichi', 'labelled', {
      mortal: { model: 'mortal-298k' },
    });
    const body = await gzip(packJson([labelled]));
    const entry = entryFor(body, { requires_model: false });
    const pack = await parsePackBody(body, entry);
    expect(pack.scenarios[0].mortal).toEqual({ model: 'mortal-298k' });
  });

  it('rejects duplicate scenario ids', async () => {
    const body = await gzip(
      packJson([scenario('fold_to_riichi', 'same'), scenario('fold_to_riichi', 'same')]),
    );
    const entry = entryFor(body, { scenario_count: 2 });
    await expect(parsePackBody(body, entry)).rejects.toThrow(/repeats a scenario id/);
  });

  it('rejects a lesson that is not in the manifest entry', async () => {
    const body = await gzip(packJson([scenario('push_or_fold', 'other')]));
    const entry = entryFor(body, { lesson_ids: ['fold_to_riichi'] });
    await expect(parsePackBody(body, entry)).rejects.toThrow(/is not in the manifest entry/);
  });

  it.each([
    ['three players', { state: { ...state(), players: state().players.slice(0, 3) } }, /four players/],
    ['no human', { state: { ...state(), players: state().players.map((p) => ({ ...(p as object), is_human: false })) } }, /no human player/],
    ['no tiles', { state: { ...state(), tiles: undefined } }, /no tile list/],
    ['no category', { state: { ...state(), category: undefined } }, /no lesson category/],
    ['an invalid answer', { correct_action: { type: 'wat' } }, /correct_action is not a valid answer/],
    ['an unsafe id', { id: '../x' }, /not a safe scenario id/],
    ['a missing lesson', { lesson_id: '' }, /lesson_id is missing/],
  ])('rejects a scenario with %s', async (_label, overrides, pattern) => {
    await expectBodyRejected(
      {
        scenarios: [
          { ...scenario(), ...(overrides as object) } as PackScenario,
        ],
      },
      pattern as RegExp,
    );
  });

  it('does not require a book section', async () => {
    const withoutBook = scenario('fold_to_riichi', 'no-book');
    delete withoutBook.book;
    const body = await gzip(packJson([withoutBook]));
    const entry = entryFor(body, { book_sections: [] });
    const pack = await parsePackBody(body, entry);
    expect(pack.scenarios[0].book).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Hashing                                                                    */
/* -------------------------------------------------------------------------- */

describe('sha256', () => {
  const vectors: Array<[string, string]> = [
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'The quick brown fox jumps over the lazy dog',
      'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
    ],
    [
      'a'.repeat(1000),
      '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3',
    ],
  ];

  it.each(vectors)('matches the known-answer vector for %s', async (input, expected) => {
    const bytes = new TextEncoder().encode(input);
    await expect(sha256Hex(bytes)).resolves.toBe(expected);
    expect(sha256FallbackHex(bytes)).toBe(expected);
  });

  it('agrees with node:crypto over random-looking bytes', async () => {
    const bytes = new Uint8Array(4096);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = (index * 37 + 11) % 256;
    }
    const expected = createHash('sha256').update(bytes).digest('hex');
    await expect(sha256Hex(bytes)).resolves.toBe(expected);
    expect(sha256FallbackHex(bytes)).toBe(expected);
  });
});

/* -------------------------------------------------------------------------- */
/* Lesson lookup                                                              */
/* -------------------------------------------------------------------------- */

describe('pickPackScenario', () => {
  const loaded = {
    entry: okEntry({ scenario_count: 2 }),
    pack: {
      schema: PACK_SCHEMA,
      version: PACK_SCHEMA_VERSION,
      pack_id: 'replay.fixture.2026-11',
      source: {},
      scenarios: [scenario('fold_to_riichi', 'a'), scenario('fold_to_riichi', 'b')],
    },
    byLesson: groupScenariosByLesson({
      schema: PACK_SCHEMA,
      version: PACK_SCHEMA_VERSION,
      pack_id: 'replay.fixture.2026-11',
      source: {},
      scenarios: [scenario('fold_to_riichi', 'a'), scenario('fold_to_riichi', 'b')],
    }),
    fromCache: false,
  };

  it('picks within the lesson and never overruns the list', () => {
    expect(pickPackScenario(loaded, 'fold_to_riichi', () => 0).id).toBe('a');
    expect(pickPackScenario(loaded, 'fold_to_riichi', () => 0.999).id).toBe('b');
    expect(pickPackScenario(loaded, 'fold_to_riichi', () => 2).id).toBe('b');
    expect(pickPackScenario(loaded, 'fold_to_riichi', () => -1).id).toBe('a');
  });

  it('rejects a lesson the pack does not contain', () => {
    expect(() => pickPackScenario(loaded, 'push_or_fold')).toThrow(/no scenario for lesson/);
  });
});

describe('packCacheKey', () => {
  it('keys by pack id, content address and cache version', () => {
    expect(packCacheKey(okEntry())).toBe(`replay.fixture.2026-11@${HASH}@v1`);
  });
});

describe('manifest type', () => {
  it('is exported with the fields the picker needs', () => {
    const manifest: PackManifest = parsePackManifest(manifestText([okEntry()]));
    expect(manifest.packs[0].id).toBe('replay.fixture.2026-11');
    expect(manifest.packs[0].lesson_ids).toEqual(['fold_to_riichi']);
  });
});
