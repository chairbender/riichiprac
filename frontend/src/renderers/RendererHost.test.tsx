// @vitest-environment jsdom
/**
 * The lazy host's lifecycle (3D-02 acceptance).
 *
 * jsdom has no WebGL, so this file does two things instead of drawing: it
 * mocks the lazy `./three` entry to count create/dispose calls, and it mocks
 * the capability probe to choose between the supported and unsupported paths.
 * The real camera, felt and scene numbers are covered by their own tests.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CompassRect,
  HeroCapture,
  HeroReport,
  HitRect,
  RendererOptions,
  RendererStats,
  TableRenderer,
  TableSnapshot,
} from './contract';
import { HERO_FAILED_EVENT, HERO_READY_EVENT } from './contract';
import { RendererHost } from './RendererHost';

const probe = vi.hoisted(() => ({
  value: {
    webgl2: true,
    maxTextureSize: 8192,
    devicePixelRatio: 1,
    unavailable: null as string | null,
  },
}));

vi.mock('./capabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./capabilities')>();
  return { ...actual, probeCapabilities: () => probe.value };
});

// The 2.5D SVG package bundles its own React (see `overlay.test.tsx`); the
// compass's wind glyphs only need to be plain SVG elements in jsdom.
vi.mock('riichi-mahjong-tiles', async () => {
  const { createElement } = await import('react');
  const Glyph = (props: Record<string, unknown>) => createElement('svg', props);
  return {
    RegularTon: Glyph,
    RegularNan: Glyph,
    RegularShaa: Glyph,
    RegularPei: Glyph,
  };
});

const hostMock = vi.hoisted(() => {
  interface MockState {
    created: number;
    disposed: number;
    live: number;
    sizes: number[][];
    snapshots: TableSnapshot[];
    options: RendererOptions[];
    fail: Error | null;
    report: unknown;
    captures: unknown[];
    rects: HitRect[];
    compass: CompassRect | null;
    hitRectCalls: number;
    hover: unknown[];
  }

  const state: MockState = {
    created: 0,
    disposed: 0,
    live: 0,
    sizes: [],
    snapshots: [],
    options: [],
    fail: null,
    report: null,
    captures: [],
    rects: [],
    compass: null,
    hitRectCalls: 0,
    hover: [],
  };

  const stats: RendererStats = {
    tier: 'high',
    drawCalls: 1,
    triangles: 2,
    instances: 0,
    atlasBytes: 0,
    frameMsP50: 0,
    frameMsP95: 0,
  };

  const createRenderer = vi.fn((_canvas: HTMLCanvasElement, options: RendererOptions): TableRenderer => {
    if (state.fail) throw state.fail;
    state.created += 1;
    state.live += 1;
    state.options.push(options);
    let disposed = false;
    return {
      syncState: (snapshot: TableSnapshot) => {
        state.snapshots.push(snapshot);
      },
      setSize: (width: number, height: number, dpr: number) => {
        state.sizes.push([width, height, dpr]);
      },
      setQuality: () => undefined,
      hitRects: () => {
        state.hitRectCalls += 1;
        return state.rects;
      },
      compassRect: () => state.compass,
      setHoverTile: (tile: unknown) => {
        state.hover.push(tile);
      },
      playEvents: () => undefined,
      measure: () => stats,
      heroReport: () => state.report as never,
      heroCaptures: () => state.captures as never,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        state.disposed += 1;
        state.live -= 1;
      },
    };
  });

  return { state, createRenderer };
});

vi.mock('./three', () => ({ createRenderer: hostMock.createRenderer }));

function seat(seatIndex: 0 | 1 | 2 | 3) {
  return {
    seat: seatIndex,
    wind: 'East' as const,
    score: 25000,
    concealed: [],
    draw: null,
    melds: [],
    river: [],
    riichi: false,
    riichiDiscardIndex: null,
  };
}

function snapshot(revision = 1): TableSnapshot {
  return {
    revision,
    humanSeat: 0,
    seats: [seat(0), seat(1), seat(2), seat(3)],
    wall: [],
    dora: [],
    compass: {
      roundWind: 'East',
      handNumber: 1,
      honba: 0,
      riichiSticks: 0,
      tilesRemaining: 70,
    },
    highlightDiscard: null,
    locked: false,
  };
}

function fallbackTable() {
  return <p>fallback table</p>;
}

beforeEach(() => {
  probe.value = {
    webgl2: true,
    maxTextureSize: 8192,
    devicePixelRatio: 1,
    unavailable: null,
  };
  Object.assign(hostMock.state, {
    created: 0,
    disposed: 0,
    live: 0,
    sizes: [],
    snapshots: [],
    options: [],
    fail: null,
    report: null,
    captures: [],
    rects: [],
    compass: null,
    hitRectCalls: 0,
    hover: [],
  });
  hostMock.createRenderer.mockClear();

  // jsdom lays nothing out; give the host a real size so it exercises setSize.
  Object.defineProperty(HTMLDivElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => 800,
  });
  Object.defineProperty(HTMLDivElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 600,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('RendererHost module boundary', () => {
  it('never statically imports the three.js chunk', () => {
    // jsdom rewrites `import.meta.url`, so resolve against the project root
    // (vitest runs from `frontend/`).
    const source = readFileSync(
      join(process.cwd(), 'src/renderers/RendererHost.tsx'),
      'utf8',
    );
    expect(source).not.toMatch(/from\s+['"]\.\/three['"]/);
    expect(source).not.toMatch(/from\s+['"]\.\/three\/[^'"]*['"]/);
    expect(source).toMatch(/import\(\s*['"]\.\/three['"]\s*\)/);
  });
});

describe('RendererHost lifecycle', () => {
  it('mounts one decoration canvas named by a hidden heading, then disposes', async () => {
    const state = snapshot(3);
    const { container, unmount } = render(
      <RendererHost snapshot={state} fallback={fallbackTable()} />,
    );

    await waitFor(() => expect(hostMock.state.created).toBe(1));

    const canvas = container.querySelector('canvas');
    expect(canvas).not.toBeNull();
    expect(canvas?.getAttribute('aria-hidden')).toBe('true');
    expect(canvas?.hasAttribute('tabindex')).toBe(false);
    // The view is named for assistive tech, on the grouping element.
    expect(screen.getByRole('group', { name: '3D table view' })).toBeTruthy();
    expect(screen.queryByText('fallback table')).toBeNull();

    // The first frame is sized to the element and the snapshot is the one the
    // host was given.
    expect(hostMock.state.sizes.at(-1)).toEqual([800, 600, 1]);
    expect(hostMock.state.snapshots.at(-1)).toBe(state);

    unmount();
    expect(hostMock.state.disposed).toBe(1);
    expect(hostMock.state.live).toBe(0);
  });

  it('forwards the pinned tier, debug mode and flags', async () => {
    render(
      <RendererHost
        snapshot={snapshot()}
        tier="balanced"
        debug="height"
        perfHud
        reducedMotion
        fallback={fallbackTable()}
      />,
    );
    await waitFor(() => expect(hostMock.state.created).toBe(1));
    expect(hostMock.state.options[0]).toEqual({
      tier: 'balanced',
      debug: 'height',
      perfHud: true,
      reducedMotion: true,
      antialias: true,
    });
  });

  it('redraws on a new snapshot without remounting', async () => {
    const { rerender } = render(
      <RendererHost snapshot={snapshot(1)} fallback={fallbackTable()} />,
    );
    await waitFor(() => expect(hostMock.state.created).toBe(1));

    rerender(<RendererHost snapshot={snapshot(2)} fallback={fallbackTable()} />);

    expect(hostMock.state.created).toBe(1);
    expect(hostMock.state.snapshots.at(-1)?.revision).toBe(2);
  });

  it('leaves no live renderer after five mount/unmount cycles', async () => {
    for (let cycle = 1; cycle <= 5; cycle += 1) {
      const { unmount } = render(
        <RendererHost snapshot={snapshot(cycle)} fallback={fallbackTable()} />,
      );
      await waitFor(() => expect(hostMock.state.live).toBe(1));
      unmount();
      expect(hostMock.state.live, `cycle ${cycle}`).toBe(0);
    }
    expect(hostMock.state.created).toBe(5);
    expect(hostMock.state.disposed).toBe(5);
  });

  it('does not create two renderers under StrictMode', async () => {
    render(
      <StrictMode>
        <RendererHost snapshot={snapshot()} fallback={fallbackTable()} />
      </StrictMode>,
    );
    await waitFor(() => expect(hostMock.state.created).toBe(1));
    expect(hostMock.state.live).toBe(1);
    expect(hostMock.state.disposed).toBe(0);
  });
});

describe('RendererHost fallbacks', () => {
  it('loads nothing and keeps the fallback when WebGL2 is unavailable', () => {
    probe.value = {
      webgl2: false,
      maxTextureSize: 0,
      devicePixelRatio: 1,
      unavailable: 'WebGL2 is not available in this browser',
    };

    render(<RendererHost snapshot={snapshot()} fallback={fallbackTable()} />);

    expect(hostMock.createRenderer).not.toHaveBeenCalled();
    expect(screen.getByText('fallback table')).toBeTruthy();
    expect(screen.getByText('WebGL2 is not available in this browser')).toBeTruthy();
  });

  it('keeps the fallback and reports a lazy-chunk failure', async () => {
    hostMock.state.fail = new Error('the chunk failed to load');

    render(<RendererHost snapshot={snapshot()} fallback={fallbackTable()} />);

    await waitFor(() =>
      expect(screen.getByText('the chunk failed to load')).toBeTruthy(),
    );
    expect(screen.getByText('fallback table')).toBeTruthy();
    expect(hostMock.state.live).toBe(0);
  });

  it('survives one context loss and gives up on the second', async () => {
    const { container } = render(
      <RendererHost snapshot={snapshot()} fallback={fallbackTable()} />,
    );
    await waitFor(() => expect(hostMock.state.live).toBe(1));
    const canvas = container.querySelector('canvas');
    if (!canvas) throw new Error('expected a canvas');

    const first = new Event('webglcontextlost', { cancelable: true });
    act(() => {
      canvas.dispatchEvent(first);
    });
    // The default must be prevented so the browser is allowed to restore.
    expect(first.defaultPrevented).toBe(true);
    expect(hostMock.state.live).toBe(1);
    await waitFor(() => expect(screen.getByText(/Restoring the 3D view/)).toBeTruthy());

    const restored = new Event('webglcontextrestored');
    act(() => {
      canvas.dispatchEvent(restored);
    });
    await waitFor(() =>
      expect(screen.queryByText(/Restoring the 3D view/)).toBeNull(),
    );

    act(() => {
      canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    });
    await waitFor(() =>
      expect(screen.getByText(/lost its WebGL context twice/)).toBeTruthy(),
    );
    expect(hostMock.state.live).toBe(0);
    expect(screen.getByText('fallback table')).toBeTruthy();
  });
});

function heroReportFixture(): HeroReport {
  const probe = (overrides: Partial<HeroReport['probes'][number]>) => ({
    id: 'faceIvory',
    label: 'face ivory',
    kind: 'ivory',
    rgb: [245, 240, 235] as const,
    hex: '#f5f0eb',
    redness: 5,
    targetHex: '#f5f0eb',
    deltaE: 1.8,
    tolerance: 6,
    pass: true,
    detail: null,
    ...overrides,
  });
  return {
    relief: 'relief3d',
    tier: 'high',
    pomSteps: 12,
    carveDepthMm: 0.55,
    heightScale: 0.25,
    maxParallaxTexels: 8,
    aspect: 16 / 9,
    parallax: [
      { slot: 'pond', label: 'pond', angleDeg: 37.1, texels: 5.94, clamped: false },
    ],
    probes: [
      probe({ id: 'faceIvory' }),
      probe({
        id: 'facePaint',
        label: 'paint',
        kind: 'paint',
        rgb: [166, 12, 12],
        hex: '#a60c0c',
        redness: 154,
        targetHex: null,
        deltaE: null,
        tolerance: null,
      }),
    ],
    allProbesPass: true,
    pomOff: { probes: [probe({ id: 'faceIvory' })], allProbesPass: true },
  };
}

function handSnapshot(revision = 1): TableSnapshot {
  const base = snapshot(revision);
  return {
    ...base,
    seats: [
      {
        ...base.seats[0],
        concealed: [
          { face: '1m', zone: 'hand', slot: 0, faceUp: true, sideways: false },
        ],
      },
      base.seats[1],
      base.seats[2],
      base.seats[3],
    ],
  };
}

const HAND_RECT: HitRect = {
  seat: 0,
  zone: 'hand',
  slot: 0,
  face: '1m',
  left: 10,
  top: 20,
  width: 44,
  height: 44,
};

describe('RendererHost interaction overlay (3D-08)', () => {
  it('renders the projected hand and forwards clicks to the shared handler', async () => {
    hostMock.state.rects = [HAND_RECT];
    const onSelectTile = vi.fn();
    render(
      <RendererHost
        snapshot={handSnapshot()}
        onSelectTile={onSelectTile}
        callRiichi={false}
        callKan={false}
        fallback={fallbackTable()}
      />,
    );
    await waitFor(() => expect(hostMock.state.live).toBe(1));

    const button = await screen.findByRole('button', { name: 'Discard 1m' });
    expect(button.style.left).toBe('10px');
    expect(button.style.width).toBe('44px');
    await userEvent.click(button);
    expect(onSelectTile).toHaveBeenCalledWith('1m', 0, false);
  });

  it('re-reads the rects after a resize and a new snapshot', async () => {
    hostMock.state.rects = [HAND_RECT];
    // jsdom has no ResizeObserver: the host's window-resize fallback is the
    // path under test, which is also the real path in browsers without it.
    vi.stubGlobal('ResizeObserver', undefined);
    const { rerender } = render(
      <RendererHost snapshot={handSnapshot(1)} onSelectTile={() => undefined} />,
    );
    await waitFor(() => expect(hostMock.state.live).toBe(1));
    expect(screen.getByRole('button', { name: 'Discard 1m' })).toBeTruthy();
    const callsBefore = hostMock.state.hitRectCalls;

    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(hostMock.state.hitRectCalls).toBeGreaterThan(callsBefore);

    hostMock.state.rects = [{ ...HAND_RECT, face: '2m', left: 60 }];
    const next = handSnapshot(2);
    rerender(
      <RendererHost
        snapshot={{
          ...next,
          seats: [
            {
              ...next.seats[0],
              concealed: [
                { face: '2m', zone: 'hand', slot: 0, faceUp: true, sideways: false },
              ],
            },
            next.seats[1],
            next.seats[2],
            next.seats[3],
          ],
        }}
        onSelectTile={() => undefined}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Discard 2m' })).toBeTruthy(),
    );
    expect(screen.getByRole('button', { name: 'Discard 2m' }).style.left).toBe('60px');
    expect(hostMock.state.hitRectCalls).toBeGreaterThan(callsBefore);
  });

  it('forwards hover to the renderer’s lift seam', async () => {
    hostMock.state.rects = [HAND_RECT];
    render(<RendererHost snapshot={handSnapshot()} onSelectTile={() => undefined} />);
    await waitFor(() => expect(hostMock.state.live).toBe(1));
    const button = await screen.findByRole('button', { name: 'Discard 1m' });
    fireEvent.focus(button);
    expect(hostMock.state.hover.at(-1)).toEqual({ seat: 0, zone: 'hand', slot: 0 });
  });

  it('names the view and describes the interactive hand for screen readers', async () => {
    hostMock.state.rects = [HAND_RECT];
    render(<RendererHost snapshot={handSnapshot()} onSelectTile={() => undefined} />);
    await waitFor(() => expect(hostMock.state.live).toBe(1));

    const group = screen.getByRole('group', { name: '3D table view' });
    const describedBy = group.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const description = document.getElementById(describedBy ?? '');
    expect(description?.textContent).toMatch(/3D table view/);
    expect(description?.textContent).toMatch(/buttons/);
    const canvas = document.querySelector('canvas');
    expect(canvas?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('RendererHost compass overlay (3D-09)', () => {
  const COMPASS: CompassRect = {
    left: 300,
    top: 200,
    width: 240,
    height: 180,
    centreX: 420,
    centreY: 290,
  };

  it('anchors the compass to the renderer’s projected well', async () => {
    hostMock.state.compass = COMPASS;
    render(
      <RendererHost
        snapshot={snapshot()}
        onSelectTile={() => undefined}
        fallback={fallbackTable()}
      />,
    );
    await waitFor(() => expect(hostMock.state.live).toBe(1));

    const compass = await screen.findByRole('group', { name: 'Compass' });
    // The square is the well's shorter side, centred on its projected centre.
    expect(compass.style.left).toBe('330px');
    expect(compass.style.top).toBe('200px');
    expect(compass.style.width).toBe('180px');
    expect(compass.style.height).toBe('180px');
    expect(compass.getAttribute('data-centre-x')).toBe('420');
    expect(compass.getAttribute('data-centre-y')).toBe('290');
    expect(
      screen.getByRole('group', {
        name: 'Round East 1, 70 tiles remaining',
      }),
    ).toBeTruthy();
  });

  it('shows the compass even when only the scene is mounted (no hand handler)', async () => {
    hostMock.state.compass = COMPASS;
    render(<RendererHost snapshot={snapshot()} fallback={fallbackTable()} />);
    await waitFor(() => expect(hostMock.state.live).toBe(1));
    expect(await screen.findByRole('group', { name: 'Compass' })).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('drops the compass while the scene is not ready', async () => {
    hostMock.state.compass = COMPASS;
    probe.value = {
      webgl2: false,
      maxTextureSize: 0,
      devicePixelRatio: 1,
      unavailable: 'WebGL2 is not available in this browser',
    };
    render(<RendererHost snapshot={snapshot()} fallback={fallbackTable()} />);
    expect(screen.queryByRole('group', { name: 'Compass' })).toBeNull();
    expect(screen.getByText('fallback table')).toBeTruthy();
  });
});

describe('RendererHost hero debug view (3D-05)', () => {
  it('prints the measured probes after the scene reports ready', async () => {
    hostMock.state.report = heroReportFixture();
    const { container } = render(
      <RendererHost snapshot={snapshot()} debug="hero" fallback={fallbackTable()} />,
    );
    await waitFor(() => expect(hostMock.state.live).toBe(1));
    const canvas = container.querySelector('canvas');
    if (!canvas) throw new Error('expected a canvas');

    act(() => {
      canvas.dispatchEvent(new CustomEvent(HERO_READY_EVENT));
    });

    expect(screen.getByText('Hero tile · numeric report')).toBeTruthy();
    expect(screen.getAllByText('#f5f0eb').length).toBeGreaterThan(0);
    expect(screen.getByText('1.80')).toBeTruthy();
    expect(screen.getByText('37.10°')).toBeTruthy();
    expect(screen.getByText('5.94')).toBeTruthy();
    expect(screen.getByText(/POM off \(steps 0\)/)).toBeTruthy();
    expect(screen.getByText(/within tolerance/)).toBeTruthy();
  });

  it('exports one PNG per capture on demand', async () => {
    hostMock.state.report = heroReportFixture();
    hostMock.state.captures = [
      { name: 'hero-hand-depth-sweep.png', pngDataUrl: 'data:image/png;base64,AA==', width: 2, height: 2 },
      { name: 'hero-pond-depth-sweep.png', pngDataUrl: 'data:image/png;base64,AA==', width: 2, height: 2 },
    ] as HeroCapture[];
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);

    const { container } = render(
      <RendererHost snapshot={snapshot()} debug="hero" fallback={fallbackTable()} />,
    );
    await waitFor(() => expect(hostMock.state.live).toBe(1));
    const canvas = container.querySelector('canvas');
    if (!canvas) throw new Error('expected a canvas');
    act(() => {
      canvas.dispatchEvent(new CustomEvent(HERO_READY_EVENT));
    });

    const button = screen.getByRole('button', { name: /Export depth sweep/ });
    act(() => {
      button.click();
    });

    expect(click).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/2 depth-sweep PNGs downloaded/)).toBeTruthy();
    const downloads = Array.from(container.querySelectorAll('a')).map((anchor) => anchor.download);
    expect(downloads).toEqual([]);
  });

  it('surfaces a hero build failure over the stage', async () => {
    const { container } = render(
      <RendererHost snapshot={snapshot()} debug="hero" fallback={fallbackTable()} />,
    );
    await waitFor(() => expect(hostMock.state.live).toBe(1));
    const canvas = container.querySelector('canvas');
    if (!canvas) throw new Error('expected a canvas');

    act(() => {
      canvas.dispatchEvent(
        new CustomEvent(HERO_FAILED_EVENT, {
          detail: '3D tile shader failed to compile or link: ERROR: 0:12',
        }),
      );
    });

    await waitFor(() =>
      expect(screen.getByText(/tile shader failed to compile/)).toBeTruthy(),
    );
    expect(screen.getByText('fallback table')).toBeTruthy();
    expect(screen.queryByText('Hero tile · numeric report')).toBeNull();
  });

  it('reports a shader compile failure from createRenderer as failed', async () => {
    hostMock.state.fail = new Error(
      '3D tile shader failed to compile or link:\nERROR: 0:12: undeclared identifier',
    );
    render(<RendererHost snapshot={snapshot()} debug="hero" fallback={fallbackTable()} />);
    await waitFor(() =>
      expect(screen.getByText(/tile shader failed to compile or link/)).toBeTruthy(),
    );
    expect(screen.getByText('fallback table')).toBeTruthy();
  });
});
