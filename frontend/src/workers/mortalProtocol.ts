/**
 * Message contract between the app and the Mortal inference worker.
 *
 * The model is a 43 MB Safetensors checkpoint evaluated with Candle inside
 * WASM, so every call is CPU-bound and must not run on the UI thread. The
 * worker owns the WASM instance and the model; the main thread only sends
 * serialized requests and receives serialized results.
 *
 * Keep this file type-only: it is imported by both the main bundle and the
 * worker bundle, and importing runtime code here would pull the model into the
 * UI thread.
 */

/** Requests, before the client assigns a correlation id. */
export type MortalCommand =
  | { op: 'init'; weights: ArrayBuffer; modelName: string }
  | { op: 'evaluate'; stateJson: string }
  | { op: 'generateAgreement'; category: string; optionsJson: string }
  | { op: 'generateAi'; category: string };

/** A request carrying the id its response will echo. */
export type MortalRequest = MortalCommand & { id: number };

/**
 * Responses. `value` is the raw payload the Rust export returned:
 * an evaluation object for `evaluate`, and a JSON string for the two
 * generation calls.
 */
export type MortalResponse =
  | { id: number; ok: true; value?: unknown }
  | { id: number; ok: false; error: string };
