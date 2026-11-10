import { useEffect } from 'react';
import init, { generate_puzzle } from 'riichiprac';
import wasmUrl from 'riichiprac/riichiprac_bg.wasm?url';
import { HandDock } from './components/HandDock';
import { FeedbackToast } from './components/FeedbackToast';
import { PlayerRow } from './components/PlayerRow';
import { TableInfo } from './components/TableInfo';
import { useGameStore } from './store/useGameStore';
import './App.css';

/**
 * Portrait rows from top to bottom:
 * Toimen (across), Kamicha (left), Shimocha (right), then the human.
 */
const PLAYER_ROW_ORDER = [2, 3, 1, 0];

let wasmInitPromise: ReturnType<typeof init> | null = null;

function ensureWasmReady(): ReturnType<typeof init> {
  wasmInitPromise ??= init({ module_or_path: wasmUrl });
  return wasmInitPromise;
}

export const App = () => {
  const gameState = useGameStore((state) => state.gameState);
  const isLoading = useGameStore((state) => state.isLoading);
  const error = useGameStore((state) => state.error);
  const feedback = useGameStore((state) => state.feedback);
  const loadFromJson = useGameStore((state) => state.loadFromJson);
  const selectTile = useGameStore((state) => state.selectTile);
  const reset = useGameStore((state) => state.reset);
  const setError = useGameStore((state) => state.setError);

  useEffect(() => {
    let active = true;

    const setupWasm = async () => {
      try {
        await ensureWasmReady();
        if (!active) return;
        loadFromJson(generate_puzzle('ryanmen_protorun'));
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    };

    void setupWasm();

    return () => {
      active = false;
    };
  }, [loadFromJson, setError]);

  const handleNextScenario = () => {
    reset();
    try {
      loadFromJson(generate_puzzle('ryanmen_protorun'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1 className="app-title">Riichi Trainer</h1>
        {gameState && (
          <button
            className="new-hand-button"
            type="button"
            onClick={handleNextScenario}
          >
            Next Scenario
          </button>
        )}
      </header>

      {feedback && <FeedbackToast feedback={feedback} />}

      {gameState && <TableInfo state={gameState} />}

      <main className="table-stack">
        {isLoading && <div className="status-msg">Loading table…</div>}
        {error && (
          <div className="error-msg" role="alert">
            {error}
          </div>
        )}

        {orderedPlayers.map((player) => (
          <PlayerRow key={player.seat} player={player} />
        ))}
      </main>

      {humanPlayer && (
        <HandDock
          player={humanPlayer}
          feedback={feedback}
          onSelectTile={selectTile}
        />
      )}
    </div>
  );
};

export default App;
