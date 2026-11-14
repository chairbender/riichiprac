// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RenderedBoard } from './RenderedBoard';
import { boardLayoutFromState } from '../table/boardFromState';
import { parseShellsManifest } from '../table/shellManifest';
import type { BoardRenderOverlay } from '../table/boardRenderer';
import type { BoardFit } from '../table/boardLayout';
import type { GameState, PlayerState } from '../types/game';
import type { TileAtlas } from '../table/TileAtlas';

const tableDir = join(process.cwd(), 'public/table');
const shells = parseShellsManifest(
  JSON.parse(readFileSync(join(tableDir, 'shells.json'), 'utf8')),
);

function player(seat: number, overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    seat,
    name: ['You', 'Shimocha', 'Toimen', 'Kamicha'][seat] ?? `Seat ${seat}`,
    is_human: seat === 0,
    wind: (['East', 'South', 'West', 'North'] as const)[seat] ?? 'East',
    score: 25000,
    hand: [],
    draw: null,
    red_fives: [],
    discards: [],
    melds: [],
    is_riichi: false,
    riichi_discard_index: null,
    ...overrides,
  };
}

const state: GameState = {
  category: 'test',
  target_action: 'Best',
  correct_action: { type: 'discard', tile: '1m' },
  decision: { kind: 'self_turn' },
  riichi_triggers: [],
  dama_reasons: [],
  shouminkan_triggers: [],
  hand_string: '',
  tiles: [],
  shanten: 0,
  is_agari: false,
  decompositions_count: 0,
  ukeire_tiles: [],
  ukeire_total: 0,
  round_wind: 'East',
  hand_number: 1,
  honba: 0,
  riichi_sticks: 0,
  dora_indicators: ['1p'],
  ura_dora_indicators: [],
  tiles_remaining: 60,
  current_turn: 0,
  players: [
    player(0, {
      hand: ['1m', '5m'],
      draw: '3m',
      red_fives: ['5m'],
      discards: [{ tile: '2p', is_riichi: false, is_tsumogiri: true }],
    }),
    player(1, { hand: ['1p', '2p'], discards: [{ tile: '9s', is_riichi: false, is_tsumogiri: false }] }),
    player(2, { hand: ['1z'], discards: [] }),
    player(3, { hand: ['9m'], discards: [] }),
  ],
};

const layout = boardLayoutFromState(shells, state);
const atlas = { shells } as unknown as TileAtlas;
const viewport = { width: layout.board.width, height: layout.board.height };
const fit: BoardFit = {
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  boardWidth: layout.board.width,
  boardHeight: layout.board.height,
};

function renderBoard(overrides: Partial<Parameters<typeof RenderedBoard>[0]> = {}) {
  const onSelectTile = vi.fn();
  const paint = vi.fn((...args: unknown[]) => {
    void args.length;
    return undefined;
  });
  const view = render(
    <RenderedBoard
      layout={layout}
      viewport={viewport}
      fit={fit}
      pixelRatio={1}
      atlas={atlas}
      felt={null}
      liftShadow={null}
      shimmer={null}
      state={state}
      answered={false}
      canDiscard
      callRiichi={false}
      callKan={false}
      highlightLastDiscard={null}
      answerPlacementId={null}
      answerCorrect={null}
      onSelectTile={onSelectTile}
      paint={paint}
      {...overrides}
    />,
  );
  return { ...view, onSelectTile, paint };
}

let getContext: { mockRestore: () => void };

beforeEach(() => {
  getContext = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue({} as CanvasRenderingContext2D);
});

afterEach(() => {
  cleanup();
  getContext.mockRestore();
  vi.clearAllMocks();
});

describe('rendered board DOM', () => {
  it('exposes one labelled button per hand tile in dock order', () => {
    renderBoard();
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Discard 1m',
      'Discard R5m',
      'Discard 3m',
    ]);
    expect(buttons.map((button) => button.getAttribute('data-placement-id'))).toEqual([
      'bottom-hand:0',
      'bottom-hand:1',
      'bottom-hand:draw',
    ]);
    expect(buttons.every((button) => !button.hasAttribute('disabled'))).toBe(true);
    expect(screen.getByRole('group', { name: 'Table, rendered 2.5D view' })).toBeTruthy();
    expect(document.querySelector('canvas')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('positions each button on the logical body rect, not the texture', () => {
    renderBoard();
    const buttons = screen.getAllByRole('button');
    for (const [index, id] of ['bottom-hand:0', 'bottom-hand:1', 'bottom-hand:draw'].entries()) {
      const placement = layout.placements.find((candidate) => candidate.id === id)!;
      const button = buttons[index];
      expect(Number.parseFloat(button.style.left)).toBeCloseTo(placement.gridX, 6);
      expect(Number.parseFloat(button.style.top)).toBeCloseTo(placement.gridY, 6);
      expect(Number.parseFloat(button.style.width)).toBeCloseTo(
        placement.advanceRect.width,
        6,
      );
      expect(Number.parseFloat(button.style.height)).toBeCloseTo(
        placement.advanceRect.height,
        6,
      );
    }
  });

  it('lifts on pointer hover inside the body, but not over the shadow margin', () => {
    const { paint } = renderBoard();
    const root = screen.getByRole('group', { name: 'Table, rendered 2.5D view' });
    const placement = layout.placements.find(
      (candidate) => candidate.id === 'bottom-hand:0',
    )!;
    const button = screen.getAllByRole('button')[0];
    // jsdom has no PointerEvent with coordinates; a MouseEvent of the same
    // native type reaches React's onPointerMove and carries clientX/Y.
    const pointerMove = (x: number, y: number) => {
      fireEvent(
        root,
        new MouseEvent('pointermove', {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
        }),
      );
    };

    // Right transparent margin: no hover, no lift.
    pointerMove(
      placement.gridX + placement.advanceRect.width + 1,
      placement.gridY + placement.advanceRect.height / 2,
    );
    expect(button.getAttribute('data-lifted')).toBe('false');

    // Body centre: lift, and the hitbox top follows by exactly 12 px.
    pointerMove(
      placement.gridX + placement.advanceRect.width / 2,
      placement.gridY + placement.advanceRect.height / 2,
    );
    expect(button.getAttribute('data-lifted')).toBe('true');
    expect(Number.parseFloat(button.style.top)).toBeCloseTo(placement.gridY - 12, 6);

    const lastCall = paint.mock.calls[paint.mock.calls.length - 1];
    const overlay = lastCall[2] as BoardRenderOverlay;
    expect(overlay.liftedIds?.has('bottom-hand:0')).toBe(true);

    fireEvent.pointerLeave(root);
    expect(button.getAttribute('data-lifted')).toBe('false');
  });

  it('clicks the correct tile with the dock index', async () => {
    const { onSelectTile } = renderBoard();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Discard R5m' }));
    expect(onSelectTile).toHaveBeenCalledWith('5m', 1);
  });

  it('focuses in hand order and Enter discards, with a focus/lift effect', async () => {
    const { onSelectTile } = renderBoard();
    const user = userEvent.setup();
    const buttons = screen.getAllByRole('button');

    await user.tab();
    expect(document.activeElement).toBe(buttons[0]);
    expect(buttons[0].getAttribute('data-lifted')).toBe('true');

    await user.keyboard('{Enter}');
    expect(onSelectTile).toHaveBeenCalledWith('1m', 0);
  });

  it('disables every hand button when answered or when discarding is illegal', () => {
    renderBoard({ answered: true });
    expect(
      screen.getAllByRole('button').every((button) => button.hasAttribute('disabled')),
    ).toBe(true);
    cleanup();

    renderBoard({ canDiscard: false });
    expect(
      screen.getAllByRole('button').every((button) => button.hasAttribute('disabled')),
    ).toBe(true);
  });

  it('gives every non-hand tile an accessible name and hides opponent faces', () => {
    renderBoard();
    const tiles = screen.getAllByRole('img');
    const expected = layout.placements.filter(
      (placement) =>
        !(
          placement.seat === 'bottom' &&
          placement.zone === 'hand' &&
          (placement.kind === 'hand' || placement.kind === 'draw')
        ),
    );
    expect(tiles).toHaveLength(expected.length);
    expect(tiles.every((tile) => (tile.getAttribute('aria-label') ?? '').length > 0)).toBe(
      true,
    );
    expect(screen.getByRole('group', { name: 'Shimocha concealed hand, 2 tiles' })).toBeTruthy();
    expect(screen.queryByRole('img', { name: /1p, concealed/ })).toBeNull();
  });

  it('announces the round, dora, seats and river markers', () => {
    renderBoard();
    expect(screen.getByText(/Round East 1, 0 honba/)).toBeTruthy();
    expect(screen.getByText(/Dora indicators: 1p/)).toBeTruthy();
    expect(screen.getByRole('group', { name: /your seat, at the bottom/ })).toBeTruthy();
    expect(screen.getByRole('img', { name: '2p, discard 1, tsumogiri' })).toBeTruthy();
  });
});
