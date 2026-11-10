import { create } from 'zustand';
import { WasmMortalEvaluator } from 'riichiprac';
import {
  correctActionTile,
  findKanCandidateTile,
  isCorrectAction,
  isKanDecision,
} from '../actions';
import type { AiEvaluation, AiStatus } from '../types/ai';
import type { CorrectActionType, GameState } from '../types/game';
import { ensureWasmReady } from '../wasm';

export interface AnswerFeedback {
  /** True only when both the action type and clicked tile are correct. */
  isCorrect: boolean;
  /** Whether the player submitted Riichi, Dama, Kan, or a normal discard. */
  selectedType: CorrectActionType;
  /** Action type the scenario expected. */
  correctType: CorrectActionType;
  isActionCorrect: boolean;
  selectedTile: string;
  correctTile: string;
  isTileCorrect: boolean;
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
  /** Result of the player's action + tile choice, or null before answering. */
  feedback: AnswerFeedback | null;

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
  selectTile: (tile: string) => void;
  /** Clear the current table and answer before loading the next scenario. */
  reset: () => void;
  setError: (error: string) => void;

  /** Fetch the Safetensors weights and build the WASM evaluator once. */
  initializeAi: () => Promise<void>;
  /** Evaluate the current table with the loaded Mortal model. */
  evaluateWithAi: () => Promise<void>;
  /** Hide the current AI recommendation without unloading the model. */
  clearEvaluation: () => void;
}

interface WasmErrorPayload {
  error?: string;
}

const WEIGHTS_URL = `${import.meta.env.BASE_URL}models/mortal_298k.safetensors`;

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
  feedback: null,
  evaluation: null,
} satisfies Pick<
  GameStore,
  | 'gameState'
  | 'isLoading'
  | 'error'
  | 'callRiichi'
  | 'callKan'
  | 'feedback'
  | 'evaluation'
>;

export const useGameStore = create<GameStore>((set, get) => ({
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

      set({
        gameState: parsed,
        isLoading: false,
        error: null,
        callRiichi: false,
        callKan: false,
        feedback: null,
        evaluation: null,
      });
    } catch (err) {
      set({
        isLoading: false,
        error: err instanceof Error ? err.message : String(err),
        callRiichi: false,
        callKan: false,
        feedback: null,
        evaluation: null,
      });
    }
  },

  toggleRiichi: () =>
    set((state) => {
      if (!state.gameState || state.feedback) return state;
      return { callRiichi: !state.callRiichi, callKan: false };
    }),

  toggleKan: () =>
    set((state) => {
      if (!state.gameState || state.feedback) return state;

      const human = state.gameState.players.find((player) => player.is_human);
      if (!human || !findKanCandidateTile(human)) return state;

      return { callKan: !state.callKan, callRiichi: false };
    }),

  selectTile: (tile) =>
    set((state) => {
      if (!state.gameState || state.feedback) return state;

      const { correct_action: correctAction, players } = state.gameState;
      const human = players.find((player) => player.is_human);
      const kanCandidate = human ? findKanCandidateTile(human) : null;

      let selectedType: CorrectActionType = 'dama';
      if (state.callKan && kanCandidate) {
        selectedType = 'kan';
      } else if (state.callRiichi) {
        selectedType = 'riichi';
      } else if (isKanDecision(correctAction)) {
        selectedType = 'discard';
      }

      const correctTile = correctActionTile(correctAction);
      const isActionCorrect = selectedType === correctAction.type;
      const isTileCorrect = tile === correctTile;

      return {
        feedback: {
          isCorrect: isActionCorrect && isTileCorrect,
          selectedType,
          correctType: correctAction.type,
          isActionCorrect,
          selectedTile: tile,
          correctTile,
          isTileCorrect,
        },
      };
    }),

  reset: () => set(emptyState),

  setError: (error) =>
    set({
      isLoading: false,
      error,
      callRiichi: false,
      callKan: false,
      feedback: null,
      evaluation: null,
    }),

  initializeAi: () => {
    if (aiInitPromise) return aiInitPromise;
    if (get().aiStatus === 'ready' || get().aiStatus === 'loading') {
      return Promise.resolve();
    }

    aiInitPromise = (async () => {
      set({ aiStatus: 'loading', aiError: null });
      try {
        await ensureWasmReady();

        const response = await fetch(WEIGHTS_URL);
        if (!response.ok) {
          throw new Error(
            `could not load ${WEIGHTS_URL} (HTTP ${response.status}). ` +
              'Run scripts/convert_weights.py to generate the model file.',
          );
        }

        const bytes = new Uint8Array(await response.arrayBuffer());

        // Let the loading badge paint before the blocking 43 MB parse/bind.
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });

        const evaluator = new WasmMortalEvaluator(bytes);
        set({ evaluator, aiStatus: 'ready', aiError: null });
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
    const { evaluator, gameState, isEvaluating } = get();
    if (!evaluator || !gameState || isEvaluating) return;

    set({ isEvaluating: true, aiError: null });
    try {
      // Yield once so the button's "Evaluating…" state can render before the
      // synchronous forward pass blocks the main thread.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });

      const evaluation = evaluator.evaluate(
        JSON.stringify(gameState),
      ) as AiEvaluation;

      // A scenario may have been swapped while the model was running.
      if (get().gameState === gameState) {
        set({ evaluation, isEvaluating: false });
      } else {
        set({ isEvaluating: false });
      }
    } catch (err) {
      set({
        isEvaluating: false,
        aiError: err instanceof Error ? err.message : String(err),
      });
    }
  },

  clearEvaluation: () => set({ evaluation: null }),
}));
