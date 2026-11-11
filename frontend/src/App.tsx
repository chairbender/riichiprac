import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { generate_puzzle, list_scenarios } from 'riichiprac';
import { AI_MODEL_ID } from './aiModel';
import { ActionBar } from './components/ActionBar';
import { HandDock } from './components/HandDock';
import { FeedbackToast } from './components/FeedbackToast';
import { PlayerRow } from './components/PlayerRow';
import { ReportBanner } from './components/ReportBanner';
import { ReportControls } from './components/ReportControls';
import { TableInfo } from './components/TableInfo';
import { VerdictPanel } from './components/VerdictPanel';
import {
  createScenarioReport,
  downloadJson,
  readReportFile,
  reportFilename,
} from './report';
import {
  FALLBACK_SCENARIOS,
  parseScenarioManifest,
  pickRandomScenario,
  scenarioLabel,
} from './scenarios';
import type { ScenarioOption, ScenarioSelection } from './scenarios';
import { useGameStore } from './store/useGameStore';
import type { ReportReason, ReportedAction } from './types/report';
import { ensureWasmReady } from './wasm';
import './App.css';

/**
 * Portrait rows from top to bottom:
 * Toimen (across), Kamicha (left), Shimocha (right), then the human.
 */
const PLAYER_ROW_ORDER = [2, 3, 1, 0];

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
  const reportMode = useGameStore((state) => state.reportMode);
  const reportError = useGameStore((state) => state.reportError);
  const reportNotice = useGameStore((state) => state.reportNotice);
  const isReportRetry = useGameStore((state) => state.isReportRetry);
  const importReport = useGameStore((state) => state.importReport);
  const retryImportedPuzzle = useGameStore(
    (state) => state.retryImportedPuzzle,
  );
  const exitReportMode = useGameStore((state) => state.exitReportMode);
  const setReportError = useGameStore((state) => state.setReportError);
  const clearReportNotice = useGameStore((state) => state.clearReportNotice);

  const [selection, setSelection] = useState<ScenarioSelection>('all');
  const [scenarios, setScenarios] =
    useState<ScenarioOption[]>(FALLBACK_SCENARIOS);
  const [aiLoading, setAiLoading] = useState(false);
  const manifestRef = useRef<ScenarioOption[] | null>(null);
  const loadRequestId = useRef(0);

  const loadPuzzle = useCallback(
    async (scenarioSelection: ScenarioSelection) => {
      const requestId = ++loadRequestId.current;
      reset();

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
        const category =
          scenarioSelection === 'all'
            ? pickRandomScenario(
                options,
                useGameStore.getState().aiStatus === 'ready',
              )
            : scenarioSelection;
        const requiresAi =
          options.find((option) => option.id === category)?.requires_ai === true;

        if (requiresAi) {
          setAiLoading(true);
          try {
            await initializeAi();
            if (requestId !== loadRequestId.current) return;
            const evaluator = useGameStore.getState().evaluator;
            if (!evaluator) {
              throw new Error(
                useGameStore.getState().aiError ??
                  'Mortal AI is unavailable; cannot generate this scenario.',
              );
            }
            // Let the loading state paint before the blocking inference.
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 0);
            });
            if (requestId !== loadRequestId.current) return;
            loadFromJson(evaluator.generate_ai_puzzle(category));
          } finally {
            setAiLoading(false);
          }
        } else {
          loadFromJson(generate_puzzle(category));
        }
      } catch (err) {
        if (requestId !== loadRequestId.current) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [initializeAi, loadFromJson, reset, setError],
  );

  useEffect(() => {
    void loadPuzzle('all');
  }, [loadPuzzle]);

  // Start loading the Mortal weights in the background on first paint.
  useEffect(() => {
    void initializeAi();
  }, [initializeAi]);

  const handleScenarioChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = event.target.value as ScenarioSelection;
    setSelection(next);
    void loadPuzzle(next);
  };

  const handleNextScenario = () => {
    void loadPuzzle(selection);
  };

  // Show the imported report's scenario in the picker when it is in the
  // current manifest. Unknown scenarios keep the picker unchanged.
  useEffect(() => {
    const id = reportMode?.report.scenario.id;
    if (id && scenarios.some((scenario) => scenario.id === id)) {
      setSelection(id);
    }
  }, [reportMode, scenarios]);

  const handleExportReport = async (reason: ReportReason, note: string) => {
    if (!gameState || !submittedAnswer) {
      throw new Error('Answer the puzzle before exporting a report.');
    }

    await ensureWasmReady();

    const answer: ReportedAction = {
      action: submittedAnswer.action,
      tile: submittedAnswer.tile,
    };
    if (submittedAnswer.tile_index !== undefined) {
      answer.tile_index = submittedAnswer.tile_index;
    }
    if (submittedAnswer.action_name !== undefined) {
      answer.action_name = submittedAnswer.action_name;
    }

    const { report, json } = createScenarioReport({
      table: gameState,
      answer,
      reason,
      note,
      evaluation,
      modelId: AI_MODEL_ID,
      peekedBeforeAnswer,
    });

    downloadJson(reportFilename(report), json);
    setReportError(null);
  };

  const handleImportFile = async (file: File) => {
    setReportError(null);
    try {
      const text = await readReportFile(file);
      // Cancel any generation that is still waiting on WASM initialization so
      // a late puzzle cannot overwrite the imported table.
      loadRequestId.current += 1;
      await importReport(text);
    } catch (err) {
      setReportError(err instanceof Error ? err.message : String(err));
    }
  };

  const orderedPlayers = gameState
    ? PLAYER_ROW_ORDER.flatMap((seat) => {
        const player = gameState.players.find(
          (candidate) => candidate.seat === seat,
        );
        return player ? [player] : [];
      })
    : [];

  const humanPlayer =
    gameState?.players.find((player) => player.is_human) ?? null;

  const aiDecision = gameState?.ai_decision ?? null;
  const availableActions = aiDecision?.actions ?? [];
  const isDrill = gameState?.correct_action.type === 'best';
  const canDiscard = isDrill
    ? availableActions.some((action) => action.type === 'discard')
    : true;
  const decision = gameState?.decision;
  const claimedFrom =
    decision?.kind === 'react_to_discard' ? decision.from : null;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-title-group">
          <h1 className="app-title">Riichi Trainer</h1>
          {gameState && (
            <span className="scenario-current">
              {scenarioLabel(gameState.category, scenarios)}
              {isDrill && ' · Mortal drill'}
            </span>
          )}
        </div>

        <div className="app-controls">
          <label className="scenario-picker">
            <span className="scenario-picker-label">Scenario</span>
            <select
              className="scenario-select"
              value={selection}
              onChange={handleScenarioChange}
              aria-label="Scenario"
            >
              <option value="all">All scenarios (random)</option>
              {scenarios.map((scenario) => (
                <option key={scenario.id} value={scenario.id}>
                  {scenario.label}
                </option>
              ))}
            </select>
          </label>

          <button
            className="new-hand-button"
            type="button"
            onClick={handleNextScenario}
            disabled={isLoading}
          >
            Next Scenario
          </button>
        </div>
      </header>

      <ReportControls
        canReport={Boolean(gameState && dualGrade)}
        reportError={reportError}
        reportNotice={reportNotice}
        onExport={handleExportReport}
        onImportFile={handleImportFile}
        onDismissNotice={clearReportNotice}
      />

      {reportMode && (
        <ReportBanner
          mode={reportMode}
          evaluation={evaluation}
          isEvaluating={isEvaluating}
          aiStatus={aiStatus}
          aiError={aiError}
          onVerify={() => {
            void evaluateWithAi();
          }}
          onRetry={retryImportedPuzzle}
          onExit={exitReportMode}
        />
      )}

      {gameState && dualGrade && submittedAnswer && humanPlayer && (!reportMode || isReportRetry) && (
        <FeedbackToast
          grade={dualGrade}
          answer={submittedAnswer}
          redFives={humanPlayer.red_fives}
          evaluation={evaluation}
        />
      )}

      {gameState && <TableInfo state={gameState} />}

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
        {(isLoading || aiLoading) && (
          <div className="status-msg">
            {aiLoading ? 'Asking Mortal…' : 'Loading table…'}
          </div>
        )}
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

      {gameState && availableActions.length > 0 && (
        <ActionBar
          actions={availableActions}
          disabled={dualGrade !== null}
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
          revealMortal={dualGrade !== null || peekedBeforeAnswer}
          onToggleRiichi={toggleRiichi}
          onToggleKan={toggleKan}
          onSelectTile={selectTile}
        />
      )}
    </div>
  );
};

export default App;
