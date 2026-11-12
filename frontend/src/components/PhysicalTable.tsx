import type { CSSProperties } from 'react';
import { SIDE_ROTATION, TABLE_SIDES, tablePlacements } from '../seatOrder';
import type { SeatPlacement, TableSide } from '../seatOrder';
import type { GameState } from '../types/game';
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

interface PhysicalTableProps {
  state: GameState;
  /**
   * Seat whose newest discard is the tile being called or ronned, so the river
   * can mark it. `null` when nothing is being claimed.
   */
  highlightLastDiscard?: number | null;
}

/**
 * A flat plan view of the table: the human at the bottom edge, shimocha on the
 * right, toimen at the top, and kamicha on the left, with each river running
 * from its player toward the centre of the table.
 *
 * The view is deliberately top-down only — no perspective, vanishing point, or
 * camera tilt — so it stays a 2D diagram of where the seats and discards are.
 * Each seat's tiles are turned to face their owner (`--seat-rotation`), which
 * is why a side river's tiles read sideways on screen.
 *
 * The human's concealed hand is not drawn here: it is the docked hand below
 * the table, where it can be tapped. Opponents' hands are hidden information
 * and were never drawn by the stacked rows either, so only melds and rivers
 * appear on their edges.
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
              className={`table-seat-player${
                placement.player.is_human ? ' table-seat-player--human' : ''
              }`}
              aria-label={`${SIDE_LABELS[side]}, ${placement.player.name}, ${
                placement.player.wind
              } wind, ${placement.player.score} points${
                placement.player.is_riichi ? ', riichi' : ''
              }`}
            >
              <div className="table-seat-meta">
                <span className="wind-badge">{placement.player.wind}</span>
                <span className="player-score">
                  {placement.player.score.toLocaleString('en-US')}
                </span>
                {placement.player.is_riichi && (
                  <RiichiStick className="riichi-stick" />
                )}
              </div>

              <div className="table-seat-body">
                <MeldList player={placement.player} />
                <River
                  player={placement.player}
                  highlightLastDiscard={
                    highlightLastDiscard === placement.player.seat
                  }
                />
              </div>
            </div>
          ))}
        </section>
      ))}

      {/* The wall sits in the middle of the table, so its count does too. */}
      <div className="physical-center" aria-hidden="true">
        <span className="physical-center-round">
          {state.round_wind} {state.hand_number}
        </span>
        <span className="physical-center-wall">{state.tiles_remaining}</span>
        <span className="physical-center-label">wall</span>
      </div>
    </div>
  );
}
