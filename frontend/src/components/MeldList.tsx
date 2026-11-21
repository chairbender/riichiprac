import { calledTile } from '../meld';
import type { CalledFrom } from '../meld';
import type { PlayerState } from '../types/game';
import { Tile, TileBack } from './Tile';

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
 * discarded it.
 *
 * A closed kan (ankan) is concealed, so its two outer tiles are drawn face
 * down and only the two middle tiles show a face — the same rule the 3D board
 * follows (`renderers/snapshot.ts`). Every other meld stays face up, including
 * an open kan and an added kan (shouminkan).
 *
 * Renders nothing at all for a hand that has not called, so the caller does not
 * need its own empty check.
 */
export function MeldList({ player }: MeldListProps) {
  if (player.melds.length === 0) return null;

  return (
    <div className="melds" aria-label={`${player.name} melds`}>
      {player.melds.map((meld, meldIndex) => {
        const called = calledTile(meld, player.seat);
        const closedKan = meld.meld_type === 'Ankan';

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
              // A closed kan's ends are face down; its middle two show.
              const isFaceDown =
                closedKan &&
                (tileIndex === 0 || tileIndex === meld.tiles.length - 1);

              return (
                <span
                  key={`${tile}-${tileIndex}`}
                  className={`meld-slot${isCalled ? ' meld-slot--called' : ''}${
                    isFaceDown ? ' meld-slot--back' : ''
                  }`}
                >
                  {isFaceDown ? (
                    <TileBack className="tile meld-tile" />
                  ) : (
                    <Tile code={tile} className="tile meld-tile" />
                  )}
                </span>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
