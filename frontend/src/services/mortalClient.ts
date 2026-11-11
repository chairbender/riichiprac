/**
 * Main-thread client for the Mortal inference worker.
 *
 * The worker owns the WASM instance and the 43 MB Candle model (see
 * `workers/mortal.worker.ts`), so evaluation never blocks the UI. Calls are
 * serialized over `postMessage` and correlated by id; the worker processes
 * them one at a time, in order.
 *
 * Superseded requests are not cancellable inside the worker (it is blocked in a
 * forward pass), but callers can ignore a stale result — the store already
 * guards with its own request ids and the current-table check.
 */
import type { AiEvaluation } from '../types/ai';
import type {
  MortalCommand,
  MortalRequest,
  MortalResponse,
} from '../workers/mortalProtocol';

/** The subset of `Worker` this client needs, so tests can substitute one. */
export interface MortalWorkerLike {
  onmessage: ((event: MessageEvent<MortalResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: MortalRequest, transfer?: Transferable[]): void;
  terminate(): void;
}

export interface MortalClient {
  /**
   * Hand the worker the model weights and build the evaluator.
   *
   * `weights` is transferred to the worker, which detaches it on this side.
   */
  init(weights: ArrayBuffer, modelName: string): Promise<void>;
  /** Evaluate a serialized `GameState`, resolving to Mortal's ranking. */
  evaluate(stateJson: string): Promise<AiEvaluation>;
  /** Generate and finalize the AI Best Action drill. */
  generateAiPuzzle(category: string): Promise<string>;
  /** Generate a lesson hand that Mortal also plays, with its sampling report. */
  generatePuzzleWithAgreement(
    category: string,
    optionsJson: string,
  ): Promise<string>;
  /** Kill the worker; every pending call rejects. */
  terminate(): void;
}

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/**
 * Spawn the real worker bundle. Vite rewrites the `new URL` into a chunk, so
 * the options object and the URL must stay literal.
 */
export function spawnMortalWorker(): MortalWorkerLike {
  return new Worker(new URL('../workers/mortal.worker.ts', import.meta.url), {
    type: 'module',
    // Shown as a separate thread in DevTools.
    name: 'mortal-inference',
  }) as MortalWorkerLike;
}

/**
 * Build a client around `worker`.
 *
 * The worker argument is injectable so the protocol can be unit-tested without
 * a DOM or a browser worker; production callers use [`initMortalClient`].
 */
export function createMortalClient(
  worker: MortalWorkerLike = spawnMortalWorker(),
): MortalClient {
  const pending = new Map<number, PendingCall>();
  let nextId = 1;
  let terminated = false;

  const failPending = (message: string) => {
    for (const call of pending.values()) call.reject(new Error(message));
    pending.clear();
  };

  worker.onmessage = (event) => {
    const response = event.data;
    const call = pending.get(response.id);
    // A response can outlive its request when a caller gave up waiting.
    if (!call) return;
    pending.delete(response.id);
    if (response.ok) call.resolve(response.value);
    else call.reject(new Error(response.error));
  };

  worker.onerror = (event) => {
    // A worker-level error leaves every pending call unanswerable.
    failPending(event.message || 'the Mortal worker crashed');
  };

  const send = (
    command: MortalCommand,
    transfer?: Transferable[],
  ): Promise<unknown> => {
    if (terminated) {
      return Promise.reject(new Error('the Mortal worker was terminated'));
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ ...command, id } as MortalRequest, transfer);
    });
  };

  return {
    init: (weights, modelName) =>
      send({ op: 'init', weights, modelName }, [weights]).then(() => undefined),

    evaluate: (stateJson) =>
      send({ op: 'evaluate', stateJson }) as Promise<AiEvaluation>,

    generateAiPuzzle: (category) =>
      send({ op: 'generateAi', category }) as Promise<string>,

    generatePuzzleWithAgreement: (category, optionsJson) =>
      send({ op: 'generateAgreement', category, optionsJson }) as Promise<string>,

    terminate: () => {
      if (terminated) return;
      terminated = true;
      worker.terminate();
      failPending('the Mortal worker was terminated');
    },
  };
}

/**
 * Spawn a worker and load the checkpoint into it.
 *
 * `weights` is transferred rather than copied: the main thread hands the bytes
 * over and never needs them again (they are already in the IndexedDB cache).
 */
export async function initMortalClient(
  weights: Uint8Array,
  modelName: string,
): Promise<MortalClient> {
  const client = createMortalClient();
  try {
    await client.init(transferableWeights(weights), modelName);
  } catch (error) {
    client.terminate();
    throw error;
  }
  return client;
}

/**
 * The weights' own buffer when the view covers all of it, otherwise a copy.
 *
 * `loadWeights` returns a fully-viewed buffer in both the cache and download
 * paths, so the copy is only a safety net.
 */
function transferableWeights(weights: Uint8Array): ArrayBuffer {
  if (
    weights.byteOffset === 0 &&
    weights.byteLength === weights.buffer.byteLength
  ) {
    return weights.buffer as ArrayBuffer;
  }
  return weights.slice().buffer as ArrayBuffer;
}
