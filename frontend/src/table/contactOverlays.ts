/**
 * Tile-to-tile contact shadows (Phase 3.5).
 *
 * `zoneLayout.ts` publishes `LayoutZone.bodies` in painter order. This module
 * derives the contact shadows between those bodies without changing the Phase 3
 * zone contract:
 *
 *   1. `contactEdges` finds every (neighbour body, later caster body, caster
 *      side) whose drawn body boxes overlap so that the caster's edge cuts into
 *      the neighbour. It is asset-free, so the bake can enumerate which decals
 *      any supported layout can ask for (the stress matrix in
 *      `frontend/scripts/export-overlays.ts`).
 *   2. `resolveContactOverlays` attaches the published decal for each edge,
 *      anchored to the caster's drawn body box and clipped to the neighbour's
 *      advance box.
 *
 * The compositor draws each overlay immediately after the body it is attached
 * to and before the caster's body: the caster covers the overlap, and the band
 * shades only the neighbour's exposed sliver.
 *
 * Why the caster's *body* silhouette and not `shadowShape`: the published blob
 * is a 1.15x rounded rectangle with a 40 px top trim and a 5/7 offset, i.e. the
 * cast shadow on the felt. A contact band must hug the visible bevel, so it is
 * baked from the shell PNG's alpha (see `tools/render/scripts/bake_overlays.mjs`).
 */
import type { ShellStats, ShellsManifest } from './shellManifest';
import { catchFor } from './catchManifest';
import type { CatchesManifest } from './catchManifest';
import type { OverlayDecal, OverlayManifest, OverlaySide } from './overlayManifest';
import { isOverlayEnabled, overlayDecalFor } from './overlayManifest';
import type { LayoutZone, PlacedTile } from './zoneLayout';

/** A caster edge only counts as a contact if this much of it overlaps. */
export const MIN_CONTACT_OVERLAP_PX = 4;
/** How far outside the caster edge the invisible-prune probes are placed. */
const PRUNE_PROBE_PX = 4;

/** Integer @1x drawn body box (the published advance box, not the texture). */
export interface BodyBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ContactEdge {
  /** Index in `zone.bodies` of the earlier body that receives the shadow. */
  readonly bodyIndex: number;
  /** Index in `zone.bodies` of the later body that casts it. */
  readonly casterIndex: number;
  /** The caster's screen edge in contact. */
  readonly side: OverlaySide;
  /** The neighbour's advance box; its body polygon is the actual clip. */
  readonly clip: BodyBox;
}

/** One resolved decal to draw after `zone.bodies[bodyIndex]`. */
export interface ContactOverlay {
  readonly bodyIndex: number;
  readonly casterIndex: number;
  /** The caster shell; for a catch the target is `zone.bodies[bodyIndex]`. */
  readonly shell: string;
  readonly contact: OverlaySide;
  /**
   * `band`: the synthetic per-caster-side decal in `overlays.json`.
   * `catch`: the target-space 3D catch in `catches.json`.
   */
  readonly kind: 'band' | 'catch';
  readonly textureFile: string;
  readonly textureFile2x: string;
  /** Integer @1x draw position in the zone's local space. */
  readonly drawX: number;
  readonly drawY: number;
  readonly texWidth: number;
  readonly texHeight: number;
  /**
   * Clip this decal to the neighbour's body: the advance box plus the published
   * inset convex hull, in zone-local @1x px. The polygon is what keeps the band
   * off the felt where an oblique body does not fill its box.
   */
  readonly clip: BodyBox & { readonly points: readonly (readonly [number, number])[] };
}

/** The drawn (opaque) body box of a placed tile, in zone-local @1x px. */
export function bodyBoxOf(tile: PlacedTile, shell: ShellStats): BodyBox {
  return {
    x: tile.drawX + shell.padding.left,
    y: tile.drawY + shell.padding.top,
    width: shell.advanceWidth,
    height: shell.advanceHeight,
  };
}

const overlaps = (
  left: number,
  right: number,
  otherLeft: number,
  otherRight: number,
): number => Math.min(right, otherRight) - Math.max(left, otherLeft);

const contains = (box: BodyBox, x: number, y: number): boolean =>
  x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height;

/**
 * All contact edges in a zone, grouped by the neighbour body they belong to.
 *
 * A side qualifies when the caster's edge lies strictly inside the neighbour's
 * drawn box and the edge and the neighbour's box overlap by at least
 * `MIN_CONTACT_OVERLAP_PX`. The same pair can qualify on two sides (the side
 * hand's L-shaped sliver), which is intentional.
 *
 * A decal that is certainly invisible is pruned: the three probe points just
 * outside the overlapping edge segment must not all be covered by a later
 * body's drawn box.
 */
export function contactEdges(
  manifest: ShellsManifest,
  zone: LayoutZone,
): ContactEdge[] {
  const shells = manifest.shells;
  const bodies = zone.bodies;
  const boxes = bodies.map((tile) => {
    const shell = shells[tile.shell];
    if (!shell) throw new Error(`contact overlays: shells.json has no ${tile.shell}`);
    return bodyBoxOf(tile, shell);
  });
  const edges: ContactEdge[] = [];

  for (let bodyIndex = 0; bodyIndex < bodies.length; bodyIndex += 1) {
    const target = boxes[bodyIndex];
    const targetRight = target.x + target.width;
    const targetBottom = target.y + target.height;
    for (let casterIndex = bodyIndex + 1; casterIndex < bodies.length; casterIndex += 1) {
      const caster = boxes[casterIndex];
      const casterRight = caster.x + caster.width;
      const casterBottom = caster.y + caster.height;
      const sides: OverlaySide[] = [];

      // The edge is a line; the perpendicular span is the overlap.
      if (
        caster.y > target.y &&
        caster.y < targetBottom &&
        overlaps(caster.x, casterRight, target.x, targetRight) >= MIN_CONTACT_OVERLAP_PX
      ) {
        sides.push('up');
      }
      if (
        casterBottom > target.y &&
        casterBottom < targetBottom &&
        overlaps(caster.x, casterRight, target.x, targetRight) >= MIN_CONTACT_OVERLAP_PX
      ) {
        sides.push('down');
      }
      if (
        caster.x > target.x &&
        caster.x < targetRight &&
        overlaps(caster.y, casterBottom, target.y, targetBottom) >= MIN_CONTACT_OVERLAP_PX
      ) {
        sides.push('left');
      }
      if (
        casterRight > target.x &&
        casterRight < targetRight &&
        overlaps(caster.y, casterBottom, target.y, targetBottom) >= MIN_CONTACT_OVERLAP_PX
      ) {
        sides.push('right');
      }

      for (const side of sides) {
        if (isHidden(side, caster, target, boxes, casterIndex)) continue;
        edges.push({
          bodyIndex,
          casterIndex,
          side,
          clip: clipFor(target),
        });
      }
    }
  }
  return edges;
}

/** The neighbour's advance box; the decal is clipped to its body polygon. */
function clipFor(target: BodyBox): BodyBox {
  return { ...target };
}

/**
 * Probe just outside the overlapping part of the caster's edge. If every probe
 * is inside a body drawn later than the caster, the decal's strongest region is
 * already covered and the decal is skipped.
 */function isHidden(
  side: OverlaySide,
  caster: BodyBox,
  target: BodyBox,
  boxes: readonly BodyBox[],
  casterIndex: number,
): boolean {
  const targetRight = target.x + target.width;
  const targetBottom = target.y + target.height;
  const probes: Array<readonly [number, number]> = [];
  if (side === 'up' || side === 'down') {
    const left = Math.max(caster.x, target.x);
    const right = Math.min(caster.x + caster.width, targetRight);
    const y = side === 'up' ? caster.y - PRUNE_PROBE_PX : caster.y + caster.height + PRUNE_PROBE_PX;
    for (const fraction of [0.2, 0.5, 0.8]) probes.push([left + (right - left) * fraction, y]);
  } else {
    const top = Math.max(caster.y, target.y);
    const bottom = Math.min(caster.y + caster.height, targetBottom);
    const x = side === 'left' ? caster.x - PRUNE_PROBE_PX : caster.x + caster.width + PRUNE_PROBE_PX;
    for (const fraction of [0.2, 0.5, 0.8]) probes.push([x, top + (bottom - top) * fraction]);
  }
  return probes.every(([x, y]) => {
    for (let later = casterIndex + 1; later < boxes.length; later += 1) {
      if (contains(boxes[later], x, y)) return true;
    }
    return false;
  });
}

/**
 * Resolve a zone's contact edges to published decals. Missing decals are
 * skipped; `validateOverlayCoverage` is the test-time gate that the committed
 * manifest covers every layout the engine can produce.
 */
export function resolveContactOverlays(
  manifest: ShellsManifest,
  overlays: OverlayManifest,
  zone: LayoutZone,
  catches?: CatchesManifest | null,
): ContactOverlay[] {
  const shells = manifest.shells;
  const resolved: ContactOverlay[] = [];
  const usedCatches = new Set<string>();
  for (const edge of contactEdges(manifest, zone)) {
    const target = zone.bodies[edge.bodyIndex];
    const caster = zone.bodies[edge.casterIndex];
    const shell = shells[caster.shell];
    if (!shell) continue;
    const neighbourShell = shells[target.shell];
    if (!neighbourShell) continue;
    const neighbourBox = bodyBoxOf(target, neighbourShell);
    const quad = overlays.bodyQuads[target.shell];
    const points: Array<readonly [number, number]> = quad
      ? quad.map(([x, y]) => [neighbourBox.x + x, neighbourBox.y + y] as const)
      : [
          [neighbourBox.x, neighbourBox.y] as const,
          [neighbourBox.x + neighbourBox.width, neighbourBox.y] as const,
          [neighbourBox.x + neighbourBox.width, neighbourBox.y + neighbourBox.height] as const,
          [neighbourBox.x, neighbourBox.y + neighbourBox.height] as const,
        ];
    const clip = { ...neighbourBox, points };

    // Prefer the target's 3D catch: it is baked for exactly this pair and is
    // already in the target's texture coordinates.
    const catchRecord = catchFor(catches, target.shell, caster.shell);
    if (catchRecord) {
      // One catch is baked for the immediate neighbour. A target can have
      // farther contacts with the same shell (the side hand's L); skip those
      // rather than stacking the same catch twice.
      const catchKey = `${edge.bodyIndex}:${caster.shell}`;
      if (usedCatches.has(catchKey)) continue;
      usedCatches.add(catchKey);
      // The catch is already target-space and its alpha is masked to the
      // target's opaque body. Do not use the inset hull used for the synthetic
      // bands: it would clip the shadow at the body edge and leave a bright
      // sliver on the target's bottom/side face. The full advance box is safe.
      const fullBox = {
        ...neighbourBox,
        points: [
          [neighbourBox.x, neighbourBox.y] as const,
          [neighbourBox.x + neighbourBox.width, neighbourBox.y] as const,
          [neighbourBox.x + neighbourBox.width, neighbourBox.y + neighbourBox.height] as const,
          [neighbourBox.x, neighbourBox.y + neighbourBox.height] as const,
        ],
      };
      resolved.push({
        bodyIndex: edge.bodyIndex,
        casterIndex: edge.casterIndex,
        shell: caster.shell,
        contact: edge.side,
        kind: 'catch',
        textureFile: catchRecord.textureFile,
        textureFile2x: catchRecord.textureFile2x,
        drawX: target.drawX,
        drawY: target.drawY,
        texWidth: catchRecord.texWidth,
        texHeight: catchRecord.texHeight,
        clip: fullBox,
      });
      continue;
    }

    const decal: OverlayDecal | null = overlayDecalFor(overlays, caster.shell, edge.side);
    if (!decal) continue;
    const casterBox = bodyBoxOf(caster, shell);
    resolved.push({
      bodyIndex: edge.bodyIndex,
      casterIndex: edge.casterIndex,
      shell: caster.shell,
      contact: edge.side,
      kind: 'band',
      textureFile: decal.textureFile,
      textureFile2x: decal.textureFile2x,
      drawX: casterBox.x + decal.bodyAnchorX,
      drawY: casterBox.y + decal.bodyAnchorY,
      texWidth: decal.texWidth,
      texHeight: decal.texHeight,
      clip,
    });
  }
  return resolved;
}

/** Every contact in `zones` that has no published decal. Empty is the goal. */
export function validateOverlayCoverage(
  manifest: ShellsManifest,
  overlays: OverlayManifest,
  zones: readonly LayoutZone[],
  catches?: CatchesManifest | null,
): string[] {
  const missing: string[] = [];
  for (const zone of zones) {
    for (const edge of contactEdges(manifest, zone)) {
      const target = zone.bodies[edge.bodyIndex];
      const caster = zone.bodies[edge.casterIndex];
      if (catchFor(catches, target.shell, caster.shell)) continue;
      if (!isOverlayEnabled(overlays, caster.shell)) continue;
      if (!overlayDecalFor(overlays, caster.shell, edge.side)) {
        missing.push(`${zone.id}: ${caster.shell} ${edge.side}`);
      }
    }
  }
  return missing;
}

/** Group resolved overlays by the body they are drawn after. */
export function overlaysByBody(
  overlays: readonly ContactOverlay[],
  bodyCount: number,
): ContactOverlay[][] {
  const grouped: ContactOverlay[][] = Array.from({ length: bodyCount }, () => []);
  for (const overlay of overlays) grouped[overlay.bodyIndex].push(overlay);
  return grouped;
}
