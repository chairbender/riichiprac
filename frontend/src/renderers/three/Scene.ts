/**
 * The three.js scene behind the lazy entry (3D-02; the board from 3D-07).
 *
 * This module is only reachable through the host's `import('./three')`, so no
 * byte of three.js can reach the entry chunk. It owns the renderer, the resize
 * path, the on-demand frame loop and a dispose registry; it owns no game rules
 * and reads no `GameState` (a `TableSnapshot` is the only input).
 *
 * The picture, in draw order:
 *
 * | layer | object | draws |
 * | --- | --- | --- |
 * | felt | one plane (`felt.ts`) | 1 |
 * | contact shadows | one instanced quad layer (`shadows.ts`), transparent | 1 |
 * | tiles | one `InstancedMesh` for the whole board (`boardMesh.ts`) | 1 |
 * | riichi sticks | one instanced box layer (`sticks.ts`) | 1 |
 *
 * Four draw calls in the default debug-off scene, and the tile count does not
 * change that: wall, ponds, hands, melds and dora all ride the same instance
 * buffer (§2.8). The shadows are transparent, so three draws them after the
 * opaque tiles and the depth test keeps them off every tile body.
 *
 * `?renderer=3d&debug=hero` still mounts 3D-05's four hero tiles instead of the
 * board (see `hero.ts`); every other debug mode draws the board, so 3D-10's
 * albedo/height/normal/steps views are the real table.
 *
 * Camera. There is one framing source: 3D-06's `boardLayout.frameForAspect`,
 * solved against the real layout at the current aspect (§2.4). `cameraRig.ts` is
 * only the three `PerspectiveCamera` adapter. The felt is re-sized from the same
 * frame so it still reaches the top and bottom edges.
 *
 * Debug reporting. `heroReport()` re-draws, reads the five probe blocks back with
 * `readPixels` and prints them as numbers; `heroCaptures()` renders the same
 * view with the depth march on and off and returns one PNG per slot. Neither
 * inspects an image or decides whether the tile "looks right" — AGENTS.md §6
 * hands that to the user at `?renderer=3d&debug=hero`.
 */

import {
  AmbientLight,
  Color,
  DirectionalLight,
  HemisphereLight,
  InstancedMesh,
  NoToneMapping,
  PerspectiveCamera,
  SRGBColorSpace,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { Object3D } from 'three';
import { effectiveDevicePixelRatio } from '../capabilities';
import type {
  CompassRect,
  DebugMode,
  GlintReport,
  HandTileRef,
  HeroCapture,
  HeroReport,
  HitRect,
  QualityTier,
  RendererOptions,
  RendererStats,
  SeamReport,
  TableRenderer,
  TableSnapshot,
  TileFaceId,
} from '../contract';
import { BOARD_FAILED_EVENT, BOARD_READY_EVENT, HERO_FAILED_EVENT, HERO_READY_EVENT } from '../contract';
import { CAMERA, LIGHT } from '../layoutConstants';
import { frameForAspect, layoutBoard } from './boardLayout';
import type { BoardLayout, CameraFrame } from './boardLayout';
import {
  buildBoardInstances,
  createBoardMesh,
  instanceFlags,
} from './boardMesh';
import type { BoardInstance, BoardMeshHandle } from './boardMesh';
import { applyFrameToCamera, frameVerticalFieldOfViewDeg } from './cameraRig';
import { createCompassPlate } from './compassPlate';
import type { CompassPlate } from './compassPlate';
import { createFelt, feltSizeForFrame } from './felt';
import type { FeltSurface } from './felt';
import { heroInstances, heroParallaxAt, probeWorldPoint } from './hero';
import type { HeroInstance, HeroSlot } from './hero';
import { withHoverLift } from './hover';
import { compassPlateRect, hitRects as projectHitRects } from './hitTest';
import { sceneLightSpecs } from './lighting';
import { allProbesPass, readProbes } from './probes';
import type { ProbePixelSource, ProbeProjector } from './probes';
import { loadReliefAssets } from './reliefAssets';
import type { ReliefAssets } from './reliefAssets';
import { createReliefTextureFactory } from './reliefTextures';
import type { ReliefGpuTexture } from './reliefTextures';
import { classifyGlintFrame } from './glintProbe';
import type { GlintFrame } from './glintProbe';
import { edgeScans, readEdge, readSeam, seamRasters } from './seamProbe';
import type { SeamPixelSource } from './seamProbe';
import { createShadowLayer, shadowInstances } from './shadows';
import type { ShadowLayer } from './shadows';
import { createStickMesh } from './sticks';
import type { StickMesh } from './sticks';
import {
  CARVE_DEPTH_MM,
  POM_HEIGHT_SCALE_SWEEP,
  POM_MAX_TEXELS,
  POM_STEPS,
  createTileMaterial,
  installShaderErrorTrap,
} from './tileMaterial';
import type { TileMaterialHandle } from './tileMaterial';

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

/** The mounted hero view: the tiles, their material and the relief textures. */
interface HeroView {
  readonly assets: ReliefAssets<ReliefGpuTexture>;
  readonly material: TileMaterialHandle;
  readonly mesh: InstancedMesh;
  readonly geometry: BoardMeshHandle['geometry'];
  readonly instances: readonly HeroInstance[];
}

/** The mounted board: the tile mesh plus its shadow and stick layers. */
interface BoardView {
  readonly assets: ReliefAssets<ReliefGpuTexture>;
  readonly material: TileMaterialHandle;
  readonly tiles: BoardMeshHandle;
  readonly shadows: ShadowLayer;
  readonly sticks: StickMesh;
  readonly plate: CompassPlate;
}

/** The macro capture's square edge, in pixels. */
const HERO_CAPTURE_SIZE = 640;

/** How much of the macro capture's frame the tile body fills. */
const HERO_CAPTURE_FILL = 0.72;

/** The framed extent around a tile in the macro capture, in world units. */
const HERO_CAPTURE_FRAME_UNITS = 1.15;

/**
 * The default debug-off scene's draw-call plan (3D-07, §2.8; 3D-09 adds the
 * compass plate).
 *
 * Five draws, regardless of the snapshot: the felt plane, the contact-shadow
 * quads (one instanced layer), the whole tile board (one instanced mesh), the
 * riichi sticks (one instanced layer) and the physical compass plate. The
 * board's lights cast no shadow maps, so there is no extra depth pass.
 * `measure().drawCalls` reports what the renderer actually issued; the gate test
 * builds the board layers headlessly, counts their meshes, and checks this plan
 * against the 5-call budget.
 */
export const SCENE_DRAW_CALLS = {
  felt: 1,
  shadows: 1,
  tiles: 1,
  sticks: 1,
  compassPlate: 1,
} as const;

/** How many draw calls the default scene plans for. */
export function steadyStateDrawCalls(): number {
  return Object.values(SCENE_DRAW_CALLS).reduce((sum, count) => sum + count, 0);
}

/**
 * The number of draw calls a scene graph of plain/instanced meshes issues.
 *
 * One visible mesh is one call in this scene (no multi-material groups, no
 * lines, no points), so this is the same number three's `info.render.calls`
 * counts for it — which is what lets a GPU-free test assert the budget.
 */
export function countSceneDrawCalls(root: Object3D): number {
  let calls = 0;
  root.traverseVisible((object) => {
    if ((object as { isMesh?: boolean }).isMesh === true) calls += 1;
  });
  return calls;
}

/** The scene's drawable picture plus the renderer the host drives. */
export class TableScene implements TableRenderer {
  private readonly renderer: WebGLRenderer;
  private readonly scene: Scene;
  private readonly camera: PerspectiveCamera;
  private readonly registry = new DisposeRegistry();
  private readonly felt: FeltSurface;
  private readonly canvas: HTMLCanvasElement;
  private hero: HeroView | null = null;
  private heroStarted = false;
  private board: BoardView | null = null;
  private boardStarted = false;
  private layout: BoardLayout | null = null;
  private frame: CameraFrame;
  private tier: QualityTier;
  /** The debug view the host asked for; the glint probe restores it. */
  private debugMode: DebugMode | null;
  private frameHandle: number | null = null;
  private disposed = false;
  private revision = 0;
  private aspect = CAMERA.framingAspect;
  /** The CSS size the frame is solved for; the overlay's rects live in it. */
  private cssWidth = 0;
  private cssHeight = 0;
  /** True once the hand is answered: the overlay renders no buttons. */
  private locked = false;
  /** The hand button the pointer/focus is on, lifted by half a tile height. */
  private hover: HandTileRef | null = null;

  constructor(canvas: HTMLCanvasElement, options: RendererOptions) {
    this.tier = options.tier;
    this.debugMode = options.debug;
    this.canvas = canvas;

    const context = canvas.getContext('webgl2', {
      antialias: options.antialias,
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
    // and what decision D2 requires. 3D-20: `antialias` follows the resolved
    // option, and the buffers genuinely carry it (the seam gate reads
    // `getContextAttributes().antialias` back rather than trusting this line).
    this.renderer = new WebGLRenderer({
      canvas,
      context: context as unknown as WebGLRenderingContext,
      antialias: options.antialias,
      alpha: false,
    });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = NoToneMapping;
    this.renderer.setPixelRatio(1);

    // A compile failure must reach the host as `failed`, not as a silent black
    // tile (3D-05). Installed before anything is compiled.
    installShaderErrorTrap(this.renderer);

    this.scene = new Scene();
    this.scene.background = new Color('#0b1116');

    // One framing source: 3D-06's solved frame (§2.4). The default aspect is
    // the reference frame until the host reports the real element size.
    this.frame = frameForAspect(this.aspect);
    this.camera = new PerspectiveCamera(
      frameVerticalFieldOfViewDeg(this.frame),
      this.frame.aspect,
      CAMERA.clipStartUnits,
      CAMERA.clipEndUnits,
    );

    this.felt = this.registry.add(createFelt());
    this.scene.add(this.felt.mesh);
    this.addLights();

    applyFrameToCamera(this.camera, this.frame);
    this.felt.setSize(feltSizeForFrame(this.frame));

    if (options.debug === 'hero') {
      this.startHero(options);
    } else {
      this.startBoard(options);
    }
    this.requestFrame();
  }

  /** The snapshot revision this scene is showing (3D-12 reads it for the cut rule). */
  get snapshotRevision(): number {
    return this.revision;
  }

  /**
   * Accept a new snapshot: lay it out (3D-06), rewrite the instance buffers and
   * re-solve the frame, because the framing target includes the tiles.
   *
   * Idempotent and O(tiles): the same snapshot produces identical buffers, and
   * no geometry, material or texture is reallocated. A new revision is a cut,
   * never a move (the buffer is replaced wholesale; 3D-12 owns any motion).
   */
  syncState(snapshot: TableSnapshot): void {
    if (this.disposed) return;
    this.revision = snapshot.revision;
    this.locked = snapshot.locked;
    const layout = layoutBoard(snapshot);
    this.layout = layout;
    this.syncBoard(layout);
    // A deeper river or a taller hand can move the solved camera, so the frame
    // and the felt follow the layout, not only the viewport.
    this.reframe();
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
    this.cssWidth = cssWidth;
    this.cssHeight = cssHeight;
    this.aspect = cssWidth / cssHeight;
    this.reframe();
    // Draw now rather than on the next frame: the host reveals the canvas as
    // soon as this returns, and a resize is a discrete change, not a loop.
    this.draw();
  }

  /**
   * Change the quality tier. The tier selects the depth-march step count and the
   * atlas upload scale (3D-11 owns loading a different scale); the felt and the
   * camera are tier-independent.
   */
  setQuality(tier: QualityTier): void {
    this.tier = tier;
    this.hero?.material.setTier(tier);
    this.board?.material.setTier(tier);
    this.requestFrame();
  }

  /**
   * The pure projection of the human's hand and draw to CSS rects (3D-08).
   *
   * Uses the scene's own solved frame — `boardLayout.frameForAspect` at the
   * current aspect and layout — so the DOM buttons and the rendered instances
   * cannot drift apart (plan §2.4, §9 R7). It creates no DOM and draws nothing.
   */
  hitRects(): readonly HitRect[] {
    if (this.disposed || !this.layout) return [];
    return projectHitRects(
      this.layout,
      this.frame,
      { widthPx: this.cssWidth, heightPx: this.cssHeight },
      { locked: this.locked },
    );
  }

  /**
   * The projected compass plate, for the DOM compass (3D-09).
   *
   * The same solved frame and CSS stage `hitRects()` uses, so the seat groups
   * and the round/tiles-left group sit on the rendered square and cannot drift
   * from the camera (plan §2.4/§2.7). Pure: it creates no DOM and draws nothing.
   */
  compassRect(): CompassRect | null {
    if (this.disposed || !this.layout) return null;
    return compassPlateRect(this.frame, {
      widthPx: this.cssWidth,
      heightPx: this.cssHeight,
    });
  }

  /**
   * 3D-12's hover lift, landed here because 3D-08 owns the report and the user
   * asked for it now: the hovered/focused hand tile rises half a tile height
   * (14 mm) on top of the DOM button's tint. The button does not move; its rect
   * comes from the un-lifted pose (see `hitTest.ts`), so the pointer stays on
   * the same target while the tile rises beneath it.
   */
  setHoverTile(tile: HandTileRef | null): void {
    const current = this.hover;
    if (
      current === tile ||
      (current !== null &&
        tile !== null &&
        current.seat === tile.seat &&
        current.zone === tile.zone &&
        current.slot === tile.slot)
    ) {
      return;
    }
    this.hover = tile;
    if (this.layout) this.syncTiles(this.layout);
    this.requestFrame();
  }

  /** Reserved for a future live/replay source; v1 draws no tile motion. */
  playEvents(): void {
    // Intentionally empty: see contract.ts. No caller in v1, and 3D-12 proves
    // the host never calls it.
  }

  /** The numbers the perf HUD and the budget gate read (final in 3D-13). */
  measure(): RendererStats {
    const info = this.renderer.info.render;
    const view = this.board ?? this.hero;
    return {
      tier: this.tier,
      drawCalls: info.calls,
      triangles: info.triangles,
      instances: this.board?.tiles.count ?? this.hero?.mesh.count ?? 0,
      atlasBytes: view?.assets.atlasBytes ?? 0,
      relief: view?.assets.status,
      reliefVerification: view?.assets.verification ?? null,
      pomSteps: view?.material.pomSteps(),
      frameMsP50: 0,
      frameMsP95: 0,
    };
  }

  /**
   * The hero view's measured numbers, or null when the hero tiles are not
   * mounted. Re-draws first: `preserveDrawingBuffer` is false, so the pixels are
   * only readable in the same task as the draw.
   */
  heroReport(): HeroReport | null {
    const hero = this.hero;
    if (!hero || this.disposed) return null;

    this.draw();
    const probes = this.readProbeSet();
    const liveSteps = hero.material.pomSteps();
    let pomOff: HeroReport['pomOff'] = null;
    if (liveSteps > 0) {
      hero.material.setPomSteps(0);
      this.draw();
      const offProbes = this.readProbeSet();
      hero.material.setPomSteps(liveSteps);
      this.draw();
      pomOff = { probes: offProbes, allProbesPass: allProbesPass(offProbes) };
    }

    const heightScale = hero.material.heightScale();
    const parallax = heroParallaxAt(this.aspect, heightScale);
    return {
      relief: hero.assets.status,
      tier: this.tier,
      pomSteps: liveSteps,
      carveDepthMm: CARVE_DEPTH_MM,
      heightScale,
      maxParallaxTexels: POM_MAX_TEXELS,
      aspect: this.aspect,
      parallax: parallax.slots.map((slot) => ({
        slot: slot.slot,
        label: slot.label,
        angleDeg: slot.angleDeg,
        texels: slot.texels,
        clamped: slot.clamped,
      })),
      probes,
      allProbesPass: allProbesPass(probes),
      pomOff,
    };
  }

  /**
   * The seam probe (3D-20): read a scanline across four known inter-tile
   * grooves and report the numbers the white-seam defect is made of.
   *
   * Re-draws first (`preserveDrawingBuffer` is false), then for each seam reads
   * the samples `seamProbe.ts` projected and reduces them to a contrast and a
   * depth. Nothing here decides whether the table "looks right"; it prints
   * whether any groove pixel is brighter than the face beside it, which is the
   * defect, and what colour the brightest one is, which is the cause.
   *
   * Returns null before the board is mounted (or in the hero view, which draws
   * no seams).
   */
  seamReport(): SeamReport | null {
    if (!this.board || this.disposed) return null;
    this.draw();
    const gl = this.renderer.getContext();
    const size = this.renderer.getDrawingBufferSize(new Vector2());
    const attributes = gl.getContextAttributes();
    const antialias = attributes ? attributes.antialias !== false : false;

    const source: SeamPixelSource = {
      width: size.x,
      height: size.y,
      read(x, y, width, height) {
        const pixels = new Uint8Array(width * height * 4);
        // `readPixels` is bottom-up; the probe's samples are y-down, so read
        // the flipped block and flip it back here.
        gl.readPixels(x, size.y - (y + height), width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        const flipped = new Uint8Array(pixels.length);
        const rowBytes = width * 4;
        for (let row = 0; row < height; row += 1) {
          flipped.set(
            pixels.subarray((height - 1 - row) * rowBytes, (height - row) * rowBytes),
            row * rowBytes,
          );
        }
        return flipped;
      },
    };

    const rasters = this.layout
      ? seamRasters(this.layout, this.frame, size.x, size.y)
      : [];
    const seams = rasters.map((raster) => readSeam(source, raster));
    const scans = this.layout ? edgeScans(this.layout, this.frame, size.x, size.y) : [];
    const edge = scans.length ? readEdge(source, scans) : null;
    return {
      antialias,
      widthPx: size.x,
      heightPx: size.y,
      drawCalls: this.renderer.info.render.calls,
      seams,
      allSeamsPass: seams.length > 0 && seams.every((seam) => seam.pass),
      edge,
    };
  }

  /**
   * The glint probe (3D-20 follow-up): which surface family drew each bright
   * pixel, from two draws of the same board — the lit frame, then
   * `?debug=flags`, whose RGB is the shader's own branch state.
   *
   * Re-draws and reads back in the same task (`preserveDrawingBuffer` is false),
   * restores the live debug view afterwards, and returns null outside the board
   * view.
   */
  glintReport(): GlintReport | null {
    if (!this.board || this.disposed) return null;
    const material = this.board.material;
    const liveDebug = this.debugMode;
    const read = (): GlintFrame => {
      this.draw();
      const size = this.renderer.getDrawingBufferSize(new Vector2());
      const gl = this.renderer.getContext();
      const raw = new Uint8Array(size.x * size.y * 4);
      gl.readPixels(0, 0, size.x, size.y, gl.RGBA, gl.UNSIGNED_BYTE, raw);
      // `readPixels` is bottom-up; the classifier's rows must match each other,
      // so both frames are flipped the same way.
      const data = new Uint8Array(raw.length);
      const rowBytes = size.x * 4;
      for (let row = 0; row < size.y; row += 1) {
        data.set(
          raw.subarray((size.y - 1 - row) * rowBytes, (size.y - row) * rowBytes),
          row * rowBytes,
        );
      }
      return { data, width: size.x, height: size.y };
    };
    try {
      material.setDebug(liveDebug);
      const lit = read();
      material.setDebug('flags');
      const flags = read();
      return {
        widthPx: lit.width,
        heightPx: lit.height,
        ...classifyGlintFrame(lit, flags),
      };
    } finally {
      material.setDebug(liveDebug);
      this.requestFrame();
    }
  }

  /**
   * One PNG per hero slot for the 3D-05 user handoff: a **depth sweep** of that
   * slot.
   *
   * Each capture is a macro shot on the slot's real incidence ray (the direction
   * from the tile to the committed eye, which is what the parallax depends on)
   * with the camera moved in to frame the body. Four panels per slot show the
   * depth-march scale {@link POM_HEIGHT_SCALE_SWEEP} (0 = POM off, 1 = the full
   * physical 0.55 mm groove), labelled in the image, so the approved 2.5D decal
   * look can be matched by eye against a fixed set of candidates. Nothing here
   * decides which one is right.
   */
  heroCaptures(): readonly HeroCapture[] {
    const hero = this.hero;
    if (!hero || this.disposed) return [];
    const liveSteps = hero.material.pomSteps();
    const liveScale = hero.material.heightScale();
    const onSteps = liveSteps > 0 ? liveSteps : POM_STEPS[this.tier];

    const cssSize = this.renderer.getSize(new Vector2());
    const liveRatio = this.renderer.getPixelRatio();
    const captures: HeroCapture[] = [];
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(HERO_CAPTURE_SIZE, HERO_CAPTURE_SIZE, false);
    try {
      for (const instance of hero.instances) {
        const panels: ImageData[] = [];
        for (const scale of POM_HEIGHT_SCALE_SWEEP) {
          hero.material.setHeightScale(scale);
          hero.material.setPomSteps(scale === 0 ? 0 : onSteps);
          this.applyHeroCaptureCamera(instance.slot);
          this.draw();
          const image = this.readImageBlock({
            x: 0,
            y: 0,
            width: HERO_CAPTURE_SIZE,
            height: HERO_CAPTURE_SIZE,
          });
          if (!image) break;
          panels.push(image);
        }
        if (panels.length !== POM_HEIGHT_SCALE_SWEEP.length) continue;
        const png = composeDepthSweep(instance.slot.label, panels, POM_HEIGHT_SCALE_SWEEP);
        if (!png) continue;
        captures.push({
          name: `hero-${instance.slot.id}-depth-sweep.png`,
          pngDataUrl: png.dataUrl,
          width: png.width,
          height: png.height,
        });
      }
    } finally {
      hero.material.setPomSteps(liveSteps);
      hero.material.setHeightScale(liveScale);
      this.renderer.setPixelRatio(liveRatio);
      this.renderer.setSize(cssSize.x, cssSize.y, false);
      applyFrameToCamera(this.camera, this.frame);
      this.draw();
    }
    return captures;
  }

  /**
   * Point the camera down the slot's own incidence ray at macro distance. The
   * direction from the tile to the committed eye is kept exactly, so the plate's
   * angle to the view (and therefore the parallax) is the board's.
   */
  private applyHeroCaptureCamera(slot: HeroSlot): void {
    // The committed eye, not the camera's current (macro) position: every slot
    // and both POM states must use the board's own incidence ray.
    const eye = new Vector3(...frameForAspect(this.aspect).eye);
    const centre = new Vector3(...slot.pose.position);
    const direction = eye.sub(centre).normalize();
    const fovYDeg = frameVerticalFieldOfViewDeg(frameForAspect(1));
    const halfFov = (fovYDeg * Math.PI) / 360;
    const distance =
      HERO_CAPTURE_FRAME_UNITS / 2 / (HERO_CAPTURE_FILL * Math.tan(halfFov));
    this.camera.fov = fovYDeg;
    this.camera.aspect = 1;
    this.camera.near = 0.1;
    this.camera.far = CAMERA.clipEndUnits;
    this.camera.position.copy(centre.clone().addScaledVector(direction, distance));
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(centre);
    this.camera.updateProjectionMatrix();
  }

  /** Cancel the frame, release every registered resource and the renderer. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frameHandle !== null) {
      globalThis.cancelAnimationFrame?.(this.frameHandle);
      this.frameHandle = null;
    }
    this.hero = null;
    this.board = null;
    this.hover = null;
    this.registry.disposeAll();
    this.scene.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  private addLights(): void {
    for (const spec of sceneLightSpecs()) {
      if (spec.kind === 'key' && spec.direction) {
        const [x, y, z] = spec.direction;
        const light = new DirectionalLight(new Color(spec.colorHex), spec.intensity);
        light.position.set(x * 30, y * 30, z * 30);
        light.name = 'key';
        this.scene.add(light);
      } else if (spec.kind === 'fill') {
        const light = new HemisphereLight(
          new Color(spec.colorHex),
          new Color(spec.groundHex ?? LIGHT.keyHex),
          spec.intensity,
        );
        light.name = 'fill';
        this.scene.add(light);
      } else {
        const light = new AmbientLight(new Color(spec.colorHex), spec.intensity);
        light.name = 'ambient';
        this.scene.add(light);
      }
    }
  }

  /**
   * Re-solve the camera and the felt for the current aspect and layout. The only
   * place this class touches the frame, so no second framing can appear.
   */
  private reframe(): void {
    this.frame = frameForAspect(this.aspect, this.layout ?? undefined);
    applyFrameToCamera(this.camera, this.frame);
    // The felt is a square that reaches the top and bottom edges, so it is
    // re-sized with the framing; it is never stretched to the aspect.
    this.felt.setSize(feltSizeForFrame(this.frame));
  }

  /** Rewrite the board's instance buffers for a new layout, if mounted. */
  private syncBoard(layout: BoardLayout): void {
    const board = this.board;
    if (!board) return;
    this.syncTiles(layout);
    board.shadows.sync(shadowInstances(layout));
    board.sticks.sync(layout.sticks);
  }

  /**
   * Rewrite the tile instances only, applying the current hover lift.
   *
   * The atlas cells are looked up per face; `withHoverLift` copies just the
   * hovered instance's matrix, so the rest of the buffer is byte-identical and
   * a hover change cannot disturb any other tile.
   */
  private syncTiles(layout: BoardLayout): void {
    const board = this.board;
    if (!board) return;
    board.tiles.sync(
      withHoverLift(
        buildBoardInstances(layout, (face: TileFaceId) =>
          board.assets.cellForFace(face),
        ),
        layout,
        this.hover,
      ),
    );
  }

  /** Load the committed relief atlases and mount the four hero tiles. */
  private startHero(options: RendererOptions): void {
    if (this.heroStarted) return;
    this.heroStarted = true;
    this.loadRelief(options)
      .then((assets) => {
        if (this.disposed || !assets) return;
        this.buildHero(assets, options);
      })
      .catch((error: unknown) => {
        this.reportFailure(HERO_FAILED_EVENT, error);
      });
  }

  /** Load the committed relief atlases and mount the board. */
  private startBoard(options: RendererOptions): void {
    if (this.boardStarted) return;
    this.boardStarted = true;
    this.loadRelief(options)
      .then((assets) => {
        if (this.disposed || !assets) return;
        this.buildBoard(assets, options);
      })
      .catch((error: unknown) => {
        this.reportFailure(BOARD_FAILED_EVENT, error);
      });
  }

  /**
   * Load 3D-03's bridge, or resolve null when the view was disposed mid-load
   * (the caller disposes the assets it received).
   */
  private loadRelief(
    options: RendererOptions,
  ): Promise<ReliefAssets<ReliefGpuTexture> | null> {
    const maxAnisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const baseUrl =
      typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL
        ? String(import.meta.env.BASE_URL)
        : '/';
    return loadReliefAssets<ReliefGpuTexture>({
      tier: options.tier,
      baseUrl,
      maxAnisotropy,
      createTexture: createReliefTextureFactory(maxAnisotropy),
    }).then((assets) => {
      if (this.disposed) {
        assets.dispose();
        return null;
      }
      return assets;
    });
  }

  private buildHero(assets: ReliefAssets<ReliefGpuTexture>, options: RendererOptions): void {
    const material = createTileMaterial({
      tier: options.tier,
      debug: options.debug,
      albedo: assets.textures.albedo,
      normalDepth: assets.textures.normalDepth,
      aoRoughness: assets.textures.aoRoughness,
    });

    const instances = heroInstances((face) => assets.cellForFace(face));
    // One geometry per mesh: the instanced attributes live on it. The hero view
    // allocates exactly its four slots; the board allocates the full capacity.
    const board = createBoardMesh(
      instances.map((instance): BoardInstance => ({
        id: instance.slot.id,
        matrix: instance.matrix,
        atlasRect: instance.atlasRect ?? [0, 0, 1, 1],
        flags: instanceFlags({
          faceUp: instance.slot.faceUp,
          highlighted: false,
          dimmed: false,
        }),
        face: instance.slot.face,
      })),
      material,
      Math.max(1, instances.length),
    );
    const mesh = board.mesh;
    mesh.name = 'hero-tiles';

    this.scene.add(mesh);

    // The registry owns both lifetimes; the hero view keeps the live handles.
    this.registry.add(assets);
    this.registry.add(material);
    this.registry.add(board);
    this.hero = {
      assets,
      material,
      mesh,
      geometry: board.geometry,
      instances,
    };

    // Compile now, in the load path, so a broken program throws into the
    // promise's catch and the host reports `failed` before the first frame.
    this.renderer.compile(this.scene, this.camera);
    this.draw();
    this.canvas.dispatchEvent(new CustomEvent(HERO_READY_EVENT));
  }

  private buildBoard(assets: ReliefAssets<ReliefGpuTexture>, options: RendererOptions): void {
    const material = createTileMaterial({
      tier: options.tier,
      debug: options.debug,
      albedo: assets.textures.albedo,
      normalDepth: assets.textures.normalDepth,
      aoRoughness: assets.textures.aoRoughness,
    });
    const layout = this.layout;
    const tiles = createBoardMesh(
      layout
        ? withHoverLift(
            buildBoardInstances(layout, (face) => assets.cellForFace(face)),
            layout,
            this.hover,
          )
        : [],
      material,
    );
    const shadows = createShadowLayer(layout ? shadowInstances(layout) : []);
    const sticks = createStickMesh(layout?.sticks ?? []);
    // The compass square is table furniture (3D-09): real geometry in
    // perspective, with only its numbers as screen-space DOM over it.
    const plate = createCompassPlate();

    this.scene.add(plate.mesh);
    this.scene.add(shadows.mesh);
    this.scene.add(tiles.mesh);
    this.scene.add(sticks.mesh);

    this.registry.add(assets);
    this.registry.add(material);
    this.registry.add(tiles);
    this.registry.add(shadows);
    this.registry.add(sticks);
    this.registry.add(plate);
    this.board = { assets, material, tiles, shadows, sticks, plate };

    // A snapshot that arrived before the atlases is already laid out; frame it
    // now so the camera and the felt match the board.
    this.reframe();
    this.renderer.compile(this.scene, this.camera);
    this.draw();
    this.canvas.dispatchEvent(new CustomEvent(BOARD_READY_EVENT));
  }

  private reportFailure(event: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (this.disposed) return;
    this.canvas.dispatchEvent(new CustomEvent(event, { detail: message }));
  }

  /** Read the five probe blocks from the current frame. */
  private readProbeSet(): ReturnType<typeof readProbes> {
    const gl = this.renderer.getContext();
    const size = this.renderer.getDrawingBufferSize(new Vector2());
    this.camera.updateMatrixWorld();
    const camera = this.camera;
    const projector: ProbeProjector = {
      project(definition) {
        const world = probeWorldPoint(definition.point);
        const projected = new Vector3(world[0], world[1], world[2]).project(camera);
        if (
          !Number.isFinite(projected.x) ||
          !Number.isFinite(projected.y) ||
          projected.z < -1 ||
          projected.z > 1
        ) {
          return null;
        }
        return {
          x: (projected.x * 0.5 + 0.5) * size.x,
          y: (projected.y * 0.5 + 0.5) * size.y,
        };
      },
    };
    const source: ProbePixelSource = {
      width: size.x,
      height: size.y,
      read(x, y, width, height) {
        const pixels = new Uint8Array(width * height * 4);
        gl.readPixels(x, y, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        return pixels;
      },
    };
    return readProbes(source, projector);
  }

  /** Read a block of the current frame as top-down RGBA pixels. */
  private readImageBlock(rect: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }): ImageData | null {
    if (typeof document === 'undefined') return null;
    const gl = this.renderer.getContext();
    const pixels = new Uint8Array(rect.width * rect.height * 4);
    gl.readPixels(
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      pixels,
    );
    const canvas = document.createElement('canvas');
    canvas.width = rect.width;
    canvas.height = rect.height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    const image = context.createImageData(rect.width, rect.height);
    // `readPixels` is bottom-up; an ImageData is top-down.
    const rowBytes = rect.width * 4;
    for (let row = 0; row < rect.height; row += 1) {
      const sourceStart = (rect.height - 1 - row) * rowBytes;
      image.data.set(
        pixels.subarray(sourceStart, sourceStart + rowBytes),
        row * rowBytes,
      );
    }
    return image;
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

/**
 * Paste the depth-sweep panels into one labelled strip: one image per slot, so
 * the user can pick the displacement scale against the 2.5D decals without
 * having to line up eight separate downloads. Labelling is DOM canvas work,
 * never a judgement about the render.
 */
function composeDepthSweep(
  label: string,
  panels: readonly ImageData[],
  scales: readonly number[],
): { readonly dataUrl: string; readonly width: number; readonly height: number } | null {
  if (typeof document === 'undefined' || panels.length === 0) return null;
  const panelWidth = panels[0].width;
  const panelHeight = panels[0].height;
  const captionHeight = 32;
  const canvas = document.createElement('canvas');
  canvas.width = panelWidth * panels.length;
  canvas.height = panelHeight + captionHeight;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.fillStyle = '#0b1116';
  context.fillRect(0, 0, canvas.width, canvas.height);
  panels.forEach((panel, index) => {
    context.putImageData(panel, index * panelWidth, captionHeight);
    context.fillStyle = '#e7ecf3';
    context.font = '20px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    const scale = scales[index] ?? 0;
    context.fillText(
      `${label} · depth scale ${scale.toFixed(2)}${scale === 0 ? ' (POM off)' : ''}`,
      index * panelWidth + 12,
      22,
    );
  });
  return {
    dataUrl: canvas.toDataURL('image/png'),
    width: canvas.width,
    height: canvas.height,
  };
}
