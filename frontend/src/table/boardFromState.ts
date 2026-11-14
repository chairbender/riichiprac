/**
 * Adapt the engine's `GameState` to the pure 2.5D board layout.
 *
 * Phase 3's layout engine takes plain data (faces, Riichi flags, wall count) so
 * it has no dependency on game rules. This module is the single place that
 * turns a `GameState` into that data for Phase 4, using the same human-anchored
 * seat order as the top-down view: the human at the bottom, then shimocha,
 * toimen and kamicha.
 */
import { tablePlacements } from '../seatOrder';
import type { GameState } from '../types/game';
import { faceIdForTile } from './tiles';
import { MAX_WALL_PAIRS_PER_SIDE, layoutBoard } from './boardLayout';
import type { BoardLayout, PondDiscardInput, SeatSide } from './boardLayout';
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

/** Build the Phase 4 layout input from the scenario payload. */
export function boardLayoutFromState(
  shells: ShellsManifest,
  state: GameState,
): BoardLayout {
  const ponds: Partial<Record<SeatSide, PondDiscardInput[]>> = {};
  for (const placement of tablePlacements(state.players)) {
    ponds[placement.side] = placement.player.discards.map((discard, index) => ({
      face: faceIdForTile(discard.tile, discard.is_red === true),
      riichi:
        discard.is_riichi === true || placement.player.riichi_discard_index === index,
    }));
  }

  const human = state.players.find((player) => player.is_human) ?? null;
  const redFives = new Set(human?.red_fives ?? []);
  const hand = (human?.hand ?? []).map((tile) => faceIdForTile(tile, redFives.has(tile)));
  const draw = human?.draw ? faceIdForTile(human.draw, redFives.has(human.draw)) : null;

  return layoutBoard(shells, {
    hand,
    draw,
    ponds,
    wallPairsPerSide: wallPairsForRemaining(state.tiles_remaining),
  });
}
