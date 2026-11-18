/**
 * The scene's dispose registry (3D-02 acceptance: mount/unmount leaves the
 * tracked resource count at zero).
 *
 * The registry is the unit-testable half of teardown; the renderer construction
 * itself needs WebGL and is exercised by the host's lifecycle tests through a
 * mocked lazy entry.
 */

import { describe, expect, it, vi } from 'vitest';
import { DisposeRegistry } from './Scene';

describe('DisposeRegistry', () => {
  it('releases every tracked resource exactly once', () => {
    const registry = new DisposeRegistry();
    const resources = [
      { dispose: vi.fn() },
      { dispose: vi.fn() },
      { dispose: vi.fn() },
    ];
    for (const resource of resources) {
      expect(registry.add(resource)).toBe(resource);
    }
    expect(registry.size).toBe(3);

    registry.disposeAll();
    expect(registry.size).toBe(0);
    for (const resource of resources) {
      expect(resource.dispose).toHaveBeenCalledTimes(1);
    }
  });

  it('is idempotent after draining', () => {
    const registry = new DisposeRegistry();
    const resource = { dispose: vi.fn() };
    registry.add(resource);
    registry.disposeAll();
    registry.disposeAll();
    expect(resource.dispose).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(0);
  });

  it('keeps accepting resources after a drain', () => {
    const registry = new DisposeRegistry();
    registry.disposeAll();
    const resource = { dispose: vi.fn() };
    registry.add(resource);
    expect(registry.size).toBe(1);
    registry.disposeAll();
    expect(resource.dispose).toHaveBeenCalledTimes(1);
  });
});
