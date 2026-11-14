/**
 * Adapt the engine's `GameState` to the pure 2.5D board layout.
 *
 * Phase 3's layout engine takes plain data (faces, Riichi flags, wall count) so
 * it has no dependency on game rules. This module is the single place that
 * turns a `GameState` into that data for Phase 4, using the same human-anchored
 * seat order as the top-down view: the human at the bottom, then shimocha,
 * toimen and kamicha.
 *
 * Every seat gets its concealed hand and its calls, because Phase 4 draws all
 * four hands: the human's face up, the opponents' with their face-down hand
 * shells. An opponent's faces travel in the layout but the atlas resolves every
 * face on a back shell to the same bare sprite, so nothing hidden is painted.
 */
import { tablePlacements } from '../seatOrder';
import type { GameState, MeldType, PlayerState } from '../types/game';
import { faceIdForTile } from './tiles';
import { MAX_WALL_PAIRS_PER_SIDE, layoutBoard } from './boardLayout';
import type {
  BoardLayout,
  MeldInput,
  MeldKind,
  PondDiscardInput,
  SeatHandInput,
  SeatSide,
} from './boardLayout';
import type { ShellsManifest } from './shellManifest';

/**
 * Two-tile wall stacks a side shows for the live wall.
 *
 * One stack layer is eight tiles (two per side), so `ceil(tiles_remaining / 8)`
 * is the thinnest symmetric representation of what is left. The dead wall is
 * not drawn. The board fits {@link MAX_WALL_PAIRS_PER_SIDE}.
 */
export function wallPairsForRemaining(tilesRemaining: number): number {
  if (!Number.isFinite(tilesRemaining) || tilesRemaining <= 0) return 0;
  return Math.min(MAX_WALL_PAIRS_PER_SIDE, Math.ceil(tilesRemaining / 8));
}

/** The layout's meld vocabulary, from the engine's `MeldType`. */
export function meldKindOf(meldType: MeldType): MeldKind {
  switch (meldType) {
    case 'Chi':
      return 'chi';
    case 'Pon':
      return 'pon';
    case 'Kan':
      return 'kan';
    case 'Ankan':
      return 'ankan';
    default:
      return 'pon';
  }
}

/** One seat's hand/melds as layout data. */
export function seatHandFromPlayer(player: PlayerState): SeatHandInput {
  const redFives = new Set(player.red_fives ?? []);
  const melds: MeldInput[] = (player.melds ?? []).map((meld) => ({
    kind: meldKindOf(meld.meld_type),
    // A called set carries no red-five flag, so its tiles map as plain faces.
    tiles: meld.tiles.map((tile) => faceIdForTile(tile)),
  }));
  return {
    hand: (player.hand ?? []).map((tile) => faceIdForTile(tile, redFives.has(tile))),
    draw: player.draw ? faceIdForTile(player.draw, redFives.has(player.draw)) : null,
    melds,
  };
}

/** Build the Phase 4 layout input from the scenario payload. */
export function boardLayoutFromState(
  shells: ShellsManifest,
  state: GameState,
): BoardLayout {
  const ponds: Partial<Record<SeatSide, PondDiscardInput[]>> = {};
  const hands: Partial<Record<SeatSide, SeatHandInput>> = {};
  for (const placement of tablePlacements(state.players)) {
    ponds[placement.side] = placement.player.discards.map((discard, index) => ({
      face: faceIdForTile(discard.tile, discard.is_red === true),
      riichi:
        discard.is_riichi === true || placement.player.riichi_discard_index === index,
    }));
    hands[placement.side] = seatHandFromPlayer(placement.player);
  }

  return layoutBoard(shells, {
    hands,
    ponds,
    wallPairsPerSide: wallPairsForRemaining(state.tiles_remaining),
  });
}
