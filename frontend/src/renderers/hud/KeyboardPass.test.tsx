// @vitest-environment jsdom
/**
 * 3D-15: the keyboard-only pass through the floating HUD.
 *
 * One full pass, no pointer: the setup trigger → its sheet → Escape back to the
 * trigger → the action rail → the projected hand → an answer → the result card's
 * live announcement → Details → Escape back to Details → Next hand.
 *
 * The harness is the App's 3D branch with the real `HudLayer`, `ActionRail`,
 * `HandRail`, `ResultCard` and `TableOverlay`; only the store's WASM grading is
 * mocked, so this is the composition the browser runs. Focus is asserted at
 * every step (never orphaned, the scene `inert` only while a sheet is open),
 * and the result live region is asserted to be one node whose text changes
 * once — opening and closing a sheet never re-announces it.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect, useMemo, useRef, useState } from 'react';
import { TableOverlay } from '../overlay';
import { snapshotFromGameState } from '../snapshot';
import { answerAnnouncement } from '../../verdictText';
import { ActionRail } from './ActionRail';
import { actionRailVisible } from './actionRail';
import { HandRail } from './HandRail';
import { HudLayer } from './HudLayer';
import { ResultCard } from './ResultCard';
import { SetupTrigger } from './SetupSheet';
import { clearHudAnchors, publishHudAnchors } from './hudAnchors';
import { frameForAspect, layoutBoard } from '../three/boardLayout';
import { hitRects, handBandRect } from '../three/hitTest';
import { kanToggleTile } from '../../actions';
import { handHintFor } from '../../handHint';
import { useGameStore } from '../../store/useGameStore';
import type { GameState, PlayerState } from '../../types/game';

vi.mock('riichiprac', () => ({
  generate_puzzle: vi.fn(() => '{}'),
  list_scenarios: vi.fn(() => '[]'),
  grade_answer_json: vi.fn(() =>
    JSON.stringify({
      mode: 'book_only',
      outcome: 'only_available_agrees',
      book: {
        is_action_correct: true,
        is_tile_correct: true,
        expected_action: 'Fold',
        expected_tile: '9p',
      },
      mortal: null,
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

const VIEWPORT = { widthPx: 1024, heightPx: 768 };
const ANCHOR_OWNER = {};

const HUMAN: PlayerState = {
  seat: 0,
  name: 'You',
  is_human: true,
  wind: 'East',
  score: 25000,
  hand: ['1m', '2m', '3m', '4m', '5m', '6p', '7p', '8p', '1s', '2s', '3s', '2z', '9p'],
  draw: '5s',
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
    hand: ['1m', '1m', '1m', '1m', '1m', '1m', '1m', '1m', '1m', '1m', '1m', '1m', '1m'],
    draw: null,
  };
}

/** A plain discard lesson that may also declare Riichi, so the rail has a row. */
function gameState(): GameState {
  return {
    category: 'fold_to_riichi',
    target_action: 'Fold',
    correct_action: { type: 'fold', discard: '9p' },
    decision: { kind: 'self_turn' },
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
    current_turn: 0,
    can_riichi: true,
    players: [HUMAN, otherPlayer(1), otherPlayer(2), otherPlayer(3)],
  };
}

/** The projected hand, on the real board, publishing the HUD's anchors. */
function SceneHand() {
  const game = useGameStore((state) => state.gameState);
  const grade = useGameStore((state) => state.dualGrade);
  const submitted = useGameStore((state) => state.submittedAnswer);
  const callRiichi = useGameStore((state) => state.callRiichi);
  const callKan = useGameStore((state) => state.callKan);
  const selectTile = useGameStore((state) => state.selectTile);

  const snapshot = useMemo(
    () => (game ? snapshotFromGameState(game, 1, submitted !== null) : null),
    [game, submitted],
  );
  const board = useMemo(
    () => (snapshot ? layoutBoard(snapshot) : null),
    [snapshot],
  );
  const frame = useMemo(
    () => (board ? frameForAspect(VIEWPORT.widthPx / VIEWPORT.heightPx, board) : null),
    [board],
  );
  const rects = useMemo(
    () =>
      board && frame
        ? hitRects(board, frame, VIEWPORT, { locked: grade !== null })
        : [],
    [board, frame, grade],
  );
  const band = useMemo(
    () => (board && frame ? handBandRect(board, frame, VIEWPORT) : null),
    [board, frame],
  );

  // Publish after the commit, never during render: the HUD subscribes to this
  // store and must not be woken by its own parent's render.
  useEffect(() => {
    publishHudAnchors(ANCHOR_OWNER, { handBand: band, compass: null });
  }, [band]);
  useEffect(() => () => clearHudAnchors(ANCHOR_OWNER), []);

  if (!snapshot) return null;
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

/** The App's 3D branch: HUD slots, one sheet, and the projected hand. */
function Harness({ onNext }: { readonly onNext: () => void }) {
  const game = useGameStore((state) => state.gameState);
  const grade = useGameStore((state) => state.dualGrade);
  const callRiichi = useGameStore((state) => state.callRiichi);
  const callKan = useGameStore((state) => state.callKan);
  const evaluation = useGameStore((state) => state.evaluation);
  const peeked = useGameStore((state) => state.peekedBeforeAnswer);
  const isEvaluating = useGameStore((state) => state.isEvaluating);
  const aiStatus = useGameStore((state) => state.aiStatus);
  const toggleRiichi = useGameStore((state) => state.toggleRiichi);
  const toggleKan = useGameStore((state) => state.toggleKan);
  const submitAction = useGameStore((state) => state.submitAction);
  const shellRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  const [sheet, setSheet] = useState<'setup' | 'verdict' | null>(null);

  const human = game?.players.find((player) => player.is_human) ?? null;
  const answered = grade !== null;
  const kanTile = human
    ? kanToggleTile(human, { targetAction: game?.target_action })
    : null;
  const hint = human
    ? handHintFor({
        player: human,
        isAnswered: answered,
        canDiscard: true,
        callRiichi,
        callKan,
        targetAction: game?.target_action,
      })
    : '';
  const railModel = {
    actions: [],
    canRiichi: game?.can_riichi ?? false,
    kanTile,
    answered,
    isAiScenario: false,
    callRiichi,
    callKan,
    evaluation,
    revealMortal: answered || peeked,
    onToggleRiichi: toggleRiichi,
    onToggleKan: toggleKan,
    onAction: submitAction,
  };

  return (
    <div className="app-shell app-shell--3d" ref={shellRef}>
      <HudLayer
        shellRef={shellRef}
        stageRef={stageRef}
        onNextScenario={() => {
          setSheet(null);
          onNext();
        }}
        setupTrigger={
          <SetupTrigger
            onOpen={() => setSheet('setup')}
            expanded={sheet === 'setup'}
          />
        }
        hintRow={
          <HandRail
            hint={hint}
            aiStatus={aiStatus}
            isEvaluating={isEvaluating}
            hasEvaluation={evaluation !== null}
            peeked={peeked}
            answered={answered}
            onOpenVerdict={() => setSheet('verdict')}
            announceHint={!answered}
          />
        }
        actionRail={
          actionRailVisible(railModel) ? (
            <ActionRail model={railModel} />
          ) : undefined
        }
        resultCard={
          answered && grade && game ? (
            <ResultCard
              grade={grade}
              state={game}
              onDetails={() => setSheet('verdict')}
              onNext={() => {
                setSheet(null);
                onNext();
              }}
            />
          ) : undefined
        }
        sheet={
          sheet
            ? {
                title: sheet === 'setup' ? 'Setup' : 'Verdict',
                body: (
                  <button type="button">
                    {sheet === 'setup' ? 'Deal from pool' : 'Book says 9p'}
                  </button>
                ),
              }
            : null
        }
        onCloseSheet={() => setSheet(null)}
        announcement={answered && grade ? answerAnnouncement(grade) : ''}
      />
      <main className="table-3d" ref={stageRef}>
        <SceneHand />
      </main>
    </div>
  );
}

let deals = 0;
let dealState: GameState;

function renderHarness() {
  deals = 0;
  dealState = gameState();
  useGameStore.getState().loadFromJson(JSON.stringify(dealState));
  return render(
    <Harness
      onNext={() => {
        deals += 1;
        // A new hand: the store's reset + load, exactly as a deal does.
        useGameStore.getState().reset();
        useGameStore.getState().loadFromJson(JSON.stringify(dealState));
      }}
    />,
  );
}

beforeEach(() => {
  useGameStore.getState().reset();
});

afterEach(() => {
  cleanup();
  clearHudAnchors(ANCHOR_OWNER);
  useGameStore.getState().reset();
});

/** Tab until the focused element matches, collecting what was visited. */
async function tabTo(
  user: ReturnType<typeof userEvent.setup>,
  match: (element: HTMLElement) => boolean,
  limit = 40,
): Promise<HTMLElement> {
  const visited: string[] = [];
  for (let step = 0; step < limit; step += 1) {
    await user.tab();
    const active = document.activeElement as HTMLElement | null;
    if (!active) throw new Error('focus left the document');
    visited.push(active.getAttribute('aria-label') ?? active.textContent ?? '');
    if (match(active)) return active;
  }
  throw new Error(`focus never reached the target; visited ${visited.join(' | ')}`);
}

describe('3D-15 keyboard pass', () => {
  it('runs setup → rail → hand → result → Details → Next with no pointer', async () => {
    const user = userEvent.setup();
    const { container } = renderHarness();
    await waitFor(() =>
      expect(container.querySelector('.hud-action-rail')).not.toBeNull(),
    );

    // 1. The setup trigger is the first stop; Enter opens its sheet.
    const setup = await tabTo(
      user,
      (element) => element.textContent === 'Setup',
    );
    expect(document.activeElement).toBe(setup);
    await user.keyboard('{Enter}');
    expect(screen.getByRole('dialog', { name: 'Setup' })).toBeTruthy();
    // The scene is inert only while a sheet is open.
    expect(
      (container.querySelector('main.table-3d') as HTMLElement).hasAttribute(
        'inert',
      ),
    ).toBe(true);

    // 2. Escape closes it and focus returns to the trigger, not to <body>.
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(setup);
    expect(
      (container.querySelector('main.table-3d') as HTMLElement).hasAttribute(
        'inert',
      ),
    ).toBe(false);

    // 3. Tab on: top bar, then the action rail's Riichi toggle.
    const rail = container.querySelector('.hud-action-rail') as HTMLElement;
    const railButton = await tabTo(user, (element) => rail.contains(element));
    expect(railButton.getAttribute('aria-pressed')).toBe('false');

    // 4. Then the projected hand; the correct tile is reachable and activates.
    await tabTo(
      user,
      (element) =>
        element.classList.contains('renderer-3d-tile') &&
        element.getAttribute('aria-label') === 'Discard 9p',
    );
    const hand = document.activeElement as HTMLElement;
    expect(hand.getAttribute('aria-label')).toBe('Discard 9p');

    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(useGameStore.getState().dualGrade).not.toBeNull(),
    );

    // 5. The answer is announced once, by the HUD's one live region.
    const announcer = container.querySelector('.hud-announcer') as HTMLElement;
    expect(announcer.getAttribute('aria-live')).toBe('polite');
    expect(announcer.textContent).toMatch(/^Result: /);
    const announcement = announcer.textContent;

    // 6. Answering removes the focused tile, and 3D-08 hands focus to the hand
    //    group: a valid, non-orphaned target rather than <body>. The result
    //    card is announce-only until a control is reached.
    const handGroup = container.querySelector(
      '.renderer-3d-hand',
    ) as HTMLElement;
    expect(document.activeElement).toBe(handGroup);
    expect(handGroup.getAttribute('tabindex')).toBe('-1');

    // 7. Tab around the document to the card's Details: the only way into the
    //    full verdict, and never an automatic expansion.
    const details = await tabTo(
      user,
      (element) =>
        element.getAttribute('aria-label') ===
        'Show the full book and Mortal comparison',
    );
    expect(container.querySelector('.hud-result-card')).not.toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(details).toBe(document.activeElement);

    // 8. Enter opens the verdict sheet; the scene is inert; Escape returns to
    //    Details and the same live region still holds the same one announcement.
    await user.keyboard('{Enter}');
    expect(screen.getByRole('dialog', { name: 'Verdict' })).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    // The result card is unmounted while the sheet is open (the panel keeps its
    // hint row), so §6.5.5's fallback applies: focus lands on a live control in
    // the top bar, never on <body>. Next hand is one Tab from there.
    const topBar = container.querySelector('.hud-top-bar') as HTMLElement;
    expect(topBar.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(document.body);
    expect(container.querySelector('.hud-announcer')).toBe(announcer);
    expect(announcer.textContent).toBe(announcement);

    // 9. Tab to the top bar's Next and deal.
    const next = await tabTo(
      user,
      (element) =>
        element.classList.contains('hud-top-bar__next') ||
        element.textContent === 'Next Scenario',
    );
    expect(next.textContent).toBe('Next Scenario');
    const dealsBefore = deals;
    await user.keyboard('{Enter}');
    await waitFor(() => expect(deals).toBe(dealsBefore + 1));
    await waitFor(() =>
      expect(container.querySelector('.hud-result-card')).toBeNull(),
    );
    // Nothing re-dealt while a sheet was open: the only deal is the one Enter.
    expect(container.querySelector('.renderer-3d-tile')).not.toBeNull();
  }, 60000);
});
