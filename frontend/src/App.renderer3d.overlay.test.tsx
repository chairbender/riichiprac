// @vitest-environment jsdom
/**
 * The App-level wiring of the 3D hand overlay (3D-08).
 *
 * The overlay's buttons must call the **same store handler** the stacked and
 * top-down views call (`App`'s `selectTile`), not a renderer-local copy: the
 * answer flow has no renderer dependency, so a disposed scene cannot leave the
 * hand unanswerable. `RendererHost` is mocked here so the assertion is about the
 * props App passes, not about WebGL.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const wasmMock = vi.hoisted(() => ({ generatedJson: '{}' }));
const hostMock = vi.hoisted(() => ({
  props: null as null | {
    readonly snapshot: unknown;
    readonly pendingCall?: unknown;
    readonly onSelectTile?: (tile: string, index?: number, isDraw?: boolean) => void;
  },
}));

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
  grade_answer_json: vi.fn(() =>
    JSON.stringify({
      mode: 'book_only',
      book: null,
      mortal: null,
      outcome: 'ungraded',
    }),
  ),
  parse_scenario_report: vi.fn(() => JSON.stringify({ error: 'not used' })),
}));

vi.mock('./wasm', () => ({ ensureWasmReady: async () => undefined }));

vi.mock('./services/weightLoader', () => ({
  WEIGHTS_FILENAME: 'mortal_298k.safetensors',
  loadWeights: async () => {
    throw new Error('weights unavailable in this test');
  },
}));

vi.mock('./components/Tile', () => ({ Tile: () => null }));

vi.mock('./renderers/RendererHost', () => ({
  RendererHost: (props: unknown) => {
    hostMock.props = props as typeof hostMock.props;
    return null;
  },
}));

import { App } from './App';
import { useGameStore } from './store/useGameStore';

const scenariosDir = join(process.cwd(), 'public', 'scenarios');
const manifest = JSON.parse(readFileSync(join(scenariosDir, 'manifest.json'), 'utf8')) as {
  packs: Array<{ path: string }>;
};
const fixtureBytes = readFileSync(join(scenariosDir, manifest.packs[0].path));
const fixture = JSON.parse(gunzipSync(fixtureBytes).toString('utf8')) as {
  scenarios: Array<{ lesson_id: string; state: unknown }>;
};
const hand = fixture.scenarios[0];
if (!hand) throw new Error('fixture pack has no scenarios');

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
  useGameStore.getState().reset();
});

describe('App 3D overlay wiring (3D-08)', () => {
  it('passes the store’s own discard handler and the open call pick to the host', async () => {
    wasmMock.generatedJson = JSON.stringify(hand.state);
    window.history.replaceState(null, '', '?renderer=3d');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline in test');
      }),
    );

    render(<App />);

    await waitFor(() => expect(hostMock.props).not.toBeNull());
    expect(useGameStore.getState().gameState).not.toBeNull();

    // The exact handler the 2D views receive: a click in the 3D view answers
    // through the store, with no renderer in the path.
    expect(hostMock.props?.onSelectTile).toBe(useGameStore.getState().selectTile);
    expect(hostMock.props?.pendingCall).toBe(useGameStore.getState().pendingCall);
    expect(hostMock.props?.snapshot).not.toBeNull();

    expect(useGameStore.getState().submittedAnswer).toBeNull();
    act(() => {
      hostMock.props?.onSelectTile?.('3z', 11, false);
    });
    expect(useGameStore.getState().submittedAnswer).not.toBeNull();
    expect(useGameStore.getState().error).toBeNull();
  });
});
