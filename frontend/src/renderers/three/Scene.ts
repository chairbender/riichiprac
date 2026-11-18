/**
 * The three.js scene behind the lazy entry (3D-02).
 *
 * This module is only reachable through the host's `import('./three')`, so no
 * byte of three.js can reach the entry chunk. It owns the renderer, the resize
 * path, the on-demand frame loop and a dispose registry; it owns no game rules
 * and reads no `GameState` (a `TableSnapshot` is the only input).
 *
 * The scene as of this unit is the felt plane and its lights. The board mesh
 * arrives in 3D-07, the DOM overlay's hit rects in 3D-08, motion in 3D-12 and
 * the perf HUD in 3D-13; those units add to this shell rather than replace it.
 */

import {
  AmbientLight,
  Color,
  DirectionalLight,
  HemisphereLight,
  NoToneMapping,
  PerspectiveCamera,
  SRGBColorSpace,
  Scene,
  WebGLRenderer,
} from 'three';
import { effectiveDevicePixelRatio } from '../capabilities';
import type {
  HitRect,
  QualityTier,
  RendererOptions,
  RendererStats,
  TableRenderer,
  TableSnapshot,
} from '../contract';
import { CAMERA, LIGHT } from '../layoutConstants';
import { applyPoseToCamera, rigPoseForAspect, verticalFieldOfViewDeg } from './cameraRig';
import { createFelt } from './felt';
import type { FeltSurface } from './felt';

/** Something that releases a GPU resource when the view unmounts. */
export interface Disposable {
  dispose(): void;
}

/**
 * The dispose registry. Every geometry, material and texture the scene creates
 * is added here, so teardown is one call and a test can assert the live count
 * returns to zero. `disposeAll` is idempotent: it drains the list.
 */
export class DisposeRegistry {
  private readonly resources: Disposable[] = [];

  /** Track a resource and return it, so it can be used inline. */
  add<T extends Disposable>(resource: T): T {
    this.resources.push(resource);
    return resource;
  }

  /** How many resources are still owned (zero after {@link disposeAll}). */
  get size(): number {
    return this.resources.length;
  }

  /** Release every tracked resource, newest first. */
  disposeAll(): void {
    while (this.resources.length > 0) {
      this.resources.pop()?.dispose();
    }
  }
}

/** The scene's drawable picture plus the renderer the host drives. */
export class TableScene implements TableRenderer {
  private readonly renderer: WebGLRenderer;
  private readonly scene: Scene;
  private readonly camera: PerspectiveCamera;
  private readonly registry = new DisposeRegistry();
  private readonly felt: FeltSurface;
  private tier: QualityTier;
  private frameHandle: number | null = null;
  private disposed = false;
  private revision = 0;

  constructor(canvas: HTMLCanvasElement, options: RendererOptions) {
    this.tier = options.tier;

    const context = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: true,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    if (!context) {
      throw new Error('3D table: WebGL2 is not available on this canvas');
    }

    // three's parameter is typed for WebGL1; a WebGL2 context is what it wants
    // and what decision D2 requires.
    this.renderer = new WebGLRenderer({
      canvas,
      context: context as unknown as WebGLRenderingContext,
      antialias: false,
      alpha: false,
    });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = NoToneMapping;
    this.renderer.setPixelRatio(1);

    this.scene = new Scene();
    this.scene.background = new Color('#0b1116');
    this.camera = new PerspectiveCamera(
      verticalFieldOfViewDeg(16 / 9),
      16 / 9,
      CAMERA.clipStartUnits,
      CAMERA.clipEndUnits,
    );

    this.felt = this.registry.add(createFelt());
    this.scene.add(this.felt.mesh);
    this.addLights();

    // A default 16:9 pose until the host reports the real element size.
    applyPoseToCamera(this.camera, rigPoseForAspect(16 / 9));
    this.requestFrame();
  }

  /** The snapshot revision this scene is showing (3D-12 reads it for the cut rule). */
  get snapshotRevision(): number {
    return this.revision;
  }

  /**
   * Accept a new snapshot. The empty scene draws only the felt, but the
   * revision is recorded now so 3D-12's "a new revision is a cut, never a move"
   * rule has one owner, and the frame is redrawn so a later board cannot be
   * stale.
   */
  syncState(snapshot: TableSnapshot): void {
    this.revision = snapshot.revision;
    this.requestFrame();
  }

  /** Resize the backing store (area-capped) and re-solve the camera framing. */
  setSize(cssWidth: number, cssHeight: number, dpr: number): void {
    if (this.disposed) return;
    if (
      !Number.isFinite(cssWidth) ||
      !Number.isFinite(cssHeight) ||
      cssWidth <= 0 ||
      cssHeight <= 0
    ) {
      return;
    }
    const ratio = effectiveDevicePixelRatio(cssWidth, cssHeight, dpr);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(cssWidth, cssHeight, false);
    applyPoseToCamera(this.camera, rigPoseForAspect(cssWidth / cssHeight));
    // Draw now rather than on the next frame: the host reveals the canvas as
    // soon as this returns, and a resize is a discrete change, not a loop.
    this.draw();
  }

  /**
   * Change the quality tier. The tier only selects shader and sampling budgets
   * (3D-11); the felt and the camera are tier-independent, so nothing is
   * rebuilt here.
   */
  setQuality(tier: QualityTier): void {
    this.tier = tier;
  }

  /** No interactive tiles exist before 3D-08. */
  hitRects(): readonly HitRect[] {
    return [];
  }

  /** Reserved for a future live/replay source; v1 draws no tile motion. */
  playEvents(): void {
    // Intentionally empty: see contract.ts. No caller in v1, and 3D-12 proves
    // the host never calls it.
  }

  /** The numbers the perf HUD and the budget gate read (final in 3D-13). */
  measure(): RendererStats {
    const info = this.renderer.info.render;
    return {
      tier: this.tier,
      drawCalls: info.calls,
      triangles: info.triangles,
      instances: 0,
      atlasBytes: 0,
      frameMsP50: 0,
      frameMsP95: 0,
    };
  }

  /** Cancel the frame, release every registered resource and the renderer. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frameHandle !== null) {
      globalThis.cancelAnimationFrame?.(this.frameHandle);
      this.frameHandle = null;
    }
    this.registry.disposeAll();
    this.scene.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  private addLights(): void {
    const [x, y, z] = LIGHT.keyDirection;
    const key = new DirectionalLight(new Color(LIGHT.keyHex), 3);
    key.position.set(x * 30, y * 30, z * 30);
    this.scene.add(key);

    // A cool, very low fill and ambient so the felt has shape but the key still
    // owns the highlight, matching the 2.5D rig's intent.
    this.scene.add(new HemisphereLight(new Color('#cfe0ff'), new Color('#0b1512'), 0.5));
    this.scene.add(new AmbientLight(new Color('#ffffff'), 0.15));
  }

  /** Draw on the next frame, coalescing multiple change notifications. */
  private requestFrame(): void {
    if (this.disposed || this.frameHandle !== null) return;
    const schedule = globalThis.requestAnimationFrame;
    if (typeof schedule !== 'function') {
      // No animation clock (an exotic embed): draw synchronously rather than
      // leaving the canvas blank.
      this.draw();
      return;
    }
    this.frameHandle = schedule(() => {
      this.frameHandle = null;
      this.draw();
    });
  }

  private draw(): void {
    if (this.disposed) return;
    this.renderer.render(this.scene, this.camera);
  }
}
