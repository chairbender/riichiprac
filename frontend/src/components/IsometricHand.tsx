import { redFiveFlags } from '../display';
import { handSlots } from '../iso';
import type { ToScreen } from '../iso';
import type { TableSide } from '../seatOrder';
import type { PlayerState } from '../types/game';
import { IsometricTile } from './IsometricTile';

interface IsometricHandProps {
  /** The player whose concealed tiles are on the table. */
  player: PlayerState;
  /**
   * The edge the player sits on. The human's seat is `bottom`, and only the
   * bottom seat has been laid out so far; opponents' concealed hands are a
   * later part.
   */
  side?: TableSide;
  /** The fitted table projection. */
  toScreen: ToScreen;
}

/**
 * A player's concealed hand, standing on the table in front of their seat.
 *
 * The tiles stand upright and are read exactly as the top-down dock reads them:
 * the same concealed hand in the same order, with the drawn tile set apart on
 * the seat's right. The ordinary 3:4 `Tile` artwork is used verbatim, including
 * the red-five variants and the honour tiles, so the two views cannot show a
 * different hand.
 *
 * The hand's geometry — how many slots, where each face sits, and which way the
 * seat reads — comes from `handSlots` in tile units, so the row scales with the
 * fitted table and a shorter hand after a call keeps the same left edge.
 */
export function IsometricHand({
  player,
  side = 'bottom',
  toScreen,
}: IsometricHandProps) {
  const slots = handSlots(side, player.hand.length, player.draw !== null);
  const tiles = player.draw ? [...player.hand, player.draw] : player.hand;
  const flags = redFiveFlags(tiles, player.red_fives);

  const label = `Your hand, ${tiles.length} tile${
    tiles.length === 1 ? '' : 's'
  }${player.is_riichi ? ', riichi' : ''}`;

  return (
    <g
      className={`iso-hand iso-hand--${side}${
        player.is_riichi ? ' iso-hand--riichi' : ''
      }`}
      role="group"
      aria-label={label}
    >
      {slots.map((slot) => {
        // The draw is appended after the concealed tiles, so its red-five flag
        // is the one just past the hand.
        const tileIndex = slot.isDraw ? player.hand.length : slot.index;
        const code = tiles[tileIndex];
        if (!code) return null;

        return (
          <IsometricTile
            key={`${code}-${tileIndex}`}
            code={code}
            isRedFive={flags[tileIndex]}
            centre={slot.centre}
            rotation={slot.rotation}
            toScreen={toScreen}
            isDraw={slot.isDraw}
          />
        );
      })}
    </g>
  );
}
