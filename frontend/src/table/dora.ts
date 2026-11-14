/**
 * Dora indicators for the rendered board's shimmer overlay.
 *
 * This is presentation-only: Rust already decides values and hands. The board
 * only needs to know which *face* is dora so the additive sweep can mark the
 * tile. The mapping is the standard Riichi one:
 *
 *  - suited tiles advance 1…9 and wrap (`9m` → `1m`);
 *  - winds advance East → South → West → North → East;
 *  - dragons advance Haku → Hatsu → Chun → Haku.
 *
 * An unknown or absent indicator yields no dora rather than guessing, so an old
 * payload can never shimmer the wrong tile.
 */
import type { GameState } from '../types/game';

const SUITS = 'mps';

/** The tile a single dora indicator reveals, or null when it is not a tile. */
export function doraTileForIndicator(indicator: string): string | null {
  if (indicator.length !== 2) return null;
  const rank = indicator[0];
  const suit = indicator[1];
  if (rank < '1' || rank > '9') return null;

  if (SUITS.includes(suit)) {
    const next = rank === '9' ? '1' : String(Number(rank) + 1);
    return `${next}${suit}`;
  }

  if (suit === 'z') {
    // 1z…4z winds cycle, 5z…7z dragons cycle. The two runs never mix.
    if (rank >= '1' && rank <= '4') {
      const next = rank === '4' ? '1' : String(Number(rank) + 1);
      return `${next}z`;
    }
    if (rank >= '5' && rank <= '7') {
      const next = rank === '7' ? '5' : String(Number(rank) + 1);
      return `${next}z`;
    }
  }

  return null;
}

/** Every base tile code that is dora for the given indicators. */
export function doraCodes(indicators: readonly string[] | null | undefined): ReadonlySet<string> {
  const codes = new Set<string>();
  for (const indicator of indicators ?? []) {
    const dora = doraTileForIndicator(indicator);
    if (dora) codes.add(dora);
  }
  return codes;
}

/**
 * The dora codes for a game state, tolerating payloads that predate the field.
 */
export function doraCodesForState(state: Pick<GameState, 'dora_indicators'>): ReadonlySet<string> {
  return doraCodes(state.dora_indicators);
}
