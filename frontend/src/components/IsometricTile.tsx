import { formatTileForDisplay } from '../display';
import { flatTileFaces, uprightTileFaces } from '../iso';
import type {
  ScreenPoint,
  TablePoint,
  TileFaces,
  ToScreen,
} from '../iso';
import type { SeatRotation } from '../seatOrder';
import { Tile } from './Tile';

/**
 * The `riichi-mahjong-tiles` artwork's own coordinate space.
 *
 * Every face in the package uses a 300x400 viewBox, matching the 3:4 tile face.
 * Embedding the art as a nested SVG at this size lets the isometric tile map it
 * onto the projected face with one matrix, so the artwork itself is untouched.
 */
const TILE_ART_WIDTH = 300;
const TILE_ART_HEIGHT = 400;

/** The `points` attribute for a projected outline. */
function pointsAttribute(points: readonly ScreenPoint[]): string {
  return points.map((point) => `${point.x},${point.y}`).join(' ');
}

/**
 * The matrix that maps the 300x400 artwork onto a projected face.
 *
 * `origin` is the face's top-left, `across` runs left to right, and `down` runs
 * top to bottom, so `origin + across * (x / 300) + down * (y / 400)` places any
 * artwork coordinate. SVG's `matrix(a b c d e f)` applies exactly that affine
 * map, which keeps the art readable at any seat rotation.
 */
function faceMatrix(face: TileFaces['face']): string {
  return [
    face.across.x / TILE_ART_WIDTH,
    face.across.y / TILE_ART_WIDTH,
    face.down.x / TILE_ART_HEIGHT,
    face.down.y / TILE_ART_HEIGHT,
    face.origin.x,
    face.origin.y,
  ].join(' ');
}

/** How the tile lies on the table. */
export type TilePose = 'upright' | 'flat';

interface IsometricTileProps {
  /** Tile code such as "1m", "5p", or "7z". */
  code: string;
  /** Draw the red-five variant of a 5 tile. */
  isRedFive?: boolean;
  /**
   * The tile's anchor on the table.
   *
   * For an upright tile this is the middle of the face's bottom edge, as
   * `handSlots` places it. For a flat tile it is the middle of the top face's
   * footprint.
   */
  centre: TablePoint;
  /** Clockwise turn of the tile from the bottom seat's reading direction. */
  rotation?: SeatRotation;
  /** The fitted table projection. */
  toScreen: ToScreen;
  /**
   * `upright` stands the tile on the table facing its owner, as a concealed
   * hand does; `flat` lays the face up, as a discard does.
   */
  pose?: TilePose;
  /**
   * Turn a flat tile a quarter turn: the Riichi declaration and called-tile
   * convention. Upright tiles ignore it, because turning one would hide its
   * face from the camera.
   */
  sideways?: boolean;
  /**
   * Draw the tile as a discard thrown straight off the draw: dimmer, with the
   * corner dot the top-down view uses. Reserved for the river; a hand's own
   * tiles are never tsumogiri.
   */
  tsumogiri?: boolean;
  /**
   * Mark the tile as the drawn tile. It is already set apart from the hand by
   * `handSlots`; this only adds the distinction to the accessible name.
   */
  isDraw?: boolean;
}

/**
 * One isometric tile: the existing tile artwork on a projected face, plus the
 * tile's thickness.
 *
 * No new artwork is drawn. The face is the same `Tile` SVG the stacked and
 * top-down views use, mapped onto the isometric face by {@link faceMatrix}; the
 * thickness is a plain cream polygon, because at this camera angle a tile only
 * ever shows its top (upright) or its front side (flat). Both are sized in tile
 * units in `iso.ts`, so tiles scale with the fitted table and never with
 * hard-coded pixels.
 */
export function IsometricTile({
  code,
  isRedFive = false,
  centre,
  rotation = 0,
  toScreen,
  pose = 'upright',
  sideways = false,
  tsumogiri = false,
  isDraw = false,
}: IsometricTileProps) {
  const faces =
    pose === 'flat'
      ? flatTileFaces(centre, rotation, toScreen, sideways)
      : uprightTileFaces(centre, rotation, toScreen);

  const label = `${formatTileForDisplay(code, isRedFive)}${
    isDraw ? ', drawn tile' : ''
  }${tsumogiri ? ', tsumogiri' : ''}`;

  // The dot sits just inside the artwork face's top-right corner.
  const dotRadius =
    Math.hypot(faces.face.across.x, faces.face.across.y) * 0.09;
  const dotX = faces.outline[1].x - dotRadius * 1.6;
  const dotY = faces.outline[1].y + dotRadius * 1.6;

  return (
    <g
      className={`iso-tile iso-tile--${pose}${
        sideways ? ' iso-tile--sideways' : ''
      }${tsumogiri ? ' iso-tile--tsumogiri' : ''}${
        isDraw ? ' iso-tile--draw' : ''
      }`}
      role="img"
      aria-label={label}
    >
      {/*
       * One ivory body for the whole tile, so the top edge and the face are
       * the same piece rather than two bars with a seam between them.
       */}
      <polygon
        className="iso-tile__body"
        points={pointsAttribute(faces.silhouette)}
      />

      {/*
       * A standing tile shows a thin strip of its blue back over the far top
       * edge; a flat tile shows its shaded front side instead.
       */}
      {faces.back ? (
        <polygon className="iso-tile__back" points={pointsAttribute(faces.back)} />
      ) : (
        <polygon className="iso-tile__side" points={pointsAttribute(faces.edge)} />
      )}

      {/* The existing artwork, mapped onto the projected face. */}
      <g aria-hidden="true" transform={`matrix(${faceMatrix(faces.face)})`}>
        <Tile
          code={code}
          isRedFive={isRedFive}
          width={TILE_ART_WIDTH}
          height={TILE_ART_HEIGHT}
        />
      </g>

      {/* A hairline around the whole body keeps neighbouring tiles from merging. */}
      <polygon
        className="iso-tile__outline"
        points={pointsAttribute(faces.silhouette)}
      />

      {tsumogiri && (
        <circle
          className="iso-tile__tsumogiri-dot"
          cx={dotX}
          cy={dotY}
          r={dotRadius}
        />
      )}
    </g>
  );
}
