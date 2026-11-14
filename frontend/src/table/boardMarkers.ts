/**
 * Riichi-stick markers for the rendered table.
 *
 * The compass is deferred (architecture §6.3): its centre region is reserved,
 * not modelled. Riichi declarations must still be visible, so each player who
 * has declared gets one stick on their side of that reserve, and the pot's
 * neutral sticks sit in the middle. These are 2D marker rectangles, not a
 * compass UI, and they paint with the pond epoch so they can never appear on
 * top of the bottom wall or the human's hand.
 */
import type { BoardRect, SeatSide } from './boardLayout';

export type RiichiMarkerKind = 'riichi' | 'pot';

export interface RiichiStickMarker {
  readonly id: string;
  readonly kind: RiichiMarkerKind;
  readonly seat: SeatSide | null;
  /** Centre of the stick in board px. */
  readonly centerX: number;
  readonly centerY: number;
  /** Long axis before rotation, in board px. */
  readonly length: number;
  /** Short axis, in board px. */
  readonly thickness: number;
  /** Clockwise screen rotation around the centre. */
  readonly rotationDeg: 0 | 90;
}

/** Length/thickness of one marker, in board px. */
export const RICHI_STICK_LENGTH_PX = 20;
export const RICHI_STICK_THICKNESS_PX = 5;
/** Distance of a declaration stick's centre from the reserve edge. */
export const RICHI_STICK_INSET_PX = 10;
/** Gap between pot sticks in the middle of the reserve. */
export const POT_STICK_GAP_PX = 23;
/** The pot never draws more than this many sticks; the menu shows the count. */
export const MAX_DRAWN_POT_STICKS = 4;

export interface RiichiMarkerInput {
  /** Sides whose player has declared Riichi, in any order. */
  readonly riichiSides: readonly SeatSide[];
  /** Neutral 1000-point sticks in the pot. */
  readonly potSticks: number;
}

/**
 * Place the declaration and pot sticks inside the reserved compass region.
 * Every marker stays inside the reserve, so the marker layer needs no collision
 * handling with walls, ponds or hands.
 */
export function riichiStickMarkers(
  reserve: BoardRect,
  input: RiichiMarkerInput,
): readonly RiichiStickMarker[] {
  const markers: RiichiStickMarker[] = [];
  const centreX = reserve.x + reserve.width / 2;
  const centreY = reserve.y + reserve.height / 2;
  const longAxis = RICHI_STICK_LENGTH_PX;

  const sidePosition: Record<
    SeatSide,
    { x: number; y: number; rotationDeg: 0 | 90 }
  > = {
    top: {
      x: centreX,
      y: reserve.y + RICHI_STICK_INSET_PX,
      rotationDeg: 0,
    },
    bottom: {
      x: centreX,
      y: reserve.y + reserve.height - RICHI_STICK_INSET_PX,
      rotationDeg: 0,
    },
    left: {
      x: reserve.x + RICHI_STICK_INSET_PX,
      y: centreY,
      rotationDeg: 90,
    },
    right: {
      x: reserve.x + reserve.width - RICHI_STICK_INSET_PX,
      y: centreY,
      rotationDeg: 90,
    },
  };

  // Stable seat order, independent of the caller's array ordering.
  for (const seat of ['bottom', 'right', 'top', 'left'] as const) {
    if (!input.riichiSides.includes(seat)) continue;
    const position = sidePosition[seat];
    markers.push({
      id: `riichi:${seat}`,
      kind: 'riichi',
      seat,
      centerX: position.x,
      centerY: position.y,
      length: longAxis,
      thickness: RICHI_STICK_THICKNESS_PX,
      rotationDeg: position.rotationDeg,
    });
  }

  const potCount = Math.max(
    0,
    Math.min(MAX_DRAWN_POT_STICKS, Math.floor(input.potSticks)),
  );
  for (let index = 0; index < potCount; index += 1) {
    markers.push({
      id: `pot:${index}`,
      kind: 'pot',
      seat: null,
      centerX: centreX + (index - (potCount - 1) / 2) * POT_STICK_GAP_PX,
      centerY: centreY,
      length: longAxis,
      thickness: RICHI_STICK_THICKNESS_PX,
      rotationDeg: 0,
    });
  }

  return markers;
}

function roundedRectPath(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

/**
 * Paint one 1000-point stick marker: an ivory bar with the red centre band and
 * a one-pixel down-right drop, rotated around its centre for the side seats.
 * No blur, gradient or shadow call is involved.
 */
export function paintRiichiStick(
  context: CanvasRenderingContext2D,
  marker: RiichiStickMarker,
): void {
  const halfLength = marker.length / 2;
  const halfThickness = marker.thickness / 2;

  context.save();
  try {
    context.translate(marker.centerX, marker.centerY);
    context.rotate((marker.rotationDeg * Math.PI) / 180);

    // Baked-style contact shadow, offset down-right like the shell margins.
    context.fillStyle = 'rgba(0, 0, 0, 0.42)';
    roundedRectPath(
      context,
      -halfLength + 1,
      -halfThickness + 1.5,
      marker.length,
      marker.thickness,
      1.5,
    );
    context.fill();

    context.fillStyle = '#f3e7c8';
    roundedRectPath(
      context,
      -halfLength,
      -halfThickness,
      marker.length,
      marker.thickness,
      1.5,
    );
    context.fill();
    context.strokeStyle = 'rgba(35, 28, 18, 0.55)';
    context.lineWidth = 0.75;
    context.stroke();

    // The red centre band is what makes the bar read as a Riichi stick.
    context.fillStyle = '#b3352e';
    context.fillRect(
      -1.5,
      -halfThickness + 0.75,
      3,
      marker.thickness - 1.5,
    );
  } finally {
    context.restore();
  }
}
