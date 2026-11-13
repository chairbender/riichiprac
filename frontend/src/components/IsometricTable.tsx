import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
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
  fitProjection,
  handApronCorners,
  project,
  seatBands,
  seatEdgeMidpoint,
  tableFootprintBounds,
  tablePlaneCorners,
  wallRingCorners,
} from '../iso';
import type { TablePoint, ToScreen, Viewport } from '../iso';
import { IsometricHand } from './IsometricHand';

/**
 * The quiet border around the fitted table, in CSS pixels.
 *
 * The table fills nearly the whole stage; this only keeps the outer wall and
 * the apron from touching the viewport edge, and gives the floating toolbar a
 * place to overlap felt instead of the table's own outline.
 */
const STAGE_PADDING = 28;

/**
 * A sensible first frame before the element has been measured.
 *
 * The real size comes from the stage's `ResizeObserver` on the first layout
 * pass; starting from the window's size avoids a visible shrink from a small
 * default on a large desktop.
 */
const DEFAULT_STAGE: Viewport = { width: 1280, height: 800 };

/** The initial stage size: the window when there is one, a 1280x800 fallback. */
function initialStageSize(): Viewport {
  if (typeof window === 'undefined') return DEFAULT_STAGE;
  return {
    width: Math.max(1, window.innerWidth),
    height: Math.max(1, window.innerHeight),
  };
}

/**
 * Track the rendered size of the stage.
 *
 * The isometric view is a full-screen SVG whose viewBox is the stage's size in
 * CSS pixels, so the projection has to be refitted whenever the window or the
 * surrounding layout changes. `ResizeObserver` also catches changes the window
 * event does not, such as the stage being laid out inside a resized panel.
 */
function useStageViewport(ref: RefObject<HTMLDivElement>): Viewport {
  const [viewport, setViewport] = useState<Viewport>(initialStageSize);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;

    const measure = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      if (width <= 0 || height <= 0) return;
      setViewport((current) =>
        current.width === width && current.height === height
          ? current
          : { width, height },
      );
    };

    measure();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }

    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return viewport;
}

/** The `points` attribute value for a projected table polygon. */
function polygonPoints(
  points: readonly TablePoint[],
  toScreen: ToScreen,
): string {
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
function DebugOverlay({ toScreen }: { toScreen: ToScreen }) {
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
        {(() => {
          const centre = toScreen({ x: 0, y: 0, z: 0 });
          return (
            <>
              <circle cx={centre.x} cy={centre.y} r={10} />
              <text x={centre.x} y={centre.y + 28} textAnchor="middle">
                compass
              </text>
            </>
          );
        })()}
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
   * The table to draw. The geometry, reserved wall ring, and seat bands render
   * without it, which is what the app shows while a hand is loading; the
   * player names enrich the accessible labels when it is present.
   */
  state?: GameState;
}

/**
 * The isometric (Tenhou-style) table view.
 *
 * The table is fitted to the stage rather than drawn at a fixed size: `iso.ts`
 * projects table units, `fitProjection` turns them into CSS pixels for the
 * measured viewport, and the SVG's viewBox is the stage in pixels. That way one
 * SVG user unit is one CSS pixel and the table fills the screen without a
 * second scaling system in CSS.
 *
 * The fitted content is the full footprint: the 12-by-12 playing surface, the
 * wall ring outside it, and the human's hand apron below that. The wall ring is
 * still an empty reserved rail; the apron now holds the human's concealed hand.
 * Both are already inside the fitted bounds, so adding them never moves the play
 * area.
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
  const stageRef = useRef<HTMLDivElement>(null);
  const viewport = useStageViewport(stageRef);
  const fit = useMemo(
    () => fitProjection(viewport, tableFootprintBounds(), STAGE_PADDING),
    [viewport],
  );

  const toScreen = useMemo<ToScreen>(
    () => (point) => {
      const projected = project(point);
      return {
        x: fit.origin.x + projected.x * fit.scale,
        y: fit.origin.y + projected.y * fit.scale,
      };
    },
    [fit],
  );

  const seated = playersBySide(state);
  const humanSeat = seated.get('bottom') ?? null;
  const railHalfSize = TABLE_HALF_SIZE + 0.55;
  const bands = seatBands();

  return (
    <div className="isometric-table" ref={stageRef}>
      <svg
        className="isometric-svg"
        viewBox={`0 0 ${viewport.width} ${viewport.height}`}
        preserveAspectRatio="xMidYMid meet"
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
           * parts reuse for tile contact shadows. The blur is in CSS pixels
           * (the viewBox is the stage), so it follows the fitted scale instead
           * of becoming a different weight on a large monitor.
           */}
          <filter
            id="iso-table-shadow"
            x="-10%"
            y="-20%"
            width="120%"
            height="150%"
          >
            <feDropShadow
              dx={ISO_LIGHT.shadowOffsetX * fit.scale}
              dy={ISO_LIGHT.shadowOffsetY * fit.scale}
              stdDeviation={ISO_LIGHT.shadowBlur * fit.scale}
              floodColor="#05080b"
              floodOpacity={ISO_LIGHT.shadowOpacity + 0.2}
            />
          </filter>
        </defs>

        {/*
         * Reserved footprint. The apron is the human's rail and holds their
         * hand; the wall ring is still the empty four-sided wall. Both are
         * fitted into the stage now so later parts cannot move the play area.
         */}
        <g aria-hidden="true">
          <polygon
            className="iso-apron"
            points={polygonPoints(handApronCorners(), toScreen)}
          />
          <polygon
            className="iso-wall-ring"
            points={polygonPoints(wallRingCorners(), toScreen)}
            filter="url(#iso-table-shadow)"
          />
        </g>

        {/* The rail lip, then the felt surface. */}
        <polygon
          className="iso-rail"
          points={polygonPoints(
            tablePlaneCorners(railHalfSize),
            toScreen,
          )}
        />
        <polygon
          className="iso-felt"
          points={polygonPoints(tablePlaneCorners(), toScreen)}
          fill="url(#iso-felt)"
        />

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
              <polygon
                points={polygonPoints(bands[side], toScreen)}
              />
            </g>
          );
        })}

        {/* The centre is reserved for the compass in a later part. */}
        <g role="group" aria-label="Compass">
          <polygon
            className="iso-centre"
            points={polygonPoints(centreCorners(), toScreen)}
          />
        </g>

        {/*
         * The human's own concealed hand stands on the apron in front of their
         * seat. The bottom seat is the human by `tablePlacements`, so this is
         * the same hand the docked hand shows in the other views.
         */}
        {humanSeat && (
          <IsometricHand player={humanSeat} toScreen={toScreen} />
        )}

        {SHOW_DEBUG_OVERLAY && <DebugOverlay toScreen={toScreen} />}
      </svg>
    </div>
  );
}
