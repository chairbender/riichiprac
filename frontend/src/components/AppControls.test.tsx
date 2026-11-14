// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AppControls } from './AppControls';
import type { TableView } from '../store/useSettingsStore';

afterEach(cleanup);

function props(overrides: Partial<Parameters<typeof AppControls>[0]> = {}) {
  return {
    scenarios: [],
    selection: { kind: 'all' } as const,
    onSelectionChange: vi.fn(),
    requireAgreement: false,
    aiStatus: 'ready' as const,
    agreementHint: 'hint',
    onAgreementChange: vi.fn(),
    tableView: 'stacked' as TableView,
    viewHint: 'hint',
    onViewChange: vi.fn(),
    onNextScenario: vi.fn(),
    nextDisabled: false,
    ...overrides,
  };
}

describe('view control', () => {
  it('offers stacked, top-down and rendered, with stacked selected by default', () => {
    render(<AppControls {...props()} />);
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual([
      'stacked',
      'topdown',
      'rendered',
    ]);
    expect(select.value).toBe('stacked');
  });

  it('reports the rendered choice without substituting the hand', () => {
    const seen: string[] = [];
    render(
      <AppControls
        {...props({
          onViewChange: (event) => {
            seen.push(event.target.value);
          },
        })}
      />,
    );
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'rendered' },
    });
    expect(seen).toEqual(['rendered']);
  });
});
