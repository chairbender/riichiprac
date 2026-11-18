/**
 * The rendered 2.5D table (`view: 'rendered'`).
 *
 * A full-window square of felt with the whole board composed on one canvas:
 * four walls, four ponds, all four hands (the human's with its drawn tile) and
 * every open meld, drawn from the committed shell/felt/decal assets through the
 * Phase 3 zone layout and the Phase 4 painter order.
 *
 * The felt is a square whose top and bottom edges touch the browser (user
 * guidance 2026-11-18), not a stretched viewport: on a wide screen the scene
 * background shows beside it, exactly like the 3D alternate view. The app chrome
 * is not part of this component; `TableStage` floats it over the board.
 *
 * The canvas is decoration. The view is named by a hidden heading, the compass
 * is real DOM with each seat's wind/score/Riichi, and a visually hidden summary
 * carries every seat's discards and melds, so the rendered view stays equivalent
 * to the stacked and top-down views. Answering and reveal state come from the
 * same store actions as the other views: the HUD's hand dock is the controller.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { formatTileForDisplay } from '../display';
import { SIDE_ROTATION, tablePlacements } from '../seatOrder';
import type { TableSide } from '../seatOrder';
import type { GameState } from '../types/game';
import { BoardRenderer } from '../table/BoardRenderer';
import type { BoardFit } from '../table/BoardRenderer';
import { loadFirstBoardAssets } from '../table/boardAssets';
import type { BoardAssets } from '../table/boardAssets';
import { buildBoardPlan } from '../table/boardPlan';
import { loadFirstBoardAtlas, tableAssetUrl } from '../table/TileAtlas';
import type { TileAtlas } from '../table/TileAtlas';
import { RiichiStick } from './RiichiStick';
import { WindGlyph } from './WindGlyph';

const SIDE_LABELS: Record<TableSide, string> = {
  bottom: 'your seat, at the bottom',
  right: 'right side, shimocha',
  top: 'across, toimen',
  left: 'left side, kamicha',
};

export interface RenderedTableProps {
  state: GameState;
  /** Test seam: the shared atlas by default. */
  loadAtlas?: () => Promise<TileAtlas>;
  /** Test seam: the shared decal manifests by default. */
  loadAssets?: () => Promise<BoardAssets>;
}

interface Viewport {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A compact compass: one wind/score/Riichi stack per seat, turned to it. */
function RenderedCompass({
  state,
  size,
  left,
  top,
}: {
  state: GameState;
  size: number;
  left: number;
  top: number;
}) {
  const placements = tablePlacements(state.players);
  const bySide = new Map<TableSide, (typeof placements)[number]>();
  for (const placement of placements) {
    if (!bySide.has(placement.side)) bySide.set(placement.side, placement);
  }

  return (
    <div
      className="rendered-compass"
      role="group"
      aria-label="Compass"
      style={{
        width: size,
        height: size,
        left,
        top,
        fontSize: Math.max(8, size * 0.085),
      }}
    >
      {(['bottom', 'right', 'top', 'left'] as const).map((side) => {
        const placement = bySide.get(side);
        if (!placement) return null;
        const player = placement.player;
        return (
          <div
            key={side}
            className={`rendered-compass-corner rendered-compass-corner--${side}`}
          >
            <div
              role="img"
              aria-label={`${player.wind} wind, ${player.score} points${
                player.is_riichi ? ', riichi' : ''
              }`}
              className="rendered-compass-seat"
              style={{ transform: `rotate(${SIDE_ROTATION[side]}deg)` }}
            >
              <WindGlyph wind={player.wind} className="rendered-compass-wind" />
              <span className="rendered-compass-score">
                {player.score.toLocaleString('en-US')}
              </span>
              {player.is_riichi && (
                <RiichiStick className="rendered-compass-stick" />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The screen-reader equivalent of the drawn board: each seat's wind, score and
 * Riichi state, what it discarded, and its open melds. The hand dock names the
 * human's tiles, so the summary does not repeat them as prose.
 */
function BoardSummary({ state }: { state: GameState }) {
  const placements = tablePlacements(state.players);
  return (
    <section className="rendered-table-summary" aria-label="Table summary">
      {placements.map(({ player, side }) => (
        <section
          key={player.seat}
          aria-label={`${player.name}, ${player.wind} wind, ${player.score} points${
            player.is_riichi ? ', riichi' : ''
          }`}
        >
          <p>{SIDE_LABELS[side]}</p>
          <p>
            Discards:{' '}
            {player.discards.length === 0
              ? 'none'
              : player.discards
                  .map(
                    (discard) =>
                      formatTileForDisplay(discard.tile, discard.is_red === true) +
                      (discard.is_riichi ? ' (riichi)' : ''),
                  )
                  .join(', ')}
          </p>
          {player.melds.length > 0 && (
            <p>
              Melds:{' '}
              {player.melds
                .map((meld) => `${meld.meld_type} ${meld.tiles.join(' ')}`)
                .join('; ')}
            </p>
          )}
          {player.hand.length > 0 && (
            <p>
              Concealed: {player.hand.length} tile
              {player.hand.length === 1 ? '' : 's'}
            </p>
          )}
        </section>
      ))}
    </section>
  );
}

export function RenderedTable({
  state,
  loadAtlas = loadFirstBoardAtlas,
  loadAssets = loadFirstBoardAssets,
}: RenderedTableProps) {
  const headingId = useId();
  const statusId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<BoardRenderer | null>(null);
  const rendererKeyRef = useRef<RendererKey | null>(null);

  const [atlas, setAtlas] = useState<TileAtlas | null>(null);
  const [assets, setAssets] = useState<BoardAssets | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewport, setViewport] = useState<Viewport>({
    width: 0,
    height: 0,
    dpr: 1,
  });
  const [fit, setFit] = useState<BoardFit | null>(null);
  /** Bottom HUD height in CSS px, so the board fits above the hand dock. */
  const [hudInset, setHudInset] = useState(0);

  const feltUrl = useMemo(() => tableAssetUrl('felt.png'), []);

  // The atlas (18 composed shell pages) and the three decal manifests load
  // once for the app, not once per hand or view switch.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    void Promise.all([loadAtlas(), loadAssets()])
      .then(([loadedAtlas, loadedAssets]) => {
        if (cancelled) return;
        setAtlas(loadedAtlas);
        setAssets(loadedAssets);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [loadAtlas, loadAssets]);

  // Keep the canvas the size of the window; the felt square is CSS, so the
  // canvas only needs to cover the viewport for the board fit.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = () => {
      const width = element.clientWidth || element.getBoundingClientRect().width;
      const height =
        element.clientHeight || element.getBoundingClientRect().height;
      if (width <= 0 || height <= 0) return;
      setViewport({
        width,
        height,
        dpr: globalThis.devicePixelRatio || 1,
      });
    };
    measure();
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      return () => observer.disconnect();
    }
    globalThis.addEventListener('resize', measure);
    return () => globalThis.removeEventListener('resize', measure);
  }, []);

  const plan = useMemo(
    () => (atlas ? buildBoardPlan(state, atlas.shells) : null),
    [atlas, state],
  );

  /*
   * The floating HUD (action strip + hand dock) covers the bottom of the
   * window. Reserve its measured height so the drawn human hand is not hidden
   * behind the dock; the felt raster still reaches the window edge.
   */
  useEffect(() => {
    const stage = containerRef.current?.closest('.table-stage');
    const hud = stage?.querySelector<HTMLElement>('.table-stage-hud') ?? null;
    if (!hud) return;
    const measure = () => {
      const height = hud.getBoundingClientRect().height;
      setHudInset(height > 0 ? height + 8 : 0);
    };
    measure();
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(measure);
      observer.observe(hud);
      return () => observer.disconnect();
    }
    globalThis.addEventListener('resize', measure);
    return () => globalThis.removeEventListener('resize', measure);
  }, []);

  // Prepare the plan's images once, then draw. The renderer is rebuilt when the
  // atlas or the manifests change (a failed load retry); a new hand reuses it.
  useEffect(() => {
    if (!atlas || !assets || !plan) return;
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas || !canvas.getContext('2d')) {
      // jsdom and a browser that refuses a 2D context: the table cannot be
      // composed, but the HUD's hand dock is still fully usable.
      setError(
        'The rendered table could not get a 2D canvas; the hand dock still works.',
      );
      return;
    }
    if (viewport.width <= 0 || viewport.height <= 0) return;

    if (
      rendererRef.current === null ||
      rendererKeyRef.current?.atlas !== atlas ||
      rendererKeyRef.current?.assets !== assets
    ) {
      rendererRef.current = new BoardRenderer(atlas, assets);
      rendererKeyRef.current = { atlas, assets };
    }
    const renderer = rendererRef.current;

    const render = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const result = renderer.draw(plan, canvas, {
        cssWidth: viewport.width,
        cssHeight: viewport.height,
        dpr: viewport.dpr,
        bottomInset: hudInset,
      });
      if (!result) {
        setError(
          'The rendered table could not get a 2D canvas; the hand dock still works.',
        );
        return;
      }
      setError(null);
      setFit(result.fit);
    };

    void renderer
      .prepare(plan)
      .then(() => {
        if (!cancelled) render();
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [assets, atlas, hudInset, plan, viewport]);

  const compassSize = compassSizeNumber(
    fit,
    plan?.centreGapPx ?? 120,
  );
  const compassLeft =
    fit && plan ? fit.originX + plan.centreX * fit.scale : viewport.width / 2;
  const compassTop =
    fit && plan ? fit.originY + plan.centreY * fit.scale : viewport.height / 2;

  return (
    <div className="rendered-table">
      <h2 id={headingId} className="rendered-table-heading">
        Rendered table view
      </h2>

      <div
        className="rendered-table-felt"
        aria-hidden="true"
        style={{ backgroundImage: `url(${feltUrl})` }}
      />

      <div
        ref={containerRef}
        className="rendered-table-viewport"
        role="group"
        aria-labelledby={headingId}
        aria-describedby={error ? statusId : undefined}
      >
        <canvas
          ref={canvasRef}
          className="rendered-table-canvas"
          aria-hidden="true"
        />
      </div>

      <RenderedCompass
        state={state}
        size={compassSize}
        left={compassLeft}
        top={compassTop}
      />

      <BoardSummary state={state} />

      {!fit && !error && (
        <p className="rendered-table-status" role="status">
          Loading the rendered table…
        </p>
      )}
      {error && (
        <p id={statusId} className="rendered-table-status" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The compass's CSS px size. Squared to the felt: the centre well is twice the
 * board's `centreGapPx`, so a fitted board gives the compass its share of the
 * gap and it never overlaps the ponds.
 */
function compassSizeNumber(fit: BoardFit | null, centreGapPx: number): number {
  if (!fit) return 120;
  return Math.max(
    52,
    Math.min(190, centreGapPx * 2 * fit.scale * 0.78),
  );
}

/** The renderer and the assets it was built for, so a retry rebuilds it. */
interface RendererKey {
  readonly atlas: TileAtlas;
  readonly assets: BoardAssets;
}
