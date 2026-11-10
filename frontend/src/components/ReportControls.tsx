import { useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import type { ReportReason } from '../types/report';
import { ReportDialog } from './ReportDialog';

interface ReportControlsProps {
  /** True once the player has answered the current puzzle. */
  canReport: boolean;
  /** Import/export error, shown inline. */
  reportError: string | null;
  /** Optional notice, e.g. after importing a bare game state. */
  reportNotice: string | null;
  onExport: (reason: ReportReason, note: string) => Promise<void>;
  onImportFile: (file: File) => Promise<void>;
  onDismissNotice: () => void;
}

/**
 * Header-adjacent controls for exporting a disputed puzzle and importing a
 * previously exported report.
 */
export function ReportControls({
  canReport,
  reportError,
  reportNotice,
  onExport,
  onImportFile,
  onDismissNotice,
}: ReportControlsProps) {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Allow selecting the same file again after an error.
    event.target.value = '';
    if (!file) return;

    setIsImporting(true);
    try {
      await onImportFile(file);
    } finally {
      setIsImporting(false);
    }
  };

  const handleSubmit = async (reason: ReportReason, note: string) => {
    await onExport(reason, note);
    setIsDialogOpen(false);
  };

  return (
    <div className="report-controls" aria-label="Scenario reports">
      <div className="report-button-row">
        <button
          className="report-button"
          type="button"
          onClick={() => setIsDialogOpen(true)}
          disabled={!canReport}
          title={
            canReport
              ? 'Download a reproducible report for this decision'
              : 'Answer the puzzle before reporting it'
          }
        >
          Report bad answer
        </button>

        <button
          className="report-button report-button--ghost"
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={isImporting}
        >
          {isImporting ? 'Importing…' : 'Import report'}
        </button>

        <input
          ref={fileInputRef}
          className="report-file-input"
          type="file"
          accept=".json,application/json"
          onChange={(event) => {
            void handleFileChange(event);
          }}
        />
      </div>

      {reportError && (
        <p className="report-inline-error" role="alert">
          {reportError}
        </p>
      )}

      {reportNotice && (
        <p className="report-inline-notice" role="status">
          {reportNotice}{' '}
          <button
            className="report-dismiss"
            type="button"
            onClick={onDismissNotice}
          >
            Dismiss
          </button>
        </p>
      )}

      <ReportDialog
        isOpen={isDialogOpen}
        onClose={() => setIsDialogOpen(false)}
        onSubmit={handleSubmit}
      />
    </div>
  );
}
