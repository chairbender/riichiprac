// @vitest-environment jsdom
/**
 * The floating HUD shell in the app (3D-H2).
 *
 * What this file proves, in DOM facts rather than pictures:
 *
 * - the shell is one fixed layer whose only always-mounted content is the top
 *   bar, and the top bar carries **Next Scenario and full screen only** — no
 *   title, no scenario name (user decision 2026-11-19);
 * - the hand panel is anchored from `hudLayout()` to the published projection,
 *   is absent without one, and follows a new projection;
 * - the slot seams H3–H5 mount into exist and are named;
 * - the sheet opens over the scene without touching it, and Escape/scrim close
 *   it through the caller's handler;
 * - full screen promotes the shell (so the HUD travels with the scene) and
 *   reflects the browser's own state.
 *
 * The visual rules are `hudCss.test.ts`'s (position, pointer-events, z ladder);
 * this file is about the element tree and the wiring.
 */

import { useRef } from 'react';
import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompassRect } from '../contract';
import { HudLayer } from './HudLayer';
import type { HudLayerProps } from './HudLayer';
import { clearHudAnchors, publishHudAnchors } from './hudAnchors';

const ANCHOR_OWNER = {};

/* jsdom's window is 1024 x 768, which `readStageSize` falls back to; the rects
 * below are that stage's. */

const BAND = { left: 300, top: 600, width: 400, height: 60 };
const COMPASS: CompassRect = {
  left: 446,
  top: 234,
  width: 132,
  height: 132,
  centreX: 512,
  centreY: 300,
};

interface HarnessProps extends Partial<HudLayerProps> {
  readonly children?: ReactNode;
}

/** The 3D branch's shape: the shell, the HUD, and the stage with its scene. */
function Harness({ children, ...props }: HarnessProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  return (
    <div className="app-shell app-shell--3d" ref={shellRef}>
      <HudLayer
        shellRef={shellRef}
        stageRef={stageRef}
        onNextScenario={() => undefined}
        {...props}
      />
      <main className="table-3d" ref={stageRef}>
        <div data-testid="canvas" />
        {children}
      </main>
    </div>
  );
}

function publish(handBand = BAND, compass = COMPASS) {
  act(() => {
    publishHudAnchors(ANCHOR_OWNER, { handBand, compass });
  });
}

const requestFullscreen = vi.fn(async () => undefined);

beforeEach(() => {
  publish(BAND, COMPASS);
  requestFullscreen.mockClear();
  // Browsers without the Fullscreen API draw no toggle at all; jsdom is one, so
  // give the element prototype one for the tests that expect the control.
  Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
    configurable: true,
    value: requestFullscreen,
  });
});

afterEach(() => {
  cleanup();
  act(() => {
    clearHudAnchors(ANCHOR_OWNER);
  });
  Reflect.deleteProperty(document, 'fullscreenElement');
  Reflect.deleteProperty(HTMLElement.prototype, 'requestFullscreen');
});

describe('HudLayer: the shell and the top bar', () => {
  it('is one fixed layer holding the bar, the panel slot and the sheet root', () => {
    const { container } = render(<Harness hintRow={<span>hint</span>} />);
    const root = container.querySelector('.hud-root');
    expect(root).not.toBeNull();
    const roles = [...(root?.children ?? [])].map((child) =>
      child.className.replace('hud-', ''),
    );
    expect(roles).toEqual([
      'inset-probe',
      'announcer hud-visually-hidden',
      'top-bar',
      'panel',
      'sheet-root',
    ]);
    // The scene is a sibling, never a child: the HUD cannot resize it.
    expect(root?.contains(screen.getByTestId('canvas'))).toBe(false);
    expect(container.querySelector('.app-shell > main.table-3d')).not.toBeNull();
  });

  it('shows Next Scenario and full screen only, with no title or scenario name', () => {
    render(<Harness />);
    const bar = document.querySelector('.hud-top-bar');
    expect(bar).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Next scenario' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Full screen' })).toBeTruthy();
    expect(bar?.querySelectorAll('button')).toHaveLength(2);

    // No identity in the 3D HUD: no brand, no lesson label, no heading.
    expect(bar?.textContent).toBe('Next ScenarioFull screen');
    expect(bar?.querySelector('h1')).toBeNull();
    expect(bar?.textContent).not.toMatch(/riichiprac/);
  });

  it('wires Next Scenario to the caller and honours its disabled state', () => {
    const onNextScenario = vi.fn();
    const { rerender } = render(<Harness onNextScenario={onNextScenario} />);
    fireEvent.click(screen.getByRole('button', { name: 'Next scenario' }));
    expect(onNextScenario).toHaveBeenCalledTimes(1);

    rerender(<Harness onNextScenario={onNextScenario} nextDisabled />);
    const next = screen.getByRole('button', {
      name: 'Next scenario',
    }) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    fireEvent.click(next);
    expect(onNextScenario).toHaveBeenCalledTimes(1);
  });

  it('promotes the shell to full screen and reports the browser’s state', () => {
    const { container } = render(<Harness />);
    const shell = container.querySelector('.app-shell') as HTMLElement;
    const toggle = screen.getByRole('button', { name: 'Full screen' });

    fireEvent.click(toggle);
    // The shell, never the canvas: the HUD travels with the scene.
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
    expect(requestFullscreen.mock.instances[0]).toBe(shell);

    // The browser decides; the button only mirrors `fullscreenchange`.
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => shell,
    });
    act(() => {
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    expect(screen.getByRole('button', { name: 'Exit full screen' })).toBeTruthy();
  });

  it('offers no full-screen control where the API is missing', () => {
    Reflect.deleteProperty(HTMLElement.prototype, 'requestFullscreen');
    render(<Harness />);
    expect(screen.queryByRole('button', { name: /full screen/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Next scenario' })).toBeTruthy();
  });
});

describe('HudLayer: the hand panel slot', () => {
  it('mounts no panel without a projection, and the top bar does not wait', () => {
    act(() => {
      publishHudAnchors(ANCHOR_OWNER, { handBand: null, compass: null });
    });
    render(<Harness hintRow={<span>Discard 9m</span>} />);
    expect(document.querySelector('.hud-panel')).toBeNull();
    expect(screen.getByRole('button', { name: 'Next scenario' })).toBeTruthy();
  });

  it('anchors a hint-only panel to the published band, 8 px above the hand', () => {
    render(<Harness hintRow={<span>Discard 9m</span>} />);
    const panel = document.querySelector('.hud-panel') as HTMLElement;
    expect(panel).not.toBeNull();
    // 600 - 8 - 40: the hint row alone, 36rem wide and centred (H3).
    expect(panel.style.top).toBe('552px');
    expect(panel.style.left).toBe('224px');
    expect(panel.style.width).toBe('576px');
    expect(panel.style.height).toBe('40px');
    expect(panel.dataset.slot).toBe('hint');
    expect(panel.textContent).toContain('Discard 9m');
  });

  it('reserves the action row only when the rail is mounted (H3)', () => {
    const { rerender } = render(
      <Harness
        hintRow={<span>hint</span>}
        actionRail={<button type="button">Call Riichi</button>}
      />,
    );
    let panel = document.querySelector('.hud-panel') as HTMLElement;
    // 600 - 8 - 84 (hint row + action row), and both rows are mounted.
    expect(panel.style.top).toBe('508px');
    expect(panel.style.height).toBe('84px');
    expect(panel.dataset.slot).toBe('actions');
    expect(panel.querySelector('.hud-hand-rail')?.textContent).toContain('hint');
    expect(panel.querySelector('.hud-action-rail')?.textContent).toContain(
      'Call Riichi',
    );

    // An explicit null is an empty rail: unmounted, not reserved (§7.1).
    rerender(
      <Harness hintRow={<span>hint</span>} actionRail={null} />,
    );
    panel = document.querySelector('.hud-panel') as HTMLElement;
    expect(panel.dataset.slot).toBe('hint');
    expect(panel.style.height).toBe('40px');
    expect(panel.querySelector('.hud-action-rail')).toBeNull();
  });

  it('gives the result card the fixed 104 px slot and the panel replaces both rows', () => {
    render(
      <Harness
        hintRow={<span>hint</span>}
        actionRail={<button type="button">Riichi</button>}
        resultCard={<span>Correct: 9m</span>}
      />,
    );
    const panel = document.querySelector('.hud-panel') as HTMLElement;
    expect(panel.dataset.slot).toBe('result');
    expect(panel.style.top).toBe('488px');
    expect(panel.style.height).toBe('104px');
    expect(panel.textContent).toContain('Correct: 9m');
    expect(panel.textContent).not.toContain('Riichi');
  });

  it('follows a new projection instead of caching the old one', () => {
    render(<Harness hintRow={<span>hint</span>} />);
    expect((document.querySelector('.hud-panel') as HTMLElement).style.top).toBe(
      '552px',
    );

    publish({ left: 300, top: 700, width: 400, height: 60 }, COMPASS);
    expect((document.querySelector('.hud-panel') as HTMLElement).style.top).toBe(
      '652px',
    );
  });

  it('mounts the toast stack under the bar, and nothing when there are none', () => {
    const { rerender } = render(<Harness />);
    expect(document.querySelector('.hud-toast-root')).toBeNull();

    rerender(<Harness toasts={<p role="status">Loading…</p>} />);
    const stack = document.querySelector('.hud-toast-root') as HTMLElement;
    expect(stack).not.toBeNull();
    expect(stack.style.top).toBe(`${56 + 8}px`);
    expect(stack.textContent).toContain('Loading…');
  });
});

describe('HudLayer: the result live region (3D-H5)', () => {
  it('keeps one persistent status node and only changes its text', () => {
    const { container, rerender } = render(
      <Harness hintRow={<span>hint</span>} />,
    );
    const announcer = container.querySelector(
      '.hud-announcer',
    ) as HTMLElement;
    expect(announcer).not.toBeNull();
    expect(announcer.getAttribute('role')).toBe('status');
    expect(announcer.getAttribute('aria-live')).toBe('polite');
    expect(announcer.textContent).toBe('');

    rerender(
      <Harness
        hintRow={<span>hint</span>}
        announcement="Result: Correct. The book and Mortal agree."
      />,
    );
    const afterAnswer = container.querySelector('.hud-announcer') as HTMLElement;
    // Same node: a new deal is not a re-announcement of the old answer simply
    // because the card re-rendered.
    expect(afterAnswer).toBe(announcer);
    expect(afterAnswer.textContent).toBe(
      'Result: Correct. The book and Mortal agree.',
    );

    // Opening the sheet unmounts the result card but not the announcement.
    rerender(
      <Harness
        hintRow={<span>hint</span>}
        announcement="Result: Correct. The book and Mortal agree."
        sheet={{ title: 'Verdict', body: <p>Book says 9m</p> }}
      />,
    );
    expect(container.querySelector('.hud-announcer')).toBe(announcer);
    expect(announcer.textContent).toBe(
      'Result: Correct. The book and Mortal agree.',
    );
  });
});

describe('HudLayer: the sheet seam', () => {
  it('opens a caller-owned sheet over the scene and closes it through the caller', () => {
    const onCloseSheet = vi.fn();
    const { container, rerender } = render(
      <Harness
        sheet={{ title: 'Setup', body: <button type="button">Deal from pool</button> }}
        onCloseSheet={onCloseSheet}
      />,
    );
    expect(screen.getByRole('dialog', { name: 'Setup' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Deal from pool' })).toBeTruthy();
    // The panel collapses to its hint row while the sheet is open.
    expect(screen.getByTestId('canvas').isConnected).toBe(true);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCloseSheet).toHaveBeenCalledTimes(1);

    // The caller decides; a null sheet removes the dialog and the inert marks.
    rerender(<Harness onCloseSheet={onCloseSheet} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(container.querySelector('main.table-3d')?.hasAttribute('inert')).toBe(
      false,
    );
  });

  it('marks the stage and the HUD background inert while the sheet is open', () => {
    const { container } = render(
      <Harness sheet={{ title: 'Verdict', body: <p>Book says 9m</p> }} />,
    );
    const stage = container.querySelector('main.table-3d') as HTMLElement;
    const bar = container.querySelector('.hud-top-bar') as HTMLElement;
    expect(stage.hasAttribute('inert')).toBe(true);
    expect(bar.hasAttribute('inert')).toBe(true);
  });

  it('keeps the scene mounted across every sheet state and remount', () => {
    const onNextScenario = vi.fn();
    const { rerender } = render(<Harness onNextScenario={onNextScenario} />);
    const canvas = screen.getByTestId('canvas');
    rerender(
      <Harness
        onNextScenario={onNextScenario}
        sheet={{ title: 'Setup', body: null }}
      />,
    );
    expect(screen.getByTestId('canvas')).toBe(canvas);
    rerender(
      <Harness
        onNextScenario={onNextScenario}
        sheet={{ title: 'Verdict', body: null }}
      />,
    );
    expect(screen.getByTestId('canvas')).toBe(canvas);
    rerender(<Harness onNextScenario={onNextScenario} />);
    expect(screen.getByTestId('canvas')).toBe(canvas);
    // A sheet is a modal over the scene, never a re-deal.
    expect(onNextScenario).not.toHaveBeenCalled();
  });

  it('collapses the panel to its hint row while a sheet is open', () => {
    render(
      <Harness
        hintRow={<span>Discard 9m</span>}
        actionRail={<button type="button">Riichi</button>}
        sheet={{ title: 'Setup', body: null }}
      />,
    );
    const panel = document.querySelector('.hud-panel') as HTMLElement;
    expect(panel.dataset.slot).toBe('hint');
    // 600 - 8 - 40: the hint row alone, so no visible control is inert.
    expect(panel.style.height).toBe('40px');
    expect(panel.style.top).toBe('552px');
    expect(panel.textContent).toContain('Discard 9m');
    expect(panel.textContent).not.toContain('Riichi');
  });
});

describe('HudLayer: what the layer may never cover', () => {
  it('mounts only named HUD regions — no node over the felt that takes taps', () => {
    render(<Harness hintRow={<span>hint</span>} toasts={<p role="status">hi</p>} />);
    const root = document.querySelector('.hud-root') as HTMLElement;
    const allowed = new Set([
      'hud-inset-probe',
      'hud-announcer hud-visually-hidden',
      'hud-top-bar',
      'hud-panel',
      'hud-toast-root',
      'hud-sheet-root',
    ]);
    for (const child of root.children) {
      expect(allowed.has(child.className), child.className).toBe(true);
    }
    // The felt under the HUD is not inside it, so nothing intercepts a tap
    // outside a control; the layer's own `pointer-events: none` is pinned by
    // `hudCss.test.ts`.
    expect(root.querySelector('[data-testid="canvas"]')).toBeNull();
  });

  it('leaves the felt reachable and every mounted control live', () => {
    const onFelt = vi.fn();
    const onNextScenario = vi.fn();
    render(
      <Harness
        onNextScenario={onNextScenario}
        hintRow={<span>hint</span>}
        toasts={<p role="status">hi</p>}
      >
        <div data-testid="felt" onClick={onFelt} />
      </Harness>,
    );

    // A tap on the board reaches the stage, which is outside the HUD's tree.
    fireEvent.click(screen.getByTestId('felt'));
    expect(onFelt).toHaveBeenCalledTimes(1);

    // And every control the HUD mounts is a live button.
    const root = document.querySelector('.hud-root') as HTMLElement;
    const buttons = [...root.querySelectorAll('button')];
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    for (const button of buttons) expect(button.disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Next scenario' }));
    expect(onNextScenario).toHaveBeenCalledTimes(1);
  });
});
