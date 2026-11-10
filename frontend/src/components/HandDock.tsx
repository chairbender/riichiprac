import type { PlayerState } from '../types/game';
import { Tile } from './Tile';

interface HandDockProps {
  player: PlayerState;
}

/**
 * The human player's active hand, pinned to the bottom of the viewport so the
 * 14 tiles stay reachable with a thumb on a portrait phone.
 */
export function HandDock({ player }: HandDockProps) {
  const tiles = player.draw ? [...player.hand, player.draw] : player.hand;

  return (
    <section className="hand-dock" aria-label="Your hand">
      <div className="hand-dock-label">Your Hand</div>
      <div
        className="hand"
        style={{ gridTemplateColumns: `repeat(${tiles.length}, minmax(0, 1fr))` }}
      >
        {tiles.map((tile, index) => (
          <Tile key={`${tile}-${index}`} code={tile} className="tile hand-tile" />
        ))}
      </div>
    </section>
  );
}
