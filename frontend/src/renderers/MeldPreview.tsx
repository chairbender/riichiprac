/**
 * `?preview=melds`: the 3D board built from the deterministic layout fixture
 * (task 261120-2225).
 *
 * It replaces the whole app at the entry point so a meld-heavy board can be
 * reviewed without dealing one. There is no game state, WASM, store, answer or
 * HUD here: only the board and a small control bar. Controls write the URL, so a
 * composition can be linked to directly:
 *
 *   ?preview=melds&melds=4,4,4,4&kan=1&human=0
 *
 * The board is the same `boardFixture` the layout gate uses, so what the eye is
 * judging is exactly what the numeric gate measured.
 */

import { useEffect, useMemo, useState } from 'react';
import type { Seat } from './contract';
import { RendererHost } from './RendererHost';
import {
  MAX_MELDS,
  meldPreviewFixture,
  meldPreviewSearch,
  parseMeldPreviewOptions,
} from './meldPreview';
import type { MeldPreviewOptions } from './meldPreview';
import '../App.css';
import './MeldPreview.css';

/** The viewport position of each absolute seat, with the human at the bottom. */
const SEAT_LABELS = ['bottom', 'right', 'top', 'left'] as const;

const PRESETS = [0, 1, 2, 3, 4] as const;

export function MeldPreview() {
  const [options, setOptions] = useState<MeldPreviewOptions>(() =>
    parseMeldPreviewOptions(window.location.search),
  );
  const [revision, setRevision] = useState(1);

  // A new options set is a new cut: the fixture alone keeps `revision: 1`.
  useEffect(() => {
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${meldPreviewSearch(options)}`,
    );
  }, [options]);

  const snapshot = useMemo(
    () => meldPreviewFixture(options, revision),
    [options, revision],
  );

  const update = (next: MeldPreviewOptions) => {
    setOptions(next);
    setRevision((value) => value + 1);
  };

  const setSeatMelds = (seat: Seat, value: number) => {
    const counts = [...options.meldCounts] as [number, number, number, number];
    counts[seat] = value;
    update({ ...options, meldCounts: counts });
  };

  return (
    <div className="app-shell app-shell--3d">
      <main className="table-3d">
        <RendererHost
          snapshot={snapshot}
          fallback={
            <p className="meld-preview__fallback" role="status">
              This browser cannot run the 3D preview (WebGL2 is required).
            </p>
          }
        />
      </main>

      <aside className="meld-preview" aria-label="Meld layout preview controls">
        <header className="meld-preview__head">
          <strong>Meld layout preview</strong>
          <span>fixture board · not a game hand</span>
        </header>

        <div className="meld-preview__row">
          <span className="meld-preview__label">melds per seat</span>
          {([0, 1, 2, 3] as const).map((seat) => (
            <label key={seat} className="meld-preview__field">
              <span>{SEAT_LABELS[seat]}</span>
              <select
                value={options.meldCounts[seat] ?? 0}
                onChange={(event) => setSeatMelds(seat, Number(event.target.value))}
              >
                {Array.from({ length: MAX_MELDS + 1 }, (_, count) => (
                  <option key={count} value={count}>
                    {count}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>

        <div className="meld-preview__row">
          <span className="meld-preview__label">every seat</span>
          {PRESETS.map((count) => (
            <button
              key={count}
              type="button"
              onClick={() =>
                update({
                  ...options,
                  meldCounts: [count, count, count, count],
                })
              }
            >
              {count}
            </button>
          ))}
          <button
            type="button"
            aria-pressed={options.kan}
            onClick={() => update({ ...options, kan: !options.kan })}
          >
            kan
          </button>
        </div>

        <div className="meld-preview__row">
          <label className="meld-preview__field">
            <span>human</span>
            <select
              value={options.humanSeat}
              onChange={(event) =>
                update({ ...options, humanSeat: Number(event.target.value) as Seat })
              }
            >
              {SEAT_LABELS.map((label, seat) => (
                <option key={label} value={seat}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <a className="meld-preview__exit" href="?">
            exit preview
          </a>
        </div>

        <p className="meld-preview__note">
          melds {options.meldCounts.join('/')} ·{' '}
          {options.kan ? 'each first meld is a kan' : 'no kans'} · human{' '}
          {SEAT_LABELS[options.humanSeat]}
        </p>
      </aside>
    </div>
  );
}
