import type { ChangeEvent } from 'react';
import type { ScenarioOption, ScenarioSelection } from '../scenarios';
import type { PackManifestStatus } from '../services/packLoader';
import type { TableView } from '../store/useSettingsStore';
import type { AiStatus } from '../types/ai';
import { AgreementToggle } from './AgreementToggle';
import { NextScenarioButton } from './NextScenarioButton';
import { ScenarioPicker } from './ScenarioPicker';
import { ViewPicker } from './ViewPicker';

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
  /** Replay-first default source for covered lessons (RF2/RF3). */
  preferReplay: boolean;
  /** The picker's Generated source filter turns the default source off. */
  onPreferReplayChange: (preferReplay: boolean) => void;
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
 * setting added here can never be missing from another layout. The agreement
 * toggle and the view picker are their own components because the 3D setup
 * sheet (3D-H4) hosts the same two settings: one component per control keeps
 * the two shells' labels and disabled states from drifting.
 */
export function AppControls({
  scenarios,
  selection,
  onSelectionChange,
  onConfigureHotseat,
  packStatus,
  packCount,
  packError,
  preferReplay,
  onPreferReplayChange,
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
        preferReplay={preferReplay}
        onPreferReplayChange={onPreferReplayChange}
      />

      <AgreementToggle
        requireAgreement={requireAgreement}
        aiStatus={aiStatus}
        hint={agreementHint}
        onChange={onAgreementChange}
      />

      <ViewPicker
        tableView={tableView}
        hint={viewHint}
        onViewChange={onViewChange}
        rendered3dExposed={rendered3dExposed}
        threeUnavailableReason={threeUnavailableReason}
      />

      <NextScenarioButton onClick={onNextScenario} disabled={nextDisabled} />
    </>
  );
}
