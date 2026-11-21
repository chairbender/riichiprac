import {
  isPickedCopy,
  isSelectableCopy,
} from '../callChoices';
import type {
  CallButtons,
  CallCopy,
  CallKind,
  PendingCall,
} from '../callChoices';
import { sortHandForDisplay } from '../display';
import { handHint } from '../handHint';
import { handTileLabel } from '../handTileLabel';
import type { SubmittedAnswer } from '../store/useGameStore';
import type { AiEvaluation } from '../types/ai';
import { discardProbabilitiesByTile, formatProbability } from '../types/ai';
import type { PlayerState } from '../types/game';
import type { DualGrade } from '../types/verdict';
import { bookAcceptedTiles, mortalRecommendedTile } from '../types/verdict';
import { AnswerSummary } from './AnswerSummary';
import { CallControls } from './CallControls';
import { NextScenarioButton } from './NextScenarioButton';
import { Tile } from './Tile';

interface HandDockProps {
  player: PlayerState;
  /** Dual verdict for the current answer, or null before answering. */
  grade: DualGrade | null;
  /** The answer the player submitted, if any. */
  answer: SubmittedAnswer | null;
  /** The call controls this state offers (Chi/Pon/Kan/Riichi/Pass). */
  callButtons: CallButtons;
  /** The open tile-pick step for a call, or null. */
  pendingCall: PendingCall | null;
  /** Why the last pick was rejected. */
  callError: string | null;
  /** The hand tiles a hovered/focused call button would use. */
  previewTiles?: readonly CallCopy[] | null;
  /** Latest Mortal evaluation for the table, if one exists. */
  aiEvaluation: AiEvaluation | null;
  /** False when a reaction state has no discard option. */
  canDiscard?: boolean;
  /** Whether Mortal's probability badges may be shown. */
  revealMortal?: boolean;
  /** Disables the post-answer Next Scenario control while a puzzle loads. */
  nextDisabled?: boolean;
  /** Loads the next scenario; shown at the bottom once the hand is answered. */
  onNextScenario: () => void;
  /** Scroll to the full book-vs-Mortal comparison. */
  onShowVerdict: () => void;
  /** Press a call button; a single-option call submits immediately. */
  onBeginCall: (kind: CallKind) => void;
  /** Pass on the offered call. */
  onPass: () => void;
  /** Close an open call pick. */
  onCancelCall: () => void;
  /** Raise the tiles a call button would use while it is hovered/focused. */
  onPreviewCall?: (kind: CallKind | null) => void;
  onSelectTile: (tile: string, index?: number, isDraw?: boolean) => void;
}

/**
 * The human player's active hand, pinned to the bottom of the viewport.
 *
 * The call bar sits above the hand's right side. Pressing a call either submits
 * it (one legal way to make it) or opens a pick step: Chi collects two hand
 * tiles, Pon/Kan one, Riichi the discard. The same click handler feeds the 3D
 * overlay, so a picked tile behaves identically in every view.
 */
export function HandDock({
  player,
  grade,
  answer,
  callButtons,
  pendingCall,
  callError,
  previewTiles,
  aiEvaluation,
  canDiscard = true,
  revealMortal = false,
  nextDisabled = false,
  onNextScenario,
  onShowVerdict,
  onBeginCall,
  onPass,
  onCancelCall,
  onPreviewCall,
  onSelectTile,
}: HandDockProps) {
  // Presentation-only order: the engine's hand order is untouched, and the
  // draw/red-five flags travel with their copies so tsumogiri survives sorting.
  const tiles = sortHandForDisplay(player.hand, player.draw, player.red_fives);
  const isAnswered = grade !== null;

  const bookTiles = bookAcceptedTiles(grade?.book ?? null);
  // The drill has no book column, so its selected-tile mark comes from Mortal.
  const selectedTileCorrect = grade?.book
    ? grade.book.is_tile_correct
    : (grade?.mortal?.matches_tile ?? false);
  const mortalTile = mortalRecommendedTile(grade?.mortal ?? null);

  // The 3D HUD's hand rail calls the same `handHint`, so the two views cannot
  // word the same state differently.
  const hint = handHint({
    isAnswered,
    canDiscard,
    pendingCall,
    hasKanCall: callButtons.calls.some((call) => call.kind === 'kan'),
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

  return (
    <section className="hand-dock" aria-label="Your hand">
      {isAnswered && grade ? (
        <AnswerSummary grade={grade} onDetails={onShowVerdict} />
      ) : (
        <CallControls
          buttons={callButtons}
          pending={pendingCall}
          error={callError}
          disabled={isAnswered}
          evaluation={aiEvaluation}
          revealMortal={revealMortal}
          onBegin={onBeginCall}
          onPass={onPass}
          onCancel={onCancelCall}
          onPreview={onPreviewCall}
        />
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
          const copy = { code, isRed };
          const picked = pendingCall ? isPickedCopy(pendingCall, copy) : false;
          const previewed =
            previewTiles?.some(
              (tile) => tile.code === code && tile.isRed === isRed,
            ) ?? false;
          const selectable = !pendingCall || isSelectableCopy(pendingCall, copy);
          const dimmed = pendingCall !== null && !selectable && !picked;
          const pickClass = pendingCall && selectable ? ' hand-tile-button--pick' : '';
          const liftClass =
            previewed || picked ? ' hand-tile-button--lifted' : '';
          const dimClass = dimmed ? ' hand-tile-button--dimmed' : '';

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
              className={`hand-tile-button${stateClass}${aiClass}${pickClass}${liftClass}${dimClass}`}
              onClick={() => {
                // A darkened tile is not part of the call: it stays focusable
                // so a keyboard pick keeps its place, but never submits.
                if (dimmed) return;
                onSelectTile(code, index, isDraw);
              }}
              disabled={isAnswered || (!pendingCall && !canDiscard)}
              aria-disabled={dimmed || undefined}
              aria-label={handTileLabel({
                code,
                isRed,
                pick: pendingCall?.kind ?? null,
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
