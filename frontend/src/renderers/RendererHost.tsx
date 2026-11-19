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
 * view is named by a hidden heading (the DOM overlays that carry the real
 * buttons and the compass are 3D-08's and 3D-09's work).
 *
 * This module has **no static import of three.js**. The only reference is the
 * dynamic `import('./three')` below, which the module-boundary test pins.
 */

import { Component, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { antiAliasFor, probeCapabilities } from './capabilities';
import type {
  CarveReport,
  CompassRect,
  DebugMode,
  HandTileRef,
  HeroReport,
  HitRect,
  QualityTier,
  TableRenderer,
  TableSnapshot,
} from './contract';
import { legendFor } from './debugLegend';
import type { DebugLegend } from './debugLegend';
import {
  BOARD_FAILED_EVENT,
  BOARD_READY_EVENT,
  HERO_FAILED_EVENT,
  HERO_READY_EVENT,
} from './contract';
import { TableCompass, TableOverlay } from './overlay';
import type { OverlayHandTile } from './handOverlay';
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
  /** Call Riichi is armed: the projected hand buttons say so (3D-08). */
  readonly callRiichi?: boolean;
  /** Call Kan is armed: the projected hand buttons say so (3D-08). */
  readonly callKan?: boolean;
  /**
   * The hand-click handler the stacked/top-down views use (App's `selectTile`).
   * The overlay is rendered only when this is supplied; the answer flow itself
   * lives in the store, so disposing the renderer cannot break it.
   */
  readonly onSelectTile?: (
    tile: string,
    index?: number,
    isDraw?: boolean,
  ) => void;
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
 * The 3D-05 hero HUD: the numbers the debug view measured, printed as numbers.
 *
 * It exists so the handoff (AGENTS.md §6) can be about taste rather than
 * mystery: the probe colours and their ΔE, the incidence angle and parallax
 * displacement of each slot, the step count and the carve depth, plus the
 * POM-off comparison, all come from `heroReport()`.
 */
interface HeroHudProps {
  readonly report: HeroReport | null;
  readonly exported: number;
  readonly onRefresh: () => void;
  readonly onExport: () => void;
}

function HeroHud({ report, exported, onRefresh, onExport }: HeroHudProps) {
  return (
    <aside className="renderer-3d-hero" aria-label="3D hero tile measurements">
      <h3 className="renderer-3d-hero-title">Hero tile · numeric report</h3>
      {!report && <p className="renderer-3d-hero-note">Loading the carved tile…</p>}
      {report && (
        <>
          <dl className="renderer-3d-hero-facts">
            <dt>relief</dt>
            <dd>{report.relief}</dd>
            <dt>tier / steps</dt>
            <dd>
              {report.tier} / {report.pomSteps}
            </dd>
            <dt>carve</dt>
            <dd>
              {report.carveDepthMm} mm × {report.heightScale.toFixed(2)} · clamp{' '}
              {report.maxParallaxTexels} texels
            </dd>
            <dt>aspect</dt>
            <dd>{report.aspect.toFixed(3)}</dd>
          </dl>
          <table className="renderer-3d-hero-table">
            <caption>probe read-backs (5×5 block median)</caption>
            <thead>
              <tr>
                <th scope="col">probe</th>
                <th scope="col">colour</th>
                <th scope="col">target</th>
                <th scope="col">ΔE</th>
                <th scope="col">redness</th>
                <th scope="col">result</th>
              </tr>
            </thead>
            <tbody>
              {report.probes.map((probe) => (
                <tr key={probe.id} data-probe={probe.id} data-pass={probe.pass}>
                  <th scope="row">{probe.label}</th>
                  <td>{probe.hex}</td>
                  <td>{probe.targetHex ?? '—'}</td>
                  <td>{probe.deltaE === null ? '—' : probe.deltaE.toFixed(2)}</td>
                  <td>{probe.redness}</td>
                  <td>{probe.pass ? 'pass' : `FAIL${probe.detail ? `: ${probe.detail}` : ''}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <table className="renderer-3d-hero-table">
            <caption>plate incidence and full-depth parallax</caption>
            <thead>
              <tr>
                <th scope="col">slot</th>
                <th scope="col">angle</th>
                <th scope="col">texels</th>
                <th scope="col">clamp</th>
              </tr>
            </thead>
            <tbody>
              {report.parallax.map((slot) => (
                <tr key={slot.slot}>
                  <th scope="row">{slot.label}</th>
                  <td>{slot.angleDeg.toFixed(2)}°</td>
                  <td>{slot.texels.toFixed(2)}</td>
                  <td>{slot.clamped ? 'bounded' : 'under'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {report.pomOff && (
            <p className="renderer-3d-hero-note">
              POM off (steps 0):{' '}
              {report.pomOff.probes
                .map((probe) => `${probe.id} ${probe.deltaE === null ? probe.hex : `ΔE ${probe.deltaE.toFixed(2)}`}`)
                .join(' · ')}{' '}
              — {report.pomOff.allProbesPass ? 'within tolerance' : 'OUT OF TOLERANCE'}
            </p>
          )}
        </>
      )}
      <div className="renderer-3d-hero-actions">
        <button type="button" onClick={onRefresh}>
          Refresh numbers
        </button>
        <button type="button" onClick={onExport}>
          Export depth sweep (4)
        </button>
      </div>
      {exported > 0 && (
        <p className="renderer-3d-hero-note" role="status">
          {exported} depth-sweep PNGs downloaded (hero-&lt;slot&gt;-depth-sweep.png).
        </p>
      )}
    </aside>
  );
}

function downloadDataUrl(name: string, dataUrl: string): void {
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = name;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/**
 * The 3D-10 carve HUD: the live step counts, the two clamped reaches, each
 * debug mode's channel legend, and the handoff export.
 *
 * It exists so a debug view is a *measurement*: the legend says which channel is
 * what and the numbers say what the tier actually runs, so the user never has to
 * infer either from the picture (AGENTS.md §6). It is debug-only chrome, floats
 * over the scene in the opposite corner from the hero panel, and takes pointer
 * events only inside its own box.
 */
interface CarveHudProps {
  readonly report: CarveReport | null;
  readonly legend: DebugLegend | null;
  readonly exported: number;
  readonly onRefresh: () => void;
  readonly onExport: () => void;
}

function CarveHud({ report, legend, exported, onRefresh, onExport }: CarveHudProps) {
  return (
    <aside
      className="renderer-3d-hero renderer-3d-carve"
      aria-label="3D carve measurements"
    >
      <h3 className="renderer-3d-hero-title">
        Carve debug{legend ? ` · ${legend.label}` : ''}
        {legend ? ` (code ${legend.code})` : ''}
      </h3>
      {!report && <p className="renderer-3d-hero-note">Loading the carved tile…</p>}
      {report && (
        <>
          <dl className="renderer-3d-hero-facts">
            <dt>tier</dt>
            <dd>{report.tier}</dd>
            <dt>depth steps</dt>
            <dd data-stat="pom-steps">{report.pomSteps}</dd>
            <dt>shadow steps</dt>
            <dd data-stat="shadow-steps">{report.shadowSteps}</dd>
            <dt>carve</dt>
            <dd>
              {report.carveDepthMm} mm × {report.heightScale.toFixed(2)} · parallax clamp{' '}
              {report.maxParallaxTexels} texels
            </dd>
            <dt>shadow</dt>
            <dd>
              strength {report.shadowStrength.toFixed(2)} · bias {report.shadowBias.toFixed(3)} ·
              softness {report.shadowSoftness.toFixed(2)} · clamp {report.shadowMaxTexels} texels
            </dd>
          </dl>
          <table className="renderer-3d-hero-table">
            <caption>worst-case carve offsets over the face-up tiles</caption>
            <thead>
              <tr>
                <th scope="col">term</th>
                <th scope="col">surface</th>
                <th scope="col">angle</th>
                <th scope="col">texels</th>
                <th scope="col">clamp</th>
              </tr>
            </thead>
            <tbody>
              {[report.parallax, report.shadow].map((reading) => (
                <tr key={reading.id}>
                  <th scope="row">{reading.id.split(':')[0]}</th>
                  <td>{reading.label}</td>
                  <td>{reading.angleDeg.toFixed(2)}°</td>
                  <td>{reading.texels.toFixed(2)}</td>
                  <td>{reading.clamped ? 'bounded' : 'under'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {legend && <p className="renderer-3d-hero-note">{legend.legend}</p>}
        </>
      )}
      <div className="renderer-3d-hero-actions">
        <button type="button" onClick={onRefresh}>
          Refresh numbers
        </button>
        <button type="button" onClick={onExport}>
          Export carve sheets (4K)
        </button>
      </div>
      {exported > 0 && (
        <p className="renderer-3d-hero-note" role="status">
          {exported} 4K state sheets downloaded (carve-&lt;view&gt;-states.png).
        </p>
      )}
    </aside>
  );
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
  callRiichi = false,
  callKan = false,
  onSelectTile,
}: RendererHostProps) {
  const headingId = useId();
  const descriptionId = useId();
  const statusId = useId();
  const viewportRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<TableRenderer | null>(null);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  const [status, setStatus] = useState<HostStatus>({ state: 'idle', message: null });
  const [heroReport, setHeroReport] = useState<HeroReport | null>(null);
  const [heroExported, setHeroExported] = useState(0);
  const [carveReport, setCarveReport] = useState<CarveReport | null>(null);
  const [carveExported, setCarveExported] = useState(0);
  const [hitRects, setHitRects] = useState<readonly HitRect[]>([]);
  const [compassRect, setCompassRect] = useState<CompassRect | null>(null);

  /**
   * Re-read the renderer's pure projection. Called after everything that can
   * move a tile: a new snapshot, a resize, and the board/context becoming
   * current. It never draws and never creates DOM.
   */
  const refreshHitRects = useCallback(() => {
    setHitRects(rendererRef.current?.hitRects() ?? []);
    setCompassRect(rendererRef.current?.compassRect?.() ?? null);
  }, []);

  const reportHoverTile = useCallback((tile: OverlayHandTile | null) => {
    const ref: HandTileRef | null = tile
      ? { seat: tile.seat, zone: tile.zone, slot: tile.slot }
      : null;
    rendererRef.current?.setHoverTile?.(ref);
  }, []);

  const refreshHero = useCallback(() => {
    setHeroReport(rendererRef.current?.heroReport?.() ?? null);
  }, []);

  const exportHero = useCallback(() => {
    const captures = rendererRef.current?.heroCaptures?.() ?? [];
    for (const capture of captures) {
      downloadDataUrl(capture.name, capture.pngDataUrl);
    }
    setHeroExported(captures.length);
    refreshHero();
  }, [refreshHero]);

  const refreshCarve = useCallback(() => {
    setCarveReport(rendererRef.current?.carveReport?.() ?? null);
  }, []);

  const exportCarve = useCallback(() => {
    const captures = rendererRef.current?.carveCaptures?.() ?? [];
    for (const capture of captures) {
      downloadDataUrl(capture.name, capture.pngDataUrl);
    }
    setCarveExported(captures.length);
    refreshCarve();
  }, [refreshCarve]);

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

    setHeroReport(null);
    setHeroExported(0);
    setCarveReport(null);
    setCarveExported(0);

    const measure = () => {
      if (!renderer) return;
      // clientWidth/Height are 0 for a display:none or not-yet-laid-out
      // element; a renderer cannot take a zero size, and the next resize will
      // correct it.
      const width = container.clientWidth || container.getBoundingClientRect().width;
      const height = container.clientHeight || container.getBoundingClientRect().height;
      if (width <= 0 || height <= 0) return;
      renderer.setSize(width, height, globalThis.devicePixelRatio || 1);
      // The overlay's rects live in the same solved frame.
      refreshHitRects();
      // The probes and the carve bounds are screen-space / camera-derived: a
      // resize moves them.
      if (debug === 'hero') refreshHero();
      if (debug !== null) refreshCarve();
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
      refreshHitRects();
    };

    canvas.addEventListener('webglcontextlost', onContextLost);
    canvas.addEventListener('webglcontextrestored', onContextRestored);

    // 3D-05's hero view: the scene tells the host when the carved tiles are
    // mounted (and if they failed), so the HUD never polls.
    const onHeroReady = () => {
      setHeroReport(renderer?.heroReport?.() ?? null);
      if (debug !== null) refreshCarve();
    };
    const onFailed = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      setStatus({
        state: 'failed',
        message:
          typeof detail === 'string' && detail.length > 0
            ? detail
            : 'The 3D table could not be built.',
      });
    };
    // 3D-07: the board reports the same way. Ready is just the mount signal
    // (the host is already `ready` by then); a failure replaces the view.
    const onBoardReady = () => {
      if (cancelled) return;
      setStatus({ state: 'ready', message: null });
      refreshHitRects();
      if (debug !== null) refreshCarve();
    };
    canvas.addEventListener(HERO_READY_EVENT, onHeroReady);
    canvas.addEventListener(HERO_FAILED_EVENT, onFailed);
    canvas.addEventListener(BOARD_READY_EVENT, onBoardReady);
    canvas.addEventListener(BOARD_FAILED_EVENT, onFailed);

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
          // 3D-20: MSAA above the compat tier; see `capabilities.MSAA_SAMPLES`.
          antialias: antiAliasFor(resolvedTier),
        });
        rendererRef.current = renderer;
        renderer.syncState(snapshotRef.current);
        measure();
        refreshHitRects();
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
      canvas?.removeEventListener(HERO_READY_EVENT, onHeroReady);
      canvas?.removeEventListener(HERO_FAILED_EVENT, onFailed);
      canvas?.removeEventListener(BOARD_READY_EVENT, onBoardReady);
      canvas?.removeEventListener(BOARD_FAILED_EVENT, onFailed);
      renderer?.dispose();
      renderer = null;
      rendererRef.current = null;
      canvas?.remove();
      canvas = null;
      setHitRects([]);
      setCompassRect(null);
    };
  }, [
    capabilities,
    debug,
    perfHud,
    reducedMotion,
    refreshCarve,
    refreshHero,
    refreshHitRects,
    resolvedTier,
  ]);

  // Redraw on a new snapshot without remounting the renderer, and re-project
  // the hand's buttons: a different hand means different labels and rects.
  useEffect(() => {
    rendererRef.current?.syncState(snapshot);
    refreshHitRects();
  }, [snapshot, refreshHitRects]);

  const showFallback = status.state !== 'ready';
  const describedBy = `${descriptionId}${status.message ? ` ${statusId}` : ''}`;

  return (
    <RendererErrorBoundary
      fallback={fallback}
      onError={(message) => setStatus({ state: 'failed', message })}
    >
      <div className="renderer-3d" data-renderer-state={status.state}>
        <h2 id={headingId} className="renderer-3d-heading">
          3D table view
        </h2>
        <p id={descriptionId} className="renderer-3d-description">
          3D table view. The table is a picture; the hand's tiles are buttons over
          it. Use Tab to move through the hand and Enter or Space to discard.
        </p>
        <div
          ref={viewportRef}
          className="renderer-3d-viewport"
          role="group"
          aria-labelledby={headingId}
          aria-describedby={describedBy}
        />
        <div className="renderer-3d-vignette" aria-hidden="true" />
        {status.state === 'ready' && debug !== 'hero' && onSelectTile && (
          <TableOverlay
            snapshot={snapshot}
            rects={hitRects}
            callRiichi={callRiichi}
            callKan={callKan}
            reducedMotion={reducedMotion}
            onSelectTile={onSelectTile}
            onHoverTile={reportHoverTile}
          />
        )}
        {status.state === 'ready' && debug !== 'hero' && (
          <TableCompass snapshot={snapshot} rect={compassRect} />
        )}
        {showFallback && fallback}
        {debug === 'hero' && status.state === 'ready' && (
          <HeroHud
            report={heroReport}
            exported={heroExported}
            onRefresh={refreshHero}
            onExport={exportHero}
          />
        )}
        {debug !== null && status.state === 'ready' && (
          <CarveHud
            report={carveReport}
            legend={legendFor(debug)}
            exported={carveExported}
            onRefresh={refreshCarve}
            onExport={exportCarve}
          />
        )}
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
