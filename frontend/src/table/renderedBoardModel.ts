/**
 * Phase 5 view model for the rendered board: which tiles lift, which are
 * tinted/shimmered, where the Riichi sticks sit, the hand-button labels, and
 * the accessible table description.
 *
 * This is pure data derived from the `GameState` and the Phase 3 layout. The
 * React shell reads it; the renderer only consumes the `BoardRenderOverlay`.
 * Keeping it here means the DOM hitboxes and the painted overlays cannot
 * disagree about which tile is selected or dora, and the scripted checks can
 * assert the same ids the component uses.
 */
import { formatTileForDisplay } from '../display';
import { TABLE_SIDES, tablePlacements } from '../seatOrder';
import type { TableSide } from '../seatOrder';
import type { GameState, PlayerState } from '../types/game';
import type { BoardLayout, SeatSide, TilePlacement } from './boardLayout';
import {
  DEFAULT_LIFT_PX,
  handTileSlot,
} from './boardInteraction';
import type { BoardRenderOverlay } from './boardRenderer';
import type { TileTint } from './boardOverlays';
import { doraCodesForState } from './dora';
import { riichiStickMarkers, type RiichiStickMarker } from './boardMarkers';
import { FACE_UP_SHELL_IDS, isRedFiveFace, tileCodeOfFace } from './tiles';

/** Same wording as the top-down plan view's seat labels. */
const SIDE_LABELS: Record<TableSide, string> = {
  bottom: 'your seat, at the bottom',
  right: 'right side, shimocha',
  top: 'across, toimen',
  left: 'left side, kamicha',
};

/** Tint palette. One tint wins per tile, in the priority order below. */
const TINTS = {
  answerCorrect: { color: '#2f9e44', alpha: 0.34 },
  answerIncorrect: { color: '#e03131', alpha: 0.3 },
  selected: { color: '#74c0fc', alpha: 0.34 },
  claimed: { color: '#ffd43b', alpha: 0.3 },
  tsumogiri: { color: '#101820', alpha: 0.16 },
  hover: { color: '#ffffff', alpha: 0.1 },
} as const;

export interface RenderedHandButton {
  readonly placementId: string;
  readonly tile: string;
  /** Index into `[...hand, draw]`, matching the dock. */
  readonly index: number;
  readonly label: string;
  readonly disabled: boolean;
  readonly isDraw: boolean;
}

export interface RenderedA11yItem {
  readonly id: string;
  readonly label: string;
}

export interface RenderedA11yGroup {
  readonly id: string;
  readonly label: string;
  readonly items: readonly RenderedA11yItem[];
}

export interface RenderedA11ySeat {
  readonly side: SeatSide;
  readonly label: string;
  readonly groups: readonly RenderedA11yGroup[];
}

export interface RenderedA11yModel {
  readonly label: string;
  readonly summary: readonly string[];
  readonly seats: readonly RenderedA11ySeat[];
  readonly markers: readonly string[];
}

export interface RenderedBoardModelInput {
  readonly layout: BoardLayout;
  readonly state: GameState;
  readonly hoveredId: string | null;
  readonly selectedId: string | null;
  readonly answered: boolean;
  readonly canDiscard: boolean;
  readonly callRiichi: boolean;
  readonly callKan: boolean;
  readonly highlightLastDiscard: number | null;
  /** Placement of the submitted tile, once answered. */
  readonly answerPlacementId: string | null;
  /** Whether the submitted tile was correct, for the answered tint. */
  readonly answerCorrect: boolean | null;
}

export interface RenderedBoardModel {
  readonly overlay: BoardRenderOverlay;
  readonly buttons: readonly RenderedHandButton[];
  readonly markers: readonly RiichiStickMarker[];
  readonly a11y: RenderedA11yModel;
}

/** The human player in a table, or null for a malformed payload. */
export function humanPlayer(state: GameState): PlayerState | null {
  return state.players.find((player) => player.is_human) ?? null;
}

/** Player lookup by rendered table side, using the shared seat order. */
export function playersBySide(
  state: GameState,
): ReadonlyMap<SeatSide, PlayerState> {
  const players = new Map<SeatSide, PlayerState>();
  for (const placement of tablePlacements(state.players)) {
    players.set(placement.side, placement.player);
  }
  return players;
}

/**
 * The human's hand buttons in dock order (the hand, then the draw), so Tab and
 * screen-reader order match the top-down view even though the renderer paints
 * the row right-to-left.
 */
export function renderedHandButtons(
  layout: BoardLayout,
  player: PlayerState,
  options: {
    readonly answered: boolean;
    readonly canDiscard: boolean;
    readonly callRiichi: boolean;
    readonly callKan: boolean;
  },
): readonly RenderedHandButton[] {
  const slots = layout.placements
    .filter(
      (placement) =>
        placement.seat === 'bottom' &&
        placement.zone === 'hand' &&
        (placement.kind === 'hand' || placement.kind === 'draw'),
    )
    .map((placement) => {
      const slot = handTileSlot(placement, player);
      return slot ? { placement, slot } : null;
    })
    .filter(
      (entry): entry is { placement: TilePlacement; slot: NonNullable<ReturnType<typeof handTileSlot>> } =>
        entry !== null,
    )
    .sort((left, right) => left.slot.index - right.slot.index);

  return slots.map(({ placement, slot }) => ({
    placementId: placement.id,
    tile: slot.tile,
    index: slot.index,
    label: handButtonLabel(placement, slot.tile, options),
    disabled: options.answered || !options.canDiscard,
    isDraw: slot.isDraw,
  }));
}

/** The dock's exact accessible naming, including the armed Riichi/Kan suffix. */
export function handButtonLabel(
  placement: TilePlacement,
  tile: string,
  options: { readonly callRiichi: boolean; readonly callKan: boolean },
): string {
  const displayed = formatTileForDisplay(tile, isRedFiveFace(placement.face));
  const action = options.callKan ? `Declare Kan on ${displayed}` : `Discard ${displayed}`;
  return `${action}${options.callRiichi ? ', with Riichi' : ''}`;
}

const FACE_UP_SHELL_SET: ReadonlySet<string> = new Set(FACE_UP_SHELL_IDS);

/** True for the faces the shimmer applies to: dora, and every aka five. */
export function isShimmerFace(
  placement: TilePlacement,
  doraCodes: ReadonlySet<string>,
): boolean {
  if (!FACE_UP_SHELL_SET.has(placement.shell)) return false;
  if (isRedFiveFace(placement.face)) return true;
  return doraCodes.has(tileCodeOfFace(placement.face));
}

function tintFor(
  placement: TilePlacement,
  input: RenderedBoardModelInput,
  players: ReadonlyMap<SeatSide, PlayerState>,
): TileTint | null {
  if (input.answerPlacementId === placement.id && input.answerCorrect !== null) {
    const tint = input.answerCorrect ? TINTS.answerCorrect : TINTS.answerIncorrect;
    return { id: placement.id, color: tint.color, alpha: tint.alpha };
  }
  if (input.selectedId === placement.id) {
    return {
      id: placement.id,
      color: TINTS.selected.color,
      alpha: TINTS.selected.alpha,
    };
  }

  if (placement.zone === 'pond') {
    const player = players.get(placement.seat);
    const index = pondIndex(placement);
    const discard = index === null ? null : player?.discards[index];
    if (discard) {
      const claimed =
        input.highlightLastDiscard === player?.seat &&
        index === player.discards.length - 1;
      if (claimed) {
        return {
          id: placement.id,
          color: TINTS.claimed.color,
          alpha: TINTS.claimed.alpha,
        };
      }
      if (discard.is_tsumogiri) {
        return {
          id: placement.id,
          color: TINTS.tsumogiri.color,
          alpha: TINTS.tsumogiri.alpha,
        };
      }
    }
  }

  if (!input.answered && input.hoveredId === placement.id) {
    return {
      id: placement.id,
      color: TINTS.hover.color,
      alpha: TINTS.hover.alpha,
    };
  }
  return null;
}

function pondIndex(placement: TilePlacement): number | null {
  const match = /-pond:(\d+)$/.exec(placement.id);
  return match ? Number(match[1]) : null;
}

function meldParts(
  placement: TilePlacement,
): { meldIndex: number; tileIndex: number } | null {
  const match = /-meld:(\d+):(\d+)$/.exec(placement.id);
  if (!match) return null;
  return { meldIndex: Number(match[1]), tileIndex: Number(match[2]) };
}

function faceLabel(placement: TilePlacement): string {
  return formatTileForDisplay(
    tileCodeOfFace(placement.face),
    isRedFiveFace(placement.face),
  );
}

function concealedItems(
  layout: BoardLayout,
  side: SeatSide,
  includeFaces: boolean,
): RenderedA11yItem[] {
  const placements = layout.placements
    .filter(
      (placement) =>
        placement.seat === side &&
        placement.zone === 'hand' &&
        (placement.kind === 'hand' || placement.kind === 'draw'),
    )
    .sort((left, right) => {
      const leftDraw = left.kind === 'draw' ? 1 : 0;
      const rightDraw = right.kind === 'draw' ? 1 : 0;
      if (leftDraw !== rightDraw) return leftDraw - rightDraw;
      return left.id.localeCompare(right.id, undefined, { numeric: true });
    });

  return placements.map((placement, index) => ({
    id: placement.id,
    label: includeFaces
      ? `${index + 1}. ${faceLabel(placement)}`
      : `Concealed tile ${index + 1}`,
  }));
}

function meldItems(
  layout: BoardLayout,
  side: SeatSide,
  player: PlayerState | undefined,
): RenderedA11yItem[] {
  return layout.placements
    .filter((placement) => placement.seat === side && placement.kind === 'meld')
    .map((placement) => {
      const parts = meldParts(placement);
      const meld = parts ? player?.melds[parts.meldIndex] : undefined;
      const kind = meld?.meld_type ? `${meld.meld_type} meld` : 'Called meld';
      return {
        id: placement.id,
        label: `${kind}, ${faceLabel(placement)}`,
      };
    });
}

function pondItems(
  layout: BoardLayout,
  side: SeatSide,
  player: PlayerState | undefined,
  highlightLastDiscard: number | null,
): RenderedA11yItem[] {
  return layout.placements
    .filter((placement) => placement.seat === side && placement.zone === 'pond')
    .sort((left, right) => (pondIndex(left) ?? 0) - (pondIndex(right) ?? 0))
    .map((placement) => {
      const index = pondIndex(placement) ?? 0;
      const discard = player?.discards[index];
      const displayed = discard
        ? formatTileForDisplay(discard.tile, discard.is_red === true)
        : faceLabel(placement);
      const flags = [
        discard?.is_riichi || player?.riichi_discard_index === index
          ? 'riichi declaration'
          : '',
        discard?.is_tsumogiri ? 'tsumogiri' : '',
        highlightLastDiscard === player?.seat &&
        index === (player?.discards.length ?? 0) - 1
          ? 'being claimed'
          : '',
      ].filter(Boolean);
      return {
        id: placement.id,
        label: `${displayed}, discard ${index + 1}${
          flags.length > 0 ? `, ${flags.join(', ')}` : ''
        }`,
      };
    });
}

function wallItems(layout: BoardLayout, side: SeatSide): RenderedA11yItem[] {
  const order = { lower: 0, upper: 1 } as const;
  return layout.placements
    .filter((placement) => placement.seat === side && placement.zone === 'wall')
    .sort((left, right) => {
      const leftTier = order[left.kind === 'wall-upper' ? 'upper' : 'lower'];
      const rightTier = order[right.kind === 'wall-upper' ? 'upper' : 'lower'];
      if (leftTier !== rightTier) return leftTier - rightTier;
      return left.id.localeCompare(right.id, undefined, { numeric: true });
    })
    .map((placement, index) => ({
      id: placement.id,
      label: `Wall tile, ${
        placement.kind === 'wall-upper' ? 'upper' : 'lower'
      } tier ${index + 1}`,
    }));
}

function summaryLines(state: GameState): string[] {
  const dora = [...doraCodesForState(state)].sort();
  const lines = [
    `Round ${state.round_wind} ${state.hand_number}, ${state.honba} honba, ${state.tiles_remaining} tiles remaining.`,
    `${state.riichi_sticks ?? 0} riichi sticks on the table.`,
    state.dora_indicators.length > 0
      ? `Dora indicators: ${state.dora_indicators
          .map((tile) => formatTileForDisplay(tile))
          .join(', ')}. Dora: ${dora.length > 0 ? dora.join(', ') : 'none'}.`
      : 'No dora indicators.',
  ];
  return lines;
}

/**
 * Build the whole Phase 5 view model. Pure and deterministic: the component
 * calls it on every render, and tests/review scripts call it with the same
 * inputs to assert the painted ids.
 */
export function buildRenderedBoardModel(
  input: RenderedBoardModelInput,
): RenderedBoardModel {
  const { layout, state } = input;
  const players = playersBySide(state);
  const player = humanPlayer(state);
  const doraCodes = doraCodesForState(state);

  const selectedId = input.answerPlacementId ?? input.selectedId;
  const liftedIds = new Set<string>();
  if (selectedId) liftedIds.add(selectedId);
  if (!input.answered && input.hoveredId) liftedIds.add(input.hoveredId);

  const tints: TileTint[] = [];
  for (const placement of layout.placements) {
    const tint = tintFor(placement, input, players);
    if (tint) tints.push(tint);
  }

  const shimmerIds = new Set<string>();
  for (const placement of layout.placements) {
    if (isShimmerFace(placement, doraCodes)) shimmerIds.add(placement.id);
  }

  const riichiSides = [...players.entries()]
    .filter(([, seatPlayer]) => seatPlayer.is_riichi)
    .map(([side]) => side);
  const markers = riichiStickMarkers(layout.metrics.zones.reserve, {
    riichiSides,
    potSticks: state.riichi_sticks ?? 0,
  });

  const seats: RenderedA11ySeat[] = [];
  for (const side of TABLE_SIDES) {
    const seatPlayer = players.get(side);
    if (!seatPlayer) continue;
    const isHuman = seatPlayer.is_human;
    const groups: RenderedA11yGroup[] = [];

    const concealed = isHuman ? [] : concealedItems(layout, side, false);
    if (concealed.length > 0) {
      groups.push({
        id: `${side}-concealed`,
        label: `${seatPlayer.name} concealed hand, ${concealed.length} tiles`,
        items: concealed,
      });
    }

    const melds = meldItems(layout, side, seatPlayer);
    if (melds.length > 0) {
      groups.push({
        id: `${side}-melds`,
        label: `${seatPlayer.name} melds`,
        items: melds,
      });
    }

    const pond = pondItems(
      layout,
      side,
      seatPlayer,
      input.highlightLastDiscard,
    );
    if (pond.length > 0) {
      groups.push({
        id: `${side}-pond`,
        label: `${seatPlayer.name} discards`,
        items: pond,
      });
    }

    const walls = wallItems(layout, side);
    if (walls.length > 0) {
      groups.push({
        id: `${side}-wall`,
        label: `${seatPlayer.name} wall`,
        items: walls,
      });
    }

    seats.push({
      side,
      label: `${SIDE_LABELS[side]}, ${seatPlayer.name}, ${
        seatPlayer.wind
      } wind, ${seatPlayer.score.toLocaleString('en-US')} points${
        seatPlayer.is_riichi ? ', riichi' : ''
      }`,
      groups,
    });
  }

  const markersA11y: string[] = [];
  if (riichiSides.length > 0) {
    markersA11y.push(
      `Riichi declared by ${riichiSides
        .map((side) => players.get(side)?.name ?? side)
        .join(', ')}.`,
    );
  }
  if ((state.riichi_sticks ?? 0) > 0) {
    markersA11y.push(
      `${state.riichi_sticks} riichi stick${
        state.riichi_sticks === 1 ? '' : 's'
      } in the pot.`,
    );
  }

  return {
    overlay: {
      liftedIds,
      liftPx: DEFAULT_LIFT_PX,
      tints,
      shimmerIds,
      markers,
    },
    buttons: player
      ? renderedHandButtons(layout, player, {
          answered: input.answered,
          canDiscard: input.canDiscard,
          callRiichi: input.callRiichi,
          callKan: input.callKan,
        })
      : [],
    markers,
    a11y: {
      label: 'Table, rendered 2.5D view',
      summary: summaryLines(state),
      seats,
      markers: markersA11y,
    },
  };
}
