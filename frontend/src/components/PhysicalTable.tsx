import type { ComponentType, CSSProperties, SVGProps } from 'react';
import {
  RegularNan,
  RegularPei,
  RegularShaa,
  RegularTon,
} from 'riichi-mahjong-tiles';
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

type WindGlyph = ComponentType<SVGProps<SVGSVGElement>>;

/**
 * The wind symbol for each seat, drawn without a tile body: the compass only
 * needs the glyph, and the symbol is recoloured to read on the dark panel.
 */
const WIND_GLYPHS: Record<Wind, WindGlyph> = {
  East: RegularTon,
  South: RegularNan,
  West: RegularShaa,
  North: RegularPei,
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
 * A player's place in the middle of the table, as the compass shows it. The
 * stack runs from the centre outwards — wind symbol, score, then Riichi stick —
 * and the whole stack turns with its seat, so every player reads it upright
 * and the stick lies along their own edge, closest to them.
 */
function CompassSeat({
  player,
  side,
}: {
  player: PlayerState;
  side: TableSide;
}) {
  const WindGlyph = WIND_GLYPHS[player.wind];

  return (
    /*
     * The corner is a picture of the player's place, not prose: the wind
     * symbol and the score are the accessible name, so they are not read twice.
     */
    <div
      role="img"
      aria-label={`${player.wind} wind, ${player.score} points${
        player.is_riichi ? ', riichi' : ''
      }`}
      className={`compass-player compass-player--${side}${
        player.is_human ? ' compass-player--human' : ''
      }`}
      /*
       * Turn the whole stack with its seat, exactly like the tiles on that
       * edge: the wind sits nearest the middle, the score next, and the Riichi
       * stick lands on the player's side of the compass, lengthways.
       */
      style={{ transform: `rotate(${SIDE_ROTATION[side]}deg)` }}
    >
      <WindGlyph
        className="compass-wind"
        aria-hidden="true"
        focusable="false"
      />
      <span className="compass-score">
        {player.score.toLocaleString('en-US')}
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
 * compass corner is turned to its own seat, reading wind, score, and then
 * Riichi stick from the middle outwards. A river
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
       * The compass stands in the middle of the table: one wind, score, and
       * Riichi stick facing each seat, with the round and remaining tile count
       * in the middle.
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

        <div
          className="compass-wall"
          role="group"
          aria-label={`Round ${state.round_wind} ${state.hand_number}, ${state.tiles_remaining} tiles remaining`}
        >
          <span className="compass-round">
            {state.round_wind} {state.hand_number}
          </span>
          <span className="compass-wall-count">{state.tiles_remaining}</span>
        </div>
      </div>
    </div>
  );
}
