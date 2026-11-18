import { describe, expect, it } from 'vitest';
import {
  BOARD_MARGIN_FRACTION,
  feltSidePx,
  fitBoardPlan,
} from './BoardRenderer';
import type { BoardPlan } from './boardPlan';

const plan = (width: number, height: number): BoardPlan => ({
  zones: [],
  width,
  height,
  blurPadPx: 36,
  centreGapPx: 231,
  centreX: width / 2,
  centreY: height / 2,
});

describe('feltSidePx', () => {
  it('sizes the square from the window height so the edge touches top and bottom', () => {
    expect(feltSidePx(1920, 1080)).toBe(1080);
    expect(feltSidePx(390, 844)).toBe(844);
    expect(feltSidePx(844, 390)).toBe(390);
  });
});

describe('fitBoardPlan', () => {
  it('fits the board inside the visible square, centred, with the margin', () => {
    const board = plan(1600, 1200);
    for (const [cssWidth, cssHeight] of [
      [1920, 1080],
      [390, 844],
      [844, 390],
      [1080, 1080],
    ]) {
      const fit = fitBoardPlan(board, cssWidth, cssHeight);
      const side = Math.min(cssWidth, cssHeight);
      const margin = Math.max(6, side * BOARD_MARGIN_FRACTION);
      expect(board.width * fit.scale).toBeLessThanOrEqual(side - margin * 2 + 0.001);
      expect(board.height * fit.scale).toBeLessThanOrEqual(
        side - margin * 2 + 0.001,
      );
      // The board is centred on the viewport.
      expect(
        fit.originX + (board.width * fit.scale) / 2,
      ).toBeCloseTo(cssWidth / 2, 6);
      expect(
        fit.originY + (board.height * fit.scale) / 2,
      ).toBeCloseTo(cssHeight / 2, 6);
      // And it never leaves the viewport.
      expect(fit.originX).toBeGreaterThanOrEqual(-0.001);
      expect(fit.originY).toBeGreaterThanOrEqual(-0.001);
    }
  });

  it('keeps a wide window letterboxed: the square felt is the height', () => {
    const fit = fitBoardPlan(plan(1000, 1000), 1920, 1080);
    expect(fit.scale).toBeLessThanOrEqual(
      (1080 - 2 * Math.max(6, 1080 * BOARD_MARGIN_FRACTION)) / 1000,
    );
    expect(fit.originX).toBeGreaterThan(0);
  });

  it('reserves the floating HUD band and keeps the board above it', () => {
    const board = plan(1600, 1200);
    const inset = 220;
    const fit = fitBoardPlan(board, 1920, 1080, inset);
    const margin = Math.max(6, 1080 * BOARD_MARGIN_FRACTION);
    expect(fit.originY).toBeGreaterThanOrEqual(margin - 0.001);
    expect(fit.originY + board.height * fit.scale).toBeLessThanOrEqual(
      1080 - inset - margin + 0.001,
    );
    // Still centred horizontally and never leaves the felt's width.
    expect(fit.originX + (board.width * fit.scale) / 2).toBeCloseTo(960, 6);
  });

  it('survives an empty plan without dividing by zero', () => {
    expect(fitBoardPlan(plan(0, 0), 100, 100)).toEqual({
      scale: 1,
      originX: 0,
      originY: 0,
    });
  });
});
