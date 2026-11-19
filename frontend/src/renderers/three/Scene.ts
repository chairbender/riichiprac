/**
 * The three.js scene behind the lazy entry (3D-02, hero view 3D-05).
 *
 * This module is only reachable through the host's `import('./three')`, so no
 * byte of three.js can reach the entry chunk. It owns the renderer, the resize
 * path, the on-demand frame loop and a dispose registry; it owns no game rules
 * and reads no `GameState` (a `TableSnapshot` is the only input).
 *
 * As of 3D-05 the scene is the felt, its lights, and — only under
 * `?renderer=3d&debug=hero` — the four hero tiles in their real committed
 * attitudes (see `hero.ts`). The four are one instanced draw of 3D-04's mesh
 * with `tileMaterial`'s carved shader, so the unit proves the look and the draw
 * shape 3D-07 will scale to a board. The board itself arrives in 3D-07, the DOM
 * overlay's hit rects in 3D-08, motion in 3D-12 and the perf HUD in 3D-13; those
 * units add to this shell rather than replace it.
 *
 * Debug reporting. `heroReport()` re-draws, reads the five probe blocks back with
 * `readPixels` and prints them as numbers; `heroCaptures()` renders the same
 * view with the depth march on and off and returns one PNG per slot. Neither
 * inspects an image or decides whether the tile "looks right" — AGENTS.md §6
 * hands that to the user at `?renderer=3d&debug=hero`.
 */

import {
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  HemisphereLight,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  NoToneMapping,
  PerspectiveCamera,
  SRGBColorSpace,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { effectiveDevicePixelRatio } from '../capabilities';
import type {
  HeroCapture,
  HeroReport,
  HitRect,
  QualityTier,
  RendererOptions,
  RendererStats,
  TableRenderer,
  TableSnapshot,
} from '../contract';
import { HERO_FAILED_EVENT, HERO_READY_EVENT } from '../contract';
import { CAMERA, LIGHT } from '../layoutConstants';
import { applyPoseToCamera, rigPoseForAspect, verticalFieldOfViewDeg } from './cameraRig';
import { createFelt, feltSizeForPose } from './felt';
import type { FeltSurface } from './felt';
import { heroInstances, heroParallaxAt, probeWorldPoint } from './hero';
import type { HeroInstance, HeroSlot } from './hero';
import { sceneLightSpecs } from './lighting';
import {
  allProbesPass,
  readProbes,
} from './probes';
import type { ProbePixelSource, ProbeProjector } from './probes';
import { loadReliefAssets } from './reliefAssets';
import type { ReliefAssets } from './reliefAssets';
import { createReliefTextureFactory } from './reliefTextures';
import type { ReliefGpuTexture } from './reliefTextures';
import { buildTileGeometry } from './tileGeometry';
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
  readonly geometry: BufferGeometry;
  readonly instances: readonly HeroInstance[];
}

/** The macro capture's square edge, in pixels. */
const HERO_CAPTURE_SIZE = 640;

/** How much of the macro capture's frame the tile body fills. */
const HERO_CAPTURE_FILL = 0.72;

/** The framed extent around a tile in the macro capture, in world units. */
const HERO_CAPTURE_FRAME_UNITS = 1.15;

/** Build 3D-04's mesh as a three geometry, attributes and index included. */
function createTileRenderGeometry(): BufferGeometry {
  const data = buildTileGeometry();
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(data.positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(data.normals, 3));
  geometry.setAttribute('uv', new BufferAttribute(data.uvs, 2));
  geometry.setAttribute('tangent', new BufferAttribute(data.tangents, 4));
  geometry.setAttribute('faceZone', new BufferAttribute(data.faceZone, 1));
  geometry.setIndex(new BufferAttribute(data.indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
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
  private tier: QualityTier;
  private frameHandle: number | null = null;
  private disposed = false;
  private revision = 0;
  private aspect = 16 / 9;

  constructor(canvas: HTMLCanvasElement, options: RendererOptions) {
    this.tier = options.tier;
    this.canvas = canvas;

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

    // A compile failure must reach the host as `failed`, not as a silent black
    // tile (3D-05). Installed before anything is compiled.
    installShaderErrorTrap(this.renderer);

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
    const initialPose = rigPoseForAspect(16 / 9);
    applyPoseToCamera(this.camera, initialPose);
    this.felt.setSize(feltSizeForPose(initialPose));
    if (options.debug === 'hero') {
      this.startHero(options);
    }
    this.requestFrame();
  }

  /** The snapshot revision this scene is showing (3D-12 reads it for the cut rule). */
  get snapshotRevision(): number {
    return this.revision;
  }

  /**
   * Accept a new snapshot. The hero scene draws no snapshot tiles, but the
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
    this.aspect = cssWidth / cssHeight;
    const pose = rigPoseForAspect(this.aspect);
    applyPoseToCamera(this.camera, pose);
    // The felt is a square that reaches the top and bottom edges, so it is
    // re-sized with the framing; it is never stretched to the aspect.
    this.felt.setSize(feltSizeForPose(pose));
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
    this.requestFrame();
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
      instances: this.hero?.mesh.count ?? 0,
      atlasBytes: this.hero?.assets.atlasBytes ?? 0,
      relief: this.hero?.assets.status,
      pomSteps: this.hero?.material.pomSteps(),
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
      applyPoseToCamera(this.camera, rigPoseForAspect(this.aspect));
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
    const eye = new Vector3(...rigPoseForAspect(this.aspect).eyeUnits);
    const centre = new Vector3(...slot.pose.position);
    const direction = eye.sub(centre).normalize();
    const fovYDeg = verticalFieldOfViewDeg(1);
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

  /** Load the committed relief atlases and mount the four hero tiles. */
  private startHero(options: RendererOptions): void {
    if (this.heroStarted) return;
    this.heroStarted = true;
    const maxAnisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const baseUrl =
      typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL
        ? String(import.meta.env.BASE_URL)
        : '/';
    void loadReliefAssets<ReliefGpuTexture>({
      tier: options.tier,
      baseUrl,
      maxAnisotropy,
      createTexture: createReliefTextureFactory(maxAnisotropy),
    })
      .then((assets) => {
        if (this.disposed) {
          assets.dispose();
          return;
        }
        this.buildHero(assets, options);
      })
      .catch((error: unknown) => {
        this.reportHeroFailure(error);
      });
  }

  private buildHero(assets: ReliefAssets<ReliefGpuTexture>, options: RendererOptions): void {
    const geometry = createTileRenderGeometry();
    this.registry.add({ dispose: () => geometry.dispose() });
    const material = createTileMaterial({
      tier: options.tier,
      debug: options.debug,
      albedo: assets.textures.albedo,
      normalDepth: assets.textures.normalDepth,
      aoRoughness: assets.textures.aoRoughness,
    });

    const instances = heroInstances((face) => assets.cellForFace(face));
    const mesh = new InstancedMesh(geometry, material.material, instances.length);
    mesh.name = 'hero-tiles';
    // Every instance has its own transform; the geometry's bounding sphere says
    // nothing about where they are, so culling would drop visible tiles.
    mesh.frustumCulled = false;

    const rects = new Float32Array(instances.length * 4);
    const faceUp = new Float32Array(instances.length);
    const matrix = new Matrix4();
    instances.forEach((instance, index) => {
      const rect = instance.atlasRect ?? [0, 0, 1, 1];
      rects.set(rect, index * 4);
      faceUp[index] = instance.slot.faceUp ? 1 : 0;
      matrix.fromArray(instance.matrix);
      mesh.setMatrixAt(index, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    geometry.setAttribute('aAtlasRect', new InstancedBufferAttribute(rects, 4));
    geometry.setAttribute('aFaceUp', new InstancedBufferAttribute(faceUp, 1));
    this.scene.add(mesh);

    // The registry owns both lifetimes; the hero view keeps the live handles.
    this.registry.add({ dispose: () => assets.dispose() });
    this.registry.add({ dispose: () => material.dispose() });
    this.hero = {
      assets,
      material,
      mesh,
      geometry,
      instances,
    };

    // Compile now, in the load path, so a broken program throws into the
    // promise's catch and the host reports `failed` before the first frame.
    this.renderer.compile(this.scene, this.camera);
    this.draw();
    this.canvas.dispatchEvent(new CustomEvent(HERO_READY_EVENT));
  }

  private reportHeroFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (this.disposed) return;
    this.canvas.dispatchEvent(
      new CustomEvent(HERO_FAILED_EVENT, { detail: message }),
    );
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
