import type { AnswerFeedback } from '../store/useGameStore';
import type { CorrectActionType } from '../types/game';
import { Tile } from './Tile';

interface FeedbackToastProps {
  feedback: AnswerFeedback;
}

const ACTION_LABELS: Record<CorrectActionType, string> = {
  riichi: 'Riichi',
  dama: 'Dama',
};

/**
 * Overlay shown after the player submits. Both parts of the answer are graded
 * independently so the player can see whether the action type, the discard
 * tile, or both were wrong.
 */
export function FeedbackToast({ feedback }: FeedbackToastProps) {
  const gradeClass = (isCorrect: boolean) =>
    isCorrect
      ? 'feedback-grade feedback-grade--correct'
      : 'feedback-grade feedback-grade--incorrect';

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
          <span className="feedback-grade-label">Discard</span>
          <span className="feedback-grade-value feedback-grade-tile">
            <Tile
              code={feedback.selectedTile}
              className="tile feedback-tile"
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
              />
              <span className="feedback-code">{feedback.correctTile}</span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
