import type { ReactNode } from 'react';
import { SIDE_ROTATION, TABLE_SIDES, tablePlacements } from '../seatOrder';
import type { TableSide } from '../seatOrder';
import type { GameState, PlayerState } from '../types/game';
import {
  ISO_LIGHT,
  SEAT_BAND_DEPTH,
  SIDE_NORMAL,
  SIDE_TANGENT,
  TABLE_HALF_SIZE,
  centreCorners,
  project,
  seatBands,
  seatEdgeMidpoint,
  tablePlaneCorners,
} from '../iso';
import type { ScreenPoint, TablePoint } from '../iso';

/** SVG user units per table unit (one tile width). */
const TILE = 60;

/** The fixed drawing area. Every position below is in these user units. */
const VIEW_WIDTH = 960;
const VIEW_HEIGHT = 700;

/**
 * Where the table's centre sits in the view.
 *
 * The plane takes the middle band of the view: the compacted 12-by-12 surface
 * is 720 by 360 units, leaving room below for the human's hand and room around
 * it for the opponents' hands in the later parts of the isometric chain.
 */
const TABLE_ORIGIN = { x: VIEW_WIDTH / 2, y: 320 };

/** Convert a table point to an SVG user-space point. */
function toScreen(point: TablePoint): ScreenPoint {
  const projected = project(point);
  return {
    x: TABLE_ORIGIN.x + projected.x * TILE,
    y: TABLE_ORIGIN.y + projected.y * TILE,
  };
}

/** The `points` attribute value for a projected table polygon. */
function polygonPoints(points: readonly TablePoint[]): string {
  return points
    .map((point) => {
      const screen = toScreen(point);
      return `${screen.x},${screen.y}`;
    })
    .join(' ');
}

/** A short label for each seat, as the human reads the table. */
const SIDE_LABELS: Record<TableSide, string> = {
  bottom: 'your seat, at the bottom',
  right: 'right side, shimocha',
  top: 'across, toimen',
  left: 'left side, kamicha',
};

/**
 * Whether to draw the alignment grid.
 *
 * The overlay is a development aid for lining up later parts (hands, rivers,
 * melds, compass), so it is only reachable in a dev build and only when the URL
 * asks for it, e.g. `http://localhost:5173/?isoDebug`. Production builds and
 * ordinary dev sessions never show it.
 */
function debugOverlayEnabled(): boolean {
  if (!import.meta.env.DEV) return false;
  try {
    const params = new URLSearchParams(globalThis.location?.search ?? '');
    if (!params.has('isoDebug')) return false;
    const value = params.get('isoDebug');
    return value !== '0' && value !== 'false';
  } catch {
    return false;
  }
}

/** Parsed once: the URL does not change while a table is on screen. */
const SHOW_DEBUG_OVERLAY = debugOverlayEnabled();

/** Table point at the middle of a seat's band, where its debug label goes. */
function seatBandCentre(side: TableSide): TablePoint {
  const normal = SIDE_NORMAL[side];
  const distance = TABLE_HALF_SIZE - SEAT_BAND_DEPTH / 2;
  return { x: normal.x * distance, y: normal.y * distance, z: 0 };
}

/**
 * The dev-only alignment overlay.
 *
 * It is deliberately drawn in the same projection as the table, one line per
 * table unit, so a tile, river row, or compass element added by a later part
 * can be checked against the grid rather than eyeballed. The seat rows show
 * which way each seat reads and the rotation later tile components must use.
 */
function DebugOverlay() {
  const gridLines: ReactNode[] = [];
  for (let unit = -TABLE_HALF_SIZE; unit <= TABLE_HALF_SIZE; unit += 1) {
    // A line of constant x, then a line of constant y.
    const bottom = toScreen({ x: unit, y: -TABLE_HALF_SIZE, z: 0 });
    const top = toScreen({ x: unit, y: TABLE_HALF_SIZE, z: 0 });
    const left = toScreen({ x: -TABLE_HALF_SIZE, y: unit, z: 0 });
    const right = toScreen({ x: TABLE_HALF_SIZE, y: unit, z: 0 });

    gridLines.push(
      <line
        key={`x-${unit}`}
        x1={bottom.x}
        y1={bottom.y}
        x2={top.x}
        y2={top.y}
      />,
      <line
        key={`y-${unit}`}
        x1={left.x}
        y1={left.y}
        x2={right.x}
        y2={right.y}
      />,
    );
  }

  return (
    <g className="iso-debug" aria-hidden="true">
      <g className="iso-debug-grid">{gridLines}</g>

      {/* Anchors later hands and river rows aim at. */}
      <g className="iso-debug-edges">
        {TABLE_SIDES.map((side) => {
          const anchor = toScreen(seatEdgeMidpoint(side));
          return <circle key={side} cx={anchor.x} cy={anchor.y} r={3} />;
        })}
      </g>

      {TABLE_SIDES.map((side) => {
        const centre = seatBandCentre(side);
        const anchor = toScreen(centre);
        const tangent = SIDE_TANGENT[side];
        const left = toScreen({
          x: centre.x - tangent.x,
          y: centre.y - tangent.y,
          z: 0,
        });
        const right = toScreen({
          x: centre.x + tangent.x,
          y: centre.y + tangent.y,
          z: 0,
        });

        return (
          <g key={side} className="iso-debug-seat">
            {/* The direction this seat's tiles read, left to right. */}
            <line x1={left.x} y1={left.y} x2={right.x} y2={right.y} />
            <circle cx={right.x} cy={right.y} r={3} />
            <text x={anchor.x} y={anchor.y - 9} textAnchor="middle">
              {side} · rot {SIDE_ROTATION[side]}°
            </text>
          </g>
        );
      })}

      <g className="iso-debug-centre">
        <circle
          cx={TABLE_ORIGIN.x}
          cy={TABLE_ORIGIN.y}
          r={10}
        />
        <text
          x={TABLE_ORIGIN.x}
          y={TABLE_ORIGIN.y + 28}
          textAnchor="middle"
        >
          compass
        </text>
      </g>
    </g>
  );
}

/** The player sitting on a side, once a game state is available. */
function playersBySide(
  state: GameState | undefined,
): Map<TableSide, PlayerState> {
  const bySide = new Map<TableSide, PlayerState>();
  if (!state) return bySide;

  // A malformed table can repeat a side; like the top-down view, keep the
  // first player placed there.
  for (const placement of tablePlacements(state.players)) {
    if (!bySide.has(placement.side)) {
      bySide.set(placement.side, placement.player);
    }
  }
  return bySide;
}

interface IsometricTableProps {
  /**
   * The table to draw. The geometry and seat bands render without it, which is
   * what the app shows while a hand is loading; the player names enrich the
   * accessible labels when it is present.
   */
  state?: GameState;
}

/**
 * The isometric (Tenhou-style) table view.
 *
 * This is the geometry layer: one SVG with a fixed viewBox, the playing
 * surface, and the four seat bands, with the centre reserved for the compass.
 * There are no tiles yet. Later parts of the chain fill each band in, using the
 * projection in `iso.ts` and the same seat order and rotations as the top-down
 * table (`tablePlacements`, `SIDE_ROTATION`), so this view cannot drift into a
 * second notion of where the seats are.
 *
 * The camera is fixed at a 30° pitch with no perspective, so the plane is a 2:1
 * rectangle: the human's edge runs along the bottom, shimocha is on the right,
 * toimen across the top, and kamicha on the left. Each band is the trapezoid
 * along its own edge, mitered at the corners, and the four tile together form
 * the ring around the compass.
 *
 * Lighting is the flat Tenhou-style cue rather than a 3D render: the felt has a
 * vignette, and the shared {@link ISO_LIGHT} tokens give every tile the same
 * fixed shadow direction once tiles arrive.
 */
export function IsometricTable({ state }: IsometricTableProps) {
  const plane = polygonPoints(tablePlaneCorners());
  const centre = polygonPoints(centreCorners());
  const bands = seatBands();
  const seated = playersBySide(state);

  return (
    <div className="isometric-table">
      <svg
        className="isometric-svg"
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        role="group"
        aria-label="Table, isometric view"
      >
        <defs>
          {/* Felt vignette: lit near the compass, darker towards the rail. */}
          <radialGradient id="iso-felt" cx="50%" cy="42%" r="68%">
            <stop offset="0%" stopColor="#2c5a44" />
            <stop offset="55%" stopColor="#254a38" />
            <stop offset="100%" stopColor="#172c22" />
          </radialGradient>

          {/*
           * One soft shadow for the table itself, and the filter shape later
           * parts reuse for tile contact shadows. User-space units keep the
           * blur proportional when the SVG scales to a phone.
           */}
          <filter
            id="iso-table-shadow"
            x="-10%"
            y="-20%"
            width="120%"
            height="150%"
          >
            <feDropShadow
              dx={ISO_LIGHT.shadowOffsetX * TILE}
              dy={ISO_LIGHT.shadowOffsetY * TILE}
              stdDeviation={ISO_LIGHT.shadowBlur * TILE}
              floodColor="#05080b"
              floodOpacity={ISO_LIGHT.shadowOpacity + 0.2}
            />
          </filter>
        </defs>

        {/* The rail, then the felt surface. */}
        <polygon
          className="iso-rail"
          points={polygonPoints(tablePlaneCorners(TABLE_HALF_SIZE + 0.55))}
          filter="url(#iso-table-shadow)"
        />
        <polygon className="iso-felt" points={plane} fill="url(#iso-felt)" />

        {/* One band per seat, in turn order from the human's. */}
        {TABLE_SIDES.map((side) => {
          const player = seated.get(side) ?? null;
          const label = player
            ? `${SIDE_LABELS[side]}, ${player.name}`
            : SIDE_LABELS[side];

          return (
            <g
              key={side}
              role="group"
              aria-label={label}
              className={`iso-seat iso-seat--${side}${
                side === 'bottom' ? ' iso-seat--human' : ''
              }`}
            >
              <polygon points={polygonPoints(bands[side])} />
            </g>
          );
        })}

        {/* The centre is reserved for the compass in a later part. */}
        <g role="group" aria-label="Compass">
          <polygon className="iso-centre" points={centre} />
        </g>

        {SHOW_DEBUG_OVERLAY && <DebugOverlay />}
      </svg>
    </div>
  );
}
