import type { ReportMode } from '../store/useGameStore';
import { callDecisionFor } from '../callDecision';
import type { AiEvaluation, AiStatus } from '../types/ai';
import { formatProbability } from '../types/ai';
import { CallReport } from './CallReport';
import {
  describeCorrectAction,
  describeReportedAction,
  mortalActionDisplayName,
  mortalActionForCorrect,
  mortalActionForReported,
  probabilityForAction,
  reportReasonLabel,
  verdictLabel,
} from '../report';

interface ReportBannerProps {
  mode: ReportMode;
  /** Fresh Mortal evaluation run after the import. */
  evaluation: AiEvaluation | null;
  isEvaluating: boolean;
  aiStatus: AiStatus;
  aiError: string | null;
  onVerify: () => void;
  onRetry: () => void;
  onExit: () => void;
}

/**
 * Review panel for an imported report: the disputed decision, any warnings,
 * and a three-way comparison between the app, the reporter, and Mortal.
 */
export function ReportBanner({
  mode,
  evaluation,
  isEvaluating,
  aiStatus,
  aiError,
  onVerify,
  onRetry,
  onExit,
}: ReportBannerProps) {
  const { report, verdict, warnings } = mode;
  const expected = report.table.correct_action;
  const answer = report.decision.answer;
  const appAction = mortalActionForCorrect(expected);
  const reporterAction = mortalActionForReported(answer);
  const snapshot = report.ai?.evaluation ?? null;
  const call = callDecisionFor(evaluation);

  const agreesWithApp =
    evaluation?.recommended_action === appAction;
  const agreesWithReporter =
    evaluation?.recommended_action === reporterAction;

  let agreementText = '';
  if (evaluation) {
    if (agreesWithApp && agreesWithReporter) {
      agreementText = 'Mortal agrees with both answers.';
    } else if (agreesWithApp) {
      agreementText = 'Mortal agrees with the app.';
    } else if (agreesWithReporter) {
      agreementText = 'Mortal agrees with the reporter.';
    } else {
      agreementText = 'Mortal agrees with neither answer.';
    }
  }

  return (
    <section className="report-banner" aria-label="Imported report">
      <div className="report-banner-header">
        <div className="report-banner-text">
          <span className="report-banner-title">Imported report</span>
          <span className="report-banner-subtitle">
            {report.scenario.label} · {formatReportDate(report.created_at)} ·
            commit {report.app.commit || 'unknown'}
          </span>
          <span className="report-banner-prompt">
            {report.decision.prompt}
          </span>
        </div>
        <button
          className="report-button report-button--ghost"
          type="button"
          onClick={onExit}
        >
          Exit report
        </button>
      </div>

      <div className="report-comparison">
        <div className="report-comparison-row">
          <span className="report-label">App expected</span>
          <span className="report-value">{describeCorrectAction(expected)}</span>
        </div>
        <div className="report-comparison-row">
          <span className="report-label">You answered</span>
          <span className="report-value">
            {describeReportedAction(answer)}
          </span>
        </div>
        <div className="report-comparison-row">
          <span className="report-label">Verdict</span>
          <span
            className={`report-verdict ${
              verdict.is_correct
                ? 'report-verdict--correct'
                : 'report-verdict--incorrect'
            }`}
          >
            {verdictLabel(verdict)}
          </span>
        </div>
      </div>

      <p className="report-reason">
        Reported as: {reportReasonLabel(report.decision.reason)}
      </p>
      {report.decision.note && (
        <p className="report-note">“{report.decision.note}”</p>
      )}

      {warnings.length > 0 && (
        <ul className="report-warnings" role="alert">
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}

      <div className="report-ai">
        {evaluation ? (
          <>
            <p className="report-ai-line">
              Mortal now: <strong>{mortalActionDisplayName(evaluation.recommended_action)}</strong>{' '}
              <span className="report-ai-detail">
                (app {formatProbability(probabilityForAction(evaluation, appAction))}
                {' · '}
                you {formatProbability(probabilityForAction(evaluation, reporterAction))})
              </span>
            </p>
            <p className="report-ai-agreement">{agreementText}</p>
            {call && <CallReport decision={call} />}
          </>
        ) : snapshot ? (
          <p className="report-ai-line">
            AI at export: <strong>{mortalActionDisplayName(snapshot.recommended_action)}</strong>
            {isEvaluating && ' · checking again…'}
          </p>
        ) : (
          <p className="report-ai-line">
            {isEvaluating
              ? 'Checking with Mortal…'
              : aiStatus === 'ready'
                ? 'No AI check yet. Verify this position with Mortal.'
                : 'Mortal is not loaded yet.'}
          </p>
        )}
        {aiError && (
          <p className="report-ai-error" role="alert">
            {aiError}
          </p>
        )}
      </div>

      <div className="report-actions">
        <button
          className="report-button"
          type="button"
          onClick={onVerify}
          disabled={isEvaluating || aiStatus !== 'ready'}
        >
          {isEvaluating ? 'Checking…' : 'Verify with AI'}
        </button>
        <button
          className="report-button report-button--ghost"
          type="button"
          onClick={onRetry}
        >
          Try this puzzle
        </button>
      </div>
    </section>
  );
}

function formatReportDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
