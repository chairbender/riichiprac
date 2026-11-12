import type { PlayerState } from '../types/game';
import { Tile } from './Tile';

interface RiverProps {
  player: PlayerState;
  /** Highlight the newest discard as the tile being called/ronned. */
  highlightLastDiscard?: boolean;
}

/**
 * One player's discard river, oldest tile first. Riichi declaration tiles are
 * turned sideways and tsumogiri discards (thrown straight off the draw) carry
 * a dot marker.
 */
export function River({ player, highlightLastDiscard = false }: RiverProps) {
  return (
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
  );
}
