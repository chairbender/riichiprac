// @vitest-environment jsdom
/**
 * The 3D table as a reversible value of the View control (3D-14).
 *
 * This file is about App's switch, not the scene: `RendererHost` is replaced by
 * a lifecycle spy so the assertions can be structural (which shell is mounted,
 * is the host torn down, is the hand the same object) without WebGL. The real
 * host's mount/dispose behaviour is covered in `RendererHost.test.tsx`.
 *
 * The fixture is a committed replay-pack hand, so the state reaching the table
 * is a real engine payload.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

// The compass glyphs come straight from the SVG package, which bundles its own
// React. The view switch is the subject here, not the wind art.
vi.mock('riichi-mahjong-tiles', async () => {
  const { createElement } = await import('react');
  const Glyph = (props: Record<string, unknown>) => createElement('svg', props);
  return {
    RegularTon: Glyph,
    RegularNan: Glyph,
    RegularShaa: Glyph,
    RegularPei: Glyph,
  };
});

/** Mount/unmount accounting for the scene host, which stands in for dispose. */
const hostState = vi.hoisted(() => ({
  mounts: 0,
  unmounts: 0,
  boards: [] as Array<{ seats: unknown; wall: unknown }>,
}));

vi.mock('./renderers/RendererHost', async () => {
  const { useEffect } = await import('react');
  return {
    RendererHost: ({
      snapshot,
    }: {
      snapshot: { seats: unknown; wall: unknown };
    }) => {
      useEffect(() => {
        hostState.mounts += 1;
        hostState.boards.push({ seats: snapshot.seats, wall: snapshot.wall });
        return () => {
          hostState.unmounts += 1;
        };
        // The fake's lifecycle is the subject; the snapshot it records is the
        // one it mounted with.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return <div data-testid="three-host" />;
    },
  };
});

import { generate_puzzle } from 'riichiprac';
import { App } from './App';
import { useGameStore } from './store/useGameStore';
import {
  DEFAULT_TABLE_VIEW,
  TABLE_VIEW_STORAGE_KEY,
  useSettingsStore,
} from './store/useSettingsStore';

const scenariosDir = join(process.cwd(), 'public', 'scenarios');
const manifest = JSON.parse(
  readFileSync(join(scenariosDir, 'manifest.json'), 'utf8'),
) as { packs: Array<{ path: string }> };
const fixture = JSON.parse(
  gunzipSync(readFileSync(join(scenariosDir, manifest.packs[0].path))).toString(
    'utf8',
  ),
) as { scenarios: Array<{ state: unknown }> };
const hand = fixture.scenarios[0];
if (!hand) throw new Error('fixture pack has no scenarios');

const MAX_TEXTURE_SIZE = 0x0d33;

/** A WebGL2 context that passes the capability probe without a GPU. */
function fakeWebgl2(): unknown {
  return {
    MAX_TEXTURE_SIZE,
    getParameter: (parameter: number) =>
      parameter === MAX_TEXTURE_SIZE ? 8192 : null,
    getExtension: () => ({ loseContext: () => undefined }),
  };
}

function stubWebgl2Context(available: boolean): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    (available ? fakeWebgl2() : null) as never,
  );
}

let fullscreenElement: Element | null = null;
let exitFullscreen = vi.fn(async () => {
  fullscreenElement = null;
});

function stubFullscreen(): void {
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    get: () => fullscreenElement,
  });
  Object.defineProperty(document, 'exitFullscreen', {
    configurable: true,
    writable: true,
    value: exitFullscreen,
  });
}

function hideFullscreen(): void {
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    get: () => null,
  });
  Reflect.deleteProperty(document, 'exitFullscreen');
}

function switchView(view: 'stacked' | 'topdown' | 'rendered3d'): void {
  act(() => {
    useSettingsStore.getState().setView(view);
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  hideFullscreen();
  fullscreenElement = null;
  exitFullscreen = vi.fn(async () => {
    fullscreenElement = null;
  });
  hostState.mounts = 0;
  hostState.unmounts = 0;
  hostState.boards = [];
  window.history.replaceState(null, '', '/');
  window.localStorage.clear();
  // The store deliberately survives a view switch, so a leftover hand from the
  // previous app instance would mount the scene once with it and then remount
  // when the first deal replaces it. Reset it, as the other App tests do.
  useGameStore.getState().reset();
  act(() => {
    useSettingsStore.setState({ view: DEFAULT_TABLE_VIEW });
  });
});

/** Render the app at `search` and wait for the fixture hand. */
async function renderApp(search = '/'): Promise<void> {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('offline in test');
    }),
  );
  window.history.replaceState(null, '', search);
  render(<App />);
  await waitFor(() => {
    expect(useGameStore.getState().gameState).not.toBeNull();
  });
}

describe('App view switch (3D-14)', () => {
  it('opens in 3D and keeps the same hand and answer across every view, without re-dealing', async () => {
    wasmMock.generatedJson = JSON.stringify(hand.state);
    stubWebgl2Context(true);
    await renderApp();

    const first = useGameStore.getState().gameState;
    expect(first).not.toBeNull();
    expect(generate_puzzle).toHaveBeenCalledTimes(1);
    // 3D is the default (2026-11-20): no query flag, no stored choice needed.
    await screen.findByTestId('three-host');

    // An answered hand, so the switch is shown to keep the answer state too.
    const answer = { action: 'discard' as const, tile: '5p' };
    act(() => {
      useGameStore.setState({ submittedAnswer: answer });
    });

    switchView('topdown');
    expect(document.querySelector('.table-physical')).not.toBeNull();
    expect(useGameStore.getState().gameState).toBe(first);

    switchView('stacked');
    expect(document.querySelector('.table-stack')).not.toBeNull();
    expect(useGameStore.getState().gameState).toBe(first);
    expect(useGameStore.getState().submittedAnswer).toBe(answer);

    switchView('rendered3d');
    await screen.findByTestId('three-host');
    expect(useGameStore.getState().gameState).toBe(first);
    expect(useGameStore.getState().submittedAnswer).toBe(answer);
    // One deal for the whole round-trip: switching redraws, it never re-deals.
    expect(generate_puzzle).toHaveBeenCalledTimes(1);
  });

  it('opens in the 3D shell and leaves full screen on the way out', async () => {
    wasmMock.generatedJson = JSON.stringify(hand.state);
    stubWebgl2Context(true);
    stubFullscreen();
    await renderApp();

    // The 3D shell is what a first launch draws, before any choice.
    await screen.findByTestId('three-host');
    expect(document.querySelectorAll('.app-shell--3d')).toHaveLength(1);
    expect(document.querySelectorAll('.app-shell')).toHaveLength(1);

    // The stage is in full screen (the toggle is H2's; the browser may also
    // restore a session), then the user switches away.
    fullscreenElement = document.querySelector('.app-shell--3d');
    switchView('topdown');

    await waitFor(() => expect(exitFullscreen).toHaveBeenCalled());
    expect(document.fullscreenElement).toBeNull();
    expect(document.querySelectorAll('.app-shell--3d')).toHaveLength(0);
    // The 2D layout is exactly where it was: one normal shell, its header and
    // the top-down table.
    expect(document.querySelectorAll('.app-shell')).toHaveLength(1);
    expect(document.querySelector('.app-header')).not.toBeNull();
    expect(document.querySelector('.table-physical')).not.toBeNull();
    expect(document.querySelector('.table-3d')).toBeNull();
  });

  it('mounts no chrome and no Y-flow sibling of the canvas in 3D', async () => {
    wasmMock.generatedJson = JSON.stringify(hand.state);
    stubWebgl2Context(true);
    await renderApp();
    // The default view is the 3D one, so this is the first paint.
    await screen.findByTestId('three-host');

    const shell = document.querySelector('.app-shell--3d');
    expect(shell).not.toBeNull();
    // The stage and the floating HUD are the shell's only element children, and
    // both are `position: fixed`: nothing sits in the document flow above or
    // below the scene (3D-H2's HudLayer is `inset: 0; pointer-events: none`).
    expect([...(shell?.children ?? [])].map((child) => child.className)).toEqual([
      'hud-root',
      'table-3d',
    ]);
    expect(shell?.querySelector(':scope > .table-3d')).not.toBeNull();
    for (const selector of [
      '.app-header',
      '.hand-dock',
      '.action-bar',
      '.player-row',
      '.table-info',
      '.app-view-select',
    ]) {
      expect(document.querySelector(selector), selector).toBeNull();
    }
    // The full-screen toggle stays unmounted here; the HUD chain (3D-H2) mounts
    // it in the floating shell.
    expect(screen.queryByRole('button', { name: /full screen/i })).toBeNull();
  });

  it('disposes the scene when the view leaves and restores the same board', async () => {
    wasmMock.generatedJson = JSON.stringify(hand.state);
    stubWebgl2Context(true);
    await renderApp();

    await screen.findByTestId('three-host');
    await waitFor(() => expect(hostState.mounts).toBe(1));
    const firstBoard = hostState.boards[0];

    switchView('stacked');
    // Unmounting the host is what disposes the GPU resources (the host's own
    // test pins that it calls dispose() there); the app must actually do it.
    expect(screen.queryByTestId('three-host')).toBeNull();
    await waitFor(() => expect(hostState.unmounts).toBe(1));

    switchView('rendered3d');
    await screen.findByTestId('three-host');
    await waitFor(() => expect(hostState.mounts).toBe(2));
    expect(hostState.boards[1]).toEqual(firstBoard);
  });

  it('remembers the view a player picks, and keeps it across a reload', async () => {
    wasmMock.generatedJson = JSON.stringify(hand.state);
    stubWebgl2Context(true);
    const stored = JSON.stringify({ version: 1, view: 'stacked' });
    window.localStorage.setItem(TABLE_VIEW_STORAGE_KEY, stored);
    // What a reload does for this page: the store seeds itself from its own
    // key before App renders (covered in `useSettingsStore.test.ts`). The
    // legacy settings blob is not where a view lives.
    act(() => {
      useSettingsStore.setState({ view: 'stacked' });
    });

    await renderApp();

    expect(document.querySelector('.app-shell--3d')).toBeNull();
    expect(document.querySelector('.table-stack')).not.toBeNull();
    expect(useGameStore.getState().gameState).not.toBeNull();
    expect(window.localStorage.getItem(TABLE_VIEW_STORAGE_KEY)).toBe(stored);
  });

  it('falls a chosen 3D view back to the standard table when WebGL2 is missing, keeping the choice', async () => {
    wasmMock.generatedJson = JSON.stringify(hand.state);
    stubWebgl2Context(false);
    const stored = JSON.stringify({ version: 1, view: 'rendered3d' });
    window.localStorage.setItem(TABLE_VIEW_STORAGE_KEY, stored);
    act(() => {
      useSettingsStore.setState({ view: 'rendered3d' });
    });

    await renderApp();

    expect(document.querySelector('.app-shell--3d')).toBeNull();
    expect(document.querySelector('.app-header')).not.toBeNull();
    expect(document.querySelector('.table-stack')).not.toBeNull();
    expect(screen.getByText(/standard table is shown and your 3D view choice is kept/)).toBeTruthy();
    // The picker still reports the saved choice, marked unavailable.
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('rendered3d');
    expect(
      [...select.options].find((option) => option.value === 'rendered3d')
        ?.disabled,
    ).toBe(true);
    // The fallback is drawing-only: the user's choice is not rewritten.
    expect(useSettingsStore.getState().view).toBe('rendered3d');
    expect(window.localStorage.getItem(TABLE_VIEW_STORAGE_KEY)).toBe(stored);
  });

  it('keeps ?renderer=3d as an override and leaves ?renderer=25d to the chosen view', async () => {
    wasmMock.generatedJson = JSON.stringify(hand.state);
    stubWebgl2Context(true);
    // Pin the store to a 2D view so the query's 3D mount is visibly an
    // override rather than the default.
    act(() => {
      useSettingsStore.setState({ view: 'stacked' });
    });

    await renderApp('?renderer=3d');
    expect(document.querySelector('.app-shell--3d')).not.toBeNull();
    await screen.findByTestId('three-host');
    // The override draws 3D without changing the saved choice.
    expect(useSettingsStore.getState().view).toBe('stacked');

    cleanup();
    act(() => {
      useSettingsStore.setState({ view: 'topdown' });
    });
    await renderApp('?renderer=25d');
    expect(document.querySelector('.app-shell--3d')).toBeNull();
    expect(document.querySelector('.table-physical')).not.toBeNull();
    expect(useSettingsStore.getState().view).toBe('topdown');
  });

  it('offers all three views in the picker, with 3D selected by default', async () => {
    wasmMock.generatedJson = JSON.stringify(hand.state);
    stubWebgl2Context(true);
    await renderApp();

    // The default is 3D, so the header's picker is not mounted; read the
    // setup sheet's picker instead.
    fireEvent.click(screen.getByRole('button', { name: 'Setup' }));
    const dialog = screen.getByRole('dialog', { name: 'Setup' });
    const select = within(dialog).getByRole('combobox') as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual([
      'stacked',
      'topdown',
      'rendered3d',
    ]);
    expect(select.value).toBe('rendered3d');
    expect(
      [...select.options].find((option) => option.value === 'rendered3d')
        ?.disabled,
    ).toBe(false);
  });

  it('changes the view from the setup sheet, leaving full screen (3D-H4, R14)', async () => {
    // The setup sheet's View picker calls the same App handler as the header's:
    // switching away from 3D leaves full screen, and the hand is untouched.
    wasmMock.generatedJson = JSON.stringify(hand.state);
    stubWebgl2Context(true);
    stubFullscreen();
    act(() => {
      useSettingsStore.setState({ view: 'rendered3d' });
    });
    await renderApp();
    await screen.findByTestId('three-host');
    fullscreenElement = document.querySelector('.app-shell--3d');
    const dealt = useGameStore.getState().gameState;

    fireEvent.click(screen.getByRole('button', { name: 'Setup' }));
    const dialog = screen.getByRole('dialog', { name: 'Setup' });
    const view = within(dialog).getByRole('combobox') as HTMLSelectElement;
    // A stored 3D choice keeps its matching option even while unexposed.
    expect(view.value).toBe('rendered3d');

    fireEvent.change(view, { target: { value: 'stacked' } });

    await waitFor(() => expect(exitFullscreen).toHaveBeenCalled());
    expect(document.fullscreenElement).toBeNull();
    expect(document.querySelector('.app-shell--3d')).toBeNull();
    expect(document.querySelector('.app-header')).not.toBeNull();
    expect(document.querySelector('.table-stack')).not.toBeNull();
    // The view change is a redraw: same hand, one deal for the session.
    expect(useGameStore.getState().gameState).toBe(dealt);
    expect(generate_puzzle).toHaveBeenCalledTimes(1);
  });
});
