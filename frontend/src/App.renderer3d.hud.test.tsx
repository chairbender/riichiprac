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
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DEFAULT_GRADE = JSON.stringify({
  mode: 'book_only',
  book: null,
  mortal: null,
  outcome: 'ungraded',
});

const wasmMock = vi.hoisted(() => ({
  generatedJson: '{}',
  gradedJson: JSON.stringify({
    mode: 'book_only',
    book: null,
    mortal: null,
    outcome: 'ungraded',
  }),
  generateCalls: 0,
  gradeCalls: 0,
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
  grade_answer_json: vi.fn(() => {
    wasmMock.gradeCalls += 1;
    return wasmMock.gradedJson;
  }),
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
import { clearHudAnchors, publishHudAnchors } from './renderers/hud/hudAnchors';
import type { GameState, PlayerState } from './types/game';

const scenariosDir = join(process.cwd(), 'public', 'scenarios');
const manifest = JSON.parse(readFileSync(join(scenariosDir, 'manifest.json'), 'utf8')) as {
  packs: Array<{ path: string }>;
};
const fixture = JSON.parse(
  gunzipSync(readFileSync(join(scenariosDir, manifest.packs[0].path))).toString('utf8'),
) as { scenarios: Array<{ lesson_id: string; state: unknown }> };
const hand = fixture.scenarios[0];
if (!hand) throw new Error('fixture pack has no scenarios');

const HUMAN: PlayerState = {
  seat: 0,
  name: 'You',
  is_human: true,
  wind: 'East',
  score: 25000,
  // A callable quad, so a Kan lesson would offer the toggle too.
  hand: ['1m', '1m', '1m', '1m', '2p', '3p', '4p', '5s', '6s', '7s', '2z', '3z'],
  draw: '9p',
  red_fives: [],
  discards: [],
  melds: [],
  is_riichi: false,
  riichi_discard_index: null,
};

function otherPlayer(seat: 1 | 2 | 3): PlayerState {
  return {
    ...HUMAN,
    seat,
    name: `P${seat}`,
    is_human: false,
    hand: ['1m', '1m', '1m', '1m', '1m', '1m', '1m', '1m', '1m', '1m'],
    draw: null,
    red_fives: [],
  };
}

/**
 * A call lesson that also offers Riichi: both shells must render the same call
 * actions *and* the same two call toggles for it.
 */
function callState(overrides: Partial<GameState> = {}): GameState {
  return {
    category: 'call_pon_or_pass',
    target_action: 'Call',
    correct_action: { type: 'pass' },
    call_offer: { action: 'Pon', label: 'Pon 5z', tile: '5z' },
    decision: { kind: 'react_to_discard', from: 1, tile: '5z' },
    riichi_triggers: [],
    dama_reasons: [],
    shouminkan_triggers: [],
    hand_string: HUMAN.hand.join(''),
    tiles: [...HUMAN.hand, HUMAN.draw].filter(
      (tile): tile is string => tile !== null,
    ),
    shanten: 1,
    is_agari: false,
    decompositions_count: 1,
    ukeire_tiles: [],
    ukeire_total: 0,
    round_wind: 'East',
    hand_number: 1,
    honba: 0,
    riichi_sticks: 0,
    dora_indicators: [],
    ura_dora_indicators: [],
    tiles_remaining: 60,
    current_turn: 1,
    can_riichi: true,
    players: [HUMAN, otherPlayer(1), otherPlayer(2), otherPlayer(3)],
    ...overrides,
  };
}

function renderThree(state: unknown = hand.state) {
  wasmMock.generatedJson = JSON.stringify(state);
  window.history.replaceState(null, '', '?renderer=3d');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('offline in test');
    }),
  );
  return render(<App />);
}

/** The stacked view, dealt the same state, for the drift comparisons. */
function renderStacked(state: unknown) {
  wasmMock.generatedJson = JSON.stringify(state);
  window.history.replaceState(null, '', '/');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('offline in test');
    }),
  );
  return render(<App />);
}

/** One control's comparable surface: accessible name, pressed, disabled, words. */
interface Control {
  readonly label: string;
  readonly pressed: string | null;
  readonly disabled: boolean;
  readonly text: string;
}

function controls(view: ParentNode, selector: string): Control[] {
  return [...view.querySelectorAll<HTMLButtonElement>(selector)].map(
    (element) => ({
      label: element.getAttribute('aria-label') ?? '',
      pressed: element.getAttribute('aria-pressed'),
      disabled: element.disabled,
      text: (element.textContent ?? '').replace(/\s+/g, ' ').trim(),
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
  useGameStore.getState().reset();
  wasmMock.generateCalls = 0;
  wasmMock.gradeCalls = 0;
  wasmMock.gradedJson = DEFAULT_GRADE;
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

  it('replaces the 2D header with a top bar that carries only the app name', async () => {
    const { container } = renderThree();
    await waitFor(() => expect(hostMock.props).not.toBeNull());

    expect(container.querySelector('.app-header')).toBeNull();
    // The name is the only identity (user request 2026-11-20), and it is an
    // h1 at the bar's start with the setup trigger under it.
    const brand = container.querySelector('.hud-top-bar__brand');
    expect(brand?.tagName).toBe('H1');
    expect(brand?.textContent).toBe('riichiprac');
    expect(
      container
        .querySelector('.hud-top-bar__start')
        ?.contains(brand as Node),
    ).toBe(true);
    const bar = container.querySelector('.hud-top-bar');
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

describe('App 3D practice HUD (3D-H3)', () => {
  /*
   * The HUD anchors come from the scene in the browser, but `RendererHost` is
   * mocked here, so this file supplies the projection the panel positions
   * against. The values only need to be a legal band; nothing in these tests
   * depends on the pixels.
   */
  const ANCHOR_OWNER = {};

  beforeEach(() => {
    publishHudAnchors(ANCHOR_OWNER, {
      handBand: { left: 400, top: 640, width: 200, height: 60 },
      compass: null,
    });
  });

  afterEach(() => {
    clearHudAnchors(ANCHOR_OWNER);
  });

  it('deals the ?preview=calls review set straight into the call row', async () => {
    window.history.replaceState(
      null,
      '',
      '?renderer=3d&preview=calls&case=chi-multi',
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline in test');
      }),
    );
    const { container } = render(<App />);

    await waitFor(() =>
      expect(useGameStore.getState().gameState?.category).toBe('call_demo'),
    );
    expect(useGameStore.getState().gameState?.call_offer).toMatchObject({
      action: 'Chi',
      tile: '4p',
    });
    // The review set bypasses generation entirely.
    expect(wasmMock.generateCalls).toBe(0);

    await waitFor(() =>
      expect(container.querySelector('.hud-call-bar')).not.toBeNull(),
    );
    expect(
      within(container).getByRole('button', { name: 'Call Chi on 4p' }),
    ).toBeTruthy();
  });

  it('mounts the isolated call row, and no pre-answer panel or 2D hand dock', async () => {
    const { container } = renderThree(callState());
    await waitFor(() => expect(hostMock.props).not.toBeNull());

    expect(container.querySelector('.hand-dock')).toBeNull();
    expect(container.querySelector('.hand-tile-button')).toBeNull();
    // No over-hand popup before the answer: just the bare call row.
    expect(container.querySelector('.hud-panel')).toBeNull();
    const callBar = container.querySelector('.hud-call-bar');
    expect(callBar).not.toBeNull();
    expect(callBar?.querySelector('.call-controls')).not.toBeNull();
    // And none of the old hint/Mortal chrome.
    expect(container.querySelector('.hud-hand-rail')).toBeNull();
    expect(container.querySelector('.hud-mortal-chip')).toBeNull();
  });

  it('renders the dock’s call controls unchanged, in the call row', async () => {
    const state = callState();
    const stacked = renderStacked(state);
    await waitFor(() =>
      expect(stacked.container.querySelector('.call-controls')).not.toBeNull(),
    );
    const dockCalls = controls(stacked.container, '.call-controls button');
    expect(dockCalls.map((control) => control.text)).toEqual(['Pon', 'Pass']);
    cleanup();

    const three = renderThree(state);
    await waitFor(() =>
      expect(three.container.querySelector('.call-controls')).not.toBeNull(),
    );
    expect(controls(three.container, '.hud-call-bar .call-controls button')).toEqual(
      dockCalls,
    );
    // A book call lesson has no other action, so the call row is the calls alone.
    expect(three.container.querySelector('.hud-call-bar .action-bar')).toBeNull();
  });

  it('turns a deal error into a HUD toast, not a block in the scene', async () => {
    wasmMock.generatedJson = '{}';
    window.history.replaceState(null, '', '?renderer=3d');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline in test');
      }),
    );
    const { container } = render(<App />);

    await waitFor(() =>
      expect(container.querySelector('.hud-toast--error')).not.toBeNull(),
    );
    const toast = container.querySelector('.hud-toast--error') as HTMLElement;
    expect(toast.getAttribute('role')).toBe('alert');
    expect(toast.closest('.hud-toast-root')).not.toBeNull();
    // Nothing in the stage's flow: the scene keeps the whole window.
    const stage = container.querySelector('main.table-3d') as HTMLElement;
    expect(stage.querySelector('.status-msg')).toBeNull();
    expect(stage.querySelector('.error-msg')).toBeNull();
    expect(stage.querySelector('.hud-toast-root')).toBeNull();
  });

  it('keeps loading status in a toast while the table is being dealt', async () => {
    wasmMock.generatedJson = JSON.stringify(callState());
    window.history.replaceState(null, '', '?renderer=3d');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline in test');
      }),
    );
    const { container } = render(<App />);
    // The first paint is the loading state: the store starts `isLoading`.
    expect(container.querySelector('.hud-toast--status')?.textContent).toBe(
      'Loading table…',
    );
    await waitFor(() => expect(hostMock.props).not.toBeNull());
    // Once the deal lands the status toast is gone.
    expect(container.querySelector('.hud-toast--status')).toBeNull();
  });
});

describe('App 3D setup sheet (3D-H4)', () => {
  const ANCHOR_OWNER = {};

  beforeEach(() => {
    publishHudAnchors(ANCHOR_OWNER, {
      handBand: { left: 400, top: 640, width: 200, height: 60 },
      compass: null,
    });
  });

  afterEach(() => {
    clearHudAnchors(ANCHOR_OWNER);
  });

  /** Wait until the deal and the failed Mortal load have both settled. */
  async function settled() {
    await waitFor(() => {
      expect(useGameStore.getState().gameState).not.toBeNull();
      expect(useGameStore.getState().aiStatus).toBe('error');
    });
  }

  /** One control's comparable surface, for the header/sheet drift check. */
  interface SetupControl {
    readonly label: string;
    readonly checked: boolean | null;
    readonly disabled: boolean | null;
    readonly title: string | null;
  }

  interface SetupControls {
    readonly pool: SetupControl & { readonly text: string | null };
    readonly agreement: SetupControl;
    readonly view: {
      readonly value: string;
      readonly options: ReadonlyArray<{
        readonly value: string;
        readonly text: string;
        readonly disabled: boolean;
        readonly title: string | null;
      }>;
    };
    readonly position: ReadonlyArray<Omit<SetupControl, 'checked'>>;
  }

  /**
   * The setup controls a shell renders, by their visible words and their
   * state — the comparable part of "every control matches the 2D header".
   */
  function setupControls(root: ParentNode): SetupControls {
    const pool = root.querySelector('.scenario-picker-trigger');
    const agreement = root.querySelector<HTMLInputElement>(
      '.app-toggle input[type="checkbox"]',
    );
    const agreementLabel = agreement?.closest('label') ?? null;
    const view = root.querySelector<HTMLSelectElement>('.app-view-select');
    const position = [
      ...root.querySelectorAll<HTMLButtonElement>('.state-button'),
    ];
    if (!pool || !agreement || !view) {
      throw new Error('the setup controls are not all present');
    }
    return {
      pool: {
        label: pool.getAttribute('aria-label') ?? '',
        text: pool.querySelector('.scenario-picker-trigger-label')?.textContent ?? null,
        checked: null,
        disabled: null,
        title: pool.getAttribute('title'),
      },
      agreement: {
        label: agreementLabel?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        checked: agreement.checked,
        disabled: agreement.disabled,
        title: agreementLabel?.getAttribute('title') ?? null,
      },
      view: {
        value: view.value,
        options: [...view.options].map((option) => ({
          value: option.value,
          text: option.textContent ?? '',
          disabled: option.disabled,
          title: option.getAttribute('title'),
        })),
      },
      position: position.map((button) => ({
        label: button.getAttribute('aria-label') ?? '',
        disabled: button.disabled,
        title: button.getAttribute('title'),
      })),
    };
  }

  it('opens from the top bar without re-dealing, remounting or resizing the scene', async () => {
    const { container } = renderThree(callState());
    await waitFor(() => expect(hostMock.props).not.toBeNull());
    const state = useGameStore.getState().gameState;
    const dealsBefore = wasmMock.generateCalls;
    const scene = screen.getByTestId('renderer-host');
    const stage = container.querySelector('main.table-3d') as HTMLElement;
    // Nothing about the stage's own box is written by the HUD: it is fixed and
    // the sheet is its sibling, so opening one cannot change the canvas size.
    const stageStyle = stage.getAttribute('style');

    const trigger = screen.getByRole('button', { name: 'Setup' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    trigger.focus();
    await act(async () => {
      fireEvent.click(trigger);
    });

    expect(screen.getByRole('dialog', { name: 'Setup' })).toBeTruthy();
    expect(useGameStore.getState().gameState).toBe(state);
    expect(wasmMock.generateCalls).toBe(dealsBefore);
    expect(screen.getByTestId('renderer-host')).toBe(scene);
    expect(stage.getAttribute('style')).toBe(stageStyle);
    // The scene is behind the modal, not inside it.
    expect(stage.hasAttribute('inert')).toBe(true);
    expect(stage.querySelector('.hud-sheet')).toBeNull();

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useGameStore.getState().gameState).toBe(state);
    expect(wasmMock.generateCalls).toBe(dealsBefore);
    expect(screen.getByTestId('renderer-host')).toBe(scene);
    expect(stage.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(trigger);
  }, 60000);

  it('hosts the 2D header’s controls with the same labels and disabled states', async () => {
    const state = callState();

    const stacked = renderStacked(state);
    await settled();
    expect(stacked.container.querySelector('.app-controls')).not.toBeNull();
    const header = setupControls(stacked.container);
    cleanup();

    const three = renderThree(state);
    await waitFor(() => expect(hostMock.props).not.toBeNull());
    await settled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Setup' }));
    });
    const sheet = screen.getByRole('dialog', { name: 'Setup' });

    // One comparison over the pool trigger, the agreement toggle, the View
    // picker and the export/import pair: the sheet is the header with a
    // different frame, never a second set of settings.
    expect(setupControls(sheet)).toEqual(header);
    expect(three.container.querySelector('.hud-sheet')).not.toBeNull();
  }, 60000);

  it('mounts one sheet at a time and closes the setup sheet on a deal', async () => {    const { container } = renderThree(callState());
    await waitFor(() => expect(hostMock.props).not.toBeNull());
    const dealsBefore = wasmMock.generateCalls;

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Setup' }));
    });
    const dialog = screen.getByRole('dialog', { name: 'Setup' });

    // A pool deal is committed from inside the sheet; it closes the sheet and
    // deals exactly one hand from the new pool.
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole('button', { name: /All scenarios/i }),
      );
    });
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole('button', { name: /Deal from pool/i }),
      );
    });

    await waitFor(() =>
      expect(wasmMock.generateCalls).toBe(dealsBefore + 1),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(container.querySelector('.hud-root')).not.toBeNull();
  }, 60000);

  it('opens the sheet from an imported position’s toast, with the full note', async () => {
    const { container } = renderThree(callState());
    await waitFor(() => expect(hostMock.props).not.toBeNull());

    await act(async () => {
      useGameStore.setState({ positionDescription: 'Line one\nLine two' });
    });
    const toast = container.querySelector(
      '[data-toast="position-description"]',
    ) as HTMLElement;
    expect(toast).not.toBeNull();

    await act(async () => {
      fireEvent.click(within(toast).getByRole('button', { name: 'Details' }));
    });
    // The toast carries the first line; the sheet carries it whole (§3, 32).
    const dialog = screen.getByRole('dialog', { name: 'Setup' });
    expect(dialog.textContent).toContain('Line one');
    expect(dialog.textContent).toContain('Line two');
  }, 60000);
});

describe('App 3D result card and verdict sheet (3D-H5)', () => {
  const ANCHOR_OWNER = {};

  const GRADE = {
    mode: 'book_and_mortal',
    outcome: 'both_agree',
    book: {
      is_action_correct: true,
      is_tile_correct: true,
      expected_action: 'pass',
      expected_tile: '',
    },
    mortal: {
      model: 'mortal_298k.safetensors',
      recommended_action: 'Pass',
      recommended_base: 'Pass',
      recommended_label: 'Pass',
      recommended_riichi: false,
      answer_action: 'Pass',
      matches_action: true,
      matches_tile: true,
      agrees: true,
      answer_probability: 0.71,
      top_probability: 0.71,
      confidence: 'high',
      close_second: false,
    },
  };

  beforeEach(() => {
    publishHudAnchors(ANCHOR_OWNER, {
      handBand: { left: 400, top: 640, width: 200, height: 60 },
      compass: null,
    });
  });

  afterEach(() => {
    clearHudAnchors(ANCHOR_OWNER);
  });

  it('answers into a compact card, and only Details opens the sheet', async () => {
    wasmMock.gradedJson = JSON.stringify(GRADE);
    const { container } = renderThree(callState());
    await waitFor(() => expect(hostMock.props).not.toBeNull());

    const dealtState = useGameStore.getState().gameState;
    const dealsBefore = wasmMock.generateCalls;
    const gradesBefore = wasmMock.gradeCalls;
    const announcer = container.querySelector('.hud-announcer') as HTMLElement;
    expect(announcer.textContent).toBe('');

    await act(async () => {
      useGameStore.getState().submitAnswer({ action: 'pass', tile: '' });
    });

    // Post-answer state machine: the call row is gone, the card is in its
    // slot, and nothing expanded on its own (user decision 2026-11-19).
    expect(wasmMock.gradeCalls).toBe(gradesBefore + 1);
    expect(container.querySelector('.hud-call-bar')).toBeNull();
    const panel = container.querySelector('.hud-panel') as HTMLElement;
    expect(panel.getAttribute('data-slot')).toBe('result');
    // The green/red outline is the whole panel's, not an inner box's.
    expect(panel.getAttribute('data-tone')).toBe('correct');
    expect(container.querySelector('.hud-result-card')).not.toBeNull();
    expect(container.querySelector('.answer-summary-headline')?.textContent).toBe(
      'Correct',
    );
    expect(container.querySelector('.hud-result-card__picks')?.textContent).toBe(
      'Book: Pass on Pon 5z · Mortal: Pass',
    );
    expect(screen.queryByRole('dialog')).toBeNull();

    // The result is announced once by the HUD's persistent live region.
    expect(container.querySelector('.hud-announcer')).toBe(announcer);
    expect(announcer.textContent).toBe(
      'Result: Correct. The book and Mortal agree.',
    );

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', {
          name: 'Show the full book and Mortal comparison',
        }),
      );
    });

    // The sheet is the full 2D verdict panel; opening it changed neither the
    // hand nor the grade, and it did not deal or re-evaluate.
    expect(screen.getByRole('dialog', { name: 'Verdict' })).toBeTruthy();
    expect(container.querySelector('.verdict-panel')).not.toBeNull();
    expect(useGameStore.getState().gameState).toBe(dealtState);
    expect(wasmMock.generateCalls).toBe(dealsBefore);
    expect(wasmMock.gradeCalls).toBe(gradesBefore + 1);
    expect(container.querySelector('.hud-announcer')).toBe(announcer);
    expect(announcer.textContent).toBe(
      'Result: Correct. The book and Mortal agree.',
    );
    // The scene stays mounted and inert behind the modal, never remounted.
    expect(container.querySelector('[data-testid="renderer-host"]')).not.toBeNull();

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    const card = container.querySelector('.hud-result-card') as HTMLElement;
    expect(card).not.toBeNull();

    // The card carries its own Next, so the corner is not the only way on
    // (user request 2026-11-20).
    await act(async () => {
      fireEvent.click(
        within(card).getByRole('button', { name: 'Next scenario' }),
      );
    });
    await waitFor(() =>
      expect(wasmMock.generateCalls).toBeGreaterThan(dealsBefore),
    );
    await waitFor(() =>
      expect(container.querySelector('.hud-result-card')).toBeNull(),
    );
    expect(announcer.textContent).toBe('');
  }, 60000);

  it('deals the next hand from the verdict sheet header', async () => {
    wasmMock.gradedJson = JSON.stringify(GRADE);
    const { container } = renderThree(callState());
    await waitFor(() => expect(hostMock.props).not.toBeNull());
    const dealsBefore = wasmMock.generateCalls;

    await act(async () => {
      useGameStore.getState().submitAnswer({ action: 'pass', tile: '' });
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', {
          name: 'Show the full book and Mortal comparison',
        }),
      );
    });

    const dialog = screen.getByRole('dialog', { name: 'Verdict' });
    const next = within(dialog).getByRole('button', { name: 'Next scenario' });
    expect(next.textContent).toBe('Next Scenario');

    await act(async () => {
      fireEvent.click(next);
    });
    await waitFor(() =>
      expect(wasmMock.generateCalls).toBeGreaterThan(dealsBefore),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(container.querySelector('.hud-result-card')).toBeNull();
  }, 60000);

});

