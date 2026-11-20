// @vitest-environment jsdom
/**
 * App's half of the 3D degrade (3D-11 acceptance): when the host reports that
 * `compat` could not hold 30 fps, App returns to the previously selected view,
 * drops `?renderer=3d`, and leaves a dismissible notice behind.
 *
 * The host itself is faked here because its event wiring is covered in
 * `RendererHost.test.tsx`; this file is about the App-level switch and notice.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('./components/Tile', () => ({ Tile: () => null }));

// The host's own lifecycle is not this file's subject; expose the one signal
// App consumes.
vi.mock('./renderers/RendererHost', () => ({
  RendererHost: ({ onDegraded }: { onDegraded?: (message: string) => void }) => (
    <button type="button" onClick={() => onDegraded?.('The 3D view was closed for this session: test degrade.')}>
      trigger degrade
    </button>
  ),
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
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('App 3D degrade return (3D-11)', () => {
  it('returns to the stored view, clears the query flag and keeps a dismissible notice', async () => {
    wasmMock.generatedJson = JSON.stringify(hand.state);
    window.history.replaceState(null, '', '?renderer=3d');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline in test');
      }),
    );

    render(<App />);
    await waitFor(() => {
      expect(useGameStore.getState().gameState).not.toBeNull();
    });

    // The opt-in 3D mount owns the shell before the degrade.
    expect(document.querySelector('.app-shell--3d')).not.toBeNull();
    expect(document.querySelector('.app-header')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'trigger degrade' }));

    // The switch is real: the URL no longer asks for 3D and the standard shell
    // (header, cards, dock) is back.
    await waitFor(() => {
      expect(document.querySelector('.app-header')).not.toBeNull();
    });
    expect(document.querySelector('.app-shell--3d')).toBeNull();
    expect(window.location.search).not.toContain('renderer=3d');

    const notice = screen.getByText(/The 3D view was closed for this session/);
    expect(notice).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(
      screen.queryByText(/The 3D view was closed for this session/),
    ).toBeNull();
  });

  it('still returns to the stored view when history refuses the URL cleanup', async () => {
    wasmMock.generatedJson = JSON.stringify(hand.state);
    window.history.replaceState(null, '', '?renderer=3d');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline in test');
      }),
    );

    render(<App />);
    await waitFor(() => {
      expect(useGameStore.getState().gameState).not.toBeNull();
    });
    vi.spyOn(window.history, 'replaceState').mockImplementation(() => {
      throw new Error('history refused');
    });

    await userEvent.click(screen.getByRole('button', { name: 'trigger degrade' }));

    await waitFor(() => {
      expect(document.querySelector('.app-header')).not.toBeNull();
    });
    expect(document.querySelector('.app-shell--3d')).toBeNull();
    expect(
      screen.getByText(/The 3D view was closed for this session/),
    ).toBeTruthy();
  });
});
