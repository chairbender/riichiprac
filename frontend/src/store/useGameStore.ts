import { create } from 'zustand';
import { grade_answer_json } from 'riichiprac';
import {
  canDeclareRiichi,
  findAiActionInfo,
  findKanCandidateTile,
  isCorrectAction,
  isKanDecision,
} from '../actions';
import { parseAgreementPayload } from '../agreement';
import { initMortalClient } from '../services/mortalClient';
import type { MortalClient } from '../services/mortalClient';
import { loadWeights, WEIGHTS_FILENAME } from '../services/weightLoader';
import { parseStateFile } from '../stateFile';
import type { AiDecision, AiEvaluation, AiStatus } from '../types/ai';
import type { MortalAgreementReport } from '../types/agreement';
import type { CorrectActionType, GameState } from '../types/game';
import type { DualGrade } from '../types/verdict';
import { ensureWasmReady } from '../wasm';

/** An answer in the trainer's submitted-answer shape (mirrors `verdict.rs`). */
export interface SubmittedAnswer {
  action: CorrectActionType;
  tile: string;
  tile_index?: number;
  /** Mortal action name, e.g. `Discard_3m`, `Chi_Low`, `Pon`, `Pass`. */
  action_name?: string;
  /** True when the discarded tile was the draw (tsumogiri). */
  is_tsumogiri?: boolean;
}

/** A generic choice from the action bar. */
export interface PlayerChoice {
  /** Mortal action name, e.g. `Discard_3m`, `Chi_Low`, `Pon`, `Pass`. */
  action: string;
  /** Clicked or claimed tile code, when the action has one. */
  tile?: string;
  /** Index of the clicked copy in the hand dock (`[...hand, draw]`). */
  tileIndex?: number;
  /** Additional tiles consumed by a call (chi). */
  tiles?: string[];
  /** Optional label override; normally taken from the payload. */
  label?: string;
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

  /** Import/export error shown beside the position controls. */
  fileError: string | null;
  /** Non-error notice, e.g. after exporting or importing a position. */
  fileNotice: string | null;
  /**
   * Description carried by the last imported position file, shown as a card.
   * Null when the file had none (or after the card is dismissed).
   */
  positionDescription: string | null;

  /** Model weight loading state for the Mortal evaluator. */
  aiStatus: AiStatus;
  aiError: string | null;
  /**
   * Inference worker holding the Candle model; created once and reused for
   * every evaluation. Null until the weights are loaded.
   */
  mortal: MortalClient | null;
  /** Latest AI result for the current table, or null before evaluating. */
  evaluation: AiEvaluation | null;
  isEvaluating: boolean;
  /**
   * Report from the opt-in Mortal-agreement filter, when it generated this
   * hand. Null for every ordinary book-only puzzle and for imported positions.
   */
  mortalAgreement: MortalAgreementReport | null;

  /** Parse and store a raw JSON payload returned by the WASM engine. */
  loadFromJson: (json: string) => void;
  /**
   * Parse the `{state, agreement}` payload returned by
   * `generate_puzzle_with_agreement` and load its table.
   */
  loadFromAgreementJson: (json: string) => void;
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

  /** Import a saved position (or an older report's table) from file text. */
  importState: (text: string) => Promise<void>;
  /** Show or clear an import/export error. */
  setFileError: (error: string | null) => void;
  /** Show or clear an import/export notice. */
  setFileNotice: (notice: string | null) => void;
  /** Dismiss the current import/export notice. */
  clearFileNotice: () => void;
  /** Hide the imported position's description card. */
  clearPositionDescription: () => void;

  /** Fetch the Safetensors weights and start the inference worker once. */
  initializeAi: () => Promise<void>;
  /** Evaluate the current table now (used by the AI panel's retry). */
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
    riichi_discard: decision.riichi_discard ?? null,
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
  mortalAgreement: null,
  fileError: null,
  fileNotice: null,
  positionDescription: null,
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
  | 'mortalAgreement'
  | 'fileError'
  | 'fileNotice'
  | 'positionDescription'
>;

/**
 * True when this answer throws the tile just drawn, which makes the discard
 * tsumogiri. Calls and a riichi toggle alone never qualify; only an action that
 * discards the draw does.
 */
function submitsTheDraw(game: GameState, answer: SubmittedAnswer): boolean {
  const human = game.players.find((player) => player.is_human);
  if (!human?.draw) return false;

  // The dock renders `[...hand, draw]`, so the draw's index is the hand length.
  // Prefer the clicked copy when the caller provides it; a hand copy with the
  // same code is tedashi, not tsumogiri.
  const clickedTheDraw =
    answer.tile_index !== undefined
      ? answer.tile_index === human.hand.length
      : answer.tile === human.draw;
  if (!clickedTheDraw) return false;

  switch (answer.action) {
    case 'riichi':
    case 'dama':
    case 'fold':
    case 'discard':
      return true;
    case 'best': {
      // A declaration discards a tile too; the drawn tile can be that discard.
      const action = answer.action_name;
      return (
        action !== undefined &&
        (action.startsWith('Discard') || action === 'Riichi')
      );
    }
    default:
      return false;
  }
}

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
    if (!get().mortal) return;
    if (get().gameState !== state) return;
    if (get().isEvaluating) {
      pendingState = state;
      return;
    }
    void runEvaluation(state);
  };

  const runEvaluation = async (state: GameState) => {
    const mortal = get().mortal;
    if (!mortal) return;

    const requestId = ++evaluationRequestId;
    set({ isEvaluating: true, aiError: null });
    try {
      // Let the "Mortal is thinking" state paint while the worker starts.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });

      const evaluation = await mortal.evaluate(JSON.stringify(state));
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
    mortal: null,
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
          mortalAgreement: null,
          fileError: null,
          fileNotice: null,
          // Cleared per load; `importState` sets the imported file's own text.
          positionDescription: null,
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
          mortalAgreement: null,
          fileError: null,
          fileNotice: null,
          positionDescription: null,
        });
      }
    },

    loadFromAgreementJson: (json) => {
      let payload;
      try {
        payload = parseAgreementPayload(json);
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
          mortalAgreement: null,
          fileError: null,
          fileNotice: null,
          positionDescription: null,
        });
        return;
      }

      // `loadFromJson` owns the table validation and the payload's own error
      // handling; the report is attached only once the table is accepted.
      get().loadFromJson(payload.stateJson);
      if (get().error) return;
      set({ mortalAgreement: payload.report });
    },

    toggleRiichi: () =>
      set((state) => {
        if (!state.gameState || state.dualGrade) return state;
        // Rust decides legality: an open hand, an already-declared Riichi, or a
        // non-tenpai hand must never arm one.
        if (!canDeclareRiichi(state.gameState)) return state;
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
          tileIndex,
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
      if (submitsTheDraw(game, answer)) {
        answer.is_tsumogiri = true;
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
      if (choice.tileIndex !== undefined) {
        answer.tile_index = choice.tileIndex;
      }
      if (submitsTheDraw(game, answer)) {
        answer.is_tsumogiri = true;
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
        fileError: null,
        fileNotice: null,
        positionDescription: null,
      });
    },

    importState: async (text) => {
      try {
        await ensureWasmReady();
        const imported = parseStateFile(text);

        get().loadFromJson(imported.json);
        if (get().error) return;

        set({
          fileError: null,
          fileNotice: imported.fromReport
            ? 'Loaded the position from a scenario-report file.'
            : 'Position loaded.',
          positionDescription: imported.description,
        });
      } catch (err) {
        set({
          fileError: err instanceof Error ? err.message : String(err),
          fileNotice: null,
        });
      }
    },

    setFileError: (fileError) =>
      set(fileError ? { fileError, fileNotice: null } : { fileError }),

    setFileNotice: (fileNotice) => set({ fileNotice }),

    clearFileNotice: () => set({ fileNotice: null }),

    clearPositionDescription: () => set({ positionDescription: null }),

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

          // The worker instantiates its own WASM copy and parses the 43 MB
          // checkpoint off the UI thread, so this await does not block input.
          const mortal = await initMortalClient(bytes, WEIGHTS_FILENAME);
          set({ mortal, aiStatus: 'ready', aiError: null });

          const state = get().gameState;
          if (state && !get().evaluation) {
            requestEvaluationFor(state);
          }
        } catch (err) {
          aiInitPromise = null; // allow a retry from the UI
          set({
            mortal: null,
            aiStatus: 'error',
            aiError: err instanceof Error ? err.message : String(err),
          });
        }
      })();

      return aiInitPromise;
    },

    evaluateWithAi: async () => {
      const state = get().gameState;
      if (!state || get().isEvaluating || !get().mortal) return;
      await runEvaluation(state);
    },
  };
});
