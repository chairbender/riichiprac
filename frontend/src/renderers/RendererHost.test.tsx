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
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RendererOptions, RendererStats, TableRenderer, TableSnapshot } from './contract';
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

const hostMock = vi.hoisted(() => {
  interface MockState {
    created: number;
    disposed: number;
    live: number;
    sizes: number[][];
    snapshots: TableSnapshot[];
    options: RendererOptions[];
    fail: Error | null;
  }

  const state: MockState = {
    created: 0,
    disposed: 0,
    live: 0,
    sizes: [],
    snapshots: [],
    options: [],
    fail: null,
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
      hitRects: () => [],
      playEvents: () => undefined,
      measure: () => stats,
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
