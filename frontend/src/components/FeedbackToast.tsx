import type { AnswerFeedback } from '../store/useGameStore';
import type { CorrectActionType } from '../types/game';
import { Tile } from './Tile';

interface FeedbackToastProps {
  feedback: AnswerFeedback;
  /** Red-five tile codes held by the human, used to render answer tiles. */
  redFives: string[];
}

const ACTION_LABELS: Record<CorrectActionType, string> = {
  riichi: 'Riichi',
  dama: 'Dama',
  kan: 'Kan',
  discard: 'No Kan',
  best: 'AI best action',
};

/**
 * Overlay shown after the player submits. Both parts of the answer are graded
 * independently so the player can see whether the action type, the clicked
 * tile, or both were wrong.
 */
export function FeedbackToast({ feedback, redFives }: FeedbackToastProps) {
  const gradeClass = (isCorrect: boolean) =>
    isCorrect
      ? 'feedback-grade feedback-grade--correct'
      : 'feedback-grade feedback-grade--incorrect';
  const isRedFive = (tile: string) => redFives.includes(tile);

  if (feedback.isMortalDecision) {
    return (
      <div
        className={`feedback-toast ${
          feedback.isCorrect
            ? 'feedback-toast--correct'
            : 'feedback-toast--incorrect'
        }`}
        role="status"
        aria-live="assertive"
      >
        <span className="feedback-message">
          {feedback.isCorrect ? 'Correct!' : 'Incorrect'}
        </span>
        <div className="feedback-grades">
          <div
            className={
              feedback.isCorrect
                ? 'feedback-grade feedback-grade--correct'
                : 'feedback-grade feedback-grade--incorrect'
            }
          >
            <span className="feedback-grade-label">You chose</span>
            <span className="feedback-grade-value">
              {feedback.selectedLabel}
            </span>
          </div>
          <div className="feedback-grade feedback-grade--correct">
            <span className="feedback-grade-label">Model answer</span>
            <span className="feedback-grade-value">
              {feedback.correctLabel}
            </span>
          </div>
        </div>
      </div>
    );
  }

  const isKanFeedback =
    feedback.selectedType === 'kan' ||
    feedback.correctType === 'kan' ||
    feedback.correctType === 'discard';

  let detail: string | null = null;
  if (feedback.correctType === 'kan') {
    detail = feedback.isCorrect
      ? `You declared Added Kan on ${feedback.correctTile}.`
      : `You should declare Kan on ${feedback.correctTile}.`;
  } else if (feedback.correctType === 'discard') {
    detail = feedback.isCorrect
      ? `You passed on the Kan and discarded ${feedback.correctTile}.`
      : `You should pass on the Kan and discard ${feedback.correctTile}.`;
  }

  return (
    <div
      className={`feedback-toast ${
        feedback.isCorrect
          ? 'feedback-toast--correct'
          : 'feedback-toast--incorrect'
      }`}
      role="status"
      aria-live="assertive"
    >
      <span className="feedback-message">
        {feedback.isCorrect ? 'Correct!' : 'Incorrect'}
      </span>
      {detail && <span className="feedback-detail">{detail}</span>}

      <div className="feedback-grades">
        <div className={gradeClass(feedback.isActionCorrect)}>
          <span className="feedback-grade-label">Action</span>
          <span className="feedback-grade-value">
            {ACTION_LABELS[feedback.selectedType]}
          </span>
          <span
            className="feedback-grade-mark"
            role="img"
            aria-label={feedback.isActionCorrect ? 'correct' : 'incorrect'}
          >
            {feedback.isActionCorrect ? '\u2713' : '\u2717'}
          </span>
          {!feedback.isActionCorrect && (
            <span className="feedback-grade-correct">
              should be {ACTION_LABELS[feedback.correctType]}
            </span>
          )}
        </div>

        <div className={gradeClass(feedback.isTileCorrect)}>
          <span className="feedback-grade-label">
            {isKanFeedback ? 'Tile' : 'Discard'}
          </span>
          <span className="feedback-grade-value feedback-grade-tile">
            <Tile
              code={feedback.selectedTile}
              className="tile feedback-tile"
              isRedFive={isRedFive(feedback.selectedTile)}
            />
            <span className="feedback-code">{feedback.selectedTile}</span>
          </span>
          <span
            className="feedback-grade-mark"
            role="img"
            aria-label={feedback.isTileCorrect ? 'correct' : 'incorrect'}
          >
            {feedback.isTileCorrect ? '\u2713' : '\u2717'}
          </span>
          {!feedback.isTileCorrect && (
            <span className="feedback-grade-correct">
              should be
              <Tile
                code={feedback.correctTile}
                className="tile feedback-tile"
                isRedFive={isRedFive(feedback.correctTile)}
              />
              <span className="feedback-code">{feedback.correctTile}</span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
