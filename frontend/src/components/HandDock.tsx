import { findKanCandidateTile } from '../actions';
import { formatTileForDisplay, sortHandForDisplay } from '../display';
import { handHint } from '../handHint';
import { handTileLabel } from '../handTileLabel';
import type { SubmittedAnswer } from '../store/useGameStore';
import type { AiActionInfo, AiEvaluation } from '../types/ai';
import {
  discardProbabilitiesByTile,
  formatProbability,
} from '../types/ai';
import type { PlayerState, TargetAction } from '../types/game';
import type { DualGrade } from '../types/verdict';
import { bookAcceptedTiles, mortalRecommendedTile } from '../types/verdict';
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
  /**
   * The state's target action. Only used to decide whether this lesson owns the
   * Call Kan toggle: the push/fold lesson derives its target from the correct
   * answer, so pre-answer copy must never branch on it.
   */
  targetAction?: TargetAction;
  /** Disables the post-answer Next Scenario control while a puzzle loads. */
  nextDisabled?: boolean;
  /** Loads the next scenario; shown at the bottom once the hand is answered. */
  onNextScenario: () => void;
  /** Scroll to the full book-vs-Mortal comparison. */
  onShowVerdict: () => void;
  onToggleRiichi: () => void;
  onToggleKan: () => void;
  onSelectTile: (tile: string, index?: number, isDraw?: boolean) => void;
}

/**
 * The human player's active hand, pinned to the bottom of the viewport.
 * The "Call Riichi" and "Call Kan" toggles arm a declaration; clicking a tile
 * then submits the armed action together with the clicked tile. The Kan button
 * only appears on a Kan lesson that holds a callable quad: the fourth tile of
 * an open Pon, or four concealed copies.
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
  // Presentation-only order: the engine's hand order is untouched, and the
  // draw/red-five flags travel with their copies so tsumogiri survives sorting.
  const tiles = sortHandForDisplay(player.hand, player.draw, player.red_fives);
  const isAnswered = grade !== null;
  const isAiScenario = availableActions !== undefined;
  // Only a Kan lesson offers the call: any hand can hold four copies, but only
  // these puzzles ask about them.
  const kanTile =
    isAiScenario || targetAction !== 'Kan'
      ? null
      : findKanCandidateTile(player);

  const bookTiles = bookAcceptedTiles(grade?.book ?? null);
  // The drill has no book column, so its selected-tile mark comes from Mortal.
  const selectedTileCorrect = grade?.book
    ? grade.book.is_tile_correct
    : (grade?.mortal?.matches_tile ?? false);
  const mortalTile = mortalRecommendedTile(grade?.mortal ?? null);

  // Never derive this from `targetAction`: the push/fold lesson sets it from
  // the correct answer, so naming the action here would give the answer away.
  const hint = handHint({
    isAnswered,
    canDiscard,
    callKan,
    callRiichi,
    kanTileLabel: kanTile && formatTileForDisplay(kanTile),
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
        {hint}
      </div>

      <div
        className="hand"
        style={{ gridTemplateColumns: `repeat(${tiles.length}, minmax(0, 1fr))` }}
      >
        {tiles.map((display, index) => {
          const { code, isDraw, isRed, sourceIndex } = display;
          const isSelected = answer?.tile === code;

          let stateClass = '';
          if (grade) {
            if (isSelected && selectedTileCorrect) {
              stateClass = ' hand-tile-button--correct';
            } else if (isSelected) {
              stateClass = ' hand-tile-button--incorrect';
            } else if (bookTiles.includes(code)) {
              stateClass = ' hand-tile-button--answer';
            }
          }

          let aiClass = '';
          if (grade && mortalTile === code) {
            aiClass = ' hand-tile-button--mortal';
          } else {
            const aiProbability = aiProbabilities.get(code);
            if (aiProbability !== undefined && aiProbability >= 0.01) {
              aiClass = ' hand-tile-button--ai';
              if (code === topAiTile) {
                aiClass += ' hand-tile-button--ai-top';
              }
            }
          }

          return (
            <button
              key={`${code}-${sourceIndex}`}
              type="button"
              className={`hand-tile-button${stateClass}${aiClass}`}
              onClick={() => onSelectTile(code, index, isDraw)}
              disabled={isAnswered || !canDiscard}
              aria-label={handTileLabel({
                code,
                isRed,
                callKan,
                callRiichi,
              })}
            >
              {aiProbabilities.get(code) !== undefined &&
                (aiProbabilities.get(code) ?? 0) >= 0.01 && (
                  <span className="ai-tile-badge" aria-hidden="true">
                    {formatProbability(aiProbabilities.get(code) ?? 0)}
                  </span>
                )}
              <Tile
                code={code}
                className="tile hand-tile"
                isRedFive={isRed}
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
