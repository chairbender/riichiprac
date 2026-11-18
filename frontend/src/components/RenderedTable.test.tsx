// @vitest-environment jsdom
/**
 * The rendered table's DOM contract, without a canvas.
 *
 * jsdom has no 2D context, which is also the browser failure path: the view
 * must still name itself, expose the compass and a textual table summary, and
 * say why the board is not drawn. The composed board itself is covered by
 * `boardPlan.test.ts` (geometry) and the `rendered:review` script (pixels).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GameState } from '../types/game';
import { parseShellsManifest } from '../table/shellManifest';
import type { TileAtlas } from '../table/TileAtlas';
import type { BoardAssets } from '../table/boardAssets';

vi.mock('riichi-mahjong-tiles', () => ({
  RegularTon: () => null,
  RegularNan: () => null,
  RegularShaa: () => null,
  RegularPei: () => null,
}));

import { RenderedTable } from './RenderedTable';

const scenariosDir = join(process.cwd(), 'public', 'scenarios');
const packManifest = JSON.parse(
  readFileSync(join(scenariosDir, 'manifest.json'), 'utf8'),
) as { packs: Array<{ path: string }> };
const pack = JSON.parse(
  gunzipSync(
    readFileSync(join(scenariosDir, packManifest.packs[0].path)),
  ).toString('utf8'),
) as { scenarios: Array<{ lesson_id: string; state: GameState }> };
const fixture = pack.scenarios.find(
  (scenario) => scenario.lesson_id === 'ryanmen_protorun',
);
if (!fixture) throw new Error('fixture pack is missing ryanmen_protorun');
const state = fixture.state;

const shells = parseShellsManifest(
  JSON.parse(
    readFileSync(join(process.cwd(), 'public/table/shells.json'), 'utf8'),
  ),
);

const fakeAtlas = {
  shells,
  hasSprite: () => false,
  getSprite: () => {
    throw new Error('not used without a canvas');
  },
  getPage: () => {
    throw new Error('not used without a canvas');
  },
} as unknown as TileAtlas;

const assets: BoardAssets = {
  overlays: null,
  catches: null,
  lyingCatches: null,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('RenderedTable', () => {
  it('names the view, exposes the compass and a textual table summary', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);

    render(
      <RenderedTable
        state={state}
        loadAtlas={async () => fakeAtlas}
        loadAssets={async () => assets}
      />,
    );

    // The canvas is decoration; the view is named for assistive technology.
    expect(
      screen.getByRole('group', { name: 'Rendered table view' }),
    ).toBeTruthy();
    expect(screen.getByText('Rendered table view')).toBeTruthy();

    // The compass is real DOM: one labelled corner per seat.
    expect(screen.getByRole('group', { name: 'Compass' })).toBeTruthy();
    for (const seat of state.players) {
      expect(
        screen.getByRole('img', {
          name: new RegExp(
            `${seat.wind} wind, ${seat.score} points`,
          ),
        }),
      ).toBeTruthy();
    }

    // Every seat's discards/melds are readable as text.
    const summary = screen.getByLabelText('Table summary');
    expect(summary).toBeTruthy();
    expect(summary.textContent).toContain('Discards:');
    expect(summary.textContent).toContain('Melds:');

    // The felt square is the committed raster.
    const felt = document.querySelector('.rendered-table-felt') as HTMLElement;
    expect(felt.style.backgroundImage).toContain('felt.png');

    // And the failure is explained instead of a blank stage.
    await waitFor(() => {
      expect(
        screen.getByRole('alert').textContent,
      ).toContain('could not get a 2D canvas');
    });
  });
});
