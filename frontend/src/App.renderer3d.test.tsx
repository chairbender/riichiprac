// @vitest-environment jsdom
/**
 * The App-level mount point for the opt-in 3D view (3D-02).
 *
 * jsdom has no WebGL2, so this is the "3D cannot run" path in the real App: the
 * query parameter must select the host, the host must report why, and the App
 * must not throw. The 3D view is the scene alone (user guidance 2026-11-18): no
 * app chrome is mounted above or below it, so the mount is also asserted to
 * have no header/dock/cards. The happy path (a live renderer) is covered by
 * `RendererHost.test.tsx` with a mocked lazy entry.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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

// The SVG tile package bundles its own React; tile art is irrelevant here.
vi.mock('./components/Tile', () => ({ Tile: () => null }));

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
});

describe('App 3D mount point', () => {
  it('mounts the scene alone, full-window, and reports an unavailable WebGL2', async () => {
    wasmMock.generatedJson = JSON.stringify(hand.state);
    window.history.replaceState(null, '', '?renderer=3d');
    // jsdom cannot create a WebGL2 context; make that explicit and silent
    // rather than rely on its "not implemented" console error.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    // The pack manifest is not this test's subject; an offline fetch leaves the
    // generated lesson in the pool.
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

    // The opt-in view is mounted by the query parameter...
    expect(screen.getByRole('group', { name: '3D table view' })).toBeTruthy();
    // ...it explains why it cannot run...
    expect(screen.getByText(/WebGL2 is not available/)).toBeTruthy();
    // ...and the scene alone owns the window: the shell drops the phone
    // column and no app chrome is mounted in the document flow.
    expect(document.querySelector('.app-shell--3d')).not.toBeNull();
    expect(document.querySelector('.app-shell--3d > .table-3d')).not.toBeNull();
    for (const selector of [
      '.app-header',
      '.hand-dock',
      '.action-bar',
      '.player-row',
      '.table-info',
    ]) {
      expect(document.querySelector(selector), selector).toBeNull();
    }
    // No canvas was created, so no three.js chunk was needed.
    expect(document.querySelector('canvas')).toBeNull();
    // jsdom has no Fullscreen API, so the toggle must not be offered.
    expect(screen.queryByRole('button', { name: /full screen/i })).toBeNull();
    expect(useGameStore.getState().error).toBeNull();
  });
});
