import { create } from 'zustand';
import type { GameState } from '../types/game';

interface GameStore {
  /** Parsed table state from the WASM `generate_puzzle` payload. */
  gameState: GameState | null;
  isLoading: boolean;
  error: string | null;

  /** Parse and store a raw JSON payload returned by the WASM engine. */
  loadFromJson: (json: string) => void;
  setError: (error: string) => void;
}

interface WasmErrorPayload {
  error?: string;
}

export const useGameStore = create<GameStore>((set) => ({
  gameState: null,
  isLoading: true,
  error: null,

  loadFromJson: (json) => {
    try {
      const parsed = JSON.parse(json) as GameState & WasmErrorPayload;

      if (parsed.error) {
        throw new Error(parsed.error);
      }
      if (!Array.isArray(parsed.players) || parsed.players.length !== 4) {
        throw new Error('WASM returned an invalid table state');
      }

      set({ gameState: parsed, isLoading: false, error: null });
    } catch (err) {
      set({
        isLoading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  setError: (error) => set({ isLoading: false, error }),
}));
