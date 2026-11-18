/**
 * The React host for the opt-in 3D table (3D-02).
 *
 * Responsibilities, and nothing else:
 *
 * - decide whether the view may run at all (`probeCapabilities`, before any
 *   three.js code is imported);
 * - create the canvas, then lazy-import `./three`, then hand it the snapshot;
 * - keep the renderer sized to its element, redraw on snapshot/size changes,
 *   carry the reduced-motion/perf flags through, and dispose on unmount;
 * - survive a WebGL context loss once, and fall back to the previous view on a
 *   second loss or a failed load.
 *
 * The canvas is decoration: it is `aria-hidden`, is not focusable, and the
 * view is named by a hidden heading (the DOM overlay that carries the real
 * buttons and compass arrives in 3D-08/3D-09).
 *
 * This module has **no static import of three.js**. The only reference is the
 * dynamic `import('./three')` below, which the module-boundary test pins.
 */

import { Component, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { probeCapabilities } from './capabilities';
import type { DebugMode, QualityTier, TableRenderer, TableSnapshot } from './contract';
import './RendererHost.css';

/** The host's observable lifecycle. */
export type RendererHostState =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'unsupported'
  | 'failed';

interface HostStatus {
  readonly state: RendererHostState;
  readonly message: string | null;
}

/**
 * The tier used when the URL does not pin one. Automatic device tiering is
 * 3D-11's job; until then the view is reachable only by an explicit query
 * parameter, and a pinned `?quality=` always wins.
 */
export const DEFAULT_QUALITY_TIER: QualityTier = 'high';

export interface RendererHostProps {
  /** The immutable picture to draw; a new revision is a cut, never a move. */
  readonly snapshot: TableSnapshot;
  /** `?quality=`, or null to use the default until automatic tiering lands. */
  readonly tier?: QualityTier | null;
  /** `?debug=`, used from 3D-05 onwards. */
  readonly debug?: DebugMode | null;
  /** `?perf`, used from 3D-13 onwards. */
  readonly perfHud?: boolean;
  /** `prefers-reduced-motion`; consumed from 3D-12 onwards. */
  readonly reducedMotion?: boolean;
  /**
   * The view to keep showing while the 3D scene loads, is unsupported or has
   * failed. App passes the normal table, so a browser without WebGL2 falls back
   * to the view it would otherwise have drawn instead of a blank stage.
   */
  readonly fallback?: ReactNode;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type ThreeModule = typeof import('./three');

/**
 * The one in-flight module load, shared by every mount.
 *
 * StrictMode (and any rapid remount) runs the mount effect twice; without this
 * cache the two runs would race two dynamic imports of the same chunk. One
 * promise is one download, and a rejection clears the cache so a retry after a
 * transient failure is still possible.
 */
let lazyThreeModule: Promise<ThreeModule> | null = null;

function loadThreeModule(): Promise<ThreeModule> {
  if (!lazyThreeModule) {
    lazyThreeModule = import('./three').catch((error: unknown) => {
      lazyThreeModule = null;
      throw error;
    });
  }
  return lazyThreeModule;
}

/**
 * Catch a render-time failure inside the host's subtree and show the fallback
 * instead of unmounting the app. Load failures are handled by the host itself;
 * this is the last-resort boundary the unit's deliverables ask for.
 */
interface RendererErrorBoundaryProps {
  readonly fallback: ReactNode;
  readonly onError: (message: string) => void;
  readonly children: ReactNode;
}

interface RendererErrorBoundaryState {
  readonly failed: boolean;
}

export class RendererErrorBoundary extends Component<
  RendererErrorBoundaryProps,
  RendererErrorBoundaryState
> {
  state: RendererErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): RendererErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error): void {
    this.props.onError(describeError(error));
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * Mount the 3D renderer.
 *
 * The effect is deliberately StrictMode-safe: the dynamic import's result is
 * discarded when the effect was already cleaned up, so a double-invoked effect
 * never produces two live renderers.
 */
export function RendererHost({
  snapshot,
  tier = null,
  debug = null,
  perfHud = false,
  reducedMotion = false,
  fallback = null,
}: RendererHostProps) {
  const headingId = useId();
  const statusId = useId();
  const viewportRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<TableRenderer | null>(null);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  const [status, setStatus] = useState<HostStatus>({ state: 'idle', message: null });

  // Once per mount: a probe that never leaks its context. Done in render rather
  // than an effect so the first paint already knows whether to show a canvas.
  const capabilities = useMemo(() => probeCapabilities(), []);
  const resolvedTier = tier ?? DEFAULT_QUALITY_TIER;

  useEffect(() => {
    if (!capabilities.webgl2) {
      setStatus({
        state: 'unsupported',
        message:
          capabilities.unavailable ?? 'WebGL2 is not available in this browser.',
      });
      return;
    }

    const container = viewportRef.current;
    if (!container) return;

    let cancelled = false;
    let renderer: TableRenderer | null = null;
    let canvas: HTMLCanvasElement | null = null;
    let losses = 0;
    let observer: ResizeObserver | null = null;

    const measure = () => {
      if (!renderer) return;
      // clientWidth/Height are 0 for a display:none or not-yet-laid-out
      // element; a renderer cannot take a zero size, and the next resize will
      // correct it.
      const width = container.clientWidth || container.getBoundingClientRect().width;
      const height = container.clientHeight || container.getBoundingClientRect().height;
      if (width <= 0 || height <= 0) return;
      renderer.setSize(width, height, globalThis.devicePixelRatio || 1);
    };

    setStatus({ state: 'loading', message: null });

    // The canvas exists before three.js is imported, so a context refusal is
    // decided by the browser, not by the lazy chunk.
    canvas = document.createElement('canvas');
    canvas.className = 'renderer-3d-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    container.appendChild(canvas);

    const onContextLost = (event: Event) => {
      // Preventing the default is what allows the browser to restore the
      // context instead of tearing it down permanently.
      event.preventDefault();
      losses += 1;
      if (losses > 1) {
        renderer?.dispose();
        renderer = null;
        rendererRef.current = null;
        setStatus({
          state: 'failed',
          message: 'The 3D view lost its WebGL context twice and was closed.',
        });
        return;
      }
      setStatus({ state: 'loading', message: 'Restoring the 3D view' });
    };

    const onContextRestored = () => {
      if (cancelled || !renderer) return;
      setStatus({ state: 'ready', message: null });
      // three re-initialises its GL state after a restore, but the scene has to
      // be drawn again; setSize redraws synchronously.
      measure();
    };

    canvas.addEventListener('webglcontextlost', onContextLost);
    canvas.addEventListener('webglcontextrestored', onContextRestored);

    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(measure);
      observer.observe(container);
    } else {
      globalThis.addEventListener('resize', measure);
    }

    void loadThreeModule()
      .then((module) => {
        if (cancelled || !canvas) return;
        renderer = module.createRenderer(canvas, {
          tier: resolvedTier,
          debug,
          perfHud,
          reducedMotion,
        });
        rendererRef.current = renderer;
        renderer.syncState(snapshotRef.current);
        measure();
        setStatus({ state: 'ready', message: null });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setStatus({ state: 'failed', message: describeError(error) });
      });

    return () => {
      cancelled = true;
      observer?.disconnect();
      if (typeof ResizeObserver !== 'function') {
        globalThis.removeEventListener('resize', measure);
      }
      // Remove the listeners before disposing: forceContextLoss fires a
      // contextlost event, and a teardown must never look like a failure.
      canvas?.removeEventListener('webglcontextlost', onContextLost);
      canvas?.removeEventListener('webglcontextrestored', onContextRestored);
      renderer?.dispose();
      renderer = null;
      rendererRef.current = null;
      canvas?.remove();
      canvas = null;
    };
  }, [capabilities, debug, perfHud, reducedMotion, resolvedTier]);

  // Redraw on a new snapshot without remounting the renderer.
  useEffect(() => {
    rendererRef.current?.syncState(snapshot);
  }, [snapshot]);

  const showFallback = status.state !== 'ready';
  const description = status.message ? statusId : undefined;

  return (
    <RendererErrorBoundary
      fallback={fallback}
      onError={(message) => setStatus({ state: 'failed', message })}
    >
      <div className="renderer-3d" data-renderer-state={status.state}>
        <h2 id={headingId} className="renderer-3d-heading">
          3D table view
        </h2>
        <div
          ref={viewportRef}
          className="renderer-3d-viewport"
          role="group"
          aria-labelledby={headingId}
          aria-describedby={description}
        />
        <div className="renderer-3d-vignette" aria-hidden="true" />
        {showFallback && fallback}
        {status.message && (
          <p
            id={statusId}
            className="renderer-3d-status"
            role={status.state === 'failed' ? 'alert' : 'status'}
          >
            {status.message}
          </p>
        )}
      </div>
    </RendererErrorBoundary>
  );
}
