/**
 * The 3D HUD's setup sheet (3D-H4).
 *
 * Everything that is not the live hand lives here, behind one trigger in the top
 * bar (`3d_hud.md` §2, §3): what to practise, the generated-hand configuration,
 * the settings, the import/export controls and the table's information. Opening
 * or closing the sheet is a view change only — it never re-deals, never
 * re-grades and never unmounts the scene (the `Sheet` primitive owns the modal
 * behaviour; H2's tests pin it).
 *
 * Composition, per §3's control inventory:
 *
 * - the pool section reuses the 2D `ScenarioPicker` unchanged, including its
 *   staged draft: ticks are local until "Deal from pool" commits them, and the
 *   AI Hotseat row's "Setup" opens the generation form in place rather than a
 *   second modal;
 * - the settings section reuses the header's own `AgreementToggle` and
 *   `ViewPicker`, so the label and disabled state cannot drift between shells;
 * - the position section reuses `ExportImportControls`, and the table section
 *   re-hosts `TableInfo`, the agreement/scenario notes and the imported
 *   position's full description.
 *
 * A nested `ScenarioPicker` panel marks itself with `NESTED_LAYER_ATTRIBUTE`
 * while open, so its Escape closes the panel and only the next Escape closes
 * the sheet (§6.5.4). The hotseat form has no wrapper of its own: the sheet is
 * the one modal, so it renders the shared body inline.
 */

import { useId, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import { AgreementToggle } from '../../components/AgreementToggle';
import { ExportImportControls } from '../../components/ExportImportControls';
import type { ExportImportControlsProps } from '../../components/ExportImportControls';
import { HotseatCardBody } from '../../components/HotseatCard';
import { ScenarioPicker } from '../../components/ScenarioPicker';
import { ViewPicker } from '../../components/ViewPicker';
import type { HotseatOptions } from '../../hotseat';
import type { ScenarioOption, ScenarioSelection } from '../../scenarios';
import type { PackManifestStatus } from '../../services/packLoader';
import type { TableView } from '../../store/useSettingsStore';
import type { AiStatus } from '../../types/ai';
import { useHudCollapse } from './hudBand';
import { NESTED_LAYER_ATTRIBUTE } from './Sheet';

/** The top bar's setup trigger: the one front door to the sheet (§3, row 3). */
export interface SetupTriggerProps {
  onOpen: () => void;
  /** Whether the sheet this trigger opens is the one currently open. */
  expanded?: boolean;
}

/**
 * The setup trigger's icon (§5's portrait band): a sliders glyph, because the
 * sheet is what to practise, the settings and the position controls. It is
 * decorative — the button's name is "Setup" either way — so it is `aria-hidden`
 * and hidden by CSS outside portrait.
 */
function SetupIcon() {
  return (
    <svg
      className="hud-top-bar__setup-icon"
      viewBox="0 0 20 20"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M3 6.5h14M3 13.5h14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="7.5" cy="6.5" r="2" fill="currentColor" />
      <circle cx="12.5" cy="13.5" r="2" fill="currentColor" />
    </svg>
  );
}

export function SetupTrigger({ onOpen, expanded = false }: SetupTriggerProps) {
  /*
   * §5: portrait collapses the label to an icon. The label stays in the DOM
   * behind `.hud-visually-hidden` and the button keeps the `aria-label`, so its
   * accessible name and the sheet's front door are unchanged.
   */
  const { setupIconOnly } = useHudCollapse();
  return (
    <button
      type="button"
      className="hud-top-bar__setup"
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      aria-label={setupIconOnly ? 'Setup' : undefined}
      title="Choose what to practise, the table settings, and import or export a position"
    >
      <SetupIcon />
      <span
        className={
          setupIconOnly ? 'hud-visually-hidden' : 'hud-top-bar__setup-label'
        }
      >
        Setup
      </span>
    </button>
  );
}

/**
 * The setup sheet's body.
 *
 * The pool and the two settings take the same values the 2D header passes to
 * its own controls; the remaining 2D blocks (`ExportImportControls`, `TableInfo`
 * and the notes) are handed in as the elements App already builds, so the two
 * shells render one component with one set of props rather than two copies of
 * the markup.
 */
export interface SetupSheetProps {
  // Scenario pool --------------------------------------------------------
  readonly scenarios: ScenarioOption[];
  readonly selection: ScenarioSelection;
  /** A committed pool: only a deal calls this (the draft stays local). */
  readonly onSelectionChange: (selection: ScenarioSelection) => void;
  readonly packStatus: PackManifestStatus;
  readonly packCount: number;
  readonly packError: string | null;
  readonly preferReplay: boolean;
  readonly onPreferReplayChange: (preferReplay: boolean) => void;

  // AI Hotseat -----------------------------------------------------------
  /** The last card choice; the form starts from it. */
  readonly hotseatOptions: HotseatOptions;
  /** True while a round is being generated: both form buttons disable. */
  readonly hotseatBusy: boolean;
  readonly onGenerateHotseat: (options: HotseatOptions) => void;

  // Settings -------------------------------------------------------------
  readonly requireAgreement: boolean;
  readonly aiStatus: AiStatus;
  /** The header's own tooltip text, shown inline here (§3, row 14). */
  readonly agreementHint: string;
  readonly onAgreementChange: (event: ChangeEvent<HTMLInputElement>) => void;
  readonly tableView: TableView;
  readonly viewHint: string;
  readonly onViewChange: (event: ChangeEvent<HTMLSelectElement>) => void;
  readonly rendered3dExposed: boolean;
  readonly threeUnavailableReason: string | null;

  // Re-hosted 2D blocks --------------------------------------------------
  readonly exportImport: ExportImportControlsProps;
  /** `TableInfo`'s element, when a hand is loaded. */
  readonly tableInfo?: ReactNode;
  /** The agreement note and the scenario note, when present. */
  readonly notes?: ReactNode;
  /** The imported position's full description card, when present. */
  readonly positionNote?: ReactNode;
}

export function SetupSheet({
  scenarios,
  selection,
  onSelectionChange,
  packStatus,
  packCount,
  packError,
  preferReplay,
  onPreferReplayChange,
  hotseatOptions,
  hotseatBusy,
  onGenerateHotseat,
  requireAgreement,
  aiStatus,
  agreementHint,
  onAgreementChange,
  tableView,
  viewHint,
  onViewChange,
  rendered3dExposed,
  threeUnavailableReason,
  exportImport,
  tableInfo,
  notes,
  positionNote,
}: SetupSheetProps) {
  const poolHeadingId = useId();
  const settingsHeadingId = useId();
  const positionHeadingId = useId();
  const tableHeadingId = useId();
  const agreementHintId = useId();
  const viewHintId = useId();
  const hotseatTitleId = useId();
  /** The pool section's AI Hotseat form, opened by the picker's "Setup" row. */
  const [hotseatOpen, setHotseatOpen] = useState(false);

  const hasTableSection = Boolean(tableInfo || notes || positionNote);

  return (
    <div className="hud-setup-sheet">
      <section className="hud-setup-section" aria-labelledby={poolHeadingId}>
        <h3 className="hud-setup-section-heading" id={poolHeadingId}>
          Scenario
        </h3>
        <ScenarioPicker
          scenarios={scenarios}
          selection={selection}
          onChange={onSelectionChange}
          // The AI Hotseat lesson is configured before it is dealt, not drawn
          // from defaults: the picker's "Setup" row opens the form in place.
          onConfigureHotseat={() => setHotseatOpen(true)}
          packStatus={packStatus}
          packCount={packCount}
          packError={packError}
          preferReplay={preferReplay}
          onPreferReplayChange={onPreferReplayChange}
          nestedLayerAttribute={NESTED_LAYER_ATTRIBUTE}
        />
        {hotseatOpen && (
          <section
            className="hud-setup-hotseat"
            aria-labelledby={hotseatTitleId}
          >
            <HotseatCardBody
              initialOptions={hotseatOptions}
              busy={hotseatBusy}
              onGenerate={onGenerateHotseat}
              // Cancelling returns to the pool; the sheet itself stays open.
              onCancel={() => setHotseatOpen(false)}
              titleId={hotseatTitleId}
              titleAs="h3"
            />
          </section>
        )}
      </section>

      <section className="hud-setup-section" aria-labelledby={settingsHeadingId}>
        <h3 className="hud-setup-section-heading" id={settingsHeadingId}>
          Settings
        </h3>
        <div className="hud-setup-setting">
          <AgreementToggle
            requireAgreement={requireAgreement}
            aiStatus={aiStatus}
            hint={agreementHint}
            describedBy={agreementHintId}
            onChange={onAgreementChange}
          />
          <p className="hud-setup-hint" id={agreementHintId}>
            {agreementHint}
          </p>
        </div>
        <div className="hud-setup-setting">
          <ViewPicker
            tableView={tableView}
            hint={viewHint}
            describedBy={viewHintId}
            onViewChange={onViewChange}
            rendered3dExposed={rendered3dExposed}
            threeUnavailableReason={threeUnavailableReason}
          />
          <p className="hud-setup-hint" id={viewHintId}>
            {viewHint}
          </p>
        </div>
      </section>

      <section className="hud-setup-section" aria-labelledby={positionHeadingId}>
        <h3 className="hud-setup-section-heading" id={positionHeadingId}>
          Position
        </h3>
        <ExportImportControls {...exportImport} />
      </section>

      {hasTableSection && (
        <section className="hud-setup-section" aria-labelledby={tableHeadingId}>
          <h3 className="hud-setup-section-heading" id={tableHeadingId}>
            Table info
          </h3>
          {tableInfo}
          {positionNote}
          {notes}
        </section>
      )}
    </div>
  );
}
