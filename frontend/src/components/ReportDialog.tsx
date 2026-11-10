import { useState } from 'react';
import type { FormEvent } from 'react';
import { REPORT_REASON_OPTIONS } from '../report';
import type { ReportReason } from '../types/report';
import { MAX_NOTE_CHARS } from '../types/report';

interface ReportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (reason: ReportReason, note: string) => Promise<void>;
}

/**
 * Small mobile-friendly dialog for the report reason and note. The report is
 * downloaded only after the parent's export promise resolves.
 */
export function ReportDialog({
  isOpen,
  onClose,
  onSubmit,
}: ReportDialogProps) {
  const [reason, setReason] = useState<ReportReason>('expected_action_wrong');
  const [note, setNote] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSubmitting) return;

    setIsSubmitting(true);
    setError(null);
    try {
      await onSubmit(reason, note);
      setNote('');
      setReason('expected_action_wrong');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="report-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isSubmitting) {
          onClose();
        }
      }}
    >
      <form
        className="report-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="report-dialog-title"
        onSubmit={handleSubmit}
      >
        <h2 className="report-dialog-title" id="report-dialog-title">
          Report a bad answer
        </h2>
        <p className="report-dialog-copy">
          This downloads the exact table (including hidden opponent tiles), your
          answer, the app's answer, and an optional AI check. The note you write
          is included in the file. Attach it to an issue so the position can be
          reproduced.
        </p>

        <label className="report-field">
          <span className="report-field-label">What looks wrong?</span>
          <select
            className="report-select"
            value={reason}
            autoFocus
            onChange={(event) =>
              setReason(event.target.value as ReportReason)
            }
          >
            {REPORT_REASON_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="report-field">
          <span className="report-field-label">
            Note <span className="report-field-hint">(optional)</span>
          </span>
          <textarea
            className="report-textarea"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={MAX_NOTE_CHARS}
            rows={3}
            placeholder="Why do you think the expected answer is wrong?"
          />
        </label>

        {error && (
          <p className="report-dialog-error" role="alert">
            {error}
          </p>
        )}

        <div className="report-dialog-actions">
          <button
            className="report-button report-button--ghost"
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
          >
            Cancel
          </button>
          <button className="report-button" type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Preparing…' : 'Download report'}
          </button>
        </div>
      </form>
    </div>
  );
}
