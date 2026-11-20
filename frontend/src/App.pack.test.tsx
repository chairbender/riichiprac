// @vitest-environment jsdom
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * End-to-end loader tests for the replay-first launch (RF2–RF4).
 *
 * The pack manifest arrives from the same origin; the first deal then downloads
 * exactly one content-addressed body and lays a real audited hand out through
 * the normal store path. The committed published pack (2.26 MB) is the loader's
 * own subject in `services/packLoader.test.ts`; here the body is a small pack
 * built from 40 of its real scenarios — the coverage floor, so the lesson is
 * replay-default — plus its real source/licence record, so the behaviour under
 * test (which bytes the app fetches, what it draws first and what it falls back
 * to) stays fast and independent of pack size.
 *
 * `generate_puzzle` is mocked with a real hand from the committed pack so the
 * generated fallback also renders a complete engine state.
 */

const wasmMock = vi.hoisted(() => ({ generatedJson: '{}' }));

vi.mock('riichiprac', () => ({
  generate_puzzle: vi.fn(() => wasmMock.generatedJson),
  list_scenarios: vi.fn(() =>
    JSON.stringify([
      {
        id: 'fold_to_riichi',
        label: 'Fold to Riichi',
        description: 'Defense: pick the safest discard against Riichi.',
        category: 'defense_decision',
        tags: ['defense', 'fold', 'discard'],
        requires_ai: false,
        grading: 'book_and_mortal',
        book: {
          chapter: 8,
          chapter_title: 'Defense judgement',
          section: 1,
          section_title: 'To push or to fold?',
          key: 'ch8.1',
          label: 'ch8.1 · To push or to fold?',
        },
      },
    ]),
  ),
  grade_answer_json: vi.fn(() => JSON.stringify({ error: 'not used' })),
  parse_scenario_report: vi.fn(() => JSON.stringify({ error: 'not used' })),
}));

vi.mock('./wasm', () => ({ ensureWasmReady: async () => undefined }));

vi.mock('./services/weightLoader', () => ({
  WEIGHTS_FILENAME: 'mortal_298k.safetensors',
  loadWeights: async () => {
    throw new Error('weights unavailable in this test');
  },
}));

// The SVG tile package bundles its own React, which a jsdom render cannot mix
// with the app's React. Tile art is irrelevant here: this test is about which
// bytes the loader fetches and which state reaches the store.
vi.mock('./components/Tile', () => ({ Tile: () => null }));

import { App } from './App';
import { useGameStore } from './store/useGameStore';
import { useSettingsStore } from './store/useSettingsStore';

// One test here waits out the real 2,500 ms first-deal budget, and the suite can
// run on a shared/loaded box: the vitest default (5 s) is too tight for this
// file, not for the app.
vi.setConfig({ testTimeout: 20_000 });

interface FixtureScenario {
  id: string;
  lesson_id: string;
  book?: { chapter: number; section: number; key: string; label: string } | null;
  title: string;
  prompt: string;
  state: { hand_string: string; [extra: string]: unknown };
  correct_action: Record<string, unknown>;
  accepted?: string[];
  mortal?: unknown;
  provenance?: { variant_of?: string; [extra: string]: unknown };
  [extra: string]: unknown;
}

const scenariosDir = join(process.cwd(), 'public', 'scenarios');
const committedManifest = JSON.parse(
  readFileSync(join(scenariosDir, 'manifest.json'), 'utf8'),
) as { packs: Array<{ id: string; path: string }> };
const committedEntry = committedManifest.packs.find(
  (pack) => pack.id === 'replay.ch8-defense.2026-11',
)!;
const committedPack = JSON.parse(
  gunzipSync(readFileSync(join(scenariosDir, committedEntry.path))).toString('utf8'),
) as {
  source: Record<string, unknown> & {
    licence: string;
    data_commercial_use: boolean;
  };
  scenarios: FixtureScenario[];
};

/** A complete engine state from a non-fold lesson, for the generated fallback. */
const firstBase = committedPack.scenarios.find(
  (scenario) =>
    !scenario.provenance?.variant_of && scenario.lesson_id !== 'fold_to_riichi',
);
/**
 * Real reviewed fold bases: the synthetic body's scenarios. Forty is the
 * coverage floor, so the lesson is replay-default like the published pack.
 */
const foldScenarios = committedPack.scenarios
  .filter(
    (scenario) =>
      scenario.lesson_id === 'fold_to_riichi' &&
      !scenario.provenance?.variant_of,
  )
  .slice(0, 40);
if (!firstBase || foldScenarios.length < 40) {
  throw new Error('committed pack is missing its base lessons');
}
const generatedState = firstBase.state;
const generatedHand = generatedState.hand_string;
const foldHands = new Set(foldScenarios.map((scenario) => scenario.state.hand_string));

const PACK_ID = 'replay.fixture-first-deal.2026-11';
const bodyDoc = {
  schema: 'riichiprac.scenario-pack',
  version: 1,
  pack_id: PACK_ID,
  generated_at: '2026-11-19T00:00:00Z',
  source: committedPack.source,
  scenarios: foldScenarios,
};
const fixtureBytes = gzipSync(Buffer.from(JSON.stringify(bodyDoc)));
const fixtureSha256 = createHash('sha256').update(fixtureBytes).digest('hex');
const PACK_PATH = `${PACK_ID}-${fixtureSha256.slice(0, 12)}.json.gz`;
const manifestText = JSON.stringify({
  schema: 'riichiprac.scenario-pack-manifest',
  version: 1,
  updated_at: '2026-11-19T00:00:00Z',
  packs: [
    {
      id: PACK_ID,
      path: PACK_PATH,
      sha256: fixtureSha256,
      bytes: fixtureBytes.byteLength,
      scenario_count: foldScenarios.length,
      lesson_ids: ['fold_to_riichi'],
      lesson_counts: { fold_to_riichi: foldScenarios.length },
      book_sections: [
        ...new Set(
          foldScenarios
            .map((scenario) => scenario.book?.key)
            .filter((key): key is string => typeof key === 'string'),
        ),
      ].sort(),
      licence: committedPack.source.licence,
      requires_model: false,
      data_commercial_use: committedPack.source.data_commercial_use,
    },
  ],
});

const PACK_BODY_URL = `/scenarios/${PACK_PATH}`;
const manifestUrl = '/scenarios/manifest.json';

/** Count the pack bodies a test's fetch stub served. */
function bodyCalls(calls: string[]): string[] {
  return calls.filter((url) => url.endsWith('.json.gz'));
}

/** A promise a test can settle on demand (a slow manifest or body). */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function manifestResponse(): Response {
  return new Response(manifestText, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function bodyResponse(): Response {
  return new Response(fixtureBytes, {
    status: 200,
    headers: { 'content-type': 'application/gzip' },
  });
}

function stubFetch(
  body: () => Response = bodyResponse,
): string[] {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url === manifestUrl) return manifestResponse();
    if (url === PACK_BODY_URL) return body();
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchImpl);
  return calls;
}

/** Wait for the store to hold a hand from the replay pack's fold lesson. */
async function expectReplayHand(): Promise<void> {
  await waitFor(
    () => {
      const hand = useGameStore.getState().gameState?.hand_string ?? '';
      expect(foldHands.has(hand)).toBe(true);
    },
    { timeout: 10_000 },
  );
}

/** Wait for the generated hand the WASM mock returns. */
async function expectGeneratedHand(): Promise<void> {
  await waitFor(() => {
    expect(useGameStore.getState().gameState?.hand_string).toBe(
      generatedHand,
    );
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // A test that forces the generated pool must not leak into the next one.
  useSettingsStore.getState().setPreferReplay(true);
});

describe('App replay-first first deal (RF4)', () => {
  it('opens with a replay hand from the covered lesson', async () => {
    wasmMock.generatedJson = JSON.stringify(generatedState);
    const calls = stubFetch();

    render(<App />);

    // The first deal waits for the manifest, then deals the covered lesson's
    // replay hand instead of the generated one.
    await expectReplayHand();

    expect(calls).toContain(manifestUrl);
    expect(bodyCalls(calls)).toEqual([PACK_BODY_URL]);
    expect(useGameStore.getState().error).toBeNull();
  });

  it('shows a status while the first replay hand is on its way', async () => {
    wasmMock.generatedJson = JSON.stringify(generatedState);
    const calls: string[] = [];
    const manifest = deferred<Response>();
    const body = deferred<Response>();
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url === manifestUrl) return manifest.promise;
        if (url === PACK_BODY_URL) return body.promise;
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    render(<App />);

    // The loading state is announced while the manifest is in flight: the deal
    // has not chosen a lesson yet, so it cannot be the pack's own note.
    const status = await screen.findByText('Loading a replay position…');
    expect(status.getAttribute('role')).toBe('status');

    await act(async () => {
      manifest.resolve(manifestResponse());
    });
    await waitFor(() => expect(calls).toContain(PACK_BODY_URL));

    await act(async () => {
      body.resolve(bodyResponse());
    });
    await expectReplayHand();

    // Once the hand is laid out the loading status is gone.
    expect(screen.queryByText('Loading a replay position…')).toBeNull();
    expect(useGameStore.getState().error).toBeNull();
  });

  it('clears the first-deal status when another deal replaces it', async () => {
    wasmMock.generatedJson = JSON.stringify(generatedState);
    const user = userEvent.setup();
    const manifest = deferred<Response>();
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === manifestUrl) return manifest.promise;
        return bodyResponse();
      }),
    );

    render(<App />);
    expect(await screen.findByText('Loading a replay position…')).toBeTruthy();

    // Deal a generated lesson from the picker while the first replay hand is
    // still waiting for its manifest: that deal owns the table now.
    await user.click(
      screen.getByTitle(
        'Choose one lesson, all scenarios, or a pool to randomise between',
      ),
    );
    const panel = await screen.findByRole('dialog', { name: 'Scenario pool' });
    await user.click(within(panel).getAllByRole('button', { name: 'Only' })[0]);
    await expectGeneratedHand();

    // The abandoned first-deal wait must not leave its status over the hand.
    expect(screen.queryByText('Loading a replay position…')).toBeNull();
    await act(async () => {
      manifest.resolve(manifestResponse());
    });
    expect(screen.queryByText('Loading a replay position…')).toBeNull();
    expect(useGameStore.getState().error).toBeNull();
  });

  it('deals the generated hand when the manifest cannot be reached', async () => {
    wasmMock.generatedJson = JSON.stringify(generatedState);
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        throw new Error('offline in test');
      }),
    );

    render(<App />);

    await expectGeneratedHand();
    expect(calls).toContain(manifestUrl);
    expect(bodyCalls(calls)).toEqual([]);
    expect(useGameStore.getState().error).toBeNull();
  });

  it('falls back to the generated lesson when the first replay body fails', async () => {
    wasmMock.generatedJson = JSON.stringify(generatedState);
    const user = userEvent.setup();
    const calls = stubFetch(() => new Response('not found', { status: 404 }));

    render(<App />);

    await expectGeneratedHand();
    expect(bodyCalls(calls)).toEqual([PACK_BODY_URL]);
    // The deal succeeded through the generated path; the failure is a picker
    // note, not an app error.
    expect(useGameStore.getState().error).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();

    const trigger = screen.getByTitle(
      'Choose one lesson, all scenarios, or a pool to randomise between',
    );
    await user.click(trigger);
    const panel = screen.getByRole('dialog', { name: 'Scenario pool' });
    expect(within(panel).getByRole('status').textContent).toContain(
      'could not be delivered',
    );
  });

  it('deals the generated hand when the replay manifest misses its budget', async () => {
    wasmMock.generatedJson = JSON.stringify(generatedState);
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        calls.push(String(input));
        // Never settles: the first deal must stop waiting at its budget.
        return new Promise<Response>(() => {});
      }),
    );

    render(<App />);

    await waitFor(
      () => {
        expect(useGameStore.getState().gameState?.hand_string).toBe(
          generatedHand,
        );
      },
      { timeout: 10_000 },
    );
    expect(bodyCalls(calls)).toEqual([]);
    expect(useGameStore.getState().error).toBeNull();
  }, 15_000);

  it('fetches no pack body on the first deal when replay is off', async () => {
    wasmMock.generatedJson = JSON.stringify(generatedState);
    const calls = stubFetch();
    useSettingsStore.getState().setPreferReplay(false);

    render(<App />);

    await expectGeneratedHand();
    await waitFor(() => expect(calls).toContain(manifestUrl));
    // The manifest is metadata the picker needs; the body is not fetched.
    expect(bodyCalls(calls)).toEqual([]);
    expect(useGameStore.getState().error).toBeNull();
  });
});

describe('App replay-pack loading', () => {
  it('shows both the replay and generated rows for a covered lesson', async () => {
    wasmMock.generatedJson = JSON.stringify(generatedState);
    const user = userEvent.setup();
    stubFetch();

    render(<App />);
    await expectReplayHand();

    const trigger = await screen.findByTitle(
      'Choose one lesson, all scenarios, or a pool to randomise between',
    );
    await user.click(trigger);

    // The committed manifest covers fold_to_riichi (731 bases), so the lesson
    // has a replay default *and* keeps its generated row for drilling it. All
    // stands for the replay row now, so that is the ticked one; the generated
    // row is the explicit opt-in and is marked as such.
    const replayBox = await screen.findByRole('checkbox', {
      name: /Fold to Riichi \(replay\)/i,
    });
    const generatedBox = screen.getByRole('checkbox', {
      name: /^Fold to Riichi GENERATED$/i,
    });
    expect(replayBox).not.toBe(generatedBox);
    expect((replayBox as HTMLInputElement).checked).toBe(true);
    expect((generatedBox as HTMLInputElement).checked).toBe(false);
    expect(
      within(generatedBox.closest('li') as HTMLElement).getByText('GENERATED'),
    ).toBeTruthy();
  });

  it('deals generated hands from All once the Generated filter is chosen', async () => {
    wasmMock.generatedJson = JSON.stringify(generatedState);
    const user = userEvent.setup();
    const calls = stubFetch();

    render(<App />);
    await expectReplayHand();
    expect(bodyCalls(calls)).toHaveLength(1);

    const trigger = await screen.findByTitle(
      'Choose one lesson, all scenarios, or a pool to randomise between',
    );
    await user.click(trigger);
    const panel = await screen.findByRole('dialog', { name: 'Scenario pool' });
    await user.click(
      within(panel).getByRole('radio', { name: 'Generated' }),
    );
    // The filter is the visible form of the RF2 setting.
    expect(useSettingsStore.getState().preferReplay).toBe(false);
    await user.click(within(panel).getByRole('button', { name: 'Cancel' }));

    // The next hand comes from the generator: no further pack body is fetched.
    await user.click(screen.getAllByLabelText('Next scenario')[0]);
    await waitFor(() => {
      expect(useGameStore.getState().gameState?.hand_string).toBe(
        generatedHand,
      );
    });
    expect(bodyCalls(calls)).toHaveLength(1);
    expect(useGameStore.getState().error).toBeNull();
  });

  it('deals the covered lesson from replay on the next hand too', async () => {
    wasmMock.generatedJson = JSON.stringify(generatedState);
    const user = userEvent.setup();
    const calls = stubFetch();

    render(<App />);
    await expectReplayHand();
    expect(bodyCalls(calls)).toEqual([PACK_BODY_URL]);

    // All is replay-first once the manifest is in hand, so the next deal is the
    // pack body again. jsdom has no IndexedDB, so it is re-fetched here; a
    // browser serves the second deal from the content-addressed cache.
    await user.click(screen.getAllByLabelText('Next scenario')[0]);
    await expectReplayHand();
    expect(bodyCalls(calls)).toEqual([PACK_BODY_URL, PACK_BODY_URL]);
    expect(useGameStore.getState().error).toBeNull();
  });
});
