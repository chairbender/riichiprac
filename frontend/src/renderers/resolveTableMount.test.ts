/**
 * View selection precedence (3D-02, extended by 3D-14): explicit query
 * parameter > stored view > the store's default, with a stored 3D choice
 * honouring the caller's "can this browser run it" answer.
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

  it('mounts a stored 3D view without the query flag (3D-14)', () => {
    expect(resolveTableMount('', 'rendered3d').kind).toBe('three');
    // The query flag is an override, not the only way in: a link that names
    // another renderer leaves the stored 3D choice alone.
    expect(resolveTableMount('?renderer=25d', 'rendered3d').kind).toBe('three');
    expect(resolveTableMount('?quality=compat', 'rendered3d').kind).toBe('three');
  });

  it('falls a stored 3D view back to the default 2D view when it cannot run', () => {
    const mount = resolveTableMount('', 'rendered3d', {
      allowStoredThreeView: false,
    });
    expect(mount).toEqual({
      kind: '2d',
      view: 'stacked',
      query: { renderer: null, quality: null, debug: null, perf: false, preview: null },
    });
    // An explicit link still asks the host to try; the host owns the message.
    expect(
      resolveTableMount('?renderer=3d', 'rendered3d', {
        allowStoredThreeView: false,
      }).kind,
    ).toBe('three');
    // The flag only governs the 3D value; the 2D choices are untouched.
    expect(
      resolveTableMount('', 'topdown', { allowStoredThreeView: false }),
    ).toMatchObject({ kind: '2d', view: 'topdown' });
  });

  it('keeps the stored view when the query names nothing', () => {
    expect(resolveTableMount('', 'topdown')).toEqual({
      kind: '2d',
      view: 'topdown',
      query: { renderer: null, quality: null, debug: null, perf: false, preview: null },
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

  it('carries the sticks preview flag through the 3D mount', () => {
    const mount = resolveTableMount(
      '?renderer=3d&preview=sticks',
      'stacked',
    );
    if (mount.kind !== 'three') throw new Error('expected a 3D mount');
    expect(mount.query.preview).toBe('sticks');
    expect(resolveTableMount('?renderer=3d&preview=nope', 'stacked')).toMatchObject({
      kind: 'three',
      query: { preview: null },
    });
  });

  it('rejects an unknown tier and debug mode in the same URL', () => {
    const mount = resolveTableMount('?renderer=3d&quality=ultra&debug=wat', 'stacked');
    if (mount.kind !== 'three') throw new Error('expected a 3D mount');
    expect(mount.query.quality).toBeNull();
    expect(mount.query.debug).toBeNull();
  });
});
