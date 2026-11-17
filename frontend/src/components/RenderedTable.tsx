/**
 * The opt-in 2.5D rendered table (architecture Phase 4).
 *
 * The view is one canvas over the full-screen felt: {@link TableCompositor}
 * draws the shadow unions and then the zone bodies in Task 4.1 order. Over the
 * canvas sits a transparent DOM hit layer with the same seat, river, meld and
 * camera names the top-down plan uses, plus the published advance box of every
 * placed tile. The stacked and top-down views remain the accessible fallback;
 * this view adds no new game logic and no 3D browser context.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { GameState } from '../types/game';
import {
  boardImagePaths,
  loadBoardImages,
  loadRenderedTableAssets,
} from '../table/boardAssets';
import type { RenderedTableAssets } from '../table/boardAssets';
import { buildBoard } from '../table/boardLayout';
import type { Board } from '../table/boardLayout';
import { boardOverlay, windLetter } from '../table/boardOverlay';
import type { BoardHitSection, BoardHitZone, BoardOverlay } from '../table/boardOverlay';
import { resolveBoardContactOverlays } from '../table/contactOverlays';
import type { ContactOverlay } from '../table/contactOverlays';
import { TableCompositor } from '../table/TableCompositor';
import type { BoardCanvas } from '../table/TableCompositor';
import { TABLE_SIDE_LABELS } from '../seatOrder';

export interface RenderedTableProps {
  readonly state: GameState;
  /**
   * Seat whose newest discard is the tile being called or ronned, matching the
   * top-down view's claim marker. Null when nothing is being claimed.
   */
  readonly highlightLastDiscard?: number | null;
}

const percent = (value: number, total: number): string =>
  `${(value / Math.max(1, total)) * 100}%`;

/**
 * Decoded board textures survive a view switch. The map is keyed by the
 * manifest-relative path; the atlas pages are already memoised in
 * `loadFirstBoardAtlas`, so this is the only piece that would otherwise be
 * re-decoded every time the user returns to the rendered view.
 */
const sharedBoardImages = new Map<string, CanvasImageSource>();

function zoneStyle(zone: BoardHitZone, board: Board): CSSProperties {
  const style: CSSProperties = {
    left: percent(zone.x, board.width),
    top: percent(zone.y, board.height),
    width: percent(zone.width, board.width),
    height: percent(zone.height, board.height),
  };
  if (zone.rotationDeg !== 0) {
    style.transform = `rotate(${zone.rotationDeg}deg)`;
    style.transformOrigin = `${percent(zone.pivotX, zone.width)} ${percent(
      zone.pivotY,
      zone.height,
    )}`;
  }
  return style;
}

function tileStyle(tile: BoardHitZone['tiles'][number], zone: BoardHitZone): CSSProperties {
  return {
    left: percent(tile.x - zone.x, zone.width),
    top: percent(tile.y - zone.y, zone.height),
    width: percent(tile.width, zone.width),
    height: percent(tile.height, zone.height),
  };
}

/**
 * The transparent hit layer. Exported separately so its DOM/ARIA contract can
 * be tested without a browser canvas: every tile's published advance box is
 * one labelled element, the seat groups use the top-down names, and a calling
 * discard carries the claim marker.
 */
export function RenderedTableHitLayer({
  board,
  overlay,
}: {
  readonly board: Board;
  readonly overlay: BoardOverlay;
}) {
  return (
    <div className="rendered-hit-layer">
      {overlay.sections.map((section: BoardHitSection) => (
        <section
          key={section.key}
          className={`rendered-seat${section.side ? ` rendered-seat--${section.side}` : ''}`}
          aria-label={
            section.side === null ? section.label : TABLE_SIDE_LABELS[section.side]
          }
        >
          <div className="rendered-seat-body" role="group" aria-label={section.label}>
            {section.zones.map((zone) => (
              <div
                key={zone.id}
                className={`rendered-hit-zone rendered-hit-zone--${zone.kind}`}
                role="group"
                aria-label={zone.label}
                data-zone={zone.id}
                style={zoneStyle(zone, board)}
              >
                {zone.tiles.map((tile) => {
                  const note = tile.note;
                  return (
                    <span
                      key={`${tile.bodyIndex}-${tile.shell}-${tile.face ?? 'bare'}`}
                      className={`rendered-hit${tile.riichi ? ' rendered-hit--riichi' : ''}${
                        tile.highlight ? ' rendered-hit--claim' : ''
                      }`}
                      role="img"
                      aria-label={note ? `${tile.label}, ${note}` : tile.label}
                      {...(note ? { title: `${tile.label} — ${note}` } : {})}
                      style={tileStyle(tile, zone)}
                      data-hit-box={`${tile.x},${tile.y},${tile.width},${tile.height}`}
                      data-shell={tile.shell}
                      data-face={tile.face ?? ''}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </section>
      ))}

      <div
        className="rendered-compass"
        role="group"
        aria-label="Compass"
        style={{
          left: percent(overlay.compass.x, board.width),
          top: percent(overlay.compass.y, board.height),
          width: percent(overlay.compass.width, board.width),
          height: percent(overlay.compass.height, board.height),
        }}
      >
        {overlay.compass.seats.map((seat) => (
          <div
            key={seat.side}
            className={`rendered-compass-seat rendered-compass-seat--${seat.side}`}
            role="img"
            aria-label={seat.label}
          >
            <span className="rendered-compass-wind">{windLetter(seat.wind)}</span>
            <span className="rendered-compass-score">
              {seat.score.toLocaleString('en-US')}
            </span>
            {seat.riichi && (
              <span className="rendered-compass-stick" aria-hidden="true" />
            )}
          </div>
        ))}
        <div
          className="rendered-compass-wall"
          role="group"
          aria-label={overlay.compass.roundLabel}
        >
          <span>
            {overlay.compass.roundWind} {overlay.compass.handNumber}
          </span>
          <span className="rendered-compass-remaining">
            {overlay.compass.tilesRemaining}
          </span>
        </div>
      </div>
    </div>
  );
}

function RenderedTableMessage({
  role,
  children,
}: {
  readonly role: 'alert' | 'status';
  readonly children: ReactNode;
}) {
  return (
    <div className="rendered-table rendered-table--message" role={role}>
      {children}
    </div>
  );
}

function RenderedBoardView({
  state,
  assets,
  highlightLastDiscard,
}: {
  readonly state: GameState;
  readonly assets: RenderedTableAssets;
  readonly highlightLastDiscard: number | null;
}) {
  const built = useMemo(() => {
    try {
      return { board: buildBoard(assets.atlas.shells, state), error: null };
    } catch (error) {
      return {
        board: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, [assets, state]);

  if (!built.board) {
    return (
      <RenderedTableMessage role="alert">
        This hand could not be drawn on the rendered table: {built.error}. Switch
        to Stacked or Top-down to keep playing.
      </RenderedTableMessage>
    );
  }

  return (
    <RenderedBoard
      board={built.board}
      state={state}
      assets={assets}
      highlightLastDiscard={highlightLastDiscard}
    />
  );
}

function RenderedBoard({
  board,
  state,
  assets,
  highlightLastDiscard,
}: {
  readonly board: Board;
  readonly state: GameState;
  readonly assets: RenderedTableAssets;
  readonly highlightLastDiscard: number | null;
}) {
  const overlaysByZone = useMemo(() => {
    try {
      return resolveBoardContactOverlays(
        assets.atlas.shells,
        board,
        assets.overlays,
        assets.catches,
        assets.lyingCatches,
      );
    } catch (error) {
      // Contact shadows are polish; a manifest/geometry mismatch must not hide
      // the table. The committed tests keep the resolver honest.
      console.warn(`contact decals unavailable: ${String(error)}`);
      return new Map<string, ContactOverlay[]>();
    }
  }, [assets, board]);
  const overlay = useMemo(
    () => boardOverlay(board, state, highlightLastDiscard),
    [board, state, highlightLastDiscard],
  );

  const imagePaths = useMemo(
    () => boardImagePaths(board, assets.atlas.shells, overlaysByZone),
    [assets, board, overlaysByZone],
  );

  const imagesRef = useRef(sharedBoardImages);
  const [imageTick, setImageTick] = useState(0);
  const [imageError, setImageError] = useState<string | null>(null);

  useEffect(() => {
    const missing = imagePaths.filter((path) => !imagesRef.current.has(path));
    if (missing.length === 0) return;
    let cancelled = false;
    loadBoardImages(missing, imagesRef.current, {
      tableBaseUrl: assets.baseUrl,
    })
      .then(() => {
        if (!cancelled) setImageTick((tick) => tick + 1);
      })
      .catch((error: unknown) => {
        if (!cancelled) setImageError(String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [assets.baseUrl, imagePaths]);

  const imagesReady = imagePaths.every((path) => imagesRef.current.has(path));
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const compositorRef = useRef<TableCompositor | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !imagesReady) return;
    if (!compositorRef.current) {
      compositorRef.current = new TableCompositor(
        assets.atlas.shells,
        assets.atlas,
        imagesRef.current,
        canvas as unknown as BoardCanvas,
        (width, height) => {
          const layer = document.createElement('canvas');
          layer.width = width;
          layer.height = height;
          return layer;
        },
      );
    }
    compositorRef.current.update(board, overlaysByZone);
  }, [assets, board, overlaysByZone, imagesReady, imageTick]);

  const ratio = board.width / board.height;
  const boardStyle = {
    '--board-ratio': ratio,
    '--board-aspect': `${board.width} / ${board.height}`,
    '--board-unit': `${100 / Math.max(1, board.width)}cqw`,
  } as CSSProperties;

  return (
    <div
      className="rendered-table"
      style={{ backgroundImage: `url("${assets.feltUrl}")` }}
    >
      <div className="rendered-board" style={boardStyle}>
        <canvas
          ref={canvasRef}
          className="rendered-canvas"
          width={board.width}
          height={board.height}
          aria-hidden="true"
        />
        <RenderedTableHitLayer board={board} overlay={overlay} />
      </div>
      {imageError && (
        <p className="rendered-error" role="alert">
          Some tile art could not be loaded. The stacked and top-down views are
          still available.
        </p>
      )}
    </div>
  );
}

/** The rendered view's entry point: loads assets once, then draws the table. */
export function RenderedTable({
  state,
  highlightLastDiscard = null,
}: RenderedTableProps) {
  const [assets, setAssets] = useState<RenderedTableAssets | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadRenderedTableAssets()
      .then((loaded) => {
        if (!cancelled) setAssets(loaded);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="rendered-table rendered-table--message" role="alert">
        The rendered table could not load: {error}. Switch to Stacked or
        Top-down to keep playing.
      </div>
    );
  }
  if (!assets) {
    return (
      <div className="rendered-table rendered-table--message" role="status">
        Loading the rendered table…
      </div>
    );
  }
  return (
    <RenderedBoardView
      state={state}
      assets={assets}
      highlightLastDiscard={highlightLastDiscard}
    />
  );
}
