import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { GameState } from '../types/game';
import { NextScenarioButton } from './NextScenarioButton';

interface TableStageProps {
  /** The hand on screen, or null while the next one loads. */
  state: GameState | null;
  /** A load/agreement status line, shown as a light overlay. */
  statusMessage: string | null;
  /** A generation or import error, shown as a light overlay. */
  error: string | null;
  /** True once the hand has been answered, which reveals Next Scenario. */
  answered: boolean;
  nextDisabled: boolean;
  onNextScenario: () => void;
  /** Everything that used to live in the header and TableInfo. */
  menu: ReactNode;
  /** The fitted table view. */
  table: ReactNode;
  /** The top-right decision panel, when the hand needs a non-discard answer. */
  popup?: ReactNode;
}

const DRAWER_ID = 'table-stage-menu-drawer';

/**
 * Full-screen shell for a fitted table view.
 *
 * Unlike the stacked layout there is no 680px column and no header: the stage
 * is the viewport, the table is fitted inside it, and only a small top-left
 * toolbar floats over the table. Everything the header and `TableInfo` used to
 * show moves into a drawer behind that toolbar, so the table itself is the
 * whole screen while every control stays reachable.
 *
 * The drawer and the decision popup are positioned overlays, never layout
 * siblings of the table. Opening the menu therefore cannot resize or re-fit
 * the table behind it.
 *
 * The shell is generic table chrome, not part of any one renderer: the offline
 * rendered table mounts its sprite compositor here (Task 4 of the rendered-table
 * chain). It is kept out of the view switch until that view exists, so the app
 * still offers only the stacked and top-down views.
 */
export function TableStage({
  state,
  statusMessage,
  error,
  answered,
  nextDisabled,
  onNextScenario,
  menu,
  table,
  popup,
}: TableStageProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    menuButtonRef.current?.focus();
  }, []);

  // Move focus into the drawer when it opens, and let Escape close it from
  // anywhere (including the scenario panel inside it).
  useEffect(() => {
    if (!menuOpen) return;

    closeButtonRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeMenu();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [menuOpen, closeMenu]);

  return (
    <div className="table-stage">
      <div className="table-stage-table">{table}</div>

      <div className="table-stage-toolbar">
        <button
          ref={menuButtonRef}
          type="button"
          className="table-stage-menu-button"
          onClick={() => setMenuOpen((open) => !open)}
          aria-expanded={menuOpen}
          aria-controls={DRAWER_ID}
          aria-label="Table menu"
        >
          <span className="table-stage-menu-icon" aria-hidden="true">
            ☰
          </span>
          <span>Menu</span>
        </button>

        <div className="table-stage-status">
          {state ? (
            <>
              <span className="table-stage-status-round">
                {state.round_wind} {state.hand_number}
              </span>
              <span className="table-stage-status-detail">
                {state.honba} honba · {state.tiles_remaining} tiles left
              </span>
            </>
          ) : (
            <span className="table-stage-status-detail" role="status">
              {statusMessage ?? 'Loading table…'}
            </span>
          )}
        </div>

        {answered && (
          <NextScenarioButton
            onClick={onNextScenario}
            disabled={nextDisabled}
          />
        )}
      </div>

      {statusMessage && state && (
        <div
          className="table-stage-overlay table-stage-overlay--status"
          role="status"
        >
          {statusMessage}
        </div>
      )}

      {error && (
        <div
          className="table-stage-overlay table-stage-overlay--error"
          role="alert"
        >
          {error}
        </div>
      )}

      {popup}

      {menuOpen && (
        <div className="table-stage-menu-backdrop" onClick={closeMenu}>
          <aside
            className="table-stage-menu-drawer"
            id={DRAWER_ID}
            role="dialog"
            aria-label="Table menu"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="table-stage-menu-head">
              <h2 className="table-stage-menu-title">Menu</h2>
              <button
                ref={closeButtonRef}
                type="button"
                className="table-stage-menu-close"
                onClick={closeMenu}
              >
                Close
              </button>
            </header>
            <div className="table-stage-menu-body">{menu}</div>
          </aside>
        </div>
      )}
    </div>
  );
}
