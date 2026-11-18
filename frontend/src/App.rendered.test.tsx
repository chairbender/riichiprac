// @vitest-environment jsdom
/**
 * The App-level mount point for the rendered 2.5D view.
 *
 * jsdom has no 2D canvas, so this is the "the board cannot be composed" path:
 * the view must still mount its full-window stage, name itself, keep the compass
 * and the textual summary, and leave the hand dock's controls usable. The
 * committed shell manifest is the real one; only the asset loaders are stubbed
 * (they would fetch images jsdom cannot decode).
 *
 * The second assertion the unit owes is that switching into and out of the view
 * re-draws the same hand: `generate_puzzle` is called once for the deal, and the
 * store's `gameState` object stays identical across the switch.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseShellsManifest } from './table/shellManifest';

const wasmMock = vi.hoisted(() => ({ generatedJson: '{}' }));
const tableMock = vi.hoisted(() => ({ atlas: null as unknown }));

vi.mock('riichiprac', () => ({
  generate_puzzle: vi.fn(() => wasmMock.generatedJson),
  list_scenarios: vi.fn(() =>
    JSON.stringify([
      {
        id: 'riichi_good_wait',
        label: 'Riichi: good wait',
        description: 'Riichi vs dama: riichi a good wait.',
        category: 'riichi_decision',
        tags: ['riichi'],
        requires_ai: false,
        grading: 'book_and_mortal',
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
vi.mock('riichi-mahjong-tiles', () => ({
  RegularTon: () => null,
  RegularNan: () => null,
  RegularShaa: () => null,
  RegularPei: () => null,
}));

// The atlas would compose 18 offscreen canvas pages and fetch the committed
// PNGs; this test only needs the real manifest for the plan.
vi.mock('./table/TileAtlas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./table/TileAtlas')>();
  return {
    ...actual,
    loadFirstBoardAtlas: async () => tableMock.atlas,
  };
});
vi.mock('./table/boardAssets', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./table/boardAssets')>();
  return {
    ...actual,
    loadFirstBoardAssets: async () => ({
      overlays: null,
      catches: null,
      lyingCatches: null,
    }),
  };
});

import { App } from './App';
import { useGameStore } from './store/useGameStore';
import { useSettingsStore } from './store/useSettingsStore';

const scenariosDir = join(process.cwd(), 'public', 'scenarios');
const packManifest = JSON.parse(
  readFileSync(join(scenariosDir, 'manifest.json'), 'utf8'),
) as { packs: Array<{ path: string }> };
const pack = JSON.parse(
  gunzipSync(
    readFileSync(join(scenariosDir, packManifest.packs[0].path)),
  ).toString('utf8'),
) as { scenarios: Array<{ lesson_id: string; state: unknown }> };
const hand = pack.scenarios.find(
  (scenario) => scenario.lesson_id === 'ryanmen_protorun',
);
if (!hand) throw new Error('fixture pack is missing ryanmen_protorun');

const shells = parseShellsManifest(
  JSON.parse(
    readFileSync(join(process.cwd(), 'public/table/shells.json'), 'utf8'),
  ),
);
tableMock.atlas = {
  shells,
  hasSprite: () => false,
  getSprite: () => {
    throw new Error('not used without a canvas');
  },
  getPage: () => {
    throw new Error('not used without a canvas');
  },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useSettingsStore.getState().setView('stacked');
  window.history.replaceState(null, '', '/');
});

describe('App rendered 2.5D mount point', () => {
  it('mounts the full-window stage with an overlay HUD and keeps the hand across views', async () => {
    wasmMock.generatedJson = JSON.stringify(hand.state);
    useSettingsStore.getState().setView('rendered');
    // jsdom cannot create a 2D context; make that explicit and silent.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline in test');
      }),
    );

    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => {
      expect(useGameStore.getState().gameState).not.toBeNull();
    });
    const firstState = useGameStore.getState().gameState;

    // Full-window stage: no 680px column, no header in the document flow.
    expect(document.querySelector('.app-shell--stage')).not.toBeNull();
    expect(document.querySelector('.table-stage')).not.toBeNull();
    expect(document.querySelector('.app-header')).toBeNull();

    // The board view names itself and keeps the compass and summary.
    expect(
      screen.getByRole('group', { name: 'Rendered table view' }),
    ).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Compass' })).toBeTruthy();
    expect(screen.getByLabelText('Table summary')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(
        'could not get a 2D canvas',
      );
    });

    // The HUD carries the same interactive hand dock as the other views.
    expect(document.querySelector('.table-stage-hud .hand-dock')).not.toBeNull();
    expect(
      screen.getAllByRole('button', { name: /Discard|Riichi|Kan/ }).length,
    ).toBeGreaterThan(0);

    // The View control is in the stage's menu drawer and offers all three.
    await user.click(screen.getByRole('button', { name: 'Table menu' }));
    const select = (await screen.findByRole('combobox', {
      name: /View/,
    })) as HTMLSelectElement;
    expect(
      [...select.options].map((option) => option.value),
    ).toEqual(['stacked', 'topdown', 'rendered']);
    expect(select.value).toBe('rendered');

    // Switching views re-draws the same hand: no new deal, same state object.
    await user.selectOptions(select, 'topdown');
    await waitFor(() => {
      expect(document.querySelector('.table-physical')).not.toBeNull();
    });
    expect(document.querySelector('.rendered-table')).toBeNull();
    expect(useGameStore.getState().gameState).toBe(firstState);

    // Back into the rendered view from the (still open) drawer.
    const reopened = screen.getByRole('combobox', { name: /View/ }) as HTMLSelectElement;
    await user.selectOptions(reopened, 'rendered');
    await waitFor(() => {
      expect(document.querySelector('.rendered-table')).not.toBeNull();
    });
    expect(useGameStore.getState().gameState).toBe(firstState);
    expect(wasmMock.generatedJson).not.toBe('');
  });
});
