import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { GameState } from '../types/game';
import { NextScenarioButton } from './NextScenarioButton';

interface IsometricShellProps {
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
  /** The fitted table SVG. */
  table: ReactNode;
  /** The top-right decision panel, when the hand needs a non-discard answer. */
  popup?: ReactNode;
}

const DRAWER_ID = 'iso-menu-drawer';

/**
 * Full-screen shell for the isometric view.
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
 */
export function IsometricShell({
  state,
  statusMessage,
  error,
  answered,
  nextDisabled,
  onNextScenario,
  menu,
  table,
  popup,
}: IsometricShellProps) {
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
    <div className="iso-stage">
      <div className="iso-table-layer">{table}</div>

      <div className="iso-toolbar">
        <button
          ref={menuButtonRef}
          type="button"
          className="iso-menu-button"
          onClick={() => setMenuOpen((open) => !open)}
          aria-expanded={menuOpen}
          aria-controls={DRAWER_ID}
          aria-label="Table menu"
        >
          <span className="iso-menu-icon" aria-hidden="true">
            ☰
          </span>
          <span>Menu</span>
        </button>

        <div className="iso-toolbar-status">
          {state ? (
            <>
              <span className="iso-status-round">
                {state.round_wind} {state.hand_number}
              </span>
              <span className="iso-status-detail">
                {state.honba} honba · {state.tiles_remaining} tiles left
              </span>
            </>
          ) : (
            <span className="iso-status-detail" role="status">
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
        <div className="iso-overlay iso-overlay--status" role="status">
          {statusMessage}
        </div>
      )}

      {error && (
        <div className="iso-overlay iso-overlay--error" role="alert">
          {error}
        </div>
      )}

      {popup}

      {menuOpen && (
        <div className="iso-menu-backdrop" onClick={closeMenu}>
          <aside
            className="iso-menu-drawer"
            id={DRAWER_ID}
            role="dialog"
            aria-label="Table menu"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="iso-menu-head">
              <h2 className="iso-menu-title">Menu</h2>
              <button
                ref={closeButtonRef}
                type="button"
                className="iso-menu-close"
                onClick={closeMenu}
              >
                Close
              </button>
            </header>
            <div className="iso-menu-body">{menu}</div>
          </aside>
        </div>
      )}
    </div>
  );
}
