import type { AiActionInfo } from './types/ai';
import type {
  CorrectAction,
  CorrectActionType,
  GameState,
  PlayerState,
} from './types/game';

const CORRECT_ACTION_TYPES: CorrectActionType[] = [
  'riichi',
  'dama',
  'fold',
  'kan',
  'discard',
  'pass',
  'call',
  'best',
];

/** Validate the `correct_action` payload before it reaches the store. */
export function isCorrectAction(value: unknown): value is CorrectAction {
  if (!value || typeof value !== 'object') return false;

  const action = value as {
    type?: unknown;
    discard?: unknown;
    tile?: unknown;
    tiles?: unknown;
    action?: unknown;
    label?: unknown;
  };
  if (!CORRECT_ACTION_TYPES.includes(action.type as CorrectActionType)) {
    return false;
  }

  if (action.type === 'best') {
    return (
      typeof action.action === 'string' &&
      typeof action.label === 'string' &&
      (action.tile === undefined ||
        action.tile === null ||
        typeof action.tile === 'string') &&
      (action.tiles === undefined ||
        (Array.isArray(action.tiles) &&
          action.tiles.every((tile) => typeof tile === 'string')))
    );
  }

  // A pass names no tile: the call it declines is in `call_offer`.
  if (action.type === 'pass') {
    return true;
  }

  return action.type === 'riichi' ||
    action.type === 'dama' ||
    action.type === 'fold'
    ? typeof action.discard === 'string'
    : typeof action.tile === 'string';
}

/** Whether the state asks to call or pass on an opponent's discard. */
export function isCallDecision(action: CorrectAction): boolean {
  return action.type === 'pass';
}

/**
 * The two buttons a book call lesson renders: the offered call and Pass.
 *
 * The offer comes from the Rust payload (`call_offer`), so whether a Pon or a
 * Chi is available is decided by the engine, not re-derived in React.
 */
export function callOfferActions(state: GameState): AiActionInfo[] {
  const offer = state.call_offer;
  if (!offer) return [];

  return [
    {
      action: offer.action,
      label: offer.label,
      type: offer.action === 'Chi' ? 'chi' : 'pon',
      tile: offer.tile,
      tiles: offer.tiles ?? [],
    },
    { action: 'Pass', label: 'Pass', type: 'pass' },
  ];
}

/** Whether the payload belongs to the Kan (Shouminkan) lesson. */
export function isKanDecision(action: CorrectAction): boolean {
  return action.type === 'kan' || action.type === 'discard';
}

/**
 * Whether the human may declare Riichi right now.
 *
 * Rust owns the rule (`GameState::can_riichi`, derived from the same
 * legal-action source the Mortal mask uses), so an open hand, an
 * already-declared Riichi, or a non-tenpai hand is never offered the toggle.
 * Payloads that predate the field fall back to the AI action list when there
 * is one, and to the old permissive behaviour for bare imported states.
 */
export function canDeclareRiichi(state: GameState): boolean {
  if (state.can_riichi !== undefined) return state.can_riichi;
  const actions = state.ai_decision?.actions;
  if (actions) return actions.some((action) => action.action === 'Riichi');
  return true;
}

/** The tile the player must click for the answer, when one is required. */
export function correctActionTile(action: CorrectAction): string | null {
  if (action.type === 'best') return action.tile ?? null;
  if (action.type === 'pass') return null;
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

/** Collapse a red-five discard action onto its base tile for matching. */
export function normalizeMortalAction(action: string): string {
  return action.startsWith('Discard_') && action.endsWith('r')
    ? action.slice(0, -1)
    : action;
}

/**
 * Find the payload info for a submitted Mortal action, including red-five
 * aliases. Used for labels and for the tiles a call consumed.
 */
export function findAiActionInfo(
  state: GameState,
  action: string,
  tile?: string,
): AiActionInfo | undefined {
  const actions = state.ai_decision?.actions ?? [];
  return (
    actions.find((candidate) => candidate.action === action) ??
    actions.find(
      (candidate) =>
        normalizeMortalAction(candidate.action) ===
          normalizeMortalAction(action) &&
        (tile === undefined || candidate.tile === tile),
    )
  );
}
