import type { AnswerFeedback } from '../store/useGameStore';
import type { PlayerState } from '../types/game';
import { RiichiStick } from './RiichiStick';
import { Tile } from './Tile';

interface HandDockProps {
  player: PlayerState;
  feedback: AnswerFeedback | null;
  callRiichi: boolean;
  onToggleRiichi: () => void;
  onSelectTile: (tile: string) => void;
}

/**
 * The human player's active hand, pinned to the bottom of the viewport.
 * The "Call Riichi" toggle arms a Riichi declaration; clicking a tile then
 * submits the toggle state (Riichi or Dama) together with the discard.
 */
export function HandDock({
  player,
  feedback,
  callRiichi,
  onToggleRiichi,
  onSelectTile,
}: HandDockProps) {
  const tiles = player.draw ? [...player.hand, player.draw] : player.hand;
  const isAnswered = feedback !== null;
  const selectedType = callRiichi ? 'Riichi' : 'Dama';

  // Mark specific copies as red fives; a tile code can appear more than once.
  const redFiveCounts = new Map<string, number>();
  for (const code of player.red_fives) {
    redFiveCounts.set(code, (redFiveCounts.get(code) ?? 0) + 1);
  }
  const redFiveFlags = tiles.map((tile) => {
    const remaining = redFiveCounts.get(tile) ?? 0;
    if (remaining === 0) return false;
    redFiveCounts.set(tile, remaining - 1);
    return true;
  });

  return (
    <section className="hand-dock" aria-label="Your hand">
      <button
        type="button"
        className={`riichi-toggle${callRiichi ? ' riichi-toggle--active' : ''}`}
        onClick={onToggleRiichi}
        disabled={isAnswered}
        aria-pressed={callRiichi}
        aria-label={`Call Riichi toggle, currently ${callRiichi ? 'on' : 'off'}`}
      >
        <RiichiStick className="riichi-toggle-stick" />
        <span className="riichi-toggle-label">Call Riichi</span>
        <span className="riichi-toggle-state">{callRiichi ? 'ON' : 'OFF'}</span>
      </button>

      <div className="hand-dock-label" aria-live="polite">
        {isAnswered
          ? 'Answer submitted'
          : `${selectedType} selected - tap a tile to discard`}
      </div>

      <div
        className="hand"
        style={{ gridTemplateColumns: `repeat(${tiles.length}, minmax(0, 1fr))` }}
      >
        {tiles.map((tile, index) => {
          const isSelected = feedback?.selectedTile === tile;
          const isCorrectTile = feedback?.correctTile === tile;

          let stateClass = '';
          if (feedback) {
            if (isSelected && feedback.isTileCorrect) {
              stateClass = ' hand-tile-button--correct';
            } else if (isSelected) {
              stateClass = ' hand-tile-button--incorrect';
            } else if (isCorrectTile) {
              stateClass = ' hand-tile-button--answer';
            }
          }

          return (
            <button
              key={`${tile}-${index}`}
              type="button"
              className={`hand-tile-button${stateClass}`}
              onClick={() => onSelectTile(tile)}
              disabled={isAnswered}
              aria-label={`Discard ${redFiveFlags[index] ? 'red five ' : ''}${tile}${
                callRiichi ? ' and call Riichi' : ''
              }`}
            >
              <Tile
                code={tile}
                className="tile hand-tile"
                isRedFive={redFiveFlags[index]}
              />
            </button>
          );
        })}
      </div>
    </section>
  );
}
