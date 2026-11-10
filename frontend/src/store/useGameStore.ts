import { create } from 'zustand';
import {
  correctActionTile,
  findKanCandidateTile,
  isCorrectAction,
  isKanDecision,
} from '../actions';
import type { CorrectActionType, GameState } from '../types/game';

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
}

interface WasmErrorPayload {
  error?: string;
}

const emptyState = {
  gameState: null,
  isLoading: true,
  error: null,
  callRiichi: false,
  callKan: false,
  feedback: null,
} satisfies Pick<
  GameStore,
  'gameState' | 'isLoading' | 'error' | 'callRiichi' | 'callKan' | 'feedback'
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
      });
    } catch (err) {
      set({
        isLoading: false,
        error: err instanceof Error ? err.message : String(err),
        callRiichi: false,
        callKan: false,
        feedback: null,
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
    }),
}));
