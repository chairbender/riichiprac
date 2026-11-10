import type { AnswerFeedback } from '../store/useGameStore';
import { Tile } from './Tile';

interface FeedbackToastProps {
  feedback: AnswerFeedback;
}

/** Overlay shown after the player picks a discard tile. */
export function FeedbackToast({ feedback }: FeedbackToastProps) {
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
      {feedback.isCorrect ? (
        <span className="feedback-message">Correct!</span>
      ) : (
        <>
          <span className="feedback-message">
            Incorrect - you should have discarded
          </span>
          <span className="feedback-answer">
            <Tile code={feedback.correctTile} className="tile feedback-tile" />
            <span className="feedback-code">{feedback.correctTile}</span>
          </span>
        </>
      )}
    </div>
  );
}
