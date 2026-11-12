import type { CSSProperties } from 'react';
import { SIDE_ROTATION, TABLE_SIDES, tablePlacements } from '../seatOrder';
import type { SeatPlacement, TableSide } from '../seatOrder';
import type { GameState, PlayerState, Wind } from '../types/game';
import { MeldList } from './MeldList';
import { RiichiStick } from './RiichiStick';
import { River } from './River';
import { Tile } from './Tile';

/** Where each edge of the table sits, as the human reads the screen. */
const SIDE_LABELS: Record<TableSide, string> = {
  bottom: 'your seat, at the bottom',
  right: 'right side, shimocha',
  top: 'across, toimen',
  left: 'left side, kamicha',
};

/**
 * The wind tile that shows a seat's wind on the compass: the same four honour
 * tile codes (`1z`..`4z`) the engine uses, so the compass draws the real tile
 * rather than a Latin initial.
 */
const WIND_TILES: Record<Wind, string> = {
  East: '1z',
  South: '2z',
  West: '3z',
  North: '4z',
};

interface PhysicalTableProps {
  state: GameState;
  /**
   * Seat whose newest discard is the tile being called or ronned, so the river
   * can mark it. `null` when nothing is being claimed.
   */
  highlightLastDiscard?: number | null;
}

/**
 * A player's place in the middle of the table, as the compass shows it: the
 * wind and score facing that player, with their Riichi stick on the side of
 * the compass nearest the centre, the way an automatic table's centre display
 * puts the declaration in front of the player who made it.
 */
function CompassSeat({
  player,
  side,
}: {
  player: PlayerState;
  side: TableSide;
}) {
  return (
    /*
     * The corner is a picture of the player's place, not prose: the wind tile
     * and the score are the accessible name, so they are not read twice.
     */
    <div
      role="img"
      aria-label={`${player.wind} wind, ${player.score} points${
        player.is_riichi ? ', riichi' : ''
      }`}
      className={`compass-player compass-player--${side}${
        player.is_human ? ' compass-player--human' : ''
      }`}
    >
      {/*
       * Turn the figure with its seat, exactly like the tiles on that edge:
       * every player reads their own wind tile and score upright from where
       * they sit, as they would on an automatic table's centre display.
       */}
      <span
        className="compass-figure"
        style={{ transform: `rotate(${SIDE_ROTATION[side]}deg)` }}
      >
        <Tile code={WIND_TILES[player.wind]} className="compass-wind" />
        <span className="compass-score">
          {player.score.toLocaleString('en-US')}
        </span>
      </span>
      {player.is_riichi && <RiichiStick className="compass-stick" />}
    </div>
  );
}

/**
 * A flat plan view of the table: the human at the bottom edge, shimocha on the
 * right, toimen at the top, and kamicha on the left, with each river starting
 * at the corner nearest the middle of the table.
 *
 * The view is deliberately top-down only — no perspective, vanishing point, or
 * camera tilt — so it stays a 2D diagram of where the seats and discards are.
 * Each seat's tiles are turned to face their owner (`--seat-rotation`), which
 * is why a side river's tiles read sideways on screen.
 *
 * Nothing is written on a seat itself: wind, score, and Riichi are all on the
 * compass in the middle, so the edges of the table only hold tiles. Every
 * compass corner is turned to its own seat, and its Riichi stick lies along the
 * player's edge, as an automatic table's centre display would show it. A river
 * starts at the corner nearest the centre and runs across its player's view,
 * filling towards that player; melds sit on the player's right and stack away
 * from them. The human's concealed hand is not drawn here either: it is the
 * docked hand below the table, where it can be tapped.
 */
export function PhysicalTable({
  state,
  highlightLastDiscard = null,
}: PhysicalTableProps) {
  const seats: Record<TableSide, SeatPlacement[]> = {
    bottom: [],
    right: [],
    top: [],
    left: [],
  };
  for (const placement of tablePlacements(state.players)) {
    seats[placement.side].push(placement);
  }

  return (
    <div
      className="physical-table"
      role="group"
      aria-label="Table, viewed from above"
    >
      {TABLE_SIDES.map((side) => (
        <section
          key={side}
          className={`table-seat table-seat--${side}`}
          style={
            {
              '--seat-rotation': `${SIDE_ROTATION[side]}deg`,
            } as CSSProperties
          }
        >
          {seats[side].map((placement, index) => (
            <div
              key={`${placement.player.seat}-${index}`}
              role="group"
              className="table-seat-player"
              aria-label={`${SIDE_LABELS[side]}, ${placement.player.name}`}
            >
              <div className="table-seat-body">
                <River
                  player={placement.player}
                  highlightLastDiscard={
                    highlightLastDiscard === placement.player.seat
                  }
                />
                <MeldList player={placement.player} />
              </div>
            </div>
          ))}
        </section>
      ))}

      {/*
       * The compass stands in the middle of the table: one wind and score
       * facing each seat, the round and wall count in the middle, and a Riichi
       * stick beside the declaring player's corner.
       */}
      <div className="physical-center" role="group" aria-label="Compass">
        {TABLE_SIDES.map((side) => (
          <div
            key={side}
            role="group"
            className={`compass-seat compass-seat--${side}`}
            aria-label={SIDE_LABELS[side]}
          >
            {seats[side].map((placement, index) => (
              <CompassSeat
                key={`${placement.player.seat}-${index}`}
                player={placement.player}
                side={side}
              />
            ))}
          </div>
        ))}

        <div className="compass-wall">
          <span className="compass-round">
            {state.round_wind} {state.hand_number}
          </span>
          <span className="compass-wall-count">{state.tiles_remaining}</span>
          <span className="compass-wall-label">wall</span>
        </div>
      </div>
    </div>
  );
}
