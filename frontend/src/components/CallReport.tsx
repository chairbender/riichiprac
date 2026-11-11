import type { CallDecision } from '../callDecision';
import { formatProbability } from '../types/ai';

/**
 * Mortal's read on the call itself, shown separately from the top action.
 *
 * For an Added-Kan hand the top pick is often just the safest discard, which
 * says nothing about whether Mortal would call the Kan. This block always
 * compares the offered call with declining it, so the call probability cannot
 * be buried below the discard rows.
 */
export function CallReport({ decision }: { decision: CallDecision }) {
  return (
    <div className="call-report">
      <span className="call-report-title">Mortal on the call</span>
      <ul className="call-report-list">
        {decision.options.map((option) => (
          <li
            key={option.action}
            className={`call-report-option${
              option.declines ? ' call-report-option--decline' : ''
            }`}
          >
            <span className="call-report-label">{option.label}</span>
            <span className="call-report-bar" aria-hidden="true">
              <span
                style={{
                  width: `${Math.max(option.probability * 100, 1)}%`,
                }}
              />
            </span>
            <span className="call-report-probability">
              {formatProbability(option.probability)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
