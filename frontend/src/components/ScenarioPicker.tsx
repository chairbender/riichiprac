import { useEffect, useMemo, useRef, useState } from 'react';
import { HOTSEAT_SCENARIO_ID, isHotseatOnly } from '../hotseat';
import {
  ALL_SCENARIOS,
  groupScenarios,
  selectedScenarioIds,
  selectionLabel,
  setScenariosSelected,
  toggleScenario,
} from '../scenarios';
import type { ScenarioId, ScenarioOption, ScenarioSelection } from '../scenarios';
import type { PackManifestStatus } from '../services/packLoader';

interface ScenarioPickerProps {
  scenarios: ScenarioOption[];
  selection: ScenarioSelection;
  onChange: (selection: ScenarioSelection) => void;
  /** Opens the AI Hotseat card; its options are chosen before generation. */
  onConfigureHotseat: () => void;
  /** Replay-manifest state for the panel's pack note. */
  packStatus: PackManifestStatus;
  packCount: number;
  packError: string | null;
}

const PANEL_ID = 'scenario-pool-panel';

/**
 * Header control for the scenario pool.
 *
 * The old `<select>` could only name one lesson. This opens a panel grouped by
 * the Riichi Book 1 chapter/section each lesson teaches (published by the Rust
 * manifest), with a checkbox per lesson and a tri-state checkbox per group, so
 * a pool can be one lesson, a chapter section, or any hand-picked mix.
 *
 * Edits are staged in `draft` and only handed to the app when the user deals:
 * ticking six boxes should not generate six tables (or six Mortal forward
 * passes). "Only" stays a one-click way to drill a single lesson.
 */
export const ScenarioPicker = ({
  scenarios,
  selection,
  onChange,
  onConfigureHotseat,
  packStatus,
  packCount,
  packError,
}: ScenarioPickerProps) => {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ScenarioSelection>(selection);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const groups = useMemo(() => groupScenarios(scenarios), [scenarios]);
  const draftIds = useMemo(
    () => new Set(selectedScenarioIds(draft, scenarios)),
    [draft, scenarios],
  );
  const draftGroupCount = groups.filter((group) =>
    group.scenarios.some((scenario) => draftIds.has(scenario.id)),
  ).length;

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const toggleOpen = () => {
    if (open) {
      setOpen(false);
      return;
    }
    // Always start from the committed pool so a cancelled edit is discarded.
    setDraft(selection);
    setOpen(true);
  };

  const deal = (next: ScenarioSelection) => {
    setDraft(next);
    setOpen(false);
    // AI Hotseat is not generated from defaults: its card chooses the starting
    // conditions before the round is played.
    if (isHotseatOnly(next)) {
      onConfigureHotseat();
      return;
    }
    onChange(next);
  };

  const toggleGroup = (ids: ScenarioId[], selected: boolean) => {
    setDraft(setScenariosSelected(scenarios, draft, ids, selected));
  };

  const selectedCount = draft.kind === 'all' ? null : draft.ids.length;
  const canDeal = draft.kind === 'all' || draft.ids.length > 0;
  const poolSummary =
    draft.kind === 'all'
      ? 'Pool: every scenario, drawn at random'
      : draft.ids.length === 0
        ? 'Pick at least one scenario to deal'
        : `Pool: ${draft.ids.length} scenario${
            draft.ids.length === 1 ? '' : 's'
          } · ${draftGroupCount} section${draftGroupCount === 1 ? '' : 's'}`;

  /**
   * Pack status line.
   *
   * Replay is the default source for a lesson its pack covers (RF2), so this
   * note must not call pack rows opt-in; a failure note from a body that could
   * not be delivered is appended. RF3 replaces this with the Replay/Generated
   * source filter's own description.
   */
  const knownPackNote =
    packCount === 1
      ? 'Replay pack: PACK lessons deal a real audited hand. A covered lesson is dealt by default; its generated row drills that lesson instead.'
      : `${packCount} replay packs: PACK lessons deal a real audited hand. A covered lesson is dealt by default; its generated row drills that lesson instead.`;

  const packNote =
    packStatus === 'loading'
      ? 'Loading replay packs…'
      : packStatus === 'error'
        ? `Replay packs unavailable: ${packError ?? 'unknown error'}`
        : packStatus === 'empty'
          ? 'No replay packs are published yet.'
          : packError
            ? `${knownPackNote} ${packError}`
            : knownPackNote;

  return (
    <div className="scenario-picker" ref={containerRef}>
      <span className="scenario-picker-label" aria-hidden="true">
        Scenario
      </span>
      <button
        type="button"
        ref={triggerRef}
        className="scenario-picker-trigger"
        onClick={toggleOpen}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? PANEL_ID : undefined}
        title="Choose one lesson, all scenarios, or a pool to randomise between"
      >
        <span className="scenario-picker-trigger-label">
          {selectionLabel(selection, scenarios)}
        </span>
        <span className="scenario-picker-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div
          className="scenario-picker-panel"
          id={PANEL_ID}
          role="dialog"
          aria-label="Scenario pool"
        >
          <div className="scenario-picker-panel-head">
            <div className="scenario-picker-heading">Scenario pool</div>
            <p className="scenario-picker-hint">
              Pick one, a whole book section, or any mix to randomise between.
            </p>
            <p className="scenario-picker-pack-note" role="status">
              {packNote}
            </p>
          </div>

          <label className="scenario-picker-all">
            <input
              type="checkbox"
              checked={draft.kind === 'all'}
              onChange={(event) =>
                setDraft(
                  event.target.checked
                    ? ALL_SCENARIOS
                    : { kind: 'selected', ids: [] },
                )
              }
            />
            <span>All scenarios (random)</span>
          </label>

          <div className="scenario-group-list">
            {groups.map((group) => {
              const groupIds = group.scenarios.map((scenario) => scenario.id);
              const checkedCount = group.scenarios.filter((scenario) =>
                draftIds.has(scenario.id),
              ).length;
              const allChecked = checkedCount === group.scenarios.length;
              const partial = checkedCount > 0 && !allChecked;

              return (
                <div className="scenario-group" key={group.key}>
                  <label className="scenario-group-head">
                    <input
                      type="checkbox"
                      checked={allChecked}
                      ref={(input) => {
                        if (input) input.indeterminate = partial;
                      }}
                      onChange={(event) =>
                        toggleGroup(groupIds, event.target.checked)
                      }
                      aria-label={`Select all in ${group.label}`}
                    />
                    <span className="scenario-group-label">{group.label}</span>
                    <span className="scenario-group-count">
                      {checkedCount}/{group.scenarios.length}
                    </span>
                  </label>

                  <ul className="scenario-group-items">
                    {group.scenarios.map((scenario) => (
                      <li className="scenario-item" key={scenario.id}>
                        <label className="scenario-item-label">
                          <input
                            type="checkbox"
                            checked={draftIds.has(scenario.id)}
                            onChange={() =>
                              setDraft(
                                toggleScenario(scenarios, draft, scenario.id),
                              )
                            }
                          />
                          <span
                            className="scenario-item-name"
                            title={scenario.description}
                          >
                            {scenario.label}
                          </span>
                          {scenario.requires_ai && (
                            <span className="scenario-item-badge">AI</span>
                          )}
                          {scenario.pack && (
                            <span
                              className="scenario-item-badge"
                              title={`Replay pack ${scenario.pack.packId}`}
                            >
                              PACK
                            </span>
                          )}
                        </label>
                        <button
                          type="button"
                          className="scenario-item-only"
                          onClick={() =>
                            deal({ kind: 'selected', ids: [scenario.id] })
                          }
                          title={
                            scenario.id === HOTSEAT_SCENARIO_ID
                              ? 'Choose the AI Hotseat starting conditions'
                              : `Deal only ${scenario.label}`
                          }
                        >
                          {scenario.id === HOTSEAT_SCENARIO_ID
                            ? 'Setup'
                            : 'Only'}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>

          <div className="scenario-picker-footer">
            <span className="scenario-picker-pool" aria-live="polite">
              {poolSummary}
            </span>
            <div className="scenario-picker-actions">
              <button
                type="button"
                className="scenario-picker-cancel"
                onClick={() => setOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="scenario-picker-deal"
                disabled={!canDeal}
                onClick={() => deal(draft)}
              >
                {selectedCount === 1 ? 'Deal this lesson' : 'Deal from pool'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
