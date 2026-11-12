import { calledTile } from '../meld';
import type { CalledFrom } from '../meld';
import type { PlayerState } from '../types/game';
import { RiichiStick } from './RiichiStick';
import { Tile } from './Tile';

interface PlayerRowProps {
  player: PlayerState;
  /** Highlight the newest discard as the tile being called/ronned. */
  highlightLastDiscard?: boolean;
}

/** Human-readable name for the seat a call came from. */
const CALLED_FROM_LABELS: Record<CalledFrom, string> = {
  left: 'the left player (kamicha)',
  across: 'the player across (toimen)',
  right: 'the right player (shimocha)',
};

/**
 * One player's vertically stacked row: wind, score, Riichi marker, open melds,
 * and the discard river. The Riichi declaration tile and a Pon's called tile
 * are rendered sideways, and tsumogiri discards (thrown straight off the draw)
 * carry a dot marker.
 */
export function PlayerRow({
  player,
  highlightLastDiscard = false,
}: PlayerRowProps) {
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
            {player.melds.map((meld, meldIndex) => {
              const called = calledTile(meld, player.seat);

              return (
                <div
                  key={`${meld.meld_type}-${meldIndex}`}
                  className="meld"
                  aria-label={`${meld.meld_type} meld${
                    called
                      ? `, called tile taken from ${CALLED_FROM_LABELS[called.from]}`
                      : ''
                  }`}
                >
                  <span className="meld-label">{meld.meld_type}</span>
                  {meld.tiles.map((tile, tileIndex) => {
                    const isCalled = called?.index === tileIndex;

                    return (
                      <span
                        key={`${tile}-${tileIndex}`}
                        className={`meld-slot${isCalled ? ' meld-slot--called' : ''}`}
                      >
                        <Tile code={tile} className="tile meld-tile" />
                      </span>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}

        <div className="river" aria-label={`${player.name} discards`}>
          {player.discards.map((discard, index) => {
            const isRiichiDiscard =
              discard.is_riichi || player.riichi_discard_index === index;
            const isClaimed =
              highlightLastDiscard && index === player.discards.length - 1;
            const isTsumogiri = discard.is_tsumogiri;

            return (
              <div
                key={`${discard.tile}-${index}`}
                className={`river-slot${isRiichiDiscard ? ' river-slot--riichi' : ''}${
                  isClaimed ? ' river-slot--claim' : ''
                }${isTsumogiri ? ' river-slot--tsumogiri' : ''}`}
                title={
                  isTsumogiri
                    ? `${discard.tile} — tsumogiri (discarded straight from the draw)`
                    : undefined
                }
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
