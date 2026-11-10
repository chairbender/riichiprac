import type {
  CorrectAction,
  CorrectActionType,
  PlayerState,
} from './types/game';

const CORRECT_ACTION_TYPES: CorrectActionType[] = [
  'riichi',
  'dama',
  'kan',
  'discard',
];

/** Validate the `correct_action` payload before it reaches the store. */
export function isCorrectAction(value: unknown): value is CorrectAction {
  if (!value || typeof value !== 'object') return false;

  const action = value as {
    type?: unknown;
    discard?: unknown;
    tile?: unknown;
  };
  if (!CORRECT_ACTION_TYPES.includes(action.type as CorrectActionType)) {
    return false;
  }

  return action.type === 'riichi' || action.type === 'dama'
    ? typeof action.discard === 'string'
    : typeof action.tile === 'string';
}

/** Whether the payload belongs to the Kan (Shouminkan) lesson. */
export function isKanDecision(action: CorrectAction): boolean {
  return action.type === 'kan' || action.type === 'discard';
}

/** The tile the player must click for the answer: discard or Kan tile. */
export function correctActionTile(action: CorrectAction): string {
  return 'discard' in action ? action.discard : action.tile;
}

/**
 * The fourth tile of an open Pon held in the hand or draw, if any.
 *
 * The call is only offered when the board makes it legal, so a "do not Kan"
 * puzzle still shows the button and lets the player make the mistake.
 */
export function findKanCandidateTile(player: PlayerState): string | null {
  const held = player.draw ? [player.draw, ...player.hand] : player.hand;

  for (const meld of player.melds) {
    if (meld.meld_type !== 'Pon' || meld.tiles.length === 0) continue;

    const ponTile = meld.tiles[0];
    if (held.includes(ponTile)) return ponTile;
  }

  return null;
}
