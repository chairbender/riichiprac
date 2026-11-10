import type { AnswerFeedback } from '../store/useGameStore';
import type { PlayerState } from '../types/game';
import { Tile } from './Tile';

interface HandDockProps {
  player: PlayerState;
  feedback: AnswerFeedback | null;
  onSelectTile: (tile: string) => void;
}

/**
 * The human player's active hand, pinned to the bottom of the viewport.
 * Each of the 14 tiles is a button that submits a discard answer.
 */
export function HandDock({ player, feedback, onSelectTile }: HandDockProps) {
  const tiles = player.draw ? [...player.hand, player.draw] : player.hand;
  const isAnswered = feedback !== null;

  return (
    <section className="hand-dock" aria-label="Your hand">
      <div className="hand-dock-label">
        {isAnswered ? 'Answer submitted' : 'Tap a tile to discard'}
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
            if (isSelected && feedback.isCorrect) {
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
              aria-label={`Discard ${tile}`}
            >
              <Tile code={tile} className="tile hand-tile" />
            </button>
          );
        })}
      </div>
    </section>
  );
}
