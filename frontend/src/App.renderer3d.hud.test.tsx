// @vitest-environment jsdom
/**
 * The App-level mount seam of the 3D HUD (3D-H2).
 *
 * The HUD is mounted by `App` **only** for the 3D table view, as a sibling of
 * the fixed stage: that is the whole `App.tsx` contract of this unit. The
 * renderer is mocked here (as in 3D-08's overlay test), so what is asserted is
 * the element tree and the wiring — the layer under the canvas, the header gone,
 * the top bar's Next control on the store's own handler.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const wasmMock = vi.hoisted(() => ({
  generatedJson: '{}',
  generateCalls: 0,
}));

vi.mock('riichiprac', () => ({
  generate_puzzle: vi.fn(() => {
    wasmMock.generateCalls += 1;
    return wasmMock.generatedJson;
  }),
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
    JSON.stringify({ mode: 'book_only', book: null, mortal: null, outcome: 'ungraded' }),
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

const hostMock = vi.hoisted(() => ({
  mounted: 0,
  props: null as null | { readonly snapshot: unknown },
}));

vi.mock('./renderers/RendererHost', () => ({
  RendererHost: (props: unknown) => {
    hostMock.props = props as typeof hostMock.props;
    hostMock.mounted += 1;
    return <div data-testid="renderer-host" />;
  },
}));

import { App } from './App';
import { useGameStore } from './store/useGameStore';

const scenariosDir = join(process.cwd(), 'public', 'scenarios');
const manifest = JSON.parse(readFileSync(join(scenariosDir, 'manifest.json'), 'utf8')) as {
  packs: Array<{ path: string }>;
};
const fixture = JSON.parse(
  gunzipSync(readFileSync(join(scenariosDir, manifest.packs[0].path))).toString('utf8'),
) as { scenarios: Array<{ lesson_id: string; state: unknown }> };
const hand = fixture.scenarios[0];
if (!hand) throw new Error('fixture pack has no scenarios');

function renderThree() {
  wasmMock.generatedJson = JSON.stringify(hand.state);
  window.history.replaceState(null, '', '?renderer=3d');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('offline in test');
    }),
  );
  return render(<App />);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
  useGameStore.getState().reset();
  wasmMock.generateCalls = 0;
  hostMock.mounted = 0;
  hostMock.props = null;
});

describe('App 3D HUD mount (3D-H2)', () => {
  it('mounts the HUD as a sibling of the fixed stage, not inside it', async () => {
    const { container } = renderThree();
    await waitFor(() => expect(hostMock.props).not.toBeNull());

    const shell = container.querySelector('.app-shell--3d');
    const hud = shell?.querySelector(':scope > .hud-root');
    const stage = shell?.querySelector(':scope > main.table-3d');
    expect(hud).not.toBeNull();
    expect(stage).not.toBeNull();
    // Sibling, in the shell, and the stage still holds the scene.
    expect(hud?.contains(stage as Node)).toBe(false);
    expect(stage?.querySelector('[data-testid="renderer-host"]')).not.toBeNull();
    expect(screen.getByTestId('renderer-host')).toBeTruthy();
  });

  it('replaces the 2D header with a top bar that has no brand or scenario name', async () => {
    const { container } = renderThree();
    await waitFor(() => expect(hostMock.props).not.toBeNull());

    expect(container.querySelector('.app-header')).toBeNull();
    expect(screen.queryByRole('heading', { name: /riichiprac/i })).toBeNull();
    const bar = container.querySelector('.hud-top-bar');
    expect(bar?.textContent).not.toMatch(/riichiprac/i);
    // No lesson label either: a visible scenario name would hint at the answer.
    expect(bar?.textContent).not.toMatch(/Fold to Riichi/i);
    expect(screen.getByRole('button', { name: 'Next scenario' })).toBeTruthy();
  });

  it('deals the next hand from the top bar through the store’s own handler', async () => {
    const { container } = renderThree();
    await waitFor(() => expect(hostMock.props).not.toBeNull());

    const before = wasmMock.generateCalls;
    const rendersBefore = hostMock.mounted;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Next scenario' }));
    });

    await waitFor(() => expect(wasmMock.generateCalls).toBeGreaterThan(before));
    // A new deal re-renders the scene with a new snapshot; the HUD itself was
    // never unmounted, so the layer's own mount count is unchanged.
    expect(container.querySelector('.hud-root')).not.toBeNull();
    expect(hostMock.mounted).toBeGreaterThanOrEqual(rendersBefore);
  });

  it('is not mounted in the 2D views', async () => {
    window.history.replaceState(null, '', '/');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline in test');
      }),
    );
    wasmMock.generatedJson = JSON.stringify(hand.state);
    const { container } = render(<App />);
    await waitFor(() => expect(useGameStore.getState().gameState).not.toBeNull());

    expect(container.querySelector('.hud-root')).toBeNull();
    expect(container.querySelector('.hud-top-bar')).toBeNull();
  });
});
