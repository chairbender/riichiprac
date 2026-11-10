import { findKanCandidateTile } from '../actions';
import type { AnswerFeedback } from '../store/useGameStore';
import type { AiEvaluation } from '../types/ai';
import {
  discardProbabilitiesByTile,
  formatProbability,
} from '../types/ai';
import type { PlayerState } from '../types/game';
import { KanIcon } from './KanIcon';
import { RiichiStick } from './RiichiStick';
import { Tile } from './Tile';

interface HandDockProps {
  player: PlayerState;
  feedback: AnswerFeedback | null;
  callRiichi: boolean;
  callKan: boolean;
  /** Latest Mortal evaluation for the table, if the player ran one. */
  aiEvaluation: AiEvaluation | null;
  onToggleRiichi: () => void;
  onToggleKan: () => void;
  onSelectTile: (tile: string, index?: number) => void;
}

/**
 * The human player's active hand, pinned to the bottom of the viewport.
 * The "Call Riichi" and "Call Kan" toggles arm a declaration; clicking a tile
 * then submits the armed action together with the clicked tile. The Kan button
 * only appears when the hand holds the fourth tile of an open Pon.
 */
export function HandDock({
  player,
  feedback,
  callRiichi,
  callKan,
  aiEvaluation,
  onToggleRiichi,
  onToggleKan,
  onSelectTile,
}: HandDockProps) {
  const tiles = player.draw ? [...player.hand, player.draw] : player.hand;
  const isAnswered = feedback !== null;
  const kanTile = findKanCandidateTile(player);

  let handHint = 'Dama selected - tap a tile to discard';
  if (isAnswered) {
    handHint = 'Answer submitted';
  } else if (callKan) {
    handHint = `Kan armed - tap ${kanTile} to declare Shouminkan`;
  } else if (callRiichi) {
    handHint = 'Riichi selected - tap a tile to discard';
  } else if (kanTile) {
    handHint = 'Tap a tile to discard, or arm Call Kan';
  }

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

  // AI badges only make sense before the answer is submitted.
  const aiProbabilities = isAnswered
    ? new Map<string, number>()
    : discardProbabilitiesByTile(aiEvaluation);
  let topAiTile: string | null = null;
  let topAiProbability = 0;
  for (const [tile, probability] of aiProbabilities) {
    if (probability > topAiProbability) {
      topAiProbability = probability;
      topAiTile = tile;
    }
  }

  return (
    <section className="hand-dock" aria-label="Your hand">
      <div className="call-toggles">
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
          <span className="riichi-toggle-state">
            {callRiichi ? 'ON' : 'OFF'}
          </span>
        </button>

        {kanTile && (
          <button
            type="button"
            className={`kan-toggle${callKan ? ' kan-toggle--active' : ''}`}
            onClick={onToggleKan}
            disabled={isAnswered}
            aria-pressed={callKan}
            aria-label={`Call Kan toggle for ${kanTile}, currently ${
              callKan ? 'on' : 'off'
            }`}
          >
            <KanIcon className="kan-toggle-icon" />
            <span className="kan-toggle-label">Call Kan</span>
            <span className="kan-toggle-tile">{kanTile}</span>
            <span className="kan-toggle-state">{callKan ? 'ON' : 'OFF'}</span>
          </button>
        )}
      </div>

      <div className="hand-dock-label" aria-live="polite">
        {handHint}
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

          const aiProbability = aiProbabilities.get(tile);
          let aiClass = '';
          if (aiProbability !== undefined && aiProbability >= 0.01) {
            aiClass = ' hand-tile-button--ai';
            if (tile === topAiTile) {
              aiClass += ' hand-tile-button--ai-top';
            }
          }

          return (
            <button
              key={`${tile}-${index}`}
              type="button"
              className={`hand-tile-button${stateClass}${aiClass}`}
              onClick={() => onSelectTile(tile, index)}
              disabled={isAnswered}
              aria-label={`${
                callKan ? `Declare Kan on ${tile}` : `Discard ${tile}`
              }${redFiveFlags[index] ? ', red five' : ''}${
                callRiichi ? ', with Riichi' : ''
              }`}
            >
              {aiProbability !== undefined && aiProbability >= 0.01 && (
                <span className="ai-tile-badge" aria-hidden="true">
                  {formatProbability(aiProbability)}
                </span>
              )}
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
