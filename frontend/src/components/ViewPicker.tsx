import type { ChangeEvent } from 'react';
import type { TableView } from '../store/useSettingsStore';

export interface ViewPickerProps {
  /** The persisted view the table is drawn with. */
  tableView: TableView;
  /** Tooltip explaining the view choices. */
  hint: string;
  /** An inline hint's id, when the host also shows it in the open (3D sheet). */
  describedBy?: string;
  onViewChange: (event: ChangeEvent<HTMLSelectElement>) => void;
  /**
   * Whether the View control offers the 3D value. It stays false until
   * `RENDERED3D_EXPOSED` flips at 3D-15 (decision 1); the query flag is the
   * only way in until then, and a value a later build stored still shows.
   */
  rendered3dExposed: boolean;
  /** Why the 3D value cannot run here, or null when it can. */
  threeUnavailableReason: string | null;
}

/**
 * The View control, shared by the 2D header (`AppControls`) and the 3D setup
 * sheet (3D-H4).
 *
 * The 3D option is offered only once 3D-15 exposes it. A value some build
 * already stored still gets a matching option: a `<select>` whose value has no
 * option renders blank and would misreport the saved choice. When the browser
 * cannot run the view the option is disabled and says why. Switching away from
 * 3D leaves full screen — that is App's rule (R14), identical from either
 * shell because both call the same handler.
 */
export function ViewPicker({
  tableView,
  hint,
  describedBy,
  onViewChange,
  rendered3dExposed,
  threeUnavailableReason,
}: ViewPickerProps) {
  const offerRendered3d = rendered3dExposed || tableView === 'rendered3d';
  const rendered3dDisabled = threeUnavailableReason !== null;

  return (
    <label className="app-toggle app-view-picker" title={hint}>
      <span>View</span>
      <select
        className="app-view-select"
        value={tableView}
        aria-describedby={describedBy}
        onChange={onViewChange}
      >
        <option value="stacked">Stacked</option>
        <option value="topdown">Top-down</option>
        {offerRendered3d && (
          <option
            value="rendered3d"
            disabled={rendered3dDisabled}
            title={threeUnavailableReason ?? undefined}
          >
            {rendered3dDisabled ? '3D (unavailable)' : '3D'}
          </option>
        )}
      </select>
    </label>
  );
}
