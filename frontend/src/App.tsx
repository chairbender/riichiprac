import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { generate_puzzle, list_scenarios } from 'riichiprac';
import { callOfferActions, canDeclareRiichi, isCallDecision } from './actions';
import { AGREEMENT_OPTIONS, formatAgreementNotice } from './agreement';
import { ActionBar } from './components/ActionBar';
import { ExportImportControls } from './components/ExportImportControls';
import { HandDock } from './components/HandDock';
import { NextScenarioButton } from './components/NextScenarioButton';
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
import { stackOrder } from './seatOrder';
import { useGameStore } from './store/useGameStore';
import { ensureWasmReady } from './wasm';
import './App.css';

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

  const [selection, setSelection] = useState<ScenarioSelection>(ALL_SCENARIOS);
  const [scenarios, setScenarios] =
    useState<ScenarioOption[]>(FALLBACK_SCENARIOS);
  const [aiLoading, setAiLoading] = useState(false);
  const [agreementLoading, setAgreementLoading] = useState(false);
  /**
   * Per-session opt-in: deal book-graded hands only where Mortal plays the book
   * answer. A Mortal-only drill has no book answer, so the pool keeps it and
   * the drill is dealt as usual. Not persisted, so a browser without the
   * weights never starts in a state it cannot generate.
   */
  const [requireAgreement, setRequireAgreement] = useState(false);
  const [exportDescription, setExportDescription] = useState('');
  const manifestRef = useRef<ScenarioOption[] | null>(null);
  const loadRequestId = useRef(0);

  const loadPuzzle = useCallback(
    async (
      scenarioSelection: ScenarioSelection,
      requireMortalAgreement: boolean,
    ) => {
      const requestId = ++loadRequestId.current;
      reset();
      // A description belongs to the position it was written for.
      setExportDescription('');

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
            loadFromJson(await mortal.generateAiPuzzle(category));
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
              throw new Error(
                useGameStore.getState().aiError ??
                  'Mortal is unavailable, so a Mortal-agreeing hand cannot be ' +
                    'generated. Turn off "Mortal must agree" to keep practising.',
              );
            }
            // Let the loading state paint before the worker starts sampling.
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 0);
            });
            if (requestId !== loadRequestId.current) return;
            loadFromAgreementJson(
              await mortal.generatePuzzleWithAgreement(
                category,
                JSON.stringify(AGREEMENT_OPTIONS),
              ),
            );
          } finally {
            setAgreementLoading(false);
          }
        } else {
          loadFromJson(generate_puzzle(category));
        }
      } catch (err) {
        if (requestId !== loadRequestId.current) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [
      initializeAi,
      loadFromAgreementJson,
      loadFromJson,
      reset,
      setError,
    ],
  );

  // The filter is a per-session choice, so the first hand is always book-only.
  useEffect(() => {
    void loadPuzzle(ALL_SCENARIOS, false);
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

  const showVerdict = useCallback(() => {
    const panel = document.getElementById('verdict-panel');
    if (!panel) return;
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
        setExportDescription(imported.positionDescription ?? '');
      }
    } catch (err) {
      setFileError(err instanceof Error ? err.message : String(err));
    }
  };

  // The human is anchored at the bottom (just above the hand dock); the other
  // seats stack above it in turn order. See `stackOrder`.
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

          <label className="agreement-toggle" title={agreementHint}>
            <input
              type="checkbox"
              checked={requireAgreement}
              disabled={aiStatus !== 'ready'}
              onChange={handleAgreementChange}
            />
            <span>Mortal must agree</span>
          </label>

          <NextScenarioButton onClick={handleNextScenario} disabled={isLoading} />
        </div>
      </header>

      <ExportImportControls
        canExport={Boolean(gameState)}
        description={exportDescription}
        onDescriptionChange={setExportDescription}
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
          {formatAgreementNotice(mortalAgreement)}
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

      <main className="table-stack">
        {statusMessage && <div className="status-msg">{statusMessage}</div>}
        {error && (
          <div className="error-msg" role="alert">
            {error}
          </div>
        )}

        {orderedPlayers.map((player) => (
          <PlayerRow
            key={player.seat}
            player={player}
            highlightLastDiscard={claimedFrom === player.seat}
          />
        ))}
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
