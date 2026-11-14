/**
 * Asset loader and responsive shell for the rendered table.
 *
 * It loads the committed felt and the startup atlas, lays the current
 * `GameState` out with the Phase 3 engine, measures the stage, and hands the
 * fitted board to {@link RenderedBoard}. Nothing here can deal a hand: the
 * layout is a pure function of the state already on screen, so switching views
 * re-draws the same table.
 *
 * ## Fallback
 *
 * The rendered view is opt-in. If the felt, a manifest, a shell glyph or the 2D
 * context fails, the loader reports the reason once and the app switches to the
 * top-down plan (the accessible default fallback). The atlas loader clears its
 * own memo on failure, so choosing the rendered view again retries.
 *
 * ## Reserved bottom band
 *
 * The full-screen felt is drawn by the canvas. The floating controls (call
 * toggles, action bar, answer summary) sit on a translucent band at the bottom
 * of the stage; that band is measured and excluded from the fit, so the human's
 * hand is never hidden behind a button on a phone or a landscape window.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import type { BoardSize } from '../table/boardLayout';
import { boardLayoutFromState } from '../table/boardFromState';
import {
  answerPlacementId,
  fitRenderedViewport,
} from '../table/boardInteraction';
import type { LiftShadowAsset, ShimmerAsset } from '../table/boardOverlays';
import {
  createLiftShadowAsset,
  createShimmerAsset,
  defaultOverlayCanvas,
} from '../table/boardOverlays';
import { renderBoard } from '../table/boardRenderer';
import { humanPlayer } from '../table/renderedBoardModel';
import {
  loadDefaultRenderedAssets,
} from '../table/renderedAssets';
import type {
  LoadRenderedTableAssets,
  RenderedTableAssets,
} from '../table/renderedAssets';
import type { TileAtlas } from '../table/TileAtlas';
import type { CreateAtlasCanvas } from '../table/TileAtlasBuilder';
import type { GameState } from '../types/game';
import { RenderedBoard } from './RenderedBoard';
import type { PaintRenderedBoard } from './RenderedBoard';

export interface RenderedTableProps {
  readonly state: GameState;
  readonly answered: boolean;
  readonly canDiscard: boolean;
  readonly callRiichi: boolean;
  readonly callKan: boolean;
  readonly highlightLastDiscard: number | null;
  /** The answer already submitted, for the answered tile's tint. */
  readonly submittedAnswer: {
    readonly tile?: string | null;
    readonly tile_index?: number;
  } | null;
  readonly answerCorrect: boolean | null;
  readonly onSelectTile: (tile: string, index?: number) => void;
  /** Switch the app to the top-down plan after an asset/paint failure. */
  readonly onFallback: (reason: string) => void;
  /** Floating controls (call toggles, action bar, answer summary). */
  readonly children?: ReactNode;
  /** Test/review injection. */
  readonly loadAssets?: LoadRenderedTableAssets;
  readonly buildOverlayAssets?: (atlas: TileAtlas) => {
    readonly liftShadow: LiftShadowAsset | null;
    readonly shimmer: ShimmerAsset | null;
  };
  readonly createOverlayCanvas?: CreateAtlasCanvas;
  readonly paint?: PaintRenderedBoard;
  /** Test/review injection; production measures the element. */
  readonly measureViewport?: (root: HTMLElement) => BoardSize;
}

function measuredViewport(root: HTMLElement): BoardSize {
  const rect = root.getBoundingClientRect();
  if (rect.width >= 1 && rect.height >= 1) {
    return { width: rect.width, height: rect.height };
  }
  const width =
    typeof window !== 'undefined' && window.innerWidth > 0 ? window.innerWidth : 1;
  const height =
    typeof window !== 'undefined' && window.innerHeight > 0 ? window.innerHeight : 1;
  return { width, height };
}

export function RenderedTable({
  state,
  answered,
  canDiscard,
  callRiichi,
  callKan,
  highlightLastDiscard,
  submittedAnswer,
  answerCorrect,
  onSelectTile,
  onFallback,
  children,
  loadAssets = loadDefaultRenderedAssets,
  buildOverlayAssets,
  createOverlayCanvas,
  paint,
  measureViewport,
}: RenderedTableProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const [assets, setAssets] = useState<RenderedTableAssets | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [viewport, setViewport] = useState<BoardSize>({ width: 0, height: 0 });
  const [controlsHeight, setControlsHeight] = useState(0);
  const fallbackReported = useRef(false);

  const reportFallback = useCallback(
    (reason: string) => {
      if (fallbackReported.current) return;
      fallbackReported.current = true;
      setFailure(reason);
      onFallback(reason);
    },
    [onFallback],
  );

  useEffect(() => {
    let cancelled = false;
    fallbackReported.current = false;
    setAssets(null);
    setFailure(null);
    loadAssets()
      .then((next) => {
        if (!cancelled) setAssets(next);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        reportFallback(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [loadAssets, reportFallback]);

  const layout = useMemo(
    () => (assets ? boardLayoutFromState(assets.atlas.shells, state) : null),
    [assets, state],
  );

  const answeredPlacementId = useMemo(() => {
    if (!layout || !submittedAnswer) return null;
    const player = humanPlayer(state);
    return player
      ? answerPlacementId(layout, player, submittedAnswer)
      : null;
  }, [layout, state, submittedAnswer]);

  const overlayAssets = useMemo(() => {
    if (!assets) return null;
    if (buildOverlayAssets) return buildOverlayAssets(assets.atlas);
    try {
      const createCanvas = createOverlayCanvas ?? defaultOverlayCanvas;
      return {
        liftShadow: createLiftShadowAsset(assets.atlas, createCanvas),
        shimmer: createShimmerAsset(createCanvas),
      };
    } catch {
      // Overlay art is polish, not the board: a failed startup bake leaves the
      // board fully usable, just without the lift shadow/shimmer.
      return { liftShadow: null, shimmer: null };
    }
  }, [assets, buildOverlayAssets, createOverlayCanvas]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const measure = () => {
      setViewport(
        measureViewport ? measureViewport(root) : measuredViewport(root),
      );
      setControlsHeight(controlsRef.current?.offsetHeight ?? 0);
    };

    measure();
    const observer =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    observer?.observe(root);
    if (controlsRef.current) observer?.observe(controlsRef.current);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [measureViewport, assets]);

  const fit = useMemo(
    () =>
      layout
        ? fitRenderedViewport(viewport, layout.board, controlsHeight)
        : null,
    [layout, viewport, controlsHeight],
  );

  const pixelRatio = useMemo(() => {
    const ratio =
      typeof devicePixelRatio === 'number' && Number.isFinite(devicePixelRatio)
        ? devicePixelRatio
        : 1;
    return Math.max(1, Math.min(2, ratio));
  }, []);

  if (failure) {
    return (
      <div className="rendered-table rendered-table--failed" role="status">
        Rendered view unavailable ({failure}); showing the top-down plan.
      </div>
    );
  }

  if (!assets || !layout || !fit) {
    return (
      <div className="rendered-table rendered-table--loading" role="status">
        Loading rendered table…
      </div>
    );
  }

  return (
    <RenderedBoard
      layout={layout}
      viewport={viewport}
      fit={fit}
      pixelRatio={pixelRatio}
      atlas={assets.atlas}
      felt={assets.felt}
      liftShadow={overlayAssets?.liftShadow ?? null}
      shimmer={overlayAssets?.shimmer ?? null}
      state={state}
      answered={answered}
      canDiscard={canDiscard}
      callRiichi={callRiichi}
      callKan={callKan}
      highlightLastDiscard={highlightLastDiscard}
      answerPlacementId={answeredPlacementId}
      answerCorrect={answerCorrect}
      onSelectTile={onSelectTile}
      onPaintError={(error) =>
        reportFallback(error instanceof Error ? error.message : String(error))
      }
      paint={
        paint ??
        ((context, board, overlay) => {
          renderBoard(context, assets.atlas, board, {
            felt: assets.felt,
            pixelRatio,
            overlay,
            liftShadow: overlayAssets?.liftShadow ?? null,
            shimmer: overlayAssets?.shimmer ?? null,
          });
        })
      }
      rootRef={(node) => {
        rootRef.current = node;
      }}
      controls={
        <div className="rendered-table-controls" ref={controlsRef}>
          {children}
        </div>
      }
    />
  );
}
