import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { generate_puzzle, list_scenarios } from 'riichiprac';
import { callOfferActions, canDeclareRiichi, isCallDecision } from './actions';
import { AGREEMENT_OPTIONS, formatAgreementNotice } from './agreement';
import { ActionBar } from './components/ActionBar';
import { ExportImportControls } from './components/ExportImportControls';
import { HandDock } from './components/HandDock';
import { IsometricTable } from './components/IsometricTable';
import { NextScenarioButton } from './components/NextScenarioButton';
import { PhysicalTable } from './components/PhysicalTable';
import { PlayerRow } from './components/PlayerRow';
import { PositionDescriptionCard } from './components/PositionDescriptionCard';
import { ScenarioPicker } from './components/ScenarioPicker';
import { TableInfo } from './components/TableInfo';
import { VerdictPanel } from './components/VerdictPanel';
import { downloadJson, readStateFile, serializeState } from './stateFile';
import {
  ALL_SCENARIOS,
  FALLBACK_SCENARIOS,
  parseScenarioManifest,
  pickRandomScenarioFrom,
} from './scenarios';
import type { ScenarioOption, ScenarioSelection } from './scenarios';
import {
  SCENARIO_HISTORY_VERSION,
  ScenarioHistory,
} from './scenarioHistory';
import type { ScenarioSnapshot } from './scenarioHistory';
import { stackOrder } from './seatOrder';
import { useGameStore } from './store/useGameStore';
import { isTableView, useSettingsStore } from './store/useSettingsStore';
import { ensureWasmReady } from './wasm';
import './App.css';

/**
 * Whether the Mortal-agreement filter starts enabled. Kept as a named constant
 * because the first hand is dealt from this value rather than from the
 * checkbox state, so the two cannot drift.
 */
const DEFAULT_REQUIRE_AGREEMENT = true;

/**
 * How the table is drawn. `stacked` is the mobile-first default: four rows in
 * turn order with the hand docked at the bottom. `physical` is the opt-in plan
 * view (top-down only, never perspective) that arranges the seats around the
 * table with the human at the bottom edge.
 *
 * The choice is not persisted (there is no localStorage/sessionStorage entry),
 * so every fresh page load starts from the stacked default. The tables are the
 * same puzzle either way: switching only changes how the state is drawn. Which
 * renderer the plan view mounts is a separate, persisted setting: `topdown` is
 * the flat `PhysicalTable` above, `isometric` the experimental view. See
 * `store/useSettingsStore.ts`.
 */
type TableLayout = 'stacked' | 'physical';

/** The table starts stacked, so the first hand matches the documented layout. */
const DEFAULT_TABLE_LAYOUT: TableLayout = 'stacked';

export const App = () => {
  const gameState = useGameStore((state) => state.gameState);
  const isLoading = useGameStore((state) => state.isLoading);
  const error = useGameStore((state) => state.error);
  const callRiichi = useGameStore((state) => state.callRiichi);
  const callKan = useGameStore((state) => state.callKan);
  const submittedAnswer = useGameStore((state) => state.submittedAnswer);
  const dualGrade = useGameStore((state) => state.dualGrade);
  const peekedBeforeAnswer = useGameStore((state) => state.peekedBeforeAnswer);
  const peekMortal = useGameStore((state) => state.peekMortal);
  const loadFromJson = useGameStore((state) => state.loadFromJson);
  const loadFromAgreementJson = useGameStore(
    (state) => state.loadFromAgreementJson,
  );
  const mortalAgreement = useGameStore((state) => state.mortalAgreement);
  const toggleRiichi = useGameStore((state) => state.toggleRiichi);
  const toggleKan = useGameStore((state) => state.toggleKan);
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
  const positionDescription = useGameStore((state) => state.positionDescription);
  const importState = useGameStore((state) => state.importState);
  const setFileError = useGameStore((state) => state.setFileError);
  const setFileNotice = useGameStore((state) => state.setFileNotice);
  const clearFileNotice = useGameStore((state) => state.clearFileNotice);
  const clearPositionDescription = useGameStore(
    (state) => state.clearPositionDescription,
  );
  const restoreSnapshot = useGameStore((state) => state.restoreSnapshot);

  const [selection, setSelection] = useState<ScenarioSelection>(ALL_SCENARIOS);
  const [scenarios, setScenarios] =
    useState<ScenarioOption[]>(FALLBACK_SCENARIOS);
  const [aiLoading, setAiLoading] = useState(false);
  const [agreementLoading, setAgreementLoading] = useState(false);
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
   * Per-session table view, stacked by default. Switching it re-draws the same
   * hand; nothing is regenerated, so the answer and any submitted grade stay
   * put.
   */
  const [tableLayout, setTableLayout] =
    useState<TableLayout>(DEFAULT_TABLE_LAYOUT);
  /**
   * Which renderer the plan view mounts, persisted across reloads. It comes
   * from the settings store rather than component state so the header control
   * and the table mount point cannot disagree after a reload.
   */
  const tableView = useSettingsStore((state) => state.view);
  const setTableView = useSettingsStore((state) => state.setView);
  const [exportDescription, setExportDescription] = useState('');
  const manifestRef = useRef<ScenarioOption[] | null>(null);
  const loadRequestId = useRef(0);
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
      callRiichi: state.callRiichi,
      callKan: state.callKan,
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
    ) => {
      const requestId = ++loadRequestId.current;
      reset();
      // A description belongs to the position it was written for.
      updateExportDescription('');

      // What the hand about to load is drawn under. The agreement filter can
      // switch itself off below when Mortal is unavailable; the snapshot has to
      // carry the value that was actually in effect.
      let effectiveAgreement = requireMortalAgreement;

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

        if (!manifestRef.current) {
          const manifest = parseScenarioManifest(list_scenarios());
          manifestRef.current =
            manifest.length > 0 ? manifest : FALLBACK_SCENARIOS;
          if (manifest.length > 0) {
            setScenarios(manifest);
          }
        }

        const options = manifestRef.current ?? FALLBACK_SCENARIOS;
        const category = pickRandomScenarioFrom(
          options,
          scenarioSelection,
          useGameStore.getState().aiStatus === 'ready',
        );
        const requiresAi =
          options.find((option) => option.id === category)?.requires_ai === true;
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
                  'Mortal AI is unavailable; cannot generate this scenario.',
              );
            }
            // Let the loading state paint before the worker starts.
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 0);
            });
            if (requestId !== loadRequestId.current) return;
            const generated = await mortal.generateAiPuzzle(category);
            if (requestId !== loadRequestId.current) return;
            finish(() => loadFromJson(generated));
          } finally {
            setAiLoading(false);
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

  /** Put a history entry's hand and its answer state back on screen. */
  const restoreHistoryEntry = useCallback(
    (snapshot: ScenarioSnapshot) => {
      loadedWithRef.current = {
        selection: snapshot.selection,
        requireAgreement: snapshot.requireAgreement,
      };
      setSelection(snapshot.selection);
      setRequireAgreement(snapshot.requireAgreement);
      updateExportDescription(snapshot.exportDescription);
      restoreSnapshot(snapshot);
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
      restoreHistoryRef.current(snapshot);
    };

    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  /**
   * Keep the current entry's snapshot matching the screen. Answering, peeking,
   * arming Riichi, or editing the export note all land here, so going Back and
   * Forward again restores the answered hand instead of a fresh copy of it.
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
    callRiichi,
    callKan,
    evaluation,
    mortalAgreement,
    positionDescription,
    exportDescription,
  ]);

  // The filter is on by default, so the first hand is dealt through it too.
  // `loadPuzzle` falls back to a book-only deal when Mortal cannot load.
  useEffect(() => {
    void loadPuzzle(ALL_SCENARIOS, DEFAULT_REQUIRE_AGREEMENT);
  }, [loadPuzzle]);

  // Start loading the Mortal weights in the background on first paint.
  useEffect(() => {
    void initializeAi();
  }, [initializeAi]);

  const handleSelectionChange = (next: ScenarioSelection) => {
    setSelection(next);
    void loadPuzzle(next, requireAgreement);
  };

  const handleNextScenario = () => {
    void loadPuzzle(selection, requireAgreement);
  };

  const handleAgreementChange = (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.target.checked;
    setRequireAgreement(next);
    // Apply the setting to the hand on screen, not just the next one.
    void loadPuzzle(selection, next);
  };

  const handleLayoutChange = (event: ChangeEvent<HTMLInputElement>) => {
    // Redraw only: the puzzle, the answer, and the grade are untouched.
    setTableLayout(event.target.checked ? 'physical' : 'stacked');
  };

  const handleViewChange = (event: ChangeEvent<HTMLSelectElement>) => {
    // Redraw only, like the layout switch: the persisted setting changes which
    // table component mounts, nothing about the hand or its grade.
    if (isTableView(event.target.value)) {
      setTableView(event.target.value);
    }
  };

  const showVerdict = useCallback(() => {
    const panel = document.getElementById('verdict-panel');
    if (!panel) return;
    // The header is sticky and its height follows the type scale and the width
    // at which its controls wrap, so offset by the height measured right now: a
    // fixed scroll margin hid the top of the panel behind it on phones.
    const header = document.querySelector<HTMLElement>('.app-header');
    const offset = (header?.offsetHeight ?? 0) + 12;
    window.scrollTo({
      top: panel.getBoundingClientRect().top + window.scrollY - offset,
      behavior: 'smooth',
    });
    panel.focus({ preventScroll: true });
  }, []);

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
        updateExportDescription(imported.positionDescription ?? '');
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
  const isDrill = gameState?.correct_action.type === 'best';
  // A book call lesson renders its own Call/Pass buttons from the Rust offer.
  const isCallLesson = gameState ? isCallDecision(gameState) : false;
  const callActions = gameState ? callOfferActions(gameState) : [];
  const actionBarActions = isCallLesson ? callActions : availableActions;
  const canDiscard = isCallLesson
    ? false
    : isDrill
      ? availableActions.some((action) => action.type === 'discard')
      : true;
  // Rust owns the rule (`GameState::can_riichi`), read through one helper so
  // the dock and the store cannot disagree.
  const canRiichi = gameState ? canDeclareRiichi(gameState) : false;
  const decision = gameState?.decision;
  const claimedFrom =
    decision?.kind === 'react_to_discard' ? decision.from : null;

  const agreementHint =
    aiStatus === 'ready'
      ? 'Deal book-graded hands only when the embedded Mortal model plays the book answer. AI drills have no book answer, so they are dealt as usual and graded by Mortal alone. Each agreeing hand may need several forward passes.'
      : aiStatus === 'error'
        ? 'Mortal is unavailable, so this filter cannot run.'
        : 'Waiting for the Mortal model to load…';

  const viewHint =
    tableLayout === 'physical'
      ? 'Which table the plan view draws. Isometric is experimental and currently shows a placeholder.'
      : 'Turn on the top-down table to choose which table it draws. Isometric is experimental and currently shows a placeholder.';

  const statusMessage = agreementLoading
    ? 'Finding a hand Mortal agrees with…'
    : aiLoading
      ? 'Asking Mortal…'
      : isLoading
        ? 'Loading table…'
        : null;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-title-group">
          {/* No scenario name here: it would hint at the answer during random draws. */}
          <h1 className="app-title">riichiprac</h1>
        </div>

        <div className="app-controls">
          <ScenarioPicker
            scenarios={scenarios}
            selection={selection}
            onChange={handleSelectionChange}
          />

          <label className="app-toggle" title={agreementHint}>
            <input
              type="checkbox"
              checked={requireAgreement}
              disabled={aiStatus !== 'ready'}
              onChange={handleAgreementChange}
            />
            <span>Mortal must agree</span>
          </label>

          <label
            className="app-toggle"
            title="Draw the table from above, with your seat at the bottom edge and the tiles turned to face each player. Stays flat: no 3D or camera tilt."
          >
            <input
              type="checkbox"
              checked={tableLayout === 'physical'}
              onChange={handleLayoutChange}
            />
            <span>Top-down table</span>
          </label>

          <label className="app-toggle app-view-picker" title={viewHint}>
            <span>Table view</span>
            <select
              className="app-view-select"
              value={tableView}
              disabled={tableLayout !== 'physical'}
              onChange={handleViewChange}
            >
              <option value="topdown">Top-down</option>
              <option value="isometric">Isometric (experimental)</option>
            </select>
          </label>

          <NextScenarioButton onClick={handleNextScenario} disabled={isLoading} />
        </div>
      </header>

      <ExportImportControls
        canExport={Boolean(gameState)}
        description={exportDescription}
        onDescriptionChange={updateExportDescription}
        fileError={fileError}
        fileNotice={fileNotice}
        onExport={handleExport}
        onImportFile={handleImportFile}
        onDismissNotice={clearFileNotice}
      />

      {positionDescription && (
        <PositionDescriptionCard
          description={positionDescription}
          onDismiss={clearPositionDescription}
        />
      )}

      {gameState && <TableInfo state={gameState} />}

      {gameState && mortalAgreement && (
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
      )}

      {gameState?.scenario_note && (
        <p className="scenario-note">{gameState.scenario_note}</p>
      )}

      {gameState && (
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
          onRetry={() => {
            void initializeAi().then(() => evaluateWithAi());
          }}
        />
      )}

      <main
        className={tableLayout === 'physical' ? 'table-physical' : 'table-stack'}
      >
        {statusMessage && <div className="status-msg">{statusMessage}</div>}
        {error && (
          <div className="error-msg" role="alert">
            {error}
          </div>
        )}

        {gameState && tableLayout === 'physical' ? (
          // The view setting picks the renderer; nothing else about the hand
          // changes when it switches, so the answer and grade stay put.
          tableView === 'isometric' ? (
            <IsometricTable />
          ) : (
            <PhysicalTable
              state={gameState}
              highlightLastDiscard={claimedFrom}
            />
          )
        ) : (
          orderedPlayers.map((player) => (
            <PlayerRow
              key={player.seat}
              player={player}
              highlightLastDiscard={claimedFrom === player.seat}
            />
          ))
        )}
      </main>

      {gameState && !dualGrade && actionBarActions.length > 0 && (
        <ActionBar
          actions={actionBarActions}
          disabled={false}
          riichiArmed={callRiichi}
          evaluation={evaluation}
          revealMortal={dualGrade !== null || peekedBeforeAnswer}
          onToggleRiichi={toggleRiichi}
          onAction={submitAction}
        />
      )}

      {humanPlayer && (
        <HandDock
          player={humanPlayer}
          grade={dualGrade}
          answer={submittedAnswer}
          callRiichi={callRiichi}
          callKan={callKan}
          aiEvaluation={evaluation}
          availableActions={isDrill ? availableActions : undefined}
          canDiscard={canDiscard}
          canRiichi={canRiichi}
          revealMortal={dualGrade !== null || peekedBeforeAnswer}
          targetAction={gameState?.target_action}
          nextDisabled={isLoading}
          onNextScenario={handleNextScenario}
          onShowVerdict={showVerdict}
          onToggleRiichi={toggleRiichi}
          onToggleKan={toggleKan}
          onSelectTile={selectTile}
        />
      )}
    </div>
  );
};

export default App;
