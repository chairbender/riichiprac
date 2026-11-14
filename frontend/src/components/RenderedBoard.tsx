/**
 * The interactive rendered board: one 2D canvas plus a DOM layer.
 *
 * The canvas is painting only; every interaction and every accessible name
 * lives in DOM, so keyboard/screen-reader behaviour is not a second-class
 * canvas mode:
 *
 *  - the human's hand buttons are real `<button>`s positioned at the shell's
 *    logical body rect. Their order is dock order (hand then draw), and their
 *    labels are the dock's labels, so Tab order and speech match the top-down
 *    view. Their hitboxes move with the lift; the transparent shadow margin is
 *    never part of a button;
 *  - pointer hit-testing uses {@link createHitTester} against the same body
 *    rects (half-open, with the current lift and sticky hover), never the
 *    texture bounds;
 *  - every other tile (walls, ponds, calls, opponents' hands) has a hidden
 *    `role="img"` item with an accessible name, grouped by seat and zone. An
 *    opponent's concealed faces are never named.
 *
 * The buttons are `pointer-events: none`: the pointer path is always the
 * scripted hit test, while the buttons remain keyboard-focusable and
 * screen-reader-activatable. Both paths call the same `onSelectTile`.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react';
import type {
  BoardFit,
  BoardLayout,
  BoardSize,
  BoardPoint,
} from '../table/boardLayout';
import {
  DEFAULT_LIFT_PX,
  boardRectToScreen,
  createHitTester,
  interactivePlacementIds,
  placementBodyRect,
  screenPointToBoard,
} from '../table/boardInteraction';
import { renderBoard } from '../table/boardRenderer';
import type { BoardRenderOverlay } from '../table/boardRenderer';
import type { LiftShadowAsset, ShimmerAsset } from '../table/boardOverlays';
import { buildRenderedBoardModel } from '../table/renderedBoardModel';
import type { GameState } from '../types/game';
import type { TileAtlas } from '../table/TileAtlas';

/** Injected painter for tests and pixel review; production uses the renderer. */
export type PaintRenderedBoard = (
  context: CanvasRenderingContext2D,
  layout: BoardLayout,
  overlay: BoardRenderOverlay,
) => void;

export interface RenderedBoardProps {
  readonly layout: BoardLayout;
  /** Canvas CSS size. */
  readonly viewport: BoardSize;
  readonly fit: BoardFit;
  readonly pixelRatio: number;
  readonly atlas: TileAtlas;
  readonly felt: CanvasImageSource | null;
  readonly liftShadow: LiftShadowAsset | null;
  readonly shimmer: ShimmerAsset | null;
  readonly state: GameState;
  readonly answered: boolean;
  readonly canDiscard: boolean;
  readonly callRiichi: boolean;
  readonly callKan: boolean;
  readonly highlightLastDiscard: number | null;
  readonly answerPlacementId: string | null;
  readonly answerCorrect: boolean | null;
  readonly onSelectTile: (tile: string, index?: number) => void;
  /** Paint failure (missing sprite, dead context): the shell falls back. */
  readonly onPaintError?: (error: unknown) => void;
  readonly paint?: PaintRenderedBoard;
  /** Attach the root element to the loader's measuring ref. */
  readonly rootRef?: (node: HTMLDivElement | null) => void;
  readonly className?: string;
  readonly controls?: ReactNode;
}

export function RenderedBoard({
  layout,
  viewport,
  fit,
  pixelRatio,
  atlas,
  felt,
  liftShadow,
  shimmer,
  state,
  answered,
  canDiscard,
  callRiichi,
  callKan,
  highlightLastDiscard,
  answerPlacementId,
  answerCorrect,
  onSelectTile,
  onPaintError,
  paint,
  rootRef,
  className,
  controls,
}: RenderedBoardProps) {
  const localRootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // A new deal is a new board: never carry a selection across it.
  useEffect(() => {
    setHoveredId(null);
    setSelectedId(null);
  }, [layout]);

  const model = useMemo(
    () =>
      buildRenderedBoardModel({
        layout,
        state,
        hoveredId,
        selectedId,
        answered,
        canDiscard,
        callRiichi,
        callKan,
        highlightLastDiscard,
        answerPlacementId,
        answerCorrect,
      }),
    [
      layout,
      state,
      hoveredId,
      selectedId,
      answered,
      canDiscard,
      callRiichi,
      callKan,
      highlightLastDiscard,
      answerPlacementId,
      answerCorrect,
    ],
  );

  const hitTester = useMemo(() => createHitTester(layout), [layout]);
  const interactiveIds = useMemo(
    () => interactivePlacementIds(layout),
    [layout],
  );
  const buttonById = useMemo(
    () => new Map(model.buttons.map((button) => [button.placementId, button])),
    [model.buttons],
  );

  // Paint after every state/viewport change. Canvas pixels are drawn at the
  // device resolution; the renderer maps CSS px back through `pixelRatio`.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const width = Math.max(1, Math.round(viewport.width * pixelRatio));
    const height = Math.max(1, Math.round(viewport.height * pixelRatio));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;

    const context = canvas.getContext('2d');
    if (!context) {
      onPaintError?.(new Error('the rendered table canvas has no 2D context'));
      return;
    }

    try {
      if (paint) {
        paint(context, layout, model.overlay);
      } else {
        renderBoard(context, atlas, layout, {
          felt,
          pixelRatio,
          overlay: model.overlay,
          liftShadow,
          shimmer,
        });
      }
    } catch (error) {
      onPaintError?.(error);
    }
  }, [
    layout,
    model.overlay,
    viewport,
    pixelRatio,
    atlas,
    felt,
    liftShadow,
    shimmer,
    paint,
    onPaintError,
  ]);

  const pointOf = useCallback(
    (event: PointerEvent<HTMLDivElement>): BoardPoint => {
      const root = localRootRef.current;
      const rect = root?.getBoundingClientRect();
      return screenPointToBoard(
        {
          x: event.clientX - (rect?.left ?? 0),
          y: event.clientY - (rect?.top ?? 0),
        },
        fit,
      );
    },
    [fit],
  );

  const canInteract = !answered && canDiscard;

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!canInteract) {
        if (hoveredId !== null) setHoveredId(null);
        return;
      }
      const hit = hitTester(pointOf(event), {
        liftedIds: model.overlay.liftedIds,
        liftPx: DEFAULT_LIFT_PX,
        stickyId: hoveredId,
      });
      const next =
        hit && interactiveIds.has(hit.id) && buttonById.has(hit.id)
          ? hit.id
          : null;
      if (next !== hoveredId) setHoveredId(next);
    },
    [
      canInteract,
      hoveredId,
      hitTester,
      pointOf,
      model.overlay.liftedIds,
      interactiveIds,
      buttonById,
    ],
  );

  const onPointerLeave = useCallback(() => setHoveredId(null), []);

  const selectAt = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!canInteract) return;
      const hit = hitTester(pointOf(event), {
        liftedIds: model.overlay.liftedIds,
        liftPx: DEFAULT_LIFT_PX,
        stickyId: hoveredId,
      });
      if (!hit) return;
      const button = buttonById.get(hit.id);
      if (!button) return;
      setSelectedId(button.placementId);
      onSelectTile(button.tile, button.index);
    },
    [
      canInteract,
      hitTester,
      pointOf,
      model.overlay.liftedIds,
      hoveredId,
      buttonById,
      onSelectTile,
    ],
  );

  const activateButton = useCallback(
    (placementId: string, tile: string, index: number) => {
      if (!canInteract) return;
      setSelectedId(placementId);
      onSelectTile(tile, index);
    },
    [canInteract, onSelectTile],
  );

  const onButtonKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
      if (event.key === 'Escape' && hoveredId === id) {
        setHoveredId(null);
        event.currentTarget.blur();
      }
    },
    [hoveredId],
  );

  return (
    <div
      ref={(node) => {
        localRootRef.current = node;
        rootRef?.(node);
      }}
      className={`rendered-table${className ? ` ${className}` : ''}`}
      role="group"
      aria-label={model.a11y.label}
      data-rendered-lift-px={DEFAULT_LIFT_PX}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      onClick={selectAt}
    >
      <canvas
        ref={canvasRef}
        className="rendered-table-canvas"
        style={{ width: '100%', height: '100%' }}
        aria-hidden="true"
      />

      {model.buttons.map((button) => {
        const placement = layout.placements.find(
          (candidate) => candidate.id === button.placementId,
        );
        if (!placement) return null;
        const lifted = model.overlay.liftedIds?.has(button.placementId) ?? false;
        const rect = boardRectToScreen(
          placementBodyRect(placement, 0),
          fit,
          lifted ? DEFAULT_LIFT_PX : 0,
        );
        const isSelected =
          (answerPlacementId ?? selectedId) === button.placementId;
        return (
          <button
            key={button.placementId}
            type="button"
            className="rendered-tile-button"
            style={{
              left: `${rect.x}px`,
              top: `${rect.y}px`,
              width: `${rect.width}px`,
              height: `${rect.height}px`,
            }}
            data-placement-id={button.placementId}
            data-lifted={lifted ? 'true' : 'false'}
            data-selected={isSelected ? 'true' : 'false'}
            aria-label={button.label}
            disabled={button.disabled}
            onClick={(event) => {
              event.stopPropagation();
              activateButton(button.placementId, button.tile, button.index);
            }}
            onFocus={() => {
              if (canInteract) setHoveredId(button.placementId);
            }}
            onBlur={() => {
              setHoveredId((current) =>
                current === button.placementId ? null : current,
              );
            }}
            onKeyDown={(event) => onButtonKeyDown(event, button.placementId)}
          />
        );
      })}

      <div className="rendered-table-a11y rendered-sr">
        <p>{model.a11y.summary.join(' ')}</p>
        {model.a11y.markers.map((marker) => (
          <p key={marker}>{marker}</p>
        ))}
        {model.a11y.seats.map((seat) => (
          <section key={seat.side} role="group" aria-label={seat.label}>
            {seat.groups.map((group) => (
              <div key={group.id} role="group" aria-label={group.label}>
                {group.items.map((item) => (
                  <span
                    key={item.id}
                    className="rendered-sr-item"
                    role="img"
                    aria-label={item.label}
                  />
                ))}
              </div>
            ))}
          </section>
        ))}
      </div>

      {controls}
    </div>
  );
}
