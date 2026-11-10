import type { GameState } from '../types/game';
import { RiichiStick } from './RiichiStick';
import { Tile } from './Tile';

interface TableInfoProps {
  state: GameState;
}

/**
 * Global table state shown above the player rows: round/hand, honba, dora
 * indicators, riichi sticks, and the remaining tile count.
 */
export function TableInfo({ state }: TableInfoProps) {
  const doraLabel =
    state.dora_indicators.length === 1 ? 'Dora indicator' : 'Dora indicators';

  return (
    <section className="table-info" aria-label="Table information">
      <div className="table-stat">
        <span className="table-stat-label">Round</span>
        <span className="table-stat-value">
          {state.round_wind} {state.hand_number}
        </span>
      </div>

      <div className="table-stat">
        <span className="table-stat-label">Honba</span>
        <span className="table-stat-value">{state.honba}</span>
      </div>

      <div className="table-stat">
        <span className="table-stat-label">Tiles left</span>
        <span className="table-stat-value">{state.tiles_remaining}</span>
      </div>

      <div className="table-stat">
        <span className="table-stat-label">Riichi sticks</span>
        <span className="table-stat-value table-stat-value--stick">
          {state.riichi_sticks > 0 && (
            <RiichiStick className="table-riichi-stick" />
          )}
          <span>{state.riichi_sticks}</span>
        </span>
      </div>

      <div className="table-dora" aria-label={doraLabel}>
        <span className="table-stat-label">{doraLabel}</span>
        <div className="dora-tiles">
          {state.dora_indicators.map((tile, index) => (
            <Tile
              key={`${tile}-${index}`}
              code={tile}
              className="tile dora-tile"
            />
          ))}
        </div>
      </div>
    </section>
  );
}
