import type { ChangeEvent } from 'react';
import type { ScenarioOption, ScenarioSelection } from '../scenarios';
import type { TableView } from '../store/useSettingsStore';
import type { AiStatus } from '../types/ai';
import { NextScenarioButton } from './NextScenarioButton';
import { ScenarioPicker } from './ScenarioPicker';

interface AppControlsProps {
  scenarios: ScenarioOption[];
  selection: ScenarioSelection;
  onSelectionChange: (selection: ScenarioSelection) => void;
  requireAgreement: boolean;
  aiStatus: AiStatus;
  /** Tooltip explaining whether the Mortal-agreement filter can run. */
  agreementHint: string;
  onAgreementChange: (event: ChangeEvent<HTMLInputElement>) => void;
  tableView: TableView;
  /** Tooltip explaining the view choices. */
  viewHint: string;
  onViewChange: (event: ChangeEvent<HTMLSelectElement>) => void;
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
  requireAgreement,
  aiStatus,
  agreementHint,
  onAgreementChange,
  tableView,
  viewHint,
  onViewChange,
  onNextScenario,
  nextDisabled,
}: AppControlsProps) {
  return (
    <>
      <ScenarioPicker
        scenarios={scenarios}
        selection={selection}
        onChange={onSelectionChange}
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
          <option value="rendered">Rendered 2.5D</option>
        </select>
      </label>

      <NextScenarioButton onClick={onNextScenario} disabled={nextDisabled} />
    </>
  );
}
