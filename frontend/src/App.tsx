import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { generate_puzzle, list_scenarios } from "riichiprac";
import { isCallDecision } from "./actions";
import { AGREEMENT_OPTIONS, formatAgreementNotice } from "./agreement";
import {
  CALL_DEMO_CASES,
  callDemoStartIndex,
  nextCallDemoIndex,
} from "./callDemo";
import {
  callButtonsFor,
  callContextFor,
  isCallActionType,
  NO_CALL_BUTTONS,
} from "./callChoices";
import { ActionBar } from "./components/ActionBar";
import { AppControls } from "./components/AppControls";
import { ExportImportControls } from "./components/ExportImportControls";
import type { ExportImportControlsProps } from "./components/ExportImportControls";
import { HandDock } from "./components/HandDock";
import { HotseatCard } from "./components/HotseatCard";
import { NextScenarioButton } from "./components/NextScenarioButton";
import { PhysicalTable } from "./components/PhysicalTable";
import { PlayerRow } from "./components/PlayerRow";
import { PositionDescriptionCard } from "./components/PositionDescriptionCard";
import { TableInfo } from "./components/TableInfo";
import { VerdictPanel } from "./components/VerdictPanel";
import { liftedHandRefs } from "./renderers/handOverlay";
import { RendererHost } from "./renderers/RendererHost";
import { ActionRail } from "./renderers/hud/ActionRail";
import { actionRailVisible } from "./renderers/hud/actionRail";
import type { ActionRailModel } from "./renderers/hud/actionRail";
import { HudLayer } from "./renderers/hud/HudLayer";
import { useMobileLayout } from "./renderers/hud/useMobileLayout";
import { useForcedLandscape } from "./renderers/useForcedLandscape";
import type { HudSheetContent } from "./renderers/hud/HudLayer";
import { ResultCard } from "./renderers/hud/ResultCard";
import { SetupSheet, SetupTrigger } from "./renderers/hud/SetupSheet";
import { HudToastStack } from "./renderers/hud/ToastStack";
import { VerdictSheet } from "./renderers/hud/VerdictSheet";
import { buildHudToasts } from "./renderers/hud/toastModel";
import {
  RENDERED3D_EXPOSED,
  probeCapabilities,
  threeViewUnavailableReason,
} from "./renderers/capabilities";
import { resolveTableMount } from "./renderers/resolveTableMount";
import { snapshotFromGameState, withPreviewRiichi } from "./renderers/snapshot";
import { exitFullscreenIfActive } from "./fullscreen";
import {
  DEFAULT_HOTSEAT_OPTIONS,
  HOTSEAT_SCENARIO_ID,
  hotseatOptionsJson,
  hotseatProgressLabel,
  isHotseatOnly,
} from "./hotseat";
import type { HotseatOptions, HotseatProgress } from "./hotseat";
import { downloadJson, readStateFile, serializeState } from "./stateFile";
import {
  ALL_SCENARIOS,
  FALLBACK_SCENARIOS,
  firstDealReplayOption,
  mergePackLessons,
  parseScenarioManifest,
  selectionPool,
} from "./scenarios";
import type {
  PackLessonSource,
  ScenarioOption,
  ScenarioSelection,
} from "./scenarios";
import {
  FIRST_DEAL_BUDGET_MS,
  fetchPackManifest,
  loadPack,
  pickUnseenPackScenario,
  withDeadline,
} from "./services/packLoader";
import type {
  PackManifest,
  PackManifestStatus,
  PackScenario,
} from "./services/packLoader";
import {
  SCENARIO_HISTORY_VERSION,
  ScenarioHistory,
  withoutAnswerState,
} from "./scenarioHistory";
import type { ScenarioSnapshot } from "./scenarioHistory";
import { stackOrder } from "./seatOrder";
import { pickUnseen } from "./session";
import { useGameStore } from "./store/useGameStore";
import { isTableView, useSettingsStore } from "./store/useSettingsStore";
import { outcomeTone } from "./types/verdict";
import { answerAnnouncement } from "./verdictText";
import { ensureWasmReady } from "./wasm";
import "./App.css";

/**
 * Whether the Mortal-agreement filter starts enabled. Kept as a named constant
 * because the first hand is dealt from this value rather than from the
 * checkbox state, so the two cannot drift.
 */
const DEFAULT_REQUIRE_AGREEMENT = true;

/**
 * Options for one deal.
 *
 * `forced` pins the lesson an AI Hotseat re-deal must keep. `bootstrap` marks
 * the first deal of a launch (RF4, strategy C in `replay-first-rollout.md`): it
 * waits — briefly — for the pack manifest and deals the most prominent covered
 * lesson's replay hand, so a cold launch opens replay-first instead of staying
 * generated until the next hand. Offline, slow, errored, uncovered, or with
 * `preferReplay` off, it deals the generated hand exactly as before.
 */
interface LoadPuzzleOptions {
  forced?: { category: string; hotseat?: HotseatOptions };
  bootstrap?: boolean;
}

/**
 * Load the pack a picker entry points at and choose one of its hands for that
 * lesson. The manifest is re-read from the ref so a pack that was unpublished
 * after the picker rendered fails with a clear message instead of a stale body.
 */
async function loadReplayScenario(
  manifest: PackManifest | null,
  source: PackLessonSource,
  seen: Set<string>,
): Promise<{ scenario: PackScenario; reset: boolean }> {
  const entry = manifest?.packs.find((pack) => pack.id === source.packId);
  if (!entry) {
    throw new Error(`Replay pack "${source.packId}" is no longer published.`);
  }
  const loaded = await loadPack(entry);
  return pickUnseenPackScenario(loaded, source.lessonId, seen);
}

export const App = () => {
  const gameState = useGameStore((state) => state.gameState);
  const isLoading = useGameStore((state) => state.isLoading);
  const error = useGameStore((state) => state.error);
  const pendingCall = useGameStore((state) => state.pendingCall);
  const callError = useGameStore((state) => state.callError);
  const callPreview = useGameStore((state) => state.callPreview);
  const submittedAnswer = useGameStore((state) => state.submittedAnswer);
  const dualGrade = useGameStore((state) => state.dualGrade);
  const resetAnswer = useGameStore((state) => state.resetAnswer);
  const peekedBeforeAnswer = useGameStore((state) => state.peekedBeforeAnswer);
  const peekMortal = useGameStore((state) => state.peekMortal);
  const loadFromJson = useGameStore((state) => state.loadFromJson);
  const loadFromAgreementJson = useGameStore(
    (state) => state.loadFromAgreementJson,
  );
  const mortalAgreement = useGameStore((state) => state.mortalAgreement);
  const beginCall = useGameStore((state) => state.beginCall);
  const cancelCall = useGameStore((state) => state.cancelCall);
  const previewCall = useGameStore((state) => state.previewCall);
  const selectTile = useGameStore((state) => state.selectTile);
  const submitAction = useGameStore((state) => state.submitAction);
  const reset = useGameStore((state) => state.reset);
  const setError = useGameStore((state) => state.setError);
  const aiStatus = useGameStore((state) => state.aiStatus);
  const aiError = useGameStore((state) => state.aiError);
  const evaluation = useGameStore((state) => state.evaluation);
  const isEvaluating = useGameStore((state) => state.isEvaluating);
  const initializeAi = useGameStore((state) => state.initializeAi);
  const evaluateWithAi = useGameStore((state) => state.evaluateWithAi);
  const fileError = useGameStore((state) => state.fileError);
  const fileNotice = useGameStore((state) => state.fileNotice);
  const positionDescription = useGameStore(
    (state) => state.positionDescription,
  );
  const importState = useGameStore((state) => state.importState);
  const setFileError = useGameStore((state) => state.setFileError);
  const setFileNotice = useGameStore((state) => state.setFileNotice);
  const clearFileNotice = useGameStore((state) => state.clearFileNotice);
  const clearPositionDescription = useGameStore(
    (state) => state.clearPositionDescription,
  );
  const restoreSnapshot = useGameStore((state) => state.restoreSnapshot);

  const [selection, setSelection] = useState<ScenarioSelection>(ALL_SCENARIOS);
  /**
   * The generated catalogue the WASM manifest publishes. Replay-pack entries are
   * merged on top in `scenarios` below; keeping the two apart means a late pack
   * manifest cannot lose the engine's metadata and vice versa.
   */
  const [wasmScenarios, setWasmScenarios] =
    useState<ScenarioOption[]>(FALLBACK_SCENARIOS);
  const [packManifest, setPackManifest] = useState<PackManifest | null>(null);
  const [packStatus, setPackStatus] = useState<PackManifestStatus>("loading");
  const [packError, setPackError] = useState<string | null>(null);
  const [packLoading, setPackLoading] = useState(false);
  /**
   * The first deal's bounded wait for replay (RF4). Separate from
   * `packLoading` because it starts before a lesson is known: the manifest may
   * still be arriving, and the deal has not chosen a pack yet.
   */
  const [firstDealLoading, setFirstDealLoading] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [agreementLoading, setAgreementLoading] = useState(false);
  const [hotseatLoading, setHotseatLoading] = useState(false);
  const [hotseatProgress, setHotseatProgress] =
    useState<HotseatProgress | null>(null);
  /**
   * The last AI Hotseat card choice. Kept in a ref as well as state: the
   * generator reads it without making `loadPuzzle` depend on it, so changing
   * an option cannot re-run the first-hand effect.
   */
  const [hotseatOptions, setHotseatOptions] = useState<HotseatOptions>(
    DEFAULT_HOTSEAT_OPTIONS,
  );
  const hotseatOptionsRef = useRef<HotseatOptions>(DEFAULT_HOTSEAT_OPTIONS);
  const [hotseatOpen, setHotseatOpen] = useState(false);
  /**
   * Per-session choice, on by default: deal book-graded hands only where Mortal
   * plays the book answer. A Mortal-only drill has no book answer, so the pool
   * keeps it and the drill is dealt as usual. Nothing persists this setting
   * (there is no localStorage/sessionStorage entry), so the default applies on
   * every fresh page load; a stored value never overrides it.
   */
  const [requireAgreement, setRequireAgreement] = useState(
    DEFAULT_REQUIRE_AGREEMENT,
  );
  /**
   * How the table is drawn, persisted across reloads. Switching it re-draws the
   * same hand; nothing is regenerated, so the answer and any submitted grade
   * stay put. It comes from the settings store rather than component state so
   * the header control and the table mount point cannot disagree after a
   * reload.
   */
  const tableView = useSettingsStore((state) => state.view);
  const setTableView = useSettingsStore((state) => state.setView);
  /**
   * Replay-first source preference (RF2), surfaced by the picker's source
   * filter (RF3). `loadPuzzle` snapshots it when a deal starts, so a change
   * applies to the next hand and can never re-run the first-hand effect.
   */
  const preferReplay = useSettingsStore((state) => state.preferReplay);
  const setPreferReplay = useSettingsStore((state) => state.setPreferReplay);
  const [exportDescription, setExportDescription] = useState("");
  /**
   * 3D-11: the notice the 3D host handed back when it degraded. Keeping it in
   * App means it survives the switch back to the standard table; the host's own
   * notice is unmounted with the scene.
   */
  const [threeNotice, setThreeNotice] = useState<string | null>(null);
  /**
   * 3D-11: once the host degrades, this session stops asking for 3D even if a
   * browser refused the URL cleanup. (The query flag is removed as well; this
   * state is the belt to that braces.)
   */
  const [threeClosed, setThreeClosed] = useState(false);
  /**
   * 3D-H3: how many rows the HUD's action rail wrapped to. The rail measures
   * itself (its height depends on the stage width and the control count) and
   * reports 1 or 2; `hudLayout()` turns that into the panel's 84/128 px.
   */
  const [actionRows, setActionRows] = useState<1 | 2>(1);
  /**
   * 3D-H5/H4: which HUD sheet is open. It is a view state, not game state:
   * opening or closing one never re-deals and never re-grades, a new hand
   * closes it, and at most one sheet exists at a time (`3d_hud.md` §6.5.8).
   */
  const [hudSheet, setHudSheet] = useState<"setup" | "verdict" | null>(null);
  /*
   * The setup sheet has two pages (2026-11-21): the settings list, and the
   * scenario pool, which needs the whole pane. Escape, a scrim tap or the
   * header's close step back one page before closing the sheet.
   */
  const [setupPage, setSetupPage] = useState<"settings" | "pool">("settings");
  const closeHudSheet = useCallback(() => {
    // Step back to the settings page first; the next close closes the sheet.
    if (hudSheet === "setup" && setupPage === "pool") {
      setSetupPage("settings");
      return;
    }
    setHudSheet(null);
  }, [hudSheet, setupPage]);
  /**
   * 3D-H2: the shell (the full-screen element, so the HUD travels with the
   * scene) and the fixed stage (made `inert` while a HUD sheet is open). Both
   * are refs on the 3D branch's own elements; the 2D views never see them.
   */
  const threeShellRef = useRef<HTMLDivElement>(null);
  const threeStageRef = useRef<HTMLElement>(null);
  /** The mobile HUD rules (2026-11-21): same device rule as the board. */
  const mobileLayout = useMobileLayout();
  /**
   * 2026-11-21: the 3D table is landscape-only. A phone held in portrait gets a
   * quarter-turn shell (see `useForcedLandscape`) instead of a portrait layout;
   * a player who wants portrait uses the stacked or top-down view.
   */
  const forcedLandscape = useForcedLandscape();
  /** The parsed WASM catalogue, so a repeat deal does not re-parse it. */
  const wasmCatalogRef = useRef<ScenarioOption[] | null>(null);
  /**
   * The latest pack manifest, mirrored synchronously for `loadPuzzle`: the deal
   * must see a manifest that arrived since the last render, and the fetch
   * resolves outside React's state updates.
   */
  const packManifestRef = useRef<PackManifest | null>(null);
  /**
   * The in-flight manifest fetch, mirrored for the first deal: RF4 awaits it
   * (bounded) so a cold launch can open with a replay hand. Every later deal
   * reads {@link packManifestRef} instead, so nothing waits on the network
   * mid-session.
   */
  const packManifestPromiseRef = useRef<Promise<PackManifest | null> | null>(
    null,
  );
  /**
   * Lesson/scenario ids already dealt this page session. Generated lessons and
   * each pack lesson get their own pool; an exhausted pool starts a new cycle
   * instead of repeating before its siblings have been shown. Nothing persists
   * across a reload, so "current session" is exactly this ref's lifetime.
   */
  const seenCategoriesRef = useRef<Set<string>>(new Set());
  const seenPackScenariosRef = useRef<Map<string, Set<string>>>(new Map());
  const loadRequestId = useRef(0);
  /**
   * `?preview=calls`: the review case currently on the board, or null when the
   * mode is off. Next hand advances it (2026-11-21 review aid); a deal that is
   * not Next (a settings change) re-loads the same case.
   */
  const callDemoIndexRef = useRef<number | null>(
    callDemoStartIndex(window.location.search),
  );
  /**
   * Mirrors `exportDescription` synchronously. A history snapshot is written in
   * the same tick a deal finishes, before React re-renders, so it cannot read
   * the state variable and must not fall back to the previous hand's text.
   */
  const exportDescriptionRef = useRef(exportDescription);
  const updateExportDescription = useCallback((text: string) => {
    exportDescriptionRef.current = text;
    setExportDescription(text);
  }, []);

  /**
   * The picker's catalogue: the generated lessons plus one opt-in entry per
   * replay lesson the manifest published. Recomputed when either side changes,
   * never re-deals the hand on screen.
   */
  const scenarios = useMemo(
    () => mergePackLessons(wasmScenarios, packManifest),
    [wasmScenarios, packManifest],
  );

  /** Browser Back/Forward bookkeeping; created once, outside React's state. */
  const historyRef = useRef<ScenarioHistory | null>(null);
  if (historyRef.current === null) {
    historyRef.current = new ScenarioHistory(window.history);
  }
  /**
   * The pool and filter the on-screen hand was actually dealt under. Kept in a
   * ref because the picker/checkbox may already show the *next* choice by the
   * time the current hand is recorded.
   */
  const loadedWithRef = useRef<{
    selection: ScenarioSelection;
    requireAgreement: boolean;
  }>({ selection: ALL_SCENARIOS, requireAgreement: DEFAULT_REQUIRE_AGREEMENT });

  /**
   * Everything needed to put the on-screen hand back, answer and all. Null when
   * no hand is showing (still loading, or the last deal failed).
   */
  const buildSnapshot = useCallback((): ScenarioSnapshot | null => {
    const state = useGameStore.getState();
    if (!state.gameState) return null;

    const { selection: drawnFrom, requireAgreement: drawnWith } =
      loadedWithRef.current;
    return {
      version: SCENARIO_HISTORY_VERSION,
      // The engine payload is stored as JSON rather than a seed: a restored hand
      // is then exactly this table, even after the generator changes.
      json: JSON.stringify(state.gameState),
      selection: drawnFrom,
      requireAgreement: drawnWith,
      submittedAnswer: state.submittedAnswer,
      dualGrade: state.dualGrade,
      peekedBeforeAnswer: state.peekedBeforeAnswer,
      evaluation: state.evaluation,
      mortalAgreement: state.mortalAgreement,
      positionDescription: state.positionDescription,
      exportDescription: exportDescriptionRef.current,
    };
  }, []);

  /** Record the hand now on screen as one browser history entry. */
  const commitHistory = useCallback(() => {
    const snapshot = buildSnapshot();
    if (snapshot) {
      historyRef.current?.commit(snapshot);
    }
  }, [buildSnapshot]);

  const loadPuzzle = useCallback(
    async (
      scenarioSelection: ScenarioSelection,
      requireMortalAgreement: boolean,
      dealOptions?: LoadPuzzleOptions,
    ) => {
      const requestId = ++loadRequestId.current;
      reset();
      // A superseded deal owns the table now; its own status must not keep the
      // first deal's replay wait on screen (RF4).
      setFirstDealLoading(false);
      setHotseatProgress(null);
      // A description belongs to the position it was written for.
      updateExportDescription("");

      // What the hand about to load is drawn under. The agreement filter can
      // switch itself off below when Mortal is unavailable; the snapshot has to
      // carry the value that was actually in effect.
      let effectiveAgreement = requireMortalAgreement;

      /**
       * Replay-first inputs, snapshotted when the deal starts.
       *
       * A pack manifest that arrives mid-deal therefore applies to the next
       * hand, not this one — except for the first deal of a launch, which
       * deliberately waits for the manifest (RF4). Reading the setting here
       * instead of through a hook keeps `loadPuzzle` stable, so changing it can
       * never re-run the first-hand effect.
       */
      const replayDefaults = {
        manifest: packManifestRef.current,
        preferReplay: useSettingsStore.getState().preferReplay,
      };

      /**
       * Install a freshly generated hand and give it its own history entry. A
       * superseded load must neither replace the table nor touch the history, so
       * both are gated on still being the newest request.
       */
      const finish = (load: () => void) => {
        if (requestId !== loadRequestId.current) return;
        loadedWithRef.current = {
          selection: scenarioSelection,
          requireAgreement: effectiveAgreement,
        };
        load();
        commitHistory();
      };

      try {
        await ensureWasmReady();
        if (requestId !== loadRequestId.current) return;

        /*
         * The call review set: a query-gated sequence of crafted positions the
         * Next hand control walks. It bypasses replay/generation entirely so
         * the review starts instantly and every case is one tap away. Wasm is
         * already ready here, so a Riichi hover can ask the engine for its
         * legal discards on the first pointer move.
         */
        if (callDemoIndexRef.current !== null) {
          const demo =
            CALL_DEMO_CASES[callDemoIndexRef.current % CALL_DEMO_CASES.length];
          finish(() => loadFromJson(JSON.stringify(demo.state)));
          return;
        }

        if (!wasmCatalogRef.current) {
          const manifest = parseScenarioManifest(list_scenarios());
          wasmCatalogRef.current =
            manifest.length > 0 ? manifest : FALLBACK_SCENARIOS;
          if (manifest.length > 0) {
            setWasmScenarios(manifest);
          }
        }

        // RF4 (strategy C): the first deal of a launch opens replay-first. The
        // manifest fetch is already in flight — its effect runs before this one
        // — so awaiting it usually costs one small same-origin request, and the
        // body that follows is content-addressed and cached. Both phases are
        // bounded, and every failure falls through to the generated pool below.
        let bootstrapOption: ScenarioOption | null = null;
        if (
          dealOptions?.bootstrap &&
          scenarioSelection.kind === "all" &&
          replayDefaults.preferReplay
        ) {
          setFirstDealLoading(true);
          try {
            const manifest =
              replayDefaults.manifest ??
              (await withDeadline(
                packManifestPromiseRef.current ?? Promise.resolve(null),
                FIRST_DEAL_BUDGET_MS,
                "the replay pack manifest",
              ));
            if (requestId !== loadRequestId.current) return;
            if (manifest) replayDefaults.manifest = manifest;
            // "Prominent covered section": the covered lesson with the most
            // reviewed bases, in book order on a tie (scenarios.ts).
            bootstrapOption = firstDealReplayOption(
              mergePackLessons(
                wasmCatalogRef.current ?? FALLBACK_SCENARIOS,
                replayDefaults.manifest,
              ),
              replayDefaults,
            );
          } catch {
            // Offline, slow, or not published: no first replay hand. The
            // generated pool deals this hand exactly as it did before RF4.
            bootstrapOption = null;
          } finally {
            if (requestId === loadRequestId.current) setFirstDealLoading(false);
          }
        }

        // The deal sees the same manifest snapshot the pool was built from, so
        // a manifest that arrives mid-deal cannot add a row the pool never
        // considered (or vice versa).
        const options = mergePackLessons(
          wasmCatalogRef.current ?? FALLBACK_SCENARIOS,
          replayDefaults.manifest,
        );
        // Replay-first: a lesson whose shipped pack covers it is drawn from
        // replay, every other lesson keeps its generated drill. With no
        // manifest this is exactly the generated pool as before.
        let category =
          bootstrapOption?.id ??
          dealOptions?.forced?.category ??
          pickUnseen(
            selectionPool(
              options,
              scenarioSelection,
              useGameStore.getState().aiStatus === "ready",
              replayDefaults,
            ),
            (entry) => entry.id,
            seenCategoriesRef.current,
          ).value.id;
        let option = options.find((entry) => entry.id === category) ?? null;
        // A bootstrap hand is a real pick: keep the session's unseen guard in
        // step with it, exactly as `pickUnseen` would.
        if (bootstrapOption) seenCategoriesRef.current.add(category);

        // A replay lesson ships its own complete state, so it is laid out with
        // the same `loadFromJson` path as an imported position: verified bytes
        // only, no generation and no Mortal-agreement sampling.
        if (option?.pack) {
          const replayPack = option.pack;
          setPackLoading(true);
          try {
            const seenKey = `${replayPack.packId}:${replayPack.lessonId}`;
            let seen = seenPackScenariosRef.current.get(seenKey);
            if (!seen) {
              seen = new Set<string>();
              seenPackScenariosRef.current.set(seenKey, seen);
            }
            const replayLoad = loadReplayScenario(
              replayDefaults.manifest ?? packManifestRef.current,
              replayPack,
              seen,
            );
            // The first deal's body gets the same budget as its manifest wait:
            // a body that never arrives deals the generated sibling instead of
            // holding the launch. The losing load still fills the cache.
            const picked = dealOptions?.bootstrap
              ? await withDeadline(
                  replayLoad,
                  FIRST_DEAL_BUDGET_MS,
                  "the first replay hand",
                )
              : await replayLoad;
            if (requestId !== loadRequestId.current) return;
            setPackError(null);
            finish(() => loadFromJson(JSON.stringify(picked.scenario.state)));
            return;
          } catch (err) {
            if (requestId !== loadRequestId.current) return;
            // A replay body can fail (offline, a stale cache, an integrity
            // miss). Replay-first must never strand the deal on it: deal the
            // same lesson's generated drill for this hand and leave the note in
            // the picker explaining why. Only a pack-only lesson (no generated
            // sibling) surfaces the error.
            const generated = options.find(
              (entry) => !entry.pack && entry.id === replayPack.lessonId,
            );
            if (!generated) throw err;
            setPackError(
              `Replay pack "${replayPack.packId}" could not be delivered; dealing the generated lesson instead.`,
            );
            category = generated.id;
            option = generated;
          } finally {
            // A newer deal owns the status line; it set its own flag.
            if (requestId === loadRequestId.current) {
              setPackLoading(false);
            }
          }
        }

        const requiresAi = option?.requires_ai === true;
        // The AI drill's answer is Mortal's own argmax, so the agreement filter
        // is meaningless there; that scenario is generated below instead.
        const wantsAgreement = requireMortalAgreement && !requiresAi;

        if (requiresAi) {
          setAiLoading(true);
          try {
            await initializeAi();
            if (requestId !== loadRequestId.current) return;
            const mortal = useGameStore.getState().mortal;
            if (!mortal) {
              throw new Error(
                useGameStore.getState().aiError ??
                  "Mortal AI is unavailable; cannot generate this scenario.",
              );
            }
            // Let the loading state paint before the worker starts.
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 0);
            });
            if (requestId !== loadRequestId.current) return;
            let generated: string;
            if (category === HOTSEAT_SCENARIO_ID) {
              // A full round of Mortal self-play: the generation card's options
              // decide the starting table, and the engine inserts the player at
              // one of that seat's real decisions.
              setHotseatLoading(true);
              const hotseat =
                dealOptions?.forced?.hotseat ?? hotseatOptionsRef.current;
              generated = await mortal.generateHotseatPuzzle(
                hotseatOptionsJson(hotseat),
                (progress) => {
                  if (requestId === loadRequestId.current) {
                    setHotseatProgress(progress);
                  }
                },
              );
            } else {
              throw new Error(
                `No evaluator-backed generator is registered for ${category}.`,
              );
            }
            if (requestId !== loadRequestId.current) return;
            finish(() => loadFromJson(generated));
          } finally {
            setAiLoading(false);
            setHotseatLoading(false);
            setHotseatProgress(null);
          }
        } else if (wantsAgreement) {
          setAgreementLoading(true);
          try {
            await initializeAi();
            if (requestId !== loadRequestId.current) return;
            const mortal = useGameStore.getState().mortal;
            if (!mortal) {
              // The default is on, but a browser without the weights must still
              // get a table: deal the ordinary book-graded hand and clear the
              // checkbox, which is disabled while Mortal is unavailable and
              // would otherwise claim a filter that cannot run.
              setRequireAgreement(false);
              effectiveAgreement = false;
              finish(() => loadFromJson(generate_puzzle(category)));
              return;
            }
            // Let the loading state paint before the worker starts sampling.
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 0);
            });
            if (requestId !== loadRequestId.current) return;
            const sampled = await mortal.generatePuzzleWithAgreement(
              category,
              JSON.stringify(AGREEMENT_OPTIONS),
            );
            if (requestId !== loadRequestId.current) return;
            finish(() => loadFromAgreementJson(sampled));
          } finally {
            setAgreementLoading(false);
          }
        } else {
          finish(() => loadFromJson(generate_puzzle(category)));
        }
      } catch (err) {
        if (requestId !== loadRequestId.current) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [
      commitHistory,
      initializeAi,
      loadFromAgreementJson,
      loadFromJson,
      reset,
      setError,
      updateExportDescription,
    ],
  );

  /**
   * Put a history entry's hand back on screen, unanswered.
   *
   * Back/Forward is "show me that table again", not "show me the answer again":
   * the stored snapshot's answer, verdict, peek, evaluation and armed toggles
   * are stripped before the store sees it, so the hand comes back answerable
   * without a re-deal. The table JSON itself is untouched.
   */
  const restoreHistoryEntry = useCallback(
    (snapshot: ScenarioSnapshot) => {
      loadedWithRef.current = {
        selection: snapshot.selection,
        requireAgreement: snapshot.requireAgreement,
      };
      setSelection(snapshot.selection);
      setRequireAgreement(snapshot.requireAgreement);
      updateExportDescription(snapshot.exportDescription);
      restoreSnapshot(withoutAnswerState(snapshot));
    },
    [restoreSnapshot, updateExportDescription],
  );

  // The popstate listener is registered once; look the current callback up
  // through a ref so it never has to be torn down and re-added.
  const restoreHistoryRef = useRef(restoreHistoryEntry);
  restoreHistoryRef.current = restoreHistoryEntry;

  /**
   * Back/Forward. The browser has already moved to the entry by the time this
   * fires, so the only job is to put that entry's hand back on screen.
   */
  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      const snapshot = historyRef.current?.adopt(event.state) ?? null;
      // An entry this app did not write (a foreign same-document navigation):
      // leave the table alone, and let the next deal replace the entry.
      if (!snapshot) return;

      // Drop any deal still running; it belongs to the hand being left behind.
      loadRequestId.current += 1;
      setAiLoading(false);
      setAgreementLoading(false);
      setHotseatLoading(false);
      setHotseatProgress(null);
      restoreHistoryRef.current(snapshot);
    };

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  /**
   * Keep the current entry's snapshot matching the screen. Answering, peeking,
   * arming Riichi, or editing the export note all land here, so the entry keeps
   * the same table and note. The answer state is recorded too but Back/Forward
   * strips it on restore, so it is never brought back as a finished answer.
   */
  useEffect(() => {
    const snapshot = buildSnapshot();
    if (snapshot) {
      historyRef.current?.update(snapshot);
    }
  }, [
    buildSnapshot,
    gameState,
    submittedAnswer,
    dualGrade,
    peekedBeforeAnswer,
    evaluation,
    mortalAgreement,
    positionDescription,
    exportDescription,
  ]);

  /**
   * Fetch the replay-pack manifest on first paint.
   *
   * It is the only pack metadata a launch needs, and it drives coverage in the
   * picker. The promise is mirrored in a ref because the first deal awaits it
   * (RF4) instead of racing it: `loadPuzzle`'s `bootstrap` path settles for
   * whatever arrives within its budget. The content-addressed bodies stay
   * lazy, fetched by `loadPuzzle` when a replay lesson is actually dealt.
   */
  useEffect(() => {
    let cancelled = false;
    setPackStatus("loading");

    const manifestLoad = fetchPackManifest()
      .then((manifest) => {
        if (!cancelled) {
          packManifestRef.current = manifest;
          setPackManifest(manifest);
          setPackError(null);
          setPackStatus(manifest.packs.length > 0 ? "ready" : "empty");
        }
        return manifest;
      })
      .catch((err) => {
        if (!cancelled) {
          // A missing manifest must not break generated lessons: keep the pool
          // and tell the picker. A reload retries the fetch.
          packManifestRef.current = null;
          setPackManifest(null);
          setPackError(err instanceof Error ? err.message : String(err));
          setPackStatus("error");
        }
        return null;
      });
    packManifestPromiseRef.current = manifestLoad;

    return () => {
      cancelled = true;
    };
  }, []);

  // The filter is on by default, so the first hand is dealt through it too.
  // `loadPuzzle` falls back to a book-only deal when Mortal cannot load.
  //
  // RF4: the first deal is also the replay-first deal. It waits (briefly) for
  // the manifest effect above and deals a covered lesson's replay hand; with no
  // pack, no coverage, `preferReplay` off or a slow/failed fetch it deals the
  // generated hand exactly as before.
  useEffect(() => {
    void loadPuzzle(ALL_SCENARIOS, DEFAULT_REQUIRE_AGREEMENT, {
      bootstrap: true,
    });
  }, [loadPuzzle]);

  // Start loading the Mortal weights in the background on first paint.
  useEffect(() => {
    void initializeAi();
  }, [initializeAi]);

  const handleSelectionChange = (next: ScenarioSelection) => {
    // A deal started from the setup sheet closes it first, so the new hand
    // arrives on the board rather than behind the modal (`3d_hud.md` §3, row 12).
    setHudSheet(null);
    setSelection(next);
    void loadPuzzle(next, requireAgreement);
  };

  const handleNextScenario = () => {
    // A hotseat hand is re-dealt with the same card choice; a mixed pool keeps
    // drawing normally, and a hotseat drawn from it uses the last choice.
    setHudSheet(null);
    // Review mode: Next walks the crafted call cases.
    if (callDemoIndexRef.current !== null) {
      callDemoIndexRef.current = nextCallDemoIndex(callDemoIndexRef.current);
    }
    const forced = isHotseatOnly(selection)
      ? {
          category: HOTSEAT_SCENARIO_ID,
          hotseat: hotseatOptionsRef.current,
        }
      : undefined;
    void loadPuzzle(selection, requireAgreement, { forced });
  };

  /** Open the generation card without generating anything yet. */
  const handleConfigureHotseat = () => {
    setHotseatOpen(true);
  };

  /** Run the card's chosen self-play round. */
  const handleGenerateHotseat = (options: HotseatOptions) => {
    // The sheet closes before the round is played: generation reports through a
    // toast, and the new hand should land on the board (`3d_hud.md` §3, row 27).
    setHudSheet(null);
    hotseatOptionsRef.current = options;
    setHotseatOptions(options);
    setHotseatOpen(false);
    const next: ScenarioSelection = {
      kind: "selected",
      ids: [HOTSEAT_SCENARIO_ID],
    };
    setSelection(next);
    void loadPuzzle(next, requireAgreement, {
      forced: { category: HOTSEAT_SCENARIO_ID, hotseat: options },
    });
  };

  const handleAgreementChange = (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.target.checked;
    setRequireAgreement(next);
    // Apply the setting to the hand on screen, not just the next one.
    void loadPuzzle(selection, next);
  };

  const handleViewChange = (event: ChangeEvent<HTMLSelectElement>) => {
    // Redraw only: the persisted setting changes how the same hand is drawn,
    // nothing about the hand or its grade.
    const next = event.target.value;
    if (!isTableView(next)) return;
    setTableView(next);
    // 3D-14: an explicit 3D choice is a fresh request, so it clears the
    // session close a degrade left behind instead of being silently ignored.
    // The host still refuses to *auto*-retry a degraded tier (3D-11).
    if (next === "rendered3d") setThreeClosed(false);
  };

  const showVerdict = useCallback(() => {
    const panel = document.getElementById("verdict-panel");
    if (!panel) return;
    // The header is sticky and its height follows the type scale and the width
    // at which its controls wrap, so offset by the height measured right now: a
    // fixed scroll margin hid the top of the panel behind it on phones.
    const header = document.querySelector<HTMLElement>(".app-header");
    const offset = (header?.offsetHeight ?? 0) + 12;
    window.scrollTo({
      top: panel.getBoundingClientRect().top + window.scrollY - offset,
      behavior: "smooth",
    });
    panel.focus({ preventScroll: true });
  }, []);

  // The 2D panel and the 3D verdict sheet share one Retry: the model load and
  // the evaluation request, never a re-grade of the submitted answer.
  const retryMortalEvaluation = useCallback(() => {
    void initializeAi().then(() => evaluateWithAi());
  }, [initializeAi, evaluateWithAi]);

  const handleExport = () => {
    if (!gameState) return;

    const { filename, json } = serializeState(gameState, exportDescription);
    downloadJson(filename, json);
    setFileError(null);
    setFileNotice(`Exported ${filename}`);
  };

  const handleImportFile = async (file: File) => {
    setFileError(null);
    try {
      const text = await readStateFile(file);
      // Cancel any generation that is still waiting on WASM initialization so
      // a late puzzle cannot overwrite the imported table.
      loadRequestId.current += 1;
      await importState(text);
      const imported = useGameStore.getState();
      if (!imported.fileError) {
        // Seed the export field so re-exporting keeps the file's description.
        updateExportDescription(imported.positionDescription ?? "");
        // An imported position is a hand like any other: it gets its own entry,
        // so Back returns to the hand it replaced.
        commitHistory();
      }
    } catch (err) {
      setFileError(err instanceof Error ? err.message : String(err));
    }
  };

  // The human is anchored at the bottom (just above the hand dock); the other
  // seats stack above it in turn order. See `stackOrder`. The top-down view
  // anchors the same way, with the seats placed round the table instead.
  const orderedPlayers = gameState ? stackOrder(gameState.players) : [];

  const humanPlayer =
    gameState?.players.find((player) => player.is_human) ?? null;

  const aiDecision = gameState?.ai_decision ?? null;
  const availableActions = aiDecision?.actions ?? [];
  const isDrill = gameState?.correct_action.type === "best";
  // A book call lesson answers through its call/Pass buttons, never a discard.
  const isCallLesson = gameState ? isCallDecision(gameState) : false;
  const canDiscard = isCallLesson
    ? false
    : isDrill
      ? availableActions.some((action) => action.type === "discard")
      : true;
  const decision = gameState?.decision;
  const claimedFrom =
    decision?.kind === "react_to_discard" ? decision.from : null;

  /*
   * 3D-H3: the hand's call state, derived once for both shells.
   *
   * The shared `CallControls` bar renders in the 2D dock and the HUD's action
   * rail from this one model, so the two views cannot disagree about which
   * calls exist. Calls are plain buttons: pressing one either submits the call
   * (one legal way to make it) or opens a pick step in the store, whose tiles
   * come from whichever hand surface is on screen.
   */
  const callContext = gameState
    ? callContextFor(gameState)
    : { isDrill: false, availableActions: [] };
  const callButtons =
    gameState && humanPlayer
      ? callButtonsFor(gameState, humanPlayer, callContext)
      : NO_CALL_BUTTONS;

  // The AI drill's non-call actions stay in the ActionBar; calls moved to the
  // shared call bar, so a drill never renders two controls for one action.
  const actionBarActions = availableActions.filter(
    (action) => !isCallActionType(action.type),
  );

  const answered = dualGrade !== null;
  const revealMortal = answered || peekedBeforeAnswer;

  /*
   * 3D-14: whether this browser can run the 3D table.
   *
   * Since the user's 2026-11-20 decision the 3D table is the default and the
   * View control always offers it (exposed), so the answer always matters: probe
   * once per page, not once per 2D visit. The probe releases the WebGL2 context
   * it creates immediately (3D-01), so this costs one context per load. `null`
   * means "can run"; otherwise this is the reason the View control shows and
   * what makes the mount fall back to the stacked table.
   */
  const threeUnavailableReason = useMemo(
    () => threeViewUnavailableReason(probeCapabilities()),
    [],
  );

  /*
   * The 3D table is the default (user request 2026-11-20, superseding decision
   * D13's "opt-in, never default"). The resolver owns the precedence — explicit
   * query, then the chosen view, then the store's default — so App only mounts
   * what it says.
   *
   * A chosen 3D view mounts only while it can run: after a degrade
   * (`threeClosed`, 3D-11) or without WebGL2 the resolver returns the stacked
   * table, and the store keeps the player's choice untouched (3D-14), so the
   * next capable load opens 3D again.
   */
  const tableMount = resolveTableMount(
    threeClosed ? "" : window.location.search,
    tableView,
    {
      allowThreeView: !threeClosed && threeUnavailableReason === null,
    },
  );

  /*
   * 3D-14: the full-window stage is reversible. The FullscreenButton stays
   * unmounted until the HUD shell lands (3D-H2), but the stage may already be
   * in full screen — from that toggle, a future HUD control, or the browser
   * restoring a session. Leaving the 3D view therefore always leaves full
   * screen, so the user is never stranded in a full-screen 2D layout.
   */
  const showingThree = tableMount.kind === "three";
  const wasShowingThree = useRef(false);
  useEffect(() => {
    if (wasShowingThree.current && !showingThree) exitFullscreenIfActive();
    wasShowingThree.current = showingThree;
  }, [showingThree]);

  /*
   * 3D-H5: the verdict sheet describes the hand it was opened on, so a new deal
   * closes it, and so does leaving the 3D view. This is presentation state only:
   * neither transition touches the deal or the grade.
   *
   * 3D-H4 gives the setup sheet the same rule: a deal started from the sheet
   * (a pool deal, a hotseat round, an agreement re-deal) closes it, so the new
   * hand arrives on the board rather than behind the modal.
   */
  useEffect(() => {
    setHudSheet(null);
  }, [gameState]);
  useEffect(() => {
    if (!showingThree) setHudSheet(null);
  }, [showingThree]);

  /*
   * 3D-11: the scene closed itself because even `compat` could not hold 30 fps.
   * The host has already stored the session memo; App's job is to return to the
   * previously selected view and keep the explanation visible (a notice the
   * user can dismiss). Removing `renderer=3d` from the URL makes the switch
   * real, so the next render resolves the stored view and the standard shell.
   */
  const handleThreeDegraded = useCallback((message: string) => {
    setThreeNotice(message);
    setThreeClosed(true);
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("renderer");
      window.history.replaceState(window.history.state, "", url);
    } catch {
      // A browser that refuses history still gets the notice and the session
      // memo; `threeClosed` keeps this session on the standard view.
    }
  }, []);

  /*
   * The 3D snapshot's `revision` identifies a *position*, not a move: it is
   * bumped whenever the store replaces `gameState`, so the renderer treats
   * every new hand as a cut rather than animating a diff between two scenarios
   * (plan §2.3). This is the only per-deal state the 3D chain adds to App.
   */
  const threeRevisionRef = useRef(0);
  const [threeRevision, setThreeRevision] = useState(0);
  const bumpThreeRevision = useCallback(() => {
    threeRevisionRef.current += 1;
    setThreeRevision(threeRevisionRef.current);
  }, []);
  useEffect(() => {
    // Only the opt-in 3D view pays for this: the standard views never read a
    // revision, so they must not re-render because of one.
    if (!gameState || tableMount.kind !== "three") return;
    bumpThreeRevision();
  }, [gameState, tableMount.kind, bumpThreeRevision]);

  /*
   * `?preview=sticks` (3D-09) is a visual-review aid, not game state: it marks
   * every seat riichi on the 3D table's copy only, so the per-seat felt sticks
   * and compass markers can be inspected on any hand. The store, the 2D views
   * and the answer never see it.
   *
   * `?preview=deal` (3D-12) was the deal-in's review aid. It is retired here
   * (3D-H2): the HUD's top bar now mounts the real Next Scenario control over
   * the scene, so a new deal — and therefore the bounded deal-in — is one tap
   * away without a query flag (task note 2026-11-19T21:29).
   */
  const previewSticks =
    tableMount.kind === "three" && tableMount.query.preview === "sticks";

  const threeSnapshot = useMemo(() => {
    if (!gameState || tableMount.kind !== "three") return null;
    try {
      const snapshot = snapshotFromGameState(
        gameState,
        threeRevision,
        submittedAnswer !== null,
      );
      return previewSticks ? withPreviewRiichi(snapshot) : snapshot;
    } catch {
      // A state the adapter refuses to describe is not drawn in 3D; the
      // standard view still renders below, so nothing takes the app down.
      return null;
    }
  }, [
    gameState,
    tableMount.kind,
    threeRevision,
    submittedAnswer,
    previewSticks,
  ]);

  /*
   * 2026-11-21: the call preview (hover/focus on a call button) or the open
   * pick's selected tiles are raised together in the 3D hand. The store names
   * them as copies; the renderer speaks in seat/zone/slot, so map them through
   * the same snapshot the projected buttons use.
   */
  const liftedCopies = pendingCall?.picks ?? callPreview;
  const liftedTiles = useMemo(
    () => (threeSnapshot ? liftedHandRefs(threeSnapshot, liftedCopies) : []),
    [threeSnapshot, liftedCopies],
  );

  const agreementHint =
    aiStatus === "ready"
      ? "Deal book-graded hands only when the embedded Mortal model plays the book answer."
      : aiStatus === "error"
        ? "Mortal is unavailable, so this filter cannot run."
        : "Waiting for the Mortal model to load…";

  /*
   * No view explanation (user request 2026-11-22): the choice names itself, and
   * the paragraphs about how each view draws the table were noise in both
   * shells. The control keeps its label and its own option names.
   */
  const viewHint = "";

  const statusMessage = hotseatLoading
    ? hotseatProgressLabel(hotseatProgress)
    : firstDealLoading
      ? "Loading a replay position…"
      : agreementLoading
        ? "Finding a hand Mortal agrees with…"
        : aiLoading
          ? "Asking Mortal…"
          : packLoading
            ? "Loading replay pack…"
            : isLoading
              ? "Loading table…"
              : null;

  /*
   * 3D-H3: the floating HUD's practice content. Each piece is built here and
   * handed to `HudLayer`'s slot, so the 3D mount is a composition of elements
   * rather than a second copy of the 2D shell. Handlers are the store's own
   * (`selectTile` reaches the scene through 3D-08), so the answer path has no
   * renderer dependency.
   */
  const actionRailModel: ActionRailModel = {
    actions: actionBarActions,
    callButtons,
    pendingCall,
    callError,
    answered,
    evaluation,
    revealMortal,
    onBeginCall: beginCall,
    onPass: () => submitAction({ action: "Pass" }),
    onCancelCall: cancelCall,
    onPreviewCall: previewCall,
    onAction: submitAction,
  };

  // No call/action controls means no pre-answer chrome at all: the call row is
  // unmounted, not reserved (3d_hud.md §7.1). After an answer the result card
  // takes over; the HUD never shows a panel before one.
  const hudCallBar = actionRailVisible(actionRailModel) ? (
    <ActionRail model={actionRailModel} onRowsChange={setActionRows} />
  ) : undefined;

  /*
   * 3D-H5: after an answer the panel becomes the fixed 104 px result card. It
   * replaces both rows (the rail is already gone) and never expands on its own;
   * Details opens the verdict sheet, and nothing else in the 3D view does.
   */
  const hudResultCard =
    answered && dualGrade && gameState ? (
      <ResultCard
        grade={dualGrade}
        state={gameState}
        onDetails={() => setHudSheet("verdict")}
        onNext={handleNextScenario}
        nextDisabled={isLoading}
        onReset={resetAnswer}
      />
    ) : undefined;
  // The outcome's green/amber/red is the result panel's outline, not an inner
  // box's, so the card's buttons never sit on it (user request 2026-11-20).
  const hudResultTone =
    answered && dualGrade ? outcomeTone(dualGrade.outcome) : undefined;

  /*
   * The one HUD sheet (H2's primitive): the full 2D verdict panel, pre-answer
   * (status + Peek + Retry) and post-answer (grade columns, ranking, call
   * report, explanation). It reads the store's existing state, so opening it is
   * not a deal and not a re-evaluation.
   */
  const hudVerdictSheet: HudSheetContent | null =
    hudSheet === "verdict" && gameState
      ? {
          title: "Verdict",
          body: (
            <VerdictSheet
              state={gameState}
              grade={dualGrade}
              evaluation={evaluation}
              aiStatus={aiStatus}
              aiError={aiError}
              isEvaluating={isEvaluating}
              peeked={peekedBeforeAnswer}
              redFives={humanPlayer?.red_fives ?? []}
              onPeek={peekMortal}
              onRetry={retryMortalEvaluation}
            />
          ),
          actions: (
            <NextScenarioButton
              onClick={() => {
                // Close first so the deal is not read as a sheet re-evaluation,
                // and the player sees the new hand arrive.
                setHudSheet(null);
                handleNextScenario();
              }}
              disabled={isLoading}
            />
          ),
        }
      : null;

  /*
   * 3D-H4's setup sheet is built below, after the 2D blocks it re-hosts (the
   * export/import controls, the table information and the notes) are defined.
   */

  /*
   * The result's announcement. `HudLayer` owns the one persistent live region,
   * so this string changes once when the answer lands; the card coming and
   * going with the sheet does not re-announce it.
   */
  const hudAnnouncement =
    answered && dualGrade ? answerAnnouncement(dualGrade) : "";

  const hudToasts = buildHudToasts({
    statusMessage,
    error,
    fileError,
    fileNotice,
    positionDescription,
    onDismissNotice: clearFileNotice,
    onDismissDescription: clearPositionDescription,
    // The toast carries the first line; the sheet holds the full text (§3, 32).
    onOpenPositionDescription: () => setHudSheet("setup"),
  });

  // The header controls, built once so the stacked and top-down layouts cannot
  // drift apart.
  const controls = (
    <AppControls
      scenarios={scenarios}
      selection={selection}
      onSelectionChange={handleSelectionChange}
      onConfigureHotseat={handleConfigureHotseat}
      packStatus={packStatus}
      packCount={packManifest?.packs.length ?? 0}
      packError={packError}
      preferReplay={preferReplay}
      onPreferReplayChange={setPreferReplay}
      requireAgreement={requireAgreement}
      aiStatus={aiStatus}
      agreementHint={agreementHint}
      onAgreementChange={handleAgreementChange}
      tableView={tableView}
      viewHint={viewHint}
      onViewChange={handleViewChange}
      rendered3dExposed={RENDERED3D_EXPOSED}
      threeUnavailableReason={threeUnavailableReason}
      onNextScenario={handleNextScenario}
      nextDisabled={isLoading}
    />
  );

  /*
   * The export/import block, as both shells render it: the 2D header mounts the
   * element, the 3D setup sheet takes the same props for its "Position"
   * section. One props object is what keeps the two from drifting.
   */
  const exportImportProps: ExportImportControlsProps = {
    canExport: Boolean(gameState),
    description: exportDescription,
    onDescriptionChange: updateExportDescription,
    fileError,
    fileNotice,
    onExport: handleExport,
    onImportFile: handleImportFile,
    onDismissNotice: clearFileNotice,
  };

  const exportImportControls = <ExportImportControls {...exportImportProps} />;

  const positionDescriptionCard = positionDescription ? (
    <PositionDescriptionCard
      description={positionDescription}
      onDismiss={clearPositionDescription}
    />
  ) : null;

  const tableInformation = gameState ? <TableInfo state={gameState} /> : null;

  const agreementNotice =
    gameState && mortalAgreement ? (
      <p className="agreement-note" role="status">
        {formatAgreementNotice(
          mortalAgreement,
          // A non-empty `equivalent_tiles` means the lesson accepts more
          // than the canonical answer, so Mortal only has to match one.
          (gameState.equivalent_tiles?.length ?? 0) > 0,
          // The pinned situation names the condition the hand was built to
          // isolate, which is the question the drill asks. It stays hidden
          // until the answer is on screen, exactly like Mortal's own choice.
          dualGrade !== null || peekedBeforeAnswer,
        )}
      </p>
    ) : null;

  const scenarioNote = gameState?.scenario_note ? (
    <p className="scenario-note">{gameState.scenario_note}</p>
  ) : null;

  /*
   * 3D-H4: the setup sheet. One front door (the top bar's Setup trigger) opens
   * it; its body is the pool, the AI Hotseat form, the settings, the position
   * controls and the table information. It is mounted only while selected, so
   * opening and closing it is a view change: the same `gameState` object stays
   * on the table, nothing re-deals, and the scene is never unmounted.
   */
  const hudSetupSheet: HudSheetContent | null =
    hudSheet === "setup"
      ? {
          title: setupPage === "pool" ? "Scenario pool" : "Setup",
          body: (
            <SetupSheet
              page={setupPage}
              onNavigatePool={() => setSetupPage("pool")}
              onBackToSettings={() => setSetupPage("settings")}
              scenarios={scenarios}
              selection={selection}
              onSelectionChange={handleSelectionChange}
              packStatus={packStatus}
              packCount={packManifest?.packs.length ?? 0}
              packError={packError}
              preferReplay={preferReplay}
              onPreferReplayChange={setPreferReplay}
              hotseatOptions={hotseatOptions}
              hotseatBusy={isLoading || aiLoading}
              onGenerateHotseat={handleGenerateHotseat}
              requireAgreement={requireAgreement}
              aiStatus={aiStatus}
              agreementHint={agreementHint}
              onAgreementChange={handleAgreementChange}
              tableView={tableView}
              viewHint={viewHint}
              onViewChange={handleViewChange}
              rendered3dExposed={RENDERED3D_EXPOSED}
              threeUnavailableReason={threeUnavailableReason}
              exportImport={exportImportProps}
              tableInfo={tableInformation}
              notes={
                agreementNotice || scenarioNote ? (
                  <>
                    {agreementNotice}
                    {scenarioNote}
                  </>
                ) : undefined
              }
              positionNote={positionDescriptionCard}
            />
          ),
        }
      : null;

  /** The one open sheet: at most one exists at a time (§6.5.8). */
  const hudOpenSheet = hudSheet === "verdict" ? hudVerdictSheet : hudSetupSheet;

  const verdictPanel = gameState ? (
    <VerdictPanel
      state={gameState}
      grade={dualGrade}
      evaluation={evaluation}
      aiStatus={aiStatus}
      aiError={aiError}
      isEvaluating={isEvaluating}
      peeked={peekedBeforeAnswer}
      redFives={humanPlayer?.red_fives ?? []}
      onPeek={peekMortal}
      onRetry={retryMortalEvaluation}
    />
  ) : null;

  /*
   * The 2D table: the persisted view picks between the stacked rows and the
   * top-down plan. In this branch the resolver has already reduced a stored 3D
   * choice that cannot run to the default view, so `tableMount.view` is what is
   * actually drawn (3D-14).
   */
  const twoDimensionalView =
    tableMount.kind === "2d" ? tableMount.view : tableView;

  const standardTable =
    twoDimensionalView === "topdown" && gameState ? (
      <PhysicalTable state={gameState} highlightLastDiscard={claimedFrom} />
    ) : (
      orderedPlayers.map((player) => (
        <PlayerRow
          key={player.seat}
          player={player}
          highlightLastDiscard={claimedFrom === player.seat}
        />
      ))
    );

  /*
   * 3D-14: a stored 3D choice this browser cannot run draws the standard table
   * instead. Say so, and say the choice is kept: the fallback must never look
   * like the user's setting was thrown away (it is not rewritten).
   */
  const rendered3dFallbackNotice =
    tableView === "rendered3d" &&
    tableMount.kind === "2d" &&
    threeUnavailableReason !== null
      ? `${threeUnavailableReason} The standard table is shown and your 3D view choice is kept.`
      : null;

  /*
   * The opt-in 3D view: the stage is the window and the UI floats over it
   * (user guidance 2026-11-18, plan §2.1/§9 decision 7). The stage holds the
   * scene and nothing in flow; `HudLayer` (3D-H2) is its fixed sibling and the
   * only chrome mounted over the canvas — the top bar's setup trigger,
   * next-hand and full-screen controls, plus the slots the HUD chain fills
   * (3D-H3…H5). No header, cards, action bar or hand dock are rendered around
   * the scene.
   */
  if (tableMount.kind === "three") {
    return (
      <div
        className="app-shell app-shell--3d"
        ref={threeShellRef}
        data-forced-landscape={forcedLandscape ? "true" : undefined}
      >
        <HudLayer
          shellRef={threeShellRef}
          stageRef={threeStageRef}
          mobile={mobileLayout}
          onNextScenario={handleNextScenario}
          nextDisabled={isLoading}
          setupTrigger={
            <SetupTrigger
              onOpen={() => {
                setSetupPage("settings");
                setHudSheet("setup");
              }}
              expanded={hudSheet === "setup"}
            />
          }
          actionRows={actionRows}
          callBar={hudCallBar}
          resultCard={hudResultCard}
          resultTone={hudResultTone}
          sheet={hudOpenSheet}
          onCloseSheet={closeHudSheet}
          announcement={hudAnnouncement}
          toasts={
            hudToasts.length > 0 ? (
              <HudToastStack toasts={hudToasts} />
            ) : undefined
          }
          toastCount={hudToasts.length}
        />
        <main className="table-3d" ref={threeStageRef}>
          {/*
           * The scene owns the window and its own status line (the host's
           * first-mount notice). App's deal status and errors are HUD toasts
           * (3D-H3), so nothing in the flow can push the canvas down or sit
           * between the player and the hand.
           */}
          {threeSnapshot && (
            <RendererHost
              snapshot={threeSnapshot}
              tier={tableMount.query.quality}
              debug={tableMount.query.debug}
              perfHud={tableMount.query.perf}
              pendingCall={pendingCall}
              liftedTiles={liftedTiles}
              onSelectTile={selectTile}
              onDegraded={handleThreeDegraded}
            />
          )}
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-title-group">
          {/* No scenario name here: it would hint at the answer during random draws. */}
          <h1 className="app-title">riichiprac</h1>
        </div>

        <div className="app-controls">{controls}</div>
      </header>

      {threeNotice && (
        <div className="three-fallback-notice" role="status">
          <span>{threeNotice}</span>
          <button type="button" onClick={() => setThreeNotice(null)}>
            Dismiss
          </button>
        </div>
      )}

      {rendered3dFallbackNotice && (
        <p className="three-fallback-notice" role="status">
          {rendered3dFallbackNotice}
        </p>
      )}

      {hotseatOpen && (
        <HotseatCard
          initialOptions={hotseatOptions}
          busy={isLoading || aiLoading}
          onGenerate={handleGenerateHotseat}
          onCancel={() => setHotseatOpen(false)}
        />
      )}

      {exportImportControls}

      {positionDescriptionCard}

      {tableInformation}

      {agreementNotice}

      {scenarioNote}

      {verdictPanel}

      <main
        className={
          twoDimensionalView === "stacked" ? "table-stack" : "table-physical"
        }
      >
        {statusMessage && (
          <div className="status-msg" role="status">
            {statusMessage}
          </div>
        )}
        {error && (
          <div className="error-msg" role="alert">
            {error}
          </div>
        )}

        {/*
         * The persisted view picks between the stacked rows and the top-down
         * plan; nothing else about the hand changes when it switches, so the
         * answer and grade stay put.
         */}
        {standardTable}
      </main>

      {gameState && !dualGrade && actionBarActions.length > 0 && (
        <ActionBar
          actions={actionBarActions}
          disabled={false}
          evaluation={evaluation}
          revealMortal={revealMortal}
          onAction={submitAction}
        />
      )}

      {humanPlayer && (
        <HandDock
          player={humanPlayer}
          grade={dualGrade}
          answer={submittedAnswer}
          callButtons={callButtons}
          pendingCall={pendingCall}
          callError={callError}
          aiEvaluation={evaluation}
          canDiscard={canDiscard}
          revealMortal={dualGrade !== null || peekedBeforeAnswer}
          nextDisabled={isLoading}
          onNextScenario={handleNextScenario}
          onResetAnswer={resetAnswer}
          onShowVerdict={showVerdict}
          previewTiles={callPreview}
          onBeginCall={beginCall}
          onPass={() => submitAction({ action: "Pass" })}
          onCancelCall={cancelCall}
          onPreviewCall={previewCall}
          onSelectTile={selectTile}
        />
      )}
    </div>
  );
};

export default App;
