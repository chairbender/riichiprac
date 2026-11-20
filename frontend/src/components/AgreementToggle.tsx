import type { ChangeEvent } from 'react';
import type { AiStatus } from '../types/ai';

export interface AgreementToggleProps {
  /** The filter's own state; it starts on (`DEFAULT_REQUIRE_AGREEMENT`). */
  requireAgreement: boolean;
  /** The filter can only run once Mortal has loaded. */
  aiStatus: AiStatus;
  /** Tooltip explaining whether the filter can run, and what it costs. */
  hint: string;
  /** An inline hint's id, when the host also shows it in the open (3D sheet). */
  describedBy?: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}

/**
 * The "Mortal must agree" checkbox, shared by the 2D header (`AppControls`) and
 * the 3D setup sheet (3D-H4).
 *
 * Both shells render this one component with the same store state, so the two
 * copies of the setting cannot drift in label, checked state or disabled state:
 * the filter is disabled unless Mortal is `ready`, exactly as in the header.
 */
export function AgreementToggle({
  requireAgreement,
  aiStatus,
  hint,
  describedBy,
  onChange,
}: AgreementToggleProps) {
  return (
    <label className="app-toggle" title={hint}>
      <input
        type="checkbox"
        checked={requireAgreement}
        disabled={aiStatus !== 'ready'}
        aria-describedby={describedBy}
        onChange={onChange}
      />
      <span>Mortal must agree</span>
    </label>
  );
}
