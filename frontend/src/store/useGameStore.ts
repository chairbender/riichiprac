import { create } from 'zustand';
import { WasmMortalEvaluator, grade_answer_json } from 'riichiprac';
import {
  findAiActionInfo,
  findKanCandidateTile,
  isCorrectAction,
  isKanDecision,
} from '../actions';
import { loadWeights, WEIGHTS_FILENAME } from '../services/weightLoader';
import { parseImportedState } from '../report';
import type { AiDecision, AiEvaluation, AiStatus } from '../types/ai';
import type { CorrectActionType, GameState } from '../types/game';
import type { ReportVerdict, ScenarioReport } from '../types/report';
import type { DualGrade } from '../types/verdict';
import { ensureWasmReady } from '../wasm';

/** An answer in the trainer's submitted-answer shape (mirrors `verdict.rs`). */
export interface SubmittedAnswer {
  action: CorrectActionType;
  tile: string;
  tile_index?: number;
  /** Mortal action name, e.g. `Discard_3m`, `Chi_Low`, `Pon`, `Pass`. */
  action_name?: string;
}

/** A generic choice from the action bar. */
export interface PlayerChoice {
  /** Mortal action name, e.g. `Discard_3m`, `Chi_Low`, `Pon`, `Pass`. */
  action: string;
  /** Clicked or claimed tile code, when the action has one. */
  tile?: string;
  /** Additional tiles consumed by a call (chi). */
  tiles?: string[];
  /** Optional label override; normally taken from the payload. */
  label?: string;
}

/** An imported report being reviewed in the UI. */
export interface ReportMode {
  report: ScenarioReport;
  verdict: ReportVerdict;
  warnings: string[];
}

interface GradeRequest {
  table: GameState;
  answer: SubmittedAnswer;
  evaluation: AiEvaluation | null;
}

interface GameStore {
  /** Parsed table state from the WASM `generate_puzzle` payload. */
  gameState: GameState | null;
  isLoading: boolean;
  error: string | null;
  /** Whether the player has armed the "Call Riichi" toggle. */
  callRiichi: boolean;
  /** Whether the player has armed the Shouminkan call. */
  callKan: boolean;

  /** The answer the player submitted, in trainer vocabulary. */
  submittedAnswer: SubmittedAnswer | null;
  /** Dual verdict for `submittedAnswer`; null before answering. */
  dualGrade: DualGrade | null;
  /** True when the player revealed Mortal's line before answering. */
  peekedBeforeAnswer: boolean;

  /** Imported report currently under review, or null in normal practice. */
  reportMode: ReportMode | null;
  /** Import/export error shown beside the report controls. */
  reportError: string | null;
  /** Non-error notice, e.g. after importing a bare game state. */
  reportNotice: string | null;
  /** True after "Try this puzzle", so normal answer feedback is shown again. */
  isReportRetry: boolean;

  /** Model weight loading state for the Mortal evaluator. */
  aiStatus: AiStatus;
  aiError: string | null;
  /** Loaded Candle model; created once and reused for every evaluation. */
  evaluator: WasmMortalEvaluator | null;
  /** Latest AI result for the current table, or null before evaluating. */
  evaluation: AiEvaluation | null;
  isEvaluating: boolean;

  /** Parse and store a raw JSON payload returned by the WASM engine. */
  loadFromJson: (json: string) => void;
  /** Arm or disarm the Riichi declaration before choosing a discard. */
  toggleRiichi: () => void;
  /** Arm or disarm the Added Kan before choosing the fourth tile. */
  toggleKan: () => void;
  /** Submit the armed call state and clicked hand tile as one answer. */
  selectTile: (tile: string, tileIndex?: number) => void;
  /** Submit a generic AI-scenario choice. */
  submitChoice: (choice: PlayerChoice) => void;
  /** Submit a non-discard action from the generic action bar. */
  submitAction: (action: { action: string; tile?: string | null; tiles?: string[]; label?: string }) => void;
  /** Grade a submitted answer against both perspectives. */
  submitAnswer: (answer: SubmittedAnswer) => void;
  /** Re-grade the current answer after an evaluation arrives. */
  regrade: () => void;
  /** Reveal Mortal's line before answering. */
  peekMortal: () => void;
  /** Clear the current table and answer before loading the next scenario. */
  reset: () => void;
  setError: (error: string) => void;

  /** Import a report (or a bare game state) from file text. */
  importReport: (text: string) => Promise<void>;
  /** Clear the imported answer so the reviewer can try the puzzle again. */
  retryImportedPuzzle: () => void;
  /** Leave report mode without changing the table. */
  exitReportMode: () => void;
  /** Show or clear an import/export error. */
  setReportError: (error: string | null) => void;
  /** Dismiss the bare-state notice. */
  clearReportNotice: () => void;

  /** Fetch the Safetensors weights and build the WASM evaluator once. */
  initializeAi: () => Promise<void>;
  /** Evaluate the current table now (used by the report banner's verify). */
  evaluateWithAi: () => Promise<void>;
}

interface WasmErrorPayload {
  error?: string;
}

/** Mortal's evaluation as embedded in an AI scenario's payload. */
function evaluationFromDecision(decision: AiDecision): AiEvaluation {
  return {
    model: decision.model,
    expected_value: decision.expected_value,
    recommended_action: decision.recommended_action,
    evaluations: decision.evaluations,
  };
}

/**
 * Deduplicates concurrent model loads. `loadEvaluator` runs from an effect, so
 * React StrictMode can fire it twice; the model must only be parsed once.
 */
let aiInitPromise: Promise<void> | null = null;

const emptyState = {
  gameState: null,
  isLoading: true,
  error: null,
  callRiichi: false,
  callKan: false,
  submittedAnswer: null,
  dualGrade: null,
  peekedBeforeAnswer: false,
  evaluation: null,
  reportMode: null,
  reportError: null,
  reportNotice: null,
  isReportRetry: false,
} satisfies Pick<
  GameStore,
  | 'gameState'
  | 'isLoading'
  | 'error'
  | 'callRiichi'
  | 'callKan'
  | 'submittedAnswer'
  | 'dualGrade'
  | 'peekedBeforeAnswer'
  | 'evaluation'
  | 'reportMode'
  | 'reportError'
  | 'reportNotice'
  | 'isReportRetry'
>;

export const useGameStore = create<GameStore>((set, get) => {
  /** One-slot queue so a puzzle swap during a forward pass is not dropped. */
  let pendingState: GameState | null = null;
  let evaluationRequestId = 0;

  /** Parse the WASM grade payload, throwing on an error envelope. */
  const parseGrade = (raw: string): DualGrade => {
    const parsed = JSON.parse(raw) as DualGrade & WasmErrorPayload;
    if (parsed.error) {
      throw new Error(parsed.error);
    }
    return parsed;
  };

  /** Grade with the Rust dual grader; returns null and reports on failure. */
  const gradeNow = (
    table: GameState,
    answer: SubmittedAnswer,
    evaluation: AiEvaluation | null,
  ): DualGrade | null => {
    try {
      const request: GradeRequest = { table, answer, evaluation };
      return parseGrade(grade_answer_json(JSON.stringify(request)));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  };

  const requestEvaluationFor = (state: GameState) => {
    if (!get().evaluator) return;
    if (get().gameState !== state) return;
    if (get().isEvaluating) {
      pendingState = state;
      return;
    }
    void runEvaluation(state);
  };

  const runEvaluation = async (state: GameState) => {
    const evaluator = get().evaluator;
    if (!evaluator) return;

    const requestId = ++evaluationRequestId;
    set({ isEvaluating: true, aiError: null });
    try {
      // Yield once so the "Mortal is thinking" state can paint before the
      // synchronous forward pass blocks the main thread.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });

      const evaluation = evaluator.evaluate(
        JSON.stringify(state),
      ) as AiEvaluation;
      if (requestId !== evaluationRequestId) return;

      if (get().gameState !== state) {
        set({ isEvaluating: false });
        return;
      }

      set({ evaluation, isEvaluating: false });

      const answer = get().submittedAnswer;
      if (answer) {
        const grade = gradeNow(state, answer, evaluation);
        if (grade) {
          set({ dualGrade: grade });
        }
      }
    } catch (err) {
      if (requestId !== evaluationRequestId) return;
      set({
        isEvaluating: false,
        aiError: err instanceof Error ? err.message : String(err),
      });
    } finally {
      const next = pendingState;
      pendingState = null;
      if (requestId === evaluationRequestId && next && get().gameState === next) {
        requestEvaluationFor(next);
      }
    }
  };

  return {
    ...emptyState,
    aiStatus: 'idle',
    aiError: null,
    evaluator: null,
    isEvaluating: false,

    loadFromJson: (json) => {
      try {
        const parsed = JSON.parse(json) as GameState & WasmErrorPayload;

        if (parsed.error) {
          throw new Error(parsed.error);
        }
        if (!Array.isArray(parsed.players) || parsed.players.length !== 4) {
          throw new Error('WASM returned an invalid table state');
        }
        if (!isCorrectAction(parsed.correct_action)) {
          throw new Error('WASM returned an invalid correct action');
        }

        // The AI scenario already carries the ranking, so seed the column from
        // it instead of paying for a second identical forward pass.
        const evaluation = parsed.ai_decision
          ? evaluationFromDecision(parsed.ai_decision)
          : null;

        set({
          gameState: parsed,
          isLoading: false,
          error: null,
          callRiichi: false,
          callKan: false,
          submittedAnswer: null,
          dualGrade: null,
          peekedBeforeAnswer: false,
          evaluation,
          reportMode: null,
          reportError: null,
          reportNotice: null,
          isReportRetry: false,
        });

        if (!evaluation) {
          requestEvaluationFor(parsed);
        }
      } catch (err) {
        set({
          isLoading: false,
          error: err instanceof Error ? err.message : String(err),
          callRiichi: false,
          callKan: false,
          submittedAnswer: null,
          dualGrade: null,
          peekedBeforeAnswer: false,
          evaluation: null,
          reportMode: null,
          reportError: null,
          reportNotice: null,
          isReportRetry: false,
        });
      }
    },

    toggleRiichi: () =>
      set((state) => {
        if (!state.gameState || state.dualGrade) return state;
        if (state.gameState.correct_action.type === 'best') {
          const hasRiichi = state.gameState.ai_decision?.actions.some(
            (action) => action.action === 'Riichi',
          );
          if (!hasRiichi) return state;
        }
        return { callRiichi: !state.callRiichi, callKan: false };
      }),

    toggleKan: () =>
      set((state) => {
        if (!state.gameState || state.dualGrade) return state;

        const human = state.gameState.players.find((player) => player.is_human);
        if (!human || !findKanCandidateTile(human)) return state;

        return { callKan: !state.callKan, callRiichi: false };
      }),

    selectTile: (tile, tileIndex) => {
      const state = get();
      const game = state.gameState;
      if (!game || state.dualGrade) return;

      if (game.correct_action.type === 'best') {
        const action = state.callRiichi ? 'Riichi' : `Discard_${tile}`;
        const info = findAiActionInfo(game, action, tile);
        get().submitChoice({
          action: info?.action ?? action,
          tile,
          tiles: info?.tiles,
          label: info?.label,
        });
        return;
      }

      const human = game.players.find((player) => player.is_human);
      const kanCandidate = human ? findKanCandidateTile(human) : null;

      // A defense lesson's answer is a fold: no declaration is armed, so the
      // click alone submits the "safest discard" action.
      let selectedType: CorrectActionType =
        game.correct_action.type === 'fold' ? 'fold' : 'dama';
      if (state.callKan && kanCandidate) {
        selectedType = 'kan';
      } else if (state.callRiichi) {
        selectedType = 'riichi';
      } else if (isKanDecision(game.correct_action)) {
        selectedType = 'discard';
      }

      const answer: SubmittedAnswer = { action: selectedType, tile };
      if (tileIndex !== undefined) {
        answer.tile_index = tileIndex;
      }
      get().submitAnswer(answer);
    },

    submitChoice: (choice) => {
      const game = get().gameState;
      if (!game || game.correct_action.type !== 'best' || get().dualGrade) return;

      const answer: SubmittedAnswer = {
        action: 'best',
        tile: choice.tile ?? '',
      };
      if (choice.action) {
        answer.action_name = choice.action;
      }
      get().submitAnswer(answer);
    },

    submitAction: (action) => {
      if (action.action === 'Riichi') {
        get().toggleRiichi();
        return;
      }
      get().submitChoice({
        action: action.action,
        tile: action.tile ?? undefined,
        tiles: action.tiles,
        label: action.label,
      });
    },

    submitAnswer: (answer) => {
      const { gameState, evaluation } = get();
      if (!gameState || get().dualGrade) return;

      const grade = gradeNow(gameState, answer, evaluation);
      if (!grade) return;

      set({ submittedAnswer: answer, dualGrade: grade });
    },

    regrade: () => {
      const { gameState, submittedAnswer, evaluation } = get();
      if (!gameState || !submittedAnswer) return;
      const grade = gradeNow(gameState, submittedAnswer, evaluation);
      if (grade) {
        set({ dualGrade: grade });
      }
    },

    peekMortal: () => set({ peekedBeforeAnswer: true }),

    reset: () => {
      pendingState = null;
      evaluationRequestId += 1;
      set({ ...emptyState, isEvaluating: false });
    },

    setError: (error) => {
      pendingState = null;
      evaluationRequestId += 1;
      set({
        isLoading: false,
        error,
        callRiichi: false,
        callKan: false,
        submittedAnswer: null,
        dualGrade: null,
        peekedBeforeAnswer: false,
        evaluation: null,
        isEvaluating: false,
        reportMode: null,
        reportError: null,
        reportNotice: null,
        isReportRetry: false,
      });
    },

    importReport: async (text) => {
      try {
        await ensureWasmReady();
        const imported = parseImportedState(text);

        if (imported.kind === 'bare') {
          get().loadFromJson(imported.json);
          if (!get().error) {
            set({
              reportNotice:
                'Loaded a bare game state. No reported answer was attached.',
            });
          }
          return;
        }

        const { report, verdict, warnings } = imported.parsed;
        const human = report.table.players.find((player) => player.is_human);
        if (!human) {
          throw new Error('The report does not contain a human player.');
        }

        const answer = report.decision.answer;
        const submitted: SubmittedAnswer = {
          action: answer.action,
          tile: answer.tile,
        };
        if (answer.tile_index !== undefined) {
          submitted.tile_index = answer.tile_index;
        }
        if (answer.action_name !== undefined) {
          submitted.action_name = answer.action_name;
        }

        const embedded = report.ai?.evaluation ?? null;
        const grade = gradeNow(report.table, submitted, embedded);
        if (!grade) {
          throw new Error('Could not grade the imported answer.');
        }

        set({
          gameState: report.table,
          isLoading: false,
          error: null,
          callRiichi: false,
          callKan: false,
          submittedAnswer: submitted,
          dualGrade: grade,
          peekedBeforeAnswer: report.ai?.peeked_before_answer ?? false,
          evaluation: embedded,
          reportMode: { report, verdict, warnings },
          reportError: null,
          reportNotice: null,
          isReportRetry: false,
        });

        // Always run a fresh evaluation: the reviewer wants Mortal's current
        // opinion, not only the snapshot that was exported.
        requestEvaluationFor(report.table);
      } catch (err) {
        set({
          reportError: err instanceof Error ? err.message : String(err),
        });
      }
    },

    retryImportedPuzzle: () =>
      set({ submittedAnswer: null, dualGrade: null, isReportRetry: true }),

    exitReportMode: () =>
      set({ reportMode: null, isReportRetry: false }),

    setReportError: (reportError) => set({ reportError }),

    clearReportNotice: () => set({ reportNotice: null }),

    initializeAi: () => {
      if (aiInitPromise) return aiInitPromise;
      if (get().aiStatus === 'ready' || get().aiStatus === 'loading') {
        return Promise.resolve();
      }

      aiInitPromise = (async () => {
        set({ aiStatus: 'loading', aiError: null });
        try {
          await ensureWasmReady();

          // Resolves from IndexedDB when cached, otherwise downloads from the
          // external CDN. See services/weightLoader.ts and hosting-plan.md.
          const bytes = await loadWeights();

          // Let the loading badge paint before the blocking 43 MB parse/bind.
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          });

          const evaluator = new WasmMortalEvaluator(bytes, WEIGHTS_FILENAME);
          set({ evaluator, aiStatus: 'ready', aiError: null });

          const state = get().gameState;
          if (state && !get().evaluation) {
            requestEvaluationFor(state);
          }
        } catch (err) {
          aiInitPromise = null; // allow a retry from the UI
          set({
            evaluator: null,
            aiStatus: 'error',
            aiError: err instanceof Error ? err.message : String(err),
          });
        }
      })();

      return aiInitPromise;
    },

    evaluateWithAi: async () => {
      const state = get().gameState;
      if (!state || get().isEvaluating || !get().evaluator) return;
      await runEvaluation(state);
    },
  };
});
