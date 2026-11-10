import { create } from 'zustand';
import type { CorrectActionType, GameState } from '../types/game';

export interface AnswerFeedback {
  /** True only when both the action type and discard tile are correct. */
  isCorrect: boolean;
  /** Whether the player submitted Riichi or Dama. */
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
  /** Result of the player's action + discard choice, or null before answering. */
  feedback: AnswerFeedback | null;

  /** Parse and store a raw JSON payload returned by the WASM engine. */
  loadFromJson: (json: string) => void;
  /** Arm or disarm the Riichi declaration before choosing a discard. */
  toggleRiichi: () => void;
  /** Submit the toggle state and clicked hand tile as one answer. */
  selectTile: (tile: string) => void;
  /** Clear the current table and answer before loading the next scenario. */
  reset: () => void;
  setError: (error: string) => void;
}

interface WasmErrorPayload {
  error?: string;
}

const emptyState = {
  gameState: null,
  isLoading: true,
  error: null,
  callRiichi: false,
  feedback: null,
} satisfies Pick<
  GameStore,
  'gameState' | 'isLoading' | 'error' | 'callRiichi' | 'feedback'
>;

export const useGameStore = create<GameStore>((set) => ({
  ...emptyState,

  loadFromJson: (json) => {
    try {
      const parsed = JSON.parse(json) as GameState & WasmErrorPayload;

      if (parsed.error) {
        throw new Error(parsed.error);
      }
      if (!Array.isArray(parsed.players) || parsed.players.length !== 4) {
        throw new Error('WASM returned an invalid table state');
      }

      set({
        gameState: parsed,
        isLoading: false,
        error: null,
        callRiichi: false,
        feedback: null,
      });
    } catch (err) {
      set({
        isLoading: false,
        error: err instanceof Error ? err.message : String(err),
        callRiichi: false,
        feedback: null,
      });
    }
  },

  toggleRiichi: () =>
    set((state) => {
      if (!state.gameState || state.feedback) return state;
      return { callRiichi: !state.callRiichi };
    }),

  selectTile: (tile) =>
    set((state) => {
      if (!state.gameState || state.feedback) return state;

      const { correct_action: correctAction } = state.gameState;
      const selectedType: CorrectActionType = state.callRiichi
        ? 'riichi'
        : 'dama';
      const isActionCorrect = selectedType === correctAction.type;
      const isTileCorrect = tile === correctAction.discard;

      return {
        feedback: {
          isCorrect: isActionCorrect && isTileCorrect,
          selectedType,
          correctType: correctAction.type,
          isActionCorrect,
          selectedTile: tile,
          correctTile: correctAction.discard,
          isTileCorrect,
        },
      };
    }),

  reset: () => set(emptyState),

  setError: (error) =>
    set({ isLoading: false, error, callRiichi: false, feedback: null }),
}));
