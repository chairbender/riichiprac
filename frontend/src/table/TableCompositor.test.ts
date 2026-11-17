import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { parseShellsManifest } from './shellManifest';
import type { ShellsManifest } from './shellManifest';
import { buildBoard } from './boardLayout';
import type { Board, BoardShadowGroup } from './boardLayout';
import { boardGameState } from './boardFixture';
import {
  TableCompositor,
  drawShadowGroupLayer,
} from './TableCompositor';
import type { BoardCanvas, TileSpriteSource } from './TableCompositor';
import type { AtlasPage, BakedTileSprite } from './TileAtlasBuilder';
// The reference alpha field is the browser-safe script the shadow lab and
// `preview-group-shadow.mjs` use, deliberately shared rather than re-derived.
// @ts-expect-error - a dependency-free .mjs script has no type declarations.
import { shadowAlpha } from '../../../tools/render/scripts/shadow-group.mjs';

const tableDir = fileURLToPath(new URL('../../public/table/', import.meta.url));
const manifest: ShellsManifest = parseShellsManifest(
  JSON.parse(readFileSync(join(tableDir, 'shells.json'), 'utf8')),
);

const board = (): Board => buildBoard(manifest, boardGameState());

interface FakeCall {
  readonly kind: 'clear' | 'image';
  readonly source?: string;
}

/**
 * A recording 2D context. It implements only the calls the compositor makes;
 * every `drawImage` records the source canvas and every `filter` assignment is
 * counted.
 */
class FakeContext {
  fillStyle = '';
  globalAlpha = 1;
  private filterValue = 'none';
  readonly calls: FakeCall[] = [];
  readonly filterAssignments: string[] = [];

  constructor(private readonly canvas: FakeCanvas) {}

  get filter(): string {
    return this.filterValue;
  }

  set filter(value: string) {
    this.filterValue = value;
    this.filterAssignments.push(value);
  }

  save(): void {}
  restore(): void {}
  translate(): void {}
  rotate(): void {}
  beginPath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  arc(): void {}
  closePath(): void {}
  fill(): void {}
  clip(): void {}
  clearRect(): void {
    this.calls.push({ kind: 'clear' });
  }

  drawImage(source: unknown): void {
    const canvas = source as FakeCanvas;
    this.calls.push({ kind: 'image', source: canvas.label });
  }

  get imageOrder(): string[] {
    return this.calls.filter((call) => call.kind === 'image').map((call) => call.source ?? '');
  }

  get blurAssignments(): string[] {
    return this.filterAssignments.filter((value) => value.startsWith('blur('));
  }

  /** The owning canvas, for tests that need it. */
  get owner(): FakeCanvas {
    return this.canvas;
  }
}

class FakeCanvas implements BoardCanvas {
  width: number;
  height: number;
  readonly context: FakeContext;

  constructor(
    width: number,
    height: number,
    readonly label: string,
  ) {
    this.width = width;
    this.height = height;
    this.context = new FakeContext(this);
  }

  getContext(): CanvasRenderingContext2D {
    return this.context as unknown as CanvasRenderingContext2D;
  }
}

function fakeFactory(): {
  readonly create: (width: number, height: number) => BoardCanvas;
  readonly canvases: FakeCanvas[];
} {
  const canvases: FakeCanvas[] = [];
  return {
    canvases,
    create: (width, height) => {
      const canvas = new FakeCanvas(width, height, `layer-${canvases.length}`);
      canvases.push(canvas);
      return canvas;
    },
  };
}

const spriteSource = (pageCanvas: BoardCanvas): TileSpriteSource => {
  const sprite = {
    key: 'shell_flat_upright:flat-topdown:1m',
    shell: 'shell_flat_upright',
    variant: 'flat-topdown',
    face: '1m',
    pageIndex: 0,
    uv: { x: 0, y: 0, width: 1, height: 1 },
    pixelRatio: 1,
    hasGlyph: true,
    texWidth: 72,
    texHeight: 102,
    anchorX: 2,
    anchorY: 2,
    advanceWidth: 72,
    advanceHeight: 102,
    gridStepPx: { x: [69, 0], y: [0, 65] },
    faceQuad: [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
    faceRotationDeg: 0,
  } as unknown as BakedTileSprite;
  return {
    getSprite: () => sprite,
    getPage: () => ({ canvas: pageCanvas } as unknown as AtlasPage),
  };
};

describe('painter order and caching', () => {
  it('composites every shadow group before every body zone, in board order', () => {
    const factory = fakeFactory();
    const destination = new FakeCanvas(1, 1, 'destination');
    const page = factory.create(1, 1);
    const compositor = new TableCompositor(
      manifest,
      spriteSource(page),
      new Map(),
      destination,
      factory.create,
    );
    const result = board();
    const stats = compositor.update(result, new Map());

    expect(stats.rebuiltZones).toEqual(result.zones.map((zone) => zone.id));
    expect(stats.rebuiltGroups).toEqual(result.groups.map((group) => group.id));
    expect(stats.drawOrder).toEqual([
      ...result.groups.map((group) => `shadow:${group.id}`),
      ...result.zones.map((zone) => `zone:${zone.id}`),
    ]);

    // Zone layers are created first, then each group's mask + final layer.
    const zoneLayers = result.zones.map((_, index) => `layer-${index + 1}`);
    const groupLayers: string[] = [];
    result.groups.forEach((_, index) => {
      groupLayers.push(`layer-${1 + result.zones.length + index * 2 + 1}`);
    });
    expect(destination.context.imageOrder).toEqual([...groupLayers, ...zoneLayers]);
    expect(destination.context.imageOrder).toHaveLength(
      result.groups.length + result.zones.length,
    );
  });

  it('blurs each group once, never once per shape', () => {
    const factory = fakeFactory();
    const destination = new FakeCanvas(1, 1, 'destination');
    const page = factory.create(1, 1);
    const compositor = new TableCompositor(
      manifest,
      spriteSource(page),
      new Map(),
      destination,
      factory.create,
    );
    const result = board();
    compositor.update(result, new Map());

    const blurAssignments = factory.canvases.flatMap(
      (canvas) => canvas.context.blurAssignments,
    );
    expect(blurAssignments).toHaveLength(
      result.groups.filter((group) => group.sigmaPx1x > 0).length,
    );
    const shapes = result.groups.reduce((total, group) => total + group.shapes.length, 0);
    // A per-shape recipe would blur `shapes` times, one per footprint.
    expect(blurAssignments.length).toBeLessThan(shapes);
    for (const value of blurAssignments) expect(value).toMatch(/^blur\(\d+px\)$/);
  });

  it('rebuilds nothing when the board has not changed', () => {
    const factory = fakeFactory();
    const destination = new FakeCanvas(1, 1, 'destination');
    const page = factory.create(1, 1);
    const compositor = new TableCompositor(
      manifest,
      spriteSource(page),
      new Map(),
      destination,
      factory.create,
    );
    const result = board();
    compositor.update(result, new Map());
    const before = factory.canvases.length;
    const again = compositor.update(result, new Map());
    expect(again.rebuiltZones).toEqual([]);
    expect(again.rebuiltGroups).toEqual([]);
    expect(again.reusedZones).toBe(result.zones.length);
    expect(again.reusedGroups).toBe(result.groups.length);
    // Only the final composite creates no layers.
    expect(factory.canvases.length).toBe(before);
  });

  it('rebuilds only the zone whose body moved, not its unchanged group', () => {
    const factory = fakeFactory();
    const destination = new FakeCanvas(1, 1, 'destination');
    const page = factory.create(1, 1);
    const compositor = new TableCompositor(
      manifest,
      spriteSource(page),
      new Map(),
      destination,
      factory.create,
    );
    const result = board();
    compositor.update(result, new Map());

    const moved: Board = {
      ...result,
      zones: result.zones.map((placement) => {
        if (placement.id !== 'pond-bottom') return placement;
        const bodies = placement.zone.bodies.map((tile, index) =>
          index === 0 ? { ...tile, drawX: tile.drawX + 3 } : tile,
        );
        return { ...placement, zone: { ...placement.zone, bodies } };
      }),
    };
    const stats = compositor.update(moved, new Map());
    expect(stats.rebuiltZones).toEqual(['pond-bottom']);
    expect(stats.rebuiltGroups).toEqual([]);
    expect(stats.reusedZones).toBe(result.zones.length - 1);
  });

  it('rebuilds only the shadow group whose union changed', () => {
    const factory = fakeFactory();
    const destination = new FakeCanvas(1, 1, 'destination');
    const page = factory.create(1, 1);
    const compositor = new TableCompositor(
      manifest,
      spriteSource(page),
      new Map(),
      destination,
      factory.create,
    );
    const result = board();
    compositor.update(result, new Map());

    const moved: Board = {
      ...result,
      groups: result.groups.map((group) => {
        if (group.id !== 'walls') return group;
        return {
          ...group,
          shapes: group.shapes.map((shape, index) =>
            index === 0 ? { ...shape, centreX: shape.centreX + 4 } : shape,
          ),
        };
      }),
    };
    const stats = compositor.update(moved, new Map());
    expect(stats.rebuiltGroups).toEqual(['walls']);
    expect(stats.rebuiltZones).toEqual([]);
    expect(stats.reusedGroups).toBe(result.groups.length - 1);
  });

  it('drops a zone layer that disappears from the board', () => {
    const factory = fakeFactory();
    const destination = new FakeCanvas(1, 1, 'destination');
    const page = factory.create(1, 1);
    const compositor = new TableCompositor(
      manifest,
      spriteSource(page),
      new Map(),
      destination,
      factory.create,
    );
    const result = board();
    compositor.update(result, new Map());
    const withoutPond: Board = {
      ...result,
      zones: result.zones.filter((placement) => placement.id !== 'pond-bottom'),
      groups: result.groups.filter((group) => group.id !== 'pond-bottom'),
    };
    compositor.update(withoutPond, new Map());
    const again = compositor.update(withoutPond, new Map());
    expect(again.rebuiltZones).toEqual([]);
    expect(again.rebuiltGroups).toEqual([]);
  });
});

describe('group shadow pixels', () => {
  const napiCanvas = (width: number, height: number): BoardCanvas =>
    createCanvas(width, height) as unknown as BoardCanvas;

  it('turns a side wall run into one smooth long shadow band', () => {
    const result = board();
    const walls = result.groups.find((group) => group.id === 'walls');
    if (!walls) throw new Error('no walls group');
    const back = result.zones.find((entry) => entry.id === 'wall-back');
    const left = result.zones.find((entry) => entry.id === 'wall-side-left');
    if (!back || !left) throw new Error('missing wall zones');
    // The wall group follows zone order; take just the left column.
    const leftShapes = walls.shapes.slice(
      back.zone.shadows.length,
      back.zone.shadows.length + left.zone.shadows.length,
    );
    const layer = drawShadowGroupLayer(
      { ...walls, shapes: leftShapes, zoneIds: [left.id] },
      napiCanvas,
    );
    const context = layer.canvas.getContext('2d');
    if (!context) throw new Error('no context');
    const { width, height } = layer.canvas;
    const pixels = context.getImageData(0, 0, width, height).data;
    const alphaAt = (x: number, y: number): number => pixels[(y * width + x) * 4 + 3] / 255;
    const edgeAt = (y: number): number | null => {
      for (let x = 0; x < width; x += 1) if (alphaAt(x, y) > 0.3) return x;
      return null;
    };
    const alphaPresent = (y: number): boolean => {
      for (let x = 0; x < width; x += 1) if (alphaAt(x, y) > 0.3) return true;
      return false;
    };
    let firstY = 0;
    while (firstY < height && !alphaPresent(firstY)) firstY += 1;
    let lastY = height - 1;
    while (lastY >= 0 && !alphaPresent(lastY)) lastY -= 1;
    let worstStep = 0;
    let worstY = -1;
    let previous: number | null = null;
    // Skip the rounded end caps; the complaint is the long edge's staircase.
    for (let y = firstY + 90; y <= lastY - 90; y += 1) {
      const edge = edgeAt(y);
      if (edge === null) {
        previous = null;
        continue;
      }
      if (previous !== null && Math.abs(edge - previous) > worstStep) {
        worstStep = Math.abs(edge - previous);
        worstY = y;
      }
      previous = edge;
    }
    // An axis-aligned per-stack footprint steps ~6.9 px between rows; the
    // rotated run moves the edge smoothly (about 0.15 px per row).
    expect(worstStep, `worst step at y=${worstY} of ${height}`).toBeLessThan(2.5);
  });

  const group: BoardShadowGroup = {
    id: 'test-group',
    x: 0,
    y: 0,
    width: 120,
    height: 76,
    pad: 16,
    sigmaPx1x: 8,
    coreAlpha: 0.6,
    colorHex: '#0b1418',
    shapes: [
      {
        centreX: 38,
        centreY: 38,
        halfX: 30,
        halfY: 22,
        radiusPx: 6,
        angleDeg: 0,
      },
      {
        centreX: 66,
        centreY: 38,
        halfX: 30,
        halfY: 22,
        radiusPx: 6,
        angleDeg: 0,
      },
    ],
    zoneIds: ['a', 'b'],
  };

  it('matches the reference merged-field alpha, with one blur', () => {
    const layer = drawShadowGroupLayer(group, napiCanvas);
    const width = layer.canvas.width;
    const height = layer.canvas.height;
    const context = layer.canvas.getContext('2d');
    if (!context) throw new Error('no context');
    const pixels = context.getImageData(0, 0, width, height).data;

    const reference = shadowAlpha(
      width,
      height,
      group.shapes.map((shape) => ({
        centre: [shape.centreX + group.pad, shape.centreY + group.pad],
        half: [shape.halfX, shape.halfY],
        angleDeg: shape.angleDeg,
        radius: shape.radiusPx,
        sigmaPx1x: group.sigmaPx1x,
        coreAlpha: group.coreAlpha,
      })),
      'merged',
    );

    let sum = 0;
    let max = 0;
    let samples = 0;
    for (let index = 0; index < reference.length; index += 1) {
      const actual = pixels[index * 4 + 3] / 255;
      const expected = reference[index];
      if (expected < 0.01 && actual < 0.01) continue;
      const delta = Math.abs(actual - expected);
      sum += delta;
      max = Math.max(max, delta);
      samples += 1;
    }
    expect(samples).toBeGreaterThan(1000);
    expect(sum / samples).toBeLessThan(0.01);
    expect(max).toBeLessThan(0.05);

    // The overlap is one union, not two source-over draws.
    const sample = (38 + group.pad) * width + (52 + group.pad);
    expect(reference[sample]).toBeLessThanOrEqual(group.coreAlpha + 0.01);
    const single = group.shapes.map((shape) =>
      shadowAlpha(
        width,
        height,
        [
          {
            centre: [shape.centreX + group.pad, shape.centreY + group.pad],
            half: [shape.halfX, shape.halfY],
            angleDeg: shape.angleDeg,
            radius: shape.radiusPx,
            sigmaPx1x: group.sigmaPx1x,
            coreAlpha: group.coreAlpha,
          },
        ],
        'merged',
      ),
    );
    const first = single[0][sample];
    const second = single[1][sample];
    const sourceOver = first + second * (1 - first);
    expect(sourceOver).toBeGreaterThan(reference[sample] + 0.02);
  });
});
