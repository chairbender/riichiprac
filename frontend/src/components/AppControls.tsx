import type { ChangeEvent } from 'react';
import type { ScenarioOption, ScenarioSelection } from '../scenarios';
import type { PackManifestStatus } from '../services/packLoader';
import type { TableView } from '../store/useSettingsStore';
import type { AiStatus } from '../types/ai';
import { NextScenarioButton } from './NextScenarioButton';
import { ScenarioPicker } from './ScenarioPicker';

interface AppControlsProps {
  scenarios: ScenarioOption[];
  selection: ScenarioSelection;
  onSelectionChange: (selection: ScenarioSelection) => void;
  /** Opens the AI Hotseat generation card without dealing a hand. */
  onConfigureHotseat: () => void;
  /** Replay-manifest state shown in the picker's pack note. */
  packStatus: PackManifestStatus;
  packCount: number;
  packError: string | null;
  requireAgreement: boolean;
  aiStatus: AiStatus;
  /** Tooltip explaining whether the Mortal-agreement filter can run. */
  agreementHint: string;
  onAgreementChange: (event: ChangeEvent<HTMLInputElement>) => void;
  tableView: TableView;
  /** Tooltip explaining the view choices. */
  viewHint: string;
  onViewChange: (event: ChangeEvent<HTMLSelectElement>) => void;
  /**
   * Whether the View control offers the 3D value. It stays false until
   * `RENDERED3D_EXPOSED` flips at 3D-15 (decision 1); the query flag is the
   * only way in until then, and a value a later build stored still shows.
   */
  rendered3dExposed: boolean;
  /** Why the 3D value cannot run here, or null when it can. */
  threeUnavailableReason: string | null;
  onNextScenario: () => void;
  nextDisabled: boolean;
}

/**
 * The scenario-pool, agreement, view, and next-hand controls.
 *
 * Kept in one component so every shell offers exactly the same controls: a
 * setting added here can never be missing from another layout.
 */
export function AppControls({
  scenarios,
  selection,
  onSelectionChange,
  onConfigureHotseat,
  packStatus,
  packCount,
  packError,
  requireAgreement,
  aiStatus,
  agreementHint,
  onAgreementChange,
  tableView,
  viewHint,
  onViewChange,
  rendered3dExposed,
  threeUnavailableReason,
  onNextScenario,
  nextDisabled,
}: AppControlsProps) {
  /*
   * The 3D option is offered only once 3D-15 exposes it. A value some build
   * already stored still gets a matching option: a `<select>` whose value has
   * no option renders blank and would misreport the saved choice. When the
   * browser cannot run the view the option is disabled and says why.
   */
  const offerRendered3d = rendered3dExposed || tableView === 'rendered3d';
  const rendered3dDisabled = threeUnavailableReason !== null;

  return (
    <>
      <ScenarioPicker
        scenarios={scenarios}
        selection={selection}
        onChange={onSelectionChange}
        onConfigureHotseat={onConfigureHotseat}
        packStatus={packStatus}
        packCount={packCount}
        packError={packError}
      />

      <label className="app-toggle" title={agreementHint}>
        <input
          type="checkbox"
          checked={requireAgreement}
          disabled={aiStatus !== 'ready'}
          onChange={onAgreementChange}
        />
        <span>Mortal must agree</span>
      </label>

      <label className="app-toggle app-view-picker" title={viewHint}>
        <span>View</span>
        <select
          className="app-view-select"
          value={tableView}
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

      <NextScenarioButton onClick={onNextScenario} disabled={nextDisabled} />
    </>
  );
}
