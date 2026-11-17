/**
 * The rendered table's accessible hit layer (Phase 4).
 *
 * The 2.5D board is one canvas: it has no semantic structure of its own. This
 * module turns a {@link Board} and its `GameState` into a plain data tree of
 * seats, zones, and tiles with the same names the top-down plan uses, plus the
 * published `hitBox` of every placed tile in board coordinates.
 *
 * `RenderedTable` renders the tree as absolutely positioned, transparent
 * elements over the canvas. They carry the ARIA labels (so the rendered view
 * reads the same as the top-down view) and the geometry Phase 5 will hit-test.
 * Positions stay in the zone's unrotated local space and the zone element
 * carries the lean, exactly as the compositor rotates the zone's layer.
 */
import { formatTileForDisplay } from '../display';
import { CALLED_FROM_LABELS, calledTile } from '../meld';
import { TABLE_SIDES, TABLE_SIDE_LABELS, tablePlacements } from '../seatOrder';
import type { TableSide } from '../seatOrder';
import type { GameState, PlayerState, Wind } from '../types/game';
import type { Board, BoardZone } from './boardLayout';
import { faceLabel } from './boardLayout';
import type { PlacedTile } from './zoneLayout';

export interface BoardHitTile {
  readonly bodyIndex: number;
  readonly label: string;
  /** Situational suffix for a tooltip; absent on ordinary tiles. */
  readonly note?: string;
  /** True on the newest discard of the seat being called/ronned. */
  readonly highlight: boolean;
  /** Board coordinates of the published advance box. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly shell: string;
  readonly face: string | null;
  readonly riichi: boolean;
}

export interface BoardHitZone {
  readonly id: string;
  readonly kind: BoardZone['zone']['kind'];
  /** The top-down name for this part of the seat, e.g. "You discards". */
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly rotationDeg: number;
  readonly pivotX: number;
  readonly pivotY: number;
  readonly tiles: readonly BoardHitTile[];
}

export interface BoardHitSection {
  readonly key: string;
  /** The seat this section belongs to; null for the shared walls. */
  readonly side: TableSide | null;
  readonly label: string;
  /** Seat index this section belongs to; null for the shared walls. */
  readonly seat: number | null;
  readonly zones: readonly BoardHitZone[];
}

export interface BoardCompassSeat {
  readonly side: TableSide;
  readonly label: string;
  readonly wind: Wind;
  readonly score: number;
  readonly riichi: boolean;
}

export interface BoardCompassOverlay {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly seats: readonly BoardCompassSeat[];
  readonly roundLabel: string;
  readonly roundWind: Wind;
  readonly handNumber: number;
  readonly tilesRemaining: number;
}

export interface BoardOverlay {
  readonly sections: readonly BoardHitSection[];
  readonly compass: BoardCompassOverlay;
}

const WIND_LETTERS: Record<Wind, string> = {
  East: 'E',
  South: 'S',
  West: 'W',
  North: 'N',
};

/** The single-letter compass glyph a wind shows in the centre. */
export function windLetter(wind: Wind): string {
  return WIND_LETTERS[wind];
}

/** The discard a pond tile came from, by its published grid cell. */
function discardAt(player: PlayerState, tile: PlacedTile) {
  const row = tile.cell?.row;
  const column = tile.cell?.column;
  if (row === undefined || column === undefined) return null;
  return player.discards[row * 6 + column] ?? null;
}

function tileHit(
  bodyIndex: number,
  tile: PlacedTile,
  label: string,
  note: string | undefined,
  placement: BoardZone,
  highlight = false,
): BoardHitTile {
  return {
    bodyIndex,
    label,
    ...(note === undefined ? {} : { note }),
    highlight,
    x: placement.x + tile.hitBox.x,
    y: placement.y + tile.hitBox.y,
    width: tile.hitBox.width,
    height: tile.hitBox.height,
    shell: tile.shell,
    face: tile.face,
    riichi: tile.riichi,
  };
}

function zoneTiles(
  placement: BoardZone,
  player: PlayerState | null,
  highlightSeat: number | null,
): BoardHitTile[] {
  const { zone } = placement;
  return zone.bodies.map((tile, index) => {
    if (zone.kind === 'pond' && player) {
      const discard = discardAt(player, tile);
      if (discard) {
        const row = tile.cell?.row ?? 0;
        const column = tile.cell?.column ?? 0;
        const discardIndex = row * 6 + column;
        const riichi =
          discard.is_riichi || player.riichi_discard_index === discardIndex;
        const label = formatTileForDisplay(discard.tile, discard.is_red === true);
        const notes: string[] = [];
        if (riichi) notes.push('riichi discard');
        if (discard.is_tsumogiri) notes.push('tsumogiri');
        const highlight =
          highlightSeat === player.seat && discardIndex === player.discards.length - 1;
        return tileHit(
          index,
          tile,
          label,
          notes.length ? notes.join(', ') : undefined,
          placement,
          highlight,
        );
      }
    }
    if (zone.kind === 'wall') {
      return tileHit(
        index,
        tile,
        tile.dora ? 'dora indicator' : 'face-down tile',
        undefined,
        placement,
      );
    }
    if (zone.kind === 'hand' && zone.side !== 'bottom') {
      return tileHit(index, tile, 'concealed tile', undefined, placement);
    }
    return tileHit(index, tile, faceLabel(tile.face), undefined, placement);
  });
}

const WALL_LABELS: Record<string, string> = {
  'wall-back': 'Back wall',
  'wall-front': 'Front wall',
  'wall-side-left': 'Left wall',
  'wall-side-right': 'Right wall',
};

function zoneLabel(
  placement: BoardZone,
  player: PlayerState | null,
): string {
  if (placement.zone.kind === 'wall') return WALL_LABELS[placement.id] ?? 'Wall';
  if (!player) return 'Table';
  if (placement.zone.kind === 'pond') return `${player.name} discards`;
  if (placement.zone.kind === 'melds') {
    const index = Number(placement.id.split('-').at(-1));
    const meld = Number.isInteger(index) ? player.melds[index] : undefined;
    if (meld) {
      const called = calledTile(meld, player.seat);
      return `${meld.meld_type} meld${
        called ? `, called tile taken from ${CALLED_FROM_LABELS[called.from]}` : ''
      }`;
    }
    return `${player.name} melds`;
  }
  return `${player.name} hand`;
}

function hitZone(
  placement: BoardZone,
  player: PlayerState | null,
  highlightSeat: number | null,
): BoardHitZone {
  const { zone } = placement;
  return {
    id: placement.id,
    kind: zone.kind,
    label: zoneLabel(placement, player),
    x: placement.x,
    y: placement.y,
    width: zone.width,
    height: zone.height,
    rotationDeg: zone.rotationDeg,
    pivotX: zone.pivotX,
    pivotY: zone.pivotY,
    tiles: zoneTiles(placement, player, highlightSeat),
  };
}

/**
 * Build the accessible tree and the hit boxes for a board.
 *
 * A seat section mirrors the top-down plan's nested groups: the section is
 * named "<side>, <player>", and each pond, hand, and meld keeps its own name.
 * The four walls are one shared section because they are not a seat. The
 * compass is a reserved centre box, not a zone.
 */
export function boardOverlay(
  board: Board,
  state: GameState,
  highlightSeat: number | null = null,
): BoardOverlay {
  const bySide = new Map<TableSide, PlayerState>();
  for (const placement of tablePlacements(state.players)) {
    bySide.set(placement.side, placement.player);
  }

  const sections: BoardHitSection[] = [];
  const wallZones: BoardHitZone[] = [];

  for (const side of TABLE_SIDES) {
    const player = bySide.get(side);
    const zones = board.zones.filter((placement) => placement.zone.side === side);
    if (!player || zones.length === 0) continue;
    sections.push({
      key: `seat-${side}`,
      side,
      label: `${TABLE_SIDE_LABELS[side]}, ${player.name}`,
      seat: player.seat,
      zones: zones.map((placement) => hitZone(placement, player, highlightSeat)),
    });
  }

  for (const placement of board.zones) {
    if (placement.zone.side === null) wallZones.push(hitZone(placement, null, highlightSeat));
  }
  if (wallZones.length > 0) {
    sections.push({
      key: 'walls',
      side: null,
      label: `Walls, ${state.tiles_remaining} tiles remaining`,
      seat: null,
      zones: wallZones,
    });
  }

  const compassSeats: BoardCompassSeat[] = [];
  for (const side of TABLE_SIDES) {
    const player = bySide.get(side);
    if (!player) continue;
    compassSeats.push({
      side,
      label: `${player.wind} wind, ${player.score} points${player.is_riichi ? ', riichi' : ''}`,
      wind: player.wind,
      score: player.score,
      riichi: player.is_riichi,
    });
  }

  return {
    sections,
    compass: {
      x: board.compass.x,
      y: board.compass.y,
      width: board.compass.width,
      height: board.compass.height,
      seats: compassSeats,
      roundLabel: `Round ${state.round_wind} ${state.hand_number}, ${state.tiles_remaining} tiles remaining`,
      roundWind: state.round_wind,
      handNumber: state.hand_number,
      tilesRemaining: state.tiles_remaining,
    },
  };
}
