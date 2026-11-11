import { findKanCandidateTile } from '../actions';
import { formatTileForDisplay } from '../display';
import type { SubmittedAnswer } from '../store/useGameStore';
import type { AiActionInfo, AiEvaluation } from '../types/ai';
import {
  discardProbabilitiesByTile,
  formatProbability,
} from '../types/ai';
import type { PlayerState, TargetAction } from '../types/game';
import type { DualGrade } from '../types/verdict';
import { mortalRecommendedTile } from '../types/verdict';
import { AnswerSummary } from './AnswerSummary';
import { KanIcon } from './KanIcon';
import { NextScenarioButton } from './NextScenarioButton';
import { RiichiStick } from './RiichiStick';
import { Tile } from './Tile';

interface HandDockProps {
  player: PlayerState;
  /** Dual verdict for the current answer, or null before answering. */
  grade: DualGrade | null;
  /** The answer the player submitted, if any. */
  answer: SubmittedAnswer | null;
  callRiichi: boolean;
  callKan: boolean;
  /** Latest Mortal evaluation for the table, if one exists. */
  aiEvaluation: AiEvaluation | null;
  /** Non-discard actions for an AI scenario; undefined for legacy lessons. */
  availableActions?: AiActionInfo[];
  /** False when a reaction state has no discard option. */
  canDiscard?: boolean;
  /** Whether Riichi is a legal declaration for this hand (Rust-derived). */
  canRiichi?: boolean;
  /** Whether Mortal's probability badges may be shown. */
  revealMortal?: boolean;
  /** What the state asks for; a `Defend` lesson is a pure-defense fold. */
  targetAction?: TargetAction;
  /** Disables the post-answer Next Scenario control while a puzzle loads. */
  nextDisabled?: boolean;
  /** Loads the next scenario; shown at the bottom once the hand is answered. */
  onNextScenario: () => void;
  /** Scroll to the full book-vs-Mortal comparison. */
  onShowVerdict: () => void;
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
  grade,
  answer,
  callRiichi,
  callKan,
  aiEvaluation,
  availableActions,
  canDiscard = true,
  canRiichi = false,
  revealMortal = false,
  targetAction,
  nextDisabled = false,
  onNextScenario,
  onShowVerdict,
  onToggleRiichi,
  onToggleKan,
  onSelectTile,
}: HandDockProps) {
  const tiles = player.draw ? [...player.hand, player.draw] : player.hand;
  const isAnswered = grade !== null;
  const isAiScenario = availableActions !== undefined;
  const kanTile = isAiScenario ? null : findKanCandidateTile(player);

  const bookTile = grade?.book?.expected_tile ?? null;
  // The drill has no book column, so its selected-tile mark comes from Mortal.
  const selectedTileCorrect = grade?.book
    ? grade.book.is_tile_correct
    : (grade?.mortal?.matches_tile ?? false);
  const mortalTile = mortalRecommendedTile(grade?.mortal ?? null);

  let handHint = 'Dama selected - tap a tile to discard';
  if (isAnswered) {
    handHint = 'Answer submitted';
  } else if (!canDiscard) {
    // An AI reaction or a book call lesson: the answer is a button, not a tile.
    handHint = 'Choose a call or Pass';
  } else if (callKan) {
    handHint = `Kan armed - tap ${formatTileForDisplay(
      kanTile ?? '',
    )} to declare Shouminkan`;
  } else if (callRiichi) {
    handHint = 'Riichi selected - tap a tile to discard';
  } else if (isAiScenario) {
    handHint = 'Tap a tile to discard';
  } else if (targetAction === 'NaniKiru') {
    handHint = 'Tap the tile to discard';
  } else if (targetAction === 'Defend') {
    handHint = 'Fold - tap the safest tile';
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

  // Mortal's per-tile probabilities are a spoiler until the answer exists (or
  // the player deliberately peeked), so they are gated on `revealMortal`.
  const aiProbabilities =
    isAnswered || !revealMortal
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

  // The Call Kan toggle is a decision in its own right: surface Mortal's
  // probability for the kan rather than only the discard badges on the tiles.
  const kanProbability =
    !isAiScenario && kanTile && revealMortal
      ? aiEvaluation?.evaluations.find((action) => action.action === 'Kan')
          ?.probability
      : undefined;

  return (
    <section className="hand-dock" aria-label="Your hand">
      {isAnswered && grade ? (
        <AnswerSummary grade={grade} onDetails={onShowVerdict} />
      ) : (
        !isAiScenario &&
        (canRiichi || kanTile) && (
          <div className="call-toggles">
            {canRiichi && (
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
            )}

            {kanTile && (
              <button
                type="button"
                className={`kan-toggle${callKan ? ' kan-toggle--active' : ''}`}
                onClick={onToggleKan}
                disabled={isAnswered}
                aria-pressed={callKan}
                aria-label={`Call Kan toggle for ${formatTileForDisplay(
                  kanTile,
                )}, currently ${callKan ? 'on' : 'off'}`}
              >
                <KanIcon className="kan-toggle-icon" />
                <span className="kan-toggle-label">Call Kan</span>
                <span className="kan-toggle-tile">
                  {formatTileForDisplay(kanTile)}
                </span>
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
        )
      )}

      <div className="hand-dock-label" aria-live="polite">
        {handHint}
      </div>

      <div
        className="hand"
        style={{ gridTemplateColumns: `repeat(${tiles.length}, minmax(0, 1fr))` }}
      >
        {tiles.map((tile, index) => {
          const isSelected = answer?.tile === tile;

          let stateClass = '';
          if (grade) {
            if (isSelected && selectedTileCorrect) {
              stateClass = ' hand-tile-button--correct';
            } else if (isSelected) {
              stateClass = ' hand-tile-button--incorrect';
            } else if (bookTile === tile) {
              stateClass = ' hand-tile-button--answer';
            }
          }

          let aiClass = '';
          if (grade && mortalTile === tile) {
            aiClass = ' hand-tile-button--mortal';
          } else {
            const aiProbability = aiProbabilities.get(tile);
            if (aiProbability !== undefined && aiProbability >= 0.01) {
              aiClass = ' hand-tile-button--ai';
              if (tile === topAiTile) {
                aiClass += ' hand-tile-button--ai-top';
              }
            }
          }

          return (
            <button
              key={`${tile}-${index}`}
              type="button"
              className={`hand-tile-button${stateClass}${aiClass}`}
              onClick={() => onSelectTile(tile, index)}
              disabled={isAnswered || !canDiscard}
              aria-label={`${
                callKan
                  ? `Declare Kan on ${formatTileForDisplay(
                      tile,
                      redFiveFlags[index],
                    )}`
                  : `Discard ${formatTileForDisplay(
                      tile,
                      redFiveFlags[index],
                    )}`
              }${callRiichi ? ', with Riichi' : ''}`}
            >
              {aiProbabilities.get(tile) !== undefined &&
                (aiProbabilities.get(tile) ?? 0) >= 0.01 && (
                  <span className="ai-tile-badge" aria-hidden="true">
                    {formatProbability(aiProbabilities.get(tile) ?? 0)}
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

      {isAnswered && (
        <NextScenarioButton
          variant="dock"
          onClick={onNextScenario}
          disabled={nextDisabled}
        />
      )}
    </section>
  );
}
