// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { RenderedTable } from './RenderedTable';
import { parseShellsManifest } from '../table/shellManifest';
import type { GameState, PlayerState } from '../types/game';
import type { TileAtlas } from '../table/TileAtlas';
import type { RenderedTableAssets } from '../table/renderedAssets';

const tableDir = join(process.cwd(), 'public/table');
const shells = parseShellsManifest(
  JSON.parse(readFileSync(join(tableDir, 'shells.json'), 'utf8')),
);

function player(seat: number, overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    seat,
    name: `Seat ${seat}`,
    is_human: seat === 0,
    wind: 'East',
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
  dora_indicators: [],
  ura_dora_indicators: [],
  tiles_remaining: 60,
  current_turn: 0,
  players: [
    player(0, { hand: ['1m'], draw: '2m' }),
    player(1, { hand: ['1p'] }),
    player(2, { hand: ['1s'] }),
    player(3, { hand: ['1z'] }),
  ],
};

const assets: RenderedTableAssets = {
  atlas: { shells } as unknown as TileAtlas,
  felt: {} as CanvasImageSource,
};

let getContext: { mockRestore: () => void };

beforeEach(() => {
  getContext = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue({} as CanvasRenderingContext2D);
});

afterEach(() => {
  cleanup();
  getContext.mockRestore();
});

function props(overrides: Partial<Parameters<typeof RenderedTable>[0]> = {}) {
  return {
    state,
    answered: false,
    canDiscard: true,
    callRiichi: false,
    callKan: false,
    highlightLastDiscard: null,
    submittedAnswer: null,
    answerCorrect: null,
    onSelectTile: vi.fn(),
    onFallback: vi.fn(),
    measureViewport: () => ({ width: 712, height: 704 }),
    ...overrides,
  };
}

describe('rendered table loader', () => {
  it('renders the fitted board and its hand controls on success', async () => {
    const onFallback = vi.fn();
    const paint = vi.fn(() => undefined);
    render(
      <RenderedTable
        {...props({ onFallback })}
        loadAssets={async () => assets}
        buildOverlayAssets={() => ({ liftShadow: null, shimmer: null })}
        paint={paint}
      >
        <span>Dock controls</span>
      </RenderedTable>,
    );

    await waitFor(() => expect(screen.getAllByRole('button')).toHaveLength(2));
    expect(onFallback).not.toHaveBeenCalled();
    expect(screen.getByText('Dock controls')).toBeTruthy();
    expect(paint).toHaveBeenCalled();
    const [context, layout] = paint.mock.calls[0] as unknown as [
      CanvasRenderingContext2D,
      { board: { width: number; height: number } },
    ];
    expect(context).toBeTruthy();
    expect(layout.board).toEqual({ width: 712, height: 704 });
  });

  it('falls back to the top-down plan when assets fail', async () => {
    const onFallback = vi.fn();
    render(
      <RenderedTable
        {...props({ onFallback })}
        loadAssets={async () => {
          throw new Error('felt 404');
        }}
      />,
    );

    await waitFor(() => expect(onFallback).toHaveBeenCalledWith('felt 404'));
    expect(screen.getByRole('status').textContent).toContain(
      'showing the top-down plan',
    );
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it('falls back when the 2D paint fails (missing sprite or dead context)', async () => {
    const onFallback = vi.fn();
    render(
      <RenderedTable
        {...props({ onFallback })}
        loadAssets={async () => assets}
        buildOverlayAssets={() => ({ liftShadow: null, shimmer: null })}
        paint={() => {
          throw new Error('sprite not baked');
        }}
      />,
    );

    await waitFor(() =>
      expect(onFallback).toHaveBeenCalledWith('sprite not baked'),
    );
  });

  it('does not call the fallback while loading', () => {
    const onFallback = vi.fn();
    render(
      <RenderedTable
        {...props({ onFallback })}
        loadAssets={() => new Promise<RenderedTableAssets>(() => undefined)}
      />,
    );
    expect(screen.getByRole('status').textContent).toContain(
      'Loading rendered table',
    );
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('uses no WebGL, 3D library or dynamic blur in the view path', () => {
    for (const file of [
      'src/components/RenderedBoard.tsx',
      'src/components/RenderedTable.tsx',
      'src/table/boardOverlays.ts',
      'src/table/boardRenderer.ts',
    ]) {
      const source = readFileSync(join(process.cwd(), file), 'utf8');
      expect(source).not.toMatch(
        /getContext\(['"]webgl|WebGLRenderingContext|from ['"]three|from ['"]babylon|shadowBlur|filter\s*=/i,
      );
    }
  });
});
