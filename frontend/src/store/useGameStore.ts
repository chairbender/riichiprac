import { create } from 'zustand';
import type { GameState } from '../types/game';

export interface AnswerFeedback {
  isCorrect: boolean;
  selectedTile: string;
  correctTile: string;
}

interface GameStore {
  /** Parsed table state from the WASM `generate_puzzle` payload. */
  gameState: GameState | null;
  isLoading: boolean;
  error: string | null;
  /** Result of the player's discard choice, or null before answering. */
  feedback: AnswerFeedback | null;

  /** Parse and store a raw JSON payload returned by the WASM engine. */
  loadFromJson: (json: string) => void;
  /** Evaluate a clicked hand tile against the scenario's correct action. */
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
  feedback: null,
} satisfies Pick<GameStore, 'gameState' | 'isLoading' | 'error' | 'feedback'>;

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
        feedback: null,
      });
    } catch (err) {
      set({
        isLoading: false,
        error: err instanceof Error ? err.message : String(err),
        feedback: null,
      });
    }
  },

  selectTile: (tile) =>
    set((state) => {
      if (!state.gameState || state.feedback) return state;

      const { correct_action: correctAction } = state.gameState;
      if (correctAction.type !== 'discard') return state;

      return {
        feedback: {
          isCorrect: tile === correctAction.tile,
          selectedTile: tile,
          correctTile: correctAction.tile,
        },
      };
    }),

  reset: () => set(emptyState),

  setError: (error) => set({ isLoading: false, error, feedback: null }),
}));
