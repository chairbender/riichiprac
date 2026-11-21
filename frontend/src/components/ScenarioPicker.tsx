import { useEffect, useMemo, useRef, useState } from "react";
import { HOTSEAT_SCENARIO_ID, isHotseatOnly } from "../hotseat";
import {
  ALL_SCENARIOS,
  DEFAULT_SOURCE_FILTER,
  groupScenarios,
  pickerScenarioRows,
  selectedScenarioIds,
  selectionLabel,
  setScenariosSelected,
  toggleScenario,
} from "../scenarios";
import type {
  ScenarioId,
  ScenarioOption,
  ScenarioSelection,
  ScenarioSourceFilter,
} from "../scenarios";
import type { PackManifestStatus } from "../services/packLoader";

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
  /**
   * The replay-first default: true deals a covered lesson from its replay row.
   * The Generated source filter turns it off, which is how a session opts into
   * generated drills for the default pool.
   */
  preferReplay: boolean;
  /** Apply the source filter's default-pool choice. */
  onPreferReplayChange: (preferReplay: boolean) => void;
  /**
   * The attribute the open panel sets (value `"open"`), for a host that must
   * know a layer is nested inside its own modal (3D-H4's setup sheet). The 2D
   * header passes nothing, so its output is unchanged.
   */
  nestedLayerAttribute?: string;
  /**
   * `popover` (default) is the 2D header's trigger plus a floating panel.
   * `page` renders the panel's content **on its own**, for a host that gives it
   * a whole pane (the 3D setup sheet, 2026-11-21): no trigger, no open state and
   * no outside-click/Escape handling — the host mounts it when it navigates to
   * the page and unmounts it on the way back, which is what gives the list the
   * full height and a working scroll.
   */
  variant?: "popover" | "page";
  /** The page variant's Cancel: return to the host's previous page. */
  onCancel?: () => void;
}

const PANEL_ID = "scenario-pool-panel";

/**
 * The source filter's three states, in the order the rollout plan names them.
 * Each title spells out what the filter lists; none of it names an answer.
 */
const SOURCE_FILTERS: Array<{
  id: ScenarioSourceFilter;
  label: string;
  hint: string;
}> = [
  {
    id: "replay",
    label: "Replay",
    hint: "Replay rows only: the real audited hands shipped for a lesson. A lesson with no replay row is listed under Generated or Both.",
  },
  {
    id: "generated",
    label: "Generated",
    hint: "Generated drills only, and the default pool deals them. Covered lessons keep a replay row one filter away.",
  },
  {
    id: "both",
    label: "Both",
    hint: "Every row: a covered lesson leads with its replay position and the generated drill follows as the opt-in alternative.",
  },
];

/**
 * Header control for the scenario pool.
 *
 * The old `<select>` could only name one lesson. This opens a panel grouped by
 * the Riichi Book 1 chapter/section each lesson teaches (published by the Rust
 * manifest), with a checkbox per lesson and a tri-state checkbox per group, so
 * a pool can be one lesson, a chapter section, or any hand-picked mix.
 *
 * The panel also carries the replay-first source model (RF3): a Source filter
 * (Replay/Generated/Both) plus per-row source labels. A covered lesson leads
 * with its **REPLAY** row and trails its generated drill as the **GENERATED**
 * opt-in; the Generated filter also switches the default pool to generated
 * drills. The Replay filter is exclusive — it lists replay rows only, and a
 * lesson without one is reachable under Generated or Both. Filtering changes
 * the rows listed, never the ticks already made.
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
  packError,
  preferReplay,
  onPreferReplayChange,
  nestedLayerAttribute,
  variant = "popover",
  onCancel,
}: ScenarioPickerProps) => {
  const isPage = variant === "page";
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ScenarioSelection>(selection);
  /**
   * Which source the panel lists. Session state, not part of the draft: picking
   * a scenario must not reset it, and it survives the panel closing. A stored
   * `preferReplay: false` opens straight on Generated, the state that matches
   * the pool it produces.
   */
  const [sourceFilter, setSourceFilter] = useState<ScenarioSourceFilter>(
    preferReplay ? DEFAULT_SOURCE_FILTER : "generated",
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const rows = useMemo(
    () => pickerScenarioRows(scenarios, sourceFilter),
    [scenarios, sourceFilter],
  );
  const rowById = useMemo(
    () => new Map(rows.map((row) => [row.option.id, row])),
    [rows],
  );
  const visibleScenarios = useMemo(() => rows.map((row) => row.option), [rows]);
  const groups = useMemo(
    () => groupScenarios(visibleScenarios),
    [visibleScenarios],
  );
  const draftIds = useMemo(
    () => new Set(selectedScenarioIds(draft, scenarios, preferReplay)),
    [draft, scenarios, preferReplay],
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
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
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
    setDraft(
      setScenariosSelected(scenarios, draft, ids, selected, preferReplay),
    );
  };

  /**
   * The Generated filter is the visible way to stop preferring replay for a
   * covered lesson, so it also sets `preferReplay`; the other two keep replay
   * as the default source. Ticks and the draft selection are untouched.
   */
  const changeSourceFilter = (next: ScenarioSourceFilter) => {
    setSourceFilter(next);
    onPreferReplayChange(next !== "generated");
  };

  const selectedCount = draft.kind === "all" ? null : draft.ids.length;
  const canDeal = draft.kind === "all" || draft.ids.length > 0;
  /**
   * The Replay filter is exclusive, so a deployment with no published replay
   * rows lists nothing there. The empty state says why and points at the
   * filters that do list rows, rather than leaving a blank group list.
   */
  const emptySourceNote =
    rows.length > 0
      ? null
      : sourceFilter === "replay"
        ? "No replay rows are published yet. Pick Generated to drill generated scenarios, or Both to list every row."
        : "No scenarios are published for this source yet.";

  const poolSummary =
    draft.kind === "all"
      ? "Pool: every scenario, drawn at random"
      : draft.ids.length === 0
        ? "Pick at least one scenario to deal"
        : `Pool: ${draft.ids.length} scenario${
            draft.ids.length === 1 ? "" : "s"
          } · ${draftGroupCount} section${draftGroupCount === 1 ? "" : "s"}`;

  /*
   * Only a **status** line, and only when there is one (user request
   * 2026-11-22: no explanation of the replay model — the REPLAY/GENERATED
   * badges and the Source filter are left to speak for themselves).
   */
  const packNote =
    packStatus === "loading"
      ? "Loading replay packs…"
      : packStatus === "error"
        ? `Replay packs unavailable: ${packError ?? "unknown error"}`
        : packStatus === "empty"
          ? "No replay packs are published yet, so every lesson stays generated."
          : packError;

  const panel = (
    <div
      className="scenario-picker-panel"
      id={PANEL_ID}
      // A floating panel is a dialog; a page is a region inside the host's one
      // modal, so it must not nest a second dialog.
      role={isPage ? "group" : "dialog"}
      aria-label="Scenario pool"
      // A host modal (the 3D setup sheet) consumes Escape only when no nested
      // layer is open; a page is not a nested layer.
      {...(nestedLayerAttribute && !isPage
        ? { [nestedLayerAttribute]: "open" }
        : {})}
    >
      {packNote && (
        <p className="scenario-picker-pack-status" role="status">
          {packNote}
        </p>
      )}
      <fieldset className="scenario-picker-source">
        <legend className="scenario-picker-source-legend">Source</legend>
        <div className="scenario-picker-source-options">
          {SOURCE_FILTERS.map((filter) => (
            <label
              className="scenario-picker-source-option"
              key={filter.id}
              title={filter.hint}
            >
              <input
                type="radio"
                name="scenario-source-filter"
                value={filter.id}
                checked={sourceFilter === filter.id}
                onChange={() => changeSourceFilter(filter.id)}
              />
              <span>
                {filter.label}
                {filter.id === "replay" && (
                  <span className="scenario-picker-asterisk" aria-hidden="true">
                    *
                  </span>
                )}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <label className="scenario-picker-all">
        <input
          type="checkbox"
          checked={draft.kind === "all"}
          onChange={(event) =>
            setDraft(
              event.target.checked
                ? ALL_SCENARIOS
                : { kind: "selected", ids: [] },
            )
          }
        />
        <span>All scenarios (random)</span>
      </label>

      <div className="scenario-group-list">
        {emptySourceNote && (
          <p className="scenario-picker-empty">{emptySourceNote}</p>
        )}
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
                {group.scenarios.map((scenario) => {
                  const row = rowById.get(scenario.id);
                  const className = row?.generatedAlternative
                    ? "scenario-item scenario-item-generated-alt"
                    : "scenario-item";
                  return (
                    <li className={className} key={scenario.id}>
                      <label className="scenario-item-label">
                        <input
                          type="checkbox"
                          checked={draftIds.has(scenario.id)}
                          onChange={() =>
                            setDraft(
                              toggleScenario(
                                scenarios,
                                draft,
                                scenario.id,
                                preferReplay,
                              ),
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
                            title={`Replay pack ${scenario.pack.packId}${
                              scenario.pack.bases > 0
                                ? ` · ${scenario.pack.bases} reviewed base${
                                    scenario.pack.bases === 1 ? "" : "s"
                                  }`
                                : ""
                            }`}
                          >
                            REPLAY
                          </span>
                        )}
                        {row?.generatedAlternative && (
                          <span
                            className="scenario-item-badge scenario-item-badge-generated"
                            title="Generated drill: the opt-in alternative to this lesson's replay position."
                          >
                            GENERATED
                          </span>
                        )}
                      </label>
                      <button
                        type="button"
                        className="scenario-item-only"
                        onClick={() =>
                          deal({ kind: "selected", ids: [scenario.id] })
                        }
                        title={
                          scenario.id === HOTSEAT_SCENARIO_ID
                            ? "Choose the AI Hotseat starting conditions"
                            : `Deal only ${scenario.label}`
                        }
                      >
                        {scenario.id === HOTSEAT_SCENARIO_ID ? "Setup" : "Only"}
                      </button>
                    </li>
                  );
                })}
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
            onClick={() => (isPage ? onCancel?.() : setOpen(false))}
          >
            Cancel
          </button>
          <button
            type="button"
            className="scenario-picker-deal"
            disabled={!canDeal}
            onClick={() => deal(draft)}
          >
            {selectedCount === 1 ? "Deal this lesson" : "Deal from pool"}
          </button>
        </div>
      </div>
      {/*
        The one explanation the picker carries (user request 2026-11-22), under
        the controls in every view that hosts it: the 2D header's popover and the
        3D setup sheet's pool page.
      */}
      <p className="scenario-picker-footnote">
        * Scenarios from replays of AI self play matches
      </p>
    </div>
  );

  if (isPage) {
    return (
      <div className="scenario-picker scenario-picker--page" ref={containerRef}>
        {panel}
      </div>
    );
  }

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
      {open && panel}
    </div>
  );
};
