import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AppControls } from './AppControls';
import { RenderedTableHitLayer } from './RenderedTable';
import { ALL_SCENARIOS } from '../scenarios';
import { parseShellsManifest } from '../table/shellManifest';
import type { ShellsManifest } from '../table/shellManifest';
import { buildBoard } from '../table/boardLayout';
import { boardOverlay } from '../table/boardOverlay';
import { boardGameState } from '../table/boardFixture';

const tableDir = fileURLToPath(new URL('../../public/table/', import.meta.url));
const manifest: ShellsManifest = parseShellsManifest(
  JSON.parse(readFileSync(join(tableDir, 'shells.json'), 'utf8')),
);

function markup(highlightSeat: number | null = null): string {
  const state = boardGameState();
  const board = buildBoard(manifest, state);
  return renderToStaticMarkup(
    <RenderedTableHitLayer board={board} overlay={boardOverlay(board, state, highlightSeat)} />,
  );
}

describe('rendered table hit layer', () => {
  it('publishes one labelled hit area per placed tile', () => {
    const state = boardGameState();
    const board = buildBoard(manifest, state);
    const overlay = boardOverlay(board, state);
    const html = markup();
    const bodies = board.zones.reduce(
      (total, placement) => total + placement.zone.bodies.length,
      0,
    );
    expect((html.match(/data-hit-box=/g) ?? []).length).toBe(bodies);
    expect((html.match(/class="rendered-hit[ "]/g) ?? []).length).toBe(bodies);
    expect((html.match(/role="img"/g) ?? []).length).toBe(
      bodies + overlay.compass.seats.length,
    );
  });

  it('uses the top-down seat and zone names', () => {
    const html = markup();
    expect(html).toContain('aria-label="your seat, at the bottom"');
    expect(html).toContain('aria-label="your seat, at the bottom, You"');
    expect(html).toContain('aria-label="right side, shimocha, Shimocha"');
    expect(html).toContain('aria-label="You discards"');
    expect(html).toContain(
      'aria-label="Pon meld, called tile taken from the right player (shimocha)"',
    );
    expect(html).toContain(
      'aria-label="Chi meld, called tile taken from the left player (kamicha)"',
    );
    expect(html).toContain('aria-label="Shimocha discards"');
    expect(html).toContain('aria-label="Back wall"');
    expect(html).toContain('aria-label="Walls, 70 tiles remaining"');
  });

  it('publishes the published advance box for a specific tile', () => {
    const state = boardGameState();
    const board = buildBoard(manifest, state);
    const overlay = boardOverlay(board, state);
    const pond = overlay.sections
      .flatMap((section) => section.zones)
      .find((zone) => zone.id === 'pond-bottom');
    const riichi = pond?.tiles.find((tile) => tile.riichi);
    expect(riichi).toBeDefined();
    if (!riichi) return;
    const html = markup();
    expect(html).toContain(
      `data-hit-box="${riichi.x},${riichi.y},${riichi.width},${riichi.height}"`,
    );
    expect(html).toContain('aria-label="1s, riichi discard"');
  });

  it('draws every pond straight', () => {
    const html = markup();
    expect(html).toContain('data-zone="pond-right"');
    expect(html).toContain('data-zone="pond-left"');
    expect(html).not.toContain('transform:rotate');
  });

  it('marks the claiming discard without changing the rest', () => {
    const html = markup(0);
    expect((html.match(/rendered-hit--claim/g) ?? []).length).toBe(1);
    expect(html).toContain('aria-label="R5s"');
    expect(markup(null)).not.toContain('rendered-hit--claim');
  });

  it('keeps the compass information and its accessible labels', () => {
    const html = markup();
    expect(html).toContain('aria-label="Compass"');
    expect(html).toContain('aria-label="East wind, 25000 points, riichi"');
    expect(html).toContain('aria-label="South wind, 25000 points"');
    expect(html).toContain('aria-label="Round East 1, 70 tiles remaining"');
  });
});

describe('view switch', () => {
  it('offers the rendered view in the header control', () => {
    const html = renderToStaticMarkup(
      <AppControls
        scenarios={[]}
        selection={ALL_SCENARIOS}
        onSelectionChange={() => undefined}
        onConfigureHotseat={() => undefined}
        requireAgreement={false}
        aiStatus="idle"
        agreementHint=""
        onAgreementChange={() => undefined}
        tableView="rendered"
        viewHint=""
        onViewChange={() => undefined}
        onNextScenario={() => undefined}
        nextDisabled={false}
      />,
    );
    expect(html).toContain('<option value="stacked">Stacked</option>');
    expect(html).toContain('<option value="topdown">Top-down</option>');
    expect(html).toMatch(/<option value="rendered"[^>]*>Rendered<\/option>/);
  });
});
