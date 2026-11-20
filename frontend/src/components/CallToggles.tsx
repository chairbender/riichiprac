import type { AiEvaluation } from '../types/ai';
import { formatProbability } from '../types/ai';
import { formatTileForDisplay } from '../display';
import { KanIcon } from './KanIcon';
import { RiichiStick } from './RiichiStick';

export interface CallTogglesProps {
  /** Whether Riichi is a legal declaration for this hand (Rust-derived). */
  readonly canRiichi: boolean;
  /**
   * The tile the Call Kan applies to, or null. Non-null only on a Kan lesson
   * that holds a callable quad (see `kanToggleTile`).
   */
  readonly kanTile: string | null;
  /** Call Riichi is armed. */
  readonly callRiichi: boolean;
  /** Call Kan is armed. */
  readonly callKan: boolean;
  /** Disables both controls (the hand is answered). */
  readonly disabled?: boolean;
  /** Latest Mortal evaluation, for the Kan probability chip. */
  readonly evaluation?: AiEvaluation | null;
  /** Whether Mortal's probability may be shown (answered, or deliberately peeked). */
  readonly revealMortal?: boolean;
  readonly onToggleRiichi: () => void;
  readonly onToggleKan: () => void;
}

/**
 * The Riichi and Kan declaration toggles.
 *
 * Extracted from `HandDock` for 3D-H3: the two controls are decisions, not hand
 * chrome, so the 3D HUD renders them in its action rail while the 2D dock keeps
 * them at the top of the hand. Both shells render this one component, so the
 * labels, `aria-pressed` state, ON/OFF words and the Mortal probability chip
 * cannot drift between the views.
 *
 * Arming is the whole interaction: the next hand-tile click (the dock's tile
 * button or 3D-08's projected one) submits the armed declaration with that tile.
 */
export function CallToggles({
  canRiichi,
  kanTile,
  callRiichi,
  callKan,
  disabled = false,
  evaluation = null,
  revealMortal = false,
  onToggleRiichi,
  onToggleKan,
}: CallTogglesProps) {
  if (!canRiichi && !kanTile) return null;

  // The Call Kan toggle is a decision in its own right: surface Mortal's
  // probability for the kan rather than only the discard badges on the tiles.
  const kanProbability =
    kanTile && revealMortal
      ? evaluation?.evaluations.find((action) => action.action === 'Kan')
          ?.probability
      : undefined;

  return (
    <div className="call-toggles">
      {canRiichi && (
        <button
          type="button"
          className={`riichi-toggle${callRiichi ? ' riichi-toggle--active' : ''}`}
          onClick={onToggleRiichi}
          disabled={disabled}
          aria-pressed={callRiichi}
          aria-label={`Call Riichi toggle, currently ${callRiichi ? 'on' : 'off'}`}
        >
          <RiichiStick className="riichi-toggle-stick" />
          <span className="riichi-toggle-label">Call Riichi</span>
          <span className="riichi-toggle-state">{callRiichi ? 'ON' : 'OFF'}</span>
        </button>
      )}

      {kanTile && (
        <button
          type="button"
          className={`kan-toggle${callKan ? ' kan-toggle--active' : ''}`}
          onClick={onToggleKan}
          disabled={disabled}
          aria-pressed={callKan}
          aria-label={`Call Kan toggle for ${formatTileForDisplay(
            kanTile,
          )}, currently ${callKan ? 'on' : 'off'}`}
        >
          <KanIcon className="kan-toggle-icon" />
          <span className="kan-toggle-label">Call Kan</span>
          <span className="kan-toggle-tile">{formatTileForDisplay(kanTile)}</span>
          {kanProbability !== undefined && (
            <span
              className="kan-toggle-probability"
              aria-label={`Mortal rates Kan ${formatProbability(kanProbability)}`}
            >
              {formatProbability(kanProbability)}
            </span>
          )}
          <span className="kan-toggle-state">{callKan ? 'ON' : 'OFF'}</span>
        </button>
      )}
    </div>
  );
}
