/**
 * The deterministic full-board fixture shared by the Phase 4 tests and the
 * review script.
 *
 * It is a legal worst-case table: every seat has a hand, three seats have
 * calls, every pond is full with a Riichi tile and the walls are at their ten-
 * stack maximum. The paint-order snapshot over this board is committed at
 * `paint-order.json`; a layout or ordering change must show up as a diff there.
 *
 * Test-support code only: the app never imports this module.
 */
import { MAX_WALL_PAIRS_PER_SIDE, layoutBoard } from '../boardLayout';
import type {
  BoardLayout,
  BoardLayoutInput,
  MeldInput,
  PondDiscardInput,
  SeatHandInput,
  SeatSide,
} from '../boardLayout';
import type { ShellsManifest } from '../shellManifest';
import type { TileFaceId } from '../tiles';

/** A deterministic ring of faces, wide enough to be distinct per seat. */
export const FIXTURE_FACES: readonly TileFaceId[] = [
  '1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m',
  '1p', '2p', '3p', '4p', '5p', '6p', '7p', '8p', '9p',
  '1s', '2s', '3s', '4s', '5s', '6s', '7s', '8s', '9s',
  '1z', '2z', '3z', '4z', '5z', '6z', '7z',
];

export function fixtureMeld(
  kind: MeldInput['kind'],
  count: number,
  offset: number,
): MeldInput {
  return { kind, tiles: FIXTURE_FACES.slice(offset, offset + count) };
}

function fixturePond(offset: number, riichiIndex: number): PondDiscardInput[] {
  return Array.from({ length: 18 }, (_value, index) => ({
    face: FIXTURE_FACES[(offset + index) % FIXTURE_FACES.length],
    riichi: index === riichiIndex,
  }));
}

/** A full table: 13 concealed-equivalent tiles a seat, calls, full ponds. */
export function fullBoardInput(): BoardLayoutInput {
  const hands: Partial<Record<SeatSide, SeatHandInput>> = {
    top: { hand: FIXTURE_FACES.slice(0, 10), melds: [fixtureMeld('chi', 3, 6)] },
    left: { hand: FIXTURE_FACES.slice(0, 10), melds: [fixtureMeld('pon', 3, 6)] },
    right: { hand: FIXTURE_FACES.slice(0, 13) },
  };
  return {
    hand: FIXTURE_FACES.slice(0, 10),
    draw: '5p',
    melds: [fixtureMeld('pon', 3, 3)],
    hands,
    ponds: {
      bottom: fixturePond(0, 3),
      right: fixturePond(9, 8),
      top: fixturePond(18, 14),
      left: fixturePond(27, 0),
    },
    wallPairsPerSide: MAX_WALL_PAIRS_PER_SIDE,
  };
}

/** The fixture board, laid out with the committed shell manifest. */
export function fullBoardLayout(shells: ShellsManifest): BoardLayout {
  return layoutBoard(shells, fullBoardInput());
}
