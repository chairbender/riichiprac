/**
 * Interaction hit testing for the 3D table (3D-08).
 *
 * The canvas is a picture; every tile a user can act on is a DOM `<button>`
 * positioned over it. This module is the bridge: it takes the same
 * {@link BoardLayout} the renderer draws and the same {@link CameraFrame} the
 * renderer solves — 3D-06's `boardLayout.frameForAspect`, never a second camera
 * — and projects the interactive tiles' oriented boxes to CSS rectangles.
 *
 * It is **pure**: no three.js, no DOM, no clock. That is what lets the overlay be
 * unit-tested in Node while the renderer owns the matrices (plan §7 D9), and it
 * is why the drift test can project the hand OBBs independently and compare.
 *
 * Geometry:
 *
 * - A tile's rect is the axis-aligned projection of its body's eight corners,
 *   so it covers exactly what the viewer sees.
 * - A tile may not be smaller than {@link MIN_HIT_TARGET_PX} per axis, so a
 *   touch target stays usable on a small screen. The expansion is clamped to the
 *   tile's **cell** — its own share of the hand row (or the draw's slot plus
 *   half the tsumogiri gap) — so two neighbouring buttons never overlap: a
 *   phone whose tiles project below 44 px gets the largest non-overlapping
 *   target rather than a wrong one.
 * - Only the human seat's concealed hand and draw are interactive. The same
 *   rule as the top-down view, where the river, melds and walls are pictures and
 *   only `HandDock` holds buttons.
 */

import type { HitRect } from '../contract';
import { HAND, TILE } from '../layoutConstants';
import {
  orientedBox,
  orientedBoxCorners,
  poseAxes,
  projectPoint,
  projectToPixels,
} from './boardLayout';
import type {
  BoardLayout,
  BoardTile,
  CameraFrame,
  OrientedBox,
  Vec3,
} from './boardLayout';

/** The smallest CSS-px touch target the overlay aims for. */
export const MIN_HIT_TARGET_PX = 44;

/** The CSS size of the stage the frame is projected into. */
export interface HitTestViewport {
  readonly widthPx: number;
  readonly heightPx: number;
}

/** Options for {@link hitRects}. */
export interface HitTestOptions {
  /** True once the hand is answered: nothing is interactive. */
  readonly locked?: boolean;
  /** Override {@link MIN_HIT_TARGET_PX} (tests and constrained stages). */
  readonly minTargetPx?: number;
}

/** A CSS-pixel rectangle, before it becomes a {@link HitRect}. */
export interface ProjectedRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Project one oriented box to the CSS rectangle that bounds it.
 *
 * Returns null when any corner is at or behind the camera: a perspective
 * projection of such a point is meaningless, and a hand is never there in the
 * shipped frames. Skipping is safer than drawing a button across the screen.
 */
export function projectedBoxRect(
  box: OrientedBox,
  frame: CameraFrame,
  viewport: HitTestViewport,
): ProjectedRect | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const corner of orientedBoxCorners(box)) {
    if (!(projectPoint(corner, frame).depth > 0)) return null;
    const pixel = projectToPixels(corner, frame, viewport.widthPx, viewport.heightPx);
    minX = Math.min(minX, pixel.x);
    minY = Math.min(minY, pixel.y);
    maxX = Math.max(maxX, pixel.x);
    maxY = Math.max(maxY, pixel.y);
  }
  if (!(maxX > minX) || !(maxY > minY)) return null;
  return { left: minX, top: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * A hand tile's **cell**: the body's own box, widened along the tile's local X
 * to the hand row's pitch (or the draw's slot plus half the tsumogiri gap on
 * each side).
 *
 * Everything inside the cell belongs to this tile and nothing else does, which
 * is what makes the 44 px expansion safe: it can grow into felt the neighbouring
 * button will never claim.
 */
export function handTileCell(tile: BoardTile): OrientedBox {
  const halfWidth =
    tile.zone === 'draw'
      ? (HAND.drawGapUnits + TILE.widthUnits) / 2
      : HAND.pitchUnits / 2;
  const axes = poseAxes(tile.pose);
  const half: Vec3 = [
    halfWidth,
    tile.pose.sizeUnits[1] / 2,
    tile.pose.sizeUnits[2] / 2,
  ];
  return { centre: tile.pose.position, axes, halfExtents: half };
}

/** Grow `rect` about its centre until both sides reach `minPx`. */
function inflateToMinimum(rect: ProjectedRect, minPx: number): ProjectedRect {
  const width = Math.max(rect.width, minPx);
  const height = Math.max(rect.height, minPx);
  return {
    left: rect.left - (width - rect.width) / 2,
    top: rect.top - (height - rect.height) / 2,
    width,
    height,
  };
}

/** The overlapping rectangle, or null when the two do not meet. */
function intersect(
  a: ProjectedRect,
  b: ProjectedRect,
): ProjectedRect | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  if (!(right > left) || !(bottom > top)) return null;
  return { left, top, width: right - left, height: bottom - top };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Pull a rect's right edge in to `x`, never below its left edge. */
function clampRight(rect: ProjectedRect, x: number): ProjectedRect {
  const right = Math.min(rect.left + rect.width, x);
  return { ...rect, width: Math.max(0, right - rect.left) };
}

/** Pull a rect's left edge in to `x`, never past its right edge. */
function clampLeft(rect: ProjectedRect, x: number): ProjectedRect {
  const left = Math.max(rect.left, x);
  const right = rect.left + rect.width;
  return { ...rect, left, width: Math.max(0, right - left) };
}

/** Pull a rect's bottom edge up to `y`, never above its top edge. */
function clampBottom(rect: ProjectedRect, y: number): ProjectedRect {
  const bottom = Math.min(rect.top + rect.height, y);
  return { ...rect, height: Math.max(0, bottom - rect.top) };
}

/** Pull a rect's top edge down to `y`, never past its bottom edge. */
function clampTop(rect: ProjectedRect, y: number): ProjectedRect {
  const top = Math.max(rect.top, y);
  const bottom = rect.top + rect.height;
  return { ...rect, top, height: Math.max(0, bottom - top) };
}

/**
 * Split adjacent tiles at the midpoint of their projected centres.
 *
 * Perspective makes one tile's near corner project past a neighbour's far
 * corner, so two touching bodies' axis-aligned bounds overlap by a few pixels
 * even though the bodies do not. The shared world plane is exactly halfway
 * between their centres, so that midpoint is inside both cells; splitting there
 * keeps every button on its own tile and leaves no pair of targets overlapping.
 * The hand row is a straight line, so only consecutive slots need the check.
 */
function separateNeighbours(
  entries: readonly { rect: ProjectedRect; centre: { x: number; y: number } }[],
): ProjectedRect[] {
  const rects = entries.map((entry) => entry.rect);
  for (let index = 0; index + 1 < entries.length; index += 1) {
    const left = entries[index];
    const right = entries[index + 1];
    const dx = right.centre.x - left.centre.x;
    const dy = right.centre.y - left.centre.y;
    if (Math.abs(dx) >= Math.abs(dy)) {
      const x = (left.centre.x + right.centre.x) / 2;
      if (dx >= 0) {
        rects[index] = clampRight(rects[index], x);
        rects[index + 1] = clampLeft(rects[index + 1], x);
      } else {
        rects[index] = clampLeft(rects[index], x);
        rects[index + 1] = clampRight(rects[index + 1], x);
      }
    } else {
      const y = (left.centre.y + right.centre.y) / 2;
      if (dy >= 0) {
        rects[index] = clampBottom(rects[index], y);
        rects[index + 1] = clampTop(rects[index + 1], y);
      } else {
        rects[index] = clampTop(rects[index], y);
        rects[index + 1] = clampBottom(rects[index + 1], y);
      }
    }
  }
  return rects;
}

/**
 * The interactive tiles of a board, projected to CSS rects.
 *
 * Returned in the hand's slot order (concealed, then the draw). An answered hand
 * returns an empty list: the top-down view disables its buttons at that point,
 * and the 3D overlay removes them so no stale target can submit twice.
 */
export function hitRects(
  layout: BoardLayout,
  frame: CameraFrame,
  viewport: HitTestViewport,
  options: HitTestOptions = {},
): readonly HitRect[] {
  if (options.locked === true) return [];
  if (!(viewport.widthPx > 0) || !(viewport.heightPx > 0)) return [];

  const minTargetPx = options.minTargetPx ?? MIN_HIT_TARGET_PX;
  const human = layout.humanSeat;
  const tiles = layout.tiles
    .filter(
      (tile) =>
        tile.seat === human && (tile.zone === 'hand' || tile.zone === 'draw'),
    )
    .sort((left, right) =>
      left.zone === right.zone
        ? left.slot - right.slot
        : left.zone === 'hand'
          ? -1
          : 1,
    );

  const rects: HitRect[] = [];
  const entries: { tile: BoardTile; rect: ProjectedRect; centre: { x: number; y: number } }[] = [];
  for (const tile of tiles) {
    const body = projectedBoxRect(orientedBox(tile.pose), frame, viewport);
    if (!body) continue;
    const cell = projectedBoxRect(handTileCell(tile), frame, viewport);
    if (!cell) continue;
    // Grow toward the 44 px target but never past the tile's own cell: a small
    // screen keeps its buttons inside their slots instead of overlapping.
    const target = intersect(inflateToMinimum(body, minTargetPx), cell) ?? body;
    entries.push({
      tile,
      rect: target,
      centre: projectToPixels(
        tile.pose.position,
        frame,
        viewport.widthPx,
        viewport.heightPx,
      ),
    });
  }

  const separated = separateNeighbours(entries);
  entries.forEach((entry, index) => {
    const target = separated[index];
    if (!(target.width > 0) || !(target.height > 0)) return;
    // Round the two edges, not the width: two neighbours that shared an edge
    // still share it after rounding, so the no-overlap rule survives the
    // two-decimal CSS values.
    const left = round(target.left);
    const top = round(target.top);
    rects.push({
      seat: human,
      zone: entry.tile.zone as 'hand' | 'draw',
      slot: entry.tile.slot,
      face: entry.tile.face,
      left,
      top,
      width: round(target.left + target.width) - left,
      height: round(target.top + target.height) - top,
    });
  });
  return rects;
}
