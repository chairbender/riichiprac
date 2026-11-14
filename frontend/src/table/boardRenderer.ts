/**
 * Phase 4 painter's-algorithm board renderer, extended by Phase 5 with the
 * hover lift and the clipped overlay passes.
 *
 * The renderer is deliberately dumb: it takes the Phase 3 layout and the
 * startup atlas and blits, in order, with no Z-buffer, no depth test, no
 * dynamic shadow and no runtime 3D. Every visual decision (order, projection,
 * shadow, seam) was made offline; the frame loop is `drawImage` per tile plus a
 * few constant-alpha overlay blits.
 *
 * ## Draw order
 *
 * {@link paintOrder} returns the placements sorted by their contiguous
 * `drawOrder` and throws on a duplicate or a gap, so a board can never paint
 * two tiles in the same slot or silently skip one. The layout engine already
 * emits the architecture §4.1 zone order (felt → top hand/melds → top wall →
 * side walls → ponds → bottom wall → side hands → bottom hand/melds) and the
 * §4.2 intra-zone order; the renderer only follows it.
 *
 * Phase 5's markers are inserted at the pond epoch: after the last pond tile
 * and before the bottom wall. The secondary lift shadow is inserted just before
 * the first lifted tile, so neighbouring hand bodies paint over it. Overlay
 * tints and shimmer are painted immediately after their own tile, so a later
 * neighbour can still cover the pair exactly as it covers the sprite.
 *
 * ## Full-screen felt
 *
 * The felt is a separate full-screen raster: the canvas is cleared, the felt is
 * stretched over the entire canvas (`100% 100%`, {@link FELT_RUNTIME}), and the
 * board is then contained and centred on top ({@link fitBoardToViewport}). The
 * vignette therefore hugs the real screen edges at any aspect ratio, and no
 * table edge, rail or apron exists. Rendering at different viewports only
 * changes the fit; the board, its order and the sprites are identical.
 *
 * ## Sprite blits
 *
 * Each tile is `blitTileSprite(ctx, page, sprite, gridX, gridY - lift)`: the
 * atlas UV rect is drawn at `grid - anchor`, so the shared sprite serves a
 * touching neighbour and an isolated tile without any adjacency special-casing.
 * Glyph rotation lives in the atlas (the shell's `faceQuad`), never here, and
 * the lift moves the whole sprite (including its baked margin) without
 * re-compositing or rotating it.
 */
import type { TileAtlas } from './TileAtlas';
import { blitTileSprite } from './TileAtlas';
import { tileRenderKey } from './tiles';
import { fitBoardToViewport } from './boardLayout';
import type { BoardFit, BoardSize, TilePlacement } from './boardLayout';
import {
  DEFAULT_LIFT_PX,
  LIFT_SHADOW_SPREAD_PX,
} from './boardInteraction';
import {
  paintLiftShadow,
  paintShimmer,
  paintTint,
} from './boardOverlays';
import type {
  LiftShadowAsset,
  ShimmerAsset,
  TileTint,
} from './boardOverlays';
import { paintRiichiStick } from './boardMarkers';
import type { RiichiStickMarker } from './boardMarkers';

/** The part of a layout the renderer needs: any ordered, static board. */
export interface PaintableBoard {
  readonly board: BoardSize;
  readonly placements: readonly TilePlacement[];
}

/** One entry of the draw-order audit trail. */
export interface PaintOrderEntry {
  readonly id: string;
  readonly shell: string;
  readonly face: string;
  readonly gridX: number;
  readonly gridY: number;
}

/**
 * Phase 5 interaction state to paint over the board. All sets are by placement
 * id; the renderer never decides *which* tile is hovered, dora or tsumogiri.
 */
export interface BoardRenderOverlay {
  /** Placements drawn `liftPx` higher, and given a secondary baseline shadow. */
  readonly liftedIds?: ReadonlySet<string>;
  /** Upward draw offset in board px. Defaults to {@link DEFAULT_LIFT_PX}. */
  readonly liftPx?: number;
  /** Flat tints, each clipped to its tile's face plate. */
  readonly tints?: readonly TileTint[];
  /** Placements that get the additive dora/akadora sweep. */
  readonly shimmerIds?: ReadonlySet<string>;
  /** Riichi declaration/pot sticks, painted at the pond epoch. */
  readonly markers?: readonly RiichiStickMarker[];
}

export interface BoardRenderOptions {
  /**
   * The full-screen felt raster (`frontend/public/table/felt.png`). When it is
   * absent the renderer fills {@link BoardRenderOptions.feltColor} instead, so
   * tests and a failed asset fetch still show a board on a dark table.
   */
  readonly felt?: CanvasImageSource | null;
  /** Felt fallback colour when no raster is supplied. */
  readonly feltColor?: string;
  /**
   * Device pixels per CSS px. The canvas is expected to be sized in device
   * pixels; the renderer maps the board into CSS px and scales by this.
   */
  readonly pixelRatio?: number;
  /** Phase 5 interaction overlay. */
  readonly overlay?: BoardRenderOverlay;
  /** Startup-baked secondary shadow for lifted tiles. */
  readonly liftShadow?: LiftShadowAsset | null;
  /** Startup-baked additive sweep for dora/akadora tiles. */
  readonly shimmer?: ShimmerAsset | null;
}

export interface BoardRenderStats {
  readonly feltPainted: boolean;
  readonly tiles: number;
  /** Viewport in CSS px (canvas size divided by the pixel ratio). */
  readonly viewport: BoardSize;
  readonly fit: BoardFit;
  readonly board: BoardSize;
  readonly firstTileId: string | null;
  readonly lastTileId: string | null;
  /** True when the felt covered the whole canvas, i.e. no transparent corner. */
  readonly feltCoversCanvas: boolean;
  readonly liftedTiles: number;
  readonly tintedTiles: number;
  readonly shimmerTiles: number;
  readonly markers: number;
  /** The pond/bottom-wall boundary the marker epoch sits between. */
  readonly markerZone: {
    readonly afterId: string | null;
    readonly beforeId: string | null;
  };
}

const DEFAULT_FELT_COLOR = '#15503a';

/**
 * The placements in paint order. Throws on a duplicated or missing
 * `drawOrder`: a painter's algorithm is only deterministic if the order is a
 * permutation of `0 … n-1`.
 */
export function paintOrder(board: PaintableBoard): readonly TilePlacement[] {
  const ordered = [...board.placements].sort((left, right) => left.drawOrder - right.drawOrder);
  ordered.forEach((placement, index) => {
    if (placement.drawOrder !== index) {
      throw new Error(
        `paint order is not a permutation: slot ${index} holds drawOrder ${placement.drawOrder} (${placement.id})`,
      );
    }
  });
  return ordered;
}

/**
 * The ordered tile keys/positions of a board, for the committed paint-order
 * fixture and the review dump. Values are rounded to 1e-3 for a stable diff;
 * the layout itself keeps full precision.
 */
export function paintOrderSnapshot(board: PaintableBoard): readonly PaintOrderEntry[] {
  const round = (value: number): number => Math.round(value * 1000) / 1000;
  return paintOrder(board).map((placement) => ({
    id: placement.id,
    shell: placement.shell,
    face: placement.face,
    gridX: round(placement.gridX),
    gridY: round(placement.gridY),
  }));
}

/**
 * Paint a full board onto a canvas.
 *
 * The canvas is the whole viewport: the felt is stretched across it, then the
 * board transform is applied and every tile is blitted in paint order. Returns
 * the numbers the review script prints (fit, tile count, order ends, overlay
 * counts and the marker epoch).
 */
export function renderBoard(
  context: CanvasRenderingContext2D,
  atlas: TileAtlas,
  board: PaintableBoard,
  options: BoardRenderOptions = {},
): BoardRenderStats {
  const pixelRatio = options.pixelRatio ?? 1;
  const canvas = context.canvas;
  const canvasWidth = canvas.width;
  const canvasHeight = canvas.height;
  const viewport: BoardSize = {
    width: canvasWidth / pixelRatio,
    height: canvasHeight / pixelRatio,
  };
  const overlay = options.overlay ?? {};
  const liftPx = overlay.liftPx ?? DEFAULT_LIFT_PX;
  const lifted = overlay.liftedIds ?? EMPTY_IDS;
  const shimmerIds = overlay.shimmerIds ?? EMPTY_IDS;
  const tintsById = new Map<string, TileTint>();
  for (const tint of overlay.tints ?? []) tintsById.set(tint.id, tint);
  const markers = overlay.markers ?? [];

  let liftedTiles = 0;
  let tintedTiles = 0;
  let shimmerTiles = 0;

  context.save();
  try {
    // 1. Full-screen felt, stretched to the real screen edges (§6.4).
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvasWidth, canvasHeight);
    const felt = options.felt ?? null;
    if (felt) {
      context.drawImage(felt, 0, 0, canvasWidth, canvasHeight);
    } else {
      context.fillStyle = options.feltColor ?? DEFAULT_FELT_COLOR;
      context.fillRect(0, 0, canvasWidth, canvasHeight);
    }

    // 2. The board layer: contain and centre the fixed board in the viewport.
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    const fit = fitBoardToViewport(viewport, board.board);
    context.translate(fit.offsetX, fit.offsetY);
    context.scale(fit.scale, fit.scale);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';

    // 3. Tiles, strictly back-to-front, with the Phase 5 insertions.
    const tiles = paintOrder(board);
    const lastPondOrder = lastOrderOf(tiles, (placement) => placement.zone === 'pond');
    const markerOrder = lastPondOrder + 1;
    const shadowOrder = firstLiftedOrder(tiles, lifted);
    let markersPainted = markers.length === 0;
    let shadowsPainted = shadowOrder < 0;

    const paintMarkers = (): void => {
      if (markersPainted) return;
      for (const marker of markers) paintRiichiStick(context, marker);
      markersPainted = true;
    };
    const paintShadows = (): void => {
      if (shadowsPainted || !options.liftShadow) return;
      for (const placement of tiles) {
        if (!lifted.has(placement.id)) continue;
        paintLiftShadow(
          context,
          placement,
          atlas.shells.shells[placement.shell],
          options.liftShadow,
          LIFT_SHADOW_SPREAD_PX,
        );
      }
      shadowsPainted = true;
    };

    if (markerOrder <= 0) paintMarkers();
    if (shadowOrder <= 0) paintShadows();

    for (let index = 0; index < tiles.length; index += 1) {
      if (index === markerOrder) paintMarkers();
      if (index === shadowOrder) paintShadows();

      const placement = tiles[index];
      const shell = atlas.shells.shells[placement.shell];
      const lift = lifted.has(placement.id) ? liftPx : 0;
      if (lift !== 0) liftedTiles += 1;

      const sprite = atlas.getSprite(tileRenderKey(placement.shell, placement.face));
      blitTileSprite(
        context,
        atlas.getPage(sprite),
        sprite,
        placement.gridX,
        placement.gridY - lift,
      );

      const tint = tintsById.get(placement.id);
      if (tint) {
        paintTint(context, placement, shell, tint, lift);
        tintedTiles += 1;
      }
      if (shimmerIds.has(placement.id) && options.shimmer) {
        paintShimmer(context, placement, shell, options.shimmer, lift);
        shimmerTiles += 1;
      }
    }

    if (!markersPainted) paintMarkers();
    if (!shadowsPainted) paintShadows();

    return {
      feltPainted: true,
      tiles: tiles.length,
      viewport,
      fit,
      board: board.board,
      firstTileId: tiles[0]?.id ?? null,
      lastTileId: tiles[tiles.length - 1]?.id ?? null,
      // The felt/fill covers the whole canvas by construction; the review
      // script asserts the pixels rather than trusting this flag.
      feltCoversCanvas: true,
      liftedTiles,
      tintedTiles,
      shimmerTiles,
      markers: markers.length,
      markerZone: {
        afterId: markerOrder > 0 ? (tiles[markerOrder - 1]?.id ?? null) : null,
        beforeId: tiles[markerOrder]?.id ?? null,
      },
    };
  } finally {
    context.restore();
  }
}

const EMPTY_IDS: ReadonlySet<string> = new Set();

function lastOrderOf(
  tiles: readonly TilePlacement[],
  predicate: (placement: TilePlacement) => boolean,
): number {
  for (let index = tiles.length - 1; index >= 0; index -= 1) {
    if (predicate(tiles[index])) return index;
  }
  return -1;
}

function firstLiftedOrder(
  tiles: readonly TilePlacement[],
  lifted: ReadonlySet<string>,
): number {
  if (lifted.size === 0) return -1;
  for (let index = 0; index < tiles.length; index += 1) {
    if (lifted.has(tiles[index].id)) return index;
  }
  return -1;
}
