/**
 * Phase 5 overlay art: the secondary lift shadow, tint and shimmer passes, and
 * their strict clipping.
 *
 * Everything expensive is built **once at startup**:
 *
 *  - the lift shadow is the standing shell's own alpha silhouette, blacked out
 *    with `source-in`, so a hovered tile casts a wider, softer version of the
 *    shadow it already bakes. Per frame it is one `drawImage` with a constant
 *    alpha and scale — no blur, no filter, no new canvas;
 *  - the dora/akadora sweep is one 64 × 64 diagonal ramp, blitted with
 *    `lighter` and stretched over the face. No gradient is created per frame.
 *
 * ## Clipping
 *
 * The shell texture has a transparent shadow/AO margin to the right and bottom.
 * A tint or shimmer must never touch it: both passes clip to the published
 * `faceQuad`, inset by {@link FACE_CLIP_INSET_PX} so canvas antialiasing cannot
 * leave a partial pixel on the quad's outer edge. The clip is the face plate,
 * so the bevel and the margin are untouched by construction.
 */
import { LIFT_SHADOW_SPREAD_PX } from './boardInteraction';
import type { TilePlacement } from './boardLayout';
import { tileRenderKey } from './tiles';
import type { TileAtlas } from './TileAtlas';
import type { AtlasCanvas, CreateAtlasCanvas } from './TileAtlasBuilder';
import type { FaceQuad, PointPx, ShellStats } from './shellManifest';

/** One flat tint, clipped to a tile's face. */
export interface TileTint {
  readonly id: string;
  /** Any CSS colour; alpha comes from {@link TileTint.alpha}. */
  readonly color: string;
  readonly alpha?: number;
}

export interface LiftShadowAsset {
  readonly image: CanvasImageSource;
  /** Logical width/height of the source sprite, in @1x px. */
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  /** Constant alpha the renderer blits the silhouette with. */
  readonly alpha: number;
}

export interface ShimmerAsset {
  readonly image: CanvasImageSource;
}

/** Clip inset inside the faceQuad, in board px. */
export const FACE_CLIP_INSET_PX = 0.75;
/** Max alpha of the baked shimmer ramp. */
export const SHIMMER_RAMP_ALPHA = 0.24;
/** Alpha the renderer blits the shimmer with. */
export const SHIMMER_DRAW_ALPHA = 0.55;
/** Constant alpha of the secondary lift shadow. */
export const LIFT_SHADOW_ALPHA = 0.28;

/** Board-space corners of a placement's face plate, including its lift. */
export function faceQuadInBoard(
  placement: TilePlacement,
  shell: ShellStats,
  liftPx = 0,
  insetPx = 0,
): FaceQuad {
  const quad = insetPx > 0 ? insetFaceQuad(shell.faceQuad, insetPx) : shell.faceQuad;
  const x = placement.drawX;
  const y = placement.drawY - liftPx;
  return quad.map(([qx, qy]) => [x + qx, y + qy] as PointPx) as unknown as FaceQuad;
}

/** Move every faceQuad corner toward the centroid, so a clip never sits on an edge. */
export function insetFaceQuad(quad: FaceQuad, insetPx: number): FaceQuad {
  if (insetPx <= 0) return quad;
  const centreX = (quad[0][0] + quad[1][0] + quad[2][0] + quad[3][0]) / 4;
  const centreY = (quad[0][1] + quad[1][1] + quad[2][1] + quad[3][1]) / 4;
  return quad.map(([x, y]) => {
    const dx = x - centreX;
    const dy = y - centreY;
    const distance = Math.hypot(dx, dy);
    if (distance === 0) return [x, y] as PointPx;
    const scale = Math.max(0, (distance - insetPx) / distance);
    return [centreX + dx * scale, centreY + dy * scale] as PointPx;
  }) as unknown as FaceQuad;
}

/** Build a closed path for a board-space quad and clip to it. */
export function clipToQuad(
  context: CanvasRenderingContext2D,
  quad: readonly PointPx[],
): void {
  context.beginPath();
  context.moveTo(quad[0][0], quad[0][1]);
  for (let index = 1; index < quad.length; index += 1) {
    context.lineTo(quad[index][0], quad[index][1]);
  }
  context.closePath();
  context.clip();
}

function quadBounds(quad: readonly PointPx[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of quad) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Paint one flat tint, clipped to the face plate. Uses the current transform,
 * so it must run while the renderer is inside the board transform.
 */
export function paintTint(
  context: CanvasRenderingContext2D,
  placement: TilePlacement,
  shell: ShellStats,
  tint: TileTint,
  liftPx = 0,
): void {
  const quad = faceQuadInBoard(placement, shell, liftPx, FACE_CLIP_INSET_PX);
  const bounds = quadBounds(quad);
  context.save();
  try {
    clipToQuad(context, quad);
    context.globalAlpha = tint.alpha ?? 1;
    context.fillStyle = tint.color;
    context.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
  } finally {
    context.restore();
  }
}

/**
 * Paint the additive specular sweep, masked to the face plate. The pre-baked
 * ramp is stretched across the face; `lighter` adds light instead of replacing
 * the glyph, so the ink stays legible.
 */
export function paintShimmer(
  context: CanvasRenderingContext2D,
  placement: TilePlacement,
  shell: ShellStats,
  shimmer: ShimmerAsset,
  liftPx = 0,
): void {
  const quad = faceQuadInBoard(placement, shell, liftPx, FACE_CLIP_INSET_PX);
  const bounds = quadBounds(quad);
  context.save();
  try {
    clipToQuad(context, quad);
    context.globalCompositeOperation = 'lighter';
    context.globalAlpha = SHIMMER_DRAW_ALPHA;
    context.drawImage(
      shimmer.image,
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
    );
  } finally {
    context.restore();
  }
}

/**
 * Paint the wider secondary shadow at the tile's **baseline** body, under a
 * lifted tile. The asset is the standing shell's silhouette, so it is only used
 * for the human hand's shell; callers only lift that shell.
 */
export function paintLiftShadow(
  context: CanvasRenderingContext2D,
  placement: TilePlacement,
  shell: ShellStats,
  shadow: LiftShadowAsset,
  spreadPx = LIFT_SHADOW_SPREAD_PX,
): void {
  context.save();
  try {
    context.globalAlpha = shadow.alpha;
    context.drawImage(
      shadow.image,
      placement.drawX - spreadPx,
      placement.drawY + spreadPx / 2,
      shell.texWidth + spreadPx * 2,
      shell.texHeight + spreadPx * 2,
    );
  } finally {
    context.restore();
  }
}

function context2d(canvas: AtlasCanvas): CanvasRenderingContext2D | null {
  return (canvas as HTMLCanvasElement).getContext(
    '2d',
  ) as CanvasRenderingContext2D | null;
}

/**
 * Create the secondary shadow once: blit the standing shell's blank sprite into
 * its own canvas, then `source-in` black, which keeps exactly the sprite's
 * alpha (body plus its baked margin). At draw time only a scaled `drawImage`
 * remains.
 */
export function createLiftShadowAsset(
  atlas: Pick<TileAtlas, 'getSprite' | 'getPage'>,
  createCanvas: CreateAtlasCanvas,
): LiftShadowAsset {
  const sprite = atlas.getSprite(tileRenderKey('shell_hand_standing', 'blank'));
  const page = atlas.getPage(sprite);
  const width = Math.max(1, Math.round(sprite.uv.width));
  const height = Math.max(1, Math.round(sprite.uv.height));
  const canvas = createCanvas(width, height);
  const context = context2d(canvas);
  if (!context) throw new Error('cannot create the lift-shadow canvas context');

  context.clearRect(0, 0, width, height);
  context.drawImage(
    page.canvas as CanvasImageSource,
    sprite.uv.x,
    sprite.uv.y,
    sprite.uv.width,
    sprite.uv.height,
    0,
    0,
    width,
    height,
  );
  context.globalCompositeOperation = 'source-in';
  context.fillStyle = '#000000';
  context.fillRect(0, 0, width, height);

  return {
    image: canvas as CanvasImageSource,
    sourceWidth: sprite.texWidth,
    sourceHeight: sprite.texHeight,
    alpha: LIFT_SHADOW_ALPHA,
  };
}

/**
 * Create the 64 × 64 diagonal shimmer ramp once. Alpha is zero at both ends and
 * peaks at {@link SHIMMER_RAMP_ALPHA}, so the sweep thins out at the face edges
 * instead of ending in a hard band.
 */
export function createShimmerAsset(
  createCanvas: CreateAtlasCanvas,
  size = 64,
): ShimmerAsset {
  const canvas = createCanvas(size, size);
  const context = context2d(canvas);
  if (!context) throw new Error('cannot create the shimmer canvas context');

  const ramp = context.createLinearGradient(0, 0, size, size);
  const peak = `rgba(255, 252, 235, ${SHIMMER_RAMP_ALPHA})`;
  const clear = 'rgba(255, 252, 235, 0)';
  ramp.addColorStop(0, clear);
  ramp.addColorStop(0.34, 'rgba(255, 252, 235, 0.03)');
  ramp.addColorStop(0.5, peak);
  ramp.addColorStop(0.66, 'rgba(255, 252, 235, 0.03)');
  ramp.addColorStop(1, clear);
  context.fillStyle = ramp;
  context.fillRect(0, 0, size, size);

  return { image: canvas as CanvasImageSource };
}

/** Browser default for the startup-baked overlay canvases. */
export const defaultOverlayCanvas: CreateAtlasCanvas = (width, height) => {
  if (typeof document === 'undefined') {
    throw new Error('cannot bake overlay assets without a document');
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
};
