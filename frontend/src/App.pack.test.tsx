// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * End-to-end loader test: the first deal is generated, the replay pack manifest
 * arrives from the same origin, and picking the replay lesson downloads exactly
 * one content-addressed body and lays it out through the normal store path.
 *
 * `generate_puzzle` is mocked with a real hand from the committed pack so the
 * table renderer gets a complete engine state. The pack body served to the
 * loader is the committed `frontend/public/scenarios` pack, so the test covers
 * the published bytes, not a hand-built copy.
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

const scenariosDir = join(process.cwd(), 'public', 'scenarios');
const manifestText = readFileSync(join(scenariosDir, 'manifest.json'), 'utf8');
const fixtureManifest = JSON.parse(manifestText) as {
  packs: Array<{ id: string; path: string }>;
};
const fixtureEntry = fixtureManifest.packs[0];
const fixtureBytes = readFileSync(join(scenariosDir, fixtureEntry.path));
const fixturePack = JSON.parse(gunzipSync(fixtureBytes).toString('utf8')) as {
  scenarios: Array<{
    lesson_id: string;
    state: { hand_string: string };
    provenance?: { variant_of?: string };
  }>;
};
const firstBase = fixturePack.scenarios.find(
  (scenario) =>
    !scenario.provenance?.variant_of && scenario.lesson_id !== 'fold_to_riichi',
);
const fold = fixturePack.scenarios.find(
  (scenario) => scenario.lesson_id === 'fold_to_riichi',
);
if (!firstBase || !fold) throw new Error('pack is missing its base lessons');
const foldHands = new Set(
  fixturePack.scenarios
    .filter((scenario) => scenario.lesson_id === 'fold_to_riichi')
    .map((scenario) => scenario.state.hand_string),
);

function stubFetch(): string[] {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url === '/scenarios/manifest.json') {
      return new Response(manifestText, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === `/scenarios/${fixtureEntry.path}`) {
      return new Response(fixtureBytes, {
        status: 200,
        headers: { 'content-type': 'application/gzip' },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchImpl);
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('App replay-pack loading', () => {
  it('starts with the manifest only, then loads one pack body for a replay lesson', async () => {
    const user = userEvent.setup();
    wasmMock.generatedJson = JSON.stringify(firstBase.state);
    const calls = stubFetch();

    render(<App />);

    // The first hand is the generated one (the mock's first base state).
    await waitFor(() => {
      expect(useGameStore.getState().gameState?.hand_string).toBe(
        firstBase.state.hand_string,
      );
    });
    await waitFor(() => {
      expect(calls).toContain('/scenarios/manifest.json');
    });
    expect(calls.filter((url) => url.endsWith('.json.gz'))).toEqual([]);

    // The picker now offers the replay entry merged from the manifest.
    const trigger = await screen.findByTitle(
      'Choose one lesson, all scenarios, or a pool to randomise between',
    );
    await user.click(trigger);
    const packBox = await screen.findByRole('checkbox', {
      name: /Fold to Riichi \(replay\)/i,
    });
    const row = packBox.closest('li') as HTMLElement;
    expect(within(row).getByText('PACK')).toBeTruthy();
    // Opening the picker still fetched nothing: the body is lazy.
    expect(calls.filter((url) => url.endsWith('.json.gz'))).toEqual([]);

    await user.click(within(row).getByRole('button', { name: 'Only' }));

    await waitFor(() => {
      const hand = useGameStore.getState().gameState?.hand_string ?? '';
      expect(foldHands.has(hand)).toBe(true);
    });
    expect(calls.filter((url) => url.endsWith('.json.gz'))).toEqual([
      `/scenarios/${fixtureEntry.path}`,
    ]);
    expect(useGameStore.getState().error).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
