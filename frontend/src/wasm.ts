import init, { riichi_discards_json } from 'riichiprac';
import wasmUrl from 'riichiprac/riichiprac_bg.wasm?url';

let wasmInitPromise: ReturnType<typeof init> | null = null;

/**
 * Initializes the Rust/WASM module exactly once.
 *
 * `WasmMortalEvaluator` lives in the same module, so nothing may construct it
 * before this promise resolves.
 */
export function ensureWasmReady(): ReturnType<typeof init> {
  wasmInitPromise ??= init({ module_or_path: wasmUrl });
  return wasmInitPromise;
}

/**
 * The tile codes whose discard is a legal Riichi declaration for this state.
 *
 * The rule is Rust's (`ai::actions::riichi_discard_tiles`), not React's: the
 * call UI only needs to know whether there is exactly one obvious discard. A
 * payload the engine cannot read, or a module that predates the export, yields
 * an empty list, which makes the UI keep the pick step rather than guess.
 */
export function riichiDiscardTiles(stateJson: string): string[] {
  try {
    const parsed: unknown = JSON.parse(riichi_discards_json(stateJson));
    return Array.isArray(parsed)
      ? parsed.filter((tile): tile is string => typeof tile === 'string')
      : [];
  } catch {
    return [];
  }
}
