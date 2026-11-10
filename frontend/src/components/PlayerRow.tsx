import type { PlayerState } from '../types/game';
import { RiichiStick } from './RiichiStick';
import { Tile } from './Tile';

interface PlayerRowProps {
  player: PlayerState;
}

/**
 * One player's vertically stacked row: wind, score, Riichi marker, open melds,
 * and the discard river. The Riichi declaration tile is rendered sideways.
 */
export function PlayerRow({ player }: PlayerRowProps) {
  return (
    <section
      className={`player-row${player.is_human ? ' player-row--human' : ''}${
        player.is_riichi ? ' player-row--riichi' : ''
      }`}
      aria-label={`${player.name}, ${player.wind} wind, ${player.score} points${
        player.is_riichi ? ', riichi' : ''
      }`}
    >
      <div className="player-meta">
        <span className="wind-badge">{player.wind}</span>
        <span className="player-score">{player.score.toLocaleString('en-US')}</span>
        {player.is_riichi && <RiichiStick className="riichi-stick" />}
      </div>

      <div className="player-tiles">
        {player.melds.length > 0 && (
          <div className="melds" aria-label={`${player.name} melds`}>
            {player.melds.map((meld, meldIndex) => (
              <div
                key={`${meld.meld_type}-${meldIndex}`}
                className="meld"
                aria-label={`${meld.meld_type} meld`}
              >
                <span className="meld-label">{meld.meld_type}</span>
                {meld.tiles.map((tile, tileIndex) => (
                  <Tile
                    key={`${tile}-${tileIndex}`}
                    code={tile}
                    className="tile meld-tile"
                  />
                ))}
              </div>
            ))}
          </div>
        )}

        <div className="river" aria-label={`${player.name} discards`}>
          {player.discards.map((discard, index) => {
            const isRiichiDiscard =
              discard.is_riichi || player.riichi_discard_index === index;

            return (
              <div
                key={`${discard.tile}-${index}`}
                className={`river-slot${isRiichiDiscard ? ' river-slot--riichi' : ''}`}
              >
                <Tile code={discard.tile} className="tile river-tile" />
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
