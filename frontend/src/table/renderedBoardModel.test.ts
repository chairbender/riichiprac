import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { boardLayoutFromState } from './boardFromState';
import { parseShellsManifest } from './shellManifest';
import {
  buildRenderedBoardModel,
  handButtonLabel,
  isShimmerFace,
  renderedHandButtons,
} from './renderedBoardModel';
import type { GameState, PlayerState } from '../types/game';

const tableDir = fileURLToPath(new URL('../../public/table/', import.meta.url));
const shells = parseShellsManifest(
  JSON.parse(readFileSync(join(tableDir, 'shells.json'), 'utf8')),
);

function player(
  seat: number,
  overrides: Partial<PlayerState> = {},
): PlayerState {
  return {
    seat,
    name: ['You', 'Shimocha', 'Toimen', 'Kamicha'][seat] ?? `Seat ${seat}`,
    is_human: seat === 0,
    wind: (['East', 'South', 'West', 'North'] as const)[seat] ?? 'East',
    score: 25000 + seat * 1000,
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
  hand_number: 2,
  honba: 1,
  riichi_sticks: 2,
  dora_indicators: ['4m', '1p'],
  ura_dora_indicators: [],
  tiles_remaining: 48,
  current_turn: 0,
  players: [
    player(0, {
      hand: ['1m', '5m'],
      draw: '3m',
      red_fives: ['5m'],
      discards: [
        { tile: '2p', is_riichi: false, is_tsumogiri: true },
        { tile: '7z', is_riichi: true, is_tsumogiri: false },
      ],
      is_riichi: true,
      riichi_discard_index: 1,
    }),
    player(1, {
      hand: ['1p', '2p', '3p'],
      discards: [
        { tile: '9s', is_riichi: false, is_tsumogiri: false },
        { tile: '6s', is_riichi: false, is_tsumogiri: false },
      ],
    }),
    player(2, {
      hand: ['1z', '1z'],
      melds: [{ meld_type: 'Chi', tiles: ['1s', '2s', '3s'], called_from: 0 }],
      discards: [{ tile: '5p', is_riichi: false, is_tsumogiri: false }],
    }),
    player(3, {
      hand: ['9m'],
      discards: [{ tile: '1p', is_riichi: false, is_tsumogiri: false }],
    }),
  ],
};

const layout = boardLayoutFromState(shells, state);

function model(overrides: Partial<Parameters<typeof buildRenderedBoardModel>[0]> = {}) {
  return buildRenderedBoardModel({
    layout,
    state,
    hoveredId: null,
    selectedId: null,
    answered: false,
    canDiscard: true,
    callRiichi: false,
    callKan: false,
    highlightLastDiscard: null,
    answerPlacementId: null,
    answerCorrect: null,
    ...overrides,
  });
}

describe('rendered hand buttons', () => {
  it('orders buttons like the dock and uses the dock labels', () => {
    const buttons = renderedHandButtons(layout, state.players[0], {
      answered: false,
      canDiscard: true,
      callRiichi: false,
      callKan: false,
    });
    expect(buttons.map((button) => button.placementId)).toEqual([
      'bottom-hand:0',
      'bottom-hand:1',
      'bottom-hand:draw',
    ]);
    expect(buttons.map((button) => button.label)).toEqual([
      'Discard 1m',
      'Discard R5m',
      'Discard 3m',
    ]);
    expect(buttons.map((button) => button.index)).toEqual([0, 1, 2]);
    expect(buttons.every((button) => !button.disabled)).toBe(true);
  });

  it('adds the armed Riichi/Kan wording and disables when the dock would', () => {
    const buttons = renderedHandButtons(layout, state.players[0], {
      answered: false,
      canDiscard: true,
      callRiichi: true,
      callKan: true,
    });
    expect(buttons[0].label).toBe('Declare Kan on 1m, with Riichi');

    const answered = renderedHandButtons(layout, state.players[0], {
      answered: true,
      canDiscard: true,
      callRiichi: false,
      callKan: false,
    });
    expect(answered.every((button) => button.disabled)).toBe(true);

    const noDiscard = renderedHandButtons(layout, state.players[0], {
      answered: false,
      canDiscard: false,
      callRiichi: false,
      callKan: false,
    });
    expect(noDiscard.every((button) => button.disabled)).toBe(true);
  });

  it('names a red five exactly as the dock does', () => {
    const placement = layout.placements.find(
      (candidate) => candidate.id === 'bottom-hand:1',
    )!;
    expect(
      handButtonLabel(placement, '5m', { callRiichi: false, callKan: false }),
    ).toBe('Discard R5m');
  });
});

describe('rendered board model', () => {
  it('lifts the hovered/selected hand tile and tints it', () => {
    const hovered = model({ hoveredId: 'bottom-hand:0' });
    expect(hovered.overlay.liftedIds?.has('bottom-hand:0')).toBe(true);
    expect(
      hovered.overlay.tints?.some((tint) => tint.id === 'bottom-hand:0'),
    ).toBe(true);

    const answered = model({
      answered: true,
      hoveredId: 'bottom-hand:0',
      answerPlacementId: 'bottom-hand:1',
      answerCorrect: false,
    });
    expect(answered.overlay.liftedIds?.has('bottom-hand:0')).toBe(false);
    expect(answered.overlay.liftedIds?.has('bottom-hand:1')).toBe(true);
    const answerTint = answered.overlay.tints?.find(
      (tint) => tint.id === 'bottom-hand:1',
    );
    expect(answerTint?.color).toBe('#e03131');
  });

  it('tints tsumogiri and the claimed last discard', () => {
    const tsumogiri = model().overlay.tints?.find(
      (tint) => tint.id === 'bottom-pond:0',
    );
    expect(tsumogiri?.color).toBe('#101820');

    const claimed = model({ highlightLastDiscard: 1 }).overlay.tints?.find(
      (tint) => tint.id === 'right-pond:1',
    );
    expect(claimed?.color).toBe('#ffd43b');
  });

  it('shimmers dora and aka fives only on face-up shells', () => {
    const doraCodes = new Set(['5m', '2p']);
    const red = layout.placements.find(
      (placement) => placement.id === 'bottom-hand:1',
    )!;
    const dora = layout.placements.find(
      (placement) => placement.id === 'bottom-pond:0',
    )!;
    const back = layout.placements.find(
      (placement) => placement.zone === 'wall',
    )!;
    expect(isShimmerFace(red, doraCodes)).toBe(true);
    expect(isShimmerFace(dora, doraCodes)).toBe(true);
    expect(isShimmerFace(back, doraCodes)).toBe(false);

    const shimmer = model().overlay.shimmerIds;
    expect(shimmer?.has('bottom-hand:1')).toBe(true);
    expect(shimmer?.has('bottom-pond:0')).toBe(true);
    // An opponent's concealed hand is a blue back: no glyph, no shimmer.
    expect(shimmer?.has('right-hand:1')).toBe(false);
    expect([...(shimmer ?? [])].some((id) => id.includes('-wall:'))).toBe(false);
  });

  it('places declaration and pot sticks inside the reserved compass region', () => {
    const built = model();
    const reserve = layout.metrics.zones.reserve;
    expect(built.markers.map((marker) => marker.id)).toEqual([
      'riichi:bottom',
      'pot:0',
      'pot:1',
    ]);
    for (const marker of built.markers) {
      const halfLength = marker.length / 2;
      const halfThickness = marker.thickness / 2;
      const halfWidth = marker.rotationDeg === 90 ? halfThickness : halfLength;
      const halfHeight = marker.rotationDeg === 90 ? halfLength : halfThickness;
      expect(marker.centerX - halfWidth).toBeGreaterThanOrEqual(reserve.x);
      expect(marker.centerX + halfWidth).toBeLessThanOrEqual(
        reserve.x + reserve.width,
      );
      expect(marker.centerY - halfHeight).toBeGreaterThanOrEqual(reserve.y);
      expect(marker.centerY + halfHeight).toBeLessThanOrEqual(
        reserve.y + reserve.height,
      );
    }
  });
});

describe('rendered accessibility model', () => {
  it('names every non-hand placement, grouped by seat and zone', () => {
    const a11y = model().a11y;
    const items = a11y.seats.flatMap((seat) =>
      seat.groups.flatMap((group) => group.items),
    );
    const expected = layout.placements.filter(
      (placement) =>
        !(
          placement.seat === 'bottom' &&
          placement.zone === 'hand' &&
          (placement.kind === 'hand' || placement.kind === 'draw')
        ),
    );
    expect(items).toHaveLength(expected.length);
    expect(new Set(items.map((item) => item.id))).toEqual(
      new Set(expected.map((placement) => placement.id)),
    );
    expect(items.every((item) => item.label.trim().length > 0)).toBe(true);
  });

  it('never names an opponent concealed face', () => {
    const a11y = model().a11y;
    const rightHand = a11y.seats.find((seat) => seat.side === 'right')!;
    const concealed = rightHand.groups.find(
      (group) => group.id === 'right-concealed',
    )!;
    expect(concealed.items.map((item) => item.label)).toEqual([
      'Concealed tile 1',
      'Concealed tile 2',
      'Concealed tile 3',
    ]);
    expect(JSON.stringify(concealed)).not.toContain('1p');
  });

  it('carries the top-down seat, river, dora and round information', () => {
    const a11y = model().a11y;
    const bottom = a11y.seats.find((seat) => seat.side === 'bottom')!;
    expect(bottom.label).toContain('your seat, at the bottom');
    expect(bottom.label).toContain('East wind');
    expect(bottom.label).toContain('riichi');

    const pond = bottom.groups.find((group) => group.id === 'bottom-pond')!;
    expect(pond.items[0].label).toBe(
      '2p, discard 1, tsumogiri',
    );
    expect(pond.items[1].label).toBe(
      'R, discard 2, riichi declaration',
    );

    expect(a11y.summary.join(' ')).toContain('Round East 2');
    expect(a11y.summary.join(' ')).toContain('Dora indicators: 4m, 1p');
    expect(a11y.markers.join(' ')).toContain('Riichi declared by You');
    expect(a11y.markers.join(' ')).toContain('2 riichi sticks in the pot');
  });
});
