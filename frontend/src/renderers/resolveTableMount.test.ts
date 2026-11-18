/**
 * View selection precedence (3D-02): explicit query parameter > stored view >
 * the store's default.
 *
 * The stored view is just a value here: this resolver never reads storage, so
 * the test covers the rule rather than a mocked `localStorage`.
 */

import { describe, expect, it } from 'vitest';
import { resolveTableMount } from './resolveTableMount';

describe('resolveTableMount', () => {
  it('lets an explicit ?renderer=3d beat the stored view', () => {
    expect(resolveTableMount('?renderer=3d', 'topdown').kind).toBe('three');
    expect(resolveTableMount('?renderer=3d', 'stacked').kind).toBe('three');
    expect(resolveTableMount('renderer=3d', 'topdown').kind).toBe('three');
  });

  it('keeps the stored view when the query names nothing', () => {
    expect(resolveTableMount('', 'topdown')).toEqual({
      kind: '2d',
      view: 'topdown',
      query: { renderer: null, quality: null, debug: null, perf: false },
    });
    expect(resolveTableMount('', 'stacked')).toMatchObject({
      kind: '2d',
      view: 'stacked',
    });
  });

  it('rejects any other renderer value instead of enabling one', () => {
    for (const search of ['?renderer=25d', '?renderer=4d', '?renderer=', '?renderer']) {
      expect(resolveTableMount(search, 'topdown'), search).toMatchObject({
        kind: '2d',
        view: 'topdown',
      });
    }
  });

  it('carries the pinned tier, debug mode and perf flag through', () => {
    const mount = resolveTableMount(
      '?renderer=3d&quality=balanced&debug=height&perf=1',
      'stacked',
    );
    expect(mount.kind).toBe('three');
    if (mount.kind !== 'three') return;
    expect(mount.query.quality).toBe('balanced');
    expect(mount.query.debug).toBe('height');
    expect(mount.query.perf).toBe(true);
  });

  it('rejects an unknown tier and debug mode in the same URL', () => {
    const mount = resolveTableMount('?renderer=3d&quality=ultra&debug=wat', 'stacked');
    if (mount.kind !== 'three') throw new Error('expected a 3D mount');
    expect(mount.query.quality).toBeNull();
    expect(mount.query.debug).toBeNull();
  });
});
