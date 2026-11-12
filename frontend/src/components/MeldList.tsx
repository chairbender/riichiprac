import { calledTile } from '../meld';
import type { CalledFrom } from '../meld';
import type { PlayerState } from '../types/game';
import { Tile } from './Tile';

/** Human-readable name for the seat a call came from. */
const CALLED_FROM_LABELS: Record<CalledFrom, string> = {
  left: 'the left player (kamicha)',
  across: 'the player across (toimen)',
  right: 'the right player (shimocha)',
};

interface MeldListProps {
  player: PlayerState;
}

/**
 * One player's open melds. The claimed tile is rendered sideways, the same way
 * the Riichi declaration tile is: its slot in the meld says which opponent
 * discarded it. Renders nothing at all for a hand that has not called, so the
 * caller does not need its own empty check.
 */
export function MeldList({ player }: MeldListProps) {
  if (player.melds.length === 0) return null;

  return (
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
  );
}
