import React, { useEffect, useState } from 'react';
import init, { generate_puzzle } from 'riichiprac';
import {
  RegularMan1,
  RegularMan2,
  RegularMan3,
  RegularMan4,
  RegularMan5,
  RegularMan6,
  RegularMan7,
  RegularMan8,
  RegularMan9,
  RegularPin1,
  RegularPin2,
  RegularPin3,
  RegularPin4,
  RegularPin5,
  RegularPin6,
  RegularPin7,
  RegularPin8,
  RegularPin9,
  RegularSou1,
  RegularSou2,
  RegularSou3,
  RegularSou4,
  RegularSou5,
  RegularSou6,
  RegularSou7,
  RegularSou8,
  RegularSou9,
  RegularTon,
  RegularNan,
  RegularShaa,
  RegularPei,
  RegularHaku,
  RegularHatsu,
  RegularChun,
  RegularBlank,
} from 'riichi-mahjong-tiles';
import './App.css';

// Map 34 standard Riichi Mahjong tile strings to riichi-mahjong-tiles SVG components
const TILE_MAP: Record<string, React.ComponentType<React.SVGProps<SVGSVGElement>>> = {
  '1m': RegularMan1,
  '2m': RegularMan2,
  '3m': RegularMan3,
  '4m': RegularMan4,
  '5m': RegularMan5,
  '6m': RegularMan6,
  '7m': RegularMan7,
  '8m': RegularMan8,
  '9m': RegularMan9,
  '1p': RegularPin1,
  '2p': RegularPin2,
  '3p': RegularPin3,
  '4p': RegularPin4,
  '5p': RegularPin5,
  '6p': RegularPin6,
  '7p': RegularPin7,
  '8p': RegularPin8,
  '9p': RegularPin9,
  '1s': RegularSou1,
  '2s': RegularSou2,
  '3s': RegularSou3,
  '4s': RegularSou4,
  '5s': RegularSou5,
  '6s': RegularSou6,
  '7s': RegularSou7,
  '8s': RegularSou8,
  '9s': RegularSou9,
  '1z': RegularTon,
  '2z': RegularNan,
  '3z': RegularShaa,
  '4z': RegularPei,
  '5z': RegularHaku,
  '6z': RegularHatsu,
  '7z': RegularChun,
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
        await init();
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
                const TileComponent = TILE_MAP[tileCode] || RegularBlank;
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
