import init from 'riichiprac';
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
