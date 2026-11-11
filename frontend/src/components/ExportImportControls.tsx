import { useRef, useState } from 'react';
import type { ChangeEvent } from 'react';

interface ExportImportControlsProps {
  /** True once a table is loaded and can be downloaded. */
  canExport: boolean;
  /** Export/import error, shown inline. */
  fileError: string | null;
  /** Optional notice, e.g. after a successful export or import. */
  fileNotice: string | null;
  onExport: () => void;
  onImportFile: (file: File) => Promise<void>;
  onDismissNotice: () => void;
}

/**
 * Header-adjacent controls for downloading the current position and loading a
 * previously saved one. Not scoped to reporting a bad answer.
 */
export function ExportImportControls({
  canExport,
  fileError,
  fileNotice,
  onExport,
  onImportFile,
  onDismissNotice,
}: ExportImportControlsProps) {
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

  return (
    <div className="state-controls" aria-label="Import and export position">
      <div className="state-button-row">
        <button
          className="state-button"
          type="button"
          onClick={onExport}
          disabled={!canExport}
          title={
            canExport
              ? 'Download the current position as JSON'
              : 'No position is loaded yet'
          }
        >
          Export
        </button>

        <button
          className="state-button state-button--ghost"
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={isImporting}
          title="Load a position from a JSON file"
        >
          {isImporting ? 'Importing…' : 'Import'}
        </button>

        <input
          ref={fileInputRef}
          className="state-file-input"
          type="file"
          accept=".json,application/json"
          onChange={(event) => {
            void handleFileChange(event);
          }}
        />
      </div>

      {fileError && (
        <p className="state-inline-error" role="alert">
          {fileError}
        </p>
      )}

      {fileNotice && (
        <p className="state-inline-notice" role="status">
          {fileNotice}{' '}
          <button
            className="state-dismiss"
            type="button"
            onClick={onDismissNotice}
          >
            Dismiss
          </button>
        </p>
      )}
    </div>
  );
}
