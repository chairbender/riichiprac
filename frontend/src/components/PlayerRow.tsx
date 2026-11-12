import type { PlayerState } from '../types/game';
import { MeldList } from './MeldList';
import { RiichiStick } from './RiichiStick';
import { River } from './River';

interface PlayerRowProps {
  player: PlayerState;
  /** Highlight the newest discard as the tile being called/ronned. */
  highlightLastDiscard?: boolean;
}

/**
 * One player's vertically stacked row: wind, score, Riichi marker, open melds,
 * and the discard river. The Riichi declaration tile and a call's claimed tile
 * (Chi, Pon, open Kan) are rendered sideways, and tsumogiri discards (thrown
 * straight off the draw) carry a dot marker.
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
        <MeldList player={player} />
        <River player={player} highlightLastDiscard={highlightLastDiscard} />
      </div>
    </section>
  );
}
