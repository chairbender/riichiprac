/**
 * The shared call bar: plain call buttons, then an optional tile-pick step.
 *
 * Calls are not an "armed" toggle. A press either submits the call (exactly one
 * legal way to make it) or opens a pick step with a visible Cancel; the hand's
 * tiles then collect the call's tiles. There is no `aria-pressed`, no ON/OFF
 * word and no state the next unrelated tile click could carry.
 *
 * Both shells mount this one component — the stacked/top-down `HandDock` above
 * the hand and the 3D HUD's action rail — so the words, the order, the disabled
 * rules and the focus behaviour cannot drift between the views.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { AiEvaluation } from '../types/ai';
import { formatProbability } from '../types/ai';
import { callPickPrompt } from '../callChoices';
import type {
  CallButtons,
  CallButtonSpec,
  CallKind,
  PendingCall,
} from '../callChoices';

export interface CallControlsProps {
  /** Which calls this state offers, in render order. */
  readonly buttons: CallButtons;
  /** The open pick step, or null. */
  readonly pending: PendingCall | null;
  /** Why the last pick was rejected; announced as an alert. */
  readonly error?: string | null;
  /** The hand is answered: every control is inert. */
  readonly disabled?: boolean;
  /** Latest Mortal evaluation, for the per-call probability chips. */
  readonly evaluation?: AiEvaluation | null;
  /** Whether Mortal's probabilities may be shown. */
  readonly revealMortal?: boolean;
  readonly onBegin: (kind: CallKind) => void;
  readonly onPass: () => void;
  readonly onCancel: () => void;
}

/**
 * The call buttons and, while a pick is open, its prompt and Cancel.
 *
 * The buttons are right-aligned in their row (the shells place the row above
 * the right side of the hand), so adding a control grows the row towards the
 * left instead of moving the right edge.
 */
export function CallControls({
  buttons,
  pending,
  error = null,
  disabled = false,
  evaluation = null,
  revealMortal = false,
  onBegin,
  onPass,
  onCancel,
}: CallControlsProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const buttonRefs = useRef<Partial<Record<CallKind, HTMLButtonElement | null>>>({});
  const originRef = useRef<CallKind | null>(null);
  const restoreRef = useRef(false);

  /* Opening a pick moves focus to Cancel; leaving it returns it to the button. */
  useEffect(() => {
    if (pending) {
      cancelRef.current?.focus();
      return;
    }
    if (!restoreRef.current) return;
    restoreRef.current = false;
    const origin = originRef.current;
    if (origin) buttonRefs.current[origin]?.focus();
  }, [pending]);

  const cancel = useCallback(() => {
    restoreRef.current = true;
    onCancel();
  }, [onCancel]);

  /* Escape closes any open pick, wherever focus is in the hand. */
  useEffect(() => {
    if (!pending) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      cancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pending, cancel]);

  if (buttons.calls.length === 0 && !buttons.pass) return null;

  const probabilityFor = (spec: CallButtonSpec): number | undefined => {
    if (!revealMortal || !spec.action) return undefined;
    return evaluation?.evaluations.find((action) => action.action === spec.action)
      ?.probability;
  };

  const begin = (kind: CallKind) => {
    originRef.current = kind;
    onBegin(kind);
  };

  return (
    <div className="call-controls" role="group" aria-label="Calls">
      {buttons.calls.map((spec) => {
        const probability = probabilityFor(spec);
        return (
          <button
            key={spec.kind}
            ref={(element) => {
              buttonRefs.current[spec.kind] = element;
            }}
            type="button"
            className={`call-button call-button--${spec.kind}${
              pending?.kind === spec.kind ? ' call-button--picking' : ''
            }`}
            onClick={() => begin(spec.kind)}
            disabled={disabled || pending !== null}
            aria-label={spec.ariaLabel}
            data-call={spec.kind}
          >
            <span className="call-button-label">{spec.label}</span>
            {probability !== undefined && (
              <span
                className="call-button-probability"
                aria-label={`Mortal rates ${spec.label} ${formatProbability(probability)}`}
              >
                {formatProbability(probability)}
              </span>
            )}
          </button>
        );
      })}

      {buttons.pass && (
        <button
          type="button"
          className="call-button call-button--pass"
          onClick={onPass}
          disabled={disabled || pending !== null}
          aria-label="Pass on the call"
        >
          <span className="call-button-label">Pass</span>
        </button>
      )}

      {pending && (
        <>
          <span className="call-controls-prompt">{callPickPrompt(pending)}</span>
          <button
            ref={cancelRef}
            type="button"
            className="call-controls-cancel"
            onClick={cancel}
          >
            Cancel
          </button>
        </>
      )}

      {error && (
        <span className="call-controls-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
