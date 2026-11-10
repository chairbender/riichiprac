import React, { useEffect, useState } from 'react';
import init, { generate_puzzle } from 'riichiprac';
import wasmUrl from 'riichiprac/riichiprac_bg.wasm?url';
import {
  RegularMan1M,
  RegularMan2M,
  RegularMan3M,
  RegularMan4M,
  RegularMan5M,
  RegularMan6M,
  RegularMan7M,
  RegularMan8M,
  RegularMan9M,
  RegularPin1M,
  RegularPin2M,
  RegularPin3M,
  RegularPin4M,
  RegularPin5M,
  RegularPin6M,
  RegularPin7M,
  RegularPin8M,
  RegularPin9M,
  RegularSou1M,
  RegularSou2M,
  RegularSou3M,
  RegularSou4M,
  RegularSou5M,
  RegularSou6M,
  RegularSou7M,
  RegularSou8M,
  RegularSou9M,
  RegularTonM,
  RegularNanM,
  RegularShaaM,
  RegularPeiM,
  RegularHakuM,
  RegularHatsuM,
  RegularChunM,
  RegularBlankM,
} from 'riichi-mahjong-tiles';
import './App.css';

// Map 34 standard Riichi Mahjong tile strings to riichi-mahjong-tiles merged SVG components
// (merged '...M' variants render the white/cream 3D tile body along with the symbol)
const TILE_MAP: Record<string, React.ComponentType<React.SVGProps<SVGSVGElement>>> = {
  '1m': RegularMan1M,
  '2m': RegularMan2M,
  '3m': RegularMan3M,
  '4m': RegularMan4M,
  '5m': RegularMan5M,
  '6m': RegularMan6M,
  '7m': RegularMan7M,
  '8m': RegularMan8M,
  '9m': RegularMan9M,
  '1p': RegularPin1M,
  '2p': RegularPin2M,
  '3p': RegularPin3M,
  '4p': RegularPin4M,
  '5p': RegularPin5M,
  '6p': RegularPin6M,
  '7p': RegularPin7M,
  '8p': RegularPin8M,
  '9p': RegularPin9M,
  '1s': RegularSou1M,
  '2s': RegularSou2M,
  '3s': RegularSou3M,
  '4s': RegularSou4M,
  '5s': RegularSou5M,
  '6s': RegularSou6M,
  '7s': RegularSou7M,
  '8s': RegularSou8M,
  '9s': RegularSou9M,
  '1z': RegularTonM,
  '2z': RegularNanM,
  '3z': RegularShaaM,
  '4z': RegularPeiM,
  '5z': RegularHakuM,
  '6z': RegularHatsuM,
  '7z': RegularChunM,
};

interface PuzzleData {
  category: string;
  hand_string: string;
  tiles: string[];
  shanten: number;
  is_agari: boolean;
  decompositions_count: number;
  ukeire_tiles: string[];
  ukeire_total: number;
}

export const App: React.FC = () => {
  const [puzzle, setPuzzle] = useState<PuzzleData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [wasmReady, setWasmReady] = useState<boolean>(false);

  const fetchHand = () => {
    try {
      const jsonStr = generate_puzzle('hello_world');
      const data: PuzzleData = JSON.parse(jsonStr);
      setPuzzle(data);
      setError(null);
    } catch (err) {
      console.error('Failed to generate hand:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    async function setupWasm() {
      try {
        await init({ module_or_path: wasmUrl });
        setWasmReady(true);
        const jsonStr = generate_puzzle('hello_world');
        const data: PuzzleData = JSON.parse(jsonStr);
        setPuzzle(data);
      } catch (err) {
        console.error('Failed to initialize WASM module:', err);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    }

    setupWasm();
  }, []);

  return (
    <div className="container">
      <header className="header">
        <h1>Riichi Mahjong Trainer</h1>
        <p className="subtitle">Phase 1: WASM Pipeline Verification</p>
      </header>

      <main className="main-content">
        {loading && <div className="status-msg">Initializing WASM module...</div>}
        {error && <div className="error-msg">Error: {error}</div>}

        {puzzle && (
          <div className="puzzle-card">
            <div className="info-bar">
              <span className="badge">Notation: {puzzle.hand_string}</span>
              <span className="badge">
                Shanten: {puzzle.shanten === -1 ? 'Agari (Complete)' : puzzle.shanten}
              </span>
              <span className="badge">Decompositions: {puzzle.decompositions_count}</span>
            </div>

            <div className="tiles-container">
              {puzzle.tiles.map((tileCode, idx) => {
                const TileComponent = TILE_MAP[tileCode] || RegularBlankM;
                return (
                  <div key={`${tileCode}-${idx}`} className="tile-wrapper">
                    <TileComponent className="tile-svg" />
                    <span className="tile-label">{tileCode}</span>
                  </div>
                );
              })}
            </div>

            <div className="action-row">
              <button
                className="btn-primary"
                onClick={fetchHand}
                disabled={!wasmReady}
              >
                Generate Another Hand
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default App;
