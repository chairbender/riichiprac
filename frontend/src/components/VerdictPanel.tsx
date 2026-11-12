import { callDecisionFor } from '../callDecision';
import { formatTileForDisplay } from '../display';
import type { AiEvaluation, AiStatus } from '../types/ai';
import { actionLabel, formatProbability } from '../types/ai';
import type { GameState } from '../types/game';
import type { BookGrade, DualGrade, MortalGrade } from '../types/verdict';
import { citationLabel } from '../types/game';
import {
  acceptedAlternativeNote,
  formatAcceptedTiles,
  mortalRecommendationLabel,
  mortalRecommendedRiichi,
  mortalRecommendedTile,
  outcomeChip,
  outcomeTone,
} from '../types/verdict';
import { ActionRanking } from './ActionRanking';
import { CallReport } from './CallReport';
import { RiichiStick } from './RiichiStick';
import { ScenarioExplanation } from './ScenarioExplanation';
import { Tile } from './Tile';

interface VerdictPanelProps {
  state: GameState;
  /** Null before the answer is submitted. */
  grade: DualGrade | null;
  evaluation: AiEvaluation | null;
  aiStatus: AiStatus;
  aiError: string | null;
  isEvaluating: boolean;
  peeked: boolean;
  redFives: string[];
  onPeek: () => void;
  onRetry: () => void;
}

/**
 * The dual verdict block: the book's recommendation and Mortal's, side by side,
 * each with its own provenance.
 *
 * Pre-answer it collapses to one status line so the recommendation does not
 * leak the answer. "Peek" is the deliberate exception: it reveals Mortal's line
 * without submitting anything, and the export records that it happened.
 */
export function VerdictPanel({
  state,
  grade,
  evaluation,
  aiStatus,
  aiError,
  isEvaluating,
  peeked,
  redFives,
  onPeek,
  onRetry,
}: VerdictPanelProps) {
  const isDrill = state.correct_action.type === 'best';
  const rationale = state.book_rationale ?? null;

  if (!grade) {
    const preAnswer = preAnswerState({
      isDrill,
      evaluation,
      aiStatus,
      aiError,
      isEvaluating,
      peeked,
    });

    return (
      <section
        className="verdict-panel"
        id="verdict-panel"
        tabIndex={-1}
        aria-label={isDrill ? 'Mortal drill verdict' : 'Book and Mortal comparison'}
      >
        <div className={`verdict-preanswer verdict-preanswer--${preAnswer.tone}`}>
          <span className="verdict-preanswer-text">{preAnswer.text}</span>
          {preAnswer.canPeek && (
            <button className="verdict-peek" type="button" onClick={onPeek}>
              Peek
            </button>
          )}
          {preAnswer.canRetry && (
            <button className="verdict-peek" type="button" onClick={onRetry}>
              Retry
            </button>
          )}
        </div>

        {peeked && !isDrill && evaluation && (
          <div className="verdict-peek-card">
            <ColumnHeader label="Mortal" source={evaluation.model} />
            <PeekedMortal evaluation={evaluation} redFives={redFives} state={state} />
          </div>
        )}
      </section>
    );
  }

  const tone = outcomeTone(grade.outcome);
  const mortal = grade.mortal;
  const book = grade.book;

  return (
    <section
      className={`verdict-panel verdict-panel--${tone}`}
      id="verdict-panel"
      tabIndex={-1}
      aria-label={isDrill ? 'Mortal drill verdict' : 'Book and Mortal comparison'}
    >
      <div className="verdict-columns">
        <div className="verdict-column verdict-column--book">
          <ColumnHeader
            label="Book"
            source={rationale ? citationLabel(rationale.source) : 'no book rule'}
          />

          {book ? (
            <>
              <p className="verdict-recommendation">
                {describeBookAnswer(state, book)}
                {book.expected_tile && (
                  <Tile
                    code={book.expected_tile}
                    className="tile verdict-tile"
                    isRedFive={redFives.includes(book.expected_tile)}
                  />
                )}
              </p>
              <div className="verdict-marks">
                <Mark label="action" ok={book.is_action_correct} />
                <Mark
                  label={
                    state.correct_action.type === 'pass'
                      ? 'call'
                      : state.correct_action.type === 'kan' ||
                          state.correct_action.type === 'discard'
                        ? 'tile'
                        : 'discard'
                  }
                  ok={book.is_tile_correct}
                />
              </div>
            </>
          ) : (
            <p className="verdict-absent-column">
              No book rule: this is a Mortal drill.
            </p>
          )}

          {rationale && <ScenarioExplanation rationale={rationale} />}
        </div>

        <div className="verdict-column verdict-column--mortal">
          <ColumnHeader
            label="Mortal"
            source={mortal?.model ?? evaluation?.model ?? 'not loaded'}
          />

          {mortal ? (
            <MortalBody
              mortal={mortal}
              redFives={redFives}
              evaluation={evaluation}
              state={state}
            />
          ) : (
            <MortalUnavailable aiStatus={aiStatus} aiError={aiError} onRetry={onRetry} />
          )}
        </div>
      </div>

      <div className={`verdict-band verdict-band--${tone}`}>
        <span className="verdict-band-chip">{outcomeChip(grade.outcome)}</span>
        <span className="verdict-band-text">
          {outcomeSentence(grade, state)}
        </span>
      </div>
    </section>
  );
}

function ColumnHeader({ label, source }: { label: string; source: string }) {
  return (
    <div className="verdict-column-header">
      <span className="verdict-column-label">{label}</span>
      <span className="verdict-column-source">{source}</span>
    </div>
  );
}

function Mark({ label, ok }: { label: string; ok: boolean }) {
  return (
    <span className={`verdict-mark ${ok ? 'verdict-mark--ok' : 'verdict-mark--no'}`}>
      <span aria-hidden="true">{ok ? '✓' : '✗'}</span>
      <span className="verdict-mark-label">{label}</span>
    </span>
  );
}

function MortalBody({
  mortal,
  redFives,
  evaluation,
  state,
}: {
  mortal: MortalGrade;
  redFives: string[];
  evaluation: AiEvaluation | null;
  state: GameState;
}) {
  const tile = mortalRecommendedTile(mortal);
  const riichi = mortalRecommendedRiichi(mortal);
  const call = callDecisionFor(evaluation, state);

  return (
    <>
      <p className="verdict-recommendation">
        {riichi && <RiichiStick className="riichi-toggle-stick" />}
        {mortal.recommended_label}
        {tile && (
          <Tile
            code={tile}
            className="tile verdict-tile"
            isRedFive={redFives.includes(tile)}
          />
        )}
      </p>
      <div className="verdict-marks">
        <Mark label="pick" ok={mortal.agrees} />
        {mortal.top_probability > 0 && (
          <span className="verdict-probability">
            {formatProbability(mortal.top_probability)} · {mortal.confidence}
          </span>
        )}
      </div>

      {call && <CallReport decision={call} />}

      {!mortal.agrees && mortal.answer_probability > 0 && (
        <p className="verdict-answer-probability">
          Your answer: {formatProbability(mortal.answer_probability)}
          {mortal.close_second ? ' · nearly tied with Mortal’s pick' : ''}
        </p>
      )}

      {evaluation && (
        <details className="verdict-ranking">
          <summary>Full ranking</summary>
          <ActionRanking
            evaluations={evaluation.evaluations}
            recommendedAction={evaluation.recommended_action}
            limit={6}
            showOverflow
            pinnedActions={call?.focusActions}
          />
        </details>
      )}
    </>
  );
}

function MortalUnavailable({
  aiStatus,
  aiError,
  onRetry,
}: {
  aiStatus: AiStatus;
  aiError: string | null;
  onRetry: () => void;
}) {
  return (
    <div className="verdict-unavailable">
      <p className="verdict-absent-column">
        {aiStatus === 'error'
          ? 'Mortal unavailable'
          : aiStatus === 'ready'
            ? 'No evaluation for this hand'
            : 'Mortal is still loading'}
      </p>
      {aiError && <p className="verdict-error">{aiError}</p>}
      <button className="verdict-peek" type="button" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

function PeekedMortal({
  evaluation,
  redFives,
  state,
}: {
  evaluation: AiEvaluation;
  redFives: string[];
  state: GameState;
}) {
  const top = evaluation.evaluations[0];
  // A Riichi recommendation is tile-less in Mortal's action space; the
  // evaluator's second pass supplies the discard it would declare on.
  const tile =
    top?.type === 'riichi'
      ? evaluation.riichi_discard ?? null
      : top?.tile ?? null;
  const call = callDecisionFor(evaluation, state);
  return (
    <>
      <p className="verdict-recommendation">
        {top?.type === 'riichi' && <RiichiStick className="riichi-toggle-stick" />}
        {top ? actionLabel(top) : evaluation.recommended_action}
        {tile && (
          <Tile
            code={tile}
            className="tile verdict-tile"
            isRedFive={redFives.includes(tile)}
          />
        )}
      </p>
      <p className="verdict-probability">
        {top ? formatProbability(top.probability) : ''} · peeked before answering
      </p>
      {call && <CallReport decision={call} />}
      <details className="verdict-ranking">
        <summary>Full ranking</summary>
        <ActionRanking
          evaluations={evaluation.evaluations}
          recommendedAction={evaluation.recommended_action}
          limit={6}
          showOverflow
          pinnedActions={call?.focusActions}
        />
      </details>
    </>
  );
}

/**
 * The book's answer as one line of text, naming every accepted tile.
 *
 * A shape lesson accepts two interchangeable discards ("discard 5p or 3p"), so
 * the response never hides the half the player did not pick; a one-tile answer
 * reads exactly as before.
 */
function describeBookAnswer(state: GameState, book: BookGrade | null): string {
  const accepted = formatAcceptedTiles(book);
  switch (state.correct_action.type) {
    case 'riichi':
      return `Riichi · discard ${accepted}`;
    case 'dama':
      // The ryanmen lesson asks which tile to discard; calling it "Dama" would
      // mislabel a tile-efficiency drill as a Riichi-vs-dama decision. The
      // push/fold lesson uses the dama carrier for a hand that is not ready at
      // all, so it names the decision instead.
      if (state.target_action === 'NaniKiru') {
        return `Discard ${accepted}`;
      }
      if (state.target_action === 'Push') {
        return `Push · discard ${accepted}`;
      }
      return `Dama · discard ${accepted}`;
    case 'fold':
      return `Fold · discard ${accepted}`;
    case 'kan':
      // Covers both Kan lessons: an Added Kan on a Pon and a concealed quad.
      return `Kan on ${accepted}`;
    case 'discard':
      return `No Kan · discard ${accepted}`;
    case 'pass': {
      const offer = state.call_offer;
      // The open-quad lesson declines a Kan, not a Pon/Chi: name what is kept.
      if (offer?.action === 'Kan') {
        return `Pass · keep the three ${formatTileForDisplay(offer.tile)}`;
      }
      return `Pass on ${offer?.label ?? 'the call'}`;
    }
    case 'best':
      return state.correct_action.label;
  }
}

function preAnswerState({
  isDrill,
  evaluation,
  aiStatus,
  aiError,
  isEvaluating,
  peeked,
}: {
  isDrill: boolean;
  evaluation: AiEvaluation | null;
  aiStatus: AiStatus;
  aiError: string | null;
  isEvaluating: boolean;
  peeked: boolean;
}): {
  text: string;
  tone: 'loading' | 'ready' | 'error';
  canPeek: boolean;
  canRetry: boolean;
} {
  if (aiStatus === 'error') {
    return {
      text: aiError
        ? isDrill
          ? `Mortal unavailable — this drill cannot be graded without it. (${aiError})`
          : `Mortal unavailable — this hand is graded against the book only. (${aiError})`
        : isDrill
          ? 'Mortal unavailable — this drill cannot be graded without it.'
          : 'Mortal unavailable — this hand is graded against the book only.',
      tone: 'error',
      canPeek: false,
      canRetry: true,
    };
  }
  if (isEvaluating) {
    return {
      text: 'Mortal is thinking about this hand…',
      tone: 'loading',
      canPeek: false,
      canRetry: false,
    };
  }
  if (aiStatus === 'idle' || aiStatus === 'loading') {
    return {
      text: 'Mortal: loading the model once (~43 MB)…',
      tone: 'loading',
      canPeek: false,
      canRetry: false,
    };
  }
  if (isDrill) {
    return {
      text: evaluation
        ? 'This drill is graded by Mortal alone. Answer when ready.'
        : 'Waiting for a Mortal evaluation for this drill…',
      tone: 'ready',
      canPeek: false,
      canRetry: false,
    };
  }
  if (!evaluation) {
    return {
      text: 'Mortal is ready; waiting for this hand’s evaluation…',
      tone: 'loading',
      canPeek: false,
      canRetry: false,
    };
  }
  return peeked
    ? {
        text: 'Mortal’s line is revealed. Answer when ready.',
        tone: 'ready',
        canPeek: false,
        canRetry: false,
      }
    : {
        text: 'Mortal has an opinion about this hand. Answer first, or peek.',
        tone: 'ready',
        canPeek: true,
        canRetry: false,
      };
}

function outcomeSentence(grade: DualGrade, state: GameState): string {
  const bookPick = describeBookAnswer(state, grade.book);
  const mortalPick = mortalRecommendationLabel(grade.mortal);

  switch (grade.outcome) {
    case 'both_agree':
      return 'The book and Mortal agree.';
    case 'book_agrees_mortal_does_not':
      return (
        acceptedAlternativeNote(grade.book, grade.mortal) ??
        `The book picks this. Mortal would play ${mortalPick}.`
      );
    case 'mortal_agrees_book_does_not':
      return `Mortal picks it. The book says ${bookPick}.`;
    case 'neither_agrees':
      return grade.mortal?.confidence === 'low'
        ? 'Neither the book nor Mortal picks this — though Mortal is nearly split here.'
        : 'Neither the book nor Mortal picks this.';
    case 'only_available_agrees':
      return grade.mode === 'mortal_only'
        ? 'Mortal drill: graded by the model alone.'
        : 'Mortal is not loaded, so this was graded against the book only.';
    case 'only_available_disagrees':
      return grade.mode === 'mortal_only'
        ? 'Mortal drill: graded by the model alone.'
        : 'Not the book’s line. Mortal is not loaded, so this is not graded as wrong.';
    case 'ungraded':
      return 'Mortal is not loaded, so this hand cannot be graded yet.';
  }
}

