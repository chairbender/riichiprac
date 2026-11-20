// @vitest-environment jsdom
/**
 * The 3D practice HUD composed with the scene's hand (3D-H3).
 *
 * This is the one test where the HUD's rail and the projected hand exist at the
 * same time, so it asserts the three facts the composition depends on:
 *
 * 1. **One hand.** Exactly one DOM button per hand tile plus the draw, and the
 *    rail adds none — the HUD never renders a second hand.
 * 2. **Arm, then tap a tile.** The Riichi and Kan toggles arm through the store's
 *    own `toggleRiichi`/`toggleKan`, and a projected tile click submits the armed
 *    declaration through the store's own `selectTile`, so the answer path has no
 *    renderer in it.
 * 3. **Rail first, then hand.** The HUD is a sibling mounted before the stage,
 *    so Tab reaches the rail's controls before the hand's projected buttons, and
 *    once answered the rail is gone and the result slot (H5) is free.
 *
 * The harness below is the 3D branch's wiring with the store handlers, exactly
 * as `App` passes them; the App-level mount test covers the real `App` seam.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TableOverlay } from '../overlay';
import { snapshotFromGameState } from '../snapshot';
import { frameForAspect, layoutBoard } from '../three/boardLayout';
import { hitRects } from '../three/hitTest';
import { ActionRail } from './ActionRail';
import { actionRailVisible } from './actionRail';
import { HandRail } from './HandRail';
import { HudLayer } from './HudLayer';
import { HudToastStack } from './ToastStack';
import { buildHudToasts } from './toastModel';
import { clearHudAnchors, publishHudAnchors } from './hudAnchors';
import { HUD_GAP, topBarHeight } from './hudLayout';
import { kanToggleTile } from '../../actions';
import { handHintFor } from '../../handHint';
import { useGameStore } from '../../store/useGameStore';
import type { GameState, PlayerState } from '../../types/game';

vi.mock('riichiprac', () => ({
  generate_puzzle: vi.fn(() => '{}'),
  list_scenarios: vi.fn(() => '[]'),
  // An ungraded answer is enough: this test is about which action was submitted.
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

vi.mock('../../wasm', () => ({ ensureWasmReady: async () => undefined }));

vi.mock('../../services/weightLoader', () => ({
  WEIGHTS_FILENAME: 'mortal_298k.safetensors',
  loadWeights: async () => {
    throw new Error('weights unavailable in this test');
  },
}));

const ANCHOR_OWNER = {};
const BAND = { left: 300, top: 640, width: 400, height: 80 };
const VIEWPORT = { widthPx: 1024, heightPx: 768 };

const HUMAN: PlayerState = {
  seat: 0,
  name: 'You',
  is_human: true,
  wind: 'East',
  score: 25000,
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

/** A Kan lesson that may also declare Riichi: both toggles are on screen. */
function gameState(overrides: Partial<GameState> = {}): GameState {
  const tiles = [...HUMAN.hand, HUMAN.draw].filter(
    (tile): tile is string => tile !== null,
  );
  return {
    category: 'kan_or_discard',
    target_action: 'Kan',
    correct_action: { type: 'kan', tile: '1m' },
    decision: { kind: 'self_turn' },
    riichi_triggers: [],
    dama_reasons: [],
    shouminkan_triggers: [],
    hand_string: HUMAN.hand.join(''),
    tiles,
    shanten: 0,
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
    current_turn: 0,
    can_riichi: true,
    players: [HUMAN, otherPlayer(1), otherPlayer(2), otherPlayer(3)],
    ...overrides,
  };
}

/** The 3D branch's wiring: the HUD's slots plus the scene's projected hand. */
function PracticeHud() {
  const game = useGameStore((state) => state.gameState);
  const dualGrade = useGameStore((state) => state.dualGrade);
  const callRiichi = useGameStore((state) => state.callRiichi);
  const callKan = useGameStore((state) => state.callKan);
  const evaluation = useGameStore((state) => state.evaluation);
  const peeked = useGameStore((state) => state.peekedBeforeAnswer);
  const isEvaluating = useGameStore((state) => state.isEvaluating);
  const aiStatus = useGameStore((state) => state.aiStatus);
  const error = useGameStore((state) => state.error);
  const toggleRiichi = useGameStore((state) => state.toggleRiichi);
  const toggleKan = useGameStore((state) => state.toggleKan);
  const submitAction = useGameStore((state) => state.submitAction);

  const human = game?.players.find((player) => player.is_human) ?? null;
  const answered = dualGrade !== null;
  const isDrill = game?.correct_action.type === 'best';
  const availableActions = game?.ai_decision?.actions ?? [];
  const isCallLesson = Boolean(game?.call_offer) || game?.correct_action.type === 'pass';
  // This harness covers a discard/Kan lesson and a drill; a book call lesson's
  // actions come from `callOfferActions` in App and never reach the rail here.
  const actions = isCallLesson ? [] : availableActions;
  const kanTile = human
    ? kanToggleTile(human, {
        availableActions: isDrill ? availableActions : undefined,
        targetAction: game?.target_action,
      })
    : null;
  const hint = human
    ? handHintFor({
        player: human,
        isAnswered: answered,
        canDiscard: true,
        callRiichi,
        callKan,
        availableActions: isDrill ? availableActions : undefined,
        targetAction: game?.target_action,
      })
    : '';

  const railModel = {
    actions,
    canRiichi: game?.can_riichi ?? false,
    kanTile,
    answered,
    isAiScenario: isDrill,
    callRiichi,
    callKan,
    evaluation,
    revealMortal: answered || peeked,
    onToggleRiichi: toggleRiichi,
    onToggleKan: toggleKan,
    onAction: submitAction,
  };

  const toasts = buildHudToasts({ error });

  return (
    <div className="app-shell app-shell--3d">
      <HudLayer
        shellRef={{ current: null }}
        onNextScenario={() => undefined}
        hintRow={
          human ? (
            <HandRail
              hint={hint}
              aiStatus={aiStatus}
              isEvaluating={isEvaluating}
              hasEvaluation={evaluation !== null}
              peeked={peeked}
              answered={answered}
            />
          ) : undefined
        }
        actionRail={
          actionRailVisible(railModel) ? (
            <ActionRail model={railModel} />
          ) : undefined
        }
        resultCard={answered ? <span data-testid="result-card">Result</span> : undefined}
        toasts={toasts.length > 0 ? <HudToastStack toasts={toasts} /> : undefined}
        toastCount={toasts.length}
      />
      <main className="table-3d">
        {game ? <SceneHand /> : null}
      </main>
    </div>
  );
}

/** 3D-08's projected hand, on the real projection for this snapshot. */
function SceneHand() {
  const game = useGameStore((state) => state.gameState);
  const submitted = useGameStore((state) => state.submittedAnswer);
  const selectTile = useGameStore((state) => state.selectTile);
  const callRiichi = useGameStore((state) => state.callRiichi);
  const callKan = useGameStore((state) => state.callKan);
  if (!game) return null;

  const snapshot = snapshotFromGameState(game, 1, submitted !== null);
  const board = layoutBoard(snapshot);
  const frame = frameForAspect(VIEWPORT.widthPx / VIEWPORT.heightPx, board);
  const rects = hitRects(board, frame, VIEWPORT);
  return (
    <TableOverlay
      snapshot={snapshot}
      rects={rects}
      callRiichi={callRiichi}
      callKan={callKan}
      onSelectTile={selectTile}
    />
  );
}

/** Load one state straight into the store, as a deal would. */
function load(state: GameState) {
  useGameStore.getState().loadFromJson(JSON.stringify(state));
}

beforeEach(() => {
  publishHudAnchors(ANCHOR_OWNER, { handBand: BAND, compass: null });
});

afterEach(() => {
  cleanup();
  clearHudAnchors(ANCHOR_OWNER);
  useGameStore.getState().reset();
});

describe('3D practice HUD: one hand, rail first', () => {
  it('renders exactly one control per hand tile plus the draw, and the rail adds none', () => {
    load(gameState());
    const { container } = render(<PracticeHud />);

    const handGroup = within(container).getByRole('group', { name: 'Your hand' });
    const handButtons = within(handGroup).getAllByRole('button');
    expect(handButtons).toHaveLength(HUMAN.hand.length + 1);

    // The rail exists (Riichi + Kan) and contributes no hand control.
    const rail = container.querySelector('.hud-action-rail');
    expect(rail).not.toBeNull();
    expect(within(rail as HTMLElement).getAllByRole('button')).toHaveLength(2);
    expect(rail?.querySelector('[aria-label^="Discard "]')).toBeNull();
    expect(container.querySelectorAll('.hand-dock')).toHaveLength(0);
    expect(container.querySelectorAll('.hand-tile-button')).toHaveLength(0);

    // One control per tile, anywhere in the document: no second hand.
    const discardButtons = within(container)
      .getAllByRole('button')
      .filter((button) => (button.getAttribute('aria-label') ?? '').startsWith('Discard '));
    expect(discardButtons).toHaveLength(handButtons.length);
  });

  it('walks the rail before the hand, and never duplicates a focus target', async () => {
    const user = userEvent.setup();
    load(gameState());
    const { container } = render(<PracticeHud />);

    const rail = container.querySelector('.hud-action-rail') as HTMLElement;
    const handGroup = within(container).getByRole('group', { name: 'Your hand' });
    const railButtons = within(rail).getAllByRole('button');
    const handButtons = within(handGroup).getAllByRole('button');

    // DOM order is tab order: every rail control precedes every hand button.
    const lastRail = railButtons[railButtons.length - 1];
    const firstHand = handButtons[0];
    expect(
      lastRail.compareDocumentPosition(firstHand) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    const visited: string[] = [];
    for (let step = 0; step < 3 + handButtons.length; step += 1) {
      await user.tab();
      const active = document.activeElement as HTMLElement | null;
      visited.push(active?.getAttribute('aria-label') ?? active?.textContent ?? '');
    }
    // Next hand, then the two rail controls, then the projected hand.
    expect(visited.slice(0, 3)).toEqual([
      'Next scenario',
      'Call Riichi toggle, currently off',
      'Call Kan toggle for 1m, currently off',
    ]);
    expect(visited.slice(3)).toEqual(
      handButtons.map((button) => button.getAttribute('aria-label') ?? ''),
    );
  }, 60000);

  it('submits, then hides the rail so the result slot is free for H5', () => {
    load(gameState());
    const { container, rerender } = render(<PracticeHud />);
    expect(container.querySelector('.hud-action-rail')).not.toBeNull();

    fireEvent.click(
      within(container).getByRole('button', {
        name: 'Call Riichi toggle, currently off',
      }),
    );
    fireEvent.click(
      within(
        within(container).getByRole('group', { name: 'Your hand' }),
      ).getByRole('button', { name: 'Discard 2p, with Riichi' }),
    );
    expect(useGameStore.getState().submittedAnswer).toMatchObject({
      action: 'riichi',
      tile: '2p',
    });

    // The store changed; re-render is what the store subscription does.
    rerender(<PracticeHud />);
    expect(container.querySelector('.hud-action-rail')).toBeNull();
    expect(screen.getByTestId('result-card')).toBeTruthy();
    expect(container.querySelector('.hud-panel')?.getAttribute('data-slot')).toBe(
      'result',
    );
    // The hand is locked: no projected tiles left, matching the 2D dock.
    expect(
      within(container)
        .getByRole('group', { name: 'Your hand' })
        .querySelectorAll('button'),
    ).toHaveLength(0);
  });
});

describe('3D practice HUD: arm, then tap a tile', () => {
  it('submits Riichi through the store when a projected tile is clicked', () => {
    load(gameState());
    const { container } = render(<PracticeHud />);

    fireEvent.click(
      within(container).getByRole('button', {
        name: 'Call Riichi toggle, currently off',
      }),
    );
    expect(useGameStore.getState().callRiichi).toBe(true);
    // The hint and the projected labels both say what the next tap will do.
    expect(container.querySelector('.hud-hand-rail__hint')?.textContent).toBe(
      'Riichi selected - tap a tile to discard',
    );

    fireEvent.click(
      within(container).getByRole('button', { name: 'Discard 2p, with Riichi' }),
    );
    expect(useGameStore.getState().submittedAnswer).toMatchObject({
      action: 'riichi',
      tile: '2p',
    });
  });

  it('submits a Kan through the store when the armed tile is clicked', () => {
    load(gameState());
    const { container } = render(<PracticeHud />);

    fireEvent.click(
      within(container).getByRole('button', {
        name: 'Call Kan toggle for 1m, currently off',
      }),
    );
    expect(useGameStore.getState().callKan).toBe(true);

    fireEvent.click(
      within(container).getAllByRole('button', {
        name: 'Declare Kan on 1m',
      })[0],
    );
    expect(useGameStore.getState().submittedAnswer).toMatchObject({
      action: 'kan',
      tile: '1m',
    });
  });
});

describe('3D practice HUD: messages are toasts over the scene', () => {
  it('renders an error as an alert over the stage, never inside it', () => {
    load(gameState());
    useGameStore.getState().setError('WASM returned an invalid table state');
    const { container } = render(<PracticeHud />);

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('WASM returned an invalid table state');
    expect(alert.closest('.hud-toast-root')).not.toBeNull();
    // The stage holds the scene only: no status or error block in its flow.
    const stage = container.querySelector('main.table-3d') as HTMLElement;
    expect(stage.querySelector('.status-msg')).toBeNull();
    expect(stage.querySelector('.error-msg')).toBeNull();
    expect(stage.querySelector('.hud-toast-root')).toBeNull();
  });

  it('places the toast stack under the bar and clear of the hand band', () => {
    load(gameState());
    useGameStore.getState().setError('deal failed');
    const { container } = render(<PracticeHud />);
    const stack = container.querySelector('.hud-toast-root') as HTMLElement;
    expect(stack).not.toBeNull();
    // The stack is the layout's rect: under the bar (brand line + controls)
    // and above the published hand band, which starts at 640.
    expect(stack.style.top).toBe(`${topBarHeight() + HUD_GAP}px`);
    expect(parseFloat(stack.style.top) + parseFloat(stack.style.height)).toBeLessThan(
      BAND.top,
    );
  });

  it('mounts no status toast when nothing is loading', () => {
    load(gameState());
    const { container } = render(<PracticeHud />);
    expect(container.querySelector('.hud-toast-root')).toBeNull();
    // The rail's hint is the only live region in the hand panel.
    expect(container.querySelectorAll('.hud-panel [aria-live]')).toHaveLength(1);
  });
});
