import type { CSSProperties } from 'react';
import { SIDE_ROTATION, TABLE_SIDES, tablePlacements } from '../seatOrder';
import type { SeatPlacement, TableSide } from '../seatOrder';
import type { GameState, PlayerState, Wind } from '../types/game';
import { MeldList } from './MeldList';
import { RiichiStick } from './RiichiStick';
import { River } from './River';

/** Where each edge of the table sits, as the human reads the screen. */
const SIDE_LABELS: Record<TableSide, string> = {
  bottom: 'your seat, at the bottom',
  right: 'right side, shimocha',
  top: 'across, toimen',
  left: 'left side, kamicha',
};

/**
 * One letter per seat wind, the same shorthand the tile codes use for the four
 * honour tiles (`1z`..`4z`). The compass is the only place on the table that
 * carries text, so each seat's name has to fit in one glyph.
 */
const WIND_LETTERS: Record<Wind, string> = {
  East: 'E',
  South: 'S',
  West: 'W',
  North: 'N',
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
     * The corner is a picture of the player's place, not prose: the wind glyph
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
      <span className="compass-figure">
        <span className="compass-wind">{WIND_LETTERS[player.wind]}</span>
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
 * compass in the middle, so the edges of the table only hold tiles. A river
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
