/**
 * Phase 4 painter's-algorithm board renderer.
 *
 * The renderer is deliberately dumb: it takes the Phase 3 layout and the
 * startup atlas and blits, in order, with no Z-buffer, no depth test, no
 * dynamic shadow and no runtime 3D. Every visual decision (order, projection,
 * shadow, seam) was made offline; the frame loop is `drawImage` per tile.
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
 * Each tile is `blitTileSprite(ctx, page, sprite, gridX, gridY)`: the atlas UV
 * rect is drawn at `grid - anchor` with the @1x logical size, so the shared
 * sprite serves a touching neighbour and an isolated tile without any adjacency
 * special-casing. Glyph rotation lives in the atlas (the shell's `faceQuad`),
 * never here.
 */
import type { TileAtlas } from './TileAtlas';
import { blitTileSprite } from './TileAtlas';
import { tileRenderKey } from './tiles';
import { fitBoardToViewport } from './boardLayout';
import type { BoardFit, BoardSize, TilePlacement } from './boardLayout';

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
 * the numbers the review script prints (fit, tile count, order ends).
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

    // 3. Tiles, strictly back-to-front.
    const tiles = paintOrder(board);
    for (const placement of tiles) {
      const sprite = atlas.getSprite(tileRenderKey(placement.shell, placement.face));
      blitTileSprite(context, atlas.getPage(sprite), sprite, placement.gridX, placement.gridY);
    }

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
    };
  } finally {
    context.restore();
  }
}
