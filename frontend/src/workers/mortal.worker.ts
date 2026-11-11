/**
 * Dedicated worker that owns the Mortal v4 model.
 *
 * Everything here is off the UI thread: the WASM instantiation, the 43 MB
 * weight parse, and every forward pass (hand evaluation, the AI drill
 * generator, and Mortal-agreement sampling). The main thread talks to it
 * through `services/mortalClient.ts`.
 */
import init, { WasmMortalEvaluator } from 'riichiprac';
import wasmUrl from 'riichiprac/riichiprac_bg.wasm?url';
import type { MortalRequest, MortalResponse } from './mortalProtocol';

/**
 * Minimal view of the worker global.
 *
 * The app compiles with the DOM lib, where `self` is typed as a `Window`, so
 * the worker-specific methods are declared here instead of pulling in
 * `lib.webworker.d.ts` (which conflicts with the DOM types).
 */
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<MortalRequest>) => void) | null;
  postMessage(message: MortalResponse): void;
};

let evaluator: WasmMortalEvaluator | null = null;

function requireEvaluator(): WasmMortalEvaluator {
  if (!evaluator) {
    throw new Error('the Mortal worker received a request before init');
  }
  return evaluator;
}

/**
 * wasm-bindgen throws the raw `JsValue` (usually a JS string) on `Err`, not an
 * `Error`, so normalize both shapes for the message channel.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

scope.onmessage = async (event) => {
  const request = event.data;

  try {
    switch (request.op) {
      case 'init': {
        await init({ module_or_path: wasmUrl });
        evaluator = new WasmMortalEvaluator(
          new Uint8Array(request.weights),
          request.modelName,
        );
        scope.postMessage({ id: request.id, ok: true });
        return;
      }
      case 'evaluate': {
        scope.postMessage({
          id: request.id,
          ok: true,
          value: requireEvaluator().evaluate(request.stateJson),
        });
        return;
      }
      case 'generateAgreement': {
        scope.postMessage({
          id: request.id,
          ok: true,
          value: requireEvaluator().generate_puzzle_with_agreement(
            request.category,
            request.optionsJson,
          ),
        });
        return;
      }
      case 'generateAi': {
        scope.postMessage({
          id: request.id,
          ok: true,
          value: requireEvaluator().generate_ai_puzzle(request.category),
        });
        return;
      }
    }
  } catch (error) {
    scope.postMessage({ id: request.id, ok: false, error: describeError(error) });
  }
};
