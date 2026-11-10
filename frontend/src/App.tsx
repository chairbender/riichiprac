import { useEffect } from 'react';
import init, { generate_puzzle } from 'riichiprac';
import wasmUrl from 'riichiprac/riichiprac_bg.wasm?url';
import { HandDock } from './components/HandDock';
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
  const loadFromJson = useGameStore((state) => state.loadFromJson);
  const setError = useGameStore((state) => state.setError);

  useEffect(() => {
    let active = true;

    const setupWasm = async () => {
      try {
        await ensureWasmReady();
        if (!active) return;
        loadFromJson(generate_puzzle('phase2_table'));
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

  const handleNewHand = () => {
    try {
      loadFromJson(generate_puzzle('phase2_table'));
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
          <button className="new-hand-button" type="button" onClick={handleNewHand}>
            New Hand
          </button>
        )}
      </header>

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

      {humanPlayer && <HandDock player={humanPlayer} />}
    </div>
  );
};

export default App;
