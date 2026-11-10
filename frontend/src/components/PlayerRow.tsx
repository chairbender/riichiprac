import type { PlayerState } from '../types/game';
import { Tile } from './Tile';

interface PlayerRowProps {
  player: PlayerState;
}

/**
 * One player's vertically stacked row. For now this intentionally shows only
 * the seat wind and the discard river; scores, melds, and Riichi visuals are
 * added in the next UI phase.
 */
export function PlayerRow({ player }: PlayerRowProps) {
  return (
    <section
      className={`player-row${player.is_human ? ' player-row--human' : ''}`}
      aria-label={`${player.name}, ${player.wind} wind`}
    >
      <div className="player-wind">
        <span className="wind-badge">{player.wind}</span>
      </div>

      <div className="river" aria-label={`${player.name} discards`}>
        {player.discards.map((discard, index) => (
          <Tile
            key={`${discard.tile}-${index}`}
            code={discard.tile}
            className="tile river-tile"
          />
        ))}
      </div>
    </section>
  );
}
