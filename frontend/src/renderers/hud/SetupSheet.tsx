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
 * The scenario pool is a **page** of the sheet (2026-11-21), not a nested
 * popover: Escape, a scrim tap or Cancel step back to the settings page and the
 * next one closes the sheet (App owns that page state). The hotseat form has no
 * wrapper of its own: the sheet is the one modal, so it renders the shared body
 * inline.
 */

import { useId, useState } from "react";
import type { ChangeEvent, ReactNode } from "react";
import { AgreementToggle } from "../../components/AgreementToggle";
import { ExportImportControls } from "../../components/ExportImportControls";
import type { ExportImportControlsProps } from "../../components/ExportImportControls";
import { HotseatCardBody } from "../../components/HotseatCard";
import { ScenarioPicker } from "../../components/ScenarioPicker";
import { selectionLabel } from "../../scenarios";
import { ViewPicker } from "../../components/ViewPicker";
import type { HotseatOptions } from "../../hotseat";
import type { ScenarioOption, ScenarioSelection } from "../../scenarios";
import type { PackManifestStatus } from "../../services/packLoader";
import type { TableView } from "../../store/useSettingsStore";
import type { AiStatus } from "../../types/ai";
import { useHudCollapse } from "./hudBand";

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
  /**
   * Which page of the sheet is showing (2026-11-21). `settings` is the list of
   * sections; `pool` gives the scenario picker the whole pane. The host owns the
   * value so Escape and a scrim tap can step back one page before closing.
   */
  readonly page?: "settings" | "pool";
  /** Open the pool page (the Scenario row). */
  readonly onNavigatePool?: () => void;
  /** Leave the pool page for the settings page (Back, Escape, scrim). */
  readonly onBackToSettings?: () => void;
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
  page = "settings",
  onNavigatePool,
  onBackToSettings,
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

  /*
   * The scenario pool is a **page**, not a dropdown (user request 2026-11-21):
   * its list needs the whole pane to scroll, and a 300 px popover inside a
   * 296 px sheet could not give it that. The sheet navigates: settings -> pool,
   * and Back (or Escape, or a scrim tap) returns to settings before the next one
   * closes the sheet.
   */
  if (page === "pool") {
    return (
      <div className="hud-setup-sheet hud-setup-sheet--pool">
        <ScenarioPicker
          variant="page"
          scenarios={scenarios}
          selection={selection}
          onChange={onSelectionChange}
          onConfigureHotseat={() => setHotseatOpen(true)}
          onCancel={onBackToSettings}
          packStatus={packStatus}
          packCount={packCount}
          packError={packError}
          preferReplay={preferReplay}
          onPreferReplayChange={onPreferReplayChange}
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
              onCancel={() => setHotseatOpen(false)}
              titleId={hotseatTitleId}
              titleAs="h3"
            />
          </section>
        )}
      </div>
    );
  }

  return (
    <div className="hud-setup-sheet">
      <section className="hud-setup-section" aria-labelledby={poolHeadingId}>
        <h3 className="hud-setup-section-heading" id={poolHeadingId}>
          Scenario
        </h3>
        <button
          type="button"
          className="hud-setup-scenario-row"
          onClick={onNavigatePool}
          // The same title the 2D header's pool control carries, so the two
          // shells name the control identically; its text is the selection.
          title="Choose one lesson, all scenarios, or a pool to randomise between"
        >
          <span className="hud-setup-scenario-value">
            {selectionLabel(selection, scenarios)}
          </span>
          <span className="hud-setup-scenario-go" aria-hidden="true">
            Change ▸
          </span>
        </button>
      </section>

      <section
        className="hud-setup-section"
        aria-labelledby={settingsHeadingId}
      >
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
          {viewHint ? (
            <p className="hud-setup-hint" id={viewHintId}>
              {viewHint}
            </p>
          ) : null}
        </div>
      </section>

      <section
        className="hud-setup-section"
        aria-labelledby={positionHeadingId}
      >
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
