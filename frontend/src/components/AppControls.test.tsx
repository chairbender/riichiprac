// @vitest-environment jsdom
/**
 * The View control's fourth value (3D-14).
 *
 * `AppControls` takes exposure and availability as props so this test needs no
 * module mock: before 3D-15 (`rendered3dExposed` false) the option is not
 * offered, once exposed it is, and a browser that cannot run the view gets a
 * disabled option that says why. A stored 3D value still gets a matching option
 * even while unexposed, because a `<select>` whose value has no option renders
 * blank and would misreport the saved choice.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppControls } from './AppControls';
import { ALL_SCENARIOS } from '../scenarios';
import type { TableView } from '../store/useSettingsStore';

function renderControls(
  view: TableView,
  options: {
    rendered3dExposed?: boolean;
    threeUnavailableReason?: string | null;
  } = {},
) {
  render(
    <AppControls
      scenarios={[]}
      selection={ALL_SCENARIOS}
      onSelectionChange={vi.fn()}
      onConfigureHotseat={vi.fn()}
      packStatus="empty"
      packCount={0}
      packError={null}
      preferReplay={false}
      onPreferReplayChange={vi.fn()}
      requireAgreement={false}
      aiStatus="idle"
      agreementHint=""
      onAgreementChange={vi.fn()}
      tableView={view}
      viewHint=""
      onViewChange={vi.fn()}
      rendered3dExposed={options.rendered3dExposed ?? false}
      threeUnavailableReason={options.threeUnavailableReason ?? null}
      preferReplay
      onPreferReplayChange={vi.fn()}
      onNextScenario={vi.fn()}
      nextDisabled={false}
    />,
  );
  return screen.getByRole('combobox') as HTMLSelectElement;
}

function viewOption(select: HTMLSelectElement): HTMLOptionElement | null {
  return (
    [...select.options].find((option) => option.value === 'rendered3d') ?? null
  );
}

afterEach(cleanup);

describe('AppControls View control (3D-14)', () => {
  it('offers only the two 2D views until 3D-15 exposes the 3D one', () => {
    const select = renderControls('stacked');
    expect([...select.options].map((option) => option.value)).toEqual([
      'stacked',
      'topdown',
    ]);
    expect(viewOption(select)).toBeNull();
  });

  it('offers the 3D view once exposed, enabled when it can run', () => {
    const select = renderControls('stacked', { rendered3dExposed: true });
    const option = viewOption(select);
    expect(option).not.toBeNull();
    expect(option?.disabled).toBe(false);
    expect(option?.textContent).toBe('3D');
  });

  it('lists the 3D view as unavailable, with the reason, when it cannot run', () => {
    const select = renderControls('stacked', {
      rendered3dExposed: true,
      threeUnavailableReason: '3D view unavailable: WebGL2 is not supported.',
    });
    const option = viewOption(select);
    expect(option?.disabled).toBe(true);
    expect(option?.textContent).toBe('3D (unavailable)');
    expect(option?.title).toBe('3D view unavailable: WebGL2 is not supported.');
    // Nothing forces the user's current 2D choice to change.
    expect(select.value).toBe('stacked');
  });

  it('keeps a matching option for a stored 3D choice while unexposed', () => {
    const select = renderControls('rendered3d');
    const option = viewOption(select);
    expect(option).not.toBeNull();
    expect(select.value).toBe('rendered3d');
    expect(option?.selected).toBe(true);
  });
});
